/**
 * Checkout domain types.
 */

export type CheckoutStatus = 'open' | 'payment_pending' | 'paid' | 'expired' | 'cancelled' | 'completed'
export type FulfillmentMethod = 'pickup' | 'delivery'

export interface DeliveryAddress {
  street: string
  city: string
  state: string
  zip: string
  country: string
  notes?: string
}

export interface Checkout {
  id: string
  customerId: string | null
  guestToken: string | null
  idempotencyKey: string
  cartId: string
  email: string
  phoneNumber: string | null
  fulfillmentMethod: FulfillmentMethod
  pickupLocationId: string | null
  deliveryAddress: DeliveryAddress | null
  deliveryFeeMinor: number
  subtotalMinor: number
  itemsTotalMinor: number
  orderDiscountMinor: number
  deliveryFeeTotalMinor: number
  taxesMinor: number
  totalMinor: number
  currency: string
  discountId: string | null
  discountCode: string | null
  status: CheckoutStatus
  paymentId: string | null
  createdAt: Date
  updatedAt: Date
  expiresAt: Date
}

export interface CheckoutCreateInput {
  cartId: string
  email: string
  phoneNumber?: string
  fulfillmentMethod: FulfillmentMethod
  pickupLocationId?: string
  deliveryAddress?: DeliveryAddress
  discountCode?: string
  idempotencyKey: string
}
