/**
 * Fixtures of the critique reviewer's evidence on the run page (`critique.spec.ts`, docs/PRD_USER_CRITIQUE.md 4.5 and
 * Appendix A), registered as the workflow `ux-critique`. One run, `run-critique`, derived from the contract examples
 * (`contracts/projects/examples.ts`: `critiqueReviewResult`, `critiqueFixLoop`) into one coherent two-lane run
 * (`pages`, `shell`), as design challenge note 1 asks:
 *
 * - the live review is round 2, attempt 2, blocked: the native reviewer `general` approved (one P2, no evidence) and the
 *   headless critique job blocked on an open P1 of the `pages` lane (its steps and one screenshot) plus an open P1 of the
 *   `shell` lane recorded with no screenshot ("no screenshot");
 * - one archived round, round 1 (blocked, lane `pages`, `archived: true`): the fix loop's repair answered the `review`
 *   step; it carries a critique P1 with its own distinct evidence (a distinct screenshot and steps, design challenge
 *   note 3) and a `general` P1 with no evidence, so "Earlier rounds" shows each reviewer's finding.
 *
 * Both phases, as `index.ts` runs them (design challenge note 2):
 * - worker phase: `payloads` serves the `RunDetail` with the fix loop projected by `ux-refine`'s `projectDetail`, the
 *   `ReviewResult` built with `validateReviewResult` (so it carries `evidence`), and the critique screenshots as artifact
 *   files the mock serves by id.
 * - candidate phase: `seed` writes a 1.10.0 export whose review section carries the 1.11.0 `evidence` and
 *   `critique_artifacts` (the server accepts them on a 1.10.0 seed; it does not gate them by version) and whose
 *   `critique/<round>/` holds the real PNG files the artifact route serves, with the registered sha256 and byte count.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  validateReviewResult, type FixLoop, type FixLoopFinding, type ReviewResult, type RunDetail, type RunInputs, type WorkflowDefinition,
} from '../../../contracts/projects/v1.ts'
import { eventSchema, validateWorkerResult, type WorkerResult, type WorkflowEvent } from '../../../contracts/workflow/v1.ts'
import {
  BASE_COMMIT, CANDIDATE_COMMIT, PROJECT, artifactRefs, backgroundId, checks, definition, laneGraphNodes,
  launchToken, offset, projectInputs, runDetail, sha256, solidPng,
  type ArtifactFile, type DefinitionNode, type NodeState, type RawInputsSection, type RawReviewSection, type RawWorkerInput,
} from '../fixtures.ts'
import type { InternalEvent, SeedContext } from '../seed.ts'
import { projectDetail } from './ux-refine.ts'
import type { UxFixtureModule, UxPayloads } from './index.ts'

export const UX_CRITIQUE_WORKFLOW_ID = 'ux-critique'
export const UX_CRITIQUE_WORKFLOW_NAME = 'UX critique'
export const RUN_CRITIQUE = 'run-critique'

const DAY = '2026-10-09'
const at = (clock: string) => `${DAY}T${clock}Z`
const CREATED_AT = at('08:00:00')
const UPDATED_AT = at('10:40:00')

type Lane = 'pages' | 'shell'
const LANES: readonly Lane[] = ['pages', 'shell']
const SESSIONS: Record<Lane, string> = { pages: 'aa11bb22-cc33-4d44-8e55-ff6677889900', shell: 'bb22cc33-dd44-4e55-8f66-001122334455' }
const GENERAL_SESSION = '3f0c2a44-9f5b-4d0e-8c0a-5a6b7c8d9e01'
const CRITIQUE_SESSION = '9d4e5f60-1b2c-4d3e-8f09-aabbccddeeff'
const REPAIR_SESSION = '0c9b8a7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d'
const JOINED = `${GENERAL_SESSION}, ${CRITIQUE_SESSION}`
const BUNDLE = 'b'.repeat(64)

// ---- The critique screenshots: real (decodable) PNG bytes, two distinct solid colours, their ids from the content hash ----
const LIVE_SHOT = solidPng(96, 64, [47, 122, 75])
const ARCHIVED_SHOT = solidPng(96, 64, [122, 47, 75])
/** Live round 2's screenshot, under critique/2/; the archived round 1's, under critique/1/ — distinct ids and captions. */
const LIVE_ID = `critique-2-${sha256(LIVE_SHOT).slice(0, 12)}`
const ARCHIVED_ID = `critique-1-${sha256(ARCHIVED_SHOT).slice(0, 12)}`
const LIVE_PATH = 'critique/2/run-spinner.png'
const ARCHIVED_PATH = 'critique/1/run-disabled.png'
export const LIVE_CAPTION = 'After clicking Run: the spinner never ends'
export const ARCHIVED_CAPTION = 'Round 1: the Run button is disabled with no hint'

