/**
 * Read-only client for the project workflow viewer API (`contracts/projects/README.md`).
 *
 * Every payload is validated against the committed contract schemas before it reaches a component. A
 * response that fails validation is a malformed-payload error: nothing is patched up or substituted.
 * Artifacts and results are only ever requested through the scoped routes of the run being viewed.
 */
import { z } from 'zod'
import { schemas, validateRunDetail, type Project, type RunDetail, type RunSummary, type WorkflowDefinition } from '../../contracts/projects/v1.ts'
import { eventSchema, validateWorkerResult, type WorkerResult, type WorkflowEvent } from '../../contracts/workflow/v1.ts'

export type { Project, RunDetail, RunSummary, WorkflowDefinition, WorkerResult, WorkflowEvent }

export type ApiErrorKind = 'network' | 'http' | 'malformed'

/** A failed request. `status` is set for HTTP failures; `code` comes from the contract error body when present. */
export class ProjectsApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status: number | null
  readonly code: string | null
  readonly path: string

  constructor(kind: ApiErrorKind, message: string, path: string, options: { status?: number | null; code?: string | null } = {}) {
    super(message)
    this.name = 'ProjectsApiError'
    this.kind = kind
    this.status = options.status ?? null
    this.code = options.code ?? null
    this.path = path
  }

  get notFound(): boolean {
    return this.kind === 'http' && this.status === 404
  }
}

export function describeApiError(error: unknown): string {
  if (error instanceof ProjectsApiError) {
    switch (error.kind) {
      case 'network': return 'The API could not be reached. Check that the server is running, then retry.'
      case 'malformed': return `The API returned data that does not match the projects contract: ${error.message}`
      case 'http': return error.code ? `${error.message} (${error.code}, HTTP ${error.status})` : `${error.message} (HTTP ${error.status})`
    }
  }
  return error instanceof Error && error.message ? error.message : 'An unexpected error occurred.'
}

const errorBodySchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) })

function encodeSegments(...segments: string[]): string {
  return segments.map(encodeURIComponent).join('/')
}

export type RunScope = { projectId: string; workflowId: string; runId: string }

export const paths = {
  projects: () => '/api/projects',
  workflows: (projectId: string) => `/api/projects/${encodeSegments(projectId)}/workflows`,
  runs: (projectId: string, workflowId: string, options: { limit?: number; cursor?: string | null } = {}) => {
    const query = new URLSearchParams()
    if (options.limit !== undefined) query.set('limit', String(options.limit))
    if (options.cursor) query.set('cursor', options.cursor)
    const suffix = query.size ? `?${query}` : ''
    return `/api/projects/${encodeSegments(projectId)}/workflows/${encodeSegments(workflowId)}/runs${suffix}`
  },
  run: (scope: RunScope) => `/api/projects/${encodeSegments(scope.projectId)}/workflows/${encodeSegments(scope.workflowId)}/runs/${encodeSegments(scope.runId)}`,
  events: (scope: RunScope, after = 0) => `${paths.run(scope)}/events?after=${after}`,
  result: (scope: RunScope, nodeId: string, attempt: number) => `${paths.run(scope)}/results/${encodeSegments(nodeId)}/${attempt}`,
  artifact: (scope: RunScope, artifactId: string) => `${paths.run(scope)}/artifacts/${encodeSegments(artifactId)}`,
}

async function request(path: string, signal: AbortSignal | undefined, accept: string): Promise<Response> {
  let response: Response
  try {
    response = await fetch(path, { signal, headers: { Accept: accept } })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new ProjectsApiError('network', error instanceof Error ? error.message : 'Network failure', path)
  }
  if (!response.ok) {
    let body: unknown = null
    try { body = await response.json() } catch { /* not JSON */ }
    const parsed = errorBodySchema.safeParse(body)
    const message = parsed.success ? parsed.data.error.message : `The API responded with status ${response.status}.`
    throw new ProjectsApiError('http', message, path, { status: response.status, code: parsed.success ? parsed.data.error.code : null })
  }
  return response
}

