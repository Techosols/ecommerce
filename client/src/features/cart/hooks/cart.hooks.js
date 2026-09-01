import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { cartApi } from '../api/cart.api'

export const cartKey = ['cart']

/**
 * The basket, fetched once and shared by the header, the cart page and
 * checkout.
 *
 * `staleTime: 0` on purpose. A basket is the one thing on the storefront that
 * must never be stale: prices and availability are re-resolved on every read,
 * and a shopper looking at a line that sold out ten minutes ago should be told
 * here rather than at the till.
 */
export function useCart() {
  return useQuery({
    queryKey: cartKey,
    queryFn: () => cartApi.get(),
    staleTime: 0,
  })
}

/**
 * Every write adopts the cart that comes back.
 *
 * Not `invalidateQueries` — the response *is* the new state, already re-priced,
 * so refetching would ask the same question twice and flicker the totals in
 * between.
 */
function useCartWrite(mutationFn) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn,
    onSuccess: (cart) => queryClient.setQueryData(cartKey, cart),
  })
}

export function useAddToCart() {
  return useCartWrite(({ variantId, quantity }) => cartApi.add(variantId, quantity))
}

export function useSetCartQuantity() {
  return useCartWrite(({ variantId, quantity }) => cartApi.setQuantity(variantId, quantity))
}

export function useRemoveFromCart() {
  return useCartWrite((variantId) => cartApi.remove(variantId))
}

export function useClearCart() {
  return useCartWrite(() => cartApi.clear())
}

/** Total units in the basket, for the header badge. */
export function cartCount(cart) {
  return cart?.totals?.itemCount ?? 0
}
