/**
 * Worker-phase mocks for the not-yet-present projects backend. Only `/api/projects` and its nested routes
 * are intercepted; every other request (Pi/Claude listing, documents, mutations) reaches the real isolated
 * API. Responses are the explicit contract fixtures from `fixtures.ts`, plus contract-shaped 404s. Review
 * results, run inputs, the sidecar ledger, the attack pass's record and the panel record answer with the contract's
 * `REVIEW_NOT_FOUND` / `INPUTS_NOT_FOUND` / `SIDECAR_NOT_FOUND` / `ATTACK_NOT_FOUND` / `PANELS_NOT_FOUND` codes when a run has
 * none, exactly like the real adapter for exports that predate those sections.
 */
import type { Page, Route } from '@playwright/test'
import { artifactFiles, attackResults, panelResults, projectList, reviewResults, runDetails, runEvents, runInputs, runLists, sidecarLedgers, workerResults, workflowLists } from './fixtures.ts'
// Merges the viewer UX slices' runs (`fixtures/ux-*.ts`) into the maps above.
import './fixtures/index.ts'
import { sessionsByRun } from './fixtures/index.ts'
import { injectSessionNodes } from './sessionProjection.ts'
import { CONTROLS_TOKEN, controlsFor, RELAUNCH_ALLOWED, RELAUNCH_LINES, RELAUNCH_REFUSED, RETRY_ALL_LINES } from './fixtures/controls.ts'
import { dispatchOverview, dispatchSteps, DISPATCH_RUN_COSTS, DISPATCH_UNLISTABLE_WORKFLOWS } from './fixtures/dispatch.ts'
import type { RunSummary } from '../../contracts/projects/v1.ts'
import type { ControlId, ControlRecord } from '../../src/projects/controls/types.ts'

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })
const notFound = (message: string, code = 'not_found') => json({ error: { code, message } }, 404)

export function isProjectsRequest(url: URL): boolean {
  return url.pathname === '/api/projects' || url.pathname.startsWith('/api/projects/')
}

export function isDispatchRequest(url: URL): boolean {
  return url.pathname === '/api/dispatch/projects' || url.pathname.startsWith('/api/dispatch/projects/') || url.pathname === '/api/dispatch/runs' || url.pathname === '/api/dispatch/runs/all'
}

type Mocked = { status: number; contentType: string; body: string | Buffer }
const parsed = (response: Mocked) => JSON.parse(String(response.body))
/** A per-workflow route's failure as the home read reports it: its status, code and message. */
const readError = (response: Mocked) => ({ status: response.status, ...(parsed(response).error as { code: string; message: string }) })

/**
 * The registry home read, assembled from the per-workflow routes this mock serves exactly as the client assembled it before
 * (`fetchRegistryRuns` with `readsNextPage(since)`): each project's workflow list, each workflow's pages back to `since`.
 */
function mockHomeRuns(since: number) {
  return projectList.projects.map(project => {
    const listed = mockResponse(new URL(`http://mock/api/projects/${encodeURIComponent(project.project_id)}/workflows`))
    if (listed.status !== 200) return { project_id: project.project_id, workflows: [], error: readError(listed), runs: [] }
    const workflows = parsed(listed).workflows as { workflow_id: string }[]
    return {
      project_id: project.project_id, workflows, error: null,
      runs: workflows.map(workflow => {
        const runs: RunSummary[] = []
        let next: string | null = null
        for (let pages = 0; pages < 100; pages++) {
          const page = mockResponse(new URL(`http://mock/api/projects/${encodeURIComponent(project.project_id)}/workflows/${encodeURIComponent(workflow.workflow_id)}/runs${next ? `?cursor=${encodeURIComponent(next)}` : ''}`))
          if (page.status !== 200) return { workflow_id: workflow.workflow_id, runs: [], next_cursor: null, error: readError(page) }
          const body = parsed(page) as { runs: RunSummary[]; next_cursor: string | null }
          runs.push(...body.runs)
          next = body.next_cursor
          const last = runs.at(-1)
          if (next === null || last === undefined || Date.parse(last.updated_at) < since) break
        }
        return { workflow_id: workflow.workflow_id, runs, next_cursor: next, error: null }
      }),
    }
  })
}

