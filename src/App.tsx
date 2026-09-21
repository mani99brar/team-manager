import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { Breadcrumbs } from './graph/Breadcrumbs.tsx'
import { DocumentView } from './document/DocumentView.tsx'
import { ConfirmDialog } from './document/ConfirmDialog.tsx'
import type { EditingState } from './document/EditingSession.tsx'
import type { MutationResponse } from './operations/api.ts'
import { OperationDialog, type Operation } from './operations/OperationDialog.tsx'
import { useDocument } from './document/useDocument.ts'
import { GraphCanvas, type GraphCanvasHandle, type View, type ViewRequest } from './graph/GraphCanvas.tsx'
import { GraphLayout, type LayoutSnapshot } from './graph/layout.ts'
import { Outline } from './graph/Outline.tsx'
import {
  buildIndex,
  childCounts,
  collapseNode,
  descendantIds,
  describeCounts,
  fileToPathname,
  folderExists,
  folderToPathname,
  locationLabel,
  locationOf,
  nodeId,
  parentFolderOf,
  parsePathname,
  pruneIds,
  refId,
  revealFolder,
  sameRef,
  visibleGraph,
  type FileRef,
  type FolderRef,
  type GraphNode,
  type Listing,
  type Location,
  type ParsedLocation,
  type Source,
  type TreeIndex,
} from './graph/model.ts'

type Data =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; index: TreeIndex; refreshing: boolean; refreshError: string | null }

type Mode = 'graph' | 'outline'

/** Where the user was browsing when a document was opened, so Back to folder can restore it exactly. */
type ReturnContext = {
  pathname: string; location: ParsedLocation; focusId: string | null
  mode: Mode; expanded: string[]; layout: LayoutSnapshot; view: View | null; scroll: number
}
type HistoryEntry = { pathname: string; browsing?: ReturnContext; origin?: ReturnContext }

function fileName(ref: FileRef): string {
  return ref.path.slice(ref.path.lastIndexOf('/') + 1)
}

async function fetchEntries(signal?: AbortSignal): Promise<Listing> {
  const response = await fetch('/api/entries', { signal })
  let body: unknown = null
  try { body = await response.json() } catch { /* not JSON */ }
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : null
  if (!response.ok) {
    throw new Error(typeof record?.error === 'string' ? record.error : `The API responded with status ${response.status}.`)
  }
  if (!record || !Array.isArray(record.entries) || !Array.isArray(record.locations)) throw new Error('The API returned an unexpected response.')
  return { locations: record.locations as Listing['locations'], entries: record.entries as Listing['entries'] }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message && error.name !== 'TypeError'
    ? error.message
    : 'The API could not be reached. Check that it is running.'
}

function summary(index: TreeIndex): string {
  let directories = 0
  let files = 0
  let unavailable = 0
  for (const node of index.nodes.values()) {
    if (node.kind === 'directory') directories += 1
    else if (node.kind === 'file') files += 1
    else if (node.kind === 'location' && node.location?.status === 'unavailable') unavailable += 1
  }
  const locations = index.locations.size
  const text = `${directories} ${directories === 1 ? 'folder' : 'folders'} and ${files} ${files === 1 ? 'Markdown file' : 'Markdown files'} across ${locations} ${locations === 1 ? 'location' : 'locations'}`
  return unavailable ? `${text}, ${unavailable} unavailable` : text
}

