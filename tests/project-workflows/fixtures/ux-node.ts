/**
 * Fixtures of viewer UX slice S4-core, the node shell (`ux-node.spec.ts`) (docs/PRD_VIEWER_UX.md 12.2), registered as the
 * workflow `ux-node`: mock payloads for the worker phase and a `seed` for the candidate phase, merged by `index.ts`.
 *
 * One run, `run-third-attempt`, with one lane (ui), written once as the controller's own records in the shapes
 * `workflow/automatic.py` and `workflow/repair.py` write them, like `ux-run.ts`: the lane's verification failed twice with
 * the same `error.message`, the controller's node-less diagnosis followed, then the operator's repair 1 and its "applied"
 * row, and attempt 3 passed. The run goes on to the combined candidate, which has not started. Results `ui/1` to `ui/3`
 * are all served, and the launch node links the latest one, `ui/3`, like the adapter.
 */
import type { RunDetail, WorkflowDefinition } from '../../../contracts/projects/v1.ts'
import { eventSchema, validateWorkerResult, type WorkerResult, type WorkflowEvent } from '../../../contracts/workflow/v1.ts'
import {
  BASE_COMMIT, OUTPUT_COMMIT_UI, PATH_TOKEN, PROJECT, UI_ARTIFACTS, UI_CHECKS, UI_SESSION, artifactRefs, backgroundId, checks, definition,
  laneGraphNodes, launchToken, offset, projectInputs, runDetail, uiTask,
  type RawInputsSection,
} from '../fixtures.ts'
import type { InternalEvent, SeedContext } from '../seed.ts'
import type { UxFixtureModule, UxPayloads } from './index.ts'

export const UX_NODE_WORKFLOW_ID = 'ux-node'
export const UX_NODE_WORKFLOW_NAME = 'UX node'
export const RUN_THIRD_ATTEMPT = 'run-third-attempt'

/** The gate's reasons on attempts 1 and 2, identical: the controller called the failure identical and stopped retrying. */
export const NODE_VERIFY_FAILURE = 'frontend-unit: no passing test evidence or failed tests; project-workflows-browser: no passing test evidence or failed tests'
/** What the worker reported, and the assumption it left open: the narrative the launch node shows once. */
export const NODE_WORKER_SUMMARY = 'Built the node pages: header, section index and attempt strip.'
export const NODE_ASSUMPTION = 'An attempt page may link a result the server removed; the chip then stays hidden.'
/** The repaired snapshot attempt 3 verified. */
export const REPAIRED_COMMIT = '50b14b3c766005cf076331e8e8a59261cf90d16b'

const DAY = '2026-03-03'
const CREATED_AT = `${DAY}T09:00:00Z`
const at = (clock: string) => `${DAY}T${clock}Z`
/** Where a message names the run directory: `<path>` once served, the real directory in the candidate phase's raw rows. */
const RUN_DIR = '{run}'

type Row = [clock: string, node: string, status: string, message: string]
type Packet = { attempt: number; from: string; to: string; failure?: string }

const REPAIR_NOTE = 'Repair 1 by the operator: snapshot 50b14b3c = abcdef12 + b27d726a on snapshot abcdef12 (tests/reporters/testSummary.ts). '
  + `Reason: The verifier parses only Node TAP summaries. Answers worker/ui attempt 2: ${NODE_VERIFY_FAILURE}. `
  + `Continue with python -m workflow automatic ${RUN_DIR} --live`
const pid = (clock: string, n: number): Row => [clock, 'controller', 'running', `Automatic checkpoint controller PID ${n}`]

const ROWS: Row[] = [
  ['09:00:10', 'ui', 'running', 'Launching or reconciling the exact native session'],
  ['09:00:14', 'ui', 'running', 'Awaiting explicit completion signal; idle is not acceptance'],
  pid('09:00:16', 3101),
  ['09:20:00', 'freeze', 'stopped', 'Native workers stopped before snapshot capture: ui'],
  ['09:20:00', 'freeze', 'succeeded', 'Immutable snapshots captured; worker-reported checks are not trusted'],
  ['09:20:00', 'verify_ui', 'running', `Attempt 1; revision ${OUTPUT_COMMIT_UI}`],
  ['09:21:07', 'verify_ui', 'blocked', NODE_VERIFY_FAILURE],
  pid('09:21:10', 3102),
  ['09:21:10', 'verify_ui', 'running', `Attempt 2; revision ${OUTPUT_COMMIT_UI}`],
  ['09:22:17', 'verify_ui', 'blocked', NODE_VERIFY_FAILURE],
  pid('09:22:19', 3103),
  ['09:22:19', 'controller', 'blocked', `worker/ui failed identically on attempts 1 and 2; not transient, inspect ${RUN_DIR} Before review a code fix is a lane repair (RUNBOOK)`],
  ['09:28:00', 'verify_ui', 'paused', REPAIR_NOTE],
  ['09:28:00', 'controller', 'running', 'Repair 1 applied: checkpoint forked from 1f1b7f90 (after handoff); attempts worker:ui 3'],
  pid('09:28:05', 3104),
  ['09:28:05', 'verify_ui', 'running', `Attempt 3; revision ${REPAIRED_COMMIT}`],
  ['09:29:20', 'verify_ui', 'succeeded', 'Required tests and artifacts passed; recorded for the candidate gate: frontend-build, project-workflows-browser'],
]

