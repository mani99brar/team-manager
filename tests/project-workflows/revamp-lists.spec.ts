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
import { classifyRuns, classOf, compareLive, dayKey, movedAt, endedAt, isFinished } from '../../src/projects/lists.ts'
import { validateReviewResult, type ReviewResult, type RunSummary } from '../../contracts/projects/v1.ts'
import { EMPTY_WORKFLOW_ID, PROJECT } from './fixtures.ts'
import {
  PANE_MESSAGE, REVAMP_FAILED_RUNS, REVAMP_FINISHED_RUNS, REVAMP_LANES, REVAMP_LATEST_RUN, REVAMP_NOW, REVAMP_OWN_RUNS, REVAMP_PREFIX, REVAMP_SUCCEEDED_RUNS,
  RUN_DESK_HELD, RUN_DESK_INTERRUPTED, RUN_DESK_LIVE, RUN_DESK_LIVE_QUIET, RUN_DESK_PANE, RUN_DESK_PAUSED, RUN_DESK_STALE, UX_REVAMP_LISTS_WORKFLOW_ID,
} from './fixtures/ux-revamp-lists.ts'
import { installProjectMocks, mockResponse } from './mock.ts'
import {
  DISPATCH_BUSY, DISPATCH_NOORIGIN, DISPATCH_UNREADABLE, DISPATCH_WIDGETS, DISPATCH_WIDGETS_WT, NOORIGIN_NEEDS, PARKED_SINCE, RUN_DECIDE, RUN_HALT,
  RUN_HALT_LIVE, RUN_PARKED, RUN_REDO_NEW, RUN_REDO_OLD, RUN_RERUN_OLD, RUN_WT_DROPPED, RUN_WT_PARKED,
} from './fixtures/dispatch.ts'
import {
  attach, editHomeRows, editHomeRuns, EXECUTION_WORDS, executionControlCount, expectNoExecutionControls, expectNoProjectPageExecutionControls, gotoProjectOpen, installHooks, installListsWorld,
  isHomeRuns, isRegistryPages, phase, PHASE_OPTIONS, projectsUrl, projectUrl, runUrl, triageUrl, workflowUrl, workspace, type HomeEntry,
} from './support.ts'
import { RUN_SESSIONS, UX_SESSIONS_WORKFLOW_ID } from './fixtures/sessions.ts'
import { B_FILTER, B_FOLD, B_MIX, B_MIX_ORDER, B_ORDER, B_ORDER_FEATURES, B_PARKED, B_RUNNER, bDefinition, bSummary, LISTS_B_NOW } from './fixtures/ux-lists.ts'

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
/** The given runs of this module's workflow in the list order (`compareLive`), read from the run list the phase serves. */
async function foldOrder(page: Page, ids: readonly string[]): Promise<string[]> {
  const body = await page.evaluate(async path => (await fetch(path)).json(), `/api/projects/${PROJECT.project_id}/workflows/${UX_REVAMP_LISTS_WORKFLOW_ID}/runs`) as { runs: RunSummary[] }
  const classes = classifyRuns(body.runs)
  return body.runs.filter(run => ids.includes(run.run_id)).sort(compareLive(classes)).map(run => run.run_id)
}
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


