/**
 * Workflow guardrails in the viewer (PRD_PORTABLE_WORKFLOW section 6, slice 2, ui lane): the design challenge node's page,
 * the completion evidence and questions on a launch node, `decisions.md` on the Assignment page, and inert run Markdown.
 * The `guarded-flow` runs are 1.5.0 exports whose graph starts with the challenge: an integrated run, one waiting on an
 * adapter question and one the controller blocked on a fourth ui question. `clarity-flow`'s run and `feature-flow`'s runs
 * predate the guardrails and stand in for runs without evidence, questions, decisions or a challenge.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  ADAPTER_SESSION,
  CHALLENGE_ACCEPTED_REASON,
  CHALLENGE_ALTERNATIVE,
  CHALLENGE_EXPERIMENT,
  CHALLENGE_P1,
  CHALLENGE_P1_CONSEQUENCE,
  CHALLENGE_P2,
  CHALLENGE_P2_CONSEQUENCE,
  CHALLENGE_SESSION,
  CLARITY_WORKFLOW_ID,
  DEFAULT_REVIEWER_ID,
  GUARDED_ANSWERED_QUESTIONS,
  GUARDED_BLOCKED_ADAPTER_SUMMARY,
  GUARDED_FALSIFYING_CHECK,
  GUARDED_FILE_FINDING,
  GUARDED_FOURTH_QUESTION,
  GUARDED_FOURTH_SUMMARY,
  GUARDED_NOTES_PATH,
  GUARDED_QUESTIONS,
  GUARDED_UNTESTED,
  GUARDED_UI_SUMMARY,
  GUARDED_VERIFY_YOURSELF,
  GUARDED_WORKFLOW_ID,
  REMOTE_AUTOLINK_URL,
  REMOTE_HTML_IMAGE_URL,
  REMOTE_IMAGE_ALT,
  REMOTE_IMAGE_URL,
  REMOTE_LINK_TEXT,
  REMOTE_LINK_URL,
  RUN_FILES,
  RUN_GUARDED,
  RUN_GUARDED_ASKING,
  RUN_GUARDED_BLOCKED,
  RUN_SUCCEEDED,
  TWO_LANES,
} from './fixtures.ts'
import { attach, expectNoExecutionControls, graphNode, installHooks, nodeDetail, nodeListItem, phase, renderedText, runUrl } from './support.ts'

installHooks()

const guardedRunUrl = (nodeId?: string, runId: string = RUN_GUARDED) => runUrl(runId, nodeId, GUARDED_WORKFLOW_ID)
const clarityRunUrl = (runId: string, nodeId?: string) => runUrl(runId, nodeId, CLARITY_WORKFLOW_ID)
const questionItems = (page: Page) => page.getByTestId('worker-questions').getByTestId('worker-question')
const UI_BROWSER_COMMAND = 'npx --no-install playwright test --config=tests/project-workflows/playwright.config.ts'

/** The formatted times the viewer shows for an ISO timestamp (`formatTime`). */
const shown = (iso: string) => iso.replace('T', ' ').replace(/Z$/, ' UTC')

/**
 * Records every request the page makes to a host other than the local app and aborts it, so a regression shows up as a
 * recorded request rather than a real fetch. Returns the live list.
 */
async function recordRemoteRequests(page: Page): Promise<string[]> {
  const remote: string[] = []
  const isLocal = (url: URL) => url.protocol === 'data:' || url.protocol === 'blob:' || url.hostname === '127.0.0.1' || url.hostname === 'localhost'
  page.on('request', request => {
    const url = new URL(request.url())
    if (!isLocal(url)) remote.push(request.url())
  })
  await page.route(url => !isLocal(url), route => route.abort('blockedbyclient'))
  return remote
}

/** Rendered run Markdown is inert: no live link and no image element, the link text and targets shown as text, images as labelled placeholders. */
async function expectInert(rendered: Locator) {
  await expect(rendered.locator('a')).toHaveCount(0)
  await expect(rendered.locator('img')).toHaveCount(0)
  await expect(rendered.locator('[href], [src], [srcset]')).toHaveCount(0)
  const link = rendered.locator('.link-inert').filter({ hasText: REMOTE_LINK_TEXT })
  await expect(link).toBeVisible()
  await expect(link).toHaveAttribute('data-inert-link', REMOTE_LINK_URL)
  await expect(link).toContainText(REMOTE_LINK_URL)
  const image = rendered.getByRole('img', { name: new RegExp(REMOTE_IMAGE_ALT) })
  await expect(image).toBeVisible()
  await expect(image).toHaveAccessibleName(/image unavailable/)
  await expect(rendered.locator(`[data-inert-image="${REMOTE_IMAGE_URL}"]`)).toContainText(REMOTE_IMAGE_URL)
}

