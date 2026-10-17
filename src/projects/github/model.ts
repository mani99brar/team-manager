/**
 * The GitHub view's pure model (docs/PRD_RUN_TEAMS.md 4 "GitHub view"). Pure: no React, no DOM, no `.tsx` import.
 * - `githubSituation` is section 4.2's table, first matching row wins: the banner's tone and exact sentence, the switcher's
 *   suffix (`githubSuffix`, section 2) and the single next action.
 * - The cards' words (4.3): pull request pill, review decision, merge, checks, reviewers, conversation; the branch's push
 *   pill, shas, default-branch counts and integrated commit; the connection line.
 * - `handCommands` is the "Commands to run by hand" card (4.6): real values, shell-quoted, the project's checkout as the
 *   project page shows it (`~/dev/...`), never a placeholder; the reviewers command waits on its field, and the draft PR
 *   command inlines the run summary through a quoted heredoc.
 * - `summaryInput` maps what `RunView` holds into `RunSummaryInput` (4.3 "Input mapping"), with every free text passed
 *   through `redactSummaryText` (paths and credentials, as the server's `redactText`), so neither reaches the clipboard.
 * GitHub's state never changes the run's own status or verdict; nothing here guesses a fact the read does not hold.
 */
import type { GithubActionId, RunBranch, RunGithub, RunPr } from '../../../contracts/projects/github.ts'
import type { RunSummaryInput, RunSummaryLane } from '../../../contracts/projects/summary.ts'
import type { Teams } from '../../../contracts/projects/teams.ts'
import type { Sessions } from '../../../contracts/projects/sessions.ts'
import type { ReviewResult, RunDetail, RunInputs } from '../../../contracts/projects/v1.ts'
import { formatAgo } from '../time.ts'
import { checkTone, prTone, pushTone, type Suffix, type Tone, type ToneWord } from '../tone.ts'

/** A requested reviewer as the read serves it. */
export type RunReviewer = RunPr['requested_reviewers'][number]

// ---- Words --------------------------------------------------------------------------------------------------------------

