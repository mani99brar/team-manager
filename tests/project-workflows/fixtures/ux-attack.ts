/**
 * Fixtures of the attack pass (`attack.spec.ts`) (docs/PRD_ATTACK_PASS.md 4.6, Appendix A), registered as the workflow
 * `ux-attack`: mock payloads for the worker phase and a `seed` for the candidate phase, merged by `index.ts`.
 *
 * Every run is a 1.8.0 export of the two-lane graph (`ui`, `adapter`, no inputs section). A run with a pass has the node
 * `attack` ("Attack pass", kind `review`) right after `review` with the same `depends_on`, and `approval` depends on both;
 * its events are only `running`, `interactive` and one closing `succeeded`, with Appendix A's texts. Each run with a pass
 * has a twin without one (same rows minus the attack's, `attack: null`, the graph every other run has), so the run's
 * activity and status can be compared with and without it. The records start from Appendix A verbatim (`APPENDIX_A` below;
 * a unit test holds it equal to `examples.attackRecord`, which the contract test reads from the PRD itself):
 * - `attack-verified`: integrated; two angles, `auth-funds` (Appendix A's attacker) and `inputs-state` (timed out); five
 *   findings: A-1 verified and labelled real, A-2 not reproduced (its test passed), A-3 verified at the skeptic's P1 (the
 *   attacker said P0), unlabelled and quoting no requirement, A-4 refuted, A-5 reproduced but not judged. Export section only.
 * - `attack-pending`: the review is running and the pass has not started: the export's `pending` record (decisions G10).
 * - `attack-live`: the review and the pass are running; the export holds the `pending` record and the live `attack.json` is
 *   newer: the attacker succeeded, A-1 reproduced and not judged yet, A-2's re-run still owed (`rerun: null`, decisions L15).
 * - `attack-waiting`: the review approved and the controller waits for the pass (decisions L9): the attack node is the only
 *   running step. Live record as `attack-live`'s.
 * - `attack-blocked`: the review blocked the candidate; the pass still ran to its end (Appendix A's record).
 * - `attack-failed`: integrated; `attack.json` was invalid, so the export holds the `failed` record with its error.
 * - `attack-refused`: integrated; a listed secret file reappeared: the `refused` record.
 * - `attack-invalid`: the node exists but neither the export section nor the live file is a valid record: the route answers
 *   404 `ATTACK_NOT_FOUND` and the page says the record is not recorded.
 * - `attack-verified-plain`, `attack-pending-plain`, `attack-live-plain`, `attack-waiting-plain`, `attack-blocked-plain`: the
 *   twins without a pass (`attack: null`), which show no Attack pass section.
 */
import type { AttackRecord, AttackResult, RunDetail, WorkflowDefinition } from '../../../contracts/projects/v1.ts'
import { eventSchema, validateWorkerResult, type WorkerResult, type WorkflowEvent } from '../../../contracts/workflow/v1.ts'
import {
  ADAPTER_ARTIFACTS, ADAPTER_SESSION, BASE_COMMIT, CANDIDATE_COMMIT, PROJECT, REVIEWER_SESSION, UI_ARTIFACTS, UI_SESSION,
  artifactRefs, checks, definition, laneGraphNodes, runDetail,
  type ArtifactFile, type DefinitionNode, type NodeState,
} from '../fixtures.ts'
import type { InternalEvent, SeedContext } from '../seed.ts'
import type { UxFixtureModule, UxPayloads } from './index.ts'

