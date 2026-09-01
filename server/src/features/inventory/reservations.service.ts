/**
 * Reservations (docs/inventory.md §5).
 *
 * The lifecycle the checkout will stand on:
 *
 * ```
 *   available ──reserve──▶ reserved ──commit──▶ gone (goods left)
 *                              │
 *                              └───release/expire──▶ available again
 * ```
 *
 * A reservation is resolved **exactly once**. That is not a convention here, it
 * is a compare-and-swap: `UPDATE … WHERE status = 'active'` returns zero rows
 * for the second caller, so a double-release cannot free stock twice and a
 * double-commit cannot consume it twice. Every quantity move is likewise a
 * single conditional statement, so two concurrent reservations against ten
 * units cannot both succeed for seven.
 *
 * What is deliberately *not* here: carts, checkout, orders. This is the seam
 * they will call, and the shape of `ownerType`/`ownerId` is what lets them do
 * so without a schema change.
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
import { settingsService } from '../settings/index.js'
import { inventoryRepository as repo } from './inventory.repository.js'
import { defaultThreshold, inventoryService, publishStockTransitions } from './inventory.service.js'
import type { Reservation, ReserveInput } from './inventory.types.js'

const log = createLogger('inventory.reservations')

export const reservationsService = {
  /**
   * Claims stock.
   *
   * The reservation row and the `reserved` increment happen in one transaction:
   * a reservation that exists without the stock behind it would let the same
   * units be sold twice, and stock held by no reservation would never be
   * released.
   *
   * An untracked item still gets a reservation row — the checkout should not
   * have to care which items are tracked — but takes no stock, because there is
   * no stock to take.
   */
  async reserve(input: ReserveInput, actor: Actor | null = null): Promise<Reservation> {
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw new ValidationError('A reservation must be for a whole, positive quantity')
    }

    const { item, locationId } = await inventoryService.resolveTarget(input)
    const ttlMinutes =
      input.expiresInMinutes ?? (await settingsService.get()).reservationTtlMinutes
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000)

    return withTransaction(async () => {
      const reservation = await repo.createReservation({
        id: uuidv7(),
        inventoryItemId: item.id,
        locationId,
        quantity: input.quantity,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        expiresAt,
      })

      if (item.trackInventory) {
        const level = await repo.ensureLevel(uuidv7(), item.id, locationId)
        const before = level.available
        const updated = await repo.applyReservedDelta(level.id, input.quantity)

        // The single statement above is the whole overselling defence: zero
        // rows means a concurrent writer got there first and there is no longer
        // enough available. There was never a window to lose.
        if (!updated) {
          throw new DomainRuleError(
            ERROR_CODES.INSUFFICIENT_STOCK,
            `Only ${level.available} available; ${input.quantity} requested`,
          )
        }

        await repo.recordMovement({
          inventoryItemId: item.id,
          locationId,
          deltaOnHand: 0,
          deltaReserved: input.quantity,
          reason: 'reservation',
          referenceType: 'reservation',
          referenceId: reservation.id,
          resultingOnHand: updated.onHand,
          resultingReserved: updated.reserved,
          actorUserId: actor?.userId ?? null,
          note: null,
        })

        // Reserving the last unit is "out of stock" to a customer, so the same
        // transitions fire here as for an adjustment.
        await publishStockTransitions({
          inventoryItemId: item.id,
          variantId: item.variantId,
          locationId,
          before,
          after: updated.available,
          threshold: item.lowStockThreshold ?? (await defaultThreshold()),
          trackInventory: true,
        })
      }

      await publish(
        'inventory.reserved',
        {
          reservationId: reservation.id,
          inventoryItemId: item.id,
          variantId: item.variantId,
          locationId,
          quantity: input.quantity,
          ownerType: input.ownerType,
          ownerId: input.ownerId,
        },
        { aggregateId: item.id, actorUserId: actor?.userId ?? undefined },
      )

      log.info(
        { reservationId: reservation.id, inventoryItemId: item.id, quantity: input.quantity },
        'stock reserved',
      )
      return reservation
    })
  },

  /** Gives the stock back. The reverse of `reserve`, and equally single-shot. */
  async release(reservationId: string, actor: Actor | null = null): Promise<Reservation> {
    return this.resolve(reservationId, 'released', actor)
  },

  /**
   * Consumes the stock: the goods have left.
   *
   * `on_hand` and `reserved` fall together in one statement, so `available`
   * does not twitch upward in between and let someone else take the same units.
   */
  async commit(reservationId: string, actor: Actor | null = null): Promise<Reservation> {
    return this.resolve(reservationId, 'committed', actor)
  },

  /**
   * The single place a reservation stops being active.
   *
   * Written once for all three outcomes because the ordering matters and
   * writing it three times is how one of them ends up subtly different: claim
   * the row first with a compare-and-swap, and only then move stock. A caller
   * that loses the claim moves nothing.
   */
  async resolve(
    reservationId: string,
    outcome: 'released' | 'committed' | 'expired',
    actor: Actor | null = null,
  ): Promise<Reservation> {
    const existing = await repo.findReservationById(reservationId)
    if (!existing) throw new NotFoundError('Reservation not found')

    return withTransaction(async () => {
      // Compare-and-swap. The second caller of a double-release gets zero rows
      // here and never reaches the stock movement below.
      const resolved = await repo.resolveReservation(reservationId, outcome, actor?.userId ?? null)
      if (!resolved) {
        const current = await repo.findReservationById(reservationId)
        throw new ConflictError(
          `That reservation is already ${current?.status ?? 'resolved'}`,
          { code: ERROR_CODES.RESERVATION_ALREADY_RESOLVED },
        )
      }

      const item = await repo.findItemById(resolved.inventoryItemId)
      if (item?.trackInventory) {
        const level = await repo.findLevel(resolved.inventoryItemId, resolved.locationId)
        if (!level) throw new NotFoundError('Inventory level not found')

        const before = level.available
        const updated =
          outcome === 'committed'
            ? await repo.applyCommit(level.id, resolved.quantity)
            : await repo.applyReservedDelta(level.id, -resolved.quantity)

        if (!updated) {
          // Unreachable unless the ledger and the levels have diverged, which
          // the constraints are there to prevent. Fail loudly rather than
          // leaving a reservation resolved against stock that did not move.
          throw new ConflictError('The stock level does not match this reservation', {
            code: ERROR_CODES.CONCURRENT_MODIFICATION,
          })
        }

        await repo.recordMovement({
          inventoryItemId: resolved.inventoryItemId,
          locationId: resolved.locationId,
          deltaOnHand: outcome === 'committed' ? -resolved.quantity : 0,
          deltaReserved: -resolved.quantity,
          reason:
            outcome === 'committed'
              ? 'reservation_commit'
              : outcome === 'expired'
                ? 'reservation_expired'
                : 'reservation_release',
          referenceType: 'reservation',
          referenceId: resolved.id,
          resultingOnHand: updated.onHand,
          resultingReserved: updated.reserved,
          actorUserId: actor?.userId ?? null,
          note: null,
        })

        // A release puts stock back and can cross the threshold upward; a
        // commit takes it for good and can cross downward.
        await publishStockTransitions({
          inventoryItemId: resolved.inventoryItemId,
          variantId: item.variantId,
          locationId: resolved.locationId,
          before,
          after: updated.available,
          threshold: item.lowStockThreshold ?? (await defaultThreshold()),
          trackInventory: true,
        })
      }

      await publish(
        outcome === 'committed'
          ? 'inventory.committed'
          : outcome === 'expired'
            ? 'inventory.reservation_expired'
            : 'inventory.released',
        {
          reservationId: resolved.id,
          inventoryItemId: resolved.inventoryItemId,
          variantId: item?.variantId ?? resolved.inventoryItemId,
          locationId: resolved.locationId,
          quantity: resolved.quantity,
          ownerType: resolved.ownerType,
          ownerId: resolved.ownerId,
        },
        { aggregateId: resolved.inventoryItemId, actorUserId: actor?.userId ?? undefined },
      )

      log.info({ reservationId, outcome, quantity: resolved.quantity }, 'reservation resolved')
      return resolved
    })
  },

  async getById(reservationId: string): Promise<Reservation> {
    const reservation = await repo.findReservationById(reservationId)
    if (!reservation) throw new NotFoundError('Reservation not found')
    return reservation
  },

  async listFor(ownerType: Reservation['ownerType'], ownerId: string): Promise<Reservation[]> {
    return repo.listReservationsFor(ownerType, ownerId)
  },

  /**
   * Expires reservations whose time has run out, so an abandoned checkout does
   * not hold stock forever. Bounded per run, and each one resolved
   * independently: a single bad row must not stop the sweep.
   */
  async expireDue(limit: number): Promise<number> {
    const due = await repo.claimExpiredReservations(limit)
    let expired = 0

    for (const reservation of due) {
      try {
        await this.resolve(reservation.id, 'expired', null)
        expired += 1
      } catch (error) {
        // Almost certainly a concurrent release or commit — the reservation is
        // resolved either way, which is the outcome the sweep wanted.
        log.warn({ err: error, reservationId: reservation.id }, 'could not expire reservation')
      }
    }
    return expired
  },
}
