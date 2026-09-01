import { api } from '@/lib/api'

/**
 * The store's public identity: its name, its currency, its logo.
 *
 * A deliberately whitelisted subset — the admin settings serializer is never
 * reused for this, which is how a tax rate or an internal note would otherwise
 * end up on a public page.
 */
export const settingsApi = {
  get: () => api.get('/storefront/settings'),
}
