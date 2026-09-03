import { useState } from 'react'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Spinner } from '@/components/ui/Spinner'
import { useToast } from '@/components/ui/toast.context'
import { useAuth } from '@/features/auth/useAuth'
import { isApiError, messageOf } from '@/lib/api/errors'
import { ProofCard } from './ProofCard'
import { RejectProofDialog } from './RejectProofDialog'
import {
  useApproveProof,
  useOrderPaymentProofs,
  useRejectProof,
} from '../hooks/payments.hooks'
import type { PaymentProof } from '../types/payments.types'

export interface OrderProofsCardProps {
  orderId: string
  /** Only bank-transfer orders can have receipts; anything else renders nothing. */
  paymentMethod: string
}

/**
 * The receipts sent for one order, on the order's own page.
 *
 * The queue on the Payments page is where this work normally happens. This card
 * exists for the other direction: somebody looking at an unpaid order and
 * asking *why* it is unpaid. Without it the answer — "a receipt arrived and
 * nobody has looked at it" — lives on a screen they are not on.
 *
 * It renders nothing at all for orders paid another way, rather than an empty
 * "no receipts" card. A card that is always blank on a COD order is a card that
 * teaches people to stop reading that part of the page.
 */
export function OrderProofsCard({ orderId, paymentMethod }: OrderProofsCardProps) {
  const { can } = useAuth()
  const { toast } = useToast()
  const [rejecting, setRejecting] = useState<PaymentProof | null>(null)
  const [approving, setApproving] = useState<PaymentProof | null>(null)

  const query = useOrderPaymentProofs(paymentMethod === 'bank_transfer' ? orderId : undefined)
  const approve = useApproveProof()
  const reject = useRejectProof()

  if (paymentMethod !== 'bank_transfer' || !can('payments:read')) return null

  const proofs = query.data ?? []

  return (
    <>
      <Card>
        <CardHeader
          title="Payment receipts"
          description="What the customer sent us to show they paid."
          actions={query.isPending ? <Spinner size="sm" label="Loading" /> : undefined}
        />
        <CardBody className="flex flex-col gap-3">
          {query.isPending ? null : proofs.length === 0 ? (
            <p className="text-muted text-sm">
              Nothing sent yet. The customer has the bank details and a page to upload their
              receipt.
            </p>
          ) : (
            proofs.map((proof) => (
              <ProofCard
                key={proof.id}
                proof={proof}
                canDecide={can('payments:capture')}
                isBusy={approve.isPending || reject.isPending}
                onApprove={setApproving}
                onReject={setRejecting}
              />
            ))
          )}
        </CardBody>
      </Card>

      <ConfirmDialog
        isOpen={approving !== null}
        title="Record this payment?"
        confirmLabel={approve.isPending ? 'Recording…' : 'Yes, record it'}
        isLoading={approve.isPending}
        onCancel={() => setApproving(null)}
        onConfirm={() => {
          if (!approving) return
          approve.mutate(approving.id, {
            onSuccess: () => {
              setApproving(null)
              toast({
                tone: 'success',
                title: 'Payment recorded',
                description: 'The order is paid and confirmed.',
              })
            },
            onError: (error) => {
              setApproving(null)
              toast({
                tone:
                  isApiError(error) && error.code === 'CONCURRENT_MODIFICATION'
                    ? 'warning'
                    : 'error',
                title: 'Could not approve that receipt',
                description: messageOf(error),
              })
            },
          })
        }}
      >
        This order will be marked paid for its full outstanding balance and confirmed, ready to
        fulfil. Check the receipt against your bank statement first — this cannot be undone from
        here.
      </ConfirmDialog>

      <RejectProofDialog
        proof={rejecting}
        isSaving={reject.isPending}
        onCancel={() => setRejecting(null)}
        onConfirm={(note) => {
          if (!rejecting) return
          reject.mutate(
            { id: rejecting.id, note },
            {
              onSuccess: () => {
                setRejecting(null)
                toast({
                  tone: 'info',
                  title: 'Receipt rejected',
                  description: 'The order stays unpaid.',
                })
              },
              onError: (error) => {
                setRejecting(null)
                toast({
                  tone: 'error',
                  title: 'Could not reject that receipt',
                  description: messageOf(error),
                })
              },
            },
          )
        }}
      />
    </>
  )
}
