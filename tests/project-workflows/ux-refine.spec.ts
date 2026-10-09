/**
 * Viewer-refine's run page (docs/PRD_VIEWER_REFINE §5): the run page opens on an answer, the graph draws the in-run fix
 * loop, the Assignment tab is one setup line and one row per lane, the review diff renders inline, and the phone layout is
 * one column. Four scenarios, each scoped to the run view (`[data-testid=run-view]`); the breadcrumb and the page gutter are
 * the shell lane's and are not asserted here.
 */
import { test, expect, type Page } from '@playwright/test'
import {
  RUN_CHALLENGE, RUN_LANE_TONES, RUN_LOOP_DONE, RUN_LOOP_RESTORED, RUN_LOOP_RUNNING, UX_REFINE_WORKFLOW_ID,
} from './fixtures/ux-refine.ts'
import { attach, expectNoExecutionControls, installHooks, phase, runUrl } from './support.ts'

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

test(`[scenario:run-first-screen] At 1440 px the run page opens on an answer: the state line, the cause, the next step with an All steps disclosure, the lanes strip with pins, then the graph; metadata folds away (${phase})`, async ({ page, context }, testInfo) => {
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

  // A running run: the state line names the running repair; the deadline chips sit beside it.
  await openRun(page, RUN_LOOP_RUNNING)
  await expect(runView(page)).toHaveAttribute('data-run-status', 'running')
  await expect(runView(page).getByTestId('run-deadlines')).toBeVisible()
  await expect(runView(page).getByTestId('run-lanes')).toBeVisible()

  // A succeeded run: the state line is green, the lanes strip shows the pins, then the graph.
  await openRun(page, RUN_LOOP_DONE)
  await expect(runView(page)).toHaveAttribute('data-run-status', 'succeeded')
  await expect(runView(page).getByTestId('run-status')).toContainText('Succeeded')
  const lanes = runView(page).getByTestId('run-lanes')
  await expect(lanes.locator('[data-lane="viewer"] [data-testid="lane-chip"]')).toContainText('opus-4-8 · medium')
  await expect(runView(page).getByTestId('workflow-graph')).toBeVisible()
  await expect(runView(page).getByTestId('run-details')).not.toHaveAttribute('open', '')

  await attach(page, testInfo, 'run-first-screen')
})

test(`[scenario:fix-loop-graph] The graph draws the repair sessions with their return marks and round meta, the review node's round and delta base, the lane pins and chip tones; the Steps group by phase with repair rows (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 })

  // The worked example: two repair nodes, each a return mark to the step it answers, with a round meta line.
  await openRun(page, RUN_LOOP_DONE)
  const view = runView(page)
  await expect(graphNode(page, 'repair-1')).toBeVisible()
  await expect(graphNode(page, 'repair-2')).toBeVisible()
  await expect(graphNode(page, 'repair-1')).toContainText('round 1 of 2 · verify')
  await expect(graphNode(page, 'repair-2')).toContainText('round 2 of 2 · review')
  // The return marks point from each repair back to the step it answers (a drawing from the fix loop, not a dependency).
  await expect(view.locator('.workflow-return[data-return-from="repair-1"][data-return-to="verify_viewer"]')).toHaveCount(1)
  await expect(view.locator('.workflow-return[data-return-from="repair-2"][data-return-to="review"]')).toHaveCount(1)
  // The viewer lane's launch node shows its pin; the review node shows its round and delta base.
  await expect(graphNode(page, 'launch_viewer')).toContainText('opus-4-8 · medium')
  await expect(graphNode(page, 'review')).toContainText('round 2')
  await expect(graphNode(page, 'review')).toContainText('delta from')
  // The legend names the return mark.
  await expect(view.locator('[data-testid="graph-legend"] [data-legend="return"]')).toContainText('Return mark')
  // Keyboard order visits every node, the repair nodes right after the step they answer.
  const order = await view.locator('[data-testid="workflow-graph"] [data-graph-node]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-graph-node')))
  expect(order.indexOf('repair-1')).toBe(order.indexOf('verify_viewer') + 1)
  expect(order).toContain('repair-2')
  // The Steps group by phase with the repair rows indented under the step they answer.
  await expect(view.getByTestId('steps-phase').first()).toBeVisible()
  await expect(view.locator('[data-testid="run-node-list"] tr[data-node-id="repair-1"]')).toHaveClass(/step-row-repair/)
  await expect(view.getByTestId('run-steps')).toContainText('2 repair rounds')

  // The mid-round example: the review node reads "round 2 in review".
  await openRun(page, RUN_LOOP_RUNNING)
  await expect(graphNode(page, 'review')).toContainText('round 2 in review')

  // The restored example: the review node reads "round 1" with the restored note.
  await openRun(page, RUN_LOOP_RESTORED)
  await expect(graphNode(page, 'review')).toContainText('round 1')
  await expect(graphNode(page, 'review')).toContainText('restored')

  // The lane chips show a failed and a running tone (the two lanes in different states).
  await openRun(page, RUN_LANE_TONES)
  const tones = runView(page).getByTestId('run-lanes')
  await expect(tones.locator('[data-lane="viewer"] [data-testid="lane-chip"]')).toHaveAttribute('data-tone', 'run')
  await expect(tones.locator('[data-lane="shell"] [data-testid="lane-chip"]')).toHaveAttribute('data-tone', 'fail')

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

test(`[scenario:run-phone] At 390 px the run view is a single column with no horizontal page scroll, the state line and next step before the graph, the Pipeline stacked above the Steps, 44 px controls, in dark theme (${phase})`, async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.setViewportSize({ width: 390, height: 900 })

  await openRun(page, RUN_LOOP_DONE)
  const view = runView(page)
  // The page does not scroll sideways (the graph box scrolls inside itself).
  expect(await pageScrollWidth(page)).toBeLessThanOrEqual(390 + 1)
  // The board stacks: the Pipeline above the Steps.
  const board = view.getByTestId('run-board')
  await expect(board).toHaveAttribute('data-layout', 'stacked')
  // The state line and the next step come before the pipeline board.
  const state = await view.getByTestId('now-headline').boundingBox()
  const boardBox = await board.boundingBox()
  expect(state && boardBox && state.y < boardBox.y).toBeTruthy()
  // The run view's own buttons meet the 44 px tap target at phone width.
  for (const control of await view.locator('button').all()) {
    if (!(await control.isVisible())) continue
    const box = await control.boundingBox()
    if (box && box.height > 0) expect(box.height).toBeGreaterThanOrEqual(44)
  }

  await attach(page, testInfo, 'run-phone')
})
