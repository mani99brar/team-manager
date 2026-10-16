/**
 * Run controls on the run page (docs/PRD_RUN_CONTROLS.md section 6, features/run-controls/policy.json): pairing the browser,
 * the Controls list and its reasons, a confirmation per control, the dock's Run button and Controls row, typed run ids and
 * the controller's refusals. The worker phase mocks `/api/run-controls/**` from Appendix A (`mock.ts`); the candidate phase
 * runs against the real backend with the fake controller (`fixtures/controls.ts`, `fake-controller.py`).
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { COMMAND_CAPTION } from '../../contracts/projects/triage.ts'
import { TOKEN_KEY } from '../../src/projects/controls/types.ts'
import {
  CONTROLS_TOKEN, CONTROLS_WORKFLOW_ID, RUN_APPROVAL, RUN_FINISHED, RUN_QUESTION, RUN_REFUSE, RUN_REPAIR, RUN_RUNNING, RUN_STOPPED, WAITING_QUESTION,
  OLDER_CONTROLLER_REASONS, RELAUNCH_ALLOWED, RELAUNCH_REFUSED, RUN_RELAUNCH, RUN_RELAUNCH_REFUSE, RUN_RETRY_ALL,
} from './fixtures/controls.ts'
import { installControlMocks, installProjectMocks } from './mock.ts'
import { attach, installHooks, phase, runUrl } from './support.ts'

installHooks()

test.beforeEach(async ({ page }) => {
  if (phase === 'worker') await installControlMocks(page)
})

const url = (runId: string) => runUrl(runId, undefined, CONTROLS_WORKFLOW_ID)
const dock = (page: Page) => page.getByTestId('live-dock')
const dialog = (page: Page) => page.getByTestId('control-dialog')
const confirmButton = (page: Page) => page.getByTestId('dialog-confirm')

/** Every request the page makes to the run-controls routes: method and path after `/api/run-controls`. */
function watch(page: Page): { method: string; path: string }[] {
  const seen: { method: string; path: string }[] = []
  page.on('request', request => {
    const parsed = new URL(request.url())
    if (parsed.pathname.startsWith('/api/run-controls/')) seen.push({ method: request.method(), path: parsed.pathname.slice('/api/run-controls'.length) })
  })
  return seen
}
const posts = (seen: { method: string; path: string }[], suffix = '') => seen.filter(item => item.method === 'POST' && item.path.endsWith(suffix))

/** Opens a run page, paired with the suite's token unless told otherwise, with the live dock open. */
async function open(page: Page, runId: string, options: { paired?: boolean } = {}) {
  if (options.paired ?? true) await page.addInitScript(`window.localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(CONTROLS_TOKEN)})`)
  await page.goto(url(runId))
  await expect(page.getByTestId('run-header')).toBeVisible()
  await expect(dock(page)).toBeVisible()
  if ((await dock(page).getAttribute('data-open')) !== 'true') await page.getByTestId('live-dock-bar').click()
  await expect(page.getByTestId('now-next')).toBeVisible()
}

async function openControls(page: Page): Promise<Locator> {
  await page.getByTestId('controls-button').click()
  const panel = page.getByTestId('controls-panel')
  await expect(panel).toBeVisible()
  return panel
}

async function chooseControl(page: Page, id: string) {
  await openControls(page)
  await expect(page.getByTestId('controls-list')).toBeVisible()
  await page.getByTestId(`control-${id}-button`).click()
  await expect(dialog(page)).toHaveAttribute('data-control', id)
}

/** The opened panel lies inside the viewport and its first and last control labels can be seen (decisions [L6] 4). */
async function panelInside(page: Page, width: number) {
  const box = (await page.getByTestId('controls-panel').boundingBox())!
  expect(box.x, `panel left edge at ${width}`).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width, `panel right edge at ${width}`).toBeLessThanOrEqual(width)
  const labels = page.locator('[data-testid="controls-list"] .ctl-label')
  await labels.first().scrollIntoViewIfNeeded()
  await expect(labels.first()).toBeVisible()
  await labels.last().scrollIntoViewIfNeeded()
  await expect(labels.last()).toBeVisible()
}

