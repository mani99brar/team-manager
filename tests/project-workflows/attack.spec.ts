/**
 * The attack pass in the viewer (docs/PRD_ATTACK_PASS.md 4.6, section 6 items 8 and 9, Appendix A): a run whose export carries
 * the pass's record shows an Attack pass section on its run page, in the attack step's sheet (the report-only line, the
 * status and counts, the verified findings as cards with their label or the label command, the rest folded, the attackers
 * and the out-of-reach notes); a pending pass says it runs at the review step, a failed or refused one shows its error, a
 * run without a pass has no section; the sheet's "Open step page" shows the same section on the attack node's page; the
 * page follows the live record without a reload. Both phases: the worker
 * phase serves `fixtures/ux-attack.ts` through the mocks, the candidate phase seeds the same runs as 1.8.0 exports, some with
 * a live `attack.json` beside the export section.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  A3_TITLE, A4_TITLE, A5_TITLE, ATTACK_RESULTS, INVALID_ERROR, REFUSED_ERROR, RUN_ATTACK_FAILED, RUN_ATTACK_INVALID, RUN_ATTACK_LIVE, RUN_ATTACK_PENDING, RUN_ATTACK_REFUSED,
  RUN_ATTACK_VERIFIED, RUN_ATTACK_VERIFIED_PLAIN, TIMED_OUT_ERROR, UX_ATTACK_WORKFLOW_ID, resultAfterSkeptic,
} from './fixtures/ux-attack.ts'
import { apiRun, attach, expectNoExecutionControls, fetchFromPage, graphNode, installHooks, nodeDetail, openStep, openStepSheet, phase, renderedText, runUrl, stepSheet } from './support.ts'

installHooks()

const NOW = new Date('2025-10-05T12:30:00Z')
const runPage = (runId: string) => runUrl(runId, undefined, UX_ATTACK_WORKFLOW_ID)
const nodePage = (runId: string) => runUrl(runId, 'attack', UX_ATTACK_WORKFLOW_ID)
const attackApi = (runId: string) => `${apiRun(runId, UX_ATTACK_WORKFLOW_ID)}/attack`
const section = (page: Page) => page.getByTestId('attack-section')
const headline = (page: Page) => section(page).getByTestId('attack-headline')
const finding = (scope: Locator, id: string) => scope.locator(`[data-testid="attack-finding"][data-id="${id}"]`)
const pageWidth = (page: Page) => page.evaluate(() => (globalThis as unknown as { document: { documentElement: { scrollWidth: number } } }).document.documentElement.scrollWidth)
/** How far an element's content reaches past its own box sideways (a scroll container hides it from the page width). */
const sidewaysOverflow = (target: Locator) => target.evaluate(element => (element as unknown as { scrollWidth: number; clientWidth: number }).scrollWidth - (element as unknown as { clientWidth: number }).clientWidth)
const attributes = async (items: Locator, name: string) => Promise.all((await items.all()).map(item => item.getAttribute(name)))
/** The run page shows the attack pass in the attack step's sheet: this opens it. */
const openAttackSheet = (page: Page) => openStepSheet(page, 'attack')
const LABEL_COMMAND = '"$PY" -m workflow attack-label "$RUN" A-3 --label real|false|out-of-scope --by operator'

/** An extra state of the section, attached beside the scenario's one screenshot under a name check-report does not read. */
async function attachState(page: Page, testInfo: Parameters<typeof attach>[1], name: string) {
  const image = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path: image, fullPage: true })
  await testInfo.attach(`state:${name}`, { path: image, contentType: 'image/png' })
}

