import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import type { GitState } from '../contracts/projects/dispatch.ts'

/**
 * Read-only git for the dispatch overview (PRD_PROJECTS_DISPATCH section 5). Every command runs through an injected
 * runner so tests drive it against temporary repositories; the real runner (`realGitRunner`) is `execFile('git', …)`
 * with `--no-optional-locks`, a 5 s timeout, no shell, and the no-lazy-fetch / no-locks / no-prompt environment, plus
 * `GIT_CEILING_DIRECTORIES` so a registered path that is not itself a repository never reports its parent's state
 * (design-challenge note 5). No field ever carries an absolute path ([P8]): the label is `~`-relative or a basename,
 * the clone is a hash, and reasons are the fixed texts of PRD section 5. The server never fetches, pushes or writes.
 */

export type GitResult = { code: number; stdout: string; stderr: string; timedOut: boolean; enoent: boolean }
export type GitRunner = (repo: string, args: readonly string[]) => Promise<GitResult>

/** A run of the project, for naming commits and listing landings. */
export type RunFact = { workflow_id: string; run_id: string; integrated_commit: string | null }

export type GitInput = {
  project_id: string
  repository: string
  /** The project's run ids, so a commit subject `Workflow <run-id>: …` names a known run. */
  run_ids: ReadonlySet<string>
  /** Each run with an integrated commit, for the landings list. */
  landings: readonly { workflow_id: string; run_id: string; sha: string }[]
}

export type GitRead = {
  state: GitState
  /** "owner/name" when origin parsed as GitHub; null with no origin remote or a non-GitHub one. */
  githubRepo: string | null
}

const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' }
const MAX_BUFFER = 8 * 1024 * 1024

/** The production runner: inherits `process.env` (so `HOME`/`PATH` reach git, design-challenge note 4) with the read-only flags added. */
export function realGitRunner(timeoutMs = 5000): GitRunner {
  return (repo, args) => new Promise<GitResult>(resolve => {
    const env = { ...process.env, ...GIT_ENV, GIT_CEILING_DIRECTORIES: dirname(repo) }
    execFile('git', ['--no-optional-locks', '-C', repo, ...args], { timeout: timeoutMs, env, maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
      const err = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null
      if (err) {
        if (err.code === 'ENOENT') return resolve({ code: -1, stdout: '', stderr: '', timedOut: false, enoent: true })
        const timedOut = err.killed === true || err.signal === 'SIGTERM'
        const code = typeof err.code === 'number' ? err.code : timedOut ? -1 : 1
        return resolve({ code, stdout: String(stdout), stderr: String(stderr), timedOut, enoent: false })
      }
      resolve({ code: 0, stdout: String(stdout), stderr: String(stderr), timedOut: false, enoent: false })
    })
  })
}

function nameValid(segment: string): boolean {
  return /^[A-Za-z0-9_.-]{1,100}$/.test(segment) && segment !== '.' && segment !== '..'
}

/** Parses `git remote get-url origin` into `owner/name` for the three accepted GitHub URL forms; null for anything else ([P10]). */
export function parseGithubRemote(url: string): string | null {
  const u = url.trim()
  const forms = [
    /^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/,
    /^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/,
    /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/,
  ]
  for (const form of forms) {
    const m = form.exec(u)
    if (m && nameValid(m[1]) && nameValid(m[2])) return `${m[1]}/${m[2]}`
  }
  return null
}

function repositoryLabel(repo: string, home: string): string {
  const hp = home.endsWith('/') ? home.slice(0, -1) : home
  if (hp && (repo === hp || repo.startsWith(`${hp}/`))) return `~${repo.slice(hp.length)}`
  return basename(repo) || repo
}

const RUN_SUBJECT = /^Workflow ([A-Za-z0-9][A-Za-z0-9._-]{0,127})[: ]/

