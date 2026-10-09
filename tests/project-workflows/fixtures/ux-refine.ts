/**
 * Fixtures of viewer-refine's run page (`ux-refine.spec.ts`, docs/PRD_VIEWER_REFINE.md §5): the in-run fix loop in the
 * graph, the Steps and Activity, the node pages, the Assignment tab and the inline diff, registered as the workflow
 * `ux-refine`. Export 1.10.0.
 *
 * The runs are built from the pinned records of PRD_VIEWER_REFINE Appendix A, re-exported here through the contract
 * examples (`contracts/projects/examples.ts`: `fixLoop`, `fixLoopLaunched`, `fixLoopRestored`), never invented. Lane
 * `viewer` carries a model pin (`opus-4-8 · medium`) and the impeccable skill; lane `shell` carries `roles: null`
 * (executor only) so the two-lane states are exercised.
 *
 * Two phases, as `index.ts` runs them:
 * - worker phase: `payloads` serves each `RunDetail` with its repair nodes already projected by `projectDetail` (the hand
 *   mirror of the server's projection), passing `validateRunDetail`; `tests/unit/refine.test.ts` feeds the three example
 *   records through `projectDetail` and asserts the invariants the server guarantees, so a drift fails before this phase.
 * - candidate phase: `seed` writes 1.10.0 exports whose `run-state.json` carries `fix_loop`, `review.round/delta_from` and
 *   each worker's `roles`/`skills`; the real server projects the repair nodes. `definition_revision` is hashed before the
 *   repair nodes are added (they are projected, never pinned).
 */
import { fixLoop, fixLoopLaunched, fixLoopRestored } from '../../../contracts/projects/examples.ts'
import {
  validateRunDetail, validateRunInputs, validateReviewResult,
  type FixLoop, type RepairEntry, type ReviewResult, type RunDetail, type RunInputs, type WorkflowDefinition,
} from '../../../contracts/projects/v1.ts'
import { eventSchema, validateWorkerResult, type WorkerResult, type WorkflowEvent } from '../../../contracts/workflow/v1.ts'
import {
  BASE_COMMIT, CANDIDATE_COMMIT, PROJECT, REVIEW_DIFF_ARTIFACT_ID, apiRunPath, artifactRefs, checks, definition, projectInputs, projectReview, runDetail, sha256,
  type ArtifactFile, type DefinitionNode, type NodeState, type RawInputsSection, type RawReviewSection,
} from '../fixtures.ts'
import type { InternalEvent, SeedContext } from '../seed.ts'
import type { UxFixtureModule, UxPayloads } from './index.ts'

export const UX_REFINE_WORKFLOW_ID = 'ux-refine'
export const UX_REFINE_WORKFLOW_NAME = 'UX refine'

export const RUN_CHALLENGE = 'run-challenge'
export const RUN_LOOP_DONE = 'run-loop-done'
export const RUN_LOOP_RUNNING = 'run-loop-running'
export const RUN_LOOP_RESTORED = 'run-loop-restored'
export const RUN_LANE_TONES = 'run-lane-tones'

const DAY = '2026-10-09'
const CREATED_AT = `${DAY}T08:00:00Z`
const at = (clock: string) => `${DAY}T${clock}Z`
const VIEWER_SESSION = '6a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const SHELL_SESSION = 'aa11bb22-cc33-4d44-8e55-ff6677889900'
const REVIEW_SESSION = 'd1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f5a'
const DELTA_FROM = '5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f'
const DELTA_DIFF_ID = 'review.delta.diff'

const LANES = ['viewer', 'shell'] as const
type Lane = (typeof LANES)[number]
const SESSIONS: Record<Lane, string> = { viewer: VIEWER_SESSION, shell: SHELL_SESSION }

