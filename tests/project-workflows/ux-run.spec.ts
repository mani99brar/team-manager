/**
 * Viewer UX slice S3, the run page (docs/PRD_VIEWER_UX.md sections 4.2-4.4, 6 and 10): the Now banner names where the run
 * is or stopped, why, since when and the RUNBOOK command to type next (copied, never run); the Steps table gives each
 * step's start, duration and attempt markers, and Activity keeps the node-less controller rows (diagnosis, repair) in view
 * with PID checkpoints behind the controller log; the graph fits the width; the Assignment view is routed; a phone gets
 * the banner first and the step it taps; and a question or a pane that waits on the operator is marked everywhere.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  BUNDLE_SHA256, GUARDED_WORKFLOW_ID, REVIEWERS_WORKFLOW_ID, RUN_GUARDED, RUN_GUARDED_ASKING, RUN_REVIEWER_BLOCKED, RUN_SUCCEEDED, apiRunPath, laneGraphNodes,
  runInputs,
} from './fixtures.ts'
import {
  APPROVAL_BUNDLE, DEADLINE_MESSAGE, RUN_AWAITING_APPROVAL, RUN_CONTROLLER_INTERRUPTED, RUN_DEADLINE, RUN_FREEZE_INTERRUPTED, RUN_IDENTICAL, RUN_PANE,
  RUN_REPAIRED, RUN_REVIEW_INTERRUPTED, UX_RUN_WORKFLOW_ID,
} from './fixtures/ux-run.ts'
import { attach, expectNoExecutionControls, graphNode, installHooks, nodeDetail, nodeListItem, phase, runUrl } from './support.ts'

installHooks()

const uxRunUrl = (runId: string, nodeId?: string) => runUrl(runId, nodeId, UX_RUN_WORKFLOW_ID)
const reviewersRunUrl = (runId: string, nodeId?: string) => runUrl(runId, nodeId, REVIEWERS_WORKFLOW_ID)
const guardedRunUrl = (runId: string, nodeId?: string) => runUrl(runId, nodeId, GUARDED_WORKFLOW_ID)
const now = (page: Page) => page.getByTestId('run-now')
const commands = (page: Page) => now(page).getByTestId('now-command')
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const pageWidth = (page: Page) => page.evaluate('document.documentElement.scrollWidth') as Promise<number>

/** Opens a run page and waits until its banner has read everything it needs (it names a situation). */
async function openRun(page: Page, url: string, situation: string): Promise<Locator> {
  await page.goto(url)
  await expect(now(page)).toHaveAttribute('data-situation', situation)
  return now(page)
}

async function bottomOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox()
  expect(box, 'the element must be laid out').not.toBeNull()
  return box!.y + box!.height
}

