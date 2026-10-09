/**
 * The review sidecar in the viewer (docs/PRD_REVIEW_SIDECAR.md 4.9 and section 6): its node page opens on one headline with
 * the pass, open-finding, message and last-pass counts, then the open findings (P0/P1 first), escalations, the closed ones,
 * the messages each lane received, the passes and the handoff, History last; it follows the ledger live while the workers
 * run and stops reading it once the run has finished; on the run page it is an agent card in the launch column that never
 * takes the Now banner from a lane. Both phases:
 * the worker phase serves `fixtures/ux-sidecar.ts` through the mocks, the candidate phase seeds the same runs, the live
 * `sidecar.ledger.json` beside an older export section.
 */
import { test, expect, type Locator, type Page, type Request } from '@playwright/test'
import {
  ESCALATION_TEXT, HANDOFF_GAP, HANDOFF_UNRESOLVED, PANE_BUSY_TEXT, RUN_SIDECAR, RUN_SIDECAR_FROZEN, RUN_SIDECAR_INTEGRATED, RUN_SIDECAR_NO_LEDGER, RUN_SIDECAR_PLAIN, S3_PROBLEM, S4_RESOLUTION,
  SIDECAR_LEDGERS, UX_SIDECAR_WORKFLOW_ID, ledgerAfterNextPass,
} from './fixtures/ux-sidecar.ts'
import { apiRun, attach, expectNoExecutionControls, fetchFromPage, graphNode, installHooks, nodeDetail, openStepSheet, phase, renderedText, runUrl, stepSheet } from './support.ts'

installHooks()

/** Four minutes after the live ledger's last pass (13:50:00 UTC). */
const NOW = new Date('2026-10-01T13:54:00Z')
const nodeUrl = (runId: string) => runUrl(runId, 'sidecar', UX_SIDECAR_WORKFLOW_ID)
const runPage = (runId: string) => runUrl(runId, undefined, UX_SIDECAR_WORKFLOW_ID)
const sidecarApi = (runId: string) => `${apiRun(runId, UX_SIDECAR_WORKFLOW_ID)}/sidecar`
const headline = (page: Page) => page.getByTestId('sidecar-headline')
const section = (page: Page, id: string) => page.getByTestId(id)
const findingsIn = (scope: Locator) => scope.getByTestId('sidecar-finding')
const pageWidth = (page: Page) => page.evaluate(() => (globalThis as unknown as { document: { documentElement: { scrollWidth: number } } }).document.documentElement.scrollWidth)
/** Whether `first` comes before `second` in the document. */
const precedes = async (first: Locator, second: Locator) => first.evaluate((a, b) => Boolean((a as unknown as { compareDocumentPosition: (other: unknown) => number }).compareDocumentPosition(b) & 4), await second.elementHandle())
const display = (target: Locator) => target.evaluate(element => (globalThis as unknown as { getComputedStyle: (target: unknown) => { display: string } }).getComputedStyle(element).display)
const attributes = async (items: Locator, name: string) => Promise.all((await items.all()).map(item => item.getAttribute(name)))

/**
 * The ledger poll stops with the run: the node page of a run that succeeded reads the ledger when it opens, and advancing
 * the clock well past several poll intervals sends no further request (a running run's next poll is asserted just before).
 */
async function expectFinishedRunNotPolled(page: Page) {
  const asked: string[] = []
  const track = (request: Request) => { if (new URL(request.url()).pathname === sidecarApi(RUN_SIDECAR_INTEGRATED)) asked.push(request.url()) }
  page.on('request', track)
  await page.goto(nodeUrl(RUN_SIDECAR_INTEGRATED))
  await expect(page.getByTestId('node-header').getByText('Succeeded', { exact: true })).toBeVisible()
  await expect(headline(page)).toContainText('2 of 7 passes failed · 3 open (2 P1)')
  await expect(section(page, 'sidecar-handoff').locator('[data-list="unresolved"] li')).toHaveCount(3)
  // The page read it (twice at most: React's development mount runs the effect twice, aborting the first).
  const settled = asked.length
  expect(settled).toBeGreaterThanOrEqual(1)
  await page.clock.runFor(30_000)
  // Real time for a request the fake clock would have fired to leave the page.
  await page.waitForTimeout(1_000)
  expect(asked).toHaveLength(settled)
  page.off('request', track)
}

