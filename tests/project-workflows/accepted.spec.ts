/**
 * The operator override in the viewer (docs/PRD_ACCEPT_OVERRIDE.md, decisions.md L8, L12): a run whose export carries `accepted`
 * reads "integrated (operator override)" on its run page and in the runs list, in its own chip and never the reviewed-integration
 * style, with the reason, who and when, the candidate and every finding open at acceptance; the same run without the record reads
 * as before, and an abandoned run that was accepted shows the override with its abandon row kept as history. Both phases: the worker
 * phase serves `fixtures/ux-accepted.ts` through the mocks, the candidate phase seeds the same runs as 1.12.0 exports.
 */
import { test, expect, type Page } from '@playwright/test'
import {
  ABANDON_MESSAGE, ACCEPTED_REASON, FAILSAFE_TITLE, RUN_ACCEPTED_ABANDONED, RUN_ACCEPTED_ABANDONED_PLAIN, RUN_ACCEPTED_BLOCKED, RUN_ACCEPTED_BLOCKED_PLAIN, STALE_TITLE,
  UX_ACCEPTED_WORKFLOW_ID,
} from './fixtures/ux-accepted.ts'
import { PROJECT } from './fixtures.ts'
import { attach, expectNoExecutionControls, installHooks, liveDock, phase, projectUrl, runUrl, workflowUrl } from './support.ts'

installHooks()

const runPage = (runId: string) => runUrl(runId, undefined, UX_ACCEPTED_WORKFLOW_ID)
const listPage = workflowUrl(PROJECT.project_id, UX_ACCEPTED_WORKFLOW_ID)
const overflow = (page: Page) => page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') as Promise<number>
const row = (page: Page, runId: string) => page.locator(`a[data-run-id="${runId}"]`)

