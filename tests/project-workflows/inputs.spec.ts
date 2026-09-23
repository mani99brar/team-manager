import { test, expect, type Page } from '@playwright/test'
import {
  ADAPTER_COMPLETION_SUMMARY,
  ADAPTER_HANDOFF_ASSUMPTION,
  ADAPTER_HANDOFF_SUMMARY,
  BASE_COMMIT,
  FEATURE_NAME,
  PARAPHRASED_QUOTE,
  PATH_TOKEN,
  RUN_AWAITING,
  RUN_FAILED,
  RUN_LEGACY,
  RUN_SUCCEEDED,
  UI_ASSUMPTION,
  UI_QUOTE,
  UI_SESSION,
  sourceBranch,
  uiCompletionSummary,
  uiPathQuote,
  uiTask,
} from './fixtures.ts'
import { attach, expectNoExecutionControls, installHooks, nodeDetail, nodeListItem, openTask, phase, renderedText, runUrl, taskDetails } from './support.ts'

installHooks()

const taskPanel = (page: Page) => page.getByTestId('task-panel')
const findingRows = (page: Page) => page.getByTestId('review-findings').getByTestId('finding')
const assignmentWorker = (page: Page, lane: string) => page.locator(`[data-testid="assignment-worker"][data-worker="${lane}"]`)

test(`[scenario:run-assignment] The Assignment tab shows what the run was asked to do, with tasks rendered as Markdown (${phase})`, async ({ page }, testInfo) => {
  await page.goto(runUrl(RUN_SUCCEEDED))
  const tablist = page.getByRole('tablist', { name: 'Run views' })
  await expect(tablist.getByRole('tab')).toHaveText(['Run', 'Assignment'])
  const runTab = page.getByTestId('tab-run')
  const assignmentTab = page.getByTestId('tab-assignment')
  await expect(runTab).toHaveAttribute('aria-selected', 'true')
  await expect(assignmentTab).toHaveAttribute('aria-selected', 'false')

  // The run header carries the pinned inputs as facts, deadlines computed from the automatic settings.
  const facts = page.getByTestId('run-inputs-facts')
  await expect(facts).toContainText(FEATURE_NAME)
  await expect(facts).toContainText(BASE_COMMIT.slice(0, 12))
  await expect(facts).toContainText(sourceBranch(RUN_SUCCEEDED))
  await expect(facts).toContainText('automatic')
  await expect(facts).toContainText('worker 4h · review 30m')
  await expect(facts).toContainText('bypassPermissions')
  await expect(facts).toContainText('verified-feature-branch')
  await expect(page.getByTestId('inputs-none')).toHaveCount(0)

  await assignmentTab.click()
  await expect(assignmentTab).toHaveAttribute('aria-selected', 'true')
  await expect(runTab).toHaveAttribute('aria-selected', 'false')
  const assignment = page.getByTestId('assignment')
  await expect(assignment).toHaveAttribute('role', 'tabpanel')
  await expect(assignment).toHaveAttribute('id', (await assignmentTab.getAttribute('aria-controls'))!)
  await expect(page.getByTestId('workflow-graph')).toHaveCount(0)
  await expect(assignment).toContainText(FEATURE_NAME)
  await expect(assignment).toContainText(sourceBranch(RUN_SUCCEEDED))
  await expect(assignment).toContainText('automatic')
  await expect(assignment).toContainText('worker 4h · review 30m')
  await expect(assignment).toContainText('native')
  await expect(page.getByTestId('assignment-setup').locator('code')).toHaveText(['npm ci'])
  await expect(assignment).toContainText('Attempt cap')
  await expect(assignment).toContainText('3 per lane and phase')

  // Each worker's task is rendered as Markdown: headings and list items, not raw text; ownership and checks follow.
  const ui = assignmentWorker(page, 'ui')
  const uiTaskPanel = ui.getByTestId('assignment-task')
  await expect(uiTaskPanel.getByRole('heading', { name: 'UI worker' })).toBeVisible()
  await expect(uiTaskPanel.getByRole('heading', { name: 'Deliverables' })).toBeVisible()
  await expect(uiTaskPanel.getByRole('listitem')).toContainText([UI_QUOTE])
  await expect(uiTaskPanel).toContainText('Approved ownership and checks:')
  await expect(ui).toContainText('frontend')
  await expect(ui).toContainText('src/projects')
  await expect(ui).toContainText('npm run build')
  await expect(ui).toContainText('project-workflows-browser')
  const adapter = assignmentWorker(page, 'adapter')
  await expect(adapter.getByTestId('assignment-task').getByRole('heading', { name: 'Adapter worker' })).toBeVisible()
  await expect(adapter).toContainText('backend')
  await expect(adapter).toContainText('server/projects.test.ts')
  await expectNoExecutionControls(page)
  await attach(page, testInfo, 'run-assignment')

  // Tabs are keyboard operable: Left from Assignment selects Run and the graph is back.
  await assignmentTab.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(runTab).toBeFocused()
  await expect(runTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('workflow-graph')).toBeVisible()
  await expect(assignment).toHaveCount(0)

  // A manual run states its mode and has no automatic deadlines to show.
  await page.goto(runUrl(RUN_AWAITING))
  await expect(page.getByTestId('run-inputs-facts')).toContainText('manual')
  await expect(page.getByTestId('run-inputs-facts')).not.toContainText('review 30m')
})

