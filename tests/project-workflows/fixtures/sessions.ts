/**
 * Fixtures of run-sessions (`sessions*.spec.ts`, docs/PRD_RUN_SESSIONS.md), registered as the workflow `ux-sessions` of
 * `PROJECT` (listed under `viewer.expose_run_dir`) and `ux-sessions-hidden` of `UNEXPOSED_PROJECT` (not listed). The
 * worker-phase payloads (the `/sessions` payload and the run detail the mock projects the session nodes onto) and the
 * candidate `seed` derive from the same constants below, so the real server reads the same facts the mock serves; the
 * candidate-phase parity spec compares both. A night-shift folder is seeded beside the registry (the candidate server reads
 * it through `MD_MANAGER_NIGHT_SHIFT_DIR`, set in `playwright.config.ts`).
 *
 * The main run `sessions-run` is a two-lane (server/viewer) run in review round 2, blocked: `general` blocked (one open and
 * one accepted P1, so both still block), `coverage` blocked late, `critique` approved with a P2; round 1 is archived (all
 * three blocked) and fed review repair 2. A multi-provider panel ran (a pi and a claude provider). `server` lane-review round
 * 1 started repair 1 (the record's own `repair`); `viewer` round 1 recorded a P1 and no fix round (the engine's refusal
 * event). Two night-shift decisions name this run's directory: an executed `challenge_paused` (Jev picked) and a held
 * `awaiting_approval` (Jev not called); a third record names this run id but the hidden run's directory, and never shows.
 * The hidden run `sessions-hidden-run` is the same builder under the unexposed project, without night-shift records. The
 * older run `sessions-older` is a 1.4.0 export with one listed reviewer, no lane review and no panel. Every status word is
 * one the controller writes (workflow/automatic.py, critique.py, lane_review.py, panel.py).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateReviewResult, type FixLoop, type PanelResults, type ReviewResult, type RunDetail, type WorkflowDefinition } from '../../../contracts/projects/v1.ts'
import type { NightShiftDecision, Sessions, SessionRow } from '../../../contracts/projects/sessions.ts'
import { definition, done, PROJECT, runDetail, UNEXPOSED_PROJECT, type DefinitionNode, type NodeState } from '../fixtures.ts'
import type { SeedContext } from '../seed.ts'
import type { SessionFacts, UxFixtureModule, UxPayloads } from './index.ts'
import { projectDetail } from './ux-refine.ts'

export const UX_SESSIONS_WORKFLOW_ID = 'ux-sessions'
export const UX_SESSIONS_WORKFLOW_NAME = 'UX run sessions'
export const UX_SESSIONS_HIDDEN_WORKFLOW_ID = 'ux-sessions-hidden'
export const RUN_SESSIONS = 'sessions-run'
export const RUN_SESSIONS_OLDER = 'sessions-older'
export const RUN_SESSIONS_HIDDEN = 'sessions-hidden-run'

const DAY = '2025-09-20'
const at = (clock: string) => `${DAY}T${clock}Z`
const CREATED = at('10:00:00')
const UPDATED = at('12:40:00')

// ---- Sessions ---------------------------------------------------------------------------------------------------
export const SESSION = {
  challenge1: 'd5974d39-f2c8-4e0d-958f-ffd47229d831',
  challenge2: 'd5974d39-f2c8-4e0d-958f-ffd47229d832',
  server: '2ec98f78-7ccf-44c4-9d09-63b372816e19',
  viewer: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  repair1: '7a1c0f3e-2b4d-4c8e-9f60-1a2b3c4d5e61',
  repair2: '7a1c0f3e-2b4d-4c8e-9f60-1a2b3c4d5e62',
  general: '3f2504e0-4f89-41d3-9a0c-0305e82c3306',
  coverage: '85323d9c-d437-4b65-8d21-161b3dfb7b6f',
  critique: 'abda90ef-5635-47b5-a11e-d81f0e899100',
  general1: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  coverage1: '85323d9c-d437-4b65-8d21-161b3dfb7b61',
  critique1: 'c13bc3d3-d518-4457-8d56-54adfd8eccea',
  older: 'bca64ed5-f2eb-40fb-a24f-710533f809f4',
} as const

const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5-5'
const GPT_LANE = 'openai-codex/gpt-6.1-sol'
const GPT_PANEL = 'openai-codex/gpt-6-sol'
const SHA40 = '1234567890abcdef1234567890abcdef12345678'
const SHA64 = 'b'.repeat(64)
const SNAPSHOT_SERVER = '2635fbfe1da48811b687b96c9de4159efc1168b7'
const SNAPSHOT_VIEWER = 'e6cec9dac58e6b821472d56e6c3f085a420fee88'

/** Where each Claude Code session ran, relative to the run directory (the worker-phase `~/` form names them under `runs/`). */
const WORKTREES = { server: 'worktree-server', viewer: 'worktree-viewer', repair1: 'repair-workspace-1', repair2: 'repair-workspace-2', review: 'review-worktree' } as const

// ---- The graph ----------------------------------------------------------------------------------------------------
export const SESSIONS_NODES: DefinitionNode[] = [
  { node_id: 'challenge', label: 'Design challenge', kind: 'review', depends_on: [] },
  { node_id: 'launch_server', label: 'Launch server worker', kind: 'worker', depends_on: ['challenge'] },
  { node_id: 'launch_viewer', label: 'Launch viewer worker', kind: 'worker', depends_on: ['challenge'] },
  { node_id: 'handoff', label: 'Freeze worker handoffs', kind: 'prepare', depends_on: ['launch_server', 'launch_viewer'] },
  { node_id: 'verify_server', label: 'Verify server', kind: 'verification', depends_on: ['handoff'] },
  { node_id: 'verify_viewer', label: 'Verify viewer', kind: 'verification', depends_on: ['handoff'] },
  { node_id: 'candidate', label: 'Verify combined candidate', kind: 'verification', depends_on: ['verify_server', 'verify_viewer'] },
  { node_id: 'review', label: 'Independent review', kind: 'review', depends_on: ['candidate'] },
  { node_id: 'approval', label: 'Integration approval', kind: 'integration', depends_on: ['review'] },
  { node_id: 'integrate', label: 'Integrate candidate', kind: 'integration', depends_on: ['approval'] },
]
/** The older run's minimal integrated graph: the single reviewer plus the gate (a finished run, kept off Runs home). */
const OLDER_NODES: DefinitionNode[] = [
  { node_id: 'review', label: 'Independent review', kind: 'review', depends_on: [] },
  { node_id: 'approval', label: 'Integration approval', kind: 'integration', depends_on: ['review'] },
  { node_id: 'integrate', label: 'Integrate candidate', kind: 'integration', depends_on: ['approval'] },
]

