import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, mock, test } from 'node:test'
import { createApp, type ProjectsConfig } from './app.ts'
import { buildDispatch, projectSpend } from './dispatch.ts'
import { GitReader, discoverGithubRepos, parseGithubRemote, readGitState, realGitRunner, type ExecFileLike, type GitInput, type GitRunner } from './dispatchGit.ts'
import { GH_REASONS, GITHUB_QUERY, GithubReader, githubArgv, githubReaderOptions, parseGithub, realGhRunner, type GhResult } from './dispatchGithub.ts'
import { buildDigest } from './dispatchSteps.ts'
import { readRunBranch, readRunRepo } from './runGithub.ts'
import { ProjectApiError, RunStore, type LoadedRun } from './projects.ts'
import { githubStateSchema, homeRunsSchema, registryRunsSchema, type RegistryRuns } from '../contracts/projects/dispatch.ts'
import { readsNextPage } from '../src/projects/lists.ts'

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
          number: 42, title: 'Human PR', url: 'u', state: 'OPEN', isDraft: true,
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
        { number: 101, title: 'Issue', url: 'u', author: null, labels: { nodes: [{ name: 'triage' }, { name: 'bug' }] }, assignees: { nodes: [{ login: 'mani99brar' }] }, createdAt: '2026-10-08T09:00:00Z', updatedAt: '2026-10-10T12:00:00Z' },
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
// A recorded definition node: the kind is the `contracts/projects/v1.ts` enum, so a test can record a kind that
// differs from the registry's (S8) and the `tsc -b` build still type-checks (design-challenge note 2).
type DefNodeKind = 'prepare' | 'worker' | 'verification' | 'review' | 'integration'
type DefNode = { node_id: string; label: string; kind: DefNodeKind; depends_on: string[] }
const MIN_NODES: readonly DefNode[] = [
  { node_id: 'launch_a', label: 'Lane A', kind: 'worker', depends_on: [] },
  { node_id: 'integrate', label: 'Integrate', kind: 'integration', depends_on: ['launch_a'] },
]
function writeRunDir(runsRoot: string, runId: string, opts: { events?: Record<string, unknown>[]; updated?: string; skipPlan?: boolean; badState?: boolean; planOnly?: boolean; empty?: boolean; nodes?: readonly DefNode[] } = {}): void {
  const dir = join(runsRoot, runId)
  mkdirSync(dir, { recursive: true })
  if (opts.empty) return
  if (opts.planOnly) { writeFileSync(join(dir, 'plan.json'), JSON.stringify({ run_id: runId, base_commit: BASE })); return }
  if (opts.badState) { writeFileSync(join(dir, 'run-state.json'), '{ not valid json'); writeFileSync(join(dir, 'plan.json'), JSON.stringify({ run_id: runId, base_commit: BASE })); return }
  const events = opts.events ?? []
  const state = {
    version: '1.0.0', run_id: runId, base_commit: BASE, created_at: '2026-01-01T00:00:00Z', updated_at: opts.updated ?? '2026-01-01T00:01:00Z',
    definition: { name: 'W', nodes: opts.nodes ?? MIN_NODES }, values: { run_id: runId }, next: [], tasks: [], events, verification_packets: [],
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

// ---- Run 002 review fixes (S1 to S5) -----------------------------------------------------------

test('S1: landings on a local-only repository report true/false on local main with on_origin null', async () => {
  // A repository with refs/heads/main and no origin ref: the local default is known, so on_default is true/false.
  const repo = fresh('local-only')
  git(repo, 'init', '-b', 'main', '.')
  commit(repo, 'c1')
  const landed = git(repo, 'rev-parse', 'HEAD').trim()
  commit(repo, 'c2')
  // A commit that exists in the repository but is not an ancestor of main (a side branch): merge-base exits 1 → false.
  git(repo, 'checkout', '-b', 'side')
  commit(repo, 'c3-side')
  const notLanded = git(repo, 'rev-parse', 'HEAD').trim()
  git(repo, 'checkout', 'main')
  const { state } = await stateOf(repo, {
    landings: [
      { workflow_id: 'w', run_id: 'r-landed', sha: landed },
      { workflow_id: 'w', run_id: 'r-not', sha: notLanded },
    ],
  })
  assert.equal(state.default_branch, 'main')
  assert.equal(state.origin, null, 'no origin ref')
  const byRun = Object.fromEntries(state.landings.map(l => [l.run_id, l]))
  assert.deepEqual([byRun['r-landed'].on_default, byRun['r-landed'].on_origin], [true, null], 'an integrated sha on local main is true, origin unknown')
  assert.deepEqual([byRun['r-not'].on_default, byRun['r-not'].on_origin], [false, null], 'a sha not on main is false, not null')
})

test('S2: a failing read is retried once per refresh window, not once per tick', async () => {
  let t = CLOCK
  let calls = 0
  const reader = new GithubReader({
    mode: 'runner', now: () => t, refreshMinutes: 15,
    runner: async () => { calls += 1; return { code: 1, stdout: '', stderr: 'boom', timedOut: false, enoent: false } },
  })
  reader.register(['o/n'])
  // Fifteen one-minute ticks inside a single 15-minute window: the failing read happens once, not every minute.
  for (let i = 0; i < 15; i += 1) { await reader.cycle(); t += 60_000 }
  assert.equal(calls, 1, 'one failing read per refresh window')
  // Crossing the window, the repository is attempted again.
  t += 60_000
  await reader.cycle()
  assert.equal(calls, 2)
  assert.equal(reader.state('o/n', false).status, 'unavailable')
})

test('S3: the tick discovers the current registry; a repository missing from a discovery keeps its cached data but is not read', async () => {
  // The discovery is wired by buildDispatch (store.sync() then discoverGithubRepos), driven through cycle() with no
  // app.inject: a registry file the reloader re-reads, and real repositories whose GitHub origins are parsed by git.
  // This fails if buildDispatch stops awaiting store.sync() (the file rewrite never reaches discovery) or discovers
  // only the start-up registry (o/b is never read), not merely if an injected key array changes.
  function ghRepo(name: string): string {
    const repo = fresh(`s3-${name}`)
    git(repo, 'init', '-b', 'main', '.')
    commit(repo, 'c')
    git(repo, 'remote', 'add', 'origin', `https://github.com/o/${name}.git`)
    return repo
  }
  const repoA = ghRepo('a')
  const repoB = ghRepo('b')
  const registryFile = join(fresh('s3-registry'), 'projects.json')
  const write = (repos: string[]) => writeFileSync(registryFile, JSON.stringify({ projects: repos.map((r, i) => ({ project_id: `p${i}`, name: `P${i}`, repository: r, workflows: [] })) }))
  write([repoA])
  const refresh = async (): Promise<ProjectsConfig> => JSON.parse(readFileSync(registryFile, 'utf8')) as ProjectsConfig
  const store = new RunStore(registry([]), { refresh })

  let t = CLOCK
  const reads: string[] = []
  const github = new GithubReader({
    mode: 'runner', now: () => t, refreshMinutes: 15,
    runner: async argv => { reads.push(argv.find(a => a.startsWith('name='))!); return ghOk() },
  })
  const deps = buildDispatch(store, { gitRunner: runner, now: () => t, github })
  await deps.github.cycle()
  assert.deepEqual(reads, ['name=a'], 'the start cycle reads the repository discovered from the registry file')

  // A repository added to the registry file at runtime is read by the next tick, with no request.
  write([repoA, repoB])
  t += 16 * 60_000
  reads.length = 0
  await deps.github.cycle()
  assert.ok(reads.includes('name=b'), 'a repository newly in the registry file is read by the tick')
  assert.equal(deps.github.state('o/b', false).status, 'read')
  // A repository dropped from the registry file is not read again, but its cached data is kept.
  write([repoA])
  t += 16 * 60_000
  reads.length = 0
  await deps.github.cycle()
  assert.ok(!reads.includes('name=b'), 'a repository missing from the discovery is not read')
  assert.ok(reads.includes('name=a'))
  assert.equal(deps.github.state('o/b', false).status, 'read', 'its last read still answers read ([P12])')
})

test('S9: an unreadable run is cached by fingerprint and warn-logged once across warm and two overview requests', async t => {
  const runsRoot = join(fresh('runs-s4'), 'w')
  mkdirSync(runsRoot, { recursive: true })
  writeRunDir(runsRoot, 'corrupt-001', {})
  const config = registry([{ project_id: 'proj', name: 'Proj', repository: fresh('repo-s4'), workflows: [{ workflow_id: 'w', runs_root: runsRoot, definition: { name: 'W', nodes: MIN_NODES } }] }])
  let loads = 0
  t.mock.method(RunStore.prototype, 'loadRun', async () => { loads += 1; throw new ProjectApiError(500, 'RUN_STORAGE_INVALID', 'corrupt run') })
  const app = createApp([], { projects: config, dispatch: { gitRunner: runner, now } })
  after(() => app.close())
  // The corrupt run is first loaded when digests are warmed at onReady, and buildDispatch passes app.log.warn as the
  // digest warner (server/app.ts), so the warning fires during app.ready(). Mock warn before ready and count only the
  // 'Run digest could not be read' message, so an unrelated boot warning does not inflate the count (design note 6).
  let warnCount = 0
  t.mock.method(app.log, 'warn', (_details: unknown, message?: string) => { if (message === 'Run digest could not be read') warnCount += 1 })
  await app.ready()
  const first = await app.inject({ method: 'GET', url: '/api/dispatch/projects' })
  const second = await app.inject({ method: 'GET', url: '/api/dispatch/projects' })
  assert.equal(first.statusCode, 200)
  assert.equal(second.statusCode, 200)
  assert.equal(loads, 1, 'the corrupt run is loaded once, then served from the fingerprint cache')
  assert.equal(warnCount, 1, 'the unreadable run is warn-logged once per fingerprint, not on every request')
  // It still surfaces as an error on the steps route, from the cache.
  const steps = await app.inject({ method: 'GET', url: '/api/dispatch/projects/proj/steps' })
  assert.equal(steps.json().workflows[0].errors[0].run_id, 'corrupt-001')
  assert.equal(loads, 1)
  assert.equal(warnCount, 1)
})

test('S9: every git argv the reader issues is read-only (an allowlist of exact shapes, abbreviations rejected)', async () => {
  const { clone, seed, origin } = originAndClone()
  commit(clone, 'Workflow run-ro: ahead')
  const landed = git(clone, 'rev-parse', 'HEAD').trim()
  const seen: string[][] = []
  const recording: GitRunner = async (repo, args) => { seen.push([...args]); return runner(repo, args) }
  await readGitState(
    { project_id: 'p', repository: clone, run_ids: new Set(['run-ro']), landings: [{ workflow_id: 'w', run_id: 'run-ro', sha: landed }, { workflow_id: 'w', run_id: 'gone', sha: 'deadbeef' }] },
    '/home/tester', recording, now,
  )
  assert.ok(seen.length > 0)
  for (const args of seen) assert.ok(isReadOnlyGit(args), `writing argv reached git: ${args.join(' ')}`)
  // The allowlist rejects a write: `remote set-url` (what a regression would introduce) is not allowed.
  assert.equal(isReadOnlyGit(['remote', 'set-url', 'origin', 'x']), false)
  assert.equal(isReadOnlyGit(['symbolic-ref', 'HEAD', 'refs/heads/main']), false, 'a two-arg symbolic-ref writes')
  assert.equal(isReadOnlyGit(['reflog', 'expire', '--all']), false)
  // A writing option is rejected even when the positionals look like a read: `symbolic-ref --delete` deletes the ref,
  // and `log --output=<file>` writes to disk. The allowlist must not pass either (lane-review-1).
  assert.equal(isReadOnlyGit(['symbolic-ref', '--delete', 'HEAD']), false, 'symbolic-ref --delete writes')
  assert.equal(isReadOnlyGit(['symbolic-ref', '-d', 'refs/remotes/origin/HEAD']), false, 'symbolic-ref -d writes')
  assert.equal(isReadOnlyGit(['log', '--output=/tmp/x', 'HEAD']), false, 'log --output writes a file')
  assert.equal(isReadOnlyGit(['rev-list', '--output=/tmp/x', 'HEAD']), false, 'rev-list --output writes a file')
  // Git accepts unambiguous abbreviations, so a writing option's prefix must be rejected too, not only its exact name
  // (S9, run-002 review P2 / lane-review-1): `--dele` abbreviates `--delete` and `--outp=` abbreviates `--output`.
  assert.equal(isReadOnlyGit(['symbolic-ref', '--dele', 'HEAD']), false, 'symbolic-ref --dele abbreviates --delete')
  assert.equal(isReadOnlyGit(['log', '--outp=/x', 'HEAD']), false, 'log --outp= abbreviates --output')
  void seed; void origin
})

/**
 * The exact read-only git shapes the reader uses (design-challenge note 6); anything else is a write and fails the
 * proof. A writing option (`--output`, `--delete`, `--force`, …, or their short forms) is rejected whatever the verb,
 * so a read-looking verb cannot smuggle a write to disk or a ref mutation (lane-review-1). Git's parse-options accepts
 * any unambiguous prefix, so a long option is writing when its name is a prefix of a writing option (`--dele` of
 * `--delete`, `--outp` of `--output`), not only the exact name (S9).
 */
const WRITING_OPTIONS = ['output', 'delete', 'force', 'write', 'update', 'set', 'edit', 'expire', 'prune', 'unset', 'add', 'rename', 'remove', 'move']
function isReadOnlyGit(args: readonly string[]): boolean {
  const verb = args[0]
  const rest = args.slice(1)
  const options = rest.filter(a => a.startsWith('-'))
  const positionals = rest.filter(a => !a.startsWith('-'))
  const writingOption = (opt: string): boolean => {
    if (['-d', '-o', '-f', '-w'].includes(opt)) return true
    const long = /^--([^=]+)(?:=|$)/.exec(opt)
    return long !== null && WRITING_OPTIONS.some(name => name.startsWith(long[1]))
  }
  if (options.some(writingOption)) return false
  switch (verb) {
    case 'rev-parse':
    case 'rev-list':
    case 'log':
      return true
    case 'symbolic-ref':
      return positionals.length <= 1 // reading one ref; a write passes a name and a value (or --delete, rejected above)
    case 'reflog':
      return rest[0] === 'show'
    case 'merge-base':
      return rest.includes('--is-ancestor')
    case 'remote':
      return rest[0] === 'get-url'
    case 'config':
      return rest.length === 2 && rest[0] === '--get' && positionals.length === 1 // reading one key; a write passes a value
    default:
      return false
  }
}

test('run-teams: every git argv the run branch reader issues is read-only (the same allowlist), refs fully qualified', async () => {
  const { clone, origin } = originAndClone()
  git(clone, 'checkout', '-b', 'feature/w/run-001')
  const integrated = (commit(clone, 'run change'), git(clone, 'rev-parse', 'HEAD').trim())
  git(clone, 'push', 'origin', 'feature/w/run-001')
  commit(clone, 'unpushed')
  git(clone, 'remote', 'set-url', 'origin', 'https://github.com/acme/widgets.git')
  const seen: string[][] = []
  const recording: GitRunner = async (repo, args) => { seen.push([...args]); return runner(repo, args) }
  const facts = await readRunBranch(recording, clone, 'feature/w/run-001', 'main', integrated)
  assert.equal((await readRunRepo(recording, clone)).ownerName, 'acme/widgets')
  assert.equal(facts.push_state, 'local_ahead')
  // Every verb/option shape the run reader uses: rev-parse --verify --quiet <ref>^{commit}, rev-list --left-right --count
  // <sha>...<sha>, rev-list --count <sha> --not <shas>, log --format -n <sha> --not <shas>, merge-base --is-ancestor,
  // symbolic-ref --quiet --short, rev-parse --path-format=absolute --git-common-dir, config --get remote.origin.url and
  // remote get-url [--push] --all origin.
  const verbs = new Set(seen.map(args => args[0]))
  assert.deepEqual([...verbs].sort(), ['config', 'log', 'merge-base', 'remote', 'rev-list', 'rev-parse', 'symbolic-ref'])
  assert.equal(isReadOnlyGit(['config', 'remote.origin.url', 'https://x']), false, 'config with a value writes')
  for (const args of seen) assert.ok(isReadOnlyGit(args), `writing argv reached git: ${args.join(' ')}`)
  for (const args of seen) {
    for (const arg of args.slice(1)) if (arg.includes('run-001')) assert.match(arg, /^refs\/(heads|remotes\/origin)\/feature\/w\/run-001(\^\{commit\})?(\.\.\.refs\/remotes\/origin\/(main|feature\/w\/run-001))?$/)
  }
  assert.ok(seen.some(args => args[0] === 'log' && args.includes('--not')))
  assert.equal(isReadOnlyGit(['rev-list', '--count', 'refs/heads/x', '--not', 'refs/remotes/origin/x']), true)
  void origin
})

test('S7: realGitRunner and realGhRunner spawn execFile the way production does — default timeouts 5000/20000, no shell, the env', async () => {
  type Call = { file: string; args: readonly string[]; options: { timeout: number; env?: NodeJS.ProcessEnv; shell?: boolean } }
  const gitCalls: Call[] = []
  const fakeGit: ExecFileLike = (file, args, options, cb) => { gitCalls.push({ file, args, options }); cb(null, '', ''); return undefined }
  // Production calls realGitRunner() with no timeout (server/index.ts, server/dispatch.ts), so the test must too: the
  // 5000 ms it asserts is the default, and changing or removing that default now fails the test ([P37], S7 lane-review P1).
  await realGitRunner(undefined, fakeGit)('/some/repo', ['rev-parse', 'HEAD'])
  const g = gitCalls[0]
  assert.equal(g.file, 'git')
  assert.ok(Array.isArray(g.args))
  assert.deepEqual(g.args.slice(0, 3), ['--no-optional-locks', '-C', '/some/repo'])
  assert.equal(g.options.shell, undefined, 'never a shell')
  assert.equal(g.options.timeout, 5000, 'the production default git timeout is 5 s')
  assert.equal(g.options.env!.GIT_TERMINAL_PROMPT, '0')
  assert.equal(g.options.env!.GIT_NO_LAZY_FETCH, '1')
  assert.equal(g.options.env!.GIT_OPTIONAL_LOCKS, '0')
  assert.ok('HOME' in g.options.env!, 'HOME is passed through')
  assert.ok('PATH' in g.options.env!, 'PATH is passed through')

  const prevToken = process.env.GH_TOKEN
  process.env.GH_TOKEN = 'ghp_fromProcessEnv'
  try {
    const ghCalls: Call[] = []
    const fakeGh: ExecFileLike = (file, args, options, cb) => { ghCalls.push({ file, args, options }); cb(null, '{}', ''); return undefined }
    // Production calls realGhRunner(env.MD_MANAGER_GH || 'gh') with no timeout (server/dispatchGithub.ts), relying on
    // the 20_000 ms default; the test calls it the same way and asserts 20000, so changing that default fails here.
    await realGhRunner('gh', undefined, fakeGh)(['api', 'graphql'])
    const h = ghCalls[0]
    assert.equal(h.file, 'gh')
    assert.ok(Array.isArray(h.args))
    assert.deepEqual(h.args, ['api', 'graphql'])
    assert.equal(h.options.shell, undefined, 'never a shell')
    assert.equal(h.options.timeout, 20_000, 'the production default gh timeout is 20 s')
    assert.equal(h.options.env!.GH_TOKEN, 'ghp_fromProcessEnv', 'gh keeps its credentials from process.env')
    assert.ok('HOME' in h.options.env!, 'HOME reaches gh')
    assert.ok('PATH' in h.options.env!, 'PATH reaches gh')
  } finally {
    if (prevToken === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = prevToken
  }
})

test('S5: both routes answer GET and HEAD; every other method is 405 with an Allow header', async () => {
  const repo = fresh('methods')
  git(repo, 'init', '-b', 'main', '.')
  commit(repo, 'c')
  const runsRoot = join(fresh('m-runs'), 'w')
  mkdirSync(runsRoot, { recursive: true })
  writeRunDir(runsRoot, 'run-001', {})
  const config = registry([{ project_id: 'proj', name: 'Proj', repository: repo, workflows: [{ workflow_id: 'w', runs_root: runsRoot, definition: { name: 'W', nodes: MIN_NODES } }] }])
  const app = createApp([], { projects: config, dispatch: { gitRunner: runner, now } })
  after(() => app.close())
  await app.ready()
  for (const url of ['/api/dispatch/projects', '/api/dispatch/projects/proj/steps']) {
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 200, `GET ${url}`)
    assert.equal((await app.inject({ method: 'HEAD', url })).statusCode, 200, `HEAD ${url}`)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const) {
      const res = await app.inject({ method, url })
      assert.equal(res.statusCode, 405, `${method} ${url}`)
      assert.equal(res.headers.allow, 'GET, HEAD', `Allow on ${method} ${url}`)
    }
  }
})

/** Every file (not directory) under `root`, recursively, as absolute paths, sorted. */
function listFilesRecursive(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name)
        if (entry.isDirectory()) walk(p)
        else out.push(p)
      }
    } catch { /* an unreadable directory contributes no files */ }
  }
  walk(root)
  return out.sort()
}

