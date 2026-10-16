import { stat } from 'node:fs/promises'
import { runGithubSchema, type PushState, type RunBranch, type RunGithub, type RunGithubState, type RunRepo } from '../contracts/projects/github.ts'
import { parseGithubRemote, type GitRunner } from './dispatchGit.ts'
import { GH_REASONS, type GithubReader } from './dispatchGithub.ts'
import { buildDigest } from './dispatchSteps.ts'
import { ProjectApiError, type RunStore } from './projects.ts'
import { ID_PATTERN } from './projectsConfig.ts'

/**
 * The run's GitHub read (docs/PRD_RUN_TEAMS.md "GitHub read"; contract `contracts/projects/github.ts`, `runGithubSchema`):
 * where a run's branch (`inputs.source_branch`) stands locally, against its remote-tracking ref and on GitHub.
 *
 * - **Local facts** (`readRunBranch`): read-only git through the injected `GitRunner` (the production `realGitRunner`: no
 *   shell, 5 s timeout, `GIT_TERMINAL_PROMPT=0`), cached 10 s per repository, branch, default branch and integrated commit
 *   (`RunBranchReader`). The branch name is checked against git's ref rules (`validBranchName`) before it reaches any argv,
 *   and every ref is passed fully qualified (`refs/heads/<b>`, `refs/remotes/origin/<b>`). Nothing fetches: the
 *   remote-tracking ref is as fresh as the last fetch or push.
 * - **GitHub facts** come from the timer-driven `GithubReader` branch keys (`owner/name#<branch>`); a request registers its
 *   key and answers from the cache, `pending` before the first read. Requests never call gh.
 * - **Source** (`createRunGithubSource`): the one object the route and the actions lane share. `read` assembles and validates
 *   the response; `markDue` drops the local cache and makes the branch key due at the next tick (after a push or a PR).
 *
 * No field carries an absolute path, a credential or raw git/gh output; reasons are the fixed texts below.
 */

export const RUN_GIT_REASONS = {
  repositoryNotFound: 'repository not found',
  notARepository: 'not a git repository',
  gitTimedOut: 'git timed out after 5 s',
  gitFailed: 'git failed',
  noRemote: 'the repository has no origin remote',
  notGithub: 'origin is not a GitHub remote',
} as const

/** The run-level GitHub reasons that are not the reader's own (`GH_REASONS`). */
export const RUN_GITHUB_REASONS = {
  noBranch: 'the run records no branch',
  invalidBranch: 'the run branch is not a valid git branch name',
} as const

const SHA = /^[0-9a-f]{7,40}$/
const UNPUBLISHED_LIMIT = 50
const LOCAL_TTL_MS = 10_000
const MAX_LOCAL_ENTRIES = 200

/**
 * Git's ref-name rules (git-check-ref-format) for a branch, a little stricter: at most 255 characters; no leading `-` or
 * `/`; no `..`, `//` or `@{`; no control character, space, `~ ^ : ? * [ \`, DEL; no component starting with `.` or ending
 * `.lock`; not ending `/` or `.`; not `@`. Anything else never reaches an argv.
 */
export function validBranchName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false
  if (name === '@' || name.startsWith('-') || name.startsWith('/')) return false
  if (name.endsWith('/') || name.endsWith('.')) return false
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false
  for (const component of name.split('/')) {
    if (component.startsWith('.') || component.endsWith('.lock')) return false
  }
  return true
}

/** The local half of `RunBranch` (GitHub's `github_sha` is filled from the reader). */
export type LocalBranch = Omit<RunBranch, 'github_sha'>

function blankBranch(name: string | null, integrated: string | null, pushState: PushState = 'unknown'): LocalBranch {
  return {
    name, local_sha: null, tracking_sha: null, push_state: pushState,
    ahead_of_remote: null, behind_remote: null, ahead_of_default: null, behind_default: null,
    unpublished: [], unpublished_more: 0, integrated_commit: integrated, contains_integrated: null,
  }
}

