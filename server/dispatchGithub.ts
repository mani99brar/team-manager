import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { githubRepoReadSchema, type GithubRepoRead, type GithubState, type Issue, type Pr } from '../contracts/projects/dispatch.ts'

/**
 * GitHub for the dispatch overview (PRD_PROJECTS_DISPATCH section 5, Appendix A.3, decisions.md [P6][P12][P18][P20]).
 * Timer-driven only: a read of every registered repository at start, then a one-minute tick that reads whichever is
 * due (older than the refresh window), one repository at a time with a 20 s timeout. Requests never trigger or wait
 * for a read; before a repository's first read its state is `pending`. The last good read is kept in memory and in
 * `MD_MANAGER_GITHUB_CACHE`; a failed refresh keeps status `read` with the data and sets `reason`. `MD_MANAGER_GITHUB=off`
 * means `off`; `MD_MANAGER_GITHUB_FIXTURE` replaces every `gh` call (read synchronously at construction) and writes no
 * cache. Reasons are the fixed texts of section 5; stderr, tokens and environment values never reach the response ([P14]).
 */

export type GhResult = { code: number; stdout: string; stderr: string; timedOut: boolean; enoent: boolean }
export type GhRunner = (argv: readonly string[]) => Promise<GhResult>

export const GH_REASONS = {
  notInstalled: 'gh is not installed',
  notLoggedIn: 'gh is not logged in',
  timedOut: 'gh timed out after 20 s',
  notUnderstood: 'gh output was not understood',
  off: 'GitHub reads are turned off',
  notInFixture: 'not in the fixture',
  pending: 'not read yet',
  gitNotRead: 'git not read',
  notGithub: 'not a GitHub remote',
} as const

const GH_TIMEOUT_MS = 20_000
const MAX_BUFFER = 16 * 1024 * 1024