/** The two-lane pinned graph (`workflow/export_state.py`), optionally led by the design challenge. */
function refineNodes(options: { challenge?: boolean } = {}): DefinitionNode[] {
  const lane = (prefix: string, kind: DefinitionNode['kind'], depends: (lane: Lane) => string[]) =>
    LANES.map(name => ({ node_id: `${prefix}_${name}`, label: `${prefix === 'launch' ? 'Launch' : 'Verify'} ${name}${prefix === 'launch' ? ' worker' : ''}`, kind, depends_on: depends(name) }))
  const challenge: DefinitionNode[] = options.challenge ? [{ node_id: 'challenge', label: 'Design challenge', kind: 'review', depends_on: [] }] : []
  const launchDeps = options.challenge ? ['challenge'] : []
  return [
    ...challenge,
    ...lane('launch', 'worker', () => launchDeps),
    { node_id: 'handoff', label: 'Freeze worker handoffs', kind: 'prepare', depends_on: LANES.map(name => `launch_${name}`) },
    ...lane('verify', 'verification', () => ['handoff']),
    { node_id: 'candidate', label: 'Verify combined candidate', kind: 'verification', depends_on: LANES.map(name => `verify_${name}`) },
    { node_id: 'review', label: 'Independent review', kind: 'review', depends_on: ['candidate'] },
    { node_id: 'approval', label: 'Integration approval', kind: 'integration', depends_on: ['review'] },
    { node_id: 'integrate', label: 'Integrate candidate', kind: 'integration', depends_on: ['approval'] },
  ]
}

const pinned = (nodes: DefinitionNode[]): WorkflowDefinition => definition(PROJECT.project_id, UX_REFINE_WORKFLOW_ID, UX_REFINE_WORKFLOW_NAME, nodes)
export const UX_REFINE_DEFINITION = pinned(refineNodes())

// ---- The projection the server does, mirrored by hand for the worker phase (and the drift guard) -------------------

const REPAIR_RUNNING: ReadonlySet<RepairEntry['status']> = new Set(['launched', 'captured', 'recorded'])
const repairNodeStatus = (repair: RepairEntry): NodeState['status'] =>
  REPAIR_RUNNING.has(repair.status) ? 'running' : repair.status === 'applied' ? 'succeeded' : 'failed'

const sessionRepairs = (loop: FixLoop | null): RepairEntry[] => (loop && 'repairs' in loop ? loop.repairs : [])

/** Inserts each `repair-<n>` right after the step it answers, in `n` order (server `insertRepairs`). */
function insertRepairs<T extends { node_id: string }>(nodes: readonly T[], loop: FixLoop | null, make: (repair: RepairEntry) => T): T[] {
  const repairs = sessionRepairs(loop)
  if (repairs.length === 0) return [...nodes]
  return nodes.flatMap(node => [node, ...[...repairs].sort((a, b) => a.n - b.n).filter(repair => repair.blocked_step === node.node_id).map(make)])
}

const archivedRounds = (loop: FixLoop | null): number => (loop && 'review_rounds' in loop ? loop.review_rounds.filter(round => round.archived).length : 0)

/**
 * Projects a base `RunDetail` (pinned definition and the pinned snapshot I chose) the way the server does: repair nodes in
 * the definition and snapshot, the steps a running repair re-enters set to `running`, the run status folded from the pinned
 * steps only, and the review node's attempt from the review round. The result passes `validateRunDetail`.
 */
export function projectDetail(base: RunDetail, loop: FixLoop | null, finalStatus?: RunDetail['summary']['status']): RunDetail {
  const running = sessionRepairs(loop).filter(repair => REPAIR_RUNNING.has(repair.status))
  const pinnedNodes = base.snapshot.nodes.map(node => {
    if (running.some(repair => repair.reentered_steps.includes(node.node_id))) return { ...node, status: 'running' as const }
    return node
  })
  // The run status is folded from the pinned steps only; a repair node never enters it.
  const statuses = new Set(pinnedNodes.map(node => node.status))
  const folded: RunDetail['summary']['status'] = finalStatus
    ?? (statuses.has('failed') ? 'failed'
      : statuses.has('awaiting_approval') ? 'awaiting_approval'
        : statuses.has('paused') ? 'paused'
          : statuses.has('running') ? 'running'
            : statuses.size === 1 && statuses.has('pending') ? 'pending'
              : statuses.has('succeeded') && !statuses.has('pending') ? 'succeeded' : 'paused')
  const repairSnapshot = (repair: RepairEntry) => ({
    node_id: repair.node_id, kind: 'worker' as const, depends_on: [repair.blocked_step],
    status: repairNodeStatus(repair), attempt: 1, session_id: repair.session_id, result_uri: null, lane_results: [],
  })
  const repairDefinition = (repair: RepairEntry): DefinitionNode => ({ node_id: repair.node_id, label: `Repair ${repair.lane} ${repair.n}`, kind: 'worker', depends_on: [repair.blocked_step] })
  return validateRunDetail({
    summary: { ...base.summary, status: folded },
    definition: { ...base.definition, nodes: insertRepairs(base.definition.nodes, loop, repairDefinition) },
    snapshot: { ...base.snapshot, status: folded, nodes: insertRepairs(pinnedNodes, loop, repairSnapshot) },
    ...(loop ? { fixLoop: loop } : {}),
  })
}

