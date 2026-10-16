/**
 * Fixtures of the run-controls feature (`controls.spec.ts`, docs/PRD_RUN_CONTROLS.md), registered as the workflow `controls`:
 * mock payloads for the worker phase and a `seed` for the candidate phase, merged by `index.ts`. One lane (`ui`) keeps
 * each run small; a run's records are the controller's own rows in the shapes `ux-run.ts` and `ux-lists.ts` use.
 *
 * - `controls-stopped`: an automatic run whose supervisor was interrupted (an `interrupted` controller row naming
 *   `automatic --live`); no lock is held. Restart is offered.
 * - `controls-refuse`: the same, but its id contains `refuse`, so the fake controller refuses every command.
 * - `controls-running`: a supervisor holds `automatic-supervisor.lock` (a fake `/proc` under `MD_MANAGER_CONTROLS_PROC`
 *   shows the flock, the holder's command line and its start time). Pause is offered; the rest wait for it.
 * - `controls-question`: lane ui waits on question 2 and `terminals.json` records its Herdr pane. Answer is offered.
 * - `controls-finished`: integrated; Clean is offered, Restart is not.
 * - `controls-approval`: an automatic run (finish `approval`) stopped with one `integration_approval` interrupt carrying
 *   `bundle_sha256`. Approve is offered.
 * - `controls-repair`: blocked at ui's verification after the freeze and before review, after the controller's identical-
 *   failure diagnosis. Repair a lane and Retry a check are offered.
 * - `controls-retry-all` (two lanes): stopped after both lanes' verify steps failed. Retry all failed checks is offered.
 * - `controls-relaunch`: lane ui's launch is in `next`, its receipt needs reconciliation and it left no completion, handoff or
 *   stop file. Relaunch a lane is offered for ui; the fake controller's dry run allows it.
 * - `controls-relaunch-refuse`: the same, but the fake controller's dry run refuses the lane (its launch name is taken).
 * The candidate phase writes all of it under the seed root; the worker phase serves the same runs from the explicit
 * payloads, and `controlsFor` builds the run-controls payloads of Appendix A that `mock.ts` serves.
 */
import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateRunDetail, type RunActivity, type RunDetail, type RunInputs, type WorkflowDefinition } from '../../../contracts/projects/v1.ts'
import { eventSchema, type WorkflowEvent } from '../../../contracts/workflow/v1.ts'
import {
  BASE_COMMIT, OUTPUT_COMMIT_UI, PATH_TOKEN, PROJECT, UI_CHECKS, UI_SESSION,
  LANE_ARTIFACTS, backgroundId, definition, laneGraphNodes, launchToken, offset, projectInputs, runDetail, uiResult, uiTask,
  type NodeState, type RawInputsSection, type RawQuestion, type RawWorkerInput, sessionFactsOf} from '../fixtures.ts'
import type { InternalEvent, SeedContext } from '../seed.ts'
import type { UxFixtureModule, UxPayloads } from './index.ts'
import type { Control, ControlId, ControlRecord, RunControls } from '../../../src/projects/controls/types.ts'

export const CONTROLS_WORKFLOW_ID = 'controls'
export const CONTROLS_WORKFLOW_NAME = 'Run controls'
export const CONTROLS_FEATURE = 'Run controls on the run page'
export const RUN_STOPPED = 'controls-stopped'
export const RUN_REFUSE = 'controls-refuse'
export const RUN_RUNNING = 'controls-running'
export const RUN_QUESTION = 'controls-question'
export const RUN_FINISHED = 'controls-finished'
export const RUN_APPROVAL = 'controls-approval'
export const RUN_REPAIR = 'controls-repair'
export const RUN_RETRY_ALL = 'controls-retry-all'
export const RUN_RELAUNCH = 'controls-relaunch'
export const RUN_RELAUNCH_REFUSE = 'controls-relaunch-refuse'
/** The fake controller's lines (the engine's, ASSUMPTIONS E1-E6): `{python}` and `{run}` are the server's argv as it passed them. */
export const RETRY_ALL_LINES = ['worker/ui will run attempt 2', 'worker/adapter will run attempt 2', 'Nothing ran. An automatic run continues under its supervisor: {python} -m workflow automatic {run} --live --by operator']
export const RELAUNCH_ALLOWED = 'relaunch ui: allowed'
export const RELAUNCH_REFUSED = "relaunch ui: refused: session 6f1c2d3e-0000-4000-8000-0000000000aa ('done') carries the launch name ui"
export const RELAUNCH_SESSION = '6f1c2d3e-0000-4000-8000-0000000000bb'
export const RELAUNCH_LINES = [`Relaunched ui once: session ${RELAUNCH_SESSION}; archived ui.interactive.json as ui.interactive.launch-1.json.`, 'Continue the run with:',
  '{python} -m workflow reconcile {run} --by operator', '{python} -m workflow automatic {run} --live --by operator']
/** The pairing token of the browser checks: the config writes it to the token file (0600) and the specs type it. */
export const CONTROLS_TOKEN = 'controls-e2e-pairing-token-0123456789abcdef'
/** The question lane ui waits on, and the digest `controls-approval` waits to have approved. */
export const WAITING_QUESTION = 'Should the Controls button sit in the identity line or in the dock?'
export const APPROVAL_DIGEST = 'a7'.repeat(32)
/** When the fake supervisor of `controls-running` started (UTC), as the Controls list words it. */
export const SUPERVISOR_SINCE = '2026-03-10T09:03:00Z'

