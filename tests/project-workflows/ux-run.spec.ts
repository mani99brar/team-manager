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
  PROJECT, WORKFLOW_ID, runInputs,
} from './fixtures.ts'
import {
  APPROVAL_BUNDLE, DEADLINE_MESSAGE, RUN_AWAITING_APPROVAL, RUN_CONTROLLER_INTERRUPTED, RUN_DEADLINE, RUN_FREEZE_INTERRUPTED, RUN_IDENTICAL, RUN_NO_BRANCH, RUN_PANE,
  RUN_REPAIRED, RUN_REVIEW_INTERRUPTED, UX_RUN_WORKFLOW_ID,
} from './fixtures/ux-run.ts'
import { RUN_ACCEPTED_ABANDONED, RUN_ACCEPTED_BLOCKED, UX_ACCEPTED_WORKFLOW_ID } from './fixtures/ux-accepted.ts'
import { RUN_CHALLENGE, UX_REFINE_WORKFLOW_ID } from './fixtures/ux-refine.ts'
import { REVAMP_PAGES_WORKFLOW_ID, RUN_REVAMP_BLOCKED, RUN_REVAMP_DONE, RUN_REVAMP_RUNNING } from './fixtures/ux-revamp-pages.ts'
import { installProjectMocks } from './mock.ts'
import { RUN_SESSIONS, UX_SESSIONS_WORKFLOW_ID } from './fixtures/sessions.ts'
import { attach, expectNoExecutionControls, graphNode, installHooks, liveDock, nodeDetail, nodeListItem, openRunDetails, openStepSheet, phase, runUrl, stepSheet, workflowUrl } from './support.ts'

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
  test.slow()
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

test(`[scenario:graph-fits] The graph opens readable at 1280 and 1440 px with the columns in order and, after 'Fit the graph', its last step in view; narrower, the focus step is in the stage (${phase})`, async ({ page }, testInfo) => {
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
    const xs: number[] = []
    for (const id of order) xs.push((await graphNode(page, id).boundingBox())!.x)
    expect(xs, `the columns keep their order at ${width} px`).toEqual([...xs].sort((a, b) => a - b))
    expect(new Set(xs).size).toBe(xs.length)
    expect(await pageWidth(page)).toBeLessThanOrEqual(width)
    // The first view opens readable and pans; "Fit the graph" shows the whole picture, the last step in the viewport.
    await page.getByRole('button', { name: 'Fit the graph' }).click()
    await expect(graphNode(page, 'integrate')).toBeInViewport()
    await expect(graphNode(page, 'challenge')).toBeInViewport()
    const refit = await stage.evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }))
    expect(refit.scroll, `the stage must not scroll sideways after the fit at ${width} px`).toBeLessThanOrEqual(refit.client)
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

test(`[scenario:storage-missing] A workflow whose run storage cannot be opened says what to fix: it leads with 'Run storage missing', names the project and its runs_root entry in projects.json, links to the project, keeps Retry secondary and folds the HTTP code and path; any other 503 keeps the generic panel (${phase})`, async ({ page }, testInfo) => {
  const runsPath = `/api/projects/${PROJECT.project_id}/workflows/${WORKFLOW_ID}/runs`
  let failing: { code: string; message: string } | null = { code: 'RUNS_ROOT_UNAVAILABLE', message: 'The configured run storage for this workflow does not exist. Check the registry configuration.' }
  await page.route(url => url.pathname === runsPath, async route => {
    if (failing) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: failing }) })
    else await route.fallback()
  })
  await page.goto(workflowUrl(PROJECT.project_id, WORKFLOW_ID))
  const error = page.getByTestId('projects-error')
  await expect(error).toContainText('Run storage missing')
  await expect(error).toContainText(PROJECT.project_id)
  await expect(error.getByTestId('storage-project')).toHaveText(PROJECT.project_id)
  await expect(error).toContainText('runs_root')
  await expect(error).toContainText('projects.json')
  await expect(error).not.toContainText('Retry once it has recovered')

  // A link back to the project; Retry is still there, after it and not the lead action.
  const link = error.getByRole('link', { name: /project/ })
  await expect(link).toHaveAttribute('href', `/projects/${PROJECT.project_id}`)
  const retry = error.getByRole('button', { name: 'Retry' })
  await expect(retry).toBeVisible()
  await expect(retry).toHaveClass(/button-small/)
  const [linkBox, retryBox] = [await link.boundingBox(), await retry.boundingBox()]
  expect(retryBox!.x).toBeGreaterThan(linkBox!.x)

  // The HTTP code and the request path sit in a closed Technical details until opened.
  const details = error.getByTestId('technical-details')
  await expect(details).not.toHaveAttribute('open', '')
  await expect(error.getByText('HTTP 503')).toBeHidden()
  await expect(error.getByText(runsPath)).toBeHidden()
  await attach(page, testInfo, 'storage-missing')
  await details.locator('summary').click()
  await expect(error.getByText('HTTP 503')).toBeVisible()
  await expect(error.getByText(runsPath)).toBeVisible()

  // Retry reads the runs again once the storage is back.
  failing = null
  await retry.click()
  await expect(page.getByTestId('run-list')).toBeVisible()
  await expect(page.getByTestId('projects-error')).toHaveCount(0)

  // Any other 503 renders the generic panel exactly as before.
  failing = { code: 'registry_unavailable', message: 'The project registry could not be read.' }
  await page.goto(workflowUrl(PROJECT.project_id, WORKFLOW_ID))
  await expect(error).toContainText('could not be loaded')
  await expect(error).toContainText('The project registry could not be read.')
  await expect(error).toContainText('Retry once it has recovered')
  await expect(error).toContainText(runsPath)
  await expect(error).not.toContainText('Run storage missing')
  await expect(error.getByTestId('technical-details')).toHaveCount(0)
})

