import { homedir } from 'node:os'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import {
  DISPATCH_VERSION, dispatchOverviewSchema, gitStateSchema, homeRunsSchema, projectStepsSchema, registryRunsSchema,
  type GitState, type GithubState, type HomeRuns, type ProjectSpend, type ProjectSteps, type ReadError, type RegistryRuns,
} from '../contracts/projects/dispatch.ts'
import type { RunSummary } from '../contracts/projects/v1.ts'
import { GitReader, discoverGithubRepos, realGitRunner, type GitRunner } from './dispatchGit.ts'
import { GithubReader } from './dispatchGithub.ts'
import { StepDigests } from './dispatchSteps.ts'
import { DEFAULT_RUN_LIMIT, MAX_RUN_LIMIT, ProjectApiError, RunStore, encodeCursor } from './projects.ts'
import { ID_PATTERN } from './projectsConfig.ts'

/**
 * The dispatch API (docs/PRD_PROJECTS_DISPATCH Appendix A): `GET /api/dispatch/projects` (the overview) and
 * `GET /api/dispatch/projects/:projectId/steps`. GET and HEAD only; any other method is 405. Read-only throughout:
 * git and gh run read-only, nothing is fetched, pushed or written (except the GitHub cache, inside the reader).
 * Each project's git and GitHub parts are validated on their own, so one odd field degrades a single project rather
 * than the whole page (design-challenge note 6, [L2]). Errors use `{ error: { code, message } }` and never carry a path.
 */
export const DISPATCH_PREFIX = '/api/dispatch'
const READ_METHODS = 'GET, HEAD'
const OTHER_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const

type ErrorBody = { error: { code: string; message: string } }

function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } }
}

function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).header('Cache-Control', 'no-store').send(errorBody(code, message))
}

function conform<T>(schema: z.ZodType<T>, payload: unknown, log: FastifyInstance['log']): T {
  const result = schema.safeParse(payload)
  if (!result.success) {
    log.error({ issues: result.error.issues.slice(0, 5).map(issue => `${issue.path.join('.')}: ${issue.message}`) }, 'Dispatch payload violates the contract')
    throw new ProjectApiError(500, 'RESPONSE_INVALID', 'The dispatch data could not be projected onto the API contract.')
  }
  return result.data
}

/** The dispatch dependencies, built by `createApp` from its options (defaults: real git, no timer, GitHub off). */
export type DispatchDeps = { store: RunStore; git: GitReader; github: GithubReader; steps: StepDigests }

export type DispatchAppOptions = {
  gitRunner?: GitRunner
  now?: () => number
  home?: string
  /** The GitHub reader; omitted means GitHub-off (no timer, no cache, no runner), so plain server tests never hang (note 7). */
  github?: GithubReader
}

export function buildDispatch(store: RunStore, options: DispatchAppOptions, warn?: (message: string, details: Record<string, unknown>) => void): DispatchDeps {
  const now = options.now ?? Date.now
  const gitRunner = options.gitRunner ?? realGitRunner()
  const git = new GitReader(gitRunner, options.home ?? homedir(), now)
  const github = options.github ?? new GithubReader({ mode: 'off', now })
  // Discovery runs through the store the reloader keeps current: sync first, then discover the GitHub keys of the
  // registry as it is now. The tick reads a repository added at runtime and skips one no longer registered ([S3], [L9]).
  github.setDiscover(async () => { await store.sync(); return discoverGithubRepos(store.config.projects, gitRunner) })
  const steps = new StepDigests(store, warn)
  return { store, git, github, steps }
}

function gitFailed(repositoryLabel: string, now: () => number): GitState {
  return {
    status: 'unavailable', reason: 'git failed', repository_label: repositoryLabel,
    checkout: null, head: null, default_branch: null, clone_id: null, clone_primary: null,
    origin: null, ahead_commits: [], ahead_naming_run: 0, landings: [], read_at: new Date(now()).toISOString(),
  }
}

export type DispatchRoutesOptions = DispatchDeps & { now?: () => number }

/** A failed read as the per-project or per-workflow route would have answered it: its status, code and message. */
function readError(error: unknown): ReadError {
  if (error instanceof ProjectApiError) return { status: error.status, code: error.code, message: error.message }
  return { status: 500, code: 'INTERNAL', message: 'The request failed unexpectedly. Retry, then check the server log.' }
}

function single(value: unknown): unknown {
  return Array.isArray(value) ? (value.length === 1 ? value[0] : { duplicated: true }) : value
}

const sinceSchema = z.iso.datetime()

/** `since`: an ISO 8601 time with a Z offset; anything else, or none, is a 400. */
function parseSince(value: unknown): number {
  const raw = single(value)
  const parsed = sinceSchema.safeParse(raw)
  const time = parsed.success ? Date.parse(parsed.data) : Number.NaN
  if (!Number.isFinite(time)) throw new ProjectApiError(400, 'INVALID_SINCE', 'The since parameter must be an ISO 8601 time with a Z offset, such as 2026-10-07T12:00:00Z.')
  return time
}

