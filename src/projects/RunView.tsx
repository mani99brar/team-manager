import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import {
  buildTimeline, deriveAttention, deriveNow, laneLines, nowResultUris, textToString,
  type RunData, type Timeline,
} from '../../contracts/projects/triage.ts'
import {
  fetchEvents, fetchReviewResult, fetchRunInputs, fetchWorkerResult, NOT_RECORDED, orNotRecorded, ProjectsApiError, scopedResultPath, scopedReviewPath,
  type RunDetail, type RunScope, type WorkerResult, type WorkflowDefinition,
} from './api.ts'
import { AssignmentPanel } from './Assignment.tsx'
import { NodeDetail } from './NodeDetail.tsx'
import { LanesLine, NowBanner } from './NowBanner.tsx'
import { AppLink, ErrorPanel, LoadingPanel } from './panels.tsx'
import { assignmentPathname, runPathname } from './routes.ts'
import { RunBar, RunHeader } from './RunHeader.tsx'
import { StepStrip } from './StepStrip.tsx'
import { stepRows, withoutGlyph } from './steps.ts'
import { Activity, StepsTable } from './StepsTimeline.tsx'
import { formatAgo, formatClock, formatSpan } from './time.ts'
import { useNow, useTimeReference, useTimeZone } from './useNow.ts'
import { useResource, type ResourceMeta } from './useResource.ts'
import { WorkflowGraph, type GraphNodeView } from './WorkflowGraph.tsx'
import './run.css'

type Tab = 'run' | 'assignment'

type Props = {
  scope: RunScope
  detail: RunDetail
  /** The workflow's current definition, when the workflow list loaded; used only to say whether it changed. */
  current: WorkflowDefinition | null
  selectedNodeId: string | null
  /** The run's view, from the path: the Run view (a node page is part of it) or Assignment. */
  tab: Tab
  refreshToken: number
  /** Ticks while the run page polls live state; the run's events and inputs re-read in the background with it. */
  pollToken?: number
  /** How fresh the polled run detail is, for the live chip. */
  freshness: ResourceMeta
  onNavigate: (pathname: string) => void
  /** Speaks through the page's polite announcer: here only a change of the run's situation (docs/PRD_VIEWER_UX.md 6.4). */
  onAnnounce: (message: string) => void
}

type Highlight = { nodeId: string; quote: string }
type FileFocus = { nodeId: string; path: string }

const TABS: { id: Tab; label: string; testId: string }[] = [
  { id: 'run', label: 'Run', testId: 'tab-run' },
  { id: 'assignment', label: 'Assignment', testId: 'tab-assignment' },
]

// ---- Lane results: immutable per URI, read once for the page's lifetime (docs/PRD_VIEWER_UX.md 7) --------------------

type CachedResult = { status: 'ready'; result: WorkerResult } | { status: 'absent' } | { status: 'failed'; refresh: number }
const RESULT_CACHE_LIMIT = 200
const cachedResults = new Map<string, CachedResult>()
const inflight = new Set<string>()
const resultListeners = new Set<() => void>()
let resultVersion = 0

function settleResult(uri: string, value: CachedResult) {
  cachedResults.delete(uri)
  cachedResults.set(uri, value)
  if (cachedResults.size > RESULT_CACHE_LIMIT) cachedResults.delete(cachedResults.keys().next().value!)
  resultVersion += 1
  resultListeners.forEach(listener => listener())
}

function subscribeResults(listener: () => void) {
  resultListeners.add(listener)
  return () => { resultListeners.delete(listener) }
}

/**
 * The worker and candidate results the Now banner and the lanes line read (`nowResultUris`), fetched once each. A result
 * that answers 404 counts as absent, not as loading; another failure is retried by the next Refresh.
 */
