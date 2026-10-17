/**
 * The run's GitHub view (docs/PRD_RUN_TEAMS.md 4 "GitHub view", 11 P0 items 7-8 and P1 items 10-11): the answer banner per
 * section 4.2 situation with its exact sentence and the switcher suffix, the cards, the commands to run by hand (no
 * placeholder copyable), Copy run summary, the actions panel's four states and its records, and the publishing dialogs with
 * their exact copy, typed confirmation, `request_id` and `state_token`, and the 409 stale outcome. Worker phase only: the
 * fixtures (`fixtures/ux-run-github.ts`) are swapped per test in the maps the mocks read per request; the candidate phase
 * serves whatever the real server reads, and the server's own tests cover its read. Every scenario runs at 1440 × 900 and
 * 390 × 844 and asserts no sideways page scroll.
 */
import { test, expect, type Page } from '@playwright/test'
import type { RunGithub, RunGithubActions } from '../../contracts/projects/github.ts'
import { runSummaryMarkdown } from '../../contracts/projects/summary.ts'
import { githubPathname } from '../../src/projects/routes.ts'
import { summaryInput, type SituationId } from '../../src/projects/github/model.ts'
import { TOKEN_KEY } from '../../src/projects/controls/types.ts'
import { CONTROLS_TOKEN } from './fixtures/controls.ts'
import { runDetails, runInputs, PROJECT } from './fixtures.ts'
import { runGithubActionsByRun, runGithubByRun } from './fixtures/index.ts'
import {
  GITHUB_ACTIONS, GITHUB_BRANCH, GITHUB_PRIVATE_NOT_PUSHED, GITHUB_READ_AT, GITHUB_RUN, GITHUB_SITUATIONS, GITHUB_WORKFLOW_ID, UNPUBLISHED, uxRunGithub,
} from './fixtures/ux-run-github.ts'
import { installControlMocks, type ControlMock } from './mock.ts'
import { attach, expectNoExecutionControls, installHooks, phase, runViewLink } from './support.ts'

installHooks()

test.skip(phase !== 'worker', 'the GitHub view\'s fixtures are worker-phase mocks; the candidate server reads its own git and gh')

const pageUrl = githubPathname(PROJECT.project_id, GITHUB_WORKFLOW_ID, GITHUB_RUN)
const DEFAULT_READ = uxRunGithub.payloads!.runGithub![GITHUB_RUN]!
const DEFAULT_ACTIONS = uxRunGithub.payloads!.runGithubActions![GITHUB_RUN]!

/** Serves this read (and these offers) for the GitHub run until the test ends. */
function serve(read: RunGithub, actions: RunGithubActions = DEFAULT_ACTIONS) {
  runGithubByRun[GITHUB_RUN] = read
  runGithubActionsByRun[GITHUB_RUN] = actions
}

test.afterEach(() => serve(DEFAULT_READ, DEFAULT_ACTIONS))

const noSideways = (page: Page) => page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1') as Promise<boolean>

/** Opens the GitHub view at a desk, its clock at the read's time so every age is fixed; paired when asked. */
async function open(page: Page, options: { paired?: boolean } = {}) {
  await page.clock.install({ time: new Date(GITHUB_READ_AT) })
  if (options.paired) await page.addInitScript(`window.localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(CONTROLS_TOKEN)})`)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(pageUrl)
  await expect(page.getByTestId('gh-view')).toBeVisible()
  await expect(page.getByTestId('gh-banner')).toBeVisible()
}

/** The phone pass: one column, nothing sideways, the banner first. */
async function phone(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByTestId('gh-banner')).toBeVisible()
  expect(await noSideways(page), 'no sideways scroll at 390 px').toBe(true)
}

/** Paired, with the run controls mocked on; the offers come from `runGithubActionsByRun`. */
async function paired(page: Page): Promise<ControlMock> {
  const mock = await installControlMocks(page)
  await open(page, { paired: true })
  await expect(page.getByTestId('gh-actions')).toHaveAttribute('data-state', /offered|actions-off/)
  return mock
}

const dialog = (page: Page) => page.getByTestId('gh-dialog')
const confirm = (page: Page) => dialog(page).getByTestId('gh-dialog-confirm')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

async function openDialogFromPanel(page: Page, action: string) {
  await page.getByTestId('gh-actions').locator(`[data-testid="gh-action"][data-action="${action}"]`).getByTestId('gh-action-button').click()
  await expect(dialog(page)).toBeVisible()
  await expect(dialog(page)).toHaveAttribute('data-action', action)
  await expect(dialog(page).getByTestId('gh-dialog-facts')).not.toContainText('Reading the branch facts')
}

// ---- P0 item 7: one scenario per section 4.2 situation --------------------------------------------------------------

