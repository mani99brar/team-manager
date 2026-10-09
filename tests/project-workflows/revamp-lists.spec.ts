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
import { validateReviewResult, type ReviewResult, type RunSummary } from '../../contracts/projects/v1.ts'
import { EMPTY_WORKFLOW_ID, PROJECT } from './fixtures.ts'
import {
  PANE_MESSAGE, REVAMP_FAILED_RUNS, REVAMP_FINISHED_RUNS, REVAMP_LANES, REVAMP_LATEST_RUN, REVAMP_NOW, REVAMP_OWN_RUNS, REVAMP_PREFIX, REVAMP_SUCCEEDED_RUNS,
  REVAMP_TITLE, RUN_DESK_HELD, RUN_DESK_INTERRUPTED, RUN_DESK_LIVE, RUN_DESK_LIVE_QUIET, RUN_DESK_PANE, RUN_DESK_PAUSED, RUN_DESK_STALE, UX_REVAMP_LISTS_WORKFLOW_ID,
} from './fixtures/ux-revamp-lists.ts'
import { mockResponse } from './mock.ts'
import { attach, expectNoExecutionControls, installHooks, phase, projectsUrl, projectUrl, runUrl, workflowUrl } from './support.ts'

installHooks()

const OWN = [RUN_DESK_PANE, RUN_DESK_LIVE, RUN_DESK_LIVE_QUIET, RUN_DESK_INTERRUPTED, RUN_DESK_PAUSED, RUN_DESK_STALE, RUN_DESK_HELD, ...REVAMP_FINISHED_RUNS]
/** The paused runs of this module, oldest-stopped first (desk-stale is three days old; the rest stopped on 2026-03-12). */
const PAUSED_OLDEST_FIRST = [RUN_DESK_STALE, RUN_DESK_HELD, RUN_DESK_INTERRUPTED, RUN_DESK_PAUSED]

/** The original answer of an overridden route: the mocks' in the worker phase, the real API's (`route.fetch()`) in the candidate phase. */
async function original(route: Route): Promise<unknown> {
  return phase === 'worker'
    ? JSON.parse(String(mockResponse(new URL(route.request().url())).body))
    : (await route.fetch()).json()
}
const isRunList = (url: URL) => /^\/api\/projects\/[^/]+\/workflows\/[^/]+\/runs$/.test(url.pathname)

const row = (scope: Locator, runId: string) => scope.locator(`a[data-run-id="${runId}"]`)
/** The run ids a section lists, in order, limited to this module's runs. */
const ownIds = (scope: Locator) => scope.locator('a[data-run-id]').evaluateAll(
  (links, own) => links.map(link => link.getAttribute('data-run-id')).filter((id): id is string => id !== null && own.includes(id)), OWN)
const showOlder = (recent: Locator) => recent.getByRole('button', { name: /^Show older/ })
async function showAll(recent: Locator) {
  if (await showOlder(recent).count()) await showOlder(recent).click()
  await expect(showOlder(recent)).toHaveCount(0)
}

/** No control in the Projects header acts on a run: the header is read-only, like the workspace (P2). */
async function expectNoHeaderExecutionControls(page: Page) {
  // The header was actually inspected (its Refresh button is present), so the no-execution count is not vacuous.
  await expect(page.locator('.app-header-projects .button')).toHaveCount(1)
  const controls = page.locator('.app-header-projects').locator('button, input, select, textarea, [role="menuitem"]')
  await expect(controls.filter({ hasText: /approve|retry|launch|start|resume|delete|cancel|integrate|edit|save/i })).toHaveCount(0)
}

