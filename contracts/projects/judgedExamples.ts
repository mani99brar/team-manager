/**
 * The review-panel-registry literals (features/review-panel-registry/prd.md Appendix A and B), loaded verbatim for the
 * viewer's contract, unit, server and browser tests: the judged and fallback panel records 1.1.0, the judged review.json, the
 * `judge-states` block (the `pending`, `running` and `incomplete` judge objects, [L2]) and the `plan-panel-judged` block (the
 * pinned `plan.panels[0]` of a judged panel). Nothing here is edited; tests clone before changing anything. Node only (it
 * reads the files), so the viewer bundle never imports it.
 */
import { readFileSync } from 'node:fs'
import type { JudgedPanelRecord, PanelJudge, ReviewResult } from './v1.ts'

const FEATURE = new URL('../../features/review-panel-registry/', import.meta.url)
const read = (name: string): unknown => JSON.parse(readFileSync(new URL(`examples/${name}`, FEATURE), 'utf8'))

/** A fenced JSON block of PRD Appendix B by its marker (`<!-- literal: <name> -->`). */
export function prdLiteral(name: string): unknown {
  const prd = readFileSync(new URL('prd.md', FEATURE), 'utf8')
  const marker = `<!-- literal: ${name} -->`
  const at = prd.indexOf(marker)
  if (at === -1) throw new Error(`PRD Appendix B has no ${marker}`)
  const block = /```json\n([\s\S]*?)\n```/.exec(prd.slice(at + marker.length))
  if (!block) throw new Error(`${marker} is not followed by a JSON block`)
  return JSON.parse(block[1])
}

/** `examples/panel-judged.example.json`: record 1.1.0 after a judged round, blocked by J1. */
export const panelJudgedExample = (): JudgedPanelRecord => read('panel-judged.example.json') as JudgedPanelRecord
/** `examples/panel-fallback.example.json`: the judge timed out, muse not logged in, argon unavailable. */
export const panelFallbackExample = (): JudgedPanelRecord => read('panel-fallback.example.json') as JudgedPanelRecord
/** `examples/review-judged.example.json`: the judged review.json as the controller writes it. */
export const reviewJudgedExample = (): RawReview => read('review-judged.example.json') as RawReview
/** The `judge-states` block: `pending`, `running`, `incomplete`. */
export const judgeStates = (): Record<'pending' | 'running' | 'incomplete', PanelJudge> => prdLiteral('judge-states') as Record<'pending' | 'running' | 'incomplete', PanelJudge>
/** The `plan-panel-judged` block: the pinned `plan.panels[0]` of a judged panel. */
export const planPanelJudged = (): Record<string, unknown> => prdLiteral('plan-panel-judged') as Record<string, unknown>

/** The plan contexts the judged rule is tested under: a judged plan, a legacy plan, a report-only plan. */
export const judgedPlan = () => ({ run_id: 'example-001', panels: [planPanelJudged()] })
export const legacyPlan = () => ({ run_id: 'example-001' })
export const reportOnlyPlan = () => ({ run_id: 'example-001', panels: [{ id: 'review-panel', stage: 'review', providers: [{ transport: 'claude', model: null }], overlap_threshold: 2 }] })

/** review.json as the controller writes it (the raw record; the export adds the reviewer receipts' facts). */
export type RawReview = {
  run_id: string
  bundle_sha256: string
  candidate_commit: string
  reviewer: string
  independent: true
  verdict: 'approved' | 'blocked'
  reviewers: { reviewer_id: string; session_id: string | null; verdict: 'approved' | 'blocked' | null; accepted_at: string | null }[]
  findings: { severity: 'P0' | 'P1' | 'P2'; message: string; disposition: 'open' | 'resolved' | 'accepted'; worker?: string; requirement?: string; reviewer: string }[]
}

/**
 * A raw review.json as the review route serves it (contract 1.4.0): what `server/projects.ts` `projectReview` makes of the
 * export's review section, with the run-wide transport `native`, no diff and no requirement matches. On a judged record (the
 * judged flag and a `judge` entry) a built-in with a verdict has status `accepted`, as the engine writes it; the judge and
 * critique, and every other record, take their status from their verdict.
 */
export function servedReview(raw: RawReview, options: { judgedPanel?: boolean; reviewedAt?: string } = {}): ReviewResult {
  const findings = raw.findings.map(finding => ({
    severity: finding.severity, message: finding.message, disposition: finding.disposition, worker: finding.worker ?? null,
    requirement: finding.requirement ?? null, requirement_found_in: [], reviewer: finding.reviewer,
  }))
  const judged = options.judgedPanel === true && raw.reviewers.some(entry => entry.reviewer_id === 'judge')
  const builtin = (id: string) => id !== 'judge' && id !== 'critique'
  const reviewedAt = options.reviewedAt ?? raw.reviewers.map(entry => entry.accepted_at).filter((at): at is string => at !== null).sort().at(-1) ?? '2026-10-15T10:31:40Z'
  return {
    contract_version: '1.4.0', run_id: raw.run_id, node_id: 'review', attempt: 1,
    reviewer: { session_id: raw.reviewer, transport: 'native', independent: true },
    bundle_sha256: raw.bundle_sha256, candidate_commit: raw.candidate_commit, verdict: raw.verdict, findings,
    reviewers: raw.reviewers.map(entry => ({
      reviewer_id: entry.reviewer_id, transport: 'native', session_id: entry.session_id, verdict: entry.verdict,
      findings: findings.filter(finding => finding.reviewer === entry.reviewer_id), launched_at: null, accepted_at: entry.accepted_at,
      status: entry.verdict === 'approved' || (judged && builtin(entry.reviewer_id) && entry.verdict !== null) ? 'accepted' : 'blocked',
    })),
    reviewed_at: reviewedAt, diff: null,
    ...(options.judgedPanel ? { judged_panel: true as const } : {}),
  }
}

/** The fallback review.json of a judged run (PRD 7.5): today's rule, the built-in reviewers only, any built-in P1 blocks. */
export function fallbackReview(): RawReview {
  const judged = reviewJudgedExample()
  return {
    ...judged,
    reviewer: judged.reviewers.slice(0, 2).map(entry => entry.session_id).join(', '),
    verdict: 'blocked',
    reviewers: judged.reviewers.filter(entry => entry.reviewer_id !== 'judge'),
    findings: [
      { severity: 'P1', message: 'panel.settle can return while a resumed seat is still running (workflow/panel.py:212).', disposition: 'open', worker: 'engine', reviewer: 'general' },
      { severity: 'P1', message: 'No unit test covers the judge-fallback banner.', disposition: 'open', worker: 'viewer', reviewer: 'coverage' },
    ],
  }
}
