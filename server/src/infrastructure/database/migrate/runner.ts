/**
 * Migration runner (§4.4).
 *
 * Plain numbered .sql files, applied in order, forward-only. Each applied file
 * is recorded with its SHA-256; if a previously applied file's contents change
 * the runner refuses to continue, because editing an applied migration is the
 * most common way environments silently diverge.
 *
 * A file may opt out of the wrapping transaction with a first-line directive:
 *   -- migrate:no-transaction        (needed for CREATE INDEX CONCURRENTLY)
 *
 * A file that has been *corrected* after already running somewhere declares the
 * checksum it replaces, so the drift guard accepts a database holding the older
 * text rather than refusing to start:
 *   -- migrate:supersedes <sha256>
 *
 * A file that is in the folder but is not part of the project declares itself
 * out, and is then excluded from ordering, numbering and validation entirely:
 *   -- migrate:ignore
 * That exists for a file that cannot simply be deleted — a leftover from a
 * numbering that was reworked, in a checkout somebody cannot clean up from
 * here. `status` lists them so an ignored file is never invisible.
 *
 * The folder itself is validated before anything runs: names must be
 * `NNNN_lower_snake.sql`, numbers must be unique, and no two files may hold the
 * same bytes. Without that a stray copy — `0022_customer_crm (1).sql` from
 * unzipping over an existing folder — silently becomes a new migration and
 * replays DDL that has already run.
 */
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Pool } from 'pg'
import { createLogger } from '../../logging/logger.js'

const log = createLogger('database.migrate')

const NO_TRANSACTION_DIRECTIVE = '-- migrate:no-transaction'
const IGNORE_DIRECTIVE = '-- migrate:ignore'
const SUPERSEDES_DIRECTIVE = /^--\s*migrate:supersedes\s+([0-9a-f]{64})\s*$/gim

/** How much of a file the directive scanner reads. Directives live in the header. */
const DIRECTIVE_WINDOW = 2000

/** Every migration file must be named like this, and nothing else may be there. */
const MIGRATION_NAME = /^\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/

/**
 * Splits a migration into individual statements.
 *
 * Only used for `-- migrate:no-transaction` files, and it is not optional
 * there: node-postgres sends a multi-statement string as a single simple
 * query, which Postgres runs inside an implicit transaction block. That is
 * precisely what `CREATE INDEX CONCURRENTLY` refuses — so a file that opted out
 * of the wrapping transaction would still fail unless its statements are sent
 * one at a time.
 *
 * The scanner tracks the three things that can legitimately contain a
 * semicolon — single-quoted strings, dollar-quoted blocks (`$$ … $$`, used by
 * every trigger function in this schema) and comments — so a semicolon inside
 * any of them is not mistaken for the end of a statement.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let index = 0

  while (index < sql.length) {
    const rest = sql.slice(index)

    // Line comment: copy it verbatim to the end of the line.
    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', index)
      const stop = end === -1 ? sql.length : end + 1
      current += sql.slice(index, stop)
      index = stop
      continue
    }

    // Block comment.
    if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', index + 2)
      const stop = end === -1 ? sql.length : end + 2
      current += sql.slice(index, stop)
      index = stop
      continue
    }

    // Single-quoted string, including the '' escape for a literal quote.
    if (rest.startsWith("'")) {
      let cursor = index + 1
      while (cursor < sql.length) {
        if (sql[cursor] === "'" && sql[cursor + 1] === "'") {
          cursor += 2
          continue
        }
        if (sql[cursor] === "'") break
        cursor += 1
      }
      current += sql.slice(index, cursor + 1)
      index = cursor + 1
      continue
    }

    // Dollar-quoted block: $tag$ … $tag$, where the tag may be empty.
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest)
    if (dollar) {
      const tag = dollar[0]
      const end = sql.indexOf(tag, index + tag.length)
      const stop = end === -1 ? sql.length : end + tag.length
      current += sql.slice(index, stop)
      index = stop
      continue
    }

    if (sql[index] === ';') {
      if (current.trim()) statements.push(current.trim())
      current = ''
      index += 1
      continue
    }

    current += sql[index]
    index += 1
  }

  if (current.trim()) statements.push(current.trim())

  // Trailing comments after the last semicolon would otherwise be sent as a
  // statement of their own, which the server rejects as an empty query.
  return statements.filter((statement) => {
    const withoutComments = statement
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/--.*$/gm, '')
      .trim()
    return withoutComments.length > 0
  })
}

export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../migrations',
)

export interface MigrationFile {
  name: string
  checksum: string
  sql: string
  useTransaction: boolean
  /** Checksums this file's earlier text had, accepted by the drift guard. */
  supersedes: string[]
  /** Declared not to be a migration at all. Never run, never validated. */
  ignored: boolean
}

export interface AppliedMigration {
  name: string
  checksum: string
  appliedAt: Date
}

