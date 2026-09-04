# Admin

The administrative dashboard for the store. React, TypeScript and Tailwind,
consuming the `server/` REST API and its Socket.IO `/admin` namespace.

**Built so far**

- The foundation — navigation, authentication, authorization, the API layer,
  realtime, notifications and the design system.
- **Products** — list with server-side search, filters, sorting and pagination;
  create with options and a variant matrix; edit; per-variant pricing; images;
  activate, publish and archive.
- **Categories** — the tree, with create, edit, re-parent, hide and archive.

Orders, Inventory, Customers, Shipping, Payments, Discounts and Analytics are
routed and protected but not yet implemented; each of those pages states what it
will do and which real endpoints it will use.

---

## Running it locally

You need the API running first.

```bash
# 1. In server/
npm run dev              # http://localhost:4000 by default

# 2. In admin/
cp .env.example .env.local
npm install
npm run dev              # http://localhost:5174
```

Sign in with a staff, admin or owner account. A `customer` account can
authenticate but is refused: the admin checks `isStaff` and signs the session
straight back out, and the server refuses every `/admin` route for it anyway.

If the API is not on port 4000, point the dev proxy at it:

```bash
VITE_DEV_API_PROXY=http://localhost:4133 npm run dev
```

### Open the admin on exactly the origin the server allowlists

Image uploads go to the URL the **server** hands back, verbatim — that is the
storage contract, and in production it is a signed URL at the storage provider.
With `STORAGE_PROVIDER=local` that URL points at the API's own `/local-storage`
routes, which is a different origin from the Vite dev server, so the upload
depends on CORS.

The practical consequence: open the admin at the origin the server has in
`ADMIN_ORIGIN`. If that is `http://localhost:5174`, browsing to
`http://127.0.0.1:5174` will load the admin fine and then fail every upload with
"could not reach the server", because `127.0.0.1` is not the allowlisted origin.

### Why the dev proxy matters

Vite proxies `/api` and `/socket.io` to the backend, so the browser sees one
origin in development. The refresh token is an httpOnly cookie the server scopes
to `/api/v1/auth` and marks `SameSite=Strict`; a same-origin dev setup means it
behaves exactly as it will in production instead of needing `SameSite=None`
locally.

In production the admin is served from its own origin, and that origin must be
the server's `ADMIN_ORIGIN` — the server's CORS allowlist is credentialed and
will refuse anything else.

### Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server on port 5174 |
| `npm run build` | Typecheck, then a production build into `dist/` |
| `npm run preview` | Serve the production build |
| `npm run typecheck` | `tsc -b --noEmit` |
| `npm run lint` | ESLint, type-aware |
| `npm run test` | Vitest, once |
| `npm run test:watch` | Vitest, watching |
| `npm run format` | Prettier |

---

## Structure

```text
admin/
├── index.html
├── vite.config.ts            dev proxy, path alias, test config
├── eslint.config.js          type-aware, react-hooks, react-refresh
├── tsconfig.app.json         strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
├── .env.example
└── src/
    ├── main.tsx
    ├── app/                  application wiring
    │   ├── App.tsx           the provider stack
    │   ├── env.ts            build-time configuration, validated once
    │   ├── queryClient.ts    React Query defaults
    │   ├── theme.tsx         light / dark / system
    │   └── theme.context.ts
    ├── routes/
    │   ├── AppRoutes.tsx     the route table
    │   ├── ProtectedRoute.tsx  the guards
    │   └── navigation.ts     the sidebar model (grouped, permission-aware)
    ├── lib/
    │   ├── api/
    │   │   ├── client.ts     the only place fetch is called
    │   │   ├── errors.ts     ApiError + the server's error codes
    │   │   └── tokenStore.ts in-memory access token
    │   ├── realtime/
    │   │   ├── events.ts     REALTIME_EVENTS / CLIENT_EVENTS, copied from the server
    │   │   ├── socket.ts     one connection, reconnection, re-auth
    │   │   ├── RealtimeProvider.tsx
    │   │   └── useRealtimeEvent.ts
    │   ├── cn.ts
    │   └── format.ts         money, dates, numbers — display only
    ├── components/
    │   ├── ui/               the design system (see below)
    │   └── states/           Loading / Empty / Error / Unauthorized / Forbidden / NotFound
    ├── layouts/
    │   ├── AdminLayout.tsx   sidebar + topbar + content, drawer below lg
    │   ├── AuthLayout.tsx    the signed-out shell
    │   ├── Sidebar.tsx  Topbar.tsx  Breadcrumbs.tsx  UserMenu.tsx
    │   └── ConnectionIndicator.tsx
    ├── features/
    │   ├── auth/             AuthProvider, guards, login form, permissions
    │   ├── categories/       api/ hooks/ components/ pages/ types/ — the tree
    │   ├── dashboard/        the overview query, queues, sales trend
    │   ├── media/            the three-step upload, dropzone, progress
    │   ├── notifications/    list, bell menu, realtime sync
    │   ├── products/         api/ hooks/ components/ pages/ types/
    │   └── settings/         the store's public settings (currency)
    ├── pages/                one file per route; placeholders.tsx for the unbuilt areas
    ├── hooks/                useDisclosure, useMediaQuery, useFocusTrap, …
    ├── types/api.ts          the wire envelope, mirrored from the server
    └── test/                 setup, render helper, fetch helpers
```

