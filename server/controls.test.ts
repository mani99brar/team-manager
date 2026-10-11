import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { spawn as realSpawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { CONTROL_IDS, controlErrorSchema, controlResponseSchema, runControlsSchema, type ControlId, type RunControls } from '../contracts/projects/controls.ts'
import * as examples from '../contracts/projects/examples.ts'
import { createApp } from './app.ts'
import { ANSWER_PANE_REASON } from './controls.ts'
import { loadControlsConfig } from './controlsGuard.ts'
import { deviceNumbers, probeLock, type SpawnFn } from './controlsRunner.ts'
import { parseProjectsConfig } from './projectsConfig.ts'

/**
 * Every test isolates its paths under a temporary root and HOME: a recording spawner (no real systemd-run, no real controller), an injected
 * clock, a fake /proc tree. The real ~/.config, ~/.local/state, ~/.claude and systemd are never touched.
 */
const TOKEN = 'test-pairing-token-0123456789abcdef-0123'
const WEB_PORT = '5173'
const BASE = 'a'.repeat(40)
const T0 = '2026-03-01T10:00:00.000000Z'
const NOW = new Date('2026-10-10T12:00:00.000Z')
const PROJECT = 'alpha'
const WORKFLOW = 'main'
const DIGEST = 'c'.repeat(64)

// ---- Seeding runs in the producer's format ---------------------------------------------------------------------------

type RawEvent = { sequence: number; time: string; node: string; status: string; message: string }

function graph(lanes: string[], challenge: boolean) {
  const gate = challenge ? ['challenge'] : []
  return [
    ...(challenge ? [{ node_id: 'challenge', label: 'Design challenge', kind: 'review', depends_on: [] }] : []),
    ...lanes.map(lane => ({ node_id: `launch_${lane}`, label: `Launch ${lane} worker`, kind: 'worker', depends_on: gate })),
    { node_id: 'handoff', label: 'Freeze worker handoffs', kind: 'prepare', depends_on: lanes.map(lane => `launch_${lane}`) },
    ...lanes.map(lane => ({ node_id: `verify_${lane}`, label: `Verify ${lane}`, kind: 'verification', depends_on: ['handoff'] })),
    { node_id: 'candidate', label: 'Verify combined candidate', kind: 'verification', depends_on: lanes.map(lane => `verify_${lane}`) },
    { node_id: 'review', label: 'Independent review', kind: 'review', depends_on: ['candidate'] },
    { node_id: 'approval', label: 'Integration approval', kind: 'integration', depends_on: ['review'] },
    { node_id: 'integrate', label: 'Integrate candidate', kind: 'integration', depends_on: ['approval'] },
  ]
}

const workerInput = { role: 'builder', required_check_kinds: ['build'], task: '# task', prompt: null, owned_paths: ['src'], checks: [{ id: 'build', kind: 'build', argv: ['npm', 'run', 'build'], command: 'npm run build', timeout_seconds: 60, scenarios: [] }], launch: null, completion: null, handoff: null, stop: null, questions: [] }

function challengeSection(overrides: Record<string, unknown> = {}) {
  return {
    status: 'paused', attempt: 1, attempts: 1, session_id: 'challenge-session-1',
    pinned: { tasks_sha256: 'a'.repeat(64), decisions_sha256: 'b'.repeat(64), prd_sha256: null },
    concerns: [
      { severity: 'P1', kind: 'failure_mode', message: 'One', consequence: 'Bad one.' },
      { severity: 'P1', kind: 'assumption', message: 'Two', consequence: 'Bad two.' },
    ],
    simpler_alternative: 'One lane.', cheap_experiment: 'Diff the paths.', accepted_reason: null, decided_at: '2026-03-01T09:59:00.000000Z', ...overrides,
  }
}

type Seed = {
  next?: string[]
  tasks?: { node_id: string; error: string | null; interrupts: Record<string, unknown>[]; result: null }[]
  events?: RawEvent[]
  automatic?: boolean
  finish?: string
  challenge?: Record<string, unknown>
  accepted?: boolean
  files?: Record<string, unknown>
  version?: string
}

const lanes = ['ui', 'adapter']
let tick = 0

async function seedRun(runsRoot: string, runId: string, seed: Seed = {}): Promise<string> {
  const dir = join(runsRoot, runId)
  await mkdir(dir, { recursive: true })
  const events = seed.events ?? [{ sequence: 1, time: T0, node: 'ui', status: 'running', message: 'Launching or reconciling the exact native session' }]
  await writeFile(join(dir, 'events.jsonl'), events.map(event => `${JSON.stringify(event)}\n`).join(''))
  const automatic = seed.automatic ?? true
  await writeFile(join(dir, 'plan.json'), JSON.stringify({
    run_id: runId, base_commit: BASE, workers: lanes, ...(automatic ? { automatic: { finish: seed.finish ?? 'approval' } } : {}), ...(seed.challenge ? { challenge: true } : {}),
  }))
  const inputs = {
    feature: 'Seeded feature', policy_version: '1.1.0', base_commit: BASE, source_branch: 'feature/seed', mode: automatic ? 'automatic' : 'manual',
    automatic: automatic ? { finish: seed.finish ?? 'approval', permission_mode: 'bypassPermissions', worker_timeout_seconds: 3600, review_timeout_seconds: 1800, reviewer_transport: 'native' } : null,
    setup: [], max_verification_attempts: 3, failure_drill: null, selected_workers: lanes, workers: { ui: workerInput, adapter: workerInput },
    ...(seed.challenge ? { decisions: null, challenge: seed.challenge } : {}),
  }
  const state = {
    version: seed.version ?? '1.7.0', run_id: runId, base_commit: BASE, created_at: T0, updated_at: `2026-03-01T10:0${tick++ % 10}:00.000000Z`,
    definition: { name: 'Feature implementation', nodes: graph(lanes, seed.challenge !== undefined) }, values: { run_id: runId }, next: seed.next ?? ['verify_ui'],
    tasks: seed.tasks ?? [], events, verification_packets: [], inputs,
    ...(seed.accepted ? { accepted: { version: '1.0.0', run_id: runId, candidate: 'b'.repeat(40), reason: 'merged by hand', by: 'operator', accepted_at: '2026-10-08T09:30:00Z', on_main: true, review: 'recorded', open_findings: [] } } : {}),
  }
  await writeFile(join(dir, 'run-state.json'), JSON.stringify(state, null, 2))
  for (const [name, content] of Object.entries(seed.files ?? {})) await writeFile(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content))
  return dir
}

const freeze: RawEvent = { sequence: 2, time: T0, node: 'handoff', status: 'succeeded', message: 'Worker handoffs frozen' }
const handoffTask = { node_id: 'handoff', error: null, interrupts: [{ kind: 'worker_handoff' }], result: null }
const failedVerify = { node_id: 'verify_ui', error: 'Gate blocked', interrupts: [], result: null }

const SEEDS = {
  stopped: { next: ['verify_ui'] } as Seed,
  failedVerify: { tasks: [failedVerify] } as Seed,
  needsReconciliation: { files: { 'ui.interactive.json': { status: 'needs_reconciliation' } } } as Seed,
  paused: { challenge: challengeSection(), next: [] } as Seed,
  held: { challenge: challengeSection({ status: 'passed', concerns: [{ severity: 'P2', kind: 'complexity', message: 'One', consequence: 'Slow.' }, { severity: 'P2', kind: 'complexity', message: 'Two', consequence: 'Slow.' }], hold: { held_at: T0, released_at: null, released_by: null, dropped: [] } }), next: [] } as Seed,
  question: { files: { 'ui.questions.json': { node_id: 'ui', questions: [{ n: 1, question: 'Which port?', asked_at: T0, answer: null, answered_at: null }] } } } as Seed,
  awaitingApproval: { next: [], tasks: [{ node_id: 'approval', error: null, interrupts: [{ kind: 'integration_approval', bundle_sha256: DIGEST }], result: null }] } as Seed,
  blockedAfterFreeze: { tasks: [handoffTask, failedVerify], events: [{ sequence: 1, time: T0, node: 'ui', status: 'running', message: 'x' }, freeze] } as Seed,
  abandoned: { files: { 'abandon.json': { reason: 'give up', by: 'operator', abandoned_at: T0 } }, events: [{ sequence: 1, time: T0, node: 'controller', status: 'cancelled', message: 'Abandoned by the operator: give up' }] } as Seed,
  finished: { accepted: true, next: [] } as Seed,
}

// ---- A fake /proc (proc(5): locks lines, cmdline NUL-separated, stat fields 5 and 22, btime) ---------------------------------

/** Independent of server code: the kernel's split of a device number, written out the long way. */
function kernelDevice(dev: bigint): [bigint, bigint] {
  const major = ((dev >> 8n) & 0xfffn) + (((dev >> 32n) & 0xfffff000n))
  const minor = (dev & 0xffn) + ((dev >> 12n) & 0xffffff00n)
  return [major, minor]
}

class FakeProc {
  readonly locks: string[] = []
  readonly root: string
  constructor(root: string) { this.root = root }

  async init() {
    await mkdir(this.root, { recursive: true })
    await writeFile(join(this.root, 'stat'), 'cpu  1 2 3\nbtime 1790000000\n')
    await this.flush()
  }

  private async flush() {
    await writeFile(join(this.root, 'locks'), this.locks.map((line, index) => `${index + 1}: ${line}\n`).join(''))
  }

  async hold(lockFile: string, pid: number, cmdline: string[], options: { pgrp?: number; ticks?: number } = {}) {
    await writeFile(lockFile, '', { flag: 'a' })
    const info = statSync(lockFile, { bigint: true })
    const [major, minor] = kernelDevice(info.dev)
    this.locks.push(`FLOCK  ADVISORY  WRITE ${pid} ${major.toString(16).padStart(2, '0')}:${minor.toString(16).padStart(2, '0')}:${info.ino} 0 EOF`)
    await mkdir(join(this.root, String(pid)), { recursive: true })
    await writeFile(join(this.root, String(pid), 'cmdline'), `${cmdline.join('\0')}\0`)
    const fields = Array.from({ length: 22 }, () => '0')
    fields[0] = 'S'; fields[5 - 3] = String(options.pgrp ?? pid); fields[22 - 3] = String(options.ticks ?? 60000)
    await writeFile(join(this.root, String(pid), 'stat'), `${pid} (python3) ${fields.join(' ')}\n`)
    await this.flush()
  }

  async release() {
    this.locks.length = 0
    await this.flush()
  }
}

// ---- The rig ----------------------------------------------------------------------------------------------------------------

type Spawned = { command: string; args: string[]; cwd: unknown; env: NodeJS.ProcessEnv | undefined; stdio: unknown; shell: unknown; detached: unknown }

class FakeChild extends EventEmitter {
  pid: number
  constructor(pid: number) { super(); this.pid = pid }
  unref() {}
}