/** The verified run's section, wherever it is shown: the run page or the attack node's page. */
async function expectVerifiedSection(page: Page) {
  const body = section(page)
  await expect(body.getByTestId('attack-report-only')).toHaveText('Report-only: never changes the run\'s verdict')
  await expect(headline(page)).toHaveText('Succeeded · 5 finding(s), 4 reproduced, 2 verified')
  await expect(headline(page)).toHaveAttribute('data-status', 'succeeded')
  // One card per verified finding, by the severity shown: A-1 (P1, labelled real), A-3 (the skeptic's P1, the attacker's P0).
  const cards = body.getByTestId('attack-verified').getByTestId('attack-finding')
  await expect(cards).toHaveCount(2)
  expect(await attributes(cards, 'data-id')).toEqual(['A-1', 'A-3'])
  const a1 = finding(body.getByTestId('attack-verified'), 'A-1')
  await expect(a1).toHaveAttribute('data-label', 'real')
  await expect(a1.getByTestId('attack-severity')).toHaveText('P1')
  await expect(a1).toContainText('A claim\'s provenance can name another account')
  await expect(a1).toContainText('files a claim whose provenance names another account')
  await expect(a1.getByTestId('attack-requirement')).toHaveText('SEC-CLAIM-03: the server derives a claim\'s author from the session, never from the request body.')
  await expect(a1.getByTestId('attack-test-file')).toHaveText('attack/auth-funds/A-1.test.ts')
  await expect(a1.getByTestId('attack-label')).toContainText('real · review found: no')
  await expect(a1.getByTestId('attack-label-command')).toHaveCount(0)
  const a3 = finding(body.getByTestId('attack-verified'), 'A-3')
  await expect(a3).toHaveAttribute('data-severity', 'P1')
  await expect(a3.getByTestId('attack-severity')).toHaveText('P1')
  await expect(a3).toContainText(A3_TITLE)
  await expect(a3).toContainText('attacker said P0')
  await expect(a3.getByTestId('attack-requirement')).toHaveText('No requirement quoted')
  await expect(a3.getByTestId('attack-label')).toContainText('Unlabelled')
  await expect(a3.getByTestId('attack-label-command')).toHaveText(LABEL_COMMAND)
  // The rest folded under one closed disclosure: unjudged, refuted, not reproduced, each with its status and re-run reason.
  const folded = body.getByTestId('attack-folded')
  await expect(folded).not.toHaveAttribute('open', '')
  await expect(folded.locator('summary')).toHaveText('3 not verified: reproduced but not judged, refuted or not reproduced')
  await folded.locator('summary').click()
  const rest = folded.getByTestId('attack-finding')
  expect(await attributes(rest, 'data-id')).toEqual(['A-5', 'A-4', 'A-2'])
  expect(await attributes(rest, 'data-status')).toEqual(['unjudged', 'refuted', 'not_reproduced'])
  await expect(finding(folded, 'A-5')).toContainText(`${A5_TITLE} · reproduced, not judged`)
  await expect(finding(folded, 'A-4')).toContainText(`${A4_TITLE} · refuted by the skeptic`)
  await expect(finding(folded, 'A-4')).toContainText('skeptic: The test signs in as a supervisor')
  await expect(finding(folded, 'A-2')).toContainText('not reproduced — re-run: the test passed on the clean copy')
  // The attackers with angle, status, cost and duration; the out-of-reach notes.
  const attackers = body.getByTestId('attack-attacker')
  expect(await attributes(attackers, 'data-angle')).toEqual(['auth-funds', 'inputs-state'])
  expect(await attributes(attackers, 'data-status')).toEqual(['succeeded', 'timed_out'])
  await expect(attackers.nth(0)).toContainText('cost $7.42 · took 39m32s · skeptic succeeded ($1.10)')
  await expect(attackers.nth(1)).toContainText('timed out')
  await expect(attackers.nth(1)).toContainText(`cost $15.00 · took 1h00m · skeptic not run`)
  await expect(attackers.nth(1)).toContainText(`Error: ${TIMED_OUT_ERROR}`)
  await expect(body.getByTestId('attack-out-of-reach')).toContainText('auth-funds: SEC-TX-02 needs a real chain reorganisation; the in-process harness has none.')
  await renderedText(body)
}

