/**
 * Public surface of the `returns` feature (§2.2).
 *
 * Returns sit above orders and inventory — they read both and are read by
 * neither. A return is goods coming back; a refund is money going out, and the
 * two stay separate all the way down.
 */
export { returnsService } from './returns.service.js'
export { returnsRepository } from './returns.repository.js'
export type {
  ReturnCondition,
  ReturnDetail,
  ReturnLineItem,
  ReturnListFilter,
  ReturnReason,
  ReturnRequest,
  ReturnStatus,
} from './returns.types.js'
export { RETURN_CONDITIONS, RETURN_REASONS, RETURN_STATUSES } from './returns.types.js'