/** `limit`: an integer from 1 to 100, 50 when absent; never clamped. */
function parseRegistryLimit(value: unknown): number {
  const raw = single(value)
  if (raw === undefined) return DEFAULT_RUN_LIMIT
  const invalid = new ProjectApiError(400, 'INVALID_LIMIT', `The limit must be an integer from 1 to ${MAX_RUN_LIMIT}.`)
  if (typeof raw !== 'string' || !/^\d{1,3}$/.test(raw)) throw invalid
  const limit = Number(raw)
  if (limit < 1 || limit > MAX_RUN_LIMIT) throw invalid
  return limit
}

/** A position in the registry's one run order. Version 2, so a workflow's own cursor (version 1) is foreign here. */
type RegistryPosition = { updated_at: string; project_id: string; workflow_id: string; run_id: string }
const registryCursorSchema = z.strictObject({ v: z.literal(2), u: z.iso.datetime({ offset: false, local: false }), p: z.string().min(1), w: z.string().min(1), r: z.string().min(1) })

export function encodeRegistryCursor(run: RegistryPosition): string {
  return Buffer.from(JSON.stringify({ v: 2, u: run.updated_at, p: run.project_id, w: run.workflow_id, r: run.run_id }), 'utf8').toString('base64url')
}

function decodeRegistryCursor(value: unknown): RegistryPosition | null {
  const raw = single(value)
  if (raw === undefined) return null
  const invalid = new ProjectApiError(400, 'INVALID_CURSOR', 'The cursor is not a paging token issued for the registry run list. Restart from the first page.')
  if (typeof raw !== 'string' || raw.length === 0 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw invalid
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw invalid
  }
  const result = registryCursorSchema.safeParse(parsed)
  if (!result.success) throw invalid
  return { updated_at: result.data.u, project_id: result.data.p, workflow_id: result.data.w, run_id: result.data.r }
}

const text = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** The registry order: newest update first, then project, workflow and run ID ascending. */
export function compareRegistryRuns(a: RegistryPosition, b: RegistryPosition): number {
  return Date.parse(b.updated_at) - Date.parse(a.updated_at) || text(a.project_id, b.project_id) || text(a.workflow_id, b.workflow_id) || text(a.run_id, b.run_id)
}

