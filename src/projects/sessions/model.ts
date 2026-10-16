/**
 * The run-sessions card model (docs/PRD_RUN_SESSIONS.md 3.1-3.5): pure functions over the `/sessions` payload that the run
 * page's Sessions section, the stage's reviewer/panel/lane-review cards, the session block on every node page and the
 * night-shift block read. Every value comes from the served payload; where it holds nothing a value is null and the UI says
 * "not recorded". Pure, so the unit tests read the same cards. Nothing here renders a transcript or an absolute path.
 */
import type { JudgedPanelEntry, PanelEntry, PanelProvider, PanelSeat } from '../../../contracts/projects/v1.ts'
import { judgedOpenP01 } from '../node/judgedPanel.ts'
import type { LaneReview, NightShiftDecision, SessionRow, Sessions, SessionTotals } from '../api.ts'
import { panelsAtStage } from '../node/providerPanel.ts'
import { formatSpan } from '../time.ts'
import type { Tone } from '../tone.ts'

export const PANEL_NODE_ID = 'panel'

/** Whether a node id is one of the projected session cards (a reviewer, the panel or a lane review). */
export function isProjectedSessionNode(nodeId: string): boolean {
  return nodeId === PANEL_NODE_ID || nodeId.startsWith('reviewer-') || nodeId.startsWith('lane-review-')
}

/** The role groups of the Sessions list, in the order PRD 3.4 names them. */
export const ROLE_GROUPS: { role: SessionRow['role']; label: string }[] = [
  { role: 'challenge', label: 'Design challenge attempts' },
  { role: 'worker', label: 'Workers' },
  { role: 'repair', label: 'Repairs' },
  { role: 'lane_reviewer', label: 'Lane reviewers' },
  { role: 'reviewer', label: 'Reviewers' },
  { role: 'critique', label: 'Critique' },
  { role: 'sidecar', label: 'Sidecar passes' },
  { role: 'attack', label: 'Attack angles' },
  { role: 'panel_provider', label: 'Panel providers' },
  { role: 'night_shift', label: 'Night-shift providers' },
]

/** The note beside a bare resume command (PRD 3.5): the command only works from the session's own working directory. */
export const RESUME_NOTE = "run it in the session's worktree"
/** The judge's note instead (features/review-panel-registry/prd.md 8): its worktree is removed after it ends, so no `cd`. */
export const JUDGE_RESUME_NOTE = 'its worktree was removed; run it from any directory'

/** A panel judge's row: `panel:<i>:judge`, or `panel:round-<k>:<i>:judge` for an archived round (server/sessions.ts `judgeRow`). */
function isJudgeRow(row: Pick<SessionRow, 'role' | 'key'>): boolean {
  return row.role === 'panel_provider' && /^panel:(?:round-\d+:)?\d+:judge$/.test(row.key)
}

const dollars = (value: number) => `$${value.toFixed(2)}`
/** A single session's cost: a non-zero figure under a cent says so rather than reading "$0.00". */
const sessionDollars = (value: number) => value > 0 && value < 0.005 ? 'under $0.01' : dollars(value)

/** A cost in words: the dollars and whether they are metered (reported by Claude) or a subscription-covered estimate. */
export function costText(cost: number | null, kind: SessionRow['cost_kind']): string {
  if (cost === null) return 'cost not recorded'
  return kind === 'covered' ? `${sessionDollars(cost)} covered` : `${sessionDollars(cost)} reported by Claude`
}

/**
 * The aggregate cost of several rows that may differ in transport (a panel or a lane review): the metered Claude dollars and
 * the subscription-covered estimates are kept apart, never summed into one figure ([P11]). A row with no cost is skipped; when
 * nothing is recorded the text is "cost not recorded".
 */
export function aggregateCostText(rows: readonly { cost_usd: number | null; cost_kind: SessionRow['cost_kind'] }[]): string {
  let metered: number | null = null
  let covered: number | null = null
  for (const row of rows) {
    if (row.cost_usd === null) continue
    if (row.cost_kind === 'covered') covered = (covered ?? 0) + row.cost_usd
    else metered = (metered ?? 0) + row.cost_usd
  }
  const parts: string[] = []
  if (metered !== null) parts.push(costText(metered, 'metered'))
  if (covered !== null) parts.push(costText(covered, 'covered'))
  return parts.length > 0 ? parts.join(' · ') : 'cost not recorded'
}

