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
      { node_id: 'review', kind: 'review', depends_on: ['ui', 'adapter'], status: 'succeeded', attempt: 1, session_id: 'dd7bdcd1-adec-4efe-bcd4-bbadc3525d95', result_uri: '/api/projects/md-manager/workflows/feature-implementation/runs/run-001/reviews/1' },
    ],
  },
}
export const projectList = { projects: [{ project_id: 'md-manager', name: 'MD Manager' }] }
export const workflowList = { workflows: [runDetail.definition] }
export const runList = { runs: [runDetail.summary], next_cursor: null }
export const reviewResult: ReviewResult = {
  contract_version: '1.1.0', run_id: 'run-001', node_id: 'review', attempt: 1,
  reviewer_session: 'dd7bdcd1-adec-4efe-bcd4-bbadc3525d95', independent: true, transport: 'native',
  bundle_sha256: 'b'.repeat(64), candidate_commit: 'c'.repeat(40), verdict: 'approved',
  findings: [
    { severity: 'P2', message: 'Reuse evidence is stated as absent rather than derived from events', disposition: 'accepted', worker: 'adapter', requirement: 'Show statuses, attempts, explicit reuse evidence', requirement_verbatim: true },
    { severity: 'P2', message: 'Graph attempt is inferred from event text', disposition: 'open', worker: 'adapter', requirement: null },
    { severity: 'P2', message: 'Recorded before finding links existed', disposition: 'open', worker: null, requirement: null },
  ],
  reviewed_at: '2026-01-01T12:05:00Z',
  diff_artifact: { artifact_id: 'review-diff', kind: 'patch', uri: '/api/projects/md-manager/workflows/feature-implementation/runs/run-001/artifacts/review-diff', sha256: 'd'.repeat(64) },
}
export const runInputs: RunInputs = {
  contract_version: '1.2.0', run_id: 'run-001', feature: 'project-workflows', base_commit: 'a'.repeat(40),
  source_branch: 'feature/project-workflows/run-001', mode: 'interactive', created_at: '2026-01-01T12:00:00Z',
  automatic: { finish: 'verified-feature-branch', permission_mode: 'bypassPermissions', worker_timeout_seconds: 14400, review_timeout_seconds: 1800, reviewer_transport: 'native' },
  setup: [{ command: 'npm ci', timeout_seconds: 600 }],
  max_verification_attempts: 3,
  workers: [
    {
      node_id: 'ui', role: 'frontend',
      task: '# UI worker\n\nShow statuses, attempts, explicit reuse evidence.\nApproved ownership and checks:\n{"node_id": "ui"}', task_truncated: false,
      owned_paths: ['src/App.tsx', 'src/projects'],
      checks: [{ id: 'frontend-build', kind: 'build', command: 'npm run build', timeout_seconds: 180, scenarios: [] },
               { id: 'browser', kind: 'browser', command: 'npx --no-install playwright test', timeout_seconds: 300, scenarios: [{ id: 'run-evidence', description: 'Inspect worker evidence' }] }],
      launch: { status: 'attached_session_available', session_id: 'ui-session', launch_token: '00000000-0000-4000-8000-000000000001', launch_requested_at: '2026-01-01T12:00:10Z', native_started_at: '2026-01-01T12:00:12Z', observed_state: 'working', launcher_invocations: 1 },
      completion: { status: 'completed', summary: 'Implemented the Projects root', open_assumptions: ['Candidate mode unverified here'] },
      handoff: { summary: 'Implemented the Projects root', open_assumptions: ['Candidate mode unverified here'] },
      stopped: true, stopped_at: '2026-01-01T12:03:00Z',
    },
    {
      node_id: 'adapter', role: 'backend',
      task: '# Adapter worker\n\nImplement the read-only API.\nApproved ownership and checks:\n{"node_id": "adapter"}', task_truncated: false,
      owned_paths: ['server'],
      checks: [{ id: 'backend-unit', kind: 'unit', command: 'npx --no-install tsx --test server/projects.test.ts', timeout_seconds: 180, scenarios: [] }],
      launch: null, completion: null, handoff: null, stopped: null, stopped_at: null,
    },
  ],
}
export const runInputsResponse = { inputs: runInputs }
