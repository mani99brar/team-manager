/**
 * Fixtures of the Projects viewer revamp, lane `shell` (`revamp-lists.spec.ts`, docs/PRD_VIEWER_REVAMP.md 5.1 and 7),
 * registered by `index.ts` as the workflow `ux-revamp-lists` of `PROJECT` (`alpha-project`): mock payloads for the worker
 * phase and a `seed` for the candidate phase.
 *
 * Every run is dated before 2026-03-13, so the `runs-home` rows of `ux-lists` (2026-03-17 to 2026-03-20) stay above them, and
 * the revamp specs fix the page clock at `REVAMP_NOW`, just after them:
 * - `desk-pane` (running): adapter needs attention in its pane. Needs you, `pane`, next step "attend the pane".
 * - `desk-live-1` and `desk-live-2` (running): nothing waits. Running cards with the `ui` and `adapter` lane chips. The
 *   worker-phase mock serves `controller: running` for `desk-live-1`; the candidate phase's seeded PID has no process.
 * - `desk-interrupted` and `desk-paused` (paused): not finished and nothing waits on the operator, so Running cards, toned
 *   pause: the first by the controller's "Supervisor interrupted" row (attention `interrupted`), the second by a handoff
 *   that froze with nothing after it (attention `paused`). A failed run is finished, so no Running card is ever failed.
 * - `desk-held` (paused): both lanes launched and nothing followed, so the server pauses the run with no focus step and
 *   serves attention `paused` without a `since` (run 007): a Running card whose line says when it started, once.
 * - fourteen finished runs over three days (2026-03-10 to 2026-03-12), eight succeeded and six failed, so Recent has three
 *   day groups, the Failed filter has something to keep and Show older something to show.
 * The run ids start with `desk-`, which no other fixture uses, so the spec can search for its own rows.
 */
import { join } from 'node:path'
import { validateRunDetail, type RunActivity, type RunDetail, type RunInputs, type WorkflowDefinition } from '../../../contracts/projects/v1.ts'
import { eventSchema, type WorkflowEvent } from '../../../contracts/workflow/v1.ts'
import {
  ADAPTER_CHECKS, ADAPTER_SESSION, BASE_COMMIT, CANDIDATE_COMMIT, LANE_ARTIFACTS, OUTPUT_COMMIT_ADAPTER, OUTPUT_COMMIT_UI, PATH_TOKEN, PROJECT, UI_CHECKS,
  UI_SESSION, adapterResult, adapterTask, backgroundId, definition, laneGraphNodes, launchToken, offset, projectInputs, runDetail, uiResult, uiTask,
  type NodeState, type RawInputsSection, type RawWorkerInput,
} from '../fixtures.ts'
import type { InternalEvent, SeedContext } from '../seed.ts'
import type { UxFixtureModule, UxPayloads } from './index.ts'

export const UX_REVAMP_LISTS_WORKFLOW_ID = 'ux-revamp-lists'
/** Not the exporter's generic name, so the title rule keeps it as the feature's title. */
export const REVAMP_TITLE = 'Operator desk'
export const REVAMP_FEATURE = 'Operator desk'
/** The instant the revamp specs fix the page clock at: the evening of the last day of runs. */
export const REVAMP_NOW = '2026-03-12T20:00:00Z'
/** The run-id prefix only this module uses. */
export const REVAMP_PREFIX = 'desk-'

export const RUN_DESK_PANE = 'desk-pane'
export const RUN_DESK_LIVE = 'desk-live-1'
export const RUN_DESK_LIVE_QUIET = 'desk-live-2'
/** Live but stopped: the supervisor was interrupted while the workers ran (served `paused`, attention `interrupted`). */
export const RUN_DESK_INTERRUPTED = 'desk-interrupted'
/** Live but stopped: the handoff froze and nothing followed, contradictory evidence (served `paused`, attention `paused`). */
export const RUN_DESK_PAUSED = 'desk-paused'
/** Live but stopped with no step to name: served `paused`, attention `paused` with `since: null` (no focus, no stop time). */
export const RUN_DESK_HELD = 'desk-held'

export const REVAMP_LANES = ['ui', 'adapter'] as const
type Lane = (typeof REVAMP_LANES)[number]
type Outcome = 'succeeded' | 'failed'

