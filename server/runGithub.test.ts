import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { createApp, type ProjectsConfig } from './app.ts'
import { realGitRunner, type GitRunner } from './dispatchGit.ts'
import {
  GH_REASONS, GithubReader, branchArgv, branchQuery, checkBucket, githubBranchReadSchema, githubReaderOptions, parseBranches,
  type GhResult, type GithubBranchRead,
} from './dispatchGithub.ts'
import { RUN_GITHUB_REASONS, RUN_GIT_REASONS, RunBranchReader, readRunBranch, readRunRepo, validBranchName } from './runGithub.ts'
import { runGithubSchema } from '../contracts/projects/github.ts'

/**
 * server/runGithub.test.ts (docs/PRD_RUN_TEAMS.md "GitHub read"): the run branch's local facts over real temporary
 * repositories (a bare origin and clones, isolated git config, a fixed identity), the GitHub reader's branch keys with an
 * injected gh runner and clock, and the run GitHub route. Every path lives under a temporary directory; nothing touches the
 * real `~/.config`, `~/.cache`, `~/.gitconfig` or GitHub, and gh is never spawned.
 */

const ROOT = mkdtempSync(join(tmpdir(), 'run-github-test-'))
// The reader's real git runner inherits process.env: keep the operator's ~/.gitconfig (insteadOf rules) out of every read.
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'
after(() => rmSync(ROOT, { recursive: true, force: true }))

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test Author', GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim()
}
let seq = 0
function fresh(name: string): string {
  const dir = join(ROOT, `${name}-${seq++}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
function commit(repo: string, message: string): string {
  writeFileSync(join(repo, `f-${seq++}.txt`), `${message}\n`)
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', message)
  return git(repo, 'rev-parse', 'HEAD')
}

const CLOCK = { t: Date.parse('2026-10-16T10:00:00Z') }
const now = () => CLOCK.t
const runner = realGitRunner()
const BRANCH = 'feature/demo/demo-001'

/** A bare origin on `main` (one commit) and a clone of it with origin/HEAD set. */
function originAndClone(): { origin: string; clone: string } {
  const origin = fresh('origin')
  git(origin, 'init', '-q', '--bare', '--initial-branch=main', '.')
  const seed = fresh('seed')
  git(seed, 'init', '-q', '-b', 'main', '.')
  commit(seed, 'c1')
  git(seed, 'remote', 'add', 'origin', origin)
  git(seed, 'push', '-q', 'origin', 'main')
  const clone = fresh('clone')
  git(clone, 'clone', '-q', origin, '.')
  return { origin, clone }
}

// ---- Local branch facts --------------------------------------------------------------------------------------------------

test('branch: no local branch is no_local_branch with null counts', async () => {
  const { clone } = originAndClone()
  const facts = await readRunBranch(runner, clone, BRANCH, 'main', null)
  assert.equal(facts.push_state, 'no_local_branch')
  assert.equal(facts.local_sha, null)
  assert.equal(facts.tracking_sha, null)
  assert.equal(facts.ahead_of_default, null)
  assert.deepEqual(facts.unpublished, [])
  assert.equal(facts.contains_integrated, null)
})

test('branch: a local branch never pushed is not_pushed; unpublished lists its commits newest first with the author as a push would publish it', async () => {
  const { clone } = originAndClone()
  git(clone, 'checkout', '-q', '-b', BRANCH)
  const first = commit(clone, 'first change')
  const second = commit(clone, 'second change')
  const facts = await readRunBranch(runner, clone, BRANCH, 'main', first)
  assert.equal(facts.push_state, 'not_pushed')
  assert.equal(facts.local_sha, second)
  assert.equal(facts.tracking_sha, null)
  assert.equal(facts.ahead_of_remote, null)
  assert.equal(facts.behind_remote, null)
  assert.equal(facts.ahead_of_default, 2)
  assert.equal(facts.behind_default, 0)
  assert.deepEqual(facts.unpublished.map(c => [c.sha, c.subject, c.author]), [
    [second, 'second change', 'Test Author <author@example.com>'],
    [first, 'first change', 'Test Author <author@example.com>'],
  ])
  assert.ok(facts.unpublished.every(c => !Number.isNaN(Date.parse(c.committed_at))))
  assert.equal(facts.unpublished_more, 0)
  assert.equal(facts.integrated_commit, first)
  assert.equal(facts.contains_integrated, true)
})

test('branch: pushed and level is up_to_date with nothing unpublished; a commit on top is local_ahead with one unpublished', async () => {
  const { clone } = originAndClone()
  git(clone, 'checkout', '-q', '-b', BRANCH)
  commit(clone, 'one')
  git(clone, 'push', '-q', 'origin', BRANCH)
  let facts = await readRunBranch(runner, clone, BRANCH, 'main', null)
  assert.equal(facts.push_state, 'up_to_date')
  assert.equal(facts.tracking_sha, facts.local_sha)
  assert.equal(facts.ahead_of_remote, 0)
  assert.equal(facts.behind_remote, 0)
  assert.deepEqual(facts.unpublished, [])
  assert.equal(facts.ahead_of_default, 1)

  const top = commit(clone, 'two')
  facts = await readRunBranch(runner, clone, BRANCH, 'main', null)
  assert.equal(facts.push_state, 'local_ahead')
  assert.equal(facts.ahead_of_remote, 1)
  assert.equal(facts.behind_remote, 0)
  assert.deepEqual(facts.unpublished.map(c => c.sha), [top], 'only the commit missing from the remote branch')
})

test('branch: remote_ahead and diverged from the remote-tracking ref (no fetch by the reader)', async () => {
  const { origin, clone } = originAndClone()
  git(clone, 'checkout', '-q', '-b', BRANCH)
  commit(clone, 'base')
  git(clone, 'push', '-q', 'origin', BRANCH)
  const other = fresh('other')
  git(other, 'clone', '-q', origin, '.')
  git(other, 'checkout', '-q', BRANCH)
  commit(other, 'remote change')
  git(other, 'push', '-q', 'origin', BRANCH)

  // Before a fetch the clone's tracking ref has not moved: the reader never fetches, so it is still level.
  assert.equal((await readRunBranch(runner, clone, BRANCH, 'main', null)).push_state, 'up_to_date')
  git(clone, 'fetch', '-q', 'origin')
  let facts = await readRunBranch(runner, clone, BRANCH, 'main', null)
  assert.equal(facts.push_state, 'remote_ahead')
  assert.equal(facts.ahead_of_remote, 0)
  assert.equal(facts.behind_remote, 1)

  commit(clone, 'local change')
  facts = await readRunBranch(runner, clone, BRANCH, 'main', null)
  assert.equal(facts.push_state, 'diverged')
  assert.equal(facts.ahead_of_remote, 1)
  assert.equal(facts.behind_remote, 1)
})

test('branch: 53 unpublished commits list 50 and count 3 more; contains_integrated false for a commit off the branch, null for an unknown sha', async () => {
  const { clone } = originAndClone()
  git(clone, 'checkout', '-q', '-b', 'elsewhere')
  const off = commit(clone, 'not on the run branch')
  git(clone, 'checkout', '-q', 'main')
  git(clone, 'checkout', '-q', '-b', BRANCH)
  for (let i = 0; i < 53; i += 1) commit(clone, `change ${i}`)
  const facts = await readRunBranch(runner, clone, BRANCH, 'main', off)
  assert.equal(facts.unpublished.length, 50)
  assert.equal(facts.unpublished_more, 3)
  assert.equal(facts.unpublished[0].subject, 'change 52')
  assert.equal(facts.contains_integrated, false)
  const unknown = await readRunBranch(runner, clone, BRANCH, 'main', 'deadbeefdeadbeef')
  assert.equal(unknown.contains_integrated, null)
})

test('branch names: git ref rules are enforced and an invalid name never reaches git', async () => {
  for (const good of ['main', 'feature/x/run-001', 'fix/a.b_c-d', 'a#b']) assert.equal(validBranchName(good), true, good)
  for (const bad of ['', '-x', '/x', 'x/', 'x.', 'a..b', 'a//b', 'a@{1}', '@', 'a b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[b', 'a\\b', 'a\x01', 'a\x7f', '.hidden', 'a/.b', 'x.lock', 'a/b.lock/c', 'x'.repeat(256)]) {
    assert.equal(validBranchName(bad), false, JSON.stringify(bad))
  }
  const { clone } = originAndClone()
  const seen: string[][] = []
  const recording: GitRunner = async (repo, args) => { seen.push([...args]); return runner(repo, args) }
  const facts = await readRunBranch(recording, clone, '--output=/tmp/x', 'main', null)
  assert.equal(facts.push_state, 'unknown')
  assert.equal(seen.length, 0, 'no git command for an invalid name')
  // The reader drops an invalid branch too: only the repository is read.
  const reader = new RunBranchReader(recording, now)
  const read = await reader.read(clone, 'bad name', null)
  assert.equal(read.branch, null)
  assert.ok(seen.every(args => !args.some(arg => arg.includes('bad name'))))
})

test('repo: github, not_github, no_remote and unavailable with fixed reasons; default branch from origin/HEAD', async () => {
  const { clone } = originAndClone()
  git(clone, 'remote', 'set-url', 'origin', 'https://github.com/acme/widgets.git')
  assert.deepEqual(await readRunRepo(runner, clone), { status: 'github', reason: null, ownerName: 'acme/widgets', defaultBranch: 'main', hasOrigin: true })
  git(clone, 'remote', 'set-url', 'origin', 'git@gitlab.com:acme/widgets.git')
  assert.deepEqual(await readRunRepo(runner, clone), { status: 'not_github', reason: RUN_GIT_REASONS.notGithub, ownerName: null, defaultBranch: 'main', hasOrigin: true })
  const solo = fresh('solo')
  git(solo, 'init', '-q', '-b', 'trunk', '.')
  commit(solo, 'c')
  assert.deepEqual(await readRunRepo(runner, solo), { status: 'no_remote', reason: RUN_GIT_REASONS.noRemote, ownerName: null, defaultBranch: null, hasOrigin: false })
  assert.equal((await readRunRepo(runner, join(ROOT, 'missing'))).reason, RUN_GIT_REASONS.repositoryNotFound)
  const plain = fresh('plain')
  assert.equal((await readRunRepo(runner, plain)).reason, RUN_GIT_REASONS.notARepository)
})

test('reader: cached 10 s per repository and branch; invalidate drops the cache', async () => {
  const { clone } = originAndClone()
  git(clone, 'checkout', '-q', '-b', BRANCH)
  commit(clone, 'one')
  let calls = 0
  const counting: GitRunner = async (repo, args) => { calls += 1; return runner(repo, args) }
  const reader = new RunBranchReader(counting, now)
  await reader.read(clone, BRANCH, null)
  const first = calls
  await reader.read(clone, BRANCH, null)
  assert.equal(calls, first, 'a second read within 10 s is cached')
  reader.invalidate(clone, BRANCH)
  await reader.read(clone, BRANCH, null)
  assert.ok(calls > first, 'invalidate forces a fresh read')
  const before = calls
  CLOCK.t += 10_001
  await reader.read(clone, BRANCH, null)
  assert.ok(calls > before, 'the cache expires after 10 s')
})

// ---- GitHub branch reads ------------------------------------------------------------------------------------------------

type PrOverrides = Record<string, unknown>
function prNode(number: number, overrides: PrOverrides = {}): Record<string, unknown> {
  return {
    number, title: `PR ${number}`, url: `https://github.com/acme/widgets/pull/${number}`, state: 'OPEN', isDraft: false, isCrossRepository: false,
    author: { login: 'octocat' }, headRefName: BRANCH, baseRefName: 'main', headRefOid: 'a'.repeat(40),
    updatedAt: '2026-10-16T09:00:00Z', mergedAt: null, reviewDecision: null, mergeable: 'MERGEABLE',
    comments: { totalCount: 0 }, reviewThreads: { totalCount: 0, nodes: [] }, reviewRequests: { nodes: [] },
    latestOpinionatedReviews: { nodes: [] }, commits: { nodes: [{ commit: { oid: 'a'.repeat(40), statusCheckRollup: null } }] },
    ...overrides,
  }
}
function response(branches: { oid: string | null; prs: Record<string, unknown>[] }[], repo: Record<string, unknown> = {}): string {
  const repository: Record<string, unknown> = { visibility: 'PUBLIC', viewerPermission: 'MAINTAIN', defaultBranchRef: { name: 'main' }, ...repo }
  branches.forEach((branch, i) => {
    repository[`b${i}`] = branch.oid ? { target: { oid: branch.oid } } : null
    repository[`p${i}`] = { nodes: branch.prs }
  })
  return JSON.stringify({ data: { viewer: { login: 'mani99brar' }, repository } })
}
const ok = (stdout: string): GhResult => ({ code: 0, stdout, stderr: '', timedOut: false, enoent: false })

