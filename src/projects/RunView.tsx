import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  buildTimeline, deriveAttention, deriveNow, nowResultUris, textToString,
  type RunData, type Timeline,
} from '../../contracts/projects/triage.ts'
import { fetchAttackResult, fetchEvents, fetchPanelResults, fetchRunInputs, fetchSidecarLedger, NOT_RECORDED, orNotRecorded, type RunDetail, type RunScope, type WorkflowDefinition } from './api.ts'
import { AssignmentPanel } from './Assignment.tsx'
import { NodeDetail } from './NodeDetail.tsx'
import { AttackPassBody } from './node/AttackSections.tsx'
import { AppLink, ErrorPanel } from './panels.tsx'
import { ProviderPanelBody } from './providerPanel.tsx'
import { assignmentPathname, runPathname } from './routes.ts'
import { RunBar } from './RunHeader.tsx'
import { IdentityLine } from './signal/IdentityLine.tsx'
import { SignalRun } from './signal/SignalRun.tsx'
import { isAttackNode, isSidecarNode } from './status.ts'
import { StepStrip } from './StepStrip.tsx'
import { stepRows, withoutGlyph } from './steps.ts'
import { formatAgo, formatClock, formatSpan } from './time.ts'
import { stateTone, TONE_LABEL } from './tone.ts'
import { useNow, useTimeReference, useTimeZone } from './useNow.ts'
import { useResource, type ResourceMeta } from './useResource.ts'
import { useRunResults, useRunReview } from './useRunData.ts'
import './run.css'

type Tab = 'run' | 'assignment'