/** The finished runs: id, outcome, day and start hour (UTC). Newest first within a day. */
const FINISHED: readonly [runId: string, outcome: Outcome, day: string, hour: number][] = [
  ['desk-ok-1', 'succeeded', '2026-03-12', 15],
  ['desk-fail-1', 'failed', '2026-03-12', 13],
  ['desk-ok-2', 'succeeded', '2026-03-12', 11],
  ['desk-fail-2', 'failed', '2026-03-12', 9],
  ['desk-ok-3', 'succeeded', '2026-03-12', 7],
  ['desk-ok-4', 'succeeded', '2026-03-11', 15],
  ['desk-fail-3', 'failed', '2026-03-11', 13],
  ['desk-ok-5', 'succeeded', '2026-03-11', 11],
  ['desk-fail-4', 'failed', '2026-03-11', 9],
  ['desk-ok-6', 'succeeded', '2026-03-11', 7],
  ['desk-ok-7', 'succeeded', '2026-03-10', 15],
  ['desk-fail-5', 'failed', '2026-03-10', 13],
  ['desk-ok-8', 'succeeded', '2026-03-10', 11],
  ['desk-fail-6', 'failed', '2026-03-10', 9],
]
export const REVAMP_FINISHED_RUNS = FINISHED.map(([runId]) => runId)
export const REVAMP_FAILED_RUNS = FINISHED.filter(([, outcome]) => outcome === 'failed').map(([runId]) => runId)
export const REVAMP_SUCCEEDED_RUNS = FINISHED.filter(([, outcome]) => outcome === 'succeeded').map(([runId]) => runId)
/** Every finished run's day, for the day-group assertions. */
export const REVAMP_RUN_DAY: Record<string, string> = Object.fromEntries(FINISHED.map(([runId, , day]) => [runId, day]))

/** Above any Linux `pid_max` (at most 2^22): no process ever has it. */
const DEAD_PID = 2_000_000_000
const NODES = laneGraphNodes(REVAMP_LANES)
const SESSIONS: Record<Lane, string> = { ui: UI_SESSION, adapter: ADAPTER_SESSION }

type Row = [at: string, node: string, status: string, message: string]
type Fixture = {
  runId: string
  status: RunDetail['summary']['status']
  createdAt: string
  events: Row[]
  states: Record<string, NodeState>
  values: (runDir: string, receipt: SeedContext['receipt']) => Record<string, unknown>
  next: string[]
  tasks: { node_id: string; error: string | null; interrupts: object[]; result: object | null }[]
  /** Writes the verification packets of a run that verified (candidate phase). */
  packets?: (runDir: string, writePacket: SeedContext['writePacket']) => object[]
  stoppedAt: string | null
  failed: boolean
  activity: RunActivity
}

const LAUNCHING = 'Launching or reconciling the exact native session'
const AWAITING = 'Awaiting explicit completion signal; idle is not acceptance'
const DRILL = 'Injected gate failure (failure drill); checks preserved'
const HANDOFF_WAIT = { kind: 'worker_handoff', message: 'Awaiting explicit completion signals and automatic freeze.' }
const AWAITING_HEADLINE = "Launch ui worker · waiting for the worker's completion signal (idle is not acceptance)"
export const PANE_MESSAGE = 'Worker adapter needs attention in its pane (native state blocked); waiting until its deadline'

const at = (day: string, clock: string) => `${day}T${clock}Z`
const after = (start: string, seconds: number) => new Date(Date.parse(start) + seconds * 1000).toISOString().replace(/\.000Z$/, 'Z')
const launch = (created: string): Row[] => [
  ...REVAMP_LANES.map((lane): Row => [after(created, 10), lane, 'running', LAUNCHING]),
  ...REVAMP_LANES.map((lane): Row => [after(created, 14), lane, 'running', AWAITING]),
]
/** What the server serves for `desk-held` (as it reads the seeded records): its last activity and its headline. */
const HELD_LAST_ACTIVITY = (created: string) => after(created, 14)
const HELD_HEADLINE = "Launch adapter worker · waiting for the worker's completion signal (idle is not acceptance)"
const INTERRUPTED = 'Supervisor interrupted. Native workers were NOT stopped and keep running'
const pid = (time: string): Row => [time, 'controller', 'running', `Automatic checkpoint controller PID ${DEAD_PID}`]
const running = (lane: Lane): NodeState => ({ status: 'running', attempt: 1, session: SESSIONS[lane] })
const done = (lane: Lane): NodeState => ({ status: 'succeeded', attempt: 1, session: SESSIONS[lane] })
const focusOf = (nodeId: string, status: RunDetail['snapshot']['status'], since: string | null) =>
  ({ node_id: nodeId, label: NODES.find(node => node.node_id === nodeId)!.label, status, since })