const noSideways = async (page: Page) => (await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')) === true

test(`[scenario:controls-off] With controls off the run page is today's: Copy only, the viewer-never-changes caption, no Controls button (${phase})`, async ({ page }, testInfo) => {
  const requests = watch(page)
  // Whatever the backend is, the probe says the controls are off; nothing else may then be asked of them.
  await page.route('**/api/run-controls/status', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: '1.0.0', enabled: false, paired: false }) }))
  await open(page, RUN_STOPPED)
  await expect(page.getByTestId('now-command').first()).toContainText('automatic')
  await expect(page.getByTestId('copy-command').first()).toBeVisible()
  await expect(page.getByTestId('run-command')).toHaveCount(0)
  await expect(page.getByTestId('now-next').locator('.command-caption')).toHaveText(COMMAND_CAPTION)
  await expect(page.getByTestId('controls-button')).toHaveCount(0)
  await page.waitForTimeout(500)
  expect(requests.map(item => `${item.method} ${item.path}`)).toEqual(['GET /status'])
  await attach(page, testInfo, 'controls-off')
})

test(`[scenario:controls-pair] The Controls button pairs this browser with one token field; a wrong token is refused, the right one shows the list and survives a reload (${phase})`, async ({ page }, testInfo) => {
  await open(page, RUN_STOPPED, { paired: false })
  // Unpaired, the page keeps today's caption and offers no Run.
  await expect(page.getByTestId('run-command')).toHaveCount(0)
  await expect(page.getByTestId('now-next').locator('.command-caption')).toHaveText(COMMAND_CAPTION)
  const panel = await openControls(page)
  await expect(panel.getByRole('heading', { name: 'Pair this browser' })).toBeVisible()
  await expect(panel.locator('input')).toHaveCount(1)
  await expect(page.getByTestId('controls-list')).toHaveCount(0)

  await panel.getByTestId('pair-token').fill('this-is-not-the-pairing-token-0000000000')
  await panel.getByTestId('pair-submit').click()
  await expect(panel.getByTestId('pair-refused')).toContainText('refused')
  await expect(panel.getByTestId('pair-token')).toBeVisible()
  await expect(panel.getByTestId('pair-token')).toHaveValue('')

  await panel.getByTestId('pair-token').fill(CONTROLS_TOKEN)
  await panel.getByTestId('pair-submit').click()
  await expect(page.getByTestId('controls-list')).toBeVisible()
  await expect(page.getByTestId('pair-token')).toHaveCount(0)
  expect(await page.content(), 'the token is never shown again').not.toContain(CONTROLS_TOKEN)
  await attach(page, testInfo, 'controls-pair')

  await page.reload()
  await expect(page.getByTestId('run-header')).toBeVisible()
  await page.getByTestId('controls-button').click()
  await expect(page.getByTestId('controls-list')).toBeVisible()
  await expect(page.getByTestId('pair-token')).toHaveCount(0)
  expect(await page.content()).not.toContain(CONTROLS_TOKEN)
})