test(`[scenario:run-now-banner] The Now banner names the situation, its cause and the RUNBOOK command to type, inside the first screen (${phase})`, async ({ page, context }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])

  // Blocked by review: the brief, then a follow-up run of the same feature (C30), with placeholders, never a concrete feature name.
  let banner = await openRun(page, reviewersRunUrl(RUN_REVIEWER_BLOCKED), 'review_blocked')
  await expect(banner).toContainText('Blocked by review at Independent review')
  await expect(banner).toContainText('The workflow did not complete.')
  await expect(banner).toContainText('coverage blocked the candidate: 1 open P1')
  await expect(commands(page)).toHaveText([
    '"$PY" -m workflow brief "$RUN"',
    '"$PY" -m workflow launch <feature> --repo <target repo> --run-id <feature>-<next number> --follows "$RUN" --live --automatic --by operator',
  ])
  await expect(banner.getByTestId('now-step')).toHaveCount(3)
  await expect(banner.getByTestId('now-step').nth(1)).toContainText('Paste what each lane needs from the brief')
  const copy = banner.getByTestId('copy-command')
  await expect(copy).toHaveText(['Copy', 'Copy'], { useInnerText: true })
  for (const button of await copy.all()) await expect(button).toHaveAttribute('aria-label', 'Copy command')
  await expect(banner).toContainText('Run these in your terminal; this viewer never changes a run.')
  await expect(banner).toContainText('Changed code')
  // The legend of the placeholders is a disclosure on the label line.
  const legend = banner.getByTestId('command-legend')
  await legend.locator('summary').click()
  await expect(legend).toContainText('RUN: this run\'s directory')
  expect(await bottomOf(banner)).toBeLessThanOrEqual(900)
  // Copy puts exactly the command on the clipboard; the viewer runs nothing.
  await copy.first().click()
  await expect.poll(() => page.evaluate('navigator.clipboard.readText()')).toBe('"$PY" -m workflow brief "$RUN"')
  await expectNoExecutionControls(page)
  await attach(page, testInfo, 'run-now-banner')

  // Blocked, identical failure before review: the lane repair, without a diagnosis row and never read as an outage.
  banner = await openRun(page, uxRunUrl(RUN_IDENTICAL), 'blocked_identical')
  await expect(banner).toContainText('Blocked at Verify combined candidate · lane ui failed identically on attempts 1 and 2')
  await expect(banner).toContainText('project-workflows-browser')
  await expect(commands(page).first()).toHaveText('"$PY" -m workflow repair "$RUN" ui --workspace --by operator')
  await expect(commands(page).last()).toHaveText('"$PY" -m workflow automatic "$RUN" --live --by operator')
  await expect(commands(page)).toHaveCount(4)
  await expect(banner).not.toContainText('Interrupted')
  await expect(banner).not.toContainText('Claude Code')
  expect(await bottomOf(banner)).toBeLessThanOrEqual(900)

  // Blocked before freeze by the worker deadline: a new run, and no repair command (repair refuses such a lane).
  banner = await openRun(page, uxRunUrl(RUN_DEADLINE), 'blocked_before_freeze')
  await expect(banner).toContainText('Blocked before freeze at Freeze worker handoffs')
  await expect(banner).toContainText(DEADLINE_MESSAGE)
  await expect(commands(page)).toHaveText(['"$PY" -m workflow launch <feature> --repo <target repo> --run-id <new run id> --live --automatic --by operator'])

  // Interrupted, recorded on the review node itself with no controller row: a paused run, never called failed.
  banner = await openRun(page, uxRunUrl(RUN_REVIEW_INTERRUPTED), 'interrupted')
  await expect(page.getByTestId('run-view')).toHaveAttribute('data-run-status', 'paused')
  await expect(banner).toContainText('Interrupted at Independent review')
  await expect(banner).not.toContainText('Failed')
  await expect(commands(page)).toHaveText(['"$PY" -m workflow automatic "$RUN" --live --by operator'])

  // Interrupted during the freeze by an outage: the same command, once Claude Code works again.
  banner = await openRun(page, uxRunUrl(RUN_FREEZE_INTERRUPTED), 'interrupted')
  await expect(banner).toContainText('Interrupted at Freeze worker handoffs')
  await expect(banner).toContainText('the freeze was stopping the workers')
  await expect(banner).toContainText('Once `claude --version` works')
  await expect(commands(page)).toHaveText(['"$PY" -m workflow automatic "$RUN" --live --by operator'])

  // Interrupted: the supervisor itself stopped while the workers ran.
  banner = await openRun(page, uxRunUrl(RUN_CONTROLLER_INTERRUPTED), 'interrupted')
  await expect(banner).toContainText('Interrupted at Freeze worker handoffs')
  await expect(banner).toContainText('the controller stopped; sessions keep running')
  await expect(banner).not.toContainText('Failed')

  // A repair was applied and waits for its continuation.
  banner = await openRun(page, uxRunUrl(RUN_REPAIRED), 'interrupted')
  await expect(banner).toContainText('Repair 1 applied; the run continues when you resume it')
  await expect(banner).not.toContainText('Failed')
  await expect(commands(page)).toHaveText(['"$PY" -m workflow automatic "$RUN" --live --by operator'])

  // Succeeded: nothing to type.
  banner = await openRun(page, runUrl(RUN_SUCCEEDED), 'succeeded')
  await expect(banner).toContainText('no push performed')
  await expect(banner).toContainText('Nothing required by the workflow')
  await expect(commands(page)).toHaveCount(0)

  // Awaiting approval: the reviewed bundle's hash is filled in.
  banner = await openRun(page, uxRunUrl(RUN_AWAITING_APPROVAL), 'awaiting_approval')
  await expect(banner).toContainText('Awaiting your approval')
  expect(APPROVAL_BUNDLE).not.toBe(BUNDLE_SHA256)
  await expect(commands(page)).toHaveText([`"$PY" -m workflow approve "$RUN" --bundle-sha256 ${APPROVAL_BUNDLE} --by operator`])

  // A question waits: both answer forms, naming the lane.
  banner = await openRun(page, guardedRunUrl(RUN_GUARDED_ASKING), 'question')
  await expect(banner).toContainText('Waiting on you: adapter asked question 2 of 3')
  await expect(commands(page)).toHaveText([
    '"$PY" -m workflow answer "$RUN" adapter "<your answer>" --by operator',
    '"$PY" -m workflow answer "$RUN" adapter "<your answer>" --by operator --no-herdr',
  ])
  await expectNoExecutionControls(page)
})

