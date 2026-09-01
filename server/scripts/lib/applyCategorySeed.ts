/**
 * Writing a planned taxonomy into the store's categories.
 *
 * Separate from the CLI so it can be tested against a real database, and
 * separate from `taxonomySeed.ts` so the planning stays pure. This is the half
 * where getting it wrong costs somebody their tree.
 *
 * ── Two rules, and the reasons ───────────────────────────────────────────────
 *
 * **Nothing existing is touched.** No renames, no moves, no archiving, no
 * repositioning. A merchant who pruned the tree last week must not find it
 * grown back after somebody re-runs the seed.
 *
 * **A node is matched by name under its parent**, never by handle. A handle is
 * an address the merchant may change; the name under a parent is what the
 * category *is*. Matching on handle would make a renamed `/dresses` sprout a
 * second `Dresses` on the next run.
 */
import { v7 as uuidv7 } from 'uuid'
import { query } from '../../src/infrastructure/database/query.js'
import { withTransaction } from '../../src/infrastructure/database/transaction.js'
import { planCategories, type PlanOptions, type PlannedCategory, type TaxonomyFile } from './taxonomySeed.js'

/** A category's identity for matching: its name, under its parent. */
export function keyFor(parentId: string | null, name: string): string {
  return `${parentId ?? 'root'} ${name.trim().toLowerCase()}`
}

export interface StoreCategories {
  /** Live categories, by `keyFor`. Archived ones are deliberately absent. */
  existing: Map<string, string>
  /** Every handle in the table, archived included — the column is unique. */
  handles: Set<string>
  total: number
}

/**
 * What the store already holds.
 *
 * Archived rows count for handles but not for matching: an archived
 * `Clothing` still owns `/clothing`, but it is not somewhere a new subtree
 * should be hung, so the seed creates a fresh one beside it rather than
 * grafting onto something the merchant has put away.
 */
export async function readStore(): Promise<StoreCategories> {
  const rows = await query<{
    id: string
    parent_id: string | null
    name: string
    handle: string
    archived_at: Date | null
  }>(`SELECT id, parent_id, name, handle, archived_at FROM categories`, [], {
    name: 'seed.readCategories',
  })

  const existing = new Map<string, string>()
  const handles = new Set<string>()
  for (const row of rows) {
    handles.add(row.handle.toLowerCase())
    if (!row.archived_at) existing.set(keyFor(row.parent_id, row.name), row.id)
  }

  return { existing, handles, total: rows.length }
}

export interface PendingCategory {
  id: string
  parentId: string | null
  category: PlannedCategory
}

/**
 * Resolves a plan against the store: what is already there, what is new.
 *
 * Returns the new rows in insertion order, parents first, each already
 * carrying the uuid it will be given — which is how a child three levels down
 * knows the id of a parent that does not exist yet.
 */
export function resolve(
  planned: PlannedCategory[],
  store: StoreCategories,
): { pending: PendingCategory[]; matched: number } {
  const idFor = new Map<string, string>()
  const pending: PendingCategory[] = []
  let matched = 0

  for (const category of planned) {
    const parentId = category.parent ? (idFor.get(category.parent) ?? null) : null
    // A node whose parent could not be placed is skipped rather than
    // reparented to the root, where it would read as a vertical it is not.
    if (category.parent && parentId === null) continue

    const already = store.existing.get(keyFor(parentId, category.name))
    if (already) {
      idFor.set(category.id, already)
      matched += 1
      continue
    }

    const id = uuidv7()
    idFor.set(category.id, id)
    pending.push({ id, parentId, category })
  }

  return { pending, matched }
}

export interface SeedResult {
  planned: PlannedCategory[]
  pending: PendingCategory[]
  /** Rows actually written. Zero on a dry run, or when nothing was missing. */
  inserted: number
  /** Planned categories that were already in the store. */
  matched: number
  storeTotalBefore: number
}

/**
 * Plans, resolves and — unless `dryRun` — writes.
 *
 * The insert is one transaction: a half-seeded tree is worse than no tree at
 * all, because the next run would match the fragments by name and build
 * around them.
 */
export async function applyCategorySeed(
  file: TaxonomyFile,
  options: PlanOptions & { dryRun?: boolean } = {},
): Promise<SeedResult> {
  const store = await readStore()
  const planned = planCategories(file, { ...options, taken: store.handles })
  const { pending, matched } = resolve(planned, store)

  if (options.dryRun || pending.length === 0) {
    return { planned, pending, inserted: 0, matched, storeTotalBefore: store.total }
  }

  await withTransaction(async () => {
    for (const { id, parentId, category } of pending) {
      await query(
        `INSERT INTO categories (id, parent_id, name, handle, position)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, parentId, category.name, category.handle, category.position],
        { name: 'seed.insertCategory' },
      )
    }
  })

  return {
    planned,
    pending,
    inserted: pending.length,
    matched,
    storeTotalBefore: store.total,
  }
}
