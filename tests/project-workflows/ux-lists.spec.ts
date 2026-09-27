/**
 * Viewer UX slice S6 (docs/PRD_VIEWER_UX.md 4.1, 6.3, 6.4, 12.2): Runs home lists what needs the operator, what runs and
 * what finished in the last seven days across every project; the project page groups the same rows by feature; the
 * feature page keeps its `run-list` rows and folds the current definition away; and the run page reads the served
 * `activity` (a live question record, a pane, a stopped controller) and `run_dir`. These tests assert only on the
 * `ux-lists` runs, since the combined candidate also lists other slices' runs, and fix the page clock at `LISTS_NOW`.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { currentCrumb } from '../helpers.ts'
import { EMPTY_PROJECT, PROJECT } from './fixtures.ts'
import {
  ANSWERED_QUESTION, LISTS_FEATURE, LISTS_NOW, mockRunDir, RUN_LISTS_ANSWERED, RUN_LISTS_APPROVAL, RUN_LISTS_ASKING, RUN_LISTS_FAILED,
  RUN_LISTS_FAILED_EARLIER, RUN_LISTS_LIVE, RUN_LISTS_OLD, RUN_LISTS_STOPPED, UX_LISTS_WORKFLOW_ID, UX_LISTS_WORKFLOW_NAME,
} from './fixtures/ux-lists.ts'
import { attach, expectNoExecutionControls, installHooks, phase, projectsUrl, runUrl, workflowUrl } from './support.ts'

installHooks()

const OWN_RUNS = [RUN_LISTS_ASKING, RUN_LISTS_ANSWERED, RUN_LISTS_APPROVAL, RUN_LISTS_LIVE, RUN_LISTS_STOPPED, RUN_LISTS_FAILED, RUN_LISTS_FAILED_EARLIER, RUN_LISTS_OLD]
const listsRunUrl = (runId: string) => runUrl(runId, undefined, UX_LISTS_WORKFLOW_ID)
const row = (scope: Locator, runId: string) => scope.locator(`a[data-run-id="${runId}"]`)
/** The run ids a section lists, in order, limited to this workflow's runs. */
const ownIds = (section: Locator) => section.locator('a[data-run-id]').evaluateAll(
  (links, own) => links.map(link => link.getAttribute('data-run-id')).filter(id => id !== null && own.includes(id)), OWN_RUNS)
const liveStatus = (page: Page) => page.getByTestId('live-status')
const banner = (page: Page) => page.getByTestId('run-now')

