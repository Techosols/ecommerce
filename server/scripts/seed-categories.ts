/**
 * Seeds the category tree from Shopify's published product taxonomy.
 *
 *   npm run db:seed:categories -- --dry-run     # print the plan, write nothing
 *   npm run db:seed:categories                  # 1,792 categories, 20 verticals
 *   npm run db:seed:categories -- --all         # all 26, Mature and Services too
 *   npm run db:seed:categories -- --depth 2     # verticals and their children
 *
 * The data is vendored at `scripts/data/shopify-taxonomy.json`, pinned to
 * release v2026-05 and trimmed to three levels. It is committed rather than
 * fetched so that seeding works offline, produces the same tree on every
 * machine, and shows up in a diff when somebody upgrades it.
 *
 * ── Why this is a script and not a migration ─────────────────────────────────
 *
 * Roles and permissions are seeded by migration `0004` because they are
 * reference data: the application's own vocabulary, identical everywhere,
 * meaningless to edit. A category tree is the opposite — it is the merchant's,
 * they will prune it the week they open, and a migration that put 1,792 rows
 * into their catalogue would be an opinion the schema has no business holding.
 *
 * Safe to re-run: it only adds what is missing, matching by name under parent,
 * and never renames, moves or archives anything that is already there.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { closePool, initPool } from '../src/infrastructure/database/pool.js'
import { applyCategorySeed } from './lib/applyCategorySeed.js'
import {
  DEFAULT_EXCLUDED_VERTICALS,
  verticalsIn,
  type PlannedCategory,
  type TaxonomyFile,
} from './lib/taxonomySeed.js'

const here = dirname(fileURLToPath(import.meta.url))

interface Options {
  all: boolean
  dryRun: boolean
  depth: number | undefined
}

function parseArgs(argv: string[]): Options | string {
  const options: Options = { all: false, dryRun: false, depth: undefined }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--all') options.all = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--depth') {
      const value = Number(argv[++index])
      if (!Number.isInteger(value) || value < 1 || value > 3) {
        return '--depth takes a whole number from 1 to 3 (the vendored file holds three levels)'
      }
      options.depth = value
    } else return `Unknown option ${arg}. Try --all, --depth <1-3> or --dry-run.`
  }

  return options
}

function describe(planned: PlannedCategory[]): string {
  const levels = planned.reduce<Record<number, number>>((counts, category) => {
    counts[category.path.length] = (counts[category.path.length] ?? 0) + 1
    return counts
  }, {})
  const breakdown = Object.entries(levels)
    .map(([depth, count]) => `${count} at level ${depth}`)
    .join(', ')
  return `${planned.length} categories across ${verticalsIn(planned).length} verticals (${breakdown})`
}

function preview(pending: { category: PlannedCategory }[]): void {
  for (const { category } of pending.slice(0, 40)) {
    const indent = '  '.repeat(category.path.length - 1)
    console.log(`  ${indent}${category.name}  (${category.handle})`)
  }
  if (pending.length > 40) console.log(`  … and ${pending.length - 40} more`)
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))
  if (typeof parsed === 'string') {
    console.error(`\n${parsed}\n`)
    return 1
  }

  const file = JSON.parse(
    await readFile(join(here, 'data', 'shopify-taxonomy.json'), 'utf8'),
  ) as TaxonomyFile

  initPool('cli')

  try {
    const result = await applyCategorySeed(file, {
      ...(parsed.all ? { excludeVerticals: [] } : {}),
      ...(parsed.depth === undefined ? {} : { maxDepth: parsed.depth }),
      ...(parsed.dryRun ? { dryRun: true } : {}),
    })

    console.log(`\n${file.source} ${file.version} — ${describe(result.planned)}`)
    if (!parsed.all) {
      console.log(`Skipping ${DEFAULT_EXCLUDED_VERTICALS.join(', ')}. Use --all to include them.`)
    }
    console.log(`The store currently holds ${result.storeTotalBefore} categories.\n`)

    if (result.pending.length === 0) {
      console.log('Everything in the plan is already there. Nothing to do.\n')
      return 0
    }

    if (parsed.dryRun) {
      preview(result.pending)
      console.log(`\nWould add ${result.pending.length} categories. Nothing was written.\n`)
      return 0
    }

    console.log(
      `Added ${result.inserted} categories.` +
        (result.matched > 0 ? ` ${result.matched} were already there and were left alone.` : ''),
    )
    console.log('Nothing existing was renamed, moved or archived.\n')
    return 0
  } catch (error) {
    console.error('\nSeeding categories failed:', error instanceof Error ? error.message : error)
    console.error('No categories were added.\n')
    return 1
  } finally {
    await closePool()
  }
}

process.exitCode = await main()
