/**
 * Run-sessions in the viewer (docs/PRD_RUN_SESSIONS.md 3.1-3.5): every session that worked on a run is visible on the run
 * page. The stage carries a card per reviewer and the panel before the review gate and a lane-review card after each verify
 * step; every node page that belongs to a session shows a session block with a resume command for Claude sessions; the run
 * page has a Sessions section with both totals and a linked night-shift count; the night-shift decisions show on the node
 * they decided. Both phases read `fixtures/sessions.ts`: the worker phase through the mocks, the candidate phase from the
 * seeded run directories and night-shift folder (the parity spec proves both serve the same payload). The resume form
 * branches on the phase ([L1]: the candidate test root is outside HOME, so even the exposed project gets the bare form).
 */
import { test, expect, type Page } from '@playwright/test'
import type { SessionRow } from '../../contracts/projects/sessions.ts'
import { costText, durationText, groupSessions, totalsText } from '../../src/projects/sessions/model.ts'
import { RUN_SUCCEEDED, UNEXPOSED_PROJECT } from './fixtures.ts'
import { RUN_IDENTICAL, UX_RUN_WORKFLOW_ID } from './fixtures/ux-run.ts'
import {
  LANE_FINDINGS, NIGHT, NO_FIX_REASON, ROUND2_FINDINGS, RUN_SESSIONS, RUN_SESSIONS_HIDDEN, RUN_SESSIONS_OLDER, SESSION, sessionsPayload,
  UX_SESSIONS_HIDDEN_WORKFLOW_ID, UX_SESSIONS_WORKFLOW_ID,
} from './fixtures/sessions.ts'
import { RUN_PANEL_OLD, UX_PANEL_WORKFLOW_ID } from './fixtures/ux-panel.ts'
import { attach, graphNode, installHooks, nodeDetail, openStepSheet, phase, renderedText, runUrl, stepSheet, workflowUrl } from './support.ts'

installHooks()

const runPage = (runId: string) => runUrl(runId, undefined, UX_SESSIONS_WORKFLOW_ID)
const nodePage = (runId: string, nodeId: string) => runUrl(runId, nodeId, UX_SESSIONS_WORKFLOW_ID)
const hiddenNodePage = (nodeId: string) => `${workflowUrl(UNEXPOSED_PROJECT.project_id, UX_SESSIONS_HIDDEN_WORKFLOW_ID)}/runs/${RUN_SESSIONS_HIDDEN}/nodes/${nodeId}`
const card = (page: Page, nodeId: string) => graphNode(page, nodeId)
const box = async (page: Page, nodeId: string) => (await card(page, nodeId).boundingBox())!
const PROJECTED = ['reviewer-general', 'reviewer-coverage', 'reviewer-critique', 'panel', 'lane-review-server-1', 'lane-review-viewer-1']
/** What the page shows, in both phases: the payload the seed and the mock agree on (bare resume in the candidate phase). */
const PAYLOAD = sessionsPayload(RUN_SESSIONS, UX_SESSIONS_WORKFLOW_ID, phase === 'worker' ? 'home' : 'bare', true)
const rowOf = (key: string) => PAYLOAD.sessions.find(row => row.key === key)!

