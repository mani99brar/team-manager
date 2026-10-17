/**
 * The GitHub actions' pure model (docs/PRD_RUN_TEAMS.md 4.4 "Publish on GitHub" and 4.5 "Dialogs"). Pure: no React, no DOM.
 * - The panel's four states and their exact copy; a record's status word and tone; the outcome sentences.
 * - Each dialog's exact copy: the title, the visibility block (a 5 px warn band for a public repository or an unknown
 *   visibility, none for a private or internal one), the facts line, the commit preview heading, the typed confirmation
 *   (exact and case-sensitive, never prefilled) and the confirm button's words.
 * - The request: every POST carries the dialog's `request_id` and the actions' `state_token` from when it opened, and only
 *   the params the action's specs name.
 * The page never decides what is offered: an action is available exactly when the server says so, with its reason verbatim.
 */
import type { GithubAction, GithubActionId, GithubActionRecord, GithubParams, RunGithub, RunGithubActions } from '../../../contracts/projects/github.ts'
import type { Tone } from '../tone.ts'
import { parseReviewers, plural, short, unpublishedCount } from './model.ts'

// ---- Panel (4.4) -------------------------------------------------------------------------------------------------------

export const PANEL_COPY = {
  controlsOff: 'Run controls are off on this server, so nothing is published from this page. The commands below do the same by hand.',
  unpaired: 'Pair this browser in the Controls menu to publish from this page, or run the commands below.',
  actionsOff: 'GitHub actions are off. Start the dashboard with MD_MANAGER_GITHUB_ACTIONS=on to publish from this page; the commands below do the same by hand.',
} as const

export type PanelState = 'loading' | 'controls-off' | 'unpaired' | 'actions-off' | 'offered' | 'unreadable'

/** Which of the panel's states holds, from the controls status probe, the pairing and the actions read. */
export function panelState(controls: { mode: 'loading' | 'off' | 'on'; paired: boolean }, actions: RunGithubActions | null, problem: string | null): PanelState {
  if (controls.mode === 'loading') return 'loading'
  if (controls.mode === 'off') return 'controls-off'
  if (!controls.paired) return 'unpaired'
  if (actions === null) return problem === null ? 'loading' : 'unreadable'
  return actions.enabled ? 'offered' : 'actions-off'
}

/** The line under an action: what it publishes when offered, "Not offered: {reason}" when not. */
export const actionNote = (action: GithubAction): string => (action.available ? action.publishes : `Not offered: ${action.reason ?? 'the server gave no reason'}`)

const RECORD_TONE: Record<GithubActionRecord['status'], Tone> = { running: 'run', succeeded: 'ok', failed: 'fail', refused: 'warn', lost: 'idle' }

/** A record's status: running run, succeeded ok, failed fail, refused warn, lost idle; the word is the contract's own. */
export const recordTone = (status: GithubActionRecord['status']): { tone: Tone; word: string } => ({ tone: RECORD_TONE[status], word: status })

/** The label of the action a record ran, as the server names it. */
export function recordLabel(record: GithubActionRecord, actions: RunGithubActions | null): string {
  return actions?.actions.find(action => action.id === record.action)?.label ?? record.action.replace(/_/g, ' ')
}

/** The records the panel lists: newest first, at most five. */
export function recentRecords(actions: RunGithubActions | null, mine: GithubActionRecord | null): GithubActionRecord[] {
  const records = actions?.records ?? []
  const all = mine !== null && !records.some(record => record.record_id === mine.record_id) ? [mine, ...records] : records
  return [...all].sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, 5)
}

// ---- Outcomes ----------------------------------------------------------------------------------------------------------

export const STALE_SENTENCE = 'The branch or the pull request changed since this dialog opened. Close it and open it again to see the new facts.'

/** What the dialog says once the controller answered with a record. */
export function outcomeSentence(record: GithubActionRecord): string {
  switch (record.status) {
    case 'running': return 'The controller is running it; this takes up to a minute.'
    case 'succeeded': return 'Done. GitHub is read again within two minutes.'
    case 'failed': return `The command failed (exit ${record.exit_code ?? 'not recorded'}).`
    case 'refused': return `The controller refused it: ${(record.output_tail.at(-1) ?? 'no output was recorded').replace(/\.$/, '')}.`
    case 'lost': return 'The controller stopped answering before it finished; whether it ran is not recorded. Check GitHub before you run it again.'
  }
}

// ---- Dialogs (4.5) -----------------------------------------------------------------------------------------------------

export const COMMAND_NOTE = 'The controller checks the branch and the commit again before it runs git or gh.'
export const PR_BODY_CAPTION = 'Local paths are already removed. It includes the run\'s recorded Claude spend when there is one; delete that line if you prefer.'

export type Visibility = RunGithubActions['visibility']

/** The visibility block: a heading (bold) and a body, and whether it takes the warn band. */
export type VisibilityBlock = { band: boolean; heading: string | null; body: string }

export function visibilityBlock(id: GithubActionId, repo: string, visibility: Visibility, commits: number): VisibilityBlock {
  if (visibility === null) return { band: true, heading: null, body: 'The repository\'s visibility was not read, so treat it as public.' }
  if (visibility === 'PRIVATE') return { band: false, heading: null, body: `${repo} is private: what this publishes is visible to everyone with access to the repository.` }
  if (visibility === 'INTERNAL') return { band: false, heading: null, body: `${repo} is internal: what this publishes is visible to everyone with access to the repository.` }
  const heading = `${repo} is public.`
  if (id === 'push_branch') {
    return { band: true, heading, body: `After this push anyone on the internet can read these ${plural(commits, 'commit')}: their messages, their authors' names and email addresses, and every line they change. A push cannot be taken back: deleting the branch later does not remove copies already fetched or forked.` }
  }
  if (id === 'open_pr') return { band: true, heading, body: 'Anyone on the internet can read the title and the text below, and the pull request stays listed on the repository even if you close it.' }
  return { band: true, heading, body: 'Anyone on the internet can see this on the pull request.' }
}

