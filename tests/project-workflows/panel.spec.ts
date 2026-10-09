/**
 * The multi-provider panel in the viewer (docs/PRD_MULTI_PROVIDER_PANEL.md 4.5, section 6 item 2, Appendix A): a run whose
 * export carries the panel record shows a Panel section on its run page (the report-only line; per panel a headline with the
 * stage, the finding and accepted counts and the overlap threshold; the accepted findings with severity, file:line, title,
 * detail, the providers that raised each and an overlap badge; the not-accepted and unanchored findings folded; each provider
 * with its transport, model, status and cost, `subscription-covered` for an openai-codex row); a pending panel says it runs
 * at its stage, a failed or timed-out one shows its error, a run with `panels` null (or an older export) has no section; the
 * section opens from the run page, in the review step's sheet (no graph node of its own this slice); a challenge-stage panel renders on the challenge view too; the
 * page follows the live record without a reload. Both phases: the worker phase serves `fixtures/ux-panel.ts` through the
 * mocks, the candidate phase seeds the same runs as 1.9.0 exports, one with a live `panel.json` beside the export section.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  CHALLENGE_F1_TITLE, CLAUDE_DIED, DEEPSEEK_TIMED_OUT, F2_TITLE, F3_TITLE, FAILED_ERROR, PANEL_RESULTS, PI_PARSE_FAILED, RUN_PANEL_CHALLENGE, RUN_PANEL_FAILED, RUN_PANEL_INVALID,
  RUN_PANEL_LIVE, RUN_PANEL_NULL, RUN_PANEL_OLD, RUN_PANEL_PENDING, RUN_PANEL_SUCCEEDED, RUN_PANEL_TIMED_OUT, TIMED_OUT_ERROR, UX_PANEL_WORKFLOW_ID, resultAfterProviders,
} from './fixtures/ux-panel.ts'
import { apiRun, attach, expectNoExecutionControls, fetchFromPage, graphNode, installHooks, openStep, openStepSheet, phase, renderedText, runUrl, stepSheet } from './support.ts'

installHooks()

const NOW = new Date('2025-10-04T12:30:00Z')
const runPage = (runId: string) => runUrl(runId, undefined, UX_PANEL_WORKFLOW_ID)
const nodePage = (runId: string, nodeId: string) => runUrl(runId, nodeId, UX_PANEL_WORKFLOW_ID)
const panelsApi = (runId: string) => `${apiRun(runId, UX_PANEL_WORKFLOW_ID)}/panels`
const section = (page: Page) => page.getByTestId('panel-section')
const panel = (page: Page, id: string) => section(page).locator(`[data-testid="panel"][data-id="${id}"]`)
const headline = (scope: Locator) => scope.getByTestId('panel-headline')
const finding = (scope: Locator, id: string) => scope.locator(`[data-testid="panel-finding"][data-id="${id}"]`)
const pageWidth = (page: Page) => page.evaluate(() => (globalThis as unknown as { document: { documentElement: { scrollWidth: number } } }).document.documentElement.scrollWidth)
/** How far an element's content reaches past its own box sideways (a scroll container hides it from the page width). */
const sidewaysOverflow = (target: Locator) => target.evaluate(element => (element as unknown as { scrollWidth: number; clientWidth: number }).scrollWidth - (element as unknown as { clientWidth: number }).clientWidth)
const attributes = async (items: Locator, name: string) => Promise.all((await items.all()).map(item => item.getAttribute(name)))
const texts = async (items: Locator) => Promise.all((await items.all()).map(item => item.innerText()))
/** The run page shows the panel record in the review step's sheet: this opens it. */
const openReviewSheet = (page: Page) => openStepSheet(page, 'review')
const REPORT_ONLY = 'Report-only: never changes the run\'s verdict'

/** An extra state of the section, attached beside the scenario's one screenshot under a name check-report does not read. */
async function attachState(page: Page, testInfo: Parameters<typeof attach>[1], name: string) {
  const image = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path: image, fullPage: true })
  await testInfo.attach(`state:${name}`, { path: image, contentType: 'image/png' })
}

