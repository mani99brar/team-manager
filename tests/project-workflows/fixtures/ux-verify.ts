/**
 * Fixtures of viewer UX slice S4a, verification and the candidate (`ux-verify.spec.ts`) (docs/PRD_VIEWER_UX.md 4.6, 7 and
 * 12.2), registered as the workflow `ux-verify`: mock payloads for the worker phase and a `seed` for the candidate phase,
 * merged by `index.ts`.
 *
 * One run, `run-rejected-checks`, with two lanes (ui, adapter), written once as the controller's own records like
 * `ux-run.ts` and `ux-node.ts`:
 * - `verify_ui` attempt 1 failed with two keyed reasons on checks that exited 0 (`frontend-unit:`,
 *   `project-workflows-browser:`), so the gate rejected two checks; attempt 2 passed.
 * - `verify_adapter` attempt 1 failed with an unkeyed reason, as workflow-guardrails-001 `results/controller/1` did:
 *   `Executed check failed: <path> -m workflow.run_tests` (the check's own command is served unredacted), followed by
 *   the keyed reasons of that same check, which exited 1; attempt 2 passed.
 * - `verify_ui` attempt 2 passed and recorded its build and browser checks for the candidate gate (`deferred_checks`).
 * - The combined candidate's attempt 1 passed lane ui and failed lane adapter, whose `backend-contract` check exited 0
 *   and was rejected, so the run failed. Its first reason carries no check id and its `<path>` tail ends no check's
 *   command, so it stays a gate-level reason only. The adapter lane also published a setup log that belongs to no check.
 * Lane adapter comes second in the lanes' order, so a table sorted by failure puts it first.
 */
import type { RunDetail, WorkflowDefinition } from '../../../contracts/projects/v1.ts'
import { eventSchema, validateWorkerResult, type WorkerResult, type WorkflowEvent } from '../../../contracts/workflow/v1.ts'
import {
  ADAPTER_SESSION, BASE_COMMIT, CANDIDATE_COMMIT, OUTPUT_COMMIT_ADAPTER, OUTPUT_COMMIT_UI, PATH_TOKEN, PROJECT, UI_ARTIFACTS, UI_CHECKS, UI_SESSION,
  adapterTask, artifactRefs, backgroundId, checks, definition, laneGraphNodes, launchToken, logArtifact, offset, projectInputs, runDetail, uiTask,
  type ArtifactFile, type NodeState, type RawCheck, type RawInputsSection, type RawWorkerInput,
} from '../fixtures.ts'
import type { InternalEvent, SeedContext } from '../seed.ts'
import type { UxFixtureModule, UxPayloads } from './index.ts'

export const UX_VERIFY_WORKFLOW_ID = 'ux-verify'
export const UX_VERIFY_WORKFLOW_NAME = 'UX verify'
export const RUN_REJECTED_CHECKS = 'run-rejected-checks'

/** The interpreter the adapter lane's first check runs: served verbatim in the check, redacted to `<path>` in the gate's reasons. */
export const PYTHON = '/srv/ci/.venv/bin/python'
export const RUN_TESTS_COMMAND = `${PYTHON} -m workflow.run_tests`
export const CONTRACT_COMMAND = 'npx --no-install tsx --test server/projects.test.ts'
/** Verify ui attempt 1: two checks that exited 0, rejected by the gate for their evidence. */
export const UI_REJECTED = 'frontend-unit: no passing test evidence or failed tests; project-workflows-browser: no passing test evidence or failed tests'
/** Verify adapter attempt 1, as the controller records it; the adapter redacts the interpreter's path when serving it. */
const ADAPTER_FAILURE_RAW = `Executed check failed: ${RUN_TESTS_COMMAND}; backend-unit: no passing test evidence or failed tests; backend-unit: exit 1`
export const UNKEYED_REASON = `Executed check failed: ${PATH_TOKEN} -m workflow.run_tests`
/** The candidate's adapter lane: its contract check exited 0 and was rejected. */
export const CANDIDATE_REJECTED = 'backend-contract: no passing test evidence or failed tests'
/** The candidate adapter lane's reason without a check id whose command tail matches no check (redacted as served). */
export const NO_MATCH_REASON = `Executed check failed: ${PATH_TOKEN} -m workflow.lint_contract`
const CANDIDATE_FAILURE_RAW = `Executed check failed: ${PYTHON} -m workflow.lint_contract; ${CANDIDATE_REJECTED}`
/** A log the adapter lane published that belongs to no check. */
export const SETUP_LOG_ID = 'log-9-adapter-setup'

