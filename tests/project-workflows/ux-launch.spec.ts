/**
 * Viewer UX slice S4b, the launch node (docs/PRD_VIEWER_UX.md 4.5, 7 and 8): the files a worker froze are dense rows that
 * fetch nothing until one opens, findings first, with a `⚒ repair n` mark on each file the operator's repair changed or
 * added, and Markdown that starts closed and opens on Rendered; while a question waits, the Questions section comes first
 * with both `answer` forms, and a running worker's Session says its state at launch.
 */
import { test, expect, type Page } from '@playwright/test'
import {
  LAUNCH_ADDED_PATH, LAUNCH_FINDING_PATHS, LAUNCH_FROZEN_PATHS, LAUNCH_QUESTIONS, LAUNCH_README_PATH, LAUNCH_REPAIRED_PATH, LAUNCH_ROOM_PATH,
  LAUNCH_SUMMARY, REPAIR_SUMMARY_NOTE, RUN_LAUNCH_ASKING, RUN_LAUNCH_REPAIRED, UX_LAUNCH_WORKFLOW_ID,
} from './fixtures/ux-launch.ts'
import { runDetails, runInputs } from './fixtures.ts'
import { apiRun, attach, expectNoExecutionControls, installHooks, nodeDetail, phase, runUrl } from './support.ts'

installHooks()

const launchUrl = (runId: string) => runUrl(runId, 'launch_ui', UX_LAUNCH_WORKFLOW_ID)
const rows = (page: Page) => page.getByTestId('changed-files').getByTestId('created-file')
const row = (page: Page, path: string) => page.locator(`[data-testid="created-file"][data-path="${path}"]`)
const filter = (page: Page, name: RegExp) => page.getByTestId('file-filters').getByRole('button', { name })
/** Every path the files list shows: the worker's freeze plus the file the repair added. */
const ALL_PATHS = [...LAUNCH_FROZEN_PATHS, LAUNCH_ADDED_PATH]

test(`[scenario:files-dense] The files are dense rows from the worker's freeze, findings first, with repair marks; nothing is fetched until a row opens, and Markdown opens on Rendered (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const fetched: string[] = []
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (path.includes('/artifacts/')) fetched.push(path)
  })
  await page.goto(launchUrl(RUN_LAUNCH_REPAIRED))
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'launch_ui')

  // One row per file; the review's findings sort their files first, the P1 before the P2s.
  await expect(rows(page)).toHaveCount(ALL_PATHS.length)
  await expect(rows(page).first()).toHaveAttribute('data-path', LAUNCH_ROOM_PATH)
  for (const [index, path] of LAUNCH_FINDING_PATHS.entries()) await expect(rows(page).nth(index)).toHaveAttribute('data-path', path)
  await expect(row(page, LAUNCH_ROOM_PATH).locator('summary')).toContainText('P1')
  await expect(row(page, LAUNCH_ROOM_PATH).locator('summary')).toContainText('lines 44–50')
  // Rows are about 32 px: the summary is one line, and its text is not a button.
  const box = await row(page, LAUNCH_ROOM_PATH).locator('summary').boundingBox()
  expect(box?.height).toBeLessThanOrEqual(36)
  await expect(page.getByTestId('changed-files').getByRole('button')).toHaveCount(0)

  // The filters: With findings first, then the repair's files, then all.
  await expect(page.getByTestId('file-filters').getByRole('button')).toHaveText(['With findings 3', 'Repair 1 · 2', `All ${ALL_PATHS.length}`])
  await filter(page, /^Repair/).click()
  await expect(rows(page)).toHaveCount(2)
  await expect(row(page, LAUNCH_REPAIRED_PATH)).toHaveAttribute('data-repair', 'changed')
  await expect(row(page, LAUNCH_REPAIRED_PATH).locator('summary')).toContainText('⚒ repair 1 · changed')
  await expect(row(page, LAUNCH_ADDED_PATH)).toHaveAttribute('data-repair', 'added')
  await expect(row(page, LAUNCH_ADDED_PATH).locator('summary')).toContainText('⚒ repair 1 · added')
  await filter(page, /^All/).click()
  await expect(rows(page)).toHaveCount(ALL_PATHS.length)

  // The report is said once, with only the verifier's added text beside it.
  await expect(page.getByTestId('worker-summary')).toHaveText(LAUNCH_SUMMARY)
  await expect(page.getByTestId('worker-verifier-note')).toHaveText(`Verifier note: ${REPAIR_SUMMARY_NOTE}`)
  await expect(nodeDetail(page).getByText('as signalled by the session, not verified')).toHaveCount(1)

  // No file content was fetched before a row opened.
  await page.waitForLoadState('networkidle')
  expect(fetched).toEqual([])
  await attach(page, testInfo, 'files-dense')

  // A Markdown row starts closed and opens on Rendered; only its content is fetched.
  const readme = row(page, LAUNCH_README_PATH).getByTestId('captured-file')
  await expect(readme).not.toHaveAttribute('open', '')
  await expect(readme.getByTestId('file-rendered')).toHaveCount(0)
  await readme.locator('summary').click()
  await expect(readme.getByTestId('file-rendered').getByRole('heading', { level: 1, name: 'Pirate race' })).toBeVisible()
  await expect(readme.getByRole('button', { name: 'Rendered' })).toHaveAttribute('aria-pressed', 'true')
  expect(fetched).toHaveLength(1)

  // An opened row shows its findings as one-line chips.
  const room = row(page, LAUNCH_ROOM_PATH).getByTestId('captured-file')
  await room.locator('summary').click()
  await expect(room.getByTestId('file-findings').getByTestId('file-finding')).toHaveCount(1)
  await expect(room.getByTestId('file-finding')).toContainText('P1')
  await expect(room.getByTestId('show-lines')).toHaveText('Show lines 44–50')

  // At phone width a row and a filter are tap targets of at least 44 px (section 10).
  await page.setViewportSize({ width: 390, height: 844 })
  expect((await row(page, LAUNCH_ADDED_PATH).locator('summary').boundingBox())?.height).toBeGreaterThanOrEqual(44)
  expect((await filter(page, /^All/).boundingBox())?.height).toBeGreaterThanOrEqual(44)
  await expectNoExecutionControls(page)
})

test(`[scenario:launch-review-late] A review recorded while the launch page is open reaches its files without a reload (${phase})`, async ({ page }) => {
  // The review is still running when the page opens: its snapshot links nothing and reviews/1 answers 404.
  const runPath = apiRun(RUN_LAUNCH_REPAIRED, UX_LAUNCH_WORKFLOW_ID)
  const running = structuredClone(runDetails[RUN_LAUNCH_REPAIRED])
  const reviewState = running.snapshot.nodes.find(node => node.node_id === 'review')!
  reviewState.status = 'running'
  reviewState.result_uri = null
  let recorded = false
  let missing = 0
  await page.route(url => url.pathname === runPath, async route => {
    if (recorded) return route.fallback()
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(running) })
  })
  await page.route(url => url.pathname === `${runPath}/reviews/1`, async route => {
    if (recorded) return route.fallback()
    missing += 1
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'REVIEW_NOT_FOUND', message: 'No review is recorded for that attempt.' } }) })
  })
  await page.goto(launchUrl(RUN_LAUNCH_REPAIRED))
  await expect(rows(page)).toHaveCount(ALL_PATHS.length)
  await expect.poll(() => missing).toBeGreaterThan(0)
  await expect(page.getByTestId('file-filters').getByRole('button', { name: /^With findings/ })).toHaveCount(0)

  // The review finishes; the next poll links it, and its findings sort their files first.
  recorded = true
  await expect(rows(page).first()).toHaveAttribute('data-path', LAUNCH_ROOM_PATH, { timeout: 15_000 })
  await expect(filter(page, /^With findings/)).toHaveText('With findings 3')
})

test(`[scenario:launch-report-no-signal] Without a completion signal the launch node still shows the result's own summary and assumptions (${phase})`, async ({ page }) => {
  const inputsPath = `${apiRun(RUN_LAUNCH_REPAIRED, UX_LAUNCH_WORKFLOW_ID)}/inputs`
  const inputs = structuredClone(runInputs[RUN_LAUNCH_REPAIRED])
  for (const worker of inputs.workers) {
    worker.completion = null
    worker.handoff = null
  }
  await page.route(url => url.pathname === inputsPath, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(inputs) }))
  await page.goto(launchUrl(RUN_LAUNCH_REPAIRED))
  const report = nodeDetail(page).locator('section[data-section="report"]')
  await expect(report).toContainText('No completion signal recorded.')
  await expect(report.getByTestId('worker-summary')).toContainText(REPAIR_SUMMARY_NOTE)
  await expect(report.getByTestId('assumptions-details')).toBeVisible()
})

