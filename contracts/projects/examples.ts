import type { WorkerResult } from '../workflow/v1.js'
import type { ReviewFinding, ReviewResult, RunDetail, RunInputs, SidecarLedger, SidecarLedgerFile } from './v1.js'

/**
 * A run as contract 1.5.0 serves it: the summary carries the run's `activity` (a list row reads it without further requests)
 * and the detail its `run_dir`, served home-relative because the registry lists the project in `viewer.expose_run_dir`.
 */
export const runDetail: RunDetail = {
  summary: {
    contract_version: '1.5.0', project_id: 'md-manager', workflow_id: 'feature-implementation',
    definition_revision: 'a'.repeat(64), run_id: 'run-001', status: 'running',
    created_at: '2026-01-01T12:00:00Z', updated_at: '2026-01-01T12:01:00Z',
    activity: {
      feature: 'Review verdict and findings in the viewer', last_activity_at: '2026-01-01T12:00:50Z', finished_at: null,
      focus: { node_id: 'adapter', label: 'Adapter worker', status: 'running', since: '2026-01-01T12:00:50Z' },
      attention: { kind: 'question', node_id: 'adapter', since: '2026-01-01T12:00:50Z' },
      waiting_questions: 1,
      headline: 'Adapter worker · Worker adapter asked question 1 of 3; its deadline is paused until `python -m workflow answer <path> adapter "<text>"`',
      controller: 'running',
    },
  },
  definition: {
    contract_version: '1.0.0', project_id: 'md-manager', workflow_id: 'feature-implementation',
    definition_revision: 'a'.repeat(64), name: 'Feature implementation',
    nodes: [
      { node_id: 'ui', label: 'UI worker', kind: 'worker', depends_on: [] },
      { node_id: 'adapter', label: 'Adapter worker', kind: 'worker', depends_on: [] },
      { node_id: 'review', label: 'Independent review', kind: 'review', depends_on: ['ui', 'adapter'] },
    ],
  },
  snapshot: {
    contract_version: '1.0.0', run_id: 'run-001', status: 'running', last_sequence: 2,
    nodes: [
      { node_id: 'ui', kind: 'worker', depends_on: [], status: 'succeeded', attempt: 1, session_id: 'ui-session', result_uri: '/api/projects/md-manager/workflows/feature-implementation/runs/run-001/results/ui/1', lane_results: [] },
      { node_id: 'adapter', kind: 'worker', depends_on: [], status: 'running', attempt: 1, session_id: 'adapter-session', result_uri: null, lane_results: [] },
      { node_id: 'review', kind: 'review', depends_on: ['ui', 'adapter'], status: 'pending', attempt: 0, session_id: null, result_uri: null, lane_results: [] },
    ],
  },
  run_dir: '~/.local/state/md-manager-workflows/feature-implementation/run-001',
}

/** The same run from a server before contract 1.5.0 (and in the viewer's worker-phase mocks): a 1.0.0 summary, neither field. */
export const legacyRunDetail: RunDetail = {
  summary: {
    contract_version: '1.0.0', project_id: 'md-manager', workflow_id: 'feature-implementation',
    definition_revision: 'a'.repeat(64), run_id: 'run-001', status: 'running',
    created_at: '2026-01-01T12:00:00Z', updated_at: '2026-01-01T12:01:00Z',
  },
  definition: runDetail.definition,
  snapshot: runDetail.snapshot,
}
export const projectList = { projects: [{ project_id: 'md-manager', name: 'MD Manager' }] }
export const workflowList = { workflows: [runDetail.definition] }
export const runList = { runs: [runDetail.summary], next_cursor: null }

const UI_TASK = '# UI worker\n\nRender the review verdict on the review node. Show every finding with severity and disposition.\n\nApproved ownership and checks:\n{"node_id": "ui"}'

const GENERAL_FINDINGS: ReviewFinding[] = [
  {
    severity: 'P2', message: 'The findings table omits the disposition column on narrow screens.', disposition: 'open',
    worker: 'ui', requirement: 'Show every finding with severity and disposition.', requirement_found_in: ['ui'], reviewer: 'general',
  },
  {
    severity: 'P2', message: 'The root Playwright suite is not part of the policy check set.', disposition: 'accepted',
    worker: 'none', requirement: null, requirement_found_in: [], reviewer: 'general',
  },
]
const COVERAGE_FINDINGS: ReviewFinding[] = [
  {
    severity: 'P2', message: 'The review route and its panel disagree about the attempt number.', disposition: 'resolved',
    worker: 'multiple', requirement: null, requirement_found_in: [], reviewer: 'coverage',
  },
  {
    severity: 'P2', message: 'The findings table omits the disposition column on narrow screens.', disposition: 'open',
    worker: 'ui', requirement: 'Show every finding with severity and disposition.', requirement_found_in: ['ui'], reviewer: 'coverage',
  },
]

