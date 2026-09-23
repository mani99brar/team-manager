/**
 * Viewer clarity (PRD_VIEWER_CLARITY section 6, ui lane): executor marks on the graph, the files a worker created shown on
 * its launch node with the review findings that name them, the launch node's output before its collapsed task, the verify
 * node's checks without the files, and findings grouped by reviewer. The `clarity-flow` run captured its ui lane's files at
 * freeze; `feature-flow`'s runs predate capture and stand in for legacy results, single-reviewer runs and the print transport.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  AUDIT_FINDINGS,
  AUDIT_NAMED_LINES,
  AUDIT_PATH,
  BINARY_PATH,
  CAPTURED_CHANGED_FILES,
  CAPTURE_TS,
  CAPTURE_TS_PATH,
  CLARITY_WORKFLOW_ID,
  FILE_FINDING_LINE,
  FILE_FINDING_NONE,
  FILE_FINDING_PLAIN,
  FILE_FINDING_RANGE,
  FILE_FINDING_SIMILAR,
  RUN_BLOCKED,
  RUN_FILES,
  RUN_SUCCEEDED,
  RUN_TWO_REVIEWERS,
  REVIEWERS_WORKFLOW_ID,
  SIMILAR_PATH,
  TOO_LARGE_PATH,
  TWO_REVIEWERS,
  UI_CHANGED_FILES,
  UI_QUOTE,
} from './fixtures.ts'
import { attach, expectNoExecutionControls, graphNode, installHooks, nodeDetail, phase, renderedText, runUrl, taskDetails } from './support.ts'

installHooks()

const clarityRunUrl = (runId: string, nodeId?: string) => runUrl(runId, nodeId, CLARITY_WORKFLOW_ID)
const createdFiles = (page: Page) => page.getByTestId('created-files')
const createdFile = (page: Page, path: string) => createdFiles(page).locator(`[data-testid="created-file"][data-path="${path}"]`)
const capturedFile = (page: Page, path: string) => page.locator(`[data-testid="captured-file"][data-path="${path}"]`)
const findings = (page: Page) => page.getByTestId('review-findings')
const findingRows = (page: Page) => findings(page).getByTestId('finding')
const findingRow = (page: Page, message: string) => findingRows(page).filter({ hasText: message })
const reviewerGroups = (page: Page) => findings(page).locator('section[data-reviewer-group]')
const filterButton = (page: Page, reviewer: string) => findings(page).locator(`[data-testid="filter-reviewer"][data-reviewer="${reviewer}"]`)

const SOLID = ['launch_ui', 'launch_adapter', 'review']
const DASHED = ['handoff', 'verify_ui', 'verify_adapter', 'candidate', 'approval', 'integrate']

async function attributeList(locator: Locator, name: string): Promise<(string | null)[]> {
  return Promise.all((await locator.all()).map(item => item.getAttribute(name)))
}

/** Whether `first` comes before `second` in document order. */
async function precedes(first: Locator, second: Locator): Promise<boolean> {
  const other = await second.elementHandle()
  // 4 is Node.DOCUMENT_POSITION_FOLLOWING.
  return first.evaluate((element, target) => Boolean(element.compareDocumentPosition(target!) & 4), other)
}

/** The dash pattern a graph node's outline is actually drawn with. */
async function dashArray(node: Locator): Promise<string> {
  return node.locator('.workflow-node-shape').evaluate(shape => shape.ownerDocument.defaultView!.getComputedStyle(shape).strokeDasharray)
}

/** Whether the element's box lies inside the viewport, allowing a pixel for sub-pixel scroll positions. */
async function inViewport(locator: Locator): Promise<boolean> {
  return locator.evaluate(element => {
    const box = element.getBoundingClientRect()
    return box.top >= -1 && box.bottom <= element.ownerDocument.defaultView!.innerHeight + 1
  })
}

