/**
 * Catalogue data access (§1.2). SQL only — no business rules live here.
 *
 * Reads are assembled deliberately rather than by one clever join: a product
 * with 3 options, 6 variants and 4 images joined in a single statement returns
 * 72 rows to be de-duplicated in JavaScript. Five small indexed queries against
 * a warm page cache are both faster and legible, and each one is separately
 * cacheable later.
 */
import { execute, query, queryOne } from '../../infrastructure/database/query.js'
import { registerConstraintError } from '../../infrastructure/database/errors.js'
import { ERROR_CODES } from '../../shared/errors/index.js'
import { resolvePrice } from './pricing.js'
import { IN_STOCK_PREDICATE, inStockJoin } from '../inventory/index.js'
import { compileRules, parseRules } from './products.rules.js'
import type { RuleSet } from './products.rules.js'
import type {
  Category,
  Collection,
  CollectionType,
  Product,
  ProductListFilter,
  ProductMedia,
  ProductOption,
  ProductStatus,
  ProductVariant,
  Publication,
  SalesChannel,
} from './catalogue.types.js'

registerConstraintError(
  'product_variants_sku_key',
  ERROR_CODES.SKU_TAKEN,
  'That SKU is already used by another variant',
)
registerConstraintError(
  'variant_combination_is_unique',
  ERROR_CODES.VARIANT_COMBINATION_EXISTS,
  'This product already has a variant with that combination of options',
)
registerConstraintError(
  'products_handle_key',
  ERROR_CODES.HANDLE_TAKEN,
  'That handle is already in use',
)
registerConstraintError(
  'collections_handle_key',
  ERROR_CODES.HANDLE_TAKEN,
  'That handle is already used by another collection',
)
registerConstraintError(
  'categories_handle_key',
  ERROR_CODES.HANDLE_TAKEN,
  'That handle is already used by another category',
)

// ── Row shapes ──────────────────────────────────────────────────────────────

interface ProductRow {
  id: string
  handle: string
  title: string
  subtitle: string | null
  description: string | null
  status: ProductStatus
  category_id: string | null
  product_type: string | null
  vendor: string | null
  tags: string[]
  seo_title: string | null
  seo_description: string | null
  metadata: Record<string, unknown>
  created_at: Date
  updated_at: Date
  archived_at: Date | null
  created_by: string | null
}

interface VariantRow {
  id: string
  product_id: string
  title: string
  sku: string | null
  barcode: string | null
  price_amount: number
  compare_at_amount: number | null
  currency: string
  weight_grams: number
  requires_shipping: boolean
  position: number
  media_id: string | null
  is_active: boolean
  option_signature: string
  metadata: Record<string, unknown>
  created_at: Date
  updated_at: Date
  archived_at: Date | null
}

interface CategoryRow {
  id: string
  parent_id: string | null
  name: string
  handle: string
  description: string | null
  image_id: string | null
  position: number
  is_active: boolean
  created_at: Date
  updated_at: Date
  archived_at: Date | null
}

interface CollectionRow {
  id: string
  rules: unknown
  handle: string
  title: string
  description: string | null
  image_id: string | null
  type: 'manual' | 'dynamic'
  position: number
  is_active: boolean
  seo_title: string | null
  seo_description: string | null
  created_at: Date
  updated_at: Date
  archived_at: Date | null
}

function toProduct(row: ProductRow): Product {
  return {
    id: row.id,
    handle: row.handle,
    title: row.title,
    subtitle: row.subtitle,
    description: row.description,
    status: row.status,
    categoryId: row.category_id,
    productType: row.product_type,
    vendor: row.vendor,
    tags: row.tags ?? [],
    seoTitle: row.seo_title,
    seoDescription: row.seo_description,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    createdBy: row.created_by,
  }
}

function toVariant(row: VariantRow): ProductVariant {
  const { price, compareAtPrice } = resolvePrice({
    priceAmount: row.price_amount,
    compareAtAmount: row.compare_at_amount,
    currency: row.currency,
  })
  return {
    id: row.id,
    productId: row.product_id,
    title: row.title,
    sku: row.sku,
    barcode: row.barcode,
    price,
    compareAtPrice,
    weightGrams: row.weight_grams,
    requiresShipping: row.requires_shipping,
    position: row.position,
    mediaId: row.media_id,
    isActive: row.is_active,
    optionSignature: row.option_signature,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    selections: [],
  }
}

function toCategory(row: CategoryRow): Category {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    handle: row.handle,
    description: row.description,
    imageId: row.image_id,
    position: row.position,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  }
}

function toCollection(row: CollectionRow): Collection {
  return {
    id: row.id,
    handle: row.handle,
    title: row.title,
    description: row.description,
    imageId: row.image_id,
    type: row.type,
    rules: parseRules(row.rules),
    position: row.position,
    isActive: row.is_active,
    seoTitle: row.seo_title,
    seoDescription: row.seo_description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  }
}

/** Update field → column. A field absent here simply cannot be written (§16.3). */
const PRODUCT_COLUMNS: Record<string, string> = {
  title: 'title',
  subtitle: 'subtitle',
  description: 'description',
  categoryId: 'category_id',
  productType: 'product_type',
  vendor: 'vendor',
  tags: 'tags',
  seoTitle: 'seo_title',
  seoDescription: 'seo_description',
  metadata: 'metadata',
}

const VARIANT_COLUMNS: Record<string, string> = {
  title: 'title',
  sku: 'sku',
  barcode: 'barcode',
  priceAmount: 'price_amount',
  compareAtAmount: 'compare_at_amount',
  weightGrams: 'weight_grams',
  requiresShipping: 'requires_shipping',
  position: 'position',
  isActive: 'is_active',
  mediaId: 'media_id',
}

/**
 * Sort key → ORDER BY, as an allowlist.
 *
 * The clause is chosen from this table, never built from the caller's string,
 * which is the only construction that cannot be turned into an injection. Every
 * clause ends in `p.id` so paging is stable: two products created in the same
 * millisecond must not swap places between page 1 and page 2.
 */
