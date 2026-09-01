import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { tokenStore } from '@/lib/api/tokenStore'
import { apiMock, type ApiMock } from '@/test/api-mock'
import { jsonResponse } from '@/test/http'
import { renderAuthed } from '@/test/renderAuthed'
import {
  adminUser,
  attemptSummary,
  cartDetail,
  cartSummary,
  checkoutAttempt,
} from '@/test/catalogue'
import { CartDetailPage } from './pages/CartDetailPage'
import { CartListPage } from './pages/CartListPage'
import { CheckoutAttemptsPage } from './pages/CheckoutAttemptsPage'
import { failureLabel, failureTone, idleFor, successRate } from './components/failureLabels'

/**
 * Sales that did not complete.
 *
 * What these tests defend:
 *
 *   • **A basket is worth what it costs now.** The value comes from the server
 *     and is never recomputed here, because a cart holds no money.
 *   • **A guest cannot be emailed.** There is no address, and the screen says
 *     so rather than offering a button that fails.
 *   • **An opt-out is not an error.** A recovery the customer has declined
 *     reports as not sent, not as a failure.
 */

let api: ApiMock

function baseRoutes(mock: ApiMock, user = adminUser) {
  return mock
    .withSession(user)
    .on('GET', '/storefront/settings', { currency: 'GBP', storeName: 'Test' })
    .on('GET', '/admin/notifications/unread-count', { count: 0 })
}

beforeEach(() => {
  api = apiMock().install()
  tokenStore.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  tokenStore.clear()
})

// ── The words ───────────────────────────────────────────────────────────────

describe('checkout labels', () => {
  it('reads a failure code as a sentence, and never hides an unknown one', () => {
    expect(failureLabel('INSUFFICIENT_STOCK')).toBe('Ran out of stock')
    // An unmapped code is shown, not swallowed: it is the interesting one.
    expect(failureLabel('SOMETHING_NEW')).toBe('something new')
    expect(failureLabel(null)).toBe('Refused')
  })

  it('reserves red for the shop being broken, not for the shop working', () => {
    // An expired code is the shop working as designed. A crash is not.
    expect(failureTone('INTERNAL_ERROR')).toBe('danger')
    expect(failureTone('INSUFFICIENT_STOCK')).toBe('warning')
    expect(failureTone('DISCOUNT_INVALID')).toBe('neutral')
  })

  it('says how long a basket has sat still', () => {
    const now = new Date('2026-03-01T12:00:00.000Z').getTime()
    expect(idleFor('2026-03-01T11:30:00.000Z', now)).toBe('30 min')
    expect(idleFor('2026-03-01T02:00:00.000Z', now)).toBe('10 hr')
    expect(idleFor('2026-02-25T12:00:00.000Z', now)).toBe('4 days')
  })

  it('will not call no data a nought per cent', () => {
    expect(successRate(80, 20)).toBe('80%')
    // No attempts is a question with no answer, not a total failure.
    expect(successRate(0, 0)).toBe('—')
  })
})

// ── The basket list ─────────────────────────────────────────────────────────

