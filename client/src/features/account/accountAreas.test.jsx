import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { apiMock, jsonResponse } from '@/test/apiMock'
import { renderPage } from '@/test/render'
import { address, notification, profile, returnCard, returnable, sessionRow } from '@/test/fixtures'
import { tokens } from '@/lib/api'
import { AddressesPage } from './pages/AddressesPage'
import { ProfilePage } from './pages/ProfilePage'
import { SecurityPage } from './pages/SecurityPage'
import { ReturnsPage } from './pages/ReturnsPage'
import { NotificationsPage } from './pages/NotificationsPage'
import { ForgotPasswordPage, ResetPasswordPage } from './pages/PasswordPage'
import { ReturnRequest } from './components/ReturnRequest'

/**
 * The account area.
 *
 * What these tests defend:
 *
 *   • **The server owns the decisions.** Which address is the default, how much
 *     of a line can still go back, whether an email needs verifying — all
 *     asked, never worked out here.
 *   • **A refusal is repeated, not paraphrased.** The one exception is the
 *     forgot-password flow, where saying *less* is the security property.
 *   • **Nothing destructive is one click.**
 *   • **A field the server will refuse is not offered.** The email address is
 *     shown and explained rather than rendered as an input that 422s.
 */

let mock

beforeEach(() => {
  mock = apiMock().install()
  tokens.set('access-token-1')
})

afterEach(() => {
  vi.unstubAllGlobals()
  tokens.clear()
})

/** Every account screen is rendered under a restored session. */
function signedIn() {
  return mock
    .on('POST', '/auth/refresh', {
      accessToken: 'access-token-1',
      tokenType: 'Bearer',
      expiresIn: 900,
    })
    .on('GET', '/auth/me', profile())
}

const authed = (route) => ({ route, auth: true })

// ── Addresses ───────────────────────────────────────────────────────────────

