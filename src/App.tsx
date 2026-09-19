import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { Breadcrumbs } from './graph/Breadcrumbs.tsx'
import { GraphCanvas, type GraphCanvasHandle, type ViewRequest } from './graph/GraphCanvas.tsx'
import { GraphLayout } from './graph/layout.ts'
import { Outline } from './graph/Outline.tsx'
import {
  buildIndex,
  childCounts,
  collapseNode,
  descendantIds,
  describeCounts,
  folderExists,
  folderToPathname,
  parsePathname,
  pruneIds,
  refId,
  revealFolder,
  sameRef,
  visibleGraph,
  type Entry,
  type FolderRef,
  type GraphNode,
  type ParsedLocation,
  type TreeIndex,
} from './graph/model.ts'

type Data =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; index: TreeIndex; refreshing: boolean; refreshError: string | null }

type Mode = 'graph' | 'outline'

async function fetchEntries(signal?: AbortSignal): Promise<Entry[]> {
  const response = await fetch('/api/entries', { signal })
  let body: unknown = null
  try { body = await response.json() } catch { /* not JSON */ }
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : null
  if (!response.ok) {
    throw new Error(typeof record?.error === 'string' ? record.error : `The API responded with status ${response.status}.`)
  }
  if (!record || !Array.isArray(record.entries)) throw new Error('The API returned an unexpected response.')
  return record.entries as Entry[]
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message && error.name !== 'TypeError'
    ? error.message
    : 'The API could not be reached. Check that it is running.'
}

function summary(index: TreeIndex): string {
  let directories = 0
  let files = 0
  for (const node of index.nodes.values()) {
    if (node.kind === 'directory') directories += 1
    else if (node.kind === 'file') files += 1
  }
  return `${directories} ${directories === 1 ? 'folder' : 'folders'} and ${files} ${files === 1 ? 'Markdown file' : 'Markdown files'}`
}

