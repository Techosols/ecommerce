/**
 * Integration-test database harness (§20.3).
 *
 * Runs against a real PostgreSQL — never a mock, because the behaviour under
 * test *is* the database's: constraints, locking, SQLSTATE mapping.
 *
 * Two safety rules:
 *   • the database name must contain "test", so a misconfigured URL cannot
 *     truncate a real one
 *   • without TEST_DATABASE_URL the integration suites skip themselves with a
 *     clear message rather than failing mysteriously
 *
 * (Deviation from the plan, recorded deliberately: the plan named
 * testcontainers. Reading the URL from the environment covers the same ground —
 * docker compose locally, a service container in CI — without a heavyweight
 * dependency. Reinstating testcontainers would be a change to this file alone.)
 */
import { Pool } from 'pg'
import { describe } from 'vitest'
import { closePool, getPool, initPool } from '../../src/infrastructure/database/pool.js'
import { migrateUp } from '../../src/infrastructure/database/migrate/runner.js'
import { settingsService } from '../../src/features/settings/index.js'
import { categoriesService, productsService } from '../../src/features/catalogue/index.js'
import { locationsService } from '../../src/features/inventory/index.js'

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? ''
export const hasDatabase = TEST_DATABASE_URL.length > 0

/** Skips a whole suite, with a visible reason, when no test database is configured. */
export const describeIfDatabase = hasDatabase ? describe : describe.skip

let migrated = false

function assertTestDatabase(url: string): void {
  const name = url.split('/').pop()?.split('?')[0] ?? ''
  if (!name.includes('test')) {
    throw new Error(
      `Refusing to run integration tests against database "${name}": its name must contain "test".`,
    )
  }
}

/** Boots the pool and applies migrations once per test process. */
export async function setupDatabase(): Promise<void> {
  if (!hasDatabase) return
  assertTestDatabase(TEST_DATABASE_URL)

  initPool('cli')
  if (!migrated) {
    await migrateUp(getPool())
    migrated = true
  }
}

export async function teardownDatabase(): Promise<void> {
  if (!hasDatabase) return
  await closePool()
}

/**
 * Empties the application tables between tests. TRUNCATE ... RESTART IDENTITY
 * keeps sequences deterministic, which matters for tests that assert on order.
 */
export async function truncateAll(): Promise<void> {
  if (!hasDatabase) return
  // `users` cascades to user_roles, sessions and auth_tokens.
  // `roles` and `permissions` are seeded by migration 0004 and must survive —
  // truncating them would empty the authorisation matrix.
  // Commerce tables are listed explicitly rather than relied on to cascade.
  // Most of them *do* cascade from `users` — TRUNCATE ... CASCADE follows every
  // foreign key regardless of its ON DELETE action — but `shipping_zones`,
  // `discounts` and the analytics rollups have no path back to a user, and a
  // zone left behind by one test is a shipping rate the next test did not
  // create and cannot explain.
  await getPool().query(
    `TRUNCATE users, login_attempts, domain_events, idempotency_keys,
              email_messages, email_suppressions, media_assets, audit_logs,
              products, categories, collections,
              inventory_items, inventory_movements, inventory_reservations,
              carts, orders, payments, refunds, webhook_events,
              shipping_zones, shipping_methods, shipments,
              discounts, discount_redemptions,
              notifications, notification_preferences,
              analytics_events, analytics_daily_sales, analytics_product_daily
     RESTART IDENTITY CASCADE`,
  )

  // Order numbers come from a sequence, not from a row count, so truncation
  // alone leaves the next test starting at #1042. Resetting it keeps a test
  // that asserts on an order number deterministic.
  await getPool().query(`ALTER SEQUENCE order_number_seq RESTART WITH 1001`)

  // store_settings is seeded by migration 0006, but it carries an FK to
  // users(updated_by), so TRUNCATE ... CASCADE above empties it too. Restore
  // the seeded row and drop the in-process cache, or the next test sees either
  // no settings at all or a stale copy of the previous test's.
  await getPool().query(
    `INSERT INTO store_settings (id, store_name, contact_email)
     VALUES (1, 'My Store', 'store@example.com')
     ON CONFLICT (id) DO UPDATE SET
       store_name = excluded.store_name,
       contact_email = excluded.contact_email,
       support_url = NULL,
       support_phone = NULL,
       currency = 'USD',
       timezone = 'UTC',
       weight_unit = 'g',
       tax_rate_bps = 0,
       prices_include_tax = false,
       default_low_stock_threshold = 5,
       order_number_prefix = '#',
       reservation_ttl_minutes = 60,
       order_reservation_hours = 192,
       guest_checkout_enabled = true,
       cod_enabled = true,
       cod_min_subtotal_cents = 0,
       cod_max_subtotal_cents = NULL,
       cod_fee_cents = 0,
       cod_country_codes = '{}',
       cod_requires_account = false,
       cod_max_open_orders = NULL,
       logo_media_id = NULL,
       metadata = '{}',
       updated_by = NULL`,
  )
  settingsService.invalidate()
  productsService.clearCache()
  categoriesService.clearCache()
  locationsService.clearCache()

  // inventory_locations is seeded by migration 0008 and survives truncation
  // (nothing above cascades to it), but a test that added a branch would leak
  // it into the next one.
  await getPool().query(
    `DELETE FROM inventory_locations WHERE id <> '00000000-0000-4000-8000-000000000101'`,
  )
  await getPool().query(
    `UPDATE inventory_locations
        SET is_active = true, is_default = true, archived_at = NULL
      WHERE id = '00000000-0000-4000-8000-000000000101'`,
  )
}

/** A second, independent connection — needed to prove real lock contention. */
export function createIndependentPool(): Pool {
  return new Pool({ connectionString: TEST_DATABASE_URL, max: 2 })
}
