import { test, expect, type Page } from '@playwright/test'
import {
  BUNDLE_SHA256,
  CANDIDATE_COMMIT,
  PATH_TOKEN,
  PRINT_REVIEWER_SESSION,
  REVIEWER_SESSION,
  REVIEW_DIFF,
  REVIEW_DIFF_ARTIFACT_ID,
  RUN_AWAITING,
  RUN_BLOCKED,
  RUN_LEGACY,
  RUN_SUCCEEDED,
  reviewFindings,
  sha256,
  uiPathQuote,
} from './fixtures.ts'
import { apiRun, attach, expectNoExecutionControls, fetchFromPage, installHooks, nodeDetail, nodeListItem, phase, renderedText, runUrl } from './support.ts'

installHooks()

const reviewPanel = (page: Page) => page.getByTestId('review-result')
const findings = (page: Page) => page.getByTestId('review-findings')
const findingRows = (page: Page) => findings(page).getByTestId('finding')
// Findings are cards (docs/PRD_VIEWER_REVAMP.md 5.4, 8): a disposition is each card's data attribute, a lane a filter toggle.
const byDisposition = (page: Page, disposition: string) => findings(page).locator(`[data-testid="finding"][data-disposition="${disposition}"]`)
const toggle = (page: Page, id: string) => findings(page).getByTestId('findings-filters').locator(`button[data-filter="${id}"]`)
const laneFigure = (page: Page) => page.getByTestId('figure-lanes').locator('[data-lane]')

test(`[scenario:review-verdict] The review node shows the verdict, reviewer, bundle, summary and findings (${phase})`, async ({ page }, testInfo) => {
  await page.goto(runUrl(RUN_SUCCEEDED, 'review'))
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'review')
  await expect(reviewPanel(page)).toBeVisible()
  await expect(page.getByTestId('result-none')).toHaveCount(0)

  // Verdict pill, reviewer identity with transport wording, and the node facts naming the same session.
  const verdict = page.getByTestId('review-verdict')
  await expect(verdict).toHaveText('Approved')
  await expect(verdict).toHaveClass(/status-succeeded/)
  const reviewer = page.getByTestId('review-reviewer')
  await expect(reviewer.locator('code')).toHaveText(REVIEWER_SESSION)
  await expect(reviewer).toContainText('native session')
  await expect(nodeDetail(page).locator('.projects-facts').first()).toContainText(REVIEWER_SESSION)

  // The bundle hash links to the candidate node the reviewer judged; the candidate commit is shown short.
  const bundle = page.getByTestId('review-bundle')
  await expect(bundle.locator('code').first()).toHaveText(BUNDLE_SHA256.slice(0, 12))
  await expect(bundle.locator('code').first()).toHaveAttribute('title', BUNDLE_SHA256)
  await expect(bundle.getByRole('link')).toHaveAttribute('href', runUrl(RUN_SUCCEEDED, 'candidate'))
  await expect(bundle).toContainText(CANDIDATE_COMMIT.slice(0, 12))

  // One-line summary and the findings as cards, by disposition: four open, two accepted, none resolved (two dispositions).
  await expect(page.getByTestId('review-summary')).toHaveText('approved with 6 findings: 4 open, 2 accepted, none blocking')
  await expect(findingRows(page)).toHaveCount(6)
  await expect(byDisposition(page, 'open')).toHaveCount(4)
  await expect(byDisposition(page, 'open').first().getByTestId('finding-disposition')).toHaveText('open')
  await expect(byDisposition(page, 'accepted')).toHaveCount(2)
  await expect(byDisposition(page, 'resolved')).toHaveCount(0)
  expect(new Set(await findingRows(page).evaluateAll(cards => cards.map(card => card.getAttribute('data-disposition'))))).toEqual(new Set(['open', 'accepted']))
  // Every card names its severity, message, worker, reviewer and requirement, as the table's five columns did.
  for (const row of await findingRows(page).all()) {
    await expect(row.locator('.ui-sev')).toHaveCount(1)
    await expect(row.locator('.finding-message')).toHaveCount(1)
    await expect(row.locator('.finding-field-label')).toHaveText(['Worker', 'Reviewer', 'Requirement'])
  }
  for (const row of await findingRows(page).all()) {
    await expect(row).toHaveAttribute('data-severity', 'P2')
    await expect(row).not.toHaveClass(/finding-blocking/)
  }
  for (const finding of reviewFindings(RUN_SUCCEEDED)) await expect(findings(page)).toContainText(finding.message)
  await expect(findingRows(page).filter({ hasText: 'root Playwright suite' })).toHaveAttribute('data-worker', 'none')

  // The same findings by the worker they concern (ui, adapter, both, none): four lanes in the figure and the filter row,
  // keyboard-operable, then back to all.
  await expect(laneFigure(page)).toHaveCount(4)
  await expect(page.getByTestId('figure-lanes').locator('[data-lane="ui"]')).toHaveAttribute('data-count', '3')
  await expect(page.getByTestId('figure-lanes').locator('[data-lane="none"]')).toContainText('no worker')
  await toggle(page, 'lane:ui').focus()
  await page.keyboard.press('Enter')
  await expect(toggle(page, 'lane:ui')).toHaveAttribute('aria-pressed', 'true')
  await expect(findingRows(page)).toHaveCount(3)
  for (const row of await findingRows(page).all()) await expect(row).toHaveAttribute('data-worker', 'ui')
  await page.keyboard.press('Enter')
  await expect(findingRows(page)).toHaveCount(6)
  await expect(byDisposition(page, 'open')).toHaveCount(4)

  // The diff the reviewer saw is a plain-text patch artifact of this run, opened in a new tab.
  const diff = page.getByTestId('review-diff')
  const link = diff.getByRole('link')
  const artifactUrl = `${apiRun(RUN_SUCCEEDED)}/artifacts/${REVIEW_DIFF_ARTIFACT_ID}`
  await expect(link).toHaveAttribute('href', artifactUrl)
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('rel', /noopener/)
  await expect(diff).toContainText(sha256(REVIEW_DIFF).slice(0, 12))
  const served = await fetchFromPage(page, artifactUrl)
  expect(served.status).toBe(200)
  expect(served.contentType).toContain('text/plain')
  expect(served.text).toBe(REVIEW_DIFF)
  await expectNoExecutionControls(page)
  await attach(page, testInfo, 'review-verdict')

  // The bundle link navigates inside the run to the candidate node.
  await bundle.getByRole('link').click()
  await expect(page).toHaveURL(new RegExp(`${runUrl(RUN_SUCCEEDED, 'candidate')}$`))
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'candidate')
})