test(`[scenario:challenge-node-page] The graph starts with Design challenge; its page shows the status, the concerns by severity with consequences, the simpler alternative, the cheap experiment and the accepted reason (${phase})`, async ({ page }, testInfo) => {
  await page.goto(guardedRunUrl())

  // The challenge is the first node of the graph and of the node list, and every launch node depends on it.
  const listed = page.locator('[data-testid="run-node-list"] [data-node-id]')
  await expect(listed.first()).toHaveAttribute('data-node-id', 'challenge')
  await expect(listed.first()).toContainText('Design challenge')
  await expect(page.locator('[data-testid="workflow-graph"] [data-graph-node]').first()).toHaveAttribute('data-graph-node', 'challenge')
  await expect(graphNode(page, 'challenge')).toHaveAttribute('aria-label', /^Design challenge, review, .*executed by one print job$/)
  for (const lane of TWO_LANES) {
    await expect(page.locator(`[data-testid="workflow-graph"] [data-edge-from="challenge"][data-edge-to="launch_${lane}"]`)).toHaveCount(1)
  }
  const challengeX = await graphNode(page, 'challenge').boundingBox()
  const launchX = await graphNode(page, 'launch_ui').boundingBox()
  expect(challengeX!.x).toBeLessThan(launchX!.x)

  await graphNode(page, 'challenge').click()
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'challenge')
  await expect(page).toHaveURL(guardedRunUrl('challenge'))
  await expect(page.getByTestId('node-executor')).toHaveText('one print job')
  // It is not the independent review: no review panel is rendered for it.
  await expect(page.getByTestId('review-result')).toHaveCount(0)

  const challenge = page.getByTestId('challenge')
  await expect(challenge).toHaveAttribute('data-challenge-status', 'accepted')
  await expect(page.getByTestId('challenge-status')).toContainText('accepted')
  await expect(page.getByTestId('challenge-status')).toContainText('the operator overrode the concerns')
  await expect(page.getByTestId('challenge-attempts')).toContainText('2 attempts; this is attempt 2')
  await expect(challenge).toContainText(CHALLENGE_SESSION)

  // Concerns are grouped by severity, the most severe first, each with its consequence.
  const groups = page.getByTestId('challenge-severity')
  await expect(groups).toHaveCount(2)
  await expect(groups.nth(0)).toHaveAttribute('data-severity', 'P1')
  await expect(groups.nth(1)).toHaveAttribute('data-severity', 'P2')
  await expect(groups.nth(0)).toContainText('pauses the run unless accepted')
  const p1 = groups.nth(0).getByTestId('challenge-concern')
  await expect(p1).toHaveCount(1)
  await expect(p1).toHaveAttribute('data-kind', 'assumption')
  await expect(p1).toContainText(CHALLENGE_P1)
  await expect(p1.getByTestId('challenge-consequence')).toHaveText(`Consequence: ${CHALLENGE_P1_CONSEQUENCE}`)
  const p2 = groups.nth(1).getByTestId('challenge-concern')
  await expect(p2).toHaveCount(1)
  await expect(p2).toContainText(CHALLENGE_P2)
  await expect(p2.getByTestId('challenge-consequence')).toHaveText(`Consequence: ${CHALLENGE_P2_CONSEQUENCE}`)

  await expect(page.getByTestId('challenge-alternative')).toContainText(CHALLENGE_ALTERNATIVE)
  await expect(page.getByTestId('challenge-experiment')).toContainText(CHALLENGE_EXPERIMENT)
  await expect(page.getByTestId('challenge-accepted')).toContainText(CHALLENGE_ACCEPTED_REASON)
  await expect(page.getByTestId('projects-error')).toHaveCount(0)
  await renderedText(nodeDetail(page))
  await expectNoExecutionControls(page)
  await attach(page, testInfo, 'challenge-node-page')

  // A run prepared before the guardrails has no challenge node; its review node is still the independent review.
  await page.goto(clarityRunUrl(RUN_FILES))
  await expect(nodeListItem(page, 'challenge')).toHaveCount(0)
  await expect(page.locator('[data-testid="run-node-list"] [data-node-id]').first()).toHaveAttribute('data-node-id', 'launch_ui')
})

