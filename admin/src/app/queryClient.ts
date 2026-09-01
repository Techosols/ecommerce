import { QueryClient } from '@tanstack/react-query'
import { isAuthError, isForbiddenError, isNotFoundError } from '@/lib/api/errors'

/**
 * Server state, and only server state.
 *
 * React Query holds everything that lives on the server; auth state lives in
 * `AuthProvider`; UI state (a drawer, a tab) lives in the component that owns
 * it. Three separate homes rather than one global store, because a single store
 * ends up re-rendering a table because a modal opened.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // The server is authoritative and things move fast in a shop, so
        // freshness is short and a refocus re-checks. Realtime events
        // invalidate the specific keys they affect on top of this.
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        retry: (failureCount, error) => {
          // Retrying these cannot help: the answer will not change without the
          // operator doing something.
          if (isAuthError(error) || isForbiddenError(error) || isNotFoundError(error)) return false
          return failureCount < 2
        },
      },
      mutations: {
        // A write is not automatically safe to repeat. Anything genuinely
        // retryable carries an idempotency key and retries deliberately.
        retry: false,
      },
    },
  })
}
