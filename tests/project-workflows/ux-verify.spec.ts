/**
 * Viewer UX slice S4a, verification and the candidate (docs/PRD_VIEWER_UX.md 4.6, 7 and 8): the gate says how many checks it
 * rejected with one bullet per reason, each keyed reason sits on its check's row, a reason with no check id stays at the gate
 * (and joins a row only when its command tail names exactly one check), and a rejected check is red even at exit 0 with its
 * log tail open. The combined candidate opens on a table of its lanes, failing lanes first and open, passing lanes closed;
 * screenshots are thumbnails that open full size in a native dialog.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { UI_SESSION } from './fixtures.ts'
import { RUN_IDENTICAL, UX_RUN_WORKFLOW_ID } from './fixtures/ux-run.ts'
import {
  CANDIDATE_REJECTED, NO_MATCH_REASON, RUN_REJECTED_CHECKS, RUN_TESTS_COMMAND, SETUP_LOG_ID, UNKEYED_REASON, UX_VERIFY_WORKFLOW_ID,
} from './fixtures/ux-verify.ts'
import { attach, expectNoExecutionControls, installHooks, nodeDetail, phase, renderedText, runUrl } from './support.ts'

installHooks()

const nodeUrl = (nodeId: string) => runUrl(RUN_REJECTED_CHECKS, nodeId, UX_VERIFY_WORKFLOW_ID)
const attemptUrl = (nodeId: string, attempt: number) => `${nodeUrl(nodeId)}/attempts/${attempt}`
const checkRow = (scope: Page | Locator, id: string) => scope.getByTestId('checks-list').locator(`.check[data-check-id="${id}"]`)
const gateReasons = (page: Page) => page.getByTestId('gate-reason')
/** How far an element's content overflows its own box, in px (0 when it fits). */
const overflow = (target: Locator) => target.evaluate(element => (element as unknown as { scrollWidth: number; clientWidth: number }).scrollWidth - (element as unknown as { clientWidth: number }).clientWidth)
const pageWidth = (page: Page) => page.evaluate(() => (globalThis as unknown as { document: { documentElement: { scrollWidth: number } } }).document.documentElement.scrollWidth)
/** The colour of a row's status stripe, which tells a rejected check from a passed one. */
const borderColor = (row: Locator) => row.evaluate(element => (globalThis as unknown as { getComputedStyle: (target: unknown) => { borderLeftColor: string } }).getComputedStyle(element).borderLeftColor)