// ---- Stage B: a run page that opens readable ------------------------------------------------------------------------------

type Rect = { x: number; y: number; width: number; height: number }
const rectOf = async (locator: Locator): Promise<Rect> => {
  const value = await locator.boundingBox()
  expect(value, 'the element must be laid out').not.toBeNull()
  return value!
}
const frameWidthOf = (page: Page) => page.getByTestId('run-board').evaluate(element => element.clientWidth)
const GUARDED_ORDER = ['challenge', 'launch_ui', 'handoff', 'verify_ui', 'candidate', 'review', 'approval', 'integrate']
const DOCK_RESERVE_PX = 336
/** The step the asking run waits at: the Now's focus, which the two phases' servers may place on different steps of the flow. */
async function markedStep(page: Page): Promise<string> {
  const marked = page.locator('[data-graph-node].now')
  await expect(marked).toHaveCount(1)
  const id = (await marked.getAttribute('data-node-id'))!
  // The dock names the same step.
  await expect(liveDock(page).getByTestId('live-dock-bar')).toContainText((await marked.locator('.n-label').innerText()).trim())
  return id
}

/** The scale the stage's detail-level tag reads, as a percentage, and its level word. */
async function levelTag(page: Page): Promise<{ percent: number; word: string }> {
  const tag = page.getByTestId('stage-level')
  const percent = Number.parseInt((await tag.locator('span').first().innerText()).replace('%', ''), 10)
  return { percent, word: (await tag.locator('b').innerText()).trim() }
}

/** Whether a card lies wholly inside the stage, right of `reserved` px from its left edge. */
async function cardInsideStage(page: Page, id: string, reserved: number): Promise<boolean> {
  const stageBox = await rectOf(page.getByTestId('run-stage'))
  const card = await rectOf(graphNode(page, id))
  return card.x >= stageBox.x + reserved - 0.5 && card.x + card.width <= stageBox.x + stageBox.width + 0.5
    && card.y >= stageBox.y - 0.5 && card.y + card.height <= stageBox.y + stageBox.height + 0.5
}

