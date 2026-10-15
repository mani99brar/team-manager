/**
 * Fixtures of the judged review panel (`judged-panel.spec.ts`, features/review-panel-registry/prd.md 8), registered as the
 * workflow `ux-judged`: mock payloads for the worker phase and a `seed` for the candidate phase, merged by `index.ts`. Every
 * record is the feature's literal example (`features/review-panel-registry/examples/`), loaded verbatim:
 * - `judged-blocked`: the review was decided by the judge (J1 P1 blocks). The export's `panels` section is
 *   `panel-judged.example.json`, its review section `review-judged.example.json` (general and coverage blocked for the record,
 *   judge blocked), and `plan.json` pins the judged panel of PRD Appendix B (`plan-panel-judged`).
 * - `judged-fallback`: the judge timed out, so today's rule decided: the live `panel.json` is `panel-fallback.example.json`
 *   (gpt timed out, muse not logged in, argon unavailable) over the judged export, and the review section is the built-in
 *   reviewers' alone (both block on their P1s).
 * Neither run's graph draws a `reviewer-judge` card ([L12] B2): the mock projects the cards through the server's own
 * `projectSessionNodes` (`sessionProjection.ts`), which leaves the judge out; its one Sessions row is the panel's.
 * The two lanes are the examples' own, `engine` and `viewer`, so the rulings' and findings' lanes are lanes of the run. The
 * report-only 1.0.0 run the legacy scenario reads is `ux-panel`'s `panel-succeeded`, unchanged.
 */
import { fallbackReview, judgedPlan, panelFallbackExample, panelJudgedExample, reviewJudgedExample, type RawReview } from '../../../contracts/projects/judgedExamples.ts'
import type { JudgedPanelRecord, PanelResults, RunDetail, WorkflowDefinition } from '../../../contracts/projects/v1.ts'
import { validateSessions, type SessionRow, type Sessions } from '../../../contracts/projects/sessions.ts'
import { eventSchema, validateWorkerResult, type WorkerResult, type WorkflowEvent } from '../../../contracts/workflow/v1.ts'
import {
  ADAPTER_ARTIFACTS, ADAPTER_CHECKS, BASE_COMMIT, CANDIDATE_COMMIT, PROJECT, UI_ARTIFACTS, UI_CHECKS, adapterTask, artifactRefs, backgroundId, checks, definition, laneGraphNodes,
  launchToken, offset, projectInputs, projectReview, runDetail, sessionFactsOf, uiTask,
  type ArtifactFile, type NodeState, type RawInputsSection, type RawReviewSection, type RawWorkerInput,
} from '../fixtures.ts'
import type { InternalEvent, SeedContext } from '../seed.ts'
import type { UxFixtureModule, UxPayloads } from './index.ts'

export const UX_JUDGED_WORKFLOW_ID = 'ux-judged'
export const UX_JUDGED_WORKFLOW_NAME = 'UX judged review panel'
export const RUN_JUDGED = 'judged-blocked'
export const RUN_JUDGED_FALLBACK = 'judged-fallback'
export const JUDGE_SESSION = '5f0c2a8e-7d4b-4f1e-9a63-2b8d1c0e4f71'

type Lane = 'engine' | 'viewer'
type Row = [clock: string, node: string, status: string, message: string]

// After desk-stale stopped (2026-03-09) and before the Runs home clock, so the capped Paused list still leads with desk-stale.
const DAY = '2026-03-11'
const at = (clock: string) => `${DAY}T${clock}Z`
const LANES: readonly Lane[] = ['engine', 'viewer']
const SESSIONS: Record<Lane, string> = { engine: '44444444-4444-4444-8444-444444444441', viewer: '44444444-4444-4444-8444-444444444442' }
const SNAPSHOTS: Record<Lane, string> = { engine: 'e1'.repeat(20), viewer: 'e2'.repeat(20) }
const ARTIFACTS: Record<Lane, ArtifactFile[]> = { engine: ADAPTER_ARTIFACTS, viewer: UI_ARTIFACTS }
const LAUNCHING = 'Launching or reconciling the exact native session'