/** Whether the dialog asks for the repository typed: the server's `typed_repo`, and always for an unknown visibility. */
export const typedConfirmation = (action: GithubAction, visibility: Visibility): boolean => action.confirm === 'typed_repo' || visibility === null

/** The typed name matches exactly, case-sensitively; a blank or missing repository never matches. */
export const typedMatches = (typed: string, repo: string | null): boolean => repo !== null && typed === repo

const prRef = (read: RunGithub | null) => (read?.pr ? `#${read.pr.number}` : 'the pull request')

/** The dialog's title. */
export function dialogTitle(id: GithubActionId, repo: string, read: RunGithub | null): string {
  switch (id) {
    case 'push_branch': return `Push the run branch to ${repo}`
    case 'open_pr': return `Open a draft pull request on ${repo}`
    case 'mark_ready': return `Mark ${prRef(read)} ready for review`
    case 'request_reviewers': return `Request reviewers on ${prRef(read)}`
  }
}

/** The one facts line under "What it does". */
export function factsLine(id: GithubActionId, repo: string, read: RunGithub | null): string {
  switch (id) {
    case 'push_branch': {
      const branch = read?.branch
      return `${branch?.name ?? 'The run branch'} at ${short(branch?.local_sha)} → ${read?.repo.remote ?? 'origin'} on github.com/${repo}. A plain push: never forced.`
    }
    case 'open_pr': return `From ${read?.branch.name ?? 'the run branch'} into ${read?.repo.default_branch ?? 'the default branch'}. Always a draft: GitHub asks no one to review until you mark it ready.`
    case 'mark_ready': {
      const requested = read?.pr?.requested_reviewers ?? []
      return `GitHub notifies the requested reviewers: ${requested.length === 0 ? 'nobody is requested yet' : requested.map(reviewer => reviewer.login).join(', ')}.`
    }
    case 'request_reviewers': return 'GitHub notifies each person, and every member of each team, now.'
  }
}

/** "Commits that become public (3)", or "visible" for a private or internal repository. */
export function previewHeading(visibility: Visibility, count: number): string {
  return `Commits that become ${visibility === 'PRIVATE' || visibility === 'INTERNAL' ? 'visible' : 'public'} (${count})`
}

export type DialogValues = { title: string; body: string; reviewers: string; typed: string }

/** The fields' first values: title and body from the server's `defaults`; reviewers and the typed name are never prefilled. */
export function initialDialogValues(action: GithubAction): DialogValues {
  return { title: action.defaults.title ?? '', body: action.defaults.body ?? '', reviewers: '', typed: '' }
}

/** The confirm button's words. */
export function confirmLabel(id: GithubActionId, repo: string, read: RunGithub | null, values: DialogValues): string {
  switch (id) {
    case 'push_branch': return `Push ${plural(read ? unpublishedCount(read.branch) : 0, 'commit')} to ${repo}`
    case 'open_pr': return 'Open draft pull request'
    case 'mark_ready': return 'Mark ready for review'
    case 'request_reviewers': return `Request ${plural(parseReviewers(values.reviewers).items.length, 'reviewer')}`
  }
}

const spec = (action: GithubAction, name: GithubAction['params'][number]['name']) => action.params.find(item => item.name === name)

/** The first thing that keeps the dialog's fields from being sent, or null when they are complete. */
export function fieldsProblem(action: GithubAction, values: DialogValues): string | null {
  const title = spec(action, 'title')
  if (title && title.kind === 'text') {
    if (values.title.trim().length < Math.max(1, title.min_length)) return 'Write a title.'
    if (values.title.length > title.max_length) return `The title is at most ${title.max_length} characters.`
  }
  const body = spec(action, 'body')
  if (body && body.kind === 'multiline') {
    if (values.body.trim().length < Math.max(1, body.min_length)) return 'Write the body.'
    if (values.body.length > body.max_length) return `The body is at most ${body.max_length} characters.`
  }
  const reviewers = spec(action, 'reviewers')
  if (reviewers && reviewers.kind === 'list') {
    const parsed = parseReviewers(values.reviewers, reviewers.max_items)
    if (parsed.problem !== null) return parsed.problem
    if (parsed.items.length === 0) return 'Name at least one reviewer.'
  }
  return null
}

/** The request's `params`: only what the action's specs name. */
export function buildGithubParams(action: GithubAction, values: DialogValues): GithubParams {
  const params: GithubParams = {}
  for (const item of action.params) {
    if (item.name === 'title') params.title = values.title
    else if (item.name === 'body') params.body = values.body
    else if (item.name === 'reviewers') params.reviewers = parseReviewers(values.reviewers, item.max_items).items
    else params.confirm_repo = values.typed
  }
  return params
}

/** Toggles a suggestion chip in the reviewers field (one per line). */
export function toggleReviewer(text: string, login: string): string {
  const items = text.split(/[\s,]+/).filter(item => item !== '')
  const present = items.some(item => item.toLowerCase() === login.toLowerCase())
  return (present ? items.filter(item => item.toLowerCase() !== login.toLowerCase()) : [...items, login]).join('\n')
}

/** Whether a suggestion is already in the field. */
export const hasReviewer = (text: string, login: string): boolean => text.split(/[\s,]+/).some(item => item.toLowerCase() === login.toLowerCase())
