/**
 * Synthetic project/workflow/run data for the Projects viewer browser tests. Identifiers and the shape of
 * each run are shared by both verification phases: in `worker` mode they are served as explicit contract
 * payloads by `mock.ts`; in `candidate` mode `seed.ts` writes the same logical runs to disk in the format
 * the real backend adapter projects. Nothing here is real execution evidence.
 */
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { validateDefinition, validateRunDetail, type Project, type RunDetail, type WorkflowDefinition } from '../../contracts/projects/v1.ts'
import { eventSchema, validateWorkerResult, type WorkerResult, type WorkflowEvent } from '../../contracts/workflow/v1.ts'

export const PROJECT: Project = { project_id: 'alpha-project', name: 'Alpha project' }
export const EMPTY_PROJECT: Project = { project_id: 'empty-project', name: 'Empty project' }
export const WORKFLOW_ID = 'feature-flow'
export const WORKFLOW_NAME = 'Feature flow'
export const EMPTY_WORKFLOW_ID = 'empty-flow'
export const EMPTY_WORKFLOW_NAME = 'Empty flow'
export const RUN_SUCCEEDED = 'run-succeeded'
export const RUN_FAILED = 'run-failed'
export const RUN_AWAITING = 'run-awaiting'
export const PINNED_LABEL = 'Verify UI (pinned r1)'
export const CURRENT_LABEL = 'Verify UI'
export const BASE_COMMIT = '1234567890abcdef1234567890abcdef12345678'
export const OUTPUT_COMMIT_UI = 'abcdef1234567890abcdef1234567890abcdef12'
export const OUTPUT_COMMIT_ADAPTER = 'fedcba0987654321fedcba0987654321fedcba09'
export const UI_ASSUMPTION = 'Candidate verification serves artifacts through the run-scoped registry only.'
export const UI_CHANGED_FILES = ['src/App.tsx', 'src/projects/ProjectsView.tsx', 'tests/project-workflows/projects.spec.ts']
export const ADAPTER_CHANGED_FILES = ['server/projects.ts', 'server/projects.test.ts']
export const LOG_TEXT_PREFIX = 'synthetic check log:'

type DefinitionNode = WorkflowDefinition['nodes'][number]

/** The production pipeline graph (`workflow/export_state.py` GRAPH_NODES). */
export const GRAPH_NODES: DefinitionNode[] = [
  { node_id: 'launch_ui', label: 'Launch UI worker', kind: 'worker', depends_on: [] },
  { node_id: 'launch_adapter', label: 'Launch adapter worker', kind: 'worker', depends_on: [] },
  { node_id: 'handoff', label: 'Freeze worker handoffs', kind: 'prepare', depends_on: ['launch_ui', 'launch_adapter'] },
  { node_id: 'verify_ui', label: CURRENT_LABEL, kind: 'verification', depends_on: ['handoff'] },
  { node_id: 'verify_adapter', label: 'Verify adapter', kind: 'verification', depends_on: ['handoff'] },
  { node_id: 'candidate', label: 'Verify combined candidate', kind: 'verification', depends_on: ['verify_ui', 'verify_adapter'] },
  { node_id: 'review', label: 'Independent review', kind: 'review', depends_on: ['candidate'] },
  { node_id: 'approval', label: 'Integration approval', kind: 'integration', depends_on: ['review'] },
  { node_id: 'integrate', label: 'Integrate candidate', kind: 'integration', depends_on: ['approval'] },
]

/** The succeeded run was started under an older definition: one label differs, so its revision differs too. */
export const PINNED_NODES: DefinitionNode[] = GRAPH_NODES.map(node => (node.node_id === 'verify_ui' ? { ...node, label: PINNED_LABEL } : node))

/** Definition revision exactly as the contract specifies: SHA-256 of canonical JSON without `definition_revision`. */
export function definitionRevision(definition: { contract_version: string; project_id: string; workflow_id: string; name: string; nodes: DefinitionNode[] }): string {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    if (value && typeof value === 'object') {
      return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
    }
    return JSON.stringify(value)
  }
  const { contract_version, project_id, workflow_id, name, nodes } = definition
  return createHash('sha256').update(canonical({ contract_version, project_id, workflow_id, name, nodes }), 'utf8').digest('hex')
}

function definition(projectId: string, workflowId: string, name: string, nodes: DefinitionNode[]): WorkflowDefinition {
  const base = { contract_version: '1.0.0' as const, project_id: projectId, workflow_id: workflowId, name, nodes }
  return validateDefinition({ ...base, definition_revision: definitionRevision(base) })
}

