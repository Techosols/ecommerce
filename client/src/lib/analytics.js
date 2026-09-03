import { api } from '@/lib/api'

/**
 * The storefront's half of the shop's analytics.
 *
 * The admin's dashboard counts orders from the orders table, which is exact but
 * blind: it can say how many people bought and nothing about how many looked.
 * Views, basket adds and started checkouts only exist if this page reports
 * them, and without that the funnel has one step in it.
 *
 * ── Rules this file exists to enforce ────────────────────────────────────────
 *
 * **A beacon must never break a page.** Every failure is swallowed. A shopper
 * whose ad blocker eats this request, or who is offline, still gets to buy
 * something — analytics is the least important thing happening on any screen it
 * appears on, and it is the only code here allowed to fail silently.
 *
 * **Never anything about a person.** Names, addresses, emails and card details
 * are not sent, ever. Properties carry handles, ids and counts. The server
 * takes the user id from the session token and ignores anything the body says
 * about who this is, so there is nothing to gain by sending it and a privacy
 * problem to create.
 *
 * **The event names are the server's.** It validates against a fixed list, so
 * an invented name is a 422 rather than a row. They are re-declared below so a
 * typo is a build-time mistake here rather than a silent gap in a report.
 */
export const EVENTS = {
  PAGE_VIEWED: 'page_viewed',
  PRODUCT_VIEWED: 'product_viewed',
  COLLECTION_VIEWED: 'collection_viewed',
  SEARCH_PERFORMED: 'search_performed',
  CART_VIEWED: 'cart_viewed',
  CART_ITEM_ADDED: 'cart_item_added',
  CART_ITEM_REMOVED: 'cart_item_removed',
  CHECKOUT_STARTED: 'checkout_started',
  CHECKOUT_COMPLETED: 'checkout_completed',
}

const ANONYMOUS_KEY = 'shop.anonymousId'

/**
 * Two ids, deliberately different in how long they live.
 *
 * `anonymousId` persists across visits so a shopper who comes back three times
 * before buying is one story rather than three. `sessionId` lives in memory
 * only and dies with the tab, which is what makes "how far did this visit get"
 * answerable.
 *
 * Neither identifies anybody. They are random and hold no meaning outside this
 * shop's own tables — and the persistent one is stored under a name a person
 * clearing site data can recognise.
 */
let sessionId = null

function uuid() {
  // `randomUUID` is unavailable on insecure origins and in older browsers, and
  // an analytics helper is not worth an exception on a page that otherwise
  // works — so there is a fallback and it does not have to be cryptographic.
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0
    const value = char === 'x' ? random : (random & 0x3) | 0x8
    return value.toString(16)
  })
}

function anonymousId() {
  try {
    const existing = window.localStorage.getItem(ANONYMOUS_KEY)
    if (existing) return existing
    const created = uuid()
    window.localStorage.setItem(ANONYMOUS_KEY, created)
    return created
  } catch {
    // Private browsing, storage disabled, a quota that is full. The visit is
    // still worth counting; it just cannot be joined to the last one.
    return undefined
  }
}

/**
 * Records one thing that happened.
 *
 * Fire and forget: nothing awaits this, and nothing reads what it returns.
 * Callers must not `await` it either — a page that waits on a beacon is a page
 * that renders as slowly as the slowest request on it.
 */
export function track(name, properties = {}) {
  sessionId ??= uuid()

  const anonymous = anonymousId()

  void api
    .post('/storefront/analytics/events', {
      name,
      ...(anonymous ? { anonymousId: anonymous } : {}),
      sessionId,
      occurredAt: new Date().toISOString(),
      // `undefined` values are dropped rather than sent as null, so an event
      // for a product with no category does not claim the category is null.
      properties: Object.fromEntries(
        Object.entries(properties).filter(([, value]) => value !== undefined && value !== null),
      ),
    })
    .catch(() => {})
}

/** Forgets the visit. Called on sign-out, so two people on one browser are two visits. */
export function resetAnalyticsSession() {
  sessionId = null
}