test('S9: runner mode writes only the GitHub cache file — nothing else under HOME or the working directory', async () => {
  // Build the reader the way index.ts does — from githubReaderOptions with an isolated HOME and an explicit cache path
  // under it — but inject the runner so no real `gh` is spawned (design-challenge note 4, [L12]). Set process.env.HOME
  // to the temporary HOME (os.homedir() reads it on POSIX) and chdir into a fresh working directory for this test only,
  // restoring both after, since the worktree is shared with parallel test processes. Then every file under HOME and the
  // working directory, recursively before and after, must differ only by the cache file.
  const tmpHome = fresh('home')
  const workdir = fresh('workdir')
  const cachePath = join(tmpHome, 'c', 'github.json')
  const options = { ...githubReaderOptions({ HOME: tmpHome, MD_MANAGER_GITHUB_CACHE: cachePath } as NodeJS.ProcessEnv, now), runner: async () => ghOk() }
  assert.equal(options.mode, 'runner')
  const reader = new GithubReader(options)
  reader.register(['o/n'])
  const prevHome = process.env.HOME
  const prevCwd = process.cwd()
  process.env.HOME = tmpHome
  process.chdir(workdir)
  try {
    const before = [...listFilesRecursive(tmpHome), ...listFilesRecursive(workdir)]
    await reader.refreshDue()
    const after = [...listFilesRecursive(tmpHome), ...listFilesRecursive(workdir)]
    const added = after.filter(p => !before.includes(p))
    assert.deepEqual(added, [cachePath], 'the only new file anywhere under HOME or the working directory is the cache file')
  } finally {
    process.chdir(prevCwd)
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
  }
  assert.equal(reader.state('o/n', false).status, 'read')
})

