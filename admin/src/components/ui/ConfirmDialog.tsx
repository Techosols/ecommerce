import type { ReactNode } from 'react'
import { Button } from './Button'
import { Modal } from './Modal'

export interface ConfirmDialogProps {
  isOpen: boolean
  onCancel: () => void
  onConfirm: () => void
  title: ReactNode
  /** Say what will happen, in the operator's terms. Not "Are you sure?". */
  children: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** `danger` for anything that loses data, refunds money or cancels an order. */
  tone?: 'primary' | 'danger'
  isLoading?: boolean
}

export function ConfirmDialog({
  isOpen,
  onCancel,
  onConfirm,
  title,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'primary',
  isLoading = false,
}: ConfirmDialogProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={isLoading ? () => undefined : onCancel}
      title={title}
      size="sm"
      dismissible={!isLoading}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={isLoading}>
            {cancelLabel}
          </Button>
          <Button variant={tone} onClick={onConfirm} isLoading={isLoading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-ink-soft text-sm">{children}</div>
    </Modal>
  )
}