/** The page's first view at the current size: readable, the step the run is at inside the stage and clear of the dock. */
async function expectReadableFirstView(page: Page, nowId: string, where: string, marked = true): Promise<'column' | 'overlay'> {
  const board = page.getByTestId('run-board')
  const stage = page.getByTestId('run-stage')
  await expect(stage).toHaveAttribute('data-direction', 'LR')
  // A finished run has no step it is at: nothing is outlined and the first view anchors on the first step by design.
  if (marked) await expect(page.locator('[data-graph-node].now'), `${where}: the step the run is at`).toHaveAttribute('data-node-id', nowId)
  else await expect(page.locator('[data-graph-node].now'), `${where}: no step is marked`).toHaveCount(0)
  await expect(graphNode(page, nowId)).toBeVisible()
  const frame = await frameWidthOf(page)
  const mode = frame >= 1200 ? 'column' : 'overlay'
  await expect(board, `${where}: the dock follows the frame's measured width (${frame} px)`).toHaveAttribute('data-dock', mode)
  await expect(liveDock(page)).toHaveAttribute('data-open', 'true')
  // Readable: at 60 % or more, the standard level or closer.
  await expect.poll(async () => (await levelTag(page)).percent, `${where}: the first view opens at 60 % or more`).toBeGreaterThanOrEqual(60)
  expect(['Standard', 'Full detail'], `${where}: the level`).toContain((await levelTag(page)).word)
  const stageBox = await rectOf(stage)
  const dock = await rectOf(liveDock(page))
  if (mode === 'column') {
    expect(dock.x + dock.width, `${where}: the dock column is left of the stage`).toBeLessThanOrEqual(stageBox.x + 0.5)
    expect(dock.width).toBeLessThanOrEqual(313)
    expect(await cardInsideStage(page, nowId, 0), `${where}: the step the run is at is inside the stage`).toBe(true)
  } else {
    expect(dock.x, `${where}: the dock overlays the stage`).toBeGreaterThanOrEqual(stageBox.x)
    expect(dock.x + dock.width).toBeGreaterThan(stageBox.x + 1)
    expect(await cardInsideStage(page, nowId, DOCK_RESERVE_PX), `${where}: the step the run is at is clear of the 336 px reserve`).toBe(true)
    const card = await rectOf(graphNode(page, nowId))
    expect(card.x - stageBox.x, `${where}: the card starts at least 336 px right of the stage's left edge`).toBeGreaterThanOrEqual(DOCK_RESERVE_PX - 0.5)
  }
  const { scroll, client } = await stage.evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }))
  expect(scroll, `${where}: the stage does not scroll sideways`).toBeLessThanOrEqual(client)
  return mode
}

/** After "Fit the graph" every step is inside the stage and every chip label is whole on at most two lines. */
async function expectWholeOverview(page: Page, listed: readonly string[], reserved: number, where: string) {
  await page.getByRole('button', { name: 'Fit the graph' }).click()
  // Every step of the picture, the listed ones among them (the page may project reviewer cards beside the definition's steps).
  const ids = await page.locator('[data-graph-node]').evaluateAll(cards => cards.map(card => card.getAttribute('data-graph-node')!))
  for (const id of listed) expect(ids).toContain(id)
  for (const id of ids) {
    await expect(graphNode(page, id), `${where}: ${id} is in the viewport`).toBeInViewport()
    expect(await cardInsideStage(page, id, reserved), `${where}: ${id} is inside the stage`).toBe(true)
  }
  const stage = page.getByTestId('run-stage')
  if ((await levelTag(page)).percent >= 60) return
  await expect(stage.locator('.sb-world')).toHaveAttribute('data-level', '0')
  const chips = await stage.locator('[data-chip-label]').evaluateAll(labels => labels.map(label => {
    const style = (globalThis as unknown as { getComputedStyle: (node: unknown) => { lineHeight: string; fontSize: string } }).getComputedStyle(label.parentElement!)
    const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.15
    return { text: label.textContent ?? '', cut: label.scrollWidth > label.clientWidth, heightRatio: label.clientHeight / lineHeight }
  }))
  expect(chips.length).toBe(ids.length)
  for (const chip of chips) {
    expect(chip.cut, `${where}: the chip "${chip.text}" is not cut`).toBe(false)
    expect(chip.heightRatio, `${where}: the chip "${chip.text}" wraps on at most two lines`).toBeLessThanOrEqual(2.2)
  }
}

