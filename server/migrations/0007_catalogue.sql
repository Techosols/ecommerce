-- 0007_catalogue.sql
-- Products, options, variants, media, categories, collections, publication.
-- Forward-only. Never edit a migration that has been applied (§4.4).
--
-- The model and its reasoning: docs/catalogue-model.md.
--
-- Three rules this file encodes that are expensive to add later:
--   • only a VARIANT is purchasable — price and SKU live there, never on a product
--   • lifecycle, publication and availability are three different things
--   • nothing is ever hard-deleted, because an order will reference a variant id
--     for as long as the order exists

-- ─────────────────────────────────────────────────────────────────────────────
-- categories — the taxonomy. "What kind of product is this?"
--
-- A tree, and a product sits at exactly one node. Multi-membership is what a
-- collection is for; see docs/catalogue-model.md §4 for why these are not one
-- table.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE categories (
  id           uuid PRIMARY KEY,
  parent_id    uuid REFERENCES categories(id) ON DELETE RESTRICT,
  name         text NOT NULL,
  handle       citext NOT NULL UNIQUE,
  description  text,
  image_id     uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  position     integer NOT NULL DEFAULT 0,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz,
  CONSTRAINT category_is_not_its_own_parent CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE TRIGGER categories_set_updated_at
  BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX categories_parent_idx ON categories (parent_id, position) WHERE archived_at IS NULL;

COMMENT ON TABLE categories IS
  'Taxonomy: what kind of product this is. One node per product. A tree.';

-- ─────────────────────────────────────────────────────────────────────────────
-- sales_channels — where a product can be published.
--
-- One row today. It exists so that publication is a relationship rather than a
-- boolean: `published_at` on the product cannot express "on the web store but
-- not the kiosk" without a schema change, and that change would land after
-- orders already reference the catalogue.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE sales_channels (
  id         uuid PRIMARY KEY,
  key        citext NOT NULL UNIQUE,
  name       text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Exactly one default channel, so "the storefront" is never ambiguous.
CREATE UNIQUE INDEX sales_channels_one_default ON sales_channels ((true)) WHERE is_default;

INSERT INTO sales_channels (id, key, name, is_default)
VALUES ('00000000-0000-4000-8000-000000000001', 'storefront', 'Online storefront', true);

COMMENT ON TABLE sales_channels IS
  'Publication targets. Seeded with one; multi-channel is additive, not a rewrite.';

-- ─────────────────────────────────────────────────────────────────────────────
-- products — the conceptual item. Never purchasable, never priced.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE products (
  id              uuid PRIMARY KEY,
  -- The public address. Identity is `id`; see product_handles for why.
  handle          citext NOT NULL UNIQUE,
  title           text NOT NULL CHECK (length(btrim(title)) > 0),
  subtitle        text,
  description     text,
  -- Editorial lifecycle. NOT visibility, NOT availability.
  status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'active', 'archived')),
  category_id     uuid REFERENCES categories(id) ON DELETE SET NULL,
  product_type    text,
  vendor          text,
  tags            text[] NOT NULL DEFAULT '{}',
  seo_title       text,
  seo_description text,
  metadata        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  search_vector   tsvector GENERATED ALWAYS AS (
                    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
                    setweight(to_tsvector('simple', coalesce(subtitle, '')), 'B') ||
                    setweight(to_tsvector('simple', coalesce(product_type, '')), 'B') ||
                    setweight(to_tsvector('simple', coalesce(description, '')), 'C')
                  ) STORED,
  CONSTRAINT archived_products_have_a_date CHECK (
    (status = 'archived') = (archived_at IS NOT NULL)
  )
);

CREATE TRIGGER products_set_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX products_search_idx ON products USING gin (search_vector);
CREATE INDEX products_tags_idx ON products USING gin (tags);
CREATE INDEX products_status_idx ON products (status, created_at DESC);
CREATE INDEX products_category_idx ON products (category_id) WHERE archived_at IS NULL;

