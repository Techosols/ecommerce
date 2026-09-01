/**
 * Order data access (§1.2). SQL only.
 */
import { execute, query, queryOne } from '../../infrastructure/database/query.js'
import type {
  FulfillmentStatus,
  Order,
  OrderAddress,
  OrderDiscount,
  OrderItem,
  OrderListFilter,
  OrderNote,
  OrderStatus,
  PaymentStatus,
  StatusHistoryEntry,
} from './orders.types.js'

interface OrderRow {
  id: string
  order_number: string
  customer_id: string | null
  email: string
  phone: string | null
  status: OrderStatus
  payment_status: PaymentStatus
  fulfillment_status: FulfillmentStatus
  currency: string
  subtotal_cents: number
  discount_total_cents: number
  tax_total_cents: number
  shipping_total_cents: number
  payment_fee_cents: number
  total_cents: number
  refunded_total_cents: number
  payment_method: string
  shipping_method_id: string | null
  shipping_method_name: string | null
  customer_note: string | null
  admin_note: string | null
  cancel_reason: string | null
  tags: string[]
  source: 'storefront' | 'admin'
  drafted_by: string | null
  placed_order_id: string | null
  placed_from_draft_at: Date | null
  draft_discount_code: string | null
  placed_at: Date
  confirmed_at: Date | null
  cancelled_at: Date | null
  completed_at: Date | null
  created_at: Date
  updated_at: Date
}

