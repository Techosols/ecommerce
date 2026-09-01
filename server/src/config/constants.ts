/** Values that are fixed by the architecture rather than by deployment. */

export const API_PREFIX = '/api'
export const API_VERSION = 'v1'
export const API_BASE_PATH = `${API_PREFIX}/${API_VERSION}` as const

/** Request surfaces (§7.1). Each has its own middleware stack and CORS origin. */
export const SURFACES = ['auth', 'storefront', 'admin', 'webhooks'] as const
export type Surface = (typeof SURFACES)[number]

export const REQUEST_ID_HEADER = 'x-request-id'
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key'

/** Largest JSON body accepted on ordinary routes (§16.3). */
export const JSON_BODY_LIMIT = '256kb'

/** Queries slower than this are logged with their statement name (§15.3). */
export const SLOW_QUERY_THRESHOLD_MS = 200

/** Pagination defaults (§7.4). */
export const DEFAULT_PAGE_SIZE = 20
export const MAX_PAGE_SIZE = 100

/** How long an idempotency record is replayable before cleanup (§19.2). */
export const IDEMPOTENCY_TTL_HOURS = 24
/** An in-progress idempotency record older than this is assumed abandoned. */
export const IDEMPOTENCY_STALE_LOCK_SECONDS = 60

/** Grace periods used by the graceful shutdown sequence (§8.5). */
/**
 * How long to keep serving after readiness starts failing, so a load balancer
 * can take the instance out of rotation before the listener closes. Shorter
 * than the probe interval means 502s on every deploy; this is deliberately a
 * little longer than a typical 2s interval times two failures.
 */
export const SHUTDOWN_DRAIN_MS = 5_000

export const SHUTDOWN_ABORT_AFTER_MS = 20_000
export const SHUTDOWN_FORCE_AFTER_MS = 25_000

/** Maximum outbox dispatch attempts before an event is parked (§12.1). */
export const EVENT_MAX_DISPATCH_ATTEMPTS = 10
