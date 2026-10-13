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
import { classifyRuns, classOf, dayKey, movedAt, endedAt, isFinished } from '../../src/projects/lists.ts'
import { validateReviewResult, type ReviewResult, type RunSummary } from '../../contracts/projects/v1.ts'
import { EMPTY_WORKFLOW_ID, PROJECT } from './fixtures.ts'
import {
  PANE_MESSAGE, REVAMP_FAILED_RUNS, REVAMP_FINISHED_RUNS, REVAMP_LANES, REVAMP_LATEST_RUN, REVAMP_NOW, REVAMP_OWN_RUNS, REVAMP_PREFIX, REVAMP_SUCCEEDED_RUNS,
  RUN_DESK_HELD, RUN_DESK_INTERRUPTED, RUN_DESK_LIVE, RUN_DESK_LIVE_QUIET, RUN_DESK_PANE, RUN_DESK_PAUSED, RUN_DESK_STALE, UX_REVAMP_LISTS_WORKFLOW_ID,
} from './fixtures/ux-revamp-lists.ts'
import { mockResponse } from './mock.ts'
import {
  DISPATCH_BUSY, DISPATCH_NOORIGIN, DISPATCH_UNREADABLE, DISPATCH_WIDGETS, DISPATCH_WIDGETS_WT, NOORIGIN_NEEDS, PARKED_SINCE, RUN_DECIDE, RUN_HALT,
  RUN_HALT_LIVE, RUN_PARKED, RUN_REDO_NEW, RUN_REDO_OLD, RUN_RERUN_OLD, RUN_WT_DROPPED, RUN_WT_PARKED,
} from './fixtures/dispatch.ts'
import { attach, expectNoExecutionControls, installHooks, phase, projectsUrl, projectUrl, runUrl, triageUrl, workflowUrl } from './support.ts'

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
  await page.goto(triageUrl)
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
  // The paused runs of this feature that moved today are superseded by desk-live-1, a later run of their own workflow: they
  // are no longer Today rows but sit, paused, in the Paused section's closed fold (asserted below).
  for (const runId of PAUSED_OLDEST_FIRST) await expect(row(today, runId)).toHaveCount(0)
  await expect(today.locator('.ui-section-header .ui-sub')).toHaveText(/\d+ at \S/)

  // Running: the runs still running since an earlier day; none in this fixture, so no row and the sub-header says so.
  const running = page.getByTestId('running-runs')
  await expect(running.locator('.ui-section-header h2')).toHaveText(/^Running · \d+$/)
  for (const runId of [RUN_DESK_LIVE, RUN_DESK_LIVE_QUIET, ...PAUSED_OLDEST_FIRST, ...REVAMP_FAILED_RUNS]) await expect(row(running, runId)).toHaveCount(0)

  // Paused: the runs paused since an earlier day that no later run superseded, longest stopped first, with their step
  // sub-header; this feature's four paused runs all have a later run (desk-live-1) in their workflow, so none is a Paused row:
  // they sit in the closed "N superseded" fold, longest stopped first, each paused, "superseded by desk-live-1", never warn.
  // desk-stale stopped three days before the clock, so it says "paused 3 d (since Mar 9)" in the paused tone.
  const paused = page.getByTestId('paused-runs')
  await expect(paused.locator('.ui-section-header h2')).toHaveText(/^Paused · \d+$/)
  await expect(paused.locator('.ui-section-header .ui-sub')).not.toHaveText('nothing is paused')
  expect(await ownIds(paused.locator(':scope > .run-rows'))).toEqual([])
  const fold = paused.getByTestId('superseded-runs')
  await expect(fold).not.toHaveAttribute('open', '')
  await expect(fold.locator('summary')).toHaveText(/^\d+ superseded$/)
  await fold.locator('summary').click()
  await expect(fold).toHaveAttribute('open', '')
  expect(await ownIds(fold)).toEqual(PAUSED_OLDEST_FIRST)
  for (const runId of PAUSED_OLDEST_FIRST) {
    await expect(row(fold, runId)).toHaveAttribute('data-status', 'paused')
    await expect(row(fold, runId)).toHaveAttribute('data-superseded-by', RUN_DESK_LIVE)
    await expect(row(fold, runId)).not.toHaveAttribute('data-attention', /.+/)
    await expect(row(fold, runId)).toContainText(`superseded by ${RUN_DESK_LIVE}`)
    expect(await row(fold, runId).evaluate(rowTone)).toBe('pause')
  }
  await expect(row(fold, RUN_DESK_STALE).locator('.run-row-stopped.tone-pause-text')).toHaveText('paused 3 d (since Mar 9)')
  await expect(row(fold, RUN_DESK_STALE).locator('.run-row-span')).toHaveCount(0)

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
  await expect(page.getByTestId('dispatch-rail-list').locator('.dispatch-rail-row').first()).toHaveClass(/tone-/)
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
  await page.goto(triageUrl)
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

  // The rail collapses into a chip row above the sections: it sits above Needs you and scrolls as a row within itself ([D1]).
  const chips = page.getByTestId('dispatch-chips')
  const railBox = await chips.boundingBox()
  const needsBox = await page.getByTestId('needs-you').boundingBox()
  expect(railBox!.y + railBox!.height).toBeLessThanOrEqual(needsBox!.y + 1)
  expect(await chips.evaluate(element => element.ownerDocument.defaultView!.getComputedStyle(element).overflowX)).toBe('auto')
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
  await page.goto(triageUrl)
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
  // Triage reads every project's run lists on a cold load (the dispatch seeds add eight lists), so it gets the slow budget.
  test.slow()
  // Every run list that answered drops the runs that need the operator (the same classification Triage uses, classifyRuns).
  // A list that could not be read carries no runs (the combined candidate seeds a `broken` workflow whose runs error): pass
  // its response through untouched, so Runs home shows it under Attention exactly as it would without this override.
  // Dropping a run that needs the operator can make an older run of its workflow the latest one, which may need the
  // operator in turn (paused at the challenge, or interrupted): drop until no run of the list needs the operator.
  const filterWaiting = (body: { runs: RunSummary[]; next_cursor: string | null }) => {
    let runs = body.runs
    for (;;) {
      const classes = classifyRuns(runs)
      const kept = runs.filter(run => classOf(classes, run).needs === null)
      if (kept.length === runs.length) return { ...body, runs: kept }
      runs = kept
    }
  }
  await page.route(isRunList, async route => {
    if (phase === 'candidate') {
      const response = await route.fetch()
      const body = await response.json() as { runs?: RunSummary[]; next_cursor: string | null }
      await (Array.isArray(body.runs) ? route.fulfill({ json: filterWaiting(body as { runs: RunSummary[]; next_cursor: string | null }) }) : route.fulfill({ response }))
      return
    }
    // A run list that could not be read carries no `runs` array (an unlistable workflow answers with an error): pass its
    // response through untouched, status and all, so Runs home reads it under Attention exactly as it would without this override.
    const resp = mockResponse(new URL(route.request().url()))
    const body = JSON.parse(String(resp.body)) as { runs?: RunSummary[]; next_cursor: string | null }
    if (!Array.isArray(body.runs)) { await route.fulfill({ status: resp.status, contentType: resp.contentType, body: resp.body }); return }
    await route.fulfill({ json: filterWaiting(body as { runs: RunSummary[]; next_cursor: string | null }) })
  })
  await page.clock.setFixedTime(REVAMP_NOW)
  await page.goto(triageUrl)
  const needs = page.getByTestId('needs-you')
  // The rest of Runs home still reads its runs, so the empty state is not a page that failed to load.
  await expect(row(page.getByTestId('today-runs'), RUN_DESK_LIVE)).toHaveCount(1)
  await expect(needs.locator('.ui-section-header h2')).toHaveText('Needs you · 0')
  await expect(needs.locator('.ui-section-header .ui-sub')).toHaveText('nothing waits on you')
  await expect(needs.locator('li, a[data-run-id]')).toHaveCount(0)
  await expect(page.getByTestId('rail-triage')).not.toContainText('waits on you')
  await expect(page.locator(`a[data-run-id="${RUN_DESK_PANE}"]`)).toHaveCount(0)
  // The revamp runs loaded (the empty needs is not a page that failed): no Attention card names this feature.
  await expect(page.getByTestId('lists-errors').locator('li', { hasText: UX_REVAMP_LISTS_WORKFLOW_ID })).toHaveCount(0)
  await expect(page.getByTestId('recent-runs').locator('a[data-run-id]').first()).toBeVisible()
  expect(await page.title()).not.toMatch(/^\(\d+\)/)
  await expectNoExecutionControls(page)
})

