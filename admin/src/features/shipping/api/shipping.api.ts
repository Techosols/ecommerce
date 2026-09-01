import { api } from '@/lib/api/client'
import type {
  CreateMethodInput,
  CreateZoneInput,
  MethodInput,
  RateQuote,
  ShippingMethod,
  ShippingZone,
  UpdateZoneInput,
} from '../types/shipping.types'

/**
 * The rate card, as `shipping.admin.routes.ts` publishes it.
 *
 * `quote` is the odd one out: it is the *public* storefront endpoint, called
 * here so an operator can see what a shopper would actually be offered rather
 * than reading the rate card and doing the arithmetic themselves. Calling the
 * real endpoint is the point — a preview computed in the browser would be a
 * second implementation of the pricing rules, and the first time the two
 * disagreed the preview would be the one people believed.
 */
export const shippingApi = {
  zones: (options: { includeArchived?: boolean } = {}) =>
    api.get<ShippingZone[]>('/admin/shipping/zones', {
      query: { includeArchived: options.includeArchived ? 'true' : undefined },
    }),

  createZone: (body: CreateZoneInput) => api.post<ShippingZone>('/admin/shipping/zones', body),

  updateZone: (id: string, body: UpdateZoneInput) =>
    api.patch<ShippingZone>(`/admin/shipping/zones/${id}`, body),

  /** Archives. The methods stay: orders cite them. */
  archiveZone: (id: string) => api.delete<void>(`/admin/shipping/zones/${id}`),

  restoreZone: (id: string) => api.post<ShippingZone>(`/admin/shipping/zones/${id}/restore`),

  methods: (zoneId?: string) =>
    api.get<ShippingMethod[]>('/admin/shipping/methods', {
      query: { zoneId },
    }),

  createMethod: (body: CreateMethodInput) =>
    api.post<ShippingMethod>('/admin/shipping/methods', body),

  updateMethod: (id: string, body: Partial<MethodInput>) =>
    api.patch<ShippingMethod>(`/admin/shipping/methods/${id}`, body),

  archiveMethod: (id: string) => api.delete<void>(`/admin/shipping/methods/${id}`),

  quote: (params: { countryCode: string; subtotalCents: number; weightGrams: number }) =>
    api.get<RateQuote[]>('/storefront/shipping/rates', {
      query: {
        countryCode: params.countryCode,
        subtotalCents: params.subtotalCents,
        weightGrams: params.weightGrams,
      },
    }),
}
