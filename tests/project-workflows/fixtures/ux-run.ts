/**
 * Fixtures of viewer UX slice S3, the run page (`ux-run.spec.ts`) (docs/PRD_VIEWER_UX.md 12.2), registered as the
 * workflow `ux-run`: mock payloads for the worker phase and a `seed` for the candidate phase, merged by `index.ts`.
 *
 * Each run is written once, as the controller's own records (`events.jsonl` rows, graph values, tasks and verification
 * packets) in the shapes `workflow/automatic.py` and `workflow/repair.py` write them, with their real message texts. The
 * candidate phase seeds exactly those; the worker phase serves them as the adapter projects them today (before B1): a row
 * naming a lane, `freeze` or `candidate_<lane>` is attributed to its graph node, a controller row is node-less with no
 * status, `blocked` is served failed and `interrupted` paused, and the run directory is redacted to `<path>`.
 *
 * - `run-identical`: two lanes; the combined candidate failed identically for lane ui on attempts 1 and 2, with no
 *   diagnosis row and no review (situation `blocked_identical`). Its focus row is the sixth of nine.
 * - `run-repaired`: one lane; verification failed identically twice, the controller's node-less diagnosis followed, then
 *   5m37s of operator time, the operator's repair 1 and its node-less "applied" row; the run waits for its continuation
 *   (`interrupted`, case d). Three controller PID checkpoints sit in the controller log.
 * - `run-deadline`: two lanes; the controller blocked the wait for handoffs when ui's deadline ran out
 *   (`blocked_before_freeze`).
 * - `run-review-interrupted`: Ctrl-C while the reviewers worked; the review node recorded its own resume note and no
 *   controller row exists, so the run is paused (`interrupted`, case b).
 * - `run-freeze-interrupted`: Claude Code was unavailable while the freeze stopped the workers; the freeze recorded its
 *   resume note and keeps its task error, so the run is served failed (`interrupted`, case b).
 * - `run-controller-interrupted`: the supervisor was interrupted while the workers ran (`interrupted`, case a).
 * - `run-awaiting-approval`: a manual run whose reviewed bundle waits for the integration approval (`awaiting_approval`).
 * - `run-pane`: ui needs attention in its pane while the run waits for handoffs (`pane_attention`).
 */
import type { ReviewResult, RunDetail, RunInputs, WorkflowDefinition } from '../../../contracts/projects/v1.ts'
import { eventSchema, validateWorkerResult, type WorkerResult, type WorkflowEvent } from '../../../contracts/workflow/v1.ts'
import {
  ADAPTER_ARTIFACTS, ADAPTER_CHECKS, ADAPTER_SESSION, BASE_COMMIT, CANDIDATE_COMMIT, OUTPUT_COMMIT_ADAPTER, OUTPUT_COMMIT_UI, PATH_TOKEN, PROJECT,
  REVIEWER_SESSION, UI_ARTIFACTS, UI_CHECKS, UI_SESSION, adapterTask, artifactRefs, backgroundId, checks, definition, laneGraphNodes, launchToken,
  offset, projectInputs, projectReview, runDetail, uiTask,
  type ArtifactFile, type DefinitionNode, type NodeState, type RawInputsSection, type RawReviewSection, type RawWorkerInput,
} from '../fixtures.ts'
import type { InternalEvent, SeedContext } from '../seed.ts'
import type { UxFixtureModule, UxPayloads } from './index.ts'

export const UX_RUN_WORKFLOW_ID = 'ux-run'
export const UX_RUN_WORKFLOW_NAME = 'UX run'
export const RUN_IDENTICAL = 'run-identical'
export const RUN_REPAIRED = 'run-repaired'
export const RUN_DEADLINE = 'run-deadline'
export const RUN_REVIEW_INTERRUPTED = 'run-review-interrupted'
export const RUN_FREEZE_INTERRUPTED = 'run-freeze-interrupted'
export const RUN_CONTROLLER_INTERRUPTED = 'run-controller-interrupted'
export const RUN_AWAITING_APPROVAL = 'run-awaiting-approval'
export const RUN_PANE = 'run-pane'