/** "1 commit", "3 commits". */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`
}

/** The first seven characters of a sha, or "none". */
export const short = (sha: string | null | undefined): string => (sha ? sha.slice(0, 7) : 'none')

/** An age read against `now` ("3 h ago"); empty for a missing or unreadable time. */
export const ageOf = (iso: string | null | undefined, now: number): string => (iso ? formatAgo(iso, now) : '')

/** The commits a push would publish, counting the ones the read did not list. */
export const unpublishedCount = (branch: RunBranch): number => branch.unpublished.length + branch.unpublished_more

// ---- The situation (4.2) ---------------------------------------------------------------------------------------------

export const SITUATION_IDS = [
  'no-branch', 'no-remote', 'not-github', 'repo-unread', 'reads-off', 'gh-missing', 'gh-logged-out', 'gh-unread', 'pending',
  'no-local-branch', 'merged', 'closed', 'diverged', 'remote-ahead', 'conflicts', 'checks-failing', 'changes-requested',
  'pr-behind-local', 'approved', 'draft', 'in-review', 'not-pushed', 'local-ahead', 'pushed-no-pr', 'unknown',
] as const
export type SituationId = (typeof SITUATION_IDS)[number]

/** Where the banner's single next action points when no offered action takes its place. */
export type NextFallback = { kind: 'commands' } | { kind: 'check'; url: string } | { kind: 'pr'; number: number; url: string }

/** The banner's next action: the offered action's button when this browser may run it, else the fallback link. */
export type NextAction = { action: GithubActionId | null; fallback: NextFallback | null }

export type Situation = { id: SituationId; tone: Tone; sentence: string; suffix: string; next: NextAction }

export const GH_NOT_INSTALLED = 'gh is not installed'
export const GH_NOT_LOGGED_IN = 'gh is not logged in'

/** The situations whose commands card holds a command to run (the banner then links "See the command below ↓"). */
const COMMAND_SITUATIONS: ReadonlySet<SituationId> = new Set(['gh-missing', 'gh-logged-out', 'no-remote', 'diverged', 'remote-ahead', 'not-pushed', 'local-ahead', 'pushed-no-pr'])
/** The situations about a pull request: the banner links "Open #{n} on GitHub ↗". */
const PR_SITUATIONS: ReadonlySet<SituationId> = new Set(['merged', 'closed', 'conflicts', 'changes-requested', 'pr-behind-local', 'approved', 'draft', 'in-review'])

/** The action that moves each situation on, when the server offers it. */
const NEXT_ACTION: Partial<Record<SituationId, GithubActionId>> = {
  'not-pushed': 'push_branch', 'local-ahead': 'push_branch', 'pr-behind-local': 'push_branch', 'pushed-no-pr': 'open_pr', draft: 'mark_ready', 'in-review': 'request_reviewers',
}

function latestReview(pr: RunPr, state: RunPr['latest_reviews'][number]['state']) {
  const matching = pr.latest_reviews.filter(review => review.state === state)
  if (matching.length === 0) return null
  return matching.reduce((best, review) => ((review.submitted_at ?? '') > (best.submitted_at ?? '') ? review : best))
}

function checksPhrase(pr: RunPr): string {
  return pr.checks === null ? 'no checks on the head commit' : `checks: ${pr.checks.passing} passing, ${pr.checks.pending} pending`
}

function failingPhrase(pr: RunPr, checks: NonNullable<RunPr['checks']>): string {
  const names = checks.items.filter(item => item.bucket === 'fail').map(item => item.name)
  const shown = names.slice(0, 2)
  const more = checks.failing - shown.length
  const list = shown.length === 0 ? '' : `: ${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}`
  return `${pr.draft ? `Draft #${pr.number}` : `#${pr.number}`} has ${plural(checks.failing, 'failing check')}${list}.`
}

/**
 * The approved row's checks word: "passing" only when a check passed and none is pending, "pending" while one is, "none passed
 * (all skipped)" when every check was skipped or neutral, "not recorded" without checks (failing ones won an earlier row).
 */
export function approvedChecksWord(checks: RunPr['checks']): string {
  if (checks === null) return 'not recorded'
  if (checks.pending > 0) return 'pending'
  return checks.passing > 0 ? 'passing' : 'none passed (all skipped)'
}

function fallbackOf(id: SituationId, pr: RunPr | null): NextFallback | null {
  if (pr !== null && id === 'checks-failing') {
    const failing = pr.checks?.items.find(item => item.bucket === 'fail' && item.url !== null)
    return failing?.url ? { kind: 'check', url: failing.url } : { kind: 'pr', number: pr.number, url: pr.url }
  }
  if (pr !== null && PR_SITUATIONS.has(id)) return { kind: 'pr', number: pr.number, url: pr.url }
  return COMMAND_SITUATIONS.has(id) ? { kind: 'commands' } : null
}

/** Section 4.2: the first row whose condition holds. `now` reads the ages (merged, closed, changes requested). */
export function githubSituation(read: RunGithub, now: number = Date.parse(read.read_at)): Situation {
  const { repo, github, branch, pr } = read
  const owner = repo.owner_name ?? 'the repository'
  const make = (id: SituationId, tone: Tone, sentence: string, suffix: string): Situation =>
    ({ id, tone, sentence, suffix, next: { action: NEXT_ACTION[id] ?? null, fallback: fallbackOf(id, pr) } })
  if (branch.name === null) return make('no-branch', 'idle', 'This run records no branch, so there is nothing to compare with GitHub.', 'no branch')
  if (repo.status === 'no_remote') return make('no-remote', 'idle', 'This project has no Git remote, so the run branch exists only on this machine.', 'no remote')
  if (repo.status === 'not_github' || github.status === 'not_github') return make('not-github', 'idle', 'This project\'s remote is not on GitHub, so there is nothing here to read.', 'not GitHub')
  if (repo.status === 'unavailable') return make('repo-unread', 'idle', `The repository could not be read: ${repo.reason ?? 'no reason was recorded'}.`, 'not read')
  if (github.status === 'off') return make('reads-off', 'idle', 'GitHub reads are turned off on this server; the branch facts below are local only.', 'reads off')
  if (github.status === 'unavailable' && github.reason === GH_NOT_INSTALLED) return make('gh-missing', 'warn', `The gh CLI is not installed on this machine, so this page cannot read ${owner}.`, 'not read')
  if (github.status === 'unavailable' && github.reason === GH_NOT_LOGGED_IN) return make('gh-logged-out', 'warn', `gh is not signed in on this machine, so this page can neither read ${owner} nor publish to it.`, 'signed out')
  if (github.status === 'unavailable') return make('gh-unread', 'idle', `GitHub was not read: ${github.reason ?? 'no reason was recorded'}. The branch facts below are local only.`, 'not read')
  if (github.status === 'pending') return make('pending', 'idle', `Reading ${owner} for this branch; the first read lands within two minutes.`, 'reading')
  if (branch.push_state === 'no_local_branch') return make('no-local-branch', 'idle', `The run branch ${branch.name} is not in this repository, so there is nothing to push.`, 'no branch')
  if (pr?.state === 'MERGED') {
    const age = ageOf(pr.merged_at, now)
    return make('merged', 'ok', `#${pr.number} was merged into ${pr.base_ref}${age ? ` ${age}` : ''}.`, `#${pr.number} merged`)
  }
  if (pr?.state === 'CLOSED') {
    const age = ageOf(pr.updated_at, now)
    return make('closed', 'idle', `#${pr.number} was closed without merging${age ? ` ${age}` : ''}.`, `#${pr.number} closed`)
  }
  if (branch.push_state === 'diverged') return make('diverged', 'fail', 'The run branch and GitHub\'s copy have diverged; this page will not push over GitHub\'s commits.', 'diverged')
  if (branch.push_state === 'remote_ahead') {
    const behind = branch.behind_remote
    const lacks = behind === null ? 'commits the run branch lacks (how many is not recorded)' : `${plural(behind, 'commit')} the run branch lacks`
    return make('remote-ahead', 'warn', `GitHub's copy of the branch has ${lacks}; this page will not push over them.`, 'behind GitHub')
  }
  if (pr !== null) {
    if (pr.mergeable === 'CONFLICTING') return make('conflicts', 'fail', `#${pr.number} has conflicts with ${pr.base_ref}; GitHub cannot merge it as it is.`, `#${pr.number} conflicts`)
    if (pr.checks !== null && pr.checks.failing > 0) return make('checks-failing', 'fail', failingPhrase(pr, pr.checks), `#${pr.number} checks failing`)
    if (pr.review_decision === 'CHANGES_REQUESTED') {
      const review = latestReview(pr, 'CHANGES_REQUESTED')
      const age = ageOf(review?.submitted_at, now)
      const threads = pr.unresolved_threads !== null && pr.unresolved_threads > 0 ? `; ${plural(pr.unresolved_threads, 'unresolved thread')}` : ''
      return make('changes-requested', 'fail', `${review?.author ?? 'A reviewer'} asked for changes on #${pr.number}${age ? ` ${age}` : ''}${threads}.`, `#${pr.number} changes requested`)
    }
    if (branch.push_state === 'local_ahead') {
      const ahead = branch.ahead_of_remote
      if (ahead === null) return make('pr-behind-local', 'idle', `#${pr.number} is open, but commits on the run branch are not on GitHub yet (how many is not recorded).`, `#${pr.number} · commits to push`)
      return make('pr-behind-local', 'idle', `#${pr.number} is open, but ${plural(ahead, 'commit')} on the run branch ${ahead === 1 ? 'is' : 'are'} not on GitHub yet.`, `#${pr.number} · ${ahead} to push`)
    }
    if (pr.review_decision === 'APPROVED') {
      const review = latestReview(pr, 'APPROVED')
      const checks = approvedChecksWord(pr.checks)
      return make('approved', 'ok', `#${pr.number} is approved${review ? ` by ${review.author}` : ''}; checks ${checks}.`, `#${pr.number} approved`)
    }
    if (pr.draft) return make('draft', 'idle', `Draft #${pr.number} is open; ${checksPhrase(pr)}. A draft notifies no reviewer until you mark it ready.`, `#${pr.number} draft`)
    const from = pr.requested_reviewers.length > 0 ? ` from ${pr.requested_reviewers.map(reviewer => reviewer.login).join(', ')}` : ''
    return make('in-review', 'run', `#${pr.number} waits for review${from}; ${checksPhrase(pr)}.`, `#${pr.number} in review`)
  }
  if (branch.push_state === 'not_pushed') {
    const count = plural(unpublishedCount(branch), 'commit')
    const visibility = github.visibility
    const sentence = visibility === 'PRIVATE'
      ? `Not on GitHub yet: ${count} would be published to ${owner}, a private repository.`
      : visibility === 'INTERNAL'
        ? `Not on GitHub yet: ${count} would be published to ${owner}, an internal repository.`
        : `Not on GitHub yet: ${count} would become public on ${owner}.`
    return make('not-pushed', 'idle', sentence, 'not pushed')
  }
  if (branch.push_state === 'local_ahead') {
    const ahead = branch.ahead_of_remote
    if (ahead === null) return make('local-ahead', 'idle', 'GitHub has an older copy of the branch; commits are not pushed yet (how many is not recorded), and there is no pull request.', 'commits to push')
    return make('local-ahead', 'idle', `GitHub has an older copy of the branch; ${plural(ahead, 'commit')} ${ahead === 1 ? 'is' : 'are'} not pushed yet, and there is no pull request.`, `${ahead} to push`)
  }
  // Only GitHub's own sha says the branch is on GitHub: a remote-tracking ref or the local head is not that fact.
  if (branch.push_state === 'up_to_date' && branch.github_sha !== null) return make('pushed-no-pr', 'ok', `The branch is on GitHub at ${short(branch.github_sha)}; there is no pull request yet.`, 'pushed')
  return make('unknown', 'idle', 'Where the branch stands against GitHub is unknown: git could not compare it with the remote.', 'unknown')
}