/**
 * A recorded review by two reviewers (`general` and `coverage`) over the same bundle: both approved, the combined list is the
 * union of their findings tagged by reviewer (the same defect reported twice is kept twice), and `reviewers` records each one.
 */
export const reviewResult: ReviewResult = {
  contract_version: '1.4.0', run_id: 'run-001', node_id: 'review', attempt: 1,
  reviewer: { session_id: '3f0c2a44-9f5b-4d0e-8c0a-5a6b7c8d9e01, 7a1d9c02-4b3e-4f60-9d21-0c8e5f6a7b02', transport: 'native', independent: true },
  bundle_sha256: 'b'.repeat(64), candidate_commit: 'c'.repeat(40),
  verdict: 'approved',
  findings: [...GENERAL_FINDINGS, ...COVERAGE_FINDINGS],
  reviewers: [
    {
      reviewer_id: 'general', transport: 'native', session_id: '3f0c2a44-9f5b-4d0e-8c0a-5a6b7c8d9e01', verdict: 'approved', findings: GENERAL_FINDINGS,
      launched_at: '2026-01-01T12:10:00Z', accepted_at: '2026-01-01T12:28:00Z', status: 'accepted',
    },
    {
      reviewer_id: 'coverage', transport: 'native', session_id: '7a1d9c02-4b3e-4f60-9d21-0c8e5f6a7b02', verdict: 'approved', findings: COVERAGE_FINDINGS,
      launched_at: '2026-01-01T12:10:05Z', accepted_at: '2026-01-01T12:30:00Z', status: 'accepted',
    },
  ],
  reviewed_at: '2026-01-01T12:30:00Z',
  diff: { artifact_id: 'patch-review-2bb474561d3e', kind: 'patch', uri: '/api/projects/md-manager/workflows/feature-implementation/runs/run-001/artifacts/patch-review-2bb474561d3e', sha256: 'd'.repeat(64) },
}

const ARTIFACTS = '/api/projects/md-manager/workflows/feature-implementation/runs/run-001/artifacts'

/**
 * The served worker-phase result of the `ui` lane (`.../results/verify_ui/1`), validated by workflow v1 `workerResult`:
 * scoped artifact links, the changed text files captured as `file` artifacts with their repo-relative `path`, and
 * the changed paths that were not captured with the reason. Results recorded before capture carry neither.
 */
export const servedWorkerResult: WorkerResult = {
  contract_version: '1.0.0', run_id: 'run-001', node_id: 'verify_ui', attempt: 1, session_id: 'ui-session', status: 'succeeded',
  base_commit: 'a'.repeat(40), output_commit: 'b'.repeat(40),
  changed_files: ['src/projects/NodeDetail.tsx', 'docs/VIEWER.md', 'public/graph.png', 'fixtures/large.json', 'src/projects/Old.tsx'],
  checks: [{ command: 'npm run build', cwd: 'verification/worker/ui/1/worktree', started_at: '2026-01-01T12:01:00Z', finished_at: '2026-01-01T12:02:00Z', exit_code: 0, log_artifact_id: 'log-2-3c1f0e9a2b4d' }],
  open_assumptions: [],
  artifacts: [
    { artifact_id: 'file-0-9d2e4c1b7a60', kind: 'file', path: 'src/projects/NodeDetail.tsx', uri: `${ARTIFACTS}/file-0-9d2e4c1b7a60`, sha256: '9'.repeat(64) },
    { artifact_id: 'file-1-5b8a3f0c2e17', kind: 'file', path: 'docs/VIEWER.md', uri: `${ARTIFACTS}/file-1-5b8a3f0c2e17`, sha256: '5'.repeat(64) },
    { artifact_id: 'log-2-3c1f0e9a2b4d', kind: 'log', uri: `${ARTIFACTS}/log-2-3c1f0e9a2b4d`, sha256: '3'.repeat(64) },
  ],
  files_not_captured: [
    { path: 'public/graph.png', reason: 'binary' }, { path: 'fixtures/large.json', reason: 'too_large' }, { path: 'src/projects/Old.tsx', reason: 'missing' },
  ],
  summary: 'Trusted worker check capture; not integration approval', error: null,
}

