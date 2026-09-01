/**
 * Public surface of the `orders` feature (§2.2).
 *
 * Orders sit at the top of the dependency graph: they read carts, catalogue,
 * inventory, customers, shipping and discounts, and nothing reads them except
 * analytics and notifications, both of which go through events.
 */
export { ordersService, displayStatus } from './orders.service.js'
export { checkoutService } from './checkout.service.js'
export { fulfillmentService } from './fulfillment.service.js'
export { ordersRepository } from './orders.repository.js'
export type {
  CheckoutInput,
  DisplayStatus,
  FulfillmentStatus,
  Order,
  OrderAddress,
  OrderDetail,
  OrderDiscount,
  OrderItem,
  OrderListFilter,
  OrderStatus,
  PaymentStatus,
  StatusHistoryEntry,
} from './orders.types.js'