const reducedMotionQuery = '(prefers-reduced-motion: reduce)'

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia(reducedMotionQuery).matches)
  useEffect(() => {
    const query = window.matchMedia(reducedMotionQuery)
    const update = () => setReduced(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return reduced
}

function App() {
  const reducedMotion = usePrefersReducedMotion()
  const [layout] = useState(() => new GraphLayout({ synchronous: reducedMotion }))
  useEffect(() => { layout.setSynchronous(reducedMotion) }, [layout, reducedMotion])
  useEffect(() => () => layout.dispose(), [layout])

  const [data, setData] = useState<Data>({ status: 'loading' })
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [location, setLocation] = useState<ParsedLocation>(() => parsePathname(window.location.pathname))
  const [mode, setMode] = useState<Mode>('graph')
  const [announcement, setAnnouncement] = useState('')
  const [viewRequest, setViewRequest] = useState<ViewRequest | null>(null)
  const canvasRef = useRef<GraphCanvasHandle>(null)
  const requestToken = useRef(0)
  // Mirrors of state for event handlers that must not re-subscribe on every change.
  const locationRef = useRef(location)
  const indexRef = useRef<TreeIndex | null>(null)
  useEffect(() => { locationRef.current = location }, [location])
  useEffect(() => { indexRef.current = data.status === 'ready' ? data.index : null }, [data])

  const requestView = useCallback((request: { type: 'fit' } | { type: 'reveal'; id: string }) => {
    requestToken.current += 1
    setViewRequest({ ...request, token: requestToken.current })
  }, [])

  const loadEntries = useCallback(async (signal?: AbortSignal) => {
    try {
      const entries = await fetchEntries(signal)
      if (signal?.aborted) return
      const index = buildIndex(entries)
      const current = locationRef.current
      if (current.kind === 'folder') {
        setExpanded(previous => revealFolder(index, previous, current.ref))
        requestView({ type: 'reveal', id: refId(current.ref) })
      }
      setData({ status: 'ready', index, refreshing: false, refreshError: null })
      setAnnouncement(`Loaded ${summary(index)}.`)
    } catch (error) {
      if (signal?.aborted) return
      setData({ status: 'error', message: errorMessage(error) })
      setAnnouncement('Loading failed.')
    }
  }, [requestView])

  useEffect(() => {
    const controller = new AbortController()
    void loadEntries(controller.signal)
    return () => controller.abort()
  }, [loadEntries])

  const retry = useCallback(() => {
    setData({ status: 'loading' })
    setAnnouncement('Loading the Pi and Claude fixture folders.')
    void loadEntries()
  }, [loadEntries])

  const refresh = useCallback(async () => {
    if (data.status !== 'ready' || data.refreshing) return
    setData({ ...data, refreshing: true })
    setAnnouncement('Refreshing the listing.')
    try {
      const entries = await fetchEntries()
      const index = buildIndex(entries)
      setExpanded(previous => pruneIds(index, previous))
      layout.prune(new Set(index.nodes.keys()))
      setData({ status: 'ready', index, refreshing: false, refreshError: null })
      const current = locationRef.current
      const missing = current.kind === 'folder' && !folderExists(index, current.ref)
      setAnnouncement(missing ? 'Refreshed. The selected folder no longer exists.' : `Refreshed: ${summary(index)}.`)
    } catch (error) {
      const message = errorMessage(error)
      setData(previous => (previous.status === 'ready' ? { ...previous, refreshing: false, refreshError: message } : previous))
      setAnnouncement('Refresh failed. Showing the previous listing, which may be outdated.')
    }
  }, [data, layout])

  const navigate = useCallback((ref: FolderRef | null, options: { replace?: boolean; reveal?: boolean } = {}) => {
    const pathname = folderToPathname(ref)
    if (window.location.pathname !== pathname) {
      window.history[options.replace ? 'replaceState' : 'pushState'](null, '', pathname)
    }
    setLocation(ref ? { kind: 'folder', ref } : { kind: 'home' })
    const index = indexRef.current
    if (ref && options.reveal && index) {
      setExpanded(previous => revealFolder(index, previous, ref))
      requestView({ type: 'reveal', id: refId(ref) })
    } else if (!ref) {
      requestView({ type: 'fit' })
    }
  }, [requestView])

  useEffect(() => {
    const onPopState = () => {
      const next = parsePathname(window.location.pathname)
      setLocation(next)
      const index = indexRef.current
      if (next.kind === 'folder' && index) {
        setExpanded(previous => revealFolder(index, previous, next.ref))
        requestView({ type: 'reveal', id: refId(next.ref) })
      }
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [requestView])

  const index = data.status === 'ready' ? data.index : null
  const selectedRef = location.kind === 'folder' ? location.ref : null
  const selectedExists = index !== null && selectedRef !== null && folderExists(index, selectedRef)
  const selectedId = selectedExists && selectedRef ? refId(selectedRef) : null
  const visible = useMemo(() => (index ? visibleGraph(index, expanded) : { nodes: [], edges: [] }), [index, expanded])

  const select = useCallback((node: GraphNode) => {
    const ref = { source: node.source, path: node.path }
    if (sameRef(locationRef.current.kind === 'folder' ? locationRef.current.ref : null, ref)) return
    navigate(ref)
  }, [navigate])

  const toggleExpand = useCallback((node: GraphNode) => {
    if (!index) return
    if (expanded.has(node.id)) {
      setExpanded(collapseNode(index, expanded, node.id))
      const current = locationRef.current
      if (current.kind === 'folder' && descendantIds(index, node.id).includes(refId(current.ref))) {
        navigate({ source: node.source, path: node.path }, { replace: true })
      }
      setAnnouncement(`Collapsed ${node.name}.`)
    } else {
      setExpanded(new Set(expanded).add(node.id))
      setAnnouncement(`Expanded ${node.name}: ${describeCounts(childCounts(index, node.id))}`)
    }
  }, [index, expanded, navigate])

  const togglePin = useCallback((node: GraphNode) => {
    const wasPinned = layout.isPinned(node.id)
    layout.togglePin(node.id)
    setAnnouncement(`${wasPinned ? 'Unpinned' : 'Pinned'} ${node.name}.`)
  }, [layout])

  const reset = useCallback(() => {
    layout.reset()
    setExpanded(new Set())
    navigate(null)
    setAnnouncement('Reset: showing the Pi and Claude sources.')
  }, [layout, navigate])

  const toggleMode = useCallback(() => {
    setMode(previous => {
      const next = previous === 'graph' ? 'outline' : 'graph'
      setAnnouncement(next === 'outline' ? 'Outline view.' : 'Graph view.')
      return next
    })
  }, [])

  const ready = data.status === 'ready'
  const refreshing = data.status === 'ready' && data.refreshing
  const graphControlsEnabled = ready && mode === 'graph'

  let missingNotice: React.ReactNode = null
  if (index && location.kind === 'unknown-source') {
    missingNotice = <>Source “{location.name}” does not exist. Only the Pi and Claude sources are available.</>
  } else if (index && location.kind === 'malformed') {
    missingNotice = <>This link could not be read.</>
  } else if (index && selectedRef && !selectedExists) {
    missingNotice = <>Folder “{selectedRef.path || selectedRef.source}” was not found in {selectedRef.source}. It may have been renamed or removed.</>
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title">
          <h1>MD Manager</h1>
          <p>Pi and Claude fixture folders as a containment graph. Read-only.</p>
        </div>
        <button type="button" className="button" onClick={() => void refresh()} disabled={!ready || refreshing} aria-busy={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      <div className="visually-hidden" role="status" aria-live="polite">{announcement}</div>

      {data.status === 'ready' && data.refreshError && (
        <div className="banner banner-error" role="alert">
          Refresh failed: {data.refreshError} The graph still shows the previous listing, which may be outdated. Try Refresh again once the API and fixture folders are available.
        </div>
      )}

      <div className="navigation">
        <Breadcrumbs selected={selectedRef} onNavigate={ref => navigate(ref, { reveal: true })} />
        {missingNotice ? (
          <div className="missing" role="alert">
            <p>{missingNotice}</p>
            <p className="missing-links">
              {selectedRef && location.kind === 'folder'
                ? <a href={folderToPathname({ source: selectedRef.source, path: '' })} onClick={event => { event.preventDefault(); navigate({ source: selectedRef.source, path: '' }, { reveal: true }) }}>Go to the {selectedRef.source} root</a>
                : <>
                    <a href="/Pi" onClick={event => { event.preventDefault(); navigate({ source: 'Pi', path: '' }, { reveal: true }) }}>Go to the Pi root</a>
                    <a href="/Claude" onClick={event => { event.preventDefault(); navigate({ source: 'Claude', path: '' }, { reveal: true }) }}>Go to the Claude root</a>
                  </>}
              <a href="/" onClick={event => { event.preventDefault(); navigate(null) }}>Home</a>
            </p>
          </div>
        ) : (
          <p className="folder-info" data-testid="folder-info">
            {index && selectedId
              ? describeCounts(childCounts(index, selectedId))
              : 'Two sources: Pi and Claude. Select a source or folder to see what it contains.'}
          </p>
        )}
      </div>

      <div className="toolbar" role="toolbar" aria-label="Graph controls">
        <button type="button" className="button" onClick={() => canvasRef.current?.zoomIn()} disabled={!graphControlsEnabled} aria-label="Zoom in">+</button>
        <button type="button" className="button" onClick={() => canvasRef.current?.zoomOut()} disabled={!graphControlsEnabled} aria-label="Zoom out">−</button>
        <button type="button" className="button" onClick={() => canvasRef.current?.fit()} disabled={!graphControlsEnabled}>Fit</button>
        <button type="button" className="button" onClick={reset} disabled={!ready}>Reset</button>
        <button type="button" className="button" onClick={toggleMode} disabled={!ready} aria-pressed={mode === 'outline'}>Outline</button>
      </div>

      <main className="workspace" aria-busy={data.status === 'loading'}>
        {data.status === 'loading' && (
          <div className="placeholder">
            <p>Loading the Pi and Claude fixture folders…</p>
          </div>
        )}
        {data.status === 'error' && (
          <div className="placeholder" role="alert">
            <p>Unable to load the fixture folders. {data.message}</p>
            <p>Check that the API is running and both fixture folders are readable, then retry.</p>
            <button type="button" className="button" onClick={retry}>Retry</button>
          </div>
        )}
        {data.status === 'ready' && mode === 'graph' && (
          <GraphCanvas
            ref={canvasRef}
            layout={layout}
            index={data.index}
            nodes={visible.nodes}
            edges={visible.edges}
            expanded={expanded}
            selectedId={selectedId}
            viewRequest={viewRequest}
            onSelect={select}
            onToggleExpand={toggleExpand}
            onTogglePin={togglePin}
          />
        )}
        {data.status === 'ready' && mode === 'outline' && (
          <Outline index={data.index} expanded={expanded} selectedId={selectedId} onSelect={select} onToggleExpand={toggleExpand} />
        )}
      </main>

      {mode === 'graph' && (
        <footer className="legend" aria-label="Legend">
          <ul>
            <li><svg viewBox="-16 -16 32 32" aria-hidden="true"><circle className="legend-source" r="11" /></svg>Source</li>
            <li><svg viewBox="-16 -16 32 32" aria-hidden="true"><path className="legend-directory" d="M -12 -9 h 7 l 3 3 h 14 v 15 h -24 z" /></svg>Folder</li>
            <li><svg viewBox="-16 -16 32 32" aria-hidden="true"><path className="legend-file" d="M -7 -11 h 9 l 5 5 v 17 h -14 z" /></svg>Markdown file</li>
            <li><svg viewBox="-16 -16 32 32" aria-hidden="true"><line className="legend-edge" x1="-13" y1="0" x2="8" y2="0" markerEnd="url(#contains-arrow)" /><path className="legend-edge-arrow" d="M 7 -4 L 13 0 L 7 4 z" /></svg>Contains (parent → child)</li>
            <li><svg viewBox="-16 -16 32 32" aria-hidden="true"><circle className="legend-pin" r="9" /><path className="legend-pin-glyph" d="M -3 -4 h 6 l -1 4 h -4 z M 0 0 v 6" /></svg>Pinned (dragged or P)</li>
          </ul>
          <p>Keyboard: Tab moves through nodes in outline order, Enter selects, → expands, ← collapses, P pins or unpins.</p>
        </footer>
      )}
    </div>
  )
}

export default App