describe('AddressesPage', () => {
  it('shows saved addresses and marks the default', async () => {
    signedIn().on('GET', '/storefront/account/addresses', [
      address(),
      address({ id: 'addr-2', label: 'Work', line1: '2 Baker Street', isDefault: false }),
    ])

    renderPage(<AddressesPage />, authed('/account/addresses'))

    expect(await screen.findByText('Home')).toBeInTheDocument()
    expect(screen.getByText('Work')).toBeInTheDocument()
    expect(screen.getAllByText('Default')).toHaveLength(1)
  })

  it('sends blanks as null, never as empty strings', async () => {
    const user = userEvent.setup()
    signedIn()
      .on('GET', '/storefront/account/addresses', [])
      .on('POST', '/storefront/account/addresses', address())

    renderPage(<AddressesPage />, authed('/account/addresses'))

    await user.click(await screen.findByRole('button', { name: 'Add an address' }))
    await user.type(screen.getByLabelText(/^First name/), 'Ada')
    await user.type(screen.getByLabelText(/^Last name/), 'Lovelace')
    await user.type(screen.getByLabelText(/^Address\*/), '1 Analytical Way')
    await user.type(screen.getByLabelText(/^City/), 'London')
    await user.type(screen.getByLabelText(/^Country/), 'GB')
    await user.click(screen.getByRole('button', { name: 'Save this address' }))

    const call = await waitFor(() => {
      const calls = mock.callsTo('POST', '/storefront/account/addresses')
      expect(calls).toHaveLength(1)
      return calls[0]
    })
    // An empty string recorded as an address line is a line that prints on a
    // label. The optional fields go as null.
    expect(call.body.company).toBeNull()
    expect(call.body.line2).toBeNull()
    expect(call.body.label).toBeNull()
    expect(call.body.countryCode).toBe('GB')
  })

  it('will not save an address the server would refuse', async () => {
    const user = userEvent.setup()
    signedIn().on('GET', '/storefront/account/addresses', [])

    renderPage(<AddressesPage />, authed('/account/addresses'))

    await user.click(await screen.findByRole('button', { name: 'Add an address' }))
    await user.click(screen.getByRole('button', { name: 'Save this address' }))

    expect(await screen.findAllByText('Required.')).not.toHaveLength(0)
    expect(mock.callsTo('POST', '/storefront/account/addresses')).toHaveLength(0)
  })

  it('asks the server to change the default rather than deciding itself', async () => {
    const user = userEvent.setup()
    signedIn()
      .on('GET', '/storefront/account/addresses', [
        address(),
        address({ id: 'addr-2', label: 'Work', isDefault: false }),
      ])
      .on('PATCH', '/storefront/account/addresses/addr-2', address({ id: 'addr-2' }))

    renderPage(<AddressesPage />, authed('/account/addresses'))

    await user.click((await screen.findAllByRole('button', { name: 'Make default' }))[0])

    const call = await waitFor(() => {
      const calls = mock.callsTo('PATCH', '/storefront/account/addresses/addr-2')
      expect(calls).toHaveLength(1)
      return calls[0]
    })
    expect(call.body).toEqual({ isDefault: true })
    // Setting one default unsets another, which this response does not carry —
    // so the list is re-read rather than patched locally.
    await waitFor(() =>
      expect(mock.callsTo('GET', '/storefront/account/addresses').length).toBeGreaterThan(1),
    )
  })

  it('never removes an address in one click', async () => {
    const user = userEvent.setup()
    signedIn().on('GET', '/storefront/account/addresses', [address()])

    renderPage(<AddressesPage />, authed('/account/addresses'))

    await user.click(await screen.findByRole('button', { name: 'Remove address Home' }))

    expect(mock.callsTo('DELETE', '/storefront/account/addresses/addr-1')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Keep it' })).toBeInTheDocument()
  })
})

// ── Profile ─────────────────────────────────────────────────────────────────

describe('ProfilePage', () => {
  it('shows the email and explains why it cannot be edited here', async () => {
    signedIn().on('GET', '/storefront/account', profile())

    renderPage(<ProfilePage />, authed('/account/details'))

    expect(await screen.findByText('shopper@example.test')).toBeInTheDocument()
    // The server's schema does not accept an email, so an input would 422.
    // Asked as a textbox, because the marketing checkbox's label also starts
    // with the word "Email".
    expect(screen.queryByRole('textbox', { name: /email/i })).not.toBeInTheDocument()
    expect(screen.getByText(/cannot be changed here/)).toBeInTheDocument()
  })

  it('saves the fields the server does accept', async () => {
    const user = userEvent.setup()
    signedIn()
      .on('GET', '/storefront/account', profile())
      .on('PATCH', '/storefront/account', profile({ firstName: 'Augusta' }))

    renderPage(<ProfilePage />, authed('/account/details'))

    const first = await screen.findByLabelText('First name')
    await user.clear(first)
    await user.type(first, 'Augusta')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    const call = await waitFor(() => {
      const calls = mock.callsTo('PATCH', '/storefront/account')
      expect(calls).toHaveLength(1)
      return calls[0]
    })
    expect(call.body).toEqual({
      firstName: 'Augusta',
      lastName: 'Lovelace',
      phone: null,
      acceptsMarketing: false,
    })
    expect(call.body).not.toHaveProperty('email')
  })

  it('offers verification only when it is needed, and says only what it can', async () => {
    const user = userEvent.setup()
    signedIn()
      .on('GET', '/storefront/account', profile({ emailVerified: false }))
      .on('POST', '/auth/email/resend', { message: 'ok' })

    renderPage(<ProfilePage />, authed('/account/details'))

    await user.click(await screen.findByRole('button', { name: 'Send it again' }))

    // The server answers the same way for a known and an unknown address, so
    // the screen cannot claim an email was actually sent.
    expect(
      await screen.findByText(/If that address needs verifying, an email is on its way/),
    ).toBeInTheDocument()
  })

  it('does not offer verification to somebody already verified', async () => {
    signedIn().on('GET', '/storefront/account', profile())

    renderPage(<ProfilePage />, authed('/account/details'))

    expect(await screen.findByText('Verified')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send it again' })).not.toBeInTheDocument()
  })
})

// ── Security ────────────────────────────────────────────────────────────────

describe('SecurityPage', () => {
  function securityRoutes() {
    return signedIn().on('GET', '/auth/sessions', [
      sessionRow(),
      sessionRow({ id: 'sess-2', current: false, userAgent: 'Mozilla/5.0 (iPhone) Safari/604' }),
    ])
  }

  it('will not send a password change that cannot succeed', async () => {
    const user = userEvent.setup()
    securityRoutes()

    renderPage(<SecurityPage />, authed('/account/security'))

    await user.type(await screen.findByLabelText('Current password'), 'old-password')
    await user.type(screen.getByLabelText('New password'), 'short')
    await user.type(screen.getByLabelText('New password again'), 'short')

    expect(screen.getByText('At least 10 characters.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Change password' })).toBeDisabled()
    expect(mock.callsTo('POST', '/auth/password/change')).toHaveLength(0)
  })

  it('catches a mistyped confirmation before the server does', async () => {
    const user = userEvent.setup()
    securityRoutes()

    renderPage(<SecurityPage />, authed('/account/security'))

    await user.type(await screen.findByLabelText('Current password'), 'old-password')
    await user.type(screen.getByLabelText('New password'), 'a-long-enough-one')
    await user.type(screen.getByLabelText('New password again'), 'a-long-enough-two')

    expect(screen.getByText('These two do not match.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Change password' })).toBeDisabled()
  })

  it('changes the password and says what else that did', async () => {
    const user = userEvent.setup()
    securityRoutes().on('POST', '/auth/password/change', { changed: true })

    renderPage(<SecurityPage />, authed('/account/security'))

    await user.type(await screen.findByLabelText('Current password'), 'old-password')
    await user.type(screen.getByLabelText('New password'), 'a-long-enough-one')
    await user.type(screen.getByLabelText('New password again'), 'a-long-enough-one')
    await user.click(screen.getByRole('button', { name: 'Change password' }))

    expect(
      await screen.findByText(/Everywhere else you were signed in has been signed out/),
    ).toBeInTheDocument()
  })

  it('repeats a wrong current password in the server’s words', async () => {
    const user = userEvent.setup()
    securityRoutes().onError(
      'POST',
      '/auth/password/change',
      401,
      'UNAUTHENTICATED',
      'That is not your current password.',
    )

    renderPage(<SecurityPage />, authed('/account/security'))

    await user.type(await screen.findByLabelText('Current password'), 'wrong')
    await user.type(screen.getByLabelText('New password'), 'a-long-enough-one')
    await user.type(screen.getByLabelText('New password again'), 'a-long-enough-one')
    await user.click(screen.getByRole('button', { name: 'Change password' }))

    expect(await screen.findByText('That is not your current password.')).toBeInTheDocument()
  })

  it('names each session in a way somebody could recognise', async () => {
    securityRoutes()

    renderPage(<SecurityPage />, authed('/account/security'))

    // Not 180 characters of user-agent tokens.
    expect(await screen.findByText(/Chrome on macOS/)).toBeInTheDocument()
    expect(screen.getByText(/Safari on iOS/)).toBeInTheDocument()
  })

  it('marks this device and offers no way to sign it out from the list', async () => {
    securityRoutes()

    renderPage(<SecurityPage />, authed('/account/security'))

    expect(await screen.findByText('This device')).toBeInTheDocument()
    // One "Sign out" per *other* session, plus "Sign out everywhere".
    expect(screen.getAllByRole('button', { name: /^Sign out/ })).toHaveLength(2)
  })

  it('revokes one session through the server', async () => {
    const user = userEvent.setup()
    securityRoutes().on('DELETE', '/auth/sessions/sess-2', null)

    renderPage(<SecurityPage />, authed('/account/security'))

    await user.click(await screen.findByRole('button', { name: /Sign out Safari on iOS/ }))

    await waitFor(() =>
      expect(mock.callsTo('DELETE', '/auth/sessions/sess-2')).toHaveLength(1),
    )
  })
})