/** The review node's projected attempt: the review round, else one plus the archived rounds. */
export function reviewAttemptOf(loop: FixLoop | null, servedRound: number | null): number {
  return servedRound ?? 1 + archivedRounds(loop)
}

// ---- The fixture states --------------------------------------------------------------------------------------------

const done = (session?: string, result?: string): NodeState => ({ status: 'succeeded', attempt: 1, session: session ?? null, result: result ?? null })

/** The pinned snapshot of the worked example: every pinned lane step succeeded, the candidate verified, round 2 approved. */
function workedStates(reviewAttempt: number): Record<string, NodeState> {
  return {
    launch_viewer: done(VIEWER_SESSION, 'viewer'), launch_shell: done(SHELL_SESSION, 'shell'), handoff: done(),
    verify_viewer: { ...done(VIEWER_SESSION, 'viewer'), attempt: 2 }, verify_shell: done(SHELL_SESSION, 'shell'),
    candidate: { ...done() },
    review: { status: 'succeeded', attempt: reviewAttempt, session: REVIEW_SESSION, review: reviewAttempt },
    approval: done(), integrate: done(),
  }
}

type Fixture = {
  runId: string
  nodes: DefinitionNode[]
  states: Record<string, NodeState>
  loop: FixLoop | null
  /** The folded status the run reads; computed by `projectDetail` unless pinned here. */
  status?: RunDetail['summary']['status']
  updatedAt: string
  events: InternalEvent[]
  /** The run inputs (always, so the Assignment tab and the lane pins have data). */
  inputs: RawInputsSection
  review?: RawReviewSection
  /** The served review's 1.10.0 keys; the diff and delta diff texts (served as patch artifacts, seeded as files). */
  reviewRound?: number
  deltaFrom?: string | null
  reviewDiffText?: string
  deltaDiffText?: string
}

/** The patch artifacts a run serves, from its diff texts. */
function artifactsOf(fixture: Fixture): ArtifactFile[] {
  const files: ArtifactFile[] = []
  // The full diff is served under the review result's own artifact id (derived from the diff's content hash); the delta
  // diff under the id `reviewWithRound` gives it, so the inline reader fetches the exact bytes the ReviewResult names.
  if (fixture.reviewDiffText !== undefined) files.push({ artifact_id: REVIEW_DIFF_ARTIFACT_ID, kind: 'patch', contentType: 'text/plain', content: Buffer.from(fixture.reviewDiffText) })
  if (fixture.deltaDiffText !== undefined) files.push({ artifact_id: DELTA_DIFF_ID, kind: 'patch', contentType: 'text/plain', content: Buffer.from(fixture.deltaDiffText) })
  return files
}

const ev = (sequence: number, time: string, node: string, status: string, message: string): InternalEvent => ({ sequence, time, node, status, message })

/** A raw worker input for a lane: the viewer lane carries the impeccable skill, the shell lane none. */
function worker(lane: Lane): RawInputsSection['workers'][string] {
  const viewer = lane === 'viewer'
  return {
    role: 'frontend',
    required_check_kinds: viewer ? ['build', 'browser'] : ['build'],
    task: `# ${lane} worker\n\nRefine the run page. ${viewer ? 'The graph, the node pages, Assignment and the inline diff.' : 'Runs home, the rail, the header and the tokens.'}\n\nApproved ownership and checks:\n{"node_id": "${lane}"}`,
    prompt: null,
    owned_paths: viewer ? ['src/projects/WorkflowGraph.tsx', 'src/projects/dag.ts', 'src/projects/diff.ts'] : ['src/App.tsx', 'src/projects/theme.css'],
    checks: [
      { id: `${lane}-build`, kind: 'build', argv: ['npm', 'run', 'build'], command: 'npm run build', timeout_seconds: 300, scenarios: [] },
      ...(viewer ? [{ id: 'project-workflows-browser', kind: 'browser' as const, argv: ['npx', 'playwright', 'test'], command: 'npx playwright test', timeout_seconds: 1500, scenarios: [{ id: 'fix-loop-graph', description: 'the loop in the graph' }] }] : []),
    ],
    launch: {
      session_id: SESSIONS[lane], launch_token: 't'.repeat(36), launch_requested_at: at('08:00:08'),
      native_started_at: Date.parse(at('08:00:10')), observed_state: 'done', status: 'attached_session_available', launcher_invocations: 1, background_id: `bg-${lane}`,
    },
    completion: { version: '1.1.0', status: 'completed', summary: `Refined the ${lane} surface.`, open_assumptions: [], untested: [], falsifying_check: `${lane}-build`, verify_yourself: 'open the run page' },
    handoff: { summary: `Refined the ${lane} surface.`, open_assumptions: [] },
    stop: { stopped: true, confirmed_at: at('09:00:00') },
    questions: [],
  }
}

