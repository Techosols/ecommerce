import type { Actor } from '../../shared/auth/actor.js'

export interface AuditEntry {
  /** Null for a system action with no acting human. */
  actor?: Actor | null
  /** `resource.verb_past_tense` — matched by a CHECK constraint. */
  action: string
  resourceType: string
  resourceId?: string | null
  before?: Record<string, unknown>
  after?: Record<string, unknown>
  ip?: string | null
}

export interface AuditRecord {
  id: number
  actorUserId: string | null
  actorEmail: string | null
  actorRoles: string[]
  actorIp: string | null
  action: string
  resourceType: string
  resourceId: string | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  requestId: string | null
  createdAt: Date
}

export interface AuditFilter {
  actorUserId?: string
  action?: string
  resourceType?: string
  resourceId?: string
  from?: string
  to?: string
  limit: number
  offset: number
}
