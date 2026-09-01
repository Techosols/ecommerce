-- migrate:no-transaction
-- migrate:supersedes 84ab3322c0b61511019251c836dfe22a9c046e6dc65566e45fa7ca78757cc2d2
-- 0017_payment_methods.sql
-- The payment method an order was placed with, and cash on delivery (§5.7).
-- Forward-only. Never edit a migration that has been applied (§4.4).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why this one runs outside a transaction
--
-- It touches `orders`, which is the busiest table in the schema and the one
-- every checkout writes to. Wrapped in a single transaction, the backfill, two
-- ALTERs and two CREATE INDEXes would hold ACCESS EXCLUSIVE for the whole
-- sequence and queue every read and write behind it.
--
-- Instead: a short `lock_timeout` so an ALTER that cannot get its lock quickly
-- gives up rather than blocking everything behind it while it waits, the
-- constraints added `NOT VALID` and validated separately (which takes only a
-- SHARE UPDATE EXCLUSIVE lock and lets writes continue), and the indexes built
-- `CONCURRENTLY`. Each statement commits on its own, so a failure part-way
-- leaves the earlier ones applied — which is why every step below is written
-- to be safe to re-run.
--
-- ── Correction, and why this file was allowed to change ──────────────────────
--
-- The paragraph above was a promise this file did not keep. Seven statements
-- were written once-only: three `ADD CONSTRAINT`s, a bare `DROP CONSTRAINT`,
-- and two `ALTER TABLE store_settings ADD COLUMN` blocks with no
-- `IF NOT EXISTS`. Because the file runs outside a transaction, a failure at
-- any point — the 3s `lock_timeout` firing on a busy `orders`, or a
-- `CONCURRENTLY` build not getting its snapshot — committed everything before
-- it and recorded nothing, so the next `db:migrate` replayed those statements
-- and stopped on `already exists`. The database was then wedged: the file could
-- neither complete nor be skipped.
--
-- Every statement below is now genuinely idempotent. Editing an applied
-- migration is otherwise forbidden (§4.4), so the previous checksum is declared
-- in the `migrate:supersedes` directive above: the runner accepts a database
-- that recorded the old text and does not re-run it. That directive is the
-- audit trail, and it is the only sanctioned way to correct a file that has
-- already run.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why the method belongs on the order
--
-- Until now `payments.method` recorded how money *arrived*. That is not the
-- same question as how the customer chose to pay when they placed the order,
-- and three separate pieces of behaviour need the second one:
--
--   • the unpaid-order sweep must cancel an abandoned card order and must NOT
--     cancel a cash-on-delivery order, which is unpaid by design until the
--     courier comes back
--   • confirmation differs: an online order confirms when the money lands, a
--     COD order confirms when the shop decides to ship it
--   • the surcharge is decided at checkout and is part of the order's total
--
-- A COD order has an order-level method from the moment it is placed and no
-- `payments` row at all until somebody hands over cash, so deriving the method
-- from the payments table would mean deriving it from rows that do not exist.
-- ─────────────────────────────────────────────────────────────────────────────

-- Give up rather than queue behind a long-running query while holding a lock
-- that blocks the entire store.
SET lock_timeout = '3s';

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS payment_method    text,
  -- A surcharge for the chosen method (COD handling, card fee later). Kept
  -- separate from shipping because it is not a delivery cost and refunding one
  -- must not look like refunding the other.
  ADD COLUMN IF NOT EXISTS payment_fee_cents integer NOT NULL DEFAULT 0;

-- Existing orders predate the concept. 'manual' is the honest description of
-- how they were settled: a member of staff marked them paid.
UPDATE orders SET payment_method = 'manual' WHERE payment_method IS NULL;

-- NOT VALID first: adding it takes a brief lock and does not scan the table.
-- Validation then runs separately under a weaker lock that still allows writes.
-- `DROP … IF EXISTS` before every `ADD CONSTRAINT`: a constraint cannot be
-- added conditionally, and drop-then-add reaches the same end state whether or
-- not a previous attempt got this far.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS payment_method_is_known;
ALTER TABLE orders
  ADD CONSTRAINT payment_method_is_known
    CHECK (payment_method IS NOT NULL
           AND payment_method IN ('cod', 'manual', 'bank_transfer', 'card'))
    NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT payment_method_is_known;

-- Only once every row satisfies the CHECK is the column marked NOT NULL, which
-- Postgres can then prove without a second scan.
ALTER TABLE orders ALTER COLUMN payment_method SET NOT NULL;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS payment_fee_is_not_negative;
ALTER TABLE orders ADD CONSTRAINT payment_fee_is_not_negative
  CHECK (payment_fee_cents >= 0) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT payment_fee_is_not_negative;

COMMENT ON COLUMN orders.payment_method IS
  'How the customer chose to pay at checkout. Distinct from payments.method, which records how money actually arrived.';

-- The total must still add up, now with the surcharge in it. A CHECK cannot be
-- altered in place, so it is dropped and rewritten — the only safe way to widen
-- an invariant, and the reason it is named rather than anonymous.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS total_is_consistent;
ALTER TABLE orders ADD CONSTRAINT total_is_consistent CHECK (
  total_cents = subtotal_cents
              - discount_total_cents
              + tax_total_cents
              + shipping_total_cents
              + payment_fee_cents
) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT total_is_consistent;

