export { productsApi } from './api/products.api'
export {
  productKeys,
  useAddOption,
  useAddOptionValue,
  useAddVariant,
  useAdjustStock,
  useArchiveVariant,
  useAttachProductMedia,
  useCreateProduct,
  useDetachProductMedia,
  useProduct,
  useProductLifecycle,
  useProductPublication,
  useProducts,
  useReorderProductMedia,
  useRemoveOptionValue,
  useReplaceOptions,
  useUpdateInventoryItem,
  useUpdateProduct,
  useUpdateVariant,
  useVariantInventory,
  type ProductLifecycleAction,
} from './hooks/products.hooks'
export { ProductCreatePage } from './pages/ProductCreatePage'
export { ProductEditPage } from './pages/ProductEditPage'
export { ProductListPage } from './pages/ProductListPage'
export { ProductStatusBadge, PublicationBadge } from './components/ProductStatusBadge'
export type {
  AddOptionInput,
  CreateProductInput,
  ProductDetail,
  ProductListParams,
  ProductSortKey,
  ProductStatus,
  ProductSummary,
  ProductVariant,
  UpdateProductInput,
  UpdateVariantInput,
  VariantInventory,
} from './types/products.types'