test(`[scenario:executor-marks] The graph shows solid worker and review nodes and dashed handoff, verify, candidate, approval and integrate nodes with a legend; each node's accessible name and detail page name its executor (${phase})`, async ({ page }, testInfo) => {
  await page.goto(clarityRunUrl(RUN_FILES))
  await expect(page.getByTestId('run-view')).toHaveAttribute('data-run-status', 'succeeded')

  // Agents are solid: no dash on the shape, the agent class and the agent session in the accessible name.
  await expect(page.locator('[data-testid="workflow-graph"] [data-graph-node].is-agent')).toHaveCount(SOLID.length)
  await expect(page.locator('[data-testid="workflow-graph"] [data-graph-node].is-controller')).toHaveCount(DASHED.length)
  for (const nodeId of SOLID) {
    const node = graphNode(page, nodeId)
    await expect(node).toHaveClass(/\bis-agent\b/)
    await expect(node.locator('.workflow-node-shape')).not.toHaveAttribute('stroke-dasharray')
    expect(await dashArray(node)).toBe('none')
  }
  // The controller and the trusted verifier are dashed.
  for (const nodeId of DASHED) {
    const node = graphNode(page, nodeId)
    await expect(node).toHaveClass(/\bis-controller\b/)
    await expect(node.locator('.workflow-node-shape')).toHaveAttribute('stroke-dasharray', /\d/)
    expect(await dashArray(node)).not.toBe('none')
  }

  // Each accessible name ends with its executor; the meta line names it too.
  await expect(graphNode(page, 'launch_ui')).toHaveAttribute('aria-label', /^Launch ui worker, worker, succeeded, attempt 1, executed by agent session$/)
  await expect(graphNode(page, 'review')).toHaveAttribute('aria-label', /, executed by one agent session per reviewer$/)
  for (const nodeId of ['verify_ui', 'verify_adapter', 'candidate']) await expect(graphNode(page, nodeId)).toHaveAttribute('aria-label', /, executed by trusted verifier$/)
  for (const nodeId of ['handoff', 'approval', 'integrate']) await expect(graphNode(page, nodeId)).toHaveAttribute('aria-label', /, executed by controller$/)
  await expect(graphNode(page, 'verify_ui').locator('.workflow-node-meta')).toHaveText('Succeeded · attempt 1 · verifier')
  await expect(graphNode(page, 'handoff').locator('.workflow-node-meta')).toHaveText('Succeeded · attempt 1 · controller')
  await expect(graphNode(page, 'launch_ui').locator('.workflow-node-meta')).toHaveText('Succeeded · attempt 1 · agent')

  // The legend lists the three executors.
  const legend = page.getByTestId('graph-legend')
  await expect(legend).toBeVisible()
  await expect(legend.locator('li')).toHaveCount(3)
  expect(await attributeList(legend.locator('li'), 'data-executor')).toEqual(['agent', 'verifier', 'controller'])
  await expect(legend.locator('li')).toContainText([/Agent session/, /Trusted verifier/, /Controller/])
  await attach(page, testInfo, 'executor-marks')

  // Each node page says who executed it.
  const expected: Record<string, string> = {
    launch_ui: 'agent session', handoff: 'controller', verify_ui: 'trusted verifier', candidate: 'trusted verifier',
    review: 'one agent session per reviewer', approval: 'controller', integrate: 'controller',
  }
  for (const [nodeId, executor] of Object.entries(expected)) {
    await graphNode(page, nodeId).click()
    await expect(nodeDetail(page)).toHaveAttribute('data-node-id', nodeId)
    await expect(page.getByTestId('node-executor')).toHaveText(executor)
  }

  // A review run with the print transport says one print job per reviewer once its served result is read.
  await page.goto(runUrl(RUN_BLOCKED, 'review'))
  await expect(page.getByTestId('review-result')).toBeVisible()
  await expect(page.getByTestId('node-executor')).toHaveText('one print job per reviewer')
  await expectNoExecutionControls(page)
})

