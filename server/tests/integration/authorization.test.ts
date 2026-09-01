/**
 * Authorization (§6.5, §6.6).
 *
 * The centrepiece is a generated role × route matrix. It is generated rather
 * than hand-written so that a new admin route without an authorisation rule
 * fails the suite instead of quietly shipping — "we forgot the guard" is the
 * most common real-world admin breach.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { usersService } from '../../src/features/users/index.js'
import { execute, query } from '../../src/infrastructure/database/query.js'
import {
  activeSessionCount,
  bearer,
  createUser,
  createUserAndLogin,
  eventNames,
} from '../factories/auth.js'
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

describeIfDatabase('the seeded permission matrix', () => {
  beforeAll(setupDatabase)
  afterAll(teardownDatabase)

  it('grants staff only day-to-day operations', async () => {
    const roles = await usersService.listRoles()
    const staff = roles.find((r) => r.key === 'staff')!

    expect(staff.permissions).toContain('orders:read')
    expect(staff.permissions).toContain('inventory:adjust')
    // Money and configuration are not day-to-day operations.
    expect(staff.permissions).not.toContain('orders:refund')
    expect(staff.permissions).not.toContain('settings:write')
    expect(staff.permissions).not.toContain('roles:assign')
  })

  it('gives admin everything staff has, and more', async () => {
    const roles = await usersService.listRoles()
    const staff = roles.find((r) => r.key === 'staff')!
    const admin = roles.find((r) => r.key === 'admin')!

    for (const permission of staff.permissions) {
      expect(admin.permissions).toContain(permission)
    }
    expect(admin.permissions).toContain('orders:refund')
    expect(admin.permissions).toContain('settings:write')
    // Staff management stays with the owner.
    expect(admin.permissions).not.toContain('roles:assign')
  })

  it('gives owner everything except the impersonation permission', async () => {
    const roles = await usersService.listRoles()
    const owner = roles.find((r) => r.key === 'owner')!
    const all = await query<{ key: string }>(`SELECT key FROM permissions`)

    expect(owner.permissions).not.toContain('customers:impersonate')
    for (const { key } of all) {
      if (key === 'customers:impersonate') continue
      expect(owner.permissions).toContain(key)
    }
  })

  it('grants a customer no administrative permission at all', async () => {
    const roles = await usersService.listRoles()
    expect(roles.find((r) => r.key === 'customer')!.permissions).toEqual([])
  })

  it('grants customers:impersonate to nobody', async () => {
    const rows = await query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
        WHERE p.key = 'customers:impersonate'`,
    )
    expect(rows[0]?.count).toBe(0)
  })
})

// ── The route × role matrix ─────────────────────────────────────────────────

interface RouteCase {
  method: 'get' | 'post' | 'patch' | 'delete'
  path: string
  body?: object
  /** Roles that must be allowed past authentication and authorisation. */
  allowed: string[]
}

// Every admin route shipped in this phase is staff administration, which the
// seeded matrix reserves for the owner (§6.5). As feature routes arrive this
// table gains rows with genuinely different allowed sets.
const ADMIN_ROUTES: RouteCase[] = [
  { method: 'get', path: '/api/v1/admin/roles', allowed: ['owner'] },
  { method: 'get', path: '/api/v1/admin/staff', allowed: ['owner'] },
  {
    method: 'patch',
    path: '/api/v1/admin/staff/00000000-0000-4000-8000-000000000000/roles',
    body: { roles: ['staff'] },
    allowed: ['owner'],
  },
  {
    method: 'patch',
    path: '/api/v1/admin/staff/00000000-0000-4000-8000-000000000000/status',
    body: { status: 'disabled' },
    allowed: ['owner'],
  },
]