test(`[scenario:worker-inputs] A worker node shows its task, ownership, required checks linked to executed ones, launch receipt and completion (${phase})`, async ({ page }, testInfo) => {
  await page.goto(runUrl(RUN_SUCCEEDED, 'launch_ui'))
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'launch_ui')
  await openTask(page)
  const task = taskPanel(page)
  await expect(task).toBeVisible()
  const rendered = task.getByRole('button', { name: 'Rendered' })
  const source = task.getByRole('button', { name: 'Source' })
  await expect(rendered).toHaveAttribute('aria-pressed', 'true')
  await expect(source).toHaveAttribute('aria-pressed', 'false')
  await expect(task.getByRole('heading', { name: 'UI worker' })).toBeVisible()
  await expect(page.getByTestId('task-source')).toHaveCount(0)

  // Source shows the exact pinned text; the toggle works from the keyboard too.
  await source.click()
  await expect(source).toHaveAttribute('aria-pressed', 'true')
  expect(await page.getByTestId('task-source').textContent()).toBe(uiTask())
  await rendered.focus()
  await page.keyboard.press('Enter')
  await expect(rendered).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('task-source')).toHaveCount(0)

  // Ownership and the required checks: executed ones link to the verify node that shows them with their logs, the rest say so.
  await expect(page.getByTestId('task-owned-paths').locator('li')).toContainText(['src/projects'])
  const checks = page.getByTestId('task-checks')
  await expect(checks.locator('[data-check-id]')).toHaveCount(4)
  const build = checks.locator('[data-check-id="frontend-build"]')
  await expect(build.getByRole('link')).toHaveAttribute('href', runUrl(RUN_SUCCEEDED, 'verify_ui'))
  await expect(build.getByRole('link')).toHaveAttribute('data-check-index', '0')
  await expect(build).toContainText('exit 0')
  await expect(checks.locator('[data-check-id="project-workflows-browser"]').getByRole('link')).toHaveAttribute('data-check-index', '2')
  await expect(checks.locator('[data-check-id="frontend-typecheck"]')).toContainText('not executed in this result')
  await expect(checks.locator('[data-check-id="frontend-typecheck"]').getByRole('link')).toHaveCount(0)

  // The exact prompt is available but collapsed by default.
  const prompt = page.getByTestId('task-prompt')
  await expect(prompt).toBeVisible()
  await expect(prompt).not.toHaveAttribute('open', '')
  await prompt.locator('summary').click()
  await expect(prompt).toContainText('You are a workflow worker in your own worktree')

  // Launch receipt, completion signal, no separate handoff (identical), and the stop confirmation on the timeline.
  const launch = page.getByTestId('launch-receipt')
  await expect(launch).toContainText(UI_SESSION)
  await expect(launch).toContainText('attached_session_available')
  await expect(launch).toContainText('2026-03-01 10:00:00 UTC')
  await expect(launch).toContainText('2026-03-01 10:00:02 UTC')
  const receiptRow = (label: string) => launch.locator('.projects-facts > div').filter({ has: page.locator('dt', { hasText: label }) }).locator('dd')
  await expect(receiptRow('Observed state')).toHaveText('done')
  await expect(receiptRow('Launcher invocations')).toHaveText('1')
  await expect(receiptRow('Launcher status')).toHaveText('attached_session_available')
  await expect(nodeDetail(page)).not.toContainText('No session recorded')
  const completion = page.getByTestId('worker-completion')
  await expect(completion).toContainText('completed')
  await expect(completion).toContainText(uiCompletionSummary(PATH_TOKEN))
  await expect(completion).toContainText(UI_ASSUMPTION)
  await expect(page.getByTestId('worker-handoff')).toHaveCount(0)
  await expect(page.getByTestId('worker-stop')).toContainText('Stop confirmed at 2026-03-01 10:20:00 UTC')
  await expectNoExecutionControls(page)
  await attach(page, testInfo, 'worker-inputs')

  // The executed-check link opens the verify node, which shows that check with its log.
  await build.getByRole('link').click()
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'verify_ui')
  await expect(page.locator('#check-0 .check-command')).toHaveText('npm run build')

  // The adapter recorded no prompt, and its accepted handoff differs from what it reported.
  await page.goto(runUrl(RUN_SUCCEEDED, 'launch_adapter'))
  await openTask(page)
  await expect(taskPanel(page)).toBeVisible()
  await expect(page.getByTestId('task-prompt')).toHaveCount(0)
  await expect(taskPanel(page)).toContainText('prompt was not recorded')
  await expect(page.getByTestId('worker-completion')).toContainText(ADAPTER_COMPLETION_SUMMARY)
  const handoff = page.getByTestId('worker-handoff')
  await expect(handoff).toContainText(ADAPTER_HANDOFF_SUMMARY)
  await expect(handoff).toContainText(ADAPTER_HANDOFF_ASSUMPTION)

  // Absent receipts are stated, never invented.
  await page.goto(runUrl(RUN_FAILED, 'launch_adapter'))
  await expect(page.getByTestId('worker-completion')).toContainText('No completion signal recorded')
  await expect(page.getByTestId('worker-handoff')).toHaveCount(0)
  await expect(page.getByTestId('worker-stop')).toContainText('Stop not confirmed')
})

