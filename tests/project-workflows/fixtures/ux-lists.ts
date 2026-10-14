/**
 * Fixtures of viewer UX slice S6, the run lists (`ux-lists.spec.ts`) (docs/PRD_VIEWER_UX.md 12.2), registered as the
 * workflow `ux-lists`: mock payloads for the worker phase and a `seed` for the candidate phase, merged by `index.ts`.
 *
 * The workflow carries the exporter's generic name, "Feature implementation", so the title rule names it by its latest
 * run's feature (`LISTS_FEATURE`). Its runs sit around `LISTS_NOW`, the instant the specs fix the page clock at:
 * - `lists-asking` (running): ui's question 1 waits in the live `ui.questions.json` only; the export, not rewritten while
 *   the handoff waits (C5), records none. Needs you, `question`.
 * - `lists-answered` (running): the export still shows ui's question 1 waiting, but the live `ui.questions.json` records it
 *   answered; adapter needs attention in its pane. Needs you, `pane`, never `question`.
 * - `lists-approval` (awaiting approval): a manual run whose handoff waits for the operator's freeze. Needs you, `approval`.
 * - `lists-live` (running): nothing waits. Running. Its worker-phase mock serves `controller: running`.
 * - `lists-stopped` (running): its controller's process is gone (`controller: not_running` in both phases).
 * - `lists-failed` (failed yesterday after 52m51s) and `lists-failed-earlier` (three days ago): Recent, newest first.
 * - `lists-old` (failed ten days ago): not in Recent, still on its project page.
 * Every running run logged a controller PID. The seeded PID is above any `pid_max`, so in the candidate phase no process
 * has it and the server reads `not_running`. The candidate registry lists the project under `viewer.expose_run_dir`;
 * its runs live under the temporary root, outside `$HOME`, so the server still serves `run_dir: null`. The worker-phase
 * mocks serve a `run_dir` for every run of this workflow and the served `activity` of contract 1.5.0, as the server
 * computes it from the same records.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateRunDetail, type RunActivity, type RunDetail, type RunInputs, type RunSummary, type WorkflowDefinition } from '../../../contracts/projects/v1.ts'
import { eventSchema, type WorkflowEvent } from '../../../contracts/workflow/v1.ts'
import {
  ADAPTER_CHECKS, ADAPTER_SESSION, BASE_COMMIT, OUTPUT_COMMIT_ADAPTER, OUTPUT_COMMIT_UI, PATH_TOKEN, PROJECT, UI_CHECKS, UI_SESSION,
  adapterTask, backgroundId, definition, laneGraphNodes, launchToken, offset, projectInputs, runDetail, uiTask,
  type NodeState, type RawInputsSection, type RawQuestion, type RawWorkerInput,
} from '../fixtures.ts'
import type { InternalEvent, SeedContext } from '../seed.ts'
import type { UxFixtureModule, UxPayloads } from './index.ts'

export const UX_LISTS_WORKFLOW_ID = 'ux-lists'
/** The exporter's generic definition name: the title rule replaces it with the latest run's feature. */
export const UX_LISTS_WORKFLOW_NAME = 'Feature implementation'
export const LISTS_FEATURE = 'Runs home lists'
/** The instant the lists specs fix the page clock at: noon on the day the live runs started. */
export const LISTS_NOW = '2026-03-20T12:00:00Z'

export const RUN_LISTS_ASKING = 'lists-asking'
export const RUN_LISTS_ANSWERED = 'lists-answered'
export const RUN_LISTS_APPROVAL = 'lists-approval'
export const RUN_LISTS_LIVE = 'lists-live'
export const RUN_LISTS_STOPPED = 'lists-stopped'
export const RUN_LISTS_FAILED = 'lists-failed'
export const RUN_LISTS_FAILED_EARLIER = 'lists-failed-earlier'
export const RUN_LISTS_OLD = 'lists-old'