/** Every run of every workflow the mock lists, in the registry order, paged by a version-2 registry cursor. */
function mockRegistryRuns(url: URL): Mocked {
  const unreadable: { project_id: string; workflow_id: string; code: string }[] = []
  const all: RunSummary[] = []
  for (const project of mockHomeRuns(Number.NEGATIVE_INFINITY)) {
    for (const entry of project.runs) {
      if (entry.error !== null) unreadable.push({ project_id: project.project_id, workflow_id: entry.workflow_id, code: entry.error.code })
      else all.push(...entry.runs)
    }
  }
  const text = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  const order = (a: RunSummary, b: RunSummary) => Date.parse(b.updated_at) - Date.parse(a.updated_at) || text(a.project_id, b.project_id) || text(a.workflow_id, b.workflow_id) || text(a.run_id, b.run_id)
  all.sort(order)
  const cursor = url.searchParams.get('cursor')
  let start = 0
  if (cursor !== null) {
    let position: { u: string; p: string; w: string; r: string } | null
    try { position = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) } catch { position = null }
    if (position === null || (position as { v?: number }).v !== 2) return json({ error: { code: 'INVALID_CURSOR', message: 'The cursor is not a paging token issued for the registry run list.' } }, 400)
    const at = { updated_at: position.u, project_id: position.p, workflow_id: position.w, run_id: position.r } as RunSummary
    start = all.findIndex(run => order(run, at) > 0)
    if (start < 0) start = all.length
  }
  const limit = Number(url.searchParams.get('limit') ?? '50')
  const runs = all.slice(start, start + limit)
  const last = runs.at(-1)
  const next_cursor = start + limit < all.length && last ? Buffer.from(JSON.stringify({ v: 2, u: last.updated_at, p: last.project_id, w: last.workflow_id, r: last.run_id })).toString('base64url') : null
  return json({ contract_version: '1.0.0', read_at: new Date().toISOString(), runs, next_cursor, unreadable })
}

/** A project's Claude spend from the same fixture runs the per-workflow routes serve, and the costs the seed writes for them. */
function mockSpend(projectId: string) {
  let runs = 0
  let priced = 0
  let total = 0
  for (const entry of mockHomeRuns(Number.NEGATIVE_INFINITY).find(project => project.project_id === projectId)?.runs ?? []) {
    if (entry.error !== null) continue
    for (const run of entry.runs) {
      runs += 1
      const cost = DISPATCH_RUN_COSTS[`${run.project_id}/${run.workflow_id}/${run.run_id}`]
      if (typeof cost === 'number') { priced += 1; total += cost }
    }
  }
  return { claude_usd: priced === 0 ? null : Math.round(total * 1e6) / 1e6, priced_runs: priced, runs }
}

/**
 * Resolves a mocked dispatch request (docs/PRD_PROJECTS_DISPATCH.md Appendix A) in the worker phase, from `fixtures/dispatch.ts`.
 * The overview covers every registered project, in registry order; a project's steps are served per id. These live here (not in
 * `dispatch.spec.ts`) so every spec gets them and no spec's project page answers 404 for `/api/dispatch/**` ([design challenge note 1]).
 */
