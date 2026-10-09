/**
 * Viewer-refine's run page (docs/PRD_VIEWER_REFINE §5), on the Signal Box run page: the run page opens on an answer (the
 * identity line and the live dock), the stage draws the in-run fix loop, the Assignment view is one setup line and one row
 * per lane, the review diff renders inline, and the phone layout lays the flow top to bottom. Four scenarios, each scoped to the run view (`[data-testid=run-view]`); the breadcrumb and the page gutter are
 * the shell lane's and are not asserted here.
 */
import { test, expect, type Page } from '@playwright/test'
import {
  RUN_CHALLENGE, RUN_LANE_TONES, RUN_LOOP_DONE, RUN_LOOP_RESTORED, RUN_LOOP_RUNNING, UX_REFINE_WORKFLOW_ID,
} from './fixtures/ux-refine.ts'
import { attach, expectNoExecutionControls, installHooks, liveDock, openRunDetails, openStepSheet, phase, runUrl, stepSheet } from './support.ts'

installHooks()

const refineUrl = (runId: string, nodeId?: string) => runUrl(runId, nodeId, UX_REFINE_WORKFLOW_ID)
const runView = (page: Page) => page.getByTestId('run-view')
const graphNode = (page: Page, nodeId: string) => page.locator(`[data-testid="run-view"] [data-testid="workflow-graph"] [data-graph-node="${nodeId}"]`)

/** Opens a run page and waits until its banner has read everything it needs (the next step is shown). */
async function openRun(page: Page, runId: string): Promise<void> {
  await page.goto(refineUrl(runId))
  await expect(runView(page)).toBeVisible()
  await expect(page.getByTestId('now-headline')).toBeVisible()
}

async function pageScrollWidth(page: Page): Promise<number> {
  return page.evaluate('document.documentElement.scrollWidth') as Promise<number>
}

test(`[scenario:run-first-screen] At 1440 px the run page opens on an answer: the state line, the cause, the next step with an All steps disclosure, the deadlines and the lane pins, then the graph; metadata folds away (${phase})`, async ({ page, context }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])

  // A paused run: the state line, its cause and the next step with Copy; the metadata sits in a closed disclosure.
  await openRun(page, RUN_CHALLENGE)
  const view = runView(page)
  await expect(view).toHaveAttribute('data-run-status', 'paused')
  await expect(view.getByTestId('run-status')).toContainText('Paused')
  await expect(view.getByTestId('now-headline')).toBeVisible()
  // The first command carries Copy; the remaining steps fold into a closed "All steps" disclosure.
  await expect(view.getByTestId('now-command').first()).toBeVisible()
  const allSteps = view.getByTestId('now-all-steps')
  if (await allSteps.count() > 0) await expect(allSteps).not.toHaveAttribute('open', '')
  // The metadata is a closed disclosure under the title; the definition warning stays outside it.
  await expect(view.getByTestId('run-details')).not.toHaveAttribute('open', '')
  // The viewer never acts on a run.
  await expectNoExecutionControls(page)

  // A running run: the live dock's figures carry the deadlines, the same as the pinned facts behind Details.
  await openRun(page, RUN_LOOP_RUNNING)
  await expect(runView(page)).toHaveAttribute('data-run-status', 'running')
  const figures = liveDock(page).getByTestId('live-dock-figures')
  const dockDeadlines = figures.locator('div').filter({ hasText: /^Deadlines/ }).locator('dd')
  await expect(dockDeadlines).toBeVisible()
  await expect(dockDeadlines).not.toHaveText('not recorded')
  await expect(figures.getByTestId('run-span')).not.toHaveText('not recorded')
  await openRunDetails(page)
  await expect(runView(page).getByTestId('run-deadlines')).toBeVisible()
  await expect(dockDeadlines).toHaveText(await runView(page).getByTestId('run-deadlines').innerText())

  // A succeeded run: the state line is green, the viewer lane's sheet names its pinned model, then the graph.
  await openRun(page, RUN_LOOP_DONE)
  await expect(runView(page)).toHaveAttribute('data-run-status', 'succeeded')
  await expect(runView(page).getByTestId('run-status')).toContainText('Succeeded')
  await expect(runView(page).getByTestId('workflow-graph')).toBeVisible()
  await expect(runView(page).getByTestId('run-details')).not.toHaveAttribute('open', '')
  await openStepSheet(page, 'launch_viewer')
  await expect(stepSheet(page).getByTestId('sheet-facts').locator('div').filter({ hasText: /^Models/ })).toContainText('opus-4-8')
  await expect(stepSheet(page).getByTestId('sheet-facts').locator('div').filter({ hasText: /^Lane/ })).toContainText('viewer')

  await attach(page, testInfo, 'run-first-screen')
})

