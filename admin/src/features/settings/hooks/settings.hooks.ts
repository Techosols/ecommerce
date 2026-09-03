import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/features/auth/useAuth'
import { storeKeys } from '../store.hooks'
import { settingsApi } from '../api/settings.api'
import type { AuditQuery, InviteStaffInput, StoreSettingsPatch } from '../types/settings.types'

export const settingsKeys = {
  all: ['settings'] as const,
  store: ['settings', 'store'] as const,
  staff: (params: { page?: number; limit?: number }) => ['settings', 'staff', params] as const,
  roles: ['settings', 'roles'] as const,
  audit: (params: AuditQuery) => ['settings', 'audit', params] as const,
  sessions: ['settings', 'sessions'] as const,
}

export function useStoreSettingsAdmin() {
  const { can } = useAuth()
  return useQuery({
    queryKey: settingsKeys.store,
    queryFn: () => settingsApi.get(),
    enabled: can('settings:read'),
  })
}

/**
 * Saves a patch of what changed.
 *
 * Also drops the *public* settings cache, which is a different query: the
 * currency, the store name and the logo are read from `/storefront/settings` by
 * every price field and the layout header. Leaving that stale means changing
 * the currency here and watching product forms keep the old symbol.
 */
export function useUpdateStoreSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: StoreSettingsPatch) => settingsApi.update(patch),
    onSuccess: (settings) => {
      queryClient.setQueryData(settingsKeys.store, settings)
      void queryClient.invalidateQueries({ queryKey: storeKeys.settings })
    },
  })
}

// ── Staff and roles ─────────────────────────────────────────────────────────

export function useEmailTemplates() {
  return useQuery({
    queryKey: ['settings', 'emails'],
    queryFn: () => settingsApi.emailTemplates(),
  })
}

/**
 * The mail log.
 *
 * `staleTime: 0` and a short refetch: somebody is looking at this screen
 * precisely because a message is in flight or stuck, and a cached answer from
 * two minutes ago is the one thing that cannot help them.
 */
export function useEmailLog(params: { page?: number; status?: string; to?: string } = {}) {
  return useQuery({
    queryKey: ['settings', 'email-log', params],
    queryFn: () => settingsApi.emailLog({ ...params, limit: 20 }),
    placeholderData: (previous) => previous,
    staleTime: 0,
  })
}

export function useSendTestEmail() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (to: string) => settingsApi.sendTestEmail(to),
    onSuccess: () => {
      // The log is where the answer actually appears, so bring it up to date.
      void queryClient.invalidateQueries({ queryKey: ['settings', 'email-log'] })
    },
  })
}

export function useRetryEmail() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => settingsApi.retryEmail(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings', 'email-log'] })
    },
  })
}

export function useSetEmailTemplate() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ template, enabled }: { template: string; enabled: boolean }) =>
      settingsApi.setEmailTemplate(template, enabled),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings', 'emails'] })
    },
  })
}

export function useStaff(params: { page?: number; limit?: number } = {}) {
  const { can } = useAuth()
  return useQuery({
    queryKey: settingsKeys.staff(params),
    queryFn: () => settingsApi.staff(params),
    enabled: can('staff:read'),
    placeholderData: (previous) => previous,
  })
}

/** The role catalogue with its permissions. Changes only on a deploy. */
export function useRoles() {
  const { can } = useAuth()
  return useQuery({
    queryKey: settingsKeys.roles,
    queryFn: () => settingsApi.roles(),
    enabled: can('staff:read'),
    staleTime: 60 * 60_000,
  })
}

function useStaffMutation<TInput, TResult>(fn: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings', 'staff'] })
    },
  })
}

export function useInviteStaff() {
  return useStaffMutation((input: InviteStaffInput) => settingsApi.invite(input))
}

export function useResendInvitation() {
  return useMutation({ mutationFn: (id: string) => settingsApi.resendInvitation(id) })
}

export function useSetStaffRoles() {
  return useStaffMutation((input: { id: string; roles: string[] }) =>
    settingsApi.setRoles(input.id, input.roles),
  )
}

export function useSetStaffStatus() {
  return useStaffMutation((input: { id: string; status: 'active' | 'disabled' }) =>
    settingsApi.setStatus(input.id, input.status),
  )
}

// ── The audit trail ─────────────────────────────────────────────────────────

export function useAuditLogs(params: AuditQuery) {
  const { can } = useAuth()
  return useQuery({
    queryKey: settingsKeys.audit(params),
    queryFn: () => settingsApi.auditLogs(params),
    enabled: can('audit:read'),
    placeholderData: (previous) => previous,
  })
}

// ── The operator's own account ──────────────────────────────────────────────

export function useSessions() {
  return useQuery({ queryKey: settingsKeys.sessions, queryFn: () => settingsApi.sessions() })
}

export function useRevokeSession() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => settingsApi.revokeSession(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.sessions })
    },
  })
}

/**
 * Changes the operator's own password.
 *
 * The server keeps *this* session and revokes every other one, so the session
 * list is stale the moment this succeeds.
 */
export function useChangePassword() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: { currentPassword: string; newPassword: string }) =>
      settingsApi.changePassword(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.sessions })
    },
  })
}
