/**
 * Turning Shopify's published taxonomy into categories this store can hold.
 *
 * Kept apart from the seeding itself, and pure, so the decisions that are easy
 * to get quietly wrong — which verticals are skipped, what handle a node ends
 * up with, what happens when two nodes want the same one — can be tested
 * without a database.
 *
 * ── Why these are not seeded by a migration ──────────────────────────────────
 *
 * Roles and permissions live in migration `0004` because they are *reference
 * data*: the application's own vocabulary, the same in every installation, and
 * meaningless to edit. A category tree is the opposite. It is the merchant's,
 * they will rename and prune it the week they open, and a migration that
 * inserted 1,863 rows into their catalogue would be an opinion the schema has
 * no business holding. So this is a script they run if they want it.
 */

/** A node exactly as `scripts/data/shopify-taxonomy.json` carries it. */
export interface TaxonomyNode {
  /** Shopify's own id, e.g. `ap-2-1`. The parent id is its prefix. */
  id: string
  parent: string | null
  name: string
  /** Order among siblings, taken from the published file. */
  position: number
}

export interface TaxonomyFile {
  source: string
  version: string
  url: string
  retrievedAt: string
  maxDepth: number
  note: string
  categories: TaxonomyNode[]
}

/** A node resolved into something `categories` can hold. */
export interface PlannedCategory {
  id: string
  parent: string | null
  name: string
  handle: string
  position: number
  /** Root-first, e.g. `['Apparel & Accessories', 'Clothing', 'Dresses']`. */
  path: string[]
}

/**
 * Verticals that are Shopify platform concepts rather than kinds of product.
 *
 * `Gift Cards` and `Bundles` are features this platform models elsewhere —
 * as products of a kind and as their own future feature — and `Uncategorized`
 * is Shopify's way of writing null. Seeding them as categories invites staff to
 * file a real product under a non-thing, which is worse than the category
 * being absent.
 */
export const HOUSEKEEPING_VERTICALS = [
  'Uncategorized',
  'Bundles',
  'Gift Cards',
  'Product Add-Ons',
] as const

/**
 * Verticals most stores do not sell and would rather not explain.
 *
 * Skipped by default and restored with a flag, because adding one vertical
 * back is a smaller job than pruning a tree somebody has already filed
 * products into.
 */
export const OPTIONAL_VERTICALS = ['Mature', 'Services'] as const

export const DEFAULT_EXCLUDED_VERTICALS: readonly string[] = [
  ...HOUSEKEEPING_VERTICALS,
  ...OPTIONAL_VERTICALS,
]

/**
 * Turns a name into a candidate handle.
 *
 * Deliberately the same rules as `slugify` in `src/features/catalogue/
 * handles.ts` — a seeded category must be addressable exactly like one a
 * person typed. It is duplicated rather than imported because this script must
 * run without loading the application, and the alternative is a scripts
 * directory that pulls in the database pool to slug a string.
 *
 * If that function changes, change this one; `taxonomy.seed.test.ts` asserts
 * the two agree.
 */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
    .replace(/-+$/g, '')
}

/**
 * The handles a node will accept, in order of preference.
 *
 * Most categories can simply be `dresses`. The ladder exists for the few that
 * cannot: `Grinders` appears under both `Kitchen Tools` and `Smoking
 * Accessories`, and the second one to ask gets `smoking-accessories-grinders`
 * rather than a number bolted onto the end. An address a person can read is
 * worth the extra step.
 */
export function handleCandidates(path: string[], id: string): string[] {
  const name = slugify(path[path.length - 1] ?? '')
  const ladder = [
    name,
    slugify(path.slice(-2).join(' ')),
    slugify(path.join(' ')),
    // Shopify's id is stable and unique, so this rung can never fail. It is
    // ugly on purpose: reaching it means three readable options were taken.
    `${name}-${id}`,
  ]
  return ladder.filter((candidate, index) => candidate.length > 0 && ladder.indexOf(candidate) === index)
}

export interface PlanOptions {
  /** Vertical names to leave out. Defaults to the housekeeping and optional sets. */
  excludeVerticals?: readonly string[]
  /** Handles already spoken for — in practice, what the store already has. */
  taken?: Iterable<string>
  /** Levels to keep. The file holds three; a smaller number trims it further. */
  maxDepth?: number
}

/**
 * Works out exactly what would be inserted, and in what order.
 *
 * Returns parents before children — not as a convenience but as a
 * requirement, since `categories.parent_id` references the same table and a
 * child inserted first has nothing to point at.
 *
 * Nothing here touches a database, so the plan can be printed, diffed, or
 * asserted on in a test before anybody writes a row.
 */
export function planCategories(file: TaxonomyFile, options: PlanOptions = {}): PlannedCategory[] {
  const excluded = new Set(options.excludeVerticals ?? DEFAULT_EXCLUDED_VERTICALS)
  const maxDepth = options.maxDepth ?? file.maxDepth
  const taken = new Set(options.taken ?? [])

  const byId = new Map(file.categories.map((node) => [node.id, node]))
  const pathOf = new Map<string, string[]>()

  const planned: PlannedCategory[] = []

  // Source order is already parents-first, and it is also the order the
  // published file lists siblings in, which is the order a shopper would
  // expect to read them in.
  for (const node of file.categories) {
    const parentPath = node.parent ? pathOf.get(node.parent) : []
    // A node whose parent was excluded is excluded with it: a tree with a
    // hole in it is not a smaller tree, it is a broken one.
    if (parentPath === undefined) continue

    const path = [...parentPath, node.name]
    if (excluded.has(path[0] as string)) continue
    if (path.length > maxDepth) continue
    if (node.parent && !byId.has(node.parent)) continue

    pathOf.set(node.id, path)

    const handle = handleCandidates(path, node.id).find((candidate) => !taken.has(candidate))
    // `handleCandidates` ends with an id-suffixed rung that cannot collide, so
    // this is unreachable — but a `!` here would be a lie about that.
    if (!handle) continue
    taken.add(handle)

    planned.push({
      id: node.id,
      parent: node.parent,
      name: node.name,
      handle,
      position: node.position,
      path,
    })
  }

  return planned
}

/** The verticals a plan covers, in order. For the summary a person reads. */
export function verticalsIn(planned: PlannedCategory[]): string[] {
  return [...new Set(planned.map((category) => category.path[0] as string))]
}
