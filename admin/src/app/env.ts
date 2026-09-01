/**
 * Build-time configuration, read once and validated once.
 *
 * Vite inlines `import.meta.env` at build time, so a missing variable is a
 * blank string in the bundle rather than a crash on the server. Failing here,
 * loudly, at module load is the only way that mistake surfaces before a user
 * meets it as an unexplained 404.
 */

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

/**
 * Where the API lives. Empty by default: in development Vite proxies `/api`
 * and `/socket.io` to the backend, so a same-origin relative URL is correct and
 * the refresh cookie behaves exactly as it will in production.
 */
const apiOrigin = readString(import.meta.env.VITE_API_URL, '').replace(/\/+$/, '')

export const env = {
  apiOrigin,
  /** Matches the server's `API_BASE_PATH`. */
  apiBasePath: readString(import.meta.env.VITE_API_BASE_PATH, '/api/v1'),
  /** Matches the server's Socket.IO `path` option. */
  socketPath: readString(import.meta.env.VITE_SOCKET_PATH, '/socket.io'),
  appName: readString(import.meta.env.VITE_APP_NAME, 'Store Admin'),
  isDev: import.meta.env.DEV,
  isProd: import.meta.env.PROD,
} as const

/** Absolute (or origin-relative) base for every REST call. */
export const API_BASE_URL = `${env.apiOrigin}${env.apiBasePath}`

/** The Socket.IO server namespace staff connect to. */
export const SOCKET_NAMESPACE_URL = `${env.apiOrigin}/admin`