Features own their API calls, their hooks and their components. Shared UI lives
in `components/ui`; anything a second feature needs moves there rather than
being imported across a feature boundary.

---

## How it talks to the server

**Everything goes through `lib/api/client.ts`.** No component calls `fetch`.
That one module attaches the bearer token, sends credentials, unwraps the
`{ success, data }` envelope, reads `meta.pagination` for lists, and turns any
failure into an `ApiError` carrying the server's stable `code`.

Access tokens last fifteen minutes. On a 401 the client refreshes once and
replays the request; concurrent 401s share a single in-flight refresh, because
the server rotates the refresh token on every use and treats a second use of a
rotated one as theft.

Nothing authoritative is computed here. Prices, totals, stock, page counts and
permissions all arrive from the server; `lib/format.ts` only turns them into
strings.

## Authentication

One mechanism, the server's:

- `POST /auth/login` returns an access token in the body and sets the refresh
  token as an httpOnly cookie scoped to `/api/v1/auth`.
- The access token is held **in memory only** — never `localStorage`, where any
  injected script could read it and where it would outlive the tab.
- On load, `AuthProvider` posts `/auth/refresh` once. A good cookie restores the
  session; a bad one makes the admin anonymous. Until that settles the status is
  `restoring`, and no guard redirects — otherwise every reload flashes the login
  page.
- Signing out calls `/auth/logout`, clears the token and empties the query cache
  so the next operator never sees the previous one's data.

## Authorization

The server is authoritative. `requireStaff()` runs before any `/admin` route is
mounted, and `requirePermission('resource:action')` runs on each one.

The admin mirrors those permissions from `/auth/me` and uses them **only to
decide what to render**: the sidebar hides sections, `ProtectedRoute` refuses a
page, and `<RequirePermission>` hides a control. A `staff` account holds no
`analytics:read`, `discounts:*`, `settings:*` or `catalog:write`, so it sees a
materially smaller admin — and would be refused by the server even if it did not.

## Realtime

One Socket.IO connection to the `/admin` namespace, authenticated with the same
access token in the handshake. Rooms are derived server-side from the verified
token; the client never names one.

Event names come from `lib/realtime/events.ts`, copied verbatim from
`server/src/infrastructure/realtime/events.ts`. When a token rotates, the live
socket is re-authenticated with `auth:refresh` rather than reconnected.

Realtime is best-effort and layered over REST: an event **invalidates** the
relevant query rather than being written into the cache, so the server stays the
only place these numbers are computed. The header shows the connection's state,
because a dashboard that has quietly stopped updating should say so.

---

## Products and categories

**The variant is the purchasable unit.** Price, SKU, barcode and weight live on
a variant, never on the product, so the create form asks for the axes a product
varies on and then wants a price for every combination. A product with no
variants is unbuyable, which is why the API demands at least one.

**Status and publication are separate.** `draft | active | archived` is the
lifecycle; publication is a row per sales channel. An active product need not be
published, and archiving unpublishes everywhere. Each transition is its own
endpoint with its own audit entry — `PATCH` accepts no status field at all, so
the admin never hides those decisions inside a form save.

**Nothing is destroyed.** There is no `DELETE` for a product, because an order
line references a variant id for as long as the order exists. Archiving is the
only retirement, and the confirmation dialogs say so. Categories are the same:
`DELETE /admin/categories/:id` archives, and the server refuses while products
or child categories still point at it rather than silently re-classifying them.

**Editing sends only what changed.** Forms keep a baseline and PATCH the diff,
so an untouched field is absent from the request and cannot revert a colleague's
concurrent edit. A cleared optional field sends `null`, which is what clears it.

**Images follow the server's storage contract exactly**: request an upload, PUT
the bytes at the URL the server chose, call `complete`, wait for the worker to
finish re-encoding, then attach the ready asset. The admin never picks a bucket
or a key, never talks to a storage service the server did not point it at, and
never attaches its bearer token to that PUT — a signed URL is its own credential.

