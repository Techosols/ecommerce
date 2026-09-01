-- 0027_draft_order_lines.sql
-- What a draft points at once it has been placed.
-- Forward-only. Never edit a migration that has been applied (§4.4).
--
-- 0026 made `draft` a status and audited the read paths. This adds the one
-- column the placement step needs.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why placing a draft makes a second row
--
-- Checkout creates the order. That is the whole of its job and the reason it
-- can guarantee what it guarantees: one transaction that reserves stock,
-- snapshots the lines, copies the addresses and raises `order.placed`, or does
-- none of it. Making it *fill in* an existing row instead would mean a second
-- code path through the most important function in the system, so a draft is
-- placed by running the ordinary checkout over the draft's lines — producing a
-- real order — and the draft then points at it.
--
-- The draft is kept rather than deleted. It records what was quoted, by whom,
-- and when it became a sale; deleting it would leave the order with no account
-- of where it came from.

ALTER TABLE orders ADD COLUMN placed_order_id uuid REFERENCES orders(id) ON DELETE SET NULL;

-- Only a draft may point at another order, and only once it has been placed.
ALTER TABLE orders ADD CONSTRAINT only_drafts_are_placed_from CHECK (
  placed_order_id IS NULL OR status = 'draft'
);

CREATE INDEX orders_placed_from_draft_idx ON orders (placed_order_id)
  WHERE placed_order_id IS NOT NULL;

-- The code a staff member typed while quoting.
--
-- An *input* to the quote rather than a fact about the order: once the draft
-- is placed, checkout validates the code afresh and records what it was worth
-- in `order_discounts`, which is where a real order's discount lives. Keeping
-- it here would be a second answer to the same question.
ALTER TABLE orders ADD COLUMN draft_discount_code text;

ALTER TABLE orders ADD CONSTRAINT only_drafts_hold_a_quoted_code CHECK (
  draft_discount_code IS NULL OR status = 'draft'
);
