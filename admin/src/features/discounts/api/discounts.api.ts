import { api } from '@/lib/api/client'
import type {
  CreateDiscountInput,
  DiscountDetail,
  DiscountListParams,
  DiscountSummary,
  Redemption,
  UpdateDiscountInput,
} from '../types/discounts.types'

/**
 * The discount endpoints, as `discounts.admin.routes.ts` publishes them.
 *
 * `discounts:read` and `discounts:write` — and note that staff hold neither by
 * default. Creating money-off is a commercial decision, and so is knowing what
 * a campaign cost, which is why the redemption ledger sits behind the same
 * read permission rather than being public to anyone who can see an order.
 *
 * There is no delete. `DELETE /discounts/:id` archives: `order_discounts`
 * records the code and its terms as they were, and removing the row would
 * leave those orders citing a discount nobody can look up.
 */
export const discountsApi = {
  list: (params: DiscountListParams) =>
    api.list<DiscountSummary>('/admin/discounts', {
      query: {
        page: params.page,
        limit: params.limit,
        q: params.q,
        status: params.status,
        includeArchived: params.includeArchived,
      },
    }),

  get: (id: string) => api.get<DiscountDetail>(`/admin/discounts/${id}`),

  create: (body: CreateDiscountInput) => api.post<DiscountDetail>('/admin/discounts', body),

  update: (id: string, body: UpdateDiscountInput) =>
    api.patch<DiscountDetail>(`/admin/discounts/${id}`, body),

  /** Archives. The code and its terms stay readable for the orders that used it. */
  archive: (id: string) => api.delete<void>(`/admin/discounts/${id}`),

  /**
   * What the code actually gave away, order by order.
   *
   * `meta.totalAmount` carries the campaign's whole cost, so the page never
   * sums one page of rows and calls that the total.
   */
  redemptions: (id: string, params: { page?: number; limit?: number } = {}) =>
    api.list<Redemption>(`/admin/discounts/${id}/redemptions`, {
      query: { page: params.page, limit: params.limit },
    }),
}