type Lane = 'ui' | 'adapter'
const LANES: readonly Lane[] = ['ui']
const TWO_LANES: readonly Lane[] = ['ui', 'adapter']
const NODES = laneGraphNodes(LANES)
const TWO_LANE_NODES = laneGraphNodes(TWO_LANES)
const DAY = '2026-03-10'
const CREATED_AT = `${DAY}T09:00:00Z`
const at = (clock: string) => `${DAY}T${clock}Z`
type Row = [time: string, node: string, status: string, message: string]

const LAUNCHING = 'Launching or reconciling the exact native session'
const AWAITING = 'Awaiting explicit completion signal; idle is not acceptance'
const RESUME_NOTE = 'Supervisor interrupted. Native workers were NOT stopped and keep running; resume with: python -m workflow automatic {run} --live'
const HANDOFF_WAIT = { kind: 'worker_handoff', message: 'Awaiting explicit completion signals and automatic freeze.' }
const IDENTICAL = 'worker/ui failed identically on attempts 1 and 2; not transient, inspect {run} Before review a code fix is a lane repair (RUNBOOK)'
const VERIFY_FAILURE = 'frontend-unit: no passing test evidence or failed tests'

const launch: Row[] = [[at('09:00:10'), 'ui', 'running', LAUNCHING], [at('09:00:14'), 'ui', 'running', AWAITING]]
/** The controller's PID checkpoint: `{pid}` is a PID no process has (above any `pid_max`) unless a fixture says its supervisor is alive. */
const pid = (clock: string): Row => [at(clock), 'controller', 'running', 'Automatic checkpoint controller PID {pid}']
const freeze: Row[] = [[at('09:30:00'), 'freeze', 'stopped', 'Native workers stopped before snapshot capture: ui'], [at('09:30:00'), 'freeze', 'succeeded', 'Immutable snapshots captured; worker-reported checks are not trusted']]
const ok = (session: string | null = null): NodeState => ({ status: 'succeeded', attempt: 1, session })
const waiting: NodeState = { status: 'running', attempt: 1, session: UI_SESSION }

type Fixture = {
  runId: string
  status: RunDetail['summary']['status']
  finish: 'verified-feature-branch' | 'approval'
  events: Row[]
  states: Record<string, NodeState>
  frozen: boolean
  next: string[]
  tasks: { node_id: string; error: string | null; interrupts: object[]; result: object | null }[]
  questions?: RawQuestion[]
  extraValues?: Record<string, unknown>
  stoppedAt: string | null
  activity: RunActivity
  /** The ui lane's verification packets are on disk: the real projection reads a run as finished only with them. */
  verified?: boolean
  /** The run holds a supervisor lock in the fake `/proc` (candidate phase). */
  held?: boolean
  /** The state the Appendix A payload is built for. */
  kind: 'stopped' | 'running' | 'question' | 'finished' | 'approval' | 'repair' | 'retryAll' | 'relaunch'
  /** The lanes the run launched; one (`ui`) unless it says two. */
  lanes?: readonly Lane[]
  /** Further files of the run directory (a launch receipt), by name. */
  files?: Record<string, unknown>
}

const focusOf = (nodeId: string, status: RunDetail['snapshot']['status'], since: string | null) => ({ node_id: nodeId, label: TWO_LANE_NODES.find(node => node.node_id === nodeId)!.label, status, since })
const quiet = (last: string, focus: RunActivity['focus'], extra: Partial<RunActivity> = {}): RunActivity => ({
  feature: CONTROLS_FEATURE, last_activity_at: last, finished_at: null, focus, attention: null, waiting_questions: 0, headline: `Launch ui worker · ${AWAITING}`, controller: null, ...extra,
})

const stoppedRun = (runId: string): Fixture => ({
  runId, kind: 'stopped', status: 'paused', finish: 'verified-feature-branch',
  events: [...launch, pid('09:00:16'), [at('09:20:00'), 'controller', 'interrupted', RESUME_NOTE]],
  states: { launch_ui: waiting, handoff: { status: 'paused', attempt: 1 } }, frozen: false, next: ['handoff'], tasks: [{ node_id: 'handoff', error: null, interrupts: [HANDOFF_WAIT], result: null }],
  stoppedAt: null, activity: quiet(at('09:20:00'), focusOf('handoff', 'paused', at('09:20:00')), { attention: { kind: 'interrupted', node_id: 'handoff', since: at('09:20:00') }, controller: 'not_running' }),
})

const launchTwo: Row[] = [[at('09:00:10'), 'ui', 'running', LAUNCHING], [at('09:00:11'), 'adapter', 'running', LAUNCHING], [at('09:00:14'), 'ui', 'running', AWAITING], [at('09:00:15'), 'adapter', 'running', AWAITING]]
const AMBIGUOUS = 'Launch of ui is ambiguous: its receipt needs reconciliation and no session is live; reconcile or relaunch it (RUNBOOK, Ambiguous startup)'
const relaunchRun = (runId: string): Fixture => ({
  runId, kind: 'relaunch', status: 'failed', finish: 'verified-feature-branch',
  events: [[at('09:00:10'), 'ui', 'running', LAUNCHING], pid('09:00:16'), [at('09:10:00'), 'controller', 'blocked', AMBIGUOUS]],
  states: { launch_ui: { status: 'running', attempt: 1 } }, frozen: false, next: ['launch_ui'], tasks: [], stoppedAt: null,
  files: { 'ui.interactive.json': { node_id: 'ui', status: 'needs_reconciliation', session_id: null, launch_token: launchToken('ui') } },
  activity: quiet(at('09:10:00'), focusOf('launch_ui', 'running', at('09:00:10')), { headline: `Launch ui worker · ${AMBIGUOUS}` }),
})