// ── Forgotten passwords ─────────────────────────────────────────────────────

describe('the forgotten-password flow', () => {
  it('says the same thing whether or not the account exists', async () => {
    const user = userEvent.setup()
    mock.on('POST', '/auth/password/forgot', { message: 'ok' })

    renderPage(<ForgotPasswordPage />, { route: '/forgot-password' })

    await user.type(screen.getByLabelText('Email'), 'nobody@example.test')
    await user.click(screen.getByRole('button', { name: 'Send me a link' }))

    // "If there is an account" — never "no account with that email", which
    // would turn this form into a way to find out who shops here.
    expect(await screen.findByText(/If there is an account/)).toBeInTheDocument()
    expect(screen.queryByText(/no account/i)).not.toBeInTheDocument()
  })

  it('explains a truncated link rather than failing silently', () => {
    renderPage(<ResetPasswordPage />, { route: '/reset-password' })

    expect(screen.getByText('That link is incomplete')).toBeInTheDocument()
  })

  it('posts the token from the link and never shows it', async () => {
    const user = userEvent.setup()
    mock.on('POST', '/auth/password/reset', { reset: true })

    renderPage(<ResetPasswordPage />, { route: '/reset-password?token=abc123def456ghi789jkl' })

    await user.type(screen.getByLabelText('New password'), 'a-long-enough-one')
    await user.type(screen.getByLabelText('Again, to be sure'), 'a-long-enough-one')
    await user.click(screen.getByRole('button', { name: 'Set the new password' }))

    const call = await waitFor(() => {
      const calls = mock.callsTo('POST', '/auth/password/reset')
      expect(calls).toHaveLength(1)
      return calls[0]
    })
    expect(call.body.token).toBe('abc123def456ghi789jkl')
    expect(await screen.findByText('Password changed')).toBeInTheDocument()
  })
})