test(`[scenario:home-sections] Runs home ranked by need at 1440: Needs you cards, Running and Paused as compact rows with step sub-headers, Recent with filtered-set counts, and the feature header's real reviewers (${phase})`, async ({ page }, testInfo) => {
  test.setTimeout(90_000)
  await serveDeskReviewers(page)
  await page.clock.setFixedTime(REVAMP_NOW)
  // The Runs home data path is read against the mock: record its fetch (P2: no browser test of it before). Since stage C it is the
  // one registry home read, which serves every workflow's run-list rows.
  const recorded = page.waitForRequest(request => request.method() === 'GET' && isHomeRuns(new URL(request.url())))
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
  await expect(jumps.getByRole('link')).toHaveText([/^Needs you\d+$/, /^Running\d+$/, /^Today\d+$/, /^Paused\d+$/, /^Recent\d+$/])

  // Running: every running run that waits on nobody, whatever day it last moved, latest activity first. A running row is a
  // compact row (a run-row, not a six-line card) with its lane chips; a sub-header counts the step each row sits at, derived
  // from the rows, never a literal total, and names the row order.
  const today = page.getByTestId('today-runs')
  await expect(today.locator('.ui-section-header h2')).toHaveText(/^Today · \d+$/)
  const runningSection = page.getByTestId('running-runs')
  for (const runId of [RUN_DESK_LIVE, RUN_DESK_LIVE_QUIET]) {
    await expect(row(today, runId)).toHaveCount(0)
    const liveRow = row(runningSection, runId)
    await expect(liveRow).toHaveAttribute('data-status', 'running')
    expect(await liveRow.evaluate(link => link.parentElement?.className ?? '')).toMatch(/\brun-row-item\b/)
    await expect(liveRow.locator('[data-lane]')).toHaveText([...REVAMP_LANES])
  }
  expect((await ownIds(runningSection)).slice(0, 2).sort()).toEqual([RUN_DESK_LIVE, RUN_DESK_LIVE_QUIET].sort())
  // The paused runs of this feature that moved today are superseded by desk-live-1, a later run of their own workflow: they
  // are no Today or Running rows but sit, paused, in the Paused section's closed fold (asserted below).
  for (const runId of PAUSED_OLDEST_FIRST) {
    await expect(row(today, runId)).toHaveCount(0)
    await expect(row(runningSection, runId)).toHaveCount(0)
  }
  await expect(runningSection.locator('.ui-section-header .ui-sub')).toHaveText(/\d+ at \S.* · latest activity first$/)

  // Today: only the runs that finished today; none of this feature's failed runs is running, and no running run is a Today row.
  const running = page.getByTestId('running-runs')
  await expect(running.locator('.ui-section-header h2')).toHaveText(/^Running · \d+$/)
  for (const runId of [...PAUSED_OLDEST_FIRST, ...REVAMP_FAILED_RUNS]) await expect(row(running, runId)).toHaveCount(0)
  for (const status of await today.locator('a[data-run-id]').evaluateAll(links => links.map(link => link.getAttribute('data-status')))) expect(['failed', 'succeeded', 'cancelled']).toContain(status)

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
  // The fold follows the list order, latest activity first, over the same four runs.
  expect(await ownIds(fold)).toEqual(await foldOrder(page, PAUSED_OLDEST_FIRST))
  for (const runId of PAUSED_OLDEST_FIRST) {
    await expect(row(fold, runId)).toHaveAttribute('data-status', 'paused')
    await expect(row(fold, runId)).toHaveAttribute('data-superseded-by', RUN_DESK_LIVE)
    await expect(row(fold, runId)).not.toHaveAttribute('data-attention', /.+/)
    await expect(row(fold, runId)).toContainText(`superseded by ${RUN_DESK_LIVE}`)
    expect(await row(fold, runId).evaluate(rowTone)).toBe('pause')
  }
  await expect(row(fold, RUN_DESK_STALE).locator('.run-row-stopped.tone-pause-text')).toHaveText('paused 3 d (since Mar 9)')
  await expect(row(fold, RUN_DESK_STALE).locator('.run-row-span')).toHaveCount(0)

  // Recent through Triage's one bar: the Failed and Succeeded counts equal the rows that toggle keeps across the sections over
  // the searched set (P2 1), and Recent keeps only rows of that status.
  const recent = page.getByTestId('recent-runs')
  const search = page.getByLabel('Search runs')
  await search.fill(REVAMP_PREFIX)
  await showAll(recent)
  const stateRows = page.locator(['needs-you', 'running-runs', 'today-runs', 'paused-runs', 'recent-runs'].map(id => `[data-testid="${id}"] a[data-run-id]`).join(', '))
  for (const [status, label] of [['failed', 'Failed'], ['succeeded', 'Succeeded']] as const) {
    const button = page.getByTestId('run-filter').locator(`button[data-filter="${status}"]`)
    await expect(button).toHaveText(new RegExp(`^${label} \\d+$`))
    const count = Number((await button.textContent())!.replace(/\D/g, ''))
    await button.click()
    await showAll(recent)
    const shown = await stateRows.count()
    expect(shown, `${label} count equals the rows it keeps`).toBe(count)
    for (const dataStatus of await recent.locator('a[data-run-id]').evaluateAll(links => links.map(link => link.getAttribute('data-status')))) expect(dataStatus).toBe(status)
    await button.click()
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
  // The rail, the cards and Triage read every list in one home read: each workflow's rows are filtered there; a workflow that
  // could not be read keeps its error, so Runs home reads it under Attention exactly as it would without this override.
  await editHomeRows(page, runs => filterWaiting({ runs, next_cursor: null }).runs)
  await page.clock.setFixedTime(REVAMP_NOW)
  await page.goto(triageUrl)
  const needs = page.getByTestId('needs-you')
  // The rest of Runs home still reads its runs, so the empty state is not a page that failed to load.
  await expect(row(page.getByTestId('running-runs'), RUN_DESK_LIVE)).toHaveCount(1)
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
  // The home read names that workflow's failure, as its run-list route answered it before.
  await editHomeRuns(page, (entry, url) => (url.pathname === failing ? { ...entry, runs: [], next_cursor: null, error: { status: 500, code: 'revamp_test', message: 'The run list could not be read' } } : entry))
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
 * The other ways a read fails: the request never gets an answer (network), or the server answers with a body that is not JSON,
 * an error page or a success. Triage reads every list in one request now, so it is that read which fails: Triage shows no row
 * and no all-clear, and says the runs were not read, with each failure's own message in words.
 */
const LIST_FAILURES: { what: string; answer: (route: Route) => Promise<void>; message: string }[] = [
  { what: 'a network failure', answer: route => route.abort('connectionrefused'), message: 'The API could not be reached. Check that the server is running, then retry.' },
  { what: 'a non-JSON error page', answer: route => route.fulfill({ status: 502, contentType: 'text/html', body: '<html><body>Bad gateway</body></html>' }), message: 'The API responded with status 502. (HTTP 502)' },
  { what: 'a success whose body is not JSON', answer: route => route.fulfill({ status: 200, contentType: 'text/plain', body: 'not json' }), message: 'The API returned data that does not match the projects contract: the response body is not JSON.' },
]

for (const failure of LIST_FAILURES) {
  test(`Runs home whose run read failed by ${failure.what}: it says the runs were not read, in words, and claims nothing (${phase})`, async ({ page }) => {
    test.slow()
    // The answer is the failure itself in both phases: nothing of the original response is read.
    await page.route(isHomeRuns, failure.answer)
    await page.clock.setFixedTime(REVAMP_NOW)
    await page.goto(triageUrl)
    const notRead = page.getByTestId('home-not-read')
    await expect(notRead).toHaveText(`Runs not read: ${failure.message}`, { timeout: 30_000 })
    for (const runId of OWN) await expect(page.locator(`a[data-run-id="${runId}"]`)).toHaveCount(0)
    await expect(page.getByTestId('home-quiet')).toHaveCount(0)
    await expect(page.getByText('nothing waits on you')).toHaveCount(0)
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
  const history = page.getByRole('list', { name: 'Run history, needs you and running first' })
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
  await expect(page.getByRole('list', { name: 'Run history, needs you and running first' })).toHaveCount(0)
  await expect(page.getByTestId('current-definition')).toHaveJSProperty('open', true)
  await expect(page.getByTestId('current-definition')).toContainText('3 nodes')
})

// ---- ux-critique-fixes stage A, lane `lists` (features/ux-critique-fixes/prd.md 6) ------------------------------------------

const STATE_SECTIONS = ['needs-you', 'running-runs', 'today-runs', 'paused-runs', 'recent-runs'] as const
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

/**
 * Answers the registry home read with `edit` applied to each workflow's original rows (the mocks' in the worker phase, the
 * server's in the candidate), keyed by the workflow's run-list URL as when each list was its own request.
 */
const editRunLists = (page: Page, edit: (runs: RunSummary[], url: URL) => RunSummary[]) => editHomeRows(page, edit)

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
  await page.route(url => isHomeRuns(url) || isRunList(url) || isOverview(url), async route => { await lists; await route.fallback().catch(() => undefined) })
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
  await gotoProjectOpen(page, projectUrl(DISPATCH_NOORIGIN))
  const redo = page.locator('li[data-workflow-id="redo"] a.lists-group-head')
  await expect(redo).toContainText('2 runs', { timeout: 30_000 })
  await expect(page.locator('[data-testid="dispatch-features"] a.lists-group-head', { hasText: /\b0 runs\b/ })).toHaveCount(0)
  await expect(page.locator('.dispatch-run[data-run-id="redo-002"]')).toHaveCount(1)
  // A run row with no served focus says its steps are reading, never the failure wording "not read".
  await gotoProjectOpen(page, projectUrl(DISPATCH_WIDGETS_WT))
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
  const wtLists = (url: URL) => url.pathname === `/api/projects/${DISPATCH_WIDGETS_WT}/workflows/experiment/runs`
    || url.pathname === `/api/projects/${DISPATCH_WIDGETS_WT}/workflows/wt-parked/runs` || url.pathname === `/api/projects/${DISPATCH_WIDGETS_WT}/workflows/wt-dropped/runs`
  const unreadable: HomeEntry['error'] = { status: 503, code: 'RUNS_UNREADABLE', message: 'held for the test' }
  await editHomeRuns(page, (entry, url) => (wtLists(url) ? { ...entry, runs: [], next_cursor: null, error: unreadable } : entry))
  await page.route(wtLists, route => route.fulfill({ status: 503, json: { error: { code: 'RUNS_UNREADABLE', message: 'held for the test' } } }))
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
  await editHomeRuns(page, entry => ({ ...entry, runs: [], next_cursor: null, error: { status: 500, code: 'internal', message: 'run list unreadable' } }))
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
  // Paused follows the list order, latest activity first: the newest of the six leads, the oldest waits behind "Show all".
  const paused = page.getByTestId('paused-runs')
  await expect(row(paused, 'fold-006')).toHaveCount(1, { timeout: 30_000 })
  await expect(paused.locator(':scope > .run-rows > li')).toHaveCount(5)
  await expect(row(paused, 'fold-001')).toHaveCount(0)
  await expect(paused.getByTestId('paused-show-all')).toHaveText(/^Show all \d+ paused$/)
  await paused.getByTestId('paused-show-all').click()
  expect(await paused.locator(':scope > .run-rows > li').count()).toBeGreaterThanOrEqual(8)
  await expect(row(paused, 'fold-001')).toHaveCount(1)
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
  // The order: waits first, then running, then paused, readable before unreadable, then last activity.
  const order = await page.getByTestId('dispatch-rail-list').locator('.dispatch-rail-row').evaluateAll((els: unknown[]) => els.map(el => (el as { getAttribute: (name: string) => string | null }).getAttribute('data-project-id')))
  expect(order.indexOf(DISPATCH_NOORIGIN)).toBeLessThan(order.indexOf(DISPATCH_BUSY))
  expect(order.indexOf(DISPATCH_BUSY), 'a running project ranks above a paused-only one').toBeLessThan(order.indexOf(DISPATCH_WIDGETS_WT))
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
  const live = row(page.getByTestId('running-runs'), RUN_DESK_LIVE).locator('.run-row-span')
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
  await gotoProjectOpen(page, projectUrl(DISPATCH_NOORIGIN))
  await expect(page.locator('.dispatch-run[data-run-id="redo-002"]')).toBeVisible({ timeout: 30_000 })
  expect(await page.getByTestId('projects-workspace').innerText()).not.toMatch(longSpan)
})

// ---- "Add to Triage" ([O6], [O10], [L1], [L2], [L8]) ----------------------------------------------------------------------

/** A Recent run of this module under REVAMP_NOW: desk-ok-4 finished on 2026-03-11, the day before the clock. */
const PIN_RUN = 'desk-ok-4'
const pinName = (runId: string, pinned: boolean) => (pinned ? `In Triage, ${runId}` : `Add to Triage, ${runId}`)
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
  await projectRead(page)
  const pinFeature = page.locator(`li[data-workflow-id="${UX_REVAMP_LISTS_WORKFLOW_ID}"]`)
  if ((await pinFeature.getByTestId('dispatch-feature-toggle').getAttribute('aria-expanded')) === 'false') await pinFeature.getByRole('button', { name: 'Show runs' }).click()
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
  await expect(pinnedSection(page)).not.toContainText('pinned in this browser')
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

// ---- Find and order runs: one order, the filter bar, the folded project page, the list state in the URL ------------------

const B_CLOCK = new Date(LISTS_B_NOW)
const ownRows = (scope: Locator, ids: readonly string[]) => scope.locator('a[data-run-id]').evaluateAll(
  (links, own) => links.map(link => link.getAttribute('data-run-id')).filter((id): id is string => id !== null && own.includes(id)), [...ids])
const runList = (page: Page) => page.getByTestId('run-list')
const bar = (scope: Page | Locator) => scope.getByTestId('run-filter')
const sortTo = (scope: Page | Locator, value: 'live' | 'newest' | 'oldest') => bar(scope).getByTestId('run-filter-sort').selectOption(value)
const statusToggle = (scope: Page | Locator, id: string) => bar(scope).locator(`button[data-filter="${id}"]`)
const featureIds = (page: Page, own: readonly string[]) => page.getByTestId('dispatch-features').locator('li[data-workflow-id]').evaluateAll(
  (items, ids) => items.map(item => item.getAttribute('data-workflow-id')).filter((id): id is string => id !== null && ids.includes(id)), [...own])
const B_ORDER_IDS = B_ORDER.workflows.map(workflow => workflow.workflow_id)
/** Waits until the project page is shown and its run lists are read. */
async function projectRead(page: Page) {
  await expect(page.getByTestId('dispatch-features')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('dispatch-needs-loading')).toHaveCount(0, { timeout: 30_000 })
  await expect(page.getByTestId('dispatch-features').getByText('reading runs…')).toHaveCount(0, { timeout: 30_000 })
}

/** The /api paths a window of control changes requests, with the page's timers frozen (no poll can fire) once reads settle. */
async function requestsDuring(page: Page, action: () => Promise<void>): Promise<string[]> {
  for (let attempt = 0; ; attempt += 1) {
    const now = await page.evaluate(() => Date.now())
    try {
      await page.clock.pauseAt(now + 2000)
      break
    } catch (error) {
      if (attempt >= 5) throw error
    }
  }
  const isApi = (request: { url: () => string }) => new URL(request.url()).pathname.startsWith('/api/')
  let last = Date.now()
  const seen = (request: { url: () => string }) => { if (isApi(request)) last = Date.now() }
  page.on('request', seen)
  while (Date.now() - last < 1500) await page.waitForTimeout(250)
  page.off('request', seen)
  const paths: string[] = []
  const count = (request: { url: () => string }) => { if (isApi(request)) paths.push(new URL(request.url()).pathname + new URL(request.url()).search) }
  page.on('request', count)
  await action()
  await page.waitForTimeout(400)
  page.off('request', count)
  await page.clock.resume()
  return paths
}

test(`[scenario:live-first] Needs you and running first everywhere: the rail and cards, the feature page, the project page and Triage, with the chronological sorts named (${phase})`, async ({ page }, testInfo) => {
  test.slow()
  await installListsWorld(page)
  await page.clock.setFixedTime(B_CLOCK)
  await page.setViewportSize({ width: 1440, height: 900 })

  // Projects: a project whose only live run is running ranks above one whose only live runs are paused, in the rail and the cards.
  await page.goto(projectsUrl)
  await expect(railRow(page, B_PARKED.project_id).locator('.dispatch-rail-badge')).toHaveText('2 paused', { timeout: 30_000 })
  await expect(railRow(page, B_RUNNER.project_id).locator('.dispatch-rail-badge')).toHaveText('1 running')
  const railIds = await page.getByTestId('dispatch-rail-list').locator('.dispatch-rail-row').evaluateAll(els => els.map(el => el.getAttribute('data-project-id')))
  const cardIds = await page.getByTestId('dispatch-cards').locator('.dispatch-card').evaluateAll(els => els.map(el => el.getAttribute('data-project-id')))
  for (const ids of [railIds, cardIds]) {
    expect(ids.indexOf(B_RUNNER.project_id)).toBeGreaterThanOrEqual(0)
    expect(ids.indexOf(B_RUNNER.project_id), 'running before paused').toBeLessThan(ids.indexOf(B_PARKED.project_id))
    expect(ids.indexOf(B_ORDER.project_id), 'waits before running').toBeLessThan(ids.indexOf(B_RUNNER.project_id))
  }
  expect(cardIds).toEqual(railIds)

  // The feature page: needs you, running, paused, then the finished runs latest activity first, under a sub-header naming it.
  await page.goto(workflowUrl(B_ORDER.project_id, 'order-mix'))
  const sub = page.getByTestId('feature-runs-sub')
  await expect(sub).toHaveText('6 runs · needs you and running first, then latest activity')
  await expect.poll(() => ownRows(runList(page), B_MIX_ORDER.live)).toEqual(B_MIX_ORDER.live)
  await expect(page.getByRole('list', { name: 'Run history, needs you and running first' })).toHaveCount(1)
  await sortTo(page, 'newest')
  await expect(sub).toHaveText('6 runs · newest created first')
  await expect.poll(() => ownRows(runList(page), B_MIX_ORDER.live)).toEqual(B_MIX_ORDER.newest)
  await expect(page.getByRole('list', { name: 'Run history, newest created first' })).toHaveCount(1)
  await sortTo(page, 'oldest')
  await expect(sub).toHaveText('6 runs · oldest created first')
  await expect.poll(() => ownRows(runList(page), B_MIX_ORDER.live)).toEqual(B_MIX_ORDER.oldest)

  // The project page: the feature with a needs-you run first, then the running one, then the finished ones; the sorts name both keys.
  await page.goto(projectUrl(B_ORDER.project_id))
  await projectRead(page)
  const featuresSub = page.getByTestId('project-features-sub')
  await expect(featuresSub).toHaveText('4 features · needs you and running first, then latest activity')
  await expect.poll(() => featureIds(page, B_ORDER_IDS)).toEqual(B_ORDER_FEATURES.live)
  const mixRows = page.locator('li[data-workflow-id="order-mix"] .dispatch-run')
  await expect.poll(() => mixRows.evaluateAll(els => els.map(el => el.getAttribute('data-run-id')))).toEqual(B_MIX_ORDER.live)
  await sortTo(page, 'newest')
  await expect(featuresSub).toHaveText('4 features · latest activity first · runs newest created first')
  await expect.poll(() => featureIds(page, B_ORDER_IDS)).toEqual(B_ORDER_FEATURES.newest)
  await expect.poll(() => mixRows.evaluateAll(els => els.map(el => el.getAttribute('data-run-id')))).toEqual(B_MIX_ORDER.newest)
  await sortTo(page, 'oldest')
  await expect(featuresSub).toHaveText('4 features · earliest activity first · runs oldest created first')
  await expect.poll(() => featureIds(page, B_ORDER_IDS)).toEqual(B_ORDER_FEATURES.oldest)
  await expect.poll(() => mixRows.evaluateAll(els => els.map(el => el.getAttribute('data-run-id')))).toEqual(B_MIX_ORDER.oldest)

  // Triage: Needs you, Running, Today, Paused, Recent, the jump links in that order; a running run that moved before today is
  // in Running, a run that finished today in Today, a run paused today in Paused and never Today.
  await page.goto(triageUrl)
  await expect(page.getByTestId('needs-you').locator('.ui-section-header h2')).toHaveText(/^Needs you · \d+$/, { timeout: 30_000 })
  const order = await page.locator('section[data-testid$="-runs"], section[data-testid="needs-you"]').evaluateAll(els => els.map(el => el.getAttribute('data-testid')))
  expect(order.filter(id => ['needs-you', 'running-runs', 'today-runs', 'paused-runs', 'recent-runs'].includes(id ?? ''))).toEqual(['needs-you', 'running-runs', 'today-runs', 'paused-runs', 'recent-runs'])
  await expect(page.getByTestId('home-jumps').getByRole('link')).toHaveText([/^Needs you\d+$/, /^Running\d+$/, /^Today\d+$/, /^Paused\d+$/, /^Recent\d+$/])
  const running = page.getByTestId('running-runs')
  const todayRuns = page.getByTestId('today-runs')
  const pausedRuns = page.getByTestId('paused-runs')
  await expect(row(running, 'fold-running-1')).toHaveCount(1)
  await expect(row(todayRuns, B_MIX.done1)).toHaveCount(1)
  await expect(row(pausedRuns, B_MIX.paused)).toHaveCount(1)
  await expect(row(todayRuns, B_MIX.paused)).toHaveCount(0)
  // Every needs-operator run is in exactly one state section.
  for (const runId of [B_MIX.needs, 'fold-needs-1', 'fr-needs']) {
    await expect(row(page.getByTestId('needs-you'), runId)).toHaveCount(1)
    for (const section of [running, todayRuns, pausedRuns, page.getByTestId('recent-runs')]) await expect(row(section, runId)).toHaveCount(0)
  }
  // Three Running rows whose default, newest and oldest orders all differ; the sort re-orders inside the section only.
  const three = [B_MIX.running, 'order-running-1', 'fold-running-1']
  await expect.poll(() => ownRows(running, three)).toEqual([B_MIX.running, 'order-running-1', 'fold-running-1'])
  await expect(running.locator('.ui-section-header .ui-sub')).toContainText('latest activity first')
  await sortTo(page, 'newest')
  await expect.poll(() => ownRows(running, three)).toEqual([B_MIX.running, 'fold-running-1', 'order-running-1'])
  for (const id of ['running-runs', 'today-runs', 'paused-runs', 'recent-runs']) await expect(page.getByTestId(id).locator('.ui-section-header .ui-sub')).toContainText('newest created first')
  await expect(row(pausedRuns, B_MIX.paused)).toHaveCount(1)
  await expect(row(todayRuns, B_MIX.done1)).toHaveCount(1)
  await sortTo(page, 'oldest')
  await expect.poll(() => ownRows(running, three)).toEqual(['order-running-1', 'fold-running-1', B_MIX.running])
  await expect(running.locator('.ui-section-header .ui-sub')).toContainText('oldest created first')
  await expect(page.getByTestId('home-jumps').getByRole('link')).toHaveText([/^Needs you\d+$/, /^Running\d+$/, /^Today\d+$/, /^Paused\d+$/, /^Recent\d+$/])
  await attach(page, testInfo, 'live-first')
})

test(`[scenario:run-filters] The filter bar on the feature page and the project page: status counts, Failed, Stopped at, search, Today, no match, All time over two pages and a failed page, no other request (${phase})`, async ({ page }, testInfo) => {
  test.slow()
  let failPage2 = false
  await installListsWorld(page, { page2Error: () => failPage2 })
  await page.clock.install({ time: B_CLOCK })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(workflowUrl(B_FILTER.project_id, 'filter-runs'))
  const list = runList(page)
  await expect(list.locator('li')).toHaveCount(9, { timeout: 30_000 })
  const scope = bar(page).getByTestId('run-filter-scope')
  await expect(scope).toHaveText('9 of 9 runs · Load more runs')
  // Each toggle's count, by value over the loaded page.
  const expected = { needs: 1, running: 1, paused: 1, failed: 3, succeeded: 1, override: 1, cancelled: 1 }
  for (const [id, n] of Object.entries(expected)) await expect(statusToggle(page, id)).toHaveText(new RegExp(` ${n}$`))
  const runListPath = `/api/projects/${B_FILTER.project_id}/workflows/filter-runs/runs`
  const during = await requestsDuring(page, async () => {
    await statusToggle(page, 'failed').click()
    await expect(list.locator('a[data-run-id]')).toHaveCount(3)
    for (const status of await list.locator('a[data-run-id]').evaluateAll(els => els.map(el => el.getAttribute('data-status')))) expect(status).toBe('failed')
    await expect(scope).toHaveText('3 of 9 runs · Load more runs')
    await bar(page).getByTestId('run-filter-phase').selectOption('Review')
    expect(await list.locator('a[data-run-id]').evaluateAll(els => els.map(el => el.getAttribute('data-run-id')))).toEqual(['fr-fail-review'])
    await bar(page).getByTestId('run-filter-phase').selectOption('')
    await statusToggle(page, 'failed').click()
    const search = bar(page).getByTestId('run-filter-q')
    for (const [words, ids] of [['fr-fail-verify', ['fr-fail-verify']], ['pirate', ['fr-fail-launch']], ['two blockers', ['fr-fail-review']]] as const) {
      await search.fill(words)
      expect(await list.locator('a[data-run-id]').evaluateAll(els => els.map(el => el.getAttribute('data-run-id')))).toEqual([...ids])
    }
    await search.fill('')
    await bar(page).getByTestId('run-filter-date').selectOption('today')
    expect((await list.locator('a[data-run-id]').evaluateAll(els => els.map(el => el.getAttribute('data-run-id')))).sort()).toEqual(['fr-fail-review', 'fr-needs', 'fr-ok', 'fr-running'])
    await search.fill('zzzz-no-such-run')
    await expect(page.getByTestId('run-filter-none')).toHaveText(/^No run matches\./)
    await page.getByTestId('run-filter-none').getByRole('button', { name: 'Clear filters' }).click()
    await expect(list.locator('li')).toHaveCount(9)
  })
  expect(during.filter(path => !path.startsWith(runListPath)), 'no request other than the run list').toEqual([])
  expect(during, 'a control change re-reads nothing').toEqual([])

  // "All time" reads the remaining page on request (one request), keeps the filters, and the scope then says all loaded.
  await statusToggle(page, 'failed').click()
  await bar(page).getByTestId('run-filter-phase').selectOption('Review')
  const allTime = await requestsDuring(page, async () => {
    await bar(page).getByTestId('run-filter-date').selectOption('all')
    await expect(list.locator('a[data-run-id]')).toHaveCount(2)
    expect(await list.locator('a[data-run-id]').evaluateAll(els => els.map(el => el.getAttribute('data-run-id')))).toEqual(['fr-fail-review', 'fr-old-fail-review'])
  })
  expect(allTime.filter(path => path.startsWith(runListPath))).toHaveLength(1)
  expect(allTime.filter(path => !path.startsWith(runListPath))).toEqual([])
  await expect(scope).toHaveText('2 of 11 runs, all loaded')
  // With no cursor left, "All time" again is a no-op.
  const again = await requestsDuring(page, async () => {
    await bar(page).getByTestId('run-filter-date').selectOption('any')
    await bar(page).getByTestId('run-filter-date').selectOption('all')
  })
  expect(again).toEqual([])
  await attach(page, testInfo, 'run-filters')

  // A failed second page: the error panel with Retry, the rows read stay, and the scope never says all loaded.
  failPage2 = true
  await page.goto(`${workflowUrl(B_FILTER.project_id, 'filter-runs')}?status=failed&date=all`)
  await expect(page.getByRole('alert').filter({ hasText: 'The next page of runs' })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('alert').filter({ hasText: 'The next page of runs' }).getByRole('button', { name: 'Retry' })).toBeVisible()
  await expect(list.locator('a[data-run-id]')).toHaveCount(3)
  await expect(scope).toHaveText('3 of 9 runs · Load more runs')

  // The project page: the same bar filters every feature; one without a match reads "0 of <n> runs match" and stays closed.
  await page.goto(projectUrl(B_FILTER.project_id))
  await projectRead(page)
  await expect(bar(page).getByTestId('run-filter-scope')).toHaveText('10 of 10 runs · the first 50 runs of each feature')
  await expect(bar(page).getByTestId('run-filter-date').locator('option')).toHaveText(['Any date', 'Today', '7 days', '30 days'])
  const projectRequests = await requestsDuring(page, async () => {
    await statusToggle(page, 'failed').click()
    const other = page.locator('li[data-workflow-id="filter-other"]')
    await expect(other.locator('a.lists-group-head')).toContainText('0 of 1 runs match')
    await expect(other).toHaveAttribute('data-open', 'false')
    await expect(page.locator('li[data-workflow-id="filter-runs"]')).toHaveAttribute('data-open', 'true')
    await expect(page.locator('li[data-workflow-id="filter-runs"] .dispatch-run')).toHaveCount(3)
    await expect(bar(page).getByTestId('run-filter-scope')).toHaveText('3 of 10 runs · the first 50 runs of each feature')
  })
  expect(projectRequests).toEqual([])
  await expectNoProjectPageExecutionControls(page)

  // At 390 px every control of the bar is a native button, select or input at least 44 px tall, and nothing scrolls sideways.
  await page.setViewportSize({ width: 390, height: 844 })
  for (const url of [workflowUrl(B_FILTER.project_id, 'filter-runs'), projectUrl(B_FILTER.project_id)]) {
    await page.goto(url)
    await expect(bar(page)).toBeVisible({ timeout: 30_000 })
    const controls = bar(page).locator('button, select, input')
    const tags = await bar(page).locator('[role="button"], [tabindex]:not(button):not(select):not(input)').count()
    expect(tags, 'no non-native control').toBe(0)
    for (const height of await controls.evaluateAll(els => els.filter(el => el.getClientRects().length > 0).map(el => el.getBoundingClientRect().height))) expect(height).toBeGreaterThanOrEqual(44)
    expect(await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') as number).toBeLessThanOrEqual(0)
  }
})

test(`The project page's scope line says "Reading runs…" while its lists are read, "Runs not read: <reason>" when every list fails, and names an unread feature when one fails; never "all loaded" or "0 of 0 runs" (${phase})`, async ({ page }) => {
  test.slow()
  let mode: 'hold' | 'all' | 'one' = 'hold'
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  await installListsWorld(page)
  const listPath = new RegExp(`^/api/projects/${B_FILTER.project_id}/workflows/([^/]+)/runs$`)
  await page.route(url => listPath.test(url.pathname), async route => {
    const workflowId = new URL(route.request().url()).pathname.match(listPath)![1]
    if (mode === 'hold') await held
    // A held read whose page was left has nobody to answer: it is dropped.
    try {
      if (mode === 'all' || (mode === 'one' && workflowId === 'filter-other')) {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'RUNS_UNREADABLE', message: 'The runs directory of this workflow could not be listed.' } }) })
      } else await route.fallback()
    } catch { /* the page was left */ }
  })
  await page.clock.install({ time: B_CLOCK })
  await page.setViewportSize({ width: 1440, height: 900 })
  const scope = bar(page).getByTestId('run-filter-scope')
  const neverClaimsAll = async () => {
    const text = (await scope.textContent()) ?? ''
    expect(text).not.toMatch(/all loaded/)
    expect(text).not.toMatch(/\b0 of 0 runs\b/)
  }

  // While the lists are read: the page's own "Reading runs…", never a count.
  await page.goto(projectUrl(B_FILTER.project_id))
  await expect(scope).toHaveText('Reading runs…', { timeout: 30_000 })
  await neverClaimsAll()
  mode = 'all'
  release()

  // Every list fails: the page's own "Runs not read: <reason>". The wait reads the scope line, since the read never settles.
  await page.goto(projectUrl(B_FILTER.project_id))
  await expect(scope).toHaveText(/^Runs not read: .+/, { timeout: 30_000 })
  await expect(page.getByTestId('dispatch-needs-failed')).toBeVisible()
  await neverClaimsAll()

  // One list fails and the other is read: "<k> of <n> runs · 1 feature cannot be read", n counting the runs read.
  mode = 'one'
  await page.goto(projectUrl(B_FILTER.project_id))
  // The unread feature and the cut: the readable feature has a next page, so the line says it read each feature's first 50 runs only.
  await expect(scope).toHaveText(`${B_FILTER.workflows[0].runs.length} of ${B_FILTER.workflows[0].runs.length} runs · 1 feature cannot be read · the first 50 runs of each feature`, { timeout: 30_000 })
  await neverClaimsAll()
  await statusToggle(page, 'failed').click()
  await expect(scope).toHaveText(`3 of ${B_FILTER.workflows[0].runs.length} runs · 1 feature cannot be read · the first 50 runs of each feature`)
  await neverClaimsAll()
})

