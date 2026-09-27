/**
 * The review, challenge and controller pages' model (docs/PRD_VIEWER_UX.md 4.7-4.9): a reviewer's time taken only from served
 * fields, the reviewer deadline, the blocking findings, the challenge headline, the handoff's wait from the launch receipts,
 * the approval's instant and who approved, the integrated commit, and the section index entries of these pages. Pure (no
 * React), so the sections and the unit tests read the same values.
 */
import type { Span } from '../../../contracts/projects/triage.ts'
import { isBlockingFinding, type ReviewFinding, type ReviewResult, type RunInputs } from '../../../contracts/projects/v1.ts'
import type { WorkflowEvent } from '../../../contracts/workflow/v1.ts'
import { formatSpan } from '../time.ts'
import type { SectionEntry } from './model.ts'

type Reviewer = ReviewResult['reviewers'][number]
type Challenge = NonNullable<RunInputs['challenge']>

/**
 * What a reviewer's own time line says: how long it took from its launch to its accepted file; that no launch time was
 * recorded (print jobs record none); or, launched without a verdict (pending or superseded), only when it was launched.
 */
export type ReviewerTime =
  | { kind: 'took'; ms: number }
  | { kind: 'no_launch'; print: boolean }
  | { kind: 'no_verdict'; launchedAt: string }
/** A reviewer's deadline: its launch plus the review timeout, and how long is left at `now` (≥ 0). */
export type Deadline = { at: string; leftMs: number; passed: boolean }
/** The challenge headline's parts (4.8); `lead` names the outcome and the attempt. */
export type ChallengeHeadline = { lead: string; notes: string | null; decidedAt: string | null; totalMs: number | null; attempts: number }
/** How long the handoff waited: from the latest launch start (`from`, of `lane`) to the freeze. */
export type HandoffWait = { ms: number; from: string; lane: string }
/** When the approval happened (inferred at the integration when no event recorded it) and who approved. */
export type ApprovalLine = { at: string | null; inferred: boolean; how: string; recorded: boolean }

const ms = (iso: string) => Date.parse(iso)
const SEVERITIES = ['P0', 'P1', 'P2'] as const

/** A reviewer's time from served fields only (`launched_at`, `accepted_at`): never an elapsed time, never an invented start. */
export function reviewerTime(reviewer: Pick<Reviewer, 'launched_at' | 'accepted_at' | 'transport'>): ReviewerTime | null {
  if (reviewer.launched_at === null) return { kind: 'no_launch', print: reviewer.transport === 'print' }
  if (reviewer.accepted_at === null) return { kind: 'no_verdict', launchedAt: reviewer.launched_at }
  const took = ms(reviewer.accepted_at) - ms(reviewer.launched_at)
  return Number.isNaN(took) ? null : { kind: 'took', ms: Math.max(0, took) }
}

/**
 * A reviewer's deadline (4.7): `launched_at` + `inputs.automatic.review_timeout_seconds`. The controller counts from its
 * receipt's launch request, so the shown value is approximate (`deadlineText` prefixes `≈`). Null without a launch time or
 * a timeout. Not rendered yet: a review serves its reviewers only once decided (decisions.md, deferred live times).
 */
export function reviewerDeadline(launchedAt: string | null, timeoutSeconds: number | null | undefined, now: number): Deadline | null {
  if (launchedAt === null || timeoutSeconds === null || timeoutSeconds === undefined) return null
  const start = ms(launchedAt)
  if (Number.isNaN(start)) return null
  const at = start + timeoutSeconds * 1000
  return { at: new Date(at).toISOString(), leftMs: Math.max(0, at - now), passed: now >= at }
}

/** Time left in whole minutes, as the PRD words it ("56m left"); an hour or more reads like a span ("1h05m"). */
function leftWords(left: number): string {
  const minutes = Math.floor(left / 60_000)
  return minutes < 1 ? 'under 1m' : minutes < 60 ? `${minutes}m` : formatSpan(left)
}

/** "deadline ≈10:40 (26m left)", or "deadline ≈10:10 (passed)"; `clock` formats the time in the viewer's zone. */
export function deadlineText(deadline: Deadline, clock: (iso: string) => string): string {
  return `deadline ≈${clock(deadline.at)} (${deadline.passed ? 'passed' : `${leftWords(deadline.leftMs)} left`})`
}

/** The findings that block integration (an unresolved P0 or P1 from any reviewer), in review order. */
export function blockingFindings(review: Pick<ReviewResult, 'findings'>): ReviewFinding[] {
  return review.findings.filter(isBlockingFinding)
}

/** A review's index entries: its blocking findings when there are any, then every finding (the section holding the table). */
export function reviewSectionEntries(review: ReviewResult | null): SectionEntry[] {
  if (review === null) return []
  const blocking = blockingFindings(review).length
  return [
    ...(blocking > 0 ? [{ key: 'blocking', label: 'Blocking', count: blocking }] : []),
    { key: 'review', label: 'Findings', count: review.findings.length },
  ]
}