type Lane = 'ui' | 'adapter'
type Row = [clock: string, node: string, status: string, message: string]
/** `deferred`: the lane's build and browser checks were recorded for the candidate gate (checks 0 and 2 of lane ui). */
type Packet = { phase: 'worker' | 'candidate'; lane: Lane; attempt: number; from: string; to: string; failure?: string; deferred?: boolean }

const LANES: readonly Lane[] = ['ui', 'adapter']
const DAY = '2026-03-04'
const CREATED_AT = `${DAY}T09:00:00Z`
const at = (clock: string) => `${DAY}T${clock}Z`
const SESSIONS: Record<Lane, string> = { ui: UI_SESSION, adapter: ADAPTER_SESSION }
const COMMITS: Record<Lane, string> = { ui: OUTPUT_COMMIT_UI, adapter: OUTPUT_COMMIT_ADAPTER }

const VERIFY_ADAPTER_CHECKS: RawCheck[] = [
  { id: 'backend-unit', kind: 'unit', argv: [PYTHON, '-m', 'workflow.run_tests'], command: RUN_TESTS_COMMAND, timeout_seconds: 600, scenarios: [] },
  { id: 'backend-contract', kind: 'contract', argv: ['npx', '--no-install', 'tsx', '--test', 'server/projects.test.ts'], command: CONTRACT_COMMAND, timeout_seconds: 180, scenarios: [] },
]
const ADAPTER_ARTIFACTS: ArtifactFile[] = [
  logArtifact('log-0-adapter-run-tests', RUN_TESTS_COMMAND, 0),
  logArtifact('log-1-adapter-contract', CONTRACT_COMMAND, 0),
  logArtifact(SETUP_LOG_ID, 'npm ci', 0),
]
/** Lane ui's checks recorded for the candidate gate, by executed index: the build and the browser suite. */
const DEFERRED: [id: string, index: number][] = [['frontend-build', 0], ['project-workflows-browser', 2]]
const ARTIFACTS: Record<Lane, ArtifactFile[]> = { ui: UI_ARTIFACTS, adapter: ADAPTER_ARTIFACTS }
const COMMANDS: Record<Lane, string[]> = {
  ui: ['npm run build', 'npm run test:unit', 'npx --no-install playwright test --config=tests/project-workflows/playwright.config.ts'],
  adapter: [RUN_TESTS_COMMAND, CONTRACT_COMMAND],
}

const pid = (clock: string, n: number): Row => [clock, 'controller', 'running', `Automatic checkpoint controller PID ${n}`]
const verifyStart = (clock: string, lane: Lane, attempt: number): Row => [clock, `verify_${lane}`, 'running', `Attempt ${attempt}; revision ${COMMITS[lane]}`]

const ROWS: Row[] = [
  ...LANES.map((lane): Row => ['09:00:10', lane, 'running', 'Launching or reconciling the exact native session']),
  ...LANES.map((lane): Row => ['09:00:14', lane, 'running', 'Awaiting explicit completion signal; idle is not acceptance']),
  pid('09:00:16', 4301),
  ['09:20:00', 'freeze', 'stopped', 'Native workers stopped before snapshot capture: ui, adapter'],
  ['09:20:00', 'freeze', 'succeeded', 'Immutable snapshots captured; worker-reported checks are not trusted'],
  verifyStart('09:20:00', 'ui', 1),
  verifyStart('09:20:00', 'adapter', 1),
  ['09:21:10', 'verify_adapter', 'blocked', ADAPTER_FAILURE_RAW],
  ['09:21:30', 'verify_ui', 'blocked', UI_REJECTED],
  pid('09:21:32', 4302),
  verifyStart('09:21:32', 'adapter', 2),
  verifyStart('09:21:32', 'ui', 2),
  ['09:22:40', 'verify_adapter', 'succeeded', 'Required tests and artifacts passed'],
  ['09:23:40', 'verify_ui', 'succeeded', 'Required tests and artifacts passed; recorded for the candidate gate: frontend-build, project-workflows-browser'],
  pid('09:23:42', 4303),
  ['09:26:00', 'candidate_ui', 'succeeded', `Combined revision ${CANDIDATE_COMMIT}`],
  ['09:27:30', 'candidate_adapter', 'blocked', `Combined revision ${CANDIDATE_COMMIT}`],
  pid('09:27:32', 4304),
]

