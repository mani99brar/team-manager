/**
 * Worker-phase mocks for the not-yet-present projects backend. Only `/api/projects` and its nested routes
 * are intercepted; every other request (Pi/Claude listing, documents, mutations) reaches the real isolated
 * API. Responses are the explicit contract fixtures from `fixtures.ts`, plus contract-shaped 404s. Review
 * results and run inputs answer with the contract's `REVIEW_NOT_FOUND` / `INPUTS_NOT_FOUND` codes when a
 * run has none, exactly like the real adapter for exports that predate those sections.
 */
import type { Page, Route } from '@playwright/test'
import { artifactFiles, PROJECT, projectList, reviewResults, runDetails, runEvents, runInputs, runLists, workerResults, workflowLists } from './fixtures.ts'

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })
const notFound = (message: string, code = 'not_found') => json({ error: { code, message } }, 404)

export function isProjectsRequest(url: URL): boolean {
  return url.pathname === '/api/projects' || url.pathname.startsWith('/api/projects/')
}

/** Resolves one mocked projects API request; returns null for unknown paths under the prefix (404). */
export function mockResponse(url: URL): { status: number; contentType: string; body: string | Buffer } {
  const segments = url.pathname.split('/').filter(Boolean).slice(2).map(decodeURIComponent) // after /api/projects
  if (segments.length === 0) return json(projectList)
  const [projectId, workflowsLiteral, workflowId, runsLiteral, runId, ...rest] = segments
  const workflows = workflowLists[projectId]
  if (!workflows) return notFound(`Project "${projectId}" is not registered.`)
  if (workflowsLiteral !== 'workflows') return notFound('Unknown resource.')
  if (workflowId === undefined) return json(workflows)
  if (!workflows.workflows.some(workflow => workflow.workflow_id === workflowId)) return notFound(`Workflow "${workflowId}" does not belong to project "${projectId}".`)
  if (runsLiteral !== 'runs') return notFound('Unknown resource.')
  if (runId === undefined) {
    // Runs are listed per workflow (empty-flow and any other registered workflow without runs answer an empty page).
    return json(projectId === PROJECT.project_id ? runLists[workflowId] ?? { runs: [], next_cursor: null } : { runs: [], next_cursor: null })
  }
  const candidate = projectId === PROJECT.project_id ? runDetails[runId] : undefined
  const detail = candidate && candidate.summary.workflow_id === workflowId ? candidate : undefined
  if (!detail) return notFound(`Run "${runId}" was not found in workflow "${workflowId}".`)
  if (rest.length === 0) return json(detail)
  const [kind, ...tail] = rest
  if (kind === 'events' && tail.length === 0) {
    const after = Number(url.searchParams.get('after') ?? '0')
    return json({ events: runEvents[runId].filter(event => event.sequence > after) })
  }
  if (kind === 'results' && tail.length === 2) {
    const result = workerResults[runId][`${tail[0]}/${tail[1]}`]
    return result ? json(result) : notFound(`No result for ${tail[0]} attempt ${tail[1]}.`)
  }
  if (kind === 'reviews' && tail.length === 1) {
    const review = reviewResults[runId]
    return review && tail[0] === String(review.attempt)
      ? json(review)
      : notFound('No review is recorded for that attempt: either the review has not happened or the run export predates review results.', 'REVIEW_NOT_FOUND')
  }
  if (kind === 'inputs' && tail.length === 0) {
    const inputs = runInputs[runId]
    return inputs ? json(inputs) : notFound('No inputs are recorded for this run: its export predates run inputs.', 'INPUTS_NOT_FOUND')
  }
  if (kind === 'artifacts' && tail.length === 1) {
    const artifact = artifactFiles[runId].find(file => file.artifact_id === tail[0])
    return artifact ? { status: 200, contentType: artifact.contentType, body: artifact.content } : notFound(`Artifact "${tail[0]}" is not registered for this run.`)
  }
  return notFound('Unknown resource.')
}

export async function installProjectMocks(page: Page): Promise<void> {
  await page.route(url => isProjectsRequest(url), async (route: Route) => {
    const request = route.request()
    if (request.method() !== 'GET') {
      await route.fulfill(json({ error: { code: 'method_not_allowed', message: 'This surface is read-only.' } }, 405))
      return
    }
    await route.fulfill(mockResponse(new URL(request.url())))
  })
}
