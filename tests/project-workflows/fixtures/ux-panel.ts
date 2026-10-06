/**
 * Fixtures of the multi-provider panel (`panel.spec.ts`) (docs/PRD_MULTI_PROVIDER_PANEL.md 4.5, 6 item 2, Appendix A),
 * registered as the workflow `ux-panel`: mock payloads for the worker phase and a `seed` for the candidate phase, merged by
 * `index.ts`.
 *
 * Every run is a 1.9.0 export; the graph is the one every older run has (two lanes `ui`/`adapter`), since the panel has **no
 * graph node** this slice (decisions L4), except `panel-challenge`, whose guarded graph starts with the `challenge` node so the
 * challenge view exists. The records start from Appendix A's two verbatim records (`examples.panelRecord` and
 * `examples.panelPendingRecord`, which the contract test reads from the PRD itself):
 * - `panel-succeeded`: integrated; Appendix A's review panel with a third provider (pi `deepseek/deepseek-v4-pro`, timed out),
 *   f1 accepted by two providers, f2 raised by the openai-codex provider alone (not accepted), f3 unanchored. Export section only.
 * - `panel-pending`: the review is running and the panel has not started: the export's `pending` record.
 * - `panel-live`: the review and the panel are running; the export holds the `pending` record and the live `panel.json` is a
 *   `running` record (providers running, no findings yet). The next poll shows Appendix A's `succeeded` record.
 * - `panel-failed`: integrated; the panel failed before any finding (its `error` set): the claude provider died, pi answered
 *   without findings JSON.
 * - `panel-timed-out`: integrated; every provider timed out, so the panel is `timed_out` with its error.
 * - `panel-challenge`: a guarded run whose workers are still working, with two panels in its export: a `challenge`-stage
 *   panel that succeeded (seeded: the engine writes a live challenge-stage panel only in the follow-up slice) and the review
 *   stage's `pending` panel. The challenge node's page shows the challenge-stage panel alone.
 * - `panel-null`: integrated, `panels: null` (no `plan.panels`): no section.
 * - `panel-invalid`: neither the export section nor the live file is a valid record: 404 `PANELS_NOT_FOUND`, no section.
 * - `panel-old`: a 1.8.0 export (no `panels` key) beside a live `panel.json`: 404, no section, exactly as today.
 */
import { panelPendingRecord, panelRecord } from '../../../contracts/projects/examples.ts'
import type { PanelEntry, PanelRecord, PanelResults, RunDetail, RunInputs, WorkflowDefinition } from '../../../contracts/projects/v1.ts'
import { eventSchema, validateWorkerResult, type WorkerResult, type WorkflowEvent } from '../../../contracts/workflow/v1.ts'
import {
  ADAPTER_ARTIFACTS, ADAPTER_CHECKS, ADAPTER_SESSION, BASE_COMMIT, CANDIDATE_COMMIT, GUARDED_NODES, PROJECT, REVIEWER_SESSION, UI_ARTIFACTS, UI_CHECKS, UI_SESSION,
  adapterTask, artifactRefs, backgroundId, checks, definition, laneGraphNodes, launchToken, offset, projectInputs, runDetail, sha256, uiTask,
  type ArtifactFile, type DefinitionNode, type NodeState, type RawChallenge, type RawInputsSection, type RawWorkerInput,
} from '../fixtures.ts'
import type { InternalEvent, SeedContext } from '../seed.ts'
import type { UxFixtureModule, UxPayloads } from './index.ts'

export const UX_PANEL_WORKFLOW_ID = 'ux-panel'
export const UX_PANEL_WORKFLOW_NAME = 'UX multi-provider panel'
export const RUN_PANEL_SUCCEEDED = 'panel-succeeded'
export const RUN_PANEL_PENDING = 'panel-pending'
export const RUN_PANEL_LIVE = 'panel-live'
export const RUN_PANEL_FAILED = 'panel-failed'
export const RUN_PANEL_TIMED_OUT = 'panel-timed-out'
export const RUN_PANEL_CHALLENGE = 'panel-challenge'
export const RUN_PANEL_NULL = 'panel-null'
export const RUN_PANEL_INVALID = 'panel-invalid'
export const RUN_PANEL_OLD = 'panel-old'
/** Each run with a panel and a run that renders as today (no section), to compare the page with and without. */
export const PANEL_TWINS: readonly [string, string][] = [[RUN_PANEL_SUCCEEDED, RUN_PANEL_NULL], [RUN_PANEL_PENDING, RUN_PANEL_INVALID]]