-- ── Clear out any index a previous attempt left half-built ───────────────────
--
-- A `CREATE INDEX CONCURRENTLY` that fails does not disappear: it leaves the
-- index behind marked INVALID. `IF NOT EXISTS` then sees it and skips, so a
-- re-run records this migration as applied while the index is never used by the
-- planner — a silent loss of exactly the index this file exists to add.
-- Dropping the invalid ones first is what makes the retry actually retry, and
-- an invalid index serves no query, so nothing depends on the one being
-- dropped.
DO $invalid$
DECLARE dead record;
BEGIN
  FOR dead IN
    SELECT c.relname AS name
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE NOT i.indisvalid
       AND n.nspname = current_schema()
       AND c.relname = ANY (ARRAY['orders_open_cod_idx',
                          'orders_expiring_unpaid_idx'])
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I', dead.name);
    RAISE NOTICE 'dropped invalid index % left by an earlier attempt', dead.name;
  END LOOP;
END
$invalid$;

-- Answers "how many COD orders is this customer already sitting on?" without a
-- scan. That question is the whole of COD abuse control, so it gets an index
-- rather than being computed from a full table read at checkout.
CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_open_cod_idx
  ON orders (customer_id)
  WHERE payment_method = 'cod'
    AND status NOT IN ('completed', 'cancelled')
    AND payment_status = 'pending';

-- Lets the unpaid-order sweep find its candidates directly, and — because the
-- predicate excludes COD — makes it structurally impossible for that job to
-- pick up a cash-on-delivery order by reading this index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_expiring_unpaid_idx
  ON orders (placed_at)
  WHERE status = 'pending'
    AND payment_status = 'pending'
    AND payment_method <> 'cod';

-- ─────────────────────────────────────────────────────────────────────────────
-- Cash on delivery policy, on store_settings
--
-- Every one of these is a commercial decision the owner changes without a
-- deploy (§21.2), and every one of them exists because COD's failure mode is
-- refused deliveries: goods that travelled, were not paid for, and come back.
-- ─────────────────────────────────────────────────────────────────────────────
-- store_settings is a single row, so none of this is a lock concern.
ALTER TABLE store_settings
  ADD COLUMN IF NOT EXISTS cod_enabled              boolean NOT NULL DEFAULT true,
  -- Below the floor the handling costs more than the margin; above the ceiling
  -- a refused delivery hurts too much to risk.
  ADD COLUMN IF NOT EXISTS cod_min_subtotal_cents   integer NOT NULL DEFAULT 0
                                        CHECK (cod_min_subtotal_cents >= 0),
  ADD COLUMN IF NOT EXISTS cod_max_subtotal_cents   integer
                                        CHECK (cod_max_subtotal_cents IS NULL
                                               OR cod_max_subtotal_cents >= 0),
  ADD COLUMN IF NOT EXISTS cod_fee_cents            integer NOT NULL DEFAULT 0
                                        CHECK (cod_fee_cents >= 0),
  -- Empty means "everywhere the store ships". A non-empty list is a whitelist.
  ADD COLUMN IF NOT EXISTS cod_country_codes        char(2)[] NOT NULL DEFAULT '{}',
  -- Guests are the usual source of fake COD orders. Off by default is the
  -- permissive choice; a store with a problem turns it on.
  ADD COLUMN IF NOT EXISTS cod_requires_account     boolean NOT NULL DEFAULT false,
  -- How many unpaid COD orders one customer may have at once. NULL is no limit.
  ADD COLUMN IF NOT EXISTS cod_max_open_orders      integer
                                        CHECK (cod_max_open_orders IS NULL
                                               OR cod_max_open_orders > 0);

-- Separated from the ADD COLUMNs above: those skip themselves when the column
-- is already there, and a constraint bundled into the same statement would be
-- skipped with them on a re-run that had only got half way.
ALTER TABLE store_settings DROP CONSTRAINT IF EXISTS cod_range_is_ordered;
ALTER TABLE store_settings ADD CONSTRAINT cod_range_is_ordered CHECK (
  cod_max_subtotal_cents IS NULL OR cod_max_subtotal_cents >= cod_min_subtotal_cents
);

-- ─────────────────────────────────────────────────────────────────────────────
-- How long a placed order holds its stock
--
-- `reservation_ttl_minutes` is a *cart* hold: an hour is right for a basket
-- somebody may never come back to. It is badly wrong for a placed order, which
-- must keep its stock until it is confirmed or cancelled — an hour later the
-- hold would lapse silently and the same unit could be sold twice while the
-- order still looked live.
--
-- The invariant that matters: **an order's stock hold must outlive every sweep
-- that could cancel it.** If the hold went first, the shop would have an open
-- order with no stock behind it and nothing to say so — the same unit could
-- then be sold again while the original order still looked live.
--
-- Two sweeps can cancel an order, and the default is set above the longer:
--
--   unpaid prepaid orders     48h
--   unaccepted COD orders    168h   ← the binding one
--   stock hold               192h   ← comfortably beyond both
--
-- A store that lengthens its COD acceptance window past this must lengthen
-- this too; the sweep logs a warning if it ever finds them the wrong way round.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE store_settings
  ADD COLUMN IF NOT EXISTS order_reservation_hours integer NOT NULL DEFAULT 192
                                       CHECK (order_reservation_hours > 0);

COMMENT ON COLUMN store_settings.order_reservation_hours IS
  'How long a placed order holds its stock before the hold lapses. Must exceed the unpaid-order sweep window.';

COMMENT ON COLUMN store_settings.cod_country_codes IS
  'Whitelist of countries COD is offered in. Empty array means everywhere the store ships.';
COMMENT ON COLUMN store_settings.cod_max_open_orders IS
  'Unpaid COD orders one customer may hold at once. NULL means no limit.';