/** The candidate gate's reason on both of lane ui's failed combined attempts. */
export const CANDIDATE_FAILURE = 'project-workflows-browser: expected one screenshot for scenario run-now-banner, found none'
/** The worker gate's reasons on both of `run-repaired`'s failed verification attempts. */
export const VERIFY_FAILURE = 'frontend-unit: no passing test evidence or failed tests; project-workflows-browser: no passing test evidence or failed tests'
export const DEADLINE_MESSAGE = 'Worker ui deadline exhausted; no automatic relaunch'
/** The reviewed bundle `run-awaiting-approval` waits to have approved; the approve command carries it. */
export const APPROVAL_BUNDLE = '3c'.repeat(32)

type Lane = 'ui' | 'adapter'
type Row = [clock: string, node: string, status: string, message: string]
type Task = { node_id: string; error: string | null; interrupts: object[]; result: object | null }
type Packet = { phase: 'worker' | 'candidate'; lane: Lane; attempt: number; from: string; to: string; failure?: string }
type Values = { lanes?: boolean; snapshots?: boolean; packets?: boolean; bundle?: boolean; review?: boolean }

type Fixture = {
  runId: string
  lanes: readonly Lane[]
  status: RunDetail['summary']['status']
  mode: 'automatic' | 'manual'
  /** Every lane's completion signal was recorded. */
  completed: boolean
  /** When the workers' stops were confirmed; null while they still run. */
  stoppedAt: string | null
  /** The controller's rows in order: time of day (UTC), node, raw status, message; `{run}` stands for the run directory. */
  events: Row[]
  /** The snapshot the adapter projects from those records, for the worker-phase mock. */
  states: Record<string, NodeState>
  packets: Packet[]
  /** Which graph values the export holds: launch receipts, frozen snapshots, verified packets, the candidate bundle, the review. */
  values: Values
  next: string[]
  tasks: Task[]
  review?: RawReviewSection
}

const DAY = '2026-03-02'
const CREATED_AT = `${DAY}T09:00:00Z`
const at = (clock: string) => `${DAY}T${clock}Z`
/** Where a message names the run directory: `<path>` once served, the real directory in the candidate phase's raw rows. */
const RUN_DIR = '{run}'
const SESSIONS: Record<Lane, string> = { ui: UI_SESSION, adapter: ADAPTER_SESSION }
const COMMITS: Record<Lane, string> = { ui: OUTPUT_COMMIT_UI, adapter: OUTPUT_COMMIT_ADAPTER }
const ARTIFACTS: Record<Lane, ArtifactFile[]> = { ui: UI_ARTIFACTS, adapter: ADAPTER_ARTIFACTS }
const TWO_LANES: readonly Lane[] = ['ui', 'adapter']

const LAUNCHING = 'Launching or reconciling the exact native session'
const AWAITING = 'Awaiting explicit completion signal; idle is not acceptance'
const pid = (clock: string, n: number): Row => [clock, 'controller', 'running', `Automatic checkpoint controller PID ${n}`]
const launch = (lanes: readonly Lane[]): Row[] => [
  ...lanes.map((lane): Row => ['09:00:10', lane, 'running', LAUNCHING]),
  ...lanes.map((lane): Row => ['09:00:14', lane, 'running', AWAITING]),
]
const freeze = (clock: string, lanes: readonly Lane[]): Row[] => [
  [clock, 'freeze', 'stopped', `Native workers stopped before snapshot capture: ${lanes.join(', ')}`],
  [clock, 'freeze', 'succeeded', 'Immutable snapshots captured; worker-reported checks are not trusted'],
]
const verifyStart = (clock: string, lane: Lane, attempt = 1): Row => [clock, `verify_${lane}`, 'running', `Attempt ${attempt}; revision ${COMMITS[lane]}`]
const verifyPass = (clock: string, lane: Lane): Row => [clock, `verify_${lane}`, 'succeeded',
  `Required tests and artifacts passed; recorded for the candidate gate: ${lane === 'ui' ? 'frontend-build, project-workflows-browser' : 'backend-unit'}`]