/** The suffix's words for a screen reader: "#531 checks failing" is "pull request 531, checks failing". */
export function spokenSuffix(word: string): string {
  const match = /^#(\d+)(?:\s*·\s*|\s+)?(.*)$/.exec(word)
  if (match) return `pull request ${match[1]}${match[2] ? `, ${match[2]}` : ''}`
  return word === 'reading' ? 'reading GitHub' : word
}

/**
 * The GitHub segment's suffix in the run switcher (section 2): the situation's suffix in its tone; none when the server
 * does not serve the read (null).
 */
export function githubSuffix(runGithub: RunGithub | null): Suffix | null {
  if (runGithub === null) return null
  const situation = githubSituation(runGithub)
  return { tone: situation.tone, word: situation.suffix, spoken: spokenSuffix(situation.suffix) }
}

// ---- Cards (4.3) -------------------------------------------------------------------------------------------------------

/** The pull request's state pill: draft idle, open run, merged ok, closed idle. */
export function prStatePill(pr: Pick<RunPr, 'state' | 'draft'>): ToneWord {
  if (pr.state === 'MERGED') return { tone: 'ok', word: 'merged' }
  if (pr.state === 'CLOSED') return { tone: 'idle', word: 'closed' }
  return pr.draft ? { tone: 'idle', word: 'draft' } : { tone: 'run', word: 'open' }
}