test(`[scenario:sidecar-node] The sidecar page opens on one headline, then open findings P0/P1 first, escalations, resolved, messages with their status, passes and the handoff, History last; read-only and no overflow at 390 px (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.clock.install({ time: NOW })
  await page.goto(nodeUrl(RUN_SIDECAR))
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'sidecar')
  await expect(page.locator('#node-detail-title')).toHaveText(/Review sidecar/)
  await expect(page.getByTestId('node-executor')).toHaveAttribute('data-executor', 'agent')

  // One headline, in the first screen, above the section index: passes (2 failed), open by severity, messages, last pass.
  await expect(headline(page)).toHaveCount(1)
  await expect(headline(page)).toHaveText(/^2 of 6 passes failed · 3 open \(2 P1\) · 2 messages delivered, 1 undeliverable, 1 refused · last pass 13:50( UTC)? \(4 min ago\)$/)
  expect((await headline(page).boundingBox())!.y).toBeLessThan(900)
  expect(await precedes(headline(page), page.getByTestId('section-index'))).toBe(true)

  // Open: P1s first, then by id; each card names its lane, file:locator, revision, problem, evidence and remedy, and its messages.
  const open = findingsIn(section(page, 'sidecar-open'))
  await expect(open).toHaveCount(3)
  expect(await attributes(open, 'data-id')).toEqual(['S-1', 'S-3', 'S-2'])
  expect(await attributes(open, 'data-severity')).toEqual(['P1', 'P1', 'P2'])
  expect(await attributes(open, 'data-disposition')).toEqual(['fix_reported', 'open', 'open'])
  expect(await attributes(open, 'data-lane')).toEqual(['engine', 'engine', 'viewer'])
  const s3 = open.nth(1)
  await expect(s3).toContainText('engine')
  await expect(s3).toContainText('workflow/sidecar.py:deliver_messages')
  await expect(s3).toContainText('c0ffee1')
  await expect(s3).toContainText(S3_PROBLEM)
  await expect(s3).toContainText('the pane is read at line 121, before the inventory')
  await expect(s3).toContainText('Read the pane and the inventory immediately before each send_text')
  await expect(s3).toContainText('M-4')
  // A finding shows its latest values: S-1 at its pass-3 revision, not the a1b2c3d it was created at.
  await expect(open.first()).toContainText('workflow/sidecar.py:merge_output')
  await expect(open.first()).toContainText('b2c3d4e')
  await expect(open.first()).toContainText('fixed S-1, validating before the write')
  // S-2 has no locator: its file stands alone.
  await expect(open.nth(2)).toContainText('tests/project-workflows/fixtures/ux-sidecar.ts')

  // Escalations: kind, finding, text, time.
  const escalation = section(page, 'sidecar-escalations').getByTestId('sidecar-escalation')
  await expect(escalation).toHaveCount(1)
  await expect(escalation).toContainText('security')
  await expect(escalation).toContainText('S-3')
  await expect(escalation).toContainText(ESCALATION_TEXT)

  // Resolved: closed by default, after Open; one line each with the evidence of its last transition.
  const resolved = section(page, 'sidecar-resolved')
  expect(await precedes(section(page, 'sidecar-open'), resolved)).toBe(true)
  const disclosure = resolved.locator('details')
  await expect(disclosure).not.toHaveAttribute('open', '')
  await expect(findingsIn(resolved)).toHaveCount(1)
  await expect(findingsIn(resolved).first()).toBeHidden()
  await disclosure.locator('summary').click()
  await expect(findingsIn(resolved).first()).toBeVisible()
  await expect(findingsIn(resolved).first()).toHaveAttribute('data-disposition', 'verified_resolved')
  await expect(findingsIn(resolved).first()).toContainText(S4_RESOLUTION)

  // Messages: a status chip each; undeliverable and refused say why; the text stays for the operator to relay.
  const messages = section(page, 'sidecar-messages').getByTestId('sidecar-message')
  await expect(messages).toHaveCount(4)
  expect(await attributes(messages, 'data-status')).toEqual(['delivered', 'refused', 'undeliverable', 'delivered'])
  await expect(messages.nth(1)).toContainText('refused: a question was waiting')
  await expect(messages.nth(2)).toContainText('undeliverable: the pane was busy')
  await expect(messages.nth(2)).toContainText(PANE_BUSY_TEXT)
  await expect(messages.nth(2)).toContainText('viewer')
  await expect(messages.nth(2)).toContainText('S-4')

  // Passes: one row each with its status, a failed and a timed-out one, and the lanes read (a pane not captured said so).
  const passes = section(page, 'sidecar-passes').getByTestId('sidecar-pass')
  await expect(passes).toHaveCount(6)
  expect(await attributes(passes, 'data-status')).toEqual(['completed', 'timed_out', 'completed', 'completed', 'failed', 'completed'])
  await expect(passes.nth(1)).toContainText('completion')
  await expect(passes.nth(1)).toContainText('10m00s')
  await expect(passes.nth(1)).toContainText('pane not captured')
  await expect(passes.nth(4)).toContainText('CalledProcessError')

  // Handoff: no final pass yet on the running run.
  await expect(section(page, 'sidecar-handoff')).toContainText('no final pass recorded')
  // History is the last section.
  await expect(nodeDetail(page).locator('section.node-section').last()).toHaveAttribute('data-section', 'history')
  await expect(nodeDetail(page).getByTestId('node-events').locator('li')).toHaveCount(8)
  await expectNoExecutionControls(page)
  await expect(nodeDetail(page).getByRole('button', { name: /claude|python|workflow|\// })).toHaveCount(0)
  await renderedText(nodeDetail(page))
  await attach(page, testInfo, 'sidecar-node')

  // At 390 px the cards stack and nothing scrolls sideways.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(open).toHaveCount(3)
  expect(await display(open.first())).toBe('block')
  await expect.poll(() => pageWidth(page)).toBeLessThanOrEqual(390)
  await expectNoExecutionControls(page)

  // Frozen: the node succeeded, the ledger closed, the final pass's five lists.
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(nodeUrl(RUN_SIDECAR_FROZEN))
  await expect(headline(page)).toContainText('2 of 7 passes failed · 3 open (2 P1)')
  const handoff = section(page, 'sidecar-handoff')
  for (const list of ['unresolved', 'structural', 'verified_resolved', 'withdrawn', 'gaps']) await expect(handoff.locator(`[data-list="${list}"]`)).toHaveCount(1)
  await expect(handoff.locator('[data-list="unresolved"] li')).toHaveCount(3)
  await expect(handoff.locator('[data-list="unresolved"]')).toContainText(HANDOFF_UNRESOLVED)
  await expect(handoff.locator('[data-list="gaps"]')).toContainText(HANDOFF_GAP)
  await expect(handoff.locator('[data-list="withdrawn"]')).toContainText('none')
  await expect(section(page, 'sidecar-source')).toHaveAttribute('data-source', 'export')
  await expect(page.getByTestId('node-header').getByText('Succeeded', { exact: true })).toBeVisible()
  await expectNoExecutionControls(page)
})

test(`[scenario:sidecar-live] While the workers run the page follows the ledger: a finding verified resolved moves to Resolved within one poll, without a reload; the live file wins over an older export; a finished run is not polled (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.clock.install({ time: NOW })
  const requests: string[] = []
  page.on('request', request => { if (new URL(request.url()).pathname === sidecarApi(RUN_SIDECAR)) requests.push(request.url()) })
  if (phase === 'worker') {
    // The mocked ledger as the controller rewrites it: the next pass verifies S-1.
    let current = SIDECAR_LEDGERS[RUN_SIDECAR]
    await page.route(url => url.pathname === sidecarApi(RUN_SIDECAR), route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(current) }))
    await page.goto(nodeUrl(RUN_SIDECAR))
    const open = findingsIn(section(page, 'sidecar-open'))
    await expect(open).toHaveCount(3)
    await expect(section(page, 'sidecar-open').locator('[data-id="S-1"]')).toHaveCount(1)
    await expect(section(page, 'sidecar-source')).toHaveAttribute('data-source', 'live')
    // A marker on the window survives only if the page is not reloaded.
    await page.evaluate(() => { (globalThis as unknown as Record<string, unknown>).__sidecarMarker = 'kept' })
    const before = requests.length
    current = ledgerAfterNextPass()
    await page.clock.runFor(5_000)
    await expect(section(page, 'sidecar-resolved').locator('[data-id="S-1"]')).toHaveCount(1)
    await expect(section(page, 'sidecar-open').locator('[data-id="S-1"]')).toHaveCount(0)
    await expect(open).toHaveCount(2)
    await expect(headline(page)).toContainText('2 of 7 passes failed · 2 open (1 P1)')
    expect(await page.evaluate(() => (globalThis as unknown as Record<string, unknown>).__sidecarMarker)).toBe('kept')
    expect(requests.length).toBe(before + 1)
    await attach(page, testInfo, 'sidecar-live')
    await expectFinishedRunNotPolled(page)
    return
  }
  // Candidate: the run's live sidecar.ledger.json has six passes, its export section Appendix B's three; the live one is served.
  await page.goto(nodeUrl(RUN_SIDECAR))
  await expect(headline(page)).toHaveText(/^2 of 6 passes failed · 3 open \(2 P1\)/)
  await expect(section(page, 'sidecar-source')).toHaveAttribute('data-source', 'live')
  await expect(section(page, 'sidecar-passes').getByTestId('sidecar-pass')).toHaveCount(6)
  const served = JSON.parse((await fetchFromPage(page, sidecarApi(RUN_SIDECAR))).text) as { source: string; passes: unknown[]; contract_version: string }
  expect([served.source, served.passes.length, served.contract_version]).toEqual(['live', 6, '1.6.0'])
  // It keeps reading it while the run works: the next poll asks again.
  const before = requests.length
  await page.clock.runFor(5_000)
  await expect.poll(() => requests.length).toBe(before + 1)
  await attach(page, testInfo, 'sidecar-live')
  await expectFinishedRunNotPolled(page)
})

