import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileRef } from '../graph/model.ts'
import { SaveError, saveDocument } from './api.ts'
import {
  edit as editDraft,
  reloaded as reloadSession,
  requestRevert as revertRequest,
  requestSave as saveRequest,
  settleFailure,
  settleSuccess,
  startSession,
  type Session,
  type Snapshot,
} from './editSession.ts'

type Events = {
  onSaved?: (purpose: 'save' | 'revert') => void
  onFailed?: (error: SaveError, purpose: 'save' | 'revert') => void
}

/**
 * Drives the pure session with real requests. Each request carries its token and the session identity
 * it belongs to, so a late response can only ever settle the request that started it.
 */
export function useEditSession(ref: FileRef, initial: Snapshot, events: Events = {}) {
  const [session, setSession] = useState(() => startSession(initial))
  const dispatched = useRef(0)
  const eventsRef = useRef(events)
  useEffect(() => { eventsRef.current = events })
  // StrictMode mounts, unmounts and remounts: liveness must be re-established on every mount.
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  useEffect(() => {
    const request = session.inFlight
    if (!request || request.token === dispatched.current) return
    dispatched.current = request.token
    void saveDocument(ref, request.content, request.expectedHash).then(
      hash => {
        if (!alive.current) return
        setSession(current => settleSuccess(current, request.token, hash))
        eventsRef.current.onSaved?.(request.purpose)
      },
      error => {
        if (!alive.current) return
        const failure = error instanceof SaveError ? error : new SaveError('failed', 'The save failed unexpectedly.')
        setSession(current => settleFailure(current, request.token, { kind: failure.kind, message: failure.message }))
        eventsRef.current.onFailed?.(failure, request.purpose)
      },
    )
  }, [ref, session.inFlight])

  const edit = useCallback((draft: string) => setSession(current => editDraft(current, draft)), [])
  const save = useCallback(() => setSession(current => saveRequest(current)), [])
  const revert = useCallback(() => setSession(current => revertRequest(current)), [])
  const reload = useCallback((document: Snapshot) => setSession(current => reloadSession(current, document)), [])
  return { session, edit, save, revert, reload }
}

export type EditSession = ReturnType<typeof useEditSession>
export type { Session }
