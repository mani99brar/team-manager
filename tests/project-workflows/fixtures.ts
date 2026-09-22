/**
 * Synthetic project/workflow/run data for the Projects viewer browser tests. Identifiers and the shape of
 * each run are shared by both verification phases: in `worker` mode they are served as explicit contract
 * payloads by `mock.ts`; in `candidate` mode `seed.ts` writes the same logical runs to disk in the format
 * the real backend adapter projects. Nothing here is real execution evidence.
 *
 * Review results and run inputs exist in two forms: the raw export sections (`rawReviewSection`,
 * `rawInputsSection`, the shapes `workflow/export_state.py` writes) and their projections onto the
 * contract (`reviewResults`, `runInputs`, what the mocks serve). Texts take a `leak` argument: the seeds
 * pass a real absolute path under the temporary root so the adapter's redaction is exercised, the mocks
 * use the already-redacted marker `<path>`, so both phases render the same text.
 */
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import {
  validateDefinition, validateReviewResult, validateRunDetail, validateRunInputs,
  type Project, type ReviewResult, type RunDetail, type RunInputs, type WorkflowDefinition,
} from '../../contracts/projects/v1.ts'
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
/** Reviewed and blocked by the independent reviewer (print transport): the review node failed, the run failed. */
export const RUN_BLOCKED = 'run-blocked'
/** Integrated under export version 1.0.0: no review and no inputs sections although the review happened. */
export const RUN_LEGACY = 'run-legacy'
export const PINNED_LABEL = 'Verify UI (pinned r1)'
export const CURRENT_LABEL = 'Verify UI'
export const BASE_COMMIT = '1234567890abcdef1234567890abcdef12345678'
export const OUTPUT_COMMIT_UI = 'abcdef1234567890abcdef1234567890abcdef12'
export const OUTPUT_COMMIT_ADAPTER = 'fedcba0987654321fedcba0987654321fedcba09'
export const CANDIDATE_COMMIT = 'c'.repeat(40)
export const BUNDLE_SHA256 = 'f'.repeat(64)
export const UI_ASSUMPTION = 'Candidate verification serves artifacts through the run-scoped registry only.'
export const UI_CHANGED_FILES = ['src/App.tsx', 'src/projects/ProjectsView.tsx', 'tests/project-workflows/projects.spec.ts']
export const ADAPTER_CHANGED_FILES = ['server/projects.ts', 'server/projects.test.ts']
export const LOG_TEXT_PREFIX = 'synthetic check log:'
/** What the adapter substitutes for an absolute filesystem path; the mocks carry it literally. */
export const PATH_TOKEN = '<path>'
export const FEATURE_NAME = 'Review visibility and run inputs in the viewer'
export const REVIEWER_SESSION = '33333333-3333-4333-8333-333333333333'
export const PRINT_REVIEWER_SESSION = '44444444-4444-4444-8444-444444444444'
export const REVIEW_DIFF = [
  'diff --git a/src/projects/NodeDetail.tsx b/src/projects/NodeDetail.tsx',
  '--- a/src/projects/NodeDetail.tsx',
  '+++ b/src/projects/NodeDetail.tsx',
  '@@ -1,3 +1,4 @@',
  " import { useCallback, useState } from 'react'",
  "+import { ReviewPanel } from './ReviewDetail.tsx'",
  ' import {',
  '   fetchArtifactText,',
  '',
].join('\n')

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

export const apiRunPath = (runId: string) => `/api/projects/${PROJECT.project_id}/workflows/${WORKFLOW_ID}/runs/${runId}`

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

export const REVIEW_DIFF_ARTIFACT_ID = `patch-review-${sha256(REVIEW_DIFF).slice(0, 12)}`

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
/** The diff the reviewer saw, served through the artifact route as a patch. */
export const REVIEW_DIFF_ARTIFACT: ArtifactFile = { artifact_id: REVIEW_DIFF_ARTIFACT_ID, kind: 'patch', content: Buffer.from(REVIEW_DIFF, 'utf8'), contentType: 'text/plain; charset=utf-8' }

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

type NodeState = { status: RunDetail['snapshot']['nodes'][number]['status']; attempt: number; session?: string | null; result?: string | null; review?: number }

function runDetail(runId: string, status: RunDetail['summary']['status'], pinned: WorkflowDefinition, createdAt: string, updatedAt: string, states: Record<string, NodeState>, lastSequence: number): RunDetail {
  const resultPath = (node: string, attempt: number) => `${apiRunPath(runId)}/results/${node}/${attempt}`
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
          result_uri: state.review ? `${apiRunPath(runId)}/reviews/${state.review}` : state.result ? resultPath(state.result, state.attempt) : null,
        }
      }),
    },
  })
}