COMMENT ON TABLE products IS
  'The conceptual item. Not purchasable: price and SKU live on product_variants.';
COMMENT ON COLUMN products.status IS
  'Editorial lifecycle only. Visibility is product_publications; stock is inventory.';

-- ─────────────────────────────────────────────────────────────────────────────
-- product_handles — every handle a product has ever had.
--
-- The primary key gives uniqueness across *time*, not merely across live rows:
-- a new product cannot claim a handle that used to point elsewhere. That is
-- what makes an old bookmark safely redirectable rather than silently landing
-- on the wrong item.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE product_handles (
  handle     citext PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  is_current boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX product_handles_one_current ON product_handles (product_id) WHERE is_current;
CREATE INDEX product_handles_product_idx ON product_handles (product_id);

COMMENT ON TABLE product_handles IS
  'Handle history. A handle is an address that may change; products.id is identity.';

-- ─────────────────────────────────────────────────────────────────────────────
-- product_options / product_option_values — the axes a product varies on.
--
-- Data, not columns. There is no "size" column and no "flavour" column, so
-- giving one product a spice level is an INSERT rather than a migration.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE product_options (
  id         uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (length(btrim(name)) > 0),
  position   integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, name),
  -- Needed by the composite foreign key on variant_option_values below.
  UNIQUE (id, product_id)
);

CREATE INDEX product_options_product_idx ON product_options (product_id, position);

CREATE TABLE product_option_values (
  id         uuid PRIMARY KEY,
  option_id  uuid NOT NULL REFERENCES product_options(id) ON DELETE CASCADE,
  value      text NOT NULL CHECK (length(btrim(value)) > 0),
  position   integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (option_id, value),
  -- Lets a variant's selection prove, in SQL, that the value belongs to the
  -- option it was selected for.
  UNIQUE (option_id, id)
);

CREATE INDEX product_option_values_option_idx ON product_option_values (option_id, position);

-- ─────────────────────────────────────────────────────────────────────────────
-- product_variants — the only purchasable thing in the system.
--
-- Every product has at least one, even when it has no options: that variant is
-- titled 'Default'. One rule, so a burger and a 6-way pizza are the same shape.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE product_variants (
  id                uuid PRIMARY KEY,
  product_id        uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  title             text NOT NULL DEFAULT 'Default',
  sku               citext UNIQUE,
  barcode           text,
  -- Money is an integer number of minor units. No floating point, ever.
  price_amount      integer NOT NULL CHECK (price_amount >= 0),
  compare_at_amount integer CHECK (compare_at_amount IS NULL OR compare_at_amount >= 0),
  -- On the variant, not read from settings at display time: changing the store
  -- currency must not silently reinterpret 1299 from pence to cents.
  currency          char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  weight_grams      integer NOT NULL DEFAULT 0 CHECK (weight_grams >= 0),
  requires_shipping boolean NOT NULL DEFAULT true,
  position          integer NOT NULL DEFAULT 0,
  -- Variant-specific imagery. One image now; several is a later table.
  media_id          uuid,
  is_active         boolean NOT NULL DEFAULT true,
  -- Deterministic fingerprint of the sorted selected option-value ids. The one
  -- denormalisation here, and it buys database-enforced "no two variants of
  -- this product share a combination".
  option_signature  text NOT NULL DEFAULT '',
  metadata          jsonb NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  archived_at       timestamptz,
  CONSTRAINT compare_at_is_above_price CHECK (
    compare_at_amount IS NULL OR compare_at_amount > price_amount
  ),
  CONSTRAINT variant_combination_is_unique UNIQUE (product_id, option_signature)
);

CREATE TRIGGER product_variants_set_updated_at
  BEFORE UPDATE ON product_variants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX product_variants_product_idx ON product_variants (product_id, position)
  WHERE archived_at IS NULL;

COMMENT ON TABLE product_variants IS
  'The purchasable unit. Its id is the stable identity inventory, carts and order lines reference.';
