/**
 * Media administration (§23.4).
 *
 * The three-step upload lives here. Note what the API never accepts: a bucket,
 * a path, a key, or a file's bytes. It takes a *claim* about what is coming,
 * hands back a place to put it, and inspects what arrives (§16.3).
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import { z } from 'zod'
import { accepted, noContent, ok, paginated } from '../../shared/http/respond.js'
import {
  buildPaginationMeta,
  offsetPaginationQuery,
  toOffset,
} from '../../shared/http/pagination.js'
import { validate, validatedQuery } from '../../shared/middleware/validate.js'
import { requirePermission } from '../../shared/middleware/authorize.js'
import { requireActor } from '../../shared/middleware/authenticate.js'
import { NotFoundError } from '../../shared/errors/index.js'
import { env } from '../../config/index.js'
import { ALLOWED_IMAGE_TYPES } from '../../infrastructure/storage/index.js'
import { mediaService } from './media.service.js'
import type { MediaAsset, MediaStatus } from './media.types.js'

const mediaIdParam = z.strictObject({ id: z.uuid() })

const requestUploadSchema = z.strictObject({
  // An allowlist, so an unsupported type is rejected before a key is generated.
  contentType: z.enum(Object.keys(ALLOWED_IMAGE_TYPES) as [string, ...string[]]),
  byteSize: z.number().int().positive().max(env.MEDIA_MAX_BYTES),
  filename: z.string().max(255).optional(),
  alt: z.string().max(500).optional(),
})

const updateMediaSchema = z.strictObject({
  alt: z.string().max(500).nullable(),
})

const listMediaQuery = offsetPaginationQuery.extend({
  status: z.enum(['pending', 'processing', 'ready', 'failed']).optional(),
})

async function toDto(asset: MediaAsset) {
  const dto: Record<string, unknown> = {
    id: asset.id,
    status: asset.status,
    mimeType: asset.mimeType,
    byteSize: asset.byteSize,
    width: asset.width,
    height: asset.height,
    originalFilename: asset.originalFilename,
    alt: asset.alt,
    failureReason: asset.failureReason,
    createdAt: asset.createdAt.toISOString(),
    updatedAt: asset.updatedAt.toISOString(),
  }

  // URLs only once the bytes have been inspected and re-encoded. Handing out a
  // URL for a `pending` object would publish unverified content.
  if (asset.status === 'ready') {
    const urls = await mediaService.urlsFor(asset)
    dto.url = urls.url
    dto.variants = urls.variants
  }
  return dto
}

export const mediaAdminRoutes: ExpressRouter = Router()

/** Step 1: reserve a key and hand back a short-lived upload URL. */
mediaAdminRoutes.post(
  '/media/uploads',
  requirePermission('catalog:write'),
  validate({ body: requestUploadSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof requestUploadSchema>

    const ticket = await mediaService.requestUpload({
      contentType: body.contentType,
      byteSize: body.byteSize,
      ...(body.filename ? { filename: body.filename } : {}),
      ...(body.alt ? { alt: body.alt } : {}),
      actor,
    })

    return accepted(res, {
      assetId: ticket.assetId,
      upload: {
        url: ticket.uploadUrl,
        method: ticket.method,
        token: ticket.uploadToken,
        expiresAt: ticket.expiresAt.toISOString(),
      },
      // Echoed so a client can confirm the server chose the path, not them.
      storageKey: ticket.storageKey,
    })
  },
)

/** Step 3: inspect what arrived and queue processing. */
mediaAdminRoutes.post(
  '/media/:id/complete',
  requirePermission('catalog:write'),
  validate({ params: mediaIdParam }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const asset = await mediaService.completeUpload(req.params.id as string, actor)
    return accepted(res, await toDto(asset))
  },
)

mediaAdminRoutes.get(
  '/media',
  requirePermission('catalog:read'),
  validate({ query: listMediaQuery }),
  async (req: Request, res: Response) => {
    const filter = validatedQuery<{ page: number; limit: number; status?: MediaStatus }>(req)
    const { limit, offset } = toOffset(filter)

    const { rows, total } = await mediaService.list({
      ...(filter.status ? { status: filter.status } : {}),
      limit,
      offset,
    })

    return paginated(res, await Promise.all(rows.map(toDto)), buildPaginationMeta(filter, total))
  },
)

mediaAdminRoutes.get(
  '/media/:id',
  requirePermission('catalog:read'),
  validate({ params: mediaIdParam }),
  async (req: Request, res: Response) => {
    const asset = await mediaService.getById(req.params.id as string)
    if (!asset) throw new NotFoundError('Media asset not found')
    return ok(res, await toDto(asset))
  },
)

mediaAdminRoutes.patch(
  '/media/:id',
  requirePermission('catalog:write'),
  validate({ params: mediaIdParam, body: updateMediaSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const { alt } = req.body as { alt: string | null }
    const asset = await mediaService.updateAlt(req.params.id as string, alt, actor)
    return ok(res, await toDto(asset))
  },
)

mediaAdminRoutes.delete(
  '/media/:id',
  requirePermission('catalog:write'),
  validate({ params: mediaIdParam }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    await mediaService.delete(req.params.id as string, actor)
    return noContent(res)
  },
)
