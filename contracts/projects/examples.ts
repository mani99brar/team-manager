import type { ReviewResult, RunDetail, RunInputs } from './v1.js'

export const runDetail: RunDetail = {
  summary: {
    contract_version: '1.0.0', project_id: 'md-manager', workflow_id: 'feature-implementation',
    definition_revision: 'a'.repeat(64), run_id: 'run-001', status: 'running',
    created_at: '2026-01-01T12:00:00Z', updated_at: '2026-01-01T12:01:00Z',
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
      { node_id: 'ui', kind: 'worker', depends_on: [], status: 'succeeded', attempt: 1, session_id: 'ui-session', result_uri: '/api/projects/md-manager/workflows/feature-implementation/runs/run-001/results/ui/1' },
      { node_id: 'adapter', kind: 'worker', depends_on: [], status: 'running', attempt: 1, session_id: 'adapter-session', result_uri: null },
      { node_id: 'review', kind: 'review', depends_on: ['ui', 'adapter'], status: 'pending', attempt: 0, session_id: null, result_uri: null },
    ],
  },
}
export const projectList = { projects: [{ project_id: 'md-manager', name: 'MD Manager' }] }
export const workflowList = { workflows: [runDetail.definition] }
export const runList = { runs: [runDetail.summary], next_cursor: null }

const UI_TASK = '# UI worker\n\nRender the review verdict on the review node. Show every finding with severity and disposition.\n\nApproved ownership and checks:\n{"node_id": "ui"}'

/** A recorded review with one open finding linked to the UI task and one cross-cutting finding without a quote. */
export const reviewResult: ReviewResult = {
  contract_version: '1.2.0', run_id: 'run-001', node_id: 'review', attempt: 1,
  reviewer: { session_id: '3f0c2a44-9f5b-4d0e-8c0a-5a6b7c8d9e01', transport: 'native', independent: true },
  bundle_sha256: 'b'.repeat(64), candidate_commit: 'c'.repeat(40),
  verdict: 'approved',
  findings: [
    {
      severity: 'P2', message: 'The findings table omits the disposition column on narrow screens.', disposition: 'open',
      worker: 'ui', requirement: 'Show every finding with severity and disposition.', requirement_found_in: ['ui'],
    },
    {
      severity: 'P2', message: 'The root Playwright suite is not part of the policy check set.', disposition: 'accepted',
      worker: 'none', requirement: null, requirement_found_in: [],
    },
  ],
  reviewed_at: '2026-01-01T12:30:00Z',
  diff: { artifact_id: 'patch-review-2bb474561d3e', kind: 'patch', uri: '/api/projects/md-manager/workflows/feature-implementation/runs/run-001/artifacts/patch-review-2bb474561d3e', sha256: 'd'.repeat(64) },
}

/** The pinned assignment of the same run: two workers, one automatic profile, receipts as far as the run got. */
export const runInputs: RunInputs = {
  contract_version: '1.2.0', run_id: 'run-001', feature: 'Review verdict and findings in the viewer',
  base_commit: 'e'.repeat(40), source_branch: 'feature/review-result/run-001', mode: 'automatic',
  automatic: { finish: 'verified-feature-branch', permission_mode: 'bypassPermissions', worker_timeout_seconds: 14400, review_timeout_seconds: 1800, reviewer_transport: 'native' },
  setup: [{ command: 'npm ci', timeout_seconds: 600 }],
  max_verification_attempts: 3,
  workers: [
    {
      node_id: 'ui', launch_node_id: 'ui', role: 'frontend',
      task: { text: UI_TASK, truncated: false },
      prompt: { text: `You are a workflow worker in your own worktree.\n\n${UI_TASK}`, truncated: false },
      owned_paths: ['src/projects', 'tests/project-workflows'],
      checks: [
        { id: 'frontend-build', kind: 'build', command: 'npm run build', timeout_seconds: 180, scenarios: [] },
        { id: 'review-browser', kind: 'browser', command: 'npx --no-install playwright test --config=tests/project-workflows/playwright.config.ts', timeout_seconds: 300, scenarios: [{ id: 'review-verdict', description: 'The review node shows the verdict and findings' }] },
      ],
      launch: { session_id: 'ui-session', launch_requested_at: '2026-01-01T12:00:00Z', native_started_at: '2026-01-01T12:00:02Z', observed_state: 'working', status: 'attached_session_available', launcher_invocations: 1 },
      completion: { status: 'completed', summary: 'Implemented the findings panel.', open_assumptions: ['Candidate mode seeds the review section.'] },
      handoff: { summary: 'Implemented the findings panel.', open_assumptions: ['Candidate mode seeds the review section.'] },
      stop: { stopped: true, confirmed_at: '2026-01-01T12:20:00Z' },
    },
    {
      node_id: 'adapter', launch_node_id: 'adapter', role: 'backend',
      task: { text: '# Adapter worker\n\nServe the review route.', truncated: false },
      prompt: null,
      owned_paths: ['server'],
      checks: [{ id: 'backend-unit', kind: 'unit', command: 'npx --no-install tsx --test server/projects.test.ts', timeout_seconds: 180, scenarios: [] }],
      launch: { session_id: 'adapter-session', launch_requested_at: '2026-01-01T12:00:00Z', native_started_at: null, observed_state: null, status: 'attached_session_available', launcher_invocations: 1 },
      completion: null,
      handoff: null,
      stop: null,
    },
  ],
}
