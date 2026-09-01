/**
 * Seeding the category tree (§4.2, docs/catalogue-model.md).
 *
 * The planning is pure and covered by `tests/unit/taxonomy.seed.test.ts`. This
 * suite is about the half that touches the merchant's data, where the failures
 * are expensive and quiet:
 *
 *   • **Re-running adds nothing.** Someone will run it twice.
 *   • **It never touches what is already there.** A pruned tree stays pruned;
 *     a renamed category keeps its name; nothing is archived or moved.
 *   • **The tree it writes is a tree.** Parents before children, no orphans,
 *     no row pointing at an id that was never inserted.
 *   • **It yields on handles**, so a store that already sells dresses does not
 *     collide with the dresses it has.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { v7 as uuidv7 } from 'uuid'
import { execute, query, queryOne } from '../../src/infrastructure/database/query.js'
import { applyCategorySeed, keyFor, readStore } from '../../scripts/lib/applyCategorySeed.js'
import { planCategories, type TaxonomyFile } from '../../scripts/lib/taxonomySeed.js'
import {
  describeIfDatabase,
  setupDatabase,
  teardownDatabase,
  truncateAll,
} from '../setup/database.js'

const here = dirname(fileURLToPath(import.meta.url))
const shopify = JSON.parse(
  await readFile(join(here, '..', '..', 'scripts', 'data', 'shopify-taxonomy.json'), 'utf8'),
) as TaxonomyFile

/** A small tree, so the assertions are about behaviour rather than 1,792 rows. */
function fixture(): TaxonomyFile {
  return {
    source: 'Test',
    version: '0',
    url: '',
    retrievedAt: '',
    maxDepth: 3,
    note: '',
    categories: [
      { id: 'aa', parent: null, name: 'Apparel & Accessories', position: 0 },
      { id: 'aa-1', parent: 'aa', name: 'Clothing', position: 0 },
      { id: 'aa-1-1', parent: 'aa-1', name: 'Dresses', position: 0 },
      { id: 'aa-1-2', parent: 'aa-1', name: 'Shirts & Tops', position: 1 },
      { id: 'hg', parent: null, name: 'Home & Garden', position: 1 },
      { id: 'hg-1', parent: 'hg', name: 'Kitchen', position: 0 },
    ],
  }
}

const all = { excludeVerticals: [] as string[] }

