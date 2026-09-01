# Storefront

The customer-facing shop. Vite 8, React 19, plain JavaScript, Tailwind v4,
TanStack Query, React Router 7, oxlint, Vitest.

```bash
npm run dev      # http://localhost:5173, proxying /api to the API on :4000
npm test         # 160 tests
npm run lint
npm run build
```

The API must be running (`npm run dev` in `server/`). For something to browse:
`npm run dev:catalogue` there creates ~30 demo products and the five
collections the shop navigates by.

## The one rule

**The storefront displays; it does not decide.**

Every price, total, availability state and "from £11.50" on screen is the
server's answer, rendered. Nothing here multiplies a quantity by a price, sums
a basket, applies a discount, or judges whether something is in stock. Those
are questions only the server can answer correctly, because only the server
knows the discount rules, the delivery rates, the tax basis and the live stock —
and a second implementation in a browser is a second answer that will
eventually disagree with the till.

Concretely, that is why:

- `priceRange` is read from the product, never computed from its variants. The
  server computes it over the *purchasable* variants only, so a product whose
  cheapest size is sold out advertises a price a shopper can actually pay.
- availability is a state the server names (`in_stock`, `low_stock`,
  `out_of_stock`, `made_to_order`), not a number this app compares against zero.
- every cart write returns the whole basket, re-priced, and the page **adopts**
  it rather than patching its own copy. Changing a quantity is a request, not
  a multiplication.
- checkout shows only what `/checkout/preview` returns. That endpoint runs the
  same rating, discounting and tax code that placing the order runs, which is
  what makes it safe to promise the total.
- searching and filtering are query parameters, never `Array.filter` over the
  page in hand. Filtering twelve visible products would silently mean "search
  the twelve you can already see".

## Colours are shown, never guessed

A colour option value carries a `swatchHex` the merchant set in the admin —
migration 0028 put it on `product_option_values`, because "Mulberry" is the same
colour in the 5 g and the 40 g and storing it per variant would let two copies
disagree. The storefront paints that hex and nothing else.

Deriving a colour from the *name* was the obvious shortcut and it is wrong:
it works for "Red" and produces a confidently wrong circle for "Mulberry",
"NBM01 Deep Brown" and "Elephant's Breath" — which is most of a real catalogue.
A value with no colour set falls back to its name rather than to a grey dot,
because "nobody has said" and "this one is grey" are different facts.

The picker asks **one question per axis** rather than listing whole variants,
and distinguishes three states per value:

- **available** — pick it.
- **sold out** — the combination exists and cannot be had. Shown and marked,
  because somebody choosing between shades needs to know the one they want
  exists.
- **not made** — no variant pairs this value with the current choices. Struck
  through and refused, rather than accepted and then silently corrected.

Choosing a shade also moves the gallery to that shade's photograph, which is
what `publicVariantDto.image` is for. A variant with no image of its own leaves
the gallery where it is — sending it back to the hero shot on every size change
was a real bug, caught by a test, and the shape of `ProductPage`'s gallery state
exists to prevent it.

## Collections, not categories

The shop browses by **collection**. Both exist on the server and they answer
different questions: a category is where a product *files* — one each, in a
deep tree the merchant maintains for their own sake — while a collection is
what a shopfront puts in a window: *Bestsellers*, *In the bakery*, *Under £10*.
A product belongs to many, or none, and the merchant decides which.

A collection is either **manual** (a hand-arranged list, and its order is
editorial content the storefront honours) or **dynamic** (a set of rules
evaluated at read time, so it is always current with nothing to rebuild). The
storefront cannot tell which it is looking at, and deliberately so:
`publicCollectionDto` carries no `type` and no `rules`. It sends a handle and
receives products.

The product page therefore leads back to the shop, not to a category — nothing
else in the storefront offers category browsing, and a breadcrumb into a
dead end is worse than no breadcrumb.

## How it is laid out

```
src/
  lib/          api.js — the only place that calls fetch; format.js; cn.js
  components/   Layout, and the small shared UI it is built from
  features/
    catalogue/  api → hooks → components → pages
    cart/       the basket
    checkout/   the quote, the address form, placing
    account/    everything behind sign-in, under one guard and one nav:
                orders, returns, addresses, details, security, notifications
    settings/   the store's public name and currency, fetched once
  test/         the fetch mock, the render helper, and DTO-shaped fixtures
```

`@/` resolves to `src/`, as in the admin.

Conventions worth knowing:

**The URL is the state.** Search term, collection, sort, price range, in-stock
and page all live in the query string, so a filtered listing can be linked,
reloaded and reached with the back button. A filter held in component state
makes the back button lie.

**Every sort and filter control maps to a parameter the server implements.**
`sort`, `minPrice`, `maxPrice` and `inStock` are real, the total count comes
back matching the filtered set, and the pager therefore cannot offer a page that
does not exist. A control that reordered only the twelve products on screen
would be the same lie as a search box that searched only them.

