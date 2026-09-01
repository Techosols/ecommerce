/**
 * Admin routes for identity and access (§6.6).
 *
 * Every route carries an explicit permission on top of the router-level staff
 * requirement, so a new route is never protected only by the default deny.
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import { z } from 'zod'
import { accepted, created, ok, paginated } from '../../shared/http/respond.js'
import {
  buildPaginationMeta,
  offsetPaginationQuery,
  toOffset,
} from '../../shared/http/pagination.js'
import { validate, validatedQuery } from '../../shared/middleware/validate.js'
import { emailField } from '../../shared/validation/common.js'
import { requirePermission } from '../../shared/middleware/authorize.js'
import { requireActor } from '../../shared/middleware/authenticate.js'
import { authService } from '../auth/index.js'
import { invitationsService } from './users.invitations.js'
import { usersService } from './users.service.js'
import type { User } from './users.types.js'

const userIdParam = z.strictObject({ id: z.uuid() })

const assignRolesSchema = z.strictObject({
  roles: z
    .array(z.enum(['owner', 'admin', 'staff', 'customer']))
    .min(1)
    .max(4),
})

const setStatusSchema = z.strictObject({
  status: z.enum(['active', 'disabled']),
})

const inviteStaffSchema = z.strictObject({
  email: emailField,
  roles: z.array(z.enum(['owner', 'admin', 'staff'])).min(1).max(3),
  firstName: z.string().trim().min(1).max(100).optional(),
  lastName: z.string().trim().min(1).max(100).optional(),
})

function toStaffDto(user: User) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    status: user.status,
    emailVerified: user.emailVerified,
    roles: user.roles,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
  }
}

export const usersAdminRoutes: ExpressRouter = Router()

/** The role catalogue with its permissions — what the admin UI renders. */
usersAdminRoutes.get(
  '/roles',
  requirePermission('staff:read'),
  async (_req: Request, res: Response) => {
    return ok(res, await usersService.listRoles())
  },
)

usersAdminRoutes.get(
  '/staff',
  requirePermission('staff:read'),
  validate({ query: offsetPaginationQuery }),
  async (req: Request, res: Response) => {
    const pagination = validatedQuery<{ page: number; limit: number }>(req)
    const { rows, total } = await usersService.listStaff(toOffset(pagination))
    return paginated(res, rows.map(toStaffDto), buildPaginationMeta(pagination, total))
  },
)

usersAdminRoutes.patch(
  '/staff/:id/roles',
  requirePermission('roles:assign'),
  validate({ params: userIdParam, body: assignRolesSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const { roles } = req.body as { roles: string[] }
    const updated = await usersService.replaceRoles(req.params.id as string, roles, actor)
    return ok(res, toStaffDto(updated))
  },
)

usersAdminRoutes.patch(
  '/staff/:id/status',
  requirePermission('staff:write'),
  validate({ params: userIdParam, body: setStatusSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const { status } = req.body as { status: 'active' | 'disabled' }
    // Disabling an account revokes its sessions in the same call — a disabled
    // user holding a live refresh token would make "disabled" advisory.
    const updated = await usersService.setStatus(
      req.params.id as string,
      status,
      actor,
      (userId, reason) => authService.revokeAllSessions(userId, reason),
    )
    return ok(res, toStaffDto(updated))
  },
)

/**
 * Invites a staff member. The account is created with **no password**: only the
 * invitee ever sets one, from a single-use link. Nobody hands anyone a
 * temporary password to be reused or shared.
 */
usersAdminRoutes.post(
  '/staff',
  requirePermission('staff:write'),
  validate({ body: inviteStaffSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof inviteStaffSchema>

    const user = await invitationsService.invite(
      {
        email: body.email,
        roles: body.roles,
        ...(body.firstName ? { firstName: body.firstName } : {}),
        ...(body.lastName ? { lastName: body.lastName } : {}),
      },
      actor,
      { ip: req.ip ?? null },
    )

    return created(res, toStaffDto(user), `/api/v1/admin/staff/${user.id}`)
  },
)

usersAdminRoutes.post(
  '/staff/:id/resend-invitation',
  requirePermission('staff:write'),
  validate({ params: userIdParam }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    await invitationsService.resend(req.params.id as string, actor)
    return accepted(res, { message: 'Invitation sent.' })
  },
)