export const F2_TITLE = 'publication amount read before the reserve lock'
export const F3_TITLE = 'CI workflow pins no Node version'
export const DEEPSEEK_TIMED_OUT = 'timed out after 15 minutes; its process group was stopped'
export const FAILED_ERROR = 'context assembly failed: [Errno 28] No space left on device'
export const CLAUDE_DIED = 'claude --print exited 137 before its result event'
export const PI_PARSE_FAILED = 'the assistant message_end carried no findings JSON (143 KB of prose)'
export const TIMED_OUT_ERROR = 'every provider timed out'
export const CHALLENGE_F1_TITLE = 'the reaper keys off a pid the record cannot carry'

type Row = [clock: string, node: string, status: string, message: string]
type Task = { node_id: string; error: string | null; interrupts: object[]; result: object | null }
type Lane = 'ui' | 'adapter'

/** The runs' day: a year before Appendix A's own times, so these finished runs stay outside the Runs home's Recent window. */
const DAY = '2025-10-04'
const at = (clock: string) => `${DAY}T${clock}Z`
const LANES: readonly Lane[] = ['ui', 'adapter']
const SESSIONS: Record<Lane, string> = { ui: UI_SESSION, adapter: ADAPTER_SESSION }
const SNAPSHOTS: Record<Lane, string> = { ui: 'c1'.repeat(20), adapter: 'c2'.repeat(20) }
const ARTIFACTS: Record<Lane, ArtifactFile[]> = { ui: UI_ARTIFACTS, adapter: ADAPTER_ARTIFACTS }
const BUNDLE = 'b7'.repeat(32)
const CHALLENGE_SESSION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const LAUNCHING = 'Launching or reconciling the exact native session'
const AWAITING = 'Awaiting explicit completion signal; idle is not acceptance'

// ---- Records: Appendix A verbatim, then what the scenarios need --------------------------------------------------------

/** docs/PRD_MULTI_PROVIDER_PANEL.md Appendix A, verbatim (the committed examples, which the contract test reads from the PRD). */
export const APPENDIX_A: PanelRecord = panelRecord
export const APPENDIX_A_PENDING: PanelRecord = panelPendingRecord
const appendixA = (): PanelRecord => structuredClone(APPENDIX_A)
const pendingRecord = (): PanelRecord => structuredClone(APPENDIX_A_PENDING)
const panelOf = (record: PanelRecord): PanelEntry => record.panels[0]

/** The integrated run's record: Appendix A's panel, a third provider that timed out, f2 not accepted and f3 unanchored. */
export function succeededRecord(): PanelRecord {
  const record = appendixA()
  const panel = panelOf(record)
  panel.providers.push({ transport: 'pi', model: 'deepseek/deepseek-v4-pro', effort: null, status: 'timed_out', cost_usd: null, context_bytes: 48213, finding_ids: [], error: DEEPSEEK_TIMED_OUT })
  panel.providers[1].finding_ids = ['f1', 'f2']
  panel.providers[0].finding_ids = ['f1', 'f3']
  panel.findings.push(
    { id: 'f2', severity: 'P2', file: 'packages/api/src/modules/claims/reconcile.ts', line: 118, title: F2_TITLE, detail: 'The amount is read outside the reserve transaction, so a concurrent payout can pass the check.', providers_raised: ['openai-codex/gpt-6-sol'], accepted: false, unanchored: false },
    { id: 'f3', severity: 'P2', file: '.github/workflows/ci.yml', line: null, title: F3_TITLE, detail: 'The workflow file is not part of the review context, so the finding cannot be anchored.', providers_raised: ['claude'], accepted: false, unanchored: true },
  )
  panel.ended_at = '2026-10-06T07:15:00Z'
  return record
}

/** Appendix A's running record: the succeeded one with the statuses `running`, `ended_at` null, no findings and no cost yet. */
export function runningRecord(): PanelRecord {
  const record = appendixA()
  const panel = panelOf(record)
  Object.assign(panel, { status: 'running', ended_at: null, findings: [] })
  for (const provider of panel.providers) Object.assign(provider, { status: 'running', cost_usd: null, finding_ids: [] })
  return record
}