test(`[scenario:completion-evidence-shown] The launch node shows untested, the falsifying check linked to the verify node's check, and verify-yourself; a legacy run says evidence was not recorded (${phase})`, async ({ page }, testInfo) => {
  await page.goto(guardedRunUrl('launch_ui'))
  const completion = page.getByTestId('worker-completion')
  await expect(completion).toContainText(GUARDED_UI_SUMMARY)
  const evidence = completion.getByTestId('completion-evidence')
  await expect(evidence).toBeVisible()
  await expect(evidence.getByTestId('evidence-untested').locator('li')).toHaveText(GUARDED_UNTESTED)
  await expect(evidence.getByTestId('evidence-verify-yourself').locator('dd')).toHaveText(GUARDED_VERIFY_YOURSELF)

  // The falsifying check is a declared check id: it links to the verify node, naming the executed check it matched.
  const link = evidence.getByTestId('falsifying-check-link')
  await expect(link).toHaveAttribute('href', guardedRunUrl('verify_ui'))
  await expect(link).toHaveAttribute('data-check-id', GUARDED_FALSIFYING_CHECK)
  await expect(link).toHaveAttribute('data-check-index', '2')
  await expect(link).toContainText(GUARDED_FALSIFYING_CHECK)
  await expect(link).toContainText(UI_BROWSER_COMMAND)
  await expect(link).toContainText('executed as check 3')
  await renderedText(completion)
  await expectNoExecutionControls(page)
  await attach(page, testInfo, 'completion-evidence-shown')

  await link.click()
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'verify_ui')
  await expect(page.locator('#check-2 .check-command')).toHaveText(UI_BROWSER_COMMAND)

  // A fourth question is treated as blocked: the lane shows blocked with the refused question's text, not a question in the list.
  await page.goto(guardedRunUrl('launch_ui', RUN_GUARDED_BLOCKED))
  const refused = page.getByTestId('worker-completion')
  await expect(refused).toContainText(GUARDED_FOURTH_SUMMARY)
  await expect(refused.locator('.status-badge[data-status]')).toHaveAttribute('data-status', 'blocked')
  await expect(page.getByTestId('completion-question-refused')).toContainText('Treated as blocked: the worker asked a fourth question')
  await expect(page.getByTestId('completion-question-text')).toHaveText(GUARDED_FOURTH_QUESTION)
  await expect(page.getByTestId('completion-evidence')).toHaveCount(0)
  await expect(page.getByTestId('completion-evidence-none')).toHaveCount(0)
  await expect(nodeDetail(page)).not.toContainText('listed below')
  await expect(questionItems(page)).toHaveCount(GUARDED_ANSWERED_QUESTIONS.length)
  await expect(questionItems(page).filter({ hasText: GUARDED_FOURTH_QUESTION })).toHaveCount(0)
  await expect(page.getByTestId('question-waiting')).toHaveCount(0)

  // A 1.1.0 blocked completion without evidence says the worker blocked; it never claims to predate the evidence fields.
  await page.goto(guardedRunUrl('launch_adapter', RUN_GUARDED_BLOCKED))
  await expect(page.getByTestId('worker-completion')).toContainText(GUARDED_BLOCKED_ADAPTER_SUMMARY)
  await expect(page.getByTestId('completion-evidence-blocked')).toContainText('the worker blocked, and a blocked completion need not carry it')
  await expect(page.getByTestId('completion-evidence-none')).toHaveCount(0)
  await expect(page.getByTestId('completion-evidence')).toHaveCount(0)

  // A lane whose question the controller recorded has no completion file (it was moved): no signal, no evidence.
  await page.goto(guardedRunUrl('launch_adapter', RUN_GUARDED_ASKING))
  await expect(page.getByTestId('worker-completion')).toContainText('No completion signal recorded.')
  await expect(page.getByTestId('completion-evidence')).toHaveCount(0)
  await expect(nodeDetail(page)).toContainText(ADAPTER_SESSION)

  // A completion recorded before 1.1.0 is served with null evidence: the viewer says it was not recorded, never "nothing untested".
  for (const url of [clarityRunUrl(RUN_FILES, 'launch_ui'), runUrl(RUN_SUCCEEDED, 'launch_ui')]) {
    await page.goto(url)
    await expect(page.getByTestId('worker-completion')).toBeVisible()
    await expect(page.getByTestId('completion-evidence-none')).toContainText('Completion evidence was not recorded for this run')
    await expect(page.getByTestId('completion-evidence')).toHaveCount(0)
    await expect(page.getByTestId('falsifying-check-link')).toHaveCount(0)
  }
})

