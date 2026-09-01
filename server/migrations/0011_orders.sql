-- 0011_orders.sql
-- Orders, items, addresses, status history, order discounts (§5.6).
-- Forward-only. Never edit a migration that has been applied (§4.4).
--
-- Two decisions carry this table:
--
--   **Three orthogonal status fields, not one** (decision D-2). Collapsing
--   lifecycle, payment and fulfilment into a single column makes real states
--   inexpressible — paid but unshipped, shipped but partly refunded — and makes
--   invalid transitions legal. A derived display status maps back to the flat
--   vocabulary for the UI.
--
--   **Order items are immutable snapshots.** Title, variant title, SKU and unit
--   price are copied at purchase and never re-read from the catalogue. A
--   product renamed or repriced next year must not rewrite what someone bought
--   today. `variant_id` is kept only for traceability, and is nullable.

CREATE SEQUENCE order_number_seq START 1001;

CREATE TABLE orders (
  id                   uuid PRIMARY KEY,
  order_number         text NOT NULL UNIQUE,
  -- NULL means a guest. SET NULL rather than CASCADE: deleting a person must
  -- never delete the financial record of what they bought.
  customer_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  email                citext NOT NULL,
  phone                text,

  status               text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','confirmed','processing','completed','cancelled')),
  payment_status       text NOT NULL DEFAULT 'pending'
                         CHECK (payment_status IN ('pending','authorized','paid',
                                'partially_refunded','refunded','failed','cancelled')),
  fulfillment_status   text NOT NULL DEFAULT 'unfulfilled'
                         CHECK (fulfillment_status IN ('unfulfilled','partially_fulfilled',
                                'fulfilled','delivered','returned')),

  currency             char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal_cents       integer NOT NULL CHECK (subtotal_cents >= 0),
  discount_total_cents integer NOT NULL DEFAULT 0 CHECK (discount_total_cents >= 0),
  tax_total_cents      integer NOT NULL DEFAULT 0 CHECK (tax_total_cents >= 0),
  shipping_total_cents integer NOT NULL DEFAULT 0 CHECK (shipping_total_cents >= 0),
  total_cents          integer NOT NULL CHECK (total_cents >= 0),
  refunded_total_cents integer NOT NULL DEFAULT 0 CHECK (refunded_total_cents >= 0),

  -- FK added by 0013, which creates `shipping_methods`. The name is snapshotted
  -- alongside for the same reason order items snapshot their titles.
  shipping_method_id   uuid,
  shipping_method_name text,

  customer_note        text,
  admin_note           text,
  cancel_reason        text,
  source               text NOT NULL DEFAULT 'storefront' CHECK (source IN ('storefront','admin')),

  placed_at            timestamptz NOT NULL DEFAULT now(),
  confirmed_at         timestamptz,
  cancelled_at         timestamptz,
  completed_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  -- The arithmetic is enforced by the database, so a rounding bug in a service
  -- cannot persist an order whose parts do not add up to its total.
  CONSTRAINT total_is_consistent CHECK (
    total_cents = subtotal_cents - discount_total_cents + tax_total_cents + shipping_total_cents
  ),
  CONSTRAINT refund_within_total CHECK (refunded_total_cents <= total_cents),
  CONSTRAINT cancelled_orders_have_a_date CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);

CREATE TRIGGER orders_set_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX orders_customer_idx ON orders (customer_id, placed_at DESC);
CREATE INDEX orders_status_idx ON orders (status, placed_at DESC);
CREATE INDEX orders_unpaid_idx ON orders (payment_status) WHERE payment_status = 'pending';
CREATE INDEX orders_unfulfilled_idx ON orders (fulfillment_status)
  WHERE fulfillment_status <> 'fulfilled';
CREATE INDEX orders_placed_idx ON orders (placed_at DESC);
CREATE INDEX orders_email_idx ON orders (email);
CREATE INDEX orders_number_idx ON orders (order_number);

COMMENT ON TABLE orders IS
  'Three orthogonal status machines. The display status in §17 is derived, never stored.';