test('S5: updated_at is the remote-tracking reflog entry time, not FETCH_HEAD', async () => {
  const { origin, clone, seed } = originAndClone()
  commit(seed, 'c2')
  git(seed, 'push', 'origin', 'main')
  // Fetch at a precise, past committer time so the origin/main reflog entry is clearly not the real wall clock (FETCH_HEAD's mtime).
  execFileSync('git', ['fetch', 'origin'], { cwd: clone, env: { ...GIT_ENV, GIT_COMMITTER_DATE: '2026-05-05T08:00:00+00:00' } })
  const reflog = git(clone, 'reflog', 'show', '-1', '--date=iso-strict', '--format=%gd', 'refs/remotes/origin/main').trim()
  const at = /@\{(.+)\}/.exec(reflog)
  const expected = new Date(Date.parse(at![1])).toISOString()
  const first = (await stateOf(clone)).state
  assert.equal(first.origin!.updated_at, expected, 'updated_at equals the origin/main reflog entry time')
  assert.ok(expected.startsWith('2026-05-05'), 'the reflog time is the set fetch time, not now (a FETCH_HEAD mtime would be the test run time)')
  // A later fetch of an empty second remote rewrites FETCH_HEAD but not origin/main's reflog.
  const other = fresh('other-reflog')
  git(other, 'init', '--bare', '--initial-branch=main', '.')
  git(clone, 'remote', 'add', 'other', other)
  execFileSync('git', ['fetch', 'other'], { cwd: clone, env: { ...GIT_ENV, GIT_COMMITTER_DATE: '2026-09-09T09:00:00+00:00' } })
  const second = (await stateOf(clone)).state
  assert.equal(second.origin!.updated_at, expected, 'a fetch of a second remote does not change origin/main')
  void origin
})