const FIXTURES: Fixture[] = [
  stoppedRun(RUN_STOPPED),
  stoppedRun(RUN_REFUSE),
  {
    runId: RUN_RUNNING, kind: 'running', status: 'running', finish: 'verified-feature-branch', held: true,
    events: [...launch, pid('09:03:10')],
    states: { launch_ui: waiting }, frozen: false, next: ['handoff'], tasks: [{ node_id: 'handoff', error: null, interrupts: [HANDOFF_WAIT], result: null }], stoppedAt: null,
    activity: quiet(at('09:03:10'), focusOf('launch_ui', 'running', at('09:00:14')), { controller: 'running' }),
  },
  {
    runId: RUN_QUESTION, kind: 'question', status: 'running', finish: 'verified-feature-branch',
    events: [...launch, pid('09:00:16')],
    states: { launch_ui: waiting }, frozen: false, next: ['handoff'], tasks: [{ node_id: 'handoff', error: null, interrupts: [HANDOFF_WAIT], result: null }], stoppedAt: null,
    questions: [
      { n: 1, question: 'Which route serves the controls?', asked_at: at('09:05:00'), answer: 'Under /api/run-controls.', answered_at: at('09:06:00') },
      { n: 2, question: WAITING_QUESTION, asked_at: at('09:12:00'), answer: null, answered_at: null },
    ],
    activity: quiet(at('09:12:00'), focusOf('launch_ui', 'running', at('09:12:00')), { attention: { kind: 'question', node_id: 'launch_ui', since: at('09:12:00') }, waiting_questions: 1, controller: 'not_running' }),
  },
  {
    runId: RUN_FINISHED, kind: 'finished', status: 'succeeded', verified: true, finish: 'verified-feature-branch',
    events: [...launch, pid('09:00:16'), ...freeze, [at('09:31:00'), 'verify_ui', 'succeeded', 'Required tests and artifacts passed'], [at('09:35:00'), 'candidate_ui', 'succeeded', 'Combined revision'],
      [at('09:40:00'), 'review', 'approved', 'Independent reviewer approved the candidate'], [at('09:41:00'), 'integrate', 'succeeded', 'Fast-forwarded the feature branch']],
    states: { launch_ui: ok(UI_SESSION), handoff: ok(), verify_ui: ok(), candidate: ok(), review: ok(), approval: ok(), integrate: ok() }, frozen: true, next: [], tasks: [], stoppedAt: at('09:30:00'),
    extraValues: {
      review: { run_id: RUN_FINISHED, verdict: 'approved', independent: true, reviewer: 'synthetic-reviewer', findings: [] },
      bundle: { run_id: RUN_FINISHED, base_commit: BASE_COMMIT, candidate_commit: 'c'.repeat(40), policy_sha256: 'e'.repeat(64) },
      approved_bundle: 'f'.repeat(64), integrated_commit: 'c'.repeat(40),
    },
    activity: quiet(at('09:41:00'), null, { finished_at: at('09:41:00'), headline: 'Integrate candidate' }),
  },
  {
    runId: RUN_APPROVAL, kind: 'approval', status: 'awaiting_approval', finish: 'approval',
    events: [...launch, pid('09:00:16'), ...freeze, [at('09:31:00'), 'verify_ui', 'succeeded', 'Required tests and artifacts passed'], [at('09:35:00'), 'candidate_ui', 'succeeded', 'Combined revision'],
      [at('09:40:00'), 'review', 'approved', 'Independent reviewer approved the candidate']],
    states: { launch_ui: ok(UI_SESSION), handoff: ok(), verify_ui: ok(), candidate: ok(), review: ok(), approval: { status: 'awaiting_approval', attempt: 1 } }, frozen: true, next: ['approval'],
    tasks: [{ node_id: 'approval', error: null, interrupts: [{ kind: 'integration_approval', message: 'Integration requires explicit approval of the reviewed bundle.', bundle_sha256: APPROVAL_DIGEST }], result: null }],
    stoppedAt: at('09:30:00'),
    activity: quiet(at('09:40:00'), focusOf('approval', 'awaiting_approval', at('09:40:00')), { attention: { kind: 'approval', node_id: 'approval', since: at('09:40:00') }, headline: 'Integration approval' }),
  },
  {
    runId: RUN_REPAIR, kind: 'repair', status: 'failed', finish: 'verified-feature-branch',
    events: [...launch, pid('09:00:16'), ...freeze, [at('09:30:00'), 'verify_ui', 'running', `Attempt 1; revision ${OUTPUT_COMMIT_UI}`], [at('09:31:00'), 'verify_ui', 'blocked', VERIFY_FAILURE],
      [at('09:31:10'), 'verify_ui', 'running', `Attempt 2; revision ${OUTPUT_COMMIT_UI}`], [at('09:32:00'), 'verify_ui', 'blocked', VERIFY_FAILURE], pid('09:32:02'),
      [at('09:32:02'), 'controller', 'blocked', IDENTICAL]],
    states: { launch_ui: ok(UI_SESSION), handoff: ok(), verify_ui: { status: 'failed', attempt: 2 } }, frozen: true, next: ['verify_ui'],
    tasks: [{ node_id: 'verify_ui', error: 'Verification of lane ui failed identically on attempts 1 and 2', interrupts: [], result: null }], stoppedAt: at('09:30:00'),
    activity: quiet(at('09:32:02'), focusOf('verify_ui', 'failed', at('09:32:02')), { attention: { kind: 'failed', node_id: 'verify_ui', since: at('09:32:02') }, headline: 'Verify ui' }),
  },
  {
    runId: RUN_RETRY_ALL, kind: 'retryAll', status: 'failed', finish: 'verified-feature-branch', lanes: TWO_LANES,
    events: [...launchTwo, pid('09:00:16'), [at('09:30:00'), 'freeze', 'stopped', 'Native workers stopped before snapshot capture: ui, adapter'],
      [at('09:30:00'), 'freeze', 'succeeded', 'Immutable snapshots captured; worker-reported checks are not trusted'],
      [at('09:30:05'), 'verify_ui', 'running', `Attempt 1; revision ${OUTPUT_COMMIT_UI}`], [at('09:30:06'), 'verify_adapter', 'running', `Attempt 1; revision ${OUTPUT_COMMIT_UI}`],
      [at('09:31:00'), 'verify_ui', 'blocked', VERIFY_FAILURE], [at('09:31:30'), 'verify_adapter', 'blocked', VERIFY_FAILURE]],
    states: { launch_ui: ok(UI_SESSION), launch_adapter: ok(), handoff: ok(), verify_ui: { status: 'failed', attempt: 1 }, verify_adapter: { status: 'failed', attempt: 1 } }, frozen: true,
    next: ['verify_ui', 'verify_adapter'], stoppedAt: at('09:30:00'),
    tasks: [{ node_id: 'verify_ui', error: 'Verification of lane ui failed', interrupts: [], result: null }, { node_id: 'verify_adapter', error: 'Verification of lane adapter failed', interrupts: [], result: null }],
    activity: quiet(at('09:31:30'), focusOf('verify_adapter', 'failed', at('09:31:30')), { attention: { kind: 'failed', node_id: 'verify_adapter', since: at('09:31:30') }, headline: 'Verify adapter' }),
  },
  relaunchRun(RUN_RELAUNCH),
  relaunchRun(RUN_RELAUNCH_REFUSE),
]

