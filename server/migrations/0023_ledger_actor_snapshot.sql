-- 0023_ledger_actor_snapshot.sql
-- An append-only ledger cannot hold a foreign key that mutates on delete.
-- Forward-only. Never edit a migration that has been applied (§4.4).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- The contradiction
--
-- `inventory_movements` and `order_status_history` are append-only, enforced by
-- `refuse_mutation()` on BEFORE UPDATE OR DELETE. Both also carried
--
--     actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL
--
-- and `ON DELETE SET NULL` is an UPDATE. So deleting any user who had ever
-- moved stock or moved an order's status raised
--
--     relation inventory_movements is append-only; write a compensating row
--
-- from inside the delete, and there was no way for a caller to avoid it: the
-- rows cannot be updated, cannot be deleted, and cannot be left pointing at a
-- row that is going away. The only user deletion the system performs is the
-- losing side of a customer merge, which is where this surfaced — a customer
-- who had ever checked out could not be merged, which is most of them.
--
-- ── The fix ──────────────────────────────────────────────────────────────────
--
-- Drop the constraint and keep the column. On a ledger the actor is a
-- *historical fact* — who did this, at the time — not a live association, and
-- the same reasoning already applies to every other snapshot in the schema:
-- order addresses are copies, order discounts store their own name and amount,
-- `order_notes` and `customer_events` snapshot the author's name so the entry
-- survives the account. A ledger row whose actor has since been deleted keeps
-- the id it recorded; a join to `users` simply finds nobody, which is the
-- truth. `audit_logs` remains the place that answers "who did what", and it
-- keeps its FK because it is not append-only at the database level.
--
-- Nothing is lost by dropping the constraint: it never protected the ledger,
-- because the ledger refuses every mutation the constraint could make.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE inventory_movements DROP CONSTRAINT inventory_movements_actor_user_id_fkey;
ALTER TABLE order_status_history DROP CONSTRAINT order_status_history_actor_user_id_fkey;

COMMENT ON COLUMN inventory_movements.actor_user_id IS
  'Who moved it, recorded at the time. Deliberately not a foreign key: this ledger is append-only, so a referential action on it is impossible.';
COMMENT ON COLUMN order_status_history.actor_user_id IS
  'Who moved it, recorded at the time. Deliberately not a foreign key, for the same reason as inventory_movements.';
