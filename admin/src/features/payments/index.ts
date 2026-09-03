/**
 * Public surface of the `payments` feature.
 *
 * The order page imports the proof card and the hook; nothing else reaches
 * inside.
 */
export { PaymentsPage } from './pages/PaymentsPage'
export { ProofCard } from './components/ProofCard'
export { OrderProofsCard } from './components/OrderProofsCard'
export { RejectProofDialog } from './components/RejectProofDialog'
export {
  useApproveProof,
  useOrderPaymentProofs,
  usePaymentProofs,
  usePendingProofCount,
  usePayments,
  useRejectProof,
  paymentKeys,
} from './hooks/payments.hooks'
export { methodLabels, statusLabels, statusTones } from './components/paymentLabels'
export type { PaymentProof, PaymentRow, PaymentMethod, PaymentStatus } from './types/payments.types'