test('S5: origin/HEAD naming dev outranks a local main', async () => {
  const { origin, clone, seed } = originAndClone()
  git(seed, 'branch', 'dev')
  git(seed, 'push', 'origin', 'dev')
  git(clone, 'fetch', 'origin')
  // The clone has a local main; origin/HEAD is pointed at dev.
  git(clone, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/dev')
  const { state } = await stateOf(clone)
  assert.equal(state.default_branch, 'dev', 'origin/HEAD outranks the local main')
  void origin
})

test('S9: landings are null (never false) with a missing origin ref and with no local default branch', async () => {
  // A clone without a local default branch, asked about a commit it DOES have (a real object, not a made-up sha):
  // on_default must be null because the branch is missing, not because the object is. A merge-base against a missing
  // object would also be non-zero, so a real sha proves the null comes from the absent branch ([L11], S9).
  const { clone } = originAndClone()
  git(clone, 'checkout', '--detach', 'HEAD')
  const existing = git(clone, 'rev-parse', 'HEAD').trim()
  git(clone, 'branch', '-D', 'main')
  const noLocal = await stateOf(clone, { landings: [{ workflow_id: 'w', run_id: 'r', sha: existing }] })
  assert.equal(noLocal.state.origin!.compare, 'no_local_branch', 'the local default branch is gone')
  assert.equal(noLocal.state.landings[0].on_default, null, 'no local default branch is null, not false, even for an object the clone has')

  // A local-only repository: origin is unknown (null), never false, for any sha.
  const repo = fresh('solo-land')
  git(repo, 'init', '-b', 'main', '.')
  commit(repo, 'c')
  const sha = git(repo, 'rev-parse', 'HEAD').trim()
  const solo = await stateOf(repo, { landings: [{ workflow_id: 'w', run_id: 'r', sha }] })
  assert.equal(solo.state.landings[0].on_origin, null, 'a missing origin ref is null, not false')
  assert.equal(solo.state.landings[0].on_default, true)
})

test('S9: the GraphQL query orders PRs and issues, and state() maps every Appendix A field (draft and labels by value) and parses with the contract', async () => {
  assert.match(GITHUB_QUERY, /pullRequests\(first: 20, orderBy: \{field: UPDATED_AT, direction: DESC\}\)/)
  assert.match(GITHUB_QUERY, /issues\(first: 20, states: OPEN, orderBy: \{field: CREATED_AT, direction: DESC\}\)/)
  const reader = new GithubReader({ mode: 'runner', now, runner: async () => ghOk() })
  reader.register(['o/n'])
  await reader.refreshDue()
  const s = reader.state('o/n', false)
  githubStateSchema.parse(s) // the full read parses with the contract schema
  assert.equal(s.pushed_at, '2026-10-10T21:15:00.000Z')
  assert.equal(s.head!.sha, '6ac7f5c1d2e3')
  assert.equal(s.head!.committed_at, '2026-10-10T21:14:00.000Z')
  assert.ok(s.read_at)
  const pr = s.prs[0]
  assert.equal(pr.title, 'Human PR')
  assert.equal(pr.url, 'u')
  assert.equal(pr.state, 'OPEN')
  assert.equal(pr.draft, true, 'a draft PR maps draft:true (guards the isDraft mapping)')
  assert.equal(s.prs[1].draft, false, 'a non-draft PR maps draft:false')
  assert.equal(pr.head_ref, 'f')
  assert.equal(pr.base_ref, 'main')
  assert.equal(pr.updated_at, '2026-10-11T02:00:00.000Z')
  assert.equal(pr.merged_at, null)
  assert.equal(pr.review_decision, 'REVIEW_REQUIRED')
  assert.deepEqual(pr.labels, ['feature'])
  assert.equal(s.prs[1].merged_at, '2026-10-09T10:05:00.000Z')
  const issue = s.issues[0]
  assert.deepEqual(issue.labels, ['triage', 'bug'], 'issue labels map by value, in order (guards the issue-label mapping)')
  assert.deepEqual(issue.assignees, ['mani99brar'])
  assert.equal(issue.created_at, '2026-10-08T09:00:00.000Z')
  assert.equal(issue.updated_at, '2026-10-10T12:00:00.000Z')
})

test('S5: a route request never triggers a gh read, even when a repository is due ([P18])', async () => {
  const ghRepo = fresh('p18')
  git(ghRepo, 'init', '-b', 'main', '.')
  commit(ghRepo, 'c')
  git(ghRepo, 'remote', 'add', 'origin', 'https://github.com/kleros/kleros-v2.git')
  let calls = 0
  let ghT = CLOCK
  // The reader has its own mutable clock so the repository can be made *due* after the start read; the app's git clock
  // stays fixed. No pre-read here: createApp's onReady fires github.start() unawaited (server/app.ts:124,
  // server/dispatchGithub.ts start()), whose start cycle discovers this repo from the registry and reads it once
  // (design-challenge note 1). A request must never trigger a read, even once the repository is due.
  const github = new GithubReader({ mode: 'runner', now: () => ghT, refreshMinutes: 15, runner: async () => { calls += 1; return ghOk() } })
  const config = registry([{ project_id: 'ghproj', name: 'GH', repository: ghRepo, workflows: [] }])
  const app = createApp([], { projects: config, dispatch: { gitRunner: runner, now, github } })
  after(() => app.close())
  await app.ready()
  // Poll until the unawaited start cycle has performed its first read (bounded, ~2 s so a never-discovered key cannot
  // hang the suite), then give the cycle one more setImmediate to settle before the clock moves, so the clock advance
  // does not race the in-flight start-cycle discovery ([L15], design-challenge note 1).
  const deadline = Date.now() + 2000
  while (calls < 1 && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1, 'the start cycle performed the first read')
  await new Promise(resolve => setImmediate(resolve))
  // Move the clock past the refresh window so the repository is now due; a request still must not read it.
  ghT += 16 * 60_000
  const before = calls
  await app.inject({ method: 'GET', url: '/api/dispatch/projects' })
  await app.inject({ method: 'GET', url: '/api/dispatch/projects' })
  assert.equal(calls, before, 'a request never triggers or waits for a gh read')
})

test('S5: githubReaderOptions honours MD_MANAGER_GITHUB=off and reads a fixture file', () => {
  assert.equal(githubReaderOptions({ MD_MANAGER_GITHUB: 'off' } as NodeJS.ProcessEnv, now).mode, 'off')
  const read = parseGithub(GRAPHQL).read
  const file = join(fresh('fixture-file'), 'fx.json')
  writeFileSync(file, JSON.stringify({ viewer_login: 'mani99brar', repos: { 'o/n': { ...read, read_at: '2026-10-11T00:00:00Z' } } }))
  const options = githubReaderOptions({ MD_MANAGER_GITHUB_FIXTURE: file } as NodeJS.ProcessEnv, now)
  assert.equal(options.mode, 'fixture')
  const reader = new GithubReader(options)
  assert.equal(reader.state('o/n', false).status, 'read')
  assert.equal(reader.viewerLogin, 'mani99brar')
})

test('S5: the steps route returns the newest 50 runs, newest first', async () => {
  const runsRoot = join(fresh('runs-50'), 'w')
  mkdirSync(runsRoot, { recursive: true })
  // 55 runs with strictly increasing updated_at (run-054 newest, run-000 oldest), written oldest-first so a reader
  // that truncates directory enumeration before sorting, or keeps the oldest 50, selects the wrong set and fails.
  for (let i = 0; i < 55; i += 1) {
    const n = String(i).padStart(3, '0')
    writeRunDir(runsRoot, `run-${n}`, { updated: `2026-02-01T00:${n.slice(-2)}:00Z` })
  }
  const config = registry([{ project_id: 'proj', name: 'Proj', repository: fresh('repo-50'), workflows: [{ workflow_id: 'w', runs_root: runsRoot, definition: { name: 'W', nodes: MIN_NODES } }] }])
  const app = createApp([], { projects: config, dispatch: { gitRunner: runner, now } })
  after(() => app.close())
  await app.ready()
  const body = (await app.inject({ method: 'GET', url: '/api/dispatch/projects/proj/steps' })).json()
  const runIds = body.workflows[0].runs.map((r: { run_id: string }) => r.run_id)
  // Exactly the newest 50, newest first: run-054 down to run-005; the five oldest (run-004 … run-000) are dropped.
  const expected = Array.from({ length: 50 }, (_, k) => `run-${String(54 - k).padStart(3, '0')}`)
  assert.deepEqual(runIds, expected, 'the newest 50 runs, newest first')
})

test('S8: a run carries the label and kind of its own recorded definition, not the registry\'s ([P22], [L2])', async () => {
  // launch_a's recorded kind is 'review' (a valid v1.ts kind, [L12]), differing from the registry's 'worker' for the
  // same node id. So an implementation that takes the label from the run but the kind from the registry's MIN_NODES
  // would still read step.kind 'worker' and fail this test, which is what [P37] requires.
  const recorded: readonly DefNode[] = [
    { node_id: 'launch_a', label: 'Recorded Lane A', kind: 'review', depends_on: [] },
    { node_id: 'integrate', label: 'Recorded Integrate', kind: 'integration', depends_on: ['launch_a'] },
  ]
  const runsRoot = join(fresh('runs-def'), 'w')
  mkdirSync(runsRoot, { recursive: true })
  writeRunDir(runsRoot, 'run-001', { nodes: recorded })
  // The registry definition uses the different MIN_NODES labels ('Lane A', 'Integrate') and kind 'worker' for launch_a.
  const config = registry([{ project_id: 'proj', name: 'Proj', repository: fresh('repo-def'), workflows: [{ workflow_id: 'w', runs_root: runsRoot, definition: { name: 'W', nodes: MIN_NODES } }] }])
  const app = createApp([], { projects: config, dispatch: { gitRunner: runner, now } })
  after(() => app.close())
  await app.ready()
  const body = (await app.inject({ method: 'GET', url: '/api/dispatch/projects/proj/steps' })).json()
  const step = body.workflows[0].runs[0].steps.find((s: { node_id: string }) => s.node_id === 'launch_a')
  assert.equal(step.label, 'Recorded Lane A', 'the step label comes from the run\'s recorded definition, not the registry')
  assert.equal(step.kind, 'review', 'the step kind comes from the run\'s recorded definition, not the registry\'s worker')
})

test('S9: no absolute path appears in either route\'s whole JSON; per-run and workflow-level error paths are redacted ([L8], [P8])', async t => {
  const runsRoot = join(fresh('runs-path'), 'w')
  mkdirSync(runsRoot, { recursive: true })
  writeRunDir(runsRoot, 'broken-001', {})
  // A second workflow whose runs_root is a regular file, as Trio's is ([P34]): `fs.readdir` fails with an ENOTDIR
  // error whose message carries the absolute path. Today's code swallows that and returns a fixed text, so the scan
  // passes; a regression that forwarded the caught error's message (dispatchSteps.ts:143) would leak the path and
  // fail the scan (design-challenge note 3).
  const fileRoot = join(fresh('runs-path-file'), 'w-file')
  writeFileSync(fileRoot, 'this is a file, not a runs directory')
  const config = registry([{
    project_id: 'proj', name: 'Proj', repository: fresh('repo-path'),
    workflows: [
      { workflow_id: 'w', runs_root: runsRoot, definition: { name: 'W', nodes: MIN_NODES } },
      { workflow_id: 'wfile', runs_root: fileRoot, definition: { name: 'W', nodes: MIN_NODES } },
    ],
  }])
  // The loader throws a message holding an absolute path, as the real `invalidRun` would before its own redaction.
  t.mock.method(RunStore.prototype, 'loadRun', async () => { throw new ProjectApiError(500, 'RUN_STORAGE_INVALID', 'plan.json is missing at /tmp/x/run/plan.json') })
  const app = createApp([], { projects: config, dispatch: { gitRunner: runner, now } })
  after(() => app.close())
  await app.ready()
  const overview = (await app.inject({ method: 'GET', url: '/api/dispatch/projects' })).json()
  const steps = (await app.inject({ method: 'GET', url: '/api/dispatch/projects/proj/steps' })).json()
  const ABSOLUTE = /(?:^|[^\w])\/(?:tmp|home|Users|var|private)\//
  for (const [name, body] of [['overview', overview], ['steps', steps]] as const) {
    assert.ok(!ABSOLUTE.test(JSON.stringify(body)), `an absolute path reached the ${name} response`)
  }
  const wf = steps.workflows.find((w: { workflow_id: string }) => w.workflow_id === 'w')
  const message = wf.errors[0].message as string
  assert.ok(message.includes('<path>'), 'the per-run path is redacted')
  assert.ok(message.includes('plan.json is missing'), 'the rest of the message survives verbatim')
  const wfFile = steps.workflows.find((w: { workflow_id: string }) => w.workflow_id === 'wfile')
  assert.ok(wfFile.error, 'the workflow whose runs_root is a file carries a workflow-level error (scanned for a path too)')
})

// ---- Stage C: the registry home read, the registry pages and the project spend ------------------------------------------

/** A run whose export carries `costs` as the controller writes it (workflow/costs.py), or none. */
function writeCostRun(runsRoot: string, runId: string, updated: string, costs?: unknown): void {
  writeRunDir(runsRoot, runId, { updated })
  if (costs === undefined) return
  const path = join(runsRoot, runId, 'run-state.json')
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), costs }))
}

