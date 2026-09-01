/**
 * Saved customer segments (§12).
 *
 * A segment is a rule set with a name. It holds no membership: the rules are
 * compiled to SQL and run on every read, because a stored list of members is
 * correct until the next order and then it is a list of customers who *used
 * to* match — the one thing a segment must never be.
 *
 * Everything about how a rule becomes SQL lives in `segments.rules.ts`; this
 * file is the storage and the plumbing around it.
 */
import { v7 as uuidv7 } from 'uuid'
import { execute, query, queryOne } from '../../infrastructure/database/query.js'
import { createLogger } from '../../infrastructure/logging/logger.js'
import type { Actor } from '../../shared/auth/actor.js'
import { ConflictError, ERROR_CODES, NotFoundError } from '../../shared/errors/index.js'
import { auditService } from '../audit/index.js'
import { registerConstraintError } from '../../infrastructure/database/errors.js'
import { compileRules, describeRules, parseRules, type RuleSet } from './segments.rules.js'

const log = createLogger('customers.segments')

registerConstraintError(
  'customer_segments_name_idx',
  ERROR_CODES.ALREADY_EXISTS,
  'A segment with that name already exists',
)

export interface CustomerSegment {
  id: string
  name: string
  description: string | null
  rules: RuleSet
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

interface SegmentRow {
  id: string
  name: string
  description: string | null
  rules: unknown
  is_active: boolean
  created_at: Date
  updated_at: Date
}

function toSegment(row: SegmentRow): CustomerSegment {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    rules: parseRules(row.rules),
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * The predicate every segment query runs against.
 *
 * Customers are `users` rows holding the `customer` role and no staff role —
 * the same definition the customer list uses, kept here so a segment can never
 * quietly include the shop's own staff.
 */
const CUSTOMER_PREDICATE = `
  EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
           WHERE ur.user_id = u.id AND r.key = 'customer')
  AND NOT EXISTS (SELECT 1 FROM user_roles ur2 JOIN roles r2 ON r2.id = ur2.role_id
                   WHERE ur2.user_id = u.id AND r2.key IN ('staff','admin','owner'))`

export const segmentsService = {
  async list(): Promise<Array<CustomerSegment & { memberCount: number; summary: string }>> {
    const rows = await query<SegmentRow>(
      `SELECT * FROM customer_segments ORDER BY name`,
      [],
      { name: 'segments.list' },
    )

    // One count per segment. A join would need the rules compiled into a single
    // query, which is not possible when each has its own parameters — and a
    // shop has a handful of segments, not thousands.
    return Promise.all(
      rows.map(async (row) => {
        const segment = toSegment(row)
        return {
          ...segment,
          memberCount: await this.countMembers(segment.rules),
          summary: describeRules(segment.rules),
        }
      }),
    )
  },

  async getById(id: string): Promise<CustomerSegment> {
    const row = await queryOne<SegmentRow>(`SELECT * FROM customer_segments WHERE id = $1`, [id], {
      name: 'segments.getById',
    })
    if (!row) throw new NotFoundError('Segment not found')
    return toSegment(row)
  },

  async create(
    input: { name: string; description?: string | null; rules: RuleSet; isActive?: boolean },
    actor: Actor,
  ): Promise<CustomerSegment> {
    // Compiled before it is stored, so a rule set that cannot become SQL is
    // refused at the boundary rather than blowing up on the first read.
    compileRules(input.rules)

    const id = uuidv7()
    await execute(
      `INSERT INTO customer_segments (id, name, description, rules, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        id,
        input.name.trim(),
        input.description ?? null,
        JSON.stringify(input.rules),
        input.isActive ?? true,
        actor.userId,
      ],
      { name: 'segments.create' },
    )

    await auditService.record({
      actor,
      action: 'customer_segment.created',
      resourceType: 'customer_segment',
      resourceId: id,
      after: { name: input.name, rules: input.rules },
    })

    log.info({ segmentId: id, name: input.name }, 'segment created')
    return this.getById(id)
  },

  async update(
    id: string,
    patch: { name?: string; description?: string | null; rules?: RuleSet; isActive?: boolean },
    actor: Actor,
  ): Promise<CustomerSegment> {
    const before = await this.getById(id)
    if (patch.rules) compileRules(patch.rules)

    const columns: Array<[string, unknown]> = []
    if (patch.name !== undefined) columns.push(['name', patch.name.trim()])
    if (patch.description !== undefined) columns.push(['description', patch.description])
    if (patch.rules !== undefined) columns.push(['rules', JSON.stringify(patch.rules)])
    if (patch.isActive !== undefined) columns.push(['is_active', patch.isActive])
    if (columns.length === 0) return before

    const params: unknown[] = [id]
    const sets = columns.map(([column, value]) => {
      params.push(value)
      return `${column} = $${params.length}`
    })

    await execute(`UPDATE customer_segments SET ${sets.join(', ')} WHERE id = $1`, params, {
      name: 'segments.update',
    })

    await auditService.record({
      actor,
      action: 'customer_segment.updated',
      resourceType: 'customer_segment',
      resourceId: id,
      before: { name: before.name, rules: before.rules },
      after: patch,
    })
    return this.getById(id)
  },

  async remove(id: string, actor: Actor): Promise<void> {
    const before = await this.getById(id)
    const affected = await execute(`DELETE FROM customer_segments WHERE id = $1`, [id], {
      name: 'segments.delete',
    })
    if (affected === 0) throw new ConflictError('That segment was already deleted')

    await auditService.record({
      actor,
      action: 'customer_segment.deleted',
      resourceType: 'customer_segment',
      resourceId: id,
      before: { name: before.name },
    })
  },

  // ── Evaluation ────────────────────────────────────────────────────────────

  async countMembers(rules: RuleSet): Promise<number> {
    const compiled = compileRules(rules)
    const row = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM users u
        WHERE ${CUSTOMER_PREDICATE} ${compiled.where ? `AND ${compiled.where}` : ''}`,
      compiled.params,
      { name: 'segments.countMembers' },
    )
    return row?.count ?? 0
  },

  /**
   * What a rule set would match, without saving it.
   *
   * A count and a handful of names: enough to tell whether the rules mean what
   * the person writing them thinks, which is the only question a preview
   * answers.
   */
  async preview(rules: RuleSet, sampleSize = 5) {
    const compiled = compileRules(rules)
    const sample = await query<{ id: string; email: string; first_name: string | null; last_name: string | null }>(
      `SELECT u.id, u.email, u.first_name, u.last_name FROM users u
        WHERE ${CUSTOMER_PREDICATE} ${compiled.where ? `AND ${compiled.where}` : ''}
        ORDER BY u.total_spent_cents DESC, u.id
        LIMIT ${Math.max(1, Math.min(20, sampleSize))}`,
      compiled.params,
      { name: 'segments.previewSample' },
    )

    return {
      memberCount: await this.countMembers(rules),
      summary: describeRules(rules),
      sample: sample.map((row) => ({
        id: row.id,
        email: row.email,
        name: [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || null,
      })),
    }
  },

  /** The ids a segment currently matches, for narrowing the customer list. */
  async memberIds(id: string): Promise<string[]> {
    const segment = await this.getById(id)
    const compiled = compileRules(segment.rules)
    const rows = await query<{ id: string }>(
      `SELECT u.id FROM users u
        WHERE ${CUSTOMER_PREDICATE} ${compiled.where ? `AND ${compiled.where}` : ''}`,
      compiled.params,
      { name: 'segments.memberIds' },
    )
    return rows.map((row) => row.id)
  },

  /**
   * A segment as a SQL fragment, for splicing into the customer list query.
   *
   * Returning the fragment rather than the ids keeps the filter to one query
   * instead of one query and an `IN (...)` list that grows with the shop.
   */
  async asFilter(id: string, startAt: number): Promise<{ where: string; params: unknown[] }> {
    const segment = await this.getById(id)
    const compiled = compileRules(segment.rules, startAt)
    return { where: compiled.where ?? 'TRUE', params: compiled.params }
  },
}
