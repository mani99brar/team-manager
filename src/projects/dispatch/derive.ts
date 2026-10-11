/**
 * The dispatch pages' derived wording and grouping, without React so the unit tests import them (tests/unit/dispatch.test.ts):
 * the sync line against origin (docs/PRD_PROJECTS_DISPATCH.md section 5), the landing wording for a commit on neither ref
 * ([L2]), the rail order and badge words ([D6]), the Projects card's state word, the pull-request and issue grouping
 * ([D5], the mock-up's `ghColumn`) and the relative time that adds the year.
 *
 * Every function is pure and names its source: the viewer never claims a comparison the data does not hold. An unknown
 * landing is shown as unknown, never as false ([P9]); git that could not be read says so in words.
 */
import type { GitState, Issue, Landing, Pr } from './types.ts'

// ---- Sync wording (section 5, "Sync wording") -------------------------------------------------------------------------

/**
 * The core sync phrase, the same on cards and headers ([P1]): "2 ahead, 1 behind origin/main", "16 ahead of origin/main",
 * "level with origin/main", the no-local-branch and no-origin states, "shares its clone with <primary>" for a non-primary
 * project of a clone, and "git not read: <reason>" when git is unavailable. The "as of … updated here <time>" addendum is
 * `syncAsOf`, rendered beside it.
 */
export function syncPhrase(git: GitState, projectId: string, primaryName: string | null): string {
  if (git.status === 'unavailable') return `git not read: ${git.reason ?? 'git failed'}`
  if (git.clone_primary !== null && git.clone_primary !== projectId) {
    return `shares its clone with ${primaryName ?? git.clone_primary}`
  }
  const origin = git.origin
  if (origin === null) return 'not compared with origin'
  const branch = git.default_branch ?? 'the default branch'
  if (origin.compare === 'no_local_branch') return `origin/${branch} at ${origin.sha.slice(0, 7)}; no local ${branch} to compare`
  const ahead = origin.ahead ?? 0
  const behind = origin.behind ?? 0
  if (ahead > 0 && behind > 0) return `${ahead} ahead, ${behind} behind origin/${branch}`
  if (ahead > 0) return `${ahead} ahead of origin/${branch}`
  if (behind > 0) return `${behind} behind origin/${branch}`
  return `level with origin/${branch}`
}

/** The time addendum for a compared sync: the remote-tracking ref's reflog time, or that it was not recorded; null otherwise. */
export function syncAsOf(git: GitState): { ref: string; updatedAt: string | null } | null {
  if (git.status !== 'read' || git.origin === null || git.origin.compare !== 'compared') return null
  return { ref: git.origin.ref, updatedAt: git.origin.updated_at }
}

/**
 * The header's "same repo as …" addendum ([P28], V10): the other projects that share this clone's GitHub repository, named.
 * On the primary it names the worktree project(s); on a worktree project it names the primary. Null when none.
 */
export function sameRepoText(otherNames: readonly string[]): string | null {
  if (otherNames.length === 0) return null
  if (otherNames.length === 1) return `same repo as ${otherNames[0]}`
  const head = otherNames.slice(0, -1).join(', ')
  return `same repo as ${head} and ${otherNames[otherNames.length - 1]}`
}

/** "update time not recorded" when a compared sync has no reflog time, else the "as of …" wording is used instead (V10). */
export const UPDATE_TIME_NOT_RECORDED = 'update time not recorded'

/**
 * The "and N more" tail for the commits-ahead list (V6, [P33]): the server lists at most 50 of `ahead` commits, so when
 * `ahead` exceeds the listed count the pane says how many are not listed; null when every ahead commit is listed.
 */
export function commitsAheadMore(ahead: number, listed: number): string | null {
  const more = ahead - listed
  return more > 0 ? `and ${more} more` : null
}

/** The "Show N more" label for a group folded to its first `shown` of `total` items (V8); null when nothing is hidden. */
export function showMoreText(total: number, shown: number): string | null {
  const more = total - shown
  return more > 0 ? `Show ${more} more` : null
}

// ---- Landing wording ([L2], [P9]) ------------------------------------------------------------------------------------

