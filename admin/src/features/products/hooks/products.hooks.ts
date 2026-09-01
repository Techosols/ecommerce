import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { isForbiddenError } from '@/lib/api/errors'
import { useAuth } from '@/features/auth/useAuth'
import { productsApi } from '../api/products.api'
import type {
  AddOptionInput,
  AdjustmentReason,
  CreateProductInput,
  OptionInput,
  ProductDetail,
  ProductListParams,
  UpdateProductInput,
  UpdateVariantInput,
  VariantInput,
} from '../types/products.types'

export const productKeys = {
  all: ['products'] as const,
  lists: () => ['products', 'list'] as const,
  list: (params: ProductListParams) => ['products', 'list', params] as const,
  detail: (id: string) => ['products', 'detail', id] as const,
  inventory: (variantId: string) => ['products', 'inventory', variantId] as const,
}

/**
 * After any write, both the list and the edited product are suspect.
 *
 * Invalidating the whole `products` key rather than surgically patching one
 * cache entry: a rename changes the row in a list that may be sorted by title,
 * an archive can remove it from a filtered view entirely, and reasoning about
 * every such interaction is how caches drift from the server.
 */
function invalidateProducts(queryClient: QueryClient, product?: ProductDetail) {
  void queryClient.invalidateQueries({ queryKey: productKeys.all })
  // The response body is the fresh product, so the detail view it lands on has
  // no reason to refetch before painting.
  if (product) queryClient.setQueryData(productKeys.detail(product.id), product)
}

export function useProducts(params: ProductListParams) {
  return useQuery({
    queryKey: productKeys.list(params),
    queryFn: () => productsApi.list(params),
    // Keeps the previous page on screen while the next one loads, so paging
    // and typing in the search box do not flash an empty table.
    placeholderData: (previous) => previous,
  })
}

export function useProduct(id: string | undefined) {
  return useQuery({
    queryKey: productKeys.detail(id ?? 'none'),
    queryFn: () => productsApi.detail(id!),
    enabled: Boolean(id),
  })
}

/** Per-variant stock. Skipped entirely without `inventory:read`. */
export function useVariantInventory(variantId: string | undefined) {
  const { can } = useAuth()
  const allowed = can('inventory:read')

  return useQuery({
    queryKey: productKeys.inventory(variantId ?? 'none'),
    queryFn: () => productsApi.variantInventory(variantId!),
    enabled: Boolean(variantId) && allowed,
    retry: (failureCount, error) => !isForbiddenError(error) && failureCount < 1,
  })
}

// ── Mutations ───────────────────────────────────────────────────────────────

export function useCreateProduct() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateProductInput) => productsApi.create(input),
    onSuccess: (product) => invalidateProducts(queryClient, product),
  })
}

export function useUpdateProduct(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: UpdateProductInput) => productsApi.update(id, patch),
    onSuccess: (product) => invalidateProducts(queryClient, product),
  })
}

export function useReplaceOptions(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (options: OptionInput[]) => productsApi.replaceOptions(id, options),
    onSuccess: (product) => invalidateProducts(queryClient, product),
  })
}

export function useAddOption(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: AddOptionInput) => productsApi.addOption(id, input),
    onSuccess: (product) => invalidateProducts(queryClient, product),
  })
}

export function useAddOptionValue(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ optionId, value }: { optionId: string; value: string }) =>
      productsApi.addOptionValue(id, optionId, value),
    onSuccess: (product) => invalidateProducts(queryClient, product),
  })
}

export function useSetOptionValueSwatch(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      optionId,
      valueId,
      swatchHex,
    }: {
      optionId: string
      valueId: string
      swatchHex: string | null
    }) => productsApi.setOptionValueSwatch(id, optionId, valueId, swatchHex),
    onSuccess: (product) => invalidateProducts(queryClient, product),
  })
}

export function useRemoveOptionValue(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ optionId, valueId }: { optionId: string; valueId: string }) =>
      productsApi.removeOptionValue(id, optionId, valueId),
    onSuccess: (product) => invalidateProducts(queryClient, product),
  })
}

/**
 * The lifecycle transitions, as one mutation keyed by the action.
 *
 * They share a shape — id in, fresh product out — and keeping them together
 * means the confirmation dialog, the toast and the cache invalidation are
 * written once instead of four times.
 */
export type ProductLifecycleAction = 'activate' | 'archive' | 'restore'

export function useProductLifecycle() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: ProductLifecycleAction }) =>
      productsApi[action](id),
    onSuccess: (product) => invalidateProducts(queryClient, product),
  })
}

export function useProductPublication() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, publish, channel }: { id: string; publish: boolean; channel?: string }) =>
      publish ? productsApi.publish(id, channel) : productsApi.unpublish(id, channel),
    onSuccess: (product) => invalidateProducts(queryClient, product),
  })
}

export function useAddVariant(productId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: VariantInput) => productsApi.addVariant(productId, input),
    // The variant response is a variant, not a product, so the detail cache has
    // to be refetched rather than written.
    onSuccess: () => invalidateProducts(queryClient),
  })
}

export function useUpdateVariant() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ variantId, patch }: { variantId: string; patch: UpdateVariantInput }) =>
      productsApi.updateVariant(variantId, patch),
    onSuccess: () => invalidateProducts(queryClient),
  })
}

export function useArchiveVariant() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (variantId: string) => productsApi.archiveVariant(variantId),
    onSuccess: () => invalidateProducts(queryClient),
  })
}

// ── Media ───────────────────────────────────────────────────────────────────

/**
 * Moving stock.
 *
 * Invalidates only the inventory keys: a stock change does not alter the
 * product row, and refetching the whole product would throw away a form the
 * operator may still be filling in.
 */
export function useAdjustStock() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      variantId: string
      delta: number
      reason: AdjustmentReason
      note?: string | null
    }) => productsApi.adjustStock(input),
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: productKeys.inventory(input.variantId) })
      // The dashboard counts low and out-of-stock variants.
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}

export function useUpdateInventoryItem(variantId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      inventoryItemId,
      patch,
    }: {
      inventoryItemId: string
      patch: { trackInventory?: boolean; lowStockThreshold?: number | null }
    }) => productsApi.updateInventoryItem(inventoryItemId, patch),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: productKeys.inventory(variantId) }),
  })
}

export function useAttachProductMedia(productId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { mediaId: string; alt?: string | null; isPrimary?: boolean }) =>
      productsApi.attachMedia(productId, input),
    onSuccess: (product) => invalidateProducts(queryClient, product),
  })
}

export function useReorderProductMedia(productId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ order, primaryId }: { order: string[]; primaryId?: string }) =>
      productsApi.reorderMedia(productId, order, primaryId),
    onSuccess: (product) => invalidateProducts(queryClient, product),
  })
}

export function useDetachProductMedia(productId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (productMediaId: string) => productsApi.detachMedia(productId, productMediaId),
    onSuccess: () => invalidateProducts(queryClient),
  })
}