test(`[scenario:controls-restart] Run beside Copy restarts a stopped supervisor after a confirmation; one POST, a Controls row from running to succeeded (${phase})`, async ({ page }, testInfo) => {
  const requests = watch(page)
  await open(page, RUN_STOPPED)
  const run = page.getByTestId('run-command')
  await expect(run).toBeVisible()
  await expect(page.getByTestId('copy-command').first()).toBeVisible()
  await expect(page.getByTestId('now-next').locator('.command-caption')).toHaveText('Run it here, or in your terminal.')

  // Escape sends nothing and returns focus to Run.
  await run.click()
  await expect(dialog(page)).toBeVisible()
  await expect(dialog(page).getByRole('heading', { name: 'Restart supervisor' })).toBeVisible()
  await expect(page.getByTestId('dialog-command')).toContainText('automatic "$RUN" --live')
  await expect(page.getByTestId('dialog-command')).not.toContainText('/home/')
  await expect(page.getByTestId('dialog-effect')).toContainText('What it does')
  await expect(page.getByTestId('dialog-not-effect')).toContainText('What it does not do')
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toHaveCount(0)
  await expect(run).toBeFocused()
  expect(posts(requests)).toHaveLength(0)

  await run.click()
  await attach(page, testInfo, 'controls-restart')
  // A second click while the request is in flight sends nothing.
  await confirmButton(page).evaluate(button => { const target = button as unknown as { click(): void }; target.click(); target.click() })
  const row = page.getByTestId('controls-row')
  await expect(row).toBeVisible()
  await expect(row).toContainText('Restart supervisor')
  // While it runs the row already holds the controller's first line (decisions [L6] 5): one locator, so the short window cannot race the steps.
  await expect(row.locator('[data-testid="control-log"]')).toContainText('Supervisor starting')
  await expect(row).toHaveAttribute('data-status', /running|succeeded/)
  await row.getByText('Log tail').click()
  await expect(row.getByTestId('control-log')).toHaveAttribute('open', '')
  await expect(row).toHaveAttribute('data-status', 'succeeded', { timeout: 15_000 })
  await expect(row.getByTestId('control-log'), 'the disclosure stays open across the polls').toHaveAttribute('open', '')
  expect(posts(requests, '/restart')).toHaveLength(1)
  expect(posts(requests)).toHaveLength(1)

  // A second restart makes two records; Run Details lists them newest first (decisions [L6] 6f).
  await run.click()
  await confirmButton(page).click()
  await expect(page.getByTestId('control-history-item')).toHaveCount(2, { timeout: 15_000 })
  await page.getByTestId('run-details').locator('summary').first().click()
  const stamps = await page.getByTestId('control-history-item').evaluateAll(items => items.map(item => item.getAttribute('data-started-at') ?? ''))
  expect(Date.parse(stamps[0]), 'newest record first').toBeGreaterThanOrEqual(Date.parse(stamps[1]))
  await expect(page.getByTestId('controls-history')).toBeVisible()
  await expect(row).toHaveAttribute('data-status', 'succeeded', { timeout: 15_000 })
})

test(`[scenario:controls-unavailable] The Controls list greys what is unavailable with the server's reason; Pause says the workers keep running (${phase})`, async ({ page }, testInfo) => {
  // Sixteen fresh page loads (four widths x four runs) do not fit the default 30 s on a 4-core host.
  test.slow()
  await open(page, RUN_RUNNING)
  await openControls(page)
  await expect(page.locator('[data-testid="controls-list"] > li')).toHaveCount(15)
  await expect(page.getByTestId('control-pause')).toHaveAttribute('data-available', 'true')
  await expect(page.getByTestId('control-pause')).toContainText('workers keep running')
  for (const id of ['restart', 'retry', 'reconcile', 'abandon', 'clean']) {
    const item = page.getByTestId(`control-${id}`)
    await expect(item).toHaveAttribute('data-available', 'false')
    await expect(item.getByTestId('control-reason')).toContainText('A supervisor is running')
    if (phase === 'worker') await expect(item.getByTestId('control-reason')).toContainText(/since \d{2}:\d{2}/)
  }
  await attach(page, testInfo, 'controls-unavailable')

  // Opening the list moves focus into it; Escape closes it and returns focus to the Controls button (decisions [L6] 6d).
  await expect(page.locator('#ctl-list-title')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('controls-panel')).toHaveCount(0)
  await expect(page.getByTestId('controls-button')).toBeFocused()

  // The list stays on screen at every desktop width, for four kinds of run (decisions [L6] 4).
  for (const width of [1280, 1400, 1024, 1920]) {
    for (const runId of [RUN_RUNNING, RUN_FINISHED, RUN_REPAIR, RUN_QUESTION]) {
      // A fresh page per run: sixteen loads in one page exhaust the browser's memory.
      const fresh = await page.context().newPage()
      try {
        if (phase === 'worker') { await installProjectMocks(fresh); await installControlMocks(fresh) }
        await fresh.setViewportSize({ width, height: 900 })
        await open(fresh, runId)
        await openControls(fresh)
        await expect(fresh.getByTestId('controls-list')).toBeVisible()
        await panelInside(fresh, width)
      } finally {
        await fresh.close()
      }
    }
  }
  await open(page, RUN_RUNNING)
  await openControls(page)

  // An unavailable control opens nothing; Pause's confirmation says the workers keep running.
  await page.getByTestId('control-restart-button').click({ force: true })
  await expect(dialog(page)).toHaveCount(0)
  await page.getByTestId('control-pause-button').click()
  await expect(dialog(page)).toHaveAttribute('data-control', 'pause')
  await expect(page.getByTestId('dialog-not-effect')).toContainText('sessions keep running')
  await page.getByTestId('dialog-cancel').click()
  await expect(dialog(page)).toHaveCount(0)

  // A finished run offers Clean and greys Restart with a reason.
  await open(page, RUN_FINISHED)
  await openControls(page)
  await expect(page.getByTestId('control-clean')).toHaveAttribute('data-available', 'true')
  await expect(page.getByTestId('control-restart')).toHaveAttribute('data-available', 'false')
  await expect(page.getByTestId('control-restart').getByTestId('control-reason')).not.toBeEmpty()
})

