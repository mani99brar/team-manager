/**
 * The judged panel's model (panel record 1.1.0, features/review-panel-registry/prd.md 7.3, 8): a seat's status in words, its
 * model and cost lines and how long the seats ran; the judge's status, the fallback banner, the rulings grouped Confirmed
 * (P0/P1 first), Deferred, Refuted; and where each source chip of a ruling points (a seat prefix → that seat,
 * `<reviewer_id>-<n>` → that reviewer). Pure (no React), so the section and the unit tests read the same values. Read-only.
 */
import type { JudgedPanelEntry, JudgeReviewerFinding, JudgeRuling, PanelJudge, PanelResults, PanelSeat } from '../../../contracts/projects/v1.ts'
import { costText, isSubscriptionCovered } from './providerPanel.ts'

type Severity = JudgeRuling['severity']
const SEVERITY_RANK: { [severity in Severity]: number } = { P0: 0, P1: 1, P2: 2 }

/** A seat's status in PRD 8's words; `unavailable` adds its reason (`seatStatusText`). */
export const SEAT_STATUS_WORDING: { [status in PanelSeat['status']]: string } = {
  pending: 'pending',
  running: 'running',
  ok: 'ok',
  timed_out: 'timed out',
  error: 'error',
  parse_failed: 'parse failed',
  unavailable: 'unavailable',
  auth_required: 'not logged in',
  usage_limit: 'usage limit reached',
  model_mismatch: 'wrong model served',
}

/** `unavailable: disabled in the reviewer list`; every other status its word alone. */
export function seatStatusText(seat: Pick<PanelSeat, 'status' | 'error'>): string {
  const word = SEAT_STATUS_WORDING[seat.status]
  return seat.status === 'unavailable' && seat.error ? `${word}: ${seat.error}` : word
}

/** The seat's model, the served model beside it when it differs, or `default model` for a claude seat without one. */
export function seatModelText(seat: Pick<PanelSeat, 'model' | 'served_model'>): string {
  const model = seat.model ?? 'default model'
  return seat.served_model !== null && seat.served_model !== seat.model ? `${model} (served ${seat.served_model})` : model
}

/** `not reported` for a null cost (every `cli` seat); `subscription-covered` for an openai-codex seat; the dollars otherwise. */
export function seatCostText(seat: Pick<PanelSeat, 'model' | 'cost_usd'>): string {
  if (seat.cost_usd === null) return 'not reported'
  return isSubscriptionCovered(seat) ? 'subscription-covered' : costText(seat.cost_usd)
}

function span(from: string | null, to: string | null): number | null {
  if (from === null || to === null) return null
  const ms = Date.parse(to) - Date.parse(from)
  return Number.isNaN(ms) || ms < 0 ? null : ms
}

/**
 * How long the seats ran: the record keeps no per-seat times, so every seat that ran reads the seats' wait, from the panel's
 * start to the judge's start (every seat had ended by then, PRD 7.2), or to the panel's end before a judge started. Null for a
 * seat that never ran (`pending`, `unavailable`) and while the times are missing.
 */
export function seatDuration(panel: Pick<JudgedPanelEntry, 'started_at' | 'ended_at' | 'judge'>, seat: Pick<PanelSeat, 'status'>): number | null {
  if (seat.status === 'pending' || seat.status === 'unavailable') return null
  if (seat.status === 'running') return null
  return span(panel.started_at, panel.judge?.started_at ?? panel.ended_at)
}

/** The judge's status in words: a `running` judge is `judging` ([L2]). */
export const JUDGE_STATUS_WORDING: { [status in PanelJudge['status']]: string } = {
  pending: 'not started',
  running: 'judging',
  judged: 'judged',
  failed: 'failed',
  timed_out: 'timed out',
  incomplete: 'incomplete',
}

/** How long the judge ran; null until it ended. */
export function judgeDuration(judge: Pick<PanelJudge, 'started_at' | 'ended_at'>): number | null {
  return span(judge.started_at, judge.ended_at)
}

/** The fallback banner (PRD 8): shown exactly when today's rule decided. Null otherwise. */
export function fallbackBanner(judge: Pick<PanelJudge, 'status' | 'fallback'> | undefined): string | null {
  if (!judge || !judge.fallback) return null
  return `Judge ${JUDGE_STATUS_WORDING[judge.status]}: the built-in reviewers decided (today's rule); panel findings are unjudged`
}

export type RulingGroup = { ruling: JudgeRuling['ruling']; label: string; rulings: JudgeRuling[] }

const GROUPS: { ruling: JudgeRuling['ruling']; label: string }[] = [
  { ruling: 'confirmed', label: 'Confirmed' },
  { ruling: 'deferred', label: 'Deferred' },
  { ruling: 'refuted', label: 'Refuted' },
]

