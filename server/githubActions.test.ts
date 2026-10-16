import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { readFileSync, statSync, writeSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import Fastify, { type FastifyInstance } from 'fastify'
import { controlErrorSchema } from '../contracts/projects/controls.ts'
import {
  GITHUB_ACTION_IDS, githubActionRecordSchema, githubActionResponseSchema, runGithubActionsSchema, type GithubActionId, type RunGithub, type RunGithubActions,
} from '../contracts/projects/github.ts'
import { runGithub as exampleGithub } from '../contracts/projects/teamExamples.ts'
import { controlRoutes } from './controls.ts'
import { CONTROLS_PREFIX, loadControlsConfig } from './controlsGuard.ts'
import type { SpawnFn } from './controlsRunner.ts'
import {
  GITHUB_ACTIONS_OFF, GITHUB_READ_FAILED, GITHUB_READ_MISSING, githubStateToken, isBranchName, isReviewerName, reviewerSuggestions, urlOf, type GithubSource,
} from './githubActions.ts'
import { RunStore } from './projects.ts'
import { parseProjectsConfig } from './projectsConfig.ts'

/**
 * The run page's GitHub actions (docs/PRD_RUN_TEAMS.md "GitHub actions"): the offers, the exact controller argv of each action, the
 * run-control guards on the new routes, the state token, BUSY, request dedupe, the typed repository, the body file and the records.
 * Every path is under a temporary root and HOME; the controller is a recording spawner (no real python, git or gh), the GitHub read is
 * a fake source returning `RunGithub` shaped like the contract's examples. Nothing reaches GitHub, systemd or the real HOME.
 */
const TOKEN = 'test-pairing-token-0123456789abcdef-0123'
const WEB_PORT = '5173'
const BASE = 'a'.repeat(40)
const T0 = '2026-03-01T10:00:00.000000Z'
const NOW = new Date('2026-10-16T10:00:00.000Z')
const PROJECT = 'alpha'
const WORKFLOW = 'main'
const HEAD = '6b6d894aa1b2c3d4e5f60718293a4b5c6d7e8f90'
const lanes = ['ui', 'adapter']

// ---- Runs in the producer's format -----------------------------------------------------------------------------------------

function graph() {
  return [
    ...lanes.map(lane => ({ node_id: `launch_${lane}`, label: `Launch ${lane} worker`, kind: 'worker', depends_on: [] })),
    { node_id: 'handoff', label: 'Freeze worker handoffs', kind: 'prepare', depends_on: lanes.map(lane => `launch_${lane}`) },
    { node_id: 'review', label: 'Independent review', kind: 'review', depends_on: ['handoff'] },
    { node_id: 'integrate', label: 'Integrate candidate', kind: 'integration', depends_on: ['review'] },
  ]
}

const workerInput = { role: 'builder', required_check_kinds: ['build'], task: '# task', prompt: null, owned_paths: ['src'], checks: [{ id: 'build', kind: 'build', argv: ['npm', 'run', 'build'], command: 'npm run build', timeout_seconds: 60, scenarios: [] }], launch: null, completion: null, handoff: null, stop: null, questions: [] }

async function seedRun(runsRoot: string, runId: string, integrated: boolean): Promise<string> {
  const dir = join(runsRoot, runId)
  await mkdir(dir, { recursive: true })
  const events = [{ sequence: 1, time: T0, node: 'ui', status: 'running', message: 'Launching or reconciling the exact native session' }]
  await writeFile(join(dir, 'events.jsonl'), events.map(event => `${JSON.stringify(event)}\n`).join(''))
  await writeFile(join(dir, 'plan.json'), JSON.stringify({ run_id: runId, base_commit: BASE, workers: lanes, automatic: { finish: 'verified-feature-branch' } }))
  const inputs = {
    feature: 'Widgets', policy_version: '1.1.0', base_commit: BASE, source_branch: 'feature/widgets/run-001', mode: 'automatic',
    automatic: { finish: 'verified-feature-branch', permission_mode: 'bypassPermissions', worker_timeout_seconds: 3600, review_timeout_seconds: 1800, reviewer_transport: 'native' },
    setup: [], max_verification_attempts: 3, failure_drill: null, selected_workers: lanes, workers: { ui: workerInput, adapter: workerInput },
  }
  const state = {
    version: '1.7.0', run_id: runId, base_commit: BASE, created_at: T0, updated_at: '2026-03-01T10:05:00.000000Z',
    definition: { name: 'Feature implementation', nodes: graph() }, values: { run_id: runId }, next: integrated ? [] : ['handoff'], tasks: [], events, verification_packets: [], inputs,
    ...(integrated ? { accepted: { version: '1.0.0', run_id: runId, candidate: HEAD, reason: 'merged by hand', by: 'operator', accepted_at: '2026-10-08T09:30:00Z', on_main: true, review: 'recorded', open_findings: [] } } : {}),
  }
  await writeFile(join(dir, 'run-state.json'), JSON.stringify(state, null, 2))
  return dir
}

// ---- GitHub reads shaped like the contract's examples -----------------------------------------------------------------------

type Variant = 'pushable' | 'pushed' | 'draft' | 'ready'

function readOf(variant: Variant, overrides: { visibility?: RunGithub['github']['visibility']; permission?: RunGithub['github']['viewer_permission']; status?: RunGithub['github']['status'] } = {}): RunGithub {
  const read = structuredClone(exampleGithub)
  read.project_id = PROJECT
  read.workflow_id = WORKFLOW
  read.github.visibility = overrides.visibility === undefined ? 'PUBLIC' : overrides.visibility
  read.github.viewer_permission = overrides.permission === undefined ? 'MAINTAIN' : overrides.permission
  if (overrides.status) read.github.status = overrides.status
  if (variant === 'pushable') {
    Object.assign(read.branch, {
      tracking_sha: null, github_sha: null, push_state: 'not_pushed', ahead_of_remote: null, behind_remote: null,
      unpublished: [
        { sha: HEAD, subject: 'Widgets: classify', author: 'Test <test@example.invalid>', committed_at: '2026-10-16T09:00:00Z' },
        { sha: 'b'.repeat(40), subject: 'Widgets: base', author: 'Test <test@example.invalid>', committed_at: '2026-10-16T08:00:00Z' },
      ],
      unpublished_more: 1,
    })
    read.pr = null
  } else if (variant === 'pushed') {
    read.pr = null
  } else if (variant === 'ready') {
    read.pr!.draft = false
  }
  return read
}

class FakeSource implements GithubSource {
  read_: RunGithub | Error = readOf('pushable')
  due: string[] = []
  authors = ['alice', 'bob', 'mani99brar', 'dependabot[bot]']
  async read(projectId: string, workflowId: string, runId: string): Promise<RunGithub> {
    if (this.read_ instanceof Error) throw this.read_
    return { ...structuredClone(this.read_), project_id: projectId, workflow_id: workflowId, run_id: runId }
  }
  markDue(projectId: string, workflowId: string, runId: string): void {
    this.due.push(`${projectId}/${workflowId}/${runId}`)
  }
  recentAuthors(): string[] {
    return this.authors
  }
}

// ---- A recording spawner (no real controller) --------------------------------------------------------------------------------

class FakeChild extends EventEmitter {
  pid: number
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  constructor(pid: number) { super(); this.pid = pid }
  unref() {}
}

type Call = { command: string; args: string[]; cwd: unknown; shell: unknown; body: { mode: number; text: string } | null }

function recorder() {
  const calls: Call[] = []
  const children: FakeChild[] = []
  const answers: { output: string; code: number | null }[] = []
  const spawn: SpawnFn = async (command, args, options) => {
    if (args[3] === '--help' && (args[2] === 'retry' || args[2] === 'relaunch')) {
      const child = new FakeChild(4000)
      setImmediate(() => { child.stdout.emit('data', Buffer.from(args[2] === 'retry' ? 'usage: retry [--all-failed]\n' : 'usage: relaunch\n')); child.emit('exit', 0, null) })
      return child as unknown as ChildProcess
    }
    const index = args.indexOf('--body-file')
    let body: Call['body'] = null
    if (index >= 0) body = { mode: statSync(args[index + 1]).mode & 0o777, text: readFileSync(args[index + 1], 'utf8') }
    calls.push({ command, args, cwd: options.cwd, shell: options.shell, body })
    const child = new FakeChild(5000 + calls.length)
    children.push(child)
    const answer = answers.shift() ?? { output: '', code: 0 }
    const fd = Array.isArray(options.stdio) ? options.stdio[1] : undefined
    if (answer.output && typeof fd === 'number') writeSync(fd, answer.output)
    if (answer.code !== null) { const code = answer.code; setImmediate(() => child.emit('exit', code, null)) }
    return child as unknown as ChildProcess
  }
  return { calls, children, answers, spawn }
}

async function rig(options: { actions?: boolean; source?: FakeSource | null; controls?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'md-manager-ghactions-'))
  const home = join(root, 'home')
  const wfhome = join(root, 'wfhome')
  const python = join(root, 'bin', 'python')
  const runsRoot = join(root, 'runs')
  const repository = join(home, 'dev', 'widgets')
  await mkdir(join(home, '.config', 'md-manager'), { recursive: true })
  await mkdir(repository, { recursive: true })
  await mkdir(wfhome, { recursive: true })
  await mkdir(join(root, 'bin'), { recursive: true })
  await mkdir(runsRoot, { recursive: true })
  await mkdir(join(root, 'proc'), { recursive: true })
  await writeFile(join(root, 'proc', 'locks'), '')
  await writeFile(python, '#!/bin/sh\nexit 0\n')
  await chmod(python, 0o755)
  const tokenFile = join(home, '.config', 'md-manager', 'controls.token')
  await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 })
  const env: Record<string, string> = {
    HOME: home, PATH: '/usr/bin:/bin', MD_MANAGER_RUN_CONTROLS: options.controls === false ? 'off' : 'on', MD_MANAGER_WORKFLOW_PYTHON: python, MD_MANAGER_WORKFLOW_HOME: wfhome,
    MD_MANAGER_CONTROLS_STATE: join(root, 'state'), MD_MANAGER_CONTROLS_PROC: join(root, 'proc'), MD_MANAGER_CONTROLS_SPAWN: 'direct', MD_MANAGER_WEB_PORT: WEB_PORT, MD_MANAGER_API_PORT: '3001',
    ...(options.actions === false ? {} : { MD_MANAGER_GITHUB_ACTIONS: 'on' }),
  }
  const setup = await loadControlsConfig(env)
  const config = await parseProjectsConfig(JSON.stringify({
    version: 1, projects: [{ project_id: PROJECT, name: PROJECT, repository, workflows: [{ workflow_id: WORKFLOW, runs_root: runsRoot, definition: { name: 'Feature implementation', nodes: graph() } }] }],
  }), 'test registry')
  const store = new RunStore(config, { home: root, summaryCache: false, procRoot: join(root, 'proc') })
  const spawner = recorder()
  const source = options.source === undefined ? new FakeSource() : options.source
  const app: FastifyInstance = Fastify({ logger: false })
  await app.register(controlRoutes, { prefix: CONTROLS_PREFIX, store, setup, now: () => NOW, runner: { spawn: spawner.spawn, systemdRun: true }, ...(source ? { github: source } : {}) })
  await seedRun(runsRoot, 'done', true)
  await seedRun(runsRoot, 'live', false)
  await app.ready()
  const url = (run: string, tail = '') => `/api/run-controls/${PROJECT}/${WORKFLOW}/${run}/github${tail}`
  const headers = (extra: Record<string, string | undefined> = {}) => {
    const all: Record<string, string | undefined> = {
      'content-type': 'application/json', host: `127.0.0.1:${WEB_PORT}`, origin: `http://127.0.0.1:${WEB_PORT}`, 'sec-fetch-site': 'same-origin', 'x-mdm-control-token': TOKEN, ...extra,
    }
    return Object.fromEntries(Object.entries(all).filter(([, value]) => value !== undefined)) as Record<string, string>
  }
  const view = async (run = 'done'): Promise<RunGithubActions> => {
    const response = await app.inject({ method: 'GET', url: url(run), headers: headers() })
    assert.equal(response.statusCode, 200, response.body)
    return runGithubActionsSchema.parse(response.json())
  }
  const post = (run: string, action: string, params: Record<string, unknown>, extra: { token?: string; request_id?: string; headers?: Record<string, string | undefined> } = {}) =>
    app.inject({ method: 'POST', url: url(run, `/${action}`), headers: headers(extra.headers), payload: JSON.stringify({ request_id: extra.request_id ?? crypto.randomUUID(), state_token: extra.token ?? 'stale', params }) })
  const act = async (run: string, action: GithubActionId, params: Record<string, unknown> = {}, extra: { request_id?: string } = {}) => post(run, action, params, { ...extra, token: (await view(run)).state_token })
  const close = async () => { await app.close(); await rm(root, { recursive: true, force: true }) }
  return { root, home, python, runsRoot, repository, source, spawner, app, url, headers, view, post, act, close, stateDir: join(root, 'state') }
}