/** Links to configured locations of one source, for legacy-link and unconfigured-location explanations. */
function LocationLinks({ locations, onNavigate }: { locations: Location[]; onNavigate: (ref: FolderRef) => void }) {
  return (
    <>
      {locations.map(location => {
        const ref: FolderRef = { source: location.source, locationId: location.id, path: '' }
        return (
          <a key={location.id} href={folderToPathname(ref)} onClick={event => { event.preventDefault(); onNavigate(ref) }}>
            {location.label}{location.status === 'unavailable' ? ' (unavailable)' : ''}
          </a>
        )
      })}
    </>
  )
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
  const [browsingRevision, setBrowsingRevision] = useState(0)
  const [announcement, setAnnouncement] = useState('')
  const [operation, setOperation] = useState<{ request: Operation; context: number } | null>(null)
  const [discardAction, setDiscardAction] = useState<{ run: () => void } | null>(null)
  const [viewRequest, setViewRequest] = useState<ViewRequest | null>(null)
  const canvasRef = useRef<GraphCanvasHandle>(null)
  const requestToken = useRef(0)
  const handledRequest = useRef(0)
  // Graph pan/zoom and outline scroll live here so they survive the workspace being replaced by a document.
  const viewStore = useRef<View | null>(null)
  const outlineScroll = useRef(0)
  // History carries only opaque keys; snapshots live in this page session, never across reloads.
  const [initialHistoryKey] = useState(() => crypto.randomUUID())
  const historyKey = useRef(initialHistoryKey)
  // Monotonic navigation context: leaving and returning to the same history entry still abandons async navigation.
  const navigationRevision = useRef(0)
  const historyEntries = useRef(new Map<string, HistoryEntry>())
  useLayoutEffect(() => {
    historyEntries.current.set(initialHistoryKey, { pathname: window.location.pathname })
    window.history.replaceState({ mdManager: initialHistoryKey }, '', window.location.pathname)
  }, [initialHistoryKey])
  const writeHistory = useCallback((entry: Omit<HistoryEntry, 'pathname'>, pathname: string, replace = false) => {
    navigationRevision.current += 1
    const key = replace ? historyKey.current : crypto.randomUUID()
    historyEntries.current.set(key, { ...entry, pathname })
    historyKey.current = key
    window.history[replace ? 'replaceState' : 'pushState']({ mdManager: key }, '', pathname)
  }, [])
  const pendingFocus = useRef<string | null>(null)
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
      const listing = await fetchEntries(signal)
      if (signal?.aborted) return
      const index = buildIndex(listing)
      const current = locationRef.current
      if (current.kind === 'folder') {
        setExpanded(previous => revealFolder(index, previous, current.ref))
        requestView({ type: 'reveal', id: refId(current.ref) })
      }
      setData({ status: 'ready', index, refreshing: false, refreshError: null })
      // While a document is open its own load/failure announcements take precedence.
      if (current.kind !== 'file') setAnnouncement(`Loaded ${summary(index)}.`)
    } catch (error) {
      if (signal?.aborted) return
      setData({ status: 'error', message: errorMessage(error) })
      if (locationRef.current.kind !== 'file') setAnnouncement('Loading failed.')
    }
  }, [requestView])

  useEffect(() => {
    const controller = new AbortController()
    void loadEntries(controller.signal)
    return () => controller.abort()
  }, [loadEntries])

  const retry = useCallback(() => {
    setData({ status: 'loading' })
    setAnnouncement('Loading the configured Pi and Claude locations.')
    void loadEntries()
  }, [loadEntries])

  /**
   * Refetches the listing while keeping selection, expansion and pins. Resolves with the new index or null on
   * failure. Only the listing changes: an open document and its draft are never touched by a refresh.
   */
  const reloadListing = useCallback(async (): Promise<TreeIndex | null> => {
    setData(previous => (previous.status === 'ready' ? { ...previous, refreshing: true } : previous))
    try {
      const listing = await fetchEntries()
      const index = buildIndex(listing)
      setExpanded(previous => pruneIds(index, previous))
      layout.prune(new Set(index.nodes.keys()))
      indexRef.current = index
      setData({ status: 'ready', index, refreshing: false, refreshError: null })
      return index
    } catch (error) {
      const message = errorMessage(error)
      setData(previous => (previous.status === 'ready' ? { ...previous, refreshing: false, refreshError: message } : previous))
      return null
    }
  }, [layout])

  const refresh = useCallback(async () => {
    if (data.status !== 'ready' || data.refreshing) return
    setAnnouncement('Refreshing the listing.')
    const index = await reloadListing()
    if (!index) {
      setAnnouncement('Refresh failed. Showing the previous listing, which may be outdated.')
      return
    }
    const current = locationRef.current
    const missing = current.kind === 'folder' && !folderExists(index, current.ref)
    setAnnouncement(missing ? 'Refreshed. The selected folder no longer exists.' : `Refreshed: ${summary(index)}.`)
  }, [data, reloadListing])

  const captureBrowsing = useCallback((focusId: string | null = null): ReturnContext => ({
    pathname: historyEntries.current.get(historyKey.current)!.pathname, location: locationRef.current, focusId,
    mode, expanded: [...expanded], layout: layout.snapshot(),
    view: viewStore.current ? { ...viewStore.current } : null, scroll: outlineScroll.current,
  }), [mode, expanded, layout])
  const saveBrowsing = useCallback((focusId: string | null = null) => {
    if (locationRef.current.kind === 'file') return
    const entry = historyEntries.current.get(historyKey.current)!
    const snapshot = captureBrowsing(focusId ?? document.activeElement?.closest('[data-node-id]')?.getAttribute('data-node-id') ?? entry.browsing?.focusId ?? null)
    historyEntries.current.set(historyKey.current, { ...entry, browsing: snapshot })
    return snapshot
  }, [captureBrowsing])
  const restoreBrowsing = useCallback((context: ReturnContext) => {
    setBrowsingRevision(previous => previous + 1)
    layout.restore(context.layout)
    viewStore.current = context.view ? { ...context.view } : null
    outlineScroll.current = context.scroll
    setViewRequest(null)
    setMode(context.mode)
    setExpanded(new Set(context.expanded))
    setLocation(context.location)
    pendingFocus.current = context.focusId
  }, [layout])
  // popstate changes the URL first; the retained entry key still identifies the departing snapshot.
  const saveBrowsingRef = useRef(saveBrowsing)
  useLayoutEffect(() => { saveBrowsingRef.current = saveBrowsing }, [saveBrowsing])

  const navigate = useCallback((ref: FolderRef | null, options: { replace?: boolean; reveal?: boolean } = {}) => {
    const pathname = folderToPathname(ref)
    if (window.location.pathname !== pathname) {
      saveBrowsing()
      writeHistory({}, pathname, options.replace)
    }
    setLocation(ref ? { kind: 'folder', ref } : { kind: 'home' })
    const index = indexRef.current
    if (ref && options.reveal && index) {
      setExpanded(previous => revealFolder(index, previous, ref))
      requestView({ type: 'reveal', id: refId(ref) })
    } else if (!ref) {
      requestView({ type: 'fit' })
    }
  }, [requestView, saveBrowsing, writeHistory])

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      navigationRevision.current += 1
      setOperation(null)
      setDiscardAction(null)
      saveBrowsingRef.current()
      const entry = historyEntries.current.get(event.state?.mdManager)
      if (entry) historyKey.current = event.state.mdManager
      else {
        historyKey.current = crypto.randomUUID()
        writeHistory({}, window.location.pathname, true)
      }
      const context = entry?.browsing
      if (context) {
        restoreBrowsing(context)
        return
      }
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
  }, [requestView, restoreBrowsing, writeHistory])

  const index = data.status === 'ready' ? data.index : null

  // ---- Documents ----
  // A file in a location the listing does not know is explained as an unconfigured location, never fetched as a guess.
  const unknownFileLocation = index !== null && location.kind === 'file' && locationOf(index, location.ref) === undefined
  const fileRef = location.kind === 'file' && !unknownFileLocation ? location.ref : null
  const fileLocation: Location | null = fileRef && index ? locationOf(index, fileRef) ?? null : null
  const { state: documentState, retry: retryDocument } = useDocument(fileRef, {
    onLoading: ref => setAnnouncement(`Loading ${fileName(ref)}.`),
    onLoaded: document => setAnnouncement(`Loaded ${fileName(document)}.`),
    onFailed: (ref, kind) => setAnnouncement(kind === 'missing' ? `${fileName(ref)} was not found.` : `Loading ${fileName(ref)} failed.`),
  })
  // Editing state of the open document, for navigation guards and file-operation eligibility.
  const [editingState, setEditingState] = useState<EditingState | null>(null)
  const editingRef = useRef<EditingState | null>(null)
  useEffect(() => { editingRef.current = editingState }, [editingState])
  const announce = useCallback((message: string) => setAnnouncement(message), [])
  const [pendingNotice, setPendingNotice] = useState(false)
  // The notice is derived: it only shows while the refused action's save is still pending.
  const showPendingNotice = pendingNotice && editingState?.pending === true
  /**
   * App-controlled actions that would abandon the editing session: refused while a save is pending,
   * confirmed while the draft is dirty, otherwise run immediately. Browser history is never intercepted.
   */
  const guardLeave = useCallback((leave: () => void) => {
    const editing = editingRef.current
    if (editing?.pending) {
      setPendingNotice(true)
      setAnnouncement('A save is in progress. Wait for it to finish before leaving this file.')
      return
    }
    if (editing?.dirty) {
      setDiscardAction({ run: leave })
      return
    }
    leave()
  }, [])
  const openFile = useCallback((node: GraphNode) => {
    if (node.kind !== 'file' || node.locationId === null) return
    const ref: FileRef = { source: node.source, locationId: node.locationId, path: node.path }
    const pathname = fileToPathname(ref)
    const origin = saveBrowsingRef.current(node.id)
    pendingFocus.current = null
    writeHistory({ origin }, pathname)
    setLocation({ kind: 'file', ref })
  }, [writeHistory])

  const leaveFile = useCallback(() => {
    const current = locationRef.current
    if (current.kind !== 'file') return
    const context = historyEntries.current.get(historyKey.current)?.origin
    if (context) {
      // Restore the exact browsing entry: no fit, no re-expansion, no layout reset.
      writeHistory({ browsing: context }, context.pathname)
      restoreBrowsing(context)
    } else {
      // Direct link or reload: open the containing folder and reveal its ancestors.
      pendingFocus.current = nodeId(current.ref.source, current.ref.locationId, current.ref.path)
      navigate(parentFolderOf(current.ref), { reveal: true })
    }
  }, [navigate, restoreBrowsing, writeHistory])
  const backToFolder = useCallback(() => guardLeave(leaveFile), [guardLeave, leaveFile])
  const navigateFromBreadcrumb = useCallback((ref: FolderRef | null) => guardLeave(() => navigate(ref, { reveal: true })), [guardLeave, navigate])

  // Focus the originating file action once the browsing view has rendered it again.
  const focusPending = useCallback(() => {
    const id = pendingFocus.current
    if (!id || locationRef.current.kind === 'file') return
    const selector = `[data-node-id="${CSS.escape(id)}"]`
    const target = document.querySelector<HTMLElement | SVGElement>(`${selector} .node-body, ${selector} .outline-name`)
    if (target) {
      // Do not let keyboard-focus reveal or native scrolling alter a restored viewport/outline scroll.
      target.setAttribute('data-restoring-focus', 'true')
      target.focus({ preventScroll: true })
      target.removeAttribute('data-restoring-focus')
      pendingFocus.current = null
    }
  }, [])
  useEffect(() => { focusPending() })
  // Graph nodes without remembered positions (a direct link's Back to folder) only exist after the layout has
  // placed them, which happens after this component's effects: retry once that render has committed.
  useEffect(() => layout.subscribe(() => { if (pendingFocus.current) setTimeout(focusPending, 0) }), [layout, focusPending])

  // ---- File and folder operations ----
  const [operationNotice, setOperationNotice] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<{ message: string; refreshFailed: boolean } | null>(null)
  const requestFolderOperation = useCallback((op: 'create-file' | 'create-folder' | 'rename' | 'move' | 'delete') => {
    const current = locationRef.current
    const ref: FolderRef | null = current.kind === 'folder' ? current.ref : null
    if (!ref) return
    setOperationNotice(null)
    if (op === 'create-file' || op === 'create-folder') setOperation({ request: { op, parent: ref }, context: navigationRevision.current })
    else if (ref.locationId !== null && ref.path) {
      // Sources and locations are navigation boundaries, never filesystem targets.
      setOperation({ request: { op, target: { kind: 'folder', ref: { source: ref.source, locationId: ref.locationId, path: ref.path } } }, context: navigationRevision.current })
    }
  }, [])
  const requestFileOperation = useCallback((op: 'rename' | 'move' | 'delete' | 'copy') => {
    const current = locationRef.current
    if (current.kind !== 'file') return
    const editing = editingRef.current
    const name = fileName(current.ref)
    if (op !== 'copy' && editing && (editing.dirty || editing.pending || editing.conflicted)) {
      const reason = editing.pending ? 'a save is still pending' : editing.conflicted ? 'its draft conflicts with the file on disk' : 'it has unsaved changes'
      setOperationNotice(`${name} cannot be ${op === 'delete' ? 'deleted' : `${op}d`} while ${reason}. Save or discard the draft first; nothing is saved or discarded for you.`)
      setAnnouncement(`${name} has unsaved changes. Save or discard them first.`)
      return
    }
    if (op === 'copy' && editing?.pending) return
    setOperationNotice(null)
    const target = { kind: 'file' as const, ref: current.ref, draftDirty: editing?.dirty === true }
    setOperation({ request: op === 'copy' ? { op, target } : { op, target }, context: navigationRevision.current })
  }, [])
  const openCreatedFile = useCallback((ref: FileRef) => {
    const origin = saveBrowsingRef.current(null)
    pendingFocus.current = null
    writeHistory({ origin }, fileToPathname(ref))
    setLocation({ kind: 'file', ref })
  }, [writeHistory])
  const completeOperation = useCallback(async (done: Operation, response: MutationResponse, context: number) => {
    setOperation(current => current?.request === done ? null : current)
    // A successful request still refreshes the listing and reports its outcome after departure,
    // but can only navigate in its originating context, never over newer edits or pending saves.
    const follow = (action: () => void) => {
      const editing = editingRef.current
      if (navigationRevision.current !== context || editing?.dirty || editing?.pending || editing?.conflicted) return
      guardLeave(action)
    }
    const { source, locationId } = response
    const name = fileName({ source, locationId, path: response.path })
    const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')))
    const where = (whichSource: Source, whichLocation: string, path: string) => {
      const label = locationLabel(indexRef.current, { source: whichSource, locationId: whichLocation })
      return path ? `${whichSource} / ${label} / ${path}` : `${whichSource} / ${label}`
    }
    let message: string
    // Identity changes of the open document are applied first so the document view never shows a stale path.
    if ((done.op === 'rename' || done.op === 'move') && done.target.kind === 'file' && response.destinationPath) {
      const ref: FileRef = { source, locationId, path: response.destinationPath }
      follow(() => {
        const entry = historyEntries.current.get(historyKey.current)
        writeHistory({ origin: entry?.origin }, fileToPathname(ref), true)
        setLocation({ kind: 'file', ref })
      })
    }
    const index = await reloadListing()
    switch (done.op) {
      case 'create-file': {
        message = `Created ${name} in ${where(source, locationId, parentOf(response.path))}.`
        follow(() => openCreatedFile({ source, locationId, path: response.path }))
        break
      }
      case 'create-folder': {
        message = `Created folder ${name} in ${where(source, locationId, parentOf(response.path))}.`
        if (index) follow(() => navigate({ source, locationId, path: response.path }, { reveal: true }))
        break
      }
      case 'rename':
      case 'move': {
        message = `${done.op === 'rename' ? 'Renamed' : 'Moved'} ${name} to ${where(source, locationId, response.destinationPath ?? response.path)}.`
        if (done.target.kind === 'folder' && response.destinationPath) {
          const path = response.destinationPath
          follow(() => navigate({ source, locationId, path }, { replace: true, reveal: true }))
        }
        break
      }
      case 'delete': {
        message = `Deleted ${name} from ${where(source, locationId, parentOf(response.path))}.`
        const parent: FolderRef = { source, locationId, path: parentOf(response.path) }
        follow(() => {
          pendingFocus.current = refId(parent)
          navigate(parent, { reveal: true })
        })
        break
      }
      case 'copy':
        message = `Copied ${name} to ${where(response.destinationSource ?? source, response.destinationLocationId ?? locationId, response.destinationPath ?? '')}.`
        break
    }
    setOutcome({ message, refreshFailed: index === null })
    setAnnouncement(index === null ? `${message} The listing could not be refreshed.` : message)
  }, [guardLeave, navigate, openCreatedFile, reloadListing, writeHistory])

  const selectedRef = location.kind === 'folder' ? location.ref : null
  const selectedExists = index !== null && selectedRef !== null && folderExists(index, selectedRef)
  const selectedId = selectedExists && selectedRef ? refId(selectedRef) : null
  const selectedNode = index && selectedId ? index.nodes.get(selectedId) ?? null : null
  const selectedLocation: Location | null = index && selectedRef?.locationId ? locationOf(index, { source: selectedRef.source, locationId: selectedRef.locationId }) ?? null : null
  const visible = useMemo(() => (index ? visibleGraph(index, expanded) : { nodes: [], edges: [] }), [index, expanded])

  const select = useCallback((node: GraphNode) => {
    const ref: FolderRef = { source: node.source, locationId: node.locationId, path: node.path }
    if (sameRef(locationRef.current.kind === 'folder' ? locationRef.current.ref : null, ref)) return
    navigate(ref)
  }, [navigate])

  const toggleExpand = useCallback((node: GraphNode) => {
    if (!index) return
    if (expanded.has(node.id)) {
      setExpanded(collapseNode(index, expanded, node.id))
      const current = locationRef.current
      if (current.kind === 'folder' && descendantIds(index, node.id).includes(refId(current.ref))) {
        navigate({ source: node.source, locationId: node.locationId, path: node.path }, { replace: true })
      }
      setAnnouncement(`Collapsed ${node.name}.`)
    } else {
      setExpanded(new Set(expanded).add(node.id))
      const unavailable = node.kind === 'location' && node.location?.status === 'unavailable'
      setAnnouncement(unavailable
        ? `Expanded ${node.name}: unavailable. ${node.location?.error ?? ''}`.trim()
        : `Expanded ${node.name}: ${describeCounts(childCounts(index, node.id), node.kind)}`)
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
  const browsing = fileRef === null
  // Creation needs a real destination: a source (choose a location in the dialog), an available location or a folder.
  const canCreate = selectedExists && selectedLocation?.status !== 'unavailable'
  const isDirectory = selectedNode?.kind === 'directory'

  const locationsOf = (source: Source) => (index ? [...index.locations.values()].filter(location => location.source === source) : [])
  const revealLocation = (ref: FolderRef) => navigate(ref, { reveal: true })
  const sourceLinks = (source: Source | null) => (
    <>
      {source
        ? <a href={folderToPathname({ source, locationId: null, path: '' })} onClick={event => { event.preventDefault(); navigate({ source, locationId: null, path: '' }, { reveal: true }) }}>Go to the {source} root</a>
        : <>
            <a href="/browse/Pi" onClick={event => { event.preventDefault(); navigate({ source: 'Pi', locationId: null, path: '' }, { reveal: true }) }}>Go to the Pi root</a>
            <a href="/browse/Claude" onClick={event => { event.preventDefault(); navigate({ source: 'Claude', locationId: null, path: '' }, { reveal: true }) }}>Go to the Claude root</a>
          </>}
      <a href="/" onClick={event => { event.preventDefault(); navigate(null) }}>Home</a>
    </>
  )

  let missingNotice: React.ReactNode = null
  let missingLinks: React.ReactNode = null
  const unknownRefLocation = index && (location.kind === 'folder' || location.kind === 'file') && location.ref.locationId !== null && !locationOf(index, { source: location.ref.source, locationId: location.ref.locationId })
    ? { source: location.ref.source, locationId: location.ref.locationId }
    : null
  if (index && location.kind === 'unknown-source') {
    missingNotice = <>Source “{location.name}” does not exist. Only the Pi and Claude sources are available.</>
    missingLinks = sourceLinks(null)
  } else if (index && location.kind === 'malformed') {
    missingNotice = <>This link is invalid and could not be read.</>
    missingLinks = sourceLinks(null)
  } else if (index && location.kind === 'legacy') {
    missingNotice = <>This link ({location.pathname}) uses the old fixture layout, where files sat directly under {location.source}. Skills now live in configured locations, so it was not resolved automatically. Choose a {location.source} location:</>
    missingLinks = <><LocationLinks locations={locationsOf(location.source)} onNavigate={revealLocation} />{sourceLinks(location.source)}</>
  } else if (unknownRefLocation) {
    missingNotice = <>Location “{unknownRefLocation.locationId}” is not configured under {unknownRefLocation.source}. This may be an old link, or the location was removed from the configuration. Choose a {unknownRefLocation.source} location:</>
    missingLinks = <><LocationLinks locations={locationsOf(unknownRefLocation.source)} onNavigate={revealLocation} />{sourceLinks(unknownRefLocation.source)}</>
  } else if (index && selectedRef && selectedRef.locationId !== null && selectedRef.path && selectedLocation?.status === 'unavailable') {
    missingNotice = <>Folder “{selectedRef.path}” cannot be shown: location {selectedLocation.label} is unavailable. {selectedLocation.error}</>
    missingLinks = sourceLinks(selectedRef.source)
  } else if (index && selectedRef && !selectedExists && selectedRef.locationId !== null) {
    missingNotice = <>Folder “{selectedRef.path}” was not found in {selectedRef.source} / {locationLabel(index, { source: selectedRef.source, locationId: selectedRef.locationId })}. It may have been renamed or removed.</>
    const locationId = selectedRef.locationId
    missingLinks = (
      <>
        <a href={folderToPathname({ source: selectedRef.source, locationId, path: '' })} onClick={event => { event.preventDefault(); navigate({ source: selectedRef.source, locationId, path: '' }, { reveal: true }) }}>
          Go to {locationLabel(index, { source: selectedRef.source, locationId })}
        </a>
        {sourceLinks(selectedRef.source)}
      </>
    )
  }

  let folderInfo: string
  if (!index || !selectedId || !selectedNode) {
    folderInfo = 'Two sources: Pi and Claude. Select a source, a location or a folder to see what it contains.'
  } else if (selectedNode.kind === 'location' && selectedNode.location?.status === 'unavailable') {
    folderInfo = `Unavailable: ${selectedNode.location.error ?? 'this location cannot be read.'}`
  } else {
    folderInfo = describeCounts(childCounts(index, selectedId), selectedNode.kind)
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title">
          <h1>MD Manager</h1>
          <p>Pi and Claude skill locations as a containment graph. Edits are saved only when you press Save.</p>
        </div>
        <button type="button" className="button" onClick={() => void refresh()} disabled={!ready || refreshing} aria-busy={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      <div className="visually-hidden" role="status" aria-live="polite">{announcement}</div>

      {showPendingNotice && (
        <div className="banner banner-error" role="alert">
          A save is in progress. Wait for it to finish before leaving this file; if it fails you can retry or copy the draft.
        </div>
      )}
      {discardAction && (
        <ConfirmDialog title="Discard changes?" confirmLabel="Discard" destructive onConfirm={() => { const action = discardAction; setDiscardAction(null); action.run() }} onCancel={() => setDiscardAction(null)}>
          <p>This file has unsaved changes. Leaving now discards them; they cannot be recovered afterwards. Cancel to keep editing, or save first.</p>
        </ConfirmDialog>
      )}

      {operationNotice && (
        <div className="banner banner-error" role="alert">
          {operationNotice}
          <button type="button" className="button button-small" onClick={() => setOperationNotice(null)}>Dismiss</button>
        </div>
      )}
      {outcome && (outcome.refreshFailed ? (
        <div className="banner banner-error" role="alert" data-testid="operation-outcome">
          {outcome.message} The listing could not be refreshed afterwards, so the graph may be outdated: use Refresh once the API is reachable. Do not repeat the operation.
          <button type="button" className="button button-small" onClick={() => { setOutcome(null); void refresh() }} disabled={!ready}>Refresh</button>
          <button type="button" className="button button-small" onClick={() => setOutcome(null)}>Dismiss</button>
        </div>
      ) : (
        <div className="banner banner-info" data-testid="operation-outcome">
          {outcome.message}
          <button type="button" className="button button-small" onClick={() => setOutcome(null)}>Dismiss</button>
        </div>
      ))}
      {operation && index && (
        <OperationDialog operation={operation.request} index={index} onCancel={() => setOperation(null)} onSuccess={(done, response) => { void completeOperation(done, response, operation.context) }} />
      )}

      {data.status === 'ready' && data.refreshError && !outcome?.refreshFailed && (
        <div className="banner banner-error" role="alert">
          Refresh failed: {data.refreshError} The graph still shows the previous listing, which may be outdated. Try Refresh again once the API is reachable.
        </div>
      )}

      <div className="navigation">
        <Breadcrumbs selected={selectedRef} file={fileRef} index={index} onNavigate={navigateFromBreadcrumb} />
        {fileRef ? null : missingNotice ? (
          <div className="missing" role="alert">
            <p>{missingNotice}</p>
            <p className="missing-links">{missingLinks}</p>
          </div>
        ) : (
          <p className="folder-info" data-testid="folder-info">{folderInfo}</p>
        )}
      </div>

      {browsing && (
        <div className="toolbars">
          <div className="toolbar" role="toolbar" aria-label="Graph controls">
            <button type="button" className="button" onClick={() => canvasRef.current?.zoomIn()} disabled={!graphControlsEnabled} aria-label="Zoom in">+</button>
            <button type="button" className="button" onClick={() => canvasRef.current?.zoomOut()} disabled={!graphControlsEnabled} aria-label="Zoom out">−</button>
            <button type="button" className="button" onClick={() => canvasRef.current?.fit()} disabled={!graphControlsEnabled}>Fit</button>
            <button type="button" className="button" onClick={reset} disabled={!ready}>Reset</button>
            <button type="button" className="button" onClick={toggleMode} disabled={!ready} aria-pressed={mode === 'outline'}>Outline</button>
          </div>
          <div className="toolbar" role="toolbar" aria-label="File operations">
            <button type="button" className="button" onClick={() => requestFolderOperation('create-file')} disabled={!canCreate}>New file…</button>
            <button type="button" className="button" onClick={() => requestFolderOperation('create-folder')} disabled={!canCreate}>New folder…</button>
            <button type="button" className="button" onClick={() => requestFolderOperation('rename')} disabled={!isDirectory}>Rename…</button>
            <button type="button" className="button" onClick={() => requestFolderOperation('move')} disabled={!isDirectory}>Move…</button>
            <button type="button" className="button" onClick={() => requestFolderOperation('delete')} disabled={!isDirectory}>Delete…</button>
          </div>
        </div>
      )}

      <main className={browsing ? 'workspace' : 'workspace workspace-document'} aria-busy={browsing && data.status === 'loading'}>
        {fileRef && documentState && (
          <DocumentView
            fileRef={fileRef}
            location={fileLocation}
            state={documentState}
            editingState={editingState}
            onBack={backToFolder}
            onRetry={retryDocument}
            onAnnounce={announce}
            onEditingChange={setEditingState}
            onOperation={requestFileOperation}
            guardLeave={guardLeave}
          />
        )}
        {browsing && data.status === 'loading' && (
          <div className="placeholder">
            <p>Loading the configured Pi and Claude locations…</p>
          </div>
        )}
        {browsing && data.status === 'error' && (
          <div className="placeholder" role="alert">
            <p>Unable to load the configured locations. {data.message}</p>
            <p>Check that the API is running, then retry.</p>
            <button type="button" className="button" onClick={retry}>Retry</button>
          </div>
        )}
        {browsing && data.status === 'ready' && mode === 'graph' && (
          <GraphCanvas
            key={browsingRevision}
            ref={canvasRef}
            layout={layout}
            index={data.index}
            nodes={visible.nodes}
            edges={visible.edges}
            expanded={expanded}
            selectedId={selectedId}
            viewRequest={viewRequest}
            handledRequest={handledRequest}
            viewStore={viewStore}
            onSelect={select}
            onOpenFile={openFile}
            onToggleExpand={toggleExpand}
            onTogglePin={togglePin}
          />
        )}
        {browsing && data.status === 'ready' && mode === 'outline' && (
          <Outline
            key={browsingRevision}
            index={data.index}
            expanded={expanded}
            selectedId={selectedId}
            scrollRef={outlineScroll}
            onSelect={select}
            onOpenFile={openFile}
            onToggleExpand={toggleExpand}
          />
        )}
      </main>

      {browsing && mode === 'graph' && (
        <footer className="legend" aria-label="Legend">
          <ul>
            <li><svg viewBox="-16 -16 32 32" aria-hidden="true"><circle className="legend-source" r="11" /></svg>Source</li>
            <li><svg viewBox="-16 -16 32 32" aria-hidden="true"><rect className="legend-location" x="-13" y="-9" width="26" height="18" rx="5" /></svg>Location</li>
            <li><svg viewBox="-16 -16 32 32" aria-hidden="true"><path className="legend-directory" d="M -12 -9 h 7 l 3 3 h 14 v 15 h -24 z" /></svg>Folder</li>
            <li><svg viewBox="-16 -16 32 32" aria-hidden="true"><path className="legend-file" d="M -7 -11 h 9 l 5 5 v 17 h -14 z" /></svg>Markdown file</li>
            <li><svg viewBox="-16 -16 32 32" aria-hidden="true"><line className="legend-edge" x1="-13" y1="0" x2="8" y2="0" markerEnd="url(#contains-arrow)" /><path className="legend-edge-arrow" d="M 7 -4 L 13 0 L 7 4 z" /></svg>Contains (parent → child)</li>
            <li><svg viewBox="-16 -16 32 32" aria-hidden="true"><circle className="legend-pin" r="9" /><path className="legend-pin-glyph" d="M -3 -4 h 6 l -1 4 h -4 z M 0 0 v 6" /></svg>Pinned (dragged or P)</li>
          </ul>
          <p>Keyboard: Tab moves through nodes in outline order, Enter selects a source, location or folder or opens a file, → expands, ← collapses, P pins or unpins.</p>
        </footer>
      )}
    </div>
  )
}

export default App
