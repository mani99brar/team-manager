/**
 * Viewer UX slice S3, the run page (docs/PRD_VIEWER_UX.md sections 4.2-4.4, 6 and 10), on the Signal Box run page: the Now
 * banner in the live dock names where the run is or stopped, why, since when and the RUNBOOK command to type next (copied,
 * never run); each step's card and sheet give its start, duration and attempt, and the dock's latest events keep the
 * node-less controller rows (diagnosis, repair) in view; the graph fits the stage; the Assignment view is routed; a phone
 * gets the banner first and the step it taps; and a question or a pane that waits on the operator is marked everywhere.
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
import { attach, expectNoExecutionControls, graphNode, installHooks, liveDock, nodeDetail, nodeListItem, openStepSheet, phase, runUrl, stepSheet } from './support.ts'

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
  // The first command shows; the remaining steps sit in the closed "All steps" disclosure (docs/PRD_VIEWER_REFINE 5.1), opened here.
  await banner.getByTestId('now-all-steps').locator('summary').click()
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

test(`[scenario:run-steps-timeline] Each step's card and sheet give its start, duration and attempt inside the first screen; the live dock shows the controller's diagnosis and the repair without a click (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })

  // One card per step in definition order, with its start, how long it took and its attempts.
  await openRun(page, uxRunUrl(RUN_REPAIRED), 'interrupted')
  const cards = page.getByTestId('workflow-graph').locator('[data-graph-node]')
  await expect(cards).toHaveCount(laneGraphNodes(['ui']).length)
  expect(await cards.evaluateAll(elements => elements.map(element => element.getAttribute('data-graph-node')))).toEqual(laneGraphNodes(['ui']).map(node => node.node_id))
  await expect(graphNode(page, 'launch_ui')).toHaveAccessibleName(/, attempt 1, .*, 28m21s$/)
  await openStepSheet(page, 'launch_ui')
  const facts = stepSheet(page).getByTestId('sheet-facts')
  await expect(facts.locator('div').filter({ hasText: /^Started/ }).locator('time')).toHaveText('09:00')
  await expect(facts.locator('div').filter({ hasText: /^Duration/ }).locator('dd')).toHaveText('28m21s')
  await expect(facts.locator('div').filter({ hasText: /^Attempt/ }).locator('dd')).toHaveText('1')
  const verify = graphNode(page, 'verify_ui')
  await expect(verify).toHaveAttribute('data-status', 'paused')
  await expect(verify).toHaveAccessibleName(/, verification, paused, attempt 2, .*, 2m17s$/)
  await openStepSheet(page, 'verify_ui')
  await expect(facts.locator('div').filter({ hasText: /^Started/ }).locator('time')).toHaveText('09:28')
  await expect(facts.locator('div').filter({ hasText: /^Duration/ }).locator('dd')).toHaveText('2m17s')
  await expect(facts.locator('div').filter({ hasText: /^Attempt/ }).locator('dd')).toHaveText('2')
  // Both failed attempts and the paused resume note are the step's own events, newest first.
  await expect(stepSheet(page).getByTestId('sheet-events').locator('li').first()).toContainText('paused')
  await expect(stepSheet(page).getByTestId('sheet-events').locator('li').filter({ hasText: 'frontend-unit' })).toHaveCount(2)
  await expect(graphNode(page, 'integrate')).toHaveAttribute('data-status', 'pending')
  await openStepSheet(page, 'integrate')
  await expect(stepSheet(page)).toContainText('Not started; nothing recorded for this step yet.')
  await stepSheet(page).getByRole('button', { name: 'Close step details' }).click()
  await expect(stepSheet(page)).toHaveCount(0)

  // The live dock's latest events: the node-less diagnosis and repair rows are shown without any click, newest first.
  const events = liveDock(page).getByTestId('live-dock-events').locator('li')
  await expect(events.first()).toContainText('Repair 1 applied')
  await expect(events.filter({ hasText: 'ui failed identically on attempts 1 and 2' })).toHaveCount(1)
  // The timeline files the diagnosis and the repair under the step they concern, so their rows lead to it; PID
  // checkpoints (the old controller log) stay out of the latest events.
  await expect(events.first().locator('button')).toHaveAttribute('data-go', 'verify_ui')
  await expect(events.filter({ hasText: 'PID' })).toHaveCount(0)
  // A step's row centres the step and opens its sheet.
  const stepRow = events.locator('button[data-go="verify_ui"]').first()
  await expect(stepRow).toBeVisible()
  await stepRow.click()
  await expect(stepSheet(page)).toHaveAttribute('data-node-id', 'verify_ui')
  await attach(page, testInfo, 'run-steps-timeline')

  // The focus step's card is inside the first screen: two lanes, nine steps, focus on the review and on the candidate.
  await openRun(page, reviewersRunUrl(RUN_REVIEWER_BLOCKED), 'review_blocked')
  await expect(graphNode(page, 'review')).toHaveAttribute('data-status', 'failed')
  await expect(graphNode(page, 'review')).toHaveClass(/\bnow\b/)
  await expect(graphNode(page, 'review')).toBeInViewport()
  expect(await bottomOf(graphNode(page, 'review'))).toBeLessThanOrEqual(900)
  await openRun(page, uxRunUrl(RUN_IDENTICAL), 'blocked_identical')
  await expect(graphNode(page, 'candidate')).toHaveAttribute('data-status', 'failed')
  await expect(graphNode(page, 'candidate')).toHaveAccessibleName(/, attempt 2, /)
  await expect(graphNode(page, 'candidate')).toBeInViewport()
  expect(await bottomOf(graphNode(page, 'candidate'))).toBeLessThanOrEqual(900)
  await attach(page, testInfo, 'run-steps-fold')
  await expectNoExecutionControls(page)
})

test(`[scenario:graph-fits] The graph fits the stage at 1280 and 1440 px, with its last step in view and the columns in order; narrower, the focus step is in the stage (${phase})`, async ({ page }, testInfo) => {
  const order = ['challenge', 'launch_ui', 'handoff', 'verify_ui', 'candidate', 'review', 'approval', 'integrate']
  for (const width of [1280, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(guardedRunUrl(RUN_GUARDED))
    const graph = page.getByTestId('workflow-graph')
    await expect(graph).toBeVisible()
    const stage = page.getByTestId('run-stage')
    await expect(stage).toHaveAttribute('data-direction', 'LR')
    const { scroll, client } = await stage.evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }))
    expect(scroll, `the stage must not scroll sideways at ${width} px`).toBeLessThanOrEqual(client)
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
  // At 780 px the stage still lays the flow left to right, fitted, with the focus step inside it.
  await page.setViewportSize({ width: 780, height: 900 })
  await openRun(page, uxRunUrl(RUN_AWAITING_APPROVAL), 'awaiting_approval')
  const stageBox = page.getByTestId('run-stage')
  const inBox = async (id: string) => {
    const node = (await graphNode(page, id).boundingBox())!
    const frame = (await stageBox.boundingBox())!
    return node.x >= frame.x && node.x + node.width <= frame.x + frame.width
  }
  await expect.poll(() => inBox('approval'), 'the focus step is inside the stage').toBe(true)
  expect(await pageWidth(page)).toBeLessThanOrEqual(780)
  // The legend opens from its button: the six tones, the three executors and the repair return mark.
  await page.setViewportSize({ width: 1440, height: 900 })
  const legendButton = page.getByRole('button', { name: 'Legend' })
  await expect(legendButton).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('graph-legend')).toBeHidden()
  await legendButton.click()
  await expect(legendButton).toHaveAttribute('aria-expanded', 'true')
  const legend = page.getByTestId('graph-legend').locator('li')
  await expect(legend).toHaveText(['succeeded', 'running', 'needs you', 'failed or blocked', 'paused', 'pending', 'agent session', 'trusted verifier', 'controller', 'repair re-entry'])
  await expect(page.getByTestId('graph-legend')).toBeVisible()
  await attach(page, testInfo, 'graph-fits')
})

test(`[scenario:assignment-routed] The Assignment view is a URL, survives a reload and keeps its keyboard pattern; its link sits on the identity line above the graph (${phase})`, async ({ page }, testInfo) => {
  const runPage = runUrl(RUN_SUCCEEDED)
  await page.goto(runPage)
  const graph = page.getByTestId('workflow-graph')
  await expect(graph).toBeVisible()
  // The run page has no tabs: the identity line links to the other view, above the stage.
  await expect(page.getByRole('tablist', { name: 'Run views' })).toHaveCount(0)
  const assignmentLink = page.getByTestId('run-header').getByTestId('tab-assignment')
  await expect(assignmentLink).toHaveText('Assignment')
  expect(await bottomOf(assignmentLink)).toBeLessThanOrEqual((await page.getByTestId('run-stage').boundingBox())!.y)

  await assignmentLink.click()
  await expect(page).toHaveURL(new RegExp(`${escape(runPage)}/assignment$`))
  const tablist = page.getByRole('tablist', { name: 'Run views' })
  const runTab = tablist.getByTestId('tab-run')
  const assignmentTab = tablist.getByTestId('tab-assignment')
  await expect(assignmentTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('assignment')).toBeVisible()
  await expect(graph).toHaveCount(0)
  await expect(page.getByTestId('run-header').getByTestId('run-graph-link')).toHaveText('Run graph')
  await page.reload()
  await expect(assignmentTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('assignment')).toBeVisible()
  await expect(graph).toHaveCount(0)
  await attach(page, testInfo, 'assignment-routed')

  // Arrow keys and Home/End still switch views from the Assignment page's tabs, and each switch is a URL.
  await expect(runTab).toHaveAttribute('aria-selected', 'false')
  await assignmentTab.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(page).toHaveURL(new RegExp(`${escape(runPage)}$`))
  await expect(graph).toBeVisible()
  // Back on the Assignment page, End keeps it and Home switches to the graph.
  await page.getByTestId('run-header').getByTestId('tab-assignment').click()
  await expect(page).toHaveURL(new RegExp(`${escape(runPage)}/assignment$`))
  await runTab.focus()
  await page.keyboard.press('End')
  await expect(assignmentTab).toBeFocused()
  await expect(page).toHaveURL(new RegExp(`${escape(runPage)}/assignment$`))
  await page.keyboard.press('Home')
  await expect(page).toHaveURL(new RegExp(`${escape(runPage)}$`))
  await expect(graph).toBeVisible()
  // Back returns to the Assignment view.
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`${escape(runPage)}/assignment$`))
  await expect(assignmentTab).toHaveAttribute('aria-selected', 'true')
  await expect(graph).toHaveCount(0)
  await expectNoExecutionControls(page)
})

test(`[scenario:narrow-run] At 390×844 the run page fits the width, starts with the Now banner, and a tapped step's heading is in view and focused (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const banner = await openRun(page, reviewersRunUrl(RUN_REVIEWER_BLOCKED), 'review_blocked')
  expect(await pageWidth(page)).toBeLessThanOrEqual(390)
  expect(await bottomOf(banner)).toBeLessThanOrEqual(844)
  // On a phone the stage lays the flow top to bottom; the dock opens over it with the banner.
  await expect(page.getByTestId('run-stage')).toHaveAttribute('data-direction', 'TB')
  await expect(liveDock(page)).toHaveAttribute('data-open', 'true')
  await expect(graphNode(page, 'review')).toHaveCount(1)
  await attach(page, testInfo, 'narrow-run')

  // Opening a step folds the dock to its bar; its sheet leads to the step page.
  await openStepSheet(page, 'review')
  await expect(liveDock(page)).toHaveAttribute('data-open', 'false')
  expect(await pageWidth(page)).toBeLessThanOrEqual(390)
  await stepSheet(page).getByTestId('sheet-open-page').click()
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'review')
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
  await expect(graphNode(page, 'review')).toBeFocused()

  await page.goto(reviewersRunUrl(RUN_REVIEWER_BLOCKED, 'verify_ui'))
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'verify_ui')
  await expect(page.getByTestId('checks-list')).toBeVisible()
  expect(await pageWidth(page)).toBeLessThanOrEqual(390)
  await expectNoExecutionControls(page)

  // A definition that changed since the run started stays said on a phone.
  await page.goto(runUrl(RUN_SUCCEEDED))
  await expect(page.getByTestId('definition-changed')).toBeVisible()
  expect(await pageWidth(page)).toBeLessThanOrEqual(390)
})

test(`[scenario:question-attention] A waiting question or a pane that needs attention is marked on the banner, the status line, the graph, the step sheet, the step strip and the tab title (${phase})`, async ({ page }, testInfo) => {
  const cases = [
    // A question: both answer forms, naming the lane.
    { url: guardedRunUrl(RUN_GUARDED_ASKING), situation: 'question', kind: 'question', meaning: 'needs you: a question waits', node: 'launch_adapter', command: [/^"\$PY" -m workflow answer "\$RUN" adapter "<your answer>" --by operator$/, /^"\$PY" -m workflow answer "\$RUN" adapter "<your answer>" --by operator --no-herdr$/] },
    { url: uxRunUrl(RUN_PANE), situation: 'pane_attention', kind: 'pane', meaning: 'needs you: a pane needs attention', node: 'launch_ui', command: [/^"\$PY" -m workflow\.interactive attach-one "\$RUN" --node ui$/] },
  ]
  for (const { url, situation, kind, meaning, node, command } of cases) {
    await openRun(page, url, situation)
    for (const [index, form] of command.entries()) await expect(commands(page).nth(index)).toHaveText(form)
    await expect(page.getByTestId('run-status-meaning')).toHaveText(meaning)
    await expect(graphNode(page, node)).toHaveAttribute('data-attention', kind)
    await expect(graphNode(page, node)).toHaveClass(/\battn\b/)
    await expect(graphNode(page, node)).toHaveAccessibleName(/ · needs you, /)
    await expect(page).toHaveTitle(/^\? /)
    await openStepSheet(page, node)
    await expect(stepSheet(page).getByTestId('sheet-status')).toContainText('needs you')
    await attach(page, testInfo, `question-attention-${kind}`)
    // The step strip on the node page carries it too.
    await stepSheet(page).getByTestId('sheet-open-page').click()
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