const DRAFT_FAILING = prNode(531, {
  isDraft: true, reviewDecision: 'REVIEW_REQUIRED', comments: { totalCount: 2 },
  reviewThreads: { totalCount: 3, nodes: [{ isResolved: true }, { isResolved: false }, { isResolved: true }] },
  reviewRequests: { nodes: [
    { requestedReviewer: { __typename: 'Team', slug: 'vea-maintainers', organization: { login: 'kleros' } } },
    { requestedReviewer: { __typename: 'User', login: 'jaybuidl' } },
    { requestedReviewer: { __typename: 'Bot', login: 'copilot' } },
    { requestedReviewer: null },
  ] },
  latestOpinionatedReviews: { nodes: [{ author: { login: 'gitguardian' }, state: 'COMMENTED', submittedAt: '2026-10-16T09:50:00Z' }, { author: null, state: 'APPROVED', submittedAt: null }] },
  commits: { nodes: [{ commit: { oid: 'a'.repeat(40), statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [
    { __typename: 'CheckRun', name: 'zeta / lint', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://example.test/1' },
    { __typename: 'CheckRun', name: 'beta / unit', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://example.test/2' },
    { __typename: 'CheckRun', name: 'alpha / coverage', status: 'IN_PROGRESS', conclusion: null, detailsUrl: null },
    { __typename: 'CheckRun', name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED', detailsUrl: null },
    { __typename: 'CheckRun', name: 'flaky', status: 'COMPLETED', conclusion: 'STALE', detailsUrl: null },
    { __typename: 'StatusContext', context: 'GitGuardian', state: 'SUCCESS', targetUrl: null },
    { __typename: 'StatusContext', context: 'ci/legacy', state: 'ERROR', targetUrl: 'https://example.test/3' },
    { __typename: 'StatusContext', context: 'deploy', state: 'PENDING', targetUrl: null },
  ] } } } }] },
})

test('github parse: a draft PR with failing checks and team reviewers maps every field; checks fail, pending, then by name', () => {
  const { reads, viewer_login } = parseBranches(response([{ oid: 'a'.repeat(40), prs: [DRAFT_FAILING] }]), [BRANCH])
  assert.equal(viewer_login, 'mani99brar')
  const read = reads[0]
  assert.equal(read.visibility, 'PUBLIC')
  assert.equal(read.viewer_permission, 'MAINTAIN')
  assert.equal(read.default_branch, 'main')
  assert.equal(read.github_sha, 'a'.repeat(40))
  const pr = read.pr!
  assert.equal(pr.number, 531)
  assert.equal(pr.draft, true)
  assert.equal(pr.review_decision, 'REVIEW_REQUIRED')
  assert.equal(pr.comments, 2)
  assert.equal(pr.review_threads, 3)
  assert.equal(pr.unresolved_threads, 1)
  assert.deepEqual(pr.requested_reviewers, [{ kind: 'team', login: 'kleros/vea-maintainers' }, { kind: 'user', login: 'jaybuidl' }, { kind: 'bot', login: 'copilot' }])
  assert.deepEqual(pr.latest_reviews, [{ author: 'gitguardian', state: 'COMMENTED', submitted_at: '2026-10-16T09:50:00.000Z' }, { author: 'ghost', state: 'APPROVED', submitted_at: null }])
  const checks = pr.checks!
  assert.equal(checks.state, 'FAILURE')
  assert.deepEqual(checks.items.map(c => [c.name, c.bucket]), [
    ['beta / unit', 'fail'], ['ci/legacy', 'fail'], ['alpha / coverage', 'pending'], ['deploy', 'pending'],
    ['GitGuardian', 'pass'], ['docs', 'skip'], ['flaky', 'neutral'], ['zeta / lint', 'pass'],
  ])
  assert.deepEqual([checks.passing, checks.failing, checks.pending, checks.skipped, checks.total], [2, 2, 2, 1, 8])
  const status = checks.items.find(c => c.name === 'ci/legacy')!
  assert.deepEqual(status, { name: 'ci/legacy', kind: 'status', status: null, conclusion: 'ERROR', bucket: 'fail', url: 'https://example.test/3' })
})

test('github parse: check buckets follow the fixed table', () => {
  assert.equal(checkBucket('check_run', 'COMPLETED', 'SUCCESS'), 'pass')
  for (const word of ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']) assert.equal(checkBucket('check_run', 'COMPLETED', word), 'fail', word)
  for (const status of ['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING', 'REQUESTED']) assert.equal(checkBucket('check_run', status, null), 'pending', status)
  assert.equal(checkBucket('check_run', 'COMPLETED', 'SKIPPED'), 'skip')
  assert.equal(checkBucket('check_run', 'COMPLETED', 'NEUTRAL'), 'neutral')
  assert.equal(checkBucket('check_run', 'COMPLETED', 'STALE'), 'neutral')
  assert.equal(checkBucket('status', null, 'ERROR'), 'fail')
  assert.equal(checkBucket('status', null, 'EXPECTED'), 'pending')
})

test('github parse: the newest open PR is chosen, else the newest; the rest are earlier_prs; cross-repository PRs are ignored; no PR is null', () => {
  const merged = prNode(10, { state: 'MERGED', mergedAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z' })
  const closed = prNode(11, { state: 'CLOSED', updatedAt: '2026-10-14T00:00:00Z' })
  const open = prNode(12, { updatedAt: '2026-10-12T00:00:00Z' })
  const fork = prNode(99, { isCrossRepository: true, updatedAt: '2026-10-16T00:00:00Z' })
  const { reads } = parseBranches(response([
    { oid: 'b'.repeat(40), prs: [fork, merged, closed, open] },
    { oid: 'c'.repeat(40), prs: [merged, closed] },
    { oid: null, prs: [fork] },
    { oid: null, prs: [] },
  ]), ['one', 'two', 'three', 'four'])
  assert.equal(reads[0].pr!.number, 12, 'open beats newer merged/closed')
  assert.deepEqual(reads[0].earlier_prs.map(p => p.number), [10, 11], 'fork #99 is not among them')
  assert.equal(reads[1].pr!.number, 10, 'no open: the newest')
  assert.equal(reads[1].pr!.merged_at, '2026-10-10T00:00:00.000Z')
  assert.deepEqual(reads[1].earlier_prs, [{ number: 11, title: 'PR 11', url: 'https://github.com/acme/widgets/pull/11', state: 'CLOSED', updated_at: '2026-10-14T00:00:00.000Z' }])
  assert.equal(reads[2].pr, null, 'only a fork PR: none')
  assert.equal(reads[3].pr, null)
  assert.equal(reads[3].github_sha, null, 'the branch is not on GitHub')
})

test('github query: branch names travel as GraphQL variables; the query text never contains one', () => {
  const names = ['feature/sneaky") { x }', 'fix/other']
  const argv = branchArgv('acme/widgets', names)
  const query = argv.find(arg => arg.startsWith('query='))!
  for (const name of names) assert.ok(!query.includes(name), `the query holds ${name}`)
  assert.ok(query.includes('$q0:String!') && query.includes('$h1:String!'))
  assert.ok(query.includes('isCrossRepository') && query.includes('latestOpinionatedReviews(first: 50)') && query.includes('viewerPermission'))
  assert.deepEqual(argv.slice(-8), ['-f', `q0=refs/heads/${names[0]}`, '-f', `h0=${names[0]}`, '-f', `q1=refs/heads/${names[1]}`, '-f', `h1=${names[1]}`])
  assert.ok(argv.includes('owner=acme') && argv.includes('name=widgets'))
  assert.equal(branchQuery(0).includes('$q0'), false)
  assert.ok(!argv.some(arg => arg.startsWith('-F')), 'raw -f only: gh never reads a file for a value')
})

function runnerReader(responses: GhResult[], extra: Partial<ConstructorParameters<typeof GithubReader>[0]> = {}) {
  const calls: string[][] = []
  const reader = new GithubReader({
    mode: 'runner', now,
    runner: async argv => { calls.push([...argv]); return responses.shift() ?? ok(response([{ oid: null, prs: [] }])) },
    ...extra,
  })
  return { reader, calls }
}

test('github reader: pending before the first read; the branch tick reads it once per window; markDue rereads; one query per repository', async () => {
  const { reader, calls } = runnerReader([ok(response([{ oid: 'a'.repeat(40), prs: [DRAFT_FAILING] }, { oid: null, prs: [] }]))])
  const pending = reader.branchState('acme/widgets', BRANCH)
  assert.equal(pending.state.status, 'pending')
  assert.equal(pending.state.reason, GH_REASONS.pending)
  assert.equal(calls.length, 0, 'a request never calls gh')
  reader.branchState('acme/widgets', 'fix/other')
  await reader.cycleBranches()
  assert.equal(calls.length, 1, 'two branches of one repository share one query')
  const read = reader.branchState('acme/widgets', BRANCH)
  assert.equal(read.state.status, 'read')
  assert.equal(read.state.viewer_login, 'mani99brar')
  assert.equal(read.state.viewer_permission, 'MAINTAIN')
  assert.equal(read.state.read_at, new Date(CLOCK.t).toISOString())
  assert.equal(read.data!.pr!.number, 531)
  assert.equal(reader.branchState('acme/widgets', 'fix/other').data!.pr, null)

  CLOCK.t += 30_000
  await reader.cycleBranches()
  assert.equal(calls.length, 1, 'not due within 90 s')
  reader.markDue(`acme/widgets#${BRANCH}`)
  await reader.cycleBranches()
  assert.equal(calls.length, 2, 'markDue makes it due at the next tick')
  assert.ok(calls[1].includes(`h0=${BRANCH}`))
  assert.ok(!calls[1].some(arg => arg === 'h1=fix/other'), 'only the marked branch')
})

test('github reader: a branch nobody asked for in 15 minutes is not read', async () => {
  const { reader, calls } = runnerReader([])
  reader.branchState('acme/widgets', BRANCH)
  CLOCK.t += 15 * 60_000 + 1
  await reader.cycleBranches()
  assert.equal(calls.length, 0)
})

test('github reader: gh logged out is unavailable before any data and keeps the last good read after', async () => {
  const loggedOut: GhResult = { code: 1, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login\nsecret-ish detail', timedOut: false, enoent: false }
  const { reader } = runnerReader([loggedOut, ok(response([{ oid: 'a'.repeat(40), prs: [DRAFT_FAILING] }])), loggedOut])
  reader.branchState('acme/widgets', BRANCH)
  await reader.cycleBranches()
  let state = reader.branchState('acme/widgets', BRANCH)
  assert.equal(state.state.status, 'unavailable')
  assert.equal(state.state.reason, GH_REASONS.notLoggedIn)
  assert.ok(!JSON.stringify(state).includes('secret-ish'), 'stderr never reaches the state')
  CLOCK.t += 91_000
  await reader.cycleBranches()
  assert.equal(reader.branchState('acme/widgets', BRANCH).state.status, 'read')
  CLOCK.t += 91_000
  await reader.cycleBranches()
  state = reader.branchState('acme/widgets', BRANCH)
  assert.equal(state.state.status, 'read', 'the last good data is kept')
  assert.equal(state.state.reason, GH_REASONS.notLoggedIn)
  assert.equal(state.data!.pr!.number, 531)
})

test('github reader: off mode answers off and never registers; markDue is a no-op', async () => {
  const reader = new GithubReader({ mode: 'off', now })
  const state = reader.branchState('acme/widgets', BRANCH)
  assert.deepEqual(state.state, { status: 'off', reason: GH_REASONS.off, read_at: null, viewer_login: null, visibility: null, viewer_permission: null })
  reader.markDue(`acme/widgets#${BRANCH}`)
  await reader.cycleBranches()
})

const FIXTURE_READ: GithubBranchRead = {
  read_at: '2026-10-16T09:59:00Z', visibility: 'PRIVATE', viewer_permission: 'WRITE', default_branch: 'main', github_sha: 'd'.repeat(40),
  pr: parseBranches(response([{ oid: 'a'.repeat(40), prs: [DRAFT_FAILING] }]), [BRANCH]).reads[0].pr, earlier_prs: [],
}

test('github fixture: a branches map is served; a fixture without branches still loads; a branch missing from it is unavailable', () => {
  const dir = fresh('fixture')
  const withBranches = join(dir, 'with.json')
  writeFileSync(withBranches, JSON.stringify({ viewer_login: 'mani99brar', repos: {}, branches: { [`acme/widgets#${BRANCH}`]: FIXTURE_READ } }))
  const reader = new GithubReader(githubReaderOptions({ MD_MANAGER_GITHUB_FIXTURE: withBranches }, now))
  const state = reader.branchState('acme/widgets', BRANCH)
  assert.equal(state.state.status, 'read')
  assert.equal(state.state.visibility, 'PRIVATE')
  assert.equal(state.data!.github_sha, 'd'.repeat(40))
  const missing = reader.branchState('acme/widgets', 'other')
  assert.equal(missing.state.status, 'unavailable')
  assert.equal(missing.state.reason, GH_REASONS.notInFixture)

  const older = join(dir, 'older.json')
  writeFileSync(older, JSON.stringify({ viewer_login: 'x', repos: {} }))
  const plain = new GithubReader(githubReaderOptions({ MD_MANAGER_GITHUB_FIXTURE: older }, now))
  assert.equal(plain.branchState('acme/widgets', BRANCH).state.status, 'unavailable')
  assert.equal(githubReaderOptions({ MD_MANAGER_GITHUB_BRANCH_REFRESH_SECONDS: '45', MD_MANAGER_GITHUB_CACHE: join(dir, 'c.json') }, now).branchRefreshSeconds, 45)
})

test('github cache: branch reads are written under branches and served after a restart; an older cache without branches loads', async () => {
  const dir = fresh('cache')
  const cachePath = join(dir, 'github.json')
  const { reader } = runnerReader([ok(response([{ oid: 'a'.repeat(40), prs: [DRAFT_FAILING] }]))], { cachePath })
  reader.branchState('acme/widgets', BRANCH)
  await reader.cycleBranches()
  const written = JSON.parse(readFileSync(cachePath, 'utf8')) as { branches: Record<string, unknown> }
  assert.ok(githubBranchReadSchema.safeParse(written.branches[`acme/widgets#${BRANCH}`]).success)
  const restarted = new GithubReader({ mode: 'runner', now, cachePath, runner: async () => { throw new Error('no gh call expected') } })
  assert.equal(restarted.branchState('acme/widgets', BRANCH).state.status, 'read')

  const olderPath = join(dir, 'older.json')
  writeFileSync(olderPath, JSON.stringify({ viewer_login: 'v', repos: {} }))
  const old = new GithubReader({ mode: 'runner', now, cachePath: olderPath, runner: async () => ok('{}') })
  assert.equal(old.viewerLogin, 'v')
  assert.equal(old.branchState('acme/widgets', BRANCH).state.status, 'pending')
})

// ---- The route ----------------------------------------------------------------------------------------------------------

const BASE = 'a'.repeat(40)
const NODES = [
  { node_id: 'launch_a', label: 'Lane A', kind: 'worker', depends_on: [] },
  { node_id: 'integrate', label: 'Integrate', kind: 'integration', depends_on: ['launch_a'] },
]
const workerInput = { role: 'builder', required_check_kinds: ['build'], task: '# task', prompt: null, owned_paths: ['src'], checks: [{ id: 'build', kind: 'build', argv: ['npm', 'run', 'build'], command: 'npm run build', timeout_seconds: 60, scenarios: [] }], launch: null, completion: null, handoff: null, stop: null, questions: [] }

function writeRun(runsRoot: string, runId: string, sourceBranch: string | null, integrated: string | null): void {
  const dir = join(runsRoot, runId)
  mkdirSync(dir, { recursive: true })
  const events = integrated ? [{ sequence: 1, time: '2026-10-16T09:00:00Z', node: 'integrate', status: 'succeeded', message: `Fast-forwarded to ${integrated}` }] : []
  const inputs = {
    feature: 'Demo', policy_version: '1.1.0', base_commit: BASE, source_branch: sourceBranch, mode: 'manual', automatic: null,
    setup: [], max_verification_attempts: 3, failure_drill: null, selected_workers: ['a'], workers: { a: workerInput },
  }
  const state = {
    version: '1.7.0', run_id: runId, base_commit: BASE, created_at: '2026-10-16T08:00:00Z', updated_at: '2026-10-16T09:00:00Z',
    definition: { name: 'W', nodes: NODES }, values: { run_id: runId }, next: [], tasks: [], events, verification_packets: [], inputs,
  }
  writeFileSync(join(dir, 'run-state.json'), JSON.stringify(state))
  if (events.length) writeFileSync(join(dir, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n')
  writeFileSync(join(dir, 'plan.json'), JSON.stringify({ run_id: runId, base_commit: BASE }))
}

function registry(projects: { project_id: string; repository: string; runs_root: string }[]): ProjectsConfig {
  return { projects: projects.map(p => ({ project_id: p.project_id, name: p.project_id, repository: p.repository, workflows: [{ workflow_id: 'w', runs_root: p.runs_root, definition: { name: 'W', nodes: NODES } }] })) } as unknown as ProjectsConfig
}

test('route: GET and HEAD answer a validated read with the branch facts and the fixture PR; unknown run 404; POST 405; a non-GitHub origin is not_github', async () => {
  const { clone } = originAndClone()
  git(clone, 'checkout', '-q', '-b', BRANCH)
  const integrated = commit(clone, 'run change')
  git(clone, 'checkout', '-q', 'main')
  git(clone, 'remote', 'set-url', 'origin', 'https://github.com/acme/widgets.git')
  const runsRoot = join(fresh('runs'), 'w')
  mkdirSync(runsRoot, { recursive: true })
  writeRun(runsRoot, 'run-001', BRANCH, integrated.slice(0, 12))
  writeRun(runsRoot, 'run-002', null, null)

  const gitlab = originAndClone().clone
  git(gitlab, 'remote', 'set-url', 'origin', 'git@gitlab.com:acme/widgets.git')
  const gitlabRuns = join(fresh('runs-gl'), 'w')
  mkdirSync(gitlabRuns, { recursive: true })
  writeRun(gitlabRuns, 'run-001', BRANCH, null)

  const github = new GithubReader({ mode: 'fixture', now, fixture: { viewer_login: 'mani99brar', repos: {}, branches: { [`acme/widgets#${BRANCH}`]: FIXTURE_READ } } })
  const app = createApp([], {
    projects: registry([{ project_id: 'proj', repository: clone, runs_root: runsRoot }, { project_id: 'gl', repository: gitlab, runs_root: gitlabRuns }]),
    dispatch: { gitRunner: runner, now, github },
  })
  after(() => app.close())
  await app.ready()

  const url = '/api/dispatch/projects/proj/workflows/w/runs/run-001/github'
  const res = await app.inject({ method: 'GET', url })
  assert.equal(res.statusCode, 200, res.body)
  const body = runGithubSchema.parse(res.json())
  assert.deepEqual(body.repo, { status: 'github', reason: null, owner_name: 'acme/widgets', url: 'https://github.com/acme/widgets', remote: 'origin', default_branch: 'main' })
  assert.equal(body.github.status, 'read')
  assert.equal(body.github.viewer_login, 'mani99brar')
  assert.equal(body.branch.name, BRANCH)
  assert.equal(body.branch.push_state, 'not_pushed')
  assert.equal(body.branch.local_sha, integrated)
  assert.equal(body.branch.github_sha, 'd'.repeat(40))
  assert.equal(body.branch.integrated_commit, integrated.slice(0, 12))
  assert.equal(body.branch.contains_integrated, true)
  assert.equal(body.branch.unpublished.length, 1)
  assert.equal(body.pr!.number, 531)
  assert.ok(!res.body.includes(ROOT), 'no absolute path in the response')
  assert.equal(res.headers['cache-control'], 'no-store')

  assert.equal((await app.inject({ method: 'HEAD', url })).statusCode, 200)
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    const r = await app.inject({ method, url })
    assert.equal(r.statusCode, 405, method)
    assert.equal(r.headers.allow, 'GET, HEAD')
  }
  const unknown = await app.inject({ method: 'GET', url: '/api/dispatch/projects/proj/workflows/w/runs/run-999/github' })
  assert.equal(unknown.statusCode, 404)
  assert.equal(unknown.json().error.code, 'RUN_NOT_FOUND')
  assert.equal((await app.inject({ method: 'GET', url: '/api/dispatch/projects/nope/workflows/w/runs/run-001/github' })).statusCode, 404)

  const noBranch = runGithubSchema.parse((await app.inject({ method: 'GET', url: '/api/dispatch/projects/proj/workflows/w/runs/run-002/github' })).json())
  assert.equal(noBranch.branch.name, null)
  assert.equal(noBranch.github.status, 'unavailable')
  assert.equal(noBranch.github.reason, RUN_GITHUB_REASONS.noBranch)

  const gl = runGithubSchema.parse((await app.inject({ method: 'GET', url: '/api/dispatch/projects/gl/workflows/w/runs/run-001/github' })).json())
  assert.equal(gl.repo.status, 'not_github')
  assert.equal(gl.repo.owner_name, null)
  assert.equal(gl.github.status, 'not_github')
  assert.equal(gl.branch.push_state, 'no_local_branch')
})

test('route: runner mode answers pending without a gh call; a missing repository is unavailable; the app exposes the source and markDue', async () => {
  const { clone } = originAndClone()
  git(clone, 'remote', 'set-url', 'origin', 'https://github.com/acme/widgets.git')
  const runsRoot = join(fresh('runs-p'), 'w')
  mkdirSync(runsRoot, { recursive: true })
  writeRun(runsRoot, 'run-001', BRANCH, null)
  const missingRuns = join(fresh('runs-m'), 'w')
  mkdirSync(missingRuns, { recursive: true })
  writeRun(missingRuns, 'run-001', BRANCH, null)
  // Only branch queries are counted: the app's start also runs the repository-level overview read.
  const calls: string[][] = []
  const github = new GithubReader({ mode: 'runner', now, runner: async argv => {
    if (argv.some(arg => arg.startsWith('h0='))) calls.push([...argv])
    return ok(response([{ oid: null, prs: [] }]))
  } })
  const app = createApp([], {
    projects: registry([{ project_id: 'proj', repository: clone, runs_root: runsRoot }, { project_id: 'gone', repository: join(ROOT, 'no-such-repo'), runs_root: missingRuns }]),
    dispatch: { gitRunner: runner, now, github },
  })
  after(() => app.close())
  await app.ready()
  const body = runGithubSchema.parse((await app.inject({ method: 'GET', url: '/api/dispatch/projects/proj/workflows/w/runs/run-001/github' })).json())
  assert.equal(body.github.status, 'pending')
  assert.equal(body.pr, null)
  assert.equal(calls.length, 0, 'a request never calls gh')
  await github.cycleBranches()
  assert.equal(calls.length, 1)
  const after1 = await app.runGithub.read('proj', 'w', 'run-001')
  assert.equal(after1.github.status, 'read')
  app.runGithub.markDue('proj', 'w', 'run-001')
  await github.cycleBranches()
  assert.equal(calls.length, 2, 'markDue through the app decoration rereads at the next tick')

  const gone = runGithubSchema.parse((await app.inject({ method: 'GET', url: '/api/dispatch/projects/gone/workflows/w/runs/run-001/github' })).json())
  assert.equal(gone.repo.status, 'unavailable')
  assert.equal(gone.repo.reason, RUN_GIT_REASONS.repositoryNotFound)
  assert.equal(gone.github.status, 'unavailable')
  assert.equal(gone.github.reason, GH_REASONS.gitNotRead)
  assert.equal(gone.branch.push_state, 'unknown')
  assert.equal(existsSync(join(ROOT, 'no-such-repo')), false)
})

// ---- Review fixes (swarm backend-verify-175144: F4.1-F4.6, F2.1, F2.2) ----------------------------------------------------

const TIMED_OUT = { code: -1, stdout: '', stderr: '', timedOut: true, enoent: false }
/** The real runner, except that a command whose argv matches `when` times out. */
function timingOut(when: (args: readonly string[]) => boolean): GitRunner {
  return async (repo, args) => when(args) ? TIMED_OUT : runner(repo, args)
}

test('F4.1: a timed-out or failed rev-parse is unknown, never no_local_branch or not_pushed; a failed origin read is unavailable, never no_remote', async () => {
  const { clone } = originAndClone()
  git(clone, 'checkout', '-q', '-b', BRANCH)
  commit(clone, 'one')
  git(clone, 'push', '-q', 'origin', BRANCH)
  commit(clone, 'two')

  const localFails = await readRunBranch(timingOut(args => args.includes(`refs/heads/${BRANCH}^{commit}`)), clone, BRANCH, 'main', null)
  assert.equal(localFails.push_state, 'unknown', 'a timed-out local head read is not no_local_branch')
  assert.equal(localFails.local_sha, null)
  assert.deepEqual(localFails.unpublished, [])

  const trackingFails = await readRunBranch(timingOut(args => args.includes(`refs/remotes/origin/${BRANCH}^{commit}`)), clone, BRANCH, 'main', null)
  assert.equal(trackingFails.push_state, 'unknown', 'a timed-out tracking read is not not_pushed')
  assert.equal(trackingFails.tracking_sha, null)
  assert.deepEqual(trackingFails.unpublished, [], 'no preview without the tracking exclusion')

  const exit128: GitRunner = async (repo, args) => args.includes(`refs/heads/${BRANCH}^{commit}`) ? { code: 128, stdout: '', stderr: 'fatal', timedOut: false, enoent: false } : runner(repo, args)
  assert.equal((await readRunBranch(exit128, clone, BRANCH, 'main', null)).push_state, 'unknown', 'only exit 1 means absent')

  const remoteFails = await readRunRepo(timingOut(args => args[0] === 'config' || args[0] === 'remote'), clone)
  assert.equal(remoteFails.status, 'unavailable')
  assert.equal(remoteFails.reason, RUN_GIT_REASONS.gitTimedOut)

  const previewFails = await readRunBranch(timingOut(args => args[0] === 'log'), clone, BRANCH, 'main', null)
  assert.equal(previewFails.push_state, 'unknown', 'a push is never offered on a preview that could not be read')
})

test('F4.4: with no tracking ref and no remote default ref, nothing is listed as unpublished and the push state is unknown', async () => {
  const { clone } = originAndClone()
  git(clone, 'checkout', '-q', '-b', BRANCH)
  commit(clone, 'run change')
  git(clone, 'update-ref', '-d', 'refs/remotes/origin/main')
  const facts = await readRunBranch(runner, clone, BRANCH, 'main', null)
  assert.deepEqual(facts.unpublished, [], 'the whole history is not a push preview')
  assert.equal(facts.unpublished_more, 0)
  assert.equal(facts.push_state, 'unknown')
  const noDefault = await readRunBranch(runner, clone, BRANCH, null, null)
  assert.deepEqual(noDefault.unpublished, [])
  assert.equal(noDefault.push_state, 'unknown')
})

test('F4.5: counts and the preview are pinned to the captured local sha even when the branch moves mid-read', async () => {
  const { clone } = originAndClone()
  git(clone, 'checkout', '-q', '-b', BRANCH)
  const first = commit(clone, 'first')
  git(clone, 'checkout', '-q', 'main')
  const later = git(clone, 'commit-tree', '-p', first, '-m', 'moved in', `${first}^{tree}`)
  const seen: string[][] = []
  let moved = false
  const moving: GitRunner = async (repo, args) => {
    seen.push([...args])
    const result = await runner(repo, args)
    if (!moved && args.includes(`refs/heads/${BRANCH}^{commit}`)) { moved = true; git(clone, 'update-ref', `refs/heads/${BRANCH}`, later) }
    return result
  }
  const facts = await readRunBranch(moving, clone, BRANCH, 'main', first)
  assert.equal(facts.local_sha, first)
  assert.deepEqual(facts.unpublished.map(c => c.sha), [first], 'the preview is the history of the reported sha')
  assert.equal(facts.ahead_of_default, 1)
  const after1 = seen.filter(args => ['rev-list', 'log', 'merge-base'].includes(args[0]))
  assert.ok(after1.length >= 3)
  assert.ok(after1.every(args => !args.some(arg => arg.includes('refs/'))), 'no count or log re-resolves a mutable ref')
})

test('F4.6: owner/name is remote.origin.url as the controller reads it; a pushurl, insteadOf or pushInsteadOf elsewhere is unavailable', async () => {
  const { clone } = originAndClone()
  git(clone, 'remote', 'set-url', 'origin', 'https://github.com/acme/widgets.git')
  assert.equal((await readRunRepo(runner, clone)).ownerName, 'acme/widgets')

  git(clone, 'config', 'remote.origin.pushurl', 'git@github.com:Acme/Widgets.git')
  assert.equal((await readRunRepo(runner, clone)).ownerName, 'acme/widgets', 'the same repository in another URL form and case')
  git(clone, 'config', 'remote.origin.pushurl', 'https://github.com/evil/fork.git')
  let read = await readRunRepo(runner, clone)
  assert.deepEqual([read.status, read.reason, read.ownerName], ['unavailable', RUN_GIT_REASONS.originMismatch, null])
  git(clone, 'config', '--unset', 'remote.origin.pushurl')

  git(clone, 'config', 'url.https://github.com/evil/.pushInsteadOf', 'https://github.com/acme/')
  read = await readRunRepo(runner, clone)
  assert.equal(read.reason, RUN_GIT_REASONS.originMismatch, 'pushInsteadOf sends the push elsewhere')
  git(clone, 'config', '--remove-section', 'url.https://github.com/evil/')

  git(clone, 'config', 'url.https://github.com/other/.insteadOf', 'https://github.com/acme/')
  read = await readRunRepo(runner, clone)
  assert.equal(read.reason, RUN_GIT_REASONS.originMismatch, 'insteadOf: git pushes to other/widgets while gh --repo would use acme/widgets')
  git(clone, 'config', '--remove-section', 'url.https://github.com/other/')

  git(clone, 'config', '--add', 'remote.origin.url', 'https://github.com/second/widgets.git')
  read = await readRunRepo(runner, clone)
  assert.equal(read.reason, RUN_GIT_REASONS.originMismatch, 'two origin URLs push to two repositories')
})

test('F4.2/F4.3: the served default branch is GitHub\'s once read (not the local main guess, and filled when there is no local guess)', async () => {
  // F4.2: GitHub's default is dev; the clone also has main (origin/HEAD and a local main).
  const { clone } = originAndClone()
  git(clone, 'checkout', '-q', '-b', 'dev')
  commit(clone, 'on dev')
  git(clone, 'push', '-q', 'origin', 'dev')
  git(clone, 'checkout', '-q', '-b', BRANCH)
  commit(clone, 'run change')
  git(clone, 'checkout', '-q', 'main')
  git(clone, 'remote', 'set-url', 'origin', 'https://github.com/acme/widgets.git')
  const runsRoot = join(fresh('runs-def'), 'w')
  mkdirSync(runsRoot, { recursive: true })
  writeRun(runsRoot, 'run-001', BRANCH, null)

  // F4.3: no origin/HEAD, no main or master; GitHub says trunk.
  const solo = fresh('solo-def')
  git(solo, 'init', '-q', '-b', 'trunk', '.')
  commit(solo, 'c')
  git(solo, 'remote', 'add', 'origin', 'https://github.com/acme/solo.git')
  git(solo, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD')
  git(solo, 'checkout', '-q', '-b', BRANCH)
  commit(solo, 'run change')
  const soloRuns = join(fresh('runs-solo'), 'w')
  mkdirSync(soloRuns, { recursive: true })
  writeRun(soloRuns, 'run-001', BRANCH, null)

  const github = new GithubReader({ mode: 'fixture', now, fixture: { viewer_login: 'mani99brar', repos: {}, branches: {
    [`acme/widgets#${BRANCH}`]: { ...FIXTURE_READ, default_branch: 'dev' },
    [`acme/solo#${BRANCH}`]: { ...FIXTURE_READ, default_branch: 'trunk' },
  } } })
  const app = createApp([], {
    projects: registry([{ project_id: 'proj', repository: clone, runs_root: runsRoot }, { project_id: 'solo', repository: solo, runs_root: soloRuns }]),
    dispatch: { gitRunner: runner, now, github },
  })
  after(() => app.close())
  await app.ready()
  const body = await app.runGithub.read('proj', 'w', 'run-001')
  assert.equal(body.github.status, 'read')
  assert.equal(body.repo.default_branch, 'dev', 'GitHub\'s defaultBranchRef, not the local main guess')
  assert.deepEqual([body.branch.ahead_of_default, body.branch.behind_default], [1, 0], 'counted against origin/dev (against main it is 2 ahead)')
  const soloBody = await app.runGithub.read('solo', 'w', 'run-001')
  assert.equal(soloBody.repo.default_branch, 'trunk', 'filled from GitHub when there is no local guess')
  assert.equal(soloBody.branch.ahead_of_default, 1)
})

test('F2.1: checks beyond the first hundred: total is totalCount and a failing rollup with no failing check on the page counts one', () => {
  const passing = Array.from({ length: 100 }, (_, i) => ({ __typename: 'CheckRun', name: `ok ${String(i).padStart(3, '0')}`, status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: null }))
  const truncated = (state: string) => prNode(7, { commits: { nodes: [{ commit: { oid: 'a'.repeat(40), statusCheckRollup: { state, contexts: { totalCount: 150, nodes: passing } } } }] } })
  const failing = parseBranches(response([{ oid: 'a'.repeat(40), prs: [truncated('FAILURE')] }]), [BRANCH]).reads[0].pr!.checks!
  assert.equal(failing.total, 150)
  assert.equal(failing.failing, 1, 'the failure beyond the page is not failing: 0')
  assert.equal(failing.items.length, 100)
  const pendingChecks = parseBranches(response([{ oid: 'a'.repeat(40), prs: [truncated('PENDING')] }]), [BRANCH]).reads[0].pr!.checks!
  assert.equal(pendingChecks.pending, 1)
  assert.equal(pendingChecks.failing, 0)
  const whole = prNode(8, { commits: { nodes: [{ commit: { oid: 'a'.repeat(40), statusCheckRollup: { state: 'SUCCESS', contexts: { totalCount: 100, nodes: passing } } } }] } })
  assert.equal(parseBranches(response([{ oid: 'a'.repeat(40), prs: [whole] }]), [BRANCH]).reads[0].pr!.checks!.total, 100)
  assert.ok(branchQuery(1).includes('contexts(first: 100) { totalCount nodes {'), 'the branch query asks for totalCount')
})

test('F2.2: a markDue while a branch read is in flight survives that read: the next tick reads again', async () => {
  let release: () => void = () => {}
  const calls: string[][] = []
  const reader = new GithubReader({
    mode: 'runner', now,
    runner: async argv => {
      calls.push([...argv])
      if (calls.length === 1) await new Promise<void>(resolve => { release = resolve })
      return ok(response([{ oid: 'a'.repeat(40), prs: [] }]))
    },
  })
  reader.branchState('acme/widgets', BRANCH)
  const cycle = reader.cycleBranches()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.length, 1)
  reader.markDue(`acme/widgets#${BRANCH}`)
  release()
  await cycle
  assert.equal(reader.branchState('acme/widgets', BRANCH).state.status, 'read', 'the in-flight data is still stored')
  await reader.cycleBranches()
  assert.equal(calls.length, 2, 'the mark made mid-read forces a reread at the next tick')
  await reader.cycleBranches()
  assert.equal(calls.length, 2, 'and only once')
})

test('F2.2: RunBranchReader.invalidate during an in-flight local read keeps that read out of the cache', async () => {
  const { clone } = originAndClone()
  git(clone, 'checkout', '-q', '-b', BRANCH)
  commit(clone, 'one')
  let calls = 0
  let reader: RunBranchReader | null = null
  const counting: GitRunner = async (repo, args) => {
    calls += 1
    if (calls === 1) reader!.invalidate(clone, BRANCH)
    return runner(repo, args)
  }
  reader = new RunBranchReader(counting, now)
  await reader.read(clone, BRANCH, null)
  const first = calls
  await reader.read(clone, BRANCH, null)
  assert.ok(calls > first, 'the read that straddled the invalidate was not cached')
  const second = calls
  await reader.read(clone, BRANCH, null)
  assert.equal(calls, second, 'a read after the invalidate is cached as usual')
})