export const SESSIONS_DEFINITION = definition(PROJECT.project_id, UX_SESSIONS_WORKFLOW_ID, UX_SESSIONS_WORKFLOW_NAME, SESSIONS_NODES)
const OLDER_DEFINITION = definition(PROJECT.project_id, UX_SESSIONS_WORKFLOW_ID, UX_SESSIONS_WORKFLOW_NAME, OLDER_NODES)
const HIDDEN_DEFINITION = definition(UNEXPOSED_PROJECT.project_id, UX_SESSIONS_HIDDEN_WORKFLOW_ID, UX_SESSIONS_WORKFLOW_NAME, SESSIONS_NODES)

// ---- The records both phases read ---------------------------------------------------------------------------------

type Finding = { severity: 'P0' | 'P1' | 'P2'; message: string; disposition: 'open' | 'accepted' | 'resolved'; worker: string | null; requirement: string | null }
/** Round 2's findings per reviewer: general's accepted P1 still blocks (isBlockingFinding), critique approved with a P2. */
export const ROUND2_FINDINGS: Record<'general' | 'coverage' | 'critique', Finding[]> = {
  general: [
    { severity: 'P1', message: 'general P1: the sessions route answers 500 for a malformed cost file.', disposition: 'open', worker: null, requirement: null },
    { severity: 'P1', message: 'general P1 b: the totals line sums covered and metered dollars.', disposition: 'accepted', worker: null, requirement: null },
    { severity: 'P2', message: 'general P2: the session block repeats its heading.', disposition: 'open', worker: null, requirement: null },
  ],
  coverage: [{ severity: 'P1', message: 'coverage P1: no test proves the night-shift uniqueness rule.', disposition: 'open', worker: null, requirement: null }],
  critique: [{ severity: 'P2', message: 'critique P2: the resume command wraps mid-word at 390 px.', disposition: 'open', worker: null, requirement: null }],
}
const ROUND1_FINDINGS: (Finding & { reviewer: string })[] = [
  { severity: 'P1', message: 'general round 1: the reviewer cards are missing.', disposition: 'open', worker: null, requirement: null, reviewer: 'general' },
  { severity: 'P1', message: 'coverage round 1: no route test.', disposition: 'open', worker: null, requirement: null, reviewer: 'coverage' },
  { severity: 'P1', message: 'critique round 1: the Sessions list scrolls sideways on a phone.', disposition: 'open', worker: null, requirement: null, reviewer: 'critique' },
]
/** What the lane reviewers found (the record's own findings; `server` started repair 1, `viewer` was refused a fix round). */
export const LANE_FINDINGS = {
  server: { severity: 'P1' as const, file: 'server/dispatch.ts', line: 42, title: 'registry reload not wired', detail: 'The reload path changes an injected array rather than rewriting the registry file.' },
  viewer: { severity: 'P1' as const, file: 'src/viewer/x.ts', line: 7, title: 'unused export', detail: 'A dead export was left behind.' },
}
/** The engine's refusal words (workflow/lane_review.py) and the reason the page shows from them (PRD 3.2, [P10]). */
export const NO_FIX_REASON = 'rounds used up, fix loop off or repair cap'
const LANE = {
  server: { cost: 0.129156, seconds: 28.1, snapshot: SNAPSHOT_SERVER, repair: 1 as number | null },
  viewer: { cost: 0.2, seconds: 37.7, snapshot: SNAPSHOT_VIEWER, repair: null as number | null },
}
/** Costs and durations as the per-session files record them. */
const COST = {
  challenge: [1.5, 1.25], server: 9.17806, viewer: 3.5, repair1: 1.75, repair2: 2.25, general: 4.2, coverage: 3.1,
  critique: 0.4766, critique1: 0.6917, panelPi: 0.2, panelClaude: 1.1, nightClaude1: 0.21, nightClaude2: 0.34, jev: 0.004,
} as const
const SECONDS = { challenge: 240, server: 3464, viewer: 1200, repair: 600, general: 2400, coverage: 2490, critique: 314.608, critique1: 133.4 } as const
/** Each session's start (and end where its files record one), so the Sessions list reads in start order. */
const TIMES = {
  server: at('10:20:00'), viewer: at('10:21:00'), serverEnd: at('11:18:00'), viewerEnd: at('10:41:00'),
  laneStart: at('11:20:00'), laneEnd: at('11:21:00'), repair1: at('11:22:00'), repair1End: at('11:32:00'),
  round1: at('11:35:00'), round1End: at('11:50:00'), repair2: at('11:52:00'), repair2End: at('12:02:00'),
  round2: at('12:05:00'), general2End: at('12:45:00'), coverage2End: at('12:46:30'), critique2End: at('12:10:15'),
  panel: at('12:05:30'), panelEnd: at('12:07:00'), nightChallenge: at('10:05:00'), nightApproval: at('12:50:00'),
} as const

const PANEL_RECORD = {
  version: '1.0.0',
  panels: [{
    id: 'review-panel', stage: 'review', status: 'succeeded', overlap_threshold: 1, context_bytes: 1000, budget_usd: 1, started_at: TIMES.panel, ended_at: TIMES.panelEnd, error: null,
    providers: [
      { transport: 'pi', model: GPT_PANEL, effort: null, status: 'ok', cost_usd: COST.panelPi, context_bytes: 1000, finding_ids: ['f1'], error: null },
      { transport: 'claude', model: null, effort: null, status: 'ok', cost_usd: COST.panelClaude, context_bytes: 1000, finding_ids: [], error: null },
    ],
    findings: [{ id: 'f1', severity: 'P1', file: 'a.ts', line: 1, title: 'panel finding', detail: 'The panel saw a duplicated key.', providers_raised: [GPT_PANEL], accepted: true, unanchored: false }],
  }],
}
export const PANEL: PanelResults = { contract_version: '1.9.0', source: 'export', ...structuredClone(PANEL_RECORD) } as PanelResults