test(`[scenario:worker-questions-shown] Answered and waiting worker questions are listed with their times, and the waiting one is marked (${phase})`, async ({ page }, testInfo) => {
  // A run waiting on handoffs: the adapter's second question waits on the operator.
  await page.goto(guardedRunUrl('launch_adapter', RUN_GUARDED_ASKING))
  const questions = page.getByTestId('worker-questions')
  await expect(questions.getByRole('heading', { name: 'Questions to the operator' })).toBeVisible()
  await expect(questionItems(page)).toHaveCount(2)
  const [first, second] = GUARDED_QUESTIONS.adapter

  const answered = questionItems(page).nth(0)
  await expect(answered).toHaveAttribute('data-question', '1')
  await expect(answered).toHaveAttribute('data-answered', 'true')
  await expect(answered).toContainText(first.question)
  await expect(answered).toContainText(`asked at ${shown(first.asked_at)}`)
  await expect(answered.getByTestId('question-answer')).toContainText(first.answer!)
  await expect(answered.getByTestId('question-answer')).toContainText(`at ${shown(first.answered_at!)}`)
  await expect(answered.getByTestId('question-waiting')).toHaveCount(0)

  const waiting = questionItems(page).nth(1)
  await expect(waiting).toHaveAttribute('data-question', '2')
  await expect(waiting).toHaveAttribute('data-answered', 'false')
  await expect(waiting).toContainText(second.question)
  await expect(waiting).toContainText(`asked at ${shown(second.asked_at)}`)
  await expect(waiting.getByTestId('question-waiting')).toHaveText('Waiting on the operator')
  await expect(waiting.getByTestId('question-answer')).toHaveCount(0)
  await expect(page.getByTestId('worker-questions-waiting')).toContainText('One question is waiting on the operator')
  await expect(page.getByTestId('worker-questions-waiting')).toContainText('workflow answer')
  await renderedText(questions)
  await expectNoExecutionControls(page)
  await attach(page, testInfo, 'worker-questions-shown')

  // The ui lane's one question was answered: nothing is waiting there.
  await page.goto(guardedRunUrl('launch_ui', RUN_GUARDED_ASKING))
  await expect(questionItems(page)).toHaveCount(1)
  await expect(questionItems(page).first()).toHaveAttribute('data-answered', 'true')
  await expect(questionItems(page).first().getByTestId('question-answer')).toContainText(GUARDED_QUESTIONS.ui[0].answer!)
  await expect(page.getByTestId('question-waiting')).toHaveCount(0)
  await expect(page.getByTestId('worker-questions-waiting')).toHaveCount(0)

  // A run from before questions existed lists none.
  await page.goto(clarityRunUrl(RUN_FILES, 'launch_ui'))
  await expect(page.getByTestId('worker-questions-none')).toHaveText('No questions were recorded for this worker.')
})

