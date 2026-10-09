/**
 * Viewer UX slice S1 (docs/PRD_VIEWER_UX.md sections 5.3 and 6.3): every time is a `<time>` with its machine value and its
 * UTC tooltip, shown in the local zone or in UTC through a remembered toggle beside the run status; a run page names the
 * day its run started unless that is today, and reads its other times against that day; lists re-read "today" after
 * midnight; check rows carry their duration; a live chip says whether the shown run is still polled and how fresh its data
 * is; and Refresh reloads in the background without blanking the page, keeps the keyboard focus, announces its outcome and
 * says when it failed. The suite pins `timezoneId: 'UTC'`; the zone scenario runs west of UTC so that local and UTC times
 * differ, and fixes the page's clock where the day matters.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { PROJECT, RUN_FAILED, RUN_SUCCEEDED, WORKFLOW_ID } from './fixtures.ts'
import { RUN_SHORT_CHECK, UX_TIME_WORKFLOW_ID } from './fixtures/ux-time.ts'
import { apiRun, attach, expectNoExecutionControls, installHooks, nodeDetail, openRunDetails, phase, runUrl, workflowUrl } from './support.ts'

installHooks()

const liveStatus = (page: Page) => page.getByTestId('live-status')
const zoneButton = (page: Page, name: 'Local' | 'UTC') => page.getByTestId('time-zone-toggle').getByRole('button', { name, exact: true })
/** The `<time>` whose UTC tooltip names this instant (the first one in document order). */
const timeAt = (scope: Locator, utc: string) => scope.locator(`time[title="${utc}"]`).first()
const scrollY = (page: Page) => page.evaluate('window.scrollY') as Promise<number>
/** The app's polite announcer (the run page has other `status` elements, such as the live chip's). */
const announcer = (page: Page) => page.locator('[role="status"][aria-live="polite"]')
const HEADER_REFRESH = '.app-header button'
const refreshHasFocus = (page: Page) => page.evaluate(`document.activeElement === document.querySelector('${HEADER_REFRESH}')`) as Promise<boolean>

async function verticallyBeside(a: Locator, b: Locator): Promise<boolean> {
  const [boxA, boxB] = [await a.boundingBox(), await b.boundingBox()]
  if (boxA === null || boxB === null) return false
  return boxA.y < boxB.y + boxB.height && boxB.y < boxA.y + boxA.height
}

