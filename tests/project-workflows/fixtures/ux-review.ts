/**
 * Fixtures of viewer UX slice S4c, review, challenge and controller nodes (`ux-review.spec.ts`) (docs/PRD_VIEWER_UX.md 4.7
 * to 4.9 and 12.2), registered as the workflow `ux-review`: mock payloads for the worker phase and a `seed` for the
 * candidate phase, merged by `index.ts`.
 *
 * Every run is a 1.5.0 export of a guarded two-lane graph (the design challenge first), written once as the controller's own
 * records (`events.jsonl` rows with their real message texts, graph values, tasks, verification packets and the export's
 * `review` and `inputs` sections):
 * - `run-review-approved`: integrated. The challenge ran three attempts (#1 ended without a record when #2 started, #2 was
 *   blocked after 46s, #3 passed with 8 P2 notes, 11m07s after #1 started). The adapter's launch receipt is the latest
 *   (08:51:33), the freeze 28m21s later (09:19:54). Both native reviewers approved: general in 3m49s, coverage in 2m04s. The
 *   approval recorded no event (an automatic run's finish policy approves it); the integration fast-forwarded the branch.
 * - `run-review-pending`: coverage blocked with an open P1 while general, launched at 09:40:00, recorded no verdict
 *   (`pending`); the review failed.
 * - `run-review-print`: one print reviewer (no launch time recorded) blocked the candidate with an open P1.
 * - `run-challenge-paused`: the design challenge found one P1 (and one P2) and paused the run before any worker launched.
 */
import type { ReviewResult, RunDetail, RunInputs, WorkflowDefinition } from '../../../contracts/projects/v1.ts'
import { eventSchema, validateWorkerResult, type WorkerResult, type WorkflowEvent } from '../../../contracts/workflow/v1.ts'
import {
  ADAPTER_ARTIFACTS, ADAPTER_CHECKS, ADAPTER_QUOTE, ADAPTER_SESSION, BASE_COMMIT, CANDIDATE_COMMIT, CHALLENGE_NODE, COVERAGE_REVIEWER_SESSION,
  GENERAL_REVIEWER_SESSION, OUTPUT_COMMIT_ADAPTER, OUTPUT_COMMIT_UI, PATH_TOKEN, PRINT_REVIEWER_SESSION, PROJECT, UI_ARTIFACTS, UI_CHECKS, UI_QUOTE,
  UI_SESSION, adapterTask, artifactRefs, backgroundId, checks, definition, laneGraphNodes, launchToken, offset, projectInputs, projectReview, runDetail,
  sha256, uiTask,
  type ArtifactFile, type DefinitionNode, type NodeState, type RawChallenge, type RawConcern, type RawFinding, type RawInputsSection, type RawReviewSection,
  type RawWorkerInput,
} from '../fixtures.ts'
import type { InternalEvent, SeedContext } from '../seed.ts'
import type { UxFixtureModule, UxPayloads } from './index.ts'

export const UX_REVIEW_WORKFLOW_ID = 'ux-review'
export const UX_REVIEW_WORKFLOW_NAME = 'UX review'
export const RUN_REVIEW_APPROVED = 'run-review-approved'
export const RUN_REVIEW_PENDING = 'run-review-pending'
export const RUN_REVIEW_PRINT = 'run-review-print'
export const RUN_CHALLENGE_PAUSED = 'run-challenge-paused'

export const UX_REVIEW_CHALLENGE_SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
/** The open P1 coverage raised on `run-review-pending`; it quotes the ui task verbatim. */
export const PENDING_P1 = 'Private matches can be joined without their code.'
/** The open P1 the print reviewer raised on `run-review-print`; it quotes the adapter task verbatim. */
export const PRINT_P1 = 'The review route serves a verdict the export section does not hold.'
/** The challenge's P1 on `run-challenge-paused`. */
export const PAUSED_P1 = 'The panels assume every review serves reviewers while it runs, but review.json is written only on the verdict.'
export const PAUSED_P1_CONSEQUENCE = 'A running review would show empty reviewer rows as if nobody had been launched.'
/** When the challenge's P2 notes of `run-review-approved` were decided, and the latest launch start and freeze of its wait. */
export const CHALLENGE_DECIDED = '2026-03-05T08:50:49Z'
export const LATEST_LAUNCH = '2026-03-05T08:51:33Z'
export const FREEZE_AT = '2026-03-05T09:19:54Z'
export const INTEGRATED_AT = '2026-03-05T09:43:52Z'