test(`[scenario:controls-answer] A waiting question is answered from the dock or the list: the question, a text field, Confirm off while empty, one send (${phase})`, async ({ page }, testInfo) => {
  const requests = watch(page)
  await open(page, RUN_QUESTION)
  await openControls(page)
  await expect(page.getByTestId('control-answer')).toHaveAttribute('data-available', 'true')
  await page.getByTestId('controls-close').click()
  const run = page.getByTestId('run-command')
  await expect(run).toHaveAccessibleName(/Answer the question/)
  await run.click()
  await expect(dialog(page)).toHaveAttribute('data-control', 'answer')
  await expect(page.getByTestId('dialog-question')).toContainText(WAITING_QUESTION)
  await expect(page.getByTestId('dialog-question')).toContainText('Question 2')
  await expect(confirmButton(page)).toBeDisabled()
  await page.getByTestId('param-text').fill('In the identity line, beside Details.')
  await expect(confirmButton(page)).toBeEnabled()
  await attach(page, testInfo, 'controls-answer')
  await confirmButton(page).click()
  await expect(page.getByTestId('controls-row')).toHaveAttribute('data-status', 'succeeded', { timeout: 15_000 })
  await expect(page.getByTestId('control-headline')).toContainText('Answer by the operator')
  expect(posts(requests, '/answer')).toHaveLength(1)
})

test(`[scenario:controls-typed-confirm] Abandon, Approve, Repair a lane and Clean keep Confirm off until the run id is typed; Clean shows its dry run first (${phase})`, async ({ page }, testInfo) => {
  const requests = watch(page)
  const typedGate = async (runId: string, id: string) => {
    await open(page, runId)
    await chooseControl(page, id)
    await expect(confirmButton(page)).toBeDisabled()
    return page.getByTestId('param-confirm_run_id')
  }
  const proves = async (field: Locator, runId: string) => {
    await field.fill(`${runId}x`)
    await expect(confirmButton(page)).toBeDisabled()
    await field.fill(runId)
    await expect(confirmButton(page)).toBeEnabled()
    await page.getByTestId('dialog-cancel').click()
    await expect(dialog(page)).toHaveCount(0)
  }

  // Abandon also needs its reason.
  let field = await typedGate(RUN_STOPPED, 'abandon')
  await field.fill(RUN_STOPPED)
  await expect(confirmButton(page), 'the reason is missing').toBeDisabled()
  await page.getByTestId('param-reason').fill('The design changed; start a follow-up run.')
  await expect(confirmButton(page)).toBeEnabled()
  await field.fill('')
  await proves(field, RUN_STOPPED)

  field = await typedGate(RUN_APPROVAL, 'approve')
  await expect(page.getByTestId('dialog-command')).toContainText('a7a7a7a7a7a7')
  await proves(field, RUN_APPROVAL)

  field = await typedGate(RUN_REPAIR, 'repair_session')
  await proves(field, RUN_REPAIR)

  field = await typedGate(RUN_FINISHED, 'clean')
  await expect(page.getByTestId('clean-preview')).toContainText('Would remove worktree-ui')
  await attach(page, testInfo, 'controls-typed-confirm')
  await proves(field, RUN_FINISHED)
  expect(posts(requests).filter(item => !item.path.endsWith('/clean-preview')), 'nothing was confirmed').toHaveLength(0)
})

