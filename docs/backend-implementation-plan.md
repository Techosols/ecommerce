# Ecommerce Platform — Backend Implementation Plan

**Status:** Proposed — awaiting sign-off. No implementation code has been written.
**Scope:** `server/` only. `client/` and `admin/` are referenced only where they constrain the backend contract.
**Date:** 2026-08-29

---

## 0. How to read this document

Sections 1–22 answer the architecture questions in order. Section 23 breaks the system down feature by feature (what it owns, entities, APIs, dependencies, events, jobs, realtime, analytics). Section 24 is the dependency-ordered build plan. Section 25 lists the decisions that still need your explicit approval before Phase 0 starts.

Two rules govern every choice below, taken straight from `CLAUDE.md` §58 and §68:

- The simplest architecture that satisfies the requirement wins.
- Every infrastructure dependency must earn its place with a concrete use case.

Where a decision is genuinely contested, the alternative and the cost of reversing later are stated rather than hidden.

---

## 0.1 Confirmed technology decisions

These four were settled before drafting:

| Decision | Choice | Why |
|---|---|---|
| Language | **TypeScript, strict mode** | Money, order/payment state machines, event payloads and job payloads are exactly the places where a type error becomes a financial bug. `CLAUDE.md` deferred to "the existing project"; there is none, so this is a fresh choice. |
| Data access | **`pg` (node-postgres) + hand-written SQL + plain `.sql` migrations** | The order/inventory path needs `SELECT … FOR UPDATE`, deterministic lock ordering, `INSERT … ON CONFLICT`, CTEs and window functions for analytics. An ORM would be bypassed for all of it. |
| Queue / cache / realtime infra | **PostgreSQL only. `pg-boss` for the queue, in-process cache, single Socket.IO node.** No Redis in v1. | Jobs live in the same database, so a job or event can be written inside the same transaction as the order. One datastore to run, back up and reason about. Redis has a documented seam (§8.6, §11.7) for when a second API instance is needed. |
| Payments | **`PaymentProvider` interface + manual/offline adapter only in v1** | Full payment domain, state machine, webhook ingestion path and refund model are built now; a real PSP drops in later as one adapter with no schema change. |

### 0.2 The full dependency list, and what each one is for

Nothing goes in without a reason.

| Package | Purpose | Why not something else |
|---|---|---|
| `express` (v5) | HTTP layer | Named in `CLAUDE.md`. v5 has native async error propagation, so no `express-async-handler` wrapper. |
| `pg` | Postgres driver + pool | Direct control over transactions and locks. |
| `pg-boss` | Job queue, scheduling, retries, dead-letter | Uses the Postgres we already run. No Redis. |
| `socket.io` | Realtime | Named in `CLAUDE.md`. |
| `zod` | Validation + env parsing + OpenAPI source | One schema library for request validation, config, job payloads and event payloads. |
| `jsonwebtoken` | Access-token signing | Standard, small. |
| `argon2` | Password hashing | Argon2id is the current recommendation over bcrypt; memory-hard. |
| `pino` + `pino-http` | Structured JSON logging | Fast, low overhead, first-class redaction. |
| `helmet` | Security headers | One line for a dozen headers. |
| `cors` | Origin allowlist for two frontends | Two distinct browser origins require it. |
| `express-rate-limit` | Auth + write-endpoint throttling | In-memory store is correct for a single API instance; the store is swappable. |
| `nodemailer` | SMTP transport, behind `EmailProvider` | Provider-neutral; a hosted API adapter can be added without touching callers. |
| `mjml` + `handlebars` | Email templates (compiled at build) | Email HTML must be table-based; MJML makes that maintainable. |
| `sharp` | Image resize / variant generation in a worker | Only place image processing happens. |
| `@supabase/supabase-js` | **Storage only**, behind `StorageProvider` | Used for object storage and signed upload URLs, not for database access. |
| `vitest`, `supertest`, `testcontainers` | Test runner, HTTP tests, disposable Postgres | Integration tests run against real Postgres, not a mock. |
| `tsx`, `typescript`, `eslint`, `prettier` | Dev tooling | — |

Deliberately **not** included: an ORM, Redis, a message broker, GraphQL, dependency-injection containers, `moment`, `lodash`.

---

# 1. Backend architecture

## 1.1 Shape

A **modular monolith**: one codebase, one deployable image, two runtime processes.

```
┌──────────────────────────────────────────────────────────────┐
│                     One codebase, one image                  │
│                                                              │
│   process: api                      process: worker          │
│   ┌────────────────────┐            ┌────────────────────┐   │
│   │ Express HTTP       │            │ pg-boss workers    │   │
│   │ Socket.IO server   │            │ cron schedules     │   │
│   │ Event dispatcher*  │            │ event dispatcher   │   │
│   └─────────┬──────────┘            └─────────┬──────────┘   │
│             │                                 │              │
│             └────────────┬────────────────────┘              │
│                          ▼                                   │
│              features/  (business domains)                   │
│                          ▼                                   │
│              infrastructure/  (technical capability)         │
│                          ▼                                   │
│                    PostgreSQL                                │
└──────────────────────────────────────────────────────────────┘
   * the dispatcher runs in the worker process; the api process
     only nudges it. See §12.4.
```

Both processes boot from the same `features/` code and the same `infrastructure/`. They differ only in entrypoint: `src/main/api.ts` starts the HTTP + socket server; `src/main/worker.ts` starts pg-boss workers and the event dispatcher. In development a single command runs both in one process (`RUN_WORKERS_IN_PROCESS=true`) so there is nothing extra to start.

**Why not microservices.** There is one store, one team, one database, and every interesting operation (order creation) spans products, inventory, discounts, payments and shipping in a single transaction. Splitting those into services would replace a transaction with a distributed saga — strictly more failure modes for no benefit. `CLAUDE.md` §58 forbids this, and the forbidding is correct.

**Why two processes rather than one.** A slow image resize or a stuck SMTP connection must not consume the event-loop capacity that serves checkout. Separating them also lets the two scale independently and lets a worker deploy be rolled back without touching the API. It costs nothing: same image, different command.

## 1.2 The four layers

```
   ┌──────────────────────────────────────────────────────┐
1. │ Interface        routes · middleware · controllers   │  HTTP shape, auth, validation
   ├──────────────────────────────────────────────────────┤
2. │ Domain           services · policies · state machines│  business rules — the valuable layer
   ├──────────────────────────────────────────────────────┤
3. │ Data             repositories · SQL                  │  persistence, no business rules
   ├──────────────────────────────────────────────────────┤
4. │ Infrastructure   db · queue · email · realtime · log │  technical capability, no business rules
   └──────────────────────────────────────────────────────┘
```

Hard rules, enforced by ESLint `no-restricted-imports` (§16.9):

- A controller never imports a repository. It calls a service.
- A repository never imports a service. It returns rows and takes parameters.
- Infrastructure never imports `features/`. Dependency arrows point one way, downward.
- No layer reads `process.env` except `config/` (§21).
- No SQL string is built by concatenation. Parameters are `$1`-style, always.

A controller's entire job is: take the already-validated input, call one service method, shape the response. If a controller has an `if` that is not about HTTP, the rule belongs in the service.

## 1.3 Where "not every operation needs every layer" applies

`CLAUDE.md` §4 is explicit that the full pipeline is not mandatory. Concretely:

- `GET /api/v1/storefront/categories` is route → controller → service → repository. No event, no job, no realtime. That is a complete, correct implementation.
- `POST /api/v1/storefront/orders` uses every mechanism, because every mechanism earns its place there.
- A pure calculation (order totals, discount evaluation) lives in a plain module with no database access at all (`features/pricing/`), which is what makes it exhaustively unit-testable.

Repositories exist for every feature that touches the database, because the alternative is SQL scattered through services and no seam for integration tests. They do not exist as empty pass-throughs for features that have no persistence.

---

# 2. Folder structure

```
server/
├── src/
│   ├── main/
│   │   ├── api.ts                  # HTTP + Socket.IO entrypoint
│   │   ├── worker.ts               # pg-boss workers + event dispatcher entrypoint
│   │   └── shutdown.ts             # shared graceful-shutdown orchestration
│   │
│   ├── app.ts                      # express app assembly (no listen) — importable by tests
│   ├── router.ts                   # mounts /api/v1/{auth,storefront,admin,webhooks}
│   │
│   ├── config/
│   │   ├── env.ts                  # zod-parsed process.env, the ONLY reader of it
│   │   ├── constants.ts
│   │   └── index.ts
│   │
│   ├── infrastructure/
│   │   ├── database/
│   │   │   ├── pool.ts             # pg.Pool, one per process
│   │   │   ├── transaction.ts      # withTransaction + AsyncLocalStorage propagation
│   │   │   ├── query.ts            # typed query helpers, slow-query logging
│   │   │   ├── errors.ts           # pg error code → AppError mapping
│   │   │   └── migrate/
│   │   │       ├── runner.ts       # applies .sql files in order, records in schema_migrations
│   │   │       └── cli.ts          # up | status | create <name>
│   │   ├── queue/
│   │   │   ├── boss.ts             # pg-boss client, start/stop
│   │   │   ├── queues.ts           # queue name registry + per-queue retry policy
│   │   │   ├── enqueue.ts          # typed enqueue<T>(queue, payload, opts)
│   │   │   └── register.ts         # worker registration table
│   │   ├── email/
│   │   │   ├── provider.ts         # EmailProvider interface
│   │   │   ├── providers/{smtp.ts,console.ts}
│   │   │   ├── renderer.ts         # mjml+handlebars → {html, text, subject}
│   │   │   └── templates/          # *.mjml + *.txt.hbs + props schema
│   │   ├── realtime/
│   │   │   ├── server.ts           # socket.io init, adapter seam
│   │   │   ├── auth.ts             # handshake JWT verification
│   │   │   ├── rooms.ts            # room-name builders + join authorization
│   │   │   ├── emitters.ts         # the ONLY place .emit() is called
│   │   │   └── events.ts           # realtime event name + payload contracts
│   │   ├── storage/
│   │   │   ├── provider.ts         # StorageProvider interface
│   │   │   └── providers/{supabase.ts,local.ts}
│   │   ├── cache/
│   │   │   └── memory.ts           # TTL map + explicit invalidation, per process
│   │   ├── logging/
│   │   │   ├── logger.ts           # pino root logger + redaction
│   │   │   └── context.ts          # AsyncLocalStorage: requestId, userId, jobId
│   │   └── observability/
│   │       ├── health.ts
│   │       └── metrics.ts          # optional, see §15.6
│   │
│   ├── shared/
│   │   ├── errors/                 # AppError hierarchy + error code enum
│   │   ├── http/
│   │   │   ├── respond.ts          # ok() / created() / paginated() envelope helpers
│   │   │   ├── asyncRoute.ts
│   │   │   └── pagination.ts       # offset + cursor parsing and meta building
│   │   ├── middleware/
│   │   │   ├── requestContext.ts   # request id, ALS binding
│   │   │   ├── authenticate.ts     # verifies access token → req.auth
│   │   │   ├── authorize.ts        # requirePermission / requireSelfOrPermission
│   │   │   ├── validate.ts         # zod for params/query/body
│   │   │   ├── idempotency.ts
│   │   │   ├── rateLimit.ts
│   │   │   ├── rawBody.ts          # webhook signature verification support
│   │   │   ├── notFound.ts
│   │   │   └── errorHandler.ts
│   │   ├── types/                  # Money, Cents, Paginated<T>, ISODate, branded ids
│   │   └── utils/                  # slug, money math, crypto, dates (store-tz aware)
│   │
│   ├── events/
│   │   ├── catalog.ts              # the event registry: name → zod payload schema
│   │   ├── publish.ts              # publish(event, tx) → writes to domain_events
│   │   ├── dispatcher.ts           # polls outbox, fans out, marks dispatched
│   │   └── subscribers/            # cross-feature reactions live here
│   │       ├── order.subscribers.ts
│   │       ├── payment.subscribers.ts
│   │       └── ...
│   │
│   ├── features/
│   │   ├── auth/
│   │   ├── users/
│   │   ├── customers/
│   │   ├── catalog/                # products + variants + categories + media
│   │   ├── inventory/
│   │   ├── carts/
│   │   ├── pricing/                # pure totals + tax + discount application
│   │   ├── orders/
│   │   ├── payments/
│   │   ├── shipping/
│   │   ├── discounts/
│   │   ├── notifications/
│   │   ├── analytics/
│   │   ├── settings/
│   │   └── audit/
│   │
│   └── jobs/
│       ├── email/                  # email.send
│       ├── notifications/          # notification.dispatch
│       ├── analytics/              # analytics.ingest, analytics.rollup
│       ├── inventory/              # inventory.release_expired, inventory.low_stock_scan
│       ├── media/                  # media.process_image
│       ├── reports/                # report.generate
│       └── cleanup/                # cleanup.sessions, cleanup.idempotency, cleanup.carts
│
├── migrations/                     # 0001_identity.sql, 0002_catalog.sql, …
├── seeds/                          # roles, permissions, store settings, dev fixtures
├── tests/
│   ├── setup/                      # testcontainers boot, migration, truncate helpers
│   ├── factories/                  # buildProduct(), buildOrder(), …
│   ├── integration/
│   └── e2e/
├── docs/                           # architecture.md, database.md, api.md, …
├── docker-compose.yml              # local postgres + mailhog
├── Dockerfile
├── .env.example
├── tsconfig.json
├── eslint.config.js
├── vitest.config.ts
└── package.json
```

## 2.1 Anatomy of a feature

Every feature follows the same internal shape, so any developer can open any feature and know where things are.

```
features/orders/
├── index.ts                  # PUBLIC SURFACE — the only file other features may import
├── orders.routes.ts          # storefront routes
├── orders.admin.routes.ts    # admin routes
├── orders.controller.ts
├── orders.service.ts         # orchestration + transaction boundary
├── orders.repository.ts      # SQL
├── orders.validators.ts      # zod schemas (request shapes)
├── orders.policy.ts          # "can this actor do this to this order?"
├── orders.state.ts           # state machines + allowed transitions
├── orders.mapper.ts          # row → DTO (controls exactly what leaves the server)
├── orders.events.ts          # event names + payload builders this feature emits
├── orders.types.ts
└── __tests__/
```

Not every feature needs every file. `settings/` has no state machine; `pricing/` has no repository or routes.

## 2.2 The public-surface rule

`features/orders/index.ts` exports a small, deliberate API:

```ts
export { ordersService } from './orders.service'
export type { Order, OrderSummary, OrderStatus } from './orders.types'
// nothing else — no repository, no SQL, no row types
```

ESLint forbids `features/*/` deep imports across feature boundaries:

```js
'no-restricted-imports': ['error', { patterns: [
  { group: ['**/features/*/!(index)*'], message: 'Import a feature only through its index.ts' },
  { group: ['**/features/**'],          message: 'infrastructure/ must not depend on features/' }
]}]
```

This is the single most important structural rule in the codebase. It is what makes the monolith modular rather than merely large: it makes an accidental cross-feature coupling a build failure instead of a code-review comment.

---

# 3. Feature boundaries

## 3.1 The map

