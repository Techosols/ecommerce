import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useAuth } from '@/features/auth/useAuth'
import { productKeys } from '@/features/products/hooks/products.hooks'
import { inventoryApi } from '../api/inventory.api'
import type {
  AdjustmentInput,
  CreateLocationInput,
  InventoryListParams,
  MovementListParams,
  StocktakeInput,
  TransferInput,
  UpdateLocationInput,
} from '../types/inventory.types'

export const inventoryKeys = {
  all: ['inventory'] as const,
  list: (params: InventoryListParams) => ['inventory', 'list', params] as const,
  item: (id: string) => ['inventory', 'item', id] as const,
  history: (id: string, params: MovementListParams) =>
    ['inventory', 'history', id, params] as const,
  reservations: (id: string) => ['inventory', 'reservations', id] as const,
  locations: ['inventory', 'locations'] as const,
}

/**
 * A stock movement changes more than the level it touched.
 *
 * It changes the item, the ledger, the list it appears in, and whether the
 * product is buyable at all — which the product screens show. Invalidating the
 * product keys as well is what stops a product page saying "in stock" about
 * something just written off.
 */
function invalidateStock(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
  void queryClient.invalidateQueries({ queryKey: productKeys.all })
}

export function useInventoryList(params: InventoryListParams) {
  const { can } = useAuth()
  return useQuery({
    queryKey: inventoryKeys.list(params),
    queryFn: () => inventoryApi.list(params),
    enabled: can('inventory:read'),
    placeholderData: (previous) => previous,
  })
}

export function useInventoryItem(id: string | undefined) {
  const { can } = useAuth()
  return useQuery({
    queryKey: inventoryKeys.item(id ?? 'none'),
    queryFn: () => inventoryApi.item(id!),
    enabled: Boolean(id) && can('inventory:read'),
  })
}

export function useStockHistory(id: string | undefined, params: MovementListParams) {
  const { can } = useAuth()
  return useQuery({
    queryKey: inventoryKeys.history(id ?? 'none', params),
    queryFn: () => inventoryApi.history(id!, params),
    enabled: Boolean(id) && can('inventory:read'),
    placeholderData: (previous) => previous,
  })
}

export function useReservations(id: string | undefined) {
  const { can } = useAuth()
  return useQuery({
    queryKey: inventoryKeys.reservations(id ?? 'none'),
    queryFn: () => inventoryApi.reservations(id!),
    enabled: Boolean(id) && can('inventory:read'),
  })
}

/** Locations change a few times a year; held for the session. */
export function useLocations() {
  const { can } = useAuth()
  return useQuery({
    queryKey: inventoryKeys.locations,
    queryFn: () => inventoryApi.locations(),
    enabled: can('inventory:read'),
    staleTime: 300_000,
  })
}

// ── Movements ───────────────────────────────────────────────────────────────

export function useAdjustStock() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: AdjustmentInput) => inventoryApi.adjust(input),
    onSuccess: () => invalidateStock(queryClient),
  })
}

export function useStocktake() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: StocktakeInput) => inventoryApi.stocktake(input),
    onSuccess: () => invalidateStock(queryClient),
  })
}

export function useTransferStock() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: TransferInput) => inventoryApi.transfer(input),
    onSuccess: () => invalidateStock(queryClient),
  })
}

export function useUpdateItemPolicy(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: { trackInventory?: boolean; lowStockThreshold?: number | null }) =>
      inventoryApi.updateItem(id, patch),
    onSuccess: () => invalidateStock(queryClient),
  })
}

// ── Locations ───────────────────────────────────────────────────────────────

function invalidateLocations(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
}

export function useCreateLocation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateLocationInput) => inventoryApi.createLocation(input),
    onSuccess: () => invalidateLocations(queryClient),
  })
}

export function useUpdateLocation(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: UpdateLocationInput) => inventoryApi.updateLocation(id, input),
    onSuccess: () => invalidateLocations(queryClient),
  })
}

export function useArchiveLocation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => inventoryApi.archiveLocation(id),
    onSuccess: () => invalidateLocations(queryClient),
  })
}
