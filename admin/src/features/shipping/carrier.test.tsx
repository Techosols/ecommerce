import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { tokenStore } from '@/lib/api/tokenStore'
import { apiMock, type ApiMock } from '@/test/api-mock'
import { renderAuthed } from '@/test/renderAuthed'
import { adminUser, defaultPagination } from '@/test/catalogue'
import { CodReconciliationPage } from './pages/CodReconciliationPage'
import { CarrierCard } from './components/CarrierCard'
import type {
  CarrierCapabilities,
  CodRemittance,
  CodRemittanceLine,
} from './types/carrier.types'

/**
 * The courier surfaces.
 *
 * What is worth holding down here is not that the screens render — it is the
 * three rules that make them safe to use:
 *
 *   • **Capabilities decide what exists.** A shop with no courier connected is
 *     never offered a control that cannot work.
 *   • **A mismatched line cannot be banked.** It is the finding, not a rounding
 *     error, and it has no button.
 *   • **Settling is one line at a time, behind a confirmation** that says what
 *     it will do to the order rather than asking "are you sure?".
 */

let api: ApiMock

const MANUAL: CarrierCapabilities = {
  provider: 'manual',
  label: 'No courier connected',
  quotes: false,
  booking: false,
  tracking: false,
  remittance: false,
  canImportRemittances: false,
}

const CONNECTED: CarrierCapabilities = {
  provider: 'swiftpost',
  label: 'SwiftPost',
  quotes: true,
  booking: true,
  tracking: true,
  remittance: true,
  canImportRemittances: true,
}

function line(overrides: Partial<CodRemittanceLine> = {}): CodRemittanceLine {
  return {
    id: 'line-1',
    trackingNumber: 'SP000123',
    shipmentId: 'ship-1',
    orderId: 'order-1',
    orderNumber: '#1042',
    collectedCents: 5499,
    feeCents: 200,
    netCents: 5299,
    currency: 'GBP',
    collectedAt: '2026-08-03T00:00:00.000Z',
    reference: null,
    matchStatus: 'matched',
    expectedCents: 5499,
    settled: false,
    ...overrides,
  }
}

function statement(overrides: Partial<CodRemittance> = {}): CodRemittance {
  return {
    id: 'rem-1',
    provider: 'swiftpost',
    reference: 'AUG-2026-01',
    declaredNetCents: 5299,
    currency: 'GBP',
    statementDate: '2026-08-03',
    sourceFilename: 'august.csv',
    importedAt: '2026-08-04T09:00:00.000Z',
    totals: {
      lines: 1,
      matched: 1,
      mismatched: 0,
      unmatched: 0,
      collectedCents: 5499,
      feeCents: 200,
      netCents: 5299,
    },
    ...overrides,
  }
}

/** Overrides register first: `apiMock` matches by substring in that order. */
function routes(
  mock: ApiMock,
  overrides: (mock: ApiMock) => ApiMock = (m) => m,
  user = adminUser,
) {
  return overrides(mock)
    .withSession(user)
    .on('GET', '/storefront/settings', { currency: 'GBP', storeName: 'Test' })
    .on('GET', '/admin/notifications/unread-count', { count: 0 })
    .on('GET', '/admin/shipping/carrier', CONNECTED)
    .onList('/admin/shipping/cod/remittances', [statement()], defaultPagination)
}

beforeEach(() => {
  api = apiMock().install()
  tokenStore.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  tokenStore.clear()
})

// ── What the courier can do ─────────────────────────────────────────────────

