# Carts, checkout and orders

The commerce path, and the reasoning behind the parts that look unusual.

---

## 1. A cart holds references, never prices

`cart_items` stores a variant and a quantity. Nothing else. Every read
re-resolves price and availability from the catalogue, so a basket left open
overnight shows this morning's price and this morning's stock — and a client has
nothing it could lie about.

A cart also does **not** reserve stock. Holding stock for everyone who ever
added an item would empty the shop by lunchtime. Reservation happens at
checkout.

Identity is the session or a guest cookie holding a random 32-byte token whose
**hash** is what the database stores, exactly like a refresh token. There is one
route shape — `/cart` — and never `/carts/:id`, because a cart id in a URL is a
way to reach somebody else's basket.

---

## 2. Checkout is one transaction

```
re-resolve the cart against the live catalogue
  → insert the order
  → snapshot every line
  → reserve stock for each line
  → copy the addresses
  → consume the discount
  → mark the cart converted
```

If any step fails there is no order, no reservation and no charge. That is the
whole point of doing it in one transaction rather than five steps a customer can
abandon between — and it is what the concurrency suite proves: two people racing
for the last unit produce one order and one clean `INSUFFICIENT_STOCK`, with no
orphaned items or addresses behind the loser.

**Nothing monetary crosses the boundary inbound.** No price, line total,
subtotal, tax, shipping amount, discount value or order total. The request
carries an address, an email, a delivery method *id* and possibly a discount
*code*. A strict schema makes sending anything else a 422 rather than a bargain.

### The snapshot

`order_items` copies the product title, variant title, SKU, image, options and
unit price as they were. Renaming or repricing a product tomorrow cannot rewrite
what somebody bought today. `order_addresses` is a copy for the same reason —
editing the address book must not move a parcel that has already been sent.

### Rounding

A discount is apportioned across lines by share of subtotal, and the **last line
absorbs the remainder**, so the parts sum exactly to the order-level figure. The
database's `total_is_consistent` CHECK refuses an order whose parts do not add
up, so this is enforced rather than intended.

---

## 3. Three status machines

`status`, `payment_status` and `fulfillment_status` move independently, each
through its own validated transitions.

Collapsing them makes real states inexpressible — paid but unshipped, shipped
but partly refunded — and makes invalid transitions legal. The flat vocabulary a
customer sees (`pending / confirmed / shipped / delivered / …`) is **derived**
for display and never stored: a fourth column that must agree with three others
is a fourth column that will eventually disagree.

Precedence, when several are true at once: cancelled beats everything, then
returned, then delivered.

### Confirmation and cancellation move stock

- **Confirm** commits the reservations — the stock actually leaves the shelf —
  and records the purchase against the customer's lifetime figures. It is
  idempotent, because it is reached from three directions (a payment landing,
  staff accepting a COD order, the generic transition endpoint) and any of them
  may arrive twice. A cancelled order is refused rather than silently revived.
- **Cancel** returns the stock, by one of two routes that the ledger
  distinguishes: an unconfirmed order's hold is *released*, while a confirmed
  order's stock comes back as an explicit `return` movement. Staff may decline
  the restock — a damaged return is not sellable.

---

## 4. Shipping

Zones own country lists; methods own rates. `flat` charges its price, `free`
charges nothing, `weight_based` charges per started kilogram, and a
free-over-subtotal threshold beats all three. Weight bands on a method decide
whether it is *offered*, not what it costs.

The server rates the delivery. A client picks a method by id and checkout
**re-rates it** against the destination rather than trusting the id, because a
method id from a stale page may belong to a zone that no longer covers the
address.

The public `/storefront/shipping/rates` returns rates for one destination — not
the zone list, the country lists or the weight bands.

---

## 5. Discounts

The server computes the amount; a client sends a code. Every refusal has its own
error code — expired, used up, needs an account, minimum not met, does not apply
to this basket — because "invalid coupon" is the message that generates support
tickets.

**Scope is real.** A discount `appliesTo: 'products'` or `'categories'` covers
only the lines it actually names; computing it against the whole subtotal
regardless would mean a store running a promotion on one product gives it away
on the entire catalogue.

**Redemption is counted twice on purpose.** `usage_count` is a denormalised
counter incremented under a row lock; `discount_redemptions` is the ledger it
must agree with. The counter makes "is this used up?" a single indexed read; the
ledger makes per-customer limits and any audit possible.

Both limits are enforced under that lock, and this is the subtle part: the total
limit is guarded by the conditional `UPDATE` itself, while the **per-customer**
limit is re-checked *after* the update has taken the row lock. Checking it
before, as the quote does, is a read — two simultaneous checkouts by the same
person would both pass it.

Redemption happens **inside the checkout transaction**, so a customer who loses
the race for the last use gets no order at all, rather than one at full price
they did not agree to.

Cancelling an order gives the use back.

---

## 6. Refunds

**A refund is an amount of money; restocking is a number of units.** They are
different quantities, so a refund that puts stock back must say *which* units:
`restock: true` requires `items: [{orderItemId, quantity}]` and is a 422
without them. Refunding a pound of a three-unit line is not three units
returning to the shelf.

`order_items.refunded_quantity` records what came back, which is what stops a
later cancellation restocking the same units a second time, and what makes
"more units than were ordered" impossible across any number of partial refunds.
A money-only goodwill refund simply omits both fields.

The amount itself is guarded in the database, not in a service:

```sql
UPDATE payments
   SET refunded_cents = refunded_cents + $2, status = …
 WHERE id = $1 AND refunded_cents + $2 <= amount_cents
```

Two staff refunding at once cannot together exceed the payment — the second
one's predicate fails against the first's committed row. The order's
`refunded_total_cents` is then incremented atomically and **re-read**, because
deriving "is this fully refunded?" from a value fetched before the increment is
wrong the moment two refunds overlap.

---

## 7. Finding an order again

A guest checkout would otherwise be a one-way door — the 201 is the only time
they see the order. `POST /storefront/orders/lookup` takes the order number and
the email it was placed with.

Three things keep that safe: it matches **only orders with no account attached**
(order numbers come from a sequence and are guessable, so without that anyone
knowing a customer's address could walk the numbers and read their history); it
is rate limited to ten attempts per quarter-hour per address; and every failure
returns the same 404, so it reveals neither which numbers exist nor which
addresses have shopped here. It is a POST because an email in a URL ends up in
access logs, history and the `Referer` of every asset the page loads.

## 8. What a customer may see

Two serialisers, written separately rather than one with fields omitted. The
customer's own view hides the admin note, the source and the internal status
triple, and shows the derived flat status. Reads go through
`detailForCustomer`, which matches on the owner: another customer's order is a
404, not a 403, because the route must not confirm the order exists.