test(`[scenario:attack-section] A run with an attack pass shows the report-only section: status and counts, verified cards with the skeptic's severity and the label or its command, the rest folded, attackers and out-of-reach notes; pending, failed, refused and absent passes; the graph's attack node opens it; no overflow at 390 px (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.clock.install({ time: NOW })
  await page.goto(runPage(RUN_ATTACK_VERIFIED))
  // The run page shows no section until the attack step's sheet is open; the section lives in that sheet, before its events.
  await expect(graphNode(page, 'attack')).toHaveCount(1)
  await expect(section(page)).toHaveCount(0)
  await openAttackSheet(page)
  await expect(section(page)).toBeVisible()
  await expect(section(page).locator('h4')).toHaveText('Attack pass')
  await expect(stepSheet(page).getByTestId('attack-section')).toHaveCount(1)
  await expectVerifiedSection(page)
  // The graph keeps its legend and draws the attack node beside the review (the same column, the next row).
  await expect(graphNode(page, 'attack')).toHaveCount(1)
  const [review, attack] = await Promise.all([graphNode(page, 'review').boundingBox(), graphNode(page, 'attack').boundingBox()])
  expect(Math.round(attack!.x)).toBe(Math.round(review!.x))
  await expectNoExecutionControls(page)
  await attach(page, testInfo, 'attack-section')

  // The sheet's "Open step page" opens the same section on the attack node's own page, listed in the section index.
  await openStep(page, 'attack')
  await expect(page.locator('#node-detail-title')).toHaveText(/Attack pass/)
  await expect(page.getByTestId('section-index').locator('[data-section="attack"]')).toHaveText('Attack pass')
  await expectVerifiedSection(page)
  await expect(nodeDetail(page).getByTestId('node-result-none')).toHaveCount(0)

  // At 390 px nothing overflows, the folded findings and the label command included.
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto(runPage(RUN_ATTACK_VERIFIED))
  await openAttackSheet(page)
  await expect(headline(page)).toContainText('2 verified')
  await section(page).getByTestId('attack-folded').locator('summary').click()
  await expect(section(page).getByTestId('attack-label-command')).toBeVisible()
  expect(await pageWidth(page)).toBeLessThanOrEqual(390)
  // The section lives in the step sheet, whose body scrolls: nothing may scroll sideways inside it either.
  for (const box of [section(page), stepSheet(page).locator('.sh-body'), stepSheet(page)]) expect(await sidewaysOverflow(box)).toBeLessThanOrEqual(0)
  await attachState(page, testInfo, 'attack-section-390')
  await page.setViewportSize({ width: 1440, height: 900 })

  // A pending pass says it runs at the review step.
  await page.goto(runPage(RUN_ATTACK_PENDING))
  await openAttackSheet(page)
  await expect(headline(page)).toHaveText('Pending: runs at the review step')
  await expect(section(page).getByTestId('attack-pending')).toHaveText('The attack pass runs at the review step, beside the reviewers; nothing has run yet.')
  await expect(section(page).getByTestId('attack-finding')).toHaveCount(0)
  await attachState(page, testInfo, 'attack-pending')
  // Opened directly, the pending run's attack node page shows the same pending section.
  await page.goto(nodePage(RUN_ATTACK_PENDING))
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'attack')
  await expect(section(page).getByTestId('attack-pending')).toBeVisible()

  // A failed or refused pass shows its error.
  await page.goto(runPage(RUN_ATTACK_FAILED))
  await openAttackSheet(page)
  await expect(headline(page)).toHaveText('Failed · 0 finding(s), 0 reproduced, 0 verified')
  await expect(section(page).getByTestId('attack-error')).toHaveText(`The pass failed: ${INVALID_ERROR}`)
  await page.goto(runPage(RUN_ATTACK_REFUSED))
  await openAttackSheet(page)
  await expect(headline(page)).toHaveText('Refused · 0 finding(s), 0 reproduced, 0 verified')
  await expect(section(page).getByTestId('attack-error')).toHaveText(`The pass was refused: ${REFUSED_ERROR}`)
  await renderedText(section(page))

  // A record that is unreadable both live and in the export is not recorded, never an error page.
  await page.goto(runPage(RUN_ATTACK_INVALID))
  await openAttackSheet(page)
  await expect(section(page).getByTestId('attack-none')).toBeVisible()

  // A run without a pass (export 1.8.0, `attack: null`) has no section, no attack node and asks nothing.
  const asked: string[] = []
  page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/attack')) asked.push(request.url()) })
  await page.goto(runPage(RUN_ATTACK_VERIFIED_PLAIN))
  await expect(page.getByTestId('run-board')).toBeVisible()
  await expect(graphNode(page, 'review')).toHaveCount(1)
  await expect(graphNode(page, 'attack')).toHaveCount(0)
  await expect(section(page)).toHaveCount(0)
  // Not in the review step's sheet either, where an attack pass would sit beside.
  await openStepSheet(page, 'review')
  await expect(stepSheet(page).getByTestId('sheet-events')).toBeVisible()
  await expect(section(page)).toHaveCount(0)
  expect(asked).toEqual([])
})

test(`[scenario:attack-live] The page follows the live record: the live attack.json wins over the export, and a pass moving from running to succeeded shows its new counts within one poll, without a reload (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.clock.install({ time: NOW })
  const requests: string[] = []
  page.on('request', request => { if (new URL(request.url()).pathname === attackApi(RUN_ATTACK_LIVE)) requests.push(request.url()) })
  if (phase === 'worker') {
    // The mocked record as the controller rewrites it: the skeptic ends and verifies A-1.
    let current = ATTACK_RESULTS[RUN_ATTACK_LIVE]
    await page.route(url => url.pathname === attackApi(RUN_ATTACK_LIVE), route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(current) }))
    await page.goto(runPage(RUN_ATTACK_LIVE))
    await openAttackSheet(page)
    await expect(headline(page)).toHaveText('Running · 2 finding(s), 1 reproduced, 0 verified')
    await expect(section(page).getByTestId('attack-source')).toHaveAttribute('data-source', 'live')
    await expect(section(page).getByTestId('attack-verified')).toHaveCount(0)
    // A-2's re-run is still owed on this live record (rerun null, decisions L15): the folded line says so, never throws.
    const folded = section(page).getByTestId('attack-folded')
    await folded.locator('summary').click()
    await expect(finding(folded, 'A-2')).toContainText('not reproduced — re-run pending')
    // A marker on the window survives only if the page is not reloaded.
    await page.evaluate(() => { (globalThis as unknown as Record<string, unknown>).__attackMarker = 'kept' })
    const before = requests.length
    current = resultAfterSkeptic()
    await page.clock.runFor(5_000)
    await expect(headline(page)).toHaveText('Succeeded · 2 finding(s), 1 reproduced, 1 verified')
    // The owed re-run has landed in this poll: A-2 now names its reason instead of "re-run pending".
    await expect(finding(section(page).getByTestId('attack-folded'), 'A-2')).toContainText('re-run: the test passed on the clean copy')
    await expect(finding(section(page).getByTestId('attack-verified'), 'A-1')).toHaveAttribute('data-label', 'unlabelled')
    await expect(section(page).getByTestId('attack-label-command')).toHaveText('"$PY" -m workflow attack-label "$RUN" A-1 --label real|false|out-of-scope --by operator')
    expect(await page.evaluate(() => (globalThis as unknown as Record<string, unknown>).__attackMarker)).toBe('kept')
    expect(requests.length).toBe(before + 1)
    await attach(page, testInfo, 'attack-live')
    return
  }
  // Candidate: the run's live attack.json (running) is newer than its export's pending record; the live one is served.
  await page.goto(runPage(RUN_ATTACK_LIVE))
  await openAttackSheet(page)
  await expect(headline(page)).toHaveText('Running · 2 finding(s), 1 reproduced, 0 verified')
  await expect(section(page).getByTestId('attack-source')).toHaveAttribute('data-source', 'live')
  const live = JSON.parse((await fetchFromPage(page, attackApi(RUN_ATTACK_LIVE))).text) as { source: string; status: string; contract_version: string; settings: { secret_files: string[] } }
  expect([live.source, live.status, live.contract_version, live.settings.secret_files]).toEqual(['live', 'running', '1.8.0', ['<path>']])
  // It keeps reading it while the run works: the next poll asks again.
  const before = requests.length
  await page.clock.runFor(5_000)
  await expect.poll(() => requests.length).toBe(before + 1)
  await attach(page, testInfo, 'attack-live')
  // A run without a live file shows the export's record.
  await page.goto(runPage(RUN_ATTACK_VERIFIED))
  await openAttackSheet(page)
  await expect(section(page).getByTestId('attack-source')).toHaveAttribute('data-source', 'export')
  const exported = JSON.parse((await fetchFromPage(page, attackApi(RUN_ATTACK_VERIFIED))).text) as { source: string; status: string }
  expect([exported.source, exported.status]).toEqual(['export', 'succeeded'])
  await page.goto(runPage(RUN_ATTACK_PENDING))
  await openAttackSheet(page)
  await expect(section(page).getByTestId('attack-source')).toHaveAttribute('data-source', 'export')
  await expect(headline(page)).toHaveText('Pending: runs at the review step')
})
