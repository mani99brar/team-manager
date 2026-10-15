/**
 * The server lane's stage C scenarios over the dispatch seeds (features/ux-critique-fixes-c/prd.md 7.3 and 7.7): the project
 * header's Claude spend from the runs' recorded costs, and the reuse evidence the server now serves for a reused candidate
 * packet. Worker phase: the mocks serve the same spend from the same fixture runs; candidate phase: the real server reads the
 * seeded exports and packets (`fixtures/dispatch.ts`).
 */
import { test, expect, type Page } from '@playwright/test'
import { REUSE_MESSAGE, RUN_FAILED } from './fixtures.ts'
import {
  DISPATCH_NOORIGIN, DISPATCH_PROJECTS, DISPATCH_SPEND, DISPATCH_WIDGETS, REUSE_WORKFLOW, RUN_NOT_REUSED, RUN_REUSED, SPEND_RUN_COSTS, SPEND_RUNS, SPEND_WORKFLOW,
} from './fixtures/dispatch.ts'
import { attach, installHooks, nodeDetail, phase, projectUrl, runUrl } from './support.ts'

installHooks()

const figures = (page: Page) => page.getByTestId('dispatch-figures')
const spendFigure = (page: Page) => page.getByTestId('dispatch-spend')
const isOverview = (url: URL) => url.pathname === '/api/dispatch/projects'

/** The seeded Spend project, by value: the recorded totals summed to the cent, the runs with a total, every run of its readable workflows. */
const PRICED = Object.values(SPEND_RUN_COSTS).filter((cost): cost is number => typeof cost === 'number')
const SPEND_TEXT = `$${PRICED.reduce((sum, cost) => sum + cost, 0).toFixed(2)} Claude spend · ${PRICED.length} of ${SPEND_RUNS.length + [RUN_REUSED, RUN_NOT_REUSED].length} runs priced`

test(`[scenario:project-spend] A project's header states its recorded Claude spend and how many runs were priced; none before the overview settles; "no Claude spend recorded" without costs (${phase})`, async ({ page }, testInfo) => {
  test.slow()
  await page.setViewportSize({ width: 1440, height: 900 })
  expect(SPEND_TEXT).toBe('$3.73 Claude spend · 3 of 7 runs priced')
  // Before the overview read settles there is no spend figure, and never the old literal.
  let release = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  const hold = async (route: import('@playwright/test').Route) => { await held; await route.fallback().catch(() => undefined) }
  await page.route(isOverview, hold)
  await page.goto(projectUrl(DISPATCH_SPEND))
  await expect(figures(page)).toBeVisible({ timeout: 30_000 })
  await expect(spendFigure(page)).toHaveCount(0)
  await expect(page.getByText('spend not recorded', { exact: false })).toHaveCount(0)
  const before = await figures(page).locator('.dispatch-fig').allInnerTexts()
  release()
  await expect(spendFigure(page)).toHaveText(SPEND_TEXT, { timeout: 30_000 })
  // The figures' other entries are unchanged: the same ones, in the same order, with the spend after them.
  const after = await figures(page).locator('.dispatch-fig').allInnerTexts()
  expect(after.slice(0, -1)).toEqual(before)
  expect(after.at(-1)).toBe(SPEND_TEXT)
  expect(after.some(text => /\bsucceeded\b/.test(text))).toBe(true)
  await attach(page, testInfo, 'project-spend')
  await page.unroute(isOverview, hold)

  // A project whose runs record no cost.
  for (const projectId of [DISPATCH_WIDGETS, DISPATCH_NOORIGIN]) {
    await page.goto(projectUrl(projectId))
    await expect(spendFigure(page)).toHaveText('no Claude spend recorded', { timeout: 30_000 })
  }
})

/** The overview this page was served (through the worker phase's mock, or the real server), read in the page. */
async function servedSpend(page: Page): Promise<Map<string, unknown>> {
  const overview = await page.evaluate(async () => (await fetch('/api/dispatch/projects')).json()) as { projects: { project_id: string; spend?: unknown }[] }
  return new Map(overview.projects.map(project => [project.project_id, project.spend ?? null]))
}

test(`No project header reads "spend not recorded"; every header whose overview spend is not null says what was recorded (${phase})`, async ({ page }) => {
  test.slow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(projectUrl(DISPATCH_SPEND))
  const spend = await servedSpend(page)
  expect([...spend.values()].some(value => value !== null), 'the overview serves a spend').toBe(true)
  for (const project of DISPATCH_PROJECTS) {
    await page.goto(projectUrl(project.project_id))
    await expect(page.getByTestId('dispatch-project-header')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('dispatch-project-header')).not.toContainText('spend not recorded')
    if ((spend.get(project.project_id) ?? null) === null) continue
    await expect(spendFigure(page), project.project_id).toHaveText(/^(\$\d+\.\d{2} Claude spend · \d+ of \d+ runs priced|no Claude spend recorded)$/, { timeout: 30_000 })
  }
})