test(`[scenario:created-file-rendered] The launch node renders a captured Markdown file, shows a captured source file on demand, lists too-large and binary entries with reasons; a legacy run says files were not captured (${phase})`, async ({ page }, testInfo) => {
  await page.goto(clarityRunUrl(RUN_FILES, 'launch_ui'))
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'launch_ui')
  await expect(createdFiles(page).getByRole('heading', { name: 'Files created or changed' })).toBeVisible()

  // Every changed file, in the result's order, each with how it was captured.
  const entries = createdFiles(page).getByTestId('created-file')
  await expect(entries).toHaveCount(CAPTURED_CHANGED_FILES.length)
  expect(await attributeList(entries, 'data-path')).toEqual(CAPTURED_CHANGED_FILES)
  expect(await attributeList(entries, 'data-state')).toEqual(['captured', 'captured', 'not-captured', 'not-captured'])
  await expect(page.getByTestId('files-not-captured')).toHaveCount(0)

  // The Markdown file is rendered inline: its headings, not its source.
  const audit = capturedFile(page, AUDIT_PATH)
  await expect(audit.getByTestId('file-rendered').getByRole('heading', { level: 1, name: 'Workflow audit' })).toBeVisible()
  await expect(audit.getByTestId('file-rendered').getByRole('heading', { level: 2, name: 'Recheck' })).toBeVisible()
  await expect(audit.getByTestId('file-source')).toHaveCount(0)
  await expect(audit.getByRole('button', { name: 'Rendered' })).toHaveAttribute('aria-pressed', 'true')

  // The TypeScript file is source, shown on demand and verbatim.
  const source = capturedFile(page, CAPTURE_TS_PATH)
  await expect(source.getByTestId('file-source')).toHaveCount(0)
  await expect(source.getByTestId('file-rendered')).toHaveCount(0)
  await source.getByRole('button', { name: 'Show source' }).click()
  await expect(source.getByTestId('file-source')).toBeVisible()
  expect(await source.getByTestId('file-source').textContent()).toBe(CAPTURE_TS)
  await source.getByRole('button', { name: 'Hide source' }).click()
  await expect(source.getByTestId('file-source')).toHaveCount(0)

  // Files that were not captured say why.
  await expect(createdFile(page, TOO_LARGE_PATH)).toHaveAttribute('data-reason', 'too_large')
  await expect(createdFile(page, TOO_LARGE_PATH).getByTestId('not-captured-reason')).toContainText('too large')
  await expect(createdFile(page, BINARY_PATH)).toHaveAttribute('data-reason', 'binary')
  await expect(createdFile(page, BINARY_PATH).getByTestId('not-captured-reason')).toContainText('binary')
  await expect(page.getByTestId('projects-error')).toHaveCount(0)
  await renderedText(createdFiles(page))
  await attach(page, testInfo, 'created-file-rendered')

  // A result recorded before capture lists its paths and says the files were not captured.
  await page.goto(runUrl(RUN_SUCCEEDED, 'launch_ui'))
  await expect(page.getByTestId('files-not-captured')).toContainText('Created files were not captured for this run')
  expect(await attributeList(createdFiles(page).getByTestId('created-file'), 'data-path')).toEqual(UI_CHANGED_FILES)
  await expect(page.getByTestId('captured-file')).toHaveCount(0)
  await expect(page.getByTestId('projects-error')).toHaveCount(0)
  await expectNoExecutionControls(page)
})