test(`[scenario:graph-readable] The guarded run opens at 60 % or more with the step it is at inside the stage and clear of the dock, whose placement follows the run frame's measured width (a column from 1200 px, an overlay with a 336 px reserve under it); Fit the graph shows every step with whole chip labels; a phone keeps its top-to-bottom flow (${phase})`, async ({ page }, testInfo) => {
  test.slow()
  // The asking guarded run waits at a step: the first view is placed on it when the graph does not fit.
  for (const width of [1280, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(guardedRunUrl(RUN_GUARDED_ASKING))
    const mode = await expectReadableFirstView(page, await markedStep(page), `${width} px`)
    const xs: number[] = []
    for (const id of GUARDED_ORDER) xs.push((await graphNode(page, id).boundingBox())!.x)
    expect(xs, `the columns keep their order at ${width} px`).toEqual([...xs].sort((a, b) => a - b))
    expect(await pageWidth(page)).toBeLessThanOrEqual(width)
    await expectWholeOverview(page, GUARDED_ORDER, mode === 'overlay' ? DOCK_RESERVE_PX : 0, `${width} px`)
  }
  // The succeeded guarded run has no step it is at: the first view anchors on the first step by design.
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(guardedRunUrl(RUN_GUARDED))
  await expectReadableFirstView(page, 'challenge', 'the succeeded guarded run', false)

  // A step far along the flow (the awaiting-approval run's sixth column) is placed inside the stage at both widths.
  for (const width of [1280, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(uxRunUrl(RUN_AWAITING_APPROVAL))
    await expectReadableFirstView(page, 'approval', `the awaiting-approval run at ${width} px`)
  }

  // 1024 px: the dock overlays the stage as before and the step the run is at is clear of it.
  await page.setViewportSize({ width: 1024, height: 900 })
  await page.goto(guardedRunUrl(RUN_GUARDED_ASKING))
  expect(await expectReadableFirstView(page, await markedStep(page), '1024 px')).toBe('overlay')
  await expectWholeOverview(page, GUARDED_ORDER, DOCK_RESERVE_PX, '1024 px')
  await attach(page, testInfo, 'graph-readable')

  // The breakpoint is the run frame's measured width: size the window from the measured difference until the frame reads 1200.
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(guardedRunUrl(RUN_GUARDED_ASKING))
  const gutter = 1280 - await frameWidthOf(page)
  const sizeFrame = async (target: number) => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const measured = await frameWidthOf(page)
      if (measured === target) return
      const viewport = page.viewportSize()!
      await page.setViewportSize({ width: viewport.width + (target - measured), height: 900 })
    }
    expect(await frameWidthOf(page)).toBe(target)
  }
  expect(gutter).toBeGreaterThan(0)
  await sizeFrame(1200)
  expect(await expectReadableFirstView(page, await markedStep(page), 'a 1200 px frame')).toBe('column')
  await sizeFrame(1199)
  expect(await expectReadableFirstView(page, await markedStep(page), 'a 1199 px frame')).toBe('overlay')
  // A folded dock keeps its column from 1200 px and gives its reserve back under it.
  await sizeFrame(1200)
  await liveDock(page).getByTestId('live-dock-bar').click()
  await expect(liveDock(page)).toHaveAttribute('data-open', 'false')
  expect((await rectOf(liveDock(page))).x + (await rectOf(liveDock(page))).width).toBeLessThanOrEqual((await rectOf(page.getByTestId('run-stage'))).x + 0.5)
  await liveDock(page).getByTestId('live-dock-bar').click()

  // 390 px: the flow runs top to bottom as before.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(guardedRunUrl(RUN_GUARDED))
  await expect(page.getByTestId('run-stage')).toHaveAttribute('data-direction', 'TB')
  const ys: number[] = []
  for (const id of GUARDED_ORDER) ys.push((await graphNode(page, id).boundingBox())!.y)
  expect(ys, 'top to bottom').toEqual([...ys].sort((a, b) => a - b))
  expect(await pageWidth(page)).toBeLessThanOrEqual(390)
})

/** The dock bar of an accepted run holds its words whole: nothing spills out of the bar and the open body starts below it. */
async function expectBarHoldsItsWords(bar: Locator) {
  const g = await bar.evaluate(element => {
    const rect = (selector: string) => element.querySelector(selector)!.getBoundingClientRect()
    const own = element.getBoundingClientRect()
    const body = element.parentElement!.querySelector('.lv-body')
    return {
      fits: element.scrollHeight <= element.clientHeight, top: own.top, bottom: own.bottom,
      labelTop: rect('.lv-label').top, wordTop: rect('.lv-now .w').top, wordBottom: rect('.lv-now .w').bottom,
      sinceBottom: rect('.lv-since').bottom, bodyTop: body === null ? null : body.getBoundingClientRect().top,
    }
  })
  expect(g.fits, 'the bar clips nothing vertically').toBe(true)
  expect(g.labelTop, 'the step name starts inside the bar').toBeGreaterThanOrEqual(g.top - 0.5)
  expect(g.wordTop, 'the override word starts inside the bar').toBeGreaterThanOrEqual(g.top - 0.5)
  expect(g.wordBottom, 'the override word ends inside the bar').toBeLessThanOrEqual(g.bottom + 0.5)
  expect(g.sinceBottom, 'the timing ends inside the bar').toBeLessThanOrEqual(g.bottom + 0.5)
  if (g.bodyTop !== null) expect(g.bottom, 'the bar ends at or above the open body').toBeLessThanOrEqual(g.bodyTop + 0.5)
}

