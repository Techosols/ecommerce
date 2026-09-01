# Server architecture — foundation

This documents what exists **today**. The full design lives in
`../../docs/backend-implementation-plan.md`; section references below (§) point
into it. Anything described there but not here has not been built yet.

Status: **foundation, identity/access, settings + media, and the catalogue
complete.** Authentication and authorization are in place (see
[authentication.md](authentication.md)); object storage, media and the audit
trail are in place (see [storage-and-media.md](storage-and-media.md)); products,
options, variants, categories, collections and publication are in place (see
[catalogue-model.md](catalogue-model.md)); and inventory — locations, items,
levels, movements and reservations — is in place (see
[inventory.md](inventory.md)). Carts, orders and payments do not exist yet.

---

## 1. Shape

One codebase, one image, two processes.

```
                    ┌──────────────── one image ────────────────┐
  process: api      │                                           │  process: worker
  ┌─────────────────┴────────┐                 ┌────────────────┴─────────┐
  │ Express (HTTP)           │                 │ pg-boss workers          │
  │ Socket.IO                │                 │ cron schedules           │
  │ pool → DATABASE_URL      │                 │ outbox dispatcher        │
  │ (pooled connection)      │                 │ pool → DATABASE_DIRECT_URL│
  └─────────────┬────────────┘                 └────────────┬─────────────┘
                └───────────────┬─────────────────────────── ┘
                                ▼
                          PostgreSQL 16
```

In development `RUN_WORKERS_IN_PROCESS=true` hosts the worker inside the API, so
one command runs everything. In production they are separate containers running
the same image with different commands — the worker can never drift from the API.

**The API does not start pg-boss.** It writes domain events inside the business
transaction; the worker's dispatcher turns those into jobs (§12.1). If an API
route ever needs to enqueue directly, start a sender-mode pg-boss instance
(`supervise: false, schedule: false`) rather than giving the API a full worker.

### Two connection roles

Supabase's transaction pooler cannot serve session-level features — advisory
locks and `LISTEN/NOTIFY` (§4.2). So:

| Role     | URL                             | Used by                            |
| -------- | ------------------------------- | ---------------------------------- |
| `api`    | `DATABASE_URL` (Supabase :6543) | HTTP request handling              |
| `worker` | `DATABASE_DIRECT_URL` (:5432)   | pg-boss, the dispatcher's `LISTEN` |
| `cli`    | `DATABASE_DIRECT_URL`           | migrations                         |

Locally the two URLs are usually the same.

---

## 2. Layers and boundaries

```
Interface       routes · middleware · controllers      HTTP shape, auth, validation
Domain          services · policies · state machines   business rules
Data            repositories · SQL                     persistence only
Infrastructure  db · queue · email · realtime · log    technical capability only
```

Enforced by ESLint, not by convention:

- `features/*` may only be imported through its `index.ts`
- `infrastructure/` may not import `features/`
- only `config/env.ts` may read `process.env`
- no tagged SQL templates — every statement is parameterised

A violation fails `npm run lint`, which fails CI.

---

## 3. Request lifecycle

```
requestId + AsyncLocalStorage context   ← every log line picks these up
  → pino-http access log (probes excluded)
  → helmet security headers
  → CORS allowlist (CLIENT_ORIGIN, ADMIN_ORIGIN — no wildcard)
  → express.json (256kb)   ·  webhooks bypass this and keep the raw body
  → surface router: /auth /storefront /admin /webhooks
      → rate limiter (per surface)
      → [Phase 2] authenticate → authorize
      → validate (zod, strict)
      → [designated routes] idempotency
      → controller
  → notFound  → errorHandler
```

Every response carries `X-Request-Id`. Every error body carries the same id, so
a customer-reported failure is one log query away.

### Response envelope

```jsonc
{ "success": true, "data": {}, "meta": { "pagination": {} } }

{ "success": false, "message": "…", "code": "STABLE_CODE",
  "requestId": "…", "details": [{ "path": "body.quantity", "message": "…" }] }
```

`code` is the contract the frontends switch on; `message` may change.

---

## 4. Transactions

```ts
await withTransaction(async (tx) => {
  await repo.insert(tx, …)      // or just call query() — it joins ambiently
})
```

- The client is bound into `AsyncLocalStorage`; `getExecutor()` returns the
  ambient transaction or the pool.
- Nesting uses a **savepoint** on the same connection, never a second one.
- `retryable: true` retries serialization failures and deadlocks with jittered
  backoff (§18.5). Safe only because rule §18.2.1 forbids external side effects
  inside a transaction.