export const CURRENT_DEFINITION = definition(PROJECT.project_id, WORKFLOW_ID, WORKFLOW_NAME, GRAPH_NODES)
export const PINNED_DEFINITION = definition(PROJECT.project_id, WORKFLOW_ID, WORKFLOW_NAME, PINNED_NODES)
export const EMPTY_WORKFLOW_DEFINITION = definition(PROJECT.project_id, EMPTY_WORKFLOW_ID, EMPTY_WORKFLOW_NAME, GRAPH_NODES.slice(0, 3))

export const projectList = { projects: [PROJECT, EMPTY_PROJECT] }
export const workflowLists: Record<string, { workflows: WorkflowDefinition[] }> = {
  [PROJECT.project_id]: { workflows: [CURRENT_DEFINITION, EMPTY_WORKFLOW_DEFINITION] },
  [EMPTY_PROJECT.project_id]: { workflows: [] },
}

export const T0 = '2026-03-01T10:00:00Z'
export const T1 = '2026-03-01T10:05:00Z'
export const T2 = '2026-03-01T10:20:00Z'
export const T3 = '2026-03-01T10:45:00Z'

// ---- A tiny valid PNG (solid colour), so screenshot artifacts are real images -------------------------

function crc32(bytes: Buffer): number {
  let crc = ~0
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

export function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // colour type: RGB
  const rows: Buffer[] = []
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3)
    for (let x = 0; x < width; x += 1) row.set(rgb, 1 + x * 3)
    rows.push(row)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

export const SCREENSHOT_PNG = solidPng(96, 64, [47, 122, 75])

export function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

// ---- Artifacts and worker results ------------------------------------------------------------------

export type ArtifactFile = { artifact_id: string; kind: WorkerResult['artifacts'][number]['kind']; content: Buffer; contentType: string }

function logArtifact(id: string, command: string, exitCode: number): ArtifactFile {
  const content = Buffer.from(`${LOG_TEXT_PREFIX} ${command}\n... output elided ...\nexit ${exitCode}\n`, 'utf8')
  return { artifact_id: id, kind: 'log', content, contentType: 'text/plain; charset=utf-8' }
}

export const UI_ARTIFACTS: ArtifactFile[] = [
  logArtifact('log-0-ui-build', 'npm run build', 0),
  logArtifact('log-1-ui-unit', 'npm run test:unit', 0),
  logArtifact('log-2-ui-browser', 'npx --no-install playwright test --config=tests/project-workflows/playwright.config.ts', 0),
  { artifact_id: 'screenshot-3-projects', kind: 'screenshot', content: SCREENSHOT_PNG, contentType: 'image/png' },
  { artifact_id: 'test_report-4-browser', kind: 'test_report', content: Buffer.from('{"stats":{"expected":6,"unexpected":0}}\n'), contentType: 'application/json' },
]
export const ADAPTER_ARTIFACTS: ArtifactFile[] = [
  logArtifact('log-0-adapter-unit', 'npx --no-install tsx --test server/projects.test.ts', 0),
]

function artifactRefs(files: ArtifactFile[]): WorkerResult['artifacts'] {
  return files.map(file => ({ artifact_id: file.artifact_id, kind: file.kind, uri: file.artifact_id, sha256: sha256(file.content) }))
}

function checks(cwd: string, entries: { command: string; log: string; exit: number; start: string; finish: string }[]): WorkerResult['checks'] {
  return entries.map(entry => ({ command: entry.command, cwd, started_at: entry.start, finished_at: entry.finish, exit_code: entry.exit, log_artifact_id: entry.log }))
}

export const UI_SESSION = '11111111-1111-4111-8111-111111111111'
export const ADAPTER_SESSION = '22222222-2222-4222-8222-222222222222'

export function uiResult(runId: string): WorkerResult {
  return validateWorkerResult({
    contract_version: '1.0.0', run_id: runId, node_id: 'ui', attempt: 1, session_id: UI_SESSION,
    status: 'succeeded', base_commit: BASE_COMMIT, output_commit: OUTPUT_COMMIT_UI,
    changed_files: UI_CHANGED_FILES,
    checks: checks('verification/worker/ui/1/worktree', [
      { command: 'npm run build', log: 'log-0-ui-build', exit: 0, start: T1, finish: '2026-03-01T10:06:00Z' },
      { command: 'npm run test:unit', log: 'log-1-ui-unit', exit: 0, start: '2026-03-01T10:06:00Z', finish: '2026-03-01T10:07:00Z' },
      { command: 'npx --no-install playwright test --config=tests/project-workflows/playwright.config.ts', log: 'log-2-ui-browser', exit: 0, start: '2026-03-01T10:07:00Z', finish: '2026-03-01T10:12:00Z' },
    ]),
    open_assumptions: [UI_ASSUMPTION],
    artifacts: artifactRefs(UI_ARTIFACTS),
    summary: 'Trusted worker check capture of the UI worktree; not integration approval.',
    error: null,
  })
}