/** ui's question in `lists-asking`, recorded only in the live `ui.questions.json`. */
export const ASKING_QUESTION = 'Should Recent keep runs that finished more than seven days ago?'
/** ui's question in `lists-answered`: waiting in the export, answered in the live `ui.questions.json`. */
export const ANSWERED_QUESTION = 'Should the project cards show the number of features?'
export const ANSWER = 'Yes, beside the latest run.'
/** The run directory the worker-phase mocks serve (B3); the candidate phase serves null under its temporary root. */
export const mockRunDir = (runId: string) => `~/.local/state/agent-workflows/${PROJECT.project_id}/${UX_LISTS_WORKFLOW_ID}/${runId}`
/** Above any Linux `pid_max` (at most 2^22): no process ever has it. */
const DEAD_PID = 2_000_000_000

type Lane = 'ui' | 'adapter'
type Row = [at: string, node: string, status: string, message: string]
const LANES: readonly Lane[] = ['ui', 'adapter']
const NODES = laneGraphNodes(LANES)
const SESSIONS: Record<Lane, string> = { ui: UI_SESSION, adapter: ADAPTER_SESSION }

type Fixture = {
  runId: string
  status: RunDetail['summary']['status']
  mode: 'automatic' | 'manual'
  createdAt: string
  events: Row[]
  /** The snapshot the adapter projects from these records, for the worker-phase mock. */
  states: Record<string, NodeState>
  /** Graph values the export holds: the launch receipts, and the frozen snapshots once the handoff froze. */
  frozen: boolean
  next: string[]
  tasks: { node_id: string; error: string | null; interrupts: object[]; result: object | null }[]
  /** The export's questions per lane. */
  questions?: Partial<Record<Lane, RawQuestion[]>>
  /** Each lane's live `<lane>.questions.json`, which the controller writes while the handoff waits. */
  live?: Partial<Record<Lane, RawQuestion[]>>
  /** When both workers' stops were confirmed; null while they run. */
  stoppedAt: string | null
  /** The served activity (contract 1.5.0) for the worker-phase mock: what the server computes from these records. */
  activity: RunActivity
}

const LAUNCHING = 'Launching or reconciling the exact native session'
const AWAITING = 'Awaiting explicit completion signal; idle is not acceptance'
const DRILL = 'Injected gate failure (failure drill); checks preserved'
const HANDOFF_WAIT = { kind: 'worker_handoff', message: 'Awaiting explicit completion signals and automatic freeze.' }
const MANUAL_HANDOFF = { kind: 'worker_handoff', message: 'Freeze the worker handoffs with: python -m workflow freeze <run> --handoff <lane>=<path>' }
/** How the server's headline words `AWAITING` (triage.ts `humanizeEvent`). */
const AWAITING_HEADLINE = "Launch ui worker · waiting for the worker's completion signal (idle is not acceptance)"
const PANE_MESSAGE = 'Worker adapter needs attention in its pane (native state blocked); waiting until its deadline'

const at = (day: string, clock: string) => `${day}T${clock}Z`
/** `seconds` after `start`, as the controller writes times. */
const after = (start: string, seconds: number) => new Date(Date.parse(start) + seconds * 1000).toISOString().replace(/\.000Z$/, 'Z')
/** Both sessions launched 10 s after the run was created, and signalled nothing 4 s later. */
const launch = (created: string): Row[] => [
  ...LANES.map((lane): Row => [after(created, 10), lane, 'running', LAUNCHING]),
  ...LANES.map((lane): Row => [after(created, 14), lane, 'running', AWAITING]),
]
const pid = (time: string): Row => [time, 'controller', 'running', `Automatic checkpoint controller PID ${DEAD_PID}`]
const running = (lane: Lane): NodeState => ({ status: 'running', attempt: 1, session: SESSIONS[lane] })
const done = (lane: Lane): NodeState => ({ status: 'succeeded', attempt: 1, session: SESSIONS[lane] })
const launchedRunning = { launch_ui: running('ui'), launch_adapter: running('adapter') }
const handoffWait = [{ node_id: 'handoff', error: null, interrupts: [HANDOFF_WAIT], result: null }]
const focusOf = (nodeId: string, status: RunDetail['snapshot']['status'], since: string | null) =>
  ({ node_id: nodeId, label: NODES.find(node => node.node_id === nodeId)!.label, status, since })