test(`[scenario:dock-times] The live dock's bar says when a run stopped: a failed run "failed <n> d ago · ran <span>", a succeeded one "integrated <age> · ran <span>", a paused and an interrupted one in days since the stop, an accepted one "operator override" then its age, a running one "for <span>" that moves with the clock; never "for <span>" on a finished run (${phase})`, async ({ page }, testInfo) => {
  test.slow()
  await page.setViewportSize({ width: 1440, height: 900 })
  const bar = () => liveDock(page).getByTestId('live-dock-bar')
  const open = async (url: string, ready: (text: string) => boolean) => {
    await page.goto(url)
    await expect(bar()).toBeVisible()
    await expect.poll(async () => ready(await bar().innerText()), { message: `the bar of ${url} settles` }).toBe(true)
    return (await bar().textContent())!.replace(/\s+/g, ' ').trim()
  }
  const SPAN_OF_HOURS = /\b\d{3,}h\d{2}m\b/
  // The clock sits after every seeded run ended or stopped, so each age reads in whole days.
  await page.clock.install({ time: new Date('2026-10-21T12:00:00Z') })
  const seen: string[] = []

  const failed = await open(`${runUrl(RUN_REVAMP_BLOCKED, undefined, REVAMP_PAGES_WORKFLOW_ID)}`, text => /failed/.test(text) && /ago/.test(text))
  expect(failed).toMatch(/failed \d+ d ago · ran \d+m\d+s$/)
  expect(failed).not.toMatch(/\bfor \d/)
  seen.push(failed)

  const succeeded = await open(runUrl(RUN_REVAMP_DONE, undefined, REVAMP_PAGES_WORKFLOW_ID), text => /integrated/.test(text) && /ago/.test(text))
  expect(succeeded).toMatch(/integrated \d+ d ago · ran \d+m\d+s$/)
  expect(succeeded).not.toMatch(/\bfor \d/)
  seen.push(succeeded)

  const paused = await open(runUrl(RUN_CHALLENGE, undefined, UX_REFINE_WORKFLOW_ID), text => /paused/.test(text) && /since/.test(text))
  expect(paused).toMatch(/paused \d+ d \(since [A-Z][a-z]{2} \d{1,2}( \d{4})?\)$/)
  expect(paused).not.toMatch(/\bfor \d/)
  seen.push(paused)

  const interrupted = await open(runUrl(RUN_REVIEW_INTERRUPTED, undefined, UX_RUN_WORKFLOW_ID), text => /interrupted/.test(text) && /since/.test(text))
  expect(interrupted).toMatch(/interrupted \d+ d \(since [A-Z][a-z]{2} \d{1,2}( \d{4})?\)$/)
  expect(interrupted).not.toMatch(/\bfor \d/)
  seen.push(interrupted)

  // A failed run served with interrupted attention is finished: the finished words, not the stopped ones.
  const frozen = await open(runUrl(RUN_FREEZE_INTERRUPTED, undefined, UX_RUN_WORKFLOW_ID), text => /failed/.test(text) && /ago/.test(text))
  expect(frozen).toMatch(/failed \d+ d ago · ran \d+m\d+s$/)
  expect(frozen).not.toMatch(/interrupted \d+ d/)
  seen.push(frozen)

  // An accepted run keeps "integrated (operator override)", adds only its age, and keeps the override tone; no second outcome word.
  const accepted = await open(runUrl(RUN_ACCEPTED_BLOCKED, undefined, UX_ACCEPTED_WORKFLOW_ID), text => /operator override/.test(text) && /ago/.test(text))
  expect(accepted).toContain('operator override')
  expect(accepted).toMatch(/operator override\) ?\d+ d ago/)
  expect(accepted).not.toMatch(/succeeded/i)
  expect(accepted.match(/integrated/g)).toHaveLength(1)
  expect(accepted).not.toMatch(/\bfor \d/)
  await expect(bar()).toHaveClass(/tone-override/)
  seen.push(accepted)
  // Nothing in the 312 px bar is clipped: the word and the timing end left of the chevron, the word inside its box.
  const geometry = await bar().evaluate(element => {
    const rect = (selector: string) => element.querySelector(selector)!.getBoundingClientRect()
    const now = element.querySelector('.lv-now')!
    return { nowFits: now.scrollWidth <= now.clientWidth, nowRight: rect('.lv-now').right, wordRight: rect('.lv-now .w').right, sinceRight: rect('.lv-since').right, chevLeft: rect('.lv-chev').left, labelWidth: rect('.lv-label').width }
  })
  expect(geometry.nowFits, '.lv-now clips nothing').toBe(true)
  expect(geometry.wordRight, 'the override word ends inside .lv-now').toBeLessThanOrEqual(geometry.nowRight + 0.5)
  expect(geometry.wordRight, 'the override word ends left of the chevron').toBeLessThanOrEqual(geometry.chevLeft + 0.5)
  expect(geometry.labelWidth, 'the step name keeps room').toBeGreaterThan(40)
  expect(geometry.sinceRight, 'the timing ends left of the chevron').toBeLessThanOrEqual(geometry.chevLeft + 0.5)

  await expectBarHoldsItsWords(bar())
  const abandoned = await open(runUrl(RUN_ACCEPTED_ABANDONED, undefined, UX_ACCEPTED_WORKFLOW_ID), text => /operator override/.test(text) && /ago/.test(text))
  seen.push(abandoned)
  await expectBarHoldsItsWords(bar())

  for (const text of seen) expect(text, text).not.toMatch(SPAN_OF_HOURS)
  await attach(page, testInfo, 'dock-times')
})