function inputsOf(feature: string, mode: 'automatic' | 'manual' = 'automatic'): RawInputsSection {
  return {
    feature, policy_version: '1.2.0', base_commit: BASE_COMMIT, source_branch: `feature/${UX_REFINE_WORKFLOW_ID}`, mode,
    automatic: mode === 'manual' ? null : { finish: 'verified-feature-branch', permission_mode: 'bypassPermissions', worker_timeout_seconds: 14400, review_timeout_seconds: 1800, reviewer_transport: 'native' },
    setup: [{ argv: ['npm', 'ci'], command: 'npm ci', timeout_seconds: 600 }],
    max_verification_attempts: 3,
    failure_drill: null,
    selected_workers: [...LANES],
    excluded_workers: [],
    workers: Object.fromEntries(LANES.map(lane => [lane, worker(lane)])),
    decisions: '# Decisions\n\nThe fix loop becomes part of the graph.',
  }
}

// The review diff is registered with the real content hash and byte count so the candidate-phase artifact route serves it
// (the route refuses bytes that do not match its registration); a round with no diff text registers none.
const reviewSection = (findings: RawReviewSection['findings'] = [], diffText?: string): RawReviewSection => ({
  attempt: 2, transport: 'native', reviewer_session_id: REVIEW_SESSION, independent: true, bundle_sha256: 'b'.repeat(64),
  candidate_commit: CANDIDATE_COMMIT, verdict: 'approved', findings, reviewed_at: at('10:05:00'),
  diff: diffText === undefined ? null : { path: 'review.diff', sha256: sha256(Buffer.from(diffText)), bytes: Buffer.byteLength(diffText) },
})

const DIFF_TEXT = [
  'diff --git a/src/projects/WorkflowGraph.tsx b/src/projects/WorkflowGraph.tsx',
  '--- a/src/projects/WorkflowGraph.tsx',
  '+++ b/src/projects/WorkflowGraph.tsx',
  '@@ -115,4 +115,6 @@ export function WorkflowGraph() {',
  '   const layout = useMemo(() => layoutDag(nodes), [nodes])',
  '-  const returns = edgesFromDependsOn(nodes)',
  '+  const returns = fixLoop.repairs.map(repair => ({ from: repair.node_id, to: repair.blocked_step }))',
  '+  // the return mark is a drawing from the fix loop, never a dependency edge',
  '   return <svg>{returns}</svg>',
  'diff --git a/public/diagram.png b/public/diagram.png',
  'GIT binary patch',
  'literal 2048',
  '',
].join('\n')

const DELTA_DIFF_TEXT = [
  'diff --git a/src/projects/WorkflowGraph.tsx b/src/projects/WorkflowGraph.tsx',
  '--- a/src/projects/WorkflowGraph.tsx',
  '+++ b/src/projects/WorkflowGraph.tsx',
  '@@ -116,2 +116,2 @@ export function WorkflowGraph() {',
  '-  const returns = edgesFromDependsOn(nodes)',
  '+  const returns = fixLoop.repairs.map(repair => ({ from: repair.node_id, to: repair.blocked_step }))',
  '',
].join('\n')

