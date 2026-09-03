import { api } from '@/lib/api/client'
import type {
  CarrierCapabilities,
  CodRemittance,
  CodRemittanceDetail,
  ImportRemittanceInput,
  TrackingEvent,
} from '../types/carrier.types'

/**
 * The courier endpoints, as the server publishes them.
 *
 * Note what is absent: there is no "settle everything" call, because the server
 * offers none. Each settlement is a separate request that confirms an order and
 * commits its stock, and the screen loops rather than the server accepting a
 * list — so every one is a decision the server checked.
 */
export const carrierApi = {
  /** What the connected courier can do. Drives which controls exist. */
  capabilities: () => api.get<CarrierCapabilities>('/admin/shipping/carrier'),

  /** The scan trail for one parcel, newest first. */
  tracking: (shipmentId: string) =>
    api.get<TrackingEvent[]>(`/admin/shipping/shipments/${shipmentId}/tracking`),

  remittances: (params: { page: number; limit: number }) =>
    api.list<CodRemittance>('/admin/shipping/cod/remittances', {
      query: { page: params.page, limit: params.limit },
    }),

  remittance: (id: string) =>
    api.get<CodRemittanceDetail>(`/admin/shipping/cod/remittances/${id}`),

  importRemittance: (body: ImportRemittanceInput) =>
    api.post<CodRemittance>('/admin/shipping/cod/remittances', body),

  settleLine: (lineId: string) =>
    api.post<{ id: string; amount: { amount: number; currency: string } }>(
      `/admin/shipping/cod/lines/${lineId}/settle`,
    ),
}
