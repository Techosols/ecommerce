/**
 * Discounts and coupons (§5.9, CLAUDE.md §21).
 *
 * Two things are worth stating plainly:
 *
 *   **The server computes the amount.** A client sends a code, never a value.
 *   Anything else is a self-service price list.
 *
 *   **Redemption is atomic and counted twice on purpose.** `usage_count` is a
 *   denormalised counter incremented under a row lock; `discount_redemptions`
 *   is the ledger it must agree with. The counter makes "is this code used up?"
 *   a single indexed read; the ledger makes per-customer limits and any later
 *   audit possible. The lock is what stops the hundredth and hundred-and-first
 *   customer both getting the last use of a limited code.
 */
import { v7 as uuidv7 } from 'uuid'
import { publish } from '../../events/index.js'
import { execute, query, queryOne } from '../../infrastructure/database/query.js'
import { withTransaction } from '../../infrastructure/database/transaction.js'
import { createLogger } from '../../infrastructure/logging/logger.js'
import { registerConstraintError } from '../../infrastructure/database/errors.js'
import type { Actor } from '../../shared/auth/actor.js'
import {
  ConflictError,
  DomainRuleError,
  ERROR_CODES,
  NotFoundError,
} from '../../shared/errors/index.js'
import { auditService, diffChanged } from '../audit/index.js'

const log = createLogger('discounts')

registerConstraintError(
  'discounts_code_key',
  ERROR_CODES.ALREADY_EXISTS,
  'A discount with that code already exists',
)
registerConstraintError(
  'one_redemption_per_order',
  ERROR_CODES.ALREADY_EXISTS,
  'That discount has already been applied to this order',
)

export type DiscountType = 'percentage' | 'fixed_amount' | 'free_shipping'

/**
 * Why a code is or is not working. Ordered by precedence: an archived code is
 * archived whatever its dates say.
 */
export type DiscountStatus =
  | 'active'
  | 'scheduled'
  | 'expired'
  | 'exhausted'
  | 'inactive'
  | 'archived'

/**
 * The same six states as SQL, for filtering a list before it is paged.
 *
 * Kept beside `statusOf` deliberately: they are one rule expressed twice, and
 * the pair only stays correct if a change to either is made looking at the
 * other. The tests assert the two agree on every status.
 */
function statusPredicate(status: DiscountStatus): string {
  switch (status) {
    case 'archived':
      return 'archived_at IS NOT NULL'
    case 'inactive':
      return 'archived_at IS NULL AND NOT is_active'
    case 'scheduled':
      return 'archived_at IS NULL AND is_active AND starts_at IS NOT NULL AND starts_at > now()'
    case 'expired':
      return `archived_at IS NULL AND is_active
              AND (starts_at IS NULL OR starts_at <= now())
              AND ends_at IS NOT NULL AND ends_at <= now()`
    case 'exhausted':
      return `archived_at IS NULL AND is_active
              AND (starts_at IS NULL OR starts_at <= now())
              AND (ends_at IS NULL OR ends_at > now())
              AND usage_limit_total IS NOT NULL AND usage_count >= usage_limit_total`
    case 'active':
      return `archived_at IS NULL AND is_active
              AND (starts_at IS NULL OR starts_at <= now())
              AND (ends_at IS NULL OR ends_at > now())
              AND (usage_limit_total IS NULL OR usage_count < usage_limit_total)`
  }
}

export interface Discount {
  id: string
  code: string
  title: string
  type: DiscountType
  value: number
  appliesTo: 'order' | 'products' | 'categories'
  minSubtotalCents: number
  startsAt: Date | null
  endsAt: Date | null
  usageLimitTotal: number | null
  usageLimitPerCustomer: number | null
  usageCount: number
  requiresCustomer: boolean
  isActive: boolean
  createdAt: Date
  updatedAt: Date
  archivedAt: Date | null
}

interface DiscountRow {
  id: string
  code: string
  title: string
  type: DiscountType
  value: number
  applies_to: 'order' | 'products' | 'categories'
  min_subtotal_cents: number
  starts_at: Date | null
  ends_at: Date | null
  usage_limit_total: number | null
  usage_limit_per_customer: number | null
  usage_count: number
  requires_customer: boolean
  is_active: boolean
  created_at: Date
  updated_at: Date
  archived_at: Date | null
}