function toIso(value: string): string | null {
  const ms = Date.parse(value.trim())
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

function unavailable(repo: string, home: string, reason: string, now: () => number): GitRead {
  return {
    githubRepo: null,
    state: {
      status: 'unavailable', reason, repository_label: repositoryLabel(repo, home),
      checkout: null, head: null, default_branch: null, clone_id: null, clone_primary: null,
      origin: null, ahead_commits: [], ahead_naming_run: 0, landings: [], read_at: new Date(now()).toISOString(),
    },
  }
}

/** Reads the git state of one project's repository. `clone_primary` is left null for the caller to fill once every clone_id is known. */
export async function readGitState(input: GitInput, home: string, run: GitRunner, now: () => number): Promise<GitRead> {
  const { repository: repo } = input
  const fail = (reason: string) => unavailable(repo, home, reason, now)

  try {
    await stat(repo)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return fail('repository not found')
    return fail('git failed')
  }

  const text = async (args: readonly string[]): Promise<{ code: number; out: string; timedOut: boolean }> => {
    const r = await run(repo, args)
    if (r.enoent) return { code: -1, out: '', timedOut: false }
    return { code: r.code, out: r.stdout.trim(), timedOut: r.timedOut }
  }

  const commonDir = await text(['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (commonDir.timedOut) return fail('git timed out after 5 s')
  if (commonDir.code !== 0 || commonDir.out === '') return fail('not a git repository')

  let clone_id: string
  try {
    const real = await realpath(commonDir.out)
    clone_id = createHash('sha256').update(real).digest('hex').slice(0, 12)
  } catch {
    clone_id = createHash('sha256').update(commonDir.out).digest('hex').slice(0, 12)
  }

  const checkoutRead = await text(['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const checkout = checkoutRead.code === 0 && checkoutRead.out !== '' ? checkoutRead.out : null

  const headRead = await text(['rev-parse', '--verify', '--quiet', 'HEAD'])
  const head = headRead.code === 0 && headRead.out !== '' ? headRead.out : null

  const refExists = async (ref: string): Promise<boolean> => (await text(['rev-parse', '--verify', '--quiet', ref])).code === 0
  const refSha = async (ref: string): Promise<string | null> => {
    const r = await text(['rev-parse', '--verify', '--quiet', ref])
    return r.code === 0 && r.out !== '' ? r.out : null
  }

  // Default branch: origin/HEAD, else main then master (local or remote-tracking), else null.
  let default_branch: string | null = null
  const originHead = await text(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  if (originHead.code === 0 && originHead.out.startsWith('origin/')) default_branch = originHead.out.slice('origin/'.length)
  if (default_branch === null) {
    for (const candidate of ['main', 'master']) {
      if (await refExists(`refs/heads/${candidate}`) || await refExists(`refs/remotes/origin/${candidate}`)) { default_branch = candidate; break }
    }
  }

  // Origin comparison.
  let origin: GitState['origin'] = null
  const ahead_commits: GitState['ahead_commits'] = []
  let ahead_naming_run = 0
  let localDefaultExists = false
  const originRef = default_branch ? `refs/remotes/origin/${default_branch}` : null
  const originSha = originRef ? await refSha(originRef) : null
  if (default_branch && originRef && originSha) {
    localDefaultExists = await refExists(`refs/heads/${default_branch}`)
    const reflog = await text(['reflog', 'show', '-1', '--date=iso-strict', '--format=%gd', originRef])
    let updated_at: string | null = null
    if (reflog.code === 0) {
      const at = /@\{(.+)\}/.exec(reflog.out)
      updated_at = at ? toIso(at[1]) : null
    }
    if (localDefaultExists) {
      const counts = await text(['rev-list', '--left-right', '--count', `refs/heads/${default_branch}...${originRef}`])
      const m = /^(\d+)\s+(\d+)$/.exec(counts.out)
      const ahead = m && counts.code === 0 ? Number(m[1]) : null
      const behind = m && counts.code === 0 ? Number(m[2]) : null
      origin = { ref: `origin/${default_branch}`, sha: originSha, updated_at, compare: 'compared', ahead, behind }
      if (ahead && ahead > 0) {
        const log = await text(['log', '--format=%H%x1f%cI%x1f%s', `${originRef}..refs/heads/${default_branch}`])
        if (log.code === 0 && log.out !== '') {
          const rows = log.out.split('\n').map(line => line.split('\x1f'))
          for (const [sha, cISO, ...rest] of rows) {
            const subject = rest.join('\x1f')
            const match = RUN_SUBJECT.exec(subject)
            const run_id = match && input.run_ids.has(match[1]) ? match[1] : null
            if (run_id !== null) ahead_naming_run += 1
            if (ahead_commits.length < 50) ahead_commits.push({ sha, subject, committed_at: toIso(cISO) ?? new Date(now()).toISOString(), run_id })
          }
        }
      }
    } else {
      origin = { ref: `origin/${default_branch}`, sha: originSha, updated_at, compare: 'no_local_branch', ahead: null, behind: null }
    }
  }

  // Landings against the local default branch and the origin ref.
  const ancestor = async (sha: string, ref: string): Promise<boolean | null> => {
    const r = await text(['merge-base', '--is-ancestor', sha, ref])
    if (r.timedOut) return null
    if (r.code === 0) return true
    if (r.code === 1) return false
    return null
  }
  const landings: GitState['landings'] = []
  for (const landing of input.landings) {
    const on_default = default_branch && localDefaultExists ? await ancestor(landing.sha, `refs/heads/${default_branch}`) : null
    const on_origin = originRef && originSha ? await ancestor(landing.sha, originRef) : null
    landings.push({ workflow_id: landing.workflow_id, run_id: landing.run_id, sha: landing.sha, on_default, on_origin })
  }

  // GitHub remote (parsing only; the GitHub reader does the network reads).
  let githubRepo: string | null = null
  const remote = await text(['remote', 'get-url', 'origin'])
  if (remote.code === 0 && remote.out !== '') githubRepo = parseGithubRemote(remote.out)

  const state: GitState = {
    status: 'read', reason: null, repository_label: repositoryLabel(repo, home),
    checkout, head, default_branch, clone_id, clone_primary: null,
    origin, ahead_commits, ahead_naming_run, landings, read_at: new Date(now()).toISOString(),
  }
  return { state, githubRepo }
}

/** Every registered project's GitHub repository key (owner/name), by parsing its origin remote; for the GitHub reader's start read and ticks. */
export async function discoverGithubRepos(projects: readonly { repository: string }[], run: GitRunner): Promise<string[]> {
  const keys = new Set<string>()
  for (const project of projects) {
    const r = await run(project.repository, ['remote', 'get-url', 'origin'])
    if (!r.enoent && r.code === 0) {
      const key = parseGithubRemote(r.stdout.trim())
      if (key) keys.add(key)
    }
  }
  return [...keys]
}

/** Caches each repository's read for 15 s, keyed by the repository path and the inputs that shape it (PRD section 5). */
export class GitReader {
  private readonly cache = new Map<string, { at: number; signature: string; read: GitRead }>()
  private readonly run: GitRunner
  private readonly home: string
  private readonly now: () => number
  private readonly ttlMs: number

  constructor(run: GitRunner, home: string, now: () => number, ttlMs = 15_000) {
    this.run = run
    this.home = home
    this.now = now
    this.ttlMs = ttlMs
  }

  private signature(input: GitInput): string {
    const runs = [...input.run_ids].sort().join(',')
    const lands = input.landings.map(l => `${l.workflow_id}/${l.run_id}:${l.sha}`).sort().join(',')
    return `${runs}|${lands}`
  }

  async read(input: GitInput): Promise<GitRead> {
    const signature = this.signature(input)
    const hit = this.cache.get(input.repository)
    const t = this.now()
    if (hit && hit.signature === signature && t - hit.at < this.ttlMs) return hit.read
    const read = await readGitState(input, this.home, this.run, this.now)
    this.cache.set(input.repository, { at: t, signature, read })
    return read
  }
}