const candidate = (clock: string, lane: Lane, status: string): Row => [clock, `candidate_${lane}`, status, `Combined revision ${CANDIDATE_COMMIT}`]

/** automatic.py REVIEW_RESUME_NOTE, FREEZE_RESUME_NOTE and RESUME_NOTE, and repair.py's note, as the controller writes them. */
const REVIEW_RESUME_NOTE = `Controller interrupted while waiting for the reviewers. The native reviewer sessions were NOT stopped and keep running; resume with: python -m workflow automatic ${RUN_DIR} --live`
const FREEZE_RESUME_NOTE = `The freeze was stopping the workers: resume completes the stops it recorded (<lane>.stop.json) and relaunches nothing. Once \`claude\` works, resume with: python -m workflow automatic ${RUN_DIR} --live`
const RESUME_NOTE = `Supervisor interrupted. Native workers were NOT stopped and keep running; resume with: python -m workflow automatic ${RUN_DIR} --live`
const OUTAGE = 'Claude Code unavailable for 60s: `claude --version` did not answer'
const REPAIR_NOTE = 'Repair 1 by the operator: snapshot 50b14b3c = abcdef12 + b27d726a on snapshot abcdef12 (tests/reporters/testSummary.ts, vitest.config.ts). '
  + `Reason: The verifier parses only Node TAP summaries; a reporter now prints the counts in that form. Answers worker/ui attempt 2: ${VERIFY_FAILURE}. `
  + `Continue with python -m workflow automatic ${RUN_DIR} --live`
const HANDOFF_WAIT = { kind: 'worker_handoff', message: 'Awaiting explicit completion signals and automatic freeze.' }
const handoffWait: Task[] = [{ node_id: 'handoff', error: null, interrupts: [HANDOFF_WAIT], result: null }]

const done = (session: string | null = null, result: string | null = null): NodeState => ({ status: 'succeeded', attempt: 1, session, result })
const running = (lane: Lane): NodeState => ({ status: 'running', attempt: 1, session: SESSIONS[lane] })
const launched = (lanes: readonly Lane[], results = true) => Object.fromEntries(lanes.map(lane => [`launch_${lane}`, done(SESSIONS[lane], results ? lane : null)]))
const verified = (lanes: readonly Lane[]) => Object.fromEntries(lanes.map(lane => [`verify_${lane}`, done(SESSIONS[lane], lane)]))
const combinedPassed: NodeState = { ...done(), lanes: [{ worker: 'ui', attempt: 1 }, { worker: 'adapter', attempt: 1 }] }

