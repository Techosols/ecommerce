-- 0013_shipping.sql
-- Shipping zones, methods and shipments (§5.8).
-- Forward-only. Never edit a migration that has been applied (§4.4).
--
-- Rates are computed server-side from zone + weight + subtotal. The client
-- never proposes a shipping price, exactly as it never proposes a product
-- price.

CREATE TABLE shipping_zones (
  id            uuid PRIMARY KEY,
  name          text NOT NULL CHECK (length(btrim(name)) > 0),
  -- An array rather than a junction table: a zone is a short list of countries
  -- read on every rate quote, and a GIN index answers "which zone covers XX"
  -- in one lookup.
  country_codes char(2)[] NOT NULL CHECK (array_length(country_codes, 1) > 0),
  position      integer NOT NULL DEFAULT 0,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER shipping_zones_set_updated_at
  BEFORE UPDATE ON shipping_zones
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX shipping_zones_countries_idx ON shipping_zones USING gin (country_codes);

CREATE TABLE shipping_methods (
  id                       uuid PRIMARY KEY,
  zone_id                  uuid NOT NULL REFERENCES shipping_zones(id) ON DELETE CASCADE,
  name                     text NOT NULL CHECK (length(btrim(name)) > 0),
  description              text,
  rate_type                text NOT NULL CHECK (rate_type IN ('flat','free','weight_based')),
  price_cents              integer NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  -- "Free over £40". NULL means the threshold does not apply.
  free_over_subtotal_cents integer CHECK (free_over_subtotal_cents >= 0),
  min_weight_grams         integer CHECK (min_weight_grams >= 0),
  max_weight_grams         integer CHECK (max_weight_grams >= 0),
  estimated_days_min       integer CHECK (estimated_days_min >= 0),
  estimated_days_max       integer CHECK (estimated_days_max >= 0),
  position                 integer NOT NULL DEFAULT 0,
  is_active                boolean NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  archived_at              timestamptz,
  CONSTRAINT weight_band_is_ordered CHECK (
    min_weight_grams IS NULL OR max_weight_grams IS NULL OR max_weight_grams >= min_weight_grams
  ),
  CONSTRAINT estimate_is_ordered CHECK (
    estimated_days_min IS NULL OR estimated_days_max IS NULL
    OR estimated_days_max >= estimated_days_min
  )
);

CREATE TRIGGER shipping_methods_set_updated_at
  BEFORE UPDATE ON shipping_methods
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX shipping_methods_zone_idx ON shipping_methods (zone_id, position)
  WHERE archived_at IS NULL;

-- Now that shipping methods exist, close the forward reference from orders.
-- SET NULL, and the name is snapshotted on the order: retiring a method must
-- not blank the record of how something was shipped.
ALTER TABLE orders
  ADD CONSTRAINT orders_shipping_method_fk
  FOREIGN KEY (shipping_method_id) REFERENCES shipping_methods(id) ON DELETE SET NULL;

CREATE TABLE shipments (
  id              uuid PRIMARY KEY,
  order_id        uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','shipped','in_transit',
                                      'delivered','returned','failed')),
  carrier         text,
  service         text,
  tracking_number text,
  tracking_url    text,
  shipped_at      timestamptz,
  delivered_at    timestamptz,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivery_follows_dispatch CHECK (
    delivered_at IS NULL OR shipped_at IS NOT NULL
  )
);

CREATE TRIGGER shipments_set_updated_at
  BEFORE UPDATE ON shipments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX shipments_order_idx ON shipments (order_id);
CREATE INDEX shipments_open_idx ON shipments (status)
  WHERE status NOT IN ('delivered','returned');
CREATE INDEX shipments_tracking_idx ON shipments (tracking_number);

-- A partial shipment is normal: three of five items go today, two on Friday.
CREATE TABLE shipment_items (
  shipment_id   uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  order_item_id uuid NOT NULL REFERENCES order_items(id) ON DELETE RESTRICT,
  quantity      integer NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (shipment_id, order_item_id)
);

CREATE INDEX shipment_items_order_item_idx ON shipment_items (order_item_id);
