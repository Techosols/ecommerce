/**
 * DTO mapping (§7.3).
 *
 * Two serializers per resource, written separately and never one derived from
 * the other by deletion. The admin view and the storefront view answer to
 * different people, and "the public shape is the admin shape minus a few
 * fields" is how next month's cost price ends up on a product page.
 *
 * Storefront DTOs also carry no database ids that a customer has no use for —
 * ids of options and values are included because a variant picker needs them,
 * but internal bookkeeping is not.
 */
import { describeRules } from './products.rules.js'
import { mediaService } from '../media/index.js'
import { availabilityService, publicAvailabilityDto } from '../inventory/index.js'
import type { VariantAvailability } from '../inventory/index.js'
import type {
  Category,
  CategoryNode,
  Collection,
  Money,
  Product,
  ProductDetail,
  ProductMedia,
  ProductVariant,
} from './catalogue.types.js'

/** Money always crosses the boundary as `{ amount, currency }`, never a number. */
function moneyDto(value: Money | null): { amount: number; currency: string } | null {
  return value === null ? null : { amount: value.amount, currency: value.currency }
}

/**
 * Resolves image URLs through the StorageProvider.
 *
 * The catalogue stores media *records*, never URLs, so the bucket, its
 * visibility and the whole storage backend can change without a migration
 * (§46). A `ready` asset is the only kind that gets a URL.
 */
async function imageUrls(media: ProductMedia[]) {
  const out: {
    id: string
    mediaId: string
    alt: string | null
    position: number
    isPrimary: boolean
    url: string | null
    variants: Record<string, string>
  }[] = []

  for (const entry of media) {
    const asset = await mediaService.getById(entry.mediaId)
    if (!asset || asset.status !== 'ready') {
      out.push({ ...entry, url: null, variants: {} })
      continue
    }
    const urls = await mediaService.urlsFor(asset)
    out.push({
      id: entry.id,
      mediaId: entry.mediaId,
      alt: entry.alt ?? asset.alt,
      position: entry.position,
      isPrimary: entry.isPrimary,
      url: urls.url,
      variants: urls.variants,
    })
  }
  return out
}

// ── Admin ───────────────────────────────────────────────────────────────────

export function adminVariantDto(variant: ProductVariant) {
  return {
    id: variant.id,
    productId: variant.productId,
    title: variant.title,
    sku: variant.sku,
    barcode: variant.barcode,
    price: moneyDto(variant.price),
    compareAtPrice: moneyDto(variant.compareAtPrice),
    weightGrams: variant.weightGrams,
    requiresShipping: variant.requiresShipping,
    position: variant.position,
    mediaId: variant.mediaId,
    isActive: variant.isActive,
    isArchived: variant.archivedAt !== null,
    options: variant.selections.map((selection) => ({
      optionId: selection.optionId,
      name: selection.optionName,
      valueId: selection.optionValueId,
      value: selection.value,
    })),
    createdAt: variant.createdAt.toISOString(),
    updatedAt: variant.updatedAt.toISOString(),
  }
}

/**
 * A row in the admin's product list.
 *
 * `summary` carries the three things a `products` row does not and a listing
 * needs — the picture, the variant count and the stock behind them. It is
 * resolved for the whole page in one query by the route, rather than per row:
 * see `catalogueRepository.summariesFor`.
 *
 * `available: null` means *nothing on this product is tracked*, which is a
 * different fact from zero and has to render differently. A product nobody has
 * ever stocked is not a product that has sold out.
 */
export function adminProductSummaryDto(
  product: Product,
  summary?: { imageUrl: string | null; variantCount: number; available: number | null },
) {
  return {
    id: product.id,
    handle: product.handle,
    title: product.title,
    status: product.status,
    categoryId: product.categoryId,
    productType: product.productType,
    vendor: product.vendor,
    tags: product.tags,
    imageUrl: summary?.imageUrl ?? null,
    variantCount: summary?.variantCount ?? 0,
    available: summary?.available ?? null,
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  }
}

