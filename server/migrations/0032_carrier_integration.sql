-- 0032_carrier_integration.sql
-- Connecting a courier: what it told us, and what cash it handed back.
-- Forward-only. Never edit a migration that has been applied (§4.4).
--
-- ── What this does not do ────────────────────────────────────────────────────
--
-- It does not name a courier. Which one is configured lives in the environment
-- and behind the `CarrierProvider` seam, exactly as the email and storage
-- providers are, so signing with a different courier is a config change and one
-- new file rather than a migration.
--
-- Everything below is therefore courier-agnostic: a scan event is a scan event
-- whether it came from TCS or Leopards, and a remittance line is a remittance
-- line. The provider translates each courier's vocabulary at the edge, which is
-- what stops that vocabulary leaking into the rest of the system.

-- ── What the courier told us about a parcel ──────────────────────────────────
--
-- Separate from `shipments` rather than columns on it, because a parcel has
-- *many* scans and the interesting question is usually "where has it been", not
-- "where is it now". The shipment keeps the current status; this is the trail.
--
-- Both the mapped status and the courier's raw code are kept. The mapped one is
-- what the system acts on; the raw one is what makes a mis-mapping diagnosable
-- six weeks later, when the only evidence is that an order sat in the wrong
-- state.
CREATE TABLE shipment_tracking_events (
  id            uuid PRIMARY KEY,
  shipment_id   uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,

  -- The shop's vocabulary, mapped by the provider. Deliberately the same set
  -- the shipment itself uses: one vocabulary, not two.
  status        text NOT NULL
                  CHECK (status IN ('pending','processing','shipped','in_transit',
                                    'delivered','returned','failed')),
  -- The courier's own words, shown to staff beside the mapped status.
  description   text NOT NULL,
  location      text,
  -- The courier's code, exactly as sent.
  raw_status    text,

  -- When the courier says it happened, which is not when we heard about it.
  -- A poll every fifteen minutes would otherwise stamp a whole morning's scans
  -- with one timestamp and lose the order they happened in.
  occurred_at   timestamptz NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),

  -- Which courier reported it. Kept per row because a shop can change courier
  -- while parcels from the old one are still moving.
  provider      text NOT NULL,

  /*
   * Exactly-once, by constraint rather than by hope.
   *
   * Polling re-reads the whole history every time and a webhook is redelivered
   * by every courier that has one, so the same scan arrives repeatedly. Without
   * this the trail fills with duplicates and "delivered" fires an email each
   * time it is re-seen.
   */
  CONSTRAINT shipment_tracking_events_once
    UNIQUE (shipment_id, occurred_at, status, description)
);

CREATE INDEX shipment_tracking_events_shipment_idx
  ON shipment_tracking_events (shipment_id, occurred_at DESC);

COMMENT ON TABLE shipment_tracking_events IS
  'Courier scans for a parcel. The shipment holds the current status; this is the trail.';

-- ── Cash the courier collected on our behalf ─────────────────────────────────
--
-- For a cash-on-delivery shop this is the money. The courier takes the cash at
-- the door, keeps its fee, and pays the rest over in batches days or weeks
-- later — and reconciling those batches against orders is, in most shops doing
-- this, somebody's afternoon with a spreadsheet.
--
-- A statement is recorded as a batch with its lines, rather than as a column on
-- the order, because that is what actually arrives and because the batch is
-- what gets queried: "what did they pay us on the 3rd, and which orders was it
-- for".

CREATE TABLE cod_remittances (
  id             uuid PRIMARY KEY,
  provider       text NOT NULL,
  -- The courier's own statement number, when it has one.
  reference      text,
  -- What the courier says it is paying, before we check.
  declared_net_cents bigint NOT NULL DEFAULT 0,
  currency       char(3) NOT NULL,
  -- The date on the statement, not the date it was imported.
  statement_date date,

  -- The file it was read from, so an argument can be settled against the
  -- original rather than against what we parsed out of it.
  source_filename text,

  imported_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  imported_at    timestamptz NOT NULL DEFAULT now(),

  -- One statement is imported once. A re-import of the same reference is a
  -- mistake to catch, not a second payment to record.
  CONSTRAINT cod_remittances_reference_once UNIQUE (provider, reference)
);

CREATE TABLE cod_remittance_lines (
  id              uuid PRIMARY KEY,
  remittance_id   uuid NOT NULL REFERENCES cod_remittances(id) ON DELETE CASCADE,

  -- What the courier called the parcel. This is the join key, because it is the
  -- only thing both sides agree on.
  tracking_number text NOT NULL,

  -- Resolved when the tracking number matches a shipment we know about. Left
  -- null when it does not, which is itself the finding: a line nobody can
  -- account for is exactly what an operator needs to see.
  shipment_id     uuid REFERENCES shipments(id) ON DELETE SET NULL,
  order_id        uuid REFERENCES orders(id) ON DELETE SET NULL,

  collected_cents bigint NOT NULL,
  fee_cents       bigint NOT NULL DEFAULT 0,
  net_cents       bigint NOT NULL,
  currency        char(3) NOT NULL,
  collected_at    timestamptz,
  reference       text,

  /*
   * What the reconciliation found.
   *
   *   matched    the line names an order and the amount agrees
   *   mismatched it names an order and the amount does not — the case that
   *              actually matters, and the reason this is not a boolean
   *   unmatched  no order of ours has that tracking number
   */
  match_status    text NOT NULL DEFAULT 'unmatched'
                    CHECK (match_status IN ('matched','mismatched','unmatched')),
  -- The order's own outstanding balance at import, so a later change to the
  -- order does not silently rewrite history.
  expected_cents  bigint,

  created_at      timestamptz NOT NULL DEFAULT now(),

  -- The same parcel cannot appear twice in one statement.
  CONSTRAINT cod_remittance_lines_once UNIQUE (remittance_id, tracking_number)
);

CREATE INDEX cod_remittance_lines_remittance_idx ON cod_remittance_lines (remittance_id);
CREATE INDEX cod_remittance_lines_order_idx ON cod_remittance_lines (order_id);
-- The query an operator runs: "what has not been accounted for".
CREATE INDEX cod_remittance_lines_unresolved_idx
  ON cod_remittance_lines (match_status) WHERE match_status <> 'matched';

COMMENT ON TABLE cod_remittances IS
  'A courier statement of cash collected on delivery, as imported.';
COMMENT ON COLUMN cod_remittance_lines.match_status IS
  'matched | mismatched | unmatched — mismatched is the one that needs a person.';

-- ── What the courier is called on a shipment ─────────────────────────────────
--
-- `shipments.carrier` is free text an operator types, and stays that way: it is
-- what a human wrote on a parcel. This records which *provider* booked it,
-- which is a different fact and the one that decides who to ask for tracking.
ALTER TABLE shipments ADD COLUMN carrier_provider text;
ALTER TABLE shipments ADD COLUMN carrier_consignment_id text;

-- Polling asks "which parcels are still moving, and who booked them". 0013
-- already indexes `tracking_number` alone for lookups by number; this one is
-- partial and exists for the sweep, which reads only the parcels still moving.
CREATE INDEX shipments_in_flight_idx
  ON shipments (carrier_provider, tracking_number)
  WHERE tracking_number IS NOT NULL
    AND status NOT IN ('delivered', 'returned', 'failed');

COMMENT ON COLUMN shipments.carrier_provider IS
  'Which CarrierProvider booked this parcel, so tracking asks the right one.';
