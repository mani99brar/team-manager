import type { WorkerResult } from '../workflow/v1.js'
import type { AttackRecord, AttackResult, FixLoop, PanelRecord, PanelResults, ReviewFinding, RepairEntry, ReviewResult, RunDetail, RunInputs, SidecarLedger, SidecarLedgerFile } from './v1.js'

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

/**
 * The attack pass's record exactly as docs/PRD_ATTACK_PASS.md Appendix A pins it (one attacker, A-1 verified and labelled real,
 * A-2 not reproduced because its test passed on the clean copy).
 */
export const attackRecord: AttackRecord = {
  version: '1.0.0',
  run_id: 'claims-007',
  candidate_commit: '4f3c2b1a9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b',
  settings: {
    angles: ['auth-funds'],
    budget_usd: 15,
    timeout_minutes: 60,
    skeptic_budget_usd: 5,
    skeptic_timeout_minutes: 20,
    max_findings: 8,
    requirements: ['docs/security/requirements.md'],
    secret_files: ['/home/agentops/.config/vps-wallet.env'],
  },
  status: 'succeeded',
  started_at: '2026-10-05T10:00:00Z',
  finished_at: '2026-10-05T10:58:10Z',
  error: null,
  attackers: [
    {
      id: 'auth-funds',
      angle: 'auth-funds',
      status: 'succeeded',
      started_at: '2026-10-05T10:01:30Z',
      finished_at: '2026-10-05T10:41:02Z',
      error: null,
      session_id: '0f2b3c6e-4a4d-4b8e-9d1a-6b2f1c0a9e11',
      cost_usd: 7.42,
      summary: 'Two requirements of the claims module fail on this candidate; one could not be expressed offline.',
      out_of_reach: ['SEC-TX-02 needs a real chain reorganisation; the in-process harness has none.'],
      skeptic: {
        status: 'succeeded',
        started_at: '2026-10-05T10:46:00Z',
        finished_at: '2026-10-05T10:57:40Z',
        error: null,
        session_id: '7c1d2e3f-5b6a-4c7d-8e9f-0a1b2c3d4e5f',
        cost_usd: 1.1,
      },
    },
  ],
  findings: [
    {
      id: 'A-1',
      ref: 'f1',
      attacker: 'auth-funds',
      severity: 'P1',
      title: 'A claim\'s provenance can name another account',
      threat: 'A signed-in user files a claim whose provenance names another account; reviewers then trust the claim as that account\'s.',
      requirement: 'SEC-CLAIM-03: the server derives a claim\'s author from the session, never from the request body.',
      test_file: 'attack/auth-funds/A-1.test.ts',
      expected: '403 and no claim row',
      observed: '201 and a claim row authored by the other account',
      rerun: {
        status: 'reproduced',
        reason: null,
        exit_code: 1,
        duration_seconds: 14.2,
        output_tail: 'FAIL attack-tests/A-1.test.ts > rejects a body author\nAssertionError: expected 201 to be 403',
        at: '2026-10-05T10:44:10Z',
      },
      skeptic: {
        verdict: 'verified',
        reason: 'SEC-CLAIM-03 states it; the assertion that fails is the status check of the request under test.',
        severity: 'P1',
      },
      status: 'verified',
      labels: [{ label: 'real', review_found: 'no', note: null, by: 'operator', at: '2026-10-05T12:00:00Z' }],
    },
    {
      id: 'A-2',
      ref: 'f2',
      attacker: 'auth-funds',
      severity: 'P2',
      title: 'A withdrawn claim keeps its evidence link',
      threat: 'A withdrawn claim\'s evidence stays readable to its former reviewers.',
      requirement: null,
      test_file: 'attack/auth-funds/A-2.test.ts',
      expected: '404 after withdrawal',
      observed: '200',
      rerun: { status: 'not_reproduced', reason: 'passed', exit_code: 0, duration_seconds: 9.8, output_tail: '1 passed', at: '2026-10-05T10:45:01Z' },
      skeptic: null,
      status: 'not_reproduced',
      labels: [],
    },
  ],
}

/** The same record as the attack route serves it from the export's `attack` section. */
export const attackResult: AttackResult = { contract_version: '1.8.0', node_id: 'attack', source: 'export', ...attackRecord }

/**
 * The multi-provider panel's record exactly as docs/PRD_MULTI_PROVIDER_PANEL.md Appendix A pins it: one review-stage panel
 * that succeeded, two providers (a default claude and pi's openai-codex/gpt-6-sol) both raising the one finding, accepted at
 * threshold 2.
 */
