import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { categoriesApi } from '../api/categories.api'
import type {
  Category,
  CategoryNode,
  CreateCategoryInput,
  UpdateCategoryInput,
} from '../types/categories.types'

export const categoryKeys = {
  all: ['categories'] as const,
  list: ['categories', 'list'] as const,
}

/**
 * Every category, once.
 *
 * A long `staleTime` because the set changes rarely and three screens read it —
 * the category page, the product filter and the product form all share this one
 * request rather than each making their own.
 */
export function useCategories() {
  return useQuery({
    queryKey: categoryKeys.list,
    queryFn: () => categoriesApi.list(),
    staleTime: 5 * 60_000,
  })
}

/**
 * The flat list arranged into a tree.
 *
 * Done in the browser because the admin endpoint returns a flat array and the
 * whole set is already in hand; this is presentation, not business logic — the
 * server owns the rules about depth and cycles and enforces them on every
 * write.
 *
 * A node whose parent is missing from the list becomes a root rather than
 * disappearing, which is the same rule the server's own tree builder applies.
 */
export function toTree(categories: Category[]): CategoryNode[] {
  const nodes = new Map<string, CategoryNode>(
    categories.map((category) => [category.id, { ...category, children: [], depth: 0 }]),
  )
  const roots: CategoryNode[] = []

  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  const byPosition = (a: CategoryNode, b: CategoryNode) =>
    a.position - b.position || a.name.localeCompare(b.name)

  function assignDepth(node: CategoryNode, depth: number) {
    node.depth = depth
    node.children.sort(byPosition)
    for (const child of node.children) assignDepth(child, depth + 1)
  }

  roots.sort(byPosition)
  for (const root of roots) assignDepth(root, 0)
  return roots
}

/** Depth-first, so a table row can be indented by `depth` and still read as a tree. */
export function flattenTree(nodes: CategoryNode[]): CategoryNode[] {
  return nodes.flatMap((node) => [node, ...flattenTree(node.children)])
}

/**
 * The ids a category may not be re-parented to: itself and its descendants.
 *
 * The server refuses such a move with `CATEGORY_CYCLE`; excluding them from the
 * picker means an operator never gets that far.
 */
export function descendantIds(nodes: CategoryNode[], id: string): Set<string> {
  const blocked = new Set<string>()

  function walk(node: CategoryNode, inside: boolean) {
    if (inside || node.id === id) {
      blocked.add(node.id)
      for (const child of node.children) walk(child, true)
      return
    }
    for (const child of node.children) walk(child, false)
  }

  for (const node of nodes) walk(node, false)
  return blocked
}

export function useCategoryTree() {
  const query = useCategories()
  const tree = useMemo(() => toTree(query.data ?? []), [query.data])
  const flat = useMemo(() => flattenTree(tree), [tree])
  const byId = useMemo(
    () => new Map((query.data ?? []).map((category) => [category.id, category])),
    [query.data],
  )
  return { ...query, tree, flat, byId }
}

export function useCreateCategory() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateCategoryInput) => categoriesApi.create(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: categoryKeys.all }),
  })
}

export function useUpdateCategory() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateCategoryInput }) =>
      categoriesApi.update(id, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: categoryKeys.all }),
  })
}

export function useArchiveCategory() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => categoriesApi.archive(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: categoryKeys.all })
      // A product's category may have just gone; product rows show its name.
      void queryClient.invalidateQueries({ queryKey: ['products'] })
    },
  })
}
