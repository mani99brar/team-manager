/**
 * The Projects dispatch scenarios (docs/PRD_PROJECTS_DISPATCH.md, policy.json): the Projects page and its cards, the
 * projects-only rail, Triage, the project page, the step chart, the reading pane, the GitHub cards, the git truth and the
 * phone layout. Each scenario is one test, titled `[scenario:<id>]`, with one `screenshot:<id>`. Worker phase: the dispatch
 * routes are mocked from `fixtures/dispatch.ts` through `installHooks`; candidate phase: the real server serves the seeded
 * repositories and the GitHub fixture.
 */
import { test, expect } from '@playwright/test'
import { attach, installHooks, phase, projectUrl, renderedText, workspace } from './support.ts'
import { DISPATCH_LOCAL, DISPATCH_NOORIGIN, DISPATCH_TRIO, DISPATCH_UNREADABLE, DISPATCH_WIDGETS, DISPATCH_WIDGETS_WT } from './fixtures/dispatch.ts'

installHooks()

const PROJECTS = '/projects'
const TRIAGE = '/projects/-/triage'
const card = (page: import('@playwright/test').Page, id: string) => page.locator(`.dispatch-card[data-project-id="${id}"]`)
const railRow = (page: import('@playwright/test').Page, id: string) => page.locator(`.dispatch-rail-row[data-project-id="${id}"]`)

test(`[scenario:dispatch-overview] /projects shows one card per project in rail order with state, repository, sync, counts and GitHub (${phase})`, async ({ page }, testInfo) => {
  await page.goto(PROJECTS)
  await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible()
  await expect(page.getByTestId('dispatch-projects-meta')).toContainText('projects in')
  await expect(page.getByTestId('dispatch-cards')).toBeVisible()
  // The three-feature project whose worst latest result is failed.
  await expect(card(page, DISPATCH_TRIO)).toContainText('1 of 3 features failed last')
  // The GitHub primary clone: the sync wording, the repository, the public chip and the open counts.
  await expect(card(page, DISPATCH_WIDGETS)).toContainText('2 ahead, 1 behind origin/main')
  await expect(card(page, DISPATCH_WIDGETS)).toContainText('acme/widgets')
  await expect(card(page, DISPATCH_WIDGETS).locator('.dispatch-vis')).toHaveText('public')
  await expect(card(page, DISPATCH_WIDGETS)).toContainText('open PR')
  await expect(card(page, DISPATCH_WIDGETS)).toContainText('open issue')
  // The non-GitHub project: no chip, the fixed reason.
  await expect(card(page, DISPATCH_LOCAL)).toContainText('GitHub not read: not a GitHub remote')
  await expect(card(page, DISPATCH_LOCAL).locator('.dispatch-vis')).toHaveCount(0)
  // A card is one link to the project page.
  await card(page, DISPATCH_WIDGETS).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${DISPATCH_WIDGETS}$`))
  await attach(page, testInfo, 'dispatch-overview')
})

test(`[scenario:dispatch-rail] The projects-only rail shows All projects, Triage, then projects; needs-you first, unreadable last, unpushed on the primary only (${phase})`, async ({ page }, testInfo) => {
  await page.goto(PROJECTS)
  const rail = page.getByTestId('dispatch-rail')
  await expect(rail.getByTestId('rail-all-projects')).toBeVisible()
  await expect(rail.getByTestId('rail-triage')).toBeVisible()
  // Only projects in the list, no workflow rows or repository headers; every row is a project link in a tone.
  await expect(page.getByTestId('dispatch-rail-list').locator('.dispatch-rail-row').first()).toHaveClass(/tone-/)
  // Wait for the run state to settle (the badges prove it loaded), then read the order.
  await expect(railRow(page, DISPATCH_LOCAL)).toContainText('1 waits on you')
  await expect(railRow(page, DISPATCH_UNREADABLE)).toContainText('cannot be read')
  await expect(railRow(page, DISPATCH_WIDGETS)).toContainText('2 unpushed')
  // Needs-you before a readable project with no waiting runs, and the unreadable project last.
  const order = await page.getByTestId('dispatch-rail-list').locator('.dispatch-rail-row').evaluateAll(els => els.map(el => el.getAttribute('data-project-id')))
  expect(order.indexOf(DISPATCH_LOCAL)).toBeLessThan(order.indexOf(DISPATCH_WIDGETS))
  expect(order[order.length - 1]).toBe(DISPATCH_UNREADABLE)
  await expect(railRow(page, DISPATCH_WIDGETS_WT)).not.toContainText('unpushed')
  await railRow(page, DISPATCH_WIDGETS).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${DISPATCH_WIDGETS}$`))
  await expect(railRow(page, DISPATCH_WIDGETS)).toHaveAttribute('aria-current', 'page')
  await attach(page, testInfo, 'dispatch-rail')
})