export const panelRecord: PanelRecord = {
  version: '1.0.0',
  panels: [
    {
      id: 'review-panel', stage: 'review', status: 'succeeded',
      overlap_threshold: 2, context_bytes: 48213,
      providers: [
        { transport: 'claude', model: null, effort: 'high', status: 'ok', cost_usd: 0.021, context_bytes: 48213, finding_ids: ['f1'], error: null },
        { transport: 'pi', model: 'openai-codex/gpt-6-sol', effort: null, status: 'ok', cost_usd: 0.0047, context_bytes: 48213, finding_ids: ['f1'], error: null },
      ],
      findings: [
        { id: 'f1', severity: 'P1', file: 'packages/api/src/modules/claims/reconcile.ts', line: 52, title: 'mined set from non-final evidence', detail: 'A reorg can strand a mined publication.', providers_raised: ['claude', 'openai-codex/gpt-6-sol'], accepted: true, unanchored: false },
      ],
      started_at: '2026-10-06T07:00:00Z', ended_at: '2026-10-06T07:00:39Z', budget_usd: 5, error: null,
    },
  ],
}

/** Appendix A's `pending` record: what the export builds from `plan.panels` before `panel.json` exists. */
export const panelPendingRecord: PanelRecord = {
  version: '1.0.0',
  panels: [
    {
      id: 'review-panel', stage: 'review', status: 'pending',
      overlap_threshold: 2, context_bytes: null,
      providers: [
        { transport: 'claude', model: null, effort: 'high', status: 'pending', cost_usd: null, context_bytes: null, finding_ids: [], error: null },
        { transport: 'pi', model: 'openai-codex/gpt-6-sol', effort: null, status: 'pending', cost_usd: null, context_bytes: null, finding_ids: [], error: null },
      ],
      findings: [], started_at: null, ended_at: null, budget_usd: 5, error: null,
    },
  ],
}

/** The same record as the panels route serves it from the export's `panels` section. */
export const panelResults: PanelResults = { contract_version: '1.9.0', source: 'export', ...panelRecord }

// ---- The in-run fix loop (1.10.0, docs/PRD_VIEWER_REFINE.md Appendix A): the pinned records, verbatim --------------------

