/** Public surface of the `payments` feature (§2.2). */
export { paymentsService } from './payments.service.js'
export type { Payment, PaymentMethod, PaymentState, Refund } from './payments.service.js'
export {
  PAYMENT_METHODS,
  availableMethods,
  getPaymentMethod,
  settlesOnDelivery,
} from './methods.js'
export type {
  Eligibility,
  MethodContext,
  PaymentMethodDefinition,
  PaymentMethodKey,
  SettlementModel,
} from './methods.js'
export { proofsService } from './proofs.service.js'
export { proofsRepository } from './proofs.repository.js'
export type { PaymentProof, PaymentProofStatus } from './proofs.types.js'