/** The fix loop: repair 1 answered the server lane review (verify_server), repair 2 the archived review round 1. */
const FIX_LOOP = {
  version: '1.0.0', rounds: 3,
  repairs: [
    {
      n: 1, node_id: 'repair-1', mode: 'session', lane: 'server', trigger: 'verify', round: 1, rounds: 3, status: 'applied', by: 'controller',
      recorded_at: TIMES.repair1, applied_at: TIMES.repair1End, blocked_step: 'verify_server', reentered_steps: ['verify_server'],
      reason: 'repair session round 1: verify', workspace_commit: 'c'.repeat(40), session_id: SESSION.repair1, review_round: null,
      findings: [], delta: false, fix_files: ['server/dispatch.ts'], left_behind: [], requested: { model: OPUS, effort: 'medium' },
      gate_reasons: ['lane-review: server round 1: 0 P0, 1 P1'],
    },
    {
      n: 2, node_id: 'repair-2', mode: 'session', lane: 'viewer', trigger: 'review', round: 1, rounds: 3, status: 'applied', by: 'controller',
      recorded_at: TIMES.repair2, applied_at: TIMES.repair2End, blocked_step: 'review', reentered_steps: ['review'],
      reason: 'repair session round 1: review', workspace_commit: 'd'.repeat(40), session_id: SESSION.repair2, review_round: 1,
      findings: ROUND1_FINDINGS, delta: false, fix_files: ['src/projects/sessions/Sessions.tsx'], left_behind: [], requested: { model: OPUS, effort: 'medium' },
      gate_reasons: [],
    },
  ],
  review_rounds: [{
    round: 1, verdict: 'blocked', candidate: SHA40, lane: 'viewer', findings: ROUND1_FINDINGS,
    reviewer_sessions: [SESSION.general1, SESSION.coverage1, SESSION.critique1], started_at: TIMES.round1, archived: true, restored_at: null, repair_n: 2,
    reviewers: [
      { reviewer_id: 'general', verdict: 'blocked', session_id: SESSION.general1 },
      { reviewer_id: 'coverage', verdict: 'blocked', session_id: SESSION.coverage1 },
      { reviewer_id: 'critique', verdict: 'blocked', session_id: SESSION.critique1 },
    ],
  }],
}
const LOOP = { contract_version: '1.10.0', source: 'export', ...structuredClone(FIX_LOOP) } as FixLoop

type ReviewerId = 'general' | 'coverage' | 'critique'
const REVIEWER_IDS: ReviewerId[] = ['general', 'coverage', 'critique']
/** Each round-2 reviewer's export entry facts: its verdict, the controller's status word and its session. */
const ROUND2: Record<ReviewerId, { verdict: 'approved' | 'blocked'; status: 'accepted' | 'blocked'; session: string; end: string; late: boolean }> = {
  general: { verdict: 'blocked', status: 'blocked', session: SESSION.general, end: TIMES.general2End, late: false },
  coverage: { verdict: 'blocked', status: 'blocked', session: SESSION.coverage, end: TIMES.coverage2End, late: true },
  critique: { verdict: 'approved', status: 'accepted', session: SESSION.critique, end: TIMES.critique2End, late: false },
}
const ROUND1_SESSIONS: Record<ReviewerId, string> = { general: SESSION.general1, coverage: SESSION.coverage1, critique: SESSION.critique1 }

/** The export's raw review section of round 2 (the builder the seed writes and the mock's facts read). */
function rawReview() {
  const tagged = REVIEWER_IDS.flatMap(id => ROUND2_FINDINGS[id].map(finding => ({ ...finding, reviewer: id })))
  return {
    attempt: 2, round: 2, transport: 'native', reviewer_session_id: REVIEWER_IDS.map(id => ROUND2[id].session).join(', '), independent: true,
    bundle_sha256: SHA64, candidate_commit: SHA40, verdict: 'blocked', reviewed_at: TIMES.coverage2End, diff: null, delta_from: null, delta_diff: null,
    findings: tagged,
    reviewers: REVIEWER_IDS.map(id => ({
      reviewer_id: id, transport: 'native', session_id: ROUND2[id].session, verdict: ROUND2[id].verdict, status: ROUND2[id].status,
      findings: ROUND2_FINDINGS[id].map(finding => ({ ...finding, reviewer: id })), launched_at: TIMES.round2, accepted_at: ROUND2[id].end,
    })),
  }
}

/** The served review result of round 2 (what the mock's reviews route answers; the server projects the same from the export). */
function reviewResult(runId: string): ReviewResult {
  const raw = rawReview()
  const served = <T extends object>(finding: T) => ({ ...finding, requirement_found_in: [] })
  return validateReviewResult({
    contract_version: '1.4.0', run_id: runId, node_id: 'review', attempt: 2,
    reviewer: { session_id: raw.reviewer_session_id, transport: 'native', independent: true },
    bundle_sha256: SHA64, candidate_commit: SHA40, verdict: 'blocked', findings: raw.findings.map(served),
    reviewers: raw.reviewers.map(entry => ({ ...entry, findings: entry.findings.map(served) })),
    reviewed_at: raw.reviewed_at, round: 2, delta_from: null, delta_diff: null, diff: null,
  })
}

// ---- The night shift ----------------------------------------------------------------------------------------------

const NIGHT_CHALLENGE = {
  kind: 'challenge_paused', node: 'challenge', time: TIMES.nightChallenge,
  providers: [
    { name: 'claude', option: 'accept-challenge', text: 'The clarification is handled inside decisions.md.', confidence: 'medium', needs_operator: false, cost_usd: COST.nightClaude1 },
    { name: 'gpt-6-astra', option: 'accept-challenge', text: 'Agree; accept.', confidence: 'high', needs_operator: false },
  ],
  agreement: 'agree', option: 'accept-challenge',
  jevFile: { pick: 'claude', confidence: 0.82, probabilities: { claude: 0.82, gpt: 0.18 }, floor: 0.6, pass_floor: true, model: 'typesafe/jev-1.13', cost_usd: COST.jev },
}
const NIGHT_APPROVAL = {
  kind: 'awaiting_approval', node: 'approval', time: TIMES.nightApproval,
  providers: [{ name: 'claude', option: 'hold', text: 'Confirm scope in the morning before approving.', confidence: 'high', needs_operator: true, cost_usd: COST.nightClaude2 }],
  agreement: 'one provider', option: 'hold', held: 'one provider; needs the operator', jevInline: { error: 'not called: one provider' },
}
export const NIGHT = { challenge: NIGHT_CHALLENGE, approval: NIGHT_APPROVAL }