test(`[scenario:gate-rejected-checks] The gate counts the checks it rejected, keys each reason to its check, keeps an unkeyed reason at the gate, and shows rejected checks red with their log tail open (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(attemptUrl('verify_ui', 1))
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'verify_ui')
  await expect(page.getByTestId('gate-outcome')).toHaveAttribute('data-passed', 'false')

  // One headline and one bullet per reason, each keyed to its check.
  const error = page.getByTestId('worker-error')
  await expect(error).toContainText('Failed: 2 checks rejected')
  await expect(gateReasons(page)).toHaveCount(2)
  await expect(gateReasons(page).nth(0)).toHaveAttribute('data-check-id', 'frontend-unit')
  await expect(gateReasons(page).nth(1)).toHaveAttribute('data-check-id', 'project-workflows-browser')
  await expect(gateReasons(page).nth(0)).toContainText('no passing test evidence or failed tests')
  await expect(error).not.toContainText('Retrying is done through the workflow CLI')

  // One row per check: glyph, the check id matched by command, the command, its offset from the attempt start, duration, exit.
  const checks = page.getByTestId('checks-list').locator('.check')
  await expect(checks).toHaveCount(3)
  const build = checkRow(page, 'frontend-build')
  await expect(build.locator('.check-id')).toHaveText('frontend-build')
  await expect(build.locator('.check-command')).toHaveText('npm run build')
  await expect(build.locator('.check-offset')).toHaveText('+0:05')
  await expect(build.locator('.check-exit')).toHaveText('exit 0')
  await expect(build).toHaveAttribute('data-state', 'passed')
  // cwd, the log's artifact id and the absolute times are in the row's tooltip.
  await expect(build.locator('.check-head')).toHaveAttribute('title', /verification\/worker\/ui\/1\/worktree[\s\S]*log-0-ui-build[\s\S]*2026-03-04 09:20:05 UTC/)
  // A passing check's log waits for the reader.
  await expect(build.locator('[data-testid^="artifact-text:"]')).toHaveCount(0)
  await expect(build.getByRole('button', { name: 'Show contents' })).toBeVisible()

  // Rejected at exit 0: red, the gate's reason on the row, and the log tail already open.
  for (const id of ['frontend-unit', 'project-workflows-browser']) {
    const row = checkRow(page, id)
    await expect(row).toHaveAttribute('data-state', 'rejected')
    await expect(row).toHaveClass(/check-rejected/)
    await expect(row.locator('.check-exit')).toContainText('exit 0 · rejected by the gate')
    await expect(row.locator('.check-reasons')).toContainText('no passing test evidence or failed tests')
    await expect(row.locator('[data-testid^="artifact-text:"]')).toBeVisible()
    await expect(row.getByRole('button', { name: 'Hide contents' })).toBeVisible()
  }
  expect(await borderColor(checkRow(page, 'frontend-unit'))).not.toEqual(await borderColor(build))
  await attach(page, testInfo, 'gate-rejected-checks')

  // At phone width the rows wrap; the page never scrolls sideways.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => pageWidth(page)).toBeLessThanOrEqual(390)
  await page.setViewportSize({ width: 1440, height: 900 })

  // A reason with no check id stays at the gate; its command tail names exactly one check, which lists it too.
  await page.goto(attemptUrl('verify_adapter', 1))
  await expect(page.getByTestId('worker-error')).toContainText('Failed: 1 check rejected')
  const unkeyed = gateReasons(page).filter({ hasText: 'Executed check failed' })
  await expect(unkeyed).toHaveCount(1)
  await expect(unkeyed).not.toHaveAttribute('data-check-id', /.*/)
  await expect(unkeyed).toHaveText(UNKEYED_REASON)
  await expect(gateReasons(page)).toHaveCount(3)
  const runTests = checkRow(page, 'backend-unit')
  await expect(runTests.locator('.check-command')).toHaveText(RUN_TESTS_COMMAND)
  await expect(runTests).toHaveAttribute('data-state', 'failed')
  await expect(runTests.locator('.check-reasons li')).toHaveCount(3)
  await expect(runTests.locator('.check-reasons')).toContainText(UNKEYED_REASON)
  await expect(checkRow(page, 'backend-contract')).toHaveAttribute('data-state', 'passed')

  // Without the run's inputs the reasons cannot be keyed to checks: the headline counts the reasons and claims no rejection.
  await page.route(`**/runs/${RUN_REJECTED_CHECKS}/inputs`, route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL', message: 'inputs unavailable' } }) }))
  await page.goto(attemptUrl('verify_ui', 1))
  await expect(page.getByTestId('worker-error')).toContainText('Failed: the gate recorded 2 reasons')
  await expect(page.getByTestId('worker-error')).not.toContainText('no check was rejected')
  await page.unroute(`**/runs/${RUN_REJECTED_CHECKS}/inputs`)

  // A reason with no check id whose command tail ends no check's command stays at the gate only.
  await page.goto(nodeUrl('candidate'))
  const adapterLane = page.getByTestId('lane-result:adapter')
  const noMatch = adapterLane.getByTestId('gate-reason').filter({ hasText: 'workflow.lint_contract' })
  await expect(noMatch).toHaveText(NO_MATCH_REASON)
  await expect(noMatch).not.toHaveAttribute('data-check-id', /.*/)
  await expect(adapterLane.getByTestId('worker-error')).toContainText('Failed: 1 check rejected')
  await expect(adapterLane.getByTestId('checks-list').locator('.check-reasons')).not.toContainText('workflow.lint_contract')
  await expect(adapterLane.getByTestId('checks-list').locator('.check-reasons')).toHaveCount(1)

  // The latest attempt: the requirements behind a closed disclosure, the identifiers in one closed disclosure, each once.
  await page.goto(nodeUrl('verify_ui'))
  await expect(page.getByTestId('gate-outcome')).toHaveAttribute('data-passed', 'true')
  await expect(page.getByTestId('section-index').locator('a[data-section="requirements"]')).toBeVisible()
  const requirements = page.getByTestId('requirements')
  await expect(requirements).not.toHaveAttribute('open', '')
  // The summary marks the checks gated at the candidate, with the browser check's scenarios.
  await expect(requirements.locator(':scope > summary')).toContainText('frontend-build (candidate) · frontend-unit · frontend-typecheck · project-workflows-browser (candidate: review-verdict, finding-to-task) · timeouts · attempt cap 3 per revision · owned paths (2)')
  await requirements.locator('summary').click()
  await expect(requirements.getByTestId('requirements-cap')).toHaveText('Attempt cap: 3 per revision')
  await expect(requirements.getByTestId('task-owned-paths')).toContainText('src/projects')
  await expect(requirements.getByTestId('task-checks').locator('[data-check-id="project-workflows-browser"]')).toContainText('timeout 5m')
  const identifiers = page.getByTestId('identifiers')
  await expect(identifiers).not.toHaveAttribute('open', '')
  await expect(identifiers).toContainText(UI_SESSION)
  const text = await nodeDetail(page).evaluate(element => element.textContent ?? '')
  expect(text.split(UI_SESSION).length - 1, 'the session id is shown once').toBe(1)
  await renderedText(nodeDetail(page))
  await expectNoExecutionControls(page)
})

test(`[scenario:candidate-lanes-table] The combined candidate opens on its lanes, failing lanes first and open, passing lanes closed; screenshots open full size in a dialog (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(nodeUrl('candidate'))
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'candidate')
  const lanes = page.getByTestId('lane-results')
  await expect(lanes).toBeVisible()
  const rows = lanes.locator('[data-testid^="lane-result:"]')
  await expect(rows).toHaveCount(2)
  // The failing lane is sorted first and open; its row names the gate's reason.
  await expect(rows.nth(0)).toHaveAttribute('data-testid', 'lane-result:adapter')
  await expect(rows.nth(1)).toHaveAttribute('data-testid', 'lane-result:ui')
  const adapter = page.getByTestId('lane-result:adapter')
  const ui = page.getByTestId('lane-result:ui')
  await expect(adapter).toHaveAttribute('open', '')
  await expect(ui).not.toHaveAttribute('open', '')
  await expect(adapter.locator(':scope > summary')).toContainText(CANDIDATE_REJECTED)
  await expect(adapter.locator(':scope > summary')).toContainText('2 of 2 exit 0, 1 rejected')
  await expect(ui.locator(':scope > summary')).toContainText('3 of 3')

  // The open lane shows its rejected check red at exit 0 with its log tail open, and the log that belongs to no check.
  const contract = checkRow(adapter, 'backend-contract')
  await expect(contract).toHaveAttribute('data-state', 'rejected')
  await expect(contract.locator('[data-testid^="artifact-text:"]')).toBeVisible()
  await expect(adapter.getByTestId('worker-error')).toContainText('Failed: 1 check rejected')
  await expect(adapter.getByTestId('artifacts')).toContainText(SETUP_LOG_ID)
  await expect(adapter.getByTestId('artifacts')).toContainText('log (not a check log)')
  // The closed Artifacts summary names the kinds it holds.
  await expect(adapter.getByTestId('artifacts-summary')).toContainText('log (not a check log)')
  // The lane's worker report is linked from its body, besides the row's link to its files.
  await expect(adapter.getByTestId('worker-report-link').getByRole('link')).toHaveAttribute('href', runUrl(RUN_REJECTED_CHECKS, 'launch_adapter', UX_VERIFY_WORKFLOW_ID))
  await expect(adapter.getByTestId('lane-files-link').getByRole('link')).toHaveAttribute('href', runUrl(RUN_REJECTED_CHECKS, 'launch_adapter', UX_VERIFY_WORKFLOW_ID))
  // A failing lane's row says which attempt of the cap it is.
  await expect(adapter.getByTestId('lane-note')).toHaveText('attempt 1 of 3')
  // Dropped: the per-lane ownership sentence (a tag in the gate line now) and the fixed introduction.
  await expect(lanes.getByTestId('ownership-outcome')).toHaveCount(0)
  await expect(lanes).not.toContainText('each lane\'s result, with its checks and screenshots, is shown below')
  await attach(page, testInfo, 'candidate-lanes-table')

  // A passing lane opens on demand; a thumbnail opens its screenshot full size in a dialog that Esc closes.
  await ui.locator(':scope > summary').click()
  await expect(ui).toHaveAttribute('open', '')
  // On a candidate lane the screenshots sit in the browser check's row, not in a block of their own.
  await expect(ui.getByTestId('screenshots')).toHaveCount(1)
  const thumb = checkRow(ui, 'project-workflows-browser').getByTestId('screenshots').getByRole('button').first()
  await expect(thumb.locator('img')).toBeVisible()
  await expect.poll(() => thumb.locator('img').evaluate(image => (image as unknown as { getBoundingClientRect: () => { width: number } }).getBoundingClientRect().width)).toBeLessThanOrEqual(220)
  await thumb.click()
  const dialog = page.getByTestId('screenshot-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('img')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(thumb).toBeFocused()

  // Just above the card breakpoint the lane table still fits the node area.
  await page.setViewportSize({ width: 761, height: 900 })
  await expect.poll(() => overflow(lanes)).toBeLessThanOrEqual(0)

  // At phone width the lane rows wrap as cards; the page never scrolls sideways.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByTestId('lane-result:adapter')).toBeVisible()
  await expect.poll(() => pageWidth(page)).toBeLessThanOrEqual(390)
  await attach(page, testInfo, 'candidate-lanes-table-390')

  // A lane that failed identically says so under its row and points at the repair; each lane's check offsets count from
  // the start of its own candidate attempt (adapter passed on attempt 1, ui failed on attempt 2).
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(runUrl(RUN_IDENTICAL, 'candidate', UX_RUN_WORKFLOW_ID))
  const identical = page.getByTestId('lane-result:ui')
  await expect(identical.getByTestId('lane-note')).toHaveText('attempt 2 of 3 · failed identically on attempts 1 and 2 → repair (see Now)')
  const passedLane = page.getByTestId('lane-result:adapter')
  await passedLane.locator(':scope > summary').click()
  await expect(passedLane.getByTestId('checks-list').locator('.check').first().locator('.check-offset')).toHaveText(/^\+0:\d\d$/)
  await expect(identical.getByTestId('checks-list').locator('.check').first().locator('.check-offset')).toHaveText(/^\+0:\d\d$/)
  await expectNoExecutionControls(page)
})