test(`[scenario:triage-filters] Triage's one bar filters every section before sectioning; counts read "<k> of <n>", the quiet line, title, rail and Pinned stay; Recent keeps grouping and Show older only (${phase})`, async ({ page }, testInfo) => {
  test.slow()
  await installListsWorld(page)
  await page.clock.install({ time: B_CLOCK })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(triageUrl)
  const needs = page.getByTestId('needs-you')
  await expect(needs.locator('.ui-section-header h2')).toHaveText(/^Needs you · \d+$/, { timeout: 30_000 })
  // One bar, above Needs you; Recent has no search box, status pills or Today choice of its own.
  await expect(bar(page)).toHaveCount(1)
  expect(await page.evaluate("Boolean(document.querySelector('[data-testid=\"run-filter\"]').compareDocumentPosition(document.querySelector('[data-testid=\"needs-you\"]')) & Node.DOCUMENT_POSITION_FOLLOWING)")).toBe(true)
  const recent = page.getByTestId('recent-runs')
  await expect(recent.locator('input')).toHaveCount(0)
  await expect(recent.getByRole('button', { name: /^(All|Failed|Succeeded|Today)( \d+)?$/ })).toHaveCount(0)
  await expect(recent.getByRole('button', { name: 'Group by project' })).toHaveCount(1)
  await expect(page.locator('input[type="search"]')).toHaveCount(1)
  await expect(page.locator('button[data-filter="failed"]')).toHaveCount(1)
  // Stage C adds "All time" (the registry's pages, read only when chosen); the other three stay.
  await expect(bar(page).getByTestId('run-filter-date').locator('option')).toHaveText(['Any date', 'Today', '7 days', 'All time'])
  const scope = bar(page).getByTestId('run-filter-scope')
  await expect(scope).toHaveText(/^(\d+) of \1 runs · runs updated in the last 7 days and the 50 most recently updated runs of each feature$/)
  const title = await page.title()
  const badge = await page.getByTestId('rail-triage').textContent()
  const pinnedBefore = await page.getByTestId('pinned-runs').count()

  const sections = ['needs-you', 'running-runs', 'today-runs', 'paused-runs', 'recent-runs']
  const requests = await requestsDuring(page, async () => {
    await statusToggle(page, 'failed').click()
    // Failed leaves failed runs only, in Today and Recent; Needs you, Running and Paused say no run matches.
    // "No run matches." is said once, by the section's body; its sub keeps the order words.
    for (const id of ['needs-you', 'running-runs', 'paused-runs']) {
      await expect(page.getByTestId(id).locator('.ui-section-header .ui-sub')).not.toHaveText('No run matches.')
      await expect(page.getByTestId(id).getByTestId('run-filter-none')).toHaveText(/^No run matches\./)
    }
    for (const id of ['today-runs', 'recent-runs']) {
      for (const status of await page.getByTestId(id).locator('a[data-run-id]').evaluateAll(els => els.map(el => el.getAttribute('data-status')))) expect(status).toBe('failed')
    }
    await expect(row(page.getByTestId('today-runs'), B_MIX.done1)).toHaveCount(1)
    for (const id of sections) await expect(page.getByTestId(id).locator('.ui-section-header h2')).toHaveText(/ · \d+ of \d+$/)
    await expect(page.getByTestId('home-quiet')).toHaveCount(0)
    await expect(scope).toHaveText(/^\d+ of \d+ runs · runs updated in the last 7 days and the 50 most recently updated runs of each feature$/)
    // One li per run across the state sections while filtered.
    const ids = await page.locator(sections.map(id => `[data-testid="${id}"] a[data-run-id]`).join(', ')).evaluateAll(els => els.map(el => el.getAttribute('data-run-id')))
    expect(new Set(ids).size).toBe(ids.length)
    await statusToggle(page, 'failed').click()
    // The search finds a seeded run by id in whichever section holds it.
    await bar(page).getByTestId('run-filter-q').fill('fold-running-1')
    await expect(row(page.getByTestId('running-runs'), 'fold-running-1')).toHaveCount(1)
    await expect(page.locator(sections.map(id => `[data-testid="${id}"] a[data-run-id]`).join(', '))).toHaveCount(1)
  })
  expect(requests, 'a Triage control change requests nothing').toEqual([])
  expect(await page.title()).toBe(title)
  expect(await page.getByTestId('rail-triage').textContent()).toBe(badge)
  await expect(page.getByTestId('pinned-runs')).toHaveCount(pinnedBefore)
  await attach(page, testInfo, 'triage-filters')
  // Clearing the bar restores every section's rows.
  await bar(page).getByTestId('run-filter-clear').click()
  await expect(scope).toHaveText(/^(\d+) of \1 runs · /)
  await expect(row(page.getByTestId('today-runs'), B_MIX.done1)).toHaveCount(1)
  await expect(row(page.getByTestId('needs-you'), B_MIX.needs)).toHaveCount(1)
  await expect(recent.getByRole('button', { name: /^Show older/ }).or(recent.locator('a[data-run-id]').first())).not.toHaveCount(0)
})