const FIXTURES: Fixture[] = [
  {
    // Paused at the design challenge, attempt 4 found 1 P1, no worker launched (run-first-screen's paused fixture).
    runId: RUN_CHALLENGE,
    nodes: refineNodes({ challenge: true }),
    states: { challenge: { status: 'paused', attempt: 4, session: REVIEW_SESSION } },
    loop: null,
    status: 'paused',
    updatedAt: at('08:05:00'),
    events: [ev(1, at('08:00:10'), 'challenge', 'running', 'Design challenge attempt 4 launched'), ev(2, at('08:05:00'), 'challenge', 'paused', 'Design challenge attempt 4 found 1 P1 concern; paused for the operator')],
    inputs: { ...inputsOf('Viewer refine'), challenge: { status: 'paused', attempt: 4, session_id: REVIEW_SESSION, pinned: { tasks_sha256: 'a'.repeat(64), decisions_sha256: 'b'.repeat(64), prd_sha256: null }, concerns: [{ severity: 'P1', kind: 'assumption', message: 'A next step whose later command is an alternative is hidden as a sequence step.', consequence: 'The operator copies the wrong branch.' }], simpler_alternative: 'keep the banner', cheap_experiment: 'mock it', accepted_reason: null, decided_at: at('08:05:00'), attempts: 4 } },
  },
  {
    // The worked example: two applied repairs, round 2 approved, integrated (run-first-screen succeeded + fix-loop-graph).
    runId: RUN_LOOP_DONE,
    nodes: refineNodes(),
    states: workedStates(2),
    loop: fixLoop,
    status: 'succeeded',
    updatedAt: at('10:10:00'),
    events: [
      ev(1, at('08:00:10'), 'launch_viewer', 'running', 'Launching the viewer worker'),
      ev(2, at('08:00:10'), 'launch_shell', 'running', 'Launching the shell worker'),
      ev(3, at('08:10:00'), 'handoff', 'succeeded', 'Captured both worker snapshots'),
      ev(4, at('08:12:40'), 'verify_viewer', 'blocked', 'frontend-unit-regression failed: 1 of 42 tests failed'),
      ev(5, at('08:31:02'), 'verify_viewer', 'succeeded', 'Repair 1 (viewer, round 1 of 2) after verify blocked; attempt 2 passed'),
      ev(6, at('08:35:00'), 'verify_shell', 'succeeded', 'shell verification passed'),
      ev(7, at('09:00:00'), 'candidate', 'succeeded', 'Combined candidate checks passed'),
      ev(8, at('09:40:10'), 'review', 'running', 'Launching reviewer general over the shared review worktree'),
      ev(9, at('10:02:48'), 'review', 'succeeded', 'Repair 2 (viewer, round 2 of 2) after review blocked; round 2 approved'),
      ev(10, at('10:10:00'), 'integrate', 'succeeded', 'Fast-forwarded the feature branch'),
    ],
    inputs: inputsOf('Viewer refine'),
    review: reviewSection([], DIFF_TEXT),
    reviewRound: 2,
    deltaFrom: DELTA_FROM,
    reviewDiffText: DIFF_TEXT,
    deltaDiffText: DELTA_DIFF_TEXT,
  },
  {
    // Mid-round: repair 2 launched, its session not yet bound; the review step re-entered (run-first-screen running).
    runId: RUN_LOOP_RUNNING,
    nodes: refineNodes(),
    states: {
      launch_viewer: done(VIEWER_SESSION, 'viewer'), launch_shell: done(SHELL_SESSION, 'shell'), handoff: done(),
      verify_viewer: { ...done(VIEWER_SESSION, 'viewer'), attempt: 2 }, verify_shell: done(SHELL_SESSION, 'shell'),
      candidate: { ...done() },
      review: { status: 'running', attempt: 1, session: REVIEW_SESSION },
    },
    loop: fixLoopLaunched,
    updatedAt: at('09:40:12'),
    events: [
      ev(1, at('08:00:10'), 'launch_viewer', 'running', 'Launching the viewer worker'),
      ev(2, at('08:00:10'), 'launch_shell', 'running', 'Launching the shell worker'),
      ev(3, at('08:10:00'), 'handoff', 'succeeded', 'Captured both worker snapshots'),
      ev(4, at('08:31:02'), 'verify_viewer', 'succeeded', 'Repair 1 (viewer, round 1 of 2) after verify blocked; attempt 2 passed'),
      ev(5, at('08:35:00'), 'verify_shell', 'succeeded', 'shell verification passed'),
      ev(6, at('09:00:00'), 'candidate', 'succeeded', 'Combined candidate checks passed'),
      ev(7, at('09:40:10'), 'review', 'running', 'Repair 2 (viewer, round 2 of 2) after review blocked; round 2 launched'),
    ],
    inputs: inputsOf('Viewer refine'),
  },
  {
    // A review-round repair ended blocked: the round is restored, the run stops controller_blocked (fix-loop-graph).
    runId: RUN_LOOP_RESTORED,
    nodes: refineNodes(),
    states: {
      launch_viewer: done(VIEWER_SESSION, 'viewer'), launch_shell: done(SHELL_SESSION, 'shell'), handoff: done(),
      verify_viewer: done(VIEWER_SESSION, 'viewer'), verify_shell: done(SHELL_SESSION, 'shell'),
      candidate: { ...done() },
      review: { status: 'failed', attempt: 1, session: REVIEW_SESSION, review: 1 },
    },
    loop: fixLoopRestored,
    status: 'failed',
    updatedAt: at('11:40:12'),
    events: [
      ev(1, at('08:00:10'), 'launch_viewer', 'running', 'Launching the viewer worker'),
      ev(2, at('08:00:10'), 'launch_shell', 'running', 'Launching the shell worker'),
      ev(3, at('08:10:00'), 'handoff', 'succeeded', 'Captured both worker snapshots'),
      ev(4, at('08:35:00'), 'verify_viewer', 'succeeded', 'viewer verification passed'),
      ev(5, at('08:36:00'), 'verify_shell', 'succeeded', 'shell verification passed'),
      ev(6, at('09:00:00'), 'candidate', 'succeeded', 'Combined candidate checks passed'),
      ev(7, at('11:02:39'), 'review', 'blocked', 'Reviewer general blocked the candidate: 1 open P1'),
      ev(8, at('11:40:12'), 'controller', 'blocked', 'Repair 1 (viewer, round 1 of 2) after review blocked: the repair session ended without a completion file; the round was restored and the fix loop is exhausted'),
    ],
    inputs: inputsOf('Viewer refine'),
    review: { ...reviewSection(fixLoopRestored.repairs[0].findings.map(finding => ({ ...finding, reviewer: 'review' }))), attempt: 1, verdict: 'blocked' },
    reviewRound: 1,
  },
  {
    // A failed shell verify while the viewer launch still runs: the lane chips show a failed and a running tone.
    runId: RUN_LANE_TONES,
    nodes: refineNodes(),
    states: {
      launch_viewer: { status: 'running', attempt: 1, session: VIEWER_SESSION }, launch_shell: done(SHELL_SESSION, 'shell'), handoff: done(),
      verify_shell: { status: 'failed', attempt: 1, session: SHELL_SESSION, result: 'shell' },
    },
    loop: null,
    status: 'failed',
    updatedAt: at('08:40:00'),
    events: [
      ev(1, at('08:00:10'), 'launch_viewer', 'running', 'Launching the viewer worker'),
      ev(2, at('08:00:10'), 'launch_shell', 'running', 'Launching the shell worker'),
      ev(3, at('08:30:00'), 'handoff', 'succeeded', 'Captured the shell worker snapshot'),
      ev(4, at('08:40:00'), 'verify_shell', 'blocked', 'shell verification failed: 1 check failed'),
    ],
    inputs: inputsOf('Viewer refine'),
  },
]

