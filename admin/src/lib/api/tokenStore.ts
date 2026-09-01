/**
 * The access token, in memory only.
 *
 * Nothing is written to `localStorage` or `sessionStorage`: a token in storage
 * is a token any injected script can read and exfiltrate, and it survives the
 * tab, so a shared machine keeps a working session after the operator walks
 * away. The durable half of the session is the refresh token, which lives in an
 * httpOnly cookie the server scopes to `/api/v1/auth` — unreadable by script by
 * construction, and the reason a page reload can restore the session without
 * anything being persisted here.
 *
 * A tiny subscribable store rather than React state because the HTTP client and
 * the socket both need the current token from outside the React tree.
 */
type Listener = (token: string | null) => void

let accessToken: string | null = null
const listeners = new Set<Listener>()

export const tokenStore = {
  get(): string | null {
    return accessToken
  },

  set(token: string | null): void {
    if (accessToken === token) return
    accessToken = token
    for (const listener of listeners) listener(token)
  },

  clear(): void {
    tokenStore.set(null)
  },

  /** Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}