describe('CartListPage', () => {
  function listRoutes(mock: ApiMock, rows = [cartSummary()], meta?: Record<string, unknown>) {
    return baseRoutes(mock).on('GET', '/admin/carts', () =>
      jsonResponse(200, {
        success: true,
        data: rows,
        meta: {
          pagination: {
            page: 1,
            limit: 20,
            total: rows.length,
            totalPages: 1,
            hasNext: false,
            hasPrev: false,
          },
          abandonedValue: { amount: 125_000, currency: 'GBP' },
          abandonedCount: 34,
          ...meta,
        },
      }),
    )
  }

  it('leads with what the whole pile is worth, from the server', async () => {
    listRoutes(api)
    await renderAuthed(<CartListPage />, { route: '/checkout' })

    // 34 baskets and £1,250 — not the one row on screen.
    expect(await screen.findByText('£1,250.00')).toBeInTheDocument()
    expect(screen.getByText('34')).toBeInTheDocument()
  })

  it('shows a basket at what it is worth now', async () => {
    listRoutes(api)
    await renderAuthed(<CartListPage />, { route: '/checkout' })

    const row = within(await screen.findByRole('row', { name: /Lost Shopper/ }))
    expect(row.getByText('£45.00')).toBeInTheDocument()
    expect(row.getByText('Left')).toBeInTheDocument()
  })

  it('says outright that a guest basket has nobody to email', async () => {
    listRoutes(api, [
      cartSummary({ id: 'cart-2', customerId: null, customerEmail: null, customerName: null }),
    ])
    await renderAuthed(<CartListPage />, { route: '/checkout' })

    expect(await screen.findByText('A guest')).toBeInTheDocument()
    expect(screen.getByText('No account — there is nobody to email')).toBeInTheDocument()
  })

  it('asks for abandoned baskets by default, because that is the question', async () => {
    listRoutes(api)
    await renderAuthed(<CartListPage />, { route: '/checkout' })

    await waitFor(() => {
      expect(api.callsTo('GET', '/admin/carts')[0]!.url).toContain('status=abandoned')
    })
  })

  it('sends the search to the server', async () => {
    const user = userEvent.setup()
    listRoutes(api)
    await renderAuthed(<CartListPage />, { route: '/checkout' })
    await screen.findByText('Lost Shopper')

    await user.type(screen.getByLabelText('Search baskets'), 'lost')

    await waitFor(() => {
      expect(api.callsTo('GET', '/admin/carts').at(-1)!.url).toContain('q=lost')
    })
  })

  it('explains what "left behind" counts, in the empty state', async () => {
    listRoutes(api, [])
    await renderAuthed(<CartListPage />, { route: '/checkout' })

    expect(await screen.findByText('Nothing has been left behind')).toBeInTheDocument()
    expect(screen.getByText(/Empty ones are never listed/)).toBeInTheDocument()
  })
})

// ── One basket ──────────────────────────────────────────────────────────────

describe('CartDetailPage', () => {
  const route = { route: '/checkout/carts/cart-1', path: '/checkout/carts/:id' }

  function detailRoutes(mock: ApiMock, cart = cartDetail(), user = adminUser) {
    return baseRoutes(mock, user).on('GET', '/admin/carts/cart-1', cart)
  }

  it('shows what is in it and what it is worth', async () => {
    detailRoutes(api)
    await renderAuthed(<CartDetailPage />, route)

    expect(await screen.findByText('Classic Burger')).toBeInTheDocument()
    expect(screen.getByText('3 items, before delivery and tax.')).toBeInTheDocument()
  })

  it('names the line that has become unbuyable, which is often the reason', async () => {
    detailRoutes(
      api,
      cartDetail({
        purchasable: false,
        lines: [
          {
            ...cartDetail().lines[0]!,
            purchasable: false,
            problem: 'Only 1 left',
          },
        ],
      }),
    )
    await renderAuthed(<CartDetailPage />, route)

    expect(await screen.findByText('Some of this can no longer be bought')).toBeInTheDocument()
    expect(screen.getByText('Only 1 left')).toBeInTheDocument()
  })

  it('offers no email for a guest, and says why', async () => {
    detailRoutes(api, cartDetail({ customer: null }))
    await renderAuthed(<CartDetailPage />, route)

    expect(await screen.findByText('A guest basket')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Email them/ })).not.toBeInTheDocument()
    expect(screen.getByText(/no address to write to/)).toBeInTheDocument()
  })

  it('offers no email for a basket that already became an order', async () => {
    detailRoutes(api, cartDetail({ status: 'converted', convertedOrderId: 'ord-9' }))
    await renderAuthed(<CartDetailPage />, route)

    expect(await screen.findByText('This basket was bought')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open the order it became' })).toHaveAttribute(
      'href',
      '/orders/ord-9',
    )
    expect(screen.queryByRole('button', { name: /Email them/ })).not.toBeInTheDocument()
  })

  it('queues a recovery email and says who it went to', async () => {
    const user = userEvent.setup()
    detailRoutes(api).on('POST', '/admin/carts/cart-1/recover', {
      sent: true,
      to: 'lost@example.test',
    })
    await renderAuthed(<CartDetailPage />, route)

    await user.click(await screen.findByRole('button', { name: /Email them a link back/ }))

    await waitFor(() => {
      expect(api.callsTo('POST', '/admin/carts/cart-1/recover')).toHaveLength(1)
    })
    expect(await screen.findByText('To lost@example.test')).toBeInTheDocument()
    // And offers to send again, rather than looking like it failed.
    expect(await screen.findByRole('button', { name: /Send again/ })).toBeInTheDocument()
  })

  it('reports an opt-out as not sent rather than as a failure', async () => {
    const user = userEvent.setup()
    detailRoutes(api).on('POST', '/admin/carts/cart-1/recover', {
      sent: false,
      to: 'lost@example.test',
      reason: 'The customer has opted out of marketing email.',
    })
    await renderAuthed(<CartDetailPage />, route)

    await user.click(await screen.findByRole('button', { name: /Email them a link back/ }))

    expect(await screen.findByText('Not sent')).toBeInTheDocument()
    expect(screen.getByText(/opted out of marketing email/)).toBeInTheDocument()
  })

  it('hides the email from an operator who may not contact customers', async () => {
    const readOnly = {
      ...adminUser,
      permissions: adminUser.permissions.filter((p) => p !== 'customers:write'),
    }
    detailRoutes(api, cartDetail(), readOnly)
    await renderAuthed(<CartDetailPage />, route)

    await screen.findByText('Classic Burger')
    expect(screen.queryByRole('button', { name: /Email them/ })).not.toBeInTheDocument()
  })
})