const TODAY = '2026-03-20'

/** A run that verified nothing: the handoff froze at 30 min, ui's verification failed its gate at `failedAt`. */
function failedRun(runId: string, day: string, failedAt: string): Fixture {
  const created = at(day, '09:00:00')
  const frozenAt = at(day, '09:30:00')
  return {
    runId, status: 'failed', mode: 'automatic', createdAt: created,
    events: [
      ...launch(created), pid(after(created, 16)),
      [frozenAt, 'freeze', 'stopped', 'Native workers stopped before snapshot capture: ui, adapter'],
      [frozenAt, 'freeze', 'succeeded', 'Immutable snapshots captured; worker-reported checks are not trusted'],
      [frozenAt, 'verify_ui', 'running', `Attempt 1; revision ${OUTPUT_COMMIT_UI}`],
      [at(day, failedAt), 'verify_ui', 'blocked', DRILL],
    ],
    states: { launch_ui: done('ui'), launch_adapter: done('adapter'), handoff: { status: 'succeeded', attempt: 1 }, verify_ui: { status: 'failed', attempt: 1 } },
    frozen: true, next: ['verify_ui'],
    tasks: [{ node_id: 'verify_ui', error: `Injected gate failure: ui verification attempt 1 was blocked by the configured failure drill`, interrupts: [], result: null }],
    stoppedAt: frozenAt,
    activity: {
      feature: LISTS_FEATURE, last_activity_at: at(day, failedAt), finished_at: at(day, failedAt),
      focus: focusOf('verify_ui', 'failed', at(day, failedAt)), attention: { kind: 'failed', node_id: 'verify_ui', since: at(day, failedAt) },
      waiting_questions: 0, headline: `Verify ui · ${DRILL}`, controller: null,
    },
  }
}

