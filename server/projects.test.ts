import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { schemas as projectSchemas, validateDefinition, validateReviewResult, validateRunDetail, validateRunInputs, type RunDetail } from '../contracts/projects/v1.ts'
import { eventSchema, validateWorkerResult } from '../contracts/workflow/v1.ts'
import { createApp } from './app.ts'
import { defaultFixtureRoot, fixtureLocations } from './config.ts'
import { PROJECTS_CONFIG_ENV, ProjectsConfigError, canonicalJson, definitionRevision, loadProjectsConfig, parseProjectsConfig } from './projectsConfig.ts'

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
}

/** One run directory exactly as workflow/export_state.py and workflow/checks.py persist it. */
async function writeRun(root: string, spec: RunSpec): Promise<string> {
  const dir = join(root, spec.runId)
  await mkdir(dir, { recursive: true })
  const runId = spec.exportRunId ?? spec.runId
  if (spec.diffFile !== undefined) await writeFile(join(dir, 'review.diff'), spec.diffFile)
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

    const live = validateRunDetail((await get(app, url('alpha', 'main', 'live'))).json())
    assert.equal(live.summary.status, 'awaiting_approval')
    const status = Object.fromEntries(live.snapshot.nodes.map(node => [node.node_id, node.status]))
    assert.deepEqual(status, { launch_ui: 'succeeded', launch_adapter: 'succeeded', handoff: 'awaiting_approval', verify_ui: 'pending', verify_adapter: 'pending', candidate: 'pending', review: 'pending', approval: 'pending', integrate: 'pending' })
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
    assert.deepEqual(inputs.automatic, { finish: 'verified-feature-branch', permission_mode: 'bypassPermissions', worker_timeout_seconds: 3600, review_timeout_seconds: 1800, reviewer_transport: 'native' })
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
    assert.deepEqual(inputs.challenge, { ...challengeSection(), decided_at: '2026-03-01T09:59:00.123456Z',
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
    { ...base, runId: 'unknown-version', version: '1.6.0', review: reviewSection(), inputs: inputsSection() },
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
