/**
 * The GitHub view's pure model (docs/PRD_RUN_TEAMS.md 4 "GitHub view", 11 P0 items 7-8 and P1 items 10-11): one test per
 * section 4.2 row with its exact banner sentence, tone and suffix (first matching row wins), the switcher suffix's spoken
 * words, the commands card's shell quoting and its rule that no placeholder reaches a copyable command, the run summary input
 * holding no absolute path, and the actions' panel states, dialog copy, typed confirmation and request params.
 */
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { RunGithub } from '../../contracts/projects/github.ts'
import { runSummaryMarkdown, runSummaryTitle } from '../../contracts/projects/summary.ts'
import { runGithub as exampleRunGithub, runGithubActions as exampleActions, teams as exampleTeams } from '../../contracts/projects/teamExamples.ts'
import {
  bodyCounter, buildGithubParams, confirmLabel, filledCommand, staleActionsLine, dialogTitle, factsLine, fieldsProblem, initialDialogValues, outcomeSentence, panelState, PANEL_COPY, previewHeading,
  recentRecords, recordShown, recordTone, toggleReviewer, typedConfirmation, typedMatches, UNKNOWN_SENTENCE, unknownLine, visibilityBlock,
} from '../../src/projects/github/actions.ts'
import {
  approvedChecksWord, githubSituation, githubSuffix, handCommands, headlineWithoutStatus, heredocDelimiter, mergeWord, noBranchLine, noPrCard, parseReviewers, pushPill,
  redactCredentials, redactPaths, redactSummaryText, refreshFailedLine, reviewRow, shasLine, shellPath, shellQuote, SITUATION_IDS, spokenSuffix, summaryInput, unlistedChecks,
  NO_PR_TEXT, type SituationId,
} from '../../src/projects/github/model.ts'
import { runDetails, runInputs } from '../project-workflows/fixtures.ts'
import '../project-workflows/fixtures/index.ts'
import { GITHUB_ACTIONS, GITHUB_BRANCH, GITHUB_PRIVATE_NOT_PUSHED, GITHUB_RUN, GITHUB_SITUATIONS, GITHUB_UNLISTED_CHECKS, UNKNOWN_PUSH_RECORD } from '../project-workflows/fixtures/ux-run-github.ts'

const NOW = Date.parse('2026-10-16T10:00:00Z')

/** Section 4.2, row by row: the exact sentence, the tone and the suffix for the fixture of that row. */
const ROWS: Record<SituationId, { tone: string; sentence: string; suffix: string }> = {
  'no-branch': { tone: 'idle', sentence: 'This run records no branch, so there is nothing to compare with GitHub.', suffix: 'no branch' },
  'no-remote': { tone: 'idle', sentence: 'This project has no Git remote, so the run branch exists only on this machine.', suffix: 'no remote' },
  'not-github': { tone: 'idle', sentence: 'This project\'s remote is not on GitHub, so there is nothing here to read.', suffix: 'not GitHub' },
  'repo-unread': { tone: 'idle', sentence: 'The repository could not be read: git not read.', suffix: 'not read' },
  'reads-off': { tone: 'idle', sentence: 'GitHub reads are turned off on this server; the branch facts below are local only.', suffix: 'reads off' },
  'gh-missing': { tone: 'warn', sentence: 'The gh CLI is not installed on this machine, so this page cannot read kleros/vea.', suffix: 'not read' },
  'gh-logged-out': { tone: 'warn', sentence: 'gh is not signed in on this machine, so this page can neither read kleros/vea nor publish to it.', suffix: 'signed out' },
  'gh-unread': { tone: 'idle', sentence: 'GitHub was not read: gh timed out after 20 s. The branch facts below are local only.', suffix: 'not read' },
  pending: { tone: 'idle', sentence: 'Reading kleros/vea for this branch; the first read lands within two minutes.', suffix: 'reading' },
  'no-local-branch': { tone: 'idle', sentence: `The run branch ${GITHUB_BRANCH} is not in this repository, so there is nothing to push.`, suffix: 'no branch' },
  merged: { tone: 'ok', sentence: '#531 was merged into dev 3 h ago.', suffix: '#531 merged' },
  closed: { tone: 'idle', sentence: '#531 was closed without merging 1 d ago.', suffix: '#531 closed' },
  diverged: { tone: 'fail', sentence: 'The run branch and GitHub\'s copy have diverged; this page will not push over GitHub\'s commits.', suffix: 'diverged' },
  'remote-ahead': { tone: 'warn', sentence: 'GitHub\'s copy of the branch has 2 commits the run branch lacks; this page will not push over them.', suffix: 'behind GitHub' },
  conflicts: { tone: 'fail', sentence: '#531 has conflicts with dev; GitHub cannot merge it as it is.', suffix: '#531 conflicts' },
  'checks-failing': { tone: 'fail', sentence: 'Draft #531 has 1 failing check: relayer-cli / unit.', suffix: '#531 checks failing' },
  'changes-requested': { tone: 'fail', sentence: 'jaybuidl asked for changes on #531 2 h ago; 2 unresolved threads.', suffix: '#531 changes requested' },
  'pr-behind-local': { tone: 'idle', sentence: '#531 is open, but 2 commits on the run branch are not on GitHub yet.', suffix: '#531 · 2 to push' },
  approved: { tone: 'ok', sentence: '#531 is approved by jaybuidl; checks passing.', suffix: '#531 approved' },
  draft: { tone: 'idle', sentence: 'Draft #531 is open; checks: 15 passing, 1 pending. A draft notifies no reviewer until you mark it ready.', suffix: '#531 draft' },
  'in-review': { tone: 'run', sentence: '#531 waits for review from kleros/vea-maintainers, jaybuidl; checks: 16 passing, 0 pending.', suffix: '#531 in review' },
  'not-pushed': { tone: 'idle', sentence: 'Not on GitHub yet: 3 commits would become public on kleros/vea.', suffix: 'not pushed' },
  'local-ahead': { tone: 'idle', sentence: 'GitHub has an older copy of the branch; 2 commits are not pushed yet, and there is no pull request.', suffix: '2 to push' },
  'pushed-no-pr': { tone: 'ok', sentence: 'The branch is on GitHub at 6b6d894; there is no pull request yet.', suffix: 'pushed' },
  unknown: { tone: 'idle', sentence: 'Where the branch stands against GitHub is unknown: git could not compare it with the remote.', suffix: 'unknown' },
}