const PRODUCT_ORDER: Record<string, (dir: 'ASC' | 'DESC') => string> = {
  created: (dir) => `ORDER BY p.created_at ${dir}, p.id ${dir}`,
  updated: (dir) => `ORDER BY p.updated_at ${dir}, p.id ${dir}`,
  title: (dir) => `ORDER BY lower(p.title) ${dir}, p.id ${dir}`,
  status: (dir) => `ORDER BY p.status ${dir}, p.created_at DESC, p.id DESC`,
  // NULLS LAST in both directions on purpose: a product with no buyable variant
  // has no price to sort by, and a shopper asking for "cheapest first" does not
  // want a column of sold-out items at the top.
  price: (dir) => `ORDER BY stock.price ${dir} NULLS LAST, p.id ASC`,
}

/**
 * Per-product price and stock, computed from its variants.
 *
 * Joined only when something actually asks for it — a price sort, a price
 * filter, or "in stock only" — so the ordinary listing keeps the exact query it
 * had before and pays nothing for a feature it is not using.
 *
 * `price` deliberately mirrors what `publicProductDto` prints: the minimum over
 * *purchasable* variants, falling back to sellable ones when none is in stock.
 * Sorting on any other figure would order the page by a number the shopper
 * cannot see, which reads as a broken sort rather than a subtle one.
 */
const STOCK_LATERAL = `LEFT JOIN LATERAL (
  SELECT coalesce(
           min(pv.price_amount) FILTER (WHERE ${IN_STOCK_PREDICATE}),
           min(pv.price_amount)
         ) AS price,
         coalesce(bool_or(${IN_STOCK_PREDICATE}), false) AS in_stock
    FROM product_variants pv
    ${inStockJoin('pv')}
   WHERE pv.product_id = p.id AND pv.archived_at IS NULL AND pv.is_active
) stock ON true`

function orderClause(sort: string | undefined, direction: string | undefined): string {
  const build = PRODUCT_ORDER[sort ?? 'created'] ?? PRODUCT_ORDER.created!
  return build(direction === 'asc' ? 'ASC' : 'DESC')
}

function assignments(
  patch: Record<string, unknown>,
  columns: Record<string, string>,
  params: unknown[],
): string[] {
  const out: string[] = []
  for (const [field, column] of Object.entries(columns)) {
    if (!(field in patch) || patch[field] === undefined) continue
    const value = patch[field]
    params.push(column === 'metadata' ? JSON.stringify(value) : value)
    // The column name comes from the allowlist above, never from input.
    out.push(`${column} = $${params.length}`)
  }
  return out
}

