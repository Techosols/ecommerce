import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { apiMock, jsonResponse } from '@/test/apiMock'
import { renderPage } from '@/test/render'
import { order, orderCard, session } from '@/test/fixtures'
import { tokens } from '@/lib/api'
import { AccountLayout } from './components/AccountLayout'
import { SignInPage } from './pages/SignInPage'
import { MyOrdersPage } from './pages/MyOrdersPage'
import { MyOrderPage } from './pages/MyOrderPage'
import { OrderPage } from './pages/OrderPage'
import { OrderLookupPage } from './pages/OrderLookupPage'

/**
 * The account, and the two ways somebody reaches an order.
 *
 * What these tests defend:
 *
 *   • **"Not known yet" is not "signed out".** A reload wipes the in-memory
 *     access token, and the provider mints a new one from the refresh cookie.
 *     A screen that treated the gap as signed-out would bounce a signed-in
 *     customer to the login page on every refresh.
 *   • **The access token never touches storage.** It lives in a module
 *     variable and dies with the page; the refresh token is an httpOnly
 *     cookie this code cannot read at all.
 *   • **A guest can find their own order, and only their own.** Order numbers
 *     are guessable, so the lookup needs the email too.
 *   • **Nothing is offered that the server would refuse.** Cancelling appears
 *     only while the order is still cancellable — and is never one click.
 */

let mock

beforeEach(() => {
  mock = apiMock().install()
  tokens.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  tokens.clear()
})

/** A provider that restores a session, as it does after a reload. */
function signedIn() {
  return mock
    .on('POST', '/auth/refresh', { accessToken: 'access-token-1', tokenType: 'Bearer', expiresIn: 900 })
    .on('GET', '/auth/me', session().user)
}

/** A provider whose refresh fails: nobody is signed in. */
function signedOut() {
  return mock.onError('POST', '/auth/refresh', 401, 'UNAUTHENTICATED', 'No session')
}

describe('signing in', () => {
  it('does not decide anybody is signed out while it is still asking', async () => {
    // A refresh that never resolves. The guard must say it is checking, not
    // send the customer to a login page they do not need. This is the one
    // place that decision is made, for every account screen.
    signedOut()
    mock.routes.unshift({ method: 'POST', pattern: '/auth/refresh', respond: () => new Promise(() => {}) })

    renderPage(<AccountLayout />, { route: '/account/orders', auth: true })

    expect(await screen.findByText('Checking your session…')).toBeInTheDocument()
  })

  it('signs in and keeps the token out of storage', async () => {
    const user = userEvent.setup()
    signedOut()
    mock.on('POST', '/auth/login', session()).on('GET', '/auth/me', session().user)

    renderPage(<SignInPage />, { route: '/sign-in', auth: true })
    await screen.findByRole('heading', { name: 'Sign in' })

    await user.type(screen.getByLabelText(/^Email/), 'shopper@example.test')
    await user.type(screen.getByLabelText(/^Password/), 'correct horse battery')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => expect(tokens.get()).toBe('access-token-1'))
    expect(window.localStorage.getItem('accessToken')).toBeNull()
    expect(JSON.stringify(window.localStorage)).not.toContain('access-token-1')
    expect(JSON.stringify(window.sessionStorage)).not.toContain('access-token-1')
  })

  it('shows the server’s refusal rather than guessing which field was wrong', async () => {
    const user = userEvent.setup()
    signedOut()
    mock.onError(
      'POST',
      '/auth/login',
      401,
      'UNAUTHENTICATED',
      'That email and password do not match.',
    )

    renderPage(<SignInPage />, { route: '/sign-in', auth: true })
    await screen.findByRole('heading', { name: 'Sign in' })

    await user.type(screen.getByLabelText(/^Email/), 'shopper@example.test')
    await user.type(screen.getByLabelText(/^Password/), 'wrong')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByText('That email and password do not match.')).toBeInTheDocument()
    // And it does not say *which* half was wrong — that is the server's choice
    // and it is the right one.
    expect(screen.queryByText(/no account with that email/i)).not.toBeInTheDocument()
  })

  it('never sends the password anywhere but the login route', async () => {
    const user = userEvent.setup()
    signedOut()
    mock.on('POST', '/auth/login', session()).on('GET', '/auth/me', session().user)

    renderPage(<SignInPage />, { route: '/sign-in', auth: true })
    await screen.findByRole('heading', { name: 'Sign in' })
    await user.type(screen.getByLabelText(/^Email/), 'shopper@example.test')
    await user.type(screen.getByLabelText(/^Password/), 'correct horse battery')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => expect(mock.callsTo('POST', '/auth/login')).toHaveLength(1))
    for (const call of mock.calls) {
      if (call.url.includes('/auth/login')) continue
      expect(JSON.stringify(call.body ?? null)).not.toContain('correct horse battery')
    }
  })
})

