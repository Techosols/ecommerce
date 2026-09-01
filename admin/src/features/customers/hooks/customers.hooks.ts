import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { RuleSet } from '@/components/rules'
import { useAuth } from '@/features/auth/useAuth'
import { customersApi } from '../api/customers.api'
import type {
  CreateCustomerInput,
  CustomerListParams,
  CustomerStatus,
  CustomerSummary,
  MarketingState,
  OptInLevel,
  UpdateCustomerInput,
} from '../types/customers.types'

export const customerKeys = {
  all: ['customers'] as const,
  list: (params: CustomerListParams) => ['customers', 'list', params] as const,
  detail: (id: string) => ['customers', 'detail', id] as const,
  events: (id: string) => ['customers', 'events', id] as const,
  segments: ['customers', 'segments'] as const,
  segment: (id: string) => ['customers', 'segments', id] as const,
  ruleFields: ['customers', 'ruleFields'] as const,
}

/**
 * Every customer write can move a segment.
 *
 * Segments are counted live from the same rows, so a tag added here changes the
 * membership of "everyone tagged wholesale" immediately. Invalidating them with
 * the customer is what stops the segments page showing a count that was true a
 * moment ago.
 */
function invalidateCustomer(queryClient: QueryClient, customer?: CustomerSummary) {
  void queryClient.invalidateQueries({ queryKey: customerKeys.all })
  if (customer) {
    void queryClient.invalidateQueries({ queryKey: customerKeys.events(customer.id) })
  }
}

export function useCustomers(params: CustomerListParams) {
  return useQuery({
    queryKey: customerKeys.list(params),
    queryFn: () => customersApi.list(params),
    placeholderData: (previous) => previous,
  })
}

export function useCustomer(id: string | undefined) {
  return useQuery({
    queryKey: customerKeys.detail(id ?? 'none'),
    queryFn: () => customersApi.detail(id!),
    enabled: Boolean(id),
  })
}

export function useCustomerEvents(id: string | undefined) {
  return useQuery({
    queryKey: customerKeys.events(id ?? 'none'),
    queryFn: () => customersApi.events(id!),
    enabled: Boolean(id),
  })
}

// ── Mutations ───────────────────────────────────────────────────────────────

export function useCreateCustomer() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateCustomerInput) => customersApi.create(input),
    onSuccess: (customer) => invalidateCustomer(queryClient, customer),
  })
}

export function useUpdateCustomer(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: UpdateCustomerInput) => customersApi.update(id, input),
    onSuccess: (customer) => invalidateCustomer(queryClient, customer),
  })
}

export function useSetCustomerStatus(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (status: Exclude<CustomerStatus, 'locked'>) => customersApi.setStatus(id, status),
    onSuccess: (customer) => invalidateCustomer(queryClient, customer),
  })
}

export function useCustomerTags(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { tags: string[]; action: 'add' | 'remove' }) =>
      input.action === 'add'
        ? customersApi.addTags(id, input.tags)
        : customersApi.removeTags(id, input.tags),
    onSuccess: (customer) => invalidateCustomer(queryClient, customer),
  })
}

export function useSetConsent(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      channel: 'email' | 'sms'
      state: MarketingState
      optInLevel?: OptInLevel | null
    }) => customersApi.setConsent(id, input),
    onSuccess: (customer) => invalidateCustomer(queryClient, customer),
  })
}

export function useAddCustomerNote(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: string) => customersApi.addNote(id, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: customerKeys.events(id) })
    },
  })
}

export function useDeleteCustomerNote(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (eventId: string) => customersApi.deleteNote(id, eventId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: customerKeys.events(id) })
    },
  })
}

export function useMergeCustomers(survivorId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (duplicateId: string) => customersApi.merge(survivorId, duplicateId),
    onSuccess: (customer) => invalidateCustomer(queryClient, customer),
  })
}

export function useRecomputeMetrics(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => customersApi.recomputeMetrics(id),
    onSuccess: (customer) => invalidateCustomer(queryClient, customer),
  })
}

export function useRecomputeAllMetrics() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => customersApi.recomputeAllMetrics(),
    onSuccess: () => invalidateCustomer(queryClient),
  })
}

// ── Segments ────────────────────────────────────────────────────────────────

/**
 * The server's field catalogue.
 *
 * Held for the session: it changes when the server is deployed, not while
 * somebody is writing a rule.
 */
export function useRuleFields() {
  const { can } = useAuth()
  return useQuery({
    queryKey: customerKeys.ruleFields,
    queryFn: () => customersApi.ruleFields(),
    enabled: can('customers:read'),
    staleTime: Infinity,
  })
}

export function useSegments() {
  const { can } = useAuth()
  return useQuery({
    queryKey: customerKeys.segments,
    queryFn: () => customersApi.segments(),
    enabled: can('customers:read'),
  })
}

/**
 * What an unsaved rule set would match.
 *
 * A mutation rather than a query on purpose: it is asked for when somebody
 * stops typing and presses the button, not on every keystroke, and a query
 * keyed on the rules would refetch on every character.
 */
export function usePreviewSegment() {
  return useMutation({
    mutationFn: (rules: RuleSet) => customersApi.previewSegment(rules),
  })
}

function invalidateSegments(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: customerKeys.segments })
}

export function useCreateSegment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      name: string
      description?: string | null
      rules: RuleSet
      isActive?: boolean
    }) => customersApi.createSegment(input),
    onSuccess: () => invalidateSegments(queryClient),
  })
}

export function useUpdateSegment(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      name?: string
      description?: string | null
      rules?: RuleSet
      isActive?: boolean
    }) => customersApi.updateSegment(id, input),
    onSuccess: () => invalidateSegments(queryClient),
  })
}

export function useDeleteSegment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => customersApi.deleteSegment(id),
    onSuccess: () => invalidateSegments(queryClient),
  })
}
