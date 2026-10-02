/**
 * Projects viewer revamp, lane `pages` (docs/PRD_VIEWER_REVAMP.md sections 5.3-5.5 and 7): the run page opens on a header card
 * with a rule in the run's tone, the lanes as chips, Pipeline and Steps side by side on a wide screen with graph nodes filled
 * by status, and Activity grouped by phase with every group open; a review node opens on four figures, its findings as
 * severity-striped cards in P0/P1/P2 then lane order, one filter row whose toggles combine, the blocking card first and the
 * reviewer cards. The `revamp-pages` runs (`fixtures/ux-revamp-pages.ts`) are dated before 2026-03-13; the clock sits just after.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { UI_CHANGED_FILES } from './fixtures.ts'
import { RUN_REPAIRED, UX_RUN_WORKFLOW_ID } from './fixtures/ux-run.ts'
import { RUN_REJECTED_CHECKS, UX_VERIFY_WORKFLOW_ID } from './fixtures/ux-verify.ts'
import {
  BLOCKED_FINDINGS, DONE_FINDINGS, REVAMP_NOW, REVAMP_PAGES_WORKFLOW_ID, REVAMP_QUESTION, RUN_REVAMP_BLOCKED, RUN_REVAMP_DONE, RUN_REVAMP_RUNNING,
} from './fixtures/ux-revamp-pages.ts'
import { attach, expectNoExecutionControls, graphNode, installHooks, nodeDetail, nodeListItem, phase, runUrl, workspace } from './support.ts'

installHooks()

const revampUrl = (runId: string, nodeId?: string) => runUrl(runId, nodeId, REVAMP_PAGES_WORKFLOW_ID)
const now = (page: Page) => page.getByTestId('run-now')
const activity = (page: Page) => page.getByTestId('run-timeline')
const groups = (page: Page) => activity(page).getByTestId('activity-group')
const findings = (page: Page) => page.getByTestId('review-findings')
const cards = (page: Page) => findings(page).getByTestId('finding')
const filters = (page: Page) => findings(page).getByTestId('findings-filters')
const toggle = (page: Page, id: string) => filters(page).locator(`button[data-filter="${id}"]`)

type Style = Record<string, string>
type Box = { x: number; y: number; width: number; height: number }
/** The computed style of an element; the specs compile without the DOM library, so the browser globals are cast. */
const style = (target: Locator, ...names: string[]): Promise<Style> => target.evaluate((element, keys) => {
  const computed = (globalThis as unknown as { getComputedStyle: (node: unknown) => Record<string, string> }).getComputedStyle(element)
  return Object.fromEntries(keys.map(key => [key, computed[key]]))
}, names)
/** What a token of the Projects shell resolves to as a computed colour, read through a probe inside the shell. */
const token = (page: Page, name: string): Promise<string> => workspace(page).evaluate((shell, variable) => {
  const doc = (globalThis as unknown as { document: { createElement: (tag: string) => { style: Record<string, string>; remove: () => void } } }).document
  const probe = doc.createElement('span')
  probe.style.color = `var(${variable})`
  ;(shell as unknown as { appendChild: (node: unknown) => void }).appendChild(probe)
  const value = (globalThis as unknown as { getComputedStyle: (node: unknown) => { color: string } }).getComputedStyle(probe).color
  probe.remove()
  return value
}, name)
const box = async (target: Locator): Promise<Box> => {
  const value = await target.boundingBox()
  expect(value, 'the element must be laid out').not.toBeNull()
  return value!
}
const pageWidth = (page: Page) => page.evaluate('document.documentElement.scrollWidth') as Promise<number>
const attributes = (target: Locator, name: string) => target.evaluateAll((elements, key) => elements.map(element => element.getAttribute(key)), name)
/** Whether `first` comes before `second` in the document. */
const precedes = async (first: Locator, second: Locator) => first.evaluate((a, b) => Boolean((a as unknown as { compareDocumentPosition: (other: unknown) => number }).compareDocumentPosition(b) & 4), await second.elementHandle())

async function openRun(page: Page, url: string, situation: string) {
  await page.goto(url)
  await expect(now(page)).toHaveAttribute('data-situation', situation)
}

