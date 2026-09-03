# Production email

Getting order confirmations and password resets to actually arrive, from
`mail.stdbeauty.com`.

---

## 1. What this decision is and is not

**Nodemailer is not a choice you are making.** It is the SMTP client this server
already uses (`src/infrastructure/email/providers/smtp.ts`), and it stays
whatever you decide below. Resend, Amazon SES, Postmark and your web host's
cPanel mail are SMTP *servers*. Nodemailer connects to one of them.

So the decision is one line of configuration:

```
SMTP_HOST=???
```

Nothing in `src/` changes for any option on this page. There is no "nodemailer
vs Resend" — there is only "which server does nodemailer hand the message to,
and does Gmail trust that server".

**What is genuinely required** is not a vendor. It is this list, and it is
required no matter who sends:

| Requirement | What it does |
| --- | --- |
| **SPF** | A DNS record naming who may send as your domain |
| **DKIM** | A cryptographic signature proving the message was not forged |
| **DMARC** | Tells receivers what to do when SPF or DKIM fails, and where to report |
| **Reverse DNS (PTR)** | The sending IP resolves back to its own hostname |
| **A sending IP with reputation** | Built over weeks of clean sending |
| **Bounce and complaint handling** | Stop mailing addresses that reject you, or reputation collapses |
| **TLS on the connection** | Certificate, renewal, correct hostname |

A sending service gives you all seven. Running your own mail server means you
provide all seven yourself, and the last three are ongoing work rather than
setup.

Since February 2024 Gmail and Yahoo require SPF, DKIM **and** DMARC from
anybody sending them meaningful volume, and weight domain reputation heavily
even below that threshold. Password resets and order confirmations landing in
spam do not read as a technical problem to a customer — they read as the shop
being broken.

---

## 2. The three honest options

### Option A — a sending service (recommended)

You verify `mail.stdbeauty.com` with the service; they sign and send.

**Cost:** free to about £15/month at the volume a new store produces.
**Setup:** three DNS records, thirty minutes.
**Ongoing:** none. Bounces, blocklists and IP reputation are theirs.

Recommended: **Resend** (simplest DNS, good logs, 3,000/month free, then $20)
or **Postmark** (best transactional deliverability, $15 for 10,000, no real
free tier). **SES** is cheapest at volume — $0.10 per thousand — but starts in
a sandbox that only mails addresses you have verified, and getting out of it is
a support request that takes a day or two. Do not discover that on launch day.

### Option B — your host's mailbox (cPanel / Plesk)

If `stdbeauty.com` already has working email through your web host, you already
have an SMTP server at `mail.stdbeauty.com`, and it already has SPF and DKIM
configured for the domain. This is a legitimate choice and it costs nothing.

**Where it hurts:** sending limits are typically 200–500 per day and are
enforced silently; there is no delivery log, so "did the customer get it" is
unanswerable; a bounce tells you nothing; and shared hosting IPs carry whatever
reputation the other tenants earned.

Fine for a store doing a few orders a day. Painful at fifty.

### Option C — your own mail server

Postfix on a VPS at `mail.stdbeauty.com`.

Viable, and genuinely cheaper at scale. But most cloud provider IP ranges are
pre-emptively blocklisted by Microsoft, several ranges are blocked by Gmail,
PTR records need your provider's cooperation, and a new IP needs weeks of
gradual warming before it is trusted. Budget days of setup and an ongoing
responsibility, not an afternoon.

Choose this if you already run mail infrastructure. Not as a first mail server,
and not for the mail that tells someone their order was placed.

---

## 3. Setting it up with a service

Using Resend as the worked example; Postmark and Brevo differ only in the exact
DNS values they hand you.

### 3.1 Verify the sending subdomain

In the provider, add the domain **`mail.stdbeauty.com`** — the subdomain, not
`stdbeauty.com`.

> **Why a subdomain.** Reputation is tracked per sending domain. If transactional
> mail ever gets marked as spam in volume, an isolated subdomain means your own
> `@stdbeauty.com` inboxes and any future marketing sending are untouched. It
> costs nothing to do now and cannot be retrofitted painlessly later.

The provider gives you three or four records. Add them at whoever hosts DNS for
`stdbeauty.com`:

| Type | Host | Value |
| --- | --- | --- |
| TXT | `mail` | `v=spf1 include:amazonses.com ~all` *(exact value from provider)* |
| TXT | `resend._domainkey.mail` | the long DKIM public key they give you |
| MX | `mail` | `feedback-smtp.<region>.amazonses.com` priority 10 *(for bounces)* |

Two things that waste an afternoon if you get them wrong:

- **Host field.** Most DNS panels want the name *relative* to the zone, so it
  is `mail`, not `mail.stdbeauty.com`. Cloudflare accepts either. If you end up
  with a record for `mail.stdbeauty.com.stdbeauty.com`, this is why.
- **Cloudflare proxying.** TXT and MX records are never proxied, but if you also
  add an A record for `mail`, turn the orange cloud **off**.

Propagation is usually minutes. Verify from the command line rather than
trusting the dashboard:

```bash
dig +short TXT mail.stdbeauty.com
dig +short TXT resend._domainkey.mail.stdbeauty.com
```

### 3.2 Add DMARC

Separate record, on the parent domain, and the providers often skip mentioning
it:

