import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { githubRepoReadSchema, type GithubRepoRead, type GithubState, type Issue, type Pr } from '../contracts/projects/dispatch.ts'
import {
  PERMISSIONS, VISIBILITIES, earlierPrSchema, runPrSchema,
  type RunCheck, type RunGithubState, type RunPr,
} from '../contracts/projects/github.ts'
import type { ExecFileLike } from './dispatchGit.ts'

/**
 * GitHub for the dispatch overview (PRD_PROJECTS_DISPATCH section 5, Appendix A.3, decisions.md [P6][P12][P18][P20]).
 * Timer-driven only: a read of every registered repository at start, then a one-minute tick that reads whichever is
 * due (older than the refresh window), one repository at a time with a 20 s timeout. Requests never trigger or wait
 * for a read; before a repository's first read its state is `pending`. The last good read is kept in memory and in
 * `MD_MANAGER_GITHUB_CACHE`; a failed refresh keeps status `read` with the data and sets `reason`. `MD_MANAGER_GITHUB=off`
 * means `off`; `MD_MANAGER_GITHUB_FIXTURE` replaces every `gh` call (read synchronously at construction) and writes no
 * cache. Reasons are the fixed texts of section 5; stderr, tokens and environment values never reach the response ([P14]).
 *
 * Run branches (docs/PRD_RUN_TEAMS.md "GitHub read"): a second key space, `owner/name#<branch>`, for the run GitHub view.
 * A request registers its key (and when it was last asked for) and answers from the cache, `pending` before the first read.
 * A 30 s branch tick reads the keys that are due (last attempt older than `MD_MANAGER_GITHUB_BRANCH_REFRESH_SECONDS`, default
 * 90, and asked for within the last 15 minutes): one GraphQL query per repository, an alias pair per branch, every branch
 * name passed as a GraphQL variable (never interpolated into the query text). `markDue(key)` makes a key due at the next
 * branch tick (the actions lane calls it after a push or a pull request). The cache and fixture files gain an optional
 * `branches` map keyed `owner/name#<branch>`; files without it still load.
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

const sha = z.string().regex(/^[0-9a-f]{7,40}$/)

/**
 * One run branch as GitHub reported it: the branch head, the pull request whose head it is (newest open, else newest; same
 * repository only) and the earlier ones, plus the repository facts the same query returns. Kept in memory, in the cache's
 * `branches` map and in the fixture's.
 */
export const githubBranchReadSchema = z.strictObject({
  read_at: z.iso.datetime().nullable(),
  visibility: z.enum(VISIBILITIES).nullable(),
  viewer_permission: z.enum(PERMISSIONS).nullable(),
  default_branch: z.string().min(1).nullable(),
  github_sha: sha.nullable(),
  pr: runPrSchema.nullable(),
  earlier_prs: z.array(earlierPrSchema).max(10),
})
export type GithubBranchRead = z.infer<typeof githubBranchReadSchema>

/** At most this many branches share one GraphQL query; more are read in further queries of the same tick. */
const BRANCHES_PER_QUERY = 10
/** A branch key is read only while someone asked for it within this window. */
const BRANCH_INTEREST_MS = 15 * 60_000
const BRANCH_TICK_MS = 30_000
/** The cache keeps at most this many branch reads (the most recently read). */
const MAX_CACHED_BRANCHES = 200

const GH_TIMEOUT_MS = 20_000
const MAX_BUFFER = 16 * 1024 * 1024

/**
 * The production gh runner: the executable (`MD_MANAGER_GH`, default `gh`), carrying a spread of `process.env` so gh
 * keeps its credentials (`GH_TOKEN`, `GH_CONFIG_DIR`, `XDG_CONFIG_HOME`, `HOME`, `PATH`; design-challenge notes 3 and 4).
 * `exec` is injectable for the spawn-option test and defaults to the real `execFile`; never a shell, 20 s timeout.
 */
