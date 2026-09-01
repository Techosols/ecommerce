/**
 * The product form's field set, taken from `createProductSchema` and
 * `updateProductSchema`.
 *
 * Every optional text field is a `string` rather than `string | null` because
 * an input cannot hold `null`. The edit page converts blanks back to `null` on
 * the way out, which is what clears a value on the server.
 *
 * The SEO pair *is* here, in its own card. The storefront falls back to the
 * title and subtitle when they are unset, so they are genuinely optional — but
 * "optional" is not "absent", and a merchant who wants to write a different
 * page title for search had no way to do it.
 */
export interface ProductDetailsValues extends Record<string, unknown> {
  title: string
  handle: string
  subtitle: string
  description: string
  categoryId: string
  productType: string
  vendor: string
  tags: string[]
  seoTitle: string
  seoDescription: string
}

/** Blank values for a new product. */
export function emptyProductDetails(): ProductDetailsValues {
  return {
    title: '',
    handle: '',
    subtitle: '',
    description: '',
    categoryId: '',
    productType: '',
    vendor: '',
    tags: [],
    seoTitle: '',
    seoDescription: '',
  }
}
