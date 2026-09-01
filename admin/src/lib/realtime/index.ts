export {
  CLIENT_EVENTS,
  REALTIME_EVENTS,
  type AdminOrderPlacedPayload,
  type AdminPaymentPayload,
  type AdminStockPayload,
  type ConnectedPayload,
  type NotificationCreatedPayload,
  type RealtimeEvent,
} from './events'
export { RealtimeProvider } from './RealtimeProvider'
export { getConnectionState, getSocket, type ConnectionState } from './socket'
export { useConnectionState, useRealtimeEvent } from './useRealtimeEvent'