test(`[scenario:project-collapsed] The project page folds its features into dated header rows with Show runs; dated run rows; one definition fold per revision; a one-line GitHub column without a remote (${phase})`, async ({ page }, testInfo) => {
  test.slow()
  await installListsWorld(page)
  await page.clock.setFixedTime(B_CLOCK)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(projectUrl(B_FOLD.project_id))
  await projectRead(page)
  const items = page.getByTestId('dispatch-features').locator('li[data-workflow-id]')
  await expect(items).toHaveCount(B_FOLD.workflows.length)
  for (const workflow of B_FOLD.workflows) {
    const item = page.locator(`li[data-workflow-id="${workflow.workflow_id}"]`)
    const head = item.locator('a.lists-group-head')
    await expect(head).toHaveCount(1)
    await expect(head).toHaveClass(/\btone-/)
    await expect(head).toContainText(workflow.workflow_id)
    const toggle = item.getByTestId('dispatch-feature-toggle')
    await expect(toggle).toHaveCount(1)
    await expect(head.locator('button')).toHaveCount(0)
    expect(await toggle.evaluate(el => el.closest('a') === null)).toBe(true)
    await expect(toggle).toHaveAttribute('aria-controls', /\S/)
    if (!workflow.unreadable) await expect(head.getByTestId('dispatch-feature-last')).toHaveText(/^last activity (today|[A-Z][a-z]{2} \d{1,2})$/)
  }
  await expect(page.locator('li[data-workflow-id="fold-needs"] [data-testid="dispatch-feature-word"]')).toHaveText('needs you')
  await expect(page.locator('li[data-workflow-id="fold-running"] [data-testid="dispatch-feature-word"]')).toHaveText('running')
  for (const id of ['fold-needs', 'fold-running', 'fold-broken']) await expect(page.locator(`li[data-workflow-id="${id}"] [data-testid="dispatch-feature-toggle"]`)).toHaveAttribute('aria-expanded', 'true')
  for (const id of ['fold-done', 'fold-paused', 'fold-old', 'fold-cancelled']) await expect(page.locator(`li[data-workflow-id="${id}"] [data-testid="dispatch-feature-toggle"]`)).toHaveAttribute('aria-expanded', 'false')
  // At least six feature header rows inside the first screen.
  const inView = await items.locator('a.lists-group-head').evaluateAll((els, height) => els.filter(el => el.getBoundingClientRect().bottom <= height).length, 900)
  expect(inView, 'six feature headers in the first screen').toBeGreaterThanOrEqual(6)
  // Show runs opens a feature whose rows are dated; a paused row reads its stopped words.
  const done = page.locator('li[data-workflow-id="fold-done"]')
  await done.getByRole('button', { name: 'Show runs' }).click()
  await expect(done.getByTestId('dispatch-feature-toggle')).toHaveAttribute('aria-expanded', 'true')
  await expect(done.getByTestId('dispatch-feature-toggle')).toHaveText('Hide runs')
  await expect(done.locator('.dispatch-run[data-run-id="fold-done-1"] [data-testid="dispatch-run-when"]')).toHaveText('started Oct 9 · ran 1h05m')
  const paused = page.locator('li[data-workflow-id="fold-paused"]')
  await paused.getByRole('button', { name: 'Show runs' }).click()
  await expect(paused.locator('[data-testid="dispatch-run-when"]')).toHaveText('paused 10 d (since Oct 3)')
  await expect(page.locator('li[data-workflow-id="fold-running"] [data-testid="dispatch-run-when"]')).toHaveText(/^started Oct 11 · running \S+/)
  // Definition folds: once per distinct revision, above the chart, inside no feature; opened, each lists its steps.
  const folds = page.getByTestId('dispatch-defs').getByTestId('dispatch-def')
  const revisions = await folds.evaluateAll(els => els.map(el => el.getAttribute('data-revision')))
  expect(new Set(revisions).size).toBe(revisions.length)
  await expect(page.getByTestId('dispatch-features').getByTestId('dispatch-def')).toHaveCount(0)
  await folds.first().locator('summary').click()
  await expect(folds.first().locator('.dispatch-def-list li')).toHaveCount(bDefinition(B_FOLD.project_id, B_FOLD.workflows[0].workflow_id).nodes.length)
  // No GitHub remote: the GitHub column is one line, and the chart takes the width a 380 px column would hold.
  const github = page.getByTestId('dispatch-github')
  // Measured once the overview read settled (until then the column holds its reading state); the bound is unchanged.
  await expect.poll(async () => (await github.boundingBox())!.height, { timeout: 30_000 }).toBeLessThanOrEqual(48)
  const chart = (await page.getByTestId('dispatch-chart').boundingBox())!.width
  const body = (await page.locator('.dispatch-project-body').boundingBox())!.width
  expect(chart, 'the chart is wider than beside a 380 px column').toBeGreaterThan(body - 380 - 16)
  expect(await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') as number).toBeLessThanOrEqual(0)
  await expectNoProjectPageExecutionControls(page)
  await attach(page, testInfo, 'project-collapsed')
  // The header link opens the feature page.
  await page.locator('li[data-workflow-id="fold-done"] a.lists-group-head').click()
  await expect(page).toHaveURL(new RegExp(`/projects/${B_FOLD.project_id}/workflows/fold-done$`))
})

test(`[scenario:list-state-url] A list's search, toggles, grouping, sort and pages live in the URL (replaceState), survive opening a run and Back with the scroll restored, and a reload; malformed values read as defaults; the graph's URL stays bare (${phase})`, async ({ page }, testInfo) => {
  test.slow()
  await installListsWorld(page)
  await page.clock.setFixedTime(B_CLOCK)
  await page.setViewportSize({ width: 1440, height: 700 })
  await page.goto(triageUrl)
  await expect(page.getByTestId('needs-you').locator('.ui-section-header h2')).toHaveText(/^Needs you · \d+$/, { timeout: 30_000 })
  const length = await page.evaluate<number>('history.length')
  await bar(page).getByTestId('run-filter-q').fill('fr-fail')
  await statusToggle(page, 'failed').click()
  await page.getByTestId('recent-runs').getByRole('button', { name: 'Group by project' }).click()
  await expect(page).toHaveURL(/\?q=fr-fail&status=failed&group=project$/)
  expect(await page.evaluate<number>('history.length')).toBe(length)
  await page.evaluate('window.scrollTo(0, 240)')
  const scrolled = await page.evaluate<number>('window.scrollY')
  await row(page.getByTestId('recent-runs'), 'fr-fail-verify').click()
  await expect(page).toHaveURL(new RegExp(`/runs/fr-fail-verify$`))
  await page.goBack()
  await expect(page).toHaveURL(/\?q=fr-fail&status=failed&group=project$/)
  await expect(bar(page).getByTestId('run-filter-q')).toHaveValue('fr-fail')
  await expect(statusToggle(page, 'failed')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('recent-runs').getByRole('button', { name: 'Group by project' })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => page.evaluate<number>('window.scrollY'), { timeout: 10_000 }).toBeGreaterThanOrEqual(scrolled - 2)
  expect(Math.abs(await page.evaluate<number>('window.scrollY') - scrolled)).toBeLessThanOrEqual(2)
  await page.reload()
  await expect(bar(page).getByTestId('run-filter-q')).toHaveValue('fr-fail', { timeout: 30_000 })
  await expect(statusToggle(page, 'failed')).toHaveAttribute('aria-pressed', 'true')
  await attach(page, testInfo, 'list-state-url')

  // The project page: an opened feature and a status toggle survive opening a run and Back.
  await page.goto(projectUrl(B_FOLD.project_id))
  await projectRead(page)
  await statusToggle(page, 'cancelled').click()
  await expect(page).toHaveURL(/\?status=cancelled$/)
  const done = page.locator('li[data-workflow-id="fold-done"]')
  await done.getByRole('button', { name: 'Show runs' }).click()
  await page.locator('.dispatch-run[data-run-id="fold-cancelled-1"]').click()
  await page.getByTestId('dispatch-pane').getByRole('link', { name: /Open run page/ }).click()
  await expect(page).toHaveURL(/\/runs\/fold-cancelled-1$/)
  await page.goBack()
  await expect(page).toHaveURL(/\?status=cancelled$/)
  await expect(statusToggle(page, 'cancelled')).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 })
  await expect(done.getByTestId('dispatch-feature-toggle')).toHaveAttribute('aria-expanded', 'true')

  // The feature page: the sort and the loaded pages survive Back and a reload.
  await page.goto(workflowUrl(B_FILTER.project_id, 'filter-runs'))
  await expect(runList(page).locator('li')).toHaveCount(9, { timeout: 30_000 })
  await sortTo(page, 'newest')
  await page.getByRole('button', { name: 'Load more runs' }).click()
  await expect(runList(page).locator('li')).toHaveCount(11)
  await expect(page).toHaveURL(/\?sort=newest&pages=2$/)
  await row(runList(page), 'fr-ok').click()
  await page.goBack()
  await expect(runList(page).locator('li')).toHaveCount(11, { timeout: 30_000 })
  await expect(bar(page).getByTestId('run-filter-sort')).toHaveValue('newest')
  await page.reload()
  await expect(runList(page).locator('li')).toHaveCount(11, { timeout: 30_000 })
  await expect(bar(page).getByTestId('run-filter-sort')).toHaveValue('newest')
  await expect(bar(page).getByTestId('run-filter-scope')).toHaveText('11 of 11 runs, all loaded')
})

test(`A list URL with an unknown key or a malformed status, date, sort or pages value opens at that key's default with no error panel (${phase})`, async ({ page }) => {
  await installListsWorld(page)
  await page.clock.setFixedTime(B_CLOCK)
  for (const query of ['?foo=bar', '?status=bogus', '?date=yesterday', '?sort=random', '?pages=99', '?pages=abc']) {
    await page.goto(`${workflowUrl(B_FILTER.project_id, 'filter-runs')}${query}`)
    await expect(runList(page).locator('li')).toHaveCount(9, { timeout: 30_000 })
    await expect(bar(page).getByTestId('run-filter-sort')).toHaveValue('live')
    await expect(bar(page).getByTestId('run-filter-date')).toHaveValue('any')
    for (const id of ['failed', 'needs']) await expect(statusToggle(page, id)).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByRole('alert')).toHaveCount(0)
  }
})

// A feature run list of more pages than a URL can restore: two runs a page, each page's cursor naming the next.
const CAPPED_PAGES = 24
const cappedPage = (cursor: string | null) => {
  const n = cursor === null ? 1 : Number(cursor.replace('cap-', ''))
  const runs = [0, 1].map(i => bSummary(B_FILTER.project_id, 'filter-runs', {
    id: `cap-${String(n).padStart(2, '0')}-${i}`, status: 'succeeded', focus: null,
    created: new Date(Date.parse('2026-09-30T00:00:00Z') - (n * 2 + i) * 3_600_000).toISOString(),
    moved: new Date(Date.parse('2026-09-30T00:30:00Z') - (n * 2 + i) * 3_600_000).toISOString(),
  }))
  return { runs, next_cursor: n < CAPPED_PAGES ? `cap-${n + 1}` : null }
}
async function serveCappedPages(page: Page, cursors: string[]) {
  await installListsWorld(page)
  await page.route(url => url.pathname === `/api/projects/${B_FILTER.project_id}/workflows/filter-runs/runs`, async route => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor')
    if (cursor !== null) cursors.push(cursor)
    await route.fulfill({ json: cappedPage(cursor) })
  })
}

test(`At the restorable page count the feature page says why it stops and that All time reads on, offers no Load more and reads no further page; a reload and the copied URL show the same rows (${phase})`, async ({ page, context }) => {
  test.slow()
  const cursors: string[] = []
  await serveCappedPages(page, cursors)
  await page.clock.setFixedTime(B_CLOCK)
  const url = `${workflowUrl(B_FILTER.project_id, 'filter-runs')}?pages=20`
  await page.goto(url)
  await expect(runList(page).locator('li')).toHaveCount(40, { timeout: 60_000 })
  await expect(page).toHaveURL(/\?pages=20$/)
  // No Load more it cannot do, in the button or the scope line: the cap is explained instead, naming All time.
  await expect(page.getByRole('button', { name: 'Load more runs' })).toHaveCount(0)
  await expect(page.getByTestId('feature-page-cap')).toHaveText('This list stops after 20 pages, the most a link can restore; choose "All time" in Date to read every older run.')
  await expect(page.getByTestId('run-filter-scope')).toHaveText('40 of 40 runs · the first 20 pages; choose All time to read on')
  await expect(page.getByTestId('run-filter-scope')).not.toContainText('Load more runs')
  await page.waitForTimeout(500)
  expect(cursors.filter(cursor => cursor === 'cap-21')).toHaveLength(0)
  await expect(runList(page).locator('li')).toHaveCount(40)
  await expect(page).toHaveURL(/\?pages=20$/)
  await page.reload()
  await expect(runList(page).locator('li')).toHaveCount(40, { timeout: 60_000 })
  await expect(page).toHaveURL(/\?pages=20$/)
  await expect(page.getByRole('button', { name: 'Load more runs' })).toHaveCount(0)
  await expect(page.getByTestId('feature-page-cap')).toBeVisible()
  expect(cursors.filter(cursor => cursor === 'cap-21')).toHaveLength(0)
  const shown = await runList(page).locator('a[data-run-id]').evaluateAll(links => links.map(link => link.getAttribute('data-run-id')))
  const copied = await context.newPage()
  if (phase === 'worker') await installProjectMocks(copied)
  await serveCappedPages(copied, cursors)
  await copied.clock.setFixedTime(B_CLOCK)
  await copied.goto(page.url())
  await expect(runList(copied).locator('li')).toHaveCount(40, { timeout: 60_000 })
  expect(await runList(copied).locator('a[data-run-id]').evaluateAll(links => links.map(link => link.getAttribute('data-run-id')))).toEqual(shown)
  expect(cursors.filter(cursor => cursor === 'cap-21')).toHaveLength(0)
  await copied.close()
})

