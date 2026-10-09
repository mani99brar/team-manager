import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { schemas as projectSchemas, validateAttackResult, validateDefinition, validatePanelResults, validateReviewResult, validateRunDetail, validateRunInputs, validateSidecarLedger, type PanelRecord, type RunDetail, type RunInputs } from '../contracts/projects/v1.ts'
import { eventSchema, validateWorkerResult, type WorkflowEvent } from '../contracts/workflow/v1.ts'
import { ATTACK_TWINS, RUN_ATTACK_WAITING } from '../tests/project-workflows/fixtures/ux-attack.ts'
import { SIDECAR_TWINS } from '../tests/project-workflows/fixtures/ux-sidecar.ts'
import { seedCandidate } from '../tests/project-workflows/seed.ts'
import { createApp } from './app.ts'
import { defaultFixtureRoot, fixtureLocations } from './config.ts'
import { mapRepairs, mapReviewRounds, redactDeep } from './fixLoop.ts'
import { ATTACK_BYTE_LIMIT, PANEL_BYTE_LIMIT, RunStore, SIDECAR_LEDGER_BYTE_LIMIT, laneMap, normalizeEvents, projectSnapshot, redactPaths, type RunStoreOptions } from './projects.ts'
import { PROJECTS_CONFIG_ENV, ProjectsConfigError, assertProjectsConfig, canonicalJson, definitionRevision, loadProjectsConfig, parseProjectsConfig, projectsConfigReloader } from './projectsConfig.ts'

/**
 * Every test builds disposable run roots in the documented producer format (plan.json, atomic run-state.json,
 * events.jsonl and verification/<phase>/<node>/<attempt>/packet.json with artifacts beside it). No live
 * application, skills or workflow data is read, and the API must never write into a run root.
 */

const GRAPH_NODES = [
  { node_id: 'launch_ui', label: 'Launch UI worker', kind: 'worker', depends_on: [] },
  { node_id: 'launch_adapter', label: 'Launch adapter worker', kind: 'worker', depends_on: [] },
  { node_id: 'handoff', label: 'Freeze worker handoffs', kind: 'prepare', depends_on: ['launch_ui', 'launch_adapter'] },
  { node_id: 'verify_ui', label: 'Verify UI', kind: 'verification', depends_on: ['handoff'] },
  { node_id: 'verify_adapter', label: 'Verify adapter', kind: 'verification', depends_on: ['handoff'] },
  { node_id: 'candidate', label: 'Verify combined candidate', kind: 'verification', depends_on: ['verify_ui', 'verify_adapter'] },
  { node_id: 'review', label: 'Independent review', kind: 'review', depends_on: ['candidate'] },
  { node_id: 'approval', label: 'Integration approval', kind: 'integration', depends_on: ['review'] },
  { node_id: 'integrate', label: 'Integrate candidate', kind: 'integration', depends_on: ['approval'] },
]
const DEFINITION = { name: 'Feature implementation', nodes: GRAPH_NODES }
/** The definition workflow/export_state.py builds for a run with the given lanes (export 1.3.0). */
function graphNodes(lanes: string[]) {
  return [
    ...lanes.map(lane => ({ node_id: `launch_${lane}`, label: `Launch ${lane} worker`, kind: 'worker', depends_on: [] })),
    { node_id: 'handoff', label: 'Freeze worker handoffs', kind: 'prepare', depends_on: lanes.map(lane => `launch_${lane}`) },
    ...lanes.map(lane => ({ node_id: `verify_${lane}`, label: `Verify ${lane}`, kind: 'verification', depends_on: ['handoff'] })),
    { node_id: 'candidate', label: 'Verify combined candidate', kind: 'verification', depends_on: lanes.map(lane => `verify_${lane}`) },
    { node_id: 'review', label: 'Independent review', kind: 'review', depends_on: ['candidate'] },
    { node_id: 'approval', label: 'Integration approval', kind: 'integration', depends_on: ['review'] },
    { node_id: 'integrate', label: 'Integrate candidate', kind: 'integration', depends_on: ['approval'] },
  ]
}
const BASE = 'a'.repeat(40)
const OUTPUT = 'b'.repeat(40)
const T0 = '2026-03-01T10:00:00.000000Z'
const T1 = '2026-03-01T10:05:00.000000Z'
const T2 = '2026-03-01T10:10:00.000000Z'
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic png body')])

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const json = (value: unknown) => JSON.stringify(value, null, 2)

type RawEvent = { sequence: number; time: string; node: string; status: string; message: string }
type Registration = { phase: 'worker' | 'candidate'; node_id: string; attempt: number; path: string; sha256: string }

type PacketSpec = {
  phase?: 'worker' | 'candidate'
  node: string
  attempt?: number
  gate?: { status: 'passed' | 'blocked'; reasons: string[] }
  /** `path` is the repo-relative path of a `file` artifact (a changed file captured from the snapshot). */
  artifacts?: { id: string; kind: 'log' | 'screenshot' | 'test_report' | 'patch' | 'other' | 'file'; content: Buffer | string; uri?: string; registeredSha?: string; skipWrite?: boolean; path?: string }[]
  session?: string
  summary?: string
  assumptions?: string[]
  changed?: string[]
  /** Mutates the packet JSON just before it is written (the registration hash follows the mutation). */
  mutate?: (packet: Record<string, unknown>) => void
  /** Corrupts the file after its hash was registered. */
  tamper?: boolean
}

type RunSpec = {
  runId: string
  definition?: { name: string; nodes: typeof GRAPH_NODES }
  values?: Record<string, unknown>
  next?: string[]
  tasks?: { node_id: string; error: string | null; interrupts: Record<string, unknown>[]; result: Record<string, unknown> | null }[]
  events?: RawEvent[]
  eventsFile?: boolean | string
  packets?: PacketSpec[]
  created?: string
  updated?: string
  planRunId?: string
  exportRunId?: string
  skipPlan?: boolean
  registrations?: (registrations: Registration[]) => Registration[]
  stateText?: string
  /** Export version; defaults to 1.2.0 when a section is given and 1.0.0 otherwise. */
  version?: string
  /** The export's `review` section as persisted (undefined leaves the key out; null is an explicit null). */
  review?: unknown
  /** The export's `inputs` section as persisted (undefined leaves the key out; null is an explicit null). */
  inputs?: unknown
  /** Content written to `<run>/review.diff`, the diff the reviewer saw. */
  diffFile?: Buffer | string
  /** Export 1.6.0: the `sidecar` section as persisted (undefined leaves the key out; null is an explicit null). */
  sidecar?: unknown
  /** Content written to the live `<run>/sidecar.ledger.json`. */
  liveLedger?: string
  /** Export 1.8.0: the `attack` section as persisted (undefined leaves the key out; null is an explicit null). */
  attack?: unknown
  /** Content written to the live `<run>/attack.json`. */
  liveAttack?: string
  /** Export 1.9.0: the `panels` section as persisted (undefined leaves the key out; null is an explicit null). */
  panels?: unknown
  /** Content written to the live `<run>/panel.json`. */
  livePanel?: string
  /** Export 1.10.0: the `fix_loop` section as persisted (undefined leaves the key out; null is an explicit null). */
  fixLoop?: unknown
  /** Further files of the run directory (the fix loop's live records), by name. */
  files?: Record<string, string | Buffer>
}

/** One run directory exactly as workflow/export_state.py and workflow/checks.py persist it. */
async function writeRun(root: string, spec: RunSpec): Promise<string> {
  const dir = join(root, spec.runId)
  await mkdir(dir, { recursive: true })
  const runId = spec.exportRunId ?? spec.runId
  if (spec.diffFile !== undefined) await writeFile(join(dir, 'review.diff'), spec.diffFile)
  if (spec.liveLedger !== undefined) await writeFile(join(dir, 'sidecar.ledger.json'), spec.liveLedger)
  if (spec.liveAttack !== undefined) await writeFile(join(dir, 'attack.json'), spec.liveAttack)
  if (spec.livePanel !== undefined) await writeFile(join(dir, 'panel.json'), spec.livePanel)
  for (const [name, content] of Object.entries(spec.files ?? {})) await writeFile(join(dir, name), content)
  const registrations: Registration[] = []
  for (const packetSpec of spec.packets ?? []) {
    const phase = packetSpec.phase ?? 'worker'
    const attempt = packetSpec.attempt ?? 1
    const packetDir = join(dir, 'verification', phase, packetSpec.node, String(attempt))
    const artifactsDir = join(packetDir, 'artifacts')
    await mkdir(artifactsDir, { recursive: true })
    const artifacts = []
    const paths: Record<string, string> = {}
    for (const artifact of packetSpec.artifacts ?? []) {
      const content = Buffer.isBuffer(artifact.content) ? artifact.content : Buffer.from(artifact.content)
      const uri = artifact.uri ?? artifact.id
      if (!artifact.skipWrite) await writeFile(join(artifactsDir, uri), content)
      artifacts.push({ artifact_id: artifact.id, kind: artifact.kind, ...(artifact.path !== undefined ? { path: artifact.path } : {}), uri, sha256: artifact.registeredSha ?? sha256(content) })
      paths[artifact.id] = join(artifactsDir, uri)
    }
    const logs = artifacts.filter(item => item.kind === 'log')
    const checks = logs.map((log, index) => ({
      command: `npm run check-${index}`, cwd: join(packetDir, 'worktree'), started_at: T0, finished_at: T1, exit_code: 0, log_artifact_id: log.artifact_id,
    }))
    const expected = { run_id: runId, node_id: packetSpec.node, attempt, base_commit: BASE, output_commit: OUTPUT, verification_cwd: join(packetDir, 'worktree') }
    const packet: Record<string, unknown> = {
      phase,
      expected,
      result: {
        contract_version: '1.0.0', run_id: runId, node_id: packetSpec.node, attempt, session_id: packetSpec.session ?? `${packetSpec.node}-session-0001`,
        status: 'succeeded', base_commit: BASE, output_commit: OUTPUT, changed_files: packetSpec.changed ?? [`src/${packetSpec.node}.ts`],
        checks, open_assumptions: packetSpec.assumptions ?? [], artifacts,
        summary: packetSpec.summary ?? `Trusted ${phase} check capture; not integration approval`, error: null,
      },
      evidence: { version: '1.0.0', policy_sha256: 'c'.repeat(64), run_id: runId, node_id: packetSpec.node, attempt, output_commit: OUTPUT, checks: [] },
      artifact_root: artifactsDir, artifact_paths: paths, capture_errors: [], effective_commands: [],
      gate: { ...(packetSpec.gate ?? { status: 'passed', reasons: [] }), pending_gates: ['independent_review', 'integration_approval'], integration_allowed: false },
    }
    packetSpec.mutate?.(packet)
    const text = json(packet)
    await writeFile(join(packetDir, 'packet.json'), text)
    registrations.push({ phase, node_id: packetSpec.node, attempt, path: `verification/${phase}/${packetSpec.node}/${attempt}/packet.json`, sha256: sha256(text) })
    if (packetSpec.tamper) await writeFile(join(packetDir, 'packet.json'), text + '\n')
  }
  const created = spec.created ?? T0
  if (!spec.skipPlan) {
    await writeFile(join(dir, 'plan.json'), json({
      run_id: spec.planRunId ?? runId, repository: '/synthetic/repository', base_commit: BASE, allow_edits: true, mode: 'interactive',
      nodes: { ui: { worktree: join(dir, 'worktree-ui') }, adapter: { worktree: join(dir, 'worktree-adapter') } },
      policy_sha256: 'c'.repeat(64), created_at: created, source_branch: 'feature/synthetic',
    }))
  }
  const events = spec.events ?? []
  if (spec.eventsFile !== false) {
    const text = typeof spec.eventsFile === 'string' ? spec.eventsFile : events.map(event => JSON.stringify(event) + '\n').join('')
    if (text.length > 0) await writeFile(join(dir, 'events.jsonl'), text)
  }
  const sections = spec.review !== undefined || spec.inputs !== undefined
  const state = {
    version: spec.version ?? (sections ? '1.2.0' : '1.0.0'), run_id: runId, base_commit: BASE, created_at: created, definition: spec.definition ?? DEFINITION,
    values: { run_id: runId, ...(spec.values ?? {}) }, next: spec.next ?? [], tasks: spec.tasks ?? [], events,
    verification_packets: spec.registrations ? spec.registrations(registrations) : registrations, updated_at: spec.updated ?? T1,
    ...(spec.review !== undefined ? { review: spec.review } : {}), ...(spec.inputs !== undefined ? { inputs: spec.inputs } : {}),
    ...(spec.sidecar !== undefined ? { sidecar: spec.sidecar } : {}),
    ...(spec.attack !== undefined ? { attack: spec.attack } : {}),
    ...(spec.panels !== undefined ? { panels: spec.panels } : {}),
    ...(spec.fixLoop !== undefined ? { fix_loop: spec.fixLoop } : {}),
  }
  await writeFile(join(dir, 'run-state.json'), spec.stateText ?? json(state))
  return dir
}

// ---- Review and inputs sections exactly as workflow/export_state.py 1.2.0 writes them ---------------------------

const REVIEWER = 'dd7bdcd1-adec-4efe-bcd4-bbadc3525d95'
const BUNDLE = 'f'.repeat(64)
const DIFF = 'diff --git a/src/ui.ts b/src/ui.ts\n--- a/src/ui.ts\n+++ b/src/ui.ts\n@@ -1 +1,2 @@\n line\n+added <script>alert(1)</script>\n'
const UI_TASK = '# UI worker\n\nRender the review verdict on the review node. Show every finding with severity and disposition.\n\nApproved ownership and checks:\n{"node_id": "ui", "owned_paths": ["src/projects"]}'
const ADAPTER_TASK = '# Adapter worker\n\nServe the review route from the export section.\n\nApproved ownership and checks:\n{"node_id": "adapter", "owned_paths": ["server"]}'
const TEXT_LIMIT = 65536

type Finding = { severity: 'P0' | 'P1' | 'P2'; message: string; disposition: 'open' | 'resolved' | 'accepted'; worker: string | null; requirement: string | null; reviewer?: string | null }
type ReviewerSection = {
  reviewer_id: string; transport: 'native' | 'print' | 'manual'; session_id: string | null; verdict: 'approved' | 'blocked' | null; findings: Finding[]
  launched_at: string | null; accepted_at: string | null; status: 'accepted' | 'blocked' | 'superseded' | 'pending'
}
type ReviewSection = {
  attempt: number; transport: 'native' | 'print' | 'manual'; reviewer_session_id: string; independent: true; bundle_sha256: string; candidate_commit: string
  verdict: 'approved' | 'blocked'; findings: Finding[]; reviewers?: ReviewerSection[]; reviewed_at: string; diff: { path: string; sha256: string; bytes: number } | null
}
type WorkerInput = {
  role: string; required_check_kinds?: string[]; task: string; prompt: string | null; owned_paths: string[]
  checks: { id: string; kind: string; argv: string[]; command: string; timeout_seconds: number; scenarios: { id: string; description: string }[] }[]
  launch: { session_id: string | null; launch_token: string; launch_requested_at: string; native_started_at: number | null; observed_state: string | null; status: string; launcher_invocations: number; background_id: string | null } | null
  completion: { version?: string; status: string; summary: string; open_assumptions: string[]; untested?: string[] | null; falsifying_check?: string | null; verify_yourself?: string | null; question?: string | null } | null
  handoff: { summary: string; open_assumptions: string[] } | null
  stop: { stopped: boolean; confirmed_at: string | null } | null
  questions?: { n: number; question: string; asked_at: string; answer: string | null; answered_at: string | null }[]
}
type InputsSection = {
  feature: string; policy_version: string; base_commit: string; source_branch: string | null; mode: string
  automatic: { finish: string; permission_mode: string; worker_timeout_seconds: number; review_timeout_seconds: number; reviewer_transport: string | null } | null
  setup: { argv: string[]; command: string; timeout_seconds: number }[]; max_verification_attempts: number
  failure_drill: { node_id: string; phase: string; attempt: number } | null
  selected_workers?: string[]
  excluded_workers?: string[]
  workers: Record<string, WorkerInput>
  decisions?: string | null
  challenge?: Record<string, unknown> | null
}

const diffRegistration = (content: Buffer | string) => ({ path: 'review.diff', sha256: sha256(content), bytes: Buffer.byteLength(content) })
const finding = (overrides: Partial<Finding> = {}): Finding => ({ severity: 'P2', message: 'Finding', disposition: 'open', worker: 'ui', requirement: null, ...overrides })

function reviewSection(overrides: Partial<ReviewSection> = {}): ReviewSection {
  return {
    attempt: 1, transport: 'native', reviewer_session_id: REVIEWER, independent: true, bundle_sha256: BUNDLE, candidate_commit: OUTPUT, verdict: 'approved',
    findings: [finding({ message: 'The findings table omits the disposition column.', requirement: 'Show every finding with severity and disposition.' })],
    reviewed_at: T2, diff: diffRegistration(DIFF), ...overrides,
  }
}

function workerInput(lane: 'ui' | 'adapter', overrides: Partial<WorkerInput> = {}): WorkerInput {
  return {
    role: lane === 'ui' ? 'frontend' : 'backend',
    task: lane === 'ui' ? UI_TASK : ADAPTER_TASK,
    prompt: lane === 'ui' ? `You are a workflow worker in your own worktree.\n\n${UI_TASK}` : null,
    owned_paths: lane === 'ui' ? ['src/projects', 'tests/project-workflows'] : ['server', 'config/projects.example.json'],
    checks: lane === 'ui'
      ? [{ id: 'frontend-build', kind: 'build', argv: ['npm', 'run', 'build'], command: 'npm run build', timeout_seconds: 180, scenarios: [] },
        { id: 'project-workflows-browser', kind: 'browser', argv: ['npx', '--no-install', 'playwright', 'test', '--config=tests/project-workflows/playwright.config.ts'],
          command: 'npx --no-install playwright test --config=tests/project-workflows/playwright.config.ts', timeout_seconds: 300, scenarios: [{ id: 'review-verdict', description: 'The review node shows the verdict' }] }]
      : [{ id: 'backend-unit', kind: 'unit', argv: ['npx', '--no-install', 'tsx', '--test', 'server/projects.test.ts'], command: 'npx --no-install tsx --test server/projects.test.ts', timeout_seconds: 180, scenarios: [] }],
    launch: { session_id: `${lane}-session-0001`, launch_token: '00000000-0000-4000-8000-000000000000', launch_requested_at: '2026-03-01T10:00:00.331982+00:00',
      native_started_at: Date.parse('2026-03-01T10:00:02.771Z'), observed_state: 'working', status: 'attached_session_available', launcher_invocations: 1, background_id: `bg-${lane}` },
    completion: { status: 'completed', summary: `${lane} done`, open_assumptions: [`${lane} assumption`] },
    handoff: { summary: `${lane} done`, open_assumptions: [`${lane} assumption`] },
    stop: { stopped: true, confirmed_at: '2026-03-01T10:20:00+00:00' },
    ...overrides,
  }
}

function inputsSection(overrides: Partial<InputsSection> = {}, workers: { ui?: Partial<WorkerInput>; adapter?: Partial<WorkerInput> } = {}): InputsSection {
  return {
    feature: 'Review verdict and findings in the viewer', policy_version: '1.1.0', base_commit: BASE, source_branch: 'feature/synthetic', mode: 'automatic',
    automatic: { finish: 'verified-feature-branch', permission_mode: 'bypassPermissions', worker_timeout_seconds: 3600, review_timeout_seconds: 1800, reviewer_transport: 'native' },
    setup: [{ argv: ['npm', 'ci'], command: 'npm ci', timeout_seconds: 600 }], max_verification_attempts: 3, failure_drill: null,
    workers: { ui: workerInput('ui', workers.ui), adapter: workerInput('adapter', workers.adapter) },
    ...overrides,
  }
}

const receipt = (node: string) => ({
  node_id: node, session_id: `${node}-session-0001`, launch_token: '00000000-0000-4000-8000-000000000000', plan_digest: 'd'.repeat(64),
  worktree: `/synthetic/run/worktree-${node}`, base_commit: BASE, status: 'attached_session_available', attempt: 1, launcher_invocations: 1,
  launch_requested_at: T0, background_id: `bg-${node}`, observed_state: 'working', native_started_at: 1_700_000_000,
})
const snapshots = { ui: { commit: OUTPUT, changed_files: ['src/ui.ts'], session_id: 'ui-session-0001', summary: 'UI done', open_assumptions: [] },
  adapter: { commit: OUTPUT, changed_files: ['src/adapter.ts'], session_id: 'adapter-session-0001', summary: 'Adapter done', open_assumptions: [] } }
const launchEvents: RawEvent[] = [
  { sequence: 1, time: T0, node: 'adapter', status: 'running', message: 'Launching or reconciling the exact native session' },
  { sequence: 2, time: T0, node: 'ui', status: 'running', message: 'Launching or reconciling the exact native session' },
  { sequence: 3, time: T1, node: 'adapter', status: 'interactive', message: 'Awaiting explicit completion signal; idle is not acceptance' },
  { sequence: 4, time: T1, node: 'ui', status: 'interactive', message: 'Awaiting explicit completion signal; idle is not acceptance' },
]

/** Persisted state of a run that reached the review: both workers launched, snapshots frozen, packets passed, bundle built. */
const reviewedValues = (extra: Record<string, unknown> = {}) => ({ ui: receipt('ui'), adapter: receipt('adapter'), snapshots, ui_packet: '/x', adapter_packet: '/y', bundle: '/synthetic/review-bundle.json', ...extra })
const reviewedEvents: RawEvent[] = [...launchEvents,
  { sequence: 5, time: T1, node: 'freeze', status: 'succeeded', message: 'Immutable snapshots captured' },
  { sequence: 6, time: T1, node: 'verify_ui', status: 'passed', message: 'Required tests and artifacts passed' },
  { sequence: 7, time: T1, node: 'verify_adapter', status: 'passed', message: 'Required tests and artifacts passed' },
  { sequence: 8, time: T1, node: 'candidate_ui', status: 'passed', message: `Combined revision ${OUTPUT}` },
  { sequence: 9, time: T1, node: 'candidate_adapter', status: 'passed', message: `Combined revision ${OUTPUT}` }]
const reviewedPackets: PacketSpec[] = [{ node: 'ui' }, { node: 'adapter' }, { node: 'ui', phase: 'candidate' }, { node: 'adapter', phase: 'candidate' }]

type Harness ={ root: string; app: ReturnType<typeof createApp>; runsRoot: (project: string, workflow: string) => string }

function registry(root: string, projects: { id: string; name?: string; workflows: { id: string; definition?: unknown; runsRoot?: string }[] }[]) {
  return {
    version: 1,
    projects: projects.map(project => ({
      project_id: project.id, name: project.name ?? project.id, repository: join(root, 'repo', project.id),
      workflows: project.workflows.map(workflow => ({ workflow_id: workflow.id, runs_root: workflow.runsRoot ?? join(root, 'runs', project.id, workflow.id), definition: workflow.definition ?? DEFINITION })),
    })),
  }
}