- Driver errors are translated to `AppError` **once**, at the query boundary. A
  business error thrown by the callback passes through untouched — re-wrapping
  it would turn a meaningful 422 into an opaque 500.

---

## 5. Domain events — the transactional outbox

The problem: an order must commit _and_ its consequences must eventually happen,
with no window where one occurs without the other.

```
┌────────── one transaction ──────────┐
│ business writes                     │
│ INSERT domain_events                │  ← publish(name, payload)
└──────────────┬──────────────────────┘
              COMMIT  ─────► pg_notify wakes the dispatcher
               │
     dispatcher: SELECT … WHERE dispatched_at IS NULL
                 ORDER BY id LIMIT n FOR UPDATE SKIP LOCKED
               │
     fan out to subscribers (each isolated; one failing does not stop siblings)
               │
     all succeeded → dispatched_at = now()
     any failed    → attempts++, retry next tick
     attempts ≥ 10 → park with the error preserved
```

Delivery is **at-least-once**, so every subscriber must be idempotent.
`domain_events` doubles as a permanent ordered log — useful for debugging,
analytics backfill and replaying a subscriber that had a bug.

The `pg_notify` is an optimisation. The poll is the mechanism: a missed
notification costs latency, not delivery.

Events are registered in `src/events/catalog.ts` with a Zod payload schema.
Publishing an unregistered event is a compile-time error.

---

## 6. Queue

pg-boss, in the same PostgreSQL (§9.1). Retries, delayed jobs, cron schedules,
concurrency control and dead-letter queues, with no second datastore to run.

- Every queue is declared in `queues.ts` with a payload schema and a retry
  policy, and gets a `<queue>.dlq` partner automatically.
- `enqueue()` validates the payload at the producer; the handler parses again on
  receipt.
- A dead-lettered job publishes `job.dead_lettered`, so it enters the same event
  pipeline as everything else instead of being only a log line.
- Handlers receive `(payload, ctx)` where `ctx` carries a bound logger, the
  attempt number and an `AbortSignal` raised during shutdown.

**Handlers must be idempotent.** In order of preference: a unique constraint
that makes the second attempt a no-op; a conditional update (`WHERE status =
'queued'`); a ledger check. Payloads are pointers (`{ orderId }`), never
snapshots — a retry must act on current state.

Live queues: `email.send`, `media.process_image`, `inventory.expire_reservations`,
`cleanup.idempotency`, `cleanup.events`, `cleanup.sessions`, `cleanup.media`.
Names reserved for later phases are listed at the bottom of `queues.ts`.

---

## 7. Email

```
emailService.enqueue(…)
   → INSERT email_messages (status='queued')     ← durable, deduplicated
   → enqueue('email.send', { emailMessageId })
   → worker: render (Handlebars → MJML → HTML) → EmailProvider.send()
   → status='sent' … or attempts++ and rethrow for retry
```

The row exists **before** the job, which gives a mail outbox, a permanent record,
deduplication via `dedupe_key`, and an operator view of failures in one move.

No controller ever calls a provider. `EmailProvider` has two implementations:
`console` (writes `.eml` files to `tmp/mail/`) and `smtp` (any SMTP service,
Mailhog locally). A hosted API provider is one new file.

Templates live in `src/infrastructure/email/templates/<name>/` and are pinned by
`registry.ts`, which holds each template's props schema and subject builder — a
renamed field is a type error at the call site rather than a blank line in
someone's inbox.

---

## 8. Realtime

Socket.IO with two namespaces:

| Namespace     | Who                     | Auto-joined rooms                                                         |
| ------------- | ----------------------- | ------------------------------------------------------------------------- |
| `/storefront` | authenticated customers | `user:<id>`                                                               |
| `/admin`      | staff, admin, owner     | `admin`, `admin:orders`, `admin:inventory`, `admin:payments`, `user:<id>` |

The client never says who it is. The handshake verifies the same access token the
HTTP API uses (algorithm pinned, issuer and token type checked); rooms are derived
server-side from the verified claims. A customer is refused on `/admin` however
valid their token.

Emission happens **only** in `emitters.ts`, called only from event subscribers.
No service or controller touches `io`. This is what keeps the socket layer from
becoming a second, unversioned, unauthorised API.

Realtime is best-effort: a disconnected admin misses the push and sees the change
on the next fetch. Anything that must not be missed is a notification row or an
email.

---

## 9. Errors

```
AppError (abstract)
├── ValidationError        422   ├── ConflictError      409
├── MalformedRequestError  400   ├── GoneError          410
├── AuthenticationError    401   ├── DomainRuleError    422
├── AuthorizationError     403   ├── RateLimitError     429
├── NotFoundError          404   ├── PayloadTooLarge    413
├── ExternalServiceError   502   ├── ServiceUnavailable 503
└── InternalError          500  (isOperational = false)
```