/** The panel failed before any finding (an assembly throw): the claude provider died, pi answered without findings JSON. */
function failedRecord(): PanelRecord {
  const record = appendixA()
  const panel = panelOf(record)
  Object.assign(panel, { status: 'failed', findings: [], error: FAILED_ERROR, ended_at: '2026-10-06T07:00:05Z', context_bytes: null })
  Object.assign(panel.providers[0], { status: 'error', cost_usd: null, context_bytes: null, finding_ids: [], error: CLAUDE_DIED })
  Object.assign(panel.providers[1], { status: 'parse_failed', finding_ids: [], error: PI_PARSE_FAILED })
  return record
}

/** Every provider timed out, so the panel is `timed_out` with its error. */
function timedOutRecord(): PanelRecord {
  const record = appendixA()
  const panel = panelOf(record)
  Object.assign(panel, { status: 'timed_out', findings: [], error: TIMED_OUT_ERROR, ended_at: '2026-10-06T07:15:00Z' })
  for (const provider of panel.providers) Object.assign(provider, { status: 'timed_out', cost_usd: null, finding_ids: [], error: 'timed out after 15 minutes; its process group was stopped' })
  return record
}

/** A challenge-stage panel that succeeded (seeded, decisions L3) beside the review stage's pending panel. */
function challengeRecord(): PanelRecord {
  const challenge = panelOf(appendixA())
  Object.assign(challenge, {
    id: 'challenge-panel', stage: 'challenge', overlap_threshold: 'all', context_bytes: 61004,
    started_at: at('11:55:10'), ended_at: at('11:57:20'),
  })
  challenge.providers[0].context_bytes = 61004
  challenge.providers[1].context_bytes = 61004
  challenge.providers[0].finding_ids = ['f1', 'f2']
  challenge.findings = [
    { id: 'f1', severity: 'P1', file: 'docs/PRD_MULTI_PROVIDER_PANEL.md', line: 150, title: CHALLENGE_F1_TITLE, detail: 'Appendix A pins the record without a pid, so a crashed controller cannot find its orphaned provider jobs on resume.', providers_raised: ['claude', 'openai-codex/gpt-6-sol'], accepted: true, unanchored: false },
    { id: 'f2', severity: 'P2', file: 'features/multi-provider-panel/engine-task.md', line: 40, title: 'the pi fixture capture has no cap', detail: 'A provider that never freelances a severity would be re-run forever.', providers_raised: ['claude'], accepted: false, unanchored: false },
  ]
  const review = panelOf(pendingRecord())
  return { version: '1.0.0', panels: [challenge, review] }
}

/** What the route serves for a record: the contract's two keys and the record (no `node_id`: no graph node this slice). */
export function served(record: PanelRecord, source: PanelResults['source']): PanelResults {
  return { contract_version: '1.9.0', source, ...structuredClone(record) }
}

// ---- Runs --------------------------------------------------------------------------------------------------------------

type Fixture = {
  runId: string
  /** The guarded graph (challenge first): the run page and the challenge node's page both show the Panel section. */
  guarded: boolean
  status: RunDetail['summary']['status']
  events: Row[]
  states: Record<string, NodeState>
  /** Graph values: `launched` (receipts only), `reviewing` (packets and bundle) or `integrated` (and review, approval, commit). */
  values: 'launched' | 'reviewing' | 'integrated'
  next: string[]
  tasks: Task[]
  /** The export version; 1.9.0 unless the run predates the panel. */
  version: '1.8.0' | '1.9.0'
  /** The export's `panels` section and the live `panel.json`; null when absent. */
  section: PanelRecord | null
  live: PanelRecord | null
  /** An export section or live file the server refuses (the seed writes them; the mock serves no record). */
  invalidSection?: unknown
  invalidLive?: string
}