const PINNED: WorkflowDefinition = definition(PROJECT.project_id, CONTROLS_WORKFLOW_ID, CONTROLS_WORKFLOW_NAME, NODES)
const PINNED_TWO: WorkflowDefinition = definition(PROJECT.project_id, CONTROLS_WORKFLOW_ID, CONTROLS_WORKFLOW_NAME, TWO_LANE_NODES)
const lanesOf = (fixture: Fixture) => fixture.lanes ?? LANES
const DEAD_PID = 2_000_000_000
/** `alive`: the seeding process itself, which outlives the run page's checks, so the server reads this run's controller as running. */
const rows = (fixture: Fixture, runDir: string, alive = false): InternalEvent[] => fixture.events.map(([time, node, status, message], index) => ({
  sequence: index + 1, time, node, status, message: message.replaceAll('{run}', runDir).replaceAll('{pid}', String(alive && fixture.held ? process.pid : DEAD_PID)),
}))
const updatedAt = (fixture: Fixture) => fixture.events.at(-1)![0]
const mockRunDir = (runId: string) => `~/.local/state/agent-workflows/${PROJECT.project_id}/${CONTROLS_WORKFLOW_ID}/${runId}`

function rawWorker(fixture: Fixture, leak: string, lane: Lane = 'ui'): RawWorkerInput {
  return {
    role: 'frontend', required_check_kinds: ['build', 'browser'], task: uiTask(leak), prompt: null, owned_paths: ['src/projects'], checks: UI_CHECKS,
    launch: { session_id: UI_SESSION, launch_token: launchToken(lane), launch_requested_at: offset(fixture.events[0][0]), native_started_at: Date.parse(fixture.events[0][0]), observed_state: fixture.stoppedAt ? 'done' : 'working', status: 'attached_session_available', launcher_invocations: 1, background_id: backgroundId(lane) },
    completion: null, handoff: null, stop: fixture.stoppedAt ? { stopped: true, confirmed_at: offset(fixture.stoppedAt) } : null, questions: fixture.questions ?? [],
  }
}

function inputsSection(fixture: Fixture, leak: string): RawInputsSection {
  return {
    feature: CONTROLS_FEATURE, policy_version: '1.2.0', base_commit: BASE_COMMIT, source_branch: `feature/${CONTROLS_WORKFLOW_ID}/${fixture.runId}`, mode: 'automatic',
    automatic: { finish: fixture.finish, permission_mode: 'bypassPermissions', worker_timeout_seconds: 7200, review_timeout_seconds: 1800, reviewer_transport: 'native' },
    setup: [{ argv: ['npm', 'ci'], command: 'npm ci', timeout_seconds: 600 }], max_verification_attempts: 3, failure_drill: null,
    selected_workers: [...lanesOf(fixture)], excluded_workers: [], workers: Object.fromEntries(lanesOf(fixture).map(lane => [lane, rawWorker(fixture, leak, lane)])),
  }
}

const EVENT_STATUS: Record<string, WorkflowEvent['status']> = { running: 'running', interactive: 'running', blocked: 'failed', succeeded: 'succeeded', approved: 'succeeded', stopped: null, paused: 'paused', interrupted: 'paused' }