**No realtime.** The server emits no Socket.IO events for the catalogue
(`REALTIME_EVENTS` has none), so none are subscribed to. Product and category
screens refresh through query invalidation after their own mutations.

### Why it looks like Shopify

The catalogue screens deliberately copy Shopify's admin — the dark top bar over
a light nav rail, the borderless cards on a grey canvas, the view tabs above the
index, the save bar that appears only when a form is dirty, the two-arrow pager,
the search-result preview under "Search engine listing". The point is
onboarding: staff who have used Shopify should recognise where things are
without being taught.

It is a hand-built resemblance, not `@shopify/polaris`. The package brings its
own token system and stylesheet, which would fight Tailwind and leave the
catalogue looking like a different application from Orders and Customers.
Instead the palette and radii moved into `styles/index.css`, so the whole admin
shifted together and most components needed no edit.

Two widths, as Shopify has them: index pages get the window (a six-column table
loses its last columns at 1000px), detail pages stay capped near 1000px (a form
label 1600px from its field is a worse form). `AdminLayout` decides from the
route — every sidebar destination is an index, everything reached from one is a
detail page — so new pages get the right width with no opt-in.

**Shopify features deliberately left out**, because this server has no data
behind them and a control that cannot work is worse than an absent one:

| Not built | Why |
| --- | --- |
| Cost per item, profit, margin | No cost field on a variant; profit would be invented on the client, which the money rules forbid. |
| Markets / international pricing | Single-currency store; no market or price-list tables. |
| Theme templates ("Theme template" select) | The storefront renders from React routes, not from named Liquid templates. |
| Sales-channel picker in the editor | Publication is per channel and per endpoint. The editor shows publish/unpublish only; a multi-channel picker would imply a bulk API that does not exist. |
| Cross-resource search in the top bar | No endpoint searches products, orders and customers together. The field is present and disabled rather than faked. |
| Product bundles, gift-card products | No schema for either of them. |

Adding any of these is a server change first. Nothing in the admin fakes them.

## Custom fields (metafields)

Extra fields the shop defines for itself, on products, variants, collections,
customers and orders. **Settings → Custom fields** is where they are defined;
the values are filled in on the record itself, in a card that builds its inputs
from the definitions rather than from anything hand-written per page.

Three rules are worth knowing before using them:

- **The type is fixed once a field exists.** Values are already stored against
  it, so changing a text field to a number would leave every stored value
  invalid under its own definition. The label renames freely.
- **Fields are private by default.** A definition has to be marked *Customers
  can see this* before it appears in the public product or collection API. The
  filter is in the server's query, not in a serializer.
- **Permissions follow the record, not the field.** Defining fields needs
  `settings:write`; filling one in needs the permission on the thing being
  edited — `catalog:write` for a product, `customers:write` for a customer,
  `orders:write` for an order.

Deleting a definition deletes every value under it, and the confirmation says
how many.

## The design system

`components/ui` — Button, Input, Select, Textarea, Checkbox, Switch, Field,
Badge, Card, Alert, Modal, ConfirmDialog, DropdownMenu, DataTable, Pagination,
Tabs, Tooltip, Skeleton, Spinner, Toast, Avatar, SearchInput, StatCard,
PageHeader.

`components/states` — LoadingState, EmptyState, ErrorState, UnauthorizedState,
ForbiddenState, NotFoundState, QueryBoundary, ErrorBoundary.

Colours come from semantic tokens in `styles/index.css` (`bg-surface`,
`text-muted`, `border-line`, `text-danger`), never raw palette values in a
component, so dark mode is one block of overrides.

Responsive: desktop and laptop first, the sidebar becoming a drawer below
`lg`, single-column cards below `sm`, and wide tables scrolling inside their own
container rather than the page.

---

## Testing

```bash
npm run test
```

Vitest and Testing Library. `fetch` is stubbed with the exact envelopes the
server produces (`src/test/api-mock.ts`), so a change to that contract fails a
test rather than a page — and an undeclared request fails loudly with a 501
naming it, rather than resolving to `undefined` three assertions later.

The suite covers the HTTP client's contract (envelope, error codes, the
refresh-and-replay dance), authentication and permission gating, the route
guards, the design system's accessibility promises, display formatting, and —
for the catalogue — listing, server-side search and filtering, debouncing,
sorting, creation with and without options, validation failures, editing that
sends only the changed fields, archival behind a confirmation, duplicate-submit
prevention, the category tree and its cycle guard, `CATEGORY_IN_USE`, the
three-step image upload, and read-only views for an operator holding only
`catalog:read`.
