import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { tokenStore } from '@/lib/api/tokenStore'
import { apiMock, type ApiMock } from '@/test/api-mock'
import { renderAuthed } from '@/test/renderAuthed'
import { AcceptInvitationPage } from '@/pages/AcceptInvitationPage'
import { ForgotPasswordPage } from '@/pages/ForgotPasswordPage'
import { ResetPasswordPage } from '@/pages/ResetPasswordPage'

/**
 * The three screens reached from a link in an email.
 *
 * All of them were missing, which meant an invited colleague followed a link
 * that went nowhere and had no password to sign in with — the account is
 * created deliberately without one, so the link was the only way in.
 *
 * What these tests hold down:
 *
 *   • **A missing token says so.** These pages are reachable directly, and a
 *     form that cannot possibly work is worse than a sentence explaining why.
 *   • **The confirmation field never reaches the server.** It is a guard against
 *     a typo in a field nobody can read back, not part of the credential.
 *   • **A reset request answers the same either way.** Saying "no such account"
 *     would turn a public form into a way to discover who works here.
 *   • **The server's password rules are shown in its own words.**
 */

let api: ApiMock

beforeEach(() => {
  api = apiMock().install()
  tokenStore.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  tokenStore.clear()
})

const TOKEN = 'ZmFrZS10b2tlbi12YWx1ZS1mb3ItdGVzdHM'

describe('accepting an invitation', () => {
  it('sets the password and sends them to sign in', async () => {
    const user = userEvent.setup()
    api.on('POST', '/auth/invitation/accept', { accepted: true })

    await renderAuthed(<AcceptInvitationPage />, {
      route: `/accept-invitation?token=${TOKEN}`
    })

    await user.type(await screen.findByLabelText(/New password/), 'a-long-enough-secret')
    await user.type(screen.getByLabelText(/Confirm password/), 'a-long-enough-secret')
    await user.click(screen.getByRole('button', { name: /Set my password/ }))

    await waitFor(() => {
      expect(api.callsTo('POST', '/auth/invitation/accept')[0]?.body).toEqual({
        token: TOKEN,
        // The confirmation is not part of the credential and never leaves the
        // browser.
        password: 'a-long-enough-secret',
      })
    })
    expect(await screen.findByRole('button', { name: /Sign in/ })).toBeInTheDocument()
  })

  it('explains itself when opened without a token', async () => {
    await renderAuthed(<AcceptInvitationPage />, { route: '/accept-invitation' })

    expect(await screen.findByText(/needs the link from your invitation email/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/New password/)).not.toBeInTheDocument()
  })

  it('will not submit two entries that differ', async () => {
    const user = userEvent.setup()
    await renderAuthed(<AcceptInvitationPage />, {
      route: `/accept-invitation?token=${TOKEN}`
    })

    await user.type(await screen.findByLabelText(/New password/), 'a-long-enough-secret')
    await user.type(screen.getByLabelText(/Confirm password/), 'a-long-enough-secrat')
    await user.click(screen.getByRole('button', { name: /Set my password/ }))

    expect(await screen.findByText(/must match/i)).toBeInTheDocument()
    expect(api.callsTo('POST', '/auth/invitation/accept')).toHaveLength(0)
  })

  it('repeats the server’s reason for refusing a password', async () => {
    // "is too common; choose something less guessable" tells somebody what to
    // do. "Invalid password" does not.
    const user = userEvent.setup()
    api.onError(
      'POST',
      '/auth/invitation/accept',
      422,
      'WEAK_PASSWORD',
      'The password is not acceptable',
    )

    await renderAuthed(<AcceptInvitationPage />, {
      route: `/accept-invitation?token=${TOKEN}`
    })

    await user.type(await screen.findByLabelText(/New password/), 'password123456')
    await user.type(screen.getByLabelText(/Confirm password/), 'password123456')
    await user.click(screen.getByRole('button', { name: /Set my password/ }))

    expect(await screen.findByText('The password is not acceptable')).toBeInTheDocument()
  })

  it('refuses anything under the server’s minimum before asking', async () => {
    const user = userEvent.setup()
    await renderAuthed(<AcceptInvitationPage />, {
      route: `/accept-invitation?token=${TOKEN}`
    })

    await user.type(await screen.findByLabelText(/New password/), 'short')
    await user.type(screen.getByLabelText(/Confirm password/), 'short')
    await user.click(screen.getByRole('button', { name: /Set my password/ }))

    expect(await screen.findByText(/at least 10 characters/i)).toBeInTheDocument()
    expect(api.callsTo('POST', '/auth/invitation/accept')).toHaveLength(0)
  })
})

describe('asking for a reset link', () => {
  it('promises nothing about whether the account exists', async () => {
    const user = userEvent.setup()
    api.on('POST', '/auth/password/forgot', {})

    await renderAuthed(<ForgotPasswordPage />, { route: '/forgot-password' })

    await user.type(await screen.findByLabelText(/Email address/), 'someone@shop.test')
    await user.click(screen.getByRole('button', { name: /Send the link/ }))

    // "If … has an account here" — the wording is the security control.
    expect(await screen.findByText(/has an account here/i)).toBeInTheDocument()
  })

  it('sends the address to the server', async () => {
    const user = userEvent.setup()
    api.on('POST', '/auth/password/forgot', {})

    await renderAuthed(<ForgotPasswordPage />, { route: '/forgot-password' })

    await user.type(await screen.findByLabelText(/Email address/), '  someone@shop.test  ')
    await user.click(screen.getByRole('button', { name: /Send the link/ }))

    await waitFor(() => {
      expect(api.callsTo('POST', '/auth/password/forgot')[0]?.body).toEqual({
        email: 'someone@shop.test',
      })
    })
  })
})

describe('completing a reset', () => {
  it('says the other sessions are gone, because they are', async () => {
    // Completing a reset revokes every session. Being signed out on a phone a
    // moment later reads as a fault unless the page says it was the point.
    const user = userEvent.setup()
    api.on('POST', '/auth/password/reset', {})

    await renderAuthed(<ResetPasswordPage />, {
      route: `/reset-password?token=${TOKEN}`
    })

    await user.type(await screen.findByLabelText(/New password/), 'a-long-enough-secret')
    await user.type(screen.getByLabelText(/Confirm password/), 'a-long-enough-secret')
    await user.click(screen.getByRole('button', { name: /Change my password/ }))

    expect(await screen.findByText(/signed out everywhere else/i)).toBeInTheDocument()
  })

  it('offers a new link when the token is missing', async () => {
    await renderAuthed(<ResetPasswordPage />, { route: '/reset-password' })

    expect(await screen.findByRole('link', { name: /Send me a new link/ })).toBeInTheDocument()
  })
})