test(`[scenario:sessions-stage] On the seeded sessions run, the stage shows 'Reviewer · general', 'Reviewer · coverage', 'Reviewer · critique' and 'Panel' as separate cards in the column before the review gate, each with its state word, open P0/P1 count and cost; a lane-review card follows each verify step; the gate, repairs and approval keep their places; the Now banner and the focus never land on a projected node; an older run adds only its reviewer node and panel-old has no Panel node (${phase})`, async ({ page }, testInfo) => {
  await page.goto(runPage(RUN_SESSIONS))
  await expect(page.getByTestId('run-view')).toBeVisible()
  // Each reviewer and the panel: its own card, label, state word, open P0/P1 count and cost.
  const expected: [string, string, string, string, string][] = [
    ['reviewer-general', 'Reviewer · general', 'blocked', '2', '$4.20 reported by Claude'],
    ['reviewer-coverage', 'Reviewer · coverage', 'late blocked', '1', '$3.10 reported by Claude'],
    ['reviewer-critique', 'Reviewer · critique', 'approved', '0', '$0.48 reported by Claude'],
    ['panel', 'Panel', 'reviewed', '1', '$1.10 reported by Claude · $0.20 covered'],
  ]
  for (const [id, label, word, open, cost] of expected) {
    await expect(card(page, id)).toHaveCount(1)
    await expect(card(page, id).locator('.n-label')).toHaveText(label)
    await expect(card(page, id).locator('.n-word')).toHaveText(word)
    await expect(card(page, id)).toContainText(`${open} open P0/P1`)
    await expect(card(page, id).locator('.n-cost')).toHaveText(cost)
  }
  // A blocked reviewer is a finished session that found problems: never drawn as a succeeded (green) card.
  for (const id of ['reviewer-general', 'reviewer-coverage']) await expect(card(page, id)).toHaveClass(/\btone-fail\b/)
  await expect(card(page, 'reviewer-critique')).toHaveClass(/\btone-ok\b/)
  // They sit side by side in one column, before the review gate.
  const review = await box(page, 'review')
  const reviewers = await Promise.all(['reviewer-general', 'reviewer-coverage', 'reviewer-critique', 'panel'].map(id => box(page, id)))
  for (const position of reviewers) {
    expect(position.x).toBeLessThan(review.x)
    expect(Math.abs(position.x - reviewers[0]!.x)).toBeLessThanOrEqual(2)
  }
  // A lane-review card follows each verify step, in its short form; repair 1 still follows verify_server.
  for (const [lane, word] of [['server', 'repair 1 started'], ['viewer', 'no fix round']] as const) {
    const id = `lane-review-${lane}-1`
    await expect(card(page, id).locator('.n-label')).toHaveText(`Lane review · ${lane} · round 1`)
    await expect(card(page, id).locator('.n-word')).toHaveText(word)
    await expect(card(page, id)).toContainText('1 open P0/P1')
    expect((await box(page, id)).x).toBeGreaterThan((await box(page, `verify_${lane}`)).x)
  }
  await expect(card(page, 'lane-review-server-1').locator('.n-cost')).toHaveText('$0.13 covered')
  await expect(card(page, 'lane-review-viewer-1').locator('.n-cost')).toHaveText('$0.20 covered')
  // The gate, the repairs and the approval keep their places: repair 1 after verify_server, review before approval.
  expect((await box(page, 'repair-1')).x).toBeGreaterThan((await box(page, 'verify_server')).x)
  expect((await box(page, 'approval')).x).toBeGreaterThan(review.x)
  expect((await box(page, 'repair-2')).x).toBeGreaterThan(review.x)
  // The Now banner and the focus never land on a projected card.
  const nowCards = page.locator('[data-testid="workflow-graph"] [data-graph-node].now')
  for (const id of await nowCards.evaluateAll(cards => cards.map(item => item.getAttribute('data-graph-node')))) expect(PROJECTED).not.toContain(id)
  const banner = await page.getByTestId('run-now').innerText()
  for (const label of ['Reviewer ·', 'Lane review ·']) expect(banner).not.toContain(label)
  // Each projected card names its own executor; the node page's header repeats the same phrase (sessions-reviewer).
  for (const [id, phrase] of [['reviewer-general', 'one reviewer'], ['panel', 'a multi-provider panel'], ['lane-review-server-1', 'one lane reviewer']] as const) {
    await expect(card(page, id)).toHaveAttribute('aria-label', new RegExp(`, executed by ${phrase}(, |$)`))
  }
  // The sheet of a reviewer card reads its session facts, never "the run waits elsewhere"; it points at the step page's
  // resume command instead of saying there is nothing to type.
  await openStepSheet(page, 'reviewer-general')
  await expect(stepSheet(page).getByTestId('sheet-facts')).toContainText(durationText(2400)!)
  await expect(stepSheet(page).getByTestId('sheet-facts')).toContainText('claude-opus-5-5')
  await expect(stepSheet(page).getByTestId('sheet-session-note')).toContainText('not a step the run waits at')
  await expect(stepSheet(page).getByTestId('sheet-session-note')).toContainText('Its resume command, when it has one, is on the step page.')
  await expect(stepSheet(page).getByTestId('sheet-session-note')).not.toContainText('nothing to type')
  await stepSheet(page).getByRole('button', { name: 'Close step details' }).click()
  await attach(page, testInfo, 'sessions-stage')

  // The older run (one listed reviewer, no lane review, no panel) adds only its reviewer node.
  await page.goto(runPage(RUN_SESSIONS_OLDER))
  await expect(card(page, 'review')).toHaveCount(1)
  const ids = await page.locator('[data-testid="workflow-graph"] [data-graph-node]').evaluateAll(cards => cards.map(item => item.getAttribute('data-graph-node')))
  expect(ids.sort()).toEqual(['approval', 'integrate', 'review', 'reviewer-review'])
  // The panel-old fixture (a pre-1.9.0 export beside a live panel.json) answers PANELS_NOT_FOUND: no Panel node.
  await page.goto(runUrl(RUN_PANEL_OLD, undefined, UX_PANEL_WORKFLOW_ID))
  await expect(card(page, 'review')).toHaveCount(1)
  await expect(card(page, 'panel')).toHaveCount(0)
})