const launchValues = (created: string) => (runDir: string, receipt: SeedContext['receipt']) =>
  ({ lanes: Object.fromEntries(REVAMP_LANES.map(lane => [lane, receipt(lane, runDir, SESSIONS[lane], after(created, 10))])) })

/** A run whose workers still work: the handoff waits for their completion signals. */
function liveRun(runId: string, created: string, extra: Row[], activity: Omit<RunActivity, 'feature' | 'finished_at' | 'waiting_questions'>): Fixture {
  return {
    runId, status: 'running', createdAt: created,
    events: [...launch(created), pid(after(created, 16)), ...extra],
    states: { launch_ui: running('ui'), launch_adapter: running('adapter') },
    values: launchValues(created), next: ['handoff'], tasks: [{ node_id: 'handoff', error: null, interrupts: [HANDOFF_WAIT], result: null }],
    stoppedAt: null, failed: false,
    activity: { feature: REVAMP_FEATURE, finished_at: null, waiting_questions: 0, ...activity },
  }
}

/** A run that verified nothing: the handoff froze at 30 min and ui's verification failed its gate 22m51s later. */
function failedRun(runId: string, day: string, hour: number): Fixture {
  const created = at(day, `${String(hour).padStart(2, '0')}:00:00`)
  const frozenAt = after(created, 30 * 60)
  const failedAt = after(created, 52 * 60 + 51)
  return {
    runId, status: 'failed', createdAt: created,
    events: [
      ...launch(created), pid(after(created, 16)),
      [frozenAt, 'freeze', 'stopped', 'Native workers stopped before snapshot capture: ui, adapter'],
      [frozenAt, 'freeze', 'succeeded', 'Immutable snapshots captured; worker-reported checks are not trusted'],
      [frozenAt, 'verify_ui', 'running', `Attempt 1; revision ${OUTPUT_COMMIT_UI}`],
      [failedAt, 'verify_ui', 'blocked', DRILL],
    ],
    states: { launch_ui: done('ui'), launch_adapter: done('adapter'), handoff: { status: 'succeeded', attempt: 1 }, verify_ui: { status: 'failed', attempt: 1 } },
    values: (runDir, receipt) => ({ ...launchValues(created)(runDir, receipt), snapshots: { ui: OUTPUT_COMMIT_UI, adapter: OUTPUT_COMMIT_ADAPTER } }),
    next: ['verify_ui'],
    tasks: [{ node_id: 'verify_ui', error: 'Injected gate failure: ui verification attempt 1 was blocked by the configured failure drill', interrupts: [], result: null }],
    stoppedAt: frozenAt, failed: true,
    activity: {
      feature: REVAMP_FEATURE, last_activity_at: failedAt, finished_at: failedAt,
      focus: focusOf('verify_ui', 'failed', failedAt), attention: { kind: 'failed', node_id: 'verify_ui', since: failedAt },
      waiting_questions: 0, headline: `Verify ui · ${DRILL}`, controller: null,
    },
  }
}