type Lane = 'ui' | 'adapter'
type Row = [clock: string, node: string, status: string, message: string]
type Task = { node_id: string; error: string | null; interrupts: object[]; result: object | null }
type Packet = { phase: 'worker' | 'candidate'; lane: Lane; attempt: number; from: string; to: string }

type Fixture = {
  runId: string
  status: RunDetail['summary']['status']
  events: Row[]
  /** The snapshot the adapter projects from these records, for the worker-phase mock. */
  states: Record<string, NodeState>
  packets: Packet[]
  /** Graph values: `launched` (receipts), `verified` (snapshots, packets and the bundle), `integrated` (review, approval, commit). */
  values: 'none' | 'verified' | 'integrated'
  next: string[]
  tasks: Task[]
  challenge: RawChallenge
  /** Workers launched (their receipts and stops are recorded). */
  launched: boolean
  transport: 'native' | 'print'
  reviewers?: readonly string[]
  review?: RawReviewSection
}

const DAY = '2026-03-05'
const at = (clock: string) => `${DAY}T${clock}Z`
const LANES: readonly Lane[] = ['ui', 'adapter']
const SESSIONS: Record<Lane, string> = { ui: UI_SESSION, adapter: ADAPTER_SESSION }
const COMMITS: Record<Lane, string> = { ui: OUTPUT_COMMIT_UI, adapter: OUTPUT_COMMIT_ADAPTER }
const ARTIFACTS: Record<Lane, ArtifactFile[]> = { ui: UI_ARTIFACTS, adapter: ADAPTER_ARTIFACTS }
/** Each lane's launch receipt: requested, then natively started; the adapter launched last. */
const LAUNCH: Record<Lane, { requested: string; started: string }> = {
  ui: { requested: '08:50:58', started: '08:51:00' },
  adapter: { requested: '08:51:28', started: '08:51:33' },
}
const REVIEWERS = ['general', 'coverage'] as const
const JOINED_SESSIONS = `${GENERAL_REVIEWER_SESSION}, ${COVERAGE_REVIEWER_SESSION}`
const BUNDLE = 'b7'.repeat(32)

const LAUNCHING = 'Launching or reconciling the exact native session'
const challengeStart = (clock: string, attempt: number): Row => [clock, 'challenge', 'running', `Design challenge attempt ${attempt}: one print job, session ${UX_REVIEW_CHALLENGE_SESSION}`]
const challengePassed = (clock: string, attempt: number, notes: number): Row => [clock, 'challenge', 'succeeded', `Design challenge attempt ${attempt} passed (${notes} P2 concern(s)); launching workers`]
/** Launch, freeze, both verifications and the combined candidate, all passing. */
const pipeline: Row[] = [
  ['08:51:00', 'ui', 'running', LAUNCHING],
  ['08:51:33', 'adapter', 'running', LAUNCHING],
  ['09:19:54', 'freeze', 'stopped', 'Native workers stopped before snapshot capture: ui, adapter'],
  ['09:19:54', 'freeze', 'succeeded', 'Immutable snapshots captured; worker-reported checks are not trusted'],
  ['09:19:55', 'verify_ui', 'running', `Attempt 1; revision ${OUTPUT_COMMIT_UI}`],
  ['09:19:55', 'verify_adapter', 'running', `Attempt 1; revision ${OUTPUT_COMMIT_ADAPTER}`],
  ['09:22:00', 'verify_adapter', 'succeeded', 'Required tests and artifacts passed; recorded for the candidate gate: backend-unit'],
  ['09:24:00', 'verify_ui', 'succeeded', 'Required tests and artifacts passed; recorded for the candidate gate: frontend-build, project-workflows-browser'],
  ['09:30:00', 'candidate_adapter', 'succeeded', `Combined revision ${CANDIDATE_COMMIT}`],
  ['09:32:00', 'candidate_ui', 'succeeded', `Combined revision ${CANDIDATE_COMMIT}`],
]
const reviewerLaunches: Row[] = REVIEWERS.map(reviewer => ['09:40:00', 'review', 'running', `Launching reviewer ${reviewer} over the shared review worktree`])
const PACKETS: Packet[] = [
  { phase: 'worker', lane: 'ui', attempt: 1, from: '09:20:00', to: '09:23:55' },
  { phase: 'worker', lane: 'adapter', attempt: 1, from: '09:20:00', to: '09:21:55' },
  { phase: 'candidate', lane: 'adapter', attempt: 1, from: '09:24:05', to: '09:29:55' },
  { phase: 'candidate', lane: 'ui', attempt: 1, from: '09:24:05', to: '09:31:55' },
]

