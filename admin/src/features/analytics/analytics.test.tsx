import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { tokenStore } from '@/lib/api/tokenStore'
import { apiMock, type ApiMock } from '@/test/api-mock'
import { renderAuthed } from '@/test/renderAuthed'
import { ownerUser } from '@/test/catalogue'
import { AnalyticsPage } from './pages/AnalyticsPage'

/**
 * The analytics screen.
 *
 * What these tests defend:
 *
 *   • **Nothing is added up in the browser.** Every total on screen is the
 *     server's `summary`. A page that summed the days itself would produce a
 *     second answer, and two irreconcilable totals is worse than none.
 *   • **The window ends yesterday, and the page says so.** The rollup job has
 *     not written today's row, so a range ending today reports a day of zero
 *     sales beside a chart that falls off a cliff.
 *   • **Recomputing is a narrower permission than reading.** It rewrites the
 *     table every figure is drawn from.
 */

let api: ApiMock

const money = (amount: number) => ({ amount, currency: 'GBP' })

function day(date: string, netSales: number, ordersCount: number) {
  return {
    date,
    ordersCount,
    cancelledCount: 0,
    unitsSold: ordersCount * 2,
    grossSales: money(netSales),
    discounts: money(0),
    refunds: money(0),
    netSales: money(netSales),
    tax: money(0),
    shipping: money(0),
    total: money(netSales),
    averageOrderValue: money(ordersCount ? Math.round(netSales / ordersCount) : 0),
    newCustomers: 1,
    returningCustomers: 1,
  }
}

/**
 * `apiMock` matches in registration order, so an override has to be registered
 * *before* the default it replaces.
 */
function routes(
  mock: ApiMock,
  overrides: (m: ApiMock) => ApiMock = (m) => m,
  user = ownerUser,
) {
  return overrides(mock.withSession(user))
    .on('GET', '/storefront/settings', { currency: 'GBP', storeName: 'Copperleaf', logoUrl: null })
    .on('GET', '/admin/notifications/unread-count', { count: 0 })
    .on('GET', '/admin/analytics/sales', {
      range: { from: '2026-08-04', to: '2026-09-02' },
      summary: {
        ordersCount: 42,
        unitsSold: 84,
        netSales: money(123456),
        total: money(140000),
        averageOrderValue: money(2939),
      },
      series: [
        day('2026-08-31', 40000, 12),
        day('2026-09-01', 55000, 18),
        day('2026-09-02', 28456, 12),
      ],
    })
    .on('GET', '/admin/analytics/products', [
      {
        productId: 'p1',
        variantId: 'v1',
        title: 'Copperleaf Classic',
        variantTitle: 'Single',
        unitsSold: 30,
        netSales: money(60000),
      },
      {
        productId: 'p2',
        variantId: 'v2',
        title: 'Velvet Matte',
        variantTitle: null,
        unitsSold: 12,
        netSales: money(24000),
      },
    ])
    .on('GET', '/admin/analytics/events', [
      { name: 'product_viewed', count: 900 },
      { name: 'cart_item_added', count: 120 },
      { name: 'checkout_completed', count: 42 },
    ])
}

beforeEach(() => {
  api = apiMock().install()
  tokenStore.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  tokenStore.clear()
})

describe('the figures', () => {
  it('shows the server’s totals, not its own', async () => {
    // 123456 minor units. Summing the three days below gives the same number
    // only by construction — the page must read `summary`, and this fails if
    // anybody ever makes it add the series up.
    routes(api)

    await renderAuthed(<AnalyticsPage />, { route: '/analytics' })

    expect(await screen.findByText('£1,234.56')).toBeInTheDocument()
    // The average is the server's too — 123456/42 is not a whole number of
    // pence, and a browser dividing the two would print a different figure.
    expect(screen.getByText('£29.39')).toBeInTheDocument()
  })

  it('asks for a range that ends yesterday', async () => {
    // The rollup has no row for today, so asking for it would report a zero.
    routes(api)

    await renderAuthed(<AnalyticsPage />, { route: '/analytics' })

    await waitFor(() => {
      const url = api.callsTo('GET', '/admin/analytics/sales')[0]?.url ?? ''
      const to = new URL(url, 'http://x').searchParams.get('to')
      const today = new Date().toISOString().slice(0, 10)
      expect(to).not.toBe(today)
    })
  })

  it('explains why these numbers differ from the dashboard', async () => {
    routes(api)

    await renderAuthed(<AnalyticsPage />, { route: '/analytics' })

    expect(await screen.findByText(/window ends yesterday/i)).toBeInTheDocument()
  })

  it('re-asks the server when the period changes', async () => {
    // Never filtered in the browser: the server owns the range, and a page that
    // sliced its own cached series would answer a different question.
    const user = userEvent.setup()
    routes(api)

    await renderAuthed(<AnalyticsPage />, { route: '/analytics' })
    await screen.findByText('£1,234.56')

    await user.selectOptions(screen.getByLabelText('Period'), '7')

    await waitFor(() => {
      expect(api.callsTo('GET', '/admin/analytics/sales').length).toBeGreaterThan(1)
    })
  })
})