test(`[scenario:output-first-task-collapsed] The launch node's result and files precede the task, the task disclosure is closed, and a finding's requirement link opens it and highlights the quote (${phase})`, async ({ page }, testInfo) => {
  await page.goto(clarityRunUrl(RUN_FILES, 'launch_ui'))
  const result = page.getByTestId('worker-result')
  await expect(result).toHaveAttribute('data-view', 'produced')
  await expect(createdFiles(page)).toBeVisible()
  const task = taskDetails(page)
  await expect(task).toBeVisible()

  // Output first: the result, then the files, the completion signal and the launch receipt, then the task.
  expect(await precedes(result, createdFiles(page))).toBe(true)
  expect(await precedes(createdFiles(page), page.getByTestId('worker-completion'))).toBe(true)
  expect(await precedes(page.getByTestId('worker-completion'), page.getByTestId('launch-receipt'))).toBe(true)
  expect(await precedes(page.getByTestId('launch-receipt'), task)).toBe(true)

  // The task is collapsed by default and appears once on the page.
  await expect(task).not.toHaveAttribute('open', '')
  await expect(page.getByTestId('task-panel')).toBeHidden()
  await expect(page.getByTestId('task-panel')).toHaveCount(1)
  await attach(page, testInfo, 'output-first-task-collapsed')

  // A finding's requirement link opens the disclosure and highlights the quote in view.
  await page.goto(clarityRunUrl(RUN_FILES, 'review'))
  await findingRow(page, FILE_FINDING_PLAIN).getByTestId('finding-task-link').click()
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'launch_ui')
  await expect(taskDetails(page)).toHaveAttribute('open', '')
  const highlight = page.getByTestId('task-highlight')
  await expect(highlight).toHaveText(UI_QUOTE)
  await expect.poll(() => inViewport(highlight)).toBe(true)
  await attach(page, testInfo, 'output-first-task-opened')
})

test(`[scenario:verify-shows-checks-not-files] The verify node shows checks, gate, deferred checks and screenshots and no created-files section; the launch node shows no checks table (${phase})`, async ({ page }, testInfo) => {
  await page.goto(clarityRunUrl(RUN_FILES, 'verify_ui'))
  const result = page.getByTestId('worker-result')
  await expect(result).toHaveAttribute('data-view', 'verified')
  await expect(page.getByTestId('checks-list').locator('.check')).toHaveCount(3)
  await expect(page.getByTestId('gate-outcome')).toHaveAttribute('data-passed', 'true')
  await expect(page.getByTestId('gate-outcome')).toContainText('Passed')
  await expect(page.getByTestId('ownership-outcome')).toContainText('owned paths')
  const screenshot = page.getByTestId('screenshots').locator('img').first()
  await expect(screenshot).toBeVisible()
  await expect.poll(() => screenshot.evaluate(image => (image as unknown as { naturalWidth: number }).naturalWidth)).toBeGreaterThan(0)
  // No created files, and the captured files are not repeated among the other artifacts.
  await expect(createdFiles(page)).toHaveCount(0)
  await expect(page.getByTestId('captured-file')).toHaveCount(0)
  await expect(page.getByTestId('artifacts')).not.toContainText('file-5-workflow-audit-md')
  await expect(page.getByTestId('artifacts')).toContainText('test_report')
  await attach(page, testInfo, 'verify-shows-checks-not-files')

  // Deferred checks are part of the verify node's gate.
  await page.goto(runUrl(RUN_BLOCKED, 'verify_ui'))
  // The ids are the gate's receipts: policy check ids in the fixtures, `check-<index>` in the seeded packets.
  await expect(page.getByTestId('gate-outcome').getByTestId('deferred-checks')).toContainText('gated only at the combined candidate')
  await expect(page.getByTestId('checks-list').locator('.check-deferred')).toHaveCount(2)
  await expect(createdFiles(page)).toHaveCount(0)

  // The launch node shows what was produced, without checks, gate or screenshots.
  await page.goto(clarityRunUrl(RUN_FILES, 'launch_ui'))
  await expect(page.getByTestId('worker-result')).toHaveAttribute('data-view', 'produced')
  await expect(createdFiles(page)).toBeVisible()
  await expect(page.getByTestId('checks-list')).toHaveCount(0)
  await expect(page.getByTestId('gate-outcome')).toHaveCount(0)
  await expect(page.getByTestId('screenshots')).toHaveCount(0)

  // The combined candidate shows each lane's checks and links to the lane's files instead of repeating them.
  await page.goto(clarityRunUrl(RUN_FILES, 'candidate'))
  const lane = page.getByTestId('lane-result:ui')
  await expect(lane.getByTestId('checks-list').locator('.check')).toHaveCount(3)
  await expect(lane.getByTestId('lane-files-link').getByRole('link')).toHaveAttribute('href', clarityRunUrl(RUN_FILES, 'launch_ui'))
  await expect(createdFiles(page)).toHaveCount(0)
  await expectNoExecutionControls(page)
})