test.describe('in a zone west of UTC', () => {
  test.use({ timezoneId: 'America/Los_Angeles' })

  test(`[scenario:time-local-utc] Times are <time> elements in the local zone, switchable to UTC and remembered; the run's day is named; check rows show durations (${phase})`, async ({ page }, testInfo) => {
    // The day after the run started, in both zones (04:00 in Los Angeles).
    await page.clock.setFixedTime('2026-03-02T12:00:00Z')
    await page.goto(runUrl(RUN_SUCCEEDED))
    const view = page.getByTestId('run-view')
    await expect(view).toHaveAttribute('data-run-status', 'succeeded')

    // The run started at 10:00 UTC, 02:00 in Los Angeles; every time carries its ISO value and the full UTC time as tooltip.
    // The start is read against today, so it names its day; the page's other times are read against the start's day. The
    // created and export times are pinned facts behind the identity line's Details.
    await openRunDetails(page)
    const created = timeAt(view, '2026-03-01 10:00:00 UTC')
    const updated = timeAt(view, '2026-03-01 10:45:00 UTC')
    await expect(created).toBeVisible()
    await expect(created).toHaveText('yesterday 02:00')
    await expect(created).toHaveAttribute('datetime', /^2026-03-01T10:00:00/)
    await expect(updated).toHaveText('02:45')
    expect(await view.locator('time').count()).toBeGreaterThan(1)
    await expect(view.locator('time:not([datetime]), time:not([title])')).toHaveCount(0)
    await expect(view).not.toContainText('2026-03-01 10:00:00 UTC')

    // The toggle sits beside the run status and switches every time on the page; the choice survives a reload.
    const toggle = page.getByTestId('time-zone-toggle')
    expect(await verticallyBeside(toggle, page.getByTestId('run-status'))).toBe(true)
    await expect(zoneButton(page, 'Local')).toHaveAttribute('aria-pressed', 'true')
    await zoneButton(page, 'UTC').click()
    await expect(zoneButton(page, 'UTC')).toHaveAttribute('aria-pressed', 'true')
    await expect(zoneButton(page, 'Local')).toHaveAttribute('aria-pressed', 'false')
    await expect(created).toHaveText('yesterday 10:00')
    // Months later, a run from another day still names its date.
    await page.clock.setFixedTime('2026-09-24T12:00:00Z')
    await page.reload()
    await expect(zoneButton(page, 'UTC')).toHaveAttribute('aria-pressed', 'true')
    await openRunDetails(page)
    await expect(timeAt(page.getByTestId('run-view'), '2026-03-01 10:00:00 UTC')).toHaveText('Mar 1 10:00')
    await expect(timeAt(page.getByTestId('run-view'), '2026-03-01 10:45:00 UTC')).toHaveText('10:45')

    // A check row names its start and end to the second, in the chosen zone, and how long it took; a node's times are on
    // the run's start day, so they carry no date.
    await page.goto(runUrl(RUN_SUCCEEDED, 'verify_ui'))
    const build = page.locator('#check-0')
    await expect(build.locator('.check-command')).toHaveText('npm run build')
    await expect(build.locator('.check-duration')).toHaveText('1m00s')
    await expect(timeAt(build, '2026-03-01 10:05:00 UTC')).toHaveText('10:05:00')
    await expect(timeAt(build, '2026-03-01 10:06:00 UTC')).toHaveText('10:06:00')
    await expect(page.locator('#check-2 .check-duration')).toHaveText('5m00s')
    // A 2.54 s check reads 3s.
    await page.goto(runUrl(RUN_SHORT_CHECK, 'verify_ui', UX_TIME_WORKFLOW_ID))
    const short = page.locator('#check-0')
    await expect(short.locator('.check-duration')).toHaveText('3s')
    await expect(timeAt(short, '2026-03-01 10:05:00 UTC')).toHaveText('10:05:00')
    await zoneButton(page, 'Local').click()
    await expect(timeAt(short, '2026-03-01 10:05:00 UTC')).toHaveText('02:05:00')
    await expectNoExecutionControls(page)
    await attach(page, testInfo, 'time-local-utc')

    // On a phone the two zone buttons are full tap targets.
    await page.setViewportSize({ width: 390, height: 844 })
    for (const name of ['Local', 'UTC'] as const) {
      const box = await zoneButton(page, name).boundingBox()
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44)
    }
  })

  test(`A run list left open past midnight re-reads which day is today (${phase})`, async ({ page }) => {
    // 23:59:30 in Los Angeles on the day the runs were created; the list shows their clocks only.
    await page.clock.install({ time: new Date('2026-03-02T07:59:30Z') })
    await page.goto(workflowUrl(PROJECT.project_id, WORKFLOW_ID))
    const updated = timeAt(page.getByTestId('run-list').locator(`[data-run-id="${RUN_SUCCEEDED}"]`), '2026-03-01 10:45:00 UTC')
    await expect(updated).toHaveText('02:45')
    // A minute later it is the next day: the same rows, still polled and never remounted, now read "yesterday".
    await page.clock.fastForward('01:00')
    await expect(updated).toHaveText('yesterday 02:45')
  })
})