function servedEvents(fixture: Fixture): WorkflowEvent[] {
  const known = new Set((fixture.lanes ? TWO_LANE_NODES : NODES).map(node => node.node_id))
  const nodeOf = (node: string) => known.has(node) ? node : node === 'freeze' ? 'handoff' : node === 'ui' || node === 'adapter' ? `launch_${node}` : node === 'candidate_ui' ? 'candidate' : null
  return rows(fixture, PATH_TOKEN).map(record => {
    const node_id = nodeOf(record.node)
    const status = node_id ? EVENT_STATUS[record.status] ?? null : null
    return eventSchema.parse({
      contract_version: '1.0.0', run_id: fixture.runId, event_id: `${fixture.runId}:${record.sequence}`, sequence: record.sequence, occurred_at: record.time,
      node_id, attempt: node_id ? 1 : 0, type: status && node_id ? 'status_changed' : 'log', status, message: record.message, artifact: null, result_uri: null, reused_from_attempt: null,
    })
  })
}

function detailOf(fixture: Fixture): RunDetail {
  const base = runDetail(fixture.runId, fixture.status, fixture.lanes ? PINNED_TWO : PINNED, CREATED_AT, updatedAt(fixture), fixture.states, fixture.events.length)
  return validateRunDetail({ ...base, summary: { ...base.summary, contract_version: '1.5.0', activity: fixture.activity }, run_dir: mockRunDir(fixture.runId) })
}

const payloads: UxPayloads = {
  // run-sessions ([L5]): the raw facts its seed writes, for the shared session-node projection.
  reviewerIds: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, sessionFactsOf('1.5.0', null)])),
  workflows: [PINNED],
  runDetails: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, detailOf(fixture)])),
  runEvents: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, servedEvents(fixture)])),
  workerResults: {},
  reviewResults: {},
  runInputs: Object.fromEntries(FIXTURES.map((fixture): [string, RunInputs] => [fixture.runId, projectInputs(fixture.runId, inputsSection(fixture, PATH_TOKEN))])),
  artifactFiles: {},
}

// ---- The fake /proc of `controls-running` (decisions [L1] 3d, proc(5)) --------------------------------------------------

/** Where the candidate phase's fake `/proc` lives: beside the seeded runs, under the seed root. */
export const fakeProcRoot = (seedRoot: string) => join(seedRoot, 'fake-proc')

/** The kernel's major:minor split of a `st_dev`, in BigInt: JavaScript's 32-bit shifts would truncate it (design challenge note 2). */
export function majorMinor(dev: bigint): { major: bigint; minor: bigint } {
  return { major: ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn), minor: (dev & 0xffn) | ((dev >> 12n) & ~0xffn) }
}

const FAKE_PID = 4242
const BOOT_TIME = Date.parse('2026-03-10T00:00:00Z') / 1000
const CLK_TCK = 100

function writeFakeProc(root: string, held: { runDir: string; python: string }[]) {
  const lines: string[] = []
  mkdirSync(root, { recursive: true })
  held.forEach(({ runDir, python }, index) => {
    const lock = join(runDir, 'automatic-supervisor.lock')
    const info = statSync(lock, { bigint: true })
    const { major, minor } = majorMinor(info.dev)
    lines.push(`${index + 1}: FLOCK  ADVISORY  WRITE ${FAKE_PID + index} ${major.toString(16).padStart(2, '0')}:${minor.toString(16).padStart(2, '0')}:${info.ino} 0 EOF`)
    const process = join(root, String(FAKE_PID + index))
    mkdirSync(process, { recursive: true })
    writeFileSync(join(process, 'cmdline'), [python, '-m', 'workflow', 'automatic', runDir, '--live', '--by', 'operator'].join('\0') + '\0')
    // proc(5): field 5 is the process group, field 22 the start time in clock ticks after boot.
    const started = Math.round((Date.parse(SUPERVISOR_SINCE) / 1000 - BOOT_TIME) * CLK_TCK)
    const fields = ['S', '1', String(FAKE_PID + index), String(FAKE_PID + index), '0', '-1', '4194304', '0', '0', '0', '0', '0', '0', '0', '0', '20', '0', '1', '0', String(started)]
    writeFileSync(join(process, 'stat'), `${FAKE_PID + index} (python) ${fields.join(' ')} ${Array(30).fill('0').join(' ')}\n`)
  })
  writeFileSync(join(root, 'locks'), lines.length ? `${lines.join('\n')}\n` : '')
  writeFileSync(join(root, 'stat'), `cpu  1 1 1 1 0 0 0 0 0 0\nbtime ${BOOT_TIME}\n`)
}