const FIXTURES: Fixture[] = [
  {
    runId: RUN_LISTS_ASKING, status: 'running', mode: 'automatic', createdAt: at(TODAY, '11:00:00'),
    events: [...launch(at(TODAY, '11:00:00')), pid(at(TODAY, '11:00:16'))],
    states: launchedRunning, frozen: false, next: ['handoff'], tasks: handoffWait, stoppedAt: null,
    live: { ui: [{ n: 1, question: ASKING_QUESTION, asked_at: offset(at(TODAY, '11:20:00')), answer: null, answered_at: null }] },
    activity: {
      feature: LISTS_FEATURE, last_activity_at: at(TODAY, '11:00:14'), finished_at: null,
      focus: focusOf('launch_ui', 'running', at(TODAY, '11:00:14')), attention: { kind: 'question', node_id: 'launch_ui', since: at(TODAY, '11:20:00') },
      waiting_questions: 1, headline: AWAITING_HEADLINE, controller: 'not_running',
    },
  },
  {
    runId: RUN_LISTS_ANSWERED, status: 'running', mode: 'automatic', createdAt: at(TODAY, '11:00:00'),
    events: [...launch(at(TODAY, '11:00:00')), pid(at(TODAY, '11:00:16')), [at(TODAY, '11:10:00'), 'adapter', 'interactive', PANE_MESSAGE]],
    states: launchedRunning, frozen: false, next: ['handoff'], tasks: handoffWait, stoppedAt: null,
    questions: { ui: [{ n: 1, question: ANSWERED_QUESTION, asked_at: at(TODAY, '11:05:00'), answer: null, answered_at: null }] },
    live: { ui: [{ n: 1, question: ANSWERED_QUESTION, asked_at: offset(at(TODAY, '11:05:00')), answer: ANSWER, answered_at: offset(at(TODAY, '11:08:00')) }] },
    activity: {
      feature: LISTS_FEATURE, last_activity_at: at(TODAY, '11:10:00'), finished_at: null,
      focus: focusOf('launch_adapter', 'running', at(TODAY, '11:10:00')), attention: { kind: 'pane', node_id: 'launch_adapter', since: at(TODAY, '11:10:00') },
      waiting_questions: 0, headline: `Launch adapter worker · ${PANE_MESSAGE}`, controller: 'not_running',
    },
  },
  {
    runId: RUN_LISTS_APPROVAL, status: 'awaiting_approval', mode: 'manual', createdAt: at(TODAY, '10:00:00'),
    events: launch(at(TODAY, '10:00:00')),
    states: { ...launchedRunning, handoff: { status: 'awaiting_approval', attempt: 1 } }, frozen: false, next: ['handoff'],
    tasks: [{ node_id: 'handoff', error: null, interrupts: [MANUAL_HANDOFF], result: null }], stoppedAt: null,
    activity: {
      feature: LISTS_FEATURE, last_activity_at: at(TODAY, '10:00:14'), finished_at: null,
      focus: focusOf('handoff', 'awaiting_approval', null), attention: { kind: 'approval', node_id: 'handoff', since: null },
      waiting_questions: 0, headline: 'Freeze worker handoffs', controller: null,
    },
  },
  {
    runId: RUN_LISTS_LIVE, status: 'running', mode: 'automatic', createdAt: at(TODAY, '11:30:00'),
    events: [...launch(at(TODAY, '11:30:00')), pid(at(TODAY, '11:30:16'))],
    states: launchedRunning, frozen: false, next: ['handoff'], tasks: handoffWait, stoppedAt: null,
    activity: {
      feature: LISTS_FEATURE, last_activity_at: at(TODAY, '11:30:14'), finished_at: null,
      focus: focusOf('launch_ui', 'running', at(TODAY, '11:30:14')), attention: null,
      // The worker-phase mock's controller is alive; the candidate phase's seeded PID is not.
      waiting_questions: 0, headline: AWAITING_HEADLINE, controller: 'running',
    },
  },
  {
    runId: RUN_LISTS_STOPPED, status: 'running', mode: 'automatic', createdAt: at(TODAY, '11:15:00'),
    events: [...launch(at(TODAY, '11:15:00')), pid(at(TODAY, '11:15:16'))],
    states: launchedRunning, frozen: false, next: ['handoff'], tasks: handoffWait, stoppedAt: null,
    activity: {
      feature: LISTS_FEATURE, last_activity_at: at(TODAY, '11:15:14'), finished_at: null,
      focus: focusOf('launch_ui', 'running', at(TODAY, '11:15:14')), attention: null,
      waiting_questions: 0, headline: AWAITING_HEADLINE, controller: 'not_running',
    },
  },
  failedRun(RUN_LISTS_FAILED, '2026-03-19', '09:52:51'),
  failedRun(RUN_LISTS_FAILED_EARLIER, '2026-03-17', '09:40:00'),
  failedRun(RUN_LISTS_OLD, '2026-03-10', '09:45:00'),
]

const PINNED: WorkflowDefinition = definition(PROJECT.project_id, UX_LISTS_WORKFLOW_ID, UX_LISTS_WORKFLOW_NAME, NODES)

const records = (fixture: Fixture): InternalEvent[] => fixture.events.map(([time, node, status, message], index) => ({ sequence: index + 1, time, node, status, message }))
const updatedAt = (fixture: Fixture) => fixture.events.at(-1)![0]

function rawWorker(fixture: Fixture, lane: Lane, leak: string): RawWorkerInput {
  const ui = lane === 'ui'
  return {
    role: ui ? 'frontend' : 'backend',
    required_check_kinds: ui ? ['build', 'browser'] : ['unit'],
    task: ui ? uiTask(leak) : adapterTask(),
    prompt: null,
    owned_paths: ui ? ['src/projects', 'tests/project-workflows'] : ['server'],
    checks: ui ? UI_CHECKS : ADAPTER_CHECKS,
    launch: {
      session_id: SESSIONS[lane], launch_token: launchToken(lane), launch_requested_at: offset(fixture.events[0][0]),
      native_started_at: Date.parse(fixture.events[0][0]), observed_state: fixture.stoppedAt ? 'done' : 'working', status: 'attached_session_available',
      launcher_invocations: 1, background_id: backgroundId(lane),
    },
    completion: null,
    handoff: null,
    stop: fixture.stoppedAt ? { stopped: true, confirmed_at: offset(fixture.stoppedAt) } : null,
    questions: fixture.questions?.[lane] ?? [],
  }
}

