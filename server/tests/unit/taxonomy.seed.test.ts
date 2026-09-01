/**
 * Planning the category seed (§4, docs/catalogue-model.md).
 *
 * The plan is pure, so this suite can hold down the decisions that would
 * otherwise only show up as a wrong tree in somebody's admin:
 *
 *   • **Parents come before children.** `categories.parent_id` points at the
 *     same table; a child inserted first has nothing to point at.
 *   • **An excluded vertical takes its subtree with it.** A tree with a hole
 *     in it is not a smaller tree.
 *   • **Handles stay readable.** `dresses`, not `dresses-2` and not a
 *     seventy-character path, except where two categories genuinely share a
 *     name and one of them has to give way.
 *   • **The store's existing handles are respected**, so seeding a shop that
 *     already sells dresses does not collide with the dresses it has.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EXCLUDED_VERTICALS,
  handleCandidates,
  planCategories,
  slugify,
  verticalsIn,
  type TaxonomyFile,
} from '../../scripts/lib/taxonomySeed.js'
import { slugify as appSlugify } from '../../src/features/catalogue/handles.js'

const here = dirname(fileURLToPath(import.meta.url))
const file = JSON.parse(
  await readFile(join(here, '..', '..', 'scripts', 'data', 'shopify-taxonomy.json'), 'utf8'),
) as TaxonomyFile

/** A small tree with the shapes that matter, rather than all 1,863. */
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
      { id: 'aa-2', parent: 'aa', name: 'Shoes', position: 1 },
      { id: 'hg', parent: null, name: 'Home & Garden', position: 1 },
      { id: 'hg-1', parent: 'hg', name: 'Kitchen', position: 0 },
      // The same leaf name under a different parent — the collision case.
      { id: 'hg-1-1', parent: 'hg-1', name: 'Dresses', position: 0 },
      { id: 'un', parent: null, name: 'Uncategorized', position: 2 },
      { id: 'un-1', parent: 'un', name: 'Whatever', position: 0 },
    ],
  }
}

// ── The words ───────────────────────────────────────────────────────────────

describe('slugify', () => {
  it('agrees with the application, so a seeded address is an ordinary one', () => {
    // The script cannot import the app — it must run without a database pool —
    // so the rules are written twice. This is the test that keeps them equal.
    for (const name of [
      'Dresses',
      'Food, Beverages & Tobacco',
      'Café Supplies',
      "Children's Clothing",
      'Arts & Entertainment',
      'Baby & Toddler',
      'Business & Industrial',
    ]) {
      expect(slugify(name)).toBe(appSlugify(name))
    }
  })
})

describe('handleCandidates', () => {
  it('prefers the plain name, and never repeats a rung', () => {
    expect(handleCandidates(['Apparel & Accessories', 'Clothing', 'Dresses'], 'aa-1-1')).toEqual([
      'dresses',
      'clothing-dresses',
      'apparel-accessories-clothing-dresses',
      'dresses-aa-1-1',
    ])
  })

  it('ends with a rung that cannot collide', () => {
    // Shopify's id is unique, so the ladder always terminates. Without this
    // the planner would have to drop a category it could not name.
    const ladder = handleCandidates(['A', 'B'], 'x-9')
    expect(ladder[ladder.length - 1]).toBe('b-x-9')
  })
})

// ── The plan ────────────────────────────────────────────────────────────────

describe('planCategories', () => {
  it('lists every parent before its children', () => {
    const planned = planCategories(fixture(), { excludeVerticals: [] })
    const seen = new Set<string>()

    for (const category of planned) {
      if (category.parent) expect(seen.has(category.parent)).toBe(true)
      seen.add(category.id)
    }
  })

  it('gives the first claimant the plain handle and disambiguates the second', () => {
    const planned = planCategories(fixture(), { excludeVerticals: [] })
    const handles = planned.filter((c) => c.name === 'Dresses').map((c) => c.handle)

    expect(handles).toEqual(['dresses', 'kitchen-dresses'])
  })

  it('takes a whole subtree out with its vertical', () => {
    const planned = planCategories(fixture(), { excludeVerticals: ['Uncategorized'] })

    // Not just the vertical: the child would otherwise be left pointing at a
    // parent that was never inserted.
    expect(planned.map((c) => c.id)).not.toContain('un')
    expect(planned.map((c) => c.id)).not.toContain('un-1')
  })

  it('yields to handles the store already has', () => {
    const planned = planCategories(fixture(), { excludeVerticals: [], taken: ['dresses'] })
    const first = planned.find((c) => c.id === 'aa-1-1')

    expect(first?.handle).toBe('clothing-dresses')
  })

  it('trims to a shallower tree on request', () => {
    const planned = planCategories(fixture(), { excludeVerticals: [], maxDepth: 2 })

    expect(planned.every((c) => c.path.length <= 2)).toBe(true)
    expect(planned.map((c) => c.name)).toContain('Clothing')
    expect(planned.map((c) => c.name)).not.toContain('Dresses')
  })

  it('keeps the published order of siblings', () => {
    const planned = planCategories(fixture(), { excludeVerticals: [] })
    const underApparel = planned.filter((c) => c.parent === 'aa')

    expect(underApparel.map((c) => [c.name, c.position])).toEqual([
      ['Clothing', 0],
      ['Shoes', 1],
    ])
  })
})

// ── The file that ships ─────────────────────────────────────────────────────

describe('the vendored taxonomy', () => {
  it('is the pinned release, three levels deep', () => {
    expect(file.source).toBe('Shopify Product Taxonomy')
    expect(file.version).toBe('2026-05')
    expect(file.maxDepth).toBe(3)
    expect(file.categories).toHaveLength(1863)
  })

  it('has no orphans — every parent named is a node in the file', () => {
    const ids = new Set(file.categories.map((node) => node.id))
    const orphans = file.categories.filter((node) => node.parent && !ids.has(node.parent))

    expect(orphans).toEqual([])
  })

  it('plans a tree of unique, usable handles', () => {
    const planned = planCategories(file)
    const handles = planned.map((c) => c.handle)

    expect(new Set(handles).size).toBe(handles.length)
    // The same rule `assertUsableHandle` applies to anything a person types.
    for (const handle of handles) {
      expect(handle).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      expect(handle.length).toBeLessThanOrEqual(120)
    }
  })

  it('fits inside the tree depth the service allows', () => {
    // `MAX_DEPTH` in taxonomy.service.ts is 5. Seeding something the admin
    // could not then add a child to would be a trap.
    expect(Math.max(...planCategories(file).map((c) => c.path.length))).toBeLessThanOrEqual(3)
  })

  it('leaves out the platform housekeeping by default', () => {
    const verticals = verticalsIn(planCategories(file))

    for (const excluded of DEFAULT_EXCLUDED_VERTICALS) {
      expect(verticals).not.toContain(excluded)
    }
    expect(verticals).toContain('Apparel & Accessories')
    expect(verticals).toHaveLength(20)
  })

  it('seeds all 26 verticals when asked for everything', () => {
    expect(verticalsIn(planCategories(file, { excludeVerticals: [] }))).toHaveLength(26)
  })
})