const minute = (n: number) => new Date(Date.parse('2026-01-01T00:00:00Z') + n * 60_000).toISOString()

/**
 * One registry with several pages per workflow: `big` holds 130 runs (ties at every tenth minute), `mid` 60, `bad` an
 * invalid run, `gone` a missing runs root, and a second project with one small workflow.
 */
function pagedRegistry() {
  const base = fresh('paged')
  const roots = Object.fromEntries(['big', 'mid', 'bad', 'gone', 'small'].map(name => [name, join(base, name)]))
  for (const name of ['big', 'mid', 'bad', 'small']) mkdirSync(roots[name], { recursive: true })
  for (let i = 0; i < 130; i += 1) writeRunDir(roots.big, `big-${String(i).padStart(3, '0')}`, { updated: minute(i - (i % 10 === 0 ? 1 : 0)) })
  for (let i = 0; i < 60; i += 1) writeRunDir(roots.mid, `mid-${String(i).padStart(3, '0')}`, { updated: minute(i * 2) })
  writeRunDir(roots.bad, 'bad-001', { updated: minute(5) })
  writeRunDir(roots.bad, 'bad-002', { badState: true })
  for (let i = 0; i < 3; i += 1) writeRunDir(roots.small, `small-${i}`, { updated: minute(100 + i) })
  const definition = { name: 'W', nodes: MIN_NODES }
  const config = registry([
    { project_id: 'alpha', name: 'Alpha', repository: fresh('repo'), workflows: ['big', 'mid', 'bad', 'gone'].map(id => ({ workflow_id: id, runs_root: roots[id], definition })) },
    { project_id: 'beta', name: 'Beta', repository: fresh('repo'), workflows: [{ workflow_id: 'small', runs_root: roots.small, definition }] },
  ])
  return { config, roots }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the routes' bodies are read loosely here, then compared by deep equality
type Inject = (url: string) => Promise<{ statusCode: number; json: () => any }>

/** What the client assembled before the home route (`fetchRegistryRuns` with `readsNextPage(since)`), read over the per-workflow routes. */
async function perWorkflowAssembly(get: Inject, since: string) {
  const projects = (await get('/api/projects')).json().projects as { project_id: string }[]
  return Promise.all(projects.map(async project => {
    const listed = await get(`/api/projects/${project.project_id}/workflows`)
    if (listed.statusCode !== 200) return { project_id: project.project_id, workflows: [], error: { status: listed.statusCode, ...listed.json().error }, runs: [] }
    const workflows = listed.json().workflows as { workflow_id: string }[]
    const runs = await Promise.all(workflows.map(async workflow => {
      const read: unknown[] = []
      let next: string | null = null
      do {
        const page = await get(`/api/projects/${project.project_id}/workflows/${workflow.workflow_id}/runs${next ? `?cursor=${next}` : ''}`)
        if (page.statusCode !== 200) return { workflow_id: workflow.workflow_id, runs: [], next_cursor: null, error: { status: page.statusCode, ...page.json().error } }
        // The per-workflow route now lists the readable runs and names an unreadable one in `errors` (first page only); the
        // home route keeps failing such a workflow with the first unreadable run's error, which is what the list used to answer.
        const unread = page.json().errors as { code: string; message: string }[] | undefined
        if (unread) return { workflow_id: workflow.workflow_id, runs: [], next_cursor: null, error: { status: 500, code: unread[0].code, message: unread[0].message } }
        read.push(...page.json().runs)
        next = page.json().next_cursor
      } while (next !== null && readsNextPage(read as { updated_at: string }[], next, Date.parse(since)))
      return { workflow_id: workflow.workflow_id, runs: read, next_cursor: next, error: null }
    }))
    return { project_id: project.project_id, workflows, error: null, runs }
  }))
}

test('home route: equals the per-workflow routes\' assembly for three cutoffs, the >= boundary included; every row of each page read, no count', async () => {
  const { config } = pagedRegistry()
  const app = createApp([], { projects: config, dispatch: { gitRunner: runner, now } })
  after(() => app.close())
  await app.ready()
  const get: Inject = async url => app.inject({ method: 'GET', url })
  const firstPage = (await get('/api/projects/alpha/workflows/big/runs')).json().runs as { updated_at: string }[]
  const boundary = new Date(Date.parse(firstPage.at(-1)!.updated_at)).toISOString()
  for (const since of ['2025-01-01T00:00:00Z', boundary, '2027-01-01T00:00:00Z']) {
    const response = await get(`/api/dispatch/runs?since=${encodeURIComponent(since)}`)
    assert.equal(response.statusCode, 200)
    const body = homeRunsSchema.parse(response.json())
    assert.equal(body.contract_version, '1.0.0')
    assert.equal(body.since, new Date(since).toISOString())
    assert.deepEqual(body.projects, await perWorkflowAssembly(get, since), `since ${since}`)
    assert.deepEqual(Object.keys(body.projects[0].runs[0]).sort(), ['error', 'next_cursor', 'runs', 'workflow_id'], 'rows only, no server-computed count')
  }
  const at = (since: string) => get(`/api/dispatch/runs?since=${encodeURIComponent(since)}`).then(r => homeRunsSchema.parse(r.json()))
  const old = await at('2025-01-01T00:00:00Z')
  const big = old.projects[0].runs.find(entry => entry.workflow_id === 'big')!
  assert.equal(big.runs.length, 130, 'an old cutoff reads every page')
  assert.equal(big.next_cursor, null)
  const future = await at('2027-01-01T00:00:00Z')
  const firstOnly = future.projects[0].runs.find(entry => entry.workflow_id === 'big')!
  assert.equal(firstOnly.runs.length, 50, 'a future cutoff still serves the whole first page, never filtered to the cutoff')
  assert.ok(firstOnly.next_cursor)
  const edge = await at(boundary)
  assert.equal(edge.projects[0].runs.find(entry => entry.workflow_id === 'big')!.runs.length, 100, 'a last run exactly at the cutoff reads the next page')
  const bad = old.projects[0].runs.find(entry => entry.workflow_id === 'bad')!
  assert.deepEqual([bad.runs, bad.next_cursor, bad.error?.code, bad.error?.status], [[], null, 'RUN_STORAGE_INVALID', 500], 'an invalid run fails its workflow only')
  // The per-workflow route alone lists that workflow's readable run and names the invalid one in `errors`.
  const perWorkflow = (await get('/api/projects/alpha/workflows/bad/runs')).json()
  assert.deepEqual([perWorkflow.runs.map((run: { run_id: string }) => run.run_id), perWorkflow.errors.map((entry: { run_id: string; code: string }) => [entry.run_id, entry.code])],
    [['bad-001'], [['bad-002', 'RUN_STORAGE_INVALID']]])
  assert.equal(old.projects[0].runs.find(entry => entry.workflow_id === 'gone')!.error?.code, 'RUNS_ROOT_UNAVAILABLE')
  assert.equal(old.projects[1].runs[0].runs.length, 3)
})

test('home route: since is required and must be an ISO time with Z; only GET and HEAD', async () => {
  const { config } = pagedRegistry()
  const app = createApp([], { projects: config, dispatch: { gitRunner: runner, now } })
  after(() => app.close())
  await app.ready()
  for (const query of ['', '?since=', '?since=yesterday', '?since=2026-10-11', '?since=2026-10-11T00:00:00%2B02:00', '?since=2026-10-11T00:00:00Z&since=2026-10-12T00:00:00Z']) {
    const response = await app.inject({ method: 'GET', url: `/api/dispatch/runs${query}` })
    assert.equal(response.statusCode, 400, query)
    assert.equal(response.json().error.code, 'INVALID_SINCE', query)
  }
  assert.equal((await app.inject({ method: 'HEAD', url: '/api/dispatch/runs?since=2026-10-11T00:00:00Z' })).statusCode, 200)
  for (const url of ['/api/dispatch/runs?since=2026-10-11T00:00:00Z', '/api/dispatch/runs/all']) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const) {
      const response = await app.inject({ method, url })
      assert.equal(response.statusCode, 405, `${method} ${url}`)
      assert.equal(response.headers.allow, 'GET, HEAD')
    }
  }
})

