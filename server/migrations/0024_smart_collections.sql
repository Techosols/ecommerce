-- 0024_smart_collections.sql
-- Collections whose membership is a question, not a list (docs/catalogue-model.md §4).
-- Forward-only. Never edit a migration that has been applied (§4.4).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why a rules column and not a membership table
--
-- 0007 created `collections` with `type IN ('manual','dynamic')` and left the
-- second half unbuilt, noting that rule-driven membership would arrive "plus a
-- rules column, without touching products". This is that column.
--
-- A smart collection stores conditions and is evaluated on every read, for the
-- same reason customer segments are: "Under £50" has to stop containing
-- something the moment its price changes, and a materialised list would need
-- invalidating from every write path that touches a product, a variant, or its
-- stock. Miss one and the shop quietly sells the wrong things at the wrong
-- price on a landing page nobody is watching.
--
-- The shape is the shape segments use — `{ match, conditions[] }` — compiled by
-- the same engine against a product field catalogue. One rule builder in the
-- admin, one set of operators, one place where a rule becomes SQL.
--
-- ── The two invariants ───────────────────────────────────────────────────────
--
-- Both are enforced here rather than trusted to the service, because both are
-- the kind of thing that goes wrong quietly:
--
--   1. A manual collection carries no rules. Otherwise a collection switched
--      from dynamic to manual keeps conditions that no longer do anything, and
--      the next person to read the row cannot tell which half is live.
--   2. A dynamic collection has no hand-picked members. Its membership *is* its
--      rules; a stray `collection_products` row would be a product that appears
--      in the collection for a reason the rules do not explain.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE collections
  ADD COLUMN rules jsonb NOT NULL DEFAULT '{"match":"all","conditions":[]}';

COMMENT ON COLUMN collections.rules IS
  'Conditions for a dynamic collection, evaluated live. Empty for manual ones. Never interpolated into SQL: fields are keys into an allowlist.';

-- Invariant 1. Written as "not manual, or no conditions" so a manual row with
-- an empty rule set — the default — satisfies it without anybody writing one.
ALTER TABLE collections ADD CONSTRAINT manual_collections_have_no_rules CHECK (
  type = 'dynamic' OR rules -> 'conditions' = '[]'::jsonb
);

-- Invariant 2, which needs a trigger: the rule lives on the *parent* row, so a
-- CHECK on collection_products cannot see it.
CREATE OR REPLACE FUNCTION refuse_members_on_dynamic_collection() RETURNS trigger AS $$
BEGIN
  IF (SELECT type FROM collections WHERE id = NEW.collection_id) = 'dynamic' THEN
    RAISE EXCEPTION 'collection % is dynamic; its membership is its rules', NEW.collection_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER collection_products_are_manual_only
  BEFORE INSERT OR UPDATE ON collection_products
  FOR EACH ROW EXECUTE FUNCTION refuse_members_on_dynamic_collection();

-- ── Indexes the rule engine leans on ─────────────────────────────────────────
--
-- Smart collection rules are mostly asked of the columns a merchant thinks in:
-- vendor, product type, and price. `products.tags` and `products.status` are
-- already indexed by 0007; these are the two that were not.

CREATE INDEX products_vendor_idx ON products (vendor) WHERE archived_at IS NULL;
CREATE INDEX products_type_idx ON products (product_type) WHERE archived_at IS NULL;

-- Price lives on variants, and every price rule asks the same question of it:
-- what does this product cost, cheapest variant first.
CREATE INDEX product_variants_price_idx ON product_variants (product_id, price_amount)
  WHERE archived_at IS NULL;
