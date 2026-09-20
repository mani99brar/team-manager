import type { ReactNode } from 'react'
import { Modal } from '../ui/Modal.tsx'

type Props = {
  title: string
  children: ReactNode
  confirmLabel: string
  cancelLabel?: string
  /** Destructive confirmations start with focus on Cancel. */
  destructive?: boolean
  pending?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({ title, children, confirmLabel, cancelLabel = 'Cancel', destructive = false, pending = false, onConfirm, onCancel }: Props) {
  return (
    <Modal title={title} initialFocus={destructive ? 'cancel' : 'confirm'} pending={pending} onCancel={onCancel}>
      <form method="dialog" onSubmit={event => { event.preventDefault(); if (!pending) onConfirm() }}>
        <div className="confirm-description">{children}</div>
        <div className="confirm-actions">
          <button type="button" className="button" data-dialog-cancel onClick={onCancel} disabled={pending}>{cancelLabel}</button>
          <button type="submit" className={destructive ? 'button button-danger' : 'button'} data-dialog-confirm disabled={pending} aria-busy={pending}>{confirmLabel}</button>
        </div>
      </form>
    </Modal>
  )
}