export function mockDispatchResponse(url: URL): { status: number; contentType: string; body: string | Buffer } {
  const segments = url.pathname.split('/').filter(Boolean).slice(2).map(decodeURIComponent) // after /api/dispatch
  if (segments.length === 1 && segments[0] === 'projects') {
    const overview = dispatchOverview(projectList.projects.map(project => project.project_id))
    return json({ ...overview, projects: overview.projects.map(entry => ({ ...entry, spend: mockSpend(entry.project_id) })) })
  }
  if (segments.length === 1 && segments[0] === 'runs') {
    const since = url.searchParams.get('since')
    const time = since === null || !/Z$/.test(since) ? Number.NaN : Date.parse(since)
    if (!Number.isFinite(time)) return json({ error: { code: 'INVALID_SINCE', message: 'The since parameter must be an ISO 8601 time with a Z offset.' } }, 400)
    return json({ contract_version: '1.0.0', read_at: new Date().toISOString(), since: new Date(time).toISOString(), projects: mockHomeRuns(time) })
  }
  if (segments.length === 2 && segments[0] === 'runs' && segments[1] === 'all') return mockRegistryRuns(url)
  if (segments.length === 3 && segments[0] === 'projects' && segments[2] === 'steps') {
    const steps = dispatchSteps(segments[1])
    return steps ? json(steps) : notFound(`Project "${segments[1]}" is not registered.`, 'NOT_FOUND')
  }
  return notFound('Unknown resource.', 'NOT_FOUND')
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
    // A workflow whose runs cannot be listed answers with a storage error, mirroring the candidate's unlistable `runs_root`
    // ([P34]): `fetchWorkflowRuns` records it as that workflow's error, so the project reads "N cannot be read" and the step
    // chart shows the workflow-level error row with the literal `<run-id>` placeholder (V18).
    if (DISPATCH_UNLISTABLE_WORKFLOWS.has(workflowId)) return json({ error: { code: 'RUNS_UNREADABLE', message: 'The runs directory of this workflow could not be listed.' } }, 500)
    // Runs are listed per workflow (empty-flow and any other registered workflow without runs answer an empty page). A workflow
    // from any registered project is served, so the dispatch fixtures' extra projects list their runs too ([P16]).
    return json(runLists[workflowId] ?? { runs: [], next_cursor: null })
  }
  // A run belongs to the project and workflow its summary names (run-sessions serves one run under the third project).
  const candidate = runDetails[runId]
  const detail = candidate && candidate.summary.project_id === projectId && candidate.summary.workflow_id === workflowId ? candidate : undefined
  if (!detail) return notFound(`Run "${runId}" was not found in workflow "${workflowId}".`)
  // run-sessions: the mock projects the same reviewer/panel/lane-review nodes the real server would, for every run, so both
  // phases show the same `data-node-id` set (the parity test proves the sets match before any stage spec is updated).
  if (rest.length === 0) return json(injectSessionNodes(detail))
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
  if (kind === 'sessions' && tail.length === 0) {
    const result = sessionsByRun[runId]
    return result ? json(result) : notFound('No run with that ID exists in this workflow.', 'RUN_NOT_FOUND')
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
  await page.route(url => isDispatchRequest(url), async (route: Route) => {
    const request = route.request()
    if (request.method() !== 'GET') {
      await route.fulfill(json({ error: { code: 'method_not_allowed', message: 'This surface is read-only.' } }, 405))
      return
    }
    await route.fulfill(mockDispatchResponse(new URL(request.url())))
  })
}

/** What a worker-phase run-controls mock saw and can be told to answer differently. */
export type ControlMock = {
  /** Every POST to a control route, in order. */
  posts: { control: string; body: { request_id?: string; run_state_token?: string; params?: Record<string, unknown> } }[]
  /** The clean-preview POSTs and their bodies. */
  previews: unknown[]
  /** The relaunch-preview POSTs and their bodies (`{ run_state_token, lane }`). */
  relaunchPreviews: unknown[]
  /** Answer the next POST of a control (or of the relaunch dry run) with an error instead of running it; STATE_CHANGED also moves the run. */
  failNext: (control: ControlId | 'relaunch-preview', status: number, code: string, message: string) => void
  /** The run moved: the next controls read carries a new state token. */
  bump: () => void
}

/**
 * Mocks `/api/run-controls/**` for the worker phase from Appendix A's shapes: the status probe, a run's controls, the clean
 * preview, a control POST and the record read. A long control reads `running` for 2.5 s and then `succeeded`; any command on
 * a run whose id contains `refuse` fails with the controller's `Blocked:` line, as the fake controller does.
 */
