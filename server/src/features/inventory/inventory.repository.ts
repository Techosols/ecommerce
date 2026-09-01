/**
 * Inventory data access (§1.2). SQL only.
 *
 * The important statements in this file are the two conditional UPDATEs —
 * `applyOnHandDelta` and `applyReservedDelta`. They are the concurrency
 * strategy, and the reason there is no read-then-write anywhere:
 *
 * ```sql
 * UPDATE inventory_levels SET reserved = reserved + $qty
 *  WHERE id = $1 AND on_hand - reserved >= $qty
 * ```
 *
 * A `SELECT` followed by an `UPDATE` has a window between them; two requests
 * can both read `available = 10`, both decide 7 is fine, and both write. The
 * single statement has no such window: Postgres takes the row lock as part of
 * the update, and a concurrent writer that was blocked re-evaluates the `WHERE`
 * against the *committed* new version before proceeding. So the loser's
 * predicate simply stops being true, and it affects zero rows — which the
 * service reads as "not enough stock" (§18.3).
 *
 * That is why this works across processes, and why an in-process mutex would
 * not.
 */
import { execute, query, queryOne } from '../../infrastructure/database/query.js'
import { registerConstraintError } from '../../infrastructure/database/errors.js'
import { ERROR_CODES } from '../../shared/errors/index.js'
import type {
  InventoryItem,
  InventoryLevel,
  InventoryLocation,
  InventoryMovement,
  MovementFilter,
  MovementReason,
  MovementReferenceType,
  Reservation,
  ReservationOwnerType,
  ReservationStatus,
} from './inventory.types.js'

registerConstraintError(
  'inventory_locations_code_key',
  ERROR_CODES.ALREADY_EXISTS,
  'A location with that code already exists',
)
registerConstraintError(
  'inventory_items_variant_id_key',
  ERROR_CODES.ALREADY_EXISTS,
  'That variant already has an inventory item',
)
registerConstraintError(
  'one_level_per_item_and_location',
  ERROR_CODES.ALREADY_EXISTS,
  'That item already has a stock level at that location',
)
registerConstraintError(
  'inventory_reservations_one_active_per_owner',
  ERROR_CODES.RESERVATION_EXISTS,
  'That owner already holds an active reservation for this item at this location',
)
// Reached only if a service bug gets past the conditional updates below. It is
// the last line of defence, and it should read as one.
registerConstraintError(
  'reserved_within_on_hand',
  ERROR_CODES.INSUFFICIENT_STOCK,
  'That change would reserve more stock than is held',
)

// ── Row shapes ──────────────────────────────────────────────────────────────

interface LocationRow {
  id: string
  code: string
  name: string
  address: Record<string, unknown>
  is_active: boolean
  is_default: boolean
  position: number
  created_at: Date
  updated_at: Date
  archived_at: Date | null
}

interface ItemRow {
  id: string
  variant_id: string
  track_inventory: boolean
  low_stock_threshold: number | null
  created_at: Date
  updated_at: Date
  archived_at: Date | null
}

interface LevelRow {
  id: string
  inventory_item_id: string
  location_id: string
  on_hand: number
  reserved: number
  available: number
  created_at: Date
  updated_at: Date
}

interface MovementRow {
  id: string
  inventory_item_id: string
  location_id: string
  delta_on_hand: number
  delta_reserved: number
  reason: MovementReason
  reference_type: MovementReferenceType | null
  reference_id: string | null
  resulting_on_hand: number
  resulting_reserved: number
  actor_user_id: string | null
  note: string | null
  created_at: Date
}

interface ReservationRow {
  id: string
  inventory_item_id: string
  location_id: string
  quantity: number
  status: ReservationStatus
  owner_type: ReservationOwnerType
  owner_id: string
  expires_at: Date
  resolved_at: Date | null
  resolved_by: string | null
  created_at: Date
  updated_at: Date
}

