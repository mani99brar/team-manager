/**
 * Fixtures of the Projects viewer revamp, lane `pages` (docs/PRD_VIEWER_REVAMP.md sections 5.3-5.5 and 7, `revamp-pages.spec.ts`),
 * registered by `index.ts` as the workflow `revamp-pages` of `alpha-project`: mock payloads for the worker phase and a `seed`
 * for the candidate phase. Every run is a 1.5.0 export of a guarded two-lane graph (the design challenge first), written once as
 * the controller's own records, the way `ux-review.ts` writes its runs. The finished runs are dated 2026-03-11 and 2026-03-12,
 * before 2026-03-13, so the `runs-home` rows (clock 2026-03-20) stay at the top of Recent; the spec fixes its clock just after.
 * - `revamp-done` (succeeded): the challenge passed, both lanes verified, `general` and `coverage` approved with mixed P1/P2
 *   findings over both lanes (the P1 resolved), the integration fast-forwarded the branch.
 * - `revamp-blocked` (failed): `coverage` blocked the candidate with an open P1 on ui and a P2 on adapter while `general`
 *   approved with a P2 on each lane (the adapter one accepted): two reviewers, P1/P2 over both lanes, one blocking card.
 * - `revamp-running` (running): both workers run; adapter asked question 1, which waits on the operator.
 * Lane and reviewer ids (`ui`, `adapter`, `general`, `coverage`) hold no word `expectNoExecutionControls` refuses.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateRunDetail, type ReviewResult, type RunActivity, type RunDetail, type RunInputs, type WorkflowDefinition } from '../../../contracts/projects/v1.ts'
import { eventSchema, validateWorkerResult, type WorkerResult, type WorkflowEvent } from '../../../contracts/workflow/v1.ts'
import {
  ADAPTER_ARTIFACTS, ADAPTER_CHANGED_FILES, ADAPTER_CHECKS, ADAPTER_SESSION, BASE_COMMIT, CANDIDATE_COMMIT, CHALLENGE_NODE, COVERAGE_REVIEWER_SESSION,
  GENERAL_REVIEWER_SESSION, OUTPUT_COMMIT_ADAPTER, OUTPUT_COMMIT_UI, PATH_TOKEN, PROJECT, UI_ARTIFACTS, UI_CHANGED_FILES, UI_CHECKS, UI_QUOTE,
  UI_SESSION, adapterTask, artifactRefs, backgroundId, checks, definition, laneGraphNodes, launchToken, offset, projectInputs, projectReview, runDetail,
  sha256, uiTask,
  type ArtifactFile, type DefinitionNode, type NodeState, type RawChallenge, type RawFinding, type RawInputsSection, type RawQuestion, type RawReviewSection,
  type RawWorkerInput,
} from '../fixtures.ts'
import type { InternalEvent, SeedContext } from '../seed.ts'
import type { UxFixtureModule, UxPayloads } from './index.ts'

export const REVAMP_PAGES_WORKFLOW_ID = 'revamp-pages'
export const REVAMP_PAGES_WORKFLOW_NAME = 'Revamp pages'
export const REVAMP_FEATURE = 'Operator desk pages'
export const RUN_REVAMP_DONE = 'revamp-done'
export const RUN_REVAMP_BLOCKED = 'revamp-blocked'
export const RUN_REVAMP_RUNNING = 'revamp-running'
/** The instant the spec fixes the page clock at: just after every run of this module. */
export const REVAMP_NOW = '2026-03-12T12:00:00Z'

export const REVAMP_CHALLENGE_SESSION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
/** adapter's question on `revamp-running`, waiting on the operator. */
export const REVAMP_QUESTION = 'Should the findings filter remember the pressed reviewers across nodes?'