test(`[scenario:revamp-run] The run page shows the toned header rule, lane chips, Pipeline and Steps side by side on a wide screen and stacked narrower, graph nodes filled by status, and Activity grouped by phase, every group open (${phase})`, async ({ page }, testInfo) => {
  await page.clock.install({ time: new Date(REVAMP_NOW) })
  await page.setViewportSize({ width: 1440, height: 900 })
  await openRun(page, revampUrl(RUN_REVAMP_DONE), 'succeeded')

  // The header card: a top rule in the run's tone (succeeded: ok), the status badge and its words kept.
  const header = page.getByTestId('run-header')
  await expect(header).toHaveAttribute('data-tone', 'ok')
  await expect(header).toHaveClass(/tone-ok/)
  const rule = await style(header, 'borderTopColor', 'borderTopWidth')
  expect(rule.borderTopColor).toBe(await token(page, '--ok'))
  expect(parseFloat(rule.borderTopWidth)).toBeGreaterThanOrEqual(3)
  await expect(page.getByTestId('run-status').locator('.status-badge')).toHaveText('Succeeded')
  await expect(page.getByTestId('run-status-meaning')).toBeVisible()

  // The Now banner: its content as the shell renders it, a left rule in the run's tone over the tone's soft background.
  const banner = await style(now(page), 'borderLeftColor', 'borderLeftWidth', 'backgroundColor')
  expect(banner.borderLeftColor).toBe(await token(page, '--ok'))
  expect(parseFloat(banner.borderLeftWidth)).toBeGreaterThanOrEqual(3)
  expect(banner.backgroundColor).toBe(await token(page, '--ok-soft'))

  // The lanes line as chips, one per lane, toned by its steps (all passed: ok), with the same text as before.
  const lanes = page.getByTestId('run-lanes').locator('li[data-lane]')
  await expect(lanes).toHaveCount(2)
  expect(await attributes(lanes, 'data-lane')).toEqual(['ui', 'adapter'])
  await expect(lanes.first()).toContainText('worker ✓')
  for (const lane of await lanes.all()) {
    const chip = await style(lane, 'borderTopLeftRadius', 'backgroundColor')
    expect(parseFloat(chip.borderTopLeftRadius)).toBeGreaterThanOrEqual(10)
    expect(chip.backgroundColor).toBe(await token(page, '--ok-soft'))
  }

  // Pipeline and Steps side by side at 1440 px: the graph fits its column without scrolling, Steps to its right, tops aligned.
  const pipeline = page.getByTestId('run-pipeline')
  const steps = page.getByTestId('run-steps')
  await expect(pipeline.getByRole('heading', { name: 'Pipeline' })).toBeVisible()
  await expect(steps.getByRole('heading', { name: 'Steps' })).toBeVisible()
  await expect(page.getByTestId('run-board')).toHaveAttribute('data-layout', 'side-by-side')
  const left = await box(pipeline)
  const right = await box(steps)
  expect(left.x + left.width, 'Steps sit to the right of the Pipeline').toBeLessThanOrEqual(right.x)
  expect(Math.abs(left.y - right.y), 'Pipeline and Steps start on one line').toBeLessThan(4)
  const scroller = page.getByTestId('workflow-graph').locator('xpath=..')
  const { scroll, client } = await scroller.evaluate(element => ({ scroll: (element as unknown as { scrollWidth: number }).scrollWidth, client: (element as unknown as { clientWidth: number }).clientWidth }))
  expect(scroll, 'the graph does not scroll sideways beside the Steps').toBeLessThanOrEqual(client)
  await expect(graphNode(page, 'integrate')).toBeInViewport()
  expect(await pageWidth(page)).toBeLessThanOrEqual(1440)

  // Graph nodes filled by status: the soft tone for the fill, the tone for the stroke; the glyph repeats it; three legend entries.
  for (const id of ['challenge', 'verify_ui', 'integrate']) {
    const node = graphNode(page, id)
    await expect(node).toHaveAttribute('data-tone', 'ok')
    const shape = await style(node.locator('.workflow-node-shape'), 'fill', 'stroke')
    expect(shape.fill).toBe(await token(page, '--ok-soft'))
    expect(shape.stroke).toBe(await token(page, '--ok'))
    await expect(node.locator('.workflow-node-glyph')).toHaveText('✓')
  }
  await expect(page.getByTestId('graph-legend').locator('li')).toHaveCount(3)
  // Steps keep their rows and their bars take the tone colours.
  await expect(nodeListItem(page, 'review').locator('.step-bar-segment')).toHaveCount(1)
  expect((await style(nodeListItem(page, 'review').locator('.step-bar-segment'), 'backgroundColor')).backgroundColor).toBe(await token(page, '--ok'))

  // Activity grouped by phase, in run order, every group open so every row is visible without a click.
  await expect(groups(page)).toHaveCount(4)
  expect(await attributes(groups(page), 'data-phase')).toEqual(['challenge', 'workers', 'verification', 'review'])
  await expect(groups(page).locator('summary')).toContainText(['Challenge', 'Workers', 'Freeze and verification', 'Review and integration'])
  // A group says where it stands in words too, so a closed one is never colour only.
  await expect(groups(page).locator('summary')).toContainText(['all passed', 'all passed', 'all passed', 'all passed'])
  expect(await attributes(groups(page), 'data-tone')).toEqual(['ok', 'ok', 'ok', 'ok'])
  for (const group of await groups(page).all()) await expect(group).toHaveAttribute('open', '')
  await expect(groups(page).last()).toHaveAttribute('open', '')
  const rows = activity(page).locator('li')
  const count = await rows.count()
  expect(count).toBeGreaterThanOrEqual(16)
  const order = await rows.allInnerTexts()
  for (const row of await rows.all()) await expect(row).toBeVisible()
  await expect(rows.first()).toContainText('09:00:00')
  await expect(rows.last()).toContainText('09:53:52')
  // Each step's rows sit in its own phase: the launches with the workers, the integration with the review.
  expect(await groups(page).nth(1).locator('li[data-node-id="launch_adapter"]').count()).toBeGreaterThan(0)
  await expect(groups(page).nth(1).locator('li[data-node-id^="verify_"]')).toHaveCount(0)
  expect(await groups(page).nth(3).locator('li[data-node-id="integrate"]').count()).toBeGreaterThan(0)
  await page.evaluate('window.scrollTo(0, 0)')
  await attach(page, testInfo, 'revamp-run')

  // Collapse all closes every group; Expand all brings back every row, in the same order.
  const expand = page.getByTestId('activity-expand')
  await expect(expand).toHaveText('Collapse all')
  await expand.click()
  for (const group of await groups(page).all()) await expect(group).not.toHaveAttribute('open', '')
  await expect(rows.first()).toBeHidden()
  await expect(expand).toHaveText('Expand all')
  await expand.click()
  for (const group of await groups(page).all()) await expect(group).toHaveAttribute('open', '')
  await expect(rows).toHaveCount(count)
  for (const row of await rows.all()) await expect(row).toBeVisible()
  expect(await rows.allInnerTexts()).toEqual(order)
  // One group closes on its own summary and opens again.
  await groups(page).first().locator('summary').click()
  await expect(groups(page).first()).not.toHaveAttribute('open', '')
  await expect(expand).toHaveText('Expand all')
  await groups(page).first().locator('summary').click()
  await expect(expand).toHaveText('Collapse all')

  // Newest first reverses the groups and the rows inside them: the first row is the last event.
  await page.getByTestId('activity-order').click()
  expect(await attributes(groups(page), 'data-phase')).toEqual(['review', 'verification', 'workers', 'challenge'])
  await expect(rows.first()).toContainText('09:53:52')
  expect(await rows.allInnerTexts()).toEqual([...order].reverse())
  // Each phase keeps its tone and its words in either order.
  expect(await attributes(groups(page), 'data-tone')).toEqual(['ok', 'ok', 'ok', 'ok'])
  await expect(groups(page).locator('summary')).toContainText(['all passed', 'all passed', 'all passed', 'all passed'])
  await page.getByTestId('activity-order').click()
  await expect(rows.first()).toContainText('09:00:00')

  // Narrower than both fit, they stack: Pipeline above Steps, each the full width.
  await page.setViewportSize({ width: 1024, height: 900 })
  await expect(page.getByTestId('run-board')).toHaveAttribute('data-layout', 'stacked')
  const above = await box(pipeline)
  const below = await box(steps)
  expect(above.y + above.height).toBeLessThanOrEqual(below.y)
  expect(Math.abs(above.x - below.x)).toBeLessThan(2)
  expect(await pageWidth(page)).toBeLessThanOrEqual(1024)

  // A failed review: its node and its Steps bar take the fail tone, its glyph says it; the run header's rule is fail.
  await page.setViewportSize({ width: 1440, height: 900 })
  await openRun(page, revampUrl(RUN_REVAMP_BLOCKED), 'review_blocked')
  await expect(page.getByTestId('run-header')).toHaveAttribute('data-tone', 'fail')
  expect((await style(page.getByTestId('run-header'), 'borderTopColor')).borderTopColor).toBe(await token(page, '--fail'))
  await expect(graphNode(page, 'review')).toHaveAttribute('data-tone', 'fail')
  expect((await style(graphNode(page, 'review').locator('.workflow-node-shape'), 'fill')).fill).toBe(await token(page, '--fail-soft'))
  await expect(graphNode(page, 'review').locator('.workflow-node-glyph')).toHaveText('✗')
  await expect(graphNode(page, 'approval')).toHaveAttribute('data-tone', 'idle')
  expect((await style(nodeListItem(page, 'review').locator('.step-bar-segment'), 'backgroundColor')).backgroundColor).toBe(await token(page, '--fail'))

  // A running run with a question waiting: the header and the waiting step take the needs-you tone; Activity has two phases so far.
  await openRun(page, revampUrl(RUN_REVAMP_RUNNING), 'question')
  await expect(now(page)).toContainText('adapter')
  await expect(page.getByTestId('run-header')).toHaveAttribute('data-tone', 'warn')
  // The banner waits on the operator: the needs-you rule over its soft background, never the run's own running blue.
  const waitingBanner = await style(now(page), 'borderLeftColor', 'backgroundColor')
  expect(waitingBanner.borderLeftColor).toBe(await token(page, '--warn'))
  expect(waitingBanner.backgroundColor).toBe(await token(page, '--warn-soft'))
  await expect(graphNode(page, 'launch_adapter')).toHaveAttribute('data-attention', 'question')
  // What waits on the operator wins over the status (tone.ts `stateTone`): the node and its Steps row are warn, the glyph `?`.
  await expect(graphNode(page, 'launch_adapter')).toHaveAttribute('data-tone', 'warn')
  await expect(graphNode(page, 'launch_adapter').locator('.workflow-node-glyph')).toHaveText('?')
  await expect(nodeListItem(page, 'launch_adapter')).toHaveClass(/tone-warn/)
  await expect(nodeListItem(page, 'launch_ui')).toHaveClass(/tone-run/)
  await expect(groups(page).last()).toHaveAttribute('data-tone', 'warn')
  await expect(groups(page).last().locator('summary')).toContainText('waiting on you')
  await expect(graphNode(page, 'launch_ui')).toHaveAttribute('data-tone', 'run')
  expect(await attributes(groups(page), 'data-phase')).toEqual(['challenge', 'workers'])
  await expect(groups(page).last().locator('li').last()).toContainText(REVAMP_QUESTION)
  await expectNoExecutionControls(page)

  // The node-less diagnosis and repair rows sit, open, in the phase where they occurred.
  await openRun(page, runUrl(RUN_REPAIRED, undefined, UX_RUN_WORKFLOW_ID), 'interrupted')
  for (const marker of ['diagnosis', 'repair']) {
    const row = activity(page).locator(`li[data-marker="${marker}"]`)
    await expect(row).toBeVisible()
    await expect(groups(page).filter({ has: page.locator(`li[data-marker="${marker}"]`) })).toHaveAttribute('data-phase', 'verification')
  }

  // At 390 px the board is one column: the Steps take the full width, the page never scrolls sideways.
  await page.setViewportSize({ width: 390, height: 844 })
  await openRun(page, revampUrl(RUN_REVAMP_DONE), 'succeeded')
  const narrow = await box(page.getByTestId('run-node-list'))
  expect(narrow.width).toBeGreaterThan(330)
  expect(await pageWidth(page)).toBeLessThanOrEqual(390)
  await expect(groups(page)).toHaveCount(4)
  await expect(activity(page).locator('li').first()).toBeVisible()
  await expectNoExecutionControls(page)
})

