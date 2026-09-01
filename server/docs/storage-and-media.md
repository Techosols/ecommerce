# Storage, media, settings and the audit trail

What exists today for object storage (§46), store settings (§23.14), media
(§23.4), the administrative audit trail (§43) and staff invitations (§23.2).
Section references (§) point into `../../docs/backend-implementation-plan.md`.

---

## 1. Storage: one seam, three backends

```
features/media ─┐
features/settings ─┤──▶  StorageProvider  ──▶  supabase │ local │ memory
jobs/media ─────┘         (infrastructure/storage)
```

No feature imports a vendor SDK. `getStorage()` returns a `StorageProvider`, and
exactly one file — `providers/supabase.ts` — imports `@supabase/supabase-js`.
Replacing the backend is one new adapter and one line in `index.ts`.

| Provider   | Selected by                  | For                                                       |
| ---------- | ---------------------------- | --------------------------------------------------------- |
| `supabase` | `STORAGE_PROVIDER=supabase`  | Production. Forced there by config — see below.            |
| `local`    | default                      | Development without a Supabase project.                    |
| `memory`   | `STORAGE_PROVIDER=memory`    | Tests.                                                     |

Configuration refuses to boot a production process on `local` or `memory`: a
container filesystem does not survive a redeploy, so a store would lose its
product images on the next deploy rather than at some visible moment.

### The interface, and why it looks like this

```ts
createSignedUploadUrl(key, { contentType, expiresInSeconds })
getUrl(key, { expiresInSeconds? })
head(key)        // metadata only
download(key)    // the bytes
put({ key, body, contentType, cacheSeconds?, upsert? })
remove(keys)
healthCheck()
```

Two rules are encoded in the shape rather than left to discipline:

- **The caller supplies a key; a client never does.** Keys are generated in
  `keys.ts`, entirely server-side, as
  `media/{yyyy}/{mm}/{uuid}/original.{ext}` — date-partitioned so a bucket
  listing stays navigable, one directory per asset so deleting an asset is a
  prefix delete. A client's filename survives only as a display label, stripped
  of its path. `assertSafeKey` is checked again in every adapter, so a future
  caller that builds a key from a new source cannot quietly reintroduce
  traversal.
- **A signed upload URL is a promise about _where_, not about _what_.** Bytes
  go straight from the browser to storage, so the server has not seen them.
  `head` and `download` exist because the server must inspect the object after
  the fact, and nothing may reference an asset before it does.

### The service-role key

Supabase is reached with the service-role key, which bypasses row-level
security. It is read once from config, held in the adapter, and never returned,
logged, or embedded in a URL. A test asserts that neither an upload URL nor a
readable URL contains it. Supabase errors are wrapped in `StorageOperationError`
with a fixed message, so a provider's error text — which can name projects and
tokens — never reaches a client or a log line.

### The development upload endpoint

With `STORAGE_PROVIDER=local` the provider issues upload URLs pointing at
`/local-storage/upload/:token` on this server, and readable URLs at
`/local-storage/objects/*`. The client-side flow is therefore identical to
production. The router is mounted only when the local provider is active and
`NODE_ENV` is not production; the download route serves the type the *bytes*
are, with `X-Content-Type-Options: nosniff`, so a stray non-image in a dev
bucket is downloaded rather than rendered.

---

## 2. Media: the three-step upload

```
1. POST /admin/media/uploads
     server validates the claim (type, size), generates the key,
     writes a `pending` row, returns a short-lived signed upload URL
2. client PUTs the bytes straight to object storage
     our API never carries them — and correspondingly has not seen them
3. POST /admin/media/:id/complete
     server HEADs the object, downloads it, sniffs the real magic bytes,
     claims the row with a compare-and-swap, and queues processing
4. worker: media.process_image
     re-encodes the original in place, generates WebP variants, marks it ready
```

### Status is the safety property

`pending → processing → ready`, or `→ failed` with a reason. Nothing may
reference an asset, and no URL is handed out, before `ready`. Every transition
is a conditional update (`WHERE status = 'pending'`), so a duplicated `complete`
or a redelivered job cannot process an asset twice or move it backwards.

### What actually makes an upload safe

- **Magic-byte sniffing, not the declared type.** The `Content-Type` a client
  sends is a claim. `sniff.ts` recognises exactly five image formats from their
  leading bytes and rejects everything else — SVG is absent from the allowlist
  precisely because it is a document that can execute script. A mismatch between
  declared and actual type is logged and the *actual* type wins; content that
  isn't an image at all is terminal, and the asset is marked `failed`.
- **Re-encoding is the control, not a nicety.** The worker decodes with sharp
  and writes fresh bytes over the same key. That destroys anything that was not
  image data: EXIF payloads, appended archives, polyglot files that are
  simultaneously a valid PNG and a valid HTML page. The original is *replaced*,
  not kept alongside — a "pristine original" is exactly the file an attacker
  wants left on disk. `.rotate()` applies the EXIF orientation and then drops
  the metadata, so a photo is upright and no longer says where it was taken.
