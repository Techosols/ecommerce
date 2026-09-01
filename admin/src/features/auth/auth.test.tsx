import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '@/test/render'
import { tokenStore } from '@/lib/api/tokenStore'
import { AuthProvider } from './AuthProvider'
import { LoginForm } from './LoginForm'
import { RequirePermission } from './RequirePermission'
import { useAuth } from './useAuth'
import type { CurrentUser } from './auth.types'
import { jsonResponse, urlOf } from '@/test/http'

/**
 * Authentication and authorization, against the server's real contract.
 *
 * `fetch` is stubbed with the exact envelopes `auth.controller.ts` produces, so
 * a change to that contract breaks these tests rather than surfacing as a blank
 * screen in production.
 */

const staffUser: CurrentUser = {
  id: 'user-1',
  email: 'ops@example.com',
  firstName: 'Sam',
  lastName: 'Ops',
  phone: null,
  emailVerified: true,
  status: 'active',
  roles: ['staff'],
  createdAt: '2026-01-05T09:00:00.000Z',
  permissions: ['orders:read', 'orders:write', 'inventory:read'],
  isStaff: true,
  sessionId: 'session-1',
}

const customerUser: CurrentUser = {
  ...staffUser,
  id: 'user-2',
  email: 'shopper@example.com',
  roles: ['customer'],
  permissions: [],
  isStaff: false,
}

function Probe() {
  const { status, user, can } = useAuth()
  return (
    <div>
      <p data-testid="status">{status}</p>
      <p data-testid="email">{user?.email ?? 'none'}</p>
      <p data-testid="can-orders">{String(can('orders:read'))}</p>
      <p data-testid="can-analytics">{String(can('analytics:read'))}</p>
      <RequirePermission permission="orders:write">
        <button type="button">Confirm order</button>
      </RequirePermission>
      <RequirePermission permission="payments:refund">
        <button type="button">Issue refund</button>
      </RequirePermission>
    </div>
  )
}

describe('AuthProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    tokenStore.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    tokenStore.clear()
  })

  it('restores a session from the refresh cookie on load', async () => {
    fetchMock.mockImplementation((input) => {
      const url = urlOf(input)
      if (url.includes('/auth/refresh')) {
        return Promise.resolve(jsonResponse(200, { success: true, data: { accessToken: 'tok' } }))
      }
      if (url.includes('/auth/me')) {
        return Promise.resolve(jsonResponse(200, { success: true, data: staffUser }))
      }
      return Promise.resolve(
        jsonResponse(404, { success: false, code: 'NOT_FOUND', message: 'no' }),
      )
    })

    renderWithProviders(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'))
    expect(screen.getByTestId('email')).toHaveTextContent('ops@example.com')
    // Nothing was persisted; the access token lives in memory only.
    expect(tokenStore.get()).toBe('tok')
  })

  it('is anonymous when there is no usable refresh cookie', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, { success: false, code: 'REFRESH_TOKEN_INVALID', message: 'gone' }),
    )

    renderWithProviders(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'))
    expect(tokenStore.get()).toBeNull()
  })

  it('renders only the controls the operator holds permissions for', async () => {
    fetchMock.mockImplementation((input) => {
      const url = urlOf(input)
      if (url.includes('/auth/refresh')) {
        return Promise.resolve(jsonResponse(200, { success: true, data: { accessToken: 'tok' } }))
      }
      return Promise.resolve(jsonResponse(200, { success: true, data: staffUser }))
    })

    renderWithProviders(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'))

    expect(screen.getByTestId('can-orders')).toHaveTextContent('true')
    // Staff hold no analytics:read — the dashboard's trading figures are hidden.
    expect(screen.getByTestId('can-analytics')).toHaveTextContent('false')
    expect(screen.getByRole('button', { name: 'Confirm order' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Issue refund' })).not.toBeInTheDocument()
  })
})

describe('LoginForm', () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    tokenStore.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    tokenStore.clear()
  })

  function renderLogin(onSuccess = vi.fn()) {
    // The provider's own restore call, before the form is used.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { success: false, code: 'REFRESH_TOKEN_INVALID', message: 'gone' }),
    )

    renderWithProviders(
      <AuthProvider>
        <LoginForm onSuccess={onSuccess} />
      </AuthProvider>,
    )
    return onSuccess
  }

  it('signs a staff account in and stores the access token in memory', async () => {
    const user = userEvent.setup()
    const onSuccess = renderLogin()

    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        data: { accessToken: 'tok', tokenType: 'Bearer', expiresIn: 900, user: staffUser },
      }),
    )

    await user.type(screen.getByLabelText(/email/i), 'ops@example.com')
    await user.type(screen.getByLabelText(/^password/i), 'correct horse battery')
    await user.click(screen.getByRole('button', { name: /sign in/i }))

    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce())
    expect(tokenStore.get()).toBe('tok')
  })

  it('refuses a customer account, even with valid credentials', async () => {
    const user = userEvent.setup()
    const onSuccess = renderLogin()

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: { accessToken: 'tok', tokenType: 'Bearer', expiresIn: 900, user: customerUser },
        }),
      )
      // The provider signs the session straight back out.
      .mockResolvedValueOnce(new Response(null, { status: 204 }))

    await user.type(screen.getByLabelText(/email/i), 'shopper@example.com')
    await user.type(screen.getByLabelText(/^password/i), 'correct horse battery')
    await user.click(screen.getByRole('button', { name: /sign in/i }))

    expect(await screen.findByText(/does not have access to the admin/i)).toBeInTheDocument()
    expect(onSuccess).not.toHaveBeenCalled()
    expect(tokenStore.get()).toBeNull()
  })

  it("shows the server's message for bad credentials without narrowing it", async () => {
    const user = userEvent.setup()
    renderLogin()

    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, {
        success: false,
        code: 'INVALID_CREDENTIALS',
        message: 'Those details do not match an account.',
      }),
    )

    await user.type(screen.getByLabelText(/email/i), 'ops@example.com')
    await user.type(screen.getByLabelText(/^password/i), 'wrong')
    await user.click(screen.getByRole('button', { name: /sign in/i }))

    expect(await screen.findByText('Those details do not match an account.')).toBeInTheDocument()
  })

  it('validates locally before spending a rate-limited request', async () => {
    const user = userEvent.setup()
    renderLogin()
    const callsBefore = fetchMock.mock.calls.length

    await user.click(screen.getByRole('button', { name: /sign in/i }))

    expect(await screen.findByText('Enter your email address.')).toBeInTheDocument()
    expect(fetchMock.mock.calls.length).toBe(callsBefore)
  })

  it('explains a rate limit rather than repeating the generic message', async () => {
    const user = userEvent.setup()
    renderLogin()

    fetchMock.mockResolvedValueOnce(
      jsonResponse(429, { success: false, code: 'RATE_LIMITED', message: 'Too many requests' }),
    )

    await user.type(screen.getByLabelText(/email/i), 'ops@example.com')
    await user.type(screen.getByLabelText(/^password/i), 'correct horse battery')
    await user.click(screen.getByRole('button', { name: /sign in/i }))

    expect(await screen.findByText(/wait a few minutes/i)).toBeInTheDocument()
  })
})