// ── Returns ─────────────────────────────────────────────────────────────────

describe('returns', () => {
  it('lists returns in the customer’s words, not the server’s enum', async () => {
    signedIn().onList('/storefront/returns', [returnCard()])

    renderPage(<ReturnsPage />, authed('/account/returns'))

    expect(await screen.findByText('RET-1001')).toBeInTheDocument()
    expect(screen.getByText(/It arrived damaged/)).toBeInTheDocument()
    expect(screen.getByText('Requested')).toBeInTheDocument()
  })

  it('points at the orders when there is nothing to show', async () => {
    signedIn().onList('/storefront/returns', [])

    renderPage(<ReturnsPage />, authed('/account/returns'))

    expect(await screen.findByText('No returns')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'See your orders' })).toHaveAttribute(
      'href',
      '/account/orders',
    )
  })

  it('offers only what the server says can still go back', async () => {
    signedIn().on('GET', '/storefront/orders/order-1/returnable', returnable())

    const user = userEvent.setup()
    renderPage(<ReturnRequest orderId="order-1" enabled />, authed('/account/orders/order-1'))
    await user.click(await screen.findByRole('button', { name: 'Start a return' }))

    // Two of three are still returnable — the third is already back, and is not
    // offered at all.
    const input = screen.getByLabelText('How many Copperleaf Classic to return')
    expect(input).toHaveAttribute('max', '2')
    expect(screen.getByText(/2 of 3 can go back/)).toBeInTheDocument()
    expect(screen.getByText(/1 already returned/)).toBeInTheDocument()
  })

  it('repeats the server’s reason when nothing can go back', async () => {
    signedIn().on(
      'GET',
      '/storefront/orders/order-1/returnable',
      returnable({ eligible: false, reason: 'Nothing has gone out on this order yet', lines: [] }),
    )

    renderPage(<ReturnRequest orderId="order-1" enabled />, authed('/account/orders/order-1'))

    expect(
      await screen.findByText('Nothing has gone out on this order yet'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Start a return' })).not.toBeInTheDocument()
  })

  it('will not open a return with nothing in it', async () => {
    const user = userEvent.setup()
    signedIn().on('GET', '/storefront/orders/order-1/returnable', returnable())

    renderPage(<ReturnRequest orderId="order-1" enabled />, authed('/account/orders/order-1'))

    await user.click(await screen.findByRole('button', { name: 'Start a return' }))

    expect(screen.getByRole('button', { name: 'Request this return' })).toBeDisabled()
    expect(mock.callsTo('POST', '/storefront/orders/order-1/returns')).toHaveLength(0)
  })

  it('opens a return with the lines and reason chosen', async () => {
    const user = userEvent.setup()
    signedIn()
      .on('GET', '/storefront/orders/order-1/returnable', returnable())
      .on('POST', '/storefront/orders/order-1/returns', {
        id: 'ret-1',
        returnNumber: 'RET-1002',
        status: 'requested',
      })

    renderPage(<ReturnRequest orderId="order-1" enabled />, authed('/account/orders/order-1'))

    await user.click(await screen.findByRole('button', { name: 'Start a return' }))
    const quantity = screen.getByLabelText('How many Copperleaf Classic to return')
    await user.clear(quantity)
    await user.type(quantity, '2')
    await user.selectOptions(screen.getByLabelText('Why?'), 'damaged')
    await user.click(screen.getByRole('button', { name: 'Request this return' }))

    const call = await waitFor(() => {
      const calls = mock.callsTo('POST', '/storefront/orders/order-1/returns')
      expect(calls).toHaveLength(1)
      return calls[0]
    })
    expect(call.body).toEqual({
      reason: 'damaged',
      customerNote: null,
      lines: [{ orderItemId: 'item-1', quantity: 2 }],
    })
    expect(await screen.findByText(/RET-1002 is open/)).toBeInTheDocument()
  })

  it('clamps a quantity to what is actually returnable', async () => {
    const user = userEvent.setup()
    signedIn().on('GET', '/storefront/orders/order-1/returnable', returnable())

    renderPage(<ReturnRequest orderId="order-1" enabled />, authed('/account/orders/order-1'))

    await user.click(await screen.findByRole('button', { name: 'Start a return' }))
    const quantity = screen.getByLabelText('How many Copperleaf Classic to return')
    await user.clear(quantity)
    await user.type(quantity, '9')

    // The server checks again regardless; this only avoids offering a number
    // that is going to be refused.
    expect(quantity).toHaveValue(2)
  })
})

