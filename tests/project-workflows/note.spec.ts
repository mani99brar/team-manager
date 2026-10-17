/**
 * Steering: "Send a note to the lead" (docs/PRD_RUN_TEAMS.md 7 "Steering", 11 P0 item 9). The note is the fifteenth run control
 * (controls 1.2.0); the Team view's lane head, the step sheet's Team section and the worker's node page open the Controls
 * dialog for `note` with the lane preset, and the dialog keeps the finished record to say what happened: typed into the pane,
 * not delivered, or left in the input line. The worker phase pairs the browser and mocks `/api/run-controls/**` as
 * `controls.spec.ts` does (`installControlMocks`); on top of it this spec serves the teams run's controls with `note` offered
 * for lane ui, and answers the note's POST with the record `workflow note` would leave (workflow/notes.py `note_main`).
 */
import { test, expect, type Page, type Route } from '@playwright/test'
import { TOKEN_KEY } from '../../src/projects/controls/types.ts'
import type { Control, ControlRecord, RunControls } from '../../src/projects/controls/types.ts'
import { CONTROLS_TOKEN, controlsFor, RUN_STOPPED } from './fixtures/controls.ts'
import { TEAMS_NOW, TEAMS_RUNS, UX_TEAMS_WORKFLOW_ID } from './fixtures/ux-teams.ts'
import { installControlMocks } from './mock.ts'
import { attach, expectNoExecutionControls, installHooks, liveDock, nodeDetail, openStepSheet, phase, runUrl, stepSheet } from './support.ts'

installHooks()
test.skip(phase !== 'worker', 'the teams fixtures and the note offer are worker-phase mocks')

const RUN = TEAMS_RUNS.base
const runPage = runUrl(RUN, undefined, UX_TEAMS_WORKFLOW_ID)
const teamPage = `${runPage}/team`
const nodePage = runUrl(RUN, 'launch_ui', UX_TEAMS_WORKFLOW_ID)
const DESK = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }

const EFFECT = 'Types your note into the lane\'s lead session pane as an operator note and records it in the lane\'s notes.'
const NOT_EFFECT = 'A running team workflow takes no input: its agents never see the note, and the lead reads it when its current turn ends. It stops and restarts nothing.'
const HELPER = 'Plain text, up to 4,000 characters. The lead reads it as an operator note, which may amend its task.'
const UNDELIVERABLE = 'Not delivered: the pane was busy, not attached, or the lane was not working or idle. Nothing was typed; look at the pane, then send it again.'
const NOTE_TEXT = 'Use the shared tone map; do not add a colour of your own.'

type Answer = 'delivered' | 'undeliverable' | 'enter_not_submitted'

/** What `workflow note` prints for each outcome (workflow/notes.py `note_main`), and its exit. */
function noteLines(answer: Answer, n: number, lane: string): { exit: number; lines: string[] } {
  switch (answer) {
    case 'delivered': return { exit: 0, lines: [`Note N-${n} typed into ${lane}'s pane and recorded in ~/runs/${RUN}/${lane}.notes.json.`] }
    case 'undeliverable': return { exit: 1, lines: [`Blocked: note N-${n} to ${lane} is recorded undeliverable and was not typed (pane_busy). Look at the pane, then send it again as a new note.`] }
    case 'enter_not_submitted': return { exit: 1, lines: [`Blocked: note N-${n} to ${lane} was typed but Enter did not submit it; the text is still in ${lane}'s input line. Submit or clear it in the pane; do not send it again.`] }
  }
}

type NoteMock = { posts: { request_id?: string; run_state_token?: string; params?: Record<string, unknown> }[]; answer: Answer; off: boolean }

/**
 * The teams run's controls: the worker-phase catalog (`controlsFor`) with `note` offered for lane ui, and the note's POST
 * answered with the record the controller's lines make. `off` answers the status probe with controls off.
 */