test(`[scenario:revamp-review] The review node opens on four figures, findings as severity-striped cards in P0/P1/P2 then lane order, one filter row whose toggles combine, the blocking card first and reviewer cards (${phase})`, async ({ page }, testInfo) => {
  await page.clock.install({ time: new Date(REVAMP_NOW) })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(revampUrl(RUN_REVAMP_BLOCKED, 'review'))
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'review')
  await expect(cards(page)).toHaveCount(4)

  // Four figures: blocking, open, per reviewer, per lane.
  const figures = page.getByTestId('review-figures')
  await expect(figures.locator('.ui-figure')).toHaveCount(4)
  await expect(figures.getByTestId('figure-blocking').locator('.ui-figure-value')).toHaveText('1')
  await expect(figures.getByTestId('figure-blocking')).toHaveClass(/tone-fail/)
  await expect(figures.getByTestId('figure-open').locator('.ui-figure-value')).toHaveText('3')
  const perReviewer = figures.getByTestId('figure-reviewers').locator('[data-reviewer]')
  expect(await attributes(perReviewer, 'data-reviewer')).toEqual(['general', 'coverage'])
  expect(await attributes(perReviewer, 'data-count')).toEqual(['2', '2'])
  await expect(perReviewer).toHaveText(['general 2', 'coverage 2'])
  const perLane = figures.getByTestId('figure-lanes').locator('[data-lane]')
  expect(await attributes(perLane, 'data-lane')).toEqual(['ui', 'adapter'])
  expect(await attributes(perLane, 'data-count')).toEqual(['2', '2'])

  // The figures open the page, then the blocking card (outside the findings), then the cards.
  const blocking = page.getByTestId('blocking-finding')
  await expect(blocking).toHaveCount(1)
  await expect(blocking).toContainText(BLOCKED_FINDINGS.coverageUi)
  await expect(findings(page).getByTestId('blocking-finding')).toHaveCount(0)
  expect(await precedes(figures, blocking)).toBe(true)
  expect(await precedes(blocking, cards(page).first())).toBe(true)
  expect((await box(blocking)).y).toBeLessThan(900)

  // Findings as cards: P1 first, then the P2s by lane (ui, adapter) and by declared reviewer, with every data attribute.
  expect(await attributes(cards(page), 'data-severity')).toEqual(['P1', 'P2', 'P2', 'P2'])
  expect(await attributes(cards(page), 'data-worker')).toEqual(['ui', 'ui', 'adapter', 'adapter'])
  expect(await attributes(cards(page), 'data-reviewer')).toEqual(['coverage', 'general', 'general', 'coverage'])
  expect(await attributes(cards(page), 'data-disposition')).toEqual(['open', 'open', 'accepted', 'open'])
  await expect(cards(page)).toContainText([BLOCKED_FINDINGS.coverageUi, BLOCKED_FINDINGS.generalUi, BLOCKED_FINDINGS.generalAdapter, BLOCKED_FINDINGS.coverageAdapter])
  await expect(cards(page).first()).toHaveClass(/finding-blocking/)
  await expect(cards(page).nth(1)).not.toHaveClass(/finding-blocking/)
  // The severity stripe: P1's colour on the P1 card, P2's on the others; the chip says the severity in words.
  expect((await style(cards(page).first(), 'borderLeftColor')).borderLeftColor).toBe(await token(page, '--p1'))
  expect((await style(cards(page).nth(1), 'borderLeftColor')).borderLeftColor).toBe(await token(page, '--p2'))
  await expect(cards(page).first().locator('.ui-sev')).toHaveText('P1')
  await expect(cards(page).first().getByTestId('finding-reviewer')).toHaveText('coverage')
  await expect(cards(page).first().getByTestId('finding-worker')).toHaveText('ui')
  await expect(cards(page).first().getByTestId('finding-task-link')).toHaveAttribute('data-lane', 'ui')

  // One filter row (no Reviewer and Group-by rows): each reviewer, each lane, Open only, with their counts.
  await expect(page.getByTestId('group-by-disposition')).toHaveCount(0)
  await expect(page.getByTestId('filter-reviewer')).toHaveCount(0)
  await expect(findings(page).getByRole('group')).toHaveCount(1)
  await expect(filters(page).locator('button')).toHaveText(['general 2', 'coverage 2', 'ui 2', 'adapter 2', 'Open only 3'])
  for (const button of await filters(page).locator('button').all()) await expect(button).toHaveAttribute('aria-pressed', 'false')
  await expect(findings(page)).toHaveAttribute('data-filters', 'all')

  // A reviewer narrows; a second reviewer adds its own; a lane and Open only narrow further; together they can leave nothing.
  await toggle(page, 'reviewer:coverage').click()
  await expect(toggle(page, 'reviewer:coverage')).toHaveAttribute('aria-pressed', 'true')
  expect(await attributes(cards(page), 'data-reviewer')).toEqual(['coverage', 'coverage'])
  await toggle(page, 'reviewer:general').click()
  await expect(cards(page)).toHaveCount(4)
  await toggle(page, 'reviewer:general').click()
  await toggle(page, 'lane:adapter').click()
  await expect(cards(page)).toHaveCount(1)
  await expect(cards(page)).toContainText(BLOCKED_FINDINGS.coverageAdapter)
  await expect(findings(page)).toHaveAttribute('data-filters', 'reviewer:coverage lane:adapter')
  await toggle(page, 'reviewer:coverage').click()
  await expect(cards(page)).toHaveCount(2)
  await toggle(page, 'open').click()
  await expect(cards(page)).toHaveCount(1)
  await expect(cards(page)).toHaveAttribute('data-disposition', 'open')
  await expect(cards(page)).toHaveAttribute('data-reviewer', 'coverage')
  await toggle(page, 'reviewer:general').click()
  await expect(cards(page)).toHaveCount(0)
  await expect(page.getByTestId('findings-empty')).toHaveText('No finding matches the pressed filters.')
  for (const id of ['reviewer:general', 'lane:adapter', 'open']) await toggle(page, id).click()
  await expect(cards(page)).toHaveCount(4)
  await expect(findings(page)).toHaveAttribute('data-filters', 'all')
  // The blocking card does not move with the filters.
  await expect(blocking).toHaveCount(1)

  // Reviewer cards follow the findings, one per reviewer in declared order, each with its verdict and counts.
  const reviewers = page.getByTestId('reviewer-entry')
  expect(await attributes(reviewers, 'data-reviewer')).toEqual(['general', 'coverage'])
  await expect(reviewers.getByTestId('reviewer-verdict')).toHaveText(['Approved', 'Blocked'])
  await expect(reviewers.getByTestId('reviewer-counts')).toHaveText(['2 P2', '1 P1, 1 P2'])
  await expect(reviewers.first()).toHaveClass(/tone-ok/)
  await expect(reviewers.last()).toHaveClass(/tone-fail/)
  expect(await precedes(cards(page).last(), reviewers.first())).toBe(true)
  await expectNoExecutionControls(page)
  await page.evaluate('window.scrollTo(0, 0)')
  await attach(page, testInfo, 'revamp-review')

  // An approved review: nothing blocks (the resolved P1 still leads the cards), no blocking card.
  await page.goto(revampUrl(RUN_REVAMP_DONE, 'review'))
  await expect(cards(page)).toHaveCount(3)
  await expect(page.getByTestId('figure-blocking').locator('.ui-figure-value')).toHaveText('0')
  await expect(page.getByTestId('figure-blocking')).toHaveClass(/tone-ok/)
  await expect(page.getByTestId('figure-open').locator('.ui-figure-value')).toHaveText('1')
  await expect(page.getByTestId('blocking-finding')).toHaveCount(0)
  await expect(cards(page)).toContainText([DONE_FINDINGS.coverageUi, DONE_FINDINGS.generalUi, DONE_FINDINGS.coverageAdapter])
  expect(await attributes(cards(page), 'data-disposition')).toEqual(['resolved', 'open', 'accepted'])

  // Verify and worker nodes open on their own figures.
  await page.goto(revampUrl(RUN_REVAMP_DONE, 'verify_ui'))
  const verify = page.getByTestId('verify-figures')
  await expect(verify.getByTestId('figure-checks-passed').locator('.ui-figure-value')).toHaveText('3')
  await expect(verify.getByTestId('figure-checks-failed').locator('.ui-figure-value')).toHaveText('0')
  await expect(verify.getByTestId('figure-took')).toBeVisible()
  await expect(verify.getByTestId('figure-checks-passed')).toHaveClass(/tone-ok/)
  // The gate line: the verdict in words, a left rule in its tone over the soft background, the verdict word in the tone.
  const gateLine = page.getByTestId('gate-outcome').locator('.gate-line')
  await expect(gateLine).toHaveAttribute('data-tone', 'ok')
  await expect(gateLine).toContainText('Passed:')
  const gateStyle = await style(gateLine, 'borderLeftColor', 'backgroundColor')
  expect(gateStyle.borderLeftColor).toBe(await token(page, '--ok'))
  expect(gateStyle.backgroundColor).toBe(await token(page, '--ok-soft'))
  expect((await style(gateLine.locator('strong'), 'color')).color).toBe(await token(page, '--ok'))
  // The check table: every exit a tone chip with its words unchanged, its glyph in the same tone.
  const checkRows = page.getByTestId('checks-list').locator(':scope > li.check')
  await expect(checkRows).toHaveCount(3)
  for (const row of await checkRows.all()) {
    const exit = row.locator('.check-exit')
    await expect(exit).toHaveText('exit 0')
    await expect(exit).toHaveClass(/ui-chip/)
    await expect(exit).toHaveAttribute('data-tone', 'ok')
    const chip = await style(exit, 'color', 'backgroundColor', 'borderTopLeftRadius')
    expect(chip.color).toBe(await token(page, '--ok'))
    expect(chip.backgroundColor).toBe(await token(page, '--ok-soft'))
    expect(parseFloat(chip.borderTopLeftRadius)).toBeGreaterThanOrEqual(10)
    expect((await style(row.locator('.check-glyph'), 'color')).color).toBe(await token(page, '--ok'))
  }
  // The step strip: every chip in its step's tone (all succeeded: ok), the current one marked.
  const strip = page.getByTestId('run-node-list').locator('.step-chip')
  expect(await strip.count()).toBeGreaterThanOrEqual(10)
  for (const chip of await strip.all()) {
    await expect(chip).toHaveClass(/tone-ok/)
    const chipStyle = await style(chip, 'backgroundColor', 'borderTopColor')
    expect(chipStyle.backgroundColor).toBe(await token(page, '--ok-soft'))
    expect(chipStyle.borderTopColor === (await token(page, '--ok')) || (await chip.getAttribute('aria-current')) === 'page').toBe(true)
  }
  await expect(page.getByTestId('run-node-list').locator('.step-chip[aria-current="page"]')).toHaveCount(1)
  // Colour is never the only carrier: each chip also shows its status glyph and says its status in its accessible name.
  for (const chip of await strip.all()) {
    await expect(chip.locator('.step-glyph')).toHaveText('✓')
    await expect(chip).toHaveAccessibleName(/, succeeded$/)
  }
  await expect(page.getByTestId('run-node-list').getByRole('link', { name: /^Verify .*, succeeded$/ }).first()).toBeVisible()

  // The worker's figures: Files from its freeze (as many as its file rows), its completion and its questions.
  await page.goto(revampUrl(RUN_REVAMP_DONE, 'launch_ui'))
  const doneWorker = page.getByTestId('worker-figures')
  // ui froze three changed files (UI_CHANGED_FILES): the figure counts them, as the file rows list them.
  await expect(page.getByTestId('created-file')).toHaveCount(UI_CHANGED_FILES.length)
  await expect(doneWorker.getByTestId('figure-files').locator('.ui-figure-value')).toHaveText(String(UI_CHANGED_FILES.length))
  await expect(doneWorker.getByTestId('figure-files').locator('.ui-figure-label')).toHaveText('Files changed')
  await expect(doneWorker.getByTestId('figure-completion').locator('.ui-figure-value')).toHaveText('completed')
  await expect(doneWorker.getByTestId('figure-completion')).toHaveClass(/tone-ok/)
  await page.goto(revampUrl(RUN_REVAMP_RUNNING, 'launch_adapter'))
  const worker = page.getByTestId('worker-figures')
  await expect(worker.getByTestId('figure-questions').locator('.ui-figure-value')).toHaveText('1 waiting')
  await expect(worker.getByTestId('figure-questions')).toHaveClass(/tone-warn/)
  await expect(worker.getByTestId('figure-completion').locator('.ui-figure-value')).toHaveText('none yet')
  // Nothing frozen yet: the Files figure says so instead of a count.
  await expect(worker.getByTestId('figure-files').locator('.ui-figure-value')).toHaveText('—')
  await expect(worker.getByTestId('figure-files').locator('.ui-figure-label')).toHaveText('Files (not frozen yet)')
  // The step strip on a running run: the waiting lane's chip in the needs-you tone, the other lane running, the challenge ok.
  const stripChip = (id: string) => page.getByTestId('run-node-list').locator(`li[data-node-id="${id}"] .step-chip`)
  await expect(stripChip('launch_adapter')).toHaveClass(/tone-warn/)
  expect((await style(stripChip('launch_adapter'), 'backgroundColor')).backgroundColor).toBe(await token(page, '--warn-soft'))
  await expect(stripChip('launch_ui')).toHaveClass(/tone-run/)
  expect((await style(stripChip('launch_ui'), 'backgroundColor')).backgroundColor).toBe(await token(page, '--run-soft'))
  await expect(stripChip('challenge')).toHaveClass(/tone-ok/)
  // The same states without colour: the glyph and the status words in each chip's accessible name.
  await expect(stripChip('launch_adapter').locator('.step-glyph')).toHaveText('?')
  await expect(stripChip('launch_adapter')).toHaveAccessibleName(/, running, waits on you$/)
  await expect(page.getByTestId('run-node-list').getByRole('link', { name: /waits on you/ })).toHaveCount(1)
  await expect(stripChip('launch_ui').locator('.step-glyph')).toHaveText('●')
  await expect(stripChip('launch_ui')).toHaveAccessibleName(/, running$/)
  await expect(stripChip('challenge').locator('.step-glyph')).toHaveText('✓')
  await expect(stripChip('challenge')).toHaveAccessibleName(/, succeeded$/)
  // A failed step: its chip in the fail tone, with the ✗ glyph and "failed" in its name.
  await page.goto(revampUrl(RUN_REVAMP_BLOCKED, 'verify_ui'))
  await expect(stripChip('review')).toHaveClass(/tone-fail/)
  await expect(stripChip('review').locator('.step-glyph')).toHaveText('✗')
  await expect(stripChip('review')).toHaveAccessibleName(/, failed$/)
  await expect(page.getByTestId('run-node-list').getByRole('link', { name: /, failed$/ })).toHaveCount(1)

  // At 390 px the cards stack, full width, and nothing scrolls sideways.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(revampUrl(RUN_REVAMP_BLOCKED, 'review'))
  await expect(cards(page)).toHaveCount(4)
  const first = await box(cards(page).first())
  const second = await box(cards(page).nth(1))
  expect(second.y).toBeGreaterThanOrEqual(first.y + first.height)
  expect(first.width).toBeGreaterThan(300)
  await expect.poll(() => pageWidth(page)).toBeLessThanOrEqual(390)
  await expectNoExecutionControls(page)
})