test(`[scenario:controls-refused] A refused control shows failed with its Blocked line first; 409 STATE_CHANGED and BUSY are said plainly and never resent (${phase})`, async ({ page }, testInfo) => {
  const requests = watch(page)
  // The controller refuses every command on a run whose id contains "refuse".
  await open(page, RUN_REFUSE)
  await page.getByTestId('run-command').click()
  await confirmButton(page).click()
  const row = page.getByTestId('controls-row')
  await expect(row).toHaveAttribute('data-status', 'failed', { timeout: 15_000 })
  await expect(page.getByTestId('control-record')).toContainText('failed')
  await expect(page.getByTestId('control-headline')).toHaveText(/^Blocked:/)
  await row.getByText('Log tail').click()
  await expect(row.locator('pre')).toContainText(/^Blocked:/)
  await attach(page, testInfo, 'controls-refused')

  // 409s: answered by routes in both phases, the page must neither resend nor stay silent.
  await open(page, RUN_STOPPED)
  let answers = ['STATE_CHANGED', 'BUSY']
  await page.route('**/api/run-controls/*/*/*/restart', route => {
    const code = answers.shift()
    return code === undefined ? route.fallback() : route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code, message: code } }) })
  })
  const before = requests.filter(item => item.method === 'GET' && !item.path.startsWith('/status')).length
  const sent = posts(requests, '/restart').length
  await page.getByTestId('run-command').click()
  await confirmButton(page).click()
  await expect(page.getByTestId('dialog-alert')).toContainText('The run changed since you looked')
  await page.waitForTimeout(600)
  expect(posts(requests, '/restart').length - sent, 'a 409 is not resent').toBe(1)
  expect(requests.filter(item => item.method === 'GET' && !item.path.startsWith('/status')).length, 'the controls were read again').toBeGreaterThan(before)
  await confirmButton(page).click()
  await expect(page.getByTestId('dialog-alert')).toContainText('Another control of this run is running')
  expect(posts(requests, '/restart').length - sent).toBe(2)
  answers = []
  await page.getByTestId('dialog-cancel').click()
  await expect(dialog(page)).toHaveCount(0)
})