async function installNoteMocks(page: Page): Promise<NoteMock> {
  await installControlMocks(page)
  const mock: NoteMock = { posts: [], answer: 'delivered', off: false }
  const records: ControlRecord[] = []
  const payload = (): RunControls => {
    const base = controlsFor(RUN_STOPPED, `rs-note-${records.length + 1}`)!
    const controls = base.controls.map((control): Control => control.id !== 'note' ? control : {
      ...control, available: true, reason: null, effect: EFFECT, not_effect: NOT_EFFECT,
      params: [{ name: 'lane', kind: 'choice', choices: ['ui'], required: true }, { name: 'text', kind: 'text', min_length: 1, max_length: 4000, required: true }],
    })
    return { ...base, controls, records: [...records].reverse() }
  }
  const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route('**/api/run-controls/**', async (route: Route) => {
    const request = route.request()
    const parts = new URL(request.url()).pathname.split('/').filter(Boolean).slice(2).map(decodeURIComponent)
    if (parts[0] === 'status' && mock.off) { await route.fulfill(json({ version: '1.2.0', enabled: false, paired: false })); return }
    const [, , runId, tail] = parts
    if (runId !== RUN || request.headers()['x-mdm-control-token'] !== CONTROLS_TOKEN) { await route.fallback(); return }
    if (request.method() === 'GET' && tail === undefined) { await route.fulfill(json(payload())); return }
    if (request.method() === 'POST' && tail === 'note') {
      const body = request.postDataJSON() as NoteMock['posts'][number]
      mock.posts.push(body)
      const lane = String(body.params?.lane ?? '')
      const { exit, lines } = noteLines(mock.answer, records.length + 1, lane)
      const now = new Date(Date.parse(TEAMS_NOW) + records.length * 1000).toISOString()
      const record: ControlRecord = {
        record_id: `c-${String(900 + records.length).padStart(12, '0')}`, request_id: body.request_id ?? '', control: 'note', params: body.params ?? {},
        command: `$PY -m workflow note "$RUN" ${lane} --by operator -- "${String(body.params?.text ?? '')}"`,
        status: exit === 0 ? 'succeeded' : 'failed', exit_code: exit, started_at: now, ended_at: now, output_tail: lines,
      }
      records.push(record)
      await route.fulfill(json({ record }))
      return
    }
    await route.fallback()
  })
  return mock
}

async function open(page: Page, url: string, paired = true) {
  if (paired) await page.addInitScript(`window.localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(CONTROLS_TOKEN)})`)
  await page.clock.setFixedTime(new Date(TEAMS_NOW))
  await page.setViewportSize(DESK)
  await page.goto(url)
}

const dialog = (page: Page) => page.getByTestId('control-dialog')
const laneNote = (page: Page, lane: string) => page.locator(`[data-testid="team-lane"][data-lane="${lane}"] button[data-testid="control-note"]`)

/** The note dialog's copy (7): title with the lane, the field and its helper, the server's effect and not-effect verbatim, the command, Send note. */
async function expectNoteDialog(page: Page, lane: string) {
  await expect(dialog(page)).toHaveAttribute('data-control', 'note')
  await expect(dialog(page).getByRole('heading', { level: 2 })).toHaveText(`Send a note to the lead of ${lane}`)
  await expect(dialog(page).getByTestId('param-lane')).toHaveValue(lane)
  await expect(dialog(page).getByLabel('Your note')).toBeVisible()
  await expect(dialog(page).getByTestId('param-text-helper')).toHaveText(HELPER)
  await expect(dialog(page).getByTestId('param-text')).toHaveAttribute('maxlength', '4000')
  await expect(dialog(page).getByTestId('dialog-effect')).toHaveText(`What it does. ${EFFECT}`)
  await expect(dialog(page).getByTestId('dialog-not-effect')).toHaveText(`What it does not do. ${NOT_EFFECT}`)
  await expect(dialog(page).getByTestId('dialog-command')).toHaveText('$PY -m workflow note "$RUN" <lane> --by operator -- "<text>"')
  await expect(dialog(page).getByTestId('dialog-confirm')).toHaveText('Send note')
  await expect(dialog(page).getByTestId('dialog-confirm')).toBeDisabled()
}