function inputsSection(fixture: Fixture, leak: string): RawInputsSection {
  return {
    feature: LISTS_FEATURE, policy_version: '1.2.0', base_commit: BASE_COMMIT, source_branch: `feature/${UX_LISTS_WORKFLOW_ID}/${fixture.runId}`,
    mode: fixture.mode,
    automatic: fixture.mode === 'manual' ? null : {
      finish: 'verified-feature-branch', permission_mode: 'bypassPermissions', worker_timeout_seconds: 7200, review_timeout_seconds: 1800, reviewer_transport: 'native',
    },
    setup: [{ argv: ['npm', 'ci'], command: 'npm ci', timeout_seconds: 600 }],
    max_verification_attempts: 3,
    failure_drill: fixture.status === 'failed' ? { node_id: 'ui', phase: 'worker', attempt: 1 } : null,
    selected_workers: [...LANES],
    excluded_workers: [],
    workers: Object.fromEntries(LANES.map(lane => [lane, rawWorker(fixture, lane, leak)])),
  }
}

// The adapter's projection of the raw rows (server/projects.ts `normalizeEvents`), for the worker-phase mock: a lane's rows
// belong to its launch node, `freeze` to the handoff, and controller rows keep their status without a node (B1).
const EVENT_STATUS: Record<string, WorkflowEvent['status']> = {
  running: 'running', interactive: 'running', blocked: 'failed', succeeded: 'succeeded', stopped: null, paused: 'paused', interrupted: 'paused',
}

function servedEvents(fixture: Fixture): WorkflowEvent[] {
  const known = new Set(NODES.map(node => node.node_id))
  const nodeOf = (node: string) => known.has(node) ? node : node === 'freeze' ? 'handoff' : (LANES as readonly string[]).includes(node) ? `launch_${node}` : null
  return records(fixture).map(record => {
    const node_id = nodeOf(record.node)
    const status = EVENT_STATUS[record.status] ?? null
    return eventSchema.parse({
      contract_version: '1.0.0', run_id: fixture.runId, event_id: `${fixture.runId}:${record.sequence}`, sequence: record.sequence, occurred_at: record.time,
      node_id, attempt: node_id ? 1 : 0, type: status && node_id ? 'status_changed' : 'log', status, message: record.message,
      artifact: null, result_uri: null, reused_from_attempt: null,
    })
  })
}

/** The worker-phase run detail: contract 1.5.0 with the served activity and the run directory an exposed project serves. */
function detailOf(fixture: Fixture): RunDetail {
  const base = runDetail(fixture.runId, fixture.status, PINNED, fixture.createdAt, updatedAt(fixture), fixture.states, fixture.events.length)
  return validateRunDetail({ ...base, summary: { ...base.summary, contract_version: '1.5.0', activity: fixture.activity }, run_dir: mockRunDir(fixture.runId) })
}

const payloads: UxPayloads = {
  workflows: [PINNED],
  runDetails: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, detailOf(fixture)])),
  runEvents: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, servedEvents(fixture)])),
  workerResults: {},
  reviewResults: {},
  // The served inputs are the export's record, never the live questions file (the server reads that for `activity` only).
  runInputs: Object.fromEntries(FIXTURES.map((fixture): [string, RunInputs] => [fixture.runId, projectInputs(fixture.runId, inputsSection(fixture, PATH_TOKEN))])),
  artifactFiles: {},
}

