/**
 * The availability rule (docs/inventory.md §7).
 *
 * Five different things get confused for one another constantly, so they are
 * named here and combined in exactly one place:
 *
 * ```
 *   product lifecycle    draft | active | archived      is it finished?
 *   publication          a row per sales channel         is it on sale here?
 *   variant active       a boolean on the variant        is this option offered?
 *   inventory tracking   track_inventory                 do we count it?
 *   inventory available  on_hand - reserved              is there any left?
 * ```
 *
 * A variant is **purchasable** only when all five agree:
 *
 * ```
 *   product.status === 'active'
 *   AND product is published to the channel
 *   AND variant.isActive AND not archived
 *   AND (item is untracked  OR  available > 0)
 * ```
 *
 * The last clause is the one people get wrong. `track_inventory = false` means
 * *unlimited* — a made-to-order burger the kitchen will always cook — and must
 * never be read as zero. So does the absence of an inventory item: a variant
 * nobody has ever stocked is not a variant that is sold out, and treating it as
 * sold out would silently hide products the moment this feature shipped.
 *
 * This module owns only the inventory half of the rule. The other three clauses
 * belong to the catalogue and are applied there, because that is where product
 * status and publication live.
 */
import { inventoryRepository as repo } from './inventory.repository.js'
import type { AvailabilityState, VariantAvailability } from './inventory.types.js'

/** A variant with no inventory item is untracked, not out of stock. */
const UNTRACKED: Omit<VariantAvailability, 'variantId'> = {
  inventoryItemId: null,
  trackInventory: false,
  available: 0,
  state: 'made_to_order',
  inStock: true,
}

function stateFor(trackInventory: boolean, available: number): AvailabilityState {
  if (!trackInventory) return 'made_to_order'
  return available > 0 ? 'in_stock' : 'out_of_stock'
}

/**
 * The inventory half of the rule, as SQL, for callers that must apply it
 * *inside* a query rather than after one.
 *
 * A listing that wants "in stock only" cannot resolve availability afterwards —
 * filtering a page that has already been cut to twenty rows returns fewer than
 * twenty and gets the total wrong. So the predicate has to reach the WHERE
 * clause, and the only safe way to allow that is to hand out the one true
 * version from here rather than let the catalogue write its own.
 *
 * `inStockJoin` supplies the two joins the predicate reads; `IN_STOCK_PREDICATE`
 * is the same three-way test `forVariants` applies in TypeScript — untracked is
 * unlimited, a missing item is untracked, and only a tracked item at zero is
 * out of stock.
 *
 * Neither interpolates anything a caller supplies: the alias is written by the
 * calling module, never by a request.
 */
export function inStockJoin(variantAlias: string): string {
  return `LEFT JOIN inventory_items inv
                 ON inv.variant_id = ${variantAlias}.id AND inv.archived_at IS NULL
          LEFT JOIN LATERAL (
            SELECT coalesce(sum(l.available) FILTER (WHERE loc.is_active), 0)::int AS available
              FROM inventory_levels l
              JOIN inventory_locations loc
                ON loc.id = l.location_id AND loc.archived_at IS NULL
             WHERE l.inventory_item_id = inv.id
          ) lvl ON true`
}

export const IN_STOCK_PREDICATE =
  '(inv.id IS NULL OR NOT inv.track_inventory OR coalesce(lvl.available, 0) > 0)'

export const availabilityService = {
  /**
   * Availability for many variants at once, as a Map keyed by variant id.
   *
   * Batched deliberately: a storefront listing renders twenty products, and
   * asking twenty times is how a catalogue page becomes slow enough that
   * somebody caches the answer and reintroduces the staleness this design
   * exists to avoid.
   */
  async forVariants(variantIds: string[]): Promise<Map<string, VariantAvailability>> {
    const out = new Map<string, VariantAvailability>()
    if (variantIds.length === 0) return out

    const rows = await repo.availabilityForVariants([...new Set(variantIds)])
    for (const row of rows) {
      if (!row.inventory_item_id) {
        out.set(row.variant_id, { variantId: row.variant_id, ...UNTRACKED })
        continue
      }
      const trackInventory = row.track_inventory ?? false
      const available = row.available ?? 0
      out.set(row.variant_id, {
        variantId: row.variant_id,
        inventoryItemId: row.inventory_item_id,
        trackInventory,
        available,
        state: stateFor(trackInventory, available),
        // The whole point: untracked is purchasable regardless of the number.
        inStock: !trackInventory || available > 0,
      })
    }

    // A variant the query did not answer for is untracked, not missing.
    for (const variantId of variantIds) {
      if (!out.has(variantId)) out.set(variantId, { variantId, ...UNTRACKED })
    }
    return out
  },

  async forVariant(variantId: string): Promise<VariantAvailability> {
    const map = await this.forVariants([variantId])
    return map.get(variantId) ?? { variantId, ...UNTRACKED }
  },

  /**
   * The inventory half of the purchasability rule, isolated so a caller cannot
   * accidentally implement "available > 0" and lose the untracked case.
   */
  isSellable(availability: VariantAvailability): boolean {
    return availability.inStock
  },
}