-- Now that orders exist, close the forward reference from carts.
ALTER TABLE carts
  ADD CONSTRAINT carts_converted_order_fk
  FOREIGN KEY (converted_order_id) REFERENCES orders(id) ON DELETE SET NULL;

CREATE TABLE order_items (
  id                 uuid PRIMARY KEY,
  order_id           uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  -- Traceability only. SET NULL because the catalogue may eventually lose a
  -- variant, and the line must survive that intact.
  variant_id         uuid REFERENCES product_variants(id) ON DELETE SET NULL,
  product_id         uuid REFERENCES products(id) ON DELETE SET NULL,

  -- The snapshot. Never re-read from the catalogue.
  product_title      text NOT NULL,
  variant_title      text NOT NULL,
  sku                text,
  image_url          text,
  options            jsonb NOT NULL DEFAULT '[]',

  unit_price_cents   integer NOT NULL CHECK (unit_price_cents >= 0),
  quantity           integer NOT NULL CHECK (quantity > 0),
  subtotal_cents     integer NOT NULL CHECK (subtotal_cents >= 0),
  discount_cents     integer NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  tax_cents          integer NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  total_cents        integer NOT NULL CHECK (total_cents >= 0),

  requires_shipping  boolean NOT NULL DEFAULT true,
  weight_grams       integer NOT NULL DEFAULT 0 CHECK (weight_grams >= 0),
  fulfilled_quantity integer NOT NULL DEFAULT 0 CHECK (fulfilled_quantity >= 0),
  refunded_quantity  integer NOT NULL DEFAULT 0 CHECK (refunded_quantity >= 0),
  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT cannot_fulfil_more_than_ordered CHECK (fulfilled_quantity <= quantity),
  CONSTRAINT cannot_refund_more_than_ordered CHECK (refunded_quantity <= quantity),
  CONSTRAINT line_total_is_consistent CHECK (
    total_cents = subtotal_cents - discount_cents + tax_cents
  )
);

CREATE INDEX order_items_order_idx ON order_items (order_id);
CREATE INDEX order_items_variant_idx ON order_items (variant_id);

COMMENT ON TABLE order_items IS
  'Immutable purchase snapshots. variant_id is for traceability; the text is the record.';

CREATE TABLE order_addresses (
  id           uuid PRIMARY KEY,
  order_id     uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  type         text NOT NULL CHECK (type IN ('shipping','billing')),
  first_name   text NOT NULL,
  last_name    text NOT NULL,
  company      text,
  line1        text NOT NULL,
  line2        text,
  city         text NOT NULL,
  region       text,
  postal_code  text,
  country_code char(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  phone        text,
  CONSTRAINT one_address_of_each_type UNIQUE (order_id, type)
);

COMMENT ON TABLE order_addresses IS
  'A copy, not a reference: editing an address book must not rewrite where a parcel went.';

CREATE TABLE order_status_history (
  id            bigserial PRIMARY KEY,
  order_id      uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  field         text NOT NULL CHECK (field IN ('status','payment_status','fulfillment_status')),
  from_value    text,
  to_value      text NOT NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_type    text NOT NULL CHECK (actor_type IN ('customer','staff','system','webhook')),
  reason        text,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX order_status_history_order_idx ON order_status_history (order_id, created_at);

-- Append-only, like the inventory ledger and for the same reason: it is the
-- record of what happened to somebody's money.
CREATE TRIGGER order_status_history_is_append_only
  BEFORE UPDATE OR DELETE ON order_status_history
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

CREATE TABLE order_discounts (
  id           uuid PRIMARY KEY,
  order_id     uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  -- FK added by 0014, which creates `discounts`.
  discount_id  uuid,
  -- Snapshots: a discount edited or deleted later must not change history.
  code         text NOT NULL,
  type         text NOT NULL,
  value        integer NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT one_application_per_code UNIQUE (order_id, code)
);

CREATE INDEX order_discounts_order_idx ON order_discounts (order_id);
