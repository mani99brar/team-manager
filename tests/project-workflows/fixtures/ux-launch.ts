/**
 * Fixtures of viewer UX slice S4b, the launch node (`ux-launch.spec.ts`) (docs/PRD_VIEWER_UX.md 12.2), registered as
 * the workflow `ux-launch`: mock payloads for the worker phase and a `seed` for the candidate phase, merged by
 * `index.ts`. Each run is written once as the controller's own records, like `ux-node.ts`.
 *
 * - `launch-repaired`: a manual one-lane run with many files. The worker froze 41 changed files (40 captured, one binary);
 *   verification failed twice, the operator's repair 1 changed `vitest.config.ts` and added `tests/reporters/testSummary.ts`,
 *   and attempt 3 passed. The review approved with findings naming three of the files, and the run awaits approval. The
 *   worker's own freeze is `results/ui/1`; the launch node links the latest result, `results/ui/3`, whose summary extends
 *   the worker's report with the operator's note, as the controller writes it.
 * - `launch-asking`: an automatic run whose ui worker is still running and waits on its second question.
 */
import type { ReviewResult, RunDetail, WorkflowDefinition } from '../../../contracts/projects/v1.ts'
import { eventSchema, validateWorkerResult, type WorkerResult, type WorkflowEvent } from '../../../contracts/workflow/v1.ts'
import {
  BASE_COMMIT, CANDIDATE_COMMIT, DEFAULT_REVIEWER_ID, OUTPUT_COMMIT_UI, PATH_TOKEN, PROJECT, REVIEWER_SESSION, UI_ARTIFACTS, UI_CHECKS, UI_SESSION,
  artifactRefs, backgroundId, checks, definition, laneGraphNodes, launchToken, offset, projectInputs, projectReview, runDetail, sha256, uiTask,
  type ArtifactFile, type NodeState, type RawInputsSection, type RawQuestion, type RawReviewSection, type RawWorkerInput,
} from '../fixtures.ts'
import type { InternalEvent, SeedContext } from '../seed.ts'
import type { UxFixtureModule, UxPayloads } from './index.ts'

export const UX_LAUNCH_WORKFLOW_ID = 'ux-launch'
export const UX_LAUNCH_WORKFLOW_NAME = 'UX launch'
export const RUN_LAUNCH_REPAIRED = 'launch-repaired'
export const RUN_LAUNCH_ASKING = 'launch-asking'

/** What the worker reported: long enough to be clamped to three lines. */
export const LAUNCH_SUMMARY = 'Built the race room and its client: a MatchRoom with private join codes and a 60 Hz fixed timestep, an input gate '
  + 'that drops malformed, stale and over-rate input, a seeded simulation with integer state, the Phaser client with its HUD and '
  + 'keyboard adapter, and the headless test client. Checks I ran: typecheck, unit (70 tests), integration (8 tests), build and the '
  + 'browser scenarios, all passed in a fresh copy of the tree with an empty cache. Nothing is committed: the task forbids commits.'
/** What the latest result adds to the report: the operator's repair note, which the viewer shows as the verifier note. */
export const REPAIR_SUMMARY_NOTE = 'Operator repair 1: the verifier parses only Node TAP summaries, so a reporter now prints the test counts in that form '
  + '(files tests/reporters/testSummary.ts, vitest.config.ts).'
export const LAUNCH_UNTESTED = ['Rematch after a disconnect', 'Two matches on one server process']
export const LAUNCH_VERIFY_YOURSELF = 'That a join with an unknown code is refused before the room is created.'
export const LAUNCH_ASSUMPTIONS = [
  'The 60 Hz clock uses Room.setFixedTimestep.',
  'Join refusals use HTTP status codes.',
  'Movement axes outside [-1, 1] are rejected, not clamped.',
]

// ---- Files: the worker's freeze and the repair ----------------------------------------------------------------------

