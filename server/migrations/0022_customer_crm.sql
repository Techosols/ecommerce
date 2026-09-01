-- 0022_customer_crm.sql
-- Customers as records a shop works with, not just accounts that log in (§12).
-- Forward-only. Never edit a migration that has been applied (§4.4).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Consent stops being a boolean
--
-- `accepts_marketing` could say yes or no, and a shop needs four answers:
--
--   not_subscribed  never asked, or asked and never answered
--   pending         asked, waiting for them to confirm (double opt-in)
--   subscribed      yes
--   unsubscribed    they said no, having previously said yes
--
-- The difference between `not_subscribed` and `unsubscribed` is the one that
-- matters legally and commercially: the first can be asked, the second must
-- not be. A boolean collapses them, and every shop that has ever mailed an
-- unsubscribed customer did it by storing consent as one bit.
--
-- SMS gets its own column because consent is per channel — agreeing to emails
-- is not agreeing to texts.
--
-- `accepts_marketing` survives as a **generated** column derived from the email
-- state, so the storefront profile and the existing filters keep working and
-- there is still exactly one source of truth. A second stored copy would drift;
-- a generated one cannot.
--
-- ── Tags, and why they are an array again ────────────────────────────────────
--
-- Same reasoning as order tags: free text chosen by staff for filtering, with
-- no identity, no attributes and nothing referencing them. GIN indexed, because
-- "every customer tagged wholesale" is the query that justifies them.
--
-- ── The timeline is append-only ──────────────────────────────────────────────
--
-- `customer_events` mixes what the system observed with what staff wrote down.
-- Nothing in it is ever edited: a record of what somebody saw at a moment stops
-- being that the moment it can be rewritten. Notes are deleted rather than
-- changed, and system events are not deleted at all.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── The customer record ──────────────────────────────────────────────────────

ALTER TABLE users ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN admin_note text;
ALTER TABLE users ADD COLUMN tax_exempt boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN locale text;
-- The other end of the lifetime window. `last_order_at` already existed; a
-- shop wanting "customers who first bought before June" had no column to ask.
ALTER TABLE users ADD COLUMN first_order_at timestamptz;

COMMENT ON COLUMN users.tags IS
  'Free-text staff labels for filtering. Deliberately not a join table.';
COMMENT ON COLUMN users.admin_note IS
  'One pinned note about this customer. The timeline holds the running record.';

-- ── Consent ──────────────────────────────────────────────────────────────────

ALTER TABLE users ADD COLUMN marketing_email_state text NOT NULL DEFAULT 'not_subscribed'
  CHECK (marketing_email_state IN ('not_subscribed', 'pending', 'subscribed', 'unsubscribed'));
ALTER TABLE users ADD COLUMN marketing_sms_state text NOT NULL DEFAULT 'not_subscribed'
  CHECK (marketing_sms_state IN ('not_subscribed', 'pending', 'subscribed', 'unsubscribed'));
-- How the yes was obtained, when there is one. Kept because a regulator asking
-- "how do you know they agreed" is not answered by a boolean.
ALTER TABLE users ADD COLUMN marketing_opt_in_level text
  CHECK (marketing_opt_in_level IS NULL
         OR marketing_opt_in_level IN ('single_opt_in', 'confirmed_opt_in', 'unknown'));
ALTER TABLE users ADD COLUMN marketing_updated_at timestamptz;

UPDATE users SET marketing_email_state = 'subscribed' WHERE accepts_marketing;

-- Replaced by a generated column over the state above: same name, same meaning,
-- one source of truth. Anything writing it now writes the state instead.
ALTER TABLE users DROP COLUMN accepts_marketing;
ALTER TABLE users ADD COLUMN accepts_marketing boolean
  GENERATED ALWAYS AS (marketing_email_state = 'subscribed') STORED;

COMMENT ON COLUMN users.accepts_marketing IS
  'Derived from marketing_email_state. Never written directly.';
COMMENT ON COLUMN users.marketing_email_state IS
  'not_subscribed (never said yes) is not unsubscribed (said no). The second must not be mailed.';

-- ── Backfill the lifetime window ─────────────────────────────────────────────

UPDATE users u
   SET first_order_at = o.first_at
  FROM (
    SELECT customer_id, min(placed_at) AS first_at
      FROM orders
     WHERE customer_id IS NOT NULL AND status <> 'cancelled'
     GROUP BY customer_id
  ) o
 WHERE o.customer_id = u.id;

-- ── Indexes for the filters that justify these columns ───────────────────────

CREATE INDEX users_tags_idx ON users USING gin (tags);
CREATE INDEX users_marketing_email_idx ON users (marketing_email_state);
CREATE INDEX users_first_order_idx ON users (first_order_at) WHERE first_order_at IS NOT NULL;

-- ── The timeline ─────────────────────────────────────────────────────────────

CREATE TABLE customer_events (
  id             uuid PRIMARY KEY,
  customer_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Open rather than a closed enum: system events are added by writing one, and
  -- a migration per event kind buys nothing when nothing branches on the value.
  -- `note` is the only kind a person writes.
  kind           text NOT NULL CHECK (kind ~ '^[a-z][a-z_.]*$'),
  body           text,
  -- SET NULL, not CASCADE: a staff member leaving must not erase what they
  -- observed. The name is snapshotted for the same reason.
  actor_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_name     text,
  metadata       jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT notes_have_a_body CHECK (kind <> 'note' OR length(btrim(coalesce(body, ''))) > 0)
);

-- The only access pattern: one customer's timeline, newest first.
CREATE INDEX customer_events_customer_idx ON customer_events (customer_id, created_at DESC);

COMMENT ON TABLE customer_events IS
  'Append-only. System observations and staff notes in one feed; nothing here is ever edited.';

-- ── Saved segments ───────────────────────────────────────────────────────────
--
-- The rules are stored and evaluated on every read rather than materialised
-- into a membership table. A stored membership is right until the next order,
-- and then it is a list of customers who *used to* match — which is the one
-- thing a segment must never be. Evaluating live costs a query and cannot go
-- stale.
--
-- The shape is `{ match: 'all' | 'any', conditions: [{ field, operator, value }] }`,
-- the same shape smart collections will use, so one rule builder serves both.
-- Field names are checked against an allowlist in the service and compiled to
-- SQL there; nothing from this column is ever interpolated into a query.

CREATE TABLE customer_segments (
  id          uuid PRIMARY KEY,
  name        text NOT NULL CHECK (length(btrim(name)) > 0),
  description text,
  rules       jsonb NOT NULL DEFAULT '{"match":"all","conditions":[]}',
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER customer_segments_set_updated_at
  BEFORE UPDATE ON customer_segments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE UNIQUE INDEX customer_segments_name_idx ON customer_segments (lower(name));

COMMENT ON TABLE customer_segments IS
  'Saved rule sets, evaluated live. Never a materialised membership: that is a list of who used to match.';