function seed({ repository, runsRoot, writeRun, receipt, leakFor }: SeedContext) {
  const root = runsRoot(UX_LISTS_WORKFLOW_ID)
  for (const fixture of FIXTURES) {
    const runDir = join(root, fixture.runId)
    writeRun(root, repository, fixture.runId, {
      createdAt: fixture.createdAt, updatedAt: updatedAt(fixture), definitionNodes: NODES, definitionName: UX_LISTS_WORKFLOW_NAME, version: '1.5.0', lanes: LANES,
      values: {
        lanes: Object.fromEntries(LANES.map(lane => [lane, receipt(lane, runDir, SESSIONS[lane], fixture.events[0][0])])),
        ...(fixture.frozen ? { snapshots: { ui: OUTPUT_COMMIT_UI, adapter: OUTPUT_COMMIT_ADAPTER } } : {}),
      },
      next: fixture.next,
      tasks: fixture.tasks,
      events: records(fixture),
      packets: () => [],
      review: null,
      inputs: inputsSection(fixture, leakFor(root, fixture.runId)),
    })
    // The controller's live question record (guardrails.py save_questions), which the export does not follow while it waits.
    for (const [lane, questions] of Object.entries(fixture.live ?? {})) {
      writeFileSync(join(runDir, `${lane}.questions.json`), `${JSON.stringify({ questions }, null, 2)}\n`)
    }
  }
  return {
    workflows: [{ workflow_id: UX_LISTS_WORKFLOW_ID, runs_root: root, definition: { name: UX_LISTS_WORKFLOW_NAME, nodes: NODES } }],
    // B3: the seeded project serves run directories; under the temporary root, outside $HOME, they are still null.
    registry: { viewer: { expose_run_dir: [PROJECT.project_id] } },
  }
}

export const uxLists: UxFixtureModule = { payloads, seed }

// ---- The ordered and filtered lists' own world, served by page.route in both phases (never seeded) ---------------------
//
// Five projects only these routes serve, so every count over them is asserted by value: `lists-b-order` (a feature with a
// needs-you, a running, a paused and three finished runs, and three more features whose default, newest and oldest orders
// differ), `lists-b-fold` (seven features of one or two runs each: one needs you, one runs, one cannot be read, the rest
// closed), `lists-b-filter` (a feature answered as two pages, page 2 entirely older than page 1's newest finished run, so
// appending it never changes which run the feature header reads its reviewers from), and `lists-b-runner` / `lists-b-parked`
// (a project whose only live run is running, one whose only live runs are paused).

/** The page clock of the stage B scenarios: 2026-10-13 at noon UTC. */
export const LISTS_B_NOW = '2026-10-13T12:00:00Z'
const B_NODES = laneGraphNodes(['ui'])

type BRun = { id: string; status: RunSummary['status']; created: string; moved: string; focus?: string | null; attention?: RunActivity['attention']; feature?: string; headline?: string; accepted?: boolean }
export type BWorkflow = { workflow_id: string; runs: BRun[]; page2?: BRun[]; unreadable?: boolean }
export type BProject = { project_id: string; name: string; workflows: BWorkflow[] }

const FINISHED_B = ['succeeded', 'failed', 'cancelled']
export function bSummary(projectId: string, workflowId: string, run: BRun): RunSummary {
  const finished = FINISHED_B.includes(run.status)
  const definition = bDefinition(projectId, workflowId)
  return {
    contract_version: '1.5.0', project_id: projectId, workflow_id: workflowId, definition_revision: definition.definition_revision, run_id: run.id, status: run.status,
    created_at: run.created, updated_at: run.moved,
    activity: {
      feature: run.feature ?? `${workflowId} feature`, last_activity_at: run.moved, finished_at: finished ? run.moved : null,
      focus: run.focus ? { node_id: run.focus, label: B_NODES.find(node => node.node_id === run.focus)?.label ?? run.focus, status: run.status, since: null } : null,
      attention: run.attention ?? null, waiting_questions: run.attention?.kind === 'question' ? 1 : 0, headline: run.headline ?? null, controller: null,
    },
    ...(run.accepted ? { accepted: { candidate: 'c'.repeat(40), reason: 'accepted by hand', by: 'operator', accepted_at: run.moved, on_main: true, review: 'none' as const, open_findings: [], abandoned: null } } : {}),
  }
}
export const bDefinition = (projectId: string, workflowId: string): WorkflowDefinition => definition(projectId, workflowId, `Feature ${workflowId}`, B_NODES)