const FOLDERS: [folder: string, names: string[], extension: string][] = [
  ['src/game/', ['room', 'inputGate', 'simulation', 'spawn', 'state', 'clock', 'hash', 'rng', 'match', 'codes'], '.ts'],
  ['src/net/', ['client', 'protocol', 'snapshot', 'interpolate', 'sender', 'schema', 'join', 'errors'], '.ts'],
  ['src/ui/', ['Hud', 'Landing', 'Keyboard', 'Scene', 'Ship', 'Sea', 'Timer', 'Results'], '.tsx'],
  ['tests/', ['room', 'inputGate', 'simulation', 'hash', 'join', 'snapshot', 'client', 'headless'], '.test.ts'],
]
/** The captured Markdown file the spec opens: it starts closed and opens on Rendered. */
export const LAUNCH_README_PATH = 'README.md'
export const LAUNCH_ARCHITECTURE_PATH = 'docs/ARCHITECTURE.md'
/** The file a P1 finding names with lines 44–50. */
export const LAUNCH_ROOM_PATH = 'src/game/room.ts'
export const LAUNCH_PROTOCOL_PATH = 'src/net/protocol.ts'
/** Changed by the operator's repair 1, and added by it. */
export const LAUNCH_REPAIRED_PATH = 'vitest.config.ts'
export const LAUNCH_ADDED_PATH = 'tests/reporters/testSummary.ts'
export const LAUNCH_BINARY_PATH = 'assets/ship.png'

const MARKDOWN: Record<string, string> = {
  [LAUNCH_README_PATH]: '# Pirate race\n\nA walking skeleton of the race.\n\n## Commands\n\n- `npm test` runs the unit tests.\n',
  [LAUNCH_ARCHITECTURE_PATH]: '# Architecture\n\nOne room per private match.\n',
  'docs/PROTOCOL.md': '# Protocol\n\nJoin and input schemas.\n',
  'docs/CONTENT.md': '# Content\n\nSea map and spawn slots.\n',
}
/** Every path the worker froze, in the order its result lists them. */
export const LAUNCH_FROZEN_PATHS = [
  LAUNCH_README_PATH,
  ...FOLDERS.flatMap(([folder, names, extension]) => names.map(name => `${folder}${name}${extension}`)),
  LAUNCH_ARCHITECTURE_PATH, 'docs/PROTOCOL.md', 'docs/CONTENT.md',
  'package.json', LAUNCH_REPAIRED_PATH,
  LAUNCH_BINARY_PATH,
]
const sourceOf = (path: string, version = 1) => MARKDOWN[path]
  ?? Array.from({ length: path === LAUNCH_ROOM_PATH ? 60 : 12 }, (_, index) => `// ${path} line ${index + 1}${version > 1 ? ' (repaired)' : ''}`).join('\n') + '\n'

function fileArtifact(index: number, path: string, content: string): ArtifactFile {
  return { artifact_id: `file-${index}-${sha256(content).slice(0, 12)}`, kind: 'file', path, content: Buffer.from(content, 'utf8'), contentType: 'text/plain; charset=utf-8' }
}
const captured = LAUNCH_FROZEN_PATHS.filter(path => path !== LAUNCH_BINARY_PATH)
/** The files the worker's freeze captured (`results/ui/1` and `/2`). */
const FROZEN_FILES = captured.map((path, index) => fileArtifact(index, path, sourceOf(path)))
/** The repaired snapshot's files (`results/ui/3`): one file changed, one added. */
const REPAIRED_FILES = [
  ...captured.map((path, index) => fileArtifact(index, path, sourceOf(path, path === LAUNCH_REPAIRED_PATH ? 2 : 1))),
  fileArtifact(captured.length, LAUNCH_ADDED_PATH, sourceOf(LAUNCH_ADDED_PATH, 2)),
]
const LOGS = UI_ARTIFACTS.filter(file => file.kind === 'log')
/** Every artifact the run serves: the check logs and both versions of the files, ids unique by content. */
const ALL_ARTIFACTS = [...LOGS, ...new Map([...FROZEN_FILES, ...REPAIRED_FILES].map(file => [file.artifact_id, file])).values()]