test(`[scenario:sessions-lane-review] The 'Lane review · server · round 1' page lists its reviewer (transport, model, status, duration, cost), every finding with severity, file:line, title and detail, the snapshot's short sha and 'Fix round started: repair 1' linking to repair-1; the viewer round says the engine's no-fix words; each card says the same in short form (${phase})`, async ({ page }, testInfo) => {
  await page.goto(nodePage(RUN_SESSIONS, 'lane-review-server-1'))
  // The header names the lane reviewer and points at the result below, never "This step completed." beside its P1.
  await expect(page.getByTestId('node-executor')).toHaveText('one lane reviewer')
  await expect(page.getByTestId('node-status-meaning')).toHaveText('The lane review finished; its result is below.')
  const server = page.getByTestId('lane-review-body')
  const reviewer = server.getByTestId('lane-reviewer')
  await expect(reviewer).toHaveCount(1)
  for (const text of ['transport pi', 'model openai-codex/gpt-6.1-sol', 'status ok', `took ${durationText(28.1)}`, '$0.13 covered']) await expect(reviewer).toContainText(text)
  const finding = server.getByTestId('lane-review-finding')
  await expect(finding).toHaveCount(1)
  await expect(finding).toHaveAttribute('data-severity', 'P1')
  for (const text of ['P1', `${LANE_FINDINGS.server.file}:${LANE_FINDINGS.server.line}`, LANE_FINDINGS.server.title, LANE_FINDINGS.server.detail]) await expect(finding).toContainText(text)
  await expect(server.getByTestId('lane-review-snapshot')).toContainText('2635fbf')
  await expect(server.getByTestId('lane-review-result')).toContainText('0 P0, 1 P1')
  await expect(server.getByTestId('lane-review-fix-round')).toHaveText('Fix round started: repair 1')
  await renderedText(nodeDetail(page))
  await attach(page, testInfo, 'sessions-lane-review')
  await server.getByTestId('lane-review-repair-link').click()
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'repair-1')

  await page.goto(nodePage(RUN_SESSIONS, 'lane-review-viewer-1'))
  await expect(page.getByTestId('lane-review-fix-round')).toHaveText(`Recorded; no fix round: ${NO_FIX_REASON}`)
  await expect(page.getByTestId('lane-review-finding')).toContainText(`${LANE_FINDINGS.viewer.file}:${LANE_FINDINGS.viewer.line}`)
  await expect(page.getByTestId('lane-reviewer')).toContainText('$0.20 covered')
  // The stage cards say the same in short form, with the whole line in their sentence.
  await page.goto(runPage(RUN_SESSIONS))
  await expect(card(page, 'lane-review-server-1').locator('.n-word')).toHaveText('repair 1 started')
  await expect(card(page, 'lane-review-server-1').locator('.n-last')).toHaveText('0 P0, 1 P1. Fix round started: repair 1.')
  await expect(card(page, 'lane-review-viewer-1').locator('.n-word')).toHaveText('no fix round')
  await expect(card(page, 'lane-review-viewer-1').locator('.n-last')).toHaveText(`0 P0, 1 P1. Recorded; no fix round: ${NO_FIX_REASON}.`)
})

async function expectSessionFacts(page: Page, row: SessionRow) {
  const block = page.locator(`[data-testid="session-block"][data-session-key="${row.key}"]`)
  await expect(block.getByTestId('session-model')).toContainText(row.model!)
  await expect(block.getByTestId('session-transport')).toContainText(row.transport!)
  await expect(block.getByTestId('session-status')).toContainText(row.status)
  await expect(block.getByTestId('session-started').locator('time')).toHaveAttribute('datetime', row.started_at!)
  await expect(block.getByTestId('session-duration')).toContainText(durationText(row.duration_seconds)!)
  await expect(block.getByTestId('session-cost')).toContainText(costText(row.cost_usd, row.cost_kind))
  await expect(block.getByTestId('session-id')).toContainText(row.session_id!)
  return block
}

test(`[scenario:sessions-reviewer] The 'Reviewer · general' page shows its session block and resume command (the ~/ form on the exposed project in the worker phase, the bare form with "run it in the session's worktree" on the unexposed one), its verdict and only its own findings, its earlier round's verdict; coverage says late blocked; the critique page shows its session and findings; no absolute path (${phase})`, async ({ page }, testInfo) => {
  await page.goto(nodePage(RUN_SESSIONS, 'reviewer-general'))
  // The header names the reviewer as its stage card does and leads with its (blocked) verdict, never "This step completed."
  // ([scenario:reviewer-verdict] below checks the lead in full).
  await expect(page.getByTestId('node-executor')).toHaveText('one reviewer')
  await expect(page.getByTestId('node-status-meaning')).toHaveText('Blocked · round 2 · 2 open P1 · session succeeded')
  const body = page.getByTestId('reviewer-body')
  await expect(body.getByTestId('reviewer-verdict')).toContainText('blocked')
  await expect(body.getByTestId('reviewer-verdict')).toContainText('round 2')
  // Only its own findings of the latest round: two P1 (one open, one accepted, both still blocking) and a P2, nothing of coverage's.
  const findings = body.getByTestId('reviewer-findings').getByTestId('finding')
  await expect(findings).toHaveCount(ROUND2_FINDINGS.general.length)
  for (const finding of ROUND2_FINDINGS.general) await expect(body.getByTestId('reviewer-findings')).toContainText(finding.message)
  await expect(body.getByTestId('reviewer-findings')).not.toContainText(ROUND2_FINDINGS.coverage[0]!.message)
  await expect(body.getByTestId('reviewer-earlier')).toContainText('Round 1: blocked')
  const block = await expectSessionFacts(page, rowOf('reviewer:general:2'))
  const command = block.getByTestId('session-resume-command')
  if (phase === 'worker') {
    await expect(command).toHaveText(`cd ~/'runs/ux-sessions/sessions-run/review-worktree' && claude --resume ${SESSION.general}`)
    await expect(block.getByTestId('session-resume-note')).toHaveCount(0)
  } else {
    await expect(command).toHaveText(`claude --resume ${SESSION.general}`)
    await expect(block.getByTestId('session-resume-note')).toHaveText("run it in the session's worktree")
  }
  await renderedText(nodeDetail(page))
  await attach(page, testInfo, 'sessions-reviewer')

  // The unexposed project never serves the `~/` form, in either phase.
  await page.goto(hiddenNodePage('reviewer-general'))
  const hidden = page.getByTestId('reviewer-body').getByTestId('session-block')
  await expect(hidden.getByTestId('session-resume-command')).toHaveText(`claude --resume ${SESSION.general}`)
  await expect(hidden.getByTestId('session-resume-note')).toHaveText("run it in the session's worktree")
  await renderedText(nodeDetail(page))

  await page.goto(nodePage(RUN_SESSIONS, 'reviewer-coverage'))
  await expect(page.getByTestId('reviewer-verdict')).toContainText('late blocked')
  await expect(page.getByTestId('reviewer-findings')).toContainText(ROUND2_FINDINGS.coverage[0]!.message)
  await page.goto(nodePage(RUN_SESSIONS, 'reviewer-critique'))
  await expect(page.getByTestId('reviewer-verdict')).toContainText('approved')
  await expect(page.getByTestId('reviewer-findings')).toContainText(ROUND2_FINDINGS.critique[0]!.message)
  await expectSessionFacts(page, rowOf('reviewer:critique:2'))
  await expect(page.getByTestId('session-resume-command')).toHaveText(`claude --resume ${SESSION.critique}`)
  await renderedText(nodeDetail(page))
})