/** The findings of `revamp-blocked`, in record order (general's, then coverage's). */
export const BLOCKED_FINDINGS = {
  generalUi: 'The phase headers repeat the row count the list already shows.',
  generalAdapter: 'The adapter serves the reviewer list twice.',
  coverageUi: 'Private matches can be joined without their code.',
  coverageAdapter: 'The match list polls every second.',
} as const
/** The findings of `revamp-done`, in record order. */
export const DONE_FINDINGS = {
  generalUi: 'The run header rule is the only place the tone shows on a phone.',
  coverageUi: 'No browser test reads the Pipeline and Steps side by side.',
  coverageAdapter: 'The adapter test never serves an empty lane list.',
} as const

type Lane = 'ui' | 'adapter'
type Row = [clock: string, node: string, status: string, message: string]
type Task = { node_id: string; error: string | null; interrupts: object[]; result: object | null }
type Packet = { phase: 'worker' | 'candidate'; lane: Lane; attempt: number; from: string; to: string }

type Fixture = {
  runId: string
  day: string
  status: RunDetail['summary']['status']
  events: Row[]
  /** The snapshot the adapter projects from these records, for the worker-phase mock. */
  states: Record<string, NodeState>
  packets: Packet[]
  /** Graph values: `launched` (receipts), `verified` (snapshots, packets and the bundle), `integrated` (review, approval, commit). */
  values: 'launched' | 'verified' | 'integrated'
  next: string[]
  tasks: Task[]
  challenge: RawChallenge
  /** Workers finished (their completions and stops are recorded). */
  finished: boolean
  review?: RawReviewSection
  /** The export's questions per lane; the live `<lane>.questions.json` holds the same while the run waits. */
  questions?: Partial<Record<Lane, RawQuestion[]>>
  /** The served activity (contract 1.5.0) of a live run, for the worker-phase mock. */
  activity?: RunActivity
}

const LANES: readonly Lane[] = ['ui', 'adapter']
const SESSIONS: Record<Lane, string> = { ui: UI_SESSION, adapter: ADAPTER_SESSION }
const COMMITS: Record<Lane, string> = { ui: OUTPUT_COMMIT_UI, adapter: OUTPUT_COMMIT_ADAPTER }
const ARTIFACTS: Record<Lane, ArtifactFile[]> = { ui: UI_ARTIFACTS, adapter: ADAPTER_ARTIFACTS }
const LAUNCH: Record<Lane, { requested: string; started: string }> = {
  ui: { requested: '09:02:58', started: '09:03:00' },
  adapter: { requested: '09:03:28', started: '09:03:33' },
}
const REVIEWERS = ['general', 'coverage'] as const
const JOINED_SESSIONS = `${GENERAL_REVIEWER_SESSION}, ${COVERAGE_REVIEWER_SESSION}`
const BUNDLE = 'c3'.repeat(32)
const LAUNCHING = 'Launching or reconciling the exact native session'
const AWAITING = 'Awaiting explicit completion signal; idle is not acceptance'

const challengeRows: Row[] = [
  ['09:00:00', 'challenge', 'running', `Design challenge attempt 1: one print job, session ${REVAMP_CHALLENGE_SESSION}`],
  ['09:02:40', 'challenge', 'succeeded', 'Design challenge attempt 1 passed (1 P2 concern(s)); launching workers'],
]
const launchRows: Row[] = [
  ['09:03:00', 'ui', 'running', LAUNCHING],
  ['09:03:33', 'adapter', 'running', LAUNCHING],
]
/** The freeze, both verifications and the combined candidate, all passing. */
const verifyRows: Row[] = [
  ['09:31:54', 'freeze', 'stopped', 'Native workers stopped before snapshot capture: ui, adapter'],
  ['09:31:54', 'freeze', 'succeeded', 'Immutable snapshots captured; worker-reported checks are not trusted'],
  ['09:31:55', 'verify_ui', 'running', `Attempt 1; revision ${OUTPUT_COMMIT_UI}`],
  ['09:31:55', 'verify_adapter', 'running', `Attempt 1; revision ${OUTPUT_COMMIT_ADAPTER}`],
  ['09:34:00', 'verify_adapter', 'succeeded', 'Required tests and artifacts passed; recorded for the candidate gate: backend-unit'],
  ['09:36:00', 'verify_ui', 'succeeded', 'Required tests and artifacts passed; recorded for the candidate gate: frontend-build, project-workflows-browser'],
  ['09:42:00', 'candidate_adapter', 'succeeded', `Combined revision ${CANDIDATE_COMMIT}`],
  ['09:44:00', 'candidate_ui', 'succeeded', `Combined revision ${CANDIDATE_COMMIT}`],
]
const reviewerLaunches: Row[] = REVIEWERS.map(reviewer => ['09:50:00', 'review', 'running', `Launching reviewer ${reviewer} over the shared review worktree`])
const PACKETS: Packet[] = [
  { phase: 'worker', lane: 'ui', attempt: 1, from: '09:32:00', to: '09:35:55' },
  { phase: 'worker', lane: 'adapter', attempt: 1, from: '09:32:00', to: '09:33:55' },
  { phase: 'candidate', lane: 'adapter', attempt: 1, from: '09:36:05', to: '09:41:55' },
  { phase: 'candidate', lane: 'ui', attempt: 1, from: '09:36:05', to: '09:43:55' },
]

