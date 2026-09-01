-- 0008_inventory.sql
-- Locations, inventory items, levels, movements and reservations.
-- Forward-only. Never edit a migration that has been applied (§4.4).
--
-- The model and its reasoning: docs/inventory.md.
--
--   variant → inventory item → inventory level (per location)
--
-- Three things this file encodes that are expensive to retrofit:
--
--   • **Quantity never lives on a variant, and never on an item.** It lives on
--     a level, which is scoped to a location. Putting it anywhere higher is
--     what makes multi-location a rewrite instead of an insert.
--   • **`available` is derived, not stored independently.** Two mutable numbers
--     that are supposed to agree eventually do not.
--   • **History is append-only.** Stock is financial data; a movement row that
--     can be edited is not evidence of anything.

-- ─────────────────────────────────────────────────────────────────────────────
-- inventory_locations — where stock physically is.
--
-- One row today. It exists as a table rather than an assumption so that a
-- second branch is an INSERT, and so no code ever contains "the main kitchen".
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE inventory_locations (
  id         uuid PRIMARY KEY,
  code       citext NOT NULL UNIQUE,
  name       text NOT NULL CHECK (length(btrim(name)) > 0),
  -- Free-form on purpose: a restaurant branch and a warehouse do not share an
  -- address shape, and inventing one now would be guessing.
  address    jsonb NOT NULL DEFAULT '{}',
  is_active  boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  position   integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE TRIGGER inventory_locations_set_updated_at
  BEFORE UPDATE ON inventory_locations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Exactly one default, so "where does stock land by default" is never ambiguous
-- and no service has to pick a winner.
CREATE UNIQUE INDEX inventory_locations_one_default
  ON inventory_locations ((true)) WHERE is_default;

INSERT INTO inventory_locations (id, code, name, is_default)
VALUES ('00000000-0000-4000-8000-000000000101', 'main', 'Main location', true);

COMMENT ON TABLE inventory_locations IS
  'Where stock is held. Seeded with one; multi-location is additive, not a rewrite.';

-- ─────────────────────────────────────────────────────────────────────────────
-- inventory_items — what is operationally tracked.
--
-- Distinct from the variant on purpose. A variant is what a customer buys; an
-- inventory item is what a stockroom counts. They are one-to-one today, and the
-- separation is what lets that change (a kit drawing on component items, one
-- item backing two sellable variants) without touching the catalogue.
--
-- Carries *policy*, never quantity.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE inventory_items (
  id                  uuid PRIMARY KEY,
  -- RESTRICT, not CASCADE: variants are archived rather than deleted, and an
  -- item disappearing under a movement history would destroy the evidence.
  variant_id          uuid NOT NULL UNIQUE REFERENCES product_variants(id) ON DELETE RESTRICT,
  -- false means "not stock-tracked" — an unlimited, made-to-order item.
  -- It does NOT mean zero. See docs/inventory.md §8.
  track_inventory     boolean NOT NULL DEFAULT true,
  -- NULL means "use the store default" (store_settings.default_low_stock_threshold),
  -- which is different from 0, meaning "warn me at zero and not before".
  low_stock_threshold integer CHECK (low_stock_threshold IS NULL OR low_stock_threshold >= 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  archived_at         timestamptz
);

CREATE TRIGGER inventory_items_set_updated_at
  BEFORE UPDATE ON inventory_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE inventory_items IS
  'What is operationally tracked. One per variant. Carries policy, never quantity.';
COMMENT ON COLUMN inventory_items.track_inventory IS
  'false = unlimited / made-to-order. Never interpreted as zero.';

-- Every existing variant gets an item, so "no inventory item" is not a state
-- the application has to reason about in practice.
INSERT INTO inventory_items (id, variant_id)
SELECT gen_random_uuid(), id FROM product_variants;

-- ─────────────────────────────────────────────────────────────────────────────
-- inventory_levels — how much of an item is at a location.
--
-- `available` is a STORED generated column rather than a third mutable number.
-- Two independently-writable quantities that are supposed to agree will
-- eventually disagree, and the disagreement is always discovered by a customer.
-- Deriving it also means "what can be sold" is a plain indexed read.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE inventory_levels (
  id                uuid PRIMARY KEY,
  inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  location_id       uuid NOT NULL REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  on_hand           integer NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved          integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  available         integer GENERATED ALWAYS AS (on_hand - reserved) STORED,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- The invariant that makes overselling impossible at the storage layer, even
  -- if a service has a bug: you cannot reserve what you do not hold.
  CONSTRAINT reserved_within_on_hand CHECK (reserved <= on_hand),
  CONSTRAINT one_level_per_item_and_location UNIQUE (inventory_item_id, location_id)
);

CREATE TRIGGER inventory_levels_set_updated_at
  BEFORE UPDATE ON inventory_levels
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX inventory_levels_item_idx ON inventory_levels (inventory_item_id);
CREATE INDEX inventory_levels_location_idx ON inventory_levels (location_id);
-- Drives "what is low or out" without a scan.
CREATE INDEX inventory_levels_available_idx ON inventory_levels (available);

COMMENT ON TABLE inventory_levels IS
  'Quantity of one item at one location. available is derived and cannot drift.';

-- ─────────────────────────────────────────────────────────────────────────────
-- inventory_movements — the append-only ledger.
--
-- Every change to a level writes one row saying what moved and why. The level
-- is the running total; this is the evidence. Stock is financial data, so a row
-- that can be edited afterwards is not evidence of anything — hence the
-- immutability trigger below rather than a convention in a service.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE inventory_movements (
  id                bigserial PRIMARY KEY,
  inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  location_id       uuid NOT NULL REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  delta_on_hand     integer NOT NULL DEFAULT 0,
  delta_reserved    integer NOT NULL DEFAULT 0,
  reason            text NOT NULL CHECK (reason IN (
                      'receive', 'manual_adjustment', 'stocktake', 'damage', 'waste',
                      'return', 'correction', 'transfer_in', 'transfer_out',
                      'reservation', 'reservation_release', 'reservation_commit',
                      'reservation_expired')),
  -- What caused it, when there is something to point at.
  reference_type    text CHECK (reference_type IN (
                      'manual', 'reservation', 'transfer', 'order', 'return', 'stocktake')),
  reference_id      uuid,
  -- Running totals after this movement, so history reads without re-summing.
  resulting_on_hand integer NOT NULL CHECK (resulting_on_hand >= 0),
  resulting_reserved integer NOT NULL CHECK (resulting_reserved >= 0),
  actor_user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- A movement that moves nothing is noise in an audit trail.
  CONSTRAINT movement_moves_something CHECK (delta_on_hand <> 0 OR delta_reserved <> 0)
);

CREATE INDEX inventory_movements_item_idx
  ON inventory_movements (inventory_item_id, created_at DESC);
CREATE INDEX inventory_movements_location_idx
  ON inventory_movements (location_id, created_at DESC);
CREATE INDEX inventory_movements_reference_idx
  ON inventory_movements (reference_type, reference_id);

-- Append-only, enforced rather than trusted. Correcting a mistake means writing
-- a compensating movement, which is what an auditor expects to see anyway.
CREATE OR REPLACE FUNCTION refuse_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'relation % is append-only; write a compensating row instead',
    TG_TABLE_NAME USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER inventory_movements_are_append_only
  BEFORE UPDATE OR DELETE ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

COMMENT ON TABLE inventory_movements IS
  'Append-only stock ledger. What happened to stock — distinct from audit_logs, which records who did what.';

-- ─────────────────────────────────────────────────────────────────────────────
-- inventory_reservations — a claim on stock that has not left yet.
--
-- The foundation the checkout will stand on:
--
--   available → reserve → reserved → commit (goods leave) or release (freed)
--
-- Status is the whole story, so a reservation is resolved exactly once and
-- cannot be counted twice.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE inventory_reservations (
  id                uuid PRIMARY KEY,
  inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  location_id       uuid NOT NULL REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  quantity          integer NOT NULL CHECK (quantity > 0),
  status            text NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'released', 'committed', 'expired')),
  -- Who holds it. 'cart' and 'order' arrive in later phases; the column does
  -- not need to change when they do.
  owner_type        text NOT NULL CHECK (owner_type IN ('cart', 'order', 'manual')),
  owner_id          uuid NOT NULL,
  -- An abandoned checkout must not hold stock forever.
  expires_at        timestamptz NOT NULL,
  resolved_at       timestamptz,
  resolved_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- Exactly the reservations that are no longer active carry a resolution time.
  CONSTRAINT resolution_matches_status CHECK ((status = 'active') = (resolved_at IS NULL))
);