// ---- The worker-phase payload (what the server produces from the seed; the parity spec compares the two) ---------------

/** The resume the server composes for a session: `cd ~/'<dir>'` only on the exposed project whose dir exists under HOME. */
type ResumeForm = 'home' | 'bare'
function resumeOf(id: string, dir: string | null, form: ResumeForm, runDirRel: string): SessionRow['resume'] {
  if (form === 'bare' || dir === null) return { dir: null, command: `claude --resume ${id}` }
  const quoted = `~/'${runDirRel}/${dir}'`
  return { dir: quoted, command: `cd ${quoted} && claude --resume ${id}` }
}

function blank({ key, role, label, ...fields }: Pick<SessionRow, 'key' | 'role' | 'label'> & Partial<SessionRow>): SessionRow {
  return {
    key, role, label,
    node_id: null, lane: null, round: null, transport: null, model: null, status: 'unknown', verdict: null, findings: null,
    started_at: null, ended_at: null, duration_seconds: null, cost_usd: null, cost_kind: null, session_id: null, resume: null, ...fields,
  }
}
const span = (start: string, end: string) => (Date.parse(end) - Date.parse(start)) / 1000
const counts = (findings: readonly { severity: string; disposition?: string }[]) => ({
  p0: findings.filter(f => f.severity === 'P0' && f.disposition !== 'resolved').length,
  p1: findings.filter(f => f.severity === 'P1' && f.disposition !== 'resolved').length,
  p2: findings.filter(f => f.severity === 'P2' && f.disposition !== 'resolved').length,
})

/** The night-shift decisions the server serves for the main run (redacted: the run directory reads `<path>`). */
function nightDecisions(): NightShiftDecision[] {
  return [
    {
      kind: NIGHT_CHALLENGE.kind, node_id: NIGHT_CHALLENGE.node, decided_at: new Date(NIGHT_CHALLENGE.time).toISOString(),
      providers: NIGHT_CHALLENGE.providers.map(p => ({ name: p.name, option: p.option, text: p.text, confidence: p.confidence, needs_operator: p.needs_operator, cost_usd: p.cost_usd ?? null, error: null })),
      agreement: NIGHT_CHALLENGE.agreement, jev: { pick: NIGHT_CHALLENGE.jevFile.pick, confidence: NIGHT_CHALLENGE.jevFile.confidence, pass_floor: NIGHT_CHALLENGE.jevFile.pass_floor },
      decision: 'executed', option: NIGHT_CHALLENGE.option, command: 'cd <path> && python -m workflow resume <path> --accept-challenge "clarified" --by panel', held_reason: null,
    },
    {
      kind: NIGHT_APPROVAL.kind, node_id: NIGHT_APPROVAL.node, decided_at: new Date(NIGHT_APPROVAL.time).toISOString(),
      providers: NIGHT_APPROVAL.providers.map(p => ({ name: p.name, option: p.option, text: p.text, confidence: p.confidence, needs_operator: p.needs_operator, cost_usd: p.cost_usd, error: null })),
      agreement: NIGHT_APPROVAL.agreement, jev: NIGHT_APPROVAL.jevInline, decision: 'held', option: NIGHT_APPROVAL.option, command: null, held_reason: NIGHT_APPROVAL.held,
    },
  ]
}