/** Attempt 3 starts at 09:28:05; its first check at 09:28:47 (setup 42s), its last ends at 09:29:18 (checks 31s). */
const PACKETS: Packet[] = [
  { attempt: 1, from: '09:20:05', to: '09:21:05', failure: NODE_VERIFY_FAILURE },
  { attempt: 2, from: '09:21:15', to: '09:22:15', failure: NODE_VERIFY_FAILURE },
  { attempt: 3, from: '09:28:47', to: '09:29:18' },
]

const NODES = laneGraphNodes(['ui'])
const DEFINITION: WorkflowDefinition = definition(PROJECT.project_id, UX_NODE_WORKFLOW_ID, UX_NODE_WORKFLOW_NAME, NODES)
const records: InternalEvent[] = ROWS.map(([clock, node, status, message], index) => ({ sequence: index + 1, time: at(clock), node, status, message }))
const UPDATED_AT = at(ROWS.at(-1)![0])

/** A verification attempt's result: the lane's three checks spread over the attempt, failed with the gate's reasons when it did not pass. */
function packetResult(packet: Packet): WorkerResult {
  const commands = ['npm run build', 'npm run test:unit', 'npx --no-install playwright test --config=tests/project-workflows/playwright.config.ts']
  const start = Date.parse(at(packet.from))
  const step = (Date.parse(at(packet.to)) - start) / commands.length
  const time = (index: number) => new Date(start + Math.round(step * index)).toISOString().replace(/\.000Z$/, 'Z')
  const logs = UI_ARTIFACTS.filter(file => file.kind === 'log').map(file => file.artifact_id)
  return validateWorkerResult({
    contract_version: '1.0.0', run_id: RUN_THIRD_ATTEMPT, node_id: 'ui', attempt: packet.attempt, session_id: UI_SESSION,
    status: packet.failure ? 'failed' : 'succeeded', base_commit: BASE_COMMIT, output_commit: packet.attempt === 3 ? REPAIRED_COMMIT : OUTPUT_COMMIT_UI,
    changed_files: [],
    checks: checks(`verification/worker/ui/${packet.attempt}/worktree`, commands.map((command, index) => ({ command, log: logs[index], exit: 0, start: time(index), finish: time(index + 1) }))),
    open_assumptions: [NODE_ASSUMPTION],
    artifacts: artifactRefs(UI_ARTIFACTS),
    summary: NODE_WORKER_SUMMARY,
    error: packet.failure ? { code: 'VERIFICATION_BLOCKED', message: packet.failure, retryable: true } : null,
  })
}

function inputsSection(leak: string): RawInputsSection {
  return {
    feature: 'Node shell', policy_version: '1.2.0', base_commit: BASE_COMMIT, source_branch: `feature/${UX_NODE_WORKFLOW_ID}/${RUN_THIRD_ATTEMPT}`,
    mode: 'automatic',
    automatic: { finish: 'verified-feature-branch', permission_mode: 'bypassPermissions', worker_timeout_seconds: 7200, review_timeout_seconds: 1800, reviewer_transport: 'native' },
    setup: [{ argv: ['npm', 'ci'], command: 'npm ci', timeout_seconds: 600 }],
    max_verification_attempts: 3,
    failure_drill: null,
    selected_workers: ['ui'],
    excluded_workers: [],
    workers: {
      ui: {
        role: 'frontend', required_check_kinds: ['build', 'browser'], task: uiTask(leak), prompt: null,
        owned_paths: ['src/projects', 'tests/project-workflows'], checks: UI_CHECKS,
        launch: {
          session_id: UI_SESSION, launch_token: launchToken('ui'), launch_requested_at: offset(at('09:00:08')), native_started_at: Date.parse(at('09:00:10')),
          observed_state: 'done', status: 'attached_session_available', launcher_invocations: 1, background_id: backgroundId('ui'),
        },
        completion: { status: 'completed', summary: NODE_WORKER_SUMMARY, open_assumptions: [NODE_ASSUMPTION] },
        handoff: { summary: NODE_WORKER_SUMMARY, open_assumptions: [NODE_ASSUMPTION] },
        stop: { stopped: true, confirmed_at: offset(at('09:20:00')) },
      },
    },
  }
}