/** Each attempt's checks spread over its packet window; verify ui attempt 1 starts its first check 5 s into the attempt. */
const PACKETS: Packet[] = [
  { phase: 'worker', lane: 'ui', attempt: 1, from: '09:20:05', to: '09:21:26', failure: UI_REJECTED },
  { phase: 'worker', lane: 'adapter', attempt: 1, from: '09:20:05', to: '09:21:05', failure: ADAPTER_FAILURE_RAW },
  { phase: 'worker', lane: 'ui', attempt: 2, from: '09:21:35', to: '09:23:35', deferred: true },
  { phase: 'worker', lane: 'adapter', attempt: 2, from: '09:21:35', to: '09:22:35' },
  { phase: 'candidate', lane: 'ui', attempt: 1, from: '09:23:45', to: '09:25:55' },
  { phase: 'candidate', lane: 'adapter', attempt: 1, from: '09:26:05', to: '09:27:25', failure: CANDIDATE_FAILURE_RAW },
]

const NODES = laneGraphNodes(LANES)
const DEFINITION: WorkflowDefinition = definition(PROJECT.project_id, UX_VERIFY_WORKFLOW_ID, UX_VERIFY_WORKFLOW_NAME, NODES)
const records: InternalEvent[] = ROWS.map(([clock, node, status, message], index) => ({ sequence: index + 1, time: at(clock), node, status, message }))
const UPDATED_AT = at(ROWS.at(-1)![0])

/** A packet's result: the lane's checks over its window; only verify adapter attempt 1's run_tests check exited 1. */
function packetResult(packet: Packet): WorkerResult {
  const commands = COMMANDS[packet.lane]
  const start = Date.parse(at(packet.from))
  const step = (Date.parse(at(packet.to)) - start) / commands.length
  const time = (index: number) => new Date(start + Math.round(step * index)).toISOString().replace(/\.000Z$/, 'Z')
  const logs = ARTIFACTS[packet.lane].filter(file => file.kind === 'log').map(file => file.artifact_id)
  const exit = (index: number) => packet.phase === 'worker' && packet.lane === 'adapter' && packet.attempt === 1 && index === 0 ? 1 : 0
  return validateWorkerResult({
    contract_version: '1.0.0', run_id: RUN_REJECTED_CHECKS, node_id: packet.lane, attempt: packet.attempt, session_id: SESSIONS[packet.lane],
    status: packet.failure ? 'failed' : 'succeeded', base_commit: BASE_COMMIT, output_commit: packet.phase === 'candidate' ? CANDIDATE_COMMIT : COMMITS[packet.lane],
    changed_files: [],
    checks: checks(`verification/${packet.phase}/${packet.lane}/${packet.attempt}/worktree`, commands.map((command, index) => ({ command, log: logs[index], exit: exit(index), start: time(index), finish: time(index + 1) }))),
    open_assumptions: [],
    artifacts: artifactRefs(ARTIFACTS[packet.lane]),
    summary: 'Trusted check capture of the lane; not integration approval.',
    error: packet.failure ? { code: 'VERIFICATION_BLOCKED', message: packet.failure.replaceAll(PYTHON, PATH_TOKEN), retryable: true } : null,
    ...(packet.deferred ? { deferred_checks: DEFERRED.map(([id, check_index]) => ({ id, check_index })) } : {}),
  })
}

