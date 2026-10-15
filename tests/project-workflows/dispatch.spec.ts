/**
 * The Projects dispatch scenarios (docs/PRD_PROJECTS_DISPATCH.md, policy.json): the Projects page and its cards, the
 * projects-only rail, Triage, the project page, the step chart, the reading pane, the GitHub cards, the git truth, the phone
 * layout, and run 002's fixes — the docked pane, the aligned axis, "Needs you and running", the commits-ahead view and the
 * folds. Each scenario is one test, titled `[scenario:<id>]`, with one `screenshot:<id>`. Worker phase: the dispatch routes
 * are mocked from `fixtures/dispatch.ts` through `installHooks`; candidate phase: the real server serves the seeded repositories.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { attach, gotoProjectOpen, installHooks, liveDock, openAllFeatures, phase, projectUrl, renderedText, runUrl, workflowUrl, workspace } from './support.ts'
import { PROJECT, RUN_FAILED, WORKFLOW_ID } from './fixtures.ts'
import { RUN_SESSIONS, UX_SESSIONS_WORKFLOW_ID } from './fixtures/sessions.ts'
import { REVAMP_PAGES_WORKFLOW_ID, RUN_REVAMP_BLOCKED, RUN_REVAMP_DONE, RUN_REVAMP_RUNNING } from './fixtures/ux-revamp-pages.ts'
import { installProjectMocks, mockDispatchResponse } from './mock.ts'
import {
  DISPATCH_BUSY, DISPATCH_LOCAL, DISPATCH_NOORIGIN, DISPATCH_TRIO, DISPATCH_UNREADABLE, DISPATCH_WIDGETS, DISPATCH_WIDGETS_WT, RUN_WT_DROPPED,
} from './fixtures/dispatch.ts'

installHooks()

const PROJECTS = '/projects'
const TRIAGE = '/projects/-/triage'
const card = (page: Page, id: string) => page.locator(`.dispatch-card[data-project-id="${id}"]`)
const railRow = (page: Page, id: string) => page.locator(`.dispatch-rail-row[data-project-id="${id}"]`)
const run = (page: Page, id: string) => page.locator(`.dispatch-run[data-run-id="${id}"]`)
/** The project page's filter-bar search box. */
const projectSearch = (page: Page) => page.getByTestId('dispatch-project').getByTestId('run-filter-q')

/** The bounding box of a locator, or a failing assertion. */
async function box(locator: Locator) {
  const b = await locator.boundingBox()
  expect(b, 'the element has a layout box').not.toBeNull()
  return b!
}

test(`[scenario:dispatch-overview] /projects shows one card per project in rail order with state, repository, sync, counts and GitHub; the runs-read time is fixed (${phase})`, async ({ page }, testInfo) => {
  await page.goto(PROJECTS)
  await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible()
  // The repository count waits for the dispatch overview (until then the header says "repositories: reading…").
  await expect(page.getByTestId('dispatch-projects-meta')).toContainText('projects in', { timeout: 30_000 })
  await expect(page.getByTestId('dispatch-cards')).toBeVisible()
  // The three readable-feature project whose worst latest result is failed (its fourth workflow cannot be read, [L8]).
  await expect(card(page, DISPATCH_TRIO)).toContainText('1 of 3 features failed last')
  // The GitHub primary clone: the sync wording, the repository, the public chip and the open counts.
  await expect(card(page, DISPATCH_WIDGETS)).toContainText('2 ahead, 1 behind origin/main')
  await expect(card(page, DISPATCH_WIDGETS)).toContainText('acme/widgets')
  await expect(card(page, DISPATCH_WIDGETS).locator('.dispatch-vis')).toHaveText('public')
  await expect(card(page, DISPATCH_WIDGETS)).toContainText('open PR')
  await expect(card(page, DISPATCH_WIDGETS)).toContainText('open issue')
  // The non-GitHub project: no chip, and its foot says so in plain words once.
  await expect(card(page, DISPATCH_LOCAL)).toContainText('no GitHub remote')
  await expect(card(page, DISPATCH_LOCAL)).not.toContainText('GitHub not read')
  await expect(card(page, DISPATCH_LOCAL).locator('.dispatch-vis')).toHaveCount(0)
  // Card order equals rail order, and each card holds exactly one link: itself (V17).
  const cardOrder = await page.getByTestId('dispatch-cards').locator('.dispatch-card').evaluateAll(els => els.map(el => el.getAttribute('data-project-id')))
  const railOrder = await page.getByTestId('dispatch-rail-list').locator('.dispatch-rail-row').evaluateAll(els => els.map(el => el.getAttribute('data-project-id')))
  expect(cardOrder).toEqual(railOrder)
  await expect(card(page, DISPATCH_WIDGETS).locator('a')).toHaveCount(0) // the card is itself the <a>; it holds no nested link
  // The latest run id and state word are asserted by value on the Widgets card.
  await expect(card(page, DISPATCH_WIDGETS)).toContainText('ui-polish-')
  // The "runs read" time is the read time, not a per-second ticking clock: it does not advance while nothing is re-read (V15).
  const readText = page.getByTestId('dispatch-runs-read')
  await expect(readText).toContainText('runs read')
  const before = await readText.innerText()
  await page.waitForTimeout(1500) // longer than a one-second clock tick, shorter than the list poll interval
  expect(await readText.innerText()).toBe(before)
  await card(page, DISPATCH_WIDGETS).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${DISPATCH_WIDGETS}$`))
  await attach(page, testInfo, 'dispatch-overview')
})

test(`[scenario:dispatch-rail] The projects-only rail shows All projects, Triage, then projects only; needs-you first, unreadable last, unpushed on the primary; gaps and current markers; the chip breakpoint (${phase})`, async ({ page }, testInfo) => {
  await page.goto(PROJECTS)
  const rail = page.getByTestId('dispatch-rail')
  await expect(rail.getByTestId('rail-all-projects')).toBeVisible()
  await expect(rail.getByTestId('rail-triage')).toBeVisible()
  await expect(page.getByTestId('dispatch-rail-list').locator('.dispatch-rail-row').first()).toHaveClass(/tone-/)
  // Wait for the run state to settle (the badges prove it loaded) before reading the order.
  await expect(railRow(page, DISPATCH_LOCAL)).toContainText('1 waits on you')
  await expect(railRow(page, DISPATCH_BUSY)).toContainText('waits on you')
  await expect(railRow(page, DISPATCH_UNREADABLE)).toContainText('cannot be read')
  await expect(railRow(page, DISPATCH_WIDGETS)).toContainText('2 unpushed')
  await expect(railRow(page, DISPATCH_WIDGETS_WT)).not.toContainText('unpushed')
  // The rail holds no workflow rows and no repository headers: every list row is a project link ([O2], V17).
  const rows = page.getByTestId('dispatch-rail-list').locator('.dispatch-rail-row')
  const order = await rows.evaluateAll(els => els.map(el => el.getAttribute('data-project-id')))
  expect(order.every(id => id !== null)).toBe(true)
  expect(order.indexOf(DISPATCH_LOCAL)).toBeLessThan(order.indexOf(DISPATCH_WIDGETS))
  expect(order.indexOf(DISPATCH_BUSY)).toBeLessThan(order.indexOf(DISPATCH_WIDGETS))
  expect(order[order.length - 1]).toBe(DISPATCH_UNREADABLE)
  // "All projects" shows a visible gap before its count and a current-page marker (V13).
  const home = rail.getByTestId('rail-all-projects')
  await expect(home).toHaveAttribute('aria-current', 'page')
  const label = await box(home.locator('.dispatch-rail-home-l'))
  const count = await box(home.locator('.dispatch-rail-home-n'))
  expect(count.x - (label.x + label.width)).toBeGreaterThanOrEqual(4)
  const bg = await home.evaluate('node => getComputedStyle(node).backgroundColor') as string
  expect(bg).not.toBe('rgba(0, 0, 0, 0)')
  // Clicking a rail project row opens that project's page, and the current page's row carries aria-current=page (V13).
  await railRow(page, DISPATCH_WIDGETS).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${DISPATCH_WIDGETS}$`))
  await expect(railRow(page, DISPATCH_WIDGETS)).toHaveAttribute('aria-current', 'page')
  // The rail is checked on a workflow page too, and the chip breakpoint at 999/1000 px.
  await page.goto(`${projectUrl(DISPATCH_WIDGETS)}/workflows/ui-polish`)
  await expect(page.getByTestId('dispatch-rail')).toBeVisible()
  await expect(page.getByTestId('dispatch-rail-list').locator('.dispatch-rail-row').first()).toBeVisible()
  await page.setViewportSize({ width: 1000, height: 900 })
  await page.goto(PROJECTS)
  await expect(page.getByTestId('dispatch-rail')).toBeVisible()
  await page.setViewportSize({ width: 999, height: 900 })
  await expect(page.getByTestId('dispatch-chips')).toBeVisible()
  await expect(page.getByTestId('dispatch-rail')).toBeHidden()
  await attach(page, testInfo, 'dispatch-rail')
})

test(`[scenario:dispatch-triage] /projects/-/triage shows the former Runs home content under the new rail, marked current (${phase})`, async ({ page }, testInfo) => {
  await page.goto(TRIAGE)
  await expect(page.getByTestId('needs-you')).toBeVisible()
  await expect(page.getByTestId('today-runs')).toBeVisible()
  await expect(page.getByTestId('running-runs')).toBeVisible()
  await expect(page.getByTestId('recent-runs')).toBeVisible()
  await expect(page.getByTestId('rail-triage')).toHaveAttribute('aria-current', 'page')
  await gotoProjectOpen(page, projectUrl(DISPATCH_WIDGETS))
  await page.getByTestId('rail-triage').click()
  await expect(page).toHaveURL(/\/projects\/-\/triage$/)
  await page.getByTestId('rail-all-projects').click()
  await expect(page).toHaveURL(/\/projects$/)
  await attach(page, testInfo, 'dispatch-triage')
})