export const UX_ATTACK_WORKFLOW_ID = 'ux-attack'
export const UX_ATTACK_WORKFLOW_NAME = 'UX attack pass'
export const RUN_ATTACK_VERIFIED = 'attack-verified'
export const RUN_ATTACK_PENDING = 'attack-pending'
export const RUN_ATTACK_LIVE = 'attack-live'
export const RUN_ATTACK_WAITING = 'attack-waiting'
export const RUN_ATTACK_BLOCKED = 'attack-blocked'
export const RUN_ATTACK_FAILED = 'attack-failed'
export const RUN_ATTACK_REFUSED = 'attack-refused'
export const RUN_ATTACK_INVALID = 'attack-invalid'
const plainOf = (runId: string) => `${runId}-plain`
export const RUN_ATTACK_VERIFIED_PLAIN = plainOf(RUN_ATTACK_VERIFIED)
/** Each run with a pass and its twin without one. */
export const ATTACK_TWINS: readonly [string, string][] = [RUN_ATTACK_VERIFIED, RUN_ATTACK_PENDING, RUN_ATTACK_LIVE, RUN_ATTACK_WAITING, RUN_ATTACK_BLOCKED]
  .map(runId => [runId, plainOf(runId)])

export const ATTACK_NODE: DefinitionNode = { node_id: 'attack', label: 'Attack pass', kind: 'review', depends_on: ['candidate'] }
export const A3_TITLE = 'A claim can be filed against a closed policy'
export const A4_TITLE = 'An adjuster can reopen a settled claim'
export const A5_TITLE = 'Two concurrent payouts can exceed the reserve'
export const TIMED_OUT_ERROR = 'timed out after 60 minutes; its process group was stopped'
export const INVALID_ERROR = 'attack.json is not valid: findings.0.status: Invalid option'
/** The refused record's error as the server serves it: the secret file's path redacted. */
export const REFUSED_ERROR = 'Blocked: an attack pass needs <path> off this host: move it, then launch again'
const SECRET_FILE = '/home/agentops/.config/vps-wallet.env'

type Row = [clock: string, node: string, status: string, message: string]
type Task = { node_id: string; error: string | null; interrupts: object[]; result: object | null }
type Lane = 'ui' | 'adapter'

/**
 * The runs' day: a year before Appendix A's own times, so these finished runs stay outside the 7-day Recent window of every
 * Runs home spec (whose clocks are pinned before it) and never push those specs' rows past the shown ten.
 */
const DAY = '2025-10-05'
const at = (clock: string) => `${DAY}T${clock}Z`
const LANES: readonly Lane[] = ['ui', 'adapter']
const SESSIONS: Record<Lane, string> = { ui: UI_SESSION, adapter: ADAPTER_SESSION }
const SNAPSHOTS: Record<Lane, string> = { ui: 'a1'.repeat(20), adapter: 'a2'.repeat(20) }
const ARTIFACTS: Record<Lane, ArtifactFile[]> = { ui: UI_ARTIFACTS, adapter: ADAPTER_ARTIFACTS }
const BUNDLE = 'b9'.repeat(32)

// ---- Records: Appendix A verbatim, then what the scenarios need --------------------------------------------------------

