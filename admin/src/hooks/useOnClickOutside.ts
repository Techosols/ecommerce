import { useEffect, type RefObject } from 'react'

/**
 * Calls `handler` when a pointer goes down outside `ref`.
 *
 * `pointerdown` rather than `click`: a menu that closes on click stays open
 * through the whole press, and the element under the cursor may have moved by
 * the time the click resolves.
 */
export function useOnClickOutside(
  ref: RefObject<HTMLElement | null>,
  handler: () => void,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return

    function onPointerDown(event: PointerEvent) {
      const element = ref.current
      if (!element || element.contains(event.target as Node)) return
      handler()
    }

    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [ref, handler, enabled])
}
