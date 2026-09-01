import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, setSessionExpiredHandler } from './client'
import { ApiError } from './errors'
import { tokenStore } from './tokenStore'
import { jsonResponse, urlOf } from '@/test/http'

/**
 * The HTTP client's contract with the server.
 *
 * These are the behaviours the whole application depends on and that nothing
 * else re-implements: unwrapping the envelope, turning a failure into an
 * `ApiError` carrying the server's `code`, and the refresh-once-and-replay
 * dance around an expired access token.
 */

describe('api client', () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    tokenStore.clear()
    setSessionExpiredHandler(() => undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    tokenStore.clear()
  })

  it('unwraps the success envelope and returns only data', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, data: { id: 'abc' } }))

    await expect(api.get<{ id: string }>('/admin/orders/abc')).resolves.toEqual({ id: 'abc' })
  })

  it('attaches the bearer token and always sends credentials', async () => {
    tokenStore.set('access-token-1')
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, data: null }))

    await api.get('/admin/orders')

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer access-token-1')
    expect(init.credentials).toBe('include')
  })

  it('carries the pagination meta through, rather than deriving it', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        data: [{ id: '1' }, { id: '2' }],
        meta: {
          pagination: {
            page: 2,
            limit: 2,
            total: 7,
            totalPages: 4,
            hasNext: true,
            hasPrev: true,
          },
        },
      }),
    )

    const result = await api.list<{ id: string }>('/admin/orders')

    expect(result.items).toHaveLength(2)
    // Four pages from seven rows is the server's arithmetic, not ours.
    expect(result.pagination.totalPages).toBe(4)
    expect(result.pagination.hasNext).toBe(true)
  })

  it("preserves the server's error code, message and request id", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, {
        success: false,
        code: 'INSUFFICIENT_PERMISSIONS',
        message: 'You need analytics:read',
        requestId: 'req-42',
      }),
    )

    await expect(api.get('/admin/analytics/dashboard')).rejects.toMatchObject({
      code: 'INSUFFICIENT_PERMISSIONS',
      status: 403,
      message: 'You need analytics:read',
      requestId: 'req-42',
    })
  })

  it('refreshes once on a 401 and replays the original request', async () => {
    tokenStore.set('expired-token')

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(401, { success: false, code: 'TOKEN_EXPIRED', message: 'expired' }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { success: true, data: { accessToken: 'fresh-token' } }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { success: true, data: { ok: true } }))

    await expect(api.get<{ ok: boolean }>('/admin/orders')).resolves.toEqual({ ok: true })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(urlOf(fetchMock.mock.calls[1]![0])).toContain('/auth/refresh')
    expect(tokenStore.get()).toBe('fresh-token')

    // The replay must carry the new token, not the one that just failed.
    const [, replayInit] = fetchMock.mock.calls[2] as [string, RequestInit]
    expect((replayInit.headers as Record<string, string>).authorization).toBe('Bearer fresh-token')
  })

  it('shares one refresh between concurrent 401s', async () => {
    tokenStore.set('expired-token')

    fetchMock.mockImplementation((input) => {
      const url = urlOf(input)
      if (url.includes('/auth/refresh')) {
        return Promise.resolve(jsonResponse(200, { success: true, data: { accessToken: 'fresh' } }))
      }
      // Anything still presenting the expired token gets a 401.
      return Promise.resolve(
        tokenStore.get() === 'fresh'
          ? jsonResponse(200, { success: true, data: { ok: true } })
          : jsonResponse(401, { success: false, code: 'TOKEN_EXPIRED', message: 'expired' }),
      )
    })

    await Promise.all([
      api.get('/admin/orders'),
      api.get('/admin/customers'),
      api.get('/admin/products'),
    ])

    const refreshCalls = fetchMock.mock.calls.filter((call) =>
      urlOf(call[0]).includes('/auth/refresh'),
    )
    // More than one would rotate the refresh token underneath itself and trip
    // the server's reuse detection, revoking the whole session.
    expect(refreshCalls).toHaveLength(1)
  })

  it('ends the session when the refresh itself fails', async () => {
    tokenStore.set('expired-token')
    const onExpired = vi.fn()
    setSessionExpiredHandler(onExpired)

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(401, { success: false, code: 'TOKEN_EXPIRED', message: 'expired' }),
      )
      .mockResolvedValueOnce(
        jsonResponse(401, { success: false, code: 'REFRESH_TOKEN_INVALID', message: 'gone' }),
      )

    await expect(api.get('/admin/orders')).rejects.toBeInstanceOf(ApiError)
    expect(onExpired).toHaveBeenCalledOnce()
    expect(tokenStore.get()).toBeNull()
  })

  it('does not try to refresh on the login endpoint', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { success: false, code: 'INVALID_CREDENTIALS', message: 'no' }),
    )

    await expect(
      api.post('/auth/login', { email: 'a@b.c', password: 'x' }, { skipAuthRefresh: true }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('turns a transport failure into a NETWORK_ERROR rather than a raw TypeError', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    await expect(api.get('/admin/orders')).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      status: 0,
    })
  })

  it('drops empty query parameters instead of sending blanks', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, data: [] }))

    await api.get('/admin/orders', { query: { status: '', page: 2, search: undefined } })

    const url = urlOf(fetchMock.mock.calls[0]![0])
    expect(url).toContain('page=2')
    expect(url).not.toContain('status=')
    expect(url).not.toContain('search=')
  })

  it('treats a 204 as a success with no body', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))

    await expect(api.post('/admin/notifications/abc/read')).resolves.toBeUndefined()
  })
})
