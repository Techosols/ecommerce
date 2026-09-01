/**
 * Idempotency middleware (§19.2).
 *
 * Exercised through a throwaway route mounted on a bare Express app — no
 * business endpoint exists yet, and inventing one would be the fake endpoint
 * the brief rules out.
 */
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import { errorHandler } from '../../src/shared/middleware/errorHandler.js'
import { requestContext } from '../../src/shared/middleware/requestContext.js'
import { idempotency } from '../../src/shared/middleware/idempotency.js'
import { queryOne } from '../../src/infrastructure/database/query.js'
import { ERROR_CODES } from '../../src/shared/errors/index.js'
import {
  describeIfDatabase,
  setupDatabase,
  teardownDatabase,
  truncateAll,
} from '../setup/database.js'

let executions = 0

/**
 * Waits until the middleware's post-response write has landed.
 *
 * `captureResponse` persists the completed record *after* the response is sent,
 * so a test that mutates the row the instant supertest resolves can be
 * overwritten by that write. Waiting for the row to reach its final state makes
 * the test deterministic without weakening what it asserts.
 */
async function settled(key: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const row = await queryOne<{ status: string }>(
      'SELECT status FROM idempotency_keys WHERE key = $1',
      [key],
    )
    if (row?.status === 'completed') return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Idempotency record "${key}" never completed`)
}

function buildApp(): Express {
  const app = express()
  app.use(requestContext)
  app.use(express.json())
  app.post('/thing', idempotency(), (req, res) => {
    executions++
    res.status(201).json({ success: true, data: { id: `thing-${executions}`, body: req.body } })
  })
  app.post('/optional', idempotency({ required: false }), (_req, res) => {
    executions++
    res.status(201).json({ success: true, data: { id: `thing-${executions}` } })
  })
  app.post('/failing', idempotency(), (_req, res) => {
    executions++
    res.status(500).json({ success: false, message: 'boom', code: 'INTERNAL_ERROR' })
  })
  app.use(errorHandler)
  return app
}

describeIfDatabase('idempotency middleware', () => {
  const app = buildApp()

  beforeAll(setupDatabase)
  afterEach(async () => {
    executions = 0
    await truncateAll()
  })
  afterAll(teardownDatabase)

  it('requires the header where the route demands it', async () => {
    const res = await request(app).post('/thing').send({ a: 1 })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED)
    expect(executions).toBe(0)
  })

  it('lets a route opt out', async () => {
    const res = await request(app).post('/optional').send({ a: 1 })
    expect(res.status).toBe(201)
  })

  it('executes once and replays the stored response for a retry', async () => {
    const send = () => request(app).post('/thing').set('Idempotency-Key', 'key-1').send({ a: 1 })

    const first = await send()
    const second = await send()

    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(second.body).toEqual(first.body)
    expect(second.headers['idempotent-replay']).toBe('true')
    expect(executions).toBe(1)
  })

  it('rejects the same key used with a different body', async () => {
    await request(app).post('/thing').set('Idempotency-Key', 'key-2').send({ a: 1 })
    const res = await request(app).post('/thing').set('Idempotency-Key', 'key-2').send({ a: 2 })

    expect(res.status).toBe(422)
    expect(res.body.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_REUSED)
    expect(executions).toBe(1)
  })

  it('executes once when two identical requests race — the unique constraint decides', async () => {
    const send = () => request(app).post('/thing').set('Idempotency-Key', 'key-3').send({ a: 1 })

    const results = await Promise.all([send(), send(), send()])
    const created = results.filter((r) => r.status === 201)
    const conflicted = results.filter((r) => r.status === 409)

    expect(executions).toBe(1)
    expect(created.length + conflicted.length).toBe(3)
    expect(conflicted.every((r) => r.body.code === ERROR_CODES.REQUEST_IN_PROGRESS)).toBe(true)
  })

  it('does not store a failed response, so a genuine failure stays retryable', async () => {
    await request(app).post('/failing').set('Idempotency-Key', 'key-4').send({ a: 1 })

    const record = await queryOne('SELECT key FROM idempotency_keys WHERE key = $1', ['key-4'])
    expect(record).toBeUndefined()

    await request(app).post('/failing').set('Idempotency-Key', 'key-4').send({ a: 1 })
    expect(executions).toBe(2)
  })

  it('scopes keys by route, so the same key on two endpoints is two requests', async () => {
    await request(app).post('/thing').set('Idempotency-Key', 'shared').send({ a: 1 })
    await request(app).post('/optional').set('Idempotency-Key', 'shared').send({ a: 1 })
    expect(executions).toBe(2)
  })

  it('takes over a stale in-progress record left by a dead process', async () => {
    await request(app).post('/thing').set('Idempotency-Key', 'key-5').send({ a: 1 })
    await settled('key-5')

    // Simulate a crash mid-request: in progress, locked long ago.
    await queryOne(
      `UPDATE idempotency_keys
          SET status = 'in_progress', locked_at = now() - interval '10 minutes',
              response_status = NULL, response_body = NULL
        WHERE key = $1 RETURNING key`,
      ['key-5'],
    )

    const res = await request(app).post('/thing').set('Idempotency-Key', 'key-5').send({ a: 1 })
    expect(res.status).toBe(201)
    expect(executions).toBe(2)
  })
})
