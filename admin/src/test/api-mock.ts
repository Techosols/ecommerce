import { vi } from 'vitest'
import { jsonResponse, urlOf } from './http'
import type { CurrentUser } from '@/features/auth/auth.types'

export interface RecordedCall {
  method: string
  url: string
  body: unknown
  /**
   * The request headers, lower-cased.
   *
   * Recorded because some of what a request carries is not in its body:
   * `idempotency-key` is the whole guarantee that a double-clicked button
   * cannot place two orders, and a test cannot check it any other way.
   */
  headers: Record<string, string>
}

type Responder = (call: RecordedCall) => Response | Promise<Response>

/**
 * A responder, or a plain value to wrap in a `{ success: true, data }` envelope.
 *
 * `object` rather than `unknown` so the union stays meaningful — `unknown`
 * would swallow the `Responder` arm and let a typo through as a valid call.
 */
type ResponderOrData = Responder | object | null

interface Route {
  method: string
  pattern: string | RegExp
  responder: Responder
  once: boolean
  used: boolean
}

/**
 * A stand-in for the API, declared route by route.
 *
 * Tests state the endpoints they expect and what those return; anything the
 * component asks for that was not declared fails loudly with a 501 naming the
 * request, rather than resolving to `undefined` and surfacing three assertions
 * later as an unrelated render error.
 *
 * Every call is recorded, so a test can assert not just *that* a request
 * happened but exactly what it carried — which is how "only send the fields
 * that changed" is actually verified.
 */
export class ApiMock {
  readonly calls: RecordedCall[] = []
  private readonly routes: Route[] = []
  readonly fetch = vi.fn<typeof fetch>()

  constructor() {
    this.fetch.mockImplementation((input, init) => {
      const url = urlOf(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      let body: unknown
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body) as unknown
        } catch {
          body = init.body
        }
      }

      const headers: Record<string, string> = {}
      if (init?.headers) {
        new Headers(init.headers).forEach((value, key) => {
          headers[key.toLowerCase()] = value
        })
      }

      const call: RecordedCall = { method, url, body, headers }
      this.calls.push(call)

      const route = this.routes.find(
        (candidate) =>
          candidate.method === method &&
          !(candidate.once && candidate.used) &&
          (typeof candidate.pattern === 'string'
            ? url.includes(candidate.pattern)
            : candidate.pattern.test(url)),
      )

      if (!route) {
        return Promise.resolve(
          jsonResponse(501, {
            success: false,
            code: 'INTERNAL_ERROR',
            message: `No mock route for ${method} ${url}`,
          }),
        )
      }

      route.used = true
      return Promise.resolve(route.responder(call))
    })
  }

  on(method: string, pattern: string | RegExp, responder: ResponderOrData): this {
    this.routes.push({
      method: method.toUpperCase(),
      pattern,
      responder:
        typeof responder === 'function'
          ? (responder as Responder)
          : () => jsonResponse(200, { success: true, data: responder }),
      once: false,
      used: false,
    })
    return this
  }

  /** Matches once, then falls through — for "fails, then succeeds on retry". */
  onOnce(method: string, pattern: string | RegExp, responder: ResponderOrData): this {
    this.on(method, pattern, responder)
    this.routes[this.routes.length - 1]!.once = true
    return this
  }

  /** A paginated list response, with `meta.pagination` where the client reads it. */
  onList<T>(pattern: string | RegExp, items: T[], pagination?: Partial<{ page: number; limit: number; total: number; totalPages: number; hasNext: boolean; hasPrev: boolean }>): this {
    return this.on('GET', pattern, () =>
      jsonResponse(200, {
        success: true,
        data: items,
        meta: {
          pagination: {
            page: 1,
            limit: 20,
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

  onError(method: string, pattern: string | RegExp, status: number, code: string, message: string): this {
    return this.on(method, pattern, () =>
      jsonResponse(status, { success: false, code, message }),
    )
  }

  /** The session `AuthProvider` restores on mount. */
  withSession(user: CurrentUser): this {
    this.on('POST', '/auth/refresh', { accessToken: 'test-token' })
    this.on('GET', '/auth/me', user)
    return this
  }

  install(): this {
    vi.stubGlobal('fetch', this.fetch)
    return this
  }

  callsTo(method: string, pattern: string): RecordedCall[] {
    return this.calls.filter(
      (call) => call.method === method.toUpperCase() && call.url.includes(pattern),
    )
  }
}

export function apiMock(): ApiMock {
  return new ApiMock()
}