test(`[scenario:findings-on-files] A captured file lists exactly the findings whose messages name its path verbatim; a path:N-M finding marks those source lines; review findings naming a captured file link to it (${phase})`, async ({ page }, testInfo) => {
  await page.goto(clarityRunUrl(RUN_FILES, 'launch_ui'))
  const audit = capturedFile(page, AUDIT_PATH)
  const listed = audit.getByTestId('file-findings').getByTestId('file-finding')

  // Exactly the findings naming the path verbatim, in review order, with severity and reviewer; the similar path is not one.
  await expect(listed).toHaveCount(AUDIT_FINDINGS.length)
  for (const [index, message] of AUDIT_FINDINGS.entries()) await expect(listed.nth(index)).toContainText(message)
  expect(await attributeList(listed, 'data-severity')).toEqual(['P2', 'P1', 'P2'])
  expect(await attributeList(listed, 'data-reviewer')).toEqual(['general', 'coverage', 'coverage'])
  await expect(listed.getByTestId('file-finding-reviewer')).toHaveText(['general', 'coverage', 'coverage'])
  await expect(audit.getByTestId('file-findings')).not.toContainText(SIMILAR_PATH)
  await expect(audit.getByTestId('file-findings')).not.toContainText(FILE_FINDING_NONE)
  // Only the findings that name lines offer to show them.
  await expect(listed.filter({ hasText: FILE_FINDING_PLAIN }).getByTestId('show-lines')).toHaveCount(0)
  await expect(listed.filter({ hasText: FILE_FINDING_LINE }).getByTestId('show-lines')).toHaveText('Show line 3')

  // The captured TypeScript file is named by no finding.
  await expect(capturedFile(page, CAPTURE_TS_PATH).getByTestId('file-findings-none')).toHaveText('No review finding names this file.')

  // "Show lines" leaves the rendered Markdown for the source and marks lines 12 to 14, the first in view.
  const showRange = listed.filter({ hasText: FILE_FINDING_RANGE }).getByTestId('show-lines')
  await expect(showRange).toHaveText('Show lines 12–14')
  await showRange.click()
  await expect(audit).toHaveAttribute('data-view', 'source')
  await expect(audit.getByTestId('file-rendered')).toHaveCount(0)
  const marked = audit.getByTestId('file-source').locator('[data-finding-line]')
  await expect(marked).toHaveCount(AUDIT_NAMED_LINES[1] - AUDIT_NAMED_LINES[0] + 1)
  expect(await attributeList(marked, 'data-line')).toEqual(['12', '13', '14'])
  await expect(marked.first()).toHaveText('1. Recompute the sha256 of every retained artifact.\n')
  await expect.poll(() => inViewport(marked.first())).toBe(true)
  await attach(page, testInfo, 'findings-on-files')

  // On the review node, findings naming a captured file link to its panel; the others have no file link.
  await page.goto(clarityRunUrl(RUN_FILES, 'review'))
  await expect(findingRows(page)).toHaveCount(5)
  await expect(findings(page).getByTestId('finding-file-link')).toHaveCount(AUDIT_FINDINGS.length)
  for (const message of AUDIT_FINDINGS) {
    const link = findingRow(page, message).getByTestId('finding-file-link')
    await expect(link).toHaveAttribute('data-path', AUDIT_PATH)
    await expect(link).toHaveAttribute('href', clarityRunUrl(RUN_FILES, 'launch_ui'))
  }
  await expect(findingRow(page, FILE_FINDING_SIMILAR).getByTestId('finding-file-link')).toHaveCount(0)
  await expect(findingRow(page, FILE_FINDING_NONE).getByTestId('finding-file-link')).toHaveCount(0)
  await findingRow(page, FILE_FINDING_RANGE).getByTestId('finding-file-link').click()
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'launch_ui')
  await expect(capturedFile(page, AUDIT_PATH)).toBeVisible()
  await expect.poll(() => inViewport(capturedFile(page, AUDIT_PATH).getByRole('heading', { level: 5 }))).toBe(true)
  await expect(page.getByTestId('projects-error')).toHaveCount(0)
  await expectNoExecutionControls(page)
})