test(`[scenario:dispatch-triage] /projects/-/triage shows the former Runs home content under the new rail, marked current (${phase})`, async ({ page }, testInfo) => {
  await page.goto(TRIAGE)
  await expect(page.getByTestId('needs-you')).toBeVisible()
  await expect(page.getByTestId('today-runs')).toBeVisible()
  await expect(page.getByTestId('running-runs')).toBeVisible()
  await expect(page.getByTestId('recent-runs')).toBeVisible()
  await expect(page.getByTestId('rail-triage')).toHaveAttribute('aria-current', 'page')
  // Reaching it from a project page, and back to the Projects page.
  await page.goto(projectUrl(DISPATCH_WIDGETS))
  await page.getByTestId('rail-triage').click()
  await expect(page).toHaveURL(/\/projects\/-\/triage$/)
  await page.getByTestId('rail-all-projects').click()
  await expect(page).toHaveURL(/\/projects$/)
  await attach(page, testInfo, 'dispatch-triage')
})

test(`[scenario:dispatch-project] The project page header shows repository, checkout, sync, figures and jump buttons; the filter narrows runs (${phase})`, async ({ page }, testInfo) => {
  await page.goto(projectUrl(DISPATCH_WIDGETS))
  const header = page.getByTestId('dispatch-project-header')
  await expect(header.getByRole('heading', { level: 1, name: 'Widgets' })).toBeVisible()
  await expect(header.getByRole('link', { name: /acme\/widgets/ })).toHaveAttribute('href', 'https://github.com/acme/widgets')
  await expect(header.locator('.dispatch-vis')).toHaveText('public')
  await expect(page.getByTestId('dispatch-sync')).toContainText('2 ahead, 1 behind origin/main')
  await expect(page.getByTestId('dispatch-sync')).toContainText('as of')
  await expect(page.getByTestId('dispatch-figures')).toContainText('succeeded')
  await expect(header.getByRole('button', { name: 'Runs by feature' })).toBeVisible()
  await header.getByRole('button', { name: /Issues ·/ }).click()
  await expect(page.locator('#g-iss')).toBeInViewport()
  // The filter narrows the run rows; Escape clears it.
  const filter = page.locator('#dispatch-filter')
  await filter.fill('ui-polish-001')
  await expect(page.locator('.dispatch-run[data-run-id="ui-polish-002"]')).toHaveCount(0)
  await expect(page.locator('.dispatch-run[data-run-id="ui-polish-001"]')).toHaveCount(1)
  await filter.focus()
  await page.keyboard.press('Escape')
  await expect(filter).toHaveValue('')
  await attach(page, testInfo, 'dispatch-project')
})

test(`[scenario:dispatch-chart] The step chart has a sticky axis of eight phases; a run stopped at verification shows ×3 in Verify; an unreadable feature shows its error and the status command (${phase})`, async ({ page }, testInfo) => {
  await page.goto(projectUrl(DISPATCH_WIDGETS))
  const axis = page.getByTestId('dispatch-axis')
  for (const label of ['Challenge', 'Launch', 'Freeze', 'Verify', 'Candidate', 'Review', 'Approval', 'Integrate']) {
    await expect(axis).toContainText(label)
  }
  const failed = page.locator('.dispatch-run[data-run-id="ui-polish-002"]')
  await expect(failed).toContainText('×3')
  const cell = failed.locator('.dispatch-cell').nth(3) // Verify column
  await expect(cell.locator('.dispatch-stop-glyph')).toHaveCount(1)
  // An integrated run shows its landed sha, and the feature header lists landed shas.
  await expect(page.locator('.dispatch-run[data-run-id="ui-polish-001"]')).toContainText('integrated')
  await expect(page.locator('li[data-workflow-id="ui-polish"] a.lists-group-head')).toContainText('landed')
  // A feature that cannot be read shows its error and the status command.
  const broken = page.locator('li[data-workflow-id="broken"]')
  await expect(broken).toContainText('cannot be read')
  await expect(broken).toContainText('plan.json is missing')
  await expect(broken).toContainText('python -m workflow status broken-001 --by operator')
  await attach(page, testInfo, 'dispatch-chart')
})

