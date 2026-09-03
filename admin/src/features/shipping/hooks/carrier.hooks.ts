import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/features/auth/useAuth'
import { carrierApi } from '../api/carrier.api'
import type { ImportRemittanceInput } from '../types/carrier.types'

export const carrierKeys = {
  all: ['carrier'] as const,
  capabilities: () => ['carrier', 'capabilities'] as const,
  tracking: (shipmentId: string) => ['carrier', 'tracking', shipmentId] as const,
  remittances: (page: number) => ['carrier', 'remittances', page] as const,
  remittance: (id: string) => ['carrier', 'remittance', id] as const,
}

/**
 * Which courier is connected, and what it can do.
 *
 * Cached for the session rather than refetched: this changes when somebody
 * edits an environment variable and restarts the server, which is not something
 * a screen can watch for.
 */
export function useCarrierCapabilities() {
  const { can } = useAuth()
  return useQuery({
    queryKey: carrierKeys.capabilities(),
    queryFn: () => carrierApi.capabilities(),
    enabled: can('shipping:read'),
    staleTime: Infinity,
  })
}

/**
 * The scan trail for a parcel.
 *
 * `enabled` takes the shipment id *and* whether the courier reports tracking at
 * all: with no courier connected there are no scans to fetch, and asking would
 * be a request per shipment on every order page for an empty list.
 */
export function useTracking(shipmentId: string | null, options: { enabled?: boolean } = {}) {
  const { can } = useAuth()
  return useQuery({
    queryKey: carrierKeys.tracking(shipmentId ?? 'none'),
    queryFn: () => carrierApi.tracking(shipmentId as string),
    enabled: can('shipping:read') && Boolean(shipmentId) && (options.enabled ?? true),
  })
}

export function useRemittances(page: number, limit = 20) {
  const { can } = useAuth()
  return useQuery({
    queryKey: carrierKeys.remittances(page),
    queryFn: () => carrierApi.remittances({ page, limit }),
    enabled: can('payments:read'),
  })
}

export function useRemittance(id: string | null) {
  const { can } = useAuth()
  return useQuery({
    queryKey: carrierKeys.remittance(id ?? 'none'),
    queryFn: () => carrierApi.remittance(id as string),
    enabled: can('payments:read') && Boolean(id),
  })
}

export function useImportRemittance() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: ImportRemittanceInput) => carrierApi.importRemittance(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: carrierKeys.all })
    },
  })
}

/**
 * Banks one line.
 *
 * Everything is invalidated afterwards, not just the statement: settling
 * records a payment, which changes the order's payment status, the payments
 * list and the dashboard. Being precise here would mean listing every screen
 * that shows money — and forgetting one, which is how an operator ends up
 * looking at an order that says unpaid after they have just banked it.
 */
export function useSettleCodLine() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (lineId: string) => carrierApi.settleLine(lineId),
    onSuccess: () => {
      void queryClient.invalidateQueries()
    },
  })
}