/** The `/sessions` payload for a run of the sessions builder, in the server's row order (role order, then start). */
export function sessionsPayload(runId: string, workflowId: string, form: ResumeForm, night: boolean): Sessions {
  const rel = `runs/${workflowId}/${runId}`
  const iso = (value: string) => new Date(value).toISOString()
  const rows: SessionRow[] = [
    ...[1, 2].map(n => blank({
      key: `challenge:${n}`, role: 'challenge', label: `Design challenge attempt ${n}`, node_id: 'challenge', round: n, transport: 'print', model: OPUS,
      status: 'succeeded', duration_seconds: SECONDS.challenge, cost_usd: COST.challenge[n - 1]!, cost_kind: 'metered',
      session_id: n === 1 ? SESSION.challenge1 : SESSION.challenge2, resume: resumeOf(n === 1 ? SESSION.challenge1 : SESSION.challenge2, null, form, rel),
    })),
    ...(['server', 'viewer'] as const).map(lane => blank({
      key: `worker:${lane}`, role: 'worker', label: `Worker · ${lane}`, node_id: `launch_${lane}`, lane, model: OPUS, status: 'succeeded',
      started_at: iso(TIMES[lane]), ended_at: iso(TIMES[`${lane}End`]), duration_seconds: SECONDS[lane], cost_usd: COST[lane], cost_kind: 'metered',
      session_id: SESSION[lane], resume: resumeOf(SESSION[lane], WORKTREES[lane], form, rel),
    })),
    ...([1, 2] as const).map(n => blank({
      key: `repair:${n}`, role: 'repair', label: `Repair ${n} · ${n === 1 ? 'server' : 'viewer'}`, node_id: `repair-${n}`, lane: n === 1 ? 'server' : 'viewer', round: n,
      model: OPUS, status: 'succeeded', started_at: iso(TIMES[`repair${n}`]), ended_at: iso(TIMES[`repair${n}End`]), duration_seconds: SECONDS.repair,
      cost_usd: COST[`repair${n}`], cost_kind: 'metered', session_id: SESSION[`repair${n}`], resume: resumeOf(SESSION[`repair${n}`], WORKTREES[`repair${n}`], form, rel),
    })),
    ...(['server', 'viewer'] as const).map(lane => blank({
      key: `lane:${lane}:1:1`, role: 'lane_reviewer', label: `Lane review · ${lane} · round 1 · ${GPT_LANE}`, node_id: `lane-review-${lane}-1`, lane, round: 1,
      transport: 'pi', model: GPT_LANE, status: 'succeeded', findings: { p0: 0, p1: 1, p2: 0 }, started_at: iso(TIMES.laneStart), ended_at: iso(TIMES.laneEnd),
      duration_seconds: LANE[lane].seconds, cost_usd: LANE[lane].cost, cost_kind: 'covered',
    })),
    ...REVIEWER_IDS.map(id => blank({
      key: `reviewer:${id}:2`, role: id === 'critique' ? 'critique' : 'reviewer', label: `Reviewer · ${id} · round 2`, node_id: `reviewer-${id}`, round: 2,
      transport: 'native', model: id === 'critique' ? SONNET : OPUS, status: 'succeeded',
      verdict: ROUND2[id].verdict === 'blocked' ? (ROUND2[id].late ? 'late blocked' : 'blocked') : 'approved', findings: counts(ROUND2_FINDINGS[id]),
      started_at: iso(TIMES.round2), ended_at: iso(ROUND2[id].end), duration_seconds: SECONDS[id], cost_usd: COST[id], cost_kind: 'metered',
      session_id: ROUND2[id].session, resume: resumeOf(ROUND2[id].session, id === 'critique' ? null : WORKTREES.review, form, rel),
    })),
    ...REVIEWER_IDS.map(id => blank({
      key: `reviewer:${id}:1`, role: id === 'critique' ? 'critique' : 'reviewer', label: `Reviewer · ${id} · round 1`, node_id: `reviewer-${id}`, round: 1,
      transport: 'native', model: id === 'critique' ? SONNET : null, status: 'succeeded', verdict: 'blocked',
      findings: counts(ROUND1_FINDINGS.filter(f => f.reviewer === id)), started_at: iso(TIMES.round1), ended_at: iso(TIMES.round1End),
      duration_seconds: id === 'critique' ? SECONDS.critique1 : span(TIMES.round1, TIMES.round1End),
      cost_usd: id === 'critique' ? COST.critique1 : null, cost_kind: id === 'critique' ? 'metered' : null,
      session_id: ROUND1_SESSIONS[id], resume: resumeOf(ROUND1_SESSIONS[id], null, form, rel),
    })),
    blank({
      key: 'panel:0:0', role: 'panel_provider', label: `Panel · review · ${GPT_PANEL}`, node_id: 'panel', transport: 'pi', model: GPT_PANEL, status: 'succeeded',
      findings: { p0: 0, p1: 1, p2: 0 }, started_at: iso(TIMES.panel), ended_at: iso(TIMES.panelEnd), duration_seconds: span(TIMES.panel, TIMES.panelEnd),
      cost_usd: COST.panelPi, cost_kind: 'covered',
    }),
    blank({
      key: 'panel:0:1', role: 'panel_provider', label: 'Panel · review · claude', node_id: 'panel', transport: 'claude', model: null, status: 'succeeded',
      findings: { p0: 0, p1: 0, p2: 0 }, started_at: iso(TIMES.panel), ended_at: iso(TIMES.panelEnd), duration_seconds: span(TIMES.panel, TIMES.panelEnd),
      cost_usd: COST.panelClaude, cost_kind: 'metered',
    }),
    ...(night ? [
      ...NIGHT_CHALLENGE.providers.map((p, i) => blank({
        key: `night:0:${i}`, role: 'night_shift', label: `Night shift · challenge_paused · ${p.name}`, node_id: 'challenge', model: p.name, status: 'succeeded',
        verdict: p.option, ended_at: iso(NIGHT_CHALLENGE.time), cost_usd: p.cost_usd ?? null, cost_kind: p.cost_usd === undefined ? null : p.name === 'claude' ? 'metered' : 'covered',
      })),
      blank({
        key: 'night:0:jev', role: 'night_shift', label: 'Night shift · challenge_paused · Jev', node_id: 'challenge', model: NIGHT_CHALLENGE.jevFile.model, status: 'succeeded',
        verdict: NIGHT_CHALLENGE.jevFile.pick, ended_at: iso(NIGHT_CHALLENGE.time), cost_usd: COST.jev, cost_kind: 'covered',
      }),
      ...NIGHT_APPROVAL.providers.map((p, i) => blank({
        key: `night:1:${i}`, role: 'night_shift', label: `Night shift · awaiting_approval · ${p.name}`, node_id: 'approval', model: p.name, status: 'succeeded',
        verdict: p.option, ended_at: iso(NIGHT_APPROVAL.time), cost_usd: p.cost_usd, cost_kind: 'metered',
      })),
    ] : []),
  ]
  // The server's order: by start (else end), rows without either last, ties in role order.
  const time = (row: SessionRow) => row.started_at ?? row.ended_at
  const sessions = rows.map((row, index) => ({ row, index }))
    .sort((a, b) => ((time(a.row) === null ? Infinity : Date.parse(time(a.row)!)) - (time(b.row) === null ? Infinity : Date.parse(time(b.row)!))) || a.index - b.index)
    .map(item => item.row)
  const round6 = (value: number) => Math.round(value * 1e6) / 1e6
  let metered = 0
  let covered = 0
  let notRecorded = 0
  for (const row of sessions) {
    if (row.cost_usd === null) notRecorded += 1
    else if (row.cost_kind === 'covered') covered = round6(covered + row.cost_usd)
    else metered = round6(metered + row.cost_usd)
  }
  return {
    contract_version: '1.13.0', sessions,
    totals: { metered_usd: round6(metered), covered_usd: round6(covered), not_recorded: notRecorded },
    lane_reviews: (['server', 'viewer'] as const).map(lane => ({
      lane, round: 1, node_id: `lane-review-${lane}-1`, snapshot: LANE[lane].snapshot, status: 'reviewed', started_at: iso(TIMES.laneStart), ended_at: iso(TIMES.laneEnd),
      fix_round: LANE[lane].repair !== null ? { started: true as const, repair_node_id: `repair-${LANE[lane].repair}` } : { started: false as const, reason: NO_FIX_REASON },
      reviewers: [{ transport: 'pi', model: GPT_LANE, status: 'ok', duration_seconds: LANE[lane].seconds, cost_usd: LANE[lane].cost, error: null }],
      findings: [LANE_FINDINGS[lane]],
    })),
    night_shift: night ? nightDecisions() : [],
  }
}

// ---- The run's events (both phases) ----------------------------------------------------------------------------