const done = (session: string | null = null, result: string | null = null): NodeState => ({ status: 'succeeded', attempt: 1, session, result })
const verifiedStates = (attempts: number): Record<string, NodeState> => ({
  challenge: { status: 'succeeded', attempt: attempts, session: UX_REVIEW_CHALLENGE_SESSION },
  launch_ui: done(UI_SESSION, 'ui'), launch_adapter: done(ADAPTER_SESSION, 'adapter'), handoff: done(),
  verify_ui: done(UI_SESSION, 'ui'), verify_adapter: done(ADAPTER_SESSION, 'adapter'),
  candidate: { ...done(), lanes: LANES.map(lane => ({ worker: lane, attempt: 1 })) },
})

const pinned = (sha: string) => ({ tasks_sha256: sha256(`tasks-${sha}`), decisions_sha256: sha256(`decisions-${sha}`), prd_sha256: null })
const P2_NOTES: RawConcern[] = [
  'The reviewer strip repeats the verdict the header already shows.',
  'Blocking cards and the findings table both name the reviewer.',
  'The narrow card layout hides the column names.',
  'The handoff wait reads receipts, not the freeze task.',
  'Approval times are inferred from the integration.',
  'The challenge headline repeats the attempt the header shows.',
  'Earlier challenge attempts show no concerns.',
  'The integrate line repeats the branch the run header names.',
].map(message => ({ severity: 'P2', kind: 'complexity', message, consequence: 'Some text is said twice on one page.' }))

const passedAfterThree: RawChallenge = {
  status: 'passed', attempt: 3, session_id: UX_REVIEW_CHALLENGE_SESSION, pinned: pinned('approved'), concerns: P2_NOTES,
  simpler_alternative: 'Keep the review table and add a blocking filter.', cheap_experiment: 'Show one blocked review to an operator at 390 px.',
  accepted_reason: null, decided_at: CHALLENGE_DECIDED, attempts: 3,
}
const passedOnce = (clock: string): RawChallenge => ({
  status: 'passed', attempt: 1, session_id: UX_REVIEW_CHALLENGE_SESSION, pinned: pinned('once'), concerns: [],
  simpler_alternative: 'None simpler.', cheap_experiment: 'None needed.', accepted_reason: null, decided_at: at(clock), attempts: 1,
})
const pausedChallenge: RawChallenge = {
  status: 'paused', attempt: 1, session_id: UX_REVIEW_CHALLENGE_SESSION, pinned: pinned('paused'),
  concerns: [
    { severity: 'P2', kind: 'other', message: 'The controller panels have no index.', consequence: 'A long History pushes nothing down.' },
    { severity: 'P1', kind: 'assumption', message: PAUSED_P1, consequence: PAUSED_P1_CONSEQUENCE },
  ],
  simpler_alternative: 'Show only decided reviews.', cheap_experiment: 'Open a running review and read what it serves.',
  accepted_reason: null, decided_at: at('08:44:12'), attempts: 1,
}

const finding = (reviewer: string, severity: RawFinding['severity'], message: string, disposition: RawFinding['disposition'], worker: string, requirement: string | null = null): RawFinding =>
  ({ severity, message, disposition, worker, requirement, reviewer })

function nativeReview(verdict: 'approved' | 'blocked', entries: { reviewer: string; verdict: 'approved' | 'blocked' | null; status: 'accepted' | 'blocked' | 'pending'; accepted: string | null; findings: RawFinding[] }[], reviewedAt: string): RawReviewSection {
  const sessions: Record<string, string> = { general: GENERAL_REVIEWER_SESSION, coverage: COVERAGE_REVIEWER_SESSION }
  return {
    attempt: 1, transport: 'native', reviewer_session_id: JOINED_SESSIONS, independent: true, bundle_sha256: BUNDLE, candidate_commit: CANDIDATE_COMMIT,
    verdict, findings: entries.flatMap(entry => entry.findings), reviewed_at: offset(at(reviewedAt)), diff: null,
    reviewers: entries.map(entry => ({
      reviewer_id: entry.reviewer, transport: 'native', session_id: sessions[entry.reviewer], verdict: entry.verdict, findings: entry.findings,
      launched_at: offset(at('09:40:00')), accepted_at: entry.accepted === null ? null : offset(at(entry.accepted)), status: entry.status,
    })),
  }
}