const done = (session: string | null = null, result: string | null = null): NodeState => ({ status: 'succeeded', attempt: 1, session, result })
const verifiedStates: Record<string, NodeState> = {
  challenge: { status: 'succeeded', attempt: 1, session: REVAMP_CHALLENGE_SESSION },
  launch_ui: done(UI_SESSION, 'ui'), launch_adapter: done(ADAPTER_SESSION, 'adapter'), handoff: done(),
  verify_ui: done(UI_SESSION, 'ui'), verify_adapter: done(ADAPTER_SESSION, 'adapter'),
  candidate: { ...done(), lanes: LANES.map(lane => ({ worker: lane, attempt: 1 })) },
}

const challengeOf = (day: string): RawChallenge => ({
  status: 'passed', attempt: 1, session_id: REVAMP_CHALLENGE_SESSION,
  pinned: { tasks_sha256: sha256(`tasks-revamp-${day}`), decisions_sha256: sha256(`decisions-revamp-${day}`), prd_sha256: null },
  concerns: [{ severity: 'P2', kind: 'complexity', message: 'Two looks double the styles to review.', consequence: 'The operator compares twice.' }],
  simpler_alternative: 'Ship one look.', cheap_experiment: 'Show both looks to the operator on one run.',
  accepted_reason: null, decided_at: `${day}T09:02:40Z`, attempts: 1,
})

const finding = (reviewer: string, severity: RawFinding['severity'], message: string, disposition: RawFinding['disposition'], worker: string, requirement: string | null = null): RawFinding =>
  ({ severity, message, disposition, worker, requirement, reviewer })

function nativeReview(day: string, verdict: 'approved' | 'blocked', entries: { reviewer: string; verdict: 'approved' | 'blocked'; status: 'accepted' | 'blocked'; accepted: string; findings: RawFinding[] }[], reviewedAt: string): RawReviewSection {
  const sessions: Record<string, string> = { general: GENERAL_REVIEWER_SESSION, coverage: COVERAGE_REVIEWER_SESSION }
  return {
    attempt: 1, transport: 'native', reviewer_session_id: JOINED_SESSIONS, independent: true, bundle_sha256: BUNDLE, candidate_commit: CANDIDATE_COMMIT,
    verdict, findings: entries.flatMap(entry => entry.findings), reviewed_at: offset(`${day}T${reviewedAt}Z`), diff: null,
    reviewers: entries.map(entry => ({
      reviewer_id: entry.reviewer, transport: 'native', session_id: sessions[entry.reviewer], verdict: entry.verdict, findings: entry.findings,
      launched_at: offset(`${day}T09:50:00Z`), accepted_at: offset(`${day}T${entry.accepted}Z`), status: entry.status,
    })),
  }
}

const RUNNING_DAY = '2026-03-12'
const QUESTION_AT = '10:20:00'

