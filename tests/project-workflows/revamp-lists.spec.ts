/**
 * Projects viewer revamp, lane `shell` (docs/PRD_VIEWER_REVAMP.md 3, 4, 5.1, 5.5 and 7): Runs home as a project rail and
 * Needs you, Running and Recent sections, and the Calm look with its contrast in both themes.
 *
 * The `revamp-home` scenario adds the `project-B-1..3` family through its own route override of `/api/projects` (the worker
 * phase builds on the mocks' answer, the candidate phase on the real API's), so the folded rail group has something to show;
 * every other spec keeps the two real projects. Both scenarios fix the page clock at `REVAMP_NOW`, just after the
 * `ux-revamp-lists` runs, and assert on those runs only, since the combined candidate also lists other slices' runs.
 */
import { test, expect, type Locator, type Page, type Route } from '@playwright/test'
import { contrastRatio, parseColor } from '../../src/projects/tone.ts'
import { waitingKind } from '../../src/projects/lists.ts'
import type { Project, RunSummary } from '../../contracts/projects/v1.ts'
import { EMPTY_WORKFLOW_ID, PROJECT } from './fixtures.ts'
import {
  PANE_MESSAGE, REVAMP_FAILED_RUNS, REVAMP_FINISHED_RUNS, REVAMP_LANES, REVAMP_LATEST_RUN, REVAMP_NOW, REVAMP_OWN_RUNS, REVAMP_PREFIX, REVAMP_RUN_DAY, REVAMP_SUCCEEDED_RUNS,
  REVAMP_TITLE, RUN_DESK_HELD, RUN_DESK_INTERRUPTED, RUN_DESK_LIVE, RUN_DESK_LIVE_QUIET, RUN_DESK_PANE, RUN_DESK_PAUSED, UX_REVAMP_LISTS_WORKFLOW_ID,
} from './fixtures/ux-revamp-lists.ts'
import { mockResponse } from './mock.ts'
import { attach, expectNoExecutionControls, installHooks, phase, projectsUrl, projectUrl, workflowUrl } from './support.ts'

installHooks()

const FAMILY: Project[] = [1, 2, 3].map(n => ({ project_id: `project-B-${n}`, name: `project-B-${n}` }))
const OWN = [RUN_DESK_PANE, RUN_DESK_LIVE, RUN_DESK_LIVE_QUIET, RUN_DESK_INTERRUPTED, RUN_DESK_PAUSED, RUN_DESK_HELD, ...REVAMP_FINISHED_RUNS]

/** The original answer of an overridden route: the mocks' in the worker phase, the real API's (`route.fetch()`) in the candidate phase. */
async function original(route: Route): Promise<unknown> {
  return phase === 'worker'
    ? JSON.parse(String(mockResponse(new URL(route.request().url())).body))
    : (await route.fetch()).json()
}
const isRunList = (url: URL) => /^\/api\/projects\/[^/]+\/workflows\/[^/]+\/runs$/.test(url.pathname)

/** Adds the `project-B-*` family to the project list, each with no workflow; the worker phase answers from the mocks. */
async function addProjectFamily(page: Page) {
  await page.route(url => url.pathname === '/api/projects', async route => {
    const body = await original(route) as { projects: Project[] }
    body.projects.push(...FAMILY)
    await route.fulfill({ json: body })
  })
  await page.route(url => /^\/api\/projects\/project-B-\d+\/workflows$/.test(url.pathname), route => route.fulfill({ json: { workflows: [] } }))
}

const row = (scope: Locator, runId: string) => scope.locator(`a[data-run-id="${runId}"]`)
/** The run ids a section lists, in order, limited to this module's runs. */
const ownIds = (scope: Locator) => scope.locator('a[data-run-id]').evaluateAll(
  (links, own) => links.map(link => link.getAttribute('data-run-id')).filter((id): id is string => id !== null && own.includes(id)), OWN)
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const showOlder = (recent: Locator) => recent.getByRole('button', { name: /^Show older/ })
async function showAll(recent: Locator) {
  if (await showOlder(recent).count()) await showOlder(recent).click()
  await expect(showOlder(recent)).toHaveCount(0)
}

