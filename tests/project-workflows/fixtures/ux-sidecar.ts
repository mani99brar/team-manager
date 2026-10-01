/**
 * Fixtures of the review sidecar's node (`sidecar.spec.ts`) (docs/PRD_REVIEW_SIDECAR.md 4.7 to 4.9 and section 6), registered
 * as the workflow `ux-sidecar`: mock payloads for the worker phase and a `seed` for the candidate phase, merged by `index.ts`.
 *
 * Every run is a 1.6.0 export of a guarded graph whose `sidecar` node sits right after `challenge` and before every launch
 * node, with `handoff` depending on it last; its events are only `running`, `interactive` and `succeeded`. Each run with a
 * sidecar has a twin without one (same lanes, same rows minus the sidecar's, `sidecar: null`), so the run's activity can be
 * compared with and without it. The ledgers start from Appendix B verbatim (`examples.sidecarLedgerFile`, which the contract
 * test reads from the PRD itself) and add the passes the scenarios need:
 * - `review-sidecar-smoke-001`: two lanes (`engine`, `viewer`) working, the sidecar running. Its export section is Appendix B
 *   (three passes); the live `sidecar.ledger.json` is newer: six passes (#2 timed out, #5 failed), S-1 P1 fix_reported, S-2 P2
 *   open, S-3 P1 open and escalated (security), S-4 P2 verified_resolved; M-1 and M-4 delivered, M-2 refused (question_waiting),
 *   M-3 undeliverable (pane_busy). Its latest event is the sidecar's escalation.
 * - `review-sidecar-smoke-frozen`: the same run after its final pass and the freeze: the node succeeded, the ledger closed with
 *   its handoff, both verifications running. Served from the export section.
 * - `review-sidecar-one-lane`: one lane working, the sidecar's first pass its latest event.
 * - `review-sidecar-blocked`: the controller blocked the wait for handoffs when engine's deadline ran out; the sidecar was then
 *   closed `succeeded` with `closed_at` (its latest event).
 * - `review-sidecar-integrated`: the frozen run carried to the end: both lanes verified, the combined candidate passed, the
 *   review approved and the branch fast-forwarded; the run succeeded, so nothing it shows is polled any more (the ledger
 *   included). Its export section and its live file both hold the closed ledger.
 * - `review-sidecar-no-ledger`: the live run before its first pass ended: two lanes working, the sidecar running, but no ledger
 *   recorded. Its export section is null and its live `sidecar.ledger.json` is invalid (a file without passes), so the sidecar
 *   route answers 404 `SIDECAR_NOT_FOUND` and the page shows the ledger as not recorded. Its twin is `review-sidecar-smoke-plain`.
 * - `review-sidecar-smoke-plain`, `review-sidecar-one-lane-plain`, `review-sidecar-blocked-plain`,
 *   `review-sidecar-integrated-plain`: the twins without a sidecar.
 */
import { sidecarLedgerFile as APPENDIX_B } from '../../../contracts/projects/examples.ts'
import type { RunDetail, RunInputs, SidecarLedger, SidecarLedgerFile, WorkflowDefinition } from '../../../contracts/projects/v1.ts'
import { eventSchema, validateWorkerResult, type WorkerResult, type WorkflowEvent } from '../../../contracts/workflow/v1.ts'
import {
  ADAPTER_ARTIFACTS, ADAPTER_CHECKS, ADAPTER_SESSION, BASE_COMMIT, CANDIDATE_COMMIT, CHALLENGE_NODE, PROJECT, REVIEWER_SESSION, UI_ARTIFACTS, UI_CHECKS, UI_SESSION,
  adapterTask, artifactRefs, backgroundId, checks, definition, laneGraphNodes, launchToken, offset, projectInputs, runDetail, sha256, uiTask,
  type ArtifactFile, type DefinitionNode, type NodeState, type RawChallenge, type RawInputsSection, type RawWorkerInput,
} from '../fixtures.ts'
import type { InternalEvent, SeedContext } from '../seed.ts'
import type { UxFixtureModule, UxPayloads } from './index.ts'