/**
 * One clock (a PRD safety rule): the run page ticks from `RunView` alone, while the run can still change, and every section reads
 * that clock as a prop. `tests/unit/steps.test.ts` fails when a file under src/projects other than RunView and ProjectsView calls
 * `useNow`; here the page shows it: a waiting question's age moves within seconds of the minute turning (a section clock of its
 * own ticked every 30 s), together with the header's running span, and a finished run's page does not change at all.
 */
/** The workspace's text once every resource has loaded: the same on two reads half a second apart (real time). */
async function settled(page: Page): Promise<string> {
  let previous = ''
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const text = await workspace(page).innerText()
    if (text === previous) return text
    previous = text
    await page.waitForTimeout(500)
  }
  throw new Error('the page kept changing without a clock tick')
}

test(`One clock: a running run's ages tick together from the run page clock; a finished run's page does not tick (${phase})`, async ({ page }) => {
  // The page opens at 10:24:20 (adapter's question was asked at 10:20:00); the clock then stops two seconds before the question
  // turns five minutes old. A section clock of its own (30 s, started on mount) would next tick after 10:25:20.
  await page.clock.install({ time: new Date('2026-03-12T10:24:20Z') })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(revampUrl(RUN_REVAMP_RUNNING, 'launch_adapter'))
  const question = page.getByTestId('worker-question').filter({ hasText: REVAMP_QUESTION })
  await expect(question).toContainText('(4 min ago)')
  await page.clock.pauseAt(new Date('2026-03-12T10:24:58Z'))
  await expect(question).toContainText('(4 min ago)')
  await page.clock.runFor(3_000)
  await expect(question).toContainText('(5 min ago)')

  // On the run page the header's span and the Now banner run off the same clock: a minute later both have moved.
  await page.goto(revampUrl(RUN_REVAMP_RUNNING))
  await expect(now(page)).toHaveAttribute('data-situation', 'question')
  const span = page.getByTestId('run-span')
  await expect(span).toContainText('running')
  const before = await span.innerText()
  await page.clock.runFor(61_000)
  await expect(span).not.toHaveText(before)

  // A finished run: the page reads the same after two minutes, polls included.
  await page.goto(revampUrl(RUN_REVAMP_DONE))
  await expect(now(page)).toHaveAttribute('data-situation', 'succeeded')
  await expect(groups(page)).toHaveCount(4)
  const still = await settled(page)
  await page.clock.runFor(120_000)
  expect(await workspace(page).innerText()).toBe(still)
  await page.goto(revampUrl(RUN_REVAMP_DONE, 'review'))
  await expect(cards(page)).toHaveCount(3)
  const node = await settled(page)
  await page.clock.runFor(120_000)
  expect(await workspace(page).innerText()).toBe(node)
})

