/**
 * Audit trail queries (§43). Owner-only: the trail records what people with
 * power did, so reading it is itself a privileged act.
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import { z } from 'zod'
import { paginated } from '../../shared/http/respond.js'
import {
  buildPaginationMeta,
  offsetPaginationQuery,
  toOffset,
} from '../../shared/http/pagination.js'
import { validate, validatedQuery } from '../../shared/middleware/validate.js'
import { requirePermission } from '../../shared/middleware/authorize.js'
import { auditService } from './audit.service.js'
import type { AuditRecord } from './audit.types.js'

const auditQuery = offsetPaginationQuery.extend({
  actorUserId: z.uuid().optional(),
  action: z
    .string()
    .max(64)
    .regex(/^[a-z_]+\.[a-z_]+$/)
    .optional(),
  resourceType: z.string().max(64).optional(),
  resourceId: z.string().max(128).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
})

function toDto(record: AuditRecord) {
  return {
    id: String(record.id),
    action: record.action,
    resourceType: record.resourceType,
    resourceId: record.resourceId,
    actor: {
      userId: record.actorUserId,
      email: record.actorEmail,
      roles: record.actorRoles,
      ip: record.actorIp,
    },
    before: record.before,
    after: record.after,
    requestId: record.requestId,
    createdAt: record.createdAt.toISOString(),
  }
}

export const auditAdminRoutes: ExpressRouter = Router()

auditAdminRoutes.get(
  '/audit-logs',
  requirePermission('audit:read'),
  validate({ query: auditQuery }),
  async (req: Request, res: Response) => {
    const filter = validatedQuery<z.infer<typeof auditQuery>>(req)
    const { limit, offset } = toOffset(filter)

    const { rows, total } = await auditService.list({
      ...(filter.actorUserId ? { actorUserId: filter.actorUserId } : {}),
      ...(filter.action ? { action: filter.action } : {}),
      ...(filter.resourceType ? { resourceType: filter.resourceType } : {}),
      ...(filter.resourceId ? { resourceId: filter.resourceId } : {}),
      ...(filter.from ? { from: filter.from } : {}),
      ...(filter.to ? { to: filter.to } : {}),
      limit,
      offset,
    })

    return paginated(res, rows.map(toDto), buildPaginationMeta(filter, total))
  },
)
