/**
 * Cart data access (§9.2).
 *
 * All cart queries go through here. No business rules live in this module.
 */

import { execute, query, queryOne } from '../../infrastructure/database/query.js'
import type { CartItemRecord, CartRecord } from './cart.types.js'

interface CartRow {
  id: string
  customer_id: string | null
  guest_token: string | null
  status: string
  created_at: string
  updated_at: string
  expires_at: string
  guest_merged_at: string | null
}

function toCartRecord(row: CartRow): CartRecord {
  return {
    id: row.id,
    customerId: row.customer_id,
    guestToken: row.guest_token,
    status: row.status as CartRecord['status'],
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    expiresAt: new Date(row.expires_at),
    guestMergedAt: row.guest_merged_at ? new Date(row.guest_merged_at) : null,
  }
}

export const cartRepository = {
  // ── Create ───────────────────────────────────────────────────────────────

  /**
   * Create a new customer cart.
   */
  async createCustomerCart(customerId: string): Promise<CartRecord> {
    const row = await queryOne<CartRow>(
      `INSERT INTO carts (id, customer_id, status, expires_at)
       VALUES (gen_random_uuid(), $1, 'active', now() + interval '30 days')
       RETURNING id, customer_id, guest_token, status, created_at, updated_at, expires_at, guest_merged_at`,
      [customerId],
      { name: 'cart.createCustomerCart' },
    )
    if (!row) throw new Error('Failed to create customer cart')
    return toCartRecord(row)
  },

  /**
   * Create a new guest cart.
   */
  async createGuestCart(): Promise<CartRecord> {
    const row = await queryOne<CartRow>(
      `INSERT INTO carts (id, guest_token, status, expires_at)
       VALUES (gen_random_uuid(), gen_random_uuid(), 'active', now() + interval '30 days')
       RETURNING id, customer_id, guest_token, status, created_at, updated_at, expires_at, guest_merged_at`,
      [],
      { name: 'cart.createGuestCart' },
    )
    if (!row) throw new Error('Failed to create guest cart')
    return toCartRecord(row)
  },

  // ── Read ───────────────────────────────────────────────────────────────

  /**
   * Fetch a cart by id. Returns null if not found or if the cart doesn't belong
   * to this customer/guest.
   */
  async findCartById(id: string): Promise<CartRecord | undefined> {
    const row = await queryOne<CartRow>(
      `SELECT id, customer_id, guest_token, status, created_at, updated_at, expires_at, guest_merged_at
       FROM carts WHERE id = $1`,
      [id],
      { name: 'cart.findCartById' },
    )
    return row ? toCartRecord(row) : undefined
  },

  /**
   * Fetch a customer's active cart. Returns null if they don't have one.
   */
  async findCustomerCart(customerId: string): Promise<CartRecord | undefined> {
    const row = await queryOne<CartRow>(
      `SELECT id, customer_id, guest_token, status, created_at, updated_at, expires_at, guest_merged_at
       FROM carts
       WHERE customer_id = $1 AND status = 'active'
       LIMIT 1`,
      [customerId],
      { name: 'cart.findCustomerCart' },
    )
    return row ? toCartRecord(row) : undefined
  },

  /**
   * Fetch a guest cart by opaque token. Returns null if not found or if expired.
   */
  async findGuestCart(guestToken: string): Promise<CartRecord | undefined> {
    const row = await queryOne<CartRow>(
      `SELECT id, customer_id, guest_token, status, created_at, updated_at, expires_at, guest_merged_at
       FROM carts
       WHERE guest_token = $1 AND status = 'active' AND expires_at > now()
       LIMIT 1`,
      [guestToken],
      { name: 'cart.findGuestCart' },
    )
    return row ? toCartRecord(row) : undefined
  },

  // ── Cart items ───────────────────────────────────────────────────────────

  /**
   * Fetch all items in a cart.
   */
  async findCartItems(cartId: string): Promise<CartItemRecord[]> {
    const rows = await query<CartItemRecord>(
      `SELECT id, cart_id, variant_id, quantity, selected_options, selected_modifiers, created_at, updated_at
       FROM cart_items
       WHERE cart_id = $1
       ORDER BY created_at ASC`,
      [cartId],
      { name: 'cart.findCartItems' },
    )
    return rows
  },

  /**
   * Fetch a single cart item.
   */
  async findCartItem(itemId: string): Promise<CartItemRecord | undefined> {
    const row = await queryOne<CartItemRecord>(
      `SELECT id, cart_id, variant_id, quantity, selected_options, selected_modifiers, created_at, updated_at
       FROM cart_items
       WHERE id = $1`,
      [itemId],
      { name: 'cart.findCartItem' },
    )
    return row ?? undefined
  },

  /**
   * Find a cart item by variant + configuration. Used to merge carts and check for duplicates.
   */
  async findCartItemByConfiguration(input: {
    cartId: string
    variantId: string
    selectedOptions: Record<string, string>
    selectedModifiers: Record<string, unknown>
  }): Promise<CartItemRecord | undefined> {
    const row = await queryOne<CartItemRecord>(
      `SELECT id, cart_id, variant_id, quantity, selected_options, selected_modifiers, created_at, updated_at
       FROM cart_items
       WHERE cart_id = $1 AND variant_id = $2 AND selected_options = $3 AND selected_modifiers = $4`,
      [input.cartId, input.variantId, JSON.stringify(input.selectedOptions), JSON.stringify(input.selectedModifiers)],
      { name: 'cart.findCartItemByConfiguration' },
    )
    return row ?? undefined
  },

  /**
   * Add an item to a cart.
   */
  async addCartItem(input: {
    cartId: string
    variantId: string
    quantity: number
    selectedOptions: Record<string, string>
    selectedModifiers: Record<string, unknown>
  }): Promise<CartItemRecord> {
    const row = await queryOne<CartItemRecord>(
      `INSERT INTO cart_items (id, cart_id, variant_id, quantity, selected_options, selected_modifiers)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
       RETURNING id, cart_id, variant_id, quantity, selected_options, selected_modifiers, created_at, updated_at`,
      [
        input.cartId,
        input.variantId,
        input.quantity,
        JSON.stringify(input.selectedOptions),
        JSON.stringify(input.selectedModifiers),
      ],
      { name: 'cart.addCartItem' },
    )
    if (!row) throw new Error('Failed to add cart item')
    return row
  },

  /**
   * Update a cart item's quantity.
   */
  async updateCartItem(itemId: string, quantity: number): Promise<CartItemRecord | undefined> {
    const row = await queryOne<CartItemRecord>(
      `UPDATE cart_items
       SET quantity = $2, updated_at = now()
       WHERE id = $1
       RETURNING id, cart_id, variant_id, quantity, selected_options, selected_modifiers, created_at, updated_at`,
      [itemId, quantity],
      { name: 'cart.updateCartItem' },
    )
    return row ?? undefined
  },

  /**
   * Remove a cart item.
   */
  async removeCartItem(itemId: string): Promise<void> {
    await execute(`DELETE FROM cart_items WHERE id = $1`, [itemId], { name: 'cart.removeCartItem' })
  },

  /**
   * Clear all items from a cart.
   */
  async clearCartItems(cartId: string): Promise<number> {
    const result = await execute(
      `DELETE FROM cart_items WHERE cart_id = $1`,
      [cartId],
      { name: 'cart.clearCartItems' },
    )
    return result
  },

  // ── Variant lookup ───────────────────────────────────────────────────────

  /**
   * Fetch variant details for pricing and validation. Throws if not found or archived.
   */
  async getVariantForCart(variantId: string): Promise<{
    id: string
    productId: string
    title: string
    sku: string | null
    isActive: boolean
    archivedAt: string | null
    priceAmount: number
    compareAtAmount: number | null
    currency: string
  } | undefined> {
    const row = await queryOne<{
      id: string
      product_id: string
      title: string
      sku: string | null
      is_active: boolean
      archived_at: string | null
      price_amount: number
      compare_at_amount: number | null
      currency: string
    }>(
      `SELECT
        id, product_id, title, sku, is_active, archived_at, price_amount, compare_at_amount, currency
       FROM product_variants
       WHERE id = $1`,
      [variantId],
      { name: 'cart.getVariantForCart' },
    )

    if (!row) return undefined
    return {
      id: row.id,
      productId: row.product_id,
      title: row.title,
      sku: row.sku,
      isActive: row.is_active,
      archivedAt: row.archived_at ? new Date(row.archived_at) : null,
      priceAmount: row.price_amount,
      compareAtAmount: row.compare_at_amount,
      currency: row.currency,
    }
  },

  // ── Cart state ───────────────────────────────────────────────────────────

  /**
   * Mark a guest cart as merged after customer login.
   */
  async markCartMerged(guestCartId: string): Promise<void> {
    await execute(
      `UPDATE carts SET status = 'merged', guest_merged_at = now() WHERE id = $1`,
      [guestCartId],
      { name: 'cart.markCartMerged' },
    )
  },

  /**
   * Mark a cart as abandoned (expired).
   */
  async markCartAbandoned(cartId: string): Promise<void> {
    await execute(`UPDATE carts SET status = 'abandoned' WHERE id = $1`, [cartId], {
      name: 'cart.markCartAbandoned',
    })
  },

  /**
   * Update cart's expires_at to extend its lifetime (used when cart is modified).
   */
  async extendCartExpiry(cartId: string): Promise<void> {
    await execute(
      `UPDATE carts SET expires_at = now() + interval '30 days', updated_at = now() WHERE id = $1`,
      [cartId],
      { name: 'cart.extendCartExpiry' },
    )
  },

  // ── Cleanup ───────────────────────────────────────────────────────────

  /**
   * Find all expired carts (guest and customer).
   */
  async findExpiredCarts(): Promise<CartRecord[]> {
    const rows = await query<CartRecord>(
      `SELECT id, customer_id, guest_token, status, created_at, updated_at, expires_at, guest_merged_at
       FROM carts
       WHERE status = 'active' AND expires_at < now()`,
      [],
      { name: 'cart.findExpiredCarts' },
    )
    return rows
  },
}
