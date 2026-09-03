import { api } from '@/lib/api/client'
import type { CurrentUser, LoginInput, LoginResponse, SessionDto } from './auth.types'

/**
 * The auth endpoints, exactly as the server publishes them.
 *
 * `/auth` sits outside `/admin`, so these are not behind `requireStaff()` —
 * a customer account can log in here successfully and then be refused
 * everywhere else. `login()` therefore checks `isStaff` itself rather than
 * waiting for the first admin request to 403.
 */
export const authApi = {
  login: (input: LoginInput) =>
    // `skipAuthRefresh`: a 401 here means wrong credentials, not an expired
    // token, and trying to refresh would burn the cookie for no reason.
    api.post<LoginResponse>('/auth/login', input, { skipAuthRefresh: true }),

  me: () => api.get<CurrentUser>('/auth/me'),

  logout: () => api.post<void>('/auth/logout', {}, { skipAuthRefresh: true }),

  logoutAll: () => api.post<{ sessionsRevoked: number }>('/auth/logout-all'),

  sessions: () => api.get<SessionDto[]>('/auth/sessions'),

  revokeSession: (id: string) => api.delete<void>(`/auth/sessions/${id}`),

  changePassword: (input: { currentPassword: string; newPassword: string }) =>
    api.post<void>('/auth/password/change', input),

  // ── The three token flows ─────────────────────────────────────────────────
  //
  // All unauthenticated, all reached from a link in an email, and all
  // `skipAuthRefresh`: there is no session to refresh, and attempting one would
  // spend the refresh cookie of whoever was last signed in on this browser.

  /**
   * A colleague setting their first password.
   *
   * The server issues no session in return — the invitee signs in normally
   * afterwards, so there is exactly one login path to reason about.
   */
  acceptInvitation: (input: { token: string; password: string }) =>
    api.post<{ accepted: true }>('/auth/invitation/accept', input, { skipAuthRefresh: true }),

  /**
   * Starting a password reset.
   *
   * Always succeeds, whatever address is given: answering differently for an
   * address that has an account would turn this form into a way to discover who
   * works here.
   */
  requestPasswordReset: (email: string) =>
    api.post<void>('/auth/password/forgot', { email }, { skipAuthRefresh: true }),

  resetPassword: (input: { token: string; password: string }) =>
    api.post<void>('/auth/password/reset', input, { skipAuthRefresh: true }),
}
