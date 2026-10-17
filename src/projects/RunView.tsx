import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  buildTimeline, deriveAttention, deriveNow, nowResultUris, textToString,
  type RunData, type Timeline,
} from '../../contracts/projects/triage.ts'
import { fetchAttackResult, fetchEvents, fetchPanelResults, fetchRunGithub, fetchRunInputs, fetchSessions, fetchSidecarLedger, fetchTeams, NOT_RECORDED, orNotRecorded, type RunDetail, type RunScope, type WorkflowDefinition } from './api.ts'
import { AssignmentPanel } from './Assignment.tsx'
import { NodeDetail } from './NodeDetail.tsx'
import { reviewerLead } from './node/model.ts'
import { isProjectedSessionNode, stageCardOf } from './sessions/model.ts'
import { AttackPassBody } from './node/AttackSections.tsx'
import { ControlDialogHost } from './controls/ControlDialog.tsx'
import { waitingQuestions } from './controls/questions.ts'
import { AppLink, ErrorPanel } from './panels.tsx'
import { ProviderPanelBody } from './providerPanel.tsx'
import { EMPTY_TEAM_QUERY, runPathname, teamHref as teamViewHref, type RunTab, type TeamQuery, type TeamQueryMode } from './routes.ts'
import { RunBar } from './RunHeader.tsx'
import { RunViews } from './RunViews.tsx'
import { GithubView } from './github/GithubView.tsx'
import { githubSuffix } from './github/model.ts'
import { useGithubActionEnded } from './github/store.ts'
import { GlyphDefs } from './signal/Glyph.tsx'
import { sheetShowsTeam, teamSessionsOf, teamSuffix } from './teams/model.ts'
import { SheetTeamSection } from './teams/TeamSections.tsx'
import { TeamView } from './teams/TeamView.tsx'
import { IdentityLine } from './signal/IdentityLine.tsx'
import { SignalRun } from './signal/SignalRun.tsx'
import { NightShiftCount, SessionsSection } from './sessions/Sessions.tsx'
import { isAttackNode, isSidecarNode } from './status.ts'
import { StepStrip } from './StepStrip.tsx'
import { stepRows, withoutGlyph } from './steps.ts'
import { formatAgo, formatClock, formatSpan } from './time.ts'
import { stateTone, TONE_LABEL, type Tone } from './tone.ts'
import { useNow, useTimeReference, useTimeZone } from './useNow.ts'
import { usePoll } from './usePoll.ts'
import { useResource, type ResourceMeta } from './useResource.ts'
import { useRunResults, useRunReview } from './useRunData.ts'
import './run.css'