test(`[scenario:finding-to-task] A verbatim requirement quote links to the worker task and is highlighted there (${phase})`, async ({ page }, testInfo) => {
  await page.goto(runUrl(RUN_SUCCEEDED, 'review'))
  await expect(findingRows(page)).toHaveCount(6)

  // Three quotes are found verbatim (two in the UI task, one in the adapter task); the paraphrase is shown unlinked.
  await expect(page.getByTestId('finding-task-link')).toHaveCount(3)
  await expect(page.locator('[data-testid="finding-task-link"][data-lane="ui"]')).toHaveCount(2)
  await expect(page.locator('[data-testid="finding-task-link"][data-lane="adapter"]')).toHaveAttribute('href', runUrl(RUN_SUCCEEDED, 'launch_adapter'))
  const unlinked = findingRows(page).filter({ hasText: PARAPHRASED_QUOTE })
  await expect(unlinked.getByTestId('finding-requirement')).toHaveText(PARAPHRASED_QUOTE)
  await expect(unlinked.getByTestId('finding-task-unlinked')).toHaveText('not found verbatim in the task')
  await expect(unlinked.getByTestId('finding-task-link')).toHaveCount(0)
  await expect(findingRows(page).filter({ hasText: 'root Playwright suite' }).locator('td').last()).toHaveText('—')

  const linked = findingRows(page).filter({ hasText: UI_QUOTE })
  const link = linked.getByTestId('finding-task-link')
  await expect(link).toHaveAttribute('data-lane', 'ui')
  await expect(link).toHaveAttribute('href', runUrl(RUN_SUCCEEDED, 'launch_ui'))
  await link.click()
  await expect(page).toHaveURL(new RegExp(`${runUrl(RUN_SUCCEEDED, 'launch_ui')}$`))
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'launch_ui')

  // The task disclosure, closed by default on a launch node, is opened by the hand-over.
  await expect(taskDetails(page)).toHaveAttribute('open', '')

  // The task panel is forced to Source and the quote is wrapped in a visible, scrolled-into-view mark.
  await expect(taskPanel(page).getByRole('button', { name: 'Source' })).toHaveAttribute('aria-pressed', 'true')
  const highlight = page.getByTestId('task-highlight')
  await expect(highlight).toBeVisible()
  await expect(highlight).toHaveText(UI_QUOTE)
  expect(await highlight.evaluate(element => element.tagName)).toBe('MARK')
  await expect(page.getByTestId('task-source')).toContainText(UI_QUOTE)
  await expect.poll(() => highlight.evaluate(element => {
    const box = element.getBoundingClientRect()
    return box.top >= 0 && box.bottom <= element.ownerDocument.defaultView!.innerHeight
  })).toBe(true)
  await attach(page, testInfo, 'finding-to-task')

  // Leaving the node clears the highlight: returning through the node list shows the plain rendered task.
  await nodeListItem(page, 'review').getByRole('link').click()
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'review')
  await nodeListItem(page, 'launch_ui').getByRole('link').click()
  await expect(taskDetails(page)).toBeVisible()
  await expect(taskDetails(page)).not.toHaveAttribute('open', '')
  await expect(page.getByTestId('task-highlight')).toHaveCount(0)
  await openTask(page)
  await expect(taskPanel(page).getByRole('button', { name: 'Rendered' })).toHaveAttribute('aria-pressed', 'true')

  // A quote that names a directory still links, and the highlighted text is the redacted form.
  await page.goto(runUrl(RUN_SUCCEEDED, 'review'))
  await findingRows(page).filter({ hasText: uiPathQuote(PATH_TOKEN) }).getByTestId('finding-task-link').click()
  await expect(page.getByTestId('task-highlight')).toHaveText(uiPathQuote(PATH_TOKEN))
})

