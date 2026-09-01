/**
 * The one place the storefront talks to the API.
 *
 * No component calls `fetch`. Everything goes through here so that four things
 * are true everywhere without anybody having to remember them:
 *
 *   • the `{ success, data, meta }` envelope is unwrapped, so callers get the
 *     payload and never `response.data.data`;
 *   • cookies are sent, which is how a guest keeps the same basket across
 *     requests — the cart is identified by an httpOnly token the server sets,
 *     never by an id the client holds;
 *   • a failure is an `ApiError` carrying the server's stable `code`, so a
 *     screen can react to `INSUFFICIENT_STOCK` without matching on prose;
 *   • query strings are built once, dropping empty values, so `?q=` never
 *     reaches the server as a filter that filters nothing.
 *
 * The base URL is a path, not an origin. Vite proxies `/api` to the API in
 * development and a reverse proxy does the same in production — which keeps
 * the storefront same-origin, and that is what makes the cart cookie work at
 * all. A cookie set by `localhost:4000` is not sent to `localhost:5173`.
 */

export const API_BASE = '/api/v1'

/**
 * The access token, held in memory only.
 *
 * Never in `localStorage`: a token sitting in storage is readable by any script
 * that gets onto the page, and it outlives the tab. This one dies with the
 * page, and the refresh token — an httpOnly cookie the browser cannot read at
 * all — is what survives a reload.
 */
let accessToken = null
let onSessionEnded = () => {}

/**
 * The one refresh in flight, if any.
 *
 * Declared here rather than beside `refreshAccessToken` because `tokens.clear`
 * has to be able to abandon it — see the note there.
 */
let refreshing = null

export const tokens = {
  get: () => accessToken,
  set: (token) => {
    accessToken = token
  },
  /**
   * Forgets the session.
   *
   * Also abandons any refresh already in flight. Signing out while one is
   * pending must not leave a promise that later resolves into a token for the
   * session just ended — and, less obviously, a refresh that never settles
   * would otherwise wedge every future one behind it for the life of the page.
   */
  clear: () => {
    accessToken = null
    refreshing = null
  },
  /** Called when a refresh fails: the session is unrecoverable. */
  onSessionEnded: (handler) => {
    onSessionEnded = handler
  },
}

/**
 * A failed request, with the server's own vocabulary attached.
 *
 * `code` is the contract. It is stable across releases and across languages,
 * which `message` is not — so screens branch on the code and *show* the
 * message.
 */
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }

  /** True when the shopper can fix it: a bad code, an out-of-stock line. */
  get isClientFault() {
    return this.status >= 400 && this.status < 500
  }
}

export const ERROR_CODES = {
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  DOMAIN_RULE_VIOLATION: 'DOMAIN_RULE_VIOLATION',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
}

/** The sentence to show a person, whatever went wrong. */
export function messageOf(error) {
  if (error instanceof ApiError && error.message) return error.message
  if (error instanceof Error && error.message === 'Failed to fetch') {
    return 'We could not reach the shop. Check your connection and try again.'
  }
  return 'Something went wrong. Please try again.'
}

function buildUrl(path, query) {
  const url = `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`
  if (!query) return url

  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    // `undefined`, `null` and `''` are all "not filtering by this", and none
    // of them should reach the server as an empty parameter.
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

async function readBody(response) {
  if (response.status === 204) return null
  const type = response.headers.get('content-type') ?? ''
  if (!type.includes('application/json')) return null
  try {
    return await response.json()
  } catch {
    return null
  }
}

function request(path, options, token) {
  const { method = 'GET', query, body, signal, idempotencyKey } = options

  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  // Required by the server on unsafe, retryable writes: a double-submitted
  // checkout must place one order, not two.
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey
  if (token) headers.authorization = `Bearer ${token}`

  return fetch(buildUrl(path, query), {
    method,
    headers,
    // The guest cart token is an httpOnly cookie, and so is the refresh token.
    // Without this the shopper gets a brand-new empty basket on every single
    // request and can never stay signed in.
    credentials: 'include',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  })
}

/**
 * One refresh at a time.
 *
 * A page that fires six requests on load can meet six 401s at once. The server
 * rotates the refresh token on every use and treats a second use of a rotated
 * one as theft — which would revoke the whole session. So concurrent callers
 * share a single in-flight refresh rather than each starting their own.
 */
/**
 * Exchanges the refresh cookie for a new access token, or null.
 *
 * Exported because the auth provider needs exactly this on mount and must not
 * write its own: the refresh token **rotates on every use**, and the server
 * treats a second use of a rotated one as theft and revokes the whole session.
 * Two callers each doing their own POST is therefore not a wasted request — it
 * is a signed-out customer. Everything goes through this one in-flight promise.
 */
export async function refreshAccessToken() {
  refreshing ??= (async () => {
    try {
      const response = await request('/auth/refresh', { method: 'POST', body: {} }, null)
      if (!response.ok) return null
      const envelope = await readBody(response)
      return envelope?.data?.accessToken ?? null
    } catch {
      return null
    } finally {
      // Cleared on the next tick so everyone awaiting this attempt sees the
      // same answer before a new one can start.
      queueMicrotask(() => {
        refreshing = null
      })
    }
  })()
  return refreshing
}

async function send(path, options = {}) {
  let response = await request(path, options, accessToken)

  // A 401 on an authenticated call means the fifteen-minute access token has
  // expired mid-session. Refresh once and replay; if that fails the session is
  // genuinely over.
  if (response.status === 401 && !options.skipAuthRefresh) {
    const renewed = await refreshAccessToken()
    if (renewed) {
      accessToken = renewed
      response = await request(path, options, renewed)
    } else if (accessToken) {
      accessToken = null
      onSessionEnded()
    }
  }

  const envelope = await readBody(response)

  if (!response.ok) {
    throw new ApiError(
      response.status,
      envelope?.code ?? ERROR_CODES.INTERNAL_ERROR,
      envelope?.message ?? 'Something went wrong.',
      envelope?.details,
    )
  }

  return envelope
}

export const api = {
  /** The payload alone, for the endpoints that return one thing. */
  async get(path, options) {
    const envelope = await send(path, { ...options, method: 'GET' })
    return envelope?.data ?? null
  },

  /**
   * A page, with its pagination and whatever else `meta` carried.
   *
   * The pager is the server's answer — total pages and whether there is a
   * next one are counted there, over the whole result set, not inferred here
   * from the length of one page.
   */
  async list(path, options) {
    const envelope = await send(path, { ...options, method: 'GET' })
    const { pagination, ...extra } = envelope?.meta ?? {}
    return { items: envelope?.data ?? [], pagination: pagination ?? null, meta: extra }
  },

  async post(path, body, options) {
    const envelope = await send(path, { ...options, method: 'POST', body })
    return envelope?.data ?? null
  },

  async patch(path, body, options) {
    const envelope = await send(path, { ...options, method: 'PATCH', body })
    return envelope?.data ?? null
  },

  /**
   * A whole-resource replace. Distinct from `patch` because the server treats
   * them differently — notification preferences are set with PUT, and sending
   * a PATCH there is a 404 on a route that does not exist.
   */
  async put(path, body, options) {
    const envelope = await send(path, { ...options, method: 'PUT', body })
    return envelope?.data ?? null
  },

  async delete(path, options) {
    const envelope = await send(path, { ...options, method: 'DELETE' })
    return envelope?.data ?? null
  },
}