/** A session's duration as the rest of the app writes spans (`1h00m`, `4m00s`); null when not recorded. */
export function durationText(seconds: number | null): string | null {
  return seconds === null ? null : formatSpan(Math.round(seconds * 1000))
}

/** The open P0/P1 count a card shows; null when the session records no findings of its own. */
export function openP01(findings: SessionRow['findings']): number | null {
  return findings === null ? null : findings.p0 + findings.p1
}

/** A finding count in words with the app's middle dots: "P0 0 · P1 2 · P2 1". */
export function findingCountsText(findings: NonNullable<SessionRow['findings']>): string {
  return `P0 ${findings.p0} · P1 ${findings.p1} · P2 ${findings.p2}`
}

/** The Sessions list grouped by role, each group in the payload's start order (the payload is already sorted). */
export function groupSessions(sessions: Sessions): { role: SessionRow['role']; label: string; rows: SessionRow[] }[] {
  return ROLE_GROUPS
    .map(group => ({ ...group, rows: sessions.sessions.filter(row => row.role === group.role) }))
    .filter(group => group.rows.length > 0)
}

/** The totals line of the Sessions section (PRD 3.4): both costs apart and how many are not recorded, by value. */
export function totalsText(totals: SessionTotals): string {
  return `Metered ${dollars(totals.metered_usd)} reported by Claude · subscription-covered estimates ${dollars(totals.covered_usd)} · ${totals.not_recorded} cost${totals.not_recorded === 1 ? '' : 's'} not recorded`
}

/** The live dock's "Spent" figure from the same totals: both costs apart; null when the run recorded no cost at all. */
export function spentText(totals: SessionTotals): string | null {
  if (totals.metered_usd === 0 && totals.covered_usd === 0) return null
  return `${dollars(totals.metered_usd)} reported by Claude · ${dollars(totals.covered_usd)} covered`
}

/** The one-line cue under the run stage: "Sessions · 7 · $12.40 reported by Claude · $3.10 covered ↓"; null when the Sessions section lists no session. */
export function sessionsCueText(sessions: Sessions): string | null {
  const count = groupSessions(sessions).reduce((sum, group) => sum + group.rows.length, 0)
  if (count === 0) return null
  return `Sessions · ${count} · ${spentText(sessions.totals) ?? 'cost not recorded'} ↓`
}

/** The resume command's parts as the page shows them: the line to copy and the note when it carries no directory. */
export function resumeText(row: SessionRow): { command: string; note: string | null } | null {
  if (row.resume === null) return null
  return { command: row.resume.command, note: row.resume.dir === null ? (isJudgeRow(row) ? JUDGE_RESUME_NOTE : RESUME_NOTE) : null }
}

// ---- Reviewer, panel and lane-review cards -----------------------------------------------------------------------

/** What a projected card shows (PRD 3.1, 3.2): its state word and tone, open P0/P1, cost, one sentence and session facts. */
export type StageCard = {
  word: string
  tone: Tone
  openP01: number | null
  cost: string
  did: string
  startedAt: string | null
  seconds: number | null
  models: string[]
}

/** Every reviewer row for a reviewer node, newest round first (the node page lists the latest then the earlier rounds). */
export function reviewerRoundsOf(sessions: Sessions, nodeId: string): SessionRow[] {
  return sessions.sessions
    .filter(row => (row.role === 'reviewer' || row.role === 'critique') && row.node_id === nodeId)
    .sort((a, b) => (b.round ?? 0) - (a.round ?? 0))
}

/** The latest round's reviewer row for a reviewer node (`reviewer-<id>`). */
export function reviewerRowOf(sessions: Sessions, nodeId: string): SessionRow | null {
  return reviewerRoundsOf(sessions, nodeId)[0] ?? null
}

/**
 * A reviewer's tone from its state word (PRD 3.1, [L11] 2): a blocked or failed reviewer is a finished session that found
 * problems, so its snapshot status reads succeeded while its card carries the fail tone; approved reads ok, running run.
 */
