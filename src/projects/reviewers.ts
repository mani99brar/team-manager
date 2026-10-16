/**
 * Per-reviewer wording for the review node. A review result always carries `reviewers`, one entry per reviewer the run
 * declared (one named `review` for exports recorded before the list existed, filled by the adapter), so nothing here has
 * a single-reviewer case: the combined verdict is unanimous, and a blocked run is explained by the reviewers that caused it.
 * Pure helpers, kept out of the component file so it only exports components.
 */
import { judgeDecided, servedReviewContext } from '../../contracts/projects/v1.ts'
import { isBlockingFinding, type ReviewFinding, type ReviewResult } from './api.ts'

export type Reviewer = ReviewResult['reviewers'][number]

const SEVERITIES: readonly ReviewFinding['severity'][] = ['P0', 'P1', 'P2']

/**
 * How a reviewer ended, in the contract's vocabulary (`REVIEWER_STATUSES` in `contracts/projects/v1.ts`): `accepted` (its
 * completion file was accepted), `blocked` (its verdict, an unresolved P0/P1, a rejected file or the review deadline
 * blocked the run), `superseded` (stopped after the run was decided while it was still working) or `pending` (no verdict
 * recorded yet). The contract records no separate status for the deadline or a rejected file: both are `blocked` with a
 * null verdict, so the wording for them is derived from `verdict` in `blockingReason`, never from an invented status.
 */
const STATUS_WORDING: Readonly<Record<Reviewer['status'], string>> = {
  accepted: 'completion file accepted',
  blocked: 'blocked',
  superseded: 'stopped after the combined decision',
  pending: 'no verdict recorded yet',
}

export function statusWording(status: Reviewer['status']): string {
  return STATUS_WORDING[status]
}

/** Whether the reviewer was stopped because of another reviewer's outcome rather than its own. */
function superseded(reviewer: Pick<Reviewer, 'status'>): boolean {
  return reviewer.status === 'superseded'
}

/**
 * Why this reviewer's own outcome blocks the run, or null when it does not: a blocked verdict; an approval that left an
 * unresolved P0/P1; or a blocked status without any verdict, which the contract records for both the expired review
 * deadline and a rejected completion file (it does not say which).
 */
export function blockingReason(reviewer: Pick<Reviewer, 'status' | 'verdict' | 'findings'>): string | null {
  if (reviewer.verdict === 'blocked') return 'blocked the candidate'
  if (reviewer.verdict === 'approved') return reviewer.findings.some(isBlockingFinding) ? 'approved with an unresolved P0/P1 finding' : null
  if (reviewer.status === 'blocked') return 'delivered no verdict: the review deadline expired or its completion file was rejected'
  return null
}

/**
 * One line for the reviewer strip: how the reviewer ended, with the blocking reason when it has one. A reviewer without a
 * verdict says so: superseded before deciding, pending and not yet launched, or pending after its launch.
 */
export function outcomeWording(reviewer: Pick<Reviewer, 'status' | 'verdict' | 'findings' | 'launched_at'>): string {
  const reason = blockingReason(reviewer)
  if (reason !== null) return reason
  if (superseded(reviewer)) return reviewer.verdict === null ? `${statusWording(reviewer.status)}, no verdict` : statusWording(reviewer.status)
  if (reviewer.status === 'pending') return reviewer.launched_at === null ? 'not launched, no verdict recorded yet' : statusWording(reviewer.status)
  return statusWording(reviewer.status)
}