const FIXTURES: Fixture[] = [
  {
    runId: RUN_IDENTICAL, lanes: TWO_LANES, status: 'failed', mode: 'automatic', completed: true, stoppedAt: at('09:31:40'),
    events: [
      ...launch(TWO_LANES), pid('09:00:16', 4101), ...freeze('09:31:40', TWO_LANES),
      verifyStart('09:31:40', 'ui'), verifyStart('09:31:40', 'adapter'), verifyPass('09:33:10', 'adapter'), verifyPass('09:36:20', 'ui'),
      pid('09:36:22', 4102),
      candidate('09:39:05', 'adapter', 'succeeded'),
      candidate('09:41:30', 'ui', 'blocked'),
      pid('09:41:32', 4103),
      candidate('09:44:05', 'ui', 'blocked'),
      pid('09:44:06', 4104),
    ],
    states: {
      ...launched(TWO_LANES), handoff: done(), ...verified(TWO_LANES),
      candidate: { status: 'failed', attempt: 2, lanes: [{ worker: 'ui', attempt: 2 }, { worker: 'adapter', attempt: 1 }] },
    },
    packets: [
      { phase: 'worker', lane: 'adapter', attempt: 1, from: '09:31:45', to: '09:33:05' },
      { phase: 'worker', lane: 'ui', attempt: 1, from: '09:31:45', to: '09:36:15' },
      { phase: 'candidate', lane: 'adapter', attempt: 1, from: '09:36:30', to: '09:39:00' },
      { phase: 'candidate', lane: 'ui', attempt: 1, from: '09:39:10', to: '09:41:28', failure: CANDIDATE_FAILURE },
      { phase: 'candidate', lane: 'ui', attempt: 2, from: '09:41:40', to: '09:44:02', failure: CANDIDATE_FAILURE },
    ],
    values: { lanes: true, snapshots: true, packets: true },
    next: ['candidate'],
    tasks: [{ node_id: 'candidate', error: 'Combined candidate lane ui failed identically on attempts 1 and 2', interrupts: [], result: null }],
  },
  {
    runId: RUN_REPAIRED, lanes: ['ui'], status: 'paused', mode: 'automatic', completed: true, stoppedAt: at('09:28:31'),
    events: [
      ...launch(['ui']), pid('09:00:16', 5101), ...freeze('09:28:31', ['ui']),
      verifyStart('09:28:31', 'ui'),
      ['09:29:38', 'verify_ui', 'blocked', VERIFY_FAILURE],
      pid('09:29:41', 5102),
      verifyStart('09:29:41', 'ui', 2),
      ['09:30:48', 'verify_ui', 'blocked', VERIFY_FAILURE],
      pid('09:30:50', 5103),
      ['09:30:50', 'controller', 'blocked', `worker/ui failed identically on attempts 1 and 2; not transient, inspect ${RUN_DIR} Before review a code fix is a lane repair (RUNBOOK)`],
      ['09:36:27', 'verify_ui', 'paused', REPAIR_NOTE],
      ['09:36:27', 'controller', 'running', 'Repair 1 applied: checkpoint forked from 1f1b7f90 (after handoff); attempts worker:ui 3'],
    ],
    states: { ...launched(['ui']), handoff: done(), verify_ui: { status: 'paused', attempt: 2, session: UI_SESSION, result: 'ui' } },
    packets: [
      { phase: 'worker', lane: 'ui', attempt: 1, from: '09:28:35', to: '09:29:36', failure: VERIFY_FAILURE },
      { phase: 'worker', lane: 'ui', attempt: 2, from: '09:29:45', to: '09:30:46', failure: VERIFY_FAILURE },
    ],
    // The repair forked the checkpoint from after the handoff, so verification holds no recorded packet any more.
    values: { lanes: true, snapshots: true },
    next: ['verify_ui'],
    tasks: [],
  },
  {
    runId: RUN_DEADLINE, lanes: TWO_LANES, status: 'failed', mode: 'automatic', completed: false, stoppedAt: null,
    events: [...launch(TWO_LANES), pid('09:00:16', 6101), ['11:00:16', 'controller', 'blocked', DEADLINE_MESSAGE]],
    states: { launch_ui: running('ui'), launch_adapter: running('adapter'), handoff: { status: 'failed', attempt: 1 } },
    packets: [],
    values: { lanes: true },
    next: ['handoff'],
    tasks: handoffWait,
  },
  {
    runId: RUN_REVIEW_INTERRUPTED, lanes: TWO_LANES, status: 'paused', mode: 'automatic', completed: true, stoppedAt: at('09:30:00'),
    events: [
      ...launch(TWO_LANES), pid('09:00:16', 7101), ...freeze('09:30:00', TWO_LANES),
      verifyStart('09:30:00', 'ui'), verifyStart('09:30:00', 'adapter'), verifyPass('09:31:20', 'adapter'), verifyPass('09:34:10', 'ui'),
      pid('09:34:12', 7102),
      candidate('09:36:40', 'adapter', 'succeeded'),
      candidate('09:38:50', 'ui', 'succeeded'),
      pid('09:38:52', 7103),
      ['09:38:53', 'review', 'running', 'Launching reviewer review over the shared review worktree'],
      ['09:45:10', 'review', 'interrupted', REVIEW_RESUME_NOTE],
    ],
    states: { ...launched(TWO_LANES), handoff: done(), ...verified(TWO_LANES), candidate: combinedPassed, review: { status: 'paused', attempt: 1 } },
    packets: [
      { phase: 'worker', lane: 'ui', attempt: 1, from: '09:30:05', to: '09:34:05' },
      { phase: 'worker', lane: 'adapter', attempt: 1, from: '09:30:05', to: '09:31:15' },
      { phase: 'candidate', lane: 'ui', attempt: 1, from: '09:34:20', to: '09:38:45' },
      { phase: 'candidate', lane: 'adapter', attempt: 1, from: '09:34:20', to: '09:36:35' },
    ],
    values: { lanes: true, snapshots: true, packets: true, bundle: true },
    next: ['review'],
    tasks: [],
  },
  {
    runId: RUN_FREEZE_INTERRUPTED, lanes: TWO_LANES, status: 'failed', mode: 'automatic', completed: true, stoppedAt: null,
    events: [...launch(TWO_LANES), pid('09:00:16', 8101), ['09:40:00', 'freeze', 'interrupted', `${OUTAGE}. ${FREEZE_RESUME_NOTE}`]],
    states: { ...launched(TWO_LANES, false), handoff: { status: 'failed', attempt: 1 } },
    packets: [],
    values: { lanes: true },
    next: ['handoff'],
    tasks: [{ node_id: 'handoff', error: OUTAGE, interrupts: [HANDOFF_WAIT], result: null }],
  },
  {
    runId: RUN_CONTROLLER_INTERRUPTED, lanes: TWO_LANES, status: 'paused', mode: 'automatic', completed: false, stoppedAt: null,
    events: [...launch(TWO_LANES), pid('09:00:16', 9101), ['09:20:00', 'controller', 'interrupted', RESUME_NOTE]],
    states: { launch_ui: running('ui'), launch_adapter: running('adapter'), handoff: { status: 'paused', attempt: 1 } },
    packets: [],
    values: { lanes: true },
    next: ['handoff'],
    tasks: handoffWait,
  },
  {
    runId: RUN_AWAITING_APPROVAL, lanes: TWO_LANES, status: 'awaiting_approval', mode: 'manual', completed: true, stoppedAt: at('09:25:00'),
    events: [
      ...TWO_LANES.map((lane): Row => ['09:00:10', lane, 'running', LAUNCHING]),
      ['09:25:00', 'freeze', 'succeeded', 'Immutable snapshots captured; worker-reported checks are not trusted'],
      verifyStart('09:25:00', 'ui'), verifyStart('09:25:00', 'adapter'), verifyPass('09:26:20', 'adapter'), verifyPass('09:29:10', 'ui'),
      candidate('09:31:40', 'adapter', 'succeeded'),
      candidate('09:33:50', 'ui', 'succeeded'),
      ['09:40:30', 'review', 'approved', 'Independent reviewer approved the candidate'],
    ],
    states: {
      ...launched(TWO_LANES), handoff: done(), ...verified(TWO_LANES), candidate: combinedPassed,
      review: { status: 'succeeded', attempt: 1, session: REVIEWER_SESSION, review: 1 },
      approval: { status: 'awaiting_approval', attempt: 1 },
    },
    packets: [
      { phase: 'worker', lane: 'ui', attempt: 1, from: '09:25:05', to: '09:29:05' },
      { phase: 'worker', lane: 'adapter', attempt: 1, from: '09:25:05', to: '09:26:15' },
      { phase: 'candidate', lane: 'ui', attempt: 1, from: '09:29:20', to: '09:33:45' },
      { phase: 'candidate', lane: 'adapter', attempt: 1, from: '09:29:20', to: '09:31:35' },
    ],
    values: { lanes: true, snapshots: true, packets: true, bundle: true, review: true },
    next: ['approval'],
    tasks: [{ node_id: 'approval', error: null, interrupts: [{ kind: 'integration_approval', message: 'Integration requires explicit approval of the reviewed bundle.' }], result: null }],
    review: {
      attempt: 1, transport: 'native', reviewer_session_id: REVIEWER_SESSION, independent: true, bundle_sha256: APPROVAL_BUNDLE, candidate_commit: CANDIDATE_COMMIT,
      verdict: 'approved', findings: [], reviewed_at: offset(at('09:40:30')), diff: null,
    },
  },
  {
    runId: RUN_PANE, lanes: TWO_LANES, status: 'running', mode: 'automatic', completed: false, stoppedAt: null,
    events: [
      ...launch(TWO_LANES), pid('09:00:16', 9201),
      ['09:10:00', 'ui', 'interactive', 'Worker ui needs attention in its pane (native state blocked); waiting until its deadline'],
    ],
    states: { launch_ui: running('ui'), launch_adapter: running('adapter') },
    packets: [],
    values: { lanes: true },
    next: ['handoff'],
    tasks: handoffWait,
  },
]

