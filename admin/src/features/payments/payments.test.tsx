import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { tokenStore } from '@/lib/api/tokenStore'
import { apiMock, type ApiMock } from '@/test/api-mock'
import { renderAuthed } from '@/test/renderAuthed'
import { jsonResponse } from '@/test/http'
import { adminUser } from '@/test/catalogue'
import type { CurrentUser } from '@/features/auth/auth.types'
import { PaymentsPage } from './pages/PaymentsPage'

/**
 * Payment management.
 *
 * Three things this suite holds down, all of them about not moving money by
 * accident:
 *
 *   **Approving is never one click.** It records money and confirms an order,
 *   so it goes through a confirmation that says so.
 *
 *   **A rejection must carry a reason.** The customer reads it; "no" alone
 *   leaves somebody who believes they have paid with nowhere to go.
 *
 *   **Nothing the customer typed is sent back as an amount.** The approve
 *   request has an empty body — the server computes what is owed.
 */

let api: ApiMock

const proof = (over: Record<string, unknown> = {}) => ({
  id: 'proof-1',
  orderId: 'order-1',
  status: 'submitted',
  claim: { senderName: 'Ada Lovelace', senderBank: 'Example Bank', accountLast4: '4321' },
  imageUrl: 'https://cdn.example.test/receipt.jpg',
  mediaId: 'media-1',
  submittedAt: '2026-09-01T10:00:00.000Z',
  submittedBy: null,
  reviewedAt: null,
  reviewedBy: null,
  reviewedByName: null,
  reviewNote: null,
  paymentId: null,
  order: {
    orderNumber: '#1042',
    email: 'payer@example.test',
    total: { amount: 5499, currency: 'GBP' },
    status: 'pending',
  },
  ...over,
})

const payment = (over: Record<string, unknown> = {}) => ({
  id: 'pay-1',
  orderId: 'order-1',
  orderNumber: '#1042',
  orderEmail: 'payer@example.test',
  method: 'bank_transfer',
  status: 'paid',
  amount: { amount: 5499, currency: 'GBP' },
  refunded: { amount: 0, currency: 'GBP' },
  provider: 'manual',
  providerPaymentId: null,
  failureMessage: null,
  createdAt: '2026-09-01T10:05:00.000Z',
  capturedAt: '2026-09-01T10:05:00.000Z',
  ...over,
})

/** Can look at payments, cannot decide about them. */
const reviewer: CurrentUser = {
  ...adminUser,
  id: 'user-reviewer',
  email: 'reader@example.com',
  roles: ['staff'],
  permissions: ['orders:read', 'payments:read'],
  sessionId: 'session-reviewer',
}

/**
 * The proofs endpoint, whose `meta.pending` is the whole-table count rather
 * than this page's length — `onList` only fills in pagination, so the envelope
 * is built by hand here.
 */
function onProofs(mock: ApiMock, items: unknown[], pending: number) {
  return mock.on('GET', '/admin/payments/proofs', () =>
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
        },
        pending,
      },
    }),
  )
}

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