export const UX_SIDECAR_WORKFLOW_ID = 'ux-sidecar'
export const UX_SIDECAR_WORKFLOW_NAME = 'UX sidecar'
/** Appendix B's run id: its export section is the PRD's ledger verbatim. */
export const RUN_SIDECAR = 'review-sidecar-smoke-001'
export const RUN_SIDECAR_PLAIN = 'review-sidecar-smoke-plain'
export const RUN_SIDECAR_FROZEN = 'review-sidecar-smoke-frozen'
export const RUN_SIDECAR_ONE_LANE = 'review-sidecar-one-lane'
export const RUN_SIDECAR_ONE_LANE_PLAIN = 'review-sidecar-one-lane-plain'
export const RUN_SIDECAR_BLOCKED = 'review-sidecar-blocked'
export const RUN_SIDECAR_BLOCKED_PLAIN = 'review-sidecar-blocked-plain'
/** A finished (succeeded) run with a sidecar: its ledger is not polled. */
export const RUN_SIDECAR_INTEGRATED = 'review-sidecar-integrated'
export const RUN_SIDECAR_INTEGRATED_PLAIN = 'review-sidecar-integrated-plain'
/** A sidecar run before its first pass ended: its ledger is not recorded (404 `SIDECAR_NOT_FOUND`). */
export const RUN_SIDECAR_NO_LEDGER = 'review-sidecar-no-ledger'
/** Each sidecar run and its twin without a sidecar. */
export const SIDECAR_TWINS: readonly [string, string][] = [
  [RUN_SIDECAR, RUN_SIDECAR_PLAIN], [RUN_SIDECAR_ONE_LANE, RUN_SIDECAR_ONE_LANE_PLAIN], [RUN_SIDECAR_BLOCKED, RUN_SIDECAR_BLOCKED_PLAIN],
  [RUN_SIDECAR_INTEGRATED, RUN_SIDECAR_INTEGRATED_PLAIN], [RUN_SIDECAR_NO_LEDGER, RUN_SIDECAR_PLAIN],
]

export const SIDECAR_NODE: DefinitionNode = { node_id: 'sidecar', label: 'Review sidecar', kind: 'review', depends_on: [CHALLENGE_NODE.node_id] }
export const DEADLINE_MESSAGE = 'Worker engine deadline exhausted; no automatic relaunch'
/** When the live ledger's last pass ended, and when the frozen run's final pass did. */
export const LAST_PASS_AT = '2026-10-01T13:50:00Z'
export const FINAL_PASS_AT = '2026-10-01T14:25:00Z'
export const CLOSED_AT = '2026-10-01T14:26:00Z'
export const S3_PROBLEM = 'deliver_messages types the message before the gate re-reads the pane, so a dialog that opened since the inventory receives Enter.'
export const S4_PROBLEM = 'The sidecar ledger keeps polling after the run finished, so a closed run still sends a request every five seconds.'
export const S4_RESOLUTION = 'RunView.tsx stops the ledger poll with the run at e5f6a7b; the poll test now covers it.'
export const ESCALATION_TEXT = 'A permission dialog could be confirmed by a typed message; this needs the operator before the next delivery.'
export const PANE_BUSY_TEXT = 'The ledger poll in RunView.tsx keeps running after the run finished; stop it with the run.'
export const HANDOFF_UNRESOLVED = 'S-3 (P1, engine): the delivery gate still types before re-reading the pane.'
export const HANDOFF_GAP = 'The viewer pane was not captured on passes 2 and 6.'

type Lane = 'engine' | 'viewer'
type Row = [clock: string, node: string, status: string, message: string]
type Task = { node_id: string; error: string | null; interrupts: object[]; result: object | null }

const DAY = '2026-10-01'
const at = (clock: string) => `${DAY}T${clock}Z`
const SESSIONS: Record<Lane, string> = { engine: UI_SESSION, viewer: ADAPTER_SESSION }
/** Each lane's frozen snapshot, and the files its verification packets capture. */
const SNAPSHOTS: Record<Lane, string> = { engine: 'e1'.repeat(20), viewer: 'e2'.repeat(20) }
const ARTIFACTS: Record<Lane, ArtifactFile[]> = { engine: ADAPTER_ARTIFACTS, viewer: UI_ARTIFACTS }
const BUNDLE = 'b8'.repeat(32)
const CHALLENGE_SESSION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const LAUNCHING = 'Launching or reconciling the exact native session'
const AWAITING = 'Awaiting explicit completion signal; idle is not acceptance'

// ---- Ledgers: Appendix B verbatim, then three more passes ---------------------------------------------------------

const appendixB = (): SidecarLedgerFile => structuredClone(APPENDIX_B)