test(`Runs home with a run list that failed to load: a fail-toned Attention card naming the list and the API error (${phase})`, async ({ page }) => {
  test.slow()
  const failing = `/api/projects/${PROJECT.project_id}/workflows/${UX_REVAMP_LISTS_WORKFLOW_ID}/runs`
  await page.route(url => url.pathname === failing, route => route.fulfill({ status: 500, json: { error: { code: 'revamp_test', message: 'The run list could not be read' } } }))
  await page.clock.setFixedTime(REVAMP_NOW)
  await page.goto(triageUrl)
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
    test.slow()
    const failing = `/api/projects/${PROJECT.project_id}/workflows/${UX_REVAMP_LISTS_WORKFLOW_ID}/runs`
    // The answer is the failure itself in both phases: nothing of the original response is read.
    await page.route(url => url.pathname === failing, failure.answer)
    await page.clock.setFixedTime(REVAMP_NOW)
    await page.goto(triageUrl)
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
    { url: triageUrl, ready: page.locator('.ui-section-header h2').first() },
    { url: projectsUrl, ready: page.getByTestId('dispatch-cards') },
    { url: projectUrl(PROJECT.project_id), ready: page.getByTestId('dispatch-project-header') },
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
    // 304: the browser revalidated a face it already holds from this origin (a later page of the walk), also served.
    expect([200, 304], font.url).toContain(font.status)
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

  // The project page: the step chart's feature group, an li[data-workflow-id] whose header is a tone-carrying a.lists-group-head
  // ([L1]); the tone is the latest registry run's (desk-live-1, running). The run rows live on the feature page below.
  await page.goto(projectUrl(PROJECT.project_id))
  const group = page.locator(`li[data-workflow-id="${UX_REVAMP_LISTS_WORKFLOW_ID}"]`)
  const head = group.locator('a.lists-group-head')
  await expect(head).toContainText(UX_REVAMP_LISTS_WORKFLOW_ID)
  const [, , latestTone] = HISTORY[REVAMP_LATEST_RUN.runId]
  await expect(head).toHaveClass(new RegExp(`\\bui-card\\b.*\\btone-${latestTone}\\b`))
  // The old prefix rail is gone; the projects-only rail replaces it.
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

// ---- ux-critique-fixes stage A, lane `lists` (features/ux-critique-fixes/prd.md 6) ------------------------------------------

const STATE_SECTIONS = ['needs-you', 'today-runs', 'running-runs', 'paused-runs', 'recent-runs'] as const
const NOORIGIN_RUN = (workflowId: string, runId: string) => `/projects/${DISPATCH_NOORIGIN}/workflows/${workflowId}/runs/${runId}`
const railRow = (page: Page, projectId: string) => page.locator(`.dispatch-rail-row[data-project-id="${projectId}"]`)
const dispatchCard = (page: Page, projectId: string) => page.locator(`.dispatch-card[data-project-id="${projectId}"]`)
/** A colour token resolved to the colour it paints, read inside the Projects shell. */
// The page code reads the DOM through untyped parameters: the spec compiles without the DOM library.
type Styled = { getComputedStyle: (element: unknown) => { color: string; lineHeight: string; fontSize: string } }
/** The tone its li carries, for a row link. */
const rowTone = (link: unknown) => (link as { parentElement: { getAttribute: (name: string) => string | null } | null }).parentElement?.getAttribute('data-tone')
const tokenColour = (page: Page, token: string) => page.evaluate(`(() => {
  const probe = document.createElement('span')
  probe.style.color = 'var(${token})'
  document.querySelector('.projects-shell').appendChild(probe)
  const colour = getComputedStyle(probe).color
  probe.remove()
  return colour
})()`) as Promise<string>
const colourOf = (locator: Locator) => locator.evaluate((element: unknown) => (globalThis as unknown as Styled).getComputedStyle(element).color)

/** Answers a run list with `edit` applied to its original runs (the mocks' in the worker phase, the server's in the candidate). */
async function editRunLists(page: Page, edit: (runs: RunSummary[], url: URL) => RunSummary[]) {
  await page.route(isRunList, async route => {
    const url = new URL(route.request().url())
    if (phase === 'candidate') {
      const response = await route.fetch()
      const body = await response.json() as { runs?: RunSummary[]; next_cursor: string | null }
      await (Array.isArray(body.runs) ? route.fulfill({ json: { ...body, runs: edit(body.runs, url) } }) : route.fulfill({ response }))
      return
    }
    const resp = mockResponse(url)
    const body = JSON.parse(String(resp.body)) as { runs?: RunSummary[]; next_cursor: string | null }
    if (!Array.isArray(body.runs)) { await route.fulfill({ status: resp.status, contentType: resp.contentType, body: resp.body }); return }
    await route.fulfill({ json: { ...body, runs: edit(body.runs, url) } })
  })
}

/** A synthetic paused run (paused at the review, so it needs nobody) in a workflow of its own id, dated in 2024. */
const parkedRun = (base: RunSummary, runId: string, workflowId: string, created: string): RunSummary => ({
  ...base, run_id: runId, workflow_id: workflowId, status: 'paused', created_at: created, updated_at: created, accepted: undefined,
  activity: { feature: 'Parked', last_activity_at: created, finished_at: null, focus: null, attention: { kind: 'paused', node_id: 'review', since: created }, waiting_questions: 0, headline: null, controller: null },
})

test(`[scenario:triage-attention] Needs you holds exactly the runs that wait on the operator: a decision at the challenge, an interrupted latest run whether paused or running, and never a superseded one (${phase})`, async ({ page }, testInfo) => {
  test.slow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.clock.setFixedTime(REVAMP_NOW)
  await page.goto(triageUrl)
  const needs = page.getByTestId('needs-you')
  const card = (runId: string) => needs.locator(`a[data-run-id="${runId}"]`)
  await expect(card(RUN_DECIDE)).toHaveCount(1, { timeout: 30_000 })

  // The served shape the rule reads ([L7]): the interrupted running run is served running with interrupted attention.
  const served = await page.evaluate(async url => (await fetch(url)).json(), `/api${NOORIGIN_RUN('halt-live', '').replace(/\/runs\/$/, '/runs')}`) as { runs: RunSummary[] }
  const halted = served.runs.find(item => item.run_id === RUN_HALT_LIVE)!
  expect([halted.status, halted.activity?.attention?.kind]).toEqual(['running', 'interrupted'])

  // A decision at the design challenge: the chip, data-attention, its since-time, and the next step naming the run page.
  await expect(card(RUN_DECIDE)).toHaveAttribute('data-attention', 'decision')
  await expect(card(RUN_DECIDE)).toContainText('decision waits')
  await expect(card(RUN_DECIDE).getByTestId('next-step')).toHaveText('Next: resume or accept the challenge on the run page')
  await expect(card(RUN_DECIDE).locator('.home-card-when time')).toHaveAttribute('datetime', '2024-12-01T08:04:00Z')
  await expect(card(RUN_DECIDE)).toHaveAttribute('href', NOORIGIN_RUN('decide', RUN_DECIDE))
  // An interrupted latest run, paused or running, is a Needs-you card; the running one is in no Running or Today row.
  for (const [runId, workflowId, status] of [[RUN_HALT, 'halt', 'paused'], [RUN_HALT_LIVE, 'halt-live', 'running']] as const) {
    await expect(card(runId)).toHaveAttribute('data-attention', 'interrupted')
    await expect(card(runId)).toHaveAttribute('data-status', status)
    await expect(card(runId).getByTestId('next-step')).toHaveText('Next: resume the run on the run page')
    await expect(card(runId)).toHaveAttribute('href', NOORIGIN_RUN(workflowId, runId))
  }
  for (const section of ['running-runs', 'today-runs']) await expect(row(page.getByTestId(section), RUN_HALT_LIVE)).toHaveCount(0)

  // Superseded: the challenge-paused redo-001 has a later run in its own workflow (whose feature text differs): not in Needs
  // you, in Paused's closed fold, "superseded by redo-002", never warn.
  await expect(card(RUN_REDO_OLD)).toHaveCount(0)
  const paused = page.getByTestId('paused-runs')
  const fold = paused.getByTestId('superseded-runs')
  await expect(fold).not.toHaveAttribute('open', '')
  await expect(fold.locator('summary')).toHaveText(/^\d+ superseded$/)
  await fold.locator('summary').click()
  await expect(row(fold, RUN_REDO_OLD)).toContainText(`superseded by ${RUN_REDO_NEW}`)
  expect(await row(fold, RUN_REDO_OLD).evaluate(rowTone)).not.toBe('warn')
  await expect(row(fold, RUN_REDO_OLD)).not.toHaveAttribute('data-attention', /.+/)
  // The decision run's only later run is in another workflow of the project: it stays in Needs you (asserted above).
  // A superseded interrupted running run keeps its Running (or Today) place; a run paused at another step stays in Paused.
  expect(await row(page.getByTestId('running-runs'), RUN_RERUN_OLD).count() + await row(page.getByTestId('today-runs'), RUN_RERUN_OLD).count()).toBe(1)
  await expect(card(RUN_RERUN_OLD)).toHaveCount(0)
  await expect(row(paused.locator(':scope > .run-rows'), RUN_PARKED)).toHaveCount(1)

  // "Needs you · n" and the tab title's "(n) " equal the number of Needs-you cards, by value; every needs-operator run is in
  // exactly one state section.
  const cards = await needs.locator(':scope > ul > li').count()
  expect(cards).toBeGreaterThanOrEqual(NOORIGIN_NEEDS.length)
  await expect(needs.locator('.ui-section-header h2')).toHaveText(`Needs you · ${cards}`)
  await expect(page).toHaveTitle(new RegExp(`^\\(${cards}\\) `))
  for (const runId of [...NOORIGIN_NEEDS, RUN_REDO_OLD, RUN_RERUN_OLD, RUN_PARKED]) {
    let listed = 0
    for (const section of STATE_SECTIONS) listed += await row(page.getByTestId(section), runId).count()
    expect(listed, runId).toBe(1)
  }
  await attach(page, testInfo, 'triage-attention')

  // The project page lists the waiting runs under "Needs you and running" once each, linking to their run pages; the
  // superseded running run is the one running.
  await page.goto(projectUrl(DISPATCH_NOORIGIN))
  const section = page.getByTestId('dispatch-needs')
  await expect(section.locator('li.tone-run')).toHaveCount(1, { timeout: 30_000 })
  for (const [runId, workflowId] of [[RUN_DECIDE, 'decide'], [RUN_HALT, 'halt'], [RUN_HALT_LIVE, 'halt-live'], [RUN_RERUN_OLD, 'rerun-live']] as const) {
    await expect(section.getByRole('link', { name: runId, exact: true })).toHaveCount(1)
    await expect(section.getByRole('link', { name: runId, exact: true })).toHaveAttribute('href', NOORIGIN_RUN(workflowId, runId))
  }
  await expect(section.locator('li.tone-warn')).toHaveCount(NOORIGIN_NEEDS.length)
  await expect(section.locator('li.tone-run')).toHaveCount(1)
  await expect(section.getByRole('link', { name: RUN_REDO_OLD })).toHaveCount(0)

  // The Projects card and the rail count them as waits, never as running, and the paused count is the non-superseded one.
  await page.goto(projectsUrl)
  await expect(railRow(page, DISPATCH_NOORIGIN).locator('.dispatch-rail-badge')).toHaveText(`${NOORIGIN_NEEDS.length} waits on you`, { timeout: 30_000 })
  await expect(dispatchCard(page, DISPATCH_NOORIGIN).locator('.dispatch-card-word')).toHaveText(`${NOORIGIN_NEEDS.length} waits on you`)
  await expect(dispatchCard(page, DISPATCH_NOORIGIN).getByTestId('dispatch-card-live')).toHaveText(`${NOORIGIN_NEEDS.length} waits on you · 1 running · 1 paused`)
})

test(`[scenario:triage-loading] While the runs, the overview and the steps load, nothing claims an empty, failed or all-clear state; a failed project list says the lists are incomplete (${phase})`, async ({ page }, testInfo) => {
  test.slow()
  await page.setViewportSize({ width: 1440, height: 900 })
  let releaseLists = () => {}
  const lists = new Promise<void>(resolve => { releaseLists = resolve })
  let releaseSteps = () => {}
  const stepsHeld = new Promise<void>(resolve => { releaseSteps = resolve })
  const isOverview = (url: URL) => url.pathname === '/api/dispatch/projects'
  const isSteps = (url: URL) => /^\/api\/dispatch\/projects\/[^/]+\/steps$/.test(url.pathname)
  await page.route(url => isRunList(url) || isOverview(url), async route => { await lists; await route.fallback().catch(() => undefined) })
  await page.route(isSteps, async route => { await stepsHeld; await route.fallback().catch(() => undefined) })

  const forbidden = ['cannot be read', 'nothing waits', 'Triage · 0', '0 runs']
  const expectNoClaims = async () => {
    for (const text of forbidden) await expect(page.getByText(text, { exact: false })).toHaveCount(0)
  }
  await page.goto(projectsUrl)
  await expect(page.getByTestId('dispatch-cards')).toBeVisible({ timeout: 30_000 })
  const rows = page.getByTestId('dispatch-rail-list').locator('.dispatch-rail-row')
  await expect(rows.first()).toBeVisible()
  for (const sub of await rows.locator('.dispatch-rail-sub').allInnerTexts()) expect(sub).toMatch(/reading…$/)
  await expect(rows.locator('.dispatch-rail-badge')).toHaveCount(0)
  await expect(page.getByTestId('rail-triage').locator('.dispatch-rail-home-n')).toHaveText('…')
  for (const line of await page.locator('.dispatch-card .dispatch-card-word').allInnerTexts()) expect(line).toBe('reading runs…')
  await expect(page.getByTestId('dispatch-projects-meta')).toContainText('repositories: reading…')
  await expectNoClaims()
  // The 390 px chip row's Triage chip says it is reading too.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByTestId('dispatch-chips').getByRole('link', { name: /^Triage/ })).toHaveText('Triage · …')
  await expectNoClaims()
  await page.setViewportSize({ width: 1440, height: 900 })
  await attach(page, testInfo, 'triage-loading')

  // Released, the rows and badges settle to the seeded values.
  releaseLists()
  await expect(railRow(page, DISPATCH_NOORIGIN).locator('.dispatch-rail-badge')).toHaveText(`${NOORIGIN_NEEDS.length} waits on you`, { timeout: 30_000 })
  await expect(railRow(page, DISPATCH_WIDGETS_WT).locator('.dispatch-rail-badge')).toHaveText('1 paused')
  await expect(railRow(page, DISPATCH_UNREADABLE)).toContainText('cannot be read')
  await expect(page.getByTestId('rail-triage').locator('.dispatch-rail-home-n')).not.toHaveText('…')

  // With /steps still held, the project page's feature rows count their runs from the run summaries, never "0 runs".
  await page.goto(projectUrl(DISPATCH_NOORIGIN))
  const redo = page.locator('li[data-workflow-id="redo"] a.lists-group-head')
  await expect(redo).toContainText('2 runs', { timeout: 30_000 })
  await expect(page.locator('[data-testid="dispatch-features"] a.lists-group-head', { hasText: /\b0 runs\b/ })).toHaveCount(0)
  await expect(page.locator('.dispatch-run[data-run-id="redo-002"]')).toHaveCount(1)
  // A run row with no served focus says its steps are reading, never the failure wording "not read" (M1).
  await page.goto(projectUrl(DISPATCH_WIDGETS_WT))
  const dropped = page.locator(`.dispatch-run[data-run-id="${RUN_WT_DROPPED}"]`)
  await expect(dropped.locator('.dispatch-run-2')).toContainText('reading steps…', { timeout: 30_000 })
  await expect(dropped).toHaveAttribute('aria-label', /Reading its steps\.$/)
  await expect(page.getByTestId('dispatch-chart').getByText('not read', { exact: false })).toHaveCount(0)
  releaseSteps()
  await expect(dropped.locator('.dispatch-run-2')).not.toContainText('reading steps…', { timeout: 30_000 })
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test(`A project whose run list fails: its rail row says "cannot be read" and Triage says the lists are incomplete above Needs you; the feature page shows no review line before its reviewers read settles (${phase})`, async ({ page }) => {
  test.slow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.route(url => url.pathname === `/api/projects/${DISPATCH_WIDGETS_WT}/workflows/experiment/runs`
    || url.pathname === `/api/projects/${DISPATCH_WIDGETS_WT}/workflows/wt-parked/runs` || url.pathname === `/api/projects/${DISPATCH_WIDGETS_WT}/workflows/wt-dropped/runs`,
  route => route.fulfill({ status: 503, json: { error: { code: 'RUNS_UNREADABLE', message: 'held for the test' } } }))
  await page.goto(triageUrl)
  await expect(railRow(page, DISPATCH_WIDGETS_WT)).toContainText('cannot be read', { timeout: 30_000 })
  const incomplete = page.getByTestId('lists-incomplete')
  await expect(incomplete).toHaveText(/^\d+ of \d+ projects read; lists incomplete$/)
  const [read, total] = (await incomplete.innerText()).match(/\d+/g)!.map(Number)
  expect(total - read).toBeGreaterThanOrEqual(1)
  expect((await incomplete.boundingBox())!.y).toBeLessThan((await page.getByTestId('needs-you').boundingBox())!.y)
  // The feature page: while the reviewers read is held, neither "Review steps" nor "Reviewers" shows.
  let release = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  const detail = `/api/projects/${PROJECT.project_id}/workflows/${UX_REVAMP_LISTS_WORKFLOW_ID}/runs/${REVAMP_FINISHED_RUNS[0]}`
  await page.route(url => url.pathname === detail, async route => { await held; await route.fallback().catch(() => undefined) })
  await page.goto(workflowUrl(PROJECT.project_id, UX_REVAMP_LISTS_WORKFLOW_ID))
  await expect(page.getByTestId('run-list')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.feature-reviews, .feature-reviewers')).toHaveCount(0)
  release()
  await expect(page.locator('.feature-reviews, .feature-reviewers')).toHaveCount(1, { timeout: 30_000 })
})

/** Drops, until stable, every run that needs the operator, every unfinished run that is not paused, and every run that moved on REVAMP_NOW's day. */
function quietRuns(runs: RunSummary[]): RunSummary[] {
  const today = dayKey(REVAMP_NOW, 'utc')
  let kept = runs.filter(run => (run.status === 'paused' || isFinished(run)) && dayKey(isFinished(run) ? endedAt(run) : movedAt(run), 'utc') !== today)
  for (;;) {
    const classes = classifyRuns(kept)
    const next = kept.filter(run => classOf(classes, run).needs === null)
    if (next.length === kept.length) return kept
    kept = next
  }
}

test(`[scenario:triage-desktop] Triage fills the main column at 1440 and 1920, ids stay on one line, the time drops under the id when a row is narrow, and empty sections collapse to one line (${phase})`, async ({ page }, testInfo) => {
  test.slow()
  await page.clock.setFixedTime(REVAMP_NOW)
  const overflow = () => page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') as Promise<number>
  for (const [width, height] of [[1440, 900], [1920, 1080]] as const) {
    await page.setViewportSize({ width, height })
    await page.goto(triageUrl)
    await expect(page.getByTestId('needs-you').locator('a[data-run-id]').first()).toBeVisible({ timeout: 30_000 })
    const [queue, main] = await page.evaluate(`(() => {
      const main = document.querySelector('.dispatch-shell-main')
      const style = getComputedStyle(main)
      return [document.querySelector('.runs-home').getBoundingClientRect().width, main.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)]
    })()`) as [number, number]
    expect(Math.abs(queue - main), `at ${width}px the queue is the main column`).toBeLessThanOrEqual(1)
    type Box = { getClientRects: () => { length: number }; getBoundingClientRect: () => { height: number }; textContent: string | null }
    const lines = await page.locator('.run-row-id').evaluateAll((ids: unknown[]) => (ids as Box[]).filter(id => id.getClientRects().length > 0).map(id => {
      const style = (globalThis as unknown as Styled).getComputedStyle(id)
      const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2
      return { id: id.textContent, height: id.getBoundingClientRect().height, line }
    }))
    expect(lines.length).toBeGreaterThan(0)
    for (const item of lines) expect(item.height, `${item.id} on one line at ${width}px`).toBeLessThan(item.line * 1.5)
    expect(await overflow()).toBeLessThanOrEqual(0)
    if (width === 1440) await attach(page, testInfo, 'triage-desktop')
  }
  // At 1100 px the rows' list is narrow: the time sits on its own line under the id instead of squeezing it.
  await page.setViewportSize({ width: 1100, height: 900 })
  const running = row(page.getByTestId('running-runs'), RUN_RERUN_OLD)
  await expect(running).toBeVisible()
  const id = (await running.locator('.run-row-id').boundingBox())!
  const when = (await running.locator('.run-row-when').boundingBox())!
  expect(when.y).toBeGreaterThanOrEqual(id.y + id.height - 1)
  expect(await overflow()).toBeLessThanOrEqual(0)
})

test(`Triage with nothing waiting, moved today or running: one line instead of three empty sections, and Paused unfolded (${phase})`, async ({ page }) => {
  test.slow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await editRunLists(page, runs => quietRuns(runs))
  await page.clock.setFixedTime(REVAMP_NOW)
  await page.goto(triageUrl)
  await expect(page.getByTestId('home-quiet')).toHaveText('Nothing waits on you, moved today or runs', { timeout: 30_000 })
  for (const id of ['needs-you', 'today-runs', 'running-runs']) {
    await expect(page.getByTestId(id)).toHaveCount(1)
    await expect(page.getByTestId(id)).toBeHidden()
  }
  const paused = page.getByTestId('paused-runs')
  await expect(paused.getByTestId('paused-show-all')).toHaveCount(0)
  const shown = await paused.locator(':scope > .run-rows > li').count()
  expect(shown).toBeGreaterThanOrEqual(2)
  await expect(paused.locator('.ui-section-header h2')).toHaveText(`Paused · ${shown}`)
  await expect(row(paused.locator(':scope > .run-rows'), RUN_PARKED)).toHaveCount(1)
  await expect(row(paused.locator(':scope > .run-rows'), RUN_WT_PARKED)).toHaveCount(1)
})

test(`Triage whose run reads all fail claims no quiet: no "Nothing waits on you" line, the sections stay shown (${phase})`, async ({ page }) => {
  test.slow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.route(isRunList, route => route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'run list unreadable' } } }))
  await page.clock.setFixedTime(REVAMP_NOW)
  await page.goto(triageUrl)
  await expect(page.getByTestId('lists-incomplete')).toHaveText(/^\d+ of \d+ projects read; lists incomplete$/, { timeout: 30_000 })
  await expect(page.getByTestId('home-quiet')).toHaveCount(0)
  for (const id of ['needs-you', 'today-runs', 'running-runs']) await expect(page.getByTestId(id)).toBeVisible()
})

test(`Triage with runs running: Paused folds after 5 as before (${phase})`, async ({ page }) => {
  test.slow()
  await page.setViewportSize({ width: 1440, height: 900 })
  // Six more paused runs that no later run supersedes: each the newest run of one of six dispatch workflows that hold no
  // paused run (created in June 2025, after every seeded run, so it is its workflow's latest; never Today or Recent).
  const hosts = [['dispatch-widgets-wt', 'experiment'], ['dispatch-trio', 'alpha-feature'], ['dispatch-trio', 'beta-feature'], ['dispatch-trio', 'gamma-feature'],
    [DISPATCH_NOORIGIN, 'main'], ['dispatch-widgets-wt', 'wt-dropped']]
  await editRunLists(page, (runs, url) => {
    const index = hosts.findIndex(([projectId, workflowId]) => url.pathname === `/api/projects/${projectId}/workflows/${workflowId}/runs`)
    return index < 0 || runs.length === 0 ? runs : [parkedRun(runs[0], `fold-00${index + 1}`, runs[0].workflow_id, `2025-06-0${index + 1}T08:00:00Z`), ...runs]
  })
  await page.clock.setFixedTime(REVAMP_NOW)
  await page.goto(triageUrl)
  await expect(page.getByTestId('running-runs').locator('a[data-run-id]').first()).toBeVisible({ timeout: 30_000 })
  const paused = page.getByTestId('paused-runs')
  await expect(row(paused, 'fold-001')).toHaveCount(1, { timeout: 30_000 })
  await expect(paused.locator(':scope > .run-rows > li')).toHaveCount(5)
  await expect(paused.getByTestId('paused-show-all')).toHaveText(/^Show all \d+ paused$/)
  await paused.getByTestId('paused-show-all').click()
  expect(await paused.locator(':scope > .run-rows > li').count()).toBeGreaterThanOrEqual(8)
  await expect(row(paused, 'fold-006')).toHaveCount(1)
})

test(`[scenario:rail-state] Rail badges carry their own state tone: paused in the pause tone, waits in warn, running in run; superseded paused runs add no badge (${phase})`, async ({ page }, testInfo) => {
  test.slow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await editRunLists(page, (runs, url) => {
    // Busy without its approval: only a running run is left, and nothing waits.
    if (url.pathname === `/api/projects/${DISPATCH_BUSY}/workflows/ship/runs`) return runs.filter(run => run.status === 'running')
    // Widgets gains a paused run that its own workflow's later runs supersede.
    if (url.pathname === `/api/projects/${DISPATCH_WIDGETS}/workflows/ui-polish/runs` && runs.length > 0) return [...runs, parkedRun(runs[0], 'ui-polish-000', 'ui-polish', '2024-06-01T08:00:00Z')]
    return runs
  })
  await page.goto(projectsUrl)
  const badge = (projectId: string) => railRow(page, projectId).locator('.dispatch-rail-badge')
  const glyph = (projectId: string) => railRow(page, projectId).locator('.dispatch-glyph')
  // Widgets worktree: its only live run is paused, its newest run (another workflow) was cancelled.
  await expect(badge(DISPATCH_WIDGETS_WT)).toHaveText('1 paused', { timeout: 30_000 })
  expect(await colourOf(badge(DISPATCH_WIDGETS_WT))).toBe(await tokenColour(page, '--pause'))
  await expect(glyph(DISPATCH_WIDGETS_WT)).toHaveClass(/\btone-pause\b/)
  await expect(dispatchCard(page, DISPATCH_WIDGETS_WT).locator('.dispatch-card-word')).toHaveText('1 paused')
  // No origin: decisions and interrupted runs (one of them running) are waits, in the warn tone.
  await expect(badge(DISPATCH_NOORIGIN)).toHaveText(`${NOORIGIN_NEEDS.length} waits on you`)
  expect(await colourOf(badge(DISPATCH_NOORIGIN))).toBe(await tokenColour(page, '--warn'))
  await expect(glyph(DISPATCH_NOORIGIN)).toHaveClass(/\btone-warn\b/)
  // Busy, with a running run and nothing waiting: "1 running" in the run tone.
  await expect(badge(DISPATCH_BUSY)).toHaveText('1 running')
  expect(await colourOf(badge(DISPATCH_BUSY))).toBe(await tokenColour(page, '--run'))
  // Widgets: its one paused run is superseded in its own workflow, so no paused badge (its unpushed badge stays).
  await expect(badge(DISPATCH_WIDGETS)).toHaveText('2 unpushed')
  await expect(railRow(page, DISPATCH_WIDGETS)).not.toContainText('paused')
  // The [D6] order: waits (and paused) first, then running, readable before unreadable, then last activity.
  const order = await page.getByTestId('dispatch-rail-list').locator('.dispatch-rail-row').evaluateAll((els: unknown[]) => els.map(el => (el as { getAttribute: (name: string) => string | null }).getAttribute('data-project-id')))
  expect(order.indexOf(DISPATCH_NOORIGIN)).toBeLessThan(order.indexOf(DISPATCH_BUSY))
  expect(order.indexOf(DISPATCH_WIDGETS_WT)).toBeLessThan(order.indexOf(DISPATCH_BUSY))
  expect(order.indexOf(DISPATCH_BUSY)).toBeLessThan(order.indexOf(DISPATCH_WIDGETS))
  expect(order[order.length - 1]).toBe(DISPATCH_UNREADABLE)
  await attach(page, testInfo, 'rail-state')
})

test(`[scenario:run-times] Stopped rows read as dates and days, running rows tick, finished rows keep their end and duration, and no span runs past 48 h in hours (${phase})`, async ({ page }, testInfo) => {
  test.slow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.clock.install({ time: new Date(REVAMP_NOW) })
  await page.goto(triageUrl)
  await expect(page.getByTestId('paused-runs').locator('a[data-run-id]').first()).toBeVisible({ timeout: 30_000 })
  const longSpan = /\d{3,}h\d{2}m/
  const daysSince = (iso: string) => Math.floor((Date.parse(REVAMP_NOW) - Date.parse(iso)) / 86_400_000)
  // A paused row: "paused <n> d (since <Mon D>)" from its attention since, no span.
  const parked = row(page.getByTestId('paused-runs'), RUN_PARKED)
  await expect(parked.locator('.run-row-when')).toHaveText(`paused ${daysSince(PARKED_SINCE)} d (since Nov 20 2024)`)
  await expect(parked.locator('.run-row-span')).toHaveCount(0)
  // An interrupted row reads interrupted, with no span, whether it is running (rerun-live-001) or paused (desk-interrupted).
  const interruptedRunning = row(page.getByTestId('running-runs'), RUN_RERUN_OLD)
  await expect(interruptedRunning).toHaveAttribute('data-status', 'running')
  await expect(interruptedRunning.locator('.run-row-when')).toHaveText(`interrupted ${daysSince('2024-12-05T08:30:00Z')} d (since Dec 5 2024)`)
  await expect(interruptedRunning.locator('.run-row-span')).toHaveCount(0)
  const fold = page.getByTestId('superseded-runs')
  await fold.locator('summary').click()
  await expect(row(fold, RUN_DESK_INTERRUPTED).locator('.run-row-when')).toHaveText('interrupted today (since Mar 12)')
  await expect(row(fold, RUN_DESK_INTERRUPTED).locator('.run-row-span')).toHaveCount(0)
  // A running row ticks: its span advances when the clock moves a minute.
  const live = row(page.getByTestId('today-runs'), RUN_DESK_LIVE).locator('.run-row-span')
  const before = await live.innerText()
  await page.clock.fastForward('01:00')
  await expect(live).not.toHaveText(before)
  // A finished row keeps its end time and its duration.
  const finished = row(page.getByTestId('today-runs'), REVAMP_FINISHED_RUNS[0])
  await expect(finished.locator('.run-row-span')).toHaveText('40m00s')
  await expect(finished.locator('time').first()).toHaveAttribute('datetime', /2026-03-12T15:40:00/)
  expect(await page.getByTestId('projects-workspace').innerText()).not.toMatch(longSpan)
  await attach(page, testInfo, 'run-times')

  // The feature page: the paused row and the interrupted paused row read the same way; a 50 h run reads "2 d 2 h".
  await page.goto(workflowUrl(DISPATCH_NOORIGIN, 'parked'))
  await expect(row(page.getByTestId('run-list'), RUN_PARKED).locator('.run-row-when')).toHaveText(/^paused \d+ d \(since Nov 20 2024\)$/, { timeout: 30_000 })
  await page.goto(workflowUrl(DISPATCH_NOORIGIN, 'halt'))
  await expect(row(page.getByTestId('run-list'), RUN_HALT).locator('.run-row-when')).toHaveText(/^interrupted \d+ d \(since Dec 4 2024\)$/, { timeout: 30_000 })
  await expect(row(page.getByTestId('run-list'), RUN_HALT).locator('.run-row-span')).toHaveCount(0)
  await page.goto(workflowUrl(DISPATCH_NOORIGIN, 'redo'))
  await expect(row(page.getByTestId('run-list'), RUN_REDO_NEW).locator('.run-row-span')).toHaveText('2 d 2 h', { timeout: 30_000 })
  expect(await page.getByTestId('projects-workspace').innerText()).not.toMatch(longSpan)
  // The project page names no span past 48 h in hours either.
  await page.goto(projectUrl(DISPATCH_NOORIGIN))
  await expect(page.locator('.dispatch-run[data-run-id="redo-002"]')).toBeVisible({ timeout: 30_000 })
  expect(await page.getByTestId('projects-workspace').innerText()).not.toMatch(longSpan)
})

// ---- "Add to Triage" ([O6], [O10], [L1], [L2], [L8]) ----------------------------------------------------------------------

/** A Recent run of this module under REVAMP_NOW: desk-ok-4 finished on 2026-03-11, the day before the clock. */
const PIN_RUN = 'desk-ok-4'
const pinName = (runId: string, pinned: boolean) => (pinned ? `Remove ${runId} from Triage` : `Add ${runId} to Triage`)
const toggleIn = (scope: Locator, runId: string, pinned: boolean) => scope.getByRole('button', { name: pinName(runId, pinned), exact: true })
const pinnedSection = (page: Page) => page.getByTestId('pinned-runs')

/**
 * Runs `action` in a window with the page's timers frozen by page.clock (no poll can fire) after the in-flight reads have
 * settled, and asserts that it issued no /api request at all.
 */
async function noRequestWindow(page: Page, action: () => Promise<void>) {
  const isApi = (request: { url: () => string }) => new URL(request.url()).pathname.startsWith('/api/')
  // Pause a moment ahead of the page's clock (its time keeps flowing until then, so retry when it has already passed).
  for (let attempt = 0; ; attempt += 1) {
    const now = await page.evaluate(() => Date.now())
    try {
      await page.clock.pauseAt(now + 2000)
      break
    } catch (error) {
      if (attempt >= 5) throw error
    }
  }
  // With the timers frozen no poll starts; let the reads already under way (and any page they chain to) settle first.
  let last = Date.now()
  const seen = (request: { url: () => string }) => { if (isApi(request)) last = Date.now() }
  page.on('request', seen)
  while (Date.now() - last < 1500) await page.waitForTimeout(250)
  page.off('request', seen)
  let requests = 0
  const count = (request: { url: () => string }) => { if (isApi(request)) requests += 1 }
  page.on('request', count)
  await action()
  await page.waitForTimeout(400)
  page.off('request', count)
  await page.clock.resume()
  expect(requests, 'pinning or unpinning issues no request').toBe(0)
}

/** Triage, with Recent narrowed to the pinned run by its search box (so it is never behind "Show older"). */
async function openRecentRow(page: Page): Promise<Locator> {
  await page.goto(triageUrl)
  const recent = page.getByTestId('recent-runs')
  await page.getByLabel('Search runs').fill(PIN_RUN, { timeout: 30_000 })
  await expect(row(recent, PIN_RUN)).toBeVisible({ timeout: 30_000 })
  return recent
}

async function pinOnTriage(page: Page) {
  const recent = await openRecentRow(page)
  await noRequestWindow(page, async () => {
    await toggleIn(recent, PIN_RUN, false).click()
    await expect(toggleIn(recent, PIN_RUN, true)).toBeVisible()
  })
  await expect(row(pinnedSection(page), PIN_RUN)).toHaveCount(1)
}

test(`[scenario:triage-pins] "Add to Triage" pins a run to a Pinned section from its row, its run and node pages, the feature page and the reading pane, with no request, kept across a reload (${phase})`, async ({ page }, testInfo) => {
  test.slow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.clock.install({ time: new Date(REVAMP_NOW) })
  const workspace = page.getByTestId('projects-workspace')

  // Triage's Recent row: the toggle sits beside the row link inside its li, never inside the link.
  const recent = await openRecentRow(page)
  const item = recent.locator(`li:has(> a[data-run-id="${PIN_RUN}"])`)
  await expect(item.locator(':scope > button.pin-toggle')).toHaveCount(1)
  await expect(row(recent, PIN_RUN).locator('button')).toHaveCount(0)
  await expect(pinnedSection(page)).toHaveCount(0)
  await noRequestWindow(page, async () => {
    await toggleIn(recent, PIN_RUN, false).click()
    await expect(toggleIn(recent, PIN_RUN, true)).toBeVisible()
  })
  // A Pinned section at the top of Triage lists it, linking to its run page; the run also stays in Recent.
  const pinned = pinnedSection(page)
  await expect(row(pinned, PIN_RUN)).toHaveAttribute('href', runUrl(PIN_RUN, undefined, UX_REVAMP_LISTS_WORKFLOW_ID))
  expect((await pinned.boundingBox())!.y).toBeLessThan((await page.getByTestId('needs-you').boundingBox())!.y)
  await expect(row(recent, PIN_RUN)).toHaveCount(1)
  await attach(page, testInfo, 'triage-pins')
  // The pin survives a reload.
  await page.reload()
  await expect(row(pinnedSection(page), PIN_RUN)).toHaveCount(1, { timeout: 30_000 })
  await row(pinnedSection(page), PIN_RUN).click()
  await expect(page).toHaveURL(new RegExp(`${runUrl(PIN_RUN, undefined, UX_REVAMP_LISTS_WORKFLOW_ID)}$`))

  // The run page and one of its node pages carry the same toggle on the crumb row, outside the workspace; at 1440 px that
  // row is no taller than the greater of the page's crumbs and the toggle (within 1 px).
  for (const nodeId of [undefined, 'launch_ui']) {
    await page.goto(runUrl(PIN_RUN, nodeId, UX_REVAMP_LISTS_WORKFLOW_ID))
    const crumbRow = page.getByTestId('crumb-row')
    await expect(toggleIn(crumbRow, PIN_RUN, true)).toBeVisible({ timeout: 30_000 })
    await expect(workspace.locator('[data-testid="run-view"], [data-testid="node-detail"]').first()).toBeVisible({ timeout: 30_000 })
    await expect(workspace.locator('button.pin-toggle')).toHaveCount(0)
    const rowBox = (await crumbRow.boundingBox())!
    const crumbs = (await crumbRow.locator('.breadcrumbs').boundingBox())!
    const toggle = (await toggleIn(crumbRow, PIN_RUN, true).boundingBox())!
    expect(rowBox.height, `crumb row on ${nodeId ?? 'the run page'}`).toBeLessThanOrEqual(Math.max(crumbs.height, toggle.height) + 1)
  }
  // Removing it on the node page removes the Pinned row on Triage.
  await noRequestWindow(page, async () => {
    await toggleIn(page.getByTestId('crumb-row'), PIN_RUN, true).click()
    await expect(toggleIn(page.getByTestId('crumb-row'), PIN_RUN, false)).toBeVisible()
  })
  await openRecentRow(page)
  await expect(pinnedSection(page)).toHaveCount(0)

  // The feature page's row reads and changes the same pin.
  await pinOnTriage(page)
  await page.goto(workflowUrl(PROJECT.project_id, UX_REVAMP_LISTS_WORKFLOW_ID))
  const runList = page.getByTestId('run-list')
  await expect(toggleIn(runList, PIN_RUN, true)).toBeVisible({ timeout: 30_000 })
  await expect(runList.locator(`li:has(> a[data-run-id="${PIN_RUN}"]) > button.pin-toggle`)).toHaveCount(1)
  await noRequestWindow(page, async () => {
    await toggleIn(runList, PIN_RUN, true).click()
    await expect(toggleIn(runList, PIN_RUN, false)).toBeVisible()
  })
  await openRecentRow(page)
  await expect(pinnedSection(page)).toHaveCount(0)

  // The project page's reading pane reads and changes the same pin.
  await pinOnTriage(page)
  await page.goto(projectUrl(PROJECT.project_id))
  await page.locator(`.dispatch-run[data-run-id="${PIN_RUN}"]`).click({ timeout: 30_000 })
  const pane = page.getByTestId('dispatch-pane')
  await expect(toggleIn(pane, PIN_RUN, true)).toBeVisible()
  await expect(pane.getByTestId('dispatch-pane-next-loading')).toHaveCount(0, { timeout: 30_000 })
  await noRequestWindow(page, async () => {
    await toggleIn(pane, PIN_RUN, true).click()
    await expect(toggleIn(pane, PIN_RUN, false)).toBeVisible()
  })
  await openRecentRow(page)
  await expect(pinnedSection(page)).toHaveCount(0)

  // A pinned run that Triage did not read: its id as a link to its run page, "not among the runs read", no reason.
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), ['md-manager:triage-pins:v1',
    JSON.stringify([{ project_id: PROJECT.project_id, workflow_id: UX_REVAMP_LISTS_WORKFLOW_ID, run_id: 'desk-gone', pinned_at: '2026-03-12T19:00:00Z' }])])
  await page.reload()
  const unread = pinnedSection(page).locator('li', { hasText: 'desk-gone' })
  await expect(unread.getByRole('link', { name: 'desk-gone', exact: true })).toHaveAttribute('href', runUrl('desk-gone', undefined, UX_REVAMP_LISTS_WORKFLOW_ID), { timeout: 30_000 })
  await expect(unread).toContainText('not among the runs read')
  await expect(unread).not.toContainText('older than')
  await expect(toggleIn(unread, 'desk-gone', true)).toBeVisible()
})