export const LIVE_P1_MESSAGE = 'Run a review: the "Run" button on the first row spins forever and never shows the verdict.'
export const NO_SHOT_P1_MESSAGE = 'The findings filter on the shell traps keyboard focus: Tab never leaves the toggle row.'
export const ARCHIVED_P1_MESSAGE = 'Run a review: the "Run" button on the first row is disabled with no hint why.'
export const GENERAL_P2_MESSAGE = 'The findings table omits the disposition column on narrow screens.'
export const GENERAL_ARCHIVED_P1_MESSAGE = 'The verdict badge is announced twice to a screen reader on the review node.'

/** The shared first step of the critique's run-flow reproduction; free of any path the server would redact to `<path>`. */
export const FIRST_STEP = 'Open the alpha project run page'

// ---- The findings (contract shapes) --------------------------------------------------------------------------------
type Finding = ReviewResult['findings'][number]
type Reviewer = ReviewResult['reviewers'][number]

const LIVE_FINDINGS: Finding[] = [
  { severity: 'P2', message: GENERAL_P2_MESSAGE, disposition: 'open', worker: 'pages', requirement: null, requirement_found_in: [], reviewer: 'general' },
  {
    severity: 'P1', message: LIVE_P1_MESSAGE, disposition: 'open', worker: 'pages', requirement: null, requirement_found_in: [], reviewer: 'critique',
    evidence: { steps: [FIRST_STEP, "Click 'Run' on the first row", 'Wait 30s: the spinner never ends'], screenshots: [{ artifact_id: LIVE_ID, caption: LIVE_CAPTION }] },
  },
  {
    severity: 'P1', message: NO_SHOT_P1_MESSAGE, disposition: 'open', worker: 'shell', requirement: null, requirement_found_in: [], reviewer: 'critique',
    evidence: { steps: ['Open the shell findings filter at 390 px', 'Tab into the toggle row', 'Tab again: focus never leaves the toggles'], screenshots: [] },
  },
]
const LIVE_GENERAL = LIVE_FINDINGS.filter(finding => finding.reviewer === 'general')
const LIVE_CRITIQUE = LIVE_FINDINGS.filter(finding => finding.reviewer === 'critique')

// The fix loop's findings (archived round and repair) carry no `requirement_found_in` (FixLoopFinding; the server computes it).
const ARCHIVED_FINDINGS: FixLoopFinding[] = [
  {
    severity: 'P1', message: ARCHIVED_P1_MESSAGE, disposition: 'open', worker: 'pages', requirement: null, reviewer: 'critique',
    evidence: { steps: [FIRST_STEP, "Hover the disabled 'Run' button", 'No tooltip or hint is shown'], screenshots: [{ artifact_id: ARCHIVED_ID, caption: ARCHIVED_CAPTION }] },
  },
  { severity: 'P1', message: GENERAL_ARCHIVED_P1_MESSAGE, disposition: 'open', worker: 'pages', requirement: null, reviewer: 'general' },
]

