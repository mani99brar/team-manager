import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { fileToPathname, type FileRef } from '../graph/model.ts'
import { Markdown } from './Markdown.tsx'
import type { DocumentState } from './useDocument.ts'

type Tab = 'rendered' | 'source'
const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'rendered', label: 'Rendered' },
  { id: 'source', label: 'Source' },
]

type Props = {
  fileRef: FileRef
  state: DocumentState
  onBack: () => void
  onRetry: () => void
}


function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** Read-only document shell: identity header, Back to folder, Rendered/Source tabs and the load states. */
export function DocumentView({ fileRef, state, onBack, onRetry }: Props) {
  const key = fileToPathname(fileRef)
  const name = baseName(fileRef.path)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [tab, setTab] = useState<Tab>('rendered')
  const [tabKey, setTabKey] = useState(key)
  // Opening a different document always starts on Rendered.
  if (tabKey !== key) {
    setTabKey(key)
    setTab('rendered')
  }

  // Focus moves to the document entry point when a document is opened (not when switching tabs).
  useEffect(() => { headingRef.current?.focus() }, [key])

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
  } else {
    // Keep the memoized Markdown subtree mounted across tab switches: large files should not be
    // parsed again just to return from Source. Only the selected tab is visible/accessibility-exposed.
    panel = (
      <>
        <div hidden={tab !== 'rendered'}>
          {state.document.content === ''
            ? <p className="document-message">This file is empty.</p>
            : <Markdown content={state.document.content} />}
        </div>
        {tab === 'source' && <>
          {state.document.content === '' && <p className="document-message">This file is empty.</p>}
          <pre className="document-source" data-testid="document-source" tabIndex={0}>{state.document.content}</pre>
        </>}
      </>
    )
  }

  return (
    <section
      className="document"
      data-testid="document-view"
      data-hash={state.status === 'ready' ? state.document.hash : undefined}
      aria-labelledby="document-title"
      aria-busy={state.status === 'loading'}
    >
      <header className="document-header">
        <div className="document-identity">
          <h2 id="document-title" ref={headingRef} tabIndex={-1}>{name}</h2>
          <p className="document-meta" data-testid="document-meta">
            <span className="document-source-name">{fileRef.source}</span>
            <span className="document-separator" aria-hidden="true">·</span>
            <span className="document-path">{fileRef.path}</span>
          </p>
        </div>
        <button type="button" className="button" onClick={onBack}>Back to folder</button>
      </header>
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
    </section>
  )
}