type Props = {
  scope: RunScope
  detail: RunDetail
  /** The workflow's current definition, when the workflow list loaded; used only to say whether it changed. */
  current: WorkflowDefinition | null
  selectedNodeId: string | null
  /** The attempt a node page shows, from `/nodes/<n>/attempts/<k>`; null for its latest. */
  selectedAttempt?: number | null
  /** The run's view, from the path: the Run view (a node page is part of it), Team, GitHub or Assignment. */
  tab: RunTab
  /** The Team view's selection, from the URL's search (docs/PRD_RUN_TEAMS.md 2); absent reads as none selected. */
  teamQuery?: TeamQuery
  /** Changes the Team view's selection: `push` adds a history entry (opening an agent), `replace` rewrites it (filters). */
  onTeamQuery?: (query: TeamQuery, mode: TeamQueryMode) => void
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

/** How often the teams are re-read (docs/PRD_RUN_TEAMS.md 2 "Polling"): fast while someone watches them on a live run. */
const TEAMS_FAST_MS = 5000
const TEAMS_SLOW_MS = 15000
/** How often the run's GitHub read is re-read: on the GitHub view, and elsewhere for the switcher's suffix. */
const GITHUB_VIEW_MS = 60_000
const GITHUB_OTHER_MS = 120_000
const NO_TEAM_QUERY = () => undefined

/** The timeline of a run whose events have not loaded yet: every step shows its status, none a time. */
function emptyTimeline(detail: RunDetail): Timeline {
  return { runStart: { at: detail.summary.created_at, source: 'receipt' }, runEnd: null, lastActivity: null, spans: [], markers: [], gaps: [], byNode: new Map(), activity: [] }
}

/**
 * One run (docs/PRD_VIEWER_UX.md 4.2-4.4, redrawn by the Signal Box design of 2026-10-09). The run page: the identity line,
 * then the stage with the run's graph, the live dock (the situation and the likely next step) and the step sheet. The Team,
 * GitHub and Assignment views keep the identity line, with its view switcher (docs/PRD_RUN_TEAMS.md 2), over their content;
 * each view has a visually hidden `h2#run-view-title` that takes the focus after a switch. A node page: the one-line run bar
 * (with the four views as plain links), the sticky step strip and the node in full width. One clock ticks here while the run can still change; selecting a step's page moves the
 * focus to its heading, and coming back returns it to the step's card on the stage.
 */
export function RunView({ scope, detail, current, selectedNodeId, selectedAttempt = null, tab, teamQuery, onTeamQuery = NO_TEAM_QUERY, refreshToken, pollToken = 0, freshness, onNavigate, onAnnounce }: Props) {
  const { summary, definition, snapshot } = detail
  const live = summary.status !== 'succeeded' && summary.status !== 'cancelled'
  const clock = useNow(live)
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
  // Every session that worked on the run (run-sessions), polled like the panel: a 404 RUN_NOT_FOUND loads as null and the
  // page shows "not recorded" without changing layout.
  const loadSessions = useCallback((signal: AbortSignal) => orNotRecorded(fetchSessions(scope, signal), NOT_RECORDED.sessions), [scope])
  const { state: sessions } = useResource(`sessions:${runKey}`, loadSessions, refreshToken, pollToken)
  const sessionsData = sessions.status === 'ready' ? sessions.data : null
  // The agent teams of the run's Claude sessions (docs/PRD_RUN_TEAMS.md 2 "Polling"): every 5 s while the run is live and
  // the Team view, a worker's page or a worker's step sheet is open, every 15 s otherwise, and no more once the run finished and no team workflow
  // runs. A 404 NOT_FOUND (a server that predates teams) loads as null, "not served".
  const loadTeams = useCallback((signal: AbortSignal) => orNotRecorded(fetchTeams(scope, signal), NOT_RECORDED.teams), [scope])
  const [teamsWorkflowRunning, setTeamsWorkflowRunning] = useState(false)
  // The step whose sheet the Run view has open (SignalRun tells it): a worker's sheet shows its Team section, so it polls fast too.
  const [sheetNode, setSheetNode] = useState<string | null>(null)
  const sheetWorker = tab === 'run' && selectedNodeId === null && sheetNode !== null && definition.nodes.some(node => node.node_id === sheetNode && node.kind === 'worker')
  const teamsWatched = tab === 'team' || selectedDefinition?.kind === 'worker' || sheetWorker
  const teamsPoll = usePoll(live || teamsWorkflowRunning, live && teamsWatched ? TEAMS_FAST_MS : TEAMS_SLOW_MS)
  const { state: teams, reload: reloadTeams, meta: teamsMeta } = useResource(`teams:${runKey}`, loadTeams, refreshToken, teamsPoll)
  const teamsData = teams.status === 'ready' ? teams.data : null
  const workflowsRunning = (teamsData?.totals.workflows_running ?? 0) > 0
  if (workflowsRunning !== teamsWorkflowRunning) setTeamsWorkflowRunning(workflowsRunning)
  // The run's branch against GitHub has its own poll, which keeps going after the run finished (checks and reviews change
  // later): every 60 s on the GitHub view, every 120 s elsewhere for the switcher's suffix. A 404 NOT_FOUND loads as null.
  const loadRunGithub = useCallback((signal: AbortSignal) => orNotRecorded(fetchRunGithub(scope, signal), NOT_RECORDED.runGithub), [scope])
  const githubPoll = usePoll(true, tab === 'github' ? GITHUB_VIEW_MS : GITHUB_OTHER_MS)
  const { state: runGithub, reload: reloadRunGithub, meta: runGithubMeta } = useResource(`run-github:${runKey}`, loadRunGithub, refreshToken, githubPoll)
  const runGithubData = runGithub.status === 'ready' ? runGithub.data : null
  // A GitHub action record that ended (pushed, opened, marked ready, requested) reads GitHub again at once.
  useGithubActionEnded(scope, reloadRunGithub)
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
  // The questions the Answer dialog quotes when it opens away from the Run view's dock (the dock reads the live Now as well).
  const offViewQuestions = useMemo(() => waitingQuestions(now, inputsData), [now, inputsData])
  // buildTimeline keeps its own cache (PRD 5.1), which deriveNow and laneLines share; the memo only spares the clock ticks
  // its key check. The Steps rows are read on every tick, since a running step's duration grows with the clock.
  const timeline = useMemo(() => (run ? buildTimeline(run) : null), [run])
  const rows = stepRows(detail, timeline ?? emptyTimeline(detail), { now: clock, attention: attention ?? undefined })
  // The run's one tone (docs/PRD_VIEWER_REVAMP.md 4): what waits on the operator wins over the status.
  const tone = stateTone({ status: summary.status, attention: attention?.top?.kind ?? null, accepted: summary.accepted })

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

  // A reviewer's step chip takes the tone and verdict of its card on the graph (the sessions' reviewer row), not the session's status.
  const verdicts = useMemo(() => {
    const map = new Map<string, { tone: Tone; verdict: 'approved' | 'blocked' | 'failed' | null }>()
    if (sessionsData === null) return map
    for (const node of definition.nodes) {
      if (!node.node_id.startsWith('reviewer-') || !isProjectedSessionNode(node.node_id)) continue
      const card = stageCardOf(sessionsData, node.node_id)
      if (card) map.set(node.node_id, { tone: card.tone, verdict: reviewerLead({ verdict: card.word, round: null, open: null, status: null }).verdict })
    }
    return map
  }, [sessionsData, definition.nodes])

  const runHref = runPathname(scope.projectId, scope.workflowId, scope.runId)
  const nodeHref = useCallback((nodeId: string) => runPathname(scope.projectId, scope.workflowId, scope.runId, nodeId), [scope])
  // The Team view's link with a selection ("Open in Team view ›", the dock's Working now row, the Sessions table's Team ›).
  const teamHref = useCallback((query: Partial<TeamQuery>) => teamViewHref(scope.projectId, scope.workflowId, scope.runId, query), [scope])
  const nodeLabel = useCallback((nodeId: string) => detail.definition.nodes.find(node => node.node_id === nodeId)?.label ?? nodeId, [detail.definition.nodes])
  const openRequirement = useCallback((nodeId: string, quote: string) => {
    setPendingHighlight({ nodeId, quote })
    onNavigate(nodeHref(nodeId))
  }, [onNavigate, nodeHref])
  const openFile = useCallback((nodeId: string, path: string) => {
    setPendingFile({ nodeId, path })
    onNavigate(nodeHref(nodeId))
  }, [onNavigate, nodeHref])

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

  // A switch to another view (from the switcher, or from a node page's run bar to Team, GitHub or Assignment) moves the focus to
  // the new view's hidden heading (docs/PRD_RUN_TEAMS.md 10); coming back from a node page to the Run view keeps the card focus above.
  const shownTab = useRef(tab)
  useEffect(() => {
    const previous = shownTab.current
    shownTab.current = tab
    if (previous === tab || selectedNodeId !== null) return
    document.getElementById('run-view-title')?.focus({ preventScroll: true })
  }, [tab, selectedNodeId])

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

  // The run-level records without a step of their own open in the sheet of the step they belong to: the attack pass on its
  // node, the multi-provider panel on the review's.
  const sheetExtras = (nodeId: string): ReactNode => {
    const node = definition.nodes.find(candidate => candidate.node_id === nodeId)
    if (!node) return null
    // The step's agent team (docs/PRD_RUN_TEAMS.md 5), before Events: a worker with a team session, another step only when its
    // session's records are found or unreadable; nothing at all when the teams were not read.
    const teamSessions = teamSessionsOf(teamsData, nodeId)
    const team = teamsData !== null && sheetShowsTeam(teamSessions, node.kind === 'worker')
      ? <SheetTeamSection teams={teamsData} sessionsOfNode={teamSessions} shared={{ scope, detail, inputs: inputsData, sessions: sessionsData, clock, live, nodeHref, onNavigate, teamHref }} />
      : null
    const extra = runRecordExtras(node, nodeId)
    return team === null ? extra : <>{team}{extra}</>
  }
  const runRecordExtras = (node: (typeof definition.nodes)[number], nodeId: string): ReactNode => {
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
          <ProviderPanelBody record={panels} onRetry={reloadPanels} links={{ nodeHref, onNavigate }} />
        </section>
      )
    }
    return null
  }
  const attentionWord = attention?.top ? `${TONE_LABEL.warn.toLowerCase()}: ${attention.top.kind === 'question' ? 'a question waits' : attention.top.kind === 'pane' ? 'a pane needs attention' : 'an approval waits'}` : null
  const views = <RunViews scope={scope} current={tab} suffixes={{ team: teamSuffix(teamsData), github: githubSuffix(runGithubData) }} onNavigate={onNavigate} />
  const identity = <IdentityLine detail={detail} inputs={inputs} onRetryInputs={reloadInputs} current={current} freshness={freshness} clock={clock} tone={tone} attentionWord={attentionWord} views={views} />
  const viewTitle = (label: string) => <h2 id="run-view-title" className="visually-hidden" tabIndex={-1}>{label}</h2>
  const zoneProps = { clock, zone, live }

  return (
    <div className="run-view" data-testid="run-view" data-run-id={summary.run_id} data-run-status={summary.status}>
      {selectedNodeId === null && tab === 'run' && (
        <div className="sb-run">
          {identity}
          {viewTitle('Run')}
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
            sessions={sessionsData}
            panels={panels.status === 'ready' ? panels.data : null}
            nodeHref={nodeHref}
            onNavigate={onNavigate}
            sheetExtras={sheetExtras}
            teams={teamsData}
            teamHref={teamHref}
            onSheetNode={setSheetNode}
          />
          {sessionsData && (
            <>
              <NightShiftCount sessions={sessionsData} nodeHref={nodeHref} nodeLabel={nodeLabel} onNavigate={onNavigate} />
              <SessionsSection sessions={sessionsData} nodeHref={nodeHref} onNavigate={onNavigate} teams={teamsData} teamHref={teamHref} />
            </>
          )}
        </div>
      )}

      {selectedNodeId === null && tab === 'team' && (
        <>
          {identity}
          <GlyphDefs />
          <div className="run-views">
            {viewTitle('Team')}
            <TeamView
              scope={scope}
              detail={detail}
              inputs={inputs}
              sessions={sessionsData}
              teams={teams}
              teamsMeta={teamsMeta}
              onRetryTeams={reloadTeams}
              review={reviewData}
              now={now}
              {...zoneProps}
              query={teamQuery ?? EMPTY_TEAM_QUERY}
              onQuery={onTeamQuery}
              nodeHref={nodeHref}
              onNavigate={onNavigate}
              onAnnounce={onAnnounce}
            />
          </div>
        </>
      )}

      {selectedNodeId === null && tab === 'github' && (
        <>
          {identity}
          <GlyphDefs />
          <div className="run-views">
            {viewTitle('GitHub')}
            <GithubView
              scope={scope}
              detail={detail}
              inputs={inputs}
              sessions={sessionsData}
              teams={teamsData}
              runGithub={runGithub}
              runGithubMeta={runGithubMeta}
              onRetryRunGithub={reloadRunGithub}
              review={reviewData}
              now={now}
              {...zoneProps}
              nodeHref={nodeHref}
              onNavigate={onNavigate}
              onAnnounce={onAnnounce}
            />
          </div>
        </>
      )}

      {selectedNodeId === null && tab === 'assignment' && (
        <>
          {identity}
          <GlyphDefs />
          <div className="run-views">
            {viewTitle('Assignment')}
            <AssignmentPanel scope={scope} inputs={inputs} review={reviewData} onRetry={reloadInputs} onNavigate={onNavigate} panelId="run-panel-assignment" labelledBy="run-view-title" />
          </div>
        </>
      )}

      {selectedNodeId !== null && (
        <>
          <RunBar detail={detail} now={now} clock={clock} runHref={runHref} views={<RunViews scope={scope} current={null} plain onNavigate={onNavigate} />} freshness={freshness} onNavigate={onNavigate} />
          <div className="run-views">
            <div className="run-body">
              <StepStrip detail={detail} rows={rows} current={selectedNodeId} runHref={runHref} nodeHref={nodeHref} verdicts={verdicts} onNavigate={onNavigate} />
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
                    sessions={sessions}
                    teams={teams}
                    onRetryTeams={reloadTeams}
                    teamHref={teamHref}
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

      {/* The Run view's dock holds the Controls dialog; the other views and the node pages hold it here, so the Controls menu,
          the lane head's and the node page's "Send a note to the lead" (docs/PRD_RUN_TEAMS.md 7) open the same dialog. */}
      {(selectedNodeId !== null || tab !== 'run') && <ControlDialogHost scope={scope} questions={offViewQuestions} />}
    </div>
  )
}