describeIfDatabase('seeding categories', () => {
  const rows = () =>
    query<{ id: string; parent_id: string | null; name: string; handle: string; position: number }>(
      `SELECT id, parent_id, name, handle, position FROM categories`,
      [],
    )

  const byName = async (name: string) =>
    await queryOne<{ id: string; parent_id: string | null; name: string; handle: string }>(
      `SELECT id, parent_id, name, handle FROM categories WHERE name = $1`,
      [name],
    )

  beforeAll(setupDatabase)
  afterEach(truncateAll)
  afterAll(teardownDatabase)

  // ── Writing it ────────────────────────────────────────────────────────────

  describe('a first run', () => {
    it('writes the whole plan as a connected tree', async () => {
      const result = await applyCategorySeed(fixture(), all)

      expect(result.inserted).toBe(6)
      const written = await rows()
      expect(written).toHaveLength(6)

      // Every parent_id names a row that exists: the property that makes it a
      // tree rather than six rows.
      const ids = new Set(written.map((row) => row.id))
      for (const row of written) {
        if (row.parent_id) expect(ids.has(row.parent_id)).toBe(true)
      }
      expect(written.filter((row) => row.parent_id === null)).toHaveLength(2)
    })

    it('hangs each category under the right parent', async () => {
      await applyCategorySeed(fixture(), all)

      const clothing = await byName('Clothing')
      const dresses = await byName('Dresses')
      const apparel = await byName('Apparel & Accessories')

      expect(clothing?.parent_id).toBe(apparel?.id)
      expect(dresses?.parent_id).toBe(clothing?.id)
      expect(apparel?.parent_id).toBeNull()
    })

    it('keeps the published order of siblings', async () => {
      await applyCategorySeed(fixture(), all)
      const clothing = await byName('Clothing')

      const children = await query<{ name: string; position: number }>(
        `SELECT name, position FROM categories WHERE parent_id = $1 ORDER BY position`,
        [clothing?.id],
      )

      expect(children).toEqual([
        { name: 'Dresses', position: 0 },
        { name: 'Shirts & Tops', position: 1 },
      ])
    })

    it('writes readable handles', async () => {
      await applyCategorySeed(fixture(), all)

      expect((await byName('Dresses'))?.handle).toBe('dresses')
      expect((await byName('Shirts & Tops'))?.handle).toBe('shirts-tops')
    })

    it('writes nothing at all on a dry run', async () => {
      const result = await applyCategorySeed(fixture(), { ...all, dryRun: true })

      expect(result.pending).toHaveLength(6)
      expect(result.inserted).toBe(0)
      expect(await rows()).toHaveLength(0)
    })
  })

  // ── Running it again ──────────────────────────────────────────────────────

  describe('a second run', () => {
    it('adds nothing and changes nothing', async () => {
      await applyCategorySeed(fixture(), all)
      const before = await rows()

      const again = await applyCategorySeed(fixture(), all)

      expect(again.inserted).toBe(0)
      expect(again.matched).toBe(6)
      // Same ids, same parents, same handles: not merely the same count.
      expect(await rows()).toEqual(before)
    })

    it('fills in a gap without disturbing what surrounds it', async () => {
      await applyCategorySeed(fixture(), all)
      const kitchen = await byName('Kitchen')
      await execute(`DELETE FROM categories WHERE id = $1`, [kitchen?.id])
      const apparel = await byName('Apparel & Accessories')

      const again = await applyCategorySeed(fixture(), all)

      expect(again.inserted).toBe(1)
      expect((await byName('Kitchen'))?.id).not.toBe(kitchen?.id)
      // Untouched, and still carrying the id it had.
      expect((await byName('Apparel & Accessories'))?.id).toBe(apparel?.id)
    })

    it('leaves a renamed category alone rather than growing a duplicate', async () => {
      // A rename makes it a different category, correctly. What must not
      // happen is the original name reappearing beside it on the next run
      // because the seed matched on handle.
      await applyCategorySeed(fixture(), all)
      const dresses = await byName('Dresses')
      await execute(`UPDATE categories SET handle = 'frocks' WHERE id = $1`, [dresses?.id])

      const again = await applyCategorySeed(fixture(), all)

      expect(again.inserted).toBe(0)
      const stillOne = await query(`SELECT id FROM categories WHERE name = 'Dresses'`, [])
      expect(stillOne).toHaveLength(1)
    })

    it('does not resurrect a subtree the merchant pruned', async () => {
      // Deleting a vertical the merchant does not sell must stick. They will
      // re-run the seed one day for an unrelated reason.
      await applyCategorySeed(fixture(), all)
      const home = await byName('Home & Garden')
      await execute(`DELETE FROM categories WHERE parent_id = $1`, [home?.id])
      await execute(`DELETE FROM categories WHERE id = $1`, [home?.id])

      await applyCategorySeed(fixture(), { excludeVerticals: ['Home & Garden'] })

      expect(await byName('Home & Garden')).toBeUndefined()
      expect(await byName('Kitchen')).toBeUndefined()
    })
  })

  // ── Meeting a store that is already in use ────────────────────────────────

  describe('a store that already has categories', () => {
    it('yields the handle and takes a longer one', async () => {
      const id = uuidv7()
      await execute(
        `INSERT INTO categories (id, parent_id, name, handle, position)
         VALUES ($1, NULL, 'My Dresses', 'dresses', 0)`,
        [id],
      )

      await applyCategorySeed(fixture(), all)

      expect((await byName('Dresses'))?.handle).toBe('clothing-dresses')
      // The merchant's own category is untouched.
      expect((await byName('My Dresses'))?.handle).toBe('dresses')
    })

    it('adopts a category the merchant already made, rather than duplicating it', async () => {
      const id = uuidv7()
      await execute(
        `INSERT INTO categories (id, parent_id, name, handle, position)
         VALUES ($1, NULL, 'Apparel & Accessories', 'my-apparel', 0)`,
        [id],
      )

      const result = await applyCategorySeed(fixture(), all)

      expect(result.matched).toBe(1)
      expect(await query(`SELECT id FROM categories WHERE parent_id IS NULL AND name = 'Apparel & Accessories'`, []))
        .toHaveLength(1)
      // The subtree is hung under the merchant's row, keeping their handle.
      const clothing = await byName('Clothing')
      expect(clothing?.parent_id).toBe(id)
      expect((await byName('Apparel & Accessories'))?.handle).toBe('my-apparel')
    })

    it('builds beside an archived category rather than under it', async () => {
      // An archived category still owns its handle but is not somewhere a new
      // subtree should be hung — the merchant put it away on purpose.
      const id = uuidv7()
      await execute(
        `INSERT INTO categories (id, parent_id, name, handle, position, archived_at)
         VALUES ($1, NULL, 'Apparel & Accessories', 'apparel-accessories', 0, now())`,
        [id],
      )

      await applyCategorySeed(fixture(), all)

      const fresh = await queryOne<{ id: string; handle: string }>(
        `SELECT id, handle FROM categories WHERE name = 'Apparel & Accessories' AND archived_at IS NULL`,
        [],
      )
      expect(fresh).toBeDefined()
      expect(fresh?.id).not.toBe(id)
      // The archived row keeps the handle it holds, so the new one takes another.
      expect(fresh?.handle).not.toBe('apparel-accessories')
    })
  })

  // ── The real file ─────────────────────────────────────────────────────────

  describe('the vendored Shopify taxonomy', () => {
    it('seeds 1,792 categories as one connected tree', async () => {
      const result = await applyCategorySeed(shopify)

      expect(result.inserted).toBe(1792)

      const written = await rows()
      const ids = new Set(written.map((row) => row.id))
      const orphans = written.filter((row) => row.parent_id && !ids.has(row.parent_id))

      expect(orphans).toEqual([])
      expect(written.filter((row) => row.parent_id === null)).toHaveLength(20)
      expect(new Set(written.map((row) => row.handle)).size).toBe(written.length)
    })

    it('is idempotent over the whole taxonomy', async () => {
      await applyCategorySeed(shopify)

      const again = await applyCategorySeed(shopify)

      expect(again.inserted).toBe(0)
      expect(again.matched).toBe(1792)
    })

    it('reaches every planned category — none is dropped for want of a parent', async () => {
      const planned = planCategories(shopify)
      const result = await applyCategorySeed(shopify)

      expect(result.pending).toHaveLength(planned.length)
    })

    it('adds the held-back verticals when asked, and only those', async () => {
      await applyCategorySeed(shopify)
      const before = (await readStore()).total

      const everything = await applyCategorySeed(shopify, all)

      expect(everything.matched).toBe(1792)
      expect(everything.inserted).toBeGreaterThan(0)
      expect((await readStore()).total).toBe(before + everything.inserted)
      expect(await byName('Mature')).toBeDefined()
    })

    it('stays within the depth the taxonomy service allows', async () => {
      await applyCategorySeed(shopify)

      // MAX_DEPTH in taxonomy.service.ts is 5. A seeded leaf must still accept
      // a child, or the merchant meets a wall the seed built.
      const deepest = await queryOne<{ depth: number }>(
        `WITH RECURSIVE tree AS (
           SELECT id, 1 AS depth FROM categories WHERE parent_id IS NULL
           UNION ALL
           SELECT c.id, tree.depth + 1 FROM categories c JOIN tree ON c.parent_id = tree.id
         )
         SELECT max(depth)::int AS depth FROM tree`,
        [],
      )

      expect(deepest?.depth).toBe(3)
    })
  })

  describe('keyFor', () => {
    it('is case- and space-insensitive, so a tidied name still matches', () => {
      expect(keyFor(null, ' Dresses ')).toBe(keyFor(null, 'dresses'))
      expect(keyFor('p1', 'Dresses')).not.toBe(keyFor('p2', 'Dresses'))
      expect(keyFor(null, 'Dresses')).not.toBe(keyFor('p1', 'Dresses'))
    })
  })
})
