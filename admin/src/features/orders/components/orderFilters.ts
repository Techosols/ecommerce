import type { FulfillmentStatus, OrderStatus, PaymentStatus } from '../types/orders.types'

export interface OrderFiltersValue {
  q: string
  status: OrderStatus | ''
  paymentStatus: PaymentStatus | ''
  fulfillmentStatus: FulfillmentStatus | ''
}

export const emptyOrderFilters: OrderFiltersValue = {
  q: '',
  status: '',
  paymentStatus: '',
  fulfillmentStatus: '',
}