const SITUATIONS: { id: SituationId; scenario: string; sentence: string; suffix: string }[] = [
  { id: 'no-branch', scenario: 'github-no-branch', sentence: 'This run records no branch, so there is nothing to compare with GitHub.', suffix: 'no branch' },
  { id: 'no-remote', scenario: 'github-no-remote', sentence: 'This project has no Git remote, so the run branch exists only on this machine.', suffix: 'no remote' },
  { id: 'not-github', scenario: 'github-not-github', sentence: 'This project\'s remote is not on GitHub, so there is nothing here to read.', suffix: 'not GitHub' },
  { id: 'reads-off', scenario: 'github-reads-off', sentence: 'GitHub reads are turned off on this server; the branch facts below are local only.', suffix: 'reads off' },
  { id: 'gh-missing', scenario: 'github-gh-missing', sentence: 'The gh CLI is not installed on this machine, so this page cannot read kleros/vea.', suffix: 'not read' },
  { id: 'gh-logged-out', scenario: 'github-gh-logged-out', sentence: 'gh is not signed in on this machine, so this page can neither read kleros/vea nor publish to it.', suffix: 'signed out' },
  { id: 'pending', scenario: 'github-pending', sentence: 'Reading kleros/vea for this branch; the first read lands within two minutes.', suffix: 'reading' },
  { id: 'not-pushed', scenario: 'github-not-pushed', sentence: 'Not on GitHub yet: 3 commits would become public on kleros/vea.', suffix: 'not pushed' },
  { id: 'local-ahead', scenario: 'github-local-ahead', sentence: 'GitHub has an older copy of the branch; 2 commits are not pushed yet, and there is no pull request.', suffix: '2 to push' },
  { id: 'remote-ahead', scenario: 'github-remote-ahead', sentence: 'GitHub\'s copy of the branch has 2 commits the run branch lacks; this page will not push over them.', suffix: 'behind GitHub' },
  { id: 'diverged', scenario: 'github-diverged', sentence: 'The run branch and GitHub\'s copy have diverged; this page will not push over GitHub\'s commits.', suffix: 'diverged' },
  { id: 'pushed-no-pr', scenario: 'github-pushed-no-pr', sentence: 'The branch is on GitHub at 6b6d894; there is no pull request yet.', suffix: 'pushed' },
  { id: 'draft', scenario: 'github-draft', sentence: 'Draft #531 is open; checks: 15 passing, 1 pending. A draft notifies no reviewer until you mark it ready.', suffix: '#531 draft' },
  { id: 'in-review', scenario: 'github-in-review', sentence: '#531 waits for review from kleros/vea-maintainers, jaybuidl; checks: 16 passing, 0 pending.', suffix: '#531 in review' },
  { id: 'checks-failing', scenario: 'github-checks-failing', sentence: 'Draft #531 has 1 failing check: relayer-cli / unit.', suffix: '#531 checks failing' },
  { id: 'changes-requested', scenario: 'github-changes-requested', sentence: 'jaybuidl asked for changes on #531 2 h ago; 2 unresolved threads.', suffix: '#531 changes requested' },
  { id: 'approved', scenario: 'github-approved', sentence: '#531 is approved by jaybuidl; checks passing.', suffix: '#531 approved' },
  { id: 'conflicts', scenario: 'github-conflicts', sentence: '#531 has conflicts with dev; GitHub cannot merge it as it is.', suffix: '#531 conflicts' },
  { id: 'merged', scenario: 'github-merged', sentence: '#531 was merged into dev 3 h ago.', suffix: '#531 merged' },
  { id: 'closed', scenario: 'github-closed', sentence: '#531 was closed without merging 1 d ago.', suffix: '#531 closed' },
]

