import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { tokenStore } from '@/lib/api/tokenStore'
import { apiMock, type ApiMock } from '@/test/api-mock'
import { jsonResponse } from '@/test/http'
import { renderAuthed } from '@/test/renderAuthed'
import {
  category,
  discountDetail,
  discountSummary,
  ownerUser,
  productSummary,
  redemption,
} from '@/test/catalogue'
import { DiscountDetailPage } from './pages/DiscountDetailPage'
import { DiscountListPage } from './pages/DiscountListPage'
import {
  bpsToPercent,
  describeTerms,
  describeUsage,
  describeValue,
  percentToBps,
} from './components/discountLabels'

/**
 * Discounts.
 *
 * The three things worth holding down:
 *
 *   • **`value` means two units.** Basis points for a percentage, minor units
 *     for a fixed amount. A screen that rendered 2500 beside a percent sign
 *     would be wrong by a hundred and would look like a typo.
 *   • **The status is the server's.** Six columns decide whether a code works,
 *     and the console must not re-derive them — it would eventually say a code
 *     is live while checkout refuses it.
 *   • **A code and its type are fixed.** An order citing SUMMER25 as a
 *     percentage has to keep meaning that, so the page shows them and never
 *     offers to change them.
 */

let api: ApiMock

function baseRoutes(mock: ApiMock, user = ownerUser) {
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

// ── The two units ───────────────────────────────────────────────────────────

describe('discount labels', () => {
  it('reads basis points as a percentage and minor units as money', () => {
    expect(describeValue({ type: 'percentage', value: 2500 }, 'GBP')).toBe('25%')
    // The same number, the other type, and a hundredfold difference.
    expect(describeValue({ type: 'fixed_amount', value: 2500 }, 'GBP')).toBe('£25.00')
    expect(describeValue({ type: 'free_shipping', value: 0 }, 'GBP')).toBe('Free delivery')
  })

  it('round-trips a percentage a person types', () => {
    expect(bpsToPercent(2500)).toBe('25')
    expect(bpsToPercent(1250)).toBe('12.5')
    expect(percentToBps('12.5')).toBe(1250)
    expect(percentToBps('')).toBe(0)
  })

  it('writes the whole rule in one line', () => {
    expect(
      describeTerms(
        discountSummary({
          type: 'percentage',
          value: 1000,
          appliesTo: 'products',
          minSubtotalCents: 5000,
          requiresCustomer: true,
        }),
        'GBP',
      ),
    ).toBe('10% · on chosen products · over £50.00 · signed-in customers')
  })

  it('says a usage count against its limit, or without one', () => {
    expect(describeUsage({ usageCount: 47, usageLimitTotal: 100 })).toBe('47 of 100 used')
    expect(describeUsage({ usageCount: 47, usageLimitTotal: null })).toBe('47 used')
  })
})

// ── The list ────────────────────────────────────────────────────────────────

describe('DiscountListPage', () => {
  function listRoutes(mock: ApiMock, rows = [discountSummary()], user = ownerUser) {
    return baseRoutes(mock, user).onList('/admin/discounts', rows)
  }

  it('shows the code, what it takes off, and how far through it is', async () => {
    listRoutes(api, [discountSummary({ usageCount: 47, usageLimitTotal: 100 })])
    await renderAuthed(<DiscountListPage />, { route: '/discounts' })

    const row = within(await screen.findByRole('row', { name: /SUMMER25/ }))
    expect(row.getByText('25%')).toBeInTheDocument()
    expect(row.getByText('47 of 100 used')).toBeInTheDocument()
    expect(row.getByText('Active')).toBeInTheDocument()
  })

  it('takes the status from the server rather than working it out', async () => {
    // A code whose dates have passed but which the server still calls active
    // must render as active: the server is the one checkout agrees with.
    listRoutes(api, [
      discountSummary({ code: 'ODD', endsAt: '2020-01-01T00:00:00.000Z', status: 'active' }),
      discountSummary({ id: 'disc-2', code: 'SOON', status: 'scheduled' }),
      discountSummary({ id: 'disc-3', code: 'GONE', status: 'exhausted' }),
    ])
    await renderAuthed(<DiscountListPage />, { route: '/discounts' })

    expect(
      within(await screen.findByRole('row', { name: /ODD/ })).getByText('Active'),
    ).toBeInTheDocument()
    expect(
      within(screen.getByRole('row', { name: /SOON/ })).getByText('Scheduled'),
    ).toBeInTheDocument()
    expect(
      within(screen.getByRole('row', { name: /GONE/ })).getByText('Used up'),
    ).toBeInTheDocument()
  })

  it('sends the search and the status to the server', async () => {
    const user = userEvent.setup()
    listRoutes(api)
    await renderAuthed(<DiscountListPage />, { route: '/discounts' })
    await screen.findByText('SUMMER25')

    await user.type(screen.getByLabelText('Search discounts'), 'summ')
    await user.selectOptions(screen.getByLabelText('Status'), 'scheduled')

    await waitFor(() => {
      const last = api.callsTo('GET', '/admin/discounts').at(-1)!
      expect(last.url).toContain('q=summ')
      expect(last.url).toContain('status=scheduled')
    })
  })

  it('asks for archived codes only when archived is the filter', async () => {
    const user = userEvent.setup()
    listRoutes(api)
    await renderAuthed(<DiscountListPage />, { route: '/discounts' })
    await screen.findByText('SUMMER25')

    expect(api.callsTo('GET', '/admin/discounts')[0]!.url).not.toContain('includeArchived')

    await user.selectOptions(screen.getByLabelText('Status'), 'archived')

    await waitFor(() => {
      expect(api.callsTo('GET', '/admin/discounts').at(-1)!.url).toContain('includeArchived=true')
    })
  })

  it('says what an empty shop means rather than just that it is empty', async () => {
    listRoutes(api, [])
    await renderAuthed(<DiscountListPage />, { route: '/discounts' })

    expect(await screen.findByText('No discounts yet')).toBeInTheDocument()
    expect(
      screen.getByText(/Nothing is discounted until one exists and is live/),
    ).toBeInTheDocument()
  })

  it('hides creating from an operator who may only look', async () => {
    const readOnly = {
      ...ownerUser,
      permissions: ownerUser.permissions.filter((p) => p !== 'discounts:write'),
    }
    listRoutes(api, [discountSummary()], readOnly)
    await renderAuthed(<DiscountListPage />, { route: '/discounts' })

    await screen.findByText('SUMMER25')
    expect(screen.queryByRole('button', { name: 'New discount' })).not.toBeInTheDocument()
  })
})

// ── Creating one ────────────────────────────────────────────────────────────

describe('CreateDiscountDialog', () => {
  async function open() {
    const user = userEvent.setup()
    baseRoutes(api).onList('/admin/discounts', [])
    await renderAuthed(<DiscountListPage />, { route: '/discounts' })
    await screen.findByText('No discounts yet')
    await user.click(screen.getByRole('button', { name: 'New discount' }))
    return user
  }

  it('sends a percentage as basis points', async () => {
    const user = await open()
    api.on('POST', '/admin/discounts', discountDetail())

    await user.type(screen.getByLabelText(/^Code/), 'summer25')
    await user.type(screen.getByLabelText(/^Name/), 'Summer sale')
    await user.clear(screen.getByLabelText(/^Percent off/))
    await user.type(screen.getByLabelText(/^Percent off/), '12.5')
    await user.click(screen.getByRole('button', { name: 'Create discount' }))

    await waitFor(() => {
      expect(api.callsTo('POST', '/admin/discounts')).toHaveLength(1)
    })
    expect(api.callsTo('POST', '/admin/discounts')[0]!.body).toMatchObject({
      // Upper-cased, because a code is typed off a poster.
      code: 'SUMMER25',
      type: 'percentage',
      value: 1250,
    })
  })

  it('sends no value at all for free delivery', async () => {
    const user = await open()
    api.on('POST', '/admin/discounts', discountDetail({ type: 'free_shipping', value: 0 }))

    await user.type(screen.getByLabelText(/^Code/), 'FREESHIP')
    await user.type(screen.getByLabelText(/^Name/), 'Free delivery')
    await user.selectOptions(screen.getByLabelText(/^Takes off/), 'free_shipping')
    await user.click(screen.getByRole('button', { name: 'Create discount' }))

    await waitFor(() => {
      expect(api.callsTo('POST', '/admin/discounts')).toHaveLength(1)
    })
    const body = api.callsTo('POST', '/admin/discounts')[0]!.body as Record<string, unknown>
    expect(body.type).toBe('free_shipping')
    expect(body).not.toHaveProperty('value')
  })

  it('refuses a code a customer could not type from a poster', async () => {
    const user = await open()

    await user.type(screen.getByLabelText(/^Code/), 'SPRING 25%')

    expect(await screen.findByText(/nothing a customer cannot type/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create discount' })).toBeDisabled()
  })

  it('warns that the code and the type are decided here for good', async () => {
    await open()

    expect(screen.getByText(/cannot be changed afterwards/)).toBeInTheDocument()
  })
})

// ── One discount ────────────────────────────────────────────────────────────

describe('DiscountDetailPage', () => {
  const route = { route: '/discounts/disc-1', path: '/discounts/:id' }

  function detailRoutes(mock: ApiMock, discount = discountDetail(), user = ownerUser) {
    return baseRoutes(mock, user)
      .onList('/admin/discounts/disc-1/redemptions', [])
      .on('GET', '/admin/discounts/disc-1', discount)
      .onList('/admin/products', [productSummary()])
      .on('GET', '/admin/categories', [category()])
  }

  it('shows the code and the type as facts, with no way to change them', async () => {
    detailRoutes(api)
    await renderAuthed(<DiscountDetailPage />, route)

    expect(await screen.findByRole('heading', { name: 'SUMMER25' })).toBeInTheDocument()
    expect(screen.getByText('Fixed at creation')).toBeInTheDocument()
    expect(screen.getByText(/Retyping either would leave those orders/)).toBeInTheDocument()
    // No input holds the code.
    expect(screen.queryByLabelText(/^Code/)).not.toBeInTheDocument()
  })

  it('renders a percentage as a percentage, not as its basis points', async () => {
    detailRoutes(api, discountDetail({ type: 'percentage', value: 1250 }))
    await renderAuthed(<DiscountDetailPage />, route)

    expect(await screen.findByLabelText(/^Percent off/)).toHaveValue(12.5)
  })

  it('sends the percentage back as basis points', async () => {
    const user = userEvent.setup()
    detailRoutes(api).on('PATCH', '/admin/discounts/disc-1', discountDetail({ value: 3000 }))
    await renderAuthed(<DiscountDetailPage />, route)

    const percent = await screen.findByLabelText(/^Percent off/)
    await user.clear(percent)
    await user.type(percent, '30')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => {
      expect(api.callsTo('PATCH', '/admin/discounts/disc-1')).toHaveLength(1)
    })
    expect(api.callsTo('PATCH', '/admin/discounts/disc-1')[0]!.body).toMatchObject({ value: 3000 })
  })

  it('will not save a window that ends before it starts', async () => {
    const user = userEvent.setup()
    detailRoutes(api)
    await renderAuthed(<DiscountDetailPage />, route)

    await user.type(await screen.findByLabelText(/^Starts/), '2026-06-01T10:00')
    await user.type(screen.getByLabelText(/^Ends/), '2026-05-01T10:00')

    expect(await screen.findByText('It has to end after it starts.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
  })

  it('says why a per-customer limit needs an account', async () => {
    const user = userEvent.setup()
    detailRoutes(api)
    await renderAuthed(<DiscountDetailPage />, route)

    await user.type(await screen.findByLabelText(/^Uses per customer/), '2')

    // The server refuses this pairing; the page explains it rather than
    // letting the save come back as a validation error.
    expect(await screen.findByText(/cannot be counted for a guest/)).toBeInTheDocument()
  })

  it('warns when a code has run out, and says how to fix it', async () => {
    detailRoutes(
      api,
      discountDetail({ status: 'exhausted', usageCount: 100, usageLimitTotal: 100 }),
    )
    await renderAuthed(<DiscountDetailPage />, route)

    expect(await screen.findByText('This code has run out')).toBeInTheDocument()
    expect(screen.getByText(/Raise the limit below/)).toBeInTheDocument()
  })

  it('locks an archived discount rather than pretending it can be edited', async () => {
    detailRoutes(
      api,
      discountDetail({ status: 'archived', archivedAt: '2026-03-05T10:00:00.000Z' }),
    )
    await renderAuthed(<DiscountDetailPage />, route)

    expect(await screen.findByText('This discount is archived')).toBeInTheDocument()
    expect(screen.getByLabelText(/^Name/)).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument()
  })

  it('says what archiving costs before doing it', async () => {
    const user = userEvent.setup()
    detailRoutes(api, discountDetail({ usageCount: 12 }))
    await renderAuthed(<DiscountDetailPage />, route)
    await screen.findByRole('heading', { name: 'SUMMER25' })

    await user.click(screen.getByRole('button', { name: 'Archive' }))

    expect(await screen.findByText('Archive SUMMER25?')).toBeInTheDocument()
    expect(screen.getByText(/12 orders that used it keep naming it/)).toBeInTheDocument()
    expect(api.callsTo('DELETE', '/admin/discounts')).toHaveLength(0)
  })

  it('passes a server refusal through in its own words', async () => {
    const user = userEvent.setup()
    api.on('PATCH', '/admin/discounts/disc-1', () =>
      jsonResponse(422, {
        success: false,
        code: 'VALIDATION_FAILED',
        message: 'a discount must end after it starts',
      }),
    )
    detailRoutes(api)
    await renderAuthed(<DiscountDetailPage />, route)

    const title = await screen.findByLabelText(/^Name/)
    await user.clear(title)
    await user.type(title, 'Renamed')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText(/must end after it starts/)).toBeInTheDocument()
  })
})

// ── Scope ───────────────────────────────────────────────────────────────────

describe('DiscountScopeCard', () => {
  const route = { route: '/discounts/disc-1', path: '/discounts/:id' }

  function scopeRoutes(mock: ApiMock, discount = discountDetail()) {
    return baseRoutes(mock)
      .onList('/admin/discounts/disc-1/redemptions', [])
      .on('GET', '/admin/discounts/disc-1', discount)
      .onList('/admin/products', [productSummary({ id: 'prod-1', title: 'Classic Burger' })])
      .on('GET', '/admin/categories', [category({ id: 'cat-1', name: 'Burgers' })])
  }

  it('names the products a scoped discount covers', async () => {
    scopeRoutes(api, discountDetail({ appliesTo: 'products', productIds: ['prod-1'] }))
    await renderAuthed(<DiscountDetailPage />, route)

    // Named, not shown as a uuid: the scope used to be invisible entirely.
    expect(await screen.findByText('Classic Burger')).toBeInTheDocument()
  })

  it('warns that a scoped discount covering nothing applies to nothing', async () => {
    scopeRoutes(api, discountDetail({ appliesTo: 'products', productIds: [] }))
    await renderAuthed(<DiscountDetailPage />, route)

    expect(
      await screen.findByText(/every customer who types it is told it does not apply/),
    ).toBeInTheDocument()
  })

  it('replaces the whole selection rather than sending a diff', async () => {
    const user = userEvent.setup()
    scopeRoutes(api, discountDetail({ appliesTo: 'products', productIds: [] })).on(
      'PATCH',
      '/admin/discounts/disc-1',
      discountDetail({ appliesTo: 'products', productIds: ['prod-1'] }),
    )
    await renderAuthed(<DiscountDetailPage />, route)

    await user.click(await screen.findByRole('button', { name: 'Choose products' }))
    const dialog = within(screen.getByRole('dialog'))
    await user.click(await dialog.findByRole('checkbox'))
    await user.click(dialog.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(api.callsTo('PATCH', '/admin/discounts/disc-1')).toHaveLength(1)
    })
    expect(api.callsTo('PATCH', '/admin/discounts/disc-1')[0]!.body).toEqual({
      productIds: ['prod-1'],
    })
  })

  it('explains that a category scope follows the category, not a list', async () => {
    scopeRoutes(api, discountDetail({ appliesTo: 'categories', categoryIds: ['cat-1'] }))
    await renderAuthed(<DiscountDetailPage />, route)

    expect(await screen.findByText('Burgers')).toBeInTheDocument()
    expect(
      screen.getByText(/adding a product to one of these puts it in the promotion/),
    ).toBeInTheDocument()
  })

  it('offers no picker for an order-wide discount', async () => {
    scopeRoutes(api)
    await renderAuthed(<DiscountDetailPage />, route)

    expect(await screen.findByText(/Every line in the basket/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Choose products' })).not.toBeInTheDocument()
  })
})

// ── The ledger ──────────────────────────────────────────────────────────────

describe('RedemptionsCard', () => {
  const route = { route: '/discounts/disc-1', path: '/discounts/:id' }

  it('says what the code cost, from the server’s total and not a page of rows', async () => {
    baseRoutes(api)
      .on('GET', '/admin/discounts/disc-1/redemptions', () =>
        jsonResponse(200, {
          success: true,
          data: [redemption(), redemption({ id: 'red-2', orderNumber: '#1043' })],
          meta: {
            pagination: {
              page: 1,
              limit: 20,
              total: 40,
              totalPages: 2,
              hasNext: true,
              hasPrev: false,
            },
            // Forty redemptions, of which this page shows two: the total must
            // not be the sum of what is on screen.
            totalAmount: { amount: 20_000, currency: 'GBP' },
          },
        }),
      )
      .on('GET', '/admin/discounts/disc-1', discountDetail({ usageCount: 40 }))
      .onList('/admin/products', [])
      .on('GET', '/admin/categories', [])

    await renderAuthed(<DiscountDetailPage />, route)

    expect(await screen.findByText('£200.00')).toBeInTheDocument()
    expect(screen.getByText(/across 40 orders/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '#1042' })).toHaveAttribute('href', '/orders/ord-1')
  })

  it('calls a guest a guest rather than leaving the row blank', async () => {
    baseRoutes(api)
      .onList('/admin/discounts/disc-1/redemptions', [
        redemption({ customerId: null, customerEmail: null }),
      ])
      .on('GET', '/admin/discounts/disc-1', discountDetail())
      .onList('/admin/products', [])
      .on('GET', '/admin/categories', [])

    await renderAuthed(<DiscountDetailPage />, route)

    expect(await screen.findByText(/A guest/)).toBeInTheDocument()
  })

  it('says plainly when nobody has used the code', async () => {
    baseRoutes(api)
      .onList('/admin/discounts/disc-1/redemptions', [])
      .on('GET', '/admin/discounts/disc-1', discountDetail())
      .onList('/admin/products', [])
      .on('GET', '/admin/categories', [])

    await renderAuthed(<DiscountDetailPage />, route)

    expect(await screen.findByText('Nobody has used this code yet.')).toBeInTheDocument()
  })
})