async function requestJson<T>(path: string, validate: (input: unknown) => T, signal?: AbortSignal): Promise<T> {
  const response = await request(path, signal, 'application/json')
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new ProjectsApiError('malformed', 'the response body is not JSON.', path)
  }
  try {
    return validate(body)
  } catch (error) {
    throw new ProjectsApiError('malformed', error instanceof z.ZodError ? z.prettifyError(error) : error instanceof Error ? error.message : 'invalid payload', path)
  }
}

export function fetchProjects(signal?: AbortSignal): Promise<Project[]> {
  return requestJson(paths.projects(), input => schemas.projectList.parse(input).projects, signal)
}

export function fetchWorkflows(projectId: string, signal?: AbortSignal): Promise<WorkflowDefinition[]> {
  return requestJson(paths.workflows(projectId), input => schemas.workflowList.parse(input).workflows, signal)
}

export type RunPage = { runs: RunSummary[]; nextCursor: string | null }

export function fetchRuns(projectId: string, workflowId: string, options: { cursor?: string | null } = {}, signal?: AbortSignal): Promise<RunPage> {
  return requestJson(paths.runs(projectId, workflowId, options), input => {
    const page = schemas.runList.parse(input)
    for (const run of page.runs) {
      if (run.project_id !== projectId || run.workflow_id !== workflowId) throw new Error(`run ${run.run_id} belongs to another scope.`)
    }
    return { runs: page.runs, nextCursor: page.next_cursor }
  }, signal)
}

export function fetchRunDetail(scope: RunScope, signal?: AbortSignal): Promise<RunDetail> {
  return requestJson(paths.run(scope), input => {
    const detail = validateRunDetail(input)
    if (detail.summary.project_id !== scope.projectId || detail.summary.workflow_id !== scope.workflowId || detail.summary.run_id !== scope.runId) {
      throw new Error('the run detail belongs to a different project, workflow or run.')
    }
    return detail
  }, signal)
}

const eventListSchema = z.strictObject({ events: z.array(eventSchema) })

export function fetchEvents(scope: RunScope, signal?: AbortSignal): Promise<WorkflowEvent[]> {
  return requestJson(paths.events(scope, 0), input => {
    const events = eventListSchema.parse(input).events
    // Deduplicate by sequence and keep the persisted order; the run ID must be this run's.
    const seen = new Set<number>()
    const unique: WorkflowEvent[] = []
    for (const event of events) {
      if (event.run_id !== scope.runId) throw new Error(`event ${event.event_id} belongs to run ${event.run_id}.`)
      if (seen.has(event.sequence)) continue
      seen.add(event.sequence)
      unique.push(event)
    }
    return unique.sort((a, b) => a.sequence - b.sequence)
  }, signal)
}

/** Only results published under this run's scoped `results/` route are fetched; anything else is refused. */
export function scopedResultPath(scope: RunScope, resultUri: string): string | null {
  const prefix = `${paths.run(scope)}/results/`
  if (!resultUri.startsWith(prefix)) return null
  const rest = resultUri.slice(prefix.length).split('/')
  if (rest.length !== 2 || rest.some(segment => segment === '') || !/^[1-9][0-9]*$/.test(rest[1])) return null
  return resultUri
}

export function fetchWorkerResult(scope: RunScope, resultPath: string, signal?: AbortSignal): Promise<WorkerResult> {
  return requestJson(resultPath, input => {
    const result = validateWorkerResult(input)
    if (result.run_id !== scope.runId) throw new Error(`the result belongs to run ${result.run_id}.`)
    return result
  }, signal)
}

/** Text artifacts (logs, reports, patches) are read as plain text and rendered as text, never as HTML. */
export async function fetchArtifactText(scope: RunScope, artifactId: string, signal?: AbortSignal): Promise<string> {
  const response = await request(paths.artifact(scope, artifactId), signal, 'text/plain, */*')
  return response.text()
}
