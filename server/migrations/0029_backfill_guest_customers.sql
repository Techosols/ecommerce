-- 0029_backfill_guest_customers.sql
-- Gives every historical guest order the customer record it would get today.
-- Forward-only. Never edit a migration that has been applied (§4.4).
--
-- Checkout now creates a customer for every email that buys. That change is not
-- retroactive on its own: orders placed before it still carry `customer_id IS
-- NULL` and appear in the admin as nobody. This migration closes that gap once,
-- so the Customers list and the per-customer totals describe the whole history
-- of the shop rather than only the part of it placed after a deploy.
--
-- Three rules, matching what checkout does live:
--
--   • an email that already belongs to an account joins THAT account. It does
--     not fork a second record of the same person, and it does not acquire the
--     `guest` tag — the account was opened by the person, not by the shop.
--   • an email with no account gets one created, passwordless, tagged `guest`,
--     with a timeline entry saying where it came from.
--   • names come from the order's own shipping address snapshot, which is the
--     only thing a guest ever told us about themselves.
--
-- Nothing is deleted and no order is repriced. The only columns written on
-- `orders` are `customer_id`, which was NULL.

BEGIN;

-- ── The people we are about to invent ────────────────────────────────────────
--
-- One row per distinct email among orphaned orders that has no account yet.
-- `DISTINCT ON` picks the earliest such order, so the name we adopt is the one
-- they gave the first time rather than an arbitrary one.
CREATE TEMP TABLE backfill_new_customers ON COMMIT DROP AS
SELECT DISTINCT ON (o.email)
  gen_random_uuid()                      AS user_id,
  o.email                                AS email,
  nullif(btrim(oa.first_name), '')       AS first_name,
  nullif(btrim(oa.last_name), '')        AS last_name,
  nullif(btrim(coalesce(o.phone, oa.phone, '')), '') AS phone
FROM orders o
LEFT JOIN order_addresses oa
  ON oa.order_id = o.id AND oa.type = 'shipping'
WHERE o.customer_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM users u WHERE u.email = o.email)
ORDER BY o.email, o.created_at;

-- uuid v7 is what the application mints, but ordering by id is never relied on
-- for these rows, and `gen_random_uuid()` needs no extension beyond pgcrypto,
-- which the schema already requires.

INSERT INTO users (id, email, password_hash, status, first_name, last_name, phone, tags, created_at)
SELECT
  b.user_id,
  b.email,
  -- Passwordless, exactly as a guest created at checkout is: `login` refuses an
  -- account with no hash, so this makes a record of a buyer and not an account
  -- in their name.
  NULL,
  'active',
  b.first_name,
  b.last_name,
  b.phone,
  ARRAY['guest'],
  -- Dated to their first order rather than to this migration, so "customers
  -- acquired in March" stays true of March.
  (SELECT min(o.created_at) FROM orders o WHERE o.email = b.email)
FROM backfill_new_customers b;

INSERT INTO user_roles (user_id, role_id, granted_by)
SELECT b.user_id, r.id, NULL
FROM backfill_new_customers b
CROSS JOIN roles r
WHERE r.key = 'customer';

INSERT INTO customer_events (id, customer_id, kind, body, actor_user_id, actor_name, metadata)
SELECT
  gen_random_uuid(),
  b.user_id,
  'account.created_at_checkout',
  NULL,
  NULL,
  NULL,
  jsonb_build_object('backfilled', true)
FROM backfill_new_customers b;

-- ── Attach every orphaned order ──────────────────────────────────────────────
--
-- Both cases at once: newly created records and accounts that already existed.
-- The join is on email, which is `citext`, so case differences match the way
-- they do at checkout.
UPDATE orders o
   SET customer_id = u.id
  FROM users u
 WHERE o.customer_id IS NULL
   AND u.email = o.email;

-- ── Make the counters tell the truth ─────────────────────────────────────────
--
-- `orders_count`, `total_spent_cents`, `first_order_at` and `last_order_at` are
-- denormalised and were only ever maintained for orders that had a customer.
-- They are recomputed here for every customer, over the SAME definition the
-- application uses in `customers.recomputeMetrics` — count of non-cancelled,
-- non-draft orders; spend net of refunds; first and last by `placed_at`. If
-- that definition ever changes, this migration is history and the function is
-- the truth; they only need to agree on the day this runs.
UPDATE users u
   SET orders_count      = coalesce(o.count, 0),
       total_spent_cents = coalesce(o.total, 0),
       first_order_at    = o.first_at,
       last_order_at     = o.last_at
  FROM (
    SELECT customer_id,
           count(*)::int AS count,
           coalesce(sum(total_cents - refunded_total_cents), 0) AS total,
           min(placed_at) AS first_at,
           max(placed_at) AS last_at
      FROM orders
     WHERE customer_id IS NOT NULL
       AND status NOT IN ('cancelled', 'draft')
     GROUP BY customer_id
  ) o
 WHERE u.id = o.customer_id;

COMMIT;