const T = (day: number, hour: number, minute = 0) => `2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`
const question = (since: string): RunActivity['attention'] => ({ kind: 'question', node_id: 'launch_ui', since })
const pane = (since: string): RunActivity['attention'] => ({ kind: 'pane', node_id: 'launch_ui', since })
const pausedAt = (since: string): RunActivity['attention'] => ({ kind: 'paused', node_id: 'review', since })

/** The feature page's mixed workflow: needs you, running, paused (the latest created), then three finished runs. */
export const B_MIX = { needs: 'mix-needs', running: 'mix-running', paused: 'mix-paused', done1: 'mix-done-1', done2: 'mix-done-2', done3: 'mix-done-3' } as const
export const B_ORDER: BProject = {
  project_id: 'lists-b-order', name: 'Lists B order',
  workflows: [
    { workflow_id: 'order-mix', runs: [
      { id: B_MIX.needs, status: 'running', created: T(10, 8), moved: T(13, 8), focus: 'launch_ui', attention: question(T(13, 8)) },
      { id: B_MIX.running, status: 'running', created: T(12, 8), moved: T(13, 11), focus: 'verify_ui' },
      { id: B_MIX.paused, status: 'paused', created: T(13, 9), moved: T(13, 9, 30), focus: 'review', attention: pausedAt(T(13, 9, 30)) },
      { id: B_MIX.done1, status: 'failed', created: T(11, 8), moved: T(13, 10), focus: 'review' },
      { id: B_MIX.done2, status: 'succeeded', created: T(9, 8), moved: T(12, 10) },
      { id: B_MIX.done3, status: 'cancelled', created: T(8, 8), moved: T(8, 9), focus: 'candidate' },
    ] },
    { workflow_id: 'order-running', runs: [{ id: 'order-running-1', status: 'running', created: T(1, 8), moved: T(13, 7), focus: 'launch_ui' }] },
    { workflow_id: 'order-done-new', runs: [{ id: 'order-done-new-1', status: 'succeeded', created: T(13, 9), moved: T(13, 11, 30) }] },
    { workflow_id: 'order-done-old', runs: [{ id: 'order-done-old-1', status: 'failed', created: T(2, 8), moved: T(5, 9), focus: 'verify_ui' }] },
  ],
}
/** The default, newest and oldest feature orders of `lists-b-order`; they all differ. */
export const B_ORDER_FEATURES = {
  live: ['order-mix', 'order-running', 'order-done-new', 'order-done-old'],
  newest: ['order-done-new', 'order-mix', 'order-running', 'order-done-old'],
  oldest: ['order-done-old', 'order-running', 'order-mix', 'order-done-new'],
}
/** The mixed workflow's rows under each sort (default, newest created, oldest created). */
export const B_MIX_ORDER = {
  live: [B_MIX.needs, B_MIX.running, B_MIX.paused, B_MIX.done1, B_MIX.done2, B_MIX.done3],
  newest: [B_MIX.paused, B_MIX.running, B_MIX.done1, B_MIX.needs, B_MIX.done2, B_MIX.done3],
  oldest: [B_MIX.done3, B_MIX.done2, B_MIX.needs, B_MIX.done1, B_MIX.running, B_MIX.paused],
}