const nodesOf = (lanes: readonly Lane[]): DefinitionNode[] => laneGraphNodes(lanes)
const pinned = (lanes: readonly Lane[]): WorkflowDefinition => definition(PROJECT.project_id, UX_RUN_WORKFLOW_ID, UX_RUN_WORKFLOW_NAME, nodesOf(lanes))
/** The workflow's current definition: the two-lane graph, so the one-lane `run-repaired` shows its own pinned graph. */
export const UX_RUN_DEFINITION = pinned(TWO_LANES)

const records = (fixture: Fixture): InternalEvent[] => fixture.events.map(([clock, node, status, message], index) => ({ sequence: index + 1, time: at(clock), node, status, message }))
const updatedAt = (fixture: Fixture) => at(fixture.events.at(-1)![0])

/** A verification packet's result: the lane's checks spread over the attempt, failed with the gate's reasons when it did not pass. */
function packetResult(runId: string, packet: Packet): WorkerResult {
  const { lane, attempt, from, to, failure } = packet
  const commands = lane === 'ui'
    ? ['npm run build', 'npm run test:unit', 'npx --no-install playwright test --config=tests/project-workflows/playwright.config.ts']
    : ['npx --no-install tsx --test server/projects.test.ts']
  const start = Date.parse(at(from))
  const step = (Date.parse(at(to)) - start) / commands.length
  const time = (index: number) => new Date(start + Math.round(step * index)).toISOString().replace(/\.000Z$/, 'Z')
  const logs = ARTIFACTS[lane].filter(file => file.kind === 'log').map(file => file.artifact_id)
  return validateWorkerResult({
    contract_version: '1.0.0', run_id: runId, node_id: lane, attempt, session_id: SESSIONS[lane],
    status: failure ? 'failed' : 'succeeded', base_commit: BASE_COMMIT, output_commit: packet.phase === 'candidate' ? CANDIDATE_COMMIT : COMMITS[lane],
    changed_files: [],
    checks: checks(`verification/${packet.phase}/${lane}/${attempt}/worktree`, commands.map((command, index) => ({ command, log: logs[index], exit: 0, start: time(index), finish: time(index + 1) }))),
    open_assumptions: [],
    artifacts: artifactRefs(ARTIFACTS[lane]),
    summary: 'Trusted check capture of the lane; not integration approval.',
    error: failure ? { code: 'VERIFICATION_BLOCKED', message: failure, retryable: true } : null,
  })
}