/** The live ledger of `review-sidecar-smoke-001`: Appendix B plus passes 4 to 6. */
function liveLedger(runId: string): SidecarLedgerFile {
  const ledger = appendixB()
  ledger.run_id = runId
  ledger.passes.push(
    { n: 4, trigger: 'cadence', started_at: at('13:15:00'), finished_at: at('13:20:00'), status: 'completed', session_id: '1a2b3c4d-0000-4000-8000-000000000004',
      lanes: { engine: { head_commit: 'c0ffee1', pane_captured: true }, viewer: { head_commit: 'd4e5f6a', pane_captured: true } },
      counts: { new: 2, changed: 0, messages: 1 }, summary: 'One P1 in the engine\'s delivery gate; the viewer keeps polling a closed run.' },
    { n: 5, trigger: 'cadence', started_at: at('13:30:00'), finished_at: at('13:31:10'), status: 'failed', session_id: null,
      lanes: { engine: { head_commit: 'c0ffee1', pane_captured: false }, viewer: { head_commit: 'd4e5f6a', pane_captured: false } },
      counts: { new: 0, changed: 0, messages: 0 }, summary: 'CalledProcessError: herdr pane read exited 1' },
    { n: 6, trigger: 'cadence', started_at: at('13:45:00'), finished_at: at('13:50:00'), status: 'completed', session_id: '1a2b3c4d-0000-4000-8000-000000000006',
      lanes: { engine: { head_commit: 'c0ffee1', pane_captured: true }, viewer: { head_commit: 'e5f6a7b', pane_captured: false } },
      counts: { new: 0, changed: 1, messages: 1 }, summary: 'S-4 verified at e5f6a7b; S-3 escalated.' },
  )
  ledger.findings.push(
    {
      id: 'S-3', category: 'risk', severity: 'P1', lane: 'engine', file: 'workflow/sidecar.py', locator: 'deliver_messages', revision: 'c0ffee1',
      problem: S3_PROBLEM, evidence: 'deliver_messages calls send_text at line 140; the pane is read at line 121, before the inventory.',
      remedy: 'Read the pane and the inventory immediately before each send_text and refuse on a dialog.', disposition: 'open', note: null, messages: ['M-4'],
      history: [{ pass: 4, disposition: 'open', revision: 'c0ffee1', evidence: 'deliver_messages calls send_text at line 140; the pane is read at line 121, before the inventory.', note: null, at: at('13:20:00') }],
    },
    {
      id: 'S-4', category: 'defect', severity: 'P2', lane: 'viewer', file: 'src/projects/RunView.tsx', locator: 'sidecar poll', revision: 'e5f6a7b',
      problem: S4_PROBLEM, evidence: S4_RESOLUTION, remedy: 'Stop the ledger poll when the run finishes, like the inputs poll.', disposition: 'verified_resolved', note: null, messages: ['M-3'],
      history: [
        { pass: 4, disposition: 'open', revision: 'd4e5f6a', evidence: 'usePoll is called with true in RunView.tsx.', note: null, at: at('13:20:00') },
        { pass: 6, disposition: 'verified_resolved', revision: 'e5f6a7b', evidence: S4_RESOLUTION, note: null, at: at('13:50:00') },
      ],
    },
  )
  ledger.messages.push(
    { id: 'M-3', pass: 4, lane: 'viewer', finding_ids: ['S-4'], text: PANE_BUSY_TEXT, status: 'undeliverable', reason: 'pane_busy', at: at('13:20:01') },
    { id: 'M-4', pass: 6, lane: 'engine', finding_ids: ['S-3'], text: 'deliver_messages reads the pane before the inventory; re-read both right before typing.', status: 'delivered', reason: null, at: at('13:50:01') },
  )
  ledger.escalations.push({ finding_id: 'S-3', kind: 'security', text: ESCALATION_TEXT, pass: 6, at: at('13:50:01') })
  return ledger
}

/** The frozen run's ledger: the live one, its final pass and the handoff, closed at the freeze. */
function frozenLedger(runId: string): SidecarLedgerFile {
  const ledger = liveLedger(runId)
  ledger.passes.push({ n: 7, trigger: 'final', started_at: at('14:20:00'), finished_at: FINAL_PASS_AT, status: 'completed', session_id: '1a2b3c4d-0000-4000-8000-000000000007',
    lanes: { engine: { head_commit: 'c0ffee2', pane_captured: true }, viewer: { head_commit: 'e5f6a7b', pane_captured: true } },
    counts: { new: 0, changed: 0, messages: 0 }, summary: 'Final pass: three findings stay open at freeze.' })
  ledger.handoff = {
    unresolved: [HANDOFF_UNRESOLVED, 'S-1 (P1, engine): fix reported in the pane, not verified at c0ffee2.', 'S-2 (P2, viewer): seeded ledger times are still hand-written.'],
    structural: ['The delivery gate and the merge share no lock-free read of the pane.'],
    verified_resolved: ['S-4 (P2, viewer): the ledger poll stops with the run.'],
    withdrawn: [],
    gaps: [HANDOFF_GAP],
  }
  ledger.closed_at = CLOSED_AT
  return ledger
}