const resultKey = (packet: Packet) => `${packet.phase === 'candidate' ? `candidate_${packet.lane}` : packet.lane}/${packet.attempt}`

function rawWorker(lane: Lane, leak: string): RawWorkerInput {
  const ui = lane === 'ui'
  const summary = ui ? 'Built the verification pages.' : 'Served the verification results.'
  return {
    role: ui ? 'frontend' : 'backend',
    required_check_kinds: ui ? ['build', 'browser'] : ['unit'],
    task: ui ? uiTask(leak) : adapterTask(),
    prompt: null,
    owned_paths: ui ? ['src/projects', 'tests/project-workflows'] : ['server', 'workflow'],
    checks: ui ? UI_CHECKS : VERIFY_ADAPTER_CHECKS,
    launch: {
      session_id: SESSIONS[lane], launch_token: launchToken(lane), launch_requested_at: offset(at('09:00:08')),
      native_started_at: Date.parse(at('09:00:10')), observed_state: 'done', status: 'attached_session_available',
      launcher_invocations: 1, background_id: backgroundId(lane),
    },
    completion: { status: 'completed', summary, open_assumptions: [] },
    handoff: { summary, open_assumptions: [] },
    stop: { stopped: true, confirmed_at: offset(at('09:20:00')) },
  }
}

function inputsSection(leak: string): RawInputsSection {
  return {
    feature: 'Verification pages', policy_version: '1.2.0', base_commit: BASE_COMMIT, source_branch: `feature/${UX_VERIFY_WORKFLOW_ID}/${RUN_REJECTED_CHECKS}`,
    mode: 'automatic',
    automatic: { finish: 'verified-feature-branch', permission_mode: 'bypassPermissions', worker_timeout_seconds: 7200, review_timeout_seconds: 1800, reviewer_transport: 'native' },
    setup: [{ argv: ['npm', 'ci'], command: 'npm ci', timeout_seconds: 600 }],
    max_verification_attempts: 3,
    failure_drill: null,
    selected_workers: [...LANES],
    excluded_workers: [],
    workers: Object.fromEntries(LANES.map(lane => [lane, rawWorker(lane, leak)])),
  }
}

// The adapter's projection of the raw rows for the worker-phase mock, as `normalizeEvents` serves them since B1: a lane's rows
// on its launch node, `freeze` on the handoff, a candidate lane's rows on `candidate` with the lane in the message, controller
// rows node-less as `log` rows that keep their status, `blocked` served failed, absolute paths redacted.
const EVENT_STATUS: Record<string, WorkflowEvent['status']> = { running: 'running', blocked: 'failed', succeeded: 'succeeded', paused: 'paused' }

function servedEvents(): WorkflowEvent[] {
  const known = new Set(NODES.map(node => node.node_id))
  const lanes: readonly string[] = LANES
  const nodeOf = (node: string) => known.has(node) ? node : node === 'freeze' ? 'handoff' : lanes.includes(node) ? `launch_${node}`
    : node.startsWith('candidate_') && lanes.includes(node.slice('candidate_'.length)) ? 'candidate' : null
  const attempts = new Map<string, number>()
  return records.map(record => {
    const node_id = nodeOf(record.node)
    let attempt = 0
    if (node_id) {
      const parsed = /^Attempt (\d+)\b/.exec(record.message)
      if (parsed) attempts.set(node_id, Number(parsed[1]))
      attempt = attempts.get(node_id) ?? 1
    }
    const status = node_id || record.node === 'controller' ? EVENT_STATUS[record.status] ?? null : null
    const lane = node_id === 'candidate' ? record.node.slice('candidate_'.length) : null
    const message = lane ? `[${lane}] ${record.message}` : record.message
    return eventSchema.parse({
      contract_version: '1.0.0', run_id: RUN_REJECTED_CHECKS, event_id: `${RUN_REJECTED_CHECKS}:${record.sequence}`, sequence: record.sequence, occurred_at: record.time,
      node_id, attempt, type: node_id && status ? 'status_changed' : 'log', status, message: message.replaceAll(PYTHON, PATH_TOKEN),
      artifact: null, result_uri: null, reused_from_attempt: null,
    })
  })
}