function toDiscount(row: DiscountRow): Discount {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    type: row.type,
    value: row.value,
    appliesTo: row.applies_to,
    minSubtotalCents: row.min_subtotal_cents,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    usageLimitTotal: row.usage_limit_total,
    usageLimitPerCustomer: row.usage_limit_per_customer,
    usageCount: row.usage_count,
    requiresCustomer: row.requires_customer,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  }
}

export interface AppliedDiscount {
  discountId: string
  code: string
  type: string
  value: number
  amountCents: number
  freeShipping: boolean
}

export const discountsService = {
  async findByCode(code: string): Promise<Discount | undefined> {
    const row = await queryOne<DiscountRow>(`SELECT * FROM discounts WHERE code = $1`, [code], {
      name: 'discounts.findByCode',
    })
    return row ? toDiscount(row) : undefined
  },

  async getById(id: string): Promise<Discount> {
    const row = await queryOne<DiscountRow>(`SELECT * FROM discounts WHERE id = $1`, [id], {
      name: 'discounts.findById',
    })
    if (!row) throw new NotFoundError('Discount not found')
    return toDiscount(row)
  },

  /**
   * What state a code is in, decided once.
   *
   * Six things can stop a code working and only one of them is the `is_active`
   * flag: it can be archived, switched off, not started yet, finished, or have
   * run out of uses. A console that derived this from four columns would be a
   * second implementation of the eligibility rules in `quote`, and the two
   * would disagree the first time one changed. The names match the reasons
   * `quote` refuses.
   */
  statusOf(discount: Discount, now = new Date()): DiscountStatus {
    if (discount.archivedAt) return 'archived'
    if (!discount.isActive) return 'inactive'
    if (discount.startsAt && discount.startsAt > now) return 'scheduled'
    if (discount.endsAt && discount.endsAt <= now) return 'expired'
    if (discount.usageLimitTotal !== null && discount.usageCount >= discount.usageLimitTotal) {
      return 'exhausted'
    }
    return 'active'
  },

  async list(filter: {
    limit: number
    offset: number
    activeOnly?: boolean
    includeArchived?: boolean
    /** Matches the code or the title, case-insensitively. */
    query?: string
    status?: DiscountStatus
  }) {
    const params: unknown[] = []
    const where: string[] = []
    const push = (value: unknown) => {
      params.push(value)
      return `$${params.length}`
    }

    if (!filter.includeArchived) where.push('archived_at IS NULL')
    if (filter.activeOnly) where.push('is_active')
    if (filter.query) {
      const like = push(`%${filter.query.trim()}%`)
      // `code` is citext, `title` is not, so only the title needs lowering.
      where.push(`(code ILIKE ${like} OR title ILIKE ${like})`)
    }

    // Pushed into SQL rather than filtered after paging: filtering a page in
    // memory would leave the pager offering pages that come back empty.
    if (filter.status) {
      where.push(statusPredicate(filter.status))
    }

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const rows = await query<DiscountRow>(
      `SELECT * FROM discounts ${clause}
        ORDER BY created_at DESC LIMIT ${push(filter.limit)} OFFSET ${push(filter.offset)}`,
      params,
      { name: 'discounts.list' },
    )
    const totalRow = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM discounts ${clause}`,
      params.slice(0, params.length - 2),
      { name: 'discounts.count' },
    )
    return { rows: rows.map(toDiscount), total: totalRow?.count ?? 0 }
  },

  /**
   * What a scoped discount covers, as ids.
   *
   * Returned for every discount rather than only the scoped ones: a discount
   * whose `appliesTo` was set to `order` still has its old lists in the join
   * tables, and a screen that hid them would silently discard the scope the
   * moment somebody switched the setting back.
   */
  async scopeOf(discountId: string): Promise<{ productIds: string[]; categoryIds: string[] }> {
    const [products, categories] = await Promise.all([
      query<{ product_id: string }>(
        `SELECT product_id FROM discount_products WHERE discount_id = $1`,
        [discountId],
        { name: 'discounts.scopeProducts' },
      ),
      query<{ category_id: string }>(
        `SELECT category_id FROM discount_categories WHERE discount_id = $1`,
        [discountId],
        { name: 'discounts.scopeCategories' },
      ),
    ])
    return {
      productIds: products.map((row) => row.product_id),
      categoryIds: categories.map((row) => row.category_id),
    }
  },

  /**
   * Replaces one side of a discount's scope.
   *
   * Wholesale rather than add/remove, because the screen holds the whole list
   * and a diff computed in the browser against a stale copy is how a product
   * quietly falls out of a promotion.
   */
  async setScope(
    discountId: string,
    scope: { productIds?: string[]; categoryIds?: string[] },
  ): Promise<void> {
    if (scope.productIds) {
      await execute(`DELETE FROM discount_products WHERE discount_id = $1`, [discountId], {
        name: 'discounts.clearProducts',
      })
      if (scope.productIds.length > 0) {
        await execute(
          `INSERT INTO discount_products (discount_id, product_id)
             SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
          [discountId, scope.productIds],
          { name: 'discounts.setProducts' },
        )
      }
    }

    if (scope.categoryIds) {
      await execute(`DELETE FROM discount_categories WHERE discount_id = $1`, [discountId], {
        name: 'discounts.clearCategories',
      })
      if (scope.categoryIds.length > 0) {
        await execute(
          `INSERT INTO discount_categories (discount_id, category_id)
             SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
          [discountId, scope.categoryIds],
          { name: 'discounts.setCategories' },
        )
      }
    }
  },

  /**
   * The redemption ledger for one code.
   *
   * `usage_count` says a code was used 47 times; this says what those 47 cost,
   * to whom, and on which orders — which is the question anyone asking about a
   * campaign is actually asking. Read from `discount_redemptions` rather than
   * summed from orders, because that table is what the per-customer limit is
   * counted from and the two must not be able to disagree.
   */
  async redemptions(filter: { discountId: string; limit: number; offset: number }) {
    const rows = await query<{
      id: string
      order_id: string
      order_number: string | null
      customer_id: string | null
      customer_email: string | null
      amount_cents: number
      created_at: Date
    }>(
      `SELECT r.id, r.order_id, o.order_number, r.customer_id, u.email AS customer_email,
              r.amount_cents, r.created_at
         FROM discount_redemptions r
         LEFT JOIN orders o ON o.id = r.order_id
         LEFT JOIN users u ON u.id = r.customer_id
        WHERE r.discount_id = $1
        ORDER BY r.created_at DESC
        LIMIT $2 OFFSET $3`,
      [filter.discountId, filter.limit, filter.offset],
      { name: 'discounts.redemptions' },
    )

    const summary = await queryOne<{ count: number; total: number }>(
      `SELECT count(*)::int AS count, COALESCE(sum(amount_cents), 0)::int AS total
         FROM discount_redemptions WHERE discount_id = $1`,
      [filter.discountId],
      { name: 'discounts.redemptionTotals' },
    )

    return {
      rows: rows.map((row) => ({
        id: row.id,
        orderId: row.order_id,
        orderNumber: row.order_number,
        customerId: row.customer_id,
        customerEmail: row.customer_email,
        amountCents: row.amount_cents,
        createdAt: row.created_at,
      })),
      total: summary?.count ?? 0,
      /** What the code has given away, in minor units. */
      totalAmountCents: summary?.total ?? 0,
    }
  },

  /**
   * The part of a basket a discount actually applies to.
   *
   * An order-wide discount covers everything. A scoped one covers only the
   * lines whose product is in its list — directly for `products`, or through
   * the product's category for `categories`.
   *
   * This is the difference between "10% off coffee" and "10% off". Computing
   * the discount against the whole subtotal regardless of scope means a store
   * running a promotion on one product gives it away on the entire catalogue,
   * and nothing in the response would say so.
   */
  async eligibleSubtotal(
    discount: Discount,
    lines: { productId: string; lineTotalCents: number }[],
  ): Promise<number> {
    const total = lines.reduce((sum, line) => sum + line.lineTotalCents, 0)
    if (discount.appliesTo === 'order') return total
    if (lines.length === 0) return 0

    const productIds = [...new Set(lines.map((line) => line.productId))]

    const rows =
      discount.appliesTo === 'products'
        ? await query<{ product_id: string }>(
            `SELECT product_id FROM discount_products
              WHERE discount_id = $1 AND product_id = ANY($2::uuid[])`,
            [discount.id, productIds],
            { name: 'discounts.scopedProducts' },
          )
        : await query<{ product_id: string }>(
            // A category scope reaches the products through their category, so
            // adding a product to a category puts it in the promotion without
            // anyone editing the discount.
            `SELECT p.id AS product_id FROM products p
               JOIN discount_categories dc ON dc.category_id = p.category_id
              WHERE dc.discount_id = $1 AND p.id = ANY($2::uuid[])`,
            [discount.id, productIds],
            { name: 'discounts.scopedCategories' },
          )

    const covered = new Set(rows.map((row) => row.product_id))
    return lines
      .filter((line) => covered.has(line.productId))
      .reduce((sum, line) => sum + line.lineTotalCents, 0)
  },

  /**
   * Checks a code and computes what it is worth, without consuming it.
   *
   * Used at checkout to quote, and by the storefront to show the effect before
   * anyone commits. Every reason for refusal has its own code, because "invalid
   * coupon" is the message that generates support tickets.
   */
  async quote(input: {
    code: string
    subtotalCents: number
    customerId: string | null
    /**
     * The basket, when the caller has it. Required for a scoped discount to
     * mean anything; an order-wide one ignores it.
     */
    lines?: { productId: string; lineTotalCents: number }[]
  }): Promise<AppliedDiscount> {
    const discount = await this.findByCode(input.code.trim())
    if (!discount || discount.archivedAt || !discount.isActive) {
      throw new DomainRuleError(ERROR_CODES.DISCOUNT_INVALID, 'That code is not valid')
    }

    const now = new Date()
    if (discount.startsAt && discount.startsAt > now) {
      throw new DomainRuleError(ERROR_CODES.DISCOUNT_EXPIRED, 'That code is not active yet')
    }
    if (discount.endsAt && discount.endsAt <= now) {
      throw new DomainRuleError(ERROR_CODES.DISCOUNT_EXPIRED, 'That code has expired')
    }
    if (discount.requiresCustomer && !input.customerId) {
      throw new DomainRuleError(
        ERROR_CODES.DISCOUNT_REQUIRES_ACCOUNT,
        'Sign in to use that code',
      )
    }
    if (input.subtotalCents < discount.minSubtotalCents) {
      throw new DomainRuleError(
        ERROR_CODES.DISCOUNT_MINIMUM_NOT_MET,
        `That code needs a subtotal of at least ${discount.minSubtotalCents}`,
      )
    }
    if (discount.usageLimitTotal !== null && discount.usageCount >= discount.usageLimitTotal) {
      throw new DomainRuleError(ERROR_CODES.DISCOUNT_USAGE_EXCEEDED, 'That code has been fully used')
    }
    if (discount.usageLimitPerCustomer !== null && input.customerId) {
      const used = await this.countForCustomer(discount.id, input.customerId)
      if (used >= discount.usageLimitPerCustomer) {
        throw new DomainRuleError(
          ERROR_CODES.DISCOUNT_USAGE_EXCEEDED,
          'You have already used that code',
        )
      }
    }

    // The scope is applied here, against the lines the caller supplied. With no
    // lines a scoped discount has nothing it can prove it covers, so it is
    // worth nothing rather than silently worth everything — the failure that
    // gives away a whole catalogue.
    const base =
      discount.appliesTo === 'order'
        ? input.subtotalCents
        : await this.eligibleSubtotal(discount, input.lines ?? [])

    if (discount.appliesTo !== 'order' && base === 0) {
      throw new DomainRuleError(
        ERROR_CODES.DISCOUNT_INVALID,
        'That code does not apply to anything in your basket',
      )
    }

    return {
      discountId: discount.id,
      code: discount.code,
      type: discount.type,
      value: discount.value,
      amountCents: this.amountFor(discount, base),
      freeShipping: discount.type === 'free_shipping',
    }
  },

  /**
   * What a discount is worth against a subtotal.
   *
   * Integer arithmetic throughout, and never more than the subtotal: a £20 code
   * on a £15 basket takes £15, not £20 and a negative total.
   */
  amountFor(discount: Discount, subtotalCents: number): number {
    if (discount.type === 'free_shipping') return 0
    if (discount.type === 'percentage') {
      return Math.min(Math.round((subtotalCents * discount.value) / 10_000), subtotalCents)
    }
    return Math.min(discount.value, subtotalCents)
  },

  async countForCustomer(discountId: string, customerId: string): Promise<number> {
    const row = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM discount_redemptions
        WHERE discount_id = $1 AND customer_id = $2`,
      [discountId, customerId],
      { name: 'discounts.countForCustomer' },
    )
    return row?.count ?? 0
  },

  /**
   * Consumes a use of the code, atomically.
   *
   * The conditional `UPDATE` is the whole limit enforcement: two customers
   * racing for the last use of a code both increment, but only one satisfies
   * `usage_count < usage_limit_total` and the other affects zero rows.
   */
  async redeem(input: {
    discountId: string
    orderId: string
    customerId: string | null
    amountCents: number
  }): Promise<void> {
    await withTransaction(async () => {
      const claimed = await execute(
        `UPDATE discounts
            SET usage_count = usage_count + 1
          WHERE id = $1
            AND (usage_limit_total IS NULL OR usage_count < usage_limit_total)`,
        [input.discountId],
        { name: 'discounts.consumeUse' },
      )
      if (claimed !== 1) {
        throw new ConflictError('That code has been fully used', {
          code: ERROR_CODES.DISCOUNT_USAGE_EXCEEDED,
        })
      }

      // ── The per-customer limit, re-checked under the lock ────────────────
      //
      // `quote()` also checks this, but that check is a read: two simultaneous
      // checkouts by the same person both see zero redemptions and both pass
      // it. The total limit does not have that problem because the conditional
      // UPDATE above *is* the check.
      //
      // The same UPDATE is what fixes this one. It takes a row lock on the
      // discount, so any two redemptions of the same code serialise here; by
      // the time the second gets through, the first's ledger row is committed
      // and this count sees it. Checking after the lock rather than before it
      // is the whole difference.
      const discount = await this.getById(input.discountId)
      if (discount.usageLimitPerCustomer !== null && input.customerId) {
        const used = await this.countForCustomer(input.discountId, input.customerId)
        if (used >= discount.usageLimitPerCustomer) {
          throw new ConflictError('You have already used that code', {
            code: ERROR_CODES.DISCOUNT_USAGE_EXCEEDED,
          })
        }
      }

      await execute(
        `INSERT INTO discount_redemptions (id, discount_id, order_id, customer_id, amount_cents)
         VALUES ($1,$2,$3,$4,$5)`,
        [uuidv7(), input.discountId, input.orderId, input.customerId, input.amountCents],
        { name: 'discounts.recordRedemption' },
      )

      await publish(
        'discount.redeemed',
        {
          discountId: input.discountId,
          code: discount.code,
          orderId: input.orderId,
          customerId: input.customerId,
          amountCents: input.amountCents,
        },
        { aggregateId: input.discountId, actorUserId: input.customerId ?? undefined },
      )
    })
  },

  /**
   * Gives the code's use back when an order is cancelled.
   *
   * Called for every cancellation, paid or not: an order that did not happen
   * should not have consumed a limited code, and a customer whose order the
   * shop cancelled would otherwise be left unable to reuse their own discount.
   * Deleting the ledger row is idempotent, so a redelivered `order.cancelled`
   * cannot hand the use back twice.
   */
  async releaseRedemption(orderId: string): Promise<void> {
    const rows = await query<{ discount_id: string }>(
      `DELETE FROM discount_redemptions WHERE order_id = $1 RETURNING discount_id`,
      [orderId],
      { name: 'discounts.releaseRedemption' },
    )
    for (const row of rows) {
      await execute(
        `UPDATE discounts SET usage_count = greatest(usage_count - 1, 0) WHERE id = $1`,
        [row.discount_id],
        { name: 'discounts.returnUse' },
      )
    }
  },

  // ── Administration ────────────────────────────────────────────────────────

  async create(
    input: {
      code: string
      title: string
      type: DiscountType
      value: number
      appliesTo?: 'order' | 'products' | 'categories'
      minSubtotalCents?: number
      startsAt?: string | null
      endsAt?: string | null
      usageLimitTotal?: number | null
      usageLimitPerCustomer?: number | null
      requiresCustomer?: boolean
      productIds?: string[]
      categoryIds?: string[]
    },
    actor: Actor,
  ): Promise<Discount> {
    const id = uuidv7()

    await withTransaction(async () => {
      await execute(
        `INSERT INTO discounts
           (id, code, title, type, value, applies_to, min_subtotal_cents, starts_at, ends_at,
            usage_limit_total, usage_limit_per_customer, requires_customer, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          id, input.code.trim(), input.title.trim(), input.type, input.value,
          input.appliesTo ?? 'order', input.minSubtotalCents ?? 0,
          input.startsAt ?? null, input.endsAt ?? null,
          input.usageLimitTotal ?? null, input.usageLimitPerCustomer ?? null,
          input.requiresCustomer ?? false, actor.userId,
        ],
        { name: 'discounts.create' },
      )

      await this.setScope(id, {
        ...(input.productIds ? { productIds: input.productIds } : {}),
        ...(input.categoryIds ? { categoryIds: input.categoryIds } : {}),
      })

      await auditService.record({
        actor,
        action: 'discount.created',
        resourceType: 'discount',
        resourceId: id,
        after: { code: input.code, type: input.type, value: input.value },
      })
      await publish(
        'discount.created',
        { discountId: id, code: input.code.trim(), actorId: actor.userId },
        { aggregateId: id, actorUserId: actor.userId },
      )
    })

    log.info({ discountId: id, code: input.code }, 'discount created')
    return this.getById(id)
  },

  async update(
    id: string,
    patch: Record<string, unknown>,
    actor: Actor,
  ): Promise<Discount> {
    const before = await this.getById(id)
    const columns: Record<string, string> = {
      title: 'title',
      value: 'value',
      // Scope may change: "10% off coffee" can become "10% off", and a
      // promotion can be corrected after somebody picked the wrong category.
      // The code and the type cannot — an order citing SUMMER25 as a
      // percentage must keep meaning that.
      appliesTo: 'applies_to',
      minSubtotalCents: 'min_subtotal_cents',
      startsAt: 'starts_at',
      endsAt: 'ends_at',
      usageLimitTotal: 'usage_limit_total',
      usageLimitPerCustomer: 'usage_limit_per_customer',
      requiresCustomer: 'requires_customer',
      isActive: 'is_active',
    }
    const params: unknown[] = []
    const sets: string[] = []
    for (const [field, column] of Object.entries(columns)) {
      if (!(field in patch) || patch[field] === undefined) continue
      params.push(patch[field])
      sets.push(`${column} = $${params.length}`)
    }
    if (sets.length > 0) {
      params.push(id)
      await execute(`UPDATE discounts SET ${sets.join(', ')} WHERE id = $${params.length}`, params, {
        name: 'discounts.update',
      })
    }

    if (Array.isArray(patch.productIds) || Array.isArray(patch.categoryIds)) {
      await this.setScope(id, {
        ...(Array.isArray(patch.productIds) ? { productIds: patch.productIds as string[] } : {}),
        ...(Array.isArray(patch.categoryIds) ? { categoryIds: patch.categoryIds as string[] } : {}),
      })
    }

    const changed = diffChanged(before as unknown as Record<string, unknown>, patch)
    if (changed) {
      await auditService.record({
        actor,
        action: 'discount.updated',
        resourceType: 'discount',
        resourceId: id,
        before: changed.before,
        after: changed.after,
      })
    }
    return this.getById(id)
  },

  /** Archive, never delete: past orders cite the code and its terms. */
  async archive(id: string, actor: Actor): Promise<void> {
    const discount = await this.getById(id)
    await execute(
      `UPDATE discounts SET archived_at = now(), is_active = false WHERE id = $1`,
      [id],
      { name: 'discounts.archive' },
    )
    await auditService.record({
      actor,
      action: 'discount.archived',
      resourceType: 'discount',
      resourceId: id,
      before: { code: discount.code },
    })
  },
}