/** The integrated run's section: Appendix A's panel with a third provider, f2 not accepted and f3 unanchored. */
async function expectSucceededSection(page: Page) {
  const body = section(page)
  await expect(body.getByTestId('panel-report-only')).toHaveText(REPORT_ONLY)
  const review = panel(page, 'review-panel')
  await expect(review).toHaveAttribute('data-stage', 'review')
  await expect(review).toHaveAttribute('data-status', 'succeeded')
  await expect(headline(review)).toContainText('Succeeded')
  await expect(headline(review).getByTestId('panel-stage')).toHaveText('review stage')
  await expect(headline(review).getByTestId('panel-counts')).toHaveText('3 finding(s), 1 accepted')
  await expect(headline(review).getByTestId('panel-threshold')).toHaveText('accepted when raised by ≥2 providers')
  // One card per accepted finding: f1, raised by both providers (an overlap), with severity, file:line, title and detail.
  const accepted = review.getByTestId('panel-accepted').getByTestId('panel-finding')
  await expect(accepted).toHaveCount(1)
  const f1 = finding(review.getByTestId('panel-accepted'), 'f1')
  await expect(f1).toHaveAttribute('data-severity', 'P1')
  await expect(f1.getByTestId('panel-severity')).toHaveText('P1')
  await expect(f1.getByTestId('panel-location')).toHaveText('packages/api/src/modules/claims/reconcile.ts:52')
  await expect(f1.getByTestId('panel-title')).toHaveText('mined set from non-final evidence')
  await expect(f1.getByTestId('panel-detail')).toHaveText('A reorg can strand a mined publication.')
  expect(await texts(f1.getByTestId('panel-raised-provider'))).toEqual(['claude', 'openai-codex/gpt-6-sol'])
  await expect(f1.getByTestId('panel-overlap')).toHaveText('overlap ×2')
  // The rest folded under one closed disclosure: f2 (one provider, not accepted), then f3 (unanchored).
  const folded = review.getByTestId('panel-folded')
  await expect(folded).not.toHaveAttribute('open', '')
  await expect(folded.locator('summary')).toHaveText('2 not accepted or unanchored')
  await folded.locator('summary').click()
  const rest = folded.getByTestId('panel-finding')
  expect(await attributes(rest, 'data-id')).toEqual(['f2', 'f3'])
  expect(await attributes(rest, 'data-unanchored')).toEqual(['false', 'true'])
  const f2 = finding(folded, 'f2')
  await expect(f2.getByTestId('panel-location')).toHaveText('packages/api/src/modules/claims/reconcile.ts:118')
  await expect(f2.getByTestId('panel-title')).toHaveText(F2_TITLE)
  expect(await texts(f2.getByTestId('panel-raised-provider'))).toEqual(['openai-codex/gpt-6-sol'])
  await expect(f2.getByTestId('panel-overlap')).toHaveCount(0)
  const f3 = finding(folded, 'f3')
  await expect(f3.getByTestId('panel-location')).toHaveText('.github/workflows/ci.yml')
  await expect(f3.getByTestId('panel-title')).toHaveText(F3_TITLE)
  await expect(f3.getByTestId('panel-unanchored')).toBeVisible()
  // Each provider with its transport, model, status and cost: the dollar estimate for a metered provider, subscription-covered
  // for the openai-codex row (the record keeps pi's 0.0047 estimate, never shown), a dash for one that recorded no cost.
  const providers = review.getByTestId('panel-provider')
  await expect(providers).toHaveCount(3)
  expect(await attributes(providers, 'data-transport')).toEqual(['claude', 'pi', 'pi'])
  expect(await attributes(providers, 'data-status')).toEqual(['ok', 'ok', 'timed_out'])
  expect(await texts(providers.getByTestId('panel-provider-name'))).toEqual(['claude', 'openai-codex/gpt-6-sol', 'deepseek/deepseek-v4-pro'])
  expect(await texts(providers.getByTestId('panel-provider-status'))).toEqual(['ok', 'ok', 'timed out'])
  expect(await texts(providers.getByTestId('panel-cost'))).toEqual(['$0.021', 'subscription-covered', '—'])
  await expect(providers.nth(0)).toContainText('transport claude (default model) · effort high')
  await expect(providers.nth(1)).toContainText('transport pi')
  await expect(providers.nth(1)).not.toContainText('0.0047')
  await expect(providers.nth(2).getByTestId('panel-provider-error')).toHaveText(`Error: ${DEEPSEEK_TIMED_OUT}`)
  await expect(review.getByTestId('panel-error')).toHaveCount(0)
  await renderedText(body)
}

