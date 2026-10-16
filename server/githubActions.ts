import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  GITHUB_ACTIONS_VERSION, GITHUB_ACTION_IDS, githubActionRecordSchema, type GithubAction, type GithubActionId, type GithubActionRecord, type GithubParamSpec,
  type GithubParams, type RunGithub, type RunGithubActions,
} from '../contracts/projects/github.ts'
import type { Teams } from '../contracts/projects/teams.ts'
import { runSummaryMarkdown, runSummaryTitle, type RunSummaryInput } from '../contracts/projects/summary.ts'
import { ControlsError } from './controlsGuard.ts'
import { readLogTail, redactText as redactSecrets, tailLines, type RunKey } from './controlsRunner.ts'
import { redactText, type LoadedRun } from './projects.ts'

/**
 * The run page's GitHub actions (docs/PRD_RUN_TEAMS.md "GitHub actions"; docs/PRD_RUN_CONTROLS.md, the GitHub family): the four
 * operator-confirmed actions on a run's branch, push it, open a draft pull request, mark it ready, request reviewers, offered from
 * the run's GitHub read (`RunGithub`, injected: the GitHub-read lane builds it from local git and the timer-driven gh reader) and
 * the run's status. Like every run control each maps to one fixed controller argv, `$PY -m workflow github <action> <run> --repo
 * <repository> ... --by operator` (PRD_RUN_CONTROLS principle 1): the server never runs git or gh for a write, and the controller
 * checks the branch, sha and pull request again (workflow/github.py). This module holds the pure parts the routes in
 * `controls.ts` use (they live in the run-control scope, so the browser guards and the pairing token apply): the offers, the
 * state token, the parameter checks, the argv and its redacted display, the default title and body, and the records
 * (`<MD_MANAGER_CONTROLS_STATE>/<project>/<workflow>/<run>.github.jsonl`). The actions are off unless the dashboard runs with
 * `MD_MANAGER_GITHUB_ACTIONS=on`; off, every action is unavailable with that reason.
 */

/** What the controls routes receive to read a run's GitHub facts and to ask for a fresh read after an action. */
export type GithubSource = {
  read(projectId: string, workflowId: string, runId: string): Promise<RunGithub>
  markDue(projectId: string, workflowId: string, runId: string): void
  /** Logins of the authors of the repository's recent pull requests in the dispatch cache, when the source has them. */
  recentAuthors?(projectId: string): Promise<string[]> | string[]
}

export const GITHUB_ACTIONS_OFF = 'GitHub actions are off on this dashboard: start it with MD_MANAGER_GITHUB_ACTIONS=on'
export const GITHUB_READ_MISSING = 'This dashboard has no run GitHub read to offer actions from'
export const GITHUB_READ_FAILED = 'The run\'s GitHub facts could not be read; reload the page'

export const TITLE_MAX = 256
export const BODY_MAX = 60000
export const REVIEWERS_MAX = 15
export const SUGGESTIONS_MAX = 30
const PROTECTED = new Set(['main', 'master', 'dev', 'develop'])
const WRITERS = new Set(['ADMIN', 'MAINTAIN', 'WRITE'])
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const TEAM = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/
const GITHUB_URL = /https:\/\/github\.com\/\S+/

/** Whether `value` is a GitHub login or an `org/team` slug, as the controller checks it. */
export function isReviewerName(value: string): boolean {
  return LOGIN.test(value) || TEAM.test(value)
}