test(`[scenario:fix-loop-graph] The graph draws the repair sessions with their return marks and round meta, the review node's round and delta base, the lane pins and the lanes' tones; each repair's sheet names its trigger and round (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 })

  // The worked example: two repair nodes, each a return mark to the step it answers, with a round meta line.
  await openRun(page, RUN_LOOP_DONE)
  const view = runView(page)
  await expect(graphNode(page, 'repair-1')).toBeVisible()
  await expect(graphNode(page, 'repair-2')).toBeVisible()
  await expect(graphNode(page, 'repair-1')).toContainText('round 1 of 2 · verify')
  await expect(graphNode(page, 'repair-2')).toContainText('round 2 of 2 · review')
  // The return marks point from each repair back to the step it answers (a drawing from the fix loop, not a dependency).
  await expect(view.locator('svg.sb-edges path[data-return="repair-1>verify_viewer"]')).toHaveCount(1)
  await expect(view.locator('svg.sb-edges path[data-return="repair-2>review"]')).toHaveCount(1)
  // The review node shows its round and delta base; the viewer lane's sheet names its pinned model.
  await expect(graphNode(page, 'review')).toContainText('round 2')
  await expect(graphNode(page, 'review')).toContainText('delta from')
  await openStepSheet(page, 'launch_viewer')
  await expect(stepSheet(page).getByTestId('sheet-facts').locator('div').filter({ hasText: /^Models/ })).toContainText('opus-4-8')
  await stepSheet(page).getByRole('button', { name: 'Close step details' }).click()
  // The legend names the return mark.
  await view.getByRole('button', { name: 'Legend' }).click()
  await expect(view.getByTestId('graph-legend')).toContainText('repair re-entry')
  // Keyboard order visits every node, the repair nodes right after the step they answer.
  const order = await view.locator('[data-testid="workflow-graph"] [data-graph-node]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-graph-node')))
  expect(order.indexOf('repair-1')).toBe(order.indexOf('verify_viewer') + 1)
  expect(order).toContain('repair-2')
  // Two repair rounds, each a repair card whose sheet names its trigger and round.
  await expect(view.locator('[data-testid="workflow-graph"] [data-graph-node^="repair-"]')).toHaveCount(2)
  await expect(graphNode(page, 'repair-1').locator('.n-meta').first()).toContainText('repair · agent')
  await openStepSheet(page, 'repair-1')
  const repair = stepSheet(page).getByTestId('sheet-repair')
  await expect(repair.locator('div').filter({ hasText: /^Trigger/ }).locator('dd')).toHaveText('verify')
  await expect(repair.locator('div').filter({ hasText: /^Round/ }).locator('dd')).toHaveText('1 of 2')
  await openStepSheet(page, 'repair-2')
  await expect(repair.locator('div').filter({ hasText: /^Trigger/ }).locator('dd')).toHaveText('review')
  await expect(repair.locator('div').filter({ hasText: /^Round/ }).locator('dd')).toHaveText('2 of 2')

  // The mid-round example: the review node reads "round 2 in review".
  await openRun(page, RUN_LOOP_RUNNING)
  await expect(graphNode(page, 'review')).toContainText('round 2 in review')

  // The restored example: the review node reads "round 1" with the restored note.
  await openRun(page, RUN_LOOP_RESTORED)
  await expect(graphNode(page, 'review')).toContainText('round 1')
  await expect(graphNode(page, 'review')).toContainText('restored')

  // The two lanes in different states: the viewer lane's running launch and the shell lane's failed verification.
  await openRun(page, RUN_LANE_TONES)
  await expect(graphNode(page, 'launch_viewer')).toHaveAttribute('data-tone', 'run')
  await expect(graphNode(page, 'launch_viewer')).toHaveAccessibleName(/, lane viewer\b/)
  await expect(graphNode(page, 'verify_shell')).toHaveAttribute('data-tone', 'fail')
  await expect(graphNode(page, 'verify_shell')).toHaveAccessibleName(/, lane shell\b/)

  await openRun(page, RUN_LOOP_DONE)
  await attach(page, testInfo, 'fix-loop-graph')
})

test(`[scenario:assignment-and-diff] The Assignment tab opens on one setup line and one row per lane; the review diff renders inline with a delta default view and a binary stat (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 })

  // The Assignment tab: the setup line, then one row per lane before any long text.
  await page.goto(refineUrl(RUN_LOOP_DONE))
  await runView(page).getByTestId('tab-assignment').click()
  const setup = runView(page).getByTestId('assignment-setup-line')
  await expect(setup).toContainText('Viewer refine')
  await expect(setup).toContainText('2 fix rounds')
  await expect(setup).toContainText('reviewers')
  const rows = runView(page).getByTestId('assignment-lane-row')
  await expect(rows).toHaveCount(2)
  await expect(runView(page).locator('[data-testid="assignment-lane-row"][data-lane="viewer"]')).toContainText('opus-4-8 · medium')
  await expect(runView(page).locator('[data-testid="assignment-lane-row"][data-lane="shell"]')).toContainText('no pin')

  // The review node's Diff section renders inline: a file list, the delta diff as the default tab, a binary stat, the raw patch.
  await page.goto(refineUrl(RUN_LOOP_DONE, 'review'))
  const inline = page.getByTestId('review-diff-inline')
  await expect(inline).toBeVisible()
  // The delta diff is the default view, the full diff a second tab.
  const tabs = inline.getByTestId('diff-tab')
  await expect(tabs).toHaveCount(2)
  await expect(tabs.nth(0)).toContainText('Delta')
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')
  // The full diff: the file list, with a GIT binary patch shown as a stat with no hunks, and the raw patch still available.
  await tabs.nth(1).click()
  await expect(inline.getByTestId('diff-file')).toHaveCount(2)
  await expect(inline.locator('[data-testid="diff-file"][data-binary="true"]')).toHaveCount(1)
  await expect(inline.getByTestId('diff-raw')).toBeVisible()

  await attach(page, testInfo, 'assignment-and-diff')
})

