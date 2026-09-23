import { useCallback, useEffect, useState } from 'react'
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
import { findingsForFile, runLanes, workerGroupOf, workerGroups, workerWording } from './findings.ts'
import { useRunCapturedFiles } from './files.ts'
import { AppLink, ErrorPanel, LoadingPanel } from './panels.tsx'
import { blockedByWording, outcomeWording, severityCounts, type Reviewer } from './reviewers.ts'
import { runPathname } from './routes.ts'
import { formatTime, reviewSummary, shortRevision } from './status.ts'
import { useResource, type Resource } from './useResource.ts'

type SnapshotNode = RunDetail['snapshot']['nodes'][number]
type DefinitionNode = RunDetail['definition']['nodes'][number]
type Lane = ReviewFinding['requirement_found_in'][number]
type Disposition = ReviewFinding['disposition']
type GroupBy = 'disposition' | 'worker' | 'reviewer'
/** A reviewer id, or null for every reviewer. */
type ReviewerFilter = string | null

type Props = {
  scope: RunScope
  node: SnapshotNode
  definitionNodes: DefinitionNode[]
  /** Every node's state in the run: the launch nodes' results name the captured files a finding can link to. */
  snapshotNodes: SnapshotNode[]
  /** The run's inputs, used only to name the graph node that launched a lane; the review itself never needs them. */
  inputs: Resource<RunInputs | null>
  refreshToken: number
  onNavigate: (pathname: string) => void
  /** Opens a worker's task with the quoted requirement highlighted (the run view navigates and hands the quote over). */
  onOpenRequirement: (nodeId: string, quote: string) => void
  /** Opens a captured file's panel on the launch node that shows it (the run view navigates and hands the path over). */
  onOpenFile: (nodeId: string, path: string) => void
  /** Reports the served review's transport, so the node can say whether its reviewers ran as sessions or print jobs. */
  onTransport?: (transport: ReviewResult['reviewer']['transport']) => void
}

const TRANSPORT_WORDING: Record<Reviewer['transport'], string> = {
  native: 'native session',
  print: 'print-mode session',
  manual: 'operator-supplied review',
}
const DISPOSITIONS: readonly Disposition[] = ['open', 'resolved', 'accepted']
const DISPOSITION_LABEL: Record<Disposition, string> = { open: 'Open', resolved: 'Resolved', accepted: 'Accepted' }
/** The graph node that launched a lane: from the inputs when loaded, else `launch_<lane>` when the pinned graph has it, else the lane itself. */
function launchNodeFor(lane: Lane, definitionNodes: DefinitionNode[], inputs: Resource<RunInputs | null>): string {
  if (inputs.status === 'ready' && inputs.data !== null) {
    const worker = inputs.data.workers.find(candidate => candidate.node_id === lane)
    if (worker) return worker.launch_node_id
  }
  return definitionNodes.some(candidate => candidate.node_id === `launch_${lane}`) ? `launch_${lane}` : lane
}

type RowProps = Pick<Props, 'scope' | 'definitionNodes' | 'inputs' | 'onOpenRequirement' | 'onOpenFile'> & {
  finding: ReviewFinding
  /** The run's captured files by path, with the launch node that shows each. */
  capturedFiles: Map<string, string>
}