// ---- Projection to the served payloads -----------------------------------------------------------------------------

/** Adds the 1.10.0 run-inputs keys the Raw projection does not carry: lane pins, skills and `fix_rounds`. */
function inputsWithPins(runId: string, section: RawInputsSection): RunInputs {
  const base = projectInputs(runId, section)
  return validateRunInputs({
    ...base,
    automatic: base.automatic ? { ...base.automatic, fix_rounds: 2 } : null,
    workers: base.workers.map(worker => worker.node_id === 'viewer'
      ? { ...worker, roles: { model: 'claude-opus-4-8', effort: 'medium' }, skills: [{ name: 'impeccable', sha256: 'e'.repeat(64) }] }
      : { ...worker, roles: null, skills: [] }),
  })
}

/** Adds the served review's 1.10.0 keys (round, delta base and delta diff artifact). */
function reviewWithRound(runId: string, fixture: Fixture): ReviewResult {
  const base = projectReview(runId, fixture.review!, Object.fromEntries(Object.entries(fixture.inputs.workers).map(([lane, worker]) => [lane, worker.task])), UX_REFINE_WORKFLOW_ID)
  return validateReviewResult({
    ...base,
    round: fixture.reviewRound ?? null,
    delta_from: fixture.deltaFrom ?? null,
    delta_diff: fixture.deltaFrom ? { artifact_id: DELTA_DIFF_ID, kind: 'patch', uri: `${apiRunPath(runId, UX_REFINE_WORKFLOW_ID)}/artifacts/${DELTA_DIFF_ID}`, sha256: 'd'.repeat(64) } : null,
  })
}