const resultKey = (packet: Packet) => `${packet.phase === 'candidate' ? `candidate_${packet.lane}` : packet.lane}/${packet.attempt}`

function rawWorker(fixture: Fixture, lane: Lane, leak: string): RawWorkerInput {
  const ui = lane === 'ui'
  const summary = ui ? 'Built the run page for the viewer.' : 'Served the run page fields.'
  return {
    role: ui ? 'frontend' : 'backend',
    required_check_kinds: ui ? ['build', 'browser'] : ['unit'],
    task: ui ? uiTask(leak) : adapterTask(),
    prompt: null,
    owned_paths: ui ? ['src/projects', 'tests/project-workflows'] : ['server'],
    checks: ui ? UI_CHECKS : ADAPTER_CHECKS,
    launch: {
      session_id: SESSIONS[lane], launch_token: launchToken(lane), launch_requested_at: offset(at('09:00:08')),
      native_started_at: Date.parse(at('09:00:10')), observed_state: fixture.stoppedAt ? 'done' : 'working', status: 'attached_session_available',
      launcher_invocations: 1, background_id: backgroundId(lane),
    },
    completion: fixture.completed ? { status: 'completed', summary, open_assumptions: [] } : null,
    handoff: fixture.completed && fixture.stoppedAt ? { summary, open_assumptions: [] } : null,
    stop: fixture.stoppedAt ? { stopped: true, confirmed_at: offset(fixture.stoppedAt) } : null,
  }
}