/** The feature's latest finished run (desk-ok-1); its review result names these reviewers, not the definition's review step. */
const DESK_OK_LATEST = REVAMP_FINISHED_RUNS[0]
const REVIEWERS = ['general', 'coverage'] as const
const reviewerEntry = (reviewerId: string, nth: number) => ({
  reviewer_id: reviewerId, transport: 'native' as const, session_id: `0000000a-0000-4000-8000-00000000000${nth}`,
  verdict: 'approved' as const, findings: [], launched_at: '2026-03-12T15:35:00Z', accepted_at: '2026-03-12T15:38:00Z', status: 'accepted' as const,
})
const DESK_REVIEW: ReviewResult = validateReviewResult({
  contract_version: '1.4.0', run_id: DESK_OK_LATEST, node_id: 'review', attempt: 1,
  reviewer: { session_id: REVIEWERS.join(', '), transport: 'native', independent: true },
  bundle_sha256: 'a'.repeat(64), candidate_commit: 'b'.repeat(40), verdict: 'approved',
  findings: [], reviewers: REVIEWERS.map((id, index) => reviewerEntry(id, index + 1)), reviewed_at: '2026-03-12T15:38:00Z', diff: null,
})

/**
 * Serves a review result for the feature's latest finished run, so the feature header can name real reviewers. The run
 * detail carries no reviewers (contracts/projects: runDetail has no `review` section), so this also points that run's review
 * node at the reviews route the header reads. Both phases: the worker phase builds on the mocks' detail, the candidate phase
 * on the real API's (`original`).
 */
async function serveDeskReviewers(page: Page) {
  const detailPath = `/api/projects/${PROJECT.project_id}/workflows/${UX_REVAMP_LISTS_WORKFLOW_ID}/runs/${DESK_OK_LATEST}`
  const reviewsPath = `${detailPath}/reviews/1`
  await page.route(url => url.pathname === detailPath, async route => {
    const body = await original(route) as { snapshot: { nodes: { node_id: string; result_uri: string | null }[] } }
    const review = body.snapshot.nodes.find(node => node.node_id === 'review')
    if (review) review.result_uri = reviewsPath
    await route.fulfill({ json: body })
  })
  await page.route(url => url.pathname === reviewsPath, route => route.fulfill({ json: DESK_REVIEW }))
}

const RUNS_LIST_PATH = /^\/api\/projects\/[^/]+\/workflows\/[^/]+\/runs$/

