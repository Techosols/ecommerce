-- 0025_shipping_zone_lifecycle.sql
-- Zones you can retire, and country coverage that resolves to one answer.
-- Forward-only. Never edit a migration that has been applied (§4.4).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why archive rather than delete
--
-- 0013 gave `shipping_methods` an `archived_at` and gave zones nothing, so the
-- only way to remove a zone was `DELETE`, which cascades to its methods. Those
-- methods are cited by orders (`orders.shipping_method_id`, ON DELETE SET
-- NULL): deleting a zone therefore quietly blanks the link between old orders
-- and how they were shipped. The order keeps its snapshotted method name, so
-- nothing is *wrong* on the invoice, but the rate card those orders were priced
-- against stops existing, which is exactly the history an audit needs.
--
-- Zones now retire the way methods and everything else in this schema retire:
-- the row stays, `archived_at` is set, and every read path that quotes a
-- shopper filters it out.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why the overlap rule is not a constraint
--
-- Two live zones both listing 'GB' make the quote non-deterministic: the
-- shopper is offered both zones' methods, ordered by position and price, and
-- which zone "won" depends on data nobody meant to be a tie-break. The rule
-- wanted is "no country appears in more than one live zone", which is an
-- exclusion constraint over an array (`EXCLUDE USING gist (country_codes WITH
-- &&) WHERE (archived_at IS NULL AND is_active)`) — and char(2)[] has no gist
-- opclass without an extension this schema does not otherwise need.
--
-- So the rule lives in the service, which refuses the write and names both the
-- country and the zone that already claims it. This index is what makes that
-- check a lookup rather than a scan, and it is the same index the quote uses.

ALTER TABLE shipping_zones ADD COLUMN archived_at timestamptz;

-- The quote's real predicate: live zones covering one country. Partial, so an
-- archived zone is not merely filtered out later — it is not in the index.
DROP INDEX IF EXISTS shipping_zones_countries_idx;
CREATE INDEX shipping_zones_live_countries_idx
  ON shipping_zones USING gin (country_codes)
  WHERE archived_at IS NULL;

-- Ordering the rate card in the admin, where archived zones are listed last.
CREATE INDEX shipping_zones_position_idx ON shipping_zones (position, name)
  WHERE archived_at IS NULL;
