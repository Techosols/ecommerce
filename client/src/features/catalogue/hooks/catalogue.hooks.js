import { useQuery } from '@tanstack/react-query'
import { catalogueApi } from '../api/catalogue.api'

export const catalogueKeys = {
  all: ['catalogue'],
  products: (params) => ['catalogue', 'products', params],
  product: (handle) => ['catalogue', 'product', handle],
  collections: () => ['catalogue', 'collections'],
  collection: (handle) => ['catalogue', 'collection', handle],
}

/**
 * A page of products.
 *
 * `placeholderData` keeps the previous page on screen while the next one
 * loads, so paging does not blank the grid and bounce the scroll position.
 */
export function useProducts(params) {
  return useQuery({
    queryKey: catalogueKeys.products(params),
    queryFn: () => catalogueApi.products(params),
    placeholderData: (previous) => previous,
  })
}

/**
 * One product, by handle.
 *
 * Availability is resolved per request on the server and never cached with the
 * product's shape, so this is deliberately not given a long `staleTime`: a
 * shopper looking at a size that just sold out should find out here, not in
 * the basket.
 */
export function useProduct(handle) {
  return useQuery({
    queryKey: catalogueKeys.product(handle),
    queryFn: () => catalogueApi.product(handle),
    enabled: Boolean(handle),
  })
}

/**
 * Every collection the shop offers.
 *
 * Fetched once and held for a long time: it is the same for every shopper and
 * changes when a merchant edits it, which is not something a browsing session
 * needs to notice within the minute.
 */
export function useCollections() {
  return useQuery({
    queryKey: catalogueKeys.collections(),
    queryFn: () => catalogueApi.collections(),
    staleTime: 10 * 60 * 1000,
  })
}

export function useCollection(handle) {
  return useQuery({
    queryKey: catalogueKeys.collection(handle),
    queryFn: () => catalogueApi.collection(handle),
    enabled: Boolean(handle),
    staleTime: 10 * 60 * 1000,
  })
}