test(`[scenario:revamp-home] Runs home: a project rail with status dots and the folded project-B group, Needs you and Running as cards, Recent searchable, filterable and grouped by day (${phase})`, async ({ page }, testInfo) => {
  test.setTimeout(90_000)
  await addProjectFamily(page)
  await page.clock.setFixedTime(REVAMP_NOW)
  await page.goto(projectsUrl)

  // The rail: a Needs-you entry outside the project list, each project with a status dot that has a title, and the
  // project-B family folded into one group named by its prefix; nothing failed to load.
  const rail = page.getByTestId('projects-rail')
  const list = page.getByTestId('projects-list')
  const needsEntry = rail.getByTestId('rail-needs-you')
  await expect(needsEntry).toHaveText(/^Needs you · \d+$/)
  expect(await needsEntry.evaluate(element => element.closest('[data-testid="projects-list"]') === null)).toBe(true)
  const alpha = list.getByRole('link', { name: new RegExp(`^${escape(PROJECT.name)}`) })
  await expect(alpha).toContainText(/\d+ features/)
  await expect(alpha.locator('.rail-dot')).toHaveAttribute('data-tone', 'warn')
  await expect(alpha.locator('.rail-dot')).toHaveAttribute('title', 'Needs you')
  const group = list.locator('details[data-prefix="project-B"]')
  await expect(group.locator('summary')).toHaveText(/^project-B \(3\)/)
  await expect(group).toHaveJSProperty('open', false)
  await group.locator('summary').click()
  await expect(group).toHaveJSProperty('open', true)
  await expect(group.getByRole('link')).toHaveCount(3)
  for (const project of FAMILY) {
    const link = group.getByRole('link', { name: new RegExp(`^${escape(project.name)}`) })
    await expect(link).toContainText('0 features')
    await expect(link.locator('.rail-dot')).toHaveAttribute('data-tone', 'idle')
    await expect(link.locator('.rail-dot')).toHaveAttribute('title', 'Idle')
  }
  await expect(page.getByTestId('lists-errors')).toHaveCount(0)
  await expect(rail.getByTestId('projects-info')).toContainText('Read-only')

  // Needs you: a warn-toned card per waiting run, the link its direct child, named by the run id first, with the cause,
  // the feature, the project and the next step as a label; no command and no button on Runs home.
  const needs = page.getByTestId('needs-you')
  await expect(needs.locator('.ui-section-header h2')).toHaveText(/^Needs you · \d+$/)
  const pane = row(needs, RUN_DESK_PANE)
  await expect(pane).toHaveAttribute('data-attention', 'pane')
  expect(await pane.evaluate(link => [link.parentElement?.tagName, link.parentElement?.className])).toEqual(['LI', expect.stringMatching(/\bui-card\b.*\btone-warn\b/)])
  await expect(needs.getByRole('link', { name: new RegExp(`^${RUN_DESK_PANE}\\s`) })).toHaveCount(1)
  const paneName = await pane.evaluate(link => link.textContent ?? '')
  expect(paneName).toContain('adapter needs attention in its pane')
  expect(paneName).toContain(REVAMP_TITLE)
  expect(paneName).toContain(PROJECT.name)
  await expect(pane.getByTestId('next-step')).toHaveText('Next: attend the pane')
  await expect(pane.getByTestId('run-cause')).toContainText(PANE_MESSAGE.slice(0, 30))
  await expect(pane).toContainText('open run ›')
  // Since when it waits and how long ago, from the list clock (20:00): the pane asked at 17:10.
  await expect(pane.locator('.home-card-when')).toHaveText('since 17:10 · 2 h ago')
  await expect(pane.locator('.home-card-when time')).toHaveAttribute('datetime', '2026-03-12T17:10:00Z')
  // Each section of Runs home is a region named by its own heading, for landmark navigation.
  for (const [testId, name] of [['needs-you', /^Needs you · \d+$/], ['running-runs', /^Running · \d+$/], ['recent-runs', /^Recent · \d+$/]] as const) {
    const region = page.getByRole('region', { name })
    await expect(region, testId).toHaveCount(1)
    await expect(region, testId).toHaveAttribute('data-testid', testId)
  }
  await expect(needs.locator('button, pre, [data-testid="now-command"], [data-testid="command-run"]')).toHaveCount(0)
  await expect(needs).not.toContainText('workflow attach')

  // Running: a card per live run with the lanes named from the definition (no state claim) and the elapsed time only.
  const running = page.getByTestId('running-runs')
  for (const [runId, elapsed] of [[RUN_DESK_LIVE, '1h00m'], [RUN_DESK_LIVE_QUIET, '1h30m']] as const) {
    const card = row(running, runId)
    await expect(card).toHaveAttribute('data-status', 'running')
    await expect(card).not.toHaveAttribute('data-attention', /.+/)
    expect(await card.evaluate(link => link.parentElement?.className)).toMatch(/\bui-card\b.*\btone-run\b/)
    await expect(card.locator('[data-lane]')).toHaveText(['ui', 'adapter'])
    await expect(card.getByTestId('run-elapsed')).toHaveText(`running for ${elapsed}`)
    // A running run's line goes on with its start time (the elapsed text alone does not say when).
    await expect(card.locator('.home-card-when')).toHaveText(`running for ${elapsed} · started ${runId === RUN_DESK_LIVE ? '19:00' : '18:30'}`)
    await expect(running.getByRole('link', { name: new RegExp(`^${runId}\\s`) })).toHaveCount(1)
  }
  await expect(row(running, RUN_DESK_PANE)).toHaveCount(0)
  // A live run that stopped (interrupted, or paused on contradictory evidence) is a Running card in its own pause tone, its
  // status chip saying Paused beside the colour; a failed run is finished, so it lists in Recent, never as a Running card.
  const stopped = [[RUN_DESK_INTERRUPTED, '4h00m', 'Supervisor interrupted', '16:20'], [RUN_DESK_PAUSED, '3h30m', 'snapshots captured', '17:00']] as const
  for (const [runId, elapsed, cause, stoppedAt] of stopped) {
    const card = row(running, runId)
    await expect(card).toHaveAttribute('data-status', 'paused')
    await expect(card.locator('.home-card-summary')).toHaveText(new RegExp(`^Paused at Freeze worker handoffs · ${cause}`))
    const tone = await card.evaluate(link => link.parentElement?.className ?? '')
    expect(tone, runId).toMatch(/\bui-card\b.*\btone-pause\b/)
    expect(tone, runId).not.toMatch(/\btone-(run|fail|warn|ok|idle)\b/)
    await expect(card.locator('.status-badge')).toHaveText(/^Paused/)
    await expect(card.locator('[data-lane]')).toHaveText([...REVAMP_LANES])
    // The age is since the run started, and the stop time is said apart: never "paused · 4h00m", which reads as paused for 4h.
    await expect(card.getByTestId('run-elapsed')).toHaveText(`paused · started ${elapsed} ago`)
    await expect(card.locator('.home-card-since')).toHaveText(`since ${stoppedAt}`)
    await expect(row(needs, runId)).toHaveCount(0)
    await expect(row(page.getByTestId('recent-runs'), runId)).toHaveCount(0)
  }
  // A paused run served without attention.since (desk-held: nothing followed the launches, so no step stopped it). Today's
  // waitingKind does not count a pause as waiting, so it is a Running card, not a Needs-you card; its line says when it
  // started once ("started 5h00m ago"), with no "since" and no start time repeated after it.
  const held = row(running, RUN_DESK_HELD)
  await expect(held).toHaveAttribute('data-status', 'paused')
  expect(await held.evaluate(link => link.parentElement?.className ?? '')).toMatch(/\bui-card\b.*\btone-pause\b/)
  await expect(held.locator('.status-badge')).toHaveText(/^Paused/)
  await expect(held.locator('[data-lane]')).toHaveText([...REVAMP_LANES])
  await expect(held.locator('.home-card-when')).toHaveText('paused · started 5h00m ago')
  await expect(held.locator('.home-card-when time, .home-card-since')).toHaveCount(0)
  await expect(row(needs, RUN_DESK_HELD)).toHaveCount(0)
  await expect(row(page.getByTestId('recent-runs'), RUN_DESK_HELD)).toHaveCount(0)
  for (const runId of REVAMP_FAILED_RUNS) await expect(row(running, runId)).toHaveCount(0)
  // The controller chip only from the served reading: alive in the worker-phase mock; nothing for a run without one.
  if (phase === 'worker') await expect(row(running, RUN_DESK_LIVE).locator('[data-controller]')).toHaveText('controller running')
  await expect(row(running, RUN_DESK_LIVE_QUIET).locator('[data-controller="running"]')).toHaveCount(0)

  // Recent: the search narrows to one own row.
  const recent = page.getByTestId('recent-runs')
  const search = page.getByLabel('Search runs')
  await expect(search).toHaveAttribute('id', 'runs-search')
  await search.fill('desk-fail-3')
  await expect(recent.locator('a[data-run-id]')).toHaveCount(1)
  expect(await ownIds(recent)).toEqual(['desk-fail-3'])
  await expect(row(recent, 'desk-fail-3')).toHaveAttribute('data-status', 'failed')

  // Every own run: the first ten rows, then Show older for the four others; rows under Today, Yesterday and the date.
  await search.fill(REVAMP_PREFIX)
  expect(await ownIds(recent)).toEqual(REVAMP_FINISHED_RUNS.slice(0, 10))
  await expect(showOlder(recent)).toHaveText('Show older 4')
  await showOlder(recent).click()
  expect(await ownIds(recent)).toEqual(REVAMP_FINISHED_RUNS)
  const label: Record<string, string> = { '2026-03-12': 'Today', '2026-03-11': 'Yesterday', '2026-03-10': 'Mar 10' }
  for (const runId of REVAMP_FINISHED_RUNS) {
    const day = await row(recent, runId).evaluate(link => {
      const group = link.closest('[data-day]')
      return [group?.getAttribute('data-day'), group?.querySelector('.recent-group-label')?.textContent]
    })
    expect(day, runId).toEqual([REVAMP_RUN_DAY[runId], label[REVAMP_RUN_DAY[runId]]])
  }
  // A row keeps one link in an li, named by its run id first, with its outcome on one line and the full text in its title.
  const failedRow = row(recent, 'desk-fail-1')
  expect(await failedRow.evaluate(link => link.parentElement?.tagName)).toBe('LI')
  await expect(recent.getByRole('link', { name: /^desk-fail-1\s/ })).toHaveCount(1)
  await expect(failedRow.locator('.run-row-summary')).toHaveAttribute('title', /^Failed at Verify ui/)
  await expect(failedRow.locator('time').first()).toHaveText('13:52')

  // Failed keeps only failed rows: every own failed run, no succeeded one.
  await recent.getByRole('button', { name: /^Failed \d+$/ }).click()
  await expect(recent.getByRole('button', { name: /^Failed/ })).toHaveAttribute('aria-pressed', 'true')
  expect(await ownIds(recent)).toEqual(REVAMP_FAILED_RUNS)
  for (const status of await recent.locator('a[data-run-id]').evaluateAll(links => links.map(link => link.getAttribute('data-status')))) expect(status).toBe('failed')
  // Without the search, other slices' later failed runs sit above; Show older makes every own failed run visible.
  await search.fill('')
  await showAll(recent)
  expect(await ownIds(recent)).toEqual(REVAMP_FAILED_RUNS)
  for (const runId of REVAMP_SUCCEEDED_RUNS) await expect(row(recent, runId)).toHaveCount(0)
  for (const status of await recent.locator('a[data-run-id]').evaluateAll(links => links.map(link => link.getAttribute('data-status')))) expect(status).toBe('failed')

  // Today keeps what ended today; Succeeded the succeeded rows.
  await search.fill(REVAMP_PREFIX)
  await recent.getByRole('button', { name: 'Today', exact: true }).click()
  expect(await ownIds(recent)).toEqual(REVAMP_FINISHED_RUNS.filter(runId => REVAMP_RUN_DAY[runId] === '2026-03-12'))
  await recent.getByRole('button', { name: /^Succeeded \d+$/ }).click()
  await showAll(recent)
  expect(await ownIds(recent)).toEqual(REVAMP_SUCCEEDED_RUNS)

  // Group by project: the rows under their project instead of their day.
  await recent.getByRole('button', { name: 'All', exact: true }).click()
  await recent.getByRole('button', { name: 'Group by project' }).click()
  await expect(recent.getByRole('button', { name: 'Group by project' })).toHaveAttribute('aria-pressed', 'true')
  await showAll(recent)
  const projectGroup = recent.locator(`[data-group="${PROJECT.project_id}"]`)
  await expect(projectGroup.locator('.recent-group-label')).toHaveText(PROJECT.name)
  expect(await ownIds(projectGroup)).toEqual(REVAMP_FINISHED_RUNS)
  await recent.getByRole('button', { name: 'Group by project' }).click()

  // Show older on the whole list: every own run is visible after the click.
  await search.fill('')
  await showAll(recent)
  expect(await ownIds(recent)).toEqual(REVAMP_FINISHED_RUNS)
  for (const runId of OWN) expect(await page.locator(`a[data-run-id="${runId}"]`).count(), runId).toBe(1)

  // Every button on Runs home is a filter, a fold or the header's; none holds a path or a command.
  const texts = await page.getByTestId('projects-workspace').locator('button').allTextContents()
  for (const text of texts) expect(text).toMatch(/^(All|Failed \d+|Succeeded \d+|Today|Group by project|Show older \d+)$/)
  await expectNoExecutionControls(page)
  await attach(page, testInfo, 'revamp-home')

  // At 390 px the rail sits above the sections as a row of chips, and nothing scrolls sideways.
  await page.setViewportSize({ width: 390, height: 844 })
  const railBox = await rail.boundingBox()
  const needsBox = await needs.boundingBox()
  expect(railBox && needsBox).toBeTruthy()
  expect(railBox!.y + railBox!.height).toBeLessThanOrEqual(needsBox!.y + 1)
  expect(await (page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') as Promise<number>)).toBeLessThanOrEqual(0)
  // The rail's entries lie in a row, not a stack: each project entry starts right of the one before, and Needs you and the
  // entries take at most two lines (Needs you, then the chips). The row scrolls inside the rail (the open group makes it
  // wider than the phone) without widening the page.
  const layout = await rail.evaluate(element => {
    const box = (node: typeof element) => node.getBoundingClientRect()
    const list = element.querySelector('[data-testid="projects-list"]')!
    const entries = [...list.children].map(box)
    const needsTop = box(element.querySelector('[data-testid="rail-needs-you"]')!).top
    return {
      lefts: entries.map(entry => entry.left), tops: [needsTop, ...entries.map(entry => entry.top)].map(Math.round),
      overflowX: element.ownerDocument.defaultView!.getComputedStyle(list).overflowX, scrollWidth: list.scrollWidth, clientWidth: list.clientWidth, right: box(list).right,
    }
  })
  expect(layout.lefts.length, 'rail entries').toBeGreaterThanOrEqual(3)
  for (let index = 1; index < layout.lefts.length; index += 1) expect(layout.lefts[index], `entry ${index} lies right of entry ${index - 1}`).toBeGreaterThan(layout.lefts[index - 1])
  expect(new Set(layout.tops).size, `distinct tops ${layout.tops.join(', ')}`).toBeLessThanOrEqual(2)
  expect(layout.overflowX).toBe('auto')
  expect(layout.scrollWidth, 'the row is wider than the phone, so it scrolls inside the rail').toBeGreaterThan(layout.clientWidth)
  expect(layout.right).toBeLessThanOrEqual(390)
  expect(await (page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') as Promise<number>)).toBeLessThanOrEqual(0)
  // The folded group stays open as the reader left it, across a reload.
  await page.reload()
  await expect(page.getByTestId('projects-list').locator('details[data-prefix="project-B"]')).toHaveJSProperty('open', true)
})

/** The token pairs every primitive draws text with (PRD_VIEWER_REVAMP 4). */
const PAIRS: [string, string][] = [
  ['--ok', '--ok-soft'], ['--run', '--run-soft'], ['--warn', '--warn-soft'], ['--fail', '--fail-soft'], ['--pause', '--pause-soft'], ['--idle', '--idle-soft'],
  ['--sev-fg', '--p0'], ['--sev-fg', '--p1'], ['--sev-fg', '--p2'],
  ['--fg', '--surface'], ['--fg', '--bg'], ['--muted', '--surface'], ['--muted', '--bg'],
]

/** A colour's relative luminance proxy: its contrast against black (higher is lighter). */
const luminanceOf = (colour: string) => contrastRatio(colour, 'rgb(0, 0, 0)')

async function tokens(shell: Locator): Promise<Record<string, string>> {
  const names = [...new Set(PAIRS.flat())]
  return shell.evaluate((element, list) => {
    const style = element.ownerDocument.defaultView!.getComputedStyle(element)
    return Object.fromEntries(list.map(name => [name, style.getPropertyValue(name).trim()]))
  }, names)
}

/** Every rendered chip's text colour and the opaque background it is drawn on (its own, else the nearest ancestor's). */
async function renderedChips(shell: Locator) {
  return shell.locator('.ui-chip, .ui-sev, .status-badge').evaluateAll(elements => elements.filter(element => element.getClientRects().length > 0).map(element => {
    const view = element.ownerDocument.defaultView!
    let background = 'rgba(0, 0, 0, 0)'
    for (let node: typeof element | null = element; node; node = node.parentElement) {
      const color = view.getComputedStyle(node).backgroundColor
      if (!/rgba\(.*, 0\)$/.test(color) && color !== 'transparent') { background = color; break }
    }
    return { text: (element.textContent ?? '').trim(), color: view.getComputedStyle(element).color, background, className: String(element.getAttribute('class')) }
  }))
}

test(`[scenario:revamp-look] Calm is the only look: no look switch and no data-look anywhere, and every chip reads at 4.5:1 in both themes (${phase})`, async ({ page }, testInfo) => {
  test.setTimeout(90_000)
  await page.clock.setFixedTime(REVAMP_NOW)
  await page.goto(projectsUrl)
  const shell = page.getByTestId('projects-workspace')
  const needsCard = page.getByTestId('needs-you').locator(`li:has(> a[data-run-id="${RUN_DESK_PANE}"])`)
  const background = (target: Locator) => target.evaluate(element => element.ownerDocument.defaultView!.getComputedStyle(element).backgroundColor)
  await expect(needsCard).toHaveCount(1)

  // No switch and no look attribute, on the shell, <html>, <body> or anywhere else; the header's first button is Refresh.
  await expect(page.locator('.look-switch')).toHaveCount(0)
  await expect(page.locator('[data-look]')).toHaveCount(0)
  expect(await page.evaluate("[document.documentElement.hasAttribute('data-look'), document.body.hasAttribute('data-look')]")).toEqual([false, false])
  expect(await page.evaluate("document.querySelector('.app-header button')?.textContent")).toMatch(/^Refresh/)
  await attach(page, testInfo, 'revamp-look')
  await expect(page.getByTestId('recent-runs').locator('a[data-run-id]').first()).toBeVisible()

  // Both themes: every token pair the primitives use, and every rendered chip, at 4.5:1 or more.
  const surfaces: Record<string, { bg: string; fg: string; surface: string; pageBackground: string }> = {}
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    // The emulated scheme took effect: the page itself now matches it, and nothing pins the other one.
    expect(await page.evaluate("matchMedia('(prefers-color-scheme: dark)').matches"), colorScheme).toBe(colorScheme === 'dark')
    const values = await tokens(shell)
    surfaces[colorScheme] = { bg: values['--bg'], fg: values['--fg'], surface: values['--surface'], pageBackground: await background(shell) }
    for (const [fg, bg] of PAIRS) {
      expect(parseColor(values[bg]), `${colorScheme}: ${bg} = ${values[bg]}`).not.toBeNull()
      expect(contrastRatio(values[fg], values[bg]), `${colorScheme}: ${fg} ${values[fg]} on ${bg} ${values[bg]}`).toBeGreaterThanOrEqual(4.5)
    }
    const chips = await renderedChips(shell)
    expect(chips.some(chip => chip.className.includes('ui-chip')), `${colorScheme}: chips rendered`).toBe(true)
    expect(chips.some(chip => chip.className.includes('status-badge')), `${colorScheme}: status badges rendered`).toBe(true)
    for (const chip of chips) {
      expect(chip.text.length, `${colorScheme}: ${chip.className} keeps its text`).toBeGreaterThan(0)
      expect(contrastRatio(chip.color, chip.background), `${colorScheme}: "${chip.text}" (${chip.className}) ${chip.color} on ${chip.background}`).toBeGreaterThanOrEqual(4.5)
    }
  }
  // The dark set really was measured: the dark tokens, and the shell's own painted background, differ from the light ones
  // (a dark ground under light text), so the loop above did not read the light set twice.
  for (const key of ['bg', 'fg', 'surface', 'pageBackground'] as const) expect(surfaces.dark[key], `${key} changes with the theme`).not.toBe(surfaces.light[key])
  expect(luminanceOf(surfaces.dark.bg), 'the dark --bg is dark').toBeLessThan(luminanceOf(surfaces.light.bg))
  expect(luminanceOf(surfaces.dark.fg), 'the dark --fg is light').toBeGreaterThan(luminanceOf(surfaces.light.fg))
  await expectNoExecutionControls(page)
})

test(`Runs home with nothing waiting: "Needs you · 0" with the empty state in the section sub-header (${phase})`, async ({ page }) => {
  // Every run list answers without the runs that wait on the operator (the same waitingKind predicate Runs home uses).
  await page.route(isRunList, async route => {
    const body = await original(route) as { runs: RunSummary[]; next_cursor: string | null }
    await route.fulfill({ json: { ...body, runs: body.runs.filter(run => waitingKind(run) === null) } })
  })
  await page.clock.setFixedTime(REVAMP_NOW)
  await page.goto(projectsUrl)
  const needs = page.getByTestId('needs-you')
  // The rest of Runs home still reads its runs, so the empty state is not a page that failed to load.
  await expect(row(page.getByTestId('running-runs'), RUN_DESK_LIVE)).toHaveCount(1)
  await expect(needs.locator('.ui-section-header h2')).toHaveText('Needs you · 0')
  await expect(needs.locator('.ui-section-header .ui-sub')).toHaveText('nothing waits on you')
  await expect(needs.locator('li, a[data-run-id]')).toHaveCount(0)
  await expect(page.getByTestId('rail-needs-you')).toHaveText('Needs you · 0')
  await expect(page.locator(`a[data-run-id="${RUN_DESK_PANE}"]`)).toHaveCount(0)
  await expect(page.getByTestId('lists-errors')).toHaveCount(0)
  expect(await page.title()).not.toMatch(/^\(\d+\)/)
  await expectNoExecutionControls(page)
})

test(`Runs home with a run list that failed to load: a fail-toned Attention card naming the list and the API error (${phase})`, async ({ page }) => {
  const failing = `/api/projects/${PROJECT.project_id}/workflows/${UX_REVAMP_LISTS_WORKFLOW_ID}/runs`
  await page.route(url => url.pathname === failing, route => route.fulfill({ status: 500, json: { error: { code: 'revamp_test', message: 'The run list could not be read' } } }))
  await page.clock.setFixedTime(REVAMP_NOW)
  await page.goto(projectsUrl)
  const attention = page.getByTestId('lists-errors')
  await expect(attention).toHaveAttribute('role', 'alert')
  // Named by its heading, as Needs you, Running and Recent are.
  await expect(page.getByRole('alert', { name: /^Attention · \d+$/ })).toHaveAttribute('data-testid', 'lists-errors')
  await expect(attention.locator('.ui-section-header h2')).toHaveText(/^Attention · \d+$/)
  await expect(attention.locator('.ui-section-header .ui-sub')).toHaveText('Some runs could not be loaded, so these lists may be incomplete.')
  const card = attention.locator('li', { hasText: `${PROJECT.name} · ${UX_REVAMP_LISTS_WORKFLOW_ID}` })
  await expect(card).toHaveCount(1)
  expect(await card.getAttribute('class')).toMatch(/\bui-card\b.*\btone-fail\b/)
  await expect(card.locator('strong')).toHaveText(`${PROJECT.name} · ${UX_REVAMP_LISTS_WORKFLOW_ID}`)
  await expect(card).toContainText('The run list could not be read (revamp_test, HTTP 500)')
  // Only that list is missing: its runs are gone, the other lists of the project still show theirs.
  for (const runId of OWN) await expect(page.locator(`a[data-run-id="${runId}"]`)).toHaveCount(0)
  await expect(page.getByTestId('recent-runs').locator('a[data-run-id]').first()).toBeVisible()
  // The card's text reads on the background it is drawn on.
  const [cardBackground, cardColour] = await card.evaluate(element => {
    const view = element.ownerDocument.defaultView!
    return [view.getComputedStyle(element).backgroundColor, view.getComputedStyle(element).color]
  })
  expect(contrastRatio(cardColour, cardBackground)).toBeGreaterThanOrEqual(4.5)
  await expectNoExecutionControls(page)
})

/**
 * The other ways a run list fails to load: the request never gets an answer (network), or the server answers with a body that
 * is not JSON, an error page or a success. Each gives its own message in the same fail-toned Attention card.
 */
const LIST_FAILURES: { what: string; answer: (route: Route) => Promise<void>; message: string }[] = [
  { what: 'a network failure', answer: route => route.abort('connectionrefused'), message: 'The API could not be reached. Check that the server is running, then retry.' },
  { what: 'a non-JSON error page', answer: route => route.fulfill({ status: 502, contentType: 'text/html', body: '<html><body>Bad gateway</body></html>' }), message: 'The API responded with status 502. (HTTP 502)' },
  { what: 'a success whose body is not JSON', answer: route => route.fulfill({ status: 200, contentType: 'text/plain', body: 'not json' }), message: 'The API returned data that does not match the projects contract: the response body is not JSON.' },
]

for (const failure of LIST_FAILURES) {
  test(`Runs home with a run list that failed by ${failure.what}: the Attention card says so in words (${phase})`, async ({ page }) => {
    const failing = `/api/projects/${PROJECT.project_id}/workflows/${UX_REVAMP_LISTS_WORKFLOW_ID}/runs`
    // The answer is the failure itself in both phases: nothing of the original response is read.
    await page.route(url => url.pathname === failing, failure.answer)
    await page.clock.setFixedTime(REVAMP_NOW)
    await page.goto(projectsUrl)
    const attention = page.getByRole('alert', { name: /^Attention · \d+$/ })
    await expect(attention).toHaveAttribute('data-testid', 'lists-errors')
    const card = attention.locator('li', { hasText: `${PROJECT.name} · ${UX_REVAMP_LISTS_WORKFLOW_ID}` })
    await expect(card).toHaveCount(1)
    expect(await card.getAttribute('class')).toMatch(/\bui-card\b.*\btone-fail\b/)
    await expect(card.locator('span')).toHaveText(failure.message)
    for (const runId of OWN) await expect(page.locator(`a[data-run-id="${runId}"]`)).toHaveCount(0)
    await expect(page.getByTestId('recent-runs').locator('a[data-run-id]').first()).toBeVisible()
    await expectNoExecutionControls(page)
  })
}

/** A request for a web font: a font host, or a font file by its extension. */
const isFontRequest = (url: string) => /fonts\.googleapis\.com|fonts\.gstatic\.com|\.woff2?(\?|#|$)/i.test(url)

test(`No web font: the Projects pages request no font and declare no @font-face (${phase})`, async ({ page }) => {
  test.setTimeout(90_000)
  const fonts: string[] = []
  page.on('request', request => { if (isFontRequest(request.url()) || request.resourceType() === 'font') fonts.push(request.url()) })
  await page.clock.setFixedTime(REVAMP_NOW)
  const shell = page.getByTestId('projects-workspace')
  /** What the document declares: every @font-face rule in a readable sheet, every FontFace in document.fonts, every font link. */
  // Evaluated as a string: the spec compiles without the DOM library, as the other specs' page code reads the DOM untyped.
  const declared = () => page.evaluate(`(async () => {
    await document.fonts.ready
    const faces = []
    const walk = rules => {
      for (const rule of [...rules]) {
        if (rule instanceof CSSFontFaceRule) faces.push(rule.cssText)
        else if (rule.cssRules) walk(rule.cssRules)
      }
    }
    for (const sheet of [...document.styleSheets]) {
      try { walk(sheet.cssRules) } catch { faces.push('unreadable sheet ' + sheet.href) }
    }
    const links = [...document.querySelectorAll('link[href]')].map(link => link.getAttribute('href') ?? '').filter(href => /font/i.test(href))
    return { faces, fontSet: [...document.fonts].map(face => face.family + ' ' + face.status), links }
  })()`) as Promise<{ faces: string[]; fontSet: string[]; links: string[] }>

  for (const url of [projectsUrl, projectUrl(PROJECT.project_id), workflowUrl(PROJECT.project_id, UX_REVAMP_LISTS_WORKFLOW_ID)]) {
    await page.goto(url)
    await expect(shell).toBeVisible()
    await expect(page.locator('.ui-section-header h2').first()).toBeVisible()
    expect(await declared(), url).toEqual({ faces: [], fontSet: [], links: [] })
  }
  expect(fonts).toEqual([])
})

/** What the feature page's run-history chip says for each own run: its status label and glyph. */
const HISTORY: Record<string, [label: string, glyph: string, tone: string]> = Object.fromEntries([
  ...[RUN_DESK_PANE, RUN_DESK_LIVE, RUN_DESK_LIVE_QUIET].map(runId => [runId, ['Running', '●', 'run']]),
  ...[RUN_DESK_INTERRUPTED, RUN_DESK_PAUSED, RUN_DESK_HELD].map(runId => [runId, ['Paused', '‖', 'pause']]),
  ...REVAMP_SUCCEEDED_RUNS.map(runId => [runId, ['Succeeded', '✓', 'ok']]),
  ...REVAMP_FAILED_RUNS.map(runId => [runId, ['Failed', '✗', 'fail']]),
])

test(`Project and feature pages (PRD_VIEWER_REVAMP 5.2): feature cards with the last run, the run-history strip and lane chips, the definition open only without runs, readable in both themes (${phase})`, async ({ page }) => {
  test.setTimeout(90_000)
  await page.clock.setFixedTime(REVAMP_NOW)

  // The project page: a feature card toned by its last run, which it names with a status chip beside the colour.
  await page.goto(projectUrl(PROJECT.project_id))
  const group = page.getByTestId('workflows-list').locator(`[data-workflow-id="${UX_REVAMP_LISTS_WORKFLOW_ID}"]`)
  const head = group.locator('a.lists-group-head')
  await expect(head.locator('.projects-card-title')).toHaveText(REVAMP_TITLE)
  await expect(head).toContainText(`${UX_REVAMP_LISTS_WORKFLOW_ID} · ${REVAMP_OWN_RUNS.length} runs`)
  // The last run is the one updated last (desk-live-1, running), not the oldest (a failed run) nor any other.
  const [latestLabel, , latestTone] = HISTORY[REVAMP_LATEST_RUN.runId]
  await expect(head.locator('.lists-group-last')).toContainText(new RegExp(`^last run ${latestLabel} · last activity `))
  await expect(head.locator('.lists-group-last .status-badge')).toHaveAttribute('data-status', REVAMP_LATEST_RUN.status)
  expect(await head.getAttribute('class')).toMatch(new RegExp(`\\bui-card\\b.*\\btone-${latestTone}\\b`))
  // Neither page shows the rail or other registry-wide data; the breadcrumb is their navigation.
  await expect(page.getByTestId('projects-rail')).toHaveCount(0)

  // The feature page: the lanes from the definition, then one history chip per listed run (glyph, title and a name that
  // says the status in words), then the rows; the definition is folded away while there are runs.
  await head.click()
  await expect(page).toHaveURL(new RegExp(`${workflowUrl(PROJECT.project_id, UX_REVAMP_LISTS_WORKFLOW_ID)}$`))
  await expect(page.locator('.feature-lanes .lane-chip')).toHaveText([...REVAMP_LANES])
  await expect(page.locator('.feature-lanes')).toContainText('Lanes')
  // The review steps the definition declares, beside the lanes (the reviewer ids are in each run's review result).
  await expect(page.locator('.feature-reviews')).toContainText('Review')
  await expect(page.locator('.feature-reviews .review-step-chip')).toHaveText(['Independent review'])
  const history = page.getByRole('list', { name: 'Run history, newest first' })
  const runList = page.getByTestId('run-list')
  await expect(runList.locator('li')).toHaveCount(REVAMP_OWN_RUNS.length)
  await expect(history.getByRole('link')).toHaveCount(REVAMP_OWN_RUNS.length)
  for (const runId of REVAMP_OWN_RUNS) {
    const [label, glyph, tone] = HISTORY[runId]
    const chip = history.getByRole('link', { name: `Run ${runId}, ${label}`, exact: true })
    await expect(chip, runId).toHaveText(glyph)
    await expect(chip, runId).toHaveAttribute('title', `${runId} · ${label}`)
    expect(await chip.getAttribute('class'), runId).toMatch(new RegExp(`\\bui-chip\\b.*\\btone-${tone}\\b`))
  }
  // The strip and the rows list the same runs in the same order.
  const historyOrder = await history.getByRole('link').evaluateAll(links => links.map(link => (link.getAttribute('aria-label') ?? '').replace(/^Run (\S+), .*$/, '$1')))
  expect(historyOrder).toEqual(await runList.locator('a[data-run-id]').evaluateAll(links => links.map(link => link.getAttribute('data-run-id'))))
  await expect(page.getByTestId('current-definition')).toHaveJSProperty('open', false)
  await expect(page.getByTestId('projects-rail')).toHaveCount(0)

  // A row waiting on the operator keeps its waiting-since time in view when its outcome is cut short at a desktop width:
  // the outcome ellipsises with its full text in its title, the since time sits outside it and is never the part cut off.
  // The fixture's outcome fits a desktop row, so the list is narrowed (desktop layout kept) until it no longer fits.
  const narrowList = await page.addStyleTag({ content: '[data-testid="run-list"] { width: 340px; }' })
  const waiting = row(runList, RUN_DESK_PANE)
  await expect(waiting).toHaveAttribute('data-attention', 'pane')
  await expect(waiting.locator('.run-row-since')).toHaveText(' · since 17:10')
  const cut = await waiting.evaluate(link => {
    const detail = link.querySelector('.run-row-detail')!.getBoundingClientRect()
    const summary = link.querySelector('.run-row-summary')!
    const since = link.querySelector('.run-row-since')!.getBoundingClientRect()
    return { truncated: summary.scrollWidth > summary.clientWidth, sinceRight: since.right, sinceWidth: since.width, detailRight: detail.right, title: summary.getAttribute('title') }
  })
  expect(cut.truncated, 'the outcome is long enough to be cut at this width').toBe(true)
  expect(cut.sinceWidth).toBeGreaterThan(0)
  expect(cut.sinceRight, 'the since time is not clipped').toBeLessThanOrEqual(cut.detailRight + 0.5)
  expect(cut.title).toMatch(/needs attention in its pane/)
  await narrowList.evaluate(style => style.remove())

  // Every chip of the feature page (history glyphs, lane chips, status pills) reads at 4.5:1 in both themes.
  const shell = page.getByTestId('projects-workspace')
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    const where = colorScheme
    const chips = await renderedChips(shell)
    for (const kind of ['run-history-chip', 'lane-chip', 'review-step-chip', 'status-badge']) expect(chips.some(chip => chip.className.includes(kind)), `${where}: ${kind} rendered`).toBe(true)
    for (const chip of chips) {
      expect(chip.text.length, `${where}: ${chip.className} keeps its text`).toBeGreaterThan(0)
      expect(contrastRatio(chip.color, chip.background), `${where}: "${chip.text}" (${chip.className}) ${chip.color} on ${chip.background}`).toBeGreaterThanOrEqual(4.5)
    }
  }
  await expectNoExecutionControls(page)

  // A feature that never ran: no history strip, and the definition is open with its graph.
  await page.goto(workflowUrl(PROJECT.project_id, EMPTY_WORKFLOW_ID))
  await expect(page.getByTestId('empty-runs')).toBeVisible()
  await expect(page.getByRole('list', { name: 'Run history, newest first' })).toHaveCount(0)
  await expect(page.getByTestId('current-definition')).toHaveJSProperty('open', true)
  await expect(page.getByTestId('current-definition')).toContainText('3 nodes')
})