function seed({ repository, runsRoot, writeRun, writePacket, receipt, leakFor }: SeedContext) {
  const root = runsRoot(CONTROLS_WORKFLOW_ID)
  const held: { runDir: string; python: string }[] = []
  for (const fixture of FIXTURES) {
    const runDir = join(root, fixture.runId)
    const lanes = lanesOf(fixture)
    writeRun(root, repository, fixture.runId, {
      createdAt: CREATED_AT, updatedAt: updatedAt(fixture), definitionNodes: fixture.lanes ? TWO_LANE_NODES : NODES, definitionName: CONTROLS_WORKFLOW_NAME, version: '1.5.0', lanes,
      values: {
        lanes: Object.fromEntries(lanes.map(lane => [lane, receipt(lane, runDir, UI_SESSION, at('09:00:08'))])),
        ...(fixture.verified ? { ui_packet: 'verification/worker/ui/1/packet.json' } : {}),
        ...(fixture.frozen ? { snapshots: Object.fromEntries(lanes.map(lane => [lane, OUTPUT_COMMIT_UI])) } : {}),
        ...(fixture.extraValues ?? {}),
      },
      next: fixture.next, tasks: fixture.tasks, events: rows(fixture, runDir, true), packets: dir => (fixture.verified
        ? (['worker', 'candidate'] as const).map(phase => writePacket(dir, phase, 'ui', 1, uiResult(fixture.runId), LANE_ARTIFACTS.ui, { status: 'passed', reasons: [] })) : []),
      review: null, inputs: inputsSection(fixture, leakFor(root, fixture.runId)),
    })
    // The controller keeps its lock file after release; only the running supervisor holds it, in the fake /proc.
    writeFileSync(join(runDir, 'automatic-supervisor.lock'), '')
    for (const [name, content] of Object.entries(fixture.files ?? {})) writeFileSync(join(runDir, name), `${JSON.stringify(content, null, 2)}\n`)
    if (fixture.held) held.push({ runDir, python: '/usr/bin/python3' })
    if (fixture.questions) {
      const live = fixture.questions.map(question => ({ ...question, asked_at: offset(question.asked_at), answered_at: question.answered_at && offset(question.answered_at) }))
      writeFileSync(join(runDir, 'ui.questions.json'), `${JSON.stringify({ questions: live }, null, 2)}\n`)
      // The lane's Herdr pane, so the server offers `answer` (decisions [L2]).
      writeFileSync(join(runDir, 'terminals.json'), `${JSON.stringify({ ui: { pane_id: 'pane-ui', tab_id: 'tab-1', mode: 'attach_requested' } }, null, 2)}\n`)
    }
  }
  writeFakeProc(fakeProcRoot(dirname(dirname(root))), held)
  return { workflows: [{ workflow_id: CONTROLS_WORKFLOW_ID, runs_root: root, definition: { name: CONTROLS_WORKFLOW_NAME, nodes: NODES } }] }
}

export const uxControls: UxFixtureModule = { payloads, seed }

// ---- The environment that turns the controls on (decisions [L5]) -------------------------------------------------------

/** The fake controller (Appendix A.3): the `MD_MANAGER_WORKFLOW_PYTHON` of the candidate phase and the critique app. */
export const FAKE_CONTROLLER = fileURLToPath(new URL('../fake-controller.py', import.meta.url))

/**
 * Writes what the server needs to turn the controls on under `root` and returns the API environment: the token file with
 * mode 0600 and the 32 characters or more the server requires, the fake controller chmod 0755 whatever the umask, and the
 * state, proc and log paths under the root. `HERDR_ENV=1` lets the server offer `answer` where a pane is recorded ([L2]).
 */
export function controlsEnvironment(root: string, seedRoot: string, token: string = CONTROLS_TOKEN): Record<string, string> {
  const tokenFile = join(root, 'controls.token')
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 })
  chmodSync(tokenFile, 0o600)
  chmodSync(FAKE_CONTROLLER, 0o755)
  const controller = writeRecoveryController(root)
  return {
    MD_MANAGER_RUN_CONTROLS: 'on',
    MD_MANAGER_WORKFLOW_PYTHON: controller,
    MD_MANAGER_WORKFLOW_HOME: root,
    MD_MANAGER_CONTROLS_TOKEN_FILE: tokenFile,
    MD_MANAGER_CONTROLS_STATE: join(root, 'controls-state'),
    MD_MANAGER_CONTROLS_SPAWN: 'direct',
    MD_MANAGER_CONTROLS_PROC: fakeProcRoot(seedRoot),
    MD_MANAGER_FAKE_CONTROLLER_LOG: join(root, 'fake-controller.log'),
    HERDR_ENV: '1',
  }
}

/**
 * The fake controller of this stage: the commands `workflow-collected-fixes` adds (`retry --help`, `retry --all-failed`,
 * `relaunch --help`, `relaunch [--dry-run]`) answered with the engine's lines verbatim (ASSUMPTIONS E1-E6), every other argv
 * handed to `fake-controller.py` unchanged. Written under the test root (never the repository) and chmod 0755; it logs its argv
 * like the base fake, prints only and never touches a run directory, so the real continuation after a relaunch is the engine's.
 */
function writeRecoveryController(root: string): string {
  const path = join(root, 'fake-controller-recovery.py')
  const lines = (list: readonly string[]) => JSON.stringify(list)
  writeFileSync(path, `#!/usr/bin/env python3
import json, os, sys
argv = sys.argv[1:]
base = ${JSON.stringify(FAKE_CONTROLLER)}
def log():
    path = os.environ.get("MD_MANAGER_FAKE_CONTROLLER_LOG")
    if path:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(argv) + "\\n")
def say(lines, run):
    for line in lines:
        print(line.replace("{python}", sys.argv[0]).replace("{run}", run))
verb = argv[2] if len(argv) > 2 and argv[:2] == ["-m", "workflow"] else None
rest = argv[3:]
if verb == "retry" and rest == ["--help"]:
    log(); print("usage: python -m workflow retry [-h] [--phase {worker,candidate}] [--node NODE] [--all-failed] --by BY run"); sys.exit(0)
if verb == "relaunch" and rest == ["--help"]:
    log(); print("usage: python -m workflow relaunch [-h] [--dry-run] --by BY run lane"); sys.exit(0)
if verb == "retry" and "--all-failed" in rest:
    log()
    run = rest[0]
    if "refuse" in os.path.basename(run.rstrip("/")):
        print("Blocked: No verify step failed or was left without a verdict; nothing to retry", file=sys.stderr); sys.exit(1)
    say(${lines(RETRY_ALL_LINES)}, run); sys.exit(0)
if verb == "relaunch":
    log()
    run, lane = rest[0], rest[1]
    refused = "refuse" in os.path.basename(run.rstrip("/"))
    if "--dry-run" in rest:
        print((${JSON.stringify(RELAUNCH_REFUSED)} if refused else ${JSON.stringify(RELAUNCH_ALLOWED)}).replace(" ui", " " + lane, 1)); sys.exit(1 if refused else 0)
    if refused:
        print("Blocked: " + ${JSON.stringify(RELAUNCH_REFUSED.split(': refused: ')[1])}, file=sys.stderr); print("Nothing was relaunched."); sys.exit(1)
    say(${lines(RELAUNCH_LINES)}, run); sys.exit(0)
os.execv(base, [base] + argv)
`)
  chmodSync(path, 0o755)
  return path
}

