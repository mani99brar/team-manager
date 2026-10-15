/**
 * The judged review panel in the viewer (features/review-panel-registry/prd.md 8, panel record 1.1.0): the seats with their
 * name, prefix, transport, model, CLI version, status, duration and cost; the judge with its status, model, cost, duration and
 * its rulings grouped Confirmed (P0/P1 first), Deferred and Refuted, each with source chips that link to the seat or the
 * reviewer that raised it; the fallback banner when the judge failed and today's rule decided; the review section in which
 * the judge decides and the built-in reviewers are advisory; the Sessions rows; a 1.0.0 run unchanged; 390 px. Both phases:
 * the worker phase serves `fixtures/ux-judged.ts` through the mocks, the candidate phase seeds the same runs from the
 * feature's literal examples.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { JUDGE_SESSION, RUN_JUDGED, RUN_JUDGED_FALLBACK, UX_JUDGED_WORKFLOW_ID } from './fixtures/ux-judged.ts'
import { RUN_PANEL_SUCCEEDED, UX_PANEL_WORKFLOW_ID } from './fixtures/ux-panel.ts'
import { attach, expectNoExecutionControls, graphNode, installHooks, openStepSheet, phase, renderedText, runUrl, stepSheet } from './support.ts'

installHooks()

const runPage = (runId: string) => runUrl(runId, undefined, UX_JUDGED_WORKFLOW_ID)
const nodePage = (runId: string, nodeId: string) => runUrl(runId, nodeId, UX_JUDGED_WORKFLOW_ID)
const section = (page: Page) => page.getByTestId('panel-section')
const panel = (page: Page) => section(page).locator('[data-testid="panel"][data-id="review"]')
const seat = (scope: Locator, name: string) => scope.locator(`[data-testid="panel-seat"][data-name="${name}"]`)
const ruling = (scope: Locator, id: string) => scope.locator(`[data-testid="judge-ruling"][data-id="${id}"]`)
const texts = async (items: Locator) => Promise.all((await items.all()).map(item => item.innerText()))
const attributes = async (items: Locator, name: string) => Promise.all((await items.all()).map(item => item.getAttribute(name)))
const pageWidth = (page: Page) => page.evaluate(() => (globalThis as unknown as { document: { documentElement: { scrollWidth: number } } }).document.documentElement.scrollWidth)
const sidewaysOverflow = (target: Locator) => target.evaluate(element => (element as unknown as { scrollWidth: number; clientWidth: number }).scrollWidth - (element as unknown as { clientWidth: number }).clientWidth)
const FALLBACK_BANNER = 'Judge timed out: the built-in reviewers decided (today\'s rule); panel findings are unjudged'

async function openPanelOnRunPage(page: Page, runId: string) {
  await page.goto(runPage(runId))
  await openStepSheet(page, 'review')
  await expect(section(page)).toBeVisible()
}

test(`[scenario:panel-judged] The judged run's Panel section lists the seats claude, gpt and muse with prefix, transport, model, CLI version, status ok, duration and cost (not reported for muse), and the judge block shows judged, claude-opus-5-5, its cost and duration (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openPanelOnRunPage(page, RUN_JUDGED)
  const body = section(page)
  await expect(body.getByTestId('panel-judged-line')).toHaveText('Judged: the judge rules on every finding, from a seat or a built-in reviewer, and decides the review')
  await expect(body.getByTestId('panel-report-only')).toHaveCount(0)
  await expect(panel(page)).toHaveAttribute('data-judged', 'true')
  await expect(panel(page).getByTestId('panel-counts')).toHaveText('3 seat(s) ok, 0 not ok')
  const seats = panel(page).getByTestId('panel-seat')
  expect(await attributes(seats, 'data-name')).toEqual(['claude', 'gpt', 'muse'])
  expect(await texts(seats.getByTestId('panel-seat-prefix'))).toEqual(['C', 'G', 'M'])
  expect(await texts(seats.getByTestId('panel-seat-transport'))).toEqual(['claude', 'pi', 'cli'])
  expect(await texts(seats.getByTestId('panel-seat-model'))).toEqual(['default model', 'openai-codex/gpt-6.1-sol', 'muse-wonder-1.0'])
  expect(await texts(seats.getByTestId('panel-seat-status'))).toEqual(['ok', 'ok', 'ok'])
  expect(await texts(seats.getByTestId('panel-seat-cost'))).toEqual(['$1.82', 'subscription-covered', 'not reported'])
  // The seats' wait: from the panel's start (10:02:11) to the judge's (10:24:03); the record keeps no per-seat times.
  expect(await texts(seats.getByTestId('panel-seat-duration'))).toEqual(['≤ 21m52s', '≤ 21m52s', '≤ 21m52s'])
  await expect(seat(panel(page), 'muse').getByTestId('panel-seat-cli-version')).toHaveText('Muse Code 1.4.7 (1.4.7-R6101.1)')
  await expect(seat(panel(page), 'claude').getByTestId('panel-seat-cli-version')).toHaveCount(0)
  const judge = panel(page).getByTestId('panel-judge')
  await expect(judge).toHaveAttribute('data-status', 'judged')
  await expect(judge.getByTestId('panel-judge-status')).toHaveText('judged')
  await expect(judge.getByTestId('panel-judge-model')).toHaveText('claude-opus-5-5')
  await expect(judge.getByTestId('panel-judge-cost')).toHaveText('$3.07')
  await expect(judge.getByTestId('panel-judge-duration')).toHaveText('took 7m37s')
  await expect(judge.getByTestId('panel-judge-counts')).toHaveText('2 confirmed (1 P0/P1), 1 deferred, 1 refuted')
  await expect(panel(page).getByTestId('panel-fallback-banner')).toHaveCount(0)
  await renderedText(body)
  await expectNoExecutionControls(page)
  await attach(page, testInfo, 'panel-judged')
})

test(`[scenario:panel-rulings] The judge block lists Confirmed first (J1 P1 at workflow/panel.py:212, lane engine; J2 P2, lane viewer), then Deferred (J4 P0 with its base-scope reason) and Refuted (J3 with its evidence); each ruling shows its source chips and each chip links to its reviewer or seat (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  // The panel's own node page carries the Panel section with the judge's rulings.
  await page.goto(nodePage(RUN_JUDGED, 'panel'))
  const judge = panel(page).getByTestId('panel-judge')
  await expect(judge).toBeVisible()
  expect(await attributes(judge.getByTestId('judge-group'), 'data-ruling')).toEqual(['confirmed', 'deferred', 'refuted'])
  expect(await judge.getByTestId('judge-group').locator('h6').allTextContents()).toEqual(['Confirmed (2)', 'Deferred (1)', 'Refuted (1)'])
  expect(await attributes(judge.getByTestId('judge-ruling'), 'data-id')).toEqual(['J1', 'J2', 'J4', 'J3'])
  const j1 = ruling(judge, 'J1')
  await expect(j1.getByTestId('judge-ruling-severity')).toHaveText('P1')
  await expect(j1.getByTestId('judge-ruling-title')).toHaveText('settle does not wait for a seat relaunched on resume')
  await expect(j1.getByTestId('judge-ruling-location')).toHaveText('workflow/panel.py:212')
  await expect(j1.getByTestId('judge-ruling-lane')).toHaveText('lane engine')
  await expect(j1.getByTestId('judge-ruling-requirement')).toContainText('PRD 7.2: the judge starts only after every seat has finished, failed or timed out')
  await expect(j1.getByTestId('judge-ruling-evidence')).toContainText('workflow/panel.py:205-214')
  await expect(ruling(judge, 'J2').getByTestId('judge-ruling-severity')).toHaveText('P2')
  await expect(ruling(judge, 'J2').getByTestId('judge-ruling-lane')).toHaveText('lane viewer')
  const j4 = ruling(judge, 'J4')
  await expect(j4.getByTestId('judge-ruling-severity')).toHaveText('P0')
  await expect(j4.getByTestId('judge-ruling-reason')).toContainText('Unchanged since the run\'s base and named by no PRD or decisions line (base-scope rule).')
  await expect(ruling(judge, 'J3').getByTestId('judge-ruling-evidence')).toContainText('workflow/judge.py:88')
  // Sources: text chips, each a link to the reviewer's page or to the seat's line in this section.
  const chips = j1.getByTestId('judge-source')
  expect(await texts(chips)).toEqual(['general-1', 'C1', 'M1'])
  expect(await attributes(chips, 'data-target-kind')).toEqual(['reviewer', 'seat', 'seat'])
  expect(await attributes(chips, 'data-target')).toEqual(['general', 'claude', 'muse'])
  for (const chip of await chips.all()) expect(await chip.evaluate(element => element.tagName)).toBe('A')
  await expect(chips.nth(0)).toHaveAttribute('href', new RegExp(`/runs/${RUN_JUDGED}/nodes/reviewer-general$`))
  await expect(chips.nth(2)).toHaveAttribute('href', '#panel-review-seat-muse')
  expect(await texts(ruling(judge, 'J2').getByTestId('judge-source'))).toEqual(['coverage-1'])
  expect(await texts(j4.getByTestId('judge-source'))).toEqual(['G1'])
  await attach(page, testInfo, 'panel-rulings')
  // A seat chip moves to that seat's line in place; a reviewer chip opens the reviewer's page.
  await chips.nth(2).click()
  await expect(seat(panel(page), 'muse')).toBeFocused()
  await expect(page).toHaveURL(new RegExp(`/runs/${RUN_JUDGED}/nodes/panel$`))
  await chips.nth(0).click()
  await expect(page).toHaveURL(new RegExp(`/runs/${RUN_JUDGED}/nodes/reviewer-general$`))
  // The reviewer's page shows the source finding the judge read (the judged review records only the judge's findings).
  const read = page.getByTestId('reviewer-judge-read')
  await expect(read.locator('[data-testid="reviewer-judge-read-finding"][data-id="general-1"]')).toContainText('panel.settle can return while a resumed seat is still running')
  await expect(page.getByTestId('reviewer-findings-none')).toHaveCount(0)
})

test(`[scenario:panel-fallback] On the fallback run the Panel section shows the banner "${FALLBACK_BANNER}", gpt timed out, muse not logged in, argon unavailable: disabled in the reviewer list, and C1 as an unjudged finding (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openPanelOnRunPage(page, RUN_JUDGED_FALLBACK)
  await expect(section(page).getByTestId('panel-source')).toHaveAttribute('data-source', 'live')
  await expect(panel(page).getByTestId('panel-fallback-banner')).toHaveText(FALLBACK_BANNER)
  await expect(panel(page).getByTestId('panel-fallback-banner')).toHaveAttribute('role', 'note')
  const seats = panel(page).getByTestId('panel-seat')
  expect(await attributes(seats, 'data-name')).toEqual(['claude', 'gpt', 'muse', 'argon'])
  expect(await texts(seats.getByTestId('panel-seat-status'))).toEqual(['ok', 'timed out', 'not logged in', 'unavailable: disabled in the reviewer list'])
  await expect(seat(panel(page), 'gpt').getByTestId('panel-seat-error')).toHaveText('Error: timed out after 15 minutes')
  await expect(seat(panel(page), 'muse').getByTestId('panel-seat-error')).toHaveText('Error: Not logged in (run `muse login`)')
  // The disabled seat never ran: no duration, no cost, its reason already in its status.
  await expect(seat(panel(page), 'argon').getByTestId('panel-seat-duration')).toHaveText('not recorded')
  await expect(seat(panel(page), 'argon').getByTestId('panel-seat-cost')).toHaveText('not reported')
  await expect(seat(panel(page), 'argon').getByTestId('panel-seat-error')).toHaveCount(0)
  await expect(panel(page).getByTestId('panel-counts')).toHaveText('1 seat(s) ok, 3 not ok')
  const judge = panel(page).getByTestId('panel-judge')
  await expect(judge.getByTestId('panel-judge-status')).toHaveText('timed out')
  await expect(judge.getByTestId('judge-ruling')).toHaveCount(0)
  const unjudged = panel(page).getByTestId('panel-unjudged')
  await expect(unjudged.locator('h5')).toHaveText('Unjudged panel findings (1)')
  await expect(unjudged.locator('[data-testid="panel-finding"][data-id="C1"]')).toContainText('judge record ignored on export fallback')
  await renderedText(section(page))
  await panel(page).getByTestId('panel-fallback-banner').scrollIntoViewIfNeeded()
  await attach(page, testInfo, 'panel-fallback')
})

test(`[scenario:panel-review-section] On the judged run the review section shows judge as the deciding reviewer (blocked) with the J1/J2 findings and their lanes, general and coverage labelled "advisory (the judge decided)"; the Sessions list has a row per seat (muse without a resume command) and a judge row with "claude --resume <id>" and no cd; no absolute path (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(nodePage(RUN_JUDGED, 'review'))
  const result = page.getByTestId('review-result')
  await expect(result).toHaveAttribute('data-judged', 'true')
  await expect(result.getByTestId('review-verdict')).toHaveAttribute('data-status', 'blocked')
  await expect(result.getByTestId('review-verdict-rule')).toContainText('Verdict of the judge for review attempt 1')
  await expect(page.getByTestId('review-blocked-by')).toHaveText('Blocked by judge (blocked the candidate).')
  const entries = page.getByTestId('reviewer-entry')
  expect(await attributes(entries, 'data-reviewer')).toEqual(['general', 'coverage', 'judge'])
  expect(await texts(entries.getByTestId('reviewer-role'))).toEqual(['advisory (the judge decided)', 'advisory (the judge decided)', 'deciding reviewer'])
  await expect(entries.nth(2).getByTestId('reviewer-verdict')).toHaveAttribute('data-status', 'blocked')
  const findings = result.getByTestId('finding')
  await expect(findings).toHaveCount(2)
  expect(await attributes(findings, 'data-reviewer')).toEqual(['judge', 'judge'])
  const messages = await texts(findings)
  expect(messages[0]).toContain('[J1 from general-1, C1, M1] settle does not wait for a seat relaunched on resume')
  expect(messages[1]).toContain('[J2 from coverage-1] No unit test for the judge-fallback banner')
  expect(await texts(findings.getByTestId('finding-worker'))).toEqual([expect.stringContaining('engine'), expect.stringContaining('viewer')])
  await renderedText(page.getByTestId('node-detail'))
  await attach(page, testInfo, 'panel-review-section')

  // The Sessions list on the run page: one row per seat, none with a resume command, and the judge's with the bare command.
  await page.goto(runPage(RUN_JUDGED))
  const sessions = page.getByTestId('sessions-section')
  await expect(sessions).toBeVisible()
  const panelRow = (key: string) => sessions.locator(`[data-testid="session-row"][data-session-key="${key}"]`)
  const labels = ['claude', 'gpt', 'muse'].map(name => `Panel · review · ${name}`)
  for (const [index, label] of labels.entries()) {
    await expect(panelRow(`panel:0:${index}`)).toContainText(label)
    await expect(panelRow(`panel:0:${index}`).getByTestId('session-resume')).toHaveCount(0)
  }
  const judgeRow = panelRow('panel:0:judge')
  await expect(judgeRow).toContainText('Panel · review · judge')
  await expect(judgeRow.getByTestId('session-resume-command')).toHaveText(`claude --resume ${JUDGE_SESSION}`)
  expect(await judgeRow.getByTestId('session-resume-command').innerText()).not.toContain('cd ')
  await renderedText(sessions)

  // The graph draws the built-in reviewers' cards and the panel's, never a judge card ([L12] B2): the judge is reached
  // through the Panel and Review surfaces above.
  for (const nodeId of ['reviewer-general', 'reviewer-coverage', 'panel']) await expect(graphNode(page, nodeId)).toHaveCount(1)
  await expect(graphNode(page, 'reviewer-judge')).toHaveCount(0)
  await expect(page.locator('[data-node-id="reviewer-judge"]')).toHaveCount(0)
})

test(`[scenario:panel-legacy] A run with a 1.0.0 report-only panel renders its Panel section as before: providers, findings, overlap and accepted marks, the report-only line, and no judge block (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(runUrl(RUN_PANEL_SUCCEEDED, undefined, UX_PANEL_WORKFLOW_ID))
  await openStepSheet(page, 'review')
  const body = section(page)
  await expect(body.getByTestId('panel-report-only')).toHaveText('Report-only: never changes the run\'s verdict')
  await expect(body.getByTestId('panel-judged-line')).toHaveCount(0)
  await expect(body.getByTestId('panels')).not.toHaveAttribute('data-version', /.*/)
  const legacy = body.locator('[data-testid="panel"][data-id="review-panel"]')
  await expect(legacy).not.toHaveAttribute('data-judged', /.*/)
  await expect(legacy.getByTestId('panel-headline').getByTestId('panel-counts')).toHaveText('3 finding(s), 1 accepted')
  await expect(legacy.getByTestId('panel-headline').getByTestId('panel-threshold')).toHaveText('accepted when raised by ≥2 providers')
  const f1 = legacy.getByTestId('panel-accepted').locator('[data-testid="panel-finding"][data-id="f1"]')
  await expect(f1).toHaveAttribute('data-accepted', 'true')
  await expect(f1.getByTestId('panel-overlap')).toHaveText('overlap ×2')
  expect(await texts(f1.getByTestId('panel-raised-provider'))).toEqual(['claude', 'openai-codex/gpt-6-sol'])
  await expect(legacy.getByTestId('panel-folded').locator('summary')).toHaveText('2 not accepted or unanchored')
  const providers = legacy.getByTestId('panel-provider')
  expect(await texts(providers.getByTestId('panel-provider-name'))).toEqual(['claude', 'openai-codex/gpt-6-sol', 'deepseek/deepseek-v4-pro'])
  expect(await texts(providers.getByTestId('panel-provider-status'))).toEqual(['ok', 'ok', 'timed out'])
  expect(await texts(providers.getByTestId('panel-cost'))).toEqual(['$0.021', 'subscription-covered', '—'])
  // Nothing of the judged panel appears on a report-only record.
  for (const id of ['panel-judge', 'panel-seat', 'judge-ruling', 'panel-fallback-banner', 'panel-unjudged']) await expect(body.getByTestId(id)).toHaveCount(0)
  await expect(graphNode(page, 'panel')).toHaveCount(1)
  await attach(page, testInfo, 'panel-legacy')
})

