import { useEffect, useRef } from 'react'
import { track } from '@/lib/analytics'

/**
 * Reports one event when a page has something worth reporting.
 *
 * Two problems this exists to solve, both of which quietly ruin the numbers if
 * a page calls `track` in a bare effect:
 *
 *   **Double counting.** React runs effects twice in development's strict mode,
 *   and a query re-resolving re-runs the effect again. A key is compared
 *   against the last one reported, so a product page counts one view however
 *   many times it renders.
 *
 *   **Counting nothing.** Every page here mounts before its data arrives, so an
 *   effect that fires on mount reports a product view with no product in it.
 *   Passing a null key waits.
 */
export function useTrackOnce(name, key, properties) {
  const reported = useRef(null)
  const latest = useRef(properties)

  // Its own effect, declared first: effects run in the order they are written,
  // so the properties for this commit are in place before the report below
  // reads them — and writing a ref during render, which is what this replaces,
  // is a rule React is entitled to break in a future renderer.
  useEffect(() => {
    latest.current = properties
  })

  useEffect(() => {
    if (!key || reported.current === key) return
    reported.current = key
    track(name, latest.current ?? {})
  }, [name, key])
}