export const catalogueRepository = {
  // ── Products ──────────────────────────────────────────────────────────────

  async createProduct(input: {
    id: string
    handle: string
    title: string
    subtitle: string | null
    description: string | null
    categoryId: string | null
    productType: string | null
    vendor: string | null
    tags: string[]
    seoTitle: string | null
    seoDescription: string | null
    metadata: Record<string, unknown>
    createdBy: string | null
  }): Promise<Product> {
    const row = await queryOne<ProductRow>(
      `INSERT INTO products
         (id, handle, title, subtitle, description, category_id, product_type,
          vendor, tags, seo_title, seo_description, metadata, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        input.id,
        input.handle,
        input.title,
        input.subtitle,
        input.description,
        input.categoryId,
        input.productType,
        input.vendor,
        input.tags,
        input.seoTitle,
        input.seoDescription,
        JSON.stringify(input.metadata),
        input.createdBy,
      ],
      { name: 'catalogue.createProduct' },
    )
    if (!row) throw new Error('Failed to create product')
    return toProduct(row)
  },

  async findProductById(id: string): Promise<Product | undefined> {
    const row = await queryOne<ProductRow>(`SELECT * FROM products WHERE id = $1`, [id], {
      name: 'catalogue.findProductById',
    })
    return row ? toProduct(row) : undefined
  },

  async findProductByHandle(handle: string): Promise<Product | undefined> {
    const row = await queryOne<ProductRow>(`SELECT * FROM products WHERE handle = $1`, [handle], {
      name: 'catalogue.findProductByHandle',
    })
    return row ? toProduct(row) : undefined
  },

  /** Locks the product row, so concurrent edits to its variants serialise. */
  async lockProduct(id: string): Promise<boolean> {
    const row = await queryOne<{ one: number }>(
      `SELECT 1 AS one FROM products WHERE id = $1 FOR UPDATE`,
      [id],
      { name: 'catalogue.lockProduct' },
    )
    return row !== undefined
  },

  async updateProduct(id: string, patch: Record<string, unknown>): Promise<Product | undefined> {
    const params: unknown[] = []
    const sets = assignments(patch, PRODUCT_COLUMNS, params)
    if (sets.length === 0) return this.findProductById(id)

    params.push(id)
    const row = await queryOne<ProductRow>(
      `UPDATE products SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
      { name: 'catalogue.updateProduct' },
    )
    return row ? toProduct(row) : undefined
  },

  async setProductHandle(id: string, handle: string): Promise<void> {
    await execute(`UPDATE products SET handle = $2 WHERE id = $1`, [id, handle], {
      name: 'catalogue.setProductHandle',
    })
  },

  /**
   * Moves a product's lifecycle state.
   *
   * `archived_at` and `status` are set together because the table's CHECK
   * requires them to agree — the database will not hold a product that claims
   * to be archived without saying when.
   */
  async setProductStatus(id: string, status: ProductStatus): Promise<Product | undefined> {
    const row = await queryOne<ProductRow>(
      `UPDATE products
          SET status = $2,
              archived_at = CASE WHEN $2 = 'archived' THEN coalesce(archived_at, now()) ELSE NULL END
        WHERE id = $1
      RETURNING *`,
      [id, status],
      { name: 'catalogue.setProductStatus' },
    )
    return row ? toProduct(row) : undefined
  },

  /**
   * Lists products for either surface.
   *
   * The storefront passes `publishedOnly`, which turns into a join on
   * `product_publications` — visibility is a relationship, so it is expressed as
   * one rather than as a boolean column that later cannot answer "which
   * channel".
   *
   * Ordering comes from `orderClause`, which maps a closed set of keys onto
   * fixed SQL. Nothing a caller sends is ever interpolated into ORDER BY.
   */
  async listProducts(filter: ProductListFilter): Promise<{ rows: Product[]; total: number }> {
    const params: unknown[] = []
    const where: string[] = []
    const joins: string[] = []

    const add = (sql: string, value: unknown): void => {
      params.push(value)
      where.push(sql.replace('$?', `$${params.length}`))
    }

    if (filter.status) add('p.status = $?', filter.status)
    if (filter.categoryId) add('p.category_id = $?', filter.categoryId)
    if (filter.query) {
      // websearch_to_tsquery accepts what a person types, including quoted
      // phrases and `-exclusions`, and never throws on malformed input the way
      // to_tsquery does.
      add("p.search_vector @@ websearch_to_tsquery('simple', $?)", filter.query)
    }
    // Two kinds of collection, two ways of belonging to one. A manual
    // collection keeps its membership in `collection_products`; a dynamic one
    // has no rows there at all — its membership *is* its rules, evaluated now.
    // Joining the table for a dynamic collection would quietly return nothing.
    const byRules = filter.collectionRules !== undefined
    if (byRules) {
      const compiled = compileRules(filter.collectionRules as RuleSet, params.length)
      if (compiled.where) {
        params.push(...compiled.params)
        where.push(compiled.where)
      }
      // Same guard `productIdsMatching` applies, so the two agree on who is in.
      where.push('p.archived_at IS NULL')
    } else if (filter.collectionId) {
      params.push(filter.collectionId)
      joins.push(
        `JOIN collection_products cp ON cp.product_id = p.id AND cp.collection_id = $${params.length}`,
      )
    }
    // One lateral answers all three of these, so asking for a price sort and an
    // in-stock filter together costs the same as asking for either.
    const needsStock =
      filter.sort === 'price' ||
      filter.inStockOnly === true ||
      filter.minPriceAmount !== undefined ||
      filter.maxPriceAmount !== undefined
    if (needsStock) {
      joins.push(STOCK_LATERAL)
      if (filter.inStockOnly) where.push('stock.in_stock')
      if (filter.minPriceAmount !== undefined) add('stock.price >= $?', filter.minPriceAmount)
      if (filter.maxPriceAmount !== undefined) add('stock.price <= $?', filter.maxPriceAmount)
    }

    if (filter.publishedOnly) {
      params.push(filter.channelKey ?? 'storefront')
      joins.push(
        `JOIN product_publications pub ON pub.product_id = p.id
         JOIN sales_channels sc ON sc.id = pub.sales_channel_id
                               AND sc.key = $${params.length} AND sc.is_active`,
      )
      where.push(`p.status = 'active'`)
    }

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const from = `FROM products p ${joins.join(' ')} ${clause}`
    // Manual collection order is editorial content, so it is the default when
    // one is selected — but only the default. A shopper who asks for "cheapest
    // first" has overridden the merchandiser on purpose, and a sort control
    // that silently does nothing on a collection page is worse than no control.
    // A dynamic collection has no hand-placed order to honour either way.
    const order =
      filter.collectionId && !byRules && !filter.sort
        ? 'ORDER BY cp.position, p.created_at DESC, p.id DESC'
        : orderClause(filter.sort, filter.direction)

    const rows = await query<ProductRow>(
      `SELECT p.* ${from} ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filter.limit, filter.offset],
      { name: 'catalogue.listProducts' },
    )
    const totalRow = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count ${from}`,
      params,
      { name: 'catalogue.countProducts' },
    )

    return { rows: rows.map(toProduct), total: totalRow?.count ?? 0 }
  },

  // ── Options ───────────────────────────────────────────────────────────────

  async insertOption(input: {
    id: string
    productId: string
    name: string
    position: number
  }): Promise<void> {
    await execute(
      `INSERT INTO product_options (id, product_id, name, position) VALUES ($1,$2,$3,$4)`,
      [input.id, input.productId, input.name, input.position],
      { name: 'catalogue.insertOption' },
    )
  },

  async insertOptionValue(input: {
    id: string
    optionId: string
    value: string
    position: number
    swatchHex?: string | null
  }): Promise<void> {
    await execute(
      `INSERT INTO product_option_values (id, option_id, value, position, swatch_hex)
       VALUES ($1,$2,$3,$4,$5)`,
      [input.id, input.optionId, input.value, input.position, input.swatchHex ?? null],
      { name: 'catalogue.insertOptionValue' },
    )
  },

  /**
   * Sets or clears what one value looks like.
   *
   * Scoped to the option as well as the value, so an id from another product
   * cannot be recoloured through this path. Returns the number of rows touched
   * rather than the row: the caller re-reads the whole product anyway.
   */
  async setOptionValueSwatch(
    optionId: string,
    valueId: string,
    swatchHex: string | null,
  ): Promise<number> {
    return execute(
      `UPDATE product_option_values SET swatch_hex = $3 WHERE id = $2 AND option_id = $1`,
      [optionId, valueId, swatchHex],
      { name: 'catalogue.setOptionValueSwatch' },
    )
  },

  async optionsFor(productId: string): Promise<ProductOption[]> {
    const rows = await query<{
      id: string
      product_id: string
      name: string
      position: number
      value_id: string | null
      value: string | null
      value_position: number | null
      swatch_hex: string | null
    }>(
      `SELECT o.id, o.product_id, o.name, o.position,
              v.id AS value_id, v.value, v.position AS value_position, v.swatch_hex
         FROM product_options o
         LEFT JOIN product_option_values v ON v.option_id = o.id
        WHERE o.product_id = $1
        ORDER BY o.position, o.name, v.position, v.value`,
      [productId],
      { name: 'catalogue.optionsFor' },
    )

    const options = new Map<string, ProductOption>()
    for (const row of rows) {
      let option = options.get(row.id)
      if (!option) {
        option = {
          id: row.id,
          productId: row.product_id,
          name: row.name,
          position: row.position,
          values: [],
        }
        options.set(row.id, option)
      }
      if (row.value_id && row.value !== null) {
        option.values.push({
          id: row.value_id,
          optionId: row.id,
          value: row.value,
          position: row.value_position ?? 0,
          swatchHex: row.swatch_hex,
        })
      }
    }
    return [...options.values()]
  },

  async deleteOptions(productId: string): Promise<void> {
    await execute(`DELETE FROM product_options WHERE product_id = $1`, [productId], {
      name: 'catalogue.deleteOptions',
    })
  },

  /** One option, scoped to its product so a stray id cannot reach another's. */
  async findOption(productId: string, optionId: string): Promise<ProductOption | undefined> {
    const options = await this.optionsFor(productId)
    return options.find((option) => option.id === optionId)
  },

  /**
   * Rewrites one variant's option signature.
   *
   * Deliberately its own method rather than a key in `VARIANT_COLUMNS`: the
   * signature is derived state that the unique constraint keys on, and a caller
   * able to set it through the generic patch path could hand two variants the
   * same combination. Only the service that just recomputed it may write it.
   */
  async setVariantSignature(variantId: string, signature: string): Promise<void> {
    await execute(
      `UPDATE product_variants SET option_signature = $2 WHERE id = $1`,
      [variantId, signature],
      { name: 'catalogue.setVariantSignature' },
    )
  },

  async deleteOptionValue(optionId: string, valueId: string): Promise<number> {
    return execute(
      `DELETE FROM product_option_values WHERE id = $1 AND option_id = $2`,
      [valueId, optionId],
      { name: 'catalogue.deleteOptionValue' },
    )
  },

  /**
   * How many variants select this value, archived ones included.
   *
   * Archived is deliberately *not* excluded. `variant_option_values` holds the
   * selection with `ON DELETE RESTRICT`, so the database refuses to drop a
   * value any variant still references — and it is right to: an archived
   * variant is a historical record an order line still resolves through, and it
   * would stop rendering its own options if the value vanished underneath it.
   *
   * Counting the same set the constraint protects means the API answers with a
   * 409 and a sentence, rather than letting a foreign-key violation surface as
   * a 500.
   */
  async countVariantsUsingValue(valueId: string): Promise<{ total: number; live: number }> {
    const row = await queryOne<{ total: number; live: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE v.archived_at IS NULL)::int AS live
         FROM variant_option_values vov
         JOIN product_variants v ON v.id = vov.variant_id
        WHERE vov.option_value_id = $1`,
      [valueId],
      { name: 'catalogue.countVariantsUsingValue' },
    )
    return { total: row?.total ?? 0, live: row?.live ?? 0 }
  },

  // ── Variants ──────────────────────────────────────────────────────────────

  async insertVariant(input: {
    id: string
    productId: string
    title: string
    sku: string | null
    barcode: string | null
    priceAmount: number
    compareAtAmount: number | null
    currency: string
    weightGrams: number
    requiresShipping: boolean
    position: number
    isActive: boolean
    optionSignature: string
  }): Promise<ProductVariant> {
    const row = await queryOne<VariantRow>(
      `INSERT INTO product_variants
         (id, product_id, title, sku, barcode, price_amount, compare_at_amount, currency,
          weight_grams, requires_shipping, position, is_active, option_signature)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        input.id,
        input.productId,
        input.title,
        input.sku,
        input.barcode,
        input.priceAmount,
        input.compareAtAmount,
        input.currency,
        input.weightGrams,
        input.requiresShipping,
        input.position,
        input.isActive,
        input.optionSignature,
      ],
      { name: 'catalogue.insertVariant' },
    )
    if (!row) throw new Error('Failed to create variant')
    return toVariant(row)
  },

  async insertVariantSelection(input: {
    variantId: string
    optionId: string
    optionValueId: string
  }): Promise<void> {
    await execute(
      `INSERT INTO variant_option_values (variant_id, option_id, option_value_id)
       VALUES ($1,$2,$3)`,
      [input.variantId, input.optionId, input.optionValueId],
      { name: 'catalogue.insertVariantSelection' },
    )
  },

  async findVariantById(id: string): Promise<ProductVariant | undefined> {
    const row = await queryOne<VariantRow>(`SELECT * FROM product_variants WHERE id = $1`, [id], {
      name: 'catalogue.findVariantById',
    })
    return row ? toVariant(row) : undefined
  },

  async updateVariant(id: string, patch: Record<string, unknown>): Promise<ProductVariant | undefined> {
    const params: unknown[] = []
    const sets = assignments(patch, VARIANT_COLUMNS, params)
    if (sets.length === 0) return this.findVariantById(id)

    params.push(id)
    const row = await queryOne<VariantRow>(
      `UPDATE product_variants SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
      { name: 'catalogue.updateVariant' },
    )
    return row ? toVariant(row) : undefined
  },

  /**
   * Archives a variant. There is no delete: an order line will reference this
   * id for as long as the order exists, and history that dangles is worse than
   * history that says "discontinued".
   */
  async archiveVariant(id: string): Promise<void> {
    await execute(
      `UPDATE product_variants SET archived_at = now(), is_active = false WHERE id = $1`,
      [id],
      { name: 'catalogue.archiveVariant' },
    )
  },

  async variantsFor(productId: string, options: { includeArchived?: boolean } = {}) {
    const rows = await query<VariantRow>(
      `SELECT * FROM product_variants
        WHERE product_id = $1 ${options.includeArchived ? '' : 'AND archived_at IS NULL'}
        ORDER BY position, created_at, id`,
      [productId],
      { name: 'catalogue.variantsFor' },
    )
    return rows.map(toVariant)
  },

  async countLiveVariants(productId: string): Promise<number> {
    const row = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM product_variants
        WHERE product_id = $1 AND archived_at IS NULL`,
      [productId],
      { name: 'catalogue.countLiveVariants' },
    )
    return row?.count ?? 0
  },

  /** Every variant's selections for a product, resolved to names and values. */
  async selectionsFor(productId: string) {
    return query<{
      variant_id: string
      option_id: string
      option_name: string
      option_value_id: string
      value: string
      option_position: number
    }>(
      `SELECT vov.variant_id, vov.option_id, o.name AS option_name,
              vov.option_value_id, v.value, o.position AS option_position
         FROM variant_option_values vov
         JOIN product_variants pv ON pv.id = vov.variant_id
         JOIN product_options o ON o.id = vov.option_id
         JOIN product_option_values v ON v.id = vov.option_value_id
        WHERE pv.product_id = $1
        ORDER BY o.position, o.name`,
      [productId],
      { name: 'catalogue.selectionsFor' },
    )
  },

  // ── Media ─────────────────────────────────────────────────────────────────

  async attachMedia(input: {
    id: string
    productId: string
    mediaId: string
    alt: string | null
    position: number
    isPrimary: boolean
  }): Promise<void> {
    await execute(
      `INSERT INTO product_media (id, product_id, media_id, alt, position, is_primary)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [input.id, input.productId, input.mediaId, input.alt, input.position, input.isPrimary],
      { name: 'catalogue.attachMedia' },
    )
  },

  async clearPrimaryMedia(productId: string): Promise<void> {
    await execute(
      `UPDATE product_media SET is_primary = false WHERE product_id = $1 AND is_primary`,
      [productId],
      { name: 'catalogue.clearPrimaryMedia' },
    )
  },

  async setPrimaryMedia(productMediaId: string): Promise<number> {
    return execute(`UPDATE product_media SET is_primary = true WHERE id = $1`, [productMediaId], {
      name: 'catalogue.setPrimaryMedia',
    })
  },

  async setMediaPosition(productMediaId: string, position: number): Promise<void> {
    await execute(`UPDATE product_media SET position = $2 WHERE id = $1`, [productMediaId, position], {
      name: 'catalogue.setMediaPosition',
    })
  },

  async detachMedia(productId: string, productMediaId: string): Promise<number> {
    return execute(`DELETE FROM product_media WHERE id = $1 AND product_id = $2`, [
      productMediaId,
      productId,
    ], { name: 'catalogue.detachMedia' })
  },

  /**
   * One line of summary per product, for a listing.
   *
   * Three facts a product index needs and a `products` row does not carry: the
   * picture, how many variants there are, and how much stock is behind them.
   *
   * Batched over the whole page in a single statement rather than asked per
   * row. Twenty rows is twenty products, and a per-row query is how a listing
   * that felt fine on the demo catalogue becomes unusable on a real one.
   *
   * `available` is null when *nothing* on the product is tracked — which is a
   * different fact from zero, and the caller renders it differently.
   */
  async summariesFor(productIds: string[]): Promise<
    Map<
      string,
      {
        mediaId: string | null
        variantCount: number
        available: number | null
      }
    >
  > {
    const out = new Map<
      string,
      { mediaId: string | null; variantCount: number; available: number | null }
    >()
    if (productIds.length === 0) return out

    const rows = await query<{
      product_id: string
      media_id: string | null
      variant_count: number
      available: number | null
    }>(
      `SELECT p.id AS product_id,
              img.media_id,
              coalesce(v.variant_count, 0)::int AS variant_count,
              v.available
         FROM unnest($1::uuid[]) AS p(id)
         LEFT JOIN LATERAL (
           SELECT pm.media_id
             FROM product_media pm
            WHERE pm.product_id = p.id
            ORDER BY pm.is_primary DESC, pm.position, pm.id
            LIMIT 1
         ) img ON true
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS variant_count,
                  -- Null when no variant is tracked at all: "untracked" and
                  -- "none left" must not render the same way.
                  CASE WHEN bool_or(inv.track_inventory) THEN
                    coalesce(sum(lvl.available) FILTER (WHERE inv.track_inventory), 0)::int
                  END AS available
             FROM product_variants pv
             ${inStockJoin('pv')}
            WHERE pv.product_id = p.id AND pv.archived_at IS NULL AND pv.is_active
         ) v ON true`,
      [productIds],
      { name: 'catalogue.summariesFor' },
    )

    for (const row of rows) {
      out.set(row.product_id, {
        mediaId: row.media_id,
        variantCount: row.variant_count,
        available: row.available,
      })
    }
    return out
  },

  async mediaFor(productId: string): Promise<ProductMedia[]> {
    const rows = await query<{
      id: string
      product_id: string
      media_id: string
      alt: string | null
      position: number
      is_primary: boolean
    }>(
      `SELECT id, product_id, media_id, alt, position, is_primary
         FROM product_media WHERE product_id = $1
        ORDER BY is_primary DESC, position, id`,
      [productId],
      { name: 'catalogue.mediaFor' },
    )
    return rows.map((row) => ({
      id: row.id,
      productId: row.product_id,
      mediaId: row.media_id,
      alt: row.alt,
      position: row.position,
      isPrimary: row.is_primary,
    }))
  },

  async findProductMedia(productId: string, productMediaId: string): Promise<ProductMedia | undefined> {
    const all = await this.mediaFor(productId)
    return all.find((entry) => entry.id === productMediaId)
  },

  // ── Publication ───────────────────────────────────────────────────────────

  async findChannelByKey(key: string): Promise<SalesChannel | undefined> {
    const row = await queryOne<{
      id: string
      key: string
      name: string
      is_default: boolean
      is_active: boolean
    }>(`SELECT * FROM sales_channels WHERE key = $1`, [key], {
      name: 'catalogue.findChannelByKey',
    })
    return row
      ? {
          id: row.id,
          key: row.key,
          name: row.name,
          isDefault: row.is_default,
          isActive: row.is_active,
        }
      : undefined
  },

  async defaultChannel(): Promise<SalesChannel> {
    const row = await queryOne<{
      id: string
      key: string
      name: string
      is_default: boolean
      is_active: boolean
    }>(`SELECT * FROM sales_channels WHERE is_default`, [], {
      name: 'catalogue.defaultChannel',
    })
    if (!row) throw new Error('No default sales channel — migration 0007 has not been applied')
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      isDefault: row.is_default,
      isActive: row.is_active,
    }
  },

  /** Idempotent: publishing an already-published product is not an error. */
  async publish(productId: string, channelId: string, actorUserId: string | null): Promise<number> {
    return execute(
      `INSERT INTO product_publications (product_id, sales_channel_id, published_by)
       VALUES ($1,$2,$3)
       ON CONFLICT (product_id, sales_channel_id) DO NOTHING`,
      [productId, channelId, actorUserId],
      { name: 'catalogue.publish' },
    )
  },

  async unpublish(productId: string, channelId: string): Promise<number> {
    return execute(
      `DELETE FROM product_publications WHERE product_id = $1 AND sales_channel_id = $2`,
      [productId, channelId],
      { name: 'catalogue.unpublish' },
    )
  },

  async unpublishEverywhere(productId: string): Promise<number> {
    return execute(`DELETE FROM product_publications WHERE product_id = $1`, [productId], {
      name: 'catalogue.unpublishEverywhere',
    })
  },

  async publicationsFor(productId: string): Promise<Publication[]> {
    const rows = await query<{ sales_channel_id: string; key: string; published_at: Date }>(
      `SELECT pub.sales_channel_id, sc.key, pub.published_at
         FROM product_publications pub
         JOIN sales_channels sc ON sc.id = pub.sales_channel_id
        WHERE pub.product_id = $1
        ORDER BY sc.key`,
      [productId],
      { name: 'catalogue.publicationsFor' },
    )
    return rows.map((row) => ({
      salesChannelId: row.sales_channel_id,
      channelKey: row.key,
      publishedAt: row.published_at,
    }))
  },

  async isPublishedOn(productId: string, channelKey: string): Promise<boolean> {
    const row = await queryOne<{ one: number }>(
      `SELECT 1 AS one
         FROM product_publications pub
         JOIN sales_channels sc ON sc.id = pub.sales_channel_id
        WHERE pub.product_id = $1 AND sc.key = $2 AND sc.is_active`,
      [productId, channelKey],
      { name: 'catalogue.isPublishedOn' },
    )
    return row !== undefined
  },

  // ── Categories ────────────────────────────────────────────────────────────

  async createCategory(input: {
    id: string
    parentId: string | null
    name: string
    handle: string
    description: string | null
    imageId: string | null
    position: number
  }): Promise<Category> {
    const row = await queryOne<CategoryRow>(
      `INSERT INTO categories (id, parent_id, name, handle, description, image_id, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        input.id,
        input.parentId,
        input.name,
        input.handle,
        input.description,
        input.imageId,
        input.position,
      ],
      { name: 'catalogue.createCategory' },
    )
    if (!row) throw new Error('Failed to create category')
    return toCategory(row)
  },

  async findCategoryById(id: string): Promise<Category | undefined> {
    const row = await queryOne<CategoryRow>(`SELECT * FROM categories WHERE id = $1`, [id], {
      name: 'catalogue.findCategoryById',
    })
    return row ? toCategory(row) : undefined
  },

  async findCategoryByHandle(handle: string): Promise<Category | undefined> {
    const row = await queryOne<CategoryRow>(`SELECT * FROM categories WHERE handle = $1`, [handle], {
      name: 'catalogue.findCategoryByHandle',
    })
    return row ? toCategory(row) : undefined
  },

  async listCategories(options: { activeOnly?: boolean } = {}): Promise<Category[]> {
    const rows = await query<CategoryRow>(
      `SELECT * FROM categories
        WHERE archived_at IS NULL ${options.activeOnly ? 'AND is_active' : ''}
        ORDER BY position, name`,
      [],
      { name: 'catalogue.listCategories' },
    )
    return rows.map(toCategory)
  },

  async updateCategory(id: string, patch: Record<string, unknown>): Promise<Category | undefined> {
    const params: unknown[] = []
    const sets = assignments(patch, {
      parentId: 'parent_id',
      name: 'name',
      handle: 'handle',
      description: 'description',
      imageId: 'image_id',
      position: 'position',
      isActive: 'is_active',
    }, params)
    if (sets.length === 0) return this.findCategoryById(id)

    params.push(id)
    const row = await queryOne<CategoryRow>(
      `UPDATE categories SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
      { name: 'catalogue.updateCategory' },
    )
    return row ? toCategory(row) : undefined
  },

  async countProductsInCategory(categoryId: string): Promise<number> {
    const row = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM products WHERE category_id = $1`,
      [categoryId],
      { name: 'catalogue.countProductsInCategory' },
    )
    return row?.count ?? 0
  },

  async countChildCategories(categoryId: string): Promise<number> {
    const row = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM categories
        WHERE parent_id = $1 AND archived_at IS NULL`,
      [categoryId],
      { name: 'catalogue.countChildCategories' },
    )
    return row?.count ?? 0
  },

  async archiveCategory(id: string): Promise<void> {
    await execute(
      `UPDATE categories SET archived_at = now(), is_active = false WHERE id = $1`,
      [id],
      { name: 'catalogue.archiveCategory' },
    )
  },

  /**
   * Every ancestor of a category, nearest first.
   *
   * A recursive CTE rather than a loop of queries, and bounded by depth so a
   * cycle introduced by some future bug produces a bounded result instead of
   * spinning.
   */
  async ancestorsOf(categoryId: string): Promise<Category[]> {
    const rows = await query<CategoryRow & { depth: number }>(
      `WITH RECURSIVE chain AS (
         SELECT c.*, 0 AS depth FROM categories c WHERE c.id = $1
         UNION ALL
         SELECT parent.*, chain.depth + 1
           FROM categories parent
           JOIN chain ON parent.id = chain.parent_id
          WHERE chain.depth < 20
       )
       SELECT * FROM chain WHERE depth > 0 ORDER BY depth`,
      [categoryId],
      { name: 'catalogue.ancestorsOf' },
    )
    return rows.map(toCategory)
  },

  // ── Collections ───────────────────────────────────────────────────────────

  async createCollection(input: {
    id: string
    handle: string
    title: string
    description: string | null
    imageId: string | null
    position: number
    seoTitle: string | null
    seoDescription: string | null
    type: CollectionType
    rules: RuleSet
  }): Promise<Collection> {
    const row = await queryOne<CollectionRow>(
      `INSERT INTO collections
         (id, handle, title, description, image_id, position, seo_title, seo_description,
          type, rules)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        input.id,
        input.handle,
        input.title,
        input.description,
        input.imageId,
        input.position,
        input.seoTitle,
        input.seoDescription,
        input.type,
        JSON.stringify(input.rules),
      ],
      { name: 'catalogue.createCollection' },
    )
    if (!row) throw new Error('Failed to create collection')
    return toCollection(row)
  },

  async findCollectionById(id: string): Promise<Collection | undefined> {
    const row = await queryOne<CollectionRow>(`SELECT * FROM collections WHERE id = $1`, [id], {
      name: 'catalogue.findCollectionById',
    })
    return row ? toCollection(row) : undefined
  },

  async findCollectionByHandle(handle: string): Promise<Collection | undefined> {
    const row = await queryOne<CollectionRow>(
      `SELECT * FROM collections WHERE handle = $1`,
      [handle],
      { name: 'catalogue.findCollectionByHandle' },
    )
    return row ? toCollection(row) : undefined
  },

  async listCollections(options: { activeOnly?: boolean } = {}): Promise<Collection[]> {
    const rows = await query<CollectionRow>(
      `SELECT * FROM collections
        WHERE archived_at IS NULL ${options.activeOnly ? 'AND is_active' : ''}
        ORDER BY position, title`,
      [],
      { name: 'catalogue.listCollections' },
    )
    return rows.map(toCollection)
  },

  async updateCollection(id: string, patch: Record<string, unknown>): Promise<Collection | undefined> {
    const params: unknown[] = []
    const sets = assignments(patch, {
      handle: 'handle',
      title: 'title',
      description: 'description',
      imageId: 'image_id',
      position: 'position',
      isActive: 'is_active',
      seoTitle: 'seo_title',
      seoDescription: 'seo_description',
      type: 'type',
      rules: 'rules',
    }, params)
    if (sets.length === 0) return this.findCollectionById(id)

    params.push(id)
    const row = await queryOne<CollectionRow>(
      `UPDATE collections SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
      { name: 'catalogue.updateCollection' },
    )
    return row ? toCollection(row) : undefined
  },

  async archiveCollection(id: string): Promise<void> {
    await execute(
      `UPDATE collections SET archived_at = now(), is_active = false WHERE id = $1`,
      [id],
      { name: 'catalogue.archiveCollection' },
    )
  },

  /** Replaces a collection's membership wholesale, preserving the given order. */
  async replaceCollectionProducts(collectionId: string, productIds: string[]): Promise<void> {
    await execute(`DELETE FROM collection_products WHERE collection_id = $1`, [collectionId], {
      name: 'catalogue.clearCollectionProducts',
    })
    if (productIds.length === 0) return

    // One statement with unnest, rather than N inserts: the position is the
    // array index, so the order the operator chose is the order stored.
    await execute(
      `INSERT INTO collection_products (collection_id, product_id, position)
       SELECT $1, id, ordinality - 1
         FROM unnest($2::uuid[]) WITH ORDINALITY AS t(id, ordinality)`,
      [collectionId, productIds],
      { name: 'catalogue.replaceCollectionProducts' },
    )
  },

  /**
   * Everything a cart line or an order line needs about a variant, in one
   * query.
   *
   * This is the *purchase* view of the catalogue: the fields an order will
   * snapshot, plus enough to decide whether the thing can still be sold. It
   * exists as its own query rather than reusing `detail()` because a cart with
   * eight lines must not become eight product loads.
   */
  async variantsForPurchase(variantIds: string[]) {
    if (variantIds.length === 0) return []
    return query<{
      variant_id: string
      product_id: string
      handle: string
      product_title: string
      variant_title: string
      sku: string | null
      price_amount: number
      currency: string
      weight_grams: number
      requires_shipping: boolean
      variant_active: boolean
      variant_archived: boolean
      product_status: string
      published: boolean
      category_id: string | null
      options: { name: string; value: string }[]
      media_id: string | null
    }>(
      `SELECT v.id AS variant_id,
              p.id AS product_id,
              p.handle,
              p.title AS product_title,
              v.title AS variant_title,
              v.sku,
              v.price_amount,
              v.currency,
              v.weight_grams,
              v.requires_shipping,
              v.is_active AS variant_active,
              (v.archived_at IS NOT NULL) AS variant_archived,
              p.status AS product_status,
              p.category_id,
              EXISTS (
                SELECT 1 FROM product_publications pub
                  JOIN sales_channels sc ON sc.id = pub.sales_channel_id
                 WHERE pub.product_id = p.id AND sc.key = $2 AND sc.is_active
              ) AS published,
              coalesce(
                (SELECT jsonb_agg(jsonb_build_object('name', o.name, 'value', ov.value)
                                  ORDER BY o.position)
                   FROM variant_option_values vov
                   JOIN product_options o ON o.id = vov.option_id
                   JOIN product_option_values ov ON ov.id = vov.option_value_id
                  WHERE vov.variant_id = v.id),
                '[]'::jsonb
              ) AS options,
              (SELECT pm.media_id FROM product_media pm
                WHERE pm.product_id = p.id
                ORDER BY pm.is_primary DESC, pm.position LIMIT 1) AS media_id
         FROM product_variants v
         JOIN products p ON p.id = v.product_id
        WHERE v.id = ANY($1::uuid[])`,
      [variantIds, 'storefront'],
      { name: 'catalogue.variantsForPurchase' },
    )
  },

  async collectionIdsFor(productId: string): Promise<string[]> {
    const rows = await query<{ collection_id: string }>(
      `SELECT collection_id FROM collection_products WHERE product_id = $1`,
      [productId],
      { name: 'catalogue.collectionIdsFor' },
    )
    return rows.map((row) => row.collection_id)
  },

  async productIdsInCollection(collectionId: string): Promise<string[]> {
    const rows = await query<{ product_id: string }>(
      `SELECT product_id FROM collection_products
        WHERE collection_id = $1 ORDER BY position`,
      [collectionId],
      { name: 'catalogue.productIdsInCollection' },
    )
    return rows.map((row) => row.product_id)
  },

  /**
   * Adds products to a manual collection, keeping the ones already there.
   *
   * Appended after the current end rather than at position zero: a merchant
   * adding to a list they have arranged expects the arrangement to survive.
   * `ON CONFLICT DO NOTHING` makes adding something twice a no-op instead of an
   * error, which is what a multi-select on a product list will do routinely.
   */
  async addCollectionProducts(collectionId: string, productIds: string[]): Promise<number> {
    if (productIds.length === 0) return 0
    return execute(
      `INSERT INTO collection_products (collection_id, product_id, position)
       SELECT $1, t.id,
              coalesce((SELECT max(position) FROM collection_products
                         WHERE collection_id = $1), -1) + t.ordinality
         FROM unnest($2::uuid[]) WITH ORDINALITY AS t(id, ordinality)
       ON CONFLICT (collection_id, product_id) DO NOTHING`,
      [collectionId, productIds],
      { name: 'catalogue.addCollectionProducts' },
    )
  },

  async removeCollectionProducts(collectionId: string, productIds: string[]): Promise<number> {
    if (productIds.length === 0) return 0
    return execute(
      `DELETE FROM collection_products WHERE collection_id = $1 AND product_id = ANY($2::uuid[])`,
      [collectionId, productIds],
      { name: 'catalogue.removeCollectionProducts' },
    )
  },

  /**
   * The collections one product belongs to, for the product page.
   *
   * Manual membership only — a dynamic collection has no rows here, and asking
   * "which smart collections contain this product" is a different query
   * entirely, answered by the service running each rule set.
   */
  async manualCollectionsForProduct(productId: string): Promise<Collection[]> {
    const rows = await query<CollectionRow>(
      `SELECT c.* FROM collections c
         JOIN collection_products cp ON cp.collection_id = c.id
        WHERE cp.product_id = $1 AND c.archived_at IS NULL
        ORDER BY c.position, c.title`,
      [productId],
      { name: 'catalogue.manualCollectionsForProduct' },
    )
    return rows.map(toCollection)
  },

  /** Every dynamic collection, for working out which ones match a product. */
  async dynamicCollections(): Promise<Collection[]> {
    const rows = await query<CollectionRow>(
      `SELECT * FROM collections
        WHERE type = 'dynamic' AND archived_at IS NULL
        ORDER BY position, title`,
      [],
      { name: 'catalogue.dynamicCollections' },
    )
    return rows.map(toCollection)
  },

  // ── Rule evaluation ───────────────────────────────────────────────────────

  /**
   * Product ids matching a rule set, newest first.
   *
   * Ids rather than rows: every caller already has a product loader that
   * assembles variants, media and publications, and a second assembly here
   * would be a second definition of what a product is.
   */
  async productIdsMatching(
    rules: RuleSet,
    options: { limit?: number; offset?: number } = {},
  ): Promise<string[]> {
    const compiled = compileRules(rules)
    const params: unknown[] = [...compiled.params]

    params.push(options.limit ?? 50)
    const limit = `$${params.length}`
    params.push(options.offset ?? 0)
    const offset = `$${params.length}`

    const rows = await query<{ id: string }>(
      `SELECT p.id FROM products p
        WHERE p.archived_at IS NULL ${compiled.where ? `AND ${compiled.where}` : ''}
        ORDER BY p.created_at DESC, p.id
        LIMIT ${limit} OFFSET ${offset}`,
      params,
      { name: 'catalogue.productIdsMatching' },
    )
    return rows.map((row) => row.id)
  },

  async countProductsMatching(rules: RuleSet): Promise<number> {
    const compiled = compileRules(rules)
    const row = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM products p
        WHERE p.archived_at IS NULL ${compiled.where ? `AND ${compiled.where}` : ''}`,
      compiled.params,
      { name: 'catalogue.countProductsMatching' },
    )
    return row?.count ?? 0
  },

  /** Whether one product satisfies a rule set — "is it in this collection?". */
  async productMatchesRules(productId: string, rules: RuleSet): Promise<boolean> {
    const compiled = compileRules(rules, 1)
    const row = await queryOne<{ matched: boolean }>(
      `SELECT true AS matched FROM products p
        WHERE p.id = $1 AND p.archived_at IS NULL
          ${compiled.where ? `AND ${compiled.where}` : ''}`,
      [productId, ...compiled.params],
      { name: 'catalogue.productMatchesRules' },
    )
    return row?.matched ?? false
  },
}
