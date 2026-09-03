import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { apiMock } from '@/test/apiMock'
import { renderPage } from '@/test/render'
import { order, returnable } from '@/test/fixtures'
import { OrderLookupPage } from './pages/OrderLookupPage'

/**
 * A guest, holding only their order number and email.
 *
 * Most of this shop's orders are guest orders, and until now the people who
 * placed them got a page they could only read: to stop an order nobody had
 * packed, or send something back, they had to email and wait.
 *
 * The credential is the pair the confirmation gave them, and it is the same
 * pair the lookup already trusts. What these tests defend is that the controls
 * appear on the same terms as the signed-in ones, and that nothing destructive
 * happens on one click.
 */

let mock

beforeEach(() => {
  mock = apiMock().install()
})
afterEach(cleanup)

/** Finds an order, the way somebody arriving with a confirmation email does. */
async function findOrder(user, found) {
  mock.on('POST', '/storefront/orders/lookup', found)

  renderPage(<OrderLookupPage />, { route: '/orders/lookup', auth: true })

  await user.type(await screen.findByLabelText(/Order number/), '#1001')
  await user.type(screen.getByLabelText(/^Email/), 'shopper@example.test')
  await user.click(screen.getByRole('button', { name: /Find it/ }))

  return screen.findByRole('heading', { name: /Order #1001/ })
}

describe('cancelling', () => {
  it('is offered while the order is still being prepared', async () => {
    const user = userEvent.setup()
    await findOrder(user, order({ status: 'pending' }))

    expect(screen.getByRole('button', { name: /Cancel this order/ })).toBeInTheDocument()
  })

  it('is not offered once it is on its way', async () => {
    // Offering it past that point would be a promise the server refuses.
    const user = userEvent.setup()
    await findOrder(user, order({ status: 'shipped' }))

    expect(screen.queryByRole('button', { name: /Cancel this order/ })).not.toBeInTheDocument()
  })

  it('asks before doing it', async () => {
    // Cancelling releases the stock and cannot be undone from here — the
    // shopper would have to order again.
    const user = userEvent.setup()
    await findOrder(user, order({ status: 'pending' }))

    await user.click(screen.getByRole('button', { name: /Cancel this order/ }))

    expect(screen.getByRole('button', { name: /Yes, cancel it/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Keep the order/ })).toBeInTheDocument()
    expect(mock.callsTo('POST', '/orders/lookup/cancel')).toHaveLength(0)
  })

  it('sends the same credential the lookup used', async () => {
    const user = userEvent.setup()
    mock.on('POST', '/storefront/orders/lookup/cancel', order({ status: 'cancelled' }))
    await findOrder(user, order({ status: 'pending' }))

    await user.click(screen.getByRole('button', { name: /Cancel this order/ }))
    await user.click(screen.getByRole('button', { name: /Yes, cancel it/ }))

    await waitFor(() => {
      expect(mock.callsTo('POST', '/orders/lookup/cancel')[0].body).toEqual({
        orderNumber: '#1001',
        email: 'shopper@example.test',
      })
    })
  })

  it('shows the cancelled order once it is done', async () => {
    const user = userEvent.setup()
    mock.on(
      'POST',
      '/storefront/orders/lookup/cancel',
      order({ status: 'cancelled', cancelReason: 'Cancelled by the customer' }),
    )
    await findOrder(user, order({ status: 'pending' }))

    await user.click(screen.getByRole('button', { name: /Cancel this order/ }))
    await user.click(screen.getByRole('button', { name: /Yes, cancel it/ }))

    expect(await screen.findByText(/This order was cancelled/)).toBeInTheDocument()
  })

  it('repeats the server’s refusal in its own words', async () => {
    // "Something has already shipped" tells them what to do next; "could not
    // cancel" does not.
    const user = userEvent.setup()
    mock.onError(
      'POST',
      '/storefront/orders/lookup/cancel',
      422,
      'DOMAIN_RULE_VIOLATION',
      'Part of this order has already shipped',
    )
    await findOrder(user, order({ status: 'pending' }))

    await user.click(screen.getByRole('button', { name: /Cancel this order/ }))
    await user.click(screen.getByRole('button', { name: /Yes, cancel it/ }))

    expect(await screen.findByText('Part of this order has already shipped')).toBeInTheDocument()
  })
})

describe('returning', () => {
  it('asks the server what can go back, with the guest credential', async () => {
    // Never worked out here: how much of a line can still be returned depends
    // on what has already gone back, and the server is what knows.
    const user = userEvent.setup()
    mock.on('POST', '/storefront/orders/lookup/returnable', returnable())
    await findOrder(user, order({ status: 'delivered' }))

    await waitFor(() => {
      expect(mock.callsTo('POST', '/orders/lookup/returnable')[0].body).toEqual({
        orderNumber: '#1001',
        email: 'shopper@example.test',
      })
    })
    expect(await screen.findByRole('button', { name: /Start a return/ })).toBeInTheDocument()
  })

  it('is not offered while the order can still simply be cancelled', async () => {
    const user = userEvent.setup()
    await findOrder(user, order({ status: 'pending' }))

    expect(screen.queryByRole('button', { name: /Start a return/ })).not.toBeInTheDocument()
    expect(mock.callsTo('POST', '/orders/lookup/returnable')).toHaveLength(0)
  })

  it('shows the server’s own reason when nothing can go back', async () => {
    const user = userEvent.setup()
    mock.on(
      'POST',
      '/storefront/orders/lookup/returnable',
      returnable({ eligible: false, reason: 'Nothing has gone out on this order yet', lines: [] }),
    )
    await findOrder(user, order({ status: 'delivered' }))

    expect(await screen.findByText('Nothing has gone out on this order yet')).toBeInTheDocument()
  })
})
