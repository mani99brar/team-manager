import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { schemas, validateReviewResult, validateRunInputs } from '../contracts/projects/v1.ts'
import { eventSchema, workerResultSchema } from '../contracts/workflow/v1.ts'
import { ID_PATTERN } from './projectsConfig.ts'
import { DEFAULT_RUN_LIMIT, MAX_RUN_LIMIT, ProjectApiError, RunStore, compareRuns, decodeCursor, encodeCursor } from './projects.ts'

/**
 * The project-scoped read-only API from contracts/projects/README.md, mounted under /api/projects. Every
 * response is validated against the committed contract before it is sent; a projection that cannot satisfy the
 * contract is a 500, never a partial or fabricated payload. Errors use `{ error: { code, message } }` and never
 * name filesystem paths. Only GET/HEAD exist: any other method on these routes is a 405.
 */
export const PROJECTS_PREFIX = '/api/projects'
const READ_METHODS = 'GET, HEAD'
const OTHER_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const

type ErrorBody = { error: { code: string; message: string } }

function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } }
}

function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).header('Cache-Control', 'no-store').send(errorBody(code, message))
}

function requireId(value: unknown, what: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new ProjectApiError(400, 'INVALID_ID', `The ${what} ID must be 1-128 characters of letters, digits, ".", "_" or "-", starting with a letter or digit.`)
  }
  return value
}

function single(value: unknown): unknown {
  return Array.isArray(value) ? (value.length === 1 ? value[0] : { duplicated: true }) : value
}

function parseLimit(value: unknown): number {
  const raw = single(value)
  if (raw === undefined) return DEFAULT_RUN_LIMIT
  if (typeof raw !== 'string' || !/^\d{1,3}$/.test(raw)) throw new ProjectApiError(400, 'INVALID_LIMIT', `The limit must be an integer from 1 to ${MAX_RUN_LIMIT}.`)
  const limit = Number(raw)
  if (limit < 1 || limit > MAX_RUN_LIMIT) throw new ProjectApiError(400, 'INVALID_LIMIT', `The limit must be an integer from 1 to ${MAX_RUN_LIMIT}.`)
  return limit
}

function parseAfter(value: unknown): number {
  const raw = single(value)
  if (raw === undefined) return 0
  if (typeof raw !== 'string' || !/^\d{1,15}$/.test(raw)) throw new ProjectApiError(400, 'INVALID_AFTER', 'The after parameter must be a non-negative integer event sequence.')
  return Number(raw)
}

function parseAttempt(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9]\d{0,8}$/.test(value)) throw new ProjectApiError(400, 'INVALID_ATTEMPT', 'The attempt must be a positive integer.')
  return Number(value)
}

/** Validates an outgoing payload against the contract; a violation is reported as a backend failure. */
function conform<T>(schema: z.ZodType<T>, payload: unknown, log: FastifyInstance['log']): T {
  const result = schema.safeParse(payload)
  if (!result.success) {
    log.error({ issues: result.error.issues.slice(0, 5).map(issue => `${issue.path.join('.')}: ${issue.message}`) }, 'Project API payload violates the contract')
    throw new ProjectApiError(500, 'RESPONSE_INVALID', 'The persisted run data could not be projected onto the API contract.')
  }
  return result.data
}

/** Applies a contract's cross-field validator to an outgoing payload; a violation is a backend failure, never a partial payload. */
function crossChecked<T>(validate: () => T, log: FastifyInstance['log']): T {
  try {
    return validate()
  } catch (error) {
    log.error({ message: (error as Error)?.message }, 'Project API payload violates a contract cross-field rule')
    throw new ProjectApiError(500, 'RESPONSE_INVALID', 'The persisted run data could not be projected onto the API contract.')
  }
}

export type ProjectRoutesOptions = { store: RunStore }