/** A one-lane run's ledger after its first pass. */
function oneLaneLedger(runId: string): SidecarLedgerFile {
  const ledger = appendixB()
  ledger.run_id = runId
  ledger.passes = [{ ...ledger.passes[0], lanes: { engine: ledger.passes[0].lanes.engine } }]
  ledger.findings = [{ ...ledger.findings[0], disposition: 'open', revision: 'a1b2c3d', evidence: ledger.findings[0].history[0].evidence, history: [ledger.findings[0].history[0]] }]
  ledger.messages = [ledger.messages[0]]
  return ledger
}

/** A blocked run's ledger: one pass, closed with the run before any final pass. */
function blockedLedger(runId: string): SidecarLedgerFile {
  const ledger = oneLaneLedger(runId)
  ledger.passes = [{ ...APPENDIX_B.passes[0] }]
  ledger.closed_at = at('16:00:01')
  return ledger
}

const served = (ledger: SidecarLedgerFile, source: SidecarLedger['source']): SidecarLedger => ({ contract_version: '1.6.0', node_id: 'sidecar', source, ...ledger })

// ---- Runs --------------------------------------------------------------------------------------------------------

type Packet = { phase: 'worker' | 'candidate'; lane: Lane; from: string; to: string }

type Fixture = {
  runId: string
  lanes: readonly Lane[]
  sidecar: boolean
  status: RunDetail['summary']['status']
  events: Row[]
  /** The snapshot the adapter projects from these records, for the worker-phase mock. */
  states: Record<string, NodeState>
  /** Graph values: `launched` (receipts), `frozen` (and snapshots) or `integrated` (and packets, bundle, review, approval, commit). */
  values: 'launched' | 'frozen' | 'integrated'
  /** Passing verification packets (attempt 1 each). */
  packets: Packet[]
  next: string[]
  tasks: Task[]
  stoppedAt: string | null
  /** The export's `sidecar` section and the live `sidecar.ledger.json`; null when absent. */
  section: SidecarLedgerFile | null
  live: SidecarLedgerFile | null
  /** A live `sidecar.ledger.json` the server refuses (the seed writes it; the mock serves no ledger), when `live` is null. */
  invalidLive?: unknown
  /** The run its source branch is named after: a twin keeps its original's. */
  branchOf?: string
}

const challengeRows: Row[] = [
  ['11:55:00', 'challenge', 'running', `Design challenge attempt 1: one print job, session ${CHALLENGE_SESSION}`],
  ['11:58:00', 'challenge', 'succeeded', 'Design challenge attempt 1 passed (0 P2 concern(s)); launching workers'],
]
const launchRows = (lanes: readonly Lane[]): Row[] => [
  ...lanes.map((lane, index): Row => [`11:58:1${index}`, lane, 'running', LAUNCHING]),
  ...lanes.map((lane, index): Row => [`11:58:2${index}`, lane, 'running', AWAITING]),
]
/** The sidecar's rows of the six passes of the live ledger; the escalation is the latest row. */
const passRows: Row[] = [
  ['12:10:00', 'sidecar', 'running', 'pass 1 (cadence) started'],
  ['12:14:20', 'sidecar', 'running', 'pass 1 (cadence): 1 new finding, 1 message delivered to engine'],
  ['12:50:00', 'sidecar', 'interactive', 'pass 2 (completion) timed out after 600 s'],
  ['13:05:00', 'sidecar', 'running', 'pass 3 (cadence): 1 new finding, 1 changed, 1 message refused'],
  ['13:20:00', 'sidecar', 'running', 'pass 4 (cadence): 2 new findings, 1 message undeliverable'],
  ['13:31:10', 'sidecar', 'interactive', 'pass 5 (cadence) failed: see the sidecar page'],
  ['13:50:00', 'sidecar', 'running', 'pass 6 (cadence): 1 verified resolved, 1 message delivered to engine'],
  ['13:50:01', 'sidecar', 'interactive', 'escalation S-3 (security): see the sidecar page'],
]
const firstPassRows: Row[] = passRows.slice(0, 2)

const done = (session: string | null = null): NodeState => ({ status: 'succeeded', attempt: 1, session, result: null })
const working = (lanes: readonly Lane[]): Record<string, NodeState> => Object.fromEntries(lanes.map(lane => [`launch_${lane}`, { status: 'running', attempt: 1, session: SESSIONS[lane], result: null }]))
const challengeDone: Record<string, NodeState> = { challenge: { status: 'succeeded', attempt: 1, session: CHALLENGE_SESSION } }
const sidecarRunning: NodeState = { status: 'running', attempt: 1 }
const HANDOFF_WAIT = { kind: 'worker_handoff', message: 'Awaiting explicit completion signals and automatic freeze.' }
const handoffWait: Task[] = [{ node_id: 'handoff', error: null, interrupts: [HANDOFF_WAIT], result: null }]

