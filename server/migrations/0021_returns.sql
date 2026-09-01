-- 0021_returns.sql
-- Goods coming back (§5.6).
-- Forward-only. Never edit a migration that has been applied (§4.4).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why returns are not refunds
--
-- A refund is money leaving the shop. A return is goods arriving at it. They
-- usually happen together and they are still different events, with different
-- evidence, different timing and different people involved: the warehouse
-- records what turned up and in what state, and somebody else decides what to
-- pay back. Modelling one as a flag on the other loses whichever half the flag
-- is not about — most often the condition the goods arrived in, which is the
-- entire basis for deciding whether they can be sold again.
--
-- So a return has its own lifecycle:
--
--   requested → approved → in_transit → received → closed
--
-- with `declined` and `cancelled` as the two ways out before the goods move.
-- The legal moves are written down in the service rather than checked ad hoc,
-- because "received → approved" is not a mistake anyone should be able to make
-- by calling the wrong endpoint.
--
-- ── Condition is per line, and it is the whole point ─────────────────────────
--
-- Receiving records a quantity *and a condition* for each line. Only
-- `resellable` units re-enter sellable stock; damaged, opened and
-- missing-parts units are written off. A return is the only event in this
-- system that legitimately *increases* on-hand stock, which is exactly why it
-- has to say what it is putting back.
--
-- ── returned_quantity on the order line ──────────────────────────────────────
--
-- Denormalised onto `order_items` so "what is still returnable" is a read of
-- the line rather than a sum over every return ever opened against the order.
-- Maintained by the service inside the same transaction that writes the return,
-- next to the existing `fulfilled_quantity` and `refunded_quantity` counters
-- that work the same way.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE SEQUENCE return_number_seq START 1001;

ALTER TABLE order_items
  ADD COLUMN returned_quantity integer NOT NULL DEFAULT 0
    CHECK (returned_quantity >= 0);

ALTER TABLE order_items
  ADD CONSTRAINT returned_within_ordered CHECK (returned_quantity <= quantity);

COMMENT ON COLUMN order_items.returned_quantity IS
  'Units committed to a return that has not been declined or cancelled. Maintained by the returns service in the same transaction.';

CREATE TABLE return_requests (
  id             uuid PRIMARY KEY,
  -- Human-facing, like an order number: a customer on the phone reads this out.
  return_number  text NOT NULL UNIQUE,
  order_id       uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  -- NULL for a guest, and SET NULL rather than CASCADE for the same reason the
  -- order does it: deleting a person must not delete the record of the goods.
  customer_id    uuid REFERENCES users(id) ON DELETE SET NULL,

  status         text NOT NULL DEFAULT 'requested'
                   CHECK (status IN ('requested','approved','declined',
                          'in_transit','received','closed','cancelled')),
  -- Why the customer says they are sending it back. A closed vocabulary,
  -- because free text here is a field nobody can ever report on.
  reason         text NOT NULL
                   CHECK (reason IN ('damaged','wrong_item','not_as_described',
                          'no_longer_wanted','arrived_late','other')),
  customer_note  text,
  staff_note     text,

  -- The refund that closed this return, when one did. Nullable because a return
  -- can be closed without a refund — an exchange, or a goodwill replacement.
  refund_id      uuid REFERENCES refunds(id) ON DELETE SET NULL,

  requested_at   timestamptz NOT NULL DEFAULT now(),
  approved_at    timestamptz,
  received_at    timestamptz,
  closed_at      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT closed_returns_have_a_date CHECK (
    (status IN ('closed','declined','cancelled')) = (closed_at IS NOT NULL)
  )
);

CREATE TRIGGER return_requests_set_updated_at
  BEFORE UPDATE ON return_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The two lists this table serves: one order's returns, and the queue by status.
CREATE INDEX return_requests_order_idx ON return_requests (order_id, created_at DESC);
CREATE INDEX return_requests_status_idx ON return_requests (status, created_at DESC);
CREATE INDEX return_requests_customer_idx ON return_requests (customer_id, created_at DESC)
  WHERE customer_id IS NOT NULL;

COMMENT ON TABLE return_requests IS
  'Goods coming back. requested → approved → in_transit → received → closed, with declined and cancelled as the exits before the goods move.';

CREATE TABLE return_line_items (
  id                 uuid PRIMARY KEY,
  return_id          uuid NOT NULL REFERENCES return_requests(id) ON DELETE CASCADE,
  -- RESTRICT: an order line that has been returned cannot be removed from under
  -- the return that describes it.
  order_item_id      uuid NOT NULL REFERENCES order_items(id) ON DELETE RESTRICT,

  quantity           integer NOT NULL CHECK (quantity > 0),
  received_quantity  integer NOT NULL DEFAULT 0 CHECK (received_quantity >= 0),
  restocked_quantity integer NOT NULL DEFAULT 0 CHECK (restocked_quantity >= 0),
  -- NULL until the goods arrive and somebody looks at them.
  condition          text CHECK (condition IS NULL OR condition IN
                       ('resellable','damaged','opened','missing_parts')),

  created_at         timestamptz NOT NULL DEFAULT now(),

  -- One row per order line per return: two rows for the same line would make
  -- "how many of these are coming back" a sum rather than a value.
  UNIQUE (return_id, order_item_id),
  CONSTRAINT received_within_requested CHECK (received_quantity <= quantity),
  CONSTRAINT restocked_within_received CHECK (restocked_quantity <= received_quantity)
);

CREATE INDEX return_line_items_return_idx ON return_line_items (return_id);
CREATE INDEX return_line_items_order_item_idx ON return_line_items (order_item_id);

COMMENT ON COLUMN return_line_items.condition IS
  'What arrived. Only `resellable` units re-enter sellable stock; the rest are written off.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Permissions
--
-- Receiving a return is a warehouse decision and approving one is a customer
-- service decision — neither is "editing an order", so neither borrows
-- `orders:write`. Refunding a return additionally requires `payments:refund`,
-- checked together on that one route: deciding goods may come back and deciding
-- to send money are two approvals, and one person holding only the first should
-- not be able to do the second by using a different button.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO permissions (key, description) VALUES
  ('returns:read',  'See return requests and their contents'),
  ('returns:write', 'Approve, decline, receive and close returns')
ON CONFLICT (key) DO NOTHING;

-- Staff run the returns desk; that is the job.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.key IN ('staff', 'admin', 'owner')
   AND p.key IN ('returns:read', 'returns:write')
ON CONFLICT DO NOTHING;