test(`[scenario:note-control] "Send a note to the lead" sits on the lane head, the step sheet and the node page when offered and paired; it opens the note dialog with the lane preset and section 7's copy, posts the lane and text, and says "Typed into ui's pane."; with controls off no note button exists (${phase})`, async ({ page }, testInfo) => {
  const mock = await installNoteMocks(page)
  // Controls off: the page is today's, with no note button anywhere and no execution control.
  mock.off = true
  await open(page, teamPage, false)
  await expect(page.getByTestId('team-lane').first()).toBeVisible()
  await expect(page.locator('button[data-testid="control-note"]')).toHaveCount(0)
  await expectNoExecutionControls(page)
  mock.off = false

  // Paired, with note offered for ui only: the ui lane head has the button, the adapter lane none.
  await open(page, teamPage)
  await expect(laneNote(page, 'ui')).toHaveText('Send a note to the lead')
  await expect(laneNote(page, 'adapter')).toHaveCount(0)
  await laneNote(page, 'ui').click()
  await expectNoteDialog(page, 'ui')
  await dialog(page).getByTestId('param-text').fill(NOTE_TEXT)
  await expect(dialog(page).getByTestId('param-text')).toHaveAccessibleDescription(HELPER)
  await dialog(page).getByTestId('dialog-confirm').click()
  const outcome = dialog(page).getByTestId('dialog-outcome')
  await expect(outcome).toHaveAttribute('data-state', 'succeeded')
  await expect(outcome).toHaveAttribute('data-tone', 'ok')
  await expect(outcome.getByTestId('dialog-outcome-sentence')).toHaveText("Typed into ui's pane.")
  expect(mock.posts).toHaveLength(1)
  expect(mock.posts[0]!.params).toEqual({ lane: 'ui', text: NOTE_TEXT })
  expect(mock.posts[0]!.run_state_token).toBe('rs-note-1')
  // Sending once more is not offered from the finished dialog: Close hands the focus back to the lane head's button.
  await expect(dialog(page).getByTestId('dialog-confirm')).toHaveCount(0)
  await attach(page, testInfo, 'note-control')
  await dialog(page).getByTestId('dialog-cancel').click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(laneNote(page, 'ui')).toBeFocused()

  // The step sheet's Team section opens the same dialog with the lane preset; Cancel sends nothing.
  await open(page, runPage)
  await openStepSheet(page, 'launch_ui')
  await stepSheet(page).getByTestId('sheet-team-section').locator('button[data-testid="control-note"]').click()
  await expectNoteDialog(page, 'ui')
  await dialog(page).getByTestId('dialog-cancel').click()
  await expect(dialog(page)).toHaveCount(0)

  // So does the worker's node page, whose Team section holds the button.
  await open(page, nodePage)
  await expect(nodeDetail(page)).toBeVisible()
  await page.getByTestId('team-section').locator('button[data-testid="control-note"]').click()
  await expectNoteDialog(page, 'ui')
  await dialog(page).getByTestId('dialog-cancel').click()
  expect(mock.posts).toHaveLength(1)

  // The Controls menu lists the note too and opens the same dialog; its one lane is preselected.
  await open(page, teamPage)
  await page.getByTestId('controls-button').click()
  await page.getByTestId('control-note-button').click()
  await expectNoteDialog(page, 'ui')
  await dialog(page).getByTestId('dialog-cancel').click()

  await page.setViewportSize(PHONE)
  await expect.poll(() => page.evaluate('document.documentElement.scrollWidth') as Promise<number>).toBeLessThanOrEqual(PHONE.width)
  await expect(laneNote(page, 'ui')).toBeVisible()
})