const TWO: readonly Lane[] = ['engine', 'viewer']
const ONE: readonly Lane[] = ['engine']

/** The run without its sidecar: the same lanes and rows minus the sidecar's, and no ledger. */
function plain(fixture: Fixture, runId: string): Fixture {
  const states = { ...fixture.states }
  delete states.sidecar
  return { ...fixture, runId, sidecar: false, events: fixture.events.filter(([, node]) => node !== 'sidecar'), states, section: null, live: null, branchOf: fixture.runId }
}

const LIVE: Fixture = {
  runId: RUN_SIDECAR, lanes: TWO, sidecar: true, status: 'running',
  events: [...challengeRows, ...launchRows(TWO), ...passRows],
  states: { ...challengeDone, sidecar: sidecarRunning, ...working(TWO) },
  values: 'launched', packets: [], next: ['handoff'], tasks: handoffWait, stoppedAt: null,
  section: { ...appendixB() }, live: liveLedger(RUN_SIDECAR),
}

const FROZEN: Fixture = {
  runId: RUN_SIDECAR_FROZEN, lanes: TWO, sidecar: true, status: 'running',
  events: [
    ...challengeRows, ...launchRows(TWO), ...passRows,
    ['14:20:00', 'sidecar', 'running', 'pass 7 (final) started'],
    ['14:25:00', 'sidecar', 'running', 'pass 7 (final): no new findings'],
    ['14:26:00', 'sidecar', 'succeeded', 'closed at freeze after 7 passes: 3 open, 1 verified resolved, 2 failed passes'],
    ['14:26:00', 'freeze', 'stopped', 'Native workers stopped before snapshot capture: engine, viewer'],
    ['14:26:00', 'freeze', 'succeeded', 'Immutable snapshots captured; worker-reported checks are not trusted'],
    ['14:26:05', 'verify_engine', 'running', `Attempt 1; revision ${'e1'.repeat(20)}`],
    ['14:26:05', 'verify_viewer', 'running', `Attempt 1; revision ${'e2'.repeat(20)}`],
  ],
  states: {
    ...challengeDone, sidecar: done(), launch_engine: done(SESSIONS.engine), launch_viewer: done(SESSIONS.viewer), handoff: done(),
    verify_engine: { status: 'running', attempt: 1 }, verify_viewer: { status: 'running', attempt: 1 },
  },
  values: 'frozen', packets: [], next: ['verify_engine', 'verify_viewer'], tasks: [], stoppedAt: at('14:26:00'),
  section: frozenLedger(RUN_SIDECAR_FROZEN), live: null,
}

const ONE_LANE: Fixture = {
  runId: RUN_SIDECAR_ONE_LANE, lanes: ONE, sidecar: true, status: 'running',
  events: [...challengeRows, ...launchRows(ONE), ...firstPassRows],
  states: { ...challengeDone, sidecar: sidecarRunning, ...working(ONE) },
  values: 'launched', packets: [], next: ['handoff'], tasks: handoffWait, stoppedAt: null,
  section: null, live: oneLaneLedger(RUN_SIDECAR_ONE_LANE),
}

const BLOCKED: Fixture = {
  runId: RUN_SIDECAR_BLOCKED, lanes: TWO, sidecar: true, status: 'failed',
  events: [
    ...challengeRows, ...launchRows(TWO), ...firstPassRows,
    ['16:00:00', 'controller', 'blocked', DEADLINE_MESSAGE],
    ['16:00:01', 'sidecar', 'succeeded', 'stopped with the run after 1 pass'],
  ],
  states: { ...challengeDone, sidecar: done(), ...working(TWO), handoff: { status: 'failed', attempt: 1 } },
  values: 'launched', packets: [], next: ['handoff'], tasks: handoffWait, stoppedAt: null,
  section: blockedLedger(RUN_SIDECAR_BLOCKED), live: blockedLedger(RUN_SIDECAR_BLOCKED),
}

