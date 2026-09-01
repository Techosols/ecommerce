# Inventory

Locations, inventory items, levels, movements and reservations — what exists
today, and the reasoning behind the parts that could reasonably have gone
another way.

The store has one location and sells fast food. Nothing below is about that:
the shape is a general commerce inventory system, because the expensive mistake
is not "we modelled burgers awkwardly", it is "orders and multi-location both
need a schema we would now have to rewrite".

---

## 1. The spine

```
Product          the conceptual item          (catalogue)
   ↓
Variant          what a customer buys         (catalogue)
   ↓
Inventory item   what a stockroom tracks      one per variant
   ↓
Inventory level  quantity at ONE location     ← the only place quantity lives
   ↓
Location         where the stock is
```

**Quantity lives on a level, and nowhere else.** Not on the variant, not on the
item. That single rule is what makes a second branch an `INSERT` rather than a
migration with a data backfill and a rewrite of every read.

The item exists as a layer of its own even though it is one-to-one with a
variant today. A variant is a commercial object — a thing with a price and a
name; an item is an operational one — a thing that is counted. Keeping them
apart is what later allows a kit that draws down component items, or one item
backing two sellable variants, without touching the catalogue.

---

## 2. Locations

`inventory_locations` — code, name, address (free-form JSON, because a branch
and a warehouse do not share an address shape), active, default, position.

One row is seeded by migration 0008: `main`. Exactly one location is the
default, enforced by a partial unique index, so "where does stock land when
nobody says" is never ambiguous and no service has to pick a winner. **No code
anywhere names a location**; `main` appears in the migration and in tests, and
nowhere else.

The default location cannot be archived or deactivated, and a location holding
stock cannot be archived — transfer it out first, so the count reaches zero
because someone decided where the goods went rather than because a row was
hidden.

---

## 3. Levels, and why `available` is derived

```sql
on_hand    integer NOT NULL CHECK (on_hand >= 0)
reserved   integer NOT NULL CHECK (reserved >= 0)
available  integer GENERATED ALWAYS AS (on_hand - reserved) STORED
CONSTRAINT reserved_within_on_hand CHECK (reserved <= on_hand)
```

`available` is a **stored generated column**, not a third number the application
maintains. Two independently writable quantities that are supposed to agree will
eventually disagree, and the disagreement is always discovered by a customer.
Deriving it also makes "what can be sold" a plain indexed read, so the storefront
pays nothing for the correctness.

`reserved <= on_hand` is the invariant that makes overselling impossible *at the
storage layer* — it holds even if a service has a bug, which is the only kind of
guarantee worth having here. Together the two constraints mean `available` can
never be negative.

---

## 4. Movements: the append-only ledger

Nothing changes a level without writing an `inventory_movements` row in the same
transaction. The level is the running total; the movement is the evidence.

Each row carries the signed deltas, the reason, an optional reference, the
acting user, and the **resulting** totals — so history reads without re-summing
the whole ledger.

Reasons an operator may cite: `receive`, `manual_adjustment`, `stocktake`,
`damage`, `waste`, `return`, `correction`. Written by the system:
`transfer_in`, `transfer_out`, `reservation`, `reservation_release`,
`reservation_commit`, `reservation_expired`.

The table is append-only, enforced by a trigger rather than by convention:

```sql
CREATE TRIGGER inventory_movements_are_append_only
  BEFORE UPDATE OR DELETE ON inventory_movements ...
```

Stock is financial data. A movement row that can be edited afterwards is not
evidence of anything. Correcting a mistake means writing a compensating
movement, which is what an auditor expects to see in any case.

**There is no endpoint that sets a quantity.** `POST /inventory/adjustments`
takes a signed delta with a reason; `POST /inventory/stocktake` takes a counted
figure and computes the delta from it. Assignment (`onHand = 47`) races with
every concurrent movement and destroys the question an auditor actually asks —
*why is it 47?*

---

## 5. Reservations

```
available ──reserve──▶ reserved ──commit──▶ gone (goods left)
                           │
                           └──release / expire──▶ available again
```

A reservation carries item, location, quantity, status, owner (`cart` | `order`
| `manual` plus an id), and an expiry. `owner_type`/`owner_id` is the seam the
checkout will use — carts and orders can hold reservations without a schema
change.

Three properties are enforced rather than intended:

- **Resolved exactly once.** `UPDATE … WHERE status = 'active'` is a
  compare-and-swap. A double-release frees stock once; a double-commit consumes
  it once. The loser is told the reservation is already resolved.