type Event = { sequence: number; time: string; node: string; status: string; message: string }
const EVENTS: Event[] = [
  { sequence: 1, time: at('10:02:00'), node: 'challenge', status: 'running', message: 'Design challenge attempt 1' },
  { sequence: 2, time: at('10:10:00'), node: 'challenge', status: 'succeeded', message: 'Design challenge attempt 2 accepted' },
  { sequence: 3, time: TIMES.server, node: 'server', status: 'running', message: 'Launching the server worker' },
  { sequence: 4, time: TIMES.viewer, node: 'viewer', status: 'running', message: 'Launching the viewer worker' },
  { sequence: 5, time: TIMES.laneStart, node: 'verify_server', status: 'running', message: 'lane_review: server round 1 started, 1 reviewer(s) on 2635fbfe' },
  { sequence: 6, time: TIMES.laneEnd, node: 'verify_server', status: 'running', message: 'lane_review: server round 1: 0 P0, 1 P1 block the lane — a fix round starts' },
  { sequence: 7, time: TIMES.laneStart, node: 'verify_viewer', status: 'running', message: 'lane_review: viewer round 1 started, 1 reviewer(s) on e6cec9da' },
  { sequence: 8, time: TIMES.laneEnd, node: 'verify_viewer', status: 'running', message: `lane_review: viewer round 1: 0 P0, 1 P1 recorded, no fix round (${NO_FIX_REASON})` },
  { sequence: 9, time: TIMES.repair1, node: 'verify_server', status: 'running', message: 'lane_review: server round 1: fix round started as repair-1' },
  { sequence: 10, time: TIMES.round2, node: 'review', status: 'running', message: 'Independent review round 2 started' },
  { sequence: 11, time: TIMES.coverage2End, node: 'review', status: 'blocked', message: 'Independent review blocked the candidate' },
]

// ---- The run details (mock) ----------------------------------------------------------------------------------------

const SESSIONS_STATES: Record<string, NodeState> = {
  challenge: { status: 'succeeded', attempt: 2, session: SESSION.challenge2 },
  launch_server: done(SESSION.server), launch_viewer: done(SESSION.viewer), handoff: done(),
  verify_server: done(), verify_viewer: done(),
  candidate: { ...done(), lanes: [{ worker: 'server', attempt: 1 }, { worker: 'viewer', attempt: 1 }] },
  review: { status: 'failed', attempt: 2, review: 2 }, approval: { status: 'pending', attempt: 0 }, integrate: { status: 'pending', attempt: 0 },
}
const OLDER_STATES: Record<string, NodeState> = { review: { ...done(), review: 1 }, approval: done(), integrate: done() }

function sessionsDetail(runId: string, def: WorkflowDefinition): RunDetail {
  return projectDetail(runDetail(runId, 'failed', def, CREATED, UPDATED, SESSIONS_STATES, EVENTS.length), LOOP, 'failed')
}

/** The raw facts the session-node projection reads for a run of the sessions builder ([L5]): the same review and records. */
const SESSIONS_FACTS: SessionFacts = {
  review: { reviewers: rawReview().reviewers.map(entry => ({ reviewer_id: entry.reviewer_id, status: entry.status })) },
  version: '1.12.0', plan: [...REVIEWER_IDS],
  receipts: Object.fromEntries(REVIEWER_IDS.map(id => [id, { status: ROUND2[id].status }])),
  laneReviews: [{ lane: 'server', round: 1, status: 'reviewed' }, { lane: 'viewer', round: 1, status: 'reviewed' }],
}

const payloads: Partial<UxPayloads> = {
  workflows: [SESSIONS_DEFINITION, HIDDEN_DEFINITION],
  runDetails: {
    [RUN_SESSIONS]: sessionsDetail(RUN_SESSIONS, SESSIONS_DEFINITION),
    [RUN_SESSIONS_HIDDEN]: sessionsDetail(RUN_SESSIONS_HIDDEN, HIDDEN_DEFINITION),
    [RUN_SESSIONS_OLDER]: runDetail(RUN_SESSIONS_OLDER, 'succeeded', OLDER_DEFINITION, CREATED, UPDATED, OLDER_STATES, 3),
  },
  reviewResults: {
    [RUN_SESSIONS]: reviewResult(RUN_SESSIONS),
    [RUN_SESSIONS_HIDDEN]: reviewResult(RUN_SESSIONS_HIDDEN),
  },
  panelResults: { [RUN_SESSIONS]: PANEL, [RUN_SESSIONS_HIDDEN]: PANEL },
  sessions: {
    // The worker phase proves the `~/` form on the exposed project ([L1]); the hidden project never gets it.
    [RUN_SESSIONS]: sessionsPayload(RUN_SESSIONS, UX_SESSIONS_WORKFLOW_ID, 'home', true),
    [RUN_SESSIONS_HIDDEN]: sessionsPayload(RUN_SESSIONS_HIDDEN, UX_SESSIONS_HIDDEN_WORKFLOW_ID, 'bare', false),
  },
  reviewerIds: {
    [RUN_SESSIONS]: SESSIONS_FACTS,
    [RUN_SESSIONS_HIDDEN]: SESSIONS_FACTS,
    [RUN_SESSIONS_OLDER]: { review: { reviewers: [{ reviewer_id: 'review', status: 'accepted' }] }, version: '1.4.0', receipts: { review: { status: 'accepted' } } },
  },
}

export const uxSessions: UxFixtureModule = { payloads, seed }

// ---- The candidate seed --------------------------------------------------------------------------------------------

const writeJson = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)

