/**
 * The review, challenge and controller pages' model (docs/PRD_VIEWER_UX.md 4.7-4.9): a reviewer's time taken only from served
 * fields, the reviewer deadline, the blocking findings, the challenge headline, the handoff's wait from the launch receipts,
 * the approval's instant and who approved, the integrated commit, and the section index entries of these pages. Pure (no
 * React), so the sections and the unit tests read the same values.
 */
import type { Span } from '../../../contracts/projects/triage.ts'
import { isBlockingFinding, type ReviewFinding, type ReviewResult, type RunInputs } from '../../../contracts/projects/v1.ts'
import type { WorkflowEvent } from '../../../contracts/workflow/v1.ts'
import { workerGroupOf, workerGroups } from '../findings.ts'
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
  const held = challenge.status === 'passed' && challenge.hold != null && challenge.hold.released_at === null
  const lead = held ? `Held after passing on attempt ${challenge.attempt}: no worker launches until the operator releases it`
    : challenge.status === 'passed' ? `Passed on attempt ${challenge.attempt}`
    : challenge.status === 'paused' ? `Paused: the design challenge found ${blocking || 'a blocking concern'}; no worker was launched.`
      : challenge.status === 'accepted' ? `Accepted by the operator on attempt ${challenge.attempt}${blocking ? ` over ${blocking}` : ''}`
        : 'Disabled: nothing was challenged'
  const starts = spans.flatMap(span => (span.start ? [ms(span.start.at)] : []))
  const ends = spans.flatMap(span => (span.end ? [ms(span.end.at)] : []))
  const end = challenge.decided_at ? ms(challenge.decided_at) : ends.length ? Math.max(...ends) : null
  const totalMs = starts.length && end !== null ? Math.max(0, end - Math.min(...starts)) : null
  return { lead, notes: p2 > 0 ? `${p2} P2 ${p2 === 1 ? 'note' : 'notes'}` : null, decidedAt: challenge.decided_at, totalMs, attempts: challenge.attempts }
}

/**
 * The records of attempts before the shown one (C49), in attempt order. An accepted attempt keeps its own paused record under
 * its number: that is the shown attempt's first decision, whose concerns the page already shows, so it is left out.
 */
export function earlierAttempts(challenge: Challenge): NonNullable<Challenge['history']> {
  return (challenge.history ?? []).filter(entry => entry.attempt < challenge.attempt)
}

/** A challenge's index entries: its concerns when it raised any, the alternative and the experiment, then the earlier attempts (C49) when there are any,
 * keyed apart from the node's own event History ('history'), which ends every node's index. */