const FIXTURES: Fixture[] = [
  {
    runId: RUN_REVAMP_DONE, day: '2026-03-11', status: 'succeeded', finished: true,
    events: [
      ...challengeRows, ...launchRows, ...verifyRows, ...reviewerLaunches,
      ['09:53:49', 'review', 'approved', JOINED_SESSIONS],
      ['09:53:52', 'integrate', 'succeeded', `Fast-forwarded to ${CANDIDATE_COMMIT}; no push performed`],
    ],
    states: { ...verifiedStates, review: { status: 'succeeded', attempt: 1, session: JOINED_SESSIONS, review: 1 }, approval: done(), integrate: done() },
    packets: PACKETS, values: 'integrated', next: [], tasks: [], challenge: challengeOf('2026-03-11'),
    review: nativeReview('2026-03-11', 'approved', [
      { reviewer: 'general', verdict: 'approved', status: 'accepted', accepted: '09:53:49', findings: [
        finding('general', 'P2', DONE_FINDINGS.generalUi, 'open', 'ui'),
      ] },
      { reviewer: 'coverage', verdict: 'approved', status: 'accepted', accepted: '09:52:04', findings: [
        finding('coverage', 'P1', DONE_FINDINGS.coverageUi, 'resolved', 'ui'),
        finding('coverage', 'P2', DONE_FINDINGS.coverageAdapter, 'accepted', 'adapter'),
      ] },
    ], '09:53:49'),
  },
  {
    runId: RUN_REVAMP_BLOCKED, day: '2026-03-12', status: 'failed', finished: true,
    events: [
      ...challengeRows, ...launchRows, ...verifyRows, ...reviewerLaunches,
      ['09:52:30', 'review', 'blocked', 'Reviewer coverage blocked the candidate'],
    ],
    states: { ...verifiedStates, review: { status: 'failed', attempt: 1, session: JOINED_SESSIONS, review: 1 } },
    packets: PACKETS, values: 'verified', next: [],
    tasks: [{ node_id: 'review', error: 'Reviewer coverage blocked the candidate; see review.json', interrupts: [], result: null }],
    challenge: challengeOf('2026-03-12'),
    review: nativeReview('2026-03-12', 'blocked', [
      { reviewer: 'general', verdict: 'approved', status: 'accepted', accepted: '09:51:10', findings: [
        finding('general', 'P2', BLOCKED_FINDINGS.generalUi, 'open', 'ui'),
        finding('general', 'P2', BLOCKED_FINDINGS.generalAdapter, 'accepted', 'adapter'),
      ] },
      { reviewer: 'coverage', verdict: 'blocked', status: 'blocked', accepted: '09:52:30', findings: [
        finding('coverage', 'P1', BLOCKED_FINDINGS.coverageUi, 'open', 'ui', UI_QUOTE),
        finding('coverage', 'P2', BLOCKED_FINDINGS.coverageAdapter, 'open', 'adapter'),
      ] },
    ], '09:52:30'),
  },
  {
    runId: RUN_REVAMP_RUNNING, day: RUNNING_DAY, status: 'running', finished: false,
    events: [
      ...challengeRows, ...launchRows,
      ['09:03:04', 'ui', 'running', AWAITING],
      ['09:03:37', 'adapter', 'running', AWAITING],
      [QUESTION_AT, 'adapter', 'running', `Worker adapter asked question 1 of 3: ${REVAMP_QUESTION}`],
    ],
    states: {
      challenge: { status: 'succeeded', attempt: 1, session: REVAMP_CHALLENGE_SESSION },
      launch_ui: { status: 'running', attempt: 1, session: UI_SESSION }, launch_adapter: { status: 'running', attempt: 1, session: ADAPTER_SESSION },
    },
    packets: [], values: 'launched', next: ['handoff'],
    tasks: [{ node_id: 'handoff', error: null, interrupts: [{ kind: 'worker_handoff', message: 'Awaiting explicit completion signals and automatic freeze.' }], result: null }],
    challenge: challengeOf(RUNNING_DAY),
    questions: { adapter: [{ n: 1, question: REVAMP_QUESTION, asked_at: `${RUNNING_DAY}T${QUESTION_AT}Z`, answer: null, answered_at: null }] },
    activity: {
      feature: REVAMP_FEATURE, last_activity_at: `${RUNNING_DAY}T${QUESTION_AT}Z`, finished_at: null,
      focus: { node_id: 'launch_adapter', label: 'Launch adapter worker', status: 'running', since: `${RUNNING_DAY}T${QUESTION_AT}Z` },
      attention: { kind: 'question', node_id: 'launch_adapter', since: `${RUNNING_DAY}T${QUESTION_AT}Z` },
      waiting_questions: 1, headline: `Launch adapter worker · Worker adapter asked question 1 of 3: ${REVAMP_QUESTION}`, controller: null,
    },
  },
]