test(`[scenario:dispatch-project] The project page header shows repository, checkout, sync, figures and jump buttons that move focus; git-not-read says so (${phase})`, async ({ page }, testInfo) => {
  test.slow() // the features are opened on every project page it reads
  await gotoProjectOpen(page, projectUrl(DISPATCH_WIDGETS))
  const header = page.getByTestId('dispatch-project-header')
  await expect(header.getByRole('heading', { level: 1, name: 'Widgets' })).toBeVisible()
  await expect(header.getByRole('link', { name: /acme\/widgets/ })).toHaveAttribute('href', 'https://github.com/acme/widgets')
  await expect(header.locator('.dispatch-vis')).toHaveText('public')
  await expect(page.getByTestId('dispatch-sync')).toContainText('2 ahead, 1 behind origin/main')
  await expect(page.getByTestId('dispatch-sync')).toContainText('as of')
  await expect(page.getByTestId('dispatch-figures')).toContainText('succeeded')
  // Each of the four jump buttons moves focus to its section, not only scroll (V4).
  for (const [name, id] of [['Runs by feature', 'dispatch-runs-section'], ['Local and GitHub', 'g-local'], [/Pull requests ·/, 'g-prs'], [/Issues ·/, 'g-iss']] as const) {
    await header.getByRole('button', { name }).click()
    await expect(page.locator(`#${id}`)).toBeFocused()
  }
  // The filter bar's search narrows the run rows; Escape clears it.
  const filter = projectSearch(page)
  await filter.fill('ui-polish-001')
  await expect(run(page, 'ui-polish-002')).toHaveCount(0)
  await expect(run(page, 'ui-polish-001')).toHaveCount(1)
  await filter.focus()
  await page.keyboard.press('Escape')
  await expect(filter).toHaveValue('')
  // A project whose git could not be read says "git not read", never "checkout detached".
  await gotoProjectOpen(page, projectUrl(DISPATCH_UNREADABLE))
  await expect(page.getByTestId('dispatch-project-header')).toContainText('git not read')
  await expect(page.getByTestId('dispatch-project-header')).not.toContainText('detached')
  await attach(page, testInfo, 'dispatch-project')
})

test(`[scenario:dispatch-chart] The step chart: sticky axis once, solid/dotted track, lane dots, chips, landed sha, ended counts, 440px collapse, and a workflow-level error with the literal placeholder (${phase})`, async ({ page }, testInfo) => {
  test.slow() // the features are opened on every project page it reads
  await gotoProjectOpen(page, projectUrl(DISPATCH_WIDGETS))
  const axis = page.getByTestId('dispatch-axis')
  await expect(axis).toHaveCount(1) // the sticky axis appears once
  await expect(axis).toHaveCSS('position', 'sticky')
  for (const label of ['Challenge', 'Launch', 'Freeze', 'Verify', 'Candidate', 'Review', 'Approval', 'Integrate']) await expect(axis).toContainText(label)
  const failed = run(page, 'ui-polish-002')
  await expect(failed).toContainText('×3')
  const cell = failed.locator('.dispatch-cell').nth(3) // Verify column
  await expect(cell.locator('.dispatch-stop-glyph')).toHaveCount(1)
  // Solid before the stop, dotted after it; lane dots are drawn.
  await expect(failed.locator('.dispatch-cell').nth(0)).toHaveClass(/pass/)
  await expect(failed.locator('.dispatch-cell').nth(4)).toHaveClass(/ahead/)
  await expect(failed.locator('.dispatch-dot')).not.toHaveCount(0)
  // An integrated run shows its landed sha, the header lists the landed shas and a chain of run chips, with the sha itself.
  await expect(run(page, 'ui-polish-001')).toContainText('integrated')
  const headRow = page.locator('li[data-workflow-id="ui-polish"] a.lists-group-head')
  await expect(headRow).toContainText('landed')
  await expect(page.locator('li[data-workflow-id="ui-polish"] .dispatch-chain .dispatch-chip-run')).not.toHaveCount(0)
  await expect(page.locator('li[data-workflow-id="ui-polish"] .dispatch-chain code')).not.toHaveCount(0)
  // The "ended here" counts sit under the group.
  await expect(page.locator('li[data-workflow-id="ui-polish"]').getByTestId('dispatch-ends')).toContainText('ended here')
  // The multi-lane collapse (PRD 4.3, "a multi-lane phase collapses to one mark"): ui-polish-002's Launch phase holds two
  // lanes (a parallel worker, worker phase only), so its cell carries `.multi`. Both marks draw at a wide chart; at a chart
  // width of 440px or less the cell collapses to one visible mark (container query). Deleting the collapse rule leaves two
  // marks at the narrow width, so this check fails. The candidate seed's runs are single-lane, as [P35] gates a worker-only line.
  if (phase === 'worker') {
    const multiCell = failed.locator('.dispatch-cell.multi')
    await expect(multiCell).toHaveCount(1)
    const visibleLaneMarks = () => multiCell.locator('.dispatch-lane').evaluateAll(els => els.filter(el => el.getBoundingClientRect().width > 0).length)
    expect(await visibleLaneMarks(), 'both lanes draw at 1280px').toBe(2)
    await page.setViewportSize({ width: 420, height: 900 })
    const chartWidth = (await box(page.getByTestId('dispatch-chart'))).width
    expect(chartWidth, 'the chart is 440px or less at this width').toBeLessThanOrEqual(440)
    expect(await visibleLaneMarks(), 'the second lane is hidden at a chart width of 440px or less').toBe(1)
    await page.setViewportSize({ width: 1280, height: 900 })
  }
  // A feature whose run state cannot be read shows one "cannot be read" row with the recorded error (kept verbatim through
  // redactPaths, [L8]) and the per-run status command. Widgets' `broken` feature has broken-001 with "plan.json is missing".
  const broken = page.locator('li[data-workflow-id="broken"]')
  await expect(broken).toContainText('cannot be read')
  await expect(broken).toContainText('plan.json is missing')
  await expect(broken).toContainText('python -m workflow status <runs root>/broken-001 --by operator')
  // A workflow whose runs could not be listed: Trio's extra workflow, its row with the literal `<run-id>` placeholder ([P34]).
  await gotoProjectOpen(page, projectUrl(DISPATCH_TRIO))
  const locked = page.locator('li[data-workflow-id="trio-locked"]')
  await expect(locked).toContainText('cannot be read')
  await expect(locked).toContainText('could not be listed')
  await expect(locked).toContainText('python -m workflow status <runs root>/<run-id> --by operator')
  // Every feature's steps stay reachable from a "Steps of this definition" fold, once per revision above the chart, the
  // unreadable workflow's included (V7, [P30]); no feature carries a fold of its own.
  const lockedFold = page.getByTestId('dispatch-defs').getByTestId('dispatch-def').filter({ hasText: 'trio-locked' })
  await expect(lockedFold).toHaveCount(1)
  await expect(lockedFold).toContainText('Steps of this definition')
  await expect(locked.getByTestId('dispatch-def')).toHaveCount(0)
  // A filter matching none of a feature's runs says "0 of N runs match" in its group header, not "0 runs" (V30).
  await gotoProjectOpen(page, projectUrl(DISPATCH_WIDGETS))
  await projectSearch(page).fill('zzzznomatch')
  await expect(page.locator('li[data-workflow-id="ui-polish"] a.lists-group-head')).toContainText('0 of 3 runs match')
  await expect(page.locator('li[data-workflow-id="ui-polish"]')).toHaveAttribute('data-open', 'false')
  await projectSearch(page).fill('')
  await openAllFeatures(page)
  // A landed sha in a run row sits on one line at 1100px (V29): its box is a single client rect, never a mid-sha break.
  await page.setViewportSize({ width: 1100, height: 900 })
  const landedSha = run(page, 'ui-polish-001').locator('.dispatch-res code').first()
  await expect(landedSha).toBeVisible()
  expect(await landedSha.evaluate(el => el.getClientRects().length), 'the landed sha sits on one line').toBe(1)
  await page.setViewportSize({ width: 1280, height: 900 })
  await attach(page, testInfo, 'dispatch-chart')
})

test(`[scenario:dispatch-pane] Selecting a run docks the pane with facts, the lead, steps, today's CommandBlock and Open run page; j/k move; Close and Escape undock and return focus (${phase})`, async ({ page }, testInfo) => {
  test.slow() // the features are opened on every project page it reads
  await gotoProjectOpen(page, projectUrl(DISPATCH_WIDGETS))
  // With nothing selected there is no pane and the project is not docked.
  await expect(page.getByTestId('dispatch-pane')).toHaveCount(0)
  await expect(page.getByTestId('dispatch-project')).not.toHaveClass(/has-pane/)
  await run(page, 'ui-polish-002').click()
  const pane = page.getByTestId('dispatch-pane')
  await expect(pane).toBeVisible()
  await expect(pane).toHaveAttribute('data-run-id', 'ui-polish-002')
  await expect(pane.getByTestId('dispatch-pane-lead')).toBeVisible()
  await expect(pane.getByTestId('dispatch-pane-steps')).toBeVisible()
  // Today's CommandBlock, fed by the run's NextStep (not a fixed status line): the command block renders.
  await expect(pane.getByTestId('now-next')).toBeVisible()
  // The command text, captured by value, is compared with the run page's own rendering below (V2).
  const paneCommand = (await pane.getByTestId('now-command').first().innerText()).trim()
  expect(paneCommand.length, 'the failed run shows a next-step command').toBeGreaterThan(0)
  await expect(pane.getByTestId('dispatch-open-run')).toHaveAttribute('href', /ui-polish-002/)
  // k moves the selection up the list, j back down.
  await page.keyboard.press('k')
  await expect(page.getByTestId('dispatch-pane')).toHaveAttribute('data-run-id', 'ui-polish-001')
  await page.keyboard.press('j')
  await expect(page.getByTestId('dispatch-pane')).toHaveAttribute('data-run-id', 'ui-polish-002')
  // The Close button undocks and returns focus to the row.
  await page.getByTestId('dispatch-pane-close').click()
  await expect(page.getByTestId('dispatch-pane')).toHaveCount(0)
  await expect(run(page, 'ui-polish-002')).toBeFocused()
  // Escape does the same.
  await run(page, 'ui-polish-002').click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('dispatch-pane')).toHaveCount(0)
  await expect(run(page, 'ui-polish-002')).toBeFocused()
  // The next-step lead appears once (V27): the CommandBlock states the label; there is no separate duplicate lead paragraph.
  // ui-polish-001 is integrated, so its label is a full sentence the block renders verbatim; it must appear exactly once.
  await run(page, 'ui-polish-001').click()
  const paneOne = page.getByTestId('dispatch-pane')
  await expect(paneOne.getByTestId('now-next')).toBeVisible()
  await expect(paneOne.getByTestId('dispatch-pane-next-lead')).toHaveCount(0)
  const lead = (await paneOne.locator('[data-testid="now-next"] .command-label').innerText()).trim()
  expect(lead.length, 'the CommandBlock states a lead label').toBeGreaterThan(0)
  const paneText = await paneOne.innerText()
  expect(paneText.split(lead).length - 1, 'the next-step lead is not duplicated').toBe(1)
  // The CommandBlock's command equals the run's NextStep command, the one the run page shows for that run, by value (V2).
  await page.goto(`${projectUrl(DISPATCH_WIDGETS)}/workflows/ui-polish/runs/ui-polish-002`)
  const runPageCommand = (await page.getByTestId('now-command').first().innerText()).trim()
  expect(runPageCommand).toBe(paneCommand)
  await gotoProjectOpen(page, projectUrl(DISPATCH_WIDGETS))
  await attach(page, testInfo, 'dispatch-pane')
})

