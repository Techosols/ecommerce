-- 0012_payments.sql
-- Payments, refunds and inbound provider webhooks (§5.7).
-- Forward-only. Never edit a migration that has been applied (§4.4).
--
-- v1 ships a `manual` provider: cash on delivery and bank transfer, marked paid
-- by staff. The table is shaped for a real gateway from the start —
-- `provider_payment_id`, idempotency keys, an authorize/capture split — because
-- retrofitting those onto a live payments table is not something anyone should
-- have to do.

CREATE TABLE payments (
  id                  uuid PRIMARY KEY,
  -- RESTRICT: an order with money against it cannot be deleted.
  order_id            uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  provider            text NOT NULL,
  provider_payment_id text,
  method              text NOT NULL CHECK (method IN ('manual','cod','bank_transfer','card')),
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','authorized','paid','failed',
                                          'cancelled','refunded','partially_refunded')),
  amount_cents        integer NOT NULL CHECK (amount_cents > 0),
  currency            char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  refunded_cents      integer NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  failure_code        text,
  failure_message     text,
  idempotency_key     text,
  metadata            jsonb NOT NULL DEFAULT '{}',
  authorized_at       timestamptz,
  captured_at         timestamptz,
  failed_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refund_within_payment CHECK (refunded_cents <= amount_cents)
);

CREATE TRIGGER payments_set_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One row per provider payment: a duplicated callback cannot create a second.
CREATE UNIQUE INDEX payments_provider_ref_idx ON payments (provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;
CREATE UNIQUE INDEX payments_idempotency_idx ON payments (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX payments_order_idx ON payments (order_id);
CREATE INDEX payments_status_idx ON payments (status) WHERE status IN ('pending','authorized');

CREATE TABLE refunds (
  id                 uuid PRIMARY KEY,
  payment_id         uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  order_id           uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  provider_refund_id text,
  amount_cents       integer NOT NULL CHECK (amount_cents > 0),
  reason             text,
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','succeeded','failed')),
  -- Whether the goods came back. Drives the inventory return movement.
  restock            boolean NOT NULL DEFAULT false,
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key    text UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER refunds_set_updated_at
  BEFORE UPDATE ON refunds
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX refunds_order_idx ON refunds (order_id);
CREATE INDEX refunds_payment_idx ON refunds (payment_id);

-- Every inbound provider callback, deduplicated at the storage layer.
--
-- The UNIQUE below is the entire duplicate-webhook defence: a second delivery
-- of the same event fails the insert, and the handler answers 200 without
-- reprocessing. One line of DDL doing what would otherwise be fragile
-- application logic.
CREATE TABLE webhook_events (
  id                 bigserial PRIMARY KEY,
  provider           text NOT NULL,
  provider_event_id  text NOT NULL,
  event_type         text NOT NULL,
  payload            jsonb NOT NULL,
  signature_verified boolean NOT NULL DEFAULT false,
  received_at        timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz,
  attempts           integer NOT NULL DEFAULT 0,
  last_error         text,
  CONSTRAINT one_row_per_provider_event UNIQUE (provider, provider_event_id)
);

CREATE INDEX webhook_events_pending_idx ON webhook_events (processed_at) WHERE processed_at IS NULL;
