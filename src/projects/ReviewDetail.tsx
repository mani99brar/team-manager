import { useCallback, useState } from 'react'
import {
  fetchReviewResult,
  isBlockingFinding,
  isNotRecorded,
  NOT_RECORDED,
  paths,
  scopedReviewPath,
  type ReviewFinding,
  type ReviewResult,
  type RunDetail,
  type RunInputs,
  type RunScope,
} from './api.ts'
import { AppLink, ErrorPanel, LoadingPanel } from './panels.tsx'
import { runPathname } from './routes.ts'
import { formatTime, reviewSummary, shortRevision } from './status.ts'
import { useResource, type Resource } from './useResource.ts'

type SnapshotNode = RunDetail['snapshot']['nodes'][number]
type DefinitionNode = RunDetail['definition']['nodes'][number]
type Lane = ReviewFinding['requirement_found_in'][number]
type Disposition = ReviewFinding['disposition']
type GroupBy = 'disposition' | 'worker'
type WorkerGroup = NonNullable<ReviewFinding['worker']> | 'unrecorded'

type Props = {
  scope: RunScope
  node: SnapshotNode
  definitionNodes: DefinitionNode[]
  /** The run's inputs, used only to name the graph node that launched a lane; the review itself never needs them. */
  inputs: Resource<RunInputs | null>
  refreshToken: number
  onNavigate: (pathname: string) => void
  /** Opens a worker's task with the quoted requirement highlighted (the run view navigates and hands the quote over). */
  onOpenRequirement: (nodeId: string, quote: string) => void
}

const TRANSPORT_WORDING: Record<ReviewResult['reviewer']['transport'], string> = {
  native: 'native session',
  print: 'print-mode session',
  manual: 'operator-supplied review',
}
const DISPOSITIONS: readonly Disposition[] = ['open', 'resolved', 'accepted']
const DISPOSITION_LABEL: Record<Disposition, string> = { open: 'Open', resolved: 'Resolved', accepted: 'Accepted' }
const WORKER_GROUPS: readonly WorkerGroup[] = ['ui', 'adapter', 'both', 'none', 'unrecorded']
const WORKER_LABEL: Record<WorkerGroup, string> = { ui: 'Worker ui', adapter: 'Worker adapter', both: 'Both workers', none: 'No worker (cross-cutting)', unrecorded: 'Worker not recorded' }

/** The graph node that launched a lane: from the inputs when loaded, else `launch_<lane>` when the pinned graph has it, else the lane itself. */
function launchNodeFor(lane: Lane, definitionNodes: DefinitionNode[], inputs: Resource<RunInputs | null>): string {
  if (inputs.status === 'ready' && inputs.data !== null) {
    const worker = inputs.data.workers.find(candidate => candidate.node_id === lane)
    if (worker) return worker.launch_node_id
  }
  return definitionNodes.some(candidate => candidate.node_id === `launch_${lane}`) ? `launch_${lane}` : lane
}

function FindingRow({ finding, scope, definitionNodes, inputs, onOpenRequirement }: { finding: ReviewFinding } & Omit<Props, 'node' | 'refreshToken' | 'onNavigate'>) {
  const blocking = isBlockingFinding(finding)
  return (
    <tr
      data-testid="finding"
      data-severity={finding.severity}
      data-disposition={finding.disposition}
      data-worker={finding.worker ?? 'unrecorded'}
      className={blocking ? 'finding-blocking' : undefined}
    >
      <td><span className="finding-severity">{finding.severity}</span>{blocking && <span className="visually-hidden"> (blocks integration)</span>}</td>
      <td>{finding.message}</td>
      <td>{finding.worker ?? <span className="projects-muted">not recorded</span>}</td>
      <td>
        {finding.requirement === null ? '—' : (
          <>
            <q data-testid="finding-requirement">{finding.requirement}</q>
            {finding.requirement_found_in.length === 0 ? (
              <span className="projects-muted finding-task-note" data-testid="finding-task-unlinked">not found verbatim in the task</span>
            ) : finding.requirement_found_in.map(lane => {
              const nodeId = launchNodeFor(lane, definitionNodes, inputs)
              const quote = finding.requirement!
              return (
                <AppLink
                  key={lane}
                  href={runPathname(scope.projectId, scope.workflowId, scope.runId, nodeId)}
                  onNavigate={() => onOpenRequirement(nodeId, quote)}
                  className="finding-task-link"
                  data-testid="finding-task-link"
                  data-lane={lane}
                >
                  Open in the {lane} task
                </AppLink>
              )
            })}
          </>
        )}
      </td>
    </tr>
  )
}