test(`[scenario:review-blocked] A blocked review shows the verdict, the failed node and the findings that caused it (${phase})`, async ({ page }, testInfo) => {
  await page.goto(runUrl(RUN_BLOCKED, 'review'))
  await expect(page.getByTestId('run-view')).toHaveAttribute('data-run-status', 'failed')
  await expect(page.getByTestId('run-status')).toContainText('Failed')
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'review')
  await expect(nodeDetail(page).locator('.status-badge').first()).toHaveText('Failed')
  await expect(page.getByTestId('node-status-meaning')).toContainText('This step failed')
  // A node page shows the step strip, not the graph (PRD_VIEWER_UX 4.4): the strip carries each step's status.
  await expect(nodeListItem(page, 'review')).toHaveAttribute('data-status', 'failed')
  await expect(nodeListItem(page, 'approval')).toHaveAttribute('data-status', 'pending')
  await expect(nodeListItem(page, 'integrate')).toHaveAttribute('data-status', 'pending')

  const verdict = page.getByTestId('review-verdict')
  await expect(verdict).toHaveText('Blocked')
  await expect(verdict).toHaveClass(/status-failed/)
  const reviewer = page.getByTestId('review-reviewer')
  await expect(reviewer.locator('code')).toHaveText(PRINT_REVIEWER_SESSION)
  await expect(reviewer).toContainText('print-mode session')
  await expect(page.getByTestId('review-summary')).toHaveText('blocked with 2 findings: 1 open, 1 resolved, 1 blocking')

  // The unresolved P1 is marked as the blocking finding; the resolved P2 is listed but not blocking.
  await expect(findingRows(page)).toHaveCount(2)
  const blocking = byDisposition(page, 'open')
  await expect(blocking).toHaveCount(1)
  await expect(blocking).toHaveAttribute('data-severity', 'P1')
  await expect(blocking).toHaveClass(/finding-blocking/)
  const resolved = byDisposition(page, 'resolved')
  await expect(resolved).toHaveCount(1)
  await expect(resolved).toHaveAttribute('data-severity', 'P2')
  await expect(resolved).not.toHaveClass(/finding-blocking/)
  await expect(byDisposition(page, 'accepted')).toHaveCount(0)
  for (const finding of reviewFindings(RUN_BLOCKED)) await expect(findings(page)).toContainText(finding.message)
  await expect(page.getByTestId('review-diff')).toContainText('No diff artifact was recorded')
  await expect(page.getByTestId('projects-error')).toHaveCount(0)
  await expectNoExecutionControls(page)
  await attach(page, testInfo, 'review-blocked')
})

test(`[scenario:review-legacy] A run exported before review results says no review is recorded, without an error (${phase})`, async ({ page }, testInfo) => {
  await page.goto(runUrl(RUN_LEGACY, 'review'))
  await expect(page.getByTestId('run-view')).toHaveAttribute('data-run-status', 'succeeded')
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'review')
  await expect(nodeDetail(page).locator('.status-badge').first()).toHaveText('Succeeded')
  const none = page.getByTestId('review-none')
  await expect(none).toContainText('No review recorded for this run')
  await expect(none).toContainText('re-export')
  await expect(reviewPanel(page)).toHaveCount(0)
  await expect(page.getByTestId('projects-error')).toHaveCount(0)
  await expect(page.getByTestId('result-unscoped')).toHaveCount(0)
  await attach(page, testInfo, 'review-legacy')

  // A review that has not happened yet reads the same way: not recorded, not an error.
  await page.goto(runUrl(RUN_AWAITING, 'review'))
  await expect(page.getByTestId('awaiting-notice')).toBeVisible()
  await expect(page.getByTestId('review-none')).toBeVisible()
  await expect(reviewPanel(page)).toHaveCount(0)
  await expect(page.getByTestId('projects-error')).toHaveCount(0)
})

test(`[scenario:paths-redacted] No absolute path from the seeded review reaches the rendered panel (${phase})`, async ({ page }, testInfo) => {
  await page.goto(runUrl(RUN_SUCCEEDED, 'review'))
  await expect(findingRows(page)).toHaveCount(6)
  const text = await renderedText(reviewPanel(page))
  expect(text).toContain(PATH_TOKEN)
  await renderedText(nodeDetail(page))

  // The finding that names a directory carries the redaction marker in both its message and its quote.
  const row = findingRows(page).filter({ hasText: 'Screenshots were written beside' })
  await expect(row).toContainText(`beside ${PATH_TOKEN} instead of below it.`)
  await expect(row.getByTestId('finding-requirement')).toHaveText(uiPathQuote(PATH_TOKEN))
  await attach(page, testInfo, 'paths-redacted')
})