// ---- Findings -------------------------------------------------------------------------------------------------------

export const LAUNCH_P1_FINDING = `${LAUNCH_ROOM_PATH}:44-50 accepts a join before the protocol version is checked.`
export const LAUNCH_ARCHITECTURE_FINDING = `${LAUNCH_ARCHITECTURE_PATH} does not name the tick rate.`
export const LAUNCH_PROTOCOL_FINDING = `${LAUNCH_PROTOCOL_PATH} drops stale frames without counting them.`
/** The paths the review names, in the order the files list puts them: the P1 first, then the P2s in the freeze's order. */
export const LAUNCH_FINDING_PATHS = [LAUNCH_ROOM_PATH, LAUNCH_PROTOCOL_PATH, LAUNCH_ARCHITECTURE_PATH]

const DAY = '2026-03-04'
const CREATED_AT = `${DAY}T09:00:00Z`
const at = (clock: string) => `${DAY}T${clock}Z`
/** Where a message names the run directory: `<path>` once served, the real directory in the candidate phase's raw rows. */
const RUN_DIR = '{run}'
export const LAUNCH_REPAIRED_COMMIT = '5c1a734e0f6b1f0d3f1b6b0f6a8d8a1b2c3d4e5f'
const VERIFY_FAILURE = 'frontend-unit: no passing test evidence or failed tests'

const REVIEW: RawReviewSection = {
  attempt: 1, transport: 'native', reviewer_session_id: REVIEWER_SESSION, independent: true, bundle_sha256: '5d'.repeat(32), candidate_commit: CANDIDATE_COMMIT,
  verdict: 'approved',
  findings: [
    { severity: 'P2', message: LAUNCH_ARCHITECTURE_FINDING, disposition: 'open', worker: 'ui', requirement: null, reviewer: DEFAULT_REVIEWER_ID },
    { severity: 'P1', message: LAUNCH_P1_FINDING, disposition: 'resolved', worker: 'ui', requirement: null, reviewer: DEFAULT_REVIEWER_ID },
    { severity: 'P2', message: LAUNCH_PROTOCOL_FINDING, disposition: 'accepted', worker: 'ui', requirement: null, reviewer: DEFAULT_REVIEWER_ID },
    { severity: 'P2', message: 'The HUD has no reduced-motion variant.', disposition: 'open', worker: 'ui', requirement: null, reviewer: DEFAULT_REVIEWER_ID },
  ],
  reviewed_at: offset(at('09:44:30')), diff: null,
}

// ---- Runs -----------------------------------------------------------------------------------------------------------

export const LAUNCH_QUESTIONS: RawQuestion[] = [
  { n: 1, question: 'May the room keep the join code after a rematch?', asked_at: '2026-03-04T09:20:00Z', answer: 'Yes, keep it.', answered_at: '2026-03-04T09:22:00Z' },
  { n: 2, question: 'Keep the seed on rematch, or reroll it?', asked_at: '2026-03-04T09:40:00Z', answer: null, answered_at: null },
]

type Row = [clock: string, node: string, status: string, message: string]
type Packet = { phase: 'worker' | 'candidate'; attempt: number; from: string; to: string; failure?: string }
type Task = { node_id: string; error: string | null; interrupts: object[]; result: object | null }
type Fixture = {
  runId: string
  status: RunDetail['summary']['status']
  mode: 'automatic' | 'manual'
  rows: Row[]
  states: Record<string, NodeState>
  packets: Packet[]
  /** Whether the export holds the frozen snapshot and verified packet, and the reviewed bundle with its review. */
  values: { snapshots?: boolean; review?: boolean }
  next: string[]
  tasks: Task[]
  review: RawReviewSection | null
  worker: Pick<RawWorkerInput, 'launch' | 'completion' | 'handoff' | 'stop' | 'questions'>
}

