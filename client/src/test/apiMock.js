import { vi } from 'vitest'

/**
 * A stand-in for the API, declared route by route.
 *
 * Tests state the endpoints they expect and what those return; anything the
 * component asks for that was not declared fails loudly with a 501 naming the
 * request, rather than resolving to `undefined` and surfacing three assertions
 * later as an unrelated render error.
 *
 * Every call is recorded, so a test can assert not just *that* a request
 * happened but exactly what it carried — which is how "the filter is sent to
 * the server" is actually verified rather than assumed.
 */
export class ApiMock {
  constructor() {
    this.calls = []
    this.routes = []
    this.fetch = vi.fn(async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url
      const method = (init.method ?? 'GET').toUpperCase()
      // Bodies are parsed here, once, so a test asserts on the object it meant
      // to send rather than re-parsing a string at every call site.
      let body
      if (typeof init.body === 'string') {
        try {
          body = JSON.parse(init.body)
        } catch {
          body = init.body
        }
      }
      this.calls.push({
        method,
        url,
        body,
        credentials: init.credentials,
        headers: init.headers ?? {},
      })

      const route = this.routes.find(
        (candidate) => candidate.method === method && url.includes(candidate.pattern),
      )
      if (!route) {
        return jsonResponse(501, {
          success: false,
          code: 'INTERNAL_ERROR',
          message: `No mock route for ${method} ${url}`,
        })
      }
      return route.respond({ method, url })
    })
  }

  /** A single payload, wrapped in the success envelope. */
  on(method, pattern, data) {
    this.routes.push({
      method: method.toUpperCase(),
      pattern,
      respond: typeof data === 'function' ? data : () => jsonResponse(200, { success: true, data }),
    })
    return this
  }

  /** A page, with `meta.pagination` where the client reads it. */
  onList(pattern, items, pagination = {}) {
    return this.on('GET', pattern, () =>
      jsonResponse(200, {
        success: true,
        data: items,
        meta: {
          pagination: {
            page: 1,
            limit: 12,
            total: items.length,
            totalPages: 1,
            hasNext: false,
            hasPrev: false,
            ...pagination,
          },
        },
      }),
    )
  }

  onError(method, pattern, status, code, message) {
    return this.on(method, pattern, () =>
      jsonResponse(status, { success: false, code, message }),
    )
  }

  install() {
    vi.stubGlobal('fetch', this.fetch)
    return this
  }

  callsTo(method, pattern) {
    return this.calls.filter(
      (call) => call.method === method.toUpperCase() && call.url.includes(pattern),
    )
  }
}

export function jsonResponse(status, body) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export function apiMock() {
  return new ApiMock()
}