const INTEGRATED: Fixture = {
  ...FROZEN, runId: RUN_SIDECAR_INTEGRATED, status: 'succeeded',
  events: [
    ...FROZEN.events.slice(0, -2),
    ['14:26:05', 'verify_engine', 'running', `Attempt 1; revision ${SNAPSHOTS.engine}`],
    ['14:26:05', 'verify_viewer', 'running', `Attempt 1; revision ${SNAPSHOTS.viewer}`],
    ['14:31:00', 'verify_engine', 'succeeded', 'Required tests and artifacts passed; recorded for the candidate gate: backend-unit'],
    ['14:34:00', 'verify_viewer', 'succeeded', 'Required tests and artifacts passed; recorded for the candidate gate: frontend-build, project-workflows-browser'],
    ['14:40:00', 'candidate_engine', 'succeeded', `Combined revision ${CANDIDATE_COMMIT}`],
    ['14:42:00', 'candidate_viewer', 'succeeded', `Combined revision ${CANDIDATE_COMMIT}`],
    ['14:45:00', 'review', 'running', 'Launching reviewer general over the shared review worktree'],
    ['14:55:00', 'review', 'approved', REVIEWER_SESSION],
    ['14:55:03', 'integrate', 'succeeded', `Fast-forwarded to ${CANDIDATE_COMMIT}; no push performed`],
  ],
  states: {
    ...challengeDone, sidecar: done(), launch_engine: done(SESSIONS.engine), launch_viewer: done(SESSIONS.viewer), handoff: done(),
    verify_engine: done(SESSIONS.engine), verify_viewer: done(SESSIONS.viewer), candidate: { ...done(), lanes: TWO.map(lane => ({ worker: lane, attempt: 1 })) },
    review: done(), approval: done(), integrate: done(),
  },
  values: 'integrated', next: [], tasks: [],
  packets: [
    { phase: 'worker', lane: 'engine', from: '14:26:10', to: '14:30:55' },
    { phase: 'worker', lane: 'viewer', from: '14:26:10', to: '14:33:55' },
    { phase: 'candidate', lane: 'engine', from: '14:34:05', to: '14:39:55' },
    { phase: 'candidate', lane: 'viewer', from: '14:34:05', to: '14:41:55' },
  ],
  section: frozenLedger(RUN_SIDECAR_INTEGRATED), live: frozenLedger(RUN_SIDECAR_INTEGRATED),
}

const NO_LEDGER: Fixture = {
  ...LIVE, runId: RUN_SIDECAR_NO_LEDGER,
  events: [...challengeRows, ...launchRows(TWO), passRows[0]],
  section: null, live: null,
  invalidLive: { version: '1.0.0', run_id: RUN_SIDECAR_NO_LEDGER, settings: APPENDIX_B.settings },
}

const FIXTURES: Fixture[] = [
  LIVE, plain(LIVE, RUN_SIDECAR_PLAIN), FROZEN,
  ONE_LANE, plain(ONE_LANE, RUN_SIDECAR_ONE_LANE_PLAIN),
  BLOCKED, plain(BLOCKED, RUN_SIDECAR_BLOCKED_PLAIN),
  INTEGRATED, plain(INTEGRATED, RUN_SIDECAR_INTEGRATED_PLAIN),
  NO_LEDGER,
]

/** The graph of a sidecar run: challenge, sidecar, the lanes (launches depend on the challenge), `handoff` depending on the sidecar last. */
export function sidecarNodes(lanes: readonly string[], sidecar: boolean): DefinitionNode[] {
  return [
    CHALLENGE_NODE,
    ...(sidecar ? [SIDECAR_NODE] : []),
    ...laneGraphNodes(lanes).map(node => node.kind === 'worker' ? { ...node, depends_on: [CHALLENGE_NODE.node_id] }
      : node.node_id === 'handoff' && sidecar ? { ...node, depends_on: [...node.depends_on, SIDECAR_NODE.node_id] } : node),
  ]
}

const definitions = new Map<string, WorkflowDefinition>()
function definitionOf(fixture: Fixture): WorkflowDefinition {
  const key = `${fixture.lanes.join(',')}:${fixture.sidecar}`
  if (!definitions.has(key)) definitions.set(key, definition(PROJECT.project_id, UX_SIDECAR_WORKFLOW_ID, UX_SIDECAR_WORKFLOW_NAME, sidecarNodes(fixture.lanes, fixture.sidecar)))
  return definitions.get(key)!
}
/** The workflow's current definition: two lanes with a sidecar. */
export const UX_SIDECAR_DEFINITION = definitionOf(LIVE)

const createdAt = (fixture: Fixture) => at(fixture.events[0][0].replace(/:\d\d$/, ':00'))
const updatedAt = (fixture: Fixture) => at(fixture.events.at(-1)![0])
const records = (fixture: Fixture): InternalEvent[] => fixture.events.map(([clock, node, status, message], index) => ({ sequence: index + 1, time: at(clock), node, status, message }))

const challenge: RawChallenge = {
  status: 'passed', attempt: 1, session_id: CHALLENGE_SESSION,
  pinned: { tasks_sha256: sha256('tasks-sidecar'), decisions_sha256: sha256('decisions-sidecar'), prd_sha256: sha256('prd-sidecar') },
  concerns: [], simpler_alternative: 'None simpler.', cheap_experiment: 'None needed.', accepted_reason: null, decided_at: at('11:58:00'), attempts: 1,
}

