/**
 * Read-only client for the project workflow viewer API (`contracts/projects/README.md`).
 *
 * Every payload is validated against the committed contract schemas before it reaches a component. A
 * response that fails validation is a malformed-payload error: nothing is patched up or substituted.
 * Artifacts and results are only ever requested through the scoped routes of the run being viewed.
 */
import { z } from 'zod'
import {
  type AttackAttacker,
  type AttackFinding,
  type AttackResult,
  isBlockingFinding,
  schemas,
  validateAttackResult,
  validateReviewResult,
  validateRunDetail,
  validateRunInputs,
  validateSidecarLedger,
  type Project,
  type ReviewFinding,
  type ReviewResult,
  type RunActivity,
  type RunDetail,
  type RunInputs,
  type RunInputWorker,
  type RunSummary,
  type SidecarFinding,
  type SidecarLedger,
  type SidecarMessage,
  type SidecarPass,
  type WorkflowDefinition,
} from '../../contracts/projects/v1.ts'
import { eventSchema, validateWorkerResult, type WorkerResult, type WorkflowEvent } from '../../contracts/workflow/v1.ts'

export type { AttackAttacker, AttackFinding, AttackResult, Project, ReviewFinding, ReviewResult, RunActivity, RunDetail, RunInputs, RunInputWorker, RunSummary, SidecarFinding, SidecarLedger, SidecarMessage, SidecarPass, WorkflowDefinition, WorkerResult, WorkflowEvent }
export { isBlockingFinding }

/** The contract's "not recorded" 404 codes: a run whose export predates a section, never an error state. */
export const NOT_RECORDED = { review: 'REVIEW_NOT_FOUND', inputs: 'INPUTS_NOT_FOUND', sidecar: 'SIDECAR_NOT_FOUND', attack: 'ATTACK_NOT_FOUND' } as const

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
  review: (scope: RunScope, attempt: number) => `${paths.run(scope)}/reviews/${attempt}`,
  inputs: (scope: RunScope) => `${paths.run(scope)}/inputs`,
  sidecar: (scope: RunScope) => `${paths.run(scope)}/sidecar`,
  attack: (scope: RunScope) => `${paths.run(scope)}/attack`,
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

/** One workflow's runs as a list shows them: the pages read, whether more exist, or why they could not be read. */
export type WorkflowRuns = { workflow: WorkflowDefinition; runs: RunSummary[]; more: boolean; error: unknown }
/** One project's workflows with their runs, or why its workflows could not be read. */
export type ProjectRuns = { project: Project; workflows: WorkflowRuns[]; error: unknown }

/** Whether a list reads the next page of a workflow's runs, given the runs read so far and the next cursor. */
export type ReadsNextPage = (runs: readonly RunSummary[], nextCursor: string | null) => boolean

/**
 * The runs of each workflow, read from the run lists only (never a run detail): the first page, then further pages while
 * `more` says so. A workflow whose runs cannot be read keeps its error beside the others' runs; an aborted load rejects.
 */
export async function fetchWorkflowRuns(projectId: string, workflows: readonly WorkflowDefinition[], more: ReadsNextPage, signal?: AbortSignal): Promise<WorkflowRuns[]> {
  return Promise.all(workflows.map(async (workflow): Promise<WorkflowRuns> => {
    const runs: RunSummary[] = []
    let next: string | null = null
    try {
      do {
        const page: RunPage = await fetchRuns(projectId, workflow.workflow_id, { cursor: next }, signal)
        runs.push(...page.runs)
        next = page.nextCursor
      } while (next !== null && more(runs, next))
      return { workflow, runs, more: next !== null, error: null }
    } catch (error) {
      if (signal?.aborted) throw error
      return { workflow, runs, more: next !== null, error }
    }
  }))
}

/**
 * Runs home's rows across the registry (docs/PRD_VIEWER_UX.md 4.1): each project's workflows, then each workflow's run
 * pages while `more` says so. Requests: one workflow list per project and at least one run page per workflow, in parallel.
 */
export async function fetchRegistryRuns(projects: readonly Project[], more: ReadsNextPage, signal?: AbortSignal): Promise<ProjectRuns[]> {
  return Promise.all(projects.map(async (project): Promise<ProjectRuns> => {
    let workflows: WorkflowDefinition[]
    try {
      workflows = await fetchWorkflows(project.project_id, signal)
    } catch (error) {
      if (signal?.aborted) throw error
      return { project, workflows: [], error }
    }
    return { project, workflows: await fetchWorkflowRuns(project.project_id, workflows, more, signal), error: null }
  }))
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

/** Only reviews published under this run's scoped `reviews/` route are fetched; anything else is refused. */
export function scopedReviewPath(scope: RunScope, resultUri: string): string | null {
  const prefix = `${paths.run(scope)}/reviews/`
  if (!resultUri.startsWith(prefix)) return null
  if (!/^[1-9][0-9]*$/.test(resultUri.slice(prefix.length))) return null
  return resultUri
}

export function fetchReviewResult(scope: RunScope, reviewPath: string, signal?: AbortSignal): Promise<ReviewResult> {
  return requestJson(reviewPath, input => {
    const review = validateReviewResult(input)
    if (review.run_id !== scope.runId) throw new Error(`the review belongs to run ${review.run_id}.`)
    return review
  }, signal)
}

export function fetchRunInputs(scope: RunScope, signal?: AbortSignal): Promise<RunInputs> {
  return requestJson(paths.inputs(scope), input => {
    const inputs = validateRunInputs(input)
    if (inputs.run_id !== scope.runId) throw new Error(`the inputs belong to run ${inputs.run_id}.`)
    return inputs
  }, signal)
}

/** The review sidecar's ledger (contract 1.6.0), live while the workers run: polled, never cached as immutable. */
export function fetchSidecarLedger(scope: RunScope, signal?: AbortSignal): Promise<SidecarLedger> {
  return requestJson(paths.sidecar(scope), input => {
    const ledger = validateSidecarLedger(input)
    if (ledger.run_id !== scope.runId) throw new Error(`the sidecar ledger belongs to run ${ledger.run_id}.`)
    return ledger
  }, signal)
}

/** The attack pass's record (contract 1.8.0), live while the pass runs: polled, never cached as immutable. */
export function fetchAttackResult(scope: RunScope, signal?: AbortSignal): Promise<AttackResult> {
  return requestJson(paths.attack(scope), input => {
    const result = validateAttackResult(input)
    if (result.run_id !== scope.runId) throw new Error(`the attack pass record belongs to run ${result.run_id}.`)
    return result
  }, signal)
}

/** Whether a failure is the contract's 404 for a section the run's export does not carry. */
export function isNotRecorded(error: unknown, code: string): boolean {
  return error instanceof ProjectsApiError && error.notFound && error.code === code
}

/** Resolves to null when the section is not recorded (the contract's 404 code); every other failure propagates. */
export async function orNotRecorded<T>(request: Promise<T>, code: string): Promise<T | null> {
  try {
    return await request
  } catch (error) {
    if (isNotRecorded(error, code)) return null
    throw error
  }
}