/** docs/PRD_ATTACK_PASS.md Appendix A, verbatim (held equal to `examples.attackRecord` by tests/unit/attack.test.ts). */
export const APPENDIX_A: AttackRecord = {
  version: '1.0.0',
  run_id: 'claims-007',
  candidate_commit: '4f3c2b1a9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b',
  settings: { angles: ['auth-funds'], budget_usd: 15, timeout_minutes: 60, skeptic_budget_usd: 5, skeptic_timeout_minutes: 20, max_findings: 8, requirements: ['docs/security/requirements.md'], secret_files: [SECRET_FILE] },
  status: 'succeeded',
  started_at: '2026-10-05T10:00:00Z',
  finished_at: '2026-10-05T10:58:10Z',
  error: null,
  attackers: [
    {
      id: 'auth-funds', angle: 'auth-funds', status: 'succeeded',
      started_at: '2026-10-05T10:01:30Z', finished_at: '2026-10-05T10:41:02Z', error: null,
      session_id: '0f2b3c6e-4a4d-4b8e-9d1a-6b2f1c0a9e11', cost_usd: 7.42,
      summary: 'Two requirements of the claims module fail on this candidate; one could not be expressed offline.',
      out_of_reach: ['SEC-TX-02 needs a real chain reorganisation; the in-process harness has none.'],
      skeptic: { status: 'succeeded', started_at: '2026-10-05T10:46:00Z', finished_at: '2026-10-05T10:57:40Z', error: null, session_id: '7c1d2e3f-5b6a-4c7d-8e9f-0a1b2c3d4e5f', cost_usd: 1.10 },
    },
  ],
  findings: [
    {
      id: 'A-1', ref: 'f1', attacker: 'auth-funds', severity: 'P1',
      title: 'A claim\'s provenance can name another account',
      threat: 'A signed-in user files a claim whose provenance names another account; reviewers then trust the claim as that account\'s.',
      requirement: 'SEC-CLAIM-03: the server derives a claim\'s author from the session, never from the request body.',
      test_file: 'attack/auth-funds/A-1.test.ts',
      expected: '403 and no claim row', observed: '201 and a claim row authored by the other account',
      rerun: { status: 'reproduced', reason: null, exit_code: 1, duration_seconds: 14.2, output_tail: 'FAIL attack-tests/A-1.test.ts > rejects a body author\nAssertionError: expected 201 to be 403', at: '2026-10-05T10:44:10Z' },
      skeptic: { verdict: 'verified', reason: 'SEC-CLAIM-03 states it; the assertion that fails is the status check of the request under test.', severity: 'P1' },
      status: 'verified',
      labels: [{ label: 'real', review_found: 'no', note: null, by: 'operator', at: '2026-10-05T12:00:00Z' }],
    },
    {
      id: 'A-2', ref: 'f2', attacker: 'auth-funds', severity: 'P2',
      title: 'A withdrawn claim keeps its evidence link',
      threat: 'A withdrawn claim\'s evidence stays readable to its former reviewers.',
      requirement: null,
      test_file: 'attack/auth-funds/A-2.test.ts',
      expected: '404 after withdrawal', observed: '200',
      rerun: { status: 'not_reproduced', reason: 'passed', exit_code: 0, duration_seconds: 9.8, output_tail: '1 passed', at: '2026-10-05T10:45:01Z' },
      skeptic: null,
      status: 'not_reproduced',
      labels: [],
    },
  ],
}

const appendixA = (runId: string): AttackRecord => ({ ...structuredClone(APPENDIX_A), run_id: runId })

const reproduced = (seconds: number, tail: string, clock: string) => ({ status: 'reproduced' as const, reason: null, exit_code: 1, duration_seconds: seconds, output_tail: tail, at: at(clock) })

/** The integrated run's record: Appendix A's attacker and findings, a second angle that timed out, and A-3 to A-5. */
function verifiedRecord(runId: string): AttackRecord {
  const record = appendixA(runId)
  record.settings.angles = ['auth-funds', 'inputs-state']
  record.started_at = at('10:31:05')
  record.finished_at = at('11:58:10')
  record.attackers.push({
    id: 'inputs-state', angle: 'inputs-state', status: 'timed_out', started_at: at('10:42:00'), finished_at: at('11:42:00'), error: TIMED_OUT_ERROR,
    session_id: '5e6f7a8b-1c2d-4e3f-8a9b-0c1d2e3f4a5b', cost_usd: 15, summary: null, out_of_reach: [],
    skeptic: { status: 'not_run', started_at: null, finished_at: null, error: null, session_id: null, cost_usd: null },
  })
  record.findings.push(
    {
      id: 'A-3', ref: 'f3', attacker: 'auth-funds', severity: 'P0', title: A3_TITLE,
      threat: 'A signed-in user files a claim against a policy that closed last month and the claim enters the payout queue.',
      requirement: null, test_file: 'attack/auth-funds/A-3.test.ts', expected: '409 and no claim row', observed: '201 and a queued claim',
      rerun: reproduced(11.4, 'FAIL attack-tests/A-3.test.ts > refuses a closed policy\nAssertionError: expected 201 to be 409', '10:45:30'),
      skeptic: { verdict: 'verified', reason: 'The claims module states no rule on closed policies, so P1 rather than P0; the failure is the status check.', severity: 'P1' },
      status: 'verified', labels: [],
    },
    {
      id: 'A-4', ref: 'f4', attacker: 'auth-funds', severity: 'P2', title: A4_TITLE,
      threat: 'An adjuster reopens a settled claim and edits its amount.',
      requirement: 'SEC-CLAIM-07: a settled claim is read-only.', test_file: 'attack/auth-funds/A-4.test.ts', expected: '403', observed: '200',
      rerun: reproduced(8.1, 'FAIL attack-tests/A-4.test.ts > settled is read-only\nAssertionError: expected 200 to be 403', '10:45:50'),
      skeptic: { verdict: 'refuted', reason: 'The test signs in as a supervisor, who may reopen a settled claim by SEC-CLAIM-08.', severity: 'P2' },
      status: 'refuted', labels: [],
    },
    {
      id: 'A-5', ref: 'f5', attacker: 'auth-funds', severity: 'P1', title: A5_TITLE,
      threat: 'Two payout requests for the same claim, sent together, both pass the reserve check.',
      requirement: 'SEC-PAY-02: the payouts of a claim never exceed its reserve.', test_file: 'attack/auth-funds/A-5.test.ts', expected: 'one 201 and one 409', observed: 'two 201',
      rerun: reproduced(21.7, 'FAIL attack-tests/A-5.test.ts > serialises payouts\nAssertionError: expected [ 201, 201 ] to include 409', '10:46:20'),
      skeptic: null, status: 'unjudged', labels: [],
    },
  )
  return record
}

