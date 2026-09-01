/**
 * Storefront catalogue (§7.1).
 *
 * Public, unauthenticated, and deliberately narrow: it answers only what a
 * shopfront asks. Everything it returns has passed three gates — the product is
 * `active`, it is published to this channel, and the variant is sellable — so a
 * client cannot see, price or reference something that is not for sale.
 *
 * There is no admin data here and no way to reach any: the storefront
 * serializers are written separately from the admin ones for exactly that
 * reason (see catalogue.mapper.ts).
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import type { z } from 'zod'
import { ok, paginated } from '../../shared/http/respond.js'
import { buildPaginationMeta, toOffset } from '../../shared/http/pagination.js'
import { validate, validatedQuery } from '../../shared/middleware/validate.js'
import { NotFoundError } from '../../shared/errors/index.js'
import { productsService } from './products.service.js'
import { categoriesService, collectionsService } from './taxonomy.service.js'
import {
  publicCategoryTreeDto,
  publicCollectionDto,
  publicProductCardDto,
  publicProductDto,
  resolveAvailability,
} from './catalogue.mapper.js'
import { handleParam, storefrontProductListQuery } from './catalogue.validators.js'

/** One storefront today. The channel is named rather than assumed (§23.3). */
const CHANNEL = 'storefront'

export const catalogueStorefrontRoutes: ExpressRouter = Router()

catalogueStorefrontRoutes.get(
  '/products',
  validate({ query: storefrontProductListQuery }),
  async (req: Request, res: Response) => {
    const filter = validatedQuery<z.infer<typeof storefrontProductListQuery>>(req)
    const { limit, offset } = toOffset(filter)

    // Handles in, ids out: a storefront URL says `?category=burgers`, never a
    // uuid, and an unknown handle is an empty page rather than an error.
    const category = filter.category ? await categoriesService.getByHandle(filter.category) : undefined
    const collection = filter.collection
      ? await collectionsService.getByHandle(filter.collection)
      : undefined

    if ((filter.category && !category) || (filter.collection && !collection)) {
      return paginated(res, [], buildPaginationMeta(filter, 0))
    }

    // The shopper's vocabulary translated into the repository's. Kept here
    // rather than in the repository so the storefront's four choices stay a
    // storefront concern, and the admin's sort keys stay out of a public URL.
    const SORTS = {
      newest: { sort: 'created', direction: 'desc' },
      price_low: { sort: 'price', direction: 'asc' },
      price_high: { sort: 'price', direction: 'desc' },
      title: { sort: 'title', direction: 'asc' },
    } as const
    const chosen = filter.sort ? SORTS[filter.sort] : undefined

    const { rows, total } = await productsService.list({
      publishedOnly: true,
      channelKey: CHANNEL,
      ...(chosen ? { sort: chosen.sort, direction: chosen.direction } : {}),
      ...(filter.minPrice !== undefined ? { minPriceAmount: filter.minPrice } : {}),
      ...(filter.maxPrice !== undefined ? { maxPriceAmount: filter.maxPrice } : {}),
      ...(filter.inStock ? { inStockOnly: true } : {}),
      ...(category ? { categoryId: category.id } : {}),
      // A dynamic collection is filtered by its rules, not by a membership
      // table it has no rows in.
      ...(collection
        ? collection.type === 'manual'
          ? { collectionId: collection.id }
          : { collectionRules: collection.rules }
        : {}),
      ...(filter.q ? { query: filter.q } : {}),
      limit,
      offset,
    })

    const details = await Promise.all(rows.map((product) => productsService.detail(product.id)))
    // One availability query for the whole page, rather than one per card.
    const availability = await resolveAvailability(details)

    const cards = await Promise.all(
      details.map((detail) => publicProductCardDto(detail, availability)),
    )
    return paginated(res, cards, buildPaginationMeta(filter, total))
  },
)

/**
 * A product by handle, including handles it used to have.
 *
 * When the handle is a former one the response says so and names the canonical
 * handle, so the edge can answer 301 rather than serving one product at two
 * addresses (docs/catalogue-model.md §6).
 */
catalogueStorefrontRoutes.get(
  '/products/:handle',
  validate({ params: handleParam }),
  async (req: Request, res: Response) => {
    const { product, canonicalHandle, redirected } = await productsService.detailByHandle(
      req.params.handle as string,
      { channelKey: CHANNEL },
    )

    return ok(res, await publicProductDto(product), {
      canonicalHandle,
      ...(redirected ? { redirectedFrom: req.params.handle } : {}),
    })
  },
)

catalogueStorefrontRoutes.get('/categories', async (_req: Request, res: Response) => {
  const tree = await categoriesService.tree()
  return ok(res, tree.map(publicCategoryTreeDto))
})

catalogueStorefrontRoutes.get(
  '/categories/:handle',
  validate({ params: handleParam }),
  async (req: Request, res: Response) => {
    const category = await categoriesService.getByHandle(req.params.handle as string)
    if (!category || category.archivedAt || !category.isActive) {
      throw new NotFoundError('Category not found')
    }
    const breadcrumb = await categoriesService.breadcrumb(category.id)
    return ok(res, {
      ...publicCategoryTreeDto({ ...category, children: [] }),
      breadcrumb: breadcrumb.map((entry) => ({ name: entry.name, handle: entry.handle })),
    })
  },
)

catalogueStorefrontRoutes.get('/collections', async (_req: Request, res: Response) => {
  const collections = await collectionsService.list({ activeOnly: true })
  return ok(res, collections.map(publicCollectionDto))
})

catalogueStorefrontRoutes.get(
  '/collections/:handle',
  validate({ params: handleParam }),
  async (req: Request, res: Response) => {
    const collection = await collectionsService.getByHandle(req.params.handle as string)
    if (!collection || collection.archivedAt || !collection.isActive) {
      throw new NotFoundError('Collection not found')
    }
    return ok(res, publicCollectionDto(collection))
  },
)
