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
}