- **Bounds at every step.** A declared size over `MEDIA_MAX_BYTES` never gets a
  key; an object that turns out larger is rejected at `complete`; images beyond
  12000px on a side or 50M pixels are refused as decompression bombs; a
  re-encoded image that somehow exceeds the limit fails rather than being
  stored.

Derivatives are WebP at 200 / 800 / 1600px, `fit: inside`, never upscaled.

### Cleanup

`cleanup.media` runs nightly (04:45) and removes `pending` rows older than 24
hours together with their objects — the tab that was closed before `complete`
was called. Bounded to 200 per run and it honours the shutdown signal.

---

## 3. Store settings

One row, enforced by `CHECK (id = 1)` and seeded by the migration, so "the
settings" is never ambiguous and no caller ever handles a null.

The distinction from environment variables (§21.2) is deliberate: store name,
currency, timezone and tax rate must be changeable by the owner without a
deploy; connection strings and secrets must not be changeable at runtime at all.

- Read on nearly every request, changed a handful of times a year, so it is
  cached in-process for 60s. A write updates the cache directly and publishes
  `settings.updated`, which the worker process also reacts to — two processes,
  two caches, one invalidation path.
- **The storefront view is a whitelist**, built by its own mapper
  (`toPublic`). The admin serializer is never reused there; that difference is
  what stops tomorrow's admin-only setting leaking by default. Tax rate,
  reservation windows, stock thresholds and metadata are admin-only.
- Money-adjacent values are integers: `tax_rate_bps` is basis points, so tax is
  integer arithmetic end to end.
- `supportUrl` is restricted to http(s) by `webUrlField`. `z.url()` alone
  accepts `javascript:alert(1)`, which — rendered as a link on the storefront —
  is stored XSS.
- A logo must be a `ready` media asset. The storefront receives a URL, never an
  id.

---

## 4. Audit trail

`audit_logs` records what people with power did: who, what action, to which
record, with a before/after of the fields that actually changed, the request id
and the IP.

- `auditService.record(...)` uses the ambient executor, so it joins the caller's
  transaction. **An audit row exists if and only if the change it describes
  committed** — a trail that can disagree with the data is worse than none,
  because it will be believed.
- It is called from services, not middleware. Middleware cannot know the
  semantic before/after of a change, and a row that says "PATCH /settings 200"
  answers no useful question.
- `diffChanged` stores only the moved fields; a full-row snapshot on both sides
  makes the trail unreadable.
- Credential-shaped keys are replaced with `[REDACTED]` whatever a caller
  passes, so the trail cannot become a secret store.
- Reads are not audited, and neither is anything a customer does to their own
  data — that is order history. Auditing everything produces a log nobody reads.
- Reading the trail is owner-only (`audit:read`): the record of what the
  powerful did is itself privileged.

---

## 5. Staff invitations

The only way a staff account comes into existence.

```
owner: POST /admin/staff        → account created with password_hash = NULL
                                → single-use token, 72h, emailed
invitee: POST /auth/invitation/accept { token, password }
                                → password set, email marked verified
                                → invitee signs in normally
```

Nobody — not even the owner — ever knows another person's password, and there is
no temporary password to be reused or shared. An account with no password hash
cannot be logged into, and the reset flow will not mint one for it either.

Accepting marks the address verified: clicking a link that only reached that
inbox is itself proof of control, so a second verification email would be
theatre. No session is issued on acceptance — the invitee logs in through the
one login path.

**The password is validated before the token is consumed.** Burning the token
first would mean an invitee who types a weak password loses the only link they
have, for a request that changed nothing. Single-use still rests entirely on the
compare-and-swap in `consumeAuthToken`, which runs inside the transaction; a
concurrency test asserts that four simultaneous redemptions still produce
exactly one winner. The same ordering fix was applied to password reset.

Unlike customer registration, invitation is deliberately *not* enumeration-safe:
the caller is an authenticated owner administering their own staff, and "that
address already has an account" is the useful answer rather than a leak.

---

## 6. Endpoints

| Method | Path                                        | Guard                        |
| ------ | ------------------------------------------- | ---------------------------- |
| GET    | `/storefront/settings`                      | public                       |
| GET    | `/admin/settings`                           | `settings:read`              |
| PATCH  | `/admin/settings`                           | `settings:write`             |
| POST   | `/admin/media/uploads`                      | `catalog:write`              |
| POST   | `/admin/media/:id/complete`                 | `catalog:write`              |
| GET    | `/admin/media`                              | `catalog:read`               |
| GET    | `/admin/media/:id`                          | `catalog:read`               |
| PATCH  | `/admin/media/:id`                          | `catalog:write`              |
| DELETE | `/admin/media/:id`                          | `catalog:write`              |
| GET    | `/admin/audit-logs`                         | `audit:read` (owner-only)    |
| POST   | `/admin/staff`                              | `staff:write` (owner-only)   |
| POST   | `/admin/staff/:id/resend-invitation`        | `staff:write` (owner-only)   |
| POST   | `/auth/invitation/accept`                   | public, IP rate-limited      |
| PUT    | `/local-storage/upload/:token`              | dev only, one-time token     |
| GET    | `/local-storage/objects/*`                  | dev only                     |

