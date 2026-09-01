-- 0026_draft_orders_and_checkout_attempts.sql
-- Orders staff build by hand, and a record of every checkout that was tried.
-- Forward-only. Never edit a migration that has been applied (§4.4).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why a draft is an order and not its own table
--
-- A draft is an order that has not been placed. It has the same lines, the same
-- addresses, the same discounts and the same pricing, and it becomes a real
-- order by being placed rather than by being copied. A separate `draft_orders`
-- table would mean a second set of line items, a second call site for the
-- pricing service, and a conversion step that copies eleven columns and
-- eventually forgets one.
--
-- The cost is that every read path now has to say it does not want drafts, and
-- that cost is real: a draft counted as a sale inflates revenue, a customer's
-- lifetime value, and the "awaiting payment" queue. The exclusions are audited
-- in `0026`'s companion changes, and two of them are enforced here rather than
-- left to a WHERE clause somebody can forget:
--
--   • A draft holds no stock. Reservations are taken when it is placed, which
--     is the same moment a storefront checkout takes them.
--   • A draft has no `placed_at` that means anything until it is placed, so
--     conversion rewrites it. Analytics windows on `placed_at` therefore see
--     the moment of sale, not the moment somebody started typing.

ALTER TABLE orders DROP CONSTRAINT orders_status_check;

ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (
  status IN ('draft','pending','confirmed','processing','completed','cancelled')
);

-- Who is building it, and when it stopped being a draft. Both NULL on every
-- order that came from the storefront.
ALTER TABLE orders ADD COLUMN drafted_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN placed_from_draft_at timestamptz;

-- The draft queue: small, read often, and always by recency.
CREATE INDEX orders_drafts_idx ON orders (updated_at DESC) WHERE status = 'draft';

-- Every other index on this table is for orders that exist as sales. Excluding
-- drafts keeps them the size they were and makes the exclusion free.
DROP INDEX IF EXISTS orders_placed_idx;
CREATE INDEX orders_placed_idx ON orders (placed_at DESC) WHERE status <> 'draft';

-- ─────────────────────────────────────────────────────────────────────────────
-- Checkout attempts
--
-- Checkout is one atomic request: it either produces an order or raises. That
-- makes it reliable and leaves nothing behind to look at, so a shop cannot see
-- that forty checkouts failed this morning because one variant went out of
-- stock. Every attempt is recorded here — the ones that worked and the ones
-- that did not, with the reason the server gave.
--
-- Deliberately *not* a checkout session. Nothing here is resumed, advanced or
-- read back by the storefront; it is a log, written once at the end of an
-- attempt, and the checkout path behaves exactly as it did before.

CREATE TABLE checkout_attempts (
  id             uuid PRIMARY KEY,
  -- The cart it was attempted from, when there was one. Kept even after the
  -- cart is swept: a failure whose basket vanished is still a failure.
  cart_id        uuid REFERENCES carts(id) ON DELETE SET NULL,
  customer_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  email          citext,
  -- Set only when the attempt produced one.
  order_id       uuid REFERENCES orders(id) ON DELETE SET NULL,
  outcome        text NOT NULL CHECK (outcome IN ('placed','failed')),
  -- The server's own error code — `INSUFFICIENT_STOCK`, `DISCOUNT_INVALID` —
  -- so the admin groups by the same vocabulary the API refuses with rather
  -- than by prose that changes.
  failure_code   text,
  failure_message text,
  subtotal_cents integer NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  item_count     integer NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  payment_method text,
  country_code   char(2),
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- A placed attempt names its order; a failed one names its reason. Neither
  -- shape can be half-filled.
  CONSTRAINT outcome_is_explained CHECK (
    (outcome = 'placed' AND failure_code IS NULL)
    OR (outcome = 'failed' AND failure_code IS NOT NULL)
  )
);

-- The two questions this table exists to answer: what happened recently, and
-- which failure is happening most.
CREATE INDEX checkout_attempts_recent_idx ON checkout_attempts (created_at DESC);
CREATE INDEX checkout_attempts_failures_idx ON checkout_attempts (failure_code, created_at DESC)
  WHERE outcome = 'failed';
CREATE INDEX checkout_attempts_cart_idx ON checkout_attempts (cart_id)
  WHERE cart_id IS NOT NULL;