function ReviewResultView({ review, scope, definitionNodes, inputs, onNavigate, onOpenRequirement }: { review: ReviewResult } & Omit<Props, 'node' | 'refreshToken'>) {
  const approved = review.verdict === 'approved'
  const candidateNode = definitionNodes.some(candidate => candidate.node_id === 'candidate') ? 'candidate' : null
  const bundle = <code title={review.bundle_sha256}>{shortRevision(review.bundle_sha256)}</code>
  // Like every other artifact link, the diff is only ever fetched through this run's own artifact route by its ID.
  const diffHref = review.diff === null ? null : paths.artifact(scope, review.diff.artifact_id)
  const diffScoped = review.diff !== null && review.diff.uri === diffHref
  const [groupBy, setGroupBy] = useState<GroupBy>('disposition')
  const groups = groupBy === 'disposition'
    ? DISPOSITIONS.map(disposition => ({ key: disposition, label: DISPOSITION_LABEL[disposition], attributes: { 'data-disposition': disposition }, findings: review.findings.filter(finding => finding.disposition === disposition) }))
    : WORKER_GROUPS.map(worker => ({ key: worker, label: WORKER_LABEL[worker], attributes: { 'data-worker-group': worker }, findings: review.findings.filter(finding => (finding.worker ?? 'unrecorded') === worker) }))
  const populated = groups.filter(group => group.findings.length > 0)
  return (
    <div className="review-result" data-testid="review-result" data-verdict={review.verdict}>
      <p className="review-verdict-line">
        <span className={`status-badge ${approved ? 'status-succeeded' : 'status-failed'}`} data-testid="review-verdict" data-status={review.verdict}>
          <span>{approved ? 'Approved' : 'Blocked'}</span>
        </span>
        <span className="projects-muted">Recorded verdict of review attempt {review.attempt}; approval and integration are separate nodes.</span>
      </p>
      <p className="review-summary" data-testid="review-summary">{reviewSummary(review)}</p>
      <dl className="projects-facts">
        <div>
          <dt>Reviewer</dt>
          <dd data-testid="review-reviewer"><code>{review.reviewer.session_id}</code> · {TRANSPORT_WORDING[review.reviewer.transport]}, independent of both workers</dd>
        </div>
        <div><dt>Reviewed at</dt><dd>{formatTime(review.reviewed_at)}</dd></div>
        <div>
          <dt>Bundle reviewed</dt>
          <dd data-testid="review-bundle">
            {candidateNode === null ? bundle : (
              <AppLink href={runPathname(scope.projectId, scope.workflowId, scope.runId, candidateNode)} onNavigate={onNavigate} title="Open the candidate node this bundle was built from">{bundle}</AppLink>
            )}
            {' '}· candidate commit <code title={review.candidate_commit}>{shortRevision(review.candidate_commit)}</code>
          </dd>
        </div>
        <div>
          <dt>Diff the reviewer saw</dt>
          <dd data-testid="review-diff">
            {review.diff === null ? 'No diff artifact was recorded.' : diffScoped && diffHref !== null ? (
              <>
                <a href={diffHref} target="_blank" rel="noopener noreferrer">Open {review.diff.artifact_id}</a>
                {' '}<span className="projects-muted">(plain text, new tab) · sha256 {review.diff.sha256.slice(0, 12)}…</span>
              </>
            ) : (
              <span className="projects-error-inline" role="alert">The diff link <code>{review.diff.uri}</code> is outside this run's artifact route and was not linked.</span>
            )}
          </dd>
        </div>
      </dl>

      <section className="evidence-section" aria-labelledby="review-findings-title" data-testid="review-findings" data-group-by={groupBy}>
        <div className="review-findings-head">
          <h4 id="review-findings-title">Findings</h4>
          {review.findings.length > 0 && (
            <div className="review-group-toggle" role="group" aria-label="Group findings by">
              <span className="projects-muted">Group by</span>
              <button type="button" className="button button-small" aria-pressed={groupBy === 'disposition'} data-testid="group-by-disposition" onClick={() => setGroupBy('disposition')}>Disposition</button>
              <button type="button" className="button button-small" aria-pressed={groupBy === 'worker'} data-testid="group-by-worker" onClick={() => setGroupBy('worker')}>Worker</button>
            </div>
          )}
        </div>
        {populated.length === 0 ? (
          <p className="projects-muted" data-testid="findings-empty">The reviewer recorded no findings.</p>
        ) : populated.map(group => (
          <section key={group.key} className="finding-group" {...group.attributes} aria-labelledby={`findings-${group.key}`}>
            <h5 id={`findings-${group.key}`}>{group.label} ({group.findings.length})</h5>
            <div className="table-wrap">
              <table className="findings-table">
                <thead>
                  <tr><th scope="col">Severity</th><th scope="col">Message</th><th scope="col">Worker</th><th scope="col">Requirement</th></tr>
                </thead>
                <tbody>
                  {group.findings.map((finding, index) => (
                    <FindingRow key={`${group.key}-${index}`} finding={finding} scope={scope} definitionNodes={definitionNodes} inputs={inputs} onOpenRequirement={onOpenRequirement} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
        <p className="projects-muted">Blocking means an unresolved P0 or P1 finding; a quote links only where the task text contains it verbatim.</p>
      </section>
    </div>
  )
}

/**
 * The Result section of a review node: the persisted verdict, reviewer identity, bundle, findings and diff.
 * A run whose export predates review results (404 REVIEW_NOT_FOUND) is a "not recorded" state, not an error.
 */
export function ReviewPanel({ scope, node, definitionNodes, inputs, refreshToken, onNavigate, onOpenRequirement }: Props) {
  // The snapshot links the recorded review; an older export has no link, so the first attempt is asked for once the node ran.
  const reviewPath = node.result_uri !== null
    ? scopedReviewPath(scope, node.result_uri)
    : node.status === 'pending' ? null : paths.review(scope, Math.max(node.attempt, 1))
  const unscoped = node.result_uri !== null && reviewPath === null
  const load = useCallback((signal: AbortSignal) => fetchReviewResult(scope, reviewPath!, signal), [scope, reviewPath])
  const { state, reload } = useResource(reviewPath, load, refreshToken)
  const none = (
    <p className="projects-muted" data-testid="review-none">
      No review recorded for this run: either the review has not happened or the run's export predates review results (re-export it with the workflow CLI).
    </p>
  )
  if (unscoped) {
    return (
      <p className="projects-error-inline" role="alert" data-testid="result-unscoped">
        The review link <code>{node.result_uri}</code> is outside this run's reviews route and was not fetched.
      </p>
    )
  }
  if (reviewPath === null) return none
  if (state.status === 'loading' || state.status === 'idle') return <LoadingPanel>Loading the recorded review…</LoadingPanel>
  if (state.status === 'error') {
    if (isNotRecorded(state.error, NOT_RECORDED.review)) return none
    return <ErrorPanel error={state.error} what="The recorded review" onRetry={reload} />
  }
  return <ReviewResultView review={state.data} scope={scope} definitionNodes={definitionNodes} inputs={inputs} onNavigate={onNavigate} onOpenRequirement={onOpenRequirement} />
}
