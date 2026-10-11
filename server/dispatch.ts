import { homedir } from 'node:os'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import {
  DISPATCH_VERSION, dispatchOverviewSchema, gitStateSchema, projectStepsSchema,
  type GitState, type GithubState, type ProjectSteps,
} from '../contracts/projects/dispatch.ts'
import { GitReader, realGitRunner, type GitRunner } from './dispatchGit.ts'
import { GithubReader } from './dispatchGithub.ts'
import { StepDigests } from './dispatchSteps.ts'
import { ProjectApiError, RunStore } from './projects.ts'
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
  const git = new GitReader(options.gitRunner ?? realGitRunner(), options.home ?? homedir(), now)
  const github = options.github ?? new GithubReader({ mode: 'off', now })
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

  const paths = { overview: '/projects', steps: '/projects/:project_id/steps' }
  for (const url of Object.values(paths)) {
    scope.route({
      method: [...OTHER_METHODS], url,
      handler: (_request, reply) => reply.header('Allow', READ_METHODS).code(405).send(errorBody('METHOD_NOT_ALLOWED', 'This dispatch API is read-only: only GET and HEAD are supported.')),
    })
  }

  scope.get(paths.overview, async () => {
    const projects = store.config.projects
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
    const result = reads.map(({ project, read }) => {
      const withPrimary: GitState = { ...read.state, clone_primary: read.state.clone_id ? firstByClone.get(read.state.clone_id) ?? null : null }
      const parsed = gitStateSchema.safeParse(withPrimary)
      const gitState: GitState = parsed.success ? parsed.data : gitFailed(read.state.repository_label, now)
      const githubState: GithubState = github.state(gitState.status === 'unavailable' ? null : read.githubRepo, gitState.status === 'unavailable')
      return { project_id: project.project_id, git: gitState, github: githubState }
    })
    return conform(dispatchOverviewSchema, {
      contract_version: DISPATCH_VERSION, read_at: new Date(now()).toISOString(), viewer_login: github.viewerLogin, projects: result,
    }, log)
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
