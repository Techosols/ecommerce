/**
 * Orders staff build by hand (§8.4).
 *
 * A draft is an order that has not been placed: an `orders` row in status
 * `draft`, with its lines in `order_items` like any other order's. It is
 * assembled over several requests — add a product, change a quantity, put an
 * address on it — and quoted at every step.
 *
 * ── What a draft deliberately does not do ───────────────────────────────────
 *
 * **It holds no stock.** Reserving on a draft would let a phone call empty the
 * shelf; the reservation is taken when it is placed, in the same transaction
 * as everything else, exactly as a storefront checkout takes it.
 *
 * **It is not counted as a sale.** Every order read path excludes drafts, so a
 * quote cannot appear in revenue, in a customer's lifetime value, or in the
 * queue of orders awaiting payment (0026).
 *
 * **It does not price itself.** The quote comes from the same code that prices
 * the storefront — `cartsService.resolveLines` for the catalogue, and
 * `checkoutService.preview` for delivery, discounts and tax — so a draft and a
 * checkout can never disagree about what a basket costs.
 *
 * Placing one runs the ordinary checkout over the draft's lines. It produces a
 * real order and the draft then points at it, kept as the record of what was
 * quoted and by whom.
 */
import { v7 as uuidv7 } from 'uuid'
import { execute, query, queryOne } from '../../infrastructure/database/query.js'
import { withTransaction } from '../../infrastructure/database/transaction.js'
import { createLogger } from '../../infrastructure/logging/logger.js'
import type { Actor } from '../../shared/auth/actor.js'
import {
  DomainRuleError,
  ERROR_CODES,
  NotFoundError,
  ValidationError,
  isAppError,
} from '../../shared/errors/index.js'
import { auditService } from '../audit/index.js'
import { cartsService } from '../carts/index.js'
import type { ResolvedCart } from '../carts/index.js'
import { settingsService } from '../settings/index.js'
import { ordersRepository as repo } from './orders.repository.js'
import type { AddressSnapshot, Order, OrderDetail } from './orders.types.js'

const log = createLogger('orders.drafts')