function servedDetail(): RunDetail {
  const verified = (lane: Lane): NodeState => ({ status: 'succeeded', attempt: 2, session: SESSIONS[lane], result: lane })
  const detail = runDetail(RUN_REJECTED_CHECKS, 'failed', DEFINITION, CREATED_AT, UPDATED_AT, {
    launch_ui: { status: 'succeeded', attempt: 1, session: UI_SESSION, result: 'ui' },
    launch_adapter: { status: 'succeeded', attempt: 1, session: ADAPTER_SESSION, result: 'adapter' },
    handoff: { status: 'succeeded', attempt: 1 },
    verify_ui: verified('ui'),
    verify_adapter: verified('adapter'),
    candidate: { status: 'failed', attempt: 1, lanes: [{ worker: 'ui', attempt: 1 }, { worker: 'adapter', attempt: 1 }] },
  }, ROWS.length)
  // The adapter links a launch node to its lane's latest verified result, the one the verify node shows.
  for (const node of detail.snapshot.nodes) {
    if (node.node_id.startsWith('launch_') && node.result_uri !== null) node.result_uri = node.result_uri.replace(/\/1$/, '/2')
  }
  return detail
}

const payloads: UxPayloads = {
  workflows: [DEFINITION],
  runDetails: { [RUN_REJECTED_CHECKS]: servedDetail() },
  runEvents: { [RUN_REJECTED_CHECKS]: servedEvents() },
  workerResults: { [RUN_REJECTED_CHECKS]: Object.fromEntries(PACKETS.map(packet => [resultKey(packet), packetResult(packet)])) },
  reviewResults: {},
  runInputs: { [RUN_REJECTED_CHECKS]: projectInputs(RUN_REJECTED_CHECKS, inputsSection(PATH_TOKEN)) },
  artifactFiles: { [RUN_REJECTED_CHECKS]: LANES.flatMap(lane => ARTIFACTS[lane]) },
}

function seed({ repository, runsRoot, writeRun, writePacket, receipt, leakFor }: SeedContext) {
  const root = runsRoot(UX_VERIFY_WORKFLOW_ID)
  const runDir = `${root}/${RUN_REJECTED_CHECKS}`
  writeRun(root, repository, RUN_REJECTED_CHECKS, {
    createdAt: CREATED_AT, updatedAt: UPDATED_AT, definitionNodes: NODES, definitionName: UX_VERIFY_WORKFLOW_NAME, version: '1.4.0', lanes: LANES,
    values: {
      lanes: Object.fromEntries(LANES.map(lane => [lane, receipt(lane, runDir, SESSIONS[lane], at('09:00:08'))])),
      snapshots: Object.fromEntries(LANES.map(lane => [lane, COMMITS[lane]])),
      packets: Object.fromEntries(LANES.map(lane => [lane, `verification/worker/${lane}/2/packet.json`])),
    },
    next: ['candidate'],
    tasks: [{ node_id: 'candidate', error: 'Combined candidate lane adapter failed its gate', interrupts: [], result: null }],
    events: records,
    packets: directory => PACKETS.map(packet => writePacket(directory, packet.phase, packet.lane, packet.attempt, packetResult(packet), ARTIFACTS[packet.lane],
      // Seeded evidence receipts are `check-<index>`, so a deferred check is named by its executed index.
      packet.failure ? { status: 'blocked', reasons: packet.failure.split('; ') }
        : { status: 'passed', reasons: [], ...(packet.deferred ? { deferred_checks: DEFERRED.map(([, index]) => `check-${index}`) } : {}) })),
    review: null,
    inputs: inputsSection(leakFor(root, RUN_REJECTED_CHECKS)),
  })
  return { workflows: [{ workflow_id: UX_VERIFY_WORKFLOW_ID, runs_root: root, definition: { name: UX_VERIFY_WORKFLOW_NAME, nodes: NODES } }] }
}

export const uxVerify: UxFixtureModule = { payloads, seed }