describe('CarrierCard', () => {
  it('names the connected courier and what it can do', async () => {
    routes(api)
    await renderAuthed(<CarrierCard />)

    expect(await screen.findByText('SwiftPost')).toBeInTheDocument()
    expect(screen.getByText('Connected')).toBeInTheDocument()
    expect(screen.getByText(/Books the consignment/)).toBeInTheDocument()
  })

  it('says plainly when no courier is connected', async () => {
    routes(api, (mock) => mock.on('GET', '/admin/shipping/carrier', MANUAL))
    await renderAuthed(<CarrierCard />)

    expect(await screen.findByText('No courier connected')).toBeInTheDocument()
    expect(screen.getByText('Not connected')).toBeInTheDocument()
    // And what happens instead, rather than leaving it as an inference.
    expect(screen.getByText(/enter the carrier and tracking number by hand/i)).toBeInTheDocument()
  })
})

// ── Reconciliation ──────────────────────────────────────────────────────────

describe('CodReconciliationPage', () => {
  it('offers no import when the courier cannot produce statements', async () => {
    routes(api, (mock) => mock.on('GET', '/admin/shipping/carrier', MANUAL))
    await renderAuthed(<CodReconciliationPage />, { route: '/payments/cod' })

    expect(await screen.findByText(/No courier statements to import/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /import statement/i })).not.toBeInTheDocument()
  })

  it('shows a statement’s findings without making the operator count', async () => {
    routes(api, (mock) =>
      mock.onList(
        '/admin/shipping/cod/remittances',
        [
          statement({
            totals: {
              lines: 12,
              matched: 9,
              mismatched: 2,
              unmatched: 1,
              collectedCents: 60000,
              feeCents: 2400,
              netCents: 57600,
            },
          }),
        ],
        defaultPagination,
      ),
    )
    await renderAuthed(<CodReconciliationPage />, { route: '/payments/cod' })

    const table = await screen.findByRole('table')
    expect(within(table).getByText('9 matched')).toBeInTheDocument()
    expect(within(table).getByText('2 disagree')).toBeInTheDocument()
    expect(within(table).getByText('1 unmatched')).toBeInTheDocument()
  })

  it('offers no way to bank a line the courier short-paid', async () => {
    routes(api, (mock) =>
      mock.on('GET', '/admin/shipping/cod/remittances/rem-1', {
        ...statement({
          totals: {
            lines: 1,
            matched: 0,
            mismatched: 1,
            unmatched: 0,
            collectedCents: 5000,
            feeCents: 200,
            netCents: 4800,
          },
        }),
        lines: [line({ matchStatus: 'mismatched', collectedCents: 5000, expectedCents: 5499 })],
      }),
    )
    await renderAuthed(<CodReconciliationPage />, { route: '/payments/cod' })

    await userEvent.click(await screen.findByRole('button', { name: 'AUG-2026-01' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Disagrees')).toBeInTheDocument()
    // The difference is shown, because it is the whole finding.
    expect(within(dialog).getByText(/order owed/i)).toBeInTheDocument()
    expect(
      within(dialog).queryByRole('button', { name: /record payment/i }),
    ).not.toBeInTheDocument()
  })

  it('settles a matched line only after saying what it will do', async () => {
    let settled = false
    routes(api, (mock) =>
      mock
        .on('POST', '/admin/shipping/cod/lines/line-1/settle', () => {
          settled = true
          return { id: 'pay-1', amount: { amount: 5499, currency: 'GBP' } }
        })
        .on('GET', '/admin/shipping/cod/remittances/rem-1', {
          ...statement(),
          lines: [line()],
        }),
    )
    await renderAuthed(<CodReconciliationPage />, { route: '/payments/cod' })

    await userEvent.click(await screen.findByRole('button', { name: 'AUG-2026-01' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /record payment/i }))

    // The confirmation names the consequence — paid, confirmed, stock committed
    // — rather than asking whether the operator is sure.
    expect(await screen.findByText(/commits its stock/i)).toBeInTheDocument()
    expect(settled).toBe(false)

    // Scoped to the confirmation: the line's own trigger carries the same
    // label, and clicking that again would only reopen this.
    const confirm = screen.getAllByRole('dialog').at(-1) as HTMLElement
    await userEvent.click(within(confirm).getByRole('button', { name: 'Record payment' }))
    await waitFor(() => expect(settled).toBe(true))
  })
})
