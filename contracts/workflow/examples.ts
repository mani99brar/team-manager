import type { RunSpec, WorkerResult, RunSnapshot, WorkflowEvent, ControlRequest } from './v1.js'

// Demonstration SHAs only; replace with observed Git revisions before execution.
const base = 'a'.repeat(40)
export const runSpec: RunSpec = {
  contract_version: '1.0.0', run_id: 'demo-001',
  objective: 'Build a workflow viewer and executor adapter', repository: '/repo',
  base_commit: base, max_concurrent_workers: 2,
  workers: [
    { node_id: 'ui', executor: 'claude', task: 'Build viewer against fixtures', worktree: '/worktrees/ui', observed_start_commit: base, owned_paths: ['src/workflow'], acceptance_criteria: ['Show failed and reused attempts'] },
    { node_id: 'adapter', executor: 'claude', task: 'Implement event and result adapter', worktree: '/worktrees/adapter', observed_start_commit: base, owned_paths: ['workflow'], acceptance_criteria: ['Persist and resume independent worker sessions'] },
  ],
  usage_exhaustion: { action: 'pause_for_approval', alternative_plan: 'Ask owner to choose an authorized provider or wait for usage reset' },
}
export const workerResult: WorkerResult = {
  contract_version: '1.0.0', run_id: 'demo-001', node_id: 'ui', attempt: 1,
  session_id: 'claude-ui-001', status: 'succeeded', base_commit: base,
  output_commit: 'b'.repeat(40), changed_files: ['src/workflow/Viewer.tsx', 'docs/VIEWER.md', 'public/viewer.png'],
  checks: [{ command: 'npm run test:workflow', cwd: '/worktrees/ui', started_at: '2026-01-01T12:00:00Z', finished_at: '2026-01-01T12:01:00Z', exit_code: 0, log_artifact_id: 'tests-ui-1' }],
  open_assumptions: ['Browser gate runs separately before acceptance'],
  artifacts: [
    { artifact_id: 'tests-ui-1', kind: 'log', uri: 'artifact://demo-001/ui/1/tests.log', sha256: 'c'.repeat(64) },
    { artifact_id: 'file-1-viewer-tsx', kind: 'file', path: 'src/workflow/Viewer.tsx', uri: 'artifact://demo-001/ui/1/file-1', sha256: 'd'.repeat(64) },
    { artifact_id: 'file-2-viewer-md', kind: 'file', path: 'docs/VIEWER.md', uri: 'artifact://demo-001/ui/1/file-2', sha256: 'e'.repeat(64) },
  ],
  files_not_captured: [{ path: 'public/viewer.png', reason: 'binary' }],
  summary: 'Viewer implemented against fixtures', error: null,
}
export const runSnapshot: RunSnapshot = {
  contract_version: '1.0.0', run_id: 'demo-001', status: 'running', last_sequence: 1,
  nodes: [{ node_id: 'ui', kind: 'worker', depends_on: [], status: 'succeeded', attempt: 1, session_id: 'claude-ui-001', result_uri: 'artifact://demo-001/ui/1/result.json', lane_results: [] },
    { node_id: 'candidate', kind: 'verification', depends_on: ['ui'], status: 'succeeded', attempt: 1, session_id: null, result_uri: null,
      lane_results: [{ worker: 'ui', attempt: 1, result_uri: 'artifact://demo-001/candidate_ui/1/result.json' }] }],
}
export const event: WorkflowEvent = {
  contract_version: '1.0.0', run_id: 'demo-001', event_id: 'event-1', sequence: 1,
  occurred_at: '2026-01-01T12:01:00Z', node_id: 'ui', attempt: 1,
  type: 'result_published', status: null, message: 'Implementation ready for verification',
  artifact: null, result_uri: 'artifact://demo-001/ui/1/result.json', reused_from_attempt: null,
}
export const controlRequest: ControlRequest = {
  contract_version: '1.0.0', run_id: 'demo-001', request_id: 'request-1',
  expected_sequence: 1, action: 'pause', node_id: null, reason: 'Review remaining included usage',
}
