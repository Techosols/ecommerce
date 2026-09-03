# Connecting a courier

What was built, what it does with no courier connected, and exactly what has
to be written to connect TCS, Leopards, M&P or anyone else.

It describes the code as it is today. Where something is a seam waiting for an
implementation rather than a working integration, it says so plainly.

---

## The short version

There is now a **courier seam**: one interface, one place that decides which
courier is active, and four capabilities a courier may declare. Four things in
the shop are wired to it — live rates, booking, tracking, and cash-on-delivery
reconciliation — and every one of them works without a courier as well as with
one.

**No courier is connected today.** The shipped default is the `manual`
provider, which declares every capability false, and the shop behaves exactly
as it did before: staff price delivery from the rate card, book the parcel on
the courier's own website, and paste the tracking number into the shipment
form. Nothing regressed and nothing is pretending.

Connecting a real courier is **one new file** plus credentials. Nothing in
shipping, orders or the storefront changes.

---

## What was built

### The seam

| File | What it is |
| --- | --- |
| `server/src/infrastructure/carriers/provider.ts` | The `CarrierProvider` interface, its request/response types, and the rules a provider must obey |
| `server/src/infrastructure/carriers/index.ts` | `getCarrier()`, the provider registry, and the startup honesty check |
| `server/src/infrastructure/carriers/providers/manual.ts` | No courier connected — the honest default |
| `server/src/features/shipping/carrier.service.ts` | What the *shop* does with a courier's answers, including when there is no answer |

`CARRIER_PROVIDER` in the environment selects the provider. It currently
accepts only `manual`.

### The four capabilities

A provider declares what it can do, and the shop shows exactly those controls.
A provider that declares a capability it has not implemented is **refused at
startup**, not at the moment a parcel is waiting to go out.

| Capability | What it turns on |
| --- | --- |
| `quotes` | The courier prices each parcel at checkout |
| `booking` | Creating a shipment books a consignment and returns a tracking number |
| `tracking` | Scans arrive by poll and/or webhook, and move the shipment on |
| `remittance` | Cash-on-delivery statements can be imported and reconciled |

### What each one does in the shop

**Live rates.** `shippingService.quote()` asks the courier and takes the
**cheaper of the two** per method. The list a shopper sees is still the shop's
— its names, its zones, its ids — because the method id is what checkout sends
back. The courier changes what a method *costs*, never what is on the menu. A
free method stays free: the shop meant it.

The courier gets 2.5 seconds. If it is slow, down, refuses, or does not serve
the address, the shopper is quoted the shop's own rates and never learns a
courier was involved. **A sale never depends on somebody else's server.**

**Booking.** `fulfillmentService.createShipment()` books with the courier
**before** the shipment row is created, so a refused booking leaves nothing
behind — no shipment, no decremented line, and the operator is told. The parcel
weight and value come from the shipped lines only, so a partial shipment is a
smaller box. The cash-on-delivery amount is set only when the order is COD and
not already paid.

**Tracking.** Two paths, one destination:

- `shipping.poll_tracking` runs every fifteen minutes and asks about every
  parcel still moving. Delivered, returned and failed parcels are excluded, so
  the cost is proportional to open shipments, not to the shop's history.
- `POST /api/v1/webhooks/carriers/:provider` accepts pushed callbacks.

Both call the same `applyTracking()`, so a scan recorded either way produces
the same state and the same emails. A uniqueness constraint on the events table
means a parcel seen twice is recorded once — polling re-reads whole histories
and every courier redelivers webhooks.

The **latest scan by the courier's clock** wins, not the furthest along. Parcels
go backwards: a failed delivery attempt after "out for delivery" is a real
thing, and a shop that only moved forwards would show "delivered" for a parcel
sitting at a depot.

**COD reconciliation.** A statement is imported, matched to orders by tracking
number, and each line comes out as one of three findings:

| Finding | Meaning |
| --- | --- |
| **Matched** | The line names an order of ours and the amount agrees |
| **Disagrees** | It names one of ours and the amount does not |
| **Unmatched** | No parcel of ours has that tracking number |

The middle one is why this exists. Importing **marks nothing paid** — settling
is a separate act, one line at a time, behind a confirmation that says it will
confirm the order and commit its stock. **A mismatched line cannot be settled
at all**: somebody has to decide who is right and record the payment on the
order itself, with their own name against it.

---

## Where an operator sees it

| Screen | What it shows |
| --- | --- |
| **Shipping** → Courier card | Which courier is connected and which of the four capabilities it has, present and absent alike |
| **Orders** → a shipment → *Courier scans* | The full scan trail: the mapped status, the courier's own words, the location, and the courier's raw code |
| **Payments** → Cash on delivery | Statements, their findings, and per-line settlement |

