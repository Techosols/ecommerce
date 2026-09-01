#!/usr/bin/env node
/**
 * Migration CLI (§4.4).
 *
 *   npm run db:migrate            apply all pending migrations
 *   npm run db:migrate:status     show applied / pending / drifted
 *   npm run db:migrate:create x   scaffold migrations/NNNN_x.sql
 *   npm run db:reset              drop and rebuild (test/dev databases only)
 *
 * Always uses the DIRECT connection: migrations need session-level features
 * that a transaction pooler cannot provide (§4.2).
 */
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { closePool, initPool } from '../pool.js'
import {
  MIGRATIONS_DIR,
  MigrationDriftError,
  MigrationFolderError,
  getStatus,
  loadMigrationFiles,
  migrateUp,
  resetDatabase,
} from './runner.js'

type Command = 'up' | 'status' | 'create' | 'reset'

async function nextMigrationName(slug: string): Promise<string> {
  const files = await loadMigrationFiles()
  const last = files.at(-1)
  const lastNumber = last ? Number.parseInt(last.name.slice(0, 4), 10) : 0
  const next = String(lastNumber + 1).padStart(4, '0')
  const safeSlug = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
  return `${next}_${safeSlug}.sql`
}

async function main(): Promise<number> {
  const command = (process.argv[2] ?? 'up') as Command

  if (command === 'create') {
    const slug = process.argv[3]
    if (!slug) {
      console.error('Usage: npm run db:migrate:create -- <name>')
      return 1
    }
    const name = await nextMigrationName(slug)
    const file = path.join(MIGRATIONS_DIR, name)
    await writeFile(
      file,
      `-- ${name}\n-- Forward-only. Never edit a migration that has been applied (§4.4).\n\n`,
      { flag: 'wx' },
    )
    console.log(`Created migrations/${name}`)
    return 0
  }

  const pool = initPool('cli')

  try {
    switch (command) {
      case 'status': {
        const status = await getStatus(pool)
        console.log(`\nApplied (${status.applied.length}):`)
        for (const m of status.applied) {
          console.log(`  ✓ ${m.name}  ${m.appliedAt.toISOString()}`)
        }
        console.log(`\nPending (${status.pending.length}):`)
        for (const m of status.pending) console.log(`  · ${m.name}`)
        if (status.ignored.length > 0) {
          console.log(`\nIgnored (not migrations — safe to delete):`)
          for (const name of status.ignored) console.log(`  ⊘ ${name}`)
        }
        if (status.superseded.length > 0) {
          console.log(`\nCorrected since they ran here (accepted, adopted on the next up):`)
          for (const m of status.superseded) console.log(`  ~ ${m.name}`)
        }
        if (status.drifted.length > 0) {
          console.error(`\nDRIFT — these applied migrations changed on disk:`)
          for (const d of status.drifted) console.error(`  ! ${d.name}`)
          return 1
        }
        console.log('')
        return 0
      }

      case 'reset': {
        const result = await resetDatabase(pool)
        console.log(`Database reset; applied ${result.applied.length} migration(s).`)
        return 0
      }

      case 'up':
      default: {
        const result = await migrateUp(pool)
        if (result.alreadyUpToDate) {
          console.log('Database is up to date.')
        } else {
          console.log(`Applied ${result.applied.length} migration(s):`)
          for (const name of result.applied) console.log(`  ✓ ${name}`)
        }
        return 0
      }
    }
  } catch (error) {
    if (error instanceof MigrationDriftError || error instanceof MigrationFolderError) {
      console.error(`\n${error.message}\n`)
    } else {
      console.error('\nMigration failed:', error instanceof Error ? error.message : error, '\n')
    }
    return 1
  } finally {
    await closePool()
  }
}

process.exitCode = await main()