test(`An accepted run's dock bar holds its words whole on a short window, where the open body overflows (${phase})`, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 700 })
  await page.clock.install({ time: new Date('2026-10-21T12:00:00Z') })
  for (const runId of [RUN_ACCEPTED_BLOCKED, RUN_ACCEPTED_ABANDONED]) {
    await page.goto(runUrl(runId, undefined, UX_ACCEPTED_WORKFLOW_ID))
    const bar = liveDock(page).getByTestId('live-dock-bar')
    await expect(bar).toBeVisible()
    await expect(bar).toContainText(/operator override/)
    await expectBarHoldsItsWords(bar)
  }
})

test(`A running run's bar reads "for <span>" and the span advances when the clock moves one minute (${phase})`, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.clock.install({ time: new Date('2026-03-12T10:24:20Z') })
  await page.goto(runUrl(RUN_REVAMP_RUNNING, undefined, REVAMP_PAGES_WORKFLOW_ID))
  const since = liveDock(page).getByTestId('live-dock-bar').locator('.lv-since')
  await expect(since).toHaveText(/^for \d+m\d+s$|^for \d+h\d+m$/)
  await page.clock.pauseAt(new Date('2026-03-12T10:24:40Z'))
  const before = await since.innerText()
  await page.clock.runFor(60_000)
  await expect.poll(() => since.innerText()).not.toBe(before)
  expect(await since.innerText()).toMatch(/^for \d+m\d+s$|^for \d+h\d+m$/)
  expect(await liveDock(page).getByTestId('live-dock-bar').innerText()).not.toMatch(/\b\d{3,}h\d{2}m\b/)
})

test(`[scenario:now-open] "Open <step> ›" in the live dock opens the step's page and Back returns; "Show in graph" beside it centres the step and opens its sheet without leaving the run page; both work from the keyboard (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const runPage = runUrl(RUN_REVAMP_BLOCKED, undefined, REVAMP_PAGES_WORKFLOW_ID)
  await page.goto(runPage)
  await expect(now(page)).toHaveAttribute('data-situation', 'review_blocked')
  const dock = liveDock(page)
  const open = dock.getByTestId('now-open')
  const show = dock.getByRole('button', { name: 'Show in graph' })
  await expect(open).toBeVisible()
  await expect(show).toBeVisible()
  const href = (await open.getAttribute('href'))!
  const nodeId = /\/nodes\/([^/?#]+)$/.exec(href)![1]!
  const urlOfRun = page.url()
  // "Show in graph" is a button beside the link, and does what "Open" did: it centres the step and opens its sheet.
  expect(await show.evaluate(element => element.tagName)).toBe('BUTTON')
  await show.focus()
  await page.keyboard.press('Enter')
  await expect(stepSheet(page)).toHaveAttribute('data-node-id', nodeId)
  expect(page.url(), 'the address does not change').toBe(urlOfRun)
  const stageBox = await rectOf(page.getByTestId('run-stage'))
  const card = await rectOf(graphNode(page, nodeId))
  // The sheet takes the stage's right 440 px: the card is centred in the rest, vertically in the stage.
  await expect.poll(async () => {
    const moved = await rectOf(graphNode(page, nodeId))
    return Math.abs((moved.x + moved.width / 2) - (stageBox.x + (stageBox.width - 440) / 2))
  }, { message: 'the card is centred beside the sheet' }).toBeLessThanOrEqual(40)
  expect(Math.abs((card.y + card.height / 2) - (stageBox.y + stageBox.height / 2))).toBeLessThanOrEqual(40)
  await attach(page, testInfo, 'now-open')
  await stepSheet(page).getByRole('button', { name: 'Close step details' }).click()
  await expect(stepSheet(page)).toHaveCount(0)

  // "Open <step> ›" is a link to the step's page, through the app's own navigation, from the keyboard too.
  await open.focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/nodes/${nodeId}$`))
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', nodeId)
  await expect(page.getByTestId('node-header')).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(urlOfRun)
  await expect(now(page)).toHaveAttribute('data-situation', 'review_blocked')
  await expect(liveDock(page).getByTestId('now-open')).toBeVisible()
  // The sheet's own "Open step page" is unchanged.
  await openStepSheet(page, nodeId)
  await expect(stepSheet(page).getByTestId('sheet-open-page')).toHaveAttribute('href', new RegExp(`/nodes/${nodeId}$`))
})

