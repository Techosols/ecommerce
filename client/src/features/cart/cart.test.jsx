import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { apiMock } from '@/test/apiMock'
import { renderPage } from '@/test/render'
import { cart, cartLine, emptyCart } from '@/test/fixtures'
import { CartPage } from './pages/CartPage'

/**
 * The basket.
 *
 * What these tests defend — each one a way a basket goes quietly wrong:
 *
 *   • **The browser never does the arithmetic.** Changing a quantity re-asks
 *     the server; it does not multiply a unit price by a number on screen. A
 *     test that let the client compute a line total would pass while the till
 *     charged something else.
 *   • **The response is the new state.** Every write returns the whole cart,
 *     re-priced, and the page adopts it rather than patching its own copy.
 *   • **A line that can no longer be bought is said so, and blocks.** Silently
 *     dropping it, or letting checkout fail at the end, are both worse.
 *   • **The cart is never addressed by id.** There is one route, `/cart`, and
 *     the caller is identified by their cookie or session.
 */

let mock

beforeEach(() => {
  mock = apiMock().install()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('CartPage', () => {
  it('shows the server’s line totals and subtotal, computing neither', async () => {
    // Deliberately inconsistent: the "unit price × quantity" a browser would
    // work out is 2300, but the server said 1999 — a promotion, a rounding
    // rule, anything. The screen must show what it was told.
    mock.on('GET', '/storefront/cart', cart({
      lines: [cartLine({ lineTotal: { amount: 1999, currency: 'GBP' } })],
      totals: {
        ...cart().totals,
        subtotal: { amount: 1999, currency: 'GBP' },
      },
    }))

    renderPage(<CartPage />, { route: '/cart' })

    // Twice: once on the line, once in the summary. Both are the server's.
    expect(await screen.findAllByText('£19.99')).toHaveLength(2)
    expect(screen.queryByText('£23.00')).not.toBeInTheDocument()
  })

  it('offers a way back to the shop when the basket is empty', async () => {
    mock.on('GET', '/storefront/cart', emptyCart())

    renderPage(<CartPage />, { route: '/cart' })

    expect(await screen.findByText('Your basket is empty')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Browse the shop' })).toHaveAttribute(
      'href',
      '/products',
    )
  })

  it('asks the server to change a quantity rather than adjusting its own copy', async () => {
    const user = userEvent.setup()
    mock.on('GET', '/storefront/cart', cart())
    mock.on('PATCH', '/storefront/cart/items/var-1', cart({
      lines: [cartLine({ quantity: 3, lineTotal: { amount: 3450, currency: 'GBP' } })],
      totals: { ...cart().totals, subtotal: { amount: 3450, currency: 'GBP' }, itemCount: 3 },
    }))

    renderPage(<CartPage />, { route: '/cart' })
    await screen.findByText('Copperleaf Classic')

    await user.click(screen.getByRole('button', { name: 'One more Copperleaf Classic' }))

    const call = await waitFor(() => {
      const calls = mock.callsTo('PATCH', '/storefront/cart/items/var-1')
      expect(calls).toHaveLength(1)
      return calls[0]
    })
    expect(call.body).toEqual({ quantity: 3 })
    // And the figure on screen is the one that came back, not one derived here.
    expect(await screen.findAllByText('£34.50')).toHaveLength(2)
    expect(screen.getByText('3 items')).toBeInTheDocument()
  })

  it('will not go below one — removal is its own control', async () => {
    // A minus that silently deletes a line is how people lose things they
    // meant to keep.
    mock.on('GET', '/storefront/cart', cart({ lines: [cartLine({ quantity: 1 })] }))

    renderPage(<CartPage />, { route: '/cart' })
    await screen.findByText('Copperleaf Classic')

    expect(screen.getByRole('button', { name: 'One fewer Copperleaf Classic' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Remove Copperleaf Classic' })).toBeEnabled()
  })

  it('removes a line through the server', async () => {
    const user = userEvent.setup()
    mock.on('GET', '/storefront/cart', cart())
    mock.on('DELETE', '/storefront/cart/items/var-1', emptyCart())

    renderPage(<CartPage />, { route: '/cart' })
    await screen.findByText('Copperleaf Classic')

    await user.click(screen.getByRole('button', { name: 'Remove Copperleaf Classic' }))

    expect(await screen.findByText('Your basket is empty')).toBeInTheDocument()
  })

  it('says why a line cannot be bought, in the server’s words', async () => {
    mock.on('GET', '/storefront/cart', cart({
      lines: [cartLine({ purchasable: false, problem: 'Only 1 left.' })],
      purchasable: false,
    }))

    renderPage(<CartPage />, { route: '/cart' })

    expect(await screen.findByText('Only 1 left.')).toBeInTheDocument()
    expect(
      screen.getByText('One item can no longer be bought. Remove it to carry on.'),
    ).toBeInTheDocument()
  })

  it('does not let an unbuyable basket reach checkout', async () => {
    // The server would refuse it anyway. Not offering it is honest; offering
    // it and failing at the till is not.
    mock.on('GET', '/storefront/cart', cart({
      lines: [cartLine({ purchasable: false, problem: 'No longer for sale.' })],
      purchasable: false,
    }))

    renderPage(<CartPage />, { route: '/cart' })
    await screen.findByText('No longer for sale.')

    expect(screen.getByRole('link', { name: 'Go to checkout' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('quotes neither delivery nor tax, and says why', async () => {
    mock.on('GET', '/storefront/cart', cart())

    renderPage(<CartPage />, { route: '/cart' })
    await screen.findByText('Copperleaf Classic')

    const summary = screen.getByText('Summary').closest('aside')
    expect(within(summary).queryByText(/^Delivery$/)).not.toBeInTheDocument()
    expect(within(summary).queryByText(/^Tax$/)).not.toBeInTheDocument()
    expect(
      screen.getByText(/Delivery and tax are worked out at checkout/),
    ).toBeInTheDocument()
  })

  it('surfaces a refused change instead of leaving the screen unchanged', async () => {
    const user = userEvent.setup()
    mock.on('GET', '/storefront/cart', cart())
    mock.onError(
      'PATCH',
      '/storefront/cart/items/var-1',
      422,
      'DOMAIN_RULE_VIOLATION',
      'Only 2 left.',
    )

    renderPage(<CartPage />, { route: '/cart' })
    await screen.findByText('Copperleaf Classic')

    await user.click(screen.getByRole('button', { name: 'One more Copperleaf Classic' }))

    expect(await screen.findByText('Only 2 left.')).toBeInTheDocument()
  })

  it('never addresses the cart by id', async () => {
    mock.on('GET', '/storefront/cart', cart())

    renderPage(<CartPage />, { route: '/cart' })
    await screen.findByText('Copperleaf Classic')

    for (const call of mock.calls) expect(call.url).not.toContain('cart-1')
  })

  it('offers a retry rather than a blank page when the basket fails to load', async () => {
    mock.onError('GET', '/storefront/cart', 500, 'INTERNAL_ERROR', 'Boom')

    renderPage(<CartPage />, { route: '/cart' })

    expect(await screen.findByText('That did not load')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})