/**
 * A landing's wording for one run: "on local <d>", "on origin/<d>", "not on local <d> or origin/<d>; integrated into
 * <source_branch>" when it is false on both refs (integration fast-forwards the source branch, not the default one), and
 * "unknown" where the ref or object is missing. Never "not landed".
 */
export function landingWording(landing: Pick<Landing, 'on_default' | 'on_origin'>, defaultBranch: string | null, sourceBranch: string | null): string {
  const d = defaultBranch ?? 'the default branch'
  if (landing.on_default === false && landing.on_origin === false) {
    return `not on local ${d} or origin/${d}; integrated into ${sourceBranch ?? 'its source branch'}`
  }
  const where: string[] = []
  if (landing.on_default === true) where.push(`on local ${d}`)
  else if (landing.on_default === null) where.push(`local ${d} unknown`)
  if (landing.on_origin === true) where.push(`on origin/${d}`)
  else if (landing.on_origin === null) where.push(`origin/${d} unknown`)
  if (landing.on_default === false) where.unshift(`not on local ${d}`)
  if (landing.on_origin === false) where.push(`not on origin/${d}`)
  return where.join(', ') || 'unknown'
}

// ---- Rail order and badge words ([D6]) -------------------------------------------------------------------------------

export type RailInfo = {
  projectId: string
  name: string
  /** Runs waiting on the operator (a question, a pane or an approval). */
  waits: number
  /** Paused runs that wait on nobody. */
  paused: number
  /** Running runs. */
  running: number
  /** The project's run state cannot be read at all. */
  allBad: boolean
  /** The newest run's last activity, in epoch ms; 0 when there are no runs. */
  lastActivity: number
  /** Commits ahead of origin on the clone's primary project only, else null (no "N unpushed" badge). */
  unpushed: number | null
}

/** Rail order: needs you, running, readable before unreadable, then by last activity ([D6]). */
export function railOrder<T extends RailInfo>(infos: readonly T[]): T[] {
  const needs = (info: RailInfo) => info.waits + info.paused
  return [...infos].sort((a, b) =>
    (needs(b) - needs(a)) || (b.running - a.running) || (Number(a.allBad) - Number(b.allBad)) || (b.lastActivity - a.lastActivity) || a.projectId.localeCompare(b.projectId))
}

/** A rail row's badge: "N waits on you", else "N paused", else "N running", else "N unpushed" on the clone's primary; null otherwise. */
export function railBadge(info: RailInfo): string | null {
  if (info.waits > 0) return `${info.waits} waits on you`
  if (info.paused > 0) return `${info.paused} paused`
  if (info.running > 0) return `${info.running} running`
  if (info.unpushed !== null && info.unpushed > 0) return `${info.unpushed} unpushed`
  return null
}

// ---- The Projects card state word (section 4.1) ----------------------------------------------------------------------

/** What each project tone reads as a single word on the card and the rail, for a project with one feature or none. */
const TONE_WORD: Record<string, string> = {
  warn: 'waiting', run: 'running', fail: 'failed', pause: 'paused', ok: 'succeeded', override: 'integrated', idle: 'idle',
}

/**
 * The card's state word: for a multi-feature project whose latest results are mixed, "N of M features <result> last" (for
 * example "1 of 3 features failed last"); otherwise the project's own one-word state. `allBad` reads "cannot be read".
 */
export function cardStateWord(input: { tone: string; waits: number; running: number; allBad: boolean; featureCount: number; worstLatestCount: number }): string {
  if (input.allBad) return 'cannot be read'
  if (input.waits > 0) return `${input.waits} waits on you`
  if (input.running > 0) return `${input.running} running`
  const word = TONE_WORD[input.tone] ?? 'idle'
  if (input.featureCount > 1) return `${input.worstLatestCount} of ${input.featureCount} features ${word} last`
  return word
}

// ---- Pull request and issue grouping ([D5], the mock-up's `ghColumn`) ------------------------------------------------

export type PrGroups = { related: Pr[]; mine: Pr[]; others: Pr[]; merged: Pr[] }