export function challengeSectionEntries(challenge: Challenge | null): SectionEntry[] {
  if (challenge === null) return []
  const history = earlierAttempts(challenge)
  return [
    ...(challenge.concerns.length > 0 ? [{ key: 'concerns', label: 'Concerns', count: challenge.concerns.length }] : []),
    { key: 'alternative', label: 'Alternative & experiment' },
    ...(history.length > 0 ? [{ key: 'challenge-history', label: 'Earlier attempts', count: history.length }] : []),
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

/** approve's row on the approval node (workflow/pipeline.py, C51): `Approved by the operator[ (via a Claude Code session)]: ...`. */
const APPROVED_BY = /^Approved by (the (?:operator|maintainer)(?: \(via a Claude Code session\))?):/

/**
 * The approval's line (4.9): its instant from the timeline (an event, else ≈ the integration), and who approved: the finish
 * policy of an automatic run, else the operator. An automatic run with finish `approval` (C51) stopped for the operator: its
 * line names the actor approve recorded, or says it is not recorded. `recorded` says whether an event of the node recorded
 * it. Null before any instant is known.
 */
export function approvalLine(spans: readonly Span[], events: readonly WorkflowEvent[], inputs: RunInputs | null): ApprovalLine | null {
  const last = spans.at(-1)
  const instant = last?.end ?? last?.start ?? null
  if (instant === null) return null
  const recorded = events.some(event => event.status !== null)
  const finish = inputs?.mode === 'automatic' ? inputs.automatic?.finish ?? null : null
  if (finish === 'approval') {
    const actor = events.map(event => APPROVED_BY.exec(event.message)?.[1]).filter(Boolean).at(-1)
    return {
      at: instant.at, inferred: instant.source === 'inferred', recorded,
      how: actor ? `approved by ${actor}; finish approval` : 'approved under finish approval; who approved is not recorded',
    }
  }
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


// ---- Findings as cards (docs/PRD_VIEWER_REVAMP.md 5.4): their order, the filter row and the four figures ---------------

type Finding = Pick<ReviewFinding, 'severity' | 'worker' | 'reviewer' | 'disposition'>
const SEVERITY_RANK: Record<ReviewFinding['severity'], number> = { P0: 0, P1: 1, P2: 2 }
/** How a lane group that is not a lane of the run is said on a figure. */
const GROUP_WORDS: Record<string, string> = { multiple: 'multiple workers', none: 'no worker', unrecorded: 'worker not recorded' }

/** The filter id of "Open only"; a reviewer's is `reviewer:<id>`, a lane group's `lane:<key>`. */
export const OPEN_ONLY = 'open'
export const reviewerFilterId = (reviewerId: string) => `reviewer:${reviewerId}`
export const laneFilterId = (key: string) => `lane:${key}`

/** The lane groups the findings populate, in display order: the run's lanes, any other lane named, then multiple, none, not recorded. */
function laneKeys(lanes: readonly string[], findings: readonly Pick<ReviewFinding, 'worker'>[]): string[] {
  const populated = new Set(findings.map(workerGroupOf))
  return workerGroups(lanes, findings).map(group => group.key).filter(key => populated.has(key))
}

/**
 * The cards' order: P0, P1, P2; within a severity by lane (the run's lanes in order, any other lane named, then multiple
 * workers, none, not recorded), then by reviewer in declared order (a reviewer the run does not list last), else as recorded.
 */
export function orderFindings<T extends Finding>(findings: readonly T[], lanes: readonly string[], reviewers: readonly string[]): T[] {
  const lane = workerGroups(lanes, findings).map(group => group.key)
  const reviewerRank = (id: string) => (reviewers.includes(id) ? reviewers.indexOf(id) : reviewers.length)
  return findings.map((finding, index) => ({ finding, index }))
    .sort((a, b) => SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity]
      || lane.indexOf(workerGroupOf(a.finding)) - lane.indexOf(workerGroupOf(b.finding))
      || reviewerRank(a.finding.reviewer) - reviewerRank(b.finding.reviewer)
      || a.index - b.index)
    .map(entry => entry.finding)
}

/**
 * The findings the pressed filters keep. Toggles of one kind add up (two reviewers show both reviewers' findings); kinds
 * narrow each other (a reviewer, a lane and Open only keep that reviewer's open findings on that lane). Nothing pressed keeps all.
 */
export function filterFindings<T extends Finding>(findings: readonly T[], pressed: ReadonlySet<string>): T[] {
  const of = (prefix: string) => [...pressed].filter(id => id.startsWith(prefix)).map(id => id.slice(prefix.length))
  const reviewers = of('reviewer:')
  const lanes = of('lane:')
  return findings.filter(finding => (reviewers.length === 0 || reviewers.includes(finding.reviewer))
    && (lanes.length === 0 || lanes.includes(workerGroupOf(finding)))
    && (!pressed.has(OPEN_ONLY) || finding.disposition === 'open'))
}

export type ReviewFigures = {
  /** Unresolved P0 and P1 findings from any reviewer. */
  blocking: number
  open: number
  /** Every reviewer of the run in declared order, with the findings it raised (0 included). */
  reviewers: { id: string; count: number }[]
  /** Every populated lane group in display order, with its findings. */
  lanes: { key: string; label: string; count: number }[]
}

/** The four figures a review node opens on: blocking, open, per reviewer and per lane. */
export function reviewFigures(review: { findings: readonly ReviewFinding[]; reviewers: readonly Pick<Reviewer, 'reviewer_id'>[] }, lanes: readonly string[]): ReviewFigures {
  const { findings } = review
  return {
    blocking: findings.filter(isBlockingFinding).length,
    open: findings.filter(finding => finding.disposition === 'open').length,
    reviewers: review.reviewers.map(reviewer => ({ id: reviewer.reviewer_id, count: findings.filter(finding => finding.reviewer === reviewer.reviewer_id).length })),
    lanes: laneKeys(lanes, findings).map(key => ({ key, label: GROUP_WORDS[key] ?? key, count: findings.filter(finding => workerGroupOf(finding) === key).length })),
  }
}

export type FindingFilter = { id: string; label: string; count: number }

/** The filter row's toggles: one per reviewer (declared order), one per populated lane group (labelled by its id), and Open only. */
export function findingFilterIds(review: { findings: readonly ReviewFinding[]; reviewers: readonly Pick<Reviewer, 'reviewer_id'>[] }, lanes: readonly string[]): { reviewers: FindingFilter[]; lanes: FindingFilter[]; open: FindingFilter } {
  const figures = reviewFigures(review, lanes)
  return {
    reviewers: figures.reviewers.map(item => ({ id: reviewerFilterId(item.id), label: item.id, count: item.count })),
    lanes: figures.lanes.map(item => ({ id: laneFilterId(item.key), label: item.key, count: item.count })),
    open: { id: OPEN_ONLY, label: 'Open only', count: figures.open },
  }
}
