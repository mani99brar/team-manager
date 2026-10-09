/**
 * The critique reviewer's evidence on the run page (docs/PRD_USER_CRITIQUE.md 4.5, Appendix A): a critique finding carries
 * `evidence` (1 to 20 numbered steps to reproduce and 0 to 6 screenshots, each an artifact id that resolves through the run's
 * artifact route and a caption). Other reviewers' findings and exports before 1.11.0 carry none. The critique reviewer is
 * worded as a headless critique job, never a native session (decisions.md [L1], [L2]).
 *
 * Pure helpers, kept out of the component files so they only export components. The components (the evidence block, the
 * "Earlier rounds" list) live in the owned `.tsx` files; this module holds the model the unit tests read.
 */
import type { FixLoop, FixLoopFinding, FixLoopReviewRound, ReviewFinding } from '../../contracts/projects/v1.ts'
import { isBlockingFinding, paths, type ReviewResult, type RunScope } from './api.ts'
import { blockingReason, type Reviewer } from './reviewers.ts'

/** The reviewer id the controller gives the critique (decisions.md [L1]); the prefix `critique-` names its screenshots. */
export const CRITIQUE_REVIEWER_ID = 'critique'
/** How the viewer words the critique reviewer entry, never "native session" (PRD 4.5, decisions.md [L1]). */
export const CRITIQUE_JOB_WORDING = 'headless critique job'
/** The strip's time label for the critique's `accepted_at`: it recorded a decision, it did not accept a completion file (PRD 4.4). */
export const CRITIQUE_DECIDED_WORDING = 'decided'

/**
 * Why the headless critique job's own outcome blocks the run, in job terms, or null when it does not (PRD 4.4): the
 * critique has no completion file and is not bound by `review_timeout_seconds`, so a null verdict is a failed job (the app
 * did not start, it timed out, it ran out of budget or its output was invalid), never an expired review deadline or a
 * rejected completion file. The controller writes the critique's exported status `accepted` only for an approved verdict
 * and `blocked` otherwise (`workflow/export_state.py`), so the critique is never superseded or pending here. A blocked
 * verdict blocked the candidate; an approval with a stray unresolved P0/P1 reads as the native reviewer's does.
 */
export function critiqueBlockingReason(reviewer: Pick<Reviewer, 'status' | 'verdict' | 'findings'>): string | null {
  if (reviewer.verdict === 'blocked') return 'blocked the candidate'
  if (reviewer.verdict === 'approved') return reviewer.findings.some(isBlockingFinding) ? 'approved with an unresolved P0/P1 finding' : null
  if (reviewer.status === 'blocked') return 'delivered no verdict: the critique job did not start, timed out, ran out of budget or produced invalid output'
  return null
}

/**
 * The critique entry's one-line outcome on the reviewer strip (PRD 4.5), worded as a headless job rather than
 * `outcomeWording`'s native-session terms (a completion file, the review deadline): its blocking reason, or "the critique
 * job completed" when its approved verdict left nothing blocking.
 */
export function critiqueOutcomeWording(reviewer: Pick<Reviewer, 'status' | 'verdict' | 'findings'>): string {
  return critiqueBlockingReason(reviewer) ?? 'the critique job completed'
}

