import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiMock } from '@/test/apiMock'
import { EVENTS, resetAnalyticsSession, track } from './analytics'

/**
 * The beacon.
 *
 * Two properties matter more than anything it records:
 *
 *   **It cannot break a page.** Every failure is swallowed. A shopper whose ad
 *   blocker eats this request, or who is offline, still gets to buy something.
 *
 *   **It carries nothing about a person.** Handles, ids and counts. The server
 *   takes the user id from the session token and ignores anything the body says
 *   about who this is, so sending it would be a privacy problem with no upside.
 */

let mock

beforeEach(() => {
  mock = apiMock().install()
  window.localStorage.clear()
  resetAnalyticsSession()
})

afterEach(() => {
  vi.restoreAllMocks()
})

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('track', () => {
  it('sends the event the server’s vocabulary knows', async () => {
    mock.on('POST', '/storefront/analytics/events', { recorded: true })

    track(EVENTS.PRODUCT_VIEWED, { handle: 'velvet-matte' })
    await flush()

    const [call] = mock.callsTo('POST', '/storefront/analytics/events')
    expect(call.body.name).toBe('product_viewed')
    expect(call.body.properties).toEqual({ handle: 'velvet-matte' })
  })

  it('never throws, whatever the server says', async () => {
    // The whole point. A page that awaited this and let it reject would take
    // the checkout down with the analytics.
    mock.onError('POST', '/storefront/analytics/events', 500, 'INTERNAL_ERROR', 'boom')

    expect(() => track(EVENTS.CART_VIEWED)).not.toThrow()
    await flush()
  })

  it('survives storage being unavailable', async () => {
    // Private browsing, storage disabled, a full quota. The visit is still
    // worth counting; it just cannot be joined to the last one.
    mock.on('POST', '/storefront/analytics/events', { recorded: true })
    // On the prototype: jsdom's `localStorage` is a `Storage` instance whose
    // methods live there, and spying on the instance does not intercept them.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })

    track(EVENTS.CART_VIEWED)
    await flush()

    const [call] = mock.callsTo('POST', '/storefront/analytics/events')
    expect(call.body.anonymousId).toBeUndefined()
    expect(call.body.sessionId).toBeTruthy()
  })

  it('keeps the same anonymous id across events, so return visits join up', async () => {
    mock.on('POST', '/storefront/analytics/events', { recorded: true })

    track(EVENTS.PAGE_VIEWED)
    track(EVENTS.CART_VIEWED)
    await flush()

    const calls = mock.callsTo('POST', '/storefront/analytics/events')
    expect(calls[0].body.anonymousId).toBe(calls[1].body.anonymousId)
    expect(calls[0].body.sessionId).toBe(calls[1].body.sessionId)
  })

  it('starts a new visit when the session is reset', async () => {
    mock.on('POST', '/storefront/analytics/events', { recorded: true })

    track(EVENTS.PAGE_VIEWED)
    await flush()
    resetAnalyticsSession()
    track(EVENTS.PAGE_VIEWED)
    await flush()

    const calls = mock.callsTo('POST', '/storefront/analytics/events')
    expect(calls[0].body.sessionId).not.toBe(calls[1].body.sessionId)
    // The person is the same person, though.
    expect(calls[0].body.anonymousId).toBe(calls[1].body.anonymousId)
  })

  it('drops empty properties rather than claiming they are null', async () => {
    mock.on('POST', '/storefront/analytics/events', { recorded: true })

    track(EVENTS.PRODUCT_VIEWED, { handle: 'balm', category: undefined, price: null })
    await flush()

    const [call] = mock.callsTo('POST', '/storefront/analytics/events')
    expect(call.body.properties).toEqual({ handle: 'balm' })
  })
})