for (const id of SITUATION_IDS) {
  test(`github situation ${id}: the 4.2 row's exact sentence, tone and suffix`, () => {
    const situation = githubSituation(GITHUB_SITUATIONS[id], NOW)
    assert.equal(situation.id, id)
    assert.equal(situation.sentence, ROWS[id].sentence)
    assert.equal(situation.tone, ROWS[id].tone)
    assert.equal(situation.suffix, ROWS[id].suffix)
  })
}

test('github situation: the private form of not-pushed, and the first matching row wins', () => {
  assert.equal(githubSituation(GITHUB_PRIVATE_NOT_PUSHED, NOW).sentence, 'Not on GitHub yet: 3 commits would be published to kleros/vea, a private repository.')
  // A merged PR wins over a diverged branch; conflicts win over failing checks; a diverged branch wins over a PR's checks.
  const merged = GITHUB_SITUATIONS.merged
  assert.equal(githubSituation({ ...merged, branch: { ...merged.branch, push_state: 'diverged' } }, NOW).id, 'merged')
  const failing = GITHUB_SITUATIONS['checks-failing']
  assert.equal(githubSituation({ ...failing, pr: { ...failing.pr!, mergeable: 'CONFLICTING' } }, NOW).id, 'conflicts')
  assert.equal(githubSituation({ ...failing, branch: { ...failing.branch, push_state: 'diverged' } }, NOW).id, 'diverged')
  // No branch beats everything, even an unread GitHub.
  assert.equal(githubSituation({ ...GITHUB_SITUATIONS['gh-missing'], branch: { ...GITHUB_SITUATIONS['gh-missing'].branch, name: null } }, NOW).id, 'no-branch')
  // Three failing checks name two and count the rest.
  const three: RunGithub = { ...failing, pr: { ...failing.pr!, draft: false, checks: { ...failing.pr!.checks!, failing: 3, items: [
    { name: 'a', kind: 'check_run', status: 'COMPLETED', conclusion: 'FAILURE', bucket: 'fail', url: null },
    { name: 'b', kind: 'check_run', status: 'COMPLETED', conclusion: 'FAILURE', bucket: 'fail', url: null },
    { name: 'c', kind: 'check_run', status: 'COMPLETED', conclusion: 'FAILURE', bucket: 'fail', url: null },
  ] } } }
  assert.equal(githubSituation(three, NOW).sentence, '#531 has 3 failing checks: a, b, and 1 more.')
  // Changes requested without a recorded review author.
  const changes = GITHUB_SITUATIONS['changes-requested']
  assert.equal(githubSituation({ ...changes, pr: { ...changes.pr!, latest_reviews: [], unresolved_threads: 0 } }, NOW).sentence, 'A reviewer asked for changes on #531.')
})

test('github situation: the next action and its fallback link', () => {
  assert.deepEqual(githubSituation(GITHUB_SITUATIONS['not-pushed'], NOW).next, { action: 'push_branch', fallback: { kind: 'commands' } })
  assert.deepEqual(githubSituation(GITHUB_SITUATIONS['checks-failing'], NOW).next.fallback, { kind: 'check', url: 'https://github.com/kleros/vea/actions/runs/1/job/2' })
  assert.deepEqual(githubSituation(GITHUB_SITUATIONS.merged, NOW).next, { action: null, fallback: { kind: 'pr', number: 531, url: 'https://github.com/kleros/vea/pull/531' } })
  assert.deepEqual(githubSituation(GITHUB_SITUATIONS.draft, NOW).next.action, 'mark_ready')
  assert.deepEqual(githubSituation(GITHUB_SITUATIONS['no-branch'], NOW).next, { action: null, fallback: null })
})

test('github suffix: the situation\'s suffix and tone, spoken in words; none when the read is not served', () => {
  assert.equal(githubSuffix(null), null)
  assert.deepEqual(githubSuffix(GITHUB_SITUATIONS['checks-failing']), { tone: 'fail', word: '#531 checks failing', spoken: 'pull request 531, checks failing' })
  assert.equal(spokenSuffix('#531 · 2 to push'), 'pull request 531, 2 to push')
  assert.equal(spokenSuffix('not pushed'), 'not pushed')
  assert.equal(spokenSuffix('reading'), 'reading GitHub')
  assert.deepEqual(githubSuffix(exampleRunGithub), { tone: 'fail', word: '#531 checks failing', spoken: 'pull request 531, checks failing' })
})

test('push pill: the counts in words', () => {
  assert.deepEqual(pushPill(GITHUB_SITUATIONS['local-ahead'].branch), { tone: 'idle', word: '2 ahead of GitHub' })
  assert.deepEqual(pushPill(GITHUB_SITUATIONS['remote-ahead'].branch), { tone: 'warn', word: '2 behind GitHub' })
  assert.equal(pushPill(GITHUB_SITUATIONS['no-local-branch'].branch).word, 'not in this repository')
})

// ---- Commands (4.6) -----------------------------------------------------------------------------------------------------

const CHECKOUT = '~/dev/vea-cook-relayer-revert-shapes'
const SUMMARY = { title: 'Relayer revert shapes: it\'s "done"', markdown: '### Relayer revert shapes\n\n- **Status:** succeeded\n' }
const commandsFor = (id: SituationId, reviewers: string[] = [], read = GITHUB_SITUATIONS[id]) =>
  handCommands(read, githubSituation(read, NOW), { checkout: CHECKOUT, summary: SUMMARY, reviewers })
const PLACEHOLDER = /<(?:title|body|reviewers?|branch|sha|checkout|repo)>|\{[a-z_]+\}/