type FixLoopRecord = Omit<Extract<FixLoop, { rounds: number }>, 'contract_version' | 'source'>
const fixLoopHeader = { contract_version: '1.10.0', source: 'live' } as const
/** The state after a verify block repaired in round 1 and a review block repaired in round 2, with round 2's reviewers approving. */
export const fixLoopRecord: FixLoopRecord = {
  "version": "1.0.0",
  "rounds": 2,
  "repairs": [
    {
      "n": 1,
      "node_id": "repair-1",
      "mode": "session",
      "lane": "viewer",
      "trigger": "verify",
      "round": 1,
      "rounds": 2,
      "status": "applied",
      "by": "controller",
      "recorded_at": "2026-10-09T08:12:40Z",
      "applied_at": "2026-10-09T08:31:02Z",
      "blocked_step": "verify_viewer",
      "reentered_steps": [
        "verify_viewer"
      ],
      "reason": "repair session round 1: verify",
      "workspace_commit": "3f1c9a2b7d4e5f60718293a4b5c6d7e8f9012345",
      "session_id": "6a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "review_round": null,
      "findings": [],
      "delta": false,
      "fix_files": [
        "src/projects/WorkflowGraph.tsx"
      ],
      "left_behind": [],
      "requested": {
        "model": "claude-opus-4-8",
        "effort": "medium"
      },
      "gate_reasons": [
        "frontend-unit-regression failed: 1 of 42 tests failed (steps.test.ts: repair row order)"
      ]
    },
    {
      "n": 2,
      "node_id": "repair-2",
      "mode": "session",
      "lane": "viewer",
      "trigger": "review",
      "round": 2,
      "rounds": 2,
      "status": "applied",
      "by": "controller",
      "recorded_at": "2026-10-09T09:40:11Z",
      "applied_at": "2026-10-09T10:02:48Z",
      "blocked_step": "review",
      "reentered_steps": [
        "review"
      ],
      "reason": "repair session round 2: review",
      "workspace_commit": "5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f",
      "session_id": "0c9b8a7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d",
      "review_round": 1,
      "findings": [
        {
          "severity": "P1",
          "message": "src/projects/WorkflowGraph.tsx:118 the return mark is drawn from depends_on, so a repair node with no fix_loop entry gets an edge to nowhere",
          "disposition": "open",
          "worker": "viewer",
          "requirement": "PRD_VIEWER_REFINE 5.2: the return mark is a drawing from the fix-loop section, never a dependency edge",
          "reviewer": "general"
        }
      ],
      "delta": false,
      "fix_files": [
        "src/projects/WorkflowGraph.tsx",
        "tests/unit/dag.test.ts"
      ],
      "left_behind": [
        "coverage/"
      ],
      "requested": {
        "model": "claude-opus-4-8",
        "effort": "medium"
      },
      "gate_reasons": []
    }
  ],
  "review_rounds": [
    {
      "round": 1,
      "verdict": "blocked",
      "candidate": "5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f",
      "lane": "viewer",
      "findings": [
        {
          "severity": "P1",
          "message": "src/projects/WorkflowGraph.tsx:118 the return mark is drawn from depends_on, so a repair node with no fix_loop entry gets an edge to nowhere",
          "disposition": "open",
          "worker": "viewer",
          "requirement": "PRD_VIEWER_REFINE 5.2: the return mark is a drawing from the fix-loop section, never a dependency edge",
          "reviewer": "general"
        }
      ],
      "reviewer_sessions": [
        "d1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f5a",
        "e2f3a4b5-c6d7-4e8f-9a0b-1c2d3e4f5a6b"
      ],
      "started_at": "2026-10-09T09:40:10Z",
      "archived": true,
      "restored_at": null,
      "repair_n": 2,
      "reviewers": [
        {
          "reviewer_id": "general",
          "verdict": "blocked",
          "session_id": "d1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f5a"
        },
        {
          "reviewer_id": "coverage",
          "verdict": "approved",
          "session_id": "e2f3a4b5-c6d7-4e8f-9a0b-1c2d3e4f5a6b"
        }
      ]
    }
  ]
}
export const fixLoop: FixLoop = { ...fixLoopHeader, ...fixLoopRecord }
/** The same run mid-round at 09:40:12, as the live read serves it: repair 2 `launched`, the session not bound yet. */
export const launchedRepair: RepairEntry = {
  "n": 2,
  "node_id": "repair-2",
  "mode": "session",
  "lane": "viewer",
  "trigger": "review",
  "round": 2,
  "rounds": 2,
  "status": "launched",
  "by": "controller",
  "recorded_at": "2026-10-09T09:40:11Z",
  "applied_at": null,
  "blocked_step": "review",
  "reentered_steps": [
    "review"
  ],
  "reason": null,
  "workspace_commit": "5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f",
  "session_id": null,
  "review_round": 1,
  "findings": [
    {
      "severity": "P1",
      "message": "src/projects/WorkflowGraph.tsx:118 the return mark is drawn from depends_on, so a repair node with no fix_loop entry gets an edge to nowhere",
      "disposition": "open",
      "worker": "viewer",
      "requirement": "PRD_VIEWER_REFINE 5.2: the return mark is a drawing from the fix-loop section, never a dependency edge",
      "reviewer": "general"
    }
  ],
  "delta": false,
  "fix_files": [],
  "left_behind": [],
  "requested": null,
  "gate_reasons": []
}
export const fixLoopLaunched: FixLoop = { ...fixLoopHeader, ...fixLoopRecord, repairs: [fixLoopRecord.repairs[0], launchedRepair] }
/** A review-round repair that ended blocked: the round is restored (`archived: false`, `restored_at` set) and the run stops. */
export const fixLoopRestoredRecord: FixLoopRecord = {
  "version": "1.0.0",
  "rounds": 2,
  "repairs": [
    {
      "n": 1,
      "node_id": "repair-1",
      "mode": "session",
      "lane": "viewer",
      "trigger": "review",
      "round": 1,
      "rounds": 2,
      "status": "blocked",
      "by": "controller",
      "recorded_at": "2026-10-09T11:02:40Z",
      "applied_at": null,
      "blocked_step": "review",
      "reentered_steps": [
        "review"
      ],
      "reason": "the repair session repair-1 ended without a completion file",
      "workspace_commit": "5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f",
      "session_id": "0c9b8a7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d",
      "review_round": 1,
      "findings": [
        {
          "severity": "P1",
          "message": "src/projects/WorkflowGraph.tsx:118 the return mark is drawn from depends_on, so a repair node with no fix_loop entry gets an edge to nowhere",
          "disposition": "open",
          "worker": "viewer",
          "requirement": "PRD_VIEWER_REFINE 5.2: the return mark is a drawing from the fix-loop section, never a dependency edge",
          "reviewer": "general"
        }
      ],
      "delta": false,
      "fix_files": [],
      "left_behind": [],
      "requested": {
        "model": "claude-opus-4-8",
        "effort": "medium"
      },
      "gate_reasons": []
    }
  ],
  "review_rounds": [
    {
      "round": 1,
      "verdict": "blocked",
      "candidate": "5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f",
      "lane": "viewer",
      "findings": [
        {
          "severity": "P1",
          "message": "src/projects/WorkflowGraph.tsx:118 the return mark is drawn from depends_on, so a repair node with no fix_loop entry gets an edge to nowhere",
          "disposition": "open",
          "worker": "viewer",
          "requirement": "PRD_VIEWER_REFINE 5.2: the return mark is a drawing from the fix-loop section, never a dependency edge",
          "reviewer": "general"
        }
      ],
      "reviewer_sessions": [
        "d1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f5a",
        "e2f3a4b5-c6d7-4e8f-9a0b-1c2d3e4f5a6b"
      ],
      "started_at": "2026-10-09T11:02:39Z",
      "archived": false,
      "restored_at": "2026-10-09T11:40:12Z",
      "repair_n": 1,
      "reviewers": []
    }
  ]
}
export const fixLoopRestored: FixLoop = { ...fixLoopHeader, ...fixLoopRestoredRecord }
/** A loop neither source could project: no repairs, no rounds, no repair nodes. */
export const fixLoopError: FixLoop = { contract_version: '1.10.0', source: 'export', version: '1.0.0', error: 'repairs.json: repair 2 has a status the viewer does not know', rounds: null, repairs: [], review_rounds: [] }
