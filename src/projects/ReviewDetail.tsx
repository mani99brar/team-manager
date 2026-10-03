import { useState } from 'react'
import {
  isBlockingFinding,
  isNotRecorded,
  NOT_RECORDED,
  paths,
  type ReviewFinding,
  type ReviewResult,
  type RunDetail,
  type RunInputs,
  type RunScope,
} from './api.ts'
import { findingsForFile, runLanes, workerWording } from './findings.ts'
import { useRunCapturedFiles } from './files.ts'
import { AppLink, ErrorPanel, LoadingPanel } from './panels.tsx'
import { blockedByWording, outcomeWording, severityCounts, type Reviewer } from './reviewers.ts'
import { runPathname } from './routes.ts'
import { blockingFindings, filterFindings, findingFilterIds, orderFindings, reviewerTime } from './node/panels.ts'
import { reviewSummary, shortRevision } from './status.ts'
import { Time } from './Time.tsx'
import { formatSpan } from './time.ts'
import { Card, Chip, FilterToggles, SeverityChip } from './ui/index.tsx'
import { severityClass, severityTone, toneClass, type Tone } from './tone.ts'
import type { Resource } from './useResource.ts'

type SnapshotNode = RunDetail['snapshot']['nodes'][number]
type DefinitionNode = RunDetail['definition']['nodes'][number]
type Lane = ReviewFinding['requirement_found_in'][number]

type Props = {
  scope: RunScope
  /** The recorded review as the node page holds it (docs/PRD_VIEWER_UX.md 4.7); idle when nothing is asked for yet. */
  review: Resource<ReviewResult>
  onRetry: () => void
  /** The node's review link when it points outside this run's reviews route (so it was not fetched); null otherwise. */
  unscopedUri: string | null
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
}

const TRANSPORT_WORDING: Record<Reviewer['transport'], string> = {
  native: 'native session',
  print: 'print-mode session',
  manual: 'operator-supplied review',
}
/** The graph node that launched a lane: from the inputs when loaded, else `launch_<lane>` when the pinned graph has it, else the lane itself. */
function launchNodeFor(lane: Lane, definitionNodes: DefinitionNode[], inputs: Resource<RunInputs | null>): string {
  if (inputs.status === 'ready' && inputs.data !== null) {
    const worker = inputs.data.workers.find(candidate => candidate.node_id === lane)
    if (worker) return worker.launch_node_id
  }
  return definitionNodes.some(candidate => candidate.node_id === `launch_${lane}`) ? `launch_${lane}` : lane
}

type CardProps = Pick<Props, 'scope' | 'definitionNodes' | 'inputs' | 'onOpenRequirement' | 'onOpenFile'> & {
  finding: ReviewFinding
  /** The run's captured files by path, with the launch node that shows each. */
  capturedFiles: Map<string, string>
}

/**
 * One finding as a card (docs/PRD_VIEWER_REVAMP.md 5.4): a stripe in its severity's colour, the severity and disposition as
 * chips (a blocking one says so in words), the message with the captured files it names, then the worker, the reviewer and
 * the quoted requirement with the tasks it was found in. The `finding` test id and its data attributes are the table row's.
 */