test(`[scenario:decisions-shown] The Assignment page renders decisions.md as Markdown; a run without it says so (${phase})`, async ({ page }, testInfo) => {
  await page.goto(guardedRunUrl())
  await page.getByTestId('tab-assignment').click()
  const decisions = page.getByTestId('assignment-decisions')
  await expect(decisions.getByRole('heading', { name: 'Decisions', exact: true, level: 4 })).toBeVisible()
  const rendered = decisions.getByTestId('assignment-decisions-rendered')
  // Rendered, not source: its headings and list items are elements, and no Markdown syntax is left.
  await expect(rendered.getByRole('heading', { level: 1, name: 'Decisions: workflow guardrails' })).toBeVisible()
  await expect(rendered.getByRole('heading', { level: 2 })).toHaveText(['Decisions', 'Assumptions', 'Deferred'])
  await expect(rendered.getByRole('listitem').first()).toHaveText('The design challenge runs before any worker; a P0 or P1 pauses the run.')
  expect(await rendered.innerText()).not.toMatch(/^#|\]\(|!\[/m)
  await expect(page.getByTestId('assignment-decisions-none')).toHaveCount(0)
  await renderedText(decisions)
  await expectNoExecutionControls(page)
  await attach(page, testInfo, 'decisions-shown')

  // A run whose export predates decisions says it has none.
  for (const url of [clarityRunUrl(RUN_FILES), runUrl(RUN_SUCCEEDED)]) {
    await page.goto(url)
    await page.getByTestId('tab-assignment').click()
    await expect(page.getByTestId('assignment-decisions-none')).toContainText('No decisions.md was recorded for this run')
    await expect(page.getByTestId('assignment-decisions-rendered')).toHaveCount(0)
  }
})

test(`[scenario:inert-markdown] Captured Markdown and decisions.md with a remote image and an external link make no network request, and the link renders as text (${phase})`, async ({ page }, testInfo) => {
  const remote = await recordRemoteRequests(page)

  // The captured Markdown file on the launch node.
  await page.goto(guardedRunUrl('launch_ui'))
  const file = page.locator(`[data-testid="captured-file"][data-path="${GUARDED_NOTES_PATH}"]`)
  const fileRendered = file.getByTestId('file-rendered')
  await expect(fileRendered.getByRole('heading', { level: 1, name: 'Guardrail notes' })).toBeVisible()
  await fileRendered.scrollIntoViewIfNeeded()
  await expectInert(fileRendered)
  // A bare URL is autolinked by GFM and just as inert; raw HTML stays literal text.
  await expect(fileRendered.locator(`[data-inert-link="${REMOTE_AUTOLINK_URL}"]`)).toBeVisible()
  await expect(fileRendered).toContainText(`<img src="${REMOTE_HTML_IMAGE_URL}" alt="pixel">`)
  // A supporting screenshot; the verifier's evidence for the scenario is the single `screenshot:inert-markdown` below.
  await attach(page, testInfo, 'inert-markdown-file')

  // decisions.md on the Assignment page.
  await page.getByTestId('tab-assignment').click()
  const decisions = page.getByTestId('assignment-decisions-rendered')
  await expect(decisions).toBeVisible()
  await decisions.scrollIntoViewIfNeeded()
  await expectInert(decisions)
  // Worker tasks come from run data too and are rendered by the same inert Markdown.
  await expect(page.getByTestId('assignment-task').first().locator('.markdown')).toHaveAttribute('data-inert', 'true')
  await attach(page, testInfo, 'inert-markdown')

  await page.waitForLoadState('networkidle')
  expect(remote, 'rendering run Markdown must not contact any other host').toEqual([])
})

test(`On a guarded graph the captured files show the independent review's findings, never a review looked up through the design challenge (${phase})`, async ({ page }) => {
  // Both nodes are of kind review and the challenge comes first; its attempt (2) is not the review's (1), so a lookup through it finds none.
  await page.goto(guardedRunUrl())
  await expect(page.locator('[data-testid="run-node-list"] [data-node-id]').first()).toHaveAttribute('data-node-id', 'challenge')
  await expect(nodeListItem(page, 'challenge')).toContainText('attempt 2')
  await expect(nodeListItem(page, 'review')).toContainText('attempt 1')

  await page.goto(guardedRunUrl('launch_ui'))
  const file = page.locator(`[data-testid="captured-file"][data-path="${GUARDED_NOTES_PATH}"]`)
  const listed = file.getByTestId('file-findings').getByTestId('file-finding')
  await expect(listed).toHaveCount(1)
  await expect(listed).toContainText(GUARDED_FILE_FINDING)
  await expect(listed).toHaveAttribute('data-reviewer', DEFAULT_REVIEWER_ID)
  await expect(file.getByTestId('file-findings-no-review')).toHaveCount(0)
  await expect(page.getByTestId('projects-error')).toHaveCount(0)
})
