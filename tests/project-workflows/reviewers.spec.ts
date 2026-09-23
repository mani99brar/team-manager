/**
 * Parallel reviewers (PRD_PARALLEL_REVIEWERS section 6, viewer half): the review node lists every reviewer of a run.
 * `viewer-two-reviewers` drives the `reviewers-flow` runs: a 1.4.0 export where `general` and `coverage` both approved
 * (the union carries both reviewer tags and a finding raised by both stays two rows), a 1.4.0 export where `coverage`
 * blocked while `general` was superseded, and a 1.3.0 single-reviewer export whose projection has one entry named `review`.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  BLOCKING_COVERAGE_FINDING,
  COVERAGE_REVIEWER_SESSION,
  DEFAULT_REVIEWER_ID,
  DUPLICATE_FINDING,
  GENERAL_REVIEWER_SESSION,
  LEGACY_REVIEWER_SESSION,
  PATH_TOKEN,
  PROJECT,
  REVIEWERS_NODES,
  REVIEWERS_WORKFLOW_ID,
  RUN_LEGACY_REVIEWER,
  RUN_REVIEWER_BLOCKED,
  RUN_TWO_REVIEWERS,
  TWO_REVIEWERS,
  reviewFindings,
  reviewerFindings,
} from './fixtures.ts'
import { attach, expectNoExecutionControls, graphNode, installHooks, nodeDetail, phase, renderedText, runUrl, workflowUrl } from './support.ts'

installHooks()

const reviewersRunUrl = (runId: string, nodeId?: string) => runUrl(runId, nodeId, REVIEWERS_WORKFLOW_ID)
const reviewPanel = (page: Page) => page.getByTestId('review-result')
const strip = (page: Page) => page.getByTestId('reviewer-strip')
const entries = (page: Page) => strip(page).getByTestId('reviewer-entry')
const entry = (page: Page, reviewer: string) => strip(page).locator(`[data-testid="reviewer-entry"][data-reviewer="${reviewer}"]`)
const findings = (page: Page) => page.getByTestId('review-findings')
const findingRows = (page: Page) => findings(page).getByTestId('finding')
const rowsOf = (page: Page, reviewer: string) => findings(page).locator(`[data-testid="finding"][data-reviewer="${reviewer}"]`)
const filterButton = (page: Page, reviewer: string) => findings(page).locator(`[data-testid="filter-reviewer"][data-reviewer="${reviewer}"]`)
const dispositionGroup = (page: Page, disposition: string) => findings(page).locator(`section[data-disposition="${disposition}"]`)
const workerGroup = (page: Page, key: string) => findings(page).locator(`section[data-worker-group="${key}"]`)
const reviewerColumn = (row: Locator) => row.getByTestId('finding-reviewer')
const attributeList = (locator: Locator, attribute: string) => locator.evaluateAll((elements, name) => elements.map(element => element.getAttribute(name)), attribute)

test(`[scenario:viewer-two-reviewers] A two-reviewer run shows both verdicts in the reviewer strip, a Reviewer column and filtering by reviewer; a legacy export shows one entry named review (${phase})`, async ({ page }, testInfo) => {
  // The reviewers workflow is registered beside the others and holds its three runs.
  await page.goto(workflowUrl(PROJECT.project_id, REVIEWERS_WORKFLOW_ID))
  await expect(page.getByTestId('current-definition')).toContainText(`${REVIEWERS_NODES.length} nodes`)
  const runList = page.getByTestId('run-list')
  await expect(runList.locator('li')).toHaveCount(3)
  await expect(runList.locator(`[data-run-id="${RUN_TWO_REVIEWERS}"]`)).toHaveAttribute('data-status', 'succeeded')
  await expect(runList.locator(`[data-run-id="${RUN_REVIEWER_BLOCKED}"]`)).toHaveAttribute('data-status', 'failed')
  await expect(runList.locator(`[data-run-id="${RUN_LEGACY_REVIEWER}"]`)).toHaveAttribute('data-status', 'succeeded')

  // ---- Both reviewers approved: the combined verdict is the headline and the strip lists each reviewer's own verdict. ----
  await page.goto(reviewersRunUrl(RUN_TWO_REVIEWERS, 'review'))
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'review')
  await expect(reviewPanel(page)).toHaveAttribute('data-reviewer-count', '2')
  await expect(page.getByTestId('review-verdict')).toHaveText('Approved')
  await expect(page.getByTestId('review-blocked-by')).toHaveCount(0)
  await expect(page.getByTestId('review-summary')).toHaveText('approved with 5 findings: 3 open, 2 accepted, none blocking')
  await expect(entries(page)).toHaveCount(2)
  expect(await attributeList(entries(page), 'data-reviewer')).toEqual([...TWO_REVIEWERS])
  for (const reviewer of TWO_REVIEWERS) {
    const item = entry(page, reviewer)
    await expect(item.getByTestId('reviewer-id')).toHaveText(reviewer)
    await expect(item.getByTestId('reviewer-verdict')).toHaveText('Approved')
    await expect(item.getByTestId('reviewer-verdict')).toHaveClass(/status-succeeded/)
    await expect(item.getByTestId('reviewer-status')).toHaveText('completion file accepted')
  }
  await expect(entry(page, 'general').getByTestId('reviewer-counts')).toHaveText('2 P2')
  await expect(entry(page, 'coverage').getByTestId('reviewer-counts')).toHaveText('3 P2')

  // Both sessions are named, each as its own independent native session.
  const reviewer = page.getByTestId('review-reviewer')
  await expect(reviewer.locator('code')).toHaveText([GENERAL_REVIEWER_SESSION, COVERAGE_REVIEWER_SESSION])
  await expect(reviewer).toContainText('general:')
  await expect(reviewer).toContainText('coverage:')
  await expect(reviewer).toContainText('independent of every worker lane and of one another')

  // Several reviewers open grouped by reviewer (PRD_VIEWER_CLARITY 4.5); the checks below read the disposition grouping.
  await expect(findings(page)).toHaveAttribute('data-group-by', 'reviewer')
  await page.getByTestId('group-by-disposition').click()

  // The union of findings: a Reviewer column, both tags, and the finding both reviewers raised listed twice, never merged.
  await expect(findings(page)).toHaveAttribute('data-reviewer-filter', 'all')
  await expect(dispositionGroup(page, 'open').getByRole('columnheader')).toHaveText(['Severity', 'Message', 'Worker', 'Reviewer', 'Requirement'])
  await expect(findingRows(page)).toHaveCount(5)
  await expect(rowsOf(page, 'general')).toHaveCount(2)
  await expect(rowsOf(page, 'coverage')).toHaveCount(3)
  for (const finding of reviewFindings(RUN_TWO_REVIEWERS)) await expect(findings(page)).toContainText(finding.message)
  const duplicates = findingRows(page).filter({ hasText: DUPLICATE_FINDING })
  await expect(duplicates).toHaveCount(2)
  expect((await attributeList(duplicates, 'data-reviewer')).sort()).toEqual([...TWO_REVIEWERS].sort())
  await expect(reviewerColumn(rowsOf(page, 'general').first())).toHaveText('general')
  await expect(reviewerColumn(rowsOf(page, 'coverage').first())).toHaveText('coverage')

  // Filtering by reviewer keeps only that reviewer's findings, and works with grouping by worker in either order.
  await expect(filterButton(page, 'all')).toHaveAttribute('aria-pressed', 'true')
  await expect(filterButton(page, 'general')).toHaveText('general (2)')
  await expect(filterButton(page, 'coverage')).toHaveText('coverage (3)')
  await filterButton(page, 'coverage').click()
  await expect(findings(page)).toHaveAttribute('data-reviewer-filter', 'coverage')
  await expect(filterButton(page, 'coverage')).toHaveAttribute('aria-pressed', 'true')
  await expect(filterButton(page, 'all')).toHaveAttribute('aria-pressed', 'false')
  await expect(findingRows(page)).toHaveCount(3)
  await expect(rowsOf(page, 'general')).toHaveCount(0)
  for (const finding of reviewerFindings(RUN_TWO_REVIEWERS, 'coverage')) await expect(findings(page)).toContainText(finding.message)
  await expect(dispositionGroup(page, 'open').getByTestId('finding')).toHaveCount(2)
  await expect(dispositionGroup(page, 'accepted').getByTestId('finding')).toHaveCount(1)
  await page.getByTestId('group-by-worker').click()
  await expect(findings(page)).toHaveAttribute('data-group-by', 'worker')
  await expect(findings(page)).toHaveAttribute('data-reviewer-filter', 'coverage')
  await expect(workerGroup(page, 'ui').getByTestId('finding')).toHaveCount(2)
  await expect(workerGroup(page, 'adapter').getByTestId('finding')).toHaveCount(1)
  await expect(findingRows(page)).toHaveCount(3)
  await filterButton(page, 'general').click()
  await expect(findings(page)).toHaveAttribute('data-group-by', 'worker')
  await expect(workerGroup(page, 'ui').getByTestId('finding')).toHaveCount(1)
  await expect(workerGroup(page, 'adapter').getByTestId('finding')).toHaveCount(1)
  await expect(findingRows(page)).toHaveCount(2)
  for (const row of await findingRows(page).all()) await expect(row).toHaveAttribute('data-reviewer', 'general')
  await filterButton(page, 'all').click()
  await expect(findingRows(page)).toHaveCount(5)
  await expect(workerGroup(page, 'ui').getByTestId('finding')).toHaveCount(3)
  await page.getByTestId('group-by-disposition').click()
  await expect(dispositionGroup(page, 'open').getByTestId('finding')).toHaveCount(3)
  await expect(page.getByTestId('projects-error')).toHaveCount(0)
  await renderedText(reviewPanel(page))
  await expectNoExecutionControls(page)
  await attach(page, testInfo, 'viewer-two-reviewers')

  // ---- One reviewer blocked while the other was superseded: the headline says which, and the strip shows both outcomes. ----
  await page.goto(reviewersRunUrl(RUN_REVIEWER_BLOCKED, 'review'))
  await expect(page.getByTestId('run-view')).toHaveAttribute('data-run-status', 'failed')
  await expect(graphNode(page, 'review')).toHaveAttribute('data-status', 'failed')
  await expect(graphNode(page, 'approval')).toHaveAttribute('data-status', 'pending')
  await expect(reviewPanel(page)).toHaveAttribute('data-reviewer-count', '2')
  await expect(page.getByTestId('review-verdict')).toHaveText('Blocked')
  const blockedBy = page.getByTestId('review-blocked-by')
  await expect(blockedBy).toHaveText('Blocked by coverage (blocked the candidate). general was superseded: stopped after that decision, no verdict recorded.')
  await expect(page.getByTestId('review-summary')).toHaveText('blocked with 2 findings: 1 open, 1 resolved, 1 blocking')
  expect(await attributeList(entries(page), 'data-reviewer')).toEqual([...TWO_REVIEWERS])
  const coverage = entry(page, 'coverage')
  await expect(coverage).toHaveAttribute('data-status', 'blocked')
  await expect(coverage.getByTestId('reviewer-verdict')).toHaveText('Blocked')
  await expect(coverage.getByTestId('reviewer-verdict')).toHaveClass(/status-failed/)
  await expect(coverage.getByTestId('reviewer-status')).toHaveText('blocked the candidate')
  await expect(coverage.getByTestId('reviewer-counts')).toHaveText('1 P1, 1 P2')
  const general = entry(page, 'general')
  await expect(general).toHaveAttribute('data-status', 'superseded')
  await expect(general).toHaveAttribute('data-verdict', 'none')
  await expect(general.getByTestId('reviewer-verdict')).toHaveText('No verdict')
  await expect(general.getByTestId('reviewer-status')).toHaveText('stopped after the combined decision, no verdict')
  await expect(general.getByTestId('reviewer-counts')).toHaveText('no findings')
  await expect(findingRows(page)).toHaveCount(2)
  for (const row of await findingRows(page).all()) await expect(row).toHaveAttribute('data-reviewer', 'coverage')
  const blocking = findingRows(page).filter({ hasText: BLOCKING_COVERAGE_FINDING })
  await expect(blocking).toHaveAttribute('data-severity', 'P1')
  await expect(blocking).toHaveClass(/finding-blocking/)
  await expect(findingRows(page).filter({ hasText: 'Screenshots were written beside' })).toContainText(`beside ${PATH_TOKEN} instead of below it.`)
  await filterButton(page, 'general').click()
  await expect(findingRows(page)).toHaveCount(0)
  await expect(page.getByTestId('findings-empty')).toHaveText('Reviewer general recorded no findings.')
  await filterButton(page, 'coverage').click()
  await expect(findingRows(page)).toHaveCount(2)
  await expect(page.getByTestId('projects-error')).toHaveCount(0)
  await renderedText(reviewPanel(page))
  await expectNoExecutionControls(page)
  await attach(page, testInfo, 'viewer-two-reviewers-blocked')

  // ---- A single-reviewer export from before reviewers were declared: one entry named `review`, same code path. ----
  await page.goto(reviewersRunUrl(RUN_LEGACY_REVIEWER, 'review'))
  await expect(reviewPanel(page)).toHaveAttribute('data-reviewer-count', '1')
  await expect(page.getByTestId('review-verdict')).toHaveText('Approved')
  await expect(entries(page)).toHaveCount(1)
  const legacy = entry(page, DEFAULT_REVIEWER_ID)
  await expect(legacy.getByTestId('reviewer-id')).toHaveText(DEFAULT_REVIEWER_ID)
  await expect(legacy.getByTestId('reviewer-verdict')).toHaveText('Approved')
  await expect(legacy.getByTestId('reviewer-status')).toHaveText('completion file accepted')
  await expect(legacy.getByTestId('reviewer-counts')).toHaveText('2 P2')
  const legacyReviewer = page.getByTestId('review-reviewer')
  await expect(legacyReviewer.locator('code')).toHaveText(LEGACY_REVIEWER_SESSION)
  await expect(legacyReviewer).toContainText('native session, independent of every worker lane')
  await expect(legacyReviewer).not.toContainText('one another')
  await expect(findingRows(page)).toHaveCount(2)
  for (const row of await findingRows(page).all()) {
    await expect(row).toHaveAttribute('data-reviewer', DEFAULT_REVIEWER_ID)
    await expect(reviewerColumn(row)).toHaveText(DEFAULT_REVIEWER_ID)
  }
  await expect(findings(page).getByTestId('filter-reviewer')).toHaveCount(2)
  await expect(filterButton(page, DEFAULT_REVIEWER_ID)).toHaveText(`${DEFAULT_REVIEWER_ID} (2)`)
  await filterButton(page, DEFAULT_REVIEWER_ID).click()
  await expect(findingRows(page)).toHaveCount(2)
  await expect(page.getByTestId('projects-error')).toHaveCount(0)
  await renderedText(reviewPanel(page))
  await attach(page, testInfo, 'viewer-two-reviewers-legacy')
})