function listWording(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/**
 * `blockedByWording` for a review that may include the critique: identical to the native wording for every native reviewer,
 * but the critique's reason is worded as a headless job (`critiqueBlockingReason`), so a failed critique never reads "the
 * review deadline expired or its completion file was rejected". Kept here because `reviewers.ts` is another lane's file; the
 * native path is delegated to `blockingReason` so the two stay in step.
 */
export function reviewBlockedBy(review: Pick<ReviewResult, 'verdict' | 'reviewers'>): string | null {
  if (review.verdict !== 'blocked') return null
  const reasons = review.reviewers.flatMap(reviewer => {
    const reason = isCritiqueReviewer(reviewer.reviewer_id) ? critiqueBlockingReason(reviewer) : blockingReason(reviewer)
    return reason === null ? [] : [`${reviewer.reviewer_id} (${reason})`]
  })
  const stopped = review.reviewers.filter(reviewer => reviewer.status === 'superseded').map(reviewer => reviewer.reviewer_id)
  const head = reasons.length === 0
    ? 'Blocked: the combined verdict is blocked although no reviewer recorded a blocking outcome.'
    : `Blocked by ${listWording(reasons)}.`
  const tail = stopped.length === 0 ? '' : ` ${listWording(stopped)} ${stopped.length === 1 ? 'was' : 'were'} superseded: stopped after that decision, no verdict recorded.`
  return head + tail
}

/** A critique finding's evidence as Appendix A pins it. */
export type CritiqueEvidence = NonNullable<ReviewFinding['evidence']>
/** One screenshot of a critique finding: an artifact id and a caption (no sha256 is carried; the id resolves at the route). */
export type EvidenceScreenshot = CritiqueEvidence['screenshots'][number]
/** A review or fix-loop finding, the two shapes that can carry `evidence`; `reviewer` gates the critique-only "no screenshot". */
type EvidencedFinding = Pick<ReviewFinding, 'severity' | 'evidence' | 'reviewer'> | Pick<FixLoopFinding, 'severity' | 'evidence' | 'reviewer'>

/** Whether a finding is the critique's (its evidence block renders only for this reviewer). */
export function isCritiqueReviewer(reviewerId: string): boolean {
  return reviewerId === CRITIQUE_REVIEWER_ID
}

/** A finding's evidence, or null when it carries none (every other reviewer's finding and exports before 1.11.0). */
export function evidenceOf(finding: EvidencedFinding): CritiqueEvidence | null {
  return finding.evidence ?? null
}

/** A finding's steps to reproduce in recorded order, or [] when it carries no evidence. */
export function evidenceSteps(finding: EvidencedFinding): string[] {
  return finding.evidence?.steps ?? []
}

/** The screenshot shape `Screenshots.tsx` renders for a critique finding: the artifact id and its caption, no sha256. */
export type CritiqueScreenshot = { artifact_id: string; caption: string }

/**
 * A critique finding's screenshots mapped to the artifact route, in recorded order: each the id, its caption and the URL the
 * thumbnail and the full-size dialog load (`paths.artifact`, the same route the check screenshots use, PRD 4.5).
 */
export function evidenceScreenshots(scope: RunScope, finding: EvidencedFinding): { artifact_id: string; caption: string; url: string }[] {
  return (finding.evidence?.screenshots ?? []).map(shot => ({ artifact_id: shot.artifact_id, caption: shot.caption, url: paths.artifact(scope, shot.artifact_id) }))
}

/**
 * Whether a critique P1 finding has no screenshot: the brief requires one, so the viewer says "no screenshot" when the
 * controller recorded a P1 without one (Appendix A). True for a critique P1 with no screenshots whether its `evidence` is
 * present-but-empty or absent altogether: the engine drops `evidence` for a finding with no steps, and that can include a
 * P1 whose digest did not match evidence.json, so a missing key is still a P1 without a screenshot (design challenge note 1).
 * Only the critique reviewer's findings are judged; every other reviewer's finding (which never carries evidence) is false.
 */
export function missingScreenshot(finding: EvidencedFinding): boolean {
  return isCritiqueReviewer(finding.reviewer) && finding.severity === 'P1' && (finding.evidence?.screenshots.length ?? 0) === 0
}

/**
 * The rounds the "Earlier rounds" list shows: the fix loop's archived review rounds (`archived === true`), in recorded
 * order. A restored round (`archived: false`) is the live review again, not an earlier one, so it is left out (design
 * challenge note 6). A run with no fix loop, or a loop in its error form, has none.
 */
export function archivedRounds(loop: FixLoop | null | undefined): FixLoopReviewRound[] {
  if (!loop || !('review_rounds' in loop)) return []
  return loop.review_rounds.filter(round => round.archived)
}