/** The project page's `REVIEW_WORD` mapping: approved ok, changes requested fail, review required idle; null when none. */
export function reviewDecisionWord(decision: RunPr['review_decision']): ToneWord | null {
  if (decision === null) return null
  return prTone({ state: 'OPEN', draft: false, review_decision: decision })
}

/**
 * The merge line: "can merge", "conflicts with dev" (fail), "GitHub is still checking" (idle), or null ("not recorded"). A merged
 * pull request reads "merged {age}" and a closed one "closed": GitHub's mergeable flag says nothing about either.
 */
export function mergeWord(pr: Pick<RunPr, 'mergeable' | 'base_ref'> & Partial<Pick<RunPr, 'state' | 'merged_at'>>, now?: number): { tone: Tone | null; word: string } | null {
  if (pr.state === 'MERGED') {
    const age = now === undefined ? '' : ageOf(pr.merged_at, now)
    return { tone: 'ok', word: age ? `merged ${age}` : 'merged' }
  }
  if (pr.state === 'CLOSED') return { tone: 'idle', word: 'closed' }
  if (pr.mergeable === 'MERGEABLE') return { tone: null, word: 'can merge' }
  if (pr.mergeable === 'CONFLICTING') return { tone: 'fail', word: `conflicts with ${pr.base_ref}` }
  if (pr.mergeable === 'UNKNOWN') return { tone: 'idle', word: 'GitHub is still checking' }
  return null
}

/**
 * The Review row of the pull request card: the decision while the pull request is open; once it is merged or closed only a
 * decision a reviewer actually gave (approved, changes requested), never "review required". Null leaves the row out.
 */
export function reviewRow(pr: Pick<RunPr, 'state' | 'review_decision'>): { shown: boolean; word: ToneWord | null } {
  const word = reviewDecisionWord(pr.review_decision)
  if (pr.state === 'OPEN') return { shown: true, word }
  return pr.review_decision === 'APPROVED' || pr.review_decision === 'CHANGES_REQUESTED' ? { shown: true, word } : { shown: false, word: null }
}

/** "and {n} more checks not listed" when the counts hold more checks than the read listed (the contract caps the list). */
export function unlistedChecks(checks: NonNullable<RunPr['checks']>): string | null {
  const counted = checks.failing + checks.pending + checks.passing + checks.skipped
  const more = counted - checks.items.length
  return more > 0 ? `and ${plural(more, 'more check', 'more checks')} not listed` : null
}

export function checksLine(checks: NonNullable<RunPr['checks']>): string {
  return `${checks.failing} failing · ${checks.pending} pending · ${checks.passing} passing · ${checks.skipped} skipped`
}

/** One check row's glyph and word by its bucket. */
export const checkRowTone = (bucket: Parameters<typeof checkTone>[0]): ToneWord => checkTone(bucket)

/** A requested reviewer as a chip: a user by login, `team kleros/vea-maintainers`, `bot <login>`. */
export function reviewerChip(reviewer: RunReviewer): string {
  return reviewer.kind === 'team' ? `team ${reviewer.login}` : reviewer.kind === 'bot' ? `bot ${reviewer.login}` : reviewer.login
}

const REVIEW_STATE_WORD: Record<RunPr['latest_reviews'][number]['state'], string> = {
  APPROVED: 'approved', CHANGES_REQUESTED: 'changes requested', COMMENTED: 'commented', DISMISSED: 'dismissed', PENDING: 'pending',
}
export const reviewStateWord = (state: RunPr['latest_reviews'][number]['state']): string => REVIEW_STATE_WORD[state]

export function conversationLine(pr: Pick<RunPr, 'comments' | 'review_threads' | 'unresolved_threads'>): string {
  const unresolved = pr.unresolved_threads !== null && pr.unresolved_threads > 0 ? `, ${pr.unresolved_threads} unresolved` : ''
  return `${plural(pr.comments, 'comment')} · ${plural(pr.review_threads, 'review thread')}${unresolved}`
}

