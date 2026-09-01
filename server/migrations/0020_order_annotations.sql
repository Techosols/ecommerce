-- 0020_order_annotations.sql
-- Staff notes and tags on an order (§7.1).
-- Forward-only. Never edit a migration that has been applied (§4.4).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why a table and not another text column
--
-- `orders.admin_note` already exists and stays: it is the one pinned sentence
-- about an order — "customer wants it left with the neighbour" — that whoever
-- opens the order next should read first. Overwriting it is the whole point.
--
-- What it cannot be is a conversation. A shop floor accumulates observations
-- against an order over days ("rang about the delay", "second attempt failed"),
-- each by a different person at a different time, and each worth keeping after
-- the next one is written. Appending those to a single column loses the author
-- and the time, and makes deleting one a string edit.
--
-- So notes are rows. They carry an author and a timestamp, which is what lets
-- them merge into the order timeline alongside status changes, payments,
-- refunds and shipments — the same feed, ordered by when things happened.
--
-- Tags are an array on the order rather than a join table. They are free text
-- chosen by staff for filtering ("fragile", "wholesale", "chase"), with no
-- identity of their own, no attributes and nothing referencing them; a table
-- would buy referential integrity over values that are deliberately ad hoc.
-- GIN indexed, because "every order tagged chase" is the query that justifies
-- them existing at all.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE order_notes (
  id             uuid PRIMARY KEY,
  order_id       uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  -- SET NULL, not CASCADE: a staff member leaving the company must not erase
  -- the operational record of what they observed about an order.
  author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Snapshotted so a note still says who wrote it once the account is gone.
  author_name    text,
  body           text NOT NULL CHECK (length(btrim(body)) > 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- The only access pattern: one order's notes, newest first.
CREATE INDEX order_notes_order_idx ON order_notes (order_id, created_at DESC);

COMMENT ON TABLE order_notes IS
  'Staff commentary on an order, one row per note. Distinct from orders.admin_note, which is the single pinned instruction.';

ALTER TABLE orders ADD COLUMN tags text[] NOT NULL DEFAULT '{}';

-- Answers "which orders are tagged X" without scanning. A GIN index over an
-- array is the one that supports the `&&` and `@>` operators the filter uses.
CREATE INDEX orders_tags_idx ON orders USING gin (tags);

COMMENT ON COLUMN orders.tags IS
  'Free-text staff labels for filtering. No identity of their own — deliberately not a join table.';
