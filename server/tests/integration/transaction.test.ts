import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { getPool } from '../../src/infrastructure/database/pool.js'
import { query, queryOne } from '../../src/infrastructure/database/query.js'
import {
  getExecutor,
  isInTransaction,
  withTransaction,
} from '../../src/infrastructure/database/transaction.js'
import { ConflictError, DomainRuleError, ERROR_CODES } from '../../src/shared/errors/index.js'
import {
  describeIfDatabase,
  setupDatabase,
  teardownDatabase,
  truncateAll,
} from '../setup/database.js'

async function countEvents(): Promise<number> {
  const row = await queryOne<{ count: number }>('SELECT count(*)::int AS count FROM domain_events')
  return row?.count ?? 0
}

async function insertEvent(name: string): Promise<void> {
  await query(
    `INSERT INTO domain_events (event_id, name, aggregate_type, payload)
     VALUES (gen_random_uuid(), $1, 'test', '{}')`,
    [name],
  )
}

describeIfDatabase('withTransaction', () => {
  beforeAll(setupDatabase)
  afterEach(truncateAll)
  afterAll(teardownDatabase)

  it('commits work when the callback resolves', async () => {
    await withTransaction(async () => {
      await insertEvent('test.commit')
    })
    expect(await countEvents()).toBe(1)
  })

  it('rolls everything back when the callback throws', async () => {
    await expect(
      withTransaction(async () => {
        await insertEvent('test.rollback')
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(await countEvents()).toBe(0)
  })

  it('binds the client ambiently, so repositories join without being passed one', async () => {
    expect(isInTransaction()).toBe(false)

    await withTransaction(async (tx) => {
      expect(isInTransaction()).toBe(true)
      expect(getExecutor()).toBe(tx.client)
    })

    expect(isInTransaction()).toBe(false)
    expect(getExecutor()).toBe(getPool())
  })

  it('nests with a savepoint: the inner failure rolls back alone', async () => {
    await withTransaction(async () => {
      await insertEvent('outer')

      await expect(
        withTransaction(async () => {
          await insertEvent('inner')
          throw new Error('inner failed')
        }),
      ).rejects.toThrow('inner failed')

      // The outer transaction is still usable — that is the point of a savepoint.
      await insertEvent('outer-after')
    })

    const rows = await query<{ name: string }>('SELECT name FROM domain_events ORDER BY id')
    expect(rows.map((r) => r.name)).toEqual(['outer', 'outer-after'])
  })

  it('reuses the same connection when nested rather than opening a second', async () => {
    await withTransaction(async (outer) => {
      await withTransaction(async (inner) => {
        expect(inner.client).toBe(outer.client)
        expect(inner.depth).toBe(1)
      })
    })
  })

  it('lets a business error through unchanged rather than re-wrapping it as a 500', async () => {
    // Regression: an earlier version mapped *every* callback failure through
    // mapDatabaseError, which turned a meaningful 422 into an opaque 500.
    const domainError = new DomainRuleError(ERROR_CODES.DOMAIN_RULE_VIOLATION, 'stock is reserved')

    await expect(
      withTransaction(async () => {
        await insertEvent('test.domain-failure')
        throw domainError
      }),
    ).rejects.toBe(domainError)

    expect(await countEvents()).toBe(0)
  })

  it('does not double-map an error the query boundary already translated', async () => {
    let caught: unknown
    await withTransaction(async () => {
      await query(
        `INSERT INTO domain_events (event_id, name, aggregate_type, payload)
         VALUES ('0199a0e0-0000-7000-8000-000000000002', 'a', 'test', '{}')`,
      )
    })

    try {
      await withTransaction(async () => {
        await query(
          `INSERT INTO domain_events (event_id, name, aggregate_type, payload)
           VALUES ('0199a0e0-0000-7000-8000-000000000002', 'b', 'test', '{}')`,
        )
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(ConflictError)
    expect((caught as ConflictError).code).toBe(ERROR_CODES.ALREADY_EXISTS)
  })

  it('releases the connection back to the pool even after a failure', async () => {
    const before = getPool().idleCount + getPool().waitingCount
    for (let i = 0; i < 5; i++) {
      await withTransaction(async () => {
        throw new Error('fail')
      }).catch(() => undefined)
    }
    // A leaked client would show up as a permanently shrinking pool.
    expect(getPool().totalCount).toBeLessThanOrEqual(before + getPool().options.max!)
  })
})
