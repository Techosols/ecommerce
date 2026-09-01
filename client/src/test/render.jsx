import { render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { SettingsContext } from '@/features/settings/useSettings'
import { AuthProvider } from '@/features/account/AuthProvider'

export const testSettings = {
  storeName: 'Copperleaf',
  contactEmail: 'hello@example.test',
  currency: 'GBP',
  guestCheckoutEnabled: true,
  logoUrl: null,
}

/**
 * Mounts a page inside the providers it really has.
 *
 * Retries are off: a test asserting an error state should not wait for three
 * attempts first, and one that passes only because of a retry is hiding a
 * flake rather than proving anything.
 *
 * `auth: true` adds the real `AuthProvider` — not a stub. It asks
 * `/auth/refresh` on mount exactly as it does in the browser, so a test that
 * wants a signed-in customer mocks that route and a test that wants a guest
 * lets it fail. Faking the context instead would prove nothing about the one
 * piece of this that is genuinely subtle: the third state, "not known yet".
 */
export function renderPage(ui, { route = '/', path, settings = testSettings, auth = false } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  })

  const page = path ? (
    <Routes>
      <Route path={path} element={ui} />
    </Routes>
  ) : (
    ui
  )

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <SettingsContext value={settings}>
          {auth ? <AuthProvider>{page}</AuthProvider> : page}
        </SettingsContext>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}
