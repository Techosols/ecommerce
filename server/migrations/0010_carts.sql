-- 0010_carts.sql
-- Carts and cart items (§5.11).
-- Forward-only. Never edit a migration that has been applied (§4.4).
--
-- A cart holds *references and quantities*, never prices. Price is resolved
-- from the catalogue at read time and again at checkout, so a cart that sat
-- open for three days cannot quote yesterday's price, and a client cannot
-- quote a price at all (§16.3, docs/inventory.md §16).

CREATE TABLE carts (
  id                   uuid PRIMARY KEY,
  customer_id          uuid REFERENCES users(id) ON DELETE CASCADE,
  -- Guests are identified by a random token we hand out once. Hashed, exactly
  -- like a session token: a leaked database must not yield working cart
  -- identifiers (§6.2).
  anonymous_token_hash bytea UNIQUE,
  status               text NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'converted', 'abandoned')),
  currency             char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- FK added by 0011, which creates `orders`.
  converted_order_id   uuid,
  last_activity_at     timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  -- A cart belongs to somebody: a signed-in customer or a guest token.
  CONSTRAINT cart_has_an_owner CHECK (customer_id IS NOT NULL OR anonymous_token_hash IS NOT NULL)
);

CREATE TRIGGER carts_set_updated_at
  BEFORE UPDATE ON carts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One active cart per signed-in customer, so "my cart" is never ambiguous and
-- two tabs cannot diverge into two baskets.
CREATE UNIQUE INDEX carts_one_active_per_customer
  ON carts (customer_id) WHERE status = 'active' AND customer_id IS NOT NULL;
CREATE INDEX carts_expiry_idx ON carts (expires_at) WHERE status = 'active';
CREATE INDEX carts_customer_idx ON carts (customer_id, created_at DESC);

COMMENT ON TABLE carts IS
  'Holds variant references and quantities. Never prices — those are resolved at read time.';

CREATE TABLE cart_items (
  id         uuid PRIMARY KEY,
  cart_id    uuid NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  quantity   integer NOT NULL CHECK (quantity > 0 AND quantity <= 999),
  added_at   timestamptz NOT NULL DEFAULT now(),
  -- Adding the same variant twice increments the line rather than creating a
  -- second one, which is what a shopper expects and what keeps totals simple.
  CONSTRAINT one_line_per_variant UNIQUE (cart_id, variant_id)
);

CREATE INDEX cart_items_cart_idx ON cart_items (cart_id);
CREATE INDEX cart_items_variant_idx ON cart_items (variant_id);