function FindingCard({ finding, scope, definitionNodes, inputs, onOpenRequirement, onOpenFile, capturedFiles }: CardProps) {
  const blocking = isBlockingFinding(finding)
  // A finding links to every captured file its message names verbatim; the review result itself records no location.
  const files = [...capturedFiles].filter(([path]) => findingsForFile([finding], path).length > 0)
  return (
    <Card
      tone={blocking ? 'fail' : 'idle'}
      className={['finding-card', severityClass(severityTone(finding.severity)), blocking ? 'finding-blocking' : ''].filter(Boolean).join(' ')}
      data-testid="finding"
      data-severity={finding.severity}
      data-disposition={finding.disposition}
      data-worker={finding.worker ?? 'unrecorded'}
      data-reviewer={finding.reviewer}
    >
      <div className="finding-card-head">
        <SeverityChip severity={finding.severity} />
        <Chip tone={DISPOSITION_TONE[finding.disposition]} plain data-testid="finding-disposition">{finding.disposition}</Chip>
        {blocking && <Chip tone="fail">blocks integration</Chip>}
      </div>
      <p className="finding-message">
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
      </p>
      <dl className="finding-fields">
        <div><dt className="finding-field-label">Worker</dt><dd data-testid="finding-worker">{finding.worker === null ? <span className="projects-muted">not recorded</span> : workerWording(finding.worker)}</dd></div>
        <div><dt className="finding-field-label">Reviewer</dt><dd data-testid="finding-reviewer">{finding.reviewer}</dd></div>
        <div className="finding-requirement-field">
          <dt className="finding-field-label">Requirement</dt>
          <dd>
            {finding.requirement === null ? <span data-testid="finding-requirement-none">—</span> : (
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
          </dd>
        </div>
      </dl>
    </Card>
  )
}

/**
 * The controller's verdict for a reviewer, derived from its findings (C34); the verdict the reviewer wrote is `accepted_decision` in
 * its status file. A reviewer superseded before deciding, still pending, or blocked by the deadline or a rejected file has none.
 */
function ReviewerVerdict({ verdict }: { verdict: Reviewer['verdict'] }) {
  if (verdict === null) return <span className="projects-muted" data-testid="reviewer-verdict" data-status="none">No verdict</span>
  const approved = verdict === 'approved'
  return (
    <span className={`status-badge ${approved ? 'status-succeeded' : 'status-failed'}`} data-testid="reviewer-verdict" data-status={verdict}>
      <span>{approved ? 'Approved' : 'Blocked'}</span>
    </span>
  )
}

/**
 * How long a reviewer took, from served fields only (docs/PRD_VIEWER_UX.md 4.7): its launch to its accepted file; "launch
 * time not recorded" when the transport records none; or, launched without a verdict, its launch time. Nothing ticks: a
 * review serves its reviewers only once decided, so no elapsed time or deadline is shown.
 */
function ReviewerTime({ reviewer }: { reviewer: Reviewer }) {
  const time = reviewerTime(reviewer)
  if (time === null) return null
  return (
    <>
      {' · '}
      <span className="reviewer-time" data-testid="reviewer-time" data-kind={time.kind}>
        {time.kind === 'took' ? <span className="reviewer-duration">took {formatSpan(time.ms)}</span>
          : time.kind === 'no_launch' ? <>launch time not recorded{time.print ? ' (print)' : ''}{reviewer.accepted_at !== null && <> · verdict <Time iso={reviewer.accepted_at} seconds /></>}</>
            : <>no verdict · launched <Time iso={time.launchedAt} seconds /></>}
      </span>
    </>
  )
}

/**
 * One entry per reviewer of the run, in declared order: id, the controller's verdict for it (derived from its findings, C34),
 * how it ended (with its blocking reason) and how long it took, then its finding counts by severity and its recorded times.
 */
function ReviewerStrip({ reviewers }: { reviewers: readonly Reviewer[] }) {
  return (
    <section className="evidence-section reviewer-strip" aria-labelledby="review-reviewers-title" data-testid="reviewer-strip" data-count={reviewers.length}>
      <h4 id="review-reviewers-title">Reviewers ({reviewers.length})</h4>
      <ul className="evidence-list reviewer-list">
        {reviewers.map(reviewer => (
          <li key={reviewer.reviewer_id} className={`ui-card reviewer-card ${toneClass(reviewerTone(reviewer))}`} data-testid="reviewer-entry" data-reviewer={reviewer.reviewer_id} data-status={reviewer.status} data-verdict={reviewer.verdict ?? 'none'}>
            <p>
              <strong data-testid="reviewer-id">{reviewer.reviewer_id}</strong>{' '}
              <ReviewerVerdict verdict={reviewer.verdict} />{' '}
              <span data-testid="reviewer-status">{outcomeWording(reviewer)}</span>
              <ReviewerTime reviewer={reviewer} />
            </p>
            <p className="projects-muted">
              <span data-testid="reviewer-counts">{severityCounts(reviewer.findings)}</span>
              {reviewer.launched_at !== null && reviewer.accepted_at !== null && <> · launched <Time iso={reviewer.launched_at} seconds /></>}
              {reviewer.accepted_at !== null && <> · file accepted <Time iso={reviewer.accepted_at} seconds /></>}
            </p>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** What a reviewer's own outcome means for the run, as a tone: approved ok, blocked fail, no verdict yet idle. */
function reviewerTone(reviewer: Reviewer): Tone {
  if (reviewer.verdict === 'approved') return reviewer.findings.some(isBlockingFinding) ? 'warn' : 'ok'
  if (reviewer.verdict === 'blocked' || reviewer.status === 'blocked') return 'fail'
  return 'idle'
}

function ReviewResultView({ review, scope, definitionNodes, snapshotNodes, inputs, refreshToken, onNavigate, onOpenRequirement, onOpenFile }: { review: ReviewResult } & Omit<Props, 'review' | 'onRetry' | 'unscopedUri'>) {
  const approved = review.verdict === 'approved'
  const reviewers = review.reviewers
  const several = reviewers.length > 1
  const blockedBy = blockedByWording(review)
  const candidateNode = definitionNodes.some(candidate => candidate.node_id === 'candidate') ? 'candidate' : null
  const bundle = <code title={review.bundle_sha256}>{shortRevision(review.bundle_sha256)}</code>
  // Like every other artifact link, the diff is only ever fetched through this run's own artifact route by its ID.
  const diffHref = review.diff === null ? null : paths.artifact(scope, review.diff.artifact_id)
  const diffScoped = review.diff !== null && review.diff.uri === diffHref
  // One filter row (docs/PRD_VIEWER_REVAMP.md 5.4): each reviewer, each lane and Open only, any of them pressed at once.
  const [pressed, setPressed] = useState<ReadonlySet<string>>(() => new Set())
  const lanes = runLanes(definitionNodes, inputs)
  const capturedFiles = useRunCapturedFiles(scope, snapshotNodes, refreshToken)
  const ordered = orderFindings(review.findings, lanes, reviewers.map(reviewer => reviewer.reviewer_id))
  const visible = filterFindings(ordered, pressed)
  const toggles = findingFilterIds(review, lanes)
  // In the toggles' order, so the attribute reads the same however they were pressed.
  const pressedIds = [...toggles.reviewers, ...toggles.lanes, toggles.open].map(toggle => toggle.id).filter(id => pressed.has(id))
  const onlyReviewer = pressedIds.length === 1 && pressedIds[0].startsWith('reviewer:') ? pressedIds[0].slice('reviewer:'.length) : null
  const onToggle = (id: string, on: boolean) => {
    setPressed(previous => {
      const next = new Set(previous)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }
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
        <div><dt>Reviewed at</dt><dd><Time iso={review.reviewed_at} seconds /></dd></div>
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

      <section className="evidence-section" aria-labelledby="review-findings-title" data-testid="review-findings" data-filters={pressedIds.length === 0 ? 'all' : pressedIds.join(' ')}>
        <div className="ui-section-header review-findings-head">
          <h4 id="review-findings-title">Findings</h4>
          <span className="ui-sub" data-testid="findings-shown">{visible.length === review.findings.length ? `${review.findings.length} ${review.findings.length === 1 ? 'finding' : 'findings'}` : `${visible.length} of ${review.findings.length} shown`} · P0, P1, P2, then by lane</span>
        </div>
        {review.findings.length > 0 && (
          <FilterToggles
            className="findings-filters"
            data-testid="findings-filters"
            aria-label="Narrow the findings"
            filters={[...toggles.reviewers, ...toggles.lanes, toggles.open]}
            selected={pressed}
            onToggle={onToggle}
          />
        )}
        {visible.length === 0 ? (
          <p className="projects-muted" data-testid="findings-empty">
            {review.findings.length > 0 && onlyReviewer !== null ? `Reviewer ${onlyReviewer} recorded no findings.`
              : review.findings.length > 0 ? 'No finding matches the pressed filters.'
                : several ? 'No reviewer recorded a finding.' : 'The reviewer recorded no findings.'}
          </p>
        ) : (
          <ul className="finding-cards">
            {visible.map(finding => (
              <li key={review.findings.indexOf(finding)}>
                <FindingCard finding={finding} scope={scope} definitionNodes={definitionNodes} inputs={inputs} onOpenRequirement={onOpenRequirement} onOpenFile={onOpenFile} capturedFiles={capturedFiles} />
              </li>
            ))}
          </ul>
        )}
        <p className="projects-muted">
          A finding links to a captured file only where its message names the file's path verbatim. Blocking means an unresolved P0 or P1 finding from any reviewer; a quote links only where the task text contains it verbatim. Workers are the lanes this run had{lanes.length > 0 ? ` (${lanes.join(', ')})` : ''}; “multiple workers” covers findings that concern more than one lane. Reviewer names the reviewer that raised the finding; the same finding raised by several reviewers is listed once per reviewer, never merged.
        </p>
      </section>

      <ReviewerStrip reviewers={reviewers} />
    </div>
  )
}

const DISPOSITION_TONE: Record<ReviewFinding['disposition'], Tone> = { open: 'warn', resolved: 'ok', accepted: 'idle' }

/** Where a finding's worker points, said on a blocking card: the lane, several lanes, none, or not recorded. */
function laneWording(worker: ReviewFinding['worker']): string {
  if (worker === null) return 'worker not recorded'
  const words = workerWording(worker)
  return words === worker ? `lane ${worker}` : words === 'none' ? 'no worker' : words
}

/**
 * The findings that block integration, one card each, before the findings table (docs/PRD_VIEWER_UX.md 4.7): severity,
 * disposition, reviewer and lane, the full message, and the task lines the quoted requirement was found in. The table below
 * keeps listing them too; a card is not a `finding` row.
 */
export function BlockingFindings({ review, scope, definitionNodes, inputs, onOpenRequirement }: { review: ReviewResult } & Pick<Props, 'scope' | 'definitionNodes' | 'inputs' | 'onOpenRequirement'>) {
  return (
    <ul className="blocking-cards">
      {blockingFindings(review).map((finding, index) => (
        <li key={index} className={`blocking-card ui-card tone-fail ${severityClass(severityTone(finding.severity))}`} data-testid="blocking-finding" data-severity={finding.severity} data-reviewer={finding.reviewer}>
          <p className="blocking-card-head">
            <SeverityChip severity={finding.severity} className="finding-severity" /> · {finding.disposition} · {finding.reviewer} · {laneWording(finding.worker)}
          </p>
          <p className="blocking-card-message">{finding.message}</p>
          {finding.requirement !== null && finding.requirement_found_in.length > 0 && (
            <p className="blocking-card-links">
              {finding.requirement_found_in.map(lane => {
                const nodeId = launchNodeFor(lane, definitionNodes, inputs)
                const quote = finding.requirement!
                return (
                  <AppLink key={lane} href={runPathname(scope.projectId, scope.workflowId, scope.runId, nodeId)} onNavigate={() => onOpenRequirement(nodeId, quote)} className="blocking-card-link">
                    Requirement in the {lane} task ›
                  </AppLink>
                )
              })}
            </p>
          )}
        </li>
      ))}
    </ul>
  )
}

/**
 * The Result section of a review node: the persisted combined verdict, every reviewer's identity and outcome, the bundle,
 * the unioned findings and the diff. The node page holds the review (it also counts its findings for the index); this only
 * renders it. A run whose export predates review results (404 REVIEW_NOT_FOUND) is a "not recorded" state, not an error.
 */
export function ReviewPanel({ scope, review, onRetry, unscopedUri, definitionNodes, snapshotNodes, inputs, refreshToken, onNavigate, onOpenRequirement, onOpenFile }: Props) {
  const none = (
    <p className="projects-muted" data-testid="review-none">
      No review recorded for this run: either the review has not happened or the run's export predates review results (re-export it with the workflow CLI).
    </p>
  )
  if (unscopedUri !== null) {
    return (
      <p className="projects-error-inline" role="alert" data-testid="result-unscoped">
        The review link <code>{unscopedUri}</code> is outside this run's reviews route and was not fetched.
      </p>
    )
  }
  if (review.status === 'idle') return none
  if (review.status === 'loading') return <LoadingPanel>Loading the recorded review…</LoadingPanel>
  if (review.status === 'error') {
    if (isNotRecorded(review.error, NOT_RECORDED.review)) return none
    return <ErrorPanel error={review.error} what="The recorded review" onRetry={onRetry} />
  }
  return (
    <ReviewResultView
      review={review.data}
      scope={scope}
      definitionNodes={definitionNodes}
      snapshotNodes={snapshotNodes}
      inputs={inputs}
      refreshToken={refreshToken}
      onNavigate={onNavigate}
      onOpenRequirement={onOpenRequirement}
      onOpenFile={onOpenFile}
    />
  )
}