const FIXTURES: Fixture[] = [
  {
    runId: RUN_REVIEW_APPROVED, status: 'succeeded', launched: true, transport: 'native', reviewers: REVIEWERS,
    events: [
      challengeStart('08:39:42', 1),
      challengeStart('08:45:00', 2),
      ['08:45:46', 'challenge', 'blocked', 'Challenge output rejected: concerns[3].severity is not one of P0, P1, P2'],
      challengeStart('08:48:20', 3),
      challengePassed('08:50:49', 3, 8),
      ...pipeline,
      ...reviewerLaunches,
      ['09:43:49', 'review', 'approved', JOINED_SESSIONS],
      ['09:43:52', 'integrate', 'succeeded', `Fast-forwarded to ${CANDIDATE_COMMIT}; no push performed`],
    ],
    states: {
      ...verifiedStates(3),
      review: { status: 'succeeded', attempt: 1, session: JOINED_SESSIONS, review: 1 },
      approval: done(), integrate: done(),
    },
    packets: PACKETS, values: 'integrated', next: [], tasks: [], challenge: passedAfterThree,
    review: nativeReview('approved', [
      { reviewer: 'general', verdict: 'approved', status: 'accepted', accepted: '09:43:49', findings: [
        finding('general', 'P2', 'The blocking card repeats the finding message.', 'open', 'ui'),
        finding('general', 'P2', 'The controller panel names the branch twice.', 'open', 'ui'),
      ] },
      { reviewer: 'coverage', verdict: 'approved', status: 'accepted', accepted: '09:42:04', findings: [
        finding('coverage', 'P2', 'No unit test reads a receipt without a native start.', 'accepted', 'ui'),
      ] },
    ], '09:43:49'),
  },
  {
    runId: RUN_REVIEW_PENDING, status: 'failed', launched: true, transport: 'native', reviewers: REVIEWERS,
    events: [
      challengeStart('08:40:00', 1),
      challengePassed('08:42:10', 1, 0),
      ...pipeline,
      ...reviewerLaunches,
      ['09:42:30', 'review', 'blocked', 'Reviewer coverage blocked the candidate'],
    ],
    states: { ...verifiedStates(1), review: { status: 'failed', attempt: 1, session: JOINED_SESSIONS, review: 1 } },
    packets: PACKETS, values: 'verified', next: [],
    tasks: [{ node_id: 'review', error: 'Reviewer coverage blocked the candidate; see review.json', interrupts: [], result: null }],
    challenge: passedOnce('08:42:10'),
    review: nativeReview('blocked', [
      { reviewer: 'general', verdict: null, status: 'pending', accepted: null, findings: [] },
      { reviewer: 'coverage', verdict: 'blocked', status: 'blocked', accepted: '09:42:30', findings: [
        finding('coverage', 'P1', PENDING_P1, 'open', 'ui', UI_QUOTE),
        finding('coverage', 'P2', 'The match list polls every second.', 'open', 'adapter'),
      ] },
    ], '09:42:30'),
  },
  {
    runId: RUN_REVIEW_PRINT, status: 'failed', launched: true, transport: 'print',
    events: [
      challengeStart('08:40:00', 1),
      challengePassed('08:42:10', 1, 0),
      ...pipeline,
      ['09:44:10', 'review', 'blocked', 'Independent reviewer blocked the candidate'],
    ],
    states: { ...verifiedStates(1), review: { status: 'failed', attempt: 1, session: PRINT_REVIEWER_SESSION, review: 1 } },
    packets: PACKETS, values: 'verified', next: [],
    tasks: [{ node_id: 'review', error: 'Independent reviewer blocked the candidate; see review.json', interrupts: [], result: null }],
    challenge: passedOnce('08:42:10'),
    review: {
      attempt: 1, transport: 'print', reviewer_session_id: PRINT_REVIEWER_SESSION, independent: true, bundle_sha256: BUNDLE, candidate_commit: CANDIDATE_COMMIT,
      verdict: 'blocked', reviewed_at: offset(at('09:44:10')), diff: null,
      findings: [
        { severity: 'P1', message: PRINT_P1, disposition: 'open', worker: 'adapter', requirement: ADAPTER_QUOTE },
        { severity: 'P2', message: 'The review route logs the bundle hash twice.', disposition: 'resolved', worker: 'adapter', requirement: null },
      ],
    },
  },
  {
    runId: RUN_CHALLENGE_PAUSED, status: 'paused', launched: false, transport: 'native',
    events: [
      challengeStart('08:40:00', 1),
      ['08:44:12', 'challenge', 'paused', 'Design challenge attempt 1 paused the run before any worker launch: 1 P0/P1 concern(s)'],
    ],
    states: { challenge: { status: 'paused', attempt: 1, session: UX_REVIEW_CHALLENGE_SESSION } },
    packets: [], values: 'none', next: [], tasks: [], challenge: pausedChallenge,
  },
]

