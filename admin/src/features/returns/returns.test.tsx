import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { tokenStore } from '@/lib/api/tokenStore'
import { apiMock, type ApiMock } from '@/test/api-mock'
import { jsonResponse } from '@/test/http'
import { renderAuthed } from '@/test/renderAuthed'
import {
  adminUser,
  orderDetail,
  refundable,
  returnDetail,
  returnSummary,
  staffUser,
} from '@/test/catalogue'
import { OrderDetailPage } from '@/features/orders/pages/OrderDetailPage'
import { ReturnDetailPage } from './pages/ReturnDetailPage'
import { ReturnListPage } from './pages/ReturnListPage'

/**
 * Returns and refunds.
 *
 * The two things worth holding: every maximum on the refund dialog comes from
 * the server, and receiving sends a condition rather than a restock quantity —
 * so the browser can never ask for damaged goods to go back on sale.
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

// ── The queue ───────────────────────────────────────────────────────────────

describe('ReturnListPage', () => {
  it('lists returns with their status and whether money went back', async () => {
    baseRoutes(api).onList('/admin/returns', [
      returnSummary(),
      returnSummary({ id: 'ret-2', returnNumber: 'R1002', status: 'closed', refunded: true }),
    ])

    await renderAuthed(<ReturnListPage />, { route: '/returns' })

    expect(await screen.findByText('R1001')).toBeInTheDocument()
    const body = screen.getByRole('table').querySelector('tbody')!
    expect(within(body).getByText('Requested')).toBeInTheDocument()
    expect(within(body).getByText('Closed')).toBeInTheDocument()
    expect(within(body).getByText('Yes')).toBeInTheDocument()
  })

  it('filters on the server, and keeps the filter in the URL', async () => {
    const user = userEvent.setup()
    baseRoutes(api).onList('/admin/returns', [returnSummary()])

    await renderAuthed(<ReturnListPage />, { route: '/returns' })
    await screen.findByText('R1001')

    await user.selectOptions(screen.getByLabelText('Filter by status'), 'received')
    await waitFor(() => expect(api.callsTo('GET', 'status=received').length).toBeGreaterThan(0))
  })
})

// ── One return ──────────────────────────────────────────────────────────────

describe('ReturnDetailPage', () => {
  function detailRoutes(mock: ApiMock, user = adminUser, detail = returnDetail()) {
    return baseRoutes(mock, user)
      .on('GET', '/admin/returns/ret-1', () => jsonResponse(200, { success: true, data: detail }))
      .on('GET', '/admin/orders/ord-1', orderDetail())
      .on('GET', '/admin/orders/ord-1/refundable', refundable())
  }

  const route = { route: '/returns/ret-1', path: '/returns/:id' }

  it('offers only the moves that are legal from the current state', async () => {
    detailRoutes(api)
    await renderAuthed(<ReturnDetailPage />, route)

    expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Decline' })).toBeInTheDocument()
    // Nothing has arrived, so there is nothing to receive or refund yet.
    expect(screen.queryByRole('button', { name: 'Record what arrived' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Refund and close' })).not.toBeInTheDocument()
  })

  it('offers nothing at all on a closed return', async () => {
    detailRoutes(
      api,
      adminUser,
      returnDetail({ status: 'closed', closedAt: '2026-03-04T00:00:00.000Z' }),
    )
    await renderAuthed(<ReturnDetailPage />, route)

    await screen.findByText('R1001')
    // The lifecycle has no exit from `closed`; offering one would be a promise
    // the server breaks.
    for (const label of ['Approve', 'Decline', 'Cancel return', 'Close without refunding']) {
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument()
    }
  })

  it('records what arrived with a condition, and never a restock quantity', async () => {
    const user = userEvent.setup()
    detailRoutes(api, adminUser, returnDetail({ status: 'approved' })).on(
      'POST',
      '/admin/returns/ret-1/receive',
      () => jsonResponse(200, { success: true, data: returnDetail({ status: 'received' }) }),
    )

    await renderAuthed(<ReturnDetailPage />, route)

    await user.type(await screen.findByLabelText(/Quantity received/), '2')
    await user.selectOptions(screen.getByLabelText(/^Condition for/), 'damaged')
    await user.click(screen.getByRole('button', { name: 'Record what arrived' }))

    await waitFor(() => expect(api.callsTo('POST', '/admin/returns/ret-1/receive')).toHaveLength(1))
    // A quantity and a condition. The server decides what goes back on the
    // shelf — a client that could send a restock figure could ask for damaged
    // goods to be sold again.
    expect(api.callsTo('POST', '/admin/returns/ret-1/receive')[0]!.body).toEqual({
      lines: [{ orderItemId: 'line-1', receivedQuantity: 2, condition: 'damaged' }],
    })
  })

  it('clamps a received quantity to what was expected', async () => {
    const user = userEvent.setup()
    detailRoutes(api, adminUser, returnDetail({ status: 'approved' }))

    await renderAuthed(<ReturnDetailPage />, route)

    const input = await screen.findByLabelText(/Quantity received/)
    await user.type(input, '9')
    // Two were expected. Letting somebody type nine and then refusing the whole
    // request is a worse way to say the same thing.
    expect(input).toHaveValue(2)
  })

  it('shows what was written off once the goods are in', async () => {
    detailRoutes(
      api,
      adminUser,
      returnDetail({
        status: 'received',
        receivedAt: '2026-03-03T00:00:00.000Z',
        lines: [
          {
            id: 'rl-1',
            orderItemId: 'line-1',
            quantity: 2,
            receivedQuantity: 2,
            restockedQuantity: 0,
            condition: 'damaged',
          },
        ],
      }),
    )

    await renderAuthed(<ReturnDetailPage />, route)

    expect(await screen.findByText('Damaged')).toBeInTheDocument()
    expect(screen.getByText('Written off')).toBeInTheDocument()
  })

  it('declines behind a confirmation', async () => {
    const user = userEvent.setup()
    detailRoutes(api).on('POST', '/admin/returns/ret-1/decline', () =>
      jsonResponse(200, { success: true, data: returnDetail({ status: 'declined' }) }),
    )

    await renderAuthed(<ReturnDetailPage />, route)
    await user.click(await screen.findByRole('button', { name: 'Decline' }))

    expect(api.callsTo('POST', '/admin/returns/ret-1/decline')).toHaveLength(0)
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Decline' }))
    await waitFor(() => expect(api.callsTo('POST', '/admin/returns/ret-1/decline')).toHaveLength(1))
  })

  it('hides the refund from somebody who may receive but not pay', async () => {
    const receiver = { ...adminUser, permissions: ['orders:read', 'returns:read', 'returns:write'] }
    detailRoutes(api, receiver, returnDetail({ status: 'received' }))

    await renderAuthed(<ReturnDetailPage />, route)

    await screen.findByText('R1001')
    // Deciding goods may come back and deciding to send money are two
    // approvals; this operator holds only the first.
    expect(screen.queryByRole('button', { name: 'Refund and close' })).not.toBeInTheDocument()
  })

  it('gives a read-only view to an operator with only returns:read', async () => {
    detailRoutes(api, staffUser)
    await renderAuthed(<ReturnDetailPage />, route)

    await screen.findByText('R1001')
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
  })
})

// ── The refund dialog, on the order page ────────────────────────────────────

describe('RefundDialog', () => {
  function orderRoutes(mock: ApiMock) {
    // The mock matches by substring, so the sub-resources have to be declared
    // before `/admin/orders/ord-1` or that route swallows all of them.
    return baseRoutes(mock)
      .on('GET', '/admin/orders/ord-1/timeline', [])
      .on('GET', '/admin/orders/ord-1/shipments', [])
      .on('GET', '/admin/orders/ord-1/returns', [])
      .on('GET', '/admin/orders/ord-1/refundable', refundable())
      .on('GET', '/admin/orders/ord-1/payments', {
        payments: [
          {
            id: 'pay-1',
            provider: 'manual',
            method: 'cod',
            status: 'paid',
            amount: { amount: 1598, currency: 'GBP' },
            refunded: { amount: 0, currency: 'GBP' },
            capturedAt: '2026-03-01T11:00:00.000Z',
            createdAt: '2026-03-01T11:00:00.000Z',
          },
        ],
        refunds: [],
        outstanding: { amount: 0, currency: 'GBP' },
      })
      .on('GET', '/admin/orders/ord-1', orderDetail())
  }

  const route = { route: '/orders/ord-1', path: '/orders/:id' }

  it('derives the amount from the units chosen, using the server’s per-unit figure', async () => {
    const user = userEvent.setup()
    orderRoutes(api)

    await renderAuthed(<OrderDetailPage />, route)
    await user.click(await screen.findByRole('button', { name: 'Refund' }))

    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText(/Quantity to refund/), '2')

    // 2 × £5.49 — the line's own total per unit after its share of the
    // discount, not the £5.99 list price.
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: /Refund £10\.98/ })).toBeInTheDocument(),
    )
  })

  it('will not let the operator ask for more than remains', async () => {
    const user = userEvent.setup()
    orderRoutes(api)

    await renderAuthed(<OrderDetailPage />, route)
    await user.click(await screen.findByRole('button', { name: 'Refund' }))

    const dialog = await screen.findByRole('dialog')
    const input = within(dialog).getByLabelText(/Quantity to refund/)
    await user.type(input, '9')
    // Two were bought, so two is the maximum the input allows.
    expect(input).toHaveValue(2)
  })

  it('sends the units and the restock decision separately', async () => {
    const user = userEvent.setup()
    orderRoutes(api).on('POST', '/admin/orders/ord-1/refunds', () =>
      jsonResponse(201, {
        success: true,
        data: {
          id: 'ref-1',
          amount: { amount: 1098, currency: 'GBP' },
          reason: 'damaged',
          restock: true,
        },
      }),
    )

    await renderAuthed(<OrderDetailPage />, route)
    await user.click(await screen.findByRole('button', { name: 'Refund' }))

    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText(/Quantity to refund/), '2')
    await user.selectOptions(within(dialog).getByLabelText(/^reason/i), 'damaged')
    await user.click(within(dialog).getByLabelText(/back on the shelf/))
    await user.click(within(dialog).getByRole('button', { name: /^Refund £/ }))

    await waitFor(() => expect(api.callsTo('POST', '/admin/orders/ord-1/refunds')).toHaveLength(1))
    expect(api.callsTo('POST', '/admin/orders/ord-1/refunds')[0]!.body).toEqual({
      paymentId: 'pay-1',
      amountCents: 1098,
      reason: 'damaged',
      restock: true,
      items: [{ orderItemId: 'line-1', quantity: 2 }],
    })
  })

  it('defaults restock to off', async () => {
    const user = userEvent.setup()
    orderRoutes(api)

    await renderAuthed(<OrderDetailPage />, route)
    await user.click(await screen.findByRole('button', { name: 'Refund' }))

    const dialog = await screen.findByRole('dialog')
    // A refund is money; putting goods back on the shelf is stock. Tying them
    // together is how a shop refunds a damaged item and sells it again.
    expect(within(dialog).getByLabelText(/back on the shelf/)).not.toBeChecked()
  })

  it('refuses to restock without knowing which units came back', async () => {
    const user = userEvent.setup()
    orderRoutes(api)

    await renderAuthed(<OrderDetailPage />, route)
    await user.click(await screen.findByRole('button', { name: 'Refund' }))

    const dialog = await screen.findByRole('dialog')
    // Refunding only the postage gives an amount with no units behind it,
    // which is exactly the case restocking cannot make sense of.
    await user.click(within(dialog).getByLabelText(/Refund shipping/))
    await user.click(within(dialog).getByLabelText(/back on the shelf/))
    await user.click(within(dialog).getByRole('button', { name: /^Refund £/ }))

    expect(await screen.findByText(/Restocking needs the units/)).toBeInTheDocument()
    expect(api.callsTo('POST', '/admin/orders/ord-1/refunds')).toHaveLength(0)
  })
})
