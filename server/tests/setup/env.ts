/**
 * Test environment. Loaded by Vitest before any module under test, so that
 * `config/env.ts` parses a known-good configuration at import time.
 */
process.env.NODE_ENV = 'test'
process.env.APP_ENV = 'local'
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent'
process.env.LOG_PRETTY = 'false'

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL ?? ''
process.env.DATABASE_DIRECT_URL ??= process.env.TEST_DATABASE_URL ?? ''
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
process.env.DATABASE_DIRECT_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_DIRECT_URL

// Placeholder that satisfies the schema when no database is configured; the
// integration suites skip themselves rather than connecting to it.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgres://unset/unset'
  process.env.DATABASE_DIRECT_URL = 'postgres://unset/unset'
}

process.env.JWT_ACCESS_SECRET ??= 'test-secret-value-that-is-long-enough-1234567890'
process.env.JWT_ISSUER ??= 'ecommerce-api'
process.env.CLIENT_ORIGIN ??= 'http://localhost:5173'
process.env.ADMIN_ORIGIN ??= 'http://localhost:5174'
process.env.EMAIL_PROVIDER ??= 'console'
process.env.EMAIL_FROM ??= 'store@example.test'
process.env.RATE_LIMIT_ENABLED ??= 'false'
process.env.SOCKET_ENABLED ??= 'true'
process.env.RUN_WORKERS_IN_PROCESS ??= 'false'
