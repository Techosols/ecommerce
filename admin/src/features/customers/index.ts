/**
 * Public surface of the customers feature.
 *
 * The pages are what the router mounts; the hooks are what other features reach
 * for (an order page linking to the customer who placed it). Everything else —
 * the API module, the cards, the label maps — stays inside.
 */
export { CustomerDetailPage } from './pages/CustomerDetailPage'
export { CustomerListPage } from './pages/CustomerListPage'
export { SegmentsPage } from './pages/SegmentsPage'

export { customerKeys, useCustomer, useCustomers, useSegments } from './hooks/customers.hooks'
export { customerName } from './components/customerLabels'

export type {
  CustomerDetail,
  CustomerEvent,
  CustomerListParams,
  CustomerSegment,
  CustomerStatus,
  CustomerSummary,
  MarketingState,
} from './types/customers.types'
