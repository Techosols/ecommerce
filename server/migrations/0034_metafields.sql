-- 0034_metafields.sql
-- Custom fields the shop defines for itself, with types the server enforces.
-- Forward-only. Never edit a migration that has been applied (§4.4).
--
-- ── Why this is two tables and not a jsonb column ────────────────────────────
--
-- `products.metadata` already exists and is a jsonb bag. It is the right shape
-- for the handful of internal keys the system itself writes, and the wrong
-- shape for fields a merchant defines: a bag has no types, so nothing can
-- validate it; no names, so nothing can label it; no list of what fields exist,
-- so an admin cannot render a form; and no visibility flag, so exposing one
-- field to the storefront means exposing the supplier's cost price with it.
--
-- Definitions are therefore data. "This shop's products have an Ingredients
-- field, it is multi-line text, and customers may see it" is a row, which means
-- the admin renders a form from it, the server validates writes against it, and
-- the storefront filters on it. Adding a field is an insert, not a migration —
-- the same reasoning that made product options data rather than columns.

-- ── What fields exist ────────────────────────────────────────────────────────

CREATE TABLE metafield_definitions (
  id             uuid PRIMARY KEY,

  /*
   * What kind of record carries this field.
   *
   * `customer` means a row in `users`: this schema has no separate customers
   * table — a customer is a user who has bought something (0011 references
   * `users(id)` for `orders.customer_id`), and inventing a second identity here
   * would be a second answer to "who is this person".
   */
  owner_type     text NOT NULL
                   CHECK (owner_type IN ('product','variant','collection','customer','order')),

  -- Namespace and key are the machine identity, and the pair is what a
  -- storefront queries by. Separate from `name`, which is what staff read and
  -- may be renamed freely without breaking a template.
  namespace      text NOT NULL CHECK (namespace ~ '^[a-z][a-z0-9_]{0,63}$'),
  key            text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,63}$'),

  name           text NOT NULL,
  description    text,

  /*
   * The type, which decides three things at once: what the admin renders, what
   * the server will accept, and how the value is stored in `value` below.
   *
   * Deliberately no `money` type. Money in this system is an integer of minor
   * units with a currency beside it, and every rule about it lives in typed
   * columns — a price in a metafield would be a second, unvalidated place for
   * money to live, and the first thing anybody would do is add it to something.
   */
  type           text NOT NULL
                   CHECK (type IN ('single_line_text','multi_line_text','integer',
                                   'decimal','boolean','date','url','json')),

  /*
   * Bounds the server checks on write: minLength/maxLength, min/max, choices.
   *
   * No regular expressions, on purpose. A merchant-supplied pattern is run by
   * the server against merchant-supplied input, which is a denial-of-service
   * waiting for the first accidental nested quantifier. Length bounds and a
   * list of allowed choices cover what these fields are actually for.
   */
  validations    jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Marks the field as expected. It is enforced where a value is written; it
  -- cannot retroactively block saving a product that never had one, because
  -- that would put metafields in the path of every create in the system.
  required       boolean NOT NULL DEFAULT false,

  /*
   * Whether customers may see it.
   *
   * Default false, and that default is the point: a field is private until
   * somebody decides otherwise. The opposite default leaks a supplier code or a
   * margin note the first time anybody adds one without thinking.
   */
  storefront_visible boolean NOT NULL DEFAULT false,

  position       integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  -- One definition per name, per kind of record. Two "custom.ingredients" on
  -- products is an ambiguity a storefront could not resolve.
  CONSTRAINT metafield_definitions_identity UNIQUE (owner_type, namespace, key)
);

CREATE INDEX metafield_definitions_owner_idx
  ON metafield_definitions (owner_type, position, created_at);
-- The storefront's query: "which fields on this kind of record are public?"
CREATE INDEX metafield_definitions_public_idx
  ON metafield_definitions (owner_type) WHERE storefront_visible;

COMMENT ON TABLE metafield_definitions IS
  'The custom fields this shop has defined. The admin renders forms from these and the server validates against them.';