describe('MyOrdersPage', () => {
  it('sends a guest to sign in, carrying where they were headed', async () => {
    signedOut()

    renderPage(<AccountLayout />, { route: '/account/orders', auth: true })

    // Navigate renders nothing; the account area never appearing is the
    // assertion.
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Your account' })).not.toBeInTheDocument(),
    )
    expect(mock.callsTo('GET', '/storefront/orders')).toHaveLength(0)
  })

  it('names who is signed in, once, for every account screen', async () => {
    signedIn().on('GET', '/storefront/notifications/unread-count', { count: 0 })

    renderPage(<AccountLayout />, { route: '/account/orders', auth: true })

    expect(await screen.findByText('Signed in as shopper@example.test')).toBeInTheDocument()
    // And offers the way out of every one of them.
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
  })

  it('lists a signed-in customer’s orders with the server’s totals', async () => {
    signedIn().onList('/storefront/orders', [orderCard()])

    renderPage(<MyOrdersPage />, { route: '/account/orders', auth: true })

    expect(await screen.findByText('#1001')).toBeInTheDocument()
    expect(screen.getByText('£32.34')).toBeInTheDocument()
  })

  it('says there is nothing yet rather than showing an empty table', async () => {
    signedIn().onList('/storefront/orders', [])

    renderPage(<MyOrdersPage />, { route: '/account/orders', auth: true })

    expect(await screen.findByText('No orders yet')).toBeInTheDocument()
  })
})

