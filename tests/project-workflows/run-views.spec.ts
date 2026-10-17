/**
 * The run's view switcher (docs/PRD_RUN_TEAMS.md 2 "Views and routing", 10 and 11 P0 item 1): Run · Team · GitHub ·
 * Assignment as a `<nav aria-label="Run views">` of four links on every view's identity line and, plain, on a node page's
 * run bar; the current view carries `aria-current="page"`, a switch moves the focus to the view's hidden `h2#run-view-title`,
 * each view is a URL that Back and Forward walk, and on a phone the switcher is one row of four 44 px columns that never
 * scrolls sideways. The Team and GitHub suffixes come from the worker-phase fixture `fixtures/run-views.ts`.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { RUN_VIEWS_RUN } from './fixtures/run-views.ts'
import { attach, EXECUTION_WORDS, executionControlCount, installHooks, nodeDetail, phase, runUrl, runViewLink } from './support.ts'

installHooks()

const VIEWS = ['run', 'team', 'github', 'assignment'] as const
const runPage = runUrl(RUN_VIEWS_RUN)
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const atView = (view: (typeof VIEWS)[number]) => new RegExp(`${escape(runPage)}${view === 'run' ? '' : `/${view}`}$`)
const pageWidth = (page: Page) => page.evaluate('document.documentElement.scrollWidth') as Promise<number>
const switcher = (scope: Page | Locator) => scope.getByRole('navigation', { name: 'Run views' })

/** Asserts the four links in order, their hrefs, and which one (if any) is the current page. */
async function expectLinks(scope: Page | Locator, current: (typeof VIEWS)[number] | null) {
  const links = switcher(scope).getByTestId('run-view-link')
  await expect(links).toHaveCount(4)
  for (const [index, view] of VIEWS.entries()) {
    await expect(links.nth(index)).toHaveAttribute('data-view', view)
    await expect(links.nth(index)).toHaveAttribute('href', view === 'run' ? runPage : `${runPage}/${view}`)
    if (view === current) await expect(links.nth(index)).toHaveAttribute('aria-current', 'page')
    else await expect(links.nth(index)).not.toHaveAttribute('aria-current')
  }
}

/** Every `aria-controls` and `aria-labelledby` on the page points at an element that exists. */
async function expectNoDanglingReferences(page: Page) {
  const dangling = await page.evaluate(() => {
    const doc = (globalThis as unknown as { document: { querySelectorAll: (s: string) => ArrayLike<{ getAttribute: (n: string) => string | null }>; getElementById: (id: string) => unknown } }).document
    const missing: string[] = []
    for (const name of ['aria-controls', 'aria-labelledby']) {
      for (const element of Array.from(doc.querySelectorAll(`[${name}]`))) {
        for (const id of (element.getAttribute(name) ?? '').split(/\s+/).filter(Boolean)) if (doc.getElementById(id) === null) missing.push(`${name}=${id}`)
      }
    }
    return missing
  })
  expect(dangling).toEqual([])
}

test(`[scenario:run-views-switcher] Four view links on the run, Team, GitHub and Assignment views and on a node page's run bar, aria-current on the shown view, the focus on its heading after a switch, and Back/Forward between them (${phase})`, async ({ page }, testInfo) => {
  test.slow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(runPage)
  await expect(page.getByTestId('workflow-graph')).toBeVisible()
  const header = page.getByTestId('run-header')
  await expectLinks(header, 'run')
  await expect(page.getByRole('tablist')).toHaveCount(0)
  // On a desk the switcher sits where the pill was: after the Local/UTC switch, before Controls.
  const order = await switcher(header).evaluate(nav => {
    const element = nav as unknown as { previousElementSibling: { className: string } | null; nextElementSibling: { className: string; getAttribute: (n: string) => string | null } | null }
    return { before: element.previousElementSibling?.className ?? '', after: element.nextElementSibling?.className ?? '' }
  })
  expect(order.before).toContain('sb-fresh')
  for (const link of await switcher(header).getByTestId('run-view-link').all()) expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(36)

  if (phase === 'worker') {
    // The Team suffix follows section 2 (an agent runs, one failed); the accessible name carries it in words.
    const team = runViewLink(header, 'team')
    await expect(team.getByTestId('run-view-suffix')).toHaveText('1 running · 1 failed')
    await expect(team.getByTestId('run-view-suffix')).toHaveAttribute('data-tone', 'run')
    await expect(team).toHaveAccessibleName('Team view, 1 agent running, 1 failed')
    await expect(runViewLink(header, 'github').getByTestId('run-view-suffix')).toBeVisible()
    await expect(runViewLink(header, 'run').getByTestId('run-view-suffix')).toHaveCount(0)
    await expect(runViewLink(header, 'assignment').getByTestId('run-view-suffix')).toHaveCount(0)
  }
  await expect(runViewLink(header, 'team')).toBeVisible()

  // Each switch is a URL, shows its view and moves the focus to the view's hidden heading.
  await runViewLink(header, 'team').click()
  await expect(page).toHaveURL(atView('team'))
  await expect(page.getByTestId('team-view')).toBeVisible()
  await expect(page.getByTestId('workflow-graph')).toHaveCount(0)
  await expectLinks(header, 'team')
  await expect(page.locator('#run-view-title')).toBeFocused()
  await expect(page.locator('#run-view-title')).toHaveText('Team')

  await runViewLink(header, 'github').click()
  await expect(page).toHaveURL(atView('github'))
  await expect(page.getByTestId('gh-view')).toBeVisible()
  await expectLinks(header, 'github')
  await expect(page.locator('#run-view-title')).toBeFocused()

  await runViewLink(header, 'assignment').click()
  await expect(page).toHaveURL(atView('assignment'))
  await expect(page.getByTestId('assignment')).toBeVisible()
  await expectLinks(header, 'assignment')
  await expect(page.locator('#run-view-title')).toBeFocused()
  await expectNoDanglingReferences(page)

  // Back and Forward walk the views.
  await page.goBack()
  await expect(page).toHaveURL(atView('github'))
  await expect(page.getByTestId('gh-view')).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(atView('team'))
  await expectLinks(header, 'team')
  await page.goForward()
  await expect(page).toHaveURL(atView('github'))
  await expectLinks(header, 'github')

  // Every view survives a reload; the Team view keeps its selection in the URL's search.
  await page.goto(`${runPage}/team?session=worker%3Aui&agent=2`)
  await expect(page.getByTestId('team-view')).toBeVisible()
  await expectLinks(header, 'team')
  await expect(page).toHaveURL(new RegExp(`${escape(runPage)}/team\\?session=worker%3Aui&agent=2$`))
  await expectNoDanglingReferences(page)
  // The Team view's phase segments say "not started" (docs/PRD_RUN_TEAMS.md 3.4) and its agent buttons carry agent data (a
  // tool name such as Edit): buttons that only select an agent, a phase or a workflow (`data-team-select`) are left out of the
  // wording check, as the stage's step cards are.
  await expect.poll(() => executionControlCount(page.getByTestId('projects-workspace')
    .locator('button:not([data-graph-node]):not([data-go]):not([data-testid="live-dock-bar"]):not([data-team-select]), input, select, textarea, [role="menuitem"]')
    .filter({ hasText: EXECUTION_WORDS }))).toBe(0)

  // A node page's run bar carries the same four links, plain: no suffix, none the current page.
  await page.goto(runUrl(RUN_VIEWS_RUN, 'launch_ui'))
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'launch_ui')
  const bar = page.locator('.run-bar')
  await expectLinks(bar, null)
  await expect(bar.getByTestId('run-view-suffix')).toHaveCount(0)
  await runViewLink(bar, 'team').click()
  await expect(page).toHaveURL(atView('team'))
  await expect(page.locator('#run-view-title')).toBeFocused()
  await page.goBack()
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'launch_ui')
  await runViewLink(bar, 'run').click()
  await expect(page).toHaveURL(atView('run'))
  await expect(page.getByTestId('workflow-graph')).toBeVisible()

  await page.goto(`${runPage}/team`)
  await expect(page.getByTestId('team-view')).toBeVisible()
  await attach(page, testInfo, 'run-views-switcher')
})