test(`A failed steps read on a cold project page: the selected run's pane says the steps could not be read, never "reading…" (${phase})`, async ({ page }) => {
  // The 503 is installed before the first load, so the steps resource never holds data a failed reload could keep.
  await page.route(url => url.pathname === `/api/dispatch/projects/${DISPATCH_WIDGETS}/steps`,
    route => route.fulfill({ status: 503, json: { error: { code: 'STEPS_UNREADABLE', message: 'held for the test' } } }))
  await gotoProjectOpen(page, projectUrl(DISPATCH_WIDGETS))
  await run(page, 'ui-polish-002').click()
  const pane = page.getByTestId('dispatch-pane')
  await expect(pane).toHaveAttribute('data-run-id', 'ui-polish-002', { timeout: 30_000 })
  await expect(pane.getByTestId('dispatch-pane-steps-state')).toHaveText('The recorded steps could not be read.', { timeout: 30_000 })
  await expect(pane.locator('.dispatch-fact', { hasText: 'Lanes' }).locator('dd')).toHaveText('not read')
  await expect(pane.getByText('reading…', { exact: false })).toHaveCount(0)
  await expect(pane.getByText('Reading the recorded steps…')).toHaveCount(0)
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test(`A failed steps read: a run row with no served focus says its steps were not read, never "reading steps…" (${phase})`, async ({ page }) => {
  await page.route(url => url.pathname === `/api/dispatch/projects/${DISPATCH_WIDGETS_WT}/steps`,
    route => route.fulfill({ status: 503, json: { error: { code: 'STEPS_UNREADABLE', message: 'held for the test' } } }))
  await gotoProjectOpen(page, projectUrl(DISPATCH_WIDGETS_WT))
  const dropped = run(page, RUN_WT_DROPPED)
  await expect(dropped.locator('.dispatch-run-2')).toContainText('steps not read', { timeout: 30_000 })
  await expect(dropped).toHaveAttribute('aria-label', /Steps not read\.$/)
  await expect(page.getByTestId('dispatch-chart').getByText('reading steps…')).toHaveCount(0)
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test(`A failed overview read on a cold Projects page: the header says the repositories were not read, never "repositories: reading…" (${phase})`, async ({ page }) => {
  await page.route(url => url.pathname === '/api/dispatch/projects',
    route => route.fulfill({ status: 503, json: { error: { code: 'OVERVIEW_UNREADABLE', message: 'held for the test' } } }))
  await page.goto(PROJECTS)
  const meta = page.getByTestId('dispatch-projects-meta')
  await expect(meta).toContainText('repositories not read', { timeout: 30_000 })
  await expect(meta).not.toContainText('repositories: reading…')
  await expect(meta).toContainText(/^\d+ projects? · repositories not read/)
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test(`[scenario:dispatch-github] The GitHub cards group PRs and issues, name the match, fold long groups, say the merged scope, a head-null read is read, and a not-read project keeps local counts (${phase})`, async ({ page }, testInfo) => {
  test.slow() // the features are opened on every project page it reads
  // In the worker phase only, serve Widgets' GitHub read with head null (an empty repository, Appendix A allows it): the card
  // must say the default branch has no commits, not "GitHub not read", and keep its PR and issue counts ([P35], V26). The
  // candidate server cannot produce this, as fixture mode never refreshes and the fixture file carries no head change.
  if (phase === 'worker') {
    await page.route(url => url.pathname === '/api/dispatch/projects', async route => {
      const body = JSON.parse(mockDispatchResponse(new URL(route.request().url())).body as string)
      for (const project of body.projects) if (project.project_id === DISPATCH_WIDGETS) project.github.head = null
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })
  }
  await gotoProjectOpen(page, projectUrl(DISPATCH_WIDGETS))
  const prs = page.getByTestId('dispatch-gh-prs')
  await expect(prs).toContainText('showing the 20 most recently updated')
  await expect(prs).toContainText('Possibly related')
  await expect(prs).toContainText('Yours, open')
  await expect(prs).toContainText('Others, open')
  await expect(prs).toContainText('Merged in the last 14 days')
  await expect(prs).toContainText('among the 20 shown') // the merged group names its scope (V9)
  // "Possibly related" names the match (V14), the Others group shows a draft and head → base and "updated".
  await expect(prs.getByText(/head is feature\/ui-polish-002|base is/)).not.toHaveCount(0)
  await expect(prs).toContainText('draft')
  await expect(prs).toContainText('updated')
  await expect(prs.getByRole('link', { name: /#42/ })).toHaveAttribute('href', /github\.com\/acme\/widgets\/pull\/42/)
  // A review decision and checks counts on a row.
  await expect(prs).toContainText('changes requested')
  await expect(prs).toContainText('passing')
  const issues = page.getByTestId('dispatch-gh-issues')
  await expect(issues).toContainText('Assigned to you')
  await expect(issues).toContainText('Newest from people')
  // The "Newest from people" group is longer than five and folds (V8).
  await expect(issues.getByTestId('dispatch-show-more')).toBeVisible()
  await issues.getByTestId('dispatch-show-more').click()
  await expect(issues.getByTestId('dispatch-show-more')).toHaveCount(0)
  await expect(issues).toContainText('from bots among the newest 20')
  await expect(issues).toContainText('2025') // an issue opened in an earlier year keeps its year
  await expect(issues.getByRole('link', { name: /All .* on GitHub/ })).toBeVisible()
  // In the worker phase only, a mocked repository read with a failed refresh shows the stale line ([P35], V20).
  if (phase === 'worker') await expect(prs).toContainText('the latest refresh failed')
  // The count wording is "N open", never "N opens" (V29).
  await expect(prs.locator('h3')).toContainText('3 open')
  await expect(prs.locator('h3')).not.toContainText('opens')
  await expect(page.getByTestId('dispatch-gh-issues').locator('h3')).toContainText('3 open')
  // In the worker phase only, Widgets' read with head null says the default branch has no commits, not "GitHub not read",
  // and keeps the read PR and issue counts (V26).
  if (phase === 'worker') {
    await expect(page.getByTestId('dispatch-gh-local-nohead')).toContainText("GitHub's main has no commits")
    await expect(page.getByTestId('dispatch-gh-local')).not.toContainText('GitHub not read')
    await expect(prs.locator('h3')).toContainText('3 open')
  }
  // The PULL REQUESTS heading sits on one line at 1100 and 1440 px: the title is a single client rect (V29).
  for (const width of [1100, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    const title = page.getByTestId('dispatch-gh-prs').locator('.dispatch-gh-title')
    await expect(title).toBeVisible()
    expect(await title.evaluate(el => el.getClientRects().length), `the heading is one line at ${width}px`).toBe(1)
  }
  await page.setViewportSize({ width: 1280, height: 900 })
  // A project without a GitHub remote: its GitHub column is one line that says it has no GitHub remote and shows no GitHub
  // count, while the local sync stays (V11); no pull-request or issue card is drawn for it.
  await gotoProjectOpen(page, projectUrl(DISPATCH_LOCAL))
  await expect(page.getByTestId('dispatch-github')).toContainText('no GitHub remote')
  await expect(page.getByTestId('dispatch-github')).not.toContainText('GitHub not read')
  await expect(page.getByTestId('dispatch-gh-prs')).toHaveCount(0)
  await expect(page.getByTestId('dispatch-gh-issues')).toHaveCount(0)
  await expect(page.getByTestId('dispatch-github')).not.toContainText(/\d+ open/)
  await expect(page.getByTestId('dispatch-gh-local')).toContainText('no GitHub remote')
  await expect(page.getByTestId('dispatch-gh-local')).toContainText('origin/main') // the local sync still shows
  await attach(page, testInfo, 'dispatch-github')
})

/** The overview as the phase serves it, with each project's GitHub state edited by `edit` (a project it leaves alone keeps its read). */
type OverviewEdit = (project: { project_id: string; github: Record<string, unknown> }) => void
async function answerOverview(page: Page, first: OverviewEdit) {
  let edit = first
  await page.route(url => url.pathname === '/api/dispatch/projects', async route => {
    try {
      const body = phase === 'worker' ? JSON.parse(String(mockDispatchResponse(new URL(route.request().url())).body)) : await (await route.fetch()).json()
      for (const project of body.projects) edit(project)
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    } catch { /* the test ended while this read was in flight */ }
  })
  return (next: OverviewEdit) => { edit = next }
}

const NOT_READ = { repo: null, read_at: null, visibility: null, default_branch: null, pushed_at: null, head: null, open_prs: null, open_issues: null, prs: [], issues: [] }
const bodyText = (page: Page) => page.locator('body').innerText()
const occurrences = (text: string, needle: string) => text.split(needle).length - 1

test(`[scenario:github-wording] GitHub's state is said once per page in plain words: no GitHub remote, or GitHub not read with its reason (${phase})`, async ({ page }, testInfo) => {
  test.slow() // three project pages and four overview variants
  await page.setViewportSize({ width: 1440, height: 900 })
  // The seeds serve one project per state they hold; `unavailable` and `off` are answered here in both phases.
  const answer = await answerOverview(page, project => {
    if (project.project_id === DISPATCH_TRIO) project.github = { status: 'unavailable', reason: 'gh is not installed', ...NOT_READ }
    if (project.project_id === DISPATCH_BUSY) project.github = { status: 'off', reason: 'GitHub reads are disabled', ...NOT_READ }
  })
  await page.goto(PROJECTS)
  await expect(page.getByTestId('dispatch-projects-meta')).toContainText('projects in', { timeout: 30_000 })
  await expect(card(page, DISPATCH_LOCAL)).toContainText('no GitHub remote')
  await expect(card(page, DISPATCH_LOCAL)).not.toContainText('GitHub not read')
  await expect(card(page, DISPATCH_TRIO)).toContainText('GitHub not read: gh is not installed')
  await expect(card(page, DISPATCH_BUSY)).toContainText('GitHub reads are turned off')
  await expect(card(page, DISPATCH_WIDGETS)).toContainText('open PR')
  await expect(page.getByTestId('dispatch-projects-meta')).toContainText(/GitHub read /)
  expect(await bodyText(page)).not.toContain('GitHub not read: not a GitHub remote')
  await attach(page, testInfo, 'github-wording')

  // A project without a GitHub remote: "no GitHub remote" once, in the column's one line, with no Pull requests or Issues card.
  await gotoProjectOpen(page, projectUrl(DISPATCH_LOCAL))
  await expect(page.getByTestId('dispatch-github')).toContainText('no GitHub remote')
  await expect(page.getByTestId('dispatch-github').locator('.dispatch-gline')).toHaveCount(1)
  await expect(page.getByTestId('dispatch-gh-prs')).toHaveCount(0)
  await expect(page.getByTestId('dispatch-gh-issues')).toHaveCount(0)
  let text = await bodyText(page)
  expect(occurrences(text, 'no GitHub remote')).toBe(1)
  expect(text).not.toContain('GitHub not read')

  // Any other not-read status: "GitHub not read: <reason>" once, on the Local and GitHub card, and no card repeats it.
  await gotoProjectOpen(page, projectUrl(DISPATCH_TRIO))
  await expect(page.getByTestId('dispatch-gh-local-notread')).toHaveText('GitHub not read: gh is not installed')
  await expect(page.getByTestId('dispatch-gh-prs')).toHaveCount(0)
  await expect(page.getByTestId('dispatch-gh-issues')).toHaveCount(0)
  text = await bodyText(page)
  expect(occurrences(text, 'GitHub not read: gh is not installed')).toBe(1)
  expect(text).not.toContain('GitHub not read: not a GitHub remote')
  await gotoProjectOpen(page, projectUrl(DISPATCH_BUSY))
  await expect(page.getByTestId('dispatch-gh-local-notread')).toHaveText('GitHub reads are turned off')
  expect(occurrences(await bodyText(page), 'GitHub reads are turned off')).toBe(1)

  // A project whose GitHub was read keeps its pull request and issue counts, and says nothing is not read.
  await gotoProjectOpen(page, projectUrl(DISPATCH_WIDGETS))
  await expect(page.getByTestId('dispatch-gh-prs').locator('h3')).toContainText('3 open')
  await expect(page.getByTestId('dispatch-gh-issues').locator('h3')).toContainText('3 open')
  await expect(page.getByTestId('dispatch-github')).not.toContainText('no GitHub remote')

  // The Projects page meta line: nothing about GitHub when no project has a GitHub remote, "GitHub not read" when none was read.
  answer(project => { project.github = { status: 'not_github', reason: 'not a GitHub remote', ...NOT_READ } })
  await page.goto(PROJECTS)
  await expect(page.getByTestId('dispatch-projects-meta')).toContainText('projects in', { timeout: 30_000 })
  await expect(page.getByTestId('dispatch-projects-meta')).not.toContainText('GitHub')
  expect(await bodyText(page)).not.toContain('GitHub not read')
  answer(project => { project.github = { status: 'unavailable', reason: 'gh is not installed', ...NOT_READ } })
  await page.goto(PROJECTS)
  await expect(page.getByTestId('dispatch-projects-meta')).toContainText('projects in', { timeout: 30_000 })
  await expect(page.getByTestId('dispatch-projects-meta')).toContainText('GitHub not read')
  await expect(page.getByTestId('dispatch-projects-meta')).not.toContainText('GitHub read')
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test(`A project without a GitHub remote keeps one body track with a run selected, however wide the body: no empty GitHub column beside the chart (${phase})`, async ({ page }) => {
  await page.setViewportSize({ width: 1700, height: 900 })
  await gotoProjectOpen(page, projectUrl(DISPATCH_LOCAL))
  await run(page, 'sync-001').click()
  await expect(page.getByTestId('dispatch-pane')).toBeVisible()
  await expect(page.getByTestId('dispatch-project')).toHaveClass(/has-pane/)
  const container = page.locator('.dispatch-body-container')
  // Widen the window until the body's container reaches the three-column width (876 px), capped at 2560 px.
  let width = 1700
  let containerWidth = await container.evaluate(el => el.clientWidth)
  while (containerWidth < 876 && width < 2560) {
    width = Math.min(2560, width + 200)
    await page.setViewportSize({ width, height: 900 })
    containerWidth = await container.evaluate(el => el.clientWidth)
  }
  expect(containerWidth, `the body container is at least 876 px wide (window ${width} px)`).toBeGreaterThanOrEqual(876)
  const body = page.locator('.dispatch-project-body')
  await expect(body).toHaveClass(/dispatch-project-body-wide/)
  const tracks = await body.evaluate(el => el.ownerDocument.defaultView!.getComputedStyle(el).gridTemplateColumns.split(' ').length)
  expect(tracks, 'the body has a single grid track').toBe(1)
  const bodyWidth = await body.evaluate(el => el.getBoundingClientRect().width)
  const mainWidth = await page.locator('.dispatch-project-main').evaluate(el => el.getBoundingClientRect().width)
  expect(Math.abs(mainWidth - bodyWidth), 'the main column fills the body width').toBeLessThanOrEqual(1)
})

test(`[scenario:dispatch-git-truth] The worktree shares its clone; the primary counts against origin with the naming split and the landings by value; no path leaks on every page (${phase})`, async ({ page }, testInfo) => {
  test.slow() // thirteen page loads come within a second of 30 s on a loaded 4-core host
  await gotoProjectOpen(page, projectUrl(DISPATCH_WIDGETS_WT))
  await expect(page.getByTestId('dispatch-gh-local')).toContainText('shares its clone with Widgets')
  await expect(railRow(page, DISPATCH_WIDGETS_WT)).not.toContainText('unpushed')
  // The Also checked out as card names the other checkout and whether it is the same clone.
  await expect(page.getByTestId('dispatch-gh-others')).toContainText('same clone')
  await gotoProjectOpen(page, projectUrl(DISPATCH_WIDGETS))
  const local = page.getByTestId('dispatch-gh-local')
  await expect(local).toContainText('Counted against origin/main as this clone has it')
  await expect(local).toContainText('origin/main last updated here')
  await expect(local).toContainText('this page never fetches')
  await expect(page.getByTestId('dispatch-ahead-naming')).toContainText('Of the 2 ahead, 1 name a run; 1 do not name a known run')
  await expect(local).toContainText('committed') // GitHub main's sha with its commit date
  // Landings asserted by value: 2 on local main, 1 on origin, 0 unknown ([P25], V16).
  await expect(page.getByTestId('dispatch-landings')).toContainText('2 of 2 landings on local main')
  await expect(page.getByTestId('dispatch-landings')).toContainText('1 on origin')
  await expect(page.getByTestId('dispatch-landings')).toContainText('0 unknown')
  await gotoProjectOpen(page, projectUrl(DISPATCH_NOORIGIN))
  await expect(page.getByTestId('dispatch-gh-local')).toContainText('not compared with origin')
  // renderedText passes on every seeded page and a workflow page (V21): no absolute path reaches the browser.
  for (const url of [PROJECTS, TRIAGE, projectUrl(DISPATCH_WIDGETS), projectUrl(DISPATCH_WIDGETS_WT), projectUrl(DISPATCH_NOORIGIN), projectUrl(DISPATCH_LOCAL), projectUrl(DISPATCH_TRIO), projectUrl(DISPATCH_BUSY), projectUrl(DISPATCH_UNREADABLE), `${projectUrl(DISPATCH_WIDGETS)}/workflows/ui-polish`]) {
    await page.goto(url)
    await renderedText(workspace(page))
  }
  await gotoProjectOpen(page, projectUrl(DISPATCH_WIDGETS))
  await attach(page, testInfo, 'dispatch-git-truth')
})

test(`[scenario:dispatch-phone] At 390 px the rail is a chip row, cards stack, the GitHub column stacks, the pane fills the screen, and every target is at least 44 px (${phase})`, async ({ page }, testInfo) => {
  test.slow() // the features are opened on every project page it reads
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(PROJECTS)
  const chips = page.getByTestId('dispatch-chips')
  await expect(chips).toBeVisible()
  await expect(chips).toContainText('All projects')
  await expect(chips).toContainText('Triage')
  const noSideways = async () => expect(await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') as number).toBeLessThanOrEqual(0)
  await noSideways()
  await gotoProjectOpen(page, projectUrl(DISPATCH_WIDGETS))
  await noSideways()
  await run(page, 'ui-polish-002').click()
  const pane = page.getByTestId('dispatch-pane')
  await expect(pane).toHaveClass(/phone/)
  await expect(pane.getByTestId('dispatch-pane-queue')).toBeVisible()
  await expect(pane.getByTestId('dispatch-pane-next')).toBeVisible()
  await expect(pane.getByTestId('now-command')).not.toHaveCount(0) // the pane shows the CommandBlock's Copy button to measure
  // Measure the targets inside the dispatch regions, the open reading pane among them (Close, Open run page, Queue, Next and
  // the CommandBlock's Copy/Run buttons), measured before "Queue" closes the pane (V12, V31). String-form evaluate so the
  // build's tsc need not type the DOM globals.
  const short = await page.evaluate(`(() => {
    const roots = ['[data-testid="dispatch-chips"]', '[data-testid="dispatch-project-header"]', '.breadcrumbs', '[data-testid="dispatch-github"]', '[data-testid="dispatch-pane"]']
      .map(s => document.querySelector(s)).filter(Boolean)
    const bad = []
    for (const root of roots) for (const el of root.querySelectorAll('a, button, input')) {
      const r = el.getBoundingClientRect()
      if (r.height > 0 && r.height < 44) bad.push(el.tagName + ' ' + (el.textContent || '').trim().slice(0, 24) + ' (' + Math.round(r.height) + 'px)')
    }
    return bad
  })()`) as string[]
  expect(short, `targets under 44px: ${short.join('; ')}`).toEqual([])
  // "Queue" returns to the run list (never the previous run).
  await pane.getByTestId('dispatch-pane-queue').click()
  await expect(page.getByTestId('dispatch-pane')).toHaveCount(0)
  await attach(page, testInfo, 'dispatch-phone')
})

test(`[scenario:dispatch-dock] Selecting a run docks the pane beside the chart without squeezing it or scrolling the page; the GitHub column count comes from the body's width (${phase})`, async ({ page }, testInfo) => {
  test.slow() // the features are opened on every project page it reads
  // Where the GitHub column sits relative to the chart: beside it (its left edge is at or past the chart's right edge) or
  // under it (the body stacked to one column). V23 decides the count from the body's own width (a container query), so the
  // chart never drops under 480px while the column is beside it, whatever the shell's border and padding around the body.
  const placement = async () => {
    const chart = await box(page.getByTestId('dispatch-chart'))
    const gh = await box(page.getByTestId('dispatch-github'))
    return { chart, beside: gh.x >= chart.x + chart.width - 2 }
  }
  for (const width of [1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 })
    await gotoProjectOpen(page, projectUrl(DISPATCH_WIDGETS))
    await page.evaluate('window.scrollTo(0, 0)')
    await run(page, 'ui-polish-002').click()
    await expect(page.getByTestId('dispatch-pane')).toBeVisible()
    const header = await box(page.getByTestId('dispatch-project-header'))
    const chart = await box(page.getByTestId('dispatch-chart'))
    const pane = await box(page.getByTestId('dispatch-pane'))
    // The header stays full width (wider than the chart beneath it).
    expect(header.width).toBeGreaterThan(chart.width)
    // The chart and the pane are both near the top of the viewport (below the full-width header), not scrolled away.
    expect(chart.y).toBeLessThan(700)
    expect(pane.y).toBeLessThan(700)
    // The chart is not squeezed under 480px.
    expect(chart.width).toBeGreaterThanOrEqual(480)
    // The boxes do not overlap: the pane is to the right of the chart.
    expect(pane.x).toBeGreaterThanOrEqual(chart.x + chart.width - 2)
    // The GitHub column stacks under the chart at 1280/1440 and sits beside it at 1920 (the body width decides, V23).
    const { beside } = await placement()
    expect(beside, `GitHub column beside the chart at ${width}px`).toBe(width === 1920)
    // No horizontal page scroll and the window did not scroll away when the run was selected.
    const overflow = await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') as number
    expect(overflow).toBeLessThanOrEqual(0)
    expect(await page.evaluate('window.scrollY') as number).toBeLessThanOrEqual(2)
  }
  // Across the band around the old 1680px breakpoint: at each width either the GitHub column is under the chart, or (beside it)
  // the chart keeps at least 480px. A viewport media query at 1680 would squeeze the chart under 480 just above it; the body
  // container query does not, because it measures the body, not the viewport.
  for (const width of [1600, 1680, 1720, 1760]) {
    await page.setViewportSize({ width, height: 900 })
    await gotoProjectOpen(page, projectUrl(DISPATCH_WIDGETS))
    await page.evaluate('window.scrollTo(0, 0)')
    await run(page, 'ui-polish-002').click()
    await expect(page.getByTestId('dispatch-pane')).toBeVisible()
    const { chart, beside } = await placement()
    expect(!beside || chart.width >= 480, `at ${width}px: column under the chart or chart >= 480px`).toBe(true)
  }
  await attach(page, testInfo, 'dispatch-dock')
})

test(`[scenario:dispatch-axis] Each stop glyph's centre lies within its phase label's column and no label is cut with an ellipsis, at 1440 and 1100 px (${phase})`, async ({ page }, testInfo) => {
  test.slow() // the features are opened on every project page it reads
  for (const width of [1440, 1100]) {
    await page.setViewportSize({ width, height: 900 })
    await gotoProjectOpen(page, projectUrl(DISPATCH_WIDGETS))
    const axis = page.getByTestId('dispatch-axis')
    await expect(axis).toBeVisible()
    // No axis label is cut with an ellipsis character (narrow columns use the fixed short forms).
    expect(await axis.innerText()).not.toContain('…')
    // The failed run stopped at Verify (phase index 3): its glyph centre lies within the Verify axis label's column.
    const glyph = await box(run(page, 'ui-polish-002').locator('.dispatch-stop-glyph'))
    const verifyLabel = await box(axis.locator('.dispatch-ax[data-phase="3"]'))
    const glyphCentre = glyph.x + glyph.width / 2
    expect(glyphCentre).toBeGreaterThanOrEqual(verifyLabel.x - 1)
    expect(glyphCentre).toBeLessThanOrEqual(verifyLabel.x + verifyLabel.width + 1)
    // The "ended here" count sits in the same column as the glyph.
    const endedCell = await box(page.locator('li[data-workflow-id="ui-polish"]').getByTestId('dispatch-ends').locator('.dispatch-en').nth(3))
    const endedCentre = endedCell.x + endedCell.width / 2
    expect(Math.abs(endedCentre - glyphCentre)).toBeLessThanOrEqual(verifyLabel.width)
  }
  await attach(page, testInfo, 'dispatch-axis')
})

test(`[scenario:dispatch-sections] "Needs you and running" lists waiting and running runs before the chart; same-repo wording; a missing reflog says "update time not recorded" (${phase})`, async ({ page }, testInfo) => {
  test.slow()
  await gotoProjectOpen(page, projectUrl(DISPATCH_BUSY))
  const needs = page.getByTestId('dispatch-needs')
  await expect(needs).toContainText('Needs you and running')
  await expect(needs.getByRole('link', { name: /ship-001/ })).toBeVisible()
  await expect(needs.getByRole('link', { name: /ship-002/ })).toBeVisible()
  await expect(needs).toContainText('waits on you')
  await expect(needs).toContainText('running')
  // Each Busy link's href is that run's page (V25).
  await expect(needs.getByRole('link', { name: /ship-001/ })).toHaveAttribute('href', /\/workflows\/ship\/runs\/ship-001$/)
  await expect(needs.getByRole('link', { name: /ship-002/ })).toHaveAttribute('href', /\/workflows\/ship\/runs\/ship-002$/)
  // The section sits before the step chart.
  const needsBox = await box(needs)
  const chartBox = await box(page.getByTestId('dispatch-chart'))
  expect(needsBox.y).toBeLessThan(chartBox.y)
  // A compared sync whose reflog time is missing says "update time not recorded" in the header and on the card ([L9], V10).
  await expect(page.getByTestId('dispatch-sync')).toContainText('update time not recorded')
  await expect(page.getByTestId('dispatch-gh-local')).toContainText('update time not recorded')
  // The Widgets primary has neither waiting nor running runs. What its run lists return differs by phase: the worker mock
  // lists its `broken` feature as an empty readable list, so the plain all-clear shows; the candidate server cannot read
  // broken-001 (its plan.json is missing), so that feature's run list fails and the section is qualified — the clear phrase
  // plus "1 feature cannot be read", never the plain all-clear (V25). Asserted per phase, not weakened to a shared substring.
  await gotoProjectOpen(page, projectUrl(DISPATCH_WIDGETS))
  if (phase === 'worker') {
    await expect(page.getByTestId('dispatch-needs-none')).toContainText('Nothing waits on you; nothing running')
  } else {
    await expect(page.getByTestId('dispatch-needs-clear')).toContainText('Nothing waits on you; nothing running')
    await expect(page.getByTestId('dispatch-needs-unread')).toContainText('1 feature cannot be read')
    await expect(page.getByTestId('dispatch-needs-none')).toHaveCount(0)
  }
  await expect(page.getByTestId('dispatch-same-repo')).toContainText('same repo as Widgets worktree')
  await gotoProjectOpen(page, projectUrl(DISPATCH_WIDGETS_WT))
  await expect(page.getByTestId('dispatch-same-repo')).toContainText('same repo as Widgets')
  // Trio's trio-locked workflow cannot be listed ([P34]): the section never shows the plain all-clear and says one feature
  // cannot be read, rather than asserting nothing waits on the operator (V25).
  await gotoProjectOpen(page, projectUrl(DISPATCH_TRIO))
  await expect(page.getByTestId('dispatch-needs')).toContainText('1 feature cannot be read')
  await expect(page.getByTestId('dispatch-needs-none')).toHaveCount(0)
  // In the worker phase only, the run-list state reaches the page as loading or fully failed (route interception, V25, [L12]).
  if (phase === 'worker') {
    // A held-open run-list request: the section reads "Reading runs…" while the lists load.
    const widgetsRuns = (u: URL) => /\/projects\/dispatch-widgets\/workflows\/[^/]+\/runs$/.test(u.pathname)
    await page.route(widgetsRuns, async route => {
      await new Promise(resolve => setTimeout(resolve, 4000))
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runs: [], next_cursor: null }) }).catch(() => undefined)
    })
    await page.goto(projectUrl(DISPATCH_WIDGETS))
    await expect(page.getByTestId('dispatch-needs-loading')).toContainText('Reading runs')
    await page.unroute(widgetsRuns)
    // Failing every /runs request of one project: "Runs not read: <reason>" and no all-clear.
    const nooriginRuns = (u: URL) => /\/projects\/dispatch-noorigin\/workflows\/[^/]+\/runs$/.test(u.pathname)
    await page.route(nooriginRuns, async route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'RUNS_UNREADABLE', message: 'the runs could not be read' } }) }))
    await gotoProjectOpen(page, projectUrl(DISPATCH_NOORIGIN))
    await expect(page.getByTestId('dispatch-needs-failed')).toContainText('Runs not read:')
    await expect(page.getByTestId('dispatch-needs-none')).toHaveCount(0)
    await page.unroute(nooriginRuns)
  }
  await gotoProjectOpen(page, projectUrl(DISPATCH_WIDGETS))
  await attach(page, testInfo, 'dispatch-sections')
})

test(`[scenario:dispatch-ahead] The commits-ahead button lists the commits and the landings in the pane; Busy shows 50 and "and 2 more" (${phase})`, async ({ page }, testInfo) => {
  test.slow() // the features are opened on every project page it reads
  await gotoProjectOpen(page, projectUrl(DISPATCH_WIDGETS))
  await page.getByTestId('dispatch-ahead-button').click()
  const pane = page.getByTestId('dispatch-pane')
  await expect(pane).toBeVisible()
  const commits = pane.getByTestId('dispatch-ahead-commits')
  await expect(commits.locator('li')).toHaveCount(2)
  // The commit that names a run links to it.
  await expect(commits.getByRole('link', { name: /ui-polish-001/ })).toBeVisible()
  // Every landing shows its local and origin state, an unknown one shown as unknown.
  const landings = pane.getByTestId('dispatch-ahead-landings')
  await expect(landings.locator('li')).toHaveCount(2)
  await expect(landings).toContainText('local main:')
  await expect(landings).toContainText('origin/main:')
  // Escape and Close on the Local commits pane return focus to the "Commits ahead and landings" button (V28).
  await page.keyboard.press('Escape')
  await expect(pane).toHaveCount(0)
  await expect(page.getByTestId('dispatch-ahead-button')).toBeFocused()
  await page.getByTestId('dispatch-ahead-button').click()
  await expect(pane).toBeVisible()
  await pane.getByTestId('dispatch-pane-close').click()
  await expect(pane).toHaveCount(0)
  await expect(page.getByTestId('dispatch-ahead-button')).toBeFocused()
  // Busy is seeded 52 commits ahead: it lists 50 and shows "and 2 more".
  await gotoProjectOpen(page, projectUrl(DISPATCH_BUSY))
  await page.getByTestId('dispatch-ahead-button').click()
  await expect(page.getByTestId('dispatch-ahead-commits').locator('li')).toHaveCount(50)
  await expect(page.getByTestId('dispatch-ahead-more')).toContainText('and 2 more')
  await attach(page, testInfo, 'dispatch-ahead')
})

test(`[scenario:dispatch-folds] Each feature group has a "Steps of this definition" fold, and a group longer than five folds to "Show N more" (${phase})`, async ({ page }, testInfo) => {
  test.slow() // the features are opened on every project page it reads
  await gotoProjectOpen(page, projectUrl(DISPATCH_WIDGETS))
  // One fold per distinct definition revision, above the chart and inside no feature; every feature's steps are reachable.
  const folds = page.getByTestId('dispatch-defs').getByTestId('dispatch-def')
  const revisions = await folds.evaluateAll(els => els.map(el => el.getAttribute('data-revision')))
  expect(new Set(revisions).size, 'one fold per revision').toBe(revisions.length)
  await expect(page.getByTestId('dispatch-features').getByTestId('dispatch-def')).toHaveCount(0)
  const features = await page.getByTestId('dispatch-features').locator('li[data-workflow-id]').evaluateAll(els => els.map(el => el.getAttribute('data-workflow-id')))
  for (const index of revisions.keys()) await folds.nth(index).locator('summary').click()
  const named = (await folds.locator('.dispatch-def-users').allInnerTexts()).flatMap(text => text.split(', '))
  for (const feature of features) expect(named, `${feature}'s steps are reachable from a fold`).toContain(feature)
  const def = folds.first()
  await expect(def).toContainText('Steps of this definition')
  await expect(def.locator('.dispatch-def-list li').first()).toBeVisible()
  await expect(def).toContainText('Verify') // a step's phase
  // The "Newest from people" issue group is longer than five and folds, expanding in place (V8).
  const issues = page.getByTestId('dispatch-gh-issues')
  const more = issues.getByTestId('dispatch-show-more')
  await expect(more).toContainText('Show 1 more')
  await more.click()
  await expect(more).toHaveCount(0)
  await attach(page, testInfo, 'dispatch-folds')
})

// ---- Desktop fixes carried from the first two stages: watching dot, Sessions table, branch, dock message ------------------

test(`The live chip's watching dot is neutral, not the running blue (${phase})`, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(runUrl(RUN_FAILED))
  const chip = page.locator('[data-testid="live-status"][data-state="watching"]')
  await expect(chip).toBeVisible({ timeout: 30_000 })
  const colours = await chip.evaluate(element => {
    const view = element.ownerDocument.defaultView!
    const dot = element.querySelector('[aria-hidden]')!
    const probe = element.ownerDocument.createElement('span')
    probe.style.color = view.getComputedStyle(element.closest('.projects-shell') ?? element.ownerDocument.body).getPropertyValue('--run')
    element.append(probe)
    const run = view.getComputedStyle(probe).color
    probe.remove()
    return { dot: view.getComputedStyle(dot).color, chip: view.getComputedStyle(element).color, run }
  })
  expect(colours.dot, 'the dot takes the chip\'s own neutral colour').toBe(colours.chip)
  expect(colours.dot, 'and not the running tone').not.toBe(colours.run)
})

test(`The Sessions table's header columns line up with every row's cells, and an opened resume command is no wider than itself (${phase})`, async ({ page }) => {
  test.slow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(runUrl(RUN_SESSIONS, undefined, UX_SESSIONS_WORKFLOW_ID))
  await expect(page.getByTestId('sessions-section')).toBeVisible({ timeout: 30_000 })
  const toggle = page.getByTestId('session-resume-toggle').first()
  await toggle.click()
  const tables = page.locator('.ss-rows')
  const count = await tables.count()
  expect(count).toBeGreaterThan(1)
  let rowsChecked = 0
  for (let index = 0; index < count; index += 1) {
    const columns = await tables.nth(index).evaluate(table => {
      const head = [...table.querySelectorAll('.ss-head > *')].map(element => Math.round(element.getBoundingClientRect().x))
      const rows = [...table.querySelectorAll('.ss-row')].map(row => [...row.children].filter(child => !child.classList.contains('ss-resume-open')).map(element => Math.round(element.getBoundingClientRect().x)))
      return { head, rows }
    })
    expect(columns.head.length).toBe(8)
    for (const row of columns.rows) {
      rowsChecked += 1
      expect(row, 'a row has the header\'s eight columns').toHaveLength(8)
      row.forEach((x, column) => expect(Math.abs(x - columns.head[column]), `column ${column} of a row starts where its header does`).toBeLessThanOrEqual(1))
    }
  }
  expect(rowsChecked).toBeGreaterThan(2)
  const command = page.getByTestId('session-resume-command').first()
  await expect(command).toBeVisible()
  const fit = await command.evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth, container: element.parentElement!.clientWidth }))
  expect(fit.scroll, 'the command is not cut').toBeLessThanOrEqual(fit.client)
  expect(fit.client, 'the command box fits its text, not the whole row').toBeLessThan(fit.container - 40)
})