test(`A search typed and a run opened at once: the run page's URL has no search and Back shows the search; a bare link to the list resets it (${phase})`, async ({ page }) => {
  await installListsWorld(page)
  await page.clock.setFixedTime(B_CLOCK)
  await page.goto(triageUrl)
  await expect(page.getByTestId('needs-you').locator('.ui-section-header h2')).toHaveText(/^Needs you · \d+$/, { timeout: 30_000 })
  const length = await page.evaluate<number>('history.length')
  await bar(page).getByTestId('run-filter-q').fill('fold-running-1')
  await row(page.getByTestId('running-runs'), 'fold-running-1').click()
  await expect(page).toHaveURL(/\/runs\/fold-running-1$/)
  await page.waitForTimeout(600)
  expect(new URL(page.url()).search).toBe('')
  expect(await page.evaluate<number>('history.length')).toBe(length + 1)
  await page.goBack()
  await expect(page).toHaveURL(/\?q=fold-running-1$/)
  await expect(bar(page).getByTestId('run-filter-q')).toHaveValue('fold-running-1')
  // The rail's Triage link to the list shown starts it at its defaults: the URL and the bar agree.
  await page.getByTestId('rail-triage').click()
  await expect(page).toHaveURL(/\/projects\/-\/triage$/)
  await expect(bar(page).getByTestId('run-filter-q')).toHaveValue('')
  // Show older lives in the URL too.
  const older = page.getByTestId('recent-runs').getByRole('button', { name: /^Show older/ })
  if (await older.count()) {
    await older.click()
    await expect(page).toHaveURL(/\?older=1$/)
    await page.reload()
    await expect(page.getByTestId('recent-runs').getByRole('button', { name: /^Show older/ })).toHaveCount(0, { timeout: 30_000 })
  }
})

test(`A search typed and Forward pressed at once is committed to the list's entry: Back shows it again (${phase})`, async ({ page }) => {
  await installListsWorld(page)
  await page.clock.setFixedTime(B_CLOCK)
  await page.goto(triageUrl)
  await expect(page.getByTestId('needs-you').locator('.ui-section-header h2')).toHaveText(/^Needs you · \d+$/, { timeout: 30_000 })
  await row(page.getByTestId('running-runs'), 'fold-running-1').click()
  await expect(page).toHaveURL(/\/runs\/fold-running-1$/)
  await page.goBack()
  await expect(bar(page).getByTestId('run-filter-q')).toHaveValue('')
  // The search is still debounced when the browser leaves the list.
  await bar(page).getByTestId('run-filter-q').fill('fold-running-1')
  await page.evaluate('history.forward()')
  await expect(page).toHaveURL(/\/runs\/fold-running-1$/)
  await page.goBack()
  await expect(page).toHaveURL(/\/projects\/-\/triage\?q=fold-running-1$/)
  await expect(bar(page).getByTestId('run-filter-q')).toHaveValue('fold-running-1')
})

test(`A list opened at its pathname with a trailing slash writes its filters, sort and search to the URL (${phase})`, async ({ page }) => {
  await installListsWorld(page)
  await page.clock.setFixedTime(B_CLOCK)
  await page.goto(`${triageUrl}/`)
  await expect(page.getByTestId('needs-you').locator('.ui-section-header h2')).toHaveText(/^Needs you · \d+$/, { timeout: 30_000 })
  const length = await page.evaluate<number>('history.length')
  await statusToggle(page, 'failed').click()
  await expect(page).toHaveURL(/\/projects\/-\/triage\/\?status=failed$/)
  await expect(statusToggle(page, 'failed')).toHaveAttribute('aria-pressed', 'true')
  await bar(page).getByTestId('run-filter-q').fill('fr-fail')
  await expect(page).toHaveURL(/\/projects\/-\/triage\/\?q=fr-fail&status=failed$/)
  await expect(bar(page).getByTestId('run-filter-q')).toHaveValue('fr-fail')
  expect(await page.evaluate<number>('history.length')).toBe(length)
})

test(`The graph's history keeps no search: Projects then Back leaves the graph page's URL without a search string (${phase})`, async ({ page }) => {
  await page.goto('/')
  const graphUrl = page.url()
  await page.goto(`${triageUrl}?q=x`)
  await expect(bar(page).getByTestId('run-filter-q')).toHaveValue('x', { timeout: 30_000 })
  await page.goBack()
  await expect(page).toHaveURL(graphUrl)
  expect(new URL(page.url()).search).toBe('')
  await page.goto('/')
  await page.getByRole('link', { name: 'Projects', exact: true }).first().click()
  await expect(page).toHaveURL(/\/projects$/)
  await page.goBack()
  expect(new URL(page.url()).search).toBe('')
})

test(`The pin toggle's visible words are part of its name, and beside a row at 1440 px it is a compact control on the row's first line (${phase})`, async ({ page }) => {
  await page.clock.setFixedTime(REVAMP_NOW)
  await page.setViewportSize({ width: 1440, height: 900 })
  for (const url of [triageUrl, workflowUrl(PROJECT.project_id, UX_REVAMP_LISTS_WORKFLOW_ID)]) {
    await page.goto(url)
    const toggle = page.locator('.run-row-item > .pin-toggle').first()
    await expect(toggle).toBeVisible({ timeout: 30_000 })
    for (const item of await page.locator('.pin-toggle').all()) {
      const visible = (await item.innerText()).replace(/[☆★]/g, '').trim()
      const name = (await item.getAttribute('aria-label')) ?? ''
      expect(name, 'the visible words are in the name').toContain(visible)
      expect(name).toMatch(/^(Add to Triage|In Triage), \S+$/)
    }
    const sizes = await toggle.evaluate(el => ({
      toggle: el.getBoundingClientRect().height,
      line: el.parentElement!.querySelector('.run-row .run-row-head')!.getBoundingClientRect().height,
    }))
    expect(sizes.toggle, 'no taller than the row link\'s first line plus 8 px').toBeLessThanOrEqual(sizes.line + 8)
    // No border taller than the link text: the toggle's border is transparent beside a row.
    expect(await toggle.evaluate(el => el.ownerDocument.defaultView!.getComputedStyle(el).borderTopColor)).toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
  }
})

test(`The compact Triage chip at 900 px counts what needs the operator, equal to the Needs-you heading and the tab title, and a paused-only run never moves it (${phase})`, async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 })
  const read = async () => {
    await page.goto(triageUrl)
    const heading = page.getByTestId('needs-you').locator('.ui-section-header h2')
    await expect(heading).toHaveText(/^Needs you · \d+$/, { timeout: 30_000 })
    await expect(page.getByTestId('chip-triage')).not.toContainText('…')
    const needs = Number((await heading.innerText()).replace(/\D/g, ''))
    const chip = Number(/Triage · (\d+)/.exec(await page.getByTestId('chip-triage').innerText())![1])
    const title = needs > 0 ? Number(/^\((\d+)\)/.exec(await page.title())![1]) : 0
    return { needs, chip, title }
  }
  const before = await read()
  expect(before.chip).toBe(before.needs)
  expect(before.title).toBe(before.needs)
  // A paused-only run added to a project's run list does not move the chip's number.
  await editHomeRows(page, (runs, url) => {
    if (url.pathname !== `/api/projects/${PROJECT.project_id}/workflows/${UX_REVAMP_LISTS_WORKFLOW_ID}/runs`) return runs
    const extra = bSummary(PROJECT.project_id, UX_REVAMP_LISTS_WORKFLOW_ID, { id: 'zz-paused-only', status: 'paused', created: '2030-01-01T00:00:00Z', moved: '2030-01-01T00:00:00Z', focus: 'review', attention: { kind: 'paused', node_id: 'review', since: '2030-01-01T00:00:00Z' } })
    return [{ ...extra, definition_revision: runs[0]?.definition_revision ?? extra.definition_revision }, ...runs]
  })
  const after = await read()
  expect(after.chip).toBe(after.needs)
  expect(after.title).toBe(after.needs)
  await expect(page.getByTestId('chip-triage')).toContainText('paused')
})

test(`The read-only check exempts exactly the bar's Cancelled toggle and its phase select: any other control with an execution word still fails it (${phase})`, async ({ page }) => {
  await installListsWorld(page)
  await page.clock.setFixedTime(B_CLOCK)
  await page.goto(triageUrl)
  await expect(bar(page)).toBeVisible({ timeout: 30_000 })
  // The phase select's options are exactly "Any step" and the phases in order, the Cancelled toggle reads "Cancelled <n>".
  await expect(bar(page).getByTestId('run-filter-phase').locator('option')).toHaveText(PHASE_OPTIONS)
  await expect(statusToggle(page, 'cancelled')).toHaveText(/^Cancelled \d+$/)
  const controls = () => workspace(page).locator('button:not([data-graph-node]):not([data-go]):not([data-testid="live-dock-bar"]), input, select, textarea, [role="menuitem"]').filter({ hasText: EXECUTION_WORDS })
  expect(await executionControlCount(controls())).toBe(0)
  // Another bar button and another bar select with an execution word are counted.
  await page.evaluate(`(() => {
    const barRoot = document.querySelector('[data-testid="run-filter"]')
    const button = document.createElement('button'); button.textContent = 'Retry'; barRoot.appendChild(button)
    const select = document.createElement('select'); select.innerHTML = '<option>Launch</option><option>Integrate</option>'; barRoot.appendChild(select)
    const toggle = barRoot.querySelector('button[data-filter="cancelled"]').cloneNode(true); toggle.textContent = 'Cancel run'; barRoot.appendChild(toggle)
  })()`)
  expect(await executionControlCount(controls())).toBe(3)
  // The project page's scoped check counts a Show runs button that carries an execution word.
  await page.goto(projectUrl(B_FOLD.project_id))
  await projectRead(page)
  await expectNoProjectPageExecutionControls(page)
  await page.evaluate(`document.querySelector('[data-testid="dispatch-feature-toggle"]').textContent = 'Retry runs'`)
  const scoped = workspace(page).locator('[data-testid="run-filter"] button, [data-testid="run-filter"] input, [data-testid="run-filter"] select, button[data-testid="dispatch-feature-toggle"]').filter({ hasText: EXECUTION_WORDS })
  expect(await executionControlCount(scoped)).toBe(1)
})

test(`Triage's opened superseded fold comes back open after opening a run and going Back, and a reload starts it closed (${phase})`, async ({ page }) => {
  await page.clock.setFixedTime(REVAMP_NOW)
  await page.goto(triageUrl)
  const fold = page.getByTestId('superseded-runs')
  await expect(fold).toBeVisible({ timeout: 30_000 })
  await expect(fold).not.toHaveAttribute('open', '')
  await fold.locator('summary').click()
  await expect(fold).toHaveAttribute('open', '')
  await row(fold, RUN_DESK_STALE).click()
  await expect(page).toHaveURL(new RegExp(`/runs/${RUN_DESK_STALE}$`))
  await page.goBack()
  await expect(page.getByTestId('superseded-runs')).toHaveAttribute('open', '', { timeout: 30_000 })
  await page.reload()
  await expect(page.getByTestId('superseded-runs')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('superseded-runs')).not.toHaveAttribute('open', '')
})

// ---- ux-critique-fixes stage C, lane `server` (features/ux-critique-fixes-c/prd.md 7.1, 7.9) ---------------------------------

type Seen = { path: string; search: URLSearchParams; at: number }
/** Every API request the page makes, by path and query, in order. */
function apiRequests(page: Page): Seen[] {
  const seen: Seen[] = []
  page.on('request', request => {
    const parsed = new URL(request.url())
    if (parsed.pathname.startsWith('/api/')) seen.push({ path: parsed.pathname, search: parsed.searchParams, at: Date.now() })
  })
  return seen
}
const homeReads = (seen: Seen[]) => seen.filter(item => item.path === '/api/dispatch/runs')
const overviewReads = (seen: Seen[]) => seen.filter(item => item.path === '/api/dispatch/projects')
const workflowLists = (seen: Seen[]) => seen.filter(item => /^\/api\/projects\/[^/]+\/workflows$/.test(item.path))
const runListReads = (seen: Seen[]) => seen.filter(item => /^\/api\/projects\/[^/]+\/workflows\/[^/]+\/runs$/.test(item.path))
const registryReads = (seen: Seen[]) => seen.filter(item => item.path === '/api/dispatch/runs/all')
/** Advances the page clock by `ms` and lets the reads it started answer. */
async function advance(page: Page, ms: number) {
  await page.clock.runFor(ms)
  await page.waitForTimeout(400)
}
/** Stops the page clock where it is, so only `advance` fires timers: a count over a window never catches a tick of real time. */
async function pauseClock(page: Page) {
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000)
}