CREATE TRIGGER inventory_reservations_set_updated_at
  BEFORE UPDATE ON inventory_reservations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One active reservation per owner per item per location: a retried checkout
-- request must not silently hold twice the stock.
CREATE UNIQUE INDEX inventory_reservations_one_active_per_owner
  ON inventory_reservations (owner_type, owner_id, inventory_item_id, location_id)
  WHERE status = 'active';

CREATE INDEX inventory_reservations_owner_idx ON inventory_reservations (owner_type, owner_id);
CREATE INDEX inventory_reservations_item_idx ON inventory_reservations (inventory_item_id, status);
-- Drives the sweep. Stays small because most reservations leave 'active'.
CREATE INDEX inventory_reservations_expiry_idx
  ON inventory_reservations (expires_at) WHERE status = 'active';

COMMENT ON TABLE inventory_reservations IS
  'A claim on stock. Resolved exactly once — released, committed or expired — so it cannot be double-counted.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Permissions (§6.5).
--
-- inventory:read and inventory:adjust already exist. Managing locations and
-- tracking policy is structural rather than day-to-day, so it is its own grant.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO permissions (key, description) VALUES
  ('inventory:manage',   'Create locations and change inventory tracking policy.'),
  ('inventory:transfer', 'Move stock between locations.');

-- staff already adjust stock; moving it between branches is the same day-to-day
-- work by another name, and refusing it would only mean two adjustments instead.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.key = 'staff' AND p.key = 'inventory:transfer';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.key = 'admin' AND p.key IN ('inventory:manage', 'inventory:transfer');

-- owner holds everything except customers:impersonate (§6.5).
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.key = 'owner' AND p.key IN ('inventory:manage', 'inventory:transfer');
