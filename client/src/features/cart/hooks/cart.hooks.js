import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { EVENTS, track } from '@/lib/analytics'
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
function useCartWrite(mutationFn, report) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn,
    onSuccess: (cart, input) => {
      queryClient.setQueryData(cartKey, cart)
      // After the cache, and never awaited: the basket must be on screen
      // whatever the beacon does.
      report?.(cart, input)
    },
  })
}

/**
 * Basket writes are reported from here, not from the buttons.
 *
 * Every add in the shop goes through this hook — the product page, the quick
 * add on a card, the "buy it again" on an order — so one call here counts all
 * of them, and a button somebody adds next year is counted without them having
 * to remember. Reported on success only: an add the server refused for lack of
 * stock did not happen, and counting it would overstate the basket step of
 * every funnel it appears in.
 */
export function useAddToCart() {
  return useCartWrite(({ variantId, quantity }) => cartApi.add(variantId, quantity), (cart, input) =>
    track(EVENTS.CART_ITEM_ADDED, {
      variantId: input.variantId,
      quantity: input.quantity,
      cartValue: cart?.totals?.subtotal?.amount,
    }),
  )
}

export function useSetCartQuantity() {
  return useCartWrite(({ variantId, quantity }) => cartApi.setQuantity(variantId, quantity))
}

export function useRemoveFromCart() {
  return useCartWrite(
    (variantId) => cartApi.remove(variantId),
    (cart, variantId) => track(EVENTS.CART_ITEM_REMOVED, { variantId }),
  )
}

export function useClearCart() {
  return useCartWrite(() => cartApi.clear())
}

/** Total units in the basket, for the header badge. */
export function cartCount(cart) {
  return cart?.totals?.itemCount ?? 0
}