test(`[scenario:findings-by-reviewer] A two-reviewer run opens grouped by reviewer in declared order with each verdict and counts; the reviewer filter composes; a single-reviewer run opens by disposition (${phase})`, async ({ page }, testInfo) => {
  await page.goto(clarityRunUrl(RUN_FILES, 'review'))
  await expect(findings(page)).toHaveAttribute('data-group-by', 'reviewer')
  await expect(page.getByTestId('group-by-reviewer')).toHaveAttribute('aria-pressed', 'true')

  // One group per reviewer in declared order, labelled with its id, own verdict and severity counts.
  await expect(reviewerGroups(page)).toHaveCount(2)
  expect(await attributeList(reviewerGroups(page), 'data-reviewer-group')).toEqual([...TWO_REVIEWERS])
  const general = findings(page).locator('section[data-reviewer-group="general"]')
  const coverage = findings(page).locator('section[data-reviewer-group="coverage"]')
  await expect(general.getByRole('heading', { level: 5 })).toHaveText('general · approved · 2 P2 (2)')
  await expect(coverage.getByRole('heading', { level: 5 })).toHaveText('coverage · approved · 1 P1, 2 P2 (3)')
  await expect(general.getByTestId('finding')).toHaveCount(2)
  await expect(coverage.getByTestId('finding')).toHaveCount(3)
  for (const row of await general.getByTestId('finding').all()) await expect(row).toHaveAttribute('data-reviewer', 'general')
  await attach(page, testInfo, 'findings-by-reviewer')

  // The reviewer filter hides the other reviewer's group, and still applies when the grouping changes.
  await filterButton(page, 'coverage').click()
  await expect(reviewerGroups(page)).toHaveCount(1)
  await expect(general).toHaveCount(0)
  await expect(coverage.getByTestId('finding')).toHaveCount(3)
  await page.getByTestId('group-by-disposition').click()
  await expect(findings(page)).toHaveAttribute('data-group-by', 'disposition')
  await expect(findingRows(page)).toHaveCount(3)
  for (const row of await findingRows(page).all()) await expect(row).toHaveAttribute('data-reviewer', 'coverage')
  await page.getByTestId('group-by-worker').click()
  await expect(findingRows(page)).toHaveCount(3)
  await page.getByTestId('group-by-reviewer').click()
  await filterButton(page, 'all').click()
  await expect(reviewerGroups(page)).toHaveCount(2)

  // The parallel-reviewers run opens by reviewer too, in its declared order.
  await page.goto(runUrl(RUN_TWO_REVIEWERS, 'review', REVIEWERS_WORKFLOW_ID))
  await expect(findings(page)).toHaveAttribute('data-group-by', 'reviewer')
  expect(await attributeList(reviewerGroups(page), 'data-reviewer-group')).toEqual([...TWO_REVIEWERS])

  // A single-reviewer run opens by disposition.
  await page.goto(runUrl(RUN_SUCCEEDED, 'review'))
  await expect(page.getByTestId('review-result')).toHaveAttribute('data-reviewer-count', '1')
  await expect(findings(page)).toHaveAttribute('data-group-by', 'disposition')
  await expect(page.getByTestId('group-by-disposition')).toHaveAttribute('aria-pressed', 'true')
  await expect(reviewerGroups(page)).toHaveCount(0)
  await expect(page.getByTestId('projects-error')).toHaveCount(0)
  await expectNoExecutionControls(page)
})
