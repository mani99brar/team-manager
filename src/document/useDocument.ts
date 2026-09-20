import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileRef } from '../graph/model.ts'
import { DocumentError, fetchDocument, type DocumentErrorKind, type FileDocument } from './api.ts'

export type DocumentState =
  | { status: 'loading'; ref: FileRef }
  | { status: 'ready'; ref: FileRef; document: FileDocument }
  | { status: 'error'; ref: FileRef; kind: DocumentErrorKind; message: string }

type Settled = Exclude<DocumentState, { status: 'loading' }> & { attempt: number }

type Events = {
  onLoading?: (ref: FileRef) => void
  onLoaded?: (document: FileDocument) => void
  onFailed?: (ref: FileRef, kind: DocumentErrorKind) => void
}

/**
 * Each opening supplies a new stable `ref` object, even when its URL is unchanged.
 * Every request is tied to the ref (and attempt) that started it and cancelled when the ref changes or clears, so a slow response (success or error) can never
 * be shown under another document's identity or reopen a document after navigating away.
 */
export function useDocument(ref: FileRef | null, events: Events = {}): { state: DocumentState | null; retry: () => void } {
  const [settled, setSettled] = useState<Settled | null>(null)
  const [attempt, setAttempt] = useState(0)
  const eventsRef = useRef(events)
  useEffect(() => { eventsRef.current = events })

  useEffect(() => {
    if (!ref) return
    const controller = new AbortController()
    const target = ref
    eventsRef.current.onLoading?.(target)
    void (async () => {
      try {
        const document = await fetchDocument(target, controller.signal)
        if (controller.signal.aborted) return
        setSettled({ status: 'ready', ref: target, document, attempt })
        eventsRef.current.onLoaded?.(document)
      } catch (error) {
        if (controller.signal.aborted) return
        const kind = error instanceof DocumentError ? error.kind : 'failed'
        const message = error instanceof DocumentError ? error.message : 'The file could not be loaded.'
        setSettled({ status: 'error', ref: target, kind, message, attempt })
        eventsRef.current.onFailed?.(target, kind)
      }
    })()
    return () => controller.abort()
  }, [ref, attempt])

  const retry = useCallback(() => setAttempt(previous => previous + 1), [])

  // A settled result is only ever shown for the exact request it answered; anything else is loading.
  if (!ref) return { state: null, retry }
  const state: DocumentState = settled && settled.ref === ref && settled.attempt === attempt ? settled : { status: 'loading', ref }
  return { state, retry }
}