function useRunResults(scope: RunScope, uris: readonly string[], refreshToken: number): { results: ReadonlyMap<string, WorkerResult>; pending: number } {
  const version = useSyncExternalStore(subscribeResults, () => resultVersion, () => resultVersion)
  const key = uris.join('\n')
  useEffect(() => {
    for (const uri of key === '' ? [] : key.split('\n')) {
      const known = cachedResults.get(uri)
      if (inflight.has(uri) || (known && (known.status !== 'failed' || known.refresh === refreshToken))) continue
      const path = scopedResultPath(scope, uri)
      if (path === null) { settleResult(uri, { status: 'absent' }); continue }
      inflight.add(uri)
      fetchWorkerResult(scope, path).then(
        result => settleResult(uri, { status: 'ready', result }),
        (error: unknown) => settleResult(uri, error instanceof ProjectsApiError && error.notFound ? { status: 'absent' } : { status: 'failed', refresh: refreshToken }),
      ).finally(() => inflight.delete(uri))
    }
  }, [scope, key, refreshToken])
  return useMemo(() => {
    const results = new Map<string, WorkerResult>()
    let pending = 0
    for (const uri of key === '' ? [] : key.split('\n')) {
      const known = cachedResults.get(uri)
      if (known?.status === 'ready') results.set(uri, known.result)
      else if (!known) pending += 1
    }
    return { results, pending }
    // `version` re-reads the cache whenever a result settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version])
}

/** The timeline of a run whose events have not loaded yet: every step shows its status, none a time. */
function emptyTimeline(detail: RunDetail): Timeline {
  return { runStart: { at: detail.summary.created_at, source: 'receipt' }, runEnd: null, lastActivity: null, spans: [], markers: [], gaps: [], byNode: new Map(), activity: [] }
}

/**
 * One run (docs/PRD_VIEWER_UX.md 4.2-4.4). The run page: the header, the Now banner with the likely next step, the lanes
 * line, then the Run and Assignment tabs; the Run view holds the fitted graph, the Steps table and Activity. A node page:
 * the one-line run bar, the tabs, the sticky step strip and the node in full width. One clock ticks here while the run can
 * still change; selecting a step moves the focus to its heading, and coming back returns it to the step's row.
 */
export function RunView({ scope, detail, current, selectedNodeId, tab, refreshToken, pollToken = 0, freshness, onNavigate, onAnnounce }: Props) {
  const { summary, definition, snapshot } = detail
  const clock = useNow(summary.status !== 'succeeded' && summary.status !== 'cancelled')
  const [zone] = useTimeZone()
  const runStart = useTimeReference()
  const snapshotById = new Map(snapshot.nodes.map(node => [node.node_id, node]))
  const selectedDefinition = selectedNodeId === null ? null : definition.nodes.find(node => node.node_id === selectedNodeId) ?? null
  const selectedState = selectedNodeId === null ? null : snapshotById.get(selectedNodeId) ?? null

  const runKey = `${scope.projectId}/${scope.workflowId}/${scope.runId}`
  const loadEvents = useCallback((signal: AbortSignal) => fetchEvents(scope, signal), [scope])
  const { state: events, reload: reloadEvents } = useResource(`events:${runKey}`, loadEvents, refreshToken, pollToken)
  // The inputs are one resource per run; a 404 INPUTS_NOT_FOUND means "not recorded", which loads as null.
  const loadInputs = useCallback((signal: AbortSignal) => orNotRecorded(fetchRunInputs(scope, signal), NOT_RECORDED.inputs), [scope])
  const { state: inputs, reload: reloadInputs } = useResource(`inputs:${runKey}`, loadInputs, refreshToken, pollToken)
  // The recorded review is immutable per URI; a run whose export predates reviews has none.
  const reviewUri = snapshot.nodes.find(node => node.node_id === 'review')?.result_uri ?? null
  const reviewPath = reviewUri === null ? null : scopedReviewPath(scope, reviewUri)
  const loadReview = useCallback((signal: AbortSignal) => orNotRecorded(fetchReviewResult(scope, reviewPath!, signal), NOT_RECORDED.review), [scope, reviewPath])
  const { state: review } = useResource(reviewPath === null ? null : `review:${reviewPath}`, loadReview, refreshToken)

  const eventsData = events.status === 'ready' ? events.data : null
  const inputsData = inputs.status === 'ready' ? inputs.data : null
  const reviewData = review.status === 'ready' ? review.data : null
  const uris = useMemo(() => (eventsData === null ? [] : nowResultUris(detail, eventsData)), [detail, eventsData])
  const { results, pending } = useRunResults(scope, uris, refreshToken)
  const run: RunData | null = useMemo(
    () => (eventsData === null ? null : { detail, events: eventsData, inputs: inputsData, review: reviewData, results }),
    [detail, eventsData, inputsData, reviewData, results],
  )
  // The banner waits for what its rules read: the inputs, the review and the lane results (`Now.missing`).
  const settled = run !== null && (inputs.status === 'ready' || inputs.status === 'error') && (reviewPath === null || review.status === 'ready' || review.status === 'error') && pending === 0
  const now = useMemo(() => (settled && run ? deriveNow(run) : null), [settled, run])
  const attention = useMemo(() => (run ? deriveAttention(run) : null), [run])
  const lanes = useMemo(() => (run ? laneLines(run) : []), [run])
  // buildTimeline keeps its own cache (PRD 5.1), which deriveNow and laneLines share; the memo only spares the clock ticks
  // its key check. The Steps rows are read on every tick, since a running step's duration grows with the clock.
  const timeline = useMemo(() => (run ? buildTimeline(run) : null), [run])
  const rows = stepRows(detail, timeline ?? emptyTimeline(detail), { now: clock, attention: attention ?? undefined })
  const labels = useMemo(() => new Map(definition.nodes.map(node => [node.node_id, node.label])), [definition.nodes])
  const graphNodes: GraphNodeView[] = definition.nodes.map(node => {
    const state = snapshotById.get(node.node_id)!
    return { node_id: node.node_id, label: node.label, kind: node.kind, depends_on: node.depends_on, status: state.status, attempt: state.attempt, attention: attention?.nodes.get(node.node_id)?.kind ?? null }
  })

  // A requirement quote handed from a review finding to a worker's task; it applies to one node and is dropped once applied or when leaving it.
  const [pendingHighlight, setPendingHighlight] = useState<Highlight | null>(null)
  const clearHighlight = useCallback(() => setPendingHighlight(null), [])
  const highlight = pendingHighlight !== null && pendingHighlight.nodeId === selectedNodeId ? pendingHighlight.quote : null
  // A captured file handed from a review finding to the launch node that shows it, applied the same way.
  const [pendingFile, setPendingFile] = useState<FileFocus | null>(null)
  const clearFile = useCallback(() => setPendingFile(null), [])
  const fileFocus = pendingFile !== null && pendingFile.nodeId === selectedNodeId ? pendingFile.path : null

  const runHref = runPathname(scope.projectId, scope.workflowId, scope.runId)
  const nodeHref = useCallback((nodeId: string) => runPathname(scope.projectId, scope.workflowId, scope.runId, nodeId), [scope])
  const tabHref = (id: Tab) => (id === 'assignment' ? assignmentPathname(scope.projectId, scope.workflowId, scope.runId) : runHref)
  const openRequirement = useCallback((nodeId: string, quote: string) => {
    setPendingHighlight({ nodeId, quote })
    onNavigate(nodeHref(nodeId))
  }, [onNavigate, nodeHref])
  const openFile = useCallback((nodeId: string, path: string) => {
    setPendingFile({ nodeId, path })
    onNavigate(nodeHref(nodeId))
  }, [onNavigate, nodeHref])

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.findIndex(candidate => candidate.id === tab)
    let next: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % TABS.length
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + TABS.length) % TABS.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = TABS.length - 1
    if (next === null) return
    event.preventDefault()
    onNavigate(tabHref(TABS[next].id))
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-testid="${TABS[next].testId}"]`)?.focus()
  }

  // Selecting a step opens its page at the top with the focus on its heading; coming back focuses the step's row again.
  const shownNode = useRef(selectedNodeId)
  useEffect(() => {
    const previous = shownNode.current
    shownNode.current = selectedNodeId
    if (previous === selectedNodeId) return
    if (selectedNodeId !== null) {
      window.scrollTo(0, 0)
      document.getElementById('node-detail-title')?.focus({ preventScroll: true })
    } else if (previous !== null) {
      document.querySelector<HTMLElement>(`[data-testid="run-node-list"] [data-node-id="${CSS.escape(previous)}"] a`)?.focus()
    }
  }, [selectedNodeId])

  // While a question, a pane or an approval waits on the operator, the tab title says so (docs/PRD_VIEWER_UX.md 6.4).
  const waiting = attention?.top != null
  useEffect(() => {
    if (!waiting) return
    const title = document.title
    document.title = `? Waiting · ${summary.run_id} — ${title}`
    return () => { document.title = title }
  }, [waiting, summary.run_id])

  // The polite announcer speaks the Now headline only when the situation changes, never on a poll that changed nothing.
  const situation = now?.situation ?? null
  const spoken = useRef<string | null>(null)
  useEffect(() => {
    if (now === null) return
    const previous = spoken.current
    spoken.current = now.situation
    if (previous === null || previous === now.situation) return
    const format = { clock: (at: string) => formatClock(at, { zone, reference: runStart }), ago: formatAgo, span: formatSpan }
    onAnnounce(`Now: ${textToString(withoutGlyph(now.headline, now.glyph), Date.now(), format)}`)
    // Only a change of situation speaks; the headline's clock and ages change every second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [situation])

  const tabs = (
    <div className="tabs run-tabs" role="tablist" aria-label="Run views">
      {TABS.map(candidate => (
        <button
          key={candidate.id}
          type="button"
          role="tab"
          id={`run-tab-${candidate.id}`}
          className="tab"
          aria-selected={tab === candidate.id}
          aria-controls={`run-panel-${candidate.id}`}
          tabIndex={tab === candidate.id ? 0 : -1}
          data-testid={candidate.testId}
          onClick={() => { if (tab !== candidate.id || selectedNodeId !== null) onNavigate(tabHref(candidate.id)) }}
          onKeyDown={onTabKey}
        >
          {candidate.label}
        </button>
      ))}
    </div>
  )

  return (
    <div className="run-view" data-testid="run-view" data-run-id={summary.run_id} data-run-status={summary.status}>
      {selectedNodeId === null ? (
        <>
          <RunHeader detail={detail} inputs={inputs} onRetryInputs={reloadInputs} current={current} freshness={freshness} timeline={timeline} clock={clock} />
          {events.status === 'error'
            ? <ErrorPanel error={events.error} what="The run's events" onRetry={reloadEvents}><span>Without them the situation and the next step cannot be read.</span></ErrorPanel>
            : <NowBanner now={now} clock={clock} focusHref={now?.focus ? nodeHref(now.focus.node_id) : null} onNavigate={onNavigate} />}
          <LanesLine lines={lanes} />
        </>
      ) : (
        <RunBar detail={detail} now={now} clock={clock} runHref={runHref} freshness={freshness} onNavigate={onNavigate} />
      )}

      <div className="run-views">
      {tabs}

      {tab === 'assignment' ? (
        <AssignmentPanel scope={scope} inputs={inputs} onRetry={reloadInputs} onNavigate={onNavigate} panelId="run-panel-assignment" tabId="run-tab-assignment" />
      ) : (
        <div role="tabpanel" id="run-panel-run" aria-labelledby="run-tab-run" className="run-body">
          {selectedNodeId === null ? (
            <>
              <section className="run-graph" aria-label="Pinned graph">
                <WorkflowGraph title={`Pinned definition graph of run ${summary.run_id}`} nodes={graphNodes} selectedId={null} focusId={now?.focus?.node_id ?? null} onSelect={nodeId => onNavigate(nodeHref(nodeId))} />
              </section>
              <StepsTable rows={rows} timeline={timeline} now={clock} live={summary.status === 'running' || summary.status === 'awaiting_approval'} nodeHref={nodeHref} onNavigate={onNavigate} />
              {(events.status === 'loading' || events.status === 'idle') && <LoadingPanel>Loading the run's events…</LoadingPanel>}
              {timeline && <Activity timeline={timeline} labels={labels} nodeHref={nodeHref} onNavigate={onNavigate} />}
            </>
          ) : (
            <>
              <StepStrip detail={detail} rows={rows} current={selectedNodeId} runHref={runHref} nodeHref={nodeHref} onNavigate={onNavigate} />
              <div className="run-node-area">
                {(selectedDefinition === null || selectedState === null) && (
                  <div className="projects-error" role="alert" data-testid="node-missing">
                    <p>Node <code>{selectedNodeId}</code> is not part of this run's pinned definition.</p>
                    <p><AppLink href={runHref} onNavigate={onNavigate}>Back to the run</AppLink></p>
                  </div>
                )}
                {selectedDefinition !== null && selectedState !== null && (
                  <NodeDetail
                    key={selectedNodeId}
                    scope={scope}
                    definition={selectedDefinition}
                    definitionNodes={definition.nodes}
                    snapshotNodes={snapshot.nodes}
                    node={selectedState}
                    events={events}
                    onRetryEvents={reloadEvents}
                    inputs={inputs}
                    onRetryInputs={reloadInputs}
                    refreshToken={refreshToken}
                    onNavigate={onNavigate}
                    highlight={highlight}
                    onHighlightApplied={clearHighlight}
                    onOpenRequirement={openRequirement}
                    fileFocus={fileFocus}
                    onFileFocusApplied={clearFile}
                    onOpenFile={openFile}
                  />
                )}
              </div>
            </>
          )}
        </div>
      )}
      </div>
    </div>
  )
}
