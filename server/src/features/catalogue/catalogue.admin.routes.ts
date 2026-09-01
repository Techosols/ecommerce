/**
 * Catalogue administration (§7.1, §6.6).
 *
 * The routes are commerce actions, not table operations. `POST
 * /products/:id/publish` is a different decision from `PATCH /products/:id`,
 * with a different permission and a different set of rules, and modelling it as
 * `{ "published": true }` on a generic update would hide all of that.
 *
 * The same reasoning explains what is *absent*: there is no DELETE for a
 * product or a variant. Archiving is the only retirement, because an order line
 * will reference a variant id for as long as the order exists.
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import type { z } from 'zod'
import { accepted, created, noContent, ok, paginated } from '../../shared/http/respond.js'
import { buildPaginationMeta, toOffset } from '../../shared/http/pagination.js'
import { validate, validatedQuery } from '../../shared/middleware/validate.js'
import { requirePermission } from '../../shared/middleware/authorize.js'
import { requireActor } from '../../shared/middleware/authenticate.js'
import { NotFoundError } from '../../shared/errors/index.js'
import { productsService } from './products.service.js'
import { catalogueRepository } from './catalogue.repository.js'
import { mediaService } from '../media/index.js'
import { categoriesService, collectionsService } from './taxonomy.service.js'
import { ruleFieldCatalogue } from './products.rules.js'
import { settingsService } from '../settings/index.js'
import {
  adminCategoryDto,
  adminCollectionDto,
  adminProductDto,
  adminProductSummaryDto,
  adminVariantDto,
} from './catalogue.mapper.js'
import {
  addOptionSchema,
  addOptionValueSchema,
  updateOptionValueSchema,
  adminProductListQuery,
  attachMediaSchema,
  createCategorySchema,
  createCollectionSchema,
  createProductSchema,
  createVariantSchema,
  idParam,
  optionParam,
  optionValueParam,
  productMediaParam,
  publishSchema,
  reorderMediaSchema,
  replaceOptionsSchema,
  setCollectionProductsSchema,
  collectionProductsSchema,
  previewCollectionSchema,
  bulkProductActionSchema,
  updateCategorySchema,
  updateCollectionSchema,
  updateProductSchema,
  updateVariantSchema,
} from './catalogue.validators.js'

export const catalogueAdminRoutes: ExpressRouter = Router()

// ── Products ────────────────────────────────────────────────────────────────

catalogueAdminRoutes.get(
  '/products',
  requirePermission('catalog:read'),
  validate({ query: adminProductListQuery }),
  async (req: Request, res: Response) => {
    const filter = validatedQuery<z.infer<typeof adminProductListQuery>>(req)
    const { limit, offset } = toOffset(filter)

    const { rows, total } = await productsService.list({
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.categoryId ? { categoryId: filter.categoryId } : {}),
      ...(filter.collectionId ? { collectionId: filter.collectionId } : {}),
      ...(filter.q ? { query: filter.q } : {}),
      ...(filter.sort ? { sort: filter.sort } : {}),
      ...(filter.direction ? { direction: filter.direction } : {}),
      limit,
      offset,
    })

    // One extra query for the whole page — the picture, the variant count and
    // the stock — rather than one per row. Twenty rows is twenty products, and
    // a per-row lookup is how a listing that felt fine on a demo catalogue
    // becomes unusable on a real one.
    const summaries = await catalogueRepository.summariesFor(rows.map((row) => row.id))
    const mediaIds = [...new Set([...summaries.values()].map((s) => s.mediaId).filter(Boolean))]
    const urls = new Map(
      await Promise.all(
        mediaIds.map(async (id) => [id, await mediaService.urlForId(id as string)] as const),
      ),
    )

    return paginated(
      res,
      rows.map((row) => {
        const summary = summaries.get(row.id)
        return adminProductSummaryDto(row, {
          imageUrl: summary?.mediaId ? (urls.get(summary.mediaId) ?? null) : null,
          variantCount: summary?.variantCount ?? 0,
          available: summary?.available ?? null,
        })
      }),
      buildPaginationMeta(filter, total),
    )
  },
)

catalogueAdminRoutes.post(
  '/products',
  requirePermission('catalog:write'),
  validate({ body: createProductSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof createProductSchema>

    const product = await productsService.create(
      {
        title: body.title,
        variants: body.variants,
        ...(body.handle ? { handle: body.handle } : {}),
        ...(body.subtitle !== undefined ? { subtitle: body.subtitle } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.categoryId !== undefined ? { categoryId: body.categoryId } : {}),
        ...(body.productType !== undefined ? { productType: body.productType } : {}),
        ...(body.vendor !== undefined ? { vendor: body.vendor } : {}),
        ...(body.tags ? { tags: body.tags } : {}),
        ...(body.seoTitle !== undefined ? { seoTitle: body.seoTitle } : {}),
        ...(body.seoDescription !== undefined ? { seoDescription: body.seoDescription } : {}),
        ...(body.metadata ? { metadata: body.metadata } : {}),
        ...(body.options ? { options: body.options } : {}),
      },
      actor,
    )

    return created(res, await adminProductDto(product), `/api/v1/admin/products/${product.id}`)
  },
)

/**
 * One change across a selection of products.
 *
 * Returns a row per product rather than failing the batch: publishing refuses a
 * draft, and "one of these forty could not be published" with no way to find
 * out which is worse than useless. The response says what happened to each, and
 * the status is 200 even when some failed — the request itself succeeded.
 *
 * Declared before `/products/:id`, because `bulk` is not a uuid and a later
 * `POST /products/:id` would otherwise swallow it.
 */