function toLocation(row: LocationRow): InventoryLocation {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    address: row.address ?? {},
    isActive: row.is_active,
    isDefault: row.is_default,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  }
}

function toItem(row: ItemRow): InventoryItem {
  return {
    id: row.id,
    variantId: row.variant_id,
    trackInventory: row.track_inventory,
    lowStockThreshold: row.low_stock_threshold,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  }
}

function toLevel(row: LevelRow): InventoryLevel {
  return {
    id: row.id,
    inventoryItemId: row.inventory_item_id,
    locationId: row.location_id,
    onHand: row.on_hand,
    reserved: row.reserved,
    available: row.available,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toMovement(row: MovementRow): InventoryMovement {
  return {
    id: String(row.id),
    inventoryItemId: row.inventory_item_id,
    locationId: row.location_id,
    deltaOnHand: row.delta_on_hand,
    deltaReserved: row.delta_reserved,
    reason: row.reason,
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    resultingOnHand: row.resulting_on_hand,
    resultingReserved: row.resulting_reserved,
    actorUserId: row.actor_user_id,
    note: row.note,
    createdAt: row.created_at,
  }
}

function toReservation(row: ReservationRow): Reservation {
  return {
    id: row.id,
    inventoryItemId: row.inventory_item_id,
    locationId: row.location_id,
    quantity: row.quantity,
    status: row.status,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export const inventoryRepository = {
  // ── Locations ─────────────────────────────────────────────────────────────

  async createLocation(input: {
    id: string
    code: string
    name: string
    address: Record<string, unknown>
    position: number
    isDefault: boolean
  }): Promise<InventoryLocation> {
    const row = await queryOne<LocationRow>(
      `INSERT INTO inventory_locations (id, code, name, address, position, is_default)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [input.id, input.code, input.name, JSON.stringify(input.address), input.position, input.isDefault],
      { name: 'inventory.createLocation' },
    )
    if (!row) throw new Error('Failed to create location')
    return toLocation(row)
  },

  async findLocationById(id: string): Promise<InventoryLocation | undefined> {
    const row = await queryOne<LocationRow>(`SELECT * FROM inventory_locations WHERE id = $1`, [id], {
      name: 'inventory.findLocationById',
    })
    return row ? toLocation(row) : undefined
  },

  async findLocationByCode(code: string): Promise<InventoryLocation | undefined> {
    const row = await queryOne<LocationRow>(
      `SELECT * FROM inventory_locations WHERE code = $1`,
      [code],
      { name: 'inventory.findLocationByCode' },
    )
    return row ? toLocation(row) : undefined
  },

  async defaultLocation(): Promise<InventoryLocation> {
    const row = await queryOne<LocationRow>(
      `SELECT * FROM inventory_locations WHERE is_default`,
      [],
      { name: 'inventory.defaultLocation' },
    )
    if (!row) throw new Error('No default location — migration 0008 has not been applied')
    return toLocation(row)
  },

  async listLocations(options: { activeOnly?: boolean } = {}): Promise<InventoryLocation[]> {
    const rows = await query<LocationRow>(
      `SELECT * FROM inventory_locations
        WHERE archived_at IS NULL ${options.activeOnly ? 'AND is_active' : ''}
        ORDER BY is_default DESC, position, name`,
      [],
      { name: 'inventory.listLocations' },
    )
    return rows.map(toLocation)
  },

  async clearDefaultLocation(): Promise<void> {
    await execute(`UPDATE inventory_locations SET is_default = false WHERE is_default`, [], {
      name: 'inventory.clearDefaultLocation',
    })
  },

  async updateLocation(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<InventoryLocation | undefined> {
    const columns: Record<string, string> = {
      code: 'code',
      name: 'name',
      address: 'address',
      isActive: 'is_active',
      isDefault: 'is_default',
      position: 'position',
    }
    const params: unknown[] = []
    const sets: string[] = []
    for (const [field, column] of Object.entries(columns)) {
      if (!(field in patch) || patch[field] === undefined) continue
      params.push(field === 'address' ? JSON.stringify(patch[field]) : patch[field])
      sets.push(`${column} = $${params.length}`)
    }
    if (sets.length === 0) return this.findLocationById(id)

    params.push(id)
    const row = await queryOne<LocationRow>(
      `UPDATE inventory_locations SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
      { name: 'inventory.updateLocation' },
    )
    return row ? toLocation(row) : undefined
  },

  async archiveLocation(id: string): Promise<void> {
    await execute(
      `UPDATE inventory_locations SET archived_at = now(), is_active = false WHERE id = $1`,
      [id],
      { name: 'inventory.archiveLocation' },
    )
  },

  async countStockAtLocation(locationId: string): Promise<number> {
    const row = await queryOne<{ count: number }>(
      `SELECT coalesce(sum(on_hand), 0)::int AS count FROM inventory_levels WHERE location_id = $1`,
      [locationId],
      { name: 'inventory.countStockAtLocation' },
    )
    return row?.count ?? 0
  },

  // ── Items ─────────────────────────────────────────────────────────────────

  async createItem(input: {
    id: string
    variantId: string
    trackInventory: boolean
    lowStockThreshold: number | null
  }): Promise<InventoryItem> {
    const row = await queryOne<ItemRow>(
      `INSERT INTO inventory_items (id, variant_id, track_inventory, low_stock_threshold)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [input.id, input.variantId, input.trackInventory, input.lowStockThreshold],
      { name: 'inventory.createItem' },
    )
    if (!row) throw new Error('Failed to create inventory item')
    return toItem(row)
  },

  /** Idempotent creation, for the variant-created path (§8.3). */
  async ensureItem(id: string, variantId: string): Promise<InventoryItem | undefined> {
    const row = await queryOne<ItemRow>(
      `INSERT INTO inventory_items (id, variant_id) VALUES ($1,$2)
       ON CONFLICT (variant_id) DO NOTHING
       RETURNING *`,
      [id, variantId],
      { name: 'inventory.ensureItem' },
    )
    return row ? toItem(row) : undefined
  },

  async findItemById(id: string): Promise<InventoryItem | undefined> {
    const row = await queryOne<ItemRow>(`SELECT * FROM inventory_items WHERE id = $1`, [id], {
      name: 'inventory.findItemById',
    })
    return row ? toItem(row) : undefined
  },

  async findItemByVariant(variantId: string): Promise<InventoryItem | undefined> {
    const row = await queryOne<ItemRow>(
      `SELECT * FROM inventory_items WHERE variant_id = $1`,
      [variantId],
      { name: 'inventory.findItemByVariant' },
    )
    return row ? toItem(row) : undefined
  },

  async updateItem(id: string, patch: Record<string, unknown>): Promise<InventoryItem | undefined> {
    const columns: Record<string, string> = {
      trackInventory: 'track_inventory',
      lowStockThreshold: 'low_stock_threshold',
    }
    const params: unknown[] = []
    const sets: string[] = []
    for (const [field, column] of Object.entries(columns)) {
      if (!(field in patch) || patch[field] === undefined) continue
      params.push(patch[field])
      sets.push(`${column} = $${params.length}`)
    }
    if (sets.length === 0) return this.findItemById(id)

    params.push(id)
    const row = await queryOne<ItemRow>(
      `UPDATE inventory_items SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
      { name: 'inventory.updateItem' },
    )
    return row ? toItem(row) : undefined
  },

  /**
   * Items with their totals and their identity, for the admin list.
   *
   * The join to variants and products is the point. An inventory row is a
   * quantity, and a quantity without the name of the thing it counts is not
   * something anybody can act on — the operator holding a picking list knows
   * "Classic Burger, Brioche", not an inventory item's uuid.
   *
   * `locationId` narrows the totals to one location rather than filtering which
   * items appear: "what is in the Camden shop" is a question about quantities,
   * and an item stocked nowhere else should still show, at zero, so somebody can
   * see it is not there.
   */
  async listItems(filter: {
    limit: number
    offset: number
    lowOnly?: boolean
    tracked?: boolean
    query?: string
    locationId?: string
    defaultThreshold: number
  }) {
    const params: unknown[] = []
    const push = (value: unknown): string => {
      params.push(value)
      return `$${params.length}`
    }

    // Bound before anything else, because it appears inside the join condition
    // and therefore before every WHERE parameter.
    const levelJoin = filter.locationId
      ? `LEFT JOIN inventory_levels l
                 ON l.inventory_item_id = i.id AND l.location_id = ${push(filter.locationId)}`
      : `LEFT JOIN inventory_levels l ON l.inventory_item_id = i.id`

    const where: string[] = ['i.archived_at IS NULL', 'v.archived_at IS NULL']
    if (filter.tracked !== undefined) where.push(`i.track_inventory = ${push(filter.tracked)}`)
    if (filter.query) {
      // SKU, variant title and product title in one box: an operator looking
      // for stock has one of the three in their hand and should not have to
      // know which field the shop calls it.
      const like = push(`%${filter.query}%`)
      where.push(`(v.sku::text ILIKE ${like} OR v.title ILIKE ${like} OR p.title ILIKE ${like})`)
    }

    const having = filter.lowOnly
      ? `HAVING i.track_inventory AND coalesce(sum(l.available), 0) <= coalesce(i.low_stock_threshold, ${push(filter.defaultThreshold)})`
      : ''

    const from = `FROM inventory_items i
         JOIN product_variants v ON v.id = i.variant_id
         JOIN products p ON p.id = v.product_id
         ${levelJoin}
        WHERE ${where.join(' AND ')}`

    const rows = await query<
      ItemRow & {
        total_on_hand: number
        total_reserved: number
        total_available: number
        product_id: string
        product_title: string
        variant_title: string
        sku: string | null
      }
    >(
      `SELECT i.*, p.id AS product_id, p.title AS product_title,
              v.title AS variant_title, v.sku::text AS sku,
              coalesce(sum(l.on_hand), 0)::int   AS total_on_hand,
              coalesce(sum(l.reserved), 0)::int  AS total_reserved,
              coalesce(sum(l.available), 0)::int AS total_available
         ${from}
        GROUP BY i.id, p.id, v.id
        ${having}
        ORDER BY p.title, v.position, v.id
        LIMIT ${push(filter.limit)} OFFSET ${push(filter.offset)}`,
      params,
      { name: 'inventory.listItems' },
    )

    // The count re-runs the same shape without the paging parameters, which is
    // why the fragments above are built once and reused rather than written
    // twice and left to drift.
    const countParams = params.slice(0, params.length - 2)
    const totalRow = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM (
         SELECT i.id ${from} GROUP BY i.id, p.id, v.id ${having}
       ) t`,
      countParams,
      { name: 'inventory.countItems' },
    )

    return {
      rows: rows.map((row) => ({
        item: toItem(row),
        productId: row.product_id,
        productTitle: row.product_title,
        variantTitle: row.variant_title,
        sku: row.sku,
        totalOnHand: row.total_on_hand,
        totalReserved: row.total_reserved,
        totalAvailable: row.total_available,
      })),
      total: totalRow?.count ?? 0,
    }
  },

  // ── Levels ────────────────────────────────────────────────────────────────

  /**
   * Returns the level, creating it at zero if this item has never been stocked
   * at this location.
   *
   * `ON CONFLICT DO NOTHING` then re-read, rather than DO UPDATE: two requests
   * racing to first-stock the same item must not have one of them silently
   * overwrite the other's row.
   */
  async ensureLevel(id: string, inventoryItemId: string, locationId: string): Promise<InventoryLevel> {
    await execute(
      `INSERT INTO inventory_levels (id, inventory_item_id, location_id)
       VALUES ($1,$2,$3) ON CONFLICT (inventory_item_id, location_id) DO NOTHING`,
      [id, inventoryItemId, locationId],
      { name: 'inventory.ensureLevel' },
    )
    const row = await queryOne<LevelRow>(
      `SELECT * FROM inventory_levels WHERE inventory_item_id = $1 AND location_id = $2`,
      [inventoryItemId, locationId],
      { name: 'inventory.readLevel' },
    )
    if (!row) throw new Error('Failed to create inventory level')
    return toLevel(row)
  },

  async findLevel(inventoryItemId: string, locationId: string): Promise<InventoryLevel | undefined> {
    const row = await queryOne<LevelRow>(
      `SELECT * FROM inventory_levels WHERE inventory_item_id = $1 AND location_id = $2`,
      [inventoryItemId, locationId],
      { name: 'inventory.findLevel' },
    )
    return row ? toLevel(row) : undefined
  },

  /**
   * The product and variant an item counts.
   *
   * Separate from `findItemById` because most callers of that are movement
   * paths that have no use for a title, and one join is cheaper than carrying
   * four columns through every adjustment.
   */
  async identityFor(variantId: string): Promise<{
    productId: string
    productTitle: string
    variantTitle: string
    sku: string | null
  } | undefined> {
    const row = await queryOne<{
      product_id: string
      product_title: string
      variant_title: string
      sku: string | null
    }>(
      `SELECT p.id AS product_id, p.title AS product_title, v.title AS variant_title, v.sku
         FROM product_variants v
         JOIN products p ON p.id = v.product_id
        WHERE v.id = $1`,
      [variantId],
      { name: 'inventory.identityFor' },
    )
    if (!row) return undefined
    return {
      productId: row.product_id,
      productTitle: row.product_title,
      variantTitle: row.variant_title,
      sku: row.sku,
    }
  },

  async levelsFor(inventoryItemId: string) {
    const rows = await query<LevelRow & { code: string; location_name: string }>(
      `SELECT l.*, loc.code, loc.name AS location_name
         FROM inventory_levels l
         JOIN inventory_locations loc ON loc.id = l.location_id
        WHERE l.inventory_item_id = $1
        ORDER BY loc.is_default DESC, loc.position, loc.name`,
      [inventoryItemId],
      { name: 'inventory.levelsFor' },
    )
    return rows.map((row) => ({
      ...toLevel(row),
      locationCode: row.code,
      locationName: row.location_name,
    }))
  },

  /**
   * Moves `on_hand` by a signed delta, atomically.
   *
   * The predicate does two jobs: it refuses to go negative, and it refuses to
   * strand reservations by dropping stock below what is already reserved. Zero
   * rows means one of those was violated — not that the row is missing, which
   * the caller has already established.
   */
  async applyOnHandDelta(levelId: string, delta: number): Promise<InventoryLevel | undefined> {
    const row = await queryOne<LevelRow>(
      `UPDATE inventory_levels
          SET on_hand = on_hand + $2
        WHERE id = $1
          AND on_hand + $2 >= 0
          AND on_hand + $2 >= reserved
      RETURNING *`,
      [levelId, delta],
      { name: 'inventory.applyOnHandDelta' },
    )
    return row ? toLevel(row) : undefined
  },

  /**
   * Moves `reserved` by a signed delta, atomically.
   *
   * Reserving (`delta > 0`) succeeds only while `available >= delta`. This one
   * statement is the whole overselling defence: there is no window between
   * checking and taking.
   */
  async applyReservedDelta(levelId: string, delta: number): Promise<InventoryLevel | undefined> {
    const row = await queryOne<LevelRow>(
      `UPDATE inventory_levels
          SET reserved = reserved + $2
        WHERE id = $1
          AND reserved + $2 >= 0
          AND reserved + $2 <= on_hand
      RETURNING *`,
      [levelId, delta],
      { name: 'inventory.applyReservedDelta' },
    )
    return row ? toLevel(row) : undefined
  },

  /**
   * Commits a reservation: the goods leave. `on_hand` and `reserved` both fall
   * by the same amount, in one statement, so `available` never twitches.
   */
  async applyCommit(levelId: string, quantity: number): Promise<InventoryLevel | undefined> {
    const row = await queryOne<LevelRow>(
      `UPDATE inventory_levels
          SET on_hand = on_hand - $2, reserved = reserved - $2
        WHERE id = $1 AND reserved >= $2 AND on_hand >= $2
      RETURNING *`,
      [levelId, quantity],
      { name: 'inventory.applyCommit' },
    )
    return row ? toLevel(row) : undefined
  },

  // ── Movements ─────────────────────────────────────────────────────────────

  async recordMovement(input: {
    inventoryItemId: string
    locationId: string
    deltaOnHand: number
    deltaReserved: number
    reason: MovementReason
    referenceType: MovementReferenceType | null
    referenceId: string | null
    resultingOnHand: number
    resultingReserved: number
    actorUserId: string | null
    note: string | null
  }): Promise<void> {
    await execute(
      `INSERT INTO inventory_movements
         (inventory_item_id, location_id, delta_on_hand, delta_reserved, reason,
          reference_type, reference_id, resulting_on_hand, resulting_reserved,
          actor_user_id, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        input.inventoryItemId,
        input.locationId,
        input.deltaOnHand,
        input.deltaReserved,
        input.reason,
        input.referenceType,
        input.referenceId,
        input.resultingOnHand,
        input.resultingReserved,
        input.actorUserId,
        input.note,
      ],
      { name: 'inventory.recordMovement' },
    )
  },

  async listMovements(filter: MovementFilter): Promise<{ rows: InventoryMovement[]; total: number }> {
    const params: unknown[] = []
    const where: string[] = []
    const add = (sql: string, value: unknown): void => {
      params.push(value)
      where.push(sql.replace('$?', `$${params.length}`))
    }
    if (filter.inventoryItemId) add('inventory_item_id = $?', filter.inventoryItemId)
    if (filter.locationId) add('location_id = $?', filter.locationId)
    if (filter.reason) add('reason = $?', filter.reason)

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const rows = await query<MovementRow>(
      `SELECT * FROM inventory_movements ${clause}
        ORDER BY created_at DESC, id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filter.limit, filter.offset],
      { name: 'inventory.listMovements' },
    )
    const totalRow = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM inventory_movements ${clause}`,
      params,
      { name: 'inventory.countMovements' },
    )
    return { rows: rows.map(toMovement), total: totalRow?.count ?? 0 }
  },

  // ── Reservations ──────────────────────────────────────────────────────────

  async createReservation(input: {
    id: string
    inventoryItemId: string
    locationId: string
    quantity: number
    ownerType: ReservationOwnerType
    ownerId: string
    expiresAt: Date
  }): Promise<Reservation> {
    const row = await queryOne<ReservationRow>(
      `INSERT INTO inventory_reservations
         (id, inventory_item_id, location_id, quantity, owner_type, owner_id, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        input.id,
        input.inventoryItemId,
        input.locationId,
        input.quantity,
        input.ownerType,
        input.ownerId,
        input.expiresAt,
      ],
      { name: 'inventory.createReservation' },
    )
    if (!row) throw new Error('Failed to create reservation')
    return toReservation(row)
  },

  async findReservationById(id: string): Promise<Reservation | undefined> {
    const row = await queryOne<ReservationRow>(
      `SELECT * FROM inventory_reservations WHERE id = $1`,
      [id],
      { name: 'inventory.findReservationById' },
    )
    return row ? toReservation(row) : undefined
  },

  /**
   * Resolves a reservation exactly once.
   *
   * `WHERE status = 'active'` is the compare-and-swap that makes double-release
   * and double-commit impossible: the second caller updates zero rows and is
   * told the reservation is already resolved. Nothing is decremented twice.
   */
  async resolveReservation(
    id: string,
    status: Exclude<ReservationStatus, 'active'>,
    resolvedBy: string | null,
  ): Promise<Reservation | undefined> {
    const row = await queryOne<ReservationRow>(
      `UPDATE inventory_reservations
          SET status = $2, resolved_at = now(), resolved_by = $3
        WHERE id = $1 AND status = 'active'
      RETURNING *`,
      [id, status, resolvedBy],
      { name: 'inventory.resolveReservation' },
    )
    return row ? toReservation(row) : undefined
  },

  async listReservationsFor(ownerType: ReservationOwnerType, ownerId: string): Promise<Reservation[]> {
    const rows = await query<ReservationRow>(
      `SELECT * FROM inventory_reservations
        WHERE owner_type = $1 AND owner_id = $2
        ORDER BY created_at`,
      [ownerType, ownerId],
      { name: 'inventory.listReservationsFor' },
    )
    return rows.map(toReservation)
  },

  /**
   * Active reservations against one item, newest first.
   *
   * Only the active ones: a released or committed reservation is history, and
   * the question this answers is "what is holding my stock *now*". The order
   * number comes along when the owner is an order, so the answer names
   * something an operator can open rather than a uuid.
   */
  async activeReservationsForItem(inventoryItemId: string): Promise<
    Array<Reservation & { orderNumber: string | null }>
  > {
    const rows = await query<ReservationRow & { order_number: string | null }>(
      `SELECT r.*, o.order_number
         FROM inventory_reservations r
         LEFT JOIN orders o ON r.owner_type = 'order' AND o.id = r.owner_id
        WHERE r.inventory_item_id = $1 AND r.status = 'active'
        ORDER BY r.created_at DESC`,
      [inventoryItemId],
      { name: 'inventory.activeReservationsForItem' },
    )
    return rows.map((row) => ({ ...toReservation(row), orderNumber: row.order_number }))
  },

  /**
   * Claims a batch of expired reservations for the sweep.
   *
   * `SKIP LOCKED` reduces the chance two workers pick the same rows; it is not
   * what makes the sweep safe. That is the compare-and-swap in
   * `resolveReservation` — a worker that loses it simply resolves nothing.
   */
  async claimExpiredReservations(limit: number): Promise<Reservation[]> {
    const rows = await query<ReservationRow>(
      `SELECT * FROM inventory_reservations
        WHERE status = 'active' AND expires_at <= now()
        ORDER BY expires_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
      { name: 'inventory.claimExpiredReservations' },
    )
    return rows.map(toReservation)
  },

  // ── Availability ──────────────────────────────────────────────────────────

  /**
   * Availability for many variants in one query.
   *
   * Batched because a storefront listing renders twenty products at once, and
   * twenty round trips to answer "is it in stock" is how a catalogue page ends
   * up slow.
   *
   * A LEFT JOIN, so a variant with no inventory item still comes back — the
   * service decides what that means rather than the absence of a row silently
   * meaning zero (§8).
   */
  async availabilityForVariants(variantIds: string[]) {
    if (variantIds.length === 0) return []
    return query<{
      variant_id: string
      inventory_item_id: string | null
      track_inventory: boolean | null
      available: number | null
    }>(
      `SELECT v.id AS variant_id,
              i.id AS inventory_item_id,
              i.track_inventory,
              coalesce(sum(l.available) FILTER (WHERE loc.is_active), 0)::int AS available
         FROM unnest($1::uuid[]) AS v(id)
         LEFT JOIN inventory_items i ON i.variant_id = v.id AND i.archived_at IS NULL
         LEFT JOIN inventory_levels l ON l.inventory_item_id = i.id
         LEFT JOIN inventory_locations loc ON loc.id = l.location_id AND loc.archived_at IS NULL
        GROUP BY v.id, i.id, i.track_inventory`,
      [variantIds],
      { name: 'inventory.availabilityForVariants' },
    )
  },
}
