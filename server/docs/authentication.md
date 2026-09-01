# Authentication and authorization

What exists today. Section references (§) point into
`../../docs/backend-implementation-plan.md`.

---

## 1. The two questions

```
Authentication  →  "who is this?"       →  shared/middleware/authenticate.ts  →  req.actor
Authorization   →  "may they do this?"  →  shared/middleware/authorize.ts + a service policy
```

`authenticate` never consults roles. `authorize` never parses tokens. Both live
in `shared/`, are written once, and are used identically by every feature —
which is what CLAUDE.md §10 means by centralised authentication.

---

## 2. Tokens

|                     | Access token                      | Refresh token                          |
| ------------------- | --------------------------------- | -------------------------------------- |
| Format              | JWT, HS256, algorithm pinned      | Opaque, 32 random bytes, base64url     |
| Lifetime            | 15 minutes (`JWT_ACCESS_TTL`)     | 30 days, sliding via rotation          |
| Stored server-side  | nothing                           | SHA-256 hash in `sessions`             |
| Given to the client | response body — hold it in memory | `httpOnly` cookie, `Path=/api/v1/auth` |
| Revocable           | no (short life)                   | yes, immediately                       |

Access-token claims are `sub`, `sid`, `roles`, `typ`, plus `iss`/`iat`/`exp`.

**Permissions are not in the token, and neither are roles trusted from it.**
`authenticate` reads the user's roles and status from the database on every
request (through a 30-second cache) and derives permissions from the
role→permission matrix (cached 5 minutes). The consequences are worth stating:

- granting or revoking a role takes effect within seconds, with no re-login
- disabling an account kills its access on the next request
- a forged token claiming `roles: ["owner"]` gets whatever the database says,
  which is nothing — there is a test for exactly this

The verifier pins `HS256` and checks `iss` and `typ`, closing `alg: none` and
token-type confusion. `JWT_PREVIOUS_ACCESS_SECRET` gives a rotation grace
window.

---

## 3. Registration

```
POST /auth/register
  → password policy check
  → address already registered?
      ├── yes → queue "account-exists" mail to the real holder, return 202
      └── no  → [transaction: create user + assign 'customer' + publish customer.registered]
                → after commit: issue verification token, queue the email
                → return 202
```

**The response is byte-identical either way.** Registration is the most common
account-enumeration oracle, and a 409 on a duplicate address is exactly that.
The observable difference is an email — visible only to whoever already owns the
address, which is the point.

Registration returns **no tokens**. Returning a session for a new account but
not an existing one would reintroduce the oracle. The client redirects to login.

Verification is **not** required to sign in. That is a deliberate product
decision: gating login on email deliverability means a bounced message locks a
paying customer out of the store. `requireVerifiedEmail()` exists for features
that need a stronger guarantee later.

---

## 4. Login

```
POST /auth/login
  → look up credentials
  → no account, or no password set → verifyDummy() → generic 401
  → wrong password → record attempt → maybe lock → generic 401
  → account not 'active' → record attempt → generic 401
  → rehash transparently if argon2 parameters have been raised
  → issue session (new family) + access token
  → record attempt, stamp last_login_at, publish auth.login_succeeded
```

Every failure answers `401 INVALID_CREDENTIALS` with the same message — unknown
address, wrong password, disabled, locked. `verifyDummy()` burns comparable
argon2 CPU when there is no account, so response time does not leak either.

**Lockout.** `LOGIN_MAX_FAILURES` (10) consecutive failures inside
`LOGIN_FAILURE_WINDOW_MINUTES` sets `status='locked'` and revokes every session.
Completing a password reset unlocks the account — that is the documented
recovery path, and `POST /auth/password/forgot` deliberately still works for a
locked account.

---

## 5. Sessions and refresh rotation

`sessions` holds one row per refresh token ever issued. Rotation inserts a
successor in the same `family_id` and marks the predecessor used.

```
     login ──▶ S1 ──rotate──▶ S2 ──rotate──▶ S3        one family
                │
                └── S1 presented again  ⇒  reuse: revoke S1, S2, S3
```

The refresh path in full:

```
find session by SHA-256(token)          — outside the transaction, cheap reject
└── BEGIN
    SELECT 1 FROM users WHERE id = ? FOR UPDATE     ← serialises this user
    re-read the session under the lock
    ├── expired               → revoke, outcome = expired
    ├── used_at or revoked_at → revoke FAMILY, publish, outcome = reuse
    ├── markRotated() = 0 rows→ revoke FAMILY, publish, outcome = reuse
    ├── user not active       → revoke FAMILY, outcome = inactive
    └── issue successor       → outcome = rotated
    COMMIT
└── raise the failure for every outcome except `rotated`
```