test(`[scenario:inputs-legacy] A run exported before run inputs says they are not recorded, without an error (${phase})`, async ({ page }, testInfo) => {
  await page.goto(runUrl(RUN_LEGACY))
  await expect(page.getByTestId('run-view')).toHaveAttribute('data-run-status', 'succeeded')
  await expect(page.getByTestId('inputs-none')).toContainText('Inputs not recorded for this run')
  await expect(page.getByTestId('run-inputs-facts')).toHaveCount(0)
  await expect(page.getByTestId('projects-error')).toHaveCount(0)

  await page.getByTestId('tab-assignment').click()
  const assignment = page.getByTestId('assignment')
  await expect(assignment).toContainText('Inputs not recorded for this run')
  await expect(assignment.getByTestId('assignment-worker')).toHaveCount(0)
  await expect(page.getByTestId('projects-error')).toHaveCount(0)
  await attach(page, testInfo, 'inputs-legacy')

  // Worker nodes still show their verified evidence, and say the inputs are not recorded instead of inventing them.
  await page.goto(runUrl(RUN_LEGACY, 'launch_ui'))
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'launch_ui')
  await expect(page.getByTestId('worker-result')).toBeVisible()
  await expect(page.getByTestId('worker-inputs-none')).toContainText('Inputs not recorded')
  await expect(taskPanel(page)).toHaveCount(0)
  await expect(page.getByTestId('launch-receipt')).toHaveCount(0)
  await expect(page.getByTestId('worker-completion')).toHaveCount(0)
  await expect(page.getByTestId('projects-error')).toHaveCount(0)
})

test(`[scenario:inputs-paths-redacted] No absolute path from the seeded inputs reaches the rendered assignment or worker panels (${phase})`, async ({ page }, testInfo) => {
  await page.goto(runUrl(RUN_SUCCEEDED))
  await expect(page.getByTestId('run-inputs-facts')).toBeVisible()
  await renderedText(page.locator('.run-summary'))
  await page.getByTestId('tab-assignment').click()
  const assignment = page.getByTestId('assignment')
  await expect(assignment.getByTestId('assignment-worker')).toHaveCount(2)
  expect(await renderedText(assignment)).toContain(PATH_TOKEN)
  await attach(page, testInfo, 'inputs-paths-redacted')

  // The worker node's task source, exact prompt and completion signal are all served redacted.
  await page.goto(runUrl(RUN_SUCCEEDED, 'launch_ui'))
  await expect(page.getByTestId('worker-completion')).toContainText(PATH_TOKEN)
  await openTask(page)
  await taskPanel(page).getByRole('button', { name: 'Source' }).click()
  await page.getByTestId('task-prompt').locator('summary').click()
  await expect(page.getByTestId('task-prompt')).toContainText(uiPathQuote(PATH_TOKEN))
  const detail = await renderedText(nodeDetail(page))
  expect(detail).toContain(PATH_TOKEN)
})
