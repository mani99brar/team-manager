import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { createApp, type ProjectsConfig } from './app.ts'
import { GitReader, discoverGithubRepos, parseGithubRemote, readGitState, realGitRunner, type GitInput } from './dispatchGit.ts'
import { GH_REASONS, GithubReader, githubArgv, parseGithub, type GhResult } from './dispatchGithub.ts'
import { buildDigest } from './dispatchSteps.ts'
import type { LoadedRun } from './projects.ts'

/**
 * server/dispatch.test.ts (PRD_PROJECTS_DISPATCH section 7): the git state over temporary repositories, the GitHub
 * reader with an injected clock and gh runner, and the step digests. Every path lives under a temporary directory and
 * every git command runs with an isolated global config and an explicit identity ([L2], design-challenge note 9), so
 * the real `~/.config`, `~/.cache` and `~/.gitconfig` are never touched. `frontend-unit` runs this file.
 */

const ROOT = mkdtempSync(join(tmpdir(), 'dispatch-test-'))
after(() => rmSync(ROOT, { recursive: true, force: true }))

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' })
}
let seq = 0
function fresh(name: string): string {
  const dir = join(ROOT, `${name}-${seq++}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
function commit(repo: string, message: string, file = 'f.txt'): void {
  writeFileSync(join(repo, file), `${message}\n${Math.random()}`)
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', message)
}

const CLOCK = Date.parse('2026-10-11T00:00:00Z')
const now = () => CLOCK
const runner = realGitRunner()

/** A bare origin on `main` with one commit, and a clone of it (origin-tracking reflog written by the clone). */
function originAndClone(): { origin: string; clone: string; seed: string } {
  const origin = fresh('origin')
  git(origin, 'init', '--bare', '--initial-branch=main', '.')
  const seed = fresh('seed')
  git(seed, 'init', '-b', 'main', '.')
  commit(seed, 'c1')
  git(seed, 'remote', 'add', 'origin', origin)
  git(seed, 'push', 'origin', 'main')
  const clone = fresh('clone')
  git(clone, 'clone', origin, '.')
  return { origin, clone, seed }
}

async function stateOf(repo: string, input: Partial<GitInput> = {}) {
  return readGitState(
    { project_id: 'p', repository: repo, run_ids: input.run_ids ?? new Set(), landings: input.landings ?? [] },
    '/home/tester', runner, now,
  )
}

// ---- Git state ---------------------------------------------------------------------------------

test('git: a clone 2 ahead and 1 behind reports compared counts, both ahead commits, the run name, and a reflog-dated updated_at', async () => {
  const { origin, clone, seed } = originAndClone()
  commit(clone, 'Workflow run-ahead-1: first ahead')
  commit(clone, 'second ahead')
  commit(seed, 'c2')
  git(seed, 'push', 'origin', 'main')
  git(clone, 'fetch', 'origin')

  const { state } = await stateOf(clone, { run_ids: new Set(['run-ahead-1']) })
  assert.equal(state.status, 'read')
  assert.equal(state.default_branch, 'main')
  assert.ok(state.origin)
  assert.equal(state.origin!.compare, 'compared')
  assert.equal(state.origin!.ahead, 2)
  assert.equal(state.origin!.behind, 1)
  assert.equal(state.origin!.ref, 'origin/main')
  assert.ok(state.origin!.updated_at, 'updated_at comes from the remote-tracking reflog')
  assert.equal(state.ahead_commits.length, 2)
  assert.equal(state.ahead_naming_run, 1)
  const named = state.ahead_commits.find(c => c.run_id !== null)
  assert.equal(named!.run_id, 'run-ahead-1')

  // A fetch of a second remote does not change origin/main's reflog time.
  const before = state.origin!.updated_at
  const other = fresh('other')
  git(other, 'init', '--bare', '--initial-branch=main', '.')
  git(clone, 'remote', 'add', 'other', other)
  git(clone, 'fetch', 'other')
  const again = await readGitState({ project_id: 'p', repository: clone, run_ids: new Set(['run-ahead-1']), landings: [] }, '/home/tester', runner, now)
  assert.equal(again.state.origin!.updated_at, before)
  void origin
})

test('git: 60 ahead, 55 naming runs, lists 50 and counts 55 over all', async () => {
  const { clone } = originAndClone()
  const runIds = new Set<string>()
  for (let i = 0; i < 60; i += 1) {
    if (i < 55) { const id = `run-${i}`; runIds.add(id); commit(clone, `Workflow ${id}: change ${i}`) }
    else commit(clone, `ordinary ${i}`)
  }
  const { state } = await stateOf(clone, { run_ids: runIds })
  assert.equal(state.origin!.ahead, 60)
  assert.equal(state.ahead_commits.length, 50)
  assert.equal(state.ahead_naming_run, 55)
})

test('git: a worktree shares the clone_id of its clone', async () => {
  const { clone } = originAndClone()
  const wt = join(ROOT, `wt-${seq++}`)
  git(clone, 'worktree', 'add', '--detach', wt)
  const a = await stateOf(clone)
  const b = await stateOf(wt)
  assert.ok(a.state.clone_id)
  assert.equal(a.state.clone_id, b.state.clone_id)
  assert.equal(b.state.checkout, null, 'the detached worktree has no checkout branch')
})

test('git: a clone without a local default branch is no_local_branch with null counts', async () => {
  const { clone } = originAndClone()
  git(clone, 'checkout', '--detach', 'HEAD')
  git(clone, 'branch', '-D', 'main')
  const { state } = await stateOf(clone)
  assert.equal(state.default_branch, 'main', 'origin/HEAD still names main')
  assert.ok(state.origin)
  assert.equal(state.origin!.compare, 'no_local_branch')
  assert.equal(state.origin!.ahead, null)
  assert.equal(state.origin!.behind, null)
})

test('git: a repository without an origin ref has origin null', async () => {
  const repo = fresh('solo')
  git(repo, 'init', '-b', 'main', '.')
  commit(repo, 'only')
  const { state, githubRepo } = await stateOf(repo)
  assert.equal(state.status, 'read')
  assert.equal(state.default_branch, 'main')
  assert.equal(state.origin, null)
  assert.equal(githubRepo, null)
})

test('git: a missing path and a non-repository are unavailable with fixed reasons', async () => {
  const missing = await stateOf(join(ROOT, 'does-not-exist'))
  assert.equal(missing.state.status, 'unavailable')
  assert.equal(missing.state.reason, 'repository not found')

  // A plain directory nested inside a repository must not report the parent's state (design-challenge note 5).
  const repo = fresh('outer')
  git(repo, 'init', '-b', 'main', '.')
  commit(repo, 'c')
  const inner = join(repo, 'plain')
  mkdirSync(inner)
  const nested = await stateOf(inner)
  assert.equal(nested.state.status, 'unavailable')
  assert.equal(nested.state.reason, 'not a git repository')
})

test('git: a detached HEAD has checkout null', async () => {
  const repo = fresh('detached')
  git(repo, 'init', '-b', 'main', '.')
  commit(repo, 'c')
  git(repo, 'checkout', '--detach', 'HEAD')
  const { state } = await stateOf(repo)
  assert.equal(state.checkout, null)
})

test('git: no response field holds an absolute path (label is ~-relative under HOME, else a basename)', async () => {
  const { clone } = originAndClone()
  const underHome = await readGitState({ project_id: 'p', repository: clone, run_ids: new Set(), landings: [] }, ROOT, runner, now)
  assert.ok(underHome.state.repository_label.startsWith('~/'), underHome.state.repository_label)
  const basename = await readGitState({ project_id: 'p', repository: clone, run_ids: new Set(), landings: [] }, '/somewhere/else', runner, now)
  assert.ok(!basename.state.repository_label.includes('/'), basename.state.repository_label)
})

test('git: default branch is origin/HEAD, else main, then master, else null', async () => {
  const masterRepo = fresh('master')
  git(masterRepo, 'init', '-b', 'master', '.')
  commit(masterRepo, 'c')
  assert.equal((await stateOf(masterRepo)).state.default_branch, 'master')

  const empty = fresh('empty')
  git(empty, 'init', '-b', 'main', '.')
  const emptyState = (await stateOf(empty)).state
  assert.equal(emptyState.default_branch, null)
  assert.equal(emptyState.head, null)
})

test('git: landings are true/true on both, true/false on local only, and null for a missing sha', async () => {
  const { clone, seed, origin } = originAndClone()
  const base = git(clone, 'rev-parse', 'HEAD').trim() // c1, on local and origin
  commit(clone, 'local-only')
  const localOnly = git(clone, 'rev-parse', 'HEAD').trim()
  const { state } = await stateOf(clone, {
    landings: [
      { workflow_id: 'w', run_id: 'r1', sha: base },
      { workflow_id: 'w', run_id: 'r2', sha: localOnly },
      { workflow_id: 'w', run_id: 'r3', sha: 'deadbeef' },
    ],
  })
  const byRun = Object.fromEntries(state.landings.map(l => [l.run_id, l]))
  assert.deepEqual([byRun.r1.on_default, byRun.r1.on_origin], [true, true])
  assert.deepEqual([byRun.r2.on_default, byRun.r2.on_origin], [true, false])
  assert.deepEqual([byRun.r3.on_default, byRun.r3.on_origin], [null, null])
  void seed; void origin
})

test('git: a github origin remote is parsed into owner/name', async () => {
  const repo = fresh('gh')
  git(repo, 'init', '-b', 'main', '.')
  commit(repo, 'c')
  git(repo, 'remote', 'add', 'origin', 'https://github.com/kleros/kleros-v2.git')
  assert.equal((await stateOf(repo)).githubRepo, 'kleros/kleros-v2')
})

test('parseGithubRemote accepts the three forms and rejects non-GitHub and lookalike hosts', () => {
  assert.equal(parseGithubRemote('https://github.com/kleros/kleros-v2'), 'kleros/kleros-v2')
  assert.equal(parseGithubRemote('https://github.com/kleros/kleros-v2.git'), 'kleros/kleros-v2')
  assert.equal(parseGithubRemote('ssh://git@github.com/o/n.git'), 'o/n')
  assert.equal(parseGithubRemote('git@github.com:o/n.git'), 'o/n')
  assert.equal(parseGithubRemote('https://evilgithub.com/o/n'), null)
  assert.equal(parseGithubRemote('https://github.com.evil.com/o/n'), null)
  assert.equal(parseGithubRemote('/local/path/repo.git'), null)
  assert.equal(parseGithubRemote('https://gitlab.com/o/n'), null)
})

test('git reads are cached 15 s per repository', async () => {
  const { clone } = originAndClone()
  let calls = 0
  const counting = async (repo: string, args: readonly string[]): Promise<GitResultLike> => { calls += 1; return runner(repo, args) }
  let t = CLOCK
  const reader = new GitReader(counting, '/home/tester', () => t)
  const input: GitInput = { project_id: 'p', repository: clone, run_ids: new Set(), landings: [] }
  await reader.read(input)
  const first = calls
  await reader.read(input)
  assert.equal(calls, first, 'a second read within 15 s runs no git')
  t += 16_000
  await reader.read(input)
  assert.ok(calls > first, 'after the window the repository is read again')
})

type GitResultLike = Awaited<ReturnType<typeof runner>>

// ---- GitHub reader -----------------------------------------------------------------------------

const GRAPHQL = JSON.stringify({
  data: {
    viewer: { login: 'mani99brar' },
    repository: {
      visibility: 'PUBLIC', pushedAt: '2026-10-10T21:15:00Z',
      defaultBranchRef: { name: 'main', target: { oid: '6ac7f5c1d2e3', committedDate: '2026-10-10T21:14:00Z' } },
      openPRs: { totalCount: 2 }, openIssues: { totalCount: 5 },
      pullRequests: { nodes: [
        {
          number: 42, title: 'Human PR', url: 'u', state: 'OPEN', isDraft: false,
          author: { login: 'mani99brar', __typename: 'User' }, headRefName: 'f', baseRefName: 'main',
          updatedAt: '2026-10-11T02:00:00Z', mergedAt: null, reviewDecision: 'REVIEW_REQUIRED',
          labels: { nodes: [{ name: 'feature' }] },
          commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
            { __typename: 'StatusContext', state: 'SUCCESS' },
            { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
            { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null },
          ] } } } }] },
        },
        {
          number: 40, title: 'Bot PR', url: 'u', state: 'MERGED', isDraft: false,
          author: { login: 'dependabot', __typename: 'Bot' }, headRefName: 'd', baseRefName: 'main',
          updatedAt: '2026-10-09T10:00:00Z', mergedAt: '2026-10-09T10:05:00Z', reviewDecision: null,
          labels: { nodes: [] }, commits: { nodes: [] },
        },
      ] },
      issues: { nodes: [
        { number: 101, title: 'Issue', url: 'u', author: null, labels: { nodes: [] }, assignees: { nodes: [{ login: 'mani99brar' }] }, createdAt: '2026-10-08T09:00:00Z', updatedAt: '2026-10-10T12:00:00Z' },
      ] },
    },
  },
})

function ghOk(): GhResult { return { code: 0, stdout: GRAPHQL, stderr: '', timedOut: false, enoent: false } }

test('github: off state', () => {
  const reader = new GithubReader({ mode: 'off', now })
  const s = reader.state('o/n', false)
  assert.equal(s.status, 'off')
  assert.equal(s.reason, GH_REASONS.off)
  assert.equal(s.repo, 'o/n')
  assert.equal(reader.viewerLogin, null)
})

test('github: not_github for a git-unavailable project and for a non-GitHub remote', () => {
  const reader = new GithubReader({ mode: 'runner', now, runner: async () => ghOk() })
  assert.equal(reader.state(null, true).status, 'unavailable')
  assert.equal(reader.state(null, true).reason, GH_REASONS.gitNotRead)
  assert.equal(reader.state(null, false).status, 'not_github')
  assert.equal(reader.state(null, false).reason, GH_REASONS.notGithub)
})

test('github: pending before the first read, then read with every Appendix A field (open_issues excludes PRs, a bot author)', async () => {
  const reader = new GithubReader({ mode: 'runner', now, runner: async () => ghOk() })
  reader.register(['o/n'])
  assert.equal(reader.state('o/n', false).status, 'pending')
  assert.equal(reader.state('o/n', false).reason, GH_REASONS.pending)
  await reader.refreshDue()
  const s = reader.state('o/n', false)
  assert.equal(s.status, 'read')
  assert.equal(s.visibility, 'PUBLIC')
  assert.equal(s.default_branch, 'main')
  assert.equal(s.head!.sha, '6ac7f5c1d2e3')
  assert.equal(s.open_prs, 2)
  assert.equal(s.open_issues, 5, 'open_issues is the issue totalCount, not the PR list length')
  assert.equal(s.prs.length, 2)
  assert.deepEqual(s.prs[0].checks, { passing: 1, failing: 1, pending: 1 })
  assert.equal(s.prs[1].author, 'dependabot')
  assert.equal(s.prs[1].author_is_bot, true)
  assert.equal(s.issues[0].author, 'ghost', 'a null author maps to ghost')
  assert.equal(s.issues[0].author_is_bot, false)
  assert.equal(reader.viewerLogin, 'mani99brar')
})

test('github: a failed refresh keeps status read, the data and read_at, and sets reason', async () => {
  let impl: () => Promise<GhResult> = async () => ghOk()
  let t = CLOCK
  const reader = new GithubReader({ mode: 'runner', now: () => t, runner: async () => impl() })
  reader.register(['o/n'])
  await reader.refreshDue()
  const good = reader.state('o/n', false)
  assert.equal(good.status, 'read')
  impl = async () => ({ code: 1, stdout: '', stderr: 'ghp_tokenSecret boom', timedOut: false, enoent: false })
  t += 16 * 60_000
  await reader.refreshDue()
  const after = reader.state('o/n', false)
  assert.equal(after.status, 'read', 'a failed refresh keeps the last good read')
  assert.equal(after.read_at, good.read_at)
  assert.equal(after.open_prs, 2)
  assert.equal(after.reason, 'gh failed (exit 1)')
  assert.ok(!after.reason!.includes('ghp_'), 'no token-looking stderr reaches the response')
})

test('github: requests within the refresh window never call the runner; the tick reads a due repository', async () => {
  let calls = 0
  let t = CLOCK
  const reader = new GithubReader({ mode: 'runner', now: () => t, refreshMinutes: 15, runner: async () => { calls += 1; return ghOk() } })
  reader.register(['o/n'])
  await reader.refreshDue()
  assert.equal(calls, 1)
  t += 5 * 60_000
  await reader.refreshDue()
  assert.equal(calls, 1, 'within the window no runner call is made')
  t += 11 * 60_000
  await reader.refreshDue()
  assert.equal(calls, 2, 'past the window the due repository is read')
})

test('github: the fixture is read on the first request and writes no cache', () => {
  const read = parseGithub(GRAPHQL).read
  const cachePath = join(fresh('cache'), 'github.json')
  const reader = new GithubReader({ mode: 'fixture', now, cachePath, fixture: { viewer_login: 'mani99brar', repos: { 'o/n': { ...read, read_at: '2026-10-11T00:00:00Z' } } } })
  assert.equal(reader.state('o/n', false).status, 'read')
  assert.equal(reader.state('x/y', false).status, 'unavailable')
  assert.equal(reader.state('x/y', false).reason, GH_REASONS.notInFixture)
  assert.equal(existsSync(cachePath), false, 'a fixture never writes the cache ([P20])')
})

test('github: the fixed failure reasons, never raw stderr', async () => {
  const cases: [GhResult, string][] = [
    [{ code: -1, stdout: '', stderr: '', timedOut: false, enoent: true }, GH_REASONS.notInstalled],
    [{ code: 4, stdout: '', stderr: 'gh auth login required', timedOut: false, enoent: false }, GH_REASONS.notLoggedIn],
    [{ code: -1, stdout: '', stderr: '', timedOut: true, enoent: false }, GH_REASONS.timedOut],
    [{ code: 2, stdout: '', stderr: 'ghp_secrettoken', timedOut: false, enoent: false }, 'gh failed (exit 2)'],
    [{ code: 0, stdout: 'not json', stderr: '', timedOut: false, enoent: false }, GH_REASONS.notUnderstood],
  ]
  for (const [result, reason] of cases) {
    const reader = new GithubReader({ mode: 'runner', now, runner: async () => result })
    reader.register(['o/n'])
    await reader.refreshDue()
    const s = reader.state('o/n', false)
    assert.equal(s.status, 'unavailable')
    assert.equal(s.reason, reason)
    assert.ok(!s.reason!.includes('ghp_'))
  }
})

test('github: a cached read is served after a restart without a runner call (note 8)', async () => {
  const read = parseGithub(GRAPHQL).read
  const cachePath = join(fresh('cache'), 'github.json')
  writeFileSync(cachePath, JSON.stringify({ viewer_login: 'mani99brar', repos: { 'o/n': { ...read, read_at: '2026-10-10T23:55:00Z' } } }))
  let calls = 0
  const reader = new GithubReader({ mode: 'runner', now, refreshMinutes: 15, cachePath, runner: async () => { calls += 1; return ghOk() } })
  assert.equal(reader.state('o/n', false).status, 'read', 'a 5-minute-old cache entry is served as read')
  await reader.refreshDue()
  assert.equal(calls, 0, 'a fresh cache entry is not re-read at start')
})

test('githubArgv asks one graphql query with the owner and name', () => {
  const argv = githubArgv('kleros/kleros-v2')
  assert.deepEqual(argv.slice(0, 2), ['api', 'graphql'])
  assert.ok(argv.includes('owner=kleros'))
  assert.ok(argv.includes('name=kleros-v2'))
})

// ---- Step digests (buildDigest unit + the route) -----------------------------------------------

type StubNode = { node_id: string; label: string; kind: string; depends_on: string[] }
type StubSnap = { node_id: string; status: string; attempt: number }
type StubEvent = { node_id: string; status: string; message: string }
function loadedStub(over: {
  nodes?: StubNode[]; snapshot?: StubSnap[]; events?: StubEvent[]; repairs?: { node_id: string }[]
  inputs?: { source_branch: string | null; base_commit: string | null } | null; runId?: string; updated?: string
}): LoadedRun {
  const nodes = over.nodes ?? [
    { node_id: 'launch_server', label: 'Server lane', kind: 'worker', depends_on: [] },
    { node_id: 'integrate', label: 'Integrate', kind: 'integration', depends_on: ['launch_server'] },
  ]
  const snapshot = over.snapshot ?? nodes.map(n => ({ node_id: n.node_id, status: 'pending', attempt: 0 }))
  return {
    detail: {
      summary: { run_id: over.runId ?? 'r-001', updated_at: over.updated ?? '2026-10-11T00:00:00Z' },
      definition: { nodes },
      snapshot: { nodes: snapshot },
    },
    events: over.events ?? [],
    inputs: over.inputs ?? null,
    fixLoop: over.repairs ? { repairs: over.repairs } : null,
  } as unknown as LoadedRun
}

test('buildDigest: steps carry status and attempt, lanes are worker nodes, integrated commit from the integrate message', () => {
  const digest = buildDigest(loadedStub({
    snapshot: [
      { node_id: 'launch_server', status: 'succeeded', attempt: 2 },
      { node_id: 'integrate', status: 'succeeded', attempt: 1 },
    ],
    events: [{ node_id: 'integrate', status: 'succeeded', message: 'Fast-forwarded to 762b8fd1a2b3' }],
    inputs: { source_branch: 'observe/x', base_commit: '5dc3ae2000' },
  }))
  assert.deepEqual(digest.lanes, ['launch_server'])
  assert.equal(digest.steps.find(s => s.node_id === 'launch_server')!.attempt, 2)
  assert.equal(digest.integrated_commit, '762b8fd1a2b3')
  assert.equal(digest.source_branch, 'observe/x')
  assert.equal(digest.base_commit, '5dc3ae2000')
})

test('buildDigest: lanes exclude fix-loop repair nodes while steps include them (note 3)', () => {
  const nodes = [
    { node_id: 'launch_server', label: 'Server lane', kind: 'worker', depends_on: [] },
    { node_id: 'repair-1', label: 'Repair 1', kind: 'worker', depends_on: ['launch_server'] },
  ]
  const digest = buildDigest(loadedStub({ nodes, repairs: [{ node_id: 'repair-1' }] }))
  assert.deepEqual(digest.lanes, ['launch_server'])
  assert.ok(digest.steps.some(s => s.node_id === 'repair-1'), 'the repair node is still a step')
})

// ---- The routes --------------------------------------------------------------------------------

const BASE = 'a'.repeat(40)
const MIN_NODES = [
  { node_id: 'launch_a', label: 'Lane A', kind: 'worker' as const, depends_on: [] as string[] },
  { node_id: 'integrate', label: 'Integrate', kind: 'integration' as const, depends_on: ['launch_a'] },
]
function writeRunDir(runsRoot: string, runId: string, opts: { events?: Record<string, unknown>[]; updated?: string; skipPlan?: boolean; badState?: boolean; planOnly?: boolean; empty?: boolean } = {}): void {
  const dir = join(runsRoot, runId)
  mkdirSync(dir, { recursive: true })
  if (opts.empty) return
  if (opts.planOnly) { writeFileSync(join(dir, 'plan.json'), JSON.stringify({ run_id: runId, base_commit: BASE })); return }
  if (opts.badState) { writeFileSync(join(dir, 'run-state.json'), '{ not valid json'); writeFileSync(join(dir, 'plan.json'), JSON.stringify({ run_id: runId, base_commit: BASE })); return }
  const events = opts.events ?? []
  const state = {
    version: '1.0.0', run_id: runId, base_commit: BASE, created_at: '2026-01-01T00:00:00Z', updated_at: opts.updated ?? '2026-01-01T00:01:00Z',
    definition: { name: 'W', nodes: MIN_NODES }, values: { run_id: runId }, next: [], tasks: [], events, verification_packets: [],
  }
  writeFileSync(join(dir, 'run-state.json'), JSON.stringify(state))
  if (events.length) writeFileSync(join(dir, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n')
  if (!opts.skipPlan) writeFileSync(join(dir, 'plan.json'), JSON.stringify({ run_id: runId, base_commit: BASE }))
}

type LooseProject = {
  project_id: string; name: string; repository: string
  workflows: { workflow_id: string; runs_root: string; definition: { name: string; nodes: typeof MIN_NODES } }[]
}
// `assertProjectsConfig` (in createApp) rebuilds and validates the full definition from this stored shape.
function registry(projects: LooseProject[]): ProjectsConfig {
  return { projects } as unknown as ProjectsConfig
}

test('steps route: runs newest first, skips legacy/just-launched, corrupt runs go to errors, unknown project is 404 NOT_FOUND, POST is 405', async () => {
  const runsRoot = join(fresh('runs'), 'w')
  mkdirSync(runsRoot, { recursive: true })
  writeRunDir(runsRoot, 'run-002', { updated: '2026-01-02T00:01:00Z', events: [{ sequence: 1, time: '2026-01-01T00:00:00Z', node: 'integrate', status: 'succeeded', message: 'Fast-forwarded to 762b8fd1a2b3' }] })
  writeRunDir(runsRoot, 'run-001', { updated: '2026-01-01T00:01:00Z' })
  writeRunDir(runsRoot, 'run-legacy', { planOnly: true })
  writeRunDir(runsRoot, 'run-empty', { empty: true })
  writeRunDir(runsRoot, 'run-bad', { badState: true })

  const config = registry([{ project_id: 'proj', name: 'Proj', repository: fresh('repo'), workflows: [{ workflow_id: 'w', runs_root: runsRoot, definition: { name: 'W', nodes: MIN_NODES } }] }])
  const app = createApp([], { projects: config, dispatch: { gitRunner: runner, now } })
  after(() => app.close())
  await app.ready()

  const res = await app.inject({ method: 'GET', url: '/api/dispatch/projects/proj/steps' })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.contract_version, '1.0.0')
  const wf = body.workflows[0]
  const runIds = wf.runs.map((r: { run_id: string }) => r.run_id)
  assert.deepEqual(runIds, ['run-002', 'run-001'], 'valid runs newest first; legacy and empty skipped')
  assert.equal(wf.errors.length, 1)
  assert.equal(wf.errors[0].run_id, 'run-bad')
  assert.equal(wf.runs[0].integrated_commit, '762b8fd1a2b3')
  assert.deepEqual(wf.runs[0].lanes, ['launch_a'])

  const unknown = await app.inject({ method: 'GET', url: '/api/dispatch/projects/nope/steps' })
  assert.equal(unknown.statusCode, 404)
  assert.equal(unknown.json().error.code, 'NOT_FOUND')

  const post = await app.inject({ method: 'POST', url: '/api/dispatch/projects/proj/steps' })
  assert.equal(post.statusCode, 405)
})

test('steps route: a workflow whose runs cannot be listed sets error without failing the response', async () => {
  const config = registry([{ project_id: 'proj', name: 'Proj', repository: fresh('repo'), workflows: [{ workflow_id: 'w', runs_root: join(ROOT, 'no-such-runs-root'), definition: { name: 'W', nodes: MIN_NODES } }] }])
  const app = createApp([], { projects: config, dispatch: { gitRunner: runner, now } })
  after(() => app.close())
  await app.ready()
  const res = await app.inject({ method: 'GET', url: '/api/dispatch/projects/proj/steps' })
  assert.equal(res.statusCode, 200)
  assert.ok(res.json().workflows[0].error, 'the workflow error is set')
})

test('overview route: clone_primary is the first project sharing the clone, a non-GitHub remote is not_github, a missing repo is unavailable with git-not-read github, and GitHub read fields come from the fixture', async () => {
  const { clone } = originAndClone()
  const wt = join(ROOT, `wt-overview-${seq++}`)
  git(clone, 'worktree', 'add', '--detach', wt)

  const ghRepo = fresh('gh-overview')
  git(ghRepo, 'init', '-b', 'main', '.')
  commit(ghRepo, 'c')
  git(ghRepo, 'remote', 'add', 'origin', 'https://github.com/kleros/kleros-v2.git')

  const read = parseGithub(GRAPHQL).read
  const github = new GithubReader({ mode: 'fixture', now, fixture: { viewer_login: 'mani99brar', repos: { 'kleros/kleros-v2': { ...read, read_at: '2026-10-11T00:00:00Z' } } } })

  const config = registry([
    { project_id: 'clone', name: 'Clone', repository: clone, workflows: [] },
    { project_id: 'worktree', name: 'Worktree', repository: wt, workflows: [] },
    { project_id: 'ghproj', name: 'GH', repository: ghRepo, workflows: [] },
    { project_id: 'missing', name: 'Missing', repository: join(ROOT, 'missing-repo'), workflows: [] },
  ])
  const app = createApp([], { projects: config, dispatch: { gitRunner: runner, now, github } })
  after(() => app.close())
  await app.ready()

  const body = (await app.inject({ method: 'GET', url: '/api/dispatch/projects' })).json()
  assert.equal(body.viewer_login, 'mani99brar')
  const byId = Object.fromEntries((body.projects as { project_id: string }[]).map(p => [p.project_id, p])) as Record<string, { project_id: string; git: Record<string, unknown>; github: Record<string, unknown> }>
  assert.equal(byId.clone.git.clone_primary, 'clone')
  assert.equal(byId.worktree.git.clone_primary, 'clone', 'the worktree shares the first project of its clone')
  assert.equal(byId.clone.git.clone_id, byId.worktree.git.clone_id)
  assert.equal(byId.ghproj.github.status, 'read')
  assert.equal(byId.ghproj.github.open_prs, 2)
  assert.equal(byId.clone.github.status, 'not_github')
  assert.equal(byId.missing.git.status, 'unavailable')
  assert.equal(byId.missing.github.status, 'unavailable')
  assert.equal(byId.missing.github.reason, GH_REASONS.gitNotRead)
})

test('overview route: a project with a bad git sha is unavailable "git failed" and leaves other projects intact (note 6, [L2])', async () => {
  const good = fresh('good-git')
  git(good, 'init', '-b', 'main', '.')
  commit(good, 'c')
  const bad = fresh('bad-git')
  git(bad, 'init', '-b', 'main', '.')
  commit(bad, 'c')
  // A runner that corrupts the bad repo's HEAD sha so the Sha pattern fails only for that project.
  const corrupting = async (repo: string, args: readonly string[]): Promise<GitResultLike> => {
    const result = await runner(repo, args)
    if (repo === bad && args[0] === 'rev-parse' && args.includes('HEAD')) return { ...result, stdout: 'nothex\n' }
    return result
  }
  const config = registry([
    { project_id: 'good', name: 'Good', repository: good, workflows: [] },
    { project_id: 'bad', name: 'Bad', repository: bad, workflows: [] },
  ])
  const app = createApp([], { projects: config, dispatch: { gitRunner: corrupting, now } })
  after(() => app.close())
  await app.ready()
  const body = (await app.inject({ method: 'GET', url: '/api/dispatch/projects' })).json()
  const byId = Object.fromEntries((body.projects as { project_id: string; git: { status: string; reason: string | null } }[]).map(p => [p.project_id, p]))
  assert.equal(byId.bad.git.status, 'unavailable')
  assert.equal(byId.bad.git.reason, 'git failed')
  assert.equal(byId.good.git.status, 'read', 'the other project is unaffected')
})

test('discoverGithubRepos lists the GitHub repositories of the registry', async () => {
  const ghRepo = fresh('discover')
  git(ghRepo, 'init', '-b', 'main', '.')
  commit(ghRepo, 'c')
  git(ghRepo, 'remote', 'add', 'origin', 'git@github.com:kleros/vea.git')
  const plain = fresh('plain-discover')
  git(plain, 'init', '-b', 'main', '.')
  const keys = await discoverGithubRepos([{ repository: ghRepo }, { repository: plain }], runner)
  assert.deepEqual(keys, ['kleros/vea'])
})
