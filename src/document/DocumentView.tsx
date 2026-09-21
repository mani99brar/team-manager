import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { fileToPathname, type FileRef, type Location } from '../graph/model.ts'
import { EditingSession, type EditingState } from './EditingSession.tsx'
import type { Snapshot } from './editSession.ts'
import { Markdown } from './Markdown.tsx'
import { analyzeText, contentHash, type TextAnalysis } from './serialize.ts'
import type { DocumentState } from './useDocument.ts'

type Tab = 'rendered' | 'source'
const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'rendered', label: 'Rendered' },
  { id: 'source', label: 'Source' },
]

type Props = {
  fileRef: FileRef
  /** The configured location the file belongs to, once the listing knows it; null while loading or unknown. */
  location: Location | null
  state: DocumentState
  onBack: () => void
  onRetry: () => void
  onAnnounce: (message: string) => void
  onEditingChange: (state: EditingState | null) => void
  /** Current editing state, for copy labelling and disabling while a save is pending. */
  editingState: EditingState | null
  onOperation: (op: 'rename' | 'move' | 'delete' | 'copy') => void
  guardLeave: (leave: () => void) => void
}

/** Whether the loaded text can be edited and written back byte for byte. */
type Editability =
  | { status: 'checking' }
  | { status: 'editable'; analysis: TextAnalysis }
  | { status: 'unavailable'; reason: string }

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** Document shell: identity header, Back to folder, Rendered/Source tabs, load states, and the editing session. */
export function DocumentView({ fileRef, location, state, editingState, onBack, onRetry, onAnnounce, onEditingChange, onOperation, guardLeave }: Props) {
  const key = fileToPathname(fileRef)
  const name = baseName(fileRef.path)
  const otherSource = fileRef.source === 'Pi' ? 'Claude' : 'Pi'
  const headingRef = useRef<HTMLHeadingElement>(null)
  const editButtonRef = useRef<HTMLButtonElement>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [tab, setTab] = useState<Tab>('rendered')
  const [editing, setEditing] = useState(false)
  // After editing, the read-only view shows the last acknowledged content, not the original fetch.
  const [override, setOverride] = useState<{ ref: FileRef; document: Snapshot } | null>(null)
  const [tabKey, setTabKey] = useState(key)
  // Opening a different document always starts on Rendered, read-only.
  if (tabKey !== key) {
    setTabKey(key)
    setTab('rendered')
    setEditing(false)
    setOverride(null)
  }

  const loaded = state.status === 'ready' ? state.document : null
  const shown: Snapshot | null = loaded ? (override && override.ref === state.ref ? override.document : loaded) : null

  // Focus moves to the document entry point when a document is opened (not when switching tabs).
  useEffect(() => { headingRef.current?.focus() }, [key])

  // Editability: same line ending throughout, and the UTF-8 re-encoding must hash to the bytes the server read.
  // The hash check is asynchronous; until it settles for this exact document, editing is unavailable.
  const [hashCheck, setHashCheck] = useState<{ document: Snapshot; matches: boolean } | null>(null)
  useEffect(() => {
    if (!shown) return
    let cancelled = false
    void contentHash(shown.content).then(hash => { if (!cancelled) setHashCheck({ document: shown, matches: hash === shown.hash }) })
    return () => { cancelled = true }
  }, [shown])
  let editability: Editability = { status: 'checking' }
  if (shown && hashCheck?.document === shown) {
    const analysis = analyzeText(shown.content)
    if (!analysis.editable) editability = { status: 'unavailable', reason: analysis.reason }
    else if (!hashCheck.matches) editability = { status: 'unavailable', reason: 'it is not valid UTF-8, so its bytes cannot be reproduced' }
    else editability = { status: 'editable', analysis }
  }

  const acknowledged = useCallback((snapshot: Snapshot) => {
    setOverride(previous => (previous && previous.ref === state.ref && previous.document === snapshot ? previous : { ref: state.ref, document: snapshot }))
  }, [state.ref])
  const exitEditing = useCallback((acknowledged: Snapshot) => {
    setOverride({ ref: state.ref, document: acknowledged })
    setEditing(false)
    setTab('rendered')
    onAnnounce(`Finished editing ${name}.`)
    requestAnimationFrame(() => editButtonRef.current?.focus())
  }, [name, onAnnounce, state.ref])

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.findIndex(candidate => candidate.id === tab)
    let next: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % TABS.length
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + TABS.length) % TABS.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = TABS.length - 1
    if (next === null) return
    event.preventDefault()
    setTab(TABS[next].id)
    tabRefs.current[next]?.focus()
  }

  let panel: React.ReactNode
  if (state.status === 'loading') {
    panel = <p className="document-message">Loading {name}…</p>
  } else if (state.status === 'error') {
    const explanation = state.kind === 'missing'
      ? `${name} was not found in ${fileRef.source} or is unavailable. It may have been renamed or removed.`
      : state.kind === 'invalid'
        ? `The link to ${name} is invalid.`
        : `${name} could not be loaded. ${state.message}`
    panel = (
      <div className="document-message document-error" role="alert">
        <p>{explanation}</p>
        <p className="document-actions">
          {state.kind === 'failed' && <button type="button" className="button" onClick={onRetry}>Retry</button>}
          <span>Use Back to folder to return to browsing.</span>
        </p>
      </div>
    )
  } else if (shown) {
    // Keep the memoized Markdown subtree mounted across tab switches: large files should not be
    // parsed again just to return from Source. Only the selected tab is visible/accessibility-exposed.
    panel = (
      <>
        <div hidden={tab !== 'rendered'}>
          {shown.content === ''
            ? <p className="document-message">This file is empty.</p>
            : <Markdown content={shown.content} />}
        </div>
        {tab === 'source' && <>
          {shown.content === '' && <p className="document-message">This file is empty.</p>}
          <pre className="document-source" data-testid="document-source" tabIndex={0}>{shown.content}</pre>
        </>}
      </>
    )
  }

  const canEdit = shown !== null && editability.status === 'editable'
  const body = editing && shown
    ? (
      <div className="document-editing">
        <EditingSession
          key={key}
          fileRef={fileRef}
          document={shown}
          analysis={editability.status === 'editable' ? editability.analysis : analyzeText(shown.content)}
          onAnnounce={onAnnounce}
          onStateChange={onEditingChange}
          onAcknowledged={acknowledged}
          guardLeave={guardLeave}
          onExit={exitEditing}
        />
      </div>
    )
    : (
      <>
        <div className="tabs" role="tablist" aria-label="Document view">
          {TABS.map((candidate, index) => (
            <button
              key={candidate.id}
              ref={element => { tabRefs.current[index] = element }}
              type="button"
              role="tab"
              id={`tab-${candidate.id}`}
              className="tab"
              aria-selected={tab === candidate.id}
              aria-controls="document-panel"
              tabIndex={tab === candidate.id ? 0 : -1}
              onClick={() => setTab(candidate.id)}
              onKeyDown={onTabKeyDown}
            >
              {candidate.label}
            </button>
          ))}
        </div>
        <div className="document-panel" role="tabpanel" id="document-panel" aria-labelledby={`tab-${tab}`}>
          {panel}
        </div>
      </>
    )
  return (
    <section
      className="document"
      data-testid="document-view"
      data-hash={shown?.hash}
      aria-labelledby="document-title"
      aria-busy={state.status === 'loading'}
    >
      <header className="document-header">
        <div className="document-identity">
          <h2 id="document-title" ref={headingRef} tabIndex={-1}>{name}</h2>
          <p className="document-meta" data-testid="document-meta">
            <span className="document-source-name">{fileRef.source}</span>
            <span className="document-separator" aria-hidden="true">·</span>
            <span className="document-location" data-testid="document-location">{location?.label ?? fileRef.locationId}</span>
            <span className="document-separator" aria-hidden="true">·</span>
            <span className="document-path">{fileRef.path}</span>
          </p>
        </div>
        <div className="document-header-actions">
          {shown && (
            <>
              <button type="button" className="button" onClick={() => onOperation('rename')}>Rename…</button>
              <button type="button" className="button" onClick={() => onOperation('move')}>Move…</button>
              <button type="button" className="button" onClick={() => onOperation('delete')}>Delete…</button>
              <button type="button" className="button" onClick={() => onOperation('copy')} disabled={editingState?.pending === true} title={editingState?.pending ? 'Wait for the save to finish.' : undefined}>
                {editingState?.dirty ? `Copy saved content to ${otherSource}…` : `Copy to ${otherSource}…`}
              </button>
            </>
          )}
          {shown && !editing && (
            <button
              ref={editButtonRef}
              type="button"
              className="button"
              onClick={() => setEditing(true)}
              disabled={!canEdit}
              aria-describedby={editability.status === 'unavailable' ? 'edit-unavailable' : undefined}
            >
              Edit
            </button>
          )}
          <button type="button" className="button" onClick={onBack}>Back to folder</button>
        </div>
      </header>
      {location && (location.category === 'package' || location.category === 'plugin') && (
        <p className="document-notice document-installed" data-testid="installed-notice">
          This file is part of an installed {location.category} ({location.label}). Saving changes the installed copy directly, and a package update or sync may overwrite it.
        </p>
      )}
      {shown && !editing && editability.status === 'unavailable' && (
        <p className="document-notice" id="edit-unavailable" data-testid="edit-unavailable">
          This file is read-only here because {editability.reason}. Editing it in this app could not keep the file byte for byte.
        </p>
      )}
      {body}
    </section>
  )
}