test(`[scenario:dispatch-pane] Selecting a run docks the reading pane with facts, steps, a command and Open run page; j/k move; Escape undocks (${phase})`, async ({ page }, testInfo) => {
  await page.goto(projectUrl(DISPATCH_WIDGETS))
  await expect(page.getByTestId('dispatch-pane')).toHaveCount(0)
  await page.locator('.dispatch-run[data-run-id="ui-polish-002"]').click()
  const pane = page.getByTestId('dispatch-pane')
  await expect(pane).toBeVisible()
  await expect(pane).toHaveAttribute('data-run-id', 'ui-polish-002')
  await expect(pane.getByTestId('dispatch-pane-steps')).toBeVisible()
  await expect(pane.getByTestId('dispatch-pane-command')).toContainText('python -m workflow status ui-polish-002')
  await expect(pane.getByTestId('dispatch-pane-copy')).toBeVisible()
  await expect(pane.getByTestId('dispatch-open-run')).toHaveAttribute('href', /ui-polish-002/)
  // k moves the selection up the list (ui-polish-002 is the last run), j moves it back down.
  await page.keyboard.press('k')
  await expect(page.getByTestId('dispatch-pane')).toHaveAttribute('data-run-id', 'ui-polish-001')
  await page.keyboard.press('j')
  await expect(page.getByTestId('dispatch-pane')).toHaveAttribute('data-run-id', 'ui-polish-002')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('dispatch-pane')).toHaveCount(0)
  await attach(page, testInfo, 'dispatch-pane')
})

test(`[scenario:dispatch-github] The GitHub cards group PRs and issues; a non-GitHub project says so (${phase})`, async ({ page }, testInfo) => {
  await page.goto(projectUrl(DISPATCH_WIDGETS))
  const prs = page.getByTestId('dispatch-gh-prs')
  await expect(prs).toContainText('showing the 20 most recently updated')
  await expect(prs).toContainText('Possibly related')
  await expect(prs).toContainText('Yours, open')
  await expect(prs).toContainText('Merged in the last 14 days')
  await expect(prs.getByRole('link', { name: /#42/ })).toHaveAttribute('href', /github\.com\/acme\/widgets\/pull\/42/)
  const issues = page.getByTestId('dispatch-gh-issues')
  await expect(issues).toContainText('Assigned to you')
  await expect(issues).toContainText('from bots among the newest 20')
  await expect(issues).toContainText('2025') // an issue opened in an earlier year keeps its year
  await expect(issues.getByRole('link', { name: /All .* on GitHub/ })).toBeVisible()
  // The non-GitHub project: every GitHub card says so.
  await page.goto(projectUrl(DISPATCH_LOCAL))
  await expect(page.getByTestId('dispatch-gh-prs')).toContainText('GitHub not read: not a GitHub remote')
  await expect(page.getByTestId('dispatch-gh-issues')).toContainText('GitHub not read: not a GitHub remote')
  await attach(page, testInfo, 'dispatch-github')
})

test(`[scenario:dispatch-git-truth] The worktree shares its clone; the primary counts against origin with the naming split and landings; no-origin says so; no path leaks (${phase})`, async ({ page }, testInfo) => {
  await page.goto(projectUrl(DISPATCH_WIDGETS_WT))
  await expect(page.getByTestId('dispatch-gh-local')).toContainText('shares its clone with Widgets')
  await expect(railRow(page, DISPATCH_WIDGETS_WT)).not.toContainText('unpushed')
  await page.goto(projectUrl(DISPATCH_WIDGETS))
  const local = page.getByTestId('dispatch-gh-local')
  await expect(local).toContainText('Counted against origin/main as this clone has it')
  await expect(local).toContainText('this page never fetches')
  await expect(page.getByTestId('dispatch-ahead-naming')).toContainText('Of the 2 ahead, 1 name a run; 1 do not name a known run')
  await expect(local).toContainText('committed')
  await expect(page.getByTestId('dispatch-landings')).toContainText('on local main')
  await expect(page.getByTestId('dispatch-landings')).toContainText('on origin')
  await page.goto(projectUrl(DISPATCH_NOORIGIN))
  await expect(page.getByTestId('dispatch-gh-local')).toContainText('not compared with origin')
  // No absolute path reaches the browser on these pages.
  await page.goto(projectUrl(DISPATCH_WIDGETS))
  await renderedText(workspace(page))
  await attach(page, testInfo, 'dispatch-git-truth')
})

test(`[scenario:dispatch-phone] At 390 px the rail is a chip row, cards stack, the GitHub column stacks and a tapped run fills the screen with Queue and Next (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(PROJECTS)
  const chips = page.getByTestId('dispatch-chips')
  await expect(chips).toBeVisible()
  await expect(chips).toContainText('All projects')
  await expect(chips).toContainText('Triage')
  // Nothing scrolls sideways.
  const overflow = await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') as number
  expect(overflow).toBeLessThanOrEqual(0)
  // A tapped run fills the screen with Queue and Next.
  await page.goto(projectUrl(DISPATCH_WIDGETS))
  await page.locator('.dispatch-run[data-run-id="ui-polish-002"]').click()
  const pane = page.getByTestId('dispatch-pane')
  await expect(pane).toHaveClass(/phone/)
  await expect(pane.getByTestId('dispatch-pane-queue')).toBeVisible()
  await expect(pane.getByTestId('dispatch-pane-next')).toBeVisible()
  await attach(page, testInfo, 'dispatch-phone')
})
