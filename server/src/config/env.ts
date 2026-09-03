/**
 * The single reader of `process.env` in the entire codebase (§16.8).
 *
 * Parsing happens once, at import time. A missing or malformed variable stops
 * the process immediately with a readable report rather than surfacing as a
 * confusing failure on the first request that happens to need it.
 *
 * An ESLint rule (`no-restricted-syntax`) fails the build if any other module
 * reads `process.env`.
 */
import { existsSync } from 'node:fs'
import { z } from 'zod'

// Node 22 can load a .env file without a dependency. Real deployments inject
// variables through the platform, so a missing file is never an error.
const envFile = process.env.ENV_FILE ?? '.env'
if (existsSync(envFile)) {
  process.loadEnvFile(envFile)
}

const bool = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1')

/**
 * Exported so the configuration rules — which are the only thing standing
 * between a misconfigured deploy and, say, ephemeral storage in production —
 * can be tested directly rather than only via whatever this process booted
 * with.
 */
export const envSchema = z
  .object({
    // Runtime
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_ENV: z.enum(['local', 'staging', 'production']).default('local'),
    PORT: z.coerce.number().int().positive().max(65535).default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'silent']).default('info'),
    LOG_PRETTY: bool.default(false),
    /** Injected by the build pipeline; surfaced by GET /version. */
    GIT_COMMIT: z.string().default('unknown'),

    // Database
    DATABASE_URL: z.string().min(1),
    DATABASE_DIRECT_URL: z.string().min(1),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    DATABASE_SSL: bool.default(false),

    // Tokens
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_PREVIOUS_ACCESS_SECRET: z.string().min(32).optional(),
    JWT_ACCESS_TTL: z.string().default('15m'),
    JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
    JWT_ISSUER: z.string().default('ecommerce-api'),

    // Credential flows
    EMAIL_VERIFICATION_TTL_HOURS: z.coerce.number().int().positive().default(24),
    PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().positive().default(60),
    /** Consecutive failures before the account locks (§6.4). */
    LOGIN_MAX_FAILURES: z.coerce.number().int().positive().default(10),
    LOGIN_FAILURE_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
    /**
     * SameSite for the refresh cookie. `strict` is correct when the frontends
     * share a registrable domain with the API. Set `none` (which forces Secure)
     * only when they genuinely cannot.
     */
    AUTH_COOKIE_SAMESITE: z.enum(['strict', 'lax', 'none']).default('strict'),

    /**
     * Shared secret for verifying inbound payment-provider callbacks (§16.6).
     *
     * Optional because v1 ships a manual provider and has no gateway to hear
     * from. When it is unset the webhook endpoint refuses every request rather
     * than accepting unverified ones — an unsigned webhook that is honoured is
     * an unauthenticated write to the payments table.
     */
    PAYMENT_WEBHOOK_SECRET: z.string().min(16).optional(),

    // CORS
    CLIENT_ORIGIN: z.url(),
    ADMIN_ORIGIN: z.url(),
    COOKIE_DOMAIN: z.string().optional(),

    // Queue / workers
    RUN_WORKERS_IN_PROCESS: bool.default(false),
    QUEUE_SCHEMA: z.string().default('pgboss'),
    EVENT_DISPATCH_INTERVAL_MS: z.coerce.number().int().positive().default(500),
    EVENT_DISPATCH_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(50),

    // Email
    EMAIL_PROVIDER: z.enum(['console', 'smtp']).default('console'),
    EMAIL_FROM: z.email(),
    EMAIL_REPLY_TO: z.email().optional(),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().max(65535).optional(),
    SMTP_SECURE: bool.default(false),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    /**
     * Keep one connection open across messages.
     *
     * Off by default. Many shared and cPanel-style hosts close an
     * authenticated connection after a single message or allow only one at a
     * time, and a pooled transport then fails every send after the first — so
     * the first email of an order arrives and the staff copies do not. Turn it
     * on for a provider that wants it (SES, Postmark, your own Postfix).
     */
    SMTP_POOL: bool.default(false),
    SMTP_MAX_CONNECTIONS: z.coerce.number().int().positive().max(20).optional(),

    // ── Object storage ────────────────────────────────────────────────────
    // Supabase Storage is the production backend. `local` writes to disk for
    // development; `memory` exists for tests. Only this block, and the adapters
    // under infrastructure/storage/, know Supabase exists (§46).
    STORAGE_PROVIDER: z.enum(['supabase', 'local', 'memory']).default('local'),
    SUPABASE_URL: z.url().optional(),
    /** Server-only. Never sent to a browser, never logged (§40). */
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
    SUPABASE_STORAGE_BUCKET: z.string().min(1).default('media'),
    /**
     * A public bucket lets product images be served and CDN-cached directly.
     * A private bucket means every read is a signed URL with a TTL — correct
     * for anything sensitive, wrong for a catalogue page.
     */
    SUPABASE_STORAGE_PUBLIC: bool.default(true),
    STORAGE_LOCAL_DIR: z.string().default('tmp/storage'),
    /** Where the local provider's objects are served from in development. */
    STORAGE_LOCAL_BASE_URL: z.string().default('http://localhost:4000/local-storage'),

    // Media
    MEDIA_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .max(50 * 1024 * 1024)
      .default(10 * 1024 * 1024),
    MEDIA_UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().default(300),
    MEDIA_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(3600),

    // Staff invitations
    STAFF_INVITATION_TTL_HOURS: z.coerce.number().int().positive().default(168),

    // Realtime
    SOCKET_ENABLED: bool.default(true),
    SOCKET_MAX_CONNECTIONS_PER_USER: z.coerce.number().int().positive().default(10),

    // Rate limiting
    RATE_LIMIT_ENABLED: bool.default(true),
    /**
     * How many reverse proxies sit in front of this process.
     *
     * Getting this wrong is not a subtle misconfiguration. With 0 behind a load
     * balancer, `req.ip` is the balancer's address for *every* request, so
     * every per-IP rate limit — five registrations an hour, twenty logins in
     * fifteen minutes — collapses into a single shared bucket and the whole
     * store is locked out of signing in within minutes of real traffic.
     * Production therefore refuses to boot with the default (see below).
     */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

    // Observability
    /**
     * Where the worker serves /healthz and /readyz. Different from PORT so both
     * processes can run on one machine in development.
     */
    WORKER_HEALTH_PORT: z.coerce.number().int().positive().max(65535).default(4001),
    METRICS_ENABLED: bool.default(false),
    METRICS_TOKEN: z.string().min(16).optional(),
  })
  .superRefine((v, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message })

    if (v.EMAIL_PROVIDER === 'smtp' && !v.SMTP_HOST) {
      issue('SMTP_HOST', 'required when EMAIL_PROVIDER=smtp')
    }
    if (v.METRICS_ENABLED && !v.METRICS_TOKEN) {
      issue('METRICS_TOKEN', 'required when METRICS_ENABLED=true')
    }
    if (v.STORAGE_PROVIDER === 'supabase') {
      if (!v.SUPABASE_URL) issue('SUPABASE_URL', 'required when STORAGE_PROVIDER=supabase')
      if (!v.SUPABASE_SERVICE_ROLE_KEY) {
        issue('SUPABASE_SERVICE_ROLE_KEY', 'required when STORAGE_PROVIDER=supabase')
      }
    }
    if (v.NODE_ENV === 'production') {
      if (v.EMAIL_PROVIDER === 'console') {
        issue('EMAIL_PROVIDER', 'the console email provider must not be used in production')
      }
      if (v.RUN_WORKERS_IN_PROCESS) {
        issue(
          'RUN_WORKERS_IN_PROCESS',
          'workers must run as their own process in production (§1.1)',
        )
      }
      if (!v.DATABASE_SSL) {
        issue('DATABASE_SSL', 'must be true in production')
      }
      if (v.STORAGE_PROVIDER !== 'supabase') {
        issue(
          'STORAGE_PROVIDER',
          'must be "supabase" in production; local and memory storage do not survive a redeploy',
        )
      }
      if (v.JWT_ACCESS_SECRET.startsWith('replace-me')) {
        issue('JWT_ACCESS_SECRET', 'still set to the example placeholder')
      }
      if (v.AUTH_COOKIE_SAMESITE === 'none' && !v.CLIENT_ORIGIN.startsWith('https://')) {
        issue('AUTH_COOKIE_SAMESITE', 'SameSite=None requires HTTPS origins')
      }
      if (v.RATE_LIMIT_ENABLED && v.TRUST_PROXY_HOPS === 0) {
        issue(
          'TRUST_PROXY_HOPS',
          'must be set to the number of proxies in front of this process; ' +
            'with 0 behind a load balancer every request appears to come from ' +
            'one address and per-IP rate limits lock out the whole store',
        )
      }
    }
  })

export type Env = z.infer<typeof envSchema>

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env)
  if (parsed.success) return parsed.data

  const lines = parsed.error.issues.map((i) => {
    const path = i.path.length > 0 ? i.path.join('.') : '(root)'
    return `  • ${path}: ${i.message}`
  })
  // Deliberately process.stderr rather than the logger: the logger itself is
  // configured from this module, so it does not exist yet.
  process.stderr.write(
    `\nInvalid environment configuration:\n${lines.join('\n')}\n\n` +
      `See .env.example for the full list of variables.\n\n`,
  )
  process.exit(1)
}

export const env: Env = loadEnv()

export const isProduction = env.NODE_ENV === 'production'
export const isTest = env.NODE_ENV === 'test'
export const isDevelopment = env.NODE_ENV === 'development'