const workRows: Row[] = [
  ['10:00:00', 'adapter', 'running', LAUNCHING],
  ['10:00:01', 'ui', 'running', LAUNCHING],
  ['10:18:00', 'adapter', 'succeeded', 'Worker completion accepted'],
  ['10:19:00', 'ui', 'succeeded', 'Worker completion accepted'],
  ['10:20:00', 'freeze', 'succeeded', 'Immutable snapshots captured; worker-reported checks are not trusted'],
  ['10:20:05', 'verify_ui', 'running', `Attempt 1; revision ${SNAPSHOTS.ui}`],
  ['10:20:05', 'verify_adapter', 'running', `Attempt 1; revision ${SNAPSHOTS.adapter}`],
  ['10:24:00', 'verify_adapter', 'succeeded', 'Required tests and artifacts passed; recorded for the candidate gate: backend-unit'],
  ['10:25:00', 'verify_ui', 'succeeded', 'Required tests and artifacts passed; recorded for the candidate gate: frontend-build, project-workflows-browser'],
  ['10:28:00', 'candidate_ui', 'succeeded', `Combined revision ${CANDIDATE_COMMIT}`],
  ['10:30:00', 'candidate_adapter', 'succeeded', `Combined revision ${CANDIDATE_COMMIT}`],
  ['10:31:00', 'review', 'running', 'Launching reviewer general over the shared review worktree'],
]
const approved: Row = ['10:50:00', 'review', 'approved', REVIEWER_SESSION]
const integrated: Row = ['10:51:05', 'integrate', 'succeeded', `Fast-forwarded to ${CANDIDATE_COMMIT}; no push performed`]
const challengeRows: Row[] = [
  ['11:55:00', 'challenge', 'running', `Design challenge attempt 1: one print job, session ${CHALLENGE_SESSION}`],
  ['11:58:00', 'challenge', 'succeeded', 'Design challenge attempt 1 passed (1 P2 concern(s)); launching workers'],
]
const launchRows: Row[] = [
  ...LANES.map((lane, index): Row => [`11:58:1${index}`, lane, 'running', LAUNCHING]),
  ...LANES.map((lane, index): Row => [`11:58:2${index}`, lane, 'running', AWAITING]),
]

const done = (session: string | null = null): NodeState => ({ status: 'succeeded', attempt: 1, session, result: null })
const verifiedStates: Record<string, NodeState> = {
  launch_ui: done(SESSIONS.ui), launch_adapter: done(SESSIONS.adapter), handoff: done(),
  verify_ui: done(SESSIONS.ui), verify_adapter: done(SESSIONS.adapter), candidate: { ...done(), lanes: LANES.map(lane => ({ worker: lane, attempt: 1 })) },
}
const reviewWait: Task[] = [{ node_id: 'review', error: null, interrupts: [], result: null }]
const HANDOFF_WAIT = { kind: 'worker_handoff', message: 'Awaiting explicit completion signals and automatic freeze.' }
const handoffWait: Task[] = [{ node_id: 'handoff', error: null, interrupts: [HANDOFF_WAIT], result: null }]

const SUCCEEDED: Fixture = {
  runId: RUN_PANEL_SUCCEEDED, guarded: false, status: 'succeeded', version: '1.9.0',
  events: [...workRows, approved, integrated],
  states: { ...verifiedStates, review: done(), approval: done(), integrate: done() },
  values: 'integrated', next: [], tasks: [], section: succeededRecord(), live: null,
}

const PENDING: Fixture = {
  runId: RUN_PANEL_PENDING, guarded: false, status: 'running', version: '1.9.0',
  events: [...workRows],
  states: { ...verifiedStates, review: { status: 'running', attempt: 1 } },
  values: 'reviewing', next: ['review'], tasks: reviewWait, section: pendingRecord(), live: null,
}

const LIVE: Fixture = { ...PENDING, runId: RUN_PANEL_LIVE, section: pendingRecord(), live: runningRecord() }

const FAILED: Fixture = { ...SUCCEEDED, runId: RUN_PANEL_FAILED, section: failedRecord() }
const TIMED_OUT: Fixture = { ...SUCCEEDED, runId: RUN_PANEL_TIMED_OUT, section: timedOutRecord() }
const NULL: Fixture = { ...SUCCEEDED, runId: RUN_PANEL_NULL, section: null }
const INVALID: Fixture = { ...PENDING, runId: RUN_PANEL_INVALID, section: null, invalidSection: { version: '1.0.0', panels: [{ id: 'review-panel', status: 'exploded' }] }, invalidLive: 'not json' }
/** A 1.8.0 export: no `panels` key at all; a live file beside it is not read. */
const OLD: Fixture = { ...SUCCEEDED, runId: RUN_PANEL_OLD, version: '1.8.0', section: null, live: succeededRecord() }

