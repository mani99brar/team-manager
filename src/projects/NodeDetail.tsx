import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { attemptResultUris, type Now, type Timeline } from '../../contracts/projects/triage.ts'
import { scopedResultPath, type RunDetail, type RunInputs, type ReviewResult, type RunScope, type WorkerResult, type WorkflowEvent } from './api.ts'
import { ChallengeSections } from './node/ChallengeSections.tsx'
import { AwaitingNotice, ControllerSections } from './node/ControllerSections.tsx'
import { attemptStrip, nodeTiming, resultRole, verifiedSections, workerSectionEntries, type SectionEntry } from './node/model.ts'
import { ReviewSections } from './node/ReviewSections.tsx'
import { CandidateLanes, VerifiedEvidence, WorkerReportLink, type LaneEntry } from './node/VerifySections.tsx'
import { WorkerSections } from './node/WorkerSections.tsx'
import { NodeHeader } from './NodeHeader.tsx'
import { AppLink, ErrorPanel, LoadingPanel, StatusBadge } from './panels.tsx'
import { attemptPathname, runPathname } from './routes.ts'
import { NodeSection, SectionIndex } from './SectionIndex.tsx'
import { isChallengeNode } from './status.ts'
import { Time } from './Time.tsx'
import type { Resource } from './useResource.ts'
import { useRunResult, useRunResults } from './useRunData.ts'
import './node.css'

type DefinitionNode = RunDetail['definition']['nodes'][number]
type SnapshotNode = RunDetail['snapshot']['nodes'][number]
type ReviewTransport = ReviewResult['reviewer']['transport']

type Props = {
  scope: RunScope
  detail: RunDetail
  definition: DefinitionNode
  node: SnapshotNode
  /** The attempt the path names (`/attempts/<k>`); null shows the latest. */
  attempt: number | null
  events: Resource<WorkflowEvent[]>
  onRetryEvents: () => void
  /** The run's inputs (null once loaded when the export predates them), shared by every node of the run. */
  inputs: Resource<RunInputs | null>
  onRetryInputs: () => void
  /** The run's timeline, once its events loaded: the header's times, attempts and markers. */
  timeline: Timeline | null
  /** The run's situation, once derived: its next step is repeated on the focus node. */
  now: Now | null
  clock: number
  refreshToken: number
  onNavigate: (pathname: string) => void
  /** A requirement quote to highlight in this node's task, handed over by a review finding link. */
  highlight: string | null
  onHighlightApplied: () => void
  onOpenRequirement: (nodeId: string, quote: string) => void
  /** A captured file to scroll to on this launch node, handed over by a review finding's file link. */
  fileFocus: string | null
  onFileFocusApplied: () => void
  onOpenFile: (nodeId: string, path: string) => void
}

/**
 * One node of a run (docs/PRD_VIEWER_UX.md 4.4-4.9): the header (status by cause, timing, attempts, next step), a section
 * index with counts, then the sections of its kind (worker, verification, candidate, review, challenge or the controller's
 * own steps) and History, always last. Empty sections are absent; a result the launch and verify nodes share is said once.
 * An earlier attempt's page shows that attempt's own result under a banner that leads back to the latest.
 */
