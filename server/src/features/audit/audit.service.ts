/**
 * The administrative audit trail (§15.7, §43).
 *
 * `audit.record(...)` is called from admin services, deliberately **not** from
 * middleware: middleware cannot know the semantic before/after of a change, and
 * an audit row that says "PATCH /settings 200" answers no useful question.
 *
 * It is also deliberately synchronous and inside the business transaction. If
 * the change committed, its audit record committed with it. An asynchronous
 * trail can lose exactly the record someone later needs.
 *
 * What is *not* audited: reads, and anything a customer does to their own data.
 * That is order history, not an audit trail — auditing everything produces a
 * log nobody reads.
 */
import { getContext } from '../../infrastructure/logging/context.js'
import { createLogger } from '../../infrastructure/logging/logger.js'
import { execute, query, queryOne } from '../../infrastructure/database/query.js'
import type { Actor } from '../../shared/auth/actor.js'
import type { AuditEntry, AuditFilter, AuditRecord } from './audit.types.js'

const log = createLogger('audit')

interface AuditRow {
  id: number
  actor_user_id: string | null
  actor_email: string | null
  actor_roles: string[]
  actor_ip: string | null
  action: string
  resource_type: string
  resource_id: string | null
  before: unknown
  after: unknown
  request_id: string | null
  created_at: Date
}

function toRecord(row: AuditRow): AuditRecord {
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    actorEmail: row.actor_email,
    actorRoles: row.actor_roles,
    actorIp: row.actor_ip,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    before: row.before as Record<string, unknown> | null,
    after: row.after as Record<string, unknown> | null,
    requestId: row.request_id,
    createdAt: row.created_at,
  }
}

/**
 * Fields never written to an audit row, whatever a caller passes. `before`/
 * `after` are diffs of business values; a credential in one would turn the
 * audit trail into a secret store (§15.4).
 */
const REDACTED_KEYS = new Set([
  'password',
  'passwordhash',
  'password_hash',
  'token',
  'accesstoken',
  'refreshtoken',
  'refresh_token_hash',
  'secret',
  'apikey',
  'api_key',
  'servicerolekey',
])

function scrub(value: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!value) return null
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    out[key] = REDACTED_KEYS.has(key.toLowerCase().replace(/[^a-z_]/g, '')) ? '[REDACTED]' : entry
  }
  return out
}

export const auditService = {
  /**
   * Writes one audit row using the ambient executor, so it joins whatever
   * transaction the caller is in (§18.1).
   */
  async record(entry: AuditEntry): Promise<void> {
    const context = getContext()
    const actor: Actor | null = entry.actor ?? null

    await execute(
      `INSERT INTO audit_logs
         (actor_user_id, actor_email, actor_roles, actor_ip, action,
          resource_type, resource_id, before, after, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        actor?.userId ?? null,
        actor?.email ?? null,
        actor ? [...actor.roles] : [],
        entry.ip ?? null,
        entry.action,
        entry.resourceType,
        entry.resourceId ?? null,
        JSON.stringify(scrub(entry.before)),
        JSON.stringify(scrub(entry.after)),
        context?.requestId ?? null,
      ],
      { name: 'audit.record' },
    )

    log.debug(
      { action: entry.action, resourceType: entry.resourceType, resourceId: entry.resourceId },
      'audit recorded',
    )
  },

  async list(filter: AuditFilter): Promise<{ rows: AuditRecord[]; total: number }> {
    const conditions: string[] = []
    const params: unknown[] = []

    const add = (sql: string, value: unknown) => {
      params.push(value)
      conditions.push(sql.replace('$?', `$${params.length}`))
    }

    if (filter.actorUserId) add('actor_user_id = $?', filter.actorUserId)
    if (filter.action) add('action = $?', filter.action)
    if (filter.resourceType) add('resource_type = $?', filter.resourceType)
    if (filter.resourceId) add('resource_id = $?', filter.resourceId)
    if (filter.from) add('created_at >= $?', filter.from)
    if (filter.to) add('created_at <= $?', filter.to)

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const rows = await query<AuditRow>(
      `SELECT * FROM audit_logs ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filter.limit, filter.offset],
      { name: 'audit.list' },
    )

    const totalRow = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM audit_logs ${where}`,
      params,
      { name: 'audit.count' },
    )

    return { rows: rows.map(toRecord), total: totalRow?.count ?? 0 }
  },

  /** Everything that ever happened to one record, oldest first. */
  async forResource(resourceType: string, resourceId: string): Promise<AuditRecord[]> {
    const rows = await query<AuditRow>(
      `SELECT * FROM audit_logs
        WHERE resource_type = $1 AND resource_id = $2
        ORDER BY created_at, id`,
      [resourceType, resourceId],
      { name: 'audit.forResource' },
    )
    return rows.map(toRecord)
  },
}

/**
 * Computes the `before`/`after` pair for an update, containing only the fields
 * that actually changed. A full-row snapshot on both sides makes the trail
 * unreadable and stores far more than the question needs.
 */
export function diffChanged<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): { before: Record<string, unknown>; after: Record<string, unknown> } | null {
  const changedBefore: Record<string, unknown> = {}
  const changedAfter: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(after)) {
    if (value === undefined) continue
    if (JSON.stringify(before[key]) === JSON.stringify(value)) continue
    changedBefore[key] = before[key]
    changedAfter[key] = value
  }

  return Object.keys(changedAfter).length > 0
    ? { before: changedBefore, after: changedAfter }
    : null
}