function inputsSection(fixture: Fixture, leak: string): RawInputsSection {
  return {
    feature: 'Run page', policy_version: '1.2.0', base_commit: BASE_COMMIT, source_branch: `feature/${UX_RUN_WORKFLOW_ID}/${fixture.runId}`,
    mode: fixture.mode,
    automatic: fixture.mode === 'manual' ? null : {
      finish: 'verified-feature-branch', permission_mode: 'bypassPermissions', worker_timeout_seconds: 7200, review_timeout_seconds: 1800, reviewer_transport: 'native',
    },
    setup: [{ argv: ['npm', 'ci'], command: 'npm ci', timeout_seconds: 600 }],
    max_verification_attempts: 3,
    failure_drill: null,
    selected_workers: [...fixture.lanes],
    excluded_workers: [],
    workers: Object.fromEntries(fixture.lanes.map(lane => [lane, rawWorker(fixture, lane, leak)])),
  }
}

// The adapter's projection of raw rows before B1 (server/projects.ts `normalizeEvents`), for the worker-phase mock.
const EVENT_STATUS: Record<string, WorkflowEvent['status']> = {
  running: 'running', interactive: 'running', blocked: 'failed', succeeded: 'succeeded', passed: 'succeeded', approved: 'succeeded', paused: 'paused', interrupted: 'paused',
}

function servedEvents(fixture: Fixture): WorkflowEvent[] {
  const known = new Set(nodesOf(fixture.lanes).map(node => node.node_id))
  const lanes: readonly string[] = fixture.lanes
  const nodeOf = (node: string) => known.has(node) ? node : node === 'freeze' ? 'handoff' : lanes.includes(node) ? `launch_${node}`
    : node.startsWith('candidate_') && lanes.includes(node.slice('candidate_'.length)) ? 'candidate' : null
  const attempts = new Map<string, number>()
  return records(fixture).map(record => {
    const node_id = nodeOf(record.node)
    let attempt = 0
    if (node_id) {
      const parsed = /\bAttempt (\d+)\b/.exec(record.message)
      if (parsed) attempts.set(node_id, Number(parsed[1]))
      attempt = attempts.get(node_id) ?? 1
    }
    const status = node_id ? EVENT_STATUS[record.status] ?? null : null
    return eventSchema.parse({
      contract_version: '1.0.0', run_id: fixture.runId, event_id: `${fixture.runId}:${record.sequence}`, sequence: record.sequence, occurred_at: record.time,
      node_id, attempt, type: status ? 'status_changed' : 'log', status, message: record.message.replaceAll(RUN_DIR, PATH_TOKEN),
      artifact: null, result_uri: null, reused_from_attempt: null,
    })
  })
}

