/**
 * Carts (§5.11, CLAUDE.md §2 `client/`).
 *
 * The rule that shapes everything here: **a cart stores references and
 * quantities, never prices.** Every read re-resolves price and availability
 * from the catalogue and inventory, so a basket left open overnight shows this
 * morning's price and this morning's stock, and a client has nothing to lie
 * about.
 *
 * A cart also does **not** reserve stock. Reservation happens at checkout, for
 * a bounded window — holding stock for everyone who ever added an item would
 * empty the shop by lunchtime (docs/inventory.md §5).
 */
import { createHash, randomBytes } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import { publish } from '../../events/index.js'
import { withTransaction } from '../../infrastructure/database/transaction.js'
import { createLogger } from '../../infrastructure/logging/logger.js'
import { getStorage } from '../../infrastructure/storage/index.js'
import {
  ConflictError,
  DomainRuleError,
  ERROR_CODES,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/index.js'
import { env } from '../../config/env.js'
import { emailService } from '../../infrastructure/email/index.js'
import { productsService } from '../catalogue/index.js'
import { availabilityService } from '../inventory/index.js'
import { mediaService } from '../media/index.js'
import { settingsService, taxAddedTo, taxOn } from '../settings/index.js'
import type { Actor } from '../../shared/auth/actor.js'
import { cartsRepository as repo } from './carts.repository.js'
import type { Cart, CartTotals, ResolvedCart, ResolvedCartLine } from './carts.types.js'

const log = createLogger('carts')

/** How long an untouched cart survives. Refreshed on every change. */
const CART_TTL_DAYS = 30
const MAX_LINES = 100

/** Guest cart tokens are hashed exactly like session tokens (§6.2). */
function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest()
}

export interface CartHandle {
  cart: Cart
  /** Present only when a guest cart has just been created. */
  anonymousToken?: string
}

