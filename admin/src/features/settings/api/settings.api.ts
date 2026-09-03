import { api } from '@/lib/api/client'
import type {
  EmailLogEntry,
  EmailTemplateSetting,
  AuditQuery,
  AuditRecord,
  InviteStaffInput,
  Role,
  Session,
  StaffMember,
  StoreSettings,
  StoreSettingsPatch,
} from '../types/settings.types'

/**
 * Everything the settings section talks to.
 *
 * Four permissions divide it, and they are not the same one: `settings:read`
 * and `settings:write` for the store, `staff:read` / `staff:write` and
 * `roles:assign` for people, `audit:read` for the trail. An operator may hold
 * any subset, so each screen asks for its own and nothing renders on a
 * permission somebody else needs.
 *
 * Notice what is absent: there is no `DELETE /admin/staff/:id`. An account that
 * has done things is disabled, never removed — the audit trail names it, and
 * deleting the row would leave the trail citing nobody.
 */
export const settingsApi = {
  get: () => api.get<StoreSettings>('/admin/settings'),

  update: (patch: StoreSettingsPatch) => api.patch<StoreSettings>('/admin/settings', patch),

  // ── Emails ────────────────────────────────────────────────────────────────

  /**
   * Every template the server knows about, with its current state.
   *
   * Driven by the server's registry, not by a list kept here — a template added
   * on the server appears in this screen without a frontend release, which is
   * the whole reason the endpoint returns the catalogue rather than just the
   * overrides.
   */
  emailTemplates: () => api.get<EmailTemplateSetting[]>('/admin/settings/emails'),

  /**
   * What the shop actually sent, and what became of it.
   *
   * The delivery half of the screen above. Every status is a different problem
   * with a different fix, and from an empty inbox they look identical.
   */
  emailLog: (params: { page?: number; limit?: number; status?: string; to?: string } = {}) =>
    api.list<EmailLogEntry>('/admin/settings/emails/log', {
      query: {
        page: params.page,
        limit: params.limit,
        status: params.status,
        to: params.to,
      },
    }),

  /**
   * Proves delivery works, without placing an order to find out.
   *
   * Deliberately takes an address: mailing the shop's own contact address only
   * proves the server can deliver to itself, which is exactly the case that
   * looks healthy while every customer email is being refused.
   */
  sendTestEmail: (to: string) =>
    api.post<{ id: string; status: string }>('/admin/settings/emails/test', { to }),

  /**
   * Sends one message again, after fixing whatever stopped it.
   *
   * Refused for a message that already went out — a duplicate order
   * confirmation is a worse outcome than none.
   */
  retryEmail: (id: string) =>
    api.post<EmailLogEntry>(`/admin/settings/emails/log/${id}/retry`),

  setEmailTemplate: (template: string, enabled: boolean) =>
    api.patch<{ template: string; enabled: boolean }>(`/admin/settings/emails/${template}`, {
      enabled,
    }),

  // ── Staff ─────────────────────────────────────────────────────────────────

  staff: (params: { page?: number; limit?: number } = {}) =>
    api.list<StaffMember>('/admin/staff', {
      query: { page: params.page, limit: params.limit },
    }),

  roles: () => api.get<Role[]>('/admin/roles'),

  /**
   * Invites a staff member. The account is created with **no password** — the
   * invitee sets one from a single-use link — so there is nothing here for an
   * admin to type, hand over, or leak.
   */
  invite: (body: InviteStaffInput) => api.post<StaffMember>('/admin/staff', body),

  resendInvitation: (id: string) =>
    api.post<{ message: string }>(`/admin/staff/${id}/resend-invitation`),

  setRoles: (id: string, roles: string[]) =>
    api.patch<StaffMember>(`/admin/staff/${id}/roles`, { roles }),

  /** Disabling revokes the account's sessions server-side, in the same call. */
  setStatus: (id: string, status: 'active' | 'disabled') =>
    api.patch<StaffMember>(`/admin/staff/${id}/status`, { status }),

  // ── The audit trail ───────────────────────────────────────────────────────

  auditLogs: (params: AuditQuery) =>
    api.list<AuditRecord>('/admin/audit-logs', {
      query: {
        page: params.page,
        limit: params.limit,
        actorUserId: params.actorUserId,
        action: params.action,
        resourceType: params.resourceType,
        resourceId: params.resourceId,
        from: params.from,
        to: params.to,
      },
    }),

  // ── The operator's own account ────────────────────────────────────────────

  sessions: () => api.get<Session[]>('/auth/sessions'),

  revokeSession: (id: string) => api.delete<void>(`/auth/sessions/${id}`),

  changePassword: (body: { currentPassword: string; newPassword: string }) =>
    api.post<{ changed: true }>('/auth/password/change', body),
}