export function earlierPrsLine(earlier: RunGithub['earlier_prs']): string | null {
  if (earlier.length === 0) return null
  return `Earlier pull requests from this branch: ${earlier.map(item => `#${item.number} ${item.state.toLowerCase()}`).join(', ')}`
}

/** The head-commit note when the pull request shows another commit than the run branch. */
export function headCommitNote(pr: RunPr, branch: RunBranch): string | null {
  if (pr.head_sha === null || branch.local_sha === null || pr.head_sha === branch.local_sha) return null
  return `The pull request shows ${short(pr.head_sha)}; the run branch is at ${short(branch.local_sha)}.`
}

/** The branch's push pill (section 8 tones): not pushed, up to date, {k} ahead of GitHub, {k} behind GitHub, diverged, … */
export function pushPill(branch: RunBranch): ToneWord {
  const { tone } = pushTone(branch.push_state)
  switch (branch.push_state) {
    case 'local_ahead': return { tone, word: branch.ahead_of_remote === null ? 'ahead of GitHub' : `${branch.ahead_of_remote} ahead of GitHub` }
    case 'remote_ahead': return { tone, word: branch.behind_remote === null ? 'behind GitHub' : `${branch.behind_remote} behind GitHub` }
    case 'no_local_branch': return { tone, word: 'not in this repository' }
    default: return pushTone(branch.push_state)
  }
}

/** The three shas; GitHub's reads "not read" unless GitHub was read, and "none" only when a read found no branch there. */
export function shasLine(branch: RunBranch, githubStatus: RunGithub['github']['status']): string {
  const github = githubStatus === 'read' ? short(branch.github_sha) : 'not read'
  return `local ${short(branch.local_sha)} · remote-tracking ${short(branch.tracking_sha)} · GitHub ${github}`
}

/** A run that records no branch: only its integrated commit is said (no push pill, no shas, no commits heading). */
export function noBranchLine(branch: RunBranch): string {
  return branch.integrated_commit === null ? 'The run has no integrated commit.' : `The run's integrated commit is ${short(branch.integrated_commit)}.`
}

/** "3 ahead of dev, 0 behind"; null when git did not count. */
export function defaultBranchLine(branch: RunBranch, defaultBranch: string | null): string | null {
  if (branch.ahead_of_default === null || branch.behind_default === null || defaultBranch === null) return null
  return `${branch.ahead_of_default} ahead of ${defaultBranch}, ${branch.behind_default} behind`
}

export function integratedLine(branch: RunBranch): { tone: Tone | null; text: string } {
  if (branch.integrated_commit === null) return { tone: null, text: 'The run has no integrated commit.' }
  if (branch.contains_integrated === true) return { tone: null, text: `Contains the run's integrated commit ${short(branch.integrated_commit)}.` }
  if (branch.contains_integrated === false) return { tone: 'warn', text: `Does not contain the run's integrated commit ${short(branch.integrated_commit)}.` }
  return { tone: null, text: `Whether it contains the run's integrated commit ${short(branch.integrated_commit)} is not recorded.` }
}

export const BRANCH_FRESHNESS = 'Remote-tracking facts are as fresh as your last fetch or push; this page never fetches.'
export const CONNECTION_NOTE = 'md-manager reads GitHub through the gh CLI signed in on this machine. It keeps no GitHub token.'
export const NO_PR_TEXT = 'There is no pull request whose head is this branch.'

/**
 * The card in the pull request's place when the read holds none (4.3): "No pull request" only when GitHub was read; otherwise a
 * "Pull request" card that says it was not read and why, since a missing read is no evidence of a missing pull request. None at
 * all for a run with no branch, no remote or a remote that is not on GitHub (the banner already says there is nothing to read).
 */
export function noPrCard(read: RunGithub, situation: SituationId): { title: string; text: string; read: boolean } | null {
  if (situation === 'no-branch' || situation === 'no-remote' || situation === 'not-github') return null
  if (situation === 'repo-unread') return { title: 'Pull request', text: 'Not read: the repository could not be read.', read: false }
  const { github } = read
  if (github.status === 'read') return { title: 'No pull request', text: NO_PR_TEXT, read: true }
  if (github.status === 'off') return { title: 'Pull request', text: 'Not read: GitHub reads are off on this server.', read: false }
  if (github.status === 'pending') return { title: 'Pull request', text: 'Reading GitHub…', read: false }
  if (github.status === 'unavailable' && github.reason === GH_NOT_INSTALLED) return { title: 'Pull request', text: 'Not read: gh is not installed on this machine.', read: false }
  if (github.status === 'unavailable' && github.reason === GH_NOT_LOGGED_IN) return { title: 'Pull request', text: 'Not read: gh is not signed in on this machine.', read: false }
  if (github.status === 'unavailable') return { title: 'Pull request', text: `Not read: ${(github.reason ?? 'no reason was recorded').replace(/\.$/, '')}.`, read: false }
  return null
}
export const SHARE_TEXT = 'One Markdown text for a chat, an issue or the pull request. Facts this run did not record are left out; the draft pull request starts from the same text.'