test(`[scenario:live-freshness] A live chip says whether the run is polled and how fresh it is; Refresh keeps the page in place (${phase})`, async ({ page }, testInfo) => {
  test.setTimeout(90_000)
  const detailRequest = (url: URL) => url.pathname === apiRun(RUN_FAILED)
  const succeededRequest = (url: URL) => url.pathname === apiRun(RUN_SUCCEEDED)
  const refresh = page.getByRole('button', { name: /^Refresh/ })
  const refreshFailed = page.getByTestId('refresh-failed')

  // A succeeded run no longer changes, so it is not polled.
  await page.goto(runUrl(RUN_SUCCEEDED))
  await expect(liveStatus(page)).toHaveAttribute('data-state', 'finished')
  await expect(liveStatus(page)).toContainText('Finished · not polling')

  // A Refresh that fails keeps the run shown and says so, with the time of the data shown, until a load succeeds again.
  await page.route(succeededRequest, route => route.abort('connectionrefused'))
  await refresh.click()
  await expect(refreshFailed).toBeVisible()
  await expect(refreshFailed).toContainText('Refresh failed')
  await expect(refreshFailed).toContainText('may be outdated')
  await expect(refreshFailed.locator('time[datetime][title]')).toHaveCount(1)
  await expect(announcer(page)).toContainText('Refresh failed')
  await expect(page.getByTestId('run-view')).toHaveAttribute('data-run-status', 'succeeded')
  await expect(page.getByTestId('projects-error')).toHaveCount(0)
  await page.unroute(succeededRequest)
  await refresh.click()
  await expect(refreshFailed).toHaveCount(0)
  await expect(announcer(page)).toContainText(`Refreshed. Loaded run ${RUN_SUCCEEDED}`)

  // A failed run is still watched, because it can be repaired or resumed.
  await page.goto(runUrl(RUN_FAILED))
  const view = page.getByTestId('run-view')
  await expect(view).toHaveAttribute('data-run-status', 'failed')
  await expect(liveStatus(page)).toHaveAttribute('data-state', 'watching')
  await expect(liveStatus(page)).toContainText(/Watching · updated (just now|\d+ s ago)/)

  // Two failed polls in a row: the chip says the page is not updating, and the last loaded run stays shown.
  await page.route(detailRequest, route => route.abort('connectionrefused'))
  await expect(liveStatus(page)).toHaveAttribute('data-state', 'stale', { timeout: 20_000 })
  await expect(liveStatus(page)).toContainText('Not updating · showing data from')
  await expect(view).toHaveAttribute('data-run-status', 'failed')
  await expect(page.getByTestId('projects-error')).toHaveCount(0)
  await attach(page, testInfo, 'live-freshness')
  await page.unroute(detailRequest)
  await expect(liveStatus(page)).toHaveAttribute('data-state', 'watching', { timeout: 15_000 })

  // Refresh reloads in the background: while the run is re-read, the node stays shown at the same scroll position, the
  // Refresh button is busy and keeps the keyboard focus, and its outcome is announced.
  await page.goto(runUrl(RUN_FAILED, 'verify_adapter'))
  await expect(page.getByTestId('checks-list')).toBeVisible()
  await expect(page.getByTestId('node-events')).toBeVisible()
  // A scroll the compact verify page allows in both phases (its closed disclosures leave about 180 px to scroll at 720 px).
  await page.evaluate('window.scrollTo(0, 120)')
  await expect.poll(() => scrollY(page)).toBe(120)
  const scrolled = await scrollY(page)
  let release = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route(detailRequest, async route => {
    await held
    await route.fallback().catch(() => undefined)
  })
  // Focused without scrolling the header into view, then pressed from the keyboard.
  await page.evaluate(`document.querySelector('${HEADER_REFRESH}').focus({ preventScroll: true })`)
  await page.keyboard.press('Enter')
  await expect(page.getByText(`Loading run ${RUN_FAILED}`)).toHaveCount(0)
  await expect(nodeDetail(page)).toBeVisible()
  expect(await scrollY(page)).toBe(scrolled)
  await expect(refresh).toHaveAttribute('aria-busy', 'true')
  await expect(refresh).toBeDisabled()
  expect(await refreshHasFocus(page)).toBe(true)
  release()
  await expect(refresh).toHaveAttribute('aria-busy', 'false')
  await expect(refresh).toBeEnabled()
  expect(await refreshHasFocus(page)).toBe(true)
  await expect(announcer(page)).toContainText(`Refreshed. Loaded run ${RUN_FAILED}`)
  await expect(nodeDetail(page)).toBeVisible()
  expect(await scrollY(page)).toBe(scrolled)
  await expectNoExecutionControls(page)
})