/** The Sessions table by value: every session of the payload in its order, grouped by role, one line each; Claude rows offer the command, others do not. */
async function expectSessionsTable(page: Page, rowHeightMax: number | null) {
  const section = page.getByTestId('sessions-section')
  await expect(section).toBeVisible()
  await expect(section.getByTestId('sessions-totals')).toHaveText(totalsText(PAYLOAD.totals))
  const groups = groupSessions(PAYLOAD)
  await expect(section.locator('[data-testid^="session-group-"]')).toHaveCount(groups.length)
  let claudeRows = 0
  for (const group of groups) {
    const rows = section.getByTestId(`session-group-${group.role}`).getByTestId('session-row')
    // Every session of the role, in the payload's start order.
    await expect(rows).toHaveCount(group.rows.length)
    expect(await rows.evaluateAll(items => items.map(item => item.getAttribute('data-session-key')))).toEqual(group.rows.map(row => row.key))
    for (const [index, row] of group.rows.entries()) {
      const line = rows.nth(index)
      if (row.node_id) await expect(line.getByTestId('session-row-link')).toHaveAttribute('href', new RegExp(`/nodes/${row.node_id}$`))
      await expect(line.locator('.ss-row-label')).toHaveText(row.label)
      await expect(line.locator('[data-fact="model"]')).toContainText(row.model ?? 'model not recorded')
      await expect(line.locator('[data-fact="status"]')).toContainText(row.status)
      if (row.started_at) await expect(line.locator('[data-fact="started"] time')).toHaveAttribute('datetime', row.started_at)
      else await expect(line.locator('[data-fact="started"]')).toHaveText('start not recorded')
      await expect(line.locator('[data-fact="duration"]')).toHaveText(durationText(row.duration_seconds) ?? 'duration not recorded')
      await expect(line.locator('[data-fact="cost"]')).toHaveText(costText(row.cost_usd, row.cost_kind))
      await expect(line.locator('[data-fact="session"]')).toHaveText(row.session_id ?? 'no session id')
      if (rowHeightMax !== null) expect((await line.boundingBox())!.height, `${row.label} is one line`).toBeLessThanOrEqual(rowHeightMax)
      // Claude Code sessions offer one Copy and a Show command toggle; pi and night-shift rows never do.
      await expect(line.getByTestId('session-resume')).toHaveCount(row.resume ? 1 : 0)
      await expect(line.getByRole('button')).toHaveCount(row.resume ? 2 : 0)
      if (row.resume) {
        claudeRows += 1
        await expect(line.getByRole('button', { name: /^Copy/ })).toHaveCount(1)
        await expect(line.getByTestId('session-resume-command')).toHaveCount(0)
        const toggle = line.getByTestId('session-resume-toggle')
        await expect(toggle).toHaveText('Show command')
        await expect(toggle).toHaveAttribute('aria-expanded', 'false')
        await toggle.click()
        await expect(toggle).toHaveText('Hide command')
        await expect(line.getByTestId('session-resume-command')).toHaveText(row.resume.command)
        if (row.resume.dir === null) await expect(line.getByTestId('session-resume-note')).toHaveText("run it in the session's worktree")
        await toggle.click()
        await expect(line.getByTestId('session-resume-command')).toHaveCount(0)
      }
    }
  }
  expect(claudeRows, 'the payload has Claude rows').toBeGreaterThan(0)
  await expect(section.getByTestId('session-group-lane_reviewer').getByTestId('session-resume')).toHaveCount(0)
  return section
}

