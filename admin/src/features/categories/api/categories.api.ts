import { api } from '@/lib/api/client'
import type { Category, CreateCategoryInput, UpdateCategoryInput } from '../types/categories.types'

/**
 * The category endpoints from `catalogue.admin.routes.ts`.
 *
 * `list` takes no parameters: the server returns every category as a flat
 * array, with no pagination and no search. That is deliberate for a single
 * store — the whole set is small, and the tree cannot be assembled from a page
 * of it anyway — so filtering and searching happen in the browser over a list
 * that was going to be fetched in full regardless.
 *
 * `DELETE` archives. The server refuses while products or child categories
 * still point at the category, returning `CATEGORY_IN_USE`, because cascading
 * would silently re-classify products.
 */
export const categoriesApi = {
  list: () => api.get<Category[]>('/admin/categories'),

  create: (input: CreateCategoryInput) => api.post<Category>('/admin/categories', input),

  update: (id: string, patch: UpdateCategoryInput) =>
    api.patch<Category>(`/admin/categories/${id}`, patch),

  archive: (id: string) => api.delete<void>(`/admin/categories/${id}`),
}