/**
 * The record while the pass runs, in its re-run phase: the attacker succeeded, A-1 reproduced and not judged yet, A-2's re-run
 * still owed (`rerun: null`, decisions L15), the skeptic not started yet. The viewer reads this live record without a reload.
 */
function runningRecord(runId: string): AttackRecord {
  const record = appendixA(runId)
  record.status = 'running'
  record.finished_at = null
  record.attackers[0].skeptic = { status: 'not_run', started_at: null, finished_at: null, error: null, session_id: null, cost_usd: null }
  Object.assign(record.findings[0], { skeptic: null, status: 'unjudged', labels: [] })
  // A-2's re-run is still owed: `rerun: null` with status `not_reproduced` (decisions L15), the live state the viewer must render.
  Object.assign(record.findings[1], { rerun: null, status: 'not_reproduced' })
  return record
}

/** The same pass once its skeptic ended: Appendix A's record before any label (the attack-live scenario's next poll). */
function finishedRecord(runId: string): AttackRecord {
  const record = appendixA(runId)
  record.findings[0].labels = []
  return record
}

/** The export's `pending` record (decisions G10): the eight settings, nothing run yet. */
function pendingRecord(runId: string): AttackRecord {
  return {
    version: '1.0.0', run_id: runId, candidate_commit: null, settings: structuredClone(APPENDIX_A.settings), status: 'pending',
    started_at: null, finished_at: null, error: null, attackers: [], findings: [],
  }
}

const failedRecord = (runId: string): AttackRecord => ({ ...pendingRecord(runId), status: 'failed', error: INVALID_ERROR })
const refusedRecord = (runId: string): AttackRecord => ({
  ...pendingRecord(runId), candidate_commit: CANDIDATE_COMMIT, status: 'refused', started_at: at('10:31:05'), finished_at: at('10:31:06'),
  error: REFUSED_ERROR.replace('<path>', SECRET_FILE),
})

/** What the route serves for a record: the contract's three keys, and the record's paths redacted as the server redacts them. */
export function served(record: AttackRecord, source: AttackResult['source']): AttackResult {
  const copy = structuredClone(record)
  copy.settings.secret_files = copy.settings.secret_files.map(() => '<path>')
  if (copy.error !== null) copy.error = copy.error.replace(SECRET_FILE, '<path>')
  return { contract_version: '1.8.0', node_id: 'attack', source, ...copy }
}

// ---- Runs --------------------------------------------------------------------------------------------------------------

