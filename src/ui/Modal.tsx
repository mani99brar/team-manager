import { useLayoutEffect, useRef, type ReactNode } from 'react'

type Props = {
  title: string
  children: ReactNode
  /** Which element receives focus when the dialog opens; the opener is refocused on close. */
  initialFocus?: 'first-field' | 'cancel' | 'confirm'
  onCancel: () => void
}

/**
 * Native modal dialog: Escape cancels, the browser traps focus, and closing returns focus to the element that
 * opened it. It is rendered only while open, so mounting shows it and unmounting closes it. The layout-effect
 * cleanup runs before React detaches the element, which is what lets the opener be refocused.
 */
export function Modal({ title, children, initialFocus = 'confirm', onCancel }: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  const latest = useRef(onCancel)
  useLayoutEffect(() => { latest.current = onCancel })
  useLayoutEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!dialog.open) dialog.showModal()
    const selector = initialFocus === 'first-field'
      ? 'input, select, textarea'
      : initialFocus === 'cancel' ? '[data-dialog-cancel]' : '[data-dialog-confirm]'
    dialog.querySelector<HTMLElement>(selector)?.focus()
    const onNativeCancel = (event: Event) => { event.preventDefault(); latest.current() }
    dialog.addEventListener('cancel', onNativeCancel)
    return () => {
      dialog.removeEventListener('cancel', onNativeCancel)
      if (dialog.open) dialog.close()
      opener?.focus()
    }
  }, [initialFocus])
  return (
    <dialog ref={ref} className="confirm-dialog" aria-labelledby="dialog-title">
      <h2 id="dialog-title">{title}</h2>
      {children}
    </dialog>
  )
}