test(`[scenario:sessions-list] The run page's Sessions table lists every seeded session in start order grouped by role, each row with label, linked node, model, status, started, duration, cost and session id, and the totals by value; Claude rows offer Copy and a Show command toggle and pi rows do not; no absolute path is rendered (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(runPage(RUN_SESSIONS))
  const section = await expectSessionsTable(page, 56)
  // The live dock's Spent reads the same totals, never "not recorded" beside them.
  await expect(page.getByTestId('run-spent')).toContainText('reported by Claude')
  await renderedText(section)
  await attach(page, testInfo, 'sessions-list')
})

const stageBottom = async (page: Page) => { const stage = (await page.getByTestId('run-stage').boundingBox())!; return stage.y + stage.height }

test(`[scenario:sessions-cue] A one-line cue directly under the stage reads "Sessions · <n> · <Spent> ↓" and is a link that scrolls to the Sessions heading and focuses it; the Sessions table is by value, one line a row; a run without sessions has no cue and a full-height stage (${phase})`, async ({ page }, testInfo) => {
  test.slow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(runPage(RUN_SESSIONS))
  const cue = page.getByTestId('sessions-cue')
  await expect(cue).toBeVisible()
  const count = groupSessions(PAYLOAD).reduce((sum, group) => sum + group.rows.length, 0)
  const spent = (await page.getByTestId('run-spent').innerText()).trim()
  await expect(cue).toHaveText(`Sessions · ${count} · ${spent} ↓`)
  expect(spent, 'metered and covered apart, never one summed figure').toMatch(/reported by Claude · .* covered$/)
  // A link, not a button; a sibling right under the stage, neither inside the stage nor the dock.
  expect(await cue.evaluate(element => element.tagName)).toBe('A')
  await expect(page.getByRole('button', { name: /^Sessions ·/ })).toHaveCount(0)
  expect(await page.getByTestId('run-stage').evaluate(stage => stage.nextElementSibling?.getAttribute('data-testid'))).toBe('sessions-cue')
  expect(await cue.evaluate(element => element.closest('[data-testid=run-stage], [data-testid=live-dock]') === null)).toBe(true)
  // One line, in the first screen; the stage ends above it.
  const cueBox = (await cue.boundingBox())!
  expect(cueBox.height).toBeLessThanOrEqual(40)
  expect(cueBox.y + cueBox.height).toBeLessThanOrEqual(900)
  expect(await stageBottom(page)).toBeLessThanOrEqual(cueBox.y + 0.5)
  expect((await page.getByTestId('run-stage').boundingBox())!.height).toBeGreaterThanOrEqual(420)
  await attach(page, testInfo, 'sessions-cue')

  // Activating it from the keyboard scrolls the Sessions heading into view and focuses it; the address and the history stay.
  const [url, length] = [page.url(), await page.evaluate('history.length') as number]
  await cue.focus()
  await page.keyboard.press('Enter')
  const heading = page.getByRole('heading', { name: 'Sessions', exact: true })
  await expect(heading).toBeFocused()
  await expect(heading).toBeInViewport()
  expect(page.url()).toBe(url)
  expect(await page.evaluate('history.length')).toBe(length)

  // The table, by value, each row at most 56 px tall.
  await expectSessionsTable(page, 56)

  // A run without sessions has no cue and its stage keeps the whole window.
  await page.goto(runUrl(RUN_IDENTICAL, undefined, UX_RUN_WORKFLOW_ID))
  await expect(page.getByTestId('run-stage')).toBeVisible()
  await expect(page.getByTestId('run-now')).toHaveAttribute('data-situation', /.+/)
  await expect(page.getByTestId('sessions-cue')).toHaveCount(0)
  await expect(page.getByTestId('sessions-section')).toHaveCount(0)
  await expect.poll(() => stageBottom(page)).toBeGreaterThanOrEqual(892)
  expect(await stageBottom(page)).toBeLessThanOrEqual(900)
})

test(`The Sessions cue follows the payload: absent while it is unread, present once it lists sessions with the stage giving up its line, and re-measured on a resize; on a phone it is a tall target (${phase})`, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route(url => url.pathname.endsWith(`/runs/${RUN_SESSIONS}/sessions`), async route => {
    await gate
    await route.fallback()
  })
  await page.goto(runPage(RUN_SESSIONS))
  await expect(page.getByTestId('run-stage')).toBeVisible()
  await expect(page.getByTestId('sessions-cue')).toHaveCount(0)
  await expect.poll(() => stageBottom(page)).toBeGreaterThanOrEqual(892)
  release()
  const cue = page.getByTestId('sessions-cue')
  await expect(cue).toBeVisible()
  await expect.poll(async () => (await stageBottom(page)) <= (await cue.boundingBox())!.y + 0.5).toBe(true)
  // A resize re-measures the stage under the cue.
  await page.setViewportSize({ width: 1440, height: 700 })
  await expect.poll(async () => { const box = (await cue.boundingBox())!; return box.y + box.height }).toBeLessThanOrEqual(700)
  expect(await stageBottom(page)).toBeLessThanOrEqual((await cue.boundingBox())!.y + 0.5)
  expect((await cue.boundingBox())!.height).toBeLessThanOrEqual(40)
  // At 1024 px the cue is still one line.
  await page.setViewportSize({ width: 1024, height: 900 })
  await expect.poll(async () => (await cue.boundingBox())!.height).toBeLessThanOrEqual(40)
  // On a phone the cue is a tall target.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(async () => (await cue.boundingBox())!.height).toBeGreaterThanOrEqual(44)
})

test(`An operator's Fit or zoom is kept when the sessions arrive and when a scrollbar-sized width change follows; a width change of 24 px or more re-fits it (${phase})`, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route(url => url.pathname.endsWith(`/runs/${RUN_SESSIONS}/sessions`), async route => {
    await gate
    await route.fallback()
  })
  await page.goto(runPage(RUN_SESSIONS))
  await expect(card(page, 'lane-review-server-1')).toHaveCount(1)
  await expect(page.getByTestId('sessions-cue')).toHaveCount(0)
  const world = page.getByTestId('run-stage').locator('.sb-world')
  await page.getByRole('button', { name: 'Fit the graph' }).click()
  for (let step = 0; step < 6 && (await world.getAttribute('data-level')) !== '0'; step++) {
    await page.getByRole('button', { name: 'Zoom out' }).click()
  }
  await expect(world).toHaveAttribute('data-level', '0')
  const transform = await world.evaluate(element => element.getAttribute('style'))
  release()
  await expect(page.getByTestId('sessions-cue')).toBeVisible()
  const kept = async () => {
    const start = Date.now()
    while (Date.now() - start < 1000) {
      expect(await world.getAttribute('data-level')).toBe('0')
      expect(await world.evaluate(element => element.getAttribute('style'))).toBe(transform)
      await page.waitForTimeout(100)
    }
  }
  await kept()
  // A scrollbar appearing is about 15 px: the operator's view stays, narrowing and widening back.
  await page.setViewportSize({ width: 1425, height: 900 })
  await kept()
  await page.setViewportSize({ width: 1440, height: 900 })
  await kept()
  // A real width change re-fits it.
  await page.setViewportSize({ width: 1380, height: 900 })
  await expect.poll(() => world.evaluate(element => element.getAttribute('style'))).not.toBe(transform)
})