test(`[scenario:launch-question-first] While a question waits, the Questions section comes first with both answer forms; a running worker's Session shows its state at launch (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(launchUrl(RUN_LAUNCH_ASKING))
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'launch_ui')

  // The first section, and the first index chip, is the waiting question.
  await expect(nodeDetail(page).locator('section[data-section]').first()).toHaveAttribute('data-section', 'questions')
  await expect(page.getByTestId('section-index').locator('a').first()).toHaveAttribute('data-section', 'questions')
  const questions = page.getByTestId('worker-questions')
  await expect(page.getByTestId('worker-questions-waiting')).toBeVisible()
  await expect(questions).toContainText(LAUNCH_QUESTIONS[1].question)
  await expect(questions.getByTestId('now-command')).toHaveText([
    '"$PY" -m workflow answer "$RUN" ui "<your answer>" --by operator',
    '"$PY" -m workflow answer "$RUN" ui "<your answer>" --by operator --no-herdr',
  ])
  await expect(questions).toContainText('Outside Herdr the first form records the answer')
  await expect(questions).toContainText('RUNBOOK “Worker questions”')
  // The waiting question's own line: its place among the three a worker may ask, and the paused deadline.
  const waitingQuestion = questions.locator('[data-testid="worker-question"][data-answered="false"]')
  await expect(waitingQuestion).toContainText('Question 2 of 3')
  await expect(waitingQuestion).toContainText('deadline paused')
  await expect(questions.getByTestId('copy-command')).toHaveText(['Copy', 'Copy'])

  // The commands are said once on the page: not repeated in the header's next step.
  await expect(nodeDetail(page).getByTestId('now-command')).toHaveCount(2)

  // A running worker: the Session disclosure is closed and holds the state at launch.
  const session = page.getByTestId('worker-session')
  await expect(session).not.toHaveAttribute('open', '')
  await session.locator('summary').first().click()
  const receiptRow = (label: string) => page.getByTestId('launch-receipt').locator('.projects-facts > div').filter({ has: page.locator('dt', { hasText: label }) }).locator('dd')
  await expect(receiptRow('State at launch')).toHaveText('working')
  await expect(page.getByTestId('worker-stop')).toContainText('Stop not confirmed')
  await attach(page, testInfo, 'launch-question-first')
  await expectNoExecutionControls(page)
})