test(`[scenario:sidecar-run] The run page draws the sidecar as an agent in the launch column with the legend unchanged, lists its step with its span, and the Now banner names a lane exactly as the run without a sidecar does (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.clock.install({ time: NOW })
  const sidecarRequests: string[] = []
  page.on('request', request => { if (/\/sidecar$/.test(new URL(request.url()).pathname)) sidecarRequests.push(new URL(request.url()).pathname) })
  await page.goto(runPage(RUN_SIDECAR))
  const node = graphNode(page, 'sidecar')
  await expect(node).toBeVisible()
  await expect(node).toHaveClass(/\bis-agent\b/)
  await expect(node).toHaveAttribute('data-executor', 'agent')
  await expect(node).toHaveAttribute('aria-label', /^Review sidecar, review, running, attempt 1, executed by /)
  // An agent session's card has a solid outline (a verifier's is dashed, the controller's dotted).
  expect(await node.evaluate(element => (globalThis as unknown as { getComputedStyle: (target: unknown) => { borderTopStyle: string } }).getComputedStyle(element).borderTopStyle)).toBe('solid')
  // The launch column: the same x as the launch nodes, right of the challenge.
  const x = async (id: string) => (await graphNode(page, id).boundingBox())!.x
  expect(await x('sidecar')).toBeCloseTo(await x('launch_engine'), 0)
  expect(await x('sidecar')).toBeGreaterThan(await x('challenge'))
  // The legend (behind its button) names the six tones and the four outlines; a sidecar adds nothing to it.
  await page.getByRole('button', { name: 'Legend' }).click()
  const legend = page.getByTestId('graph-legend')
  await expect(legend).toBeVisible()
  await expect(legend.locator('li')).toHaveCount(10)

  // Its step, running, with its span from its first pass: on the card's name and in its sheet's facts.
  await expect(node).toHaveAttribute('data-status', 'running')
  await expect(node).toHaveAttribute('aria-label', /, 1h44m$/)
  await openStepSheet(page, 'sidecar')
  const facts = stepSheet(page).getByTestId('sheet-facts')
  await expect(facts).toContainText('12:10')
  await expect(facts).toContainText('1h44m')
  await stepSheet(page).getByRole('button', { name: 'Close step details' }).click()
  await expect(stepSheet(page)).toHaveCount(0)

  // The Now banner names the lanes, not the sidecar, and reads exactly as the run without a sidecar.
  const banner = page.getByTestId('now-headline')
  await expect(page.getByTestId('run-now')).toHaveAttribute('data-situation', 'running')
  await expect(banner).toContainText('Launch engine worker')
  await expect(banner).toContainText('Launch viewer worker')
  await expect(banner).not.toContainText(/Review sidecar|escalation/)
  const withSidecar = (await banner.textContent())!
  await expectNoExecutionControls(page)
  await attach(page, testInfo, 'sidecar-run')

  await page.goto(runPage(RUN_SIDECAR_PLAIN))
  await expect(page.getByTestId('run-now')).toHaveAttribute('data-situation', 'running')
  await expect(page.getByTestId('now-headline')).toHaveText(withSidecar)
  // Without a sidecar: no such node or step, the legend unchanged, and its sidecar route is "not recorded".
  await expect(graphNode(page, 'launch_engine')).toHaveCount(1)
  await expect(graphNode(page, 'sidecar')).toHaveCount(0)
  await expect(page.getByTestId('graph-legend').locator('li')).toHaveCount(10)
  // The page itself never asks for a ledger of the run without a sidecar; the one request below is this test's own.
  const plainRequests = () => sidecarRequests.filter(path => path === sidecarApi(RUN_SIDECAR_PLAIN))
  expect(plainRequests()).toEqual([])
  const missing = await fetchFromPage(page, sidecarApi(RUN_SIDECAR_PLAIN))
  expect(missing.status).toBe(404)
  expect((JSON.parse(missing.text) as { error: { code: string } }).error.code).toBe('SIDECAR_NOT_FOUND')
  await page.goto(nodeUrl(RUN_SIDECAR_PLAIN))
  await expect(page.getByTestId('node-missing')).toBeVisible()
  await page.clock.runFor(5_000)
  expect(plainRequests()).toHaveLength(1)
  if (phase === 'candidate') {
    // The served activity of the two runs is the same: the run list reads it.
    const activity = async (runId: string) => (JSON.parse((await fetchFromPage(page, apiRun(runId, UX_SIDECAR_WORKFLOW_ID))).text) as { summary: { activity: unknown } }).summary.activity
    expect(await activity(RUN_SIDECAR)).toEqual(await activity(RUN_SIDECAR_PLAIN))
  }

  // A run with a sidecar but no ledger yet (its first pass has not ended; in the candidate phase its export section is null
  // and its live file invalid): the route answers 404 SIDECAR_NOT_FOUND and the node page says "not recorded", not an error.
  const unrecorded = await fetchFromPage(page, sidecarApi(RUN_SIDECAR_NO_LEDGER))
  expect(unrecorded.status).toBe(404)
  expect((JSON.parse(unrecorded.text) as { error: { code: string } }).error.code).toBe('SIDECAR_NOT_FOUND')
  await page.goto(nodeUrl(RUN_SIDECAR_NO_LEDGER))
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'sidecar')
  await expect(page.getByTestId('sidecar-none')).toHaveText(/^Sidecar ledger not recorded/)
  await expect(headline(page)).toHaveText('no pass yet')
  await expect(page.getByTestId('sidecar-source')).toHaveCount(0)
  await expect(nodeDetail(page).getByTestId('projects-error')).toHaveCount(0)
  await expectNoExecutionControls(page)
  // The run is running: the resource keeps polling and keeps reading "not recorded".
  const asked = sidecarRequests.filter(path => path === sidecarApi(RUN_SIDECAR_NO_LEDGER)).length
  await page.clock.runFor(5_000)
  await expect.poll(() => sidecarRequests.filter(path => path === sidecarApi(RUN_SIDECAR_NO_LEDGER)).length).toBeGreaterThan(asked)
  await expect(page.getByTestId('sidecar-none')).toBeVisible()
})