test(`[scenario:run-steps-timeline] Steps give each step's start, duration and attempt markers inside the first screen; Activity shows the controller's diagnosis and the repair without a click (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })

  // One row per step in definition order, with its start, how long it took and its attempts.
  await openRun(page, uxRunUrl(RUN_REPAIRED), 'interrupted')
  const rows = page.getByTestId('run-node-list').locator('[data-node-id]')
  await expect(rows).toHaveCount(laneGraphNodes(['ui']).length)
  expect(await rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-node-id')))).toEqual(laneGraphNodes(['ui']).map(node => node.node_id))
  const launch = nodeListItem(page, 'launch_ui')
  await expect(launch.locator('.step-started time')).toHaveText('09:00')
  await expect(launch.locator('.step-took')).toHaveText('28m21s')
  const verify = nodeListItem(page, 'verify_ui')
  await expect(verify).toHaveAttribute('data-status', 'paused')
  await expect(verify.locator('.step-started time')).toHaveText('09:28')
  await expect(verify.locator('.step-took')).toHaveText('2m17s')
  await expect(verify.locator('.step-attempts')).toContainText('attempt 2')
  await expect(verify.locator('.step-attempts')).toContainText('✗✗⚑⚒')
  await expect(nodeListItem(page, 'integrate').locator('.step-outcome')).toHaveText('not started')
  await expect(page.getByTestId('node-hint')).toBeVisible()

  // Activity: the node-less diagnosis and repair rows are shown without any click, with the operator's gap between them.
  const activity = page.getByTestId('run-timeline')
  await expect(activity.locator('li[data-marker="diagnosis"]')).toBeVisible()
  await expect(activity.locator('li[data-marker="diagnosis"]')).toContainText('ui failed identically on attempts 1 and 2')
  // Its event number and the full served message open by keyboard or touch, not in a hover tooltip.
  const more = activity.locator('li[data-marker="diagnosis"]').getByTestId('activity-more')
  await expect(more).toHaveText(/^#\d+$/)
  await expect(more).toHaveAttribute('aria-expanded', 'false')
  await more.focus()
  await page.keyboard.press('Enter')
  await expect(more).toHaveAttribute('aria-expanded', 'true')
  await expect(activity.locator('li[data-marker="diagnosis"]').getByTestId('activity-raw')).toContainText('identical')
  await expect(activity.locator('li[data-marker="repair"]')).toBeVisible()
  await expect(activity.locator('li[data-marker="repair"]')).toContainText('Repair 1 applied')
  await expect(activity.locator('li[data-kind="gap"]').filter({ hasText: 'operator time' })).toContainText('5m37s')
  // PID checkpoints sit behind the controller log, which says how many there are.
  const controllerLog = page.getByTestId('activity-controller-log')
  await expect(controllerLog).toHaveText('Controller log (3)')
  await expect(controllerLog).toHaveAttribute('aria-pressed', 'false')
  await expect(activity.locator('li[data-marker="controller_start"]')).toHaveCount(0)
  // A group the reader closed stays closed, and only it, when the controller log adds its rows (run 006: keys by first row).
  const phaseGroups = activity.getByTestId('activity-group')
  const verification = phaseGroups.filter({ has: page.locator('li[data-marker="diagnosis"]') })
  const groupCount = await phaseGroups.count()
  await verification.locator('summary').click()
  await expect(verification).not.toHaveAttribute('open', '')
  await controllerLog.click()
  await expect(phaseGroups).toHaveCount(groupCount)
  await expect(verification).not.toHaveAttribute('open', '')
  await expect(phaseGroups.and(page.locator('[open]'))).toHaveCount(groupCount - 1)
  await controllerLog.click()
  await expect(verification).not.toHaveAttribute('open', '')
  await controllerLog.click()
  await verification.locator('summary').click()
  await expect(verification).toHaveAttribute('open', '')
  await expect(activity.locator('li[data-marker="controller_start"]')).toHaveCount(3)
  await expect(activity.locator('li[data-marker="controller_start"]').first()).toContainText('controller started (PID 5101)')
  // Oldest first, with a remembered Newest first.
  const order = page.getByTestId('activity-order')
  await expect(activity.locator('li').first()).toContainText('09:00:10')
  await order.click()
  await expect(order).toHaveAttribute('aria-pressed', 'true')
  await expect(activity.locator('li').first()).toContainText('09:36:27')
  await page.reload()
  await expect(page.getByTestId('activity-order')).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('activity-order').click()
  await attach(page, testInfo, 'run-steps-timeline')

  // An attempt row opens that attempt's page (S4-core retargets it from the node page).
  const attempt = activity.locator('li[data-kind="end"][data-node-id="verify_ui"]').first().getByRole('link')
  await expect(attempt).toHaveAttribute('href', `${uxRunUrl(RUN_REPAIRED, 'verify_ui')}/attempts/1`)
  await attempt.click()
  await expect(page).toHaveURL(new RegExp(`${escape(uxRunUrl(RUN_REPAIRED, 'verify_ui'))}/attempts/1$`))
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'verify_ui')

  // The focus row is inside the first screen: two lanes, nine steps, focus on the review (row 7) and on the candidate (row 6).
  await openRun(page, reviewersRunUrl(RUN_REVIEWER_BLOCKED), 'review_blocked')
  await expect(page.getByTestId('run-lanes')).toBeVisible()
  await expect(nodeListItem(page, 'review')).toHaveAttribute('data-status', 'failed')
  expect(await bottomOf(nodeListItem(page, 'review'))).toBeLessThanOrEqual(900)
  await openRun(page, uxRunUrl(RUN_IDENTICAL), 'blocked_identical')
  await expect(page.getByTestId('run-lanes')).toContainText('candidate ✗ attempt 2 of 3')
  await expect(nodeListItem(page, 'candidate')).toHaveAttribute('data-status', 'failed')
  expect(await bottomOf(nodeListItem(page, 'candidate'))).toBeLessThanOrEqual(900)
  await attach(page, testInfo, 'run-steps-fold')
  await expectNoExecutionControls(page)
})

test(`[scenario:graph-fits] The graph fits the page width at 1280 and 1440 px, with its last step in view and the columns in order; narrower, the focus step is scrolled into view (${phase})`, async ({ page }, testInfo) => {
  const order = ['challenge', 'launch_ui', 'handoff', 'verify_ui', 'candidate', 'review', 'approval', 'integrate']
  for (const width of [1280, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(guardedRunUrl(RUN_GUARDED))
    const graph = page.getByTestId('workflow-graph')
    await expect(graph).toBeVisible()
    const box = graph.locator('xpath=..')
    const { scroll, client } = await box.evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }))
    expect(scroll, `the graph must not scroll sideways at ${width} px`).toBeLessThanOrEqual(client)
    await expect(graphNode(page, 'integrate')).toBeInViewport()
    const xs: number[] = []
    for (const id of order) xs.push((await graphNode(page, id).boundingBox())!.x)
    expect(xs, `the columns keep their order at ${width} px`).toEqual([...xs].sort((a, b) => a - b))
    expect(new Set(xs).size).toBe(xs.length)
    expect(await pageWidth(page)).toBeLessThanOrEqual(width)
  }
  // Two lanes stack in their columns: the launches share one x and so do the verifications, and the columns stay in order.
  await page.goto(runUrl(RUN_SUCCEEDED))
  const x = async (id: string) => (await graphNode(page, id).boundingBox())!.x
  expect(await x('launch_ui')).toBe(await x('launch_adapter'))
  expect(await x('verify_ui')).toBe(await x('verify_adapter'))
  const columns = [await x('launch_ui'), await x('handoff'), await x('verify_ui'), await x('candidate'), await x('review'), await x('approval'), await x('integrate')]
  expect(columns, 'the two-lane columns keep their order').toEqual([...columns].sort((a, b) => a - b))
  expect(new Set(columns).size).toBe(columns.length)
  // Between 760 and 1,100 px the graph scrolls inside its box with the focus step in view.
  await page.setViewportSize({ width: 780, height: 900 })
  await openRun(page, uxRunUrl(RUN_AWAITING_APPROVAL), 'awaiting_approval')
  const scrollBox = page.getByTestId('workflow-graph').locator('xpath=..')
  const inBox = async (id: string) => {
    const node = (await graphNode(page, id).boundingBox())!
    const frame = (await scrollBox.boundingBox())!
    return node.x >= frame.x && node.x + node.width <= frame.x + frame.width
  }
  await expect.poll(() => inBox('approval'), 'the focus step is scrolled into the graph box').toBe(true)
  expect(await pageWidth(page)).toBeLessThanOrEqual(780)
  // The legend is three short items, on one line.
  await page.setViewportSize({ width: 1440, height: 900 })
  const legend = page.getByTestId('graph-legend').locator('li')
  await expect(legend).toHaveCount(3)
  await expect(legend).toContainText(['Agent session', 'Trusted verifier', 'Controller'])
  const tops = await legend.evaluateAll(items => items.map(item => Math.round(item.getBoundingClientRect().top)))
  expect(new Set(tops).size, 'the legend fits one line').toBe(1)
  await attach(page, testInfo, 'graph-fits')
})

test(`[scenario:assignment-routed] The Assignment tab is a URL, survives a reload and keeps its keyboard pattern; the tabs sit above the graph (${phase})`, async ({ page }, testInfo) => {
  const runPage = runUrl(RUN_SUCCEEDED)
  await page.goto(runPage)
  const tablist = page.getByRole('tablist', { name: 'Run views' })
  const graph = page.getByTestId('workflow-graph')
  await expect(graph).toBeVisible()
  expect(await bottomOf(tablist)).toBeLessThanOrEqual((await graph.boundingBox())!.y)
  const runTab = page.getByTestId('tab-run')
  const assignmentTab = page.getByTestId('tab-assignment')

  await assignmentTab.click()
  await expect(page).toHaveURL(new RegExp(`${escape(runPage)}/assignment$`))
  await expect(assignmentTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('assignment')).toBeVisible()
  await expect(graph).toHaveCount(0)
  await page.reload()
  await expect(assignmentTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('assignment')).toBeVisible()
  await expect(graph).toHaveCount(0)
  await attach(page, testInfo, 'assignment-routed')

  // Arrow keys and Home/End still switch tabs, and each switch is a URL.
  await assignmentTab.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(runTab).toBeFocused()
  await expect(runTab).toHaveAttribute('aria-selected', 'true')
  await expect(page).toHaveURL(new RegExp(`${escape(runPage)}$`))
  await expect(graph).toBeVisible()
  await page.keyboard.press('End')
  await expect(assignmentTab).toBeFocused()
  await expect(page).toHaveURL(new RegExp(`${escape(runPage)}/assignment$`))
  // Back returns to the Run view.
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`${escape(runPage)}$`))
  await expect(runTab).toHaveAttribute('aria-selected', 'true')
  await expect(graph).toBeVisible()
  await expectNoExecutionControls(page)
})

test(`[scenario:narrow-run] At 390×844 the run page fits the width, starts with the Now banner, and a tapped step's heading is in view and focused (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const banner = await openRun(page, reviewersRunUrl(RUN_REVIEWER_BLOCKED), 'review_blocked')
  expect(await pageWidth(page)).toBeLessThanOrEqual(390)
  expect(await bottomOf(banner)).toBeLessThanOrEqual(844)
  // The graph is hidden on a phone; the Steps table is the navigator.
  await expect(page.getByTestId('workflow-graph')).toBeHidden()
  await expect(nodeListItem(page, 'review')).toBeVisible()
  await attach(page, testInfo, 'narrow-run')

  await nodeListItem(page, 'review').getByRole('link').click()
  await expect(page).toHaveURL(new RegExp(`${escape(reviewersRunUrl(RUN_REVIEWER_BLOCKED, 'review'))}$`))
  const heading = page.locator('#node-detail-title')
  await expect(heading).toBeFocused()
  const top = (await heading.boundingBox())!.y
  expect(top).toBeGreaterThanOrEqual(0)
  expect(top).toBeLessThan(844)
  expect(await pageWidth(page)).toBeLessThanOrEqual(390)
  // The step strip scrolls inside itself, with the current step in it.
  await expect(nodeListItem(page, 'review').getByRole('link')).toHaveAttribute('aria-current', 'page')
  await expect(nodeListItem(page, 'review')).toBeInViewport()
  await attach(page, testInfo, 'narrow-run-review')

  // Back on the run page the focus returns to the step the reader came from.
  await page.goBack()
  await expect(nodeListItem(page, 'review').getByRole('link')).toBeFocused()

  await page.goto(reviewersRunUrl(RUN_REVIEWER_BLOCKED, 'verify_ui'))
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'verify_ui')
  await expect(page.getByTestId('checks-list')).toBeVisible()
  expect(await pageWidth(page)).toBeLessThanOrEqual(390)
  await expectNoExecutionControls(page)

  // A definition that changed since the run started stays said on a phone; only the "current" chip goes behind Details.
  await page.goto(runUrl(RUN_SUCCEEDED))
  await expect(page.getByTestId('definition-changed')).toBeVisible()
  expect(await pageWidth(page)).toBeLessThanOrEqual(390)
})