// ---- The worker phase's run-controls payloads (Appendix A) ------------------------------------------------------------

const PY = '$PY -m workflow'
type Spec = Pick<Control, 'label' | 'runs' | 'confirm' | 'effect' | 'not_effect'> & { command: string }
const CATALOG: Record<ControlId, Spec> = {
  restart: { label: 'Restart supervisor', runs: 'long', confirm: 'plain', command: `${PY} automatic "$RUN" --live --by operator`, effect: 'Starts the automatic supervisor again; it continues from the checkpoint and starts model sessions where the run needs them.', not_effect: 'It relaunches nothing the controller has a receipt for.' },
  pause: { label: 'Pause supervisor (workers keep running)', runs: 'signal', confirm: 'plain', command: 'SIGINT to the supervisor\'s process group (as Ctrl-C in its terminal)', effect: 'Interrupts the supervisor the way Ctrl-C in its terminal does; the run records it as interrupted.', not_effect: 'It does not stop the workers or reviewers: their sessions keep running and a later restart waits for them again. To stop everything, abandon the run.' },
  retry: { label: 'Retry a check', runs: 'short', confirm: 'plain', command: `${PY} retry "$RUN" --phase <worker|candidate> --node <lane> --by operator`, effect: 'Raises the attempt of one lane\'s check.', not_effect: 'On an automatic run it only prints the restart command; it does not restart the supervisor.' },
  reconcile: { label: 'Reconcile launches', runs: 'short', confirm: 'plain', command: `${PY} reconcile "$RUN" --by operator`, effect: 'Reconciles the launch receipts with the sessions that exist.', not_effect: 'Inspect the receipts first (RUNBOOK); it launches nothing new.' },
  resume: { label: 'Rerun the design challenge', runs: 'long', confirm: 'plain', command: `${PY} resume "$RUN" --by operator`, effect: 'Reruns the design challenge on the edited task files.', not_effect: null },
  accept_challenge: { label: 'Accept the challenge', runs: 'long', confirm: 'plain', command: `${PY} resume "$RUN" --accept-challenge="<reason>" --by operator`, effect: 'Records your override of the paused challenge and launches the workers.', not_effect: null },
  release_hold: { label: 'Launch the workers', runs: 'long', confirm: 'plain', command: `${PY} resume "$RUN" --launch --by operator`, effect: 'Launches the workers with the challenge notes.', not_effect: null },
  answer: { label: 'Answer the question', runs: 'short', confirm: 'plain', command: `${PY} answer "$RUN" <lane> --by operator -- "<text>"`, effect: 'Records your answer and types it into the lane\'s Herdr pane.', not_effect: null },
  approve: { label: 'Approve and integrate', runs: 'short', confirm: 'typed_run_id', command: `${PY} approve "$RUN" --bundle-sha256 ${APPROVAL_DIGEST.slice(0, 12)}… --by operator`, effect: 'Approves the reviewed bundle (digest a7a7a7a7a7a7…) and integrates it into the feature branch.', not_effect: 'Only this exact reviewed bundle: a changed candidate is refused.' },
  repair_session: { label: 'Repair a lane', runs: 'long', confirm: 'typed_run_id', command: `${PY} repair "$RUN" <lane> --session --live --by operator`, effect: 'Starts a repair session for the lane that failed its check.', not_effect: 'It does not edit your source checkout.' },
  abandon: { label: 'Abandon the run', runs: 'short', confirm: 'typed_run_id', command: `${PY} abandon "$RUN" --reason="<reason>" --by operator`, effect: 'Stops every recorded session and closes the run for good.', not_effect: 'Worktrees and evidence stay until you clean them.' },
  clean: { label: 'Clean worktrees', runs: 'short', confirm: 'typed_run_id', command: `${PY} clean "$RUN" --by operator`, effect: 'Removes the run\'s worktrees; the dry run below lists them.', not_effect: 'Evidence and the run\'s records stay.' },
  retry_all: { label: 'Retry all failed checks', runs: 'short', confirm: 'plain', command: `${PY} retry "$RUN" --phase worker --all-failed --by operator`, effect: 'Raises the attempt of every lane whose worker check failed or was left without a verdict, in one command; Restart supervisor then reruns them.', not_effect: 'It runs no check itself and never retries a combined (candidate) check.' },
  relaunch: { label: 'Relaunch a lane', runs: 'short', confirm: 'plain', command: `${PY} relaunch "$RUN" <lane> --by operator`, effect: 'Relaunches the lane\'s worker session once, after its dry run shows the controller allows it; continue with Reconcile launches and then Restart supervisor.', not_effect: 'It reconciles and restarts nothing itself, and relaunches a lane at most once.' },
  note: { label: 'Send a note to the lead', runs: 'short', confirm: 'plain', command: `${PY} note "$RUN" <lane> --by operator -- "<text>"`, effect: 'Types your note into the lane\'s lead session between its turns and records it in <lane>.notes.json.', not_effect: 'It does not interrupt a running tool call; a team workflow that is running takes no input until it returns.' },
}