const NODES: DefinitionNode[] = [
  CHALLENGE_NODE,
  ...laneGraphNodes(LANES).map(node => (node.kind === 'worker' ? { ...node, depends_on: [CHALLENGE_NODE.node_id] } : node)),
]
export const REVAMP_PAGES_DEFINITION: WorkflowDefinition = definition(PROJECT.project_id, REVAMP_PAGES_WORKFLOW_ID, REVAMP_PAGES_WORKFLOW_NAME, NODES)

const at = (fixture: Fixture, clock: string) => `${fixture.day}T${clock}Z`
const createdAt = (fixture: Fixture) => at(fixture, fixture.events[0][0].replace(/:\d\d$/, ':00'))
const updatedAt = (fixture: Fixture) => at(fixture, fixture.events.at(-1)![0])
const records = (fixture: Fixture): InternalEvent[] => fixture.events.map(([clock, node, status, message], index) => ({ sequence: index + 1, time: at(fixture, clock), node, status, message }))

/** A verification packet's result: the lane's checks spread over the attempt, all passing. */
function packetResult(fixture: Fixture, packet: Packet): WorkerResult {
  const { lane, attempt, from, to } = packet
  const commands = lane === 'ui'
    ? ['npm run build', 'npm run test:unit', 'npx --no-install playwright test --config=tests/project-workflows/playwright.config.ts']
    : ['npx --no-install tsx --test server/projects.test.ts']
  const start = Date.parse(at(fixture, from))
  const step = (Date.parse(at(fixture, to)) - start) / commands.length
  const time = (index: number) => new Date(start + Math.round(step * index)).toISOString().replace(/\.000Z$/, 'Z')
  const logs = ARTIFACTS[lane].filter(file => file.kind === 'log').map(file => file.artifact_id)
  return validateWorkerResult({
    contract_version: '1.0.0', run_id: fixture.runId, node_id: lane, attempt, session_id: SESSIONS[lane],
    status: 'succeeded', base_commit: BASE_COMMIT, output_commit: packet.phase === 'candidate' ? CANDIDATE_COMMIT : COMMITS[lane],
    changed_files: lane === 'ui' ? UI_CHANGED_FILES : ADAPTER_CHANGED_FILES,
    checks: checks(`verification/${packet.phase}/${lane}/${attempt}/worktree`, commands.map((command, index) => ({ command, log: logs[index], exit: 0, start: time(index), finish: time(index + 1) }))),
    open_assumptions: [],
    artifacts: artifactRefs(ARTIFACTS[lane]),
    summary: 'Trusted check capture of the lane; not integration approval.',
    error: null,
  })
}

const resultKey = (packet: Packet) => `${packet.phase === 'candidate' ? `candidate_${packet.lane}` : packet.lane}/${packet.attempt}`