/** The production gh runner: the executable (`MD_MANAGER_GH`, default `gh`), inheriting `process.env` so gh finds its credentials (note 4). */
export function realGhRunner(executable: string, timeoutMs = GH_TIMEOUT_MS): GhRunner {
  return argv => new Promise<GhResult>(resolve => {
    execFile(executable, [...argv], { timeout: timeoutMs, maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
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

/** The one GraphQL query per repository (Appendix A.3): PRs by UPDATED_AT, open issues by CREATED_AT, totals, visibility, push and head. */
export const GITHUB_QUERY = `query($owner:String!,$name:String!){
  viewer { login }
  repository(owner:$owner,name:$name){
    visibility
    pushedAt
    defaultBranchRef { name target { oid ... on Commit { committedDate } } }
    openPRs: pullRequests(states: OPEN) { totalCount }
    openIssues: issues(states: OPEN) { totalCount }
    pullRequests(first: 20, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number title url state isDraft
        author { login __typename }
        headRefName baseRefName updatedAt mergedAt reviewDecision
        labels(first: 20) { nodes { name } }
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
          __typename ... on StatusContext { state } ... on CheckRun { status conclusion }
        } } } } } }
      }
    }
    issues(first: 20, states: OPEN, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        number title url
        author { login __typename }
        labels(first: 20) { nodes { name } }
        assignees(first: 20) { nodes { login } }
        createdAt updatedAt
      }
    }
  }
}`

export function githubArgv(repo: string): string[] {
  const [owner, name] = repo.split('/')
  return ['api', 'graphql', '-f', `query=${GITHUB_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`]
}

type GqlAuthor = { login?: string | null; __typename?: string }
type GqlContext = { __typename?: string; state?: string; status?: string; conclusion?: string }
type GqlLabels = { nodes?: { name: string }[] }
type GqlPr = {
  number: number; title?: string; url?: string; state?: string; isDraft?: boolean; author?: GqlAuthor | null
  headRefName?: string; baseRefName?: string; updatedAt?: string; mergedAt?: string | null; reviewDecision?: string | null
  labels?: GqlLabels; commits?: { nodes?: { commit?: { statusCheckRollup?: { contexts?: { nodes?: GqlContext[] } } | null } }[] }
}
type GqlIssue = {
  number: number; title?: string; url?: string; author?: GqlAuthor | null
  labels?: GqlLabels; assignees?: { nodes?: { login: string }[] }; createdAt?: string; updatedAt?: string
}
type GqlRepo = {
  visibility?: string; pushedAt?: string | null
  defaultBranchRef?: { name?: string; target?: { oid?: string; committedDate?: string } } | null
  openPRs?: { totalCount?: number }; openIssues?: { totalCount?: number }
  pullRequests?: { nodes?: GqlPr[] }; issues?: { nodes?: GqlIssue[] }
}

function iso(value: unknown): string {
  return new Date(String(value)).toISOString()
}

function mapAuthor(author: GqlAuthor | null | undefined): { author: string; author_is_bot: boolean } {
  if (!author || author.login == null) return { author: 'ghost', author_is_bot: false }
  return { author: author.login, author_is_bot: author.__typename === 'Bot' || author.login.endsWith('[bot]') }
}

function mapChecks(contexts: GqlContext[] | undefined): Pr['checks'] {
  if (!contexts) return null
  let passing = 0, failing = 0, pending = 0
  for (const context of contexts) {
    if (context.__typename === 'CheckRun') {
      if (context.status !== 'COMPLETED') pending += 1
      else if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(String(context.conclusion))) passing += 1
      else failing += 1
    } else {
      if (context.state === 'SUCCESS') passing += 1
      else if (context.state === 'PENDING' || context.state === 'EXPECTED') pending += 1
      else failing += 1
    }
  }
  return { passing, failing, pending }
}

/** Parses one `gh api graphql` response into a repository read and the viewer login; throws on a shape it cannot map. */
export function parseGithub(stdout: string): { read: GithubRepoRead; viewer_login: string | null } {
  const root = JSON.parse(stdout) as { data?: Record<string, unknown>; viewer?: unknown; repository?: unknown }
  const data = (root.data ?? root) as { viewer?: GqlAuthor; repository?: GqlRepo }
  const viewer = data.viewer
  const repo = data.repository
  if (!repo) throw new Error('no repository in the response')
  const target = repo.defaultBranchRef?.target
  const head = target?.oid ? { sha: String(target.oid), committed_at: iso(target.committedDate) } : null
  const prs: Pr[] = (repo.pullRequests?.nodes ?? []).map((node): Pr => ({
    number: node.number, title: node.title ?? '', url: node.url ?? '',
    state: (node.state ?? 'OPEN') as Pr['state'], draft: Boolean(node.isDraft), ...mapAuthor(node.author),
    head_ref: node.headRefName ?? '', base_ref: node.baseRefName ?? '',
    updated_at: iso(node.updatedAt), merged_at: node.mergedAt ? iso(node.mergedAt) : null,
    review_decision: (node.reviewDecision ?? null) as Pr['review_decision'],
    checks: mapChecks(node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes),
    labels: (node.labels?.nodes ?? []).map(label => label.name),
  }))
  const issues: Issue[] = (repo.issues?.nodes ?? []).map((node): Issue => ({
    number: node.number, title: node.title ?? '', url: node.url ?? '', ...mapAuthor(node.author),
    labels: (node.labels?.nodes ?? []).map(label => label.name),
    assignees: (node.assignees?.nodes ?? []).map(assignee => assignee.login),
    created_at: iso(node.createdAt), updated_at: iso(node.updatedAt),
  }))
  const read: GithubRepoRead = {
    read_at: null,
    visibility: (repo.visibility ?? null) as GithubRepoRead['visibility'],
    default_branch: repo.defaultBranchRef?.name ?? null,
    pushed_at: repo.pushedAt ? iso(repo.pushedAt) : null,
    head,
    open_prs: repo.openPRs?.totalCount ?? null,
    open_issues: repo.openIssues?.totalCount ?? null,
    prs, issues,
  }
  return { read, viewer_login: viewer?.login ?? null }
}

type Entry = { data: GithubRepoRead | null; readAtMs: number | null; failReason: string | null; attempted: boolean }

const BLANK = {
  read_at: null, visibility: null, default_branch: null, pushed_at: null, head: null,
  open_prs: null, open_issues: null, prs: [], issues: [],
} satisfies Omit<GithubState, 'status' | 'reason' | 'repo'>

export type GithubReaderOptions = {
  mode: 'off' | 'runner' | 'fixture'
  now: () => number
  refreshMinutes?: number
  runner?: GhRunner
  fixture?: { viewer_login: string | null; repos: Record<string, GithubRepoRead> }
  cachePath?: string
  /** Returns every registered GitHub repository key, for the start read and each tick (the registry reloader adds some). */
  discover?: () => Promise<string[]>
  warn?: (message: string, details: Record<string, unknown>) => void
}

export class GithubReader {
  private readonly entries = new Map<string, Entry>()
  private viewerLoginValue: string | null = null
  private readonly refreshMs: number
  private timer: NodeJS.Timeout | null = null
  private cycling = false
  private readonly options: GithubReaderOptions

  constructor(options: GithubReaderOptions) {
    this.options = options
    this.refreshMs = (options.refreshMinutes ?? 15) * 60_000
    if (options.mode === 'fixture' && options.fixture) {
      this.viewerLoginValue = options.fixture.viewer_login
      for (const [key, data] of Object.entries(options.fixture.repos)) {
        this.entries.set(key, { data, readAtMs: data.read_at ? Date.parse(data.read_at) : options.now(), failReason: null, attempted: true })
      }
    } else if (options.mode === 'runner' && options.cachePath) {
      this.loadCache(options.cachePath)
    }
  }

  get viewerLogin(): string | null {
    return this.options.mode === 'off' ? null : this.viewerLoginValue
  }

  private loadCache(path: string): void {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { viewer_login?: string | null; repos?: Record<string, unknown> }
      if (typeof parsed.viewer_login === 'string') this.viewerLoginValue = parsed.viewer_login
      for (const [key, value] of Object.entries(parsed.repos ?? {})) {
        const data = githubRepoReadSchema.safeParse(value)
        if (data.success) this.entries.set(key, { data: data.data, readAtMs: data.data.read_at ? Date.parse(data.data.read_at) : this.options.now(), failReason: null, attempted: true })
      }
    } catch { /* a missing or unreadable cache is simply no prior reads */ }
  }

  private writeCache(): void {
    if (this.options.mode !== 'runner' || !this.options.cachePath) return
    const repos: Record<string, GithubRepoRead> = {}
    for (const [key, entry] of this.entries) if (entry.data) repos[key] = entry.data
    try {
      mkdirSync(dirname(this.options.cachePath), { recursive: true })
      writeFileSync(this.options.cachePath, `${JSON.stringify({ viewer_login: this.viewerLoginValue, repos }, null, 2)}\n`)
    } catch (error) {
      this.options.warn?.('GitHub cache could not be written', { message: (error as Error).message })
    }
  }

  /** Registers keys as pending (runner mode) so the tick reads them; fixture and off modes ignore unknown keys. */
  register(keys: readonly string[]): void {
    if (this.options.mode !== 'runner') return
    for (const key of keys) if (!this.entries.has(key)) this.entries.set(key, { data: null, readAtMs: null, failReason: null, attempted: false })
  }

  private due(entry: Entry): boolean {
    return entry.readAtMs === null || this.options.now() - entry.readAtMs >= this.refreshMs
  }

  /** Reads every due repository, one at a time (runner mode only). Called at start and on each tick; never by a request. */
  async refreshDue(): Promise<void> {
    if (this.options.mode !== 'runner' || !this.options.runner) return
    for (const [key, entry] of this.entries) if (this.due(entry)) await this.read(key, entry)
  }

  private async read(key: string, entry: Entry): Promise<void> {
    const runner = this.options.runner!
    const result = await runner(githubArgv(key))
    entry.attempted = true
    if (result.enoent) { entry.failReason = GH_REASONS.notInstalled; return }
    if (result.timedOut) { entry.failReason = GH_REASONS.timedOut; return }
    if (result.code !== 0) { entry.failReason = /auth login/i.test(result.stderr) ? GH_REASONS.notLoggedIn : `gh failed (exit ${result.code})`; return }
    let parsed: { read: GithubRepoRead; viewer_login: string | null }
    try {
      parsed = parseGithub(result.stdout)
      const now = new Date(this.options.now()).toISOString()
      const read = githubRepoReadSchema.parse({ ...parsed.read, read_at: now })
      entry.data = read
      entry.readAtMs = this.options.now()
      entry.failReason = null
      if (parsed.viewer_login !== null) this.viewerLoginValue = parsed.viewer_login
      this.writeCache()
    } catch {
      entry.failReason = GH_REASONS.notUnderstood
    }
  }

  /** The overview's GitHub state for one project; `gitUnavailable` when the project's git could not be read, `repo` null for a non-GitHub remote. */
  state(repo: string | null, gitUnavailable: boolean): GithubState {
    if (gitUnavailable) return { status: 'unavailable', reason: GH_REASONS.gitNotRead, repo: null, ...BLANK }
    if (repo === null) return { status: 'not_github', reason: GH_REASONS.notGithub, repo: null, ...BLANK }
    if (this.options.mode === 'off') return { status: 'off', reason: GH_REASONS.off, repo, ...BLANK }
    const entry = this.entries.get(repo)
    if (!entry) {
      if (this.options.mode === 'fixture') return { status: 'unavailable', reason: GH_REASONS.notInFixture, repo, ...BLANK }
      this.register([repo])
      return { status: 'pending', reason: GH_REASONS.pending, repo, ...BLANK }
    }
    if (entry.data) return { status: 'read', reason: entry.failReason, repo, ...entry.data }
    if (entry.attempted && entry.failReason) return { status: 'unavailable', reason: entry.failReason, repo, ...BLANK }
    return { status: 'pending', reason: GH_REASONS.pending, repo, ...BLANK }
  }

  private async cycle(): Promise<void> {
    if (this.cycling) return
    this.cycling = true
    try {
      if (this.options.discover) this.register(await this.options.discover())
      await this.refreshDue()
    } catch (error) {
      this.options.warn?.('GitHub refresh cycle failed', { message: (error as Error).message })
    } finally {
      this.cycling = false
    }
  }

  /** Starts the one-minute tick and the read at start (runner mode only); the timer is unref'd so it never holds the process open. */
  start(): void {
    if (this.options.mode !== 'runner' || this.timer) return
    void this.cycle()
    this.timer = setInterval(() => { void this.cycle() }, 60_000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }
}
