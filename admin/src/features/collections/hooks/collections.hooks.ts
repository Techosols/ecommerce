import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { RuleSet } from '@/components/rules'
import { useAuth } from '@/features/auth/useAuth'
import { productKeys } from '@/features/products/hooks/products.hooks'
import { collectionsApi } from '../api/collections.api'
import type {
  BulkActionInput,
  CreateCollectionInput,
  UpdateCollectionInput,
} from '../types/collections.types'

export const collectionKeys = {
  all: ['collections'] as const,
  list: ['collections', 'list'] as const,
  detail: (id: string) => ['collections', 'detail', id] as const,
  forProduct: (productId: string) => ['collections', 'product', productId] as const,
  ruleFields: ['collections', 'ruleFields'] as const,
}

/**
 * A collection write is a product write.
 *
 * Membership is part of a product's detail, and a smart collection's membership
 * changes whenever a product's price, stock or tags do — so the two caches move
 * together or one of them is showing something that stopped being true.
 */
function invalidateCollections(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: collectionKeys.all })
  void queryClient.invalidateQueries({ queryKey: productKeys.all })
}

export function useCollections() {
  const { can } = useAuth()
  return useQuery({
    queryKey: collectionKeys.list,
    queryFn: () => collectionsApi.list(),
    enabled: can('catalog:read'),
  })
}

export function useCollection(id: string | undefined) {
  return useQuery({
    queryKey: collectionKeys.detail(id ?? 'none'),
    queryFn: () => collectionsApi.detail(id!),
    enabled: Boolean(id),
  })
}

/** The collections one product is in, both kinds. */
export function useProductCollections(productId: string | undefined) {
  const { can } = useAuth()
  return useQuery({
    queryKey: collectionKeys.forProduct(productId ?? 'none'),
    queryFn: () => collectionsApi.forProduct(productId!),
    enabled: Boolean(productId) && can('catalog:read'),
  })
}

/**
 * The server's product field catalogue.
 *
 * Held for the session: it changes when the server is deployed, not while
 * somebody is writing a rule.
 */
export function useCollectionRuleFields() {
  const { can } = useAuth()
  return useQuery({
    queryKey: collectionKeys.ruleFields,
    queryFn: () => collectionsApi.ruleFields(),
    enabled: can('catalog:read'),
    staleTime: Infinity,
  })
}

// ── Mutations ───────────────────────────────────────────────────────────────

export function useCreateCollection() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateCollectionInput) => collectionsApi.create(input),
    onSuccess: () => invalidateCollections(queryClient),
  })
}

export function useUpdateCollection(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: UpdateCollectionInput) => collectionsApi.update(id, input),
    onSuccess: () => invalidateCollections(queryClient),
  })
}

export function useArchiveCollection() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => collectionsApi.archive(id),
    onSuccess: () => invalidateCollections(queryClient),
  })
}

/** Replaces membership and order wholesale — the reorder path. */
export function useSetCollectionProducts(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (productIds: string[]) => collectionsApi.setProducts(id, productIds),
    onSuccess: () => invalidateCollections(queryClient),
  })
}

export function useCollectionProducts(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { productIds: string[]; action: 'add' | 'remove' }) =>
      input.action === 'add'
        ? collectionsApi.addProducts(id, input.productIds)
        : collectionsApi.removeProducts(id, input.productIds),
    onSuccess: () => invalidateCollections(queryClient),
  })
}

/**
 * What an unsaved rule set would match.
 *
 * A mutation rather than a query: it is asked for when the rules settle, not on
 * every keystroke, and a query keyed on the rules would refetch on every
 * character typed into a value.
 */
export function usePreviewCollection() {
  return useMutation({
    mutationFn: (rules: RuleSet) => collectionsApi.preview(rules),
  })
}

export function useBulkProductAction() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: BulkActionInput) => collectionsApi.bulk(input),
    onSuccess: () => invalidateCollections(queryClient),
  })
}