Two details carry the correctness, and both are easy to get wrong:

**The per-user lock.** Without it, a loser's family revocation can run its scan
_before_ the winner's successor row exists, leaving a live session descended
from a token just declared compromised. Contention is nil — a user refreshes a
few times an hour.

**The failure is raised after the commit.** Revoking a family and then throwing
from inside the transaction would roll the revocation back: the request would
fail while the stolen token stayed usable. So the transaction returns an
outcome and the throw happens outside it. A test asserts the revocation
survives.

**Concurrent refresh is treated as theft.** Two tabs refreshing the same token
at the same instant are, server-side, indistinguishable from a replay. Exactly
one wins; the family is then revoked and everyone signs in again. Losing a
session is the cheap failure; leaving a thief with a working one is not.

Revocation reasons are recorded (`logout`, `logout_all`, `rotated`,
`reuse_detected`, `password_changed`, `password_reset`, `account_disabled`,
`admin_revoked`, `expired`), so "why was I signed out?" is answerable.

---

## 6. Passwords

- **argon2id**, 19 MiB / 2 iterations / 1 lane (the OWASP baseline). Test runs
  use a lower work factor — same algorithm, so the suite stays fast enough to
  run often. A unit test pins the production parameters.
- Minimum 10 characters, maximum 200 (an unbounded password is an argon2
  denial-of-service). No composition rules: length beats character classes. A
  small blocklist covers what dominates credential-stuffing lists, and a
  password containing the email's local part is rejected.
- Rehashing is transparent on login when parameters are raised.
- **Change** requires the current password and revokes every _other_ session.
- **Reset** consumes a single-use token, revokes _every_ session, and unlocks a
  locked account.
- Both publish `auth.password_changed`, which mails a security notice.

`POST /auth/password/forgot` always answers `202` with the same body, and sends
nothing for an unknown or disabled account.

---

## 7. Credential tokens

Verification and reset tokens are 32 random bytes. Only the SHA-256 is stored.
A partial unique index enforces **one live token per purpose per user**, so
issuing a new one invalidates the old, and consumption is a compare-and-swap
(`consumed_at IS NULL AND expires_at > now()`), so a replayed link fails
cleanly.

### Why these two emails bypass the outbox

Every other email is queued by an event subscriber. Verification and reset are
not, and the reason is specific: an event payload is written to
`domain_events`, which is durable and queryable. A live reset token sitting
there would be a standing credential leak — anyone with read access to the
database could take over any account inside the token's lifetime.

So the service enqueues those two directly, **after the transaction commits**.
The event still fires (`auth.password_reset_requested`) carrying the _token
id_, so audit, analytics and security monitoring see the action without seeing
the secret. Two integration tests assert the token never appears in
`domain_events`.

The trade-off, stated plainly: if the process dies between the commit and the
enqueue, the user gets no email and retries. That is acceptable for a reset; it
would not be for an order confirmation, which is why order mail goes through the
outbox.

---

## 8. Authorization

Four roles, seeded by migration `0004` so every environment has the same matrix
and a change to it is a reviewable diff.

|                                                 | staff | admin | owner |
| ----------------------------------------------- | :---: | :---: | :---: |
| orders read / write / cancel                    |   ✔   |   ✔   |   ✔   |
| orders refund, payments capture/refund          |   —   |   ✔   |   ✔   |
| shipping, inventory                             |   ✔   |   ✔   |   ✔   |
| catalog read                                    |   ✔   |   ✔   |   ✔   |
| catalog write / publish                         |   —   |   ✔   |   ✔   |
| customers read                                  |   ✔   |   ✔   |   ✔   |
| customers write, discounts, analytics, settings |   —   |   ✔   |   ✔   |
| staff, roles, audit                             |   —   |   —   |   ✔   |

`customers:impersonate` is defined and granted to nobody, so the audit surface
is designed for it rather than retrofitted. `customer` holds no administrative
permission at all — access to their own data is a resource-level policy, not a
permission.

Enforcement is three layers:

1. **Router-level default deny.** `adminRouter.use(authenticate(), requireStaff())`
   runs before any admin route is mounted, so a new route is protected the
   moment it is added. It also runs before route matching, so an unknown admin
   path answers `401` rather than confirming its absence.
2. **A permission per route** — `requirePermission('roles:assign')`.
3. **A resource-level policy in the service** — "may this actor do it to _this_
   record". Revoking someone else's session answers `404`, not `403`:
   confirming the record exists is itself a leak.