test(`[scenario:note-control-undeliverable] A note recorded undeliverable says it was not delivered and to send it again; one typed but left in the input line says to submit or clear it and not to send it again; the dock's Controls row says the same (${phase})`, async ({ page }, testInfo) => {
  const mock = await installNoteMocks(page)
  mock.answer = 'undeliverable'
  await open(page, runPage)
  await openStepSheet(page, 'launch_ui')
  await stepSheet(page).getByTestId('sheet-team-section').locator('button[data-testid="control-note"]').click()
  await expectNoteDialog(page, 'ui')
  await dialog(page).getByTestId('param-text').fill(NOTE_TEXT)
  await dialog(page).getByTestId('dialog-confirm').click()
  const outcome = dialog(page).getByTestId('dialog-outcome')
  await expect(outcome).toHaveAttribute('data-state', 'failed')
  await expect(outcome).toHaveAttribute('data-tone', 'warn')
  await expect(outcome.getByTestId('dialog-outcome-sentence')).toHaveText(UNDELIVERABLE)
  // The controller's own line stays readable behind Output.
  await outcome.getByText('Output').click()
  await expect(outcome.locator('pre')).toContainText('is recorded undeliverable and was not typed (pane_busy)')
  await attach(page, testInfo, 'note-control-undeliverable')
  await dialog(page).getByTestId('dialog-cancel').click()
  // The dock's Controls row leads with the same sentence.
  const dock = liveDock(page)
  if ((await dock.getAttribute('data-open')) !== 'true') await page.getByTestId('live-dock-bar').click()
  await expect(dock.getByTestId('controls-row')).toHaveAttribute('data-control', 'note')
  await expect(dock.getByTestId('control-headline')).toHaveText(UNDELIVERABLE)

  // Typed, but Enter did not submit it: the text is still in the pane's input line.
  mock.answer = 'enter_not_submitted'
  await open(page, teamPage)
  await laneNote(page, 'ui').click()
  await dialog(page).getByTestId('param-text').fill(NOTE_TEXT)
  await dialog(page).getByTestId('dialog-confirm').click()
  await expect(dialog(page).getByTestId('dialog-outcome-sentence')).toHaveText("The note is still in ui's input line: submit or clear it in the pane, and do not send it again.")
  await expect(dialog(page).getByTestId('dialog-outcome')).toHaveAttribute('data-tone', 'warn')
  expect(mock.posts).toHaveLength(2)
  await page.setViewportSize(PHONE)
  await expect.poll(() => page.evaluate('document.documentElement.scrollWidth') as Promise<number>).toBeLessThanOrEqual(PHONE.width)
})

test(`[regression:note-request-id-rule] The note dialog keeps its request_id only for a retry after a network failure with an unchanged note; an edited note is a new request (${phase})`, async ({ page }) => {
  const mock = await installNoteMocks(page)
  const isNotePost = (url: URL) => /\/api\/run-controls\/.*\/note$/.test(url.pathname)
  const sent: string[] = []
  page.on('request', request => { if (request.method() === 'POST' && isNotePost(new URL(request.url()))) sent.push((request.postDataJSON() as { request_id: string }).request_id) })
  // The first two POSTs never reach the server (a lost answer); later ones do.
  let dropped = 0
  await page.route(isNotePost, async route => {
    if (dropped < 2) { dropped += 1; await route.abort('connectionrefused'); return }
    await route.fallback()
  })
  await open(page, teamPage)
  await laneNote(page, 'ui').click()
  await expectNoteDialog(page, 'ui')
  const text = dialog(page).getByTestId('param-text')
  await text.fill(NOTE_TEXT)
  await dialog(page).getByTestId('dialog-confirm').click()
  await expect(dialog(page).getByTestId('dialog-alert')).toBeVisible()
  await expect(dialog(page).getByTestId('dialog-confirm')).toBeEnabled()
  await dialog(page).getByTestId('dialog-confirm').click()
  await expect.poll(() => sent.length).toBe(2)
  await expect(dialog(page).getByTestId('dialog-confirm')).toBeEnabled()
  expect(sent[1]).toBe(sent[0])
  await text.fill(`${NOTE_TEXT} Also keep the 44 px targets.`)
  await dialog(page).getByTestId('dialog-confirm').click()
  await expect(dialog(page).getByTestId('dialog-outcome')).toHaveAttribute('data-state', 'succeeded')
  expect(sent).toHaveLength(3)
  expect(sent[2]).not.toBe(sent[0])
  expect(mock.posts).toHaveLength(1)
  expect(mock.posts[0]!.request_id).toBe(sent[2])
})
