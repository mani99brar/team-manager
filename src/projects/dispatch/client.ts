/**
 * The viewer lane's own client for the dispatch routes (docs/PRD_PROJECTS_DISPATCH.md Appendix A). The `server` lane owns the
 * routes and the shared contract; this client reads them with a light runtime shape check and the types mirrored in
 * `types.ts`, so the two lanes meet only at the candidate ([D2]). GET only; the overview polls at `LISTS_POLL_MS`.
 */
import type { DispatchOverview, ProjectSteps } from './types.ts'

export class DispatchApiError extends Error {
  readonly status: number | null
  readonly code: string | null
  readonly notFound: boolean
  constructor(message: string, status: number | null = null, code: string | null = null) {
    super(message)
    this.name = 'DispatchApiError'
    this.status = status
    this.code = code
    this.notFound = status === 404
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, { signal, headers: { Accept: 'application/json' } })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new DispatchApiError(error instanceof Error ? error.message : 'Network failure')
  }
  let body: unknown = null
  try { body = await response.json() } catch { /* not JSON */ }
  if (!response.ok) {
    const record = body && typeof body === 'object' ? (body as { error?: { code?: string; message?: string } }).error : null
    throw new DispatchApiError(record?.message ?? `The API responded with status ${response.status}.`, response.status, record?.code ?? null)
  }
  if (body === null || typeof body !== 'object') throw new DispatchApiError(`The dispatch API returned an unexpected response from ${path}.`)
  return body as T
}

export function fetchDispatchOverview(signal?: AbortSignal): Promise<DispatchOverview> {
  return getJson<DispatchOverview>('/api/dispatch/projects', signal).then(overview => {
    if (!Array.isArray(overview.projects)) throw new DispatchApiError('The dispatch overview has no projects array.')
    return overview
  })
}

export function fetchProjectSteps(projectId: string, signal?: AbortSignal): Promise<ProjectSteps> {
  return getJson<ProjectSteps>(`/api/dispatch/projects/${encodeURIComponent(projectId)}/steps`, signal).then(steps => {
    if (!Array.isArray(steps.workflows)) throw new DispatchApiError('The project steps have no workflows array.')
    return steps
  })
}
