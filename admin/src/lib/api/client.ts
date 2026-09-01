import { API_BASE_URL } from '@/app/env'
import type { ErrorBody, Paginated, PaginationMeta, SuccessBody } from '@/types/api'
import { API_ERROR_CODES, ApiError } from './errors'
import { tokenStore } from './tokenStore'

/**
 * The one place the admin talks to the API.
 *
 * No component calls `fetch`. Everything goes through here so that four things
 * are true everywhere without anybody remembering them: the bearer token is
 * attached, the cookie is sent, the `{ success, data }` envelope is unwrapped,
 * and a failure is an `ApiError` carrying the server's stable `code`.
 *
 * ## The refresh
 *
 * Access tokens last 15 minutes, so a normal working session will meet an
 * expiry mid-request. On a 401 the client refreshes once and replays the
 * original request. Concurrent 401s share a single in-flight refresh — a
 * dashboard firing six queries at once must not send six refreshes, because the
 * server rotates the refresh token on every use and treats a second use of a
 * rotated token as theft, which would revoke the whole session.
 */

export type QueryValue = string | number | boolean | null | undefined
export type QueryParams = Record<string, QueryValue | QueryValue[]>

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  query?: QueryParams
  body?: unknown
  signal?: AbortSignal
  headers?: Record<string, string>
  /** Skips the refresh-and-replay dance; used by the auth endpoints themselves. */
  skipAuthRefresh?: boolean
  /** Required by the server on unsafe, retryable writes (§45). */
  idempotencyKey?: string
}

/** Called when a refresh fails: the session is unrecoverable and must end. */
type SessionExpiredHandler = () => void

let onSessionExpired: SessionExpiredHandler = () => undefined

export function setSessionExpiredHandler(handler: SessionExpiredHandler): void {
  onSessionExpired = handler
}

function buildUrl(path: string, query?: QueryParams): string {
  const url = `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`
  if (!query) return url

  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null && item !== '') search.append(key, String(item))
      }
    } else {
      search.set(key, String(value))
    }
  }

  const qs = search.toString()
  return qs ? `${url}?${qs}` : url
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.headers.get('content-length') === '0') return null
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) return await response.text()
  try {
    return (await response.json()) as unknown
  } catch {
    return null
  }
}

function toApiError(status: number, body: unknown): ApiError {
  const envelope = body as Partial<ErrorBody> | null

  if (envelope && typeof envelope.code === 'string') {
    return new ApiError({
      status,
      code: envelope.code,
      message: envelope.message ?? 'Request failed',
      requestId: envelope.requestId,
      details: envelope.details,
    })
  }

  // A gateway, a proxy or a crash — anything that did not come from the API's
  // own error handler. Map it to something the UI can still branch on.
  const code =
    status === 401
      ? API_ERROR_CODES.UNAUTHENTICATED
      : status === 403
        ? API_ERROR_CODES.FORBIDDEN
        : status === 404
          ? API_ERROR_CODES.NOT_FOUND
          : status === 429
            ? API_ERROR_CODES.RATE_LIMITED
            : status >= 500
              ? API_ERROR_CODES.SERVICE_UNAVAILABLE
              : API_ERROR_CODES.INTERNAL_ERROR

  return new ApiError({ status, code, message: `Request failed with status ${status}` })
}

// ── Refresh coordination ────────────────────────────────────────────────────

let refreshInFlight: Promise<string | null> | null = null

async function performRefresh(): Promise<string | null> {
  const response = await fetch(buildUrl('/auth/refresh'), {
    method: 'POST',
    // The refresh token is the cookie; the body is empty but must be valid JSON
    // for the server's schema.
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })

  if (!response.ok) return null

  const body = (await readBody(response)) as SuccessBody<{ accessToken: string }> | null
  const token = body?.data?.accessToken
  return typeof token === 'string' ? token : null
}

/** One refresh at a time, shared by every caller that arrives while it runs. */
function refreshAccessToken(): Promise<string | null> {
  refreshInFlight ??= performRefresh()
    .catch(() => null)
    .finally(() => {
      refreshInFlight = null
    })
  return refreshInFlight
}