type Reading = { where: string; text: string; color: string; background: string; ratio: number }
/**
 * The text contrast of every element under `roots` that holds text of its own: its colour (with its and its ancestors' opacity)
 * over the first opaque background behind it, composited through any translucent ones. Browser globals are cast (no DOM lib).
 */
const contrasts = (roots: Locator, where: string): Promise<Reading[]> => roots.evaluateAll((elements, label) => {
  type Node = { nodeType: number; textContent: string | null; childNodes: ArrayLike<Node>; parentElement: Node | null; tagName: string; className: unknown; getBoundingClientRect: () => { width: number; height: number }; checkVisibility?: (options: object) => boolean; querySelectorAll: (selector: string) => ArrayLike<Node> }
  const computed = (node: Node) => (globalThis as unknown as { getComputedStyle: (element: unknown) => Record<string, string> }).getComputedStyle(node)
  const parse = (value: string): number[] => {
    const rgb = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/.exec(value)
    if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? Number(rgb[4].slice(0, -1)) / 100 : Number(rgb[4])]
    const srgb = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/.exec(value)
    if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, srgb[4] === undefined ? 1 : Number(srgb[4])]
    return [0, 0, 0, 0]
  }
  const over = (top: number[], bottom: number[]) => [0, 1, 2].map(index => top[index] * top[3] + bottom[index] * (1 - top[3])).concat(1)
  const luminance = (color: number[]) => {
    const linear = (channel: number) => { const value = channel / 255; return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4 }
    return 0.2126 * linear(color[0]) + 0.7152 * linear(color[1]) + 0.0722 * linear(color[2])
  }
  const ownsText = (node: Node) => Array.from(node.childNodes).some(child => child.nodeType === 3 && (child.textContent ?? '').trim() !== '')
  const readings: { where: string; text: string; color: string; background: string; ratio: number }[] = []
  for (const root of elements as unknown as Node[]) {
    for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
      if (!ownsText(element) || ['svg', 'text', 'tspan'].includes(element.tagName.toLowerCase())) continue
      const box = element.getBoundingClientRect()
      if (box.width < 2 || box.height < 2 || (element.checkVisibility && !element.checkVisibility({ visibilityProperty: true }))) continue
      const layers: number[][] = []
      let opacity = 1
      for (let node: Node | null = element; node !== null; node = node.parentElement) {
        const style = computed(node)
        opacity *= Number(style.opacity)
        const background = parse(style.backgroundColor)
        if (background[3] > 0) layers.push(background)
        if (background[3] >= 1) break
      }
      const background = layers.reverse().reduce((bottom, top) => over(top, bottom), [255, 255, 255, 1])
      const ink = parse(computed(element).color)
      const text = over([ink[0], ink[1], ink[2], ink[3] * opacity], background)
      const [light, dark] = [luminance(text), luminance(background)].sort((a, b) => b - a)
      readings.push({ where: label, text: (element.textContent ?? '').trim().slice(0, 40), color: computed(element).color, background: `rgb(${background.slice(0, 3).map(Math.round).join(', ')})`, ratio: (light + 0.05) / (dark + 0.05) })
    }
  }
  return readings
}, where)

