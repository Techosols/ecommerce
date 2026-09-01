import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { tokenStore } from '@/lib/api/tokenStore'
import { apiMock, type ApiMock } from '@/test/api-mock'
import { jsonResponse } from '@/test/http'
import { renderAuthed } from '@/test/renderAuthed'
import { adminUser, orderDetail, orderSummary, staffUser } from '@/test/catalogue'
import { OrderDetailPage } from './pages/OrderDetailPage'
import { OrderListPage } from './pages/OrderListPage'

/**
 * Order management, against the server's real contracts.
 *
 * The assertions are mostly about the requests that leave the browser: an order
 * has no editable fields, only named operations, so "the right button sends the
 * right operation" is the whole of what there is to get wrong.
 */

let api: ApiMock

function baseRoutes(mock: ApiMock, user = adminUser) {
  return mock
    .withSession(user)
    .on('GET', '/storefront/settings', { currency: 'GBP', storeName: 'Test' })
    .on('GET', '/admin/notifications/unread-count', { count: 0 })
    .on('GET', '/admin/orders/ord-1/timeline', [])
    .on('GET', '/admin/orders/ord-1/payments', {
      payments: [],
      refunds: [],
      outstanding: { amount: 1598, currency: 'GBP' },
    })
    .on('GET', '/admin/orders/ord-1/shipments', [])
}

beforeEach(() => {
  api = apiMock().install()
  tokenStore.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  tokenStore.clear()
})

// ── Listing ─────────────────────────────────────────────────────────────────

describe('OrderListPage', () => {
  it('shows all three status machines rather than collapsing them into one', async () => {
    baseRoutes(api).onList('/admin/orders', [
      orderSummary({ status: 'confirmed', paymentStatus: 'paid', fulfillmentStatus: 'unfulfilled' }),
    ])

    await renderAuthed(<OrderListPage />, { route: '/orders' })

    expect(await screen.findByText('#1001')).toBeInTheDocument()
    // Paid but unshipped is a real state and has to be readable as one.
    const table = screen.getByRole('table')
    expect(within(table).getByText('Confirmed')).toBeInTheDocument()
    expect(within(table).getByText('Paid')).toBeInTheDocument()
    expect(within(table).getByText('Unfulfilled')).toBeInTheDocument()
  })

  it('shows a refund as a subtraction beneath the total', async () => {
    baseRoutes(api).onList('/admin/orders', [
      orderSummary({
        paymentStatus: 'partially_refunded',
        refundedTotal: { amount: 500, currency: 'GBP' },
      }),
    ])

    await renderAuthed(<OrderListPage />, { route: '/orders' })

    expect(await screen.findByText(/−£5\.00 refunded/)).toBeInTheDocument()
  })

  it('sends every filter to the server rather than narrowing in the browser', async () => {
    const user = userEvent.setup()
    baseRoutes(api).onList('/admin/orders', [orderSummary()])

    await renderAuthed(<OrderListPage />, { route: '/orders' })
    await screen.findByText('#1001')

    await user.selectOptions(screen.getByLabelText('Filter by payment status'), 'paid')
    await waitFor(() => expect(api.callsTo('GET', 'paymentStatus=paid').length).toBeGreaterThan(0))

    await user.selectOptions(screen.getByLabelText('Filter by fulfilment status'), 'unfulfilled')
    await waitFor(() =>
      expect(api.callsTo('GET', 'fulfillmentStatus=unfulfilled').length).toBeGreaterThan(0),
    )
  })

  it('carries a tag filter from the URL into the request, and can drop it', async () => {
    const user = userEvent.setup()
    baseRoutes(api).onList('/admin/orders', [orderSummary({ tags: ['fragile'] })])

    await renderAuthed(<OrderListPage />, { route: '/orders?tags=fragile&tags=chase' })
    await screen.findByText('#1001')

    // Repeated parameters, which is what the server's `tags` filter takes.
    await waitFor(() =>
      expect(api.callsTo('GET', 'tags=fragile&tags=chase').length).toBeGreaterThan(0),
    )

    await user.click(screen.getByRole('button', { name: 'Remove the chase tag filter' }))
    await waitFor(() => {
      const calls = api.callsTo('GET', '/admin/orders')
      expect(calls[calls.length - 1]!.url).not.toContain('chase')
    })
  })

  it('offers no sort control, because the endpoint takes no sort parameter', async () => {
    baseRoutes(api).onList('/admin/orders', [orderSummary()])

    await renderAuthed(<OrderListPage />, { route: '/orders' })
    await screen.findByText('#1001')

    // A header that looked sortable and quietly did nothing would be worse.
    expect(screen.queryByRole('button', { name: /^Total/ })).not.toBeInTheDocument()
  })
})