export function adapterResult(runId: string, failed: boolean): WorkerResult {
  return validateWorkerResult({
    contract_version: '1.0.0', run_id: runId, node_id: 'adapter', attempt: 1, session_id: ADAPTER_SESSION,
    status: failed ? 'failed' : 'succeeded', base_commit: BASE_COMMIT, output_commit: failed ? null : OUTPUT_COMMIT_ADAPTER,
    changed_files: ADAPTER_CHANGED_FILES,
    checks: checks('verification/worker/adapter/1/worktree', [
      { command: 'npx --no-install tsx --test server/projects.test.ts', log: 'log-0-adapter-unit', exit: 0, start: T1, finish: '2026-03-01T10:08:00Z' },
    ]),
    open_assumptions: [],
    artifacts: artifactRefs(ADAPTER_ARTIFACTS),
    summary: failed ? 'Checks ran and were preserved; the verification gate was blocked by the configured failure drill.' : 'Trusted worker check capture of the adapter worktree; not integration approval.',
    error: failed ? { code: 'injected_gate_failure', message: 'Verification attempt 1 was blocked by the configured failure drill, not by a failing check.', retryable: true } : null,
  })
}

// ---- Runs ----------------------------------------------------------------------------------------------

type NodeState = { status: RunDetail['snapshot']['nodes'][number]['status']; attempt: number; session?: string | null; result?: string | null }

function runDetail(runId: string, status: RunDetail['summary']['status'], pinned: WorkflowDefinition, createdAt: string, updatedAt: string, states: Record<string, NodeState>, lastSequence: number): RunDetail {
  const resultPath = (node: string, attempt: number) => `/api/projects/${PROJECT.project_id}/workflows/${WORKFLOW_ID}/runs/${runId}/results/${node}/${attempt}`
  return validateRunDetail({
    summary: {
      contract_version: '1.0.0', project_id: PROJECT.project_id, workflow_id: WORKFLOW_ID,
      definition_revision: pinned.definition_revision, run_id: runId, status, created_at: createdAt, updated_at: updatedAt,
    },
    definition: pinned,
    snapshot: {
      contract_version: '1.0.0', run_id: runId, status, last_sequence: lastSequence,
      nodes: pinned.nodes.map(node => {
        const state = states[node.node_id] ?? { status: 'pending', attempt: 0 }
        return {
          node_id: node.node_id, kind: node.kind, depends_on: node.depends_on, status: state.status, attempt: state.attempt,
          session_id: state.session ?? null,
          result_uri: state.result ? resultPath(state.result, state.attempt) : null,
        }
      }),
    },
  })
}

const done = (session?: string, result?: string): NodeState => ({ status: 'succeeded', attempt: 1, session: session ?? null, result: result ?? null })

export const runDetails: Record<string, RunDetail> = {
  [RUN_SUCCEEDED]: runDetail(RUN_SUCCEEDED, 'succeeded', PINNED_DEFINITION, T0, T3, {
    launch_ui: done(UI_SESSION), launch_adapter: done(ADAPTER_SESSION), handoff: done(),
    verify_ui: done(undefined, 'ui'), verify_adapter: done(undefined, 'adapter'),
    candidate: done(), review: done(), approval: done(), integrate: done(),
  }, 18),
  [RUN_FAILED]: runDetail(RUN_FAILED, 'failed', CURRENT_DEFINITION, T1, T2, {
    launch_ui: done(UI_SESSION), launch_adapter: done(ADAPTER_SESSION), handoff: done(),
    verify_ui: { status: 'succeeded', attempt: 2, result: 'ui' },
    verify_adapter: { status: 'failed', attempt: 1, result: 'adapter' },
  }, 9),
  [RUN_AWAITING]: runDetail(RUN_AWAITING, 'awaiting_approval', CURRENT_DEFINITION, T2, T3, {
    launch_ui: done(UI_SESSION), launch_adapter: done(ADAPTER_SESSION), handoff: done(),
    verify_ui: done(undefined, 'ui'), verify_adapter: done(undefined, 'adapter'), candidate: done(),
    review: { status: 'awaiting_approval', attempt: 1 },
  }, 12),
}