`isOperational` decides log level and whether the message reaches the client.
In production a 500 never carries a stack, a SQL fragment or a constraint name.

SQLSTATE mapping happens once, in `infrastructure/database/errors.ts`:
`23505 → 409`, `23503 → 422`, `40001/40P01 → retryable 409`, `08* → 503`.

---

## 10. Idempotency

`Idempotency-Key` on designated unsafe routes:

```
INSERT … ON CONFLICT DO NOTHING
  ├─ inserted   → run handler, store the 2xx response
  └─ conflict   → completed + same body  → replay stored response
                  completed + different  → 422 IDEMPOTENCY_KEY_REUSED
                  in progress (< 60s)    → 409 REQUEST_IN_PROGRESS
                  in progress (stale)    → take over and re-run
```

The unique constraint is the concurrency control: two simultaneous retries cannot
both execute. Failed responses are not stored, so a genuine failure stays
retryable. Records expire after 24 hours.

---

## 11. Observability

- **Logs**: pino, JSON, with `requestId`/`jobId` injected from
  `AsyncLocalStorage`. Redaction of tokens, passwords, cookies and card fields is
  configured once, in the logger.
- **`/healthz`** — liveness. Checks nothing but the process, so a database blip
  stops traffic being routed rather than restarting the container.
- **`/readyz`** — database reachable, migrations applied and undrifted. Returns
  503 with a per-check breakdown when degraded.
- **`/version`** — commit, environment, start time.

---

## 12. Migrations

Numbered, forward-only `.sql` files applied in build order. Each is recorded with
its SHA-256; if an applied file changes on disk the runner refuses to run,
because editing an applied migration is how environments silently diverge.
A mistake is corrected with a new forward migration, never a down migration.

| File                              | Introduces                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `0001_extensions_and_helpers.sql` | `pgcrypto`, `citext`, `set_updated_at()`                                                                                                   |
| `0002_events_and_idempotency.sql` | `domain_events`, `idempotency_keys`                                                                                                        |
| `0003_email.sql`                  | `email_messages`, `email_suppressions`                                                                                                     |
| `0004_identity_and_access.sql`    | `users`, `roles`, `permissions`, `role_permissions`, `user_roles`, `sessions`, `auth_tokens`, `login_attempts`, and the seeded RBAC matrix |
| `0005_audit.sql`                  | `audit_logs`                                                                                                                               |
| `0006_settings_and_media.sql`     | `store_settings` (seeded, single row), `media_assets`, and the `staff_invite` token purpose                                                 |
| `0008_inventory.sql`              | `inventory_locations` (seeded), `inventory_items`, `inventory_levels`, `inventory_movements`, `inventory_reservations`, and the `inventory:manage` / `inventory:transfer` permissions |
| `0007_catalogue.sql`              | `products`, `product_handles`, `product_options`, `product_option_values`, `product_variants`, `variant_option_values`, `product_media`, `categories`, `collections`, `collection_products`, `sales_channels`, `product_publications` |

`-- migrate:no-transaction` on the first line opts a file out of the wrapping
transaction (needed for `CREATE INDEX CONCURRENTLY`).

---

## 13. Object storage

Behind a `StorageProvider` interface, with the Supabase SDK confined to a single
adapter file. Feature code asks for a signed upload URL or an object's bytes; it
does not know which backend answers. Full detail, including what the tests do
and do not prove, is in [storage-and-media.md](storage-and-media.md).

**Supabase is used for object storage only.** Database access remains `pg` +
hand-written SQL against `DATABASE_URL`; there is no second data-access path and
no Supabase client library anywhere near a query. Migrations stay ordinary
PostgreSQL, so moving the database to Supabase PostgreSQL later is a change of
connection string, not of code.

---

## 14. Catalogue

Products, options, variants, media links, categories, collections and
publication. The commerce model — and why a variant is the only purchasable
thing, why publication is a table rather than a boolean, and why nothing is ever
deleted — is in [catalogue-model.md](catalogue-model.md).

---

## 15. Inventory

Stock lives on an inventory *level*, scoped to a location — never on a variant.
Every change is a signed movement in an append-only ledger, and every quantity
change is a single conditional `UPDATE`, which is what makes overselling
impossible across processes. See [inventory.md](inventory.md).

---

## 16. What is deliberately absent

No `carts`, `orders`, `payments` or `shipments`. No payment
provider, no shipping integration, no analytics rollups. No Redis and no ORM.

Each arrives with the phase that needs it, per the plan's §24.