test(`A project whose runs are all running and none waits still states its recorded spend (${phase})`, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(projectUrl(DISPATCH_SPEND))
  await expect(spendFigure(page)).toHaveText(SPEND_TEXT, { timeout: 30_000 })
  // The Spend project's readable run lists as served, every run turned running with nothing finished and nothing waiting.
  const lists = new Map<string, unknown>()
  for (const workflowId of [SPEND_WORKFLOW, REUSE_WORKFLOW]) {
    const list = await page.evaluate(async url => (await fetch(url)).json(), `/api/projects/${DISPATCH_SPEND}/workflows/${workflowId}/runs`) as { runs: Record<string, unknown>[] }
    expect(list.runs.length, workflowId).toBeGreaterThan(0)
    lists.set(workflowId, {
      ...list,
      runs: list.runs.map(run => {
        const activity = run.activity as Record<string, unknown> & { focus: Record<string, unknown> | null }
        return { ...run, status: 'running', accepted: undefined,
          activity: { ...activity, finished_at: null, attention: null, waiting_questions: 0, focus: activity.focus && { ...activity.focus, status: 'running' } } }
      }),
    })
  }
  // Registered after the harness mock, so it answers first.
  await page.route(url => url.pathname.startsWith(`/api/projects/${DISPATCH_SPEND}/workflows/`) && url.pathname.endsWith('/runs'), async route => {
    const workflowId = new URL(route.request().url()).pathname.split('/')[5]
    const list = lists.get(workflowId)
    if (list === undefined) return route.fallback()
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(list) })
  })
  await page.goto(projectUrl(DISPATCH_SPEND))
  await expect(page.getByTestId('dispatch-project-header')).toBeVisible({ timeout: 30_000 })
  await expect(spendFigure(page)).toHaveText(SPEND_TEXT, { timeout: 30_000 })
  await expect(figures(page)).not.toContainText('succeeded')
  await expect(figures(page)).not.toContainText('waits on you')
})

const spendRunUrl = (runId: string, nodeId: string) => `${projectUrl(DISPATCH_SPEND)}/workflows/${REUSE_WORKFLOW}/runs/${runId}/nodes/${nodeId}`

test(`[scenario:reuse-evidence] A reused candidate packet is served as reuse evidence on the candidate node; a run without reuse shows none (${phase})`, async ({ page }, testInfo) => {
  test.slow()
  await page.setViewportSize({ width: 1440, height: 900 })
  if (phase === 'candidate') {
    await page.goto(spendRunUrl(RUN_REUSED, 'candidate'))
    await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'candidate', { timeout: 30_000 })
    const reuse = page.getByTestId('reuse-list')
    await expect(reuse).toContainText('Attempt 1 reused the result of attempt 1', { timeout: 30_000 })
    await expect(reuse).toContainText('worker checks reused from verification/worker/ui/1/packet.json')
    await expect(reuse.locator('li')).toHaveCount(1)
    await attach(page, testInfo, 'reuse-evidence')
    await page.goto(spendRunUrl(RUN_NOT_REUSED, 'candidate'))
    await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'candidate', { timeout: 30_000 })
    await expect(page.getByTestId('node-detail')).toBeVisible()
    await expect(page.getByTestId('reuse-list')).toHaveCount(0)
  } else {
    // The worker phase's mocked reuse event on verify_ui still renders.
    await page.goto(runUrl(RUN_FAILED, 'verify_ui'))
    await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'verify_ui', { timeout: 30_000 })
    await expect(page.getByTestId('reuse-list')).toContainText(REUSE_MESSAGE)
    await expect(page.getByTestId('reuse-list')).toContainText('Attempt 2 reused the result of attempt 1')
    await attach(page, testInfo, 'reuse-evidence')
  }
})

test(`The events of a reused run are served once each, the reuse row typed result_reused with the reused worker result's route (${phase})`, async ({ page }) => {
  test.skip(phase !== 'candidate', 'the worker phase mocks the events; the server derives them from the seeded packets')
  await page.goto(projectUrl(DISPATCH_SPEND))
  const events = await page.evaluate(async url => (await fetch(url)).json(), `/api/projects/${DISPATCH_SPEND}/workflows/${REUSE_WORKFLOW}/runs/${RUN_REUSED}/events`) as { events: { sequence: number; type: string; reused_from_attempt: number | null; result_uri: string | null }[] }
  const reused = events.events.filter(event => event.type === 'result_reused')
  expect(reused).toHaveLength(1)
  expect(reused[0].reused_from_attempt).toBe(1)
  expect(reused[0].result_uri).toBe(`/api/projects/${DISPATCH_SPEND}/workflows/${REUSE_WORKFLOW}/runs/${RUN_REUSED}/results/ui/1`)
  expect(new Set(events.events.map(event => event.sequence)).size).toBe(events.events.length)
  const plain = await page.evaluate(async url => (await fetch(url)).json(), `/api/projects/${DISPATCH_SPEND}/workflows/${REUSE_WORKFLOW}/runs/${RUN_NOT_REUSED}/events`) as { events: { type: string }[] }
  expect(plain.events.filter(event => event.type === 'result_reused')).toHaveLength(0)
})