const LAUNCHING = 'Launching or reconciling the exact native session'
const AWAITING = 'Awaiting explicit completion signal; idle is not acceptance'
const REPAIR_NOTE = 'Repair 1 by the operator: snapshot 5c1a734e = abcdef12 + b27d726a on snapshot abcdef12 (tests/reporters/testSummary.ts, vitest.config.ts). '
  + `Reason: The verifier parses only Node TAP summaries. Answers worker/ui attempt 2: ${VERIFY_FAILURE}. Continue with python -m workflow retry ${RUN_DIR}`
const asked = (clock: string, question: RawQuestion): Row => [clock, 'ui', 'interactive',
  `Worker ui asked question ${question.n} of 3; its deadline is paused until \`python -m workflow answer ${RUN_DIR} ui "<text>"\`: ${question.question}`]

const launchReceipt = (observed: string): NonNullable<RawWorkerInput['launch']> => ({
  session_id: UI_SESSION, launch_token: launchToken('ui'), launch_requested_at: offset(at('09:00:08')), native_started_at: Date.parse(at('09:00:10')),
  observed_state: observed, status: 'attached_session_available', launcher_invocations: 1, background_id: backgroundId('ui'),
})

const FIXTURES: Fixture[] = [
  {
    runId: RUN_LAUNCH_REPAIRED, status: 'awaiting_approval', mode: 'manual',
    rows: [
      ['09:00:10', 'ui', 'running', LAUNCHING],
      ['09:00:14', 'ui', 'running', AWAITING],
      ['09:28:21', 'freeze', 'stopped', 'Native workers stopped before snapshot capture: ui'],
      ['09:28:21', 'freeze', 'succeeded', 'Immutable snapshots captured; worker-reported checks are not trusted'],
      ['09:28:21', 'verify_ui', 'running', `Attempt 1; revision ${OUTPUT_COMMIT_UI}`],
      ['09:29:28', 'verify_ui', 'blocked', VERIFY_FAILURE],
      ['09:30:00', 'verify_ui', 'running', `Attempt 2; revision ${OUTPUT_COMMIT_UI}`],
      ['09:31:07', 'verify_ui', 'blocked', VERIFY_FAILURE],
      ['09:35:00', 'verify_ui', 'paused', REPAIR_NOTE],
      ['09:35:00', 'controller', 'running', 'Repair 1 applied: checkpoint forked from 1f1b7f90 (after handoff); attempts worker:ui 3'],
      ['09:35:10', 'verify_ui', 'running', `Attempt 3; revision ${LAUNCH_REPAIRED_COMMIT}`],
      ['09:36:20', 'verify_ui', 'succeeded', 'Required tests and artifacts passed; recorded for the candidate gate: frontend-build, project-workflows-browser'],
      ['09:39:00', 'candidate_ui', 'succeeded', `Combined revision ${CANDIDATE_COMMIT}`],
      ['09:39:02', 'review', 'running', 'Launching reviewer review over the shared review worktree'],
      ['09:44:30', 'review', 'approved', 'Independent reviewer approved the candidate'],
    ],
    states: {
      launch_ui: { status: 'succeeded', attempt: 1, session: UI_SESSION, result: 'ui' },
      handoff: { status: 'succeeded', attempt: 1 },
      verify_ui: { status: 'succeeded', attempt: 3, session: UI_SESSION, result: 'ui' },
      candidate: { status: 'succeeded', attempt: 1, lanes: [{ worker: 'ui', attempt: 1 }] },
      review: { status: 'succeeded', attempt: 1, session: REVIEWER_SESSION, review: 1 },
      approval: { status: 'awaiting_approval', attempt: 1 },
    },
    packets: [
      { phase: 'worker', attempt: 1, from: '09:28:25', to: '09:29:25', failure: VERIFY_FAILURE },
      { phase: 'worker', attempt: 2, from: '09:30:05', to: '09:31:05', failure: VERIFY_FAILURE },
      { phase: 'worker', attempt: 3, from: '09:35:15', to: '09:36:15' },
      { phase: 'candidate', attempt: 1, from: '09:36:30', to: '09:38:55' },
    ],
    values: { snapshots: true, review: true },
    next: ['approval'],
    tasks: [{ node_id: 'approval', error: null, interrupts: [{ kind: 'integration_approval', message: 'Integration requires explicit approval of the reviewed bundle.' }], result: null }],
    review: REVIEW,
    worker: {
      launch: launchReceipt('done'),
      completion: {
        version: '1.1.0', status: 'completed', summary: LAUNCH_SUMMARY, open_assumptions: LAUNCH_ASSUMPTIONS,
        untested: LAUNCH_UNTESTED, falsifying_check: 'project-workflows-browser', verify_yourself: LAUNCH_VERIFY_YOURSELF, question: null,
      },
      handoff: { summary: LAUNCH_SUMMARY, open_assumptions: LAUNCH_ASSUMPTIONS },
      stop: { stopped: true, confirmed_at: offset(at('09:28:21')) },
      questions: [LAUNCH_QUESTIONS[0]],
    },
  },
  {
    runId: RUN_LAUNCH_ASKING, status: 'running', mode: 'automatic',
    rows: [
      ['09:00:10', 'ui', 'running', LAUNCHING],
      ['09:00:14', 'ui', 'running', AWAITING],
      ['09:00:16', 'controller', 'running', 'Automatic checkpoint controller PID 7301'],
      asked('09:20:00', LAUNCH_QUESTIONS[0]),
      ['09:22:00', 'ui', 'interactive', 'Worker ui question 1 answered; its deadline runs again'],
      asked('09:40:00', LAUNCH_QUESTIONS[1]),
    ],
    states: { launch_ui: { status: 'running', attempt: 1, session: UI_SESSION } },
    packets: [],
    values: {},
    next: ['handoff'],
    tasks: [{ node_id: 'handoff', error: null, interrupts: [{ kind: 'worker_handoff', message: 'Awaiting explicit completion signals and automatic freeze.' }], result: null }],
    review: null,
    worker: { launch: launchReceipt('working'), completion: null, handoff: null, stop: null, questions: LAUNCH_QUESTIONS },
  },
]

