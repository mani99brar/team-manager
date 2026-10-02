/**
 * Viewer UX slice S4c, review, challenge and controller nodes (docs/PRD_VIEWER_UX.md 4.7-4.9, 12.2): a review opens on what
 * blocks it, before the findings table, with each reviewer's time taken only from served fields; at phone width the same
 * findings are cards. A challenge opens on one headline and keeps its P2 notes to one line each; a paused one shows its P1
 * in full with the commands to resume. The controller's steps say what they did: the handoff's wait from the launch
 * receipts, an approval no event recorded as `≈`, the fast-forwarded branch and commit.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { CANDIDATE_COMMIT } from './fixtures.ts'
import {
  PAUSED_P1, PAUSED_P1_CONSEQUENCE, PENDING_P1, PRINT_P1, RUN_CHALLENGE_PAUSED, RUN_REVIEW_APPROVED, RUN_REVIEW_PENDING, RUN_REVIEW_PRINT, UX_REVIEW_WORKFLOW_ID,
} from './fixtures/ux-review.ts'
import { APPROVAL_BUNDLE, RUN_AWAITING_APPROVAL, UX_RUN_WORKFLOW_ID } from './fixtures/ux-run.ts'
import { attach, expectNoExecutionControls, installHooks, nodeDetail, phase, renderedText, runUrl } from './support.ts'

installHooks()

const nodeUrl = (runId: string, nodeId: string) => runUrl(runId, nodeId, UX_REVIEW_WORKFLOW_ID)
const findings = (page: Page) => page.getByTestId('review-findings')
const findingRows = (page: Page) => findings(page).getByTestId('finding')
const blockingCards = (page: Page) => page.getByTestId('blocking-finding')
const reviewer = (page: Page, id: string) => page.locator(`[data-testid="reviewer-entry"][data-reviewer="${id}"]`)
const indexLink = (page: Page, key: string) => page.getByTestId('section-index').locator(`a[data-section="${key}"]`)
const pageWidth = (page: Page) => page.evaluate(() => (globalThis as unknown as { document: { documentElement: { scrollWidth: number } } }).document.documentElement.scrollWidth)
/** Whether `first` comes before `second` in the document. */
const precedes = async (first: Locator, second: Locator) => first.evaluate((a, b) => Boolean((a as unknown as { compareDocumentPosition: (other: unknown) => number }).compareDocumentPosition(b) & 4), await second.elementHandle())
const display = (target: Locator) => target.evaluate(element => (globalThis as unknown as { getComputedStyle: (target: unknown) => { display: string } }).getComputedStyle(element).display)
const overflow = (target: Locator) => target.evaluate(element => (element as unknown as { scrollWidth: number; clientWidth: number }).scrollWidth - (element as unknown as { clientWidth: number }).clientWidth)