export async function dispatchRoutes(scope: FastifyInstance, options: DispatchRoutesOptions): Promise<void> {
  const { store, git, github, steps } = options
  const now = options.now ?? Date.now
  const log = scope.log

  scope.setNotFoundHandler((_request, reply) => sendError(reply, 404, 'NOT_FOUND', 'No dispatch resource exists at that path.'))
  scope.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof ProjectApiError) {
      if (error.status >= 500) log.error({ code: error.code, message: error.message }, 'Dispatch request failed')
      return sendError(reply, error.status, error.code, error.message)
    }
    log.error({ message: (error as Error)?.message }, 'Unhandled dispatch failure')
    return sendError(reply, 500, 'INTERNAL', 'The request failed unexpectedly.')
  })
  scope.addHook('onRequest', async () => { await store.sync() })
  scope.addHook('onSend', async (_request, reply) => { if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store') })

  const paths = { overview: '/projects', steps: '/projects/:project_id/steps', homeRuns: '/runs', registryRuns: '/runs/all' }
  for (const url of Object.values(paths)) {
    scope.route({
      method: [...OTHER_METHODS], url,
      handler: (_request, reply) => reply.header('Allow', READ_METHODS).code(405).send(errorBody('METHOD_NOT_ALLOWED', 'This dispatch API is read-only: only GET and HEAD are supported.')),
    })
  }

  scope.get(paths.overview, async () => {
    const projects = store.config.projects
    // The spend reads only the run store's cached summaries; it runs beside the git reads rather than after them.
    const spending = Promise.all(projects.map(project => projectSpend(store, project)))
    const reads = await Promise.all(projects.map(async project => {
      const facts = await steps.facts(project)
      const read = await git.read({ project_id: project.project_id, repository: project.repository, run_ids: facts.runIds, landings: facts.landings })
      return { project, read }
    }))
    // clone_primary: the first registry project sharing the clone_id.
    const firstByClone = new Map<string, string>()
    for (const { project, read } of reads) {
      const id = read.state.clone_id
      if (id && !firstByClone.has(id)) firstByClone.set(id, project.project_id)
    }
    const spends = await spending
    const result = reads.map(({ project, read }, index) => {
      const withPrimary: GitState = { ...read.state, clone_primary: read.state.clone_id ? firstByClone.get(read.state.clone_id) ?? null : null }
      const parsed = gitStateSchema.safeParse(withPrimary)
      const gitState: GitState = parsed.success ? parsed.data : gitFailed(read.state.repository_label, now)
      const githubState: GithubState = github.state(gitState.status === 'unavailable' ? null : read.githubRepo, gitState.status === 'unavailable')
      return { project_id: project.project_id, git: gitState, github: githubState, spend: spends[index] }
    })
    return conform(dispatchOverviewSchema, {
      contract_version: DISPATCH_VERSION, read_at: new Date(now()).toISOString(), viewer_login: github.viewerLogin, projects: result,
    }, log)
  })

  // The rail's, the cards' and Triage's one read: the per-workflow route's pages back to `since`, for every workflow at once.
  scope.get(paths.homeRuns, async request => {
    const since = parseSince((request.query as Record<string, unknown>).since)
    const projects = await Promise.all(store.config.projects.map(async (project): Promise<HomeRuns['projects'][number]> => {
      let workflows
      try {
        workflows = store.workflows(project.project_id)
      } catch (error) {
        return { project_id: project.project_id, workflows: [], error: readError(error), runs: [] }
      }
      const runs = await Promise.all(workflows.map(async workflow => {
        try {
          const all = await store.listRuns(store.scope(project.project_id, workflow.workflow_id))
          let read = Math.min(DEFAULT_RUN_LIMIT, all.length)
          while (read < all.length && Date.parse(all[read - 1].updated_at) >= since) read = Math.min(read + DEFAULT_RUN_LIMIT, all.length)
          const next_cursor = read < all.length ? encodeCursor({ project_id: project.project_id, workflow_id: workflow.workflow_id }, all[read - 1]) : null
          return { workflow_id: workflow.workflow_id, runs: all.slice(0, read), next_cursor, error: null }
        } catch (error) {
          return { workflow_id: workflow.workflow_id, runs: [], next_cursor: null, error: readError(error) }
        }
      }))
      return { project_id: project.project_id, workflows, error: null, runs }
    }))
    const payload: HomeRuns = { contract_version: DISPATCH_VERSION, read_at: new Date(now()).toISOString(), since: new Date(since).toISOString(), projects }
    return conform(homeRunsSchema, payload, log)
  })

  // Triage's "All time": every readable workflow's runs, one page of the registry order at a time.
  scope.get(paths.registryRuns, async request => {
    const query = request.query as Record<string, unknown>
    const limit = parseRegistryLimit(query.limit)
    const cursor = decodeRegistryCursor(query.cursor)
    const unreadable: RegistryRuns['unreadable'] = []
    const lists = await Promise.all(store.config.projects.flatMap(project => project.workflows.map(async (workflow): Promise<RunSummary[]> => {
      try {
        return await store.listRuns(store.scope(project.project_id, workflow.workflow_id))
      } catch (error) {
        unreadable.push({ project_id: project.project_id, workflow_id: workflow.workflow_id, code: readError(error).code })
        return []
      }
    })))
    const ordered = lists.flat().sort(compareRegistryRuns)
    const remaining = cursor === null ? ordered : ordered.filter(run => compareRegistryRuns(run, cursor) > 0)
    const runs = remaining.slice(0, limit)
    const next_cursor = remaining.length > limit ? encodeRegistryCursor(runs[runs.length - 1]) : null
    unreadable.sort((a, b) => text(a.project_id, b.project_id) || text(a.workflow_id, b.workflow_id))
    const payload: RegistryRuns = { contract_version: DISPATCH_VERSION, read_at: new Date(now()).toISOString(), runs, next_cursor, unreadable }
    return conform(registryRunsSchema, payload, log)
  })

  scope.get(paths.steps, async request => {
    const projectId = (request.params as Record<string, string>).project_id
    const project = ID_PATTERN.test(projectId) ? store.config.projects.find(candidate => candidate.project_id === projectId) : undefined
    if (!project) throw new ProjectApiError(404, 'NOT_FOUND', 'No project with that ID is registered.')
    const workflows = (await steps.workflows(project)).map(workflow => ({
      workflow_id: workflow.workflow_id,
      error: workflow.error,
      runs: workflow.runs.map(run => ({
        run_id: run.run_id, source_branch: run.source_branch, base_commit: run.base_commit,
        integrated_commit: run.integrated_commit, lanes: run.lanes, steps: run.steps,
      })),
      errors: workflow.errors,
    }))
    const payload: ProjectSteps = { contract_version: DISPATCH_VERSION, project_id: project.project_id, workflows }
    return conform(projectStepsSchema, payload, log)
  })
}

/**
 * A project's Claude spend from its runs' exports, over every run of every readable workflow (the whole directory, never a
 * page): from `listRunEntries`' cached summaries, so a warm read parses no export. A workflow that cannot be read counts in
 * neither total; only a workflow list that cannot be read makes it null.
 */
export async function projectSpend(store: RunStore, project: RunStore['config']['projects'][number]): Promise<ProjectSpend | null> {
  let workflows
  try {
    workflows = store.workflows(project.project_id)
  } catch {
    return null
  }
  let runs = 0
  let priced = 0
  let total = 0
  for (const workflow of workflows) {
    let entries
    try {
      entries = await store.listRunEntries(store.scope(project.project_id, workflow.workflow_id))
    } catch {
      continue
    }
    for (const entry of entries) {
      runs += 1
      if (entry.claudeUsd !== null) { priced += 1; total += entry.claudeUsd }
    }
  }
  return { claude_usd: priced === 0 ? null : Math.round(total * 1e6) / 1e6, priced_runs: priced, runs }
}
