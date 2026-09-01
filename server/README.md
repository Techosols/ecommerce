# Ecommerce server

Backend for a single-store Ecommerce platform: a modular monolith on Node.js,
Express 5, TypeScript and PostgreSQL.

**Current state: feature-complete for a single-store shop selling with cash on
delivery.** 931 tests pass against real PostgreSQL.
The platform layer is complete — configuration, database, migrations, logging,
errors, validation, security, routing, health, queue, workers, email, realtime,
domain events, idempotency and graceful shutdown. So is authentication and
authorization: registration, login, refresh rotation with reuse detection,
session management, password change and reset, email verification, roles and
permissions. And so is the operator layer: store settings, object storage behind
a `StorageProvider` seam (Supabase in production), the media upload and
processing pipeline, the administrative audit trail and staff invitations.

And the catalogue: products with options and variants, categories, collections,
publication to a sales channel, and handles that survive being renamed.

And inventory: locations, inventory items, per-location stock levels, an
append-only movement ledger, and reservations that cannot oversell — proven
against real PostgreSQL under genuinely concurrent load.

And commerce: carts that never store a price, checkout in a single transaction,
orders that snapshot what was bought, cash on delivery with its own eligibility
rules and surcharge, shipping zones and rates, discounts that cannot be spent
twice, refunds that cannot exceed what was captured, customer accounts,
notifications, and the analytics rollups behind the dashboard.

Payment methods other than cash on delivery are declared but switched off:
turning one on needs a gateway integration, not a flag. See
[`docs/payments.md`](docs/payments.md).

- [`docs/architecture.md`](docs/architecture.md) — how the platform fits together
- [`docs/authentication.md`](docs/authentication.md) — auth and authorization in full
- [`docs/storage-and-media.md`](docs/storage-and-media.md) — storage, media, settings, audit, invitations
- [`docs/catalogue-model.md`](docs/catalogue-model.md) — the commerce model: products, variants, pricing
- [`docs/inventory.md`](docs/inventory.md) — stock, locations, reservations, concurrency
- [`docs/orders.md`](docs/orders.md) — carts, checkout, the order lifecycle, shipping, discounts
- [`docs/payments.md`](docs/payments.md) — cash on delivery, and how to add a second method
- [`docs/operations.md`](docs/operations.md) — deploying, probes, the runbook

---

## Getting started

```bash
docker compose up -d          # PostgreSQL 16 + Mailhog
cp .env.example .env          # then edit DATABASE_URL and JWT_ACCESS_SECRET
npm ci
npm run db:migrate
SEED_OWNER_EMAIL=you@example.com SEED_OWNER_PASSWORD='a-long-passphrase' npm run db:seed
npm run dev                   # API on :4000, workers in-process
```

Verify:

```bash
curl localhost:4000/healthz   # {"status":"ok",…}
curl localhost:4000/readyz    # database + migration checks
```

Mailhog's inbox is at <http://localhost:8025>. To prove the whole mail pipeline
works in a new environment:

```bash
node --import tsx scripts/dev/send-test-email.ts you@example.com
```

---

## Running it

|               | Command                      | Notes                                                           |
| ------------- | ---------------------------- | --------------------------------------------------------------- |
| API (dev)     | `npm run dev`                | Watch mode. `RUN_WORKERS_IN_PROCESS=true` hosts the worker too. |
| Worker (dev)  | `npm run dev:worker`         | Only needed when debugging workers in isolation.                |
| API (prod)    | `npm run build && npm start` |                                                                 |
| Worker (prod) | `npm run start:worker`       | Same image, different command.                                  |

## Migrations

```bash
npm run db:migrate                      # apply pending
npm run db:migrate:status               # applied / pending / drifted
npm run db:migrate:create -- add_orders # scaffold migrations/NNNN_add_orders.sql
npm run db:reset                        # drop and rebuild (test/dev databases only)
npm run db:seed                         # create the first owner (idempotent)
```

Forward-only. Never edit an applied migration — the runner checksums them and
will refuse to continue.

## Tests

```bash
npm test                  # everything
npm run test:unit         # no database required
npm run test:integration  # requires TEST_DATABASE_URL
npm run test:watch
```

Integration tests need a database whose name contains `test`:

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/ecommerce_test npm test
```

Without it the integration suites skip themselves; unit tests still run.

The Supabase Storage tests run against a **fake SDK client** by default and
prove only that the adapter translates the interface correctly. To exercise the
real service, opt in with a throwaway project:

```bash
SUPABASE_TEST_URL=https://<project>.supabase.co \
SUPABASE_TEST_SERVICE_ROLE_KEY=<service role key> \
SUPABASE_TEST_BUCKET=media-test \
npm test -- tests/integration/storage.supabase.live.test.ts
```

Unset, that suite skips and says so. Nothing else in the repository touches
Supabase over the network.

## Checks

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # ESLint, including the architectural boundary rules
npm run format      # Prettier
npm run check       # all three plus the test suite
```

---

## Layout

```
src/
├── main/            api.ts · worker.ts · shutdown.ts     process entrypoints
├── app.ts           express assembly (no listen — importable by tests)
├── router.ts        /api/v1/{auth,storefront,admin,webhooks}
├── config/          env.ts is the only reader of process.env
├── infrastructure/  database · queue · email · realtime · storage · logging · observability
│   └── storage/     provider.ts (the seam) · keys · sniff · providers/{supabase,local,memory}
├── shared/          errors · http · middleware · validation · auth · types
├── events/          catalog · publish · dispatcher · subscribers
├── jobs/            worker handlers (email · media · cleanup)
├── features/        auth · users · settings · media · audit · catalogue · inventory
└── routes/          health.routes.ts · localStorage.routes.ts (dev only)
```

Two rules hold the structure together, both enforced by ESLint:
a feature is imported only through its `index.ts`, and `infrastructure/` never
imports `features/`.

---

## Next

Carts and checkout. The reservation seam is already in place —
`reservationsService.reserve` with `ownerType: 'cart'` — so a cart holds stock
the database has agreed to, never a quantity the browser claimed.
`docs/inventory.md` §16 records what a cart may and may not assume.