test(`[scenario:runs-home] Runs home lists Needs you, Running and Recent across projects; the project page groups rows by feature; the feature page folds its definition (${phase})`, async ({ page }, testInfo) => {
  await page.clock.setFixedTime(LISTS_NOW)
  await page.goto(projectsUrl)
  await expect(currentCrumb(page)).toHaveText('Projects')
  await expect(page.getByTestId('projects-info')).toContainText('Read-only')
  const needs = page.getByTestId('needs-you')
  const running = page.getByTestId('running-runs')
  const recent = page.getByTestId('recent-runs')

  // Needs you: grouped by what waits (served activity.attention.kind), each row one link in an li, named by its run id first.
  await expect(row(needs, RUN_LISTS_ASKING)).toHaveAttribute('data-attention', 'question')
  await expect(row(needs, RUN_LISTS_ANSWERED)).toHaveAttribute('data-attention', 'pane')
  await expect(row(needs, RUN_LISTS_APPROVAL)).toHaveAttribute('data-attention', 'approval')
  await expect(row(needs, RUN_LISTS_APPROVAL)).toHaveAttribute('data-status', 'awaiting_approval')
  for (const runId of [RUN_LISTS_ASKING, RUN_LISTS_ANSWERED, RUN_LISTS_APPROVAL]) {
    await expect(needs.getByRole('link', { name: new RegExp(`^${runId}(?:\\s|$)`) })).toHaveCount(1)
    expect(await row(needs, runId).evaluate(link => link.parentElement?.tagName)).toBe('LI')
  }
  await expect(row(needs, RUN_LISTS_ASKING)).toContainText('ui asked a question')
  // The live question record answered ui's question: the run waits on adapter's pane, never on a question.
  await expect(row(needs, RUN_LISTS_ANSWERED)).toContainText('adapter needs attention in its pane')
  await expect(row(needs, RUN_LISTS_ANSWERED)).not.toContainText('asked a question')
  await expect(row(needs, RUN_LISTS_APPROVAL)).toContainText('Freeze worker handoffs awaits your decision')
  // Titles follow the rule: the generic definition name gives the latest run's feature.
  await expect(row(needs, RUN_LISTS_ASKING)).toContainText(LISTS_FEATURE)
  await expect(row(needs, RUN_LISTS_ASKING)).toContainText(PROJECT.name)
  await expect(needs).not.toContainText(UX_LISTS_WORKFLOW_NAME)

  // Running: the other live runs, never repeated in another section.
  await expect(row(running, RUN_LISTS_LIVE)).toHaveAttribute('data-status', 'running')
  await expect(row(running, RUN_LISTS_STOPPED)).toHaveAttribute('data-status', 'running')
  await expect(row(running, RUN_LISTS_LIVE)).not.toHaveAttribute('data-attention', /.+/)
  await expect(running.getByRole('link', { name: new RegExp(`^${RUN_LISTS_LIVE}(?:\\s|$)`) })).toHaveCount(1)
  for (const runId of [RUN_LISTS_ASKING, RUN_LISTS_ANSWERED, RUN_LISTS_APPROVAL]) await expect(row(running, runId)).toHaveCount(0)

  // Recent: finished in the last seven days, newest first, with the finish time and the duration from the served activity.
  expect(await ownIds(recent)).toEqual([RUN_LISTS_FAILED, RUN_LISTS_FAILED_EARLIER])
  const failed = row(recent, RUN_LISTS_FAILED)
  await expect(failed).toHaveAttribute('data-status', 'failed')
  await expect(failed).toContainText('Failed at Verify ui')
  await expect(failed).toContainText('52m51s')
  await expect(failed.locator('time[datetime="2026-03-19T09:52:51Z"]').first()).toHaveText('yesterday 09:52')
  await expect(recent.getByRole('link', { name: new RegExp(`^${RUN_LISTS_FAILED}(?:\\s|$)`) })).toHaveCount(1)
  // A run that finished ten days ago is not on Runs home at all.
  await expect(page.locator(`a[data-run-id="${RUN_LISTS_OLD}"]`)).toHaveCount(0)
  for (const runId of OWN_RUNS) expect(await page.locator(`a[data-run-id="${runId}"]`).count(), runId).toBeLessThanOrEqual(1)

  // Compact project cards, one link each.
  const projects = page.getByTestId('projects-list')
  await expect(projects.getByRole('link')).toHaveCount(2)
  await expect(projects.getByRole('link', { name: new RegExp(`^${PROJECT.name}`) })).toContainText(/\d+ features/)
  await expect(projects.getByRole('link', { name: new RegExp(`^${EMPTY_PROJECT.name}`) })).toContainText('0 features')
  await expectNoExecutionControls(page)
  await attach(page, testInfo, 'runs-home')

  // At 390 px each row stacks into short lines, the whole row is the tap target, and nothing scrolls sideways.
  await page.setViewportSize({ width: 390, height: 844 })
  const narrow = row(recent, RUN_LISTS_FAILED)
  const id = await narrow.locator('.run-row-id').boundingBox()
  const when = await narrow.locator('.run-row-when').boundingBox()
  const detail = await narrow.locator('.run-row-detail').boundingBox()
  expect(id && when && detail).toBeTruthy()
  expect(when!.y).toBeGreaterThanOrEqual(id!.y + id!.height - 1)
  expect(detail!.y).toBeGreaterThanOrEqual(id!.y + id!.height - 1)
  expect((await narrow.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  expect(await (page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') as Promise<number>)).toBeLessThanOrEqual(0)
  await page.setViewportSize({ width: 1280, height: 720 })

  // The project page: the same rows grouped by feature; a group header links to the feature's runs, and the old run stays here.
  await page.getByTestId('projects-list').getByRole('link', { name: new RegExp(`^${PROJECT.name}`) }).click()
  await expect(currentCrumb(page)).toHaveText(PROJECT.name)
  const groups = page.getByTestId('workflows-list')
  const group = groups.locator(`[data-workflow-id="${UX_LISTS_WORKFLOW_ID}"]`)
  const header = group.getByRole('link', { name: new RegExp(`^${LISTS_FEATURE}`) })
  await expect(header).toContainText(`${UX_LISTS_WORKFLOW_ID} · ${OWN_RUNS.length} runs`)
  await expect(row(group, RUN_LISTS_OLD)).toHaveAttribute('data-status', 'failed')
  await expect(row(group, RUN_LISTS_ASKING)).toHaveAttribute('data-attention', 'question')
  await expect(row(group, RUN_LISTS_ASKING).locator('.run-row-glyph')).toHaveText('?')
  expect((await ownIds(group)).sort()).toEqual([...OWN_RUNS].sort())

  // The feature page: the same rows in run-list, and the current definition closed below them.
  await header.click()
  await expect(page).toHaveURL(new RegExp(`${workflowUrl(PROJECT.project_id, UX_LISTS_WORKFLOW_ID)}$`))
  await expect(currentCrumb(page)).toHaveText(LISTS_FEATURE)
  const runList = page.getByTestId('run-list')
  await expect(runList.locator('li')).toHaveCount(OWN_RUNS.length)
  await expect(runList.getByRole('link', { name: new RegExp(`^${RUN_LISTS_OLD}(?:\\s|$)`) })).toHaveCount(1)
  const definition = page.getByTestId('current-definition')
  await expect(definition).toHaveJSProperty('tagName', 'DETAILS')
  await expect(definition).toHaveJSProperty('open', false)
  await expect(page.getByRole('group', { name: `Current definition graph of ${UX_LISTS_WORKFLOW_NAME}` })).toHaveCount(0)
  await definition.locator('summary').click()
  await expect(page.getByRole('group', { name: `Current definition graph of ${UX_LISTS_WORKFLOW_NAME}` })).toBeVisible()
  await expectNoExecutionControls(page)
})

test(`[scenario:served-activity] The run page reads the served activity: a live question record, the run directory and the controller liveness (${phase})`, async ({ page }, testInfo) => {
  test.setTimeout(90_000)
  await page.clock.install({ time: new Date(LISTS_NOW) })

  // The export still shows ui's question 1 waiting; the live ui.questions.json records it answered, so adapter's pane is what waits.
  await page.goto(listsRunUrl(RUN_LISTS_ANSWERED))
  await expect(banner(page)).toHaveAttribute('data-situation', 'pane_attention')
  await expect(page.getByTestId('now-headline')).toContainText('adapter needs attention in its pane')
  await expect(banner(page)).not.toContainText(ANSWERED_QUESTION)

  // A question only the live record holds waits on the operator.
  await page.goto(listsRunUrl(RUN_LISTS_ASKING))
  await expect(banner(page)).toHaveAttribute('data-situation', 'question')
  await expect(page.getByTestId('now-headline')).toContainText('Waiting on you: ui asked a question')
  // The RUN= line makes the commands paste-ready when the run directory is served (worker-phase mocks); the candidate
  // phase's temporary roots lie outside $HOME, so it serves none and the block keeps the $RUN legend only.
  const runLine = banner(page).getByTestId('command-run')
  if (phase === 'worker') {
    await expect(runLine.getByTestId('run-dir-command')).toHaveText(`RUN=${mockRunDir(RUN_LISTS_ASKING)}`)
    await expect(runLine.getByRole('button')).toHaveText('Copy')
  } else {
    await expect(banner(page).getByTestId('now-command').first()).toBeVisible()
    await expect(runLine).toHaveCount(0)
  }
  await expect(banner(page).getByTestId('now-command').first()).toContainText('"$RUN"')

  // The live chip: `controller running` from the worker-phase mock; the candidate phase's seeded PID has no process.
  if (phase === 'worker') {
    await page.goto(listsRunUrl(RUN_LISTS_LIVE))
    await expect(liveStatus(page)).toHaveAttribute('data-controller', 'running')
    await expect(liveStatus(page)).toContainText('controller running')
  }

  // `not_running` is believed only once it has held for 15 s of polls: a single reading can be a checkpoint hand-over.
  await page.goto(listsRunUrl(RUN_LISTS_STOPPED))
  await expect(liveStatus(page)).toHaveAttribute('data-state', 'live')
  await expect(banner(page)).toHaveAttribute('data-situation', 'running')
  await expect(liveStatus(page)).not.toContainText('controller not running')
  await page.clock.fastForward('00:06')
  await expect(liveStatus(page)).toHaveAttribute('data-state', 'live')
  await expect(liveStatus(page)).not.toContainText('controller not running')
  await page.clock.fastForward('00:10')
  await expect(liveStatus(page)).toContainText('▲ controller not running')
  await expect(liveStatus(page)).toHaveAttribute('data-controller', 'not_running')
  // Then, while the run reads running, the banner says the controller stopped (rule 5 case c).
  await expect(banner(page)).toHaveAttribute('data-situation', 'interrupted')
  await expect(page.getByTestId('now-headline')).toContainText('the controller is not running')
  await expect(banner(page).getByTestId('now-command').first()).toContainText('"$PY" -m workflow automatic "$RUN" --live')
  await expectNoExecutionControls(page)
  await attach(page, testInfo, 'served-activity')
})