COMMENT ON COLUMN metafield_definitions.storefront_visible IS
  'False by default: a field is private until somebody decides otherwise.';

-- ── What is in them ──────────────────────────────────────────────────────────
--
-- ── Why five owner columns rather than one `owner_id` ────────────────────────
--
-- Postgres cannot point one foreign key at five tables, and the usual answer —
-- a bare `owner_id uuid` with no constraint — means nothing deletes these rows.
-- Delete a customer under a data-protection request and their metafields stay
-- behind, holding whatever somebody typed into a field called "notes", with no
-- row left to explain who it was about. That is the failure worth spending five
-- columns to make impossible.
--
-- So: one nullable column per owner kind, each a real foreign key that cascades,
-- and a CHECK that exactly one is set. Deleting the owner deletes its values,
-- enforced by the database rather than remembered by a job.

CREATE TABLE metafield_values (
  id             uuid PRIMARY KEY,
  definition_id  uuid NOT NULL REFERENCES metafield_definitions(id) ON DELETE CASCADE,

  product_id     uuid REFERENCES products(id) ON DELETE CASCADE,
  variant_id     uuid REFERENCES product_variants(id) ON DELETE CASCADE,
  collection_id  uuid REFERENCES collections(id) ON DELETE CASCADE,
  customer_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  order_id       uuid REFERENCES orders(id) ON DELETE CASCADE,

  /*
   * The value, as JSON of its own natural type.
   *
   * An integer is stored as a JSON number and a boolean as a JSON boolean, so
   * the type survives the round trip and nothing has to parse "42" back out of
   * a text column and guess. One column rather than eight sparse typed ones:
   * the definition already says which type it is, and a `value_decimal` sitting
   * null on every text field is a wide table pretending to be a schema.
   */
  value          jsonb NOT NULL,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  -- Exactly one owner. Without this a row could name a product *and* an order,
  -- and every read after that would be guessing.
  CONSTRAINT metafield_values_one_owner CHECK (
    (product_id    IS NOT NULL)::int +
    (variant_id    IS NOT NULL)::int +
    (collection_id IS NOT NULL)::int +
    (customer_id   IS NOT NULL)::int +
    (order_id      IS NOT NULL)::int = 1
  )
);

-- One value per field per record. Partial uniques rather than one composite,
-- because four of the five columns are null on any given row.
CREATE UNIQUE INDEX metafield_values_product_once
  ON metafield_values (definition_id, product_id) WHERE product_id IS NOT NULL;
CREATE UNIQUE INDEX metafield_values_variant_once
  ON metafield_values (definition_id, variant_id) WHERE variant_id IS NOT NULL;
CREATE UNIQUE INDEX metafield_values_collection_once
  ON metafield_values (definition_id, collection_id) WHERE collection_id IS NOT NULL;
CREATE UNIQUE INDEX metafield_values_customer_once
  ON metafield_values (definition_id, customer_id) WHERE customer_id IS NOT NULL;
CREATE UNIQUE INDEX metafield_values_order_once
  ON metafield_values (definition_id, order_id) WHERE order_id IS NOT NULL;

-- The read every page does: "all the values for this one record".
CREATE INDEX metafield_values_product_idx ON metafield_values (product_id) WHERE product_id IS NOT NULL;
CREATE INDEX metafield_values_variant_idx ON metafield_values (variant_id) WHERE variant_id IS NOT NULL;
CREATE INDEX metafield_values_collection_idx ON metafield_values (collection_id) WHERE collection_id IS NOT NULL;
CREATE INDEX metafield_values_customer_idx ON metafield_values (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX metafield_values_order_idx ON metafield_values (order_id) WHERE order_id IS NOT NULL;

COMMENT ON TABLE metafield_values IS
  'One value per definition per record. Exactly one owner column is set, enforced by CHECK; the owner''s deletion cascades.';
COMMENT ON COLUMN metafield_values.value IS
  'The value as JSON of its own type — a number stays a number. The definition says which type to expect.';