const rows: Row[] = [
  ['10:00:00', 'engine', 'running', LAUNCHING],
  ['10:00:01', 'viewer', 'running', LAUNCHING],
  ['10:18:00', 'engine', 'succeeded', 'Worker completion accepted'],
  ['10:19:00', 'viewer', 'succeeded', 'Worker completion accepted'],
  ['10:20:00', 'freeze', 'succeeded', 'Immutable snapshots captured; worker-reported checks are not trusted'],
  ['10:20:05', 'verify_engine', 'running', `Attempt 1; revision ${SNAPSHOTS.engine}`],
  ['10:20:05', 'verify_viewer', 'running', `Attempt 1; revision ${SNAPSHOTS.viewer}`],
  ['10:24:00', 'verify_engine', 'succeeded', 'Required tests and artifacts passed'],
  ['10:25:00', 'verify_viewer', 'succeeded', 'Required tests and artifacts passed'],
  ['10:28:00', 'candidate_engine', 'succeeded', `Combined revision ${CANDIDATE_COMMIT}`],
  ['10:30:00', 'candidate_viewer', 'succeeded', `Combined revision ${CANDIDATE_COMMIT}`],
  ['10:31:00', 'review', 'running', 'Launching reviewers general and coverage and the panel seats over the shared review worktree'],
  ['11:02:00', 'review', 'blocked', 'Review blocked: P1 finding(s) open'],
]

const done = (session: string | null = null): NodeState => ({ status: 'succeeded', attempt: 1, session, result: null })
const states: Record<string, NodeState> = {
  launch_engine: done(SESSIONS.engine), launch_viewer: done(SESSIONS.viewer), handoff: done(),
  verify_engine: done(SESSIONS.engine), verify_viewer: done(SESSIONS.viewer), candidate: { ...done(), lanes: LANES.map(lane => ({ worker: lane, attempt: 1 })) },
  review: { status: 'failed', attempt: 1 },
}

type Fixture = { runId: string; section: JudgedPanelRecord; live: JudgedPanelRecord | null; review: RawReview }
const JUDGED: Fixture = { runId: RUN_JUDGED, section: panelJudgedExample(), live: null, review: reviewJudgedExample() }
const FALLBACK: Fixture = { runId: RUN_JUDGED_FALLBACK, section: panelJudgedExample(), live: panelFallbackExample(), review: fallbackReview() }
const FIXTURES: Fixture[] = [JUDGED, FALLBACK]

const NODES = laneGraphNodes(LANES)
export const UX_JUDGED_DEFINITION: WorkflowDefinition = definition(PROJECT.project_id, UX_JUDGED_WORKFLOW_ID, UX_JUDGED_WORKFLOW_NAME, NODES)

const records = (): InternalEvent[] => rows.map(([clock, node, status, message], index) => ({ sequence: index + 1, time: at(clock), node, status, message }))

/** review.json as the export's review section (1.4.0): its reviewers with their own findings, the run-wide transport native. */
function rawReviewSection(review: RawReview): RawReviewSection {
  const findings = review.findings.map(finding => ({ severity: finding.severity, message: finding.message, disposition: finding.disposition, worker: finding.worker ?? null, requirement: finding.requirement ?? null, reviewer: finding.reviewer }))
  return {
    attempt: 1, transport: 'native', reviewer_session_id: review.reviewer, independent: true, bundle_sha256: review.bundle_sha256, candidate_commit: CANDIDATE_COMMIT,
    verdict: review.verdict, findings, reviewed_at: at('11:02:00'), diff: null,
    reviewers: review.reviewers.map(entry => ({
      reviewer_id: entry.reviewer_id, transport: 'native', session_id: entry.session_id ?? '', verdict: entry.verdict,
      findings: findings.filter(finding => finding.reviewer === entry.reviewer_id), launched_at: null, accepted_at: entry.accepted_at,
      status: entry.verdict === 'approved' ? 'accepted' : 'blocked',
    })),
  }
}

/** The run's inputs: the two lanes `engine` and `viewer` (the server reads a run's lanes from here). */
function inputsSection(leak: string): RawInputsSection {
  const worker = (lane: Lane): RawWorkerInput => ({
    role: lane === 'viewer' ? 'frontend' : 'backend',
    required_check_kinds: lane === 'viewer' ? ['build', 'browser'] : ['unit'],
    task: lane === 'viewer' ? uiTask(leak) : adapterTask(), prompt: null,
    owned_paths: lane === 'viewer' ? ['src/projects'] : ['workflow'],
    checks: lane === 'viewer' ? UI_CHECKS : ADAPTER_CHECKS,
    launch: {
      session_id: SESSIONS[lane], launch_token: launchToken(lane), launch_requested_at: offset(at('10:00:00')), native_started_at: Date.parse(at('10:00:00')),
      observed_state: 'done', status: 'attached_session_available', launcher_invocations: 1, background_id: backgroundId(lane),
    },
    completion: { status: 'completed', summary: `${lane} done`, open_assumptions: [] }, handoff: { summary: `${lane} done`, open_assumptions: [] }, stop: null, questions: [],
  })
  return {
    feature: 'Configurable review panel, step 1', policy_version: '1.2.0', base_commit: BASE_COMMIT, source_branch: 'feature/review-panel-registry/judged', mode: 'automatic',
    automatic: { finish: 'verified-feature-branch', permission_mode: 'bypassPermissions', worker_timeout_seconds: 14400, review_timeout_seconds: 3600, reviewer_transport: 'native' },
    setup: [{ argv: ['npm', 'ci'], command: 'npm ci', timeout_seconds: 600 }], max_verification_attempts: 3, failure_drill: null,
    selected_workers: [...LANES], excluded_workers: [], workers: Object.fromEntries(LANES.map(lane => [lane, worker(lane)])), decisions: null, challenge: null,
  }
}