test(`[scenario:home-sections] Runs home ranked by need at 1440: Needs you cards, Running and Paused as compact rows with step sub-headers, Recent with filtered-set counts, and the feature header's real reviewers (${phase})`, async ({ page }, testInfo) => {
  test.setTimeout(90_000)
  await serveDeskReviewers(page)
  await page.clock.setFixedTime(REVAMP_NOW)
  // The Runs home data path is read against the mock: record one run-list fetch (P2: no browser test of it before).
  const recorded = page.waitForRequest(request => request.method() === 'GET' && RUNS_LIST_PATH.test(new URL(request.url()).pathname))
  await page.goto(projectsUrl)
  await testInfo.attach('runs-home-fetch', { body: new URL((await recorded).url()).pathname, contentType: 'text/plain' })

  // Needs you: a warn card with the cause and the next-step label; the section names its own count.
  const needs = page.getByTestId('needs-you')
  await expect(needs.locator('.ui-section-header h2')).toHaveText(/^Needs you · \d+$/)
  const pane = row(needs, RUN_DESK_PANE)
  await expect(pane).toHaveAttribute('data-attention', 'pane')
  await expect(pane.getByTestId('next-step')).toHaveText('Next: attend the pane')
  await expect(pane.getByTestId('run-cause')).toContainText(PANE_MESSAGE.slice(0, 30))

  // The section jumps name every section with its count and lead to it.
  const jumps = page.getByTestId('home-jumps')
  await expect(jumps.getByRole('link')).toHaveText([/^Needs you\d+$/, /^Today\d+$/, /^Running\d+$/, /^Paused\d+$/, /^Recent\d+$/])

  // Today: every run that moved today and waits on nobody, the running ones first, then the ones paused or finished today,
  // latest activity first. A running row is a compact row (a run-row, not a six-line card) with its lane chips; a sub-header
  // counts the step each row sits at, derived from the rows, never a literal total.
  const today = page.getByTestId('today-runs')
  await expect(today.locator('.ui-section-header h2')).toHaveText(/^Today · \d+$/)
  for (const runId of [RUN_DESK_LIVE, RUN_DESK_LIVE_QUIET]) {
    const liveRow = row(today, runId)
    await expect(liveRow).toHaveAttribute('data-status', 'running')
    expect(await liveRow.evaluate(link => link.parentElement?.className ?? '')).toMatch(/\brun-row-item\b/)
    await expect(liveRow.locator('[data-lane]')).toHaveText([...REVAMP_LANES])
  }
  expect((await ownIds(today)).slice(0, 2).sort()).toEqual([RUN_DESK_LIVE, RUN_DESK_LIVE_QUIET].sort())
  for (const runId of PAUSED_OLDEST_FIRST.filter(id => id !== RUN_DESK_STALE)) await expect(row(today, runId)).toHaveAttribute('data-status', 'paused')
  await expect(today.locator('.ui-section-header .ui-sub')).toHaveText(/\d+ at \S/)

  // Running: the runs still running since an earlier day; none in this fixture, so no row and the sub-header says so.
  const running = page.getByTestId('running-runs')
  await expect(running.locator('.ui-section-header h2')).toHaveText(/^Running · \d+$/)
  for (const runId of [RUN_DESK_LIVE, RUN_DESK_LIVE_QUIET, ...PAUSED_OLDEST_FIRST, ...REVAMP_FAILED_RUNS]) await expect(row(running, runId)).toHaveCount(0)

  // Paused: the runs paused since an earlier day, longest stopped first, each with "since <n> days" in the paused tone and
  // its own step sub-header. desk-stale stopped three days before the clock, so it is the one here and says "since 3 days".
  const paused = page.getByTestId('paused-runs')
  await expect(paused.locator('.ui-section-header h2')).toHaveText(/^Paused · \d+$/)
  await expect(paused.locator('.ui-section-header .ui-sub')).not.toHaveText('nothing is paused')
  expect(await ownIds(paused)).toEqual([RUN_DESK_STALE])
  await expect(row(paused, RUN_DESK_STALE)).toHaveAttribute('data-status', 'paused')
  await expect(row(paused, RUN_DESK_STALE).locator('.run-row-paused-since.tone-pause-text')).toHaveText(/ · since 3 days$/)

  // Recent: the Failed and Succeeded filter counts equal the rows that filter keeps over the searched set (P2 1).
  const recent = page.getByTestId('recent-runs')
  const search = page.getByLabel('Search runs')
  await search.fill(REVAMP_PREFIX)
  await showAll(recent)
  for (const [status, label] of [['failed', 'Failed'], ['succeeded', 'Succeeded']] as const) {
    const button = recent.getByRole('button', { name: new RegExp(`^${label} \\d+$`) })
    const count = Number((await button.textContent())!.replace(/\D/g, ''))
    await button.click()
    await showAll(recent)
    const shown = await recent.locator('a[data-run-id]').count()
    expect(shown, `${label} count equals the rows it keeps`).toBe(count)
    for (const dataStatus of await recent.locator('a[data-run-id]').evaluateAll(links => links.map(link => link.getAttribute('data-status')))) expect(dataStatus).toBe(status)
    await recent.getByRole('button', { name: 'All', exact: true }).click()
  }

  // The project rail keeps its state dots; the header and the workspace act on no run.
  await expect(page.getByTestId('projects-list').locator('.rail-dot').first()).toHaveAttribute('data-tone', /.+/)
  await expectNoHeaderExecutionControls(page)
  await expectNoExecutionControls(page)
  await attach(page, testInfo, 'home-sections')

  // The feature header lists the latest finished run's actual reviewers, labelled "Reviewers", never the definition's steps.
  await page.goto(workflowUrl(PROJECT.project_id, UX_REVAMP_LISTS_WORKFLOW_ID))
  const reviewers = page.locator('.feature-reviewers')
  await expect(reviewers).toContainText('Reviewers')
  await expect(reviewers.locator('.reviewer-chip')).toHaveText([...REVIEWERS])
  await expect(page.locator('.feature-reviews .review-step-chip')).toHaveCount(0)
})

