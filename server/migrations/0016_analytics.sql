-- 0016_analytics.sql
-- Behavioural events and daily rollups (§5.11, §13).
-- Forward-only. Never edit a migration that has been applied (§4.4).
--
-- Three layers by cost (§13.1): live queries for small ranges, nightly rollups
-- for dashboards and trends, raw behavioural events for funnels. The dashboard
-- reads rollups, so a year of trend data is a few hundred rows rather than a
-- scan of every order.

-- Storefront behaviour. Append-only, and deliberately not joined to orders:
-- this is what people did, not what they bought.
CREATE TABLE analytics_events (
  id           bigserial PRIMARY KEY,
  name         text NOT NULL,
  occurred_at  timestamptz NOT NULL,
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  anonymous_id uuid,
  session_id   uuid,
  properties   jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX analytics_events_name_idx ON analytics_events (name, occurred_at DESC);
CREATE INDEX analytics_events_time_idx ON analytics_events (occurred_at DESC);
CREATE INDEX analytics_events_session_idx ON analytics_events (session_id, occurred_at);

-- Keyed by store-local date, computed by the nightly rollup. Recomputed
-- idempotently for a given date, so a re-run corrects rather than duplicates.
CREATE TABLE analytics_daily_sales (
  date                date PRIMARY KEY,
  orders_count        integer NOT NULL DEFAULT 0,
  cancelled_count     integer NOT NULL DEFAULT 0,
  units_sold          integer NOT NULL DEFAULT 0,
  gross_sales_cents   bigint  NOT NULL DEFAULT 0,
  discounts_cents     bigint  NOT NULL DEFAULT 0,
  refunds_cents       bigint  NOT NULL DEFAULT 0,
  net_sales_cents     bigint  NOT NULL DEFAULT 0,
  tax_cents           bigint  NOT NULL DEFAULT 0,
  shipping_cents      bigint  NOT NULL DEFAULT 0,
  total_cents         bigint  NOT NULL DEFAULT 0,
  aov_cents           integer NOT NULL DEFAULT 0,
  new_customers       integer NOT NULL DEFAULT 0,
  returning_customers integer NOT NULL DEFAULT 0,
  computed_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE analytics_product_daily (
  date              date NOT NULL,
  variant_id        uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  product_id        uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  units_sold        integer NOT NULL DEFAULT 0,
  gross_sales_cents bigint  NOT NULL DEFAULT 0,
  discounts_cents   bigint  NOT NULL DEFAULT 0,
  refunds_cents     bigint  NOT NULL DEFAULT 0,
  net_sales_cents   bigint  NOT NULL DEFAULT 0,
  orders_count      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (date, variant_id)
);

CREATE INDEX analytics_product_top_idx ON analytics_product_daily (date, net_sales_cents DESC);
CREATE INDEX analytics_product_history_idx ON analytics_product_daily (product_id, date);