type Fixture = {
  runId: string
  attack: boolean
  status: RunDetail['summary']['status']
  events: Row[]
  states: Record<string, NodeState>
  /** Graph values: `reviewing` (packets and bundle) or `integrated` (and review, approval, commit). */
  values: 'reviewing' | 'integrated'
  /** The review value is present so the review node reads `succeeded` (decided) without the integration evidence. */
  reviewed?: boolean
  next: string[]
  tasks: Task[]
  /** The export's `attack` section and the live `attack.json`; null when absent. */
  section: AttackRecord | null
  live: AttackRecord | null
  /** An export section or live file the server refuses (the seed writes them; the mock serves no record). */
  invalidSection?: unknown
  invalidLive?: string
}

const workRows: Row[] = [
  ['10:00:00', 'adapter', 'running', 'Launching or reconciling the exact native session'],
  ['10:00:01', 'ui', 'running', 'Launching or reconciling the exact native session'],
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
const started: Row = ['10:31:05', 'attack', 'running', 'Attack pass started (auth-funds)']
const approved: Row = ['10:50:00', 'review', 'approved', REVIEWER_SESSION]

const done = (session: string | null = null): NodeState => ({ status: 'succeeded', attempt: 1, session, result: null })
const verifiedStates: Record<string, NodeState> = {
  launch_ui: done(SESSIONS.ui), launch_adapter: done(SESSIONS.adapter), handoff: done(),
  verify_ui: done(SESSIONS.ui), verify_adapter: done(SESSIONS.adapter), candidate: { ...done(), lanes: LANES.map(lane => ({ worker: lane, attempt: 1 })) },
}
const reviewWait: Task[] = [{ node_id: 'review', error: null, interrupts: [], result: null }]

const VERIFIED: Fixture = {
  runId: RUN_ATTACK_VERIFIED, attack: true, status: 'succeeded',
  events: [
    ...workRows, ['10:31:05', 'attack', 'running', 'Attack pass started (auth-funds, inputs-state)'], approved,
    ['11:42:00', 'attack', 'interactive', 'Attack pass attacker inputs-state timed_out: see attack/inputs-state.stderr.log'],
    ['11:58:10', 'attack', 'succeeded', 'Attack pass: 5 finding(s), 4 reproduced, 2 verified'],
    ['11:58:15', 'integrate', 'succeeded', `Fast-forwarded to ${CANDIDATE_COMMIT}; no push performed`],
  ],
  states: { ...verifiedStates, review: done(), attack: done(), approval: done(), integrate: done() },
  values: 'integrated', next: [], tasks: [], section: verifiedRecord(RUN_ATTACK_VERIFIED), live: null,
}

const PENDING: Fixture = {
  runId: RUN_ATTACK_PENDING, attack: true, status: 'running',
  events: [...workRows],
  states: { ...verifiedStates, review: { status: 'running', attempt: 1 } },
  values: 'reviewing', next: ['review'], tasks: reviewWait, section: pendingRecord(RUN_ATTACK_PENDING), live: null,
}

const LIVE: Fixture = {
  runId: RUN_ATTACK_LIVE, attack: true, status: 'running',
  events: [...workRows, started],
  states: { ...verifiedStates, review: { status: 'running', attempt: 1 }, attack: { status: 'running', attempt: 1 } },
  values: 'reviewing', next: ['review'], tasks: reviewWait, section: pendingRecord(RUN_ATTACK_LIVE), live: runningRecord(RUN_ATTACK_LIVE),
}

// The review decided (approved, so the review node reads `succeeded`) and the controller waits for the still-running pass: the
// attack node is the only running step, yet the run is still in its review step, so the review keeps the focus (decisions L9,
// the run 003 P1). `next` names the approval, which depends on both review and attack and cannot start until the pass ends.
const WAITING: Fixture = {
  ...LIVE, runId: RUN_ATTACK_WAITING, reviewed: true,
  events: [...workRows, started, approved],
  states: { ...verifiedStates, review: done(), attack: { status: 'running', attempt: 1 } },
  next: ['approval'], tasks: [],
  section: pendingRecord(RUN_ATTACK_WAITING), live: runningRecord(RUN_ATTACK_WAITING),
}

const BLOCKED: Fixture = {
  runId: RUN_ATTACK_BLOCKED, attack: true, status: 'failed',
  events: [...workRows, started, ['10:52:00', 'review', 'blocked', 'Independent reviewer blocked the candidate'], ['10:58:10', 'attack', 'succeeded', 'Attack pass: 2 finding(s), 1 reproduced, 1 verified']],
  states: { ...verifiedStates, review: { status: 'failed', attempt: 1 }, attack: done() },
  values: 'reviewing', next: [], tasks: [], section: appendixA(RUN_ATTACK_BLOCKED), live: null,
}

const FAILED: Fixture = {
  ...VERIFIED, runId: RUN_ATTACK_FAILED,
  events: [...workRows, started, approved, ['10:51:00', 'attack', 'succeeded', 'Attack pass ended: failed'], ['10:51:05', 'integrate', 'succeeded', `Fast-forwarded to ${CANDIDATE_COMMIT}; no push performed`]],
  section: failedRecord(RUN_ATTACK_FAILED),
}

const REFUSED: Fixture = {
  ...VERIFIED, runId: RUN_ATTACK_REFUSED,
  events: [
    ...workRows, ['10:31:05', 'attack', 'interactive', 'Attack pass refused: <path> exists on this host'], ['10:31:06', 'attack', 'succeeded', 'Attack pass ended: refused'],
    approved, ['10:51:05', 'integrate', 'succeeded', `Fast-forwarded to ${CANDIDATE_COMMIT}; no push performed`],
  ],
  section: refusedRecord(RUN_ATTACK_REFUSED),
}

const INVALID: Fixture = {
  ...LIVE, runId: RUN_ATTACK_INVALID, section: null, live: null,
  invalidSection: { version: '1.0.0', run_id: RUN_ATTACK_INVALID, status: 'exploded' }, invalidLive: 'not json',
}

/** The run without its pass: the same rows minus the attack's, the graph without the node, `attack: null`. */
function plain(fixture: Fixture): Fixture {
  const states = { ...fixture.states }
  delete states.attack
  return { ...fixture, runId: plainOf(fixture.runId), attack: false, events: fixture.events.filter(([, node]) => node !== 'attack'), states, section: null, live: null }
}

const WITH_PASS: Fixture[] = [VERIFIED, PENDING, LIVE, WAITING, BLOCKED, FAILED, REFUSED, INVALID]
const FIXTURES: Fixture[] = [...WITH_PASS, ...[VERIFIED, PENDING, LIVE, WAITING, BLOCKED].map(plain)]

/** The graph of a run: the two lanes, then `attack` right after `review` with its depends_on, and `approval` on both. */
export function attackNodes(attack: boolean): DefinitionNode[] {
  const nodes = laneGraphNodes(LANES)
  if (!attack) return nodes
  return nodes.flatMap(node => node.node_id === 'review' ? [node, ATTACK_NODE]
    : node.node_id === 'approval' ? [{ ...node, depends_on: ['review', ATTACK_NODE.node_id] }] : [node])
}

const definitions = new Map<boolean, WorkflowDefinition>()
function definitionOf(fixture: Fixture): WorkflowDefinition {
  if (!definitions.has(fixture.attack)) definitions.set(fixture.attack, definition(PROJECT.project_id, UX_ATTACK_WORKFLOW_ID, UX_ATTACK_WORKFLOW_NAME, attackNodes(fixture.attack)))
  return definitions.get(fixture.attack)!
}
/** The workflow's current definition: two lanes with an attack pass. */
export const UX_ATTACK_DEFINITION = definitionOf(VERIFIED)

const createdAt = (fixture: Fixture) => at(fixture.events[0][0])
const updatedAt = (fixture: Fixture) => at(fixture.events.at(-1)![0])
const records = (fixture: Fixture): InternalEvent[] => fixture.events.map(([clock, node, status, message], index) => ({ sequence: index + 1, time: at(clock), node, status, message }))

// The adapter's projection of the raw rows for the worker-phase mock (as `normalizeEvents` serves them): a lane's rows on its
// launch node, `freeze` on the handoff, `candidate_<lane>` on the candidate, the attack's on its own node.
const EVENT_STATUS: Record<string, WorkflowEvent['status']> = {
  running: 'running', interactive: 'running', blocked: 'failed', succeeded: 'succeeded', passed: 'succeeded', approved: 'succeeded', paused: 'paused', interrupted: 'paused',
}
const OWN_ATTEMPT = /^Attempt (\d+)\b/

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
const servedRecord = (fixture: Fixture): AttackResult | null => fixture.live ? served(fixture.live, 'live') : fixture.section ? served(fixture.section, 'export') : null

/** What the attack route serves for each run in the worker phase (the live file over the export section). */
export const ATTACK_RESULTS: Record<string, AttackResult> = Object.fromEntries(FIXTURES.flatMap(fixture => {
  const result = servedRecord(fixture)
  return result ? [[fixture.runId, result]] : []
}))

/** The live record of `attack-live` once its skeptic ended: A-1 verified, the pass succeeded (the attack-live scenario's next poll). */
export function resultAfterSkeptic(): AttackResult {
  return served(finishedRecord(RUN_ATTACK_LIVE), 'live')
}

const payloads: Partial<UxPayloads> = {
  workflows: [UX_ATTACK_DEFINITION],
  runDetails: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, detailOf(fixture)])),
  runEvents: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, servedEvents(fixture)])),
  workerResults: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, Object.fromEntries(PACKETS.map(packet => [resultKey(packet), packetResult(fixture.runId, packet)]))])),
  artifactFiles: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, LANES.flatMap(lane => ARTIFACTS[lane])])),
  attackResults: ATTACK_RESULTS,
}