test(`[scenario:question-attention] A waiting question or a pane that needs attention is marked on the banner, the graph, the Steps, the step strip and the tab title (${phase})`, async ({ page }, testInfo) => {
  const cases = [
    // A question: both answer forms, naming the lane.
    { url: guardedRunUrl(RUN_GUARDED_ASKING), situation: 'question', kind: 'question', node: 'launch_adapter', command: [/^"\$PY" -m workflow answer "\$RUN" adapter "<your answer>" --by operator$/, /^"\$PY" -m workflow answer "\$RUN" adapter "<your answer>" --by operator --no-herdr$/] },
    { url: uxRunUrl(RUN_PANE), situation: 'pane_attention', kind: 'pane', node: 'launch_ui', command: [/^"\$PY" -m workflow\.interactive attach-one "\$RUN" --node ui$/] },
  ]
  for (const { url, situation, kind, node, command } of cases) {
    await openRun(page, url, situation)
    for (const [index, form] of command.entries()) await expect(commands(page).nth(index)).toHaveText(form)
    await expect(graphNode(page, node)).toHaveAttribute('data-attention', kind)
    await expect(nodeListItem(page, node)).toHaveAttribute('data-attention', kind)
    await expect(page).toHaveTitle(/^\? /)
    await attach(page, testInfo, `question-attention-${kind}`)
    // The step strip on the node page carries it too.
    await nodeListItem(page, node).getByRole('link').click()
    await expect(nodeDetail(page)).toHaveAttribute('data-node-id', node)
    await expect(nodeListItem(page, node)).toHaveAttribute('data-attention', kind)
    await expect(page).toHaveTitle(/^\? /)
  }
  // Nothing waits on a finished run: the title carries no mark.
  await page.goto(runUrl(RUN_SUCCEEDED))
  await expect(now(page)).toHaveAttribute('data-situation', 'succeeded')
  await expect(page).not.toHaveTitle(/^\?/)
  await expect(page.locator('[data-attention]')).toHaveCount(0)
  await expectNoExecutionControls(page)
})