/**
 * Why a PR is "possibly related" ([L5], run 002, changing [D5]): its head branch equals the checkout branch or a run's
 * `source_branch`, or its base branch does and that base is not the project's default branch (so a project checked out on
 * its default branch does not match every PR by base). The match names itself: "head is <branch>" or "base is <branch>";
 * null when it is not related.
 */
export function prRelation(pr: Pick<Pr, 'head_ref' | 'base_ref'>, branches: ReadonlySet<string>, defaultBranch: string | null): { kind: 'head' | 'base'; branch: string } | null {
  if (branches.has(pr.head_ref)) return { kind: 'head', branch: pr.head_ref }
  if (branches.has(pr.base_ref) && pr.base_ref !== defaultBranch) return { kind: 'base', branch: pr.base_ref }
  return null
}

/** The wording that names a "possibly related" match: "head is <branch>" or "base is <branch>" ([L5]). */
export function relatedWhy(relation: { kind: 'head' | 'base'; branch: string }): string {
  return `${relation.kind} is ${relation.branch}`
}

/**
 * Groups the 20 most recently updated PRs ([P15]): "Possibly related" ([L5]: head equals the checkout or a run's source
 * branch, or base does when base is not the default branch); "Yours, open" (author equals `viewer_login`); "Others, open";
 * and "Merged in the last 14 days" among the 20 shown. A PR counted as related is in no other group.
 */
export function prGroups(prs: readonly Pr[], options: { branches: ReadonlySet<string>; viewerLogin: string | null; readAt: number; defaultBranch?: string | null }): PrGroups {
  const defaultBranch = options.defaultBranch ?? null
  const related = prs.filter(pr => prRelation(pr, options.branches, defaultBranch) !== null)
  const isRelated = new Set(related)
  const open = prs.filter(pr => pr.state === 'OPEN' && !isRelated.has(pr))
  const mine = options.viewerLogin === null ? [] : open.filter(pr => pr.author === options.viewerLogin)
  const isMine = new Set(mine)
  const others = open.filter(pr => !isMine.has(pr))
  const merged = prs.filter(pr => pr.state === 'MERGED' && pr.merged_at !== null && options.readAt - Date.parse(pr.merged_at) < 14 * 86_400_000 && !isRelated.has(pr))
  return { related, mine, others, merged }
}

export type IssueGroups = { assigned: Issue[]; people: Issue[]; botCount: number; botAuthors: string[] }

/**
 * Groups the newest 20 open issues: "Assigned to you" (an assignee equals `viewer_login`), "Newest from people", and the
 * bot authors folded into "N from bots among the newest 20".
 */
export function issueGroups(issues: readonly Issue[], options: { viewerLogin: string | null }): IssueGroups {
  const assigned = options.viewerLogin === null ? [] : issues.filter(issue => issue.assignees.includes(options.viewerLogin!))
  const isAssigned = new Set(assigned)
  const rest = issues.filter(issue => !isAssigned.has(issue))
  const people = rest.filter(issue => !issue.author_is_bot)
  const bots = rest.filter(issue => issue.author_is_bot)
  const botAuthors = [...new Set(bots.map(issue => issue.author))]
  return { assigned, people, botCount: bots.length, botAuthors }
}

// ---- Relative time with the year (section 4.3) -----------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const dayStart = (ms: number) => Date.UTC(new Date(ms).getUTCFullYear(), new Date(ms).getUTCMonth(), new Date(ms).getUTCDate())

/**
 * A GitHub time relative to when GitHub was read: "today", "yesterday", "N d ago" under a fortnight, "N wk ago" under two
 * months, else the date, with the year added when it differs from the read year (so an issue opened in an earlier year says
 * so). `readAt` is the overview's GitHub read time.
 */
export function relTime(iso: string, readAt: number): string {
  const at = Date.parse(iso)
  const days = Math.floor((dayStart(readAt) - dayStart(at)) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 14) return `${days} d ago`
  if (days < 61) return `${Math.floor(days / 7)} wk ago`
  const date = new Date(at)
  const label = `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`
  return date.getUTCFullYear() === new Date(readAt).getUTCFullYear() ? label : `${label} ${date.getUTCFullYear()}`
}