test(`The run page's branch is not cut, and the dock's Now message keeps a readable width beside its Open link at 1440 (${phase})`, async ({ page }) => {
  test.slow()
  await page.setViewportSize({ width: 1440, height: 900 })
  for (const id of [RUN_REVAMP_BLOCKED, RUN_REVAMP_RUNNING, RUN_REVAMP_DONE]) {
    await page.goto(runUrl(id, undefined, REVAMP_PAGES_WORKFLOW_ID))
    await expect(page.getByTestId('run-branch')).toBeVisible({ timeout: 30_000 })
    const branch = await page.getByTestId('run-branch').evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth, overflow: element.ownerDocument.defaultView!.getComputedStyle(element).textOverflow }))
    expect(branch.scroll, 'the branch is not cut').toBeLessThanOrEqual(branch.client)
    expect(branch.overflow).not.toBe('ellipsis')
    const bar = page.getByTestId('live-dock-bar')
    if ((await bar.getAttribute('aria-expanded')) === 'false') await bar.click()
    const headline = liveDock(page).getByTestId('now-headline')
    if (await headline.count() === 0) continue
    const message = headline.locator('> span:nth-child(2)')
    const measured = await message.evaluate(element => element.getBoundingClientRect().width)
    expect(measured, 'the message is not squeezed to a sliver').toBeGreaterThanOrEqual(140)
  }
})