const NODES = laneGraphNodes(['ui'])
const DEFINITION: WorkflowDefinition = definition(PROJECT.project_id, UX_LAUNCH_WORKFLOW_ID, UX_LAUNCH_WORKFLOW_NAME, NODES)
const records = (fixture: Fixture): InternalEvent[] => fixture.rows.map(([clock, node, status, message], index) => ({ sequence: index + 1, time: at(clock), node, status, message }))
const updatedAt = (fixture: Fixture) => at(fixture.rows.at(-1)![0])
const latestWorkerAttempt = (fixture: Fixture) => Math.max(0, ...fixture.packets.filter(packet => packet.phase === 'worker').map(packet => packet.attempt))

/** A verification packet's result: the freeze's files on attempts 1 and 2, the repaired snapshot's on 3; none at the candidate. */
function packetResult(runId: string, packet: Packet): WorkerResult {
  const commands = ['npm run build', 'npm run test:unit', 'npx --no-install playwright test --config=tests/project-workflows/playwright.config.ts']
  const start = Date.parse(at(packet.from))
  const step = (Date.parse(at(packet.to)) - start) / commands.length
  const time = (index: number) => new Date(start + Math.round(step * index)).toISOString().replace(/\.000Z$/, 'Z')
  const worker = packet.phase === 'worker'
  const repaired = worker && packet.attempt === 3
  return validateWorkerResult({
    contract_version: '1.0.0', run_id: runId, node_id: 'ui', attempt: packet.attempt, session_id: UI_SESSION,
    status: packet.failure ? 'failed' : 'succeeded', base_commit: BASE_COMMIT,
    output_commit: !worker ? CANDIDATE_COMMIT : repaired ? LAUNCH_REPAIRED_COMMIT : OUTPUT_COMMIT_UI,
    changed_files: repaired ? [...LAUNCH_FROZEN_PATHS, LAUNCH_ADDED_PATH] : LAUNCH_FROZEN_PATHS,
    checks: checks(`verification/${packet.phase}/ui/${packet.attempt}/worktree`, commands.map((command, index) => ({ command, log: LOGS[index].artifact_id, exit: 0, start: time(index), finish: time(index + 1) }))),
    open_assumptions: LAUNCH_ASSUMPTIONS,
    artifacts: artifactRefs(packetFiles(packet)),
    summary: repaired ? `${LAUNCH_SUMMARY}\n\n${REPAIR_SUMMARY_NOTE}` : LAUNCH_SUMMARY,
    error: packet.failure ? { code: 'VERIFICATION_BLOCKED', message: packet.failure, retryable: true } : null,
    ...(worker ? { files_not_captured: [{ path: LAUNCH_BINARY_PATH, reason: 'binary' as const }] } : {}),
  })
}
const resultKey = (packet: Packet) => `${packet.phase === 'candidate' ? 'candidate_ui' : 'ui'}/${packet.attempt}`
function packetFiles(packet: Packet): ArtifactFile[] {
  if (packet.phase === 'candidate') return LOGS
  return [...LOGS, ...(packet.attempt === 3 ? REPAIRED_FILES : FROZEN_FILES)]
}