function detailOf(fixture: Fixture): RunDetail {
  const detail = runDetail(fixture.runId, fixture.status, pinned(fixture.lanes), CREATED_AT, updatedAt(fixture), fixture.states, fixture.events.length)
  // The adapter links a launch node to its lane's latest worker packet: attempt 2 of the repaired lane.
  const latest = (lane: string) => Math.max(0, ...fixture.packets.filter(packet => packet.phase === 'worker' && packet.lane === lane).map(packet => packet.attempt))
  for (const node of detail.snapshot.nodes) {
    if (node.node_id.startsWith('launch_') && node.result_uri !== null) node.result_uri = node.result_uri.replace(/\/\d+$/, `/${latest(node.node_id.slice('launch_'.length))}`)
  }
  return detail
}

const taskTexts = (fixture: Fixture, leak: string) => Object.fromEntries(Object.entries(inputsSection(fixture, leak).workers).map(([lane, worker]) => [lane, worker.task]))

const payloads: UxPayloads = {
  workflows: [UX_RUN_DEFINITION],
  runDetails: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, detailOf(fixture)])),
  runEvents: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, servedEvents(fixture)])),
  workerResults: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, Object.fromEntries(fixture.packets.map(packet => [resultKey(packet), packetResult(fixture.runId, packet)]))])),
  reviewResults: Object.fromEntries(FIXTURES.flatMap((fixture): [string, ReviewResult][] => fixture.review
    ? [[fixture.runId, projectReview(fixture.runId, fixture.review, taskTexts(fixture, PATH_TOKEN), UX_RUN_WORKFLOW_ID)]] : [])),
  runInputs: Object.fromEntries(FIXTURES.map((fixture): [string, RunInputs] => [fixture.runId, projectInputs(fixture.runId, inputsSection(fixture, PATH_TOKEN))])),
  artifactFiles: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, fixture.packets.length ? fixture.lanes.flatMap(lane => ARTIFACTS[lane]) : []])),
}

function seed({ repository, runsRoot, writeRun, writePacket, receipt, leakFor }: SeedContext) {
  const root = runsRoot(UX_RUN_WORKFLOW_ID)
  for (const fixture of FIXTURES) {
    const runDir = `${root}/${fixture.runId}`
    const { values, lanes } = fixture
    writeRun(root, repository, fixture.runId, {
      createdAt: CREATED_AT, updatedAt: updatedAt(fixture), definitionNodes: nodesOf(lanes), definitionName: UX_RUN_WORKFLOW_NAME, version: '1.4.0', lanes,
      values: {
        ...(values.lanes ? { lanes: Object.fromEntries(lanes.map(lane => [lane, receipt(lane, runDir, SESSIONS[lane], at('09:00:08'))])) } : {}),
        ...(values.snapshots ? { snapshots: Object.fromEntries(lanes.map(lane => [lane, COMMITS[lane]])) } : {}),
        ...(values.packets ? { packets: Object.fromEntries(lanes.map(lane => [lane, `verification/worker/${lane}/1/packet.json`])) } : {}),
        ...(values.bundle ? { bundle: { run_id: fixture.runId, base_commit: BASE_COMMIT, candidate_commit: CANDIDATE_COMMIT, policy_sha256: 'e'.repeat(64) } } : {}),
        ...(values.review ? { review: { run_id: fixture.runId, verdict: 'approved', independent: true, reviewer: 'synthetic-reviewer', findings: [] } } : {}),
      },
      next: fixture.next,
      tasks: fixture.tasks,
      events: records(fixture).map(record => ({ ...record, message: record.message.replaceAll(RUN_DIR, runDir) })),
      packets: directory => fixture.packets.map(packet => writePacket(directory, packet.phase, packet.lane, packet.attempt, packetResult(fixture.runId, packet), ARTIFACTS[packet.lane],
        packet.failure ? { status: 'blocked', reasons: packet.failure.split('; ') } : { status: 'passed', reasons: [] })),
      review: fixture.review ?? null,
      inputs: inputsSection(fixture, leakFor(root, fixture.runId)),
    })
  }
  return { workflows: [{ workflow_id: UX_RUN_WORKFLOW_ID, runs_root: root, definition: { name: UX_RUN_WORKFLOW_NAME, nodes: nodesOf(TWO_LANES) } }] }
}

export const uxRun: UxFixtureModule = { payloads, seed }
