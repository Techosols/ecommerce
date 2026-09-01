import type { ReactElement, ReactNode } from 'react'
import { expect } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ToastProvider } from '@/components/ui/Toast'
import { ThemeProvider } from '@/app/theme'
import { AuthProvider } from '@/features/auth/AuthProvider'
import { tokenStore } from '@/lib/api/tokenStore'

export interface RenderAuthedOptions {
  route?: string
  /** Register the element at this path when the component reads route params. */
  path?: string
}

/**
 * Mounts a page inside the providers it really has, with a restored session.
 *
 * Waiting for the session before returning is what keeps every test from
 * repeating the same `waitFor`: a page under `AuthProvider` renders the
 * "restoring" state first, and asserting against that is a race.
 */
export async function renderAuthed(ui: ReactElement, options: RenderAuthedOptions = {}) {
  const { route = '/', path } = options
  tokenStore.clear()

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  })

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[route]}>
            <AuthProvider>
              <ToastProvider>
                {path ? <Routes>{<Route path={path} element={children} />}</Routes> : children}
              </ToastProvider>
            </AuthProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>
    )
  }

  const result = render(ui, { wrapper: Wrapper })

  await waitFor(() => {
    expect(screen.queryByText(/restoring your session/i)).not.toBeInTheDocument()
  })

  return { queryClient, ...result }
}