test(`[scenario:run-views-phone] At 390×844 the switcher is its own row of four equal 44 px columns, glyph-only suffixes with the word in the accessible name, and no view scrolls sideways (${phase})`, async ({ page }, testInfo) => {
  test.slow()
  await page.setViewportSize({ width: 390, height: 844 })
  for (const view of VIEWS) {
    await page.goto(view === 'run' ? runPage : `${runPage}/${view}`)
    const nav = switcher(page.getByTestId('run-header'))
    await expect(nav).toBeVisible()
    const links = await nav.getByTestId('run-view-link').all()
    expect(links).toHaveLength(4)
    const boxes = await Promise.all(links.map(async link => (await link.boundingBox())!))
    // One row: the same top, at least 44 px tall, equal widths, filling the row inside the page.
    for (const box of boxes) {
      expect(Math.round(box.y)).toBe(Math.round(boxes[0].y))
      expect(box.height).toBeGreaterThanOrEqual(44)
      expect(Math.abs(box.width - boxes[0].width)).toBeLessThanOrEqual(2)
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(390)
    }
    // The row is below the run id: the switcher has its own row under the identity line's first one.
    const runId = (await page.locator('#run-summary-title').boundingBox())!
    expect(boxes[0].y).toBeGreaterThanOrEqual(runId.y + runId.height)
    // Every label fits its column whole: none is cut by an ellipsis.
    const cut = await nav.locator('.run-view-label').evaluateAll(labels => labels
      .filter(label => (label as unknown as { scrollWidth: number; clientWidth: number }).scrollWidth > (label as unknown as { clientWidth: number }).clientWidth)
      .map(label => (label as unknown as { textContent: string }).textContent))
    expect(cut).toEqual([])
    await expect.poll(() => pageWidth(page)).toBeLessThanOrEqual(390)
    if (phase === 'worker') {
      const team = runViewLink(page, 'team')
      await expect(team.locator('.run-view-glyph')).toBeVisible()
      await expect(team.locator('.run-view-word')).toBeHidden()
      await expect(team).toHaveAccessibleName('Team view, 1 agent running, 1 failed')
    }
  }

  // A node page's run bar: the same four plain links, 44 px tall, in one row.
  await page.goto(runUrl(RUN_VIEWS_RUN, 'launch_ui'))
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'launch_ui')
  const barLinks = await switcher(page.locator('.run-bar')).getByTestId('run-view-link').all()
  expect(barLinks).toHaveLength(4)
  const barBoxes = await Promise.all(barLinks.map(async link => (await link.boundingBox())!))
  for (const box of barBoxes) {
    expect(box.height).toBeGreaterThanOrEqual(44)
    expect(Math.round(box.y)).toBe(Math.round(barBoxes[0].y))
  }
  await expect.poll(() => pageWidth(page)).toBeLessThanOrEqual(390)

  await page.goto(runPage)
  await expect(page.getByTestId('workflow-graph')).toBeVisible()
  await attach(page, testInfo, 'run-views-phone')
})
