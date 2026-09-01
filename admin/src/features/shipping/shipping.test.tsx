import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { tokenStore } from '@/lib/api/tokenStore'
import { apiMock, type ApiMock } from '@/test/api-mock'
import { jsonResponse } from '@/test/http'
import { renderAuthed } from '@/test/renderAuthed'
import { adminUser, rateQuote, shippingMethod, shippingZone } from '@/test/catalogue'
import { ShippingPage } from './pages/ShippingPage'
import { describeMethod } from './components/methodLabels'

/**
 * The rate card.
 *
 * Three things worth holding down, because each is a way a delivery screen
 * misleads the person configuring it:
 *
 *   • **A zone with no methods ships nothing.** That is a silent failure on the
 *     storefront, so it is said out loud here.
 *   • **The preview is the real quote.** It calls the storefront endpoint, so
 *     what it shows is what a shopper is offered — including nothing at all.
 *   • **A method is retired, not deleted.** Orders name the method they were
 *     shipped by.
 */

let api: ApiMock

function baseRoutes(mock: ApiMock, user = adminUser) {
  return mock
    .withSession(user)
    .on('GET', '/storefront/settings', { currency: 'GBP', storeName: 'Test' })
    .on('GET', '/admin/notifications/unread-count', { count: 0 })
    .on('GET', '/storefront/shipping/rates', [rateQuote()])
}

/** Specific before prefix: `/admin/shipping/zones` would swallow the id route. */
function rateCard(
  mock: ApiMock,
  zones = [shippingZone()],
  methods = [shippingMethod()],
  user = adminUser,
) {
  return baseRoutes(mock, user)
    .on('GET', '/admin/shipping/methods', methods)
    .on('GET', '/admin/shipping/zones', zones)
}

beforeEach(() => {
  api = apiMock().install()
  tokenStore.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  tokenStore.clear()
})

// ── The one-line summary ────────────────────────────────────────────────────

describe('describeMethod', () => {
  it('writes the whole rule in order: price, threshold, band, estimate', () => {
    expect(
      describeMethod(
        shippingMethod({
          priceCents: 499,
          freeOverSubtotalCents: 5000,
          minWeightGrams: 0,
          maxWeightGrams: 2000,
        }),
        'GBP',
      ),
    ).toBe('£4.99 · free over £50.00 · 0–2 kg · 2–4 days')
  })

  it('says per kg, because the price means something different then', () => {
    expect(
      describeMethod(
        shippingMethod({ rateType: 'weight_based', priceCents: 250, estimatedDaysMin: null }),
        'GBP',
      ),
    ).toBe('£2.50 per kg')
  })

  it('leaves an open-ended band open', () => {
    expect(
      describeMethod(
        shippingMethod({
          rateType: 'free',
          minWeightGrams: 2000,
          maxWeightGrams: null,
          estimatedDaysMin: null,
        }),
        'GBP',
      ),
    ).toBe('Free · 2–∞ kg')
  })
})

// ── The screen ──────────────────────────────────────────────────────────────