export function reviewerTone(word: string): Tone {
  if (word === 'blocked' || word === 'late blocked' || word === 'failed') return 'fail'
  if (word === 'running') return 'run'
  if (word === 'not started') return 'idle'
  return 'ok'
}

export function laneReviewOf(sessions: Sessions, nodeId: string): LaneReview | null {
  return sessions.lane_reviews.find(review => review.node_id === nodeId) ?? null
}

/** A lane review's reviewer rows (one per reviewer, [L10] 6). */
export function laneReviewerRowsOf(sessions: Sessions, nodeId: string): SessionRow[] {
  return sessions.sessions.filter(row => row.role === 'lane_reviewer' && row.node_id === nodeId)
}

const repairWords = (nodeId: string | null) => (nodeId ?? 'repair').replace(/^repair-/, 'repair ')

/** The fix-round line of a lane review's page (PRD 3.2): the repair it started, or the engine's recorded reason. */
export function fixRoundText(review: LaneReview): string {
  return review.fix_round.started ? `Fix round started: ${repairWords(review.fix_round.repair_node_id)}` : `Recorded; no fix round: ${review.fix_round.reason}`
}

/** The same in short form, for the stage card's state word. */
export function fixRoundShort(review: LaneReview): string {
  return review.fix_round.started ? `${repairWords(review.fix_round.repair_node_id)} started` : 'no fix round'
}

function laneCounts(review: LaneReview): { p0: number; p1: number } {
  return { p0: review.findings.filter(f => f.severity === 'P0').length, p1: review.findings.filter(f => f.severity === 'P1').length }
}

/** A lane review's result in words: "0 P0, 3 P1" (PRD 3.2). */
export function laneResultText(review: LaneReview): string {
  const { p0, p1 } = laneCounts(review)
  return `${p0} P0, ${p1} P1`
}

/** The panel record's fields the card reads (the panels route, contract 1.9.0): a 1.0.0 record's panels or a 1.1.0 record's. */
export type PanelRecordView = { panels: readonly (PanelEntry | JudgedPanelEntry)[] }

/**
 * The panel's state word from its own recorded status ([L12] 1), never from its provider rows: running while any panel runs,
 * failed when any panel failed or timed out, not started while every panel is pending, otherwise reviewed. A provider that
 * timed out inside a panel that succeeded keeps the panel reviewed; its own row says its state.
 */
export function panelWord(record: PanelRecordView): 'running' | 'failed' | 'not started' | 'reviewed' {
  if (record.panels.some(panel => panel.status === 'running')) return 'running'
  if (record.panels.some(panel => panel.status === 'failed' || panel.status === 'timed_out')) return 'failed'
  if (record.panels.every(panel => panel.status === 'pending')) return 'not started'
  return 'reviewed'
}

/** The card of a panel whose state cannot be read: never the node's served `succeeded`, which a failed panel also has (PRD 3.2). */
const panelNotRecorded = (did: string): StageCard => ({ word: 'not recorded', tone: 'idle', openP01: null, cost: 'cost not recorded', did, startedAt: null, seconds: null, models: [] })

/**
 * The panel node's aggregate card (PRD 3.1), from the panel's own record alone ([L12] 1) and only its review-stage panels (a
 * challenge-stage panel belongs to the design challenge, whose page shows it): its state word, how many providers answered
 * (status ok) of how many ran, the open P0/P1 the panel accepted (a finding raised by two providers counts once; a rejected one
 * not at all; a judged panel's are its judge's confirmed P0/P1 rulings), and the providers' costs apart (a `pi` provider's estimate is subscription-covered, a `claude` provider metered,
 * as the server's rows say, [P11]). Until the record has loaded, when the panels route fails, or when it holds no review-stage
 * panel, the card says "not recorded" in the neutral tone: never the node's served status, which reads `succeeded` for a
 * failed panel too, and never a word derived from the provider rows.
 */