// ---- Chart words, run identities, definition folds and landed chips -----------------------------------------------------

const PHASE_NAMES = ['Challenge', 'Launch', 'Freeze', 'Verify', 'Candidate', 'Review', 'Approval', 'Integrate']
const SHORT_FORMS = ['Ch', 'La', 'Fr', 'Ve', 'Ca', 'Re', 'Ap', 'In']

/** The chart's container width, as the `@container dispatch-chart` query sees it. */
const chartContainerWidth = (page: Page) => page.locator('#dispatch-runs-section').evaluate(element => element.clientWidth)

test(`[scenario:chart-words] An "ended here" count says what it counts, the axis shows full phase names, and a narrow chart explains every short form in a legend (${phase})`, async ({ page }, testInfo) => {
  test.slow() // the features are opened on every project page it reads
  // Wide: the eight full names, the sentence in each non-empty cell, its own name equal to its text, centred under its column.
  // At 1100px the GitHub column leaves the chart under 640px, where the short forms and their legend show instead.
  for (const width of [1440, 1100]) {
    await page.setViewportSize({ width, height: 900 })
    await gotoProjectOpen(page, projectUrl(DISPATCH_WIDGETS))
    const wide = (await chartContainerWidth(page)) > 640
    if (width === 1440) expect(wide, 'the chart is wider than 640px at 1440px').toBe(true)
    const ends = page.locator('li[data-workflow-id="ui-polish"]').getByTestId('dispatch-ends')
    await expect(ends.locator('.dispatch-ends-l')).toHaveText('ended here')
    const cells = ends.locator('.dispatch-en')
    expect(await cells.count()).toBe(8)
    if (wide) {
      await expect(page.locator('.dispatch-ax-full')).toHaveText(PHASE_NAMES)
      await expect(page.getByTestId('dispatch-axis-legend')).toBeHidden()
      let nonEmpty = 0
      for (let column = 0; column < 8; column += 1) {
        const cell = cells.nth(column)
        const sentence = await cell.locator('.dispatch-en-full').count() ? await cell.locator('.dispatch-en-full').innerText() : ''
        if (sentence === '') continue
        nonEmpty += 1
        const count = sentence.split(' ')[0]
        expect(sentence, `column ${column}`).toBe(column === 7 ? `${count} landed` : `${count} ended at ${PHASE_NAMES[column]}`)
        await expect(cell).toHaveAccessibleName(sentence)
        expect(await cell.evaluate(element => element.scrollWidth <= element.clientWidth), `"${sentence}" is not cut`).toBe(true)
      }
      expect(nonEmpty, 'the seeded feature ended at several steps').toBeGreaterThanOrEqual(2)
    } else {
      await expect(page.getByTestId('dispatch-axis-legend')).toBeVisible()
    }
    const verifyCell = await box(cells.nth(3))
    const verifyAxis = await box(page.locator('.dispatch-ax[data-phase="3"]'))
    expect(Math.abs((verifyCell.x + verifyCell.width / 2) - (verifyAxis.x + verifyAxis.width / 2)), `the Verify count is centred under its column at ${width}px`).toBeLessThanOrEqual(2)
    expect(await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') as number).toBeLessThanOrEqual(0)
  }

  // Narrow: a run selected beside the chart at 1024px leaves it under 640px (or a narrower window does).
  await page.setViewportSize({ width: 1024, height: 900 })
  await gotoProjectOpen(page, projectUrl(DISPATCH_WIDGETS))
  await run(page, 'ui-polish-002').click()
  await expect(page.getByTestId('dispatch-pane')).toBeVisible()
  expect(await chartContainerWidth(page), 'the chart container is under 640px with a run selected').toBeLessThan(640)
  const axis = page.getByTestId('dispatch-axis')
  expect(await axis.innerText()).not.toContain('…')
  await expect(page.locator('.dispatch-ax-short')).toHaveText(SHORT_FORMS)
  for (const full of await page.locator('.dispatch-ax-full').all()) await expect(full).toBeHidden()
  // Every short form is explained by a visible legend under the chart, in the chart's container, none clipped.
  const legend = page.getByTestId('dispatch-axis-legend')
  await expect(legend).toBeVisible()
  const containerBox = await box(page.locator('#dispatch-runs-section'))
  const features = await box(page.getByTestId('dispatch-features'))
  const legendBox = await box(legend)
  expect(legendBox.y, 'the legend sits under the chart').toBeGreaterThanOrEqual(features.y + features.height - 1)
  const items = legend.locator('.dispatch-legend-item')
  await expect(items).toHaveCount(8)
  for (let index = 0; index < 8; index += 1) {
    const item = items.nth(index)
    await expect(item).toBeVisible()
    await expect(item).toHaveText(`${SHORT_FORMS[index]} ${PHASE_NAMES[index]}`)
    expect(await item.evaluate(element => element.scrollWidth <= element.clientWidth), `${PHASE_NAMES[index]} is not clipped`).toBe(true)
    const itemBox = await box(item)
    expect(itemBox.x).toBeGreaterThanOrEqual(containerBox.x - 1)
    expect(itemBox.x + itemBox.width).toBeLessThanOrEqual(containerBox.x + containerBox.width + 1)
  }
  expect(await legend.innerText()).not.toContain('…')
  expect(await legend.evaluate(element => element.scrollWidth <= element.clientWidth), 'the legend does not scroll sideways').toBe(true)
  // No axis label or count cell is wider than its column or broken inside a word; a count cell is named by its sentence.
  for (const selector of ['.dispatch-ax', '.dispatch-en']) {
    const widths = await page.locator(selector).evaluateAll(elements => elements.filter(element => element.getClientRects().length > 0).map(element => ({
      fits: element.scrollWidth <= element.clientWidth, oneLine: element.getClientRects().length === 1 && element.getBoundingClientRect().height < 2.4 * parseFloat(element.ownerDocument.defaultView!.getComputedStyle(element).fontSize),
    })))
    expect(widths.length).toBeGreaterThan(0)
    for (const measured of widths) { expect(measured.fits, `${selector} fits its column`).toBe(true); expect(measured.oneLine, `${selector} has no break inside a word`).toBe(true) }
  }
  const counts = page.locator('li[data-workflow-id="ui-polish"] .dispatch-en:has(.dispatch-en-count)')
  expect(await counts.count()).toBeGreaterThanOrEqual(2)
  for (let index = 0; index < await counts.count(); index += 1) {
    const cell = counts.nth(index)
    const full = (await cell.getAttribute('aria-label'))!
    expect(full).toMatch(/^\d+ (ended at (Challenge|Launch|Freeze|Verify|Candidate|Review|Approval)|landed)$/)
    await expect(cell).toHaveAccessibleName(full)
    await expect(cell).toHaveAttribute('title', full)
    expect(await cell.locator('.dispatch-en-count').innerText()).toBe(full.split(' ')[0])
    expect(await cell.ariaSnapshot()).toContain(full)
  }
  expect(await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') as number).toBeLessThanOrEqual(0)
  await attach(page, testInfo, 'chart-words')
})

test(`A run row is named by its whole run id, the folds by their features, and the landed shas are apart and unique (${phase})`, async ({ page }) => {
  test.slow()
  const problems: string[] = []
  page.on('console', message => { if (message.type() === 'error' && /unique "key"|same key/i.test(message.text())) problems.push(message.text()) })
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoProjectOpen(page, projectUrl(DISPATCH_WIDGETS))
  const rows = page.locator('.dispatch-run')
  expect(await rows.count()).toBeGreaterThan(1)
  const ids = await rows.evaluateAll(elements => elements.map(element => ({ id: element.getAttribute('data-run-id')!, shown: element.querySelector('.dispatch-run-id')!.textContent! })))
  for (const { id, shown } of ids) { expect(shown, 'the row names its run in full').toBe(id); expect(shown).not.toMatch(/^\d+$/) }
  // A header chip is the run's number, and its title names the whole run.
  const chipTitles = await page.locator('.dispatch-chip-run').evaluateAll(elements => elements.map(element => element.getAttribute('title')))
  for (const title of chipTitles) expect(ids.map(item => item.id)).toContain(title)
  // Every fold says which features use it, so folds of different revisions are never identical.
  const summaries = await page.getByTestId('dispatch-def').locator('summary').allInnerTexts()
  expect(summaries.length).toBeGreaterThan(0)
  expect(new Set(summaries).size, 'no two folds read the same').toBe(summaries.length)
  const featureIds = await page.getByTestId('dispatch-features').locator('li[data-workflow-id]').evaluateAll(elements => elements.map(element => element.getAttribute('data-workflow-id')!))
  for (const summary of summaries) expect(featureIds.some(feature => summary.includes(feature)), `"${summary}" names a feature`).toBe(true)
  // The landed shas of a feature are separate chips, each once, with room between them.
  const landed = page.locator('.dispatch-landed')
  for (let index = 0; index < await landed.count(); index += 1) {
    const shas = await landed.nth(index).locator('code').allInnerTexts()
    expect(new Set(shas).size, 'a sha is listed once').toBe(shas.length)
    const boxes = await landed.nth(index).locator('code').evaluateAll(elements => elements.map(element => { const rect = element.getBoundingClientRect(); return { x: rect.x, right: rect.right, y: rect.y } }))
    for (let chip = 1; chip < boxes.length; chip += 1) {
      if (Math.abs(boxes[chip].y - boxes[chip - 1].y) < 4) expect(boxes[chip].x - boxes[chip - 1].right, 'the chips are visibly apart').toBeGreaterThanOrEqual(4)
    }
  }
  expect(problems).toEqual([])
})

// ---- The type floor, measured in the app ---------------------------------------------------------------------------------

/**
 * Every visible element that holds its own non-empty text, outside the run stage's zoomed graph, with its computed font size,
 * uppercase flag and a short name. Evaluated in the page as a string (this config has no DOM types).
 */
const READABLE_TEXT = `(() => {
  const found = []
  const exempt = [...document.querySelectorAll('[data-testid="run-stage"] .sb-viewport')]
  for (const element of document.body.querySelectorAll('*')) {
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'defs'].includes(element.tagName)) continue
    if (exempt.some(zone => zone.contains(element))) continue
    const own = [...element.childNodes].filter(node => node.nodeType === 3 && node.textContent.trim() !== '').map(node => node.textContent.trim()).join(' ')
    if (own === '') continue
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    if (rect.width < 2 || rect.height < 2 || style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue
    found.push({ name: element.tagName.toLowerCase() + (element.className && typeof element.className === 'string' ? '.' + element.className.trim().split(/\\s+/).join('.') : ''), text: own.slice(0, 40), size: parseFloat(style.fontSize), uppercase: style.textTransform === 'uppercase', code: element.tagName === 'CODE' })
  }
  return found
})()`

type Measured = { name: string; text: string; size: number; uppercase: boolean; code: boolean }

/** The elements under the floor for the window's width: 13px from 720px (14px under it), uppercase labels 11px. */
async function underTheFloor(page: Page, width: number): Promise<string[]> {
  const measured = await page.evaluate(READABLE_TEXT) as Measured[]
  expect(measured.length, 'the page holds text').toBeGreaterThan(5)
  const floor = width >= 720 ? 13 : 14
  return measured.filter(item => (item.uppercase ? item.size < 11 : item.size < floor - 0.01) || (item.code && width >= 720 && item.size < 13 - 0.01))
    .map(item => `${item.name} "${item.text}" ${item.size}px`)
}

test(`[scenario:type-floor] Nothing the operator reads is under 13px (14px under 720px) except uppercase labels at 11px, on every Projects page, at 1440 and 390 (${phase})`, async ({ page }, testInfo) => {
  test.slow() // twelve page loads
  const pages: [string, string, ((page: Page) => Promise<void>) | null][] = [
    ['the Projects cards', PROJECTS, async p => { await expect(p.getByTestId('dispatch-cards')).toBeVisible({ timeout: 30_000 }) }],
    ['a project page with its step chart', projectUrl(DISPATCH_WIDGETS), async p => { await openAllFeatures(p) }],
    ['Triage', TRIAGE, async p => { await expect(p.getByTestId('recent-runs')).toBeVisible({ timeout: 30_000 }) }],
    ['a feature page', workflowUrl(PROJECT.project_id, WORKFLOW_ID), async p => { await expect(p.locator('a.run-row').first()).toBeVisible({ timeout: 30_000 }) }],
    ['a run page with its dock open and its Sessions table', runUrl(RUN_SESSIONS, undefined, UX_SESSIONS_WORKFLOW_ID), async p => {
      await expect(p.getByTestId('sessions-section')).toBeVisible({ timeout: 30_000 })
      const bar = p.getByTestId('live-dock-bar')
      if ((await bar.count()) > 0 && (await bar.getAttribute('aria-expanded')) === 'false') await bar.click()
    }],
    ['a review node page', runUrl(RUN_SESSIONS, 'review', UX_SESSIONS_WORKFLOW_ID), async p => { await expect(p.getByTestId('node-header')).toBeVisible({ timeout: 30_000 }) }],
  ]
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 })
    for (const [name, url, ready] of pages) {
      await page.goto(url)
      if (ready) await ready(page)
      const under = await underTheFloor(page, width)
      expect(under, `${name} at ${width}px`).toEqual([])
      expect(await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') as number, `${name} is not wider than the window at ${width}px`).toBeLessThanOrEqual(0)
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(projectUrl(DISPATCH_WIDGETS))
  await openAllFeatures(page)
  await attach(page, testInfo, 'type-floor')
})

test(`The current definition's node labels, glyphs and meta lines stay inside their node at the type floor (${phase})`, async ({ page }) => {
  test.slow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(workflowUrl(PROJECT.project_id, WORKFLOW_ID))
  const definition = page.getByTestId('current-definition')
  await expect(definition).toBeVisible({ timeout: 30_000 })
  if ((await definition.getAttribute('open')) === null) await definition.locator('summary').click()
  const graph = page.getByTestId('workflow-graph')
  await expect(graph).toBeVisible()
  const outside = await graph.evaluate(svg => {
    const view = svg.ownerDocument.defaultView!
    const found: string[] = []
    let longest = ''
    for (const node of svg.querySelectorAll('[data-graph-node]')) {
      const shape = node.querySelector('.workflow-node-shape')!.getBoundingClientRect()
      for (const text of node.querySelectorAll('.workflow-node-label, .workflow-node-meta, .workflow-node-glyph')) {
        const box = text.getBoundingClientRect()
        if (text.classList.contains('workflow-node-label') && (text.textContent ?? '').length > longest.length) longest = text.textContent ?? ''
        const size = parseFloat(view.getComputedStyle(text).fontSize)
        if (size < 13) found.push(`${text.textContent} is ${size}px`)
        if (box.left < shape.left - 1 || box.right > shape.right + 1 || box.top < shape.top - 1 || box.bottom > shape.bottom + 1) found.push(`${node.getAttribute('data-graph-node')}: "${text.textContent}" ${Math.round(box.left - shape.left)},${Math.round(shape.right - box.right)},${Math.round(box.top - shape.top)},${Math.round(shape.bottom - box.bottom)}`)
      }
    }
    return { found, longest }
  })
  expect(outside.longest.length, 'the definition has labels').toBeGreaterThan(5)
  expect(outside.found).toEqual([])
})

test(`[scenario:narrow-chart-rows] At 1024 px with a run selected the chart's rows lay out: the date and the landing note wrap inside the chart, a run id is never a column of two characters, and the status command names a runs root (${phase})`, async ({ page }, testInfo) => {
  test.slow()
  await page.setViewportSize({ width: 1024, height: 900 })
  await gotoProjectOpen(page, projectUrl(DISPATCH_WIDGETS))
  await run(page, 'ui-polish-002').click()
  await expect(page.getByTestId('dispatch-pane')).toBeVisible()
  expect(await chartContainerWidth(page), 'the chart container is under 640px with a run selected').toBeLessThan(640)
  const chart = page.getByTestId('dispatch-chart')
  const chartBox = await box(chart)
  // The date and the landing note of every row fit inside their own box.
  const notes = chart.locator('.dispatch-run-when, .dispatch-off')
  expect(await notes.count()).toBeGreaterThan(0)
  for (const [index, fits] of (await notes.evaluateAll(elements => elements.map(element => element.scrollWidth <= element.clientWidth))).entries()) expect(fits, `note ${index} fits its box`).toBe(true)
  // Nothing in the chart reaches past its right edge.
  const beyond = await chart.evaluate(element => {
    const right = element.getBoundingClientRect().right
    return [...element.querySelectorAll('*')].filter(node => node.getClientRects().length > 0 && node.getBoundingClientRect().right > right + 1).map(node => `${node.tagName}.${node.className}`)
  })
  expect(beyond, 'no descendant ends right of the chart').toEqual([])
  // A run id is one or two lines, never broken at every hyphen into a narrow column.
  for (const id of await chart.locator('.dispatch-run-id').all()) {
    const lines = await id.evaluate(element => {
      const range = element.ownerDocument.createRange()
      range.selectNodeContents(element)
      return new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size
    })
    expect(lines, `${await id.innerText()} is at most two lines`).toBeLessThanOrEqual(2)
    expect((await box(id)).width, `${await id.innerText()} is not a narrow column`).toBeGreaterThan(60)
  }
  expect(chartBox.width).toBeGreaterThan(0)
  await attach(page, testInfo, 'narrow-chart-rows')
})

test(`The chart's status command reads <runs root>/<run id> with the run id filled in and never a bare run id after status (${phase})`, async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 })
  await gotoProjectOpen(page, projectUrl(DISPATCH_WIDGETS))
  const commands = page.locator('li[data-workflow-id="broken"] code')
  await expect(commands).toHaveText(['python -m workflow status <runs root>/broken-001 --by operator'])
  expect(await page.locator('.dispatch-chart').innerText()).not.toMatch(/workflow status (?!<runs root>)/)
})

