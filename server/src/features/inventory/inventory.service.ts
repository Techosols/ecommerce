/**
 * Inventory items, levels and adjustments (docs/inventory.md).
 *
 * Two rules govern everything in this file:
 *
 *   **Nothing changes a level without writing a movement.** The level is the
 *   running total; the movement is the evidence. They are written in the same
 *   transaction, so a stock change that committed always has a reason attached
 *   and a rolled-back one leaves neither.
 *
 *   **Every quantity change is one conditional UPDATE.** No read-then-write,
 *   anywhere. See the note at the top of `inventory.repository.ts` for why that
 *   is the difference between correct and usually-correct.
 */
import { v7 as uuidv7 } from 'uuid'
import { publish } from '../../events/index.js'
import { withTransaction } from '../../infrastructure/database/transaction.js'
import { createLogger } from '../../infrastructure/logging/logger.js'
import type { Actor } from '../../shared/auth/actor.js'
import {
  ConflictError,
  DomainRuleError,
  ERROR_CODES,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/index.js'
import { auditService } from '../audit/index.js'
import { settingsService } from '../settings/index.js'
import { inventoryRepository as repo } from './inventory.repository.js'
import type {
  AdjustmentInput,
  InventoryItem,
  InventoryItemDetail,
  InventoryLevel,
  MovementFilter,
  MovementReason,
  StocktakeInput,
} from './inventory.types.js'

const log = createLogger('inventory')

/** Reasons an operator may cite directly. The rest are written by the system. */
const OPERATOR_REASONS: MovementReason[] = [
  'receive',
  'manual_adjustment',
  'stocktake',
  'damage',
  'waste',
  'return',
  'correction',
]

export function isOperatorReason(reason: string): reason is MovementReason {
  return (OPERATOR_REASONS as string[]).includes(reason)
}

export async function defaultThreshold(): Promise<number> {
  return (await settingsService.get()).defaultLowStockThreshold
}

/**
 * Emits stock-state events on **transitions only**.
 *
 * Exported because reservations move availability just as adjustments do: the
 * last unit being *reserved* is as much "out of stock" to a customer as the
 * last unit being written off, and a shop that only announces one of those is
 * announcing the wrong half.
 *
 * The naive version fires `low_stock` on every movement while stock sits below
 * the threshold, which produces thousands of identical events and trains
 * everyone to ignore them. What is interesting is the crossing, so that is what
 * is published: the moment availability falls through the threshold, hits zero,
 * or climbs back.
 *
 * Called inside the caller's transaction, so an event never describes a change
 * that rolled back (§12.1).
 */
export async function publishStockTransitions(input: {
  inventoryItemId: string
  variantId: string
  locationId: string
  before: number
  after: number
  threshold: number
  trackInventory: boolean
}): Promise<void> {
  const { before, after, threshold } = input
  if (!input.trackInventory || before === after) return

  const base = {
    inventoryItemId: input.inventoryItemId,
    variantId: input.variantId,
    locationId: input.locationId,
  }

  if (before > 0 && after <= 0) {
    await publish('inventory.out_of_stock', base, { aggregateId: input.inventoryItemId })
  } else if (before <= 0 && after > 0) {
    await publish('inventory.back_in_stock', { ...base, available: after }, {
      aggregateId: input.inventoryItemId,
    })
  } else if (before > threshold && after <= threshold) {
    // Only the crossing. Staying low is not news.
    await publish('inventory.low_stock', { ...base, available: after, threshold }, {
      aggregateId: input.inventoryItemId,
    })
  }
}

export const inventoryService = {
  // ── Items ─────────────────────────────────────────────────────────────────

  /**
   * Gives a variant an inventory item, if it has none.
   *
   * Called from the catalogue when a variant is created, so "a variant with no
   * inventory item" is not a state anyone has to reason about in practice —
   * even though `availability.ts` defines what it would mean.
   */
  async ensureItemForVariant(variantId: string): Promise<InventoryItem> {
    const existing = await repo.findItemByVariant(variantId)
    if (existing) return existing

    const created = await repo.ensureItem(uuidv7(), variantId)
    if (created) {
      await publish(
        'inventory.item_created',
        { inventoryItemId: created.id, variantId },
        { aggregateId: created.id },
      )
      return created
    }

    // Lost the race; the winner's row is the answer.
    const item = await repo.findItemByVariant(variantId)
    if (!item) throw new Error('Inventory item vanished after a conflicting insert')
    return item
  },

  async getItem(inventoryItemId: string): Promise<InventoryItemDetail> {
    const item = await repo.findItemById(inventoryItemId)
    if (!item) throw new NotFoundError('Inventory item not found')
    return this.withLevels(item)
  },

  async getItemForVariant(variantId: string): Promise<InventoryItemDetail> {
    const item = await repo.findItemByVariant(variantId)
    if (!item) throw new NotFoundError('That variant has no inventory item')
    return this.withLevels(item)
  },

  async withLevels(item: InventoryItem): Promise<InventoryItemDetail> {
    const [levels, identity] = await Promise.all([
      repo.levelsFor(item.id),
      repo.identityFor(item.variantId),
    ])
    return {
      ...item,
      levels,
      // A variant can only be missing if the catalogue row went while this
      // request was in flight; the screen still has to render something.
      identity: identity ?? {
        productId: '',
        productTitle: 'Unknown product',
        variantTitle: '',
        sku: null,
      },
      totalOnHand: levels.reduce((sum, level) => sum + level.onHand, 0),
      totalReserved: levels.reduce((sum, level) => sum + level.reserved, 0),
      totalAvailable: levels.reduce((sum, level) => sum + level.available, 0),
      effectiveLowStockThreshold: item.lowStockThreshold ?? (await defaultThreshold()),
    }
  },

  async listItems(filter: {
    limit: number
    offset: number
    lowOnly?: boolean
    tracked?: boolean
    query?: string
    locationId?: string
  }) {
    return repo.listItems({ ...filter, defaultThreshold: await defaultThreshold() })
  },

  /**
   * What is currently holding an item's stock.
   *
   * `reserved` on a level is a number, and a number is not an answer when an
   * operator is looking at stock they cannot sell: this says which carts and
   * orders are holding it, so they can see whether it will come back on its own.
   */
  async reservationsFor(inventoryItemId: string) {
    await this.getItem(inventoryItemId)
    return repo.activeReservationsForItem(inventoryItemId)
  },

  /**
   * Changes tracking policy. Audited, because switching tracking off makes an
   * item unconditionally purchasable and that is a commercial decision, not a
   * data edit.
   */
  async updateItem(
    inventoryItemId: string,
    patch: { trackInventory?: boolean; lowStockThreshold?: number | null },
    actor: Actor,
  ): Promise<InventoryItemDetail> {
    const before = await repo.findItemById(inventoryItemId)
    if (!before) throw new NotFoundError('Inventory item not found')

    const updated = await withTransaction(async () => {
      const next = await repo.updateItem(inventoryItemId, patch)
      await auditService.record({
        actor,
        action: 'inventory.policy_changed',
        resourceType: 'inventory_item',
        resourceId: inventoryItemId,
        before: {
          trackInventory: before.trackInventory,
          lowStockThreshold: before.lowStockThreshold,
        },
        after: patch,
      })
      if (patch.trackInventory !== undefined && patch.trackInventory !== before.trackInventory) {
        await publish(
          'inventory.tracking_changed',
          {
            inventoryItemId,
            variantId: before.variantId,
            trackInventory: patch.trackInventory,
            actorId: actor.userId,
          },
          { aggregateId: inventoryItemId, actorUserId: actor.userId },
        )
      }
      return next
    })

    if (!updated) throw new NotFoundError('Inventory item not found')
    return this.withLevels(updated)
  },

  // ── Adjustments ───────────────────────────────────────────────────────────

  /**
   * The one way `on_hand` changes.
   *
   * A signed delta with a reason, never "set the number to 47". Setting a
   * number destroys the question an auditor actually asks — *why is it 47?* —
   * and races with any concurrent movement. `stocktake` exists for the case
   * where someone genuinely has counted, and it computes the delta.
   */
  async adjust(input: AdjustmentInput, actor: Actor | null): Promise<InventoryLevel> {
    if (!Number.isInteger(input.delta) || input.delta === 0) {
      throw new ValidationError('An adjustment must move stock by a whole, non-zero amount')
    }

    const { item, locationId } = await this.resolveTarget(input)
    const threshold = item.lowStockThreshold ?? (await defaultThreshold())

    return withTransaction(async () => {
      const level = await repo.ensureLevel(uuidv7(), item.id, locationId)
      const before = level.available

      const updated = await repo.applyOnHandDelta(level.id, input.delta)
      if (!updated) {
        // The predicate failed: either it would go negative, or it would drop
        // below what is already reserved and strand those reservations.
        throw new DomainRuleError(
          ERROR_CODES.INSUFFICIENT_STOCK,
          input.delta < 0
            ? `Cannot remove ${Math.abs(input.delta)}: only ${level.onHand - level.reserved} unreserved of ${level.onHand} on hand`
            : 'That adjustment would leave the stock level in an impossible state',
        )
      }

      await repo.recordMovement({
        inventoryItemId: item.id,
        locationId,
        deltaOnHand: input.delta,
        deltaReserved: 0,
        reason: input.reason,
        referenceType: input.referenceType ?? 'manual',
        referenceId: input.referenceId ?? null,
        resultingOnHand: updated.onHand,
        resultingReserved: updated.reserved,
        actorUserId: actor?.userId ?? null,
        note: input.note ?? null,
      })

      // Who did an administrative thing (audit) is a different question from
      // what happened to stock (the movement ledger). Both are recorded.
      if (actor) {
        await auditService.record({
          actor,
          action: 'inventory.adjusted',
          resourceType: 'inventory_item',
          resourceId: item.id,
          before: { onHand: level.onHand, available: level.available },
          after: { onHand: updated.onHand, available: updated.available, reason: input.reason },
        })
      }

      await publish(
        'inventory.adjusted',
        {
          inventoryItemId: item.id,
          variantId: item.variantId,
          locationId,
          delta: input.delta,
          reason: input.reason,
          available: updated.available,
          actorId: actor?.userId ?? null,
        },
        { aggregateId: item.id, actorUserId: actor?.userId ?? undefined },
      )
      await publishStockTransitions({
        inventoryItemId: item.id,
        variantId: item.variantId,
        locationId,
        before,
        after: updated.available,
        threshold,
        trackInventory: item.trackInventory,
      })

      log.info(
        { inventoryItemId: item.id, locationId, delta: input.delta, reason: input.reason },
        'stock adjusted',
      )
      return updated
    })
  },

  /**
   * Records a physical count.
   *
   * Expressed as a delta rather than an assignment, so it lands in the same
   * ledger as everything else and a concurrent sale during the count does not
   * get silently overwritten.
   */
  async stocktake(input: StocktakeInput, actor: Actor): Promise<InventoryLevel> {
    if (!Number.isInteger(input.countedOnHand) || input.countedOnHand < 0) {
      throw new ValidationError('A counted quantity must be a whole number, and not negative')
    }

    const { item, locationId } = await this.resolveTarget(input)
    const level = await repo.ensureLevel(uuidv7(), item.id, locationId)
    const delta = input.countedOnHand - level.onHand

    if (delta === 0) {
      log.debug({ inventoryItemId: item.id, locationId }, 'stocktake matched the recorded level')
      return level
    }

    return this.adjust(
      {
        inventoryItemId: item.id,
        locationId,
        delta,
        reason: 'stocktake',
        referenceType: 'stocktake',
        note: input.note ?? `Counted ${input.countedOnHand}, system held ${level.onHand}`,
      },
      actor,
    )
  },

  /**
   * Moves stock between locations, atomically.
   *
   * One transaction, two movements, no window in which the goods exist in both
   * places or neither. The multi-step transfer *workflow* — draft, dispatched,
   * in transit, received — is deferred (docs/inventory.md §10); the movement
   * reasons and `reference_type = 'transfer'` are already in place to carry it.
   */
  async transfer(
    input: {
      inventoryItemId?: string
      variantId?: string
      fromLocationId: string
      toLocationId: string
      quantity: number
      note?: string | null
    },
    actor: Actor,
  ): Promise<{ from: InventoryLevel; to: InventoryLevel }> {
    if (input.fromLocationId === input.toLocationId) {
      throw new ValidationError('A transfer needs two different locations')
    }
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw new ValidationError('A transfer must move a whole, positive quantity')
    }

    const { item } = await this.resolveTarget({ ...input, locationId: input.fromLocationId })
    await this.requireLocation(input.toLocationId)
    const transferId = uuidv7()

    return withTransaction(async () => {
      const from = await this.adjust(
        {
          inventoryItemId: item.id,
          locationId: input.fromLocationId,
          delta: -input.quantity,
          reason: 'transfer_out',
          referenceType: 'transfer',
          referenceId: transferId,
          note: input.note ?? null,
        },
        actor,
      )
      const to = await this.adjust(
        {
          inventoryItemId: item.id,
          locationId: input.toLocationId,
          delta: input.quantity,
          reason: 'transfer_in',
          referenceType: 'transfer',
          referenceId: transferId,
          note: input.note ?? null,
        },
        actor,
      )

      await publish(
        'inventory.transferred',
        {
          transferId,
          inventoryItemId: item.id,
          variantId: item.variantId,
          fromLocationId: input.fromLocationId,
          toLocationId: input.toLocationId,
          quantity: input.quantity,
          actorId: actor.userId,
        },
        { aggregateId: item.id, actorUserId: actor.userId },
      )

      return { from, to }
    })
  },

  async history(filter: MovementFilter) {
    return repo.listMovements(filter)
  },

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Turns "a variant or an item, and maybe a location" into the concrete pair
   * every write needs. Accepting a variant id is a convenience for callers that
   * hold one; it never means the quantity lives on the variant.
   */
  async resolveTarget(input: {
    inventoryItemId?: string
    variantId?: string
    locationId?: string
  }): Promise<{ item: InventoryItem; locationId: string }> {
    const item = input.inventoryItemId
      ? await repo.findItemById(input.inventoryItemId)
      : input.variantId
        ? await repo.findItemByVariant(input.variantId)
        : undefined

    if (!item) throw new NotFoundError('Inventory item not found')
    if (item.archivedAt) {
      throw new ConflictError('That inventory item has been archived', {
        code: ERROR_CODES.DOMAIN_RULE_VIOLATION,
      })
    }

    const locationId = input.locationId ?? (await repo.defaultLocation()).id
    await this.requireLocation(locationId)
    return { item, locationId }
  },

  async requireLocation(locationId: string): Promise<void> {
    const location = await repo.findLocationById(locationId)
    if (!location || location.archivedAt) throw new NotFoundError('Location not found')
    if (!location.isActive) {
      throw new DomainRuleError(
        ERROR_CODES.DOMAIN_RULE_VIOLATION,
        `Location "${location.name}" is not active`,
      )
    }
  },
}