test(`At the overview of the sessions run, every chip label, the projected reviewer, panel and lane-review cards included, is whole on at most two lines (${phase})`, async ({ page }) => {
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(runPage(RUN_SESSIONS))
    await expect(card(page, 'lane-review-server-1')).toHaveCount(1)
    await page.getByRole('button', { name: 'Fit the graph' }).click()
    // The fit may land at the standard level on a graph this size: zoom out until the stage is at the overview.
    for (let step = 0; step < 6 && (await page.getByTestId('stage-level').getAttribute('data-level')) !== '0'; step++) {
      await page.getByRole('button', { name: 'Zoom out' }).click()
    }
    await expect(page.getByTestId('run-stage').locator('.sb-world')).toHaveAttribute('data-level', '0')
    const chips = await page.locator('[data-chip-label]').evaluateAll(labels => labels.map(label => {
      const style = (globalThis as unknown as { getComputedStyle: (node: unknown) => { lineHeight: string; fontSize: string } }).getComputedStyle(label.parentElement!)
      const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.15
      return { text: label.textContent ?? '', cut: label.scrollWidth > label.clientWidth, lines: label.clientHeight / lineHeight }
    }))
    expect(chips.length).toBeGreaterThan(8)
    for (const chip of chips) {
      expect(chip.cut, `${width} px: "${chip.text}" is not cut`).toBe(false)
      expect(chip.lines, `${width} px: "${chip.text}" is on at most two lines`).toBeLessThanOrEqual(2.2)
    }
  }
})