/** A draft carries a placeholder until it is placed and earns a real one. */
function draftNumber(): string {
  return `DRAFT-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
}

/**
 * The message a rule refused with, for showing as a blocker.
 *
 * Domain errors carry a sentence written for the person reading it — "This
 * order is above the maximum for cash on delivery" — and that sentence is the
 * whole value of catching them. Anything else gets a neutral line rather than
 * an internal message on a staff member's screen.
 */
function errorMessage(error: unknown): string {
  return isAppError(error) && error.message
    ? error.message
    : 'This draft could not be priced. Check the delivery address and the discount code.'
}

export interface DraftLineInput {
  variantId: string
  quantity: number
}

/** A delivery option, as the rating service returns it. */
export interface DraftShippingOption {
  methodId: string
  name: string
  description: string | null
  amountCents: number
  estimatedDaysMin: number | null
  estimatedDaysMax: number | null
}

/** A way to pay, as the payment rules return it. */
export interface DraftPaymentOption {
  key: string
  label: string
  description: string
  feeCents: number
}

/**
 * What checkout would charge for this basket.
 *
 * Injected rather than imported, for the same reason `checkout` takes hooks:
 * this file must not learn that shipping, discounts and payments exist. In
 * production it is `checkoutService.preview`, which is the function the
 * storefront quotes with — so a draft and a checkout cannot disagree.
 */
export type DraftPricer = (args: {
  basket: ResolvedCart
  cartId: string
  countryCode: string
  shippingMethodId: string | null
  discountCode: string | null
  paymentMethod: string | null
  customerId: string | null
}) => Promise<{
  discountTotalCents: number
  shippingTotalCents: number
  taxTotalCents: number
  paymentFeeCents: number
  totalCents: number
  shippingOptions: DraftShippingOption[]
  selectedShippingMethodId: string | null
  paymentMethods: DraftPaymentOption[]
  selectedPaymentMethod: string | null
}>

export interface DraftQuote {
  draft: Order
  lines: ResolvedCart['lines']
  /**
   * The lines in the shape checkout takes, built once here.
   *
   * `place` hands this straight on rather than assembling its own, so the
   * basket that was quoted on screen and the basket that is charged are the
   * same object — not two constructions that could come to differ.
   */
  basket: ResolvedCart
  totals: {
    subtotalCents: number
    discountCents: number
    shippingCents: number
    taxCents: number
    paymentFeeCents: number
    totalCents: number
    currency: string
  }
  /** What staff may choose from, for this basket and this address. */
  shippingOptions: DraftShippingOption[]
  paymentMethods: DraftPaymentOption[]
  /** True when every line can still be bought, which placing requires. */
  purchasable: boolean
  /** Why it cannot be placed yet, in the order a person would fix them. */
  blockers: string[]
}

export const draftsService = {
  /**
   * Starts one. Empty, because the first thing staff do is add a product.
   *
   * An order number is *not* taken from the sequence: a draft that is deleted
   * would burn one, and a shop counting its orders by number should not see
   * gaps for quotes nobody placed. The real number is assigned at placement.
   */
  async create(
    input: { customerId?: string | null; email?: string | null; customerNote?: string | null },
    actor: Actor,
  ): Promise<Order> {
    const settings = await settingsService.get()
    const id = uuidv7()

    await execute(
      // The money columns are `NOT NULL` because an *order* always has totals.
      // A draft's are a running tally of its lines, kept current by `setLines`
      // so the list can show a figure without re-pricing every row — never the
      // authority on what it costs. That is `quote`, which re-resolves against
      // the catalogue, and the placement, which re-resolves again.
      `INSERT INTO orders
         (id, order_number, customer_id, email, currency, status, payment_method,
          customer_note, source, drafted_by, subtotal_cents, total_cents)
       VALUES ($1,$2,$3,$4,$5,'draft','manual',$6,'admin',$7,0,0)`,
      [
        id,
        draftNumber(),
        input.customerId ?? null,
        input.email?.toLowerCase() ?? '',
        settings.currency,
        input.customerNote ?? null,
        actor.userId,
      ],
      { name: 'drafts.create' },
    )

    await auditService.record({
      actor,
      action: 'order.draft_created',
      resourceType: 'order',
      resourceId: id,
      after: { customerId: input.customerId ?? null, email: input.email ?? null },
    })

    log.info({ draftId: id, actorId: actor.userId }, 'draft order created')
    return this.get(id)
  },

  /**
   * The draft's lines in the shape checkout and preview both take.
   *
   * One function rather than two, because the basket that is quoted on screen
   * and the basket that is placed must be the same object by construction —
   * two hand-built copies would eventually differ, and the difference would be
   * a price a customer was quoted and not charged.
   *
   * The cart it wraps is a stand-in with the draft's id: nothing loads it, and
   * the totals below it are recomputed by whoever receives it. They are here
   * because `ResolvedCart` demands them, not because a draft has an opinion.
   */
  asBasket(draft: Order, resolved: Omit<ResolvedCart, 'cart'>): ResolvedCart {
    const zero = { amount: 0, currency: draft.currency }
    return {
      cart: {
        id: draft.id,
        customerId: draft.customerId,
        status: 'active',
        currency: draft.currency,
        convertedOrderId: null,
        lastActivityAt: new Date(),
        expiresAt: new Date(Date.now() + 3_600_000),
        createdAt: draft.placedAt,
        updatedAt: new Date(),
      },
      lines: resolved.lines,
      totals: {
        subtotal: resolved.totals.subtotal,
        discountTotal: zero,
        taxTotal: zero,
        shippingTotal: zero,
        total: resolved.totals.subtotal,
        itemCount: resolved.lines.reduce((sum, line) => sum + line.quantity, 0),
      },
      purchasable: resolved.purchasable,
    }
  },

  async get(id: string): Promise<Order> {
    const order = await repo.findById(id)
    if (!order) throw new NotFoundError('Draft not found')
    if (order.status !== 'draft') throw new NotFoundError('Draft not found')
    return order
  },

  async list(filter: { limit: number; offset: number; query?: string }) {
    return repo.list({ ...filter, status: 'draft' })
  },

  /**
   * Replaces the draft's lines and re-quotes.
   *
   * Wholesale rather than add/remove, for the same reason a discount's scope
   * is: the screen holds the whole list, and a diff computed in the browser
   * against a stale copy is how a line quietly disappears.
   *
   * The stored line is a *snapshot at the moment of editing* — title, price,
   * options — because `order_items` is a snapshot table. It is re-resolved
   * against the catalogue on every read, so what the screen shows is always
   * current, and it is re-resolved again at placement, which is the copy that
   * counts.
   */
  async setLines(id: string, lines: DraftLineInput[], actor: Actor): Promise<Order> {
    const draft = await this.get(id)
    if (lines.length > 100) throw new ValidationError('A draft may hold at most 100 lines')

    const merged = new Map<string, number>()
    for (const line of lines) {
      if (line.quantity <= 0) continue
      merged.set(line.variantId, (merged.get(line.variantId) ?? 0) + line.quantity)
    }

    const resolved = await cartsService.resolveLines(
      [...merged].map(([variantId, quantity]) => ({ id: uuidv7(), variantId, quantity })),
      draft.currency,
    )

    await withTransaction(async () => {
      await execute(`DELETE FROM order_items WHERE order_id = $1`, [id], {
        name: 'drafts.clearLines',
      })

      for (const line of resolved.lines) {
        await repo.insertItem({
          id: uuidv7(),
          orderId: id,
          variantId: line.variantId,
          productId: line.productId,
          productTitle: line.productTitle,
          variantTitle: line.variantTitle,
          sku: line.sku,
          imageUrl: line.imageUrl,
          options: line.options,
          unitPriceCents: line.unitPrice.amount,
          quantity: line.quantity,
          subtotalCents: line.lineTotal.amount,
          // A draft carries no apportioned discount or tax: those are computed
          // over the whole basket at placement, and storing a stale share here
          // would be a number nothing reads and everyone believes.
          discountCents: 0,
          taxCents: 0,
          totalCents: line.lineTotal.amount,
          requiresShipping: line.requiresShipping,
          weightGrams: line.weightGrams,
        })
      }

      // The running tally, for the list. Not what it costs — see `create`.
      await execute(
        `UPDATE orders SET subtotal_cents = $2, total_cents = $2, updated_at = now()
           WHERE id = $1`,
        [id, resolved.totals.subtotal.amount],
        { name: 'drafts.touch' },
      )
    })

    await auditService.record({
      actor,
      action: 'order.draft_updated',
      resourceType: 'order',
      resourceId: id,
      after: { lineCount: resolved.lines.length },
    })

    // The caller re-quotes, because quoting needs the pricer and this file
    // must not know what a pricer is made of.
    return this.get(id)
  },

  /**
   * Sets the things a checkout needs that are not lines.
   *
   * The address, the email, the delivery method and the code. Stored on the
   * draft so it survives a reload, and handed to checkout unchanged when it is
   * placed.
   */
  async update(
    id: string,
    patch: {
      customerId?: string | null
      email?: string | null
      phone?: string | null
      paymentMethod?: string
      shippingMethodId?: string | null
      discountCode?: string | null
      customerNote?: string | null
      shippingAddress?: AddressSnapshot
      billingAddress?: AddressSnapshot
    },
    actor: Actor,
  ): Promise<Order> {
    await this.get(id)

    const columns: Record<string, string> = {
      customerId: 'customer_id',
      email: 'email',
      phone: 'phone',
      paymentMethod: 'payment_method',
      shippingMethodId: 'shipping_method_id',
      customerNote: 'customer_note',
    }
    const params: unknown[] = []
    const sets: string[] = []
    for (const [field, column] of Object.entries(columns)) {
      if (!(field in patch)) continue
      const value = patch[field as keyof typeof patch]
      params.push(field === 'email' && typeof value === 'string' ? value.toLowerCase() : value)
      sets.push(`${column} = $${params.length}`)
    }

    // An input to the quote rather than a fact about the order: checkout
    // validates it afresh at placement, and `order_discounts` is where the
    // real order's discount lands.
    if ('discountCode' in patch) {
      params.push(patch.discountCode ?? null)
      sets.push(`draft_discount_code = $${params.length}`)
    }

    if (sets.length > 0) {
      params.push(id)
      await execute(
        `UPDATE orders SET ${sets.join(', ')} WHERE id = $${params.length} AND status = 'draft'`,
        params,
        { name: 'drafts.update' },
      )
    }

    if (patch.shippingAddress) await this.setAddress(id, 'shipping', patch.shippingAddress)
    if (patch.billingAddress) await this.setAddress(id, 'billing', patch.billingAddress)

    await auditService.record({
      actor,
      action: 'order.draft_updated',
      resourceType: 'order',
      resourceId: id,
      after: patch as Record<string, unknown>,
    })

    return this.get(id)
  },

  async setAddress(id: string, type: 'shipping' | 'billing', address: AddressSnapshot) {
    await withTransaction(async () => {
      await execute(`DELETE FROM order_addresses WHERE order_id = $1 AND type = $2`, [id, type], {
        name: 'drafts.clearAddress',
      })
      await repo.insertAddress({ id: uuidv7(), orderId: id, type, ...address })
    })
  },

  /**
   * What the draft costs right now, and what stops it being placed.
   *
   * Every figure comes from the same code the storefront uses. The blockers
   * are listed rather than thrown, because a draft is *expected* to be
   * incomplete while somebody is building it — refusing to answer until it is
   * finished would make the screen useless exactly while it is being used.
   */
  async quote(id: string, price?: DraftPricer): Promise<DraftQuote> {
    const draft = await this.get(id)
    const items = await repo.items(id)
    const resolved = await cartsService.resolveLines(
      items.map((item) => ({ id: item.id, variantId: item.variantId ?? '', quantity: item.quantity })),
      draft.currency,
    )

    const addresses = await repo.addresses(id)
    const shipping = addresses.find((address) => address.type === 'shipping')

    const blockers: string[] = []
    if (resolved.lines.length === 0) blockers.push('Add at least one product.')
    if (!draft.email) blockers.push('Add an email address to send the order to.')
    if (!shipping) blockers.push('Add a delivery address.')
    if (resolved.lines.length > 0 && !resolved.purchasable) {
      const problems = resolved.lines
        .filter((line) => !line.purchasable)
        .map((line) => `${line.productTitle}: ${line.problem}`)
      blockers.push(`Some lines cannot be bought — ${problems.join('; ')}`)
    }

    const subtotalCents = resolved.totals.subtotal.amount
    const basket = this.asBasket(draft, resolved)

    // Priced only once there is somewhere to deliver to and something to
    // deliver: delivery is rated against a country and a discount is quoted
    // against a basket, and inventing either to fill the screen would put a
    // number in front of staff that checkout has not agreed to.
    let priced: Awaited<ReturnType<DraftPricer>> | null = null
    if (price && shipping && resolved.lines.length > 0) {
      try {
        priced = await price({
          basket,
          cartId: id,
          countryCode: shipping.countryCode,
          shippingMethodId: draft.shippingMethodId,
          discountCode: draft.draftDiscountCode,
          paymentMethod: draft.paymentMethod,
          customerId: draft.customerId,
        })
      } catch (error) {
        // A code that does not apply, or a payment method this basket cannot
        // use, is a thing to fix — not a screen that fails to load. It becomes
        // a blocker in the words the rule itself used.
        blockers.push(errorMessage(error))
      }
    }

    // Delivery, once there is a quote to judge it against.
    //
    // Checkout refuses an order that ships with no method chosen, so the
    // blockers have to say so — a button the server will reject is worse than
    // no button. The three cases are separate because they are three different
    // things for the person to do.
    if (priced && resolved.lines.some((line) => line.requiresShipping)) {
      if (priced.shippingOptions.length === 0) {
        blockers.push('Nothing can be delivered to that address. Check it, or add a shipping zone.')
      } else if (!draft.shippingMethodId) {
        blockers.push('Choose a delivery option.')
      } else if (!priced.shippingOptions.some((o) => o.methodId === draft.shippingMethodId)) {
        blockers.push('That delivery option no longer applies to this order. Choose another.')
      }
    }

    return {
      draft,
      lines: resolved.lines,
      basket,
      totals: {
        subtotalCents,
        discountCents: priced?.discountTotalCents ?? 0,
        shippingCents: priced?.shippingTotalCents ?? 0,
        taxCents: priced?.taxTotalCents ?? 0,
        paymentFeeCents: priced?.paymentFeeCents ?? 0,
        // Without a price there is nothing to add to the merchandise yet, and
        // showing the subtotal as though it were the total would misstate it.
        totalCents: priced?.totalCents ?? subtotalCents,
        currency: draft.currency,
      },
      shippingOptions: priced?.shippingOptions ?? [],
      paymentMethods: priced?.paymentMethods ?? [],
      purchasable: resolved.purchasable,
      blockers,
    }
  },

  /**
   * Places it, through the ordinary checkout.
   *
   * `place` is injected rather than imported so that this file does not pull in
   * shipping, discounts and payments — the same reason `checkout` takes hooks.
   * The order it returns is a real order in every respect: reserved stock, a
   * sequence number, `order.placed` raised, and `source: 'admin'`.
   */
  async place(
    id: string,
    actor: Actor,
    place: (input: {
      basket: ResolvedCart
      email: string
      paymentMethod: string
      phone: string | null
      shippingAddress: AddressSnapshot
      billingAddress?: AddressSnapshot
      shippingMethodId: string | null
      discountCode: string | null
      customerNote: string | null
      customerId: string | null
    }) => Promise<OrderDetail>,
  ): Promise<OrderDetail> {
    const quote = await this.quote(id)

    // A draft becomes a sale exactly once. The idempotency key covers a
    // double-clicked button within its window; this covers the same draft
    // opened in a second tab an hour later, which would otherwise reserve the
    // stock twice and bill the customer twice.
    if (quote.draft.placedOrderId) {
      throw new DomainRuleError(
        ERROR_CODES.DOMAIN_RULE_VIOLATION,
        'That draft has already been placed.',
      )
    }

    if (quote.blockers.length > 0) {
      throw new DomainRuleError(ERROR_CODES.DOMAIN_RULE_VIOLATION, quote.blockers[0] as string)
    }

    const draft = quote.draft
    const addresses = await repo.addresses(id)
    const shipping = addresses.find((address) => address.type === 'shipping')
    const billing = addresses.find((address) => address.type === 'billing')
    if (!shipping) {
      throw new DomainRuleError(ERROR_CODES.DOMAIN_RULE_VIOLATION, 'Add a delivery address.')
    }

    const toSnapshot = (address: typeof shipping): AddressSnapshot => ({
      firstName: address.firstName,
      lastName: address.lastName,
      company: address.company,
      line1: address.line1,
      line2: address.line2,
      city: address.city,
      region: address.region,
      postalCode: address.postalCode,
      countryCode: address.countryCode,
      phone: address.phone,
    })

    const order = await place({
      // The draft's own lines, resolved a moment ago and resolved again inside
      // checkout's transaction — so a line that sold out while the quote was
      // on screen fails the placement rather than overselling.
      basket: quote.basket,
      email: draft.email,
      paymentMethod: draft.paymentMethod,
      phone: draft.phone,
      shippingAddress: toSnapshot(shipping),
      ...(billing ? { billingAddress: toSnapshot(billing) } : {}),
      shippingMethodId: draft.shippingMethodId,
      discountCode: draft.draftDiscountCode,
      customerNote: draft.customerNote,
      customerId: draft.customerId,
    })

    // Kept, not deleted: the draft records what was quoted and by whom, and an
    // order with no account of where it came from is worse than a spare row.
    await execute(
      `UPDATE orders SET placed_order_id = $2, placed_from_draft_at = now() WHERE id = $1`,
      [id, order.id],
      { name: 'drafts.markPlaced' },
    )

    await auditService.record({
      actor,
      action: 'order.draft_placed',
      resourceType: 'order',
      resourceId: id,
      after: { orderId: order.id, orderNumber: order.orderNumber },
    })

    log.info({ draftId: id, orderId: order.id }, 'draft placed')
    return order
  },

  /** Discards a draft. Nothing was reserved, so nothing has to be released. */
  async discard(id: string, actor: Actor): Promise<void> {
    const draft = await this.get(id)
    if (draft.placedOrderId) {
      throw new DomainRuleError(
        ERROR_CODES.DOMAIN_RULE_VIOLATION,
        'That draft has already been placed.',
      )
    }

    await execute(`DELETE FROM orders WHERE id = $1 AND status = 'draft'`, [id], {
      name: 'drafts.discard',
    })
    await auditService.record({
      actor,
      action: 'order.draft_discarded',
      resourceType: 'order',
      resourceId: id,
      before: { email: draft.email },
    })
  },

  /** How many drafts are open, for the badge on the queue. */
  async openCount(): Promise<number> {
    const row = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM orders
        WHERE status = 'draft' AND placed_order_id IS NULL`,
      [],
      { name: 'drafts.openCount' },
    )
    return row?.count ?? 0
  },

  /** Products a staff member can put on a draft, searched by name or SKU. */
  async searchVariants(term: string, limit = 20) {
    return query<{
      variant_id: string
      product_id: string
      product_title: string
      variant_title: string
      sku: string | null
      price_amount: number
    }>(
      `SELECT v.id AS variant_id, p.id AS product_id, p.title AS product_title,
              v.title AS variant_title, v.sku, v.price_amount
         FROM product_variants v
         JOIN products p ON p.id = v.product_id
        WHERE v.is_active AND v.archived_at IS NULL AND p.archived_at IS NULL
          AND (p.title ILIKE $1 OR v.sku ILIKE $1)
        ORDER BY p.title, v.position
        LIMIT $2`,
      [`%${term}%`, limit],
      { name: 'drafts.searchVariants' },
    )
  },
}
