# Catalogue domain model

The commerce model the catalogue is built on, the reasoning behind the parts
that could reasonably have gone another way, and the amendments this makes to
§5.4 of the approved plan.

The store sells fast food today. Nothing below is about burgers: the shape is a
general commerce catalogue, because the expensive mistake is not "we modelled
pizzas awkwardly", it is "orders reference a table we now have to rewrite".

---

## 1. The spine

```
Product ────────────── the conceptual item      "Classic Burger"
   ├── Options ─────── the axes it varies on     Size, Crust
   │     └── Values                              Small · Medium · Large
   ├── Variants ────── purchasable configurations Small/Classic
   │     └── one value per option, price, SKU
   ├── Media ───────── ordered, one primary
   └── Category ────── what kind of thing it is

Collections ────────── which products appear together (many-to-many)
Publications ───────── which channels it is visible on
```

**Only a variant is purchasable.** A product is never added to a cart, never
priced, never counted. Every product has at least one variant; a product with no
declared options gets a single variant titled `Default`. That single rule is
what makes "Classic Burger" and "Pizza, 3 sizes × 2 crusts" the same shape.

Options are data, not columns. There is no `size` column and no `flavour`
column; there is a `product_options` row named "Size" with values, and a variant
selects one value from each option. Adding "Spice level" to one product is an
insert, not a migration.

---

## 2. Entities

| Entity                   | Owns                                                        |
| ------------------------ | ----------------------------------------------------------- |
| `products`               | title, description, status, category, SEO, handle           |
| `product_handles`        | every handle a product has ever had (see §6)                |
| `product_options`        | an axis of variation, ordered                               |
| `product_option_values`  | one allowed value on that axis, ordered                     |
| `product_variants`       | SKU, barcode, price, weight, position, media, active        |
| `variant_option_values`  | a variant's selection: one value per option                 |
| `product_media`          | product images, ordered, exactly one primary                |
| `categories`             | the taxonomy tree                                           |
| `collections`            | merchandising groupings                                     |
| `collection_products`    | membership, ordered                                         |
| `sales_channels`         | where a product can be published (one row today)            |
| `product_publications`   | product × channel visibility                                |

---

## 3. Three states that are not the same state

The single most common catalogue modelling error is collapsing these.

```
lifecycle      products.status         draft | active | archived
publication    product_publications    a row per channel it is visible on
availability   (deferred — inventory)  can it be bought right now
```

- **Lifecycle** is editorial: is this thing finished, in use, or retired.
- **Publication** is distribution: which storefronts show it. Modelled as rows,
  not a boolean, because `published_at` on the product cannot answer "visible on
  the web store but not the kiosk" without a schema change.
- **Availability** is stock, and belongs to inventory. It is deliberately absent
  from these tables.

So "active product, published, currently unavailable" is representable, which is
exactly the state a sold-out burger is in at 9pm. Archiving is the only
retirement: **nothing in the catalogue is ever hard-deleted**, because a future
`order_items.variant_id` must stay resolvable for the life of the order.

---

## 4. Categories vs collections — kept separate, deliberately

They answer different questions, and unifying them makes every consumer ask
"which kind is this row?" at every use site.

| | Category | Collection |
| --- | --- | --- |
| Question | *What kind of product is this?* | *Which products belong together?* |
| Cardinality | one per product | many per product |
| Shape | a tree | a flat set |
| Ordering | categories among siblings | **products within the collection** |
| Changes | rarely; it is structure | often; it is merchandising |
| Later | drives tax class, reporting, navigation | may become rule-driven |

A unified "collections with an optional parent" table (Shopify's approach, more
or less) works right up to the first question that needs the taxonomy alone —
"what is our best-selling *category*" — and then every query carries a
`WHERE kind = 'category'` that nothing enforces.

**Amendment to the plan:** §5.4 gives products both `primary_category_id` *and*
a `product_categories` many-to-many. That is two sources of truth for one
question. A product has **exactly zero or one category**. If something genuinely
belongs in two places, that is merchandising, and merchandising is a collection.
`product_categories` is dropped.

Dynamic (rule-driven) collections are deferred; `collections.type` carries
`manual` today so `dynamic` can be added without touching membership.

---

## 5. Pricing

Money is an integer number of minor units. There is no floating point anywhere
near a price, in the database, the service, or the JSON.

```
product_variants.price_amount           integer, minor units, NOT NULL
product_variants.compare_at_amount      integer, nullable  (the "was" price)
product_variants.currency               char(3)
```