for (const { id, scenario, sentence, suffix } of SITUATIONS) {
  test(`[scenario:${scenario}] The GitHub view in the ${id} situation: the banner's exact sentence and tone, the switcher suffix, the cards in their order, desk and phone (${phase})`, async ({ page }, testInfo) => {
    serve(GITHUB_SITUATIONS[id])
    await open(page)
    const banner = page.getByTestId('gh-banner')
    await expect(banner).toHaveAttribute('data-state', id)
    await expect(page.getByTestId('gh-banner-sentence')).toHaveText(sentence)
    await expect(page.getByTestId('gh-banner-fresh')).toContainText('local git read')
    // GitHub's state is said once per page: the switcher's suffix, no chip in the identity line.
    const link = runViewLink(page, 'github')
    await expect(link.getByTestId('run-view-suffix')).toHaveText(suffix)
    await expect(link).toHaveAttribute('aria-current', 'page')
    await expect(link.getByTestId('run-view-suffix')).toHaveAttribute('data-tone', (await banner.getAttribute('data-tone'))!)
    const read = GITHUB_SITUATIONS[id]
    if (read.pr !== null) {
      await expect(page.getByTestId('gh-pr-card')).toBeVisible()
      await expect(page.getByTestId('gh-no-pr-card')).toHaveCount(0)
      await expect(page.getByTestId('gh-pr-link')).toContainText(`#531 ${read.pr.title} ↗`)
      // On a desk the Pull request card comes before the Branch card.
      const pr = (await page.getByTestId('gh-pr-card').boundingBox())!
      const branch = (await page.getByTestId('gh-branch-card').boundingBox())!
      expect(pr.y).toBeLessThan(branch.y)
    } else {
      await expect(page.getByTestId('gh-pr-card')).toHaveCount(0)
      await expect(page.getByTestId('gh-no-pr-card')).toContainText('There is no pull request whose head is this branch.')
    }
    await expect(page.getByTestId('gh-branch-card')).toContainText('Remote-tracking facts are as fresh as your last fetch or push; this page never fetches.')
    await expect(page.getByTestId('gh-connection-card')).toContainText('md-manager reads GitHub through the gh CLI signed in on this machine. It keeps no GitHub token.')
    await expect(page.getByTestId('gh-commands')).toContainText('Run these yourself in a terminal on this machine.')
    // Situation-specific facts.
    if (id === 'not-pushed') {
      await expect(page.getByTestId('gh-branch-card').getByTestId('gh-commit-row')).toHaveCount(3)
      await expect(page.getByTestId('gh-branch-card').getByTestId('gh-commit-author').first()).toHaveText(UNPUBLISHED[0]!.author)
      await expect(page.getByTestId('gh-push-state')).toHaveText('not pushed')
      // The visibility chip is a fact, untoned.
      await expect(page.getByTestId('gh-visibility-chip')).toHaveText('public')
      await expect(page.getByTestId('gh-visibility-chip')).not.toHaveAttribute('data-tone')
      await expect(page.getByTestId('gh-banner-link')).toHaveText('See the command below ↓')
    }
    if (id === 'checks-failing') {
      await expect(page.getByTestId('gh-checks-line')).toHaveText('1 failing · 1 pending · 14 passing · 1 skipped')
      await expect(page.getByTestId('gh-check-row').first()).toHaveAttribute('data-tone', 'fail')
      await expect(page.getByTestId('gh-banner-link')).toHaveText('Open the failing check ↗')
      await expect(page.getByTestId('gh-pr-requested')).toContainText('team kleros/vea-maintainers')
    }
    if (id === 'merged') await expect(page.getByTestId('gh-pr-state')).toHaveText('merged')
    if (id === 'remote-ahead') await expect(page.getByTestId('gh-push-state')).toHaveText('2 behind GitHub')
    if (id === 'gh-logged-out') await expect(page.getByTestId('gh-commands').getByTestId('gh-command')).toHaveCount(3)
    await attach(page, testInfo, scenario)
    await phone(page)
    // Phone order: banner, Publish on GitHub, then the pull request or the branch.
    const bannerY = (await banner.boundingBox())!.y
    const publishY = (await page.getByTestId('gh-actions').boundingBox())!.y
    const branchY = (await page.getByTestId('gh-branch-card').boundingBox())!.y
    expect(bannerY).toBeLessThan(publishY)
    expect(publishY).toBeLessThan(branchY)
    await expectNoExecutionControls(page)
  })
}

