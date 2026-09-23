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
 * How a reviewer's status file ended, as the controller records it. `accepted` and `succeeded` both mean its completion
 * file was accepted; `blocked` covers its own blocked verdict as well as the deadline and a rejected file (then with no
 * verdict); `superseded` is a reviewer stopped because another one blocked. Any other value is shown as recorded.
 */
const STATUS_WORDING: Readonly<Record<string, string>> = {
  accepted: 'completion file accepted',
  succeeded: 'completion file accepted',
  blocked: 'blocked',
  rejected: 'completion file rejected',
  timed_out: 'reached the review deadline',
  superseded: 'stopped after the combined decision',
  needs_reconciliation: 'needs reconciliation; no verdict',
  pending: 'not launched',
  launching: 'launching when the run stopped',
  running: 'still running when the run stopped',
}

export function statusWording(status: string): string {
  return STATUS_WORDING[status] ?? status.replace(/_/g, ' ')
}

/** Whether the reviewer was stopped because of another reviewer's outcome rather than its own. */
function superseded(reviewer: Pick<Reviewer, 'status'>): boolean {
  return reviewer.status === 'superseded'
}

/**
 * Why this reviewer's own outcome blocks the run, or null when it does not: a blocked verdict; an approval that left an
 * unresolved P0/P1; or a blocking status without any verdict (the deadline expired or its file was rejected).
 */
export function blockingReason(reviewer: Pick<Reviewer, 'status' | 'verdict' | 'findings'>): string | null {
  if (reviewer.verdict === 'blocked') return 'blocked the candidate'
  if (reviewer.verdict === 'approved') return reviewer.findings.some(isBlockingFinding) ? 'approved with an unresolved P0/P1 finding' : null
  if (superseded(reviewer)) return null
  if (reviewer.status === 'timed_out') return 'reached the review deadline without a verdict'
  if (reviewer.status === 'rejected') return 'completion file rejected'
  if (reviewer.status === 'blocked') return 'delivered no verdict: the review deadline expired or its completion file was rejected'
  return null
}

/** One line for the reviewer strip: how the reviewer ended, with the blocking reason when it has one. */
export function outcomeWording(reviewer: Pick<Reviewer, 'status' | 'verdict' | 'findings'>): string {
  const reason = blockingReason(reviewer)
  if (reason !== null) return reason
  if (superseded(reviewer)) return `${statusWording(reviewer.status)}, no verdict`
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
 * P0/P1, the deadline, a rejected file), then the reviewers stopped because of it. Null for an approved review.
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