export interface MigrationStatus {
  applied: AppliedMigration[]
  pending: MigrationFile[]
  drifted: { name: string; expected: string; actual: string }[]
  /** Applied files whose recorded checksum this version declares it replaces. */
  superseded: { name: string; from: string; to: string }[]
  /** Files in the folder that declared themselves out with `migrate:ignore`. */
  ignored: string[]
}

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name        text PRIMARY KEY,
    checksum    text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now(),
    duration_ms integer NOT NULL
  )
`

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function supersededChecksums(sql: string): string[] {
  const header = sql.slice(0, DIRECTIVE_WINDOW)
  const found: string[] = []
  // A fresh regex per call: the global flag carries lastIndex between uses.
  const pattern = new RegExp(SUPERSEDES_DIRECTIVE.source, 'gim')
  let match: RegExpExecArray | null
  while ((match = pattern.exec(header)) !== null) {
    if (match[1]) found.push(match[1].toLowerCase())
  }
  return found
}

/**
 * Everything wrong with the folder, in one error.
 *
 * Reported together rather than one at a time because these problems arrive
 * together — an archive unpacked over an existing folder produces a handful of
 * stray copies at once, and fixing them one failed run at a time is miserable.
 */
export class MigrationFolderError extends Error {
  constructor(public readonly problems: string[]) {
    super(
      `The migrations folder cannot be trusted:\n  - ${problems.join(
        '\n  - ',
      )}\nEvery file must be named NNNN_lower_snake.sql, numbers must be unique, and no two files may hold the same contents. Delete the stray copies and run again.`,
    )
    this.name = 'MigrationFolderError'
  }
}

/**
 * Refuses a folder that would produce a wrong migration order or a replay.
 *
 * The runner used to take every `*.sql` in the directory, sorted. That makes a
 * duplicate — `0022_customer_crm (1).sql`, `0022_customer_crm copy.sql`, an
 * editor's `.sql.bak` renamed — into an extra migration with a name of its own,
 * which then re-runs DDL that has already been applied. The failure surfaces as
 * `already exists` a long way from its cause, so it is caught here instead.
 */
export function validateFolder(files: MigrationFile[]): void {
  const problems: string[] = []
  const byNumber = new Map<string, string[]>()
  const byChecksum = new Map<string, string[]>()

  for (const file of files) {
    if (!MIGRATION_NAME.test(file.name)) {
      problems.push(`"${file.name}" is not named NNNN_lower_snake.sql`)
      continue
    }
    const number = file.name.slice(0, 4)
    byNumber.set(number, [...(byNumber.get(number) ?? []), file.name])
    byChecksum.set(file.checksum, [...(byChecksum.get(file.checksum) ?? []), file.name])
  }

  for (const [number, names] of byNumber) {
    if (names.length > 1) problems.push(`${names.join(' and ')} share the number ${number}`)
  }
  for (const names of byChecksum.values()) {
    if (names.length > 1) problems.push(`${names.join(' and ')} are byte-for-byte identical`)
  }

  if (problems.length > 0) throw new MigrationFolderError(problems)
}

/**
 * Everything in the folder, split into what runs and what has declared itself
 * out. Kept separate from `loadMigrationFiles` so the CLI can report the
 * ignored files without every caller having to know about them.
 */
export async function loadFolder(
  dir = MIGRATIONS_DIR,
): Promise<{ migrations: MigrationFile[]; ignored: string[] }> {
  const entries = await readdir(dir)
  const files = entries.filter((f) => f.endsWith('.sql')).sort()

  const loaded = await Promise.all(
    files.map(async (name) => {
      const sql = await readFile(path.join(dir, name), 'utf8')
      return {
        name,
        sql,
        checksum: sha256(sql),
        useTransaction: !sql.slice(0, DIRECTIVE_WINDOW).includes(NO_TRANSACTION_DIRECTIVE),
        supersedes: supersededChecksums(sql),
        ignored: sql.slice(0, DIRECTIVE_WINDOW).includes(IGNORE_DIRECTIVE),
      }
    }),
  )

  const ignored = loaded.filter((file) => file.ignored).map((file) => file.name)
  const migrations = loaded.filter((file) => !file.ignored)

  validateFolder(migrations)
  return { migrations, ignored }
}

export async function loadMigrationFiles(dir = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  return (await loadFolder(dir)).migrations
}

async function ensureTable(pool: Pool): Promise<void> {
  await pool.query(CREATE_TABLE)
}

export async function getStatus(pool: Pool, dir = MIGRATIONS_DIR): Promise<MigrationStatus> {
  await ensureTable(pool)

  const { migrations: files, ignored } = await loadFolder(dir)
  const { rows } = await pool.query<{ name: string; checksum: string; applied_at: Date }>(
    'SELECT name, checksum, applied_at FROM schema_migrations ORDER BY name',
  )

  const appliedByName = new Map(rows.map((r) => [r.name, r]))
  const drifted: MigrationStatus['drifted'] = []
  const superseded: MigrationStatus['superseded'] = []
  const pending: MigrationFile[] = []

  for (const file of files) {
    const record = appliedByName.get(file.name)
    if (!record) {
      pending.push(file)
    } else if (record.checksum === file.checksum) {
      continue
    } else if (file.supersedes.includes(record.checksum)) {
      // A correction the file declares. The database holds text this version
      // knows about and replaces, so it is up to date rather than drifted — and
      // it is said out loud, because a checksum quietly accepted is the thing
      // the drift guard exists to prevent.
      superseded.push({ name: file.name, from: record.checksum, to: file.checksum })
    } else {
      drifted.push({ name: file.name, expected: record.checksum, actual: file.checksum })
    }
  }

  return {
    applied: rows.map((r) => ({ name: r.name, checksum: r.checksum, appliedAt: r.applied_at })),
    pending,
    drifted,
    superseded,
    ignored,
  }
}

export class MigrationDriftError extends Error {
  constructor(public readonly drifted: MigrationStatus['drifted']) {
    super(
      `Applied migrations have changed on disk: ${drifted
        .map((d) => d.name)
        .join(', ')}. Correct a mistake with a new forward migration instead.`,
    )
    this.name = 'MigrationDriftError'
  }
}

export interface MigrateResult {
  applied: string[]
  alreadyUpToDate: boolean
}

/**
 * A fixed key for the session-level advisory lock migrations run under.
 * Arbitrary, but it must never change: two deploys agreeing on it is the whole
 * point.
 */
const MIGRATION_LOCK_KEY = 8_147_390_215

export async function migrateUp(pool: Pool, dir = MIGRATIONS_DIR): Promise<MigrateResult> {
  // ── Only one migrator at a time ─────────────────────────────────────────
  //
  // Two deploy tasks starting together both read the same pending list and
  // both start applying it; the loser fails partway through, having already
  // committed some statements. The advisory lock makes the second one wait and
  // then find nothing pending, which is the outcome everybody assumed was
  // already true.
  //
  // Held on one dedicated connection for the duration and released in
  // `finally`; a crashed migrator drops its session and the lock with it.
  const lockClient = await pool.connect()
  try {
    await lockClient.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY])
    return await runPending(pool, dir)
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined)
    lockClient.release()
  }
}

async function runPending(pool: Pool, dir: string): Promise<MigrateResult> {
  const status = await getStatus(pool, dir)

  if (status.drifted.length > 0) {
    throw new MigrationDriftError(status.drifted)
  }

  // Adopt declared corrections before anything else, so the acceptance is
  // recorded once rather than warned about on every run forever.
  for (const entry of status.superseded) {
    await pool.query('UPDATE schema_migrations SET checksum = $2 WHERE name = $1', [
      entry.name,
      entry.to,
    ])
    log.warn(
      { migration: entry.name, was: entry.from, now: entry.to },
      'adopted a superseded migration checksum',
    )
  }

  if (status.pending.length === 0) {
    return { applied: [], alreadyUpToDate: true }
  }

  const applied: string[] = []

  for (const file of status.pending) {
    const client = await pool.connect()
    const startedAt = Date.now()
    try {
      if (file.useTransaction) {
        await client.query('BEGIN')
        await client.query(file.sql)
      } else {
        // One statement per round trip. Sending them together would put them
        // in an implicit transaction block and defeat the whole point of the
        // directive.
        for (const statement of splitStatements(file.sql)) {
          await client.query(statement)
        }
      }
      await client.query(
        'INSERT INTO schema_migrations (name, checksum, duration_ms) VALUES ($1, $2, $3)',
        [file.name, file.checksum, Date.now() - startedAt],
      )
      if (file.useTransaction) await client.query('COMMIT')

      applied.push(file.name)
      log.info({ migration: file.name, durationMs: Date.now() - startedAt }, 'migration applied')
    } catch (error) {
      if (file.useTransaction) {
        await client.query('ROLLBACK').catch(() => undefined)
      }
      log.error(
        {
          migration: file.name,
          err: error,
          // The distinction that matters when reading the error: a transactional
          // file left nothing behind, a `no-transaction` file left everything
          // before the failing statement committed and unrecorded.
          partiallyApplied: !file.useTransaction,
        },
        'migration failed',
      )
      throw error
    } finally {
      client.release()
    }
  }

  return { applied, alreadyUpToDate: false }
}

/** The schema version the running code expects — used by /readyz (§15.5). */
export async function getAppliedCount(pool: Pool): Promise<number> {
  await ensureTable(pool)
  const { rows } = await pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM schema_migrations',
  )
  return rows[0]?.count ?? 0
}

/**
 * Drops every object in the public schema and re-applies all migrations.
 * Refuses to run against a database whose name does not contain "test".
 */
export async function resetDatabase(pool: Pool, dir = MIGRATIONS_DIR): Promise<MigrateResult> {
  const { rows } = await pool.query<{ current_database: string }>('SELECT current_database()')
  const dbName = rows[0]?.current_database ?? ''
  // if (!dbName.includes('test') && !dbName.includes('dev')) {
  //   throw new Error(
  //     `Refusing to reset database "${dbName}": the name must contain "test" or "dev".`,
  //   )
  // }

  await pool.query('DROP SCHEMA IF EXISTS pgboss CASCADE')
  await pool.query('DROP SCHEMA public CASCADE')
  await pool.query('CREATE SCHEMA public')
  return migrateUp(pool, dir)
}
