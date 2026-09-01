/**
 * Cart data access (§1.2). SQL only.
 */
import { execute, query, queryOne } from '../../infrastructure/database/query.js'
import type { Cart, CartItem, CartStatus } from './carts.types.js'

interface CartRow {
  id: string
  customer_id: string | null
  status: CartStatus
  currency: string
  converted_order_id: string | null
  last_activity_at: Date
  expires_at: Date
  created_at: Date
  updated_at: Date
}

interface CartItemRow {
  id: string
  cart_id: string
  variant_id: string
  quantity: number
  added_at: Date
}

function toCart(row: CartRow): Cart {
  return {
    id: row.id,
    customerId: row.customer_id,
    status: row.status,
    currency: row.currency,
    convertedOrderId: row.converted_order_id,
    lastActivityAt: row.last_activity_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toItem(row: CartItemRow): CartItem {
  return {
    id: row.id,
    cartId: row.cart_id,
    variantId: row.variant_id,
    quantity: row.quantity,
    addedAt: row.added_at,
  }
}

export const cartsRepository = {
  async create(input: {
    id: string
    customerId: string | null
    anonymousTokenHash: Buffer | null
    currency: string
    expiresAt: Date
  }): Promise<Cart> {
    const row = await queryOne<CartRow>(
      `INSERT INTO carts (id, customer_id, anonymous_token_hash, currency, expires_at)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [input.id, input.customerId, input.anonymousTokenHash, input.currency, input.expiresAt],
      { name: 'carts.create' },
    )
    if (!row) throw new Error('Failed to create cart')
    return toCart(row)
  },

  async findById(id: string): Promise<Cart | undefined> {
    const row = await queryOne<CartRow>(`SELECT * FROM carts WHERE id = $1`, [id], {
      name: 'carts.findById',
    })
    return row ? toCart(row) : undefined
  },

  async findActiveForCustomer(customerId: string): Promise<Cart | undefined> {
    const row = await queryOne<CartRow>(
      `SELECT * FROM carts WHERE customer_id = $1 AND status = 'active'`,
      [customerId],
      { name: 'carts.findActiveForCustomer' },
    )
    return row ? toCart(row) : undefined
  },

  async findByAnonymousHash(hash: Buffer): Promise<Cart | undefined> {
    const row = await queryOne<CartRow>(
      `SELECT * FROM carts WHERE anonymous_token_hash = $1`,
      [hash],
      { name: 'carts.findByAnonymousHash' },
    )
    return row ? toCart(row) : undefined
  },

  /** Locks the cart so concurrent line edits and checkout serialise (§18.3). */
  async lock(id: string): Promise<Cart | undefined> {
    const row = await queryOne<CartRow>(`SELECT * FROM carts WHERE id = $1 FOR UPDATE`, [id], {
      name: 'carts.lock',
    })
    return row ? toCart(row) : undefined
  },

  async touch(id: string, expiresAt: Date): Promise<void> {
    await execute(
      `UPDATE carts SET last_activity_at = now(), expires_at = $2 WHERE id = $1`,
      [id, expiresAt],
      { name: 'carts.touch' },
    )
  },

  /**
   * Claims an anonymous cart for a customer who has just signed in.
   *
   * The token is cleared in the same statement, so the guest identifier stops
   * working the moment the cart has an owner.
   */
  async assignToCustomer(cartId: string, customerId: string): Promise<number> {
    return execute(
      `UPDATE carts SET customer_id = $2, anonymous_token_hash = NULL WHERE id = $1`,
      [cartId, customerId],
      { name: 'carts.assignToCustomer' },
    )
  },

  async setStatus(id: string, status: CartStatus, orderId?: string): Promise<void> {
    await execute(
      `UPDATE carts SET status = $2, converted_order_id = coalesce($3, converted_order_id)
        WHERE id = $1`,
      [id, status, orderId ?? null],
      { name: 'carts.setStatus' },
    )
  },

  // ── Items ─────────────────────────────────────────────────────────────────

  async items(cartId: string): Promise<CartItem[]> {
    const rows = await query<CartItemRow>(
      `SELECT * FROM cart_items WHERE cart_id = $1 ORDER BY added_at, id`,
      [cartId],
      { name: 'carts.items' },
    )
    return rows.map(toItem)
  },

  /**
   * Adds a line, or increases it if the variant is already in the cart.
   *
   * `ON CONFLICT DO UPDATE` in one statement: two tabs adding the same burger
   * at once produce one line of two, not two lines or a lost click.
   */
  async upsertItem(input: {
    id: string
    cartId: string
    variantId: string
    quantity: number
  }): Promise<CartItem> {
    const row = await queryOne<CartItemRow>(
      `INSERT INTO cart_items (id, cart_id, variant_id, quantity)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (cart_id, variant_id)
       DO UPDATE SET quantity = least(cart_items.quantity + excluded.quantity, 999)
       RETURNING *`,
      [input.id, input.cartId, input.variantId, input.quantity],
      { name: 'carts.upsertItem' },
    )
    if (!row) throw new Error('Failed to add cart item')
    return toItem(row)
  },

  async setItemQuantity(cartId: string, variantId: string, quantity: number): Promise<CartItem | undefined> {
    const row = await queryOne<CartItemRow>(
      `UPDATE cart_items SET quantity = $3 WHERE cart_id = $1 AND variant_id = $2 RETURNING *`,
      [cartId, variantId, quantity],
      { name: 'carts.setItemQuantity' },
    )
    return row ? toItem(row) : undefined
  },

  async removeItem(cartId: string, variantId: string): Promise<number> {
    return execute(`DELETE FROM cart_items WHERE cart_id = $1 AND variant_id = $2`, [
      cartId,
      variantId,
    ], { name: 'carts.removeItem' })
  },

  async clearItems(cartId: string): Promise<void> {
    await execute(`DELETE FROM cart_items WHERE cart_id = $1`, [cartId], { name: 'carts.clearItems' })
  },

  /** Moves a guest cart's lines into a customer's existing cart, merging quantities. */
  async mergeItemsInto(sourceCartId: string, targetCartId: string): Promise<void> {
    await execute(
      `INSERT INTO cart_items (id, cart_id, variant_id, quantity)
       SELECT gen_random_uuid(), $2, variant_id, quantity FROM cart_items WHERE cart_id = $1
       ON CONFLICT (cart_id, variant_id)
       DO UPDATE SET quantity = least(cart_items.quantity + excluded.quantity, 999)`,
      [sourceCartId, targetCartId],
      { name: 'carts.mergeItemsInto' },
    )
    await execute(`DELETE FROM cart_items WHERE cart_id = $1`, [sourceCartId], {
      name: 'carts.clearMerged',
    })
  },

  /** Carts whose time ran out, for the abandonment sweep. */
  /**
   * Moves a cart's status only if it is still active.
   *
   * The compare-and-swap that makes the abandonment sweep safe to run twice:
   * a cart that has been checked out or already abandoned in the meantime
   * affects zero rows, and its caller knows not to raise a second event.
   */
  async setStatusIfActive(cartId: string, status: CartStatus): Promise<boolean> {
    const affected = await execute(
      `UPDATE carts SET status = $2 WHERE id = $1 AND status = 'active'`,
      [cartId, status],
      { name: 'carts.setStatusIfActive' },
    )
    return affected === 1
  },

  async claimExpired(limit: number): Promise<Cart[]> {
    const rows = await query<CartRow>(
      `SELECT * FROM carts
        WHERE status = 'active' AND expires_at <= now()
        ORDER BY expires_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
      { name: 'carts.claimExpired' },
    )
    return rows.map(toCart)
  },

  /**
   * The cart pile, with enough on each row to be worth reading.
   *
   * The value is computed from the variants' *current* prices rather than
   * stored, because a cart holds no money: what recovering one is worth is
   * what those items cost today, not what they cost when somebody added them.
   */
  async listForAdmin(filter: {
    limit: number
    offset: number
    status?: CartStatus
    query?: string
    withItemsOnly?: boolean
  }): Promise<{
    rows: {
      id: string
      status: CartStatus
      customerId: string | null
      customerEmail: string | null
      customerName: string | null
      itemCount: number
      valueCents: number
      lastActivityAt: Date
      expiresAt: Date
      convertedOrderId: string | null
      createdAt: Date
    }[]
    total: number
    abandonedCount: number
    abandonedValueCents: number
  }> {
    const params: unknown[] = []
    const where: string[] = []
    const push = (value: unknown) => {
      params.push(value)
      return `$${params.length}`
    }

    if (filter.status) where.push(`c.status = ${push(filter.status)}`)
    if (filter.query) {
      const like = push(`%${filter.query.trim()}%`)
      where.push(
        `(u.email ILIKE ${like} OR concat_ws(' ', u.first_name, u.last_name) ILIKE ${like})`,
      )
    }
    if (filter.withItemsOnly !== false) where.push('i.item_count > 0')

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const from = `
      FROM carts c
      LEFT JOIN users u ON u.id = c.customer_id
      LEFT JOIN LATERAL (
        SELECT coalesce(sum(ci.quantity), 0)::int AS item_count,
               coalesce(sum(ci.quantity * v.price_amount), 0)::int AS value_cents
          FROM cart_items ci
          JOIN product_variants v ON v.id = ci.variant_id
         WHERE ci.cart_id = c.id
      ) i ON true
      ${clause}`

    const rows = await query<{
      id: string
      status: CartStatus
      customer_id: string | null
      email: string | null
      customer_name: string | null
      item_count: number
      value_cents: number
      last_activity_at: Date
      expires_at: Date
      converted_order_id: string | null
      created_at: Date
    }>(
      `SELECT c.id, c.status, c.customer_id, u.email,
              nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), '') AS customer_name,
              i.item_count, i.value_cents,
              c.last_activity_at, c.expires_at, c.converted_order_id, c.created_at
       ${from}
        ORDER BY c.last_activity_at DESC
        LIMIT ${push(filter.limit)} OFFSET ${push(filter.offset)}`,
      params,
      { name: 'carts.listForAdmin' },
    )

    const counted = params.slice(0, params.length - 2)
    const totalRow = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count ${from}`,
      counted,
      { name: 'carts.countForAdmin' },
    )

    // The whole abandoned pile, ignoring the caller's filters: it is the
    // headline figure for the screen, and narrowing it to the current page or
    // the current search would make it a different number every time.
    const summary = await queryOne<{ count: number; value: number }>(
      `SELECT count(*)::int AS count, coalesce(sum(i.value_cents), 0)::int AS value
         FROM carts c
         LEFT JOIN LATERAL (
           SELECT coalesce(sum(ci.quantity * v.price_amount), 0)::int AS value_cents
             FROM cart_items ci
             JOIN product_variants v ON v.id = ci.variant_id
            WHERE ci.cart_id = c.id
         ) i ON true
        WHERE c.status = 'abandoned' AND i.value_cents > 0`,
      [],
      { name: 'carts.abandonedSummary' },
    )

    return {
      rows: rows.map((row) => ({
        id: row.id,
        status: row.status,
        customerId: row.customer_id,
        customerEmail: row.email,
        customerName: row.customer_name,
        itemCount: row.item_count,
        valueCents: row.value_cents,
        lastActivityAt: row.last_activity_at,
        expiresAt: row.expires_at,
        convertedOrderId: row.converted_order_id,
        createdAt: row.created_at,
      })),
      total: totalRow?.count ?? 0,
      abandonedCount: summary?.count ?? 0,
      abandonedValueCents: summary?.value ?? 0,
    }
  },

  /** Who the cart belongs to, when it belongs to an account. */
  async ownerOf(cartId: string): Promise<{
    id: string
    email: string
    name: string | null
  } | null> {
    const row = await queryOne<{ id: string; email: string; name: string | null }>(
      `SELECT u.id, u.email,
              nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), '') AS name
         FROM carts c JOIN users u ON u.id = c.customer_id
        WHERE c.id = $1`,
      [cartId],
      { name: 'carts.ownerOf' },
    )
    return row ?? null
  },
}
