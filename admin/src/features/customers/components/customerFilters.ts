import type {
  CustomerListParams,
  CustomerSort,
  CustomerStatus,
  MarketingState,
} from '../types/customers.types'

/**
 * The filter drawer's state, as strings.
 *
 * Everything is a string because it comes from the URL and goes back to it —
 * "everyone tagged wholesale who has not ordered since June" has to be a link
 * somebody can send to a colleague. The conversion to the API's types happens
 * once, in `toParams`.
 */
export interface CustomerFiltersValue {
  q: string
  status: CustomerStatus | ''
  hasOrders: '' | 'true' | 'false'
  marketingEmailState: MarketingState | ''
  taxExempt: '' | 'true' | 'false'
  minSpent: string
  maxSpent: string
  minOrders: string
  noOrderSince: string
  segmentId: string
  sort: string
  direction: '' | 'asc' | 'desc'
}

export const emptyCustomerFilters: CustomerFiltersValue = {
  q: '',
  status: '',
  hasOrders: '',
  marketingEmailState: '',
  taxExempt: '',
  minSpent: '',
  maxSpent: '',
  minOrders: '',
  noOrderSince: '',
  segmentId: '',
  sort: '',
  direction: '',
}

export function readFilters(params: URLSearchParams): CustomerFiltersValue {
  return {
    q: params.get('q') ?? '',
    status: (params.get('status') ?? '') as CustomerStatus | '',
    hasOrders: (params.get('hasOrders') ?? '') as '' | 'true' | 'false',
    marketingEmailState: (params.get('marketingEmailState') ?? '') as MarketingState | '',
    taxExempt: (params.get('taxExempt') ?? '') as '' | 'true' | 'false',
    minSpent: params.get('minSpent') ?? '',
    maxSpent: params.get('maxSpent') ?? '',
    minOrders: params.get('minOrders') ?? '',
    noOrderSince: params.get('noOrderSince') ?? '',
    segmentId: params.get('segmentId') ?? '',
    sort: params.get('sort') ?? '',
    direction: (params.get('direction') ?? '') as '' | 'asc' | 'desc',
  }
}

/** True when anything is narrowing the list — drives the empty state's wording. */
export function isFiltered(filters: CustomerFiltersValue, tags: string[]): boolean {
  return (
    tags.length > 0 ||
    Object.entries(filters).some(
      ([key, value]) => key !== 'sort' && key !== 'direction' && value !== '',
    )
  )
}

/**
 * The drawer's state as the API's parameters.
 *
 * Money arrives as major units, because that is what the person typed, and the
 * server takes minor units like everywhere else. A blank stays blank rather
 * than becoming a zero — "at least £0" is not a filter.
 */
export function toParams(
  filters: CustomerFiltersValue,
  tags: string[],
  query: string,
): Omit<CustomerListParams, 'page' | 'limit'> {
  // Built by assignment rather than by spreading ternaries: under
  // `exactOptionalPropertyTypes` a spread of `{ x: number | undefined }` is not
  // the same as an absent key, and only the second means "do not filter".
  const params: Omit<CustomerListParams, 'page' | 'limit'> = {}

  const number = (value: string) =>
    value === '' || Number.isNaN(Number(value)) ? null : Number(value)

  if (query) params.q = query
  if (filters.status) params.status = filters.status
  if (filters.hasOrders) params.hasOrders = filters.hasOrders
  if (filters.marketingEmailState) params.marketingEmailState = filters.marketingEmailState
  if (filters.taxExempt) params.taxExempt = filters.taxExempt

  const minSpent = number(filters.minSpent)
  if (minSpent !== null) params.minSpent = Math.round(minSpent * 100)
  const maxSpent = number(filters.maxSpent)
  if (maxSpent !== null) params.maxSpent = Math.round(maxSpent * 100)
  const minOrders = number(filters.minOrders)
  if (minOrders !== null) params.minOrders = minOrders

  if (filters.noOrderSince) {
    params.noOrderSince = new Date(`${filters.noOrderSince}T00:00:00Z`).toISOString()
  }
  if (filters.segmentId) params.segmentId = filters.segmentId
  if (filters.sort) params.sort = filters.sort as CustomerSort
  if (filters.direction) params.direction = filters.direction
  if (tags.length > 0) params.tags = tags

  return params
}