export const cartsService = {
  // ── Identity ──────────────────────────────────────────────────────────────

  /**
   * Finds the caller's cart, creating one if they have none.
   *
   * A signed-in customer has at most one active cart, enforced by a partial
   * unique index — so two tabs cannot diverge into two baskets.
   */
  async resolveOrCreate(input: {
    customerId?: string | null
    anonymousToken?: string | null
  }): Promise<CartHandle> {
    const { currency } = await settingsService.get()

    if (input.customerId) {
      const existing = await repo.findActiveForCustomer(input.customerId)
      if (existing) return { cart: existing }

      const cart = await repo.create({
        id: uuidv7(),
        customerId: input.customerId,
        anonymousTokenHash: null,
        currency,
        expiresAt: this.newExpiry(),
      })
      await publish('cart.created', { cartId: cart.id, customerId: input.customerId }, {
        aggregateId: cart.id,
        actorUserId: input.customerId,
      })
      return { cart }
    }

    if (input.anonymousToken) {
      const existing = await repo.findByAnonymousHash(hashToken(input.anonymousToken))
      if (existing && existing.status === 'active') return { cart: existing }
    }

    // A fresh guest token. Returned once; only its hash is stored, so a leaked
    // database yields no working cart identifiers.
    const anonymousToken = randomBytes(32).toString('base64url')
    const cart = await repo.create({
      id: uuidv7(),
      customerId: null,
      anonymousTokenHash: hashToken(anonymousToken),
      currency,
      expiresAt: this.newExpiry(),
    })
    await publish('cart.created', { cartId: cart.id, customerId: null }, { aggregateId: cart.id })
    return { cart, anonymousToken }
  },

  /**
   * Finds the caller's active cart without creating one.
   *
   * Checkout uses this rather than `resolveOrCreate`: a checkout with no cart
   * is a request that cannot be satisfied, and quietly minting an empty basket
   * to fail against a moment later only obscures that.
   */
  async find(input: {
    customerId?: string | null
    anonymousToken?: string | null
  }): Promise<Cart | undefined> {
    if (input.customerId) {
      const existing = await repo.findActiveForCustomer(input.customerId)
      if (existing) return existing
    }
    if (input.anonymousToken) {
      const guest = await repo.findByAnonymousHash(hashToken(input.anonymousToken))
      if (guest && guest.status === 'active') return guest
    }
    return undefined
  },

  newExpiry(): Date {
    return new Date(Date.now() + CART_TTL_DAYS * 24 * 60 * 60 * 1000)
  },

  /**
   * Merges a guest cart into the customer's on sign-in.
   *
   * Quantities are added rather than replaced: someone who put two burgers in
   * before logging in and had one saved from last week expects three.
   */
  async claimForCustomer(anonymousToken: string, customerId: string): Promise<Cart> {
    const guest = await repo.findByAnonymousHash(hashToken(anonymousToken))
    if (!guest || guest.status !== 'active') {
      const handle = await this.resolveOrCreate({ customerId })
      return handle.cart
    }

    return withTransaction(async () => {
      const existing = await repo.findActiveForCustomer(customerId)
      if (!existing) {
        await repo.assignToCustomer(guest.id, customerId)
        const claimed = await repo.findById(guest.id)
        if (!claimed) throw new NotFoundError('Cart not found')
        return claimed
      }

      await repo.mergeItemsInto(guest.id, existing.id)
      await repo.setStatus(guest.id, 'abandoned')
      log.info({ from: guest.id, into: existing.id, customerId }, 'guest cart merged on sign-in')
      return existing
    })
  },

  async getById(cartId: string): Promise<Cart> {
    const cart = await repo.findById(cartId)
    if (!cart) throw new NotFoundError('Cart not found')
    return cart
  },

  /**
   * Confirms the caller owns this cart.
   *
   * Ownership is proved by the customer id or by holding the guest token —
   * never by knowing the cart id, which appears in URLs and logs.
   */
  async assertOwner(cart: Cart, input: { customerId?: string | null; anonymousToken?: string | null }): Promise<void> {
    if (cart.customerId) {
      if (cart.customerId !== input.customerId) throw new NotFoundError('Cart not found')
      return
    }
    if (!input.anonymousToken) throw new NotFoundError('Cart not found')
    const byToken = await repo.findByAnonymousHash(hashToken(input.anonymousToken))
    if (!byToken || byToken.id !== cart.id) throw new NotFoundError('Cart not found')
  },

  // ── Lines ─────────────────────────────────────────────────────────────────

  async addItem(cartId: string, variantId: string, quantity: number): Promise<ResolvedCart> {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
      throw new ValidationError('Quantity must be a whole number between 1 and 999')
    }

    await withTransaction(async () => {
      const cart = await repo.lock(cartId)
      if (!cart) throw new NotFoundError('Cart not found')
      if (cart.status !== 'active') {
        throw new ConflictError('This cart has already been checked out', {
          code: ERROR_CODES.DOMAIN_RULE_VIOLATION,
        })
      }

      // Refuse the variant outright if the catalogue will not sell it. A cart
      // that accepts unbuyable lines only fails later, at checkout, when the
      // customer has already entered an address.
      const [view] = await productsService.purchaseView([variantId])
      if (!view || !view.sellable) {
        throw new DomainRuleError(
          ERROR_CODES.REFERENCED_RESOURCE_MISSING,
          'That item is not available',
        )
      }

      const lines = await repo.items(cartId)
      if (lines.length >= MAX_LINES && !lines.some((line) => line.variantId === variantId)) {
        throw new ConflictError(`A cart holds at most ${MAX_LINES} different items`, {
          code: ERROR_CODES.DOMAIN_RULE_VIOLATION,
        })
      }

      await repo.upsertItem({ id: uuidv7(), cartId, variantId, quantity })
      await repo.touch(cartId, this.newExpiry())
      await publish('cart.item_added', { cartId, variantId, quantity }, { aggregateId: cartId })
    })

    return this.resolve(cartId)
  },

  /** Setting a line to zero removes it, which is what a quantity stepper means. */
  async setItemQuantity(cartId: string, variantId: string, quantity: number): Promise<ResolvedCart> {
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 999) {
      throw new ValidationError('Quantity must be a whole number between 0 and 999')
    }

    await withTransaction(async () => {
      const cart = await repo.lock(cartId)
      if (!cart || cart.status !== 'active') throw new NotFoundError('Cart not found')

      if (quantity === 0) {
        await repo.removeItem(cartId, variantId)
        await publish('cart.item_removed', { cartId, variantId }, { aggregateId: cartId })
      } else {
        const updated = await repo.setItemQuantity(cartId, variantId, quantity)
        if (!updated) throw new NotFoundError('That item is not in this cart')
      }
      await repo.touch(cartId, this.newExpiry())
    })

    return this.resolve(cartId)
  },

  async removeItem(cartId: string, variantId: string): Promise<ResolvedCart> {
    return this.setItemQuantity(cartId, variantId, 0)
  },

  async clear(cartId: string): Promise<ResolvedCart> {
    await repo.clearItems(cartId)
    return this.resolve(cartId)
  },

  // ── Resolution and totals ─────────────────────────────────────────────────

  /**
   * The cart as it stands right now: live prices, live availability.
   *
   * Nothing here is read from the cart itself except variant ids and
   * quantities. That is what makes a stale basket impossible rather than
   * merely unlikely.
   */
  async resolve(cartId: string): Promise<ResolvedCart> {
    const cart = await this.getById(cartId)
    const items = await repo.items(cartId)
    const { lines, totals, purchasable } = await this.resolveLines(items, cart.currency)
    return { cart, lines, totals, purchasable }
  },

  /**
   * Resolves a set of variant references against the live catalogue.
   *
   * Split out of `resolve` so that anything holding lines can be priced the
   * same way — in particular a draft order, whose lines a staff member typed
   * rather than a shopper adding them. There is one implementation of "what
   * does this basket cost and can it be bought", and both callers use it.
   */
  async resolveLines(
    items: { id: string; variantId: string; quantity: number }[],
    currency: string,
  ): Promise<{ lines: ResolvedCartLine[]; totals: CartTotals; purchasable: boolean }> {
    if (items.length === 0) {
      return { lines: [], totals: await this.emptyTotals(currency), purchasable: false }
    }

    const variantIds = items.map((item) => item.variantId)
    const [views, availability] = await Promise.all([
      productsService.purchaseView(variantIds),
      availabilityService.forVariants(variantIds),
    ])
    const byVariant = new Map(views.map((view) => [view.variantId, view]))

    const lines: ResolvedCartLine[] = []
    for (const item of items) {
      const view = byVariant.get(item.variantId)
      const stock = availability.get(item.variantId)

      // A variant that vanished from the catalogue keeps its line, marked, so
      // the customer is told rather than silently short-changed.
      if (!view) {
        lines.push(
          this.unavailableLine(item.variantId, item.quantity, currency, 'This item is no longer sold'),
        )
        continue
      }

      const enoughStock = stock ? stock.trackInventory === false || stock.available >= item.quantity : true
      const problem = !view.sellable
        ? 'This item is no longer available'
        : !enoughStock
          ? stock && stock.available > 0
            ? `Only ${stock.available} left`
            : 'Out of stock'
          : null

      const unit = view.priceAmount
      lines.push({
        id: item.id,
        variantId: item.variantId,
        productId: view.productId,
        handle: view.handle,
        productTitle: view.productTitle,
        variantTitle: view.variantTitle,
        sku: view.sku,
        options: view.options,
        imageUrl: await this.imageUrl(view.mediaId),
        quantity: item.quantity,
        unitPrice: { amount: unit, currency: view.currency },
        lineTotal: { amount: unit * item.quantity, currency: view.currency },
        requiresShipping: view.requiresShipping,
        weightGrams: view.weightGrams,
        purchasable: problem === null,
        availability: stock?.state ?? 'made_to_order',
        problem,
      })
    }

    return {
      lines,
      totals: await this.totalsFor(lines, currency),
      // Checkout refuses unless every line can be bought. Partial checkout is a
      // decision for the customer to make explicitly, not for the server to
      // make quietly on their behalf.
      purchasable: lines.length > 0 && lines.every((line) => line.purchasable),
    }
  },

  unavailableLine(
    variantId: string,
    quantity: number,
    currency: string,
    problem: string,
  ): ResolvedCartLine {
    return {
      id: variantId,
      variantId,
      productId: '',
      handle: '',
      productTitle: 'Unavailable item',
      variantTitle: '',
      sku: null,
      options: [],
      imageUrl: null,
      quantity,
      unitPrice: { amount: 0, currency },
      lineTotal: { amount: 0, currency },
      requiresShipping: false,
      weightGrams: 0,
      purchasable: false,
      availability: 'out_of_stock',
      problem,
    }
  },

  async imageUrl(mediaId: string | null): Promise<string | null> {
    if (!mediaId) return null
    const asset = await mediaService.getById(mediaId)
    if (!asset || asset.status !== 'ready') return null
    return getStorage().getUrl(asset.storageKey)
  },

  /**
   * Money. Integer minor units throughout, and tax computed once from the
   * store's basis-point rate.
   *
   * Only purchasable lines count: a cart containing something out of stock must
   * not quote a total the customer cannot actually pay.
   */
  async totalsFor(lines: ResolvedCartLine[], currency: string): Promise<CartTotals> {
    const settings = await settingsService.get()
    const billable = lines.filter((line) => line.purchasable)

    const subtotal = billable.reduce((sum, line) => sum + line.lineTotal.amount, 0)
    const itemCount = billable.reduce((sum, line) => sum + line.quantity, 0)

    // Tax-inclusive pricing means the tax is already inside the subtotal and is
    // shown for information; exclusive means it is added. Getting this backwards
    // is a common and expensive mistake, so the two readings have names.
    const tax = taxOn(subtotal, settings)
    const total = subtotal + taxAddedTo(subtotal, settings)

    return {
      subtotal: { amount: subtotal, currency },
      discountTotal: { amount: 0, currency },
      taxTotal: { amount: tax, currency },
      // Shipping is quoted at checkout, once an address is known.
      shippingTotal: { amount: 0, currency },
      total: { amount: total, currency },
      itemCount,
    }
  },

  async emptyTotals(currency: string): Promise<CartTotals> {
    return this.totalsFor([], currency)
  },

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async markConverted(cartId: string, orderId: string): Promise<void> {
    await repo.setStatus(cartId, 'converted', orderId)
    await publish('cart.converted', { cartId, orderId }, { aggregateId: cartId })
  },

  /**
   * Sweeps carts nobody has touched. Bounded per run.
   *
   * The whole pass runs in one transaction, and that is load-bearing rather
   * than tidiness: `claimExpired` selects `FOR UPDATE SKIP LOCKED`, and those
   * row locks live only as long as the transaction that took them. Called
   * without one, each statement commits immediately, the locks are released
   * before anything is done with the rows, and two workers happily claim the
   * same carts — publishing `cart.abandoned` twice for each.
   *
   * `setStatus` is conditional on the cart still being active, so even a lock
   * that somehow escaped would not produce a second event.
   */
  async abandonExpired(limit: number): Promise<number> {
    return withTransaction(async () => {
      const expired = await repo.claimExpired(limit)
      let abandoned = 0

      for (const cart of expired) {
        const moved = await repo.setStatusIfActive(cart.id, 'abandoned')
        if (!moved) continue
        abandoned += 1
        await publish('cart.abandoned', { cartId: cart.id, customerId: cart.customerId }, {
          aggregateId: cart.id,
        })
      }
      return abandoned
    })
  },

  /**
   * Sends the shopper a link back to the basket they left.
   *
   * The same template the automatic sweep uses, and the same consent check: a
   * recovery email is marketing however deliberately a staff member pressed
   * the button, and somebody who has opted out has opted out of this too. What
   * differs is the dedupe key — the automatic one is once per cart for good,
   * and a person choosing to send it again means it.
   *
   * Refuses rather than failing quietly in the three cases where there is
   * nothing to send: no account to send to, an empty basket, and a cart that
   * has already become an order.
   */
  async sendRecovery(
    cartId: string,
    actor: Actor,
    context: {
      /**
       * Whether this customer may be approached. Injected for the same reason
       * checkout's discount and shipping hooks are: carts must not import
       * notifications, and a cart knowing about preference categories is how
       * two features quietly become one.
       */
      allowed?: (customerId: string) => Promise<boolean>
    } = {},
  ): Promise<{ sent: boolean; to: string; reason?: string }> {
    const resolved = await this.resolve(cartId)

    if (resolved.cart.status === 'converted') {
      throw new DomainRuleError(
        ERROR_CODES.DOMAIN_RULE_VIOLATION,
        'That basket became an order, so there is nothing to recover.',
      )
    }
    if (resolved.lines.length === 0) {
      throw new DomainRuleError(
        ERROR_CODES.DOMAIN_RULE_VIOLATION,
        'That basket is empty, so there is nothing to send.',
      )
    }

    const owner = await repo.ownerOf(cartId)
    if (!owner) {
      throw new DomainRuleError(
        ERROR_CODES.DOMAIN_RULE_VIOLATION,
        'That basket belongs to a guest, so there is no address to send to.',
      )
    }

    const allowed = context.allowed ? await context.allowed(owner.id) : true
    if (!allowed) {
      // Not an error: the shop asked a reasonable question and the answer is
      // that this customer has opted out of being approached.
      return { sent: false, to: owner.email, reason: 'The customer has opted out of marketing email.' }
    }

    const settings = await settingsService.get()
    await emailService.enqueue({
      to: owner.email,
      template: 'cart-abandoned',
      props: {
        storeName: settings.storeName,
        ...(owner.name ? { firstName: owner.name.split(' ')[0] as string } : {}),
        items: resolved.lines.map((line) => ({
          title: line.productTitle,
          ...(line.variantTitle ? { variant: line.variantTitle } : {}),
          quantity: line.quantity,
        })),
        cartUrl: `${env.CLIENT_ORIGIN}/cart`,
      },
      // Timestamped, so a staff member can send it again on purpose without
      // the automatic send's once-per-cart key swallowing it.
      dedupeKey: `cart-recovery:${cartId}:${Date.now()}`,
      category: 'marketing',
    })

    log.info({ cartId, actorId: actor.userId }, 'cart recovery email queued')
    return { sent: true, to: owner.email }
  },

}
