/**
 * Shipping zones, rates and shipments (§5.8, CLAUDE.md §19).
 *
 * **The server quotes the rate.** A client picks a method by id; it never sends
 * a shipping price, exactly as it never sends a product price. The rate is
 * recomputed at checkout from the destination, the weight and the subtotal, so
 * a stale quote in a browser tab cannot become a cheap delivery.
 */
import { v7 as uuidv7 } from 'uuid'
import { publish } from '../../events/index.js'
import { execute, query, queryOne } from '../../infrastructure/database/query.js'
import { withTransaction } from '../../infrastructure/database/transaction.js'
import { createLogger } from '../../infrastructure/logging/logger.js'
import type { Actor } from '../../shared/auth/actor.js'
import {
  DomainRuleError,
  ERROR_CODES,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/index.js'
import { auditService } from '../audit/index.js'

const log = createLogger('shipping')

export type RateType = 'flat' | 'free' | 'weight_based'
export type ShipmentStatus =
  | 'pending' | 'processing' | 'shipped' | 'in_transit' | 'delivered' | 'returned' | 'failed'

export interface ShippingZone {
  id: string
  name: string
  countryCodes: string[]
  position: number
  isActive: boolean
  isArchived: boolean
}

export interface ShippingMethod {
  id: string
  zoneId: string
  name: string
  description: string | null
  rateType: RateType
  priceCents: number
  freeOverSubtotalCents: number | null
  minWeightGrams: number | null
  maxWeightGrams: number | null
  estimatedDaysMin: number | null
  estimatedDaysMax: number | null
  position: number
  isActive: boolean
}

export interface RateQuote {
  methodId: string
  name: string
  description: string | null
  amountCents: number
  estimatedDaysMin: number | null
  estimatedDaysMax: number | null
}

export interface Shipment {
  id: string
  orderId: string
  status: ShipmentStatus
  carrier: string | null
  service: string | null
  trackingNumber: string | null
  trackingUrl: string | null
  shippedAt: Date | null
  deliveredAt: Date | null
  createdAt: Date
  items: { orderItemId: string; quantity: number }[]
}

interface ZoneRow {
  id: string
  name: string
  country_codes: string[]
  position: number
  is_active: boolean
  archived_at: Date | null
}

function toZone(row: ZoneRow): ShippingZone {
  return {
    id: row.id,
    name: row.name,
    // char(2) pads nothing at two characters, but the column type is fixed
    // width and a driver returning ' G' once is a bug nobody would find.
    countryCodes: row.country_codes.map((code) => code.trim().toUpperCase()),
    position: row.position,
    isActive: row.is_active,
    isArchived: row.archived_at !== null,
  }
}

interface MethodRow {
  id: string
  zone_id: string
  name: string
  description: string | null
  rate_type: RateType
  price_cents: number
  free_over_subtotal_cents: number | null
  min_weight_grams: number | null
  max_weight_grams: number | null
  estimated_days_min: number | null
  estimated_days_max: number | null
  position: number
  is_active: boolean
}

function toMethod(row: MethodRow): ShippingMethod {
  return {
    id: row.id,
    zoneId: row.zone_id,
    name: row.name,
    description: row.description,
    rateType: row.rate_type,
    priceCents: row.price_cents,
    freeOverSubtotalCents: row.free_over_subtotal_cents,
    minWeightGrams: row.min_weight_grams,
    maxWeightGrams: row.max_weight_grams,
    estimatedDaysMin: row.estimated_days_min,
    estimatedDaysMax: row.estimated_days_max,
    position: row.position,
    isActive: row.is_active,
  }
}

export const shippingService = {
  // ── Zones and methods ─────────────────────────────────────────────────────

  async listZones(options: { includeArchived?: boolean } = {}): Promise<ShippingZone[]> {
    const rows = await query<ZoneRow>(
      `SELECT * FROM shipping_zones
        ${options.includeArchived ? '' : 'WHERE archived_at IS NULL'}
        ORDER BY archived_at NULLS FIRST, position, name`,
      [],
      { name: 'shipping.listZones' },
    )
    return rows.map(toZone)
  },

  async getZone(id: string): Promise<ShippingZone> {
    const row = await queryOne<ZoneRow>(`SELECT * FROM shipping_zones WHERE id = $1`, [id], {
      name: 'shipping.getZone',
    })
    if (!row) throw new NotFoundError('Shipping zone not found')
    return toZone(row)
  },

  /**
   * Refuses a country already covered by another live zone.
   *
   * Two live zones listing 'GB' do not fail — they quote. The shopper is
   * offered both zones' methods ordered by position and price, so which zone
   * "won" is decided by data nobody set for that purpose, and the store
   * silently charges the wrong rate to one country. There is no correct
   * behaviour for the ambiguity, so it is refused at the point somebody creates
   * it, naming the country and the zone that already claims it.
   *
   * Archived and deactivated zones are ignored: a retired zone is not quoting,
   * and keeping its country list intact is what makes it restorable.
   */
  async assertNoOverlap(codes: string[], exceptZoneId?: string): Promise<void> {
    const clash = await queryOne<{ id: string; name: string; overlap: string[] }>(
      `SELECT id, name, ARRAY(SELECT unnest(country_codes) INTERSECT SELECT unnest($1::char(2)[])) AS overlap
         FROM shipping_zones
        WHERE archived_at IS NULL AND is_active
          AND country_codes && $1::char(2)[]
          AND ($2::uuid IS NULL OR id <> $2::uuid)
        LIMIT 1`,
      [codes, exceptZoneId ?? null],
      { name: 'shipping.assertNoOverlap' },
    )
    if (!clash) return

    const countries = clash.overlap.map((code) => code.trim()).join(', ')
    throw new DomainRuleError(
      ERROR_CODES.DOMAIN_RULE_VIOLATION,
      `${countries} is already covered by the zone "${clash.name}". A country may only be in one live zone, or a shopper there is quoted two rate cards at once.`,
    )
  },

  async createZone(
    input: { name: string; countryCodes: string[]; position?: number },
    actor: Actor,
  ): Promise<ShippingZone> {
    const id = uuidv7()
    const codes = [...new Set(input.countryCodes.map((code) => code.toUpperCase()))]
    await this.assertNoOverlap(codes)

    await execute(
      `INSERT INTO shipping_zones (id, name, country_codes, position) VALUES ($1,$2,$3,$4)`,
      [id, input.name.trim(), codes, input.position ?? 0],
      { name: 'shipping.createZone' },
    )
    await auditService.record({
      actor,
      action: 'shipping.zone_created',
      resourceType: 'shipping_zone',
      resourceId: id,
      after: { name: input.name, countryCodes: codes },
    })
    return {
      id,
      name: input.name.trim(),
      countryCodes: codes,
      position: input.position ?? 0,
      isActive: true,
      isArchived: false,
    }
  },

  async updateZone(
    id: string,
    patch: {
      name?: string
      countryCodes?: string[]
      position?: number
      isActive?: boolean
    },
    actor: Actor,
  ): Promise<ShippingZone> {
    const before = await this.getZone(id)
    if (before.isArchived) {
      throw new DomainRuleError(
        ERROR_CODES.DOMAIN_RULE_VIOLATION,
        'That zone is archived. Restore it before changing it.',
      )
    }

    const codes = patch.countryCodes
      ? [...new Set(patch.countryCodes.map((code) => code.toUpperCase()))]
      : undefined

    // Checked whenever the zone will be live afterwards — turning a zone back
    // on is as much a way to create an overlap as adding a country to it.
    const willBeActive = patch.isActive ?? before.isActive
    if (willBeActive && (codes || patch.isActive === true)) {
      await this.assertNoOverlap(codes ?? before.countryCodes, id)
    }

    const sets: string[] = []
    const params: unknown[] = [id]
    const push = (column: string, value: unknown) => {
      params.push(value)
      sets.push(`${column} = $${params.length}`)
    }
    if (patch.name !== undefined) push('name', patch.name.trim())
    if (codes) push('country_codes', codes)
    if (patch.position !== undefined) push('position', patch.position)
    if (patch.isActive !== undefined) push('is_active', patch.isActive)
    if (sets.length === 0) return before

    const row = await queryOne<ZoneRow>(
      `UPDATE shipping_zones SET ${sets.join(', ')} WHERE id = $1 AND archived_at IS NULL RETURNING *`,
      params,
      { name: 'shipping.updateZone' },
    )
    if (!row) throw new NotFoundError('Shipping zone not found')

    const after = toZone(row)
    await auditService.record({
      actor,
      action: 'shipping.zone_updated',
      resourceType: 'shipping_zone',
      resourceId: id,
      before: { name: before.name, countryCodes: before.countryCodes, isActive: before.isActive },
      after: { name: after.name, countryCodes: after.countryCodes, isActive: after.isActive },
    })
    return after
  },

  /**
   * Retires a zone. Its methods are left alone.
   *
   * Archived rather than deleted because `DELETE` cascades to the methods, and
   * orders cite those methods; the row is what connects an old order to the
   * rate card it was priced against. The quote joins through the zone, so an
   * archived zone stops being offered without any of its methods changing.
   */
  async archiveZone(id: string, actor: Actor): Promise<void> {
    const zone = await this.getZone(id)
    if (zone.isArchived) return

    await execute(`UPDATE shipping_zones SET archived_at = now() WHERE id = $1`, [id], {
      name: 'shipping.archiveZone',
    })
    await auditService.record({
      actor,
      action: 'shipping.zone_archived',
      resourceType: 'shipping_zone',
      resourceId: id,
      before: { name: zone.name, countryCodes: zone.countryCodes },
    })
  },

  /**
   * Brings a zone back. Refused if its countries were claimed while it was away.
   */
  async restoreZone(id: string, actor: Actor): Promise<ShippingZone> {
    const zone = await this.getZone(id)
    if (!zone.isArchived) return zone
    if (zone.isActive) await this.assertNoOverlap(zone.countryCodes, id)

    const row = await queryOne<ZoneRow>(
      `UPDATE shipping_zones SET archived_at = NULL WHERE id = $1 RETURNING *`,
      [id],
      { name: 'shipping.restoreZone' },
    )
    if (!row) throw new NotFoundError('Shipping zone not found')

    await auditService.record({
      actor,
      action: 'shipping.zone_restored',
      resourceType: 'shipping_zone',
      resourceId: id,
      after: { name: zone.name, countryCodes: zone.countryCodes },
    })
    return toZone(row)
  },

  async listMethods(zoneId?: string): Promise<ShippingMethod[]> {
    const rows = await query<MethodRow>(
      `SELECT * FROM shipping_methods
        WHERE archived_at IS NULL ${zoneId ? 'AND zone_id = $1' : ''}
        ORDER BY position, name`,
      zoneId ? [zoneId] : [],
      { name: 'shipping.listMethods' },
    )
    return rows.map(toMethod)
  },

  async getMethod(id: string): Promise<ShippingMethod> {
    const row = await queryOne<MethodRow>(`SELECT * FROM shipping_methods WHERE id = $1`, [id], {
      name: 'shipping.getMethod',
    })
    if (!row) throw new NotFoundError('Shipping method not found')
    return toMethod(row)
  },

  async createMethod(
    input: {
      zoneId: string
      name: string
      description?: string | null
      rateType: RateType
      priceCents?: number
      freeOverSubtotalCents?: number | null
      minWeightGrams?: number | null
      maxWeightGrams?: number | null
      estimatedDaysMin?: number | null
      estimatedDaysMax?: number | null
      position?: number
    },
    actor: Actor,
  ): Promise<ShippingMethod> {
    const id = uuidv7()
    await execute(
      `INSERT INTO shipping_methods
         (id, zone_id, name, description, rate_type, price_cents, free_over_subtotal_cents,
          min_weight_grams, max_weight_grams, estimated_days_min, estimated_days_max, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id, input.zoneId, input.name.trim(), input.description ?? null, input.rateType,
        input.priceCents ?? 0, input.freeOverSubtotalCents ?? null,
        input.minWeightGrams ?? null, input.maxWeightGrams ?? null,
        input.estimatedDaysMin ?? null, input.estimatedDaysMax ?? null, input.position ?? 0,
      ],
      { name: 'shipping.createMethod' },
    )
    await auditService.record({
      actor,
      action: 'shipping.method_created',
      resourceType: 'shipping_method',
      resourceId: id,
      after: { name: input.name, rateType: input.rateType, priceCents: input.priceCents ?? 0 },
    })
    return this.getMethod(id)
  },

  async updateMethod(id: string, patch: Record<string, unknown>, actor: Actor): Promise<ShippingMethod> {
    const columns: Record<string, string> = {
      name: 'name',
      description: 'description',
      rateType: 'rate_type',
      priceCents: 'price_cents',
      freeOverSubtotalCents: 'free_over_subtotal_cents',
      minWeightGrams: 'min_weight_grams',
      maxWeightGrams: 'max_weight_grams',
      estimatedDaysMin: 'estimated_days_min',
      estimatedDaysMax: 'estimated_days_max',
      position: 'position',
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
      await execute(
        `UPDATE shipping_methods SET ${sets.join(', ')} WHERE id = $${params.length}`,
        params,
        { name: 'shipping.updateMethod' },
      )
      await auditService.record({
        actor,
        action: 'shipping.method_updated',
        resourceType: 'shipping_method',
        resourceId: id,
        after: patch,
      })
    }
    return this.getMethod(id)
  },

  async archiveMethod(id: string, actor: Actor): Promise<void> {
    // Reading it first turns a typo'd or already-archived id into a 404 rather
    // than a cheerful 204 for something that never happened — an admin console
    // has to be able to trust the answer.
    await this.getMethod(id)
    await execute(
      `UPDATE shipping_methods SET archived_at = now(), is_active = false WHERE id = $1`,
      [id],
      { name: 'shipping.archiveMethod' },
    )
    await auditService.record({
      actor,
      action: 'shipping.method_archived',
      resourceType: 'shipping_method',
      resourceId: id,
    })
  },

  // ── Rating ────────────────────────────────────────────────────────────────

  /**
   * The methods that will actually deliver to this address, with their prices.
   *
   * Zone is matched on the country code; a destination no zone covers gets an
   * empty list, and checkout refuses rather than shipping somewhere for free.
   */
  async quote(input: {
    countryCode: string
    subtotalCents: number
    weightGrams: number
  }): Promise<RateQuote[]> {
    const rows = await query<MethodRow>(
      `SELECT m.* FROM shipping_methods m
         JOIN shipping_zones z ON z.id = m.zone_id
        WHERE z.is_active AND z.archived_at IS NULL AND m.is_active AND m.archived_at IS NULL
          AND $1 = ANY(z.country_codes)
        ORDER BY m.position, m.price_cents`,
      [input.countryCode.toUpperCase()],
      { name: 'shipping.quote' },
    )

    return rows
      .map(toMethod)
      .filter((method) => this.weightFits(method, input.weightGrams))
      .map((method) => ({
        methodId: method.id,
        name: method.name,
        description: method.description,
        amountCents: this.rateFor(method, input.subtotalCents, input.weightGrams),
        estimatedDaysMin: method.estimatedDaysMin,
        estimatedDaysMax: method.estimatedDaysMax,
      }))
  },

  weightFits(method: ShippingMethod, weightGrams: number): boolean {
    if (method.minWeightGrams !== null && weightGrams < method.minWeightGrams) return false
    if (method.maxWeightGrams !== null && weightGrams > method.maxWeightGrams) return false
    return true
  },

  /**
   * What one method costs for this basket. Integer minor units throughout.
   *
   * Three rate types, and the difference between the last two is what
   * `priceCents` *means*:
   *
   *   `free`          nothing, always
   *   `flat`          `priceCents`, whatever the parcel weighs
   *   `weight_based`  `priceCents` **per kilogram, rounded up** — the usual
   *                   courier model, and the reason the type exists
   *
   * The free-over-subtotal threshold beats all of them: a store that says
   * "free delivery over £50" means it regardless of how the rate is computed.
   *
   * A weight band on a method (`minWeightGrams`/`maxWeightGrams`) is a
   * different thing again — it decides whether the method is *offered* at all,
   * and is applied by `weightFits` before this is ever called.
   */
  rateFor(method: ShippingMethod, subtotalCents: number, weightGrams: number): number {
    if (method.rateType === 'free') return 0
    if (
      method.freeOverSubtotalCents !== null &&
      subtotalCents >= method.freeOverSubtotalCents
    ) {
      return 0
    }
    if (method.rateType === 'weight_based') {
      // Couriers charge by the started kilogram, so 1.2 kg costs two. A basket
      // with no weight recorded still pays for one, rather than shipping free.
      const kilograms = Math.max(1, Math.ceil(weightGrams / 1000))
      return method.priceCents * kilograms
    }
    return method.priceCents
  },

  /**
   * Rates a specific method for checkout, refusing anything that does not
   * actually serve the destination.
   *
   * Checkout calls this rather than trusting the id it was handed: a method id
   * from a stale page might belong to a zone that no longer covers the address.
   */
  async rateForCheckout(input: {
    countryCode: string
    subtotalCents: number
    weightGrams: number
    methodId: string | null
  }): Promise<{ methodId: string | null; name: string | null; amountCents: number }> {
    const options = await this.quote(input)
    if (options.length === 0) {
      throw new DomainRuleError(
        ERROR_CODES.SHIPPING_UNAVAILABLE,
        'We do not currently ship to that address',
      )
    }

    if (!input.methodId) {
      throw new DomainRuleError(ERROR_CODES.NO_SHIPPING_METHOD, 'Choose a delivery option')
    }
    const chosen = options.find((option) => option.methodId === input.methodId)
    if (!chosen) {
      throw new DomainRuleError(
        ERROR_CODES.SHIPPING_UNAVAILABLE,
        'That delivery option is not available for this address',
      )
    }
    return { methodId: chosen.methodId, name: chosen.name, amountCents: chosen.amountCents }
  },

  // ── Shipments ─────────────────────────────────────────────────────────────

  /**
   * Creates a shipment for some or all of an order's items.
   *
   * Partial shipment is normal — three items today, two on Friday — so the
   * quantities are per line and the order's fulfilment status is derived from
   * what has actually gone.
   */
  async createShipment(
    input: {
      orderId: string
      items: { orderItemId: string; quantity: number }[]
      carrier?: string | null
      service?: string | null
      trackingNumber?: string | null
      trackingUrl?: string | null
    },
    actor: Actor,
    hooks: {
      order: { email: string; orderNumber: string }
      incrementFulfilled: (orderItemId: string, quantity: number) => Promise<boolean>
      afterShipment: (orderId: string) => Promise<void>
    },
  ): Promise<Shipment> {
    if (input.items.length === 0) throw new ValidationError('A shipment needs at least one item')

    const shipmentId = uuidv7()
    await withTransaction(async () => {
      await execute(
        `INSERT INTO shipments (id, order_id, carrier, service, tracking_number, tracking_url, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          shipmentId, input.orderId, input.carrier ?? null, input.service ?? null,
          input.trackingNumber ?? null, input.trackingUrl ?? null, actor.userId,
        ],
        { name: 'shipping.createShipment' },
      )

      for (const item of input.items) {
        // The conditional increment refuses to ship more than was ordered, even
        // if two staff create shipments at once.
        const ok = await hooks.incrementFulfilled(item.orderItemId, item.quantity)
        if (!ok) {
          throw new DomainRuleError(
            ERROR_CODES.DOMAIN_RULE_VIOLATION,
            'That would ship more units than were ordered',
          )
        }
        await execute(
          `INSERT INTO shipment_items (shipment_id, order_item_id, quantity) VALUES ($1,$2,$3)`,
          [shipmentId, item.orderItemId, item.quantity],
          { name: 'shipping.addShipmentItem' },
        )
      }

      await auditService.record({
        actor,
        action: 'shipment.created',
        resourceType: 'shipment',
        resourceId: shipmentId,
        after: { orderId: input.orderId, items: input.items.length },
      })
      await publish(
        'shipment.created',
        {
          shipmentId,
          orderId: input.orderId,
          orderNumber: hooks.order.orderNumber,
          email: hooks.order.email,
          itemCount: input.items.length,
        },
        { aggregateId: input.orderId, actorUserId: actor.userId },
      )
    })

    await hooks.afterShipment(input.orderId)
    log.info({ shipmentId, orderId: input.orderId }, 'shipment created')
    return this.getShipment(shipmentId)
  },

  async getShipment(id: string): Promise<Shipment> {
    const row = await queryOne<{
      id: string
      order_id: string
      status: ShipmentStatus
      carrier: string | null
      service: string | null
      tracking_number: string | null
      tracking_url: string | null
      shipped_at: Date | null
      delivered_at: Date | null
      created_at: Date
    }>(`SELECT * FROM shipments WHERE id = $1`, [id], { name: 'shipping.getShipment' })
    if (!row) throw new NotFoundError('Shipment not found')

    const items = await query<{ order_item_id: string; quantity: number }>(
      `SELECT order_item_id, quantity FROM shipment_items WHERE shipment_id = $1`,
      [id],
      { name: 'shipping.shipmentItems' },
    )
    return {
      id: row.id,
      orderId: row.order_id,
      status: row.status,
      carrier: row.carrier,
      service: row.service,
      trackingNumber: row.tracking_number,
      trackingUrl: row.tracking_url,
      shippedAt: row.shipped_at,
      deliveredAt: row.delivered_at,
      createdAt: row.created_at,
      items: items.map((item) => ({ orderItemId: item.order_item_id, quantity: item.quantity })),
    }
  },

  async listForOrder(orderId: string): Promise<Shipment[]> {
    const rows = await query<{ id: string }>(
      `SELECT id FROM shipments WHERE order_id = $1 ORDER BY created_at`,
      [orderId],
      { name: 'shipping.listForOrder' },
    )
    return Promise.all(rows.map((row) => this.getShipment(row.id)))
  },

  /**
   * Moves a shipment along. `shipped` and `delivered` stamp their timestamps,
   * and both are the moments a customer expects an email.
   */
  async setShipmentStatus(
    id: string,
    status: ShipmentStatus,
    actor: Actor,
    hooks: { order: { orderId: string; orderNumber: string; email: string } },
  ): Promise<Shipment> {
    const shipment = await this.getShipment(id)

    const stamps =
      status === 'shipped'
        ? ', shipped_at = coalesce(shipped_at, now())'
        : status === 'delivered'
          ? ', delivered_at = coalesce(delivered_at, now()), shipped_at = coalesce(shipped_at, now())'
          : ''

    await execute(`UPDATE shipments SET status = $2${stamps} WHERE id = $1`, [id, status], {
      name: 'shipping.setShipmentStatus',
    })

    await auditService.record({
      actor,
      action: 'shipment.status_changed',
      resourceType: 'shipment',
      resourceId: id,
      before: { status: shipment.status },
      after: { status },
    })

    if (status === 'shipped') {
      await publish(
        'shipment.shipped',
        {
          shipmentId: id,
          orderId: hooks.order.orderId,
          orderNumber: hooks.order.orderNumber,
          email: hooks.order.email,
          carrier: shipment.carrier,
          trackingNumber: shipment.trackingNumber,
          trackingUrl: shipment.trackingUrl,
        },
        { aggregateId: hooks.order.orderId, actorUserId: actor.userId },
      )
    }
    if (status === 'delivered') {
      await publish(
        'shipment.delivered',
        {
          shipmentId: id,
          orderId: hooks.order.orderId,
          orderNumber: hooks.order.orderNumber,
          email: hooks.order.email,
        },
        { aggregateId: hooks.order.orderId, actorUserId: actor.userId },
      )
    }

    return this.getShipment(id)
  },
}
