/**
 * Handles (docs/catalogue-model.md §6).
 *
 * `/products/classic-burger` is an **address**. `products.id` is **identity**.
 * Conflating them is how a rename breaks every inbound link, every QR code on a
 * table tent, and every order confirmation that quoted a URL.
 *
 * So a handle can change, and every handle a product has ever held is kept. The
 * history table's primary key gives uniqueness across time: a *new* product
 * cannot take a handle that used to mean something else, which is precisely
 * what makes an old link safe to redirect rather than a silent mis-delivery.
 */
import { execute, queryOne } from '../../infrastructure/database/query.js'
import { registerConstraintError } from '../../infrastructure/database/errors.js'
import { ConflictError, ERROR_CODES, ValidationError } from '../../shared/errors/index.js'

// Translated at the data boundary, so no service here contains a SQLSTATE
// (§14.2). The constraint is the *primary key* of the history table, which is
// what enforces uniqueness across time rather than merely across live rows.
registerConstraintError(
  'product_handles_pkey',
  ERROR_CODES.HANDLE_TAKEN,
  'That handle is already in use, now or by a product that used to have it',
)

/**
 * Turns a title into a candidate handle.
 *
 * Transliteration is deliberately not attempted: a title in a non-Latin script
 * produces an empty slug, and the caller is told to supply a handle rather than
 * being given `product-a1b2c3`, which is an address nobody can read or type.
 */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    // Strip combining marks so "Café" becomes "cafe" rather than "caf".
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
    .replace(/-+$/g, '')
}

export function assertUsableHandle(handle: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(handle) || handle.length > 120) {
    throw new ValidationError(
      'A handle must be lowercase letters, digits and single hyphens, e.g. "classic-burger"',
    )
  }
}

export const handles = {
  /**
   * Claims a handle for a product, in the same transaction as the write that
   * needs it.
   *
   * The insert is the claim: uniqueness is decided by the database, not by a
   * prior SELECT, so two admins naming two products the same thing at the same
   * moment produce one success and one conflict rather than two rows.
   */
  async claim(productId: string, handle: string): Promise<void> {
    assertUsableHandle(handle)
    await execute(
      `INSERT INTO product_handles (handle, product_id, is_current) VALUES ($1, $2, true)`,
      [handle, productId],
      { name: 'catalogue.handles.claim' },
    )
  },

  /** Retires the product's current handle and claims a new one. */
  async rename(productId: string, handle: string): Promise<void> {
    assertUsableHandle(handle)
    await execute(
      `UPDATE product_handles SET is_current = false WHERE product_id = $1 AND is_current`,
      [productId],
      { name: 'catalogue.handles.retire' },
    )
    await this.claim(productId, handle)
  },

  /**
   * Resolves any handle a product has ever had.
   *
   * `isCurrent: false` is the signal for the edge to answer 301 to
   * `currentHandle` rather than serving the page at a stale address — one
   * canonical URL per product, without breaking the old one.
   */
  async resolve(
    handle: string,
  ): Promise<{ productId: string; isCurrent: boolean; currentHandle: string } | undefined> {
    const row = await queryOne<{ product_id: string; is_current: boolean; current: string }>(
      `SELECT h.product_id,
              h.is_current,
              p.handle AS current
         FROM product_handles h
         JOIN products p ON p.id = h.product_id
        WHERE h.handle = $1`,
      [handle],
      { name: 'catalogue.handles.resolve' },
    )
    return row
      ? { productId: row.product_id, isCurrent: row.is_current, currentHandle: row.current }
      : undefined
  },

  /**
   * Finds a free handle near `base`, for the convenience of "create this
   * product from a title". Only used when the caller supplied no handle: an
   * explicit handle that collides is a conflict, not something to silently
   * alter behind the operator's back.
   */
  async suggest(base: string): Promise<string> {
    const root = slugify(base)
    if (!root) {
      throw new ValidationError(
        'A handle could not be derived from that title — please supply one',
      )
    }

    for (let suffix = 0; suffix < 50; suffix += 1) {
      const candidate = suffix === 0 ? root : `${root}-${suffix + 1}`
      const taken = await queryOne<{ one: number }>(
        `SELECT 1 AS one FROM product_handles WHERE handle = $1`,
        [candidate],
        { name: 'catalogue.handles.suggest' },
      )
      if (!taken) return candidate
    }
    throw new ConflictError('Could not find an available handle — please supply one', {
      code: ERROR_CODES.ALREADY_EXISTS,
    })
  },
}