/** "signed in to gh as … · permission maintain · remote origin · default branch dev", leaving out what was not read. */
export function connectionLine(read: RunGithub): string {
  const parts = [
    read.github.viewer_login ? `signed in to gh as ${read.github.viewer_login}` : 'gh sign-in not recorded',
    read.github.viewer_permission ? `permission ${read.github.viewer_permission.toLowerCase()}` : null,
    read.repo.remote ? `remote ${read.repo.remote}` : null,
    read.repo.default_branch ? `default branch ${read.repo.default_branch}` : null,
  ]
  return parts.filter((part): part is string => part !== null).join(' · ')
}

/** The visibility chip: a fact, not a state, so it is untoned. */
export const visibilityWord = (visibility: RunGithub['github']['visibility']): string | null => (visibility === null ? null : visibility.toLowerCase())

/**
 * The freshness lines (4.1): the banner's "GitHub read {age} · local git read {age}", each card's own line, and the failed
 * refresh line when the gh reader kept an older read.
 */
export function freshness(read: RunGithub, now: number): { banner: string; github: string | null; local: string; failed: string | null } {
  const githubAge = read.github.read_at ? formatAgo(read.github.read_at, now) : null
  const localAge = formatAgo(read.read_at, now)
  return {
    banner: `${githubAge ? `GitHub read ${githubAge}` : 'GitHub not read'} · local git read ${localAge}`,
    github: githubAge ? `read from GitHub ${githubAge}` : null,
    local: `local git, read ${localAge}`,
    failed: read.github.status === 'read' && read.github.reason !== null ? `Last read failed: ${read.github.reason}; showing the read from ${githubAge ?? 'an earlier time'}.` : null,
  }
}

/**
 * Said under the banner's freshness line while the read's background polls fail (the page keeps the last read it got): when the
 * latest one failed, why, and how old the read shown is, so old facts never pass for fresh ones.
 */
export function refreshFailedLine(failure: { message: string; failedAt: number | null; settledAt: number | null }, now: number): string {
  const when = failure.failedAt === null ? '' : ` ${formatAgo(new Date(failure.failedAt).toISOString(), now)}`
  const from = failure.settledAt === null ? 'an earlier time' : formatAgo(new Date(failure.settledAt).toISOString(), now)
  return `Last read failed${when}: ${failure.message.replace(/\.$/, '')}; showing the read from ${from}.`
}

// ---- Commands to run by hand (4.6) -----------------------------------------------------------------------------------