const ORDER: ControlId[] = ['restart', 'pause', 'retry', 'reconcile', 'resume', 'accept_challenge', 'release_hold', 'answer', 'approve', 'repair_session', 'abandon', 'clean', 'retry_all', 'relaunch', 'note']
/** The reasons of a controller without the two 1.1.0 commands (the server's capability read failed closed). */
export const OLDER_CONTROLLER_REASONS: Partial<Record<ControlId, string>> = {
  retry_all: 'This controller has no `retry --all-failed` (workflow-collected-fixes is not merged)',
  relaunch: 'This controller has no `relaunch` command (workflow-collected-fixes is not merged)',
}
const SUPERVISOR = 'A supervisor is running (since 09:03 UTC)'
const REASONS: Record<ControlId, string> = {
  restart: 'The run is finished', pause: 'No supervisor of this run is running', retry: 'No lane\'s check failed or was interrupted without a verdict', reconcile: 'The run does not need reconciling',
  resume: 'No design challenge is paused or held', accept_challenge: 'No design challenge is paused', release_hold: 'No design challenge is held', answer: 'No lane has an unanswered question',
  approve: 'The run is not waiting for approval', repair_session: 'No lane is blocked at a check after the freeze', abandon: 'The run is already integrated', clean: 'The run is not finished or abandoned',
  retry_all: 'Fewer than two worker checks failed', relaunch: 'No lane launch is waiting to be relaunched', note: 'No lane\'s worker is launched and still working',
}
const WITH_SUPERVISOR: ControlId[] = ['restart', 'retry', 'reconcile', 'resume', 'accept_challenge', 'release_hold', 'repair_session', 'abandon', 'clean', 'retry_all', 'relaunch']
const OFFERED: Record<Fixture['kind'], ControlId[]> = {
  stopped: ['restart', 'abandon'], running: ['pause'], question: ['restart', 'answer', 'abandon'], finished: ['clean'], approval: ['restart', 'approve', 'abandon'], repair: ['restart', 'retry', 'repair_session', 'abandon'],
  retryAll: ['restart', 'retry', 'repair_session', 'abandon', 'retry_all'], relaunch: ['restart', 'reconcile', 'abandon', 'relaunch'],
}

const paramsOf = (id: ControlId, fixture: Fixture): Control['params'] => {
  switch (id) {
    case 'retry': return [{ name: 'lane', kind: 'choice', choices: [...lanesOf(fixture)], required: true }, { name: 'phase', kind: 'choice', choices: fixture.kind === 'retryAll' ? ['worker'] : ['worker', 'candidate'], required: true }]
    case 'relaunch': return [{ name: 'lane', kind: 'choice', choices: fixture.kind === 'relaunch' ? ['ui'] : [], required: true }]
    case 'note': return [{ name: 'lane', kind: 'choice', choices: [], required: true }, { name: 'text', kind: 'text', min_length: 1, max_length: 2000, required: true }]
    case 'answer': return [{ name: 'lane', kind: 'choice', choices: ['ui'], required: true }, { name: 'text', kind: 'text', min_length: 1, max_length: 4000, required: true }]
    case 'accept_challenge': return [{ name: 'reason', kind: 'text', min_length: 10, max_length: 500, required: true }]
    case 'release_hold': return [{ name: 'drop', kind: 'multi', choices: [1, 2], required: false }]
    case 'repair_session': return [{ name: 'lane', kind: 'choice', choices: [...lanesOf(fixture)], required: true }, { name: 'confirm_run_id', kind: 'typed', required: true }]
    case 'abandon': return [{ name: 'reason', kind: 'text', min_length: 3, max_length: 500, required: true }, { name: 'confirm_run_id', kind: 'typed', required: true }]
    case 'approve': case 'clean': return [{ name: 'confirm_run_id', kind: 'typed', required: true }]
    default: return []
  }
}

/** The run's controls as the server answers `GET /api/run-controls/<project>/<workflow>/<run>` (Appendix A.2). */
export function controlsFor(runId: string, token: string, records: ControlRecord[] = [], options: { older?: boolean } = {}): RunControls | null {
  const fixture = FIXTURES.find(item => item.runId === runId)
  if (!fixture) return null
  const running = fixture.kind === 'running'
  return {
    version: '1.2.0', run_state_token: token, supervisor: running ? 'running' : 'not_running', supervisor_since: running ? SUPERVISOR_SINCE : null,
    controls: ORDER.map((id): Control => {
      const absent = options.older ? OLDER_CONTROLLER_REASONS[id] : undefined
      const available = absent === undefined && OFFERED[fixture.kind].includes(id)
      const reason = available ? null : absent ?? (running && WITH_SUPERVISOR.includes(id) ? SUPERVISOR : REASONS[id])
      return { id, ...CATALOG[id], available, reason, recommended: false, params: paramsOf(id, fixture) }
    }),
    records,
  }
}

export const CONTROLS_RUNS = FIXTURES.map(fixture => fixture.runId)