// ---- The fix loop (export 1.10.0 + the 1.11.0 evidence on the archived round) ---------------------------------------
const LOOP: FixLoop = {
  contract_version: '1.10.0', source: 'export', version: '1.0.0', rounds: 2,
  repairs: [{
    n: 1, node_id: 'repair-1', mode: 'session', lane: 'pages', trigger: 'review', round: 1, rounds: 2, status: 'applied', by: 'controller',
    recorded_at: at('09:10:00'), applied_at: at('09:35:00'), blocked_step: 'review', reentered_steps: ['review'],
    reason: 'repair session round 1: review', workspace_commit: 'd'.repeat(40), session_id: REPAIR_SESSION, review_round: 1,
    findings: ARCHIVED_FINDINGS, delta: false, fix_files: ['src/pages/RunRow.tsx'], left_behind: [],
    requested: { model: 'claude-opus-4-8', effort: 'medium' }, gate_reasons: [],
  }],
  review_rounds: [{
    round: 1, verdict: 'blocked', candidate: CANDIDATE_COMMIT, lane: 'pages', findings: ARCHIVED_FINDINGS,
    reviewer_sessions: [GENERAL_SESSION, CRITIQUE_SESSION], started_at: at('09:00:10'), archived: true, restored_at: null, repair_n: 1,
    reviewers: [
      { reviewer_id: 'general', verdict: 'blocked', session_id: GENERAL_SESSION },
      { reviewer_id: 'critique', verdict: 'blocked', session_id: CRITIQUE_SESSION },
    ],
  }],
}

// ---- The graph and the states --------------------------------------------------------------------------------------
const NODES: DefinitionNode[] = laneGraphNodes(LANES)
export const UX_CRITIQUE_DEFINITION: WorkflowDefinition = definition(PROJECT.project_id, UX_CRITIQUE_WORKFLOW_ID, UX_CRITIQUE_WORKFLOW_NAME, NODES)

const done = (session?: string, result?: string): NodeState => ({ status: 'succeeded', attempt: 1, session: session ?? null, result: result ?? null })
const STATES: Record<string, NodeState> = {
  launch_pages: done(SESSIONS.pages, 'pages'), launch_shell: done(SESSIONS.shell, 'shell'), handoff: done(),
  verify_pages: done(SESSIONS.pages, 'pages'), verify_shell: done(SESSIONS.shell, 'shell'),
  candidate: { ...done(), lanes: LANES.map(lane => ({ worker: lane, attempt: 1 })) },
  review: { status: 'failed', attempt: 2, session: JOINED, review: 2 },
}

const EVENTS: InternalEvent[] = [
  { sequence: 1, time: at('08:00:10'), node: 'launch_pages', status: 'running', message: 'Launching the pages worker' },
  { sequence: 2, time: at('08:00:10'), node: 'launch_shell', status: 'running', message: 'Launching the shell worker' },
  { sequence: 3, time: at('08:30:00'), node: 'handoff', status: 'succeeded', message: 'Captured both worker snapshots' },
  { sequence: 4, time: at('08:45:00'), node: 'verify_pages', status: 'succeeded', message: 'pages verification passed' },
  { sequence: 5, time: at('08:46:00'), node: 'verify_shell', status: 'succeeded', message: 'shell verification passed' },
  { sequence: 6, time: at('09:00:00'), node: 'candidate', status: 'succeeded', message: 'Combined candidate checks passed' },
  { sequence: 7, time: at('09:00:10'), node: 'review', status: 'running', message: 'Launching the native reviewers and the headless critique job' },
  { sequence: 8, time: at('09:35:00'), node: 'review', status: 'running', message: 'Repair 1 (pages, round 1 of 2) after review blocked; round 2 launched' },
  { sequence: 9, time: at('10:40:00'), node: 'review', status: 'blocked', message: 'The headless critique job blocked the candidate: 1 open P1 on pages' },
]

// ---- The review (worker phase: built with evidence) ----------------------------------------------------------------
// The served ReviewResult carries UTC (Z) timestamps, as the contract requires (the raw export section uses `offset()`).
const reviewer = (id: string, verdict: Reviewer['verdict'], status: Reviewer['status'], findings: Finding[], accepted: string | null): Reviewer => ({
  reviewer_id: id, transport: 'native', session_id: id === 'general' ? GENERAL_SESSION : CRITIQUE_SESSION, verdict, findings,
  launched_at: at('09:00:10'), accepted_at: accepted === null ? null : at(accepted), status,
})

