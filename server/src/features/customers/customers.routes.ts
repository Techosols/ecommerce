/**
 * Customer self-service (§7.1, CLAUDE.md §12).
 *
 * Every route here is scoped to the authenticated Actor. There is no
 * `/customers/:id` on this surface at all — not guarded, absent — because the
 * safest way to prevent one customer reading another's address book is for the
 * route to have no way to name somebody else.
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import type { z } from 'zod'
import { created, noContent, ok } from '../../shared/http/respond.js'
import { validate } from '../../shared/middleware/validate.js'
import { authenticate, requireActor } from '../../shared/middleware/authenticate.js'
import { customersService } from './customers.service.js'
import { addressDto, profileDto } from './customers.mapper.js'
import { addressSchema, idParam, updateAddressSchema, updateProfileSchema } from './customers.validators.js'

export const customersStorefrontRoutes: ExpressRouter = Router()

customersStorefrontRoutes.get(
  '/account',
  authenticate(),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    return ok(res, profileDto(await customersService.getById(actor.userId)))
  },
)

customersStorefrontRoutes.patch(
  '/account',
  authenticate(),
  validate({ body: updateProfileSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const updated = await customersService.updateProfile(
      actor,
      req.body as z.infer<typeof updateProfileSchema>,
    )
    return ok(res, profileDto(updated))
  },
)

customersStorefrontRoutes.get(
  '/account/addresses',
  authenticate(),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const addresses = await customersService.listAddresses(actor.userId)
    return ok(res, addresses.map(addressDto))
  },
)

customersStorefrontRoutes.post(
  '/account/addresses',
  authenticate(),
  validate({ body: addressSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const address = await customersService.createAddress(
      actor.userId,
      req.body as z.infer<typeof addressSchema>,
    )
    return created(res, addressDto(address))
  },
)

customersStorefrontRoutes.get(
  '/account/addresses/:id',
  authenticate(),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const address = await customersService.getAddress(actor.userId, req.params.id as string)
    return ok(res, addressDto(address))
  },
)

customersStorefrontRoutes.patch(
  '/account/addresses/:id',
  authenticate(),
  validate({ params: idParam, body: updateAddressSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const address = await customersService.updateAddress(
      actor.userId,
      req.params.id as string,
      req.body as z.infer<typeof updateAddressSchema>,
    )
    return ok(res, addressDto(address))
  },
)

customersStorefrontRoutes.delete(
  '/account/addresses/:id',
  authenticate(),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    await customersService.archiveAddress(actor.userId, req.params.id as string)
    return noContent(res)
  },
)