function FindingRow({ finding, scope, definitionNodes, inputs, onOpenRequirement, onOpenFile, capturedFiles }: RowProps) {
  const blocking = isBlockingFinding(finding)
  // A finding links to every captured file its message names verbatim; the review result itself records no location.
  const files = [...capturedFiles].filter(([path]) => findingsForFile([finding], path).length > 0)
  return (
    <tr
      data-testid="finding"
      data-severity={finding.severity}
      data-disposition={finding.disposition}
      data-worker={finding.worker ?? 'unrecorded'}
      data-reviewer={finding.reviewer}
      className={blocking ? 'finding-blocking' : undefined}
    >
      <td><span className="finding-severity">{finding.severity}</span>{blocking && <span className="visually-hidden"> (blocks integration)</span>}</td>
      <td>
        {finding.message}
        {files.map(([path, nodeId]) => (
          <AppLink
            key={path}
            href={runPathname(scope.projectId, scope.workflowId, scope.runId, nodeId)}
            onNavigate={() => onOpenFile(nodeId, path)}
            className="finding-file-link"
            data-testid="finding-file-link"
            data-path={path}
            style={{ display: 'block' }}
          >
            Open the captured {path}
          </AppLink>
        ))}
      </td>
      <td>{finding.worker === null ? <span className="projects-muted">not recorded</span> : workerWording(finding.worker)}</td>
      <td data-testid="finding-reviewer">{finding.reviewer}</td>
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

/** A reviewer's own verdict; a reviewer superseded before deciding, still pending, or blocked by the deadline or a rejected file has none. */
function ReviewerVerdict({ verdict }: { verdict: Reviewer['verdict'] }) {
  if (verdict === null) return <span className="projects-muted" data-testid="reviewer-verdict" data-status="none">No verdict</span>
  const approved = verdict === 'approved'
  return (
    <span className={`status-badge ${approved ? 'status-succeeded' : 'status-failed'}`} data-testid="reviewer-verdict" data-status={verdict}>
      <span>{approved ? 'Approved' : 'Blocked'}</span>
    </span>
  )
}

/** One entry per reviewer of the run, in declared order: id, own verdict, how it ended (with its blocking reason), finding counts by severity and its times. */
function ReviewerStrip({ reviewers }: { reviewers: readonly Reviewer[] }) {
  return (
    <section className="evidence-section reviewer-strip" aria-labelledby="review-reviewers-title" data-testid="reviewer-strip" data-count={reviewers.length}>
      <h4 id="review-reviewers-title">Reviewers ({reviewers.length})</h4>
      <ul className="evidence-list reviewer-list">
        {reviewers.map(reviewer => (
          <li key={reviewer.reviewer_id} data-testid="reviewer-entry" data-reviewer={reviewer.reviewer_id} data-status={reviewer.status} data-verdict={reviewer.verdict ?? 'none'}>
            <p>
              <strong data-testid="reviewer-id">{reviewer.reviewer_id}</strong>{' '}
              <ReviewerVerdict verdict={reviewer.verdict} />{' '}
              <span data-testid="reviewer-status">{outcomeWording(reviewer)}</span>
            </p>
            <p className="projects-muted">
              <span data-testid="reviewer-counts">{severityCounts(reviewer.findings)}</span>
              {reviewer.launched_at !== null && <> · launched {formatTime(reviewer.launched_at)}</>}
              {reviewer.accepted_at !== null && <> · file accepted {formatTime(reviewer.accepted_at)}</>}
            </p>
          </li>
        ))}
      </ul>
    </section>
  )
}

const UNLISTED_REVIEWER = 'unlisted'

/**
 * One group per reviewer of the run in declared order, labelled with its id, its own verdict and its severity counts, then a
 * guard group for findings whose reviewer the run does not list (the contract forbids it, so it stays hidden when empty).
 */
function reviewerGroups(reviewers: readonly Reviewer[], visible: readonly ReviewFinding[]) {
  const ids = new Set(reviewers.map(reviewer => reviewer.reviewer_id))
  const verdictWording = (verdict: Reviewer['verdict']) => (verdict === null ? 'no verdict' : verdict === 'approved' ? 'approved' : 'blocked')
  return [
    ...reviewers.map(reviewer => ({
      key: `reviewer-${reviewer.reviewer_id}`,
      label: `${reviewer.reviewer_id} · ${verdictWording(reviewer.verdict)} · ${severityCounts(reviewer.findings)}`,
      attributes: { 'data-reviewer-group': reviewer.reviewer_id, 'data-verdict': reviewer.verdict ?? 'none' },
      findings: visible.filter(finding => finding.reviewer === reviewer.reviewer_id),
    })),
    {
      key: `reviewer-${UNLISTED_REVIEWER}`,
      label: 'Reviewer not listed for this run',
      attributes: { 'data-reviewer-group': UNLISTED_REVIEWER, 'data-verdict': 'none' },
      findings: visible.filter(finding => !ids.has(finding.reviewer)),
    },
  ]
}

function ReviewResultView({ review, scope, definitionNodes, snapshotNodes, inputs, refreshToken, onNavigate, onOpenRequirement, onOpenFile, onTransport }: { review: ReviewResult } & Omit<Props, 'node'>) {
  const approved = review.verdict === 'approved'
  const reviewers = review.reviewers
  const several = reviewers.length > 1
  const blockedBy = blockedByWording(review)
  const candidateNode = definitionNodes.some(candidate => candidate.node_id === 'candidate') ? 'candidate' : null
  const bundle = <code title={review.bundle_sha256}>{shortRevision(review.bundle_sha256)}</code>
  // Like every other artifact link, the diff is only ever fetched through this run's own artifact route by its ID.
  const diffHref = review.diff === null ? null : paths.artifact(scope, review.diff.artifact_id)
  const diffScoped = review.diff !== null && review.diff.uri === diffHref
  // Several reviewers read best as one group each; a single reviewer's findings group by disposition.
  const [groupBy, setGroupBy] = useState<GroupBy>(several ? 'reviewer' : 'disposition')
  const [reviewerFilter, setReviewerFilter] = useState<ReviewerFilter>(null)
  const lanes = runLanes(definitionNodes, inputs)
  const capturedFiles = useRunCapturedFiles(scope, snapshotNodes, refreshToken)
  const transport = review.reviewer.transport
  useEffect(() => { onTransport?.(transport) }, [onTransport, transport])
  // The filter narrows the union to one reviewer's findings; grouping then applies to what is left.
  const visible = reviewerFilter === null ? review.findings : review.findings.filter(finding => finding.reviewer === reviewerFilter)
  const countFor = (reviewerId: string) => review.findings.filter(finding => finding.reviewer === reviewerId).length
  const groups = groupBy === 'disposition'
    ? DISPOSITIONS.map(disposition => ({ key: disposition, label: DISPOSITION_LABEL[disposition], attributes: { 'data-disposition': disposition }, findings: visible.filter(finding => finding.disposition === disposition) }))
    : groupBy === 'reviewer'
      ? reviewerGroups(reviewers, visible)
      : workerGroups(lanes, visible).map(group => ({ ...group, attributes: { 'data-worker-group': group.key }, findings: visible.filter(finding => workerGroupOf(finding) === group.key) }))
  const populated = groups.filter(group => group.findings.length > 0)
  return (
    <div className="review-result" data-testid="review-result" data-verdict={review.verdict} data-reviewer-count={reviewers.length}>
      <p className="review-verdict-line">
        <span className={`status-badge ${approved ? 'status-succeeded' : 'status-failed'}`} data-testid="review-verdict" data-status={review.verdict}>
          <span>{approved ? 'Approved' : 'Blocked'}</span>
        </span>
        <span className="projects-muted">
          Combined verdict of {several ? `${reviewers.length} reviewers` : 'the one reviewer'} for review attempt {review.attempt}: every reviewer must approve; approval and integration are separate nodes.
        </span>
      </p>
      {blockedBy !== null && <p className="projects-error-inline" role="status" data-testid="review-blocked-by">{blockedBy}</p>}
      <p className="review-summary" data-testid="review-summary">{reviewSummary(review)}</p>
      <dl className="projects-facts">
        <div>
          <dt>{several ? 'Reviewers' : 'Reviewer'}</dt>
          <dd data-testid="review-reviewer">
            {reviewers.map((reviewer, index) => (
              <span key={reviewer.reviewer_id} data-reviewer={reviewer.reviewer_id}>
                {index > 0 && ', '}
                {several && `${reviewer.reviewer_id}: `}{reviewer.session_id ? <code>{reviewer.session_id}</code> : <span className="projects-muted">no session recorded</span>} · {TRANSPORT_WORDING[reviewer.transport]}
              </span>
            ))}
            {several ? '; independent of every worker lane and of one another' : ', independent of every worker lane'}
          </dd>
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
          <dt>Diff the {several ? 'reviewers' : 'reviewer'} saw</dt>
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

      <ReviewerStrip reviewers={reviewers} />

      <section className="evidence-section" aria-labelledby="review-findings-title" data-testid="review-findings" data-group-by={groupBy} data-reviewer-filter={reviewerFilter ?? 'all'}>
        <div className="review-findings-head">
          <h4 id="review-findings-title">Findings</h4>
          {review.findings.length > 0 && (
            <>
              <div className="review-group-toggle" role="group" aria-label="Show findings from">
                <span className="projects-muted">Reviewer</span>
                <button type="button" className="button button-small" aria-pressed={reviewerFilter === null} data-testid="filter-reviewer" data-reviewer="all" onClick={() => setReviewerFilter(null)}>All ({review.findings.length})</button>
                {reviewers.map(reviewer => (
                  <button
                    key={reviewer.reviewer_id}
                    type="button"
                    className="button button-small"
                    aria-pressed={reviewerFilter === reviewer.reviewer_id}
                    data-testid="filter-reviewer"
                    data-reviewer={reviewer.reviewer_id}
                    onClick={() => setReviewerFilter(reviewer.reviewer_id)}
                  >
                    {reviewer.reviewer_id} ({countFor(reviewer.reviewer_id)})
                  </button>
                ))}
              </div>
              <div className="review-group-toggle" role="group" aria-label="Group findings by">
                <span className="projects-muted">Group by</span>
                <button type="button" className="button button-small" aria-pressed={groupBy === 'disposition'} data-testid="group-by-disposition" onClick={() => setGroupBy('disposition')}>Disposition</button>
                <button type="button" className="button button-small" aria-pressed={groupBy === 'worker'} data-testid="group-by-worker" onClick={() => setGroupBy('worker')}>Worker</button>
                <button type="button" className="button button-small" aria-pressed={groupBy === 'reviewer'} data-testid="group-by-reviewer" onClick={() => setGroupBy('reviewer')}>Reviewer</button>
              </div>
            </>
          )}
        </div>
        {populated.length === 0 ? (
          <p className="projects-muted" data-testid="findings-empty">
            {reviewerFilter !== null ? `Reviewer ${reviewerFilter} recorded no findings.` : several ? 'No reviewer recorded a finding.' : 'The reviewer recorded no findings.'}
          </p>
        ) : populated.map(group => (
          <section key={group.key} className="finding-group" {...group.attributes} aria-labelledby={`findings-${group.key}`}>
            <h5 id={`findings-${group.key}`}>{group.label} ({group.findings.length})</h5>
            <div className="table-wrap">
              <table className="findings-table">
                <thead>
                  <tr><th scope="col">Severity</th><th scope="col">Message</th><th scope="col">Worker</th><th scope="col">Reviewer</th><th scope="col">Requirement</th></tr>
                </thead>
                <tbody>
                  {group.findings.map((finding, index) => (
                    <FindingRow key={`${group.key}-${index}`} finding={finding} scope={scope} definitionNodes={definitionNodes} inputs={inputs} onOpenRequirement={onOpenRequirement} onOpenFile={onOpenFile} capturedFiles={capturedFiles} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
        <p className="projects-muted">
          A finding links to a captured file only where its message names the file's path verbatim. Blocking means an unresolved P0 or P1 finding from any reviewer; a quote links only where the task text contains it verbatim. Workers are the lanes this run had{lanes.length > 0 ? ` (${lanes.join(', ')})` : ''}; “multiple workers” covers findings that concern more than one lane. Reviewer names the reviewer that raised the finding; the same finding raised by several reviewers is listed once per reviewer, never merged.
        </p>
      </section>
    </div>
  )
}

/**
 * The Result section of a review node: the persisted combined verdict, every reviewer's identity and outcome, the bundle,
 * the unioned findings and the diff. A run whose export predates review results (404 REVIEW_NOT_FOUND) is a "not recorded"
 * state, not an error.
 */
export function ReviewPanel({ scope, node, definitionNodes, snapshotNodes, inputs, refreshToken, onNavigate, onOpenRequirement, onOpenFile, onTransport }: Props) {
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
  return (
    <ReviewResultView
      review={state.data}
      scope={scope}
      definitionNodes={definitionNodes}
      snapshotNodes={snapshotNodes}
      inputs={inputs}
      refreshToken={refreshToken}
      onNavigate={onNavigate}
      onOpenRequirement={onOpenRequirement}
      onOpenFile={onOpenFile}
      onTransport={onTransport}
    />
  )
}