/** One shell word: bare when it holds only safe characters, else single-quoted (a `'` inside becomes `'\''`). */
export function shellQuote(value: string): string {
  if (value !== '' && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** A path as a shell word that keeps a leading `~/` unquoted, so the shell still expands it. */
export function shellPath(path: string): string {
  return path.startsWith('~/') && path.length > 2 ? `~/${shellQuote(path.slice(2))}` : shellQuote(path)
}

/** GitHub logins (up to 39 characters) and `org/team` slugs. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const TEAM = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/

/** Reads a reviewers field: one login or `org/team` per line (commas and spaces also separate); the first problem, if any. */
export function parseReviewers(text: string, maxItems = 15): { items: string[]; problem: string | null } {
  const items = text.split(/[\s,]+/).map(item => item.trim()).filter(item => item !== '')
  const bad = items.find(item => !LOGIN.test(item) && !TEAM.test(item))
  if (bad !== undefined) return { items, problem: `"${bad}" is not a GitHub login or an org/team name.` }
  const seen = new Set<string>()
  const repeated = items.find(item => { const key = item.toLowerCase(); if (seen.has(key)) return true; seen.add(key); return false })
  if (repeated !== undefined) return { items, problem: `${repeated} is listed twice.` }
  if (items.length > maxItems) return { items, problem: `At most ${maxItems} reviewers.` }
  return { items, problem: null }
}

export type HandCommand = {
  id: 'auth-status' | 'auth-login' | 'auth-setup-git' | 'remote' | 'push' | 'pr-create' | 'pr-ready' | 'add-reviewers' | 'log'
  /** The exact text Copy writes; null while it waits on a field (the reviewers), so no placeholder reaches the clipboard. */
  text: string | null
  /** Why Copy is off while `text` is null. */
  waiting?: string
  /** A line said after the command ("Then reload this page."). */
  after?: string
}

export const COMMANDS_CAPTION = 'Run these yourself in a terminal on this machine. They skip this page\'s checks; the page reads GitHub again within two minutes.'
export const NO_CHECKOUT_NOTE = 'Run the git commands in the project\'s checkout: the project page does not name it.'
export const SUMMARY_DELIMITER = 'MD_MANAGER_SUMMARY'

/** The heredoc's end word: `MD_MANAGER_SUMMARY`, numbered if the text itself holds that line. */
export function heredocDelimiter(body: string): string {
  const lines = new Set(body.split('\n'))
  let word = SUMMARY_DELIMITER
  for (let n = 2; lines.has(word); n += 1) word = `${SUMMARY_DELIMITER}_${n}`
  return word
}

/**
 * The commands card for one read (4.6): which commands show depends on the situation and the read's facts. `checkout` is
 * the project's checkout as the project page shows it (`~/dev/...`), or null when it names none (the git commands then run
 * in the current directory, said above them). `reviewers` is the field above the reviewers command.
 */
export function handCommands(read: RunGithub, situation: Situation, options: { checkout: string | null; summary: { title: string; markdown: string } | null; reviewers: readonly string[] }): HandCommand[] {
  const { checkout, summary, reviewers } = options
  const git = checkout === null ? 'git' : `git -C ${shellPath(checkout)}`
  const { repo, branch, pr } = read
  const remote = repo.remote ?? 'origin'
  if (situation.id === 'gh-missing' || situation.id === 'gh-logged-out') {
    return [
      { id: 'auth-status', text: 'gh auth status --hostname github.com' },
      { id: 'auth-login', text: 'gh auth login --hostname github.com --git-protocol https' },
      { id: 'auth-setup-git', text: 'gh auth setup-git --hostname github.com', after: 'Then reload this page.' },
    ]
  }
  if (situation.id === 'no-remote') return [{ id: 'remote', text: `${git} remote -v`, after: 'Add a GitHub remote yourself; this page never changes remotes.' }]
  const commands: HandCommand[] = []
  if (repo.status !== 'github' || branch.name === null || branch.push_state === 'no_local_branch') return commands
  const name = branch.name
  if ((branch.push_state === 'not_pushed' || branch.push_state === 'local_ahead') && branch.local_sha !== null) {
    commands.push({ id: 'push', text: `${git} push ${shellQuote(remote)} ${shellQuote(`${branch.local_sha}:refs/heads/${name}`)}` })
  }
  if (branch.push_state === 'diverged' || branch.push_state === 'remote_ahead') {
    const local = branch.local_sha ?? name
    commands.push({ id: 'log', text: `${git} log --oneline --left-right ${shellQuote(`${local}...${remote}/${name}`)}`, after: 'Resolve it yourself; this page offers nothing that overwrites GitHub\'s copy.' })
  }
  const owner = repo.owner_name
  if (owner === null || read.github.status !== 'read') return commands
  if (branch.push_state === 'up_to_date' && (pr === null || pr.state === 'CLOSED') && summary === null) {
    commands.push({ id: 'pr-create', text: null, waiting: 'Reading the run…' })
  } else if (branch.push_state === 'up_to_date' && (pr === null || pr.state === 'CLOSED') && summary !== null) {
    const delimiter = heredocDelimiter(summary.markdown)
    const base = repo.default_branch ? ` --base ${shellQuote(repo.default_branch)}` : ''
    const body = summary.markdown.endsWith('\n') ? summary.markdown : `${summary.markdown}\n`
    commands.push({ id: 'pr-create', text: `gh pr create --repo ${shellQuote(owner)} --head ${shellQuote(name)}${base} --draft --title ${shellQuote(summary.title)} --body-file - <<'${delimiter}'\n${body}${delimiter}` })
  }
  if (pr !== null && pr.state === 'OPEN') {
    if (pr.draft) commands.push({ id: 'pr-ready', text: `gh pr ready ${pr.number} --repo ${shellQuote(owner)}` })
    commands.push(reviewers.length === 0
      ? { id: 'add-reviewers', text: null, waiting: 'Name a reviewer first' }
      : { id: 'add-reviewers', text: `gh pr edit ${pr.number} --repo ${shellQuote(owner)} --add-reviewer ${shellQuote(reviewers.join(','))}` })
  }
  return commands
}

// ---- Run summary input (4.3 "Input mapping") -------------------------------------------------------------------------

/**
 * Every absolute or home path becomes `<path>`, as the server's `redactPaths` does (server/projects.ts): a path under `/srv` or
 * `/opt` is as private as one under `/home`. A URL's `//` and a relative `a/b` stay (the slash follows a letter or a slash).
 */
export function redactPaths(text: string): string {
  return text.replace(/(?:file:\/\/(?=\/)|(?<![\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Nd}._@~+/-]))(?:~(?:\/[\p{L}\p{M}\p{N}._@~+-]*)+|\/[\p{L}\p{M}\p{N}._@~+-]+(?:\/[\p{L}\p{M}\p{N}._@~+-]*)*)/gu, '<path>')
}

/**
 * Credential-shaped strings become `<redacted>`, the same patterns as the server's `redactCredentials` (server/projects.ts): GitHub
 * tokens, `sk-` keys, Slack tokens, a `Bearer` header, `token=`/`password=` assignments, a PEM block, and an upper-case secret
 * assignment keeps its name (`TELEGRAM_BOT_TOKEN=<redacted>`). Kept in step with the server until both import one module.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /-----BEGIN ([A-Z0-9 ]{1,64})-----[\s\S]*?(?:-----END \1-----|$)/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
  /\btoken=[A-Za-z0-9._~+/-]{12,}/g,
  /\bpassword=\S{6,}/g,
]
const SECRET_ASSIGNMENT = /\b((?:[A-Z][A-Z0-9_]*)?(?:SECRET[A-Z0-9_]*|TOKEN|KEY|PASSWORD|PASSWD))=(?:"[^"\n]*"|'[^'\n]*'|[^\s"']+)/g
export function redactCredentials(text: string): string {
  return CREDENTIAL_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, '<redacted>'), text).replace(SECRET_ASSIGNMENT, '$1=<redacted>')
}

/** The run summary's redaction (the server's `redactText`): paths first, then credentials. */
export const redactSummaryText = (text: string): string => redactCredentials(redactPaths(text))

/**
 * The Now headline without a leading status word: "Succeeded · no push performed" under the status "succeeded" becomes "no push
 * performed", so the summary's status line does not say it twice ("needs_attention" matches "Needs attention").
 */
export function headlineWithoutStatus(headline: string, status: string): string {
  const words = status.replace(/[_-]+/g, ' ').trim().toLowerCase()
  const lead = headline.trimStart()
  if (words === '' || !lead.toLowerCase().startsWith(words)) return headline
  const rest = lead.slice(words.length)
  if (rest.trim() === '') return ''
  const match = /^\s*·\s*/.exec(rest)
  return match ? rest.slice(match[0].length) : headline
}

/** One lane's agent team from the teams read: the worker session's workflows, agents and failed agents; null without one. */
export function laneTeam(teams: Teams | null, lane: string): RunSummaryLane['team'] {
  const session = teams?.sessions.find(item => item.role === 'worker' && item.lane === lane && item.records === 'found')
  if (!session) return null
  return {
    workflows: session.workflows.length,
    agents: session.workflows.reduce((sum, workflow) => sum + workflow.agent_count, 0),
    failed: session.workflows.reduce((sum, workflow) => sum + workflow.agents.filter(agent => agent.state === 'failed').length, 0),
  }
}

export type SummarySources = {
  detail: Pick<RunDetail, 'summary'>
  inputs: Pick<RunInputs, 'feature' | 'source_branch' | 'base_commit' | 'workers'> | null
  review: Pick<ReviewResult, 'verdict' | 'reviewers' | 'findings'> | null
  /** The Now headline as plain text; null while it is not derived. */
  headline: string | null
  teams: Teams | null
  sessions: Pick<Sessions, 'totals'> | null
  runGithub: RunGithub | null
  /** Each lane's worker report (its result's `summary`), by lane; a lane without one is not recorded. */
  reports: ReadonlyMap<string, string>
}

function shownHeadline(headline: string | null, status: string): string | null {
  if (headline === null) return null
  const rest = headlineWithoutStatus(headline, status)
  return rest === '' ? null : redactSummaryText(rest)
}

/** What `runSummaryMarkdown` reads, from what the run page already holds; free texts go through `redactSummaryText`. */
export function summaryInput(sources: SummarySources): RunSummaryInput {
  const { detail, inputs, review, headline, teams, sessions, runGithub, reports } = sources
  const open = { p0: 0, p1: 0, p2: 0 }
  for (const finding of review?.findings ?? []) {
    if (finding.disposition !== 'open') continue
    if (finding.severity === 'P0') open.p0 += 1
    else if (finding.severity === 'P1') open.p1 += 1
    else open.p2 += 1
  }
  const pr = runGithub?.pr ?? null
  const metered = sessions?.totals.metered_usd ?? 0
  return {
    runId: detail.summary.run_id,
    workflowId: detail.summary.workflow_id,
    feature: inputs ? redactSummaryText(inputs.feature) : null,
    status: detail.summary.status,
    headline: shownHeadline(headline, detail.summary.status),
    branch: inputs?.source_branch ?? runGithub?.branch.name ?? null,
    baseCommit: inputs?.base_commit ?? null,
    integratedCommit: runGithub?.branch.integrated_commit ?? null,
    review: review === null ? null : { verdict: review.verdict, reviewers: review.reviewers.map(entry => entry.reviewer_id), open },
    lanes: (inputs?.workers ?? []).map(worker => {
      const report = reports.get(worker.node_id)
      return { lane: worker.node_id, summary: report === undefined ? null : redactSummaryText(report), team: laneTeam(teams, worker.node_id) }
    }),
    costUsd: metered > 0 ? metered : null,
    pr: pr === null ? null : { number: pr.number, url: pr.url, state: pr.state, draft: pr.draft },
  }
}