const REVIEW_RESULT: ReviewResult = validateReviewResult({
  contract_version: '1.4.0', run_id: RUN_CRITIQUE, node_id: 'review', attempt: 2,
  reviewer: { session_id: JOINED, transport: 'native', independent: true },
  bundle_sha256: BUNDLE, candidate_commit: CANDIDATE_COMMIT, verdict: 'blocked',
  findings: LIVE_FINDINGS,
  reviewers: [
    reviewer('general', 'approved', 'accepted', LIVE_GENERAL, '10:30:00'),
    reviewer('critique', 'blocked', 'blocked', LIVE_CRITIQUE, '10:40:00'),
  ],
  reviewed_at: at('10:40:00'), round: 2, delta_from: null, delta_diff: null, diff: null,
})

// ---- The run inputs (two lanes; raw section reused for both phases) -------------------------------------------------
function rawWorker(lane: Lane): RawWorkerInput {
  const pages = lane === 'pages'
  return {
    role: 'frontend', required_check_kinds: ['build'],
    task: `# ${lane} worker\n\nBuild the ${lane} surface.\n\nApproved ownership and checks:\n{"node_id": "${lane}"}`,
    prompt: null, owned_paths: pages ? ['src/pages'] : ['src/shell'],
    checks: [{ id: `${lane}-build`, kind: 'build', argv: ['npm', 'run', 'build'], command: 'npm run build', timeout_seconds: 300, scenarios: [] }],
    launch: {
      session_id: SESSIONS[lane], launch_token: launchToken(lane), launch_requested_at: offset(at('08:00:08')),
      native_started_at: Date.parse(at('08:00:10')), observed_state: 'done', status: 'attached_session_available', launcher_invocations: 1, background_id: backgroundId(lane),
    },
    completion: { version: '1.1.0', status: 'completed', summary: `Built the ${lane} surface.`, open_assumptions: [], untested: [], falsifying_check: `${lane}-build`, verify_yourself: 'open the run page' },
    handoff: { summary: `Built the ${lane} surface.`, open_assumptions: [] }, stop: { stopped: true, confirmed_at: offset(at('08:30:00')) }, questions: [],
  }
}

function inputsSection(): RawInputsSection {
  return {
    feature: 'User critique', policy_version: '1.4.0', base_commit: BASE_COMMIT, source_branch: `feature/${UX_CRITIQUE_WORKFLOW_ID}/${RUN_CRITIQUE}`, mode: 'automatic',
    automatic: { finish: 'verified-feature-branch', permission_mode: 'bypassPermissions', worker_timeout_seconds: 14400, review_timeout_seconds: 1800, reviewer_transport: 'native' },
    setup: [{ argv: ['npm', 'ci'], command: 'npm ci', timeout_seconds: 600 }], max_verification_attempts: 3, failure_drill: null,
    selected_workers: [...LANES], excluded_workers: [],
    workers: Object.fromEntries(LANES.map(lane => [lane, rawWorker(lane)])), decisions: null,
  }
}

// ---- The review section the candidate-phase export carries (1.10.0 + the 1.11.0 evidence and artifacts) -------------
type ReviewerWithEvidence = Omit<Reviewer, 'requirement_found_in'>
/** The raw review section with `evidence` on critique findings and the critique artifact list; cast because the Raw types
 * (fixtures.ts, not owned) predate 1.11.0, which the server accepts on a 1.10.0 seed (design challenge note 2). */
