/**
 * Checkout data access.
 */

import { queryOne } from '../../infrastructure/database/query.js'
import type { Checkout, DeliveryAddress } from './checkout.types.js'

interface CheckoutRow {
  id: string
  customer_id: string | null
  guest_token: string | null
  idempotency_key: string
  cart_id: string
  email: string
  phone_number: string | null
  fulfillment_method: 'pickup' | 'delivery'
  pickup_location_id: string | null
  delivery_address: DeliveryAddress | Record<string, unknown> | string | null
  delivery_fee_minor: number | null
  subtotal_minor: number
  items_total_minor: number
  order_discount_minor: number
  delivery_fee_total_minor: number
  taxes_minor: number
  total_minor: number
  currency: string
  discount_id: string | null
  discount_code: string | null
  status: 'open' | 'payment_pending' | 'paid' | 'expired' | 'cancelled' | 'completed'
  payment_id: string | null
  created_at: string
  updated_at: string
  expires_at: string
}

function toCheckout(row: CheckoutRow): Checkout {
  return {
    id: row.id,
    customerId: row.customer_id,
    guestToken: row.guest_token,
    idempotencyKey: row.idempotency_key,
    cartId: row.cart_id,
    email: row.email,
    phoneNumber: row.phone_number,
    fulfillmentMethod: row.fulfillment_method,
    pickupLocationId: row.pickup_location_id,
    deliveryAddress: row.delivery_address
      ? (typeof row.delivery_address === 'string'
          ? (JSON.parse(row.delivery_address) as DeliveryAddress)
          : (row.delivery_address as DeliveryAddress))
      : null,
    deliveryFeeMinor: row.delivery_fee_minor ?? 0,
    subtotalMinor: row.subtotal_minor,
    itemsTotalMinor: row.items_total_minor,
    orderDiscountMinor: row.order_discount_minor,
    deliveryFeeTotalMinor: row.delivery_fee_total_minor,
    taxesMinor: row.taxes_minor,
    totalMinor: row.total_minor,
    currency: row.currency,
    discountId: row.discount_id,
    discountCode: row.discount_code,
    status: row.status,
    paymentId: row.payment_id,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    expiresAt: new Date(row.expires_at),
  }
}

export const checkoutRepository = {
  async create(input: {
    customerId: string | null
    guestToken: string | null
    idempotencyKey: string
    cartId: string
    email: string
    phoneNumber: string | null
    fulfillmentMethod: 'pickup' | 'delivery'
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
  }): Promise<Checkout> {
    const row = await queryOne<CheckoutRow>(
      `INSERT INTO checkouts (
        customer_id,
        guest_token,
        idempotency_key,
        cart_id,
        email,
        phone_number,
        fulfillment_method,
        pickup_location_id,
        delivery_address,
        delivery_fee_minor,
        subtotal_minor,
        items_total_minor,
        order_discount_minor,
        delivery_fee_total_minor,
        taxes_minor,
        total_minor,
        currency,
        discount_id,
        discount_code,
        status,
        expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, 'open', now() + interval '1 hour')
      RETURNING *`,
      [
        input.customerId,
        input.guestToken,
        input.idempotencyKey,
        input.cartId,
        input.email,
        input.phoneNumber,
        input.fulfillmentMethod,
        input.pickupLocationId,
        input.deliveryAddress ? JSON.stringify(input.deliveryAddress) : null,
        input.deliveryFeeMinor,
        input.subtotalMinor,
        input.itemsTotalMinor,
        input.orderDiscountMinor,
        input.deliveryFeeTotalMinor,
        input.taxesMinor,
        input.totalMinor,
        input.currency,
        input.discountId,
        input.discountCode,
      ],
      { name: 'checkout.create' },
    )

    if (!row) throw new Error('Failed to create checkout')
    return toCheckout(row)
  },

  async findById(id: string): Promise<Checkout | undefined> {
    const row = await queryOne<CheckoutRow>(`SELECT * FROM checkouts WHERE id = $1`, [id], {
      name: 'checkout.findById',
    })
    return row ? toCheckout(row) : undefined
  },

  async findByIdempotencyKey(idempotencyKey: string): Promise<Checkout | undefined> {
    const row = await queryOne<CheckoutRow>(
      `SELECT * FROM checkouts WHERE idempotency_key = $1 LIMIT 1`,
      [idempotencyKey],
      { name: 'checkout.findByIdempotencyKey' },
    )
    return row ? toCheckout(row) : undefined
  },

  async findByCartId(cartId: string): Promise<Checkout | undefined> {
    const row = await queryOne<CheckoutRow>(
      `SELECT * FROM checkouts WHERE cart_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [cartId],
      { name: 'checkout.findByCartId' },
    )
    return row ? toCheckout(row) : undefined
  },

  async updateStatus(checkoutId: string, status: Checkout['status']): Promise<Checkout | undefined> {
    const row = await queryOne<CheckoutRow>(
      `UPDATE checkouts SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [checkoutId, status],
      { name: 'checkout.updateStatus' },
    )
    return row ? toCheckout(row) : undefined
  },

  async assignPayment(checkoutId: string, paymentId: string): Promise<Checkout | undefined> {
    const row = await queryOne<CheckoutRow>(
      `UPDATE checkouts SET payment_id = $2, status = 'payment_pending', updated_at = now() WHERE id = $1 RETURNING *`,
      [checkoutId, paymentId],
      { name: 'checkout.assignPayment' },
    )
    return row ? toCheckout(row) : undefined
  },
}