function toOrder(row: OrderRow): Order {
  return {
    id: row.id,
    orderNumber: row.order_number,
    customerId: row.customer_id,
    email: row.email,
    phone: row.phone,
    status: row.status,
    paymentStatus: row.payment_status,
    fulfillmentStatus: row.fulfillment_status,
    currency: row.currency,
    subtotalCents: row.subtotal_cents,
    discountTotalCents: row.discount_total_cents,
    taxTotalCents: row.tax_total_cents,
    shippingTotalCents: row.shipping_total_cents,
    paymentFeeCents: row.payment_fee_cents,
    totalCents: row.total_cents,
    refundedTotalCents: row.refunded_total_cents,
    paymentMethod: row.payment_method,
    shippingMethodId: row.shipping_method_id,
    shippingMethodName: row.shipping_method_name,
    customerNote: row.customer_note,
    adminNote: row.admin_note,
    cancelReason: row.cancel_reason,
    tags: row.tags ?? [],
    source: row.source,
    draftedBy: row.drafted_by,
    placedOrderId: row.placed_order_id,
    placedFromDraftAt: row.placed_from_draft_at,
    draftDiscountCode: row.draft_discount_code,
    placedAt: row.placed_at,
    confirmedAt: row.confirmed_at,
    cancelledAt: row.cancelled_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

interface ItemRow {
  id: string
  order_id: string
  variant_id: string | null
  product_id: string | null
  product_title: string
  variant_title: string
  sku: string | null
  image_url: string | null
  options: { name: string; value: string }[]
  unit_price_cents: number
  quantity: number
  subtotal_cents: number
  discount_cents: number
  tax_cents: number
  total_cents: number
  requires_shipping: boolean
  weight_grams: number
  fulfilled_quantity: number
  refunded_quantity: number
  returned_quantity: number
}

function toItem(row: ItemRow): OrderItem {
  return {
    id: row.id,
    orderId: row.order_id,
    variantId: row.variant_id,
    productId: row.product_id,
    productTitle: row.product_title,
    variantTitle: row.variant_title,
    sku: row.sku,
    imageUrl: row.image_url,
    options: row.options ?? [],
    unitPriceCents: row.unit_price_cents,
    quantity: row.quantity,
    subtotalCents: row.subtotal_cents,
    discountCents: row.discount_cents,
    taxCents: row.tax_cents,
    totalCents: row.total_cents,
    requiresShipping: row.requires_shipping,
    weightGrams: row.weight_grams,
    fulfilledQuantity: row.fulfilled_quantity,
    refundedQuantity: row.refunded_quantity,
    returnedQuantity: row.returned_quantity ?? 0,
  }
}

interface NoteRow {
  id: string
  order_id: string
  author_user_id: string | null
  author_name: string | null
  body: string
  created_at: Date
}

function toNote(row: NoteRow): OrderNote {
  return {
    id: row.id,
    orderId: row.order_id,
    authorUserId: row.author_user_id,
    authorName: row.author_name,
    body: row.body,
    createdAt: row.created_at,
  }
}

export const ordersRepository = {
  /**
   * The human-facing order number.
   *
   * A sequence, not a count of rows: numbering from `count(*) + 1` produces
   * duplicates the moment two orders are placed at once, and gaps are harmless
   * whereas collisions are not.
   */
  async nextOrderNumber(prefix: string): Promise<string> {
    const row = await queryOne<{ n: string }>(`SELECT nextval('order_number_seq') AS n`, [], {
      name: 'orders.nextOrderNumber',
    })
    return `${prefix}${row?.n ?? '0'}`
  },

  async create(input: {
    id: string
    orderNumber: string
    customerId: string | null
    email: string
    phone: string | null
    currency: string
    subtotalCents: number
    discountTotalCents: number
    taxTotalCents: number
    shippingTotalCents: number
    paymentFeeCents: number
    totalCents: number
    paymentMethod: string
    shippingMethodId: string | null
    shippingMethodName: string | null
    customerNote: string | null
    source: 'storefront' | 'admin'
  }): Promise<Order> {
    const row = await queryOne<OrderRow>(
      `INSERT INTO orders
         (id, order_number, customer_id, email, phone, currency, subtotal_cents,
          discount_total_cents, tax_total_cents, shipping_total_cents, payment_fee_cents,
          total_cents, payment_method, shipping_method_id, shipping_method_name,
          customer_note, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [
        input.id, input.orderNumber, input.customerId, input.email, input.phone, input.currency,
        input.subtotalCents, input.discountTotalCents, input.taxTotalCents,
        input.shippingTotalCents, input.paymentFeeCents, input.totalCents, input.paymentMethod,
        input.shippingMethodId, input.shippingMethodName, input.customerNote, input.source,
      ],
      { name: 'orders.create' },
    )
    if (!row) throw new Error('Failed to create order')
    return toOrder(row)
  },

  async insertItem(
    input: Omit<OrderItem, 'fulfilledQuantity' | 'refundedQuantity' | 'returnedQuantity'>,
  ): Promise<void> {
    await execute(
      `INSERT INTO order_items
         (id, order_id, variant_id, product_id, product_title, variant_title, sku, image_url,
          options, unit_price_cents, quantity, subtotal_cents, discount_cents, tax_cents,
          total_cents, requires_shipping, weight_grams)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        input.id, input.orderId, input.variantId, input.productId, input.productTitle,
        input.variantTitle, input.sku, input.imageUrl, JSON.stringify(input.options),
        input.unitPriceCents, input.quantity, input.subtotalCents, input.discountCents,
        input.taxCents, input.totalCents, input.requiresShipping, input.weightGrams,
      ],
      { name: 'orders.insertItem' },
    )
  },

  async insertAddress(input: {
    id: string
    orderId: string
    type: 'shipping' | 'billing'
    firstName: string
    lastName: string
    company: string | null
    line1: string
    line2: string | null
    city: string
    region: string | null
    postalCode: string | null
    countryCode: string
    phone: string | null
  }): Promise<void> {
    await execute(
      `INSERT INTO order_addresses
         (id, order_id, type, first_name, last_name, company, line1, line2, city,
          region, postal_code, country_code, phone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        input.id, input.orderId, input.type, input.firstName, input.lastName, input.company,
        input.line1, input.line2, input.city, input.region, input.postalCode,
        input.countryCode, input.phone,
      ],
      { name: 'orders.insertAddress' },
    )
  },

  async insertDiscount(input: {
    id: string
    orderId: string
    discountId: string | null
    code: string
    type: string
    value: number
    amountCents: number
  }): Promise<void> {
    await execute(
      `INSERT INTO order_discounts (id, order_id, discount_id, code, type, value, amount_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [input.id, input.orderId, input.discountId, input.code, input.type, input.value, input.amountCents],
      { name: 'orders.insertDiscount' },
    )
  },

  async findById(id: string): Promise<Order | undefined> {
    const row = await queryOne<OrderRow>(`SELECT * FROM orders WHERE id = $1`, [id], {
      name: 'orders.findById',
    })
    return row ? toOrder(row) : undefined
  },

  /**
   * A guest order, found by the two things its owner has: the number and the
   * email it was placed with.
   *
   * `customer_id IS NULL` is the important part of this predicate. Order numbers
   * come from a sequence and are therefore guessable, so without it anyone who
   * knew a customer's email address could walk the numbers and read that
   * person's order history without their password. A registered customer signs
   * in instead; this exists only for the case where there is no account to sign
   * in to.
   *
   * The email match is case-insensitive because the column is `citext`.
   */
  async findGuestOrder(orderNumber: string, email: string): Promise<Order | undefined> {
    const row = await queryOne<OrderRow>(
      `SELECT * FROM orders
        WHERE order_number = $1 AND email = $2 AND customer_id IS NULL`,
      [orderNumber, email],
      { name: 'orders.findGuestOrder' },
    )
    return row ? toOrder(row) : undefined
  },

  async findByNumber(orderNumber: string): Promise<Order | undefined> {
    const row = await queryOne<OrderRow>(`SELECT * FROM orders WHERE order_number = $1`, [orderNumber], {
      name: 'orders.findByNumber',
    })
    return row ? toOrder(row) : undefined
  },

  /** Locks the order, so two staff actions on it serialise (§18.3). */
  async lock(id: string): Promise<Order | undefined> {
    const row = await queryOne<OrderRow>(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [id], {
      name: 'orders.lock',
    })
    return row ? toOrder(row) : undefined
  },

  async items(orderId: string): Promise<OrderItem[]> {
    const rows = await query<ItemRow>(
      `SELECT * FROM order_items WHERE order_id = $1 ORDER BY created_at, id`,
      [orderId],
      { name: 'orders.items' },
    )
    return rows.map(toItem)
  },

  async addresses(orderId: string): Promise<OrderAddress[]> {
    const rows = await query<{
      id: string
      type: 'shipping' | 'billing'
      first_name: string
      last_name: string
      company: string | null
      line1: string
      line2: string | null
      city: string
      region: string | null
      postal_code: string | null
      country_code: string
      phone: string | null
    }>(`SELECT * FROM order_addresses WHERE order_id = $1`, [orderId], {
      name: 'orders.addresses',
    })
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      firstName: row.first_name,
      lastName: row.last_name,
      company: row.company,
      line1: row.line1,
      line2: row.line2,
      city: row.city,
      region: row.region,
      postalCode: row.postal_code,
      countryCode: row.country_code,
      phone: row.phone,
    }))
  },

  async discounts(orderId: string): Promise<OrderDiscount[]> {
    const rows = await query<{
      id: string
      order_id: string
      discount_id: string | null
      code: string
      type: string
      value: number
      amount_cents: number
    }>(`SELECT * FROM order_discounts WHERE order_id = $1`, [orderId], {
      name: 'orders.discounts',
    })
    return rows.map((row) => ({
      id: row.id,
      orderId: row.order_id,
      discountId: row.discount_id,
      code: row.code,
      type: row.type,
      value: row.value,
      amountCents: row.amount_cents,
    }))
  },

  /**
   * Moves one status field, and only from an expected value.
   *
   * The `WHERE … = $expectedFrom` is a compare-and-swap: two staff clicking
   * "cancel" at once produce one transition, and the loser is told the order
   * already moved rather than writing a second history row.
   */
  async transition(input: {
    orderId: string
    field: 'status' | 'payment_status' | 'fulfillment_status'
    from: string
    to: string
    timestamps?: Record<string, 'now' | null>
  }): Promise<boolean> {
    const extra = Object.entries(input.timestamps ?? {})
      .map(([column, value]) => `${column} = ${value === 'now' ? 'now()' : 'NULL'}`)
      .join(', ')

    // Column names come from the typed union and this file, never from input.
    const affected = await execute(
      `UPDATE orders SET ${input.field} = $3${extra ? `, ${extra}` : ''}
        WHERE id = $1 AND ${input.field} = $2`,
      [input.orderId, input.from, input.to],
      { name: 'orders.transition' },
    )
    return affected === 1
  },

  async setFields(orderId: string, patch: Record<string, unknown>): Promise<void> {
    const columns: Record<string, string> = {
      adminNote: 'admin_note',
      cancelReason: 'cancel_reason',
      tags: 'tags',
      shippingMethodId: 'shipping_method_id',
      shippingMethodName: 'shipping_method_name',
      phone: 'phone',
    }
    const params: unknown[] = []
    const sets: string[] = []
    for (const [field, column] of Object.entries(columns)) {
      if (!(field in patch) || patch[field] === undefined) continue
      params.push(patch[field])
      sets.push(`${column} = $${params.length}`)
    }
    if (sets.length === 0) return
    params.push(orderId)
    await execute(`UPDATE orders SET ${sets.join(', ')} WHERE id = $${params.length}`, params, {
      name: 'orders.setFields',
    })
  },

  async recordStatusChange(input: {
    orderId: string
    field: string
    fromValue: string | null
    toValue: string
    actorUserId: string | null
    actorType: 'customer' | 'staff' | 'system' | 'webhook'
    reason?: string | null
    note?: string | null
  }): Promise<void> {
    await execute(
      `INSERT INTO order_status_history
         (order_id, field, from_value, to_value, actor_user_id, actor_type, reason, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        input.orderId, input.field, input.fromValue, input.toValue,
        input.actorUserId, input.actorType, input.reason ?? null, input.note ?? null,
      ],
      { name: 'orders.recordStatusChange' },
    )
  },

  async history(orderId: string): Promise<StatusHistoryEntry[]> {
    const rows = await query<{
      id: string
      field: 'status' | 'payment_status' | 'fulfillment_status'
      from_value: string | null
      to_value: string
      actor_user_id: string | null
      actor_type: 'customer' | 'staff' | 'system' | 'webhook'
      reason: string | null
      note: string | null
      created_at: Date
    }>(
      `SELECT * FROM order_status_history WHERE order_id = $1 ORDER BY created_at, id`,
      [orderId],
      { name: 'orders.history' },
    )
    return rows.map((row) => ({
      id: String(row.id),
      field: row.field,
      fromValue: row.from_value,
      toValue: row.to_value,
      actorUserId: row.actor_user_id,
      actorType: row.actor_type,
      reason: row.reason,
      note: row.note,
      createdAt: row.created_at,
    }))
  },

  // ── Notes ─────────────────────────────────────────────────────────────────

  async insertNote(input: {
    id: string
    orderId: string
    authorUserId: string | null
    authorName: string | null
    body: string
  }): Promise<OrderNote> {
    const row = await queryOne<NoteRow>(
      `INSERT INTO order_notes (id, order_id, author_user_id, author_name, body)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [input.id, input.orderId, input.authorUserId, input.authorName, input.body],
      { name: 'orders.insertNote' },
    )
    if (!row) throw new Error('Failed to create order note')
    return toNote(row)
  },

  async notes(orderId: string): Promise<OrderNote[]> {
    const rows = await query<NoteRow>(
      `SELECT * FROM order_notes WHERE order_id = $1 ORDER BY created_at DESC, id DESC`,
      [orderId],
      { name: 'orders.notes' },
    )
    return rows.map(toNote)
  },

  /** Scoped to its order, so a stray id cannot delete another order's note. */
  async deleteNote(orderId: string, noteId: string): Promise<number> {
    return execute(
      `DELETE FROM order_notes WHERE id = $1 AND order_id = $2`,
      [noteId, orderId],
      { name: 'orders.deleteNote' },
    )
  },

  // ── Timeline sources ──────────────────────────────────────────────────────

  /**
   * Names for the actors a timeline mentions, in one query.
   *
   * The alternative is a join on every source table, which would have to be
   * written five times and would still miss the deleted-account case. Here a
   * missing id simply has no name, and the entry says "system".
   */
  async actorNames(userIds: string[]): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map()
    const rows = await query<{ id: string; first_name: string | null; last_name: string | null; email: string }>(
      `SELECT id, first_name, last_name, email FROM users WHERE id = ANY($1)`,
      [userIds],
      { name: 'orders.actorNames' },
    )
    return new Map(
      rows.map((row) => [
        row.id,
        [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || row.email,
      ]),
    )
  },

  async list(filter: OrderListFilter): Promise<{ rows: Order[]; total: number }> {
    const params: unknown[] = []
    const where: string[] = []
    const add = (sql: string, value: unknown): void => {
      params.push(value)
      where.push(sql.replace('$?', `$${params.length}`))
    }

    if (filter.customerId) add('customer_id = $?', filter.customerId)
    if (filter.status) add('status = $?', filter.status)
    // Drafts appear only when they are asked for by name. Everything that
    // lists orders — the admin queue, a customer's own history, the search —
    // means placed orders, and a draft showing up in any of them is an order
    // somebody has not agreed to yet being presented as one they have.
    else where.push(`status <> 'draft'`)
    if (filter.paymentStatus) add('payment_status = $?', filter.paymentStatus)
    if (filter.fulfillmentStatus) add('fulfillment_status = $?', filter.fulfillmentStatus)
    // `@>` means "carries every one of these", not "any of them" — a two-tag
    // filter narrows rather than widens, which is what an operator expects.
    if (filter.tags && filter.tags.length > 0) add('tags @> $?', filter.tags)
    if (filter.from) add('placed_at >= $?', filter.from)
    if (filter.to) add('placed_at <= $?', filter.to)
    if (filter.query) {
      params.push(`%${filter.query}%`)
      where.push(`(order_number ILIKE $${params.length} OR email ILIKE $${params.length})`)
    }

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const rows = await query<OrderRow>(
      `SELECT * FROM orders ${clause} ORDER BY placed_at DESC, id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filter.limit, filter.offset],
      { name: 'orders.list' },
    )
    const totalRow = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM orders ${clause}`,
      params,
      { name: 'orders.count' },
    )
    return { rows: rows.map(toOrder), total: totalRow?.count ?? 0 }
  },

  /**
   * Attaches a newly verified account to the guest orders it placed.
   *
   * Matching on the email alone would let anyone claim a stranger's order
   * history by typing their address at registration, so this runs only after
   * the address has been **verified** — the subscriber is on
   * `customer.email_verified`, never on `customer.registered`.
   *
   * `customer_id IS NULL` keeps it idempotent and stops it ever moving an order
   * that already belongs to somebody.
   */
  async claimGuestOrders(userId: string, email: string): Promise<number> {
    return execute(
      `UPDATE orders SET customer_id = $1
        WHERE customer_id IS NULL AND email = $2`,
      [userId, email.toLowerCase()],
      { name: 'orders.claimGuestOrders' },
    )
  },

  /**
   * How many unpaid cash-on-delivery orders one customer is already holding.
   *
   * The whole of COD abuse control rests on this number, so it is a single
   * indexed count (`orders_open_cod_idx`) rather than a scan at checkout.
   */
  async countOpenCod(customerId: string): Promise<number> {
    const row = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM orders
        WHERE customer_id = $1
          AND payment_method = 'cod'
          AND status NOT IN ('completed','cancelled')
          AND payment_status = 'pending'`,
      [customerId],
      { name: 'orders.countOpenCod' },
    )
    return row?.count ?? 0
  },

  /**
   * Re-reads the refunded total straight from the row.
   *
   * Used immediately after an atomic increment, because deriving "is this order
   * fully refunded?" from a value read *before* the increment is wrong the
   * moment two refunds overlap.
   */
  async refundedTotal(orderId: string): Promise<number> {
    const row = await queryOne<{ refunded_total_cents: number }>(
      `SELECT refunded_total_cents FROM orders WHERE id = $1`,
      [orderId],
      { name: 'orders.refundedTotal' },
    )
    return row?.refunded_total_cents ?? 0
  },

  async addRefundedTotal(orderId: string, amountCents: number): Promise<void> {
    await execute(
      `UPDATE orders SET refunded_total_cents = refunded_total_cents + $2 WHERE id = $1`,
      [orderId, amountCents],
      { name: 'orders.addRefundedTotal' },
    )
  },

  async incrementFulfilled(orderItemId: string, quantity: number): Promise<boolean> {
    const affected = await execute(
      `UPDATE order_items SET fulfilled_quantity = fulfilled_quantity + $2
        WHERE id = $1 AND fulfilled_quantity + $2 <= quantity`,
      [orderItemId, quantity],
      { name: 'orders.incrementFulfilled' },
    )
    return affected === 1
  },

  async incrementRefunded(orderItemId: string, quantity: number): Promise<boolean> {
    const affected = await execute(
      `UPDATE order_items SET refunded_quantity = refunded_quantity + $2
        WHERE id = $1 AND refunded_quantity + $2 <= quantity`,
      [orderItemId, quantity],
      { name: 'orders.incrementRefunded' },
    )
    return affected === 1
  },
}