test(`[scenario:review-blocking-first] A review opens on its blocking finding before the finding cards; reviewers show their time only from served fields; phone width shows the same findings as cards (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  // A fixed clock: a reviewer that recorded no verdict shows no ticking time.
  await page.clock.install({ time: new Date('2026-03-05T10:00:00Z') })
  await page.goto(nodeUrl(RUN_REVIEW_PENDING, 'review'))
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'review')
  await expect(findingRows(page)).toHaveCount(2)

  // The blocking card: outside the findings, no `finding` test id, before the finding cards, in the first screen.
  const cards = blockingCards(page)
  await expect(cards).toHaveCount(1)
  await expect(cards).toContainText(PENDING_P1)
  await expect(cards).toContainText('P1 · open · coverage · lane ui')
  await expect(findings(page).getByTestId('blocking-finding')).toHaveCount(0)
  await expect(page.getByTestId('blocking-findings').getByTestId('finding')).toHaveCount(0)
  expect(await precedes(cards.first(), findingRows(page).first())).toBe(true)
  expect((await cards.first().boundingBox())!.y).toBeLessThan(900)
  await expect(cards.getByRole('link', { name: 'Requirement in the ui task ›' })).toBeVisible()
  await expect(indexLink(page, 'blocking')).toHaveAttribute('data-count', '1')
  await expect(indexLink(page, 'review')).toHaveAttribute('data-count', '2')

  // Decided: from launch to the accepted file. No verdict: the launch time only, and nothing ticks.
  await expect(reviewer(page, 'coverage').getByTestId('reviewer-status')).toHaveText('blocked the candidate')
  await expect(reviewer(page, 'coverage').getByTestId('reviewer-time')).toHaveText('took 2m30s')
  const general = reviewer(page, 'general')
  await expect(general.getByTestId('reviewer-status')).toHaveText('no verdict recorded yet')
  await expect(general.getByTestId('reviewer-time')).toHaveText('no verdict · launched 09:40:00')
  await page.clock.fastForward('05:00')
  await expect(general.getByTestId('reviewer-time')).toHaveText('no verdict · launched 09:40:00')
  await expect(general).not.toContainText(/left|deadline|working/)
  await expectNoExecutionControls(page)
  await attach(page, testInfo, 'review-blocking-first')

  // Both reviewers approved: their durations, and no blocking card.
  await page.goto(nodeUrl(RUN_REVIEW_APPROVED, 'review'))
  await expect(findingRows(page)).toHaveCount(3)
  await expect(reviewer(page, 'general').getByTestId('reviewer-time')).toHaveText('took 3m49s')
  await expect(reviewer(page, 'coverage').getByTestId('reviewer-time')).toHaveText('took 2m04s')
  await expect(blockingCards(page)).toHaveCount(0)
  await expect(indexLink(page, 'blocking')).toHaveCount(0)

  // A print reviewer records no launch time: said so, with no duration or deadline.
  await page.goto(nodeUrl(RUN_REVIEW_PRINT, 'review'))
  await expect(findingRows(page)).toHaveCount(2)
  await expect(blockingCards(page)).toHaveCount(1)
  await expect(blockingCards(page)).toContainText(PRINT_P1)
  expect(await precedes(blockingCards(page).first(), findingRows(page).first())).toBe(true)
  const print = reviewer(page, 'review')
  await expect(print.getByTestId('reviewer-time')).toContainText('launch time not recorded (print)')
  await expect(print).not.toContainText(/took|deadline/)
  await renderedText(nodeDetail(page))

  // At 390 px the same finding cards stack: no second copy, no sideways scroll, every field still labelled.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(findingRows(page)).toHaveCount(2)
  expect(await display(findingRows(page).first())).toBe('flex')
  await expect(findingRows(page).first().locator('.ui-sev')).toHaveCount(1)
  await expect(findingRows(page).first().locator('.finding-field-label')).toHaveText(['Worker', 'Reviewer', 'Requirement'])
  for (const card of await findingRows(page).all()) expect(await overflow(card)).toBeLessThanOrEqual(0)
  await expect.poll(() => pageWidth(page)).toBeLessThanOrEqual(390)
  await expect(blockingCards(page)).toHaveCount(1)
  await expectNoExecutionControls(page)
})

test(`[scenario:challenge-headline] A challenge opens on one headline over its attempts, with P0/P1 open and P2 one line each; a paused one shows its P1 and the commands to resume (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(nodeUrl(RUN_REVIEW_APPROVED, 'challenge'))
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'challenge')
  const headline = page.getByTestId('challenge-headline')
  await expect(headline).toHaveText('Passed on attempt 3 · 8 P2 notes · decided 08:50:49 · 11m07s over 3 attempts')
  await expect(page.getByTestId('challenge-headline')).toHaveCount(1)
  expect(await precedes(headline, page.getByTestId('section-index'))).toBe(true)
  expect((await headline.boundingBox())!.y).toBeLessThan(900)

  // The attempt strip: three attempts, the first ended without a record, the second failed.
  const chips = page.getByTestId('node-attempts').locator('[data-item="attempt"]')
  await expect(chips).toHaveCount(3)
  await expect(chips.nth(0)).toHaveAttribute('aria-label', /Attempt 1, ended without a record/)
  await expect(chips.nth(1)).toHaveAttribute('aria-label', /Attempt 2, failed, 46s/)
  await expect(chips.nth(2)).toHaveAttribute('aria-label', /Attempt 3, succeeded, 2m29s/)

  // P2 notes: one line each, closed, expandable to message and consequence.
  const notes = page.locator('[data-testid="challenge-concern"][data-severity="P2"]')
  await expect(notes).toHaveCount(8)
  await expect(indexLink(page, 'concerns')).toHaveAttribute('data-count', '8')
  for (const note of await notes.all()) await expect(note).not.toHaveAttribute('open', '')
  const first = notes.first()
  const line = await first.locator('summary').boundingBox()
  expect(line!.height).toBeLessThan(40)
  await expect(first.getByTestId('challenge-consequence')).toBeHidden()
  await first.locator('summary').click()
  await expect(first.getByTestId('challenge-consequence')).toBeVisible()
  await expectNoExecutionControls(page)
  await attach(page, testInfo, 'challenge-headline')

  // Paused: the P1 in full, open, and the two ways on.
  await page.goto(nodeUrl(RUN_CHALLENGE_PAUSED, 'challenge'))
  await expect(page.getByTestId('challenge-headline')).toContainText('Paused: the design challenge found 1 P1; no worker was launched.')
  const p1 = page.locator('[data-testid="challenge-concern"][data-severity="P1"]')
  await expect(p1).toHaveCount(1)
  await expect(p1).toHaveAttribute('open', '')
  await expect(p1).toContainText(PAUSED_P1)
  await expect(p1.getByTestId('challenge-consequence')).toBeVisible()
  await expect(p1.getByTestId('challenge-consequence')).toHaveText(`Consequence: ${PAUSED_P1_CONSEQUENCE}`)
  await expect(page.locator('[data-testid="challenge-concern"][data-severity="P2"]')).not.toHaveAttribute('open', '')
  const next = page.getByTestId('node-next')
  await expect(next).toContainText('"$PY" -m workflow resume "$RUN"')
  await expect(next).toContainText('"$PY" -m workflow resume "$RUN" --accept-challenge "<reason>"')
  await expectNoExecutionControls(page)
})

