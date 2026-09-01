import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { tokenStore } from '@/lib/api/tokenStore'
import { apiMock, type ApiMock } from '@/test/api-mock'
import { jsonResponse } from '@/test/http'
import { renderAuthed } from '@/test/renderAuthed'
import {
  adminUser,
  defaultPagination,
  draftDetail,
  draftSummary,
  orderDetail,
  staffUser,
  variantMatch,
} from '@/test/catalogue'
import { DraftBuilderPage } from './pages/DraftBuilderPage'
import { DraftListPage } from './pages/DraftListPage'
import { addressLine, deliveryEstimate, draftState, draftTitle, isReady } from './components/draftLabels'

/**
 * Orders staff build by hand.
 *
 * What these tests defend, all four of which are ways the screen could look
 * right while being wrong:
 *
 *   • **The admin computes no money.** Every figure is rendered from the
 *     server's quote. A test that asserts a total is asserting that the screen
 *     showed what it was told, never that it added correctly.
 *   • **Readiness is the server's answer.** Blockers are shown verbatim and
 *     the place button follows them — there is no second rule here that could
 *     let through an order checkout would refuse.
 *   • **Lines are sent whole.** Changing a quantity sends the entire list, so
 *     nothing can quietly go missing.
 *   • **A placed draft is a record.** It stops being editable and points at
 *     the order it became.
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

describe('draft labels', () => {
  it('calls a draft placed only once it points at an order', () => {
    expect(draftState({ placedOrderId: null }).label).toBe('Being built')
    expect(draftState({ placedOrderId: 'ord-1' }).label).toBe('Placed')
  })

  it('takes readiness from the server, and never from a placed draft', () => {
    expect(isReady(draftDetail())).toBe(true)
    expect(isReady(draftDetail({ blockers: ['Add a delivery address.'] }))).toBe(false)
    // Already placed: ready is not the question any more.
    expect(isReady(draftDetail({ placedOrderId: 'ord-1' }))).toBe(false)
  })

  it('writes an address as one line, skipping what is not there', () => {
    const line = addressLine(draftDetail().addresses[0]!)
    expect(line).toBe('Ada Lovelace, 1 Analytical Way, London, E1 1AA, GB')
  })

  it('says how long delivery takes, or nothing at all', () => {
    const option = draftDetail().shippingOptions[0]!
    expect(deliveryEstimate(option)).toBe('2–4 days')
    expect(deliveryEstimate({ ...option, estimatedDaysMin: 1, estimatedDaysMax: 1 })).toBe('1 day')
    expect(deliveryEstimate({ ...option, estimatedDaysMin: null, estimatedDaysMax: null })).toBeNull()
  })

  it('falls back to the reference when there is no email yet', () => {
    expect(draftTitle({ email: 'phone@example.test', reference: 'DRAFT-1' })).toBe(
      'phone@example.test',
    )
    expect(draftTitle({ email: null, reference: 'DRAFT-1' })).toBe('DRAFT-1')
  })
})

// ── The list ────────────────────────────────────────────────────────────────

describe('DraftListPage', () => {
  function listRoutes(mock: ApiMock, rows = [draftSummary()], user = adminUser) {
    return baseRoutes(mock, user).on('GET', '/admin/drafts', () =>
      jsonResponse(200, {
        success: true,
        data: rows,
        meta: { pagination: { ...defaultPagination, total: rows.length } },
      }),
    )
  }

  it('shows a draft by its placeholder reference and what is on it', async () => {
    listRoutes(api)
    await renderAuthed(<DraftListPage />, { route: '/drafts' })

    const row = within(await screen.findByRole('row', { name: /DRAFT-AB12CD/ }))
    expect(row.getByText('£45.00')).toBeInTheDocument()
    expect(row.getByText('Being built')).toBeInTheDocument()
  })

  it('marks one that has become an order', async () => {
    listRoutes(api, [draftSummary({ placedOrderId: 'ord-9' })])
    await renderAuthed(<DraftListPage />, { route: '/drafts' })

    expect(await screen.findByText('Placed')).toBeInTheDocument()
  })

  it('sends the search to the server rather than filtering here', async () => {
    const user = userEvent.setup()
    listRoutes(api)
    await renderAuthed(<DraftListPage />, { route: '/drafts' })
    await screen.findByText('DRAFT-AB12CD')

    await user.type(screen.getByLabelText('Search drafts'), 'ada')

    await waitFor(() => {
      expect(api.callsTo('GET', '/admin/drafts').at(-1)!.url).toContain('q=ada')
    })
  })

  it('explains what a draft is when there are none', async () => {
    listRoutes(api, [])
    await renderAuthed(<DraftListPage />, { route: '/drafts' })

    expect(await screen.findByText('No drafts')).toBeInTheDocument()
    expect(screen.getByText(/reserves no stock until you place it/)).toBeInTheDocument()
  })

  it('offers no way to start one without permission to write', async () => {
    // Staff here hold `orders:read` only. The server would refuse anyway; the
    // screen not offering the button is the courtesy.
    listRoutes(api, [draftSummary()], staffUser)
    await renderAuthed(<DraftListPage />, { route: '/drafts' })

    await screen.findByText('DRAFT-AB12CD')
    expect(screen.queryByRole('button', { name: /New draft/ })).not.toBeInTheDocument()
  })
})

// ── The builder ─────────────────────────────────────────────────────────────

describe('DraftBuilderPage', () => {
  const route = { route: '/drafts/draft-1', path: '/drafts/:id' }

  function builderRoutes(mock: ApiMock, draft = draftDetail(), user = adminUser) {
    return baseRoutes(mock, user).on('GET', '/admin/drafts/draft-1', draft)
  }

  it('shows the totals the server quoted, and adds nothing up itself', async () => {
    // The fixture's total is deliberately not the sum a careless screen would
    // compute — it is what the server said, which is what must appear.
    builderRoutes(api)
    await renderAuthed(<DraftBuilderPage />, route)

    expect(await screen.findByText('£54.49')).toBeInTheDocument()
    expect(screen.getByText('£4.99')).toBeInTheDocument()
    expect(screen.getByText('£4.50')).toBeInTheDocument()
  })

  it('lists the blockers in the server’s own words and refuses to place', async () => {
    builderRoutes(
      api,
      draftDetail({ blockers: ['Add an email address to send the order to.'], email: null }),
    )
    await renderAuthed(<DraftBuilderPage />, route)

    expect(await screen.findByText('Add an email address to send the order to.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Place the order/ })).toBeDisabled()
  })

  it('sends the whole line list when a quantity changes', async () => {
    const user = userEvent.setup()
    builderRoutes(api).on('PUT', '/admin/drafts/draft-1/lines', draftDetail())
    await renderAuthed(<DraftBuilderPage />, route)

    await user.click(await screen.findByRole('button', { name: /One more Classic Burger/ }))

    await waitFor(() => {
      const call = api.callsTo('PUT', '/admin/drafts/draft-1/lines').at(-1)!
      expect(call.body).toEqual({
        lines: [{ variantId: 'var-1', quantity: 4 }],
      })
    })
  })

  it('adds a searched product as a new line beside the existing ones', async () => {
    const user = userEvent.setup()
    builderRoutes(api)
      .on('GET', '/admin/drafts/variant-search', [variantMatch()])
      .on('PUT', '/admin/drafts/draft-1/lines', draftDetail())
    await renderAuthed(<DraftBuilderPage />, route)

    await user.click(await screen.findByRole('button', { name: /Add a product/ }))
    await user.type(screen.getByLabelText('Search products'), 'wrap')
    await user.click(await screen.findByText('Halloumi Wrap'))

    await waitFor(() => {
      const call = api.callsTo('PUT', '/admin/drafts/draft-1/lines').at(-1)!
      expect(call.body).toEqual({
        lines: [
          { variantId: 'var-1', quantity: 3 },
          { variantId: 'var-2', quantity: 1 },
        ],
      })
    })
  })

  it('says why a line cannot be bought instead of quietly pricing it', async () => {
    builderRoutes(
      api,
      draftDetail({
        purchasable: false,
        blockers: ['Some lines cannot be bought — Classic Burger: Out of stock'],
        lines: [
          {
            ...draftDetail().lines[0]!,
            purchasable: false,
            problem: 'Out of stock',
          },
        ],
      }),
    )
    await renderAuthed(<DraftBuilderPage />, route)

    expect(await screen.findByText('Out of stock')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Place the order/ })).toBeDisabled()
  })

  it('offers the delivery options the server rated for this address', async () => {
    builderRoutes(api)
    await renderAuthed(<DraftBuilderPage />, route)

    const select = (await screen.findByLabelText('Delivery'))
    expect(within(select).getByText('Standard — £4.99 — 2–4 days')).toBeInTheDocument()
  })

  it('says delivery cannot be rated until there is an address', async () => {
    builderRoutes(
      api,
      draftDetail({ addresses: [], shippingOptions: [], blockers: ['Add a delivery address.'] }),
    )
    await renderAuthed(<DraftBuilderPage />, route)

    expect(await screen.findByText(/Delivery is rated against the address/)).toBeInTheDocument()
  })

  it('offers staff the manual method, which no shopper may pick', async () => {
    builderRoutes(api)
    await renderAuthed(<DraftBuilderPage />, route)

    const select = (await screen.findByLabelText('Payment'))
    expect(within(select).getByText('Recorded by staff')).toBeInTheDocument()
    expect(within(select).getByText('Cash on delivery (+£2.00)')).toBeInTheDocument()
  })

  it('sends a discount code for the server to judge', async () => {
    const user = userEvent.setup()
    builderRoutes(api).on('PATCH', '/admin/drafts/draft-1', draftDetail())
    await renderAuthed(<DraftBuilderPage />, route)

    await user.type(await screen.findByLabelText(/^Discount code/), 'SAVE10')
    await user.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => {
      const call = api.callsTo('PATCH', '/admin/drafts/draft-1').at(-1)!
      expect(call.body).toEqual({ discountCode: 'SAVE10' })
    })
  })

  it('places the order and goes to it', async () => {
    const user = userEvent.setup()
    builderRoutes(api).on('POST', '/admin/drafts/draft-1/place', () =>
      jsonResponse(201, { success: true, data: orderDetail({ id: 'ord-7', orderNumber: 'ORD-7' }) }),
    )
    await renderAuthed(<DraftBuilderPage />, route)

    await user.click(await screen.findByRole('button', { name: /Place the order/ }))

    expect(await screen.findByText(/Order ORD-7 placed/)).toBeInTheDocument()
  })

  it('sends an idempotency key, so a double click cannot reserve twice', async () => {
    const user = userEvent.setup()
    builderRoutes(api).on('POST', '/admin/drafts/draft-1/place', () =>
      jsonResponse(201, { success: true, data: orderDetail() }),
    )
    await renderAuthed(<DraftBuilderPage />, route)

    await user.click(await screen.findByRole('button', { name: /Place the order/ }))

    await waitFor(() => {
      const call = api.callsTo('POST', '/admin/drafts/draft-1/place').at(-1)!
      expect(call.headers['idempotency-key']).toBeTruthy()
    })
  })

  it('reports the server’s refusal rather than a generic failure', async () => {
    const user = userEvent.setup()
    builderRoutes(api).on('POST', '/admin/drafts/draft-1/place', () =>
      jsonResponse(422, {
        success: false,
        code: 'DOMAIN_RULE_VIOLATION',
        message: 'This order is above the maximum for cash on delivery',
      }),
    )
    await renderAuthed(<DraftBuilderPage />, route)

    await user.click(await screen.findByRole('button', { name: /Place the order/ }))

    expect(
      await screen.findByText('This order is above the maximum for cash on delivery'),
    ).toBeInTheDocument()
  })

  it('turns into a record once it has been placed', async () => {
    builderRoutes(api, draftDetail({ placedOrderId: 'ord-9' }))
    await renderAuthed(<DraftBuilderPage />, route)

    // Twice over: the badge in the header and the summary card's own title.
    expect((await screen.findAllByText('Placed')).length).toBeGreaterThan(0)
    expect(screen.getByRole('link', { name: /Open the order/ })).toHaveAttribute(
      'href',
      '/orders/ord-9',
    )
    expect(screen.queryByRole('button', { name: /Place the order/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Add a product/ })).not.toBeInTheDocument()
  })

  it('asks before discarding, because the quote is gone for good', async () => {
    const user = userEvent.setup()
    builderRoutes(api).on('DELETE', '/admin/drafts/draft-1', () => jsonResponse(204, null))
    await renderAuthed(<DraftBuilderPage />, route)

    await user.click(await screen.findByRole('button', { name: 'Discard' }))

    expect(await screen.findByText('Discard this draft?')).toBeInTheDocument()
    expect(api.callsTo('DELETE', '/admin/drafts/draft-1')).toHaveLength(0)

    // Two buttons now read "Discard" — the one on the page and the one in the
    // dialog. The dialog's is the last rendered.
    await user.click(screen.getAllByRole('button', { name: 'Discard' }).at(-1)!)

    await waitFor(() => {
      expect(api.callsTo('DELETE', '/admin/drafts/draft-1')).toHaveLength(1)
    })
  })

  it('shows a read-only draft to somebody who may only look', async () => {
    builderRoutes(api, draftDetail(), staffUser)
    await renderAuthed(<DraftBuilderPage />, route)

    await screen.findByText('phone@example.test')
    expect(screen.queryByRole('button', { name: /Add a product/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Discard' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Place the order/ })).toBeDisabled()
  })
})