/** Writes one run of the sessions builder; returns its directory. */
function seedSessionsRun(runsRoot: string, repository: string, runId: string) {
  const runDir = join(runsRoot, runId)
  for (const dir of [...Object.values(WORKTREES), join('lane-review', 'server'), join('lane-review', 'viewer'), join('critique', '1'), join('critique', '2')]) {
    mkdirSync(join(runDir, dir), { recursive: true })
  }
  // Challenge: two attempts, each with a print receipt naming its session, cost and model.
  writeJson(join(runDir, 'challenge.json'), { version: '1.0.0', run_id: runId, status: 'passed', attempt: 2 })
  for (const n of [1, 2]) {
    writeJson(join(runDir, `challenge-${n}.stdout.json`), { session_id: n === 1 ? SESSION.challenge1 : SESSION.challenge2, total_cost_usd: COST.challenge[n - 1], duration_ms: SECONDS.challenge * 1000, modelUsage: { [OPUS]: {} } })
    writeJson(join(runDir, `challenge-${n}.role.json`), { observed_models: [OPUS] })
  }
  // Workers and repairs: interactive receipts (worktree + model), cost files and the workers' completions.
  for (const lane of ['server', 'viewer'] as const) {
    writeJson(join(runDir, `${lane}.interactive.json`), { session_id: SESSION[lane], worktree: join(runDir, WORKTREES[lane]), launch_requested_at: TIMES[lane], requested: { model: OPUS } })
    writeJson(join(runDir, `${lane}.cost.json`), { session_id: SESSION[lane], cost_usd: COST[lane], duration_ms: SECONDS[lane] * 1000, recorded_at: TIMES[`${lane}End`], models: [OPUS] })
    // The worker's completion: the evidence it ended (a cost file alone leaves the session running).
    writeJson(join(runDir, `${lane}.completion.json`), { version: '1.1.0', run_id: runId, node_id: lane, status: 'completed' })
  }
  for (const n of [1, 2] as const) {
    writeJson(join(runDir, `repair-${n}.interactive.json`), { session_id: SESSION[`repair${n}`], worktree: join(runDir, WORKTREES[`repair${n}`]), launch_requested_at: TIMES[`repair${n}`], requested: { model: OPUS } })
    writeJson(join(runDir, `repair-${n}.cost.json`), { session_id: SESSION[`repair${n}`], cost_usd: COST[`repair${n}`], duration_ms: SECONDS.repair * 1000, recorded_at: TIMES[`repair${n}End`], models: [OPUS] })
  }
  // Lane reviews: server round 1 started repair 1 (its own `repair`); viewer round 1 recorded a P1 and no fix round.
  for (const lane of ['server', 'viewer'] as const) {
    writeJson(join(runDir, 'lane-review', lane, '1.json'), {
      version: '1.0.0', lane, round: 1, snapshot: LANE[lane].snapshot, status: 'reviewed', started_at: TIMES.laneStart, ended_at: TIMES.laneEnd, spent_marks: [], repair: LANE[lane].repair,
      reviewers: [{ index: 1, transport: 'pi', model: GPT_LANE, effort: null, status: 'ok', cost_usd: LANE[lane].cost, context_bytes: 1000, duration_seconds: LANE[lane].seconds, cwd: '/tmp/lane-review-x', findings: [LANE_FINDINGS[lane]], error: null }],
    })
    writeJson(join(runDir, 'lane-review', lane, 'r1-1-1.pid'), { pid: 1, cwd: '/tmp/lane-review-x', marker: `--model ${GPT_LANE}`, worktree: null })
  }
  // Reviewers, round 2: the controller's receipts (status words of workflow/automatic.py), launch receipts and costs.
  for (const id of ['general', 'coverage'] as const) {
    writeJson(join(runDir, `automatic-review-${id}.json`), {
      reviewer_id: id, node_id: `review-${id}`, transport: 'native', status: ROUND2[id].status, session_id: ROUND2[id].session,
      accepted_at: ROUND2[id].end, accepted_decision: { verdict: ROUND2[id].verdict, findings: [] }, derived: true, ...(ROUND2[id].late ? { late: true } : {}),
    })
    writeJson(join(runDir, `review-${id}.interactive.json`), { session_id: ROUND2[id].session, worktree: join(runDir, WORKTREES.review), launch_requested_at: TIMES.round2 })
    writeJson(join(runDir, `review-${id}.cost.json`), { session_id: ROUND2[id].session, cost_usd: COST[id], duration_ms: SECONDS[id] * 1000, recorded_at: ROUND2[id].end, models: [OPUS] })
    writeJson(join(runDir, `automatic-review-${id}.round-1.json`), { reviewer_id: id, node_id: `review-${id}`, transport: 'native', status: 'blocked', session_id: ROUND1_SESSIONS[id], accepted_at: TIMES.round1End, accepted_decision: { verdict: 'blocked', findings: [] }, derived: true })
  }
  // The critique: its receipt and each round's own print job (critique/<round>/{status,stdout}.json).
  writeJson(join(runDir, 'automatic-review-critique.json'), { reviewer_id: 'critique', status: 'accepted', reason: null, session_id: SESSION.critique, round: 2, retries: 0, launched_at: TIMES.round2, finished_at: TIMES.critique2End })
  for (const [round, session, cost, seconds] of [[1, SESSION.critique1, COST.critique1, SECONDS.critique1], [2, SESSION.critique, COST.critique, SECONDS.critique]] as const) {
    writeJson(join(runDir, 'critique', String(round), 'status.json'), { reviewer_id: 'critique', round, session_id: session, launched_at: round === 1 ? TIMES.round1 : TIMES.round2, accepted_decision: { verdict: round === 1 ? 'blocked' : 'approved', findings: [] } })
    writeJson(join(runDir, 'critique', String(round), 'stdout.json'), { session_id: session, total_cost_usd: cost, duration_ms: seconds * 1000, modelUsage: { [SONNET]: {} } })
  }
  // The archived round 1 (`review.round-1.json`): every reviewer blocked.
  writeJson(join(runDir, 'review.round-1.json'), {
    run_id: runId, bundle_sha256: SHA64, candidate_commit: SHA40, independent: true, verdict: 'blocked', findings: ROUND1_FINDINGS,
    reviewers: REVIEWER_IDS.map(id => ({
      reviewer_id: id, transport: 'native', session_id: ROUND1_SESSIONS[id], verdict: 'blocked', status: 'blocked',
      findings: ROUND1_FINDINGS.filter(f => f.reviewer === id), launched_at: TIMES.round1, accepted_at: TIMES.round1End,
    })),
  })
  const state = {
    version: '1.12.0', run_id: runId, base_commit: SHA40, created_at: CREATED, updated_at: UPDATED,
    definition: { name: UX_SESSIONS_WORKFLOW_NAME, nodes: SESSIONS_NODES },
    values: { run_id: runId }, next: [], tasks: [{ node_id: 'review', error: 'Independent review blocked the candidate', interrupts: [], result: null }],
    events: EVENTS, verification_packets: [], review: rawReview(), inputs: null, sidecar: null, attack: null, panels: PANEL_RECORD,
    fix_loop: FIX_LOOP, accepted: null,
  }
  writeJson(join(runDir, 'run-state.json'), state)
  writeJson(join(runDir, 'plan.json'), { run_id: runId, base_commit: SHA40, repository, workers: ['server', 'viewer'], reviewers: REVIEWER_IDS.map(id => ({ reviewer_id: id, prompt: 'p' })) })
  writeFileSync(join(runDir, 'events.jsonl'), EVENTS.map(event => JSON.stringify({ ...event, run_id: runId })).join('\n') + '\n')
  return runDir
}