test(`[scenario:one-request] The rail, the cards and Triage read every run list in one request per poll; the project page reads only its own features (${phase})`, async ({ page }, testInfo) => {
  test.slow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.clock.install({ time: REVAMP_NOW })
  const seen = apiRequests(page)
  for (const target of [triageUrl, projectsUrl]) {
    await page.goto(target)
    if (target === triageUrl) await expect(page.getByTestId('needs-you').locator(`a[data-run-id="${RUN_DECIDE}"]`)).toHaveCount(1, { timeout: 30_000 })
    else await expect(page.getByTestId('dispatch-cards')).toBeVisible({ timeout: 30_000 })
    await expect(railRow(page, DISPATCH_NOORIGIN).locator('.dispatch-rail-badge')).toHaveText(`${NOORIGIN_NEEDS.length} waits on you`, { timeout: 30_000 })
    // The cold open: home reads with a since parameter (the dev build's strict mode may start and abort one), no per-project
    // or per-workflow read.
    expect(homeReads(seen).length, `${target}: a home read`).toBeGreaterThanOrEqual(1)
    for (const read of homeReads(seen)) expect(read.search.get('since')).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/)
    expect(workflowLists(seen)).toEqual([])
    expect(runListReads(seen)).toEqual([])
    // Across one poll interval (15 s: the seeds hold running and waiting runs): one home read, one overview read, nothing else.
    await pauseClock(page)
    seen.length = 0
    await advance(page, 15_000)
    expect(homeReads(seen).length, `${target}: one home read per poll`).toBe(1)
    expect(homeReads(seen)[0].search.has('since')).toBe(true)
    expect(overviewReads(seen).length).toBe(1)
    expect(workflowLists(seen)).toEqual([])
    expect(runListReads(seen)).toEqual([])
    await page.clock.resume()
    seen.length = 0
  }
  // Triage's sections and the rail's badges on the new source, by value, as stage A's scenarios assert them.
  await page.goto(triageUrl)
  const needs = page.getByTestId('needs-you')
  for (const runId of NOORIGIN_NEEDS) await expect(needs.locator(`a[data-run-id="${runId}"]`)).toHaveCount(1, { timeout: 30_000 })
  const cards = await needs.locator(':scope > ul > li').count()
  await expect(needs.locator('.ui-section-header h2')).toHaveText(`Needs you · ${cards}`)
  await expect(page).toHaveTitle(new RegExp(`^\\(${cards}\\) `))
  await expect(railRow(page, DISPATCH_WIDGETS_WT).locator('.dispatch-rail-badge')).toHaveText('1 paused')
  // While a poll is in flight the rows stay on screen and no reading wording returns.
  let release = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  const hold = async (route: Route) => { await held; await route.fallback().catch(() => undefined) }
  await page.route(isHomeRuns, hold)
  await pauseClock(page)
  seen.length = 0
  await advance(page, 15_000)
  expect(homeReads(seen).length).toBe(1)
  await expect(needs.locator(`a[data-run-id="${RUN_DECIDE}"]`)).toHaveCount(1)
  await expect(page.getByText('Loading the runs of every project…')).toHaveCount(0)
  for (const sub of await page.getByTestId('dispatch-rail-list').locator('.dispatch-rail-sub').allInnerTexts()) expect(sub).not.toMatch(/reading…$/)
  await attach(page, testInfo, 'one-request')
  release()
  await page.unroute(isHomeRuns, hold)
  await page.clock.resume()

  // A project page: its own features' first pages only, never another project's runs or a later page.
  seen.length = 0
  await page.goto(projectUrl(DISPATCH_NOORIGIN))
  await expect(page.getByTestId('dispatch-features')).toBeVisible({ timeout: 30_000 })
  await advance(page, 15_000)
  const lists = runListReads(seen)
  expect(lists.length).toBeGreaterThan(0)
  for (const read of lists) {
    expect(read.path).toMatch(new RegExp(`^/api/projects/${DISPATCH_NOORIGIN}/workflows/[^/]+/runs$`))
    expect(read.search.has('cursor'), 'only first pages').toBe(false)
  }
})

test(`The home read with nothing running or waiting polls every 60 s, never at 15 s, and a running run brings 15 s back; the live status never says "Not updating" between on-time polls (${phase})`, async ({ page }) => {
  test.slow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.clock.install({ time: REVAMP_NOW })
  let running = false
  // Nothing running or waiting in every list; then, once told, one run of this module's workflow is running again.
  await editHomeRows(page, (runs, url) => {
    const quiet = quietRuns(runs)
    if (!running || url.pathname !== `/api/projects/${PROJECT.project_id}/workflows/${UX_REVAMP_LISTS_WORKFLOW_ID}/runs`) return quiet
    const live = runs.find(run => run.run_id === RUN_DESK_LIVE)!
    return [live, ...quiet]
  })
  const seen = apiRequests(page)
  await page.goto(triageUrl)
  await expect(page.getByTestId('home-quiet')).toBeVisible({ timeout: 30_000 })
  // The cadence restarts at 60 s when the first read finds nothing running: the clock stops there, and only `advance` moves it.
  await pauseClock(page)
  seen.length = 0
  await advance(page, 15_000)
  expect(homeReads(seen), 'no read at 15 s while nothing runs').toEqual([])
  await advance(page, 15_000)
  await advance(page, 15_000)
  expect(homeReads(seen)).toEqual([])
  await expect(page.getByTestId('live-status')).not.toHaveAttribute('data-state', 'stale')
  await expect(page.getByTestId('live-status')).not.toContainText('Not updating')
  running = true
  await advance(page, 15_000)
  expect(homeReads(seen).length, 'the read 60 s after the last').toBe(1)
  expect(overviewReads(seen).length).toBe(1)
  await expect(page.getByTestId('running-runs').locator(`a[data-run-id="${RUN_DESK_LIVE}"]`)).toHaveCount(1, { timeout: 15_000 })
  await expect(page.getByTestId('live-status')).not.toContainText('Not updating')
  // A run that runs again: the next read comes 15 s later.
  seen.length = 0
  await advance(page, 15_000)
  expect(homeReads(seen).length, 'back to 15 s').toBe(1)
})

test(`A home read answered with an error keeps the last rows and says the runs were not read, with the reason (${phase})`, async ({ page }) => {
  test.slow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.clock.install({ time: REVAMP_NOW })
  await page.goto(triageUrl)
  const decide = page.getByTestId('needs-you').locator(`a[data-run-id="${RUN_DECIDE}"]`)
  await expect(decide).toHaveCount(1, { timeout: 30_000 })
  await page.route(isHomeRuns, route => route.fulfill({ status: 503, json: { error: { code: 'RUNS_UNREADABLE', message: 'The registry could not be read' } } }))
  await pauseClock(page)
  await advance(page, 15_000)
  await expect(page.getByTestId('home-not-read')).toHaveText('Runs not read: The registry could not be read (RUNS_UNREADABLE, HTTP 503) · showing the runs read before', { timeout: 15_000 })
  await expect(decide).toHaveCount(1)
  await expect(page.getByTestId('home-quiet')).toHaveCount(0)
})

// ---- Triage "All time" ------------------------------------------------------------------------------------------------------

const OLD = (id: string, status: RunSummary['status'], moved: string, extra: Partial<Parameters<typeof bSummary>[2]> = {}) =>
  bSummary(PROJECT.project_id, UX_REVAMP_LISTS_WORKFLOW_ID, { id, status, created: moved, moved, focus: status === 'succeeded' ? null : 'review', feature: 'Old work', ...extra })
/** Two registry pages: the first holds a run the home read also holds and two old finished runs, the second an old one and a workflow it could not read. */
const OLD_FAILED = 'zz-old-failed'
const OLD_SUCCEEDED = 'zz-old-succeeded'
const OLD_CANCELLED = 'zz-old-cancelled'
const ALL_PAGES = (home: RunSummary) => ({
  first: { contract_version: '1.0.0', read_at: REVAMP_NOW, runs: [home, OLD(OLD_FAILED, 'failed', '2026-01-02T10:00:00Z'), OLD(OLD_SUCCEEDED, 'succeeded', '2026-01-01T10:00:00Z')], next_cursor: 'page-2', unreadable: [] },
  second: { contract_version: '1.0.0', read_at: REVAMP_NOW, runs: [OLD(OLD_CANCELLED, 'cancelled', '2025-12-01T10:00:00Z')], next_cursor: null, unreadable: [{ project_id: PROJECT.project_id, workflow_id: 'zz-gone', code: 'RUNS_UNREADABLE' }] },
})

/**
 * Serves the two pages by cursor; `failSecond` answers the second page 500 while it returns true; `holdSecond` delays it. The run
 * both reads hold is this module's newest, taken from the home read the page made (so no extra request is made for it).
 */
async function serveRegistryPages(page: Page, options: { failSecond?: () => boolean; holdSecond?: Promise<void> } = {}) {
  const cursors: (string | null)[] = []
  let home: RunSummary | null = null
  page.on('response', response => {
    if (!isHomeRuns(new URL(response.url())) || response.status() !== 200) return
    void response.json().then((body: { projects: { project_id: string; runs: HomeEntry[] }[] }) => {
      const entry = body.projects.find(project => project.project_id === PROJECT.project_id)?.runs.find(item => item.workflow_id === UX_REVAMP_LISTS_WORKFLOW_ID)
      if (entry?.runs[0]) home = entry.runs[0]
    }).catch(() => undefined)
  })
  await page.route(isRegistryPages, async route => {
    try {
      const cursor = new URL(route.request().url()).searchParams.get('cursor')
      cursors.push(cursor)
      for (let wait = 0; home === null && wait < 100; wait++) await new Promise(resolve => setTimeout(resolve, 100))
      const pages = ALL_PAGES(home!)
      if (cursor === null) { await route.fulfill({ json: pages.first }); return }
      if (options.holdSecond) await options.holdSecond
      if (options.failSecond?.()) { await route.fulfill({ status: 500, json: { error: { code: 'INTERNAL', message: 'The next page could not be read' } } }); return }
      await route.fulfill({ json: pages.second })
    } catch { /* the test ended */ }
  })
  return cursors
}
const allRuns = (page: Page) => page.getByTestId('all-runs')
const allIds = (page: Page) => allRuns(page).locator('a[data-run-id]').evaluateAll(links => links.map(link => link.getAttribute('data-run-id')))
const dateSelect = (page: Page) => bar(page).getByTestId('run-filter-date')

test(`[scenario:triage-all-time] Triage's "All time" reads the registry's pages and lists every run once in one All runs list, filtered by the bar, with an honest scope line; leaving it restores the sections (${phase})`, async ({ page }, testInfo) => {
  test.slow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.clock.setFixedTime(REVAMP_NOW)
  let release = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  const cursors = await serveRegistryPages(page, { holdSecond: held })
  const seen = apiRequests(page)
  await page.goto(triageUrl)
  const needs = page.getByTestId('needs-you')
  await expect(needs.locator('.ui-section-header h2')).toHaveText(/^Needs you · \d+$/, { timeout: 30_000 })
  await expect(dateSelect(page).locator('option')).toHaveText(['Any date', 'Today', '7 days', 'All time'])
  // The old runs are in no section before.
  for (const runId of [OLD_FAILED, OLD_SUCCEEDED, OLD_CANCELLED]) await expect(page.locator(`a[data-run-id="${runId}"]`)).toHaveCount(0)
  const title = await page.title()
  const railBadge = await page.getByTestId('rail-triage').textContent()
  const pinned = await page.getByTestId('pinned-runs').count()
  seen.length = 0
  await dateSelect(page).selectOption('all')
  await expect(page).toHaveURL(/[?&]date=all\b/)
  // While the second page reads: the reading line with the runs read so far.
  await expect(bar(page).getByTestId('run-filter-reading')).toHaveText(/^ · Reading older runs… \(\d+ read\)$/, { timeout: 15_000 })
  release()
  await expect(bar(page).getByTestId('run-filter-reading')).toHaveCount(0, { timeout: 15_000 })
  // One request per page and no other read.
  expect(cursors).toEqual([null, 'page-2'])
  expect(registryReads(seen).length).toBe(2)
  expect(workflowLists(seen)).toEqual([])
  expect(runListReads(seen)).toEqual([])
  // One All runs list replaces the state sections; Pinned stays above it.
  await expect(allRuns(page)).toBeVisible()
  for (const id of STATE_SECTIONS) await expect(page.getByTestId(id)).toHaveCount(0)
  const ids = await allIds(page)
  expect(new Set(ids).size, 'every run once').toBe(ids.length)
  for (const runId of [OLD_FAILED, OLD_SUCCEEDED, OLD_CANCELLED, RUN_DECIDE, RUN_DESK_LIVE]) expect(ids).toContain(runId)
  // The default order: what waits first, then what runs, then the rest.
  const ranks = await allRuns(page).locator('a[data-run-id]').evaluateAll(links => links.map(link => (link.getAttribute('data-attention') ? 0 : link.getAttribute('data-status') === 'running' ? 1 : 2)))
  expect(ranks, 'needs you and running first').toEqual([...ranks].sort((a, b) => a - b))
  const scope = bar(page).getByTestId('run-filter-scope')
  await expect(scope).toHaveText(`${ids.length} of ${ids.length} runs · every project, all loaded`)
  if (pinned > 0) expect(await page.evaluate("Boolean(document.querySelector('[data-testid=\"pinned-runs\"]').compareDocumentPosition(document.querySelector('[data-testid=\"all-runs\"]')) & Node.DOCUMENT_POSITION_FOLLOWING)")).toBe(true)
  // The tab title, the rail badge and Pinned do not change with the choice.
  expect(await page.title()).toBe(title)
  expect(await page.getByTestId('rail-triage').textContent()).toBe(railBadge)
  await expect(page.getByTestId('pinned-runs')).toHaveCount(pinned)
  // The unreadable workflow a page listed is named in Attention.
  await expect(page.getByTestId('lists-errors').locator('li', { hasText: `${PROJECT.name} · zz-gone` })).toContainText('RUNS_UNREADABLE')
  await attach(page, testInfo, 'triage-all-time')

  // The bar filters the list: status, stopped-at and text.
  await statusToggle(page, 'failed').click()
  for (const status of await allRuns(page).locator('a[data-run-id]').evaluateAll(links => links.map(link => link.getAttribute('data-status')))) expect(status).toBe('failed')
  expect(await allIds(page)).toContain(OLD_FAILED)
  const failedCount = (await allIds(page)).length
  await expect(scope).toHaveText(`${failedCount} of ${ids.length} runs · every project, all loaded`)
  await statusToggle(page, 'failed').click()
  await bar(page).getByTestId('run-filter-phase').selectOption('Review')
  expect((await allIds(page)).length).toBeLessThan(ids.length)
  expect(await allIds(page)).toContain(OLD_CANCELLED)
  await bar(page).getByTestId('run-filter-phase').selectOption('')
  await bar(page).getByTestId('run-filter-q').fill(OLD_SUCCEEDED)
  await expect(allRuns(page).locator('a[data-run-id]')).toHaveCount(1)
  await expect(allRuns(page).locator(`a[data-run-id="${OLD_SUCCEEDED}"]`)).toHaveCount(1)
  await expect(scope).toHaveText(`1 of ${ids.length} runs · every project, all loaded`)
  await bar(page).getByTestId('run-filter-q').fill('')
  await expect(allRuns(page).locator('a[data-run-id]')).toHaveCount(ids.length)

  // date=all survives opening a run and Back, and a reload reads the pages again.
  await allRuns(page).locator(`a[data-run-id="${RUN_DESK_LIVE}"]`).click()
  await expect(page).toHaveURL(new RegExp(`/runs/${RUN_DESK_LIVE}`))
  await page.goBack()
  await expect(page).toHaveURL(/[?&]date=all\b/)
  await expect(allRuns(page)).toBeVisible({ timeout: 30_000 })
  await page.reload()
  await expect(allRuns(page).locator(`a[data-run-id="${OLD_CANCELLED}"]`)).toHaveCount(1, { timeout: 30_000 })
  expect(cursors.filter(cursor => cursor === null).length).toBeGreaterThanOrEqual(2)

  // Another date restores the sections with no request.
  seen.length = 0
  await dateSelect(page).selectOption('any')
  await expect(needs).toBeVisible()
  await expect(allRuns(page)).toHaveCount(0)
  await page.waitForTimeout(300)
  expect(registryReads(seen)).toEqual([])
  expect(await page.title()).toBe(title)
  expect(await page.getByTestId('rail-triage').textContent()).toBe(railBadge)
})