const NODES: DefinitionNode[] = [
  CHALLENGE_NODE,
  ...laneGraphNodes(LANES).map(node => (node.kind === 'worker' ? { ...node, depends_on: [CHALLENGE_NODE.node_id] } : node)),
]
export const UX_REVIEW_DEFINITION: WorkflowDefinition = definition(PROJECT.project_id, UX_REVIEW_WORKFLOW_ID, UX_REVIEW_WORKFLOW_NAME, NODES)

const createdAt = (fixture: Fixture) => at(fixture.events[0][0].replace(/:\d\d$/, ':00'))
const updatedAt = (fixture: Fixture) => at(fixture.events.at(-1)![0])
const records = (fixture: Fixture): InternalEvent[] => fixture.events.map(([clock, node, status, message], index) => ({ sequence: index + 1, time: at(clock), node, status, message }))

/** A verification packet's result: the lane's checks spread over the attempt, all passing. */
function packetResult(runId: string, packet: Packet): WorkerResult {
  const { lane, attempt, from, to } = packet
  const commands = lane === 'ui'
    ? ['npm run build', 'npm run test:unit', 'npx --no-install playwright test --config=tests/project-workflows/playwright.config.ts']
    : ['npx --no-install tsx --test server/projects.test.ts']
  const start = Date.parse(at(from))
  const step = (Date.parse(at(to)) - start) / commands.length
  const time = (index: number) => new Date(start + Math.round(step * index)).toISOString().replace(/\.000Z$/, 'Z')
  const logs = ARTIFACTS[lane].filter(file => file.kind === 'log').map(file => file.artifact_id)
  return validateWorkerResult({
    contract_version: '1.0.0', run_id: runId, node_id: lane, attempt, session_id: SESSIONS[lane],
    status: 'succeeded', base_commit: BASE_COMMIT, output_commit: packet.phase === 'candidate' ? CANDIDATE_COMMIT : COMMITS[lane],
    changed_files: [],
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
  const summary = ui ? 'Built the review panels.' : 'Served the review fields.'
  const { requested, started } = LAUNCH[lane]
  return {
    role: ui ? 'frontend' : 'backend',
    required_check_kinds: ui ? ['build', 'browser'] : ['unit'],
    task: ui ? uiTask(leak) : adapterTask(),
    prompt: null,
    owned_paths: ui ? ['src/projects', 'tests/project-workflows'] : ['server'],
    checks: ui ? UI_CHECKS : ADAPTER_CHECKS,
    launch: fixture.launched ? {
      session_id: SESSIONS[lane], launch_token: launchToken(lane), launch_requested_at: offset(at(requested)),
      native_started_at: Date.parse(at(started)), observed_state: 'done', status: 'attached_session_available',
      launcher_invocations: 1, background_id: backgroundId(lane),
    } : null,
    completion: fixture.launched ? { version: '1.1.0', status: 'completed', summary, open_assumptions: [], untested: [], falsifying_check: null, verify_yourself: null, question: null } : null,
    handoff: fixture.launched ? { summary, open_assumptions: [] } : null,
    stop: fixture.launched ? { stopped: true, confirmed_at: offset(FREEZE_AT) } : null,
    questions: [],
  }
}

function inputsSection(fixture: Fixture, leak: string): RawInputsSection {
  return {
    feature: 'Review panels', policy_version: '1.2.0', base_commit: BASE_COMMIT, source_branch: `feature/${UX_REVIEW_WORKFLOW_ID}/${fixture.runId}`,
    mode: 'automatic',
    automatic: { finish: 'verified-feature-branch', permission_mode: 'bypassPermissions', worker_timeout_seconds: 7200, review_timeout_seconds: 1800, reviewer_transport: fixture.transport },
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

// The adapter's projection of the raw rows for the worker-phase mock, as `normalizeEvents` serves them since B1: a lane's rows
// on its launch node, `freeze` on the handoff, a candidate lane's rows on `candidate` with the lane in the message, statuses
// through the adapter's table (a plain `stopped` record is a log row), and the attempt a row states of its own node.
const EVENT_STATUS: Record<string, WorkflowEvent['status']> = {
  running: 'running', interactive: 'running', blocked: 'failed', succeeded: 'succeeded', passed: 'succeeded', approved: 'succeeded', paused: 'paused', interrupted: 'paused',
}
const OWN_ATTEMPT = /^(?:Attempt|Design challenge attempt|Feature files re-pinned for design challenge attempt) (\d+)\b/

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

const detailOf = (fixture: Fixture): RunDetail => runDetail(fixture.runId, fixture.status, UX_REVIEW_DEFINITION, createdAt(fixture), updatedAt(fixture), fixture.states, fixture.events.length)
const taskTexts = (fixture: Fixture, leak: string) => Object.fromEntries(Object.entries(inputsSection(fixture, leak).workers).map(([lane, worker]) => [lane, worker.task]))

const payloads: UxPayloads = {
  workflows: [UX_REVIEW_DEFINITION],
  runDetails: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, detailOf(fixture)])),
  runEvents: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, servedEvents(fixture)])),
  workerResults: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, Object.fromEntries(fixture.packets.map(packet => [resultKey(packet), packetResult(fixture.runId, packet)]))])),
  reviewResults: Object.fromEntries(FIXTURES.flatMap((fixture): [string, ReviewResult][] => fixture.review
    ? [[fixture.runId, projectReview(fixture.runId, fixture.review, taskTexts(fixture, PATH_TOKEN), UX_REVIEW_WORKFLOW_ID)]] : [])),
  runInputs: Object.fromEntries(FIXTURES.map((fixture): [string, RunInputs] => [fixture.runId, projectInputs(fixture.runId, inputsSection(fixture, PATH_TOKEN))])),
  artifactFiles: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, fixture.packets.length ? LANES.flatMap(lane => ARTIFACTS[lane]) : []])),
}