type Props = {
  scope: RunScope
  detail: RunDetail
  /** The workflow's current definition, when the workflow list loaded; used only to say whether it changed. */
  current: WorkflowDefinition | null
  selectedNodeId: string | null
  /** The attempt a node page shows, from `/nodes/<n>/attempts/<k>`; null for its latest. */
  selectedAttempt?: number | null
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

/** A repair session whose node reads running (its launch has not applied or blocked yet). */
const REPAIR_RUNNING_STATUSES: ReadonlySet<string> = new Set(['launched', 'captured', 'recorded'])

const TABS: { id: Tab; label: string; testId: string }[] = [
  { id: 'run', label: 'Run', testId: 'tab-run' },
  { id: 'assignment', label: 'Assignment', testId: 'tab-assignment' },
]

/** The timeline of a run whose events have not loaded yet: every step shows its status, none a time. */
function emptyTimeline(detail: RunDetail): Timeline {
  return { runStart: { at: detail.summary.created_at, source: 'receipt' }, runEnd: null, lastActivity: null, spans: [], markers: [], gaps: [], byNode: new Map(), activity: [] }
}

/**
 * One run (docs/PRD_VIEWER_UX.md 4.2-4.4, redrawn by the Signal Box design of 2026-10-09). The run page: the identity line,
 * then the stage with the run's graph, the live dock (the situation and the likely next step) and the step sheet. The
 * Assignment view keeps the identity line over the assignment. A node page: the one-line run bar, the tabs, the sticky step
 * strip and the node in full width. One clock ticks here while the run can still change; selecting a step's page moves the
 * focus to its heading, and coming back returns it to the step's card on the stage.
 */
export function RunView({ scope, detail, current, selectedNodeId, selectedAttempt = null, tab, refreshToken, pollToken = 0, freshness, onNavigate, onAnnounce }: Props) {
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
  // The review sidecar's ledger changes while the workers run: polled like the inputs, and only for a run that has the node
  // (a run without one asks nothing). A 404 SIDECAR_NOT_FOUND means "not recorded" (no pass yet) and loads as null.
  const hasSidecar = definition.nodes.some(isSidecarNode)
  const loadSidecar = useCallback((signal: AbortSignal) => orNotRecorded(fetchSidecarLedger(scope, signal), NOT_RECORDED.sidecar), [scope])
  const { state: sidecar, reload: reloadSidecar } = useResource(hasSidecar ? `sidecar:${runKey}` : null, loadSidecar, refreshToken, pollToken)
  // The attack pass's record changes while the pass runs: polled the same way, only for a run whose graph has the node. A 404
  // ATTACK_NOT_FOUND (an unreadable record) loads as null; a run without a pass asks nothing and shows no section.
  const hasAttack = definition.nodes.some(isAttackNode)
  const loadAttack = useCallback((signal: AbortSignal) => orNotRecorded(fetchAttackResult(scope, signal), NOT_RECORDED.attack), [scope])
  const { state: attack, reload: reloadAttack } = useResource(hasAttack ? `attack:${runKey}` : null, loadAttack, refreshToken, pollToken)
  // The multi-provider panel has no graph node this slice (docs/PRD_MULTI_PROVIDER_PANEL.md Appendix A), so every run asks for
  // its record, polled the same way: a 404 PANELS_NOT_FOUND (no panels, an older export, an unreadable record) loads as null
  // and shows no section, so a run without panels and every older export render as today.
  const loadPanels = useCallback((signal: AbortSignal) => orNotRecorded(fetchPanelResults(scope, signal), NOT_RECORDED.panels), [scope])
  const { state: panels, reload: reloadPanels } = useResource(`panels:${runKey}`, loadPanels, refreshToken, pollToken)
  const hasPanels = panels.status === 'error' || (panels.status === 'ready' && panels.data !== null)
  // The recorded review and the lane results are immutable per URI: read once through the run's cache (docs/PRD_VIEWER_UX.md 7).
  const reviewPath = snapshot.nodes.find(node => node.node_id === 'review')?.result_uri ?? null
  const review = useRunReview(scope, reviewPath, String(refreshToken))

  const eventsData = events.status === 'ready' ? events.data : null
  const inputsData = inputs.status === 'ready' ? inputs.data : null
  const reviewData = review.status === 'ready' ? review.data : null
  const uris = useMemo(() => (eventsData === null ? [] : nowResultUris(detail, eventsData)), [detail, eventsData])
  const { results, pending } = useRunResults(scope, uris, String(refreshToken))
  const run: RunData | null = useMemo(
    () => (eventsData === null ? null : { detail, events: eventsData, inputs: inputsData, review: reviewData, results }),
    [detail, eventsData, inputsData, reviewData, results],
  )
  // The banner waits for what its rules read: the inputs, the review and the lane results (`Now.missing`).
  const settled = run !== null && (inputs.status === 'ready' || inputs.status === 'error') && (reviewPath === null || review.status === 'ready' || review.status === 'error') && pending === 0
  const now = useMemo(() => (settled && run ? deriveNow(run) : null), [settled, run])
  const attention = useMemo(() => (run ? deriveAttention(run) : null), [run])
  // buildTimeline keeps its own cache (PRD 5.1), which deriveNow and laneLines share; the memo only spares the clock ticks
  // its key check. The Steps rows are read on every tick, since a running step's duration grows with the clock.
  const timeline = useMemo(() => (run ? buildTimeline(run) : null), [run])
  const rows = stepRows(detail, timeline ?? emptyTimeline(detail), { now: clock, attention: attention ?? undefined })
  // The run's one tone (docs/PRD_VIEWER_REVAMP.md 4): what waits on the operator wins over the status.
  const tone = stateTone({ status: summary.status, attention: attention?.top?.kind ?? null })

  // The in-run fix loop (export 1.10.0): the review node's round line follows the fix loop, not the snapshot attempt
  // (docs/PRD_VIEWER_REFINE 5.2, decisions [L12]/[L13]). The repair nodes themselves are projected into `definition`/`snapshot`
  // by the server; the stage model reads their entries.
  const fixLoopRepairs = detail.fixLoop && 'repairs' in detail.fixLoop ? detail.fixLoop.repairs : []
  const fixLoopRounds = detail.fixLoop && 'review_rounds' in detail.fixLoop ? detail.fixLoop.review_rounds : []
  const reviewMeta = (): string | null => {
    const running = fixLoopRepairs.find(repair => repair.trigger === 'review' && repair.review_round !== null && REPAIR_RUNNING_STATUSES.has(repair.status))
    if (running?.review_round != null) return `round ${running.review_round + 1} in review`
    const applied = fixLoopRepairs.find(repair => repair.trigger === 'review' && repair.status === 'applied' && repair.review_round !== null)
    if (applied?.review_round != null && reviewData === null) return `round ${applied.review_round + 1} in review`
    if (reviewData?.round != null) {
      const delta = reviewData.delta_from ? ` · delta from ${reviewData.delta_from.slice(0, 7)}` : ''
      const restored = fixLoopRounds.some(round => round.restored_at !== null) ? ' · round restored' : ''
      return `round ${reviewData.round}${delta}${restored}`
    }
    return null
  }
  const reviewRound = reviewMeta()

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

  // Selecting a step, or another attempt of it, opens its page at the top with the focus on its heading (the link that was
  // activated unmounts with the page it was on); coming back focuses the step's row again.
  const shownNode = useRef(selectedNodeId)
  const shownAttempt = useRef(selectedAttempt)
  useEffect(() => {
    const previous = shownNode.current
    const previousAttempt = shownAttempt.current
    shownNode.current = selectedNodeId
    shownAttempt.current = selectedAttempt
    if (previous === selectedNodeId && previousAttempt === selectedAttempt) return
    if (selectedNodeId !== null) {
      window.scrollTo(0, 0)
      document.getElementById('node-detail-title')?.focus({ preventScroll: true })
    } else if (previous !== null) {
      document.querySelector<HTMLElement>(`[data-testid="workflow-graph"] [data-graph-node="${CSS.escape(previous)}"]`)?.focus({ preventScroll: true })
    }
  }, [selectedNodeId, selectedAttempt])

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

  // The run-level records without a step of their own open in the sheet of the step they belong to: the attack pass on its
  // node, the multi-provider panel on the review's.
  const sheetExtras = (nodeId: string): ReactNode => {
    const node = definition.nodes.find(candidate => candidate.node_id === nodeId)
    if (!node) return null
    if (hasAttack && isAttackNode(node)) {
      return (
        <section className="sb-sheet-record" data-testid="attack-section" aria-labelledby="run-attack-title">
          <h4 id="run-attack-title">Attack pass</h4>
          <AttackPassBody record={attack} onRetry={reloadAttack} />
        </section>
      )
    }
    if (hasPanels && nodeId === 'review' && node.kind === 'review') {
      return (
        <section className="sb-sheet-record" data-testid="panel-section" aria-labelledby="run-panels-title">
          <h4 id="run-panels-title">Panel</h4>
          <ProviderPanelBody record={panels} onRetry={reloadPanels} />
        </section>
      )
    }
    return null
  }
  const attentionWord = attention?.top ? `${TONE_LABEL.warn.toLowerCase()}: ${attention.top.kind === 'question' ? 'a question waits' : attention.top.kind === 'pane' ? 'a pane needs attention' : 'an approval waits'}` : null
  const identity = (other: { label: string; href: string; testId: string }) => (
    <IdentityLine detail={detail} inputs={inputs} onRetryInputs={reloadInputs} current={current} freshness={freshness} clock={clock} tone={tone} attentionWord={attentionWord} other={other} onNavigate={onNavigate} />
  )

  return (
    <div className="run-view" data-testid="run-view" data-run-id={summary.run_id} data-run-status={summary.status}>
      {selectedNodeId === null && tab === 'run' && (
        <div className="sb-run">
          {identity({ label: 'Assignment', href: assignmentPathname(scope.projectId, scope.workflowId, scope.runId), testId: 'tab-assignment' })}
          {events.status === 'error' && (
            <ErrorPanel error={events.error} what="The run's events" onRetry={reloadEvents}><span>Without them the situation and the next step cannot be read.</span></ErrorPanel>
          )}
          <SignalRun
            detail={detail}
            rows={rows}
            timeline={timeline}
            events={eventsData ?? []}
            inputs={inputsData}
            review={reviewData}
            attention={attention}
            now={now}
            clock={clock}
            reviewRound={reviewRound}
            nodeHref={nodeHref}
            onNavigate={onNavigate}
            sheetExtras={sheetExtras}
          />
        </div>
      )}

      {selectedNodeId === null && tab === 'assignment' && (
        <>
          {identity({ label: 'Run graph', href: runHref, testId: 'run-graph-link' })}
          <div className="run-views">
            {tabs}
            <AssignmentPanel scope={scope} inputs={inputs} review={reviewData} onRetry={reloadInputs} onNavigate={onNavigate} panelId="run-panel-assignment" tabId="run-tab-assignment" />
          </div>
        </>
      )}

      {selectedNodeId !== null && (
        <>
          <RunBar detail={detail} now={now} clock={clock} runHref={runHref} freshness={freshness} onNavigate={onNavigate} />
          <div className="run-views">
            {tabs}
            <div role="tabpanel" id="run-panel-run" aria-labelledby="run-tab-run" className="run-body">
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
                    key={`${selectedNodeId}/${selectedAttempt ?? 'latest'}`}
                    scope={scope}
                    detail={detail}
                    definition={selectedDefinition}
                    node={selectedState}
                    attempt={selectedAttempt}
                    timeline={timeline}
                    now={now}
                    clock={clock}
                    events={events}
                    onRetryEvents={reloadEvents}
                    inputs={inputs}
                    onRetryInputs={reloadInputs}
                    sidecar={sidecar}
                    onRetrySidecar={reloadSidecar}
                    attack={attack}
                    onRetryAttack={reloadAttack}
                    panels={panels}
                    onRetryPanels={reloadPanels}
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
            </div>
          </div>
        </>
      )}
    </div>
  )
}
