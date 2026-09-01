/**
 * Products, options and variants (§23.3, docs/catalogue-model.md).
 *
 * The invariants this file exists to hold — the ones SQL cannot express without
 * triggers:
 *
 *   • **Every product has at least one live variant.** A product with none is
 *     unbuyable but looks fine in the admin, which is the worst kind of broken.
 *     A product with no options gets a single variant titled `Default`.
 *   • **A variant selects a value for every option, exactly once.** The database
 *     enforces "at most one per option" and "the value belongs to the option";
 *     "one for *each* option" is checked here.
 *   • **Nothing is destroyed.** Archive, never delete: an order line will
 *     reference a variant id for as long as the order exists.
 *   • **Publication requires an active product.** Publishing a draft would put
 *     an unfinished item in front of customers.
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
import { inventoryService } from '../inventory/index.js'
import { catalogueRepository as repo } from './catalogue.repository.js'
import { handles } from './handles.js'
import { assertPriceAcceptable, storeCurrency } from './pricing.js'
import type {
  CreateProductInput,
  CreateVariantInput,
  OptionValueInput,
  Product,
  ProductDetail,
  ProductListFilter,
  ProductOption,
  ProductStatus,
  ProductVariant,
  UpdateProductInput,
  UpdateVariantInput,
} from './catalogue.types.js'

const log = createLogger('catalogue.products')

/**
 * Storefront reads are the hot path and the catalogue changes a few times a
 * day, so a resolved product detail is cached briefly. Invalidated explicitly on
 * every write *and* by the `catalogue.changed` event, because the API and the
 * worker are separate processes each holding their own copy (§23.14).
 */
const detailCache = new TtlCache<ProductDetail>({ ttlMs: 60_000, maxEntries: 500 })

function cacheKey(productId: string): string {
  return `product:${productId}`
}

export function invalidateProduct(productId: string): void {
  detailCache.invalidate(cacheKey(productId))
}

/**
 * The most axes one product may vary on, matching `createProductSchema`.
 *
 * Three is not arbitrary: every axis multiplies the variant count, and the
 * combination space of a fourth is where a catalogue stops being editable by a
 * person. Shopify draws the same line.
 */
export const MAX_OPTIONS = 3

/**
 * The fingerprint that makes "no two variants share a combination" a database
 * constraint rather than a hope. Sorted, so `{Size:L, Crust:Thin}` and
 * `{Crust:Thin, Size:L}` are the same variant — which they are.
 */
export function optionSignature(optionValueIds: string[]): string {
  return [...optionValueIds].sort().join('|')
}

/**
 * An archived product is frozen. Restoring it is the way back, and making that
 * an explicit step is what stops an edit quietly resurrecting a retired item.
 */
function assertNotArchived(product: Product): void {
  if (product.status === 'archived') {
    throw new DomainRuleError(
      ERROR_CODES.PRODUCT_ARCHIVED,
      'An archived product cannot be edited; restore it first',
    )
  }
}

/**
 * Flattens the two shapes into one, so every caller below reads the same thing.
 *
 * The alternative — branching at each of the four places a value is written —
 * is four chances to handle the string case and forget the object one.
 */
function readOptionValue(input: OptionValueInput): { value: string; swatchHex: string | null } {
  if (typeof input === 'string') return { value: input.trim(), swatchHex: null }
  return { value: input.value.trim(), swatchHex: input.swatchHex ?? null }
}