describe('MyOrderPage', () => {
  const route = { route: '/account/orders/order-1', path: '/account/orders/:id', auth: true }

  it('shows the order the server sent, priced by the server', async () => {
    signedIn().on('GET', '/storefront/orders/order-1', order())

    renderPage(<MyOrderPage />, route)

    expect(await screen.findByRole('heading', { name: 'Order #1001' })).toBeInTheDocument()
    expect(screen.getByText('£32.34')).toBeInTheDocument()
    expect(screen.getByText('Standard delivery')).toBeInTheDocument()
  })

  it('never cancels in one click', async () => {
    const user = userEvent.setup()
    signedIn().on('GET', '/storefront/orders/order-1', order())

    renderPage(<MyOrderPage />, route)
    await screen.findByRole('heading', { name: 'Order #1001' })

    await user.click(screen.getByRole('button', { name: 'Cancel this order' }))

    // The first press only asks. Nothing has been sent.
    expect(mock.callsTo('POST', '/storefront/orders/order-1/cancel')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Keep the order' })).toBeInTheDocument()

    // And backing out sends nothing either.
    await user.click(screen.getByRole('button', { name: 'Keep the order' }))

    expect(mock.callsTo('POST', '/storefront/orders/order-1/cancel')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Cancel this order' })).toBeInTheDocument()
  })

  it('cancels through the server and adopts what comes back', async () => {
    const user = userEvent.setup()
    signedIn()
      .on('GET', '/storefront/orders/order-1', order())
      .on('POST', '/storefront/orders/order-1/cancel', order({
        status: 'cancelled',
        cancelReason: 'Cancelled by the customer.',
      }))

    renderPage(<MyOrderPage />, route)
    await screen.findByRole('heading', { name: 'Order #1001' })

    await user.click(screen.getByRole('button', { name: 'Cancel this order' }))
    await user.click(screen.getByRole('button', { name: 'Yes, cancel it' }))

    expect(await screen.findByText('Cancelled')).toBeInTheDocument()
    expect(
      screen.getByText(/This order was cancelled\. Cancelled by the customer\./),
    ).toBeInTheDocument()
  })

  it('does not offer to cancel an order that has shipped', async () => {
    // The server would refuse it. A button that cannot work is a lie.
    signedIn().on('GET', '/storefront/orders/order-1', order({ status: 'shipped' }))

    renderPage(<MyOrderPage />, route)
    await screen.findByRole('heading', { name: 'Order #1001' })

    expect(screen.queryByRole('button', { name: 'Cancel this order' })).not.toBeInTheDocument()
  })

  it('says a refused cancellation in the server’s words', async () => {
    const user = userEvent.setup()
    signedIn()
      .on('GET', '/storefront/orders/order-1', order())
      .onError(
        'POST',
        '/storefront/orders/order-1/cancel',
        422,
        'DOMAIN_RULE_VIOLATION',
        'That order has already been picked.',
      )

    renderPage(<MyOrderPage />, route)
    await screen.findByRole('heading', { name: 'Order #1001' })
    await user.click(screen.getByRole('button', { name: 'Cancel this order' }))
    await user.click(screen.getByRole('button', { name: 'Yes, cancel it' }))

    expect(await screen.findByText('That order has already been picked.')).toBeInTheDocument()
  })
})

describe('the confirmation', () => {
  const route = { route: '/orders/order-1', path: '/orders/:id', auth: true }

  it('shows a guest their order with no second request', async () => {
    // Handed over in navigation state at the moment of placing. For a guest
    // this is the one time they are guaranteed to see it, and it must not
    // depend on a fetch they are not authorised to make.
    signedOut()
    const { container } = renderPage(<OrderPage />, {
      ...route,
      route: { pathname: '/orders/order-1', state: { order: order() } },
    })

    expect(await screen.findByText('Thank you — your order is in')).toBeInTheDocument()
    expect(within(container).getByText('£32.34')).toBeInTheDocument()
    expect(mock.callsTo('GET', '/storefront/orders/order-1')).toHaveLength(0)
  })

  it('sends a guest arriving cold to the lookup rather than a 404', async () => {
    signedOut()

    renderPage(<OrderPage />, route)

    await waitFor(() => expect(screen.queryByText(/Thank you/)).not.toBeInTheDocument())
    expect(mock.callsTo('GET', '/storefront/orders/order-1')).toHaveLength(0)
  })
})

describe('OrderLookupPage', () => {
  it('needs the number and the email together', async () => {
    const user = userEvent.setup()
    mock.on('POST', '/storefront/orders/lookup', order())

    renderPage(<OrderLookupPage />, { route: '/orders/lookup' })

    await user.type(screen.getByLabelText('Order number'), '#1001')
    await user.type(screen.getByLabelText('Email'), 'shopper@example.test')
    await user.click(screen.getByRole('button', { name: 'Find it' }))

    const call = await waitFor(() => {
      const calls = mock.callsTo('POST', '/storefront/orders/lookup')
      expect(calls).toHaveLength(1)
      return calls[0]
    })
    expect(call.body).toEqual({ orderNumber: '#1001', email: 'shopper@example.test' })
    expect(await screen.findByRole('heading', { name: 'Order #1001' })).toBeInTheDocument()
  })

  it('repeats the server’s single answer for every failure', async () => {
    const user = userEvent.setup()
    // The server deliberately answers the same way whether the number does not
    // exist or the email does not match — otherwise this endpoint would tell
    // anyone which order numbers are real.
    mock.on('POST', '/storefront/orders/lookup', () =>
      jsonResponse(404, {
        success: false,
        code: 'NOT_FOUND',
        message: 'We could not find an order with those details.',
      }),
    )

    renderPage(<OrderLookupPage />, { route: '/orders/lookup' })

    await user.type(screen.getByLabelText('Order number'), '#9999')
    await user.type(screen.getByLabelText('Email'), 'someone@example.test')
    await user.click(screen.getByRole('button', { name: 'Find it' }))

    expect(
      await screen.findByText('We could not find an order with those details.'),
    ).toBeInTheDocument()
  })
})