const done = (session?: string, result?: string): NodeState => ({ status: 'succeeded', attempt: 1, session: session ?? null, result: result ?? null })
/** Both launch nodes finished and, like the real adapter, link to the worker's verified result. */
const launched = { launch_ui: done(UI_SESSION, 'ui'), launch_adapter: done(ADAPTER_SESSION, 'adapter'), handoff: done() }
const verified = { ...launched, verify_ui: done(undefined, 'ui'), verify_adapter: done(undefined, 'adapter'), candidate: done() }

export const runDetails: Record<string, RunDetail> = {
  [RUN_SUCCEEDED]: runDetail(RUN_SUCCEEDED, 'succeeded', PINNED_DEFINITION, T0, T3, {
    ...verified, review: { status: 'succeeded', attempt: 1, session: REVIEWER_SESSION, review: 1 }, approval: done(), integrate: done(),
  }, 18),
  [RUN_FAILED]: runDetail(RUN_FAILED, 'failed', CURRENT_DEFINITION, T1, T2, {
    ...launched,
    verify_ui: { status: 'succeeded', attempt: 2, result: 'ui' },
    verify_adapter: { status: 'failed', attempt: 1, result: 'adapter' },
  }, 9),
  [RUN_AWAITING]: runDetail(RUN_AWAITING, 'awaiting_approval', CURRENT_DEFINITION, T2, T3, {
    ...verified, review: { status: 'awaiting_approval', attempt: 1 },
  }, 12),
  [RUN_BLOCKED]: runDetail(RUN_BLOCKED, 'failed', CURRENT_DEFINITION, T1, T3, {
    ...verified, review: { status: 'failed', attempt: 1, session: PRINT_REVIEWER_SESSION, review: 1 },
  }, 10),
  [RUN_LEGACY]: runDetail(RUN_LEGACY, 'succeeded', CURRENT_DEFINITION, T0, T2, {
    ...verified, review: done(), approval: done(), integrate: done(),
  }, 6),
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
  [RUN_BLOCKED]: { 'ui/1': uiResult(RUN_BLOCKED), 'adapter/1': adapterResult(RUN_BLOCKED, false) },
  [RUN_LEGACY]: { 'ui/1': uiResult(RUN_LEGACY), 'adapter/1': adapterResult(RUN_LEGACY, false) },
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
export const BLOCKED_MESSAGE = 'Independent reviewer blocked the candidate'

export const runEvents: Record<string, WorkflowEvent[]> = {
  [RUN_SUCCEEDED]: [
    event(RUN_SUCCEEDED, 1, { type: 'status_changed', node_id: 'launch_ui', attempt: 1, status: 'running', message: 'Launching the native UI session' }),
    event(RUN_SUCCEEDED, 2, { type: 'status_changed', node_id: 'launch_ui', attempt: 1, status: 'succeeded', message: 'Native session launched and its turn ended; not implementation completion' }),
    event(RUN_SUCCEEDED, 3, { type: 'result_published', node_id: 'verify_ui', attempt: 1, message: 'UI verification packet captured', result_uri: runDetails[RUN_SUCCEEDED].snapshot.nodes.find(node => node.node_id === 'verify_ui')!.result_uri }),
    event(RUN_SUCCEEDED, 4, { type: 'status_changed', node_id: 'review', attempt: 1, status: 'succeeded', message: `Reviewer session ${REVIEWER_SESSION} approved the candidate` }),
    event(RUN_SUCCEEDED, 5, { type: 'status_changed', node_id: 'integrate', attempt: 1, status: 'succeeded', message: 'Fast-forwarded the feature branch' }),
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
  [RUN_BLOCKED]: [
    event(RUN_BLOCKED, 1, { type: 'status_changed', node_id: 'candidate', attempt: 1, status: 'succeeded', message: 'Combined candidate checks passed' }),
    event(RUN_BLOCKED, 2, { type: 'status_changed', node_id: 'review', attempt: 1, status: 'running', message: 'Launching the print-mode reviewer' }),
    event(RUN_BLOCKED, 3, { type: 'status_changed', node_id: 'review', attempt: 1, status: 'failed', message: BLOCKED_MESSAGE }),
  ],
  [RUN_LEGACY]: [
    event(RUN_LEGACY, 1, { type: 'status_changed', node_id: 'review', attempt: 1, status: 'succeeded', message: 'Review accepted (recorded before review results were exported)' }),
    event(RUN_LEGACY, 2, { type: 'status_changed', node_id: 'integrate', attempt: 1, status: 'succeeded', message: 'Fast-forwarded the feature branch' }),
  ],
}

export const artifactFiles: Record<string, ArtifactFile[]> = {
  [RUN_SUCCEEDED]: [...UI_ARTIFACTS, ...ADAPTER_ARTIFACTS, REVIEW_DIFF_ARTIFACT],
  [RUN_FAILED]: [...UI_ARTIFACTS, ...ADAPTER_ARTIFACTS],
  [RUN_AWAITING]: [...UI_ARTIFACTS, ...ADAPTER_ARTIFACTS],
  [RUN_BLOCKED]: [...UI_ARTIFACTS, ...ADAPTER_ARTIFACTS],
  [RUN_LEGACY]: [...UI_ARTIFACTS, ...ADAPTER_ARTIFACTS],
}

// ---- Worker tasks, prompts and the reviewer's quotes ----------------------------------------------------

/** A requirement the reviewer quoted verbatim from the UI task. */
export const UI_QUOTE = 'Show every finding with its severity and disposition.'
/** A verbatim UI-task requirement that names a directory; the seeds put a real path here, the mocks the marker. */
export const uiPathQuote = (leak = PATH_TOKEN) => `Write screenshots below ${leak} only.`
/** A requirement the reviewer quoted verbatim from the adapter task. */
export const ADAPTER_QUOTE = 'Serve the review verdict from the export section only.'
/** A paraphrase of the UI requirement: not a verbatim substring of any task, so it never links. */
export const PARAPHRASED_QUOTE = 'Show each finding with severity and disposition'

export function uiTask(leak = PATH_TOKEN): string {
  return [
    '# UI worker',
    '',
    'Render the review verdict on the review node and the run inputs on the worker nodes.',
    '',
    '## Deliverables',
    '',
    `- ${UI_QUOTE}`,
    '- Link each verbatim requirement quote to the task that contains it.',
    `- ${uiPathQuote(leak)}`,
    '',
    'Approved ownership and checks:',
    '{"node_id": "ui", "owned_paths": ["src/App.tsx", "src/App.css", "src/projects", "tests/project-workflows"], "checks": ["frontend-build", "frontend-unit", "frontend-typecheck", "project-workflows-browser"]}',
  ].join('\n')
}

export function adapterTask(): string {
  return [
    '# Adapter worker',
    '',
    '## Deliverables',
    '',
    `- ${ADAPTER_QUOTE}`,
    '- Redact absolute paths from every served text.',
    '',
    'Approved ownership and checks:',
    '{"node_id": "adapter", "owned_paths": ["server", "config/projects.example.json"], "checks": ["backend-unit"]}',
  ].join('\n')
}

export const uiPrompt = (leak = PATH_TOKEN) => `You are a workflow worker in your own worktree. Work only inside your owned paths and hand off with a completion signal.\n\n${uiTask(leak)}`

/** The UI worker's completion summary; the seeds put a real path here, the mocks the marker. */
export const uiCompletionSummary = (leak = PATH_TOKEN) => `Implemented the review panel and the task panels; browser screenshots are under ${leak} for inspection.`
export const ADAPTER_COMPLETION_SUMMARY = 'Served the review and inputs routes with path redaction.'
export const ADAPTER_HANDOFF_SUMMARY = 'Served the review and inputs routes with path redaction; the diff artifact is hash-checked.'
export const ADAPTER_HANDOFF_ASSUMPTION = 'The artifact byte limit stays at the default.'
export const sourceBranch = (runId: string) => `feature/${WORKFLOW_ID}/${runId}`

// ---- Raw export sections (the shapes workflow/export_state.py 1.2.0 writes) ------------------------------

export type RawFinding = {
  severity: 'P0' | 'P1' | 'P2'
  message: string
  disposition: 'open' | 'resolved' | 'accepted'
  worker: 'ui' | 'adapter' | 'both' | 'none' | null
  requirement: string | null
}
export type RawReviewSection = {
  attempt: number
  transport: 'native' | 'print' | 'manual'
  reviewer_session_id: string
  independent: true
  bundle_sha256: string
  candidate_commit: string
  verdict: 'approved' | 'blocked'
  findings: RawFinding[]
  reviewed_at: string
  diff: { path: 'review.diff'; sha256: string; bytes: number } | null
}
export type RawCheck = { id: string; kind: 'build' | 'typecheck' | 'unit' | 'integration' | 'contract' | 'browser'; argv: string[]; command: string; timeout_seconds: number; scenarios: { id: string; description: string }[] }
export type RawWorkerInput = {
  role: 'frontend' | 'backend'
  task: string
  prompt: string | null
  owned_paths: string[]
  checks: RawCheck[]
  launch: { session_id: string | null; launch_token: string; launch_requested_at: string; native_started_at: number | null; observed_state: string | null; status: string; launcher_invocations: number; background_id: string | null } | null
  completion: { status: 'completed' | 'blocked'; summary: string; open_assumptions: string[] } | null
  handoff: { summary: string; open_assumptions: string[] } | null
  stop: { stopped: boolean; confirmed_at: string | null } | null
}
export type RawInputsSection = {
  feature: string
  policy_version: string
  base_commit: string
  source_branch: string | null
  mode: 'automatic' | 'manual'
  automatic: { finish: string; permission_mode: string; worker_timeout_seconds: number; review_timeout_seconds: number; reviewer_transport: 'native' | 'print' | null } | null
  setup: { argv: string[]; command: string; timeout_seconds: number }[]
  max_verification_attempts: number
  failure_drill: { node_id: string; phase: string; attempt: number } | null
  workers: Record<'ui' | 'adapter', RawWorkerInput>
}

/** Receipts store `+00:00` offsets; the adapter normalises them to a trailing Z. */
const offset = (iso: string) => iso.replace(/Z$/, '+00:00')
const zulu = (value: string) => (value.endsWith('+00:00') ? `${value.slice(0, -6)}Z` : value)

/** The reviewer's findings for a run; one message and one quote name a directory (redacted by the adapter). */
export function reviewFindings(runId: string, leak = PATH_TOKEN): RawFinding[] {
  if (runId === RUN_BLOCKED) {
    return [
      { severity: 'P1', message: 'The inputs route still serves the worktree path of the adapter lane.', disposition: 'open', worker: 'adapter', requirement: ADAPTER_QUOTE },
      { severity: 'P2', message: 'Naming of the review panel props was inconsistent; fixed before the verdict.', disposition: 'resolved', worker: 'ui', requirement: null },
    ]
  }
  return [
    { severity: 'P2', message: 'The findings table drops the disposition column below 480px.', disposition: 'open', worker: 'ui', requirement: UI_QUOTE },
    { severity: 'P2', message: `Screenshots were written beside ${leak} instead of below it.`, disposition: 'open', worker: 'ui', requirement: uiPathQuote(leak) },
    { severity: 'P2', message: 'The summary line paraphrases the disposition counts.', disposition: 'open', worker: 'ui', requirement: PARAPHRASED_QUOTE },
    { severity: 'P2', message: 'The root Playwright suite is not part of the policy check set.', disposition: 'open', worker: 'none', requirement: null },
    { severity: 'P2', message: 'The review route re-reads the export on every request.', disposition: 'accepted', worker: 'adapter', requirement: ADAPTER_QUOTE },
    { severity: 'P2', message: 'Both lanes duplicate the redaction regex in their tests.', disposition: 'accepted', worker: 'both', requirement: null },
  ]
}

/** The export's `review` section for a run, or null for runs whose review was not reached or not exported. */
export function rawReviewSection(runId: string, leak = PATH_TOKEN): RawReviewSection | null {
  if (runId === RUN_SUCCEEDED) {
    return {
      attempt: 1, transport: 'native', reviewer_session_id: REVIEWER_SESSION, independent: true, bundle_sha256: BUNDLE_SHA256, candidate_commit: CANDIDATE_COMMIT,
      verdict: 'approved', findings: reviewFindings(runId, leak), reviewed_at: offset(T3),
      diff: { path: 'review.diff', sha256: sha256(REVIEW_DIFF), bytes: Buffer.byteLength(REVIEW_DIFF) },
    }
  }
  if (runId === RUN_BLOCKED) {
    return {
      attempt: 1, transport: 'print', reviewer_session_id: PRINT_REVIEWER_SESSION, independent: true, bundle_sha256: BUNDLE_SHA256, candidate_commit: CANDIDATE_COMMIT,
      verdict: 'blocked', findings: reviewFindings(runId, leak), reviewed_at: offset(T3), diff: null,
    }
  }
  return null
}

export const UI_CHECKS: RawCheck[] = [
  { id: 'frontend-build', kind: 'build', argv: ['npm', 'run', 'build'], command: 'npm run build', timeout_seconds: 180, scenarios: [] },
  { id: 'frontend-unit', kind: 'unit', argv: ['npm', 'run', 'test:unit'], command: 'npm run test:unit', timeout_seconds: 180, scenarios: [] },
  { id: 'frontend-typecheck', kind: 'typecheck', argv: ['npx', '--no-install', 'tsc', '-b'], command: 'npx --no-install tsc -b', timeout_seconds: 120, scenarios: [] },
  {
    id: 'project-workflows-browser', kind: 'browser',
    argv: ['npx', '--no-install', 'playwright', 'test', '--config=tests/project-workflows/playwright.config.ts'],
    command: 'npx --no-install playwright test --config=tests/project-workflows/playwright.config.ts', timeout_seconds: 300,
    scenarios: [
      { id: 'review-verdict', description: 'The review node shows the verdict and findings' },
      { id: 'finding-to-task', description: 'A verbatim requirement quote links to the worker task' },
    ],
  },
]
export const ADAPTER_CHECKS: RawCheck[] = [
  { id: 'backend-unit', kind: 'unit', argv: ['npx', '--no-install', 'tsx', '--test', 'server/projects.test.ts'], command: 'npx --no-install tsx --test server/projects.test.ts', timeout_seconds: 180, scenarios: [] },
]

const launchToken = (lane: 'ui' | 'adapter') => `00000000-0000-4000-8000-00000000000${lane === 'ui' ? 1 : 2}`

function rawWorker(lane: 'ui' | 'adapter', runId: string, leak: string, requestedAt: string): RawWorkerInput {
  const ui = lane === 'ui'
  const failedAdapter = !ui && runId === RUN_FAILED
  return {
    role: ui ? 'frontend' : 'backend',
    task: ui ? uiTask(leak) : adapterTask(),
    prompt: ui ? uiPrompt(leak) : null,
    owned_paths: ui ? ['src/App.tsx', 'src/App.css', 'src/projects', 'tests/project-workflows'] : ['server', 'config/projects.example.json'],
    checks: ui ? UI_CHECKS : ADAPTER_CHECKS,
    launch: {
      session_id: ui ? UI_SESSION : ADAPTER_SESSION, launch_token: launchToken(lane), launch_requested_at: offset(requestedAt),
      native_started_at: Date.parse(requestedAt) + 2000, observed_state: failedAdapter ? 'working' : 'done', status: 'attached_session_available',
      launcher_invocations: 1, background_id: ui ? '10001' : '10002',
    },
    completion: failedAdapter ? null : ui
      ? { status: 'completed', summary: uiCompletionSummary(leak), open_assumptions: [UI_ASSUMPTION] }
      : { status: 'completed', summary: ADAPTER_COMPLETION_SUMMARY, open_assumptions: [] },
    // The UI handoff repeats the completion; the adapter's was amended when it was accepted, so it differs.
    handoff: failedAdapter ? null : ui
      ? { summary: uiCompletionSummary(leak), open_assumptions: [UI_ASSUMPTION] }
      : { summary: ADAPTER_HANDOFF_SUMMARY, open_assumptions: [ADAPTER_HANDOFF_ASSUMPTION] },
    stop: failedAdapter ? { stopped: false, confirmed_at: null } : { stopped: true, confirmed_at: offset(T2) },
  }
}

/** The export's `inputs` section for a run, or null for the legacy export that predates it. */
export function rawInputsSection(runId: string, leak = PATH_TOKEN): RawInputsSection | null {
  if (runId === RUN_LEGACY) return null
  const requestedAt = runId === RUN_SUCCEEDED ? T0 : runId === RUN_AWAITING ? T2 : T1
  const manual = runId === RUN_AWAITING
  return {
    feature: FEATURE_NAME, policy_version: '1.1.0', base_commit: BASE_COMMIT, source_branch: sourceBranch(runId),
    mode: manual ? 'manual' : 'automatic',
    automatic: manual ? null : {
      finish: 'verified-feature-branch', permission_mode: 'bypassPermissions',
      worker_timeout_seconds: runId === RUN_SUCCEEDED ? 14400 : 3600, review_timeout_seconds: 1800,
      // The failed run was pinned before the setting existed and never reviewed: the export records null, never a guess.
      reviewer_transport: runId === RUN_BLOCKED ? 'print' : runId === RUN_FAILED ? null : 'native',
    },
    setup: [{ argv: ['npm', 'ci'], command: 'npm ci', timeout_seconds: 600 }],
    max_verification_attempts: 3,
    failure_drill: runId === RUN_FAILED ? { node_id: 'adapter', phase: 'worker', attempt: 1 } : null,
    workers: { ui: rawWorker('ui', runId, leak, requestedAt), adapter: rawWorker('adapter', runId, leak, requestedAt) },
  }
}

// ---- Projections onto the contract (what the mocks serve) ----------------------------------------------

/** The lanes whose task text contains the quote verbatim; the same rule the adapter applies. */
function lanesQuoting(requirement: string | null, tasks: Record<'ui' | 'adapter', string>): ('ui' | 'adapter')[] {
  if (requirement === null) return []
  return (['ui', 'adapter'] as const).filter(lane => tasks[lane].includes(requirement))
}

function projectReview(runId: string, section: RawReviewSection, tasks: Record<'ui' | 'adapter', string>): ReviewResult {
  return validateReviewResult({
    contract_version: '1.2.0', run_id: runId, node_id: 'review', attempt: section.attempt,
    reviewer: { session_id: section.reviewer_session_id, transport: section.transport, independent: true },
    bundle_sha256: section.bundle_sha256, candidate_commit: section.candidate_commit, verdict: section.verdict,
    findings: section.findings.map(finding => ({ ...finding, requirement_found_in: lanesQuoting(finding.requirement, tasks) })),
    reviewed_at: zulu(section.reviewed_at),
    diff: section.diff === null ? null : { artifact_id: REVIEW_DIFF_ARTIFACT_ID, kind: 'patch', uri: `${apiRunPath(runId)}/artifacts/${REVIEW_DIFF_ARTIFACT_ID}`, sha256: section.diff.sha256 },
  })
}

function projectInputs(runId: string, section: RawInputsSection): RunInputs {
  return validateRunInputs({
    contract_version: '1.2.0', run_id: runId, feature: section.feature, base_commit: section.base_commit, source_branch: section.source_branch,
    mode: section.mode, automatic: section.automatic,
    setup: section.setup.map(step => ({ command: step.command, timeout_seconds: step.timeout_seconds })),
    max_verification_attempts: section.max_verification_attempts,
    workers: (['ui', 'adapter'] as const).map(lane => {
      const worker = section.workers[lane]
      return {
        node_id: lane, launch_node_id: `launch_${lane}`, role: worker.role,
        task: { text: worker.task, truncated: false },
        prompt: worker.prompt === null ? null : { text: worker.prompt, truncated: false },
        owned_paths: worker.owned_paths,
        checks: worker.checks.map(({ id, kind, command, timeout_seconds, scenarios }) => ({ id, kind, command, timeout_seconds, scenarios })),
        launch: worker.launch === null ? null : {
          session_id: worker.launch.session_id, launch_requested_at: zulu(worker.launch.launch_requested_at),
          native_started_at: worker.launch.native_started_at === null ? null : new Date(worker.launch.native_started_at).toISOString(),
          observed_state: worker.launch.observed_state, status: worker.launch.status, launcher_invocations: worker.launch.launcher_invocations,
        },
        completion: worker.completion, handoff: worker.handoff,
        stop: worker.stop === null ? null : { stopped: worker.stop.stopped, confirmed_at: worker.stop.confirmed_at === null ? null : zulu(worker.stop.confirmed_at) },
      }
    }),
  })
}

const taskTexts = (section: RawInputsSection | null): Record<'ui' | 'adapter', string> => ({ ui: section?.workers.ui.task ?? '', adapter: section?.workers.adapter.task ?? '' })

const ALL_RUNS = [RUN_SUCCEEDED, RUN_FAILED, RUN_AWAITING, RUN_BLOCKED, RUN_LEGACY]

/** Projected review results per run (runs without one are absent: the mock answers 404 REVIEW_NOT_FOUND). */
export const reviewResults: Record<string, ReviewResult> = Object.fromEntries(ALL_RUNS.flatMap(runId => {
  const section = rawReviewSection(runId)
  return section === null ? [] : [[runId, projectReview(runId, section, taskTexts(rawInputsSection(runId)))]]
}))

/** Projected run inputs per run (the legacy run is absent: the mock answers 404 INPUTS_NOT_FOUND). */
export const runInputs: Record<string, RunInputs> = Object.fromEntries(ALL_RUNS.flatMap(runId => {
  const section = rawInputsSection(runId)
  return section === null ? [] : [[runId, projectInputs(runId, section)]]
}))
