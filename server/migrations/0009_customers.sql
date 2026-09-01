-- 0009_customers.sql
-- Customer addresses (§5.3, CLAUDE.md §12).
-- Forward-only. Never edit a migration that has been applied (§4.4).
--
-- An address book is the piece checkout cannot proceed without, and the piece
-- that must NOT be shared with an order: an order snapshots the address it was
-- shipped to, because a customer editing their address next year must not
-- rewrite where last year's parcel went. `order_addresses` (0011) is a
-- deliberate copy, not a foreign key.

CREATE TABLE addresses (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        text,
  first_name   text NOT NULL CHECK (length(btrim(first_name)) > 0),
  last_name    text NOT NULL CHECK (length(btrim(last_name)) > 0),
  company      text,
  line1        text NOT NULL CHECK (length(btrim(line1)) > 0),
  line2        text,
  city         text NOT NULL CHECK (length(btrim(city)) > 0),
  region       text,
  postal_code  text,
  country_code char(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  phone        text,
  -- One default per address book, so checkout can pre-fill without guessing.
  is_default   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz
);

CREATE TRIGGER addresses_set_updated_at
  BEFORE UPDATE ON addresses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX addresses_user_idx ON addresses (user_id) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX addresses_one_default_per_user
  ON addresses (user_id) WHERE is_default AND archived_at IS NULL;

COMMENT ON TABLE addresses IS
  'A customer''s address book. Orders snapshot addresses rather than referencing them.';

-- Marketing consent lives on the user, because it is a property of the person
-- rather than of any one address or order (§10.4).
ALTER TABLE users ADD COLUMN accepts_marketing boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN marketing_consent_at timestamptz;
-- Denormalised counters, maintained when an order reaches a paid state. They
-- answer "who are my best customers" without scanning every order.
ALTER TABLE users ADD COLUMN orders_count integer NOT NULL DEFAULT 0
  CHECK (orders_count >= 0);
ALTER TABLE users ADD COLUMN total_spent_cents bigint NOT NULL DEFAULT 0
  CHECK (total_spent_cents >= 0);
ALTER TABLE users ADD COLUMN last_order_at timestamptz;

CREATE INDEX users_customers_idx ON users (created_at DESC)
  WHERE status = 'active';
CREATE INDEX users_spend_idx ON users (total_spent_cents DESC)
  WHERE orders_count > 0;

COMMENT ON COLUMN users.orders_count IS
  'Denormalised; the orders table is the truth. Maintained on payment, reconciled nightly.';