test(`[scenario:controls-phone] At 390 px the Controls list is a bottom sheet and the dialog fits with its command wrapped, nothing scrolls sideways (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await open(page, RUN_STOPPED)
  const panel = await openControls(page)
  await expect(page.getByTestId('controls-list')).toBeVisible()
  const box = (await panel.boundingBox())!
  expect(box.x, 'the sheet spans the width').toBeLessThanOrEqual(1)
  expect(box.width).toBeGreaterThanOrEqual(388)
  expect(box.y + box.height, 'the sheet sits at the bottom').toBeGreaterThanOrEqual(840)
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  for (const id of ['restart', 'pause', 'abandon', 'clean']) {
    await page.getByTestId(`control-${id}-button`).scrollIntoViewIfNeeded()
    await expect(page.getByTestId(`control-${id}-button`)).toBeVisible()
    await expect(page.getByTestId(`control-${id}`).locator('.ctl-sub')).toBeVisible()
  }
  expect(await noSideways(page)).toBe(true)
  await attach(page, testInfo, 'controls-phone')

  await page.getByTestId('control-restart-button').click()
  await expect(dialog(page)).toBeVisible()
  const frame = (await dialog(page).boundingBox())!
  expect(frame.x).toBeGreaterThanOrEqual(0)
  expect(frame.x + frame.width).toBeLessThanOrEqual(391)
  expect(frame.y + frame.height).toBeLessThanOrEqual(845)
  expect(await page.getByTestId('dialog-command').evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'the command wraps').toBe(true)
  expect(await noSideways(page)).toBe(true)
})

test(`[scenario:controls-recovery] Retry all failed checks reruns both failed lanes through the controller; Relaunch a lane shows the dry run's verdict before Confirm (${phase})`, async ({ page }, testInfo) => {
  test.slow()
  await page.setViewportSize({ width: 1440, height: 900 })
  const requests = watch(page)
  // Two worker lanes failed their checks: Retry all is offered, names the controller's command, and records its lines.
  await open(page, RUN_RETRY_ALL)
  await openControls(page)
  await expect(page.locator('[data-testid="controls-list"] > li')).toHaveCount(15)
  await expect(page.getByTestId('control-retry_all')).toHaveAttribute('data-available', 'true')
  await expect(page.getByTestId('control-retry_all')).toContainText('Retry all failed checks')
  await page.getByTestId('control-retry_all-button').click()
  await expect(dialog(page)).toHaveAttribute('data-control', 'retry_all')
  await expect(page.getByTestId('dialog-command')).toContainText('retry "$RUN" --phase worker --all-failed --by operator')
  await expect(page.getByTestId('dialog-effect')).toContainText('Restart supervisor')
  await confirmButton(page).click()
  const row = page.getByTestId('controls-row')
  await expect(row).toContainText('Retry all failed checks')
  await expect(row).toHaveAttribute('data-status', 'succeeded', { timeout: 15_000 })
  await expect(row.getByTestId('control-log')).toContainText('worker/ui will run attempt 2')
  await expect(row.getByTestId('control-log')).toContainText('worker/adapter will run attempt 2')
  expect(posts(requests, '/retry_all')).toHaveLength(1)
  expect(posts(requests)).toHaveLength(1)

  // One failed lane: unavailable, with the reason.
  await open(page, RUN_REPAIR)
  await openControls(page)
  await expect(page.locator('[data-testid="controls-list"] > li')).toHaveCount(15)
  await expect(page.getByTestId('control-retry_all')).toHaveAttribute('data-available', 'false')
  await expect(page.getByTestId('control-retry_all').getByTestId('control-reason')).toHaveText('Fewer than two worker checks failed')
  await page.keyboard.press('Escape')

  // A lane launch that needs reconciliation and left no live session: Relaunch a lane, ui its only choice, the dry run first.
  await open(page, RUN_RELAUNCH)
  await chooseControl(page, 'relaunch')
  await expect(page.getByTestId('param-lane').locator('option')).toHaveText(['ui'])
  await expect(page.getByTestId('relaunch-preview-line')).toHaveText(RELAUNCH_ALLOWED, { timeout: 15_000 })
  await expect(confirmButton(page)).toBeEnabled()
  await expect(page.getByTestId('dialog-effect')).toContainText('Reconcile launches and then Restart supervisor')
  await attach(page, testInfo, 'controls-recovery')
  const previews = posts(requests, '/relaunch-preview').length
  expect(previews).toBeGreaterThanOrEqual(1)
  await confirmButton(page).click()
  await expect(row).toContainText('Relaunch a lane')
  await expect(row).toHaveAttribute('data-status', 'succeeded', { timeout: 15_000 })
  const log = row.getByTestId('control-log')
  await expect(log).toContainText('Relaunched ui once')
  await expect(log).toContainText('Continue the run with:')
  await expect(log).toContainText(/-m workflow reconcile \S+ --by operator/)
  await expect(log).toContainText(/-m workflow automatic \S+ --live --by operator/)
  expect(posts(requests, '/relaunch')).toHaveLength(1)
  // Neither continuation ran: the viewer chains nothing, and Reconcile is offered next.
  expect(posts(requests, '/reconcile')).toHaveLength(0)
  expect(posts(requests, '/restart')).toHaveLength(0)
  await openControls(page)
  await expect(page.getByTestId('control-reconcile')).toHaveAttribute('data-available', 'true')
  await page.keyboard.press('Escape')

  // The controller's dry run refuses the lane: its line verbatim, Confirm stays off.
  await open(page, RUN_RELAUNCH_REFUSE)
  await chooseControl(page, 'relaunch')
  await expect(page.getByTestId('relaunch-preview-line')).toHaveText(RELAUNCH_REFUSED, { timeout: 15_000 })
  await expect(confirmButton(page)).toBeDisabled()
  await page.getByTestId('dialog-cancel').click()
  expect(posts(requests, '/relaunch')).toHaveLength(1)
})

test(`An older controller without retry --all-failed and relaunch: both controls are greyed with their reasons and open nothing (${phase})`, async ({ page }) => {
  test.skip(phase !== 'worker', 'the candidate phase runs one fake controller, which has both commands; server/controls.test.ts proves the older one')
  await installControlMocks(page, { older: true })
  for (const runId of [RUN_RETRY_ALL, RUN_RELAUNCH]) {
    await open(page, runId)
    await openControls(page)
    await expect(page.locator('[data-testid="controls-list"] > li')).toHaveCount(15)
    for (const id of ['retry_all', 'relaunch'] as const) {
      await expect(page.getByTestId(`control-${id}`)).toHaveAttribute('data-available', 'false')
      await expect(page.getByTestId(`control-${id}`).getByTestId('control-reason')).toHaveText(OLDER_CONTROLLER_REASONS[id]!)
    }
    await page.getByTestId('control-relaunch-button').click({ force: true })
    await expect(dialog(page)).toHaveCount(0)
    await page.keyboard.press('Escape')
  }
})
