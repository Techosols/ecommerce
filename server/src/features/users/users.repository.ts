/**
 * Identity and RBAC data access (§1.2).
 *
 * SQL only — no business rules. Every statement is parameterised; role keys
 * that reach a query come from an allowlist resolved against the `roles` table,
 * never interpolated.
 */
import { v7 as uuidv7 } from 'uuid'
import { execute, query, queryOne } from '../../infrastructure/database/query.js'
import type {
  CreateUserInput,
  Role,
  User,
  UserAccess,
  UserCredentials,
  UserStatus,
} from './users.types.js'

interface UserRow {
  id: string
  email: string
  status: UserStatus
  email_verified_at: Date | null
  first_name: string | null
  last_name: string | null
  phone: string | null
  last_login_at: Date | null
  created_at: Date
  roles: string[] | null
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    status: row.status,
    emailVerified: row.email_verified_at !== null,
    firstName: row.first_name,
    lastName: row.last_name,
    phone: row.phone,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    roles: row.roles ?? [],
  }
}

const USER_SELECT = `
  SELECT u.id, u.email, u.status, u.email_verified_at, u.first_name, u.last_name,
         u.phone, u.last_login_at, u.created_at,
         coalesce(array_agg(r.key ORDER BY r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles
    FROM users u
    LEFT JOIN user_roles ur ON ur.user_id = u.id
    LEFT JOIN roles r ON r.id = ur.role_id
`