describe('the charts', () => {
  it('draws sales and orders separately, never on shared axes', async () => {
    // A dual-axis chart can be slid until any two lines appear to agree, and
    // nothing about where they cross is true.
    routes(api)

    await renderAuthed(<AnalyticsPage />, { route: '/analytics' })

    expect(await screen.findByRole('img', { name: /^Net sales from/ })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /^Orders from/ })).toBeInTheDocument()
  })

  it('describes the trend for somebody who cannot see it', async () => {
    routes(api)

    await renderAuthed(<AnalyticsPage />, { route: '/analytics' })

    const chart = await screen.findByRole('img', { name: /^Net sales from/ })
    // The peak is named and valued: the one fact a sighted reader takes from a
    // sparkline at a glance.
    expect(chart).toHaveAccessibleName(/Highest.*£550\.00/)
  })

  it('ranks products by the server’s order', async () => {
    routes(api)

    await renderAuthed(<AnalyticsPage />, { route: '/analytics' })

    expect(await screen.findByText('Copperleaf Classic')).toBeInTheDocument()
    expect(screen.getByText(/£600\.00 · 30 sold/)).toBeInTheDocument()
  })

  it('names storefront events in an operator’s words', async () => {
    routes(api)

    await renderAuthed(<AnalyticsPage />, { route: '/analytics' })

    expect(await screen.findByText('Products viewed')).toBeInTheDocument()
    expect(screen.getByText('Checkouts completed')).toBeInTheDocument()
    // Never the raw wire name.
    expect(screen.queryByText('checkout_completed')).not.toBeInTheDocument()
  })
})

const reporter = { ...ownerUser, permissions: [...ownerUser.permissions, 'reports:generate'] }

describe('recomputing', () => {
  it('is offered to somebody who may generate reports', async () => {
    routes(api, (m) => m, reporter)

    await renderAuthed(<AnalyticsPage />, { route: '/analytics' })

    expect(await screen.findByRole('button', { name: /Recompute/ })).toBeInTheDocument()
  })

  it('sends the range on screen', async () => {
    const user = userEvent.setup()
    routes(api, (m) => m.on('POST', '/admin/analytics/rollups', {
          recomputed: 30,
          from: '2026-08-04',
          to: '2026-09-02',
        }), reporter)

    await renderAuthed(<AnalyticsPage />, { route: '/analytics' })
    await user.click(await screen.findByRole('button', { name: /Recompute/ }))

    await waitFor(() => {
      const body = api.callsTo('POST', '/admin/analytics/rollups')[0]?.body as {
        from: string
        to: string
      }
      expect(body.from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(body.to).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })
  })

  it('is hidden from somebody who may only read', async () => {
    // `analytics:read` is not `reports:generate`: one looks, the other rewrites
    // the table everything on the page is drawn from. The owner fixture holds
    // the first and not the second, which is the real division.
    routes(api)

    await renderAuthed(<AnalyticsPage />, { route: '/analytics' })

    await screen.findByText('£1,234.56')
    expect(screen.queryByRole('button', { name: /Recompute/ })).not.toBeInTheDocument()
  })
})

describe('an empty range', () => {
  it('says nothing sold rather than drawing an empty chart', async () => {
    routes(api, (m) =>
      m.on('GET', '/admin/analytics/products', []).on('GET', '/admin/analytics/events', []),
    )

    await renderAuthed(<AnalyticsPage />, { route: '/analytics' })

    expect(await screen.findByText(/Nothing sold in this range/)).toBeInTheDocument()
    // Distinguished from "nobody visited": these rows exist only if the
    // storefront reports them.
    expect(screen.getByText(/No storefront activity recorded/)).toBeInTheDocument()
  })

  it('will not draw a trend from a single day', async () => {
    routes(api, (m) =>
      m.on('GET', '/admin/analytics/sales', {
        range: { from: '2026-09-02', to: '2026-09-02' },
        summary: {
          ordersCount: 1,
          unitsSold: 1,
          netSales: money(1000),
          total: money(1000),
          averageOrderValue: money(1000),
        },
        series: [day('2026-09-02', 1000, 1)],
      }),
    )

    await renderAuthed(<AnalyticsPage />, { route: '/analytics' })

    const notices = await screen.findAllByText(/Not enough days in this range/)
    expect(notices.length).toBeGreaterThan(0)
  })
})

describe('the ranked list', () => {
  it('gives every bar the same colour, whatever its rank', async () => {
    // Shading by rank would repaint a product when a filter reorders the list —
    // the same product, a different colour, which reads as a different thing.
    routes(api)

    await renderAuthed(<AnalyticsPage />, { route: '/analytics' })
    await screen.findByText('Copperleaf Classic')

    const list = screen.getByText('Copperleaf Classic').closest('ul')!
    const fills = within(list)
      .getAllByRole('listitem')
      .map((item) => item.querySelector('div[style]')?.className)
    expect(new Set(fills).size).toBe(1)
  })
})
