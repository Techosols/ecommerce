import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Testing Library auto-cleans only when Vitest's globals are on, and they are
// deliberately off here. Without this, each test renders into the DOM the last
// one left behind and "one link" quietly becomes four.
afterEach(cleanup)

// jsdom implements neither, and both are called by code under test: the pager
// scrolls to the top, and the layout asks about the viewport.
window.scrollTo = () => {}
window.matchMedia ??= () => ({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
})
