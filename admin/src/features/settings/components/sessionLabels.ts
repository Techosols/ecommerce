/**
 * Turning a user-agent string into something a person recognises.
 *
 * Deliberately coarse: the question this answers is "is that laptop mine?",
 * not "which build of Chrome is that", and a longer string would read as
 * surveillance rather than as a list of your own sessions.
 */

/** Enough of a user agent to recognise your own laptop. Not a device fingerprint. */
export function describeAgent(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device'
  const browser =
    /edg/i.test(userAgent) ? 'Edge'
    : /chrome|chromium/i.test(userAgent) ? 'Chrome'
    : /firefox/i.test(userAgent) ? 'Firefox'
    : /safari/i.test(userAgent) ? 'Safari'
    : 'Browser'
  const platform =
    /windows/i.test(userAgent) ? 'Windows'
    : /android/i.test(userAgent) ? 'Android'
    : /iphone|ipad/i.test(userAgent) ? 'iOS'
    : /mac os|macintosh/i.test(userAgent) ? 'macOS'
    : /linux/i.test(userAgent) ? 'Linux'
    : 'Unknown'
  return `${browser} on ${platform}`
}

export function isMobile(userAgent: string | null): boolean {
  return /android|iphone|ipad|mobile/i.test(userAgent ?? '')
}