function candidateReview(): RawReviewSection {
  // The export's review findings carry no `requirement_found_in` (the server computes it); drop it from the contract shape.
  const strip = (findings: Finding[]): Omit<Finding, 'requirement_found_in'>[] => findings.map(finding => {
    const rest: Omit<Finding, 'requirement_found_in'> & { requirement_found_in?: unknown } = { ...finding }
    delete rest.requirement_found_in
    return rest
  })
  const reviewerSection = (id: string, verdict: Reviewer['verdict'], status: Reviewer['status'], findings: Finding[], accepted: string | null): ReviewerWithEvidence => ({
    reviewer_id: id, transport: 'native', session_id: id === 'general' ? GENERAL_SESSION : CRITIQUE_SESSION, verdict,
    findings: strip(findings) as Finding[], launched_at: offset(at('09:00:10')), accepted_at: accepted === null ? null : offset(at(accepted)), status,
  })
  return {
    attempt: 2, transport: 'native', reviewer_session_id: JOINED, independent: true, bundle_sha256: BUNDLE, candidate_commit: CANDIDATE_COMMIT,
    verdict: 'blocked', findings: strip(LIVE_FINDINGS) as RawReviewSection['findings'], reviewed_at: offset(at('10:40:00')), diff: null,
    reviewers: [
      reviewerSection('general', 'approved', 'accepted', LIVE_GENERAL, '10:30:00'),
      reviewerSection('critique', 'blocked', 'blocked', LIVE_CRITIQUE, '10:40:00'),
    ],
    critique_artifacts: [
      { id: LIVE_ID, kind: 'screenshot', path: LIVE_PATH, sha256: sha256(LIVE_SHOT), bytes: LIVE_SHOT.length },
      { id: ARCHIVED_ID, kind: 'screenshot', path: ARCHIVED_PATH, sha256: sha256(ARCHIVED_SHOT), bytes: ARCHIVED_SHOT.length },
    ],
  } as unknown as RawReviewSection
}

// ---- Worker-phase payloads -----------------------------------------------------------------------------------------
const SHOTS: ArtifactFile[] = [
  { artifact_id: LIVE_ID, kind: 'screenshot', content: LIVE_SHOT, contentType: 'image/png' },
  { artifact_id: ARCHIVED_ID, kind: 'screenshot', content: ARCHIVED_SHOT, contentType: 'image/png' },
]

const EVENT_STATUS: Record<string, WorkflowEvent['status']> = { running: 'running', blocked: 'failed', failed: 'failed', succeeded: 'succeeded' }
function servedEvents(): WorkflowEvent[] {
  const known = new Set(NODES.map(node => node.node_id))
  return EVENTS.map(record => {
    const node_id = known.has(record.node) ? record.node : null
    const status = node_id ? EVENT_STATUS[record.status] ?? null : null
    return eventSchema.parse({
      contract_version: '1.0.0', run_id: RUN_CRITIQUE, event_id: `${RUN_CRITIQUE}:${record.sequence}`, sequence: record.sequence, occurred_at: record.time,
      node_id, attempt: node_id === 'review' ? 2 : node_id ? 1 : 0, type: status ? 'status_changed' : 'log', status, message: record.message,
      artifact: null, result_uri: null, reused_from_attempt: null,
    })
  })
}

function detail(): RunDetail {
  const base = runDetail(RUN_CRITIQUE, 'failed', UX_CRITIQUE_DEFINITION, CREATED_AT, UPDATED_AT, STATES, EVENTS.length)
  return projectDetail(base, LOOP, 'failed')
}

const payloads: UxPayloads = {
  workflows: [UX_CRITIQUE_DEFINITION],
  runDetails: { [RUN_CRITIQUE]: detail() },
  runEvents: { [RUN_CRITIQUE]: servedEvents() },
  workerResults: {},
  reviewResults: { [RUN_CRITIQUE]: REVIEW_RESULT },
  runInputs: { [RUN_CRITIQUE]: projectInputs(RUN_CRITIQUE, inputsSection()) as RunInputs },
  artifactFiles: { [RUN_CRITIQUE]: SHOTS },
}

// ---- Candidate-phase seed ------------------------------------------------------------------------------------------
/** One trusted lane check capture, so the real server folds the lane's verify/candidate node to succeeded. */
function laneWorkerResult(lane: Lane, phase: 'worker' | 'candidate'): WorkerResult {
  const cwd = `verification/${phase}/${lane}/1/worktree`
  return validateWorkerResult({
    contract_version: '1.0.0', run_id: RUN_CRITIQUE, node_id: lane, attempt: 1, session_id: SESSIONS[lane],
    status: 'succeeded', base_commit: BASE_COMMIT, output_commit: phase === 'candidate' ? CANDIDATE_COMMIT : BASE_COMMIT, changed_files: [],
    checks: checks(cwd, [{ command: 'npm run build', log: `log-0-${lane}`, exit: 0, start: at('08:00:10'), finish: at('08:10:00') }]),
    open_assumptions: [], artifacts: artifactRefs([{ artifact_id: `log-0-${lane}`, kind: 'log', content: Buffer.from(`${lane} build passed\n`), contentType: 'text/plain; charset=utf-8' }]),
    summary: `Trusted check capture of the ${lane} lane; not integration approval.`, error: null,
  })
}

