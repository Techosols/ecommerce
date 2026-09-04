import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/features/auth/useAuth'
import { metafieldsApi } from '../api/metafields.api'
import type {
  CreateDefinitionInput,
  MetafieldOwnerType,
  UpdateDefinitionInput,
} from '../types/metafields.types'

export const metafieldKeys = {
  all: ['metafields'] as const,
  definitions: (ownerType?: MetafieldOwnerType) =>
    ['metafields', 'definitions', ownerType ?? 'all'] as const,
  values: (ownerType: MetafieldOwnerType, ownerId: string) =>
    ['metafields', 'values', ownerType, ownerId] as const,
}

export function useDefinitions(ownerType?: MetafieldOwnerType) {
  const { can } = useAuth()
  return useQuery({
    queryKey: metafieldKeys.definitions(ownerType),
    queryFn: () => metafieldsApi.definitions(ownerType),
    enabled: can('settings:read'),
  })
}

/**
 * The fields on one record.
 *
 * Not gated on a permission here: which permission applies depends on the
 * record's type, the caller already knows it, and the server checks it either
 * way. `enabled` takes the caller's own answer instead.
 */
export function useMetafieldValues(
  ownerType: MetafieldOwnerType,
  ownerId: string | undefined,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: metafieldKeys.values(ownerType, ownerId ?? 'none'),
    queryFn: () => metafieldsApi.values(ownerType, ownerId as string),
    enabled: Boolean(ownerId) && (options.enabled ?? true),
  })
}

export function useSetMetafieldValues(ownerType: MetafieldOwnerType, ownerId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (values: { definitionId: string; value: unknown }[]) =>
      metafieldsApi.setValues(ownerType, ownerId, values),
    onSuccess: (data) => {
      // The server returns the saved state, so the cache is set from the
      // response rather than refetched — the values are already here, and a
      // second request would only be a slower way to display them.
      queryClient.setQueryData(metafieldKeys.values(ownerType, ownerId), data)
    },
  })
}

export function useCreateDefinition() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateDefinitionInput) => metafieldsApi.createDefinition(input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: metafieldKeys.all }),
  })
}

export function useUpdateDefinition() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: string; patch: UpdateDefinitionInput }) =>
      metafieldsApi.updateDefinition(input.id, input.patch),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: metafieldKeys.all }),
  })
}

export function useDeleteDefinition() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => metafieldsApi.deleteDefinition(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: metafieldKeys.all }),
  })
}