function toIso(value: string): string | null {
  const ms = Date.parse(value.trim())
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

/**
 * Reads the run branch's local facts. `branch` must already be valid (`validBranchName`); `defaultBranch` is checked the same
 * way (an invalid one is treated as absent); `integratedCommit` must be hex. Git failures leave the affected facts null and
 * the push state `unknown`, never a guess.
 */
export async function readRunBranch(run: GitRunner, repo: string, branch: string, defaultBranch: string | null, integratedCommit: string | null): Promise<LocalBranch> {
  const integrated = integratedCommit !== null && SHA.test(integratedCommit) ? integratedCommit : null
  if (!validBranchName(branch)) return blankBranch(branch, integrated)
  const def = defaultBranch !== null && validBranchName(defaultBranch) ? defaultBranch : null
  const text = async (args: readonly string[]): Promise<{ code: number; out: string }> => {
    const r = await run(repo, args)
    if (r.enoent || r.timedOut) return { code: -1, out: '' }
    return { code: r.code, out: r.stdout.trim() }
  }
  const sha = async (ref: string): Promise<string | null> => {
    const r = await text(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    return r.code === 0 && /^[0-9a-f]{40}$/.test(r.out) ? r.out : null
  }
  const counts = async (left: string, right: string): Promise<[number, number] | null> => {
    const r = await text(['rev-list', '--left-right', '--count', `${left}...${right}`])
    const m = /^(\d+)\s+(\d+)$/.exec(r.out)
    return r.code === 0 && m ? [Number(m[1]), Number(m[2])] : null
  }

  const localRef = `refs/heads/${branch}`
  const trackingRef = `refs/remotes/origin/${branch}`
  const defaultRef = def ? `refs/remotes/origin/${def}` : null
  const local_sha = await sha(localRef)
  const tracking_sha = await sha(trackingRef)
  const default_sha = defaultRef ? await sha(defaultRef) : null
  const result = blankBranch(branch, integrated)
  result.local_sha = local_sha
  result.tracking_sha = tracking_sha
  if (local_sha === null) {
    result.push_state = 'no_local_branch'
    return result
  }

  if (tracking_sha === null) {
    result.push_state = 'not_pushed'
  } else if (tracking_sha === local_sha) {
    result.push_state = 'up_to_date'
    result.ahead_of_remote = 0
    result.behind_remote = 0
  } else {
    const c = await counts(localRef, trackingRef)
    if (c) {
      result.ahead_of_remote = c[0]
      result.behind_remote = c[1]
      result.push_state = c[0] > 0 && c[1] > 0 ? 'diverged' : c[0] > 0 ? 'local_ahead' : c[1] > 0 ? 'remote_ahead' : 'up_to_date'
    }
  }

  if (defaultRef && default_sha) {
    const c = await counts(localRef, defaultRef)
    if (c) { result.ahead_of_default = c[0]; result.behind_default = c[1] }
  }

  // The commits a push would publish: on the run branch, on neither its remote branch nor the remote default.
  const exclude = [...(tracking_sha ? [trackingRef] : []), ...(defaultRef && default_sha ? [defaultRef] : [])]
  const total = await text(['rev-list', '--count', localRef, ...(exclude.length ? ['--not', ...exclude] : [])])
  if (total.code === 0 && /^\d+$/.test(total.out)) {
    const count = Number(total.out)
    if (count > 0) {
      const log = await text(['log', '--format=%H%x1f%s%x1f%an <%ae>%x1f%cI', '-n', String(UNPUBLISHED_LIMIT), localRef, ...(exclude.length ? ['--not', ...exclude] : [])])
      if (log.code === 0 && log.out !== '') {
        for (const line of log.out.split('\n')) {
          const parts = line.split('\x1f')
          if (parts.length < 4) continue
          const committed = toIso(parts[parts.length - 1])
          if (!/^[0-9a-f]{40}$/.test(parts[0]) || committed === null) continue
          result.unpublished.push({ sha: parts[0], subject: parts[1], author: parts.slice(2, -1).join('\x1f'), committed_at: committed })
        }
      }
      result.unpublished_more = Math.max(0, count - result.unpublished.length)
    }
  }

  if (integrated) {
    const r = await run(repo, ['merge-base', '--is-ancestor', integrated, localRef])
    result.contains_integrated = r.enoent || r.timedOut ? null : r.code === 0 ? true : r.code === 1 ? false : null
  }
  return result
}

/** The repository half: whether it is readable, its origin and default branch (origin/HEAD, else main, then master). */
export type LocalRepo = { status: RunRepo['status']; reason: string | null; ownerName: string | null; defaultBranch: string | null; hasOrigin: boolean }

export async function readRunRepo(run: GitRunner, repo: string): Promise<LocalRepo> {
  const fail = (reason: string): LocalRepo => ({ status: 'unavailable', reason, ownerName: null, defaultBranch: null, hasOrigin: false })
  try {
    await stat(repo)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return fail(code === 'ENOENT' || code === 'ENOTDIR' ? RUN_GIT_REASONS.repositoryNotFound : RUN_GIT_REASONS.gitFailed)
  }
  const probe = await run(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (probe.timedOut) return fail(RUN_GIT_REASONS.gitTimedOut)
  if (probe.enoent) return fail(RUN_GIT_REASONS.gitFailed)
  if (probe.code !== 0 || probe.stdout.trim() === '') return fail(RUN_GIT_REASONS.notARepository)

  const refExists = async (ref: string) => {
    const r = await run(repo, ['rev-parse', '--verify', '--quiet', ref])
    return !r.enoent && !r.timedOut && r.code === 0
  }
  let defaultBranch: string | null = null
  const originHead = await run(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  const head = originHead.stdout.trim()
  if (!originHead.enoent && originHead.code === 0 && head.startsWith('origin/')) defaultBranch = head.slice('origin/'.length)
  if (defaultBranch === null) {
    for (const candidate of ['main', 'master']) {
      if (await refExists(`refs/heads/${candidate}`) || await refExists(`refs/remotes/origin/${candidate}`)) { defaultBranch = candidate; break }
    }
  }
  if (defaultBranch !== null && !validBranchName(defaultBranch)) defaultBranch = null

  const remote = await run(repo, ['remote', 'get-url', 'origin'])
  const url = remote.stdout.trim()
  if (remote.enoent || remote.timedOut || remote.code !== 0 || url === '') {
    return { status: 'no_remote', reason: RUN_GIT_REASONS.noRemote, ownerName: null, defaultBranch, hasOrigin: false }
  }
  const ownerName = parseGithubRemote(url)
  if (ownerName === null) return { status: 'not_github', reason: RUN_GIT_REASONS.notGithub, ownerName: null, defaultBranch, hasOrigin: true }
  return { status: 'github', reason: null, ownerName, defaultBranch, hasOrigin: true }
}

/** Caches `readRunRepo` + `readRunBranch` for 10 s per (repository, branch, integrated commit). */
export class RunBranchReader {
  private readonly cache = new Map<string, { at: number; repo: LocalRepo; branch: LocalBranch | null }>()
  private readonly run: GitRunner
  private readonly now: () => number
  private readonly ttlMs: number

  constructor(run: GitRunner, now: () => number, ttlMs = LOCAL_TTL_MS) {
    this.run = run
    this.now = now
    this.ttlMs = ttlMs
  }

  private key(repo: string, branch: string | null, integrated: string | null, fallbackDefault: string | null): string {
    return `${repo}\0${branch ?? ''}\0${integrated ?? ''}\0${fallbackDefault ?? ''}`
  }

  /**
   * `branch` null (the run records none) or invalid reads only the repository. `fallbackDefault` is the default branch to
   * compare against when the repository has no origin/HEAD, main or master (GitHub's `defaultBranchRef`).
   */
  async read(repo: string, branch: string | null, integrated: string | null, fallbackDefault: string | null = null): Promise<{ repo: LocalRepo; branch: LocalBranch | null }> {
    const key = this.key(repo, branch, integrated, fallbackDefault)
    const t = this.now()
    const hit = this.cache.get(key)
    if (hit && t - hit.at < this.ttlMs) return { repo: hit.repo, branch: hit.branch }
    const localRepo = await readRunRepo(this.run, repo)
    let localBranch: LocalBranch | null = null
    if (branch !== null && validBranchName(branch) && localRepo.status !== 'unavailable') {
      const def = localRepo.defaultBranch ?? fallbackDefault
      localBranch = await readRunBranch(this.run, repo, branch, def, integrated)
    }
    if (this.cache.size >= MAX_LOCAL_ENTRIES) this.cache.clear()
    this.cache.set(key, { at: t, repo: localRepo, branch: localBranch })
    return { repo: localRepo, branch: localBranch }
  }

  /** Drops every cached read of the repository and branch (after a push the refs moved). */
  invalidate(repo: string, branch: string | null): void {
    const prefix = `${repo}\0${branch ?? ''}\0`
    for (const key of [...this.cache.keys()]) if (key.startsWith(prefix)) this.cache.delete(key)
  }
}

/** The shared run GitHub source: the route's read and the actions lane's read and refresh trigger. */
export type RunGithubSource = {
  read(projectId: string, workflowId: string, runId: string): Promise<RunGithub>
  markDue(projectId: string, workflowId: string, runId: string): void
}

function requireId(value: string, what: string): string {
  if (!ID_PATTERN.test(value)) {
    throw new ProjectApiError(400, 'INVALID_ID', `The ${what} ID must be 1-128 characters of letters, digits, ".", "_" or "-", starting with a letter or digit.`)
  }
  return value
}

export type RunGithubSourceOptions = {
  store: RunStore
  github: GithubReader
  branches: RunBranchReader
  now?: () => number
  warn?: (message: string, details: Record<string, unknown>) => void
}

/** Builds the source; the response is validated against `runGithubSchema` (a violation is a 500 `RESPONSE_INVALID`). */
export function createRunGithubSource(options: RunGithubSourceOptions): RunGithubSource {
  const { store, github, branches } = options
  const now = options.now ?? Date.now
  /** run key -> what its last read resolved, so `markDue` needs no run load. */
  const resolved = new Map<string, { repository: string; branch: string | null; ownerName: string | null }>()

  const read = async (projectId: string, workflowId: string, runId: string): Promise<RunGithub> => {
    const scope = store.scope(requireId(projectId, 'project'), requireId(workflowId, 'workflow'))
    const loaded = await store.loadRun(scope, requireId(runId, 'run'))
    const digest = buildDigest(loaded)
    const branchName = digest.source_branch
    const integrated = digest.integrated_commit !== null && SHA.test(digest.integrated_commit) ? digest.integrated_commit : null
    const repository = scope.project.repository

    const local = await branches.read(repository, branchName, integrated)
    const repoFacts = local.repo
    const ownerName = repoFacts.ownerName
    resolved.set(`${projectId}/${workflowId}/${runId}`, { repository, branch: branchName, ownerName })

    const repo: RunRepo = {
      status: repoFacts.status,
      reason: repoFacts.reason,
      owner_name: ownerName,
      url: ownerName ? `https://github.com/${ownerName}` : null,
      remote: repoFacts.hasOrigin ? 'origin' : null,
      default_branch: repoFacts.defaultBranch,
    }

    // GitHub: the reader's state for the branch key, or the fixed reason why there is none.
    const blankState = (status: RunGithubState['status'], reason: string): RunGithubState => ({
      status, reason, read_at: null, viewer_login: null, visibility: null, viewer_permission: null,
    })
    let githubState: RunGithubState
    let githubSha: string | null = null
    let pr: RunGithub['pr'] = null
    let earlier: RunGithub['earlier_prs'] = []
    if (repoFacts.status === 'unavailable') githubState = blankState('unavailable', GH_REASONS.gitNotRead)
    else if (ownerName === null) githubState = blankState('not_github', GH_REASONS.notGithub)
    else if (github.mode === 'off') githubState = blankState('off', GH_REASONS.off)
    else if (branchName === null || !validBranchName(branchName)) {
      const repoRead = github.repoFacts(ownerName)
      githubState = {
        ...blankState('unavailable', branchName === null ? RUN_GITHUB_REASONS.noBranch : RUN_GITHUB_REASONS.invalidBranch),
        viewer_login: github.viewerLogin, visibility: repoRead.visibility,
      }
    } else {
      const state = github.branchState(ownerName, branchName)
      githubState = state.state
      if (state.data) {
        githubSha = state.data.github_sha
        pr = state.data.pr
        earlier = state.data.earlier_prs
      }
    }

    // A default branch only GitHub knows still gives the ahead/behind counts a reference (the remote-tracking ref must exist).
    let localBranch = local.branch
    if (localBranch !== null && repoFacts.defaultBranch === null && ownerName !== null && branchName !== null) {
      const ghDefault = github.branchDefault(ownerName, branchName)
      if (ghDefault !== null) localBranch = (await branches.read(repository, branchName, integrated, ghDefault)).branch
    }
    const branchFacts: RunBranch = localBranch
      ? { ...localBranch, github_sha: githubSha }
      : { ...blankBranch(branchName, integrated), github_sha: githubSha }

    const payload: RunGithub = {
      contract_version: '1.0.0',
      project_id: projectId, workflow_id: workflowId, run_id: runId,
      read_at: new Date(now()).toISOString(),
      repo, github: githubState, branch: branchFacts, pr, earlier_prs: earlier,
    }
    const parsed = runGithubSchema.safeParse(payload)
    if (!parsed.success) {
      options.warn?.('Run GitHub payload violates the contract', { issues: parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join('.')}: ${issue.message}`) })
      throw new ProjectApiError(500, 'RESPONSE_INVALID', 'The run GitHub data could not be projected onto the API contract.')
    }
    return parsed.data
  }

  const markResolved = (entry: { repository: string; branch: string | null; ownerName: string | null }) => {
    branches.invalidate(entry.repository, entry.branch)
    if (entry.ownerName && entry.branch && validBranchName(entry.branch)) github.markDue(`${entry.ownerName}#${entry.branch}`)
  }

  const markDue = (projectId: string, workflowId: string, runId: string): void => {
    const known = resolved.get(`${projectId}/${workflowId}/${runId}`)
    if (known) { markResolved(known); return }
    // Never read yet: resolve it once (which registers the key), then mark it due. Failures are only logged.
    void read(projectId, workflowId, runId).then(() => {
      const entry = resolved.get(`${projectId}/${workflowId}/${runId}`)
      if (entry) markResolved(entry)
    }, error => options.warn?.('Run GitHub markDue could not resolve the run', { message: (error as Error).message }))
  }

  return { read, markDue }
}
