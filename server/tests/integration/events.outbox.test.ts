/**
 * The outbox guarantee (§12.1) — the most important behaviour in the
 * foundation, and the reason `domain_events` exists at all.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { queryOne, query } from '../../src/infrastructure/database/query.js'
import { withTransaction } from '../../src/infrastructure/database/transaction.js'
import { publish } from '../../src/events/publish.js'
import { dispatchBatch } from '../../src/events/dispatcher.js'
import { clearSubscribers, on, type EventEnvelope } from '../../src/events/subscribers/index.js'
import { EVENT_MAX_DISPATCH_ATTEMPTS } from '../../src/config/constants.js'
import {
  describeIfDatabase,
  setupDatabase,
  teardownDatabase,
  truncateAll,
} from '../setup/database.js'

async function eventRow(name: string) {
  return queryOne<{
    id: number
    dispatched_at: Date | null
    attempts: number
    last_error: string | null
  }>('SELECT id, dispatched_at, attempts, last_error FROM domain_events WHERE name = $1', [name])
}

describeIfDatabase('transactional outbox', () => {
  beforeAll(setupDatabase)
  beforeEach(clearSubscribers)
  afterEach(truncateAll)
  afterAll(teardownDatabase)

  it('writes the event inside the business transaction', async () => {
    await withTransaction(async () => {
      await publish('job.dead_lettered', { queue: 'email.send', jobId: 'j1', attempts: 1 })
    })
    const row = await eventRow('job.dead_lettered')
    expect(row).toBeDefined()
    expect(row?.dispatched_at).toBeNull()
  })

  it('loses the event when the transaction rolls back — no event for work that did not happen', async () => {
    await expect(
      withTransaction(async () => {
        await publish('job.dead_lettered', { queue: 'email.send', jobId: 'j2', attempts: 1 })
        throw new Error('business rule failed')
      }),
    ).rejects.toThrow()

    expect(await eventRow('job.dead_lettered')).toBeUndefined()
  })

  it('rejects a payload that does not match the registered schema', async () => {
    await expect(publish('job.dead_lettered', { queue: 'email.send' } as never)).rejects.toThrow()
  })

  it('dispatches a committed event to its subscribers exactly once', async () => {
    const handler = vi.fn<(event: EventEnvelope<'job.dead_lettered'>) => Promise<void>>(
      async () => undefined,
    )
    on('job.dead_lettered', [handler])

    await withTransaction(async () => {
      await publish('job.dead_lettered', { queue: 'email.send', jobId: 'j3', attempts: 2 })
    })

    expect(await dispatchBatch()).toBe(1)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0]![0]).toMatchObject({
      name: 'job.dead_lettered',
      payload: { queue: 'email.send', jobId: 'j3', attempts: 2 },
    })

    // A second pass finds nothing: the row is marked dispatched.
    expect(await dispatchBatch()).toBe(0)
    expect(handler).toHaveBeenCalledTimes(1)
    expect((await eventRow('job.dead_lettered'))?.dispatched_at).not.toBeNull()
  })

  it('isolates subscribers: one failing does not stop its siblings', async () => {
    const failing = vi.fn(async () => {
      throw new Error('subscriber exploded')
    })
    const succeeding = vi.fn(async () => undefined)
    on('job.dead_lettered', [failing, succeeding])

    await publish('job.dead_lettered', { queue: 'email.send', jobId: 'j4', attempts: 1 })
    await dispatchBatch()

    expect(failing).toHaveBeenCalledTimes(1)
    expect(succeeding).toHaveBeenCalledTimes(1)
  })

  it('retries an event whose subscriber failed, recording the attempt', async () => {
    on('job.dead_lettered', [
      vi.fn(async () => {
        throw new Error('still failing')
      }),
    ])

    await publish('job.dead_lettered', { queue: 'email.send', jobId: 'j5', attempts: 1 })
    await dispatchBatch()

    const afterFirst = await eventRow('job.dead_lettered')
    expect(afterFirst?.dispatched_at).toBeNull()
    expect(afterFirst?.attempts).toBe(1)
    expect(afterFirst?.last_error).toContain('still failing')

    await dispatchBatch()
    expect((await eventRow('job.dead_lettered'))?.attempts).toBe(2)
  })

  it('parks a poison event instead of wedging the queue forever', async () => {
    on('job.dead_lettered', [
      vi.fn(async () => {
        throw new Error('always fails')
      }),
    ])

    await publish('job.dead_lettered', { queue: 'email.send', jobId: 'j6', attempts: 1 })

    for (let i = 0; i < EVENT_MAX_DISPATCH_ATTEMPTS; i++) {
      await dispatchBatch()
    }

    const row = await eventRow('job.dead_lettered')
    expect(row?.dispatched_at).not.toBeNull()
    expect(row?.last_error).toContain('always fails')
    // Parked, so it no longer blocks anything behind it.
    expect(await dispatchBatch()).toBe(0)
  })

  it('parks an unknown event name rather than retrying a deploy mismatch forever', async () => {
    await query(
      `INSERT INTO domain_events (event_id, name, aggregate_type, payload)
       VALUES (gen_random_uuid(), 'future.event', 'future', '{}')`,
    )

    await dispatchBatch()
    const row = await eventRow('future.event')
    expect(row?.dispatched_at).not.toBeNull()
    expect(row?.last_error).toContain('unknown event name')
  })

  it('dispatches in publication order', async () => {
    const seen: string[] = []
    on('job.dead_lettered', [
      async (event) => {
        seen.push(event.payload.jobId)
      },
    ])

    for (const jobId of ['a', 'b', 'c']) {
      await publish('job.dead_lettered', { queue: 'email.send', jobId, attempts: 1 })
    }
    await dispatchBatch()

    expect(seen).toEqual(['a', 'b', 'c'])
  })

  it('claims a bounded batch', async () => {
    on('job.dead_lettered', [async () => undefined])
    for (let i = 0; i < 5; i++) {
      await publish('job.dead_lettered', { queue: 'email.send', jobId: `b${i}`, attempts: 1 })
    }
    expect(await dispatchBatch(2)).toBe(2)
    expect(await dispatchBatch(2)).toBe(2)
    expect(await dispatchBatch(2)).toBe(1)
  })
})