describe('ShippingPage', () => {
  it('nests methods under the zone they apply to', async () => {
    rateCard(api)
    await renderAuthed(<ShippingPage />, { route: '/shipping' })

    expect(await screen.findByText('United Kingdom')).toBeInTheDocument()
    // Scoped: the preview beside it quotes a method of the same name, which is
    // the point of the preview.
    expect(screen.getByText(/£4.99 · 2–4 days/)).toBeInTheDocument()
  })

  it('says outright that a zone with no methods ships nothing', async () => {
    rateCard(api, [shippingZone()], [])
    await renderAuthed(<ShippingPage />, { route: '/shipping' })

    expect(
      await screen.findByText(/No methods here, so nothing can be shipped to GB/),
    ).toBeInTheDocument()
  })

  it('warns that an empty rate card refuses every order that needs shipping', async () => {
    rateCard(api, [], [])
    await renderAuthed(<ShippingPage />, { route: '/shipping' })

    expect(await screen.findByText('No delivery zones yet')).toBeInTheDocument()
    expect(screen.getByText(/checkout will refuse every order that needs shipping/)).toBeInTheDocument()
  })

  it('previews with the real storefront quote, not arithmetic of its own', async () => {
    rateCard(api)
    await renderAuthed(<ShippingPage />, { route: '/shipping' })

    await waitFor(() => {
      expect(api.callsTo('GET', '/storefront/shipping/rates')).toHaveLength(1)
    })
    const url = api.callsTo('GET', '/storefront/shipping/rates')[0]!.url
    expect(url).toContain('countryCode=GB')
    expect(url).toContain('subtotalCents=5000')
    expect(url).toContain('weightGrams=1000')
  })

  it('says plainly when a destination is quoted nothing at all', async () => {
    // The empty quote is the interesting one: a country covered by no zone, or
    // a basket outside every weight band, ships nowhere — and the storefront
    // simply tells the shopper the store does not deliver to them.
    api
      .withSession(adminUser)
      .on('GET', '/storefront/settings', { currency: 'GBP', storeName: 'Test' })
      .on('GET', '/admin/notifications/unread-count', { count: 0 })
      .on('GET', '/storefront/shipping/rates', [])
      .on('GET', '/admin/shipping/methods', [shippingMethod()])
      .on('GET', '/admin/shipping/zones', [shippingZone()])

    await renderAuthed(<ShippingPage />, { route: '/shipping' })

    expect(await screen.findByText(/Nothing is offered to GB/)).toBeInTheDocument()
  })

  it('refuses to create a zone with no countries', async () => {
    const user = userEvent.setup()
    rateCard(api)
    await renderAuthed(<ShippingPage />, { route: '/shipping' })
    await screen.findByText('United Kingdom')

    await user.click(screen.getByRole('button', { name: 'New zone' }))
    await user.type(screen.getByLabelText(/^Name/), 'Europe')

    // A zone covering nothing quotes nobody; `isActive: false` is how you
    // switch one off.
    expect(screen.getByRole('button', { name: 'Create zone' })).toBeDisabled()
  })

  it('passes the overlap refusal through in the server’s own words', async () => {
    const user = userEvent.setup()
    rateCard(api)
    api.on('POST', '/admin/shipping/zones', () =>
      jsonResponse(422, {
        success: false,
        code: 'DOMAIN_RULE_VIOLATION',
        message: 'GB is already covered by the zone "United Kingdom".',
      }),
    )

    await renderAuthed(<ShippingPage />, { route: '/shipping' })
    await screen.findByText('United Kingdom')

    await user.click(screen.getByRole('button', { name: 'New zone' }))
    const dialog = within(screen.getByRole('dialog'))
    await user.type(dialog.getByLabelText(/^Name/), 'Britain')
    await user.type(dialog.getByRole('textbox', { name: /countries/i }), 'GB,')
    await user.click(dialog.getByRole('button', { name: 'Create zone' }))

    // Named, so the operator knows which zone to change.
    expect(await screen.findByText(/already covered by the zone "United Kingdom"/)).toBeInTheDocument()
  })

  it('says what archiving a zone does, and does nothing until confirmed', async () => {
    const user = userEvent.setup()
    rateCard(api)
    await renderAuthed(<ShippingPage />, { route: '/shipping' })
    await screen.findByText('United Kingdom')

    await user.click(screen.getByRole('button', { name: /Archive/ }))

    expect(await screen.findByText('Archive "United Kingdom"?')).toBeInTheDocument()
    expect(screen.getByText(/Its\s+methods are kept/)).toBeInTheDocument()
    expect(api.callsTo('DELETE', '/admin/shipping/zones')).toHaveLength(0)
  })

  it('says a removed method is retired rather than deleted', async () => {
    const user = userEvent.setup()
    rateCard(api)
    await renderAuthed(<ShippingPage />, { route: '/shipping' })
    await screen.findByRole('button', { name: 'Add a method' })

    await user.click(screen.getByRole('button', { name: 'Remove' }))

    expect(await screen.findByText('Remove Standard?')).toBeInTheDocument()
    expect(screen.getByText(/keep naming it/)).toBeInTheDocument()
  })

  it('hides every write from an operator who cannot make one', async () => {
    // Holds `shipping:read` and not `shipping:write`: the rate card is a
    // commercial arrangement staff may look at without changing.
    const readOnly = {
      ...adminUser,
      permissions: adminUser.permissions.filter((p) => p !== 'shipping:write'),
    }
    rateCard(api, [shippingZone()], [shippingMethod()], readOnly)
    await renderAuthed(<ShippingPage />, { route: '/shipping' })

    await screen.findByText('United Kingdom')
    expect(screen.queryByRole('button', { name: 'New zone' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit zone' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add a method' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
  })
})

// ── The method dialog ───────────────────────────────────────────────────────

describe('MethodDialog', () => {
  async function openNewMethod() {
    const user = userEvent.setup()
    rateCard(api)
    await renderAuthed(<ShippingPage />, { route: '/shipping' })
    await screen.findByText('United Kingdom')
    await user.click(screen.getByRole('button', { name: 'Add a method' }))
    return user
  }

  it('sends weights in grams, whatever the field is labelled in', async () => {
    const user = await openNewMethod()
    api.on('POST', '/admin/shipping/methods', shippingMethod({ id: 'method-2' }))

    await user.type(screen.getByLabelText(/^To, in kilograms/), '2')
    await user.click(screen.getByRole('button', { name: 'Add method' }))

    await waitFor(() => {
      expect(api.callsTo('POST', '/admin/shipping/methods')).toHaveLength(1)
    })
    expect(api.callsTo('POST', '/admin/shipping/methods')[0]!.body).toMatchObject({
      zoneId: 'zone-1',
      maxWeightGrams: 2000,
    })
  })

  it('refuses a band that excludes every parcel', async () => {
    const user = await openNewMethod()

    await user.type(screen.getByLabelText(/^From, in kilograms/), '5')
    await user.type(screen.getByLabelText(/^To, in kilograms/), '1')

    expect(await screen.findByText('The lightest is heavier than the heaviest.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add method' })).toBeDisabled()
  })

  it('explains that a band withdraws the method rather than pricing it', async () => {
    const user = await openNewMethod()

    await user.type(screen.getByLabelText(/^To, in kilograms/), '2')

    expect(
      await screen.findByText(/is not offered this method at all/),
    ).toBeInTheDocument()
  })

  it('sends no price at all for a free method', async () => {
    const user = await openNewMethod()
    api.on('POST', '/admin/shipping/methods', shippingMethod({ id: 'method-2' }))

    await user.selectOptions(screen.getByLabelText('Charged as'), 'free')
    expect(screen.getByText(/Nothing is charged/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add method' }))

    await waitFor(() => {
      expect(api.callsTo('POST', '/admin/shipping/methods')).toHaveLength(1)
    })
    expect(api.callsTo('POST', '/admin/shipping/methods')[0]!.body).toMatchObject({
      rateType: 'free',
      priceCents: 0,
      freeOverSubtotalCents: null,
    })
  })

  it('says what a per-kilogram price means before it is set', async () => {
    const user = await openNewMethod()

    await user.selectOptions(screen.getByLabelText('Charged as'), 'weight_based')

    expect(await screen.findByText(/started kilogram/)).toBeInTheDocument()
    expect(screen.getByLabelText(/^Price per kilogram/)).toBeInTheDocument()
  })
})