catalogueAdminRoutes.post(
  '/products/bulk',
  requirePermission('catalog:write'),
  validate({ body: bulkProductActionSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof bulkProductActionSchema>

    const results = await productsService.bulk(body, actor, {
      addToCollection: (collectionId, productId) =>
        collectionsService.addProducts(collectionId, [productId], actor),
      removeFromCollection: (collectionId, productId) =>
        collectionsService.removeProducts(collectionId, [productId], actor),
    })

    return ok(res, {
      results,
      succeeded: results.filter((entry) => entry.ok).length,
      failed: results.filter((entry) => !entry.ok).length,
    })
  },
)

catalogueAdminRoutes.get(
  '/products/:id',
  requirePermission('catalog:read'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const product = await productsService.detail(req.params.id as string)
    return ok(res, await adminProductDto(product))
  },
)

catalogueAdminRoutes.patch(
  '/products/:id',
  requirePermission('catalog:write'),
  validate({ params: idParam, body: updateProductSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const product = await productsService.update(
      req.params.id as string,
      req.body as z.infer<typeof updateProductSchema>,
      actor,
    )
    return ok(res, await adminProductDto(product))
  },
)

/** Restructuring a product's axes of variation. Refused while variants live. */
catalogueAdminRoutes.put(
  '/products/:id/options',
  requirePermission('catalog:write'),
  validate({ params: idParam, body: replaceOptionsSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const { options } = req.body as z.infer<typeof replaceOptionsSchema>
    const product = await productsService.replaceOptions(req.params.id as string, options, actor)
    return ok(res, await adminProductDto(product))
  },
)

/**
 * Adds a new axis to a live product — "Colour" onto a product that had "Size".
 *
 * Unlike `PUT /options` this does not restructure anything: the new option is
 * appended, and `appliesToExisting` names the value every variant already on
 * the product takes on it. That field is required because there is no value the
 * server could invent for them, and a variant with a gap in its selection is
 * the one state the model does not allow.
 */
catalogueAdminRoutes.post(
  '/products/:id/options',
  requirePermission('catalog:write'),
  validate({ params: idParam, body: addOptionSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof addOptionSchema>
    const product = await productsService.addOption(req.params.id as string, body, actor)
    return created(res, await adminProductDto(product))
  },
)

/**
 * Appends a value to an existing option — "XL" onto Size.
 *
 * Additive, so unlike `PUT /options` it is safe on a live product: nothing
 * selects the new value yet, and every existing variant still chooses exactly
 * one value for every option. It creates no variants; which combinations are
 * worth stocking is a merchandising decision made through `POST /variants`.
 */
catalogueAdminRoutes.post(
  '/products/:id/options/:optionId/values',
  requirePermission('catalog:write'),
  validate({ params: optionParam, body: addOptionValueSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof addOptionValueSchema>
    const product = await productsService.addOptionValue(
      req.params.id as string,
      req.params.optionId as string,
      body.swatchHex === undefined ? body.value : { value: body.value, swatchHex: body.swatchHex },
      actor,
    )
    return created(res, await adminProductDto(product))
  },
)

/**
 * Sets what one option value looks like — the colour behind "Mulberry".
 *
 * Its own route rather than a field on the value-add endpoint, because a
 * merchant sets a colour long after the value exists, and because this is the
 * one option operation that is safe on a live product: it changes nothing about
 * which variants exist or what they select.
 *
 * `swatchHex: null` clears it, and the storefront goes back to showing the name.
 */
catalogueAdminRoutes.patch(
  '/products/:id/options/:optionId/values/:valueId',
  requirePermission('catalog:write'),
  validate({ params: optionValueParam, body: updateOptionValueSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const { swatchHex } = req.body as z.infer<typeof updateOptionValueSchema>
    const product = await productsService.setOptionValueSwatch(
      req.params.id as string,
      req.params.optionId as string,
      req.params.valueId as string,
      swatchHex,
      actor,
    )
    return ok(res, await adminProductDto(product))
  },
)

/** Removes a value nothing selects. Refused while any variant still records it. */
catalogueAdminRoutes.delete(
  '/products/:id/options/:optionId/values/:valueId',
  requirePermission('catalog:write'),
  validate({ params: optionValueParam }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const product = await productsService.removeOptionValue(
      req.params.id as string,
      req.params.optionId as string,
      req.params.valueId as string,
      actor,
    )
    return ok(res, await adminProductDto(product))
  },
)

// ── Lifecycle: three transitions, three decisions ───────────────────────────

catalogueAdminRoutes.post(
  '/products/:id/activate',
  requirePermission('catalog:write'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const product = await productsService.setStatus(req.params.id as string, 'active', actor)
    return ok(res, await adminProductDto(product))
  },
)

catalogueAdminRoutes.post(
  '/products/:id/archive',
  requirePermission('catalog:write'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const product = await productsService.setStatus(req.params.id as string, 'archived', actor)
    return ok(res, await adminProductDto(product))
  },
)

/** Restoring returns a product to `draft`: republishing is its own decision. */
catalogueAdminRoutes.post(
  '/products/:id/restore',
  requirePermission('catalog:write'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const product = await productsService.setStatus(req.params.id as string, 'draft', actor)
    return ok(res, await adminProductDto(product))
  },
)

// ── Publication: a separate permission, because it is a separate act ────────

catalogueAdminRoutes.post(
  '/products/:id/publish',
  requirePermission('catalog:publish'),
  validate({ params: idParam, body: publishSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const { channel } = req.body as z.infer<typeof publishSchema>
    const product = await productsService.publish(req.params.id as string, channel, actor)
    return ok(res, await adminProductDto(product))
  },
)

catalogueAdminRoutes.post(
  '/products/:id/unpublish',
  requirePermission('catalog:publish'),
  validate({ params: idParam, body: publishSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const { channel } = req.body as z.infer<typeof publishSchema>
    const product = await productsService.unpublish(req.params.id as string, channel, actor)
    return ok(res, await adminProductDto(product))
  },
)

// ── Variants ────────────────────────────────────────────────────────────────

catalogueAdminRoutes.post(
  '/products/:id/variants',
  requirePermission('catalog:write'),
  validate({ params: idParam, body: createVariantSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const variant = await productsService.addVariant(
      req.params.id as string,
      req.body as z.infer<typeof createVariantSchema>,
      actor,
    )
    return created(res, adminVariantDto(variant), `/api/v1/admin/variants/${variant.id}`)
  },
)

catalogueAdminRoutes.get(
  '/variants/:id',
  requirePermission('catalog:read'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const product = await productsService.detail(
      (await requireVariantProductId(req.params.id as string)),
    )
    const variant = product.variants.find((entry) => entry.id === req.params.id)
    if (!variant) throw new NotFoundError('Variant not found')
    return ok(res, adminVariantDto(variant))
  },
)

catalogueAdminRoutes.patch(
  '/variants/:id',
  requirePermission('catalog:write'),
  validate({ params: idParam, body: updateVariantSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const variant = await productsService.updateVariant(
      req.params.id as string,
      req.body as z.infer<typeof updateVariantSchema>,
      actor,
    )
    return ok(res, adminVariantDto(variant))
  },
)

/**
 * Archives a variant. DELETE is the verb because that is what an operator means
 * and what a REST client expects; the *effect* is an archive, and the 204 says
 * nothing was destroyed.
 */
catalogueAdminRoutes.delete(
  '/variants/:id',
  requirePermission('catalog:write'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    await productsService.archiveVariant(req.params.id as string, actor)
    return noContent(res)
  },
)

// ── Product media ───────────────────────────────────────────────────────────

catalogueAdminRoutes.post(
  '/products/:id/media',
  requirePermission('catalog:write'),
  validate({ params: idParam, body: attachMediaSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof attachMediaSchema>
    const product = await productsService.attachMedia(
      req.params.id as string,
      {
        mediaId: body.mediaId,
        ...(body.alt !== undefined ? { alt: body.alt } : {}),
        ...(body.isPrimary !== undefined ? { isPrimary: body.isPrimary } : {}),
      },
      actor,
    )
    return created(res, await adminProductDto(product))
  },
)

catalogueAdminRoutes.put(
  '/products/:id/media/order',
  requirePermission('catalog:write'),
  validate({ params: idParam, body: reorderMediaSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const { order, primaryId } = req.body as z.infer<typeof reorderMediaSchema>
    const product = await productsService.reorderMedia(
      req.params.id as string,
      order,
      primaryId,
      actor,
    )
    return ok(res, await adminProductDto(product))
  },
)

catalogueAdminRoutes.delete(
  '/products/:id/media/:mediaId',
  requirePermission('catalog:write'),
  validate({ params: productMediaParam }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    await productsService.detachMedia(
      req.params.id as string,
      req.params.mediaId as string,
      actor,
    )
    return noContent(res)
  },
)

// ── Categories ──────────────────────────────────────────────────────────────

catalogueAdminRoutes.get(
  '/categories',
  requirePermission('catalog:read'),
  async (_req: Request, res: Response) => {
    const categories = await categoriesService.list()
    return ok(res, categories.map(adminCategoryDto))
  },
)

catalogueAdminRoutes.post(
  '/categories',
  requirePermission('catalog:write'),
  validate({ body: createCategorySchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const category = await categoriesService.create(
      req.body as z.infer<typeof createCategorySchema>,
      actor,
    )
    return created(res, adminCategoryDto(category), `/api/v1/admin/categories/${category.id}`)
  },
)

catalogueAdminRoutes.patch(
  '/categories/:id',
  requirePermission('catalog:write'),
  validate({ params: idParam, body: updateCategorySchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const category = await categoriesService.update(
      req.params.id as string,
      req.body as z.infer<typeof updateCategorySchema>,
      actor,
    )
    return ok(res, adminCategoryDto(category))
  },
)

catalogueAdminRoutes.delete(
  '/categories/:id',
  requirePermission('catalog:write'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    await categoriesService.archive(req.params.id as string, actor)
    return noContent(res)
  },
)

// ── Collections ─────────────────────────────────────────────────────────────
//
// Declared before `/collections/:id`, because neither `rules` nor `preview` is
// a uuid and both would otherwise be matched as one.

/** The field table the admin's rule builder is generated from. */
catalogueAdminRoutes.get(
  '/collections/rules/fields',
  requirePermission('catalog:read'),
  async (_req: Request, res: Response) => {
    return ok(res, ruleFieldCatalogue())
  },
)

/** What an unsaved rule set would match. The only question a preview answers. */
catalogueAdminRoutes.post(
  '/collections/preview',
  requirePermission('catalog:read'),
  validate({ body: previewCollectionSchema }),
  async (req: Request, res: Response) => {
    const { rules } = req.body as z.infer<typeof previewCollectionSchema>
    const { currency } = await settingsService.get()
    return ok(res, await collectionsService.preview(rules, 8, currency))
  },
)

catalogueAdminRoutes.get(
  '/collections',
  requirePermission('catalog:read'),
  async (_req: Request, res: Response) => {
    const { currency } = await settingsService.get()
    const collections = await collectionsService.list()
    // One count per collection. A shop has a handful of collections, not
    // thousands, and a smart one's count is a query by definition — there is no
    // stored number to join against.
    return ok(
      res,
      await Promise.all(
        collections.map(async (collection) => ({
          ...adminCollectionDto(collection, currency),
          productCount: await collectionsService.productCount(collection.id),
        })),
      ),
    )
  },
)

catalogueAdminRoutes.post(
  '/collections',
  requirePermission('catalog:write'),
  validate({ body: createCollectionSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const collection = await collectionsService.create(
      req.body as z.infer<typeof createCollectionSchema>,
      actor,
    )
    const { currency } = await settingsService.get()
    return created(
      res,
      adminCollectionDto(collection, currency),
      `/api/v1/admin/collections/${collection.id}`,
    )
  },
)

catalogueAdminRoutes.get(
  '/collections/:id',
  requirePermission('catalog:read'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const collection = await collectionsService.getById(req.params.id as string)
    if (!collection) throw new NotFoundError('Collection not found')
    const { currency } = await settingsService.get()
    const productIds = await collectionsService.productIds(collection.id)
    return ok(res, { ...adminCollectionDto(collection, currency), productIds })
  },
)

catalogueAdminRoutes.patch(
  '/collections/:id',
  requirePermission('catalog:write'),
  validate({ params: idParam, body: updateCollectionSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const collection = await collectionsService.update(
      req.params.id as string,
      req.body as z.infer<typeof updateCollectionSchema>,
      actor,
    )
    const { currency } = await settingsService.get()
    return ok(res, adminCollectionDto(collection, currency))
  },
)

/**
 * Sets a collection's membership and order in one call.
 *
 * PUT rather than add/remove endpoints because the order *is* the content: a
 * merchandiser arranges a list, and reconstructing that arrangement from a
 * stream of individual moves is how the order drifts from what they intended.
 */
catalogueAdminRoutes.put(
  '/collections/:id/products',
  requirePermission('catalog:write'),
  validate({ params: idParam, body: setCollectionProductsSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const { productIds } = req.body as z.infer<typeof setCollectionProductsSchema>
    const stored = await collectionsService.setProducts(req.params.id as string, productIds, actor)
    return accepted(res, { productIds: stored })
  },
)

/**
 * Adds products without resending the whole list.
 *
 * Alongside the PUT above rather than instead of it. Reordering is wholesale
 * because the order is the content; adding four products chosen on the product
 * list is not, and making that caller fetch and resend the existing membership
 * is how two people editing at once silently undo each other.
 */
catalogueAdminRoutes.post(
  '/collections/:id/products',
  requirePermission('catalog:write'),
  validate({ params: idParam, body: collectionProductsSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const { productIds } = req.body as z.infer<typeof collectionProductsSchema>
    const stored = await collectionsService.addProducts(req.params.id as string, productIds, actor)
    return ok(res, { productIds: stored })
  },
)

catalogueAdminRoutes.delete(
  '/collections/:id/products',
  requirePermission('catalog:write'),
  validate({ params: idParam, body: collectionProductsSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const { productIds } = req.body as z.infer<typeof collectionProductsSchema>
    const stored = await collectionsService.removeProducts(
      req.params.id as string,
      productIds,
      actor,
    )
    return ok(res, { productIds: stored })
  },
)

catalogueAdminRoutes.delete(
  '/collections/:id',
  requirePermission('catalog:write'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    await collectionsService.archive(req.params.id as string, actor)
    return noContent(res)
  },
)

/** The collections one product is in — manual membership and rule matches alike. */
catalogueAdminRoutes.get(
  '/products/:id/collections',
  requirePermission('catalog:read'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const { currency } = await settingsService.get()
    const collections = await collectionsService.forProduct(req.params.id as string)
    return ok(
      res,
      collections.map((collection) => ({
        ...adminCollectionDto(collection, currency),
        matchedByRules: collection.matchedByRules,
      })),
    )
  },
)

// ── Helpers ─────────────────────────────────────────────────────────────────

async function requireVariantProductId(variantId: string): Promise<string> {
  const variant = await catalogueRepository.findVariantById(variantId)
  if (!variant) throw new NotFoundError('Variant not found')
  return variant.productId
}
