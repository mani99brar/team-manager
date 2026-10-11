/**
 * The Projects dispatch scenarios (docs/PRD_PROJECTS_DISPATCH.md, policy.json): the Projects page and its cards, the
 * projects-only rail, Triage, the project page, the step chart, the reading pane, the GitHub cards, the git truth, the phone
 * layout, and run 002's fixes — the docked pane, the aligned axis, "Needs you and running", the commits-ahead view and the
 * folds. Each scenario is one test, titled `[scenario:<id>]`, with one `screenshot:<id>`. Worker phase: the dispatch routes
 * are mocked from `fixtures/dispatch.ts` through `installHooks`; candidate phase: the real server serves the seeded repositories.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { attach, installHooks, phase, projectUrl, renderedText, workspace } from './support.ts'
import {
  DISPATCH_BUSY, DISPATCH_LOCAL, DISPATCH_NOORIGIN, DISPATCH_TRIO, DISPATCH_UNREADABLE, DISPATCH_WIDGETS, DISPATCH_WIDGETS_WT,
} from './fixtures/dispatch.ts'

installHooks()

const PROJECTS = '/projects'
const TRIAGE = '/projects/-/triage'
const card = (page: Page, id: string) => page.locator(`.dispatch-card[data-project-id="${id}"]`)
const railRow = (page: Page, id: string) => page.locator(`.dispatch-rail-row[data-project-id="${id}"]`)
const run = (page: Page, id: string) => page.locator(`.dispatch-run[data-run-id="${id}"]`)

/** The bounding box of a locator, or a failing assertion. */
async function box(locator: Locator) {
  const b = await locator.boundingBox()
  expect(b, 'the element has a layout box').not.toBeNull()
  return b!
}

test(`[scenario:dispatch-overview] /projects shows one card per project in rail order with state, repository, sync, counts and GitHub; the runs-read time is fixed (${phase})`, async ({ page }, testInfo) => {
  await page.goto(PROJECTS)
  await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible()
  await expect(page.getByTestId('dispatch-projects-meta')).toContainText('projects in')
  await expect(page.getByTestId('dispatch-cards')).toBeVisible()
  // The three readable-feature project whose worst latest result is failed (its fourth workflow cannot be read, [L8]).
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
  await page.goto(projectUrl(DISPATCH_WIDGETS))
  await page.getByTestId('rail-triage').click()
  await expect(page).toHaveURL(/\/projects\/-\/triage$/)
  await page.getByTestId('rail-all-projects').click()
  await expect(page).toHaveURL(/\/projects$/)
  await attach(page, testInfo, 'dispatch-triage')
})

test(`[scenario:dispatch-project] The project page header shows repository, checkout, sync, figures and jump buttons that move focus; git-not-read says so (${phase})`, async ({ page }, testInfo) => {
  await page.goto(projectUrl(DISPATCH_WIDGETS))
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
  // The filter narrows the run rows; Escape clears it.
  const filter = page.locator('#dispatch-filter')
  await filter.fill('ui-polish-001')
  await expect(run(page, 'ui-polish-002')).toHaveCount(0)
  await expect(run(page, 'ui-polish-001')).toHaveCount(1)
  await filter.focus()
  await page.keyboard.press('Escape')
  await expect(filter).toHaveValue('')
  // A project whose git could not be read says "git not read", never "checkout detached".
  await page.goto(projectUrl(DISPATCH_UNREADABLE))
  await expect(page.getByTestId('dispatch-project-header')).toContainText('git not read')
  await expect(page.getByTestId('dispatch-project-header')).not.toContainText('detached')
  await attach(page, testInfo, 'dispatch-project')
})

test(`[scenario:dispatch-chart] The step chart: sticky axis once, solid/dotted track, lane dots, chips, landed sha, ended counts, 440px collapse, and a workflow-level error with the literal placeholder (${phase})`, async ({ page }, testInfo) => {
  await page.goto(projectUrl(DISPATCH_WIDGETS))
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
  await expect(broken).toContainText('python -m workflow status broken-001 --by operator')
  // A workflow whose runs could not be listed: Trio's extra workflow, its row with the literal `<run-id>` placeholder ([P34]).
  await page.goto(projectUrl(DISPATCH_TRIO))
  const locked = page.locator('li[data-workflow-id="trio-locked"]')
  await expect(locked).toContainText('cannot be read')
  await expect(locked).toContainText('could not be listed')
  await expect(locked).toContainText('python -m workflow status <run-id> --by operator')
  // Every feature group exposes the "Steps of this definition" fold, the unreadable workflow included (V7, [P30]).
  await expect(locked.getByTestId('dispatch-def')).toHaveCount(1)
  await expect(locked.getByTestId('dispatch-def')).toContainText('Steps of this definition')
  await attach(page, testInfo, 'dispatch-chart')
})

