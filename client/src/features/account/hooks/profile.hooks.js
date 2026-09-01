import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { profileApi } from '../api/profile.api'

export const profileKeys = {
  profile: ['account', 'profile'],
  addresses: ['account', 'addresses'],
}

export function useProfile(enabled) {
  return useQuery({
    queryKey: profileKeys.profile,
    queryFn: () => profileApi.get(),
    enabled,
  })
}

export function useUpdateProfile() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch) => profileApi.update(patch),
    // The response is the updated profile, so the screen adopts it rather than
    // asking the same question twice.
    onSuccess: (profile) => queryClient.setQueryData(profileKeys.profile, profile),
  })
}

export function useAddresses(enabled) {
  return useQuery({
    queryKey: profileKeys.addresses,
    queryFn: () => profileApi.addresses(),
    enabled,
  })
}

/**
 * Every address write re-reads the list rather than patching the local copy.
 *
 * Not laziness — a necessity. Saving an address as the default *unsets* the
 * previous one, and deleting the default *promotes* another. Both are decisions
 * the server makes about rows this response does not contain, so a client that
 * spliced its own array would show two defaults, or none.
 */
function useAddressWrite(mutationFn) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: profileKeys.addresses }),
  })
}

export function useCreateAddress() {
  return useAddressWrite((body) => profileApi.createAddress(body))
}

export function useUpdateAddress() {
  return useAddressWrite(({ id, patch }) => profileApi.updateAddress(id, patch))
}

export function useRemoveAddress() {
  return useAddressWrite((id) => profileApi.removeAddress(id))
}