test(`[scenario:github-once] A project that is not a git repository says so once and never also "GitHub not read"; while the overview loads the cards say "reading…", and a failed overview keeps "GitHub not read" (${phase})`, async ({ page }, testInfo) => {
  test.slow()
  await page.setViewportSize({ width: 1440, height: 900 })
  const foot = (id: string) => card(page, id).locator('.dispatch-card-foot')
  // The overview held in flight: every card's foot says reading, and nothing says "not read".
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route(url => url.pathname === '/api/dispatch/projects', async route => {
    await gate
    await route.fallback()
  })
  await page.goto(PROJECTS)
  await expect(page.getByTestId('dispatch-cards')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('dispatch-projects-meta')).toContainText('repositories: reading…')
  const cards = page.locator('.dispatch-card')
  expect(await cards.count()).toBeGreaterThan(0)
  for (const text of await cards.allInnerTexts()) expect(text).not.toContain('not read')
  expect(await page.getByTestId('dispatch-projects-meta').innerText()).not.toContain('not read')
  for (const text of await page.locator('.dispatch-card-foot').allInnerTexts()) expect(text).toContain('GitHub: reading…')
  release()
  await expect(page.getByTestId('dispatch-projects-meta')).toContainText('projects in', { timeout: 30_000 })
  await expect(page.locator('.dispatch-card-foot').filter({ hasText: 'GitHub: reading…' })).toHaveCount(0)

  // The normal text: a non-git project says "not a git repository" once; no GitHub remote once; another reason keeps its words.
  const noGit = await card(page, DISPATCH_UNREADABLE).innerText()
  expect(occurrences(noGit, 'not a git repository'), noGit).toBe(1)
  expect(noGit).not.toContain('GitHub not read')
  const local = await card(page, DISPATCH_LOCAL).innerText()
  expect(occurrences(local, 'no GitHub remote'), local).toBe(1)
  await attach(page, testInfo, 'github-once')

  // Any other not-read reason is said as before, on its card.
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  if (phase === 'worker') await installProjectMocks(page)
  await answerOverview(page, project => { if (project.project_id === DISPATCH_TRIO) project.github = { status: 'unavailable', reason: 'gh is not installed', ...NOT_READ } })
  await page.goto(PROJECTS)
  await expect(page.getByTestId('dispatch-projects-meta')).toContainText('projects in', { timeout: 30_000 })
  await expect(foot(DISPATCH_TRIO)).toContainText('GitHub not read: gh is not installed')

  // An overview that failed: the cards say "GitHub not read".
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  if (phase === 'worker') await installProjectMocks(page)
  await page.route(url => url.pathname === '/api/dispatch/projects', route => route.fulfill({ status: 500, json: { error: { code: 'INTERNAL', message: 'The overview failed.' } } }))
  await page.goto(PROJECTS)
  await expect(page.getByTestId('dispatch-projects-meta')).toContainText('repositories not read', { timeout: 30_000 })
  for (const text of await page.locator('.dispatch-card-foot').allInnerTexts()) expect(text).toContain('GitHub not read')

  // The non-git project's own page: the Local and GitHub card never says "GitHub not read"; the header keeps "git not read".
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  if (phase === 'worker') await installProjectMocks(page)
  await gotoProjectOpen(page, projectUrl(DISPATCH_UNREADABLE))
  // The git read has answered (the header says why it could not be read) before the card is judged.
  await expect(page.getByTestId('dispatch-project-header')).toContainText('git not read', { timeout: 30_000 })
  await expect(page.getByTestId('dispatch-gh-local')).toBeVisible()
  expect(await page.getByTestId('dispatch-gh-local').innerText()).not.toContain('GitHub not read')
})