/** `J2` before `J10`. */
function byNumber(a: { id: string }, b: { id: string }): number {
  const number = (id: string) => Number(/(\d+)$/.exec(id)?.[1] ?? NaN)
  const [x, y] = [number(a.id), number(b.id)]
  if (!Number.isNaN(x) && !Number.isNaN(y) && x !== y) return x - y
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** The rulings grouped Confirmed, Deferred, Refuted (empty groups left out); each group by severity (P0/P1 first), then J id. */
export function groupRulings(rulings: readonly JudgeRuling[]): RulingGroup[] {
  return GROUPS.map(group => ({
    ...group,
    rulings: rulings.filter(ruling => ruling.ruling === group.ruling).sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || byNumber(a, b)),
  })).filter(group => group.rulings.length > 0)
}

/** `workflow/panel.py:212`; the file alone without a line; null without a file. */
export function rulingLocation(ruling: Pick<JudgeRuling, 'file' | 'line'>): string | null {
  if (ruling.file === null) return null
  return ruling.line === null ? ruling.file : `${ruling.file}:${ruling.line}`
}

/** `lane engine`; `no lane` for `none` or a missing worker. */
export function laneText(worker: string | null): string {
  return worker === null || worker === 'none' ? 'no lane' : `lane ${worker}`
}

export type SourceTarget = { kind: 'seat'; name: string } | { kind: 'reviewer'; reviewerId: string }

/**
 * Where a ruling's source id points: the seat whose prefix it carries (`C1` → the claude seat), else the reviewer the judge
 * read it from (`general-1` → general, from `reviewer_findings`, else the id's `<reviewer_id>-<n>` form). Null when it reads as
 * neither (the chip then shows its id without a link).
 */
export function sourceTarget(source: string, panel: Pick<JudgedPanelEntry, 'providers' | 'judge'>): SourceTarget | null {
  const seat = /^([A-Z])\d+$/.exec(source)
  if (seat) {
    const owner = panel.providers.find(candidate => candidate.prefix === seat[1])
    return owner ? { kind: 'seat', name: owner.name } : null
  }
  const read = panel.judge?.reviewer_findings.find(finding => finding.id === source)
  if (read) return { kind: 'reviewer', reviewerId: read.reviewer }
  const reviewer = /^([a-z][a-z0-9-]*?)-\d+$/.exec(source)
  return reviewer ? { kind: 'reviewer', reviewerId: reviewer[1] } : null
}

/**
 * A built-in reviewer's findings as the judge read them (`reviewer_findings` of the judged review panels), in record order.
 * On a judged review the recorded findings are the judge's and critique's only, so this is where a reviewer's own finding (the
 * target of its source chip) is kept. Empty for a 1.0.0 record, no record, a reviewer the judge read nothing from, or a judge
 * that did not decide (fallback, or any status but `judged`): there the built-in reviewers decided and are never advisory.
 */
export function judgeReadFindings(record: Pick<PanelResults, 'version' | 'panels'> | null, reviewerId: string): JudgeReviewerFinding[] {
  if (record === null || record.version !== '1.1.0') return []
  return (record.panels as JudgedPanelEntry[])
    .filter(panel => panel.stage === 'review')
    .filter(panel => panel.judge !== undefined && panel.judge.status === 'judged' && !panel.judge.fallback)
    .flatMap(panel => panel.judge?.reviewer_findings.filter(finding => finding.reviewer === reviewerId) ?? [])
}

/** The element id of a seat's line, the target of its source chips (stable per panel and seat name). */
export function seatAnchorId(panelId: string, seatName: string): string {
  return `panel-${panelId}-seat-${seatName}`.replace(/[^A-Za-z0-9_-]/g, '-')
}

/** The reviewer's own graph node (the projected `reviewer-<id>` card and page). */
export function reviewerNodeId(reviewerId: string): string {
  return `reviewer-${reviewerId}`
}

/** `3 seats ok, 1 not ok` for the headline; a pending or running seat counts as neither. */
export function seatCounts(panel: Pick<JudgedPanelEntry, 'providers'>): { ok: number; notOk: number } {
  const ended = panel.providers.filter(seat => seat.status !== 'pending' && seat.status !== 'running')
  const ok = ended.filter(seat => seat.status === 'ok').length
  return { ok, notOk: ended.length - ok }
}

/** `2 confirmed (1 P0/P1), 1 deferred, 1 refuted` (PRD 7.7's words). */
export function rulingCountsText(rulings: readonly JudgeRuling[]): string {
  const of = (ruling: JudgeRuling['ruling']) => rulings.filter(candidate => candidate.ruling === ruling)
  const confirmed = of('confirmed')
  const blocking = confirmed.filter(ruling => ruling.severity !== 'P2').length
  return `${confirmed.length} confirmed (${blocking} P0/P1), ${of('deferred').length} deferred, ${of('refuted').length} refuted`
}

/** The open P0/P1 a judged panel stands for: its confirmed P0/P1 rulings; null when the judge did not decide. */
export function judgedOpenP01(panel: Pick<JudgedPanelEntry, 'judge'>): number | null {
  if (!panel.judge || panel.judge.status !== 'judged' || panel.judge.fallback) return null
  return panel.judge.rulings.filter(ruling => ruling.ruling === 'confirmed' && ruling.severity !== 'P2').length
}