test(`[scenario:github-commands-card] The commands to run by hand: real, shell-quoted values; the reviewers command stays uncopyable until a reviewer is named; the draft PR heredoc (${phase})`, async ({ page, context }, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  serve(GITHUB_SITUATIONS['in-review'])
  await open(page)
  const commands = page.getByTestId('gh-commands')
  const reviewers = commands.locator('[data-command="add-reviewers"]')
  await expect(reviewers.getByTestId('gh-command-copy')).toBeDisabled()
  await expect(reviewers).toContainText('Name a reviewer first')
  await expect(reviewers.getByTestId('gh-command-text')).toHaveCount(0)
  await commands.getByTestId('gh-reviewers-field').fill('not a/valid/name')
  await expect(commands.getByTestId('gh-reviewers-problem')).toContainText('is not a GitHub login or an org/team name')
  await expect(reviewers.getByTestId('gh-command-copy')).toBeDisabled()
  await commands.getByTestId('gh-reviewers-field').fill('jaybuidl, kleros/vea-maintainers')
  await expect(reviewers.getByTestId('gh-command-text')).toHaveText('gh pr edit 531 --repo kleros/vea --add-reviewer jaybuidl,kleros/vea-maintainers')
  await reviewers.getByTestId('gh-command-copy').click()
  await expect.poll(() => page.evaluate('navigator.clipboard.readText()')).toBe('gh pr edit 531 --repo kleros/vea --add-reviewer jaybuidl,kleros/vea-maintainers')
  await attach(page, testInfo, 'github-commands-card')
  await phone(page)

  // A push: the local sha onto the branch, never forced.
  serve(GITHUB_SITUATIONS['not-pushed'])
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(pageUrl)
  const push = page.getByTestId('gh-commands').locator('[data-command="push"]').getByTestId('gh-command-text')
  await expect(push).toContainText(`push origin 6b6d894aa1b2c3d4e5f60718293a4b5c6d7e8f90:refs/heads/${GITHUB_BRANCH}`)
  await expect(push).not.toContainText('--force')
  // Pushed with no PR: the draft PR command carries the run summary through a quoted heredoc.
  serve(GITHUB_SITUATIONS['pushed-no-pr'])
  await page.goto(pageUrl)
  const create = page.getByTestId('gh-commands').locator('[data-command="pr-create"]').getByTestId('gh-command-text')
  await expect(create).toContainText(`gh pr create --repo kleros/vea --head ${GITHUB_BRANCH} --base dev --draft --title 'Run controls on the run page: ${GITHUB_RUN}' --body-file - <<'MD_MANAGER_SUMMARY'`)
  await expect(create).toContainText(`### Run controls on the run page: ${GITHUB_RUN}`)
  const text = await create.innerText()
  expect(text.trimEnd().endsWith('MD_MANAGER_SUMMARY')).toBe(true)
  expect(text).not.toMatch(/<(?:title|body|reviewers?|branch|sha)>|\/home\/|\/tmp\//)
  // Every copyable command on these pages is free of placeholders.
  for (const command of await page.getByTestId('gh-command-text').allInnerTexts()) expect(command).not.toMatch(/<(?:title|body|reviewers?|branch|sha)>/)
})

// ---- P0 item 8: Copy run summary --------------------------------------------------------------------------------------

test(`[scenario:github-copy-summary] Copy run summary puts exactly the run summary on the clipboard, Show the text shows the same Markdown, and no absolute path is in it (${phase})`, async ({ page, context }, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  serve(GITHUB_SITUATIONS['checks-failing'])
  await open(page)
  const share = page.getByTestId('gh-share-card')
  await expect(share).toContainText('One Markdown text for a chat, an issue or the pull request. Facts this run did not record are left out; the draft pull request starts from the same text.')
  await share.getByTestId('gh-summary-copy').click()
  await expect(share.getByTestId('gh-summary-copy')).toHaveText('Copied')
  const copied = await page.evaluate('navigator.clipboard.readText()') as string
  // The expected text from the same fixtures the page read: the headline is the page's Now headline, taken from the status line.
  const headline = /^- \*\*Status:\*\* succeeded(?: · (.*))?$/m.exec(copied)?.[1] ?? null
  const expected = runSummaryMarkdown(summaryInput({
    detail: runDetails[GITHUB_RUN]!, inputs: runInputs[GITHUB_RUN]!, review: null, headline, teams: null, sessions: null, runGithub: GITHUB_SITUATIONS['checks-failing'], reports: new Map(),
  }))
  expect(copied).toBe(expected)
  expect(copied).toContain(`### Run controls on the run page: ${GITHUB_RUN}`)
  expect(copied).toContain('- **Pull request:** [#531](https://github.com/kleros/vea/pull/531) (draft)')
  expect(copied).not.toMatch(/\/home\/|\/tmp\/|\/Users\//)
  await share.getByTestId('gh-summary-toggle').click()
  await expect(share.getByTestId('gh-summary-toggle')).toHaveAttribute('aria-expanded', 'true')
  const shown = await share.getByTestId('gh-summary-text').evaluate(element => element.textContent)
  expect(shown).toBe(copied)
  await attach(page, testInfo, 'github-copy-summary')
  await phone(page)
  // On an unpaired page the GitHub view's buttons are Copy and disclosures only.
  const words = await page.getByTestId('gh-view').locator('button').allInnerTexts()
  for (const word of words) expect(word.trim()).toMatch(/^(Copy|Copied|Copy run summary|Show the text|Hide the text|Show all \d+|Show fewer|Show \d+ passing|Hide passing)$/)
})

// ---- P1 item 10: the actions panel -------------------------------------------------------------------------------------

test(`[scenario:github-actions-controls-off] With run controls off the panel says nothing is published from this page and points at the commands (${phase})`, async ({ page }, testInfo) => {
  await installControlMocks(page, { enabled: false })
  serve(GITHUB_SITUATIONS['not-pushed'])
  await open(page)
  const panel = page.getByTestId('gh-actions')
  await expect(panel).toHaveAttribute('data-state', 'controls-off')
  await expect(panel.getByTestId('gh-actions-copy')).toHaveText('Run controls are off on this server, so nothing is published from this page. The commands below do the same by hand.')
  await expect(panel.getByTestId('gh-action')).toHaveCount(0)
  await expect(page.getByTestId('gh-banner-action')).toHaveCount(0)
  await expect(page.getByTestId('controls-button')).toHaveCount(0)
  await expectNoExecutionControls(page)
  await attach(page, testInfo, 'github-actions-controls-off')
  await phone(page)
})

test(`[scenario:github-actions-unpaired] Unpaired, the panel asks to pair in the Controls menu or run the commands; nothing is read with a token (${phase})`, async ({ page }, testInfo) => {
  const seen: string[] = []
  page.on('request', request => { const path = new URL(request.url()).pathname; if (path.startsWith('/api/run-controls/')) seen.push(`${request.method()} ${path}`) })
  await installControlMocks(page)
  serve(GITHUB_SITUATIONS['not-pushed'], GITHUB_ACTIONS.pushPublic)
  await open(page)
  const panel = page.getByTestId('gh-actions')
  await expect(panel).toHaveAttribute('data-state', 'unpaired')
  await expect(panel.getByTestId('gh-actions-copy')).toHaveText('Pair this browser in the Controls menu to publish from this page, or run the commands below.')
  await expect(panel.getByTestId('gh-action')).toHaveCount(0)
  expect(seen.filter(item => item.endsWith('/github'))).toEqual([])
  await expectNoExecutionControls(page)
  await attach(page, testInfo, 'github-actions-unpaired')
  await phone(page)
})

test(`[scenario:github-actions-off] Paired on a server without MD_MANAGER_GITHUB_ACTIONS=on, the panel says how to turn them on (${phase})`, async ({ page }, testInfo) => {
  serve(GITHUB_SITUATIONS['not-pushed'], GITHUB_ACTIONS.off)
  await paired(page)
  const panel = page.getByTestId('gh-actions')
  await expect(panel).toHaveAttribute('data-state', 'actions-off')
  await expect(panel.getByTestId('gh-actions-copy')).toHaveText('GitHub actions are off. Start the dashboard with MD_MANAGER_GITHUB_ACTIONS=on to publish from this page; the commands below do the same by hand.')
  await expect(panel.getByTestId('gh-action-button')).toHaveCount(0)
  await expect(page.getByTestId('gh-banner-action')).toHaveCount(0)
  await attach(page, testInfo, 'github-actions-off')
  await phone(page)
})

test(`[scenario:github-actions-offered] Offered actions in contract order: a 44 px button with what it publishes, an unavailable one as text with its reason; the banner's next action and the Controls menu's GitHub group open the same dialog (${phase})`, async ({ page }, testInfo) => {
  serve(GITHUB_SITUATIONS['not-pushed'], GITHUB_ACTIONS.pushPublic)
  await paired(page)
  const panel = page.getByTestId('gh-actions')
  await expect(panel).toHaveAttribute('data-state', 'offered')
  const rows = panel.getByTestId('gh-action')
  await expect(rows).toHaveCount(4)
  expect(await rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-action')))).toEqual(['push_branch', 'open_pr', 'mark_ready', 'request_reviewers'])
  const push = rows.nth(0)
  await expect(push.getByTestId('gh-action-button')).toHaveText('Push branch')
  expect((await push.getByTestId('gh-action-button').boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await expect(push.getByTestId('gh-action-note')).toHaveText('3 commits become public on kleros/vea')
  await expect(rows.nth(1).getByTestId('gh-action-button')).toHaveCount(0)
  await expect(rows.nth(1).getByTestId('gh-action-note')).toHaveText('Not offered: The branch is not on GitHub yet')
  // The banner's single next action is the offered push.
  await expect(page.getByTestId('gh-banner-action')).toHaveText('Push branch')
  await page.getByTestId('gh-banner-action').click()
  await expect(dialog(page)).toHaveAttribute('data-action', 'push_branch')
  await dialog(page).getByTestId('gh-dialog-cancel').click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(page.getByTestId('gh-banner-action')).toBeFocused()
  // The Controls menu's GitHub group lists the same four and opens the same dialog.
  await page.getByTestId('controls-button').click()
  const group = page.getByTestId('gh-controls-group')
  await expect(group).toBeVisible()
  await expect(group.getByTestId('gh-control')).toHaveCount(4)
  await expect(page.getByTestId('controls-list')).toBeVisible()
  await expect(group.locator('[data-action="open_pr"]')).toHaveAttribute('data-available', 'false')
  await group.locator('[data-action="push_branch"]').getByTestId('gh-control-button').click()
  await expect(dialog(page)).toHaveAttribute('data-action', 'push_branch')
  await expect(dialog(page).getByTestId('gh-dialog-confirm')).toBeDisabled()
  await dialog(page).getByTestId('gh-dialog-cancel').click()
  await attach(page, testInfo, 'github-actions-offered')
  await phone(page)
})

test(`[scenario:github-action-record] Recent GitHub actions list up to five records with their status words and an Output fold for failed and refused ones; an action this page runs joins them and GitHub is read again (${phase})`, async ({ page }, testInfo) => {
  serve(GITHUB_SITUATIONS.draft, GITHUB_ACTIONS.records)
  const reads: number[] = []
  page.on('request', request => { if (/\/api\/dispatch\/projects\/[^/]+\/workflows\/[^/]+\/runs\/[^/]+\/github$/.test(new URL(request.url()).pathname)) reads.push(Date.now()) })
  await paired(page)
  const records = page.getByTestId('gh-action-record')
  await expect(records).toHaveCount(3)
  expect(await records.evaluateAll(elements => elements.map(element => element.getAttribute('data-state')))).toEqual(['failed', 'refused', 'succeeded'])
  await expect(records.nth(0)).toContainText('Request reviewers')
  await expect(records.nth(0)).toContainText('failed')
  await records.nth(0).locator('summary').click()
  await expect(records.nth(0).locator('.gh-output')).toContainText('Could not resolve to a User with the login of \'nobody-here\'')
  await expect(records.nth(1).locator('details')).toHaveCount(1)
  await expect(records.nth(2).locator('details')).toHaveCount(0)
  await expect(records.nth(2).locator('a')).toHaveText('kleros/vea/pull/531 ↗')
  // Run Mark ready: the record joins the list and the GitHub read runs again right after it ends.
  const before = reads.length
  await openDialogFromPanel(page, 'mark_ready')
  await confirm(page).click()
  await expect(dialog(page).getByTestId('gh-dialog-outcome')).toHaveAttribute('data-state', 'succeeded')
  await expect(dialog(page).getByTestId('gh-dialog-outcome')).toContainText('Done. GitHub is read again within two minutes.')
  await dialog(page).getByTestId('gh-dialog-cancel').click()
  await expect(records).toHaveCount(4)
  await expect(records.first()).toHaveAttribute('data-state', 'succeeded')
  await expect(records.first()).toContainText('Mark ready for review')
  await expect.poll(() => reads.length).toBeGreaterThan(before)
  await attach(page, testInfo, 'github-action-record')
  await phone(page)
})

// ---- P1 item 11: the dialogs ------------------------------------------------------------------------------------------

test(`[scenario:github-push-public-dialog] Pushing to a public repository: the warn band, every commit with its author, the exact command, and a typed kleros/vea that must match exactly before the button works (${phase})`, async ({ page }, testInfo) => {
  serve(GITHUB_SITUATIONS['not-pushed'], GITHUB_ACTIONS.pushPublic)
  const mock = await paired(page)
  await openDialogFromPanel(page, 'push_branch')
  const box = dialog(page)
  await expect(box.locator('#gh-dialog-title')).toHaveText('Push the run branch to kleros/vea')
  const block = box.getByTestId('gh-visibility-block')
  await expect(block).toHaveAttribute('data-band', 'true')
  await expect(block.locator('strong')).toHaveText('kleros/vea is public.')
  await expect(block).toContainText('After this push anyone on the internet can read these 3 commits: their messages, their authors\' names and email addresses, and every line they change. A push cannot be taken back: deleting the branch later does not remove copies already fetched or forked.')
  expect(await block.evaluate(element => element.ownerDocument.defaultView!.getComputedStyle(element).borderTopWidth)).toBe('5px')
  await expect(box.getByTestId('gh-dialog-facts')).toHaveText(`${GITHUB_BRANCH} at 6b6d894 → origin on github.com/kleros/vea. A plain push: never forced.`)
  const preview = box.getByTestId('gh-commit-preview')
  await expect(preview.locator('h4')).toHaveText('Commits that become public (3)')
  await expect(preview.getByTestId('gh-commit-author')).toHaveText(UNPUBLISHED.map(commit => commit.author))
  await expect(box.getByTestId('gh-dialog-command')).toHaveText(GITHUB_ACTIONS.pushPublic.actions[0]!.command)
  await expect(box).toContainText('The controller checks the branch and the commit again before it runs git or gh.')
  const typed = box.getByTestId('gh-typed-input')
  await expect(box.getByTestId('gh-typed-confirm')).toContainText('Type kleros/vea to confirm')
  await expect(typed).toHaveValue('')
  await expect(confirm(page)).toHaveText('Push 3 commits to kleros/vea')
  await expect(confirm(page)).toBeDisabled()
  await typed.fill('Kleros/vea')
  await expect(confirm(page)).toBeDisabled()
  await typed.fill('kleros/vea ')
  await expect(confirm(page)).toBeDisabled()
  await typed.fill('kleros/vea')
  await expect(confirm(page)).toBeEnabled()
  await attach(page, testInfo, 'github-push-public-dialog')
  await confirm(page).click()
  await expect(box.getByTestId('gh-dialog-outcome')).toHaveAttribute('data-state', 'succeeded')
  expect(mock.githubPosts).toHaveLength(1)
  expect(mock.githubPosts[0]!.action).toBe('push_branch')
  expect(mock.githubPosts[0]!.body.request_id).toMatch(UUID)
  expect(mock.githubPosts[0]!.body.state_token).toBe(GITHUB_ACTIONS.pushPublic.state_token)
  expect(mock.githubPosts[0]!.body.params).toEqual({ confirm_repo: 'kleros/vea' })
  await phone(page)
})

test(`[scenario:github-push-private-dialog] Pushing to a private repository: no band, "visible" instead of "public", and no typed name (${phase})`, async ({ page }, testInfo) => {
  serve(GITHUB_PRIVATE_NOT_PUSHED, GITHUB_ACTIONS.pushPrivate)
  const mock = await paired(page)
  await openDialogFromPanel(page, 'push_branch')
  const box = dialog(page)
  const block = box.getByTestId('gh-visibility-block')
  await expect(block).toHaveAttribute('data-band', 'false')
  await expect(block).toHaveText('kleros/vea is private: what this publishes is visible to everyone with access to the repository.')
  expect(await block.evaluate(element => element.ownerDocument.defaultView!.getComputedStyle(element).borderTopWidth)).toBe('1px')
  await expect(box.getByTestId('gh-commit-preview').locator('h4')).toHaveText('Commits that become visible (3)')
  await expect(box.getByTestId('gh-typed-confirm')).toHaveCount(0)
  await expect(confirm(page)).toBeEnabled()
  await attach(page, testInfo, 'github-push-private-dialog')
  await confirm(page).click()
  await expect(box.getByTestId('gh-dialog-outcome')).toHaveAttribute('data-state', 'succeeded')
  expect(mock.githubPosts[0]!.body.params).toEqual({})
  expect(mock.githubPosts[0]!.body.request_id).toMatch(UUID)
  await phone(page)
})

test(`[scenario:github-open-pr-dialog] Opening a draft pull request: the title and the editable body prefilled from the server's defaults, the counter, the caption and the typed repository (${phase})`, async ({ page }, testInfo) => {
  serve(GITHUB_SITUATIONS['pushed-no-pr'], GITHUB_ACTIONS.openPr)
  const mock = await paired(page)
  await openDialogFromPanel(page, 'open_pr')
  const box = dialog(page)
  const action = GITHUB_ACTIONS.openPr.actions.find(item => item.id === 'open_pr')!
  await expect(box.locator('#gh-dialog-title')).toHaveText('Open a draft pull request on kleros/vea')
  await expect(box.getByTestId('gh-visibility-block').locator('strong')).toHaveText('kleros/vea is public.')
  await expect(box.getByTestId('gh-visibility-block')).toContainText('Anyone on the internet can read the title and the text below, and the pull request stays listed on the repository even if you close it.')
  await expect(box.getByTestId('gh-dialog-facts')).toHaveText(`From ${GITHUB_BRANCH} into dev. Always a draft: GitHub asks no one to review until you mark it ready.`)
  await expect(box.getByTestId('gh-param-title')).toHaveValue(action.defaults.title!)
  await expect(box.getByTestId('gh-param-body')).toHaveValue(action.defaults.body!)
  await expect(box.getByTestId('gh-body-counter')).toHaveText(`${action.defaults.body!.length} of 60000 characters`)
  await expect(box).toContainText('Local paths are already removed. It includes the run\'s recorded Claude spend when there is one; delete that line if you prefer.')
  await box.getByTestId('gh-param-body').fill('Edited body.')
  await expect(box.getByTestId('gh-body-counter')).toHaveText('12 of 60000 characters')
  await expect(confirm(page)).toHaveText('Open draft pull request')
  await expect(confirm(page)).toBeDisabled()
  await box.getByTestId('gh-typed-input').fill('kleros/vea')
  await expect(confirm(page)).toBeEnabled()
  await attach(page, testInfo, 'github-open-pr-dialog')
  await confirm(page).click()
  await expect(box.getByTestId('gh-dialog-outcome')).toHaveAttribute('data-state', 'succeeded')
  expect(mock.githubPosts[0]!.body.params).toEqual({ title: action.defaults.title, body: 'Edited body.', confirm_repo: 'kleros/vea' })
  expect(mock.githubPosts[0]!.body.state_token).toBe(GITHUB_ACTIONS.openPr.state_token)
  await phone(page)
})

test(`[scenario:github-mark-ready] Marking #531 ready: a plain confirmation that names whom GitHub notifies (${phase})`, async ({ page }, testInfo) => {
  serve(GITHUB_SITUATIONS.draft, GITHUB_ACTIONS.markReady)
  const mock = await paired(page)
  await expect(page.getByTestId('gh-banner-action')).toHaveText('Mark ready for review')
  await openDialogFromPanel(page, 'mark_ready')
  const box = dialog(page)
  await expect(box.locator('#gh-dialog-title')).toHaveText('Mark #531 ready for review')
  await expect(box.getByTestId('gh-dialog-facts')).toHaveText('GitHub notifies the requested reviewers: kleros/vea-maintainers, jaybuidl.')
  await expect(box.getByTestId('gh-typed-confirm')).toHaveCount(0)
  await expect(confirm(page)).toHaveText('Mark ready for review')
  await expect(confirm(page)).toBeEnabled()
  await attach(page, testInfo, 'github-mark-ready')
  await confirm(page).click()
  await expect(box.getByTestId('gh-dialog-outcome')).toHaveAttribute('data-state', 'succeeded')
  expect(mock.githubPosts[0]).toMatchObject({ action: 'mark_ready', body: { state_token: GITHUB_ACTIONS.markReady.state_token, params: {} } })
  // Escape closes the dialog and the focus returns to the opener.
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toHaveCount(0)
  await phone(page)
})

test(`[scenario:github-request-reviewers] Requesting reviewers: one per line, validated, suggestion chips that toggle, never prefilled (${phase})`, async ({ page }, testInfo) => {
  serve(GITHUB_SITUATIONS['in-review'], GITHUB_ACTIONS.requestReviewers)
  const mock = await paired(page)
  await openDialogFromPanel(page, 'request_reviewers')
  const box = dialog(page)
  await expect(box.locator('#gh-dialog-title')).toHaveText('Request reviewers on #531')
  await expect(box.getByTestId('gh-dialog-facts')).toHaveText('GitHub notifies each person, and every member of each team, now.')
  const field = box.getByTestId('gh-param-reviewers')
  await expect(field).toHaveValue('')
  await expect(confirm(page)).toHaveText('Request 0 reviewers')
  await expect(confirm(page)).toBeDisabled()
  const chips = box.getByTestId('gh-reviewer-suggestion')
  await expect(chips).toHaveText(['jaybuidl', 'kleros/vea-maintainers'])
  await chips.nth(0).click()
  await expect(chips.nth(0)).toHaveAttribute('aria-pressed', 'true')
  await expect(field).toHaveValue('jaybuidl')
  await field.fill('jaybuidl\nnot a/valid/name')
  await expect(box.getByTestId('gh-reviewers-hint')).toContainText('is not a GitHub login or an org/team name')
  await expect(confirm(page)).toBeDisabled()
  await field.fill('jaybuidl')
  await chips.nth(1).click()
  await expect(field).toHaveValue('jaybuidl\nkleros/vea-maintainers')
  await expect(confirm(page)).toHaveText('Request 2 reviewers')
  await expect(confirm(page)).toBeEnabled()
  await attach(page, testInfo, 'github-request-reviewers')
  await confirm(page).click()
  await expect(box.getByTestId('gh-dialog-outcome')).toHaveAttribute('data-state', 'succeeded')
  expect(mock.githubPosts[0]!.body.params).toEqual({ reviewers: ['jaybuidl', 'kleros/vea-maintainers'] })
  expect(mock.githubPosts[0]!.body.request_id).toMatch(UUID)
  await phone(page)
})

test(`[scenario:github-action-stale] A branch that moved after the dialog opened: the POST carries the old state_token, the server answers 409 and the dialog says to reopen it (${phase})`, async ({ page }, testInfo) => {
  serve(GITHUB_SITUATIONS['not-pushed'], GITHUB_ACTIONS.pushPublic)
  const mock = await paired(page)
  await openDialogFromPanel(page, 'push_branch')
  // The branch moves on the server: new offers with a new state token.
  serve(GITHUB_SITUATIONS['not-pushed'], { ...GITHUB_ACTIONS.pushPublic, state_token: 'gh-moved-0000000000' })
  await dialog(page).getByTestId('gh-typed-input').fill('kleros/vea')
  await confirm(page).click()
  await expect(dialog(page).getByTestId('gh-dialog-alert')).toHaveText('The branch or the pull request changed since this dialog opened. Close it and open it again to see the new facts.')
  await expect(confirm(page)).toBeDisabled()
  await expect(dialog(page).getByTestId('gh-dialog-cancel')).toHaveText('Close')
  expect(mock.githubPosts[0]!.body.state_token).toBe(GITHUB_ACTIONS.pushPublic.state_token)
  await attach(page, testInfo, 'github-action-stale')
  await phone(page)
  // Reopened, the dialog posts the new token.
  await dialog(page).getByTestId('gh-dialog-cancel').click()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.reload()
  await expect(page.getByTestId('gh-actions')).toHaveAttribute('data-state', 'offered')
  await openDialogFromPanel(page, 'push_branch')
  await dialog(page).getByTestId('gh-typed-input').fill('kleros/vea')
  await confirm(page).click()
  await expect(dialog(page).getByTestId('gh-dialog-outcome')).toHaveAttribute('data-state', 'succeeded')
  expect(mock.githubPosts.at(-1)!.body.state_token).toBe('gh-moved-0000000000')
})