function seed({ repository, runsRoot, writeRun, writePacket, receipt }: SeedContext) {
  const root = runsRoot(UX_ATTACK_WORKFLOW_ID)
  for (const fixture of FIXTURES) {
    const runDir = `${root}/${fixture.runId}`
    writeRun(root, repository, fixture.runId, {
      createdAt: createdAt(fixture), updatedAt: updatedAt(fixture), definitionNodes: attackNodes(fixture.attack), definitionName: UX_ATTACK_WORKFLOW_NAME,
      version: '1.8.0', lanes: LANES,
      values: {
        lanes: Object.fromEntries(LANES.map(lane => [lane, receipt(lane, runDir, SESSIONS[lane], at(lane === 'ui' ? '10:00:01' : '10:00:00'))])),
        snapshots: Object.fromEntries(LANES.map(lane => [lane, SNAPSHOTS[lane]])),
        packets: Object.fromEntries(LANES.map(lane => [lane, `verification/worker/${lane}/1/packet.json`])),
        bundle: { run_id: fixture.runId, base_commit: BASE_COMMIT, candidate_commit: CANDIDATE_COMMIT, policy_sha256: 'e'.repeat(64) },
        ...(fixture.values === 'integrated' || fixture.reviewed ? {
          review: { run_id: fixture.runId, verdict: 'approved', independent: true, reviewer: REVIEWER_SESSION, findings: [] },
        } : {}),
        ...(fixture.values === 'integrated' ? { approved_bundle: BUNDLE, integrated_commit: CANDIDATE_COMMIT } : {}),
      },
      next: fixture.next,
      tasks: fixture.tasks,
      events: records(fixture),
      packets: directory => PACKETS.map(packet => writePacket(directory, packet.phase, packet.lane, 1, packetResult(fixture.runId, packet), ARTIFACTS[packet.lane], { status: 'passed', reasons: [] })),
      review: null,
      inputs: null,
      sidecar: null,
      attack: fixture.invalidSection ?? fixture.section,
      ...(fixture.live ? { attackFile: fixture.live } : fixture.invalidLive !== undefined ? { attackFile: fixture.invalidLive } : {}),
    })
  }
  return { workflows: [{ workflow_id: UX_ATTACK_WORKFLOW_ID, runs_root: root, definition: { name: UX_ATTACK_WORKFLOW_NAME, nodes: UX_ATTACK_DEFINITION.nodes } }] }
}

export const uxAttack: UxFixtureModule = { payloads, seed }