A generated test walks the admin router's own stack and asserts every mounted
route rejects an anonymous request, so "we forgot the guard" fails the suite
rather than shipping.

---

## 9. Endpoints

**Auth** (`/api/v1/auth`)

| Method | Path               | Auth           | Rate limit                     |
| ------ | ------------------ | -------------- | ------------------------------ |
| POST   | `/register`        | —              | 5/h per IP                     |
| POST   | `/login`           | —              | 5/15m per email, 20/15m per IP |
| POST   | `/refresh`         | cookie or body | 60/15m per IP                  |
| POST   | `/logout`          | optional       | surface default                |
| POST   | `/logout-all`      | required       | surface default                |
| GET    | `/me`              | required       | surface default                |
| GET    | `/sessions`        | required       | surface default                |
| DELETE | `/sessions/:id`    | required       | surface default                |
| POST   | `/email/verify`    | —              | 20/15m per IP                  |
| POST   | `/email/resend`    | —              | 3/h per email                  |
| POST   | `/password/forgot` | —              | 5/15m per email, 20/h per IP   |
| POST   | `/password/reset`  | —              | 10/15m per IP                  |
| POST   | `/password/change` | required       | 5/15m per user                 |

**Admin** (`/api/v1/admin`) — all behind `authenticate + requireStaff`

| Method | Path                | Permission     |
| ------ | ------------------- | -------------- |
| GET    | `/roles`            | `staff:read`   |
| GET    | `/staff`            | `staff:read`   |
| PATCH  | `/staff/:id/roles`  | `roles:assign` |
| PATCH  | `/staff/:id/status` | `staff:write`  |

Logout works with or without a valid access token: a client whose access token
has expired must still be able to end its session.

---

## 10. Cookies and CSRF

The refresh cookie is `httpOnly`, `Secure` in production, `SameSite=Strict` by
default, and scoped to `Path=/api/v1/auth` — so it is unreadable by script and
is not sent to any other endpoint. The access token is never put in a cookie.

`AUTH_COOKIE_SAMESITE` can be relaxed to `lax` or `none` when the frontends
cannot share a registrable domain with the API; `none` is rejected at boot
unless the origins are HTTPS.

CSRF: with `SameSite=Strict` a cross-site request cannot carry the cookie. The
body fallback (`{ refreshToken }`) is for native clients that have no cookie
jar; being body-supplied it is immune to CSRF rather than a weakening of it.

---

## 11. Events

| Event                           | Raised when                                      |
| ------------------------------- | ------------------------------------------------ |
| `user.created`                  | any identity is created                          |
| `user.status_changed`           | an account is enabled or disabled                |
| `user.roles_changed`            | roles are replaced                               |
| `customer.registered`           | a customer signs up                              |
| `customer.email_verified`       | an address is confirmed                          |
| `auth.login_succeeded`          | a session is issued                              |
| `auth.logged_out`               | one session, or all, revoked by the user         |
| `auth.password_changed`         | change or reset completes                        |
| `auth.password_reset_requested` | a reset token is issued (carries the token _id_) |
| `auth.account_locked`           | repeated failures lock an account                |
| `auth.token_reuse_detected`     | a spent refresh token was presented              |

Subscribers: welcome mail on verification, security notice on password change,
per-process cache invalidation on role and status changes, and operator-level
logging for the two security events. Notification fan-out arrives in Phase 10.

---

## 12. Background jobs

`cleanup.sessions` (daily, 04:15 UTC) removes sessions expired or revoked more
than 30 days ago, consumed or expired credential tokens older than 7 days, and
login attempts past their retention (90 days). Retention is generous on purpose:
a revoked session is evidence about how an account was used.

Authentication email flows exactly like every other email (§10.1 of the plan):

```
authService  →  emailService.enqueue(...)
             →  INSERT email_messages (status='queued', dedupe_key)
             →  enqueue('email.send', { emailMessageId })
             →  worker: render → EmailProvider.send() → status='sent'
```

No controller ever calls a provider, and a redelivered job is a no-op because
the handler only acts on a row still in `queued`.

---

## 13. What is deliberately not here

Two-factor authentication for staff (a seam exists; the feature does not), SSO
and social login, staff invitation by email (the owner is created by
`npm run db:seed`; staff creation arrives with the customers/users feature),
customer profile and address management, and the audit trail — `audit_logs` is
Phase 3 work, so role and status changes are currently recorded as domain events
and log lines rather than audit rows.
