import { api } from '@/lib/api'

/**
 * Passwords, sessions and email verification.
 *
 * ── Why the forgot flow says so little ──────────────────────────────────────
 *
 * `forgot` answers the same 202 whether or not the address has an account, and
 * `resend` does the same. That is deliberate on the server's part and the
 * screen must not undo it: an endpoint that answered differently for a known
 * address would be a way to enumerate the shop's customers, and a form that
 * said "no account with that email" would leak the same fact more politely.
 *
 * `skipAuthRefresh` on the password calls stops the client's 401-retry from
 * treating a wrong current password as an expired token and quietly replaying
 * it against a fresh one.
 */
export const securityApi = {
  changePassword: (currentPassword, newPassword) =>
    api.post(
      '/auth/password/change',
      { currentPassword, newPassword },
      { skipAuthRefresh: true },
    ),

  forgotPassword: (email) =>
    api.post('/auth/password/forgot', { email }, { skipAuthRefresh: true }),

  resetPassword: (token, password) =>
    api.post('/auth/password/reset', { token, password }, { skipAuthRefresh: true }),

  verifyEmail: (token) => api.post('/auth/email/verify', { token }, { skipAuthRefresh: true }),

  resendVerification: (email) =>
    api.post('/auth/email/resend', { email }, { skipAuthRefresh: true }),

  /** Where this account is signed in. `current: true` marks this browser. */
  sessions: () => api.get('/auth/sessions'),

  revokeSession: (id) => api.delete(`/auth/sessions/${id}`),

  /** Ends every session including this one, so the caller must sign out after. */
  signOutEverywhere: () => api.post('/auth/logout-all', {}),
}
