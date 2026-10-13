/**
 * The critique reviewer's evidence on the run page (docs/PRD_USER_CRITIQUE.md 4.5, Appendix A, decisions.md [L1]/[L2]): on
 * the review node the critique is listed as a reviewer, worded as a headless critique job (never a native session); its P1
 * shows its lane, its numbered steps and its screenshot thumbnails with captions, a thumbnail opens the one full-size dialog
 * (Escape closes it and focus returns), and a P1 recorded with no screenshot says "no screenshot"; other reviewers' findings
 * carry no evidence block; one "Earlier rounds" list shows each archived round's findings, and an archived critique finding
 * keeps its own evidence. The viewer stays read-only and does not scroll sideways at 390 px.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  ARCHIVED_CAPTION, ARCHIVED_P1_MESSAGE, FIRST_STEP, GENERAL_ARCHIVED_P1_MESSAGE, GENERAL_P2_MESSAGE, LIVE_CAPTION, LIVE_P1_MESSAGE,
  NO_SHOT_P1_MESSAGE, RUN_CRITIQUE, UX_CRITIQUE_WORKFLOW_ID,
} from './fixtures/ux-critique.ts'
import { attach, expectNoExecutionControls, installHooks, nodeDetail, phase, renderedText, runUrl } from './support.ts'

installHooks()

const nodeUrl = (runId: string, nodeId: string) => runUrl(runId, nodeId, UX_CRITIQUE_WORKFLOW_ID)
const findingCard = (page: Page, reviewer: string, severity: string, worker: string) =>
  page.locator(`[data-testid="finding"][data-reviewer="${reviewer}"][data-severity="${severity}"][data-worker="${worker}"]`)
const reviewerEntry = (page: Page, id: string) => page.locator(`[data-testid="reviewer-entry"][data-reviewer="${id}"]`)
const indexLink = (page: Page, key: string) => page.getByTestId('section-index').locator(`a[data-section="${key}"]`)
const pageWidth = (page: Page) => page.evaluate(() => (globalThis as unknown as { document: { documentElement: { scrollWidth: number } } }).document.documentElement.scrollWidth)
const overflow = (target: Locator) => target.evaluate(element => (element as unknown as { scrollWidth: number; clientWidth: number }).scrollWidth - (element as unknown as { clientWidth: number }).clientWidth)

test(`[scenario:critique-evidence] The review lists the critique as a headless job; its P1 shows lane, steps and a screenshot (dialog opens, Escape returns focus); a P1 with no screenshot says so; other reviewers carry no evidence; an "Earlier rounds" list shows each archived round's own evidence; read-only, no sideways scroll at 390 px (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(nodeUrl(RUN_CRITIQUE, 'review'))
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'review')

  // The critique is listed as a reviewer, worded as a headless critique job, never a native session.
  const critique = reviewerEntry(page, 'critique')
  await expect(critique).toHaveCount(1)
  await expect(critique.getByTestId('reviewer-kind')).toHaveText('headless critique job')
  await expect(critique).not.toContainText('native session')
  await expect(critique.getByTestId('reviewer-status')).toHaveText('blocked the candidate')
  // Its launch time and status are shown; the Reviewers fact names it a headless critique job, not a native session.
  await expect(critique).toContainText('launched')
  // Its recorded time reads as a decision, never a native "file accepted" (the critique has no completion file, PRD 4.4).
  await expect(critique).toContainText('decided')
  await expect(critique).not.toContainText('file accepted')
  const critiqueFact = page.locator('[data-testid="review-reviewer"] [data-reviewer="critique"]')
  await expect(critiqueFact).toContainText('headless critique job')
  await expect(critiqueFact).not.toContainText('native session')

  // The critique's P1 on the pages lane: its lane, its numbered steps, and its screenshot thumbnail with its caption.
  const p1 = findingCard(page, 'critique', 'P1', 'pages')
  await expect(p1).toContainText(LIVE_P1_MESSAGE)
  await expect(p1.getByTestId('finding-worker')).toHaveText('pages')
  const steps = p1.getByTestId('critique-steps')
  await expect(steps.locator('li')).toHaveCount(3)
  await expect(steps.locator('li').first()).toHaveText(FIRST_STEP)
  await expect(steps).toHaveJSProperty('tagName', 'OL')
  await expect(p1.locator('.screenshot-caption')).toHaveText(LIVE_CAPTION)
  const thumb = p1.locator('.screenshot-thumb')
  await expect(thumb).toHaveCount(1)
  await attach(page, testInfo, 'critique-evidence')

  // Activating the thumbnail opens the one full-size dialog; Escape closes it and the focus returns to the thumbnail.
  await p1.getByTestId('finding-more').click()
  await thumb.click()
  const dialog = page.getByTestId('screenshot-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('img')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(thumb).toBeFocused()

  // A critique P1 recorded with no screenshot says "no screenshot"; it still shows its steps.
  const noShot = findingCard(page, 'critique', 'P1', 'shell')
  await expect(noShot).toContainText(NO_SHOT_P1_MESSAGE)
  await expect(noShot.getByTestId('critique-no-screenshot')).toHaveText('no screenshot')
  await expect(noShot.locator('.screenshot-thumb')).toHaveCount(0)
  await expect(noShot.getByTestId('critique-steps').locator('li')).toHaveCount(3)

  // The review opens on open P0/P1; "All" brings the P2 card into the list.
  await page.getByRole('button', { name: /^All \d+$/ }).click()

  // Another reviewer's finding carries no evidence block.
  const general = findingCard(page, 'general', 'P2', 'pages')
  await expect(general).toContainText(GENERAL_P2_MESSAGE)
  await expect(general.getByTestId('critique-evidence')).toHaveCount(0)

  // One "Earlier rounds" list of archived rounds: round 1's findings (every reviewer's), the critique keeping its own
  // evidence (its own caption and steps, not the live round's).
  await expect(indexLink(page, 'earlier-rounds')).toHaveAttribute('data-count', '1')
  const earlier = page.getByTestId('earlier-rounds')
  await expect(earlier).toHaveCount(1)
  const round1 = earlier.locator('[data-testid="earlier-round"][data-round="1"]')
  await expect(round1).toHaveCount(1)
  const archivedCritique = round1.locator('[data-testid="earlier-finding"][data-reviewer="critique"]')
  await expect(archivedCritique).toContainText(ARCHIVED_P1_MESSAGE)
  await expect(archivedCritique.locator('.screenshot-caption')).toHaveText(ARCHIVED_CAPTION)
  // Its evidence is its own, not the live finding's.
  await expect(archivedCritique).not.toContainText(LIVE_CAPTION)
  await expect(archivedCritique.getByTestId('critique-steps').locator('li').first()).toHaveText(FIRST_STEP)
  // The archived round also shows the other reviewer's finding, with no evidence block.
  const archivedGeneral = round1.locator('[data-testid="earlier-finding"][data-reviewer="general"]')
  await expect(archivedGeneral).toContainText(GENERAL_ARCHIVED_P1_MESSAGE)
  await expect(archivedGeneral.getByTestId('critique-evidence')).toHaveCount(0)
  // The archived round's cards are not live `finding` rows (the live findings count is untouched).
  await expect(earlier.getByTestId('finding')).toHaveCount(0)

  await renderedText(nodeDetail(page))
  await expectNoExecutionControls(page)

  // At 390 px nothing scrolls the page sideways and no card overflows.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(p1).toBeVisible()
  for (const card of await page.getByTestId('finding').all()) expect(await overflow(card)).toBeLessThanOrEqual(0)
  for (const card of await page.getByTestId('earlier-finding').all()) expect(await overflow(card)).toBeLessThanOrEqual(0)
  await expect.poll(() => pageWidth(page)).toBeLessThanOrEqual(390)
  await expectNoExecutionControls(page)
})
