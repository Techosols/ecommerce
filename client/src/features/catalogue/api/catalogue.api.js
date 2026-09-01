import { api } from '@/lib/api'

/**
 * The public catalogue.
 *
 * Everything here has passed three gates on the server before it is returned:
 * the product is active, it is published to this channel, and the variant is
 * sellable. So the storefront never has to ask "should this be visible" — if
 * it came back, it is for sale.
 *
 * **The shop browses by collection, not by category.** Both exist on the
 * server and they answer different questions: a category is where a product
 * *files* (one each, a deep tree the merchant maintains), a collection is
 * where products *appear together* (a hand-picked list, or a rule). A shopper
 * wants the second. The category tree is also the wrong shape for a shopfront
 * — it can run to thousands of nodes, most of them empty.
 *
 * Note what the URLs carry: **handles, never ids**. `?collection=bestsellers`
 * is an address a person can read, type and link to; a uuid is not. The server
 * resolves the handle and answers an unknown one with an empty page rather
 * than an error, because a stale link should show "nothing here", not a crash.
 */
export const catalogueApi = {
  products: (params = {}) =>
    api.list('/storefront/products', {
      query: {
        page: params.page,
        limit: params.limit,
        collection: params.collection,
        // Sorting and filtering are the server's. `buildQuery` drops empty
        // values, so an unset filter never reaches the API as a filter that
        // filters nothing.
        sort: params.sort,
        minPrice: params.minPrice,
        maxPrice: params.maxPrice,
        inStock: params.inStock,
        q: params.q,
      },
    }),

  product: (handle) => api.get(`/storefront/products/${handle}`),

  collections: () => api.get('/storefront/collections'),

  collection: (handle) => api.get(`/storefront/collections/${handle}`),
}