/** Bold without the shell's switch: `data-look` set on the shell after navigation, and a Bold-only token checked to resolve. */
async function applyLook(page: Page, look: 'calm' | 'bold') {
  if (look === 'bold') {
    await workspace(page).evaluate(shell => (shell as unknown as { setAttribute: (name: string, value: string) => void }).setAttribute('data-look', 'bold'))
    expect(await token(page, '--band'), 'Bold draws the section band').not.toBe('rgba(0, 0, 0, 0)')
  } else {
    expect(await token(page, '--band'), 'Calm has no section band').toBe('rgba(0, 0, 0, 0)')
  }
}

test(`The run and node pages' chips, figures, phase summaries, cards, gate lines, check chips and step strip read at 4.5:1 in Calm and Bold, light and dark (${phase})`, async ({ page }) => {
  test.setTimeout(180_000)
  await page.clock.install({ time: new Date(REVAMP_NOW) })
  await page.setViewportSize({ width: 1440, height: 900 })
  // Each page and the elements of its own measured on it.
  const pages: { url: string; ready: (page: Page) => Promise<void>; roots: string[] }[] = [
    { url: revampUrl(RUN_REVAMP_DONE), ready: async page => { await expect(now(page)).toHaveAttribute('data-situation', 'succeeded') }, roots: ['[data-testid="run-header"]', '[data-testid="run-now"]', '[data-testid="run-lanes"] li[data-lane]', '[data-testid="activity-group"] > summary', '[data-testid="run-steps"] .ui-section-header', '[data-testid="run-pipeline"] .ui-section-header'] },
    { url: revampUrl(RUN_REVAMP_RUNNING), ready: async page => { await expect(now(page)).toHaveAttribute('data-situation', 'question') }, roots: ['[data-testid="run-now"] .run-now-headline', '[data-testid="run-lanes"] li[data-lane]', '[data-testid="activity-group"] > summary'] },
    { url: revampUrl(RUN_REVAMP_BLOCKED, 'review'), ready: async page => { await expect(cards(page)).toHaveCount(4) }, roots: ['[data-testid="review-figures"] .ui-figure', '[data-testid="finding"] .finding-card-head', '[data-testid="findings-filters"] button', '[data-testid="reviewer-entry"]', '[data-testid="run-node-list"] .step-chip', '[data-testid="blocking-finding"]'] },
    { url: revampUrl(RUN_REVAMP_DONE, 'verify_ui'), ready: async page => { await expect(page.getByTestId('checks-list').locator('.check-exit')).toHaveCount(3) }, roots: ['[data-testid="verify-figures"] .ui-figure', '.gate-line', '[data-testid="checks-list"] .check-exit', '[data-testid="run-node-list"] .step-chip'] },
    // A failed gate (ux-verify's rejected checks): the fail-toned gate line, rejected rows on --fail-soft with their reasons.
    { url: `${runUrl(RUN_REJECTED_CHECKS, 'verify_ui', UX_VERIFY_WORKFLOW_ID)}/attempts/1`, ready: async page => { await expect(page.getByTestId('checks-list').locator('.check-reasons')).toHaveCount(2) }, roots: ['[data-testid="worker-error"] .gate-line', '[data-testid="checks-list"] .check-exit', '[data-testid="checks-list"] .check-reasons', '[data-testid="checks-list"] .check-rejected .check-head'] },
    { url: revampUrl(RUN_REVAMP_RUNNING, 'launch_adapter'), ready: async page => { await expect(page.getByTestId('worker-figures')).toBeVisible() }, roots: ['[data-testid="worker-figures"] .ui-figure', '[data-testid="run-node-list"] .step-chip'] },
  ]
  const failures: Reading[] = []
  let measured = 0
  let lightBg = ''
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    for (const look of ['calm', 'bold'] as const) {
      for (const entry of pages) {
        await page.goto(entry.url)
        await entry.ready(page)
        await applyLook(page, look)
        // The theme took: dark changes the shell's background token.
        const bg = await token(page, '--bg')
        if (scheme === 'light' && look === 'calm') lightBg = bg
        if (scheme === 'dark' && look === 'calm') expect(bg, 'dark changes --bg').not.toBe(lightBg)
        for (const root of entry.roots) {
          const readings = await contrasts(page.locator(root), `${scheme}/${look} ${entry.url} ${root}`)
          expect(readings.length, `${scheme}/${look} ${entry.url} ${root} has text to measure`).toBeGreaterThan(0)
          measured += readings.length
          failures.push(...readings.filter(reading => reading.ratio < 4.5))
        }
        // Pressed filter toggles read too.
        if (entry.url.endsWith('/review')) {
          await toggle(page, 'reviewer:coverage').click()
          failures.push(...(await contrasts(toggle(page, 'reviewer:coverage'), `${scheme}/${look} pressed toggle`)).filter(reading => reading.ratio < 4.5))
        }
      }
    }
  }
  expect(measured).toBeGreaterThan(200)
  expect(failures, 'text under 4.5:1').toEqual([])
})