test(`[scenario:accepted-run-outcome] A run the operator accepted reads integrated (operator override) on its page and in the runs list, apart from a reviewed integration, with reason, actor, time, candidate and the open findings; without the record it reads as before; no overflow at 390 px (${phase})`, async ({ page }, testInfo) => {
  await page.goto(runPage(RUN_ACCEPTED_BLOCKED))
  const status = page.getByTestId('run-status')
  const chip = status.getByTestId('override-chip')
  await expect(chip).toHaveText('integrated (operator override)')
  await expect(chip).toHaveClass(/status-override/)
  await expect(chip).not.toHaveClass(/status-succeeded/)
  await expect(status.locator('.status-succeeded')).toHaveCount(0)
  await expect(page.getByTestId('run-now')).toHaveAttribute('data-situation', 'accepted')
  const outcome = page.getByTestId('accepted-outcome')
  await expect(outcome.getByTestId('accepted-reason')).toContainText(ACCEPTED_REASON)
  await expect(outcome.getByTestId('accepted-facts')).toContainText('accepted by operator')
  await expect(outcome.getByTestId('accepted-facts').locator('time')).toHaveAttribute('datetime', /^2026-03-01T11:30:00/)
  await expect(outcome.getByTestId('accepted-candidate')).toHaveText('ccccccc')
  const findings = outcome.getByTestId('accepted-findings').locator('li')
  await expect(findings).toHaveCount(2)
  await expect(findings.nth(0)).toContainText('P1')
  await expect(findings.nth(0)).toContainText(FAILSAFE_TITLE)
  await expect(findings.nth(0)).toContainText('coverage')
  await expect(findings.nth(1)).toContainText('P2')
  await expect(findings.nth(1)).toContainText(STALE_TITLE)
  await expect(outcome.getByTestId('accepted-abandoned')).toHaveCount(0)
  await expectNoExecutionControls(page)
  // The live dock's bar (L12) never reads succeeded, and is not in the ok tone, whatever step the review stopped at.
  const bar = liveDock(page).getByTestId('live-dock-bar')
  await expect(bar).toContainText('operator override')
  await expect(bar).not.toContainText(/succeeded/i)
  await expect(bar).not.toHaveClass(/tone-ok/)
  await expect(bar).toHaveClass(/tone-override/)

  // The runs list: the override row in its own chip, its twins as before.
  await page.goto(listPage)
  const accepted = row(page, RUN_ACCEPTED_BLOCKED)
  await expect(accepted).toHaveAttribute('data-outcome', 'override')
  await expect(accepted.getByTestId('override-chip')).toContainText('integrated (operator override)')
  await expect(accepted.locator('.status-succeeded')).toHaveCount(0)
  await expect(accepted).toContainText(ACCEPTED_REASON)
  // Actor and open findings sit outside the ellipsised summary, so a long reason never cuts them off (note 5).
  const rowAccepted = accepted.getByTestId('row-accepted')
  await expect(rowAccepted).toBeVisible()
  await expect(rowAccepted).toContainText('accepted by operator')
  await expect(rowAccepted).toContainText('2 open findings at acceptance: P1, P2')
  expect(await rowAccepted.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  const plain = row(page, RUN_ACCEPTED_BLOCKED_PLAIN)
  await expect(plain).toHaveAttribute('data-status', 'failed')
  await expect(plain).not.toHaveAttribute('data-outcome', 'override')
  await expect(plain.locator('.status-badge')).toContainText('Failed')
  await expect(row(page, RUN_ACCEPTED_ABANDONED_PLAIN).locator('.status-badge')).toContainText('Cancelled')

  // The project page's group head for the feature is not in the ok tone when its latest run was accepted (design note 1).
  await page.goto(projectUrl(PROJECT.project_id))
  const head = page.locator(`li[data-workflow-id="${UX_ACCEPTED_WORKFLOW_ID}"] a.lists-group-head`)
  await expect(head).toHaveClass(/tone-(?:override|fail|idle)/)
  await expect(head).not.toHaveClass(/tone-ok/)

  // The same run without the record is untouched on its page.
  await page.goto(runPage(RUN_ACCEPTED_BLOCKED_PLAIN))
  await expect(page.getByTestId('accepted-outcome')).toHaveCount(0)
  await expect(page.getByTestId('override-chip')).toHaveCount(0)
  await expect(page.getByTestId('run-status').locator('.status-badge')).toContainText('Failed')

  // 390 px: nothing scrolls sideways, on the run page or in the list.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(runPage(RUN_ACCEPTED_BLOCKED))
  await expect(page.getByTestId('accepted-outcome')).toBeVisible()
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await page.goto(listPage)
  await expect(row(page, RUN_ACCEPTED_BLOCKED)).toBeVisible()
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(runPage(RUN_ACCEPTED_BLOCKED))
  await expect(page.getByTestId('accepted-outcome')).toBeVisible()
  await attach(page, testInfo, 'accepted-run-outcome')
})

test(`[scenario:accepted-after-abandon] An abandoned run that was then accepted reads as the override, not cancelled, keeps the abandon reason as history, and says when no finding was open (${phase})`, async ({ page }, testInfo) => {
  await page.goto(runPage(RUN_ACCEPTED_ABANDONED))
  const status = page.getByTestId('run-status')
  await expect(status.getByTestId('override-chip')).toHaveText('integrated (operator override)')
  await expect(status).not.toContainText('Cancelled')
  await expect(status).not.toContainText('cancelled')
  await expect(page.getByTestId('run-now')).toHaveAttribute('data-situation', 'accepted')
  const outcome = page.getByTestId('accepted-outcome')
  await expect(outcome.getByTestId('accepted-abandoned')).toContainText(ABANDON_MESSAGE)
  await expect(outcome.getByTestId('accepted-findings-none')).toHaveText('no open findings at acceptance')
  await expect(outcome.getByTestId('accepted-findings')).toHaveCount(0)
  await page.goto(listPage)
  const accepted = row(page, RUN_ACCEPTED_ABANDONED)
  await expect(accepted).toHaveAttribute('data-outcome', 'override')
  await expect(accepted.getByTestId('override-chip')).toContainText('integrated (operator override)')
  await expect(accepted).not.toContainText('Cancelled')
  await page.goto(runPage(RUN_ACCEPTED_ABANDONED))
  await expect(page.getByTestId('accepted-outcome')).toBeVisible()
  await attach(page, testInfo, 'accepted-after-abandon')
})
