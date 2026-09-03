import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { apiMock } from '@/test/apiMock'
import { renderPage } from '@/test/render'
import { cart, checkoutQuote, order } from '@/test/fixtures'
import { CheckoutPage } from './pages/CheckoutPage'
import { toAddressPayload, validateAddress } from './address'

/**
 * Checkout.
 *
 * What these tests defend:
 *
 *   • **Every figure is the server's.** Delivery, discount, tax and the total
 *     come from `/checkout/preview`, which runs the same code the till runs.
 *     A test that let the browser add anything up would be a test that let the
 *     shopper be shown one number and charged another.
 *   • **The quote is re-asked when the answer would change** — destination,
 *     delivery choice, code, payment method — and *not* when it would not.
 *   • **A refusal is repeated in the server's own words.** "That code has
 *     expired" is actionable; "invalid coupon" is not.
 *   • **Placing is idempotent.** One key per attempt, so a retry after a
 *     dropped connection cannot make a second order.
 */

let mock

beforeEach(() => {
  mock = apiMock().install()
  // Checkout sits inside `AuthProvider` in the real app, and now reads it: the
  // shop can require an account to check out, and this page sends somebody to
  // sign in rather than letting them fill the whole form in and be refused at
  // the end. Every test below renders with `auth: true` and no mocked refresh,
  // which is exactly a guest.
  // Placing mints one with `crypto.randomUUID`; jsdom has it, but pinning it
  // makes "the same key on a retry" something a test can actually assert.
  vi.spyOn(crypto, 'randomUUID').mockReturnValue('11111111-2222-4333-8444-555555555555')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Fills in the minimum a shopper must give before the button does anything. */
async function fillDeliverable(user, { country = 'GB' } = {}) {
  await user.type(screen.getByLabelText(/^Email/), 'shopper@example.test')
  await user.type(screen.getByLabelText(/^First name/), 'Ada')
  await user.type(screen.getByLabelText(/^Last name/), 'Lovelace')
  // The required marker is part of the label's text, so the pattern has to
  // anchor past it — "Address" alone would also match "Address line 2".
  await user.type(screen.getByLabelText(/^Address\*/), '1 Analytical Way')
  await user.type(screen.getByLabelText(/^City/), 'London')
  await user.type(screen.getByLabelText(/^Country/), country)
}

describe('CheckoutPage', () => {
  it('sends people back to the basket rather than checking out nothing', async () => {
    mock.on('GET', '/storefront/cart', cart({ lines: [] }))

    renderPage(<CheckoutPage />, { route: '/checkout', auth: true })

    // Navigate renders nothing, so the absence of the form is the assertion.
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Checkout' })).not.toBeInTheDocument(),
    )
  })

  it('does not quote before there is a country to rate against', async () => {
    const user = userEvent.setup()
    mock.on('GET', '/storefront/cart', cart()).on('GET', '/checkout/preview', checkoutQuote())

    renderPage(<CheckoutPage />, { route: '/checkout', auth: true })
    await screen.findByRole('heading', { name: 'Checkout' })

    await user.type(screen.getByLabelText(/^First name/), 'Ada')

    expect(mock.callsTo('GET', '/checkout/preview')).toHaveLength(0)
    expect(
      screen.getByText('Enter a country above and the delivery options will appear.'),
    ).toBeInTheDocument()
  })

  it('shows the server’s delivery, tax and total — and computes none of them', async () => {
    const user = userEvent.setup()
    mock.on('GET', '/storefront/cart', cart()).on('GET', '/checkout/preview', checkoutQuote())

    renderPage(<CheckoutPage />, { route: '/checkout', auth: true })
    await screen.findByRole('heading', { name: 'Checkout' })
    await fillDeliverable(user)

    const summary = (await screen.findByText('Your order')).closest('aside')
    await waitFor(() => expect(within(summary).getByText('Total')).toBeInTheDocument())

    // 2300 + 395 + 539 = 3234 — but only because the server said so. The page
    // is asserted against the quote, not against that sum.
    expect(within(summary).getByText('£3.95')).toBeInTheDocument()
    expect(within(summary).getByText('£5.39')).toBeInTheDocument()
    expect(within(summary).getByText('£32.34')).toBeInTheDocument()
  })

  it('re-asks the server when the destination changes', async () => {
    const user = userEvent.setup()
    mock.on('GET', '/storefront/cart', cart()).on('GET', '/checkout/preview', checkoutQuote())

    renderPage(<CheckoutPage />, { route: '/checkout', auth: true })
    await screen.findByRole('heading', { name: 'Checkout' })
    await fillDeliverable(user)

    await waitFor(() => {
      expect(mock.callsTo('GET', '/checkout/preview')[0].url).toContain('countryCode=GB')
    })

    await user.clear(screen.getByLabelText(/^Country/))
    await user.type(screen.getByLabelText(/^Country/), 'FR')

    await waitFor(() => {
      expect(mock.callsTo('GET', '/checkout/preview').at(-1).url).toContain('countryCode=FR')
    })
  })

  it('does not re-ask for something that cannot change the price', async () => {
    const user = userEvent.setup()
    mock.on('GET', '/storefront/cart', cart()).on('GET', '/checkout/preview', checkoutQuote())

    renderPage(<CheckoutPage />, { route: '/checkout', auth: true })
    await screen.findByRole('heading', { name: 'Checkout' })
    await fillDeliverable(user)
    await waitFor(() => expect(mock.callsTo('GET', '/checkout/preview').length).toBeGreaterThan(0))

    const before = mock.callsTo('GET', '/checkout/preview').length
    // A street does not change what delivery costs. Re-rating on every
    // keystroke of an address would be a request per character.
    await user.type(screen.getByLabelText(/^Address line 2/), 'Second floor')

    expect(mock.callsTo('GET', '/checkout/preview')).toHaveLength(before)
  })

  it('adopts the delivery option the server pre-selected, and sends a change back', async () => {
    const user = userEvent.setup()
    mock.on('GET', '/storefront/cart', cart()).on('GET', '/checkout/preview', checkoutQuote())

    renderPage(<CheckoutPage />, { route: '/checkout', auth: true })
    await screen.findByRole('heading', { name: 'Checkout' })
    await fillDeliverable(user)

    const standard = await screen.findByRole('radio', { name: /Standard delivery/ })
    expect(standard).toBeChecked()

    await user.click(screen.getByRole('radio', { name: /Next day/ }))

    await waitFor(() => {
      expect(mock.callsTo('GET', '/checkout/preview').at(-1).url).toContain(
        'shippingMethodId=ship-express',
      )
    })
  })

  it('says plainly when nothing can be delivered to the address', async () => {
    const user = userEvent.setup()
    mock
      .on('GET', '/storefront/cart', cart())
      .on('GET', '/checkout/preview', checkoutQuote({ shippingOptions: [], purchasable: false }))

    renderPage(<CheckoutPage />, { route: '/checkout', auth: true })
    await screen.findByRole('heading', { name: 'Checkout' })
    await fillDeliverable(user, { country: 'AQ' })

    expect(await screen.findByText(/We do not deliver to AQ at the moment/)).toBeInTheDocument()
    // And the button is not offered, because the server would refuse it.
    expect(screen.getByRole('button', { name: 'Place order' })).toBeDisabled()
  })

  it('repeats a refused discount code in the server’s own words', async () => {
    const user = userEvent.setup()
    mock.on('GET', '/storefront/cart', cart()).on('GET', '/checkout/preview', ({ url }) =>
      url.includes('discountCode=NOTACODE')
        ? new Response(
            JSON.stringify({
              success: false,
              code: 'DOMAIN_RULE_VIOLATION',
              message: 'That code has expired.',
            }),
            { status: 422, headers: { 'content-type': 'application/json' } },
          )
        : new Response(JSON.stringify({ success: true, data: checkoutQuote() }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
    )

    renderPage(<CheckoutPage />, { route: '/checkout', auth: true })
    await screen.findByRole('heading', { name: 'Checkout' })
    await fillDeliverable(user)
    await screen.findByRole('radio', { name: /Standard delivery/ })

    await user.type(screen.getByLabelText('Discount code'), 'NOTACODE')
    await user.click(screen.getByRole('button', { name: 'Apply' }))

    expect(await screen.findByText('That code has expired.')).toBeInTheDocument()
  })

  it('will not place an order with a missing address, and says which field', async () => {
    const user = userEvent.setup()
    mock.on('GET', '/storefront/cart', cart()).on('GET', '/checkout/preview', checkoutQuote())

    renderPage(<CheckoutPage />, { route: '/checkout', auth: true })
    await screen.findByRole('heading', { name: 'Checkout' })
    // Enough for a quote, not enough to post to.
    await user.type(screen.getByLabelText(/^Country/), 'GB')
    await screen.findByRole('radio', { name: /Standard delivery/ })

    await user.click(screen.getByRole('button', { name: 'Place order' }))

    expect(await screen.findAllByText('Required.')).not.toHaveLength(0)
    expect(mock.callsTo('POST', '/storefront/checkout')).toHaveLength(0)
  })

  it('places the order with the server’s choices, and one idempotency key', async () => {
    const user = userEvent.setup()
    mock
      .on('GET', '/storefront/cart', cart())
      .on('GET', '/checkout/preview', checkoutQuote())
      .on('POST', '/storefront/checkout', order())

    renderPage(<CheckoutPage />, { route: '/checkout', auth: true })
    await screen.findByRole('heading', { name: 'Checkout' })
    await fillDeliverable(user)
    await screen.findByRole('radio', { name: /Standard delivery/ })

    await user.click(screen.getByRole('button', { name: 'Place order' }))

    const call = await waitFor(() => {
      const calls = mock.callsTo('POST', '/storefront/checkout')
      expect(calls).toHaveLength(1)
      return calls[0]
    })
    expect(call.body.email).toBe('shopper@example.test')
    // The delivery option is the one the server selected, sent back by id —
    // not a price, and not a name.
    expect(call.body.shippingMethodId).toBe('ship-standard')
    expect(call.body.paymentMethod).toBe('card')
    expect(call.body.shippingAddress.countryCode).toBe('GB')
    // Blank optionals go as null, never as "".
    expect(call.body.shippingAddress.company).toBeNull()
    // No total, no tax, no line prices: the server prices the order.
    expect(call.body).not.toHaveProperty('total')
    expect(call.body).not.toHaveProperty('lines')
    expect(call.headers['idempotency-key']).toBe('11111111-2222-4333-8444-555555555555')
  })

  it('shows a refused checkout rather than silently doing nothing', async () => {
    const user = userEvent.setup()
    mock
      .on('GET', '/storefront/cart', cart())
      .on('GET', '/checkout/preview', checkoutQuote())
      .onError(
        'POST',
        '/storefront/checkout',
        422,
        'DOMAIN_RULE_VIOLATION',
        'Copperleaf Classic sold out while you were checking out.',
      )

    renderPage(<CheckoutPage />, { route: '/checkout', auth: true })
    await screen.findByRole('heading', { name: 'Checkout' })
    await fillDeliverable(user)
    await screen.findByRole('radio', { name: /Standard delivery/ })

    await user.click(screen.getByRole('button', { name: 'Place order' }))

    expect(
      await screen.findByText('Copperleaf Classic sold out while you were checking out.'),
    ).toBeInTheDocument()
  })
})

// ── The address helpers ─────────────────────────────────────────────────────

describe('address', () => {
  it('turns blanks into null, because "" prints on a label', () => {
    const payload = toAddressPayload(
      {
        firstName: ' Ada ',
        lastName: 'Lovelace',
        company: '   ',
        line1: '1 Analytical Way',
        line2: '',
        city: 'London',
        region: '',
        postalCode: 'E1 1AA',
        countryCode: 'gb',
      },
      '',
    )

    expect(payload).toEqual({
      firstName: 'Ada',
      lastName: 'Lovelace',
      company: null,
      line1: '1 Analytical Way',
      line2: null,
      city: 'London',
      region: null,
      postalCode: 'E1 1AA',
      countryCode: 'GB',
      phone: null,
    })
  })

  it('asks for exactly what the server’s schema requires, and no more', () => {
    const errors = validateAddress({
      firstName: '',
      lastName: '',
      company: '',
      line1: '',
      line2: '',
      city: '',
      region: '',
      postalCode: '',
      countryCode: 'GBR',
    })

    expect(Object.keys(errors).sort()).toEqual([
      'city',
      'countryCode',
      'firstName',
      'lastName',
      'line1',
    ])
    // A postcode is not required: much of the world does not have one.
    expect(errors.postalCode).toBeUndefined()
  })
})