test(`[scenario:sessions-panel] The Panel page shows the providers with model, status, cost and findings; the approval page the held night-shift decision (kind, each provider's option, text, confidence word and needs-the-operator, agreement, 'Jev not called', 'Held: <reason>'); the challenge page the executed one with its redacted command; another run's record never shows; the run page's count links to them (${phase})`, async ({ page }, testInfo) => {
  await page.goto(nodePage(RUN_SESSIONS, 'panel'))
  const providers = page.getByTestId('panel-section').getByTestId('panel-provider')
  await expect(providers).toHaveCount(2)
  await expect(providers.nth(0).getByTestId('panel-provider-name')).toContainText('openai-codex/gpt-6-sol')
  // Today's panel section words a pi provider's cost as subscription-covered (contract 1.9.0); its session block gives the estimate.
  await expect(providers.nth(0).getByTestId('panel-cost')).toContainText('subscription-covered')
  await expect(providers.nth(0).getByTestId('panel-provider-status')).toBeVisible()
  await expect(providers.nth(1).getByTestId('panel-cost')).toContainText('1.10')
  await expect(page.getByTestId('panel-section').getByTestId('panel-title')).toContainText('panel finding')
  const blocks = page.getByTestId('panel-sessions').getByTestId('session-block')
  await expect(blocks).toHaveCount(2)
  await expect(blocks.nth(0).getByTestId('session-model')).toHaveText('openai-codex/gpt-6-sol')
  await expect(blocks.nth(0).getByTestId('session-status')).toHaveText('succeeded')
  await expect(blocks.nth(0).getByTestId('session-cost')).toHaveText('$0.20 covered')
  await expect(blocks.nth(0).getByTestId('session-findings')).toHaveText('P0 0 · P1 1 · P2 0')
  await expect(blocks.nth(1).getByTestId('session-cost')).toHaveText('$1.10 reported by Claude')
  await renderedText(nodeDetail(page))
  await attach(page, testInfo, 'sessions-panel')

  // The approval node: the held decision in full.
  await page.goto(nodePage(RUN_SESSIONS, 'approval'))
  const held = page.getByTestId('night-shift-decision')
  await expect(held).toHaveCount(1)
  await expect(held).toHaveAttribute('data-decision', 'held')
  await expect(held.getByTestId('night-shift-kind')).toHaveText('awaiting_approval')
  const provider = NIGHT.approval.providers[0]!
  await expect(held.getByTestId('night-shift-provider')).toContainText(`${provider.name}${provider.option} · confidence ${provider.confidence} · needs the operator`)
  await expect(held.getByTestId('night-shift-provider')).toContainText(provider.text)
  await expect(held.getByTestId('night-shift-agreement')).toHaveText(`Agreement: ${NIGHT.approval.agreement}`)
  await expect(held.getByTestId('night-shift-jev')).toHaveText('Jev not called (one provider)')
  await expect(held.getByTestId('night-shift-outcome')).toHaveText(`Held: ${NIGHT.approval.held}`)
  await expect(held.getByTestId('night-shift-command')).toHaveCount(0)

  // The challenge node: the executed one, Jev's pick with confidence and pass-floor, the command redacted.
  await page.goto(nodePage(RUN_SESSIONS, 'challenge'))
  const executed = page.getByTestId('night-shift-decision')
  await expect(executed).toHaveCount(1)
  await expect(executed).toHaveAttribute('data-decision', 'executed')
  await expect(executed.getByTestId('night-shift-outcome')).toHaveText('Executed')
  await expect(executed.getByTestId('night-shift-provider')).toHaveCount(2)
  await expect(executed.getByTestId('night-shift-provider').nth(1)).toContainText('accept-challenge · confidence high')
  await expect(executed.getByTestId('night-shift-jev')).toHaveText('Jev picked claude · confidence 0.82 · passed the floor')
  await expect(executed.getByTestId('night-shift-command')).toHaveText('Ran cd <path> && python -m workflow resume <path> --accept-challenge "clarified" --by panel')
  await renderedText(nodeDetail(page))
  // Another run's record of the same id (its directory is the hidden run's) never shows, on any node of this run.
  await page.goto(nodePage(RUN_SESSIONS, 'review'))
  await expect(page.getByTestId('night-shift-decision')).toHaveCount(0)
  await expect(page.getByText('FOREIGN RECORD MUST NOT SHOW')).toHaveCount(0)

  // The run page's one-line count links to the nodes it counts.
  await page.goto(runPage(RUN_SESSIONS))
  await expect(page.getByTestId('night-shift-count-text')).toHaveText('2 panel decisions: 1 executed, 1 held')
  const links = page.getByTestId('night-shift-link')
  await expect(links).toHaveText(['Design challenge: executed', 'Integration approval: held'])
  await links.nth(1).click()
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'approval')
  await expect(page.getByTestId('night-shift-decision')).toHaveAttribute('data-decision', 'held')
})

