/**
 * Viewer UX slice S1 (docs/PRD_VIEWER_UX.md sections 5.3 and 6.3): every time is a `<time>` with its machine value and its
 * UTC tooltip, shown in the local zone or in UTC through a remembered toggle beside the run status; check rows carry their
 * duration; a live chip says whether the shown run is still polled and how fresh its data is; and Refresh reloads in the
 * background without blanking the page. The suite pins `timezoneId: 'UTC'`; the zone scenario runs west of UTC so that
 * local and UTC times differ.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { RUN_FAILED, RUN_SUCCEEDED } from './fixtures.ts'
import { apiRun, attach, expectNoExecutionControls, installHooks, nodeDetail, phase, runUrl } from './support.ts'

installHooks()

const liveStatus = (page: Page) => page.getByTestId('live-status')
const zoneButton = (page: Page, name: 'Local' | 'UTC') => page.getByTestId('time-zone-toggle').getByRole('button', { name, exact: true })
/** The `<time>` whose UTC tooltip names this instant (the first one in document order). */
const timeAt = (scope: Locator, utc: string) => scope.locator(`time[title="${utc}"]`).first()
const scrollY = (page: Page) => page.evaluate('window.scrollY') as Promise<number>

async function verticallyBeside(a: Locator, b: Locator): Promise<boolean> {
  const [boxA, boxB] = [await a.boundingBox(), await b.boundingBox()]
  if (boxA === null || boxB === null) return false
  return boxA.y < boxB.y + boxB.height && boxB.y < boxA.y + boxA.height
}

test.describe('in a zone west of UTC', () => {
  test.use({ timezoneId: 'America/Los_Angeles' })

  test(`[scenario:time-local-utc] Times are <time> elements in the local zone, switchable to UTC and remembered; check rows show durations (${phase})`, async ({ page }, testInfo) => {
    await page.goto(runUrl(RUN_SUCCEEDED))
    const view = page.getByTestId('run-view')
    await expect(view).toHaveAttribute('data-run-status', 'succeeded')

    // The run started at 10:00 UTC, 02:00 in Los Angeles; every time carries its ISO value and the full UTC time as tooltip.
    const created = timeAt(view, '2026-03-01 10:00:00 UTC')
    await expect(created).toHaveText('02:00')
    await expect(created).toHaveAttribute('datetime', /^2026-03-01T10:00:00/)
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
    await expect(created).toHaveText('10:00')
    await page.reload()
    await expect(zoneButton(page, 'UTC')).toHaveAttribute('aria-pressed', 'true')
    await expect(timeAt(page.getByTestId('run-view'), '2026-03-01 10:00:00 UTC')).toHaveText('10:00')

    // A check row names its start and end to the second, in the chosen zone, and how long it took.
    await page.goto(runUrl(RUN_SUCCEEDED, 'verify_ui'))
    const build = page.locator('#check-0')
    await expect(build.locator('.check-command')).toHaveText('npm run build')
    await expect(build.locator('.check-duration')).toHaveText('1m00s')
    await expect(timeAt(build, '2026-03-01 10:05:00 UTC')).toHaveText('10:05:00')
    await expect(timeAt(build, '2026-03-01 10:06:00 UTC')).toHaveText('10:06:00')
    await expect(page.locator('#check-2 .check-duration')).toHaveText('5m00s')
    await zoneButton(page, 'Local').click()
    await expect(timeAt(build, '2026-03-01 10:05:00 UTC')).toHaveText('02:05:00')
    await expectNoExecutionControls(page)
    await attach(page, testInfo, 'time-local-utc')
  })
})

test(`[scenario:live-freshness] A live chip says whether the run is polled and how fresh it is; Refresh keeps the page in place (${phase})`, async ({ page }, testInfo) => {
  test.setTimeout(90_000)
  const detailRequest = (url: URL) => url.pathname === apiRun(RUN_FAILED)

  // A succeeded run no longer changes, so it is not polled.
  await page.goto(runUrl(RUN_SUCCEEDED))
  await expect(liveStatus(page)).toHaveAttribute('data-state', 'finished')
  await expect(liveStatus(page)).toContainText('Finished · not polling')

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

  // Refresh reloads in the background: while the run is re-read, the node stays shown at the same scroll position and the
  // Refresh button is busy.
  await page.goto(runUrl(RUN_FAILED, 'verify_adapter'))
  await expect(page.getByTestId('checks-list')).toBeVisible()
  await expect(page.getByTestId('node-events')).toBeVisible()
  await page.evaluate('window.scrollTo(0, 400)')
  await expect.poll(() => scrollY(page)).toBe(400)
  const scrolled = await scrollY(page)
  let release = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route(detailRequest, async route => {
    await held
    await route.fallback().catch(() => undefined)
  })
  const refresh = page.getByRole('button', { name: /^Refresh/ })
  // A plain DOM click: Playwright's click would first scroll the header button into view.
  await refresh.dispatchEvent('click')
  await expect(page.getByText(`Loading run ${RUN_FAILED}`)).toHaveCount(0)
  await expect(nodeDetail(page)).toBeVisible()
  expect(await scrollY(page)).toBe(scrolled)
  await expect(refresh).toHaveAttribute('aria-busy', 'true')
  await expect(refresh).toBeDisabled()
  release()
  await expect(refresh).toHaveAttribute('aria-busy', 'false')
  await expect(refresh).toBeEnabled()
  await expect(nodeDetail(page)).toBeVisible()
  expect(await scrollY(page)).toBe(scrolled)
  await expectNoExecutionControls(page)
})