function recorder() {
  const calls: Spawned[] = []
  const children: FakeChild[] = []
  const output: string[] = []
  const gate: { wait: Promise<void> | null } = { wait: null }
  const auto: { code: number | null } = { code: null }
  const spawn: SpawnFn = async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd, env: options.env, stdio: options.stdio, shell: options.shell, detached: options.detached })
    if (gate.wait) await gate.wait
    const child = new FakeChild(5000 + calls.length)
    children.push(child)
    const text = output.shift()
    const fd = Array.isArray(options.stdio) ? options.stdio[1] : undefined
    if (text !== undefined && typeof fd === 'number') writeSync(fd, text)
    if (auto.code !== null) { const code = auto.code; setImmediate(() => child.emit('exit', code, null)) }
    return child as unknown as ChildProcess
  }
  return { calls, children, output, gate, auto, spawn, exit: (index: number, code: number | null, signal: NodeJS.Signals | null = null) => children[index].emit('exit', code, signal) }
}

type RigOptions = {
  root?: string
  env?: Record<string, string>
  mode?: 'systemd' | 'direct'
  kill?: (pid: number, signal: NodeJS.Signals) => void
  spawn?: SpawnFn
  timeoutMs?: number
  seeds?: Record<string, Seed>
}

async function rig(options: RigOptions = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'md-manager-controls-'))
  const home = join(root, 'home')
  const wfhome = join(root, 'wfhome')
  const python = join(root, 'bin', 'python')
  const runsRoot = join(root, 'runs')
  await mkdir(join(home, '.config', 'md-manager'), { recursive: true })
  await mkdir(wfhome, { recursive: true })
  await mkdir(join(root, 'bin'), { recursive: true })
  await mkdir(runsRoot, { recursive: true })
  await writeFile(python, '#!/bin/sh\nexit 0\n')
  await chmod(python, 0o755)
  const tokenFile = join(home, '.config', 'md-manager', 'controls.token')
  await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 })
  await chmod(tokenFile, 0o600)
  const proc = new FakeProc(join(root, 'proc'))
  await proc.init()
  const env: Record<string, string> = {
    HOME: home, PATH: '/usr/bin:/bin', MD_MANAGER_RUN_CONTROLS: 'on', MD_MANAGER_WORKFLOW_PYTHON: python, MD_MANAGER_WORKFLOW_HOME: wfhome,
    MD_MANAGER_CONTROLS_STATE: join(root, 'state'), MD_MANAGER_CONTROLS_PROC: proc.root, MD_MANAGER_CONTROLS_SPAWN: options.mode ?? 'direct',
    MD_MANAGER_WEB_PORT: WEB_PORT, MD_MANAGER_API_PORT: '3001', CLAUDECODE: '1', ...options.env,
  }
  const setup = await loadControlsConfig(env)
  const spawner = recorder()
  const config = await parseProjectsConfig(JSON.stringify({
    version: 1,
    projects: [{ project_id: PROJECT, name: PROJECT, repository: join(root, 'repo'), workflows: [{ workflow_id: WORKFLOW, runs_root: runsRoot, definition: { name: 'Feature implementation', nodes: graph(lanes, false) } }] }],
  }), 'test registry')
  const kills: [number, NodeJS.Signals][] = []
  const app: FastifyInstance = createApp([], {
    projects: config,
    controls: {
      setup, now: () => NOW,
      runner: { spawn: options.spawn ?? spawner.spawn, kill: options.kill ?? ((pid, signal) => { kills.push([pid, signal]) }), systemdRun: true, timeoutMs: options.timeoutMs },
    },
  })
  const url = (run: string, tail = '') => `/api/run-controls/${PROJECT}/${WORKFLOW}/${run}${tail}`
  const headers = (extra: Record<string, string | undefined> = {}) => {
    const all: Record<string, string | undefined> = {
      'content-type': 'application/json', host: `127.0.0.1:${WEB_PORT}`, origin: `http://127.0.0.1:${WEB_PORT}`, 'sec-fetch-site': 'same-origin', 'x-mdm-control-token': TOKEN, ...extra,
    }
    return Object.fromEntries(Object.entries(all).filter(([, value]) => value !== undefined)) as Record<string, string>
  }
  const controls = async (run: string): Promise<RunControls> => {
    const response = await app.inject({ method: 'GET', url: url(run), headers: headers() })
    assert.equal(response.statusCode, 200, response.body)
    return runControlsSchema.parse(response.json())
  }
  const post = (run: string, control: string, params: Record<string, unknown>, extra: { token?: string; request_id?: string; headers?: Record<string, string | undefined>; body?: Record<string, unknown> } = {}) =>
    app.inject({
      method: 'POST', url: url(run, `/${control}`), headers: headers(extra.headers),
      payload: JSON.stringify(extra.body ?? { request_id: extra.request_id ?? crypto.randomUUID(), run_state_token: extra.token, params }),
    })
  /** The state token the page would hold, then the POST. */
  const act = async (run: string, control: string, params: Record<string, unknown> = {}, extra: { request_id?: string; headers?: Record<string, string | undefined> } = {}) =>
    post(run, control, params, { ...extra, token: (await controls(run)).run_state_token })
  const seed = (run: string, spec: Seed) => seedRun(runsRoot, run, spec)
  for (const [run, spec] of Object.entries(options.seeds ?? {})) await seed(run, spec)
  const close = async (remove = true) => { await app.close(); if (remove) await rm(root, { recursive: true, force: true }) }
  return { root, home, wfhome, python, runsRoot, proc, env, setup, spawner, kills, app, url, headers, controls, post, act, seed, close }
}

async function withRig(options: RigOptions, body: (r: Awaited<ReturnType<typeof rig>>) => Promise<void>) {
  const r = await rig(options)
  try { await body(r) } finally { await r.close() }
}

