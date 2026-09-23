/**
 * Per-reviewer wording for the review node. A review result always carries `reviewers`, one entry per reviewer the run
 * declared (one named `review` for exports recorded before the list existed, filled by the adapter), so nothing here has
 * a single-reviewer case: the combined verdict is unanimous, and a blocked run is explained by the reviewers that caused it.
 * Pure helpers, kept out of the component file so it only exports components.
 */
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
