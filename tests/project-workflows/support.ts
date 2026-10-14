/**
 * Helpers shared by the Projects viewer specs: URL builders, locators for the run view, the screenshot
 * attachment every scenario records, the per-test setup (isolated API up, mocks in worker mode) and the
 * redaction assertion used by the `paths-redacted` scenarios.
 */
import { test, expect, type APIRequestContext, type Locator, type Page, type Route, type TestInfo } from '@playwright/test'
import { waitForApi } from '../helpers.ts'
import { apiRunPath, PROJECT, WORKFLOW_ID } from './fixtures.ts'
import { verificationPhase } from './harness.ts'
import { installProjectMocks, mockDispatchResponse, mockResponse } from './mock.ts'
import { B_PROJECTS, bDefinition, bSummary } from './fixtures/ux-lists.ts'

export const phase = verificationPhase()

export const projectsUrl = '/projects'
/** Triage, the former Runs home, now under `/projects/-/triage` ([D1]). */
export const triageUrl = '/projects/-/triage'
export const projectUrl = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`
export const workflowUrl = (projectId: string, workflowId: string) => `${projectUrl(projectId)}/workflows/${encodeURIComponent(workflowId)}`
export const runUrl = (runId: string, nodeId?: string, workflowId: string = WORKFLOW_ID) => `${workflowUrl(PROJECT.project_id, workflowId)}/runs/${encodeURIComponent(runId)}${nodeId ? `/nodes/${encodeURIComponent(nodeId)}` : ''}`
export const apiRun = apiRunPath

export const workspace = (page: Page) => page.getByTestId('projects-workspace')
export const graphNode = (page: Page, nodeId: string) => page.locator(`[data-testid="workflow-graph"] [data-graph-node="${nodeId}"]`)
export const nodeListItem = (page: Page, nodeId: string) => page.locator(`[data-testid="run-node-list"] [data-node-id="${nodeId}"]`)
export const nodeDetail = (page: Page) => page.getByTestId('node-detail')
export const taskDetails = (page: Page) => page.getByTestId('task-details')
/** The run page's step sheet (the Signal Box design): opened by selecting a card on the stage. */
export const stepSheet = (page: Page) => page.getByTestId('node-sheet')
/** The run page's live dock: the Now banner (`run-now`), the latest events and the figures live inside it. */
export const liveDock = (page: Page) => page.getByTestId('live-dock')

/** Opens a step's sheet from the stage: the card is clicked where it lies (a card behind the dock or off the stage still opens). */
export async function openStepSheet(page: Page, nodeId: string) {
  await expect(graphNode(page, nodeId)).toHaveCount(1)
  await graphNode(page, nodeId).dispatchEvent('click')
  await expect(stepSheet(page)).toHaveAttribute('data-node-id', nodeId)
}

/** Opens a step's page from the run page: its sheet, then "Open step page". */
export async function openStep(page: Page, nodeId: string) {
  await openStepSheet(page, nodeId)
  await stepSheet(page).getByTestId('sheet-open-page').click()
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', nodeId)
}

/** The identity line keeps the pinned facts (branch, base commit, mode, deadlines, times) behind Details; this opens it. */
export async function openRunDetails(page: Page) {
  const details = page.getByTestId('run-details')
  if ((await details.getAttribute('open')) === null) await details.locator('summary').click()
  await expect(details).toHaveAttribute('open', '')
}

/** A launch node shows its task behind a disclosure, closed by default (PRD_VIEWER_CLARITY 4.2); this opens it. */
export async function openTask(page: Page) {
  await expect(taskDetails(page)).toBeVisible()
  if ((await taskDetails(page).getAttribute('open')) === null) await taskDetails(page).locator('summary').first().click()
  await expect(taskDetails(page)).toHaveAttribute('open', '')
}

/** No view action may launch, approve, retry, delete or edit a run: no such real controls exist (graph nodes are read-only selectors). */
export async function expectNoExecutionControls(page: Page) {
  // The stage's step cards, the dock's event rows and the dock bar are buttons that only select a step; their text names steps
  // ("Launch UI worker", "Integrate candidate"), so they are left out of the wording check.
  const controls = workspace(page).locator('button:not([data-graph-node]):not([data-go]):not([data-testid="live-dock-bar"]), input, select, textarea, [role="menuitem"]')
  // The filter bar's "Cancelled" status toggle and its "Stopped at" phase select name a status and the phases; exactly those
  // two elements are exempt, and only while their text is exactly that.
  await expect.poll(() => executionControlCount(controls.filter({ hasText: EXECUTION_WORDS }))).toBe(0)
  await expect(page.locator('form')).toHaveCount(0)
}

/** The words no read-only control may carry. */
export const EXECUTION_WORDS = /approve|retry|launch|start|resume|delete|cancel|integrate|edit|save/i
/** The "Stopped at" select's exact options: "Any step", then the phases in order. */
export const PHASE_OPTIONS = ['Any step', 'Challenge', 'Launch', 'Freeze', 'Verify', 'Candidate', 'Review', 'Approval', 'Integrate']

/**
 * How many of the given controls carry an execution word, leaving out exactly the filter bar's two exempt elements: the
 * status toggle whose whole text is "Cancelled" (with its count), and the `run-filter-phase` select whose options are exactly
 * `PHASE_OPTIONS`. Any other control inside or outside the bar is counted.
 */
export async function executionControlCount(controls: Locator): Promise<number> {
  return controls.evaluateAll((elements, options) => elements.filter(element => {
    const inBar = element.closest('[data-testid="run-filter"]') !== null
    const text = (element.textContent ?? '').trim()
    if (inBar && element.tagName === 'BUTTON' && element.getAttribute('data-filter') === 'cancelled' && /^Cancelled( \d+)?$/.test(text)) return false
    if (inBar && element.tagName === 'SELECT' && element.getAttribute('data-testid') === 'run-filter-phase') {
      const labels = [...element.querySelectorAll('option')].map(option => (option.textContent ?? '').trim())
      if (labels.length === options.length && labels.every((label, index) => label === options[index])) return false
    }
    return true
  }).length, PHASE_OPTIONS)
}

/**
 * The project page's scoped read-only check: the filter bar's controls (under the two exemptions above) and every "Show
 * runs" / "Hide runs" disclosure carry no execution word. The step chart's run-select rows act on no run and stay outside it.
 */
export async function expectNoProjectPageExecutionControls(page: Page) {
  const scoped = workspace(page).locator('[data-testid="run-filter"] button, [data-testid="run-filter"] input, [data-testid="run-filter"] select, button[data-testid="dispatch-feature-toggle"]')
  await expect(scoped.first()).toBeVisible()
  await expect.poll(() => executionControlCount(scoped.filter({ hasText: EXECUTION_WORDS }))).toBe(0)
  await expect(page.locator('form')).toHaveCount(0)
}

export async function attach(page: Page, testInfo: TestInfo, id: string) {
  const image = testInfo.outputPath(`${id}.png`)
  await page.screenshot({ path: image, fullPage: true })
  await testInfo.attach(`screenshot:${id}`, { path: image, contentType: 'image/png' })
}

export async function waitForProjectsApi(request: APIRequestContext) {
  if (phase !== 'candidate') return
  await expect.poll(async () => (await request.get('/api/projects')).status(), { timeout: 30_000 }).toBe(200)
}

/** Registers the suite's shared per-test setup; call once at the top level of a spec file. */
export function installHooks() {
  test.beforeEach(async ({ page, request }) => {
    await waitForApi(request)
    await waitForProjectsApi(request)
    if (phase === 'worker') await installProjectMocks(page)
  })
}

/** Reads the rendered text and asserts no absolute filesystem path (temporary root or home) leaked into it. */
export async function renderedText(locator: Locator): Promise<string> {
  const text = await locator.innerText()
  expect(text, 'rendered text must not name a temporary or home directory').not.toMatch(/\/tmp\/|\/home\//)
  return text
}

/** Fetches a URL from inside the page, so worker-mode route mocks apply exactly as they do for the app. */
export async function fetchFromPage(page: Page, url: string): Promise<{ status: number; contentType: string | null; text: string }> {
  return page.evaluate(async target => {
    const response = await fetch(target)
    return { status: response.status, contentType: response.headers.get('content-type'), text: await response.text() }
  }, url)
}

/**
 * Serves the lists' own world (`fixtures/ux-lists.ts` `B_PROJECTS`) by page.route in both phases: the projects appended to
 * the registry's answer (the mocks' in the worker phase, the real API's in the candidate phase), their workflows, run pages
 * (page 2 behind a cursor where a workflow has one; `page2Error` makes it answer 500 while it returns true), steps (no
 * recorded steps) and dispatch entries (git read, no GitHub remote). An unreadable workflow's run list answers 500. Every
 * other request goes to the phase's own server or mocks.
 */
export async function installListsWorld(page: Page, options: { page2Error?: () => boolean } = {}) {
  const projects = new Map(B_PROJECTS.map(project => [project.project_id, project]))
  const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })
  const passOn = async (route: Route) => (phase === 'worker' ? JSON.parse(String(mockResponse(new URL(route.request().url())).body)) : (await route.fetch()).json())
  // A read still in flight when its test ends has nobody to answer: it is dropped, never reported as the test's error.
  const ended = (handler: (route: Route) => Promise<unknown>) => async (route: Route) => { try { await handler(route) } catch { /* the test ended */ } }
  await page.route(url => url.pathname === '/api/projects', ended(async route => {
    const body = await passOn(route) as { projects: { project_id: string; name: string }[] }
    await route.fulfill(json({ projects: [...body.projects, ...B_PROJECTS.map(project => ({ project_id: project.project_id, name: project.name }))] }))
  }))
  await page.route(url => /^\/api\/projects\/lists-b-[^/]+\/workflows(\/|$)/.test(url.pathname), async route => {
    const url = new URL(route.request().url())
    const [, , , projectId, , workflowId, runsLiteral, ...rest] = url.pathname.split('/')
    const project = projects.get(decodeURIComponent(projectId))
    if (!project) return route.fulfill(json({ error: { code: 'NOT_FOUND', message: 'Unknown project.' } }, 404))
    if (workflowId === undefined || workflowId === '') return route.fulfill(json({ workflows: project.workflows.map(workflow => bDefinition(project.project_id, workflow.workflow_id)) }))
    const workflow = project.workflows.find(item => item.workflow_id === decodeURIComponent(workflowId))
    if (!workflow || runsLiteral !== 'runs') return route.fulfill(json({ error: { code: 'NOT_FOUND', message: 'Unknown resource.' } }, 404))
    if (rest.length > 0) return route.fulfill(json({ error: { code: 'RUN_NOT_FOUND', message: 'No run with that ID exists in this workflow.' } }, 404))
    if (workflow.unreadable) return route.fulfill(json({ error: { code: 'RUNS_UNREADABLE', message: 'The runs directory of this workflow could not be listed.' } }, 500))
    const cursor = url.searchParams.get('cursor')
    if (cursor === null) return route.fulfill(json({ runs: workflow.runs.map(run => bSummary(project.project_id, workflow.workflow_id, run)), next_cursor: workflow.page2 ? 'page-2' : null }))
    if (options.page2Error?.()) return route.fulfill(json({ error: { code: 'INTERNAL', message: 'The next page could not be read.' } }, 500))
    return route.fulfill(json({ runs: (workflow.page2 ?? []).map(run => bSummary(project.project_id, workflow.workflow_id, run)), next_cursor: null }))
  })
  await page.route(url => /^\/api\/dispatch\/projects\/lists-b-[^/]+\/steps$/.test(url.pathname), async route => {
    const projectId = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[4])
    const project = projects.get(projectId)
    await route.fulfill(json({ contract_version: '1.0.0', project_id: projectId, workflows: (project?.workflows ?? []).map(workflow => ({ workflow_id: workflow.workflow_id, error: null, runs: [], errors: [] })) }))
  })
  await page.route(url => url.pathname === '/api/dispatch/projects', ended(async route => {
    const body = phase === 'worker' ? JSON.parse(String(mockDispatchResponse(new URL(route.request().url())).body)) : await (await route.fetch()).json()
    const readAt = body.read_at as string
    const entries = B_PROJECTS.map(project => ({
      project_id: project.project_id,
      git: { status: 'read', reason: null, repository_label: `~/dev/${project.project_id}`, checkout: 'main', head: 'd'.repeat(40), default_branch: 'main', clone_id: `${project.project_id}-clone`.slice(0, 12), clone_primary: project.project_id, origin: null, ahead_commits: [], ahead_naming_run: 0, landings: [], read_at: readAt },
      github: { status: 'not_github', reason: 'not a GitHub remote', repo: null, read_at: null, visibility: null, default_branch: null, pushed_at: null, head: null, open_prs: null, open_issues: null, prs: [], issues: [] },
    }))
    await route.fulfill(json({ ...body, projects: [...body.projects, ...entries] }))
  }))
}

/** Opens every feature of the project page shown ("Show runs") once its run lists are read, so its run rows are on the page. */
export async function openAllFeatures(page: Page) {
  await expect(page.getByTestId('dispatch-features').locator('li[data-workflow-id]').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('dispatch-needs-loading')).toHaveCount(0, { timeout: 30_000 })
  const closed = page.locator('button[data-testid="dispatch-feature-toggle"][aria-expanded="false"]')
  for (let left = await closed.count(); left > 0; left = await closed.count()) await closed.first().click()
}

/** Goes to a project page and opens every feature (see `openAllFeatures`). */
export async function gotoProjectOpen(page: Page, url: string) {
  await page.goto(url)
  await openAllFeatures(page)
}