async function withRig(options: Parameters<typeof rig>[0], body: (r: Awaited<ReturnType<typeof rig>>) => Promise<void>) {
  const r = await rig(options)
  try { await body(r) } finally { await r.close() }
}

const actionOf = (view: RunGithubActions, id: GithubActionId) => view.actions.find(action => action.id === id)!
const errorOf = (response: { json: () => unknown }) => controlErrorSchema.parse(response.json()).error
const BY = ['--by', 'operator']

// ---- Offers -------------------------------------------------------------------------------------------------------------------

test('[offers] off unless MD_MANAGER_GITHUB_ACTIONS=on: every action unavailable with the fixed reason, still the repository facts', async () => {
  await withRig({ actions: false }, async r => {
    const view = await r.view()
    assert.equal(view.enabled, false)
    assert.deepEqual(view.actions.map(action => action.id), [...GITHUB_ACTION_IDS])
    for (const action of view.actions) assert.deepEqual([action.available, action.reason], [false, GITHUB_ACTIONS_OFF])
    assert.equal(view.repo, 'kleros/vea')
    const refused = await r.post('done', 'push_branch', { confirm_repo: 'kleros/vea' }, { token: view.state_token })
    assert.equal(refused.statusCode, 422)
    assert.equal(errorOf(refused).message, GITHUB_ACTIONS_OFF)
    assert.equal(r.spawner.calls.length, 0)
  })
})

