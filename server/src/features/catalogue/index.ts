/**
 * Public surface of the `catalogue` feature (§2.2).
 *
 * Products, options, variants, media links, categories and collections are one
 * feature rather than five, because they are one aggregate: a variant is
 * meaningless without its product, and every write that touches one touches the
 * others in the same transaction.
 *
 * Routes are mounted by `router.ts` directly, not re-exported here.
 */
export { productsService, invalidateProduct, optionSignature } from './products.service.js'
export { categoriesService, collectionsService } from './taxonomy.service.js'
export { handles, slugify } from './handles.js'
export { publicProductDto, publicProductCardDto, resolveAvailability } from './catalogue.mapper.js'
export { assertPriceAcceptable, resolvePrice, money, storeCurrency } from './pricing.js'
export type {
  Money,
  Product,
  ProductDetail,
  ProductStatus,
  ProductVariant,
  ProductOption,
  ProductOptionValue,
  ProductMedia,
  ProductListFilter,
  Category,
  CategoryNode,
  Collection,
  CollectionType,
  Publication,
  SalesChannel,
  CreateProductInput,
  CreateVariantInput,
  UpdateProductInput,
  UpdateVariantInput,
  VariantSelection,
} from './catalogue.types.js'