function rawWorker(fixture: Fixture, lane: Lane, leak: string): RawWorkerInput {
  const ui = lane === 'ui'
  const summary = ui ? 'Built the run and node pages.' : 'Served the review fields.'
  const { requested, started } = LAUNCH[lane]
  return {
    role: ui ? 'frontend' : 'backend',
    required_check_kinds: ui ? ['build', 'browser'] : ['unit'],
    task: ui ? uiTask(leak) : adapterTask(),
    prompt: null,
    owned_paths: ui ? ['src/projects', 'tests/project-workflows'] : ['server'],
    checks: ui ? UI_CHECKS : ADAPTER_CHECKS,
    launch: {
      session_id: SESSIONS[lane], launch_token: launchToken(lane), launch_requested_at: offset(at(fixture, requested)),
      native_started_at: Date.parse(at(fixture, started)), observed_state: fixture.finished ? 'done' : 'working', status: 'attached_session_available',
      launcher_invocations: 1, background_id: backgroundId(lane),
    },
    completion: fixture.finished ? { version: '1.1.0', status: 'completed', summary, open_assumptions: [], untested: [], falsifying_check: null, verify_yourself: null, question: null } : null,
    handoff: fixture.finished ? { summary, open_assumptions: [] } : null,
    stop: fixture.finished ? { stopped: true, confirmed_at: offset(at(fixture, '09:31:54')) } : null,
    questions: fixture.questions?.[lane] ?? [],
  }
}

function inputsSection(fixture: Fixture, leak: string): RawInputsSection {
  return {
    feature: REVAMP_FEATURE, policy_version: '1.2.0', base_commit: BASE_COMMIT, source_branch: `feature/${REVAMP_PAGES_WORKFLOW_ID}/${fixture.runId}`,
    mode: 'automatic',
    automatic: { finish: 'verified-feature-branch', permission_mode: 'bypassPermissions', worker_timeout_seconds: 7200, review_timeout_seconds: 1800, reviewer_transport: 'native' },
    setup: [{ argv: ['npm', 'ci'], command: 'npm ci', timeout_seconds: 600 }],
    max_verification_attempts: 3,
    failure_drill: null,
    selected_workers: [...LANES],
    excluded_workers: [],
    workers: Object.fromEntries(LANES.map(lane => [lane, rawWorker(fixture, lane, leak)])),
    decisions: null,
    challenge: fixture.challenge,
  }
}

// The adapter's projection of the raw rows for the worker-phase mock, as `ux-review.ts` serves them: a lane's rows on its launch
// node, `freeze` on the handoff, a candidate lane's rows on `candidate` with the lane in the message, statuses through the
// adapter's table (a plain `stopped` record is a log row), and the attempt a row states of its own node.
const EVENT_STATUS: Record<string, WorkflowEvent['status']> = {
  running: 'running', interactive: 'running', blocked: 'failed', succeeded: 'succeeded', passed: 'succeeded', approved: 'succeeded', paused: 'paused', interrupted: 'paused',
}
const OWN_ATTEMPT = /^(?:Attempt|Design challenge attempt) (\d+)\b/

function servedEvents(fixture: Fixture): WorkflowEvent[] {
  const known = new Set(NODES.map(node => node.node_id))
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
    const status = node_id || record.node === 'controller' ? EVENT_STATUS[record.status] ?? null : null
    const lane = node_id === 'candidate' ? record.node.slice('candidate_'.length) : null
    return eventSchema.parse({
      contract_version: '1.0.0', run_id: fixture.runId, event_id: `${fixture.runId}:${record.sequence}`, sequence: record.sequence, occurred_at: record.time,
      node_id, attempt, type: node_id && status ? 'status_changed' : 'log', status, message: lane ? `[${lane}] ${record.message}` : record.message,
      artifact: null, result_uri: null, reused_from_attempt: null,
    })
  })
}

/** The worker-phase run detail; a live run's is contract 1.5.0 with its served activity and no run directory (the seeded root is outside `$HOME`). */
function detailOf(fixture: Fixture): RunDetail {
  const base = runDetail(fixture.runId, fixture.status, REVAMP_PAGES_DEFINITION, createdAt(fixture), updatedAt(fixture), fixture.states, fixture.events.length)
  return fixture.activity ? validateRunDetail({ ...base, summary: { ...base.summary, contract_version: '1.5.0', activity: fixture.activity }, run_dir: null }) : base
}
const taskTexts = (fixture: Fixture, leak: string) => Object.fromEntries(Object.entries(inputsSection(fixture, leak).workers).map(([lane, worker]) => [lane, worker.task]))