/** The pinned assignment of the same run: two of three declared lanes selected, one automatic profile, receipts as far as the run got. */
export const runInputs: RunInputs = {
  contract_version: '1.4.0', run_id: 'run-001', feature: 'Review verdict and findings in the viewer',
  base_commit: 'e'.repeat(40), source_branch: 'feature/review-result/run-001', mode: 'automatic',
  automatic: { finish: 'verified-feature-branch', permission_mode: 'bypassPermissions', worker_timeout_seconds: 14400, review_timeout_seconds: 1800, reviewer_transport: 'native', profile: 'unattended' },
  setup: [{ command: 'npm ci', timeout_seconds: 600 }],
  max_verification_attempts: 3,
  selected_workers: ['ui', 'adapter'],
  excluded_workers: ['docs'],
  workers: [
    {
      node_id: 'ui', launch_node_id: 'launch_ui', role: 'frontend', required_check_kinds: ['build', 'browser'],
      task: { text: UI_TASK, truncated: false },
      prompt: { text: `You are a workflow worker in your own worktree.\n\n${UI_TASK}`, truncated: false },
      owned_paths: ['src/projects', 'tests/project-workflows'],
      checks: [
        { id: 'frontend-build', kind: 'build', command: 'npm run build', timeout_seconds: 180, scenarios: [] },
        { id: 'review-browser', kind: 'browser', command: 'npx --no-install playwright test --config=tests/project-workflows/playwright.config.ts', timeout_seconds: 300, scenarios: [{ id: 'review-verdict', description: 'The review node shows the verdict and findings' }] },
      ],
      launch: { session_id: 'ui-session', launch_requested_at: '2026-01-01T12:00:00Z', native_started_at: '2026-01-01T12:00:02Z', observed_state: 'working', status: 'attached_session_available', launcher_invocations: 1 },
      completion: {
        version: '1.1.0', status: 'completed', summary: 'Implemented the findings panel.', open_assumptions: ['Candidate mode seeds the review section.'],
        untested: ['Findings wider than the viewport'], falsifying_check: 'review-browser', verify_yourself: 'The seeded run matches a real export.', question: null,
      },
      handoff: { summary: 'Implemented the findings panel.', open_assumptions: ['Candidate mode seeds the review section.'] },
      stop: { stopped: true, confirmed_at: '2026-01-01T12:20:00Z' },
      questions: [
        { n: 1, question: 'Group findings by severity or by reviewer?', asked_at: '2026-01-01T12:05:00Z', answer: 'By severity.', answered_at: '2026-01-01T12:07:00Z' },
      ],
    },
    {
      node_id: 'adapter', launch_node_id: 'launch_adapter', role: 'backend', required_check_kinds: ['unit'],
      task: { text: '# Adapter worker\n\nServe the review route.', truncated: false },
      prompt: null,
      owned_paths: ['server'],
      checks: [{ id: 'backend-unit', kind: 'unit', command: 'npx --no-install tsx --test server/projects.test.ts', timeout_seconds: 180, scenarios: [] }],
      launch: { session_id: 'adapter-session', launch_requested_at: '2026-01-01T12:00:00Z', native_started_at: null, observed_state: null, status: 'attached_session_available', launcher_invocations: 1 },
      completion: null,
      handoff: null,
      stop: null,
      questions: [{ n: 1, question: 'May the route return 404 for runs without a review?', asked_at: '2026-01-01T12:10:00Z', answer: null, answered_at: null }],
    },
  ],
  decisions: '# Decisions\n\n## Decisions\n\n- Findings are grouped by severity.\n\n## Assumptions\n\nNone.\n\n## Deferred\n\nNothing.\n',
  challenge: {
    status: 'accepted', attempt: 1, attempts: 1, session_id: 'challenge-session',
    pinned: { tasks_sha256: 'a'.repeat(64), decisions_sha256: 'b'.repeat(64), prd_sha256: null },
    concerns: [
      { severity: 'P1', kind: 'failure_mode', message: 'Both lanes edit the contract.', consequence: 'The candidate merge conflicts.' },
      { severity: 'P2', kind: 'complexity', message: 'Two reviewers for a small change.', consequence: 'Review costs twice.' },
    ],
    simpler_alternative: 'One lane owns the contract and the adapter.',
    cheap_experiment: 'Merge the two task texts and count shared paths.',
    accepted_reason: 'The contract is split by file.',
    decided_at: '2026-01-01T11:59:00Z',
    history: [{
      attempt: 1, status: 'paused', decided_at: '2026-01-01T11:50:00Z',
      concerns: [{ severity: 'P1', kind: 'failure_mode', message: 'Both lanes edit the contract.', consequence: 'The candidate merge conflicts.' }],
    }],
  },
  roles: { worker: { model: null, effort: 'medium' }, judges: { model: 'claude-opus-5-5', effort: 'high' } },
  controller: { commit: 'f'.repeat(40), dirty: false, claude_version: '2.1.288 (Claude Code)' },
}