// The adapter's projection of the raw rows for the worker-phase mock, as the server serves them since B1: a lane's rows on
// its launch node, `freeze` on the handoff, controller rows node-less as `log` rows that keep their status, `blocked`
// served failed, the run directory redacted.
const EVENT_STATUS: Record<string, WorkflowEvent['status']> = { running: 'running', blocked: 'failed', succeeded: 'succeeded', paused: 'paused' }

function servedEvents(): WorkflowEvent[] {
  const known = new Set(NODES.map(node => node.node_id))
  const nodeOf = (node: string) => known.has(node) ? node : node === 'freeze' ? 'handoff' : node === 'ui' ? 'launch_ui' : null
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
    return eventSchema.parse({
      contract_version: '1.0.0', run_id: RUN_THIRD_ATTEMPT, event_id: `${RUN_THIRD_ATTEMPT}:${record.sequence}`, sequence: record.sequence, occurred_at: record.time,
      node_id, attempt, type: node_id && status ? 'status_changed' : 'log', status, message: record.message.replaceAll(RUN_DIR, PATH_TOKEN),
      artifact: null, result_uri: null, reused_from_attempt: null,
    })
  })
}

function servedDetail(): RunDetail {
  const detail = runDetail(RUN_THIRD_ATTEMPT, 'running', DEFINITION, CREATED_AT, UPDATED_AT, {
    launch_ui: { status: 'succeeded', attempt: 1, session: UI_SESSION, result: 'ui' },
    handoff: { status: 'succeeded', attempt: 1 },
    verify_ui: { status: 'succeeded', attempt: 3, session: UI_SESSION, result: 'ui' },
  }, ROWS.length)
  // The adapter links the launch node to the lane's latest verified result, the one the verify node shows.
  const launch = detail.snapshot.nodes.find(node => node.node_id === 'launch_ui')!
  launch.result_uri = launch.result_uri!.replace(/\/1$/, '/3')
  return detail
}

const payloads: UxPayloads = {
  workflows: [DEFINITION],
  runDetails: { [RUN_THIRD_ATTEMPT]: servedDetail() },
  runEvents: { [RUN_THIRD_ATTEMPT]: servedEvents() },
  workerResults: { [RUN_THIRD_ATTEMPT]: Object.fromEntries(PACKETS.map(packet => [`ui/${packet.attempt}`, packetResult(packet)])) },
  reviewResults: {},
  runInputs: { [RUN_THIRD_ATTEMPT]: projectInputs(RUN_THIRD_ATTEMPT, inputsSection(PATH_TOKEN)) },
  artifactFiles: { [RUN_THIRD_ATTEMPT]: UI_ARTIFACTS },
}

function seed({ repository, runsRoot, writeRun, writePacket, receipt, leakFor }: SeedContext) {
  const root = runsRoot(UX_NODE_WORKFLOW_ID)
  const runDir = `${root}/${RUN_THIRD_ATTEMPT}`
  writeRun(root, repository, RUN_THIRD_ATTEMPT, {
    createdAt: CREATED_AT, updatedAt: UPDATED_AT, definitionNodes: NODES, definitionName: UX_NODE_WORKFLOW_NAME, version: '1.4.0', lanes: ['ui'],
    values: {
      lanes: { ui: receipt('ui', runDir, UI_SESSION, at('09:00:08')) },
      snapshots: { ui: REPAIRED_COMMIT },
      packets: { ui: 'verification/worker/ui/3/packet.json' },
    },
    next: ['candidate'],
    tasks: [],
    events: records.map(record => ({ ...record, message: record.message.replaceAll(RUN_DIR, runDir) })),
    packets: directory => PACKETS.map(packet => writePacket(directory, 'worker', 'ui', packet.attempt, packetResult(packet), UI_ARTIFACTS,
      packet.failure ? { status: 'blocked', reasons: packet.failure.split('; ') } : { status: 'passed', reasons: [] })),
    review: null,
    inputs: inputsSection(leakFor(root, RUN_THIRD_ATTEMPT)),
  })
  return { workflows: [{ workflow_id: UX_NODE_WORKFLOW_ID, runs_root: root, definition: { name: UX_NODE_WORKFLOW_NAME, nodes: NODES } }] }
}

export const uxNode: UxFixtureModule = { payloads, seed }