test(`[scenario:controller-panels] The handoff shows its wait from the receipts, an approval with no event is ≈, the integration names branch and commit, and a manual approval shows its command (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(nodeUrl(RUN_REVIEW_APPROVED, 'handoff'))
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'handoff')
  const handoff = page.getByTestId('handoff-summary')
  await expect(handoff).toContainText('09:19:54 · workers stopped and snapshots captured (ui, adapter) · waited 28m21s for the completion signal')
  await expect(page.getByTestId('handoff-wait')).toContainText('latest launch start (adapter, 08:51:33) → freeze; from receipts')
  await expect(page.getByTestId('section-index')).toHaveCount(0)
  await expectNoExecutionControls(page)
  await attach(page, testInfo, 'controller-panels')

  await page.goto(nodeUrl(RUN_REVIEW_APPROVED, 'approval'))
  const approval = page.getByTestId('approval-summary')
  await expect(approval).toContainText('≈09:43:52 · approved automatically by the finish policy (verified-feature-branch) · no approval event recorded')
  await expect(approval.locator('time')).toHaveAttribute('datetime', '2026-03-05T09:43:52Z')
  await expectNoExecutionControls(page)

  await page.goto(nodeUrl(RUN_REVIEW_APPROVED, 'integrate'))
  await expect(page.getByTestId('integrate-summary')).toContainText(`09:43:52 · fast-forwarded feature/${UX_REVIEW_WORKFLOW_ID}/${RUN_REVIEW_APPROVED} to ${CANDIDATE_COMMIT.slice(0, 12)} · no push performed`)
  await expectNoExecutionControls(page)

  // A manual run's approval: the notice keeps its wording, and the command carries the reviewed bundle's hash.
  await page.goto(runUrl(RUN_AWAITING_APPROVAL, 'approval', UX_RUN_WORKFLOW_ID))
  await expect(page.getByTestId('awaiting-notice')).toContainText('Viewing does not approve it')
  await expect(page.getByTestId('node-next')).toContainText(`"$PY" -m workflow approve "$RUN" --bundle-sha256 ${APPROVAL_BUNDLE}`)
  await expect(page.getByTestId('approval-summary')).toContainText(`bundle ${APPROVAL_BUNDLE.slice(0, 12)}`)
  await expectNoExecutionControls(page)
})
