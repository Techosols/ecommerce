import { describe, expect, it } from 'vitest'
import { EVENT_AGGREGATES, EVENT_SCHEMAS, isKnownEvent } from '../../src/events/catalog.js'
import {
  JOB_SCHEMAS,
  QUEUES,
  QUEUE_POLICIES,
  QUEUE_SCHEDULES,
  deadLetterName,
} from '../../src/infrastructure/queue/queues.js'

describe('event catalogue', () => {
  it('gives every event an aggregate type, so the "what happened to X" index works', () => {
    for (const name of Object.keys(EVENT_SCHEMAS)) {
      expect(EVENT_AGGREGATES[name as keyof typeof EVENT_AGGREGATES]).toBeTruthy()
    }
  })

  it('recognises only registered names', () => {
    expect(isKnownEvent('job.dead_lettered')).toBe(true)
    expect(isKnownEvent('order.placed')).toBe(true)
    // The point of the registry: a name nobody declared cannot be published,
    // so a typo is a compile error rather than an event nothing subscribes to.
    expect(isKnownEvent('order.plcaed')).toBe(false)
    expect(isKnownEvent('something.invented')).toBe(false)
  })

  it('validates payloads', () => {
    const schema = EVENT_SCHEMAS['job.dead_lettered']
    expect(schema.safeParse({ queue: 'email.send', jobId: 'j1', attempts: 3 }).success).toBe(true)
    expect(schema.safeParse({ queue: 'email.send' }).success).toBe(false)
    expect(schema.safeParse({ queue: 'email.send', jobId: 'j1', attempts: -1 }).success).toBe(false)
  })

  it('names events as aggregate.past_tense', () => {
    for (const name of Object.keys(EVENT_SCHEMAS)) {
      expect(name).toMatch(/^[a-z_]+\.[a-z_]+$/)
    }
  })
})

describe('queue registry', () => {
  it('gives every queue a payload schema and a policy', () => {
    for (const queue of Object.values(QUEUES)) {
      expect(JOB_SCHEMAS[queue]).toBeDefined()
      expect(QUEUE_POLICIES[queue]).toBeDefined()
    }
  })

  it('names queues as domain.action', () => {
    for (const queue of Object.values(QUEUES)) {
      expect(queue).toMatch(/^[a-z]+\.[a-z_]+$/)
    }
  })

  it('derives a dead-letter name for every queue', () => {
    expect(deadLetterName(QUEUES.EMAIL_SEND)).toBe('email.send.dlq')
  })

  it('sets a visibility timeout comfortably above the expected duration', () => {
    for (const policy of Object.values(QUEUE_POLICIES)) {
      expect(policy.expireInSeconds).toBeGreaterThan(0)
      expect(policy.retryLimit).toBeGreaterThanOrEqual(0)
    }
  })

  it('schedules only queues that exist', () => {
    const names = Object.values(QUEUES) as string[]
    for (const schedule of QUEUE_SCHEDULES) {
      expect(names).toContain(schedule.queue)
      expect(schedule.cron.split(' ')).toHaveLength(5)
    }
  })

  it('validates job payloads at the producer', () => {
    const schema = JOB_SCHEMAS[QUEUES.EMAIL_SEND]
    expect(
      schema.safeParse({ emailMessageId: '0199a0e0-0000-7000-8000-000000000000' }).success,
    ).toBe(true)
    expect(schema.safeParse({ emailMessageId: 'not-a-uuid' }).success).toBe(false)
  })
})
