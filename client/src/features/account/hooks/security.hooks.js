import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { securityApi } from '../api/security.api'

export const securityKeys = { sessions: ['account', 'sessions'] }

export function useSessions(enabled) {
  return useQuery({
    queryKey: securityKeys.sessions,
    queryFn: () => securityApi.sessions(),
    enabled,
    // Sessions are the screen somebody opens *because* they suspect something.
    // A cached answer is the one thing that would make it useless.
    staleTime: 0,
  })
}

export function useChangePassword() {
  return useMutation({
    mutationFn: ({ currentPassword, newPassword }) =>
      securityApi.changePassword(currentPassword, newPassword),
  })
}

export function useRevokeSession() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id) => securityApi.revokeSession(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: securityKeys.sessions }),
  })
}

export function useForgotPassword() {
  return useMutation({ mutationFn: (email) => securityApi.forgotPassword(email) })
}

export function useResetPassword() {
  return useMutation({
    mutationFn: ({ token, password }) => securityApi.resetPassword(token, password),
  })
}

export function useResendVerification() {
  return useMutation({ mutationFn: (email) => securityApi.resendVerification(email) })
}
