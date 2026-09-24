/**
 * Viewer UX slice S4-core, the node shell (docs/PRD_VIEWER_UX.md 4.4, 7 and 8): a node page opens on its header (the status
 * worded by cause, the timing line of its attempt, its attempt number, "not started" instead of attempt 0, the attempt
 * strip with the controller's diagnosis and the operator's repair, and the run's next step when the node is its focus),
 * then a section index whose counts match the sections, where empty sections are absent and History comes last. A
 * result shared by the launch and verify nodes is said once: its facts on verify, the worker's narrative on launch. Every
 * earlier attempt has its own page, reached from the strip and from Activity.
 */
import { test, expect, type Page, type Route } from '@playwright/test'
import { OUTPUT_COMMIT_UI, RUN_FAILED } from './fixtures.ts'
import { RUN_IDENTICAL, UX_RUN_WORKFLOW_ID } from './fixtures/ux-run.ts'
import { NODE_ASSUMPTION, NODE_VERIFY_FAILURE, NODE_WORKER_SUMMARY, REPAIRED_COMMIT, RUN_THIRD_ATTEMPT, UX_NODE_WORKFLOW_ID } from './fixtures/ux-node.ts'
import { attach, expectNoExecutionControls, installHooks, nodeDetail, phase, runUrl } from './support.ts'

installHooks()

const nodeUrl = (nodeId?: string) => runUrl(RUN_THIRD_ATTEMPT, nodeId, UX_NODE_WORKFLOW_ID)
const attemptUrl = (nodeId: string, attempt: number) => `${nodeUrl(nodeId)}/attempts/${attempt}`
const header = (page: Page) => page.getByTestId('node-header')
const sectionIndex = (page: Page) => page.getByTestId('section-index')
const indexLink = (page: Page, key: string) => sectionIndex(page).locator(`a[data-section="${key}"]`)
const attempts = (page: Page) => page.getByTestId('node-attempts')
const chip = (page: Page, attempt: number) => attempts(page).locator(`a[data-attempt="${attempt}"]`)
const resultPattern = (attempt: number) => new RegExp(`/runs/${RUN_THIRD_ATTEMPT}/results/ui/${attempt}$`)