/** "1 P1", "1 P0 and 2 P1": the counts of the given severities present. */
function severityWords(concerns: Challenge['concerns'], severities: readonly Challenge['concerns'][number]['severity'][]): string {
  return severities.map(severity => [severity, concerns.filter(concern => concern.severity === severity).length] as const)
    .filter(([, count]) => count > 0).map(([severity, count]) => `${count} ${severity}`).join(' and ')
}

/**
 * The challenge headline (4.8): the outcome on its attempt, the P2 notes, when it was decided and the span over every attempt,
 * from the first attempt's start to the decision (else the last attempt's end); no span without a recorded start.
 */
export function challengeHeadline(challenge: Challenge, spans: readonly Span[]): ChallengeHeadline {
  const blocking = severityWords(challenge.concerns, ['P0', 'P1'])
  const p2 = challenge.concerns.filter(concern => concern.severity === 'P2').length
  const lead = challenge.status === 'passed' ? `Passed on attempt ${challenge.attempt}`
    : challenge.status === 'paused' ? `Paused: the design challenge found ${blocking || 'a blocking concern'}; no worker was launched.`
      : challenge.status === 'accepted' ? `Accepted by the operator on attempt ${challenge.attempt}${blocking ? ` over ${blocking}` : ''}`
        : 'Disabled: nothing was challenged'
  const starts = spans.flatMap(span => (span.start ? [ms(span.start.at)] : []))
  const ends = spans.flatMap(span => (span.end ? [ms(span.end.at)] : []))
  const end = challenge.decided_at ? ms(challenge.decided_at) : ends.length ? Math.max(...ends) : null
  const totalMs = starts.length && end !== null ? Math.max(0, end - Math.min(...starts)) : null
  return { lead, notes: p2 > 0 ? `${p2} P2 ${p2 === 1 ? 'note' : 'notes'}` : null, decidedAt: challenge.decided_at, totalMs, attempts: challenge.attempts }
}

/** A challenge's index entries: its concerns when it raised any, then the alternative and the experiment. */
export function challengeSectionEntries(challenge: Challenge | null): SectionEntry[] {
  if (challenge === null) return []
  return [
    ...(challenge.concerns.length > 0 ? [{ key: 'concerns', label: 'Concerns', count: challenge.concerns.length }] : []),
    { key: 'alternative', label: 'Alternative & experiment' },
  ]
}

/** Concerns in severity order, P0 first; the order within a severity is the record's. */
export function concernsBySeverity(concerns: Challenge['concerns']): Challenge['concerns'] {
  return SEVERITIES.flatMap(severity => concerns.filter(concern => concern.severity === severity))
}

/**
 * How long the handoff waited for the completion signals (4.9): from the latest launch start among the lanes' receipts (the
 * native start, else the launch request) to the freeze. Null without a freeze time, a receipt, or when the freeze precedes it.
 */
export function handoffWait(workers: RunInputs['workers'], freezeAt: string | null): HandoffWait | null {
  if (freezeAt === null) return null
  const starts = workers.flatMap(worker => {
    const at = worker.launch ? worker.launch.native_started_at ?? worker.launch.launch_requested_at : null
    return at !== null && !Number.isNaN(ms(at)) ? [{ at, lane: worker.node_id }] : []
  })
  if (starts.length === 0) return null
  const latest = starts.reduce((last, item) => (ms(item.at) >= ms(last.at) ? item : last))
  const wait = ms(freezeAt) - ms(latest.at)
  return Number.isNaN(wait) || wait < 0 ? null : { ms: wait, from: latest.at, lane: latest.lane }
}

/**
 * The approval's line (4.9): its instant from the timeline (an event, else ≈ the integration), and who approved: the finish
 * policy of an automatic run, else the operator. `recorded` says whether an event of the node recorded it. Null before any
 * instant is known.
 */
export function approvalLine(spans: readonly Span[], events: readonly WorkflowEvent[], inputs: RunInputs | null): ApprovalLine | null {
  const last = spans.at(-1)
  const instant = last?.end ?? last?.start ?? null
  if (instant === null) return null
  const recorded = events.some(event => event.status !== null)
  const finish = inputs?.mode === 'automatic' ? inputs.automatic?.finish ?? null : null
  return {
    at: instant.at, inferred: instant.source === 'inferred', recorded,
    how: finish ? `approved automatically by the finish policy (${finish})` : 'approved by the operator',
  }
}

const COMMIT = /\b[0-9a-f]{40}\b/

/** The commit the integration fast-forwarded to: the one its last row names, else the reviewed candidate's. */
export function integratedCommit(events: readonly WorkflowEvent[], review: Pick<ReviewResult, 'candidate_commit'> | null): string | null {
  const named = events.filter(event => event.status === 'succeeded').map(event => COMMIT.exec(event.message)?.[0]).filter(Boolean).at(-1)
  return named ?? review?.candidate_commit ?? null
}

/** When a node's latest status row was recorded (the start of a wait on the operator); null when no row carries a status. */
export function lastStatusAt(events: readonly WorkflowEvent[]): string | null {
  const rows = events.filter(event => event.status !== null)
  return rows.length ? rows.reduce((last, event) => (event.sequence > last.sequence ? event : last)).occurred_at : null
}