const EVENT_STATUS: Record<string, WorkflowEvent['status']> = { running: 'running', interactive: 'running', blocked: 'failed', failed: 'failed', succeeded: 'succeeded', approved: 'succeeded', paused: 'paused', interrupted: 'paused' }

function servedEvents(fixture: Fixture): WorkflowEvent[] {
  const known = new Set(fixture.nodes.map(node => node.node_id))
  return fixture.events.map(record => {
    const node_id = known.has(record.node) ? record.node : null
    const status = node_id ? EVENT_STATUS[record.status] ?? null : null
    return eventSchema.parse({
      contract_version: '1.0.0', run_id: fixture.runId, event_id: `${fixture.runId}:${record.sequence}`, sequence: record.sequence, occurred_at: record.time,
      node_id, attempt: node_id ? (/verify/.test(record.node) && /attempt 2/.test(record.message) ? 2 : 1) : 0,
      type: status ? 'status_changed' : 'log', status, message: record.message, artifact: null, result_uri: null, reused_from_attempt: null,
    })
  })
}

function detailOf(fixture: Fixture): RunDetail {
  const base = runDetail(fixture.runId, fixture.status ?? 'running', pinned(fixture.nodes), CREATED_AT, fixture.updatedAt, fixture.states, fixture.events.length)
  return projectDetail(base, fixture.loop, fixture.status)
}

export const payloads: UxPayloads = {
  workflows: [UX_REFINE_DEFINITION],
  runDetails: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, detailOf(fixture)])),
  runEvents: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, servedEvents(fixture)])),
  workerResults: {},
  runInputs: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, inputsWithPins(fixture.runId, fixture.inputs)])),
  reviewResults: Object.fromEntries(FIXTURES.flatMap(fixture => (fixture.review ? [[fixture.runId, reviewWithRound(fixture.runId, fixture)]] : []))),
  artifactFiles: Object.fromEntries(FIXTURES.map(fixture => [fixture.runId, artifactsOf(fixture)])),
}

/** The commands a lane's verification ran: the viewer lane also runs the browser suite, the shell lane only builds. */
const laneCommands = (lane: Lane): string[] => lane === 'viewer'
  ? ['npm run build', 'npx --no-install playwright test --config=tests/project-workflows/playwright.config.ts']
  : ['npm run build']

/** One log artifact per executed check, as `validateWorkerResult` requires and the packet registers. */
const laneArtifacts = (lane: Lane): ArtifactFile[] => laneCommands(lane).map((_, index) => ({
  artifact_id: `log-${index}-${lane}`, kind: 'log', content: Buffer.from(`${lane} check ${index} passed\n`), contentType: 'text/plain; charset=utf-8',
}))

/** A trusted check capture of one lane, so the real server folds its verify/candidate node to succeeded (gate passed). */
function laneWorkerResult(runId: string, lane: Lane, phase: 'worker' | 'candidate', attempt: number): WorkerResult {
  const cwd = `verification/${phase}/${lane}/${attempt}/worktree`
  return validateWorkerResult({
    contract_version: '1.0.0', run_id: runId, node_id: lane, attempt, session_id: SESSIONS[lane],
    status: 'succeeded', base_commit: BASE_COMMIT, output_commit: phase === 'candidate' ? CANDIDATE_COMMIT : BASE_COMMIT,
    changed_files: [],
    checks: checks(cwd, laneCommands(lane).map((command, index) => ({ command, log: `log-${index}-${lane}`, exit: 0, start: at('08:00:10'), finish: at('08:10:00') }))),
    open_assumptions: [], artifacts: artifactRefs(laneArtifacts(lane)),
    summary: `Trusted check capture of the ${lane} lane; not integration approval.`, error: null,
  })
}