const errorOf = (response: { json: () => unknown }) => controlErrorSchema.parse(response.json()).error
const byId = (controls: RunControls, id: ControlId) => controls.controls.find(control => control.id === id)!
const readFileSyncSafe = (path: string) => { try { return readFileSync(path, 'utf8') } catch { return '' } }
const unitFor = (run: string, n: number) => `mdm-control-${createHash('sha256').update(`${PROJECT}/${WORKFLOW}/${run}`).digest('hex').slice(0, 8)}-${n}`
async function waitFor(condition: () => boolean, what: string) {
  for (let attempt = 0; attempt < 400 && !condition(); attempt++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(condition(), `timed out waiting for ${what}`)
}

// ---- Startup environment ([L5]) ------------------------------------------------------------------------------------------

test('[L5] each failed startup condition leaves the controls off with a warning naming it', async () => {
  const r = await rig()
  try {
    const base = { ...r.env }
    assert.equal(r.setup.enabled, true)
    const token = base.MD_MANAGER_CONTROLS_TOKEN_FILE ?? join(r.home, '.config', 'md-manager', 'controls.token')
    const cases: [string, () => Promise<void>, Record<string, string>, RegExp][] = [
      ['unset', async () => {}, { MD_MANAGER_RUN_CONTROLS: 'off' }, /^$/],
      ['token mode 0644', async () => { await chmod(token, 0o644) }, {}, /token file must not be readable/],
      ['token under 32 characters', async () => { await writeFile(token, 'short\n', { mode: 0o600 }); await chmod(token, 0o600) }, {}, /at least 32 characters/],
      ['relative python', async () => {}, { MD_MANAGER_WORKFLOW_PYTHON: 'python3' }, /absolute path/],
      ['non-executable python', async () => { await chmod(r.python, 0o644) }, {}, /not an executable file/],
      ['missing token file', async () => { await rm(token) }, {}, /cannot be read/],
    ]
    for (const [name, prepare, change, warning] of cases) {
      await writeFile(token, `${TOKEN}\n`, { mode: 0o600 }); await chmod(token, 0o600); await chmod(r.python, 0o755)
      await prepare()
      const setup = await loadControlsConfig({ ...base, ...change })
      assert.equal(setup.enabled, false, name)
      if (name === 'unset') assert.deepEqual(setup.warnings, [])
      else assert.match(setup.warnings.join('\n'), warning, name)
      assert.ok(!setup.warnings.join('\n').includes(TOKEN), 'the token is never in a warning')
    }
    // A symlinked token file is refused too (no-follow open).
    await rm(token, { force: true }); await writeFile(join(r.root, 'real.token'), `${TOKEN}\n`, { mode: 0o600 }); await symlink(join(r.root, 'real.token'), token)
    assert.equal((await loadControlsConfig(base)).enabled, false)
  } finally { await r.close() }
})

test('[L5] a disabled setup serves status enabled:false and 404 CONTROLS_DISABLED everywhere else', async () => {
  await withRig({ seeds: { r1: SEEDS.stopped }, env: { MD_MANAGER_WORKFLOW_PYTHON: 'relative-python' } }, async r => {
    assert.equal(r.setup.enabled, false)
    const status = await r.app.inject({ method: 'GET', url: '/api/run-controls/status' })
    assert.equal(status.statusCode, 200)
    assert.deepEqual(status.json(), { version: '1.0.0', enabled: false, paired: false })
  })
})

test('[disabled] controls off: every control route is 404 CONTROLS_DISABLED, nothing spawns, /api/projects stays read-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'md-manager-controls-'))
  try {
    await mkdir(join(root, 'runs'), { recursive: true })
    await seedRun(join(root, 'runs'), 'r1')
    const config = await parseProjectsConfig(JSON.stringify({ version: 1, projects: [{ project_id: PROJECT, name: PROJECT, repository: join(root, 'repo'), workflows: [{ workflow_id: WORKFLOW, runs_root: join(root, 'runs'), definition: { name: 'x', nodes: graph(lanes, false) } }] }] }), 'x')
    for (const app of [createApp([], { projects: config }), createApp([], { projects: config, controls: { setup: { enabled: false, warnings: [] } } })]) {
      for (const [method, url] of [['GET', `/api/run-controls/${PROJECT}/${WORKFLOW}/r1`], ['POST', `/api/run-controls/${PROJECT}/${WORKFLOW}/r1/restart`],
        ['POST', `/api/run-controls/${PROJECT}/${WORKFLOW}/r1/clean-preview`], ['GET', `/api/run-controls/${PROJECT}/${WORKFLOW}/r1/records/c-000000000000`], ['GET', '/api/run-controls/nothing']] as const) {
        const response = await app.inject({ method, url, headers: { 'content-type': 'application/json' }, payload: method === 'POST' ? '{}' : undefined })
        assert.equal(response.statusCode, 404, `${method} ${url}`)
        assert.equal(errorOf(response).code, 'CONTROLS_DISABLED')
      }
      const status = await app.inject({ method: 'GET', url: '/api/run-controls/status' })
      assert.deepEqual(status.json(), { version: '1.0.0', enabled: false, paired: false })
      const projects = await app.inject({ method: 'POST', url: `/api/projects/${PROJECT}/workflows/${WORKFLOW}/runs/r1`, payload: {} })
      assert.equal(projects.statusCode, 405)
      assert.equal((await app.inject({ method: 'GET', url: '/api/projects' })).statusCode, 200)
      await app.close()
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('[enabled] the Projects API still answers 405 to a POST and status reports paired only with the token', async () => {
  await withRig({ seeds: { r1: SEEDS.stopped } }, async r => {
    assert.equal((await r.app.inject({ method: 'POST', url: `/api/projects/${PROJECT}/workflows/${WORKFLOW}/runs/r1`, payload: {} })).statusCode, 405)
    assert.equal((await r.app.inject({ method: 'POST', url: '/api/projects', payload: {} })).statusCode, 405)
    assert.deepEqual((await r.app.inject({ method: 'GET', url: '/api/run-controls/status' })).json(), { version: '1.0.0', enabled: true, paired: false })
    assert.deepEqual((await r.app.inject({ method: 'GET', url: '/api/run-controls/status', headers: { 'x-mdm-control-token': TOKEN } })).json(), { version: '1.0.0', enabled: true, paired: true })
    assert.equal(((await r.app.inject({ method: 'GET', url: '/api/run-controls/status', headers: { 'x-mdm-control-token': 'x'.repeat(40) } })).json() as { paired: boolean }).paired, false)
  })
})

// ---- Acceptance 1: argv ----------------------------------------------------------------------------------------------------

const PY = (r: { python: string }) => r.python
const BY = ['--by', 'operator']

test('[argv] each control runs exactly one fixed command; free text is one argv element', async () => {
  await withRig({ env: { HERDR_ENV: '1' }, seeds: {
    'run-restart': SEEDS.stopped, 'run-retry': SEEDS.failedVerify, 'run-reconcile': SEEDS.needsReconciliation, 'run-resume': SEEDS.paused,
    'run-accept': SEEDS.paused, 'run-release': SEEDS.held, 'run-approve': SEEDS.awaitingApproval, 'run-repair': SEEDS.blockedAfterFreeze,
    'run-abandon': SEEDS.stopped, 'run-clean': SEEDS.finished,
    'run-answer': { ...SEEDS.question, files: { ...SEEDS.question.files, 'terminals.json': { ui: { pane_id: 'p-1' } } } },
  } }, async r => {
    const text = 'Use "quotes", $HOME and --flags; `ticks` & newlines\nsecond line'
    const reason = 'Ten or more characters of reason; with $(shell) syntax'
    const table: { run: string; control: ControlId; params: Record<string, unknown>; argv: (run: string) => string[]; status: 200 | 202 }[] = [
      { run: 'run-restart', control: 'restart', params: {}, argv: run => ['-m', 'workflow', 'automatic', join(r.runsRoot, run), '--live', ...BY], status: 202 },
      { run: 'run-retry', control: 'retry', params: { lane: 'ui', phase: 'worker' }, argv: run => ['-m', 'workflow', 'retry', join(r.runsRoot, run), '--phase', 'worker', '--node', 'ui', ...BY], status: 200 },
      { run: 'run-reconcile', control: 'reconcile', params: {}, argv: run => ['-m', 'workflow', 'reconcile', join(r.runsRoot, run), ...BY], status: 200 },
      { run: 'run-resume', control: 'resume', params: {}, argv: run => ['-m', 'workflow', 'resume', join(r.runsRoot, run), ...BY], status: 202 },
      { run: 'run-accept', control: 'accept_challenge', params: { reason }, argv: run => ['-m', 'workflow', 'resume', join(r.runsRoot, run), `--accept-challenge=${reason}`, ...BY], status: 202 },
      { run: 'run-release', control: 'release_hold', params: { drop: [2, 1] }, argv: run => ['-m', 'workflow', 'resume', join(r.runsRoot, run), '--launch', '--drop', '1,2', ...BY], status: 202 },
      { run: 'run-answer', control: 'answer', params: { lane: 'ui', text }, argv: run => ['-m', 'workflow', 'answer', join(r.runsRoot, run), 'ui', ...BY, '--', text], status: 200 },
      // [L1] 1: the digest comes from run-state.json, never from the request.
      { run: 'run-approve', control: 'approve', params: { confirm_run_id: 'run-approve' }, argv: run => ['-m', 'workflow', 'approve', join(r.runsRoot, run), '--bundle-sha256', DIGEST, ...BY], status: 200 },
      { run: 'run-repair', control: 'repair_session', params: { lane: 'ui', confirm_run_id: 'run-repair' }, argv: run => ['-m', 'workflow', 'repair', join(r.runsRoot, run), 'ui', '--session', '--live', ...BY], status: 202 },
      { run: 'run-abandon', control: 'abandon', params: { reason, confirm_run_id: 'run-abandon' }, argv: run => ['-m', 'workflow', 'abandon', join(r.runsRoot, run), `--reason=${reason}`, ...BY], status: 200 },
      { run: 'run-clean', control: 'clean', params: { confirm_run_id: 'run-clean' }, argv: run => ['-m', 'workflow', 'clean', join(r.runsRoot, run), ...BY], status: 200 },
    ]
    for (const row of table) {
      const before = r.spawner.calls.length
      r.spawner.auto.code = row.status === 200 ? 0 : null
      const response = await r.act(row.run, row.control, row.params)
      assert.equal(response.statusCode, row.status, `${row.control}: ${response.body}`)
      assert.equal(r.spawner.calls.length, before + 1, `${row.control} spawns once`)
      const call = r.spawner.calls[before]
      assert.equal(call.command, PY(r))
      assert.deepEqual(call.args, row.argv(row.run), row.control)
      assert.equal(call.cwd, r.wfhome)
      assert.equal(call.shell, false, 'no shell')
      assert.equal(call.env?.CLAUDECODE, undefined, 'the child environment drops CLAUDECODE')
      assert.equal(call.env?.HOME, r.home)
    }
    // The shown record carries the parameters, not the typed run id.
    const shown = (await r.controls('run-abandon')).records[0]
    assert.deepEqual(shown.params, { reason })
    assert.equal(shown.command, `$PY -m workflow abandon "$RUN" --reason=${JSON.stringify(reason)} --by operator`)
    assert.equal(shown.status, 'succeeded')
  })
})

test('[argv] the approve digest is never taken from the request', async () => {
  await withRig({ seeds: { a1: SEEDS.awaitingApproval } }, async r => {
    const token = (await r.controls('a1')).run_state_token
    const response = await r.post('a1', 'approve', { confirm_run_id: 'a1', bundle_sha256: 'e'.repeat(64) } as never, { token })
    assert.equal(response.statusCode, 400)
    assert.equal(errorOf(response).code, 'INVALID_PARAMS')
    assert.equal(r.spawner.calls.length, 0)
    const shown = byId(await r.controls('a1'), 'approve')
    assert.equal(shown.command, `$PY -m workflow approve "$RUN" --bundle-sha256 ${DIGEST.slice(0, 12)}… --by operator`)
  })
})

test('[params] invalid lane, phase, NUL, over-long text and a wrong typed run id are 400 INVALID_PARAMS and spawn nothing', async () => {
  await withRig({ env: { HERDR_ENV: '1' }, seeds: {
    f1: SEEDS.failedVerify, q1: { ...SEEDS.question, files: { ...SEEDS.question.files, 'terminals.json': { ui: { pane_id: 'p' } } } }, s1: SEEDS.stopped, p1: SEEDS.paused,
  } }, async r => {
    const bad: [string, string, Record<string, unknown>][] = [
      ['f1', 'retry', { lane: 'nope', phase: 'worker' }], ['f1', 'retry', { lane: 'ui', phase: 'review' }], ['f1', 'retry', { lane: 'adapter', phase: 'worker' }],
      ['f1', 'retry', { lane: 'ui' }], ['f1', 'retry', { lane: 'ui', phase: 'worker', extra: 1 }], ['f1', 'retry', { lane: '../ui', phase: 'worker' }],
      ['q1', 'answer', { lane: 'ui', text: 'has\0nul' }], ['q1', 'answer', { lane: 'ui', text: 'x'.repeat(4001) }], ['q1', 'answer', { lane: 'ui', text: '' }], ['q1', 'answer', { lane: 'adapter', text: 'ok' }],
      ['s1', 'abandon', { reason: 'fine reason', confirm_run_id: 'other-run' }], ['s1', 'abandon', { reason: 'fine reason' }], ['s1', 'abandon', { reason: 'r\0', confirm_run_id: 's1' }],
      ['s1', 'abandon', { reason: 'x'.repeat(501), confirm_run_id: 's1' }], ['s1', 'restart', { lane: 'ui' }],
      ['p1', 'accept_challenge', { reason: 'too short' }], ['p1', 'accept_challenge', { reason: 'x'.repeat(501) }],
    ]
    for (const [run, control, params] of bad) {
      const response = await r.act(run, control, params)
      assert.equal(response.statusCode, 400, `${control} ${JSON.stringify(params).slice(0, 60)}: ${response.body.slice(0, 120)}`)
      assert.equal(errorOf(response).code, 'INVALID_PARAMS')
    }
    // A malformed body, an unknown control and an invalid id.
    const token = (await r.controls('s1')).run_state_token
    assert.equal(errorOf(await r.post('s1', 'restart', {}, { token, body: { request_id: 'not-a-uuid', run_state_token: token, params: {} } })).code, 'INVALID_PARAMS')
    assert.equal(errorOf(await r.post('s1', 'restart', {}, { token, body: { request_id: crypto.randomUUID(), params: {} } })).code, 'INVALID_PARAMS')
    assert.equal((await r.post('s1', 'explode', {}, { token })).statusCode, 404)
    assert.equal(errorOf(await r.app.inject({ method: 'POST', url: `/api/run-controls/${PROJECT}/${WORKFLOW}/..bad/restart`, headers: r.headers(), payload: '{}' })).code, 'INVALID_ID')
    assert.equal(r.spawner.calls.length, 0)
  })
})

// ---- Acceptance 2: guards --------------------------------------------------------------------------------------------------

test('[guards] each guard of PRD 5.2 alone refuses with its code and spawns nothing', async () => {
  await withRig({ seeds: { g1: SEEDS.stopped } }, async r => {
    r.spawner.auto.code = 0
    const token = (await r.controls('g1')).run_state_token
    const cases: [string, Record<string, string | undefined>, number, string][] = [
      ['form content type', { 'content-type': 'application/x-www-form-urlencoded' }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
      ['text/plain', { 'content-type': 'text/plain' }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
      ['no content type', { 'content-type': undefined }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
      ['foreign host', { host: 'evil.example:5173' }, 403, 'FORBIDDEN_ORIGIN'],
      ['rebinding host on another port', { host: '127.0.0.1:9999' }, 403, 'FORBIDDEN_ORIGIN'],
      ['missing origin', { origin: undefined }, 403, 'FORBIDDEN_ORIGIN'],
      ['foreign origin', { origin: 'http://evil.example:5173' }, 403, 'FORBIDDEN_ORIGIN'],
      ['https origin', { origin: `https://127.0.0.1:${WEB_PORT}` }, 403, 'FORBIDDEN_ORIGIN'],
      ['other port origin', { origin: 'http://127.0.0.1:5174' }, 403, 'FORBIDDEN_ORIGIN'],
      ['cross-site fetch metadata', { 'sec-fetch-site': 'cross-site' }, 403, 'FORBIDDEN_ORIGIN'],
      ['same-site fetch metadata', { 'sec-fetch-site': 'same-site' }, 403, 'FORBIDDEN_ORIGIN'],
      ['missing token', { 'x-mdm-control-token': undefined }, 403, 'TOKEN_REQUIRED'],
      ['wrong token', { 'x-mdm-control-token': `${TOKEN}x` }, 403, 'TOKEN_INVALID'],
      ['short wrong token', { 'x-mdm-control-token': 'a' }, 403, 'TOKEN_INVALID'],
    ]
    for (const [name, headers, status, code] of cases) {
      const response = await r.post('g1', 'restart', {}, { token, headers })
      assert.equal(response.statusCode, status, name)
      assert.equal(errorOf(response).code, code, name)
      assert.ok(!response.body.includes(TOKEN), 'the token is never returned')
    }
    // [L7]: an Origin on the API port is refused, as is a Host that is not loopback on the web or API port.
    for (const host of ['127.0.0.1:3001', 'localhost:3001']) {
      const response = await r.post('g1', 'restart', {}, { token, headers: { host, origin: `http://${host}` } })
      assert.equal(errorOf(response).code, 'FORBIDDEN_ORIGIN', host)
    }
    for (const host of ['mac.local:5173', 'mac.local:3001', '127.0.0.1:9999']) {
      const response = await r.post('g1', 'restart', {}, { token, headers: { host, origin: `http://127.0.0.1:${WEB_PORT}` } })
      assert.equal(errorOf(response).code, 'FORBIDDEN_ORIGIN', host)
    }
    // [L7]: the dev proxy's Host (the API's own port) passes with a web-port Origin.
    for (const host of ['127.0.0.1:3001', 'localhost:3001']) {
      const response = await r.post('g1', 'abandon', { reason: 'ok reason', confirm_run_id: 'other' }, { token, headers: { host, origin: `http://127.0.0.1:${WEB_PORT}` } })
      assert.notEqual(errorOf(response).code, 'FORBIDDEN_ORIGIN', host)
    }
    const local = await r.post('g1', 'abandon', { reason: 'ok reason', confirm_run_id: 'g1' }, { token, headers: { host: `localhost:${WEB_PORT}`, origin: `http://localhost:${WEB_PORT}` } })
    assert.equal(local.statusCode, 200, local.body)
    // A GET needs the token as well, also for a run that happens to be named "status".
    assert.equal(errorOf(await r.app.inject({ method: 'GET', url: `/api/run-controls/${PROJECT}/${WORKFLOW}/status` })).code, 'TOKEN_REQUIRED')
    assert.equal(errorOf(await r.app.inject({ method: 'GET', url: r.url('g1') })).code, 'TOKEN_REQUIRED')
    assert.equal(errorOf(await r.app.inject({ method: 'GET', url: r.url('g1'), headers: { 'x-mdm-control-token': 'no' } })).code, 'TOKEN_INVALID')
  })
})

test('[guards] MD_MANAGER_WEB_PORT decides the allowed origin (a random critique port works, another is refused)', async () => {
  await withRig({ env: { MD_MANAGER_WEB_PORT: '45123' }, seeds: { g1: SEEDS.stopped } }, async r => {
    r.spawner.auto.code = 0
    const token = (await r.controls('g1')).run_state_token
    const good = await r.post('g1', 'abandon', { reason: 'ok reason', confirm_run_id: 'g1' }, { token, headers: { host: '127.0.0.1:45123', origin: 'http://127.0.0.1:45123' } })
    assert.equal(good.statusCode, 200, good.body)
    const bad = await r.post('g1', 'restart', {}, { token, headers: { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173' } })
    assert.equal(errorOf(bad).code, 'FORBIDDEN_ORIGIN')
  })
})

test('[L6] 2/[L7]: MD_MANAGER_CONTROLS_HOSTS is ignored with one startup warning; its host is 403 FORBIDDEN_ORIGIN', async () => {
  await withRig({ env: { MD_MANAGER_CONTROLS_HOSTS: 'mac.local:5173' }, seeds: { g1: SEEDS.stopped } }, async r => {
    assert.equal(r.setup.warnings.length, 1)
    assert.match(r.setup.warnings[0], /MD_MANAGER_CONTROLS_HOSTS is ignored/)
    const token = (await r.controls('g1')).run_state_token
    const response = await r.post('g1', 'abandon', { reason: 'ok reason', confirm_run_id: 'g1' }, { token, headers: { host: 'mac.local:5173', origin: 'http://mac.local:5173' } })
    assert.equal(response.statusCode, 403)
    assert.equal(errorOf(response).code, 'FORBIDDEN_ORIGIN')
    assert.equal(r.spawner.calls.length, 0)
  })
  await withRig({}, async r => assert.deepEqual(r.setup.warnings, []))
})

test('[L6] 3: free text starting with "-" is data: answer after --, abandon and accept-challenge as --flag=<text>, one argv element each', async () => {
  await withRig({ env: { HERDR_ENV: '1' }, seeds: {
    a1: { ...SEEDS.question, files: { ...SEEDS.question.files, 'terminals.json': { ui: { pane_id: 'p-1' } } } }, b1: SEEDS.stopped, c1: SEEDS.paused,
  } }, async r => {
    for (const text of ['-x', '-h', '--help', '--reason']) {
      r.spawner.auto.code = 0
      let before = r.spawner.calls.length
      assert.equal((await r.act('a1', 'answer', { lane: 'ui', text })).statusCode, 200)
      assert.deepEqual(r.spawner.calls[before].args, ['-m', 'workflow', 'answer', join(r.runsRoot, 'a1'), 'ui', ...BY, '--', text])
      const shown = (await r.controls('a1')).records[0]
      assert.equal(shown.command, `$PY -m workflow answer "$RUN" ui --by operator -- ${JSON.stringify(text)}`)
      before = r.spawner.calls.length
      const abandon = await r.post('b1', 'abandon', { reason: text, confirm_run_id: 'b1' }, { token: (await r.controls('b1')).run_state_token })
      assert.equal(abandon.statusCode, 200, abandon.body)
      assert.deepEqual(r.spawner.calls[before].args, ['-m', 'workflow', 'abandon', join(r.runsRoot, 'b1'), `--reason=${text}`, ...BY])
      await r.seed('b1', SEEDS.stopped)
      r.spawner.auto.code = null
      before = r.spawner.calls.length
      const accept = await r.post('c1', 'accept_challenge', { reason: text.padEnd(12, '.') }, { token: (await r.controls('c1')).run_state_token })
      assert.equal(accept.statusCode, 202, accept.body)
      assert.deepEqual(r.spawner.calls[before].args, ['-m', 'workflow', 'resume', join(r.runsRoot, 'c1'), `--accept-challenge=${text.padEnd(12, '.')}`, ...BY])
      r.spawner.exit(r.spawner.children.length - 1, 0)
      await r.seed('c1', SEEDS.paused)
    }
  })
})

test('[L6] 1: the stored line keeps argv and unit; reads strip them; lost recovery keeps both; a repeated request_id still spawns once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'md-manager-controls-'))
  try {
    const first = await rig({ root, mode: 'systemd', seeds: { k1: SEEDS.stopped, k2: SEEDS.failedVerify } })
    const lines = (run: string) => readFileSyncSafe(join(root, 'state', PROJECT, WORKFLOW, `${run}.jsonl`)).split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
    // A short control: the full argv and a null unit.
    first.spawner.auto.code = 0
    const requestId = crypto.randomUUID()
    const token2 = (await first.controls('k2')).run_state_token
    assert.equal((await first.post('k2', 'retry', { lane: 'ui', phase: 'worker' }, { token: token2, request_id: requestId })).statusCode, 200)
    assert.equal((await first.post('k2', 'retry', { lane: 'ui', phase: 'worker' }, { token: token2, request_id: requestId })).statusCode, 200)
    assert.equal(first.spawner.calls.length, 1, 'a repeated request_id spawns once with the new lines on disk')
    const short = lines('k2').at(-1)!
    assert.deepEqual(short.argv, [first.python, '-m', 'workflow', 'retry', join(first.runsRoot, 'k2'), '--phase', 'worker', '--node', 'ui', ...BY].map(item => item.split(first.home).join('~')))
    assert.equal(short.unit, null)
    // A long control in systemd mode: the exact systemd-run argv and the unit name.
    first.spawner.auto.code = null
    assert.equal((await first.act('k1', 'restart')).statusCode, 202)
    const long = lines('k1').at(-1)!
    assert.deepEqual(long.argv, ['systemd-run', '--user', '--scope', '--collect', `--unit=${unitFor('k1', 1)}`, `--working-directory=${first.wfhome}`, '--', first.python, '-m', 'workflow', 'automatic', join(first.runsRoot, 'k1'), '--live', ...BY])
    assert.equal(long.unit, unitFor('k1', 1))
    // The wire records are Appendix A's strict shape.
    const served = (await first.controls('k1')).records[0] as Record<string, unknown>
    assert.ok(!('argv' in served) && !('unit' in served))
    await first.close(false)
    const second = await rig({ root, mode: 'systemd' })
    assert.equal((await second.controls('k1')).records[0].status, 'lost')
    const lost = lines('k1').at(-1)!
    assert.deepEqual([lost.status, lost.unit, lost.argv], ['lost', long.unit, long.argv])
    await second.close()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('[L6] 5: a running record returns the log tail as of each read; the final write replaces it', async () => {
  await withRig({ seeds: { r1: SEEDS.stopped } }, async r => {
    const response = await r.act('r1', 'restart')
    assert.equal(response.statusCode, 202)
    const record = controlResponseSchema.parse(response.json()).record
    assert.deepEqual(record.output_tail, [])
    const log = join(r.root, 'state', PROJECT, WORKFLOW, `r1.${record.record_id}.log`)
    const read = async () => {
      const got = await r.app.inject({ method: 'GET', url: r.url('r1', `/records/${record.record_id}`), headers: r.headers() })
      return controlResponseSchema.parse(got.json()).record
    }
    assert.deepEqual((await read()).output_tail, [], 'a missing or empty log reads []')
    await writeFile(log, `Supervisor starting\nhome ${r.home}\n`, { flag: 'a' })
    assert.deepEqual((await read()).output_tail, ['Supervisor starting', 'home ~'])
    assert.deepEqual((await r.controls('r1')).records[0].output_tail, ['Supervisor starting', 'home ~'])
    await writeFile(log, 'Phase two\n', { flag: 'a' })
    assert.deepEqual((await read()).output_tail, ['Supervisor starting', 'home ~', 'Phase two'])
    await writeFile(log, 'Done\n', { flag: 'a' })
    r.spawner.exit(0, 0)
    await waitFor(() => readFileSyncSafe(join(r.root, 'state', PROJECT, WORKFLOW, 'r1.jsonl')).includes('"succeeded"'), 'the succeeded record')
    const done = await read()
    assert.deepEqual([done.status, done.output_tail], ['succeeded', ['Supervisor starting', 'home ~', 'Phase two', 'Done']])
  })
})

test('[L6] 6(a): HEAD needs the token on every run-controls route but status, and never runs the handler', async () => {
  await withRig({ seeds: { h1: SEEDS.stopped } }, async r => {
    for (const url of [r.url('h1'), r.url('h1', '/records/c-000000000000')]) {
      const bare = await r.app.inject({ method: 'HEAD', url })
      assert.equal(bare.statusCode, 403, url)
      const wrong = await r.app.inject({ method: 'HEAD', url, headers: { 'x-mdm-control-token': 'no' } })
      assert.equal(wrong.statusCode, 403, url)
    }
    assert.equal((await r.app.inject({ method: 'HEAD', url: r.url('h1'), headers: r.headers() })).statusCode, 200)
    assert.equal((await r.app.inject({ method: 'HEAD', url: '/api/run-controls/status' })).statusCode, 200)
  })
})

test('[L6] 6(b): a command the controller refused (exit 1) was spawned exactly once, with no retry', async () => {
  await withRig({ seeds: { f1: SEEDS.failedVerify } }, async r => {
    r.spawner.output.push('Blocked: Another controller owns this run\n')
    r.spawner.auto.code = 1
    const response = await r.act('f1', 'retry', { lane: 'ui', phase: 'worker' })
    assert.equal(controlResponseSchema.parse(response.json()).record.status, 'failed')
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(r.spawner.calls.length, 1)
  })
})

test('[guards] a stale run_state_token is 409 STATE_CHANGED and spawns nothing; a repeated request_id spawns once and returns the same record', async () => {
  await withRig({ seeds: { s1: SEEDS.stopped, s2: SEEDS.stopped } }, async r => {
    const stale = (await r.controls('s1')).run_state_token
    await r.seed('s1', { ...SEEDS.stopped, events: [{ sequence: 1, time: T0, node: 'ui', status: 'running', message: 'a' }, { sequence: 2, time: T0, node: 'ui', status: 'running', message: 'b' }] })
    const refused = await r.post('s1', 'restart', {}, { token: stale })
    assert.equal(refused.statusCode, 409)
    assert.equal(errorOf(refused).code, 'STATE_CHANGED')
    assert.match(errorOf(refused).message, /changed since you looked/)
    assert.equal(r.spawner.calls.length, 0)
    // A fresh token works once; the same request_id again is the same record, not a second run.
    const requestId = crypto.randomUUID()
    const token = (await r.controls('s2')).run_state_token
    const first = await r.post('s2', 'restart', {}, { token, request_id: requestId })
    assert.equal(first.statusCode, 202)
    const again = await r.post('s2', 'restart', {}, { token, request_id: requestId })
    assert.equal(again.statusCode, 202)
    assert.deepEqual(controlResponseSchema.parse(again.json()), controlResponseSchema.parse(first.json()))
    const afterChange = await r.post('s2', 'restart', {}, { token: 'a-token-that-is-stale', request_id: requestId })
    assert.equal(afterChange.statusCode, 202, 'a repeat is answered before the state token is looked at')
    assert.equal(r.spawner.calls.length, 1)
  })
})

test('[guards] a control that is not offered is 422 NOT_AVAILABLE with its reason, and spawns nothing', async () => {
  await withRig({ seeds: { s1: SEEDS.stopped } }, async r => {
    const response = await r.act('s1', 'clean', { confirm_run_id: 's1' })
    assert.equal(response.statusCode, 422)
    assert.deepEqual(errorOf(response), { code: 'NOT_AVAILABLE', message: 'The run is not finished or abandoned' })
    assert.equal((await r.act('s1', 'pause')).statusCode, 422)
    assert.equal(r.spawner.calls.length, 0)
  })
})

// ---- Acceptance 8: BUSY and the running long record ([L3]) --------------------------------------------------------------------

test('[L3] BUSY while a short control is in flight and while a long control is being spawned; neither survives its end', async () => {
  await withRig({ seeds: { b1: SEEDS.failedVerify, b2: SEEDS.stopped } }, async r => {
    // A short control in flight: retry has been spawned and has not exited.
    const tokenOne = (await r.controls('b1')).run_state_token
    const shortFlight = r.post('b1', 'retry', { lane: 'ui', phase: 'worker' }, { token: tokenOne })
    await waitFor(() => r.spawner.children.length === 1, 'the short child')
    assert.equal(r.spawner.calls.length, 1)
    const second = await r.post('b1', 'abandon', { reason: 'fine reason', confirm_run_id: 'b1' }, { token: tokenOne })
    assert.equal(second.statusCode, 409)
    assert.equal(errorOf(second).code, 'BUSY')
    assert.equal(r.spawner.calls.length, 1)
    r.spawner.exit(0, 0)
    assert.equal((await shortFlight).statusCode, 200)
    // Another run is not affected, and the slot is free again.
    const token = (await r.controls('b2')).run_state_token
    // A long control whose spawner has not returned.
    let release!: () => void
    r.spawner.gate.wait = new Promise<void>(resolve => { release = resolve })
    const longFlight = r.post('b2', 'restart', {}, { token })
    await waitFor(() => r.spawner.calls.length === 2, 'the long spawn call')
    assert.equal(r.spawner.calls.length, 2, 'the spawner was called and has not returned')
    const blocked = await r.post('b2', 'abandon', { reason: 'fine reason', confirm_run_id: 'b2' }, { token })
    assert.equal(errorOf(blocked).code, 'BUSY')
    release()
    assert.equal((await longFlight).statusCode, 202)
    r.spawner.gate.wait = null
    // Once the spawn returned, the running record holds nothing.
    r.spawner.auto.code = 0
    const after = await r.post('b2', 'abandon', { reason: 'fine reason', confirm_run_id: 'b2' }, { token: (await r.controls('b2')).run_state_token })
    assert.equal(after.statusCode, 200, after.body)
  })
})

test('[L3] with a running restart record and the supervisor lock held, pause and answer are accepted and a second restart is NOT_AVAILABLE', async () => {
  const files = { ...SEEDS.question.files, 'terminals.json': { ui: { pane_id: 'p-1' } } }
  await withRig({ env: { HERDR_ENV: '1' }, seeds: { l3: { ...SEEDS.question, files } } }, async r => {
    const first = await r.act('l3', 'restart')
    assert.equal(first.statusCode, 202)
    assert.equal(controlResponseSchema.parse(first.json()).record.status, 'running')
    // The supervisor the restart started now holds its lock.
    const runDir = join(r.runsRoot, 'l3')
    await r.proc.hold(join(runDir, 'automatic-supervisor.lock'), 4242, ['/usr/bin/python3', '-m', 'workflow', 'automatic', runDir, '--live', '--by', 'operator'], { pgrp: 4200 })
    const controls = await r.controls('l3')
    assert.equal(controls.supervisor, 'running')
    assert.equal(controls.records[0].status, 'running')
    const restart = byId(controls, 'restart')
    assert.equal(restart.available, false)
    assert.match(restart.reason!, /^A supervisor is running \(since \d\d:\d\d UTC\)$/)
    const second = await r.post('l3', 'restart', {}, { token: controls.run_state_token })
    assert.equal(second.statusCode, 422)
    assert.equal(errorOf(second).code, 'NOT_AVAILABLE')
    // pause and answer are accepted while the record is running.
    assert.equal(byId(controls, 'pause').available, true)
    assert.equal(byId(controls, 'answer').available, true)
    r.spawner.auto.code = 0
    const answer = await r.post('l3', 'answer', { lane: 'ui', text: 'port 8080' }, { token: controls.run_state_token })
    assert.equal(answer.statusCode, 200)
    r.spawner.auto.code = null
    const pause = await r.act('l3', 'pause')
    assert.equal(pause.statusCode, 200, pause.body)
    assert.equal(r.spawner.calls.length, 2, 'the restart and the answer; pause spawns nothing')
    assert.deepEqual(r.kills, [[4200, 'SIGINT']])
  })
})

// ---- Acceptance 3: the lock probe and pause ---------------------------------------------------------------------------------

test('[probe] deviceNumbers is the kernel split on a BigInt (252:1 is not 61692; a tmpfs minor above 255 survives)', () => {
  const make = (major: bigint, minor: bigint) => ((major & 0xfffff000n) << 32n) | ((major & 0xfffn) << 8n) | ((minor & 0xffffff00n) << 12n) | (minor & 0xffn)
  for (const [major, minor] of [[252n, 1n], [8n, 1n], [0n, 44n], [0n, 300n], [259n, 1048575n], [0x1234n, 0x12345n]] as const) {
    assert.deepEqual(deviceNumbers(make(major, minor)), { major, minor }, `${major}:${minor}`)
  }
  assert.equal(make(252n, 1n), 64513n)
  assert.deepEqual(deviceNumbers(64513n), { major: 252n, minor: 1n })
})

test('[probe] held, free and unknown on a fake /proc', async () => {
  await withRig({ seeds: { p1: SEEDS.stopped } }, async r => {
    const lock = join(r.runsRoot, 'p1', 'automatic-supervisor.lock')
    assert.deepEqual(await probeLock(r.proc.root, lock), { state: 'free' }, 'no lock file: free')
    await writeFile(lock, '')
    assert.deepEqual(await probeLock(r.proc.root, lock), { state: 'free' }, 'a file nobody holds: free')
    await r.proc.hold(lock, 777, ['x'])
    assert.deepEqual(await probeLock(r.proc.root, lock), { state: 'held', pid: 777 })
    // Another inode on the same device is not this lock.
    const other = join(r.runsRoot, 'p1', 'controller.lock')
    await writeFile(other, '')
    assert.deepEqual(await probeLock(r.proc.root, other), { state: 'free' })
    // Only FLOCK lines count (a POSIX lock on the inode is not the controller's flock).
    await rm(join(r.proc.root, 'locks'))
    assert.deepEqual(await probeLock(r.proc.root, lock), { state: 'unknown' }, 'no /proc/locks: unknown')
    await r.proc.init()
    await writeFile(join(r.proc.root, 'locks'), (await readFile(join(r.proc.root, 'locks'), 'utf8')).replace('FLOCK ', 'POSIX '))
    assert.deepEqual(await probeLock(r.proc.root, lock), { state: 'free' })
    // The probe is read-only: the lock file is still empty and nothing was written next to it.
    assert.equal((await stat(lock)).size, 0)
    // The status the page reads: unknown without /proc/locks; the controls stay offered.
    await rm(join(r.proc.root, 'locks'))
    const controls = await r.controls('p1')
    assert.equal(controls.supervisor, 'unknown')
    assert.equal(byId(controls, 'restart').available, true)
    assert.equal(byId(controls, 'pause').available, false)
    assert.match(byId(controls, 'pause').reason!, /lock probe is unavailable/)
  })
})

test('[probe] a real flock on a real file is seen as held on the real /proc, and free after it is released', async t => {
  if (!existsSync('/proc/locks') || !existsSync('/usr/bin/flock')) { t.skip('needs Linux /proc/locks and util-linux flock'); return }
  const root = await mkdtemp(join(tmpdir(), 'md-manager-flock-'))
  try {
    const file = join(root, 'automatic-supervisor.lock')
    await writeFile(file, '')
    assert.deepEqual(await probeLock('/proc', file), { state: 'free' })
    const child = realSpawn('/usr/bin/flock', [file, 'sleep', '5'], { stdio: 'ignore', detached: true })
    try {
      let probe = await probeLock('/proc', file)
      for (let attempt = 0; attempt < 50 && probe.state !== 'held'; attempt++) { await new Promise(resolve => setTimeout(resolve, 40)); probe = await probeLock('/proc', file) }
      assert.equal(probe.state, 'held', 'the probe finds the flock on the real /proc')
    } finally {
      process.kill(-child.pid!, 'SIGKILL')
      await new Promise(resolve => child.once('exit', resolve))
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.deepEqual(await probeLock('/proc', file), { state: 'free' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('[pause] signals the matching holder\'s process group with SIGINT; any other holder is reported, never signalled', async () => {
  await withRig({ seeds: { k1: SEEDS.stopped, k2: SEEDS.stopped, k3: SEEDS.stopped, k4: SEEDS.stopped } }, async r => {
    const dir = (run: string) => join(r.runsRoot, run)
    const lock = (run: string) => join(dir(run), 'automatic-supervisor.lock')
    await r.proc.hold(lock('k1'), 900, ['/usr/bin/python3', '-m', 'workflow', 'automatic', dir('k1'), '--live', '--by', 'operator'], { pgrp: 880 })
    await r.proc.hold(lock('k2'), 901, ['/usr/bin/python3', '-m', 'workflow', 'automatic', dir('k1'), '--live'], { pgrp: 881 })
    await r.proc.hold(lock('k3'), 902, ['/usr/bin/vim', lock('k3')], { pgrp: 882 })
    await r.proc.hold(lock('k4'), 903, ['/usr/bin/python3', 'other.py', 'automatic', dir('k4')], { pgrp: 883 })
    const refusals: string[] = []
    for (const run of ['k2', 'k3', 'k4']) {
      const controls = await r.controls(run)
      assert.equal(byId(controls, 'pause').available, false, run)
      refusals.push(byId(controls, 'pause').reason!)
      const response = await r.post(run, 'pause', {}, { token: controls.run_state_token })
      assert.equal(response.statusCode, 422, run)
      assert.equal(errorOf(response).code, 'NOT_AVAILABLE')
    }
    assert.ok(refusals.every(reason => /not a supervisor of this run/.test(reason)))
    assert.deepEqual(r.kills, [], 'a holder that does not name this run is never signalled')
    const controls = await r.controls('k1')
    assert.equal(byId(controls, 'pause').available, true)
    assert.equal(controls.supervisor, 'running')
    assert.match(controls.supervisor_since!, /^2026-10-1\dT\d\d:\d\d:\d\dZ$|^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
    const response = await r.post('k1', 'pause', {}, { token: controls.run_state_token })
    assert.equal(response.statusCode, 200, response.body)
    const record = controlResponseSchema.parse(response.json()).record
    assert.deepEqual([record.status, record.exit_code, record.output_tail], ['succeeded', 0, ['SIGINT to group 880']])
    assert.deepEqual(r.kills, [[880, 'SIGINT']])
    assert.equal(r.spawner.calls.length, 0, 'pause spawns nothing')
  })
})

test('[L1] 5: under a fake /proc without an injected kill, pause never reaches the real process.kill', async () => {
  const base = await rig({ seeds: { k1: SEEDS.stopped } })
  const calls = mock.method(process, 'kill', () => true)
  try {
    // The same setup, but a runner without an injected kill.
    const config = await parseProjectsConfig(JSON.stringify({ version: 1, projects: [{ project_id: PROJECT, name: PROJECT, repository: join(base.root, 'repo'), workflows: [{ workflow_id: WORKFLOW, runs_root: base.runsRoot, definition: { name: 'x', nodes: graph(lanes, false) } }] }] }), 'x')
    const app = createApp([], { projects: config, controls: { setup: base.setup, now: () => NOW } })
    const dir = join(base.runsRoot, 'k1')
    await base.proc.hold(join(dir, 'automatic-supervisor.lock'), 910, ['python3', '-m', 'workflow', 'automatic', dir, '--live'], { pgrp: 890 })
    const headers = base.headers()
    const token = runControlsSchema.parse((await app.inject({ method: 'GET', url: base.url('k1'), headers })).json()).run_state_token
    const response = await app.inject({ method: 'POST', url: base.url('k1', '/pause'), headers, payload: JSON.stringify({ request_id: crypto.randomUUID(), run_state_token: token, params: {} }) })
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(controlResponseSchema.parse(response.json()).record.output_tail, ['SIGINT to group 890 (test /proc: not sent)'])
    assert.equal(calls.mock.calls.length, 0, 'process.kill is never called')
    await app.close()
  } finally {
    calls.mock.restore()
    await base.close()
  }
})

// ---- Acceptance 4: long controls, records, restart ---------------------------------------------------------------------------

test('[long] a long control runs as a transient user unit: the exact systemd-run argv, the record goes running to succeeded or failed', async () => {
  await withRig({ mode: 'systemd', seeds: { u1: SEEDS.stopped, u2: SEEDS.stopped } }, async r => {
    r.spawner.output.push('Automatic by the operator\n')
    const response = await r.act('u1', 'restart')
    assert.equal(response.statusCode, 202)
    const running = controlResponseSchema.parse(response.json()).record
    assert.equal(running.status, 'running')
    assert.equal(running.command, '$PY -m workflow automatic "$RUN" --live --by operator')
    assert.deepEqual(r.spawner.calls[0].args, [
      '--user', '--scope', '--collect', `--unit=${unitFor('u1', 1)}`, `--working-directory=${r.wfhome}`, '--',
      r.python, '-m', 'workflow', 'automatic', join(r.runsRoot, 'u1'), '--live', '--by', 'operator',
    ])
    assert.equal(r.spawner.calls[0].command, 'systemd-run')
    assert.equal(r.spawner.calls[0].detached, true)
    assert.equal(r.spawner.calls[0].env?.CLAUDECODE, undefined)
    assert.match(unitFor('u1', 1), /^mdm-control-[0-9a-f]{8}-1$/)
    // The record is readable while it runs, then ends from the child's exit.
    assert.equal((await r.controls('u1')).records[0].status, 'running')
    r.spawner.exit(0, 0)
    await waitFor(() => existsSync(join(r.root, 'state')) && readFileSyncSafe(join(r.root, 'state', PROJECT, WORKFLOW, 'u1.jsonl')).includes('"succeeded"'), 'the succeeded record')
    const done = (await r.controls('u1')).records[0]
    assert.deepEqual([done.status, done.exit_code, done.output_tail], ['succeeded', 0, ['Automatic by the operator']])
    assert.ok(done.ended_at)
    // A refusal: exit 1 and the Blocked line first.
    r.spawner.output.push('noise\nBlocked: Another controller owns this run\nmore\n')
    assert.equal((await r.act('u2', 'restart')).statusCode, 202)
    r.spawner.exit(1, 1)
    await waitFor(() => readFileSyncSafe(join(r.root, 'state', PROJECT, WORKFLOW, 'u2.jsonl')).includes('"failed"'), 'the failed record')
    const failed = (await r.controls('u2')).records[0]
    assert.deepEqual([failed.status, failed.exit_code, failed.output_tail[0]], ['failed', 1, 'Blocked: Another controller owns this run'])
    // The record is served by id, too.
    const byRecord = await r.app.inject({ method: 'GET', url: r.url('u2', `/records/${failed.record_id}`), headers: r.headers() })
    assert.equal(controlResponseSchema.parse(byRecord.json()).record.record_id, failed.record_id)
    assert.equal((await r.app.inject({ method: 'GET', url: r.url('u2', '/records/c-000000000000'), headers: r.headers() })).statusCode, 404)
    // The unit count rises with the run's records.
    r.spawner.output.push('')
    await r.act('u2', 'restart')
    assert.ok(r.spawner.calls[2].args.includes(`--unit=${unitFor('u2', 2)}`))
  })
})

test('[long] a signal or a missing systemd-run: long controls are unavailable with that reason', async () => {
  const root = await mkdtemp(join(tmpdir(), 'md-manager-controls-'))
  try {
    const r = await rig({ root, mode: 'systemd', seeds: { n1: SEEDS.stopped } })
    await r.close(false)
    const config = await parseProjectsConfig(JSON.stringify({ version: 1, projects: [{ project_id: PROJECT, name: PROJECT, repository: join(root, 'repo'), workflows: [{ workflow_id: WORKFLOW, runs_root: r.runsRoot, definition: { name: 'x', nodes: graph(lanes, false) } }] }] }), 'x')
    const app = createApp([], { projects: config, controls: { setup: r.setup, now: () => NOW, runner: { spawn: r.spawner.spawn, systemdRun: false } } })
    const controls = runControlsSchema.parse((await app.inject({ method: 'GET', url: r.url('n1'), headers: r.headers() })).json())
    assert.equal(byId(controls, 'restart').available, false)
    assert.match(byId(controls, 'restart').reason!, /systemd-run is not available/)
    assert.equal(byId(controls, 'abandon').available, true, 'short controls are unaffected')
    await app.close()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('[long] a server restart marks a running record lost; the next server serves it lost', async () => {
  const root = await mkdtemp(join(tmpdir(), 'md-manager-controls-'))
  try {
    const first = await rig({ root, mode: 'systemd', seeds: { w1: SEEDS.stopped } })
    assert.equal((await first.act('w1', 'restart')).statusCode, 202)
    assert.equal((await first.controls('w1')).records[0].status, 'running')
    await first.close(false)
    const second = await rig({ root, mode: 'systemd' })
    const record = (await second.controls('w1')).records[0]
    assert.equal(record.status, 'lost')
    assert.equal(record.ended_at, '2026-10-10T12:00:00Z')
    assert.equal((await second.controls('w1')).records.length, 1)
    await second.close()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('[long] MD_MANAGER_CONTROLS_SPAWN=direct runs a detached child of the Python itself, with the log under the state directory', async () => {
  await withRig({ mode: 'direct', seeds: { d1: SEEDS.stopped } }, async r => {
    assert.equal((await r.act('d1', 'restart')).statusCode, 202)
    const call = r.spawner.calls[0]
    assert.equal(call.command, r.python)
    assert.equal(call.detached, true)
    assert.deepEqual(call.args, ['-m', 'workflow', 'automatic', join(r.runsRoot, 'd1'), '--live', ...BY])
    const files = await readdir(join(r.root, 'state', PROJECT, WORKFLOW))
    assert.ok(files.includes('d1.jsonl'))
    assert.ok(files.some(name => /^d1\.c-[0-9a-f]{12}\.log$/.test(name)))
  })
})

test('[long] a child that cannot be started leaves a refused record and answers SPAWN_FAILED (short)', async () => {
  const failing: SpawnFn = () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }
  await withRig({ spawn: failing, seeds: { x1: SEEDS.failedVerify, x2: SEEDS.stopped } }, async r => {
    const response = await r.act('x1', 'retry', { lane: 'ui', phase: 'worker' })
    assert.equal(response.statusCode, 500)
    assert.equal(errorOf(response).code, 'SPAWN_FAILED')
    assert.equal((await r.controls('x1')).records[0].status, 'refused')
    const long = await r.act('x2', 'restart')
    assert.equal(errorOf(long).code, 'SPAWN_FAILED')
    // The slot is free again after a failed spawn.
    assert.notEqual(errorOf(await r.act('x2', 'restart')).code, 'BUSY')
  })
})

test('[short] a short control past its bound is killed by process group and recorded failed', async () => {
  await withRig({ timeoutMs: 30, seeds: { t1: SEEDS.failedVerify } }, async r => {
    // The rig's kill records; the fake child exits when it is killed.
    const token = (await r.controls('t1')).run_state_token
    const pending = r.post('t1', 'retry', { lane: 'ui', phase: 'worker' }, { token })
    await waitFor(() => r.kills.length === 1, 'the bound to expire')
    assert.deepEqual(r.kills, [[5001, 'SIGKILL']])
    r.spawner.exit(0, null, 'SIGKILL')
    const record = controlResponseSchema.parse((await pending).json()).record
    assert.deepEqual([record.status, record.exit_code], ['failed', null])
    assert.match(record.output_tail.at(-1)!, /longer than 5 minutes/)
  })
})

test('[records] output is redacted (home as ~, the token as [token]), capped at 40 lines, and never written into the run directory', async () => {
  await withRig({ seeds: { o1: SEEDS.failedVerify } }, async r => {
    const runDir = join(r.runsRoot, 'o1')
    const snapshot = async () => (await readdir(runDir)).sort().map(name => `${name}:${statSync(join(runDir, name)).size}:${statSync(join(runDir, name)).mtimeMs}`).join('|')
    const before = await snapshot()
    const lines = Array.from({ length: 60 }, (_, index) => `line ${index}`)
    r.spawner.output.push(`${lines.join('\n')}\nin ${r.home}/work with ${TOKEN} inside\n`)
    const token = (await r.controls('o1')).run_state_token
    const pending = r.post('o1', 'retry', { lane: 'ui', phase: 'worker' }, { token })
    await waitFor(() => r.spawner.children.length === 1, 'the child')
    r.spawner.exit(0, 0)
    const record = controlResponseSchema.parse((await pending).json()).record
    assert.equal(record.output_tail.length, 40)
    assert.equal(record.output_tail.at(-1), 'in ~/work with [token] inside')
    assert.ok(!JSON.stringify(record).includes(TOKEN))
    assert.ok(!JSON.stringify(record).includes(r.home))
    assert.equal(await snapshot(), before, 'the run directory is untouched')
    // Nothing in the state directory holds the token either.
    for (const name of await readdir(join(r.root, 'state', PROJECT, WORKFLOW))) {
      if (name.endsWith('.jsonl')) assert.ok(!(await readFile(join(r.root, 'state', PROJECT, WORKFLOW, name), 'utf8')).includes(TOKEN))
    }
  })
})

// ---- Acceptance 5 and 9: the offer rules --------------------------------------------------------------------------------------

const offered = (controls: RunControls) => controls.controls.filter(control => control.available).map(control => control.id)

test('[offer] a stopped automatic run, a running supervisor, a failed verify, needs_reconciliation', async () => {
  await withRig({ seeds: { stopped: SEEDS.stopped, running: SEEDS.stopped, failed: SEEDS.failedVerify, reconcile: SEEDS.needsReconciliation } }, async r => {
    const stopped = await r.controls('stopped')
    assert.equal(stopped.supervisor, 'not_running')
    assert.equal(stopped.supervisor_since, null)
    assert.deepEqual(offered(stopped), ['restart', 'abandon'])
    assert.equal(byId(stopped, 'pause').reason, 'No supervisor is running')
    assert.equal(byId(stopped, 'retry').reason, 'No check failed or was interrupted without a verdict')
    assert.equal(byId(stopped, 'reconcile').reason, 'No launch needs reconciling')
    assert.equal(byId(stopped, 'resume').reason, 'The design challenge is not paused, held or interrupted')
    assert.equal(byId(stopped, 'answer').reason, 'No lane has an unanswered question')
    assert.equal(byId(stopped, 'approve').reason, 'The run is not waiting for your approval')
    assert.equal(byId(stopped, 'clean').reason, 'The run is not finished or abandoned')
    assert.deepEqual(stopped.controls.map(control => control.id), [...CONTROL_IDS])
    assert.ok(stopped.controls.every(control => control.recommended === false), 'the server never computes recommended')

    const runDir = join(r.runsRoot, 'running')
    await r.proc.hold(join(runDir, 'automatic-supervisor.lock'), 321, ['python3', '-m', 'workflow', 'automatic', runDir, '--live'])
    const running = await r.controls('running')
    assert.equal(running.supervisor, 'running')
    assert.match(running.supervisor_since!, /Z$/)
    assert.deepEqual(offered(running), ['pause'])
    const since = running.supervisor_since!.slice(11, 16)
    for (const id of ['restart', 'retry', 'reconcile', 'abandon', 'clean'] as const) {
      assert.equal(byId(running, id).reason, `A supervisor is running (since ${since} UTC)`, `${id}: the lock is checked before any other condition`)
    }
    assert.equal(byId(running, 'restart').available, false)

    const failed = await r.controls('failed')
    assert.deepEqual(offered(failed), ['restart', 'retry', 'abandon'])
    assert.deepEqual(byId(failed, 'retry').params, [
      { name: 'lane', kind: 'choice', choices: ['ui'], required: true }, { name: 'phase', kind: 'choice', choices: ['worker'], required: true }])
    assert.equal(byId(failed, 'repair_session').reason, 'The run is not blocked at a check verdict after freeze, before review')

    const reconcile = await r.controls('reconcile')
    assert.deepEqual(offered(reconcile), ['restart', 'reconcile', 'abandon'])
  })
})

test('[offer] a paused and a held challenge', async () => {
  await withRig({ seeds: { paused: SEEDS.paused, held: SEEDS.held } }, async r => {
    const paused = await r.controls('paused')
    assert.deepEqual(offered(paused), ['restart', 'resume', 'accept_challenge', 'abandon'])
    assert.deepEqual(byId(paused, 'accept_challenge').params, [{ name: 'reason', kind: 'text', min_length: 10, max_length: 500, required: true }])
    assert.equal(byId(paused, 'release_hold').reason, 'The design challenge is not held')
    const held = await r.controls('held')
    assert.deepEqual(offered(held), ['restart', 'resume', 'release_hold', 'abandon'])
    assert.deepEqual(byId(held, 'release_hold').params, [{ name: 'drop', kind: 'multi', choices: [1, 2], required: false }])
    assert.equal(byId(held, 'accept_challenge').reason, 'The latest design challenge is not paused')
    // An interrupted rerun (challenge.running.json) is resumable too.
    await writeFile(join(r.runsRoot, 'paused', 'challenge.running.json'), '{}')
    assert.equal(byId(await r.controls('paused'), 'resume').available, true)
  })
})

test('[offer][L2] answer needs a waiting question, HERDR_ENV=1 in the server\'s environment and a recorded pane for the lane', async () => {
  const withPane = { ...SEEDS.question, files: { ...SEEDS.question.files, 'terminals.json': { ui: { pane_id: 'pane-9', tab: 1 } } } }
  const variants: [string, Seed][] = [
    ['missing-file', SEEDS.question], ['malformed', { ...SEEDS.question, files: { ...SEEDS.question.files, 'terminals.json': '{not json' } }],
    ['no-pane-for-lane', { ...SEEDS.question, files: { ...SEEDS.question.files, 'terminals.json': { adapter: { pane_id: 'p' } } } }],
    ['pane-without-id', { ...SEEDS.question, files: { ...SEEDS.question.files, 'terminals.json': { ui: { pane_id: 7 } } } }],
    ['array-file', { ...SEEDS.question, files: { ...SEEDS.question.files, 'terminals.json': [] } }],
  ]
  const seeds = Object.fromEntries([['with-pane', withPane], ...variants])
  // Without HERDR_ENV=1, even with a pane.
  await withRig({ seeds }, async r => {
    const controls = await r.controls('with-pane')
    assert.deepEqual([byId(controls, 'answer').available, byId(controls, 'answer').reason], [false, ANSWER_PANE_REASON])
    assert.equal(ANSWER_PANE_REASON, 'Typing the answer needs the lane\'s Herdr pane; answer in your terminal')
    const response = await r.post('with-pane', 'answer', { lane: 'ui', text: 'x' }, { token: controls.run_state_token })
    assert.equal(response.statusCode, 422)
    assert.deepEqual(errorOf(response), { code: 'NOT_AVAILABLE', message: ANSWER_PANE_REASON })
    assert.equal(r.spawner.calls.length, 0)
  })
  // With HERDR_ENV=1: unavailable unless the lane has a pane.
  await withRig({ env: { HERDR_ENV: '1' }, seeds }, async r => {
    for (const [name] of variants) {
      const controls = await r.controls(name)
      assert.deepEqual([byId(controls, 'answer').available, byId(controls, 'answer').reason], [false, ANSWER_PANE_REASON], name)
      const response = await r.post(name, 'answer', { lane: 'ui', text: 'x' }, { token: controls.run_state_token })
      assert.equal(errorOf(response).code, 'NOT_AVAILABLE', name)
    }
    assert.equal(r.spawner.calls.length, 0)
    const ok = await r.controls('with-pane')
    assert.equal(byId(ok, 'answer').available, true)
    assert.deepEqual(byId(ok, 'answer').params, [{ name: 'lane', kind: 'choice', choices: ['ui'], required: true }, { name: 'text', kind: 'text', min_length: 1, max_length: 4000, required: true }])
  })
  // A request header can never switch it on.
  await withRig({ seeds }, async r => {
    const token = (await r.controls('with-pane')).run_state_token
    const response = await r.post('with-pane', 'answer', { lane: 'ui', text: 'x' }, { token, headers: { 'x-herdr-env': '1', herdr_env: '1' } })
    assert.equal(response.statusCode, 422)
  })
})

test('[offer][L2] the lane choices are the waiting lanes that have a pane', async () => {
  const both = { files: {
    'ui.questions.json': { node_id: 'ui', questions: [{ n: 1, question: 'a?', asked_at: T0, answer: null, answered_at: null }] },
    'adapter.questions.json': { node_id: 'adapter', questions: [{ n: 1, question: 'b?', asked_at: T0, answer: 'done', answered_at: T0 }, { n: 2, question: 'c?', asked_at: T0, answer: null, answered_at: null }] },
    'terminals.json': { adapter: { pane_id: 'p-2' } },
  } } as Seed
  await withRig({ env: { HERDR_ENV: '1' }, seeds: { two: both } }, async r => {
    const answer = byId(await r.controls('two'), 'answer')
    assert.equal(answer.available, true)
    assert.deepEqual(answer.params[0], { name: 'lane', kind: 'choice', choices: ['adapter'], required: true })
  })
})

test('[offer] awaiting_approval, a check block after freeze, an abandoned run and a finished run', async () => {
  await withRig({ seeds: { approval: SEEDS.awaitingApproval, frozen: SEEDS.blockedAfterFreeze, abandoned: SEEDS.abandoned, finished: SEEDS.finished, manual: { ...SEEDS.stopped, automatic: false } } }, async r => {
    const approval = await r.controls('approval')
    assert.equal(byId(approval, 'approve').available, true)
    assert.equal(byId(approval, 'approve').confirm, 'typed_run_id')
    assert.deepEqual(byId(approval, 'approve').params, [{ name: 'confirm_run_id', kind: 'typed', required: true }])
    assert.deepEqual(offered(approval), ['restart', 'approve', 'abandon'])
    // No digest recorded: approve is not offered.
    await r.seed('nodigest', { ...SEEDS.awaitingApproval, tasks: [{ node_id: 'approval', error: null, interrupts: [{ kind: 'integration_approval' }], result: null }] })
    assert.equal(byId(await r.controls('nodigest'), 'approve').reason, 'No reviewed bundle digest is recorded for this approval')
    // Two gates are not the awaiting_approval of pipeline.py:1124.
    await r.seed('twogates', { ...SEEDS.awaitingApproval, tasks: [{ node_id: 'approval', error: null, interrupts: [{ kind: 'integration_approval', bundle_sha256: DIGEST }, { kind: 'other' }], result: null }] })
    assert.equal(byId(await r.controls('twogates'), 'approve').available, false)
    // A manual run (finish is not approval) has no digest.
    await r.seed('finishmerge', { ...SEEDS.awaitingApproval, finish: 'verified-feature-branch' })
    assert.equal(byId(await r.controls('finishmerge'), 'approve').available, false)

    const frozen = await r.controls('frozen')
    assert.deepEqual(offered(frozen), ['restart', 'retry', 'repair_session', 'abandon'])
    assert.deepEqual(byId(frozen, 'repair_session').params, [{ name: 'lane', kind: 'choice', choices: ['ui'], required: true }, { name: 'confirm_run_id', kind: 'typed', required: true }])
    assert.equal(byId(frozen, 'repair_session').confirm, 'typed_run_id')
    assert.equal(byId(frozen, 'repair_session').runs, 'long')

    const abandoned = await r.controls('abandoned')
    assert.equal(byId(abandoned, 'restart').reason, 'The run was abandoned')
    assert.equal(byId(abandoned, 'abandon').reason, 'The run was abandoned')
    assert.deepEqual(offered(abandoned), ['clean'])

    const finished = await r.controls('finished')
    assert.equal(byId(finished, 'restart').reason, 'The run is finished')
    assert.equal(byId(finished, 'abandon').reason, 'The run is already integrated')
    assert.deepEqual(offered(finished), ['clean'])

    const manual = await r.controls('manual')
    assert.equal(byId(manual, 'restart').reason, 'Only an automatic run has a supervisor')
  })
})

test('[offer] a recorded repair blocks restart; a held controller lock blocks the lock-bound controls with its own reason', async () => {
  await withRig({ seeds: { rr: { ...SEEDS.stopped, files: { 'repairs.json': {} } }, cl: SEEDS.failedVerify } }, async r => {
    const runDir = join(r.runsRoot, 'cl')
    await r.proc.hold(join(runDir, 'controller.lock'), 600, ['python3', '-m', 'workflow', 'retry', runDir])
    const controls = await r.controls('cl')
    assert.match(byId(controls, 'retry').reason!, /^A controller is running \(since \d\d:\d\d UTC\)$/)
    assert.equal(controls.supervisor, 'running')
    assert.equal(byId(controls, 'pause').available, false, 'only a supervisor lock can be paused')
  })
})

// ---- [L4] the clean preview -------------------------------------------------------------------------------------------------

test('[L4] clean-preview runs clean --dry-run, writes no record and does not consume the dialog\'s request_id; a following clean runs once', async () => {
  await withRig({ seeds: { c1: SEEDS.finished } }, async r => {
    const token = (await r.controls('c1')).run_state_token
    const requestId = crypto.randomUUID()
    r.spawner.output.push('')
    const preview = r.app.inject({ method: 'POST', url: r.url('c1', '/clean-preview'), headers: r.headers(), payload: JSON.stringify({ run_state_token: token }) })
    await waitFor(() => r.spawner.children.length === 1, 'the dry-run child')
    assert.equal(r.spawner.calls.length, 1)
    const call = r.spawner.calls[0]
    assert.deepEqual(call.args, ['-m', 'workflow', 'clean', join(r.runsRoot, 'c1'), '--by', 'operator', '--dry-run'])
    assert.deepEqual(call.stdio, ['ignore', 'pipe', 'pipe'])
    const child = r.spawner.children[0] as unknown as { stdout?: EventEmitter; stderr?: EventEmitter }
    child.stdout = child.stdout ?? new EventEmitter()
    // The fake child has no streams: the capture ended with the exit, so the output is empty.
    r.spawner.exit(0, 0)
    const response = await preview
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(response.json(), { exitCode: 0, output: '' })
    assert.deepEqual((await r.controls('c1')).records, [], 'a preview writes no record')
    // The dialog's request_id goes on the clean POST only, and is fresh there.
    r.spawner.auto.code = 0
    const clean = await r.post('c1', 'clean', { confirm_run_id: 'c1' }, { token, request_id: requestId })
    assert.equal(clean.statusCode, 200)
    assert.deepEqual(r.spawner.calls[1].args, ['-m', 'workflow', 'clean', join(r.runsRoot, 'c1'), '--by', 'operator'])
    const repeat = await r.post('c1', 'clean', { confirm_run_id: 'c1' }, { token, request_id: requestId })
    assert.equal(repeat.statusCode, 200)
    assert.equal(r.spawner.calls.length, 2, 'the real clean ran once')
  })
})

test('[L4] clean-preview refuses an extra key, a stale token, an unavailable clean, and the browser guards; it is not BUSY-gated', async () => {
  await withRig({ seeds: { c1: SEEDS.finished, c2: SEEDS.stopped } }, async r => {
    const token = (await r.controls('c1')).run_state_token
    const send = (run: string, body: unknown, headers: Record<string, string | undefined> = {}) =>
      r.app.inject({ method: 'POST', url: r.url(run, '/clean-preview'), headers: r.headers(headers), payload: JSON.stringify(body) })
    assert.equal(errorOf(await send('c1', { run_state_token: token, request_id: crypto.randomUUID() })).code, 'INVALID_PARAMS')
    assert.equal(errorOf(await send('c1', { run_state_token: token, params: {} })).code, 'INVALID_PARAMS')
    assert.equal(errorOf(await send('c1', {})).code, 'INVALID_PARAMS')
    assert.equal(errorOf(await send('c1', { run_state_token: 'stale' })).code, 'STATE_CHANGED')
    assert.equal(errorOf(await send('c2', { run_state_token: (await r.controls('c2')).run_state_token })).code, 'NOT_AVAILABLE')
    assert.equal(errorOf(await send('c1', { run_state_token: token }, { origin: 'http://evil.example' })).code, 'FORBIDDEN_ORIGIN')
    assert.equal(errorOf(await send('c1', { run_state_token: token }, { 'x-mdm-control-token': undefined })).code, 'TOKEN_REQUIRED')
    assert.equal(errorOf(await send('c1', { run_state_token: token }, { 'content-type': 'text/plain' })).code, 'UNSUPPORTED_MEDIA_TYPE')
    assert.equal(r.spawner.calls.length, 0)
    // A control named "clean-preview" is not the :control_id route.
    assert.equal((await r.post('c1', 'clean-preview', {}, { token })).statusCode, 400)
  })
})

// ---- Housekeeping ------------------------------------------------------------------------------------------------------------

test('[housekeeping] only a registered run is served: unknown ids are 404 NOT_FOUND and a symlinked run directory is refused', async () => {
  await withRig({ seeds: { real: SEEDS.stopped } }, async r => {
    const get = (url: string) => r.app.inject({ method: 'GET', url, headers: r.headers() })
    assert.equal(errorOf(await get(`/api/run-controls/${PROJECT}/${WORKFLOW}/missing`)).code, 'NOT_FOUND')
    assert.equal(errorOf(await get(`/api/run-controls/nope/${WORKFLOW}/real`)).code, 'NOT_FOUND')
    assert.equal(errorOf(await get(`/api/run-controls/${PROJECT}/nope/real`)).code, 'NOT_FOUND')
    await symlink(join(r.runsRoot, 'real'), join(r.runsRoot, 'linked'))
    assert.equal(errorOf(await get(`/api/run-controls/${PROJECT}/${WORKFLOW}/linked`)).code, 'NOT_FOUND')
    const token = (await r.controls('real')).run_state_token
    assert.equal(errorOf(await r.post('missing', 'restart', {}, { token })).code, 'NOT_FOUND')
    assert.equal(r.spawner.calls.length, 0)
  })
})

test('[housekeeping] no module spawns through a shell and the executable is fixed', async () => {
  const sources = await Promise.all(['controls.ts', 'controlsGuard.ts', 'controlsRunner.ts'].map(name => readFile(new URL(name, import.meta.url), 'utf8')))
  for (const source of sources) {
    assert.ok(!/execSync|execFile|shell:\s*true/.test(source))
    for (const line of source.split('\n').filter(text => text.includes("from 'node:child_process'"))) assert.ok(!/\bexec/.test(line), line)
    assert.ok(!/console\.log|log\.[a-z]+\([^)]*token/i.test(source.replace(/\/\/.*$/gm, '')), 'the token is not logged')
  }
})

test('[contract] the served RunControls match the committed examples for the seeded states', async () => {
  const pane = { ...SEEDS.question, files: { ...SEEDS.question.files, 'terminals.json': { ui: { pane_id: 'p' } } } }
  await withRig({ env: { HERDR_ENV: '1' }, seeds: {
    stopped: SEEDS.stopped, failed: SEEDS.failedVerify, reconcile: SEEDS.needsReconciliation, paused: SEEDS.paused, held: SEEDS.held, 'q-pane': pane, 'q-none': SEEDS.question,
    approval: SEEDS.awaitingApproval, frozen: SEEDS.blockedAfterFreeze, abandoned: SEEDS.abandoned, finished: SEEDS.finished,
  } }, async r => {
    const states = examples.runControlsStates
    const pairs: [string, keyof typeof states][] = [
      ['stopped', 'stoppedAutomatic'], ['failed', 'failedVerify'], ['reconcile', 'needsReconciliation'], ['paused', 'challengePaused'], ['held', 'challengeHeld'],
      ['q-pane', 'questionWithPane'], ['q-none', 'questionWithoutPane'], ['approval', 'awaitingApproval'], ['frozen', 'blockedAfterFreeze'], ['abandoned', 'abandoned'], ['finished', 'finished'],
    ]
    // 'q-none' has a pane-less question while HERDR_ENV=1: the same unavailable answer as the example.
    for (const [run, name] of pairs) assert.deepEqual((await r.controls(run)).controls, states[name].controls, name)
  })
})