COMMENT ON COLUMN product_variants.option_signature IS
  'Sorted selected option-value ids. Maintained by the service inside the same transaction.';

-- ─────────────────────────────────────────────────────────────────────────────
-- variant_option_values — a variant's selection.
--
-- The composite key and composite foreign key together make two errors
-- impossible rather than merely unlikely: a variant cannot select two values
-- for one option, and cannot select a value belonging to a different option.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE variant_option_values (
  variant_id      uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  option_id       uuid NOT NULL REFERENCES product_options(id) ON DELETE CASCADE,
  option_value_id uuid NOT NULL,
  PRIMARY KEY (variant_id, option_id),
  FOREIGN KEY (option_id, option_value_id)
    REFERENCES product_option_values (option_id, id) ON DELETE RESTRICT
);

CREATE INDEX variant_option_values_value_idx ON variant_option_values (option_value_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- product_media — images, ordered, exactly one primary.
--
-- References media_assets. Never a URL and never a storage key: URLs are
-- produced at read time by the StorageProvider, so the bucket and even the
-- backend can change without touching the catalogue (§46).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE product_media (
  id         uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  media_id   uuid NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  alt        text,
  position   integer NOT NULL DEFAULT 0,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, media_id),
  -- Lets a variant prove its image is one of its own product's images.
  UNIQUE (id, product_id)
);

CREATE UNIQUE INDEX product_media_one_primary ON product_media (product_id) WHERE is_primary;
CREATE INDEX product_media_product_idx ON product_media (product_id, position);

-- The column list on SET NULL is load-bearing: a composite foreign key nulls
-- *every* referencing column by default, which would blank the NOT NULL
-- product_id and fail the delete. Naming media_id clears only the image.
ALTER TABLE product_variants
  ADD CONSTRAINT variant_media_belongs_to_product
  FOREIGN KEY (media_id, product_id) REFERENCES product_media (id, product_id)
  ON DELETE SET NULL (media_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- collections — "which products belong together?"
--
-- Merchandising, not taxonomy: many-to-many, and the order of products within a
-- collection is itself editorial content. `type` is 'manual' today; rule-driven
-- membership arrives as 'dynamic' plus a rules column, without touching
-- products.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE collections (
  id              uuid PRIMARY KEY,
  handle          citext NOT NULL UNIQUE,
  title           text NOT NULL CHECK (length(btrim(title)) > 0),
  description     text,
  image_id        uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  type            text NOT NULL DEFAULT 'manual' CHECK (type IN ('manual', 'dynamic')),
  position        integer NOT NULL DEFAULT 0,
  is_active       boolean NOT NULL DEFAULT true,
  seo_title       text,
  seo_description text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz
);

CREATE TRIGGER collections_set_updated_at
  BEFORE UPDATE ON collections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX collections_position_idx ON collections (position) WHERE archived_at IS NULL;

COMMENT ON TABLE collections IS
  'Merchandising groupings. Distinct from categories: see docs/catalogue-model.md §4.';

CREATE TABLE collection_products (
  collection_id uuid NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  product_id    uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  position      integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, product_id)
);

CREATE INDEX collection_products_product_idx ON collection_products (product_id);
CREATE INDEX collection_products_order_idx ON collection_products (collection_id, position);

-- ─────────────────────────────────────────────────────────────────────────────
-- product_publications — product × channel visibility.
--
-- A row means "visible there". Publication is separate from status on purpose:
-- an active product can be unpublished, and a published product can be out of
-- stock. Three different questions, three different answers.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE product_publications (
  product_id       uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sales_channel_id uuid NOT NULL REFERENCES sales_channels(id) ON DELETE CASCADE,
  published_at     timestamptz NOT NULL DEFAULT now(),
  published_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (product_id, sales_channel_id)
);

CREATE INDEX product_publications_channel_idx
  ON product_publications (sales_channel_id, published_at DESC);

COMMENT ON TABLE product_publications IS
  'Visibility per channel. Presence of a row is the publication; there is no boolean.';