export function panelCard(record: PanelRecordView | null): StageCard {
  if (record === null) return panelNotRecorded('The panel record has not loaded, so its state is not recorded.')
  const panels = panelsAtStage(record.panels, 'review')
  if (panels.length === 0) return panelNotRecorded('No review-stage panel is recorded.')
  const word = panelWord({ panels })
  const providers = panels.flatMap((panel): (PanelProvider | PanelSeat)[] => [...panel.providers])
  const answered = providers.filter(provider => provider.status === 'ok').length
  // A judged panel (1.1.0) stands for its judge's confirmed P0/P1 rulings; a report-only one for the findings its overlap rule accepted.
  const open = panels.reduce((sum, panel) => sum + ('judged' in panel
    ? judgedOpenP01(panel) ?? 0
    : panel.findings.filter(finding => finding.accepted && (finding.severity === 'P0' || finding.severity === 'P1')).length), 0)
  const first = [...panels].filter(panel => panel.started_at !== null).sort((a, b) => a.started_at!.localeCompare(b.started_at!))[0] ?? null
  const seconds = first?.started_at && first.ended_at ? (Date.parse(first.ended_at) - Date.parse(first.started_at)) / 1000 : NaN
  const plural = (n: number) => `${n} provider${n === 1 ? '' : 's'}`
  const did = word === 'running' ? `${plural(providers.length)} running; ${answered} answered so far` : word === 'not started' ? 'Not started'
    : `${answered} of ${plural(providers.length)} answered; ${open} open P0/P1`
  return {
    word, tone: word === 'running' ? 'run' : word === 'failed' ? 'fail' : word === 'not started' ? 'idle' : 'ok', openP01: word === 'not started' ? null : open,
    cost: aggregateCostText(providers.map(provider => ({ cost_usd: provider.cost_usd, cost_kind: provider.cost_usd === null ? null : provider.transport === 'pi' ? 'covered' : 'metered' }))),
    did: `${did}.`,
    startedAt: first?.started_at ?? null, seconds: Number.isFinite(seconds) && seconds >= 0 ? seconds : null,
    models: [...new Set(providers.map(provider => provider.model ?? provider.transport))],
  }
}

/**
 * The Panel node page's meaning line (PRD 3.2): the node is `succeeded` once its review-stage panel ended, whatever the
 * outcome (the panel is report-only), so a failed or timed-out panel says so here instead of "This step completed." and the
 * header never reads "The run cannot succeed without intervention."; a record that did not load says its state is not
 * recorded. Null when the header's own wording holds.
 */
export function panelMeaning(record: PanelRecordView | null): string | null {
  if (record === null) return 'The panel record did not load, so whether the panel failed is not recorded.'
  const ended = panelsAtStage(record.panels, 'review').find(panel => panel.status === 'failed' || panel.status === 'timed_out')
  if (!ended) return null
  return `The panel ${ended.status === 'timed_out' ? 'timed out' : 'failed'} (report-only; the run's verdict is unchanged). Its error is below.`
}

/** The stage card facts for a projected node (its state word, tone, open P0/P1, cost and sheet facts); null when the payload has nothing for it, except the panel's, which always has one (`panelCard`). */
export function stageCardOf(sessions: Sessions | null, nodeId: string, panels: PanelRecordView | null = null): StageCard | null {
  if (nodeId === PANEL_NODE_ID) return panelCard(panels)
  if (sessions === null) return null
  if (nodeId.startsWith('reviewer-')) {
    const row = reviewerRowOf(sessions, nodeId)
    if (!row) return null
    const word = row.verdict ?? 'not recorded'
    const open = openP01(row.findings)
    return {
      word, tone: reviewerTone(word), openP01: open, cost: costText(row.cost_usd, row.cost_kind),
      did: `Round ${row.round ?? '?'}: ${word}${open !== null ? `, ${open} open P0/P1` : ''}.`,
      startedAt: row.started_at, seconds: row.duration_seconds, models: row.model ? [row.model] : [],
    }
  }
  if (nodeId.startsWith('lane-review-')) {
    const review = laneReviewOf(sessions, nodeId)
    if (!review) return null
    const counts = laneCounts(review)
    const failed = !review.fix_round.started && review.fix_round.reason.startsWith('the review failed')
    const tone: Tone = review.status === 'running' ? 'run' : review.status === 'pending' ? 'idle' : failed || counts.p0 + counts.p1 > 0 ? 'fail' : 'ok'
    const rows = laneReviewerRowsOf(sessions, nodeId)
    return {
      word: review.status === 'running' ? 'running' : review.status === 'pending' ? 'not started' : fixRoundShort(review), tone,
      openP01: counts.p0 + counts.p1,
      cost: aggregateCostText(review.reviewers.map(reviewer => ({ cost_usd: reviewer.cost_usd, cost_kind: reviewer.cost_usd === null ? null : reviewer.transport === 'pi' || reviewer.transport === 'openrouter' ? 'covered' : 'metered' }))),
      did: `${laneResultText(review)}. ${fixRoundText(review)}.`,
      startedAt: review.started_at, seconds: review.reviewers.find(reviewer => reviewer.duration_seconds !== null)?.duration_seconds ?? null,
      models: [...new Set(rows.map(row => row.model ?? row.transport).filter((value): value is string => value !== null))],
    }
  }
  return null
}