function seed({ repository, runsRoot, writeRun, writePacket, receipt, leakFor }: SeedContext): { workflows: { workflow_id: string; runs_root: string; definition: { name: string; nodes: DefinitionNode[] } }[] } {
  const root = runsRoot(UX_CRITIQUE_WORKFLOW_ID)
  const runDir = join(root, RUN_CRITIQUE)
  const laneArtifact = (lane: Lane): ArtifactFile[] => [{ artifact_id: `log-0-${lane}`, kind: 'log', content: Buffer.from(`${lane} build passed\n`), contentType: 'text/plain; charset=utf-8' }]
  writeRun(root, repository, RUN_CRITIQUE, {
    createdAt: CREATED_AT, updatedAt: UPDATED_AT, definitionNodes: NODES, definitionName: UX_CRITIQUE_WORKFLOW_NAME, version: '1.10.0', lanes: [...LANES],
    values: {
      lanes: Object.fromEntries(LANES.map(lane => [lane, receipt(lane, runDir, SESSIONS[lane], at('08:00:08'))])),
      snapshots: Object.fromEntries(LANES.map(lane => [lane, CANDIDATE_COMMIT])),
      packets: Object.fromEntries(LANES.map(lane => [lane, `verification/worker/${lane}/1/packet.json`])),
      bundle: { run_id: RUN_CRITIQUE, base_commit: BASE_COMMIT, candidate_commit: CANDIDATE_COMMIT, policy_sha256: 'e'.repeat(64) },
    },
    next: [],
    tasks: [{ node_id: 'review', error: `The headless critique job blocked the candidate; see ${join(runDir, 'review.json')}`, interrupts: [], result: null }],
    events: EVENTS,
    packets: directory => [
      ...LANES.map(lane => writePacket(directory, 'worker', lane, 1, laneWorkerResult(lane, 'worker'), laneArtifact(lane), { status: 'passed', reasons: [] })),
      ...LANES.map(lane => writePacket(directory, 'candidate', lane, 1, laneWorkerResult(lane, 'candidate'), laneArtifact(lane), { status: 'passed', reasons: [] })),
    ],
    inputs: inputsSection(),
    review: candidateReview(),
    reviewRound: 2,
    deltaFrom: null,
    fixLoop: LOOP,
    roles: { pages: { model: 'claude-opus-4-8', effort: 'medium' }, shell: null },
    skills: { pages: [{ name: 'impeccable', sha256: 'e'.repeat(64) }], shell: [] },
    fixRounds: 2,
  })
  // The critique screenshots the artifact route serves: real PNG bytes at the registered run-relative paths (PRD 4.5).
  for (const shot of [{ path: LIVE_PATH, content: LIVE_SHOT }, { path: ARCHIVED_PATH, content: ARCHIVED_SHOT }]) {
    const destination = join(runDir, shot.path)
    mkdirSync(join(destination, '..'), { recursive: true })
    writeFileSync(destination, shot.content)
  }
  void leakFor
  return { workflows: [{ workflow_id: UX_CRITIQUE_WORKFLOW_ID, runs_root: root, definition: { name: UX_CRITIQUE_WORKFLOW_NAME, nodes: NODES } }] }
}

export const uxCritique: UxFixtureModule = { payloads, seed }

/** The projected detail for the drift-guard unit test (worker-phase payload). */
export const CRITIQUE_EXAMPLE = { runId: RUN_CRITIQUE, loop: LOOP, review: REVIEW_RESULT, liveId: LIVE_ID, archivedId: ARCHIVED_ID }