test(`[scenario:home-phone] Runs home and the Projects header at 390 px: one column, 16 px gutters, 44 px header and row controls, the rail collapsed, and dark without a horizontal overflow (${phase})`, async ({ page }, testInfo) => {
  test.setTimeout(90_000)
  await page.clock.setFixedTime(REVAMP_NOW)
  await page.goto(projectsUrl)
  await page.setViewportSize({ width: 390, height: 844 })
  const overflow = () => page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') as Promise<number>

  // One column, 16 px gutters, no sideways scroll.
  await expect(page.getByTestId('running-runs')).toBeVisible()
  expect(await page.evaluate("getComputedStyle(document.querySelector('.workspace-projects')).paddingLeft")).toBe('16px')
  expect(await overflow()).toBeLessThanOrEqual(0)

  // Every Projects header control is at least 44 px tall: the three roots links and the Refresh button.
  const headerControls = page.locator('.app-header-projects a, .app-header-projects button')
  const headerCount = await headerControls.count()
  expect(headerCount, 'the header has its roots links and Refresh').toBeGreaterThanOrEqual(4)
  for (let index = 0; index < headerCount; index += 1) {
    expect((await headerControls.nth(index).boundingBox())!.height, `header control ${index}`).toBeGreaterThanOrEqual(44)
  }

  // Every row control is at least 44 px tall (the whole row is the link).
  const rowControls = page.locator('.runs-home a.run-row, .runs-home a.home-card-link')
  const rowCount = await rowControls.count()
  expect(rowCount, 'Runs home has rows').toBeGreaterThan(0)
  for (let index = 0; index < rowCount; index += 1) {
    expect((await rowControls.nth(index).boundingBox())!.height, `row control ${index}`).toBeGreaterThanOrEqual(44)
  }

  // The rail collapses above the sections as the revamp specified: it sits above Needs you and scrolls as a row within itself.
  const rail = page.getByTestId('projects-rail')
  const railBox = await rail.boundingBox()
  const needsBox = await page.getByTestId('needs-you').boundingBox()
  expect(railBox!.y + railBox!.height).toBeLessThanOrEqual(needsBox!.y + 1)
  expect(await rail.locator('.rail-list').first().evaluate(element => element.ownerDocument.defaultView!.getComputedStyle(element).overflowX)).toBe('auto')
  await attach(page, testInfo, 'home-phone')

  // Dark theme: still a single column with no horizontal overflow.
  await page.emulateMedia({ colorScheme: 'dark' })
  expect(await page.evaluate("matchMedia('(prefers-color-scheme: dark)').matches")).toBe(true)
  await expect(page.getByTestId('running-runs')).toBeVisible()
  expect(await overflow()).toBeLessThanOrEqual(0)
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
  await expect(row(page.getByTestId('today-runs'), RUN_DESK_LIVE)).toHaveCount(1)
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

/** A request for a font: a font host (Google Fonts' CSS or files), or a font file by its extension. */
const isFontRequest = (url: string) => /fonts\.googleapis\.com|fonts\.gstatic\.com|\.(woff2?|ttf|otf|eot)(\?|#|$)/i.test(url)
/** The two faces the Projects shell self-hosts from /fonts (src/projects/theme.css), and nothing else. */
const SELF_HOSTED_FAMILIES = ['Atkinson Hyperlegible Mono', 'Atkinson Hyperlegible Next']

test(`Self-hosted fonts: the Projects pages request fonts only from their own origin and declare exactly the two Atkinson Hyperlegible faces (${phase})`, async ({ page }) => {
  test.setTimeout(90_000)
  const fonts: { url: string; status: number }[] = []
  page.on('response', response => {
    if (isFontRequest(response.url()) || response.request().resourceType() === 'font') fonts.push({ url: response.url(), status: response.status() })
  })
  const failed: string[] = []
  page.on('requestfailed', request => { if (isFontRequest(request.url()) || request.resourceType() === 'font') failed.push(request.url()) })
  await page.clock.setFixedTime(REVAMP_NOW)
  const shell = page.getByTestId('projects-workspace')
  /**
   * What the document declares: every @font-face rule in a readable sheet (its family and each src URL, resolved against the
   * sheet's own URL, or the document's for an inline style), every FontFace in document.fonts, every font link.
   */
  // Evaluated as a string: the spec compiles without the DOM library, as the other specs' page code reads the DOM untyped.
  const declared = () => page.evaluate(`(async () => {
    await document.fonts.ready
    const unquote = value => value.trim().replace(/^["']|["']$/g, '')
    const faces = []
    const unreadable = []
    const walk = (rules, base) => {
      for (const rule of [...rules]) {
        if (rule instanceof CSSFontFaceRule) {
          const src = rule.style.getPropertyValue('src')
          const urls = [...src.matchAll(/url\\(\\s*(["']?)([^"')]+)\\1\\s*\\)/g)].map(match => new URL(match[2], base).href)
          faces.push({ family: unquote(rule.style.getPropertyValue('font-family')), urls, src })
        } else if (rule.cssRules) walk(rule.cssRules, base)
      }
    }
    for (const sheet of [...document.styleSheets]) {
      try { walk(sheet.cssRules, sheet.href ?? document.baseURI) } catch { unreadable.push(String(sheet.href)) }
    }
    const links = [...document.querySelectorAll('link[href]')].filter(link => /font/i.test(link.getAttribute('href') ?? '')).map(link => link.href)
    return { origin: location.origin, faces, unreadable, fontSet: [...new Set([...document.fonts].map(face => unquote(face.family)))].sort(), links }
  })()`) as Promise<{ origin: string; faces: { family: string; urls: string[]; src: string }[]; unreadable: string[]; fontSet: string[]; links: string[] }>

  const pages = [
    { url: projectsUrl, ready: page.locator('.ui-section-header h2').first() },
    { url: projectUrl(PROJECT.project_id), ready: page.locator('.ui-section-header h2').first() },
    { url: workflowUrl(PROJECT.project_id, UX_REVAMP_LISTS_WORKFLOW_ID), ready: page.locator('.ui-section-header h2').first() },
    // The run page (the Signal Box stage) uses the same two faces.
    { url: runUrl(RUN_DESK_LIVE, undefined, UX_REVAMP_LISTS_WORKFLOW_ID), ready: page.getByTestId('run-stage') },
  ]
  let origin = ''
  for (const { url, ready } of pages) {
    await page.goto(url)
    await expect(shell).toBeVisible()
    await expect(ready).toBeVisible()
    const found = await declared()
    origin = found.origin
    // Every sheet is readable (a cross-origin sheet, such as Google Fonts' CSS, is not), and no link names a font host.
    expect(found.unreadable, url).toEqual([])
    for (const link of found.links) expect(new URL(link).origin, `${url}: font link ${link}`).toBe(origin)
    // The declared families are exactly the two self-hosted faces, each declared once, each source a file on this origin.
    expect(found.faces.map(face => face.family).sort(), url).toEqual(SELF_HOSTED_FAMILIES)
    for (const face of found.faces) {
      expect(face.urls.length, `${url}: ${face.family} declares a url() source (${face.src})`).toBeGreaterThan(0)
      for (const source of face.urls) {
        expect(new URL(source).origin, `${url}: ${face.family} source ${source}`).toBe(origin)
        expect(new URL(source).pathname, `${url}: ${face.family} source ${source}`).toMatch(/^\/fonts\/[^/]+\.woff2$/)
      }
    }
    expect(found.fontSet, url).toEqual(SELF_HOSTED_FAMILIES)
  }
  // Every font the pages fetched came from this origin's /fonts and was served; none went to another host.
  expect(fonts.length, 'the pages load their self-hosted faces').toBeGreaterThan(0)
  for (const font of fonts) {
    expect(new URL(font.url).origin, font.url).toBe(origin)
    expect(new URL(font.url).pathname, font.url).toMatch(/^\/fonts\/[^/]+\.woff2$/)
    expect(font.status, font.url).toBe(200)
  }
  expect(failed).toEqual([])
})

/** What the feature page's run-history chip says for each own run: its status label and glyph. */
const HISTORY: Record<string, [label: string, glyph: string, tone: string]> = Object.fromEntries([
  ...[RUN_DESK_PANE, RUN_DESK_LIVE, RUN_DESK_LIVE_QUIET].map(runId => [runId, ['Running', '●', 'run']]),
  ...[RUN_DESK_INTERRUPTED, RUN_DESK_PAUSED, RUN_DESK_HELD, RUN_DESK_STALE].map(runId => [runId, ['Paused', '‖', 'pause']]),
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
