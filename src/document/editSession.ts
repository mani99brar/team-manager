/**
 * Pure explicit-save state machine for one editing session of one document. No React, no network.
 *
 * - `baseline` is captured once when Edit begins and never changes until a Reload.
 * - `acknowledged` is the last content/hash the server confirmed (read or successful write).
 * - `draft` is what the editor holds now. Keystrokes only change `draft`.
 * - At most one request is `inFlight`; explicit saves while one is pending fill a single `queued` slot.
 * - A failure or conflict empties the queue; a conflict blocks Save and Revert until `reloaded`.
 */
export type Snapshot = { content: string; hash: string }
export type SaveErrorKind = 'failed' | 'conflict' | 'too-large' | 'missing'
export type SaveError = { kind: SaveErrorKind; message: string }
export type Request = { token: number; content: string; expectedHash: string; purpose: 'save' | 'revert' }
export type Session = {
  readonly baseline: Snapshot
  readonly acknowledged: Snapshot
  readonly draft: string
  readonly inFlight: Request | null
  readonly queued: { content: string } | null
  readonly error: SaveError | null
  readonly conflicted: boolean
  readonly nextToken: number
  /** Increments whenever the draft is replaced from outside the editor (Revert success, Reload). */
  readonly generation: number
}
export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'error'

export function startSession(document: Snapshot): Session {
  const snapshot = { content: document.content, hash: document.hash }
  return { baseline: snapshot, acknowledged: snapshot, draft: document.content, inFlight: null, queued: null, error: null, conflicted: false, nextToken: 1, generation: 0 }
}

export function edit(session: Session, draft: string): Session {
  return draft === session.draft ? session : { ...session, draft }
}

function send(session: Session, content: string, purpose: Request['purpose']): Session {
  const request: Request = { token: session.nextToken, content, expectedHash: session.acknowledged.hash, purpose }
  return { ...session, inFlight: request, queued: null, error: null, nextToken: session.nextToken + 1 }
}

/** Explicit Save (button, shortcut or Retry). Never sends concurrently; never sends an unchanged draft. */
export function requestSave(session: Session): Session {
  if (session.conflicted) return session
  if (session.inFlight) {
    if (session.draft === session.inFlight.content) return session.queued ? { ...session, queued: null } : session
    return { ...session, queued: { content: session.draft } }
  }
  if (session.draft === session.acknowledged.content) return session.error ? { ...session, error: null } : session
  return send(session, session.draft, 'save')
}

/** Revert restores the Edit baseline on disk through the same hash-checked pipeline. */
export function requestRevert(session: Session): Session {
  if (!canRevert(session)) return session
  return send(session, session.baseline.content, 'revert')
}

export function settleSuccess(session: Session, token: number, hash: string): Session {
  const request = session.inFlight
  if (!request || request.token !== token) return session
  const acknowledged = { content: request.content, hash }
  const reverted = request.purpose === 'revert'
  const draft = reverted ? request.content : session.draft
  const settled: Session = { ...session, acknowledged, draft, inFlight: null, error: null, conflicted: false, generation: session.generation + (reverted ? 1 : 0) }
  if (session.queued && session.queued.content !== acknowledged.content) return send(settled, session.queued.content, 'save')
  return { ...settled, queued: null }
}

export function settleFailure(session: Session, token: number, error: SaveError): Session {
  const request = session.inFlight
  if (!request || request.token !== token) return session
  return { ...session, inFlight: null, queued: null, error, conflicted: error.kind === 'conflict' }
}

/** A successful fresh read replaces baseline, acknowledged content and draft, and clears any conflict. */
export function reloaded(session: Session, document: Snapshot): Session {
  if (session.inFlight) return session
  return { ...startSession(document), nextToken: session.nextToken, generation: session.generation + 1 }
}

export function status(session: Session): SaveStatus {
  if (session.inFlight) return 'saving'
  if (session.error) return 'error'
  return session.draft === session.acknowledged.content ? 'saved' : 'unsaved'
}

export function canSave(session: Session): boolean {
  return !session.conflicted
}

export function canRevert(session: Session): boolean {
  if (session.conflicted || session.inFlight || session.queued) return false
  return session.draft !== session.baseline.content || session.acknowledged.content !== session.baseline.content
}

/** Unsaved changes or a save that has not been acknowledged: what navigation guards and beforeunload care about. */
export function hasUnacknowledgedWork(session: Session): boolean {
  return session.inFlight !== null || session.queued !== null || session.draft !== session.acknowledged.content
}

export function isPending(session: Session): boolean {
  return session.inFlight !== null || session.queued !== null
}
