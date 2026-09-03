import { api } from '@/lib/api'

/**
 * The public catalogue.
 *
 * Everything here has passed three gates on the server before it is returned:
 * the product is active, it is published to this channel, and the variant is
 * sellable. So the storefront never has to ask "should this be visible" — if
 * it came back, it is for sale.
 *
 * **Collections lead; categories are the second way in.** The two answer
 * different questions and both are offered, in that order of prominence. A
 * category is where a product *files* — one each, in a tree the merchant
 * maintains — and a collection is where products *appear together*, hand-picked
 * or by rule. The front page and the main navigation are collections, because a
 * shopper arriving cold wants "gifts under £30", not a taxonomy.
 *
 * Categories earn their place for the shopper who knows what kind of thing they
 * want. They are exposed as a browsable tree rather than as the whole tree at
 * once: the top level is the menu, and each category page shows its own
 * children alongside its products, so a deep taxonomy is walked a level at a
 * time instead of being flattened into a menu with a thousand entries.
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
        // A handle, resolved on the server. An unknown one comes back as an
        // empty page rather than an error, so a stale link shows "nothing
        // here" instead of breaking.
        category: params.category,
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

  /** The whole active tree, each node carrying its own children. */
  categories: () => api.get('/storefront/categories'),

  /** One category, with the trail back to the root for breadcrumbs. */
  category: (handle) => api.get(`/storefront/categories/${handle}`),
}
