/**
 * Worker-phase mocks for the not-yet-present projects backend. Only `/api/projects` and its nested routes
 * are intercepted; every other request (Pi/Claude listing, documents, mutations) reaches the real isolated
 * API. Responses are the explicit contract fixtures from `fixtures.ts`, plus contract-shaped 404s. Review
 * results, run inputs, the sidecar ledger, the attack pass's record and the panel record answer with the contract's
 * `REVIEW_NOT_FOUND` / `INPUTS_NOT_FOUND` / `SIDECAR_NOT_FOUND` / `ATTACK_NOT_FOUND` / `PANELS_NOT_FOUND` codes when a run has
 * none, exactly like the real adapter for exports that predate those sections.
 */
import type { Page, Route } from '@playwright/test'
import { artifactFiles, attackResults, panelResults, PROJECT, projectList, reviewResults, runDetails, runEvents, runInputs, runLists, sidecarLedgers, workerResults, workflowLists } from './fixtures.ts'
// Merges the viewer UX slices' runs (`fixtures/ux-*.ts`) into the maps above.
import './fixtures/index.ts'
import { CONTROLS_TOKEN, controlsFor } from './fixtures/controls.ts'
import type { ControlId, ControlRecord } from '../../src/projects/controls/types.ts'

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
  if (kind === 'sidecar' && tail.length === 0) {
    const ledger = sidecarLedgers[runId]
    return ledger ? json(ledger) : notFound('No review sidecar ledger is recorded for this run: it has no sidecar, no pass has run yet or its export predates the sidecar.', 'SIDECAR_NOT_FOUND')
  }
  if (kind === 'attack' && tail.length === 0) {
    const result = attackResults[runId]
    return result ? json(result) : notFound('No attack pass is recorded for this run: it has no attack pass, its record is not readable or its export predates the attack pass.', 'ATTACK_NOT_FOUND')
  }
  if (kind === 'panels' && tail.length === 0) {
    const result = panelResults[runId]
    return result ? json(result) : notFound('No panel is recorded for this run: it has no panels, its record is not readable or its export predates the multi-provider panel.', 'PANELS_NOT_FOUND')
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

/** What a worker-phase run-controls mock saw and can be told to answer differently. */
export type ControlMock = {
  /** Every POST to a control route, in order. */
  posts: { control: string; body: { request_id?: string; run_state_token?: string; params?: Record<string, unknown> } }[]
  /** The clean-preview POSTs and their bodies. */
  previews: unknown[]
  /** Answer the next POST of a control with an error instead of running it. */
  failNext: (control: ControlId, status: number, code: string, message: string) => void
  /** The run moved: the next controls read carries a new state token. */
  bump: () => void
}

/**
 * Mocks `/api/run-controls/**` for the worker phase from Appendix A's shapes: the status probe, a run's controls, the clean
 * preview, a control POST and the record read. A long control reads `running` for 2.5 s and then `succeeded`; any command on
 * a run whose id contains `refuse` fails with the controller's `Blocked:` line, as the fake controller does.
 */
export async function installControlMocks(page: Page, options: { enabled?: boolean; token?: string } = {}): Promise<ControlMock> {
  const enabled = options.enabled ?? true
  const token = options.token ?? CONTROLS_TOKEN
  const records: ControlRecord[] = []
  const failures = new Map<string, { status: number; code: string; message: string }>()
  let generation = 1
  const mock: ControlMock = {
    posts: [], previews: [],
    failNext: (control, status, code, message) => { failures.set(control, { status, code, message }) },
    bump: () => { generation += 1 },
  }
  const error = (status: number, code: string, message: string) => json({ error: { code, message } }, status)
  const settled = (record: ControlRecord, long: boolean): ControlRecord => (long && record.status === 'running' && Date.now() - Date.parse(record.started_at) > 2500
    ? { ...record, status: 'succeeded', exit_code: 0, ended_at: new Date().toISOString(), output_tail: [...record.output_tail, 'Automatic by the operator: supervisor started'] } : record)
  await page.route('**/api/run-controls/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const parts = url.pathname.split('/').filter(Boolean).slice(2).map(decodeURIComponent)
    const header = request.headers()['x-mdm-control-token']
    if (!enabled) {
      await route.fulfill(parts[0] === 'status' ? json({ version: '1.0.0', enabled: false, paired: false }) : error(404, 'CONTROLS_DISABLED', 'Run controls are off.'))
      return
    }
    if (parts[0] === 'status') { await route.fulfill(json({ version: '1.0.0', enabled: true, paired: header === token })); return }
    if (header === undefined) { await route.fulfill(error(403, 'TOKEN_REQUIRED', 'The pairing token is required.')); return }
    if (header !== token) { await route.fulfill(error(403, 'TOKEN_INVALID', 'The pairing token was refused.')); return }
    const [, , runId, tail, extra] = parts
    const state = `rs-${generation}`
    if (request.method() === 'GET' && tail === undefined) {
      const controls = controlsFor(runId, state, records.map(record => settled(record, true)).reverse())
      await route.fulfill(controls ? json(controls) : error(404, 'NOT_FOUND', 'The run was not found.'))
      return
    }
    if (request.method() === 'GET' && tail === 'records') {
      const record = records.find(item => item.record_id === extra)
      await route.fulfill(record ? json({ record: settled(record, true) }) : error(404, 'NOT_FOUND', 'The record was not found.'))
      return
    }
    const body = request.postDataJSON() as ControlMock['posts'][number]['body']
    if (tail === 'clean-preview') {
      mock.previews.push(body)
      await route.fulfill(json({ exitCode: 0, output: 'Would remove worktree-ui\nWould remove worktree-adapter\n' }))
      return
    }
    const id = tail as ControlId
    mock.posts.push({ control: id, body })
    const failure = failures.get(id)
    if (failure) { failures.delete(id); await route.fulfill(error(failure.status, failure.code, failure.message)); return }
    const controls = controlsFor(runId, state)
    const control = controls?.controls.find(item => item.id === id)
    if (!control || !control.available) { await route.fulfill(error(422, 'NOT_AVAILABLE', control?.reason ?? 'Not available.')); return }
    const refused = runId.includes('refuse')
    const long = control.runs === 'long' && !refused
    const now = new Date().toISOString()
    const { confirm_run_id: _typed, ...params } = (body.params ?? {}) as Record<string, unknown>
    void _typed
    const record: ControlRecord = {
      record_id: `c-${String(records.length + 1).padStart(12, '0')}`, request_id: body.request_id ?? '', control: id, params, command: control.command,
      status: refused ? 'failed' : long ? 'running' : 'succeeded', exit_code: refused ? 1 : long ? null : 0, started_at: now, ended_at: long ? null : now,
      output_tail: refused ? [`Blocked: ${id} refused for this run (the fake controller refuses every run named refuse)`, 'Nothing was changed.']
        : [long ? 'Supervisor starting' : id === 'answer' ? `Answer by the operator: recorded and typed into the lane's pane` : `${control.label} by the operator`],
    }
    records.push(record)
    generation += 1
    await route.fulfill(json({ record }, long ? 202 : 200))
  })
  return mock
}
