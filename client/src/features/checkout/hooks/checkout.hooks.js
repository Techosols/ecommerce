import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { cartKey } from '@/features/cart/hooks/cart.hooks'
import { checkoutApi } from '../api/checkout.api'

/**
 * The live quote.
 *
 * Re-asked whenever the country, the delivery choice, the code or the payment
 * method changes, because each of those changes the answer — and the answer is
 * the server's, never assembled here.
 *
 * Not run at all until there is a country to rate against: delivery is priced
 * per destination, and asking without one would be a request the server can
 * only refuse.
 */
export function useCheckoutPreview(params) {
  return useQuery({
    queryKey: ['checkout', 'preview', params],
    queryFn: () => checkoutApi.preview(params),
    enabled: Boolean(params.countryCode) && params.countryCode.length === 2,
    placeholderData: (previous) => previous,
    // A bad discount code is a 4xx the shopper must see and fix, not something
    // to retry three times before telling them.
    retry: false,
    staleTime: 0,
  })
}

export function usePlaceOrder() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ body, idempotencyKey }) => checkoutApi.place(body, idempotencyKey),
    onSuccess: () => {
      // The basket is now an order and the server has cleared the guest cookie.
      queryClient.removeQueries({ queryKey: cartKey })
    },
  })
}

export function useOrderLookup() {
  return useMutation({
    mutationFn: ({ orderNumber, email }) => checkoutApi.lookup(orderNumber, email),
  })
}

/**
 * A guest stopping an order nobody has packed yet.
 *
 * Scoped by the same order number and email the lookup uses. The server refuses
 * anything past the point where cancelling is possible and always returns the
 * stock, so this offers a button and the server decides — the storefront is
 * never the thing that judges what is too late to stop.
 */
export function useCancelGuestOrder() {
  return useMutation({
    mutationFn: (claim) => checkoutApi.cancelAsGuest(claim),
  })
}