test(`[scenario:tryout-untried] A succeeded run that asks for a tryout carries the Untried chip and the try-this step until one verdict is recorded (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  // The run's inputs as a 1.7.0 export of a tryout run serves them (C7): the worker phase's fixture, or the seeded run's own.
  const path = `${apiRunPath(RUN_SUCCEEDED)}/inputs`
  let verdicts: object[] = []
  await page.route(url => url.pathname === path, async route => {
    const inputs = phase === 'worker' ? structuredClone(runInputs[RUN_SUCCEEDED]) : await (await route.fetch()).json()
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...inputs, tryout: { required: true, verdicts, allow_untried: null } }) })
  })
  const banner = await openRun(page, runUrl(RUN_SUCCEEDED), 'succeeded')
  const chip = page.getByTestId('untried-chip')
  await expect(chip).toHaveText('Untried')
  await expect(page.getByTestId('run-status')).toContainText('Untried')
  await expect(banner).toContainText('· untried')
  await expect(banner).toContainText(/try the candidate before you merge it, then record what you found/i)
  await expect(commands(page)).toHaveText(['"$PY" -m workflow tryout "$RUN" --result <works|broken|skipped> --note "<what you tried>" --by operator'])
  await expect(banner).toContainText('Each check row keeps its screenshots.')
  await expectNoExecutionControls(page)
  await attach(page, testInfo, 'tryout-untried')
  // One recorded verdict clears the chip and the step; the banner names the verdict.
  verdicts = [{ result: 'works', note: 'Reload keeps the list.', by: 'operator', at: '2026-10-04T10:00:00.000Z' }]
  await page.reload()
  await expect(now(page)).toHaveAttribute('data-situation', 'succeeded')
  await expect(now(page)).toContainText('· tried: works')
  await expect(chip).toHaveCount(0)
  await expect(commands(page)).toHaveCount(0)
})