| Feature | Owns | Explicitly does **not** own |
|---|---|---|
| `auth` | Credentials, sessions, tokens, verification/reset flows, login throttling | User profile data, roles catalogue |
| `users` | The `users` record, roles/permissions assignment, staff accounts, account status | Passwords and sessions (auth's), customer-specific data |
| `customers` | Customer profile, addresses, marketing consent, admin customer views | Identity and login (users'/auth's), orders |
| `catalog` | Products, variants, options, categories, product media, catalog search | Stock levels, prices *charged* (pricing's), order history |
| `inventory` | On-hand, reserved, availability, movement ledger, low-stock thresholds | Product definition, order lifecycle |
| `carts` | Cart lifecycle, cart lines, cart→order conversion handoff | Prices (asks pricing), stock (asks inventory), orders |
| `pricing` | Line totals, order totals, tax computation, discount *application*, rounding | Persistence — it is pure and stateless |
| `discounts` | Discount definitions, eligibility rules, redemption tracking and limits | Total arithmetic (pricing's) |
| `orders` | Order aggregate, order items, order lifecycle, cancellation, order history | Payment capture, shipment execution, stock arithmetic |
| `payments` | Payment records, provider abstraction, webhook ingestion, refund records | Order status (it *requests* a change via orders' public service) |
| `shipping` | Shipping zones/methods/rates, shipments, tracking, fulfillment state | Order totals, inventory arithmetic |
| `notifications` | In-app notifications, channel routing, preferences, dedupe | Email transport (infrastructure), socket transport (infrastructure) |
| `analytics` | Behavioural event store, rollups, metric definitions, dashboard queries | Any transactional write outside its own tables |
| `settings` | Single-row store configuration, currency, timezone, tax defaults | Anything else |
| `audit` | Append-only administrative audit trail | Application logs (infrastructure) |

## 3.2 How features talk to each other

Exactly three legal mechanisms:

**(a) Direct call through the public service — synchronous, when the caller needs the result now and it must be in the same transaction.**

```
orders.service  →  inventory.reserveForOrder(tx, lines)
                →  discounts.validateAndReserve(tx, code, context)
                →  pricing.calculate(...)   [pure]
```

**(b) Domain event — asynchronous, when the reaction is a consequence rather than a precondition.**

```
orders  ──publishes──▶  order.placed  ──▶  notifications · analytics · realtime · email
```

The order does not care who listens. Adding a new reaction never touches `orders/`.

**(c) Read-only query through the public service — when a feature needs another's data for display.**

Admin order detail needs the customer name: `orders.controller` asks `customers.getSummaries([ids])` in one batched call, not `SELECT … FROM users` inside `orders.repository`.

**Illegal:** a repository in feature A issuing SQL against feature B's tables. There is exactly one sanctioned exception, documented inline: the analytics rollup jobs read across all transactional tables. They are read-only, they run in the background, and reimplementing them through per-feature service calls would be N+1 by construction. That exception is confined to `features/analytics/analytics.rollup.repository.ts` and nowhere else.

## 3.3 Dependency direction

```
        auth ──▶ users ──▶ customers
                              │
   catalog ──▶ inventory      │
      │            ▲          │
      │            │          ▼
      └──▶ carts ──┴──▶ orders ──▶ payments
                    │       │  └──▶ shipping
              pricing◀──────┤
             discounts◀─────┘

   notifications · analytics · audit · realtime
      ▲ subscribe to events from everything, depend on nothing
```

No cycles. `notifications`, `analytics` and `audit` are pure consumers — nothing calls into them synchronously except through events or a single explicit write helper (`audit.record(...)`). That is deliberate: it means those three can never break checkout.

---

# 4. PostgreSQL database architecture

## 4.1 Principles

1. **The database enforces what the database can enforce.** Foreign keys, `NOT NULL`, `CHECK`, `UNIQUE` and partial indexes come first; application validation is a better error message on top of them, never the only guard.
2. **Money is integer minor units.** `integer`/`bigint` cents, never `float`, never `numeric` for stored amounts (a `numeric` is fine for intermediate SQL aggregation). All arithmetic in TypeScript is on integers. A `Cents` branded type prevents mixing with quantities.
3. **Historical rows are immutable snapshots.** Order items copy title, SKU, unit price at write time. Changing a product tomorrow must not rewrite yesterday's invoice.
4. **Deletion is archival.** Anything an order can reference gets `archived_at`, never `DELETE`. Genuine deletes are limited to rows nothing depends on (a cart line, an unconsumed token).
5. **Status columns are `text` + `CHECK`, not Postgres `enum`.** Adding a value to a PG enum requires `ALTER TYPE` and values can never be removed; a `CHECK` constraint is edited in a normal migration. TypeScript union types mirror each `CHECK` list, and one test asserts the two agree.
6. **Every table that represents a thing has `created_at timestamptz NOT NULL DEFAULT now()`;** mutable ones also have `updated_at`, maintained by a shared trigger. Pure junction tables (`role_permissions`, `product_categories`, `variant_option_values`, `discount_products`, `discount_categories`, `shipment_items`) and rollup tables carry neither — the association's timestamp belongs to one of its sides, and a rollup's timestamp is `computed_at`.
7. **UUIDv7 primary keys** (`uuid`, generated in the application) for anything exposed in a URL, so ids are unguessable but still index-ordered by time. High-volume append-only tables (`domain_events`, `analytics_events`, `inventory_movements`, `audit_logs`) use `bigserial` — they are never exposed and benefit from the smaller index.
8. **Timestamps are `timestamptz`, stored UTC.** All *business date* bucketing (daily sales, "orders today") converts to the store timezone from `store_settings` first. This is a real source of wrong dashboards and is handled once, in one helper.

## 4.2 Supabase-specific constraints

Supabase-hosted Postgres has three properties that change decisions:

- **Connection pooling.** The transaction-mode pooler (port 6543) does not support session-level state — session advisory locks, `LISTEN/NOTIFY`, and long-lived prepared statements. The **API process connects through the transaction pooler**; the **worker process connects on the direct/session connection (port 5432)** because pg-boss uses maintenance advisory locks. Two env vars, `DATABASE_URL` and `DATABASE_DIRECT_URL`, make this explicit rather than accidental.
- **Row Level Security.** Only the server touches this database, using the service role, which bypasses RLS. RLS is therefore *not* our authorization mechanism — §6 is. But we still `ALTER TABLE … ENABLE ROW LEVEL SECURITY` on every table and add no permissive policies, so that if a Supabase anon/publishable key ever leaks or PostgREST is exposed, it reads nothing. Defence in depth, one line per table.
- **Extensions.** `pgcrypto` (`gen_random_uuid`) and `citext` are available and used. We avoid `ltree`; category trees use recursive CTEs with a depth cap.

## 4.3 Schema organisation

One `public` schema for application tables; pg-boss owns its own `pgboss` schema. Tables are grouped by feature in the migration files, and the naming convention is plural snake_case with the feature prefix where ambiguity is possible (`order_items`, `inventory_movements`, `analytics_daily_sales`).

## 4.4 Migrations

Plain, numbered, forward-only SQL files applied by a 120-line runner:

Numbering follows **build order**, not topic order, so migrations are always applied in the sequence they were written and no phase ever applies a file numbered below one already applied:

```
migrations/                                    introduced in
├── 0001_extensions_and_helpers.sql            Phase 0
├── 0002_events_and_idempotency.sql            Phase 1
├── 0003_email.sql                             Phase 1
├── 0004_identity_and_access.sql               Phase 2
├── 0005_audit.sql                             Phase 2
├── 0006_settings_and_media.sql                Phase 3
├── 0007_catalog.sql                           Phase 4
├── 0008_inventory.sql                         Phase 4b
├── 0009_carts.sql                             Phase 5
├── 0010_orders.sql                            Phase 6
├── 0011_payments.sql                          Phase 7
├── 0012_shipping.sql                          Phase 8
├── 0013_discounts.sql                         Phase 9
├── 0014_notifications.sql                     Phase 10
└── 0015_analytics.sql                         Phase 11
```

Section 5 below groups the DDL by topic for readability; the file a given table is created in is the one above.

- The runner records each applied file with its SHA-256 in `schema_migrations`. If a previously applied file's checksum changes, it refuses to run. Editing an applied migration is the most common way a team's environments silently diverge.
- Each file runs inside a transaction, except those declaring `-- pgm:no-transaction` (needed for `CREATE INDEX CONCURRENTLY`).
- **No down migrations.** A mistake is corrected by a new forward migration. Down migrations are almost never exercised and give false confidence.
- Destructive changes use expand → migrate → contract across separate deploys: add the new column, backfill in a job, switch reads, then drop the old column in a later release.
- New indexes on tables with meaningful data use `CREATE INDEX CONCURRENTLY`.

---

# 5. Database entities and relationships

## 5.1 Entity relationship overview

```
users ──1:1── customer_profiles
  │  └──*── addresses
  │  └──*── sessions
  │  └──*── user_roles ──*── roles ──*── role_permissions ──*── permissions
  │
  └──*── orders ──*── order_items ──?── product_variants
           │  └──*── order_addresses
           │  └──*── order_status_history
           │  └──*── order_discounts ──?── discounts
           │  └──*── payments ──*── refunds
           │  └──*── shipments ──*── shipment_items ──*── order_items
           │
categories ──*── product_categories ──*── products ──*── product_variants ──1:1── inventory_items
                                          │                     │                      │
                                          └──*── product_images  └──*── inventory_movements
                                          └──*── product_options ──*── product_option_values
                                                                            │
                                                        variant_option_values┘
carts ──*── cart_items ──?── product_variants
discounts ──*── discount_redemptions ──?── orders
```

## 5.2 Identity and access

```sql
CREATE TABLE users (
  id              uuid PRIMARY KEY,
  email           citext NOT NULL UNIQUE,
  password_hash   text,                       -- NULL only for future SSO/guest-upgrade
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','disabled','locked')),
  email_verified_at timestamptz,
  first_name      text,
  last_name       text,
  phone           text,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  id    smallserial PRIMARY KEY,
  key   text NOT NULL UNIQUE CHECK (key IN ('owner','admin','staff','customer')),
  name  text NOT NULL
);

CREATE TABLE permissions (
  id    smallserial PRIMARY KEY,
  key   text NOT NULL UNIQUE,                 -- 'orders:write', 'inventory:adjust', …
  description text NOT NULL
);

CREATE TABLE role_permissions (
  role_id       smallint NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id smallint NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id smallint NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  granted_by uuid REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

-- one row per refresh token issued; rotation creates a new row in the same family
CREATE TABLE sessions (
  id                 uuid PRIMARY KEY,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id          uuid NOT NULL,           -- constant across a rotation chain
  refresh_token_hash bytea NOT NULL UNIQUE,   -- sha256 of the opaque token
  parent_id          uuid REFERENCES sessions(id) ON DELETE SET NULL,
  user_agent         text,
  ip                 inet,
  expires_at         timestamptz NOT NULL,
  used_at            timestamptz,             -- set when rotated; reuse after this = theft
  revoked_at         timestamptz,
  revoked_reason     text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX ON sessions (family_id);
CREATE INDEX ON sessions (expires_at);

CREATE TABLE auth_tokens (                    -- email verification + password reset
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    text NOT NULL CHECK (purpose IN ('email_verify','password_reset','email_change')),
  token_hash bytea NOT NULL UNIQUE,
  new_email  citext,                          -- for email_change only
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON auth_tokens (user_id, purpose) WHERE consumed_at IS NULL;

CREATE TABLE login_attempts (
  id         bigserial PRIMARY KEY,
  email      citext,
  ip         inet,
  success    boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON login_attempts (email, created_at DESC);
CREATE INDEX ON login_attempts (ip, created_at DESC);
```

**Why one `users` table for staff and customers.** `CLAUDE.md` §10 requires centralised authentication and forbids duplicating auth logic. Two identity tables means two login flows, two token verifiers, two password-reset flows — the exact duplication being forbidden. Instead: one identity, roles decide capability, and customer-specific data lives in a separate profile table.

```sql
CREATE TABLE customer_profiles (
  user_id           uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  accepts_marketing boolean NOT NULL DEFAULT false,
  marketing_consent_at timestamptz,
  default_shipping_address_id uuid,
  default_billing_address_id  uuid,
  admin_note        text,
  tags              text[] NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE addresses (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label         text,
  first_name    text NOT NULL,
  last_name     text NOT NULL,
  company       text,
  line1         text NOT NULL,
  line2         text,
  city          text NOT NULL,
  region        text,
  postal_code   text,
  country_code  char(2) NOT NULL,
  phone         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz
);
CREATE INDEX ON addresses (user_id) WHERE archived_at IS NULL;
```

Addresses are archived rather than deleted, and orders never point at them — orders snapshot the address into `order_addresses` (§5.6). Editing a saved address must not rewrite where last month's parcel went.

## 5.3 Settings and media

```sql
CREATE TABLE store_settings (
  id                       smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  store_name               text NOT NULL,
  contact_email            citext NOT NULL,
  support_phone            text,
  currency                 char(3) NOT NULL DEFAULT 'USD',
  timezone                 text NOT NULL DEFAULT 'UTC',
  weight_unit              text NOT NULL DEFAULT 'g' CHECK (weight_unit IN ('g','kg','lb','oz')),
  tax_rate_bps             integer NOT NULL DEFAULT 0 CHECK (tax_rate_bps BETWEEN 0 AND 10000),
  prices_include_tax       boolean NOT NULL DEFAULT false,
  default_low_stock_threshold integer NOT NULL DEFAULT 5,
  order_number_prefix      text NOT NULL DEFAULT '#',
  reservation_ttl_minutes  integer NOT NULL DEFAULT 60,
  guest_checkout_enabled   boolean NOT NULL DEFAULT true,
  metadata                 jsonb NOT NULL DEFAULT '{}',
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               uuid REFERENCES users(id)
);

CREATE TABLE media_assets (
  id           uuid PRIMARY KEY,
  storage_key  text NOT NULL UNIQUE,
  url          text NOT NULL,
  mime_type    text NOT NULL,
  byte_size    integer NOT NULL,
  width        integer,
  height       integer,
  checksum     text,
  variants     jsonb NOT NULL DEFAULT '{}',   -- {"thumb": "...", "medium": "..."}
  uploaded_by  uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
```

`tax_rate_bps` is basis points (integer) so tax is integer arithmetic end to end. `reservation_ttl_minutes` drives the inventory release job (§8.4).

## 5.4 Catalog

```sql
CREATE TABLE categories (
  id          uuid PRIMARY KEY,
  parent_id   uuid REFERENCES categories(id) ON DELETE RESTRICT,
  name        text NOT NULL,
  slug        citext NOT NULL UNIQUE,
  description text,
  image_id    uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  position    integer NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX ON categories (parent_id, position) WHERE archived_at IS NULL;

CREATE TABLE products (
  id                  uuid PRIMARY KEY,
  title               text NOT NULL,
  slug                citext NOT NULL UNIQUE,
  description         text,
  status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','active','archived')),
  primary_category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  vendor              text,
  product_type        text,
  tags                text[] NOT NULL DEFAULT '{}',
  seo_title           text,
  seo_description     text,
  published_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  archived_at         timestamptz,
  search_vector       tsvector GENERATED ALWAYS AS (
                        setweight(to_tsvector('simple', coalesce(title,'')), 'A') ||
                        setweight(to_tsvector('simple', coalesce(product_type,'')), 'B') ||
                        setweight(to_tsvector('simple', coalesce(description,'')), 'C')
                      ) STORED
);
CREATE INDEX ON products USING gin (search_vector);
CREATE INDEX ON products USING gin (tags);
CREATE INDEX ON products (status, published_at DESC) WHERE archived_at IS NULL;

CREATE TABLE product_categories (
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, category_id)
);
CREATE INDEX ON product_categories (category_id);

CREATE TABLE product_variants (
  id                     uuid PRIMARY KEY,
  product_id             uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku                    citext UNIQUE,
  title                  text NOT NULL DEFAULT 'Default',
  price_cents            integer NOT NULL CHECK (price_cents >= 0),
  compare_at_price_cents integer CHECK (compare_at_price_cents >= 0),
  cost_cents             integer CHECK (cost_cents >= 0),
  barcode                text,
  weight_grams           integer NOT NULL DEFAULT 0 CHECK (weight_grams >= 0),
  requires_shipping      boolean NOT NULL DEFAULT true,
  position               integer NOT NULL DEFAULT 0,
  image_id               uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  is_active              boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  archived_at            timestamptz
);
CREATE INDEX ON product_variants (product_id, position) WHERE archived_at IS NULL;

CREATE TABLE product_options (              -- "Size", "Colour"
  id         uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name       text NOT NULL,
  position   integer NOT NULL DEFAULT 0,
  UNIQUE (product_id, name)
);

CREATE TABLE product_option_values (        -- "M", "Red"
  id        uuid PRIMARY KEY,
  option_id uuid NOT NULL REFERENCES product_options(id) ON DELETE CASCADE,
  value     text NOT NULL,
  position  integer NOT NULL DEFAULT 0,
  UNIQUE (option_id, value)
);

CREATE TABLE variant_option_values (
  variant_id      uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  option_value_id uuid NOT NULL REFERENCES product_option_values(id) ON DELETE CASCADE,
  PRIMARY KEY (variant_id, option_value_id)
);

CREATE TABLE product_images (
  id         uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  media_id   uuid NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  alt        text,
  position   integer NOT NULL DEFAULT 0,
  UNIQUE (product_id, media_id)
);
```

Price and SKU live on the **variant**, not the product. Every product has at least one variant (titled `Default`) created automatically. See decision **D-1** in §25 — this is the schema decision most expensive to reverse later, because `order_items`, `cart_items` and `inventory_items` all key on `variant_id`.

## 5.5 Inventory

```sql
CREATE TABLE inventory_items (
  variant_id          uuid PRIMARY KEY REFERENCES product_variants(id) ON DELETE CASCADE,
  on_hand             integer NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved            integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  available           integer GENERATED ALWAYS AS (on_hand - reserved) STORED,
  low_stock_threshold integer NOT NULL DEFAULT 5 CHECK (low_stock_threshold >= 0),
  track_inventory     boolean NOT NULL DEFAULT true,
  allow_backorder     boolean NOT NULL DEFAULT false,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reserved_within_on_hand CHECK (reserved <= on_hand)
);
CREATE INDEX ON inventory_items (available) WHERE track_inventory;

CREATE TABLE inventory_movements (
  id             bigserial PRIMARY KEY,
  variant_id     uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  delta_on_hand  integer NOT NULL DEFAULT 0,
  delta_reserved integer NOT NULL DEFAULT 0,
  reason         text NOT NULL CHECK (reason IN (
                   'restock','manual_adjustment','reservation','reservation_release',
                   'fulfillment','cancellation','return','damage','correction')),
  reference_type text CHECK (reference_type IN ('order','shipment','return','manual')),
  reference_id   uuid,
  actor_user_id  uuid REFERENCES users(id),
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (delta_on_hand <> 0 OR delta_reserved <> 0)
);
CREATE INDEX ON inventory_movements (variant_id, created_at DESC);
CREATE INDEX ON inventory_movements (reference_type, reference_id);
```

`available` is a stored generated column, so "what is in stock" is a plain indexed read, and `reserved_within_on_hand` makes over-reservation impossible at the storage layer even if a service has a bug. `inventory_movements` is an append-only ledger: the sum of its deltas per variant must equal the `inventory_items` row, and a nightly reconciliation job asserts exactly that (§8.4).

## 5.6 Orders

```sql
CREATE SEQUENCE order_number_seq START 1001;

CREATE TABLE orders (
  id                   uuid PRIMARY KEY,
  order_number         text NOT NULL UNIQUE,
  customer_id          uuid REFERENCES users(id) ON DELETE SET NULL,   -- NULL = guest
  email                citext NOT NULL,
  phone                text,
  status               text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','confirmed','processing',
                                           'completed','cancelled')),
  payment_status       text NOT NULL DEFAULT 'pending'
                         CHECK (payment_status IN ('pending','authorized','paid',
                                'partially_refunded','refunded','failed','cancelled')),
  fulfillment_status   text NOT NULL DEFAULT 'unfulfilled'
                         CHECK (fulfillment_status IN ('unfulfilled','partially_fulfilled',
                                'fulfilled','delivered','returned')),
  currency             char(3) NOT NULL,
  subtotal_cents       integer NOT NULL CHECK (subtotal_cents >= 0),
  discount_total_cents integer NOT NULL DEFAULT 0 CHECK (discount_total_cents >= 0),
  tax_total_cents      integer NOT NULL DEFAULT 0 CHECK (tax_total_cents >= 0),
  shipping_total_cents integer NOT NULL DEFAULT 0 CHECK (shipping_total_cents >= 0),
  total_cents          integer NOT NULL CHECK (total_cents >= 0),
  refunded_total_cents integer NOT NULL DEFAULT 0 CHECK (refunded_total_cents >= 0),
  shipping_method_id   uuid REFERENCES shipping_methods(id) ON DELETE SET NULL,
  shipping_method_name text,
  customer_note        text,
  admin_note           text,
  cancel_reason        text,
  source               text NOT NULL DEFAULT 'storefront'
                         CHECK (source IN ('storefront','admin')),
  placed_at            timestamptz NOT NULL DEFAULT now(),
  confirmed_at         timestamptz,
  cancelled_at         timestamptz,
  completed_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT total_is_consistent CHECK (
    total_cents = subtotal_cents - discount_total_cents + tax_total_cents + shipping_total_cents
  ),
  CONSTRAINT refund_within_total CHECK (refunded_total_cents <= total_cents)
);
CREATE INDEX ON orders (customer_id, placed_at DESC);
CREATE INDEX ON orders (status, placed_at DESC);
CREATE INDEX ON orders (payment_status) WHERE payment_status = 'pending';
CREATE INDEX ON orders (fulfillment_status) WHERE fulfillment_status <> 'fulfilled';
CREATE INDEX ON orders (placed_at DESC);
CREATE INDEX ON orders (email);

CREATE TABLE order_items (
  id                   uuid PRIMARY KEY,
  order_id             uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  variant_id           uuid REFERENCES product_variants(id) ON DELETE SET NULL,
  product_id           uuid REFERENCES products(id) ON DELETE SET NULL,
  -- immutable snapshot, never re-read from catalog:
  product_title        text NOT NULL,
  variant_title        text NOT NULL,
  sku                  text,
  image_url            text,
  unit_price_cents     integer NOT NULL CHECK (unit_price_cents >= 0),
  quantity             integer NOT NULL CHECK (quantity > 0),
  subtotal_cents       integer NOT NULL CHECK (subtotal_cents >= 0),
  discount_cents       integer NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  tax_cents            integer NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  total_cents          integer NOT NULL CHECK (total_cents >= 0),
  requires_shipping    boolean NOT NULL DEFAULT true,
  weight_grams         integer NOT NULL DEFAULT 0,
  fulfilled_quantity   integer NOT NULL DEFAULT 0 CHECK (fulfilled_quantity >= 0),
  refunded_quantity    integer NOT NULL DEFAULT 0 CHECK (refunded_quantity >= 0),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (fulfilled_quantity <= quantity),
  CHECK (refunded_quantity <= quantity)
);
CREATE INDEX ON order_items (order_id);
CREATE INDEX ON order_items (variant_id);

CREATE TABLE order_addresses (
  id           uuid PRIMARY KEY,
  order_id     uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  type         text NOT NULL CHECK (type IN ('shipping','billing')),
  first_name   text NOT NULL,
  last_name    text NOT NULL,
  company      text,
  line1        text NOT NULL,
  line2        text,
  city         text NOT NULL,
  region       text,
  postal_code  text,
  country_code char(2) NOT NULL,
  phone        text,
  UNIQUE (order_id, type)
);

CREATE TABLE order_status_history (
  id            bigserial PRIMARY KEY,
  order_id      uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  field         text NOT NULL CHECK (field IN ('status','payment_status','fulfillment_status')),
  from_value    text,
  to_value      text NOT NULL,
  actor_user_id uuid REFERENCES users(id),
  actor_type    text NOT NULL CHECK (actor_type IN ('customer','staff','system','webhook')),
  reason        text,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON order_status_history (order_id, created_at);

CREATE TABLE order_discounts (
  id             uuid PRIMARY KEY,
  order_id       uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  discount_id    uuid REFERENCES discounts(id) ON DELETE SET NULL,
  code           text NOT NULL,      -- snapshot
  type           text NOT NULL,      -- snapshot
  value          integer NOT NULL,   -- snapshot (bps or cents)
  amount_cents   integer NOT NULL CHECK (amount_cents >= 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);
```

**Three orthogonal status fields, not one.** `CLAUDE.md` §17 lists a single flat status vocabulary. Collapsing lifecycle, payment and fulfillment into one column produces states that cannot be expressed (paid but unshipped; shipped but partially refunded) and forces invalid transitions to be legal. Three independent, individually validated machines model reality; a derived display status maps back to the vocabulary in §17 for the UI. Flagged as decision **D-2** in §25.

Derived display status (computed, never stored):

| Conditions | Displayed as |
|---|---|
| `status='cancelled'` | cancelled |
| `fulfillment_status='returned'` | returned |
| `fulfillment_status='delivered'` | delivered |
| `fulfillment_status IN ('fulfilled','partially_fulfilled')` | shipped |
| `status='processing'` and all items picked | ready_to_ship |
| `status='processing'` | processing |
| `payment_status IN ('paid','authorized')` | confirmed |
| otherwise | pending |

## 5.7 Payments

```sql
CREATE TABLE payments (
  id                  uuid PRIMARY KEY,
  order_id            uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  provider            text NOT NULL,                    -- 'manual' in v1
  provider_payment_id text,
  method              text NOT NULL CHECK (method IN ('manual','cod','bank_transfer','card')),
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','authorized','paid','failed',
                                          'cancelled','refunded','partially_refunded')),
  amount_cents        integer NOT NULL CHECK (amount_cents > 0),
  currency            char(3) NOT NULL,
  refunded_cents      integer NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  failure_code        text,
  failure_message     text,
  idempotency_key     text,
  metadata            jsonb NOT NULL DEFAULT '{}',
  authorized_at       timestamptz,
  captured_at         timestamptz,
  failed_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (refunded_cents <= amount_cents)
);
CREATE UNIQUE INDEX ON payments (provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;
CREATE UNIQUE INDEX ON payments (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX ON payments (order_id);

CREATE TABLE refunds (
  id                 uuid PRIMARY KEY,
  payment_id         uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  order_id           uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  provider_refund_id text,
  amount_cents       integer NOT NULL CHECK (amount_cents > 0),
  reason             text,
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','succeeded','failed')),
  restock            boolean NOT NULL DEFAULT false,
  created_by         uuid REFERENCES users(id),
  idempotency_key    text UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON refunds (order_id);

-- every inbound provider callback, deduplicated at the storage layer
CREATE TABLE webhook_events (
  id                 bigserial PRIMARY KEY,
  provider           text NOT NULL,
  provider_event_id  text NOT NULL,
  event_type         text NOT NULL,
  payload            jsonb NOT NULL,
  signature_verified boolean NOT NULL DEFAULT false,
  received_at        timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz,
  attempts           integer NOT NULL DEFAULT 0,
  last_error         text,
  UNIQUE (provider, provider_event_id)
);
CREATE INDEX ON webhook_events (processed_at) WHERE processed_at IS NULL;
```

The `UNIQUE (provider, provider_event_id)` constraint is the entire duplicate-webhook defence: a second delivery of the same event fails the insert and returns `200 OK` without reprocessing. That is one line of DDL doing what would otherwise be fragile application logic.

## 5.8 Shipping

> **Migration ordering note.** Three foreign keys point at tables created in a later migration. In each case the column is created without the constraint, and the later migration adds it with `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY`. The DDL in this section shows the *final* shape, not the literal file contents.
>
> | Column | Created in | Constraint added in |
> |---|---|---|
> | `carts.converted_order_id → orders` | `0009_carts.sql` | `0010_orders.sql` |
> | `orders.shipping_method_id → shipping_methods` | `0010_orders.sql` | `0012_shipping.sql` |
> | `order_discounts.discount_id → discounts` | `0010_orders.sql` | `0013_discounts.sql` |

```sql
CREATE TABLE shipping_zones (
  id            uuid PRIMARY KEY,
  name          text NOT NULL,
  country_codes char(2)[] NOT NULL,
  position      integer NOT NULL DEFAULT 0,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shipping_methods (
  id                       uuid PRIMARY KEY,
  zone_id                  uuid NOT NULL REFERENCES shipping_zones(id) ON DELETE CASCADE,
  name                     text NOT NULL,
  description              text,
  rate_type                text NOT NULL CHECK (rate_type IN ('flat','free','weight_based')),
  price_cents              integer NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  free_over_subtotal_cents integer CHECK (free_over_subtotal_cents >= 0),
  min_weight_grams         integer,
  max_weight_grams         integer,
  estimated_days_min       integer,
  estimated_days_max       integer,
  position                 integer NOT NULL DEFAULT 0,
  is_active                boolean NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  archived_at              timestamptz
);

CREATE TABLE shipments (
  id              uuid PRIMARY KEY,
  order_id        uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','shipped','in_transit',
                                      'delivered','returned','failed')),
  carrier         text,
  service         text,
  tracking_number text,
  tracking_url    text,
  shipped_at      timestamptz,
  delivered_at    timestamptz,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON shipments (order_id);
CREATE INDEX ON shipments (status) WHERE status NOT IN ('delivered','returned');
CREATE INDEX ON shipments (tracking_number);

CREATE TABLE shipment_items (
  shipment_id   uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  order_item_id uuid NOT NULL REFERENCES order_items(id) ON DELETE RESTRICT,
  quantity      integer NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (shipment_id, order_item_id)
);
```

## 5.9 Discounts

```sql
CREATE TABLE discounts (
  id                       uuid PRIMARY KEY,
  code                     citext NOT NULL UNIQUE,
  title                    text NOT NULL,
  type                     text NOT NULL
                             CHECK (type IN ('percentage','fixed_amount','free_shipping')),
  value                    integer NOT NULL CHECK (value >= 0),  -- bps if %, cents if fixed
  applies_to               text NOT NULL DEFAULT 'order'
                             CHECK (applies_to IN ('order','products','categories')),
  min_subtotal_cents       integer NOT NULL DEFAULT 0 CHECK (min_subtotal_cents >= 0),
  starts_at                timestamptz,
  ends_at                  timestamptz,
  usage_limit_total        integer CHECK (usage_limit_total > 0),
  usage_limit_per_customer integer CHECK (usage_limit_per_customer > 0),
  usage_count              integer NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  requires_customer        boolean NOT NULL DEFAULT false,
  is_active                boolean NOT NULL DEFAULT true,
  created_by               uuid REFERENCES users(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  archived_at              timestamptz,
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at),
  CHECK (type <> 'percentage' OR value <= 10000)
);

CREATE TABLE discount_products (
  discount_id uuid NOT NULL REFERENCES discounts(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY (discount_id, product_id)
);

CREATE TABLE discount_categories (
  discount_id uuid NOT NULL REFERENCES discounts(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (discount_id, category_id)
);

CREATE TABLE discount_redemptions (
  id           uuid PRIMARY KEY,
  discount_id  uuid NOT NULL REFERENCES discounts(id) ON DELETE RESTRICT,
  order_id     uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  customer_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (discount_id, order_id)
);
CREATE INDEX ON discount_redemptions (discount_id, customer_id);
```

`usage_count` is a denormalised counter incremented under the row lock taken during redemption; `discount_redemptions` is the ledger it must agree with. Per-customer limits are counted from the ledger, which is why it carries `customer_id`.

## 5.10 Events, idempotency, audit

```sql
-- Event log AND transactional outbox. Written inside the business transaction.
CREATE TABLE domain_events (
  id             bigserial PRIMARY KEY,
  event_id       uuid NOT NULL UNIQUE,
  name           text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id   uuid,
  payload        jsonb NOT NULL,
  actor_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  request_id     text,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  dispatched_at  timestamptz,
  attempts       integer NOT NULL DEFAULT 0,
  last_error     text
);
CREATE INDEX ON domain_events (id) WHERE dispatched_at IS NULL;
CREATE INDEX ON domain_events (aggregate_type, aggregate_id, occurred_at DESC);
CREATE INDEX ON domain_events (name, occurred_at DESC);

CREATE TABLE idempotency_keys (
  id              bigserial PRIMARY KEY,
  key             text NOT NULL,
  scope           text NOT NULL,           -- 'POST /storefront/orders'
  actor_key       text NOT NULL,           -- user id, or hashed ip for guests
  request_hash    text NOT NULL,           -- sha256 of the canonical request body
  status          text NOT NULL DEFAULT 'in_progress'
                    CHECK (status IN ('in_progress','completed','failed')),
  response_status integer,
  response_body   jsonb,
  locked_at       timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  expires_at      timestamptz NOT NULL,
  UNIQUE (key, scope, actor_key)
);
CREATE INDEX ON idempotency_keys (expires_at);

CREATE TABLE audit_logs (
  id             bigserial PRIMARY KEY,
  actor_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_email    citext,                   -- snapshot, survives user deletion
  actor_ip       inet,
  action         text NOT NULL,            -- 'order.status_changed'
  resource_type  text NOT NULL,
  resource_id    text,
  before         jsonb,
  after          jsonb,
  request_id     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_logs (resource_type, resource_id, created_at DESC);
CREATE INDEX ON audit_logs (actor_user_id, created_at DESC);
CREATE INDEX ON audit_logs (created_at DESC);
```

## 5.11 Carts, notifications, email, analytics

```sql
CREATE TABLE carts (
  id                uuid PRIMARY KEY,
  customer_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  anonymous_token_hash bytea UNIQUE,       -- guests; hashed, never the raw token
  status            text NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','converted','abandoned')),
  currency          char(3) NOT NULL,
  converted_order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  last_activity_at  timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (customer_id IS NOT NULL OR anonymous_token_hash IS NOT NULL)
);
CREATE UNIQUE INDEX ON carts (customer_id) WHERE status = 'active' AND customer_id IS NOT NULL;
CREATE INDEX ON carts (expires_at) WHERE status = 'active';

CREATE TABLE cart_items (
  id         uuid PRIMARY KEY,
  cart_id    uuid NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  quantity   integer NOT NULL CHECK (quantity > 0 AND quantity <= 999),
  added_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cart_id, variant_id)
);

CREATE TABLE notifications (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  audience   text NOT NULL CHECK (audience IN ('customer','staff')),
  type       text NOT NULL,
  title      text NOT NULL,
  body       text NOT NULL,
  data       jsonb NOT NULL DEFAULT '{}',
  dedupe_key text UNIQUE,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON notifications (user_id, created_at DESC);
CREATE INDEX ON notifications (user_id) WHERE read_at IS NULL;

CREATE TABLE notification_preferences (
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type     text NOT NULL,
  channel  text NOT NULL CHECK (channel IN ('in_app','email','realtime')),
  enabled  boolean NOT NULL DEFAULT true,
  PRIMARY KEY (user_id, type, channel)
);

CREATE TABLE email_messages (
  id                  uuid PRIMARY KEY,
  to_email            citext NOT NULL,
  template            text NOT NULL,
  subject             text NOT NULL,
  payload             jsonb NOT NULL,       -- template props, no secrets
  category            text NOT NULL DEFAULT 'transactional'
                        CHECK (category IN ('transactional','marketing')),
  status              text NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','sent','failed','suppressed')),
  provider_message_id text,
  attempts            integer NOT NULL DEFAULT 0,
  last_error          text,
  dedupe_key          text UNIQUE,
  sent_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON email_messages (to_email, created_at DESC);
CREATE INDEX ON email_messages (status) WHERE status = 'failed';

CREATE TABLE email_suppressions (
  email      citext PRIMARY KEY,
  reason     text NOT NULL CHECK (reason IN ('bounce','complaint','unsubscribe','manual')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- behavioural events (storefront), append-only
CREATE TABLE analytics_events (
  id           bigserial PRIMARY KEY,
  name         text NOT NULL,
  occurred_at  timestamptz NOT NULL,
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  anonymous_id uuid,
  session_id   uuid,
  properties   jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON analytics_events (name, occurred_at DESC);
CREATE INDEX ON analytics_events (occurred_at DESC);

-- rollups, keyed by store-local date
CREATE TABLE analytics_daily_sales (
  date                  date PRIMARY KEY,
  orders_count          integer NOT NULL DEFAULT 0,
  cancelled_count       integer NOT NULL DEFAULT 0,
  units_sold            integer NOT NULL DEFAULT 0,
  gross_sales_cents     bigint  NOT NULL DEFAULT 0,
  discounts_cents       bigint  NOT NULL DEFAULT 0,
  refunds_cents         bigint  NOT NULL DEFAULT 0,
  net_sales_cents       bigint  NOT NULL DEFAULT 0,
  tax_cents             bigint  NOT NULL DEFAULT 0,
  shipping_cents        bigint  NOT NULL DEFAULT 0,
  total_cents           bigint  NOT NULL DEFAULT 0,
  aov_cents             integer NOT NULL DEFAULT 0,
  new_customers         integer NOT NULL DEFAULT 0,
  returning_customers   integer NOT NULL DEFAULT 0,
  computed_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE analytics_product_daily (
  date              date NOT NULL,
  variant_id        uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  product_id        uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  units_sold        integer NOT NULL DEFAULT 0,
  gross_sales_cents bigint  NOT NULL DEFAULT 0,
  discounts_cents   bigint  NOT NULL DEFAULT 0,
  refunds_cents     bigint  NOT NULL DEFAULT 0,
  net_sales_cents   bigint  NOT NULL DEFAULT 0,
  orders_count      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (date, variant_id)
);
CREATE INDEX ON analytics_product_daily (date, net_sales_cents DESC);
CREATE INDEX ON analytics_product_daily (product_id, date);
```

## 5.12 Indexing summary

Beyond the primary and foreign keys, the indexes that exist because of a known query:

| Index | Serves |
|---|---|
| `products USING gin(search_vector)` | storefront + admin product search |
| `products (status, published_at DESC) WHERE archived_at IS NULL` | storefront listing |
| `product_categories (category_id)` | category browse |
| `inventory_items (available) WHERE track_inventory` | low-stock and out-of-stock reports |
| `orders (customer_id, placed_at DESC)` | customer order history |
| `orders (status, placed_at DESC)` | admin order table default view |
| `orders (payment_status) WHERE payment_status='pending'` | "awaiting payment" queue |
| `orders (fulfillment_status) WHERE <> 'fulfilled'` | "awaiting shipment" queue |
| `domain_events (id) WHERE dispatched_at IS NULL` | outbox dispatcher poll — stays tiny |
| `webhook_events (processed_at) WHERE processed_at IS NULL` | webhook retry sweep |
| `analytics_product_daily (date, net_sales_cents DESC)` | best-sellers |
| `sessions (user_id) WHERE revoked_at IS NULL` | active-session list, bulk revoke |

Partial indexes are used deliberately: the outbox index covers only undispatched rows, so it stays a handful of pages no matter how large the event log grows.

---

# 6. Authentication and authorization

## 6.1 The two questions, kept separate

```
Authentication  →  "who is this?"       →  shared/middleware/authenticate.ts  →  req.auth
Authorization   →  "may they do this?"  →  shared/middleware/authorize.ts + feature policies
```

`authenticate` never consults roles. `authorize` never parses tokens. Both live in `shared/`, are written once, and are used identically by every feature — satisfying `CLAUDE.md` §10's requirement that authentication not be duplicated across features.

## 6.2 Token design

| | Access token | Refresh token |
|---|---|---|
| Format | JWT, HS256 | Opaque, 32 random bytes, base64url |
| Lifetime | 15 minutes | 30 days (sliding, via rotation) |
| Storage server-side | none (stateless) | SHA-256 hash in `sessions` |
| Storage client-side | memory only | `httpOnly; Secure; SameSite=Strict` cookie, `Path=/api/v1/auth` |
| Transport | `Authorization: Bearer …` | cookie, automatically |
| Revocable | no (short life) | yes, immediately |

Access token claims are deliberately minimal:

```json
{ "sub": "<user uuid>", "sid": "<session id>", "roles": ["customer"],
  "typ": "access", "iat": …, "exp": …, "iss": "ecommerce-api", "aud": "storefront" }
```

Permissions are **not** in the token. They are resolved per request from a process-cached role→permission map (invalidated on role change). Putting permissions in the token means a permission revocation takes up to 15 minutes to bite and makes tokens grow with the permission set.

The verifier pins the algorithm (`algorithms: ['HS256']`), checks `iss`, `aud` and `typ`, and rejects anything else — `alg: none` and token-type confusion are both closed by construction.

**Why opaque refresh tokens rather than JWTs.** A refresh token must be revocable and its use must be *detectable*. A stateless JWT is neither. The hash-in-database approach costs one indexed lookup per refresh (once per 15 minutes per user) and buys real session management.

## 6.3 Refresh rotation and reuse detection

```
POST /auth/refresh  (cookie carries token T1)
        │
        ├─ hash(T1) not found                → 401, nothing else
        ├─ row.revoked_at IS NOT NULL        → 401
        ├─ row.expires_at < now()            → 401
        ├─ row.used_at IS NOT NULL  ── REUSE DETECTED
        │        └─ revoke every session with the same family_id
        │           log security event, publish security.token_reuse_detected  → 401
        └─ valid
             └─ in one transaction:
                  UPDATE sessions SET used_at = now() WHERE id = $1 AND used_at IS NULL
                  (0 rows affected → a concurrent refresh won; treat as reuse)
                  INSERT new session row, same family_id, parent_id = old id
                  issue new access token
```

The `UPDATE … WHERE used_at IS NULL` returning zero rows is the compare-and-swap that makes rotation safe under concurrent refreshes from two browser tabs.

## 6.4 Password and credential handling

- **argon2id**, `memoryCost: 19456 KiB, timeCost: 2, parallelism: 1` (OWASP baseline), tuned to ~250 ms on the target instance. Rehash transparently on login if parameters have changed.
- Minimum 10 characters, no composition rules, checked against a small blocklist of the most common passwords. Length beats character classes.
- Login returns one generic error (`INVALID_CREDENTIALS`) for unknown email, wrong password and disabled account. A dummy argon2 verification runs when the user does not exist, so response time does not leak account existence.
- Registration and password reset never reveal whether an email is registered. `POST /auth/password/forgot` always returns `202`.
- Throttling: 5 failures per email per 15 min and 20 per IP per 15 min → `429` with `Retry-After`; 10 consecutive failures sets `users.status='locked'`, cleared by a successful reset.
- Tokens for verification and reset: 32 random bytes, stored as SHA-256, single-use (`consumed_at` set via CAS), 24 h for verification and 1 h for reset. Consuming a reset token revokes every session for that user.

## 6.5 The role and permission model

Four roles, seeded by migration:

| Role | Intended for |
|---|---|
| `customer` | Storefront shoppers. Granted automatically at registration. |
| `staff` | Day-to-day operations: orders, shipping, inventory, customer lookup. |
| `admin` | Everything operational plus catalog, discounts, analytics, settings. |
| `owner` | Admin plus staff management and role assignment. Cannot be removed from the last holder. |

Permission keys are `resource:action`:

```
catalog:read      catalog:write      catalog:publish
inventory:read    inventory:adjust
orders:read       orders:write       orders:cancel      orders:refund
shipping:read     shipping:write
payments:read     payments:capture   payments:refund
customers:read    customers:write    customers:impersonate*
discounts:read    discounts:write
analytics:read    reports:generate
settings:read     settings:write
staff:read        staff:write        roles:assign
audit:read
```

*`customers:impersonate` is defined but granted to nobody in v1; it exists so the audit surface is designed for it rather than retrofitted.

Default grants (seed):

| Permission group | staff | admin | owner |
|---|:--:|:--:|:--:|
| orders read/write/cancel | ✔ | ✔ | ✔ |
| orders refund | — | ✔ | ✔ |
| shipping | ✔ | ✔ | ✔ |
| inventory read / adjust | ✔ | ✔ | ✔ |
| catalog read | ✔ | ✔ | ✔ |
| catalog write/publish | — | ✔ | ✔ |
| customers read | ✔ | ✔ | ✔ |
| customers write | — | ✔ | ✔ |
| discounts | — | ✔ | ✔ |
| analytics / reports | — | ✔ | ✔ |
| settings | — | ✔ | ✔ |
| staff / roles / audit | — | — | ✔ |

## 6.6 Enforcement

Three layers, all server-side:

**1. Router-level default deny.** The admin router applies `authenticate` and `requireAnyRole('staff','admin','owner')` before any admin route is mounted. A new admin route is protected the moment it is added; forgetting the middleware is not possible.

**2. Permission check per route.**

```ts
adminRouter.post('/orders/:id/refunds',
  requirePermission('orders:refund'),
  validate({ params: idParam, body: createRefundSchema }),
  idempotency(),
  ordersAdminController.createRefund)
```

**3. Resource-level policy in the service.** Permissions answer "may this role refund orders"; policies answer "may this actor refund *this* order". Storefront reads are always scoped in SQL by `customer_id = $actor`, never filtered in application code after fetching — that is how IDOR bugs happen.

```ts
// features/orders/orders.policy.ts
export function assertCanViewOrder(actor: Actor, order: Order) {
  if (actor.type === 'staff' && actor.can('orders:read')) return
  if (actor.type === 'customer' && order.customerId === actor.userId) return
  throw new NotFoundError('ORDER_NOT_FOUND')   // 404, not 403 — do not confirm existence
}
```

## 6.7 Guest access

Guests get no token. A cart is addressed by an opaque `cart_token` (cookie, hashed in the database), and guest order lookup requires order number **plus** the email on the order, rate-limited to 5 attempts per IP per hour. Guest orders can be claimed later: when a user verifies an email that matches guest orders, a job attaches those orders to the account. See decision **D-3**.

## 6.8 Socket authentication

Covered in §11.2 — the same access token, verified in the handshake, never trusting any client-supplied identity.

---

# 7. REST API architecture

## 7.1 Surfaces

```
/api/v1/auth/*         register, login, refresh, logout, verify, password reset
/api/v1/storefront/*   public catalog + customer-scoped resources
/api/v1/admin/*        staff/admin/owner operations
/api/v1/webhooks/*     inbound provider callbacks (no session auth; signature auth)
/healthz  /readyz  /metrics                     (unversioned operational endpoints)
```

Separating storefront from admin is not cosmetic. It gives each surface its own default middleware stack (auth posture, rate limits, CORS origin, response shaping) and makes "is this endpoint reachable by a customer?" answerable by looking at the URL. It also means an admin-only field can never leak through a storefront serializer, because they are different mappers.

Versioning is in the path from day one. `v1` will not be replaced casually; additive changes stay in `v1`, and a `v2` only appears for a genuine breaking change.

## 7.2 Conventions

| Aspect | Rule |
|---|---|
| Resource naming | plural nouns, kebab-case: `/order-items`, `/shipping-methods` |
| Reads | `GET` collection / `GET` item |
| Creates | `POST` collection → `201` + `Location` |
| Partial updates | `PATCH` — the default for updates |
| Full replacement | `PUT` — used only where genuinely idempotent-replace |
| Archival | `DELETE` on the item, which archives rather than removes |
| Actions that are not CRUD | sub-resource `POST`: `/orders/:id/cancel`, `/orders/:id/refunds`, `/shipments/:id/mark-delivered` |
| Filtering | query params: `?status=paid&created_from=…&q=…` |
| Sorting | `?sort=-placed_at` (leading `-` = descending), against an allowlist per endpoint |
| Field selection | not supported in v1; distinct DTOs instead |

Non-CRUD state changes get their own endpoint rather than `PATCH {status: 'cancelled'}`. Cancelling an order releases inventory, may trigger a refund, and writes history — that is a command with its own authorization, validation and idempotency, not a field assignment.

## 7.3 Response envelope

Matching `CLAUDE.md` §37, extended with the two fields needed operationally:

```jsonc
// 200
{ "success": true, "data": { … } }

// 200 collection
{ "success": true,
  "data": [ … ],
  "meta": { "pagination": { "page": 1, "limit": 20, "total": 137,
                            "totalPages": 7, "hasNext": true, "hasPrev": false } } }

// error
{ "success": false,
  "message": "Product not found",
  "code": "PRODUCT_NOT_FOUND",
  "requestId": "01J8…",
  "details": [ { "path": "body.quantity", "message": "must be at least 1" } ] }
```

`code` is a stable machine-readable string the frontends switch on; `message` is human-readable and may change. `requestId` is echoed in every error so a customer-reported failure is one log query away. `details` appears only for validation errors. Every response also carries `X-Request-Id`.

Status codes: `200`, `201`, `202` (accepted, work queued), `204`, `400` (malformed), `401`, `403`, `404`, `409` (state conflict, idempotency conflict), `410` (expired token/link), `422` (semantically invalid / business rule), `429`, `500`, `503`. `422` vs `400`: `400` is "I cannot parse this", `422` is "I understand it and it is not allowed".

## 7.4 Pagination

Two strategies, each where it fits:

- **Offset** (`?page=&limit=`, default 20, max 100) for admin tables, which need a total count and page jumps. The count query is `COUNT(*) OVER ()` in the same statement, so listing costs one round trip.
- **Cursor/keyset** (`?cursor=&limit=`) for storefront listings, the notification feed, and anything infinite-scrolling, where deep offsets degrade and page drift shows duplicates. The cursor is an opaque base64 of the sort key plus id.

The chosen strategy per endpoint is fixed and documented; endpoints do not accept both.

## 7.5 Request-level middleware order

```
requestId + ALS context
  → pino-http access log
  → helmet
  → cors (origin allowlist by surface)
  → raw body capture (webhooks only, before json parser)
  → express.json({ limit: '256kb' })
  → rate limiter (tiered by surface)
  → authenticate            (optional or required per surface)
  → authorize               (per route)
  → validate                (params, query, body — replaces req values with parsed ones)
  → idempotency             (unsafe methods on designated routes)
  → controller
  → notFound
  → errorHandler
```

Order matters and is asserted by a test: validation runs after authentication (do not spend CPU validating unauthenticated noise), and the raw-body capture runs before the JSON parser (a signature is over raw bytes).

## 7.6 Endpoint inventory (v1)

**Auth** — `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `POST /auth/logout-all`, `POST /auth/email/verify`, `POST /auth/email/resend`, `POST /auth/password/forgot`, `POST /auth/password/reset`, `POST /auth/password/change`, `GET /auth/me`, `GET /auth/sessions`, `DELETE /auth/sessions/:id`.

**Storefront** — catalog: `GET /products`, `GET /products/:slug`, `GET /categories`, `GET /categories/:slug/products`, `GET /search`. Cart: `GET|POST /cart`, `POST /cart/items`, `PATCH /cart/items/:id`, `DELETE /cart/items/:id`, `POST /cart/discount`, `DELETE /cart/discount`. Checkout: `GET /checkout/shipping-methods`, `POST /checkout/quote`, `POST /orders`. Account: `GET /orders`, `GET /orders/:id`, `POST /orders/:id/cancel`, `GET|POST /addresses`, `PATCH|DELETE /addresses/:id`, `GET|PATCH /profile`, `GET /notifications`, `POST /notifications/:id/read`, `POST /analytics/events`. Guest: `POST /orders/lookup`.

**Admin** — `GET /dashboard/summary`; `GET /analytics/{sales,orders,customers,products,inventory,shipping}`; `POST /reports`; full CRUD over `/products`, `/products/:id/variants`, `/categories`, `/media`; `GET|POST /inventory/adjustments`, `GET /inventory/low-stock`, `GET /inventory/movements`; `GET /orders`, `GET /orders/:id`, `POST /orders/:id/{confirm,cancel}`, `PATCH /orders/:id/notes`, `POST /orders/:id/refunds`; `GET /payments`, `POST /payments/:id/mark-paid`; `POST /orders/:id/shipments`, `PATCH /shipments/:id`, `POST /shipments/:id/{ship,deliver}`, CRUD `/shipping-zones`, `/shipping-methods`; CRUD `/discounts`; `GET /customers`, `GET /customers/:id`, `PATCH /customers/:id/status`; `GET|POST /staff`, `PATCH /staff/:id/roles`; `GET|PATCH /settings`; `GET /audit-logs`; `GET /jobs/failed`, `POST /jobs/:id/retry`.

**Webhooks** — `POST /webhooks/payments/:provider`.

## 7.7 Documentation

Request and response schemas are Zod objects; `@asteasolutions/zod-to-openapi` derives an OpenAPI 3.1 document from the same objects that validate at runtime. The spec is generated in CI and committed, so a schema change that is not reflected in the docs is a diff in the pull request. Swagger UI is served at `/docs` in non-production environments only.

---

# 8. Background worker architecture

## 8.1 What belongs in a worker

The rule from `CLAUDE.md` §22: if it is slow, external, retryable, or not needed for the response, it does not run in the request. Applied:

| Work | Where | Why |
|---|---|---|
| Order totals, inventory reservation, order insert | request, in transaction | The customer must know it succeeded |
| Order confirmation email | worker | SMTP latency and failure must not fail checkout |
| In-app + realtime notification | worker | Not needed for the response |
| Analytics event ingestion | worker | Batched writes, best-effort |
| Daily rollups | scheduled worker | Expensive aggregate scans |
| Image resizing | worker | CPU-bound, seconds |
| Expired reservation release | scheduled worker | Time-driven, not request-driven |
| Low-stock scan | scheduled worker | Periodic |
| CSV/report generation | worker | Minutes, produces a file |
| Webhook processing | worker | Provider needs `200` in milliseconds |

## 8.2 Runtime model

`src/main/worker.ts` starts pg-boss, registers every handler in `src/jobs/`, registers cron schedules, and starts the event dispatcher. Handlers are plain typed functions:

```ts
type JobHandler<T> = (payload: T, ctx: JobContext) => Promise<void>
// ctx: { jobId, attempt, logger, signal }
```

The handler receives a logger already bound with `jobId`, `queue` and `attempt`, so every log line from a job is traceable back to the job. `signal` is aborted on shutdown so long jobs can stop cleanly.

Registration is declarative and typed, so a queue name typo is a compile error:

```ts
register(QUEUES.EMAIL_SEND,        emailSendHandler,      { teamSize: 5,  teamConcurrency: 2 })
register(QUEUES.ANALYTICS_ROLLUP,  analyticsRollupHandler,{ teamSize: 1 })
```

## 8.3 Reliability and idempotency

Every handler must be safe to run twice — pg-boss, like every queue, is at-least-once. The techniques, in order of preference:

1. **A unique constraint that makes the second attempt a no-op.** `email_messages.dedupe_key`, `notifications.dedupe_key`, `discount_redemptions (discount_id, order_id)`.
2. **Conditional update (CAS).** `UPDATE orders SET status='confirmed' WHERE id=$1 AND status='pending'` — zero rows means someone already did it, which is success, not failure.
3. **A ledger check.** Before writing an inventory movement for shipment X, check whether one already exists for that reference.

Handlers never re-derive state from their payload alone; they re-read the aggregate and act on its current state. A payload is a *pointer*, not a snapshot: `{ orderId }`, not the whole order. This also keeps the queue table small and avoids acting on stale data after a retry delay.

Failure policy per queue:

| Queue | Retries | Backoff | On final failure |
|---|---|---|---|
| `email.send` | 5 | exponential, 30 s → 8 h | dead-letter, mark `email_messages.status='failed'`, alert if rate spikes |
| `notification.dispatch` | 3 | exponential | dead-letter |
| `analytics.ingest` | 2 | 30 s | drop with a warning — analytics must never page anyone |
| `analytics.rollup` | 3 | 5 min | dead-letter + admin notification (dashboard is stale) |
| `media.process_image` | 3 | exponential | dead-letter, asset stays unprocessed, original still usable |
| `inventory.release_expired` | 3 | 1 min | dead-letter + **admin alert** (stock is stuck reserved) |
| `webhook.process` | 8 | exponential to 24 h | dead-letter + admin alert (money is involved) |
| `report.generate` | 2 | 1 min | dead-letter, notify the requester |

Each queue has a companion dead-letter queue (`<queue>.dlq`) whose handler records the failure and, for the queues marked above, raises an admin notification. `GET /api/v1/admin/jobs/failed` and `POST /api/v1/admin/jobs/:id/retry` make that visible and recoverable without database access.

## 8.4 Scheduled jobs

| Schedule | Job | Purpose |
|---|---|---|
| every 1 min | `inventory.release_expired` | Release reservations older than `reservation_ttl_minutes` on still-unpaid orders |
| every 5 min | `analytics.rollup` (today) | Keep today's dashboard fresh |
| every 15 min | `webhook.sweep` | Re-enqueue `webhook_events` with `processed_at IS NULL` |
| hourly | `inventory.low_stock_scan` | Emit `inventory.low_stock` once per variant per crossing |
| daily 03:00 store-local | `analytics.rollup` (yesterday + 7-day correction window) | Final numbers, absorbing late refunds |
| daily 03:30 | `inventory.reconcile` | Assert `sum(movements) == inventory_items`; alert on drift |
| daily 04:00 | `cleanup.*` | Expired sessions, consumed tokens, expired idempotency keys, abandoned carts, `analytics_events` past retention |
| daily 09:00 store-local | `carts.abandoned_scan` | Mark carts abandoned; optional recovery email (Phase 12) |

pg-boss `singletonKey` guarantees one instance of each scheduled job at a time even if two worker processes are running.

## 8.5 Graceful shutdown

On `SIGTERM`: stop accepting new jobs, let in-flight handlers finish within a 25-second grace window (their `AbortSignal` is raised at 20 s), then `boss.stop({ graceful: true })`, close the pool, exit. Any job killed mid-flight is retried by pg-boss after its visibility timeout — which is exactly why handlers must be idempotent.

## 8.6 Scaling seam

One worker process is enough for a single store. If throughput demands more, pg-boss workers scale by running more copies of the same process — no code change, because job fetching already uses `FOR UPDATE SKIP LOCKED`. The only thing that changes is the Socket.IO adapter (§11.7).

---

# 9. Queue architecture

## 9.1 Why pg-boss

The requirement list in `CLAUDE.md` §23 is: retry, delayed jobs, scheduled jobs, failure handling, concurrency control, job tracking, idempotency. pg-boss provides all seven on top of the Postgres already in the stack, using `SKIP LOCKED` for fetching and its own `pgboss` schema.

The decisive property is transactional coupling. Because jobs and business data live in the same database, the outbox row that triggers a job is written in the same transaction as the order. With Redis, "order committed but job lost" and "job enqueued but order rolled back" both become real, and the standard fix is… an outbox table in Postgres. We would end up building this anyway.

The cost is honest: pg-boss throughput is on the order of thousands of jobs per minute rather than tens of thousands per second, and it adds write load to the transactional database. For one store that is a large margin. §9.5 records the trigger to revisit.

## 9.2 Queue registry

Names are `domain.action`, declared once, typed with their payload schema:

```ts
export const QUEUES = {
  // messaging
  EMAIL_SEND:              'email.send',
  NOTIFICATION_DISPATCH:   'notification.dispatch',
  // catalog & media
  MEDIA_PROCESS_IMAGE:     'media.process_image',
  // inventory
  INVENTORY_RELEASE:       'inventory.release_expired',
  INVENTORY_LOW_STOCK:     'inventory.low_stock_scan',
  INVENTORY_RECONCILE:     'inventory.reconcile',
  // orders, payments, shipping
  ORDER_EXPIRE_UNPAID:     'order.expire_unpaid',
  PAYMENT_CHECK_PENDING:   'payment.check_pending',
  SHIPMENT_DELIVERY_CHECK: 'shipment.delivery_check',
  WEBHOOK_PROCESS:         'webhook.process',
  WEBHOOK_SWEEP:           'webhook.sweep',
  // customers & carts
  CUSTOMER_CLAIM_GUEST_ORDERS: 'customer.claim_guest_orders',
  CARTS_ABANDONED_SCAN:    'carts.abandoned_scan',
  // analytics
  ANALYTICS_INGEST:        'analytics.ingest',
  ANALYTICS_ROLLUP:        'analytics.rollup',
  REPORT_GENERATE:         'report.generate',
  // maintenance
  CLEANUP_SESSIONS:        'cleanup.sessions',
  CLEANUP_IDEMPOTENCY:     'cleanup.idempotency',
  CLEANUP_CARTS:           'cleanup.carts',
  CLEANUP_ANALYTICS:       'cleanup.analytics',
  CLEANUP_EVENTS:          'cleanup.events',
} as const

export const JOB_SCHEMAS = {
  [QUEUES.EMAIL_SEND]: z.object({ emailMessageId: z.string().uuid() }),
  [QUEUES.NOTIFICATION_DISPATCH]: z.object({ eventId: z.string().uuid() }),
  …
} satisfies Record<QueueName, ZodTypeAny>
```

`enqueue()` validates the payload against the schema before sending, and the handler parses it again on receipt. A malformed payload therefore fails at the producer, where the stack trace is useful, rather than silently in a worker.

## 9.3 Options used

| Option | Where |
|---|---|
| `retryLimit`, `retryDelay`, `retryBackoff` | per queue, table in §8.3 |
| `expireInSeconds` | visibility timeout, set to ~3× the expected duration |
| `singletonKey` | scheduled jobs; also `low_stock:<variantId>` to collapse duplicate alerts |
| `startAfter` | delayed work (e.g. re-check payment in 30 min) |
| `deadLetter` | every queue routes to `<queue>.dlq` |
| `retentionDays` | completed jobs kept 7 days for debugging, then archived by pg-boss |
| `teamSize` / `teamConcurrency` | per-queue concurrency; email 5×2, image 2×1, rollup 1×1 |

## 9.4 What never goes through the queue

- Anything the HTTP response depends on.
- Anything that must be atomic with a database write — that is the outbox's job, and the outbox is not the queue.
- Cache invalidation for a value read on the very next request.

## 9.5 When to introduce Redis

Documented trigger conditions, so the decision is data-driven rather than a taste argument:

1. More than one API instance is required (Socket.IO then needs a shared adapter), **or**
2. Queue depth regularly exceeds ~50k pending jobs or job write volume becomes a visible share of database load, **or**
3. A cache with cross-process invalidation becomes necessary (currently the only shared cache is store settings, invalidated by an event).

The migration is bounded: `infrastructure/queue/` is the only place that names pg-boss, and `enqueue()`/`register()` are the only functions features call.

---

# 10. Email system

## 10.1 Pipeline

Exactly the flow required by `CLAUDE.md` §25, with one addition — a database row per message, before the queue:

```
feature / event subscriber
        │  emailService.enqueue({ template, to, props, dedupeKey })
        ▼
  INSERT email_messages (status='queued')      ← renders subject, stores props
        │
        ▼
  enqueue('email.send', { emailMessageId })
        ▼
  email worker  ──▶ render (mjml+handlebars) ──▶ EmailProvider.send()
        │                                              │
        ├── success → status='sent', provider_message_id
        └── failure → attempts++, throw → pg-boss retry → eventually 'failed' + DLQ
```

The `email_messages` row exists before the job, which gives four things at once: a durable outbox for mail, a permanent record of what was sent to whom, natural deduplication via `dedupe_key`, and an admin view of failures. Retrying a failed send is re-enqueueing an existing row, not reconstructing the message.

No controller ever calls a provider. `emailService.enqueue` is the only public entry point, and `EmailProvider.send` is called from exactly one place.

## 10.2 Provider abstraction

```ts
export interface EmailProvider {
  readonly name: string
  send(msg: { to: string; subject: string; html: string; text: string;
              replyTo?: string; headers?: Record<string,string> })
    : Promise<{ providerMessageId: string }>
}
```

Adapters: `smtp` (nodemailer — works with any SMTP provider, and with Mailhog locally), `console` (writes `.eml` files to `tmp/mail/` in tests and development). A hosted API provider is one file. Selection is `EMAIL_PROVIDER` in config; nothing else in the codebase knows which is active.

## 10.3 Templates

```
infrastructure/email/templates/
├── _layout.mjml                 # shared header, footer, store branding
├── welcome/{template.mjml, template.txt.hbs, props.ts}
├── email-verification/…
├── password-reset/…
├── order-confirmation/…
├── order-cancelled/…
├── payment-received/…
├── refund-issued/…
├── shipment-shipped/…
├── shipment-delivered/…
└── low-stock-alert/…            # staff-facing
```

Each template directory carries a `props.ts` exporting a Zod schema. `emailService.enqueue` validates props against it, so a renamed field is a type error at the call site rather than `{{customer.name}}` rendering blank in a customer's inbox. MJML compiles to HTML at build time (not per send). Every template ships a hand-written plain-text alternative — it is the accessibility and deliverability baseline, and it is short.

A snapshot test renders every template with fixture props and asserts the HTML is stable, so a layout change that breaks one template is caught in CI.

## 10.4 Deliverability and consent

- `category` distinguishes transactional from marketing. Marketing sends check `customer_profiles.accepts_marketing` and include a one-click unsubscribe link; transactional sends do not and must not.
- `email_suppressions` is consulted before every send; a suppressed address results in `status='suppressed'`, not a failure.
- Provider bounce/complaint webhooks (when a hosted provider is added) write to `email_suppressions`.
- Credentials live only in server config. The frontends never see them.
- Emails never contain a password, a session token, or full payment details — only single-use, short-lived links.

## 10.5 Which events send which email

| Trigger | Template | To |
|---|---|---|
| `customer.registered` | welcome + email-verification | customer |
| `auth.password_reset_requested` | password-reset | customer |
| `order.placed` | order-confirmation | customer |
| `order.placed` | new-order-alert | staff with `orders:read` (batched, max 1/min) |
| `payment.succeeded` | payment-received | customer |
| `order.cancelled` | order-cancelled | customer |
| `refund.succeeded` | refund-issued | customer |
| `shipment.shipped` | shipment-shipped | customer |
| `shipment.delivered` | shipment-delivered | customer |
| `inventory.low_stock` | low-stock-alert | staff with `inventory:read` (daily digest) |

Staff alerts are digested rather than sent per event, because the failure mode of a busy store is an unread inbox.

---

# 11. Socket.IO realtime architecture

## 11.1 What is genuinely realtime

`CLAUDE.md` §28 is explicit that Socket.IO is not for CRUD. The test applied here: *would a human be staring at this screen expecting it to change without them acting?* If no, it is REST.

Qualifies: a new order arriving on the admin dashboard; an order's status changing while the customer watches the tracking page; a low-stock alert; a payment or shipment update; the admin's unread-notification badge.

Does not qualify: product lists, category trees, settings, analytics tables (refreshed on an interval or on demand), anything a customer only sees after navigating.

## 11.2 Connection and authentication

```
client: io('/storefront', { auth: { token: <access token> } })
             │
   handshake middleware
             ├─ verify JWT (same verifier as HTTP, typ='access')
             ├─ invalid/expired → next(new Error('UNAUTHORIZED')) → connection refused
             └─ valid → socket.data.auth = { userId, roles, sessionId }
             │
   auto-join rooms derived from socket.data.auth ONLY
             ├─ /storefront:  user:<userId>
             └─ /admin:       admin  (+ admin:orders, admin:inventory by permission)
```

The client never says who it is. Rooms are derived server-side from the verified token. A client may request to join exactly one kind of room — `order:<id>` — and the server authorizes that join against the same policy the HTTP `GET /orders/:id` uses. Anything else is refused.

Access tokens expire in 15 minutes. The socket does not drop at expiry; instead the client emits `auth:refresh` with a new token, and the server re-verifies and updates `socket.data`. A socket whose token has been expired for more than 5 minutes without refresh is disconnected. Logging out revokes the session and the server disconnects every socket carrying that `sessionId`.

## 11.3 Namespaces and rooms

| Namespace | Who | Rooms |
|---|---|---|
| `/storefront` | authenticated customers | `user:<userId>`, `order:<orderId>` (own orders only) |
| `/admin` | staff, admin, owner | `admin`, `admin:orders`, `admin:inventory`, `admin:payments`, `user:<staffId>` |

Two namespaces rather than one keeps the authorization rules simple and makes a broadcast to all admins impossible to accidentally deliver to customers. Guests get no socket connection in v1 — there is nothing to push to them.

## 11.4 Event contract

Server → client only. The one client → server message is `order:subscribe`/`order:unsubscribe`. There are no business commands over the socket: every state change goes through an authenticated, validated, audited REST endpoint.

```
order.created         → admin:orders
order.status_changed  → admin:orders, order:<id>, user:<customerId>
order.cancelled       → admin:orders, order:<id>, user:<customerId>
payment.succeeded     → admin:payments, order:<id>, user:<customerId>
payment.failed        → admin:payments, order:<id>
shipment.created      → admin:orders, order:<id>, user:<customerId>
shipment.updated      → admin:orders, order:<id>, user:<customerId>
inventory.low_stock   → admin:inventory
inventory.out_of_stock→ admin:inventory
notification.created  → user:<userId>
dashboard.metrics     → admin  (throttled to at most 1 per 10 s)
```

Payloads are minimal and audience-specific:

```ts
// to admin:orders
{ orderId, orderNumber, status, paymentStatus, fulfillmentStatus,
  totalCents, customerName, occurredAt }
// to user:<customerId> — same event, less data
{ orderId, orderNumber, status, occurredAt }
```

Two rules make this safe and cheap: **a realtime payload never contains anything the recipient could not fetch over REST**, and it carries identifiers plus the changed fields rather than the full aggregate. The client refetches detail if it needs it. That keeps the socket layer from becoming a second, unversioned, unauthorized API.

## 11.5 Where emission happens

Only in `infrastructure/realtime/emitters.ts`, called only from event subscribers. No controller and no service ever calls `io.emit`. This is what stops realtime from leaking into business logic, and it means an event fired by a background job reaches the browser through exactly the same path as one fired by a request.

```
domain event committed  →  dispatcher  →  realtime subscriber  →  emitters.orderStatusChanged(...)
```

A consequence worth stating: **the socket layer is not a delivery guarantee.** A disconnected admin misses the push and sees the change on their next fetch or reconnect. Anything that must not be missed is a `notification` row (durable) or an email — never only a socket event.

## 11.6 Operational limits

`maxHttpBufferSize` 100 KB; `pingInterval` 25 s / `pingTimeout` 20 s; connection rate limited per IP; connections per user capped (10) to bound a runaway client; CORS restricted to the two known origins; the dashboard metrics event is throttled server-side so a burst of orders cannot produce a burst of broadcasts.

## 11.7 Scaling seam

A single Socket.IO node keeps rooms in memory. If a second API instance is ever needed, add `@socket.io/postgres-adapter` (uses `LISTEN/NOTIFY` on the direct connection, no new infrastructure) or the Redis adapter. `emitters.ts` and `rooms.ts` are the only files involved; nothing in `features/` changes.

---

# 12. Domain and business events

## 12.1 The mechanism: a transactional outbox

The hard problem this solves: an order must be committed *and* its consequences must eventually happen — with no window in which one occurs without the other. Publishing to an in-process emitter after `COMMIT` loses events if the process dies in between. Publishing before `COMMIT` sends events for orders that then roll back.

So events are written to a table **inside the business transaction**, and a dispatcher fans them out afterwards.

```
   ┌─────────── one database transaction ────────────┐
   │  INSERT orders / order_items                     │
   │  UPDATE inventory_items (reserve)                │
   │  INSERT inventory_movements                      │
   │  INSERT domain_events ('order.placed', …)        │
   └──────────────────────┬───────────────────────────┘
                          COMMIT
                          │
              ┌───────────▼────────────┐
              │  event dispatcher      │  polls id WHERE dispatched_at IS NULL
              │  FOR UPDATE SKIP LOCKED│  (partial index → always tiny)
              └───────────┬────────────┘
                          │  fan out to subscribers
        ┌────────┬────────┼─────────┬──────────┐
        ▼        ▼        ▼         ▼          ▼
     email   notifi-   analytics  realtime   audit
     enqueue  cation    enqueue    emit      (where applicable)
        └────────┴────────┴─────────┴──────────┘
                          │
                  UPDATE dispatched_at = now()
```

The dispatcher runs in the worker process on a 500 ms tick, and the API process signals it via `pg_notify` on commit so the usual latency is a few milliseconds rather than half a second. If the notify is missed, the poll still catches it — the notification is an optimisation, never the mechanism.

Delivery is **at-least-once**. Every subscriber must therefore be idempotent, which they are by the techniques in §8.3. `domain_events` doubles as a permanent, ordered event log: useful for debugging ("what actually happened to order X"), for analytics backfill, and for replaying a subscriber that had a bug.

## 12.2 Event catalogue

Names are `aggregate.past_tense`. Every event has a Zod payload schema in `events/catalog.ts`; publishing an unregistered event or a mismatched payload is a compile-time error.

This is the complete registry — the per-feature "events published" lists in §23 contain nothing that is not here.

| Event | Published by | Payload core |
|---|---|---|
| `customer.registered` | auth | userId, email |
| `customer.email_verified` | auth | userId, email |
| `auth.password_reset_requested` | auth | userId, tokenId |
| `auth.password_changed` | auth | userId |
| `auth.account_locked` | auth | userId, email, ip |
| `auth.token_reuse_detected` | auth | userId, familyId, ip |
| `user.created` | users | userId, roles[] |
| `user.status_changed` | users | userId, from, to, actorId |
| `user.roles_changed` | users | userId, added[], removed[], actorId |
| `staff.invited` | users | userId, email, roles[], invitedBy |
| `customer.profile_updated` | customers | userId, changed[] |
| `customer.marketing_consent_changed` | customers | userId, accepts |
| `customer.address_added` | customers | userId, addressId |
| `product.created` / `product.updated` / `product.archived` | catalog | productId, changed[] |
| `product.published` | catalog | productId |
| `product.price_changed` | catalog | productId, variantId, fromCents, toCents, actorId |
| `category.created` / `category.updated` / `category.archived` | catalog | categoryId |
| `inventory.adjusted` | inventory | variantId, deltaOnHand, reason, actorId |
| `inventory.reserved` / `inventory.released` | inventory | variantId, qty, orderId |
| `inventory.committed` | inventory | variantId, qty, shipmentId |
| `inventory.low_stock` | inventory | variantId, available, threshold |
| `inventory.out_of_stock` | inventory | variantId |
| `inventory.back_in_stock` | inventory | variantId, available |
| `cart.created` | carts | cartId, customerId? |
| `cart.abandoned` | carts | cartId, customerId, itemCount, valueCents |
| `cart.converted` | carts | cartId, orderId |
| `order.placed` | orders | orderId, orderNumber, customerId, totalCents, items[] |
| `order.confirmed` | orders | orderId |
| `order.status_changed` | orders | orderId, field, from, to, actorType |
| `order.cancelled` | orders | orderId, reason, actorType |
| `order.completed` | orders | orderId |
| `order.note_added` | orders | orderId, actorId, visibility |
| `payment.created` | payments | paymentId, orderId, amountCents, provider |
| `payment.succeeded` | payments | paymentId, orderId, amountCents |
| `payment.failed` | payments | paymentId, orderId, failureCode |
| `payment.cancelled` | payments | paymentId, orderId |
| `refund.created` | payments | refundId, orderId, amountCents |
| `refund.succeeded` | payments | refundId, orderId, amountCents, restock |
| `refund.failed` | payments | refundId, orderId, failureCode |
| `shipment.created` | shipping | shipmentId, orderId, itemCount |
| `shipment.shipped` | shipping | shipmentId, orderId, carrier, trackingNumber |
| `shipment.delivered` | shipping | shipmentId, orderId |
| `shipment.returned` | shipping | shipmentId, orderId, restock |
| `shipment.failed` | shipping | shipmentId, orderId, reason |
| `discount.created` / `discount.updated` / `discount.archived` | discounts | discountId, actorId |
| `discount.redeemed` | discounts | discountId, orderId, amountCents |
| `discount.usage_limit_reached` | discounts | discountId, code |
| `notification.created` | notifications | notificationId, userId, type |
| `settings.updated` | settings | changed[], actorId |
| `report.generated` | analytics | reportId, requestedBy, storageKey |
| `analytics.rollup_failed` | analytics | from, to, error |
| `job.dead_lettered` | queue infra | queue, jobId, attempts, error |

Deliberately absent: `product.viewed`, `cart.item_added`. Those are *behavioural* events with two to three orders of magnitude more volume; they go to `analytics_events` through a separate batched ingestion path (§13.4), not through the outbox. Mixing them in would make the outbox the busiest table in the database.

## 12.3 Subscribers

`events/subscribers/` holds the fan-out map. This is the one place where cross-feature reactions are visible in a single screen:

```ts
on('order.placed', [
  sendOrderConfirmationEmail,     // → email.send
  notifyStaffOfNewOrder,          // → notification.dispatch
  emitOrderCreatedRealtime,       // → socket
  recordOrderPlacedAnalytics,     // → analytics.ingest
])
on('payment.succeeded', [
  confirmOrderAfterPayment,       // → orders.markPaid()  (public service)
  sendPaymentReceipt,
  emitPaymentRealtime,
])
on('inventory.low_stock', [notifyStaffLowStock, emitLowStockRealtime])
```

Subscribers are thin: they translate an event into a job or an emit. Real work happens in the job handler, where retry and backoff apply. A subscriber that throws does not block its siblings — each is wrapped, failures are logged, and the event is retried as a whole with an attempt counter, so subscriber idempotency matters (§8.3).

## 12.4 What events are not for

- Not a replacement for a synchronous call. Reserving inventory during checkout is a direct service call whose failure must fail the order.
- Not for trivial internal calls. There is no `product.title_changed`.
- Not a state machine. The order's status lives in the `orders` row; events describe what happened, they do not define what is true.

---

# 13. Analytics architecture

## 13.1 Three layers, by cost

```
Layer 1 — LIVE COUNTERS          indexed queries on transactional tables
          "12 orders awaiting shipment"        < 10 ms, always current

Layer 2 — DAILY ROLLUPS          analytics_daily_sales, analytics_product_daily
          "revenue trend, best sellers"        precomputed by job, < 20 ms to read

Layer 3 — BEHAVIOURAL EVENTS     analytics_events
          "checkout funnel, conversion"        append-only, queried on demand
```

Layer 1 exists because some numbers must be exact and current, and are cheap given the partial indexes in §5.12. Layer 2 exists because scanning a year of orders on every dashboard load is exactly what `CLAUDE.md` §33 forbids. Layer 3 exists because conversion questions cannot be answered from orders alone — an order tells you who bought, not who left.

## 13.2 Metric definitions

Ambiguity here is what makes finance distrust a dashboard, so the definitions are fixed and documented, and the rollup SQL is the only implementation of them:

```
gross_sales   = Σ order_items.subtotal_cents                    (before discounts, excl. tax & shipping)
discounts     = Σ orders.discount_total_cents
refunds       = Σ refunds.amount_cents (succeeded, attributed to the refund's own date)
net_sales     = gross_sales − discounts − refunds
total_sales   = net_sales + tax + shipping
AOV           = total_sales ÷ orders_count                       (excluding cancelled orders)
units_sold    = Σ order_items.quantity − Σ order_items.refunded_quantity
```

Two rules that decide the answers: cancelled orders are excluded from every sales metric; a refund is attributed to the date the refund happened, not the date of the original order (so yesterday's published numbers never change retroactively — instead the correction appears on today's).

A customer counts as **new** on the date of their first non-cancelled order, and **returning** on every subsequent order date.

All bucketing uses the store timezone from `store_settings`, applied in one helper (`toStoreDate(ts)`). "Sales today" means today where the store is, not in UTC.

## 13.3 Rollup jobs

`analytics.rollup` takes `{ from, to }` store-local dates and is **fully idempotent**: it recomputes each date from the transactional tables and upserts, so running it twice, or re-running last month after a data fix, is always safe.

- Every 5 minutes: recompute today. Cheap — one day's orders.
- Nightly at 03:00: recompute the last **7** days. Late refunds and delivery confirmations land inside that window; a fixed correction window means the dashboard is eventually consistent within a bounded, documented period.
- On demand: `POST /api/v1/admin/analytics/rebuild { from, to }` (owner only, audited) for backfills after a bug fix.

Materialized views were considered and rejected: `REFRESH MATERIALIZED VIEW CONCURRENTLY` recomputes everything, whereas a job can recompute exactly the affected date range, and a table can be incrementally corrected. The rollup tables *are* the materialization, with better control.

## 13.4 Behavioural event ingestion

```
storefront  ──POST /storefront/analytics/events  (batch of ≤20)
                 │  validated against an allowlist of event names + property schemas
                 │  rate limited per IP and per session
                 ▼
            enqueue('analytics.ingest', batch)     → 202 immediately
                 ▼
            worker: multi-row INSERT into analytics_events
```

Allowlisted events: `product.viewed`, `collection.viewed`, `search.performed`, `cart.item_added`, `cart.item_removed`, `checkout.started`, `checkout.step_completed`. Anything else is rejected — an open ingestion endpoint is a free write amplifier for an attacker.

The endpoint never blocks on a database write, the client's `anonymous_id` is a UUID it generates and stores locally, and IP addresses are not stored (only used for rate limiting). Retention: 180 days, enforced by `cleanup.analytics`. If volume ever justifies it, monthly partitioning of `analytics_events` is a contained change — noted, not built.

Conversion is computed by joining sessions that produced a `checkout.started` against orders in the same session window.

## 13.5 Dashboard and reporting API

`GET /api/v1/admin/dashboard/summary` returns everything the landing screen needs in one call, assembled from Layer 1 + Layer 2 and cached in-process for 30 seconds:

```jsonc
{ "salesToday": {...}, "salesThisWeek": {...}, "salesThisMonth": {...},
  "ordersToday": 14, "pendingOrders": 3, "awaitingShipment": 7,
  "newCustomersToday": 5, "returningCustomersToday": 9,
  "lowStockCount": 4, "outOfStockCount": 1,
  "revenueTrend": [{ "date": "2026-08-01", "netSalesCents": 128400 }, …],
  "orderTrend": [...], "topProducts": [...], "recentOrders": [...] }
```

One request instead of eleven. `?range=today|7d|30d|90d|custom` with an explicit date range; every response echoes the range and the store timezone it was computed in.

Detailed endpoints (`/analytics/sales`, `/analytics/products`, …) accept `?groupBy=day|week|month` and support `Accept: text/csv` for export. Exports over 5 000 rows return `202` and go through `report.generate`, which writes a file to storage and notifies the requester when it is ready.

## 13.6 Cost control

Analytics may never slow down checkout. Concretely: rollup jobs run in the worker process; they use `SET LOCAL statement_timeout = '60s'`; heavy exports are jobs, not requests; the dashboard reads rollups, never raw orders; and `analytics.ingest` failures are logged and dropped rather than retried indefinitely. If analytics is broken, the store still sells.

---

# 14. Error handling

## 14.1 Hierarchy

```
AppError (abstract)  { code, httpStatus, message, details?, cause?, isOperational }
├── ValidationError        422  VALIDATION_FAILED
├── AuthenticationError    401  UNAUTHENTICATED | INVALID_CREDENTIALS | TOKEN_EXPIRED
├── AuthorizationError     403  FORBIDDEN | INSUFFICIENT_PERMISSIONS
├── NotFoundError          404  <RESOURCE>_NOT_FOUND
├── ConflictError          409  ALREADY_EXISTS | CONCURRENT_MODIFICATION | IDEMPOTENCY_CONFLICT
├── GoneError              410  TOKEN_EXPIRED | LINK_EXPIRED
├── DomainRuleError        422  INSUFFICIENT_STOCK | INVALID_STATUS_TRANSITION | DISCOUNT_EXPIRED …
├── RateLimitError         429  RATE_LIMITED           (+ retryAfter)
├── ExternalServiceError   502  PAYMENT_PROVIDER_ERROR | EMAIL_PROVIDER_ERROR
└── InternalError          500  INTERNAL_ERROR          (isOperational = false)
```

`DomainRuleError` is the workhorse: business rules fail loudly with a specific code the frontend can act on. `INSUFFICIENT_STOCK` carries `details: [{ variantId, requested, available }]` so the cart page can show exactly which line to fix — the difference between a usable checkout and a dead end.

Error codes live in one exported const object. A test asserts every code is unique and every code used in the codebase is declared, which keeps the frontend contract honest.

## 14.2 Database error translation

`infrastructure/database/errors.ts` maps Postgres `SQLSTATE`s once, at the boundary, so no service writes `if (err.code === '23505')`:

| SQLSTATE | Meaning | Becomes |
|---|---|---|
| `23505` | unique violation | `ConflictError` (constraint name → specific code, e.g. `EMAIL_ALREADY_REGISTERED`) |
| `23503` | FK violation | `DomainRuleError REFERENCED_RESOURCE_MISSING` |
| `23514` | check violation | `DomainRuleError` — usually a real bug; logged at `error` |
| `40001` / `40P01` | serialization failure / deadlock | retried automatically (§18.5); if retries exhaust, `ConflictError CONCURRENT_MODIFICATION` |
| `55P03` / `57014` | lock not available / statement timeout | `ConflictError RESOURCE_BUSY` |
| `08*` | connection failure | `InternalError` + readiness degradation |

## 14.3 The central handler

```
error → is it AppError?
   ├─ yes, operational → log at warn (401/403/404/409/422) or info (429)
   │                    → respond { success:false, message, code, requestId, details? }
   └─ no  → log at error with full stack, request id, user id, route, sanitized input
          → respond 500 { success:false, message:'An unexpected error occurred',
                          code:'INTERNAL_ERROR', requestId }
```

In production the response never contains a stack, a SQL fragment, a constraint name, an internal identifier or a provider message. In development the response gains `stack` and `cause`. The `requestId` is the bridge: the customer quotes it, the log has everything.

`unhandledRejection` and `uncaughtException` are logged and then trigger a graceful shutdown — a process in an unknown state must not keep serving checkout. Worker handlers wrap their own errors so a job failure never takes the process down.

---

# 15. Logging and observability

## 15.1 Structured logs

pino, JSON to stdout, collected by the platform. Every line carries `requestId` (or `jobId`), `userId` when known, and the component name, injected automatically from `AsyncLocalStorage` — so nothing has to be threaded through function signatures.

```json
{"level":30,"time":"…","requestId":"01J8…","userId":"…","component":"orders.service",
 "orderId":"…","totalCents":48900,"msg":"order placed"}
```

Levels: `error` = needs a human; `warn` = handled but notable (payment declined, retry, rate limit); `info` = business milestones (order placed, shipment shipped, job completed); `debug` = development only. Default production level `info`, overridable per component via `LOG_LEVEL`.

## 15.2 Redaction

Configured once in the logger, not remembered per call site:

```ts
redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'password',
                  '*.password', 'passwordHash', 'token', '*.token', 'refreshToken',
                  'refresh_token_hash', 'accessToken', 'apiKey', '*.secret',
                  'card', 'cvv', 'res.headers["set-cookie"]'], censor: '[REDACTED]' }
```

Request bodies are logged only for `4xx`/`5xx`, and only after redaction. Full email addresses are logged for staff actions and masked (`j***@example.com`) elsewhere.

## 15.3 What is always logged

Authentication failures and lockouts; token reuse detection; every `5xx`; every permission denial; order creation, cancellation and status transitions; every payment and refund state change; every webhook received and its dedupe outcome; job start/complete/fail with duration; email send failures; realtime auth failures; slow queries (> 200 ms) with the statement name and duration; every migration applied.

## 15.4 What is never logged

Passwords or hashes, raw tokens of any kind, full card data (never handled at all), provider secrets, full request bodies on success, personally identifying data beyond what an operation requires.

## 15.5 Health

- `GET /healthz` — process is alive. No dependency checks. Used by the platform's restart probe.
- `GET /readyz` — `SELECT 1` against the pool, pg-boss started, migrations at the expected version. Returns `503` with a per-check breakdown when degraded. Used by the load balancer.
- `GET /version` — commit SHA, build time, schema version.

Splitting these matters: a database blip should stop traffic being routed, not restart the process.

## 15.6 Metrics (recommended, small)

`prom-client` exposing `/metrics` on an internal-only path guarded by a bearer token: default Node metrics, plus `http_request_duration_seconds{route,method,status}`, `db_query_duration_seconds{statement}`, `job_duration_seconds{queue,status}`, `queue_depth{queue}`, `orders_placed_total`, `payments_failed_total`, `socket_connections`. About 60 lines, and it is the difference between "the site feels slow" and "the `orders` insert p99 tripled at 14:05". Marked optional in Phase 13; the alternative is to rely on the hosting platform's built-in metrics.

## 15.7 Audit trail, distinct from logs

Logs are for operators and are ephemeral. `audit_logs` is for the business, is queryable by the admin UI, and is retained. Written explicitly from admin services via `audit.record({ action, resourceType, resourceId, before, after })` — deliberately not middleware, because a middleware cannot know the semantic before/after of the change.

Audited: product create/update/archive and price changes; inventory adjustments; order status changes, cancellations, refunds; discount create/update; customer status changes; staff and role changes; settings changes; analytics rebuilds; failed-job retries. Not audited: reads (except `customers:impersonate` if ever enabled), and anything a customer does to their own data — that is order history, not audit.

---

# 16. Security

## 16.1 Transport and headers

TLS terminated at the platform; `helmet` sets HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options` and a restrictive CSP for the API's own responses (`default-src 'none'`, since the API returns JSON). `x-powered-by` removed. `trust proxy` set to the exact hop count so `req.ip` is the real client and cannot be spoofed via `X-Forwarded-For`.

## 16.2 CORS

An explicit allowlist per surface — `CLIENT_ORIGIN` for `/storefront`, `ADMIN_ORIGIN` for `/admin` — with `credentials: true` (the refresh cookie needs it), a fixed method and header allowlist, and no wildcard, ever. Webhook routes have CORS disabled entirely.

## 16.3 Input handling

- Every request body, query and param is parsed by a **strict** Zod schema (`.strict()` rejects unknown keys), which also closes mass assignment: `role`, `isAdmin` and `priceCents` are simply not in the customer-facing schema, so sending them is a `422`.
- Body limit 256 KB; uploads go through a separate multipart route with its own limits.
- Product descriptions and any other rich text are sanitized server-side on write.
- All SQL is parameterized. Identifiers that must be dynamic (sort columns) come from a hard-coded allowlist, never from user input.
- File uploads: extension **and** magic-byte sniffing, 10 MB cap, images only, re-encoded by `sharp` in the worker (which strips EXIF and neutralizes polyglot files), stored with a generated key, served from storage — never from the API process.

## 16.4 Authentication hardening

Covered in §6: argon2id, generic errors, timing-safe comparison, per-email and per-IP throttling, account lock, refresh rotation with reuse detection, algorithm pinning, short access-token life, single-use hashed tokens for verification and reset, session revocation on password change.

## 16.5 Authorization hardening

Default-deny at the admin router; explicit permission per route; resource-level policies; storefront queries scoped by `customer_id` in SQL. `404` rather than `403` when confirming existence would leak information. A contract test asserts that every route under `/admin` has at least one authorization middleware — the check is automated because "we forgot the guard" is the most common real-world admin breach.

## 16.6 Payments and webhooks

No card data ever touches this server. Webhook handling: capture the raw body before JSON parsing, verify the HMAC signature with `crypto.timingSafeEqual`, reject timestamps outside a 5-minute tolerance (replay defence), insert into `webhook_events` with its unique constraint (duplicate defence), respond `200` immediately, process asynchronously. An unverified signature is logged and rejected with `400` — and never processed "just in case".

## 16.7 Rate limiting

| Scope | Limit |
|---|---|
| `POST /auth/login`, `/auth/password/forgot` | 5 / 15 min per email, 20 / 15 min per IP |
| `POST /auth/register` | 5 / hour per IP |
| `POST /orders` | 10 / hour per user or IP |
| `POST /orders/lookup` (guest) | 5 / hour per IP |
| `POST /analytics/events` | 60 / min per session |
| storefront reads | 300 / min per IP |
| admin, authenticated | 600 / min per user |

In-memory store, correct for one API instance; swapping in a shared store is a one-line change if §9.5 is triggered. Limits are also a cost control, not only a security control.

## 16.8 Secrets

Only `config/env.ts` reads `process.env`, validating with Zod at boot and refusing to start if anything required is missing or malformed — a misconfigured deploy fails immediately and loudly instead of at the first checkout. `.env` files are git-ignored; `.env.example` carries names and dummy values only. The Supabase service-role key, JWT secrets and provider credentials exist only in the server environment and are never included in any API response. JWT secrets are rotatable: the verifier accepts a previous secret for a grace window.

## 16.9 Supply chain and CI gates

`npm audit --audit-level=high` and `npm ci` with a committed lockfile in CI; Dependabot for updates; the ESLint rules from §1.2 (no cross-feature deep imports, no `process.env` outside config, no string-concatenated SQL); TypeScript `strict` with `noUncheckedIndexedAccess`; a secret scanner on every push. The build fails on any of these.

## 16.10 Data protection

RLS enabled with no policies on every table (§4.2). Backups and PITR via Supabase; a documented restore drill. Customer data export and deletion endpoints (owner-only, audited): deletion anonymizes `users` and `order_addresses` while preserving order financial records, because those are legally retained. Retention: `analytics_events` 180 days, `login_attempts` 90 days, `domain_events` 12 months (archived after), `audit_logs` retained.

---

# 17. Validation

## 17.1 Layers

```
1. Schema validation   Zod, at the HTTP boundary   → 422 VALIDATION_FAILED, field-level details
2. Business validation Services                     → 422 DomainRuleError with a specific code
3. Database constraints CHECK / FK / UNIQUE         → last line of defence, mapped in §14.2
```

All three are required. Zod cannot know that a discount has been used up; the database cannot produce a good error message; a service alone cannot survive a concurrent request. Together they make an invalid state unrepresentable.

## 17.2 Schema conventions

```ts
export const createOrderSchema = z.object({
  cartId: z.string().uuid(),
  email: z.string().email().max(255).toLowerCase().trim(),
  shippingAddress: addressSchema,
  billingAddress: addressSchema.optional(),
  shippingMethodId: z.string().uuid(),
  discountCode: z.string().trim().max(64).optional(),
  customerNote: z.string().max(1000).optional(),
}).strict()
```

- `.strict()` everywhere. Unknown keys are an error, not silently dropped.
- The validated output **replaces** `req.body`/`req.query`/`req.params`, and the typed handler reads only from there. The raw value is unreachable, so it cannot be used by accident.
- Coercion happens at the edge (`z.coerce.number().int().min(1).max(100)` for `limit`), so services receive real types.
- Shared primitives live in `shared/validation/`: `uuidParam`, `paginationQuery`, `dateRangeQuery`, `moneyCents`, `countryCode`, `email`, `slug`.
- Money is only ever accepted as integer cents, and never from a customer-facing schema at all — prices come from the database.

## 17.3 The non-negotiables

From `CLAUDE.md` §38, restated as concrete implementation rules:

| Never trusted | How it is actually obtained |
|---|---|
| Prices | `product_variants.price_cents`, read inside the order transaction |
| Line and order totals | Computed by `pricing.calculate()` from server-held values |
| Stock | `inventory_items`, read `FOR UPDATE` |
| Discount amounts | Computed by the discount engine from the stored definition |
| Shipping cost | Computed from the matched `shipping_methods` row |
| Roles and permissions | `user_roles`, never a request field or a token claim beyond `sub` |
| Order status | Transitioned only by the service through the state machine |
| `customer_id` on any resource | `req.auth.userId`, never a body field |

The checkout request carries a cart id, an address, a shipping method id and an optional discount code. Every number on the resulting order is computed server-side. If the client sends a total, it is rejected by `.strict()`.

## 17.4 Response validation in tests

Response DTOs are built by explicit mappers, and integration tests assert responses against a Zod schema. This catches the most dangerous leak — a new database column silently appearing in an API response — before it ships.

---

# 18. Transactions and concurrency

## 18.1 The transaction helper

```ts
await withTransaction(async (tx) => {
  const order = await ordersRepo.insert(tx, …)
  await inventoryService.reserveForOrder(tx, order.id, lines)
  await publish(tx, 'order.placed', { … })
  return order
})
```

`withTransaction` acquires a client, `BEGIN`s, binds the client into `AsyncLocalStorage`, runs the callback, `COMMIT`s or `ROLLBACK`s, and always releases. Repositories call `getClient()`, which returns the ambient transaction client if one is active and the pool otherwise. Nesting reuses the outer transaction via a savepoint rather than opening a second connection — a subtle deadlock source that is closed by design.

Passing `tx` explicitly in service signatures *as well* is deliberate: it makes "this runs inside a transaction" visible at the call site, which is the thing reviewers need to see.

## 18.2 Transaction rules

1. **Nothing external inside a transaction.** No SMTP, no HTTP, no queue publish. `CLAUDE.md` §18 states this and it is enforced by review plus a lint rule on `infrastructure/email` and `infrastructure/queue` imports inside `withTransaction` blocks. Side effects go through the outbox (§12.1).
2. **Short transactions.** Validate and compute before `BEGIN`; the transaction contains only writes and the locking reads they depend on.
3. **Deterministic lock ordering.** Every multi-row lock sorts by primary key before locking. Two concurrent orders containing the same two variants in opposite cart order would otherwise deadlock.
4. **Isolation is `READ COMMITTED`** (the default) with explicit row locks. `SERIALIZABLE` is used nowhere in v1; if a future aggregate check needs it, the retry wrapper in §18.5 already exists.
5. **`statement_timeout`** is set per connection type: 10 s for API, 60 s for workers, 5 min for reports.

## 18.3 The three real race conditions

**Two customers buy the last unit.**

```sql
-- lock the inventory rows, in id order, inside the order transaction
SELECT variant_id, on_hand, reserved, available, allow_backorder
  FROM inventory_items
 WHERE variant_id = ANY($1::uuid[])
 ORDER BY variant_id
   FOR UPDATE;
-- then, per line:
UPDATE inventory_items
   SET reserved = reserved + $2, updated_at = now()
 WHERE variant_id = $1
   AND (NOT track_inventory OR allow_backorder OR on_hand - reserved >= $2);
-- 0 rows → INSUFFICIENT_STOCK → whole transaction rolls back
```

The second buyer's `UPDATE` blocks on the first's row lock, then matches zero rows and fails cleanly. `CHECK (reserved <= on_hand)` is the backstop if the predicate were ever wrong.

**A duplicate payment webhook.** `UNIQUE (provider, provider_event_id)` on `webhook_events` (§5.7) — the second insert conflicts and the handler returns success without reprocessing.

**Two admins change the same order.** Compare-and-swap on the status:

```sql
UPDATE orders SET status = $new, updated_at = now()
 WHERE id = $1 AND status = $expected
RETURNING *;
-- 0 rows → ConflictError CONCURRENT_MODIFICATION ("this order changed; reload")
```

No `version` column is needed: the status *is* the version for the transitions that matter. For non-status admin edits (notes, addresses) last-write-wins is acceptable and documented.

## 18.4 Discount usage limits

The one place a counter must not drift:

```sql
SELECT * FROM discounts WHERE id = $1 FOR UPDATE;                  -- serialize redeemers
-- check active window, usage_limit_total vs usage_count,
-- and per-customer count from discount_redemptions
UPDATE discounts SET usage_count = usage_count + 1 WHERE id = $1;
INSERT INTO discount_redemptions (discount_id, order_id, …);        -- UNIQUE guards retries
```

## 18.5 Retry wrapper

Serialization failures and deadlocks (`40001`, `40P01`) are transient by definition. `withTransaction` retries up to 3 times with jittered backoff (25 ms, 75 ms, 200 ms) when the callback is declared `retryable: true` — which requires it to have no side effects outside the transaction, true by rule 1 above. Exhausted retries surface as `ConflictError`.

## 18.6 Connection pool

API: `max: 10`, `idleTimeoutMillis: 30_000`, `connectionTimeoutMillis: 5_000`, via the Supabase transaction pooler. Worker: `max: 5`, via the direct connection. Sized against the plan's connection ceiling with headroom for migrations and manual access; the numbers are config, and pool saturation is a metric (§15.6).

---

# 19. Idempotency

## 19.1 Where it is required

| Operation | Mechanism |
|---|---|
| `POST /storefront/orders` | `Idempotency-Key` header, required |
| `POST /admin/orders/:id/refunds` | `Idempotency-Key` header, required |
| `POST /admin/payments/:id/mark-paid` | `Idempotency-Key` header, required |
| Inbound webhooks | `UNIQUE (provider, provider_event_id)` |
| Every job handler | unique constraint / CAS / ledger check (§8.3) |
| Event subscribers | same, dispatch is at-least-once (§12.1) |
| Emails | `email_messages.dedupe_key` |
| Notifications | `notifications.dedupe_key` |

## 19.2 The middleware

```
POST with Idempotency-Key: K
  │
  INSERT INTO idempotency_keys (key=K, scope, actor_key, request_hash, status='in_progress')
  │      ON CONFLICT (key, scope, actor_key) DO NOTHING
  │
  ├─ inserted (1 row) → run the handler
  │      ├─ 2xx → store status/body, status='completed'  → respond
  │      └─ error → status='failed', delete the row (a genuine failure may be retried)
  │
  └─ conflict (0 rows) → read the existing row
         ├─ status='completed' AND request_hash matches → replay the stored response  (+ Idempotent-Replay: true)
         ├─ status='completed' AND hash differs         → 422 IDEMPOTENCY_KEY_REUSED
         ├─ status='in_progress' AND locked_at < 60s    → 409 REQUEST_IN_PROGRESS + Retry-After: 2
         └─ status='in_progress' AND locked_at ≥ 60s    → stale (process died); take it over
```

The unique constraint does the concurrency control, so two simultaneous retries of the same key cannot both execute. `request_hash` prevents a client from reusing a key for a different request — silently returning the wrong order would be worse than an error.

Keys expire after 24 hours (`cleanup.idempotency`). Responses are stored whole, so a replay is byte-identical.

## 19.3 Why the order path needs it

A shopper on mobile taps "Place order", the connection drops mid-request, they tap again. Without an idempotency key that is two orders, two reservations of stock and eventually two parcels. With it, the second request replays the first response and the customer sees the order they already have. This is the single highest-value reliability feature in the checkout path, which is why the header is **required** rather than optional there — a request without it is rejected with `400 IDEMPOTENCY_KEY_REQUIRED`, so a client cannot accidentally opt out.

---

# 20. Testing strategy

## 20.1 Shape

```
        ╱ e2e ╲            few    full flows through HTTP against a real database
      ╱ integr. ╲          many   services + repositories + real Postgres
    ╱   unit      ╲        most   pure domain logic, no I/O
```

Vitest throughout; `supertest` for HTTP; `testcontainers` for a disposable Postgres (falling back to the docker-compose instance locally, and to the CI service container in GitHub Actions).

## 20.2 Unit tests — pure logic

No database, no mocks worth the name, microseconds each. The targets are the parts where a bug is a financial bug:

- `pricing.calculate()` — line subtotals, discount application order, tax on discounted vs undiscounted base, shipping, rounding. Rounding is tested explicitly: percentages produce fractional cents, and the rule (round half up per line, then reconcile the order total to the sum of the lines) must be pinned by a test or the invoice will not add up.
- Order, payment, fulfillment and shipment state machines — the full transition matrix, including that every illegal transition throws.
- Discount eligibility — expired, not yet started, below minimum, wrong products, usage exhausted, per-customer exhausted, inactive, guest with `requires_customer`.
- Token, slug, and store-timezone date helpers (including a DST boundary, which is where "sales today" silently breaks).

## 20.3 Integration tests — services against real Postgres

Migrations run once per test container; each test runs inside a transaction that is rolled back afterwards, so tests are isolated and fast without truncation. Factories (`buildProduct`, `buildOrderReady`) create fixtures through repositories, so schema drift breaks the factory rather than fifty tests.

The must-have cases, most of which cannot be tested any other way:

- **Concurrency.** Two `Promise.all` order creations for the last unit → exactly one `201`, one `422 INSUFFICIENT_STOCK`, `on_hand - reserved` never negative, exactly one reservation movement.
- **Order creation atomicity.** Force a failure after the order insert; assert no order row, no reservation, no movement, no event.
- **Outbox atomicity.** `order.placed` exists in `domain_events` in the same transaction; a rolled-back order leaves no event.
- **Idempotency.** Same key twice → one order, identical responses; same key with a different body → `422`.
- **Duplicate webhook.** Same `provider_event_id` twice → one payment transition, one email.
- **Job idempotency.** Invoke each critical handler twice → one email row, one notification, one movement.
- **Reservation expiry.** Reserve, advance the clock, run the release job, assert stock returns and the ledger balances.
- **Cancellation.** Cancel a confirmed order → stock released, movement written, status history written, event published; cancelling a shipped order → `422 INVALID_STATUS_TRANSITION`.
- **Refund.** Partial refund updates `refunded_total_cents` and `payment_status='partially_refunded'`; over-refunding is rejected.
- **Discount limits.** Concurrent redemptions of a discount with `usage_limit_total = 1` → exactly one succeeds.
- **Ledger reconciliation.** After a full order lifecycle, `sum(inventory_movements) == inventory_items` per variant.

## 20.4 API tests — contract and authorization

Against the assembled Express app with a seeded database:

- Response envelope shape and pagination metadata for every collection endpoint.
- **A parameterized authorization matrix**: for each admin route × each role (anonymous, customer, staff, admin, owner), assert the expected status. This is generated from the route table, so a new route without a rule fails the suite.
- IDOR: customer A requesting customer B's order gets `404`, not `403` and not the order.
- Validation: unknown keys rejected; a client-supplied `totalCents` or `role` is ignored/rejected; a negative quantity is `422`.
- Rate limiting returns `429` with `Retry-After`.
- Auth flows end to end: register → verify → login → refresh → rotate → reuse old refresh token → whole family revoked.

## 20.5 E2E

A handful of full journeys, run in CI on every push to main: browse → add to cart → apply discount → checkout → order confirmation email queued → admin confirms → shipment created → shipped → delivered → customer sees final state. Plus the unhappy path: out of stock at checkout, expired discount, cancelled after payment with a refund.

## 20.6 Standards

- Coverage gates by layer, not globally: services and pricing/state machines ≥ 90 %, repositories ≥ 70 %, controllers not gated (they should be too thin to matter). A global percentage encourages testing the easy code.
- Every bug fix starts with a failing test.
- No test asserts on log output or on wall-clock sleeps; time is injected.
- CI: typecheck → lint → unit → integration → e2e → build. Any failure blocks merge.

---

# 21. Environment configuration

## 21.1 One parsed, typed config object

```ts
// config/env.ts — the only file that touches process.env
const schema = z.object({
  NODE_ENV: z.enum(['development','test','production']),
  APP_ENV:  z.enum(['local','staging','production']).default('local'),
  PORT:     z.coerce.number().int().positive().default(4000),

  DATABASE_URL:        z.string().url(),        // pooled  (Supabase :6543) — API
  DATABASE_DIRECT_URL: z.string().url(),        // direct  (Supabase :5432) — workers, migrations
  DATABASE_POOL_MAX:   z.coerce.number().int().default(10),

  JWT_ACCESS_SECRET:   z.string().min(32),
  JWT_ACCESS_TTL:      z.string().default('15m'),
  JWT_REFRESH_TTL_DAYS:z.coerce.number().int().default(30),
  JWT_PREVIOUS_ACCESS_SECRET: z.string().min(32).optional(),   // rotation grace

  CLIENT_ORIGIN: z.string().url(),
  ADMIN_ORIGIN:  z.string().url(),
  COOKIE_DOMAIN: z.string().optional(),

  EMAIL_PROVIDER: z.enum(['smtp','console']).default('console'),
  SMTP_HOST: z.string().optional(), SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(), SMTP_PASSWORD: z.string().optional(),
  EMAIL_FROM: z.string().email(),
  EMAIL_REPLY_TO: z.string().email().optional(),

  STORAGE_PROVIDER: z.enum(['supabase','local']).default('local'),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_STORAGE_BUCKET: z.string().default('media'),

  PAYMENT_PROVIDER: z.enum(['manual']).default('manual'),
  PAYMENT_WEBHOOK_SECRET: z.string().min(16).optional(),

  RUN_WORKERS_IN_PROCESS: z.coerce.boolean().default(false),
  LOG_LEVEL: z.enum(['fatal','error','warn','info','debug']).default('info'),
  METRICS_ENABLED: z.coerce.boolean().default(false),
  METRICS_TOKEN: z.string().optional(),
})
.superRefine((v, ctx) => {
  if (v.EMAIL_PROVIDER === 'smtp' && !v.SMTP_HOST) ctx.addIssue({ … })
  if (v.STORAGE_PROVIDER === 'supabase' && !v.SUPABASE_SERVICE_ROLE_KEY) ctx.addIssue({ … })
  if (v.NODE_ENV === 'production') {
    if (v.EMAIL_PROVIDER === 'console') ctx.addIssue({ message: 'console email in production' })
    if (v.STORAGE_PROVIDER === 'local') ctx.addIssue({ message: 'local storage in production' })
    if (!v.PAYMENT_WEBHOOK_SECRET) ctx.addIssue({ … })
  }
})

export const env = schema.parse(process.env)   // throws at boot, prints every problem at once
```

Conditional requirements are expressed in the schema, so an environment that is *internally* wrong (SMTP selected with no host; console email in production) fails at boot, not at the first order.

## 21.2 What is configuration and what is settings

- **Environment variables**: infrastructure, secrets, per-environment endpoints. Changing them means a deploy.
- **`store_settings` table**: business configuration the owner changes in the admin UI — currency, timezone, tax rate, thresholds, reservation TTL. Changing them must not require a deploy.

Store name, tax rate and timezone are *not* environment variables. That distinction is easy to get wrong and expensive to unwind.

## 21.3 Files

`.env.example` is committed with every variable name, a comment and a dummy value — never a real credential. `.env.test` holds deterministic test values. `.env`, `.env.local`, `.env.production` are git-ignored, and a pre-commit secret scan backs that up. Rotation: `JWT_PREVIOUS_ACCESS_SECRET` lets access-token secrets rotate without logging everyone out; database and provider credentials rotate through the platform.

---

# 22. Development and production setup

## 22.1 Local

```bash
docker compose up -d          # postgres:16 + mailhog
cp .env.example .env
npm ci
npm run db:migrate
npm run db:seed               # roles, permissions, owner account, settings, demo catalog
npm run dev                   # tsx watch, workers in-process, pretty logs
```

One command after the first setup. `docker-compose.yml` provides Postgres 16 and Mailhog (SMTP on 1025, inbox on 8025) so email is visible without a provider account. `RUN_WORKERS_IN_PROCESS=true` in development means no second terminal; a `npm run dev:worker` script exists for when worker behaviour is being debugged in isolation.

Scripts:

```
dev  dev:worker  build  start  start:worker
db:migrate  db:migrate:status  db:migrate:create  db:seed  db:reset
test  test:unit  test:integration  test:e2e  test:watch
lint  format  typecheck  openapi:generate
```

## 22.2 Environments

| | local | test | staging | production |
|---|---|---|---|---|
| Database | docker Postgres | throwaway container | Supabase (separate project) | Supabase |
| Email | Mailhog | console adapter | SMTP → a catch-all inbox | SMTP |
| Storage | local disk | memory | Supabase bucket | Supabase bucket |
| Workers | in-process | in-process | separate process | separate process |
| Logs | pretty | silent | JSON | JSON |
| `/docs` | on | on | on | off |

Staging mirrors production topology, with its own Supabase project — never a shared database.

## 22.3 Build and run

Multi-stage Dockerfile: build stage runs `npm ci` and `tsc` and compiles MJML templates; the runtime stage installs production dependencies only, runs as a non-root user, and starts `node dist/main/api.js`. The same image runs the worker with `node dist/main/worker.js`. One image, two commands — the worker can never drift from the API.

## 22.4 Deployment

```
push → CI: typecheck · lint · unit · integration · e2e · npm audit · build image
        → deploy to staging → run migrations → smoke tests
        → manual approval
        → production: run migrations (separate step, direct connection)
        → deploy API (rolling) → deploy worker
```

Migrations run as their own step before the new code, and are always backward compatible with the currently running version — that is what makes a rolling deploy and a rollback safe. Breaking schema changes use expand/contract across releases (§4.4). Rollback is redeploying the previous image; because migrations are forward-only and additive, the old code still runs against the new schema.

Production checklist per deploy: `/readyz` green, error rate flat, queue depth flat, no dead-letter growth, a test order placed end to end.

## 22.5 Operations

Health probes as in §15.5. Backups and PITR via Supabase, with a restore rehearsed at least once — an untested backup is a hope, not a backup. Admin-visible operational surfaces: failed jobs with retry, unprocessed webhooks, failed emails, inventory reconciliation drift, audit log. Alerting (whatever the platform provides) on `5xx` rate, `/readyz` failing, dead-letter growth, `payments_failed_total` spikes, and the reconciliation job reporting drift.

---

# 23. Feature-by-feature breakdown

Each feature is described in the same eight terms: what it owns, its entities, its APIs, its dependencies, the events it publishes, its background jobs, its realtime events, and its analytics requirements. A dash means the feature genuinely has none — not that it was overlooked.

---

## 23.1 `auth`

**Owns.** Credential verification, session lifecycle, token issuing and rotation, email verification, password reset and change, login throttling and account lockout, socket handshake verification. It is the only feature that knows what a password hash or a refresh token is.

**Entities.** `sessions`, `auth_tokens`, `login_attempts`. Reads and updates `users` (`password_hash`, `email_verified_at`, `status`, `last_login_at`) through the `users` public service — it does not own the row.

**APIs.** `POST /auth/register`, `/login`, `/refresh`, `/logout`, `/logout-all`, `/email/verify`, `/email/resend`, `/password/forgot`, `/password/reset`, `/password/change`; `GET /auth/me`, `GET /auth/sessions`, `DELETE /auth/sessions/:id`.

**Dependencies.** `users` (create and read the identity), `notifications`/email (verification and reset mail, via events), `settings` (store name for email branding).

**Events published.** `customer.registered`, `customer.email_verified`, `auth.password_reset_requested`, `auth.password_changed`, `auth.token_reuse_detected`, `auth.account_locked`.

**Jobs.** `cleanup.sessions` (expired/revoked sessions and consumed tokens, daily). Verification and reset emails go through `email.send` via subscribers.

**Realtime.** None outbound. It supplies the handshake verifier that the realtime layer uses, and forces disconnection of sockets whose session is revoked.

**Analytics.** Registrations per day feed `new_customers`; failed-login and lockout counts are operational metrics, not business analytics.

---

## 23.2 `users`

**Owns.** The `users` record itself, account status, the role catalogue and role assignment, staff account creation, and the permission resolution used by `authorize`.

**Entities.** `users`, `roles`, `permissions`, `role_permissions`, `user_roles`.

**APIs.** `GET|POST /admin/staff`, `GET /admin/staff/:id`, `PATCH /admin/staff/:id/roles`, `PATCH /admin/staff/:id/status`, `GET /admin/roles`, `GET /admin/permissions`. Self-service profile lives in `customers`.

**Dependencies.** None upward. It is depended on by nearly everything.

**Events published.** `user.created`, `user.status_changed`, `user.roles_changed`, `staff.invited`.

**Jobs.** Staff invitation email via `email.send`.

**Realtime.** `user.session_revoked` to `user:<id>` so an admin disabling an account logs that person out immediately.

**Analytics.** Staff activity is audit, not analytics.

**Note.** Role and permission changes are audited (§15.7) and invalidate the cached role→permission map process-wide via a `user.roles_changed` subscriber.

---

## 23.3 `customers`

**Owns.** Customer profile, addresses, marketing consent, and the admin's view of a customer including their aggregate history.

**Entities.** `customer_profiles`, `addresses`.

**APIs.** Storefront: `GET|PATCH /storefront/profile`, `GET|POST /storefront/addresses`, `PATCH|DELETE /storefront/addresses/:id`, `POST /storefront/addresses/:id/default`. Admin: `GET /admin/customers` (search by name/email/phone, filter by status, spend, order count, tags), `GET /admin/customers/:id` (profile + order history + lifetime value + addresses), `PATCH /admin/customers/:id/status`, `PATCH /admin/customers/:id/notes`, `POST /admin/customers/:id/tags`.

**Dependencies.** `users` (identity), `orders` (order history and totals — through `orders.getCustomerSummary(customerId)`, never by querying `orders` directly), `analytics` (lifetime value).

**Events published.** `customer.profile_updated`, `customer.marketing_consent_changed`, `customer.address_added`.

**Jobs.** `customer.claim_guest_orders` — after email verification, attach matching guest orders to the account (see decision D-3).

**Realtime.** None. A customer editing their own profile does not need a push.

**Analytics.** Supplies new-vs-returning classification and the customer dimension of every sales metric. Lifetime value and order counts are read from rollups, not recomputed per request.

---

## 23.4 `catalog`

**Owns.** Products, variants, product options, categories, product↔category assignment, product media associations, catalog search and filtering, publication status. It is the source of truth for what is sold and at what list price.

**Entities.** `products`, `product_variants`, `product_options`, `product_option_values`, `variant_option_values`, `product_images`, `categories`, `product_categories`, `media_assets`.

**APIs.** Storefront: `GET /products` (filter by category, price range, availability, tags; sort by price/newest/best-selling; cursor paginated), `GET /products/:slug`, `GET /categories`, `GET /categories/:slug/products`, `GET /search?q=`. Admin: full CRUD on `/admin/products`, `/admin/products/:id/variants`, `/admin/products/:id/images`, `/admin/categories`; `POST /admin/products/:id/publish`, `POST /admin/products/:id/archive`, `POST /admin/media` (signed upload), `POST /admin/products/bulk` (bulk status/category changes).

**Dependencies.** `inventory` (availability shown on product pages — batched: one query for all variants on the page, never per variant), `settings` (currency), storage infrastructure (media).

**Events published.** `product.created`, `product.updated` (with a `changed[]` field list), `product.published`, `product.archived`, `product.price_changed` (separate, because it is audited and cache-invalidating), `category.created`, `category.updated`, `category.archived`.

**Jobs.** `media.process_image` — generate thumbnail/medium/large variants with `sharp`, strip EXIF, store, update `media_assets.variants`.

**Realtime.** None to the storefront. `catalog.product_updated` to `admin` only, so two admins editing the same catalogue see each other's changes.

**Analytics.** `product.viewed` and `collection.viewed` behavioural events; product and category dimensions of the sales rollups; best-seller and worst-performer reports read `analytics_product_daily`.

**Rules.** Archiving a product with orders is always archival, never deletion (§4.1). Deleting a category with children is refused (`ON DELETE RESTRICT`); category depth is capped at 3 and enforced on write. Storefront reads only ever see `status='active' AND archived_at IS NULL AND published_at <= now()`, enforced in the repository, not the controller.

---

## 23.5 `inventory`

**Owns.** On-hand and reserved quantities, availability, the movement ledger, low-stock thresholds, reservation and release, and every arithmetic operation on stock. **No other feature ever writes an inventory number.**

**Entities.** `inventory_items`, `inventory_movements`.

**APIs.** Storefront: none directly — availability is projected into product responses. Admin: `GET /admin/inventory` (filter: low stock, out of stock, by category), `GET /admin/inventory/low-stock`, `POST /admin/inventory/adjustments` (single or bulk, requires a reason), `GET /admin/inventory/movements?variantId=` (the ledger), `PATCH /admin/inventory/:variantId/settings` (threshold, tracking, backorder).

**Public service surface** (this is the contract other features use):

```ts
inventory.checkAvailability(lines): AvailabilityResult[]        // no lock, for cart display
inventory.reserveForOrder(tx, orderId, lines): void             // locks, throws INSUFFICIENT_STOCK
inventory.releaseReservation(tx, orderId, lines, reason): void
inventory.commitForShipment(tx, shipmentId, lines): void        // reserved → out of on_hand
inventory.restock(tx, ref, lines, reason): void                 // returns and refund-restocks
inventory.adjust(tx, variantId, delta, reason, actorId): void
```

**Dependencies.** `catalog` (variants must exist), `settings` (default threshold, reservation TTL).

**Events published.** `inventory.adjusted`, `inventory.reserved`, `inventory.released`, `inventory.committed`, `inventory.low_stock`, `inventory.out_of_stock`, `inventory.back_in_stock`.

**Jobs.** `inventory.release_expired` (every minute — release reservations on unpaid orders past the TTL); `inventory.low_stock_scan` (hourly, `singletonKey` per variant so an alert fires once per crossing, not once per scan); `inventory.reconcile` (nightly — assert the ledger sums to the item row, alert on drift).

**Realtime.** `inventory.low_stock` and `inventory.out_of_stock` to `admin:inventory`; `inventory.updated` to `admin:inventory` after a manual adjustment.

**Analytics.** Current stock, low-stock and out-of-stock counts (Layer 1); movement history for shrinkage and restock analysis; sell-through rate combining `analytics_product_daily.units_sold` with on-hand.

**Rules.** Every write goes through the service, inside a transaction, and always writes a movement row alongside the item update. The ledger is what makes stock disputes answerable.

---

## 23.6 `carts`

**Owns.** Cart lifecycle for both authenticated and guest shoppers, cart lines, merging a guest cart into an account on login, abandonment marking, and conversion handoff to `orders`.

**Entities.** `carts`, `cart_items`.

**APIs.** `GET /storefront/cart`, `POST /storefront/cart` (create or adopt), `POST /storefront/cart/items`, `PATCH /storefront/cart/items/:id`, `DELETE /storefront/cart/items/:id`, `POST /storefront/cart/discount`, `DELETE /storefront/cart/discount`, `POST /storefront/cart/merge`. Admin: `GET /admin/carts/abandoned`.

**Dependencies.** `catalog` (variant existence, active status, list price), `inventory` (soft availability check — display only), `pricing` (live totals), `discounts` (code preview and validation), `settings` (currency, tax).

**Events published.** `cart.created`, `cart.abandoned`, `cart.converted`.

**Jobs.** `carts.abandoned_scan` (daily — mark carts inactive beyond the window as abandoned, publish the event); `cleanup.carts` (delete expired guest carts).

**Realtime.** None.

**Analytics.** `cart.item_added` / `cart.item_removed` behavioural events; abandoned-cart count and value; cart→checkout→order funnel.

**Rules that matter.** A cart **never reserves stock** — reservation happens only at order creation. Reserving on add-to-cart lets one shopper deny inventory to everyone by filling a cart, and requires an expiry mechanism for something that is not a commitment. The cost is honest and stated to the user: availability shown in the cart is advisory, and a line can fail at checkout with `INSUFFICIENT_STOCK`. Cart totals are always recomputed live from current prices — the cart stores quantities and variant ids, nothing else. Nothing in the cart is authoritative for the order; the order recomputes everything from scratch.

---

## 23.7 `pricing`

**Owns.** All money arithmetic: line subtotals, discount application, tax, shipping, order totals, and rounding. Pure functions, no database, no I/O.

**Entities.** None. This is the deliberate exception to "every feature has a repository".

**APIs.** None directly. `POST /storefront/checkout/quote` is a thin controller over it, so the shopper sees the exact numbers the order will use before committing.

**Public surface.**

```ts
pricing.calculate(input: {
  lines: { variantId, unitPriceCents, quantity, productId, categoryIds, weightGrams }[]
  discounts: ResolvedDiscount[]      // already validated by the discounts feature
  shipping:  { methodId, priceCents } | null
  tax:       { rateBps, pricesIncludeTax }
}): PricedOrder      // per-line subtotal/discount/tax/total + order totals
```

**Dependencies.** None. That is the point: it is deterministic, exhaustively unit-testable, and identical whether it runs for a cart quote or an order commit.

**Events, jobs, realtime, analytics.** None.

**Rules.** Integer cents throughout. Discounts apply before tax; order-level discounts are distributed across lines proportionally to line subtotal, with the remainder cents assigned to the largest line so the sum of the lines always equals the order total. Rounding is half-up, applied per line, then reconciled. These rules are stated here because an invoice that does not add up is a support ticket, and they are pinned by unit tests.

---

## 23.8 `discounts`

**Owns.** Discount definitions, eligibility evaluation, usage limits and redemption records.

**Entities.** `discounts`, `discount_products`, `discount_categories`, `discount_redemptions`.

**APIs.** Storefront: validation happens through cart and checkout, never as a standalone lookup — a public `GET /discounts/:code` is a code-enumeration oracle. Admin: full CRUD on `/admin/discounts`, `GET /admin/discounts/:id/redemptions`, `POST /admin/discounts/:id/archive`.

**Public surface.**

```ts
discounts.evaluate(code, ctx): ResolvedDiscount     // read-only, for cart/quote
discounts.redeem(tx, discountId, orderId, customerId, amountCents): void  // locks, enforces limits
discounts.releaseRedemption(tx, discountId, orderId): void                // on cancellation
```

**Dependencies.** `catalog` (product/category restrictions), `pricing` (which applies the resolved amount), `orders` (redemption is bound to an order).

**Events published.** `discount.created`, `discount.updated`, `discount.redeemed`, `discount.usage_limit_reached`, `discount.archived`.

**Jobs.** None. Expiry is evaluated at use time — a scheduled "expire discounts" job would be a state machine for a `WHERE ends_at > now()` clause.

**Realtime.** `discount.usage_limit_reached` to `admin` (a promotion selling out is worth knowing immediately).

**Analytics.** Redemptions and discount cost per campaign; discounted vs undiscounted AOV; the `discounts_cents` line in the daily rollup.

**Rules.** Evaluation is always server-side; the client sends a code and receives an amount. Limits are enforced under a row lock at redemption time (§18.4), not at evaluation time — evaluating is advisory, redeeming is authoritative. Cancelling an order releases the redemption so a limited coupon is not consumed by an order that never existed.

---

## 23.9 `orders`

The core aggregate. Everything else exists to serve this transaction.

**Owns.** The order aggregate and its items, the order lifecycle and its three state machines, cancellation, order history and status history, and the checkout transaction that ties five other features together.

**Entities.** `orders`, `order_items`, `order_addresses`, `order_status_history`, `order_discounts`.

**APIs.** Storefront: `POST /storefront/checkout/quote`, `POST /storefront/orders` (idempotency key required), `GET /storefront/orders`, `GET /storefront/orders/:id`, `POST /storefront/orders/:id/cancel` (only while `pending`/`confirmed` and unfulfilled), `POST /storefront/orders/lookup` (guest, order number + email). Admin: `GET /admin/orders` (filter by status, payment status, fulfillment status, customer, date range, total range; search by order number or email), `GET /admin/orders/:id`, `POST /admin/orders/:id/confirm`, `POST /admin/orders/:id/cancel`, `PATCH /admin/orders/:id/notes`, `GET /admin/orders/:id/history`, `GET /admin/orders/export`.

**Dependencies.** `carts` (source lines), `catalog` (authoritative prices and snapshot fields), `inventory` (reservation — must succeed), `pricing` (totals), `discounts` (resolve and redeem), `shipping` (rate for the chosen method), `settings` (currency, tax rate, timezone), `customers`/`users` (identity, addresses).

**The checkout transaction**, precisely:

```
  ── outside the transaction ──
  1  validate request (zod), authenticate, idempotency middleware
  2  load cart + lines; reject if empty or stale
  3  load variants FRESH from catalog → authoritative prices + snapshot fields
  4  evaluate discount code (advisory)
  5  resolve shipping method + rate
  6  pricing.calculate(...) → totals
  ── BEGIN ────────────────────────────────────────────────
  7  re-read variants FOR UPDATE (price changed since step 3 → 409, client re-quotes)
  8  inventory.reserveForOrder(tx, lines)        ← locks in id order; throws INSUFFICIENT_STOCK
  9  discounts.redeem(tx, ...)                   ← locks the discount row; enforces limits
 10  INSERT orders, order_items (snapshots), order_addresses, order_discounts
 11  INSERT order_status_history (→ pending)
 12  UPDATE carts SET status='converted', converted_order_id=…
 13  publish(tx, 'order.placed', {...})          ← outbox row, same transaction
  ── COMMIT ───────────────────────────────────────────────
 14  respond 201 with the order
 15  dispatcher fans out: confirmation email · staff notification · admin realtime · analytics
```

Nothing between `BEGIN` and `COMMIT` performs I/O outside Postgres, which is `CLAUDE.md` §18's rule and is what keeps the transaction short enough that lock contention on a popular variant stays measured in milliseconds.

**Events published.** `order.placed`, `order.confirmed`, `order.status_changed`, `order.cancelled`, `order.completed`, `order.note_added`.

**Jobs.** `order.expire_unpaid` (delayed job scheduled at placement; if still unpaid at the TTL, cancel and release stock — the same code path as `inventory.release_expired`, which is the backstop).

**Realtime.** `order.created` → `admin:orders`; `order.status_changed` → `admin:orders`, `order:<id>`, `user:<customerId>`; `order.cancelled` → the same three.

**Analytics.** The primary source for every sales metric; `checkout.started` (behavioural) vs `order.placed` gives conversion; cancellation rate and reason breakdown.

**State machines.**

```
status:              pending → confirmed → processing → completed
                        └──────┴───────────┴──▶ cancelled   (blocked once any item is fulfilled)

payment_status:      pending → authorized → paid → partially_refunded → refunded
                        ├──▶ failed        └──▶ refunded
                        └──▶ cancelled

fulfillment_status:  unfulfilled → partially_fulfilled → fulfilled → delivered
                                                              └──▶ returned
```

Transitions are declared as a map, validated in the service, and applied with the compare-and-swap `UPDATE` from §18.3. Every transition writes `order_status_history` with actor and reason, and publishes `order.status_changed`.

---

## 23.10 `payments`

**Owns.** Payment records and their state machine, the provider abstraction, webhook ingestion and verification, refund records. It never changes an order's status directly — it requests the change through `orders`' public service, so order rules stay in one place.

**Entities.** `payments`, `refunds`, `webhook_events`.

**APIs.** Storefront: `GET /storefront/orders/:id/payment` (status only). Admin: `GET /admin/payments`, `GET /admin/payments/:id`, `POST /admin/payments/:id/mark-paid` (the manual adapter's capture, idempotency key required), `POST /admin/payments/:id/mark-failed`, `POST /admin/orders/:id/refunds` (idempotency key required), `GET /admin/refunds`. Webhooks: `POST /webhooks/payments/:provider`.

**Provider interface.**

```ts
export interface PaymentProvider {
  readonly name: string
  createPayment(input: { orderId, amountCents, currency, idempotencyKey, metadata })
    : Promise<{ providerPaymentId?: string; status: PaymentStatus; clientSecret?: string }>
  capture?(providerPaymentId: string, amountCents: number): Promise<{ status: PaymentStatus }>
  refund(input: { providerPaymentId?, amountCents, idempotencyKey })
    : Promise<{ providerRefundId?: string; status: RefundStatus }>
  verifyWebhook(rawBody: Buffer, headers: Record<string,string>)
    : { eventId: string; type: string; payload: unknown }        // throws if invalid
}
```

The **manual adapter** (v1) implements this against nothing external: `createPayment` records a `pending` payment; capture is a staff action; `refund` records the refund as `succeeded` immediately; `verifyWebhook` throws. A hosted PSP is a second file implementing the same five methods, plus a webhook secret in config. No caller changes.

**Dependencies.** `orders` (the order being paid; status changes requested through its service), `settings` (currency).

**Events published.** `payment.created`, `payment.succeeded`, `payment.failed`, `payment.cancelled`, `refund.created`, `refund.succeeded`, `refund.failed`.

**Jobs.** `webhook.process` (verify → dedupe → apply); `webhook.sweep` (re-enqueue unprocessed rows every 15 min); `payment.check_pending` (delayed, for future async providers).

**Realtime.** `payment.succeeded` → `admin:payments`, `order:<id>`, `user:<customerId>`; `payment.failed` → `admin:payments`, `order:<id>`.

**Analytics.** Paid vs pending vs failed volume; refund rate and refunded amount; payment-method mix; the `refunds_cents` line in the daily rollup.

**Rules.** Every mutating payment operation carries an idempotency key. Webhooks respond `200` before processing and dedupe on `(provider, provider_event_id)`. Refunds cannot exceed `amount_cents - refunded_cents` (`CHECK` plus a service guard); a refund with `restock=true` calls `inventory.restock` in the same transaction. `payment.succeeded` triggers `orders.markPaid()`, which confirms the order and cancels its `order.expire_unpaid` job.

---

## 23.11 `shipping`

**Owns.** Shipping zones, methods and rate calculation; shipments; tracking; fulfillment state; delivery confirmation.

**Entities.** `shipping_zones`, `shipping_methods`, `shipments`, `shipment_items`.

**APIs.** Storefront: `GET /storefront/checkout/shipping-methods?country=&subtotal=&weight=` (available methods with prices), `GET /storefront/orders/:id/shipments` (tracking). Admin: CRUD `/admin/shipping-zones`, `/admin/shipping-methods`; `POST /admin/orders/:id/shipments` (select items and quantities), `PATCH /admin/shipments/:id` (carrier, tracking), `POST /admin/shipments/:id/ship`, `POST /admin/shipments/:id/deliver`, `POST /admin/shipments/:id/return`, `GET /admin/shipments?status=`.

**Public surface.** `shipping.getAvailableMethods(ctx)`, `shipping.getRate(methodId, ctx)` — used by cart, quote and checkout so the rate a shopper sees is computed by exactly one function.

**Dependencies.** `orders` (shipments belong to orders; fulfillment status changes requested through `orders`), `inventory` (`commitForShipment` moves reserved stock out of on-hand), `settings` (weight unit).

**Events published.** `shipment.created`, `shipment.shipped`, `shipment.delivered`, `shipment.returned`, `shipment.failed`.

**Jobs.** `shipment.delivery_check` (placeholder for carrier polling when a carrier integration is added); shipping notification emails via subscribers.

**Realtime.** `shipment.created`, `shipment.updated`, `shipment.delivered` → `admin:orders`, `order:<id>`, `user:<customerId>`. This is the highest-value realtime path for the customer — the tracking page updating without a refresh.

**Analytics.** Pending shipments, in transit, delivered, returned (Layer 1); average time from order to ship and ship to delivery; return rate; shipping revenue vs cost.

**Rules.** Creating a shipment commits inventory (reserved → out of on-hand) and recomputes the order's `fulfillment_status` from the sum of `shipment_items` versus `order_items.quantity` — partial fulfillment is normal and is derived, never set by hand. A returned shipment restocks through `inventory.restock`. An order cannot be cancelled once any shipment has shipped.

---

## 23.12 `notifications`

**Owns.** In-app notifications, per-user preferences, channel routing (in-app / email / realtime), and deduplication. It is the single place that decides *who* is told *what*, through *which* channel.

**Entities.** `notifications`, `notification_preferences`.

**APIs.** Storefront: `GET /storefront/notifications` (cursor paginated), `GET /storefront/notifications/unread-count`, `POST /storefront/notifications/:id/read`, `POST /storefront/notifications/read-all`, `GET|PATCH /storefront/notifications/preferences`. Admin: the same under `/admin/notifications` for staff-audience notifications.

**Dependencies.** `users` (recipients and their permissions — a staff notification goes to holders of a permission, not to a hard-coded list), email infrastructure, realtime infrastructure.

**Events published.** `notification.created`. It is mostly a consumer.

**Jobs.** `notification.dispatch` — the fan-out worker: resolve recipients, check preferences, insert the notification row (idempotent on `dedupe_key`), emit realtime, enqueue email if the channel applies.

**Realtime.** `notification.created` → `user:<userId>`, carrying the unread count so the badge updates in one message.

**Analytics.** Delivery and read rates per type — useful for pruning notifications nobody opens.

**Routing table** (the configuration that makes §27 of `CLAUDE.md` concrete):

| Notification type | Audience | in-app | email | realtime |
|---|---|:--:|:--:|:--:|
| `order.placed` | customer | ✔ | ✔ | ✔ |
| `order.placed` | staff | ✔ | digest | ✔ |
| `payment.succeeded` | customer | ✔ | ✔ | ✔ |
| `payment.failed` | staff | ✔ | — | ✔ |
| `order.cancelled` | customer | ✔ | ✔ | ✔ |
| `shipment.shipped` | customer | ✔ | ✔ | ✔ |
| `shipment.delivered` | customer | ✔ | ✔ | ✔ |
| `refund.succeeded` | customer | ✔ | ✔ | ✔ |
| `inventory.low_stock` | staff | ✔ | digest | ✔ |
| `discount.usage_limit_reached` | staff | ✔ | — | ✔ |
| `job.dead_lettered` (critical queues) | staff | ✔ | ✔ | ✔ |

`dedupe_key` is deterministic (`order.placed:<orderId>:<userId>`), so a retried dispatch job produces one notification and one email — satisfying "users should not receive duplicate notifications" structurally rather than by hoping the job runs once.

---

## 23.13 `analytics`

**Owns.** Behavioural event storage, rollup computation, metric definitions, dashboard and report queries. It writes only its own tables and never participates in a business transaction.

**Entities.** `analytics_events`, `analytics_daily_sales`, `analytics_product_daily`.

**APIs.** Storefront: `POST /storefront/analytics/events` (batched, allowlisted, rate limited). Admin: `GET /admin/dashboard/summary`; `GET /admin/analytics/{sales,orders,customers,products,inventory,shipping}`; `GET /admin/analytics/funnel`; `POST /admin/analytics/rebuild` (owner only, audited); `POST /admin/reports` + `GET /admin/reports/:id`.

**Dependencies.** Read-only across the transactional tables, via the single sanctioned exception in §3.2 — confined to `analytics.rollup.repository.ts`.

**Events published.** `report.generated`, `analytics.rollup_failed`.

**Jobs.** `analytics.ingest` (batch insert behavioural events); `analytics.rollup` (5-minutely for today, nightly for a 7-day correction window); `report.generate` (CSV to storage, then notify); `cleanup.analytics` (180-day retention).

**Realtime.** `dashboard.metrics` → `admin`, throttled to at most one per 10 seconds, carrying only the small live counters (orders today, pending, awaiting shipment, revenue today).

**Analytics requirements it satisfies.** Every metric listed in `CLAUDE.md` §32: sales (gross, net, revenue, AOV, over time, by product, by category), orders (total, completed, cancelled, pending, over time), customers (total, new, returning, frequency, lifetime value), products (best sellers, worst performers, product and category revenue), inventory (current, low, out of stock, movements), shipping (pending, shipped, in transit, delivered, returns).

---

## 23.14 `settings`

**Owns.** The single-row store configuration and its cache.

**Entities.** `store_settings`.

**APIs.** Storefront: `GET /storefront/settings` — a **whitelisted public subset** (store name, currency, contact email, whether guest checkout is on). Admin: `GET|PATCH /admin/settings`.

**Dependencies.** None. Nearly everything depends on it.

**Events published.** `settings.updated` (with `changed[]`), which invalidates the process cache.

**Jobs.** None.

**Realtime.** `settings.updated` → `admin`.

**Analytics.** Provides the timezone every date bucket depends on and the currency every amount is denominated in.

**Rules.** Cached in process for 60 seconds and on `settings.updated`; the row is created by seed and can never be deleted (`CHECK (id = 1)`). The public subset is built by an explicit mapper — the admin serializer is never reused for the storefront.

---

## 23.15 `audit`

**Owns.** The append-only administrative audit trail and its query API.

**Entities.** `audit_logs`.

**APIs.** `GET /admin/audit-logs` (filter by actor, action, resource type, resource id, date range; owner and `audit:read` only).

**Dependencies.** None; every admin service calls `audit.record(...)`.

**Events, jobs, realtime.** None. Audit is deliberately synchronous and inside the business transaction: if the change committed, its audit record committed with it. An asynchronous audit trail can lose exactly the record that matters.

**Analytics.** None. Audit answers "who changed this", which is a different question from "how is the business doing", and conflating them makes both worse.

---

# 24. Phased implementation plan

Ordered strictly by dependency: nothing in a phase depends on anything in a later one. Each phase ends in a state that is deployable and tested — not a half-wired layer waiting for the next phase to make sense.

```
P0 Platform ──▶ P1 Async spine ──▶ P2 Identity ──▶ P3 Settings & media ──▶ P4 Catalog
                                                                              │
                                                                              ▼
P9 Discounts ◀── P8 Shipping ◀── P7 Payments ◀── P6 Orders ◀── P5 Cart & pricing ◀── inventory
      │                                              ▲                    ▲
      └──────────────────────────────────────────────┘                    │
                                                   (P4b Inventory) ───────┘
                          │
                          ▼
   P10 Notifications & realtime ──▶ P11 Analytics ──▶ P12 Hardening & launch
```

---

## Phase 0 — Platform skeleton

*No business features. This is the floor everything stands on, and retrofitting it later means touching every file.*

**Build.** TypeScript project setup (strict, path aliases, ESLint with the boundary rules from §2.2, Prettier). `config/env.ts` with the Zod schema and fail-fast boot. pino logger with redaction and `AsyncLocalStorage` request context. `AppError` hierarchy, error-code registry, central error handler, `notFound`. Response envelope helpers and pagination helpers. `pg` pool, `withTransaction` with ALS propagation and the retry wrapper, SQLSTATE→`AppError` mapping, slow-query logging. Migration runner + CLI, migration `0001` (extensions, `updated_at` trigger function, `schema_migrations`). Express app assembly with the §7.5 middleware order. `/healthz`, `/readyz`, `/version`. Graceful shutdown. Vitest + testcontainers harness, factories scaffold, transaction-rollback isolation. Dockerfile, docker-compose (Postgres + Mailhog), GitHub Actions pipeline.

**Exit criteria.** `npm run dev` boots; `/healthz` and `/readyz` respond correctly with the database up and down; a deliberately thrown `AppError` and a deliberately thrown unknown error both produce the right envelope with a request id; migrations apply and re-applying is a no-op; a checksum change is refused; CI runs green end to end; the boundary lint rules actually fail on a deliberate violation.

---

## Phase 1 — Asynchronous spine

*Events, queue, email. Deliberately before any feature, because Phase 2 already needs verification email and every later phase publishes events. Building this after the first feature means retrofitting the outbox into working code.*

**Build.** Migration `0002` (`domain_events`, `idempotency_keys`) and `0003` (`email_messages`, `email_suppressions`). pg-boss setup, queue registry with typed payload schemas, `enqueue()`, `register()`, per-queue retry policy and dead-letter queues. Worker entrypoint, job context and logger binding, graceful drain. Event catalogue with Zod payloads, `publish(tx, …)`, the outbox dispatcher (poll + `pg_notify` nudge + `SKIP LOCKED`), the subscriber registry. `EmailProvider` interface, SMTP and console adapters, MJML+Handlebars renderer with build-time compilation, `emailService.enqueue`, the `email.send` worker, `_layout` plus one real template. Idempotency middleware. `cleanup.idempotency` and `cleanup.events` — the only cleanup jobs whose tables exist yet; each remaining `cleanup.*` job ships in the phase that creates its table.

**Exit criteria.** An event published inside a rolled-back transaction never dispatches; published inside a committed transaction it dispatches exactly once and its subscribers run. A job that throws retries with backoff and lands in its dead-letter queue. Mailhog receives a rendered email in development. The idempotency middleware replays a stored response, rejects a mismatched body, and two concurrent identical requests execute the handler once. Killing the worker mid-job results in the job being retried, not lost.

---

## Phase 2 — Identity and access

**Build.** Migration `0004` (users, roles, permissions, role_permissions, user_roles, sessions, auth_tokens, login_attempts) and the seed for roles, permissions, grants and the owner account. `users` feature (staff CRUD, role assignment, cached permission resolution with event-driven invalidation). `auth` feature: register, login, refresh with rotation and reuse detection, logout, logout-all, email verification, password reset and change, session listing and revocation. `authenticate` and `authorize` middleware, the `Actor` abstraction, argon2 hashing, throttling and lockout. Email templates: welcome, verification, reset. Audit table (`0005`), `audit.record`, and `cleanup.sessions`.

**Exit criteria.** The full auth flow works end to end. Refresh-token reuse revokes the entire family. Password change revokes all sessions. Login is rate limited and locks the account after repeated failure. The response time for an unknown email matches that for a wrong password. The authorization matrix test passes for every role against a set of probe routes. Role change takes effect on the next request, without a restart.

---

## Phase 3 — Settings and media

**Build.** Migration `0006` (`store_settings`, `media_assets`) and seed. `settings` feature with the process cache, the public subset mapper, and admin update with audit. `StorageProvider` interface with Supabase and local adapters, signed upload URLs, magic-byte validation, the `media.process_image` worker producing size variants with `sharp`.

**Exit criteria.** Settings are readable, updatable, audited, cached and invalidated by their own event. An image uploads, processes into variants, strips EXIF, and its URLs resolve. A non-image or oversized upload is rejected. The public settings endpoint exposes only the whitelisted fields — asserted by a test that fails when a new column is added without a decision.

---

## Phase 4 — Catalog

**Build.** Migration `0007`. Categories (tree with a depth cap, recursive-CTE reads, archival with `RESTRICT`). Products, variants, options and option values, images, product↔category. Admin CRUD with validation and audit on price changes. Storefront listing with filters, sorting, cursor pagination and full-text search over `search_vector`. Publication rules enforced in the repository. Bulk operations.

**Exit criteria.** A product with multiple variants and options can be created, published, listed, searched, filtered and archived. Storefront reads never return drafts or archived products — asserted directly. Search returns sensible ranking. A category with children cannot be deleted. Listing 1 000 products stays under the latency budget with the planned indexes (verified with `EXPLAIN ANALYZE`, not by feel).

---

## Phase 4b — Inventory

*Same phase boundary as catalog conceptually, but a separate step because it is where correctness starts to matter.*

**Build.** Migration `0008`. `inventory_items` auto-created per variant, `inventory_movements` ledger, the full public service surface (§23.5), admin adjustments with mandatory reasons and audit, low-stock and movement views, `inventory.low_stock_scan` and `inventory.reconcile` jobs, `inventory.*` events.

**Exit criteria.** Every stock write produces a ledger row. Reconciliation passes after a randomized sequence of operations. Adjustments below zero are refused by both the service and the `CHECK`. Low-stock alerts fire once per threshold crossing, not once per scan. Availability is batch-projected into product responses with one query per request.

---

## Phase 5 — Cart and pricing

**Build.** `pricing` as pure functions with an exhaustive unit-test suite (including rounding and remainder distribution). Migration `0009` (carts, cart_items; `converted_order_id` without its foreign key, which arrives in `0010`). Cart lifecycle for guests and authenticated users, guest→account merge on login, live totals, soft availability display, `POST /checkout/quote`, `carts.abandoned_scan` and `cleanup.carts`. The `DiscountResolver` port is defined here and returns an empty list until Phase 9 — so Phase 9 is a plug-in, not a rewrite.

**Exit criteria.** Cart totals match hand-computed expected values across a table of cases including tax-inclusive pricing and zero-value edge cases. A guest cart merges into an account without duplicating lines or losing quantities. Cart never touches inventory numbers. The quote endpoint returns exactly what the order will charge, asserted by a test that runs both paths over the same input.

---

## Phase 6 — Orders and checkout

*The centre of the system. Everything before this exists to make this phase possible; everything after extends it.*

**Build.** Migration `0010` (orders and its tables, plus the `carts.converted_order_id` foreign key). The three state machines and their transition maps. The checkout transaction exactly as sequenced in §23.9. Snapshotting into `order_items`. `order_status_history` on every transition. Storefront order list, detail, cancellation and guest lookup. Admin order list with the full filter set, detail, confirm, cancel, notes, history, export. Idempotency required on `POST /orders`. `order.*` events. `order.expire_unpaid` delayed job. Order-confirmation and cancellation email templates and their subscribers.

**Exit criteria.** The concurrency test passes: two simultaneous purchases of the last unit produce exactly one order. The atomicity test passes: an induced failure at any step leaves no order, no reservation, no movement, no event. Idempotency: a duplicated request produces one order. Cancellation releases stock, writes the ledger and history, and publishes its event; cancelling a fulfilled order is refused. `order.placed` is in `domain_events` in the same transaction as the order. Order items are true snapshots — changing the product afterwards does not alter the order. Every illegal transition throws.

---

## Phase 7 — Payments

**Build.** Migration `0011`. `PaymentProvider` interface, manual adapter, payment state machine, payment records created at checkout, admin mark-paid and mark-failed with idempotency keys, refunds with `restock` handling and the over-refund guard, webhook route with raw-body capture and signature verification, `webhook_events` dedupe, `webhook.process` and `webhook.sweep` jobs, `payment.*` and `refund.*` events, payment-receipt and refund email templates.

**Exit criteria.** A duplicate webhook produces one state transition and one email. Marking paid twice with the same idempotency key produces one transition. Over-refunding is rejected at both the service and the constraint. A refund with restock returns stock and writes the ledger. `payment.succeeded` confirms the order and cancels its expiry job. An unverified webhook signature is rejected and never processed.

---

## Phase 8 — Shipping and fulfillment

**Build.** Migration `0012` plus the deferred `orders.shipping_method_id` FK. Zones, methods and rate calculation wired into cart, quote and checkout. Shipment creation with item selection, inventory commit on shipment, derived `fulfillment_status`, ship/deliver/return transitions, tracking fields, customer tracking view, admin shipment queue. `shipment.*` events. Shipping notification email templates.

**Exit criteria.** Partial fulfillment derives the correct order fulfillment status across a matrix of cases. Creating a shipment moves reserved stock out of on-hand exactly once and writes the ledger. A return restocks. An order with a shipped shipment cannot be cancelled. Rates shown in the cart, the quote and the order are produced by the same function — asserted, not assumed.

---

## Phase 9 — Discounts and coupons

**Build.** Migration `0013` plus the deferred `order_discounts.discount_id` FK. Discount CRUD, the eligibility engine (window, minimum, product/category restriction, customer requirement, active flag), `evaluate` and `redeem`/`releaseRedemption`, the row-locked usage-limit enforcement from §18.4, redemption ledger, cart and checkout integration through the `DiscountResolver` port from Phase 5, admin redemption reporting, `discount.*` events.

**Exit criteria.** Concurrent redemption of a single-use discount yields exactly one success. Every rejection reason has its own error code and a test. Cancelling an order releases its redemption. A discount code cannot be enumerated through any public endpoint. Discount amounts appear correctly in order totals and in `order_discounts` snapshots.

---

## Phase 10 — Notifications and realtime

**Build.** Migration `0014` (`notifications`, `notification_preferences`). The notification service, the routing table from §23.12, `notification.dispatch` worker with deterministic dedupe keys, notification APIs and preferences. Socket.IO server, handshake authentication, the two namespaces, room builders with join authorization, `emitters.ts`, the realtime subscribers, socket disconnection on session revocation, connection limits and throttling. Staff digest emails.

**Exit criteria.** A socket with an invalid, expired or wrong-type token is refused. A customer cannot join another customer's `order:` room. An event fired by a background job reaches the browser through the same path as one fired by a request. A retried dispatch job produces one notification and one email. Revoking a session disconnects its sockets. A burst of 50 orders does not produce 50 dashboard broadcasts.

---

## Phase 11 — Analytics and dashboard

**Build.** Migration `0015`. Rollup SQL implementing the §13.2 definitions, `analytics.rollup` job (5-minutely today, nightly 7-day window), store-timezone date helper, behavioural ingestion endpoint with allowlist and rate limits, `analytics.ingest` worker, `analytics_events` retention cleanup, the dashboard summary endpoint with its 30-second cache, detailed analytics endpoints with grouping and CSV, `report.generate` for large exports, `POST /analytics/rebuild`, the throttled `dashboard.metrics` realtime event.

**Exit criteria.** Rollups recomputed twice produce identical rows. A backfill over a historical range matches numbers computed directly from the transactional tables. A refund appears on the refund's date, not the order's. DST boundaries bucket correctly. The dashboard summary responds within budget on a seeded dataset of ~100 000 orders. Every metric in `CLAUDE.md` §32 has an endpoint that returns it.

---

## Phase 12 — Hardening, documentation and launch

**Build.** Rate limits applied per the §16.7 table. The full authorization-matrix test generated from the route table. `npm audit` and secret scanning as CI gates. Load testing of the checkout path with `EXPLAIN ANALYZE` on every query it touches; index tuning against real plans. Optional metrics endpoint (§15.6). OpenAPI generation and `/docs`. The `docs/` set required by `CLAUDE.md` §55 (architecture, database, api, authentication, orders, inventory, shipping, payments, workers, realtime, analytics). Admin operational surfaces: failed jobs with retry, unprocessed webhooks, failed emails, reconciliation drift. Backup restore drill. Staging soak with seeded traffic.

**Exit criteria.** No high or critical dependency advisories. Every admin route has an authorization rule, proven by the generated test. Checkout p95 within budget under target concurrency. The restore drill succeeded and is written down. The documentation set is complete and matches the code. A full production-like rehearsal — place, pay, ship, deliver, refund — passes on staging.

---

## 24.1 Sequencing notes

- **Phase 1 before Phase 2** is the least obvious ordering choice and the most valuable. Auth needs email; every feature needs events. Building the spine first means no feature is ever written twice.
- **Inventory before orders** is non-negotiable — the order transaction is defined by its inventory interaction.
- **Payments after orders** because a payment exists for an order. With the manual adapter, an order can be placed and confirmed before Phase 7 exists, which is why Phase 6 is independently deployable.
- **Discounts late** is safe only because the `DiscountResolver` port is defined in Phase 5. Without that port, Phase 9 would mean reopening the checkout transaction.
- **Realtime after the events it carries** avoids inventing events to emit.
- **Analytics last among features** because it reads everything; building it earlier means rewriting it as each source appears.
- Frontend work can begin against Phase 4's catalog APIs and proceed roughly one phase behind the backend; the OpenAPI document from Phase 12 should be generated continuously from Phase 4 onward so the frontends always have a current contract.

---

# 25. Decisions that need your approval before Phase 0

Per `CLAUDE.md` §69, these materially affect the schema, security or lifecycle, so they are surfaced rather than assumed. Each has a recommendation and a reversal cost.

**D-1 — Product variants.** *Recommended: include them from day one.* Price, SKU, weight and stock live on `product_variants`; every product gets a `Default` variant automatically, so a store selling simple products never sees the complexity. **Reversal cost if deferred: very high.** `order_items`, `cart_items`, `inventory_items`, `analytics_product_daily` and every catalog API key on `variant_id`. Adding variants later means a data migration across the entire order history.

**D-2 — Three orthogonal order status fields** (`status`, `payment_status`, `fulfillment_status`) instead of the single flat vocabulary in `CLAUDE.md` §17, with a derived display status that reproduces that vocabulary for the UI (mapping table in §5.6). *Recommended.* A single column cannot express "paid but not yet shipped" or "shipped and partially refunded" without a combinatorial explosion of state names. **Reversal cost: high** — it is the shape of the order state machine.

**D-3 — Guest checkout enabled, with later claiming.** *Recommended.* `orders.customer_id` is nullable and the order always carries an email; guest order lookup requires order number plus email and is rate limited; verified accounts claim matching guest orders via a job. Turning guest checkout off later is a settings flag; turning it on later is a schema change. **Reversal cost: moderate.**

**D-4 — Tax: a single store-level rate in basis points, applied to the discounted subtotal, stored per line and per order.** *Recommended for v1.* Real jurisdictional tax means a tax-provider integration and a per-address rate table; that is a project of its own. The order schema already stores tax per line and per order, so a provider can be introduced later without touching order history. **Reversal cost: low**, provided we store per-line tax now, which the schema does. Please confirm the store's tax situation is simple enough for a flat rate.

**D-5 — Single currency, stored on every order.** *Recommended.* Multi-currency requires exchange-rate snapshots, per-currency pricing and reporting in a base currency — a large feature with no stated requirement. The `currency` column on orders and carts means adding it later does not invalidate history. **Reversal cost: moderate.**

**D-6 — Carts do not reserve stock.** *Recommended.* Reservation happens at order creation and expires with the unpaid order. The trade-off (a cart line can fail at checkout) is stated in §23.6. **Reversal cost: low** — reservation-on-add would be an additive change to the same `reserved` column.

**D-7 — One `users` table for customers and staff, with RBAC.** *Recommended,* because `CLAUDE.md` §10 requires centralised authentication and two identity tables would duplicate it. Customer-specific data is in `customer_profiles`. **Reversal cost: high.**

**D-8 — Media on Supabase Storage behind a `StorageProvider` interface,** with signed uploads and worker-side re-encoding. *Recommended*; the alternative (files on the API server) does not survive a second instance. **Reversal cost: low.**

**D-9 — Order numbers are a sequence with a configurable prefix** (`#1001`), unique, human-quotable, and separate from the UUID primary key. *Recommended.* Note that sequential numbers disclose order volume; a randomized-suffix scheme is available if that matters commercially. **Reversal cost: low before launch, high after.**

**D-10 — Refunds in v1 are records, not money movements,** because the manual payment adapter has no PSP to call. A refund marks the payment and order state, optionally restocks, and emails the customer; the actual transfer happens outside the system. *Recommended given the payment decision.* **Reversal cost: none** — the real adapter fills in `provider.refund()`.

Two smaller confirmations, low cost either way, decided as stated unless you say otherwise: **soft-delete/archival everywhere** an order could reference the row (products, variants, categories, discounts, addresses), and **an optional Prometheus metrics endpoint** in Phase 12 rather than relying solely on platform metrics.

---

# 26. What this plan deliberately does not include

Stated so the omissions are visible decisions rather than gaps: multi-tenancy or store isolation of any kind (`CLAUDE.md` §57); microservices, Kubernetes, a message broker or a second database (§58); GraphQL; product reviews, wishlists, gift cards, subscriptions or loyalty; a headless CMS; multi-warehouse inventory; carrier API integrations and label printing; a recommendation engine; internationalisation and translated content; SSO or social login; two-factor authentication for staff (a seam exists in `auth`; the feature does not); Elasticsearch (Postgres full-text search covers a single store's catalogue comfortably).

Each is a real feature with a real cost. None is required by the current requirements, and every one of them is easier to add to a clean modular monolith than to a prematurely distributed system.