export async function adminProductDto(product: ProductDetail) {
  return {
    id: product.id,
    handle: product.handle,
    title: product.title,
    subtitle: product.subtitle,
    description: product.description,
    // Three separate answers to three separate questions (§3 of the model doc).
    status: product.status,
    publications: product.publications.map((publication) => ({
      channel: publication.channelKey,
      publishedAt: publication.publishedAt.toISOString(),
    })),
    category: product.category
      ? { id: product.category.id, name: product.category.name, handle: product.category.handle }
      : null,
    productType: product.productType,
    vendor: product.vendor,
    tags: product.tags,
    seo: { title: product.seoTitle, description: product.seoDescription },
    metadata: product.metadata,
    options: product.options.map((option) => ({
      id: option.id,
      name: option.name,
      position: option.position,
      values: option.values.map((value) => ({
        id: value.id,
        value: value.value,
        position: value.position,
        swatchHex: value.swatchHex,
      })),
    })),
    variants: product.variants.map(adminVariantDto),
    media: await imageUrls(product.media),
    collectionIds: product.collectionIds,
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
    archivedAt: product.archivedAt?.toISOString() ?? null,
  }
}

export function adminCategoryDto(category: Category) {
  return {
    id: category.id,
    parentId: category.parentId,
    name: category.name,
    handle: category.handle,
    description: category.description,
    imageId: category.imageId,
    position: category.position,
    isActive: category.isActive,
    isArchived: category.archivedAt !== null,
    createdAt: category.createdAt.toISOString(),
    updatedAt: category.updatedAt.toISOString(),
  }
}

export function adminCollectionDto(collection: Collection, currency?: string) {
  return {
    id: collection.id,
    handle: collection.handle,
    title: collection.title,
    description: collection.description,
    imageId: collection.imageId,
    type: collection.type,
    rules: collection.rules,
    // The rules in English, so a card can say what a smart collection means
    // without making anybody read JSON. Built from the same table the compiler
    // uses, so the sentence and the query cannot describe different things.
    ...(collection.type === 'dynamic'
      ? { summary: describeRules(collection.rules, currency ? { currency } : {}) }
      : {}),
    position: collection.position,
    isActive: collection.isActive,
    isArchived: collection.archivedAt !== null,
    seo: { title: collection.seoTitle, description: collection.seoDescription },
    createdAt: collection.createdAt.toISOString(),
    updatedAt: collection.updatedAt.toISOString(),
  }
}

// ── Storefront ──────────────────────────────────────────────────────────────

/**
 * The public view of a variant.
 *
 * `available` is now a real answer: the variant is switched on **and** stock
 * allows it. A quantity is deliberately not exposed — see
 * docs/inventory.md §12; that is a product decision, not a DTO accident.
 */
function publicVariantDto(
  variant: ProductVariant,
  availability: VariantAvailability | undefined,
  images: Awaited<ReturnType<typeof imageUrls>>,
) {
  const stock = availability
    ? publicAvailabilityDto(availability)
    : // No availability resolved: treat as untracked rather than as zero, which
      // is the same rule availability.ts applies (§8).
      { available: true, availability: 'made_to_order' as const }

  // The variant's own photo, if it has one. `mediaId` points at a row in this
  // product's `product_media` — a composite foreign key guarantees it cannot
  // point anywhere else — so this is a lookup, not a join, and it is null both
  // when no image was chosen and when the one chosen is not ready yet.
  //
  // Publishing it is what lets a storefront swap the picture when somebody
  // picks a colour. Without it the shopper reads "Mulberry" and still sees the
  // photo of the red one.
  const own = variant.mediaId ? images.find((image) => image.id === variant.mediaId) : undefined

  return {
    id: variant.id,
    title: variant.title,
    sku: variant.sku,
    price: moneyDto(variant.price),
    compareAtPrice: moneyDto(variant.compareAtPrice),
    ...stock,
    image:
      own && own.url
        ? { url: own.url, alt: own.alt, variants: own.variants }
        : null,
    options: variant.selections.map((selection) => ({
      name: selection.optionName,
      value: selection.value,
      valueId: selection.optionValueId,
    })),
  }
}

/**
 * Availability is resolved per request, never cached with the product.
 *
 * The catalogue caches a product's shape for sixty seconds; folding stock into
 * that cache is how a page ends up advertising something that sold out fifty
 * seconds ago. One batched query is cheap, and correctness here is not
 * negotiable — see docs/inventory.md §17.
 *
 * A listing resolves availability once for every variant on the page and passes
 * the map in; a single product resolves its own.
 */
export async function resolveAvailability(
  products: ProductDetail[],
): Promise<Map<string, VariantAvailability>> {
  return availabilityService.forVariants(products.flatMap((p) => p.variants.map((v) => v.id)))
}