export function NodeDetail({ scope, detail, definition, node, attempt, events, onRetryEvents, inputs, onRetryInputs, timeline, now, clock, refreshToken, onNavigate, highlight, onHighlightApplied, onOpenRequirement, fileFocus, onFileFocusApplied, onOpenFile }: Props) {
  const definitionNodes = detail.definition.nodes
  const snapshotNodes = detail.snapshot.nodes
  // A review's executor wording depends on the transport its served result records, known once the review panel loads it.
  const [reviewTransport, setReviewTransport] = useState<ReviewTransport | undefined>(undefined)

  const isWorker = definition.kind === 'worker'
  const isChallenge = isChallengeNode(definition)
  const isReview = definition.kind === 'review' && !isChallenge
  const isCandidate = node.node_id === 'candidate'
  const isVerify = definition.kind === 'verification' && !isCandidate
  const isController = definition.kind === 'prepare' || definition.kind === 'integration'
  const latest = node.attempt
  const isLatest = attempt === null || attempt === latest
  const shownAttempt = attempt ?? latest
  const recorded = shownAttempt >= 1 && shownAttempt <= latest

  // What this view reads: the latest attempt's result as served, or the viewed attempt's own (`results/<lane>/<k>`).
  const attemptUris = useMemo(() => attemptResultUris(detail, node.node_id), [detail, node.node_id])
  const resultUri = definition.kind === 'review' ? null
    : isLatest || !isVerify ? node.result_uri
      : attemptUris.find(item => item.attempt === attempt)?.uri ?? null
  const lanes: LaneEntry[] = isLatest || !isCandidate ? node.lane_results
    : attemptUris.filter(item => item.attempt === attempt).map(item => ({ worker: item.lane, attempt: item.attempt, result_uri: item.uri }))
  const resultPath = resultUri === null ? null : scopedResultPath(scope, resultUri)
  const stamp = String(refreshToken)
  const { state: result, reload: reloadResult } = useRunResult(scope, resultPath, stamp)
  const resultData = result.status === 'ready' ? result.data : null

  // The attempt strip: a chip shows once one of its results loaded (read through the run's cache, asked again on new events).
  const strip = useMemo(() => (timeline ? attemptStrip(detail, timeline, node.node_id) : []), [detail, timeline, node.node_id])
  const chipUris = useMemo(() => strip.flatMap(item => (item.kind === 'attempt' ? item.chip.uris : [])), [strip])
  const { results: chipResults } = useRunResults(scope, chipUris, `${refreshToken}:${detail.snapshot.last_sequence}`)
  const loaded = useCallback((uri: string) => chipResults.has(uri), [chipResults])
  const viewedChip = strip.flatMap(item => (item.kind === 'attempt' && item.chip.attempt === shownAttempt ? [item.chip] : []))[0]

  // The candidate's own verdict is its lanes': a failing lane's gate reasons are the cause its header names.
  const { results: laneResults } = useRunResults(scope, useMemo(() => lanes.map(entry => entry.result_uri), [lanes]), stamp)
  const failure = lanes.flatMap(entry => {
    const error = laneResults.get(entry.result_uri)?.error
    return error ? [`${entry.worker}: ${error.message}`] : []
  }).join('; ') || null

  const nodeEvents = events.status === 'ready' ? events.data.filter(event => event.node_id === node.node_id) : []
  const reuse = nodeEvents.filter(event => event.type === 'result_reused')
  const approvals = nodeEvents.filter(event => event.type === 'approval_requested')

  const recordedInputs = inputs.status === 'ready' ? inputs.data : null
  const worker = isWorker && recordedInputs !== null ? recordedInputs.workers.find(candidate => candidate.launch_node_id === node.node_id) ?? null : null
  // The design challenge is also of kind review; the independent review is the other one.
  const reviewNode = snapshotNodes.find(candidate => candidate.kind === 'review' && !isChallengeNode(candidate)) ?? null
  const hasNode = (nodeId: string) => definitionNodes.some(candidate => candidate.node_id === nodeId)
  const nodeLink = (nodeId: string) => ({ node_id: nodeId, href: runPathname(scope.projectId, scope.workflowId, scope.runId, nodeId), label: definitionNodes.find(candidate => candidate.node_id === nodeId)!.label })
  const launchNodeOf = (lane: string) => {
    const launched = recordedInputs?.workers.find(candidate => candidate.node_id === lane)?.launch_node_id
    const id = launched && hasNode(launched) ? launched : hasNode(`launch_${lane}`) ? `launch_${lane}` : null
    return id === null ? null : nodeLink(id)
  }
  const lane = isWorker ? worker?.node_id ?? node.node_id.replace(/^launch_/, '') : null
  const verifyNode = lane !== null && hasNode(`verify_${lane}`) ? nodeLink(`verify_${lane}`) : null
  const role = resultRole(detail, node.node_id)
  const reportNode = isVerify && !role.narrative && role.partner !== null ? nodeLink(role.partner) : null
  const repairs = (timeline?.markers ?? []).filter(marker => marker.kind === 'repair' && verifyNode !== null && marker.node_id === verifyNode.node_id)
  const repairNote = repairs.length ? `after operator ${repairs.map(marker => `repair ${marker.repair?.n ?? ''}`.trim()).join(', ')}` : ''

  const timing = timeline && recorded ? nodeTiming(timeline, node.node_id, isLatest ? null : attempt, isVerify ? resultData : null) : null
  const headerStatus = isLatest ? node.status : viewedChip?.status ?? resultData?.status ?? 'pending'
  const next = isLatest && now?.focus?.node_id === node.node_id && (now.next.steps.length > 0 || now.next.action === 'required') ? now.next : null
  const attemptHref = (value: number) => attemptPathname(scope.projectId, scope.workflowId, scope.runId, node.node_id, value)
  const nodeHref = runPathname(scope.projectId, scope.workflowId, scope.runId, node.node_id)

  const renderResult = (evidence: (data: WorkerResult) => ReactNode) => (
    <>
      {resultUri === null && lanes.length === 0 && <p className="projects-muted" data-testid="result-none">No result has been published for this node{node.attempt === 0 ? ' (it has not started)' : ''}.</p>}
      {resultUri !== null && resultPath === null && (
        <p className="projects-error-inline" role="alert" data-testid="result-unscoped">
          The result link <code>{resultUri}</code> is outside this run's results route and was not fetched.
        </p>
      )}
      {resultPath !== null && result.status === 'loading' && <LoadingPanel>Loading the result…</LoadingPanel>}
      {resultPath !== null && result.status === 'error' && <ErrorPanel error={result.error} what="The node result" onRetry={reloadResult} />}
      {resultPath !== null && result.status === 'ready' && evidence(result.data)}
    </>
  )

  // The section index: what the kind lists, only when it lists something, then reuse (only with reuse events) and History.
  const sections: SectionEntry[] = [
    ...(isWorker ? workerSectionEntries(worker, resultData) : []),
    ...(isCandidate && lanes.length > 0 ? [{ key: 'lanes', label: 'Lanes', count: lanes.length }] : []),
    ...((isVerify || isCandidate) && resultData !== null ? verifiedSections(resultData) : []),
    ...(isReview ? [{ key: 'review', label: 'Review' }] : []),
    ...(isChallenge ? [{ key: 'challenge', label: 'Challenge' }] : []),
    ...(reuse.length > 0 ? [{ key: 'reuse', label: 'Reuse', count: reuse.length }] : []),
    { key: 'history', label: 'History', ...(events.status === 'ready' ? { count: nodeEvents.length } : {}) },
  ]
  // An earlier attempt keeps only a verification's own result; any other step's earlier attempt shows its times and History.
  const evidence = isLatest || (recorded && (isVerify || isCandidate))

  return (
    <section className="node-detail" aria-labelledby="node-detail-title" data-testid="node-detail" data-node-id={node.node_id} data-attempt={isLatest ? undefined : shownAttempt}>
      <NodeHeader
        definition={definition}
        status={headerStatus}
        attempt={shownAttempt}
        timing={timing}
        clock={clock}
        events={nodeEvents}
        timeline={timeline}
        result={resultData}
        failure={failure}
        reviewTransport={reviewTransport}
        verifyNode={verifyNode}
        strip={strip}
        loaded={loaded}
        attemptHref={attemptHref}
        next={next}
        onNavigate={onNavigate}
      />

      {!isLatest && (
        <p className="projects-notice attempt-banner" role="note" data-testid="attempt-banner">
          {recorded ? `You are viewing attempt ${attempt} of ${latest}. ` : `Attempt ${attempt} of this step was not recorded. `}
          <AppLink href={nodeHref} onNavigate={onNavigate}>{latest === 0 ? 'Open the step ›' : `The latest is attempt ${latest} ›`}</AppLink>
        </p>
      )}

      {isLatest && node.status === 'awaiting_approval' && <AwaitingNotice approvals={approvals} />}

      {!isController && (isLatest || recorded) && (
        <SectionIndex label={definition.label} sections={evidence ? sections : sections.filter(section => section.key === 'history')}>
          {reportNode && <WorkerReportLink href={reportNode.href} label={reportNode.label} onNavigate={onNavigate} />}
        </SectionIndex>
      )}

      {!evidence && recorded && <p className="projects-muted" data-testid="attempt-latest-only">Only the latest attempt's evidence is kept for this step; the times above are this attempt's.</p>}

      {evidence && (
        isWorker ? (
          <WorkerSections
            scope={scope}
            renderResult={renderResult}
            result={result}
            role={role}
            checksNode={verifyNode}
            repairNote={repairNote}
            inputs={inputs}
            onRetryInputs={onRetryInputs}
            worker={worker}
            reviewNode={reviewNode}
            refreshToken={refreshToken}
            onNavigate={onNavigate}
            highlight={highlight}
            onHighlightApplied={onHighlightApplied}
            fileFocus={fileFocus}
            onFileFocusApplied={onFileFocusApplied}
          />
        ) : isChallenge ? (
          <ChallengeSections inputs={inputs} onRetryInputs={onRetryInputs} />
        ) : isReview ? (
          <ReviewSections
            scope={scope}
            node={node}
            definitionNodes={definitionNodes}
            snapshotNodes={snapshotNodes}
            inputs={inputs}
            refreshToken={refreshToken}
            onNavigate={onNavigate}
            onOpenRequirement={onOpenRequirement}
            onOpenFile={onOpenFile}
            onTransport={setReviewTransport}
          />
        ) : isController ? (
          <ControllerSections scope={scope} renderResult={renderResult} />
        ) : (
          <>
            {lanes.length > 0 && <CandidateLanes scope={scope} lanes={lanes} launchNodeOf={launchNodeOf} stamp={stamp} onNavigate={onNavigate} />}
            {renderResult(data => <VerifiedEvidence scope={scope} result={data} phase="worker" anchored />)}
          </>
        )
      )}

      {reuse.length > 0 && (
        <NodeSection sectionKey="reuse" title="Reuse evidence">
          <ul className="evidence-list" data-testid="reuse-list">
            {reuse.map(event => (
              <li key={event.event_id}>
                Attempt {event.attempt} reused the result of attempt {event.reused_from_attempt ?? 'unknown'} (event {event.sequence}, <Time iso={event.occurred_at} seconds />): {event.message}
              </li>
            ))}
          </ul>
        </NodeSection>
      )}

      <NodeSection sectionKey="history" title="History">
        {events.status === 'loading' && <LoadingPanel>Loading events…</LoadingPanel>}
        {events.status === 'error' && <ErrorPanel error={events.error} what="The run events" onRetry={onRetryEvents} />}
        {events.status === 'ready' && (nodeEvents.length === 0 ? (
          <p className="projects-muted" data-testid="events-none">No events reference this node.</p>
        ) : (
          <ol className="event-list" data-testid="node-events">
            {nodeEvents.map(event => (
              <li key={event.event_id} data-attempt={event.attempt}>
                <span className="event-seq">#{event.sequence}</span> <span className="projects-muted"><Time iso={event.occurred_at} seconds /></span>{' '}
                <span className="event-type">{event.type.replace(/_/g, ' ')}</span>
                {event.status && <> · <StatusBadge status={event.status} /></>}
                {event.attempt > 0 && <> · attempt {event.attempt}</>}
                {event.message && <> — {event.message}</>}
                {event.artifact && <> · artifact <code>{event.artifact.artifact_id}</code> ({event.artifact.kind})</>}
              </li>
            ))}
          </ol>
        ))}
      </NodeSection>
    </section>
  )
}