test('[offers] with run controls off the GitHub routes answer 404 CONTROLS_DISABLED', async () => {
  await withRig({ controls: false }, async r => {
    const response = await r.app.inject({ method: 'GET', url: r.url('done'), headers: r.headers() })
    assert.equal(response.statusCode, 404)
    assert.equal(errorOf(response).code, 'CONTROLS_DISABLED')
  })
})

test('[offers] the matrix: push on a public repo asks for the repo typed, a private one is plain; READ, not integrated, pushed, PR open, draft or ready', async () => {
  await withRig({}, async r => {
    const source = r.source!
    let view = await r.view()
    let push = actionOf(view, 'push_branch')
    assert.equal(push.available, true, push.reason ?? '')
    assert.equal(push.confirm, 'typed_repo')
    assert.deepEqual(push.params, [{ name: 'confirm_repo', kind: 'typed', required: true }])
    assert.equal(push.publishes, '3 commits (with author names and emails) become public on kleros/vea')
    assert.equal(push.command, `$PY -m workflow github push "$RUN" --repo ~/dev/widgets --sha ${HEAD.slice(0, 12)} --by operator`)
    assert.equal(actionOf(view, 'open_pr').reason, 'Push the branch first: GitHub does not have the run branch at its head')
    assert.equal(actionOf(view, 'mark_ready').reason, 'No pull request is open for this branch')
    assert.equal(actionOf(view, 'request_reviewers').reason, 'No pull request is open for this branch')

    source.read_ = readOf('pushable', { visibility: 'PRIVATE' })
    push = actionOf(await r.view(), 'push_branch')
    assert.deepEqual([push.confirm, push.params], ['plain', []])
    assert.match(push.publishes, /visible to everyone with access to kleros\/vea \(PRIVATE\)/)
    source.read_ = readOf('pushable', { visibility: null })
    push = actionOf(await r.view(), 'push_branch')
    assert.equal(push.confirm, 'typed_repo')
    assert.match(push.publishes, /not known, so treat it as public/)

    source.read_ = readOf('pushable', { permission: 'READ' })
    assert.equal(actionOf(await r.view(), 'push_branch').reason, 'Your GitHub account has READ access to kleros/vea; a push needs WRITE')
    source.read_ = readOf('pushable', { status: 'pending' })
    assert.equal(actionOf(await r.view(), 'push_branch').reason, 'GitHub has not been read for this branch yet; it is read within a minute')
    source.read_ = readOf('pushable')
    assert.equal(actionOf(await r.view('live'), 'push_branch').reason, 'Only an integrated or accepted run\'s branch is pushed')

    source.read_ = readOf('pushed')
    view = await r.view()
    assert.equal(actionOf(view, 'push_branch').reason, 'The branch is already on GitHub at the same commit')
    const open = actionOf(view, 'open_pr')
    assert.equal(open.available, true, open.reason ?? '')
    assert.equal(open.confirm, 'typed_repo')
    assert.deepEqual(open.params.map(param => param.name), ['title', 'body', 'confirm_repo'])
    assert.equal(open.defaults.title, 'Widgets: done')
    assert.match(open.defaults.body!, /^### Widgets: done\n/)
    assert.match(open.defaults.body!, /\*\*Branch:\*\* `feature\/relayer-revert-shapes\/run-001`/)
    assert.ok(!open.defaults.body!.includes(r.home), 'no home path in the generated body')
    assert.equal(open.command, '$PY -m workflow github pr "$RUN" --repo ~/dev/widgets --base dev --title <title> --body-file <body> --by operator')

    source.read_ = readOf('draft')
    view = await r.view()
    assert.equal(actionOf(view, 'open_pr').reason, 'Pull request #531 is already open for this branch')
    assert.equal(actionOf(view, 'mark_ready').available, true)
    assert.equal(actionOf(view, 'mark_ready').confirm, 'plain')
    const reviewers = actionOf(view, 'request_reviewers')
    assert.equal(reviewers.available, true)
    assert.deepEqual(reviewers.params, [{ name: 'reviewers', kind: 'list', max_items: 15, suggestions: ['kleros/vea-maintainers', 'jaybuidl', 'gitguardian', 'alice', 'bob'], required: true }])
    assert.deepEqual(reviewers.defaults, { reviewers: [] })
    source.read_ = readOf('ready')
    assert.equal(actionOf(await r.view(), 'mark_ready').reason, 'Pull request #531 is already ready for review')
  })
})

test('[offers] no source, or a source that fails, leaves every action unavailable with a fixed reason', async () => {
  await withRig({ source: null }, async r => {
    for (const action of (await r.view()).actions) assert.equal(action.reason, GITHUB_READ_MISSING)
  })
  const failing = new FakeSource()
  failing.read_ = new Error('gh exploded at /home/someone/secret')
  await withRig({ source: failing }, async r => {
    const view = await r.view()
    for (const action of view.actions) assert.equal(action.reason, GITHUB_READ_FAILED)
    assert.equal(view.repo, null)
  })
})

// ---- Commands -------------------------------------------------------------------------------------------------------------

test('[argv] each action runs exactly one fixed controller command, as the operator, without a shell', async () => {
  await withRig({}, async r => {
    const source = r.source!
    const runDir = join(r.runsRoot, 'done')
    r.spawner.answers.push({ output: `Pushed ${HEAD.slice(0, 12)} to kleros/vea refs/heads/x (new branch).\n`, code: 0 })
    let response = await r.act('done', 'push_branch', { confirm_repo: 'kleros/vea' })
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(r.spawner.calls[0].args, ['-m', 'workflow', 'github', 'push', runDir, '--repo', r.repository, '--sha', HEAD, ...BY])
    assert.equal(r.spawner.calls[0].command, r.python)
    assert.equal(r.spawner.calls[0].shell, false)

    source.read_ = readOf('pushed')
    r.spawner.answers.push({ output: 'Creating draft pull request\nhttps://github.com/kleros/vea/pull/532\n', code: 0 })
    response = await r.act('done', 'open_pr', { title: 'Widgets: done', body: 'Body\n\nwith `code`', confirm_repo: 'kleros/vea' })
    assert.equal(response.statusCode, 200, response.body)
    const pr = r.spawner.calls[1].args
    const bodyFile = pr[pr.indexOf('--body-file') + 1]
    assert.deepEqual(pr, ['-m', 'workflow', 'github', 'pr', runDir, '--repo', r.repository, '--base', 'dev', '--title', 'Widgets: done', '--body-file', bodyFile, ...BY])

    source.read_ = readOf('draft')
    response = await r.act('done', 'mark_ready')
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(r.spawner.calls[2].args, ['-m', 'workflow', 'github', 'ready', runDir, '--repo', r.repository, '--pr', '531', ...BY])

    response = await r.act('done', 'request_reviewers', { reviewers: ['jaybuidl', ' kleros/vea-maintainers', 'jaybuidl'] })
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(r.spawner.calls[3].args, ['-m', 'workflow', 'github', 'reviewers', runDir, '--repo', r.repository, '--pr', '531', '--add', 'jaybuidl,kleros/vea-maintainers', ...BY])
    assert.equal(r.spawner.calls.length, 4)
    for (const call of r.spawner.calls) {
      assert.ok(!call.args.some(arg => arg === '--force' || arg === '-f' || arg.startsWith('+')))
      assert.equal(call.args.filter(arg => arg === '--by').length, 1)
    }
  })
})

test('[records] the record validates, keeps body_chars not the body, extracts the URL, marks the branch due; newest first', async () => {
  await withRig({}, async r => {
    const source = r.source!
    source.read_ = readOf('pushed')
    const body = 'Secret-free body\n'.repeat(3)
    r.spawner.answers.push({ output: 'Creating draft pull request\nhttps://github.com/kleros/vea/pull/532\n', code: 0 })
    const response = await r.act('done', 'open_pr', { title: 'Widgets: done', body, confirm_repo: 'kleros/vea' })
    assert.equal(response.statusCode, 200, response.body)
    const record = githubActionResponseSchema.parse(response.json()).record
    githubActionRecordSchema.parse(record)
    assert.match(record.record_id, /^g-[0-9a-f]{12}$/)
    assert.deepEqual(record.params, { title: 'Widgets: done', body_chars: body.length })
    assert.equal(record.status, 'succeeded')
    assert.equal(record.exit_code, 0)
    assert.equal(record.url, 'https://github.com/kleros/vea/pull/532')
    assert.equal(record.command, '$PY -m workflow github pr "$RUN" --repo ~/dev/widgets --base dev --title "Widgets: done" --body-file <body> --by operator')
    assert.deepEqual(source.due, [`${PROJECT}/${WORKFLOW}/done`])
    const stored = await readFile(join(r.stateDir, PROJECT, WORKFLOW, 'done.github.jsonl'), 'utf8')
    assert.ok(!stored.includes('Secret-free body'), 'the body text is never kept')
    assert.ok(!stored.includes(TOKEN))

    source.read_ = readOf('draft')
    r.spawner.answers.push({ output: 'Blocked: pull request #531 is not a draft (already ready for review)\n', code: 2 })
    const failed = githubActionResponseSchema.parse((await r.act('done', 'mark_ready')).json()).record
    assert.deepEqual([failed.status, failed.exit_code, failed.url], ['failed', 2, null])
    assert.equal(failed.output_tail[0], 'Blocked: pull request #531 is not a draft (already ready for review)')
    assert.equal(source.due.length, 1, 'a failure marks nothing due')
    const view = await r.view()
    assert.deepEqual(view.records.map(item => item.action), ['mark_ready', 'open_pr'])
  })
})

test('[body] the body file is mode 600 under the controls state while the command runs and removed after it', async () => {
  await withRig({}, async r => {
    r.source!.read_ = readOf('pushed')
    r.spawner.answers.push({ output: 'https://github.com/kleros/vea/pull/532\n', code: 0 })
    const response = await r.act('done', 'open_pr', { title: 'T', body: 'The body as typed.\n', confirm_repo: 'kleros/vea' })
    assert.equal(response.statusCode, 200, response.body)
    const call = r.spawner.calls[0]
    assert.deepEqual(call.body, { mode: 0o600, text: 'The body as typed.\n' })
    const file = call.args[call.args.indexOf('--body-file') + 1]
    assert.ok(file.startsWith(join(r.stateDir, PROJECT, WORKFLOW)), 'beside the records, never in the run directory')
    assert.ok(!(await readdir(join(r.stateDir, PROJECT, WORKFLOW))).some(name => name.endsWith('.body.md')), 'removed after the command')
    // A command that fails removes it too.
    r.source!.read_ = readOf('pushed')
    r.spawner.answers.push({ output: 'Failed: gh pr create failed (HTTP 422)\n', code: 1 })
    assert.equal((await r.act('done', 'open_pr', { title: 'T', body: 'B', confirm_repo: 'kleros/vea' })).statusCode, 200)
    assert.ok(!(await readdir(join(r.stateDir, PROJECT, WORKFLOW))).some(name => name.endsWith('.body.md')))
  })
})

test('[redaction] a token URL and the home path never reach the output tail; output is capped at 40 lines', async () => {
  await withRig({}, async r => {
    const lines = Array.from({ length: 45 }, (_, n) => `line ${n}`)
    r.spawner.answers.push({ output: `${lines.join('\n')}\nFailed: git push failed (fatal: unable to access 'https://bot:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/kleros/vea.git/' at ${r.home}/dev/widgets)\n`, code: 1 })
    const record = githubActionResponseSchema.parse((await r.act('done', 'push_branch', { confirm_repo: 'kleros/vea' })).json()).record
    assert.equal(record.output_tail.length, 40)
    const text = record.output_tail.join('\n')
    assert.ok(!text.includes('ghp_abcdef'), text)
    assert.ok(!text.includes('bot:'))
    assert.ok(!text.includes(r.home))
    assert.match(text, /https:\/\/github\.com\/kleros\/vea\.git\/' at ~\/dev\/widgets/)
  })
})

// ---- Guards ---------------------------------------------------------------------------------------------------------------

test('[guards] the new routes need the pairing token and the page\'s origin', async () => {
  await withRig({}, async r => {
    const noToken = await r.app.inject({ method: 'GET', url: r.url('done'), headers: r.headers({ 'x-mdm-control-token': undefined }) })
    assert.equal(noToken.statusCode, 403)
    assert.equal(errorOf(noToken).code, 'TOKEN_REQUIRED')
    const token = (await r.view()).state_token
    const cases: [Record<string, string | undefined>, number, string][] = [
      [{ 'x-mdm-control-token': undefined }, 403, 'TOKEN_REQUIRED'],
      [{ 'x-mdm-control-token': 'wrong-token-wrong-token-wrong-token-00' }, 403, 'TOKEN_INVALID'],
      [{ origin: 'http://evil.example' }, 403, 'FORBIDDEN_ORIGIN'],
      [{ host: 'evil.example:5173' }, 403, 'FORBIDDEN_ORIGIN'],
      [{ 'sec-fetch-site': 'cross-site' }, 403, 'FORBIDDEN_ORIGIN'],
      [{ 'content-type': 'text/plain' }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ]
    for (const [headers, status, code] of cases) {
      const response = await r.post('done', 'push_branch', { confirm_repo: 'kleros/vea' }, { token, headers })
      assert.equal(response.statusCode, status, JSON.stringify(headers))
      assert.equal(errorOf(response).code, code)
    }
    assert.equal(r.spawner.calls.length, 0)
    const unknown = await r.post('done', 'comment', {}, { token })
    assert.equal(unknown.statusCode, 404)
  })
})

test('[guards] a stale state token is STATE_CHANGED, a repeat request_id runs once, a second action while one runs is BUSY', async () => {
  await withRig({}, async r => {
    const before = await r.view()
    r.source!.read_ = readOf('pushable', { visibility: 'PRIVATE' })
    const stale = await r.post('done', 'push_branch', {}, { token: before.state_token })
    assert.equal(stale.statusCode, 409)
    assert.equal(errorOf(stale).code, 'STATE_CHANGED')

    const requestId = crypto.randomUUID()
    const first = await r.act('done', 'push_branch', {}, { request_id: requestId })
    assert.equal(first.statusCode, 200, first.body)
    const again = await r.post('done', 'push_branch', {}, { request_id: requestId, token: 'anything' })
    assert.equal(again.statusCode, 200)
    assert.deepEqual(again.json(), first.json())
    assert.equal(r.spawner.calls.length, 1, 'a repeat runs nothing')

    r.source!.read_ = readOf('draft')
    const token = (await r.view()).state_token
    r.spawner.answers.push({ output: '', code: null })
    const running = r.post('done', 'mark_ready', {}, { token })
    for (let attempt = 0; attempt < 200 && r.spawner.calls.length < 2; attempt++) await new Promise(resolve => setTimeout(resolve, 5))
    const busy = await r.post('done', 'request_reviewers', { reviewers: ['alice'] }, { token })
    assert.equal(busy.statusCode, 409)
    assert.equal(errorOf(busy).code, 'BUSY')
    r.spawner.children.at(-1)!.emit('exit', 0, null)
    assert.equal((await running).statusCode, 200)
  })
})

test('[params] the typed repository is compared exactly; titles, bodies and reviewers are bounded server-side', async () => {
  await withRig({}, async r => {
    const cases: [GithubActionId, Variant, Record<string, unknown>, RegExp][] = [
      ['push_branch', 'pushable', {}, /"confirm_repo" is required/],
      ['push_branch', 'pushable', { confirm_repo: 'KLEROS/VEA' }, /does not match kleros\/vea/],
      ['push_branch', 'pushable', { confirm_repo: 'kleros/vea', title: 'x' }, /"title" does not belong/],
      ['open_pr', 'pushed', { title: 'two\nlines', body: 'b', confirm_repo: 'kleros/vea' }, /one line/],
      ['open_pr', 'pushed', { title: 'x'.repeat(257), body: 'b', confirm_repo: 'kleros/vea' }, /1 to 256 characters/],
      ['open_pr', 'pushed', { title: 'ok', body: '   ', confirm_repo: 'kleros/vea' }, /1 to 60000/],
      ['open_pr', 'pushed', { title: 'ok', body: 'x'.repeat(60001), confirm_repo: 'kleros/vea' }, /1 to 60000/],
      ['request_reviewers', 'draft', { reviewers: ['-rf'] }, /not a GitHub login/],
      ['request_reviewers', 'draft', { reviewers: ['a/b/c'] }, /not a GitHub login/],
      ['request_reviewers', 'draft', { reviewers: [] }, /at least one reviewer/],
      ['request_reviewers', 'draft', { reviewers: Array.from({ length: 16 }, (_, n) => `user${n}`) }, /at most 15/],
    ]
    for (const [action, variant, params, message] of cases) {
      r.source!.read_ = readOf(variant)
      const response = await r.act('done', action, params)
      assert.equal(response.statusCode, 400, `${action} ${JSON.stringify(params).slice(0, 80)}: ${response.body}`)
      assert.equal(errorOf(response).code, 'INVALID_PARAMS')
      assert.match(errorOf(response).message, message)
    }
    assert.equal(r.spawner.calls.length, 0)
    r.source!.read_ = readOf('ready')
    const unoffered = await r.act('done', 'mark_ready')
    assert.equal(unoffered.statusCode, 422)
    assert.equal(errorOf(unoffered).code, 'NOT_AVAILABLE')
  })
})

// ---- Pure parts ---------------------------------------------------------------------------------------------------------------

test('[pure] the state token follows the branch and the pull request; names, branches and URLs', () => {
  const pushed = readOf('pushed')
  const moved = structuredClone(pushed)
  moved.branch.local_sha = 'c'.repeat(40)
  assert.notEqual(githubStateToken(pushed, 'succeeded'), githubStateToken(moved, 'succeeded'))
  const drafted = readOf('draft')
  const readied = readOf('ready')
  assert.notEqual(githubStateToken(drafted, 'succeeded'), githubStateToken(readied, 'succeeded'))
  assert.equal(githubStateToken(pushed, 'succeeded'), githubStateToken(structuredClone(pushed), 'succeeded'))
  assert.ok(isReviewerName('jaybuidl') && isReviewerName('kleros/vea-maintainers') && !isReviewerName('-x') && !isReviewerName('a'.repeat(40)))
  assert.ok(isBranchName('feature/w/run-001') && !isBranchName('-x') && !isBranchName('a..b') && !isBranchName('a b') && !isBranchName(null))
  assert.equal(urlOf(['Creating', 'see https://github.com/o/n/pull/3.']), 'https://github.com/o/n/pull/3')
  assert.equal(urlOf(['nothing']), null)
  assert.deepEqual(reviewerSuggestions(readOf('draft'), ['mani99brar', 'renovate[bot]', 'carol']), ['kleros/vea-maintainers', 'jaybuidl', 'gitguardian', 'carol'])
})
