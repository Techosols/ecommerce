# The admin, feature by feature

A working manual for the people who run the shop. Every screen, what each
control does, what the server will refuse and why, and the handful of rules
that explain most of the surprises.

It describes the admin as it is today. Where something is not built, or is
built differently from how it looks, it says so plainly rather than leaving
you to find out.

---

## Contents

**Before you start**
[Signing in](#signing-in) · [Roles and what each can do](#roles-and-what-each-can-do) · [Six rules that explain most of the admin](#six-rules-that-explain-most-of-the-admin)

**Overview** — [Dashboard](#dashboard)

**Sell** — [Orders](#orders) · [Draft orders](#draft-orders) · [Returns](#returns) · [Checkout](#checkout) · [Shipping](#shipping) · [Payments](#payments) · [Customers](#customers) · [Segments](#segments)

**Catalogue** — [Products](#products) · [Categories](#categories) · [Collections](#collections) · [Inventory](#inventory) · [Locations](#locations)

**Grow** — [Discounts](#discounts) · [Analytics](#analytics)

**Store** — [Notifications](#notifications) · [Store settings](#store-settings) · [Staff](#staff) · [Audit trail](#audit-trail) · [Your account](#your-account)

**Reference** — [Status vocabularies](#status-vocabularies) · [Why was I refused?](#why-was-i-refused) · [Known gaps](#known-gaps)

---

# Before you start

## Signing in

Go to the admin and enter your **Email address** and **Password**. There is a
reveal toggle on the password field.

**If you are told your details are wrong**, that one message covers four
different situations: unknown email, wrong password, a disabled account and a
locked account all say the same thing. This is deliberate — telling a stranger
"that email exists but the password is wrong" hands them half the answer. It
does mean that if you are certain the password is right, you cannot diagnose
it yourself: ask an owner.

**Ten failed attempts within fifteen minutes locks the account** and signs it
out everywhere. There is no unlock button anywhere in the admin. The only way
back is the password reset link on the sign-in page, which sets the account
back to active as a side effect.

**If you were invited and have not used your link yet, you cannot sign in.**
An invited account has no password until the link is used, so there is nothing
to sign in with.

**Banners above the sign-in form** tell you why you are there:

- *"Your session ended. Sign in again to continue."*
- *"You have been signed out."*
- *"That account does not have access to the admin."* — a customer account. The
  storefront and the admin share a sign-in endpoint; the admin checks
  afterwards that you are staff and signs you straight back out if not.

### Sessions

Your session lasts **30 days**, and the short-lived token behind it is renewed
about every fifteen minutes without you noticing. Reloading the page shows
*"Restoring your session…"* for a moment while that happens.

Being signed out unexpectedly usually means one of four things:

1. An owner disabled your account (immediate).
2. You changed your password somewhere else (every other browser is signed out).
3. You completed a password reset (every browser, including this one).
4. Ten failed sign-ins in fifteen minutes.

There is a fifth, rarer cause: if the same session is renewed twice at once —
two tabs waking from sleep together, say — the system treats the second use as
possible theft and revokes the whole chain. You are asked to sign in again.
This is a safety net working, not a fault.

**A role change reaches you within about thirty seconds**, not at your next
sign-in. Your permissions are re-read from the database on every request
rather than trusted from your token. This is why the Roles dialog says "Takes
effect on their next request".

---

## Roles and what each can do

There are four roles. **Roles add up and nothing subtracts** — giving somebody
both Staff and Admin gives them the union of the two. There is no way to take
one permission away from a role short of a code change and a deploy.

| | Owner | Admin | Staff | Customer |
|---|:--:|:--:|:--:|:--:|
| **Orders** — view, edit, cancel | ✓ | ✓ | ✓ | — |
| **Returns** — approve, receive, close | ✓ | ✓ | ✓ | — |
| **Shipping** — zones, methods, shipments | ✓ | ✓ | ✓ | — |
| **Inventory** — view, adjust, transfer | ✓ | ✓ | ✓ | — |
| Inventory — locations and tracking policy | ✓ | ✓ | — | — |
| **Customers** — view | ✓ | ✓ | ✓ | — |
| Customers — edit, disable, merge | ✓ | ✓ | — | — |
| **Catalogue** — view | ✓ | ✓ | ✓ | — |
| Catalogue — create and edit | ✓ | ✓ | — | — |
| Catalogue — publish and archive | ✓ | ✓ | — | — |
| **Payments** — view | ✓ | ✓ | ✓ | — |
| Payments — record and refund | ✓ | ✓ | — | — |
| **Discounts** | ✓ | ✓ | — | — |
| **Analytics and the dashboard's figures** | ✓ | ✓ | — | — |
| **Store settings** | ✓ | ✓ | — | — |
| **Staff accounts** | ✓ | — | — | — |
| **Granting roles** | ✓ | — | — | — |
| **Audit trail** | ✓ | — | — | — |

**The four owner-only capabilities are the sharpest edge in the product.** An
Admin runs the entire shop — catalogue, refunds, settings, discounts — but
cannot add a colleague, cannot change anyone's roles, and cannot read the
audit trail. If an Admin asks you why they cannot see the Staff tab, that is
the answer.

A **Customer** role carries no admin permissions at all. Customers never appear
in the Staff list and cannot reach the admin.

**Menu entries you cannot use are not shown.** A Staff member simply has no
Discounts or Analytics entry in the sidebar. This is a courtesy, not a
security measure — the server checks every request regardless of what your
browser drew, so hiding a button is never what stops anything.

---

## Six rules that explain most of the admin

If you read nothing else, read these. Most "why did it do that" questions in
this admin are one of the six.

### 1. The server decides; the screen displays

No figure on any screen is worked out in your browser. Order totals, what is
still refundable, what a discount takes off, whether a draft can be placed,
how much stock is available — all of it is computed on the server and
rendered here. When a screen and your own arithmetic disagree, the screen is
showing you what the shop will actually do.

This is why, for instance, **Record payment has no amount box**: it records
exactly the outstanding balance, taken from the order.

### 2. Archive, never delete

Almost nothing in this admin can be deleted. Products, variants, categories,
collections, discounts, shipping methods, staff accounts, locations — all are
*archived*, which removes them from use while leaving them intact.

The reason is that past orders point at them. An order shipped by "Standard
delivery" has to keep meaning something after you stop offering Standard
delivery. The exceptions — things that genuinely can be deleted — are
timeline notes, customer segments, and a draft order that was never placed.

### 3. Order lines are snapshots

When somebody buys, the title, SKU, options and price are copied onto the
order. Renaming or repricing the product afterwards does not change what that
order says, and the admin will never "correct" it. That is what was bought, at
the price it was bought at.

The same applies to a discount code an order used, and the shipping method it
was shipped by.

### 4. Money is entered in pounds and stored in pennies

You type £12.99; the system stores 1299. You will occasionally see minor units
surface where it matters — the rule builders say so explicitly ("In minor
units — 5000 is £50") because a rule is closer to the data than a form is.

Tax is stored the same way: 8.75% is 875 basis points, so two decimal places
are exact.

### 5. Filters live in the web address

On almost every list, what you have searched and filtered is in the URL. That
means a filtered view can be bookmarked, sent to a colleague, and reached
again with the Back button. Changing a filter always returns you to page one.

### 6. Stock is a ledger, not a number you type over

You never set a stock level. You record a movement — a delivery, a count, a
breakage — and the level follows from it. Nothing in the history can be
edited; a mistake is corrected with another movement. This is why every stock
change asks you for a reason.

---

# Dashboard

**Who can see it:** everyone who can sign in. The trading figures need
`analytics:read`, which Staff do not hold — they see the queues and an
explanatory note instead.

## How to use the Dashboard

It answers two questions that are deliberately kept apart: *what needs me
right now*, and *how has the shop been trading*.

### Needs attention

Four tiles, each a link into the relevant screen. Every count is computed by
the server in a single query.

| Tile | Counts |
|---|---|
| **Awaiting payment** | Placed, not cancelled or completed, still unpaid |
| **To fulfil** | Confirmed or processing, nothing shipped yet |
| **Low stock** | Tracked items at or under their threshold, but not yet at zero |
| **Out of stock** | Tracked items with nothing available |

**Out of stock turns red above zero.** The others never do — a queue with
things in it is a normal morning, and colouring it red teaches people to
ignore the one that matters.

A tile showing an em dash (—) means the figure could not be loaded, not that
it is zero.

> **Low stock counts locations, not products.** An item low at two locations
> counts twice. If the tile and the Inventory list seem to disagree, this is
> usually why.

### Today

Four live figures, counted from the orders themselves, for **the store's own
today** in the timezone set in Store settings — not your browser's.

- **Net sales** — subtotal, less discounts, less refunds. **Tax and delivery
  are excluded.** Refunds are subtracted from the day of the *original order*,
  not the day you issued the refund.
- **Orders** — placed today, excluding cancelled and drafts. Cancellations are
  noted underneath when there are any.
- **Average order** — based on the order **total**, which *does* include tax
  and delivery. It is therefore not "average net sales", and dividing one card
  by another will not reconcile.
- **New customers** — an order counts as new when it is that customer's first.
  Somebody who registered a year ago and bought today is new. Guest orders
  count as neither new nor returning.

### Net sales, last 30 days — and why it does not add up to Today

The trend, the four figures beneath it and the Top products table all come
from a nightly rollup. **There is no row for today until tonight's job runs**,
so this window deliberately ends *yesterday*, and the card says so.

You cannot add the 30-day card to the Today card. They are two different
counts of two different periods, and the dashboard shows them apart rather
than presenting one misleading total.

The sparkline needs at least two rolled-up days before it will draw.

### Top products

The five best sellers by net sales over the same rolled-up window. It is **per
variant**, so a product sold in three sizes can appear three times. A
part-refunded order reduces that product's figure by the refunded units
rather than zeroing the line.

### Refresh, and live updates

The **Refresh** button appears only if you can see the trading figures. The
dashboard also refreshes itself when an order is placed or cancelled, a
payment lands or is refunded, or stock goes low, out or back in.

It re-asks the server rather than adjusting the numbers in your browser. An
arriving order does not simply increment "Orders" — the browser has no way to
know whether that order counted, or was cancelled a second later, or belongs
to a different day in the store's timezone.

---

# Orders

**Who can see it:** `orders:read` — Owner, Admin, Staff.

## How to use Orders

### Finding an order

The list is newest first and every filter runs on the server, across all
orders, not just the page you are looking at.

- **Search** matches the order number or the customer's email.
- **Three status filters**, because there are three status machines and they
  move independently: *order status*, *payment status* and *fulfilment
  status*. "Paid but not shipped" and "shipped but not paid" are different
  mornings' work, and the admin never collapses them into one word.
- **Tags** can only be *removed* here. A tag filter arrives from a link; the
  chips at the top of the list let you drop them one at a time.

There is **no sort control** — the list is always newest first, because the
server accepts no sort parameter.

The **Total** column shows a red `−£x.xx refunded` line beneath the total when
anything has come back. On a cancelled order the fulfilment column shows a
dash rather than a badge, because fulfilment is no longer a meaningful
question.

### Moving an order along

Open an order and use the **Status** card. Only the moves that are legal right
now are offered:

| The order is | You can |
|---|---|
| Pending | **Confirm order**, or **Cancel order** |
| Confirmed | **Start processing**, or **Cancel order** |
| Processing | **Mark completed**, or **Cancel order** |
| Completed | nothing — it is finished |
| Cancelled | nothing — cancellation is permanent |

**Confirming is what commits the stock.** Until an order is confirmed, its
stock is only *held*; confirming takes it off the shelf properly. This is what
makes an unpaid order safe to release automatically.

Confirming twice does nothing the second time. That is deliberate:
confirmation can arrive from three directions — a payment landing, a staff
member accepting a cash-on-delivery order, or this button — and re-recording
it would inflate the customer's lifetime spend.

**You cannot set payment or fulfilment status by hand.** Fulfilment follows
from shipments; payment follows from payments and refunds. There is no button
for either, on purpose.

### Cancelling

**Cancel order** needs `orders:cancel` (Staff have it). The dialog says what
will happen:

> Reserved stock goes back on the shelf and the customer is told. Nothing is
> deleted — the order stays as a record, and it cannot be un-cancelled.

Two refusals to expect:

- **A shipped order cannot be cancelled.** The server says so: *"A shipped
  order cannot be cancelled — refund and return it instead."*
- A completed order offers no Cancel button at all.

Stock is returned by default, and units already returned by a refund are
skipped so nothing is restocked twice. If the order was still unpaid, its
payment status moves to cancelled too.

### Taking payment

The **Payments** card needs `payments:read` to see and `payments:capture` to
use — Staff can see it, only Admins and Owners can act on it.

**Record payment** appears only when something is outstanding. It has no
amount field: it records exactly the outstanding balance, computed by the
server. When the balance reaches zero the order is marked paid, and if it was
still pending it is confirmed automatically.

"Outstanding" is measured **net of refunds on both sides**, so refunding half
a paid order does not re-open a balance to chase.

### Refunding

**Refund** needs `payments:refund`. The dialog offers two ways to decide the
amount, and they are linked:

1. **Choose quantities per line.** The amount is worked out for you. Per-unit
   is the line total divided by quantity — what the customer actually paid
   after discount and tax, not the list price.
2. **Type an amount.** This overrides the calculated figure. Changing any
   quantity afterwards clears your override.

Also on the dialog:

- **Refund shipping** — only offered when there was a delivery charge. Whether
  postage comes back is your shop's policy, so it is asked rather than assumed.
- **Reason** — recorded on the refund and shown in the timeline.
- **Refund against** — only appears when the order has more than one payment.
- **Put these units back on the shelf** — **off by default, and leave it off
  unless the goods are back and can be sold again.** Refunding a damaged item
  and putting it back on the shelf is a bad afternoon.

Three separate limits apply, and the maximums in the dialog come from the
server:

- a payment cannot be refunded beyond what it took;
- a line cannot be refunded beyond the units ordered;
- an order cannot be refunded beyond its own total.

Ticking restock without choosing quantities is refused — the server needs to
know *which* units are coming back.

> **Refunds are money leaving.** They are protected against double submission
> in two independent ways, but they cannot be undone from the admin.

### Shipping what is on the order

The **Shipments** card needs `shipping:read` to see, `shipping:write` to use.
**Fulfil everything left** creates one shipment covering everything not yet
shipped and not refunded. Digital lines are skipped.

**Carrier and tracking cannot be entered from this screen.** The shipment is
created with its items only.

Fulfilment status follows from what has actually gone out. An order that is
fully shipped *and* fully paid moves itself to completed. A shipment marked
delivered only moves the order to delivered if everything has shipped — two
parcels with one delivered is not a delivered order.

### Notes: there are two kinds, and they are different

- The **Note** on the *Notes and tags* card is one pinned instruction, meant to
  be overwritten as it changes. *"Leave with the neighbour at number 12."*
- The **timeline notes** are a running record. They can be added and deleted
  but **never edited** — a record that can be rewritten is not evidence.

Both are staff-only; the customer never sees either. The customer's own note,
if they left one, appears separately on the Customer card.

**Tags** are for finding the order again later. They are de-duplicated
case-insensitively, keeping the first spelling typed. Up to 50, 40 characters
each.

### The timeline

Assembled at read time from the status history, notes, payments, refunds and
shipments — there is no separate feed that could drift from the records it
describes. Newest first.

Entries by "system" are the automatic jobs, most often the unpaid-order sweep.

### Two things that happen without you

**Unpaid orders cancel themselves.** A prepaid order still unpaid after the
window in Store settings is cancelled with the reason *"Unpaid after the
payment window"*.

**Cash-on-delivery orders are judged differently** — they are unpaid by
design. A COD order is cancelled only if it is still *pending* after a much
longer acceptance window, with the reason *"Not accepted within the
acceptance window"*. A confirmed COD order is never touched.

---

# Draft orders

**Who can see it:** `orders:read`. **Who can build one:** `orders:write` —
Staff included.

## How to use Draft orders

A draft is an order you build by hand — a phone order, a quote, a sale made in
person. Three things about it are worth knowing before you start:

- **It holds no stock.** Nothing is reserved while you build. The shelf is
  untouched until you place it.
- **It is not a sale.** A draft never appears in the order list, in revenue, in
  a customer's lifetime spend, or in the "awaiting payment" queue.
- **It burns no order number.** The `DRAFT-XXXXXX` reference is a placeholder.
  A real number is assigned at placement, so quotes nobody placed do not leave
  gaps in your order numbering.

### Building one

Press **New draft**. You are taken straight into the builder with an empty
draft.

**Add the products.** Press **Add a product**, search by name or SKU, and pick.
Only active, unarchived products can be sold, so that is all the search
returns. Picking something already on the draft increases its quantity rather
than adding a second row. Use the − and + steppers, or the bin, to adjust.

**Fill in the customer and delivery.** Email is required — it is where the
confirmation goes. The address needs at least an address line, a city and a
two-letter country code before it is saved; a half-typed address is held back
rather than being rejected. Press **Save details** when you have finished
typing. Saving re-prices the draft against that address.

**Choose delivery and payment** in the summary card on the right. The delivery
options are the real rated options for the address you entered; if there are
none, the card tells you the address needs checking. Payment offers **Recorded
by staff**, which shoppers can never choose — it is the honest name for "the
customer paid us somehow".

**Apply a discount code** if there is one. It is stored as something to check
later, not as a fact: checkout validates it afresh when the draft is placed.

### Placing it

The **Place the order** button is disabled until the draft is complete. What is
missing is listed in the *Not ready yet* panel above it, in the server's own
words and in the order you would fix them:

- Add at least one product.
- Add an email address to send the order to.
- Add a delivery address.
- Some lines cannot be bought — *(and which, and why)*
- Choose a delivery option.
- Nothing can be delivered to that address. Check it, or add a shipping zone.

Placing runs the ordinary checkout over the draft's lines. That means the
prices are resolved **again** inside the transaction, so a line that sold out
while your quote was on screen fails the placement rather than overselling.
The result is a real order with a real number, marked as placed via Admin.

**Staff are not exempt from the shop's money rules.** You are offered the
"Recorded by staff" method that customers cannot pick, but an order over the
cash-on-delivery ceiling is refused for you exactly as it would be for a
customer.

### Afterwards

The draft stays, permanently read-only, pointing at the order it became. It is
the record of what was quoted and by whom. **Discard** is offered only before
placement, and it is final — the quote and its lines are gone.

> **The Items figure in the draft list is the lines as of your last edit, not a
> live quote.** Re-pricing twenty rows against the catalogue to draw a list
> would be a lot of work for a figure nobody acts on. Opening the draft
> re-prices it, and that figure is the one that governs.

---

# Returns

**Who can see it:** `returns:read`. **Who can work them:** `returns:write` —
Staff included. **Refunding additionally needs** `payments:refund`, which
Staff do not hold.

> **There is no way to open a return from the admin.** Returns are opened by
> the customer on the storefront. This queue works the ones that exist.

## How to use Returns

### The lifecycle

```
Requested → Approved → On its way → Received → Closed
     ↘ Declined                          ↘ (or refunded, which closes it)
     ↘ Cancelled
```

**Declined** and **Cancelled** are the two exits before the goods move.
**Closed**, **Declined** and **Cancelled** are all final — this is what stops a
closed return being reopened and refunded a second time.

### Working one

Open a return and use the **Progress** card. Only the legal next moves are
offered:

- **Requested** → *Approve* or *Decline*
- **Approved** → *Mark on its way*
- **Requested / Approved / On its way** → *Cancel return*
- **Received** → *Close without refunding*, or refund it

**Declining or cancelling releases the units**, so the customer can open a
fresh request for the same items. Receiving does not.

### Recording what arrived

Once a return is approved or on its way, the Items card becomes a form. For
each line, enter the quantity that actually arrived and pick its condition:

- **Resellable — goes back on the shelf**
- **Damaged — written off**
- **Opened — written off**
- **Missing parts — written off**

Only resellable units re-enter stock, as an explicit movement noted against
the return number. You cannot enter a restock quantity separately; the server
works it out from the condition, which is the point.

> **Any line you do not fill in is recorded as arriving at zero, condition
> "missing parts".** If a line arrived, say so — silence is treated as absence.

### Refunding a return

The **Refund** card appears only when the return has been received, has not
already been refunded, and you hold both `returns:write` and `payments:refund`.

> *"Only the units recorded as arrived are refunded, and they are not restocked
> again — that happened when they were received."*

Refunding closes the return in the same operation.

The two-permission requirement is deliberate: somebody who can receive a parcel
should not be able to issue a refund by pressing a different button on the same
page.

### Refusals you may meet

- *"Only a received return can be refunded — record what arrived first."*
- *"This return has already been refunded."*
- *"Nothing arrived on this return, so there is nothing to refund."*
- *"Somebody else moved this return; reload and try again."* — two people
  working the same return at once. One move wins.

---

# Checkout

**Who can see it:** `orders:read`. Two tabs: **Baskets** and **Attempts**.

## How to use Baskets

Baskets people filled and did not buy.

**The default filter is "Left behind"**, not "any" — that is the question this
screen exists to answer. Clearing the filters returns you to it.

The two figures at the top — **Left behind** and **Worth** — are computed over
the whole abandoned pile by the server and **do not change** when you search or
page. They are the size of the problem, not the size of your current view.

> **A basket holds no money and reserves no stock.** It stores what was chosen,
> never what it cost. "Worth now" is those items at *today's* prices, so the
> column moves when your catalogue moves. Stock is reserved at checkout, not
> when somebody adds to a basket.

> **The list's "Worth now" and the basket's own "Worth now" can differ.** The
> list values every item; the opened basket values only the lines that can
> still be bought. A basket full of sold-out items shows a figure in the list
> and a smaller one when you open it.

Empty baskets are never listed — one is created by anybody who so much as looks
at the shop.

### Emailing a shopper back

Open a basket and press **Email them a link back**. It needs `customers:write`
— contacting a customer is a customer permission, not an orders one — and it
appears only when there is somebody to email.

Three outcomes:

- **Recovery email queued** — sent.
- **Not sent** — shown as information, not an error. Almost always because the
  customer has opted out of marketing email. That is a reasonable question with
  a reasonable answer, not a failure.
- **Could not send it** — an actual error.

The button relabels to **Send again** afterwards. Pressing it twice sends two
emails; there is no cooling-off period on the manual send, unlike the automatic
one which goes once per basket ever.

**Nothing on this screen edits a basket.** Editing somebody's shopping behind
their back is not something a shop should be able to do, and the server
publishes no endpoint that would allow it.

## How to use Attempts

Every checkout the shop was asked for and what came of it.

> **Read this before trusting the numbers: the three cards and the reasons
> chart cover the last seven days. The table below them is all time.** Clicking
> a reason bar filters the all-time table by a code counted over seven days, so
> a reason showing 12 can produce 40 rows.

**Got through** is placed ÷ (placed + failed) — a success rate over *attempts*,
not over visitors. With no attempts at all it shows an em dash, because 0 of 0
is not 0%.

**What stopped them** groups failures by the server's error code, never by the
message, because messages get reworded for shoppers. Click any reason to filter
the table to it.

**Only "Something went wrong on our side" is red.** Everything else — a
declined code, an out-of-stock line, an address nobody ships to — is the shop
working as designed. Colouring those as errors trains people to ignore the one
that is not.

> **This is a log, not a session.** Checkout is a single request that either
> produces an order or refuses. There is no "resume this checkout" button
> because there is no checkout to resume.

---

# Shipping

**Who can see it:** `shipping:read`. **Who can change it:** `shipping:write` —
Staff included.

## How to use Shipping

Delivery is defined in two layers. A **zone** is a set of countries that share
a rate card. A **method** inside it is one option a shopper is offered.

> **Until a zone exists with a method in it, the shop cannot quote delivery to
> anybody, and checkout refuses every order that needs shipping.**

### Creating a zone

**New zone** → give it a **Name** (for you; shoppers never see it) and its
**Countries** as two-letter codes.

**A country may be in only one live zone.** If it is already covered, the
server refuses and names the zone that has it — a shopper in two zones would
be quoted two rate cards at once.

Archived zones and zones with **Quoting** switched off are excluded from that
check, so turning a zone off frees its countries for another one. That also
means **switching a zone back on can be refused** if its countries were claimed
while it was away.

### Adding a method

**Add a method** on a zone. The important part is the two fieldsets:

**What it costs** — *Charged as* offers **One price, whatever it weighs**,
**Free**, or **A price per kilogram**. Then a price, and optionally a **Free
over** threshold.

**When it is offered** — a **Parcel weight** band in kilograms, either end
optional.

Three rules trip people up:

1. **A weight band is not a price — it decides whether the method is offered at
   all.** A 3 kg parcel against a 0–2 kg band does not ship free; it does not
   see that method. If nothing else covers that weight, the shopper is told you
   do not deliver to them.
2. **"Free over" beats everything, including per-kilogram.** "Free delivery over
   £50" is true whatever the rate type.
3. **Per-kilogram rounds up, per started kilogram.** 1.2 kg costs two. A basket
   with no recorded weight costs one, not nothing.

You type kilograms; the system stores grams.

### Checking your work

The **What a shopper sees** panel on the right calls the *real* storefront
endpoint — the same one checkout uses. It cannot drift from what customers get.
Enter a country, a basket total and a weight, and it shows the actual quote.

It is the only place the rules can be seen interacting: a band withdrawing a
method, a threshold beating a per-kilogram price, a country in no zone. Change
a rate and re-check it immediately; it refreshes on its own.

### Archiving

**Archiving a zone** stops it quoting. Its methods are kept, because orders
shipped by them still name them.

> **In practice, archiving a zone is one-way from this screen.** The dialog says
> a zone can be restored and the server supports it, but there is no restore
> button on the archived zone card. See [Known gaps](#known-gaps).

**Removing a method** retires it — orders shipped by it keep naming it. There is
no un-archive for a method at all.

**"Not quoting" on a zone and "Off" on a method are different levers.** Turning
a zone off also releases its countries; turning a method off does not.

---

# Payments

**There is no Payments screen.** The sidebar entry leads to a page that says
"Not built yet". Payments are handled in two places instead:

- **Taking and returning money** — the *Payments* card on each order. See
  [Orders → Taking payment](#taking-payment) and
  [Orders → Refunding](#refunding).
- **The rules for cash on delivery** — [Store settings](#store-settings).

## What can be paid with today

| Method | Settles | Shoppers can choose it |
|---|---|---|
| **Cash on delivery** | On delivery | Yes, subject to the limits |
| **Recorded by staff** | Before delivery | **No** — staff only, on draft orders |
| Bank transfer | — | Declared but switched off |
| Card | — | Declared but switched off. Turning it on needs a gateway, not a flag |

"Recorded by staff" exists so that "the customer paid us somehow" has an honest
name in the payments table, rather than being mislabelled as a card capture.

---

# Customers

**Who can see it:** `customers:read` — Staff included.
**Who can change:** `customers:write` — Admin and Owner only.

## How to use Customers

### Finding somebody

**Search** matches name, email or phone. **More filters** opens a drawer whose
every filter runs on the server against the whole shop:

- **Account status** — active, disabled, locked
- **Email marketing** — the four consent states
- **Has ordered** / **Has never ordered**
- **Tax exempt**
- **Spent at least / at most**, **At least this many orders**
- **Has not ordered since** — finds customers who have gone quiet, **including
  those who never ordered at all**

Sort by newest, total spent, orders, last order, or name.

> **Only customers appear here.** Staff colleagues never do, even though they
> also have accounts.

### Guests are customers too

Anybody who completes checkout gets a customer record, whether or not they ever
registered. You do not have to do anything for this — it happens as the order is
placed, and it is why the list fills up with people who never signed up.

**How to tell them apart.** A record the shop created carries the **guest** tag,
and its timeline opens with *account created at checkout* rather than an
account the person opened themselves. Filter on the tag to see only guests, or
remove the tag from anyone you no longer think of that way — it is never
re-applied.

**They cannot log in.** No password is ever set for them; the record is the
shop's memory of a buyer, not an account made in their name. If they later want
one, they set a password through the ordinary forgotten-password flow, and their
earlier orders are already in their history.

**A second order from the same email joins the same record.** So does an order
somebody places without signing in to an account they already have — the order
lands in their real history rather than forking a duplicate person. This is
what makes *Total spent* and *Orders* mean what they say.

**Marketing consent is never set this way.** Typing an email to get a receipt is
not a subscription. Everyone created at checkout starts at *Not subscribed*.

> **One consequence worth knowing.** Because checkout now recognises people by
> email, a customer you have **disabled** can no longer place an order by simply
> not signing in. Their checkout is refused the same way it would be if they
> were logged in.

**Export** downloads the list as CSV *with the filters currently on screen*,
capped at 10,000 rows. Spend in the CSV is in minor units, unformatted.

### The consent states, and why there are four

| State | Means | May you email them marketing? |
|---|---|---|
| **Not subscribed** | Never asked, or asked and never answered | Not yet — but you may ask again |
| **Awaiting confirmation** | Asked, waiting for them to confirm | No |
| **Subscribed** | They agreed | Yes |
| **Unsubscribed** | They asked you to stop | **No, and do not ask again** |

"Not subscribed" and "Unsubscribed" are emphatically different things, which is
why Unsubscribed is shown in red rather than grey. Changing a consent state
takes effect immediately, with no save button, and is recorded on the customer's
timeline and in the audit trail.

### One customer

**Total spent** is the sum of order totals net of refunds, excluding cancelled
orders and drafts. It **includes tax and delivery**, so it will not match the
dashboard's net sales.

> These counters are kept up to date as orders are confirmed. They can drift
> after an import, a merge or a hand correction. **Recalculate** on the
> *Lifetime figures* card rebuilds them from the orders themselves;
> **Rebuild totals** on the list does it for everybody.

**Details** — names, phone, locale, a pinned note and the tax-exempt switch.
**The email address is the customer's identity and cannot be changed here.**

**Orders** shows the ten most recent, opening the real order rather than a copy.

**Tags** are free labels the list can filter on. They compare
case-insensitively, so retyping `VIP` over `vip` is not a change.

**Addresses** are read-only here. First address becomes the default; addresses
are archived rather than deleted; archiving a default promotes the next one.

**Timeline** is the running record — notes you add, plus what the shop did.
Notes can be deleted but never edited, and only notes can be deleted: a system
observation cannot be removed by guessing at it.

### Disabling an account

> They are signed out everywhere immediately and cannot order or sign in again.
> Their record, orders and history are untouched.

**Locked cannot be set by hand.** An account locks itself after ten failed
sign-ins and unlocks itself, or the customer resets their password.

### Merging duplicates

**Merge** folds a duplicate into the record you are looking at. Orders,
addresses, tags and timeline move across; the duplicate is deleted; the
survivor's lifetime figures are **recalculated from the orders** rather than
added up, because adding would double-count.

> **This cannot be undone.** The dialog says so, and it means it.

One thing to know afterwards: the Orders card on a customer searches by email
address, so orders that came from the merged-away email will not show there
even though they moved correctly.

---

# Segments

**Who can see it:** `customers:read`. **Who can change:** `customers:write`.

## How to use Segments

A segment is a saved question — "everyone who has spent over £500", "everyone
tagged wholesale" — that the customer list can be narrowed to.

> **A segment stores no members.** Its rules are checked against the shop every
> time it is read, so it is never out of date. Tag somebody and the count moves
> immediately.

### Building one

**New segment**, give it a name, then add conditions. Choose whether products
must match **all conditions** or **any condition**.

Each row is a field, an operator and a value. The fields on offer come from the
server, so you cannot build a rule the system would refuse. They include email,
names, phone, tags, total spent, number of orders, account status, marketing
state, tax exempt, email verified, and four dates including **Days since last
order**.

The **Preview** panel counts live and shows five example customers as you work.

Three behaviours worth knowing:

- **Changing the field resets the operator and the value.** Otherwise "Total
  spent contains vip" would sit there and be refused on save.
- **Incomplete rows are dropped silently** when you save, not flagged.
- **"Is not" matches customers with no value at all.** "Country is not France"
  includes people with no country recorded — which is what a person means, even
  though it is not what plain SQL would do.

**Money in rules is in minor units** — 5000 is £50 — and the hint says so.
**Days since last order** never matches somebody who has never ordered.

**Delete** removes only the saved rules. No customer is changed or removed.

---

# Products

**Who can see it:** `catalog:read` — Staff included.
**Who can create and edit:** `catalog:write`. **Who can publish or archive:**
`catalog:publish`. Both are Admin and Owner only.

## How to use Products

### The three states, and the two decisions

A product moves **Draft → Active → Archived**, and *separately* is **published**
or not.

- **Draft** — being worked on. Invisible to customers.
- **Active** — ready. Still invisible until published.
- **Archived** — withdrawn. Hidden everywhere and **cannot be edited at all**.

**Activating and publishing are two decisions on purpose.** Activating says the
product is finished; publishing says it is for sale. Restoring an archived
product returns it to *draft*, never straight back to sale — republishing is a
separate decision somebody has to make.

Activating needs at least one live variant. Publishing needs the product to be
active and to have something sellable.

### Creating a product

**New product** creates the product, its options and all its variants in one
go.

**Info** — Title (required), Subtitle, Description, Handle.

> **The handle is the product's address on the storefront.** Leave it blank and
> the server derives one from the title. It auto-follows the title while you
> type, and stops the moment you edit it by hand — silently rewriting a handle
> somebody chose would change a live URL.

**Organisation** — Category, Product type, Vendor, Tags.

**Pricing and variants** — leave the variations box unticked for a single price.
Tick it to name up to three options (Size, Colour, Material), give each its
values, and every combination appears as a row you can price.

Limits: **3 options, 100 variants, 50 values per option.** The form warns you
before you exceed them.

Images are not on this screen. Uploading needs a product to attach to, so you
add them on the edit page immediately afterwards.

### Editing a product

**Save changes** saves the copy, the price and the identifiers. Three things
are deliberately *outside* it, and take effect the moment you do them:

- lifecycle changes (activate, publish, archive)
- stock movements
- image changes

**Options** — the axes a product varies on. Adding a value **does not create
variants**; you add the combinations worth stocking in the Variants card below.
Each value chip shows how many live variants use it. Removing a value is
refused while anything uses it, including an archived variant, because an
archived variant keeps its combination forever.

**Variants** — the purchasable unit. Each carries its own price, SKU, weight,
image and stock. Archiving a variant is refused if it is the product's only
live one — archive the product instead.

**Images** — the first is the one customers see in listings. Drag to reorder,
or use *Make primary*. Uploads run one at a time and wait for the server to
finish re-encoding, which is why you see "Processing on the server…". JPEG,
PNG, WebP, AVIF or GIF, up to 10 MB each.

### Handles never get reused

Every handle a product has ever held is kept forever. Renaming retires the old
one and old links keep working, redirecting to the new address. The
consequence: **a new product cannot take a handle another product used to
have**, and you will be told so.

### Bulk actions

Tick products in the list to get the action bar: change status, publish,
unpublish, add or remove from a collection, add or remove tags. Up to 200 at a
time.

Each product is processed individually, so **one failure does not sink the
batch**. If some fail, your selection is kept and the reasons are listed.

Only **manual** collections are offered in the bulk actions — a smart
collection's membership is its rules.

---

# Categories

**Who can see it:** `catalog:read`. **Who can change:** `catalog:write`.

## How to use Categories

Categories are a tree, and **a product belongs to exactly one**. If you want a
product in several places at once, that is what a [collection](#collections) is
for.

**New category** or *Add a sub-category* from a row's menu. Leave the parent
empty for a top-level category. **Position** orders siblings; lower sorts
first.

The tree may be **at most five levels deep**. The parent picker excludes the
category itself and everything under it, so you cannot accidentally make a loop.

**Visible on the storefront** hides a category without archiving it. Its
products stay where they are.

**Archiving is refused while anything still points at the category** — products
or sub-categories. Move them first. Cascading was deliberately not built:
re-classifying somebody's catalogue is a decision a person should make on
purpose.

Renaming is always safe. Products stay where they are.

The search box here filters what is already on screen (the whole tree is loaded
at once) and **keeps each match's ancestors visible**, so the hierarchy still
reads.

> **If you seeded the Shopify taxonomy**, this tree has around 1,800 nodes and
> most of them will be empty. Pruning it to what you actually sell makes both
> this screen and your storefront navigation considerably more useful.

---

# Collections

**Who can see it:** `catalog:read`. **Who can change:** `catalog:write`.

## How to use Collections

A collection is where products appear together on the storefront. There are two
kinds, and **you choose which when you create it**:

- **Hand-picked** — a list you arrange, in the order you arrange it.
- **Smart** — a rule that finds them.

> **Choose carefully: switching a hand-picked collection to smart drops every
> product somebody chose, silently and irreversibly.** The admin only offers the
> choice at creation for that reason.

### A hand-picked collection

**Add products** searches the whole catalogue, not just the page. Products
already in are shown ticked and disabled. Chosen products are appended and saved
immediately.

The order on this screen is the order on the storefront. Move rows up and down,
then **Save order**. Up to 500 products.

### A smart collection

> **Membership is the rule.** A smart collection holds whatever matches at the
> moment somebody looks, so it stops containing something the instant that stops
> being true. Nothing is stored and nothing is scheduled.

Build conditions the same way as a [segment](#segments). The fields include
title, handle, description, vendor, product type, tags, category handle, status,
published, created and edited dates, price, compare-at price, discount percent,
number of variants, any SKU, stock on hand, in stock, and has an image.

Two that mislead if you skim them:

- **Price is the cheapest live variant.** "Under £50" means "something can be
  bought for under £50", not "every size is under £50".
- **In stock counts untracked items as in stock**, always.

The preview shows the count and up to six matching products as you work, so you
can see what a rule does before saving it. Up to 25 conditions.

You cannot edit a smart collection's membership by hand. On a product page, a
collection it belongs to by rule is marked **By rule** and has no remove button:
change the rules or change the product.

### Archiving

A collection disappears from the storefront but **keeps its membership**, so
restoring it restores the list. No product is changed.

---

# Inventory

**Who can see it:** `inventory:read` — Staff included.
**Who can move stock:** `inventory:adjust`, and `inventory:transfer` to move it
between locations. **Who can change tracking policy and locations:**
`inventory:manage` — Admin and Owner only.

## How to use Inventory

### The three numbers

| | Means |
|---|---|
| **On hand** | Physically on the shelf |
| **Reserved** | Spoken for by a basket in checkout or an unfulfilled order |
| **Available** | On hand minus reserved — what you can actually sell |

An untracked item shows **Always** available. It is a made-to-order thing that
nobody counts, and it is always purchasable however many are on the shelf.

### Finding something

Search by product, variant or SKU. Filter by location, by **Low or out**, and by
whether an item is counted at all.

> **Choosing a location narrows the quantities, not the rows.** Items held
> elsewhere still appear, showing zero. The screen says so when a location is
> selected.

### Moving stock — three ways, and when to use each

Open an item and use **Adjust**, **Count** or **Transfer**.

**Adjust** — you know what changed and by how much. A delivery arrived, three
were dropped. Pick a direction, a quantity and a **reason**. The reason is kept
on the ledger for good and cannot be edited later.

The reasons you may cite: *Received a delivery, Manual adjustment, Damaged,
Waste, Customer return, Correction.* You cannot file a sale or a reservation as
an adjustment — those are written by the system, and a dropdown offering
"reservation" would let somebody file a sale as a shelf count.

**Count** — you counted the shelf and want the system to match. Enter what you
counted; the correction is worked out for you. This exists so a count is not
turned into the wrong movement by arithmetic against a figure that was already
stale when the page loaded. **Counting the same number as the system writes
nothing at all.**

**Transfer** — moving stock between locations. One transaction, two movements —
out of one and into the other — so the total across the shop is unchanged and
both ledgers explain themselves.

### What refuses a stock movement

- **You cannot remove stock that is reserved.** The refusal reads *"Cannot
  remove 5: only 2 unreserved of 7 on hand."* This is stricter than "do not go
  below zero", deliberately — eating into reserved stock strands somebody's
  order.
- An archived item, an unknown location, or an inactive location.
- A transfer to the same location it came from.

### The history

Every movement, with its reason, its effect on hand and on reserved, and where.
Filter by location or reason.

> **Nothing here can be edited.** A ledger that can be rewritten is not evidence
> of anything. A mistake is corrected by another movement, which is why
> *Correction* is one of the reasons.

A reservation moves *reserved* without moving *on hand*, which is why both are
shown. "Sold" in the reason filter is the moment a reservation became a sale.

### Holding stock

When something is reserved, the item page shows why — the order that holds it
(as a link), or "A basket in checkout", or "Held by staff".

### Tracking and thresholds

**Count stock** off means the item is always available, whatever the shelf says.
**Low-stock warning at** overrides the store default for this item; blank
restores the default, **which is not the same as zero**.

---

# Locations

**Who can see it:** `inventory:read`. **Who can change:** `inventory:manage`.

## How to use Locations

A location is a place stock physically sits — a shop floor, a stockroom, a
warehouse. **One is enough for most shops.**

Each has a **Name** and a **Code** — keep the code short and stable, it appears
on stock reports.

**Default location** is where a stock movement lands when nobody names one.
Promoting a location moves that role off whichever location holds it now;
existing stock does not move.

**Inactive** locations keep their stock but are not offered for new movements.

**Archiving** is refused while anything is still held there, and the default
location cannot be archived at all — it has no Archive button.

> **A caution about multiple locations.** Availability is summed across
> locations, but a reservation is taken from one. With stock split 1 + 12 across
> two locations, a two-unit order can look available and then fail at checkout.
> If you run one location this never arises.

---

# Discounts

**Who can see it:** `discounts:read` — **Admin and Owner only.** Staff have no
Discounts entry in the sidebar at all.

## How to use Discounts

### Creating one

**New discount** asks for only what cannot be changed later:

- **Code** — what the customer types. Uppercased as you type. Three characters
  or more, letters, numbers, hyphens and underscores. Case-insensitively unique.
- **Name** — for you, and on the order.
- **Takes off** — a percentage, a fixed amount, or the delivery charge.

> **The code and what it takes off cannot be changed afterwards.** An order that
> used SUMMER25 has to keep meaning what it meant. Everything else — the
> schedule, the limits, the scope, the minimum — can be changed freely.

Everything else is set on the detail page, which you land on immediately,
because a new code has no schedule, limits or scope yet.

### Setting the terms

**Terms** — the value, and a **Minimum basket** (blank or zero means any basket
qualifies). The **Live** switch turns it off outright, whatever the dates say.

**When it runs** — leave either end open. Blank start means live now; blank end
means until you switch it off.

**How often it can be used** — a total limit and a per-customer limit. The
per-customer limit now counts guests too: checkout creates a customer record
for every email that buys, so the same person using a code twice as a guest is
caught. **Signed-in customers only** is a stricter, separate thing — it means
the shopper must actually log in, and a guest is refused however well the shop
knows them.

**What it applies to** — the whole order, chosen products, or chosen categories.
This card **saves as you go**, separately from the page's Save button, so
choosing forty products is not lost to a stray reload.

> **A scoped discount with nothing chosen applies to nothing**, and every
> customer who types it is told it does not apply to their basket. The screen
> warns you.

A category scope reaches products through their category, so adding a product
to that category puts it in the promotion without touching the discount.

### Status — the server decides, and it is the same answer checkout gives

| Badge | Means |
|---|---|
| **Active** | Working now |
| **Scheduled** | Has a start date in the future — shown in blue, **not green**, so a code that is not live yet never looks live to somebody about to print a poster |
| **Expired** | Past its end date |
| **Used up** | Hit its total usage limit |
| **Off** | The Live switch is off |
| **Archived** | Withdrawn |

They are checked in that order, top down: archived beats everything, whatever
the dates say.

### What it has given away

The **Redemptions** card lists every order that used the code, with the total
computed by the server across all of them — not a sum of the page you can see.
This is read from the same ledger the per-customer limit is counted from, so
the two can never disagree.

> **Cancelling an order gives the use back.** You will see the Used count go
> *down*. That is correct: the sale did not happen.

### Archiving

It stops working immediately and cannot be changed afterwards. Orders that used
it keep naming it, which is why this archives rather than deletes.

---

# Analytics

**Not built.** The sidebar entry leads to a page that says so and lists what it
will do: sales and order trends over a range you choose, top products by units
and by net sales, new against returning customers, and re-running a rollup for
a range corrected after the fact.

**Use the [Dashboard](#dashboard) meanwhile** — it carries today's live figures
and a rolled-up 30-day window.

---

# Notifications

**Who can see it:** everyone who can sign in.

## How to use Notifications

The bell in the header shows the unread count, capped at 99+, and the latest
ten. **View all notifications** opens the full, paginated record.

Two types are drawn as alerts rather than as events, because they mean
something is *wrong* rather than that something happened: **out of stock** and
a **failed background job**.

Everything else — orders placed, confirmed or cancelled, payments succeeded or
refunded, shipments shipped or delivered, low stock — is an ordinary entry.

**Mark all read** appears only when something is unread.

Notifications are per person. Staff notifications are fanned out individually,
so one person reading a low-stock alert does not clear it from everybody else's
list.

The bell polls every two minutes as a floor behind live updates, and its panel
only loads when you open it.

---

# Store settings

**Who can see it:** `settings:read`. **Who can change:** `settings:write`.
Admin and Owner only.

> **One page, one save.** The whole page saves together, deliberately: the tax
> basis and the currency change what every other figure on the page means.
> **Discard** appears while you have unsaved changes.

## Store

Name, contact email (it signs every email the shop sends), support page and
phone.

## Logo

> **The logo saves itself on upload**, separately from the page's Save button.
> An upload that appears to have worked and silently is not saved is a bad
> surprise.

PNG or SVG on a transparent background reads best.

## Region and units

**Currency** — three letters, ISO 4217. **Changing it does not convert existing
prices.** A £10 product becomes a $10 product.

**Weight unit** — what product weights are entered in.

**Time zone** — the clock every timestamp is read against, including the
dashboard's "today".

## Tax

**One rate, applied to every order.** Two decimal places, so 8.75% is exact.

**Catalogue prices** is the important choice:

- **Exclude tax** — a product priced £10.00 is charged **£12.00** at 20%.
- **Include tax** — a product priced £10.00 is charged **£10.00**, of which
  £1.67 is tax.

The card shows a live worked example so you can see which you have chosen.

> **Changing the rate does not re-rate past orders.** They keep the rate they
> were placed at.

## Orders and checkout

**Guest checkout** — off means a shopper must have an account before they can
buy.

**Order number prefix** — prepended to new order numbers. Existing orders keep
theirs.

**Basket holds stock for** (minutes) and **Unpaid order holds stock for**
(hours) are two different timers and easy to confuse. The second **must be
longer than the first**, or an order loses its stock while it is still live.

**Low-stock warning at** is the store default. An individual item can override
it on its own page.

## Cash on delivery

Every control here is a limit, not a feature. Each one is a way cash on
delivery loses money, written down.

| Control | What it protects against |
|---|---|
| **Smallest order** | The courier costing more than the order is worth |
| **Largest order** | One refusal being any size at all |
| **Handling fee** | Not covering the cost of the method |
| **Unpaid orders per customer** | Somebody accumulating refusals |
| **Countries** | Delivering where refusals are expensive to recover from |
| **Account holders only** | Guests, who leave nothing behind but an address |

**The open-order cap now applies to guests.** It counts per customer, and
checkout gives every email that buys a customer record — so somebody placing
their fourth unpaid cash-on-delivery order as a guest is stopped by the cap
whether or not they ever signed in. This used to be trivially avoidable by not
logging in.

**"Account holders only" is still the stricter lever.** It asks whether the
shopper signed in, not whether the shop has a record of them, so it refuses a
guest the shop recognises perfectly well. Use it when you want a real account
behind the order; use the cap when you want to limit exposure per person.

**Leaving Countries empty means everywhere the store ships**, not nowhere.

**Turning cash on delivery off keeps all the limits**, so it can be turned back
on without re-entering them.

> **A caution.** The card warns you if the ceiling is below the floor, but it
> does not stop you saving it. If you do, cash on delivery refuses every order —
> everything is either below the minimum or above the maximum.

The limits themselves are never published to the storefront; only *whether*
cash on delivery is offered. Publishing the thresholds would be publishing
exactly what to stay under.

---

# Staff

**Who can see it:** `staff:read` — **Owner only.**

## How to use Staff

### Inviting somebody

**Invite someone** → email, optional names, and at least one role.

> **You never see or send a password.** They set their own from a single-use
> link, valid for seven days. Nobody, including you, ever knows another
> person's password.

Roles **add up — nothing subtracts**. A person with Staff and Admin has the
union of both.

**Resend** issues a fresh link and **invalidates the previous one**. It is
refused if they have already accepted.

Inviting an address that already has an account is a plain error rather than a
silent no-op — you are an owner administering your own staff, so there is
nothing to protect you from knowing.

### Reading the list

- **Active** — has a password and can sign in.
- **Invited** — the account exists but has no password until the link is used.
- **Disabled** — cannot sign in.

Your own row is marked "· you".

### Changing roles

> **Takes effect on their next request, not their next sign-in** — within about
> thirty seconds.

Removing the owner role from somebody takes away staff management and the audit
trail. **The last owner is protected**: the server refuses to remove the role,
and refuses to disable the account.

### Disabling

> They are signed out everywhere immediately and cannot sign back in. Nothing
> they did is removed — the audit trail still names them — and you can restore
> the account later.

**You cannot disable your own account**, and the button is not offered on your
own row.

**There is no delete.** An account that has done things is disabled, never
removed, because the audit trail names it.

### What the roles mean

The reference card at the foot of the page lists every role and every
permission it holds, read live from the server. **It is set in code and changes
only on a deploy** — you cannot create a role or adjust one from here.

---

# Audit trail

**Who can see it:** `audit:read` — **Owner only.** Reading what people with
power did is itself a privileged act.

## How to use the Audit trail

Every administrative change, as it was recorded. **Nothing here can be edited.**

**Filter by action** — actions are written `resource.verb`, like
`order.refunded`. The filter is an **exact match**, not a search, which is why
the screen shows a hint and will not send a partial string.

**Filter by kind** — orders, products, customers, refunds, returns, discounts,
inventory, shipping, settings, staff.

**Date range** — the dates are widened to whole days, and are **UTC**
regardless of your store's timezone.

Each entry shows who did it (or **The system**), what they did, which record,
and when. Open one to see a **field-by-field diff** — `price: 1200 → 1500` —
rather than two blocks of JSON. A request id is shown for correlating with
server logs.

Passwords, tokens and secrets are scrubbed before anything is written.

The trail is written inside the same transaction as the change itself: if the
change happened, its audit row happened, and vice versa.

**Reads are never audited**, nor is anything a customer does to their own data.

> **A coverage gap worth knowing.** Role changes and account disable/restore are
> **not** written to the audit trail. Filtering by Kind = Staff shows
> invitations but not "X was made an admin". See
> [Known gaps](#known-gaps).

Retention is indefinite. Nothing trims it.

---

# Your account

**Who can see it:** everyone. No permission required — everybody has an
account, so this is the one settings tab always available.

## How to use Your account

### Where you are signed in

Every browser holding a live session. Each is described coarsely — "Chrome on
macOS" — because the question this answers is *is that laptop mine*, not *which
build of Chrome is that*.

**End** signs a session out immediately. Your current session is deliberately
not endable here — sign out instead.

### Password

**Changing your password signs out every other browser** and leaves this one
signed in. That is exactly what makes changing it worth doing after somebody
has seen it.

A **password reset** (the forgot-password flow) is different: it signs out
*every* session, including the one that did it.

Requirements: **at least 10 characters**, at most 200. There are no
uppercase-digit-symbol rules — a phrase you can remember beats a short one you
cannot. Two rules are only checked by the server, so you can pass the form and
still be rejected:

- it must not be one of a list of very common passwords;
- it must not contain the local part of your email address.

---

# Status vocabularies

## An order has three statuses, not one

They move independently. This is why the admin shows three badges and never one
word.

**Order status** — where the work has got to.

| | Means | Can become |
|---|---|---|
| Pending | Placed, not yet accepted. Stock held, not committed | Confirmed, Cancelled |
| Confirmed | Accepted. Stock committed | Processing, Cancelled |
| Processing | Being picked and packed | Completed, Cancelled |
| Completed | Done | — |
| Cancelled | Off. Stock returned | — |

**Payment status** — where the money has got to.

| | Means |
|---|---|
| Unpaid | Nothing received |
| Authorised | Held, not taken |
| Paid | Received in full |
| Part refunded | Some money returned |
| Refunded | All of it returned |
| Payment failed | An attempt failed — recoverable |

**Fulfilment status** — where the goods have got to.

| | Means |
|---|---|
| Unfulfilled | Nothing shipped |
| Part shipped | Some shipped |
| Shipped | All shipped |
| Delivered | Arrived |
| Returned | Come back |

## A return

Requested → Approved → On its way → Received → Closed, with **Declined** and
**Cancelled** as exits before the goods move. Closed, Declined and Cancelled
are all final.

## A product

Draft → Active → Archived, plus **published** or not as a separate fact.
Restoring an archived product returns it to Draft.

## A discount

Archived → Off → Scheduled → Expired → Used up → Active, checked in that
order.

---

# Why was I refused?

Common refusals, and what to do about them.

| The message | What it means | What to do |
|---|---|---|
| *A shipped order cannot be cancelled* | Something has already gone out | Refund it and take it back as a return |
| *This order has already been paid in full* | No outstanding balance | Nothing to record |
| *That would refund more units than were ordered* | Over one of the three refund caps | Check the Refundable column |
| *Restocking needs the items and quantities coming back* | Restock ticked with no quantities | Choose the units, or untick restock |
| *Only a received return can be refunded* | Nothing recorded as arrived | Record what arrived first |
| *That draft has already been placed* | Somebody placed it in another tab | Open the order it became |
| *A product needs at least one live variant before it can be activated* | Nothing sellable on it | Add a variant |
| *A {status} product cannot be published — activate it first* | Publishing a draft | Make it active, then publish |
| *An archived product cannot be edited; restore it first* | Editing something withdrawn | Restore it to draft |
| *That handle is already in use, now or by a product that used to have it* | Handles are never reused | Choose another |
| *{n} product(s) are still in this category — move them first* | Archiving a category in use | Move the products |
| *{n} variant(s) still use "{value}"* | Removing an option value in use | Archive those variants first |
| *This is a smart collection; edit its rules rather than its products* | Hand-editing a rule-based collection | Change the rules |
| *Cannot remove {n}: only {x} unreserved of {y} on hand* | Removing stock that is spoken for | Wait, or release the reservation |
| *{countries} is already covered by the zone "{name}"* | Two live zones, one country | Archive or deactivate the other |
| *The last owner cannot have the owner role removed* | Locking yourself out | Make somebody else an owner first |
| *You cannot disable your own account* | — | Ask another owner |
| *The order changed while you were working on it* | Two people at once | Reload and look again |
| *Too many attempts. Wait a few minutes and try again.* | Rate limited | Wait |

---

# Known gaps

Things that are missing or behave differently from how they look. Worth knowing
before somebody reports them as bugs.

**Not built yet**

- **Analytics** — the page says so. Use the Dashboard.
- **Payments** — the page says so. Payments happen on the order; the rules live
  in Store settings.

**Missing controls**

- **No way to open a return from the admin.** Returns come from the storefront.
- **No restore button for an archived shipping zone**, although the dialog
  promises one and the server supports it. Archiving a zone is effectively
  one-way from this screen.
- **No un-archive for a shipping method** at all.
- **Carrier and tracking cannot be entered on a shipment.**
- **No sort control on the order list** — it is always newest first.
- **Addresses cannot be edited** from a customer's record.

**Behaves differently from how it reads**

- **Checkout attempts:** the stat cards and reasons chart cover seven days; the
  table below covers all time.
- **Discounts:** the *Total uses* hint says a limit below current usage cannot
  be saved. It can. Doing so simply marks the code Used up.
- **The Transfer button** on an inventory item is shown to anyone who can
  adjust stock, but the server requires the separate transfer permission. If
  you can see it and are refused, that is why.
- **Role changes and account disable/restore are not in the audit trail**, only
  invitations.
- **The customer's Orders card searches by email**, so orders inherited through
  a merge do not appear there.
- **Cash on delivery** will let you save a ceiling below the floor, which
  refuses every order.

**Worth planning around**

- **Multiple stock locations:** availability sums across locations but a
  reservation is taken from one, so split stock can look available and fail at
  checkout.
- **The seeded Shopify category tree** is ~1,800 nodes. Prune it to what you
  sell.