**The access token lives in memory, and one refresh happens at a time.** Never
in `localStorage`: a token sitting in storage is readable by any script that
gets onto the page, and it outlives the tab. The refresh token is an httpOnly
cookie this code cannot read at all, which is why a full page load always posts
one `/auth/refresh` — asking is the only way to find out whether there is a
session, and for a guest it answers 422 which the provider swallows.

That refresh token rotates on every use and the server treats a second use of a
rotated one as theft — so `refreshAccessToken` is a single in-flight promise
that *everything* goes through, the auth provider included. A provider posting
its own refresh was a real bug: React runs effects twice in development, the
second call presented the rotated token, and the whole session was revoked on
every reload.

**Fixtures are copied from the server's mappers, not invented.**
`src/test/fixtures.js` mirrors `publicProductCardDto`, `publicProductDto`,
`publicCollectionDto`, the cart DTO, the checkout preview and
`customerOrderDto` exactly — including the fact that a *card* carries no
compare-at price, that a sold-out product's `priceRange` is `null`, and that a
customer's order carries `paymentState` rather than the admin's status triple.
A test passing against an invented shape proves nothing.

**The cart is never addressed by id.** There is one route, `/cart`, and the
caller is identified by their session or an httpOnly guest cookie. That is also
why the dev server proxies `/api` rather than pointing at `localhost:4000`
directly: a cookie set by `:4000` is not sent to `:5173`, and the basket would
silently reset on every request.

**Placing an order carries one idempotency key**, minted once per mounted
checkout, so a retry after a dropped connection replays that attempt instead of
making a second order and a second stock reservation.

## Notes on the API

Found while building, reported rather than worked around.

**Fixed in the server, with tests:** `product_option_values` gained a
`swatch_hex` (migration 0028) with an admin picker to set it;
`publicVariantDto` now publishes the variant's own image, which existed in the
database and was simply not exposed; and the storefront product list gained
`sort`, `minPrice`, `maxPrice` and `inStock`, evaluated inside the query so the
count matches the page. `publicProductCardDto` also gained `colours`, which
costs nothing — the card mapper is handed the fully resolved product, and the
alternative was a request per card.

**Fixed earlier, in the server:** `/storefront/products?collection=`
joined `collection_products` unconditionally, so a *dynamic* collection — whose
membership is its rules, not rows in that table — always returned an empty
page. Every collection the demo data creates is dynamic, so the whole
collection-browsing surface rendered empty. The repository now evaluates the
rules when the collection is dynamic, matching what `collectionsService.productIds`
already did. `/checkout/preview` also gained `taxTotal` and `total`, which were
computed all along and simply not published — a checkout that cannot show what
will be charged is not a checkout.

**Still outstanding, none of them blocking:**

**No sort parameter on `/storefront/products`.** The endpoint takes `page`,
`limit`, `category`, `collection` and `q` — so there is no "price: low to high".
The listing deliberately ships without a sort control rather than offering one
that reorders only the twelve products on screen, which would be a lie about
what it did.

**No compare-at price on the product card.** `publicProductCardDto` carries
`priceRange` but not `compareAtPrice`, so a grid cannot show "20% off" — only
the product page can, where the full variant is available. The cards show a
tag-based badge instead.

**An order number cannot be a URL.** The store's number prefix defaults to `#`,
which in a URL is a fragment, so `/orders/#1001` truncates. The confirmation
routes on the order's id instead, and guests returning later use
`/orders/lookup`, which needs the number *and* the email — order numbers come
from a sequence and are guessable, so the email is what makes that endpoint
safe to leave public.

**`GET /auth/sessions` is unpaginated.** It returns every active session as one
array. Fine for somebody with three devices; the security screen caps the
display at six with a count and a "show the rest", which is a presentation
choice rather than a fix.

**There is no catalogue of notification types.** `GET /notifications/preferences`
returns only the exceptions somebody has set, since an absent row means enabled
— a good design that needs no backfill when a type is added, with one
consequence: the preferences screen has to name the types it offers switches
for, and a new server-side type will not appear until that list does.

**A customer cannot change their own email.** `PATCH /account` takes a strict
schema without it, so the details screen shows the address and explains why,
rather than offering an input that would 422. Changing the address somebody
signs in with needs a verification round trip that does not exist yet.

**No wishlist, reviews or newsletter signup.** None of the three has an
endpoint. Marketing consent exists only as `acceptsMarketing` on the
authenticated profile, so there is no signup for somebody who has not registered.

**The admin's product list has the same dynamic-collection gap.** Filtering
admin products by a dynamic collection's id still joins `collection_products`
and returns nothing. The admin does not currently do that — it previews a
dynamic collection through `collectionsService` instead — so it was left alone
rather than changed speculatively.

**No product counts on `/storefront/categories`.** Not used by the storefront
any more, but the gap is still there for anyone who wants category browsing:
the endpoint returns the whole tree with no indication of which nodes contain
anything, which with the seeded Shopify taxonomy is 1,864 nodes in one
unpaginated payload.