test(`[scenario:identity-line] The identity line shows "definition current" or "definition changed since" without the revision, and the source branch and base commit as "<branch> @ <sha>" with the full values in its title; a run without a recorded branch reads "no branch recorded"; a phone hides the branch and keeps a changed definition (${phase})`, async ({ page }, testInfo) => {
  test.slow()
  await page.setViewportSize({ width: 1440, height: 900 })
  const header = page.getByTestId('run-header')
  const branch = page.getByTestId('run-branch')
  const detailFact = (label: string) => page.getByTestId('run-inputs-facts').locator('div').filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) }).locator('dd')

  // A current definition: the chip says so, the line carries no revision, and the branch and base are on the line outside Details.
  await page.goto(runUrl(RUN_REVAMP_DONE, undefined, REVAMP_PAGES_WORKFLOW_ID))
  await expect(now(page)).toHaveAttribute('data-situation', 'succeeded')
  await expect(page.getByTestId('definition-current')).toBeVisible()
  await expect(page.getByTestId('definition-current')).toHaveText('definition current')
  await expect(page.getByTestId('definition-changed')).toHaveCount(0)
  await expect(branch).toBeVisible()
  expect(await branch.evaluate(element => element.closest('[data-testid=run-details]') === null), 'outside Details').toBe(true)
  const line = (await header.innerText()).replace(/\s+/g, ' ')
  expect(line, 'no revision on the line').not.toMatch(/[0-9a-f]{12}/)
  await openRunDetails(page)
  const source = (await detailFact('Source branch').innerText()).trim()
  const base = (await detailFact('Base commit').innerText()).trim()
  expect(base).toMatch(/^[0-9a-f]{40}$/)
  await expect(branch).toHaveText(`${source} @ ${base.slice(0, 7)}`)
  await expect(branch).toHaveAttribute('title', `${source} @ ${base}`)
  // Details still lists the pinned definition with its revision.
  await expect(page.getByTestId('run-details')).toContainText(/Pinned definition[\s\S]*revision\s*[0-9a-f]{12}/)
  await attach(page, testInfo, 'identity-line')

  // A definition that changed since the run: the chip is a warning that says so.
  await page.goto(runUrl(RUN_SUCCEEDED))
  await expect(page.getByTestId('definition-changed')).toBeVisible()
  await expect(page.getByTestId('definition-changed')).toHaveText('definition changed since')
  expect((await header.innerText()).replace(/\s+/g, ' ')).not.toMatch(/[0-9a-f]{12}/)

  // A run whose inputs record no source branch.
  await page.goto(runUrl(RUN_NO_BRANCH, undefined, UX_RUN_WORKFLOW_ID))
  await expect(branch).toBeVisible()
  await expect(branch).toHaveText(/^no branch recorded @ [0-9a-f]{7}$/)
  await openRunDetails(page)
  await expect(detailFact('Source branch')).toHaveText('None recorded')
  const noBase = (await detailFact('Base commit').innerText()).trim()
  await expect(branch).toHaveAttribute('title', `no branch recorded @ ${noBase}`)

  // At 390 px the branch hides like the definition chip, a changed definition stays, and the page does not scroll sideways.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(runUrl(RUN_REVAMP_DONE, undefined, REVAMP_PAGES_WORKFLOW_ID))
  await expect(now(page)).toHaveAttribute('data-situation', 'succeeded')
  await expect(branch).toBeHidden()
  await expect(page.getByTestId('definition-current')).toBeHidden()
  expect(await pageWidth(page)).toBeLessThanOrEqual(390)
  await page.goto(runUrl(RUN_SUCCEEDED))
  await expect(page.getByTestId('definition-changed')).toBeVisible()
  await expect(branch).toBeHidden()
  expect(await pageWidth(page)).toBeLessThanOrEqual(390)
})

