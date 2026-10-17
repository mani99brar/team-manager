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
import { heredocDelimiter, parseReviewers, plural, shellQuote, short, unpublishedCount } from './model.ts'

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

/** Said above the offers when a later read of the actions failed and the ones shown are from an earlier read. */
export function staleActionsLine(actions: RunGithubActions | null, problem: string | null): string | null {
  if (actions === null || problem === null) return null
  return `Could not refresh the actions: ${problem.replace(/\.$/, '')}; showing the ones read earlier.`
}

/** The line under an action: what it publishes when offered, "Not offered: {reason}" when not. */
export const actionNote = (action: GithubAction): string => (action.available ? action.publishes : `Not offered: ${action.reason ?? 'the server gave no reason'}`)

const RECORD_TONE: Record<GithubActionRecord['status'], Tone> = { running: 'run', succeeded: 'ok', failed: 'fail', refused: 'warn', lost: 'idle' }

/** A record's status: running run, succeeded ok, failed fail, refused warn, lost idle; the word is the contract's own. */
export const recordTone = (status: GithubActionRecord['status']): { tone: Tone; word: string } => ({ tone: RECORD_TONE[status], word: status })

/**
 * The controller's `Unknown: ...` line of a failed record: a push or a pull request create that timed out and may have reached
 * GitHub (workflow/github.py exits 3; the server's 6-minute stop adds the same kind of line). The contract has no `unknown`
 * status, so such a record is `failed` with this line in its output; null for every other record.
 */
export function unknownLine(record: GithubActionRecord): string | null {
  if (record.status !== 'failed') return null
  return record.output_tail.find(line => line.startsWith('Unknown:')) ?? null
}

/** A record as the page shows it: an unknown outcome reads `unknown` in the warn tone, never as a plain failure. */
export function recordShown(record: GithubActionRecord): { tone: Tone; word: string } {
  return unknownLine(record) !== null ? { tone: 'warn', word: 'unknown' } : recordTone(record.status)
}

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

export const UNKNOWN_SENTENCE = 'The outcome is unknown: it may have been published. Check GitHub before you try again.'

/** What the dialog says once the controller answered with a record; a timed-out publish says its outcome is unknown. */
export function outcomeSentence(record: GithubActionRecord): string {
  if (unknownLine(record) !== null) return UNKNOWN_SENTENCE
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

/** `commits` is null while the branch facts are not read (or could not be): the block then says "these commits", never 0. */
export function visibilityBlock(id: GithubActionId, repo: string, visibility: Visibility, commits: number | null): VisibilityBlock {
  if (visibility === null) return { band: true, heading: null, body: 'The repository\'s visibility was not read, so treat it as public.' }
  if (visibility === 'PRIVATE') return { band: false, heading: null, body: `${repo} is private: what this publishes is visible to everyone with access to the repository.` }
  if (visibility === 'INTERNAL') return { band: false, heading: null, body: `${repo} is internal: what this publishes is visible to everyone with access to the repository.` }
  const heading = `${repo} is public.`
  if (id === 'push_branch') {
    return { band: true, heading, body: `After this push anyone on the internet can read these ${commits === null ? 'commits' : plural(commits, 'commit')}: their messages, their authors' names and email addresses, and every line they change. A push cannot be taken back: deleting the branch later does not remove copies already fetched or forked.` }
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
    case 'push_branch': return read ? `Push ${plural(unpublishedCount(read.branch), 'commit')} to ${repo}` : `Push the branch to ${repo}`
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
    if (utf8Bytes(values.body) > body.max_length) return `The body is at most ${body.max_length} bytes of UTF-8.`
  }
  const reviewers = spec(action, 'reviewers')
  if (reviewers && reviewers.kind === 'list') {
    const parsed = parseReviewers(values.reviewers, reviewers.max_items)
    if (parsed.problem !== null) return parsed.problem
    if (parsed.items.length === 0) return 'Name at least one reviewer.'
  }
  return null
}

/** A text's length in UTF-8 bytes, as the server counts the body (`Buffer.byteLength`). */
export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length

/** The body counter: "{n} of {max} characters", with " · {bytes} bytes" when multi-byte text makes the two differ. */
export function bodyCounter(body: string, max: number): string {
  const bytes = utf8Bytes(body)
  return `${body.length} of ${max} characters${bytes !== body.length ? ` · ${bytes} bytes` : ''}`
}

export const BODY_FILE_NOTE = 'The command writes the body to a temporary file first (the heredoc), since the controller reads it from a file.'
export const FILL_FIELDS_FIRST = 'Fill the fields first'

/** Why Copy is off while the command still holds a placeholder: each one named, as pasted into bash it is a redirection. */
export const placeholderReason = (placeholders: string[]): string => `The command still holds ${placeholders.join(', ')}, so it cannot be copied yet.`

/**
 * "The exact command" with the typed values filled in, as the server words the record's command (`githubDisplay`): the title as
 * one shell word `--title=…` and the reviewers as one comma-joined word. The body (open_pr) is written to a temporary file by a
 * quoted heredoc first, and `--body-file` names that file, so the pasted command opens the pull request with the real body.
 * Every value goes in through a replacer function, so a `$&`, `$'` or `$$` in it is inserted literally. `copyable` is false
 * while a field is incomplete or any `<…>` placeholder remains (pasted into bash, `<title>` is a redirection); `waiting` says
 * why, and is null when it is copyable.
 */
export function filledCommand(action: GithubAction, values: DialogValues): { text: string; copyable: boolean; hasBody: boolean; waiting: string | null } {
  let text = action.command
  // The placeholders the server's command holds; each one filled below is crossed off. The typed values are never scanned, so
  // a title like "Fix <div> rendering" does not read as a placeholder.
  const left = new Set(action.command.match(/<[^<>\s]+>/g) ?? [])
  const fill = (placeholder: string, from: string, word: string) => {
    if (!text.includes(from)) return
    text = text.replace(from, () => word)
    left.delete(placeholder)
  }
  const problem = fieldsProblem(action, values)
  if (spec(action, 'title') && values.title.trim() !== '') fill('<title>', '--title=<title>', shellQuote(`--title=${values.title}`))
  const reviewers = spec(action, 'reviewers')
  if (reviewers && reviewers.kind === 'list') {
    const parsed = parseReviewers(values.reviewers, reviewers.max_items)
    if (parsed.problem === null && parsed.items.length > 0) fill('<reviewers>', '<reviewers>', shellQuote(parsed.items.join(',')))
  }
  const hasBody = action.command.includes('--body-file <body>')
  if (spec(action, 'body') && hasBody && values.body.trim() !== '') {
    fill('<body>', '--body-file <body>', '--body-file "$body_file"')
    const delimiter = heredocDelimiter(values.body)
    const content = values.body.endsWith('\n') ? values.body : `${values.body}\n`
    text = `body_file=$(mktemp) && cat > "$body_file" <<'${delimiter}'\n${content}${delimiter}\n${text}`
  }
  const copyable = problem === null && left.size === 0
  return { text, copyable, hasBody, waiting: copyable ? null : problem !== null ? `${FILL_FIELDS_FIRST}. ${problem}` : placeholderReason([...left]) }
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
