import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { schemas as projectSchemas, validateDefinition, validateRunDetail, type RunDetail } from '../contracts/projects/v1.ts'
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
  node: 'ui' | 'adapter'
  attempt?: number
  gate?: { status: 'passed' | 'blocked'; reasons: string[] }
  artifacts?: { id: string; kind: 'log' | 'screenshot' | 'test_report' | 'patch' | 'other'; content: Buffer | string; uri?: string; registeredSha?: string; skipWrite?: boolean }[]
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
}

/** One run directory exactly as workflow/export_state.py and workflow/checks.py persist it. */
async function writeRun(root: string, spec: RunSpec): Promise<string> {
  const dir = join(root, spec.runId)
  await mkdir(dir, { recursive: true })
  const runId = spec.exportRunId ?? spec.runId
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
      artifacts.push({ artifact_id: artifact.id, kind: artifact.kind, uri, sha256: artifact.registeredSha ?? sha256(content) })
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
  const state = {
    version: '1.0.0', run_id: runId, base_commit: BASE, created_at: created, definition: spec.definition ?? DEFINITION,
    values: { run_id: runId, ...(spec.values ?? {}) }, next: spec.next ?? [], tasks: spec.tasks ?? [], events,
    verification_packets: spec.registrations ? spec.registrations(registrations) : registrations, updated_at: spec.updated ?? T1,
  }
  await writeFile(join(dir, 'run-state.json'), spec.stateText ?? json(state))
  return dir
}

const receipt = (node: 'ui' | 'adapter') => ({
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

type Harness = { root: string; app: ReturnType<typeof createApp>; runsRoot: (project: string, workflow: string) => string }

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
    const before = await snapshotTree(runsRoot('alpha', 'main'))
    const routes = ['/api/projects', url('alpha'), url('alpha', 'main'), url('alpha', 'main', 'run-001'), url('alpha', 'main', 'run-001', '/events'),
      url('alpha', 'main', 'run-001', '/results/ui/1'), url('alpha', 'main', 'run-001', '/artifacts/log-0-abc')]
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
    // A packet whose result cannot satisfy the worker-result contract is a 500, not a partial payload.
    await writeRun(runsRoot('alpha', 'main'), { runId: 'broken', values: { ui: receipt('ui'), adapter: receipt('adapter'), snapshots }, next: ['verify_ui'], events: launchEvents,
      packets: [{ node: 'ui', mutate: packet => { (packet.result as Record<string, unknown>).changed_files = ['/absolute/leak.ts'] } }] })
    const broken = await get(app, url('alpha', 'main', 'broken', '/results/ui/1'))
    assertError(broken, 500, 'RESULT_INVALID')
    assert.ok(!broken.body.includes('/absolute/leak.ts'))
  })
})