test(`Pins with a browser storage that throws: Triage renders, pinning works for the page session, and the Pinned section says pins are not saved (${phase})`, async ({ page }) => {
  test.slow()
  await page.addInitScript("Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('storage denied') } })")
  await page.clock.setFixedTime(REVAMP_NOW)
  const recent = await openRecentRow(page)
  await expect(page.getByTestId('needs-you')).toBeVisible()
  await toggleIn(recent, PIN_RUN, false).click()
  await expect(row(pinnedSection(page), PIN_RUN)).toHaveCount(1)
  await expect(pinnedSection(page).getByTestId('pins-not-saved')).toHaveText('Pins are not saved in this browser')
})

test(`Pins with a malformed stored value read as no pins; pinning a pinned run again leaves one Pinned row (${phase})`, async ({ page }) => {
  test.slow()
  await page.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('md-manager:triage-pins:v1', '{not json'); sessionStorage.setItem('seeded', '1') } })
  await page.clock.setFixedTime(REVAMP_NOW)
  await openRecentRow(page)
  await expect(pinnedSection(page)).toHaveCount(0)
  // Pinned from its run page, then the run page offers only Remove: the same run is never pinned twice.
  await page.goto(runUrl(PIN_RUN, undefined, UX_REVAMP_LISTS_WORKFLOW_ID))
  await toggleIn(page.getByTestId('crumb-row'), PIN_RUN, false).click({ timeout: 30_000 })
  await expect(toggleIn(page.getByTestId('crumb-row'), PIN_RUN, true)).toBeVisible()
  await expect(page.getByTestId('crumb-row').getByRole('button', { name: pinName(PIN_RUN, false) })).toHaveCount(0)
  // A stored list that names the run twice still lists it once.
  await page.evaluate(([key, runId, workflowId, projectId]) => {
    const pin = { project_id: projectId, workflow_id: workflowId, run_id: runId, pinned_at: '2026-03-12T19:00:00Z' }
    localStorage.setItem(key, JSON.stringify([pin, { ...pin, pinned_at: '2026-03-12T18:00:00Z' }]))
  }, ['md-manager:triage-pins:v1', PIN_RUN, UX_REVAMP_LISTS_WORKFLOW_ID, PROJECT.project_id])
  await page.goto(triageUrl)
  await expect(page.getByTestId('needs-you')).toBeVisible({ timeout: 30_000 })
  await expect(pinnedSection(page).locator('a[data-run-id]')).toHaveCount(1)
})

test(`Pins at 390 px: the row and crumb toggles are 44 px tall and nothing scrolls sideways (${phase})`, async ({ page }) => {
  test.slow()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.clock.setFixedTime(REVAMP_NOW)
  const recent = await openRecentRow(page)
  expect((await toggleIn(recent, PIN_RUN, false).boundingBox())!.height).toBeGreaterThanOrEqual(44)
  expect(await (page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') as Promise<number>)).toBeLessThanOrEqual(0)
  await page.goto(runUrl(PIN_RUN, undefined, UX_REVAMP_LISTS_WORKFLOW_ID))
  const toggle = toggleIn(page.getByTestId('crumb-row'), PIN_RUN, false)
  await expect(toggle).toBeVisible({ timeout: 30_000 })
  expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  expect(await (page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') as Promise<number>)).toBeLessThanOrEqual(0)
})