const CHALLENGE: Fixture = {
  runId: RUN_PANEL_CHALLENGE, guarded: true, status: 'running', version: '1.9.0',
  events: [...challengeRows, ...launchRows],
  states: {
    challenge: { status: 'succeeded', attempt: 1, session: CHALLENGE_SESSION },
    ...Object.fromEntries(LANES.map(lane => [`launch_${lane}`, { status: 'running', attempt: 1, session: SESSIONS[lane], result: null }])),
  },
  values: 'launched', next: ['handoff'], tasks: handoffWait, section: challengeRecord(), live: null,
}

const FIXTURES: Fixture[] = [SUCCEEDED, PENDING, LIVE, FAILED, TIMED_OUT, CHALLENGE, NULL, INVALID, OLD]

/** The graph of a run: the two lanes (every older run's graph), or the guarded graph whose launches depend on the challenge. */
export function panelNodes(guarded: boolean): DefinitionNode[] {
  return guarded ? GUARDED_NODES : laneGraphNodes(LANES)
}

const definitions = new Map<boolean, WorkflowDefinition>()
function definitionOf(fixture: Fixture): WorkflowDefinition {
  if (!definitions.has(fixture.guarded)) definitions.set(fixture.guarded, definition(PROJECT.project_id, UX_PANEL_WORKFLOW_ID, UX_PANEL_WORKFLOW_NAME, panelNodes(fixture.guarded)))
  return definitions.get(fixture.guarded)!
}
/** The workflow's current definition: the guarded graph. */
export const UX_PANEL_DEFINITION = definitionOf(CHALLENGE)

const createdAt = (fixture: Fixture) => at(fixture.events[0][0].replace(/:\d\d$/, ':00'))
const updatedAt = (fixture: Fixture) => at(fixture.events.at(-1)![0])
const records = (fixture: Fixture): InternalEvent[] => fixture.events.map(([clock, node, status, message], index) => ({ sequence: index + 1, time: at(clock), node, status, message }))

// ---- The challenge run's inputs (the challenge view reads the challenge from the run inputs) ----------------------------

const challenge: RawChallenge = {
  status: 'passed', attempt: 1, session_id: CHALLENGE_SESSION,
  pinned: { tasks_sha256: sha256('tasks-panel'), decisions_sha256: sha256('decisions-panel'), prd_sha256: sha256('prd-panel') },
  concerns: [{ severity: 'P2', kind: 'failure_mode', message: 'Hard-crash orphans are rerun beside themselves on resume.', consequence: 'Every controller crash during a review doubles the panel\'s provider spend.' }],
  simpler_alternative: 'Run the panel in-process in the review step (adopted).', cheap_experiment: 'Kill the controller mid-panel and count the provider processes left.',
  accepted_reason: null, decided_at: at('11:58:00'), attempts: 1,
}

function rawWorker(lane: Lane, leak: string): RawWorkerInput {
  const started = at(lane === 'ui' ? '11:58:11' : '11:58:10')
  return {
    role: lane === 'ui' ? 'frontend' : 'backend',
    required_check_kinds: lane === 'ui' ? ['build', 'browser'] : ['unit'],
    task: lane === 'ui' ? uiTask(leak) : adapterTask(),
    prompt: null,
    owned_paths: lane === 'ui' ? ['src/projects'] : ['workflow'],
    checks: lane === 'ui' ? UI_CHECKS : ADAPTER_CHECKS,
    launch: {
      session_id: SESSIONS[lane], launch_token: launchToken(lane), launch_requested_at: offset(started), native_started_at: Date.parse(started),
      observed_state: 'working', status: 'attached_session_available', launcher_invocations: 1, background_id: backgroundId(lane),
    },
    completion: null, handoff: null, stop: null, questions: [],
  }
}

function inputsSection(fixture: Fixture, leak: string): RawInputsSection {
  return {
    feature: 'Multi-provider panel', policy_version: '1.2.0', base_commit: BASE_COMMIT, source_branch: `feature/${UX_PANEL_WORKFLOW_ID}/${fixture.runId}`,
    mode: 'automatic',
    automatic: { finish: 'verified-feature-branch', permission_mode: 'bypassPermissions', worker_timeout_seconds: 14400, review_timeout_seconds: 3600, reviewer_transport: 'native' },
    setup: [{ argv: ['npm', 'ci'], command: 'npm ci', timeout_seconds: 600 }],
    max_verification_attempts: 3,
    failure_drill: null,
    selected_workers: [...LANES],
    excluded_workers: [],
    workers: Object.fromEntries(LANES.map(lane => [lane, rawWorker(lane, leak)])),
    decisions: null,
    challenge,
  }
}