test(`[scenario:run-phone] At 390 px the run view has no horizontal page scroll, the state line and the Now headline in the first screen over the graph, the flow laid top to bottom, 44 px controls, in dark theme (${phase})`, async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.setViewportSize({ width: 390, height: 900 })

  await openRun(page, RUN_LOOP_DONE)
  const view = runView(page)
  // The page does not scroll sideways (the graph box scrolls inside itself).
  expect(await pageScrollWidth(page)).toBeLessThanOrEqual(390 + 1)
  // The stage lays the flow top to bottom.
  const stage = view.getByTestId('run-stage')
  await expect(stage).toHaveAttribute('data-direction', 'TB')
  // The state line comes before the stage; the dock's headline and next step are in the first screen over it.
  const state = await view.getByTestId('run-status').boundingBox()
  const stageBox = await stage.boundingBox()
  expect(state && stageBox && state.y + state.height <= stageBox.y).toBeTruthy()
  await expect(liveDock(page)).toHaveAttribute('data-open', 'true')
  await expect(view.getByTestId('now-headline')).toBeInViewport()
  // The run view's own buttons meet the 44 px tap target at phone width.
  for (const control of await view.locator('button').all()) {
    if (!(await control.isVisible())) continue
    const box = await control.boundingBox()
    if (box && box.height > 0) expect(box.height).toBeGreaterThanOrEqual(44)
  }

  await attach(page, testInfo, 'run-phone')
})
