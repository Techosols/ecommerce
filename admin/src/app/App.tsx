import { useState } from 'react'
import { BrowserRouter } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { ToastProvider } from '@/components/ui/Toast'
import { ErrorBoundary } from '@/components/states/ErrorBoundary'
import { AuthProvider } from '@/features/auth/AuthProvider'
import { RealtimeProvider } from '@/lib/realtime/RealtimeProvider'
import { AppRoutes } from '@/routes/AppRoutes'
import { createQueryClient } from './queryClient'
import { ThemeProvider } from './theme'

/**
 * The provider stack, ordered by dependency.
 *
 *   ErrorBoundary   catches a crash in any provider below it
 *   Theme           no dependencies; needed before anything paints
 *   QueryClient     the auth provider clears its cache on sign-out
 *   Router          `AuthProvider` and the guards use location
 *   Auth            owns the session
 *   Realtime        connects only once a staff session exists
 *   Toast           realtime raises toasts, so it must wrap nothing below it
 *
 * The QueryClient is created in state rather than at module scope so that a
 * test can mount the whole application twice without the two sharing a cache.
 */
export function App() {
  const [queryClient] = useState(createQueryClient)

  return (
    <ErrorBoundary>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <AuthProvider>
              <ToastProvider>
                <RealtimeProvider>
                  <AppRoutes />
                </RealtimeProvider>
              </ToastProvider>
            </AuthProvider>
          </BrowserRouter>
        </QueryClientProvider>
      </ThemeProvider>
    </ErrorBoundary>
  )
}