/** The session rows a pinned node page's session blocks show: every row on this node but night shift, the latest round first. */
export function sessionsForNode(sessions: Sessions, nodeId: string): SessionRow[] {
  return sessions.sessions.filter(row => row.node_id === nodeId && row.role !== 'night_shift').sort((a, b) => (b.round ?? 0) - (a.round ?? 0))
}

// ---- Night shift (PRD 3.3) -------------------------------------------------------------------------------------

/** Every night-shift decision that landed on a node (challenge, a question, the approval). */
export function decisionsForNode(sessions: Sessions, nodeId: string): NightShiftDecision[] {
  return sessions.night_shift.filter(decision => decision.node_id === nodeId)
}

/** The run page's one-line count of night-shift decisions (PRD 3.3): "N panel decisions: X executed, Y held". */
export function nightShiftCountText(sessions: Sessions): string | null {
  const total = sessions.night_shift.length
  if (total === 0) return null
  const executed = sessions.night_shift.filter(decision => decision.decision === 'executed').length
  return `${total} panel decision${total === 1 ? '' : 's'}: ${executed} executed, ${total - executed} held`
}

/** The nodes the night shift decided, in decision order, each once: what the run page's count links to. */
export function nightShiftNodes(sessions: Sessions): { nodeId: string; decisions: NightShiftDecision[] }[] {
  const nodes: { nodeId: string; decisions: NightShiftDecision[] }[] = []
  for (const decision of sessions.night_shift) {
    if (decision.node_id === null) continue
    const entry = nodes.find(item => item.nodeId === decision.node_id)
    if (entry) entry.decisions.push(decision)
    else nodes.push({ nodeId: decision.node_id, decisions: [decision] })
  }
  return nodes
}

/** A decision's outcome in words: "Executed" or "Held: <reason>" (PRD 3.3). */
export function outcomeText(decision: NightShiftDecision): string {
  return decision.decision === 'executed' ? 'Executed' : `Held: ${decision.held_reason ?? 'not recorded'}`
}

/** One provider's answer in words: its option, confidence word and whether it needs the operator. */
export function providerText(provider: NightShiftDecision['providers'][number]): string {
  const parts = [provider.option ?? 'no option recorded', `confidence ${provider.confidence ?? 'not recorded'}`]
  if (provider.needs_operator) parts.push('needs the operator')
  return parts.join(' · ')
}

/** Jev's line for a decision (PRD 3.3): its pick with confidence and pass-floor, "Jev not called", or its error. */
export function jevText(jev: NightShiftDecision['jev']): string {
  if (jev === null) return 'Jev not called'
  if ('error' in jev) {
    const notCalled = /^not called\b[\s:(]*(.*?)\)?$/i.exec(jev.error)
    return notCalled ? `Jev not called${notCalled[1] ? ` (${notCalled[1]})` : ''}` : `Jev error: ${jev.error}`
  }
  const confidence = jev.confidence === null ? 'confidence not recorded' : `confidence ${jev.confidence}`
  const floor = jev.pass_floor === null ? 'floor not recorded' : jev.pass_floor ? 'passed the floor' : 'below the floor'
  return `Jev picked ${jev.pick} · ${confidence} · ${floor}`
}