function rawWorker(fixture: Fixture, lane: Lane, leak: string): RawWorkerInput {
  const engine = lane === 'engine'
  const started = at(engine ? '11:58:10' : '11:58:11')
  const stopped = fixture.stoppedAt
  const summary = engine ? 'Ran the sidecar passes and the ledger merge.' : 'Served the ledger and the sidecar page.'
  return {
    role: engine ? 'backend' : 'frontend',
    required_check_kinds: engine ? ['unit'] : ['build', 'browser'],
    task: engine ? adapterTask() : uiTask(leak),
    prompt: null,
    owned_paths: engine ? ['workflow'] : ['src/projects'],
    checks: engine ? ADAPTER_CHECKS : UI_CHECKS,
    launch: {
      session_id: SESSIONS[lane], launch_token: launchToken(lane), launch_requested_at: offset(started), native_started_at: Date.parse(started),
      observed_state: 'working', status: 'attached_session_available', launcher_invocations: 1, background_id: backgroundId(lane),
    },
    completion: stopped ? { version: '1.1.0', status: 'completed', summary, open_assumptions: [], untested: [], falsifying_check: null, verify_yourself: null, question: null } : null,
    handoff: stopped ? { summary, open_assumptions: [] } : null,
    stop: stopped ? { stopped: true, confirmed_at: offset(stopped) } : null,
    questions: [],
  }
}

function inputsSection(fixture: Fixture, leak: string): RawInputsSection {
  return {
    feature: 'Review sidecar', policy_version: '1.2.0', base_commit: BASE_COMMIT, source_branch: `feature/${UX_SIDECAR_WORKFLOW_ID}/${fixture.branchOf ?? fixture.runId}`,
    mode: 'automatic',
    automatic: { finish: 'verified-feature-branch', permission_mode: 'bypassPermissions', worker_timeout_seconds: 14400, review_timeout_seconds: 3600, reviewer_transport: 'native' },
    setup: [{ argv: ['npm', 'ci'], command: 'npm ci', timeout_seconds: 600 }],
    max_verification_attempts: 3,
    failure_drill: null,
    selected_workers: [...fixture.lanes],
    excluded_workers: [],
    workers: Object.fromEntries(fixture.lanes.map(lane => [lane, rawWorker(fixture, lane, leak)])),
    decisions: null,
    challenge,
  }
}

// The adapter's projection of the raw rows for the worker-phase mock (as `normalizeEvents` serves them): a lane's rows on its
// launch node, `freeze` on the handoff, the sidecar's on its own node, statuses through the adapter's table.
const EVENT_STATUS: Record<string, WorkflowEvent['status']> = {
  running: 'running', interactive: 'running', blocked: 'failed', succeeded: 'succeeded', passed: 'succeeded', approved: 'succeeded', paused: 'paused', interrupted: 'paused',
}
const OWN_ATTEMPT = /^(?:Attempt|Design challenge attempt|Feature files re-pinned for design challenge attempt) (\d+)\b/

function servedEvents(fixture: Fixture): WorkflowEvent[] {
  const known = new Set(definitionOf(fixture).nodes.map(node => node.node_id))
  const lanes: readonly string[] = fixture.lanes
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
    const status = node_id || record.node === 'controller' ? EVENT_STATUS[record.status] ?? null : null
    const lane = node_id === 'candidate' ? record.node.slice('candidate_'.length) : null
    return eventSchema.parse({
      contract_version: '1.0.0', run_id: fixture.runId, event_id: `${fixture.runId}:${record.sequence}`, sequence: record.sequence, occurred_at: record.time,
      node_id, attempt, type: node_id && status ? 'status_changed' : 'log', status, message: lane ? `[${lane}] ${record.message}` : record.message,
      artifact: null, result_uri: null, reused_from_attempt: null,
    })
  })
}