test(`[scenario:panel-phone] At 390 px the Panel section (seats, judge block, rulings with chips, fallback banner) reads in one column with no horizontal page scroll, and every new link and chip is at least 44 px tall (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 900 })
  for (const runId of [RUN_JUDGED_FALLBACK, RUN_JUDGED]) {
    await openPanelOnRunPage(page, runId)
    await expect(panel(page).getByTestId('panel-seat').first()).toBeVisible()
    if (runId === RUN_JUDGED_FALLBACK) await expect(panel(page).getByTestId('panel-fallback-banner')).toBeVisible()
    expect(await pageWidth(page), runId).toBeLessThanOrEqual(390)
    for (const box of [section(page), stepSheet(page).locator('.sh-body'), stepSheet(page)]) expect(await sidewaysOverflow(box), runId).toBeLessThanOrEqual(0)
    // One column: every seat and ruling card starts at the same left edge.
    const lefts = await Promise.all((await panel(page).locator('[data-testid="panel-seat"], [data-testid="judge-ruling"]').all()).map(async item => Math.round((await item.boundingBox())!.x)))
    expect(new Set(lefts).size, runId).toBe(1)
  }
  // Every chip and every new link or control of the judged section is at least 44 px tall.
  const targets = panel(page).locator('[data-testid="judge-source"], .panel-folded > summary')
  expect(await targets.count()).toBeGreaterThan(5)
  for (const target of await targets.all()) {
    await target.scrollIntoViewIfNeeded()
    const box = await target.boundingBox()
    expect(box!.height, await target.innerText()).toBeGreaterThanOrEqual(44)
  }
  await ruling(panel(page).getByTestId('panel-judge'), 'J1').getByTestId('judge-sources').scrollIntoViewIfNeeded()
  await attach(page, testInfo, 'panel-phone')
})