/**
 * The read-only allow-list on the run and node pages (PRD_VIEWER_UX 12.3 plus PRD_VIEWER_REVAMP section 8, and the controls
 * PRD_VIEWER_UX itself specifies on these pages: the Activity order, the controller log, an event's message, Less after More,
 * Hide contents after Show contents, Rendered/Source, a screenshot dialog's Close), each filter label being a reviewer or lane id
 * with its count; no button holds a path or a command.
 */
test(`Every button on the run and node pages is on the read-only allow-list and holds no path or command (${phase})`, async ({ page }) => {
  test.setTimeout(120_000)
  await page.clock.install({ time: new Date(REVAMP_NOW) })
  await page.setViewportSize({ width: 1440, height: 900 })
  const ids = ['general', 'coverage', 'ui', 'adapter']
  const allowed = new RegExp(`^(Copy|Show contents|Hide contents|Show lines|More|Less|Run|Assignment|Local|UTC|Expand all|Collapse all|Newest first|Controller log \\(\\d+\\)|Rendered|Source|Close|All \\d+|#\\d+|message|Open only \\d+|(?:${ids.join('|')}) \\d+)$`)
  const command = /[/\\$`]|\b(npm|npx|git|workflow|node|python|bash)\b/
  const seen = new Set<string>()
  const check = async (where: string) => {
    // Read every button at once, so a re-render between reads cannot skip one.
    const buttons = await workspace(page).locator('button').evaluateAll(elements => elements.map(element => {
      const node = element as unknown as { textContent: string | null; querySelector: (selector: string) => unknown }
      return { text: (node.textContent ?? '').replace(/\s+/g, ' ').trim(), image: node.querySelector('img') !== null }
    }))
    expect(buttons.length, `${where} has buttons`).toBeGreaterThan(0)
    for (const { text, image } of buttons) {
      // A screenshot thumbnail is an image button: its name is the image's alt text, never a command.
      if (text === '' && image) continue
      seen.add(text)
      expect(text, `${where}: button "${text}"`).toMatch(allowed)
      expect(text, `${where}: button "${text}" holds no path or command`).not.toMatch(command)
    }
    await expectNoExecutionControls(page)
  }
  for (const [runId, situation] of [[RUN_REVAMP_DONE, 'succeeded'], [RUN_REVAMP_BLOCKED, 'review_blocked'], [RUN_REVAMP_RUNNING, 'question']] as const) {
    await openRun(page, revampUrl(runId), situation)
    await expect(groups(page).first()).toBeVisible()
    await check(runId)
    // The Activity tools in their other states.
    await page.getByTestId('activity-expand').click()
    await page.getByTestId('activity-order').click()
    await check(`${runId} (collapsed, newest first)`)
    await page.getByTestId('activity-order').click()
    await page.getByTestId('activity-expand').click()
  }
  // Every step of the finished run, the blocked review and the waiting worker.
  await openRun(page, revampUrl(RUN_REVAMP_DONE), 'succeeded')
  const steps = await attributes(page.getByTestId('run-node-list').locator('[data-node-id]'), 'data-node-id')
  expect(steps.length).toBeGreaterThanOrEqual(10)
  for (const nodeId of steps) {
    await page.goto(revampUrl(RUN_REVAMP_DONE, nodeId!))
    await expect(nodeDetail(page)).toHaveAttribute('data-node-id', nodeId!)
    await check(`${RUN_REVAMP_DONE}/${nodeId}`)
  }
  await page.goto(revampUrl(RUN_REVAMP_BLOCKED, 'review'))
  await expect(cards(page)).toHaveCount(4)
  // The lane toggles and counts follow the run's inputs: wait for the whole row as revamp-review reads it.
  await expect(filters(page).locator('button')).toHaveText(['general 2', 'coverage 2', 'ui 2', 'adapter 2', 'Open only 3'])
  await check(`${RUN_REVAMP_BLOCKED}/review`)
  await page.goto(revampUrl(RUN_REVAMP_RUNNING, 'launch_adapter'))
  await expect(page.getByTestId('worker-figures')).toBeVisible()
  await check(`${RUN_REVAMP_RUNNING}/launch_adapter`)
  // The new run-page tools and the filter row were among the buttons read.
  for (const text of ['Collapse all', 'Expand all', 'Newest first', 'Open only 3', 'general 2', 'coverage 2', 'ui 2', 'adapter 2']) expect(seen.has(text), text).toBe(true)
})