/** Runs sorted by `updated_at` descending then `run_id` ascending, as the contract requires. */
export const runList = {
  runs: Object.values(runDetails).map(detail => detail.summary).sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.run_id.localeCompare(b.run_id)),
  next_cursor: null,
}

export const workerResults: Record<string, Record<string, WorkerResult>> = {
  [RUN_SUCCEEDED]: { 'ui/1': uiResult(RUN_SUCCEEDED), 'adapter/1': adapterResult(RUN_SUCCEEDED, false) },
  [RUN_FAILED]: { 'ui/1': uiResult(RUN_FAILED), 'ui/2': { ...uiResult(RUN_FAILED), attempt: 2 }, 'adapter/1': adapterResult(RUN_FAILED, true) },
  [RUN_AWAITING]: { 'ui/1': uiResult(RUN_AWAITING), 'adapter/1': adapterResult(RUN_AWAITING, false) },
}

function event(runId: string, sequence: number, fields: Partial<WorkflowEvent> & Pick<WorkflowEvent, 'type' | 'message'>): WorkflowEvent {
  return eventSchema.parse({
    contract_version: '1.0.0', run_id: runId, event_id: `${runId}-event-${sequence}`, sequence,
    occurred_at: new Date(Date.parse(T0) + sequence * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    node_id: null, attempt: 0, status: null, artifact: null, result_uri: null, reused_from_attempt: null,
    ...fields,
  })
}

export const REUSE_MESSAGE = 'Reused the successful UI verification from attempt 1; only the adapter lane was rerun.'
export const APPROVAL_MESSAGE = 'Independent review required before integration; awaiting the recorded review verdict.'

export const runEvents: Record<string, WorkflowEvent[]> = {
  [RUN_SUCCEEDED]: [
    event(RUN_SUCCEEDED, 1, { type: 'status_changed', node_id: 'launch_ui', attempt: 1, status: 'running', message: 'Launching the native UI session' }),
    event(RUN_SUCCEEDED, 2, { type: 'status_changed', node_id: 'launch_ui', attempt: 1, status: 'succeeded', message: 'Native session launched and its turn ended; not implementation completion' }),
    event(RUN_SUCCEEDED, 3, { type: 'result_published', node_id: 'verify_ui', attempt: 1, message: 'UI verification packet captured', result_uri: runDetails[RUN_SUCCEEDED].snapshot.nodes.find(node => node.node_id === 'verify_ui')!.result_uri }),
    event(RUN_SUCCEEDED, 4, { type: 'status_changed', node_id: 'integrate', attempt: 1, status: 'succeeded', message: 'Fast-forwarded the feature branch' }),
  ],
  [RUN_FAILED]: [
    event(RUN_FAILED, 1, { type: 'status_changed', node_id: 'launch_ui', attempt: 1, status: 'succeeded', message: 'Native session launched and its turn ended; not implementation completion' }),
    event(RUN_FAILED, 2, { type: 'result_published', node_id: 'verify_adapter', attempt: 1, message: 'Adapter verification packet captured with a blocked gate', result_uri: runDetails[RUN_FAILED].snapshot.nodes.find(node => node.node_id === 'verify_adapter')!.result_uri }),
    event(RUN_FAILED, 3, { type: 'status_changed', node_id: 'verify_adapter', attempt: 1, status: 'failed', message: 'Injected gate failure (failure drill), checks preserved' }),
    event(RUN_FAILED, 4, { type: 'result_reused', node_id: 'verify_ui', attempt: 2, reused_from_attempt: 1, message: REUSE_MESSAGE }),
  ],
  [RUN_AWAITING]: [
    event(RUN_AWAITING, 1, { type: 'status_changed', node_id: 'candidate', attempt: 1, status: 'succeeded', message: 'Combined candidate checks passed' }),
    event(RUN_AWAITING, 2, { type: 'approval_requested', node_id: 'review', attempt: 1, status: 'awaiting_approval', message: APPROVAL_MESSAGE }),
  ],
}

export const artifactFiles: Record<string, ArtifactFile[]> = {
  [RUN_SUCCEEDED]: [...UI_ARTIFACTS, ...ADAPTER_ARTIFACTS],
  [RUN_FAILED]: [...UI_ARTIFACTS, ...ADAPTER_ARTIFACTS],
  [RUN_AWAITING]: [...UI_ARTIFACTS, ...ADAPTER_ARTIFACTS],
}
