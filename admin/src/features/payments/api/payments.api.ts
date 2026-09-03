import { api } from '@/lib/api/client'
import type {
  PaymentListParams,
  PaymentProof,
  PaymentRow,
  ProofListParams,
} from '../types/payments.types'

/**
 * The payments endpoints, exactly as `payments.admin.routes.ts` publishes them.
 *
 * Note what `approve` does *not* send: an amount. The server records the
 * order's own outstanding balance, computed from the order. A client that could
 * name a figure here would be a client that could be talked into agreeing with
 * a forged screenshot, so the request body is empty on purpose.
 */
export const paymentsApi = {
  /** The ledger, across every order. */
  list: (params: PaymentListParams) =>
    api.list<PaymentRow>('/admin/payments', {
      query: {
        page: params.page,
        limit: params.limit,
        method: params.method,
        status: params.status,
      },
    }),

  /** The review queue. `meta.pending` carries the count still waiting. */
  proofs: (params: ProofListParams) =>
    api.list<PaymentProof>('/admin/payments/proofs', {
      query: { page: params.page, limit: params.limit, status: params.status },
    }),

  proof: (id: string) => api.get<PaymentProof>(`/admin/payments/proofs/${id}`),

  /** Every receipt sent for one order, for the order page. */
  forOrder: (orderId: string) => api.get<PaymentProof[]>(`/admin/orders/${orderId}/payment-proofs`),

  approve: (id: string) => api.post<PaymentProof>(`/admin/payments/proofs/${id}/approve`),

  /** The note is required, and is shown to the customer. */
  reject: (id: string, note: string) =>
    api.post<PaymentProof>(`/admin/payments/proofs/${id}/reject`, { note }),
}