| Type | Host | Value |
| --- | --- | --- |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@stdbeauty.com; pct=100` |

Start at `p=none`. It changes nothing about delivery — it only asks receivers to
send you reports. Read them for a fortnight, confirm everything legitimate is
passing, then tighten to `p=quarantine`. Going straight to `p=reject` before you
know what is sending as your domain is how a shop silently stops delivering its
own invoices.

### 3.3 Configure the server

```dotenv
NODE_ENV=production
APP_ENV=production

EMAIL_PROVIDER=smtp
EMAIL_FROM=orders@mail.stdbeauty.com
EMAIL_REPLY_TO=support@stdbeauty.com

SMTP_HOST=smtp.resend.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=resend
SMTP_PASSWORD=re_xxxxxxxxxxxx
```

Four notes, each of which has bitten somebody:

- **`SMTP_SECURE=false` on port 587 is correct**, and looks wrong. 587 begins
  in plaintext and upgrades via STARTTLS, which nodemailer does automatically.
  `secure: true` means "TLS from the first byte" and belongs only on port 465.
  Setting it true on 587 hangs until the connection times out.
- **`EMAIL_FROM` must be on the verified subdomain.** Sending as
  `store@stdbeauty.com` while `mail.stdbeauty.com` is what you verified fails
  DKIM alignment, and DMARC then tells Gmail to distrust it.
- **`EMAIL_REPLY_TO` should be a real inbox** you read. Customers reply to order
  confirmations constantly. It does not need to be on the sending subdomain.
- **The API key is a password.** It goes in the deployment's secret store, not
  in the repository.

### 3.4 What the boot will refuse

`src/config/env.ts` will not start a production process that is misconfigured.
Relevant to this page:

| Setting | Refused because |
| --- | --- |
| `EMAIL_PROVIDER=console` | Writes `.eml` files to disk and mails nobody |
| `RUN_WORKERS_IN_PROCESS=true` | The worker must be its own process |
| `DATABASE_SSL=false` | Credentials in clear text |
| `STORAGE_PROVIDER` not `supabase` | Local storage does not survive a redeploy |
| `JWT_ACCESS_SECRET` starting `replace-me` | The example placeholder |

The email one matters here: **the worker is what sends mail.** The API writes an
`email_messages` row and a domain event inside the business transaction; the
worker's dispatcher turns that into an `email.send` job and the job talks to
SMTP. In production those are two processes, so a running API and no worker
produces a queue that fills and a shop that mails nobody — with no errors in the
API log at all.

---

## 4. Verifying it end to end

```bash
node dist/main/api.js      # terminal one
node dist/main/worker.js   # terminal two
```

Then place a real order against production, or trigger a password reset. Watch
the row rather than the inbox:

```sql
select template, to_email, status, attempts, last_error, provider_message_id
from email_messages
order by created_at desc
limit 10;
```

`status` walks `queued → sending → sent`. What each stall means:

| Stuck at | Cause |
| --- | --- |
| `queued`, attempts 0 | The worker is not running, or the dispatcher is not reaching the database |
| `sending` | The SMTP connection is hanging — usually `SMTP_SECURE=true` on port 587, or outbound 587 blocked by the host |
| `failed`, `last_error` naming auth | Wrong `SMTP_USER`/`SMTP_PASSWORD`. Resend's username is the literal string `resend` |
| `failed`, naming the sender | `EMAIL_FROM` is not on the verified domain |
| `sent`, but nothing arrives | It sent. Check spam, then the provider's own delivery log |

### The test that actually matters

Send one to **[mail-tester.com](https://www.mail-tester.com)** — trigger a
password reset to the address it gives you. It scores out of 10 and names every
missing piece. Below 8, fix what it lists before launching. It catches the
DKIM-alignment mistake in §3.3 immediately, which nothing else will tell you
until customers start not receiving things.

Then send one to a Gmail address and one to an Outlook address, and check both
spam folders. Those two decide most of your delivery.

---

## 5. If you use the cPanel mailbox instead

The only differences:

```dotenv
SMTP_HOST=mail.stdbeauty.com
SMTP_PORT=465
SMTP_SECURE=true              # 465 is TLS from the first byte — genuinely true here
SMTP_USER=orders@stdbeauty.com
SMTP_PASSWORD=<the mailbox password>
EMAIL_FROM=orders@stdbeauty.com
```

Create the mailbox in cPanel first. Note `SMTP_SECURE=true` here — that is the
one case where it is right, because 465 is implicit TLS. Some hosts also offer
587 with STARTTLS, in which case it goes back to `false`.

Check your host's hourly and daily sending limits before launch. Hitting one
does not usually produce an error you will see; it produces mail that quietly
does not go.

---

## 6. Reference

- Nodemailer's transport is created once, pooled, three connections
  (`smtp.ts`). No per-message connection cost.
- `verify()` is implemented on `SmtpEmailProvider` and declared optional on the
  provider interface, but **nothing calls it** — `/readyz` does not currently
  check SMTP. So a wrong password produces a healthy-looking worker and a queue
  of `failed` rows. Worth wiring into the readiness probe; ask and it is a small
  change.
- Templates are MJML under `src/infrastructure/email/templates/`, sharing
  `_layout.mjml`. The `system-check` template exists for exactly this kind of
  smoke test.
- Every send is recorded in `email_messages` before it is attempted, so a
  provider outage is a retryable row rather than a lost message.