async function harness(run: (h: Harness) => Promise<void>, projects: Parameters<typeof registry>[1] = [{ id: 'alpha', name: 'Alpha', workflows: [{ id: 'main' }] }], options: Parameters<typeof createApp>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'md-manager-projects-'))
  try {
    for (const project of projects) for (const workflow of project.workflows) {
      const runsRoot = workflow.runsRoot ?? join(root, 'runs', project.id, workflow.id)
      if (runsRoot.startsWith(root)) await mkdir(runsRoot, { recursive: true })
    }
    const config = await parseProjectsConfig(JSON.stringify(registry(root, projects)), 'test registry')
    const app = createApp([], { ...options, projects: config })
    try {
      await run({ root, app, runsRoot: (project, workflow) => join(root, 'runs', project, workflow) })
    } finally { await app.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
}

test('a workflow registered while the server runs is served without a restart; an invalid registry keeps the last one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'md-manager-projects-'))
  try {
    for (const workflow of ['main', 'fixes']) await mkdir(join(root, 'runs', 'alpha', workflow), { recursive: true })
    const path = join(root, 'projects.json')
    const one = registry(root, [{ id: 'alpha', workflows: [{ id: 'main' }] }])
    const two = registry(root, [{ id: 'alpha', workflows: [{ id: 'main' }, { id: 'fixes' }] }])
    await writeFile(path, JSON.stringify(one))
    const config = await parseProjectsConfig(JSON.stringify(one), path)
    const app = createApp([], { projects: config, refreshProjects: projectsConfigReloader(path) })
    try {
      const served = async () => projectSchemas.workflowList.parse((await get(app, url('alpha'))).json()).workflows.map(workflow => workflow.workflow_id)
      assert.deepEqual(await served(), ['main'])
      // A launch registers a new workflow (the `workflow` CLI rewrites the file).
      await writeFile(path, JSON.stringify(two))
      assert.deepEqual(await served(), ['main', 'fixes'])
      assert.equal((await get(app, url('alpha', 'fixes'))).status, 200)
      // A half-written or invalid file is not served; the last loaded registry stays in use.
      await writeFile(path, '{"version": 1, "projects": [')
      assert.deepEqual(await served(), ['main', 'fixes'])
      await rm(path)
      assert.deepEqual(await served(), ['main', 'fixes'])
      await writeFile(path, JSON.stringify(one))
      assert.deepEqual(await served(), ['main'])
      assert.equal((await get(app, url('alpha', 'fixes'))).status, 404)
    } finally { await app.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

/** Contract paths: a project lists workflows, a workflow lists runs, a run has detail plus sub-resources in `rest`. */
const url = (project: string, workflow?: string, run?: string, rest = '') =>
  `/api/projects/${encodeURIComponent(project)}/workflows${workflow ? `/${encodeURIComponent(workflow)}/runs` : ''}${run ? `/${encodeURIComponent(run)}` : ''}${rest}`

async function get(app: Harness['app'], path: string) {
  const response = await app.inject({ method: 'GET', url: path })
  return { status: response.statusCode, body: response.body, json: () => response.json(), headers: response.headers }
}

function assertError(response: { status: number; body: string; json: () => unknown }, status: number, code: string, root?: string) {
  assert.equal(response.status, status, response.body)
  const body = response.json() as { error: { code: string; message: string } }
  assert.deepEqual(Object.keys(body), ['error'])
  assert.equal(body.error.code, code)
  assert.ok(typeof body.error.message === 'string' && body.error.message.length > 0)
  if (root) assert.ok(!response.body.includes(root), `absolute paths are never disclosed: ${response.body}`)
  assert.ok(!/\/(?:home|tmp|var)\//.test(body.error.message), `message leaks a path: ${body.error.message}`)
}

// ---------------------------------------------------------------------------------------------------------------
// Configuration

test('unset or blank MD_MANAGER_PROJECTS_CONFIG means an empty registry; an explicit file must exist and be valid', async () => {
  assert.deepEqual(await loadProjectsConfig({}), { projects: [], configPath: null })
  assert.deepEqual(await loadProjectsConfig({ [PROJECTS_CONFIG_ENV]: '   ' }), { projects: [], configPath: null })
  const root = await mkdtemp(join(tmpdir(), 'md-manager-projects-config-'))
  try {
    await assert.rejects(loadProjectsConfig({ [PROJECTS_CONFIG_ENV]: join(root, 'missing.json') }), ProjectsConfigError)
    await writeFile(join(root, 'bad.json'), '{ not json')
    await assert.rejects(loadProjectsConfig({ [PROJECTS_CONFIG_ENV]: join(root, 'bad.json') }), ProjectsConfigError)
    await writeFile(join(root, 'good.json'), JSON.stringify(registry(root, [{ id: 'p', workflows: [{ id: 'w' }] }])))
    const loaded = await loadProjectsConfig({ [PROJECTS_CONFIG_ENV]: join(root, 'good.json') })
    assert.equal(loaded.configPath, join(root, 'good.json'))
    assert.equal(loaded.projects.length, 1)
    assert.equal(loaded.projects[0].workflows[0].runs_root, join(root, 'runs', 'p', 'w'))
    validateDefinition(loaded.projects[0].workflows[0].definition)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('rejects malformed registries: shape, IDs, paths, duplicate scopes, overlapping roots and invalid graphs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'md-manager-projects-config-'))
  const base = () => registry(root, [{ id: 'p', workflows: [{ id: 'w' }] }])
  const cases: [string, (config: ReturnType<typeof registry>) => unknown][] = [
    ['wrong version', config => ({ ...config, version: 2 })],
    ['missing projects', config => ({ version: config.version })],
    ['unknown top-level key', config => ({ ...config, extra: true })],
    ['unknown project key', config => ({ ...config, projects: [{ ...config.projects[0], demo: true }] })],
    ['project ID with a slash', config => ({ ...config, projects: [{ ...config.projects[0], project_id: 'a/b' }] })],
    ['project ID starting with a dot', config => ({ ...config, projects: [{ ...config.projects[0], project_id: '.hidden' }] })],
    ['blank name', config => ({ ...config, projects: [{ ...config.projects[0], name: '  ' }] })],
    ['relative repository', config => ({ ...config, projects: [{ ...config.projects[0], repository: 'relative/path' }] })],
    ['tilde runs_root', config => ({ ...config, projects: [{ ...config.projects[0], workflows: [{ ...config.projects[0].workflows[0], runs_root: '~/runs' }] }] })],
    ['root runs_root', config => ({ ...config, projects: [{ ...config.projects[0], workflows: [{ ...config.projects[0].workflows[0], runs_root: '/' }] }] })],
    ['duplicate project', config => ({ ...config, projects: [config.projects[0], { ...config.projects[0], workflows: [] }] })],
    ['duplicate workflow', config => ({ ...config, projects: [{ ...config.projects[0], workflows: [config.projects[0].workflows[0], { ...config.projects[0].workflows[0], runs_root: join(root, 'other') }] }] })],
    ['identical runs_root across projects', config => ({ ...config, projects: [config.projects[0], { ...config.projects[0], project_id: 'q' }] })],
    ['nested runs_root', config => ({ ...config, projects: [config.projects[0], { ...config.projects[0], project_id: 'q', workflows: [{ ...config.projects[0].workflows[0], runs_root: join(config.projects[0].workflows[0].runs_root, 'nested') }] }] })],
    ['definition without nodes', config => ({ ...config, projects: [{ ...config.projects[0], workflows: [{ ...config.projects[0].workflows[0], definition: { name: 'x', nodes: [] } }] }] })],
    ['definition with a revision field', config => ({ ...config, projects: [{ ...config.projects[0], workflows: [{ ...config.projects[0].workflows[0], definition: { ...DEFINITION, definition_revision: 'a'.repeat(64) } }] }] })],
    ['unknown dependency', config => ({ ...config, projects: [{ ...config.projects[0], workflows: [{ ...config.projects[0].workflows[0], definition: { name: 'x', nodes: [{ node_id: 'a', label: 'A', kind: 'worker', depends_on: ['b'] }] } }] }] })],
    ['cycle', config => ({ ...config, projects: [{ ...config.projects[0], workflows: [{ ...config.projects[0].workflows[0], definition: { name: 'x', nodes: [{ node_id: 'a', label: 'A', kind: 'worker', depends_on: ['b'] }, { node_id: 'b', label: 'B', kind: 'worker', depends_on: ['a'] }] } }] }] })],
    ['duplicate node', config => ({ ...config, projects: [{ ...config.projects[0], workflows: [{ ...config.projects[0].workflows[0], definition: { name: 'x', nodes: [GRAPH_NODES[0], GRAPH_NODES[0]] } }] }] })],
    ['unknown node kind', config => ({ ...config, projects: [{ ...config.projects[0], workflows: [{ ...config.projects[0].workflows[0], definition: { name: 'x', nodes: [{ node_id: 'a', label: 'A', kind: 'agent', depends_on: [] }] } }] }] })],
  ]
  try {
    for (const [label, mutate] of cases) {
      await assert.rejects(parseProjectsConfig(JSON.stringify(mutate(base())), label), ProjectsConfigError, label)
    }
    // Two spellings of one directory (a symlink alias) are also an overlap once the roots exist.
    await mkdir(join(root, 'real'))
    await symlink(join(root, 'real'), join(root, 'alias'))
    const aliased = registry(root, [{ id: 'p', workflows: [{ id: 'w', runsRoot: join(root, 'real') }, { id: 'x', runsRoot: join(root, 'alias') }] }])
    await assert.rejects(parseProjectsConfig(JSON.stringify(aliased), 'alias'), ProjectsConfigError)
    // Zero projects and a project with zero workflows are valid registries.
    assert.deepEqual(await parseProjectsConfig(JSON.stringify({ version: 1, projects: [] }), 'empty'), { projects: [] })
    const empty = await parseProjectsConfig(JSON.stringify(registry(root, [{ id: 'p', workflows: [] }])), 'no workflows')
    assert.deepEqual(empty.projects[0].workflows, [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('the definition revision is the SHA-256 of canonical JSON (sorted keys, compact, literal Unicode) without the revision field', async () => {
  const stored = { name: 'Vérification ✓', nodes: [{ node_id: 'z', label: 'Z', kind: 'worker', depends_on: [] }, { node_id: 'a', label: 'A', kind: 'review', depends_on: ['z'] }] }
  const config = await parseProjectsConfig(JSON.stringify(registry('/synthetic', [{ id: 'p', workflows: [{ id: 'w', definition: stored }] }])), 'unicode')
  const definition = config.projects[0].workflows[0].definition
  const canonical = '{"contract_version":"1.0.0","name":"Vérification ✓","nodes":[{"depends_on":[],"kind":"worker","label":"Z","node_id":"z"},'
    + '{"depends_on":["z"],"kind":"review","label":"A","node_id":"a"}],"project_id":"p","workflow_id":"w"}'
  assert.equal(canonicalJson({ contract_version: '1.0.0', project_id: 'p', workflow_id: 'w', name: stored.name, nodes: stored.nodes }), canonical)
  assert.equal(definition.definition_revision, sha256(Buffer.from(canonical, 'utf8')))
  assert.equal(definitionRevision(definition), definition.definition_revision)
  // Array order is retained (not sorted) and the scope participates, so the same graph differs per workflow.
  assert.deepEqual(definition.nodes.map(node => node.node_id), ['z', 'a'])
  const other = await parseProjectsConfig(JSON.stringify(registry('/synthetic', [{ id: 'p', workflows: [{ id: 'other', definition: stored }] }])), 'scope')
  assert.notEqual(other.projects[0].workflows[0].definition.definition_revision, definition.definition_revision)
})

// ---------------------------------------------------------------------------------------------------------------
// Surface: methods, error shapes, empty registry and legacy compatibility

test('without project configuration the Projects root is empty, scoped routes are 404 and the legacy API is unchanged', async () => {
  const app = createApp(fixtureLocations(defaultFixtureRoot))
  try {
    const projects = await get(app, '/api/projects')
    assert.equal(projects.status, 200)
    assert.deepEqual(projects.json(), { projects: [] })
    projectSchemas.projectList.parse(projects.json())
    assertError(await get(app, url('md-manager')), 404, 'PROJECT_NOT_FOUND')
    assertError(await get(app, url('md-manager', 'feature-implementation')), 404, 'PROJECT_NOT_FOUND')
    assertError(await get(app, url('md-manager', 'feature-implementation', 'run-001')), 404, 'PROJECT_NOT_FOUND')
    assertError(await get(app, '/api/projects/unknown/other'), 404, 'NOT_FOUND')
    // Legacy routes keep their own error shape and behaviour.
    assert.equal((await get(app, '/api/entries')).status, 200)
    const legacy = await get(app, '/api/file')
    assert.equal(legacy.status, 400)
    assert.deepEqual(Object.keys(legacy.json()).sort(), ['code', 'error'])
    assert.equal((await get(app, '/api/files')).status, 404)
  } finally { await app.close() }
})

test('the project API is read-only: writes are 405 with Allow, HEAD works, and nothing is written into run roots', async () => {
  await harness(async ({ app, runsRoot }) => {
    await writeRun(runsRoot('alpha', 'main'), { runId: 'run-001', values: { ui: receipt('ui') }, next: ['launch_adapter'], events: launchEvents.slice(0, 2),
      packets: [{ node: 'ui', artifacts: [{ id: 'log-0-abc', kind: 'log', content: 'ok\n' }] }] })
    await writeRun(runsRoot('alpha', 'main'), { runId: 'run-002', values: reviewedValues({ review: { verdict: 'approved' } }), next: ['approval'], events: reviewedEvents, packets: reviewedPackets,
      review: reviewSection(), inputs: inputsSection(), diffFile: DIFF })
    const before = await snapshotTree(runsRoot('alpha', 'main'))
    const routes = ['/api/projects', url('alpha'), url('alpha', 'main'), url('alpha', 'main', 'run-001'), url('alpha', 'main', 'run-001', '/events'),
      url('alpha', 'main', 'run-001', '/results/ui/1'), url('alpha', 'main', 'run-001', '/artifacts/log-0-abc'),
      url('alpha', 'main', 'run-002', '/reviews/1'), url('alpha', 'main', 'run-002', '/inputs'), url('alpha', 'main', 'run-002', `/artifacts/patch-review-${sha256(DIFF).slice(0, 12)}`)]
    for (const route of routes) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const) {
        const response = await app.inject({ method, url: route, payload: method === 'OPTIONS' ? undefined : { approve: true } })
        assert.equal(response.statusCode, 405, `${method} ${route}: ${response.body}`)
        assert.equal(response.headers.allow, 'GET, HEAD')
        assert.equal(response.json().error.code, 'METHOD_NOT_ALLOWED')
      }
      const head = await app.inject({ method: 'HEAD', url: route })
      assert.equal(head.statusCode, 200, `HEAD ${route}`)
      assert.equal((await get(app, route)).status, 200, route)
    }
    assert.deepEqual(await snapshotTree(runsRoot('alpha', 'main')), before, 'reads never create, modify or delete run storage')
  })
})

async function snapshotTree(dir: string): Promise<[string, number, number][]> {
  const entries: [string, number, number][] = []
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    const path = join(entry.parentPath ?? dir, entry.name)
    const info = await stat(path)
    entries.push([path, info.size, info.mtimeMs])
  }
  return entries.sort()
}

test('invalid IDs, limits, cursors, attempts and after values are 400 without touching storage', async () => {
  await harness(async ({ app }) => {
    for (const bad of ['.hidden', 'a%20b', 'x'.repeat(129), 'x'.repeat(300), 'a%2Fb', '%00']) {
      assertError(await get(app, `/api/projects/${bad}/workflows`), 400, 'INVALID_ID')
      assertError(await get(app, `/api/projects/alpha/workflows/${bad}/runs`), 400, 'INVALID_ID')
      assertError(await get(app, `/api/projects/alpha/workflows/main/runs/${bad}`), 400, 'INVALID_ID')
      assertError(await get(app, `/api/projects/alpha/workflows/main/runs/run-001/artifacts/${bad}`), 400, 'INVALID_ID')
    }
    assertError(await get(app, url('alpha', 'main', undefined, '?limit=0')), 400, 'INVALID_LIMIT')
    assertError(await get(app, url('alpha', 'main', undefined, '?limit=101')), 400, 'INVALID_LIMIT')
    assertError(await get(app, url('alpha', 'main', undefined, '?limit=abc')), 400, 'INVALID_LIMIT')
    assertError(await get(app, url('alpha', 'main', undefined, '?limit=5&limit=6')), 400, 'INVALID_LIMIT')
    assertError(await get(app, url('alpha', 'main', undefined, '?cursor=not-a-token')), 400, 'INVALID_CURSOR')
    assertError(await get(app, url('alpha', 'main', undefined, `?cursor=${Buffer.from('/etc/passwd').toString('base64url')}`)), 400, 'INVALID_CURSOR')
    assertError(await get(app, url('alpha', 'main', 'run-001', '/events?after=-1')), 400, 'INVALID_AFTER')
    assertError(await get(app, url('alpha', 'main', 'run-001', '/events?after=x')), 400, 'INVALID_AFTER')
    assertError(await get(app, url('alpha', 'main', 'run-001', '/results/ui/0')), 400, 'INVALID_ATTEMPT')
    assertError(await get(app, url('alpha', 'main', 'run-001', '/results/ui/one')), 400, 'INVALID_ATTEMPT')
    // Dot segments are normalized away before routing, so they can only miss; they never reach a run.
    const traversal = await get(app, url('alpha', 'main', 'run-001', '/results/../1'))
    assert.ok([400, 404].includes(traversal.status), traversal.body)
    assert.deepEqual(Object.keys(traversal.json() as object), ['error'])
  })
})

test('an empty project, an empty workflow and a missing scope are distinguishable', async () => {
  await harness(async ({ app }) => {
    const projects = await get(app, '/api/projects')
    assert.deepEqual(projects.json(), { projects: [{ project_id: 'alpha', name: 'Alpha' }, { project_id: 'bare', name: 'Bare project' }] })
    const noWorkflows = await get(app, url('bare'))
    assert.equal(noWorkflows.status, 200)
    assert.deepEqual(noWorkflows.json(), { workflows: [] })
    const noRuns = await get(app, url('alpha', 'main'))
    assert.equal(noRuns.status, 200)
    assert.deepEqual(noRuns.json(), { runs: [], next_cursor: null })
    projectSchemas.runList.parse(noRuns.json())
    assertError(await get(app, url('missing')), 404, 'PROJECT_NOT_FOUND')
    assertError(await get(app, url('alpha', 'missing')), 404, 'WORKFLOW_NOT_FOUND')
    assertError(await get(app, url('alpha', 'main', 'missing')), 404, 'RUN_NOT_FOUND')
    assertError(await get(app, url('alpha', 'main', 'missing', '/events')), 404, 'RUN_NOT_FOUND')
    assertError(await get(app, url('alpha', 'main', 'missing', '/results/ui/1')), 404, 'RUN_NOT_FOUND')
    assertError(await get(app, url('alpha', 'main', 'missing', '/artifacts/log-0')), 404, 'RUN_NOT_FOUND')
    // Registered but unusable storage is a 503, never an empty success.
    assertError(await get(app, url('alpha', 'absent')), 503, 'RUNS_ROOT_UNAVAILABLE')
  }, [{ id: 'alpha', name: 'Alpha', workflows: [{ id: 'main' }, { id: 'absent', runsRoot: '/nonexistent/md-manager-projects-test/runs' }] }, { id: 'bare', name: 'Bare project', workflows: [] }])
})

// ---------------------------------------------------------------------------------------------------------------
// Isolation and identity

test('runs are associated only through the configured project/workflow root; same basenames stay separate', async () => {
  const other = { name: 'Other graph', nodes: [{ node_id: 'solo', label: 'Solo', kind: 'worker', depends_on: [] }] }
  await harness(async ({ app, runsRoot, root }) => {
    await writeRun(runsRoot('alpha', 'main'), { runId: 'run-001', values: { ui: receipt('ui'), adapter: receipt('adapter') }, next: ['handoff'], events: launchEvents,
      packets: [{ node: 'ui', artifacts: [{ id: 'log-0-alpha', kind: 'log', content: 'alpha log\n' }] }] })
    await writeRun(runsRoot('beta', 'main'), { runId: 'run-001', definition: other, values: {}, next: ['solo'], events: [], updated: T2 })
    const alpha = await get(app, url('alpha', 'main', 'run-001'))
    const beta = await get(app, url('beta', 'main', 'run-001'))
    assert.equal(alpha.status, 200, alpha.body)
    assert.equal(beta.status, 200, beta.body)
    const alphaDetail = validateRunDetail(alpha.json())
    const betaDetail = validateRunDetail(beta.json())
    assert.equal(alphaDetail.summary.project_id, 'alpha')
    assert.equal(betaDetail.summary.project_id, 'beta')
    assert.notEqual(alphaDetail.summary.definition_revision, betaDetail.summary.definition_revision)
    assert.deepEqual(betaDetail.snapshot.nodes.map(node => node.node_id), ['solo'])
    assert.equal(alphaDetail.snapshot.nodes.length, GRAPH_NODES.length)
    // The run is invisible from the sibling workflow and from the other project's routes.
    assertError(await get(app, url('alpha', 'second', 'run-001')), 404, 'RUN_NOT_FOUND', root)
    assert.deepEqual((await get(app, url('alpha', 'second'))).json(), { runs: [], next_cursor: null })
    assertError(await get(app, url('beta', 'main', 'run-001', '/results/ui/1')), 404, 'RESULT_NOT_FOUND', root)
    assertError(await get(app, url('beta', 'main', 'run-001', '/artifacts/log-0-alpha')), 404, 'ARTIFACT_NOT_FOUND', root)
    assertError(await get(app, url('alpha', 'second', 'run-001', '/artifacts/log-0-alpha')), 404, 'RUN_NOT_FOUND', root)
    assert.equal((await get(app, url('alpha', 'main', 'run-001', '/artifacts/log-0-alpha'))).status, 200)
    // A run root symlinked into another workflow's root is never followed.
    await symlink(join(runsRoot('alpha', 'main'), 'run-001'), join(runsRoot('alpha', 'second'), 'run-001'))
    assertError(await get(app, url('alpha', 'second', 'run-001')), 404, 'RUN_NOT_FOUND', root)
    assert.deepEqual((await get(app, url('alpha', 'second'))).json(), { runs: [], next_cursor: null })
    // Result and artifact links inside the payload are scoped to the run that owns them.
    const ui = alphaDetail.snapshot.nodes.find(node => node.node_id === 'launch_ui')!
    assert.equal(ui.result_uri, '/api/projects/alpha/workflows/main/runs/run-001/results/ui/1')
    assert.ok(!alpha.body.includes(root))
  }, [{ id: 'alpha', workflows: [{ id: 'main' }, { id: 'second' }] }, { id: 'beta', workflows: [{ id: 'main', definition: other }] }])
})

test('run detail returns the pinned definition even after the workflow definition changed; lists return the current one', async () => {
  const current = { name: 'Feature implementation v2', nodes: [...GRAPH_NODES, { node_id: 'publish', label: 'Publish', kind: 'integration', depends_on: ['integrate'] }] }
  await harness(async ({ app, runsRoot }) => {
    await writeRun(runsRoot('alpha', 'main'), { runId: 'old-run', values: { ui: receipt('ui'), adapter: receipt('adapter') }, next: ['handoff'], events: launchEvents })
    const workflows = await get(app, url('alpha'))
    assert.equal(workflows.status, 200)
    const list = projectSchemas.workflowList.parse(workflows.json())
    validateDefinition(list.workflows[0])
    assert.equal(list.workflows[0].nodes.length, GRAPH_NODES.length + 1)
    const detail = validateRunDetail((await get(app, url('alpha', 'main', 'old-run'))).json())
    assert.equal(detail.definition.name, 'Feature implementation')
    assert.equal(detail.definition.nodes.length, GRAPH_NODES.length)
    assert.notEqual(detail.definition.definition_revision, list.workflows[0].definition_revision)
    assert.equal(detail.summary.definition_revision, detail.definition.definition_revision)
    assert.equal(detail.summary.project_id, detail.definition.project_id)
    assert.equal(detail.summary.workflow_id, detail.definition.workflow_id)
    const runs = projectSchemas.runList.parse((await get(app, url('alpha', 'main'))).json())
    assert.deepEqual(runs.runs, [detail.summary])
    assert.deepEqual(detail.snapshot.nodes.map(node => [node.node_id, node.kind, node.depends_on]), GRAPH_NODES.map(node => [node.node_id, node.kind, node.depends_on]))
  }, [{ id: 'alpha', workflows: [{ id: 'main', definition: current }] }])
})

// ---------------------------------------------------------------------------------------------------------------
// State projection from actual persisted evidence

test('projects a fresh run, a live run awaiting handoff, and an integrated run from persisted state', async () => {
  await harness(async ({ app, runsRoot }) => {
    const rootDir = runsRoot('alpha', 'main')
    await writeRun(rootDir, { runId: 'fresh', next: ['launch_ui', 'launch_adapter'], updated: T0 })
    await writeRun(rootDir, { runId: 'live', values: { ui: receipt('ui'), adapter: receipt('adapter') }, next: ['handoff'], events: launchEvents,
      tasks: [{ node_id: 'handoff', error: null, interrupts: [{ kind: 'worker_handoff', message: 'Awaiting explicit completion signals and automatic freeze.' }], result: null }] })
    const done = [...launchEvents,
      { sequence: 5, time: T1, node: 'freeze', status: 'stopped', message: 'Both native workers stopped before snapshot capture' },
      { sequence: 6, time: T1, node: 'freeze', status: 'succeeded', message: 'Immutable snapshots captured; worker-reported checks are not trusted' },
      { sequence: 7, time: T1, node: 'verify_ui', status: 'running', message: `Attempt 1; revision ${OUTPUT}` },
      { sequence: 8, time: T1, node: 'verify_ui', status: 'passed', message: 'Required tests and artifacts passed' },
      { sequence: 9, time: T1, node: 'verify_adapter', status: 'running', message: `Attempt 1; revision ${OUTPUT}` },
      { sequence: 10, time: T1, node: 'verify_adapter', status: 'passed', message: 'Required tests and artifacts passed' },
      { sequence: 11, time: T1, node: 'candidate_ui', status: 'passed', message: `Combined revision ${OUTPUT}` },
      { sequence: 12, time: T1, node: 'candidate_adapter', status: 'passed', message: `Combined revision ${OUTPUT}` },
      { sequence: 13, time: T1, node: 'review', status: 'approved', message: 'claude-reviewer' },
      { sequence: 14, time: T2, node: 'integrate', status: 'succeeded', message: `Fast-forwarded to ${OUTPUT}; no push performed` }]
    await writeRun(rootDir, { runId: 'integrated', values: { ui: receipt('ui'), adapter: receipt('adapter'), snapshots, ui_packet: '/synthetic/ui/packet.json', adapter_packet: '/synthetic/adapter/packet.json',
      bundle: '/synthetic/review-bundle.json', review: { reviewer: 'claude-reviewer', decision: 'approve' }, approved_bundle: 'e'.repeat(64), integrated_commit: OUTPUT },
      next: [], events: done, updated: T2,
      packets: [{ node: 'ui' }, { node: 'adapter' }, { node: 'ui', phase: 'candidate' }, { node: 'adapter', phase: 'candidate' }] })

    const fresh = validateRunDetail((await get(app, url('alpha', 'main', 'fresh'))).json())
    assert.equal(fresh.summary.status, 'running')
    assert.ok(fresh.snapshot.nodes.every(node => node.status === 'pending' && node.attempt === 0 && node.session_id === null && node.result_uri === null))
    assert.equal(fresh.snapshot.last_sequence, 0)
    assert.equal(fresh.summary.created_at, T0)
    assert.equal(fresh.summary.updated_at, T0)

    // An export without inputs cannot say the run is automatic: its handoff keeps awaiting approval, but the lanes are live.
    const live = validateRunDetail((await get(app, url('alpha', 'main', 'live'))).json())
    assert.equal(live.summary.status, 'awaiting_approval')
    const status = Object.fromEntries(live.snapshot.nodes.map(node => [node.node_id, node.status]))
    assert.deepEqual(status, { launch_ui: 'running', launch_adapter: 'running', handoff: 'awaiting_approval', verify_ui: 'pending', verify_adapter: 'pending', candidate: 'pending', review: 'pending', approval: 'pending', integrate: 'pending' })
    const launchUi = live.snapshot.nodes.find(node => node.node_id === 'launch_ui')!
    assert.deepEqual([launchUi.attempt, launchUi.session_id, launchUi.result_uri], [1, 'ui-session-0001', null], 'launch means a session, not a worker result')
    assert.equal(live.snapshot.last_sequence, 4)
    assert.equal(live.summary.updated_at, T1)

    const integrated = validateRunDetail((await get(app, url('alpha', 'main', 'integrated'))).json())
    assert.equal(integrated.summary.status, 'succeeded')
    assert.ok(integrated.snapshot.nodes.every(node => node.status === 'succeeded' && node.attempt === 1), JSON.stringify(integrated.snapshot.nodes))
    const verifyUi = integrated.snapshot.nodes.find(node => node.node_id === 'verify_ui')!
    assert.equal(verifyUi.result_uri, '/api/projects/alpha/workflows/main/runs/integrated/results/ui/1')
    assert.equal(verifyUi.session_id, 'ui-session-0001')
    assert.equal(integrated.summary.updated_at, T2)
    assert.equal(integrated.snapshot.last_sequence, 14)
    // Sorted newest first, then run_id ascending.
    const runs = projectSchemas.runList.parse((await get(app, url('alpha', 'main'))).json())
    assert.deepEqual(runs.runs.map(run => run.run_id), ['integrated', 'live', 'fresh'])
  })
})

test('while the handoff waits on worker completion signals the lanes are running, and only a manual run awaits approval', async () => {
  await harness(async ({ app, runsRoot }) => {
    const rootDir = runsRoot('alpha', 'main')
    const waiting = { values: { ui: receipt('ui'), adapter: receipt('adapter') }, next: ['handoff'],
      tasks: [{ node_id: 'handoff', error: null, interrupts: [{ kind: 'worker_handoff', message: 'Awaiting explicit completion signals and automatic freeze.' }], result: null }] }
    await writeRun(rootDir, { ...waiting, runId: 'automatic', events: launchEvents, inputs: inputsSection() })
    await writeRun(rootDir, { ...waiting, runId: 'manual', events: launchEvents, inputs: inputsSection({ mode: 'manual', automatic: null }) })
    const controller = (sequence: number, status: string) => ({ sequence, time: T1, node: 'controller', status, message: `controller ${status}` })
    // Ctrl-C or a Claude Code outage: the workers keep running and the operator resumes with automatic --live.
    await writeRun(rootDir, { ...waiting, runId: 'interrupted', events: [...launchEvents, controller(5, 'interrupted')], inputs: inputsSection() })
    // The controller gave up (a deadline) and stopped the workers: nothing continues.
    const gaveUp = [...launchEvents, controller(5, 'blocked'), { sequence: 6, time: T1, node: 'freeze', status: 'stopped', message: 'Native workers stopped' }]
    await writeRun(rootDir, { ...waiting, runId: 'gave-up', events: gaveUp, inputs: inputsSection() })
    // Resumed after an outage: the newer controller event wins.
    await writeRun(rootDir, { ...waiting, runId: 'resumed', events: [...launchEvents, controller(5, 'interrupted'), controller(6, 'running')], inputs: inputsSection() })
    // The freeze succeeded and verification runs, but the export still holds the interrupt until the next checkpoint.
    const frozen = [...launchEvents, { sequence: 5, time: T1, node: 'freeze', status: 'stopped', message: 'Native workers stopped' },
      { sequence: 6, time: T1, node: 'freeze', status: 'succeeded', message: 'Immutable snapshots captured' },
      { sequence: 7, time: T1, node: 'verify_ui', status: 'running', message: `Attempt 1; revision ${OUTPUT}` }]
    await writeRun(rootDir, { ...waiting, runId: 'frozen', events: frozen, inputs: inputsSection() })
    const statuses = async (runId: string) => {
      const detail = validateRunDetail((await get(app, url('alpha', 'main', runId))).json())
      const nodes = Object.fromEntries(detail.snapshot.nodes.map(node => [node.node_id, node.status]))
      return { run: detail.summary.status, launch_ui: nodes.launch_ui, launch_adapter: nodes.launch_adapter, handoff: nodes.handoff, verify_ui: nodes.verify_ui }
    }
    assert.deepEqual(await statuses('automatic'), { run: 'running', launch_ui: 'running', launch_adapter: 'running', handoff: 'pending', verify_ui: 'pending' })
    assert.deepEqual(await statuses('manual'), { run: 'awaiting_approval', launch_ui: 'running', launch_adapter: 'running', handoff: 'awaiting_approval', verify_ui: 'pending' })
    assert.deepEqual(await statuses('interrupted'), { run: 'paused', launch_ui: 'running', launch_adapter: 'running', handoff: 'paused', verify_ui: 'pending' })
    assert.deepEqual(await statuses('gave-up'), { run: 'failed', launch_ui: 'succeeded', launch_adapter: 'succeeded', handoff: 'failed', verify_ui: 'pending' })
    assert.deepEqual(await statuses('resumed'), { run: 'running', launch_ui: 'running', launch_adapter: 'running', handoff: 'pending', verify_ui: 'pending' })
    assert.deepEqual(await statuses('frozen'), { run: 'running', launch_ui: 'succeeded', launch_adapter: 'succeeded', handoff: 'succeeded', verify_ui: 'running' })
    const automatic = validateRunDetail((await get(app, url('alpha', 'main', 'automatic'))).json())
    const launchUi = automatic.snapshot.nodes.find(node => node.node_id === 'launch_ui')!
    assert.deepEqual([launchUi.attempt, launchUi.session_id], [1, 'ui-session-0001'])
    const handoff = automatic.snapshot.nodes.find(node => node.node_id === 'handoff')!
    assert.equal(handoff.attempt, 0)
  })
})

test('a blocked verification is failed with a retrievable failed result; a sibling success held in a task result counts', async () => {
  await harness(async ({ app, runsRoot, root }) => {
    const events = [...launchEvents,
      { sequence: 5, time: T1, node: 'freeze', status: 'succeeded', message: 'Immutable snapshots captured' },
      { sequence: 6, time: T1, node: 'verify_ui', status: 'running', message: `Attempt 1; revision ${OUTPUT}` },
      { sequence: 7, time: T1, node: 'verify_adapter', status: 'running', message: `Attempt 1; revision ${OUTPUT}` },
      { sequence: 8, time: T1, node: 'verify_ui', status: 'passed', message: 'Required tests and artifacts passed' },
      { sequence: 9, time: T2, node: 'verify_adapter', status: 'blocked', message: `Intentional lab drill: verification branch failure, not a worker or test failure; see ${root}/runs/alpha/main/drill/verification/worker/adapter/1/packet.json` }]
    await writeRun(runsRoot('alpha', 'main'), { runId: 'drill', values: { ui: receipt('ui'), adapter: receipt('adapter'), snapshots }, next: ['verify_adapter'], events, updated: T1,
      tasks: [
        { node_id: 'verify_ui', error: null, interrupts: [], result: { ui_packet: `${root}/runs/alpha/main/drill/verification/worker/ui/1/packet.json` } },
        { node_id: 'verify_adapter', error: `adapter verification blocked; see ${root}/runs/alpha/main/drill/verification/worker/adapter/1/packet.json. Retry explicitly or start a revised run.`, interrupts: [], result: null },
      ],
      packets: [
        { node: 'ui', summary: 'UI worker handoff summary', assumptions: ['Mock routes only in worker phase', ''], artifacts: [
          { id: 'log-0-111111111111', kind: 'log', content: 'build ok\n' }, { id: 'screenshot-1-222222222222', kind: 'screenshot', content: PNG }, { id: 'test_report-2-333333333333', kind: 'test_report', content: '{"ok":true}' }] },
        { node: 'adapter', gate: { status: 'blocked', reasons: ['backend-unit: exit 1', `Intentional lab drill: verification branch failure, not a worker or test failure; see ${root}/x/packet.json`] },
          artifacts: [{ id: 'log-0-444444444444', kind: 'log', content: 'FAIL\n' }] },
      ] })
    const detail = validateRunDetail((await get(app, url('alpha', 'main', 'drill'))).json())
    assert.equal(detail.summary.status, 'failed')
    const nodes = Object.fromEntries(detail.snapshot.nodes.map(node => [node.node_id, node]))
    assert.equal(nodes.verify_ui.status, 'succeeded', 'pending writes of the successful sibling are evidence')
    assert.equal(nodes.verify_adapter.status, 'failed')
    assert.equal(nodes.verify_adapter.attempt, 1)
    assert.equal(nodes.verify_adapter.result_uri, '/api/projects/alpha/workflows/main/runs/drill/results/adapter/1')
    assert.equal(nodes.handoff.status, 'succeeded')
    assert.equal(nodes.candidate.status, 'pending')
    assert.equal(detail.summary.updated_at, T2, 'the newest persisted event time is the update time')
    assert.ok(!JSON.stringify(detail).includes(root))

    const failed = await get(app, url('alpha', 'main', 'drill', '/results/adapter/1'))
    assert.equal(failed.status, 200, failed.body)
    const adapterResult = validateWorkerResult(failed.json())
    assert.equal(adapterResult.status, 'failed')
    assert.equal(adapterResult.error?.code, 'VERIFICATION_BLOCKED')
    assert.match(adapterResult.error!.message, /backend-unit: exit 1/)
    assert.ok(!failed.body.includes(root), 'gate reasons are redacted')
    assert.ok(failed.body.includes('<path>'))
    assert.equal(adapterResult.checks[0].cwd, 'verification/worker/adapter/1/worktree')

    const ok = await get(app, url('alpha', 'main', 'drill', '/results/ui/1'))
    const uiResult = validateWorkerResult(ok.json())
    assert.equal(uiResult.status, 'succeeded')
    assert.equal(uiResult.summary, 'UI worker handoff summary')
    assert.deepEqual(uiResult.open_assumptions, ['Mock routes only in worker phase'])
    assert.deepEqual(uiResult.changed_files, ['src/ui.ts'])
    assert.deepEqual(uiResult.artifacts.map(artifact => artifact.uri), [
      '/api/projects/alpha/workflows/main/runs/drill/artifacts/log-0-111111111111',
      '/api/projects/alpha/workflows/main/runs/drill/artifacts/screenshot-1-222222222222',
      '/api/projects/alpha/workflows/main/runs/drill/artifacts/test_report-2-333333333333'])
    assert.ok(!ok.body.includes(root))
    assertError(await get(app, url('alpha', 'main', 'drill', '/results/ui/2')), 404, 'RESULT_NOT_FOUND')
    assertError(await get(app, url('alpha', 'main', 'drill', '/results/review/1')), 404, 'RESULT_NOT_FOUND')
    assertError(await get(app, url('alpha', 'main', 'drill', '/results/candidate_ui/1')), 404, 'RESULT_NOT_FOUND')
  })
})

test('a retried verification shows the latest attempt and keeps the earlier failed result reachable', async () => {
  await harness(async ({ app, runsRoot }) => {
    const events = [...launchEvents,
      { sequence: 5, time: T1, node: 'verify_adapter', status: 'running', message: `Attempt 1; revision ${OUTPUT}` },
      { sequence: 6, time: T1, node: 'verify_adapter', status: 'blocked', message: 'Intentional lab drill' },
      { sequence: 7, time: T2, node: 'verify_adapter', status: 'running', message: `Attempt 2; revision ${OUTPUT}` },
      { sequence: 8, time: T2, node: 'verify_adapter', status: 'passed', message: 'Required tests and artifacts passed' }]
    await writeRun(runsRoot('alpha', 'main'), { runId: 'retry', values: { ui: receipt('ui'), adapter: receipt('adapter'), snapshots, ui_packet: '/x', adapter_packet: '/y' }, next: ['candidate'], events, updated: T2,
      packets: [{ node: 'ui' }, { node: 'adapter', attempt: 1, gate: { status: 'blocked', reasons: ['drill'] } }, { node: 'adapter', attempt: 2 }] })
    const detail = validateRunDetail((await get(app, url('alpha', 'main', 'retry'))).json())
    assert.equal(detail.summary.status, 'running')
    const adapter = detail.snapshot.nodes.find(node => node.node_id === 'verify_adapter')!
    assert.deepEqual([adapter.status, adapter.attempt, adapter.result_uri], ['succeeded', 2, '/api/projects/alpha/workflows/main/runs/retry/results/adapter/2'])
    assert.equal(validateWorkerResult((await get(app, url('alpha', 'main', 'retry', '/results/adapter/1'))).json()).status, 'failed')
    assert.equal(validateWorkerResult((await get(app, url('alpha', 'main', 'retry', '/results/adapter/2'))).json()).status, 'succeeded')
    const candidate = detail.snapshot.nodes.find(node => node.node_id === 'candidate')!
    assert.deepEqual([candidate.status, candidate.attempt], ['pending', 0])
  })
})

test('contradictory evidence is paused, never succeeded: tampered packets, a claimed packet with no registration, integration with pending work', async () => {
  await harness(async ({ app, runsRoot, root }) => {
    const rootDir = runsRoot('alpha', 'main')
    await writeRun(rootDir, { runId: 'tampered', values: { ui: receipt('ui'), adapter: receipt('adapter'), snapshots, ui_packet: '/x' }, next: ['verify_adapter'], events: launchEvents,
      packets: [{ node: 'ui', tamper: true, artifacts: [{ id: 'log-0-555555555555', kind: 'log', content: 'x' }] }] })
    await writeRun(rootDir, { runId: 'unregistered', values: { ui: receipt('ui'), adapter: receipt('adapter'), snapshots, ui_packet: '/x' }, next: ['verify_adapter'], events: launchEvents })
    await writeRun(rootDir, { runId: 'blocked-claim', values: { ui: receipt('ui'), adapter: receipt('adapter'), snapshots, ui_packet: '/x' }, next: [], events: launchEvents,
      packets: [{ node: 'ui', gate: { status: 'blocked', reasons: ['tests failed'] } }] })
    await writeRun(rootDir, { runId: 'half-integrated', values: { ui: receipt('ui'), adapter: receipt('adapter'), integrated_commit: OUTPUT }, next: ['review'], events: launchEvents })
    await writeRun(rootDir, { runId: 'event-only', values: { ui: receipt('ui'), adapter: receipt('adapter') }, next: [], events: [...launchEvents, { sequence: 5, time: T1, node: 'freeze', status: 'succeeded', message: 'Immutable snapshots captured' }] })
    for (const [runId, node] of [['tampered', 'verify_ui'], ['unregistered', 'verify_ui'], ['blocked-claim', 'verify_ui'], ['half-integrated', 'integrate'], ['event-only', 'handoff']] as const) {
      const detail = validateRunDetail((await get(app, url('alpha', 'main', runId))).json())
      assert.equal(detail.summary.status, 'paused', runId)
      assert.equal(detail.snapshot.nodes.find(item => item.node_id === node)!.status, runId === 'half-integrated' ? 'succeeded' : 'paused', runId)
    }
    // A tampered packet's result and artifacts are refused rather than served.
    assertError(await get(app, url('alpha', 'main', 'tampered', '/results/ui/1')), 500, 'EVIDENCE_MISMATCH', root)
    assertError(await get(app, url('alpha', 'main', 'tampered', '/artifacts/log-0-555555555555')), 500, 'EVIDENCE_MISMATCH', root)
    const runs = projectSchemas.runList.parse((await get(app, url('alpha', 'main'))).json())
    assert.ok(runs.runs.every(run => run.status === 'paused'))
  })
})

test('legacy run directories without a supported export are neither listed nor shown as successful', async () => {
  await harness(async ({ app, runsRoot, root }) => {
    const rootDir = runsRoot('alpha', 'main')
    await mkdir(join(rootDir, 'legacy-run'))
    await writeFile(join(rootDir, 'legacy-run', 'plan.json'), json({ run_id: 'legacy-run', repository: join(root, 'somewhere'), base_commit: BASE }))
    await mkdir(join(rootDir, 'candidate'))
    await writeFile(join(rootDir, 'stray.json'), '{}')
    await writeRun(rootDir, { runId: 'supported', values: { ui: receipt('ui') }, next: ['launch_adapter'] })
    const runs = projectSchemas.runList.parse((await get(app, url('alpha', 'main'))).json())
    assert.deepEqual(runs.runs.map(run => run.run_id), ['supported'])
    assertError(await get(app, url('alpha', 'main', 'legacy-run')), 404, 'RUN_UNSUPPORTED', root)
    assertError(await get(app, url('alpha', 'main', 'candidate')), 404, 'RUN_NOT_FOUND', root)
  })
})

test('events are normalized to workflow v1 with graph attribution, redaction and cursor filtering', async () => {
  await harness(async ({ app, runsRoot, root }) => {
    const events = [...launchEvents,
      { sequence: 5, time: T1, node: 'freeze', status: 'stopped', message: 'Both native workers stopped before snapshot capture' },
      { sequence: 6, time: T1, node: 'verify_adapter', status: 'running', message: `Attempt 2; revision ${OUTPUT}` },
      { sequence: 7, time: T2, node: 'verify_adapter', status: 'blocked', message: `see ${root}/runs/alpha/main/ev/verification/worker/adapter/2/packet.json and ~/state/x.json` },
      { sequence: 8, time: T2, node: 'mystery', status: 'running', message: 'unknown alias must not invent a node' }]
    await writeRun(runsRoot('alpha', 'main'), { runId: 'ev', values: { ui: receipt('ui'), adapter: receipt('adapter') }, next: ['handoff'], events })
    const response = await get(app, url('alpha', 'main', 'ev', '/events'))
    assert.equal(response.status, 200, response.body)
    const body = response.json() as { events: unknown[] }
    assert.deepEqual(Object.keys(body), ['events'])
    const parsed = body.events.map(event => eventSchema.parse(event))
    assert.deepEqual(parsed.map(event => event.sequence), [1, 2, 3, 4, 5, 6, 7, 8])
    assert.deepEqual(parsed.map(event => event.node_id), ['launch_adapter', 'launch_ui', 'launch_adapter', 'launch_ui', 'handoff', 'verify_adapter', 'verify_adapter', null])
    assert.deepEqual(parsed.map(event => event.status), ['running', 'running', 'running', 'running', null, 'running', 'failed', null])
    assert.deepEqual(parsed.map(event => event.type), ['status_changed', 'status_changed', 'status_changed', 'status_changed', 'log', 'status_changed', 'status_changed', 'log'])
    assert.deepEqual(parsed.map(event => event.attempt), [1, 1, 1, 1, 1, 2, 2, 0])
    assert.equal(parsed[6].message, 'see <path> and <path>')
    assert.ok(parsed.every(event => event.run_id === 'ev' && event.artifact === null && event.result_uri === null && event.reused_from_attempt === null))
    assert.equal(new Set(parsed.map(event => event.event_id)).size, 8)
    assert.ok(!response.body.includes(root))
    const after = (await get(app, url('alpha', 'main', 'ev', '/events?after=6'))).json() as { events: { sequence: number }[] }
    assert.deepEqual(after.events.map(event => event.sequence), [7, 8])
    assert.deepEqual((await get(app, url('alpha', 'main', 'ev', '/events?after=99'))).json(), { events: [] })
    const detail = validateRunDetail((await get(app, url('alpha', 'main', 'ev'))).json())
    assert.equal(detail.snapshot.last_sequence, 8)
    assert.equal(detail.snapshot.nodes.find(node => node.node_id === 'verify_adapter')!.attempt, 2)
    assert.equal(detail.snapshot.nodes.find(node => node.node_id === 'verify_adapter')!.status, 'failed')
  })
})

test('a run without events.jsonl falls back to the export copy; a partially appended last line is ignored', async () => {
  await harness(async ({ app, runsRoot }) => {
    await writeRun(runsRoot('alpha', 'main'), { runId: 'embedded', values: { ui: receipt('ui') }, next: ['launch_adapter'], events: launchEvents.slice(0, 2), eventsFile: false })
    await writeRun(runsRoot('alpha', 'main'), { runId: 'partial', values: { ui: receipt('ui') }, next: ['launch_adapter'], events: launchEvents.slice(0, 2),
      eventsFile: launchEvents.slice(0, 2).map(event => JSON.stringify(event) + '\n').join('') + '{"sequence": 3, "time": "2026' })
    for (const runId of ['embedded', 'partial']) {
      const events = (await get(app, url('alpha', 'main', runId, '/events'))).json() as { events: { sequence: number }[] }
      assert.deepEqual(events.events.map(event => event.sequence), [1, 2], runId)
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Pagination

test('runs paginate newest-first with opaque workflow-bound cursors, default 50 and maximum 100', async () => {
  await harness(async ({ app, runsRoot }) => {
    const rootDir = runsRoot('alpha', 'main')
    const ids: string[] = []
    for (let index = 0; index < 53; index += 1) {
      const runId = `run-${String(index).padStart(3, '0')}`
      ids.push(runId)
      // Pairs share an updated_at so the tie-break by run_id is exercised across page boundaries.
      const minute = String(Math.floor(index / 2)).padStart(2, '0')
      await writeRun(rootDir, { runId, values: { ui: receipt('ui') }, next: ['launch_adapter'], updated: `2026-03-02T11:${minute}:00Z` })
    }
    const expected = [...ids].sort((a, b) => {
      const ma = Math.floor(Number(a.slice(4)) / 2), mb = Math.floor(Number(b.slice(4)) / 2)
      return mb - ma || (a < b ? -1 : 1)
    })
    const first = projectSchemas.runList.parse((await get(app, url('alpha', 'main'))).json())
    assert.equal(first.runs.length, 50)
    assert.ok(first.next_cursor)
    const second = projectSchemas.runList.parse((await get(app, url('alpha', 'main', undefined, `?cursor=${encodeURIComponent(first.next_cursor!)}`))).json())
    assert.equal(second.runs.length, 3)
    assert.equal(second.next_cursor, null)
    assert.deepEqual([...first.runs, ...second.runs].map(run => run.run_id), expected)
    const all = projectSchemas.runList.parse((await get(app, url('alpha', 'main', undefined, '?limit=100'))).json())
    assert.equal(all.runs.length, 53)
    assert.equal(all.next_cursor, null)
    // Walk in pages of 7 without overlap or omission; cursors are never paths and cannot cross workflows.
    const walked: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const page: { runs: { run_id: string }[]; next_cursor: string | null } = projectSchemas.runList.parse((await get(app, url('alpha', 'main', undefined, `?limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`))).json())
      walked.push(...page.runs.map(run => run.run_id))
      assert.ok(cursor === null || !Buffer.from(cursor, 'base64url').toString().includes(rootDir))
      cursor = page.next_cursor
      pages += 1
    } while (cursor)
    assert.equal(pages, 8)
    assert.deepEqual(walked, expected)
    assertError(await get(app, url('alpha', 'other', undefined, `?cursor=${encodeURIComponent(first.next_cursor!)}`)), 400, 'INVALID_CURSOR')
    assertError(await get(app, url('alpha', 'main', undefined, '?cursor=')), 400, 'INVALID_CURSOR')
  }, [{ id: 'alpha', workflows: [{ id: 'main' }, { id: 'other' }] }])
})

// ---------------------------------------------------------------------------------------------------------------
// Malformed and missing storage

test('malformed or contradictory run storage is a 5xx that names the run but never a path, for lists and detail alike', async () => {
  const cases: [string, RunSpec][] = [
    ['not-json', { runId: 'not-json', stateText: '{ oops' }],
    ['wrong-version', { runId: 'wrong-version', stateText: json({ version: '0.9.0', run_id: 'wrong-version' }) }],
    ['id-mismatch', { runId: 'id-mismatch', exportRunId: 'other-run', planRunId: 'other-run' }],
    ['plan-mismatch', { runId: 'plan-mismatch', planRunId: 'someone-else' }],
    ['plan-missing', { runId: 'plan-missing', skipPlan: true }],
    ['bad-definition', { runId: 'bad-definition', definition: { name: 'x', nodes: [{ node_id: 'a', label: 'A', kind: 'worker', depends_on: ['zzz'] }] } }],
    ['bad-events', { runId: 'bad-events', events: launchEvents.slice(0, 1), eventsFile: '{"sequence": 1}\n{bad json}\n' }],
    ['non-monotonic-events', { runId: 'non-monotonic-events', events: [launchEvents[1], launchEvents[0]] }],
    ['packet-outside', { runId: 'packet-outside', packets: [{ node: 'ui' }], registrations: items => items.map(item => ({ ...item, path: 'plan.json' })) }],
    ['packet-traversal', { runId: 'packet-traversal', packets: [{ node: 'ui' }], registrations: items => items.map(item => ({ ...item, path: '../packet-outside/verification/worker/ui/1/packet.json' })) }],
    ['packet-duplicate', { runId: 'packet-duplicate', packets: [{ node: 'ui' }], registrations: items => [...items, ...items] }],
    ['bad-timestamp', { runId: 'bad-timestamp', updated: 'yesterday' }],
  ]
  for (const [label, spec] of cases) {
    await harness(async ({ app, runsRoot, root }) => {
      await writeRun(runsRoot('alpha', 'main'), spec)
      assertError(await get(app, url('alpha', 'main', spec.runId)), 500, 'RUN_STORAGE_INVALID', root)
      const list = await get(app, url('alpha', 'main'))
      assertError(list, 500, 'RUN_STORAGE_INVALID', root)
      assert.ok(list.body.includes(spec.runId), `${label}: the run directory name is the only locator given`)
    })
  }
})

test('unavailable or symlinked run roots are 503; oversized exports are refused rather than truncated', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'md-manager-projects-outside-'))
  try {
    await harness(async ({ app, runsRoot, root }) => {
      await rm(runsRoot('alpha', 'main'), { recursive: true })
      await symlink(outside, runsRoot('alpha', 'main'))
      assertError(await get(app, url('alpha', 'main')), 503, 'RUNS_ROOT_UNAVAILABLE', root)
      assertError(await get(app, url('alpha', 'main', 'anything')), 503, 'RUNS_ROOT_UNAVAILABLE', root)
      await writeRun(runsRoot('alpha', 'big'), { runId: 'big', values: { ui: receipt('ui'), padding: 'x'.repeat(4096) }, next: [] })
      assertError(await get(app, url('alpha', 'big', 'big')), 500, 'FILE_TOO_LARGE', root)
      assertError(await get(app, url('alpha', 'big')), 500, 'FILE_TOO_LARGE', root)
      if (process.getuid?.() !== 0) {
        await chmod(runsRoot('alpha', 'locked'), 0o000)
        try {
          assertError(await get(app, url('alpha', 'locked')), 503, 'RUNS_ROOT_UNAVAILABLE', root)
        } finally { await chmod(runsRoot('alpha', 'locked'), 0o755) }
      }
    }, [{ id: 'alpha', workflows: [{ id: 'main' }, { id: 'big' }, { id: 'locked' }] }], { runStore: { exportByteLimit: 2048 } })
  } finally { await rm(outside, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------------------------------------------
// Artifacts

test('registered artifacts are served with safe content types; unknown, tampered, escaped and oversized artifacts are refused', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'md-manager-projects-secret-'))
  await writeFile(join(outside, 'secret.txt'), 'top secret')
  try {
    await harness(async ({ app, runsRoot, root }) => {
      const rootDir = runsRoot('alpha', 'main')
      const secret = await import('node:fs/promises').then(fs => fs.readFile(join(outside, 'secret.txt')))
      await writeRun(rootDir, { runId: 'art', values: { ui: receipt('ui'), adapter: receipt('adapter'), snapshots, ui_packet: '/x' }, next: ['verify_adapter'], events: launchEvents,
        packets: [{ node: 'ui', artifacts: [
          { id: 'log-0-aaaaaaaaaaaa', kind: 'log', content: 'line one\n<script>alert(1)</script>\n' },
          { id: 'screenshot-1-bbbbbbbbbbbb', kind: 'screenshot', content: PNG },
          { id: 'screenshot-2-cccccccccccc', kind: 'screenshot', content: '<html>not a png</html>' },
          { id: 'test_report-3-dddddddddddd', kind: 'test_report', content: '{"suites":[]}' },
          { id: 'patch-4-eeeeeeeeeeee', kind: 'patch', content: 'diff --git a b\n' },
          { id: 'other-5-ffffffffffff', kind: 'other', content: Buffer.from([0, 1, 2]) },
          { id: 'log-6-hash-mismatch', kind: 'log', content: 'real content', registeredSha: 'f'.repeat(64) },
          { id: 'log-7-missing', kind: 'log', content: 'never written', skipWrite: true },
          { id: 'log-8-symlink', kind: 'log', content: secret, uri: 'log-8-symlink', skipWrite: true },
          { id: 'log-9-traversal', kind: 'log', content: secret, uri: '../../../../../plan.json', skipWrite: true },
          { id: 'log-10-large', kind: 'log', content: 'y'.repeat(600) },
        ] }] })
      await symlink(join(outside, 'secret.txt'), join(rootDir, 'art', 'verification', 'worker', 'ui', '1', 'artifacts', 'log-8-symlink'))
      const artifact = (id: string) => get(app, url('alpha', 'main', 'art', `/artifacts/${id}`))

      const log = await artifact('log-0-aaaaaaaaaaaa')
      assert.equal(log.status, 200, log.body)
      assert.equal(log.headers['content-type'], 'text/plain; charset=utf-8')
      assert.equal(log.headers['x-content-type-options'], 'nosniff')
      assert.equal(log.headers['content-security-policy'], "default-src 'none'; sandbox")
      assert.match(String(log.headers['content-disposition']), /^inline; filename="log-0-aaaaaaaaaaaa"$/)
      assert.equal(log.body, 'line one\n<script>alert(1)</script>\n')
      const png = await app.inject({ method: 'GET', url: url('alpha', 'main', 'art', '/artifacts/screenshot-1-bbbbbbbbbbbb') })
      assert.equal(png.statusCode, 200)
      assert.equal(png.headers['content-type'], 'image/png')
      assert.ok(png.rawPayload.equals(PNG))
      const notPng = await artifact('screenshot-2-cccccccccccc')
      assert.equal(notPng.status, 200)
      assert.equal(notPng.headers['content-type'], 'application/octet-stream', 'a screenshot that is not a PNG is never served as an image or HTML')
      assert.match(String(notPng.headers['content-disposition']), /^attachment/)
      assert.equal((await artifact('test_report-3-dddddddddddd')).headers['content-type'], 'application/json; charset=utf-8')
      assert.equal((await artifact('patch-4-eeeeeeeeeeee')).headers['content-type'], 'text/plain; charset=utf-8')
      const other = await artifact('other-5-ffffffffffff')
      assert.equal(other.headers['content-type'], 'application/octet-stream')
      assert.match(String(other.headers['content-disposition']), /^attachment/)

      assertError(await artifact('log-6-hash-mismatch'), 500, 'ARTIFACT_HASH_MISMATCH', root)
      assertError(await artifact('log-7-missing'), 500, 'ARTIFACT_UNAVAILABLE', root)
      const viaSymlink = await artifact('log-8-symlink')
      assertError(viaSymlink, 500, 'ARTIFACT_UNAVAILABLE', root)
      assert.ok(!viaSymlink.body.includes('top secret'))
      const traversal = await artifact('log-9-traversal')
      assertError(traversal, 500, 'EVIDENCE_MISMATCH', root)
      assert.ok(!traversal.body.includes('synthetic'))
      assertError(await artifact('log-10-large'), 500, 'ARTIFACT_TOO_LARGE', root)
      assertError(await artifact('unknown-artifact'), 404, 'ARTIFACT_NOT_FOUND', root)
      assertError(await artifact('plan.json'), 404, 'ARTIFACT_NOT_FOUND', root)
      assertError(await get(app, url('alpha', 'main', 'art', '/artifacts/..%2F..%2Fplan.json')), 400, 'INVALID_ID', root)
      assertError(await get(app, url('alpha', 'main', 'art', '/artifacts/')), 400, 'INVALID_ID', root)
      assertError(await get(app, url('alpha', 'main', 'art', '/artifacts')), 404, 'NOT_FOUND', root)
    }, undefined, { runStore: { artifactByteLimit: 512 } })
  } finally { await rm(outside, { recursive: true, force: true }) }
})

test('[scenario:served-files] captured files are served as file artifacts with their path and the uncaptured reasons; older results still validate', async () => {
  await harness(async ({ app, runsRoot, root }) => {
    const markdown = '# Guide\n\nSee `src/app.ts:1`.\n<script>alert(1)</script>\n'
    const source = "export const greeting = 'h\u00e9llo'\n"
    const changed = ['docs/GUIDE.md', 'src/app.ts', 'assets/logo.png', 'docs/large.txt', 'docs/OLD.md']
    const notCaptured = [{ path: 'assets/logo.png', reason: 'binary' }, { path: 'docs/large.txt', reason: 'too_large' }, { path: 'docs/OLD.md', reason: 'missing' }]
    await writeRun(runsRoot('alpha', 'main'), { runId: 'files', values: { ui: receipt('ui'), adapter: receipt('adapter'), snapshots }, next: ['verify_adapter'], events: launchEvents,
      packets: [
        { node: 'ui', changed, artifacts: [
          { id: 'file-0-111111111111', kind: 'file', path: 'docs/GUIDE.md', content: markdown },
          { id: 'file-1-222222222222', kind: 'file', path: 'src/app.ts', content: source },
          { id: 'log-2-333333333333', kind: 'log', content: 'ok\n' }],
          mutate: packet => { (packet.result as Record<string, unknown>).files_not_captured = notCaptured } },
        { node: 'adapter', artifacts: [{ id: 'log-0-444444444444', kind: 'log', content: 'ok\n' }] },
      ] })
    const served = await get(app, url('alpha', 'main', 'files', '/results/ui/1'))
    assert.equal(served.status, 200, served.body)
    const result = validateWorkerResult(served.json())
    assert.deepEqual(result.changed_files, changed)
    assert.deepEqual(result.artifacts.filter(artifact => artifact.kind === 'file').map(({ artifact_id, path, uri, sha256: digest }) => ({ artifact_id, path, uri, sha256: digest })), [
      { artifact_id: 'file-0-111111111111', path: 'docs/GUIDE.md', uri: '/api/projects/alpha/workflows/main/runs/files/artifacts/file-0-111111111111', sha256: sha256(markdown) },
      { artifact_id: 'file-1-222222222222', path: 'src/app.ts', uri: '/api/projects/alpha/workflows/main/runs/files/artifacts/file-1-222222222222', sha256: sha256(source) },
    ])
    assert.deepEqual(result.files_not_captured, notCaptured)
    assert.ok(!served.body.includes(root))
    // A result recorded before capture carries neither field and still validates.
    const legacy = await get(app, url('alpha', 'main', 'files', '/results/adapter/1'))
    assert.equal(legacy.status, 200, legacy.body)
    const legacyResult = validateWorkerResult(legacy.json())
    assert.equal('files_not_captured' in legacyResult, false)
    assert.deepEqual(legacyResult.artifacts.map(artifact => artifact.kind), ['log'])
    // The artifact route serves the captured bytes verbatim as text, never as HTML.
    const file = await get(app, url('alpha', 'main', 'files', '/artifacts/file-0-111111111111'))
    assert.equal(file.status, 200, file.body)
    assert.equal(file.headers['content-type'], 'text/plain; charset=utf-8')
    assert.equal(file.headers['x-content-type-options'], 'nosniff')
    assert.match(String(file.headers['content-disposition']), /^inline; filename="file-0-111111111111"$/)
    assert.equal(file.body, markdown)
    assert.equal((await get(app, url('alpha', 'main', 'files', '/artifacts/file-1-222222222222'))).body, source)
  })
})

test('a file artifact without a path, or an uncaptured entry that is not a changed file, is refused rather than served', async () => {
  await harness(async ({ app, runsRoot, root }) => {
    await writeRun(runsRoot('alpha', 'main'), { runId: 'badfiles', values: { ui: receipt('ui'), adapter: receipt('adapter'), snapshots }, next: ['verify_adapter'], events: launchEvents,
      packets: [
        { node: 'ui', changed: ['docs/GUIDE.md'], artifacts: [{ id: 'file-0-111111111111', kind: 'file', content: '# Guide\n' }, { id: 'log-1-222222222222', kind: 'log', content: 'ok\n' }] },
        { node: 'adapter', artifacts: [{ id: 'log-0-333333333333', kind: 'log', content: 'ok\n' }],
          mutate: packet => { (packet.result as Record<string, unknown>).files_not_captured = [{ path: 'src/elsewhere.ts', reason: 'missing' }] } },
      ] })
    assertError(await get(app, url('alpha', 'main', 'badfiles', '/results/ui/1')), 500, 'RESULT_INVALID', root)
    assertError(await get(app, url('alpha', 'main', 'badfiles', '/results/adapter/1')), 500, 'RESULT_INVALID', root)
  })
})

test('the same artifact ID registered twice is served only when both registrations agree on content', async () => {
  await harness(async ({ app, runsRoot, root }) => {
    await writeRun(runsRoot('alpha', 'main'), { runId: 'dup', values: { ui: receipt('ui'), adapter: receipt('adapter'), snapshots }, next: ['verify_ui'], events: launchEvents,
      packets: [
        { node: 'ui', attempt: 1, artifacts: [{ id: 'log-0-same', kind: 'log', content: 'identical' }, { id: 'log-1-differs', kind: 'log', content: 'first' }] },
        { node: 'ui', attempt: 2, artifacts: [{ id: 'log-0-same', kind: 'log', content: 'identical' }, { id: 'log-1-differs', kind: 'log', content: 'second' }] },
      ] })
    const same = await get(app, url('alpha', 'main', 'dup', '/artifacts/log-0-same'))
    assert.equal(same.status, 200)
    assert.equal(same.body, 'identical')
    assertError(await get(app, url('alpha', 'main', 'dup', '/artifacts/log-1-differs')), 500, 'EVIDENCE_MISMATCH', root)
  })
})

test('a reused candidate packet serves its worker packet\'s artifacts and names that packet\'s worktree', async () => {
  // workflow/checks.py reuse_packet (C28): one lane without a browser check; the candidate packet names the worker packet it
  // reused, copies its result and holds no artifact of its own.
  await harness(async ({ app, runsRoot }) => {
    const reused_from = { path: 'verification/worker/ui/1/packet.json', sha256: 'a'.repeat(64) }
    await writeRun(runsRoot('alpha', 'main'), { runId: 'reused', values: { ui: receipt('ui'), adapter: receipt('adapter'), snapshots }, next: ['review'], events: launchEvents,
      packets: [
        { node: 'ui', phase: 'candidate', artifacts: [{ id: 'log-0-444444444444', kind: 'log', content: 'checked once\n', skipWrite: true }],
          mutate: packet => { packet.reused_from = reused_from } },
        { node: 'ui', artifacts: [{ id: 'log-0-444444444444', kind: 'log', content: 'checked once\n' }] },
      ] })
    const log = await get(app, url('alpha', 'main', 'reused', '/artifacts/log-0-444444444444'))
    assert.equal(log.status, 200)
    assert.equal(log.body, 'checked once\n')
    const result = await get(app, url('alpha', 'main', 'reused', '/results/candidate_ui/1'))
    assert.equal(result.status, 200)
    assert.deepEqual(JSON.parse(result.body).checks.map((check: { cwd: string }) => check.cwd), ['verification/worker/ui/1/worktree'])
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Review results and run inputs (export sections 1.1.0 / 1.2.0)

test('a recorded review is served with its reviewer, redacted text, verbatim-only task links and the diff artifact; the review node links to it', async () => {
  await harness(async ({ app, runsRoot, root }) => {
    const leak = `${root}/runs/alpha/main/reviewed/worktree-ui/tests/harness.ts`
    const uiTask = `${UI_TASK}\n\nWrite the harness to ${leak} before anything else.`
    const findings: Finding[] = [
      finding({ message: `The findings table omits the disposition column; see ${leak} for the fixture.`, worker: 'ui', requirement: 'Show every finding with severity and disposition.' }),
      finding({ message: 'Paraphrased quotes are never matched.', worker: 'ui', requirement: 'Show all findings with their severity and disposition.' }),
      finding({ message: 'Cross-cutting policy finding.', disposition: 'accepted', worker: 'none', requirement: null }),
      finding({ message: 'Quotes are matched against the raw task text, then redacted.', worker: 'ui', requirement: `Write the harness to ${leak} before anything else.` }),
      finding({ message: 'A redacted spelling is not the raw text.', worker: 'ui', requirement: 'Write the harness to <path> before anything else.' }),
      finding({ message: 'The adapter task is searched too.', disposition: 'resolved', worker: 'both', requirement: 'Serve the review route from the export section.' }),
      finding({ message: 'Recorded before the reviewer prompt asked for links.', worker: null, requirement: null }),
    ]
    await writeRun(runsRoot('alpha', 'main'), { runId: 'reviewed', values: reviewedValues({ review: { verdict: 'approved', findings: 'never trusted' } }), next: ['approval'], events: reviewedEvents,
      packets: reviewedPackets, review: reviewSection({ findings }), inputs: inputsSection({}, { ui: { task: uiTask } }), diffFile: DIFF })
    const response = await get(app, url('alpha', 'main', 'reviewed', '/reviews/1'))
    assert.equal(response.status, 200, response.body)
    assert.ok(!response.body.includes(root), 'no absolute path leaves the server')
    const review = validateReviewResult(response.json())
    assert.equal(review.contract_version, '1.4.0')
    assert.deepEqual([review.run_id, review.node_id, review.attempt, review.verdict], ['reviewed', 'review', 1, 'approved'])
    assert.deepEqual(review.reviewer, { session_id: REVIEWER, transport: 'native', independent: true })
    assert.deepEqual([review.bundle_sha256, review.candidate_commit, review.reviewed_at], [BUNDLE, OUTPUT, T2])
    assert.equal(review.findings.length, 7)
    // An export before 1.4.0 has the single reviewer `review`: the adapter fills the list from the section itself.
    assert.ok(review.findings.every(item => item.reviewer === 'review'))
    assert.equal(review.reviewers.length, 1)
    assert.deepEqual([review.reviewers[0].reviewer_id, review.reviewers[0].transport, review.reviewers[0].session_id, review.reviewers[0].verdict, review.reviewers[0].status, review.reviewers[0].launched_at, review.reviewers[0].accepted_at],
      ['review', 'native', REVIEWER, 'approved', 'accepted', null, T2])
    assert.deepEqual(review.reviewers[0].findings, review.findings)
    assert.equal(review.findings[0].message, 'The findings table omits the disposition column; see <path> for the fixture.')
    assert.deepEqual(review.findings.map(item => item.requirement_found_in), [['ui'], [], [], ['ui'], [], ['adapter'], []])
    assert.equal(review.findings[3].requirement, 'Write the harness to <path> before anything else.')
    assert.deepEqual(review.findings.map(item => item.worker), ['ui', 'ui', 'none', 'ui', 'ui', 'both', null])
    const artifactId = `patch-review-${sha256(DIFF).slice(0, 12)}`
    assert.deepEqual(review.diff, { artifact_id: artifactId, kind: 'patch', uri: `/api/projects/alpha/workflows/main/runs/reviewed/artifacts/${artifactId}`, sha256: sha256(DIFF) })
    // The review node carries the reviewer session and a scoped link to the result; nothing in `values` is consulted.
    const detail = validateRunDetail((await get(app, url('alpha', 'main', 'reviewed'))).json())
    const node = detail.snapshot.nodes.find(item => item.node_id === 'review')!
    assert.deepEqual([node.status, node.attempt, node.session_id, node.result_uri], ['succeeded', 1, REVIEWER, '/api/projects/alpha/workflows/main/runs/reviewed/reviews/1'])
    assert.equal(detail.summary.status, 'running')
    assertError(await get(app, url('alpha', 'main', 'reviewed', '/reviews/2')), 404, 'REVIEW_NOT_FOUND', root)
    assertError(await get(app, url('alpha', 'main', 'reviewed', '/reviews/0')), 400, 'INVALID_ATTEMPT', root)
    assertError(await get(app, url('alpha', 'main', 'reviewed', '/reviews/one')), 400, 'INVALID_ATTEMPT', root)
    assertError(await get(app, url('alpha', 'main', 'missing', '/reviews/1')), 404, 'RUN_NOT_FOUND', root)
    assertError(await get(app, url('alpha', 'main', 'missing', '/inputs')), 404, 'RUN_NOT_FOUND', root)
    // The inputs the quotes were matched against are served redacted; the raw task never leaves the server.
    const inputs = validateRunInputs((await get(app, url('alpha', 'main', 'reviewed', '/inputs'))).json())
    assert.ok(inputs.workers[0].task.text.includes('Write the harness to <path> before anything else.'))
    assert.ok(!JSON.stringify(inputs).includes(root))
  })
})

test('a two-reviewer export (1.4.0) is served with every reviewer, its findings tagged by reviewer, on the unchanged reviews route', async () => {
  await harness(async ({ app, runsRoot, root }) => {
    const general: Finding[] = [finding({ message: 'General finding.', worker: 'ui', requirement: 'Show every finding with severity and disposition.', reviewer: 'general' })]
    const coverage: Finding[] = [
      finding({ message: 'No test covers the disposition column.', worker: 'ui', requirement: null, reviewer: 'coverage' }),
      finding({ message: 'General finding.', worker: 'ui', requirement: 'Show every finding with severity and disposition.', reviewer: 'coverage' }),
    ]
    const reviewers: ReviewerSection[] = [
      { reviewer_id: 'general', transport: 'native', session_id: REVIEWER, verdict: 'approved', findings: general, launched_at: '2026-03-01T10:30:00.100000+00:00', accepted_at: '2026-03-01T10:40:00+00:00', status: 'accepted' },
      { reviewer_id: 'coverage', transport: 'native', session_id: 'e1e1e1e1-adec-4efe-bcd4-bbadc3525d95', verdict: 'approved', findings: coverage, launched_at: '2026-03-01T10:30:02+00:00', accepted_at: T2, status: 'accepted' },
    ]
    await writeRun(runsRoot('alpha', 'main'), { runId: 'two', version: '1.4.0', values: reviewedValues({ review: { verdict: 'approved' } }), next: ['approval'], events: reviewedEvents,
      packets: reviewedPackets, review: reviewSection({ reviewer_session_id: `${REVIEWER}, e1e1e1e1-adec-4efe-bcd4-bbadc3525d95`, findings: [...general, ...coverage], reviewers }), inputs: inputsSection(), diffFile: DIFF })
    const response = await get(app, url('alpha', 'main', 'two', '/reviews/1'))
    assert.equal(response.status, 200, response.body)
    const review = validateReviewResult(response.json())
    assert.equal(review.contract_version, '1.4.0')
    assert.deepEqual(review.reviewers.map(entry => [entry.reviewer_id, entry.verdict, entry.status, entry.findings.length, entry.launched_at, entry.accepted_at]),
      [['general', 'approved', 'accepted', 1, '2026-03-01T10:30:00.100000Z', '2026-03-01T10:40:00Z'], ['coverage', 'approved', 'accepted', 2, '2026-03-01T10:30:02Z', T2]])
    assert.deepEqual(review.findings.map(item => item.reviewer), ['general', 'coverage', 'coverage'])
    assert.deepEqual(review.findings.map(item => item.requirement_found_in), [['ui'], [], ['ui']])  // The same quote links for every reviewer that wrote it.
    assert.equal(review.reviewer.session_id, `${REVIEWER}, e1e1e1e1-adec-4efe-bcd4-bbadc3525d95`)
    const detail = validateRunDetail((await get(app, url('alpha', 'main', 'two'))).json())
    const node = detail.snapshot.nodes.find(item => item.node_id === 'review')!
    assert.deepEqual([node.status, node.result_uri], ['succeeded', '/api/projects/alpha/workflows/main/runs/two/reviews/1'])
    assert.ok(!response.body.includes(root))
    // One reviewer blocked while the other was still working: the blocked run keeps both entries, the superseded one without a verdict.
    const blockedReviewers: ReviewerSection[] = [
      { ...reviewers[0], verdict: null, accepted_at: null, status: 'superseded', findings: [] },
      { ...reviewers[1], verdict: 'blocked', status: 'blocked' },
    ]
    await writeRun(runsRoot('alpha', 'main'), { runId: 'one-blocks', version: '1.4.0', values: reviewedValues(), next: ['review'], events: reviewedEvents,
      packets: reviewedPackets, review: reviewSection({ verdict: 'blocked', findings: coverage, reviewers: blockedReviewers }), inputs: inputsSection(), diffFile: DIFF })
    const blocked = validateReviewResult((await get(app, url('alpha', 'main', 'one-blocks', '/reviews/1'))).json())
    assert.deepEqual(blocked.reviewers.map(entry => [entry.reviewer_id, entry.verdict, entry.status]), [['general', null, 'superseded'], ['coverage', 'blocked', 'blocked']])
    // A finding naming a reviewer the section does not list is contradictory.
    await writeRun(runsRoot('alpha', 'main'), { runId: 'foreign', version: '1.4.0', values: reviewedValues({ review: { verdict: 'approved' } }), next: ['approval'], events: reviewedEvents,
      packets: reviewedPackets, review: reviewSection({ findings: [finding({ reviewer: 'security' })], reviewers: [{ ...reviewers[0], findings: [] }] }), inputs: inputsSection(), diffFile: DIFF })
    assertError(await get(app, url('alpha', 'main', 'foreign', '/reviews/1')), 500, 'RUN_STORAGE_INVALID', root)
  })
})

test('the review diff is served as a bounded, hash- and size-checked patch artifact beside packet artifacts', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'md-manager-projects-secret-'))
  await writeFile(join(outside, 'secret.diff'), 'top secret')
  try {
    await harness(async ({ app, runsRoot, root }) => {
      const rootDir = runsRoot('alpha', 'main')
      const id = (content: Buffer | string) => `patch-review-${sha256(content).slice(0, 12)}`
      const base = { values: reviewedValues({ review: { verdict: 'approved' } }), next: ['approval'], events: reviewedEvents }
      await writeRun(rootDir, { ...base, runId: 'served', packets: [{ node: 'ui', artifacts: [{ id: 'log-0-abc', kind: 'log', content: 'ok\n' }] }], review: reviewSection(), inputs: inputsSection(), diffFile: DIFF })
      await writeRun(rootDir, { ...base, runId: 'tampered', review: reviewSection({ diff: { ...diffRegistration(DIFF), sha256: 'e'.repeat(64) } }), diffFile: DIFF })
      await writeRun(rootDir, { ...base, runId: 'shorter', review: reviewSection({ diff: { ...diffRegistration(DIFF), bytes: DIFF.length - 1 } }), diffFile: DIFF })
      await writeRun(rootDir, { ...base, runId: 'missing', review: reviewSection() })
      await writeRun(rootDir, { ...base, runId: 'linked', review: reviewSection({ diff: diffRegistration('top secret') }) })
      await symlink(join(outside, 'secret.diff'), join(rootDir, 'linked', 'review.diff'))
      const big = 'y'.repeat(600)
      await writeRun(rootDir, { ...base, runId: 'big', review: reviewSection({ diff: diffRegistration(big) }), diffFile: big })
      await writeRun(rootDir, { ...base, runId: 'none', review: reviewSection({ diff: null }), diffFile: DIFF })
      const artifact = (run: string, artifactId: string) => get(app, url('alpha', 'main', run, `/artifacts/${artifactId}`))

      const served = await artifact('served', id(DIFF))
      assert.equal(served.status, 200, served.body)
      assert.equal(served.headers['content-type'], 'text/plain; charset=utf-8')
      assert.equal(served.headers['x-content-type-options'], 'nosniff')
      assert.equal(served.headers['content-security-policy'], "default-src 'none'; sandbox")
      assert.equal(served.headers['content-disposition'], `inline; filename="${id(DIFF)}"`)
      assert.equal(served.body, DIFF)
      assert.equal((await artifact('served', 'log-0-abc')).status, 200, 'packet artifacts stay reachable beside the review diff')
      assertError(await artifact('served', `patch-review-${'0'.repeat(12)}`), 404, 'ARTIFACT_NOT_FOUND', root)
      assertError(await artifact('served', 'review.diff'), 404, 'ARTIFACT_NOT_FOUND', root)
      assertError(await artifact('tampered', id(DIFF)), 404, 'ARTIFACT_NOT_FOUND', root)
      assertError(await artifact('tampered', `patch-review-${'e'.repeat(12)}`), 500, 'ARTIFACT_HASH_MISMATCH', root)
      assertError(await artifact('shorter', id(DIFF)), 500, 'ARTIFACT_HASH_MISMATCH', root)
      assertError(await artifact('missing', id(DIFF)), 500, 'ARTIFACT_UNAVAILABLE', root)
      const linked = await artifact('linked', id('top secret'))
      assertError(linked, 500, 'ARTIFACT_UNAVAILABLE', root)
      assert.ok(!linked.body.includes('top secret'))
      assertError(await artifact('big', id(big)), 500, 'ARTIFACT_TOO_LARGE', root)
      assertError(await artifact('none', id(DIFF)), 404, 'ARTIFACT_NOT_FOUND', root)
      const none = validateReviewResult((await get(app, url('alpha', 'main', 'none', '/reviews/1'))).json())
      assert.equal(none.diff, null)
      // Registration problems never surface through the review payload as a fabricated link: the link is only to the registry.
      const tampered = validateReviewResult((await get(app, url('alpha', 'main', 'tampered', '/reviews/1'))).json())
      assert.equal(tampered.diff!.artifact_id, `patch-review-${'e'.repeat(12)}`)
    }, undefined, { runStore: { artifactByteLimit: 512 } })
  } finally { await rm(outside, { recursive: true, force: true }) }
})

test('a blocked review is served with its verdict while the review node projects failed from the task error and the run fails', async () => {
  await harness(async ({ app, runsRoot, root }) => {
    const findings: Finding[] = [
      finding({ severity: 'P1', message: 'The inputs route serves absolute paths.', disposition: 'open', worker: 'adapter', requirement: 'Serve the review route from the export section.' }),
      finding({ severity: 'P2', message: 'Minor naming.', disposition: 'resolved', worker: 'ui', requirement: null }),
    ]
    await writeRun(runsRoot('alpha', 'main'), { runId: 'blocked', values: reviewedValues(), next: [], events: [...reviewedEvents, { sequence: 10, time: T2, node: 'review', status: 'blocked', message: 'Independent reviewer blocked the candidate' }],
      tasks: [{ node_id: 'review', error: `Independent reviewer blocked the candidate; see ${root}/runs/alpha/main/blocked/review.json`, interrupts: [], result: null }],
      packets: reviewedPackets, review: reviewSection({ transport: 'print', verdict: 'blocked', findings, reviewed_at: T2 }), inputs: inputsSection(), diffFile: DIFF, updated: T2 })
    const detail = validateRunDetail((await get(app, url('alpha', 'main', 'blocked'))).json())
    assert.equal(detail.summary.status, 'failed')
    const node = detail.snapshot.nodes.find(item => item.node_id === 'review')!
    assert.deepEqual([node.status, node.attempt, node.session_id, node.result_uri], ['failed', 1, REVIEWER, '/api/projects/alpha/workflows/main/runs/blocked/reviews/1'])
    const response = await get(app, url('alpha', 'main', 'blocked', '/reviews/1'))
    assert.equal(response.status, 200, response.body)
    const review = validateReviewResult(response.json())
    assert.equal(review.verdict, 'blocked')
    assert.equal(review.reviewer.transport, 'print')
    assert.deepEqual(review.findings.map(item => [item.severity, item.disposition, item.requirement_found_in]), [['P1', 'open', ['adapter']], ['P2', 'resolved', []]])
    assert.ok(!response.body.includes(root))
  })
})

test('a retried lane whose newest packet passed is not failed by the error its checkpoint task still holds', async () => {
  await harness(async ({ app, runsRoot }) => {
    // The first attempt failed (the task keeps its error until the graph moves on) and the retry passed: the packet decides.
    await writeRun(runsRoot('alpha', 'main'), { runId: 'retried', values: reviewedValues(), next: [], events: [...reviewedEvents],
      tasks: [{ node_id: 'verify_adapter', error: 'RuntimeError(platform verification blocked; retry raised the attempt)', interrupts: [], result: null }],
      packets: reviewedPackets, review: null, inputs: inputsSection(), diffFile: DIFF })
    const detail = validateRunDetail((await get(app, url('alpha', 'main', 'retried'))).json())
    const node = detail.snapshot.nodes.find(item => item.node_id === 'verify_adapter')!
    assert.equal(node.status, 'succeeded')
  })
})

test('exports without a section are served without it: 1.0.0 has neither, 1.1.0 has the review only, explicit nulls mean not recorded', async () => {
  await harness(async ({ app, runsRoot, root }) => {
    const rootDir = runsRoot('alpha', 'main')
    const integrated = { values: reviewedValues({ review: { reviewer: REVIEWER, verdict: 'approved' }, approved_bundle: 'e'.repeat(64), integrated_commit: OUTPUT }), next: [], packets: reviewedPackets,
      events: [...reviewedEvents, { sequence: 10, time: T2, node: 'review', status: 'approved', message: REVIEWER }, { sequence: 11, time: T2, node: 'integrate', status: 'succeeded', message: `Fast-forwarded to ${OUTPUT}` }] }
    await writeRun(rootDir, { ...integrated, runId: 'legacy', version: '1.0.0' })
    const manual = reviewSection({ transport: 'manual', reviewer_session_id: 'operator@example', diff: null,
      findings: [finding({ message: 'Recorded by hand.', worker: null, requirement: null }), finding({ message: 'Quoted but unmatched without inputs.', worker: 'ui', requirement: 'Show every finding with severity and disposition.' })] })
    await writeRun(rootDir, { ...integrated, runId: 'partial', version: '1.1.0', review: manual })
    await writeRun(rootDir, { ...integrated, runId: 'nulls', version: '1.2.0', review: null, inputs: null })

    const legacy = validateRunDetail((await get(app, url('alpha', 'main', 'legacy'))).json())
    assert.equal(legacy.summary.status, 'succeeded')
    const legacyNode = legacy.snapshot.nodes.find(item => item.node_id === 'review')!
    assert.deepEqual([legacyNode.status, legacyNode.attempt, legacyNode.session_id, legacyNode.result_uri], ['succeeded', 1, null, null], 'values.review is never projected as a result')
    assertError(await get(app, url('alpha', 'main', 'legacy', '/reviews/1')), 404, 'REVIEW_NOT_FOUND', root)
    assertError(await get(app, url('alpha', 'main', 'legacy', '/inputs')), 404, 'INPUTS_NOT_FOUND', root)

    const partial = validateRunDetail((await get(app, url('alpha', 'main', 'partial'))).json())
    const partialNode = partial.snapshot.nodes.find(item => item.node_id === 'review')!
    assert.deepEqual([partialNode.status, partialNode.session_id, partialNode.result_uri], ['succeeded', 'operator@example', '/api/projects/alpha/workflows/main/runs/partial/reviews/1'])
    const review = validateReviewResult((await get(app, url('alpha', 'main', 'partial', '/reviews/1'))).json())
    assert.deepEqual(review.reviewer, { session_id: 'operator@example', transport: 'manual', independent: true })
    assert.equal(review.diff, null)
    assert.deepEqual(review.findings.map(item => [item.worker, item.requirement_found_in]), [[null, []], ['ui', []]], 'without inputs no quote can be matched')
    assertError(await get(app, url('alpha', 'main', 'partial', '/inputs')), 404, 'INPUTS_NOT_FOUND', root)

    const nulls = validateRunDetail((await get(app, url('alpha', 'main', 'nulls'))).json())
    assert.deepEqual([nulls.snapshot.nodes.find(item => item.node_id === 'review')!.session_id, nulls.snapshot.nodes.find(item => item.node_id === 'review')!.result_uri], [null, null])
    assertError(await get(app, url('alpha', 'main', 'nulls', '/reviews/1')), 404, 'REVIEW_NOT_FOUND', root)
    assertError(await get(app, url('alpha', 'main', 'nulls', '/inputs')), 404, 'INPUTS_NOT_FOUND', root)
    const runs = projectSchemas.runList.parse((await get(app, url('alpha', 'main'))).json())
    assert.deepEqual(runs.runs.map(run => run.run_id), ['legacy', 'nulls', 'partial'])
  })
})

test('run inputs are projected in policy order with redaction, truncation, Z timestamps, launch-node mapping and receipt passthrough', async () => {
  await harness(async ({ app, runsRoot, root }) => {
    const rootDir = runsRoot('alpha', 'main')
    const leak = `${root}/runs/alpha/main/inputs/worktree-ui`
    const longTask = `${UI_TASK}\n\nWorktree: ${leak}\n\n${'x'.repeat(TEXT_LIMIT)}`
    const redactedLength = longTask.length - leak.length + '<path>'.length
    const section = inputsSection({ failure_drill: { node_id: 'adapter', phase: 'worker', attempt: 1 } }, {
      ui: { task: longTask, prompt: `You are a workflow worker in ${leak}\n\n${longTask}`, completion: { status: 'blocked', summary: `Blocked on ${leak}/src`, open_assumptions: ['Mock routes only', '  '] } },
      adapter: { prompt: null, launch: { ...workerInput('adapter').launch!, session_id: null, native_started_at: null, observed_state: null, status: 'launching', launcher_invocations: 0 },
        completion: null, handoff: null, stop: { stopped: false, confirmed_at: null } },
    })
    // Policy order is the export's worker order, whatever the lane names sort to.
    section.workers = { adapter: section.workers.adapter, ui: section.workers.ui }
    await writeRun(rootDir, { runId: 'inputs', values: reviewedValues(), next: ['review'], events: reviewedEvents, packets: reviewedPackets, inputs: section })
    const response = await get(app, url('alpha', 'main', 'inputs', '/inputs'))
    assert.equal(response.status, 200, response.body)
    assert.ok(!response.body.includes(root), 'no absolute path leaves the server')
    const inputs = validateRunInputs(response.json())
    assert.deepEqual([inputs.contract_version, inputs.run_id, inputs.feature, inputs.base_commit, inputs.source_branch, inputs.mode], ['1.4.0', 'inputs', 'Review verdict and findings in the viewer', BASE, 'feature/synthetic', 'automatic'])
    // A 1.2.0 export: no roles, controller record or profile (export 1.7.0); served as null.
    assert.deepEqual([inputs.roles, inputs.controller], [null, null])
    assert.deepEqual(inputs.automatic, { finish: 'verified-feature-branch', permission_mode: 'bypassPermissions', worker_timeout_seconds: 3600, review_timeout_seconds: 1800, reviewer_transport: 'native', profile: null })
    assert.deepEqual(inputs.setup, [{ command: 'npm ci', timeout_seconds: 600 }])
    assert.equal(inputs.max_verification_attempts, 3)
    assert.ok(!('failure_drill' in inputs) && !('policy_version' in inputs))
    assert.deepEqual(inputs.workers.map(worker => [worker.node_id, worker.launch_node_id, worker.role]), [['adapter', 'launch_adapter', 'backend'], ['ui', 'launch_ui', 'frontend']])
    // A 1.2.0 export declares no required kinds and no selection: the kinds the controller derived from the role, every lane selected, nothing excluded.
    assert.deepEqual(inputs.workers.map(worker => worker.required_check_kinds), [['unit'], ['build', 'browser']])
    assert.deepEqual([inputs.selected_workers, inputs.excluded_workers], [['adapter', 'ui'], []])
    const [adapter, ui] = inputs.workers
    // Text is redacted, then truncated with a marker that counts what was cut.
    assert.equal(ui.task.truncated, true)
    const marker = `\n\n[… truncated by the viewer API: ${redactedLength - TEXT_LIMIT} more characters]`
    assert.ok(ui.task.text.endsWith(marker), ui.task.text.slice(-120))
    assert.equal(ui.task.text.length, TEXT_LIMIT + marker.length)
    assert.ok(ui.task.text.includes(`Worktree: <path>\n`))
    assert.equal(ui.prompt!.truncated, true)
    assert.ok(ui.prompt!.text.startsWith('You are a workflow worker in <path>\n'))
    assert.deepEqual(adapter.task, { text: ADAPTER_TASK, truncated: false })
    assert.equal(adapter.prompt, null)
    assert.deepEqual(ui.owned_paths, ['src/projects', 'tests/project-workflows'])
    assert.deepEqual(ui.checks.map(check => [check.id, check.kind, check.command, check.timeout_seconds, check.scenarios.length]),
      [['frontend-build', 'build', 'npm run build', 180, 0], ['project-workflows-browser', 'browser', 'npx --no-install playwright test --config=tests/project-workflows/playwright.config.ts', 300, 1]])
    assert.ok(ui.checks.every(check => !('argv' in check)))
    // Receipts: offsets become Z, epoch milliseconds become timestamps, tokens and background IDs stay private.
    assert.deepEqual(ui.launch, { session_id: 'ui-session-0001', launch_requested_at: '2026-03-01T10:00:00.331982Z', native_started_at: '2026-03-01T10:00:02.771Z', observed_state: 'working', status: 'attached_session_available', launcher_invocations: 1 })
    assert.deepEqual(adapter.launch, { session_id: null, launch_requested_at: '2026-03-01T10:00:00.331982Z', native_started_at: null, observed_state: null, status: 'launching', launcher_invocations: 0 })
    // An export before 1.5.0 has no completion evidence, questions, decisions or challenge: nulls and [].
    assert.deepEqual(ui.completion, { version: '1.0.0', status: 'blocked', summary: 'Blocked on <path>', open_assumptions: ['Mock routes only'], untested: null, falsifying_check: null, verify_yourself: null, question: null })
    assert.deepEqual([ui.questions, adapter.questions, inputs.decisions, inputs.challenge], [[], [], null, null])
    assert.deepEqual(ui.handoff, { summary: 'ui done', open_assumptions: ['ui assumption'] })
    assert.deepEqual(ui.stop, { stopped: true, confirmed_at: '2026-03-01T10:20:00Z' })
    assert.deepEqual([adapter.completion, adapter.handoff, adapter.stop], [null, null, { stopped: false, confirmed_at: null }])
    // A manual run without automatic settings, and a graph without launch_* nodes, map onto the contract as well.
    const flat = { name: 'Flat graph', nodes: [{ node_id: 'ui', label: 'UI', kind: 'worker', depends_on: [] }, { node_id: 'adapter', label: 'Adapter', kind: 'worker', depends_on: [] }, { node_id: 'review', label: 'Review', kind: 'review', depends_on: ['ui', 'adapter'] }] }
    await writeRun(rootDir, { runId: 'manual', definition: flat, next: ['ui', 'adapter'], inputs: inputsSection({ mode: 'manual', automatic: null, source_branch: null }, { ui: { launch: null, completion: null, handoff: null, stop: null } }) })
    const manual = validateRunInputs((await get(app, url('alpha', 'main', 'manual', '/inputs'))).json())
    assert.deepEqual([manual.mode, manual.automatic, manual.source_branch], ['manual', null, null])
    assert.deepEqual(manual.workers.map(worker => [worker.node_id, worker.launch_node_id]), [['ui', 'ui'], ['adapter', 'adapter']])
    assert.deepEqual([manual.workers[0].launch, manual.workers[0].completion, manual.workers[0].handoff, manual.workers[0].stop], [null, null, null, null])
  })
})

/** A 1.5.0 challenge section exactly as workflow/export_state.py writes it (the latest challenge.json plus `attempts`). */
function challengeSection(overrides: Record<string, unknown> = {}) {
  return {
    status: 'paused', attempt: 2, attempts: 2, session_id: 'challenge-session-2',
    pinned: { tasks_sha256: 'a'.repeat(64), decisions_sha256: 'b'.repeat(64), prd_sha256: 'c'.repeat(64) },
    concerns: [
      { severity: 'P1', kind: 'failure_mode', message: 'Both lanes write /home/op/dev/md-manager/server/projects.ts', consequence: 'The candidate cannot merge.' },
      { severity: 'P2', kind: 'complexity', message: 'Two reviewers.', consequence: 'Review costs twice.' },
    ],
    simpler_alternative: 'One lane.', cheap_experiment: 'Diff the owned paths.', accepted_reason: null, decided_at: '2026-03-01T09:59:00.123456Z',
    ...overrides,
  }
}

test('[scenario:served-inputs] a 1.5.0 export serves decisions, the challenge, completion evidence and questions; older runs stay valid', async () => {
  await harness(async ({ app, runsRoot, root }) => {
    const rootDir = runsRoot('alpha', 'main')
    const leak = `${root}/runs/alpha/main/guarded/worktree-ui`
    const definition = { name: 'Feature implementation', nodes: [
      { node_id: 'challenge', label: 'Design challenge', kind: 'review', depends_on: [] },
      ...GRAPH_NODES.map(node => node.kind === 'worker' ? { ...node, depends_on: ['challenge'] } : node)] }
    const decisions = `# Decisions\n\n## Decisions\n\n- Serve the fields unchanged; see ${leak} for the run.\n`
    const section = inputsSection({ decisions, challenge: challengeSection() }, {
      ui: {
        completion: { version: '1.1.0', status: 'completed', summary: 'ui done', open_assumptions: [], untested: ['Narrow screens', ' '], falsifying_check: 'project-workflows-browser', verify_yourself: `Open ${leak}/report.html`, question: null },
        questions: [
          { n: 1, question: 'Group by severity?', asked_at: '2026-03-01T10:01:00+00:00', answer: 'Yes.', answered_at: '2026-03-01T10:02:00Z' },
          { n: 2, question: `Write to ${leak}?`, asked_at: '2026-03-01T10:03:00Z', answer: null, answered_at: null },
        ],
      },
      // A question the controller has not recorded yet: served with its text, redacted like the recorded ones.
      adapter: { completion: { version: '1.1.0', status: 'question', summary: 'Waiting', open_assumptions: [], untested: null, falsifying_check: '', verify_yourself: null, question: `Read ${leak}?` }, questions: [] },
    })
    // A paused challenge: nothing launched yet.
    const paused = [{ sequence: 1, time: T0, node: 'challenge', status: 'running', message: 'Design challenge attempt 2: one print job' },
      { sequence: 2, time: T0, node: 'challenge', status: 'paused', message: 'Design challenge attempt 2 paused the run' }]
    await writeRun(rootDir, { runId: 'guarded', version: '1.5.0', definition, next: ['launch_ui', 'launch_adapter'], events: paused, inputs: section })
    const response = await get(app, url('alpha', 'main', 'guarded', '/inputs'))
    assert.equal(response.status, 200, response.body)
    assert.ok(!response.body.includes(root), 'no absolute path leaves the server')
    const inputs = validateRunInputs(response.json())
    assert.equal(inputs.contract_version, '1.4.0')
    assert.equal(inputs.decisions, '# Decisions\n\n## Decisions\n\n- Serve the fields unchanged; see <path> for the run.\n')
    assert.deepEqual(inputs.challenge, { ...challengeSection(), decided_at: '2026-03-01T09:59:00.123456Z', hold: null, history: [],
      concerns: [{ ...challengeSection().concerns[0], message: 'Both lanes write <path>' }, challengeSection().concerns[1]] })
    const [ui, adapter] = inputs.workers
    assert.deepEqual(ui.completion, { version: '1.1.0', status: 'completed', summary: 'ui done', open_assumptions: [], untested: ['Narrow screens'], falsifying_check: 'project-workflows-browser', verify_yourself: 'Open <path>', question: null })
    assert.deepEqual(ui.questions, [
      { n: 1, question: 'Group by severity?', asked_at: '2026-03-01T10:01:00Z', answer: 'Yes.', answered_at: '2026-03-01T10:02:00Z' },
      { n: 2, question: 'Write to <path>?', asked_at: '2026-03-01T10:03:00Z', answer: null, answered_at: null }])
    assert.deepEqual([adapter.completion, adapter.questions], [{ version: '1.1.0', status: 'question', summary: 'Waiting', open_assumptions: [], untested: null, falsifying_check: null, verify_yourself: null, question: 'Read <path>?' }, []])
    // The graph starts with the challenge node, paused with its attempts and session; no launch node has started.
    const detail = validateRunDetail((await get(app, url('alpha', 'main', 'guarded'))).json())
    assert.deepEqual(detail.definition.nodes[0], { node_id: 'challenge', label: 'Design challenge', kind: 'review', depends_on: [] })
    const nodes = new Map(detail.snapshot.nodes.map(node => [node.node_id, node]))
    assert.deepEqual([nodes.get('challenge')!.status, nodes.get('challenge')!.attempt, nodes.get('challenge')!.session_id], ['paused', 2, 'challenge-session-2'])
    assert.deepEqual([nodes.get('launch_ui')!.status, detail.summary.status], ['pending', 'paused'])
    // Accepted (or passed) is a succeeded node; the accepted reason is served.
    await writeRun(rootDir, { runId: 'accepted', version: '1.5.0', definition, next: ['launch_ui', 'launch_adapter'], events: paused,
      inputs: inputsSection({ decisions, challenge: challengeSection({ status: 'accepted', accepted_reason: 'Split by file.' }) }) })
    const accepted = validateRunInputs((await get(app, url('alpha', 'main', 'accepted', '/inputs'))).json())
    assert.deepEqual([accepted.challenge!.status, accepted.challenge!.accepted_reason], ['accepted', 'Split by file.'])
    const acceptedDetail = validateRunDetail((await get(app, url('alpha', 'main', 'accepted'))).json())
    assert.equal(acceptedDetail.snapshot.nodes.find(node => node.node_id === 'challenge')!.status, 'succeeded')
    // C8: a passed attempt the plan holds is a paused node until resume --launch records its release; the record stays passed.
    const hold = { held_at: '2026-03-01T10:00:00+00:00', released_at: null, released_by: null, dropped: [] }
    const passed = { concerns: [challengeSection().concerns[1]], status: 'passed' }
    const heldEvents = [{ sequence: 1, time: T0, node: 'challenge', status: 'succeeded', message: 'Design challenge attempt 2 passed (1 P2 concern(s)); held for the operator' },
      { sequence: 2, time: T0, node: 'challenge', status: 'paused', message: 'Design challenge attempt 2 passed (1 P2 concern(s)) and is held for the operator before any worker launch' }]
    await writeRun(rootDir, { runId: 'held', version: '1.7.0', definition, next: ['launch_ui', 'launch_adapter'], events: heldEvents,
      inputs: inputsSection({ decisions, challenge: challengeSection({ ...passed, hold }) }) })
    const held = validateRunInputs((await get(app, url('alpha', 'main', 'held', '/inputs'))).json())
    assert.deepEqual([held.challenge!.status, held.challenge!.hold], ['passed', { ...hold, held_at: '2026-03-01T10:00:00Z' }])
    const heldDetail = validateRunDetail((await get(app, url('alpha', 'main', 'held'))).json())
    assert.deepEqual([heldDetail.snapshot.nodes.find(node => node.node_id === 'challenge')!.status, heldDetail.summary.status], ['paused', 'paused'])
    const release = { ...hold, released_at: '2026-03-01T10:30:00Z', released_by: 'operator', dropped: [1] }
    await writeRun(rootDir, { runId: 'released', version: '1.7.0', definition, next: ['launch_ui', 'launch_adapter'], events: heldEvents.slice(0, 1),
      inputs: inputsSection({ decisions, challenge: challengeSection({ ...passed, hold: release }) }) })
    const releasedDetail = validateRunDetail((await get(app, url('alpha', 'main', 'released'))).json())
    assert.equal(releasedDetail.snapshot.nodes.find(node => node.node_id === 'challenge')!.status, 'succeeded')
    assert.deepEqual(validateRunInputs((await get(app, url('alpha', 'main', 'released', '/inputs'))).json()).challenge!.hold,
      { ...release, held_at: '2026-03-01T10:00:00Z' })
    // Every challenge without a hold record serves hold null.
    assert.equal(accepted.challenge!.hold, null)
    // C49: the records an attempt replaced are served with their P0/P1, redacted and in UTC; an export without them serves [].
    const history = [{ attempt: 1, status: 'paused', decided_at: '2026-03-01T09:00:00+00:00',
      concerns: [{ severity: 'P1', kind: 'assumption', message: 'The PRD at /home/op/dev/md-manager/docs/PRD.md is stale', consequence: 'Lanes build the old page.' }] }]
    await writeRun(rootDir, { runId: 'retried', version: '1.7.0', definition, inputs: inputsSection({ decisions, challenge: challengeSection({ history }) }) })
    const retried = validateRunInputs((await get(app, url('alpha', 'main', 'retried', '/inputs'))).json())
    assert.deepEqual(retried.challenge!.history, [{ ...history[0], decided_at: '2026-03-01T09:00:00Z',
      concerns: [{ ...history[0].concerns[0], message: 'The PRD at <path> is stale' }] }])
    assert.deepEqual(accepted.challenge!.history, [])
    // A 1.5.0 export of a run before 2.2.0 and a 1.4.0 export both serve nulls and [].
    await writeRun(rootDir, { runId: 'unguarded', version: '1.5.0', inputs: inputsSection({ decisions: null, challenge: null }, { ui: { questions: [] }, adapter: { questions: [] } }) })
    await writeRun(rootDir, { runId: 'older', version: '1.4.0', inputs: inputsSection() })
    for (const runId of ['unguarded', 'older']) {
      const older = validateRunInputs((await get(app, url('alpha', 'main', runId, '/inputs'))).json())
      assert.deepEqual([older.decisions, older.challenge, older.workers.map(worker => worker.questions), older.workers[0].completion!.falsifying_check], [null, null, [[], []], null], runId)
      // Exports before 1.5.0 carry only 1.0.0 completions, and say so.
      assert.deepEqual([older.workers[0].completion!.version, older.workers[0].completion!.question], ['1.0.0', null], runId)
      assert.equal((await get(app, url('alpha', 'main', runId))).status, 200)
    }
    // A fourth question, served as blocked with its text after three answered questions.
    const answered = [1, 2, 3].map(n => ({ n, question: `Question ${n}?`, asked_at: T0, answer: 'Yes.', answered_at: T0 }))
    const fourth = { version: '1.1.0', status: 'blocked', summary: 'Asked again', open_assumptions: [], untested: null, falsifying_check: null, verify_yourself: null, question: 'Fourth?' }
    await writeRun(rootDir, { runId: 'fourth', version: '1.5.0', inputs: inputsSection({ decisions, challenge: null }, { ui: { completion: fourth, questions: answered }, adapter: { questions: [] } }) })
    const blocked = validateRunInputs((await get(app, url('alpha', 'main', 'fourth', '/inputs'))).json()).workers[0]
    assert.deepEqual([blocked.completion!.status, blocked.completion!.question, blocked.questions.length], ['blocked', 'Fourth?', 3])
    // A contradictory challenge or question list fails the run as a whole, naming only the run.
    await writeRun(rootDir, { runId: 'bad-challenge', version: '1.5.0', inputs: inputsSection({ challenge: challengeSection({ status: 'passed' }) }) })
    await writeRun(rootDir, { runId: 'bad-question', version: '1.5.0', inputs: inputsSection({}, { ui: { questions: [{ n: 2, question: 'q', asked_at: T0, answer: null, answered_at: null }] } }) })
    // A 1.1.0 completion with evidence must say so: an export without its version serves 1.0.0, which carries none.
    await writeRun(rootDir, { runId: 'bad-version', version: '1.5.0', inputs: inputsSection({}, { ui: { completion: { status: 'completed', summary: 'Done', open_assumptions: [], untested: [], falsifying_check: 'x', verify_yourself: 'y' } } }) })
    for (const runId of ['bad-challenge', 'bad-question', 'bad-version']) assertError(await get(app, url('alpha', 'main', runId, '/inputs')), 500, 'RUN_STORAGE_INVALID', root)
  })
})

test('malformed or contradictory review and inputs sections are RUN_STORAGE_INVALID for detail and lists, naming only the run', async () => {
  const base = { values: reviewedValues({ review: { verdict: 'approved' } }), next: ['approval'], events: reviewedEvents, diffFile: DIFF }
  const withReview = (mutate: (section: ReviewSection) => void, runId: string): RunSpec => {
    const section = reviewSection()
    mutate(section)
    return { ...base, runId, review: section, inputs: inputsSection() }
  }
  const withInputs = (mutate: (section: InputsSection) => void, runId: string): RunSpec => {
    const section = inputsSection()
    mutate(section)
    return { ...base, runId, review: reviewSection(), inputs: section }
  }
  const cases: RunSpec[] = [
    { ...base, runId: 'unknown-version', version: '1.11.0', review: reviewSection(), inputs: inputsSection() },
    { ...base, runId: 'review-string', review: 'approved' },
    { ...base, runId: 'inputs-array', inputs: [] },
    withReview(section => { (section as Record<string, unknown>).summary = 'extra' }, 'review-extra-key'),
    withReview(section => { (section as Record<string, unknown>).verdict = 'maybe' }, 'review-verdict'),
    withReview(section => { section.bundle_sha256 = 'f'.repeat(63) }, 'review-bundle'),
    withReview(section => { (section as Record<string, unknown>).independent = false }, 'review-dependent'),
    withReview(section => { section.attempt = 0 }, 'review-attempt'),
    withReview(section => { section.reviewed_at = 'yesterday' }, 'review-time'),
    withReview(section => { section.findings = [finding({ severity: 'P1', disposition: 'open' })] }, 'review-approved-with-blocker'),
    withReview(section => { (section.findings[0] as Record<string, unknown>).worker = 'tester' }, 'review-worker-not-a-lane-of-this-run'),
    withReview(section => { (section.findings[0] as Record<string, unknown>).worker = 'Tester' }, 'review-worker-pattern'),
    withReview(section => { section.findings[0].requirement = '' }, 'review-empty-quote'),
    withReview(section => { (section.findings[0] as Record<string, unknown>).line = 12 }, 'review-finding-key'),
    withReview(section => { section.diff = { path: 'plan.json', sha256: sha256(DIFF), bytes: DIFF.length } }, 'review-diff-path'),
    withReview(section => { section.diff = { path: '../other/review.diff', sha256: sha256(DIFF), bytes: DIFF.length } }, 'review-diff-traversal'),
    withInputs(section => { section.automatic = null }, 'inputs-automatic-missing'),
    withInputs(section => { section.mode = 'manual' }, 'inputs-manual-with-settings'),
    withInputs(section => { section.workers.review = workerInput('ui') }, 'inputs-reserved-lane'),
    withInputs(section => { section.workers['launch_docs'] = workerInput('ui') }, 'inputs-prefixed-lane'),
    withInputs(section => { section.workers.challenge = workerInput('ui') }, 'inputs-challenge-lane'),
    withInputs(section => { section.workers['challenge-1'] = workerInput('ui') }, 'inputs-challenge-prefixed-lane'),
    withInputs(section => { section.workers.Docs = workerInput('ui') }, 'inputs-lane-pattern'),
    withInputs(section => { section.selected_workers = ['ui'] }, 'inputs-selection-disagrees-with-workers'),
    withInputs(section => { section.selected_workers = ['ui', 'adapter']; section.excluded_workers = ['ui'] }, 'inputs-excluded-and-selected'),
    withInputs(section => { section.workers.ui.required_check_kinds = ['contract'] }, 'inputs-required-kind-without-check'),
    withInputs(section => { section.workers.ui.role = '' }, 'inputs-blank-role'),
    { ...base, runId: 'definition-lane-not-described', definition: { name: 'Three lanes', nodes: graphNodes(['ui', 'adapter', 'docs']) }, review: reviewSection(), inputs: inputsSection() },
    withInputs(section => { section.workers = {} }, 'inputs-no-workers'),
    withInputs(section => { section.workers.ui.owned_paths = ['/etc/passwd'] }, 'inputs-absolute-owned-path'),
    withInputs(section => { section.workers.ui.owned_paths = ['src/../..'] }, 'inputs-traversal-owned-path'),
    withInputs(section => { section.workers.ui.checks[0].id = section.workers.ui.checks[1].id }, 'inputs-duplicate-check'),
    withInputs(section => { section.workers.ui.checks[1].scenarios = [] }, 'inputs-browser-without-scenarios'),
    withInputs(section => { section.workers.ui.launch!.launch_requested_at = 'noon' }, 'inputs-launch-time'),
    withInputs(section => { section.workers.ui.stop = { stopped: false, confirmed_at: T2 } }, 'inputs-unconfirmed-stop-time'),
    withInputs(section => { section.workers.ui.completion = { status: 'done', summary: 'x', open_assumptions: [] } }, 'inputs-completion-status'),
    withInputs(section => { (section.workers.ui as Record<string, unknown>).worktree = '/home/someone/worktree' }, 'inputs-worker-key'),
    withInputs(section => { (section as Record<string, unknown>).repository = '/home/someone/repo' }, 'inputs-extra-key'),
  ]
  for (const spec of cases) {
    await harness(async ({ app, runsRoot, root }) => {
      await writeRun(runsRoot('alpha', 'main'), spec)
      assertError(await get(app, url('alpha', 'main', spec.runId)), 500, 'RUN_STORAGE_INVALID', root)
      assertError(await get(app, url('alpha', 'main', spec.runId, '/reviews/1')), 500, 'RUN_STORAGE_INVALID', root)
      assertError(await get(app, url('alpha', 'main', spec.runId, '/inputs')), 500, 'RUN_STORAGE_INVALID', root)
      const list = await get(app, url('alpha', 'main'))
      assertError(list, 500, 'RUN_STORAGE_INVALID', root)
      assert.ok(list.body.includes(spec.runId), `${spec.runId}: the run directory name is the only locator given`)
      assert.ok(!list.body.includes('/home/someone') && !list.body.includes('/etc/passwd'), `${spec.runId}: ${list.body}`)
    })
  }
})

test('redaction covers paths next to Markdown punctuation and file URIs; links respect the served text; policy labels and unpinned transports pass', async () => {
  await harness(async ({ app, runsRoot, root }) => {
    const rootDir = runsRoot('alpha', 'main')
    const leak = `${root}/runs/alpha/main/spelled/worktree-ui`
    // Every spelling an operator's Markdown might use around a path, plus a file URI, must come back as <path>.
    const uiTask = `${UI_TASK}\n\nRead [${leak}/x](${leak}/x) and |${leak}/x| and file://${leak}/x and <${leak}/x> and *${leak}/x* and **${leak}/x** first.`
    const beyond = 'Render the verdict pill on the review node.'
    const longTask = `${ADAPTER_TASK}\n\n${'y'.repeat(TEXT_LIMIT)}\n\n${beyond}`
    const findings: Finding[] = [
      finding({ message: `Screenshots were written beside [${leak}/shots] instead of below it.`, worker: 'ui', requirement: `Read [${leak}/x](${leak}/x) and |${leak}/x|` }),
      finding({ message: 'Quoted from beyond the served cut.', worker: 'adapter', requirement: beyond }),
    ]
    const section = inputsSection({ policy_version: '1.2.0', selected_workers: ['ui', 'adapter'], excluded_workers: [],
      automatic: { finish: 'verified-feature-branch', permission_mode: 'bypassPermissions', worker_timeout_seconds: 3600, review_timeout_seconds: 1800, reviewer_transport: null } },
      { ui: { task: uiTask, required_check_kinds: ['unit', 'browser'], checks: [{ id: 'test:unit', kind: 'unit', argv: ['npm', 'run', 'test:unit'], command: 'npm run test:unit', timeout_seconds: 180, scenarios: [] },
        { id: 'e2e/smoke', kind: 'browser', argv: ['npx', 'playwright', 'test'], command: 'npx playwright test', timeout_seconds: 300, scenarios: [{ id: 'review verdict / narrow', description: 'narrow layout' }] }] },
        adapter: { task: longTask, required_check_kinds: ['unit'] } })
    await writeRun(rootDir, { runId: 'spelled', version: '1.3.0', values: reviewedValues({ review: { verdict: 'approved' } }), next: ['approval'], events: reviewedEvents, packets: reviewedPackets,
      review: reviewSection({ findings }), inputs: section, diffFile: DIFF })
    const inputsResponse = await get(app, url('alpha', 'main', 'spelled', '/inputs'))
    assert.equal(inputsResponse.status, 200, inputsResponse.body)
    assert.ok(!inputsResponse.body.includes(root), `a path leaked: ${inputsResponse.body.slice(0, 400)}`)
    const inputs = validateRunInputs(inputsResponse.json())
    const ui = inputs.workers.find(worker => worker.node_id === 'ui')!
    assert.ok(ui.task.text.endsWith('Read [<path>](<path>) and |<path>| and <path> and <<path>> and *<path>* and **<path>** first.'), ui.task.text.slice(-160))
    assert.deepEqual(ui.checks.map(check => check.id), ['test:unit', 'e2e/smoke'])
    assert.deepEqual(ui.checks[1].scenarios.map(scenario => scenario.id), ['review verdict / narrow'])
    assert.equal(inputs.automatic?.reviewer_transport, null)
    const reviewResponse = await get(app, url('alpha', 'main', 'spelled', '/reviews/1'))
    assert.equal(reviewResponse.status, 200, reviewResponse.body)
    assert.ok(!reviewResponse.body.includes(root), `a path leaked: ${reviewResponse.body.slice(0, 400)}`)
    const review = validateReviewResult(reviewResponse.json())
    assert.equal(review.findings[0].message, 'Screenshots were written beside [<path>] instead of below it.')
    assert.equal(review.findings[0].requirement, 'Read [<path>](<path>) and |<path>|')
    assert.deepEqual(review.findings[0].requirement_found_in, ['ui'], 'a redacted quote still links when it survives in the served text')
    // The adapter quote is verbatim in the raw task but past the 64 KiB cut of the served text: no link is claimed.
    const adapter = inputs.workers.find(worker => worker.node_id === 'adapter')!
    assert.equal(adapter.task.truncated, true)
    assert.ok(!adapter.task.text.includes(beyond))
    assert.deepEqual(review.findings[1].requirement_found_in, [])
    // A sibling run keeps the workflow list healthy: free-form policy labels are not malformed storage.
    assert.equal((await get(app, url('alpha', 'main'))).status, 200)
  })
})

test('an abandoned run reads cancelled at run level, ahead of failed and paused (C30)', async () => {
  await harness(async ({ app, runsRoot }) => {
    const paused: RawEvent[] = [...reviewedEvents,
      { sequence: 10, time: T2, node: 'review', status: 'interrupted', message: 'Supervisor interrupted. The reviewer session keeps running; resume with: python -m workflow automatic <path> --live' }]
    const abandoned: RawEvent[] = [...paused,
      { sequence: 11, time: T2, node: 'controller', status: 'cancelled', message: 'Abandoned by the operator: usage limit; followed up by run-002. Stopped: review' }]
    await writeRun(runsRoot('alpha', 'main'), { runId: 'paused', values: reviewedValues(), next: ['review'], events: paused, packets: reviewedPackets, review: null, inputs: inputsSection() })
    await writeRun(runsRoot('alpha', 'main'), { runId: 'abandoned', values: reviewedValues(), next: ['review'], events: abandoned, packets: reviewedPackets, review: null, inputs: inputsSection() })
    assert.equal(validateRunDetail((await get(app, url('alpha', 'main', 'paused'))).json()).summary.status, 'paused')
    const detail = validateRunDetail((await get(app, url('alpha', 'main', 'abandoned'))).json())
    assert.equal(detail.summary.status, 'cancelled')
    assert.equal(detail.snapshot.status, 'cancelled')
    const timeline = (await get(app, url('alpha', 'main', 'abandoned', '/events'))).json() as { events: { sequence: number; status: string | null; node_id: string | null }[] }
    assert.deepEqual(timeline.events.at(-1), { ...timeline.events.at(-1), sequence: 11, status: 'cancelled', node_id: null })
  })
})

test('an interrupted native review projects the review node as paused, not pending, until the controller resumes', async () => {
  await harness(async ({ app, runsRoot }) => {
    const events: RawEvent[] = [...reviewedEvents,
      { sequence: 10, time: T2, node: 'review', status: 'running', message: 'Launching the native reviewer session' },
      { sequence: 11, time: T2, node: 'review', status: 'interactive', message: `Reviewer session ${REVIEWER} launched; awaiting review.completion.json` },
      { sequence: 12, time: T2, node: 'review', status: 'running', message: 'Reviewer pane attached' },
      { sequence: 13, time: T2, node: 'review', status: 'interrupted', message: 'Supervisor interrupted. The reviewer session keeps running; resume with: python -m workflow automatic <path> --live' }]
    await writeRun(runsRoot('alpha', 'main'), { runId: 'interrupted', values: reviewedValues(), next: ['review'], events, packets: reviewedPackets, review: null, inputs: inputsSection() })
    const detail = validateRunDetail((await get(app, url('alpha', 'main', 'interrupted'))).json())
    const node = detail.snapshot.nodes.find(item => item.node_id === 'review')!
    assert.deepEqual([node.status, node.attempt, node.session_id, node.result_uri], ['paused', 1, null, null])
    assert.equal(detail.summary.status, 'paused')
    const timeline = (await get(app, url('alpha', 'main', 'interrupted', '/events'))).json() as { events: { sequence: number; status: string | null; type: string }[] }
    assert.deepEqual(timeline.events.at(-1), { ...timeline.events.at(-1), sequence: 13, status: 'paused', type: 'status_changed' })
    // A stop record after an accepted review is a plain note: it never hides the node's evidence-based state.
    const stopped: RawEvent[] = [...events.slice(0, -1), { sequence: 13, time: T2, node: 'review', status: 'stopped', message: 'Reviewer session stopped; its transcript stays resumable' },
      { sequence: 14, time: T2, node: 'review', status: 'approved', message: REVIEWER }]
    await writeRun(runsRoot('alpha', 'main'), { runId: 'stopped', values: reviewedValues({ review: { verdict: 'approved' } }), next: ['approval'], events: stopped, packets: reviewedPackets, review: reviewSection(), inputs: inputsSection(), diffFile: DIFF })
    const done = validateRunDetail((await get(app, url('alpha', 'main', 'stopped'))).json())
    assert.equal(done.snapshot.nodes.find(item => item.node_id === 'review')!.status, 'succeeded')
  })
})

// Export 1.3.0: worker lanes from configuration ------------------------------------------------------------------

/** A lane's inputs entry as export 1.3.0 writes it: a free role label and its own required check kinds. */
function laneInput(lane: string, role: string, kinds: string[], checks: WorkerInput['checks'], task: string): WorkerInput {
  return { ...workerInput('adapter'), role, required_check_kinds: kinds, task, prompt: `You are a workflow worker in your own worktree.\n\n${task}`, owned_paths: [lane], checks,
    launch: { ...workerInput('adapter').launch!, session_id: `${lane}-session-0001`, background_id: `bg-${lane}` }, completion: { status: 'completed', summary: `${lane} done`, open_assumptions: [] }, handoff: { summary: `${lane} done`, open_assumptions: [] } }
}
const DOCS_TASK = '# Docs worker\n\nDocument every lane the run declares.\n\nApproved ownership and checks:\n{"node_id": "docs"}'
const contractCheck = { id: 'docs-contract', kind: 'contract', argv: ['npm', 'run', 'test:contracts'], command: 'npm run test:contracts', timeout_seconds: 120, scenarios: [] }

/** Persisted 1.3.0 state of a run over `lanes` that reached the review: per-lane receipts and packets live under `lanes` and `packets`. */
function lanesRun(lanes: string[], extra: Record<string, unknown> = {}) {
  const values = {
    lanes: Object.fromEntries(lanes.map(lane => [lane, receipt(lane)])),
    snapshots: Object.fromEntries(lanes.map(lane => [lane, { commit: OUTPUT, changed_files: [`${lane}/file`], session_id: `${lane}-session-0001`, summary: `${lane} done`, open_assumptions: [] }])),
    packets: Object.fromEntries(lanes.map(lane => [lane, `/packets/${lane}`])), bundle: '/synthetic/review-bundle.json', ...extra,
  }
  let sequence = 0
  const events: RawEvent[] = [
    ...lanes.map(lane => ({ sequence: ++sequence, time: T0, node: lane, status: 'running', message: 'Launching or reconciling the exact native session' })),
    ...lanes.map(lane => ({ sequence: ++sequence, time: T1, node: lane, status: 'interactive', message: 'Awaiting explicit completion signal; idle is not acceptance' })),
    { sequence: ++sequence, time: T1, node: 'freeze', status: 'succeeded', message: 'Immutable snapshots captured' },
    ...lanes.map(lane => ({ sequence: ++sequence, time: T1, node: `verify_${lane}`, status: 'passed', message: 'Required tests and artifacts passed' })),
    ...lanes.map(lane => ({ sequence: ++sequence, time: T1, node: `candidate_${lane}`, status: 'passed', message: `Combined revision ${OUTPUT}` })),
  ]
  const packets: PacketSpec[] = [...lanes.map(lane => ({ node: lane })), ...lanes.map(lane => ({ node: lane, phase: 'candidate' as const }))]
  return { definition: { name: 'Feature implementation', nodes: graphNodes(lanes) }, values, events, packets }
}

test('a three-lane 1.3.0 export projects one launch and verify node per lane, lane-attributed events and findings, and three workers', async () => {
  await harness(async ({ app, runsRoot, root }) => {
    const lanes = ['ui', 'adapter', 'docs']
    const run = lanesRun(lanes, { review: { verdict: 'approved' } })
    const inputs = inputsSection({ policy_version: '1.2.0', selected_workers: lanes, excluded_workers: [] })
    inputs.workers = {
      ui: { ...workerInput('ui'), required_check_kinds: ['build', 'browser'] },
      adapter: { ...workerInput('adapter'), required_check_kinds: ['unit'] },
      docs: laneInput('docs', 'technical writer', ['contract'], [contractCheck], DOCS_TASK),
    }
    const findings: Finding[] = [
      finding({ message: 'The docs lane omits the excluded lanes.', worker: 'docs', requirement: 'Document every lane the run declares.' }),
      finding({ message: 'Two lanes spell the lane list differently.', disposition: 'resolved', worker: 'multiple', requirement: null }),
      finding({ message: 'Cross-cutting.', disposition: 'accepted', worker: 'none', requirement: null }),
    ]
    await writeRun(runsRoot('alpha', 'main'), { ...run, runId: 'three', version: '1.3.0', next: ['approval'], review: reviewSection({ findings }), inputs, diffFile: DIFF })
    const detail = validateRunDetail((await get(app, url('alpha', 'main', 'three'))).json())
    assert.deepEqual(detail.definition.nodes.map(node => node.node_id), ['launch_ui', 'launch_adapter', 'launch_docs', 'handoff', 'verify_ui', 'verify_adapter', 'verify_docs', 'candidate', 'review', 'approval', 'integrate'])
    const byId = new Map(detail.snapshot.nodes.map(node => [node.node_id, node]))
    for (const lane of lanes) {
      assert.deepEqual([byId.get(`launch_${lane}`)!.status, byId.get(`launch_${lane}`)!.session_id], ['succeeded', `${lane}-session-0001`], lane)
      assert.deepEqual([byId.get(`verify_${lane}`)!.status, byId.get(`verify_${lane}`)!.attempt, byId.get(`verify_${lane}`)!.result_uri], ['succeeded', 1, `/api/projects/alpha/workflows/main/runs/three/results/${lane}/1`], lane)
    }
    assert.deepEqual([byId.get('handoff')!.status, byId.get('candidate')!.status, byId.get('review')!.status, byId.get('approval')!.status], ['succeeded', 'succeeded', 'succeeded', 'pending'])
    assert.equal(detail.summary.status, 'running')
    validateWorkerResult((await get(app, url('alpha', 'main', 'three', '/results/docs/1'))).json())
    validateWorkerResult((await get(app, url('alpha', 'main', 'three', '/results/candidate_docs/1'))).json())
    const events = (await get(app, url('alpha', 'main', 'three', '/events'))).json() as { events: { node_id: string | null; sequence: number }[] }
    assert.deepEqual(events.events.filter(event => event.sequence <= 3).map(event => event.node_id), ['launch_ui', 'launch_adapter', 'launch_docs'])
    assert.ok(events.events.some(event => event.node_id === 'verify_docs'))
    assert.equal(events.events.filter(event => event.node_id === 'candidate').length, 3)
    const served = validateRunInputs((await get(app, url('alpha', 'main', 'three', '/inputs'))).json())
    assert.deepEqual(served.workers.map(worker => [worker.node_id, worker.launch_node_id, worker.role, worker.required_check_kinds]),
      [['ui', 'launch_ui', 'frontend', ['build', 'browser']], ['adapter', 'launch_adapter', 'backend', ['unit']], ['docs', 'launch_docs', 'technical writer', ['contract']]])
    assert.deepEqual([served.selected_workers, served.excluded_workers], [lanes, []])
    assert.ok(!JSON.stringify(served).includes(root))
    const review = validateReviewResult((await get(app, url('alpha', 'main', 'three', '/reviews/1'))).json())
    assert.deepEqual(review.findings.map(item => [item.worker, item.requirement_found_in]), [['docs', ['docs']], ['multiple', []], ['none', []]])
  })
})

test('a one-lane 1.3.0 export is a complete run over that lane; the excluded lanes have no node, receipt or result', async () => {
  await harness(async ({ app, runsRoot }) => {
    const run = lanesRun(['adapter'], { review: { verdict: 'approved' }, approved_bundle: BUNDLE, integrated_commit: OUTPUT })
    const inputs = inputsSection({ policy_version: '1.2.0', selected_workers: ['adapter'], excluded_workers: ['ui', 'docs'] })
    inputs.workers = { adapter: { ...workerInput('adapter'), required_check_kinds: ['unit'] } }
    await writeRun(runsRoot('alpha', 'main'), { ...run, runId: 'one', version: '1.3.0', next: [], review: reviewSection({ findings: [finding({ worker: 'adapter', requirement: 'Serve the review route from the export section.' })] }), inputs, diffFile: DIFF })
    const detail = validateRunDetail((await get(app, url('alpha', 'main', 'one'))).json())
    assert.deepEqual(detail.definition.nodes.map(node => node.node_id), ['launch_adapter', 'handoff', 'verify_adapter', 'candidate', 'review', 'approval', 'integrate'])
    assert.equal(detail.summary.status, 'succeeded')
    assert.ok(detail.snapshot.nodes.every(node => node.status === 'succeeded'))
    const served = validateRunInputs((await get(app, url('alpha', 'main', 'one', '/inputs'))).json())
    assert.deepEqual(served.workers.map(worker => worker.node_id), ['adapter'])
    assert.deepEqual([served.selected_workers, served.excluded_workers], [['adapter'], ['ui', 'docs']])
    assertError(await get(app, url('alpha', 'main', 'one', '/results/ui/1')), 404, 'RESULT_NOT_FOUND')
    const review = validateReviewResult((await get(app, url('alpha', 'main', 'one', '/reviews/1'))).json())
    assert.deepEqual(review.findings.map(item => [item.worker, item.requirement_found_in]), [['adapter', ['adapter']]])
    // The same two-lane run recorded under 1.2.0 (flat `ui`/`ui_packet` keys, no selection) still loads, as does a 1.3.0 re-export of it.
    await writeRun(runsRoot('alpha', 'main'), { runId: 'old', values: reviewedValues({ review: { verdict: 'approved' } }), next: ['approval'], events: reviewedEvents, packets: reviewedPackets, review: reviewSection(), inputs: inputsSection(), diffFile: DIFF })
    await writeRun(runsRoot('alpha', 'main'), { runId: 'reexported', version: '1.3.0', values: reviewedValues({ review: { verdict: 'approved' } }), next: ['approval'], events: reviewedEvents, packets: reviewedPackets, review: reviewSection(), inputs: inputsSection({ selected_workers: ['ui', 'adapter'], excluded_workers: [] }), diffFile: DIFF })
    const old = validateRunDetail((await get(app, url('alpha', 'main', 'old'))).json())
    const reexported = validateRunDetail((await get(app, url('alpha', 'main', 'reexported'))).json())
    const asOld = (uri: string) => uri.replace('/runs/reexported/', '/runs/old/')
    assert.deepEqual(reexported.snapshot.nodes.map(node => ({
      ...node, result_uri: node.result_uri === null ? null : asOld(node.result_uri),
      lane_results: node.lane_results.map(lane => ({ ...lane, result_uri: asOld(lane.result_uri) })),
    })), old.snapshot.nodes)
    assert.deepEqual(old.snapshot.nodes.filter(node => node.node_id.startsWith('launch_')).map(node => node.status), ['succeeded', 'succeeded'])
  })
})

test('every successful payload conforms to the committed contract schemas', async () => {
  await harness(async ({ app, runsRoot }) => {
    await writeRun(runsRoot('alpha', 'main'), { runId: 'conform', values: { ui: receipt('ui'), adapter: receipt('adapter'), snapshots, ui_packet: '/x' }, next: ['verify_adapter'], events: launchEvents,
      packets: [{ node: 'ui', artifacts: [{ id: 'log-0-abc', kind: 'log', content: 'ok' }] }] })
    projectSchemas.projectList.parse((await get(app, '/api/projects')).json())
    const workflows = projectSchemas.workflowList.parse((await get(app, url('alpha'))).json())
    workflows.workflows.forEach(validateDefinition)
    const runs = projectSchemas.runList.parse((await get(app, url('alpha', 'main'))).json())
    const detail: RunDetail = validateRunDetail((await get(app, url('alpha', 'main', 'conform'))).json())
    assert.deepEqual(runs.runs[0], detail.summary)
    assert.deepEqual(detail.definition, workflows.workflows[0])
    const events = (await get(app, url('alpha', 'main', 'conform', '/events'))).json() as { events: unknown[] }
    events.events.forEach(event => eventSchema.parse(event))
    validateWorkerResult((await get(app, url('alpha', 'main', 'conform', '/results/ui/1'))).json())
    await writeRun(runsRoot('alpha', 'main'), { runId: 'conform-review', values: reviewedValues({ review: { verdict: 'approved' } }), next: ['approval'], events: reviewedEvents, packets: reviewedPackets,
      review: reviewSection(), inputs: inputsSection(), diffFile: DIFF })
    const review = (await get(app, url('alpha', 'main', 'conform-review', '/reviews/1'))).json()
    validateReviewResult(projectSchemas.reviewResult.parse(review))
    const inputs = (await get(app, url('alpha', 'main', 'conform-review', '/inputs'))).json()
    validateRunInputs(projectSchemas.runInputs.parse(inputs))
    const reviewed = validateRunDetail((await get(app, url('alpha', 'main', 'conform-review'))).json())
    assert.equal(reviewed.snapshot.nodes.find(node => node.node_id === 'review')!.result_uri, '/api/projects/alpha/workflows/main/runs/conform-review/reviews/1')
    // A packet whose result cannot satisfy the worker-result contract is a 500, not a partial payload.
    await writeRun(runsRoot('alpha', 'main'), { runId: 'broken', values: { ui: receipt('ui'), adapter: receipt('adapter'), snapshots }, next: ['verify_ui'], events: launchEvents,
      packets: [{ node: 'ui', mutate: packet => { (packet.result as Record<string, unknown>).changed_files = ['/absolute/leak.ts'] } }] })
    const broken = await get(app, url('alpha', 'main', 'broken', '/results/ui/1'))
    assertError(broken, 500, 'RESULT_INVALID')
    assert.ok(!broken.body.includes('/absolute/leak.ts'))
  })
})

test('the candidate node links every lane\'s combined result in lane order; no other node carries lane results', async () => {
  await harness(async ({ app, runsRoot }) => {
    const rootDir = runsRoot('alpha', 'main')
    await writeRun(rootDir, { runId: 'reviewed', values: { ui: receipt('ui'), adapter: receipt('adapter'), snapshots, ui_packet: '/synthetic/ui/packet.json', adapter_packet: '/synthetic/adapter/packet.json',
      bundle: '/synthetic/review-bundle.json', review: { reviewer: 'claude-reviewer', decision: 'approve' } },
      next: ['approval'], events: reviewedEvents, updated: T2,
      packets: [{ node: 'ui' }, { node: 'adapter' }, { node: 'ui', phase: 'candidate' }, { node: 'adapter', phase: 'candidate' }, { node: 'adapter', phase: 'candidate', attempt: 2 }] })
    await writeRun(rootDir, { runId: 'verifying', values: { ui: receipt('ui'), adapter: receipt('adapter'), snapshots, ui_packet: '/synthetic/ui/packet.json', adapter_packet: '/synthetic/adapter/packet.json' },
      next: ['candidate'], events: reviewedEvents.slice(0, 7), packets: [{ node: 'ui' }, { node: 'adapter' }] })
    const reviewed = validateRunDetail((await get(app, url('alpha', 'main', 'reviewed'))).json())
    const candidate = reviewed.snapshot.nodes.find(node => node.node_id === 'candidate')!
    assert.equal(candidate.status, 'succeeded')
    assert.deepEqual(candidate.lane_results, [
      { worker: 'ui', attempt: 1, result_uri: '/api/projects/alpha/workflows/main/runs/reviewed/results/candidate_ui/1' },
      { worker: 'adapter', attempt: 2, result_uri: '/api/projects/alpha/workflows/main/runs/reviewed/results/candidate_adapter/2' },
    ], 'one link per lane, in lane order, at the latest candidate attempt')
    assert.ok(reviewed.snapshot.nodes.filter(node => node.node_id !== 'candidate').every(node => node.lane_results.length === 0))
    // Each link serves that lane's combined result under the candidate route.
    const served = await get(app, candidate.lane_results[0].result_uri)
    assert.equal(served.status, 200, served.body)
    assert.equal(validateWorkerResult(served.json()).node_id, 'candidate_ui')
    // Before the candidate phase ran there is nothing to link.
    const verifying = validateRunDetail((await get(app, url('alpha', 'main', 'verifying'))).json())
    assert.deepEqual(verifying.snapshot.nodes.find(node => node.node_id === 'candidate')!.lane_results, [])
  })
})

test('a served worker result names the checks its gate deferred to the candidate, by executed index; nothing else changes', async () => {
  await harness(async ({ app, runsRoot }) => {
    const rootDir = runsRoot('alpha', 'main')
    const deferred = (packet: Record<string, unknown>) => {
      const result = packet.result as { checks: { exit_code: number }[] }
      result.checks[0].exit_code = 2
      ;(packet.gate as Record<string, unknown>).deferred_checks = ['frontend-build']
      ;(packet.evidence as Record<string, unknown>).checks = [{ id: 'frontend-build', worker_check_index: 0, tests: null, scenarios: [] }, { id: 'frontend-unit', worker_check_index: 1, tests: { passed: 3, failed: 0, skipped: 0 }, scenarios: [] }]
    }
    await writeRun(rootDir, { runId: 'reviewed', values: { ui: receipt('ui'), adapter: receipt('adapter'), snapshots, ui_packet: '/synthetic/ui/packet.json', adapter_packet: '/synthetic/adapter/packet.json',
      bundle: '/synthetic/review-bundle.json', review: { reviewer: 'claude-reviewer', decision: 'approve' } },
      next: ['approval'], events: reviewedEvents, updated: T2,
      packets: [{ node: 'ui', artifacts: [{ id: 'log-0-ui', kind: 'log', content: 'build log\n' }, { id: 'log-1-ui', kind: 'log', content: 'unit log\n' }], mutate: deferred },
        { node: 'adapter' }, { node: 'ui', phase: 'candidate' }, { node: 'adapter', phase: 'candidate' }] })
    const detail = validateRunDetail((await get(app, url('alpha', 'main', 'reviewed'))).json())
    assert.equal(detail.snapshot.nodes.find(node => node.node_id === 'verify_ui')!.status, 'succeeded', 'the gate passed: deferred checks do not gate the worker phase')
    const worker = validateWorkerResult((await get(app, url('alpha', 'main', 'reviewed', '/results/ui/1'))).json())
    assert.deepEqual(worker.deferred_checks, [{ id: 'frontend-build', check_index: 0 }])
    assert.equal(worker.checks[0].exit_code, 2, 'the executed exit code is served as captured')
    assert.equal(worker.status, 'succeeded')
    const combined = validateWorkerResult((await get(app, url('alpha', 'main', 'reviewed', '/results/candidate_ui/1'))).json())
    assert.equal(combined.deferred_checks, undefined, 'a gate without deferred checks serves no field at all')
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Viewer UX S5 (docs/PRD_VIEWER_UX.md 9.2): B1 projection fixes, B2 run activity, B3 the opt-in run directory

type CapturedRun = { detail: RunDetail; events: WorkflowEvent[]; inputs: RunInputs }

/** A live run as the viewer captured it (served payloads, trimmed by S2): skeleton-001, skeleton-fixes-001, workflow-guardrails-001. */
async function capturedRun(name: string): Promise<CapturedRun> {
  return JSON.parse(await readFile(new URL(`../tests/unit/fixtures/runs/${name}.json`, import.meta.url), 'utf8')) as CapturedRun
}

/** The `events.jsonl` rows a captured run was served from: lane and freeze aliases undone, `blocked` back for failures and controller blocks. */
function rawEventsOf(run: CapturedRun): RawEvent[] {
  return run.events.map(event => {
    const node = event.node_id === null ? 'controller' : event.node_id === 'handoff' ? 'freeze' : event.node_id.startsWith('launch_') ? event.node_id.slice('launch_'.length) : event.node_id
    const status = event.status === 'failed' ? 'blocked' : event.status !== null ? event.status : event.node_id !== null ? 'stopped'
      : /^(?:Automatic checkpoint controller PID|Repair \d+ applied)/.test(event.message) ? 'running' : 'blocked'
    return { sequence: event.sequence, time: event.occurred_at, node, status, message: event.message }
  })
}

/** Projects a captured run's events onto its graph with no evidence at all, so each verification node's attempt comes from its events alone. */
function snapshotFromEvents(run: CapturedRun, raw: RawEvent[]) {
  const { summary, definition } = run.detail
  const scope = { project: { project_id: summary.project_id, name: 'Captured', repository: '/captured', workflows: [] }, workflow: { workflow_id: summary.workflow_id, runs_root: '/captured', definition } }
  const state = { version: '1.5.0', run_id: summary.run_id, base_commit: BASE, created_at: summary.created_at, updated_at: summary.updated_at,
    definition: { name: definition.name, nodes: definition.nodes }, values: {}, next: [], tasks: [], events: [], verification_packets: [], review: null, inputs: null }
  return projectSnapshot(scope as Parameters<typeof projectSnapshot>[0], definition, state as unknown as Parameters<typeof projectSnapshot>[2], raw, [], laneMap(run.inputs.selected_workers))
}

/** Every browser fixture run as the candidate phase seeds it, projected before B1: `node:status:attempt` in definition order. */
const SEEDED_SNAPSHOTS: Record<string, string> = {
  'feature-flow/run-awaiting': 'launch_ui:succeeded:1 launch_adapter:succeeded:1 handoff:succeeded:1 verify_ui:succeeded:1 verify_adapter:succeeded:1 candidate:succeeded:1 review:awaiting_approval:1 approval:pending:0 integrate:pending:0',
  'feature-flow/run-blocked': 'launch_ui:succeeded:1 launch_adapter:succeeded:1 handoff:succeeded:1 verify_ui:succeeded:1 verify_adapter:succeeded:1 candidate:succeeded:1 review:failed:1 approval:pending:0 integrate:pending:0',
  'feature-flow/run-succeeded': 'launch_ui:succeeded:1 launch_adapter:succeeded:1 handoff:succeeded:1 verify_ui:succeeded:1 verify_adapter:succeeded:1 candidate:succeeded:1 review:succeeded:1 approval:succeeded:1 integrate:succeeded:1',
  'feature-flow/run-failed': 'launch_ui:succeeded:1 launch_adapter:succeeded:1 handoff:succeeded:1 verify_ui:succeeded:1 verify_adapter:failed:1 candidate:pending:0 review:pending:0 approval:pending:0 integrate:pending:0',
  'feature-flow/run-legacy': 'launch_ui:succeeded:1 launch_adapter:succeeded:1 handoff:succeeded:1 verify_ui:succeeded:1 verify_adapter:succeeded:1 candidate:succeeded:1 review:succeeded:1 approval:succeeded:1 integrate:succeeded:1',
  'lanes-flow/run-one-lane': 'launch_docs:succeeded:1 handoff:succeeded:1 verify_docs:succeeded:1 candidate:succeeded:1 review:succeeded:1 approval:succeeded:1 integrate:succeeded:1',
  'lanes-flow/run-three-lanes': 'launch_ui:succeeded:1 launch_adapter:succeeded:1 launch_docs:succeeded:1 handoff:succeeded:1 verify_ui:succeeded:1 verify_adapter:succeeded:1 verify_docs:succeeded:1 candidate:succeeded:1 review:succeeded:1 approval:succeeded:1 integrate:succeeded:1',
  'reviewers-flow/run-legacy-reviewer': 'launch_ui:succeeded:1 launch_adapter:succeeded:1 handoff:succeeded:1 verify_ui:succeeded:1 verify_adapter:succeeded:1 candidate:succeeded:1 review:succeeded:1 approval:succeeded:1 integrate:succeeded:1',
  'reviewers-flow/run-reviewer-blocked': 'launch_ui:succeeded:1 launch_adapter:succeeded:1 handoff:succeeded:1 verify_ui:succeeded:1 verify_adapter:succeeded:1 candidate:succeeded:1 review:failed:1 approval:pending:0 integrate:pending:0',
  'reviewers-flow/run-two-reviewers': 'launch_ui:succeeded:1 launch_adapter:succeeded:1 handoff:succeeded:1 verify_ui:succeeded:1 verify_adapter:succeeded:1 candidate:succeeded:1 review:succeeded:1 approval:succeeded:1 integrate:succeeded:1',
  'clarity-flow/run-files-captured': 'launch_ui:succeeded:1 launch_adapter:succeeded:1 handoff:succeeded:1 verify_ui:succeeded:1 verify_adapter:succeeded:1 candidate:succeeded:1 review:succeeded:1 approval:succeeded:1 integrate:succeeded:1',
  'guarded-flow/run-guarded': 'challenge:succeeded:2 launch_ui:succeeded:1 launch_adapter:succeeded:1 handoff:succeeded:1 verify_ui:succeeded:1 verify_adapter:succeeded:1 candidate:succeeded:1 review:succeeded:1 approval:succeeded:1 integrate:succeeded:1',
  'guarded-flow/run-guarded-asking': 'challenge:succeeded:1 launch_ui:running:1 launch_adapter:running:1 handoff:pending:0 verify_ui:pending:0 verify_adapter:pending:0 candidate:pending:0 review:pending:0 approval:pending:0 integrate:pending:0',
  'guarded-flow/run-guarded-blocked': 'challenge:succeeded:1 launch_ui:running:1 launch_adapter:running:1 handoff:failed:1 verify_ui:pending:0 verify_adapter:pending:0 candidate:pending:0 review:pending:0 approval:pending:0 integrate:pending:0',
  'ux-time/run-short-check': 'launch_ui:succeeded:1 launch_adapter:succeeded:1 handoff:succeeded:1 verify_ui:succeeded:1 verify_adapter:failed:1 candidate:pending:0 review:pending:0 approval:pending:0 integrate:pending:0',
  // The review sidecar's node (docs/PRD_REVIEW_SIDECAR.md 4.8): its status from its events only, never a ledger branch.
  'ux-sidecar/review-sidecar-smoke-001': 'challenge:succeeded:1 sidecar:running:1 launch_engine:running:1 launch_viewer:running:1 handoff:pending:0 verify_engine:pending:0 verify_viewer:pending:0 candidate:pending:0 review:pending:0 approval:pending:0 integrate:pending:0',
  'ux-sidecar/review-sidecar-no-ledger': 'challenge:succeeded:1 sidecar:running:1 launch_engine:running:1 launch_viewer:running:1 handoff:pending:0 verify_engine:pending:0 verify_viewer:pending:0 candidate:pending:0 review:pending:0 approval:pending:0 integrate:pending:0',
  'ux-sidecar/review-sidecar-smoke-plain': 'challenge:succeeded:1 launch_engine:running:1 launch_viewer:running:1 handoff:pending:0 verify_engine:pending:0 verify_viewer:pending:0 candidate:pending:0 review:pending:0 approval:pending:0 integrate:pending:0',
  'ux-sidecar/review-sidecar-smoke-frozen': 'challenge:succeeded:1 sidecar:succeeded:1 launch_engine:succeeded:1 launch_viewer:succeeded:1 handoff:succeeded:1 verify_engine:running:1 verify_viewer:running:1 candidate:pending:0 review:pending:0 approval:pending:0 integrate:pending:0',
  'ux-sidecar/review-sidecar-one-lane': 'challenge:succeeded:1 sidecar:running:1 launch_engine:running:1 handoff:pending:0 verify_engine:pending:0 candidate:pending:0 review:pending:0 approval:pending:0 integrate:pending:0',
  'ux-sidecar/review-sidecar-one-lane-plain': 'challenge:succeeded:1 launch_engine:running:1 handoff:pending:0 verify_engine:pending:0 candidate:pending:0 review:pending:0 approval:pending:0 integrate:pending:0',
  'ux-sidecar/review-sidecar-blocked': 'challenge:succeeded:1 sidecar:succeeded:1 launch_engine:running:1 launch_viewer:running:1 handoff:failed:1 verify_engine:pending:0 verify_viewer:pending:0 candidate:pending:0 review:pending:0 approval:pending:0 integrate:pending:0',
  'ux-sidecar/review-sidecar-blocked-plain': 'challenge:succeeded:1 launch_engine:running:1 launch_viewer:running:1 handoff:failed:1 verify_engine:pending:0 verify_viewer:pending:0 candidate:pending:0 review:pending:0 approval:pending:0 integrate:pending:0',
  'ux-sidecar/review-sidecar-integrated': 'challenge:succeeded:1 sidecar:succeeded:1 launch_engine:succeeded:1 launch_viewer:succeeded:1 handoff:succeeded:1 verify_engine:succeeded:1 verify_viewer:succeeded:1 candidate:succeeded:1 review:succeeded:1 approval:succeeded:1 integrate:succeeded:1',
  'ux-sidecar/review-sidecar-integrated-plain': 'challenge:succeeded:1 launch_engine:succeeded:1 launch_viewer:succeeded:1 handoff:succeeded:1 verify_engine:succeeded:1 verify_viewer:succeeded:1 candidate:succeeded:1 review:succeeded:1 approval:succeeded:1 integrate:succeeded:1',
}

type SeededActivity = { feature: string | null; last: string; finished: string; focus: string; attention: string; waiting: number; headline: string }

/**
 * The activity each seeded browser fixture run serves, compacted: a time as `HH:MM` on the seeds' day, focus as
 * `node:status@since`, attention as `kind:node@since`, `-` for null. No seeded run has a PID row, so `controller` is null.
 */
const SEEDED_ACTIVITY: Record<string, SeededActivity> = (() => {
  const REVIEWS = 'Review visibility and run inputs in the viewer'
  const INTEGRATED = 'Integrate candidate · Fast-forwarded the feature branch'
  const DRILL = 'Verify adapter · Injected gate failure (failure drill); checks preserved'
  const SIDECAR_FEATURE = 'Review sidecar'
  const AWAITING = 'waiting for the worker\'s completion signal (idle is not acceptance)'
  const succeeded = (feature: string | null, at: string): SeededActivity => ({ feature, last: at, finished: at, focus: '-', attention: '-', waiting: 0, headline: INTEGRATED })
  return {
    'feature-flow/run-awaiting': { feature: REVIEWS, last: '10:45', finished: '-', focus: 'review:awaiting_approval@-', attention: 'approval:review@-', waiting: 0,
      headline: 'Independent review · Independent review required before integration' },
    'feature-flow/run-blocked': { feature: REVIEWS, last: '10:45', finished: '10:45', focus: 'review:failed@10:45', attention: 'failed:review@10:45', waiting: 0,
      headline: 'Independent review · Independent reviewer blocked the candidate' },
    'feature-flow/run-succeeded': succeeded(REVIEWS, '10:45'),
    'feature-flow/run-failed': { feature: REVIEWS, last: '10:20', finished: '10:20', focus: 'verify_adapter:failed@-', attention: 'failed:verify_adapter@-', waiting: 0, headline: DRILL },
    'feature-flow/run-legacy': succeeded(null, '10:20'),
    'lanes-flow/run-one-lane': succeeded('Worker lanes from configuration', '10:45'),
    'lanes-flow/run-three-lanes': succeeded('Worker lanes from configuration', '10:45'),
    'reviewers-flow/run-legacy-reviewer': succeeded('Parallel reviewers', '10:45'),
    'reviewers-flow/run-reviewer-blocked': { feature: 'Parallel reviewers', last: '10:45', finished: '10:45', focus: 'review:failed@10:45', attention: 'failed:review@10:45', waiting: 0,
      headline: 'Independent review · Reviewer coverage blocked the candidate; reviewer general was stopped and superseded' },
    'reviewers-flow/run-two-reviewers': succeeded('Parallel reviewers', '10:45'),
    'clarity-flow/run-files-captured': succeeded('Viewer clarity', '10:45'),
    'guarded-flow/run-guarded': succeeded('Workflow guardrails', '10:45'),
    'guarded-flow/run-guarded-asking': { feature: 'Workflow guardrails', last: '10:45', finished: '-', focus: 'launch_adapter:running@10:45', attention: 'question:launch_adapter@10:30', waiting: 1,
      headline: 'Launch adapter worker · Worker adapter asked question 2 of 3; its deadline is paused until `python -m workflow answer <path> adapter "<text>"`: Does a paused d…' },
    'guarded-flow/run-guarded-blocked': { feature: 'Workflow guardrails', last: '10:45', finished: '10:45', focus: 'handoff:failed@-', attention: 'failed:handoff@-', waiting: 0,
      headline: 'Freeze worker handoffs · Worker ui asked question 4; at most 3 are answered, so it is treated as blocked: Should the challenge page also show the concerns of e…' },
    'ux-time/run-short-check': { feature: null, last: '10:20', finished: '10:20', focus: 'verify_adapter:failed@-', attention: 'failed:verify_adapter@-', waiting: 0, headline: DRILL },
    // A run with a review sidecar reads like its twin without one: the sidecar's later rows, its running span and its
    // closing `succeeded` change no focus, last activity, finish, attention or headline.
    ...Object.fromEntries(['review-sidecar-smoke-001', 'review-sidecar-no-ledger', 'review-sidecar-smoke-plain'].map(run => [`ux-sidecar/${run}`, {
      feature: SIDECAR_FEATURE, last: '2026-10-01T11:58:21Z', finished: '-', focus: 'launch_viewer:running@2026-10-01T11:58:21Z', attention: '-', waiting: 0, headline: `Launch viewer worker · ${AWAITING}` }])),
    ...Object.fromEntries(['review-sidecar-one-lane', 'review-sidecar-one-lane-plain'].map(run => [`ux-sidecar/${run}`, {
      feature: SIDECAR_FEATURE, last: '2026-10-01T11:58:20Z', finished: '-', focus: 'launch_engine:running@2026-10-01T11:58:20Z', attention: '-', waiting: 0, headline: `Launch engine worker · ${AWAITING}` }])),
    ...Object.fromEntries(['review-sidecar-blocked', 'review-sidecar-blocked-plain'].map(run => [`ux-sidecar/${run}`, {
      feature: SIDECAR_FEATURE, last: '2026-10-01T16:00:00Z', finished: '2026-10-01T11:58:21Z', focus: 'handoff:failed@-', attention: 'failed:handoff@-', waiting: 0,
      headline: 'Freeze worker handoffs · Worker engine deadline exhausted; no automatic relaunch' }])),
    ...Object.fromEntries(['review-sidecar-integrated', 'review-sidecar-integrated-plain'].map(run => [`ux-sidecar/${run}`, {
      ...succeeded(SIDECAR_FEATURE, '2026-10-01T14:55:03Z'), headline: 'Integrate candidate · fast-forwarded to ccccccc · no push performed' }])),
    'ux-sidecar/review-sidecar-smoke-frozen': { feature: SIDECAR_FEATURE, last: '2026-10-01T14:26:05Z', finished: '-', focus: 'verify_engine:running@2026-10-01T14:26:05Z', attention: '-', waiting: 0,
      headline: 'Verify engine · attempt 1 started · revision e1e1e1e' },
  }
})()

/** Seeds every browser fixture run in a temporary root and projects each one; `visit` sees `workflow/run` and the loaded run. */
async function eachSeededRun(visit: (key: string, detail: RunDetail) => void) {
  const root = await mkdtemp(join(tmpdir(), 'md-manager-projects-seeded-'))
  try {
    const path = seedCandidate(root)
    const store = new RunStore(await parseProjectsConfig(await readFile(path, 'utf8'), path))
    for (const project of store.config.projects) for (const workflow of project.workflows) {
      const scope = store.scope(project.project_id, workflow.workflow_id)
      const summaries = await store.listRuns(scope)
      for (const summary of summaries) {
        const { detail } = await store.loadRun(scope, summary.run_id)
        assert.deepEqual(summary, detail.summary, `${workflow.workflow_id}/${summary.run_id}: the list serves the detail's summary`)
        visit(`${workflow.workflow_id}/${summary.run_id}`, detail)
      }
    }
  } finally { await rm(root, { recursive: true, force: true }) }
}

test('[B1] the design challenge\'s lower-case attempt phrases are read; the snapshot attempts of the captured runs and of every fixture are unchanged', async () => {
  const challenge = (events: WorkflowEvent[]) => events.filter(event => event.node_id === 'challenge').map(event => event.attempt)
  // "Design challenge attempt N" rows were all served as attempt 1 by the case-sensitive parser.
  const expected: Record<string, number[]> = { 'skeleton-001': [1, 2, 2, 2, 3, 3, 3], 'skeleton-fixes-001': [1, 1, 1, 1, 2, 2, 2], 'workflow-guardrails-001': [] }
  for (const [name, attempts] of Object.entries(expected)) {
    const run = await capturedRun(name)
    const raw = rawEventsOf(run)
    const served = normalizeEvents(run.detail.summary.run_id, run.detail.definition, raw, laneMap(run.inputs.selected_workers))
    assert.deepEqual(challenge(served), attempts, name)
    // Every other row keeps the attempt it was served with (the repair note on skeleton-001 #20 stays on its node's attempt 2, whatever it quotes).
    served.forEach((event, index) => {
      const before = run.events[index]
      if (event.node_id === before.node_id && event.node_id !== 'challenge') assert.equal(event.attempt, before.attempt, `${name} #${event.sequence}`)
    })
    // `projectSnapshot` reads message attempts only through `eventAttempt` and `Math.max` on verification nodes: from the events alone
    // they reach exactly the attempts the run was served with, so no packet attempt is ever raised.
    const snapshot = snapshotFromEvents(run, raw)
    for (const node of snapshot.nodes.filter(item => item.node_id.startsWith('verify_'))) {
      assert.equal(node.attempt, run.detail.snapshot.nodes.find(item => item.node_id === node.node_id)!.attempt, `${name} ${node.node_id}`)
    }
  }
  // Every browser fixture projects the statuses and attempts it projected before B1.
  const projected: Record<string, string> = {}
  await eachSeededRun((key, detail) => { projected[key] = detail.snapshot.nodes.map(node => `${node.node_id}:${node.status}:${node.attempt}`).join(' ') })
  for (const [key, nodes] of Object.entries(SEEDED_SNAPSHOTS)) assert.equal(projected[key], nodes, key)
})

test('[B1] a repair note\'s quoted attempts and reason are not its node\'s attempt; only the controller\'s own attempt phrases are', async () => {
  // A candidate-phase block in skeleton-001's graph, repaired as repair.py finish_repair records it: the note on `verify_game`
  // quotes every blocked packet ("Answers <phase>/<lane> attempt N") after the operator's free-text reason, and neither is
  // the attempt `verify_game` runs next (its packet and result are /2, from attempt_targets).
  const run = await capturedRun('skeleton-001')
  const note = 'Repair 1 by the operator: snapshot dddddddd = cccccccc + eeeeeeee on snapshot cccccccc (src/app.ts). '
    + 'Reason: Attempt 4 of the combined check and attempt 5 hit a flaky runner. '
    + 'Answers worker/game attempt 1: browser: failed tests. Answers candidate/game attempt 3: browser: failed tests. '
    + 'Continue with python -m workflow automatic <run>'
  const raw: RawEvent[] = [
    { sequence: 1, time: T0, node: 'verify_game', status: 'running', message: `Attempt 1; revision ${'c'.repeat(40)}` },
    { sequence: 2, time: T0, node: 'verify_game', status: 'succeeded', message: 'Required tests and artifacts passed; recorded for the candidate gate: browser' },
    { sequence: 3, time: T1, node: 'candidate_game', status: 'blocked', message: `Combined revision ${'e'.repeat(40)}` },
    { sequence: 4, time: T1, node: 'candidate_game', status: 'blocked', message: `Combined revision ${'e'.repeat(40)}` },
    { sequence: 5, time: T1, node: 'candidate_game', status: 'blocked', message: `Combined revision ${'e'.repeat(40)}` },
    { sequence: 6, time: T1, node: 'controller', status: 'blocked', message: 'candidate/game failed identically on attempts 2 and 3; not transient, inspect <path>' },
    { sequence: 7, time: T2, node: 'verify_game', status: 'paused', message: note },
    { sequence: 8, time: T2, node: 'candidate', status: 'paused', message: 'Repair 1 supersedes combined revision eeeeeeee; candidate-1 is built after the lanes re-verify' },
    { sequence: 9, time: T2, node: 'controller', status: 'running', message: 'Repair 1 applied: checkpoint forked from 1f1b7f90 (after handoff); attempts worker:game 2, candidate:game 4' },
    { sequence: 10, time: T2, node: 'verify_game', status: 'running', message: `Attempt 2; revision ${'d'.repeat(40)}` },
  ]
  const served = normalizeEvents(run.detail.summary.run_id, run.detail.definition, raw, laneMap(run.inputs.selected_workers))
  assert.deepEqual(served.filter(event => event.node_id === 'verify_game').map(event => [event.sequence, event.attempt]), [[1, 1], [2, 1], [7, 1], [10, 2]],
    'the repair note keeps the attempt its node was on')
  const verify = snapshotFromEvents(run, raw).nodes.find(node => node.node_id === 'verify_game')!
  assert.deepEqual([verify.status, verify.attempt], ['running', 2], 'verify_game runs attempt 2, never a quoted one')
  // The design challenge's own phrases still count, in the controller's lower case.
  const challenge = [
    { sequence: 1, time: T0, node: 'challenge', status: 'running', message: 'Design challenge attempt 1: one print job, session s1' },
    { sequence: 2, time: T0, node: 'challenge', status: 'running', message: 'Feature files re-pinned for design challenge attempt 2 on base aaaa' },
    { sequence: 3, time: T0, node: 'challenge', status: 'succeeded', message: 'Design challenge attempt 2 accepted by the operator: the reviewer on attempt 7 was wrong' },
  ]
  assert.deepEqual(normalizeEvents(run.detail.summary.run_id, run.detail.definition, challenge, laneMap(run.inputs.selected_workers)).map(event => event.attempt), [1, 2, 2])
})

test('[B1] on a lane named controller, PID and Errno rows belong to the run while the lane\'s own controller events stay on the lane', async () => {
  await harness(async ({ app, runsRoot }) => {
    const lanes = ['controller', 'ui']
    const inputs = inputsSection({ policy_version: '1.2.0', selected_workers: lanes, excluded_workers: [] })
    inputs.workers = { controller: laneInput('controller', 'backend', ['unit'], workerInput('adapter').checks, '# Controller worker\n\nHarden the controller.'), ui: workerInput('ui') }
    const events: RawEvent[] = [
      { sequence: 1, time: T0, node: 'controller', status: 'running', message: 'Launching or reconciling the exact native session' },
      { sequence: 2, time: T0, node: 'ui', status: 'running', message: 'Launching or reconciling the exact native session' },
      { sequence: 3, time: T1, node: 'controller', status: 'interactive', message: 'Awaiting explicit completion signal; idle is not acceptance' },
      { sequence: 4, time: T1, node: 'ui', status: 'interactive', message: 'Awaiting explicit completion signal; idle is not acceptance' },
      { sequence: 5, time: T1, node: 'controller', status: 'running', message: 'Automatic checkpoint controller PID 2088885' },
      { sequence: 6, time: T2, node: 'controller', status: 'blocked', message: '[Errno 2] No such file or directory: \'claude\'' },
    ]
    // No launch receipt was exported yet, so each lane's state comes from its own events.
    await writeRun(runsRoot('alpha', 'main'), { runId: 'lane', version: '1.3.0', definition: { name: 'Feature implementation', nodes: graphNodes(lanes) }, next: ['launch_controller', 'launch_ui'], events, inputs })
    const served = ((await get(app, url('alpha', 'main', 'lane', '/events'))).json() as { events: WorkflowEvent[] }).events
    assert.deepEqual(served.map(event => [event.sequence, event.node_id, event.status, event.type, event.attempt]), [
      [1, 'launch_controller', 'running', 'status_changed', 1], [2, 'launch_ui', 'running', 'status_changed', 1],
      [3, 'launch_controller', 'running', 'status_changed', 1], [4, 'launch_ui', 'running', 'status_changed', 1],
      [5, null, 'running', 'log', 0], [6, null, 'failed', 'log', 0]])
    const detail = validateRunDetail((await get(app, url('alpha', 'main', 'lane'))).json())
    assert.equal(detail.snapshot.nodes.find(node => node.node_id === 'launch_controller')!.status, 'running', 'the controller process\'s own error never fails the lane')
    assert.equal(detail.summary.status, 'running')
  })
})

test('[B1] on a lane named controller, the controller\'s resumable stops belong to the run, never pausing the lane', async () => {
  // automatic.py resumable_stop: drive stops before any step and records a `controller` `interrupted` row naming what comes
  // before `automatic --live`; on md-manager's own features a lane may be named `controller` too.
  await harness(async ({ app, runsRoot }) => {
    const lanes = ['controller', 'ui']
    const inputs = inputsSection({ policy_version: '1.2.0', selected_workers: lanes, excluded_workers: [] })
    inputs.workers = { controller: laneInput('controller', 'backend', ['unit'], workerInput('adapter').checks, '# Controller worker\n\nHarden the controller.'), ui: workerInput('ui') }
    const events: RawEvent[] = [
      { sequence: 1, time: T0, node: 'controller', status: 'running', message: 'Launching or reconciling the exact native session' },
      { sequence: 2, time: T0, node: 'ui', status: 'running', message: 'Launching or reconciling the exact native session' },
      { sequence: 3, time: T1, node: 'controller', status: 'interrupted', message: 'Source feature branch changed: /srv/repo is on feature/elsewhere, not feature/lane. Nothing was stopped or relaunched: switch it back with: git -C /srv/repo switch feature/lane, then resume with: python -m workflow automatic /srv/runs/lane --live' },
      { sequence: 4, time: T1, node: 'controller', status: 'running', message: 'Automatic checkpoint controller PID 2088885' },
      { sequence: 5, time: T2, node: 'controller', status: 'interrupted', message: 'Automatic supervision requires a completed start: launch_ui did not complete. Nothing was stopped or relaunched: inspect its receipt and `claude agents --json`, reconcile with: python -m workflow reconcile /srv/runs/lane, then resume with: python -m workflow automatic /srv/runs/lane --live' },
    ]
    await writeRun(runsRoot('alpha', 'main'), { runId: 'lane', version: '1.3.0', definition: { name: 'Feature implementation', nodes: graphNodes(lanes) }, next: ['launch_controller', 'launch_ui'], events, inputs })
    const served = ((await get(app, url('alpha', 'main', 'lane', '/events'))).json() as { events: WorkflowEvent[] }).events
    assert.deepEqual(served.map(event => [event.sequence, event.node_id, event.status, event.type]), [
      [1, 'launch_controller', 'running', 'status_changed'], [2, 'launch_ui', 'running', 'status_changed'],
      [3, null, 'paused', 'log'], [4, null, 'running', 'log'], [5, null, 'paused', 'log']])
    const detail = validateRunDetail((await get(app, url('alpha', 'main', 'lane'))).json())
    assert.equal(detail.snapshot.nodes.find(node => node.node_id === 'launch_controller')!.status, 'running', 'the controller\'s stop never pauses the lane')
  })
})

test('[B1] on a lane named controller, a Controller blocked row belongs to the run, never failing the lane', async () => {
  // automatic.py record_blocked: drive says why it stops before its non-retryable raise, as a `controller` `blocked` row that starts
  // `Controller blocked:`. On a lane named `controller` it would otherwise land on that lane's launch node.
  await harness(async ({ app, runsRoot }) => {
    const lanes = ['controller', 'ui']
    const inputs = inputsSection({ policy_version: '1.2.0', selected_workers: lanes, excluded_workers: [] })
    inputs.workers = { controller: laneInput('controller', 'backend', ['unit'], workerInput('adapter').checks, '# Controller worker\n\nHarden the controller.'), ui: workerInput('ui') }
    const blocked = 'Controller blocked: the review step failed: Independent reviewer blocked the candidate (review); not retried, inspect retained evidence'
    const events: RawEvent[] = [
      { sequence: 1, time: T0, node: 'controller', status: 'running', message: 'Launching or reconciling the exact native session' },
      { sequence: 2, time: T0, node: 'ui', status: 'running', message: 'Launching or reconciling the exact native session' },
      { sequence: 3, time: T1, node: 'controller', status: 'running', message: 'Automatic checkpoint controller PID 2088885' },
      { sequence: 4, time: T2, node: 'controller', status: 'blocked', message: blocked },
    ]
    await writeRun(runsRoot('alpha', 'main'), { runId: 'lane', version: '1.3.0', definition: { name: 'Feature implementation', nodes: graphNodes(lanes) }, next: ['launch_controller', 'launch_ui'], events, inputs })
    const served = ((await get(app, url('alpha', 'main', 'lane', '/events'))).json() as { events: WorkflowEvent[] }).events
    assert.deepEqual(served.map(event => [event.sequence, event.node_id, event.status, event.type]), [
      [1, 'launch_controller', 'running', 'status_changed'], [2, 'launch_ui', 'running', 'status_changed'],
      [3, null, 'running', 'log'], [4, null, 'failed', 'log']])
    assert.equal(served[3].message, blocked)
    const detail = validateRunDetail((await get(app, url('alpha', 'main', 'lane'))).json())
    assert.equal(detail.snapshot.nodes.find(node => node.node_id === 'launch_controller')!.status, 'running', 'the controller\'s stop never fails the lane')
  })
})

test('[C52] the controller drift warning is a node-less log row, on a lane named controller too, never failing or moving the lane', async () => {
  // automatic.py note_controller_drift writes a `controller` `warning` row before the step's PID row. `warning` is no event status,
  // so it is served without one; on a lane named `controller` it would otherwise land on that lane's launch node.
  await harness(async ({ app, runsRoot }) => {
    const lanes = ['controller', 'ui']
    const inputs = inputsSection({ policy_version: '1.2.0', selected_workers: lanes, excluded_workers: [] })
    inputs.workers = { controller: laneInput('controller', 'backend', ['unit'], workerInput('adapter').checks, '# Controller worker\n\nHarden the controller.'), ui: workerInput('ui') }
    const drift = `Controller commit ${'b'.repeat(12)} runs this step, not ${'a'.repeat(12)} pinned at prepare: the controller checkout moved during the run`
    const events: RawEvent[] = [
      { sequence: 1, time: T0, node: 'controller', status: 'running', message: 'Launching or reconciling the exact native session' },
      { sequence: 2, time: T0, node: 'ui', status: 'running', message: 'Launching or reconciling the exact native session' },
      { sequence: 3, time: T1, node: 'controller', status: 'warning', message: drift },
      { sequence: 4, time: T1, node: 'controller', status: 'running', message: 'Automatic checkpoint controller PID 2088885' },
    ]
    await writeRun(runsRoot('alpha', 'main'), { runId: 'lane', version: '1.3.0', definition: { name: 'Feature implementation', nodes: graphNodes(lanes) }, next: ['launch_controller', 'launch_ui'], events, inputs })
    const served = ((await get(app, url('alpha', 'main', 'lane', '/events'))).json() as { events: WorkflowEvent[] }).events
    assert.deepEqual(served.map(event => [event.sequence, event.node_id, event.status, event.type]), [
      [1, 'launch_controller', 'running', 'status_changed'], [2, 'launch_ui', 'running', 'status_changed'],
      [3, null, null, 'log'], [4, null, 'running', 'log']])
    const detail = validateRunDetail((await get(app, url('alpha', 'main', 'lane'))).json())
    assert.equal(detail.snapshot.nodes.find(node => node.node_id === 'launch_controller')!.status, 'running')
  })
})

test('[B1] on a lane named controller, prepare\'s launch notes belong to the run, never starting the lane', async () => {
  // pipeline.py prepare records the launch's notes (C23, C27) as one `controller` row, before any lane launches.
  const notes = 'Launch notes: Lane controller requires fewer checks than the policy of lane-000: required kind contract removed.'
  await harness(async ({ app, runsRoot }) => {
    const lanes = ['controller', 'ui']
    const inputs = inputsSection({ policy_version: '1.2.0', selected_workers: lanes, excluded_workers: [] })
    inputs.workers = { controller: laneInput('controller', 'backend', ['unit'], workerInput('adapter').checks, '# Controller worker\n\nHarden the controller.'), ui: workerInput('ui') }
    const events: RawEvent[] = [{ sequence: 1, time: T0, node: 'controller', status: 'running', message: notes }]
    await writeRun(runsRoot('alpha', 'main'), { runId: 'lane', version: '1.3.0', definition: { name: 'Feature implementation', nodes: graphNodes(lanes) }, next: ['launch_controller', 'launch_ui'], events, inputs })
    const served = ((await get(app, url('alpha', 'main', 'lane', '/events'))).json() as { events: WorkflowEvent[] }).events
    assert.deepEqual(served.map(event => [event.sequence, event.node_id, event.status, event.type]), [[1, null, 'running', 'log']])
    const detail = validateRunDetail((await get(app, url('alpha', 'main', 'lane'))).json())
    assert.equal(detail.snapshot.nodes.find(node => node.node_id === 'launch_controller')!.status, 'pending', 'the launch notes never start the lane')
  })
})

test('[B1] on a lane named controller, the stops said bare off the source branch belong to the run, never failing the lane', async () => {
  // automatic.py final_stop: off the source branch, a check that reached its attempt limit and workers stopped when their wait
  // failed are said as drive says them, without `Controller blocked: `. On a lane named `controller` each row would otherwise land on
  // that lane's launch node and fail it. The failed wait's own texts follow: wait_handoffs' (record_question's fourth question
  // among them) and read_signal's refusals.
  const stops = ['Verification retry limit exhausted; work and evidence retained', 'Handoff changed after stop intent', 'Invalid completion file for ui',
    'Worker ui deadline exhausted; no automatic relaunch', 'Worker ui explicitly blocked: the fixture is missing',
    'Worker ui asked a question that is not recorded yet: Which port?', 'Native worker missing; reconciliation required',
    'Worker ui asked question 4; at most 3 are answered, so it is treated as blocked: Which port?',
    'Malformed completion signal', 'Malformed completion signal: version 1.1.0 needs untested, falsifying_check, verify_yourself and question',
    'Stale or foreign worker completion signal', 'Invalid completion status/summary', 'Invalid completion evidence: untested must be a list of strings',
    'Invalid completion: status question needs a non-empty question', 'Completion version 1.1.0 refused: this run is pinned at completion 1.0.0']
  for (const stop of stops) {
    await harness(async ({ app, runsRoot }) => {
      const lanes = ['controller', 'ui']
      const inputs = inputsSection({ policy_version: '1.2.0', selected_workers: lanes, excluded_workers: [] })
      inputs.workers = { controller: laneInput('controller', 'backend', ['unit'], workerInput('adapter').checks, '# Controller worker\n\nHarden the controller.'), ui: workerInput('ui') }
      const events: RawEvent[] = [
        { sequence: 1, time: T0, node: 'controller', status: 'running', message: 'Launching or reconciling the exact native session' },
        { sequence: 2, time: T0, node: 'ui', status: 'running', message: 'Launching or reconciling the exact native session' },
        { sequence: 3, time: T1, node: 'controller', status: 'running', message: 'Automatic checkpoint controller PID 2088885' },
        { sequence: 4, time: T2, node: 'controller', status: 'blocked', message: stop },
      ]
      await writeRun(runsRoot('alpha', 'main'), { runId: 'lane', version: '1.3.0', definition: { name: 'Feature implementation', nodes: graphNodes(lanes) }, next: ['launch_controller', 'launch_ui'], events, inputs })
      const served = ((await get(app, url('alpha', 'main', 'lane', '/events'))).json() as { events: WorkflowEvent[] }).events
      assert.deepEqual(served.map(event => [event.sequence, event.node_id, event.status, event.type]), [
        [1, 'launch_controller', 'running', 'status_changed'], [2, 'launch_ui', 'running', 'status_changed'],
        [3, null, 'running', 'log'], [4, null, 'failed', 'log']], stop)
      assert.equal(served[3].message, stop)
      const detail = validateRunDetail((await get(app, url('alpha', 'main', 'lane'))).json())
      assert.equal(detail.snapshot.nodes.find(node => node.node_id === 'launch_controller')!.status, 'running', `${stop}: the controller's stop never fails the lane`)
    })
  }
})

test('[B1] on a lane named controller, a gate action\'s actor row (C17) and a tryout verdict (C7) belong to the run, never touching the lane', async () => {
  // pipeline.py action_event: `<Action> by the operator|maintainer…` as a `controller` row with the plain record status `note`, served with no status.
  await harness(async ({ app, runsRoot }) => {
    const lanes = ['controller', 'ui']
    const inputs = inputsSection({ policy_version: '1.2.0', selected_workers: lanes, excluded_workers: [] })
    inputs.workers = { controller: laneInput('controller', 'backend', ['unit'], workerInput('adapter').checks, '# Controller worker\n\nHarden the controller.'), ui: workerInput('ui') }
    const events: RawEvent[] = [
      { sequence: 1, time: T0, node: 'controller', status: 'note', message: 'Start by the operator (via a Claude Code session)' },
      { sequence: 2, time: T0, node: 'controller', status: 'running', message: 'Launching or reconciling the exact native session' },
      { sequence: 3, time: T0, node: 'ui', status: 'running', message: 'Launching or reconciling the exact native session' },
      { sequence: 4, time: T1, node: 'controller', status: 'interactive', message: 'Worker controller needs attention in its pane (native state blocked); waiting until its deadline' },
      { sequence: 5, time: T2, node: 'controller', status: 'note', message: 'Automatic by the maintainer: the supervisor continues the run' },
      // tryout.py (C7): the operator's verdict, the same plain record.
      { sequence: 6, time: T2, node: 'controller', status: 'note', message: 'Tryout recorded by the operator: works. Reload keeps the list.' },
    ]
    await writeRun(runsRoot('alpha', 'main'), { runId: 'lane', version: '1.3.0', definition: { name: 'Feature implementation', nodes: graphNodes(lanes) }, next: ['launch_controller', 'launch_ui'], events, inputs })
    const served = ((await get(app, url('alpha', 'main', 'lane', '/events'))).json() as { events: WorkflowEvent[] }).events
    assert.deepEqual(served.map(event => [event.sequence, event.node_id]), [[1, null], [2, 'launch_controller'], [3, 'launch_ui'], [4, 'launch_controller'], [5, null], [6, null]])
  })
})

test('[B1] candidate events name the lane whose combined check they report', async () => {
  await harness(async ({ app, runsRoot }) => {
    await writeRun(runsRoot('alpha', 'main'), { runId: 'combined', values: reviewedValues(), next: ['review'], events: reviewedEvents, packets: reviewedPackets })
    const served = ((await get(app, url('alpha', 'main', 'combined', '/events'))).json() as { events: WorkflowEvent[] }).events
    assert.deepEqual(served.filter(event => event.node_id === 'candidate').map(event => event.message), [`[ui] Combined revision ${OUTPUT}`, `[adapter] Combined revision ${OUTPUT}`])
    assert.ok(served.filter(event => event.node_id !== 'candidate').every(event => !event.message.startsWith('[')), 'only aliased candidate rows are prefixed')
  })
})

test('[B1] node-less controller rows keep their status: a deadline block is served failed and fails the handoff; a PID row is served running', async () => {
  await harness(async ({ app, runsRoot }) => {
    const events: RawEvent[] = [...launchEvents,
      { sequence: 5, time: T1, node: 'controller', status: 'running', message: 'Automatic checkpoint controller PID 3242976' },
      { sequence: 6, time: T2, node: 'controller', status: 'blocked', message: 'Worker ui deadline exhausted; no automatic relaunch' },
      { sequence: 7, time: T2, node: 'freeze', status: 'stopped', message: 'Native workers stopped before snapshot capture: ui, adapter' }]
    await writeRun(runsRoot('alpha', 'main'), { runId: 'deadline', values: { ui: receipt('ui'), adapter: receipt('adapter') }, next: ['handoff'], events, inputs: inputsSection(),
      tasks: [{ node_id: 'handoff', error: null, interrupts: [{ kind: 'worker_handoff', message: 'Awaiting explicit completion signals and automatic freeze.' }], result: null }] })
    const served = ((await get(app, url('alpha', 'main', 'deadline', '/events'))).json() as { events: WorkflowEvent[] }).events
    assert.deepEqual(served.slice(4).map(event => [event.node_id, event.status, event.type, event.attempt, event.message]), [
      [null, 'running', 'log', 0, 'Automatic checkpoint controller PID 3242976'],
      [null, 'failed', 'log', 0, 'Worker ui deadline exhausted; no automatic relaunch'],
      ['handoff', null, 'log', 1, 'Native workers stopped before snapshot capture: ui, adapter']])
    const detail = validateRunDetail((await get(app, url('alpha', 'main', 'deadline'))).json())
    assert.equal(detail.snapshot.nodes.find(node => node.node_id === 'handoff')!.status, 'failed')
    assert.equal(detail.summary.status, 'failed')
  })
})

/** A run waiting in the handoff interrupt for its workers' completion signals; `live` workers have no completion, handoff or stop yet. */
const waitingRun = { values: { ui: receipt('ui'), adapter: receipt('adapter') }, next: ['handoff'],
  tasks: [{ node_id: 'handoff', error: null, interrupts: [{ kind: 'worker_handoff', message: 'Awaiting explicit completion signals and automatic freeze.' }], result: null }] }
const liveWorker: Partial<WorkerInput> = { completion: null, handoff: null, stop: null }
const stoppedWorker: Partial<WorkerInput> = { stop: { stopped: true, confirmed_at: T1 } }

/** The activity a served run detail carries; its absence is the failure, not a TypeError further on. */
function activityOf(detail: RunDetail, what: string) {
  assert.ok(detail.summary.activity, `${what}: the run summary carries its activity`)
  return detail.summary.activity
}

test('[B2] a run summary carries its activity: feature, recency, focus, attention and headline; lists serve the same summary', async () => {
  await harness(async ({ app, runsRoot, root }) => {
    const rootDir = runsRoot('alpha', 'main')
    await writeRun(rootDir, { runId: 'fresh', next: ['launch_ui', 'launch_adapter'], updated: T0 })
    const integrated: RawEvent[] = [...reviewedEvents,
      { sequence: 10, time: T2, node: 'review', status: 'approved', message: REVIEWER },
      { sequence: 11, time: T2, node: 'integrate', status: 'succeeded', message: `Fast-forwarded to ${OUTPUT}; no push performed` }]
    await writeRun(rootDir, { runId: 'integrated', values: reviewedValues({ review: { verdict: 'approved' }, approved_bundle: BUNDLE, integrated_commit: OUTPUT }), next: [], events: integrated, updated: T2,
      packets: reviewedPackets, review: reviewSection(), inputs: inputsSection({}, { ui: stoppedWorker, adapter: stoppedWorker }), diffFile: DIFF })
    const failed: RawEvent[] = [...launchEvents,
      { sequence: 5, time: T1, node: 'freeze', status: 'succeeded', message: 'Immutable snapshots captured' },
      { sequence: 6, time: T1, node: 'verify_adapter', status: 'running', message: `Attempt 1; revision ${OUTPUT}` },
      { sequence: 7, time: T2, node: 'verify_adapter', status: 'blocked', message: `backend-unit: exit 1; see ${root}/runs/alpha/main/failed/verification/worker/adapter/1/packet.json` }]
    await writeRun(rootDir, { runId: 'failed', values: { ui: receipt('ui'), adapter: receipt('adapter'), snapshots }, next: ['verify_adapter'], events: failed,
      tasks: [{ node_id: 'verify_adapter', error: 'adapter verification blocked', interrupts: [], result: null }],
      packets: [{ node: 'adapter', gate: { status: 'blocked', reasons: ['backend-unit: exit 1'] } }], inputs: inputsSection({}, { ui: stoppedWorker, adapter: stoppedWorker }) })
    await writeRun(rootDir, { ...waitingRun, runId: 'approval', events: launchEvents, inputs: inputsSection({ mode: 'manual', automatic: null }, { ui: liveWorker, adapter: liveWorker }) })
    const interrupted = { sequence: 5, time: T2, node: 'controller', status: 'interrupted', message: `Supervisor interrupted. Native workers were NOT stopped and keep running; resume with: python -m workflow automatic ${root}/runs/alpha/main/interrupted --live` }
    await writeRun(rootDir, { ...waitingRun, runId: 'interrupted', events: [...launchEvents, interrupted], inputs: inputsSection({}, { ui: liveWorker, adapter: liveWorker }) })
    // `note` and `answer` need no controller: their plain records (raw status `note`) on a lane keep the interruption.
    const noted: RawEvent[] = [...launchEvents, { ...interrupted, message: interrupted.message.replace('/interrupted --live', '/noted --live') },
      { sequence: 6, time: T2, node: 'ui', status: 'note', message: 'Note N-1 from the operator to worker ui: undeliverable, not typed (lane_blocked)' },
      { sequence: 7, time: T2, node: 'adapter', status: 'note', message: 'Question 1 of adapter answered by the operator' },
      // A controller action row (C17) after the interruption is a plain record too: the run stays paused, its handoff waiting.
      { sequence: 8, time: T2, node: 'controller', status: 'note', message: 'Automatic by the operator: the supervisor continues the run' }]
    await writeRun(rootDir, { ...waitingRun, runId: 'noted', events: noted, inputs: inputsSection({}, { ui: liveWorker, adapter: liveWorker }) })
    await writeRun(rootDir, { runId: 'paused', values: { ui: receipt('ui'), adapter: receipt('adapter') }, next: [], events: [...launchEvents, { sequence: 5, time: T1, node: 'freeze', status: 'succeeded', message: 'Immutable snapshots captured' }] })

    const feature = 'Review verdict and findings in the viewer'
    const details = new Map<string, RunDetail>()
    for (const runId of ['fresh', 'integrated', 'failed', 'approval', 'interrupted', 'noted', 'paused']) {
      const detail = validateRunDetail((await get(app, url('alpha', 'main', runId))).json())
      assert.equal(detail.summary.contract_version, '1.5.0', runId)
      assert.equal(detail.run_dir, null, `${runId}: the temporary run roots are outside $HOME and the project is not listed`)
      details.set(runId, detail)
    }
    const activity = (runId: string) => activityOf(details.get(runId)!, runId)
    const none = { focus: null, attention: null, waiting_questions: 0, controller: null }
    assert.deepEqual(activity('fresh'), { ...none, feature: null, last_activity_at: null, finished_at: null, headline: null })
    // A finished run: the latest activity is its last step; with no focus the headline names the step that ended it.
    assert.deepEqual(activity('integrated'), { ...none, feature, last_activity_at: T2, finished_at: T2, headline: 'Integrate candidate · fast-forwarded to bbbbbbb · no push performed' })
    assert.deepEqual(activity('failed'), {
      ...none, feature, last_activity_at: T2, finished_at: T2, headline: 'Verify adapter · backend-unit: exit 1; see <path>',
      focus: { node_id: 'verify_adapter', label: 'Verify adapter', status: 'failed', since: T2 }, attention: { kind: 'failed', node_id: 'verify_adapter', since: T2 },
    })
    assert.deepEqual(activity('approval'), {
      ...none, feature, last_activity_at: T1, finished_at: null, headline: 'Freeze worker handoffs',
      focus: { node_id: 'handoff', label: 'Freeze worker handoffs', status: 'awaiting_approval', since: null }, attention: { kind: 'approval', node_id: 'handoff', since: null },
    })
    // The in-scope controller row is the headline (6.2 reason source 0), and the run waits on its controller.
    const stopped = activity('interrupted')!
    assert.deepEqual({ ...stopped, headline: null }, {
      ...none, feature, last_activity_at: T2, finished_at: null, headline: null,
      focus: { node_id: 'handoff', label: 'Freeze worker handoffs', status: 'paused', since: null }, attention: { kind: 'interrupted', node_id: 'handoff', since: T2 },
    })
    assert.match(stopped.headline!, /^Freeze worker handoffs · Supervisor interrupted\. Native workers were NOT stopped/)
    assert.ok(stopped.headline!.length <= 160 && !stopped.headline!.includes(root), stopped.headline!)
    const notedActivity = activity('noted')!
    assert.deepEqual({ focus: notedActivity.focus, attention: notedActivity.attention }, { focus: stopped.focus, attention: stopped.attention })
    const timeline = (await get(app, url('alpha', 'main', 'noted', '/events'))).json() as { events: { node_id: string | null; status: string | null; type: string }[] }
    assert.deepEqual(timeline.events.slice(-3).map(event => [event.node_id, event.status, event.type]),
      [['launch_ui', null, 'log'], ['launch_adapter', null, 'log'], [null, null, 'log']])
    assert.deepEqual(activity('paused'), {
      ...none, feature: null, last_activity_at: T1, finished_at: null, headline: 'Freeze worker handoffs · Immutable snapshots captured',
      focus: { node_id: 'handoff', label: 'Freeze worker handoffs', status: 'paused', since: T1 }, attention: { kind: 'paused', node_id: 'handoff', since: T1 },
    })
    const runs = projectSchemas.runList.parse((await get(app, url('alpha', 'main'))).json())
    for (const summary of runs.runs) assert.deepEqual(summary, details.get(summary.run_id)!.summary, summary.run_id)
  })
})

test('[B2] waiting questions come from the live <lane>.questions.json, which wins over a stale export', async () => {
  await harness(async ({ app, runsRoot }) => {
    const rootDir = runsRoot('alpha', 'main')
    const asked = { n: 1, question: 'Keep the seed on rematch, or reroll it?', asked_at: '2026-03-01T10:06:00+00:00', answer: null, answered_at: null }
    const answered = { ...asked, answer: 'Keep it.', answered_at: '2026-03-01T10:08:00+00:00' }
    const write = async (runId: string, exported: WorkerInput['questions'], live: string) => {
      const dir = await writeRun(rootDir, { ...waitingRun, runId, version: '1.5.0', events: launchEvents, inputs: inputsSection({}, { ui: { ...liveWorker, questions: exported }, adapter: liveWorker }) })
      await writeFile(join(dir, 'ui.questions.json'), live)
    }
    // run-state.json is not re-exported during the handoff wait: only the live file knows the question waits.
    await write('asking', [], json({ node_id: 'ui', questions: [asked] }))
    // The export still shows it waiting, but the operator has answered it since.
    await write('answered', [asked], json({ node_id: 'ui', questions: [answered] }))
    // A live file that is malformed or contradicts itself is not read: the export's record stands.
    await write('malformed', [asked], json({ node_id: 'ui', questions: [{ ...asked, n: 2 }] }))
    await write('unparsable', [asked], '{"node_id": "ui", "questions": [')
    const waiting = async (runId: string) => {
      const activity = activityOf(validateRunDetail((await get(app, url('alpha', 'main', runId))).json()), runId)
      return { waiting_questions: activity.waiting_questions, attention: activity.attention }
    }
    const question = { waiting_questions: 1, attention: { kind: 'question', node_id: 'launch_ui', since: '2026-03-01T10:06:00Z' } }
    assert.deepEqual(await waiting('asking'), question)
    assert.deepEqual(await waiting('answered'), { waiting_questions: 0, attention: null })
    assert.deepEqual(await waiting('malformed'), question)
    assert.deepEqual(await waiting('unparsable'), question)
    // The served inputs stay the export's record; only the run's activity reads the live file.
    assert.deepEqual(validateRunInputs((await get(app, url('alpha', 'main', 'asking', '/inputs'))).json()).workers[0].questions, [])
  })
})

test('[B2] a pane that needs attention is attention until any later event for its node', async () => {
  await harness(async ({ app, runsRoot }) => {
    const rootDir = runsRoot('alpha', 'main')
    const inputs = inputsSection({}, { ui: liveWorker, adapter: liveWorker })
    const pane: RawEvent = { sequence: 5, time: T2, node: 'ui', status: 'interactive', message: 'Worker ui needs attention in its pane (native state blocked); waiting until its deadline' }
    await writeRun(rootDir, { ...waitingRun, runId: 'pane', events: [...launchEvents, pane], inputs })
    await writeRun(rootDir, { ...waitingRun, runId: 'went-on', inputs, events: [...launchEvents, pane,
      { sequence: 6, time: T2, node: 'ui', status: 'interactive', message: 'Awaiting explicit completion signal; idle is not acceptance' }] })
    const reviewer: RawEvent = { sequence: 10, time: T2, node: 'review', status: 'interactive', message: 'Reviewer general needs attention in its pane (native state blocked); waiting until the deadline' }
    await writeRun(rootDir, { runId: 'reviewer', values: reviewedValues(), next: ['review'], events: [...reviewedEvents, reviewer], packets: reviewedPackets, inputs: inputsSection() })
    const attention = async (runId: string) => activityOf(validateRunDetail((await get(app, url('alpha', 'main', runId))).json()), runId).attention
    assert.deepEqual(await attention('pane'), { kind: 'pane', node_id: 'launch_ui', since: T2 })
    assert.equal(await attention('went-on'), null)
    assert.deepEqual(await attention('reviewer'), { kind: 'pane', node_id: 'review', since: T2 })
  })
})

/** A fake `/proc`: `self/stat`, `btime` in `stat`, and optionally one process with its `cmdline` and `stat` (field 22: start ticks since boot). */
async function fakeProc(root: string, name: string, child?: { pid: number; argv: string[]; startedAt: string }, readable = true): Promise<string> {
  const proc = join(root, name)
  const boot = Date.parse(T0) / 1000 - 3600
  await mkdir(proc, { recursive: true })
  if (readable) {
    await mkdir(join(proc, 'self'))
    await writeFile(join(proc, 'self', 'stat'), '1 (node) S 0')
    await writeFile(join(proc, 'stat'), `cpu  1 2 3 4\nbtime ${boot}\nprocesses 7\n`)
  }
  if (child) {
    const dir = join(proc, String(child.pid))
    await mkdir(dir)
    await writeFile(join(dir, 'cmdline'), `${child.argv.join('\0')}\0`)
    const ticks = Math.round((Date.parse(child.startedAt) / 1000 - boot) * 100)
    // The command name may hold spaces and parentheses; the fields after it are counted from its closing parenthesis.
    const fields = [String(child.pid), '(python3 (step))', 'S', ...Array.from({ length: 18 }, (_, index) => String(index + 1)), String(ticks), '0', '0']
    await writeFile(join(dir, 'stat'), fields.join(' '))
  }
  return proc
}

test('[B2] controller liveness: this run\'s automatic-step, started by its PID row, is running; a gone or reused PID is not; anything unclear is unknown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'md-manager-projects-proc-'))
  try {
    const runsRoot = join(root, 'runs', 'alpha', 'main')
    await mkdir(runsRoot, { recursive: true })
    const config = await parseProjectsConfig(JSON.stringify(registry(root, [{ id: 'alpha', workflows: [{ id: 'main' }] }])), 'test registry')
    const pid = 4242
    const pidRow = (sequence: number, controller = pid): RawEvent => ({ sequence, time: T1, node: 'controller', status: 'running', message: `Automatic checkpoint controller PID ${controller}` })
    const inputs = inputsSection({}, { ui: liveWorker, adapter: liveWorker })
    const liveDir = await writeRun(runsRoot, { ...waitingRun, runId: 'live', events: [...launchEvents, pidRow(5)], inputs })
    const otherDir = await writeRun(runsRoot, { ...waitingRun, runId: 'other', events: [...launchEvents, pidRow(5, 4343)], inputs })
    // A manual run records no PID row; a finished run's controller is not asked about.
    await writeRun(runsRoot, { runId: 'manual', values: { ui: receipt('ui'), adapter: receipt('adapter'), snapshots }, next: ['verify_ui'],
      events: [...launchEvents, { sequence: 5, time: T1, node: 'freeze', status: 'succeeded', message: 'Immutable snapshots captured' }, { sequence: 6, time: T2, node: 'verify_ui', status: 'running', message: `Attempt 1; revision ${OUTPUT}` }],
      inputs: inputsSection({ mode: 'manual', automatic: null }) })
    await writeRun(runsRoot, { ...waitingRun, runId: 'blocked', inputs, events: [...launchEvents, pidRow(5), { sequence: 6, time: T2, node: 'controller', status: 'blocked', message: 'Worker ui deadline exhausted; no automatic relaunch' }] })
    const step = (dir: string) => ['/home/you/dev/md-manager/.venv/bin/python', '-m', 'workflow', 'automatic-step', dir, '--live']
    const started = (at: string) => ({ pid, argv: step(liveDir), startedAt: at })
    const running = await fakeProc(root, 'proc-running', started('2026-03-01T10:04:30Z'))
    const cases: [string, string][] = [
      ['running', running],
      // Clock ticks are coarse: a start within a second after the row is still the process that logged it.
      ['running', await fakeProc(root, 'proc-tolerance', started('2026-03-01T10:05:00.900Z'))],
      ['not_running', await fakeProc(root, 'proc-gone')],
      ['not_running', await fakeProc(root, 'proc-reused', { pid, argv: ['/usr/bin/vim', 'notes.md'], startedAt: '2026-03-01T10:30:00Z' })],
      ['not_running', await fakeProc(root, 'proc-other-run', { pid, argv: step(otherDir), startedAt: '2026-03-01T10:04:00Z' })],
      ['unknown', await fakeProc(root, 'proc-later', started('2026-03-01T10:05:02Z'))],
      ['unknown', await fakeProc(root, 'proc-missing', started('2026-03-01T10:04:30Z'), false)],
    ]
    for (const [expected, procRoot] of cases) {
      const store = new RunStore(config, { procRoot })
      const scope = store.scope('alpha', 'main')
      assert.equal(activityOf((await store.loadRun(scope, 'live')).detail, procRoot).controller, expected, procRoot)
      assert.equal((await store.listRuns(scope)).find(summary => summary.run_id === 'live')!.activity?.controller, expected, `${procRoot} (list)`)
    }
    const store = new RunStore(config, { procRoot: running })
    const scope = store.scope('alpha', 'main')
    assert.equal((await store.loadRun(scope, 'manual')).detail.summary.status, 'running')
    assert.equal((await store.loadRun(scope, 'manual')).detail.summary.activity!.controller, null)
    assert.equal((await store.loadRun(scope, 'blocked')).detail.summary.status, 'failed')
    assert.equal((await store.loadRun(scope, 'blocked')).detail.summary.activity!.controller, null)
    // The real /proc: this test's own PID runs no automatic-step, so a row naming it is a reused PID, never a live controller.
    if (existsSync('/proc/self/stat')) {
      await writeRun(runsRoot, { ...waitingRun, runId: 'reused', events: [...launchEvents, pidRow(5, process.pid)], inputs })
      assert.equal((await new RunStore(config).loadRun(scope, 'reused')).detail.summary.activity!.controller, 'not_running')
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('[B2] every browser fixture run serves a 1.5.0 summary whose activity names what it waits on', async () => {
  const at = (value: string | null | undefined) => value ? value.replace(/^2026-03-01T(\d\d:\d\d):00Z$/, '$1') : '-'
  const seen: Record<string, SeededActivity> = {}
  await eachSeededRun((key, detail) => {
    assert.equal(detail.summary.contract_version, '1.5.0', key)
    const activity = activityOf(detail, key)
    assert.ok(activity.headline === null || activity.headline.length <= 160, key)
    // A seeded PID row (the ux-run fixtures log them) never names this run's own automatic-step: not_running, else null.
    assert.ok(activity.controller === null || activity.controller === 'not_running', `${key}: controller ${activity.controller}`)
    const { focus, attention } = activity
    seen[key] = { feature: activity.feature, last: at(activity.last_activity_at), finished: at(activity.finished_at),
      focus: focus ? `${focus.node_id}:${focus.status}@${at(focus.since)}` : '-', attention: attention ? `${attention.kind}:${attention.node_id ?? '-'}@${at(attention.since)}` : '-',
      waiting: activity.waiting_questions, headline: activity.headline ?? '-' }
  })
  for (const [key, expected] of Object.entries(SEEDED_ACTIVITY)) assert.deepEqual(seen[key], expected, key)
})

test('[B3] run_dir is served with ~ only for projects listed in viewer.expose_run_dir and only under $HOME', async () => {
  const root = await mkdtemp(join(tmpdir(), 'md-manager-projects-rundir-'))
  try {
    const projects = [{ id: 'alpha', workflows: [{ id: 'main' }] }, { id: 'beta', workflows: [{ id: 'main' }] }, { id: 'gamma', workflows: [{ id: 'spaced', runsRoot: join(root, 'runs with space') }] }]
    for (const runsRoot of [join(root, 'runs', 'alpha', 'main'), join(root, 'runs', 'beta', 'main'), join(root, 'runs with space')]) {
      await mkdir(runsRoot, { recursive: true })
      await writeRun(runsRoot, { runId: 'r1', next: ['launch_ui', 'launch_adapter'] })
    }
    await symlink(root, join(root, 'home-link'))
    const config = await parseProjectsConfig(JSON.stringify({ ...registry(root, projects), viewer: { expose_run_dir: ['alpha', 'gamma'] } }), 'viewer registry')
    const runDir = async (options: RunStoreOptions, project: string, workflow = 'main') => {
      const store = new RunStore(config, options)
      return (await store.loadRun(store.scope(project, workflow), 'r1')).detail.run_dir
    }
    // With the temporary root as the viewer's home, a listed project's runs are served home-relative; an unlisted project's never are.
    assert.equal(await runDir({ home: root }, 'alpha'), '~/runs/alpha/main/r1')
    assert.equal(await runDir({ home: join(root, 'home-link') }, 'alpha'), '~/runs/alpha/main/r1', 'home and run directory compare by realpath')
    assert.equal(await runDir({ home: root }, 'beta'), null)
    // A path the shell would split is not paste-ready.
    assert.equal(await runDir({ home: root }, 'gamma', 'spaced'), null)
    // Outside $HOME (the temporary roots) nothing is served, listed or not.
    if (!root.startsWith(`${homedir()}/`)) assert.equal(await runDir({}, 'alpha'), null)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('[B3] the registry accepts a top-level viewer key and keeps it across reloads; unknown keys are still refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'md-manager-projects-viewer-'))
  try {
    const runsRoot = join(root, 'runs', 'alpha', 'main')
    await mkdir(runsRoot, { recursive: true })
    await writeRun(runsRoot, { runId: 'r1', next: ['launch_ui', 'launch_adapter'] })
    const base = registry(root, [{ id: 'alpha', workflows: [{ id: 'main' }] }])
    // A project that a later launch registers may be listed ahead of time.
    const loaded = await parseProjectsConfig(JSON.stringify({ ...base, viewer: { expose_run_dir: ['alpha', 'not-registered-yet'] } }), 'viewer')
    assert.deepEqual(loaded.viewer, { expose_run_dir: ['alpha', 'not-registered-yet'] })
    assert.deepEqual(assertProjectsConfig(loaded).viewer, loaded.viewer, 're-validating a built registry keeps the key')
    const refused: [string, unknown][] = [
      ['unknown top-level key', { ...base, viewers: { expose_run_dir: [] } }],
      ['unknown viewer key', { ...base, viewer: { expose_run_dir: [], show_paths: true } }],
      ['a path instead of a project ID', { ...base, viewer: { expose_run_dir: ['/home/you/state'] } }],
      ['a list instead of an object', { ...base, viewer: ['alpha'] }],
    ]
    for (const [label, config] of refused) await assert.rejects(parseProjectsConfig(JSON.stringify(config), label), ProjectsConfigError, label)
    // The operator adds the key while the viewer runs: the next request serves the run directory.
    const path = join(root, 'projects.json')
    await writeFile(path, JSON.stringify(base))
    const store = new RunStore(await parseProjectsConfig(JSON.stringify(base), path), { home: root, refresh: projectsConfigReloader(path) })
    const runDir = async () => {
      await store.sync()
      return (await store.loadRun(store.scope('alpha', 'main'), 'r1')).detail.run_dir
    }
    assert.equal(await runDir(), null)
    await writeFile(path, JSON.stringify({ ...base, viewer: { expose_run_dir: ['alpha'] } }))
    assert.equal(await runDir(), '~/runs/alpha/main/r1')
    // Through the app, a reloaded registry with the key still serves (outside $HOME the directory itself stays null).
    const app = createApp([], { projects: await parseProjectsConfig(JSON.stringify(base), path), refreshProjects: projectsConfigReloader(path) })
    try {
      const detail = validateRunDetail((await get(app, url('alpha', 'main', 'r1'))).json())
      if (!root.startsWith(`${homedir()}/`)) assert.equal(detail.run_dir, null)
    } finally { await app.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

// ---- Review sidecar (docs/PRD_REVIEW_SIDECAR.md 4.7, 4.8 and section 6): export 1.6.0, the live ledger and the node ----

/** The ledger of Appendix B, read from the PRD itself: the bytes both lanes build to. */
async function appendixB(): Promise<string> {
  const prd = await readFile(new URL('../docs/PRD_REVIEW_SIDECAR.md', import.meta.url), 'utf8')
  const block = /```json\n([\s\S]*?)\n```/.exec(prd.slice(prd.indexOf('## Appendix B')))
  assert.ok(block, 'Appendix B holds a JSON block')
  return block[1]
}
const ledgerOf = async (overrides: Record<string, unknown> = {}) => ({ ...JSON.parse(await appendixB()) as Record<string, unknown>, ...overrides })
const SIDECAR_RUN = 'review-sidecar-smoke-001'
/** A guarded graph with the sidecar right after the challenge, before every launch node; the handoff depends on it last. */
const SIDECAR_NODES = [
  { node_id: 'challenge', label: 'Design challenge', kind: 'review', depends_on: [] },
  { node_id: 'sidecar', label: 'Review sidecar', kind: 'review', depends_on: ['challenge'] },
  ...GRAPH_NODES.map(node => node.kind === 'worker' ? { ...node, depends_on: ['challenge'] } : node.node_id === 'handoff' ? { ...node, depends_on: [...node.depends_on, 'sidecar'] } : node),
] as typeof GRAPH_NODES
const SIDECAR_DEFINITION = { name: 'Feature implementation', nodes: SIDECAR_NODES }
const sidecarRow = (sequence: number, status: string, message: string, time = T1): RawEvent => ({ sequence, time, node: 'sidecar', status, message })
const sidecarRun = (spec: Partial<RunSpec> = {}): RunSpec => ({
  runId: SIDECAR_RUN, version: '1.6.0', definition: SIDECAR_DEFINITION, values: { ui: receipt('ui'), adapter: receipt('adapter') }, next: ['handoff'],
  tasks: [{ node_id: 'handoff', error: null, interrupts: [{ kind: 'worker_handoff' }], result: null }],
  events: [...launchEvents.slice(0, 2), sidecarRow(3, 'running', 'pass 1 (cadence) started')], ...spec,
})
const sidecarRoute = (run = SIDECAR_RUN) => url('alpha', 'main', run, '/sidecar')
const nodeStatus = (detail: RunDetail, nodeId: string) => detail.snapshot.nodes.find(node => node.node_id === nodeId)?.status

test('[sidecar] a 1.6.0 export loads with a sidecar section, without one, and with a garbage one; the run list keeps every run', async () => {
  await harness(async ({ app, runsRoot }) => {
    const root = runsRoot('alpha', 'main')
    await writeRun(root, sidecarRun({ sidecar: await ledgerOf() }))
    await writeRun(root, { runId: 'sidecar-null', version: '1.6.0', sidecar: null, values: { ui: receipt('ui') }, next: ['launch_adapter'], events: launchEvents.slice(0, 2) })
    await writeRun(root, { runId: 'sidecar-absent', version: '1.6.0', values: { ui: receipt('ui') }, next: ['launch_adapter'], events: launchEvents.slice(0, 2) })
    for (const [runId, garbage] of [['sidecar-garbage', { passes: 'many', findings: [{ id: 7 }] }], ['sidecar-string', 'not a ledger'], ['sidecar-array', [1, 2, 3]]] as const) {
      await writeRun(root, sidecarRun({ runId, sidecar: garbage }))
    }
    const list = projectSchemas.runList.parse((await get(app, url('alpha', 'main'))).json())
    assert.deepEqual(list.runs.map(run => run.run_id).sort(), [SIDECAR_RUN, 'sidecar-absent', 'sidecar-array', 'sidecar-garbage', 'sidecar-null', 'sidecar-string'].sort())
    for (const run of list.runs) assert.equal((await get(app, url('alpha', 'main', run.run_id))).status, 200, run.run_id)
    // The export section is served when no live file exists; a garbage section is "not recorded", never a failed run.
    const served = validateSidecarLedger((await get(app, sidecarRoute())).json())
    assert.equal(served.source, 'export')
    assert.equal(served.passes.length, 3)
    for (const runId of ['sidecar-null', 'sidecar-absent', 'sidecar-garbage', 'sidecar-string', 'sidecar-array']) assertError(await get(app, sidecarRoute(runId)), 404, 'SIDECAR_NOT_FOUND')
  })
})

test('[sidecar] a 1.5.0 export, and a run whose graph has no sidecar node, still load and answer SIDECAR_NOT_FOUND', async () => {
  await harness(async ({ app, runsRoot }) => {
    const root = runsRoot('alpha', 'main')
    await writeRun(root, { runId: 'guarded-150', version: '1.5.0', values: { ui: receipt('ui') }, next: ['launch_adapter'], events: launchEvents.slice(0, 2) })
    // A live ledger beside a run whose pinned graph has no sidecar node is not this run's: never served.
    await writeRun(root, { runId: 'no-node', version: '1.6.0', sidecar: null, values: { ui: receipt('ui') }, next: ['launch_adapter'], events: launchEvents.slice(0, 2),
      liveLedger: JSON.stringify(await ledgerOf({ run_id: 'no-node' })) })
    for (const runId of ['guarded-150', 'no-node']) {
      assert.equal((await get(app, url('alpha', 'main', runId))).status, 200)
      assertError(await get(app, sidecarRoute(runId)), 404, 'SIDECAR_NOT_FOUND')
    }
  })
})

test('[sidecar] the live ledger wins over the export; a malformed, invalid, oversized or foreign live file falls back to the export, with the reason logged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'md-manager-projects-sidecar-'))
  try {
    const runsRoot = join(root, 'runs')
    await mkdir(runsRoot, { recursive: true })
    const config = await parseProjectsConfig(JSON.stringify({ version: 1, projects: [{ project_id: 'alpha', name: 'Alpha', repository: join(root, 'repo'), workflows: [{ workflow_id: 'main', runs_root: runsRoot, definition: DEFINITION }] }] }), 'test registry')
    const warnings: string[] = []
    const store = new RunStore(config, { warn: (message, details) => warnings.push(`${message} ${JSON.stringify(details)}`) })
    const scope = store.scope('alpha', 'main')
    const exported = await ledgerOf()
    const live = await ledgerOf()
    ;(live.passes as unknown[]).push({ n: 4, trigger: 'cadence', started_at: '2026-10-01T13:15:00Z', finished_at: '2026-10-01T13:16:00Z', status: 'failed', session_id: null,
      lanes: { engine: { head_commit: 'c0ffee1', pane_captured: false } }, counts: { new: 0, changed: 0, messages: 0 }, summary: 'CalledProcessError: herdr pane read exited 1' })
    // Model-written text may name a path: the route serves it redacted, like every other run text.
    ;(live.findings as { evidence: string }[])[0].evidence = `pane: 'fixed in ${join(root, 'worktree-engine', 'workflow', 'sidecar.py')}'`
    const cases: [string, string | null, 'live' | 'export', number][] = [
      ['live-newer', JSON.stringify(live), 'live', 4],
      ['live-malformed', '{"version": "1.0.0", "passes": [', 'export', 3],
      ['live-invalid', JSON.stringify({ ...live, findings: [{ id: 'S-1' }] }), 'export', 3],
      ['live-foreign', JSON.stringify({ ...live, run_id: 'another-run' }), 'export', 3],
      // The live ledger has its own 4 MiB cap (the engine bounds the file at 4 MiB), not the 256 KiB of a question record:
      // a file of 3 MiB is served live, one over 4 MiB falls back to the export.
      ['live-large', JSON.stringify({ ...live, padding: 'x'.repeat(3 * 1024 * 1024) }), 'live', 4],
      ['live-oversized', JSON.stringify({ ...live, padding: 'x'.repeat(4 * 1024 * 1024) }), 'export', 3],
      ['live-absent', null, 'export', 3],
    ]
    assert.equal(SIDECAR_LEDGER_BYTE_LIMIT, 4 * 1024 * 1024)
    const large = cases.find(([runId]) => runId === 'live-large')![1]!
    assert.ok(Buffer.byteLength(large) > 256 * 1024 && Buffer.byteLength(large) < SIDECAR_LEDGER_BYTE_LIMIT, 'live-large sits between the questions cap and the ledger cap')
    for (const [runId, file, source, passes] of cases) {
      await writeRun(runsRoot, sidecarRun({ runId, sidecar: { ...exported, run_id: runId }, ...(file === null ? {} : { liveLedger: file.replace(/"review-sidecar-smoke-001"/, `"${runId}"`) }) }))
      warnings.length = 0
      const ledger = validateSidecarLedger(await store.sidecarLedger(scope, runId))
      assert.equal(ledger.source, source, runId)
      assert.equal(ledger.passes.length, passes, runId)
      assert.equal(ledger.run_id, runId)
      assert.equal(ledger.node_id, 'sidecar')
      if (source === 'export' && file !== null) assert.ok(warnings.some(warning => warning.includes(runId) && /sidecar/i.test(warning)), `${runId}: the reason is logged (${warnings.join(' | ')})`)
    }
    const redacted = validateSidecarLedger(await store.sidecarLedger(scope, 'live-newer'))
    assert.equal(redacted.findings[0].evidence, `pane: 'fixed in <path>'`)
    assert.ok(!JSON.stringify(redacted).includes(root))
    // Neither readable: not recorded, never an error page or a failed run.
    await writeRun(runsRoot, sidecarRun({ runId: 'both-invalid', sidecar: { broken: true }, liveLedger: 'not json' }))
    await assert.rejects(store.sidecarLedger(scope, 'both-invalid'), (error: { status: number; code: string }) => error.status === 404 && error.code === 'SIDECAR_NOT_FOUND')
    validateRunDetail((await store.loadRun(scope, 'both-invalid')).detail)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('[sidecar] the node\'s status comes from its events only: none is pending, running and interactive are running, succeeded is succeeded', async () => {
  await harness(async ({ app, runsRoot }) => {
    const root = runsRoot('alpha', 'main')
    const cases: [string, RawEvent[], string][] = [
      ['no-event', launchEvents.slice(0, 2), 'pending'],
      ['running', [...launchEvents.slice(0, 2), sidecarRow(3, 'running', 'pass 1 (cadence) started')], 'running'],
      ['interactive', [...launchEvents.slice(0, 2), sidecarRow(3, 'running', 'pass 1 (cadence) started'), sidecarRow(4, 'interactive', 'escalation S-1 (security): see the sidecar page')], 'running'],
      ['succeeded', [...launchEvents.slice(0, 2), sidecarRow(3, 'running', 'pass 1 (cadence) started'), sidecarRow(4, 'succeeded', 'closed at freeze after 1 pass')], 'succeeded'],
    ]
    for (const [runId, events, status] of cases) {
      // A garbage ledger never moves the node: its status is its events'.
      await writeRun(root, sidecarRun({ runId, events, sidecar: { closed_at: 'never' }, liveLedger: '{}' }))
      const detail = validateRunDetail((await get(app, url('alpha', 'main', runId))).json())
      assert.equal(nodeStatus(detail, 'sidecar'), status, runId)
      assert.equal(detail.snapshot.nodes.find(node => node.node_id === 'sidecar')?.kind, 'review')
      // The sidecar never decides the run: the same run without its events has the same status.
      assert.equal(detail.summary.status, validateRunDetail((await get(app, url('alpha', 'main', 'no-event'))).json()).summary.status, runId)
    }
  })
})

test('[sidecar] an integrated run whose sidecar succeeded at freeze is succeeded, never paused', async () => {
  await harness(async ({ app, runsRoot }) => {
    const events: RawEvent[] = [{ sequence: 0, time: T0, node: 'challenge', status: 'succeeded', message: 'Design challenge attempt 1 passed (0 P2 concern(s)); launching workers' }, ...reviewedEvents.map(event => ({ ...event }))]
    const frozenAt = events.findIndex(event => event.node === 'freeze')
    events.splice(frozenAt, 0, { sequence: 0, time: T1, node: 'sidecar', status: 'running', message: 'pass 1 (cadence) started' }, { sequence: 0, time: T1, node: 'sidecar', status: 'succeeded', message: 'closed at freeze after 1 pass' })
    events.push({ sequence: 0, time: T2, node: 'integrate', status: 'succeeded', message: `Fast-forwarded to ${'c'.repeat(40)}; no push performed` })
    events.forEach((event, index) => { event.sequence = index + 1 })
    await writeRun(runsRoot('alpha', 'main'), {
      runId: 'integrated', version: '1.6.0', definition: SIDECAR_DEFINITION, sidecar: { ...(await ledgerOf({ run_id: 'integrated', closed_at: T1 })) },
      values: reviewedValues({ review: { verdict: 'approved' }, approved_bundle: BUNDLE, integrated_commit: 'c'.repeat(40) }), next: [], events, packets: reviewedPackets,
      review: reviewSection(), inputs: inputsSection(),
    })
    const detail = validateRunDetail((await get(app, url('alpha', 'main', 'integrated'))).json())
    assert.equal(nodeStatus(detail, 'sidecar'), 'succeeded')
    assert.equal(detail.summary.status, 'succeeded')
    assert.equal(detail.summary.activity?.focus, null)
  })
})

test('[sidecar] the sidecar route is read-only: other methods are 405, HEAD works, nothing is written', async () => {
  await harness(async ({ app, runsRoot }) => {
    await writeRun(runsRoot('alpha', 'main'), sidecarRun({ sidecar: await ledgerOf(), liveLedger: await appendixB() }))
    const before = await snapshotTree(runsRoot('alpha', 'main'))
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const) {
      const response = await app.inject({ method, url: sidecarRoute(), payload: method === 'OPTIONS' ? undefined : { relay: 'M-1' } })
      assert.equal(response.statusCode, 405, method)
      assert.equal(response.headers.allow, 'GET, HEAD')
      assert.equal(response.json().error.code, 'METHOD_NOT_ALLOWED')
    }
    assert.equal((await app.inject({ method: 'HEAD', url: sidecarRoute() })).statusCode, 200)
    const response = await get(app, sidecarRoute())
    assert.equal(response.status, 200)
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.deepEqual(await snapshotTree(runsRoot('alpha', 'main')), before)
  })
})

test('[sidecar] the Appendix B example validates verbatim: written live, it is served field for field', async () => {
  await harness(async ({ app, runsRoot }) => {
    const text = await appendixB()
    await writeRun(runsRoot('alpha', 'main'), sidecarRun({ sidecar: null, liveLedger: text }))
    const served = validateSidecarLedger((await get(app, sidecarRoute())).json())
    const { contract_version, node_id, source, ...ledger } = served
    assert.deepEqual([contract_version, node_id, source], ['1.6.0', 'sidecar', 'live'])
    assert.deepEqual(ledger, JSON.parse(text))
  })
})

test('[sidecar] reserved names: a lane named sidecar or sidecar-<x> makes the export contradictory', async () => {
  await harness(async ({ app, runsRoot }) => {
    // `sidecars` is an ordinary lane name, the control case: only the reserved id and prefix are refused.
    for (const [lane, status] of [['sidecar', 500], ['sidecar-two', 500], ['sidecars', 200]] as const) {
      const inputs = inputsSection()
      const renamed = { ...inputs, workers: { ui: inputs.workers.ui, [lane]: inputs.workers.adapter } }
      await writeRun(runsRoot('alpha', 'main'), { runId: `lane-${lane}`, definition: { name: 'Feature implementation', nodes: graphNodes(['ui', lane]) as typeof GRAPH_NODES },
        values: { ui: receipt('ui') }, next: [`launch_${lane}`], events: launchEvents.slice(0, 1), inputs: renamed })
      const response = await get(app, url('alpha', 'main', `lane-${lane}`))
      if (status === 200) assert.equal(response.status, 200, response.body)
      else assertError(response, 500, 'RUN_STORAGE_INVALID')
    }
  })
})

test('[sidecar] a seeded run with a sidecar has the activity of its twin without one, with two lanes, one lane and a blocked run', async () => {
  const activities: Record<string, unknown> = {}
  const nodes: Record<string, string[]> = {}
  await eachSeededRun((key, detail) => {
    activities[key] = detail.summary.activity
    nodes[key] = detail.definition.nodes.map(node => node.node_id)
  })
  for (const [withSidecar, without] of SIDECAR_TWINS) {
    const key = (run: string) => `ux-sidecar/${run}`
    assert.ok(activities[key(withSidecar)], withSidecar)
    assert.deepEqual(activities[key(withSidecar)], activities[key(without)], `${withSidecar} reads like ${without}`)
    // The sidecar sits right after the challenge, before every launch node; the twin has no such node.
    const order = nodes[key(withSidecar)]
    assert.equal(order.indexOf('sidecar'), order.indexOf('challenge') + 1)
    assert.ok(order.filter(id => id.startsWith('launch_')).every(id => order.indexOf(id) > order.indexOf('sidecar')))
    assert.equal(nodes[key(without)].includes('sidecar'), false)
  }
})

// ---- Attack pass (docs/PRD_ATTACK_PASS.md 4.6 and Appendix A): export 1.8.0, the live record and the node ----------

/** The record of Appendix A, read from the PRD itself: the bytes both lanes build to. */
async function appendixA(): Promise<string> {
  const prd = await readFile(new URL('../docs/PRD_ATTACK_PASS.md', import.meta.url), 'utf8')
  const block = /```json\n([\s\S]*?)\n```/.exec(prd.slice(prd.indexOf('## Appendix A')))
  assert.ok(block, 'Appendix A holds a JSON block')
  return block[1]
}
const ATTACK_RUN = 'claims-007'
const attackOf = async (overrides: Record<string, unknown> = {}) => ({ ...JSON.parse(await appendixA()) as Record<string, unknown>, ...overrides })
/** Appendix A's `pending` record (decisions G10): the plan has `attack`, no `attack.json` exists yet. */
const pendingOf = async (runId: string) => ({
  version: '1.0.0', run_id: runId, candidate_commit: null, settings: (await attackOf()).settings, status: 'pending',
  started_at: null, finished_at: null, error: null, attackers: [], findings: [],
})
/** The exported graph of a plan with `attack` (Appendix A): `attack` right after `review` with its `depends_on`; `approval` depends on both. */
const ATTACK_NODES = [
  ...GRAPH_NODES.slice(0, 7),
  { node_id: 'attack', label: 'Attack pass', kind: 'review', depends_on: ['candidate'] },
  { ...GRAPH_NODES[7], depends_on: ['review', 'attack'] },
  GRAPH_NODES[8],
] as typeof GRAPH_NODES
const ATTACK_DEFINITION = { name: 'Feature implementation', nodes: ATTACK_NODES }
const attackRow = (sequence: number, status: string, message: string, time = T2): RawEvent => ({ sequence, time, node: 'attack', status, message })
const reviewingEvents: RawEvent[] = [...reviewedEvents, { sequence: 10, time: T2, node: 'review', status: 'running', message: 'Launching reviewer general over the shared review worktree' }]
const attackRun = (spec: Partial<RunSpec> = {}): RunSpec => ({
  runId: ATTACK_RUN, version: '1.8.0', definition: ATTACK_DEFINITION, values: reviewedValues(), next: ['review', 'attack'], packets: reviewedPackets,
  events: [...reviewingEvents, attackRow(11, 'running', 'Attack pass started (auth-funds)')], sidecar: null, ...spec,
})
const attackRoute = (run = ATTACK_RUN) => url('alpha', 'main', run, '/attack')

test('[attack] a 1.8.0 export loads with the Appendix A record, a pending record, null and garbage; an invalid record never fails the run or the run list', async () => {
  await harness(async ({ app, runsRoot }) => {
    const root = runsRoot('alpha', 'main')
    await writeRun(root, attackRun({ attack: await attackOf() }))
    await writeRun(root, attackRun({ runId: 'attack-pending', attack: await pendingOf('attack-pending'), events: reviewingEvents }))
    // A run without a pass: export 1.8.0 with `attack: null` and the graph every older run has.
    await writeRun(root, { runId: 'attack-null', version: '1.8.0', attack: null, sidecar: null, values: { ui: receipt('ui') }, next: ['launch_adapter'], events: launchEvents.slice(0, 2) })
    for (const [runId, garbage] of [['attack-garbage', { findings: 'many', attackers: [{ id: 7 }] }], ['attack-string', 'not a record'], ['attack-array', [1, 2, 3]],
      ['attack-open-settings', await attackOf({ run_id: 'attack-open-settings', settings: { ...(await attackOf()).settings as object, attack_check: { argv: ['vitest'] } } })]] as const) {
      await writeRun(root, attackRun({ runId, attack: garbage }))
    }
    const list = projectSchemas.runList.parse((await get(app, url('alpha', 'main'))).json())
    assert.deepEqual(list.runs.map(run => run.run_id).sort(), [ATTACK_RUN, 'attack-array', 'attack-garbage', 'attack-null', 'attack-open-settings', 'attack-pending', 'attack-string'].sort())
    for (const run of list.runs) assert.equal((await get(app, url('alpha', 'main', run.run_id))).status, 200, run.run_id)
    // The export section is served when no live file exists: Appendix A, and the pending record.
    const served = validateAttackResult((await get(app, attackRoute())).json())
    assert.deepEqual([served.contract_version, served.node_id, served.source, served.status, served.findings.length], ['1.8.0', 'attack', 'export', 'succeeded', 2])
    const pending = validateAttackResult((await get(app, attackRoute('attack-pending'))).json())
    assert.deepEqual([pending.source, pending.status, pending.attackers.length, pending.findings.length, pending.candidate_commit], ['export', 'pending', 0, 0, null])
    // Null, garbage and a settings object beyond the eight keys (L1): not recorded, never an error page.
    for (const runId of ['attack-null', 'attack-garbage', 'attack-string', 'attack-array', 'attack-open-settings']) assertError(await get(app, attackRoute(runId)), 404, 'ATTACK_NOT_FOUND')
  })
})

test('[attack] a 1.7.0 export, and a 1.8.0 run without a pass, still load and answer ATTACK_NOT_FOUND, even beside a live attack.json', async () => {
  await harness(async ({ app, runsRoot }) => {
    const root = runsRoot('alpha', 'main')
    await writeRun(root, { runId: 'export-170', version: '1.7.0', values: { ui: receipt('ui') }, next: ['launch_adapter'], events: launchEvents.slice(0, 2),
      liveAttack: JSON.stringify(await attackOf({ run_id: 'export-170' })) })
    await writeRun(root, { runId: 'no-pass', version: '1.8.0', attack: null, values: { ui: receipt('ui') }, next: ['launch_adapter'], events: launchEvents.slice(0, 2),
      liveAttack: JSON.stringify(await attackOf({ run_id: 'no-pass' })) })
    for (const runId of ['export-170', 'no-pass']) {
      assert.equal((await get(app, url('alpha', 'main', runId))).status, 200)
      assertError(await get(app, attackRoute(runId)), 404, 'ATTACK_NOT_FOUND')
    }
  })
})

test('[attack] the live record wins over the export; a malformed, invalid, foreign or oversized live file falls back to the export (pending, failed or the record), with the reason logged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'md-manager-projects-attack-'))
  try {
    const runsRoot = join(root, 'runs')
    await mkdir(runsRoot, { recursive: true })
    const config = await parseProjectsConfig(JSON.stringify({ version: 1, projects: [{ project_id: 'alpha', name: 'Alpha', repository: join(root, 'repo'), workflows: [{ workflow_id: 'main', runs_root: runsRoot, definition: ATTACK_DEFINITION }] }] }), 'test registry')
    const warnings: string[] = []
    const store = new RunStore(config, { warn: (message, details) => warnings.push(`${message} ${JSON.stringify(details)}`) })
    const scope = store.scope('alpha', 'main')
    // The live record while the pass runs: the attacker finished, the skeptic is running, A-1 reproduced and not judged yet.
    const live = await attackOf({ status: 'running', finished_at: null })
    const findings = live.findings as Record<string, unknown>[]
    Object.assign(findings[0], { skeptic: null, status: 'unjudged', labels: [] })
    ;(live.attackers as Record<string, unknown>[])[0].skeptic = { status: 'running', started_at: '2026-10-05T10:46:00Z', finished_at: null, error: null, session_id: null, cost_usd: null }
    // The re-run's output names the worktree's absolute path: served redacted, like the secret-file paths.
    ;(findings[0].rerun as Record<string, unknown>).output_tail = `FAIL ${join(root, 'claims-007.attack', 'rerun', 'attack-tests', 'A-1.test.ts')} > rejects a body author`
    const exported = async (runId: string) => ({ ...(await attackOf()), run_id: runId })
    const failed = async (runId: string) => ({ ...(await pendingOf(runId)), status: 'failed', error: 'attack.json is not valid: findings[0].status' })
    const cases: [string, string | null, unknown, 'live' | 'export', string][] = [
      ['live-newer', JSON.stringify(live), exported, 'live', 'running'],
      ['live-over-pending', JSON.stringify(live), pendingOf, 'live', 'running'],
      ['live-malformed', '{"version": "1.0.0", "findings": [', exported, 'export', 'succeeded'],
      ['live-invalid', JSON.stringify({ ...live, findings: [{ id: 'A-1' }] }), exported, 'export', 'succeeded'],
      ['live-bad-enum', JSON.stringify({ ...live, status: 'timed_out' }), pendingOf, 'export', 'pending'],
      ['live-skeptic-raised', JSON.stringify({ ...live, findings: [{ ...findings[0], skeptic: { verdict: 'verified', reason: 'r', severity: 'P0' }, status: 'verified' }] }), failed, 'export', 'failed'],
      ['live-foreign', JSON.stringify({ ...live, run_id: 'another-run' }), exported, 'export', 'succeeded'],
      ['live-oversized', JSON.stringify({ ...live, padding: 'x'.repeat(4 * 1024 * 1024) }), exported, 'export', 'succeeded'],
      ['live-absent', null, failed, 'export', 'failed'],
    ]
    assert.equal(ATTACK_BYTE_LIMIT, 4 * 1024 * 1024)
    for (const [runId, file, section, source, status] of cases) {
      await writeRun(runsRoot, attackRun({ runId, attack: await (section as (run: string) => Promise<unknown>)(runId), ...(file === null ? {} : { liveAttack: file.replace(/"claims-007"/, `"${runId}"`) }) }))
      warnings.length = 0
      const result = validateAttackResult(await store.attackResult(scope, runId))
      assert.deepEqual([result.source, result.status, result.run_id, result.node_id], [source, status, runId, 'attack'], runId)
      if (source === 'export' && file !== null) assert.ok(warnings.some(warning => warning.includes(runId) && /attack/i.test(warning)), `${runId}: the reason is logged (${warnings.join(' | ')})`)
      // A record, valid or not, never fails the run.
      validateRunDetail((await store.loadRun(scope, runId)).detail)
    }
    const redacted = validateAttackResult(await store.attackResult(scope, 'live-newer'))
    assert.equal(redacted.findings[0].rerun!.output_tail, 'FAIL <path> > rejects a body author')
    assert.deepEqual(redacted.settings.secret_files, ['<path>'])
    assert.ok(!JSON.stringify(redacted).includes(root) && !JSON.stringify(redacted).includes('/home/'))
    // Neither readable: not recorded, never an error page or a failed run.
    await writeRun(runsRoot, attackRun({ runId: 'both-invalid', attack: { broken: true }, liveAttack: 'not json' }))
    await assert.rejects(store.attackResult(scope, 'both-invalid'), (error: { status: number; code: string }) => error.status === 404 && error.code === 'ATTACK_NOT_FOUND')
    validateRunDetail((await store.loadRun(scope, 'both-invalid')).detail)
    assert.equal((await store.listRuns(scope)).length, cases.length + 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('[attack] the node\'s status comes from its events only and never decides the run: running and interactive are running, the closing row succeeded', async () => {
  await harness(async ({ app, runsRoot }) => {
    const root = runsRoot('alpha', 'main')
    const started = attackRow(11, 'running', 'Attack pass started (auth-funds)')
    const cases: [string, RawEvent[], string][] = [
      ['no-event', reviewingEvents, 'pending'],
      ['running', [...reviewingEvents, started], 'running'],
      ['interactive', [...reviewingEvents, started, attackRow(12, 'interactive', 'Attack pass attacker auth-funds timed_out: see attack/auth-funds.stderr.log')], 'running'],
      ['succeeded', [...reviewingEvents, started, attackRow(12, 'succeeded', 'Attack pass: 2 finding(s), 1 reproduced, 1 verified')], 'succeeded'],
      ['ended-failed', [...reviewingEvents, started, attackRow(12, 'interactive', 'Attack pass failed: OSError'), attackRow(13, 'succeeded', 'Attack pass ended: failed')], 'succeeded'],
    ]
    for (const [runId, events, status] of cases) {
      // A garbage record never moves the node: its status is its events'.
      await writeRun(root, attackRun({ runId, events, attack: { status: 'failed' }, liveAttack: '{}' }))
      const detail = validateRunDetail((await get(app, url('alpha', 'main', runId))).json())
      assert.equal(nodeStatus(detail, 'attack'), status, runId)
      assert.equal(detail.snapshot.nodes.find(node => node.node_id === 'attack')?.kind, 'review')
      // The review is the focus and the headline's step whatever the attack node's rows say.
      assert.equal(detail.summary.activity?.focus?.node_id, 'review', runId)
      assert.match(detail.summary.activity?.headline ?? '', /^Independent review · /, runId)
    }
  })
})

test('[attack] the attack route is read-only: other methods are 405, HEAD works, nothing is written', async () => {
  await harness(async ({ app, runsRoot }) => {
    await writeRun(runsRoot('alpha', 'main'), attackRun({ attack: await pendingOf(ATTACK_RUN), liveAttack: await appendixA() }))
    const before = await snapshotTree(runsRoot('alpha', 'main'))
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const) {
      const response = await app.inject({ method, url: attackRoute(), payload: method === 'OPTIONS' ? undefined : { label: 'real' } })
      assert.equal(response.statusCode, 405, method)
      assert.equal(response.headers.allow, 'GET, HEAD')
      assert.equal(response.json().error.code, 'METHOD_NOT_ALLOWED')
    }
    assert.equal((await app.inject({ method: 'HEAD', url: attackRoute() })).statusCode, 200)
    const response = await get(app, attackRoute())
    assert.equal(response.status, 200)
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.deepEqual(await snapshotTree(runsRoot('alpha', 'main')), before)
  })
})

test('[attack] the Appendix A example validates verbatim: written live, it is served field for field but for the redacted secret-file path', async () => {
  await harness(async ({ app, runsRoot }) => {
    const text = await appendixA()
    await writeRun(runsRoot('alpha', 'main'), attackRun({ attack: await pendingOf(ATTACK_RUN), liveAttack: text }))
    const served = validateAttackResult((await get(app, attackRoute())).json())
    const { contract_version, node_id, source, ...record } = served
    assert.deepEqual([contract_version, node_id, source], ['1.8.0', 'attack', 'live'])
    const expected = JSON.parse(text) as { settings: { secret_files: string[] } }
    expected.settings.secret_files = ['<path>']
    assert.deepEqual(record, expected)
  })
})

test('[attack] reserved names: a lane named attack or attack-<x> makes the export contradictory', async () => {
  await harness(async ({ app, runsRoot }) => {
    // `attacker` is an ordinary lane name, the control case: only the reserved id and prefix are refused.
    for (const [lane, status] of [['attack', 500], ['attack-two', 500], ['attacker', 200]] as const) {
      const inputs = inputsSection()
      const renamed = { ...inputs, workers: { ui: inputs.workers.ui, [lane]: inputs.workers.adapter } }
      await writeRun(runsRoot('alpha', 'main'), { runId: `lane-${lane}`, definition: { name: 'Feature implementation', nodes: graphNodes(['ui', lane]) as typeof GRAPH_NODES },
        values: { ui: receipt('ui') }, next: [`launch_${lane}`], events: launchEvents.slice(0, 1), inputs: renamed })
      const response = await get(app, url('alpha', 'main', `lane-${lane}`))
      if (status === 200) assert.equal(response.status, 200, response.body)
      else assertError(response, 500, 'RUN_STORAGE_INVALID')
    }
  })
})

test('[attack] a seeded run with an attack pass has the activity and status of its twin without one: reviewing, waiting on the pass after the review, blocked and integrated', async () => {
  const activities: Record<string, unknown> = {}
  const statuses: Record<string, string> = {}
  const nodes: Record<string, RunDetail['definition']['nodes']> = {}
  await eachSeededRun((key, detail) => {
    activities[key] = detail.summary.activity
    statuses[key] = detail.summary.status
    nodes[key] = detail.definition.nodes
  })
  assert.ok(ATTACK_TWINS.length >= 4)
  for (const [withAttack, without] of ATTACK_TWINS) {
    const key = (run: string) => `ux-attack/${run}`
    assert.ok(activities[key(withAttack)], withAttack)
    assert.equal(statuses[key(withAttack)], statuses[key(without)], `${withAttack}: the same status as ${without}`)
    if (withAttack === RUN_ATTACK_WAITING) {
      // The review decided (approved) but the report-only pass runs on: the run is still in its review step, so the review
      // keeps the focus (run 003 P1), while its twin without a pass has nothing running and reads null (between steps). That
      // one focus field is the only intended difference; every other activity field still reads the same, and the attack
      // node never takes the focus itself.
      const asWith = activities[key(withAttack)] as { focus: { node_id: string } | null }
      const asWithout = activities[key(without)] as { focus: unknown }
      assert.equal(asWith.focus?.node_id, 'review', `${withAttack}: the review keeps the focus while the pass runs`)
      assert.equal(asWithout.focus, null, `${without}: no pass and nothing running, so no focus`)
      assert.deepEqual({ ...asWith, focus: null }, { ...asWithout, focus: null }, `${withAttack} reads like ${without} but for the focus`)
    } else {
      assert.deepEqual(activities[key(withAttack)], activities[key(without)], `${withAttack} reads like ${without}`)
    }
    // `attack` right after `review` with its depends_on; approval depends on both; the twin has no such node.
    const graph = nodes[key(withAttack)]
    const ids = graph.map(node => node.node_id)
    assert.equal(ids.indexOf('attack'), ids.indexOf('review') + 1)
    assert.deepEqual(graph.find(node => node.node_id === 'attack')!.depends_on, graph.find(node => node.node_id === 'review')!.depends_on)
    assert.deepEqual(graph.find(node => node.node_id === 'approval')!.depends_on, ['review', 'attack'])
    assert.equal(nodes[key(without)].some(node => node.node_id === 'attack'), false)
  }
})

// ---- Run roles, the controller record and the profile (C52): export 1.7.0 ----

// ---- Multi-provider panel (docs/PRD_MULTI_PROVIDER_PANEL.md Appendix A): export 1.9.0 and the live record, no node ------

/**
 * The two records of Appendix A, read from the PRD itself: the `succeeded` record and the `pending` one, in that order. Both
 * blocks are indented inside a bullet, so the fences tolerate leading whitespace (design-challenge note 4).
 */
async function panelAppendixA(): Promise<[string, string]> {
  const prd = await readFile(new URL('../docs/PRD_MULTI_PROVIDER_PANEL.md', import.meta.url), 'utf8')
  const blocks = [...prd.slice(prd.indexOf('## Appendix A')).matchAll(/^[ \t]*```json\n([\s\S]*?)\n[ \t]*```/gm)].map(block => block[1])
  assert.equal(blocks.length, 2, 'Appendix A holds the succeeded and the pending record')
  return [blocks[0], blocks[1]]
}
const PANEL_RUN = 'panel-run'
const panelOf = async (): Promise<PanelRecord> => JSON.parse((await panelAppendixA())[0]) as PanelRecord
const panelPendingOf = async (): Promise<PanelRecord> => JSON.parse((await panelAppendixA())[1]) as PanelRecord
/** Appendix A's running record: the succeeded one with the statuses `running`, `ended_at` null and no findings yet. */
async function panelRunningOf(): Promise<PanelRecord> {
  const record = await panelOf()
  Object.assign(record.panels[0], { status: 'running', ended_at: null, findings: [] })
  for (const provider of record.panels[0].providers) Object.assign(provider, { status: 'running', cost_usd: null, finding_ids: [] })
  return record
}
/** A 1.9.0 run in its review step; the graph is every older run's (no panel node this slice). */
const panelRun = (spec: Partial<RunSpec> = {}): RunSpec => ({
  runId: PANEL_RUN, version: '1.9.0', values: reviewedValues(), next: ['review'], packets: reviewedPackets, events: reviewingEvents, sidecar: null, attack: null, ...spec,
})
const panelsRoute = (run = PANEL_RUN) => url('alpha', 'main', run, '/panels')

test('[panel] a 1.9.0 export loads with the Appendix A record, the pending record, null and garbage; an invalid record never fails the run or the run list; the graph is unchanged', async () => {
  await harness(async ({ app, runsRoot }) => {
    const root = runsRoot('alpha', 'main')
    await writeRun(root, panelRun({ panels: await panelOf() }))
    await writeRun(root, panelRun({ runId: 'panel-pending', panels: await panelPendingOf() }))
    await writeRun(root, panelRun({ runId: 'panel-null', panels: null }))
    for (const [runId, garbage] of [['panel-garbage', { version: '1.0.0', panels: [{ id: 'x', status: 'exploded' }] }], ['panel-string', 'not a record'], ['panel-array', [1, 2, 3]],
      ['panel-threshold-zero', { ...(await panelOf()), panels: [{ ...(await panelOf()).panels[0], overlap_threshold: 0 }] }]] as const) {
      await writeRun(root, panelRun({ runId, panels: garbage }))
    }
    const list = projectSchemas.runList.parse((await get(app, url('alpha', 'main'))).json())
    assert.deepEqual(list.runs.map(run => run.run_id).sort(), [PANEL_RUN, 'panel-array', 'panel-garbage', 'panel-null', 'panel-pending', 'panel-string', 'panel-threshold-zero'].sort())
    for (const run of list.runs) {
      const detail = validateRunDetail((await get(app, url('alpha', 'main', run.run_id))).json())
      // No graph node this slice: the pinned definition is every older run's, and nothing of the activity reads the panel.
      assert.deepEqual(detail.definition.nodes.map(node => node.node_id), DEFINITION.nodes.map(node => node.node_id), run.run_id)
      assert.equal(detail.snapshot.nodes.some(node => node.node_id.startsWith('panel')), false)
    }
    const served = validatePanelResults((await get(app, panelsRoute())).json())
    assert.deepEqual([served.contract_version, served.source, served.version, served.panels.length], ['1.9.0', 'export', '1.0.0', 1])
    assert.equal('node_id' in served, false)
    assert.deepEqual([served.panels[0].id, served.panels[0].stage, served.panels[0].status, served.panels[0].findings.length, served.panels[0].findings[0].accepted], ['review-panel', 'review', 'succeeded', 1, true])
    const pending = validatePanelResults((await get(app, panelsRoute('panel-pending'))).json())
    assert.deepEqual([pending.source, pending.panels[0].status, pending.panels[0].findings.length, pending.panels[0].started_at], ['export', 'pending', 0, null])
    assert.deepEqual(pending.panels[0].providers.map(provider => provider.status), ['pending', 'pending'])
    for (const runId of ['panel-null', 'panel-garbage', 'panel-string', 'panel-array', 'panel-threshold-zero']) assertError(await get(app, panelsRoute(runId)), 404, 'PANELS_NOT_FOUND')
  })
})

test('[panel] a 1.8.0 export answers PANELS_NOT_FOUND even beside a live panel.json, as does a 1.9.0 run without panels; a 1.9.0 export keeps every other section', async () => {
  await harness(async ({ app, runsRoot }) => {
    const root = runsRoot('alpha', 'main')
    const live = JSON.stringify(await panelOf())
    await writeRun(root, { runId: 'export-180', version: '1.8.0', attack: null, sidecar: null, values: { ui: receipt('ui') }, next: ['launch_adapter'], events: launchEvents.slice(0, 2), livePanel: live })
    await writeRun(root, { runId: 'no-panels', version: '1.9.0', attack: null, sidecar: null, panels: null, values: { ui: receipt('ui') }, next: ['launch_adapter'], events: launchEvents.slice(0, 2), livePanel: live })
    for (const runId of ['export-180', 'no-panels']) {
      assert.equal((await get(app, url('alpha', 'main', runId))).status, 200)
      assertError(await get(app, panelsRoute(runId)), 404, 'PANELS_NOT_FOUND')
    }
    // A 1.9.0 export serves its review, inputs, sidecar and attack sections exactly as a 1.8.0 one.
    await writeRun(root, panelRun({ runId: 'full-190', panels: await panelOf(), review: reviewSection(), inputs: inputsSection(), sidecar: null, attack: null }))
    validateReviewResult((await get(app, url('alpha', 'main', 'full-190', '/reviews/1'))).json())
    validateRunInputs((await get(app, url('alpha', 'main', 'full-190', '/inputs'))).json())
    assertError(await get(app, url('alpha', 'main', 'full-190', '/attack')), 404, 'ATTACK_NOT_FOUND')
    assertError(await get(app, url('alpha', 'main', 'full-190', '/sidecar')), 404, 'SIDECAR_NOT_FOUND')
    assert.equal(validatePanelResults((await get(app, panelsRoute('full-190'))).json()).source, 'export')
  })
})

test('[panel] the live record wins whenever it is readable and valid, with no mtime comparison; a malformed, invalid or oversized live file falls back to the export (pending or the record), with the reason logged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'md-manager-projects-panel-'))
  try {
    const runsRoot = join(root, 'runs')
    await mkdir(runsRoot, { recursive: true })
    const config = await parseProjectsConfig(JSON.stringify({ version: 1, projects: [{ project_id: 'alpha', name: 'Alpha', repository: join(root, 'repo'), workflows: [{ workflow_id: 'main', runs_root: runsRoot, definition: DEFINITION }] }] }), 'test registry')
    const warnings: string[] = []
    const store = new RunStore(config, { warn: (message, details) => warnings.push(`${message} ${JSON.stringify(details)}`) })
    const scope = store.scope('alpha', 'main')
    const running = await panelRunningOf()
    // A live record whose texts name the worktree's absolute path: served redacted.
    const redactable = await panelOf()
    const finding = redactable.panels[0].findings[0]
    finding.detail = `A reorg can strand a mined publication (see ${join(root, 'worktree-review', 'reconcile.ts')}).`
    finding.file = join(root, 'worktree-review', 'packages', 'reconcile.ts')
    redactable.panels[0].providers[1].error = `pi wrote its stream to ${join(root, 'panel', 'pi.stdout')}`
    redactable.panels[0].error = `context assembled at ${join(root, 'panel', 'context.txt')}`
    const cases: [string, string | null, PanelRecord, 'live' | 'export', string][] = [
      ['live-over-pending', JSON.stringify(running), await panelPendingOf(), 'live', 'running'],
      ['live-over-succeeded', JSON.stringify(running), await panelOf(), 'live', 'running'],
      ['live-older-than-export', JSON.stringify(running), await panelOf(), 'live', 'running'],
      ['live-redacted', JSON.stringify(redactable), await panelPendingOf(), 'live', 'succeeded'],
      ['live-malformed', '{"version": "1.0.0", "panels": [', await panelOf(), 'export', 'succeeded'],
      ['live-invalid', JSON.stringify({ ...running, panels: [{ id: 'review-panel' }] }), await panelOf(), 'export', 'succeeded'],
      ['live-bad-enum', JSON.stringify({ ...running, panels: [{ ...running.panels[0], status: 'refused' }] }), await panelPendingOf(), 'export', 'pending'],
      ['live-bad-threshold', JSON.stringify({ ...running, panels: [{ ...running.panels[0], overlap_threshold: 'some' }] }), await panelPendingOf(), 'export', 'pending'],
      ['live-duplicate-ids', JSON.stringify({ ...running, panels: [running.panels[0], running.panels[0]] }), await panelOf(), 'export', 'succeeded'],
      ['live-oversized', JSON.stringify({ ...running, padding: 'x'.repeat(4 * 1024 * 1024) }), await panelOf(), 'export', 'succeeded'],
      ['live-absent', null, await panelPendingOf(), 'export', 'pending'],
    ]
    assert.equal(PANEL_BYTE_LIMIT, 4 * 1024 * 1024)
    for (const [runId, file, section, source, status] of cases) {
      await writeRun(runsRoot, panelRun({ runId, panels: section, ...(file === null ? {} : { livePanel: file }) }))
      if (runId === 'live-older-than-export') {
        // The live file predates the export by an hour: it still wins, since only validity decides (Appendix A: no mtime).
        const old = new Date(Date.now() - 3_600_000)
        await utimes(join(runsRoot, runId, 'panel.json'), old, old)
        assert.ok((await stat(join(runsRoot, runId, 'panel.json'))).mtimeMs < (await stat(join(runsRoot, runId, 'run-state.json'))).mtimeMs)
      }
      warnings.length = 0
      const result = validatePanelResults(await store.panelResults(scope, runId))
      assert.deepEqual([result.source, result.panels[0].status], [source, status], runId)
      if (source === 'export' && file !== null) assert.ok(warnings.some(warning => warning.includes(runId) && /panel/i.test(warning)), `${runId}: the reason is logged (${warnings.join(' | ')})`)
      // A record, valid or not, never fails the run.
      validateRunDetail((await store.loadRun(scope, runId)).detail)
    }
    const redacted = validatePanelResults(await store.panelResults(scope, 'live-redacted'))
    assert.equal(redacted.panels[0].findings[0].detail, 'A reorg can strand a mined publication (see <path>).')
    assert.equal(redacted.panels[0].findings[0].file, '<path>')
    assert.equal(redacted.panels[0].providers[1].error, 'pi wrote its stream to <path>')
    assert.equal(redacted.panels[0].error, 'context assembled at <path>')
    assert.ok(!JSON.stringify(redacted).includes(root) && !JSON.stringify(redacted).includes('/home/'))
    // Neither readable: not recorded, never an error page or a failed run.
    await writeRun(runsRoot, panelRun({ runId: 'both-invalid', panels: { broken: true }, livePanel: 'not json' }))
    await assert.rejects(store.panelResults(scope, 'both-invalid'), (error: { status: number; code: string }) => error.status === 404 && error.code === 'PANELS_NOT_FOUND')
    validateRunDetail((await store.loadRun(scope, 'both-invalid')).detail)
    assert.equal((await store.listRuns(scope)).length, cases.length + 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('[panel] both Appendix A records are served field for field, live and from the export; a threshold of "all" or 1, a challenge stage, a running provider and every nullable field null are served, never skipped', async () => {
  await harness(async ({ app, runsRoot }) => {
    const root = runsRoot('alpha', 'main')
    const [succeeded, pending] = await panelAppendixA()
    await writeRun(root, panelRun({ runId: 'verbatim-live', panels: JSON.parse(pending), livePanel: succeeded }))
    await writeRun(root, panelRun({ runId: 'verbatim-export', panels: JSON.parse(succeeded) }))
    await writeRun(root, panelRun({ runId: 'verbatim-pending', panels: JSON.parse(pending) }))
    for (const [runId, source, text] of [['verbatim-live', 'live', succeeded], ['verbatim-export', 'export', succeeded], ['verbatim-pending', 'export', pending]] as const) {
      const served = validatePanelResults((await get(app, panelsRoute(runId))).json())
      const { contract_version, source: servedSource, ...record } = served
      assert.deepEqual([contract_version, servedSource], ['1.9.0', source], runId)
      assert.deepEqual(record, JSON.parse(text), runId)
    }
    // Design-challenge note 3: the values the verbatim records do not carry.
    const all = await panelOf()
    Object.assign(all.panels[0], { id: 'challenge-panel', stage: 'challenge', overlap_threshold: 'all', status: 'running', ended_at: null, context_bytes: null, error: null })
    all.panels[0].providers[0] = { ...all.panels[0].providers[0], model: null, effort: null, status: 'running', cost_usd: null, context_bytes: null, finding_ids: [], error: null }
    all.panels[0].findings[0] = { ...all.panels[0].findings[0], line: null, accepted: false }
    const any = await panelOf()
    Object.assign(any.panels[0], { id: 'any-panel', overlap_threshold: 1 })
    const timedOut = await panelOf()
    Object.assign(timedOut.panels[0], { id: 'timed-out-panel', status: 'timed_out', findings: [], error: 'every provider timed out' })
    for (const provider of timedOut.panels[0].providers) Object.assign(provider, { status: 'timed_out', finding_ids: [], error: 'timed out after 15 minutes; its process group was stopped', cost_usd: null })
    const multi: PanelRecord = { version: '1.0.0', panels: [all.panels[0], any.panels[0], timedOut.panels[0]] }
    await writeRun(root, panelRun({ runId: 'thresholds', panels: await panelPendingOf(), livePanel: JSON.stringify(multi) }))
    const served = validatePanelResults((await get(app, panelsRoute('thresholds'))).json())
    assert.equal(served.source, 'live')
    assert.deepEqual(served.panels.map(panel => [panel.id, panel.stage, panel.overlap_threshold, panel.status]), [['challenge-panel', 'challenge', 'all', 'running'], ['any-panel', 'review', 1, 'succeeded'], ['timed-out-panel', 'review', 2, 'timed_out']])
    assert.deepEqual(served.panels[0].providers[0], { transport: 'claude', model: null, effort: null, status: 'running', cost_usd: null, context_bytes: null, finding_ids: [], error: null })
    assert.equal(served.panels[0].findings[0].line, null)
    assert.deepEqual(served.panels[2].providers.map(provider => provider.status), ['timed_out', 'timed_out'])
  })
})

test('[panel] the panels route is read-only: other methods are 405, HEAD works, nothing is written', async () => {
  await harness(async ({ app, runsRoot }) => {
    await writeRun(runsRoot('alpha', 'main'), panelRun({ panels: await panelPendingOf(), livePanel: (await panelAppendixA())[0] }))
    const before = await snapshotTree(runsRoot('alpha', 'main'))
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const) {
      const response = await app.inject({ method, url: panelsRoute(), payload: method === 'OPTIONS' ? undefined : { accepted: true } })
      assert.equal(response.statusCode, 405, method)
      assert.equal(response.headers.allow, 'GET, HEAD')
      assert.equal(response.json().error.code, 'METHOD_NOT_ALLOWED')
    }
    assert.equal((await app.inject({ method: 'HEAD', url: panelsRoute() })).statusCode, 200)
    const response = await get(app, panelsRoute())
    assert.equal(response.status, 200)
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.equal(validatePanelResults(response.json()).source, 'live')
    assert.deepEqual(await snapshotTree(runsRoot('alpha', 'main')), before)
  })
})

test('[roles] a 1.7.0 export serves the pinned roles, the controller record and the profile; a 1.6.0 export serves them as null', async () => {
  await harness(async ({ app, runsRoot }) => {
    const root = runsRoot('alpha', 'main')
    const roles = { worker: { model: 'claude-sonnet-5', effort: 'low' }, judges: { model: null, effort: 'high' } }
    const controller = { commit: 'f'.repeat(40), dirty: true, claude_version: '2.1.288 (Claude Code)' }
    const pinned = inputsSection({ automatic: { ...inputsSection().automatic!, profile: 'attended' } as InputsSection['automatic'] })
    await writeRun(root, { runId: 'pinned', version: '1.7.0', values: { ui: receipt('ui') }, next: ['launch_adapter'], events: launchEvents.slice(0, 2),
      inputs: { ...pinned, roles, controller } })
    await writeRun(root, { runId: 'before', version: '1.6.0', values: { ui: receipt('ui') }, next: ['launch_adapter'], events: launchEvents.slice(0, 2), inputs: inputsSection() })
    const served = validateRunInputs((await get(app, url('alpha', 'main', 'pinned', '/inputs'))).json())
    assert.deepEqual([served.roles, served.controller, served.automatic?.profile], [roles, controller, 'attended'])
    const before = validateRunInputs((await get(app, url('alpha', 'main', 'before', '/inputs'))).json())
    assert.deepEqual([before.roles, before.controller, before.automatic?.profile], [null, null, null])
    const list = projectSchemas.runList.parse((await get(app, url('alpha', 'main'))).json())
    assert.deepEqual(list.runs.map(run => run.run_id).sort(), ['before', 'pinned'])
    // A malformed record is invalid storage, as any other inputs field is.
    await writeRun(root, { runId: 'bad-roles', version: '1.7.0', values: { ui: receipt('ui') }, next: ['launch_adapter'], events: launchEvents.slice(0, 2),
      inputs: { ...inputsSection(), roles: { worker: { model: null, effort: 'extreme' }, judges: roles.judges } } })
    assertError(await get(app, url('alpha', 'main', 'bad-roles', '/inputs')), 500, 'RUN_STORAGE_INVALID', root)
  })
})

// ---- Tryouts (C7, C29): export 1.7.0 ----

test('[tryout] a 1.7.0 export serves the tryout, its verdicts redacted and the override; older runs serve null', async () => {
  await harness(async ({ app, runsRoot }) => {
    const root = runsRoot('alpha', 'main')
    const verdicts = [
      { result: 'broken', note: `The list is empty after a reload of ${root}/x`, at: '2026-10-04T11:00:00+02:00', by: 'operator', via: 'claude-code' },
      { result: 'works', note: null, at: '2026-10-04T10:00:00Z', by: 'operator' },
    ]
    const override = { reason: 'The demo is tomorrow', by: 'operator', at: '2026-10-04T08:00:00Z' }
    await writeRun(root, { runId: 'tried', version: '1.7.0', values: { ui: receipt('ui') }, next: ['launch_adapter'], events: launchEvents.slice(0, 2),
      inputs: { ...inputsSection(), tryout: { required: true, verdicts, allow_untried: override } } })
    await writeRun(root, { runId: 'untried', version: '1.7.0', values: { ui: receipt('ui') }, next: ['launch_adapter'], events: launchEvents.slice(0, 2),
      inputs: { ...inputsSection(), tryout: { required: true, verdicts: [] } } })
    await writeRun(root, { runId: 'before', version: '1.7.0', values: { ui: receipt('ui') }, next: ['launch_adapter'], events: launchEvents.slice(0, 2), inputs: inputsSection() })
    const served = validateRunInputs((await get(app, url('alpha', 'main', 'tried', '/inputs'))).json())
    assert.deepEqual(served.tryout, {
      required: true, allow_untried: override,
      verdicts: [{ result: 'broken', note: 'The list is empty after a reload of <path>', at: '2026-10-04T09:00:00.000Z', by: 'operator' },
        { result: 'works', note: null, at: '2026-10-04T10:00:00Z', by: 'operator' }],
    })
    assert.deepEqual(validateRunInputs((await get(app, url('alpha', 'main', 'untried', '/inputs'))).json()).tryout, { required: true, verdicts: [], allow_untried: null })
    assert.equal(validateRunInputs((await get(app, url('alpha', 'main', 'before', '/inputs'))).json()).tryout, null)
    // An unknown result is invalid storage, as any other inputs field is.
    await writeRun(root, { runId: 'bad-tryout', version: '1.7.0', values: { ui: receipt('ui') }, next: ['launch_adapter'], events: launchEvents.slice(0, 2),
      inputs: { ...inputsSection(), tryout: { required: true, verdicts: [{ result: 'fine', note: null, at: '2026-10-04T10:00:00Z', by: 'operator' }] } } })
    assertError(await get(app, url('alpha', 'main', 'bad-tryout', '/inputs')), 500, 'RUN_STORAGE_INVALID', root)
  })
})

// ---- Export 1.10.0: the in-run fix loop (docs/PRD_VIEWER_REFINE.md Appendix A) ----------------------------------

const FIX_DIR = new URL('../contracts/projects/examples/fix-loop/', import.meta.url)
const fixText = (name: string) => readFileSync(new URL(name, FIX_DIR), 'utf8')
const fixJson = (name: string) => JSON.parse(fixText(name))
const FIX_RUN = 'fix-loop'
const FINDING = { severity: 'P1', message: 'src/a.ts:1 the return mark is drawn from depends_on', disposition: 'open', worker: 'ui', requirement: 'draw it from fixLoop', reviewer: 'review' }

/** A session entry as `launch_session` writes it (repair.py), for lane `ui`: `launched`, nothing else written yet. */
function journalEntry(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    n, status: 'launched', mode: 'session', by: 'controller', trigger: 'review', round: 1, rounds: 2, lanes: { ui: {} }, recorded_at: '2026-03-01T10:12:00.000000Z',
    blocked: { step: 'review', phase: 'candidate', candidate_commit: OUTPUT, packets: [] }, workspace: '/synthetic/run/repair-workspace-1', workspace_commit: OUTPUT,
    what: 'the reviewed candidate', review_round: 1, brief: { findings: [FINDING], delta: '/synthetic/run/review.round-1.diff' },
    session: { node: `repair-${n}`, launch_token: 'e3a0b7a8-0000-4000-8000-000000000000', session_id: null }, ...over,
  }
}
const journal = (...entries: Record<string, unknown>[]) => json({ version: '1.0.0', repairs: entries })
const roundsFile = (...rounds: Record<string, unknown>[]) => json({ version: '1.0.0', rounds })
const reviewRound = (round: number, over: Record<string, unknown> = {}) => ({
  round, verdict: 'blocked', candidate: OUTPUT, lane: 'ui', findings: [FINDING], reviewer_sessions: ['s-1', 's-2'], archived: true, started_at: '2026-03-01T10:11:00.000000Z', ...over,
})
const reviewBlocked = [{ node_id: 'review', error: 'RuntimeError(review blocked)', interrupts: [], result: null }]
const fixRun = (spec: Partial<RunSpec> = {}): RunSpec => ({
  runId: FIX_RUN, version: '1.10.0', values: reviewedValues(), next: ['review'], packets: reviewedPackets, events: reviewedEvents, tasks: reviewBlocked,
  review: null, inputs: inputsSection(), ...spec,
})
const reviewDone = reviewedValues({ review: '/synthetic/review.json' })
const detailOf = async (app: Harness['app'], run = FIX_RUN) => validateRunDetail((await get(app, url('alpha', 'main', run))).json())
const nodeOf = (detail: RunDetail, id: string) => detail.snapshot.nodes.find(node => node.node_id === id)

test('[fix loop] the live mapping and the Python export are tested against the same real journals of worker-skills-001', () => {
  const expected = fixJson('expected.json')
  const receipts = new Map([[1, fixJson('repair-1.interactive.json')], [2, fixJson('repair-2.interactive.json')]])
  const repairs = mapRepairs(fixJson('repairs.json'), n => receipts.get(n))
  const rounds = mapReviewRounds(fixJson('review-rounds.json'), repairs, round => fixJson(`review.round-${round}.json`))
  assert.deepEqual({ version: '1.0.0', rounds: 2, repairs, review_rounds: rounds }, expected)
  // The record is a valid served fix loop, and the lanes' pins of the receipts reach `requested`.
  const loop = projectSchemas.fixLoop.parse({ contract_version: '1.10.0', source: 'live', ...expected })
  assert.deepEqual(loop.repairs.map(repair => repair.requested), [{ model: 'claude-opus-4-8', effort: null }, { model: 'claude-opus-4-8', effort: null }])
})

test('[fix loop] a non-string item in fix_files or left_behind is dropped by the mapping (the Python export drops it the same way)', () => {
  const entry = journalEntry(1, { lanes: { ui: { fix_files: ['a.ts', 7, null, 'b.ts'] } }, left_behind: ['x', { y: 1 }, 'z'] })
  const [repair] = mapRepairs(JSON.parse(journal(entry)), () => undefined)
  assert.deepEqual([repair.fix_files, repair.left_behind], [['a.ts', 'b.ts'], ['x', 'z']])
})

test('[fix loop] the real run directory of worker-skills-001 (an export 1.9.0 with session repairs) is read live: repair nodes, statuses, the review attempt and /reviews/2', async () => {
  await harness(async ({ app, runsRoot }) => {
    const lanes = ['engine']
    const files: Record<string, string> = {}
    for (const name of ['repairs.json', 'review-rounds.json', 'review.round-1.json', 'repair-1.interactive.json', 'repair-2.interactive.json']) files[name] = fixText(name)
    const delta = fixText('review.delta.diff')
    const section = reviewSection({ attempt: 1, round: 2, delta_from: '56c8ebd521a1b252e9ec7242784977c1a188ed61', delta_diff: { path: 'review.delta.diff', sha256: sha256(delta), bytes: Buffer.byteLength(delta) } } as Partial<ReviewSection>)
    await writeRun(runsRoot('alpha', 'main'), fixRun({
      definition: { name: 'Feature implementation', nodes: graphNodes(lanes) as typeof GRAPH_NODES }, version: '1.10.0', tasks: [], files: { ...files, 'review.delta.diff': delta },
      review: section, inputs: null as never, events: [],
      values: { run_id: FIX_RUN, review: '/synthetic/review.json' }, next: [], packets: [],
    }))
    const detail = await detailOf(app)
    const loop = detail.fixLoop!
    assert.equal(loop.source, 'live')
    assert.equal(loop.contract_version, '1.10.0')
    assert.deepEqual({ ...loop, contract_version: undefined, source: undefined }, redactDeep({ ...fixJson('expected.json'), contract_version: undefined, source: undefined }, redactPaths))
    // Repair nodes sit right after the step they answer; nothing depends on them; their status comes from the journal (applied).
    const ids = detail.definition.nodes.map(node => node.node_id)
    assert.equal(ids[ids.indexOf('verify_engine') + 1], 'repair-1')
    assert.equal(ids[ids.indexOf('review') + 1], 'repair-2')
    assert.deepEqual(detail.definition.nodes.find(node => node.node_id === 'repair-2'), { node_id: 'repair-2', label: 'Repair engine 2', kind: 'worker', depends_on: ['review'] })
    assert.equal(detail.definition.nodes.some(node => node.depends_on.some(parent => parent.startsWith('repair-'))), false)
    assert.deepEqual(['repair-1', 'repair-2'].map(id => nodeOf(detail, id)?.status), ['succeeded', 'succeeded'])
    assert.equal(nodeOf(detail, 'repair-2')?.session_id, '2a16e9fa-a209-449a-b2f9-7297e9dd25d4')
    // The definition revision is the pinned definition's: a round landing never moves it.
    const bare = await (async () => { await writeRun(runsRoot('alpha', 'main'), fixRun({ runId: 'bare', definition: { name: 'Feature implementation', nodes: graphNodes(lanes) as typeof GRAPH_NODES }, tasks: [], review: null, inputs: null as never, events: [], values: { run_id: 'bare' }, next: [], packets: [] })); return detailOf(app, 'bare') })()
    assert.equal(detail.definition.definition_revision, bare.definition.definition_revision)
    assert.equal(bare.fixLoop, undefined)
    // The review node is attempt 2 (review.round) and its result is served at /reviews/2.
    assert.equal(nodeOf(detail, 'review')?.attempt, 2)
    const review = validateReviewResult((await get(app, url('alpha', 'main', FIX_RUN, '/reviews/2'))).json())
    assert.deepEqual([review.attempt, review.round, review.delta_from], [2, 2, '56c8ebd521a1b252e9ec7242784977c1a188ed61'])
    assert.equal(review.delta_diff?.kind, 'patch')
    assert.equal((await get(app, url('alpha', 'main', FIX_RUN, '/reviews/1'))).status, 404)
    // The delta diff is served as review.diff is, through the artifact route, hash-checked.
    const artifact = await get(app, review.delta_diff!.uri)
    assert.equal(artifact.status, 200)
    assert.equal(artifact.body, delta)
  })
})

test('[fix loop] a 1.9.0 export with session repairs read live projects the review attempt from the archived rounds; one without renders as before', async () => {
  await harness(async ({ app, runsRoot }) => {
    const root = runsRoot('alpha', 'main')
    const files = { 'repairs.json': journal(journalEntry(1, { status: 'applied', applied_at: '2026-03-01T10:30:00.000000Z', reason: 'repair session round 1: review', session: { node: 'repair-1', launch_token: 't', session_id: 'abc-session' } })),
      'review-rounds.json': roundsFile(reviewRound(1)) }
    await writeRun(root, fixRun({ runId: 'old-live', version: '1.9.0', review: reviewSection(), values: reviewDone, tasks: [], files }))
    const old = await detailOf(app, 'old-live')
    assert.equal(old.fixLoop?.source, 'live')
    assert.equal(nodeOf(old, 'review')?.attempt, 2)
    assert.equal(validateReviewResult((await get(app, url('alpha', 'main', 'old-live', '/reviews/2'))).json()).attempt, 2)
    // The 1.9.0 shape of a run without session repairs: no fixLoop key, no repair node, the 1.9.0 keys of review and inputs only.
    await writeRun(root, fixRun({ runId: 'plain', version: '1.9.0', review: reviewSection(), values: reviewDone, tasks: [] }))
    const plain = await detailOf(app, 'plain')
    assert.deepEqual(Object.keys(plain).sort(), ['definition', 'run_dir', 'snapshot', 'summary'])
    assert.deepEqual(plain.definition.nodes.map(node => node.node_id), GRAPH_NODES.map(node => node.node_id))
    assert.equal(nodeOf(plain, 'review')?.attempt, 1)
    const review = validateReviewResult((await get(app, url('alpha', 'main', 'plain', '/reviews/1'))).json())
    assert.deepEqual(Object.keys(review).sort(), ['attempt', 'bundle_sha256', 'candidate_commit', 'contract_version', 'diff', 'findings', 'node_id', 'reviewed_at', 'reviewer', 'reviewers', 'run_id', 'verdict'])
    const inputs = validateRunInputs((await get(app, url('alpha', 'main', 'plain', '/inputs'))).json())
    assert.equal(inputs.workers.some(worker => 'roles' in worker || 'skills' in worker), false)
    assert.equal(inputs.automatic !== null && 'fix_rounds' in inputs.automatic, false)
    // A commit-only journal lists no session repair and adds no node.
    const commit = { n: 1, status: 'applied', mode: 'commit', reason: 'by hand', by: 'operator', via: 'claude-code', lanes: { ui: {}, adapter: {} }, recorded_at: T1, workspace_commit: OUTPUT }
    await writeRun(root, fixRun({ runId: 'commit-only', version: '1.9.0', review: reviewSection(), tasks: [], files: { 'repairs.json': journal(commit) } }))
    const commitOnly = await detailOf(app, 'commit-only')
    assert.equal(commitOnly.fixLoop, undefined)
    assert.equal(commitOnly.definition.nodes.some(node => node.node_id.startsWith('repair-')), false)
  })
})

test('[fix loop] 1.10.0 is accepted: inputs carry roles, skills and fix_rounds, and the review carries round, delta_from and delta_diff', async () => {
  await harness(async ({ app, runsRoot }) => {
    const skills = [{ name: 'impeccable', sha256: 'a'.repeat(64) }]
    const inputs = inputsSection({ automatic: { ...inputsSection().automatic!, fix_rounds: 2 } as never }, {
      ui: { roles: { model: 'claude-opus-4-8', effort: 'high' }, skills } as never, adapter: { roles: null, skills: [] } as never })
    await writeRun(runsRoot('alpha', 'main'), fixRun({ tasks: [], inputs, review: reviewSection({ round: 1, delta_from: null, delta_diff: null } as never) }))
    const served = validateRunInputs((await get(app, url('alpha', 'main', FIX_RUN, '/inputs'))).json())
    assert.equal(served.automatic?.fix_rounds, 2)
    assert.deepEqual(served.workers.map(worker => [worker.node_id, worker.roles, worker.skills]), [['ui', { model: 'claude-opus-4-8', effort: 'high' }, skills], ['adapter', null, []]])
    const review = validateReviewResult((await get(app, url('alpha', 'main', FIX_RUN, '/reviews/1'))).json())
    assert.deepEqual([review.round, review.delta_from, review.delta_diff], [1, null, null])
    assert.equal(await detailOf(app).then(detail => detail.fixLoop), undefined)
  })
})

test('[fix loop] a repair node reads running, failed or succeeded from its entry, and never enters the run status', async () => {
  await harness(async ({ app, runsRoot }) => {
    const root = runsRoot('alpha', 'main')
    const cases: [string, Record<string, unknown>, string][] = [
      ['launched', { status: 'launched' }, 'running'], ['captured', { status: 'captured' }, 'running'], ['recorded', { status: 'recorded' }, 'running'],
      ['applied', { status: 'applied', applied_at: T2, reason: 'repair session round 1: review' }, 'succeeded'],
      ['blocked', { status: 'blocked', reason: 'the repair session repair-1 ended without a completion file' }, 'failed'],
    ]
    const without = await (async () => { await writeRun(root, fixRun({ runId: 'without' })); return detailOf(app, 'without') })()
    for (const [name, over, status] of cases) {
      await writeRun(root, fixRun({ runId: `s-${name}`, files: { 'repairs.json': journal(journalEntry(1, over)), 'review-rounds.json': roundsFile(reviewRound(1)) } }))
      const detail = await detailOf(app, `s-${name}`)
      assert.equal(nodeOf(detail, 'repair-1')?.status, status, name)
      assert.deepEqual(nodeOf(detail, 'repair-1'), { node_id: 'repair-1', kind: 'worker', depends_on: ['review'], status, attempt: 1, session_id: null, result_uri: null, lane_results: [] })
      assert.equal(detail.fixLoop?.source, 'live')
      if (status !== 'running') assert.equal(detail.summary.status, without.summary.status, `${name}: the run status folds the pinned steps only`)
    }
    // While a repair runs, the step it answers is re-entered (running, its attempt unchanged) and the run is running.
    const running = await detailOf(app, 's-launched')
    assert.equal(nodeOf(running, 'review')?.status, 'running')
    assert.equal(nodeOf(without, 'review')?.status, 'failed')
    assert.equal(running.summary.status, 'running')
    assert.equal(without.summary.status, 'failed')
  })
})

test('[fix loop] a two-lane verify block re-enters every failed verify step while its repair runs, and a launched entry maps without an error', async () => {
  await harness(async ({ app, runsRoot }) => {
    const entry = journalEntry(3, {
      trigger: 'verify', round: 1, review_round: undefined, brief: undefined, lanes: { adapter: {} },
      blocked: { step: 'verify_ui, verify_adapter', packets: [{ node_id: 'ui', reasons: ['ui broke'] }, { node_id: 'adapter', reasons: ['adapter broke'] }] },
    })
    delete entry.review_round
    delete entry.brief
    await writeRun(runsRoot('alpha', 'main'), fixRun({
      tasks: [{ node_id: 'verify_ui', error: 'RuntimeError(blocked)', interrupts: [], result: null }, { node_id: 'verify_adapter', error: 'RuntimeError(blocked)', interrupts: [], result: null }],
      files: { 'repairs.json': journal(entry) },
    }))
    const detail = await detailOf(app)
    const loop = detail.fixLoop!
    assert.equal('error' in loop, false)
    assert.deepEqual(loop.repairs[0], {
      n: 3, node_id: 'repair-3', mode: 'session', lane: 'adapter', trigger: 'verify', round: 1, rounds: 2, status: 'launched', by: 'controller', recorded_at: '2026-03-01T10:12:00.000000Z',
      applied_at: null, blocked_step: 'verify_adapter', reentered_steps: ['verify_ui', 'verify_adapter'], reason: null, workspace_commit: OUTPUT, session_id: null, review_round: null,
      findings: [], delta: false, fix_files: [], left_behind: [], requested: null, gate_reasons: ['adapter broke'],
    })
    assert.deepEqual(['verify_ui', 'verify_adapter', 'repair-3'].map(id => nodeOf(detail, id)?.status), ['running', 'running', 'running'])
    assert.deepEqual(detail.definition.nodes.find(node => node.node_id === 'repair-3')?.depends_on, ['verify_adapter'])
    assert.equal(detail.summary.status, 'running')
    assert.equal(detail.summary.activity?.focus?.node_id, 'repair-3')
  })
})

test('[fix loop] failure isolation: an unknown status is the error form on the list and the detail; an unknown journal key is not an error', async () => {
  await harness(async ({ app, runsRoot }) => {
    const root = runsRoot('alpha', 'main')
    await writeRun(root, fixRun({ runId: 'bad-status', files: { 'repairs.json': journal(journalEntry(1, { status: 'exploded' })) } }))
    await writeRun(root, fixRun({ runId: 'extra-key', files: { 'repairs.json': journal(journalEntry(1, { status: 'applied', applied_at: T2, brand_new_key: { nested: true }, stop_pending: false })) } }))
    await writeRun(root, fixRun({ runId: 'no-lane', files: { 'repairs.json': journal(journalEntry(1, { lanes: {} })) } }))
    await writeRun(root, fixRun({ runId: 'bad-actor', files: { 'repairs.json': journal(journalEntry(1, { by: 'robot' })) } }))
    await writeRun(root, fixRun({ runId: 'garbage', files: { 'repairs.json': '{not json' } }))
    await writeRun(root, fixRun({ runId: 'other-step', files: { 'repairs.json': journal(journalEntry(1, { trigger: 'verify', lanes: { nobody: {} } })) } }))
    const warnings: string[] = []
    const list = await get(app, url('alpha', 'main'))
    assert.equal(list.status, 200)
    for (const runId of ['bad-status', 'no-lane', 'bad-actor', 'other-step']) {
      const response = await get(app, url('alpha', 'main', runId))
      assert.equal(response.status, 200, runId)
      const detail = validateRunDetail(response.json())
      const loop = detail.fixLoop!
      assert.ok('error' in loop && loop.error.length > 0, runId)
      assert.deepEqual([loop.rounds, loop.repairs, loop.review_rounds], [null, [], []])
      assert.equal(detail.definition.nodes.some(node => node.node_id.startsWith('repair-')), false)
      assert.equal(nodeOf(detail, 'review')?.status, 'failed')  // no repair, no re-entered step
    }
    const extra = await detailOf(app, 'extra-key')
    assert.equal(extra.fixLoop?.source, 'live')
    assert.equal('error' in extra.fixLoop!, false)
    assert.equal(nodeOf(extra, 'repair-1')?.status, 'succeeded')
    // An unreadable journal falls back to the export's record, and says so.
    const exportRecord = { version: '1.0.0', rounds: 2, repairs: [{ ...fixJson('expected.json').repairs[0], lane: 'ui', blocked_step: 'verify_ui', reentered_steps: ['verify_ui'] }], review_rounds: [] }
    await writeRun(root, fixRun({ runId: 'fallback', fixLoop: exportRecord, files: { 'repairs.json': '{not json' } }))
    const fallback = await detailOf(app, 'fallback')
    assert.equal(fallback.fixLoop?.source, 'export')
    assert.equal(nodeOf(fallback, 'repair-1')?.status, 'succeeded')
    void warnings
  })
})

test('[fix loop] the export path alone (no live journal): the export\'s fix_loop is served with source export, the error form too', async () => {
  await harness(async ({ app, runsRoot }) => {
    const root = runsRoot('alpha', 'main')
    const record = { version: '1.0.0', rounds: 2, repairs: [{ ...fixJson('expected.json').repairs[1], lane: 'ui', worker: undefined }], review_rounds: fixJson('expected.json').review_rounds.map((round: Record<string, unknown>) => ({ ...round, lane: 'ui' })) }
    await writeRun(root, fixRun({ runId: 'exp', tasks: [], fixLoop: record }))
    await writeRun(root, fixRun({ runId: 'exp-error', fixLoop: { version: '1.0.0', error: 'repairs.json has no repairs list', rounds: null, repairs: [], review_rounds: [] } }))
    await writeRun(root, fixRun({ runId: 'exp-null', fixLoop: null }))
    const exported = await detailOf(app, 'exp')
    assert.equal(exported.fixLoop?.source, 'export')
    assert.equal(nodeOf(exported, 'repair-2')?.status, 'succeeded')
    const error = (await detailOf(app, 'exp-error')).fixLoop!
    assert.deepEqual(['error' in error && error.error, error.source], ['repairs.json has no repairs list', 'export'])
    assert.equal((await detailOf(app, 'exp-null')).fixLoop, undefined)
  })
})

test('[fix loop] events of a repair session sit on its repair node: the repair-<n> token first, then the round counted per lane', async () => {
  await harness(async ({ app, runsRoot }) => {
    const rows: RawEvent[] = [
      { sequence: 10, time: T2, node: 'repair_ui', status: 'running', message: 'round 1: repair session launched (repair-4, the reviewed candidate 56c8ebd5, review block)' },
      { sequence: 11, time: T2, node: 'repair_ui', status: 'warning', message: 'repair session repair-4 stop not confirmed: no pid' },
      { sequence: 12, time: T2, node: 'repair_ui', status: 'passed', message: 'round 1: repair 4 applied; ui is verified again' },
      { sequence: 13, time: T2, node: 'repair_adapter', status: 'running', message: 'round 1: repair session launched (repair-5, the engine snapshot e5f9d0c7, verify block)' },
      { sequence: 14, time: T2, node: 'repair_adapter', status: 'failed', message: 'round 1: the repair session ended' },
      { sequence: 15, time: T2, node: 'repair_ghost', status: 'running', message: 'round 9: repair session launched' },
    ]
    const four = journalEntry(4, { status: 'applied', applied_at: T2 })
    const five = journalEntry(5, { trigger: 'verify', lanes: { adapter: {} }, status: 'blocked', reason: 'ended', review_round: undefined, brief: undefined, blocked: { step: 'verify_adapter', packets: [{ node_id: 'adapter', reasons: [] }] } })
    await writeRun(runsRoot('alpha', 'main'), fixRun({ events: [...reviewedEvents, ...rows], files: { 'repairs.json': journal(four, five), 'review-rounds.json': roundsFile(reviewRound(1)) } }))
    const events = ((await get(app, url('alpha', 'main', FIX_RUN, '/events'))).json() as { events: WorkflowEvent[] }).events
    assert.deepEqual(events.filter(event => event.sequence >= 10).map(event => [event.sequence, event.node_id, event.status]), [
      [10, 'repair-4', 'running'], [11, 'repair-4', null], [12, 'repair-4', 'succeeded'], [13, 'repair-5', 'running'], [14, 'repair-5', 'failed'], [15, null, null]])
  })
})

test('[fix loop] review rounds: the live review-rounds.json, the archived reviewers and a restored round; round k in review shows attempt k with the review section null', async () => {
  await harness(async ({ app, runsRoot }) => {
    const root = runsRoot('alpha', 'main')
    const archive = { reviewers: [{ reviewer_id: 'review', session_id: 's-1', verdict: 'blocked', accepted_at: T2 }, { reviewer_id: 'coverage', session_id: 's-2', verdict: 'approved', accepted_at: T2 }] }
    const applied = journalEntry(1, { status: 'applied', applied_at: T2, session: { node: 'repair-1', launch_token: 't', session_id: 'abc' } })
    await writeRun(root, fixRun({ runId: 'in-review', tasks: [], next: ['review'], events: reviewingEvents, files: { 'repairs.json': journal(applied), 'review-rounds.json': roundsFile(reviewRound(1)), 'review.round-1.json': json(archive) } }))
    const live = await detailOf(app, 'in-review')
    assert.equal(nodeOf(live, 'review')?.attempt, 2)  // review section null: one plus the archived rounds
    const loop = live.fixLoop as Extract<NonNullable<RunDetail['fixLoop']>, { rounds: number }>
    assert.deepEqual(loop.review_rounds[0].reviewers, [{ reviewer_id: 'review', verdict: 'blocked', session_id: 's-1' }, { reviewer_id: 'coverage', verdict: 'approved', session_id: 's-2' }])
    assert.equal(loop.review_rounds[0].repair_n, 1)
    // A restored round is one attempt: not archived, no reviewers, review.round 1.
    const restored = journalEntry(1, { status: 'blocked', reason: 'ended without a completion file' })
    await writeRun(root, fixRun({ runId: 'restored', review: reviewSection({ round: 1 } as never), values: reviewDone, tasks: [], files: { 'repairs.json': journal(restored), 'review-rounds.json': roundsFile(reviewRound(1, { archived: false, restored_at: T2 })) } }))
    const back = await detailOf(app, 'restored')
    assert.equal(nodeOf(back, 'review')?.attempt, 1)
    const rounds = (back.fixLoop as { review_rounds: { reviewers: unknown[]; restored_at: string | null }[] }).review_rounds
    assert.deepEqual([rounds[0].reviewers, rounds[0].restored_at], [[], '2026-03-01T10:10:00.000000Z'.replace('10:10:00.000000Z', '10:10:00.000000Z')])
    assert.equal(nodeOf(back, 'repair-1')?.status, 'failed')
    // A journal and a rounds file that disagree with the export: the live files win.
    assert.equal((await detailOf(app, 'restored')).fixLoop?.source, 'live')
  })
})