function seed({ repository, runsRoot, writeRun, writePacket, receipt, leakFor }: SeedContext) {
  const root = runsRoot(UX_REVIEW_WORKFLOW_ID)
  for (const fixture of FIXTURES) {
    const runDir = `${root}/${fixture.runId}`
    const verified = fixture.values !== 'none'
    writeRun(root, repository, fixture.runId, {
      createdAt: createdAt(fixture), updatedAt: updatedAt(fixture), definitionNodes: NODES, definitionName: UX_REVIEW_WORKFLOW_NAME, version: '1.5.0', lanes: LANES,
      ...(fixture.reviewers ? { reviewers: fixture.reviewers } : {}),
      values: {
        ...(fixture.launched ? { lanes: Object.fromEntries(LANES.map(lane => [lane, receipt(lane, runDir, SESSIONS[lane], at(LAUNCH[lane].requested))])) } : {}),
        ...(verified ? {
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
      packets: directory => fixture.packets.map(packet => writePacket(directory, packet.phase, packet.lane, packet.attempt, packetResult(fixture.runId, packet), ARTIFACTS[packet.lane], { status: 'passed', reasons: [] })),
      review: fixture.review ?? null,
      inputs: inputsSection(fixture, leakFor(root, fixture.runId)),
    })
  }
  return { workflows: [{ workflow_id: UX_REVIEW_WORKFLOW_ID, runs_root: root, definition: { name: UX_REVIEW_WORKFLOW_NAME, nodes: NODES } }] }
}

export const uxReview: UxFixtureModule = { payloads, seed }