// ── Checkout attempts ───────────────────────────────────────────────────────

describe('CheckoutAttemptsPage', () => {
  function attemptRoutes(mock: ApiMock, rows = [checkoutAttempt()], summary = attemptSummary()) {
    return baseRoutes(mock)
      .on('GET', '/admin/checkout-attempts/summary', summary)
      .onList('/admin/checkout-attempts', rows)
  }

  it('leads with the rate, computed by the server', async () => {
    attemptRoutes(api)
    await renderAuthed(<CheckoutAttemptsPage />, { route: '/checkout/attempts' })

    expect(await screen.findByText('80%')).toBeInTheDocument()
    expect(screen.getByText('80')).toBeInTheDocument()
    expect(screen.getByText('20')).toBeInTheDocument()
  })

  it('ranks the reasons in words rather than error codes', async () => {
    attemptRoutes(api)
    await renderAuthed(<CheckoutAttemptsPage />, { route: '/checkout/attempts' })

    expect(await screen.findByText('Ran out of stock')).toBeInTheDocument()
    expect(screen.getByText('The discount code was refused')).toBeInTheDocument()
  })

  it('filters to one reason when it is clicked', async () => {
    const user = userEvent.setup()
    attemptRoutes(api)
    await renderAuthed(<CheckoutAttemptsPage />, { route: '/checkout/attempts' })

    await user.click(await screen.findByRole('button', { name: 'Ran out of stock' }))

    await waitFor(() => {
      const last = api.callsTo('GET', '/admin/checkout-attempts').at(-1)!
      expect(last.url).toContain('failureCode=INSUFFICIENT_STOCK')
      expect(last.url).toContain('outcome=failed')
    })
  })

  it('links a successful attempt to the order it became', async () => {
    attemptRoutes(api)
    await renderAuthed(<CheckoutAttemptsPage />, { route: '/checkout/attempts' })

    expect(await screen.findByRole('link', { name: 'Bought' })).toHaveAttribute(
      'href',
      '/orders/ord-1',
    )
  })

  it('shows a refusal with the reason the shopper was given', async () => {
    attemptRoutes(api, [
      checkoutAttempt({
        id: 'att-2',
        outcome: 'failed',
        orderId: null,
        failureCode: 'INSUFFICIENT_STOCK',
        failureMessage: 'Some items are no longer available — Classic Burger: only 1 left',
      }),
    ])
    await renderAuthed(<CheckoutAttemptsPage />, { route: '/checkout/attempts' })

    // Scoped to the row: the reasons chart above lists the same words, which
    // is the point of the chart.
    const row = within(await screen.findByRole('row', { name: /only 1 left/ }))
    expect(row.getByText('Ran out of stock')).toBeInTheDocument()
  })

  it('says nothing has been tried rather than showing an empty table', async () => {
    attemptRoutes(api, [], attemptSummary({ placed: 0, failed: 0, reasons: [] }))
    await renderAuthed(<CheckoutAttemptsPage />, { route: '/checkout/attempts' })

    expect(await screen.findByText('No checkouts yet')).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
  })
})