// ---- The worker-phase projections (what the server serves for the seeded runs) -----------------------------------------

const EVENT_STATUS: Record<string, WorkflowEvent['status']> = { running: 'running', blocked: 'failed', succeeded: 'succeeded', passed: 'succeeded' }

function servedEvents(runId: string): WorkflowEvent[] {
  const known = new Set(NODES.map(node => node.node_id))
  const lanes: readonly string[] = LANES
  const nodeOf = (node: string) => known.has(node) ? node : node === 'freeze' ? 'handoff' : lanes.includes(node) ? `launch_${node}`
    : node.startsWith('candidate_') && lanes.includes(node.slice('candidate_'.length)) ? 'candidate' : null
  return records().map(record => {
    const node_id = nodeOf(record.node)
    const status = node_id ? EVENT_STATUS[record.status] ?? null : null
    const lane = node_id === 'candidate' ? record.node.slice('candidate_'.length) : null
    return eventSchema.parse({
      contract_version: '1.0.0', run_id: runId, event_id: `${runId}:${record.sequence}`, sequence: record.sequence, occurred_at: record.time,
      node_id, attempt: node_id ? 1 : 0, type: node_id && status ? 'status_changed' : 'log', status, message: lane ? `[${lane}] ${record.message}` : record.message,
      artifact: null, result_uri: null, reused_from_attempt: null,
    })
  })
}

type Packet = { phase: 'worker' | 'candidate'; lane: Lane; from: string; to: string }
const PACKETS: Packet[] = [
  { phase: 'worker', lane: 'engine', from: '10:20:10', to: '10:23:55' },
  { phase: 'worker', lane: 'viewer', from: '10:20:10', to: '10:24:55' },
  { phase: 'candidate', lane: 'viewer', from: '10:25:05', to: '10:27:55' },
  { phase: 'candidate', lane: 'engine', from: '10:25:05', to: '10:29:55' },
]

function packetResult(runId: string, packet: Packet): WorkerResult {
  const { lane, from, to } = packet
  const files = ARTIFACTS[lane].filter(file => file.kind === 'log')
  const start = Date.parse(at(from))
  const step = (Date.parse(at(to)) - start) / files.length
  const time = (index: number) => new Date(start + Math.round(step * index)).toISOString().replace(/\.000Z$/, 'Z')
  return validateWorkerResult({
    contract_version: '1.0.0', run_id: runId, node_id: lane, attempt: 1, session_id: SESSIONS[lane],
    status: 'succeeded', base_commit: BASE_COMMIT, output_commit: packet.phase === 'candidate' ? CANDIDATE_COMMIT : SNAPSHOTS[lane],
    changed_files: [],
    checks: checks(`verification/${packet.phase}/${lane}/1/worktree`, files.map((file, index) => ({ command: lane === 'viewer' ? ['npm run build', 'npm run test:unit', 'npx --no-install playwright test --config=tests/project-workflows/playwright.config.ts'][index] ?? 'npm test' : 'npx --no-install tsx --test server/projects.test.ts', log: file.artifact_id, exit: 0, start: time(index), finish: time(index + 1) }))),
    open_assumptions: [], artifacts: artifactRefs(ARTIFACTS[lane]), summary: 'Trusted check capture of the lane; not integration approval.', error: null,
  })
}
const resultKey = (packet: Packet) => `${packet.phase === 'candidate' ? `candidate_${packet.lane}` : packet.lane}/1`

const detailOf = (fixture: Fixture): RunDetail => runDetail(fixture.runId, 'failed', UX_JUDGED_DEFINITION, at('10:00:00'), at('11:02:00'), states, rows.length)
const servedPanels = (fixture: Fixture): PanelResults => ({ contract_version: '1.9.0', source: fixture.live ? 'live' : 'export', ...structuredClone(fixture.live ?? fixture.section) })

