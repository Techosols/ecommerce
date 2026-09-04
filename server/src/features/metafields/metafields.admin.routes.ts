/**
 * Custom fields: defining them, and filling them in (§7.1).
 *
 * ── Two different permissions, on purpose ────────────────────────────────────
 *
 * **Defining** a field is store configuration — what shape this shop's records
 * have — so it sits behind `settings:read` / `settings:write`, beside the rest
 * of the store's setup.
 *
 * **Filling one in** is editing the record it belongs to, so it takes that
 * record's own permission: a product's custom fields need `catalog:write`, a
 * customer's need `customers:write`, an order's need `orders:write`.
 *
 * Collapsing these into one permission is the mistake worth avoiding. Under a
 * single `metafields:write`, whoever can define a field could also write to a
 * customer record — and "custom fields" would become a way around the
 * permission on the data itself. Under `settings:write` alone, the merchandiser
 * who actually knows the ingredients could not type them in.
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import type { z } from 'zod'
import { created, ok } from '../../shared/http/respond.js'
import { validate, validatedQuery } from '../../shared/middleware/validate.js'
import { requirePermission } from '../../shared/middleware/authorize.js'
import { requireActor } from '../../shared/middleware/authenticate.js'
import { AuthorizationError } from '../../shared/errors/index.js'
import { metafieldsService } from './metafields.service.js'
import {
  createDefinitionSchema,
  definitionListQuery,
  idParam,
  ownerParams,
  setValuesSchema,
  updateDefinitionSchema,
} from './metafields.validators.js'
import type { MetafieldOwnerType } from './metafields.types.js'

export const metafieldsAdminRoutes: ExpressRouter = Router()

/** Which permission governs the record a field is being written to. */
const OWNER_PERMISSIONS: Record<MetafieldOwnerType, { read: string; write: string }> = {
  product: { read: 'catalog:read', write: 'catalog:write' },
  variant: { read: 'catalog:read', write: 'catalog:write' },
  collection: { read: 'catalog:read', write: 'catalog:write' },
  customer: { read: 'customers:read', write: 'customers:write' },
  order: { read: 'orders:read', write: 'orders:write' },
}

/**
 * Checked in the handler rather than as middleware, because which permission
 * applies depends on a path parameter that middleware would have to re-parse.
 * The refusal is identical either way.
 */
function assertMayTouchOwner(req: Request, ownerType: MetafieldOwnerType, mode: 'read' | 'write') {
  const actor = requireActor(req)
  const permission = OWNER_PERMISSIONS[ownerType][mode]
  if (!actor.can(permission)) {
    throw new AuthorizationError(`You do not have permission to ${mode} this record`)
  }
  return actor
}

// ── Definitions ─────────────────────────────────────────────────────────────

metafieldsAdminRoutes.get(
  '/metafields/definitions',
  requirePermission('settings:read'),
  validate({ query: definitionListQuery }),
  async (req: Request, res: Response) => {
    const filter = validatedQuery<z.infer<typeof definitionListQuery>>(req)
    return ok(res, await metafieldsService.listDefinitions(filter.ownerType))
  },
)

metafieldsAdminRoutes.post(
  '/metafields/definitions',
  requirePermission('settings:write'),
  validate({ body: createDefinitionSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof createDefinitionSchema>
    const definition = await metafieldsService.createDefinition(
      {
        ownerType: body.ownerType,
        namespace: body.namespace,
        key: body.key,
        name: body.name,
        description: body.description ?? null,
        type: body.type,
        ...(body.validations ? { validations: body.validations } : {}),
        ...(body.required === undefined ? {} : { required: body.required }),
        ...(body.storefrontVisible === undefined
          ? {}
          : { storefrontVisible: body.storefrontVisible }),
        ...(body.position === undefined ? {} : { position: body.position }),
      },
      actor,
    )
    return created(res, definition, `/api/v1/admin/metafields/definitions/${definition.id}`)
  },
)

metafieldsAdminRoutes.patch(
  '/metafields/definitions/:id',
  requirePermission('settings:write'),
  validate({ params: idParam, body: updateDefinitionSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const definition = await metafieldsService.updateDefinition(
      req.params.id as string,
      req.body as z.infer<typeof updateDefinitionSchema>,
      actor,
    )
    return ok(res, definition)
  },
)

/**
 * Deletes a field and every value under it.
 *
 * Returns how many values went with it rather than 204, so the admin can say
 * "the field and its 340 values are gone" instead of leaving an operator to
 * wonder what they just did.
 */
metafieldsAdminRoutes.delete(
  '/metafields/definitions/:id',
  requirePermission('settings:write'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const result = await metafieldsService.deleteDefinition(req.params.id as string, actor)
    return ok(res, result)
  },
)

// ── Values ──────────────────────────────────────────────────────────────────

metafieldsAdminRoutes.get(
  '/metafields/:ownerType/:ownerId',
  validate({ params: ownerParams }),
  async (req: Request, res: Response) => {
    const params = req.params as unknown as z.infer<typeof ownerParams>
    assertMayTouchOwner(req, params.ownerType, 'read')

    const values = await metafieldsService.valuesFor(params.ownerType, params.ownerId)
    return ok(
      res,
      values.map((entry) => ({
        definitionId: entry.definitionId,
        namespace: entry.namespace,
        key: entry.key,
        name: entry.name,
        description: entry.definition.description,
        type: entry.type,
        validations: entry.definition.validations,
        required: entry.definition.required,
        storefrontVisible: entry.definition.storefrontVisible,
        value: entry.value,
        updatedAt: entry.updatedAt.toISOString(),
      })),
    )
  },
)

metafieldsAdminRoutes.put(
  '/metafields/:ownerType/:ownerId',
  validate({ params: ownerParams, body: setValuesSchema }),
  async (req: Request, res: Response) => {
    const params = req.params as unknown as z.infer<typeof ownerParams>
    const actor = assertMayTouchOwner(req, params.ownerType, 'write')
    const body = req.body as z.infer<typeof setValuesSchema>

    const values = await metafieldsService.setValues(
      params.ownerType,
      params.ownerId,
      body.values,
      actor,
    )
    return ok(
      res,
      values.map((entry) => ({
        definitionId: entry.definitionId,
        namespace: entry.namespace,
        key: entry.key,
        name: entry.name,
        type: entry.type,
        value: entry.value,
        updatedAt: entry.updatedAt.toISOString(),
      })),
    )
  },
)