describe('the review queue', () => {
  it('shows the claim beside the order total it has to be checked against', async () => {
    onProofs(baseRoutes(api), [proof()], 1)

    renderAuthed(<PaymentsPage />, { route: '/payments', path: '/payments' })

    expect(await screen.findByText('#1042')).toBeInTheDocument()
    // The customer's claim — labelled as a claim, not as fact.
    expect(screen.getByText('Customer says')).toBeInTheDocument()
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument()
    expect(screen.getByText('•••• 4321')).toBeInTheDocument()
    // The shop's own figure.
    expect(screen.getByText('Order total')).toBeInTheDocument()
    expect(screen.getByText('£54.99')).toBeInTheDocument()
  })

  it('counts what is waiting on the tab', async () => {
    onProofs(baseRoutes(api), [proof()], 7)

    renderAuthed(<PaymentsPage />, { route: '/payments', path: '/payments' })

    // The count arrives with the data, so wait for the name that includes it
    // rather than for the tab, which is on screen before the request settles.
    expect(await screen.findByRole('tab', { name: /To review\s*7/ })).toBeInTheDocument()
  })

  it('says so when there is nothing to do', async () => {
    onProofs(baseRoutes(api), [], 0)

    renderAuthed(<PaymentsPage />, { route: '/payments', path: '/payments' })

    expect(await screen.findByText('Nothing to review')).toBeInTheDocument()
  })

  it('confirms before recording money, and sends no amount', async () => {
    onProofs(baseRoutes(api), [proof()], 1).on(
      'POST',
      '/admin/payments/proofs/proof-1/approve',
      proof({ status: 'approved' }),
    )

    renderAuthed(<PaymentsPage />, { route: '/payments', path: '/payments' })

    await userEvent.click(await screen.findByRole('button', { name: /Approve and mark paid/ }))

    // Never one click: the dialog says what is about to happen.
    expect(await screen.findByText(/will be marked paid for £54.99/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Yes, record it/ }))

    await waitFor(() => {
      expect(api.callsTo('POST', '/admin/payments/proofs/proof-1/approve')).toHaveLength(1)
    })
    // The body carries nothing: the server decides what is owed, and a client
    // that could name a figure could be talked into a forged one.
    const [call] = api.callsTo('POST', '/admin/payments/proofs/proof-1/approve')
    expect(call?.body ?? {}).toEqual({})
  })

  it('will not reject without a reason', async () => {
    onProofs(baseRoutes(api), [proof()], 1)

    renderAuthed(<PaymentsPage />, { route: '/payments', path: '/payments' })

    await userEvent.click(await screen.findByRole('button', { name: /^Reject$/ }))

    const confirm = await screen.findByRole('button', { name: /Reject receipt/ })
    expect(confirm).toBeDisabled()
  })

  it('sends the reason the customer will read', async () => {
    onProofs(baseRoutes(api), [proof()], 1).on(
      'POST',
      '/admin/payments/proofs/proof-1/reject',
      proof({ status: 'rejected' }),
    )

    renderAuthed(<PaymentsPage />, { route: '/payments', path: '/payments' })

    await userEvent.click(await screen.findByRole('button', { name: /^Reject$/ }))
    // A preset fills the field rather than submitting, so it can be edited.
    await userEvent.click(await screen.findByRole('button', { name: /amount does not match/i }))
    await userEvent.click(screen.getByRole('button', { name: /Reject receipt/ }))

    await waitFor(() => {
      expect(api.callsTo('POST', '/admin/payments/proofs/proof-1/reject')).toHaveLength(1)
    })
    const [call] = api.callsTo('POST', '/admin/payments/proofs/proof-1/reject')
    expect(call?.body).toMatchObject({ note: 'The amount does not match your order total.' })
  })

  it('shows why a receipt was turned down, and by whom', async () => {
    onProofs(
      baseRoutes(api),
      [
        proof({
          status: 'rejected',
          reviewedAt: '2026-09-01T11:00:00.000Z',
          reviewedByName: 'owner@example.test',
          reviewNote: 'We could not find this payment.',
        }),
      ],
      0,
    )

    renderAuthed(<PaymentsPage />, { route: '/payments', path: '/payments' })

    expect(await screen.findByText(/We could not find this payment/)).toBeInTheDocument()
    expect(screen.getByText(/owner@example.test/)).toBeInTheDocument()
    // A decided receipt offers no buttons.
    expect(screen.queryByRole('button', { name: /Approve and mark paid/ })).not.toBeInTheDocument()
  })

  it('lets a reader look without deciding', async () => {
    // Staff hold payments:read but not payments:capture.
    onProofs(baseRoutes(api, reviewer), [proof()], 1)

    renderAuthed(<PaymentsPage />, { route: '/payments', path: '/payments' })

    expect(await screen.findByText('#1042')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Approve and mark paid/ })).not.toBeInTheDocument()
    expect(screen.getByText(/not decide about it/)).toBeInTheDocument()
  })
})

// ── The ledger ──────────────────────────────────────────────────────────────

describe('the payments ledger', () => {
  it('lists payments across orders with their method and status', async () => {
    onProofs(baseRoutes(api), [], 0).onList('/admin/payments', [payment()])

    renderAuthed(<PaymentsPage />, { route: '/payments?tab=ledger', path: '/payments' })

    // Scoped to the table: "Bank transfer" and "Paid" are also option labels in
    // the filter selects, and a bare getByText would pass on an empty ledger.
    const table = await screen.findByRole('table')
    expect(await within(table).findByText('#1042')).toBeInTheDocument()
    expect(within(table).getByText('Bank transfer')).toBeInTheDocument()
    expect(within(table).getByText('Paid')).toBeInTheDocument()
    expect(within(table).getByText('£54.99')).toBeInTheDocument()
  })

  it('shows a refund beside the amount it came out of', async () => {
    onProofs(baseRoutes(api), [], 0).onList('/admin/payments', [
      payment({ status: 'partially_refunded', refunded: { amount: 1000, currency: 'GBP' } }),
    ])

    renderAuthed(<PaymentsPage />, { route: '/payments?tab=ledger', path: '/payments' })

    // "How much did we keep" is one glance, not two columns.
    expect(await screen.findByText(/−£10.00 refunded/)).toBeInTheDocument()
  })

  it('filters on the server, through the URL', async () => {
    onProofs(baseRoutes(api), [], 0).onList('/admin/payments', [payment()])

    renderAuthed(<PaymentsPage />, { route: '/payments?tab=ledger', path: '/payments' })

    await screen.findByText('Bank transfer')
    await userEvent.selectOptions(screen.getByLabelText('Filter by method'), 'cod')

    await waitFor(() => {
      const calls = api.callsTo('GET', '/admin/payments')
      expect(calls.at(-1)?.url).toMatch(/method=cod/)
    })
  })
})