test(`[scenario:dispatch-pane] Selecting a run docks the pane with facts, the lead, steps, today's CommandBlock and Open run page; j/k move; Close and Escape undock and return focus (${phase})`, async ({ page }, testInfo) => {
  await page.goto(projectUrl(DISPATCH_WIDGETS))
  // With nothing selected there is no pane and the project is not docked.
  await expect(page.getByTestId('dispatch-pane')).toHaveCount(0)
  await expect(page.getByTestId('dispatch-project')).not.toHaveClass(/has-pane/)
  await run(page, 'ui-polish-002').click()
  const pane = page.getByTestId('dispatch-pane')
  await expect(pane).toBeVisible()
  await expect(pane).toHaveAttribute('data-run-id', 'ui-polish-002')
  await expect(pane.getByTestId('dispatch-pane-lead')).toBeVisible()
  await expect(pane.getByTestId('dispatch-pane-steps')).toBeVisible()
  // Today's CommandBlock, fed by the run's NextStep (not a fixed status line): its lead and the command block render.
  await expect(pane.getByTestId('dispatch-pane-next-lead')).toBeVisible()
  await expect(pane.getByTestId('now-next')).toBeVisible()
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
  await attach(page, testInfo, 'dispatch-pane')
})

test(`[scenario:dispatch-github] The GitHub cards group PRs and issues, name the match, fold long groups, say the merged scope, and a not-read project keeps local counts (${phase})`, async ({ page }, testInfo) => {
  await page.goto(projectUrl(DISPATCH_WIDGETS))
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
  // A not-read project: every GitHub card says so and shows no GitHub count, while the local sync and counts stay (V11).
  await page.goto(projectUrl(DISPATCH_LOCAL))
  await expect(page.getByTestId('dispatch-gh-prs')).toContainText('GitHub not read: not a GitHub remote')
  await expect(page.getByTestId('dispatch-gh-issues')).toContainText('GitHub not read: not a GitHub remote')
  await expect(page.getByTestId('dispatch-gh-local')).toContainText('GitHub not read')
  await expect(page.getByTestId('dispatch-gh-local')).toContainText('origin/main') // the local sync still shows
  await attach(page, testInfo, 'dispatch-github')
})

test(`[scenario:dispatch-git-truth] The worktree shares its clone; the primary counts against origin with the naming split and the landings by value; no path leaks on every page (${phase})`, async ({ page }, testInfo) => {
  await page.goto(projectUrl(DISPATCH_WIDGETS_WT))
  await expect(page.getByTestId('dispatch-gh-local')).toContainText('shares its clone with Widgets')
  await expect(railRow(page, DISPATCH_WIDGETS_WT)).not.toContainText('unpushed')
  // The Also checked out as card names the other checkout and whether it is the same clone.
  await expect(page.getByTestId('dispatch-gh-others')).toContainText('same clone')
  await page.goto(projectUrl(DISPATCH_WIDGETS))
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
  await page.goto(projectUrl(DISPATCH_NOORIGIN))
  await expect(page.getByTestId('dispatch-gh-local')).toContainText('not compared with origin')
  // renderedText passes on every seeded page and a workflow page (V21): no absolute path reaches the browser.
  for (const url of [PROJECTS, TRIAGE, projectUrl(DISPATCH_WIDGETS), projectUrl(DISPATCH_WIDGETS_WT), projectUrl(DISPATCH_NOORIGIN), projectUrl(DISPATCH_LOCAL), projectUrl(DISPATCH_TRIO), projectUrl(DISPATCH_BUSY), projectUrl(DISPATCH_UNREADABLE), `${projectUrl(DISPATCH_WIDGETS)}/workflows/ui-polish`]) {
    await page.goto(url)
    await renderedText(workspace(page))
  }
  await page.goto(projectUrl(DISPATCH_WIDGETS))
  await attach(page, testInfo, 'dispatch-git-truth')
})