- **One active reservation per owner per item per location**, a partial unique
  index — so a retried checkout request cannot silently hold twice the stock.
- **Resolution and status agree**, `CHECK ((status = 'active') = (resolved_at IS
  NULL))`.

A commit decrements `on_hand` and `reserved` together in one statement, so
`available` never twitches upward in between and lets someone else take the same
units.

Expiry is swept by `inventory.expire_reservations` every five minutes — not
nightly, because stock held by an abandoned checkout is stock the shop cannot
sell, and the cost of a late release is a lost sale.

---

## 6. Concurrency

Inventory is the one subsystem where "usually correct" is worthless. The
strategy is a **single conditional UPDATE** for every quantity change, and no
read-then-write anywhere:

```sql
UPDATE inventory_levels
   SET reserved = reserved + $qty
 WHERE id = $1 AND on_hand - reserved >= $qty
```

A `SELECT` followed by an `UPDATE` has a window: two requests both read
`available = 10`, both decide 7 is fine, both write. The single statement has no
window. Postgres takes the row lock as part of the update, and a writer that was
blocked re-evaluates its `WHERE` against the *committed* new version before
proceeding — so the loser's predicate simply stops being true and it affects
zero rows, which the service reads as "not enough stock".

This works because it is the database's guarantee, not the process's. **There is
no in-process mutex**, which would be worthless the moment a second Node process
started — and two processes is the normal deployment (api + worker), never mind
scaling the API.

Adjustments use the same shape, with a predicate that refuses both going
negative and dropping below what is already reserved:

```sql
WHERE id = $1 AND on_hand + $delta >= 0 AND on_hand + $delta >= reserved
```

The last condition is what stops a write-off stranding a live reservation.

`tests/integration/inventory.concurrency.test.ts` exercises all of this against
real PostgreSQL with genuinely simultaneous requests — see §8 below.

---

## 7. Availability

Five things get confused for one another constantly. They are separate, and any
one of them can veto:

```
product lifecycle    draft | active | archived     is it finished?
publication          a row per sales channel        is it on sale here?
variant active       a boolean on the variant       is this option offered?
inventory tracking   track_inventory                do we count it?
inventory available  on_hand - reserved             is there any left?
```

A variant is **purchasable** only when all five agree:

```
product.status = 'active'
AND published to the channel
AND variant.isActive AND not archived
AND (inventory untracked OR available > 0)
```

The rule lives in one place — `availability.ts` owns the inventory clause, the
catalogue owns the other three — so it cannot drift between the listing, the
product page and whatever the checkout does later.

The consequence that matters: **an out-of-stock product is still on the shop.**
It is visible, priced, and marked unavailable. Archiving or unpublishing it would
lose its URL, its SEO and its reviews because the kitchen ran out of buns.

---

## 8. Tracking policy: untracked means unlimited

`track_inventory = false` means **unlimited** — a made-to-order burger the
kitchen will always cook. It is never read as zero.

The same holds for a variant with no inventory item at all: untracked, not sold
out. Reading absence as zero would have silently hidden every product the day
this feature shipped, which is exactly the kind of failure that looks like a
data problem for a week. In practice the case does not arise, because the
catalogue creates an item for every variant in the same transaction as the
variant — but the semantics are stated rather than left to an accident.

`low_stock_threshold` is nullable on the item, and `NULL` means "use
`store_settings.default_low_stock_threshold`". That is a different answer from
`0`, which means "warn me at zero and not before".

---

## 9. Multi-location

The schema supports it now; the *routing* decisions do not exist yet.

```
Inventory item
   ├── Lahore Branch  → level
   ├── Islamabad      → level
   └── Warehouse      → level
```

Adjustments, transfers and reservations all take a location and default to the
store's default location. Availability sums across active locations, which is
the right answer for a single-storefront shop and the wrong answer for one that
ships from specific warehouses — that is fulfilment routing, and it is deferred.

---

## 10. Transfers

A transfer is atomic today: one transaction, two movements
(`transfer_out`/`transfer_in`) sharing a `reference_id`, and one
`inventory.transferred` event. Stock never exists in both places or neither, and
a transfer that cannot complete leaves nothing behind.

**Deferred:** the multi-step transfer *workflow* — draft, dispatched, in
transit, partially received. That needs a `transfers` table with a lifecycle,
and stock that is neither here nor there for a while. The movement reasons and
`reference_type = 'transfer'` already exist to carry it, so adding the workflow
does not disturb the ledger.

