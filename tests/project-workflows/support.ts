/**
 * Helpers shared by the Projects viewer specs: URL builders, locators for the run view, the screenshot
 * attachment every scenario records, the per-test setup (isolated API up, mocks in worker mode) and the
 * redaction assertion used by the `paths-redacted` scenarios.
 */
import { test, expect, type APIRequestContext, type Locator, type Page, type TestInfo } from '@playwright/test'
import { waitForApi } from '../helpers.ts'
import { apiRunPath, PROJECT, WORKFLOW_ID } from './fixtures.ts'
import { verificationPhase } from './harness.ts'
import { installProjectMocks } from './mock.ts'

export const phase = verificationPhase()

export const projectsUrl = '/projects'
export const projectUrl = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`
export const workflowUrl = (projectId: string, workflowId: string) => `${projectUrl(projectId)}/workflows/${encodeURIComponent(workflowId)}`
export const runUrl = (runId: string, nodeId?: string, workflowId: string = WORKFLOW_ID) => `${workflowUrl(PROJECT.project_id, workflowId)}/runs/${encodeURIComponent(runId)}${nodeId ? `/nodes/${encodeURIComponent(nodeId)}` : ''}`
export const apiRun = apiRunPath

export const workspace = (page: Page) => page.getByTestId('projects-workspace')
export const graphNode = (page: Page, nodeId: string) => page.locator(`[data-testid="workflow-graph"] [data-graph-node="${nodeId}"]`)
export const nodeListItem = (page: Page, nodeId: string) => page.locator(`[data-testid="run-node-list"] [data-node-id="${nodeId}"]`)
export const nodeDetail = (page: Page) => page.getByTestId('node-detail')

/** No view action may launch, approve, retry, delete or edit a run: no such real controls exist (graph nodes are read-only selectors). */
export async function expectNoExecutionControls(page: Page) {
  const controls = workspace(page).locator('button, input, select, textarea, [role="menuitem"]')
  await expect(controls.filter({ hasText: /approve|retry|launch|start|resume|delete|cancel|integrate|edit|save/i })).toHaveCount(0)
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
