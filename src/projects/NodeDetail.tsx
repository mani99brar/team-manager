import { useCallback, useState, type ReactNode } from 'react'
import {
  fetchArtifactText,
  fetchWorkerResult,
  paths,
  scopedResultPath,
  type RunDetail,
  type RunInputs,
  type ReviewResult,
  type RunScope,
  type WorkerResult,
  type WorkflowEvent,
} from './api.ts'
import { CreatedFiles } from './CreatedFiles.tsx'
import { AppLink, ErrorPanel, LoadingPanel, StatusBadge } from './panels.tsx'
import { ReviewPanel } from './ReviewDetail.tsx'
import { runPathname } from './routes.ts'
import { executorCategory, executorOf, formatTime, KIND_LABEL, nodeStatusMeaning, STATUS_LABEL } from './status.ts'
import { useResource, type Resource } from './useResource.ts'
import { LaunchReceipt, StopLine, TaskPanel, WorkerSignals } from './WorkerInputs.tsx'

type DefinitionNode = RunDetail['definition']['nodes'][number]
type SnapshotNode = RunDetail['snapshot']['nodes'][number]
type ReviewTransport = ReviewResult['reviewer']['transport']

type Props = {
  scope: RunScope
  definition: DefinitionNode
  /** Every node of the pinned definition, so review findings can link to the lanes' launch nodes. */
  definitionNodes: DefinitionNode[]
  /** Every node's state in the run, so a launch node can find the review and a review can find the launch nodes' files. */
  snapshotNodes: SnapshotNode[]
  node: SnapshotNode
  events: Resource<WorkflowEvent[]>
  onRetryEvents: () => void
  /** The run's inputs (null once loaded when the export predates them), shared by every node of the run. */
  inputs: Resource<RunInputs | null>
  onRetryInputs: () => void
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

function shortSha(value: string | null): string {
  return value === null ? 'none' : value.slice(0, 12)
}

/** Text-like artifact kinds are shown as plain text on demand; screenshots are images; anything else is only listed. */
function TextArtifact({ scope, artifactId }: { scope: RunScope; artifactId: string }) {
  const [open, setOpen] = useState(false)
  const load = useCallback((signal: AbortSignal) => fetchArtifactText(scope, artifactId, signal), [scope, artifactId])
  const { state, reload } = useResource(open ? `artifact:${artifactId}` : null, load)
  return (
    <div className="artifact-text">
      <button type="button" className="button button-small" aria-expanded={open} onClick={() => setOpen(previous => !previous)}>
        {open ? 'Hide contents' : 'Show contents'}
      </button>
      {open && state.status === 'loading' && <LoadingPanel>Loading artifact {artifactId}…</LoadingPanel>}
      {open && state.status === 'error' && <ErrorPanel error={state.error} what={`Artifact ${artifactId}`} onRetry={reload} />}
      {open && state.status === 'ready' && (
        state.data.length === 0
          ? <p className="projects-muted">This artifact is empty.</p>
          : <pre className="artifact-log" data-testid={`artifact-text:${artifactId}`} tabIndex={0}>{state.data}</pre>
      )}
    </div>
  )
}

function ScreenshotArtifact({ scope, artifactId }: { scope: RunScope; artifactId: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <p className="projects-error-inline" role="alert">Screenshot {artifactId} could not be loaded from the artifact route.</p>
  return (
    <img
      className="artifact-screenshot"
      src={paths.artifact(scope, artifactId)}
      alt={`Screenshot artifact ${artifactId}`}
      data-testid={`artifact-screenshot:${artifactId}`}
      onError={() => setFailed(true)}
    />
  )
}

/** The facts that anchor a result to its snapshot, shown on both the launch and the verify node: status, attempt, session, commits, summary, error, assumptions. */
function ResultFacts({ result, node }: { result: WorkerResult; node: SnapshotNode }) {
  return (
    <>
      <dl className="projects-facts">
        <div><dt>Result status</dt><dd><StatusBadge status={result.status} /></dd></div>
        <div><dt>Result attempt</dt><dd>{result.attempt}{result.attempt !== node.attempt ? ` (graph node attempt is ${node.attempt})` : ''}</dd></div>
        <div><dt>Session</dt><dd><code>{result.session_id}</code></dd></div>
        <div><dt>Base commit</dt><dd><code>{shortSha(result.base_commit)}</code></dd></div>
        <div><dt>Output commit</dt><dd>{result.output_commit ? <code>{shortSha(result.output_commit)}</code> : 'None recorded (no durable output commit)'}</dd></div>
      </dl>
      <p className="worker-summary" data-testid="worker-summary">{result.summary}</p>
      {result.error && (
        <div className="projects-error" role="alert" data-testid="worker-error">
          <p><strong>Error {result.error.code}:</strong> {result.error.message}</p>
          <p>{result.error.retryable ? 'Marked retryable by the producer. Retrying is done through the workflow CLI, not this viewer.' : 'Marked not retryable by the producer.'}</p>
        </div>
      )}
      <section className="evidence-section" aria-labelledby="evidence-assumptions">
        <h4 id="evidence-assumptions">Open assumptions</h4>
        {result.open_assumptions.length === 0 ? (
          <p className="projects-muted" data-testid="assumptions-empty">No open assumptions were recorded.</p>
        ) : (
          <ul className="evidence-list" data-testid="assumptions">
            {result.open_assumptions.map((assumption, index) => <li key={index}>{assumption}</li>)}
          </ul>
        )}
      </section>
    </>
  )
}

/** What the worker produced, on its launch node: the result facts and the files it created or changed, as captured at freeze. */
function ProducedEvidence({ scope, result, node, reviewNode, refreshToken, focusPath, onFocusApplied }: {
  scope: RunScope
  result: WorkerResult
  node: SnapshotNode
  reviewNode: SnapshotNode | null
  refreshToken: number
  focusPath: string | null
  onFocusApplied: () => void
}) {
  return (
    <div className="worker-evidence" data-testid="worker-result" data-view="produced">
      <ResultFacts result={result} node={node} />
      <CreatedFiles scope={scope} result={result} reviewNode={reviewNode} refreshToken={refreshToken} focusPath={focusPath} onFocusApplied={onFocusApplied} />
    </div>
  )
}

/**
 * What the trusted verifier proved, on a verify node and for each lane of the combined candidate: the result facts, the
 * gate with its deferred checks, the checks with their logs, screenshots, other artifacts and the ownership outcome.
 * Captured files are the launch node's; they are not repeated here.
 */
function VerifiedEvidence({ scope, result, node, phase, testId = 'worker-result' }: { scope: RunScope; result: WorkerResult; node: SnapshotNode; phase: 'worker' | 'candidate'; testId?: string }) {
  const artifactsById = new Map(result.artifacts.map(artifact => [artifact.artifact_id, artifact]))
  const checkLogs = new Set(result.checks.map(check => check.log_artifact_id))
  const screenshots = result.artifacts.filter(artifact => artifact.kind === 'screenshot')
  // Check logs are shown with their check and captured files on the launch node; everything else that is not a screenshot is listed here.
  const others = result.artifacts.filter(artifact => artifact.kind !== 'screenshot' && artifact.kind !== 'file' && !checkLogs.has(artifact.artifact_id))
  // Checks the gate recorded on this isolated snapshot but gates only at the combined candidate (build, browser).
  const deferred = new Map((result.deferred_checks ?? []).map(entry => [entry.check_index, entry.id]))
  const passed = result.status === 'succeeded' && result.error === null
  return (
    <div className="worker-evidence" data-testid={testId} data-view="verified">
      <ResultFacts result={result} node={node} />

      <section className="evidence-section" aria-labelledby={`${testId}-gate`} data-testid="gate-outcome" data-passed={passed ? 'true' : 'false'}>
        <h4 id={`${testId}-gate`}>Gate</h4>
        <p>
          {passed
            ? `Passed: every gating check of this ${phase === 'worker' ? 'isolated lane snapshot' : 'combined candidate'} exited 0.`
            : 'Did not pass: see the error above for the reasons the gate recorded.'}
        </p>
        {deferred.size > 0 && (
          <p className="projects-notice-inline" data-testid="deferred-checks">
            Deferred checks: {[...deferred.values()].join(', ')} — executed and recorded on this isolated lane snapshot, but gated only at the combined candidate, which verifies the whole application.
          </p>
        )}
        <p className="projects-muted" data-testid="ownership-outcome">
          {phase === 'candidate'
            ? 'Ownership: enforced on each lane\'s isolated snapshot, not on the combined candidate.'
            : passed
              ? 'Ownership: the verifier checked the changed files against the lane\'s owned paths on this snapshot, and the gate passed.'
              : 'Ownership: checked on this snapshot; an ownership violation, if there was one, is among the reasons in the error above.'}
        </p>
      </section>

      <section className="evidence-section" aria-labelledby={`${testId}-checks`}>
        <h4 id={`${testId}-checks`}>Checks actually executed</h4>
        {result.checks.length === 0 ? (
          <p className="projects-muted" data-testid="checks-empty">No checks were recorded for this result.</p>
        ) : (
          <ul className="evidence-list" data-testid="checks-list">
            {result.checks.map((check, index) => {
              const log = artifactsById.get(check.log_artifact_id)
              const isDeferred = deferred.has(index)
              const exitText = check.exit_code === 0 ? 'exit 0' : `exit ${check.exit_code}`
              return (
                <li key={`${check.log_artifact_id}-${index}`} id={`check-${index}`} tabIndex={-1} className={isDeferred ? 'check check-deferred' : check.exit_code === 0 ? 'check check-passed' : 'check check-failed'} data-exit-code={check.exit_code} data-deferred={isDeferred ? 'true' : undefined}>
                  <div className="check-head">
                    <code className="check-command">{check.command}</code>
                    <span className="check-exit">{isDeferred ? `${exitText} · recorded, gated at the combined candidate` : check.exit_code === 0 ? exitText : `${exitText} (failed)`}</span>
                  </div>
                  <p className="projects-muted check-meta">
                    {formatTime(check.started_at)} → {formatTime(check.finished_at)} · cwd <code>{check.cwd}</code>
                  </p>
                  <div className="check-log">
                    <span>Log artifact <code>{check.log_artifact_id}</code>{log ? '' : ' (not listed among the result artifacts)'}</span>
                    {log && <TextArtifact scope={scope} artifactId={log.artifact_id} />}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="evidence-section" aria-labelledby={`${testId}-screenshots`}>
        <h4 id={`${testId}-screenshots`}>Screenshots</h4>
        {screenshots.length === 0 && deferred.size > 0 ? (
          <p className="projects-muted" data-testid="screenshots-deferred">No screenshot artifacts were published for this isolated lane run; browser evidence is gated and shown at the combined candidate.</p>
        ) : screenshots.length === 0 ? (
          <p className="projects-muted" data-testid="screenshots-empty">No screenshot artifacts were published.</p>
        ) : (
          <ul className="evidence-list evidence-screenshots" data-testid="screenshots">
            {screenshots.map(artifact => (
              <li key={artifact.artifact_id}>
                <p><code>{artifact.artifact_id}</code> <span className="projects-muted">sha256 {artifact.sha256.slice(0, 12)}…</span></p>
                <ScreenshotArtifact scope={scope} artifactId={artifact.artifact_id} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="evidence-section" aria-labelledby={`${testId}-artifacts`}>
        <h4 id={`${testId}-artifacts`}>Other artifacts</h4>
        {others.length === 0 ? (
          <p className="projects-muted">No artifacts beyond the check logs, screenshots and captured files were published.</p>
        ) : (
          <ul className="evidence-list" data-testid="artifacts">
            {others.map(artifact => (
              <li key={artifact.artifact_id}>
                <p><code>{artifact.artifact_id}</code> · {artifact.kind} · <span className="projects-muted">sha256 {artifact.sha256.slice(0, 12)}…</span></p>
                {artifact.kind === 'other'
                  ? <p className="projects-muted">Not rendered: only logs, reports, patches and screenshots are displayed.</p>
                  : <TextArtifact scope={scope} artifactId={artifact.artifact_id} />}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

/** One lane's result of the combined candidate, fetched through the run's scoped results route like any worker result. */
function LaneResult({ scope, node, lane, launchNodeId, refreshToken, onNavigate }: {
  scope: RunScope
  node: SnapshotNode
  lane: SnapshotNode['lane_results'][number]
  /** The graph node that launched the lane, which shows the files it created; null when the pinned graph has none. */
  launchNodeId: string | null
  refreshToken: number
  onNavigate: (pathname: string) => void
}) {
  const resultPath = scopedResultPath(scope, lane.result_uri)
  const load = useCallback((signal: AbortSignal) => fetchWorkerResult(scope, resultPath!, signal), [scope, resultPath])
  const { state, reload } = useResource(resultPath, load, refreshToken)
  return (
    <section className="lane-result" aria-label={`Lane ${lane.worker}`} data-testid={`lane-result:${lane.worker}`}>
      <h5>Lane {lane.worker} <span className="projects-muted">· candidate attempt {lane.attempt}</span></h5>
      {launchNodeId !== null && (
        <p className="projects-muted" data-testid="lane-files-link">
          Files are captured on the lane's worker snapshot only:{' '}
          <AppLink href={runPathname(scope.projectId, scope.workflowId, scope.runId, launchNodeId)} onNavigate={onNavigate}>open the files the {lane.worker} lane created or changed</AppLink>.
        </p>
      )}
      {resultPath === null && (
        <p className="projects-error-inline" role="alert">The result link <code>{lane.result_uri}</code> is outside this run's results route and was not fetched.</p>
      )}
      {resultPath !== null && state.status === 'loading' && <LoadingPanel>Loading the {lane.worker} lane result…</LoadingPanel>}
      {resultPath !== null && state.status === 'error' && <ErrorPanel error={state.error} what={`The ${lane.worker} lane result`} onRetry={reload} />}
      {resultPath !== null && state.status === 'ready' && <VerifiedEvidence scope={scope} result={state.data} node={node} phase="candidate" testId={`lane-result-evidence:${lane.worker}`} />}
    </section>
  )
}

/** The pinned task behind a disclosure, closed by default and opened when a finding link hands over a quote to highlight. */
function TaskDisclosure({ highlight, children }: { highlight: string | null; children: ReactNode }) {
  const [open, setOpen] = useState(highlight !== null)
  return (
    <details className="evidence-section task-details" data-testid="task-details" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>Task: what this worker was asked to do</summary>
      {children}
    </details>
  )
}

/**
 * Everything known about one node of a run: state, executor, reuse evidence, result and events. Absent evidence is stated.
 * A launch node shows what the worker produced first (result facts and created files), then its completion signal, launch
 * receipt and the task behind a disclosure; a verify node shows what the verifier proved (gate, checks, screenshots); a
 * review node's Result is the recorded review verdict.
 */
export function NodeDetail({ scope, definition, definitionNodes, snapshotNodes, node, events, onRetryEvents, inputs, onRetryInputs, refreshToken, onNavigate, highlight, onHighlightApplied, onOpenRequirement, fileFocus, onFileFocusApplied, onOpenFile }: Props) {
  const resultPath = node.result_uri === null || definition.kind === 'review' ? null : scopedResultPath(scope, node.result_uri)
  const loadResult = useCallback((signal: AbortSignal) => fetchWorkerResult(scope, resultPath!, signal), [scope, resultPath])
  const { state: result, reload: reloadResult } = useResource(resultPath, loadResult, refreshToken)
  // A review's executor wording depends on the transport its served result records, known once the review panel loads it.
  const [reviewTransport, setReviewTransport] = useState<ReviewTransport | undefined>(undefined)

  const nodeEvents = events.status === 'ready' ? events.data.filter(event => event.node_id === node.node_id) : []
  const reuse = nodeEvents.filter(event => event.type === 'result_reused')
  const approvals = nodeEvents.filter(event => event.type === 'approval_requested')

  const isWorker = definition.kind === 'worker'
  const isReview = definition.kind === 'review'
  const recordedInputs = inputs.status === 'ready' ? inputs.data : null
  const worker = isWorker && recordedInputs !== null ? recordedInputs.workers.find(candidate => candidate.launch_node_id === node.node_id) ?? null : null
  const receiptSession = worker?.launch?.session_id ?? null
  const reviewNode = snapshotNodes.find(candidate => candidate.kind === 'review') ?? null
  const hasNode = (nodeId: string) => definitionNodes.some(candidate => candidate.node_id === nodeId)
  const launchNodeOf = (lane: string) => {
    const launched = recordedInputs?.workers.find(candidate => candidate.node_id === lane)?.launch_node_id
    if (launched) return launched
    return hasNode(`launch_${lane}`) ? `launch_${lane}` : null
  }
  const verifyNodeId = worker !== null && hasNode(`verify_${worker.node_id}`) ? `verify_${worker.node_id}` : null

  const resultBody = (evidence: (data: WorkerResult) => ReactNode) => (
    <>
      {node.result_uri === null && node.lane_results.length === 0 && <p className="projects-muted" data-testid="result-none">No result has been published for this node{node.attempt === 0 ? ' (it has not started)' : ''}.</p>}
      {node.result_uri !== null && resultPath === null && (
        <p className="projects-error-inline" role="alert" data-testid="result-unscoped">
          The result link <code>{node.result_uri}</code> is outside this run's results route and was not fetched.
        </p>
      )}
      {resultPath !== null && result.status === 'loading' && <LoadingPanel>Loading the result…</LoadingPanel>}
      {resultPath !== null && result.status === 'error' && <ErrorPanel error={result.error} what="The node result" onRetry={reloadResult} />}
      {resultPath !== null && result.status === 'ready' && evidence(result.data)}
    </>
  )

  const reuseSection = (
    <section className="evidence-section" aria-labelledby="node-reuse">
      <h4 id="node-reuse">Reuse evidence</h4>
      {events.status === 'loading' && <LoadingPanel>Loading events…</LoadingPanel>}
      {events.status === 'error' && <p className="projects-muted">Events could not be loaded, so reuse cannot be determined.</p>}
      {events.status === 'ready' && (reuse.length === 0 ? (
        <p className="projects-muted" data-testid="reuse-none">No reuse evidence recorded: the attempts shown are this node's own graph attempts, not reused results.</p>
      ) : (
        <ul className="evidence-list" data-testid="reuse-list">
          {reuse.map(event => (
            <li key={event.event_id}>
              Attempt {event.attempt} reused the result of attempt {event.reused_from_attempt ?? 'unknown'} (event {event.sequence}, {formatTime(event.occurred_at)}): {event.message}
            </li>
          ))}
        </ul>
      ))}
    </section>
  )

  return (
    <section className="node-detail" aria-labelledby="node-detail-title" data-testid="node-detail" data-node-id={node.node_id}>
      <h3 id="node-detail-title">{definition.label} <span className="projects-muted node-detail-id">({node.node_id})</span></h3>
      <dl className="projects-facts">
        <div><dt>Kind</dt><dd>{KIND_LABEL[definition.kind]}</dd></div>
        <div><dt>Executed by</dt><dd data-testid="node-executor" data-executor={executorCategory(definition.kind)}>{executorOf(definition.kind, reviewTransport)}</dd></div>
        <div><dt>Status</dt><dd><StatusBadge status={node.status} /> <span data-testid="node-status-meaning">{nodeStatusMeaning(definition.kind, node.status)}</span></dd></div>
        <div><dt>Graph attempt</dt><dd data-testid="node-attempt">{node.attempt === 0 ? '0 (not started)' : node.attempt}</dd></div>
        <div>
          <dt>Session</dt>
          <dd>
            {node.session_id
              ? <code>{node.session_id}</code>
              : receiptSession
                ? <><code>{receiptSession}</code> <span className="projects-muted">(from the launch receipt)</span></>
                : 'No session recorded'}
          </dd>
        </div>
        <div><dt>Depends on</dt><dd>{definition.depends_on.length ? definition.depends_on.join(', ') : 'nothing'}</dd></div>
      </dl>

      {node.status === 'awaiting_approval' && (
        <div className="projects-notice" role="status" data-testid="awaiting-notice">
          <p><strong>Awaiting approval.</strong> This node is stopped at a decision that has not been recorded. Viewing does not approve it; decisions are made through the workflow CLI.</p>
          {approvals.length > 0 && (
            <ul className="evidence-list">
              {approvals.map(event => <li key={event.event_id}>Requested at {formatTime(event.occurred_at)}: {event.message}</li>)}
            </ul>
          )}
        </div>
      )}

      {isWorker ? (
        <>
          <section className="evidence-section" aria-labelledby="node-result">
            <h4 id="node-result">Result</h4>
            {resultBody(data => (
              <ProducedEvidence scope={scope} result={data} node={node} reviewNode={reviewNode} refreshToken={refreshToken} focusPath={fileFocus} onFocusApplied={onFileFocusApplied} />
            ))}
          </section>

          {(inputs.status === 'loading' || inputs.status === 'idle') && <LoadingPanel>Loading the run inputs…</LoadingPanel>}
          {inputs.status === 'error' && <ErrorPanel error={inputs.error} what="The run inputs" onRetry={onRetryInputs} />}
          {inputs.status === 'ready' && recordedInputs === null && (
            <p className="projects-muted" data-testid="worker-inputs-none">
              Inputs not recorded for this run (the export predates run inputs; re-export it with the workflow CLI), so the task, launch receipt and completion signal cannot be shown.
            </p>
          )}
          {recordedInputs !== null && worker === null && (
            <p className="projects-muted" data-testid="worker-inputs-unmatched">The run inputs list no worker launched by this node.</p>
          )}
          {worker !== null && (
            <>
              <WorkerSignals completion={worker.completion} handoff={worker.handoff} />
              <LaunchReceipt launch={worker.launch} />
              <TaskDisclosure highlight={highlight}>
                <TaskPanel
                  worker={worker}
                  result={result}
                  highlight={highlight}
                  onHighlightApplied={onHighlightApplied}
                  checksNode={verifyNodeId === null ? null : { href: runPathname(scope.projectId, scope.workflowId, scope.runId, verifyNodeId), label: definitionNodes.find(candidate => candidate.node_id === verifyNodeId)!.label }}
                  onNavigate={onNavigate}
                />
              </TaskDisclosure>
            </>
          )}
          {reuseSection}
        </>
      ) : (
        <>
          {reuseSection}
          <section className="evidence-section" aria-labelledby="node-result">
            <h4 id="node-result">{isReview ? 'Review result' : 'Result'}</h4>
            {isReview ? (
              <ReviewPanel
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
            ) : (
              <>
                {node.lane_results.length > 0 && (
                  <div className="lane-results" data-testid="lane-results">
                    <p className="projects-muted">The combined candidate verified every lane on one revision; each lane's result, with its checks and screenshots, is shown below.</p>
                    {node.lane_results.map(lane => (
                      <LaneResult key={lane.worker} scope={scope} node={node} lane={lane} launchNodeId={launchNodeOf(lane.worker)} refreshToken={refreshToken} onNavigate={onNavigate} />
                    ))}
                  </div>
                )}
                {resultBody(data => <VerifiedEvidence scope={scope} result={data} node={node} phase="worker" />)}
              </>
            )}
          </section>
        </>
      )}

      <section className="evidence-section" aria-labelledby="node-timeline">
        <h4 id="node-timeline">Events for this node</h4>
        {events.status === 'loading' && <LoadingPanel>Loading events…</LoadingPanel>}
        {events.status === 'error' && <ErrorPanel error={events.error} what="The run events" onRetry={onRetryEvents} />}
        {events.status === 'ready' && (nodeEvents.length === 0 ? (
          <p className="projects-muted" data-testid="events-none">No events reference this node.</p>
        ) : (
          <ol className="event-list" data-testid="node-events">
            {nodeEvents.map(event => (
              <li key={event.event_id}>
                <span className="event-seq">#{event.sequence}</span> <span className="projects-muted">{formatTime(event.occurred_at)}</span>{' '}
                <span className="event-type">{event.type.replace(/_/g, ' ')}</span>
                {event.status && <> · <StatusBadge status={event.status} /></>}
                {event.attempt > 0 && <> · attempt {event.attempt}</>}
                {event.message && <> — {event.message}</>}
                {event.artifact && <> · artifact <code>{event.artifact.artifact_id}</code> ({event.artifact.kind})</>}
              </li>
            ))}
          </ol>
        ))}
        {worker !== null && <StopLine stop={worker.stop} />}
      </section>
      <p className="projects-muted node-detail-footnote">Status labels here are historical observations; “{STATUS_LABEL.succeeded}” on a worker node is not workflow completion.</p>
    </section>
  )
}