Currency is stored **on the variant**, not read from store settings at display
time. Settings' currency is a setting; if an operator changes it, prices must
not silently reinterpret 1299 from pence to cents. Today the service requires
every price to match the store currency; lifting that is what multi-currency
means.

Every price crosses the API as a money object, never a bare number:

```json
{ "amount": 1299, "currency": "GBP" }
```

That shape is already what a price list, a sale price or a customer-specific
price would return, so adding them later changes what the resolver reads, not
what clients parse. All price reads go through `pricing.ts`, a single seam with
one implementation today — deliberately, so there is one place for price lists,
sale windows and customer pricing to arrive.

**The server is the only authority on price.** No endpoint accepts a price from
a client, and when carts arrive they will store a variant reference, not an
amount.

---

## 6. Handles are addresses; ids are identity

`/products/classic-burger` is an address that may change. `products.id` is the
identity that never does. Every internal reference — variants, media,
collections, and later cart and order lines — uses the uuid.

Renaming a handle must not 404 the link someone bookmarked, so every handle a
product has ever held is kept:

```sql
product_handles (handle PRIMARY KEY, product_id, is_current, created_at)
```

The primary key gives uniqueness **across time**, not just across live products:
a new product cannot claim a handle that used to point somewhere else, which is
what makes an old link safely redirectable instead of silently landing on the
wrong item. Storefront lookup resolves the current handle, or reports the
canonical one so the edge can issue a 301.

---

## 7. Integrity the database enforces itself

Service-layer checks are good; constraints are better, because they hold when
the service has a bug.

```sql
-- one value per option per variant, and the value must belong to that option
variant_option_values (
  variant_id, option_id, option_value_id,
  PRIMARY KEY (variant_id, option_id),
  FOREIGN KEY (option_id, option_value_id)
    REFERENCES product_option_values (option_id, id)
)

-- no two variants of a product share a combination
product_variants.option_signature  UNIQUE (product_id, option_signature)

-- exactly one primary image per product
CREATE UNIQUE INDEX ... ON product_media (product_id) WHERE is_primary
```

`option_signature` is a deterministic fingerprint of the sorted selected value
ids, written by the service inside the same transaction as the selections. It is
the one denormalisation here, and it buys database-enforced "no duplicate
Small/Classic".

"Every product has ≥1 variant" and "a variant selects a value for *every*
option" cannot be expressed as constraints without triggers, so they are service
invariants with tests naming them.

**Amendment to the plan:** §5.4's `variant_option_values(variant_id,
option_value_id)` permits a variant with two sizes, or none. The composite form
above does not.

---

## 8. Inventory: identity now, system later

No inventory table is created in this phase. The variant's uuid is the stable
identity a future inventory system references, and no quantity is stored on a
product or a variant.

**Amendment to the plan:** §5.5 keys `inventory_items` by `variant_id` as its
primary key, which forecloses multi-location — the very thing the plan's own
roadmap wants. The corrected target shape is:

```
variant → inventory_item (own id) → stock levels per location
```

That is a note for the inventory phase, not work for this one.

---

## 9. Media

Product media references `media_assets` rows — never a Supabase URL, never a
storage key. URLs are produced at read time by the `StorageProvider`, so the
bucket, its visibility and the whole backend can change without touching the
catalogue. A media asset must be `ready` before it can be attached: attaching a
`pending` upload would publish bytes nothing has inspected.

Ordering and a single primary image are supported now. Variant-specific media is
one nullable column on the variant pointing at a `product_media` row; multiple
images per variant is deferred.

---

## 10. Built toward, not built

The shape below is what the schema must not obstruct. None of it is implemented.

```
Catalogue → Cart → Checkout → Order → Payment → Fulfilment
```

The load-bearing consequence for *this* phase: **an order line snapshots what
was bought** — title, variant title, option selections, SKU and price at the
moment of purchase — and only *also* keeps a `variant_id` for traceability. So
the catalogue is free to rename, reprice and restructure, and history stays
true. The catalogue's obligation is narrower than it looks: never destroy a
variant id, and never let price live anywhere a cart could quote from.

---

## 11. Scope

**In this phase:** products with options, values and variants; product media;
categories; collections; publication to a single seeded channel; handles with
history; lifecycle transitions; storefront and admin APIs; events; caching;
audit.

**Deferred, by name:** inventory, carts, checkout, orders, payments, discounts,
bundles, subscriptions, multi-currency, multi-location, dynamic collections,
search infrastructure beyond a simple text filter, advanced SEO, webhooks.