/** A verification packet's result: the lane's checks spread over the attempt, all passing. */
function packetResult(runId: string, packet: Packet): WorkerResult {
  const { lane, from, to } = packet
  const commands = lane === 'viewer'
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
const servedLedger = (fixture: Fixture): SidecarLedger | null => fixture.live ? served(fixture.live, 'live') : fixture.section ? served(fixture.section, 'export') : null

/** What the sidecar route serves for each run in the worker phase (the live file over the export section). */
export const SIDECAR_LEDGERS: Record<string, SidecarLedger> = Object.fromEntries(FIXTURES.flatMap(fixture => {
  const ledger = servedLedger(fixture)
  return ledger ? [[fixture.runId, ledger]] : []
}))

/** The live ledger of `review-sidecar-smoke-001` after one more pass: S-1 verified resolved (the sidecar-live scenario's next poll). */
export function ledgerAfterNextPass(): SidecarLedger {
  const ledger = structuredClone(SIDECAR_LEDGERS[RUN_SIDECAR])
  ledger.passes.push({ n: 7, trigger: 'cadence', started_at: at('14:05:00'), finished_at: at('14:10:00'), status: 'completed', session_id: '1a2b3c4d-0000-4000-8000-000000000008',
    lanes: { engine: { head_commit: 'c0ffee2', pane_captured: true }, viewer: { head_commit: 'e5f6a7b', pane_captured: true } },
    counts: { new: 0, changed: 1, messages: 0 }, summary: 'S-1 verified at c0ffee2.' })
  const s1 = ledger.findings.find(finding => finding.id === 'S-1')!
  Object.assign(s1, { disposition: 'verified_resolved', revision: 'c0ffee2', evidence: 'merge_output validates before the write at c0ffee2; test_sidecar covers a rejected output.' })
  s1.history.push({ pass: 7, disposition: 'verified_resolved', revision: 'c0ffee2', evidence: s1.evidence, note: null, at: at('14:10:00') })
  return ledger
}

const payloads: Partial<UxPayloads> = {
  workflows: [UX_SIDECAR_DEFINITION],
  runDetails: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, detailOf(fixture)])),
  runEvents: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, servedEvents(fixture)])),
  runInputs: Object.fromEntries(FIXTURES.map((fixture): [string, RunInputs] => [fixture.runId, projectInputs(fixture.runId, inputsSection(fixture, '<path>'))])),
  workerResults: Object.fromEntries(FIXTURES.filter(fixture => fixture.packets.length > 0)
    .map(fixture => [fixture.runId, Object.fromEntries(fixture.packets.map(packet => [resultKey(packet), packetResult(fixture.runId, packet)]))])),
  artifactFiles: Object.fromEntries(FIXTURES.filter(fixture => fixture.packets.length > 0).map(fixture => [fixture.runId, fixture.lanes.flatMap(lane => ARTIFACTS[lane])])),
  sidecarLedgers: SIDECAR_LEDGERS,
}

function seed({ repository, runsRoot, writeRun, writePacket, receipt, leakFor }: SeedContext) {
  const root = runsRoot(UX_SIDECAR_WORKFLOW_ID)
  for (const fixture of FIXTURES) {
    const runDir = `${root}/${fixture.runId}`
    writeRun(root, repository, fixture.runId, {
      createdAt: createdAt(fixture), updatedAt: updatedAt(fixture), definitionNodes: sidecarNodes(fixture.lanes, fixture.sidecar), definitionName: UX_SIDECAR_WORKFLOW_NAME,
      version: '1.6.0', lanes: fixture.lanes,
      values: {
        lanes: Object.fromEntries(fixture.lanes.map(lane => [lane, receipt(lane, runDir, SESSIONS[lane], at(lane === 'engine' ? '11:58:10' : '11:58:11'))])),
        ...(fixture.values !== 'launched' ? { snapshots: Object.fromEntries(fixture.lanes.map(lane => [lane, SNAPSHOTS[lane]])) } : {}),
        ...(fixture.values === 'integrated' ? {
          packets: Object.fromEntries(fixture.lanes.map(lane => [lane, `verification/worker/${lane}/1/packet.json`])),
          bundle: { run_id: fixture.runId, base_commit: BASE_COMMIT, candidate_commit: CANDIDATE_COMMIT, policy_sha256: 'e'.repeat(64) },
          review: { run_id: fixture.runId, verdict: 'approved', independent: true, reviewer: REVIEWER_SESSION, findings: [] },
          approved_bundle: BUNDLE, integrated_commit: CANDIDATE_COMMIT,
        } : {}),
      },
      next: fixture.next,
      tasks: fixture.tasks,
      events: records(fixture),
      packets: directory => fixture.packets.map(packet => writePacket(directory, packet.phase, packet.lane, 1, packetResult(fixture.runId, packet), ARTIFACTS[packet.lane], { status: 'passed', reasons: [] })),
      review: null,
      inputs: inputsSection(fixture, leakFor(root, fixture.runId)),
      sidecar: fixture.section,
      ...(fixture.live ? { sidecarLedger: fixture.live } : fixture.invalidLive !== undefined ? { sidecarLedger: fixture.invalidLive } : {}),
    })
  }
  return { workflows: [{ workflow_id: UX_SIDECAR_WORKFLOW_ID, runs_root: root, definition: { name: UX_SIDECAR_WORKFLOW_NAME, nodes: UX_SIDECAR_DEFINITION.nodes } }] }
}

export const uxSidecar: UxFixtureModule = { payloads, seed }
