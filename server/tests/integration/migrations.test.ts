import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPool } from '../../src/infrastructure/database/pool.js'
import {
  MigrationDriftError,
  MigrationFolderError,
  getStatus,
  loadFolder,
  loadMigrationFiles,
  migrateUp,
  splitStatements,
  validateFolder,
  type MigrationFile,
} from '../../src/infrastructure/database/migrate/runner.js'
import { describeIfDatabase, setupDatabase, teardownDatabase } from '../setup/database.js'

describeIfDatabase('migration runner', () => {
  beforeAll(setupDatabase)
  afterAll(teardownDatabase)

  it('applies every migration and reports nothing pending', async () => {
    const status = await getStatus(getPool())
    expect(status.pending).toHaveLength(0)
    expect(status.drifted).toHaveLength(0)
    expect(status.applied.length).toBeGreaterThanOrEqual(3)
  })

  it('is idempotent — running again applies nothing', async () => {
    const result = await migrateUp(getPool())
    expect(result.alreadyUpToDate).toBe(true)
    expect(result.applied).toHaveLength(0)
  })

  it('refuses to continue when an applied migration changed on disk', async () => {
    const files = await loadMigrationFiles()
    const first = files[0]!

    // Simulate an edit to an already-applied migration.
    await getPool().query('UPDATE schema_migrations SET checksum = $2 WHERE name = $1', [
      first.name,
      'tampered-checksum',
    ])

    await expect(migrateUp(getPool())).rejects.toThrow(MigrationDriftError)

    await getPool().query('UPDATE schema_migrations SET checksum = $2 WHERE name = $1', [
      first.name,
      first.checksum,
    ])
  })

  it('accepts a checksum a file declares it supersedes, and adopts it', async () => {
    const files = await loadMigrationFiles()
    const corrected = files.find((file) => file.supersedes.length > 0)
    // Not a fixture: if no file has ever been corrected there is nothing here
    // to prove, and the day one is, this starts covering it.
    if (!corrected) return

    const old = corrected.supersedes[0]!
    await getPool().query('UPDATE schema_migrations SET checksum = $2 WHERE name = $1', [
      corrected.name,
      old,
    ])

    const status = await getStatus(getPool())
    expect(status.drifted).toHaveLength(0)
    expect(status.superseded.map((entry) => entry.name)).toContain(corrected.name)

    // Running adopts it, so the acceptance is recorded once rather than warned
    // about forever.
    await migrateUp(getPool())
    const { rows } = await getPool().query<{ checksum: string }>(
      'SELECT checksum FROM schema_migrations WHERE name = $1',
      [corrected.name],
    )
    expect(rows[0]?.checksum).toBe(corrected.checksum)
  })

  it('leaves every no-transaction migration safe to re-run', async () => {
    // These files commit statement by statement, so a failure part-way leaves
    // the earlier statements applied and the migration unrecorded. Running the
    // whole file again is then the *only* way forward, and it has to work —
    // otherwise the database is wedged: the file can neither finish nor be
    // skipped. This is the regression that produced `constraint … already
    // exists` on a second `db:migrate`.
    const files = await loadMigrationFiles()
    const outsideTransaction = files.filter((file) => !file.useTransaction)
    expect(outsideTransaction.length).toBeGreaterThan(0)

    for (const file of outsideTransaction) {
      for (const statement of splitStatements(file.sql)) {
        await getPool().query(statement)
      }
    }
  })

  it('numbers migrations uniquely and in order', async () => {
    const files = await loadMigrationFiles()
    const numbers = files.map((f) => f.name.slice(0, 4))
    expect(new Set(numbers).size).toBe(numbers.length)
    expect([...numbers].sort()).toEqual(numbers)
  })

  it('created the tables the foundation depends on', async () => {
    const { rows } = await getPool().query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`,
    )
    const names = rows.map((r) => r.table_name)
    expect(names).toEqual(
      expect.arrayContaining([
        'domain_events',
        'email_messages',
        'email_suppressions',
        'idempotency_keys',
        'schema_migrations',
      ]),
    )
  })

  it('enforces the outbox constraints in the database, not only in code', async () => {
    await expect(
      getPool().query(
        `INSERT INTO domain_events (event_id, name, aggregate_type, payload, attempts)
         VALUES (gen_random_uuid(), 'x.y', 'x', '{}', -1)`,
      ),
    ).rejects.toThrow()
  })
})

/**
 * Folder validation.
 *
 * Pure, so it needs no database: the point is that a stray copy is refused
 * before a single statement runs. An archive unpacked over an existing folder
 * is where these come from, and the old runner turned each one into an extra
 * migration that replayed DDL.
 */
describe('migration folder validation', () => {
  const file = (name: string, checksum = name): MigrationFile => ({
    name,
    checksum,
    sql: '',
    useTransaction: true,
    supersedes: [],
    ignored: false,
  })

  it('accepts a clean folder', () => {
    expect(() =>
      validateFolder([file('0001_first.sql'), file('0002_second_thing.sql')]),
    ).not.toThrow()
  })

  it('refuses a copy left by unzipping over the folder', () => {
    expect(() =>
      validateFolder([file('0001_first.sql'), file('0001_first (1).sql')]),
    ).toThrow(MigrationFolderError)
  })

  it('refuses two files sharing a number', () => {
    expect(() => validateFolder([file('0001_first.sql'), file('0001_other.sql')])).toThrow(
      /share the number 0001/,
    )
  })

  it('refuses two files with identical contents under different names', () => {
    expect(() =>
      validateFolder([file('0001_first.sql', 'same'), file('0002_copy.sql', 'same')]),
    ).toThrow(/byte-for-byte identical/)
  })

  it('refuses anything that is not a migration', () => {
    expect(() => validateFolder([file('backup.sql')])).toThrow(/not named NNNN_lower_snake.sql/)
  })

  it('lets a file that cannot be deleted declare itself out of the set', async () => {
    // The escape hatch for a leftover from a numbering that was reworked, in a
    // checkout nobody can clean up remotely. It is excluded before the
    // duplicate-number check, so it stops colliding with the file that replaced
    // it — and `status` still lists it, so it is never invisible.
    const folder = await mkdtemp(path.join(tmpdir(), 'migrations-'))
    await writeFile(path.join(folder, '0001_real.sql'), 'SELECT 1;\n')
    await writeFile(
      path.join(folder, '0001_leftover.sql'),
      '-- migrate:ignore\n-- Superseded draft. Safe to delete.\n',
    )

    const { migrations, ignored } = await loadFolder(folder)
    expect(migrations.map((entry) => entry.name)).toEqual(['0001_real.sql'])
    expect(ignored).toEqual(['0001_leftover.sql'])

    await rm(folder, { recursive: true })
  })
})