/** A run that went through: both lanes verified, the candidate verified, reviewed, approved and integrated after 40 min. */
function succeededRun(runId: string, day: string, hour: number): Fixture {
  const created = at(day, `${String(hour).padStart(2, '0')}:00:00`)
  const frozenAt = after(created, 30 * 60)
  const end = after(created, 40 * 60)
  return {
    runId, status: 'succeeded', createdAt: created,
    events: [
      ...launch(created), pid(after(created, 16)),
      [frozenAt, 'freeze', 'stopped', 'Native workers stopped before snapshot capture: ui, adapter'],
      [frozenAt, 'freeze', 'succeeded', 'Immutable snapshots captured; worker-reported checks are not trusted'],
      [after(created, 33 * 60), 'verify_ui', 'succeeded', 'UI verification passed'],
      [after(created, 34 * 60), 'verify_adapter', 'succeeded', 'Adapter verification passed'],
      [after(created, 36 * 60), 'candidate', 'succeeded', 'Combined candidate verified'],
      [after(created, 38 * 60), 'review', 'approved', 'Independent reviewer approved the candidate'],
      [after(created, 39 * 60), 'approval', 'approved', 'Integration approved'],
      [end, 'integrate', 'succeeded', 'Fast-forwarded the feature branch'],
    ],
    states: {
      launch_ui: done('ui'), launch_adapter: done('adapter'), handoff: { status: 'succeeded', attempt: 1 },
      verify_ui: { status: 'succeeded', attempt: 1 }, verify_adapter: { status: 'succeeded', attempt: 1 }, candidate: { status: 'succeeded', attempt: 1 },
      review: { status: 'succeeded', attempt: 1 }, approval: { status: 'succeeded', attempt: 1 }, integrate: { status: 'succeeded', attempt: 1 },
    },
    values: (runDir, receipt) => ({
      ...launchValues(created)(runDir, receipt),
      snapshots: { ui: OUTPUT_COMMIT_UI, adapter: OUTPUT_COMMIT_ADAPTER },
      ui_packet: 'verification/worker/ui/1/packet.json', adapter_packet: 'verification/worker/adapter/1/packet.json',
      bundle: { run_id: runId, base_commit: BASE_COMMIT, candidate_commit: CANDIDATE_COMMIT, policy_sha256: 'e'.repeat(64) },
      review: { run_id: runId, verdict: 'approved', independent: true, reviewer: 'synthetic-reviewer', findings: [] },
      approved_bundle: 'f'.repeat(64), integrated_commit: CANDIDATE_COMMIT,
    }),
    next: [], tasks: [],
    packets: (runDir, writePacket) => {
      const passed = { status: 'passed', reasons: [] }
      return [
        writePacket(runDir, 'worker', 'ui', 1, uiResult(runId), LANE_ARTIFACTS.ui, passed),
        writePacket(runDir, 'worker', 'adapter', 1, adapterResult(runId, false), LANE_ARTIFACTS.adapter, passed),
        writePacket(runDir, 'candidate', 'ui', 1, uiResult(runId), LANE_ARTIFACTS.ui, passed),
        writePacket(runDir, 'candidate', 'adapter', 1, adapterResult(runId, false), LANE_ARTIFACTS.adapter, passed),
      ]
    },
    stoppedAt: frozenAt, failed: false,
    activity: {
      feature: REVAMP_FEATURE, last_activity_at: end, finished_at: end,
      focus: focusOf('integrate', 'succeeded', end), attention: null,
      waiting_questions: 0, headline: 'Integrate candidate · Fast-forwarded the feature branch', controller: null,
    },
  }
}

/** The supervisor was interrupted while both workers ran: served paused, attention `interrupted` at the handoff. */
function interruptedRun(runId: string, created: string): Fixture {
  const stoppedAt = after(created, 20 * 60)
  return {
    runId, status: 'paused', createdAt: created,
    events: [...launch(created), pid(after(created, 16)), [stoppedAt, 'controller', 'interrupted', INTERRUPTED]],
    states: { launch_ui: running('ui'), launch_adapter: running('adapter'), handoff: { status: 'paused', attempt: 1 } },
    values: launchValues(created), next: ['handoff'], tasks: [{ node_id: 'handoff', error: null, interrupts: [HANDOFF_WAIT], result: null }],
    stoppedAt: null, failed: false,
    activity: {
      feature: REVAMP_FEATURE, last_activity_at: stoppedAt, finished_at: null, focus: focusOf('handoff', 'paused', null),
      attention: { kind: 'interrupted', node_id: 'handoff', since: stoppedAt }, waiting_questions: 0,
      headline: `Freeze worker handoffs · ${INTERRUPTED}`, controller: 'not_running',
    },
  }
}