/** A branch name git would accept under refs/heads (a conservative subset of check-ref-format); the controller checks it again. */
export function isBranchName(value: string | null): value is string {
  if (!value || value.length > 255 || value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.') || value.endsWith('.lock')) return false
  if (/\.\.|@\{|\/\/|\/\.|[\s~^:?*[\\]/.test(value) || [...value].some(char => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)) return false
  return value !== '@'
}

// ---- The state token ----------------------------------------------------------------------------------------------------

/** A digest of the facts the offers depend on: the branch shas and the pull request. A push or a new PR changes it. */
export function githubStateToken(read: RunGithub | null, runStatus: string): string {
  const facts = read === null ? null : [
    read.branch.local_sha, read.branch.tracking_sha, read.branch.github_sha, read.branch.push_state,
    read.pr ? [read.pr.number, read.pr.state, read.pr.draft, read.pr.head_sha] : null, read.repo.owner_name, read.github.visibility,
  ]
  return `gh-${createHash('sha256').update(JSON.stringify([facts, runStatus])).digest('hex').slice(0, 32)}`
}

// ---- Offers ---------------------------------------------------------------------------------------------------------------

export type OfferInput = {
  enabled: boolean
  /** Null when the source failed or is missing; `readReason` then says why. */
  read: RunGithub | null
  readReason: string | null
  /** The run's snapshot status (`succeeded` for an integrated run and for an accepted override). */
  runStatus: string
  /** The project's registered repository, shown with home as `~` in the command. */
  repositoryShown: string
  /** Suggested reviewers (requested, latest reviewers, recent authors), deduplicated, at most 30. */
  suggestions: string[]
  /** The default pull request title and body (the run summary), redacted. */
  defaults: { title: string; body: string }
}

type Spec = { id: GithubActionId; label: string; effect: (read: RunGithub | null) => string; not_effect: string }

const SPECS: Spec[] = [
  { id: 'push_branch', label: 'Push branch', effect: () => 'Pushes the run branch to origin without force, so GitHub has it.', not_effect: 'It never force-pushes, never pushes another branch and never opens a pull request.' },
  { id: 'open_pr', label: 'Open draft pull request', effect: read => `Opens a draft pull request from the run branch into ${read?.repo.default_branch ?? 'the default branch'}.`, not_effect: 'It requests no reviewers and merges nothing.' },
  { id: 'mark_ready', label: 'Mark ready for review', effect: read => `Takes ${read?.pr ? `#${read.pr.number}` : 'the pull request'} out of draft so reviewers are notified.`, not_effect: 'It merges nothing and changes no code.' },
  { id: 'request_reviewers', label: 'Request reviewers', effect: read => `Asks the named people or teams to review ${read?.pr ? `#${read.pr.number}` : 'the pull request'}.`, not_effect: 'It removes no reviewer and approves nothing.' },
]
if (SPECS.map(spec => spec.id).join() !== GITHUB_ACTION_IDS.join()) throw new Error('The GitHub actions must follow GITHUB_ACTION_IDS')

/** Whether a push or a pull request asks for the repository typed: a PUBLIC repository or one whose visibility is unknown. */
export function needsTypedRepo(read: RunGithub | null): boolean {
  const visibility = read?.github.visibility ?? null
  return visibility !== 'PRIVATE' && visibility !== 'INTERNAL'
}

function audience(read: RunGithub | null): string {
  const repo = read?.repo.owner_name ?? 'the repository'
  const visibility = read?.github.visibility ?? null
  if (visibility === 'PRIVATE' || visibility === 'INTERNAL') return `visible to everyone with access to ${repo} (${visibility})`
  if (visibility === 'PUBLIC') return `public on ${repo}`
  return `public on ${repo} (its visibility is not known, so treat it as public)`
}

function commitCount(read: RunGithub): number {
  return read.branch.unpublished.length + read.branch.unpublished_more
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function publishesOf(id: GithubActionId, read: RunGithub | null): string {
  switch (id) {
    case 'push_branch': {
      const n = read ? commitCount(read) : 0
      return `${plural(n, 'commit')} (with author names and emails) ${n === 1 ? 'becomes' : 'become'} ${audience(read)}`
    }
    case 'open_pr': return `The title and body become ${audience(read)}`
    case 'mark_ready': return 'GitHub notifies the requested reviewers and the repository\'s watchers'
    case 'request_reviewers': return 'GitHub notifies each reviewer you name'
  }
}

const confirmSpec: GithubParamSpec = { name: 'confirm_repo', kind: 'typed', required: true }

function paramsOf(id: GithubActionId, read: RunGithub | null, suggestions: string[]): GithubParamSpec[] {
  const typed = needsTypedRepo(read) ? [confirmSpec] : []
  switch (id) {
    case 'push_branch': return typed
    case 'open_pr': return [
      { name: 'title', kind: 'text', min_length: 1, max_length: TITLE_MAX, required: true },
      { name: 'body', kind: 'multiline', min_length: 1, max_length: BODY_MAX, required: true },
      ...typed,
    ]
    case 'mark_ready': return []
    case 'request_reviewers': return [{ name: 'reviewers', kind: 'list', max_items: REVIEWERS_MAX, suggestions: suggestions.slice(0, SUGGESTIONS_MAX), required: true }]
  }
}

/** Why `id` is unavailable, or null; the order is the one the reasons are told in (off, read, repository, the action's own rule). */
export function unavailableReason(id: GithubActionId, input: Pick<OfferInput, 'enabled' | 'read' | 'readReason' | 'runStatus'>): string | null {
  if (!input.enabled) return GITHUB_ACTIONS_OFF
  const read = input.read
  if (read === null) return input.readReason ?? GITHUB_READ_FAILED
  if (read.repo.status !== 'github' || read.repo.owner_name === null) return read.repo.reason ?? 'The repository has no GitHub remote'
  const repo = read.repo.owner_name
  if (read.github.status !== 'read') {
    if (read.github.status === 'pending') return 'GitHub has not been read for this branch yet; it is read within a minute'
    return read.github.reason ?? `GitHub is ${read.github.status.replace('_', ' ')} for ${repo}`
  }
  const branch = read.branch
  const pr = read.pr
  switch (id) {
    case 'push_branch': {
      const permission = read.github.viewer_permission
      if (permission === null) return `GitHub did not report your permission on ${repo}`
      if (!WRITERS.has(permission)) return `Your GitHub account has ${permission} access to ${repo}; a push needs WRITE`
      if (input.runStatus !== 'succeeded') return 'Only an integrated or accepted run\'s branch is pushed'
      if (!isBranchName(branch.name)) return 'The run records no valid branch name'
      if (branch.name === read.repo.default_branch || PROTECTED.has(branch.name)) return `${branch.name} is a default or protected branch; only a run branch is pushed`
      switch (branch.push_state) {
        case 'up_to_date': return 'The branch is already on GitHub at the same commit'
        case 'remote_ahead': return 'GitHub has commits the run branch lacks; nothing is pushed over them'
        case 'diverged': return 'The run branch and its GitHub branch have diverged; nothing is pushed over them'
        case 'no_local_branch': return 'The run branch is not in the repository'
        case 'unknown': return 'Where the run branch stands against GitHub is not known'
        default: break
      }
      if (branch.local_sha === null || branch.local_sha.length < 12) return 'The run branch\'s head is not recorded in full'
      return null
    }
    case 'open_pr': {
      if (pr !== null && pr.state === 'OPEN') return `Pull request #${pr.number} is already open for this branch`
      if (branch.push_state !== 'up_to_date') return 'Push the branch first: GitHub does not have the run branch at its head'
      if (!isBranchName(branch.name)) return 'The run records no valid branch name'
      if (!isBranchName(read.repo.default_branch)) return `The default branch of ${repo} is not known`
      if (branch.name === read.repo.default_branch) return 'The run branch is the default branch'
      return null
    }
    case 'mark_ready': {
      if (pr === null || pr.state !== 'OPEN') return 'No pull request is open for this branch'
      if (!pr.draft) return `Pull request #${pr.number} is already ready for review`
      return null
    }
    case 'request_reviewers':
      if (pr === null || pr.state !== 'OPEN') return 'No pull request is open for this branch'
      return null
  }
}

/** The reviewers to suggest: the pull request's requested and latest reviewers, then the repository's recent authors; at most 30. */
export function reviewerSuggestions(read: RunGithub | null, recentAuthors: string[]): string[] {
  const names = [
    ...(read?.pr?.requested_reviewers ?? []).filter(reviewer => reviewer.kind !== 'bot').map(reviewer => reviewer.login),
    ...(read?.pr?.latest_reviews ?? []).map(review => review.author),
    ...recentAuthors,
  ]
  const viewer = read?.github.viewer_login ?? null
  return [...new Set(names.filter(name => isReviewerName(name) && name !== viewer && !name.endsWith('[bot]')))].slice(0, SUGGESTIONS_MAX)
}

// ---- Commands -------------------------------------------------------------------------------------------------------------

const W = ['-m', 'workflow', 'github']
const BY = ['--by', 'operator']

/** The argv after the Python executable; `bodyFile` is the server's temporary body file for `open_pr`. */
export function githubArgv(id: GithubActionId, runDir: string, repository: string, read: RunGithub, params: GithubParams, bodyFile: string | null): string[] {
  switch (id) {
    case 'push_branch': return [...W, 'push', runDir, '--repo', repository, '--sha', read.branch.local_sha!, ...BY]
    case 'open_pr': return [...W, 'pr', runDir, '--repo', repository, '--base', read.repo.default_branch!, '--title', params.title!, '--body-file', bodyFile!, ...BY]
    case 'mark_ready': return [...W, 'ready', runDir, '--repo', repository, '--pr', String(read.pr!.number), ...BY]
    case 'request_reviewers': return [...W, 'reviewers', runDir, '--repo', repository, '--pr', String(read.pr!.number), '--add', params.reviewers!.join(','), ...BY]
  }
}

/** The redacted command as the page shows it: `$PY`, `"$RUN"`, home as `~`, a 12-character sha, typed values as placeholders. */
export function githubDisplay(id: GithubActionId, repositoryShown: string, read: RunGithub | null, params: GithubParams = {}): string {
  const repo = `--repo ${repositoryShown}`
  const pr = read?.pr ? String(read.pr.number) : '<pr>'
  switch (id) {
    case 'push_branch': return `$PY -m workflow github push "$RUN" ${repo} --sha ${read?.branch.local_sha ? read.branch.local_sha.slice(0, 12) : '<sha>'} --by operator`
    case 'open_pr': return `$PY -m workflow github pr "$RUN" ${repo} --base ${read?.repo.default_branch ?? '<base>'} --title ${params.title === undefined ? '<title>' : JSON.stringify(params.title)} --body-file <body> --by operator`
    case 'mark_ready': return `$PY -m workflow github ready "$RUN" ${repo} --pr ${pr} --by operator`
    case 'request_reviewers': return `$PY -m workflow github reviewers "$RUN" ${repo} --pr ${pr} --add ${params.reviewers ? params.reviewers.join(',') : '<reviewers>'} --by operator`
  }
}

/** The four actions in order, each with its reason exactly when unavailable. */
export function githubActionsOf(input: OfferInput): GithubAction[] {
  return SPECS.map((spec): GithubAction => {
    const reason = unavailableReason(spec.id, input)
    const defaults = spec.id === 'open_pr' ? { title: input.defaults.title, body: input.defaults.body } : spec.id === 'request_reviewers' ? { reviewers: [] as string[] } : {}
    return {
      id: spec.id, label: spec.label, available: reason === null, reason, command: githubDisplay(spec.id, input.repositoryShown, input.read),
      confirm: spec.id === 'push_branch' || spec.id === 'open_pr' ? (needsTypedRepo(input.read) ? 'typed_repo' : 'plain') : 'plain',
      params: paramsOf(spec.id, input.read, input.suggestions), defaults, effect: spec.effect(input.read), not_effect: spec.not_effect, publishes: publishesOf(spec.id, input.read),
    }
  })
}

// ---- Parameters -----------------------------------------------------------------------------------------------------------

function invalid(message: string): never {
  throw new ControlsError(400, 'INVALID_PARAMS', message)
}

/** Only the action's offered parameters, each within its bounds; the typed repository compared exactly. The cleaned parameters. */
export function validateGithubParams(action: GithubAction, params: GithubParams, repo: string | null): GithubParams {
  const names = new Set<string>(action.params.map(param => param.name))
  for (const key of Object.keys(params)) if (!names.has(key)) invalid(`The parameter "${key}" does not belong to this action.`)
  const clean: GithubParams = {}
  for (const param of action.params) {
    const value = params[param.name]
    if (value === undefined) invalid(`The parameter "${param.name}" is required.`)
    switch (param.name) {
      case 'title': {
        const title = value as string
        if (title.includes('\0') || /[\r\n]/.test(title)) invalid('The title must be one line of text.')
        if (title.trim().length < param.min_length || title.length > param.max_length) invalid(`The title must be ${param.min_length} to ${param.max_length} characters.`)
        clean.title = title
        break
      }
      case 'body': {
        const body = value as string
        if (body.includes('\0')) invalid('The body must be text without NUL characters.')
        if (body.trim().length < param.min_length || body.length > param.max_length || Buffer.byteLength(body, 'utf8') > param.max_length) invalid(`The body must be ${param.min_length} to ${param.max_length} characters (and bytes).`)
        clean.body = body
        break
      }
      case 'reviewers': {
        const list = [...new Set((value as string[]).map(name => name.trim()).filter(Boolean))]
        if (list.length === 0) invalid('Name at least one reviewer.')
        if (list.length > param.max_items) invalid(`Name at most ${param.max_items} reviewers.`)
        const bad = list.find(name => !isReviewerName(name))
        if (bad !== undefined) invalid(`"${bad}" is not a GitHub login or org/team slug.`)
        clean.reviewers = list
        break
      }
      case 'confirm_repo':
        if (repo === null || value !== repo) invalid(`The typed repository does not match ${repo ?? 'the repository'}.`)
        break
    }
  }
  return clean
}

// ---- The default title and body (the run summary) ---------------------------------------------------------------------------

/** The run summary's input from what the store loaded and the GitHub read; every free text goes through `redactText`. */
/** A lane's team facts for the summary: its worker session's workflows, when the team reader found any; else null. */
function laneTeam(teams: Teams | null, lane: string): RunSummaryInput['lanes'][number]['team'] {
  const session = teams?.sessions.find(candidate => candidate.role === 'worker' && candidate.lane === lane && candidate.records === 'found')
  if (!session) return null
  const agents = session.workflows.reduce((sum, workflow) => sum + workflow.agent_count, 0)
  const failed = session.workflows.reduce((sum, workflow) => sum + workflow.agents.filter(agent => agent.state === 'failed').length, 0)
  return { workflows: session.workflows.length, agents, failed }
}

export function summaryInput(loaded: LoadedRun, workflowId: string, read: RunGithub | null, teams: Teams | null = null): RunSummaryInput {
  const review = loaded.review
  const open = review ? review.findings.filter(finding => finding.disposition === 'open') : []
  return {
    runId: loaded.detail.summary.run_id, workflowId, feature: loaded.inputs?.feature ?? null, status: loaded.detail.summary.status,
    headline: loaded.detail.summary.activity?.headline ?? null, branch: read?.branch.name ?? loaded.inputs?.source_branch ?? null,
    baseCommit: loaded.inputs?.base_commit ?? null, integratedCommit: read?.branch.integrated_commit ?? null,
    review: review ? {
      verdict: review.verdict, reviewers: review.reviewers.map(reviewer => reviewer.reviewer_id),
      open: { p0: open.filter(finding => finding.severity === 'P0').length, p1: open.filter(finding => finding.severity === 'P1').length, p2: open.filter(finding => finding.severity === 'P2').length },
    } : null,
    lanes: (loaded.inputs?.workers ?? []).map(worker => ({ lane: worker.node_id, summary: worker.completion?.summary ?? null, team: laneTeam(teams, worker.node_id) })),
    costUsd: loaded.claudeUsd,
    pr: read?.pr ? { number: read.pr.number, url: read.pr.url, state: read.pr.state, draft: read.pr.draft } : null,
  }
}

export function summaryDefaults(loaded: LoadedRun, workflowId: string, read: RunGithub | null, teams: Teams | null = null): { title: string; body: string } {
  const input = summaryInput(loaded, workflowId, read, teams)
  const title = runSummaryTitle(input, redactText).replace(/[\r\n]+/g, ' ').slice(0, TITLE_MAX)
  const body = runSummaryMarkdown(input, redactText)
  return { title, body: body.length > BODY_MAX ? `${body.slice(0, BODY_MAX - 2)}…\n` : body }
}

// ---- Output -------------------------------------------------------------------------------------------------------------------

/** The first `https://github.com/...` the command printed (the pull request gh created), or null. */
export function urlOf(lines: string[]): string | null {
  for (const line of lines) {
    const match = GITHUB_URL.exec(line)
    if (match) return match[0].replace(/[).,;'"]+$/, '')
  }
  return null
}

// ---- Records ------------------------------------------------------------------------------------------------------------------

export function newGithubRecordId(): string {
  return `g-${createHash('sha256').update(`${Math.random()}${process.hrtime.bigint()}${process.pid}`).digest('hex').slice(0, 12)}`
}

export const storedGithubRecordSchema = githubActionRecordSchema.extend({ argv: z.array(z.string()) })
export type StoredGithubRecord = GithubActionRecord & { argv: string[] }

function wire(record: StoredGithubRecord): GithubActionRecord {
  const { argv: _argv, ...rest } = record
  void _argv
  return rest
}

/** `<state>/<project>/<workflow>/<run>.github.jsonl`, one line per change; the last line of a record wins. Logs sit beside it. */
export class GithubRecordStore {
  private readonly chains = new Map<string, Promise<void>>()
  private readonly stateDir: string
  private readonly now: () => Date
  private readonly secrets: { home: string; token: string | null }

  constructor(stateDir: string, now: () => Date, secrets: { home: string; token: string | null }) {
    this.stateDir = stateDir
    this.now = now
    this.secrets = secrets
  }

  folder(key: RunKey): string {
    return join(this.stateDir, key.project, key.workflow)
  }

  file(key: RunKey): string {
    return join(this.folder(key), `${key.run}.github.jsonl`)
  }

  logPath(key: RunKey, recordId: string): string {
    return join(this.folder(key), `${key.run}.${recordId}.log`)
  }

  bodyPath(key: RunKey, recordId: string): string {
    return join(this.folder(key), `${key.run}.${recordId}.body.md`)
  }

  async prepare(key: RunKey): Promise<void> {
    await fs.mkdir(this.folder(key), { recursive: true, mode: 0o700 })
  }

  private async fold(file: string): Promise<StoredGithubRecord[]> {
    let text: string
    try {
      text = await fs.readFile(file, 'utf8')
    } catch {
      return []
    }
    const byId = new Map<string, StoredGithubRecord>()
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = storedGithubRecordSchema.safeParse(JSON.parse(line))
        if (parsed.success) byId.set(parsed.data.record_id, parsed.data)
      } catch { /* a torn line is skipped */ }
    }
    return [...byId.values()]
  }

  private async expose(key: RunKey, record: StoredGithubRecord): Promise<GithubActionRecord> {
    const shown = wire(record)
    if (record.status !== 'running') return shown
    return { ...shown, output_tail: tailLines(await readLogTail(this.logPath(key, record.record_id)), this.secrets) }
  }

  /** Newest first, at most `limit`. */
  async list(key: RunKey, limit = 20): Promise<GithubActionRecord[]> {
    const stored = (await this.fold(this.file(key))).reverse().slice(0, limit)
    return Promise.all(stored.map(record => this.expose(key, record)))
  }

  async byRequest(key: RunKey, requestId: string): Promise<GithubActionRecord | null> {
    const record = (await this.fold(this.file(key))).find(candidate => candidate.request_id === requestId)
    return record ? this.expose(key, record) : null
  }

  async write(key: RunKey, record: StoredGithubRecord): Promise<void> {
    const file = this.file(key)
    const line = `${JSON.stringify(storedGithubRecordSchema.parse(record))}\n`
    const previous = this.chains.get(file) ?? Promise.resolve()
    const next = previous.then(async () => {
      await this.prepare(key)
      await fs.appendFile(file, line, { mode: 0o600 })
    })
    this.chains.set(file, next.catch(() => undefined))
    await next
  }

  /** A restart cannot observe a child it did not wait for: every `running` GitHub record becomes `lost`. */
  async recoverLost(): Promise<number> {
    let lost = 0
    for (const project of await fs.readdir(this.stateDir).catch(() => [] as string[])) {
      for (const workflow of await fs.readdir(join(this.stateDir, project)).catch(() => [] as string[])) {
        for (const name of await fs.readdir(join(this.stateDir, project, workflow)).catch(() => [] as string[])) {
          if (!name.endsWith('.github.jsonl')) continue
          const key = { project, workflow, run: name.slice(0, -'.github.jsonl'.length) }
          for (const record of await this.fold(this.file(key))) {
            if (record.status !== 'running') continue
            await this.write(key, { ...record, status: 'lost', ended_at: this.now().toISOString().replace(/\.\d+Z$/, 'Z') })
            lost += 1
          }
        }
      }
    }
    return lost
  }
}

/** The repository as the command shows it: home as `~`, the pairing token never. */
export function shownPath(path: string, secrets: { home: string; token: string | null }): string {
  return redactSecrets(path, secrets)
}

export type { RunGithubActions }
export { GITHUB_ACTIONS_VERSION }
