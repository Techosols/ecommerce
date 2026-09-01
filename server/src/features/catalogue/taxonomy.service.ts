/**
 * Categories and collections (docs/catalogue-model.md §4).
 *
 * Two things that look alike and are not:
 *
 *   **Category** answers *what kind of product is this?* — a tree, one node per
 *   product, structural, changes rarely.
 *
 *   **Collection** answers *which products belong together?* — flat,
 *   many-to-many, and the order of products inside it is editorial content that
 *   someone chose.
 *
 * They are separate tables because unifying them means every query afterwards
 * carries a `WHERE kind = …` that nothing enforces, and the tree constraint
 * only ever applies to one of the two.
 */
import { v7 as uuidv7 } from 'uuid'
import { publish } from '../../events/index.js'
import { withTransaction } from '../../infrastructure/database/transaction.js'
import { createLogger } from '../../infrastructure/logging/logger.js'
import { TtlCache } from '../../infrastructure/cache/memory.js'
import type { Actor } from '../../shared/auth/actor.js'
import {
  ConflictError,
  DomainRuleError,
  ERROR_CODES,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/index.js'
import { auditService, diffChanged } from '../audit/index.js'
import { mediaService } from '../media/index.js'
import { catalogueRepository as repo } from './catalogue.repository.js'
import { invalidateProduct } from './products.service.js'
import { assertUsableHandle, slugify } from './handles.js'
import { compileRules, describeRules } from './products.rules.js'
import type { RuleSet } from './products.rules.js'
import type {
  Category,
  CategoryNode,
  Collection,
  CollectionType,
} from './catalogue.types.js'

/** A collection with no conditions. Every manual collection has exactly this. */
const EMPTY_RULES: RuleSet = { match: 'all', conditions: [] }

const log = createLogger('catalogue.taxonomy')

/** The tree is read on every storefront page and changes a few times a year. */
const treeCache = new TtlCache<CategoryNode[]>({ ttlMs: 300_000, maxEntries: 4 })
const TREE_KEY = 'active'

/** How deep a category tree may go. Depth is navigation, not data modelling. */
const MAX_DEPTH = 5

async function resolveImage(mediaId: string | null | undefined): Promise<string | null> {
  if (!mediaId) return null
  const asset = await mediaService.getById(mediaId)
  if (!asset) throw new ValidationError('That media asset does not exist')
  mediaService.assertReady(asset)
  return mediaId
}

export const categoriesService = {
  async list(options: { activeOnly?: boolean } = {}): Promise<Category[]> {
    return repo.listCategories(options)
  },

  /** The active tree, assembled once and cached for the storefront. */
  async tree(): Promise<CategoryNode[]> {
    return treeCache.getOrLoad(TREE_KEY, async () => {
      const flat = await repo.listCategories({ activeOnly: true })
      const nodes = new Map<string, CategoryNode>(
        flat.map((category) => [category.id, { ...category, children: [] }]),
      )

      const roots: CategoryNode[] = []
      for (const node of nodes.values()) {
        const parent = node.parentId ? nodes.get(node.parentId) : undefined
        // A node whose parent is inactive is promoted to a root rather than
        // dropped: hiding a parent must not hide the whole branch by accident.
        if (parent) parent.children.push(node)
        else roots.push(node)
      }
      return roots
    })
  },

  async getById(id: string): Promise<Category | undefined> {
    return repo.findCategoryById(id)
  },

  async getByHandle(handle: string): Promise<Category | undefined> {
    return repo.findCategoryByHandle(handle)
  },

  async breadcrumb(categoryId: string): Promise<Category[]> {
    const category = await repo.findCategoryById(categoryId)
    if (!category) return []
    const ancestors = await repo.ancestorsOf(categoryId)
    return [...ancestors.reverse(), category]
  },

  async create(
    input: {
      name: string
      handle?: string
      parentId?: string | null
      description?: string | null
      imageId?: string | null
      position?: number
    },
    actor: Actor,
  ): Promise<Category> {
    const handle = input.handle ?? slugify(input.name)
    assertUsableHandle(handle)

    if (input.parentId) await this.assertDepthAllows(input.parentId)
    const imageId = await resolveImage(input.imageId)

    const category = await withTransaction(async () => {
      const created = await repo.createCategory({
        id: uuidv7(),
        parentId: input.parentId ?? null,
        name: input.name.trim(),
        handle,
        description: input.description ?? null,
        imageId,
        position: input.position ?? 0,
      })
      await auditService.record({
        actor,
        action: 'category.created',
        resourceType: 'category',
        resourceId: created.id,
        after: { name: created.name, handle: created.handle, parentId: created.parentId },
      })
      await publish(
        'category.created',
        { categoryId: created.id, handle: created.handle, actorId: actor.userId },
        { aggregateId: created.id, actorUserId: actor.userId },
      )
      return created
    })

    treeCache.clear()
    return category
  },

  async update(
    id: string,
    patch: {
      name?: string
      handle?: string
      parentId?: string | null
      description?: string | null
      imageId?: string | null
      position?: number
      isActive?: boolean
    },
    actor: Actor,
  ): Promise<Category> {
    const before = await repo.findCategoryById(id)
    if (!before) throw new NotFoundError('Category not found')

    if (patch.handle) assertUsableHandle(patch.handle)
    if (patch.parentId !== undefined && patch.parentId !== null) {
      if (patch.parentId === id) {
        throw new DomainRuleError(ERROR_CODES.CATEGORY_CYCLE, 'A category cannot be its own parent')
      }
      // A tree that contains a cycle is no longer a tree, and every recursive
      // read of it becomes a bounded lie or an infinite loop.
      const ancestors = await repo.ancestorsOf(patch.parentId)
      if (ancestors.some((ancestor) => ancestor.id === id) || patch.parentId === id) {
        throw new DomainRuleError(
          ERROR_CODES.CATEGORY_CYCLE,
          'That move would put the category inside its own subtree',
        )
      }
      await this.assertDepthAllows(patch.parentId)
    }
    if (patch.imageId) await resolveImage(patch.imageId)

    const updated = await withTransaction(async () => {
      const next = await repo.updateCategory(id, patch)
      const changed = diffChanged(before as unknown as Record<string, unknown>, patch)
      if (changed) {
        await auditService.record({
          actor,
          action: 'category.updated',
          resourceType: 'category',
          resourceId: id,
          before: changed.before,
          after: changed.after,
        })
      }
      return next
    })

    treeCache.clear()
    if (!updated) throw new NotFoundError('Category not found')
    return updated
  },

  /**
   * Archives a category.
   *
   * Refuses while products or child categories still point at it. Cascading
   * would silently re-classify products, and re-classification is a decision
   * someone should make on purpose.
   */
  async archive(id: string, actor: Actor): Promise<void> {
    const category = await repo.findCategoryById(id)
    if (!category) throw new NotFoundError('Category not found')

    const products = await repo.countProductsInCategory(id)
    if (products > 0) {
      throw new ConflictError(
        `${products} product(s) are still in this category — move them first`,
        { code: ERROR_CODES.CATEGORY_IN_USE },
      )
    }
    const children = await repo.countChildCategories(id)
    if (children > 0) {
      throw new ConflictError('This category still has sub-categories', {
        code: ERROR_CODES.CATEGORY_IN_USE,
      })
    }

    await withTransaction(async () => {
      await repo.archiveCategory(id)
      await auditService.record({
        actor,
        action: 'category.archived',
        resourceType: 'category',
        resourceId: id,
        before: { name: category.name, handle: category.handle },
      })
    })

    treeCache.clear()
    log.info({ categoryId: id, actorId: actor.userId }, 'category archived')
  },

  async assertDepthAllows(parentId: string): Promise<void> {
    const parent = await repo.findCategoryById(parentId)
    if (!parent || parent.archivedAt) throw new ValidationError('That parent category does not exist')

    const ancestors = await repo.ancestorsOf(parentId)
    if (ancestors.length + 1 >= MAX_DEPTH) {
      throw new DomainRuleError(
        ERROR_CODES.DOMAIN_RULE_VIOLATION,
        `A category tree may be at most ${MAX_DEPTH} levels deep`,
      )
    }
  },

  clearCache(): void {
    treeCache.clear()
  },
}

export const collectionsService = {
  async list(options: { activeOnly?: boolean } = {}): Promise<Collection[]> {
    return repo.listCollections(options)
  },

  async getById(id: string): Promise<Collection | undefined> {
    return repo.findCollectionById(id)
  },

  async getByHandle(handle: string): Promise<Collection | undefined> {
    return repo.findCollectionByHandle(handle)
  },

  async create(
    input: {
      title: string
      handle?: string
      description?: string | null
      imageId?: string | null
      position?: number
      seoTitle?: string | null
      seoDescription?: string | null
      productIds?: string[]
      type?: CollectionType
      rules?: RuleSet
    },
    actor: Actor,
  ): Promise<Collection> {
    const handle = input.handle ?? slugify(input.title)
    assertUsableHandle(handle)
    const imageId = await resolveImage(input.imageId)

    const type = input.type ?? 'manual'
    const rules = type === 'dynamic' ? (input.rules ?? EMPTY_RULES) : EMPTY_RULES
    // Compiled before it is stored, so a rule set that cannot become SQL is
    // refused at the boundary rather than blowing up on the first read.
    if (type === 'dynamic') compileRules(rules)
    if (type === 'dynamic' && input.productIds?.length) {
      throw new ValidationError(
        'A smart collection cannot be given products; its rules decide what is in it',
      )
    }

    const collection = await withTransaction(async () => {
      const created = await repo.createCollection({
        id: uuidv7(),
        handle,
        title: input.title.trim(),
        description: input.description ?? null,
        imageId,
        position: input.position ?? 0,
        seoTitle: input.seoTitle ?? null,
        seoDescription: input.seoDescription ?? null,
        type,
        rules,
      })
      if (input.productIds && input.productIds.length > 0) {
        await repo.replaceCollectionProducts(created.id, input.productIds)
      }
      await auditService.record({
        actor,
        action: 'collection.created',
        resourceType: 'collection',
        resourceId: created.id,
        after: { title: created.title, handle: created.handle },
      })
      await publish(
        'collection.created',
        { collectionId: created.id, handle: created.handle, actorId: actor.userId },
        { aggregateId: created.id, actorUserId: actor.userId },
      )
      return created
    })

    return collection
  },

  async update(
    id: string,
    patch: {
      title?: string
      handle?: string
      description?: string | null
      imageId?: string | null
      position?: number
      isActive?: boolean
      seoTitle?: string | null
      seoDescription?: string | null
      type?: CollectionType
      rules?: RuleSet
    },
    actor: Actor,
  ): Promise<Collection> {
    const before = await repo.findCollectionById(id)
    if (!before) throw new NotFoundError('Collection not found')
    if (patch.handle) assertUsableHandle(patch.handle)
    if (patch.imageId) await resolveImage(patch.imageId)

    // What the collection will be once this patch lands, which is what the
    // rules have to be consistent with — not what it is now.
    const type = patch.type ?? before.type
    const rules = patch.rules ?? before.rules
    if (type === 'dynamic') compileRules(rules)

    const stored: Record<string, unknown> = { ...patch }
    if (patch.rules !== undefined || patch.type !== undefined) {
      // Switching to manual clears the rules rather than leaving conditions
      // that no longer do anything — the database refuses the alternative, and
      // this is the honest reading of "it is a manual collection now".
      stored.rules = JSON.stringify(type === 'dynamic' ? rules : EMPTY_RULES)
    }

    // Turning a manual collection into a smart one drops the hand-picked
    // members, because from that moment the rules are the membership and a
    // leftover row would be a product nobody could explain.
    const droppingMembers = type === 'dynamic' && before.type === 'manual'

    const updated = await withTransaction(async () => {
      if (droppingMembers) await repo.replaceCollectionProducts(id, [])
      const next = await repo.updateCollection(id, stored)
      const changed = diffChanged(before as unknown as Record<string, unknown>, patch)
      if (changed) {
        await auditService.record({
          actor,
          action: 'collection.updated',
          resourceType: 'collection',
          resourceId: id,
          before: changed.before,
          after: changed.after,
        })
      }
      return next
    })

    if (!updated) throw new NotFoundError('Collection not found')
    return updated
  },

  /**
   * Replaces a collection's membership and order in one move.
   *
   * Wholesale rather than add/remove endpoints because the order *is* the
   * content: "Best Sellers" is a list someone arranged, and reconstructing that
   * arrangement from a stream of individual moves is how orders drift.
   */
  async setProducts(id: string, productIds: string[], actor: Actor): Promise<string[]> {
    const collection = await repo.findCollectionById(id)
    if (!collection) throw new NotFoundError('Collection not found')

    const unique = [...new Set(productIds)]
    if (unique.length !== productIds.length) {
      throw new ValidationError('The same product appears more than once')
    }
    for (const productId of unique) {
      const product = await repo.findProductById(productId)
      if (!product) throw new ValidationError(`Product ${productId} does not exist`)
    }

    const affected = await withTransaction(async () => {
      const before = await repo.productIdsInCollection(id)
      await repo.replaceCollectionProducts(id, unique)
      await auditService.record({
        actor,
        action: 'collection.products_changed',
        resourceType: 'collection',
        resourceId: id,
        before: { count: before.length },
        after: { count: unique.length },
      })
      await publish(
        'collection.products_changed',
        { collectionId: id, productCount: unique.length, actorId: actor.userId },
        { aggregateId: id, actorUserId: actor.userId },
      )
      // Both sides of the change: a product that left the collection is as
      // stale as one that joined it.
      return [...new Set([...before, ...unique])]
    })

    // A cached product detail carries its collection membership, so membership
    // changes are product changes as far as the cache is concerned.
    for (const productId of affected) invalidateProduct(productId)

    return unique
  },

  /**
   * What is in a collection, whichever kind it is.
   *
   * The caller should not have to branch on `type`: "show me this collection's
   * products" is one question, and the difference between a list somebody
   * arranged and a list a rule found is this method's business, not theirs.
   */
  async productIds(id: string, options: { limit?: number; offset?: number } = {}): Promise<string[]> {
    const collection = await repo.findCollectionById(id)
    if (!collection) throw new NotFoundError('Collection not found')

    if (collection.type === 'manual') return repo.productIdsInCollection(id)
    return repo.productIdsMatching(collection.rules, options)
  },

  /** How many products a collection holds. A query for both kinds. */
  async productCount(id: string): Promise<number> {
    const collection = await repo.findCollectionById(id)
    if (!collection) throw new NotFoundError('Collection not found')

    if (collection.type === 'manual') {
      return (await repo.productIdsInCollection(id)).length
    }
    return repo.countProductsMatching(collection.rules)
  },

  /**
   * What a rule set would match, without saving it.
   *
   * A count and a handful of ids: enough to tell whether the rules mean what
   * the person writing them thinks, which is the only question a preview
   * answers.
   */
  async preview(rules: RuleSet, sampleSize = 8, currency?: string) {
    const ids = await repo.productIdsMatching(rules, {
      limit: Math.max(1, Math.min(24, sampleSize)),
    })

    // Named, not just counted. A sample of UUIDs answers the question "how
    // many" and not the question the preview exists for — "did I mean these?"
    const sample = await Promise.all(ids.map((id) => repo.findProductById(id)))

    return {
      productCount: await repo.countProductsMatching(rules),
      summary: describeRules(rules, currency ? { currency } : {}),
      products: sample
        .filter((product): product is NonNullable<typeof product> => Boolean(product))
        .map((product) => ({ id: product.id, title: product.title, handle: product.handle })),
    }
  },

  /**
   * Adds products to a manual collection.
   *
   * Alongside `setProducts` rather than instead of it: reordering is a
   * wholesale replace because the order is the content, but "add these four
   * from the product list" should not require the caller to know, and resend,
   * everything already in the collection.
   */
  async addProducts(id: string, productIds: string[], actor: Actor): Promise<string[]> {
    const collection = await this.assertManual(id)
    const unique = [...new Set(productIds)]
    for (const productId of unique) {
      const product = await repo.findProductById(productId)
      if (!product) throw new ValidationError(`Product ${productId} does not exist`)
    }

    await withTransaction(async () => {
      await repo.addCollectionProducts(id, unique)
      await auditService.record({
        actor,
        action: 'collection.products_added',
        resourceType: 'collection',
        resourceId: id,
        after: { productIds: unique },
      })
    })

    for (const productId of unique) invalidateProduct(productId)
    log.info({ collectionId: id, added: unique.length, title: collection.title }, 'products added')
    return repo.productIdsInCollection(id)
  },

  async removeProducts(id: string, productIds: string[], actor: Actor): Promise<string[]> {
    await this.assertManual(id)
    const unique = [...new Set(productIds)]

    await withTransaction(async () => {
      await repo.removeCollectionProducts(id, unique)
      await auditService.record({
        actor,
        action: 'collection.products_removed',
        resourceType: 'collection',
        resourceId: id,
        before: { productIds: unique },
      })
    })

    for (const productId of unique) invalidateProduct(productId)
    return repo.productIdsInCollection(id)
  },

  /**
   * The collections one product is in, both kinds.
   *
   * The smart ones are worked out by running each rule set against this one
   * product, which is a cheap `EXISTS` per dynamic collection — a shop has a
   * handful of them, not thousands. Storing the answer would mean recomputing
   * it from every write path that can change a product, a variant or its stock.
   */
  async forProduct(productId: string): Promise<Array<Collection & { matchedByRules: boolean }>> {
    const manual = await repo.manualCollectionsForProduct(productId)
    const dynamic = await repo.dynamicCollections()

    const matched: Array<Collection & { matchedByRules: boolean }> = []
    for (const collection of dynamic) {
      if (await repo.productMatchesRules(productId, collection.rules)) {
        matched.push({ ...collection, matchedByRules: true })
      }
    }

    return [...manual.map((entry) => ({ ...entry, matchedByRules: false })), ...matched]
  },

  /**
   * Refuses a membership change on a collection whose membership is its rules.
   *
   * The database refuses it too — that is what the trigger in 0024 is for —
   * but a 422 saying why is a better answer than a constraint violation.
   */
  async assertManual(id: string): Promise<Collection> {
    const collection = await repo.findCollectionById(id)
    if (!collection) throw new NotFoundError('Collection not found')
    if (collection.type === 'dynamic') {
      throw new DomainRuleError(
        ERROR_CODES.DOMAIN_RULE_VIOLATION,
        'This is a smart collection; edit its rules rather than its products',
      )
    }
    return collection
  },

  async archive(id: string, actor: Actor): Promise<void> {
    const collection = await repo.findCollectionById(id)
    if (!collection) throw new NotFoundError('Collection not found')

    await withTransaction(async () => {
      // Membership survives: archiving a collection hides a grouping, it does
      // not un-group the products, and restoring it should restore the list.
      await repo.archiveCollection(id)
      await auditService.record({
        actor,
        action: 'collection.archived',
        resourceType: 'collection',
        resourceId: id,
        before: { title: collection.title, handle: collection.handle },
      })
    })
  },
}
