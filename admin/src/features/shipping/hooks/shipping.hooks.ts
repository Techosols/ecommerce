import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useAuth } from '@/features/auth/useAuth'
import { shippingApi } from '../api/shipping.api'
import type {
  CreateMethodInput,
  CreateZoneInput,
  MethodInput,
  UpdateZoneInput,
} from '../types/shipping.types'

export const shippingKeys = {
  all: ['shipping'] as const,
  zones: (includeArchived: boolean) => ['shipping', 'zones', includeArchived] as const,
  methods: (zoneId?: string) => ['shipping', 'methods', zoneId ?? 'all'] as const,
  quote: (params: { countryCode: string; subtotalCents: number; weightGrams: number }) =>
    ['shipping', 'quote', params] as const,
}

/**
 * Any change to the rate card changes the quote.
 *
 * Both are invalidated together because the preview on this screen is the real
 * storefront endpoint: editing a price and seeing the old quote would make the
 * preview look wrong when it was only stale.
 */
function invalidateRateCard(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: shippingKeys.all })
}

export function useZones(options: { includeArchived?: boolean } = {}) {
  const { can } = useAuth()
  const includeArchived = options.includeArchived ?? false
  return useQuery({
    queryKey: shippingKeys.zones(includeArchived),
    queryFn: () => shippingApi.zones({ includeArchived }),
    enabled: can('shipping:read'),
  })
}

export function useMethods(zoneId?: string) {
  const { can } = useAuth()
  return useQuery({
    queryKey: shippingKeys.methods(zoneId),
    queryFn: () => shippingApi.methods(zoneId),
    enabled: can('shipping:read'),
  })
}

export function useCreateZone() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateZoneInput) => shippingApi.createZone(input),
    onSuccess: () => invalidateRateCard(queryClient),
  })
}

export function useUpdateZone() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: string; patch: UpdateZoneInput }) =>
      shippingApi.updateZone(input.id, input.patch),
    onSuccess: () => invalidateRateCard(queryClient),
  })
}

export function useArchiveZone() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => shippingApi.archiveZone(id),
    onSuccess: () => invalidateRateCard(queryClient),
  })
}

export function useRestoreZone() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => shippingApi.restoreZone(id),
    onSuccess: () => invalidateRateCard(queryClient),
  })
}

export function useCreateMethod() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateMethodInput) => shippingApi.createMethod(input),
    onSuccess: () => invalidateRateCard(queryClient),
  })
}

export function useUpdateMethod() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: string; patch: Partial<MethodInput> }) =>
      shippingApi.updateMethod(input.id, input.patch),
    onSuccess: () => invalidateRateCard(queryClient),
  })
}

export function useArchiveMethod() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => shippingApi.archiveMethod(id),
    onSuccess: () => invalidateRateCard(queryClient),
  })
}

/**
 * What a shopper at this destination, with this basket, would be offered.
 *
 * Disabled until a country is chosen: an empty country is not a quote for
 * "everywhere", it is a request the server would refuse.
 */
export function useRateQuote(params: {
  countryCode: string
  subtotalCents: number
  weightGrams: number
}) {
  return useQuery({
    queryKey: shippingKeys.quote(params),
    queryFn: () => shippingApi.quote(params),
    enabled: /^[A-Z]{2}$/.test(params.countryCode),
  })
}