test(`Triage "All time" with a page that fails: the rows and filters stay, the panel offers Retry for that page only, and "all loaded" only once it answers; no Retry after leaving (${phase})`, async ({ page }) => {
  test.slow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.clock.setFixedTime(REVAMP_NOW)
  let fail = true
  const cursors = await serveRegistryPages(page, { failSecond: () => fail })
  await page.goto(`${triageUrl}?date=all`)
  const panel = page.getByTestId('projects-error').filter({ hasText: 'The next page of runs could not be loaded.' })
  await expect(panel).toBeVisible({ timeout: 30_000 })
  const scope = bar(page).getByTestId('run-filter-scope')
  await expect(scope).toHaveText(/^\d+ of \d+ runs · every project · Load more runs$/)
  await expect(scope).not.toContainText('all loaded')
  await expect(allRuns(page).locator(`a[data-run-id="${OLD_FAILED}"]`)).toHaveCount(1)
  await statusToggle(page, 'failed').click()
  await expect(statusToggle(page, 'failed')).toHaveAttribute('aria-pressed', 'true')
  await expect(scope).not.toContainText('all loaded')
  expect(cursors.filter(cursor => cursor === null).length).toBeGreaterThanOrEqual(1)
  // Retry asks for the failed page only.
  fail = false
  const before = cursors.length
  await panel.getByRole('button', { name: 'Retry' }).click()
  await expect(scope).toHaveText(/^\d+ of \d+ runs · every project, all loaded$/, { timeout: 15_000 })
  expect(cursors.slice(before)).toEqual(['page-2'])
  await expect(statusToggle(page, 'failed')).toHaveAttribute('aria-pressed', 'true')
  // A failure again, then leaving All time: no panel and no Retry remain that would do nothing.
  fail = true
  await statusToggle(page, 'failed').click()
  await dateSelect(page).selectOption('any')
  await dateSelect(page).selectOption('all')
  await expect(panel).toBeVisible({ timeout: 15_000 })
  await dateSelect(page).selectOption('any')
  await expect(page.getByTestId('projects-error')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0)
})

test(`Triage "All time" whose home read failed: the registry's runs still list, with the bar, Attention and a way back to Any date (${phase})`, async ({ page }) => {
  test.slow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.clock.setFixedTime(REVAMP_NOW)
  await page.route(isHomeRuns, route => route.fulfill({ status: 503, json: { error: { code: 'RUNS_UNREADABLE', message: 'The registry could not be read' } } }))
  // The pages answer on their own: the home read gives them no run to hold.
  const pages = ALL_PAGES(OLD('zz-old-home', 'failed', '2026-01-03T10:00:00Z'))
  await page.route(isRegistryPages, route => route.fulfill({ json: new URL(route.request().url()).searchParams.get('cursor') === null ? pages.first : pages.second }))
  await page.goto(`${triageUrl}?date=all`)
  await expect(page.getByTestId('home-not-read')).toHaveText('Runs not read: The registry could not be read (RUNS_UNREADABLE, HTTP 503)', { timeout: 30_000 })
  await expect(allRuns(page).locator(`a[data-run-id="${OLD_CANCELLED}"]`)).toHaveCount(1, { timeout: 15_000 })
  for (const runId of [OLD_FAILED, OLD_SUCCEEDED]) await expect(allRuns(page).locator(`a[data-run-id="${runId}"]`)).toHaveCount(1)
  await expect(page.getByTestId('lists-errors').locator('li', { hasText: `${PROJECT.name} · zz-gone` })).toContainText('RUNS_UNREADABLE')
  await expect(dateSelect(page)).toHaveValue('all')
  await dateSelect(page).selectOption('any')
  await expect(page).not.toHaveURL(/[?&]date=all\b/)
  await expect(allRuns(page)).toHaveCount(0)
  await expect(page.getByTestId('lists-errors')).toHaveCount(0)
  await expect(page.getByTestId('home-not-read')).toBeVisible()
  await expect(page.getByTestId('home-quiet')).toHaveCount(0)
})

// ---- Carried list fixes ------------------------------------------------------------------------------------------------------

test(`"Lists incomplete" counts projects as its fraction, names unread workflows of read projects in its own clause, and links to Attention (${phase})`, async ({ page }) => {
  test.slow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.clock.setFixedTime(REVAMP_NOW)
  const answered = page.waitForResponse(response => isHomeRuns(new URL(response.url())))
  await page.goto(triageUrl)
  const home = await (await answered).json() as { projects: { project_id: string; error: unknown; runs: HomeEntry[] }[] }
  // What the served read says: projects whose own read or every workflow failed, and failed workflows of the others.
  const unread = home.projects.filter(project => project.error !== null || (project.runs.length > 0 && project.runs.every(entry => entry.error !== null)))
  const workflows = home.projects.filter(project => !unread.includes(project)).reduce((sum, project) => sum + project.runs.filter(entry => entry.error !== null).length, 0)
  const incomplete = page.getByTestId('lists-incomplete')
  await expect(incomplete).toHaveText(`${home.projects.length - unread.length} of ${home.projects.length} projects read; lists incomplete`, { timeout: 30_000 })
  if (workflows > 0) await expect(page.getByTestId('lists-incomplete-workflows')).toHaveText(` · ${workflows} ${workflows === 1 ? 'workflow' : 'workflows'} of read projects not read`)
  else await expect(page.getByTestId('lists-incomplete-workflows')).toHaveCount(0)
  // Each failed workflow is an Attention card; the banner's link goes there.
  const attention = page.getByTestId('lists-errors')
  await expect(attention.locator(':scope li')).toHaveCount(unread.filter(project => project.error !== null).length + home.projects.reduce((sum, project) => sum + (project.error !== null ? 0 : project.runs.filter(entry => entry.error !== null).length), 0))
  const link = page.getByTestId('lists-incomplete-link')
  await expect(link).toHaveAttribute('href', '#lists-attention')
  await expect(attention).toHaveAttribute('id', 'lists-attention')
  await link.click()
  await expect(attention).toBeInViewport()
})

test(`The feature page under "All time" reads past the page cap; a page that fails there and then Any date leaves no Retry that does nothing, and says why the list stops (${phase})`, async ({ page }) => {
  test.slow()
  const cursors: string[] = []
  await installListsWorld(page)
  await page.route(url => url.pathname === `/api/projects/${B_FILTER.project_id}/workflows/filter-runs/runs`, async route => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor')
    if (cursor !== null) cursors.push(cursor)
    if (cursor === 'cap-22') { await route.fulfill({ status: 500, json: { error: { code: 'INTERNAL', message: 'The next page could not be read' } } }); return }
    await route.fulfill({ json: cappedPage(cursor) })
  })
  await page.clock.setFixedTime(B_CLOCK)
  await page.goto(`${workflowUrl(B_FILTER.project_id, 'filter-runs')}?date=all`)
  const panel = page.getByTestId('projects-error').filter({ hasText: 'The next page of runs could not be loaded.' })
  await expect(panel).toBeVisible({ timeout: 60_000 })
  // "All time" reads past the cap of 20 pages until the failed one.
  await expect(runList(page).locator('li')).toHaveCount(42)
  await expect(panel.getByRole('button', { name: 'Retry' })).toHaveCount(1)
  await bar(page).getByTestId('run-filter-date').selectOption('any')
  // Outside "All time" at the cap, Retry could not read on: none is offered, and the cap says why and that All time reads on.
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Load more runs' })).toHaveCount(0)
  await expect(page.getByTestId('feature-page-cap')).toBeVisible()
  await expect(runList(page).locator('li')).toHaveCount(42)
  const asked = cursors.length
  await page.waitForTimeout(500)
  expect(cursors.length, 'nothing more is read outside All time').toBe(asked)
})

// ---- Stage D: filtered blocks, scroll back to a run page, a stopped controller, unreadable runs -------------------------

test(`[scenario:filtered-lists] The project page's "Needs you and running" block follows the filter with a "<k> of <n>" heading and says "No run matches." once; a feature header keeps its latest run's word; a filtered Triage says it once per empty section (${phase})`, async ({ page }, testInfo) => {
  test.slow()
  await installListsWorld(page)
  await page.clock.install({ time: B_CLOCK })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(projectUrl(B_ORDER.project_id))
  await projectRead(page)
  const needs = page.getByTestId('dispatch-needs')
  const heading = needs.locator('h2')
  const listed = async () => (await needs.locator('.dispatch-needs-list li a code').allInnerTexts()).sort()
  const blockRuns = ['mix-needs', 'mix-running', 'order-running-1']
  // Without a filter: the block and its heading as on main.
  await expect(heading).toHaveText('Needs you and running')
  expect(await listed()).toEqual(blockRuns)
  const unfiltered = await needs.innerHTML()
  const rail = page.getByTestId('dispatch-rail-list').locator(`.dispatch-rail-row[data-project-id="${B_ORDER.project_id}"]`)
  const counts = async () => ({ rail: await rail.innerText(), figures: await page.getByTestId('dispatch-figures').innerText() })
  // The rail row is compared before and after filtering: wait for the overview (its repository label) so a late overview is not a change.
  await expect(rail).toContainText(`~/dev/${B_ORDER.project_id}`, { timeout: 30_000 })
  const before = await counts()
  // A text filter alone that matches one of the block's runs.
  await bar(page).getByTestId('run-filter-q').fill('order-running-1')
  await expect(heading).toHaveText(/ · 1 of 3$/)
  expect(await listed()).toEqual(['order-running-1'])
  expect(await counts()).toEqual(before)
  // q=fail with status Failed matches none of them: the heading says 0 of 3, "No run matches." once, neither all-clear.
  await bar(page).getByTestId('run-filter-q').fill('fail')
  await statusToggle(page, 'failed').click()
  await expect(heading).toHaveText(/ · 0 of 3$/)
  expect(((await needs.innerText()).match(/No run matches\./g) ?? []).length).toBe(1)
  await expect(page.getByTestId('dispatch-needs-none')).toHaveCount(0)
  await expect(page.getByTestId('dispatch-needs-clear')).toHaveCount(0)
  expect(await counts()).toEqual(before)
  await attach(page, testInfo, 'filtered-lists')
  // Clearing the filter restores the block and its heading.
  await bar(page).getByTestId('run-filter-clear').click()
  await expect(heading).toHaveText('Needs you and running')
  expect(await needs.innerHTML()).toBe(unfiltered)

  // A feature whose latest run succeeded keeps "succeeded" while the filter leaves an older failed run, or nothing.
  await page.goto(projectUrl(B_FOLD.project_id))
  await projectRead(page)
  const word = page.locator('li[data-workflow-id="fold-done"]').getByTestId('dispatch-feature-word')
  await expect(word).toHaveText('succeeded')
  await statusToggle(page, 'failed').click()
  await expect(page.locator('li[data-workflow-id="fold-done"]').getByText('1 run', { exact: false }).first()).toBeVisible()
  await expect(word).toHaveText('succeeded')
  await bar(page).getByTestId('run-filter-q').fill('zzzz-no-such-run')
  await expect(page.locator('li[data-workflow-id="fold-done"]').getByText('0 of 2 runs match')).toBeVisible()
  await expect(word).toHaveText('succeeded')
  await expect(word).not.toHaveText('no runs')

  // A filtered Triage: every empty section's text says "No run matches." exactly once.
  await page.goto(triageUrl)
  await expect(page.getByTestId('needs-you').locator('.ui-section-header h2')).toHaveText(/^Needs you · \d+$/, { timeout: 30_000 })
  await bar(page).getByTestId('run-filter-q').fill('zzzz-no-such-run')
  for (const id of ['needs-you', 'running-runs', 'today-runs', 'paused-runs', 'recent-runs']) {
    await expect(page.getByTestId(id).locator('a[data-run-id]')).toHaveCount(0)
    expect(((await page.getByTestId(id).innerText()).match(/No run matches\./g) ?? []).length, `${id} says it once`).toBe(1)
  }
  await bar(page).getByTestId('run-filter-q').fill('')
  await statusToggle(page, 'failed').click()
  for (const id of ['needs-you', 'running-runs', 'today-runs', 'paused-runs', 'recent-runs']) {
    if ((await page.getByTestId(id).locator('a[data-run-id]').count()) === 0) {
      expect(((await page.getByTestId(id).innerText()).match(/No run matches\./g) ?? []).length, `${id} says it once`).toBe(1)
    }
  }
})