test('shell quoting: branch names with slashes stay bare, quotes are escaped, ~ stays expandable', () => {
  assert.equal(shellQuote('feature/relayer-revert-shapes/run-002'), 'feature/relayer-revert-shapes/run-002')
  assert.equal(shellQuote('it\'s "done"'), '\'it\'\\\'\'s "done"\'')
  assert.equal(shellQuote('a b'), '\'a b\'')
  assert.equal(shellQuote(''), '\'\'')
  assert.equal(shellQuote('$(rm -rf /)'), '\'$(rm -rf /)\'')
  assert.equal(shellPath('~/dev/my repo'), '~/\'dev/my repo\'')
  assert.equal(shellPath(CHECKOUT), CHECKOUT)
})

test('commands: push, log, gh auth, remote, as section 4.6 lists them', () => {
  const push = commandsFor('not-pushed')
  assert.deepEqual(push.map(command => command.id), ['push'])
  assert.equal(push[0]!.text, `git -C ${CHECKOUT} push origin 6b6d894aa1b2c3d4e5f60718293a4b5c6d7e8f90:refs/heads/${GITHUB_BRANCH}`)
  assert.ok(!push[0]!.text!.includes('--force'))
  assert.deepEqual(commandsFor('local-ahead').map(command => command.id), ['push'])
  assert.deepEqual(commandsFor('pr-behind-local').map(command => command.id), ['push', 'add-reviewers'])
  const log = commandsFor('diverged')
  assert.equal(log[0]!.text, `git -C ${CHECKOUT} log --oneline --left-right 6b6d894aa1b2c3d4e5f60718293a4b5c6d7e8f90...origin/${GITHUB_BRANCH}`)
  assert.equal(log[0]!.after, 'Resolve it yourself; this page offers nothing that overwrites GitHub\'s copy.')
  assert.deepEqual(commandsFor('gh-logged-out').map(command => command.text), ['gh auth status --hostname github.com', 'gh auth login --hostname github.com --git-protocol https', 'gh auth setup-git --hostname github.com'])
  assert.equal(commandsFor('gh-missing').at(-1)!.after, 'Then reload this page.')
  assert.deepEqual(commandsFor('no-remote').map(command => command.text), [`git -C ${CHECKOUT} remote -v`])
  assert.deepEqual(commandsFor('draft').map(command => command.id), ['pr-ready', 'add-reviewers'])
  assert.equal(commandsFor('draft')[0]!.text, 'gh pr ready 531 --repo kleros/vea')
  assert.deepEqual(commandsFor('merged'), [])
})

test('commands: the draft PR heredoc carries the run summary, quoted title and a delimiter the text cannot end early', () => {
  const [create] = commandsFor('pushed-no-pr')
  assert.equal(create!.id, 'pr-create')
  assert.equal(create!.text, `gh pr create --repo kleros/vea --head ${GITHUB_BRANCH} --base dev --draft --title 'Relayer revert shapes: it'\\''s "done"' --body-file - <<'MD_MANAGER_SUMMARY'\n${SUMMARY.markdown}MD_MANAGER_SUMMARY`)
  assert.equal(heredocDelimiter('a\nMD_MANAGER_SUMMARY\nb'), 'MD_MANAGER_SUMMARY_2')
  // Without a summary yet the create command waits (no text, Copy off) rather than carrying a placeholder body (G12).
  const read = GITHUB_SITUATIONS['pushed-no-pr']
  assert.deepEqual(handCommands(read, githubSituation(read, NOW), { checkout: CHECKOUT, summary: null, reviewers: [] }), [{ id: 'pr-create', text: null, waiting: 'Reading the run…' }])
})