test(`[scenario:dispatch-phone] At 390 px the rail is a chip row, cards stack, the GitHub column stacks, the pane fills the screen, and every target is at least 44 px (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(PROJECTS)
  const chips = page.getByTestId('dispatch-chips')
  await expect(chips).toBeVisible()
  await expect(chips).toContainText('All projects')
  await expect(chips).toContainText('Triage')
  const noSideways = async () => expect(await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') as number).toBeLessThanOrEqual(0)
  await noSideways()
  await page.goto(projectUrl(DISPATCH_WIDGETS))
  await noSideways()
  await run(page, 'ui-polish-002').click()
  const pane = page.getByTestId('dispatch-pane')
  await expect(pane).toHaveClass(/phone/)
  await expect(pane.getByTestId('dispatch-pane-queue')).toBeVisible()
  await expect(pane.getByTestId('dispatch-pane-next')).toBeVisible()
  // "Queue" returns to the run list (never the previous run).
  await pane.getByTestId('dispatch-pane-queue').click()
  await expect(page.getByTestId('dispatch-pane')).toHaveCount(0)
  // Measure the targets inside the dispatch regions (string-form evaluate, so the build's tsc need not type the DOM globals).
  const short = await page.evaluate(`(() => {
    const roots = ['[data-testid="dispatch-chips"]', '[data-testid="dispatch-project-header"]', '.breadcrumbs', '[data-testid="dispatch-github"]']
      .map(s => document.querySelector(s)).filter(Boolean)
    const bad = []
    for (const root of roots) for (const el of root.querySelectorAll('a, button, input')) {
      const r = el.getBoundingClientRect()
      if (r.height > 0 && r.height < 44) bad.push(el.tagName + ' ' + (el.textContent || '').trim().slice(0, 24) + ' (' + Math.round(r.height) + 'px)')
    }
    return bad
  })()`) as string[]
  expect(short, `targets under 44px: ${short.join('; ')}`).toEqual([])
  await attach(page, testInfo, 'dispatch-phone')
})

test(`[scenario:dispatch-dock] Selecting a run docks the pane beside the chart without squeezing it or scrolling the page, at 1280, 1440 and 1920 px (${phase})`, async ({ page }, testInfo) => {
  for (const width of [1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(projectUrl(DISPATCH_WIDGETS))
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
    // No horizontal page scroll and the window did not scroll away when the run was selected.
    const overflow = await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') as number
    expect(overflow).toBeLessThanOrEqual(0)
    expect(await page.evaluate('window.scrollY') as number).toBeLessThanOrEqual(2)
  }
  await attach(page, testInfo, 'dispatch-dock')
})

test(`[scenario:dispatch-axis] Each stop glyph's centre lies within its phase label's column and no label is cut with an ellipsis, at 1440 and 1100 px (${phase})`, async ({ page }, testInfo) => {
  for (const width of [1440, 1100]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(projectUrl(DISPATCH_WIDGETS))
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
  await page.goto(projectUrl(DISPATCH_BUSY))
  const needs = page.getByTestId('dispatch-needs')
  await expect(needs).toContainText('Needs you and running')
  await expect(needs.getByRole('link', { name: /ship-001/ })).toBeVisible()
  await expect(needs.getByRole('link', { name: /ship-002/ })).toBeVisible()
  await expect(needs).toContainText('waits on you')
  await expect(needs).toContainText('running')
  // The section sits before the step chart.
  const needsBox = await box(needs)
  const chartBox = await box(page.getByTestId('dispatch-chart'))
  expect(needsBox.y).toBeLessThan(chartBox.y)
  // A compared sync whose reflog time is missing says "update time not recorded" in the header and on the card ([L9], V10).
  await expect(page.getByTestId('dispatch-sync')).toContainText('update time not recorded')
  await expect(page.getByTestId('dispatch-gh-local')).toContainText('update time not recorded')
  // The Widgets primary has neither waiting nor running runs.
  await page.goto(projectUrl(DISPATCH_WIDGETS))
  await expect(page.getByTestId('dispatch-needs-none')).toContainText('Nothing waits on you; nothing running')
  await expect(page.getByTestId('dispatch-same-repo')).toContainText('same repo as Widgets worktree')
  await page.goto(projectUrl(DISPATCH_WIDGETS_WT))
  await expect(page.getByTestId('dispatch-same-repo')).toContainText('same repo as Widgets')
  await attach(page, testInfo, 'dispatch-sections')
})

test(`[scenario:dispatch-ahead] The commits-ahead button lists the commits and the landings in the pane; Busy shows 50 and "and 2 more" (${phase})`, async ({ page }, testInfo) => {
  await page.goto(projectUrl(DISPATCH_WIDGETS))
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
  // Busy is seeded 52 commits ahead: it lists 50 and shows "and 2 more".
  await page.goto(projectUrl(DISPATCH_BUSY))
  await page.getByTestId('dispatch-ahead-button').click()
  await expect(page.getByTestId('dispatch-ahead-commits').locator('li')).toHaveCount(50)
  await expect(page.getByTestId('dispatch-ahead-more')).toContainText('and 2 more')
  await attach(page, testInfo, 'dispatch-ahead')
})

test(`[scenario:dispatch-folds] Each feature group has a "Steps of this definition" fold, and a group longer than five folds to "Show N more" (${phase})`, async ({ page }, testInfo) => {
  await page.goto(projectUrl(DISPATCH_WIDGETS))
  const def = page.getByTestId('dispatch-def').first()
  await expect(def).toContainText('Steps of this definition')
  await def.locator('summary').click()
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
