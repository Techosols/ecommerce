import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api/client'

export interface PublicStoreSettings {
  storeName: string
  contactEmail: string | null
  supportUrl: string | null
  currency: string
  timezone: string
  weightUnit: string
  guestCheckoutEnabled: boolean
  logoUrl: string | null
  codEnabled: boolean
}

export const storeKeys = { settings: ['store', 'settings'] as const }

/**
 * The store's public settings.
 *
 * Read from `/storefront/settings` rather than `/admin/settings` on purpose:
 * the admin route is behind `settings:read`, which a catalogue editor need not
 * hold, and the only thing the product forms want from it — the store's single
 * currency — is already public. Asking for the admin surface here would make a
 * price field fail for exactly the people who use it most.
 */
export function useStoreSettings() {
  return useQuery({
    queryKey: storeKeys.settings,
    queryFn: () => api.get<PublicStoreSettings>('/storefront/settings'),
    // Changes about once in the life of a shop.
    staleTime: 30 * 60_000,
  })
}

/**
 * The currency prices are entered in.
 *
 * Falls back to the store's own value the moment it loads. Until then the
 * money inputs render with a neutral prefix rather than guessing a currency —
 * a price field that says the wrong symbol is worse than one that says none.
 */
export function useStoreCurrency(): string {
  return useStoreSettings().data?.currency ?? ''
}