export const B_FOLD: BProject = {
  project_id: 'lists-b-fold', name: 'Lists B fold',
  workflows: [
    { workflow_id: 'fold-needs', runs: [{ id: 'fold-needs-1', status: 'running', created: T(12, 8), moved: T(13, 9), focus: 'launch_ui', attention: pane(T(13, 9)) }] },
    { workflow_id: 'fold-running', runs: [{ id: 'fold-running-1', status: 'running', created: T(11, 0), moved: T(12, 18), focus: 'verify_ui' }] },
    { workflow_id: 'fold-broken', runs: [], unreadable: true },
    { workflow_id: 'fold-done', runs: [{ id: 'fold-done-1', status: 'failed', created: T(9, 8), moved: T(9, 9, 5), focus: 'review' }, { id: 'fold-done-2', status: 'succeeded', created: T(10, 8), moved: T(10, 9) }] },
    { workflow_id: 'fold-paused', runs: [{ id: 'fold-paused-1', status: 'paused', created: T(2, 8), moved: T(3, 10), focus: 'review', attention: pausedAt(T(3, 10)) }] },
    { workflow_id: 'fold-old', runs: [{ id: 'fold-old-1', status: 'succeeded', created: T(1, 8), moved: T(1, 9) }] },
    { workflow_id: 'fold-cancelled', runs: [{ id: 'fold-cancelled-1', status: 'cancelled', created: T(4, 8), moved: T(4, 8, 30), focus: 'candidate' }] },
  ],
}

/** The filtered feature: page 1 with a next cursor, page 2 older than page 1's newest finished run (fr-fail-review). */
export const B_FILTER: BProject = {
  project_id: 'lists-b-filter', name: 'Lists B filter',
  workflows: [
    { workflow_id: 'filter-runs', runs: [
      { id: 'fr-needs', status: 'running', created: T(13, 8), moved: T(13, 10), focus: 'launch_ui', attention: question(T(13, 10)) },
      { id: 'fr-running', status: 'running', created: T(13, 7), moved: T(13, 11), focus: 'verify_ui' },
      { id: 'fr-paused', status: 'paused', created: T(12, 7), moved: T(12, 8), focus: 'review', attention: pausedAt(T(12, 8)) },
      { id: 'fr-fail-review', status: 'failed', created: T(13, 6), moved: T(13, 9), focus: 'review', headline: 'Independent review found two blockers' },
      { id: 'fr-ok', status: 'succeeded', created: T(13, 5), moved: T(13, 8, 30) },
      { id: 'fr-fail-verify', status: 'failed', created: T(12, 6), moved: T(12, 9), focus: 'verify_ui' },
      { id: 'fr-fail-launch', status: 'failed', created: T(11, 6), moved: T(11, 9), focus: 'launch_ui', feature: 'Pirate sea race' },
      { id: 'fr-override', status: 'succeeded', created: T(10, 6), moved: T(10, 9), accepted: true },
      { id: 'fr-cancelled', status: 'cancelled', created: T(9, 6), moved: T(9, 9), focus: 'candidate' },
    ], page2: [
      { id: 'fr-old-fail-review', status: 'failed', created: T(1, 6), moved: T(1, 9), focus: 'review' },
      { id: 'fr-old-ok', status: 'succeeded', created: '2026-09-30T06:00:00Z', moved: '2026-09-30T09:00:00Z' },
    ] },
    { workflow_id: 'filter-other', runs: [{ id: 'fo-running', status: 'running', created: T(13, 1), moved: T(13, 2), focus: 'launch_ui' }] },
  ],
}

export const B_RUNNER: BProject = {
  project_id: 'lists-b-runner', name: 'Lists B runner',
  workflows: [{ workflow_id: 'runner', runs: [{ id: 'runner-1', status: 'running', created: T(12, 1), moved: T(12, 2), focus: 'launch_ui' }, { id: 'runner-0', status: 'succeeded', created: T(11, 1), moved: T(11, 2) }] }],
}
export const B_PARKED: BProject = {
  project_id: 'lists-b-parked', name: 'Lists B parked',
  workflows: [
    { workflow_id: 'parked-a', runs: [{ id: 'parked-a-1', status: 'paused', created: T(12, 1), moved: T(13, 6), focus: 'review', attention: pausedAt(T(13, 6)) }] },
    { workflow_id: 'parked-b', runs: [{ id: 'parked-b-1', status: 'paused', created: T(12, 2), moved: T(13, 6, 30), focus: 'review', attention: pausedAt(T(13, 6, 30)) }] },
  ],
}

export const B_PROJECTS: readonly BProject[] = [B_ORDER, B_FOLD, B_FILTER, B_RUNNER, B_PARKED]