test(`[scenario:panel-section] A run whose export carries the Appendix A panels record shows the Panel section on its run page: the report-only line, the headline with stage, counts and threshold, accepted findings with severity, file:line, title, detail, raising providers and an overlap badge, the rest folded, each provider with transport, model, status and cost (subscription-covered for openai-codex); pending, failed, timed-out and absent panels; no graph node; no overflow at 390 px (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.clock.install({ time: NOW })
  await page.goto(runPage(RUN_PANEL_SUCCEEDED))
  // The section opens from the run page in the review step's sheet: there is no graph node of its own this slice.
  await expect(graphNode(page, 'review')).toHaveCount(1)
  await expect(section(page)).toHaveCount(0)
  await openReviewSheet(page)
  await expect(section(page)).toBeVisible()
  await expect(section(page).locator('h4')).toHaveText('Panel')
  await expect(stepSheet(page).getByTestId('panel-section')).toHaveCount(1)
  await expect(page.locator('[data-testid="workflow-graph"] [data-graph-node^="panel"]')).toHaveCount(0)
  await expect(page.getByTestId('attack-section')).toHaveCount(0)
  await expectSucceededSection(page)
  await expect(section(page).getByTestId('panel-source')).toHaveAttribute('data-source', 'export')
  await expectNoExecutionControls(page)
  await attach(page, testInfo, 'panel-section')

  // At 390 px nothing overflows, the folded findings and the provider rows included.
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto(runPage(RUN_PANEL_SUCCEEDED))
  await openReviewSheet(page)
  await expect(headline(panel(page, 'review-panel'))).toContainText('1 accepted')
  await section(page).getByTestId('panel-folded').locator('summary').click()
  await expect(section(page).getByTestId('panel-provider').nth(2)).toBeVisible()
  expect(await pageWidth(page)).toBeLessThanOrEqual(390)
  // The section lives in the step sheet, whose body scrolls: nothing may scroll sideways inside it either.
  for (const box of [section(page), stepSheet(page).locator('.sh-body'), stepSheet(page)]) expect(await sidewaysOverflow(box)).toBeLessThanOrEqual(0)
  await attachState(page, testInfo, 'panel-section-390')
  await page.setViewportSize({ width: 1440, height: 900 })

  // A pending panel says it runs at its stage; its providers are pending.
  await page.goto(runPage(RUN_PANEL_PENDING))
  await openReviewSheet(page)
  await expect(headline(panel(page, 'review-panel'))).toContainText('Pending: runs at the review stage')
  await expect(headline(panel(page, 'review-panel')).getByTestId('panel-counts')).toHaveCount(0)
  await expect(section(page).getByTestId('panel-pending')).toHaveText('The panel runs at the review stage, beside the reviewers; nothing has run yet.')
  await expect(section(page).getByTestId('panel-finding')).toHaveCount(0)
  expect(await texts(section(page).getByTestId('panel-provider-status'))).toEqual(['pending', 'pending'])
  await attachState(page, testInfo, 'panel-pending')

  // A failed panel shows its error; its providers show that they died or answered no findings JSON.
  await page.goto(runPage(RUN_PANEL_FAILED))
  await openReviewSheet(page)
  await expect(headline(panel(page, 'review-panel'))).toContainText('Failed')
  await expect(headline(panel(page, 'review-panel')).getByTestId('panel-counts')).toHaveText('0 finding(s), 0 accepted')
  await expect(section(page).getByTestId('panel-error')).toHaveText(`The panel failed: ${FAILED_ERROR}`)
  const failedProviders = section(page).getByTestId('panel-provider')
  expect(await attributes(failedProviders, 'data-status')).toEqual(['error', 'parse_failed'])
  expect(await texts(failedProviders.getByTestId('panel-provider-status'))).toEqual(['failed', 'parse failed'])
  await expect(failedProviders.nth(0).getByTestId('panel-provider-error')).toHaveText(`Error: ${CLAUDE_DIED}`)
  await expect(failedProviders.nth(1).getByTestId('panel-provider-error')).toHaveText(`Error: ${PI_PARSE_FAILED}`)
  // A timed-out panel shows its error; every provider timed out.
  await page.goto(runPage(RUN_PANEL_TIMED_OUT))
  await openReviewSheet(page)
  await expect(headline(panel(page, 'review-panel'))).toContainText('Timed out')
  await expect(section(page).getByTestId('panel-error')).toHaveText(`The panel timed out: ${TIMED_OUT_ERROR}`)
  expect(await texts(section(page).getByTestId('panel-provider-status'))).toEqual(['timed out', 'timed out'])
  await renderedText(section(page))

  // A run with `panels` null has no section; so has a record unreadable both live and in the export, and a 1.8.0 export.
  for (const runId of [RUN_PANEL_NULL, RUN_PANEL_INVALID, RUN_PANEL_OLD]) {
    await page.goto(runPage(runId))
    await expect(page.getByTestId('run-board')).toBeVisible()
    await expect(graphNode(page, 'review')).toHaveCount(1)
    await openReviewSheet(page)
    await expect(stepSheet(page).getByTestId('sheet-events')).toBeVisible()
    await expect(section(page)).toHaveCount(0)
    await expect(page.getByTestId('projects-error')).toHaveCount(0)
  }
})

test(`[scenario:panel-challenge-and-live] A challenge-stage panel renders on the challenge view as well as the run page; the live panel.json wins over the export whenever it is valid and a run without one shows the export's; a panel moving from running to succeeded shows its new accepted counts within one poll, without a reload (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.clock.install({ time: NOW })

  // The run page shows both panels of the record (in the review step's sheet); the challenge node's page shows the
  // challenge-stage one, listed in its index.
  await page.goto(runPage(RUN_PANEL_CHALLENGE))
  await openReviewSheet(page)
  await expect(section(page)).toBeVisible()
  expect(await attributes(section(page).getByTestId('panel'), 'data-stage')).toEqual(['challenge', 'review'])
  await expect(headline(panel(page, 'review-panel'))).toContainText('Pending: runs at the review stage')
  await openStep(page, 'challenge')
  await expect(page.getByTestId('section-index').locator('[data-section="panel"]')).toContainText('Panel')
  await expect(page.getByTestId('challenge')).toBeVisible()
  await expect(section(page).getByTestId('panel')).toHaveCount(1)
  const challenge = panel(page, 'challenge-panel')
  await expect(challenge).toHaveAttribute('data-stage', 'challenge')
  await expect(section(page).getByTestId('panel-report-only')).toHaveText(REPORT_ONLY)
  await expect(headline(challenge)).toContainText('Succeeded')
  await expect(headline(challenge).getByTestId('panel-stage')).toHaveText('challenge stage')
  await expect(headline(challenge).getByTestId('panel-counts')).toHaveText('2 finding(s), 1 accepted')
  await expect(headline(challenge).getByTestId('panel-threshold')).toHaveText('accepted when raised by every provider (2)')
  const f1 = finding(challenge.getByTestId('panel-accepted'), 'f1')
  await expect(f1.getByTestId('panel-location')).toHaveText('docs/PRD_MULTI_PROVIDER_PANEL.md:150')
  await expect(f1.getByTestId('panel-title')).toHaveText(CHALLENGE_F1_TITLE)
  await expect(f1.getByTestId('panel-overlap')).toHaveText('overlap ×2')
  await expect(challenge.getByTestId('panel-folded').locator('summary')).toHaveText('1 not accepted or unanchored')
  expect(await texts(challenge.getByTestId('panel-cost'))).toEqual(['$0.021', 'subscription-covered'])
  await renderedText(section(page))
  await attachState(page, testInfo, 'panel-challenge-view')
  // Opened directly, the challenge node's page shows the same section.
  await page.goto(nodePage(RUN_PANEL_CHALLENGE, 'challenge'))
  await expect(section(page).getByTestId('panel')).toHaveCount(1)

  const requests: string[] = []
  page.on('request', request => { if (new URL(request.url()).pathname === panelsApi(RUN_PANEL_LIVE)) requests.push(request.url()) })
  if (phase === 'worker') {
    // The mocked record as the controller rewrites it: both providers answer and f1 is accepted.
    let current = PANEL_RESULTS[RUN_PANEL_LIVE]
    await page.route(url => url.pathname === panelsApi(RUN_PANEL_LIVE), route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(current) }))
    await page.goto(runPage(RUN_PANEL_LIVE))
    await openReviewSheet(page)
    const live = panel(page, 'review-panel')
    await expect(headline(live)).toContainText('Running')
    await expect(headline(live).getByTestId('panel-counts')).toHaveText('0 finding(s), 0 accepted')
    await expect(section(page).getByTestId('panel-source')).toHaveAttribute('data-source', 'live')
    expect(await texts(live.getByTestId('panel-provider-status'))).toEqual(['running', 'running'])
    await expect(live.getByTestId('panel-accepted')).toHaveCount(0)
    // A marker on the window survives only if the page is not reloaded.
    await page.evaluate(() => { (globalThis as unknown as Record<string, unknown>).__panelMarker = 'kept' })
    const before = requests.length
    current = resultAfterProviders()
    await page.clock.runFor(5_000)
    await expect(headline(live)).toContainText('Succeeded')
    await expect(headline(live).getByTestId('panel-counts')).toHaveText('1 finding(s), 1 accepted')
    await expect(finding(live.getByTestId('panel-accepted'), 'f1').getByTestId('panel-overlap')).toHaveText('overlap ×2')
    expect(await texts(live.getByTestId('panel-cost'))).toEqual(['$0.021', 'subscription-covered'])
    expect(await page.evaluate(() => (globalThis as unknown as Record<string, unknown>).__panelMarker)).toBe('kept')
    expect(requests.length).toBe(before + 1)
    await attach(page, testInfo, 'panel-challenge-and-live')
    return
  }
  // Candidate, against the real API: the run's live panel.json (running) is readable and valid, so it is served over the
  // export's pending record, whatever either file's mtime says.
  await page.goto(runPage(RUN_PANEL_LIVE))
  await openReviewSheet(page)
  await expect(headline(panel(page, 'review-panel'))).toContainText('Running')
  await expect(section(page).getByTestId('panel-source')).toHaveAttribute('data-source', 'live')
  const live = JSON.parse((await fetchFromPage(page, panelsApi(RUN_PANEL_LIVE))).text) as { source: string; contract_version: string; node_id?: string; panels: { status: string }[] }
  expect([live.source, live.contract_version, live.node_id, live.panels[0].status]).toEqual(['live', '1.9.0', undefined, 'running'])
  // It keeps reading it while the run works: the next poll asks again.
  const before = requests.length
  await page.clock.runFor(5_000)
  await expect.poll(() => requests.length).toBe(before + 1)
  await attach(page, testInfo, 'panel-challenge-and-live')
  // A run without a live file shows the export's record.
  await page.goto(runPage(RUN_PANEL_SUCCEEDED))
  await openReviewSheet(page)
  await expect(section(page).getByTestId('panel-source')).toHaveAttribute('data-source', 'export')
  const exported = JSON.parse((await fetchFromPage(page, panelsApi(RUN_PANEL_SUCCEEDED))).text) as { source: string; panels: { status: string }[] }
  expect([exported.source, exported.panels[0].status]).toEqual(['export', 'succeeded'])
  await page.goto(runPage(RUN_PANEL_PENDING))
  await openReviewSheet(page)
  await expect(section(page).getByTestId('panel-source')).toHaveAttribute('data-source', 'export')
  await expect(headline(panel(page, 'review-panel'))).toContainText('Pending: runs at the review stage')
  // A 1.8.0 export beside a live panel.json: not recorded, no section, exactly as today.
  const old = await fetchFromPage(page, panelsApi(RUN_PANEL_OLD))
  expect([old.status, (JSON.parse(old.text) as { error: { code: string } }).error.code]).toEqual([404, 'PANELS_NOT_FOUND'])
  await page.goto(runPage(RUN_PANEL_OLD))
  await expect(page.getByTestId('run-board')).toBeVisible()
  await openReviewSheet(page)
  await expect(section(page)).toHaveCount(0)
})