// ---- The adapter's projection of the raw rows for the worker-phase mock (as `normalizeEvents` serves them) ---------------

const EVENT_STATUS: Record<string, WorkflowEvent['status']> = {
  running: 'running', interactive: 'running', blocked: 'failed', succeeded: 'succeeded', passed: 'succeeded', approved: 'succeeded', paused: 'paused', interrupted: 'paused',
}
const OWN_ATTEMPT = /^(?:Attempt|Design challenge attempt) (\d+)\b/

function servedEvents(fixture: Fixture): WorkflowEvent[] {
  const known = new Set(definitionOf(fixture).nodes.map(node => node.node_id))
  const lanes: readonly string[] = LANES
  const nodeOf = (node: string) => known.has(node) ? node : node === 'freeze' ? 'handoff' : lanes.includes(node) ? `launch_${node}`
    : node.startsWith('candidate_') && lanes.includes(node.slice('candidate_'.length)) ? 'candidate' : null
  const attempts = new Map<string, number>()
  return records(fixture).map(record => {
    const node_id = nodeOf(record.node)
    let attempt = 0
    if (node_id) {
      const parsed = OWN_ATTEMPT.exec(record.message)
      if (parsed) attempts.set(node_id, Number(parsed[1]))
      attempt = attempts.get(node_id) ?? 1
    }
    const status = node_id ? EVENT_STATUS[record.status] ?? null : null
    const lane = node_id === 'candidate' ? record.node.slice('candidate_'.length) : null
    return eventSchema.parse({
      contract_version: '1.0.0', run_id: fixture.runId, event_id: `${fixture.runId}:${record.sequence}`, sequence: record.sequence, occurred_at: record.time,
      node_id, attempt, type: node_id && status ? 'status_changed' : 'log', status, message: lane ? `[${lane}] ${record.message}` : record.message,
      artifact: null, result_uri: null, reused_from_attempt: null,
    })
  })
}

type Packet = { phase: 'worker' | 'candidate'; lane: Lane; from: string; to: string }
const PACKETS: Packet[] = [
  { phase: 'worker', lane: 'adapter', from: '10:20:10', to: '10:23:55' },
  { phase: 'worker', lane: 'ui', from: '10:20:10', to: '10:24:55' },
  { phase: 'candidate', lane: 'ui', from: '10:25:05', to: '10:27:55' },
  { phase: 'candidate', lane: 'adapter', from: '10:25:05', to: '10:29:55' },
]
const packetsOf = (fixture: Fixture): Packet[] => fixture.values === 'launched' ? [] : PACKETS

/** A verification packet's result: the lane's checks spread over the attempt, all passing. */
function packetResult(runId: string, packet: Packet): WorkerResult {
  const { lane, from, to } = packet
  const commands = lane === 'ui'
    ? ['npm run build', 'npm run test:unit', 'npx --no-install playwright test --config=tests/project-workflows/playwright.config.ts']
    : ['npx --no-install tsx --test server/projects.test.ts']
  const start = Date.parse(at(from))
  const step = (Date.parse(at(to)) - start) / commands.length
  const time = (index: number) => new Date(start + Math.round(step * index)).toISOString().replace(/\.000Z$/, 'Z')
  const logs = ARTIFACTS[lane].filter(file => file.kind === 'log').map(file => file.artifact_id)
  return validateWorkerResult({
    contract_version: '1.0.0', run_id: runId, node_id: lane, attempt: 1, session_id: SESSIONS[lane],
    status: 'succeeded', base_commit: BASE_COMMIT, output_commit: packet.phase === 'candidate' ? CANDIDATE_COMMIT : SNAPSHOTS[lane],
    changed_files: [],
    checks: checks(`verification/${packet.phase}/${lane}/1/worktree`, commands.map((command, index) => ({ command, log: logs[index], exit: 0, start: time(index), finish: time(index + 1) }))),
    open_assumptions: [],
    artifacts: artifactRefs(ARTIFACTS[lane]),
    summary: 'Trusted check capture of the lane; not integration approval.',
    error: null,
  })
}
const resultKey = (packet: Packet) => `${packet.phase === 'candidate' ? `candidate_${packet.lane}` : packet.lane}/1`

