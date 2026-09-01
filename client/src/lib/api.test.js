import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, messageOf } from './api'
import { apiMock, jsonResponse } from '@/test/apiMock'

/**
 * The one place the storefront talks to the API.
 *
 * Four properties this suite holds down, each of which breaks something
 * specific if it slips:
 *
 *   • **Cookies are always sent.** They carry the guest cart token. Without
 *     them every request is a new shopper with an empty basket, and nothing
 *     visibly fails until somebody tries to check out.
 *   • **The envelope is unwrapped once.** Callers must never see `data.data`.
 *   • **Empty filters are dropped.** `?q=` is not a search for the empty
 *     string, and must not reach the server as one.
 *   • **A failure carries the server's code.** Screens branch on `code`,
 *     which is stable, and display `message`, which is not.
 */

let mock

beforeEach(() => {
  mock = apiMock().install()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the request', () => {
  it('sends cookies, because the basket is one', async () => {
    mock.on('GET', '/storefront/settings', { storeName: 'Copperleaf' })

    await api.get('/storefront/settings')

    expect(mock.calls[0].credentials).toBe('include')
  })

  it('unwraps the envelope so nobody writes data.data', async () => {
    mock.on('GET', '/storefront/settings', { storeName: 'Copperleaf', currency: 'GBP' })

    const settings = await api.get('/storefront/settings')

    expect(settings).toEqual({ storeName: 'Copperleaf', currency: 'GBP' })
  })

  it('returns the page and the server’s own pagination', async () => {
    mock.onList('/storefront/products', [{ id: 'p1' }], { total: 31, totalPages: 3, hasNext: true })

    const page = await api.list('/storefront/products')

    expect(page.items).toHaveLength(1)
    // Counted over the whole result set on the server, not inferred from the
    // length of this page.
    expect(page.pagination).toMatchObject({ total: 31, totalPages: 3, hasNext: true })
  })

  it('keeps any other meta the server sent alongside the pagination', async () => {
    mock.on('GET', '/storefront/products', () =>
      jsonResponse(200, {
        success: true,
        data: [],
        meta: { pagination: { page: 1 }, canonicalHandle: 'classic-burger' },
      }),
    )

    const page = await api.list('/storefront/products')

    expect(page.meta).toEqual({ canonicalHandle: 'classic-burger' })
  })
})

describe('the query string', () => {
  it('drops values that are not filters', async () => {
    mock.onList('/storefront/products', [])

    await api.list('/storefront/products', {
      query: { page: 1, q: '', category: undefined, collection: null, limit: 12 },
    })

    const url = mock.callsTo('GET', '/storefront/products')[0].url
    expect(url).toContain('page=1')
    expect(url).toContain('limit=12')
    // An empty search is not a search for nothing.
    expect(url).not.toContain('q=')
    expect(url).not.toContain('category')
    expect(url).not.toContain('collection')
  })

  it('encodes a value rather than pasting it in', async () => {
    mock.onList('/storefront/products', [])

    await api.list('/storefront/products', { query: { q: 'salt & pepper' } })

    expect(mock.callsTo('GET', '/storefront/products')[0].url).toContain('q=salt+%26+pepper')
  })

  it('omits the question mark entirely when nothing survives', async () => {
    mock.onList('/storefront/products', [])

    await api.list('/storefront/products', { query: { q: '' } })

    expect(mock.callsTo('GET', '/storefront/products')[0].url).not.toContain('?')
  })
})

describe('a failure', () => {
  it('carries the server’s stable code, not just its prose', async () => {
    mock.onError('GET', '/storefront/products/gone', 404, 'NOT_FOUND', 'Product not found')

    await expect(api.get('/storefront/products/gone')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      message: 'Product not found',
    })
  })

  it('knows whose fault it was', async () => {
    mock.onError('GET', '/storefront/a', 422, 'VALIDATION_FAILED', 'Bad request')
    mock.onError('GET', '/storefront/b', 500, 'INTERNAL_ERROR', 'Boom')

    const client = await api.get('/storefront/a').catch((error) => error)
    const server = await api.get('/storefront/b').catch((error) => error)

    expect(client.isClientFault).toBe(true)
    expect(server.isClientFault).toBe(false)
  })

  it('still throws something usable when the body is not JSON', async () => {
    mock.on('GET', '/storefront/html', () => new Response('<html>502</html>', { status: 502 }))

    const error = await api.get('/storefront/html').catch((thrown) => thrown)

    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(502)
    expect(error.code).toBe('INTERNAL_ERROR')
  })

  it('says something a shopper can act on when the network is gone', () => {
    expect(messageOf(new TypeError('Failed to fetch'))).toMatch(/could not reach the shop/i)
    expect(messageOf(new ApiError(422, 'X', 'That code has expired'))).toBe('That code has expired')
    expect(messageOf({})).toMatch(/something went wrong/i)
  })
})

describe('a write', () => {
  it('passes the idempotency key the server requires', async () => {
    // A double-submitted checkout must place one order, not two.
    mock.on('POST', '/storefront/checkout', () => jsonResponse(201, { success: true, data: { id: 'o1' } }))

    await api.post('/storefront/checkout', { email: 'a@b.test' }, { idempotencyKey: 'key-1' })

    expect(mock.fetch.mock.calls[0][1].headers['idempotency-key']).toBe('key-1')
  })

  it('handles a 204 without trying to parse a body', async () => {
    mock.on('DELETE', '/storefront/cart/items/1', () => new Response(null, { status: 204 }))

    await expect(api.delete('/storefront/cart/items/1')).resolves.toBeNull()
  })
})