// ── The request ─────────────────────────────────────────────────────────────

async function send(
  path: string,
  options: RequestOptions,
  token: string | null,
): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json', ...options.headers }
  if (token) headers.authorization = `Bearer ${token}`
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey

  const hasBody = options.body !== undefined
  if (hasBody) headers['content-type'] ??= 'application/json'

  try {
    return await fetch(buildUrl(path, options.query), {
      method: options.method ?? 'GET',
      // Sends the refresh cookie on auth routes and satisfies the server's
      // credentialed CORS allowlist for `ADMIN_ORIGIN`.
      credentials: 'include',
      headers,
      ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiError({
      status: 0,
      code: API_ERROR_CODES.NETWORK_ERROR,
      message: 'Could not reach the server.',
    })
  }
}

/** Issues a request and returns the unwrapped `data`, with the raw envelope. */
async function requestEnvelope<T>(
  path: string,
  options: RequestOptions = {},
): Promise<SuccessBody<T>> {
  let response = await send(path, options, tokenStore.get())

  if (response.status === 401 && !options.skipAuthRefresh) {
    const refreshed = await refreshAccessToken()
    if (refreshed) {
      tokenStore.set(refreshed)
      response = await send(path, options, refreshed)
    } else {
      tokenStore.clear()
      onSessionExpired()
    }
  }

  const body = await readBody(response)
  if (!response.ok) throw toApiError(response.status, body)

  // 204 and other empty successes: there is no envelope to unwrap.
  if (body === null) return { success: true, data: undefined as T }
  return body as SuccessBody<T>
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const envelope = await requestEnvelope<T>(path, options)
  return envelope.data
}

/**
 * A list endpoint. Rows come back in `data`, counts in `meta.pagination` — the
 * shape `paginated()` produces on the server. The admin never derives page
 * counts from a row count of its own.
 */
export async function requestPaginated<T>(
  path: string,
  options: RequestOptions = {},
): Promise<Paginated<T>> {
  const envelope = await requestEnvelope<T[]>(path, options)
  const { pagination: paginationMeta, ...extra } = envelope.meta ?? {}
  const pagination = paginationMeta as PaginationMeta | undefined

  return {
    items: envelope.data ?? [],
    ...(Object.keys(extra).length > 0 ? { meta: extra } : {}),
    pagination: pagination ?? {
      page: 1,
      limit: envelope.data?.length ?? 0,
      total: envelope.data?.length ?? 0,
      totalPages: 1,
      hasNext: false,
      hasPrev: false,
    },
  }
}

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'GET' }),

  list: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    requestPaginated<T>(path, { ...options, method: 'GET' }),

  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'POST', body }),

  put: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'PUT', body }),

  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'PATCH', body }),

  // A body on DELETE is unusual but legal, and it is what the customer tag
  // endpoint takes: removing three tags is one request describing what to
  // remove, not three requests or a list smuggled through the query string.
  delete: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'DELETE', ...(body === undefined ? {} : { body }) }),
}

/**
 * Fetches a file rather than an envelope.
 *
 * The CSV export is behind the same bearer token as everything else, so it
 * cannot be an `<a href>` — the browser would send the request without the
 * header and get a 401. The blob is returned for the caller to save.
 */
export async function download(
  path: string,
  options: Omit<RequestOptions, 'method' | 'body'> = {},
): Promise<Blob> {
  let response = await send(path, { ...options, method: 'GET' }, tokenStore.get())

  if (response.status === 401 && !options.skipAuthRefresh) {
    const refreshed = await refreshAccessToken()
    if (refreshed) {
      tokenStore.set(refreshed)
      response = await send(path, { ...options, method: 'GET' }, refreshed)
    } else {
      tokenStore.clear()
      onSessionExpired()
    }
  }

  if (!response.ok) throw toApiError(response.status, await readBody(response))
  return await response.blob()
}