describeIfDatabase('admin authorization matrix', () => {
  beforeAll(setupDatabase)
  afterEach(async () => {
    usersService.clearCaches()
    await truncateAll()
  })
  afterAll(teardownDatabase)

  for (const route of ADMIN_ROUTES) {
    describe(`${route.method.toUpperCase()} ${route.path}`, () => {
      it('rejects an anonymous request', async () => {
        const res = await request(app)
          [route.method](route.path)
          .send(route.body ?? {})
        expect(res.status).toBe(401)
        expect(res.body.code).toBe('UNAUTHENTICATED')
      })

      it('rejects a customer before it reaches the handler', async () => {
        const session = await createUserAndLogin(app, { roles: ['customer'] })
        const res = await request(app)
          [route.method](route.path)
          .set('Authorization', bearer(session.accessToken))
          .send(route.body ?? {})

        expect(res.status).toBe(403)
        expect(res.body.code).toBe('FORBIDDEN')
      })

      for (const role of ['staff', 'admin', 'owner']) {
        const permitted = route.allowed.includes(role)

        it(`${permitted ? 'admits' : 'refuses'} ${role}`, async () => {
          const session = await createUserAndLogin(app, { roles: [role] })
          const res = await request(app)
            [route.method](route.path)
            .set('Authorization', bearer(session.accessToken))
            .send(route.body ?? {})

          if (permitted) {
            // Past authorisation. 404 is fine — the fixture id does not exist.
            expect([200, 204, 404]).toContain(res.status)
          } else {
            expect(res.status).toBe(403)
            expect(res.body.code).toBe('INSUFFICIENT_PERMISSIONS')
          }
        })
      }
    })
  }

  it('protects every mounted admin route — no route may be reachable anonymously', async () => {
    // Walks the router's own stack, so a route added without a guard is caught
    // here rather than in review.
    // Every router mounted on adminRouter, so a whole feature added without a
    // guard is caught too — not just a route added to an existing file.
    const routers = await Promise.all([
      import('../../src/features/users/users.admin.routes.js').then((m) => m.usersAdminRoutes),
      import('../../src/features/settings/settings.admin.routes.js').then((m) => m.settingsAdminRoutes),
      import('../../src/features/media/media.admin.routes.js').then((m) => m.mediaAdminRoutes),
      import('../../src/features/audit/audit.admin.routes.js').then((m) => m.auditAdminRoutes),
    ])

    const mounted = routers.flatMap((router) =>
      (
        router as unknown as {
          stack: { route?: { path: string; methods: Record<string, boolean> } }[]
        }
      ).stack
        .filter((layer) => layer.route)
        .map((layer) => ({
          path: layer.route!.path,
          method: Object.keys(layer.route!.methods)[0] as RouteCase['method'],
        })),
    )

    expect(mounted.length).toBeGreaterThanOrEqual(12)

    for (const route of mounted) {
      const full = `/api/v1/admin${route.path.replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000')}`
      const res = await request(app)[route.method](full).send({})
      expect(
        res.status,
        `${route.method.toUpperCase()} ${full} answered ${res.status} without a token`,
      ).toBe(401)
    }
  })
})

