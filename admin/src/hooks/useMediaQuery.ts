import { useSyncExternalStore } from 'react'

/**
 * Reactive `matchMedia`.
 *
 * `useSyncExternalStore` rather than an effect so the first render already has
 * the right answer — an effect-based version renders the mobile layout once on
 * a desktop, which is a visible flash of the wrong navigation.
 */
export function useMediaQuery(query: string): boolean {
  function subscribe(onChange: () => void) {
    const list = window.matchMedia(query)
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  )
}

/** Tailwind's `lg` breakpoint: at and above it the sidebar is permanent. */
export const useIsDesktop = () => useMediaQuery('(min-width: 1024px)')
