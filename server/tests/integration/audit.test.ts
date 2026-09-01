/**
 * The administrative audit trail (§43, §15.7).
 *
 * The property that matters is atomicity: an audit row exists if and only if
 * the change it describes committed. A trail that can disagree with the data is
 * worse than none, because it will be believed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { auditService, diffChanged } from '../../src/features/audit/index.js'
import { usersService } from '../../src/features/users/index.js'
import { withTransaction } from '../../src/infrastructure/database/transaction.js'
import { query, queryOne } from '../../src/infrastructure/database/query.js'
import { bearer, createUser, createUserAndLogin } from '../factories/auth.js'
import {
  describeIfDatabase,
  setupDatabase,
  teardownDatabase,
  truncateAll,
} from '../setup/database.js'

vi.mock('../../src/infrastructure/queue/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof QueueModule>()
  return { ...actual, enqueue: vi.fn(async () => 'stub-job-id') }
})

const app = createApp()

/** The same Actor `authenticate` would build, without going through HTTP. */
async function actorFor(userId: string) {
  const actor = await usersService.resolveActor(userId, 'session-under-test')
  if (!actor) throw new Error(`No actor for ${userId}`)
  return actor
}

async function rows() {
  return query<{
    action: string
    resource_type: string
    resource_id: string | null
    actor_email: string | null
    actor_roles: string[]
    before: Record<string, unknown> | null
    after: Record<string, unknown> | null
  }>(`SELECT * FROM audit_logs ORDER BY id`)
}