export async function installControlMocks(page: Page, options: { enabled?: boolean; token?: string; older?: boolean } = {}): Promise<ControlMock> {
  const enabled = options.enabled ?? true
  const token = options.token ?? CONTROLS_TOKEN
  const records: ControlRecord[] = []
  const failures = new Map<string, { status: number; code: string; message: string }>()
  let generation = 1
  const mock: ControlMock = {
    posts: [], previews: [], relaunchPreviews: [],
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
      await route.fulfill(parts[0] === 'status' ? json({ version: '1.1.0', enabled: false, paired: false }) : error(404, 'CONTROLS_DISABLED', 'Run controls are off.'))
      return
    }
    if (parts[0] === 'status') { await route.fulfill(json({ version: '1.1.0', enabled: true, paired: header === token })); return }
    if (header === undefined) { await route.fulfill(error(403, 'TOKEN_REQUIRED', 'The pairing token is required.')); return }
    if (header !== token) { await route.fulfill(error(403, 'TOKEN_INVALID', 'The pairing token was refused.')); return }
    const [, , runId, tail, extra] = parts
    const state = `rs-${generation}`
    if (request.method() === 'GET' && tail === undefined) {
      const controls = controlsFor(runId, state, records.map(record => settled(record, true)).reverse(), { older: options.older })
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
    if (tail === 'relaunch-preview') {
      mock.relaunchPreviews.push(body)
      const failed = failures.get('relaunch-preview')
      if (failed) {
        failures.delete('relaunch-preview')
        if (failed.code === 'STATE_CHANGED') generation += 1
        await route.fulfill(error(failed.status, failed.code, failed.message))
        return
      }
      const lane = (body as { lane?: string }).lane ?? ''
      const relaunch = controlsFor(runId, state, [], { older: options.older })?.controls.find(item => item.id === 'relaunch')
      if (!relaunch?.available) { await route.fulfill(error(422, 'NOT_AVAILABLE', relaunch?.reason ?? 'Not available.')); return }
      const choices = relaunch.params.find(param => param.name === 'lane')
      if (!choices || !(choices.choices as string[]).includes(lane)) { await route.fulfill(error(400, 'INVALID_PARAMS', 'The lane is not one of the offered choices.')); return }
      const refused = runId.includes('refuse')
      await route.fulfill(json({ exitCode: refused ? 1 : 0, line: (refused ? RELAUNCH_REFUSED : RELAUNCH_ALLOWED).replace(' ui', ` ${lane}`) }))
      return
    }
    const id = tail as ControlId
    mock.posts.push({ control: id, body })
    const failure = failures.get(id)
    if (failure) { failures.delete(id); await route.fulfill(error(failure.status, failure.code, failure.message)); return }
    const controls = controlsFor(runId, state, [], { older: options.older })
    const control = controls?.controls.find(item => item.id === id)
    if (!control || !control.available) { await route.fulfill(error(422, 'NOT_AVAILABLE', control?.reason ?? 'Not available.')); return }
    const refused = runId.includes('refuse')
    const long = control.runs === 'long' && !refused
    // The two 1.1.0 commands print the engine's lines (the fake controller's in the candidate phase).
    const engine = (lines: readonly string[]) => lines.map(line => line.replace('{python}', '$PY').replace('{run}', `~/runs/${runId}`))
    const recovered = id === 'retry_all' ? engine(RETRY_ALL_LINES) : id === 'relaunch' ? engine(RELAUNCH_LINES) : null
    const now = new Date().toISOString()
    const { confirm_run_id: _typed, ...params } = (body.params ?? {}) as Record<string, unknown>
    void _typed
    const record: ControlRecord = {
      record_id: `c-${String(records.length + 1).padStart(12, '0')}`, request_id: body.request_id ?? '', control: id, params, command: id === "relaunch" && typeof params.lane === "string" ? control.command.replace("<lane>", params.lane) : control.command,
      status: refused ? 'failed' : long ? 'running' : 'succeeded', exit_code: refused ? 1 : long ? null : 0, started_at: now, ended_at: long ? null : now,
      output_tail: refused ? [`Blocked: ${id} refused for this run (the fake controller refuses every run named refuse)`, 'Nothing was changed.']
        : recovered ?? [long ? 'Supervisor starting' : id === 'answer' ? `Answer by the operator: recorded and typed into the lane's pane` : `${control.label} by the operator`],
    }
    records.push(record)
    generation += 1
    await route.fulfill(json({ record }, long ? 202 : 200))
  })
  return mock
}
