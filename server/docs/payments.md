# Payments

v1 sells with **cash on delivery**. This document explains how that works, why
it is shaped the way it is, and what adding a second method actually involves.

---

## 1. The one distinction that matters

A payment method differs from another in exactly one interesting way: **when the
money arrives relative to the goods.** Everything else follows from it.

| | `on_delivery` | `before_delivery` |
| --- | --- | --- |
| Example | cash on delivery | card, bank transfer, staff marking paid |
| Order confirms when | the shop decides to ship it | the money lands |
| Unpaid after two days means | nothing — that is normal | the customer walked away |
| Stock is committed at | acceptance | payment |

That is why `settlement` is the field the rest of the system branches on, and
why nothing outside `payments/methods.ts` should ever test for the string
`'cod'`.

---

## 2. The registry

`src/features/payments/methods.ts` holds one entry per method:

```ts
{
  key: 'cod',
  settlement: 'on_delivery',
  selectableAtCheckout: true,
  enabled: (settings) => settings.codEnabled,
  feeCents: (context) => context.settings.codFeeCents,
  eligibility: (context) => …,
}
```

The rules are **pure functions over a context**, which is why they are tested
without a database, a request or a cart (`tests/unit/payments.methods.test.ts`).
The context — subtotal, destination, customer, whether anything ships, how many
unpaid COD orders this person already holds — is assembled in
`checkout.service.ts`, so the rules stay honest about what they depend on.

`manual` is in the registry but `selectableAtCheckout: false`. It is how staff
record money that arrived some other way; offering it on the storefront would be
a "mark my own order paid" button.

---

## 3. The cash-on-delivery flow

```
customer places order          status: pending    payment: pending   stock: held
        ↓
shop accepts it                status: confirmed  payment: pending   stock: committed
        ↓
shipment created and shipped   fulfilment: fulfilled
        ↓
courier delivers               fulfilment: delivered
        ↓
courier returns with the cash  payment: paid
```

Two things are worth stating because they surprise people:

**Accepting is not being paid.** `POST /admin/orders/:id/confirm` commits the
stock and records the purchase, with no payment involved. For COD that *is* the
decision to ship.

**A delivered COD order is still unpaid** until somebody records the collection.
`POST /admin/orders/:id/payments` with an empty body does that — the order
already knows it is COD, and repeating it is a chance to record it wrongly.

---

## 4. Abuse control

COD's failure mode is the refused delivery: goods that travelled, were never
paid for, and have to come back. Five levers, all store settings, all changeable
without a deploy:

| Setting | Guards against |
| --- | --- |
| `codMinSubtotalCents` | orders too small to be worth handling |
| `codMaxSubtotalCents` | one refusal costing more than a week of margin |
| `codCountryCodes` | regions where refusal rates are unacceptable |
| `codRequiresAccount` | throwaway guest orders |
| `codMaxOpenOrders` | one person stacking up unpaid orders |

The cap is per customer, so a guest is never over it — which is exactly why
`codRequiresAccount` is a separate lever rather than implied.

None of these thresholds is exposed on the storefront. `GET /storefront/settings`
publishes only `codEnabled`; publishing the ceiling would be publishing what to
stay under.

---

## 5. Two sweeps, and why they differ

`order.expire_unpaid` runs hourly with **two** predicates:

- **prepaid, still unpaid after 48h** — an abandoned checkout, cancelled
- **COD, still unaccepted after 168h** — nobody ever confirmed it, cancelled

Judging COD on payment rather than acceptance would cancel every COD order the
shop had within two days. That is the single most expensive mistake available in
this feature, so the predicate excludes COD explicitly *and* the partial index
it reads (`orders_expiring_unpaid_idx`) does too.

**The invariant to preserve:** an order's stock hold must outlive every sweep
that could cancel it. `orderReservationHours` defaults to 192, above the 168h
COD window. Lengthening the COD window without lengthening the hold leaves
orders alive with no stock behind them.

---

## 6. Adding a second method

Turning on `card` is not a flag. In order:

1. **Registry** — set `enabled` and `selectableAtCheckout`, and decide the fee
   and eligibility rules. Add the key to `selectablePaymentMethod` in
   `orders.validators.ts`, which is the allowlist a customer may name.
2. **Authorisation** — a `before_delivery` method needs a gateway call at
   checkout. The order is placed `pending`; the money lands later.
3. **Webhook** — `POST /api/v1/webhooks/payments/:provider` already verifies a
   signature over the raw bytes and deduplicates on
   `(provider, provider_event_id)`. Today it records and stops. A real gateway
   needs a handler that turns a `payment_intent.succeeded` into
   `fulfillmentService.recordPayment`, which confirms the order and commits its
   stock.
4. **Refunds** — `paymentsService.refund` guards the amount with a conditional
   `UPDATE`; the gateway call goes beside it, and the provider's refund id into
   `refunds`.
5. **Set `PAYMENT_WEBHOOK_SECRET`.** Unset, the webhook endpoint refuses
   everything — which is the correct failure mode, but it does mean nothing
   works until it is set.

What you should *not* need to touch: checkout, the expiry sweep, the admin
console's order view, or the notification and email subscribers. If you find
yourself editing those, the settlement model is probably doing less work than it
should.