const detailOf = (fixture: Fixture): RunDetail => runDetail(fixture.runId, fixture.status, definitionOf(fixture), createdAt(fixture), updatedAt(fixture), fixture.states, fixture.events.length)
/** The live file wins whenever it is valid (no mtime); an export before 1.9.0 serves nothing. */
const servedRecord = (fixture: Fixture): PanelResults | null => fixture.version !== '1.9.0' ? null : fixture.live ? served(fixture.live, 'live') : fixture.section ? served(fixture.section, 'export') : null

/** What the panels route serves for each run in the worker phase. */
export const PANEL_RESULTS: Record<string, PanelResults> = Object.fromEntries(FIXTURES.flatMap(fixture => {
  const result = servedRecord(fixture)
  return result ? [[fixture.runId, result]] : []
}))

/** The live record of `panel-live` once both providers answered: Appendix A's succeeded record (the next poll). */
export function resultAfterProviders(): PanelResults {
  return served(appendixA(), 'live')
}

const payloads: Partial<UxPayloads> = {
  workflows: [UX_PANEL_DEFINITION],
  runDetails: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, detailOf(fixture)])),
  runEvents: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, servedEvents(fixture)])),
  runInputs: Object.fromEntries(FIXTURES.filter(fixture => fixture.guarded).map((fixture): [string, RunInputs] => [fixture.runId, projectInputs(fixture.runId, inputsSection(fixture, '<path>'))])),
  workerResults: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, Object.fromEntries(packetsOf(fixture).map(packet => [resultKey(packet), packetResult(fixture.runId, packet)]))])),
  artifactFiles: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, packetsOf(fixture).length > 0 ? LANES.flatMap(lane => ARTIFACTS[lane]) : []])),
  panelResults: PANEL_RESULTS,
}

function seed({ repository, runsRoot, writeRun, writePacket, receipt, leakFor }: SeedContext) {
  const root = runsRoot(UX_PANEL_WORKFLOW_ID)
  for (const fixture of FIXTURES) {
    const runDir = `${root}/${fixture.runId}`
    const launchedAt = (lane: Lane) => at(fixture.guarded ? (lane === 'ui' ? '11:58:11' : '11:58:10') : lane === 'ui' ? '10:00:01' : '10:00:00')
    writeRun(root, repository, fixture.runId, {
      createdAt: createdAt(fixture), updatedAt: updatedAt(fixture), definitionNodes: panelNodes(fixture.guarded), definitionName: UX_PANEL_WORKFLOW_NAME,
      version: fixture.version, lanes: LANES,
      values: {
        lanes: Object.fromEntries(LANES.map(lane => [lane, receipt(lane, runDir, SESSIONS[lane], launchedAt(lane))])),
        ...(fixture.values !== 'launched' ? {
          snapshots: Object.fromEntries(LANES.map(lane => [lane, SNAPSHOTS[lane]])),
          packets: Object.fromEntries(LANES.map(lane => [lane, `verification/worker/${lane}/1/packet.json`])),
          bundle: { run_id: fixture.runId, base_commit: BASE_COMMIT, candidate_commit: CANDIDATE_COMMIT, policy_sha256: 'e'.repeat(64) },
        } : {}),
        ...(fixture.values === 'integrated' ? {
          review: { run_id: fixture.runId, verdict: 'approved', independent: true, reviewer: REVIEWER_SESSION, findings: [] },
          approved_bundle: BUNDLE, integrated_commit: CANDIDATE_COMMIT,
        } : {}),
      },
      next: fixture.next,
      tasks: fixture.tasks,
      events: records(fixture),
      packets: directory => packetsOf(fixture).map(packet => writePacket(directory, packet.phase, packet.lane, 1, packetResult(fixture.runId, packet), ARTIFACTS[packet.lane], { status: 'passed', reasons: [] })),
      review: null,
      inputs: fixture.guarded ? inputsSection(fixture, leakFor(root, fixture.runId)) : null,
      sidecar: null,
      attack: null,
      panels: fixture.invalidSection ?? fixture.section,
      ...(fixture.live ? { panelFile: fixture.live } : fixture.invalidLive !== undefined ? { panelFile: fixture.invalidLive } : {}),
    })
  }
  return { workflows: [{ workflow_id: UX_PANEL_WORKFLOW_ID, runs_root: root, definition: { name: UX_PANEL_WORKFLOW_NAME, nodes: UX_PANEL_DEFINITION.nodes } }] }
}

export const uxPanel: UxFixtureModule = { payloads, seed }