test('commands: the reviewers command waits on its field; no placeholder ever reaches a copyable command', () => {
  const waiting = commandsFor('in-review').find(command => command.id === 'add-reviewers')!
  assert.equal(waiting.text, null)
  assert.equal(waiting.waiting, 'Name a reviewer first')
  const named = commandsFor('in-review', ['jaybuidl', 'kleros/vea-maintainers']).find(command => command.id === 'add-reviewers')!
  assert.equal(named.text, 'gh pr edit 531 --repo kleros/vea --add-reviewer jaybuidl,kleros/vea-maintainers')
  for (const id of SITUATION_IDS) {
    for (const command of [...commandsFor(id), ...commandsFor(id, ['jaybuidl'])]) {
      if (command.text === null) continue
      assert.doesNotMatch(command.text, PLACEHOLDER, `${id}: ${command.id}`)
      assert.doesNotMatch(command.text, /\/home\/|\/tmp\//, `${id}: ${command.id}`)
    }
  }
  // Without a checkout the git commands run in the current directory, still with no placeholder.
  const read = GITHUB_SITUATIONS['not-pushed']
  const [push] = handCommands(read, githubSituation(read, NOW), { checkout: null, summary: null, reviewers: [] })
  assert.match(push!.text!, /^git push origin /)
})

test('reviewers field: logins and org/team, duplicates and the maximum', () => {
  assert.deepEqual(parseReviewers('jaybuidl\nkleros/vea-maintainers'), { items: ['jaybuidl', 'kleros/vea-maintainers'], problem: null })
  assert.match(parseReviewers('not a/login/x').problem ?? '', /is not a GitHub login/)
  assert.equal(parseReviewers('a\nA').problem, 'A is listed twice.')
  assert.equal(parseReviewers('a b c', 2).problem, 'At most 2 reviewers.')
  assert.equal(toggleReviewer('a', 'b'), 'a\nb')
  assert.equal(toggleReviewer('a\nb', 'B'), 'a')
})

// ---- Run summary input (4.3) -----------------------------------------------------------------------------------------

test('summary input: maps what the run page holds, and no absolute path reaches it', () => {
  const detail = runDetails[GITHUB_RUN]!
  const inputs = runInputs[GITHUB_RUN]!
  const lane = inputs.workers[0]!.node_id
  const input = summaryInput({
    detail,
    inputs: { ...inputs, feature: 'Feature in /home/agentops/dev/md-manager' },
    review: { verdict: 'approved', reviewers: [{ reviewer_id: 'general' } as never], findings: [
      { severity: 'P1', disposition: 'open' } as never, { severity: 'P2', disposition: 'open' } as never, { severity: 'P0', disposition: 'fixed' } as never,
    ] },
    headline: 'Integrated in /tmp/claude-1002/worktree-ui and /Users/me/x',
    teams: { ...exampleTeams, sessions: exampleTeams.sessions.map(session => ({ ...session, lane: session.role === 'worker' ? lane : session.lane })) },
    sessions: { totals: { metered_usd: 7.5 } as never },
    runGithub: GITHUB_SITUATIONS['checks-failing'],
    reports: new Map([[lane, 'Edited /home/agentops/dev/md-manager/src/a.ts.\n\nMore.']]),
  })
  const text = JSON.stringify(input)
  assert.doesNotMatch(text, /\/home\/|\/tmp\/|\/Users\//)
  assert.equal(input.runId, GITHUB_RUN)
  assert.equal(input.feature, 'Feature in <path>')
  assert.deepEqual(input.review, { verdict: 'approved', reviewers: ['general'], open: { p0: 0, p1: 1, p2: 1 } })
  assert.equal(input.costUsd, 7.5)
  assert.deepEqual(input.pr, { number: 531, url: 'https://github.com/kleros/vea/pull/531', state: 'OPEN', draft: true })
  assert.equal(input.lanes[0]!.summary, 'Edited <path>\n\nMore.')
  assert.ok(input.lanes[0]!.team !== null)
  assert.doesNotMatch(runSummaryMarkdown(input), /\/home\/|\/tmp\//)
  assert.equal(runSummaryTitle(input), `Feature in <path>: ${GITHUB_RUN}`)
  // Nothing recorded: no cost, no review, no PR, no lane report.
  const bare = summaryInput({ detail, inputs: null, review: null, headline: null, teams: null, sessions: null, runGithub: null, reports: new Map() })
  assert.equal(bare.costUsd, null)
  assert.equal(bare.review, null)
  assert.equal(bare.pr, null)
  assert.deepEqual(bare.lanes, [])
  assert.equal(redactPaths('/root/x and /var/folders/ab/c'), '<path> and <path>')
})

// ---- Actions (4.4, 4.5) ------------------------------------------------------------------------------------------------

test('actions panel: the four states and their exact copy', () => {
  assert.equal(panelState({ mode: 'off', paired: false }, null, null), 'controls-off')
  assert.equal(panelState({ mode: 'on', paired: false }, null, null), 'unpaired')
  assert.equal(panelState({ mode: 'on', paired: true }, GITHUB_ACTIONS.off, null), 'actions-off')
  assert.equal(panelState({ mode: 'on', paired: true }, GITHUB_ACTIONS.pushPublic, null), 'offered')
  assert.equal(panelState({ mode: 'on', paired: true }, null, 'boom'), 'unreadable')
  assert.equal(PANEL_COPY.controlsOff, 'Run controls are off on this server, so nothing is published from this page. The commands below do the same by hand.')
  assert.equal(PANEL_COPY.unpaired, 'Pair this browser in the Controls menu to publish from this page, or run the commands below.')
  assert.equal(PANEL_COPY.actionsOff, 'GitHub actions are off. Start the dashboard with MD_MANAGER_GITHUB_ACTIONS=on to publish from this page; the commands below do the same by hand.')
  assert.deepEqual(recentRecords(GITHUB_ACTIONS.records, null).map(record => record.status), ['failed', 'refused', 'succeeded'])
})

test('dialog copy: visibility blocks, titles, facts, preview heading and buttons', () => {
  const pub = visibilityBlock('push_branch', 'kleros/vea', 'PUBLIC', 3)
  assert.equal(pub.band, true)
  assert.equal(pub.heading, 'kleros/vea is public.')
  assert.equal(pub.body, 'After this push anyone on the internet can read these 3 commits: their messages, their authors\' names and email addresses, and every line they change. A push cannot be taken back: deleting the branch later does not remove copies already fetched or forked.')
  assert.equal(visibilityBlock('open_pr', 'kleros/vea', 'PUBLIC', 0).body, 'Anyone on the internet can read the title and the text below, and the pull request stays listed on the repository even if you close it.')
  assert.deepEqual(visibilityBlock('push_branch', 'kleros/vea', 'PRIVATE', 3), { band: false, heading: null, body: 'kleros/vea is private: what this publishes is visible to everyone with access to the repository.' })
  assert.deepEqual(visibilityBlock('push_branch', 'kleros/vea', null, 3), { band: true, heading: null, body: 'The repository\'s visibility was not read, so treat it as public.' })
  const read = GITHUB_SITUATIONS['not-pushed']
  assert.equal(dialogTitle('push_branch', 'kleros/vea', read), 'Push the run branch to kleros/vea')
  assert.equal(factsLine('push_branch', 'kleros/vea', read), `${GITHUB_BRANCH} at 6b6d894 → origin on github.com/kleros/vea. A plain push: never forced.`)
  assert.equal(previewHeading('PUBLIC', 3), 'Commits that become public (3)')
  assert.equal(previewHeading('PRIVATE', 3), 'Commits that become visible (3)')
  assert.equal(confirmLabel('push_branch', 'kleros/vea', read, initialDialogValues(GITHUB_ACTIONS.pushPublic.actions[0]!)), 'Push 3 commits to kleros/vea')
  assert.equal(factsLine('open_pr', 'kleros/vea', GITHUB_SITUATIONS['pushed-no-pr']), `From ${GITHUB_BRANCH} into dev. Always a draft: GitHub asks no one to review until you mark it ready.`)
  assert.equal(dialogTitle('mark_ready', 'kleros/vea', GITHUB_SITUATIONS.draft), 'Mark #531 ready for review')
  assert.equal(factsLine('mark_ready', 'kleros/vea', GITHUB_SITUATIONS.draft), 'GitHub notifies the requested reviewers: kleros/vea-maintainers, jaybuidl.')
  assert.equal(dialogTitle('request_reviewers', 'kleros/vea', GITHUB_SITUATIONS.draft), 'Request reviewers on #531')
  assert.equal(confirmLabel('request_reviewers', 'kleros/vea', null, { title: '', body: '', reviewers: 'a\nb', typed: '' }), 'Request 2 reviewers')
})

test('typed confirmation: exact and case-sensitive, never prefilled; asked for an unknown visibility', () => {
  const push = GITHUB_ACTIONS.pushPublic.actions[0]!
  assert.equal(initialDialogValues(push).typed, '')
  assert.equal(typedConfirmation(push, 'PUBLIC'), true)
  assert.equal(typedConfirmation(GITHUB_ACTIONS.pushPrivate.actions[0]!, 'PRIVATE'), false)
  assert.equal(typedConfirmation(GITHUB_ACTIONS.pushPrivate.actions[0]!, null), true)
  assert.equal(typedMatches('kleros/vea', 'kleros/vea'), true)
  assert.equal(typedMatches('Kleros/vea', 'kleros/vea'), false)
  assert.equal(typedMatches(' kleros/vea', 'kleros/vea'), false)
  assert.equal(typedMatches('', null), false)
})

test('request params: only what the action names; the PR body prefilled from the server defaults; reviewers validated', () => {
  const open = GITHUB_ACTIONS.openPr.actions.find(action => action.id === 'open_pr')!
  const values = initialDialogValues(open)
  assert.equal(values.title, open.defaults.title)
  assert.equal(values.body, open.defaults.body)
  assert.equal(fieldsProblem(open, values), null)
  assert.deepEqual(buildGithubParams(open, { ...values, typed: 'kleros/vea' }), { title: values.title, body: values.body, confirm_repo: 'kleros/vea' })
  assert.equal(fieldsProblem(open, { ...values, title: ' ' }), 'Write a title.')
  const reviewers = exampleActions.actions.find(action => action.id === 'request_reviewers')!
  assert.equal(fieldsProblem(reviewers, initialDialogValues(reviewers)), 'Name at least one reviewer.')
  assert.deepEqual(buildGithubParams(reviewers, { title: '', body: '', reviewers: 'jaybuidl\nkleros/vea-maintainers', typed: '' }), { reviewers: ['jaybuidl', 'kleros/vea-maintainers'] })
  const ready = exampleActions.actions.find(action => action.id === 'mark_ready')!
  assert.deepEqual(buildGithubParams(ready, initialDialogValues(ready)), {})
})

test('outcome sentences', () => {
  const record = GITHUB_ACTIONS.records.records[0]!
  assert.equal(outcomeSentence({ ...record, status: 'running' }), 'The controller is running it; this takes up to a minute.')
  assert.equal(outcomeSentence({ ...record, status: 'succeeded' }), 'Done. GitHub is read again within two minutes.')
  assert.equal(outcomeSentence(record), 'The command failed (exit 1).')
  assert.equal(outcomeSentence(GITHUB_ACTIONS.records.records[1]!), 'The controller refused it: Blocked: the run branch moved since the offer (6b6d894 is not 1a2b3c4).')
})

test('outcome: a timed-out publish (exit 3, an `Unknown:` line) says its outcome is unknown in the warn tone, never "The command failed"', () => {
  const failed = GITHUB_ACTIONS.records.records[0]!
  const controllerUnknown = { ...failed, status: 'failed' as const, exit_code: 3, output_tail: ['To github.com:kleros/vea.git', 'Unknown: git push timed out after 120 s; it may have been published; check GitHub'] }
  assert.equal(unknownLine(controllerUnknown), 'Unknown: git push timed out after 120 s; it may have been published; check GitHub')
  assert.equal(outcomeSentence(controllerUnknown), UNKNOWN_SENTENCE)
  assert.equal(UNKNOWN_SENTENCE, 'The outcome is unknown: it may have been published. Check GitHub before you try again.')
  assert.deepEqual(recordShown(controllerUnknown), { tone: 'warn', word: 'unknown' })
  // The server's 6-minute stop: no exit code, its own `Unknown:` note as the last line.
  const serverStop = { ...failed, status: 'failed' as const, exit_code: null, output_tail: ['Unknown: the command ran longer than 6 minutes and was stopped; it may have been published; check GitHub.'] }
  assert.equal(outcomeSentence(serverStop), UNKNOWN_SENTENCE)
  assert.deepEqual(recordShown(serverStop), { tone: 'warn', word: 'unknown' })
  // A plain failure stays a failure; an `Unknown:` line only counts on a failed record.
  assert.equal(unknownLine(failed), null)
  assert.deepEqual(recordShown(failed), recordTone('failed'))
  assert.equal(outcomeSentence(failed), 'The command failed (exit 1).')
  const succeeded = { ...controllerUnknown, status: 'succeeded' as const, exit_code: 0 }
  assert.equal(unknownLine(succeeded), null)
  assert.equal(outcomeSentence(succeeded), 'Done. GitHub is read again within two minutes.')
  // A line that merely mentions the word is not the controller's verdict.
  assert.equal(unknownLine({ ...failed, output_tail: ['Failed: gh said Unknown: flag'] }), null)
})

// ---- Fixes after the run-teams review (G3-G22) ------------------------------------------------------------------------

test('G3 exact command: the typed title and reviewers filled in as one shell word each, the body through a heredoc, Copy off until complete', () => {
  const open = GITHUB_ACTIONS.openPr.actions.find(action => action.id === 'open_pr')!
  const values = initialDialogValues(open)
  const filled = filledCommand(open, { ...values, title: "relayer: Bob's fix" })
  assert.match(filled.text, / '--title=relayer: Bob'\\''s fix' --body-file /)
  assert.doesNotMatch(filled.text, /<title>/)
  assert.match(filled.text, /--body-file "\$body_file" --by operator$/)
  assert.equal(filled.hasBody, true)
  assert.equal(filled.copyable, true)
  assert.equal(filled.waiting, null)
  // An empty title keeps the placeholder and Copy off.
  const blank = filledCommand(open, { ...values, title: '' })
  assert.match(blank.text, /--title=<title>/)
  assert.equal(blank.copyable, false)
  assert.equal(blank.waiting, 'Fill the fields first. Write a title.')
  const reviewers = GITHUB_ACTIONS.requestReviewers.actions.find(action => action.id === 'request_reviewers')!
  const none = filledCommand(reviewers, initialDialogValues(reviewers))
  assert.match(none.text, /--add <reviewers>/)
  assert.equal(none.copyable, false)
  const named = filledCommand(reviewers, { ...initialDialogValues(reviewers), reviewers: 'jaybuidl\nkleros/vea-maintainers' })
  assert.match(named.text, /--add jaybuidl,kleros\/vea-maintainers --by operator$/)
  assert.equal(named.copyable, true)
  assert.equal(named.hasBody, false)
  // A command with no placeholder (the push) is copyable as it is.
  const push = GITHUB_ACTIONS.pushPublic.actions[0]!
  assert.deepEqual(filledCommand(push, initialDialogValues(push)), { text: push.command, copyable: true, hasBody: false, waiting: null })
})

test('G4 a failed background refresh: the banner line and the actions panel line say what is shown is from an earlier read', () => {
  const now = Date.parse('2026-10-16T10:05:00Z')
  assert.equal(refreshFailedLine({ message: 'The server did not answer.', failedAt: Date.parse('2026-10-16T10:04:00Z'), settledAt: Date.parse('2026-10-16T10:00:00Z') }, now),
    'Last read failed 1 min ago: The server did not answer; showing the read from 5 min ago.')
  assert.match(refreshFailedLine({ message: 'boom', failedAt: null, settledAt: null }, now), /^Last read failed: boom; showing the read from an earlier time\.$/)
  assert.equal(staleActionsLine(GITHUB_ACTIONS.markReady, 'Network error.'), 'Could not refresh the actions: Network error; showing the ones read earlier.')
  assert.equal(staleActionsLine(GITHUB_ACTIONS.markReady, null), null)
  assert.equal(staleActionsLine(null, 'Network error.'), null)
})

test('G5 the card in the pull request\'s place says "No pull request" only when GitHub was read', () => {
  const card = (id: SituationId) => noPrCard(GITHUB_SITUATIONS[id], id)
  assert.deepEqual(card('not-pushed'), { title: 'No pull request', text: NO_PR_TEXT, read: true })
  assert.deepEqual(card('reads-off'), { title: 'Pull request', text: 'Not read: GitHub reads are off on this server.', read: false })
  assert.deepEqual(card('pending'), { title: 'Pull request', text: 'Reading GitHub…', read: false })
  assert.deepEqual(card('gh-missing'), { title: 'Pull request', text: 'Not read: gh is not installed on this machine.', read: false })
  assert.deepEqual(card('gh-logged-out'), { title: 'Pull request', text: 'Not read: gh is not signed in on this machine.', read: false })
  assert.deepEqual(card('gh-unread'), { title: 'Pull request', text: 'Not read: gh timed out after 20 s.', read: false })
  assert.equal(card('no-branch'), null)
  assert.equal(card('no-remote'), null)
  assert.equal(card('not-github'), null)
})

test('G6 the run summary drops credential-shaped strings and any absolute path, in the Markdown and the hand pr-create command', () => {
  const detail = runDetails[GITHUB_RUN]!
  const inputs = runInputs[GITHUB_RUN]!
  const lane = inputs.workers[0]!.node_id
  const token = `ghp_${'a1B2'.repeat(9)}`
  const input = summaryInput({
    detail, inputs, review: null, headline: 'Bearer abcdefghijklmnopqrstuvwxyz0123 in /srv/app', teams: null, sessions: null, runGithub: GITHUB_SITUATIONS['pushed-no-pr'],
    reports: new Map([[lane, `Used ${token} and TELEGRAM_BOT_TOKEN=123456:ABCdef from /opt/secrets/env.`]]),
  })
  const markdown = runSummaryMarkdown(input, redactSummaryText)
  assert.ok(!markdown.includes(token))
  assert.ok(!markdown.includes('123456:ABCdef'))
  assert.ok(!markdown.includes('abcdefghijklmnopqrstuvwxyz0123'))
  assert.doesNotMatch(markdown, /\/srv\/|\/opt\//)
  assert.match(markdown, /Used <redacted> and TELEGRAM_BOT_TOKEN=<redacted> from <path>/)
  const create = handCommands(GITHUB_SITUATIONS['pushed-no-pr'], githubSituation(GITHUB_SITUATIONS['pushed-no-pr'], NOW), {
    checkout: '~/dev/vea', summary: { title: runSummaryTitle(input, redactSummaryText), markdown }, reviewers: [],
  }).find(command => command.id === 'pr-create')!
  assert.ok(!create.text!.includes(token))
  assert.match(create.text!, /TELEGRAM_BOT_TOKEN=<redacted>/)
  assert.equal(redactCredentials('sk-short and MONKEY and TOKEN_COUNT=5'), 'sk-short and MONKEY and TOKEN_COUNT=5')
  // URLs and relative paths stay.
  assert.equal(redactPaths('see https://github.com/kleros/vea/pull/531 and src/a.ts'), 'see https://github.com/kleros/vea/pull/531 and src/a.ts')
})

test('G7 unread or null facts are not stated as facts: GitHub not read, no fallback sha, no fabricated 0', () => {
  const loggedOut = GITHUB_SITUATIONS['gh-logged-out']
  assert.equal(shasLine(loggedOut.branch, loggedOut.github.status), 'local 6b6d894 · remote-tracking none · GitHub not read')
  const notPushed = GITHUB_SITUATIONS['not-pushed']
  assert.equal(shasLine(notPushed.branch, 'read'), 'local 6b6d894 · remote-tracking none · GitHub none')
  // Up to date with its tracking ref, but GitHub's sha is null: never "on GitHub at" a local sha.
  const noGithubSha = { ...GITHUB_SITUATIONS['pushed-no-pr'], branch: { ...GITHUB_SITUATIONS['pushed-no-pr'].branch, github_sha: null } }
  assert.equal(githubSituation(noGithubSha, NOW).id, 'unknown')
  // Null counts read "not recorded", never 0.
  const remoteAhead = { ...GITHUB_SITUATIONS['remote-ahead'], branch: { ...GITHUB_SITUATIONS['remote-ahead'].branch, behind_remote: null } }
  assert.equal(githubSituation(remoteAhead, NOW).sentence, 'GitHub\'s copy of the branch has commits the run branch lacks (how many is not recorded); this page will not push over them.')
  const localAhead = { ...GITHUB_SITUATIONS['local-ahead'], branch: { ...GITHUB_SITUATIONS['local-ahead'].branch, ahead_of_remote: null } }
  assert.equal(githubSituation(localAhead, NOW).sentence, 'GitHub has an older copy of the branch; commits are not pushed yet (how many is not recorded), and there is no pull request.')
  assert.doesNotMatch(githubSituation(localAhead, NOW).suffix, /\b0\b/)
  const behindLocal = { ...GITHUB_SITUATIONS['pr-behind-local'], branch: { ...GITHUB_SITUATIONS['pr-behind-local'].branch, ahead_of_remote: null } }
  assert.equal(githubSituation(behindLocal, NOW).sentence, '#531 is open, but commits on the run branch are not on GitHub yet (how many is not recorded).')
  assert.equal(githubSituation(behindLocal, NOW).suffix, '#531 · commits to push')
})

test('G10 the push dialog never says 0 commits while the branch facts are not read', () => {
  const block = visibilityBlock('push_branch', 'kleros/vea', 'PUBLIC', null)
  assert.match(block.body, /^After this push anyone on the internet can read these commits: /)
  assert.doesNotMatch(block.body, /\b0 commits\b/)
  assert.equal(confirmLabel('push_branch', 'kleros/vea', null, initialDialogValues(GITHUB_ACTIONS.pushPublic.actions[0]!)), 'Push the branch to kleros/vea')
})

test('G12 the hand pr-create command waits while the run summary is not ready, never dropping it', () => {
  const read = GITHUB_SITUATIONS['pushed-no-pr']
  const waiting = handCommands(read, githubSituation(read, NOW), { checkout: null, summary: null, reviewers: [] }).find(command => command.id === 'pr-create')
  assert.deepEqual(waiting, { id: 'pr-create', text: null, waiting: 'Reading the run…' })
})

test('G15 the body limit counts UTF-8 bytes as the server does', () => {
  const open = GITHUB_ACTIONS.openPr.actions.find(action => action.id === 'open_pr')!
  const spec = open.params.find(item => item.name === 'body')!
  assert.ok(spec.kind === 'multiline')
  const max = spec.max_length
  const values = { ...initialDialogValues(open), body: 'é'.repeat(Math.floor(max / 2) + 1) }
  assert.ok(values.body.length <= max)
  assert.equal(fieldsProblem(open, values), `The body is at most ${max} bytes of UTF-8.`)
  assert.equal(bodyCounter('abc', 100), '3 of 100 characters')
  assert.equal(bodyCounter('héllo', 100), '5 of 100 characters · 6 bytes')
})

test('G16 the approved row says "checks passing" only when a check passed and none is pending', () => {
  const checks = GITHUB_SITUATIONS.approved.pr!.checks!
  assert.equal(approvedChecksWord(checks), 'passing')
  assert.equal(approvedChecksWord({ ...checks, passing: 0, pending: 0, skipped: 3 }), 'none passed (all skipped)')
  assert.equal(approvedChecksWord({ ...checks, pending: 2 }), 'pending')
  assert.equal(approvedChecksWord(null), 'not recorded')
  const skippedOnly = { ...GITHUB_SITUATIONS.approved, pr: { ...GITHUB_SITUATIONS.approved.pr!, checks: { ...checks, passing: 0, pending: 0, skipped: 3 } } }
  assert.equal(githubSituation(skippedOnly, NOW).sentence, '#531 is approved by jaybuidl; checks none passed (all skipped).')
})

test('G18 a merged or closed pull request has no "can merge" and no "review required"', () => {
  const merged = GITHUB_SITUATIONS.merged.pr!
  assert.deepEqual(mergeWord(merged, NOW), { tone: 'ok', word: 'merged 3 h ago' })
  assert.deepEqual(reviewRow(merged), { shown: true, word: { tone: 'ok', word: 'approved' } })
  const closed = GITHUB_SITUATIONS.closed.pr!
  assert.deepEqual(mergeWord(closed, NOW), { tone: 'idle', word: 'closed' })
  assert.equal(closed.review_decision, 'REVIEW_REQUIRED')
  assert.deepEqual(reviewRow(closed), { shown: false, word: null })
  // An open pull request keeps both rows as before.
  assert.deepEqual(mergeWord(GITHUB_SITUATIONS['in-review'].pr!, NOW), { tone: null, word: 'can merge' })
  assert.equal(reviewRow(GITHUB_SITUATIONS['in-review'].pr!).shown, true)
})

test('G19 a run with no branch says only its integrated commit', () => {
  const branch = GITHUB_SITUATIONS['no-branch'].branch
  assert.equal(branch.contains_integrated, null)
  assert.equal(noBranchLine(branch), 'The run\'s integrated commit is 6b6d894.')
  assert.equal(noBranchLine({ ...branch, integrated_commit: null }), 'The run has no integrated commit.')
})

test('G20 counts beyond the listed check rows are said; the fixtures list every row they count', () => {
  assert.equal(unlistedChecks(GITHUB_UNLISTED_CHECKS.pr!.checks!), 'and 117 more checks not listed')
  assert.equal(unlistedChecks({ ...GITHUB_UNLISTED_CHECKS.pr!.checks!, passing: 4, total: 4 }), 'and 1 more check not listed')
  for (const id of SITUATION_IDS) {
    const checks = GITHUB_SITUATIONS[id].pr?.checks
    if (checks) assert.equal(unlistedChecks(checks), null, id)
  }
})

test('G22 the summary\'s status line says the status once', () => {
  assert.equal(headlineWithoutStatus('Succeeded · no push performed · took 41m00s', 'succeeded'), 'no push performed · took 41m00s')
  assert.equal(headlineWithoutStatus('Needs attention · answer the worker', 'needs_attention'), 'answer the worker')
  assert.equal(headlineWithoutStatus('Integrate candidate · fast-forwarded', 'succeeded'), 'Integrate candidate · fast-forwarded')
  assert.equal(headlineWithoutStatus('Succeeded', 'succeeded'), '')
  const detail = runDetails[GITHUB_RUN]!
  const input = summaryInput({ detail, inputs: null, review: null, headline: `${detail.summary.status.replace(/^./, c => c.toUpperCase())} · no push performed`, teams: null, sessions: null, runGithub: null, reports: new Map() })
  assert.equal(input.headline, 'no push performed')
  assert.match(runSummaryMarkdown(input), new RegExp(`- \\*\\*Status:\\*\\* ${detail.summary.status} · no push performed\\n`))
})

test('G27 the unknown-outcome fixture record reads unknown in the warn tone', () => {
  const listed = GITHUB_ACTIONS.unknown.records[0]!
  assert.deepEqual(recordShown(listed), { tone: 'warn', word: 'unknown' })
  assert.deepEqual(recordShown(UNKNOWN_PUSH_RECORD), { tone: 'warn', word: 'unknown' })
  assert.equal(outcomeSentence(UNKNOWN_PUSH_RECORD), UNKNOWN_SENTENCE)
})

// ---- Final review fixes (F6.1, F6.2) -----------------------------------------------------------------------------------

/** Runs a copied command's heredoc prefix in bash, with the controller swapped for a printer of its argv and the body file. */
function runCopied(text: string): { argv: string[]; body: string } {
  const script = `printargs() { for a in "$@"; do printf '%s\\0' "$a"; done; printf 'BODY\\0'; cat "$body_file"; }\nPY=printargs\n${text.replace('$PY -m workflow', '$PY')}`
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const at = result.stdout.indexOf('BODY\0')
  return { argv: result.stdout.slice(0, at).split('\0').filter(word => word !== ''), body: result.stdout.slice(at + 5) }
}

test('F6.2 filledCommand inserts every value literally: $&, $\' and $$ in the title or the body are not replacement patterns', () => {
  const open = GITHUB_ACTIONS.openPr.actions.find(action => action.id === 'open_pr')!
  const title = 'Cost $$5 and $& and $\' and $`'
  const body = 'Line with $& and $\'\nand <title> kept as text'
  const filled = filledCommand(open, { ...initialDialogValues(open), title, body })
  assert.equal(filled.copyable, true, filled.waiting ?? '')
  assert.ok(filled.text.includes(shellQuote(`--title=${title}`)), filled.text)
  const ran = runCopied(filled.text)
  assert.ok(ran.argv.includes(`--title=${title}`), ran.argv.join(' | '))
  assert.equal(ran.body, `${body}\n`)
  // A reviewer value goes in literally too (logins hold no $, but the replacer is the same).
  const reviewers = GITHUB_ACTIONS.requestReviewers.actions.find(action => action.id === 'request_reviewers')!
  assert.match(filledCommand(reviewers, { ...initialDialogValues(reviewers), reviewers: 'a-b\nkleros/x' }).text, /--add a-b,kleros\/x --by operator$/)
})

test('F6.1 the open_pr command is never copyable with <body>: the body goes in through a quoted heredoc and the pasted command runs with it', () => {
  const open = GITHUB_ACTIONS.openPr.actions.find(action => action.id === 'open_pr')!
  const values = { ...initialDialogValues(open), title: 'Widgets: done', body: 'First line\n$(whoami) `id` stays text\nMD_MANAGER_SUMMARY\n' }
  const filled = filledCommand(open, values)
  assert.doesNotMatch(filled.text, /<body>/)
  assert.equal(filled.copyable, true)
  assert.match(filled.text, /^body_file=\$\(mktemp\) && cat > "\$body_file" <<'MD_MANAGER_SUMMARY_2'\n/)
  const ran = runCopied(filled.text)
  assert.equal(ran.body, values.body)
  assert.deepEqual(ran.argv.slice(ran.argv.indexOf('--title=Widgets: done')), ['--title=Widgets: done', '--body-file', ran.argv[ran.argv.indexOf('--body-file') + 1]!, '--by', 'operator'])
  // An empty body keeps <body>: the command is not copyable and says why.
  const empty = filledCommand(open, { ...values, body: '' })
  assert.match(empty.text, /--body-file <body>/)
  assert.equal(empty.copyable, false)
  assert.equal(empty.waiting, 'Fill the fields first. Write the body.')
  // Any placeholder left in the server's command (here <base>, a default branch not read) keeps Copy off and is named.
  const unread = filledCommand({ ...open, command: open.command.replace('--base dev', '--base <base>') }, values)
  assert.equal(unread.copyable, false)
  assert.equal(unread.waiting, 'The command still holds <base>, so it cannot be copied yet.')
  // A title that merely looks like a placeholder is the operator's text, not a placeholder.
  assert.equal(filledCommand(open, { ...values, title: 'Fix <div> rendering' }).copyable, true)
})

test('swarm F6.1 filledCommand fills placeholders by position: a title holding "--body-file <body>" stays the typed title and the real --body-file names the heredoc file', () => {
  const open = GITHUB_ACTIONS.openPr.actions.find(action => action.id === 'open_pr')!
  const title = 'Docs: explain --body-file <body> and <reviewers>'
  const values = { ...initialDialogValues(open), title, body: 'The body.\n' }
  const filled = filledCommand(open, values)
  assert.equal(filled.copyable, true, filled.waiting ?? '')
  assert.ok(filled.text.includes(shellQuote(`--title=${title}`)), filled.text)
  assert.match(filled.text, /--body-file "\$body_file" --by operator$/)
  const ran = runCopied(filled.text)
  assert.ok(ran.argv.includes(`--title=${title}`), ran.argv.join(' | '))
  const at = ran.argv.indexOf('--body-file')
  assert.notEqual(ran.argv[at + 1], '<body>')
  assert.equal(ran.body, values.body)
  // The server's `--title <title>` form (two words) is filled as the one `--title=…` word too.
  const spaced = filledCommand({ ...open, command: open.command.replace('--title=<title>', '--title <title>') }, values)
  assert.equal(spaced.copyable, true, spaced.waiting ?? '')
  assert.ok(spaced.text.includes(` ${shellQuote(`--title=${title}`)} --body-file "$body_file"`), spaced.text)
  assert.doesNotMatch(spaced.text, /--title '--title=/)
})