// ── Detail ──────────────────────────────────────────────────────────────────

describe('OrderDetailPage', () => {
  function detailRoutes(mock: ApiMock, user = adminUser, detail = orderDetail()) {
    return baseRoutes(mock, user).on('GET', '/admin/orders/ord-1', () =>
      jsonResponse(200, { success: true, data: detail }),
    )
  }

  const route = { route: '/orders/ord-1', path: '/orders/:id' }

  it('shows the totals as a derivation, using the server’s figures', async () => {
    detailRoutes(api)
    await renderAuthed(<OrderDetailPage />, route)

    expect(await screen.findByText('#1001')).toBeInTheDocument()
    // Subtotal, the named discount, the named shipping method, then the total.
    expect(screen.getByText('£11.98')).toBeInTheDocument()
    expect(screen.getByText('WELCOME')).toBeInTheDocument()
    expect(screen.getByText('Standard')).toBeInTheDocument()
    expect(screen.getByText('£15.98')).toBeInTheDocument()
  })

  it('shows a net line only once money has actually gone back', async () => {
    detailRoutes(api, adminUser)
    await renderAuthed(<OrderDetailPage />, route)
    await screen.findByText('#1001')
    expect(screen.queryByText('Net')).not.toBeInTheDocument()
  })

  it('confirms through the confirm operation, not a status field edit', async () => {
    const user = userEvent.setup()
    detailRoutes(api).on('POST', '/admin/orders/ord-1/confirm', () =>
      jsonResponse(200, { success: true, data: orderDetail({ status: 'confirmed' }) }),
    )

    await renderAuthed(<OrderDetailPage />, route)
    await user.click(await screen.findByRole('button', { name: 'Confirm order' }))

    await waitFor(() => expect(api.callsTo('POST', '/admin/orders/ord-1/confirm')).toHaveLength(1))
    // Confirming commits reserved stock, so it must not go through the generic
    // transitions endpoint.
    expect(api.callsTo('POST', '/admin/orders/ord-1/transitions')).toHaveLength(0)
  })

  it('never cancels on one click', async () => {
    const user = userEvent.setup()
    detailRoutes(api).on('POST', '/admin/orders/ord-1/cancel', () =>
      jsonResponse(200, {
        success: true,
        data: orderDetail({ status: 'cancelled', cancelledAt: '2026-03-02T00:00:00.000Z' }),
      }),
    )

    await renderAuthed(<OrderDetailPage />, route)
    await user.click(await screen.findByRole('button', { name: 'Cancel order' }))

    expect(api.callsTo('POST', '/admin/orders/ord-1/cancel')).toHaveLength(0)

    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }))
    await waitFor(() => expect(api.callsTo('POST', '/admin/orders/ord-1/cancel')).toHaveLength(1))
  })

  it('saves the pinned note and the tags in one request', async () => {
    const user = userEvent.setup()
    detailRoutes(api).on('PATCH', '/admin/orders/ord-1/annotations', () =>
      jsonResponse(200, {
        success: true,
        data: orderDetail({ adminNote: 'Leave next door.', tags: ['fragile'] }),
      }),
    )

    await renderAuthed(<OrderDetailPage />, route)

    await user.type(await screen.findByLabelText(/^note/i), 'Leave next door.')
    await user.type(screen.getByPlaceholderText('fragile, chase…'), 'fragile,')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(api.callsTo('PATCH', '/admin/orders/ord-1/annotations')).toHaveLength(1),
    )
    // One request, because it is one edit: two would leave half of it saved.
    expect(api.callsTo('PATCH', '/admin/orders/ord-1/annotations')[0]!.body).toEqual({
      note: 'Leave next door.',
      tags: ['fragile'],
    })
  })

  it('adds a timeline note and refetches the feed', async () => {
    const user = userEvent.setup()
    detailRoutes(api).on('POST', '/admin/orders/ord-1/notes', () =>
      jsonResponse(201, {
        success: true,
        data: { id: 'n1', body: 'Packed.', authorUserId: 'user-admin', authorName: 'Ada', at: '2026-03-01T11:00:00.000Z' },
      }),
    )

    await renderAuthed(<OrderDetailPage />, route)

    await user.type(await screen.findByLabelText('Add an internal note'), 'Packed.')
    await user.click(screen.getByRole('button', { name: 'Add note' }))

    await waitFor(() => expect(api.callsTo('POST', '/admin/orders/ord-1/notes')).toHaveLength(1))
    expect(api.callsTo('POST', '/admin/orders/ord-1/notes')[0]!.body).toEqual({ body: 'Packed.' })
  })

  it('records the outstanding balance without sending an amount', async () => {
    const user = userEvent.setup()
    detailRoutes(api).on('POST', '/admin/orders/ord-1/payments', () =>
      jsonResponse(201, { success: true, data: { id: 'pay-1', status: 'captured' } }),
    )

    await renderAuthed(<OrderDetailPage />, route)
    await user.click(await screen.findByRole('button', { name: 'Record payment' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Record payment' }))

    await waitFor(() => expect(api.callsTo('POST', '/admin/orders/ord-1/payments')).toHaveLength(1))
    // The server computes the amount from the order. Sending one from here
    // would be the browser deciding how much money changed hands.
    expect(api.callsTo('POST', '/admin/orders/ord-1/payments')[0]!.body).toEqual({})
  })

  it('ships what is outstanding, not what was ordered', async () => {
    const user = userEvent.setup()
    const partly = orderDetail({
      status: 'confirmed',
      items: [{ ...orderDetail().items[0]!, quantity: 3, fulfilledQuantity: 1 }],
    })
    detailRoutes(api, adminUser, partly).on('POST', '/admin/orders/ord-1/shipments', () =>
      jsonResponse(201, { success: true, data: { id: 'shp-1' } }),
    )

    await renderAuthed(<OrderDetailPage />, route)
    await user.click(await screen.findByRole('button', { name: 'Fulfil everything left' }))
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Create shipment' }),
    )

    await waitFor(() => expect(api.callsTo('POST', '/admin/orders/ord-1/shipments')).toHaveLength(1))
    // Three ordered, one already gone: two left.
    expect(api.callsTo('POST', '/admin/orders/ord-1/shipments')[0]!.body).toEqual({
      items: [{ orderItemId: 'line-1', quantity: 2 }],
    })
  })

  it('hides the money and lifecycle actions from an operator without the permissions', async () => {
    detailRoutes(api, staffUser)
    await renderAuthed(<OrderDetailPage />, route)

    await screen.findByText('#1001')
    expect(screen.queryByRole('button', { name: 'Record payment' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel order' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add note' })).not.toBeInTheDocument()
  })

  it('says a cancelled order is cancelled, and stops offering to ship it', async () => {
    detailRoutes(
      api,
      adminUser,
      orderDetail({
        status: 'cancelled',
        cancelledAt: '2026-03-02T00:00:00.000Z',
        cancelReason: 'Out of stock',
      }),
    )

    await renderAuthed(<OrderDetailPage />, route)

    expect(await screen.findByText('This order was cancelled')).toBeInTheDocument()
    expect(screen.getByText(/Out of stock/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Fulfil everything left' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Confirm order' })).not.toBeInTheDocument()
  })
})
