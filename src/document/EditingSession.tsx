import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileRef } from '../graph/model.ts'
import { fetchDocument } from './api.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { Editor } from './Editor.tsx'
import { hasUnacknowledgedWork, isPending, type Snapshot } from './editSession.ts'
import type { TextAnalysis } from './serialize.ts'
import { useEditSession } from './useEditSession.ts'

/** What the rest of the app needs to know to guard navigation and refuse operations on the active file. */
export type EditingState = { dirty: boolean; pending: boolean; conflicted: boolean }

type Props = {
  fileRef: FileRef
  document: Snapshot
  analysis: TextAnalysis
  onAnnounce: (message: string) => void
  onStateChange: (state: EditingState | null) => void
  /** The last acknowledged content/hash (initial read, each successful save or revert, each reload). */
  onAcknowledged: (acknowledged: Snapshot) => void
  /** Runs `leave` now, or after the user confirms discarding a dirty draft; refuses while a save is pending. */
  guardLeave: (leave: () => void) => void
  /** Leaves editing mode; `acknowledged` is what the read-only view should now show. */
  onExit: (acknowledged: Snapshot) => void
}

type Confirmation = 'reload' | 'revert' | null

function fileName(ref: FileRef): string {
  return ref.path.slice(ref.path.lastIndexOf('/') + 1)
}

export function EditingSession({ fileRef, document, analysis, onAnnounce, onStateChange, onAcknowledged, guardLeave, onExit }: Props) {
  const name = fileName(fileRef)
  const { session, edit, save, revert, reload } = useEditSession(fileRef, document, {
    onSaved: purpose => onAnnounce(purpose === 'revert' ? `Reverted ${name} to the version from when editing began.` : `Saved ${name}.`),
    onFailed: (error, purpose) => onAnnounce(error.kind === 'conflict'
      ? `${purpose === 'revert' ? 'Revert' : 'Save'} conflicted: ${name} changed on disk.`
      : `${purpose === 'revert' ? 'Revert' : 'Save'} failed for ${name}.`),
  })

  const dirty = hasUnacknowledgedWork(session)
  const pending = isPending(session)
  const conflicted = session.conflicted
  useEffect(() => { onStateChange({ dirty, pending, conflicted }) }, [dirty, pending, conflicted, onStateChange])
  useEffect(() => () => onStateChange(null), [onStateChange])
  useEffect(() => { onAcknowledged(session.acknowledged) }, [session.acknowledged, onAcknowledged])

  const sessionRef = useRef(session)
  useEffect(() => { sessionRef.current = session })

  const [confirmation, setConfirmation] = useState<Confirmation>(null)
  const [reloading, setReloading] = useState(false)
  const [fallback, setFallback] = useState<string | null>(null)

  const performReload = useCallback(async () => {
    setReloading(true)
    onAnnounce(`Reloading ${name} from disk.`)
    try {
      const fresh = await fetchDocument(fileRef)
      reload({ content: fresh.content, hash: fresh.hash })
      setConfirmation(null)
      onAnnounce(`Reloaded ${name} from disk. Editing starts again from this version.`)
    } catch {
      setConfirmation(null)
      onAnnounce(`Reloading ${name} failed. The draft and the conflict are unchanged.`)
    } finally { setReloading(false) }
  }, [fileRef, name, onAnnounce, reload])

  const copyDraft = useCallback(async () => {
    const draft = sessionRef.current.draft
    try {
      await navigator.clipboard.writeText(draft)
      setFallback(null)
      onAnnounce('Draft copied to the clipboard.')
    } catch {
      setFallback(draft)
      onAnnounce('The clipboard is unavailable. The draft is shown as selectable text.')
    }
  }, [onAnnounce])

  const exitEditing = useCallback(() => {
    guardLeave(() => onExit(sessionRef.current.acknowledged))
  }, [guardLeave, onExit])

  const recovery = fallback !== null ? (
    <div className="editor-fallback">
      <p id="draft-fallback-help">The clipboard is unavailable. Select the text below and copy it yourself.</p>
      <textarea aria-label="Draft text" aria-describedby="draft-fallback-help" readOnly value={fallback} rows={6} onFocus={event => event.currentTarget.select()} />
      <p className="document-actions"><button type="button" className="button" onClick={() => setFallback(null)}>Hide draft text</button></p>
    </div>
  ) : null

  return (
    <>
      <Editor
        fileRef={fileRef}
        session={session}
        analysis={analysis}
        onEdit={edit}
        onSave={save}
        onRevert={() => setConfirmation('revert')}
        onReload={() => setConfirmation('reload')}
        onCopyDraft={() => { void copyDraft() }}
        onExit={exitEditing}
        recovery={recovery}
      />
      {confirmation === 'reload' && (
        <ConfirmDialog title="Reload from disk?" confirmLabel="Reload" destructive pending={reloading} onConfirm={() => { void performReload() }} onCancel={() => setConfirmation(null)}>
          <p>Reloading {name} will discard your current draft and replace it with the version now on disk. Copy the draft first if you want to keep it.</p>
        </ConfirmDialog>
      )}
      {confirmation === 'revert' && (
        <ConfirmDialog title="Revert to the version from when editing began?" confirmLabel="Revert" destructive onConfirm={() => { setConfirmation(null); revert() }} onCancel={() => setConfirmation(null)}>
          <p>This will discard your current draft changes and save the content {name} had when you pressed Edit, replacing every save made since. It is checked against the last acknowledged version and can report a conflict.</p>
        </ConfirmDialog>
      )}
    </>
  )
}