/** The older run: a 1.4.0 export whose review lists the one default reviewer, no lane review, no panel. */
function seedOlderRun(runsRoot: string, repository: string) {
  const runDir = join(runsRoot, RUN_SESSIONS_OLDER)
  mkdirSync(join(runDir, 'review-worktree'), { recursive: true })
  writeJson(join(runDir, 'automatic-review.json'), { reviewer_id: 'review', status: 'accepted', session_id: SESSION.older })
  writeJson(join(runDir, 'review.cost.json'), { session_id: SESSION.older, cost_usd: 2.5, duration_ms: 1200000, recorded_at: UPDATED, models: [OPUS] })
  const review = {
    attempt: 1, transport: 'native', reviewer_session_id: SESSION.older, independent: true, bundle_sha256: SHA64, candidate_commit: SHA40,
    verdict: 'approved', reviewed_at: UPDATED, diff: null, findings: [],
    reviewers: [{ reviewer_id: 'review', transport: 'native', session_id: SESSION.older, verdict: 'approved', status: 'accepted', findings: [], launched_at: CREATED, accepted_at: UPDATED }],
  }
  const events = [
    { sequence: 1, time: UPDATED, node: 'review', status: 'approved', message: 'Independent reviewer approved' },
    { sequence: 2, time: UPDATED, node: 'approval', status: 'succeeded', message: 'Approved' },
    { sequence: 3, time: UPDATED, node: 'integrate', status: 'succeeded', message: 'Integrated' },
  ]
  const state = {
    version: '1.4.0', run_id: RUN_SESSIONS_OLDER, base_commit: SHA40, created_at: CREATED, updated_at: UPDATED,
    definition: { name: UX_SESSIONS_WORKFLOW_NAME, nodes: OLDER_NODES },
    values: { run_id: RUN_SESSIONS_OLDER, review: { run_id: RUN_SESSIONS_OLDER, verdict: 'approved', independent: true, reviewer: 'synthetic', findings: [] }, approved_bundle: 'f'.repeat(64), integrated_commit: SHA40 },
    next: [], tasks: [], events, verification_packets: [], review, inputs: null,
  }
  writeJson(join(runDir, 'run-state.json'), state)
  writeJson(join(runDir, 'plan.json'), { run_id: RUN_SESSIONS_OLDER, base_commit: SHA40, repository })
  writeFileSync(join(runDir, 'events.jsonl'), events.map(event => JSON.stringify({ ...event, run_id: RUN_SESSIONS_OLDER })).join('\n') + '\n')
}

/** The night-shift records: two for the main run (naming its directory, as real records do) and one naming the hidden run's. */
function seedNightShift(dir: string, runDir: string, hiddenRunDir: string) {
  const write = (entry: string, record: unknown, jev?: unknown) => {
    const stateDir = join(dir, DAY, 'states', entry)
    mkdirSync(stateDir, { recursive: true })
    writeJson(join(stateDir, 'record.json'), record)
    if (jev !== undefined) writeJson(join(stateDir, 'jev.json'), jev)
  }
  const key = (time: string, kind: string, node: string) => `${RUN_SESSIONS}|${time}|${kind}|${node}`
  write(`${RUN_SESSIONS}-challenge_paused-100500`, {
    key: key(NIGHT_CHALLENGE.time, NIGHT_CHALLENGE.kind, NIGHT_CHALLENGE.node), run_id: RUN_SESSIONS, kind: NIGHT_CHALLENGE.kind, node: NIGHT_CHALLENGE.node,
    text: `Design challenge attempt 1 paused the run ${runDir}`, providers: NIGHT_CHALLENGE.providers, agreement: NIGHT_CHALLENGE.agreement,
    jev: { pick: NIGHT_CHALLENGE.jevFile.pick, confidence: NIGHT_CHALLENGE.jevFile.confidence, pass_floor: true },
    decision: 'executed', option: NIGHT_CHALLENGE.option,
    command: `cd ${runDir} && python -m workflow resume ${runDir} --accept-challenge "clarified" --by panel`, held_reason: null,
  }, NIGHT_CHALLENGE.jevFile)
  write(`${RUN_SESSIONS}-awaiting_approval-125000`, {
    key: key(NIGHT_APPROVAL.time, NIGHT_APPROVAL.kind, NIGHT_APPROVAL.node), run_id: RUN_SESSIONS, kind: NIGHT_APPROVAL.kind, node: NIGHT_APPROVAL.node,
    text: `Awaiting approval for ${runDir}`, providers: NIGHT_APPROVAL.providers, agreement: NIGHT_APPROVAL.agreement, jev: NIGHT_APPROVAL.jevInline,
    decision: 'held', option: NIGHT_APPROVAL.option, command: null, held_reason: NIGHT_APPROVAL.held,
  })
  // Same run id, another registered run's directory: it belongs to that run, never to this one ([P13]).
  write(`${RUN_SESSIONS}-review_blocked-130000`, {
    key: key(at('13:00:00'), 'review_blocked', 'review'), run_id: RUN_SESSIONS, kind: 'review_blocked', node: 'review',
    text: `Review blocked for ${hiddenRunDir}`, providers: [{ name: 'claude', option: 'hold', text: 'Another run of the same id: not this one.', confidence: 'high', needs_operator: true }],
    agreement: 'one provider', jev: null, decision: 'held', option: 'hold', command: null, held_reason: 'FOREIGN RECORD MUST NOT SHOW',
  })
}

function seed(context: SeedContext) {
  const runsRoot = context.runsRoot(UX_SESSIONS_WORKFLOW_ID)
  const hiddenRoot = context.runsRoot(UX_SESSIONS_HIDDEN_WORKFLOW_ID)
  const runDir = seedSessionsRun(runsRoot, context.repository, RUN_SESSIONS)
  const hiddenRunDir = seedSessionsRun(hiddenRoot, context.repository, RUN_SESSIONS_HIDDEN)
  seedOlderRun(runsRoot, context.repository)
  seedNightShift(context.nightShiftDir, runDir, hiddenRunDir)
  return {
    workflows: [
      { workflow_id: UX_SESSIONS_WORKFLOW_ID, runs_root: runsRoot, definition: { name: UX_SESSIONS_WORKFLOW_NAME, nodes: SESSIONS_NODES } },
      { workflow_id: UX_SESSIONS_HIDDEN_WORKFLOW_ID, runs_root: hiddenRoot, definition: { name: UX_SESSIONS_WORKFLOW_NAME, nodes: SESSIONS_NODES }, project_id: UNEXPOSED_PROJECT.project_id },
    ],
    // The sessions project exposes its run directory; the third project does not ([L1]: the candidate test root is outside
    // HOME, so the exposed resume is bare there too).
    registry: { viewer: { expose_run_dir: [PROJECT.project_id] } },
  }
}