/**
 * A column stays a column when the Sessions table's scrollbar appears after load. The suite's default Chromium hides its
 * scrollbars (`--hide-scrollbars`), so this one test launches its own browser without that flag, on a page with the same
 * mocks and context options as the default one, and closes it in `finally`.
 */
test(`[scenario:dock-column-hold] A dock column stays a column when the sessions load and their scrollbar appears; resizing still switches at 1200 px (${phase})`, async ({ playwright, baseURL }, testInfo) => {
  test.slow()
  const browser = await playwright.chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] })
  try {
    const context = await browser.newContext({ baseURL, timezoneId: 'UTC', locale: 'en-GB', reducedMotion: 'reduce' })
    const page = await context.newPage()
    if (phase === 'worker') await installProjectMocks(page)
    // The sessions are held back, so the page has no scrollbar until they arrive.
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    await page.route(url => url.pathname.endsWith(`/runs/${RUN_SESSIONS}/sessions`), async route => {
      await gate
      await route.fallback()
    })
    const gutterOf = () => page.evaluate('window.innerWidth - document.documentElement.clientWidth') as Promise<number>
    const board = page.getByTestId('run-board')
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(runUrl(RUN_SESSIONS, undefined, UX_SESSIONS_WORKFLOW_ID))
    await expect(page.getByTestId('run-stage')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('sessions-cue')).toHaveCount(0)
    // The page scrolls as soon as the stage has its height (the workspace's own padding sits below the frame), so the scrollbar
    // is there before the sessions arrive; the frame is sized so that it measures 1205 px without it.
    const gutter = await gutterOf()
    expect(gutter, 'this browser draws a page scrollbar').toBeGreaterThan(0)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const measured = await frameWidthOf(page)
      if (measured === 1205 - gutter) break
      await page.setViewportSize({ width: page.viewportSize()!.width + (1205 - gutter - measured), height: 900 })
    }
    const before = { gutter: await gutterOf(), frame: await frameWidthOf(page) }
    expect(before.frame + before.gutter, 'the frame is 1205 px wide without the scrollbar').toBe(1205)
    expect(before.frame, 'and under 1200 px with it').toBeLessThan(1200)
    await expect(board, 'the column holds before the sessions arrive').toHaveAttribute('data-dock', 'column')
    release()
    await expect(page.getByTestId('sessions-cue')).toBeVisible()
    await expect(board, 'and when they have loaded').toHaveAttribute('data-dock', 'column')
    const after = { gutter: await gutterOf(), frame: await frameWidthOf(page) }
    testInfo.annotations.push({ type: 'dock-column-hold', description: `before the sessions: gutter ${before.gutter} px, run-board clientWidth ${before.frame} px; after: gutter ${after.gutter} px, run-board clientWidth ${after.frame} px` })
    expect(after.frame + after.gutter, 'the scrollbar and the frame still make 1205 px').toBe(1205)
    await attach(page, testInfo, 'dock-column-hold')

    // Genuine resizing still switches at 1200 px, counted without the scrollbar: the frame and the scrollbar together.
    const sizeToTotal = async (total: number) => {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const measured = (await frameWidthOf(page)) + (await gutterOf())
        if (measured === total) return
        await page.setViewportSize({ width: page.viewportSize()!.width + (total - measured), height: 900 })
        await page.waitForTimeout(150)
      }
      expect((await frameWidthOf(page)) + (await gutterOf())).toBe(total)
    }
    await sizeToTotal(1199)
    await expect(board).toHaveAttribute('data-dock', 'overlay')
    await sizeToTotal(1200)
    await expect(board).toHaveAttribute('data-dock', 'column')
    await sizeToTotal(1199)
    await expect(board).toHaveAttribute('data-dock', 'overlay')
  } finally {
    await browser.close()
  }
})