const payloads: UxPayloads = {
  workflows: [REVAMP_PAGES_DEFINITION],
  runDetails: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, detailOf(fixture)])),
  runEvents: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, servedEvents(fixture)])),
  workerResults: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, Object.fromEntries(fixture.packets.map(packet => [resultKey(packet), packetResult(fixture, packet)]))])),
  reviewResults: Object.fromEntries(FIXTURES.flatMap((fixture): [string, ReviewResult][] => fixture.review
    ? [[fixture.runId, projectReview(fixture.runId, fixture.review, taskTexts(fixture, PATH_TOKEN), REVAMP_PAGES_WORKFLOW_ID)]] : [])),
  runInputs: Object.fromEntries(FIXTURES.map((fixture): [string, RunInputs] => [fixture.runId, projectInputs(fixture.runId, inputsSection(fixture, PATH_TOKEN))])),
  artifactFiles: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, fixture.packets.length ? LANES.flatMap(lane => ARTIFACTS[lane]) : []])),
}

function seed({ repository, runsRoot, writeRun, writePacket, receipt, leakFor }: SeedContext) {
  const root = runsRoot(REVAMP_PAGES_WORKFLOW_ID)
  for (const fixture of FIXTURES) {
    const runDir = join(root, fixture.runId)
    writeRun(root, repository, fixture.runId, {
      createdAt: createdAt(fixture), updatedAt: updatedAt(fixture), definitionNodes: NODES, definitionName: REVAMP_PAGES_WORKFLOW_NAME, version: '1.5.0', lanes: LANES,
      reviewers: REVIEWERS,
      values: {
        lanes: Object.fromEntries(LANES.map(lane => [lane, receipt(lane, runDir, SESSIONS[lane], at(fixture, LAUNCH[lane].requested))])),
        ...(fixture.values !== 'launched' ? {
          snapshots: Object.fromEntries(LANES.map(lane => [lane, COMMITS[lane]])),
          packets: Object.fromEntries(LANES.map(lane => [lane, `verification/worker/${lane}/1/packet.json`])),
          bundle: { run_id: fixture.runId, base_commit: BASE_COMMIT, candidate_commit: CANDIDATE_COMMIT, policy_sha256: 'e'.repeat(64) },
        } : {}),
        ...(fixture.values === 'integrated' ? {
          review: { run_id: fixture.runId, verdict: 'approved', independent: true, reviewer: JOINED_SESSIONS, findings: [] },
          approved_bundle: BUNDLE, integrated_commit: CANDIDATE_COMMIT,
        } : {}),
      },
      next: fixture.next,
      tasks: fixture.tasks,
      events: records(fixture),
      packets: directory => fixture.packets.map(packet => writePacket(directory, packet.phase, packet.lane, packet.attempt, packetResult(fixture, packet), ARTIFACTS[packet.lane], { status: 'passed', reasons: [] })),
      review: fixture.review ?? null,
      inputs: inputsSection(fixture, leakFor(root, fixture.runId)),
    })
    // The controller's live question record (guardrails.py save_questions), the same as the export while the run waits.
    for (const [lane, questions] of Object.entries(fixture.questions ?? {})) {
      const live = questions.map(question => ({ ...question, asked_at: offset(question.asked_at) }))
      writeFileSync(join(runDir, `${lane}.questions.json`), `${JSON.stringify({ questions: live }, null, 2)}\n`)
    }
  }
  return { workflows: [{ workflow_id: REVAMP_PAGES_WORKFLOW_ID, runs_root: root, definition: { name: REVAMP_PAGES_WORKFLOW_NAME, nodes: NODES } }] }
}

export const uxRevampPages: UxFixtureModule = { payloads, seed }