test(`[scenario:node-header] A node opens on its status by cause, its timing and attempt, the next step on the focus, and a section index whose counts match (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(nodeUrl('verify_ui'))
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'verify_ui')

  // The header: the status, who executed the step, the latest attempt's times with its setup and check split.
  await expect(header(page).locator('.status-badge').first()).toHaveText('Succeeded')
  await expect(page.getByTestId('node-executor')).toHaveText('trusted verifier')
  await expect(page.getByTestId('node-attempt')).toHaveText('3')
  const timing = page.getByTestId('node-timing')
  await expect(timing).toContainText('09:28:05')
  await expect(timing).toContainText('09:29:20')
  await expect(timing).toContainText('1m15s')
  await expect(timing).toContainText('setup 42s')
  await expect(timing).toContainText('checks 31s')
  await expect(page.getByTestId('node-status-meaning')).toContainText('after operator repair 1')
  // A passed verification does not count its attempts against the cap.
  await expect(page.getByTestId('node-attempt-revision')).toHaveCount(0)

  // The section index: in-page links with counts that equal what each section lists; History comes last.
  await expect(page.getByRole('navigation', { name: 'Sections of Verify ui' })).toBeVisible()
  await expect(indexLink(page, 'checks')).toHaveAttribute('data-count', '3')
  await expect(page.getByTestId('checks-list').locator('.check')).toHaveCount(3)
  await expect(indexLink(page, 'screenshots')).toHaveAttribute('data-count', '1')
  await expect(page.getByTestId('screenshots').locator('li')).toHaveCount(1)
  const events = await page.getByTestId('node-events').locator('li').count()
  expect(events).toBeGreaterThan(0)
  await expect(indexLink(page, 'history')).toHaveAttribute('data-count', String(events))
  await expect(sectionIndex(page).locator('a').last()).toHaveAttribute('data-section', 'history')
  await expect(nodeDetail(page).locator('section[data-section]').last()).toHaveAttribute('data-section', 'history')
  for (const link of await sectionIndex(page).locator('a').all()) {
    const target = (await link.getAttribute('href'))!.replace(/^#/, '')
    await expect(nodeDetail(page).locator(`section[id="${target}"]`)).toHaveAttribute('aria-labelledby', /.+/)
  }
  // Following a link brings its section into view.
  await indexLink(page, 'history').click()
  await expect(page.getByTestId('node-events')).toBeInViewport()

  // Empty sections are absent: no reuse without reuse events, no empty-state lines.
  await expect(page.getByTestId('reuse-none')).toHaveCount(0)
  await expect(page.getByTestId('reuse-list')).toHaveCount(0)
  await expect(nodeDetail(page)).not.toContainText('Reuse evidence')
  await expect(page.getByTestId('checks-empty')).toHaveCount(0)
  await expect(nodeDetail(page)).not.toContainText('graph node attempt is')

  // One home per result: the facts on verify, the worker's report only on its launch node, linked from here.
  const reportLink = page.getByTestId('worker-report-link')
  await expect(reportLink).toContainText("Worker's report")
  await expect(reportLink.getByRole('link')).toHaveAttribute('href', nodeUrl('launch_ui'))
  await expect(page.getByTestId('worker-summary')).toHaveCount(0)
  await expect(page.getByTestId('assumptions')).toHaveCount(0)
  await attach(page, testInfo, 'node-header')
  await reportLink.getByRole('link').click()
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'launch_ui')
  await expect(page.getByTestId('worker-summary')).toHaveText(NODE_WORKER_SUMMARY)
  await page.getByTestId('assumptions-details').getByText('Open assumptions (1)').click()
  await expect(page.getByTestId('assumptions')).toBeVisible()
  await expect(page.getByTestId('assumptions')).toContainText(NODE_ASSUMPTION)
  // The launch line: the revision frozen at handoff, verified on attempt 3 after the repair as the repaired revision.
  const verified = page.getByTestId('worker-verified')
  await expect(verified).toHaveAttribute('data-state', 'verified')
  await expect(verified).toContainText(`Frozen at handoff as ${OUTPUT_COMMIT_UI.slice(0, 7)}; verified on attempt 3 after operator repair 1 as ${REPAIRED_COMMIT.slice(0, 7)}`)
  await expect(page.getByTestId('node-status-meaning')).toContainText('verified by Verify ui')
  await expect(page.getByTestId('node-timing')).toContainText('from the launch receipt and the stop receipt')
  await expect(indexLink(page, 'questions')).toHaveCount(0)
  await expect(page.getByTestId('node-attempts')).toHaveCount(0)

  // A result whose verification failed is never called verified, on the line or in the status; the failure is linked.
  await page.goto(runUrl(RUN_FAILED, 'launch_adapter'))
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'launch_adapter')
  await expect(page.getByTestId('worker-verified')).toHaveAttribute('data-state', 'failed')
  await expect(page.getByTestId('worker-verified')).toContainText(/verification failed on attempt 1/i)
  await expect(page.getByTestId('worker-verified').getByRole('link')).toHaveText("the gate's reasons on Verify adapter ›")
  await expect(page.getByTestId('node-status-meaning')).toContainText('verification failed at Verify adapter')
  await expect(nodeDetail(page)).not.toContainText(/verified on attempt|verified by/)

  // A step that never started says so, and has no timing.
  await page.goto(nodeUrl('integrate'))
  await expect(page.getByTestId('node-attempt')).toHaveText('not started')
  await expect(page.getByTestId('node-timing')).not.toContainText('→')
  await expect(page.getByTestId('result-none')).toBeVisible()
  await expect(page.getByTestId('events-none')).toBeVisible()

  // The run's focus repeats the Now banner's next step; another step does not.
  await page.goto(runUrl(RUN_IDENTICAL, 'candidate', UX_RUN_WORKFLOW_ID))
  const next = page.getByTestId('node-next')
  await expect(next).toBeVisible()
  await expect(next.getByTestId('now-command').first()).toContainText('"$PY" -m workflow repair "$RUN" ui')
  await expect(page.getByTestId('node-status-meaning')).toContainText('This step failed')
  await page.goto(runUrl(RUN_IDENTICAL, 'verify_ui', UX_RUN_WORKFLOW_ID))
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'verify_ui')
  await expect(page.getByTestId('node-next')).toHaveCount(0)
  await expectNoExecutionControls(page)
})

test(`[scenario:node-attempts] Earlier attempts have their own pages, linked from the attempt strip once their result loads and from Activity (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  // Attempt 1's result is held until released, and attempt 2's is gone: a chip waits for its result, and never links a missing one.
  let release!: () => void
  const released = new Promise<void>(resolve => { release = resolve })
  await page.route(resultPattern(1), async (route: Route) => { await released; await route.fallback() })
  await page.route(resultPattern(2), (route: Route) => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'RESULT_NOT_FOUND', message: 'No such result.' } }) }))

  await page.goto(nodeUrl('verify_ui'))
  await expect(chip(page, 3)).toBeVisible()
  await expect(chip(page, 1)).toHaveCount(0)
  // The controller's diagnosis and the operator's repair sit between the attempts they concern.
  const items = attempts(page).locator('[data-item]')
  await expect(items).toHaveCount(3)
  await expect(attempts(page).locator('[data-item="diagnosis"]')).toContainText('⚑')
  await expect(attempts(page).locator('[data-item="repair"]')).toContainText('repair 1')
  release()
  await expect(chip(page, 1)).toBeVisible()
  // The chip names the checks the gate failed.
  await expect(chip(page, 1).getByTestId('node-attempt-reason')).toHaveText('frontend-unit, project-workflows-browser')
  await expect(chip(page, 2)).toHaveCount(0)
  await expect(attempts(page).locator('[data-item]')).toHaveCount(4)
  await expect(chip(page, 1)).toHaveAttribute('href', attemptUrl('verify_ui', 1))
  await expect(chip(page, 3)).toHaveAttribute('aria-current', 'page')
  await expect(attempts(page).locator('[data-item]').first()).toHaveAttribute('data-attempt', '1')
  await page.unroute(resultPattern(2))

  // Attempt 1's page reads its own result (already fetched for its chip): failed, with the gate's reasons, and says which
  // attempt is the latest. Opened from the keyboard, the focus moves to the new page's heading.
  await chip(page, 1).focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/nodes/verify_ui/attempts/1$`))
  await expect(page.locator('#node-detail-title')).toBeFocused()
  await expect(header(page).locator('.status-badge').first()).toHaveText('Failed')
  await expect(header(page)).toContainText(/Failed[\s\S]*attempt 1/)
  await expect(page.getByTestId('node-attempt')).toHaveText('1')
  await expect(page.getByTestId('node-timing')).toContainText('1m07s')
  await expect(page.getByTestId('node-attempt-revision')).toHaveText(' (1 of 3 on this revision)')
  const shownAttempt = page.getByTestId('result-facts').locator('div').filter({ has: page.locator('dt', { hasText: /^Attempt$/ }) }).locator('dd')
  await expect(shownAttempt).toHaveText('1')
  const banner = page.getByTestId('attempt-banner')
  await expect(banner).toContainText('You are viewing attempt 1 of 3. The latest is attempt 3 ›')
  await expect(banner.getByRole('link')).toHaveAttribute('href', nodeUrl('verify_ui'))
  await expect(page.getByTestId('gate-outcome')).toHaveAttribute('data-passed', 'false')
  // The gate's reasons are one bullet each (S4a), so the joined error text is read back from them.
  await expect(page.getByTestId('gate-reason')).toHaveText(NODE_VERIFY_FAILURE.split('; '))
  await expect(page.getByTestId('node-next')).toHaveCount(0)
  await attach(page, testInfo, 'node-attempts')

  // The attempt survives a reload, which reads results/ui/1 again (the run's cache lives with the page), and the banner
  // leads back to the latest, with the focus on its heading.
  const reread = page.waitForRequest(resultPattern(1))
  await page.reload()
  await reread
  await expect(page.getByTestId('node-attempt')).toHaveText('1')
  await expect(shownAttempt).toHaveText('1')
  await banner.getByRole('link').focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/nodes/verify_ui$`))
  await expect(page.locator('#node-detail-title')).toBeFocused()
  await expect(page.getByTestId('attempt-banner')).toHaveCount(0)
  await expect(page.getByTestId('gate-outcome')).toHaveAttribute('data-passed', 'true')

  // Activity's attempt rows open that attempt's page.
  await page.goto(nodeUrl())
  const failed = page.getByTestId('run-timeline').locator('li[data-node-id="verify_ui"][data-status="failed"]')
  await expect(failed).toHaveCount(2)
  await expect(failed.first().getByRole('link')).toHaveAttribute('href', attemptUrl('verify_ui', 1))
  await expect(failed.last().getByRole('link')).toHaveAttribute('href', attemptUrl('verify_ui', 2))
  await failed.last().getByRole('link').click()
  await expect(page.getByTestId('node-attempt')).toHaveText('2')
  await expect(page.getByTestId('attempt-banner')).toContainText('You are viewing attempt 2 of 3.')
  await expect(page.getByTestId('node-attempt-revision')).toHaveText(' (2 of 3 on this revision)')
  await expectNoExecutionControls(page)
})
