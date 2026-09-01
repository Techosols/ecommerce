/**
 * Inventory locations (docs/inventory.md §2).
 *
 * A table rather than an assumption. There is one row today, and no code
 * anywhere says "main kitchen" — a second branch is an INSERT, and the routing
 * decisions that come with it (which location fulfils an order) are deferred
 * rather than pre-empted.
 */
import { v7 as uuidv7 } from 'uuid'
import { publish } from '../../events/index.js'
import { withTransaction } from '../../infrastructure/database/transaction.js'
import { createLogger } from '../../infrastructure/logging/logger.js'
import { TtlCache } from '../../infrastructure/cache/memory.js'
import type { Actor } from '../../shared/auth/actor.js'
import {
  ConflictError,
  DomainRuleError,
  ERROR_CODES,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/index.js'
import { auditService, diffChanged } from '../audit/index.js'
import { inventoryRepository as repo } from './inventory.repository.js'
import type { InventoryLocation } from './inventory.types.js'

const log = createLogger('inventory.locations')

/** Read on every stock write and changed a handful of times a year. */
const cache = new TtlCache<InventoryLocation[]>({ ttlMs: 300_000, maxEntries: 2 })
const ALL_KEY = 'all'

function assertCode(code: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(code) || code.length > 40) {
    throw new ValidationError(
      'A location code must be lowercase letters, digits and single hyphens, e.g. "lahore-branch"',
    )
  }
}

export const locationsService = {
  async list(options: { activeOnly?: boolean } = {}): Promise<InventoryLocation[]> {
    if (options.activeOnly) {
      const all = await cache.getOrLoad(ALL_KEY, () => repo.listLocations())
      return all.filter((location) => location.isActive)
    }
    return cache.getOrLoad(ALL_KEY, () => repo.listLocations())
  },

  async getById(id: string): Promise<InventoryLocation | undefined> {
    return repo.findLocationById(id)
  },

  async getByCode(code: string): Promise<InventoryLocation | undefined> {
    return repo.findLocationByCode(code)
  },

  async getDefault(): Promise<InventoryLocation> {
    return repo.defaultLocation()
  },

  async create(
    input: {
      code: string
      name: string
      address?: Record<string, unknown>
      position?: number
      isDefault?: boolean
    },
    actor: Actor,
  ): Promise<InventoryLocation> {
    assertCode(input.code)

    const location = await withTransaction(async () => {
      // Exactly one default, enforced by a partial unique index. Clearing the
      // old one first turns a constraint violation into an intentional handover.
      if (input.isDefault) await repo.clearDefaultLocation()

      const created = await repo.createLocation({
        id: uuidv7(),
        code: input.code,
        name: input.name.trim(),
        address: input.address ?? {},
        position: input.position ?? 0,
        isDefault: input.isDefault ?? false,
      })

      await auditService.record({
        actor,
        action: 'inventory.location_created',
        resourceType: 'inventory_location',
        resourceId: created.id,
        after: { code: created.code, name: created.name, isDefault: created.isDefault },
      })
      await publish(
        'inventory.location_created',
        { locationId: created.id, code: created.code, actorId: actor.userId },
        { aggregateId: created.id, actorUserId: actor.userId },
      )
      return created
    })

    cache.clear()
    log.info({ locationId: location.id, code: location.code }, 'location created')
    return location
  },

  async update(
    id: string,
    patch: {
      code?: string
      name?: string
      address?: Record<string, unknown>
      isActive?: boolean
      isDefault?: boolean
      position?: number
    },
    actor: Actor,
  ): Promise<InventoryLocation> {
    const before = await repo.findLocationById(id)
    if (!before) throw new NotFoundError('Location not found')
    if (patch.code) assertCode(patch.code)

    // The default location is where stock lands when nobody names one, so it
    // must always exist. Demoting it is done by promoting another.
    if (patch.isDefault === false && before.isDefault) {
      throw new DomainRuleError(
        ERROR_CODES.DOMAIN_RULE_VIOLATION,
        'Make another location the default instead of unsetting this one',
      )
    }
    if (patch.isActive === false && before.isDefault) {
      throw new DomainRuleError(
        ERROR_CODES.LAST_LOCATION_PROTECTED,
        'The default location cannot be deactivated — promote another one first',
      )
    }

    const updated = await withTransaction(async () => {
      if (patch.isDefault === true && !before.isDefault) await repo.clearDefaultLocation()

      const next = await repo.updateLocation(id, patch)
      const changed = diffChanged(before as unknown as Record<string, unknown>, patch)
      if (changed) {
        await auditService.record({
          actor,
          action: 'inventory.location_updated',
          resourceType: 'inventory_location',
          resourceId: id,
          before: changed.before,
          after: changed.after,
        })
      }
      return next
    })

    cache.clear()
    if (!updated) throw new NotFoundError('Location not found')
    return updated
  },

  /**
   * Archives a location.
   *
   * Refuses while stock is still held there: archiving would make that stock
   * invisible without anyone deciding what happened to it. Move it out — a
   * transfer — and the count reaches zero honestly.
   */
  async archive(id: string, actor: Actor): Promise<void> {
    const location = await repo.findLocationById(id)
    if (!location) throw new NotFoundError('Location not found')
    if (location.isDefault) {
      throw new DomainRuleError(
        ERROR_CODES.LAST_LOCATION_PROTECTED,
        'The default location cannot be archived — promote another one first',
      )
    }

    const onHand = await repo.countStockAtLocation(id)
    if (onHand > 0) {
      throw new ConflictError(
        `${onHand} unit(s) are still held at this location — transfer them out first`,
        { code: ERROR_CODES.LOCATION_IN_USE },
      )
    }

    await withTransaction(async () => {
      await repo.updateLocation(id, { isActive: false })
      await repo.archiveLocation(id)
      await auditService.record({
        actor,
        action: 'inventory.location_archived',
        resourceType: 'inventory_location',
        resourceId: id,
        before: { code: location.code, name: location.name },
      })
    })

    cache.clear()
    log.info({ locationId: id, actorId: actor.userId }, 'location archived')
  },

  clearCache(): void {
    cache.clear()
  },
}
