import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ToastProvider } from '@/components/ui/Toast'
import { ThemeProvider } from '@/app/theme'
import { AuthProvider } from '@/features/auth/AuthProvider'
import { tokenStore } from '@/lib/api/tokenStore'
import type { CurrentUser } from '@/features/auth/auth.types'
import { AppRoutes } from './AppRoutes'
import { jsonResponse, urlOf } from '@/test/http'

/**
 * The route guards.
 *
 * What matters here is the ordering: a page must never redirect while the
 * session is still being restored from the refresh cookie, or every reload
 * flashes the login screen.
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
  // Staff hold neither analytics:read nor discounts:read.
  permissions: ['orders:read', 'orders:write', 'inventory:read', 'customers:read'],
  isStaff: true,
  sessionId: 'session-1',
}

function renderAt(route: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })

  return render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[route]}>
          <AuthProvider>
            <ToastProvider>
              <AppRoutes />
            </ToastProvider>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  )
}

describe('route guards', () => {
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

  function signedIn() {
    fetchMock.mockImplementation((input) => {
      const url = urlOf(input)
      if (url.includes('/auth/refresh')) {
        return Promise.resolve(jsonResponse(200, { success: true, data: { accessToken: 'tok' } }))
      }
      if (url.includes('/auth/me')) {
        return Promise.resolve(jsonResponse(200, { success: true, data: staffUser }))
      }
      if (url.includes('/notifications/unread-count')) {
        return Promise.resolve(jsonResponse(200, { success: true, data: { count: 0 } }))
      }
      return Promise.resolve(jsonResponse(200, { success: true, data: [] }))
    })
  }

  function signedOut() {
    fetchMock.mockResolvedValue(
      jsonResponse(401, { success: false, code: 'REFRESH_TOKEN_INVALID', message: 'gone' }),
    )
  }

  it('sends an anonymous visitor to the login page', async () => {
    signedOut()
    renderAt('/orders')

    expect(await screen.findByRole('button', { name: /sign in/i })).toBeInTheDocument()
  })

  it('shows a restoring state rather than redirecting while the cookie is checked', () => {
    // A refresh that never settles: the guard must wait, not decide.
    fetchMock.mockImplementation(() => new Promise(() => undefined))
    renderAt('/orders')

    expect(screen.getByText(/restoring your session/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /sign in/i })).not.toBeInTheDocument()
  })

  it('renders a protected page for an operator who holds the permission', async () => {
    signedIn()
    renderAt('/orders')

    expect(await screen.findByRole('heading', { name: 'Orders', level: 1 })).toBeInTheDocument()
  })

  it('refuses a page whose permission the operator lacks', async () => {
    signedIn()
    renderAt('/discounts')

    expect(await screen.findByText(/do not have access to this/i)).toBeInTheDocument()
  })

  it('keeps a signed-in operator out of the login page', async () => {
    signedIn()
    renderAt('/login')

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /sign in/i })).not.toBeInTheDocument(),
    )
  })

  it('renders the not-found page inside the shell for an unknown route', async () => {
    signedIn()
    renderAt('/nowhere')

    expect(await screen.findByText('Page not found')).toBeInTheDocument()
  })
})