/**
 * The panel's rows of the sessions payload, as `server/sessions.ts` writes them for a 1.1.0 record: one per seat (spanning the
 * seats' wait, no resume) and the judge's (the bare resume command). Only the panel rows: the specs read only these.
 */
function sessionsOf(fixture: Fixture): Sessions {
  const panel = (fixture.live ?? fixture.section).panels[0]
  const judge = panel.judge!
  const word: Record<string, string> = { timed_out: 'timed out', auth_required: 'not logged in', usage_limit: 'usage limit reached', model_mismatch: 'wrong model served', error: 'error', parse_failed: 'parse failed' }
  const span = (from: string | null, to: string | null) => from && to ? (Date.parse(to) - Date.parse(from)) / 1000 : null
  // The server writes every row time as `Date.toISOString()` (milliseconds included).
  const iso = (value: string | null) => value === null ? null : new Date(value).toISOString()
  const base = { node_id: 'panel', lane: null, round: null, started_at: null, ended_at: null, duration_seconds: null, session_id: null, resume: null } as const
  const seats: SessionRow[] = panel.providers.map((seat, index) => {
    const ran = seat.status !== 'pending' && seat.status !== 'unavailable'
    const ended = judge.started_at ?? panel.ended_at
    const raised = panel.findings.filter(finding => seat.finding_ids.includes(finding.id))
    const count = (severity: string) => raised.filter(finding => finding.severity === severity).length
    return {
      ...base, key: `panel:0:${index}`, role: 'panel_provider', label: `Panel · ${panel.stage} · ${seat.name}`, transport: seat.transport, model: seat.model,
      status: seat.status === 'ok' ? 'succeeded' : seat.status === 'unavailable' ? 'unknown' : seat.status === 'timed_out' ? 'stopped' : 'failed',
      verdict: seat.status === 'ok' ? null : seat.status === 'unavailable' ? `unavailable: ${seat.error}` : word[seat.status] ?? seat.status,
      findings: ran ? { p0: count('P0'), p1: count('P1'), p2: count('P2') } : null,
      started_at: ran ? iso(panel.started_at) : null, ended_at: ran ? iso(ended) : null, duration_seconds: ran ? span(panel.started_at, ended) : null,
      cost_usd: seat.cost_usd, cost_kind: seat.cost_usd === null ? null : seat.transport === 'pi' ? 'covered' : 'metered',
    }
  })
  const confirmed = judge.rulings.filter(ruling => ruling.ruling === 'confirmed')
  const decided = judge.status === 'judged' && !judge.fallback
  const judgeRow: SessionRow = {
    ...base, key: 'panel:0:judge', role: 'panel_provider', label: `Panel · ${panel.stage} · judge`, transport: 'print', model: judge.model,
    status: judge.status === 'judged' ? 'succeeded' : judge.status === 'timed_out' ? 'stopped' : 'failed',
    verdict: decided ? (confirmed.some(ruling => ruling.severity !== 'P2') ? 'blocked' : 'approved') : 'fallback: today\'s rule decided',
    findings: decided ? { p0: confirmed.filter(r => r.severity === 'P0').length, p1: confirmed.filter(r => r.severity === 'P1').length, p2: confirmed.filter(r => r.severity === 'P2').length } : null,
    started_at: iso(judge.started_at), ended_at: iso(judge.ended_at), duration_seconds: span(judge.started_at, judge.ended_at),
    cost_usd: judge.cost_usd, cost_kind: judge.cost_usd === null ? null : 'metered',
    session_id: judge.session_id, resume: judge.session_id ? { dir: null, command: `claude --resume ${judge.session_id}` } : null,
  }
  // The built-in reviewers' rows (the judge has none of its own: its row is the panel's), as `reviewerRows` writes them.
  const reviewers: SessionRow[] = fixture.review.reviewers.filter(entry => entry.reviewer_id !== 'judge').map(entry => {
    const own = fixture.review.findings.filter(finding => finding.reviewer === entry.reviewer_id && finding.disposition !== 'resolved')
    const count = (severity: string) => own.filter(finding => finding.severity === severity).length
    return {
      ...base, key: `reviewer:${entry.reviewer_id}:1`, role: 'reviewer', label: `Reviewer · ${entry.reviewer_id} · round 1`, node_id: `reviewer-${entry.reviewer_id}`, round: 1,
      transport: 'native', model: null, status: 'succeeded', verdict: entry.verdict, findings: { p0: count('P0'), p1: count('P1'), p2: count('P2') },
      ended_at: iso(entry.accepted_at), cost_usd: null, cost_kind: null, session_id: entry.session_id,
      resume: entry.session_id ? { dir: null, command: `claude --resume ${entry.session_id}` } : null,
    }
  })
  // In start order (a row without a start by its end), stable, as the server sorts them.
  const startOf = (row: SessionRow) => { const value = row.started_at ?? row.ended_at; return value === null ? Number.POSITIVE_INFINITY : Date.parse(value) }
  const sessions = [...seats, ...reviewers, judgeRow].map((row, index) => ({ row, index }))
    .sort((a, b) => (startOf(a.row) - startOf(b.row)) || (a.index - b.index)).map(item => item.row)
  const round6 = (value: number) => Math.round(value * 1e6) / 1e6
  return validateSessions({
    contract_version: '1.13.0', sessions,
    totals: {
      metered_usd: round6(sessions.filter(row => row.cost_kind === 'metered').reduce((sum, row) => sum + (row.cost_usd ?? 0), 0)),
      covered_usd: round6(sessions.filter(row => row.cost_kind === 'covered').reduce((sum, row) => sum + (row.cost_usd ?? 0), 0)),
      not_recorded: sessions.filter(row => row.cost_usd === null).length,
    },
    lane_reviews: [], night_shift: [],
  })
}