test('registry pages: every run exactly once in the total order across page boundaries and ties, unreadable listed; bad cursors and limits are 400', async () => {
  const { config } = pagedRegistry()
  const app = createApp([], { projects: config, dispatch: { gitRunner: runner, now } })
  after(() => app.close())
  await app.ready()
  const page = async (query: string) => {
    const response = await app.inject({ method: 'GET', url: `/api/dispatch/runs/all${query}` })
    assert.equal(response.statusCode, 200, response.body)
    return registryRunsSchema.parse(response.json())
  }
  for (const limit of [undefined, 1, 7, 100]) {
    const read: { project_id: string; workflow_id: string; run_id: string; updated_at: string }[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const body: RegistryRuns = await page(`?${limit === undefined ? '' : `limit=${limit}&`}${cursor ? `cursor=${cursor}` : ''}`)
      assert.ok(body.runs.length <= (limit ?? 50))
      assert.deepEqual(body.unreadable, [{ project_id: 'alpha', workflow_id: 'bad', code: 'RUN_STORAGE_INVALID' }, { project_id: 'alpha', workflow_id: 'gone', code: 'RUNS_ROOT_UNAVAILABLE' }])
      read.push(...body.runs)
      cursor = body.next_cursor
      pages += 1
    } while (cursor !== null && pages < 500)
    assert.equal(read.length, 130 + 60 + 3, `limit ${limit}`)
    assert.equal(new Set(read.map(run => `${run.project_id}/${run.workflow_id}/${run.run_id}`)).size, read.length, 'no run twice')
    for (let i = 1; i < read.length; i += 1) {
      const [a, b] = [read[i - 1], read[i]]
      const text = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0)
      const order = Date.parse(b.updated_at) - Date.parse(a.updated_at) || text(a.project_id, b.project_id) || text(a.workflow_id, b.workflow_id) || text(a.run_id, b.run_id)
      assert.ok(order < 0, `order at ${i}: ${a.run_id} then ${b.run_id}`)
    }
  }
  const workflowCursor = (await app.inject({ method: 'GET', url: '/api/projects/alpha/workflows/big/runs' })).json().next_cursor
  const forged = Buffer.from(JSON.stringify({ v: 2, u: 'yesterday', p: 'alpha', w: 'big', r: 'x' })).toString('base64url')
  for (const query of [`?cursor=${workflowCursor}`, '?cursor=', '?cursor=%%%', '?cursor=bm90IGpzb24', `?cursor=${forged}`, `?cursor=${Buffer.from(JSON.stringify({ v: 2, u: '2026-01-01T00:00:00Z', p: 'a', w: 'b', r: 'c', extra: 1 })).toString('base64url')}`]) {
    const response = await app.inject({ method: 'GET', url: `/api/dispatch/runs/all${query}` })
    assert.equal(response.statusCode, 400, query)
    assert.equal(response.json().error.code, 'INVALID_CURSOR', query)
  }
  for (const query of ['?limit=0', '?limit=500', '?limit=abc', '?limit=101', '?limit=', '?limit=1.5', '?limit=-1', '?limit=1&limit=2']) {
    const response = await app.inject({ method: 'GET', url: `/api/dispatch/runs/all${query}` })
    assert.equal(response.statusCode, 400, query)
    assert.equal(response.json().error.code, 'INVALID_LIMIT', query)
  }
})

