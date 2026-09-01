# Operations

How to deploy this, what the probes mean, and what to do at three in the
morning.

---

## 1. Two processes, one image

```
node dist/main/api.js        HTTP + Socket.IO      :4000  /healthz /readyz
node dist/main/worker.js     queues + dispatcher   :4001  /healthz /readyz
```

Same build, different command, so they cannot drift. The worker owns pg-boss,
the cron schedules and the outbox dispatcher; the API owns the sockets. Neither
does the other's job in production — `RUN_WORKERS_IN_PROCESS` is refused there.

Both serve probes. The worker's are not optional: it is the process that runs
every job, and without them a worker whose queue has disconnected looks
perfectly healthy from outside.

---

## 2. Configuration that will stop a boot

The process refuses to start rather than run misconfigured. In production it
additionally requires:

| Setting | Why it is refused |
| --- | --- |
| `TRUST_PROXY_HOPS` > 0 | with 0 behind a load balancer every request appears to come from one address, and per-IP rate limits lock out the entire store within minutes |
| `DATABASE_SSL=true` | |
| `STORAGE_PROVIDER=supabase` | a container filesystem does not survive a redeploy |
| `EMAIL_PROVIDER` ≠ `console` | |
| `RUN_WORKERS_IN_PROCESS=false` | |
| a real `JWT_ACCESS_SECRET` | |

`PAYMENT_WEBHOOK_SECRET` is optional and **fails closed**: unset, the webhook
endpoint refuses every callback. That is correct, but it means a gateway
integration does nothing until it is set.

---

## 3. Deploying

Order matters:

```
1. run migrations          npm run db:migrate
2. roll out new code
```

Readiness returns 503 while any migration is pending, so new code that starts
before its migration simply never becomes ready. Migrations take an advisory
lock, so two deploy tasks racing is safe — the second waits and finds nothing
to do.

**Shutdown is a drain, not a stop.** On SIGTERM the process fails readiness
immediately, keeps serving for five seconds while the balancer notices, then
closes sockets, then the listener, then the pool. A signal exits 0; a crash
exits 1, so `restart: on-failure` behaves.

### Long-running migrations

Anything touching `orders` should use `-- migrate:no-transaction` with
`SET lock_timeout`, `NOT VALID` constraints validated separately, and
`CREATE INDEX CONCURRENTLY` — see `0017` and `0018` for the pattern. An ordinary
`CREATE INDEX` on a busy table blocks every write for its duration.

---

## 4. The probes

| | `/healthz` | `/readyz` |
| --- | --- | --- |
| Checks | the event loop | database, migrations, queue |
| Failing means | restart the process | stop routing traffic here |

A database blip should take an instance out of rotation, not restart it. Wire
liveness to `/healthz` and readiness to `/readyz`, never the reverse.

---

## 5. Scheduled work

| Job | Cadence | If it stops |
| --- | --- | --- |
| `inventory.expire_reservations` | every 5 min | stock stays held by dead checkouts; the shop slowly cannot sell what it has |
| `carts.abandoned_scan` | hourly | no recovery emails; carts hold their "one active cart" slot |
| `order.expire_unpaid` | hourly | stock held by orders nobody will pay for |
| `analytics.rollup` | 05:00 UTC | the dashboard goes stale — visible, not urgent |
| `cleanup.*` | ~04:00 UTC | tables grow without limit |

Every job is idempotent and bounded per run. A job that exhausts its retries
lands in a dead-letter queue, which raises `job.dead_lettered` — that becomes a
staff notification and an `error` log line.

---

## 6. Runbook

**"Orders are being cancelled that shouldn't be."**
Check `order.expire_unpaid`'s payload. `afterHours` applies to prepaid orders
only; COD is judged on `codAcceptanceHours` and acceptance, never on payment.
Confirm `orderReservationHours` still exceeds the longest window.

**"Stock is wrong."**
`inventory_movements` is append-only and says why every change happened. Compare
its sum for an item against `inventory_levels.on_hand`. A discrepancy means a
write that bypassed the service, which should be impossible — `available` is a
generated column and `reserved <= on_hand` is a CHECK.

**"A customer says they were charged twice."**
`payments` has a unique index on `idempotency_key` and one on
`(provider, provider_payment_id)`. Two rows for one order with different keys
means two genuine captures; identical keys cannot both exist.

**"The dashboard shows nothing for today."**
Expected before 05:00 — `rolledUpRange` ends yesterday and the `today` block is
served live. If the rollup is stale beyond that, look for a dead-lettered
`analytics.rollup`, then re-run it by hand:
`POST /api/v1/admin/analytics/rollups {"from":"…","to":"…"}` (bounded to 400
days; it is recomputed from source, so re-running is always safe).

**"Realtime stopped."**
Realtime crosses processes over a `pg_notify` channel: the worker raises,
every API instance listens. Check the API log for
`realtime bridge listening` at boot and `realtime listener connection failed`
after. Realtime is best-effort by design — the notification row and the email
are the durable copies, so this is never a data-loss incident.

**"Emails stopped."**
`SELECT status, count(*) FROM email_messages GROUP BY 1`. Rows stuck in
`sending` are crashed sends holding a claim — deliberately not retried
automatically, because re-sending risks a duplicate. Decide per row.

**Nothing is obviously wrong but something is slow.**
Every log line carries `requestId`, and every error response returns it. Slow
queries *and* slow writes log at `warn` with the statement name.

---

## 7. Known gaps

Honest list of what is not covered:

- **No metrics endpoint.** `METRICS_ENABLED` is validated and nothing serves
  `/metrics`. Logs are the only telemetry.
- **Rate limits are per-instance and in-memory.** Two replicas means double the
  effective limit, and a rolling deploy clears every bucket.
- **Dead letters reach a notification, not a pager.** Someone has to be looking
  at the admin console.
- **`rejectUnauthorized: false` on database TLS.** Encrypted but unauthenticated;
  pin the CA before this matters to you.
- **A revoked session keeps its open socket** until the client reconnects.
- **Payment webhooks are recorded and not acted on.** Correct while only COD is
  selectable; it becomes a blocker the day a gateway is switched on.