test(`[scenario:back-to-run] Back from a node page returns to the run page where it was scrolled (${phase})`, async ({ page }, testInfo) => {
  test.slow()
  await page.setViewportSize({ width: 1440, height: 900 })
  const run = runUrl(RUN_SESSIONS, undefined, UX_SESSIONS_WORKFLOW_ID)
  await page.goto(run)
  const heading = page.locator('#sessions-title')
  await expect(heading).toBeVisible({ timeout: 30_000 })
  await heading.scrollIntoViewIfNeeded()
  await heading.evaluate(element => element.scrollIntoView({ block: 'start' }))
  const scrollY = () => page.evaluate('window.scrollY') as Promise<number>
  await expect.poll(scrollY).toBeGreaterThan(600)
  const before = await scrollY()
  // A node page by its link, then Back.
  await page.locator('[data-testid="sessions-section"] a[data-testid="session-row-link"]').first().click()
  await expect(page.getByTestId('node-detail')).toBeVisible()
  await page.goBack()
  await expect(heading).toBeVisible()
  await expect.poll(async () => Math.abs((await scrollY()) - before), { timeout: 10_000 }).toBeLessThanOrEqual(50)
  testInfo.annotations.push({ type: 'scrollY', description: `before ${before}, after ${await scrollY()}` })
  await attach(page, testInfo, 'back-to-run')
})

test(`[scenario:triage-controller-stopped] A feature's latest running run whose controller read not_running on two polls 15 s apart needs you on every list, as on its run page; a later running reading, one reading, unknown, null and a run that is not the latest leave Running alone (${phase})`, async ({ page }, testInfo) => {
  test.setTimeout(240_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  // Every running run is served with a controller reading of the test's choosing: this module's latest and its non-latest run
  // by the variables below, every other running run (the combined candidate lists more) as alive, so only these two can move.
  type Reading = 'running' | 'not_running' | 'unknown' | null
  const serve: { live: Reading; quiet: Reading } = { live: 'running', quiet: 'not_running' }
  await editHomeRows(page, runs => runs.map(run => {
    if (run.status !== 'running' || run.activity == null) return run
    const controller = run.run_id === RUN_DESK_LIVE ? serve.live : run.run_id === RUN_DESK_LIVE_QUIET ? serve.quiet : 'running'
    return { ...run, activity: { ...run.activity, controller } }
  }))
  await page.clock.install({ time: new Date(REVAMP_NOW) })
  await page.goto(triageUrl)
  const needs = page.getByTestId('needs-you')
  const running = page.getByTestId('running-runs')
  await expect(row(running, RUN_DESK_LIVE)).toHaveCount(1, { timeout: 30_000 })
  const railRow = page.getByTestId('dispatch-rail-list').locator(`.dispatch-rail-row[data-project-id="${PROJECT.project_id}"]`)
  const snapshot = async () => ({
    title: (await page.title()).match(/^\((\d+)\) /)?.[1] ?? '0',
    needs: await needs.locator('.ui-section-header h2').innerText(),
    running: await running.locator('.ui-section-header h2').innerText(),
    triage: await page.getByTestId('rail-triage').innerText(),
    rail: await railRow.innerText(),
  })
  // One more home poll, far enough from the last (16 s of the page's clock) for two readings to be 15 s apart.
  const poll = async () => {
    const answered = page.waitForResponse(response => new URL(response.url()).pathname === '/api/dispatch/runs')
    await page.clock.runFor(16_000)
    await answered
    await page.waitForTimeout(400)
  }
  const waitsOf = (text: string) => Number(text.match(/(\d+) waits on you/)?.[1] ?? 0)
  const card = () => page.locator(`a.dispatch-card[data-project-id="${PROJECT.project_id}"]`).getByTestId('dispatch-card-live')
  const cardWaits = async () => {
    await page.getByTestId('rail-all-projects').click()
    await expect(page.getByTestId('dispatch-cards')).toBeVisible()
    const text = await card().innerText().catch(() => '')
    await page.getByTestId('rail-triage').click()
    await expect(needs).toBeVisible()
    return waitsOf(text)
  }

  const calm = await snapshot()
  const calmCard = await cardWaits()
  await expect(needs.locator(`a[data-run-id="${RUN_DESK_LIVE}"]`)).toHaveCount(0)

  // One not_running reading changes nothing; the non-latest running run never moves, however long it reads not_running.
  serve.live = 'not_running'
  await poll()
  expect(await snapshot()).toEqual(calm)
  await expect(row(running, RUN_DESK_LIVE)).toHaveCount(1)

  // Two readings 15 s apart: Needs you, with the interrupted wording and next step, and every count follows.
  await poll()
  await expect(needs.locator(`a[data-run-id="${RUN_DESK_LIVE}"][data-attention="interrupted"]`)).toHaveCount(1, { timeout: 15_000 })
  await expect(row(running, RUN_DESK_LIVE)).toHaveCount(0)
  const card1 = needs.locator('li', { has: page.locator(`a[data-run-id="${RUN_DESK_LIVE}"]`) })
  await expect(card1.locator('.home-card-summary')).toContainText('controller is not running')
  await expect(card1.locator('.home-card-head .ui-chip').first()).toHaveText('controller not running')
  await expect(card1.getByTestId('next-step')).toHaveText('Next: resume the run on the run page')
  await expect(row(running, RUN_DESK_LIVE_QUIET)).toHaveCount(1)
  await expect(needs.locator(`a[data-run-id="${RUN_DESK_LIVE_QUIET}"]`)).toHaveCount(0)
  const stopped = await snapshot()
  expect(Number(stopped.title)).toBe(Number(calm.title) + 1)
  expect(Number(stopped.needs.match(/(\d+)$/)![1])).toBe(Number(calm.needs.match(/(\d+)$/)![1]) + 1)
  expect(Number(stopped.running.match(/(\d+)$/)![1])).toBe(Number(calm.running.match(/(\d+)$/)![1]) - 1)
  expect(waitsOf(stopped.triage)).toBe(waitsOf(calm.triage) + 1)
  expect(waitsOf(stopped.rail)).toBe(waitsOf(calm.rail) + 1)
  expect(await cardWaits()).toBe(calmCard + 1)
  await attach(page, testInfo, 'triage-controller-stopped')

  // Its time reads interrupted, never a ticking span, wherever it is listed: as a row on Triage (pinned), in the project
  // page's step chart and on the feature page; the list clock moving on changes none of it, and none lists it as running.
  const pin = card1.locator('button.pin-toggle')
  await pin.click()
  const triageRow = page.getByTestId('pinned-runs').locator(`a[data-run-id="${RUN_DESK_LIVE}"]`)
  await expect(triageRow).toHaveAttribute('data-attention', 'interrupted')
  const triageWhen = triageRow.locator('.run-row-when')
  await expect(triageWhen).toContainText('interrupted')
  await expect(triageWhen.locator('.run-row-span')).toHaveCount(0)
  const triageText = await triageWhen.innerText()
  await poll()
  await expect(triageWhen).toHaveText(triageText)
  await pin.click()
  await expect(page.getByTestId('pinned-runs')).toHaveCount(0)
  await railRow.click()
  const chartRun = page.locator(`li[data-workflow-id="${UX_REVAMP_LISTS_WORKFLOW_ID}"] .dispatch-run[data-run-id="${RUN_DESK_LIVE}"]`)
  const chartWhen = chartRun.getByTestId('dispatch-run-when')
  await expect(chartWhen).toContainText('interrupted', { timeout: 30_000 })
  await expect(chartWhen).not.toContainText('running ')
  await expect(chartRun.locator('.dispatch-word')).toHaveText('interrupted')
  const chartText = await chartWhen.innerText()
  await poll()
  await expect(chartWhen).toHaveText(chartText)
  await page.locator(`li[data-workflow-id="${UX_REVAMP_LISTS_WORKFLOW_ID}"] a.lists-group-head`).click()
  const featureRow = page.getByTestId('run-list').locator(`a[data-run-id="${RUN_DESK_LIVE}"]`)
  await expect(featureRow).toHaveAttribute('data-attention', 'interrupted', { timeout: 30_000 })
  await expect(featureRow.locator('.run-row-when')).toContainText('interrupted')
  await expect(featureRow.locator('.run-row-span')).toHaveCount(0)
  await page.getByTestId('rail-triage').click()
  await expect(needs.locator(`a[data-run-id="${RUN_DESK_LIVE}"][data-attention="interrupted"]`)).toHaveCount(1, { timeout: 15_000 })

  // A later running reading takes it out of Needs you on that poll, and every count returns.
  serve.live = 'running'
  await poll()
  await expect(row(running, RUN_DESK_LIVE)).toHaveCount(1, { timeout: 15_000 })
  await expect(needs.locator(`a[data-run-id="${RUN_DESK_LIVE}"]`)).toHaveCount(0)
  expect(await snapshot()).toEqual(calm)
  expect(await cardWaits()).toBe(calmCard)

  // unknown and null never establish it, over any number of polls.
  for (const value of ['unknown', null] as const) {
    serve.live = value
    await poll()
    await poll()
    await poll()
    expect(await snapshot(), `${value} readings`).toEqual(calm)
    await expect(row(running, RUN_DESK_LIVE)).toHaveCount(1)
  }
})

test(`[scenario:unread-runs] A run list that names runs it could not read shows its readable runs and one "cannot be read" line, never a run row; an all-unreadable list shows the line instead of an empty list; without the key both pages are as before (${phase})`, async ({ page }, testInfo) => {
  test.slow()
  await installListsWorld(page)
  await page.clock.install({ time: B_CLOCK })
  await page.setViewportSize({ width: 1440, height: 900 })
  const project = B_ORDER.project_id
  const workflow = B_ORDER.workflows[0]
  const readable = workflow.runs.slice(0, 2).map(run => bSummary(project, workflow.workflow_id, run))
  const bad = { run_id: 'bad-run-001', code: 'RUN_STATE_INVALID', message: 'run-state.json does not match its directory' }
  const other = { run_id: 'bad-run-002', code: 'RUN_STATE_INVALID', message: 'run-state.json does not match its directory' }
  const answer: { runs: RunSummary[]; errors?: typeof bad[] } = { runs: readable, errors: [bad] }
  await page.route(url => url.pathname === `/api/projects/${project}/workflows/${workflow.workflow_id}/runs`, route => route.fulfill({
    json: { runs: answer.runs, next_cursor: null, ...(answer.errors === undefined ? {} : { errors: answer.errors }) },
  }))
  const stepsNaming: { errors: typeof bad[] } = { errors: [] }
  await page.route(url => url.pathname === `/api/dispatch/projects/${project}/steps`, route => route.fulfill({
    json: { contract_version: '1.0.0', project_id: project, workflows: B_ORDER.workflows.map(item => ({ workflow_id: item.workflow_id, error: null, runs: [], errors: item.workflow_id === workflow.workflow_id ? stepsNaming.errors : [] })) },
  }))

  // The feature page: the two readable runs, one line, no run row; the scope line counts the two served rows.
  await page.goto(workflowUrl(project, workflow.workflow_id))
  await expect(runList(page).locator('li')).toHaveCount(2, { timeout: 30_000 })
  const line = page.getByTestId('feature-unread-runs')
  await expect(line).toHaveText('1 run cannot be read: bad-run-001')
  await expect(line.locator('xpath=ancestor-or-self::li[ancestor::*[@data-testid="run-list"]]')).toHaveCount(0)
  await expect(line).not.toHaveAttribute('data-run-id', /.*/)
  await expect(page.locator('[data-run-id="bad-run-001"]')).toHaveCount(0)
  await expect(bar(page).getByTestId('run-filter-scope')).toHaveText('2 of 2 runs, all loaded')
  await attach(page, testInfo, 'unread-runs')

  // The project page: the same line under the feature, the feature counted as one that cannot be read.
  await gotoProjectOpen(page, projectUrl(project))
  const feature = page.locator(`li[data-workflow-id="${workflow.workflow_id}"]`)
  await expect(feature.getByTestId('dispatch-unread-runs')).toHaveText('1 run cannot be read: bad-run-001')
  await expect(page.getByTestId('dispatch-needs-unread')).toContainText('1 feature cannot be read')
  await expect(page.getByTestId('dispatch-needs-none')).toHaveCount(0)
  await expect(bar(page).getByTestId('run-filter-scope')).toContainText('1 feature cannot be read')
  // The partly read feature keeps its header state word and its run count.
  await expect(feature.getByTestId('dispatch-feature-word')).toHaveCount(1)
  await expect(feature.locator('.lists-group-head')).toContainText('2 runs')

  // The chart's steps rows already name that run: no second "cannot be read" for it.
  stepsNaming.errors = [bad]
  await gotoProjectOpen(page, projectUrl(project))
  const named = page.locator(`li[data-workflow-id="${workflow.workflow_id}"]`)
  await expect(named.locator('.dispatch-badrow')).toHaveCount(1)
  await expect(named.getByTestId('dispatch-unread-runs')).toHaveCount(0)
  expect(((await named.innerText()).match(/cannot be read/g) ?? []).length).toBe(1)
  await expect(page.getByTestId('dispatch-needs-unread')).toContainText('1 feature cannot be read')
  stepsNaming.errors = []

  // Every run unreadable: the line in place of an empty list.
  answer.runs = []
  answer.errors = [bad, other]
  await page.goto(workflowUrl(project, workflow.workflow_id))
  await expect(page.getByTestId('feature-unread-runs')).toHaveText('2 runs cannot be read: bad-run-001, bad-run-002', { timeout: 30_000 })
  await expect(page.getByTestId('empty-runs')).toHaveCount(0)
  await expect(page.getByText('No runs have been recorded')).toHaveCount(0)
  await expect(runList(page)).toHaveCount(0)
  await gotoProjectOpen(page, projectUrl(project))
  await expect(page.getByTestId('dispatch-needs-unread')).toContainText('1 feature cannot be read')
  await expect(page.getByTestId('dispatch-needs-none')).toHaveCount(0)

  // Without the key neither page shows the line.
  answer.runs = readable
  answer.errors = undefined
  await page.goto(workflowUrl(project, workflow.workflow_id))
  await expect(runList(page).locator('li')).toHaveCount(2, { timeout: 30_000 })
  await expect(page.getByTestId('feature-unread-runs')).toHaveCount(0)
  await gotoProjectOpen(page, projectUrl(project))
  await expect(page.getByTestId('dispatch-unread-runs')).toHaveCount(0)
  await expect(page.getByTestId('dispatch-needs-unread')).toHaveCount(0)
})