test(`[scenario:sessions-phone] At 390 px the reviewer, panel and lane-review cards stack in the stage's top-to-bottom flow, the Sessions list reads as one column per session with no horizontal page scroll, and every link and button in the Sessions list and the session blocks is at least 44 px tall (${phase})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto(runPage(RUN_SESSIONS))
  await expect(page.getByTestId('run-stage')).toHaveAttribute('data-direction', 'TB')
  // Top to bottom: the reviewer and panel cards share a row above the review gate; each lane review sits below its verify step.
  const review = await box(page, 'review')
  const reviewers = await Promise.all(['reviewer-general', 'reviewer-coverage', 'reviewer-critique', 'panel'].map(id => box(page, id)))
  for (const position of reviewers) {
    expect(position.y).toBeLessThan(review.y)
    expect(Math.abs(position.y - reviewers[0]!.y)).toBeLessThanOrEqual(2)
  }
  for (const lane of ['server', 'viewer']) expect((await box(page, `lane-review-${lane}-1`)).y).toBeGreaterThan((await box(page, `verify_${lane}`)).y)
  const section = page.getByTestId('sessions-section')
  await section.scrollIntoViewIfNeeded()
  const noSideways = async () => {
    const [scroll, client] = await page.evaluate(() => {
      const root = (globalThis as unknown as { document: { documentElement: { scrollWidth: number; clientWidth: number } } }).document.documentElement
      return [root.scrollWidth, root.clientWidth]
    })
    expect(scroll).toBeLessThanOrEqual(client + 1)
  }
  await noSideways()
  // One column per session: every row spans the section's width, its facts stacked under its label.
  const sectionBox = (await section.boundingBox())!
  const rows = section.getByTestId('session-row')
  for (let i = 0; i < await rows.count(); i += 1) {
    const rowBox = (await rows.nth(i).boundingBox())!
    expect(rowBox.width).toBeGreaterThan(sectionBox.width - 4)
  }
  // Every Claude row's resume command stays behind its Show command toggle, so the list stays one short block per row.
  await expect(section.getByTestId('session-resume-toggle')).toHaveCount(PAYLOAD.sessions.filter(row => row.resume).length)
  await expect(section.getByTestId('session-resume-command')).toHaveCount(0)
  const minHeight = async (scope: ReturnType<Page['locator']>) => {
    await expect(scope.first()).toBeVisible()
    const controls = scope.locator('a:visible, button:visible, summary:visible')
    const count = await controls.count()
    expect(count).toBeGreaterThan(0)
    for (let i = 0; i < count; i += 1) {
      const target = (await controls.nth(i).boundingBox())!
      expect(target.height, await controls.nth(i).innerText()).toBeGreaterThanOrEqual(44)
    }
  }
  await minHeight(section)
  await attach(page, testInfo, 'sessions-phone')
  // The session blocks of a node page, and the lane review's repair link, at the same size.
  await page.goto(nodePage(RUN_SESSIONS, 'reviewer-general'))
  await minHeight(page.getByTestId('session-block'))
  await noSideways()
  await page.goto(nodePage(RUN_SESSIONS, 'lane-review-server-1'))
  await minHeight(page.getByTestId('lane-review-fix-round'))
  await noSideways()
  await page.goto(nodePage(RUN_SESSIONS, 'challenge'))
  await minHeight(page.getByTestId('session-section'))
  await noSideways()
})

test(`[scenario:reviewer-verdict] A reviewer's page leads with its verdict ('Blocked · round 2 · 2 open P1') and shows the session's outcome as neutral metadata; an approving reviewer leads with 'Approved · round 2'; the step strip tones each reviewer chip by its verdict and agrees with the graph; a worker still reads 'not workflow completion' (${phase})`, async ({ page }, testInfo) => {
  test.slow()
  await page.setViewportSize({ width: 1440, height: 900 })
  const lead = page.getByTestId('node-verdict')
  const chip = (id: string) => page.getByTestId('run-node-list').locator(`li[data-node-id="${id}"]`)

  await page.goto(nodePage(RUN_SESSIONS, 'reviewer-general'))
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'reviewer-general')
  await expect(lead).toHaveText('Blocked · round 2 · 2 open P1')
  await expect(lead).toHaveAttribute('data-verdict', 'blocked')
  await expect(page.getByTestId('node-status-meaning')).toHaveText('Blocked · round 2 · 2 open P1 · session succeeded')
  await expect(page.getByTestId('node-verdict-outcome')).toHaveText('· session succeeded')
  await expect(page.getByTestId('node-verdict-outcome')).toHaveClass(/projects-muted/)
  await expect(page.getByTestId('node-header')).not.toContainText('This step completed.')
  // The step strip: each reviewer chip carries the verdict and its tone; the li keeps the step's own status.
  await expect(chip('reviewer-general')).toHaveAttribute('data-status', 'succeeded')
  await expect(chip('reviewer-general').locator('.step-chip')).toHaveAttribute('data-verdict', 'blocked')
  await expect(chip('reviewer-general').locator('.step-chip')).toHaveClass(/\btone-fail\b/)
  await expect(chip('reviewer-coverage').locator('.step-chip')).toHaveAttribute('data-verdict', 'blocked')
  await expect(chip('reviewer-coverage').locator('.step-chip')).toHaveClass(/\btone-fail\b/)
  await expect(chip('reviewer-critique')).toHaveAttribute('data-status', 'succeeded')
  await expect(chip('reviewer-critique').locator('.step-chip')).toHaveAttribute('data-verdict', 'approved')
  await expect(chip('reviewer-critique').locator('.step-chip')).toHaveClass(/\btone-ok\b/)
  await attach(page, testInfo, 'reviewer-verdict')

  await page.goto(nodePage(RUN_SESSIONS, 'reviewer-coverage'))
  await expect(lead).toHaveText('Late, blocked · round 2 · 1 open P1')
  await page.goto(nodePage(RUN_SESSIONS, 'reviewer-critique'))
  await expect(lead).toHaveText('Approved · round 2')
  await expect(lead).toHaveAttribute('data-verdict', 'approved')
  await expect(page.getByTestId('node-verdict-outcome')).toHaveText('· session succeeded')
  await expect(page.getByTestId('node-header')).not.toContainText('This step completed.')

  // The combined review leads with its verdict as well.
  await page.goto(nodePage(RUN_SESSIONS, 'review'))
  await expect(lead).toHaveText('Blocked · round 2 · 3 open P1')
  await expect(page.getByTestId('node-header')).not.toContainText('This step completed.')

  // The graph agrees with the strip on each reviewer's tone.
  await page.goto(runPage(RUN_SESSIONS))
  for (const id of ['reviewer-general', 'reviewer-coverage']) await expect(card(page, id)).toHaveClass(/\btone-fail\b/)
  await expect(card(page, 'reviewer-critique')).toHaveClass(/\btone-ok\b/)

  // A worker keeps its wording.
  await page.goto(runUrl(RUN_SUCCEEDED, 'launch_adapter'))
  await expect(page.getByTestId('node-status-meaning')).toContainText('not workflow completion')
  await expect(page.getByTestId('node-verdict')).toHaveCount(0)
})