/**
 * The review sidecar's ledger exactly as docs/PRD_REVIEW_SIDECAR.md Appendix B pins it (three passes, the second timed out;
 * S-1 reported fixed with its pass-1 values in `history[0]`; M-2 refused because a question waited).
 */
export const sidecarLedgerFile: SidecarLedgerFile = {
  version: '1.0.0',
  run_id: 'review-sidecar-smoke-001',
  settings: { cadence_seconds: 900, pass_timeout_seconds: 600, max_passes: 16, max_messages_per_lane: 6 },
  passes: [
    { n: 1, trigger: 'cadence', started_at: '2026-10-01T12:10:00Z', finished_at: '2026-10-01T12:14:20Z', status: 'completed', session_id: '0f2b3c6e-4a4d-4b8e-9d1a-6b2f1c0a9e11', lanes: { engine: { head_commit: 'a1b2c3d', pane_captured: true }, viewer: { head_commit: 'a1b2c3d', pane_captured: true } }, counts: { new: 1, changed: 0, messages: 1 }, summary: 'One P1 in the engine lane\'s merge; the viewer lane has no diff yet.' },
    { n: 2, trigger: 'completion', started_at: '2026-10-01T12:40:00Z', finished_at: '2026-10-01T12:50:00Z', status: 'timed_out', session_id: null, lanes: { engine: { head_commit: 'b2c3d4e', pane_captured: false }, viewer: { head_commit: 'c3d4e5f', pane_captured: true } }, counts: { new: 0, changed: 0, messages: 0 }, summary: null },
    { n: 3, trigger: 'cadence', started_at: '2026-10-01T13:00:00Z', finished_at: '2026-10-01T13:05:00Z', status: 'completed', session_id: '7c1d2e3f-5b6a-4c7d-8e9f-0a1b2c3d4e5f', lanes: { engine: { head_commit: 'b2c3d4e', pane_captured: true }, viewer: { head_commit: 'd4e5f6a', pane_captured: true } }, counts: { new: 1, changed: 1, messages: 1 }, summary: 'S-1 reported fixed in the engine pane; one P2 in the viewer\'s fixture seeding.' },
  ],
  findings: [
    {
      id: 'S-1', category: 'defect', severity: 'P1', lane: 'engine',
      file: 'workflow/sidecar.py', locator: 'merge_output', revision: 'b2c3d4e',
      problem: 'A rejected output still appends the pass to the ledger before validation, so a malformed output leaves a half-written pass.',
      evidence: 'pane: \'fixed S-1, validating before the write\'',
      remedy: 'Validate first, then write the pass and the findings in one atomic replace.',
      disposition: 'fix_reported',
      note: null,
      messages: ['M-1'],
      history: [
        { pass: 1, disposition: 'open', revision: 'a1b2c3d', evidence: 'merge_output writes passes[] at line 88 and validates at line 102; test_sidecar has no case for it.', note: null, at: '2026-10-01T12:14:20Z' },
        { pass: 3, disposition: 'fix_reported', revision: 'b2c3d4e', evidence: 'pane: \'fixed S-1, validating before the write\'', note: null, at: '2026-10-01T13:05:00Z' },
      ],
    },
    {
      id: 'S-2', category: 'suggestion', severity: 'P2', lane: 'viewer',
      file: 'tests/project-workflows/fixtures/ux-sidecar.ts', locator: '', revision: 'working-tree',
      problem: 'The seeded ledger\'s timestamps are written by hand and drift from the events the same fixture seeds.',
      evidence: '',
      remedy: 'Derive the ledger times from the fixture\'s event times.',
      disposition: 'open',
      note: null,
      messages: ['M-2'],
      history: [
        { pass: 3, disposition: 'open', revision: 'working-tree', evidence: '', note: null, at: '2026-10-01T13:05:00Z' },
      ],
    },
  ],
  messages: [
    { id: 'M-1', pass: 1, lane: 'engine', finding_ids: ['S-1'], text: 'merge_output appends the pass before validating the output; a malformed output leaves a half-written ledger. Validate first and write once.', status: 'delivered', reason: null, at: '2026-10-01T12:14:21Z' },
    { id: 'M-2', pass: 3, lane: 'viewer', finding_ids: ['S-2'], text: 'The seeded ledger times in ux-sidecar.ts drift from the seeded events; derive one from the other.', status: 'refused', reason: 'question_waiting', at: '2026-10-01T13:05:01Z' },
  ],
  escalations: [],
  handoff: null,
  closed_at: null,
}

/** The same ledger as the sidecar route serves it while the run works: read live from `<run>/sidecar.ledger.json`. */
export const sidecarLedger: SidecarLedger = { contract_version: '1.6.0', node_id: 'sidecar', source: 'live', ...sidecarLedgerFile }