const reviewIds = (fixture: Fixture) => fixture.review.reviewers.map(entry => entry.reviewer_id).filter(id => id !== 'judge')

const payloads: Partial<UxPayloads> = {
  reviewerIds: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, sessionFactsOf('1.9.0', rawReviewSection(fixture.review), reviewIds(fixture))])),
  workflows: [UX_JUDGED_DEFINITION],
  runInputs: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, projectInputs(fixture.runId, inputsSection('<path>'))])),
  runDetails: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, detailOf(fixture)])),
  runEvents: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, servedEvents(fixture.runId)])),
  workerResults: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, Object.fromEntries(PACKETS.map(packet => [resultKey(packet), packetResult(fixture.runId, packet)]))])),
  artifactFiles: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, LANES.flatMap(lane => ARTIFACTS[lane])])),
  panelResults: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, servedPanels(fixture)])),
  sessions: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, sessionsOf(fixture)])),
  // The plan pins a judged panel: the review is served with that context (features/review-panel-registry/prd.md 7.4).
  reviewResults: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, projectReview(fixture.runId, rawReviewSection(fixture.review), {}, UX_JUDGED_WORKFLOW_ID, true)])),
}

function seed({ repository, runsRoot, writeRun, writePacket, receipt, leakFor }: SeedContext) {
  const root = runsRoot(UX_JUDGED_WORKFLOW_ID)
  for (const fixture of FIXTURES) {
    const runDir = `${root}/${fixture.runId}`
    writeRun(root, repository, fixture.runId, {
      createdAt: at('10:00:00'), updatedAt: at('11:02:00'), definitionNodes: NODES, definitionName: UX_JUDGED_WORKFLOW_NAME,
      version: '1.9.0', lanes: LANES, reviewers: reviewIds(fixture),
      values: {
        lanes: Object.fromEntries(LANES.map((lane, index) => [lane, receipt(lane, runDir, SESSIONS[lane], at(`10:00:0${index}`))])),
        snapshots: Object.fromEntries(LANES.map(lane => [lane, SNAPSHOTS[lane]])),
        packets: Object.fromEntries(LANES.map(lane => [lane, `verification/worker/${lane}/1/packet.json`])),
        bundle: { run_id: fixture.runId, base_commit: BASE_COMMIT, candidate_commit: CANDIDATE_COMMIT, policy_sha256: 'e'.repeat(64) },
        review: { run_id: fixture.runId, verdict: fixture.review.verdict, independent: true, reviewer: fixture.review.reviewer, findings: fixture.review.findings },
      },
      next: [],
      tasks: [],
      events: records(),
      packets: directory => PACKETS.map(packet => writePacket(directory, packet.phase, packet.lane, 1, packetResult(fixture.runId, packet), ARTIFACTS[packet.lane], { status: 'passed', reasons: [] })),
      review: rawReviewSection(fixture.review),
      inputs: inputsSection(leakFor(root, fixture.runId)),
      sidecar: null,
      attack: null,
      panels: fixture.section,
      ...(fixture.live ? { panelFile: fixture.live } : {}),
      plan: { panels: judgedPlan().panels },
    })
  }
  return { workflows: [{ workflow_id: UX_JUDGED_WORKFLOW_ID, runs_root: root, definition: { name: UX_JUDGED_WORKFLOW_NAME, nodes: UX_JUDGED_DEFINITION.nodes } }] }
}

export const uxJudged: UxFixtureModule = { payloads, seed }
