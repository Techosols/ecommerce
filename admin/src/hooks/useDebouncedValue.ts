import { useEffect, useState } from 'react'

/**
 * The value, but only once it has stopped changing.
 *
 * Used for search boxes: typing "burger" would otherwise be six requests, five
 * of them already stale by the time they land. The input stays instant because
 * it renders the raw value; only the query key is delayed.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])

  return debounced
}