export async function publicProductDto(
  product: ProductDetail,
  availability?: Map<string, VariantAvailability>,
) {
  const stock = availability ?? (await resolveAvailability([product]))

  // Archived and inactive variants are not merely hidden from the picker; they
  // are absent, so nothing downstream can quote a price for one. Out-of-stock
  // variants stay listed but marked, because a customer choosing a size needs
  // to see that the large exists and is unavailable.
  const sellable = product.variants.filter(
    (variant) => variant.archivedAt === null && variant.isActive,
  )
  const purchasable = sellable.filter((variant) => stock.get(variant.id)?.inStock ?? true)
  const media = await imageUrls(product.media)
  // Only what can actually be bought sets the "from" price.
  const prices = purchasable.map((variant) => variant.price.amount)

  return {
    id: product.id,
    handle: product.handle,
    title: product.title,
    subtitle: product.subtitle,
    description: product.description,
    category: product.category
      ? { name: product.category.name, handle: product.category.handle }
      : null,
    productType: product.productType,
    tags: product.tags,
    seo: {
      title: product.seoTitle ?? product.title,
      description: product.seoDescription ?? product.subtitle,
    },
    options: product.options.map((option) => ({
      id: option.id,
      name: option.name,
      // `swatchHex` is what the merchant said this value looks like, or null.
      // The storefront paints a circle when there is one and falls back to the
      // name when there is not — it never guesses a colour from the word.
      values: option.values.map((value) => ({
        id: value.id,
        value: value.value,
        swatchHex: value.swatchHex,
      })),
    })),
    variants: sellable.map((variant) =>
      publicVariantDto(variant, stock.get(variant.id), media),
    ),
    // Saves every storefront from computing "from £4.50" itself, and from
    // getting it wrong when a variant is unavailable.
    priceRange:
      prices.length > 0
        ? {
            min: { amount: Math.min(...prices), currency: purchasable[0]!.price.currency },
            max: { amount: Math.max(...prices), currency: purchasable[0]!.price.currency },
          }
        : null,
    images: media.map((entry) => ({
      url: entry.url,
      alt: entry.alt,
      isPrimary: entry.isPrimary,
      variants: entry.variants,
    })),
    // The product is available when at least one of its variants can be bought.
    available: purchasable.length > 0,
  }
}

/** The listing shape: enough to render a card, and nothing more. */
export async function publicProductCardDto(
  product: ProductDetail,
  availability?: Map<string, VariantAvailability>,
) {
  const full = await publicProductDto(product, availability)
  return {
    id: full.id,
    handle: full.handle,
    title: full.title,
    subtitle: full.subtitle,
    category: full.category,
    priceRange: full.priceRange,
    image: full.images.find((image) => image.isPrimary) ?? full.images[0] ?? null,
    available: full.available,
    tags: full.tags,
    /**
     * The colours this product comes in, for the swatch row on a card.
     *
     * Costs nothing: this mapper is handed the fully resolved product, so the
     * option values are already in memory. Without it a grid of twelve cards
     * would need twelve extra product requests to draw twelve rows of circles,
     * which is how a listing page becomes slow enough that somebody caches it.
     *
     * Empty for a product with no colour axis, which is most of them. A value
     * with no colour set is left out entirely rather than sent as a null — a
     * card has room for circles, not for a fallback to a name.
     */
    colours: colourValues(full.options),
  }
}

/**
 * Values from the first option that has any colours on it.
 *
 * The *first* rather than all of them: a product varying on Shade and Size has
 * one colour axis, and merging both would put sizes in a row of circles. If a
 * catalogue ever grows two genuine colour axes this returns the primary one,
 * which is the one a card should show.
 */
function colourValues(
  options: { name: string; values: { value: string; swatchHex: string | null }[] }[],
): { value: string; swatchHex: string }[] {
  const axis = options.find((option) => option.values.some((value) => value.swatchHex !== null))
  if (!axis) return []
  return axis.values
    .filter((value): value is { value: string; swatchHex: string } => value.swatchHex !== null)
    .map((value) => ({ value: value.value, swatchHex: value.swatchHex }))
}

export function publicCategoryDto(category: Category) {
  return {
    name: category.name,
    handle: category.handle,
    description: category.description,
    position: category.position,
  }
}

export function publicCategoryTreeDto(node: CategoryNode): Record<string, unknown> {
  return {
    ...publicCategoryDto(node),
    children: node.children.map(publicCategoryTreeDto),
  }
}

export function publicCollectionDto(collection: Collection) {
  return {
    handle: collection.handle,
    title: collection.title,
    description: collection.description,
    seo: {
      title: collection.seoTitle ?? collection.title,
      description: collection.seoDescription ?? collection.description,
    },
    position: collection.position,
  }
}