export function realGhRunner(executable: string, timeoutMs = GH_TIMEOUT_MS, exec: ExecFileLike = execFile as unknown as ExecFileLike): GhRunner {
  return argv => new Promise<GhResult>(resolve => {
    exec(executable, [...argv], { timeout: timeoutMs, maxBuffer: MAX_BUFFER, env: { ...process.env } }, (error, stdout, stderr) => {
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

/** The per-branch fields of the branch query (aliased `b<i>` and `p<i>`); the variables `$q<i>` and `$h<i>` carry the names. */
function branchFields(index: number): string {
  return `b${index}: ref(qualifiedName: $q${index}) { target { oid } }
    p${index}: pullRequests(headRefName: $h${index}, first: 10, orderBy: {field: UPDATED_AT, direction: DESC}, states: [OPEN, MERGED, CLOSED]) {
      nodes {
        number title url state isDraft isCrossRepository
        author { login }
        headRefName baseRefName headRefOid updatedAt mergedAt reviewDecision mergeable
        comments { totalCount }
        reviewThreads(first: 100) { totalCount nodes { isResolved } }
        reviewRequests(first: 50) { nodes { requestedReviewer {
          __typename ... on User { login } ... on Team { slug organization { login } } ... on Bot { login } ... on Mannequin { login }
        } } }
        latestOpinionatedReviews(first: 50) { nodes { author { login } state submittedAt } }
        commits(last: 1) { nodes { commit { oid statusCheckRollup { state contexts(first: 100) { nodes {
          __typename ... on CheckRun { name status conclusion detailsUrl } ... on StatusContext { context state targetUrl }
        } } } } } }
      }
    }`
}

/** The branch query for `count` branches of one repository. Only variable references appear in it, never a branch name. */
export function branchQuery(count: number): string {
  const variables = ['$owner:String!', '$name:String!']
  const fields: string[] = []
  for (let i = 0; i < count; i += 1) {
    variables.push(`$q${i}:String!`, `$h${i}:String!`)
    fields.push(branchFields(i))
  }
  return `query(${variables.join(',')}){
  viewer { login }
  repository(owner:$owner,name:$name){
    visibility
    viewerPermission
    defaultBranchRef { name }
    ${fields.join('\n    ')}
  }
}`
}

/** `gh api graphql` argv for one repository's branches: the query text plus one `-f` raw-string variable per name. */
export function branchArgv(repo: string, branches: readonly string[]): string[] {
  const [owner, name] = repo.split('/')
  const argv = ['api', 'graphql', '-f', `query=${branchQuery(branches.length)}`, '-f', `owner=${owner}`, '-f', `name=${name}`]
  branches.forEach((branch, i) => { argv.push('-f', `q${i}=refs/heads/${branch}`, '-f', `h${i}=${branch}`) })
  return argv
}

type GqlBranchContext = {
  __typename?: string; name?: string; status?: string | null; conclusion?: string | null; detailsUrl?: string | null
  context?: string; state?: string | null; targetUrl?: string | null
}
type GqlBranchPr = {
  number: number; title?: string; url?: string; state?: string; isDraft?: boolean; isCrossRepository?: boolean
  author?: { login?: string | null } | null; headRefName?: string; baseRefName?: string; headRefOid?: string | null
  updatedAt?: string; mergedAt?: string | null; reviewDecision?: string | null; mergeable?: string | null
  comments?: { totalCount?: number }
  reviewThreads?: { totalCount?: number; nodes?: { isResolved?: boolean }[] }
  reviewRequests?: { nodes?: { requestedReviewer?: { __typename?: string; login?: string; slug?: string; organization?: { login?: string } | null } | null }[] }
  latestOpinionatedReviews?: { nodes?: { author?: { login?: string | null } | null; state?: string; submittedAt?: string | null }[] }
  commits?: { nodes?: { commit?: { oid?: string; statusCheckRollup?: { state?: string | null; contexts?: { nodes?: GqlBranchContext[] } } | null } }[] }
}

const FAIL = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'])
const PENDING = new Set(['QUEUED', 'IN_PROGRESS', 'PENDING', 'EXPECTED', 'WAITING', 'REQUESTED'])
const NEUTRAL = new Set(['NEUTRAL', 'STALE'])

/** The check bucket of one context: pass, fail, pending, skip or neutral (docs/PRD_RUN_TEAMS.md "GitHub read"). */
export function checkBucket(kind: RunCheck['kind'], status: string | null, conclusion: string | null): RunCheck['bucket'] {
  if (kind === 'check_run' && conclusion === null) return status === 'COMPLETED' ? 'neutral' : 'pending'
  const word = conclusion ?? ''
  if (word === 'SUCCESS') return 'pass'
  if (FAIL.has(word)) return 'fail'
  if (PENDING.has(word)) return 'pending'
  if (word === 'SKIPPED') return 'skip'
  if (NEUTRAL.has(word)) return 'neutral'
  return 'neutral'
}

const BUCKET_ORDER: Record<RunCheck['bucket'], number> = { fail: 0, pending: 1, pass: 2, skip: 2, neutral: 2 }

function mapRunChecks(rollup: { state?: string | null; contexts?: { nodes?: GqlBranchContext[] } } | null | undefined): RunPr['checks'] {
  if (!rollup) return null
  const items: RunCheck[] = []
  for (const node of rollup.contexts?.nodes ?? []) {
    if (node.__typename === 'CheckRun' && node.name) {
      const status = node.status ?? null
      const conclusion = node.conclusion ?? null
      items.push({ name: node.name, kind: 'check_run', status, conclusion, bucket: checkBucket('check_run', status, conclusion), url: node.detailsUrl ?? null })
    } else if (node.__typename === 'StatusContext' && node.context) {
      const conclusion = node.state ?? null
      items.push({ name: node.context, kind: 'status', status: null, conclusion, bucket: checkBucket('status', null, conclusion), url: node.targetUrl ?? null })
    }
  }
  items.sort((a, b) => BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket] || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const count = (bucket: RunCheck['bucket']) => items.filter(item => item.bucket === bucket).length
  const state = ['SUCCESS', 'FAILURE', 'PENDING', 'ERROR', 'EXPECTED'].includes(String(rollup.state)) ? rollup.state as NonNullable<RunPr['checks']>['state'] : null
  return { state, passing: count('pass'), failing: count('fail'), pending: count('pending'), skipped: count('skip'), total: items.length, items: items.slice(0, 100) }
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : null
}

function mapRunPr(node: GqlBranchPr): RunPr {
  const threads = node.reviewThreads
  const threadNodes = threads?.nodes ?? []
  const threadTotal = threads?.totalCount ?? threadNodes.length
  const reviewers: RunPr['requested_reviewers'] = []
  for (const request of node.reviewRequests?.nodes ?? []) {
    const r = request.requestedReviewer
    if (!r) continue
    if (r.__typename === 'Team' && r.slug) reviewers.push({ kind: 'team', login: r.organization?.login ? `${r.organization.login}/${r.slug}` : r.slug })
    else if (r.__typename === 'Bot' && r.login) reviewers.push({ kind: 'bot', login: r.login })
    else if ((r.__typename === 'User' || r.__typename === 'Mannequin') && r.login) reviewers.push({ kind: 'user', login: r.login })
  }
  const reviews: RunPr['latest_reviews'] = []
  for (const review of node.latestOpinionatedReviews?.nodes ?? []) {
    const state = oneOf(review.state, ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING'] as const)
    if (state === null) continue
    reviews.push({ author: review.author?.login || 'ghost', state, submitted_at: review.submittedAt ? iso(review.submittedAt) : null })
  }
  const commit = node.commits?.nodes?.[0]?.commit
  const headSha = node.headRefOid ?? commit?.oid ?? null
  return {
    number: node.number,
    title: node.title ?? '',
    url: node.url ?? '',
    state: oneOf(node.state, ['OPEN', 'MERGED', 'CLOSED'] as const) ?? 'OPEN',
    draft: Boolean(node.isDraft),
    author: node.author?.login || 'ghost',
    head_ref: node.headRefName ?? '',
    base_ref: node.baseRefName ?? '',
    head_sha: headSha && /^[0-9a-f]{7,40}$/.test(headSha) ? headSha : null,
    updated_at: iso(node.updatedAt),
    merged_at: node.mergedAt ? iso(node.mergedAt) : null,
    review_decision: oneOf(node.reviewDecision, ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'] as const),
    mergeable: oneOf(node.mergeable, ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] as const),
    comments: node.comments?.totalCount ?? 0,
    review_threads: threadTotal,
    unresolved_threads: threadNodes.length === threadTotal ? threadNodes.filter(thread => !thread.isResolved).length : null,
    requested_reviewers: reviewers.slice(0, 50),
    latest_reviews: reviews.slice(0, 50),
    checks: mapRunChecks(commit?.statusCheckRollup),
  }
}

/**
 * Parses one branch query response into a read per branch (in `branches` order) and the viewer login; throws on a shape it
 * cannot map. Cross-repository pull requests (forks whose head has the same name) are dropped; the chosen one is the newest
 * open, else the newest; the rest are `earlier_prs`, newest first, at most 10.
 */
export function parseBranches(stdout: string, branches: readonly string[]): { reads: GithubBranchRead[]; viewer_login: string | null } {
  const root = JSON.parse(stdout) as { data?: Record<string, unknown> }
  const data = (root.data ?? root) as { viewer?: { login?: string }; repository?: Record<string, unknown> | null }
  const repo = data.repository
  if (!repo) throw new Error('no repository in the response')
  const visibility = oneOf(repo.visibility, VISIBILITIES)
  const viewer_permission = oneOf(repo.viewerPermission, PERMISSIONS)
  const default_branch = (repo.defaultBranchRef as { name?: string } | null | undefined)?.name ?? null
  const reads = branches.map((_branch, i): GithubBranchRead => {
    if (!(`p${i}` in repo)) throw new Error(`alias p${i} is missing`)
    const ref = repo[`b${i}`] as { target?: { oid?: string } } | null | undefined
    const oid = ref?.target?.oid ?? null
    const nodes = ((repo[`p${i}`] as { nodes?: GqlBranchPr[] } | null)?.nodes ?? []).filter(node => node && node.isCrossRepository !== true)
    const prs = nodes.map(mapRunPr).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
    const chosen = prs.find(pr => pr.state === 'OPEN') ?? prs[0] ?? null
    const earlier_prs = prs.filter(pr => pr !== chosen).slice(0, 10).map(pr => ({ number: pr.number, title: pr.title, url: pr.url, state: pr.state, updated_at: pr.updated_at }))
    return githubBranchReadSchema.parse({
      read_at: null, visibility, viewer_permission, default_branch,
      github_sha: oid && /^[0-9a-f]{7,40}$/.test(oid) ? oid : null,
      pr: chosen, earlier_prs,
    })
  })
  return { reads, viewer_login: data.viewer?.login ?? null }
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

/**
 * `readAtMs` is the time of the last *good* read (for `read_at` and the restart cache); `attemptedAtMs` is the time
 * of the last *attempt*, success or not. `due()` uses `attemptedAtMs` so a failed or never-successful read waits the
 * whole refresh window before the next attempt, rather than retrying every tick ([S2]).
 */
type Entry = { data: GithubRepoRead | null; readAtMs: number | null; attemptedAtMs: number | null; failReason: string | null; attempted: boolean }

/** A run branch key's entry: as `Entry`, plus when a request last asked for it (only keys asked for recently are read). */
type BranchEntry = { data: GithubBranchRead | null; readAtMs: number | null; attemptedAtMs: number | null; failReason: string | null; attempted: boolean; requestedAtMs: number | null }

/** `owner/name#<branch>` into its repository and branch (owner/name never holds `#`). */
export function splitBranchKey(key: string): { repo: string; branch: string } | null {
  const at = key.indexOf('#')
  if (at <= 0 || at === key.length - 1) return null
  return { repo: key.slice(0, at), branch: key.slice(at + 1) }
}

const BLANK = {
  read_at: null, visibility: null, default_branch: null, pushed_at: null, head: null,
  open_prs: null, open_issues: null, prs: [], issues: [],
} satisfies Omit<GithubState, 'status' | 'reason' | 'repo'>

export type GithubReaderOptions = {
  mode: 'off' | 'runner' | 'fixture'
  now: () => number
  refreshMinutes?: number
  runner?: GhRunner
  fixture?: { viewer_login: string | null; repos: Record<string, GithubRepoRead>; branches?: Record<string, GithubBranchRead> }
  /** Minimum seconds between reads of one run branch key (`MD_MANAGER_GITHUB_BRANCH_REFRESH_SECONDS`, default 90). */
  branchRefreshSeconds?: number
  cachePath?: string
  /** Returns every registered GitHub repository key, for the start read and each tick (the registry reloader adds some). */
  discover?: () => Promise<string[]>
  warn?: (message: string, details: Record<string, unknown>) => void
}

export class GithubReader {
  private readonly entries = new Map<string, Entry>()
  private readonly branchEntries = new Map<string, BranchEntry>()
  private readonly branchRefreshMs: number
  private branchTimer: NodeJS.Timeout | null = null
  private branchCycling = false
  private viewerLoginValue: string | null = null
  private readonly refreshMs: number
  private timer: NodeJS.Timeout | null = null
  private cycling = false
  private readonly options: GithubReaderOptions
  /** Returns the current registry's GitHub keys; wired by `buildDispatch` so each tick follows the reloaded registry ([S3], [L9]). */
  private discoverFn?: () => Promise<string[]>

  constructor(options: GithubReaderOptions) {
    this.options = options
    this.discoverFn = options.discover
    this.refreshMs = (options.refreshMinutes ?? 15) * 60_000
    this.branchRefreshMs = (options.branchRefreshSeconds ?? 90) * 1000
    if (options.mode === 'fixture' && options.fixture) {
      this.viewerLoginValue = options.fixture.viewer_login
      for (const [key, data] of Object.entries(options.fixture.repos)) {
        const at = data.read_at ? Date.parse(data.read_at) : options.now()
        this.entries.set(key, { data, readAtMs: at, attemptedAtMs: at, failReason: null, attempted: true })
      }
      for (const [key, data] of Object.entries(options.fixture.branches ?? {})) {
        const at = data.read_at ? Date.parse(data.read_at) : options.now()
        this.branchEntries.set(key, { data, readAtMs: at, attemptedAtMs: at, failReason: null, attempted: true, requestedAtMs: null })
      }
    } else if (options.mode === 'runner' && options.cachePath) {
      this.loadCache(options.cachePath)
    }
  }

  /** `off`, `runner` or `fixture`, as configured. */
  get mode(): GithubReaderOptions['mode'] {
    return this.options.mode
  }

  get viewerLogin(): string | null {
    return this.options.mode === 'off' ? null : this.viewerLoginValue
  }

  private loadCache(path: string): void {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { viewer_login?: string | null; repos?: Record<string, unknown>; branches?: Record<string, unknown> }
      if (typeof parsed.viewer_login === 'string') this.viewerLoginValue = parsed.viewer_login
      for (const [key, value] of Object.entries(parsed.repos ?? {})) {
        const data = githubRepoReadSchema.safeParse(value)
        if (data.success) {
          const at = data.data.read_at ? Date.parse(data.data.read_at) : this.options.now()
          this.entries.set(key, { data: data.data, readAtMs: at, attemptedAtMs: at, failReason: null, attempted: true })
        }
      }
      // Older cache files have no `branches`; a branch read that no longer parses is dropped alone.
      const branches = parsed.branches && typeof parsed.branches === 'object' ? parsed.branches : {}
      for (const [key, value] of Object.entries(branches)) {
        const data = githubBranchReadSchema.safeParse(value)
        if (data.success && splitBranchKey(key)) {
          const at = data.data.read_at ? Date.parse(data.data.read_at) : this.options.now()
          this.branchEntries.set(key, { data: data.data, readAtMs: at, attemptedAtMs: at, failReason: null, attempted: true, requestedAtMs: null })
        }
      }
    } catch { /* a missing or unreadable cache is simply no prior reads */ }
  }

  private writeCache(): void {
    if (this.options.mode !== 'runner' || !this.options.cachePath) return
    const repos: Record<string, GithubRepoRead> = {}
    for (const [key, entry] of this.entries) if (entry.data) repos[key] = entry.data
    const branches: Record<string, GithubBranchRead> = {}
    const kept = [...this.branchEntries].filter(([, entry]) => entry.data !== null)
      .sort((a, b) => (b[1].readAtMs ?? 0) - (a[1].readAtMs ?? 0)).slice(0, MAX_CACHED_BRANCHES)
    for (const [key, entry] of kept) branches[key] = entry.data!
    try {
      mkdirSync(dirname(this.options.cachePath), { recursive: true })
      writeFileSync(this.options.cachePath, `${JSON.stringify({ viewer_login: this.viewerLoginValue, repos, branches }, null, 2)}\n`)
    } catch (error) {
      this.options.warn?.('GitHub cache could not be written', { message: (error as Error).message })
    }
  }

  /** Registers keys as pending (runner mode) so the tick reads them; fixture and off modes ignore unknown keys. */
  register(keys: readonly string[]): void {
    if (this.options.mode !== 'runner') return
    for (const key of keys) if (!this.entries.has(key)) this.entries.set(key, { data: null, readAtMs: null, attemptedAtMs: null, failReason: null, attempted: false })
  }

  private due(entry: Entry): boolean {
    return entry.attemptedAtMs === null || this.options.now() - entry.attemptedAtMs >= this.refreshMs
  }

  /**
   * Reads every due repository, one at a time (runner mode only). Called at start and on each tick; never by a request.
   * With `keys`, only those are considered: a repository missing from the latest discovery is not read, though its entry
   * and cached data are kept ([S3], [P12]). With no `keys` every known entry is considered (direct-call tests).
   */
  async refreshDue(keys?: readonly string[]): Promise<void> {
    if (this.options.mode !== 'runner' || !this.options.runner) return
    const candidates = keys ?? [...this.entries.keys()]
    for (const key of candidates) {
      const entry = this.entries.get(key)
      if (entry && this.due(entry)) await this.read(key, entry)
    }
  }

  private async read(key: string, entry: Entry): Promise<void> {
    const runner = this.options.runner!
    const result = await runner(githubArgv(key))
    entry.attempted = true
    entry.attemptedAtMs = this.options.now()
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

  /** The repository facts of the last repository read (visibility), for a run whose branch cannot be read. */
  repoFacts(repo: string): { visibility: GithubRepoRead['visibility'] } {
    if (this.options.mode === 'off') return { visibility: null }
    return { visibility: this.entries.get(repo)?.data?.visibility ?? null }
  }

  /** GitHub's default branch for the repository, from the last branch or repository read; null when none was read. */
  branchDefault(repo: string, branch: string): string | null {
    if (this.options.mode === 'off') return null
    return this.branchEntries.get(`${repo}#${branch}`)?.data?.default_branch ?? this.entries.get(repo)?.data?.default_branch ?? null
  }

  /**
   * The run GitHub state of one branch, from the cache only: registers the key (runner mode) and stamps when it was asked
   * for, so the branch tick reads it; `pending` before its first read; a failed refresh keeps `read` with the data and sets
   * `reason`; a failure with no data is `unavailable`. Visibility and permission come from the branch read, else the
   * repository read. Never calls gh.
   */
  branchState(repo: string, branch: string): { state: RunGithubState; data: GithubBranchRead | null } {
    const key = `${repo}#${branch}`
    const repoData = this.entries.get(repo)?.data ?? null
    const blank = (status: RunGithubState['status'], reason: string): RunGithubState => ({
      status, reason, read_at: null, viewer_login: this.viewerLogin, visibility: this.options.mode === 'off' ? null : repoData?.visibility ?? null, viewer_permission: null,
    })
    if (this.options.mode === 'off') return { state: blank('off', GH_REASONS.off), data: null }
    let entry = this.branchEntries.get(key)
    if (!entry) {
      if (this.options.mode === 'fixture') return { state: blank('unavailable', GH_REASONS.notInFixture), data: null }
      entry = { data: null, readAtMs: null, attemptedAtMs: null, failReason: null, attempted: false, requestedAtMs: null }
      this.branchEntries.set(key, entry)
    }
    entry.requestedAtMs = this.options.now()
    if (entry.data) {
      const data = entry.data
      return {
        state: {
          status: 'read', reason: entry.failReason,
          read_at: entry.readAtMs !== null ? new Date(entry.readAtMs).toISOString() : data.read_at,
          viewer_login: this.viewerLogin,
          visibility: data.visibility ?? repoData?.visibility ?? null,
          viewer_permission: data.viewer_permission,
        },
        data,
      }
    }
    if (entry.attempted && entry.failReason) return { state: blank('unavailable', entry.failReason), data: null }
    return { state: blank('pending', GH_REASONS.pending), data: null }
  }

  /** Makes a branch key due at the next branch tick and marks it asked for (after a push or a pull request). Never calls gh. */
  markDue(key: string): void {
    if (this.options.mode !== 'runner' || !splitBranchKey(key)) return
    const entry = this.branchEntries.get(key)
    if (entry) {
      entry.attemptedAtMs = null
      entry.requestedAtMs = this.options.now()
    } else {
      this.branchEntries.set(key, { data: null, readAtMs: null, attemptedAtMs: null, failReason: null, attempted: false, requestedAtMs: this.options.now() })
    }
  }

  private branchDue(entry: BranchEntry): boolean {
    const t = this.options.now()
    if (entry.requestedAtMs === null || t - entry.requestedAtMs > BRANCH_INTEREST_MS) return false
    return entry.attemptedAtMs === null || t - entry.attemptedAtMs >= this.branchRefreshMs
  }

  /**
   * Reads every due branch key (runner mode only): grouped by repository, one GraphQL query per repository (more when a
   * repository has more than ten due branches). Called by the branch tick; never by a request.
   */
  async refreshBranches(): Promise<void> {
    if (this.options.mode !== 'runner' || !this.options.runner) return
    const byRepo = new Map<string, string[]>()
    for (const [key, entry] of this.branchEntries) {
      const parts = splitBranchKey(key)
      if (!parts || !this.branchDue(entry)) continue
      const list = byRepo.get(parts.repo) ?? []
      list.push(parts.branch)
      byRepo.set(parts.repo, list)
    }
    for (const [repo, branches] of byRepo) {
      for (let i = 0; i < branches.length; i += BRANCHES_PER_QUERY) await this.readBranches(repo, branches.slice(i, i + BRANCHES_PER_QUERY))
    }
  }

  private async readBranches(repo: string, branches: readonly string[]): Promise<void> {
    const runner = this.options.runner!
    const result = await runner(branchArgv(repo, branches))
    const at = this.options.now()
    const entries = branches.map(branch => this.branchEntries.get(`${repo}#${branch}`)!)
    const fail = (reason: string) => { for (const entry of entries) { entry.attempted = true; entry.attemptedAtMs = at; entry.failReason = reason } }
    if (result.enoent) return fail(GH_REASONS.notInstalled)
    if (result.timedOut) return fail(GH_REASONS.timedOut)
    if (result.code !== 0) return fail(/auth login/i.test(result.stderr) ? GH_REASONS.notLoggedIn : `gh failed (exit ${result.code})`)
    let parsed: { reads: GithubBranchRead[]; viewer_login: string | null }
    try {
      parsed = parseBranches(result.stdout, branches)
    } catch {
      return fail(GH_REASONS.notUnderstood)
    }
    const readAt = new Date(at).toISOString()
    parsed.reads.forEach((read, i) => {
      const entry = entries[i]
      entry.attempted = true
      entry.attemptedAtMs = at
      entry.data = { ...read, read_at: readAt }
      entry.readAtMs = at
      entry.failReason = null
    })
    if (parsed.viewer_login !== null) this.viewerLoginValue = parsed.viewer_login
    this.writeCache()
  }

  /** One branch cycle; public so a test drives it with an injected clock instead of fake timers. */
  async cycleBranches(): Promise<void> {
    if (this.branchCycling) return
    this.branchCycling = true
    try {
      await this.refreshBranches()
    } catch (error) {
      this.options.warn?.('GitHub branch refresh failed', { message: (error as Error).message })
    } finally {
      this.branchCycling = false
    }
  }

  /** Sets the discovery used by the tick, after the store exists (`buildDispatch`); the store does not exist where `index.ts` builds the reader ([S3]). */
  setDiscover(discover: () => Promise<string[]>): void {
    this.discoverFn = discover
  }

  /**
   * One refresh cycle: discover the current registry's keys, register the new ones, and read whichever of *those* is
   * due. Public so a test can drive it with an injected clock instead of fake timers (design-challenge note 5). A
   * repository no longer discovered is left in place with its cached data but is not read ([S3], [P12]).
   */
  async cycle(): Promise<void> {
    if (this.cycling) return
    this.cycling = true
    try {
      if (this.discoverFn) {
        const keys = await this.discoverFn()
        this.register(keys)
        await this.refreshDue(keys)
      } else {
        await this.refreshDue()
      }
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
    this.branchTimer = setInterval(() => { void this.cycleBranches() }, BRANCH_TICK_MS)
    this.branchTimer.unref?.()
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    if (this.branchTimer) { clearInterval(this.branchTimer); this.branchTimer = null }
  }
}

/**
 * Resolves the GitHub reader options from the environment (Appendix A.3), the single place `index.ts` uses so the
 * fixture-file and `MD_MANAGER_GITHUB=off` paths are covered by a unit test rather than only the candidate browser
 * phase ([S5], [P36]). `off` disables every `gh` call; `MD_MANAGER_GITHUB_FIXTURE` names a JSON file read synchronously
 * and validated with the contract (no cache write); otherwise `gh` runs on a 20 s timeout and the last good reads are
 * cached under `MD_MANAGER_GITHUB_CACHE`. Discovery is wired later by `buildDispatch`, where the store exists.
 */
export function githubReaderOptions(env: NodeJS.ProcessEnv, now: () => number): GithubReaderOptions {
  const refreshMinutes = Number(env.MD_MANAGER_GITHUB_REFRESH_MINUTES ?? 15) || 15
  const branchSeconds = Number(env.MD_MANAGER_GITHUB_BRANCH_REFRESH_SECONDS ?? 90)
  const branchRefreshSeconds = Number.isFinite(branchSeconds) && branchSeconds > 0 ? branchSeconds : 90
  if (env.MD_MANAGER_GITHUB === 'off') return { mode: 'off', now }
  if (env.MD_MANAGER_GITHUB_FIXTURE) {
    const parsed = JSON.parse(readFileSync(resolve(env.MD_MANAGER_GITHUB_FIXTURE), 'utf8')) as { viewer_login?: string | null; repos?: Record<string, unknown>; branches?: Record<string, unknown> }
    const repos: Record<string, GithubRepoRead> = {}
    for (const [key, value] of Object.entries(parsed.repos ?? {})) repos[key] = githubRepoReadSchema.parse(value)
    // `branches` is optional: fixture files written before run branches still load.
    const branches: Record<string, GithubBranchRead> = {}
    for (const [key, value] of Object.entries(parsed.branches ?? {})) {
      if (!splitBranchKey(key)) throw new Error(`fixture branch key ${JSON.stringify(key)} is not owner/name#branch`)
      branches[key] = githubBranchReadSchema.parse(value)
    }
    return { mode: 'fixture', now, fixture: { viewer_login: parsed.viewer_login ?? null, repos, branches } }
  }
  const cachePath = env.MD_MANAGER_GITHUB_CACHE || join(env.HOME || homedir(), '.cache', 'md-manager', 'github.json')
  return { mode: 'runner', now, refreshMinutes, branchRefreshSeconds, runner: realGhRunner(env.MD_MANAGER_GH || 'gh'), cachePath }
}
