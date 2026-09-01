/**
 * Contract tests against the assembled app — the same object `main/api.ts`
 * serves, so what passes here is what ships.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { createApp } from '../../src/app.js'
import { API_BASE_PATH, env } from '../../src/config/index.js'
import { ERROR_CODES } from '../../src/shared/errors/index.js'
import { describeIfDatabase, setupDatabase, teardownDatabase } from '../setup/database.js'

let app: Express

beforeAll(() => {
  app = createApp()
})

describe('operational endpoints', () => {
  it('reports liveness without touching any dependency', async () => {
    const res = await request(app).get('/healthz')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'ok' })
    expect(typeof res.body.uptimeSeconds).toBe('number')
  })

  it('reports the build identity', async () => {
    const res = await request(app).get('/version')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ name: 'ecommerce-server', nodeEnv: 'test' })
  })
})

describe('response envelope', () => {
  it('returns an enveloped 404 with a request id for an unknown route', async () => {
    const res = await request(app).get('/api/v1/does-not-exist')
    expect(res.status).toBe(404)
    expect(res.body).toMatchObject({
      success: false,
      code: ERROR_CODES.ROUTE_NOT_FOUND,
    })
    expect(typeof res.body.requestId).toBe('string')
    expect(res.headers['x-request-id']).toBe(res.body.requestId)
  })

  it('gives every response a fresh request id', async () => {
    const [a, b] = await Promise.all([
      request(app).get('/api/v1/nope'),
      request(app).get('/api/v1/nope'),
    ])
    expect(a.body.requestId).not.toBe(b.body.requestId)
  })

  it('never leaks a stack trace in the error body for an operational error', async () => {
    const res = await request(app).get('/api/v1/does-not-exist')
    expect(res.body.stack).toBeUndefined()
  })
})

describe('API surfaces', () => {
  it('mounts all four surfaces under the versioned base path', async () => {
    for (const surface of ['auth', 'storefront', 'webhooks']) {
      const res = await request(app).get(`${API_BASE_PATH}/${surface}/probe`)
      // Mounted: the surface router matched, no route did.
      expect(res.status).toBe(404)
      expect(res.body.code).toBe(ERROR_CODES.ROUTE_NOT_FOUND)
    }
  })

  it('denies the admin surface before routing, so an unknown path cannot be probed', async () => {
    // The router-level default deny runs ahead of route matching, so even a
    // path that does not exist answers 401 rather than confirming its absence.
    const res = await request(app).get(`${API_BASE_PATH}/admin/probe`)
    expect(res.status).toBe(401)
    expect(res.body.code).toBe(ERROR_CODES.UNAUTHENTICATED)
  })

  it('answers on the storefront surfaces that have been built', async () => {
    // Present but scoped to a session: 401, never 404. A 404 here would mean
    // the route had quietly stopped being mounted — which is the regression
    // this asserts, and it needs no database to catch.
    for (const path of ['/orders', '/account', '/notifications']) {
      const res = await request(app).get(`${API_BASE_PATH}/storefront${path}`)
      expect(res.status, `${path} should require a session`).toBe(401)
    }
  })

  it('does not expose a storefront route that names another customer', async () => {
    // There is deliberately no `/customers/:id` on this surface at all — not
    // guarded, absent — so one customer cannot reach another's record even if
    // an authorisation check were ever removed.
    const res = await request(app).get(
      `${API_BASE_PATH}/storefront/customers/00000000-0000-4000-8000-000000000001`,
    )
    expect(res.status).toBe(404)
  })
})

describe('security headers and CORS', () => {
  it('sets restrictive headers and hides the framework', async () => {
    const res = await request(app).get('/healthz')
    expect(res.headers['x-powered-by']).toBeUndefined()
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-security-policy']).toContain("default-src 'none'")
    expect(res.headers['referrer-policy']).toBe('no-referrer')
  })

  it('allows the configured client origin with credentials', async () => {
    const res = await request(app).get('/healthz').set('Origin', env.CLIENT_ORIGIN)
    expect(res.headers['access-control-allow-origin']).toBe(env.CLIENT_ORIGIN)
    expect(res.headers['access-control-allow-credentials']).toBe('true')
  })

  it('allows the configured admin origin', async () => {
    const res = await request(app).get('/healthz').set('Origin', env.ADMIN_ORIGIN)
    expect(res.headers['access-control-allow-origin']).toBe(env.ADMIN_ORIGIN)
  })

  it('refuses an unknown origin — no wildcard, ever', async () => {
    const res = await request(app).get('/healthz').set('Origin', 'https://evil.example')
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })
})

describe('body parsing', () => {
  it('rejects malformed JSON with a 400 rather than a 500', async () => {
    const res = await request(app)
      .post(`${API_BASE_PATH}/storefront/anything`)
      .set('Content-Type', 'application/json')
      .send('{"broken":')
    expect(res.status).toBe(400)
    expect(res.body.code).toBe(ERROR_CODES.MALFORMED_REQUEST)
  })

  it('rejects an oversized body with a 413', async () => {
    const res = await request(app)
      .post(`${API_BASE_PATH}/storefront/anything`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(300 * 1024) }))
    expect(res.status).toBe(413)
    expect(res.body.code).toBe(ERROR_CODES.PAYLOAD_TOO_LARGE)
  })
})

describeIfDatabase('readiness', () => {
  beforeAll(setupDatabase)
  afterAll(teardownDatabase)

  it('is ready when the database is reachable and the schema is current', async () => {
    const res = await request(app).get('/readyz')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ready')
    expect(res.body.checks.database.status).toBe('pass')
    expect(res.body.checks.migrations.status).toBe('pass')
  })
})