export async function projectRoutes(scope: FastifyInstance, options: ProjectRoutesOptions): Promise<void> {
  const { store } = options
  const log = scope.log
  scope.setNotFoundHandler((_request, reply) => sendError(reply, 404, 'NOT_FOUND', 'No project resource exists at that path.'))
  scope.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof ProjectApiError) {
      if (error.status >= 500) log.error({ code: error.code, message: error.message }, 'Project API request failed')
      return sendError(reply, error.status, error.code, error.message)
    }
    const status = typeof (error as { statusCode?: number }).statusCode === 'number' ? (error as { statusCode: number }).statusCode : 500
    // Fastify caps path parameters below the contract's 128-character IDs; report that as an invalid ID, not a 414.
    if ((error as { code?: string }).code === 'FST_ERR_MAX_PARAM_LENGTH') return sendError(reply, 400, 'INVALID_ID', 'A path segment is longer than any valid ID.')
    if (status >= 400 && status < 500) return sendError(reply, status, 'BAD_REQUEST', 'The request could not be processed.')
    log.error({ code: (error as NodeJS.ErrnoException)?.code, message: (error as Error)?.message }, 'Unhandled project API failure')
    return sendError(reply, 500, 'INTERNAL', 'The request failed unexpectedly. Retry, then check the server log.')
  })
  scope.addHook('onSend', async (_request, reply) => {
    if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store')
  })

  const paths = {
    projects: '/',
    workflows: '/:project_id/workflows',
    runs: '/:project_id/workflows/:workflow_id/runs',
    run: '/:project_id/workflows/:workflow_id/runs/:run_id',
    events: '/:project_id/workflows/:workflow_id/runs/:run_id/events',
    result: '/:project_id/workflows/:workflow_id/runs/:run_id/results/:node_id/:attempt',
    artifact: '/:project_id/workflows/:workflow_id/runs/:run_id/artifacts/:artifact_id',
    review: '/:project_id/workflows/:workflow_id/runs/:run_id/reviews/:attempt',
    inputs: '/:project_id/workflows/:workflow_id/runs/:run_id/inputs',
  }
  for (const url of Object.values(paths)) {
    scope.route({
      method: [...OTHER_METHODS], url,
      handler: (_request, reply) => reply.header('Allow', READ_METHODS).code(405).send(errorBody('METHOD_NOT_ALLOWED', 'This project API is read-only: only GET and HEAD are supported.')),
    })
  }

  type Params = Record<string, string | undefined>
  const scopeOf = (params: Params) => store.scope(requireId(params.project_id, 'project'), requireId(params.workflow_id, 'workflow'))

  scope.get(paths.projects, async () => conform(schemas.projectList, { projects: store.projects() }, log))

  scope.get(paths.workflows, async request => {
    const { project_id } = request.params as Params
    return conform(schemas.workflowList, { workflows: store.workflows(requireId(project_id, 'project')) }, log)
  })

  scope.get(paths.runs, async request => {
    const run = scopeOf(request.params as Params)
    const query = request.query as Record<string, unknown>
    const limit = parseLimit(query.limit)
    const cursorValue = single(query.cursor)
    const cursor = cursorValue === undefined ? null : typeof cursorValue === 'string' && cursorValue.length > 0
      ? decodeCursor(cursorValue, { project_id: run.project.project_id, workflow_id: run.workflow.workflow_id })
      : (() => { throw new ProjectApiError(400, 'INVALID_CURSOR', 'The cursor is not a paging token issued for this workflow. Restart from the first page.') })()
    const all = await store.listRuns(run)
    const remaining = cursor ? all.filter(summary => compareRuns(summary, cursor) > 0) : all
    const page = remaining.slice(0, limit)
    const next_cursor = remaining.length > limit ? encodeCursor({ project_id: run.project.project_id, workflow_id: run.workflow.workflow_id }, page[page.length - 1]) : null
    return conform(schemas.runList, { runs: page, next_cursor }, log)
  })

  scope.get(paths.run, async request => {
    const params = request.params as Params
    const loaded = await store.loadRun(scopeOf(params), requireId(params.run_id, 'run'))
    return conform(schemas.runDetail, loaded.detail, log)
  })

  scope.get(paths.events, async request => {
    const params = request.params as Params
    const after = parseAfter((request.query as Record<string, unknown>).after)
    const loaded = await store.loadRun(scopeOf(params), requireId(params.run_id, 'run'))
    return conform(z.strictObject({ events: z.array(eventSchema) }), { events: loaded.events.filter(event => event.sequence > after) }, log)
  })

  scope.get(paths.result, async request => {
    const params = request.params as Params
    const runScope = scopeOf(params)
    const runId = requireId(params.run_id, 'run')
    const nodeId = requireId(params.node_id, 'node')
    const attempt = parseAttempt(params.attempt)
    return conform(workerResultSchema, await store.workerResult(runScope, runId, nodeId, attempt), log)
  })

  scope.get(paths.review, async request => {
    const params = request.params as Params
    const runScope = scopeOf(params)
    const runId = requireId(params.run_id, 'run')
    const attempt = parseAttempt(params.attempt)
    const review = await store.reviewResult(runScope, runId, attempt)
    return conform(schemas.reviewResult, crossChecked(() => validateReviewResult(review), log), log)
  })

  scope.get(paths.inputs, async request => {
    const params = request.params as Params
    const inputs = await store.runInputs(scopeOf(params), requireId(params.run_id, 'run'))
    return conform(schemas.runInputs, crossChecked(() => validateRunInputs(inputs), log), log)
  })

  scope.get(paths.artifact, async (request, reply) => {
    const params = request.params as Params
    const runScope = scopeOf(params)
    const runId = requireId(params.run_id, 'run')
    const artifactId = requireId(params.artifact_id, 'artifact')
    const artifact = await store.artifact(runScope, runId, artifactId)
    return reply
      .header('Content-Type', artifact.contentType)
      .header('Content-Length', artifact.bytes.length)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Content-Disposition', `${artifact.disposition}; filename="${artifact.artifact_id}"`)
      .header('Cache-Control', 'no-store')
      .send(artifact.bytes)
  })
}