export const productsService = {
  // ── Reading ───────────────────────────────────────────────────────────────

  /**
   * A product with everything needed to render it.
   *
   * Assembled from small indexed queries rather than one wide join: a product
   * with 3 options, 6 variants and 4 images would return 72 rows to be
   * de-duplicated in JavaScript.
   */
  async detail(productId: string, options: { fresh?: boolean } = {}): Promise<ProductDetail> {
    if (!options.fresh) {
      const cached = detailCache.get(cacheKey(productId))
      if (cached) return cached
    }

    const product = await repo.findProductById(productId)
    if (!product) throw new NotFoundError('Product not found')

    const [optionRows, variants, media, publications, collectionIds, selections] = await Promise.all(
      [
        repo.optionsFor(productId),
        repo.variantsFor(productId),
        repo.mediaFor(productId),
        repo.publicationsFor(productId),
        repo.collectionIdsFor(productId),
        repo.selectionsFor(productId),
      ],
    )

    const byVariant = new Map<string, ProductVariant['selections']>()
    for (const row of selections) {
      const list = byVariant.get(row.variant_id) ?? []
      list.push({
        optionId: row.option_id,
        optionName: row.option_name,
        optionValueId: row.option_value_id,
        value: row.value,
      })
      byVariant.set(row.variant_id, list)
    }

    const detail: ProductDetail = {
      ...product,
      options: optionRows,
      variants: variants.map((variant) => ({
        ...variant,
        selections: byVariant.get(variant.id) ?? [],
      })),
      media,
      publications,
      collectionIds,
      category: product.categoryId ? ((await repo.findCategoryById(product.categoryId)) ?? null) : null,
    }

    detailCache.set(cacheKey(productId), detail)
    return detail
  },

  /**
   * Storefront lookup by handle, including handles the product used to have.
   *
   * `canonicalHandle` differing from the requested one is the edge's cue to
   * answer 301: one canonical URL per product, without breaking the old link.
   */
  async detailByHandle(
    handle: string,
    options: { channelKey: string },
  ): Promise<{ product: ProductDetail; canonicalHandle: string; redirected: boolean }> {
    const resolved = await handles.resolve(handle)
    if (!resolved) throw new NotFoundError('Product not found')

    const published = await repo.isPublishedOn(resolved.productId, options.channelKey)
    const product = await this.detail(resolved.productId)

    // Unpublished and non-active products are invisible to the storefront, and
    // indistinguishable from products that never existed. A 403 here would
    // confirm that a handle is real, which is a small catalogue leak.
    if (!published || product.status !== 'active') throw new NotFoundError('Product not found')

    return {
      product,
      canonicalHandle: resolved.currentHandle,
      redirected: !resolved.isCurrent,
    }
  },

  async list(filter: ProductListFilter): Promise<{ rows: Product[]; total: number }> {
    return repo.listProducts(filter)
  },

  async getById(productId: string): Promise<Product | undefined> {
    return repo.findProductById(productId)
  },

  // ── Creating ──────────────────────────────────────────────────────────────

  /**
   * Creates a product with its options and variants in one transaction.
   *
   * All-or-nothing on purpose: a product that committed without its variants is
   * a product nobody can buy, and it would look perfectly normal in a listing.
   */
  async create(input: CreateProductInput, actor: Actor): Promise<ProductDetail> {
    const currency = await storeCurrency()

    // Validate every price before opening a transaction: argon-slow work and
    // avoidable rollbacks both belong outside one.
    for (const variant of input.variants ?? []) {
      await assertPriceAcceptable({
        amount: variant.priceAmount,
        compareAtAmount: variant.compareAtAmount ?? null,
        ...(variant.currency ? { currency: variant.currency } : {}),
      })
    }
    if (input.categoryId) await this.assertCategoryExists(input.categoryId)

    const productId = uuidv7()
    const handle = input.handle ?? (await handles.suggest(input.title))

    await withTransaction(async () => {
      await repo.createProduct({
        id: productId,
        handle,
        title: input.title.trim(),
        subtitle: input.subtitle ?? null,
        description: input.description ?? null,
        categoryId: input.categoryId ?? null,
        productType: input.productType ?? null,
        vendor: input.vendor ?? null,
        tags: input.tags ?? [],
        seoTitle: input.seoTitle ?? null,
        seoDescription: input.seoDescription ?? null,
        metadata: input.metadata ?? {},
        createdBy: actor.userId,
      })
      await handles.claim(productId, handle)

      const options = await this.writeOptions(productId, input.options ?? [])
      await this.writeVariants(productId, options, input.variants ?? [], currency)

      await auditService.record({
        actor,
        action: 'product.created',
        resourceType: 'product',
        resourceId: productId,
        after: { handle, title: input.title, status: 'draft' },
      })
      await publish(
        'product.created',
        { productId, handle, title: input.title.trim(), actorId: actor.userId },
        { aggregateId: productId, actorUserId: actor.userId },
      )
    })

    log.info({ productId, handle, actorId: actor.userId }, 'product created')
    return this.detail(productId, { fresh: true })
  },

  /**
   * Writes a product's options and their values. Returns them resolved, so the
   * variant writer can map `{ "Size": "Large" }` onto ids without a re-read.
   */
  async writeOptions(
    productId: string,
    options: { name: string; values: OptionValueInput[] }[],
  ): Promise<ProductOption[]> {
    const seen = new Set<string>()

    for (const [index, option] of options.entries()) {
      const name = option.name.trim()
      if (seen.has(name.toLowerCase())) {
        throw new ValidationError(`Duplicate option name "${name}"`)
      }
      seen.add(name.toLowerCase())

      if (option.values.length === 0) {
        throw new ValidationError(`Option "${name}" needs at least one value`)
      }
      const optionId = uuidv7()
      await repo.insertOption({ id: optionId, productId, name, position: index })

      const values = new Set<string>()
      for (const [valueIndex, raw] of option.values.entries()) {
        const { value, swatchHex } = readOptionValue(raw)
        if (values.has(value.toLowerCase())) {
          throw new ValidationError(`Duplicate value "${value}" on option "${name}"`)
        }
        values.add(value.toLowerCase())
        await repo.insertOptionValue({
          id: uuidv7(),
          optionId,
          value,
          position: valueIndex,
          swatchHex,
        })
      }
    }

    return repo.optionsFor(productId)
  },

  /**
   * Writes variants, resolving each one's `{ optionName: value }` selection to
   * ids and computing the signature the unique constraint keys on.
   */
  async writeVariants(
    productId: string,
    options: ProductOption[],
    variants: CreateVariantInput[],
    currency: string,
  ): Promise<void> {
    // A product with no options is still purchasable: it gets one variant. This
    // is the rule that makes a single-SKU item and a 6-way t-shirt the same
    // shape everywhere downstream.
    if (variants.length === 0) {
      if (options.length > 0) {
        throw new ValidationError(
          'A product with options needs at least one variant that selects them',
        )
      }
      throw new ValidationError('A product needs at least one variant, with a price')
    }

    for (const [index, variant] of variants.entries()) {
      const { valueIds, byOption, title } = this.resolveSelection(
        options,
        variant.options ?? {},
        variant.title,
      )

      const created = await repo.insertVariant({
        id: uuidv7(),
        productId,
        title,
        sku: variant.sku?.trim() || null,
        barcode: variant.barcode?.trim() || null,
        priceAmount: variant.priceAmount,
        compareAtAmount: variant.compareAtAmount ?? null,
        currency: variant.currency ?? currency,
        weightGrams: variant.weightGrams ?? 0,
        requiresShipping: variant.requiresShipping ?? true,
        position: variant.position ?? index,
        isActive: variant.isActive ?? true,
        optionSignature: optionSignature(valueIds),
      })

      for (const [optionId, optionValueId] of Object.entries(byOption)) {
        await repo.insertVariantSelection({
          variantId: created.id,
          optionId,
          optionValueId,
        })
      }

      // Every purchasable thing is trackable from the moment it exists, so
      // "a variant with no inventory item" is not a state anyone has to reason
      // about. Same transaction: a variant without its item would be a variant
      // nothing can stock.
      await inventoryService.ensureItemForVariant(created.id)
    }
  },

  /**
   * Maps `{ "Size": "Large", "Crust": "Thin" }` onto option-value ids.
   *
   * Rejects a selection that misses an option or names one the product does not
   * have. The database already refuses two values for one option and a value
   * belonging to a different option; "a value for *every* option" is the part
   * that needs a service.
   */
  resolveSelection(
    options: ProductOption[],
    selection: Record<string, string>,
    explicitTitle?: string,
  ): { valueIds: string[]; byOption: Record<string, string>; title: string } {
    const byOption: Record<string, string> = {}
    const ids: string[] = []
    const titleParts: string[] = []

    const supplied = new Set(Object.keys(selection).map((name) => name.toLowerCase()))
    for (const name of supplied) {
      if (!options.some((option) => option.name.toLowerCase() === name)) {
        throw new DomainRuleError(
          ERROR_CODES.INVALID_OPTION_SELECTION,
          `This product has no option named "${name}"`,
        )
      }
    }

    for (const option of options) {
      const chosen = Object.entries(selection).find(
        ([name]) => name.toLowerCase() === option.name.toLowerCase(),
      )?.[1]

      if (chosen === undefined) {
        throw new DomainRuleError(
          ERROR_CODES.INVALID_OPTION_SELECTION,
          `Every variant must choose a value for "${option.name}"`,
        )
      }
      const value = option.values.find(
        (candidate) => candidate.value.toLowerCase() === chosen.trim().toLowerCase(),
      )
      if (!value) {
        throw new DomainRuleError(
          ERROR_CODES.INVALID_OPTION_SELECTION,
          `"${chosen}" is not a value of "${option.name}"`,
        )
      }

      byOption[option.id] = value.id
      ids.push(value.id)
      titleParts.push(value.value)
    }

    return {
      valueIds: ids,
      byOption,
      // "Large / Thin" reads better than "Variant 3" on an order line, and the
      // order line is where this title ends up living forever.
      title: explicitTitle?.trim() || (titleParts.length > 0 ? titleParts.join(' / ') : 'Default'),
    }
  },

  // ── Updating ──────────────────────────────────────────────────────────────

  async update(productId: string, patch: UpdateProductInput, actor: Actor): Promise<ProductDetail> {
    const before = await repo.findProductById(productId)
    if (!before) throw new NotFoundError('Product not found')
    if (before.status === 'archived') {
      throw new DomainRuleError(
        ERROR_CODES.PRODUCT_ARCHIVED,
        'An archived product cannot be edited; restore it first',
      )
    }
    if (patch.categoryId) await this.assertCategoryExists(patch.categoryId)

    await withTransaction(async () => {
      if (patch.handle && patch.handle !== before.handle) {
        await handles.rename(productId, patch.handle)
        await repo.setProductHandle(productId, patch.handle)
      }
      await repo.updateProduct(productId, { ...patch, handle: undefined } as Record<string, unknown>)

      const changed = diffChanged(
        before as unknown as Record<string, unknown>,
        patch as Record<string, unknown>,
      )
      if (changed) {
        await auditService.record({
          actor,
          action: 'product.updated',
          resourceType: 'product',
          resourceId: productId,
          before: changed.before,
          after: changed.after,
        })
        await publish(
          'product.updated',
          { productId, changed: Object.keys(changed.after), actorId: actor.userId },
          { aggregateId: productId, actorUserId: actor.userId },
        )
      }
    })

    invalidateProduct(productId)
    return this.detail(productId, { fresh: true })
  },

  /**
   * Replaces a product's options wholesale.
   *
   * Deleting an option cascades to its values and, through them, would orphan
   * every variant's selection — so this refuses while live variants exist.
   * Restructuring a product's axes is a decision about what the variants *are*,
   * and doing it silently would leave variants selecting nothing.
   */
  async replaceOptions(
    productId: string,
    options: { name: string; values: OptionValueInput[] }[],
    actor: Actor,
  ): Promise<ProductDetail> {
    const product = await repo.findProductById(productId)
    if (!product) throw new NotFoundError('Product not found')

    const liveVariants = await repo.countLiveVariants(productId)
    if (liveVariants > 0) {
      throw new ConflictError(
        'Archive this product’s variants before changing its options — variants select option values, and changing the axes would leave them selecting nothing',
        { code: ERROR_CODES.DOMAIN_RULE_VIOLATION },
      )
    }

    await withTransaction(async () => {
      await repo.deleteOptions(productId)
      await this.writeOptions(productId, options)
      await auditService.record({
        actor,
        action: 'product.options_changed',
        resourceType: 'product',
        resourceId: productId,
        after: { options: options.map((option) => option.name) },
      })
    })

    invalidateProduct(productId)
    return this.detail(productId, { fresh: true })
  },

  /**
   * Adds a whole new axis to a live product — "Colour" onto a product that only
   * had "Size".
   *
   * The reason this cannot be a bare append is the invariant `resolveSelection`
   * rests on: every variant selects exactly one value for **every** option. Add
   * an axis and each existing variant suddenly has nothing to select for it.
   *
   * So the caller must say which value they all take — `appliesToExisting` — and
   * that value is written onto every variant, archived ones included. An
   * archived variant is still resolved from an order line and would stop being
   * able to describe itself with a gap in its selection. Each variant's
   * signature is then recomputed; because they all gain the *same* value id,
   * combinations that were distinct stay distinct, and the unique constraint
   * holds without anything having to be reshuffled.
   *
   * Titles are left alone. A variant's title is what an order line has been
   * calling it, and the admin renders the live selection anyway — so "Large"
   * keeps its name and reads as "Large / Black" wherever options are shown.
   */
  async addOption(
    productId: string,
    input: { name: string; values: OptionValueInput[]; appliesToExisting: string },
    actor: Actor,
  ): Promise<ProductDetail> {
    const product = await repo.findProductById(productId)
    if (!product) throw new NotFoundError('Product not found')
    assertNotArchived(product)

    const name = input.name.trim()
    const values = input.values.map(readOptionValue)
    const applies = input.appliesToExisting.trim()

    const seen = new Set<string>()
    for (const { value } of values) {
      if (seen.has(value.toLowerCase())) {
        throw new ValidationError(`Duplicate value "${value}" on option "${name}"`)
      }
      seen.add(value.toLowerCase())
    }
    if (!seen.has(applies.toLowerCase())) {
      throw new ValidationError(
        `"${applies}" must be one of the new option's values — it is what every existing variant will select`,
      )
    }

    await withTransaction(async () => {
      // The same lock the variant writer takes: two admins adding an axis at
      // once would both pass the cap check and leave four options behind.
      await repo.lockProduct(productId)

      const existing = await repo.optionsFor(productId)
      if (existing.length >= MAX_OPTIONS) {
        throw new ConflictError(
          `A product may have at most ${MAX_OPTIONS} options; remove one before adding another`,
          { code: ERROR_CODES.DOMAIN_RULE_VIOLATION },
        )
      }
      if (existing.some((option) => option.name.toLowerCase() === name.toLowerCase())) {
        throw new ConflictError(`This product already has an option named "${name}"`, {
          code: ERROR_CODES.ALREADY_EXISTS,
        })
      }

      const optionId = uuidv7()
      await repo.insertOption({ id: optionId, productId, name, position: existing.length })

      let appliesId = ''
      for (const [index, { value, swatchHex }] of values.entries()) {
        const valueId = uuidv7()
        await repo.insertOptionValue({ id: valueId, optionId, value, position: index, swatchHex })
        if (value.toLowerCase() === applies.toLowerCase()) appliesId = valueId
      }

      const variants = await repo.variantsFor(productId, { includeArchived: true })
      const selections = await repo.selectionsFor(productId)

      for (const variant of variants) {
        await repo.insertVariantSelection({
          variantId: variant.id,
          optionId,
          optionValueId: appliesId,
        })

        const valueIds = selections
          .filter((row) => row.variant_id === variant.id)
          .map((row) => row.option_value_id)
        valueIds.push(appliesId)
        await repo.setVariantSignature(variant.id, optionSignature(valueIds))
      }

      await auditService.record({
        actor,
        action: 'product.option_added',
        resourceType: 'product',
        resourceId: productId,
        after: { option: name, values, appliesToExisting: applies, variants: variants.length },
      })
    })

    invalidateProduct(productId)
    return this.detail(productId, { fresh: true })
  },

  /**
   * Appends one value to an existing option — "XL" onto Size.
   *
   * Additive, and therefore safe on a live product in a way that
   * `replaceOptions` is not. Nothing selects the new value yet, so every
   * existing variant still chooses exactly one value for every option, which is
   * the invariant `resolveSelection` depends on. It creates no variants either:
   * which combinations are worth stocking is a merchandising decision, made by
   * adding variants afterwards.
   *
   * Adding a whole new *axis* is deliberately still not possible here. That
   * would leave every existing variant with no selection for it, and there is
   * no answer the server could invent — so it remains a create-time decision.
   */
  async addOptionValue(
    productId: string,
    optionId: string,
    input: OptionValueInput,
    actor: Actor,
  ): Promise<ProductDetail> {
    const product = await repo.findProductById(productId)
    if (!product) throw new NotFoundError('Product not found')
    assertNotArchived(product)

    const { value: trimmed, swatchHex } = readOptionValue(input)

    await withTransaction(async () => {
      // The same lock `addVariant` takes: two admins adding "XL" at once must
      // not both pass the duplicate check before either inserts.
      await repo.lockProduct(productId)

      const option = await repo.findOption(productId, optionId)
      if (!option) throw new NotFoundError('That option does not belong to this product')

      if (option.values.some((entry) => entry.value.toLowerCase() === trimmed.toLowerCase())) {
        throw new ConflictError(`"${option.name}" already has the value "${trimmed}"`, {
          code: ERROR_CODES.ALREADY_EXISTS,
        })
      }

      await repo.insertOptionValue({
        id: uuidv7(),
        optionId,
        value: trimmed,
        position: option.values.length,
        swatchHex,
      })

      await auditService.record({
        actor,
        action: 'product.option_value_added',
        resourceType: 'product',
        resourceId: productId,
        after: { option: option.name, value: trimmed },
      })
    })

    invalidateProduct(productId)
    return this.detail(productId, { fresh: true })
  },

  /**
   * Removes an option value nothing has selected.
   *
   * The refusal counts *every* variant, archived included, because that is what
   * the `ON DELETE RESTRICT` on `variant_option_values` protects. An archived
   * variant is still resolvable from an order line, and it would stop being
   * able to describe itself if the value under it disappeared. Refusing with a
   * sentence beats letting a constraint violation come back as a 500.
   */
  async removeOptionValue(
    productId: string,
    optionId: string,
    valueId: string,
    actor: Actor,
  ): Promise<ProductDetail> {
    const product = await repo.findProductById(productId)
    if (!product) throw new NotFoundError('Product not found')
    assertNotArchived(product)

    await withTransaction(async () => {
      await repo.lockProduct(productId)

      const option = await repo.findOption(productId, optionId)
      if (!option) throw new NotFoundError('That option does not belong to this product')

      const target = option.values.find((entry) => entry.id === valueId)
      if (!target) throw new NotFoundError('That value does not belong to this option')

      // An option with no values cannot be satisfied by any variant, so the
      // last one may not go.
      if (option.values.length === 1) {
        throw new ConflictError(
          `"${option.name}" must keep at least one value — remove the option itself instead`,
          { code: ERROR_CODES.DOMAIN_RULE_VIOLATION },
        )
      }

      const { total, live } = await repo.countVariantsUsingValue(valueId)
      if (total > 0) {
        throw new ConflictError(
          live > 0
            ? `${live} variant(s) still use "${target.value}" — archive them first`
            : `An archived variant still records "${target.value}", so it cannot be removed`,
          { code: ERROR_CODES.OPTION_VALUE_IN_USE },
        )
      }

      await repo.deleteOptionValue(optionId, valueId)
      await auditService.record({
        actor,
        action: 'product.option_value_removed',
        resourceType: 'product',
        resourceId: productId,
        before: { option: option.name, value: target.value },
      })
    })

    invalidateProduct(productId)
    return this.detail(productId, { fresh: true })
  },

  /**
   * Sets or clears what one option value looks like.
   *
   * Unlike every other option operation this one is safe on a live product and
   * takes no lock: it changes how a value is *drawn*, not which variants exist
   * or what any of them select. Nothing downstream keys on it, so there is no
   * signature to recompute and no combination that can collide.
   *
   * Passing `null` clears the colour, and the storefront falls back to the
   * value's name — which is what it did before anybody set one.
   */
  async setOptionValueSwatch(
    productId: string,
    optionId: string,
    valueId: string,
    swatchHex: string | null,
    actor: Actor,
  ): Promise<ProductDetail> {
    const product = await repo.findProductById(productId)
    if (!product) throw new NotFoundError('Product not found')
    assertNotArchived(product)

    const option = await repo.findOption(productId, optionId)
    if (!option) throw new NotFoundError('That option does not belong to this product')

    const target = option.values.find((entry) => entry.id === valueId)
    if (!target) throw new NotFoundError('That value does not belong to this option')

    await repo.setOptionValueSwatch(optionId, valueId, swatchHex)
    await auditService.record({
      actor,
      action: 'product.option_value_recoloured',
      resourceType: 'product',
      resourceId: productId,
      before: { option: option.name, value: target.value, swatchHex: target.swatchHex },
      after: { option: option.name, value: target.value, swatchHex },
    })

    invalidateProduct(productId)
    return this.detail(productId, { fresh: true })
  },

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Moves a product's lifecycle state.
   *
   * Archiving also unpublishes everywhere: leaving a retired product visible is
   * the failure mode this transition exists to prevent. The reverse is not
   * symmetric — restoring makes a product `draft`, and someone must decide to
   * publish it again.
   */
  async setStatus(productId: string, status: ProductStatus, actor: Actor): Promise<ProductDetail> {
    const product = await repo.findProductById(productId)
    if (!product) throw new NotFoundError('Product not found')
    if (product.status === status) return this.detail(productId)

    if (status === 'active') {
      const live = await repo.countLiveVariants(productId)
      if (live === 0) {
        throw new DomainRuleError(
          ERROR_CODES.PRODUCT_NOT_PUBLISHABLE,
          'A product needs at least one live variant before it can be activated',
        )
      }
    }

    await withTransaction(async () => {
      await repo.setProductStatus(productId, status)
      if (status === 'archived') await repo.unpublishEverywhere(productId)

      await auditService.record({
        actor,
        action: status === 'archived' ? 'product.archived' : 'product.status_changed',
        resourceType: 'product',
        resourceId: productId,
        before: { status: product.status },
        after: { status },
      })
      await publish(
        status === 'archived' ? 'product.archived' : 'product.status_changed',
        { productId, from: product.status, to: status, actorId: actor.userId },
        { aggregateId: productId, actorUserId: actor.userId },
      )
    })

    invalidateProduct(productId)
    log.info({ productId, from: product.status, to: status }, 'product status changed')
    return this.detail(productId, { fresh: true })
  },

  /**
   * Publishes a product to a channel.
   *
   * Publication is separate from status, so this checks status explicitly: a
   * draft is unfinished and an archived product is retired, and neither belongs
   * in front of a customer.
   */
  async publish(
    productId: string,
    channelKey: string | undefined,
    actor: Actor,
  ): Promise<ProductDetail> {
    const product = await repo.findProductById(productId)
    if (!product) throw new NotFoundError('Product not found')

    if (product.status !== 'active') {
      throw new DomainRuleError(
        ERROR_CODES.PRODUCT_NOT_PUBLISHABLE,
        `A ${product.status} product cannot be published — activate it first`,
      )
    }
    const live = await repo.countLiveVariants(productId)
    if (live === 0) {
      throw new DomainRuleError(
        ERROR_CODES.PRODUCT_NOT_PUBLISHABLE,
        'A product with no live variant has nothing to sell',
      )
    }

    const channel = channelKey
      ? await repo.findChannelByKey(channelKey)
      : await repo.defaultChannel()
    if (!channel) throw new NotFoundError('Sales channel not found')

    await withTransaction(async () => {
      const inserted = await repo.publish(productId, channel.id, actor.userId)
      if (inserted > 0) {
        await auditService.record({
          actor,
          action: 'product.published',
          resourceType: 'product',
          resourceId: productId,
          after: { channel: channel.key },
        })
        await publish(
          'product.published',
          { productId, channelKey: channel.key, actorId: actor.userId },
          { aggregateId: productId, actorUserId: actor.userId },
        )
      }
    })

    invalidateProduct(productId)
    return this.detail(productId, { fresh: true })
  },

  async unpublish(
    productId: string,
    channelKey: string | undefined,
    actor: Actor,
  ): Promise<ProductDetail> {
    const product = await repo.findProductById(productId)
    if (!product) throw new NotFoundError('Product not found')

    const channel = channelKey
      ? await repo.findChannelByKey(channelKey)
      : await repo.defaultChannel()
    if (!channel) throw new NotFoundError('Sales channel not found')

    await withTransaction(async () => {
      const removed = await repo.unpublish(productId, channel.id)
      if (removed > 0) {
        await auditService.record({
          actor,
          action: 'product.unpublished',
          resourceType: 'product',
          resourceId: productId,
          before: { channel: channel.key },
        })
        await publish(
          'product.unpublished',
          { productId, channelKey: channel.key, actorId: actor.userId },
          { aggregateId: productId, actorUserId: actor.userId },
        )
      }
    })

    invalidateProduct(productId)
    return this.detail(productId, { fresh: true })
  },

  // ── Variants ──────────────────────────────────────────────────────────────

  async addVariant(
    productId: string,
    input: CreateVariantInput,
    actor: Actor,
  ): Promise<ProductVariant> {
    const product = await repo.findProductById(productId)
    if (!product) throw new NotFoundError('Product not found')

    const currency = await assertPriceAcceptable({
      amount: input.priceAmount,
      compareAtAmount: input.compareAtAmount ?? null,
      ...(input.currency ? { currency: input.currency } : {}),
    })

    const variantId = await withTransaction(async () => {
      // Serialises concurrent variant writes on this product, so two admins
      // adding "Large / Thin" at the same instant cannot both pass the
      // duplicate check before either inserts.
      await repo.lockProduct(productId)

      const options = await repo.optionsFor(productId)
      const { valueIds, byOption, title } = this.resolveSelection(
        options,
        input.options ?? {},
        input.title,
      )
      const existing = await repo.variantsFor(productId)

      const created = await repo.insertVariant({
        id: uuidv7(),
        productId,
        title,
        sku: input.sku?.trim() || null,
        barcode: input.barcode?.trim() || null,
        priceAmount: input.priceAmount,
        compareAtAmount: input.compareAtAmount ?? null,
        currency,
        weightGrams: input.weightGrams ?? 0,
        requiresShipping: input.requiresShipping ?? true,
        position: input.position ?? existing.length,
        isActive: input.isActive ?? true,
        optionSignature: optionSignature(valueIds),
      })

      for (const [optionId, optionValueId] of Object.entries(byOption)) {
        await repo.insertVariantSelection({ variantId: created.id, optionId, optionValueId })
      }
      await inventoryService.ensureItemForVariant(created.id)

      await auditService.record({
        actor,
        action: 'variant.created',
        resourceType: 'product_variant',
        resourceId: created.id,
        after: { productId, title, priceAmount: input.priceAmount, sku: created.sku },
      })
      await publish(
        'variant.created',
        { productId, variantId: created.id, actorId: actor.userId },
        { aggregateId: productId, actorUserId: actor.userId },
      )
      return created.id
    })

    invalidateProduct(productId)
    const variant = await repo.findVariantById(variantId)
    if (!variant) throw new NotFoundError('Variant not found')
    return variant
  },

  async updateVariant(
    variantId: string,
    patch: UpdateVariantInput,
    actor: Actor,
  ): Promise<ProductVariant> {
    const before = await repo.findVariantById(variantId)
    if (!before) throw new NotFoundError('Variant not found')
    if (before.archivedAt) {
      throw new DomainRuleError(
        ERROR_CODES.DOMAIN_RULE_VIOLATION,
        'An archived variant cannot be edited',
      )
    }

    if (patch.priceAmount !== undefined || patch.compareAtAmount !== undefined) {
      await assertPriceAcceptable({
        amount: patch.priceAmount ?? before.price.amount,
        compareAtAmount:
          patch.compareAtAmount !== undefined
            ? patch.compareAtAmount
            : (before.compareAtPrice?.amount ?? null),
        currency: before.price.currency,
      })
    }
    if (patch.mediaId) {
      const media = await repo.findProductMedia(before.productId, patch.mediaId)
      if (!media) {
        throw new ValidationError('That image is not attached to this product')
      }
    }

    await withTransaction(async () => {
      await repo.updateVariant(variantId, patch as Record<string, unknown>)

      const changed = diffChanged(
        {
          title: before.title,
          sku: before.sku,
          barcode: before.barcode,
          priceAmount: before.price.amount,
          compareAtAmount: before.compareAtPrice?.amount ?? null,
          weightGrams: before.weightGrams,
          requiresShipping: before.requiresShipping,
          position: before.position,
          isActive: before.isActive,
          mediaId: before.mediaId,
        },
        patch,
      )
      if (changed) {
        await auditService.record({
          actor,
          action: 'variant.updated',
          resourceType: 'product_variant',
          resourceId: variantId,
          before: changed.before,
          after: changed.after,
        })
        // Price changes are the ones anyone will later want to reconstruct, so
        // the event names what moved rather than merely that something did.
        await publish(
          'variant.updated',
          {
            productId: before.productId,
            variantId,
            changed: Object.keys(changed.after),
            actorId: actor.userId,
          },
          { aggregateId: before.productId, actorUserId: actor.userId },
        )
      }
    })

    invalidateProduct(before.productId)
    const updated = await repo.findVariantById(variantId)
    if (!updated) throw new NotFoundError('Variant not found')
    return updated
  },

  /**
   * Archives a variant. There is deliberately no delete.
   *
   * Refuses to remove the last live variant of a non-archived product: that
   * would leave a product that exists, looks fine, and cannot be bought.
   */
  async archiveVariant(variantId: string, actor: Actor): Promise<void> {
    const variant = await repo.findVariantById(variantId)
    if (!variant) throw new NotFoundError('Variant not found')
    if (variant.archivedAt) return

    const product = await repo.findProductById(variant.productId)
    const live = await repo.countLiveVariants(variant.productId)

    if (live <= 1 && product?.status !== 'archived') {
      throw new DomainRuleError(
        ERROR_CODES.LAST_VARIANT_PROTECTED,
        'This is the product’s only variant — archive the product instead',
      )
    }

    await withTransaction(async () => {
      await repo.archiveVariant(variantId)
      await auditService.record({
        actor,
        action: 'variant.archived',
        resourceType: 'product_variant',
        resourceId: variantId,
        before: { productId: variant.productId, title: variant.title, sku: variant.sku },
      })
      await publish(
        'variant.archived',
        { productId: variant.productId, variantId, actorId: actor.userId },
        { aggregateId: variant.productId, actorUserId: actor.userId },
      )
    })

    invalidateProduct(variant.productId)
  },

  // ── Media ─────────────────────────────────────────────────────────────────

  /**
   * Attaches an image to a product.
   *
   * The asset must be `ready`: attaching a `pending` upload would put bytes
   * nothing has inspected on a product page (§16.3).
   */
  async attachMedia(
    productId: string,
    input: { mediaId: string; alt?: string | null; isPrimary?: boolean },
    actor: Actor,
  ): Promise<ProductDetail> {
    const product = await repo.findProductById(productId)
    if (!product) throw new NotFoundError('Product not found')

    const asset = await mediaService.getById(input.mediaId)
    if (!asset) throw new ValidationError('That media asset does not exist')
    mediaService.assertReady(asset)

    const existing = await repo.mediaFor(productId)
    // The first image is primary whether or not anyone said so: a product with
    // images and no primary renders an empty thumbnail everywhere.
    const primary = input.isPrimary ?? existing.length === 0

    await withTransaction(async () => {
      if (primary) await repo.clearPrimaryMedia(productId)
      await repo.attachMedia({
        id: uuidv7(),
        productId,
        mediaId: input.mediaId,
        alt: input.alt ?? asset.alt,
        position: existing.length,
        isPrimary: primary,
      })
      await auditService.record({
        actor,
        action: 'product.media_attached',
        resourceType: 'product',
        resourceId: productId,
        after: { mediaId: input.mediaId, isPrimary: primary },
      })
    })

    invalidateProduct(productId)
    return this.detail(productId, { fresh: true })
  },

  /** Reorders a product's images and optionally names a new primary. */
  async reorderMedia(
    productId: string,
    order: string[],
    primaryId: string | undefined,
    actor: Actor,
  ): Promise<ProductDetail> {
    const existing = await repo.mediaFor(productId)
    if (existing.length === 0) throw new NotFoundError('This product has no media')

    const known = new Set(existing.map((entry) => entry.id))
    for (const id of order) {
      if (!known.has(id)) throw new ValidationError('That image is not attached to this product')
    }
    if (primaryId && !known.has(primaryId)) {
      throw new ValidationError('That image is not attached to this product')
    }

    await withTransaction(async () => {
      for (const [index, id] of order.entries()) {
        await repo.setMediaPosition(id, index)
      }
      if (primaryId) {
        await repo.clearPrimaryMedia(productId)
        await repo.setPrimaryMedia(primaryId)
      }
      await auditService.record({
        actor,
        action: 'product.media_reordered',
        resourceType: 'product',
        resourceId: productId,
        after: { order, primaryId: primaryId ?? null },
      })
    })

    invalidateProduct(productId)
    return this.detail(productId, { fresh: true })
  },

  /**
   * Detaches an image from a product. The underlying media asset is untouched:
   * it may be used elsewhere, and deleting it is the media feature's decision.
   */
  async detachMedia(productId: string, productMediaId: string, actor: Actor): Promise<void> {
    const removed = await withTransaction(async () => {
      const count = await repo.detachMedia(productId, productMediaId)
      if (count > 0) {
        await auditService.record({
          actor,
          action: 'product.media_detached',
          resourceType: 'product',
          resourceId: productId,
          before: { productMediaId },
        })
      }
      return count
    })
    if (removed === 0) throw new NotFoundError('That image is not attached to this product')
    invalidateProduct(productId)
  },

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Which product a variant belongs to.
   *
   * Exists for the inventory subscriber: inventory events carry a variant id
   * because inventory knows nothing about products, and resolving that is the
   * catalogue's job rather than a JOIN across a feature boundary.
   */
  async productIdForVariant(variantId: string): Promise<string | undefined> {
    const variant = await repo.findVariantById(variantId)
    return variant?.productId
  },

  /**
   * The purchase view of a set of variants: what a cart line or an order line
   * needs, resolved in one query.
   *
   * `sellable` folds together the three catalogue conditions — product active,
   * published, variant live — leaving only the inventory question for the
   * caller. That keeps the purchasability rule in one shape rather than
   * re-derived at every call site (docs/inventory.md §7).
   */
  async purchaseView(variantIds: string[]) {
    const rows = await repo.variantsForPurchase(variantIds)
    return rows.map((row) => ({
      variantId: row.variant_id,
      productId: row.product_id,
      handle: row.handle,
      productTitle: row.product_title,
      variantTitle: row.variant_title,
      sku: row.sku,
      priceAmount: row.price_amount,
      currency: row.currency,
      weightGrams: row.weight_grams,
      requiresShipping: row.requires_shipping,
      categoryId: row.category_id,
      options: row.options ?? [],
      mediaId: row.media_id,
      sellable:
        row.variant_active &&
        !row.variant_archived &&
        row.product_status === 'active' &&
        row.published,
    }))
  },

  // ── Bulk changes ──────────────────────────────────────────────────────────

  /**
   * One change across a selection of products.
   *
   * Two decisions shape this. It runs the *existing* single-product operations
   * rather than reaching into the repository with an `IN (...)`: publishing
   * refuses a draft product, archiving releases stock, and every one of those
   * rules would have to be reimplemented — and would then drift — if a bulk
   * path took a shortcut past them.
   *
   * And it reports per product rather than failing the batch. Selecting forty
   * products and being told "one of them could not be published" with no way to
   * find out which is worse than useless; the caller gets a row per product and
   * the admin shows what happened to each.
   */
  async bulk(
    input: {
      productIds: string[]
      action:
        | 'setStatus'
        | 'publish'
        | 'unpublish'
        | 'addTags'
        | 'removeTags'
        | 'addToCollection'
        | 'removeFromCollection'
      status?: ProductStatus
      channelKey?: string
      tags?: string[]
      collectionId?: string
    },
    actor: Actor,
    // Passed in rather than imported: `taxonomy.service` already imports this
    // module for cache invalidation, and importing it back would be a cycle.
    // The same seam `customersService.create` uses for hashing.
    hooks: {
      addToCollection: (collectionId: string, productId: string) => Promise<unknown>
      removeFromCollection: (collectionId: string, productId: string) => Promise<unknown>
    },
  ): Promise<Array<{ productId: string; ok: boolean; error?: string }>> {
    const results: Array<{ productId: string; ok: boolean; error?: string }> = []

    for (const productId of input.productIds) {
      try {
        switch (input.action) {
          case 'setStatus':
            await this.setStatus(productId, input.status as ProductStatus, actor)
            break
          case 'publish':
            await this.publish(productId, input.channelKey, actor)
            break
          case 'unpublish':
            await this.unpublish(productId, input.channelKey, actor)
            break
          case 'addTags':
          case 'removeTags': {
            const product = await repo.findProductById(productId)
            if (!product) throw new NotFoundError('Product not found')
            const lower = new Set((input.tags ?? []).map((tag) => tag.toLowerCase()))
            // Tags are a set with a spelling: adding one that is already there
            // in another case is not a change, and removing is case-insensitive
            // for the same reason.
            const next =
              input.action === 'addTags'
                ? [
                    ...product.tags,
                    ...(input.tags ?? []).filter(
                      (tag) =>
                        !product.tags.some((held) => held.toLowerCase() === tag.toLowerCase()),
                    ),
                  ]
                : product.tags.filter((tag) => !lower.has(tag.toLowerCase()))
            await this.update(productId, { tags: next }, actor)
            break
          }
          case 'addToCollection':
            await hooks.addToCollection(input.collectionId as string, productId)
            break
          case 'removeFromCollection':
            await hooks.removeFromCollection(input.collectionId as string, productId)
            break
        }
        results.push({ productId, ok: true })
      } catch (error) {
        results.push({
          productId,
          ok: false,
          error: error instanceof Error ? error.message : 'Failed',
        })
      }
    }

    log.info(
      {
        action: input.action,
        total: results.length,
        failed: results.filter((entry) => !entry.ok).length,
      },
      'bulk product action',
    )
    return results
  },

  async assertCategoryExists(categoryId: string): Promise<void> {
    const category = await repo.findCategoryById(categoryId)
    if (!category || category.archivedAt) {
      throw new ValidationError('That category does not exist')
    }
  },

  /** Test seam and event handler: drop everything the process has cached. */
  clearCache(): void {
    detailCache.clear()
  },
}