---

## 11. Events

| Event | Emitted when |
| --- | --- |
| `inventory.item_created` | a variant gets its inventory item |
| `inventory.adjusted` | `on_hand` moved, with the reason |
| `inventory.tracking_changed` | tracking switched on or off |
| `inventory.transferred` | stock moved between locations |
| `inventory.reserved` | stock claimed |
| `inventory.released` | a claim given back |
| `inventory.committed` | goods left |
| `inventory.reservation_expired` | a claim timed out |
| `inventory.low_stock` | availability **crossed** the threshold |
| `inventory.out_of_stock` | availability **reached** zero |
| `inventory.back_in_stock` | availability **left** zero |
| `inventory.location_created` | a location was added |

All published through the transactional outbox inside the business transaction,
so an event never describes a change that rolled back (§12.1).

**The stock-state events fire on transitions only.** The naive version emits
`low_stock` on every movement while stock sits below the line, which produces
thousands of identical events and trains everyone to ignore them. What is
interesting is the crossing:

```
above threshold ──▶ crosses ──▶ ONE event
below threshold ──▶ stays below ──▶ nothing
```

Untracked items emit no stock-state events at all, because "low" is meaningless
when supply is unlimited.

---

## 12. What the storefront is told

A **state**, never a number:

```json
{ "available": true, "availability": "in_stock" }
```

`in_stock` | `out_of_stock` | `made_to_order`.

Exposing exact stock is a product decision with real consequences: competitors
read it, "3 left" is a scarcity claim you must stand behind, and it invites a
race you then have to lose gracefully at checkout. The default here is **no**,
and `publicAvailabilityDto` is the single place that would change if someone
decides otherwise.

Never exposed: quantities, locations, movement history, actors, thresholds,
tracking policy, reservations.

---

## 13. Caching

The catalogue caches a product's *shape* — options, variants, media — for sixty
seconds. It deliberately does **not** cache availability.

Availability is resolved per request, in one batched query for the whole page.
So the failure the requirement names —

```
inventory = 0, and the storefront keeps saying available = true
```

— is impossible by construction rather than by remembering to invalidate. There
is no window, not even a short one.

The event-driven invalidation in `events/subscribers/inventory.subscribers.ts`
is defence in depth on top of that: every event that could change what a customer
is told drops the product's cached shape, across processes. It costs a map
delete, and it means that if anyone ever does fold availability into the cached
detail, the path already exists and already works.

---

## 14. Authorization

| Permission | Grants | Held by |
| --- | --- | --- |
| `inventory:read` | see stock, levels, history, reservations | staff, admin, owner |
| `inventory:adjust` | move stock; reserve, release, commit | staff, admin, owner |
| `inventory:transfer` | move stock between locations | staff, admin, owner |
| `inventory:manage` | create locations, change tracking policy | admin, owner |

Adjusting stock is day-to-day work, so staff hold it. Creating locations and
switching tracking off are structural decisions — switching tracking off makes
an item unconditionally purchasable — so they are not day-to-day work and staff
do not hold them. Customers reach none of it: `requireStaff()` denies at the
router before any permission is consulted.

---

## 15. Two different records

```
inventory_movements  what happened to stock   append-only, includes system actions
audit_logs           who did an administrative thing
```

They are not substitutes. A reservation expiring writes a movement and no audit
row — no person did it. An operator writing off three burgers writes both: the
ledger records the stock change, the audit trail records that a named person
made it. Replacing either with the other loses a question someone will ask.

---

## 16. Future order compatibility

```
Inventory → Cart → Checkout → Order → Payment → Fulfilment
```

An order will reserve at checkout and commit on payment, referencing
`variant`, `inventory_item`, `location`, `quantity` and `reservation` — all of
which exist now with stable ids. `owner_type = 'order'` is already a valid
value.

The load-bearing consequence: **no cart or checkout will ever be trusted for
quantity or availability.** They call `reservationsService.reserve`, and the
database decides. A client that says "there are 5 left" is describing what it
saw, not what is true.

---

## 17. Deliberately deferred

Carts, checkout, orders, payments, fulfilment. Purchasing and suppliers.
Warehouse management, bin locations, barcode scanning. Stock forecasting and
automatic replenishment. Inventory analytics. Multi-location fulfilment routing.
The multi-step transfer workflow. Backorders and negative-stock policies.

None of these require a schema change to the tables above — that is the test
each of them was designed against.