/**
 * Seeds each run as the controller's own records so the real combined backend folds the same node statuses the worker-phase
 * mirror pins. The evidence a run carries follows its pinned `states`: a launch receipt for every lane not still launching, a
 * verification packet (gate passed) and freeze snapshot once a lane verified, the candidate bundle and per-lane candidate
 * packets once the combined candidate passed, and the review/approval/integration values as those steps succeed. A lane whose
 * launch still runs (the lane-tones example) is given no receipt, so its launch node reads running, not succeeded.
 */
function seed({ repository, runsRoot, writeRun, writePacket, receipt }: SeedContext) {
  const root = runsRoot(UX_REFINE_WORKFLOW_ID)
  for (const fixture of FIXTURES) {
    const runDir = `${root}/${fixture.runId}`
    const states = fixture.states
    const succeeded = (nodeId: string): boolean => states[nodeId]?.status === 'succeeded'
    const launchLanes = LANES.filter(lane => states[`launch_${lane}`]?.status !== 'running' && states[`launch_${lane}`]?.status !== 'pending')
    const verifiedLanes = LANES.filter(lane => succeeded(`verify_${lane}`))
    const values: Record<string, unknown> = {
      lanes: Object.fromEntries(launchLanes.map(lane => [lane, receipt(lane, runDir, SESSIONS[lane], at('08:00:08'))])),
    }
    if (succeeded('handoff')) values.snapshots = Object.fromEntries(launchLanes.map(lane => [lane, CANDIDATE_COMMIT]))
    if (verifiedLanes.length > 0) values.packets = Object.fromEntries(verifiedLanes.map(lane => [lane, `verification/worker/${lane}/1/packet.json`]))
    if (succeeded('candidate')) values.bundle = { run_id: fixture.runId, base_commit: BASE_COMMIT, candidate_commit: CANDIDATE_COMMIT, policy_sha256: 'e'.repeat(64) }
    if (succeeded('review')) values.review = { run_id: fixture.runId, verdict: 'approved', independent: true, reviewer: REVIEW_SESSION, findings: [] }
    if (succeeded('approval')) values.approved_bundle = 'f'.repeat(64)
    if (succeeded('integrate')) values.integrated_commit = CANDIDATE_COMMIT
    writeRun(root, repository, fixture.runId, {
      createdAt: CREATED_AT, updatedAt: fixture.updatedAt, definitionNodes: fixture.nodes, definitionName: UX_REFINE_WORKFLOW_NAME, version: '1.10.0', lanes: [...LANES],
      values,
      next: [], tasks: [],
      events: fixture.events,
      packets: dir => [
        ...verifiedLanes.map(lane => writePacket(dir, 'worker', lane, states[`verify_${lane}`]!.attempt, laneWorkerResult(fixture.runId, lane, 'worker', states[`verify_${lane}`]!.attempt), laneArtifacts(lane), { status: 'passed', reasons: [] })),
        ...(succeeded('candidate') ? verifiedLanes.map(lane => writePacket(dir, 'candidate', lane, 1, laneWorkerResult(fixture.runId, lane, 'candidate', 1), laneArtifacts(lane), { status: 'passed', reasons: [] })) : []),
      ],
      inputs: fixture.inputs,
      review: fixture.review ?? null,
      reviewRound: fixture.reviewRound,
      deltaFrom: fixture.deltaFrom ?? null,
      fixLoop: fixture.loop,
      roles: { viewer: { model: 'claude-opus-4-8', effort: 'medium' }, shell: null },
      skills: { viewer: [{ name: 'impeccable', sha256: 'e'.repeat(64) }], shell: [] },
      fixRounds: 2,
      diff: fixture.reviewDiffText,
      deltaDiff: fixture.deltaDiffText,
    })
  }
  return { workflows: [{ workflow_id: UX_REFINE_WORKFLOW_ID, runs_root: root, definition: { name: UX_REFINE_WORKFLOW_NAME, nodes: refineNodes() } }] }
}

export const uxRefine: UxFixtureModule = { payloads, seed }

/** The projected details of the three fix-loop example records, for the drift-guard unit test. */
export const REFINE_EXAMPLES: { runId: string; loop: FixLoop; detail: RunDetail }[] = FIXTURES
  .filter(fixture => fixture.loop !== null)
  .map(fixture => ({ runId: fixture.runId, loop: fixture.loop!, detail: payloads.runDetails![fixture.runId] }))