export const usersRepository = {
  async create(input: CreateUserInput & { id?: string }): Promise<string> {
    const id = input.id ?? uuidv7()
    await execute(
      `INSERT INTO users (id, email, password_hash, first_name, last_name, phone)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        input.email,
        input.passwordHash ?? null,
        input.firstName ?? null,
        input.lastName ?? null,
        input.phone ?? null,
      ],
      { name: 'users.create' },
    )
    return id
  },

  async findById(userId: string): Promise<User | undefined> {
    const row = await queryOne<UserRow>(`${USER_SELECT} WHERE u.id = $1 GROUP BY u.id`, [userId], {
      name: 'users.findById',
    })
    return row ? toUser(row) : undefined
  },

  async findByEmail(email: string): Promise<User | undefined> {
    const row = await queryOne<UserRow>(
      `${USER_SELECT} WHERE u.email = $1 GROUP BY u.id`,
      [email],
      {
        name: 'users.findByEmail',
      },
    )
    return row ? toUser(row) : undefined
  },

  /** The only query that returns a password hash. */
  async findCredentialsByEmail(email: string): Promise<UserCredentials | undefined> {
    const row = await queryOne<{
      id: string
      email: string
      status: UserStatus
      password_hash: string | null
      email_verified_at: Date | null
    }>(
      `SELECT id, email, status, password_hash, email_verified_at
         FROM users WHERE email = $1`,
      [email],
      { name: 'users.findCredentialsByEmail' },
    )
    if (!row) return undefined
    return {
      id: row.id,
      email: row.email,
      status: row.status,
      passwordHash: row.password_hash,
      emailVerified: row.email_verified_at !== null,
    }
  },

  async findCredentialsById(userId: string): Promise<UserCredentials | undefined> {
    const row = await queryOne<{
      id: string
      email: string
      status: UserStatus
      password_hash: string | null
      email_verified_at: Date | null
    }>(
      `SELECT id, email, status, password_hash, email_verified_at
         FROM users WHERE id = $1`,
      [userId],
      { name: 'users.findCredentialsById' },
    )
    if (!row) return undefined
    return {
      id: row.id,
      email: row.email,
      status: row.status,
      passwordHash: row.password_hash,
      emailVerified: row.email_verified_at !== null,
    }
  },

  /** Everything `authenticate` needs, in one indexed read. */
  async findAccess(userId: string): Promise<UserAccess | undefined> {
    const row = await queryOne<{
      id: string
      email: string
      status: UserStatus
      email_verified_at: Date | null
      roles: string[] | null
    }>(
      `SELECT u.id, u.email, u.status, u.email_verified_at,
              coalesce(array_agg(r.key ORDER BY r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles
         FROM users u
         LEFT JOIN user_roles ur ON ur.user_id = u.id
         LEFT JOIN roles r ON r.id = ur.role_id
        WHERE u.id = $1
        GROUP BY u.id`,
      [userId],
      { name: 'users.findAccess' },
    )
    if (!row) return undefined
    return {
      userId: row.id,
      email: row.email,
      status: row.status,
      emailVerified: row.email_verified_at !== null,
      roles: row.roles ?? [],
    }
  },

  async setPasswordHash(userId: string, passwordHash: string): Promise<void> {
    await execute(`UPDATE users SET password_hash = $2 WHERE id = $1`, [userId, passwordHash], {
      name: 'users.setPasswordHash',
    })
  },

  /**
   * Compare-and-swap on the verification timestamp: a replayed verification
   * affects zero rows, which the service reads as "already done" (§8.3).
   */
  async markEmailVerified(userId: string): Promise<boolean> {
    const affected = await execute(
      `UPDATE users SET email_verified_at = now()
        WHERE id = $1 AND email_verified_at IS NULL`,
      [userId],
      { name: 'users.markEmailVerified' },
    )
    return affected === 1
  },

  async setStatus(userId: string, status: UserStatus): Promise<void> {
    await execute(`UPDATE users SET status = $2 WHERE id = $1`, [userId, status], {
      name: 'users.setStatus',
    })
  },

  async recordLogin(userId: string): Promise<void> {
    await execute(`UPDATE users SET last_login_at = now() WHERE id = $1`, [userId], {
      name: 'users.recordLogin',
    })
  },

  // ── Roles and permissions ─────────────────────────────────────────────────

  async listRoles(): Promise<Role[]> {
    const rows = await query<{
      key: string
      name: string
      description: string
      permissions: string[] | null
    }>(
      `SELECT r.key, r.name, r.description,
              coalesce(array_agg(p.key ORDER BY p.key) FILTER (WHERE p.key IS NOT NULL), '{}') AS permissions
         FROM roles r
         LEFT JOIN role_permissions rp ON rp.role_id = r.id
         LEFT JOIN permissions p ON p.id = rp.permission_id
        GROUP BY r.id
        ORDER BY r.id`,
      [],
      { name: 'users.listRoles' },
    )
    return rows.map((row) => ({
      key: row.key,
      name: row.name,
      description: row.description,
      permissions: row.permissions ?? [],
    }))
  },

  /** The whole role→permission matrix, cached by the service. */
  async loadPermissionMatrix(): Promise<Record<string, string[]>> {
    const roles = await this.listRoles()
    return Object.fromEntries(roles.map((role) => [role.key, role.permissions]))
  },

  async assignRoles(userId: string, roleKeys: string[], grantedBy: string | null): Promise<void> {
    await execute(
      `INSERT INTO user_roles (user_id, role_id, granted_by)
       SELECT $1, r.id, $3 FROM roles r WHERE r.key = ANY($2::text[])
       ON CONFLICT (user_id, role_id) DO NOTHING`,
      [userId, roleKeys, grantedBy],
      { name: 'users.assignRoles' },
    )
  },

  async replaceRoles(userId: string, roleKeys: string[], grantedBy: string | null): Promise<void> {
    await execute(
      `DELETE FROM user_roles
        WHERE user_id = $1
          AND role_id NOT IN (SELECT id FROM roles WHERE key = ANY($2::text[]))`,
      [userId, roleKeys],
      { name: 'users.pruneRoles' },
    )
    if (roleKeys.length > 0) {
      await this.assignRoles(userId, roleKeys, grantedBy)
    }
  },

  async roleKeysExist(roleKeys: string[]): Promise<string[]> {
    const rows = await query<{ key: string }>(
      `SELECT key FROM roles WHERE key = ANY($1::text[])`,
      [roleKeys],
      { name: 'users.roleKeysExist' },
    )
    return rows.map((r) => r.key)
  },

  async countUsersWithRole(roleKey: string): Promise<number> {
    const row = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         JOIN users u ON u.id = ur.user_id
        WHERE r.key = $1 AND u.status = 'active'`,
      [roleKey],
      { name: 'users.countUsersWithRole' },
    )
    return row?.count ?? 0
  },

  /** Staff listing for the admin surface. */
  async listStaff(options: {
    limit: number
    offset: number
  }): Promise<{ rows: User[]; total: number }> {
    const rows = await query<UserRow & { total: number }>(
      `${USER_SELECT}
        WHERE EXISTS (
          SELECT 1 FROM user_roles ur2
            JOIN roles r2 ON r2.id = ur2.role_id
           WHERE ur2.user_id = u.id AND r2.key IN ('staff', 'admin', 'owner')
        )
        GROUP BY u.id
        ORDER BY u.created_at DESC
        LIMIT $1 OFFSET $2`,
      [options.limit, options.offset],
      { name: 'users.listStaff' },
    )

    const totalRow = await queryOne<{ count: number }>(
      `SELECT count(DISTINCT ur.user_id)::int AS count
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
        WHERE r.key IN ('staff', 'admin', 'owner')`,
      [],
      { name: 'users.countStaff' },
    )

    return { rows: rows.map(toUser), total: totalRow?.count ?? 0 }
  },
}
