import type { RuleField, RuleSet } from '@/components/rules'
import { api, download } from '@/lib/api/client'
import type {
  CreateCustomerInput,
  CustomerDetail,
  CustomerEvent,
  CustomerListParams,
  CustomerSegment,
  CustomerStatus,
  CustomerSummary,
  MarketingState,
  OptInLevel,
  SegmentPreview,
  UpdateCustomerInput,
} from '../types/customers.types'

/**
 * The customer endpoints, exactly as `customers.admin.routes.ts` publishes them.
 *
 * Consent is its own route taking a channel and a state, not a field in the
 * profile patch — because a shop has to be able to say *when* and *how* consent
 * moved, and a value buried in a general update carries neither.
 *
 * The export is a download rather than a request, because the CSV is behind the
 * same bearer token as everything else and a plain link would not carry it.
 */
export const customersApi = {
  list: (params: CustomerListParams) =>
    api.list<CustomerSummary>('/admin/customers', {
      query: {
        page: params.page,
        limit: params.limit,
        q: params.q,
        status: params.status,
        hasOrders: params.hasOrders,
        acceptsMarketing: params.acceptsMarketing,
        marketingEmailState: params.marketingEmailState,
        taxExempt: params.taxExempt,
        tags: params.tags,
        minSpent: params.minSpent,
        maxSpent: params.maxSpent,
        minOrders: params.minOrders,
        maxOrders: params.maxOrders,
        createdAfter: params.createdAfter,
        createdBefore: params.createdBefore,
        lastOrderAfter: params.lastOrderAfter,
        noOrderSince: params.noOrderSince,
        segmentId: params.segmentId,
        sort: params.sort,
        direction: params.direction,
      },
    }),

  detail: (id: string) => api.get<CustomerDetail>(`/admin/customers/${id}`),

  create: (body: CreateCustomerInput) => api.post<CustomerSummary>('/admin/customers', body),

  update: (id: string, body: UpdateCustomerInput) =>
    api.patch<CustomerSummary>(`/admin/customers/${id}`, body),

  setStatus: (id: string, status: Exclude<CustomerStatus, 'locked'>) =>
    api.patch<CustomerSummary>(`/admin/customers/${id}/status`, { status }),

  addTags: (id: string, tags: string[]) =>
    api.post<CustomerSummary>(`/admin/customers/${id}/tags`, { tags }),

  removeTags: (id: string, tags: string[]) =>
    api.delete<CustomerSummary>(`/admin/customers/${id}/tags`, { tags }),

  setConsent: (
    id: string,
    body: { channel: 'email' | 'sms'; state: MarketingState; optInLevel?: OptInLevel | null },
  ) => api.patch<CustomerSummary>(`/admin/customers/${id}/marketing`, body),

  events: (id: string) => api.get<CustomerEvent[]>(`/admin/customers/${id}/events`),

  addNote: (id: string, body: string) =>
    api.post<CustomerEvent>(`/admin/customers/${id}/events`, { body }),

  /** Only notes can go. A system observation is evidence, not somebody's to take back. */
  deleteNote: (id: string, eventId: string) =>
    api.delete<void>(`/admin/customers/${id}/events/${eventId}`),

  merge: (survivorId: string, duplicateId: string) =>
    api.post<CustomerSummary>(`/admin/customers/${survivorId}/merge`, { duplicateId }),

  recomputeMetrics: (id: string) =>
    api.post<CustomerSummary>(`/admin/customers/${id}/recompute-metrics`),

  recomputeAllMetrics: () =>
    api.post<{ customers: number }>('/admin/customers/recompute-metrics'),

  /** The same filters as the list, so what downloads is what is on screen. */
  export: (params: CustomerListParams) =>
    download('/admin/customers/export', {
      query: {
        q: params.q,
        status: params.status,
        hasOrders: params.hasOrders,
        acceptsMarketing: params.acceptsMarketing,
        marketingEmailState: params.marketingEmailState,
        taxExempt: params.taxExempt,
        tags: params.tags,
        minSpent: params.minSpent,
        maxSpent: params.maxSpent,
        minOrders: params.minOrders,
        maxOrders: params.maxOrders,
        createdAfter: params.createdAfter,
        createdBefore: params.createdBefore,
        lastOrderAfter: params.lastOrderAfter,
        noOrderSince: params.noOrderSince,
        segmentId: params.segmentId,
      },
    }),

  // ── Segments ──────────────────────────────────────────────────────────────

  /** The field table the rule builder is generated from. Never written here. */
  ruleFields: () => api.get<RuleField[]>('/admin/customers/segments/fields'),

  segments: () => api.get<CustomerSegment[]>('/admin/customers/segments'),

  segment: (id: string) => api.get<CustomerSegment>(`/admin/customers/segments/${id}`),

  previewSegment: (rules: RuleSet) =>
    api.post<SegmentPreview>('/admin/customers/segments/preview', { rules }),

  createSegment: (body: {
    name: string
    description?: string | null
    rules: RuleSet
    isActive?: boolean
  }) => api.post<CustomerSegment>('/admin/customers/segments', body),

  updateSegment: (
    id: string,
    body: { name?: string; description?: string | null; rules?: RuleSet; isActive?: boolean },
  ) => api.patch<CustomerSegment>(`/admin/customers/segments/${id}`, body),

  deleteSegment: (id: string) => api.delete<void>(`/admin/customers/segments/${id}`),
}