// ── Notifications ───────────────────────────────────────────────────────────

describe('NotificationsPage', () => {
  function notificationRoutes(items = [notification()]) {
    return signedIn()
      .on('GET', '/storefront/notifications/preferences', [])
      .onList('/storefront/notifications', items)
  }

  it('lists notifications and marks the unread ones', async () => {
    notificationRoutes([notification(), notification({ id: 'note-2', read: true })])

    renderPage(<NotificationsPage />, authed('/account/notifications'))

    expect(await screen.findAllByText('Your order is on its way')).toHaveLength(2)
    // One unread, so one way to mark it.
    expect(screen.getAllByRole('button', { name: /Mark "/ })).toHaveLength(1)
  })

  it('offers no "mark all" when there is nothing unread', async () => {
    notificationRoutes([notification({ read: true })])

    renderPage(<NotificationsPage />, authed('/account/notifications'))

    await screen.findByText('Your order is on its way')
    expect(screen.queryByRole('button', { name: 'Mark all read' })).not.toBeInTheDocument()
  })

  it('marks one read through the server', async () => {
    const user = userEvent.setup()
    notificationRoutes().on('POST', '/storefront/notifications/note-1/read', null)

    renderPage(<NotificationsPage />, authed('/account/notifications'))

    await user.click(await screen.findByRole('button', { name: /Mark "/ }))

    await waitFor(() =>
      expect(mock.callsTo('POST', '/storefront/notifications/note-1/read')).toHaveLength(1),
    )
  })

  it('treats an absent preference as on', async () => {
    // The server returns only the exceptions somebody has set. Everything not
    // in that list is enabled, and a screen that defaulted to off would show
    // every switch dark on a fresh account.
    notificationRoutes()

    renderPage(<NotificationsPage />, authed('/account/notifications'))

    expect(await screen.findByLabelText('Dispatch and tracking — Email')).toBeChecked()
  })

  it('shows a preference somebody has turned off', async () => {
    signedIn()
      .on('GET', '/storefront/notifications/preferences', [
        { type: 'order.shipped', channel: 'email', enabled: false },
      ])
      .onList('/storefront/notifications', [notification()])

    renderPage(<NotificationsPage />, authed('/account/notifications'))

    // The grid renders before the exceptions land — everything is on until the
    // server says otherwise — so this waits for the answer rather than the row.
    await waitFor(() =>
      expect(screen.getByLabelText('Dispatch and tracking — Email')).not.toBeChecked(),
    )
    expect(screen.getByLabelText('Dispatch and tracking — Here')).toBeChecked()
  })

  it('saves one preference at a time, not the whole grid', async () => {
    const user = userEvent.setup()
    notificationRoutes().on('PUT', '/storefront/notifications/preferences', () =>
      jsonResponse(200, {
        success: true,
        data: { type: 'order.shipped', channel: 'email', enabled: false },
      }),
    )

    renderPage(<NotificationsPage />, authed('/account/notifications'))

    // The switches are disabled until the current preferences are known, so a
    // click before that lands would be silently dropped.
    const toggle = await screen.findByLabelText('Dispatch and tracking — Email')
    await waitFor(() => expect(toggle).toBeEnabled())
    await user.click(toggle)

    const call = await waitFor(() => {
      const calls = mock.callsTo('PUT', '/storefront/notifications/preferences')
      expect(calls).toHaveLength(1)
      return calls[0]
    })
    expect(call.body).toEqual({ type: 'order.shipped', channel: 'email', enabled: false })
  })
})