test('overview spend: the whole directory of every readable workflow, per project, recorded totals only; a warm poll reads no export; a change invalidates', async () => {
  const base = fresh('spend')
  const roots = Object.fromEntries(['many', 'mixed', 'broken', 'other'].map(name => [name, join(base, name)]))
  for (const root of Object.values(roots)) mkdirSync(root, { recursive: true })
  // 60 runs priced at 0.5 each: a page-limited total would read 50 of them.
  for (let i = 0; i < 60; i += 1) writeCostRun(roots.many, `many-${String(i).padStart(2, '0')}`, minute(i), { total_usd: 0.5, by_role: {}, nodes: [] })
  writeCostRun(roots.mixed, 'priced', minute(1), { total_usd: 1.234567, by_role: {}, nodes: [] })
  writeCostRun(roots.mixed, 'zero', minute(2), { total_usd: 0, by_role: {}, nodes: [] })
  writeCostRun(roots.mixed, 'nulltotal', minute(3), { total_usd: null, by_role: {}, nodes: [] })
  writeCostRun(roots.mixed, 'none', minute(4))
  writeCostRun(roots.mixed, 'covered', minute(5), { total_usd: null, covered_usd: 9.99, by_role: {}, nodes: [{ node: 'panel', role: 'panel', transport: 'pi', cost_usd: null, covered_usd: 9.99 }] })
  writeCostRun(roots.broken, 'fine', minute(1), { total_usd: 100, by_role: {}, nodes: [] })
  writeRunDir(roots.broken, 'corrupt', { badState: true })
  writeCostRun(roots.other, 'o1', minute(1), { total_usd: 7, by_role: {}, nodes: [] })
  const definition = { name: 'W', nodes: MIN_NODES }
  const config = registry([
    { project_id: 'p1', name: 'P1', repository: fresh('repo'), workflows: [{ workflow_id: 'many', runs_root: roots.many, definition }, { workflow_id: 'mixed', runs_root: roots.mixed, definition }, { workflow_id: 'broken', runs_root: roots.broken, definition }] },
    { project_id: 'p2', name: 'P2', repository: fresh('repo'), workflows: [{ workflow_id: 'other', runs_root: roots.other, definition }] },
    { project_id: 'p3', name: 'P3', repository: fresh('repo'), workflows: [] },
  ])
  const app = createApp([], { projects: config, dispatch: { gitRunner: runner, now } })
  after(() => app.close())
  await app.ready()
  const overview = async () => {
    const response = await app.inject({ method: 'GET', url: '/api/dispatch/projects' })
    assert.equal(response.statusCode, 200)
    return Object.fromEntries((response.json().projects as { project_id: string; spend: unknown }[]).map(entry => [entry.project_id, entry.spend]))
  }
  const first = await overview()
  assert.deepEqual(first.p1, { claude_usd: 31.234567, priced_runs: 62, runs: 65 }, '60 x 0.5 + 1.234567 + 0; null, absent and covered-only totals are unpriced; the unreadable workflow counts nowhere')
  assert.deepEqual(first.p2, { claude_usd: 7, priced_runs: 1, runs: 1 }, 'totals never mix across projects')
  assert.deepEqual(first.p3, { claude_usd: null, priced_runs: 0, runs: 0 })
  // A warm poll reads no run-state.json (the summary cache keeps the total). The invalid run is never cached by listRuns (its
  // workflow's list fails as before), so it is removed first and the cache primed once.
  rmSync(join(roots.broken, 'corrupt'), { recursive: true, force: true })
  const primed = await overview()
  assert.deepEqual(primed.p1, { claude_usd: 131.234567, priced_runs: 63, runs: 66 }, 'the workflow read again counts once it is readable')
  const fsPromises = (await import('node:fs/promises')).default
  const opened: string[] = []
  const original = fsPromises.open
  const spy = mock.method(fsPromises, 'open', function (this: unknown, ...args: Parameters<typeof original>) { opened.push(String(args[0])); return original.apply(this, args) })
  try {
    assert.deepEqual(await overview(), primed)
    assert.deepEqual(opened.filter(path => path.endsWith('run-state.json')), [], 'no export is read on a warm poll')
  } finally { spy.mock.restore() }
  // A changed export invalidates its cached summary: the new total is served, never the stale one.
  await new Promise(resolve => setTimeout(resolve, 20))
  writeCostRun(roots.other, 'o1', minute(1), { total_usd: 8.5, by_role: {}, nodes: [] })
  assert.deepEqual((await overview()).p2, { claude_usd: 8.5, priced_runs: 1, runs: 1 })
})

test('overview spend is null only when the workflow list cannot be read', async () => {
  const project = { project_id: 'p', name: 'P', repository: fresh('repo'), workflows: [] } as unknown as Parameters<typeof projectSpend>[1]
  const store = { workflows: () => { throw new ProjectApiError(404, 'PROJECT_NOT_FOUND', 'No project with that ID is registered.') } } as unknown as RunStore
  assert.equal(await projectSpend(store, project), null)
  const readable = { workflows: () => [{ workflow_id: 'w' }], scope: () => ({}), listRunEntries: async () => { throw new ProjectApiError(503, 'RUNS_ROOT_UNAVAILABLE', 'x') } } as unknown as RunStore
  assert.deepEqual(await projectSpend(readable, project), { claude_usd: null, priced_runs: 0, runs: 0 })
})
