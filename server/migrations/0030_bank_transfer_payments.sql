-- 0030_bank_transfer_payments.sql
-- Bank transfer with a screenshot as proof, verified by hand.
-- Forward-only. Never edit a migration that has been applied (§4.4).
--
-- ── What this is, and what it deliberately is not ────────────────────────────
--
-- A customer transfers the total to the shop's account in their own banking
-- app, then comes back and says "here is what I sent". A member of staff looks
-- at the screenshot against the shop's statement and decides. Nothing here
-- talks to a bank, and nothing here believes a customer about money.
--
-- That last point shapes the whole table. Everything the customer submits is
-- a **claim**, stored so a human can compare it against the truth — never used
-- to compute a balance, mark an order paid, or decide an amount. When a proof
-- is approved the money is recorded through the ordinary payments path, for
-- the order's own outstanding total, exactly as a staff member marking an order
-- paid does today. `payment_proofs` is evidence; `payments` remains the ledger.
--
-- When the automated bank feed arrives later, it becomes another way to reach
-- the same `approved` state — the review queue empties itself instead of being
-- worked by hand. The shape does not have to change for that.

-- ── Where the money should be sent ───────────────────────────────────────────
--
-- On settings rather than in a config file: the account can change, changing it
-- is an ordinary shop decision, and the audit trail on settings is where the
-- record of that change belongs.

ALTER TABLE store_settings ADD COLUMN bank_transfer_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE store_settings ADD COLUMN bank_account_name text;
ALTER TABLE store_settings ADD COLUMN bank_name text;
ALTER TABLE store_settings ADD COLUMN bank_account_number text;
ALTER TABLE store_settings ADD COLUMN bank_iban text;
ALTER TABLE store_settings ADD COLUMN bank_swift text;
-- Free text shown under the account details: "quote your order number", branch
-- codes, whatever this particular bank needs. Not parsed, only displayed.
ALTER TABLE store_settings ADD COLUMN bank_instructions text;

-- The method cannot be switched on without somewhere to send the money. Without
-- this the storefront would offer bank transfer and then show a blank panel,
-- and the shop would find out from a customer.
ALTER TABLE store_settings ADD CONSTRAINT bank_transfer_needs_an_account CHECK (
  NOT bank_transfer_enabled
  OR (
    length(btrim(coalesce(bank_account_name, ''))) > 0
    AND length(btrim(coalesce(bank_name, ''))) > 0
    AND (
      length(btrim(coalesce(bank_account_number, ''))) > 0
      OR length(btrim(coalesce(bank_iban, ''))) > 0
    )
  )
);

COMMENT ON COLUMN store_settings.bank_transfer_enabled IS
  'Whether customers may choose bank transfer. Guarded by bank_transfer_needs_an_account.';

-- ── The proof ────────────────────────────────────────────────────────────────

CREATE TABLE payment_proofs (
  id                   uuid PRIMARY KEY,
  -- RESTRICT, like `payments`: an order with evidence against it is not
  -- something to delete quietly.
  order_id             uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  status               text NOT NULL DEFAULT 'submitted'
                         CHECK (status IN ('submitted', 'approved', 'rejected')),

  -- The screenshot. RESTRICT because the evidence is the point of the row: a
  -- media sweep must not be able to leave an approved payment with nothing
  -- behind it.
  media_id             uuid NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,

  -- ── What the customer claims. All of it unverified, none of it authoritative.
  sender_name          text NOT NULL CHECK (length(btrim(sender_name)) > 0),
  sender_bank          text NOT NULL CHECK (length(btrim(sender_bank)) > 0),
  -- Four digits, or nothing. Deliberately not the whole account number: it is
  -- enough to match a line on a statement and not enough to be worth stealing.
  account_last4        text CHECK (account_last4 IS NULL OR account_last4 ~ '^[0-9]{4}$'),

  -- ── The decision.
  reviewed_at          timestamptz,
  -- SET NULL: the decision outlives the person who made it. `reviewed_by_name`
  -- keeps the record readable after the account is gone, the same way
  -- `customer_events.actor_name` does.
  reviewed_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by_name     text,
  -- Why it was rejected. Shown to the customer, so it is written for them.
  review_note          text,

  -- The payment this proof produced, once approved. Nullable and set after the
  -- fact: the payment is created by the ordinary payments path, and this is the
  -- link back, not the source of truth.
  payment_id           uuid REFERENCES payments(id) ON DELETE SET NULL,

  -- Who submitted it, when it can be told. Null for a guest working from an
  -- order-lookup link, which is the common case.
  submitted_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  submitted_at         timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  -- A decision has a date and a decider; an undecided proof has neither.
  CONSTRAINT reviewed_proofs_say_when CHECK (
    (status = 'submitted') = (reviewed_at IS NULL)
  ),
  -- A rejection has to say why. "Rejected" with no reason is a support ticket.
  CONSTRAINT rejections_give_a_reason CHECK (
    status <> 'rejected' OR length(btrim(coalesce(review_note, ''))) > 0
  )
);

CREATE TRIGGER payment_proofs_set_updated_at
  BEFORE UPDATE ON payment_proofs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One proof awaiting review per order. A customer who submits twice while
-- waiting would otherwise put the same order in the queue twice, and two staff
-- could approve both and record the money twice. Resubmission after a rejection
-- is fine, which is why this is partial rather than a plain unique on order_id.
CREATE UNIQUE INDEX payment_proofs_one_pending_per_order
  ON payment_proofs (order_id) WHERE status = 'submitted';

-- The review queue: oldest first, so nobody waits behind a later submission.
CREATE INDEX payment_proofs_queue_idx
  ON payment_proofs (submitted_at) WHERE status = 'submitted';

CREATE INDEX payment_proofs_order_idx ON payment_proofs (order_id, submitted_at DESC);

COMMENT ON TABLE payment_proofs IS
  'Customer-submitted evidence of a bank transfer. Claims, not money: the payments table remains the ledger.';
COMMENT ON COLUMN payment_proofs.account_last4 IS
  'Last four digits only — enough to match a statement line, not enough to be worth stealing.';