/** The handoff froze the workers and nothing followed: contradictory evidence, served paused at the handoff. */
function pausedRun(runId: string, created: string): Fixture {
  const frozenAt = after(created, 30 * 60)
  const message = 'Immutable snapshots captured; worker-reported checks are not trusted'
  return {
    runId, status: 'paused', createdAt: created,
    events: [...launch(created), pid(after(created, 16)), [frozenAt, 'freeze', 'succeeded', message]],
    states: { launch_ui: done('ui'), launch_adapter: done('adapter'), handoff: { status: 'paused', attempt: 1 } },
    values: launchValues(created), next: [], tasks: [],
    stoppedAt: frozenAt, failed: false,
    activity: {
      feature: REVAMP_FEATURE, last_activity_at: frozenAt, finished_at: null, focus: focusOf('handoff', 'paused', frozenAt),
      attention: { kind: 'paused', node_id: 'handoff', since: frozenAt }, waiting_questions: 0,
      // As the server words the freeze row (its humanized event text).
      headline: 'Freeze worker handoffs · snapshots captured (worker-reported checks are not trusted)', controller: 'not_running',
    },
  }
}

/**
 * Both lanes launched (their receipts are the evidence) and nothing followed: no handoff record, no next step. The server
 * pauses such a run with no failed, paused, awaiting or running step, so it has no focus and its attention carries no since.
 */
function heldRun(runId: string, created: string): Fixture {
  const events: Row[] = [...launch(created), pid(after(created, 16))]
  return {
    runId, status: 'paused', createdAt: created,
    events,
    states: { launch_ui: done('ui'), launch_adapter: done('adapter') },
    values: launchValues(created), next: [], tasks: [],
    stoppedAt: null, failed: false,
    activity: {
      feature: REVAMP_FEATURE, last_activity_at: HELD_LAST_ACTIVITY(created), finished_at: null, focus: null,
      attention: { kind: 'paused', node_id: null, since: null }, waiting_questions: 0,
      headline: HELD_HEADLINE, controller: 'not_running',
    },
  }
}

const PANE_CREATED = at('2026-03-12', '17:00:00')
const PANE_AT = at('2026-03-12', '17:10:00')
const LIVE_CREATED = at('2026-03-12', '19:00:00')
const QUIET_CREATED = at('2026-03-12', '18:30:00')
const INTERRUPTED_CREATED = at('2026-03-12', '16:00:00')
const PAUSED_CREATED = at('2026-03-12', '16:30:00')
const HELD_CREATED = at('2026-03-12', '15:00:00')

const FIXTURES: Fixture[] = [
  liveRun(RUN_DESK_PANE, PANE_CREATED, [[PANE_AT, 'adapter', 'interactive', PANE_MESSAGE]], {
    last_activity_at: PANE_AT, focus: focusOf('launch_adapter', 'running', PANE_AT), attention: { kind: 'pane', node_id: 'launch_adapter', since: PANE_AT },
    headline: `Launch adapter worker · ${PANE_MESSAGE}`, controller: 'not_running',
  }),
  liveRun(RUN_DESK_LIVE, LIVE_CREATED, [], {
    last_activity_at: after(LIVE_CREATED, 14), focus: focusOf('launch_ui', 'running', after(LIVE_CREATED, 14)), attention: null,
    // The worker-phase mock's controller is alive; the candidate phase's seeded PID is not.
    headline: AWAITING_HEADLINE, controller: 'running',
  }),
  liveRun(RUN_DESK_LIVE_QUIET, QUIET_CREATED, [], {
    last_activity_at: after(QUIET_CREATED, 14), focus: focusOf('launch_ui', 'running', after(QUIET_CREATED, 14)), attention: null,
    headline: AWAITING_HEADLINE, controller: null,
  }),
  interruptedRun(RUN_DESK_INTERRUPTED, INTERRUPTED_CREATED),
  pausedRun(RUN_DESK_PAUSED, PAUSED_CREATED),
  heldRun(RUN_DESK_HELD, HELD_CREATED),
  ...FINISHED.map(([runId, outcome, day, hour]) => (outcome === 'failed' ? failedRun(runId, day, hour) : succeededRun(runId, day, hour))),
]

export const REVAMP_OWN_RUNS = FIXTURES.map(fixture => fixture.runId)

const PINNED: WorkflowDefinition = definition(PROJECT.project_id, UX_REVAMP_LISTS_WORKFLOW_ID, REVAMP_TITLE, NODES)