function inputsSection(fixture: Fixture, leak: string): RawInputsSection {
  return {
    feature: 'Launch page', policy_version: '1.2.0', base_commit: BASE_COMMIT, source_branch: `feature/${UX_LAUNCH_WORKFLOW_ID}/${fixture.runId}`,
    mode: fixture.mode,
    automatic: fixture.mode === 'manual' ? null : {
      finish: 'verified-feature-branch', permission_mode: 'bypassPermissions', worker_timeout_seconds: 7200, review_timeout_seconds: 1800, reviewer_transport: 'native',
    },
    setup: [{ argv: ['npm', 'ci'], command: 'npm ci', timeout_seconds: 600 }],
    max_verification_attempts: 3,
    failure_drill: null,
    selected_workers: ['ui'],
    excluded_workers: [],
    workers: {
      ui: { role: 'frontend', required_check_kinds: ['build', 'browser'], task: uiTask(leak), prompt: null, owned_paths: ['src', 'tests', 'docs'], checks: UI_CHECKS, ...fixture.worker },
    },
  }
}

// The adapter's projection of the raw rows for the worker-phase mock, as the server serves them since B1 (see `ux-node.ts`).
const EVENT_STATUS: Record<string, WorkflowEvent['status']> = {
  running: 'running', interactive: 'running', blocked: 'failed', succeeded: 'succeeded', approved: 'succeeded', paused: 'paused',
}

function servedEvents(fixture: Fixture): WorkflowEvent[] {
  const known = new Set(NODES.map(node => node.node_id))
  const nodeOf = (node: string) => known.has(node) ? node : node === 'freeze' ? 'handoff' : node === 'ui' ? 'launch_ui' : node === 'candidate_ui' ? 'candidate' : null
  const attempts = new Map<string, number>()
  return records(fixture).map(record => {
    const node_id = nodeOf(record.node)
    let attempt = 0
    if (node_id) {
      const parsed = /^Attempt (\d+)\b/.exec(record.message)
      if (parsed) attempts.set(node_id, Number(parsed[1]))
      attempt = attempts.get(node_id) ?? 1
    }
    const status = node_id || record.node === 'controller' ? EVENT_STATUS[record.status] ?? null : null
    return eventSchema.parse({
      contract_version: '1.0.0', run_id: fixture.runId, event_id: `${fixture.runId}:${record.sequence}`, sequence: record.sequence, occurred_at: record.time,
      node_id, attempt, type: node_id && status ? 'status_changed' : 'log', status, message: record.message.replaceAll(RUN_DIR, PATH_TOKEN),
      artifact: null, result_uri: null, reused_from_attempt: null,
    })
  })
}