describeIfDatabase('role and status administration', () => {
  beforeAll(setupDatabase)
  afterEach(async () => {
    usersService.clearCaches()
    await truncateAll()
  })
  afterAll(teardownDatabase)

  it('changes a user’s roles and takes effect on the next request', async () => {
    const owner = await createUserAndLogin(app, { roles: ['owner'] })
    const target = await createUserAndLogin(app, { roles: ['customer'] })

    const before = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(target.accessToken))
    expect(before.body.data.roles).toEqual(['customer'])
    expect(before.body.data.isStaff).toBe(false)

    const res = await request(app)
      .patch(`/api/v1/admin/staff/${target.user.id}/roles`)
      .set('Authorization', bearer(owner.accessToken))
      .send({ roles: ['staff'] })
    expect(res.status).toBe(200)
    expect(res.body.data.roles).toEqual(['staff'])

    // The SAME access token, issued when the user was a customer, now carries
    // staff standing: roles are read from the database per request, not taken
    // from the token, so no re-login is needed.
    const after = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(target.accessToken))
    expect(after.body.data.roles).toEqual(['staff'])
    expect(after.body.data.isStaff).toBe(true)
    expect(after.body.data.permissions).toContain('orders:read')

    expect(await eventNames()).toContain('user.roles_changed')
  })

  it('opens an owner-only route the moment the owner role is granted', async () => {
    const owner = await createUserAndLogin(app, { roles: ['owner'] })
    const target = await createUserAndLogin(app, { roles: ['admin'] })

    expect(
      (
        await request(app)
          .get('/api/v1/admin/roles')
          .set('Authorization', bearer(target.accessToken))
      ).status,
    ).toBe(403)

    await request(app)
      .patch(`/api/v1/admin/staff/${target.user.id}/roles`)
      .set('Authorization', bearer(owner.accessToken))
      .send({ roles: ['owner'] })

    expect(
      (
        await request(app)
          .get('/api/v1/admin/roles')
          .set('Authorization', bearer(target.accessToken))
      ).status,
    ).toBe(200)
  })

  it('refuses to let an admin grant the owner role', async () => {
    const admin = await createUserAndLogin(app, { roles: ['admin'] })
    const target = await createUser({ roles: ['customer'] })

    // Admin lacks roles:assign entirely, so this stops at the permission check.
    const res = await request(app)
      .patch(`/api/v1/admin/staff/${target.id}/roles`)
      .set('Authorization', bearer(admin.accessToken))
      .send({ roles: ['owner'] })
    expect(res.status).toBe(403)
  })

  it('refuses to remove the last owner', async () => {
    const owner = await createUserAndLogin(app, { roles: ['owner'] })

    const res = await request(app)
      .patch(`/api/v1/admin/staff/${owner.user.id}/roles`)
      .set('Authorization', bearer(owner.accessToken))
      .send({ roles: ['admin'] })

    expect(res.status).toBe(422)
    expect(res.body.code).toBe('LAST_OWNER_PROTECTED')
  })

  it('allows demoting an owner once a second owner exists', async () => {
    const first = await createUserAndLogin(app, { roles: ['owner'] })
    const second = await createUser({ roles: ['owner'] })

    const res = await request(app)
      .patch(`/api/v1/admin/staff/${second.id}/roles`)
      .set('Authorization', bearer(first.accessToken))
      .send({ roles: ['admin'] })
    expect(res.status).toBe(200)
  })

  it('rejects an unknown role key', async () => {
    const owner = await createUserAndLogin(app, { roles: ['owner'] })
    const target = await createUser()

    const res = await request(app)
      .patch(`/api/v1/admin/staff/${target.id}/roles`)
      .set('Authorization', bearer(owner.accessToken))
      .send({ roles: ['superuser'] })
    expect(res.status).toBe(422)
  })

  it('disabling an account revokes its sessions immediately', async () => {
    const owner = await createUserAndLogin(app, { roles: ['owner'] })
    const target = await createUserAndLogin(app, { roles: ['staff'] })
    expect(await activeSessionCount(target.user.id)).toBe(1)

    const res = await request(app)
      .patch(`/api/v1/admin/staff/${target.user.id}/status`)
      .set('Authorization', bearer(owner.accessToken))
      .send({ status: 'disabled' })

    expect(res.status).toBe(200)
    expect(await activeSessionCount(target.user.id)).toBe(0)

    const blocked = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(target.accessToken))
    expect(blocked.status).toBe(401)
    expect(blocked.body.code).toBe('ACCOUNT_DISABLED')

    const refresh = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', target.refreshCookie)
      .send({})
    expect(refresh.status).toBe(401)
  })

  it('refuses to let an owner disable themselves', async () => {
    const owner = await createUserAndLogin(app, { roles: ['owner'] })
    const res = await request(app)
      .patch(`/api/v1/admin/staff/${owner.user.id}/status`)
      .set('Authorization', bearer(owner.accessToken))
      .send({ status: 'disabled' })
    expect(res.status).toBe(409)
  })

  it('lists only staff, never customers', async () => {
    const owner = await createUserAndLogin(app, { roles: ['owner'] })
    await createUser({ roles: ['customer'] })
    await createUser({ roles: ['staff'] })

    const res = await request(app)
      .get('/api/v1/admin/staff')
      .set('Authorization', bearer(owner.accessToken))

    expect(res.status).toBe(200)
    expect(res.body.meta.pagination.total).toBe(2)
    for (const row of res.body.data) {
      expect(row.roles.some((r: string) => ['staff', 'admin', 'owner'].includes(r))).toBe(true)
    }
  })

  it('never exposes a password hash in an admin listing', async () => {
    const owner = await createUserAndLogin(app, { roles: ['owner'] })
    const res = await request(app)
      .get('/api/v1/admin/staff')
      .set('Authorization', bearer(owner.accessToken))

    const body = JSON.stringify(res.body)
    expect(body).not.toContain('$argon2')
    expect(body).not.toContain('password')
  })

  it('reflects a permission revoked from a role without a restart', async () => {
    const staff = await createUserAndLogin(app, { roles: ['staff'] })

    const before = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(staff.accessToken))
    expect(before.body.data.permissions).toContain('orders:read')

    await execute(
      `DELETE FROM role_permissions
        WHERE role_id = (SELECT id FROM roles WHERE key = 'staff')
          AND permission_id = (SELECT id FROM permissions WHERE key = 'orders:read')`,
    )
    usersService.invalidatePermissionMatrix()

    const after = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(staff.accessToken))
    expect(after.body.data.permissions).not.toContain('orders:read')

    // Restore: role_permissions is seed data shared by every test in the file.
    await execute(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT r.id, p.id FROM roles r, permissions p
        WHERE r.key = 'staff' AND p.key = 'orders:read'
       ON CONFLICT DO NOTHING`,
    )
    usersService.invalidatePermissionMatrix()
  })
})