The tracking expander only appears where a courier reports scans, and the
import button only where a courier produces statements. A shop on `manual` is
never offered a control that could not work.

---

## Connecting a real courier

### 1. Write the provider

Create `server/src/infrastructure/carriers/providers/<name>.ts` implementing
`CarrierProvider`. Only implement the methods for capabilities the courier
genuinely has.

```ts
export class TcsCarrierProvider implements CarrierProvider {
  readonly name = 'tcs'
  readonly label = 'TCS'
  readonly capabilities: CarrierCapabilities = {
    quotes: true,      // only if it really prices over an API
    booking: true,
    tracking: true,
    remittance: true,
  }

  async quote(request: CarrierQuoteRequest): Promise<CarrierQuote[]> { … }
  async book(request: CarrierBookingRequest): Promise<CarrierBooking> { … }
  async track(trackingNumber: string): Promise<CarrierTrackingUpdate> { … }
  parseWebhook(raw: Buffer, headers): CarrierTrackingUpdate | null { … }
  async parseRemittance(file: Buffer, filename: string) { … }
}
```

Three rules the interface documents and the code depends on:

- **Never decide what the customer pays.** A quote is an input to the shop's
  pricing, not the price.
- **Never move an order's status.** Report what the courier said; the shipping
  service owns the transition.
- **Never throw for an ordinary refusal.** A courier that cannot serve an
  address returns *no quotes* — that is an answer. Exceptions are for the
  courier being unreachable or refusing the credentials.

### 2. Map the courier's statuses

Each courier's vocabulary is translated at the edge into the shop's seven:
`pending`, `processing`, `shipped`, `in_transit`, `delivered`, `returned`,
`failed`. Keep the courier's raw code in `rawStatus` — it is the only thing
that makes a mis-mapping diagnosable six weeks later, when the only evidence is
that an order sat in the wrong state.

### 3. Register it

In `carriers/index.ts`, add the case to `build()` and the name to
`CARRIER_PROVIDERS`; in `config/env.ts`, add the name to the `CARRIER_PROVIDER`
enum and add the courier's credentials to the schema.

### 4. Verify the webhook signature — in `parseWebhook`

**`parseWebhook` is the authentication for the webhook route, and there is no
other.** Couriers sign differently, so the route cannot verify on a provider's
behalf: it hands over the exact bytes received and treats a throw as a refusal.

Compute the signature over the **raw buffer**, never over re-serialised JSON —
that verifies nothing — and compare with `timingSafeEqual`, not `===`.
`tests/fakes/carrier.ts` does exactly this and is worth copying.

A provider without `parseWebhook` never reaches the route at all, and a
callback naming a courier this shop is not configured with is refused with a
404.

### 5. Give the courier the callback URL

```
POST https://<your-api>/api/v1/webhooks/carriers/<provider-name>
```

The provider name in the path must match `CARRIER_PROVIDER`.

### 6. Test it

`server/tests/integration/shipping.carrier.test.ts` covers the seam through the
real app with a fake courier — 26 tests over booking, tracking, rates and
reconciliation, including the failure modes. A new provider needs its own unit
tests for the translation: its quote shape, its status mapping, its signature
check, its statement parser.

---

## What is deliberately not built

**No real courier integration.** TCS, Leopards and M&P each need credentials,
their API documentation, and a sandbox account — none of which the code can
invent. The seam is what makes each one a day's work instead of a fortnight's.

**No `simulated` provider in the build.** A courier that invents tracking
numbers and confirms deliveries that never happened is not something a shop
should be one environment variable away from running. The fake lives in
`tests/fakes/carrier.ts` and cannot be configured in production.

**No "settle everything" button.** Every settlement confirms an order and
commits its stock. The server accepts one line per request, on purpose.

**No courier dropdown in the admin.** Choosing a courier needs credentials, a
registered callback URL and a restart. A dropdown would suggest an operator
could switch over lunch, and the first person to try it would take booking
offline.

---

## Operational notes

**Migration `0032_carrier_integration.sql`** must be applied. It adds
`shipment_tracking_events`, `cod_remittances`, `cod_remittance_lines`, and two
columns on `shipments`.

**The worker must be running** for tracking polls — it owns every job. That is
`npm run dev:worker` in development, `npm run start:worker` in production, and
it is a *separate process* from the API.

**Statements are uploaded as base64 in JSON**, capped at 2MB, because the API
accepts multipart nowhere and a courier statement is a few kilobytes of CSV.

**Permissions** reuse what already exists — no new permission rows. Reading
statements needs `payments:read`; importing and settling need
`payments:capture`; the courier capability card needs `shipping:read`.