const records = (fixture: Fixture): InternalEvent[] => fixture.events.map(([time, node, status, message], index) => ({ sequence: index + 1, time, node, status, message }))
const updatedAt = (fixture: Fixture) => fixture.events.at(-1)![0]

/** The run updated last (its last record), whose status the project page's feature card names as "last run". */
export const REVAMP_LATEST_RUN = (() => {
  const latest = FIXTURES.reduce((best, fixture) => (Date.parse(updatedAt(fixture)) > Date.parse(updatedAt(best)) ? fixture : best))
  return { runId: latest.runId, status: latest.status }
})()

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
    questions: [],
  }
}

function inputsSection(fixture: Fixture, leak: string): RawInputsSection {
  return {
    feature: REVAMP_FEATURE, policy_version: '1.2.0', base_commit: BASE_COMMIT, source_branch: `feature/${UX_REVAMP_LISTS_WORKFLOW_ID}/${fixture.runId}`,
    mode: 'automatic',
    automatic: { finish: 'verified-feature-branch', permission_mode: 'bypassPermissions', worker_timeout_seconds: 7200, review_timeout_seconds: 1800, reviewer_transport: 'native' },
    setup: [{ argv: ['npm', 'ci'], command: 'npm ci', timeout_seconds: 600 }],
    max_verification_attempts: 3,
    failure_drill: fixture.failed ? { node_id: 'ui', phase: 'worker', attempt: 1 } : null,
    selected_workers: [...REVAMP_LANES],
    excluded_workers: [],
    workers: Object.fromEntries(REVAMP_LANES.map(lane => [lane, rawWorker(fixture, lane, leak)])),
  }
}

// The adapter's projection of the raw rows (server/projects.ts `normalizeEvents`), for the worker-phase mock.
const EVENT_STATUS: Record<string, WorkflowEvent['status']> = {
  running: 'running', interactive: 'running', blocked: 'failed', succeeded: 'succeeded', approved: 'succeeded', stopped: null, paused: 'paused', interrupted: 'paused',
}

function servedEvents(fixture: Fixture): WorkflowEvent[] {
  const known = new Set(NODES.map(node => node.node_id))
  const nodeOf = (node: string) => known.has(node) ? node : node === 'freeze' ? 'handoff' : (REVAMP_LANES as readonly string[]).includes(node) ? `launch_${node}` : null
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

/** The worker-phase run detail: contract 1.5.0 with the served activity, as the server computes it from these records. */
function detailOf(fixture: Fixture): RunDetail {
  const base = runDetail(fixture.runId, fixture.status, PINNED, fixture.createdAt, updatedAt(fixture), fixture.states, fixture.events.length)
  return validateRunDetail({ ...base, summary: { ...base.summary, contract_version: '1.5.0', activity: fixture.activity }, run_dir: null })
}

const payloads: UxPayloads = {
  workflows: [PINNED],
  runDetails: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, detailOf(fixture)])),
  runEvents: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, servedEvents(fixture)])),
  workerResults: {},
  reviewResults: {},
  runInputs: Object.fromEntries(FIXTURES.map((fixture): [string, RunInputs] => [fixture.runId, projectInputs(fixture.runId, inputsSection(fixture, PATH_TOKEN))])),
  artifactFiles: {},
}

function seed({ repository, runsRoot, writeRun, writePacket, receipt, leakFor }: SeedContext) {
  const root = runsRoot(UX_REVAMP_LISTS_WORKFLOW_ID)
  for (const fixture of FIXTURES) {
    const runDir = join(root, fixture.runId)
    writeRun(root, repository, fixture.runId, {
      createdAt: fixture.createdAt, updatedAt: updatedAt(fixture), definitionNodes: NODES, definitionName: REVAMP_TITLE, version: '1.5.0', lanes: REVAMP_LANES,
      values: fixture.values(runDir, receipt),
      next: fixture.next,
      tasks: fixture.tasks,
      events: records(fixture),
      packets: directory => fixture.packets?.(directory, writePacket) ?? [],
      review: null,
      inputs: inputsSection(fixture, leakFor(root, fixture.runId)),
    })
  }
  return { workflows: [{ workflow_id: UX_REVAMP_LISTS_WORKFLOW_ID, runs_root: root, definition: { name: REVAMP_TITLE, nodes: NODES } }] }
}

export const uxRevampLists: UxFixtureModule = { payloads, seed }