function servedDetail(fixture: Fixture): RunDetail {
  const detail = runDetail(fixture.runId, fixture.status, DEFINITION, CREATED_AT, updatedAt(fixture), fixture.states, fixture.rows.length)
  // The adapter links the launch node to the lane's latest worker packet, the one the verify node shows.
  const launch = detail.snapshot.nodes.find(node => node.node_id === 'launch_ui')!
  if (launch.result_uri !== null) launch.result_uri = launch.result_uri.replace(/\/\d+$/, `/${latestWorkerAttempt(fixture)}`)
  return detail
}

const taskTexts = (fixture: Fixture) => ({ ui: inputsSection(fixture, PATH_TOKEN).workers.ui.task })

const payloads: UxPayloads = {
  workflows: [DEFINITION],
  runDetails: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, servedDetail(fixture)])),
  runEvents: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, servedEvents(fixture)])),
  workerResults: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, Object.fromEntries(fixture.packets.map(packet => [resultKey(packet), packetResult(fixture.runId, packet)]))])),
  reviewResults: Object.fromEntries(FIXTURES.flatMap((fixture): [string, ReviewResult][] => fixture.review
    ? [[fixture.runId, projectReview(fixture.runId, fixture.review, taskTexts(fixture), UX_LAUNCH_WORKFLOW_ID)]] : [])),
  runInputs: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, projectInputs(fixture.runId, inputsSection(fixture, PATH_TOKEN))])),
  artifactFiles: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, fixture.packets.length ? ALL_ARTIFACTS : []])),
}

function seed({ repository, runsRoot, writeRun, writePacket, receipt, leakFor }: SeedContext) {
  const root = runsRoot(UX_LAUNCH_WORKFLOW_ID)
  for (const fixture of FIXTURES) {
    const runDir = `${root}/${fixture.runId}`
    writeRun(root, repository, fixture.runId, {
      createdAt: CREATED_AT, updatedAt: updatedAt(fixture), definitionNodes: NODES, definitionName: UX_LAUNCH_WORKFLOW_NAME, version: '1.5.0', lanes: ['ui'],
      values: {
        lanes: { ui: receipt('ui', runDir, UI_SESSION, at('09:00:08')) },
        ...(fixture.values.snapshots ? { snapshots: { ui: LAUNCH_REPAIRED_COMMIT }, packets: { ui: `verification/worker/ui/${latestWorkerAttempt(fixture)}/packet.json` } } : {}),
        ...(fixture.values.review ? {
          bundle: { run_id: fixture.runId, base_commit: BASE_COMMIT, candidate_commit: CANDIDATE_COMMIT, policy_sha256: 'e'.repeat(64) },
          review: { run_id: fixture.runId, verdict: 'approved', independent: true, reviewer: 'synthetic-reviewer', findings: [] },
        } : {}),
      },
      next: fixture.next,
      tasks: fixture.tasks,
      events: records(fixture).map(record => ({ ...record, message: record.message.replaceAll(RUN_DIR, runDir) })),
      packets: directory => fixture.packets.map(packet => writePacket(directory, packet.phase, 'ui', packet.attempt, packetResult(fixture.runId, packet), packetFiles(packet),
        packet.failure ? { status: 'blocked', reasons: packet.failure.split('; ') } : { status: 'passed', reasons: [] })),
      review: fixture.review,
      inputs: inputsSection(fixture, leakFor(root, fixture.runId)),
    })
  }
  return { workflows: [{ workflow_id: UX_LAUNCH_WORKFLOW_ID, runs_root: root, definition: { name: UX_LAUNCH_WORKFLOW_NAME, nodes: NODES } }] }
}

export const uxLaunch: UxFixtureModule = { payloads, seed }