Everything under `/admin` sits behind the router-level `authenticate()` +
`requireStaff()` default deny; the permission above is the second layer. A test
walks every mounted admin router and fails if any route answers something other
than 401 without a token.

---

## 7. Events and jobs

| Event                       | Published when                                  |
| --------------------------- | ----------------------------------------------- |
| `settings.updated`          | settings change (carries the changed field names)|
| `media.uploaded`            | bytes accepted for processing                    |
| `media.ready`               | re-encoded and variants generated                |
| `media.failed`              | rejected at inspection or processing             |
| `media.deleted`             | asset removed                                    |
| `staff.invited`             | invitation created (carries the token *id*)      |
| `staff.invitation_accepted` | invitation accepted                              |

| Queue                 | Schedule       | Does                                       |
| --------------------- | -------------- | ------------------------------------------ |
| `media.process_image` | on demand      | re-encode, strip metadata, build variants   |
| `cleanup.media`       | `45 4 * * *`   | purge abandoned `pending` uploads           |

No raw token ever enters `domain_events`; the event carries the token id and the
mailer holds the only copy of the secret.

---

## 8. Testing, and what it proves

| Suite                                | Runs against                        | Proves                                                |
| ------------------------------------ | ----------------------------------- | ----------------------------------------------------- |
| `tests/contract/storageProvider.ts`  | memory, local, supabase-with-fake   | all adapters satisfy one interface                    |
| `unit/storage.providers.test.ts`     | memory + local                      | token single-use, expiry, no escape from the root     |
| `unit/storage.supabase.test.ts`      | **a fake SDK client**               | the adapter's translation layer                       |
| `integration/storage.supabase.live.test.ts` | **real Supabase, opt-in**    | that Supabase actually behaves as assumed             |
| `integration/storage.localRoutes.test.ts` | the dev endpoints              | guessed tokens write nothing; no traversal; no sniffing |
| `integration/media.test.ts`          | real Postgres + memory storage      | the whole three-step flow and its rejections          |
| `integration/settings.test.ts`       | real Postgres                       | public whitelist, cache invalidation, validation      |
| `integration/audit.test.ts`          | real Postgres                       | atomicity, redaction, owner-only reads                |
| `integration/invitations.test.ts`    | real Postgres                       | no password until accepted; single-use token          |

**Supabase has not been tested against the real service** unless the live suite
was run. It skips by default, and prints why. To run it:

```bash
SUPABASE_TEST_URL=https://<project>.supabase.co \
SUPABASE_TEST_SERVICE_ROLE_KEY=<service role key> \
SUPABASE_TEST_BUCKET=media-test \
npm test -- tests/integration/storage.supabase.live.test.ts
```

Use a throwaway project and a bucket you are happy to have objects created and
deleted in. It is opt-in because CI must not depend on a third-party service
being up, and because a service-role key does not belong in a CI secret store
unless someone has decided it should.

---

## 9. Configuration

| Variable                        | Default                                  | Notes                                        |
| ------------------------------- | ---------------------------------------- | -------------------------------------------- |
| `STORAGE_PROVIDER`              | `local`                                  | `supabase` is forced in production           |
| `SUPABASE_URL`                  | —                                        | required when provider is `supabase`         |
| `SUPABASE_SERVICE_ROLE_KEY`     | —                                        | server-side secret; never sent to a client   |
| `SUPABASE_STORAGE_BUCKET`       | `media`                                  |                                              |
| `SUPABASE_STORAGE_PUBLIC`       | `true`                                   | `false` issues signed, expiring download URLs|
| `STORAGE_LOCAL_DIR`             | `tmp/storage`                            | dev only                                     |
| `STORAGE_LOCAL_BASE_URL`        | `http://localhost:4000/local-storage`    | dev only                                     |
| `MEDIA_MAX_BYTES`               | `10485760`                               | 10 MiB, enforced server-side                 |
| `MEDIA_UPLOAD_URL_TTL_SECONDS`  | `300`                                    |                                              |
| `MEDIA_SIGNED_URL_TTL_SECONDS`  | `3600`                                   | private buckets only                         |
| `STAFF_INVITATION_TTL_HOURS`    | `72`                                     | longer than a reset: it waits in an inbox    |

---

## 10. On Supabase PostgreSQL

Supabase is used here for **object storage only**. Database access stays on `pg`
with hand-written SQL against `DATABASE_URL`, and no Supabase client library
goes anywhere near a query. Migrations use ordinary PostgreSQL features, so
pointing `DATABASE_URL` at Supabase PostgreSQL later is a change of connection
string rather than of code — the two-role split (`DATABASE_URL` pooled,
`DATABASE_DIRECT_URL` for pg-boss and `LISTEN`) already matches how Supabase
exposes its poolers.