describeIfDatabase('the audit trail', () => {
  let owner: Awaited<ReturnType<typeof createUserAndLogin>>

  beforeAll(setupDatabase)
  beforeEach(async () => {
    owner = await createUserAndLogin(app, { roles: ['owner'] })
  })
  afterEach(async () => {
    usersService.clearCaches()
    await truncateAll()
  })
  afterAll(teardownDatabase)

  // ── Recording ─────────────────────────────────────────────────────────────

  it('records who did what, to which record', async () => {
    const actor = await actorFor(owner.user.id)

    await auditService.record({
      actor,
      action: 'settings.updated',
      resourceType: 'store_settings',
      resourceId: '1',
      before: { storeName: 'Old' },
      after: { storeName: 'New' },
      ip: '203.0.113.9',
    })

    const [row] = await rows()
    expect(row).toMatchObject({
      action: 'settings.updated',
      resource_type: 'store_settings',
      resource_id: '1',
      actor_email: owner.user.email,
      before: { storeName: 'Old' },
      after: { storeName: 'New' },
    })
    expect(row?.actor_roles).toEqual(['owner'])
  })

  it('commits with the change, and rolls back with it', async () => {
    const actor = await actorFor(owner.user.id)

    await expect(
      withTransaction(async () => {
        await auditService.record({
          actor,
          action: 'staff.role_changed',
          resourceType: 'user',
          resourceId: owner.user.id,
        })
        throw new Error('the business rule said no')
      }),
    ).rejects.toThrow('the business rule said no')

    // No orphan record of a change that never happened.
    expect(await rows()).toHaveLength(0)
  })

  it('redacts credentials even if a caller passes one', async () => {
    const actor = await actorFor(owner.user.id)

    await auditService.record({
      actor,
      action: 'user.updated',
      resourceType: 'user',
      resourceId: owner.user.id,
      before: { passwordHash: '$argon2id$v=19$m=19456$abc', email: 'a@b.test' },
      after: { password: 'hunter2', refreshToken: 'rt_secret', apiKey: 'sk_live_x', email: 'c@d.test' },
    })

    const [row] = await rows()
    expect(row?.before).toEqual({ passwordHash: '[REDACTED]', email: 'a@b.test' })
    expect(row?.after).toEqual({
      password: '[REDACTED]',
      refreshToken: '[REDACTED]',
      apiKey: '[REDACTED]',
      email: 'c@d.test',
    })

    const raw = JSON.stringify(await rows())
    expect(raw).not.toContain('hunter2')
    expect(raw).not.toContain('argon2')
    expect(raw).not.toContain('sk_live_x')
  })

  it('accepts a record with no actor, for a change a job made', async () => {
    await auditService.record({
      action: 'media.deleted',
      resourceType: 'media_asset',
      resourceId: '00000000-0000-4000-8000-000000000000',
    })

    const [row] = await rows()
    expect(row?.actor_email).toBeNull()
    expect(row?.actor_roles).toEqual([])
  })

  it('refuses an action name that is not feature-dotted', async () => {
    // The CHECK constraint keeps the trail queryable by feature.
    await expect(
      auditService.record({ action: 'DidSomething', resourceType: 'user' }),
    ).rejects.toThrow()
  })

  it('collects the history of one record in order', async () => {
    const actor = await actorFor(owner.user.id)
    for (const name of ['First', 'Second', 'Third']) {
      await auditService.record({
        actor,
        action: 'settings.updated',
        resourceType: 'store_settings',
        resourceId: '1',
        after: { storeName: name },
      })
    }

    const history = await auditService.forResource('store_settings', '1')
    expect(history.map((r) => r.after?.storeName)).toEqual(['First', 'Second', 'Third'])
  })

  // ── diffChanged ───────────────────────────────────────────────────────────

  it('records only the fields that actually moved', () => {
    const before = { storeName: 'Old', currency: 'USD', taxRateBps: 0 }

    expect(diffChanged(before, { storeName: 'New', currency: 'USD' })).toEqual({
      before: { storeName: 'Old' },
      after: { storeName: 'New' },
    })
    expect(diffChanged(before, { currency: 'USD' })).toBeNull()
    expect(diffChanged(before, { storeName: undefined })).toBeNull()
    expect(diffChanged({ a: { x: 1 } }, { a: { x: 1 } })).toBeNull()
    expect(diffChanged({ a: { x: 1 } }, { a: { x: 2 } })).not.toBeNull()
  })

  // ── Reading ───────────────────────────────────────────────────────────────

  it('is readable by an owner and nobody else', async () => {
    const res = await request(app)
      .get('/api/v1/admin/audit-logs')
      .set('Authorization', bearer(owner.accessToken))
    expect(res.status).toBe(200)

    for (const roles of [['admin'], ['staff'], ['customer']]) {
      const other = await createUserAndLogin(app, { roles })
      const denied = await request(app)
        .get('/api/v1/admin/audit-logs')
        .set('Authorization', bearer(other.accessToken))
      expect(denied.status).toBe(403)
    }

    expect((await request(app).get('/api/v1/admin/audit-logs')).status).toBe(401)
  })

  it('lists newest first and paginates', async () => {
    const actor = await actorFor(owner.user.id)
    for (let i = 0; i < 5; i += 1) {
      await auditService.record({
        actor,
        action: 'settings.updated',
        resourceType: 'store_settings',
        resourceId: String(i),
      })
    }

    const res = await request(app)
      .get('/api/v1/admin/audit-logs?page=1&limit=2')
      .set('Authorization', bearer(owner.accessToken))

    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
    expect(res.body.meta.pagination.total).toBe(5)
    expect(res.body.data[0].resourceId).toBe('4')
  })

  it('filters by actor, action and resource', async () => {
    const actor = await actorFor(owner.user.id)
    const other = await createUser({ roles: ['admin'] })
    const otherActor = await actorFor(other.id)

    await auditService.record({ actor, action: 'settings.updated', resourceType: 'store_settings', resourceId: '1' })
    await auditService.record({ actor: otherActor, action: 'media.deleted', resourceType: 'media_asset', resourceId: 'm1' })

    const get = (qs: string) =>
      request(app).get(`/api/v1/admin/audit-logs?${qs}`).set('Authorization', bearer(owner.accessToken))

    expect((await get(`actorUserId=${other.id}`)).body.meta.pagination.total).toBe(1)
    expect((await get('action=media.deleted')).body.meta.pagination.total).toBe(1)
    expect((await get('resourceType=store_settings')).body.meta.pagination.total).toBe(1)
    expect((await get('resourceId=m1')).body.data[0].action).toBe('media.deleted')
  })

  it('rejects a filter that is not a valid action name', async () => {
    const res = await request(app)
      .get('/api/v1/admin/audit-logs?action=%27%20OR%201%3D1--')
      .set('Authorization', bearer(owner.accessToken))
    expect(res.status).toBe(422)
  })

  it('shows the request that caused each change', async () => {
    // Recorded through a real HTTP request, so requestId comes from the
    // middleware rather than being passed in.
    await request(app)
      .patch('/api/v1/admin/settings')
      .set('Authorization', bearer(owner.accessToken))
      .send({ storeName: 'Copperleaf' })

    const row = await queryOne<{ request_id: string | null; actor_ip: string | null }>(
      `SELECT request_id, actor_ip FROM audit_logs ORDER BY id DESC LIMIT 1`,
    )
    expect(row?.request_id).toBeTruthy()
    expect(row?.actor_ip).toBeTruthy()
  })
})