/** "1 P1, 2 P2" in severity order, listing only the severities present; "no findings" when the list is empty. */
export function severityCounts(findings: readonly Pick<ReviewFinding, 'severity'>[]): string {
  if (findings.length === 0) return 'no findings'
  return SEVERITIES
    .map(severity => [severity, findings.filter(finding => finding.severity === severity).length] as const)
    .filter(([, count]) => count > 0)
    .map(([severity, count]) => `${count} ${severity}`)
    .join(', ')
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/**
 * Why a blocked review is blocked, naming the reviewers whose own outcome caused it (a blocked verdict, an unresolved
 * P0/P1, the deadline or a rejected file), then the reviewers stopped because of it. Null for an approved review.
 */
export function blockedByWording(review: Pick<ReviewResult, 'verdict' | 'reviewers'>): string | null {
  if (review.verdict !== 'blocked') return null
  const reasons = review.reviewers.flatMap(reviewer => {
    const reason = blockingReason(reviewer)
    return reason === null ? [] : [`${reviewer.reviewer_id} (${reason})`]
  })
  const stopped = review.reviewers.filter(superseded).map(reviewer => reviewer.reviewer_id)
  const head = reasons.length === 0
    ? 'Blocked: the combined verdict is blocked although no reviewer recorded a blocking outcome.'
    : `Blocked by ${list(reasons)}.`
  const tail = stopped.length === 0 ? '' : ` ${list(stopped)} ${stopped.length === 1 ? 'was' : 'were'} superseded: stopped after that decision, no verdict recorded.`
  return head + tail
}

export { ADVISORY_WORDING, DECIDING_WORDING, reviewerRole } from '../../contracts/projects/v1.ts'

/**
 * Whether the judge decided the review: the served result says its run pins a judged panel and it lists `judge`. A fallback
 * record on a judged run (no `judge` entry) is decided by its built-in reviewers, as today, and labels none advisory.
 */
export function isJudgedReview(review: Pick<ReviewResult, 'reviewers' | 'judged_panel'>): boolean {
  return judgeDecided(review, servedReviewContext(review))
}

/**
 * An advisory reviewer's verdict in words: it advised, the judge decided (never "blocked the candidate"). One that gave no
 * verdict (the deadline expired or its completion file was rejected: status blocked) says so, never that it blocked or advised.
 */
export function advisedWording(reviewer: Pick<Reviewer, 'status' | 'verdict'>): string {
  if (reviewer.verdict === 'blocked') return 'advised blocking'
  if (reviewer.verdict === 'approved') return 'advised approval'
  if (reviewer.status === 'blocked') return 'gave no verdict (the judge ruled on the others)'
  return `${statusWording(reviewer.status)}, no advice recorded`
}

/** What an advisory card says in place of its counts: its findings went to the judge, which ruled on each. */
export const ADVISORY_FINDINGS_WORDING = 'findings passed to the judge'

/** An advisory card's counts line: its findings went to the judge only when it gave a verdict; else its own (none) counts. */
export function advisoryFindingsWording(reviewer: Pick<Reviewer, 'verdict' | 'findings'>): string {
  return reviewer.verdict !== null ? ADVISORY_FINDINGS_WORDING : severityCounts(reviewer.findings)
}

/**
 * The Findings legend under the list. A judged record says the judge's confirmed rulings (and critique's own findings) block,
 * the built-ins reach the list only through a ruling, and each ruling names the findings it merged; every other record reads
 * exactly as before.
 */
export function findingsLegend(judged: boolean, critique: boolean, lanes: readonly string[]): string {
  const files = 'A finding links to a captured file only where its message names the file\'s path verbatim.'
  const workers = `Workers are the lanes this run had${lanes.length > 0 ? ` (${lanes.join(', ')})` : ''}; “multiple workers” covers findings that concern more than one lane.`
  if (!judged) return `${files} Blocking means an unresolved P0 or P1 finding from any reviewer; a quote links only where the task text contains it verbatim. ${workers} Reviewer names the reviewer that raised the finding; the same finding raised by several reviewers is listed once per reviewer, never merged.`
  return `${files} Blocking means an unresolved P0 or P1 ruling the judge confirmed${critique ? ', or an unresolved P0 or P1 critique finding' : ''}; the built-in reviewers are advisory and reach this list only through a ruling; a quote links only where the task text contains it verbatim. ${workers} Each ruling's Reviewer is the judge, and its [J<n> from …] prefix names the findings it merged.`
}
