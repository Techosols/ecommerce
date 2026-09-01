-- 0014_discounts.sql
-- Discounts, their scope and their redemption ledger (§5.9).
-- Forward-only. Never edit a migration that has been applied (§4.4).

CREATE TABLE discounts (
  id                       uuid PRIMARY KEY,
  code                     citext NOT NULL UNIQUE,
  title                    text NOT NULL CHECK (length(btrim(title)) > 0),
  type                     text NOT NULL
                             CHECK (type IN ('percentage','fixed_amount','free_shipping')),
  -- Basis points when percentage, minor units when fixed. Integer either way.
  value                    integer NOT NULL CHECK (value >= 0),
  applies_to               text NOT NULL DEFAULT 'order'
                             CHECK (applies_to IN ('order','products','categories')),
  min_subtotal_cents       integer NOT NULL DEFAULT 0 CHECK (min_subtotal_cents >= 0),
  starts_at                timestamptz,
  ends_at                  timestamptz,
  usage_limit_total        integer CHECK (usage_limit_total > 0),
  usage_limit_per_customer integer CHECK (usage_limit_per_customer > 0),
  -- Denormalised counter, incremented under the row lock taken at redemption.
  -- `discount_redemptions` is the ledger it must agree with.
  usage_count              integer NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  requires_customer        boolean NOT NULL DEFAULT false,
  is_active                boolean NOT NULL DEFAULT true,
  created_by               uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  archived_at              timestamptz,
  CONSTRAINT window_is_ordered CHECK (
    ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at
  ),
  -- 100% off is the ceiling; 150% off is a refund with extra steps.
  CONSTRAINT percentage_is_bounded CHECK (type <> 'percentage' OR value <= 10000),
  -- A per-customer limit is meaningless for a code anyone can use anonymously.
  CONSTRAINT per_customer_limit_needs_a_customer CHECK (
    usage_limit_per_customer IS NULL OR requires_customer
  )
);

CREATE TRIGGER discounts_set_updated_at
  BEFORE UPDATE ON discounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX discounts_active_idx ON discounts (is_active, ends_at)
  WHERE archived_at IS NULL;

CREATE TABLE discount_products (
  discount_id uuid NOT NULL REFERENCES discounts(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY (discount_id, product_id)
);

CREATE TABLE discount_categories (
  discount_id uuid NOT NULL REFERENCES discounts(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (discount_id, category_id)
);

-- The ledger. Per-customer limits are counted from here, which is why it
-- carries customer_id even though the order already does.
CREATE TABLE discount_redemptions (
  id           uuid PRIMARY KEY,
  discount_id  uuid NOT NULL REFERENCES discounts(id) ON DELETE RESTRICT,
  order_id     uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  customer_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- One redemption of a code per order, enforced rather than checked.
  CONSTRAINT one_redemption_per_order UNIQUE (discount_id, order_id)
);

CREATE INDEX discount_redemptions_customer_idx ON discount_redemptions (discount_id, customer_id);

-- Now that discounts exist, close the forward reference from order_discounts.
-- SET NULL: deleting a campaign must not erase what a customer was charged.
ALTER TABLE order_discounts
  ADD CONSTRAINT order_discounts_discount_fk
  FOREIGN KEY (discount_id) REFERENCES discounts(id) ON DELETE SET NULL;
