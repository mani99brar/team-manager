/**
 * The GitHub view's fixtures (docs/PRD_RUN_TEAMS.md 4 "GitHub view", 11 P0 items 7-8 and P1 items 10-11): one run GitHub
 * read per section 4.2 situation (`GITHUB_SITUATIONS`), each built from the contract example `runGithub`, and the GitHub
 * actions a paired browser reads (`GITHUB_ACTIONS`): actions off, push offered on a public and on a private repository, open a
 * draft pull request, mark ready, request reviewers, and records (succeeded, failed, refused). They are served on the
 * finished run of the controls workflow (`controls-finished`), whose run controls the worker-phase mocks already answer; the
 * spec swaps the payload per test through `runGithubByRun` / `runGithubActionsByRun` (the mocks read them per request).
 * Those are worker-phase payloads. The candidate phase serves what the real server reads, so `seedRunGithubCandidate` (called
 * by `seedCandidate` with the dispatch option, never by `controls-app.ts` or `sessions-app.ts`) gives it something real to read:
 * the project `publish` whose checkout is a real git repository under the seed root, cloned from a bare origin and then pointed
 * at `https://github.com/acme/publish.git`, with two integrated runs of the workflow `publish`, each recording its branch
 * (`inputs.source_branch`) and its integrated commit (the integrate event's "Fast-forwarded to <sha>"):
 * - `publish-unpushed`: its branch has three commits that are on neither origin's branch nor origin/main;
 * - `publish-pushed`: its branch was pushed (the remote-tracking ref is at its head), and the GitHub fixture
 *   (`MD_MANAGER_GITHUB_FIXTURE`) holds a draft pull request #7 for it with one pending check and a team and a user requested.
 * The fixture's `branches` entries are keyed `acme/publish#<branch>`; GitHub itself is never called.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { runGithub as exampleRunGithub, runGithubActions as exampleActions } from '../../../contracts/projects/teamExamples.ts'
import type { GithubAction, RunGithub, RunGithubActions, RunPr } from '../../../contracts/projects/github.ts'
import type { SituationId } from '../../../src/projects/github/model.ts'
import type { GithubRepoRead } from '../../../src/projects/dispatch/types.ts'
import { BASE_COMMIT, GRAPH_NODES, OUTPUT_COMMIT_ADAPTER, OUTPUT_COMMIT_UI, PROJECT, rawInputsSection, UI_SESSION, ADAPTER_SESSION } from '../fixtures.ts'
import type { SeedContext } from '../seed.ts'
import { CONTROLS_WORKFLOW_ID, RUN_FINISHED } from './controls.ts'
import { commit, git, gitOut, initRepo, type FixtureBranchRead } from './dispatch.ts'
import type { RegistryWorkflow, UxFixtureModule } from './index.ts'
import { finishedPackets } from './ux-teams.ts'

export const GITHUB_RUN = RUN_FINISHED
export const GITHUB_WORKFLOW_ID = CONTROLS_WORKFLOW_ID
export const GITHUB_READ_AT = '2026-10-16T10:00:00Z'
export const GITHUB_REPO = 'kleros/vea'
export const GITHUB_BRANCH = `feature/${CONTROLS_WORKFLOW_ID}/${RUN_FINISHED}`
export const GITHUB_CHECKOUT = '~/dev/vea-cook-relayer-revert-shapes'
const LOCAL_SHA = '6b6d894aa1b2c3d4e5f60718293a4b5c6d7e8f90'
const OLD_SHA = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d'

/** The commits a push would publish, newest first, each author as git records it. */
export const UNPUBLISHED: RunGithub['branch']['unpublished'] = [
  { sha: LOCAL_SHA, subject: 'Workflow controls-finished: integrate candidate', author: 'Mani Brar <mani@example.org>', committed_at: '2026-10-16T09:40:00Z' },
  { sha: '5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b', subject: 'relayer: classify revert shapes', author: 'Claude Worker <worker@example.org>', committed_at: '2026-10-16T09:20:00Z' },
  { sha: '4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e', subject: 'relayer: tests for the revert shapes', author: 'Claude Worker <worker@example.org>', committed_at: '2026-10-16T09:10:00Z' },
]

const base: RunGithub = {
  ...exampleRunGithub,
  project_id: PROJECT.project_id,
  workflow_id: CONTROLS_WORKFLOW_ID,
  run_id: RUN_FINISHED,
  read_at: GITHUB_READ_AT,
  branch: { ...exampleRunGithub.branch, name: GITHUB_BRANCH },
}
const examplePr = exampleRunGithub.pr!
const openPr: NonNullable<RunGithub['pr']> = {
  ...examplePr, head_ref: GITHUB_BRANCH, draft: false, review_decision: 'REVIEW_REQUIRED',
  checks: { state: 'SUCCESS', passing: 16, failing: 0, pending: 0, skipped: 1, total: 17, items: [
    { name: 'GitGuardian Security Checks', kind: 'status', status: null, conclusion: 'SUCCESS', bucket: 'pass', url: null },
    { name: 'relayer-cli / unit', kind: 'check_run', status: 'COMPLETED', conclusion: 'SUCCESS', bucket: 'pass', url: 'https://github.com/kleros/vea/actions/runs/1/job/3' },
  ] },
}
const notPushedBranch: RunGithub['branch'] = {
  ...base.branch, tracking_sha: null, github_sha: null, push_state: 'not_pushed', ahead_of_remote: null, behind_remote: null, unpublished: UNPUBLISHED, unpublished_more: 0,
}
const withBranch = (branch: Partial<RunGithub['branch']>, rest: Partial<RunGithub> = {}): RunGithub => ({ ...base, pr: null, ...rest, branch: { ...base.branch, ...branch } })
const withPr = (pr: Partial<NonNullable<RunGithub['pr']>>, branch: Partial<RunGithub['branch']> = {}): RunGithub => ({ ...base, branch: { ...base.branch, ...branch }, pr: { ...openPr, ...pr } })
const githubState = (state: Partial<RunGithub['github']>): RunGithub['github'] => ({ ...base.github, ...state })
const unread = (reason: string): Partial<RunGithub> => ({ github: githubState({ status: 'unavailable', reason, read_at: null, viewer_login: null, visibility: null, viewer_permission: null }) })

/** One read per section 4.2 row, in table order. */
export const GITHUB_SITUATIONS: Record<SituationId, RunGithub> = {
  'no-branch': withBranch({ name: null, local_sha: null, tracking_sha: null, github_sha: null, push_state: 'unknown', ahead_of_remote: null, behind_remote: null, ahead_of_default: null, behind_default: null }),
  'no-remote': withBranch({ tracking_sha: null, github_sha: null, push_state: 'unknown' }, {
    repo: { status: 'no_remote', reason: null, owner_name: null, url: null, remote: null, default_branch: null },
    github: githubState({ status: 'not_github', reason: 'not a GitHub remote', read_at: null, viewer_login: null, visibility: null, viewer_permission: null }),
  }),
  'not-github': withBranch({ github_sha: null }, {
    repo: { status: 'not_github', reason: null, owner_name: null, url: null, remote: 'origin', default_branch: 'main' },
    github: githubState({ status: 'not_github', reason: 'not a GitHub remote', read_at: null, viewer_login: null, visibility: null, viewer_permission: null }),
  }),
  'repo-unread': withBranch({ local_sha: null, tracking_sha: null, github_sha: null, push_state: 'unknown' }, { repo: { status: 'unavailable', reason: 'git not read', owner_name: null, url: null, remote: null, default_branch: null } }),
  'reads-off': { ...withBranch(notPushedBranch), github: githubState({ status: 'off', reason: 'GitHub reads are turned off', read_at: null, viewer_login: null, visibility: null, viewer_permission: null }) },
  'gh-missing': { ...withBranch(notPushedBranch), ...unread('gh is not installed') },
  'gh-logged-out': { ...withBranch(notPushedBranch), ...unread('gh is not logged in') },
  'gh-unread': { ...withBranch(notPushedBranch), ...unread('gh timed out after 20 s') },
  pending: { ...withBranch(notPushedBranch), github: githubState({ status: 'pending', reason: 'not read yet', read_at: null }) },
  'no-local-branch': withBranch({ local_sha: null, tracking_sha: null, github_sha: null, push_state: 'no_local_branch', ahead_of_remote: null, behind_remote: null, ahead_of_default: null, behind_default: null }),
  merged: withPr({ state: 'MERGED', merged_at: '2026-10-16T07:00:00Z', review_decision: 'APPROVED', latest_reviews: [{ author: 'jaybuidl', state: 'APPROVED', submitted_at: '2026-10-16T06:30:00Z' }] }),
  closed: withPr({ state: 'CLOSED', updated_at: '2026-10-15T10:00:00Z' }),
  diverged: withBranch({ push_state: 'diverged', ahead_of_remote: 1, behind_remote: 2, github_sha: OLD_SHA, tracking_sha: OLD_SHA }),
  'remote-ahead': withBranch({ push_state: 'remote_ahead', ahead_of_remote: 0, behind_remote: 2, github_sha: OLD_SHA, tracking_sha: OLD_SHA }),
  conflicts: withPr({ mergeable: 'CONFLICTING' }),
  'checks-failing': { ...base, pr: { ...examplePr, head_ref: GITHUB_BRANCH } },
  'changes-requested': withPr({
    review_decision: 'CHANGES_REQUESTED', unresolved_threads: 2,
    latest_reviews: [{ author: 'gitguardian', state: 'COMMENTED', submitted_at: '2026-10-16T09:50:00Z' }, { author: 'jaybuidl', state: 'CHANGES_REQUESTED', submitted_at: '2026-10-16T08:00:00Z' }],
  }),
  'pr-behind-local': withPr({}, { push_state: 'local_ahead', ahead_of_remote: 2, behind_remote: 0, github_sha: OLD_SHA, tracking_sha: OLD_SHA, unpublished: UNPUBLISHED.slice(0, 2) }),
  approved: withPr({ review_decision: 'APPROVED', latest_reviews: [{ author: 'jaybuidl', state: 'APPROVED', submitted_at: '2026-10-16T09:30:00Z' }] }),
  draft: withPr({ draft: true, checks: { ...openPr.checks!, state: 'PENDING', passing: 15, pending: 1, items: [{ name: 'contracts / coverage', kind: 'check_run', status: 'IN_PROGRESS', conclusion: null, bucket: 'pending', url: null }, ...openPr.checks!.items] } }),
  'in-review': withPr({}),
  'not-pushed': withBranch(notPushedBranch),
  'local-ahead': withBranch({ push_state: 'local_ahead', ahead_of_remote: 2, behind_remote: 0, github_sha: OLD_SHA, tracking_sha: OLD_SHA, unpublished: UNPUBLISHED.slice(0, 2) }),
  'pushed-no-pr': withBranch({}),
  unknown: withBranch({ tracking_sha: null, github_sha: null, push_state: 'unknown', ahead_of_remote: null, behind_remote: null }),
}

/** The not-pushed read on a private repository: its push dialog has no warn band. */
export const GITHUB_PRIVATE_NOT_PUSHED: RunGithub = { ...GITHUB_SITUATIONS['not-pushed'], github: githubState({ visibility: 'PRIVATE' }) }

/** A situation with many checks: the passing rows fold behind "Show {n} passing". */
export const GITHUB_MANY_CHECKS: RunGithub = withPr({
  checks: {
    state: 'FAILURE', passing: 7, failing: 2, pending: 0, skipped: 0, total: 9,
    items: [
      { name: 'relayer-cli / unit', kind: 'check_run', status: 'COMPLETED', conclusion: 'FAILURE', bucket: 'fail', url: 'https://github.com/kleros/vea/actions/runs/1/job/2' },
      { name: 'contracts / lint', kind: 'check_run', status: 'COMPLETED', conclusion: 'FAILURE', bucket: 'fail', url: null },
      ...['build', 'contracts / unit', 'relayer / build', 'validator / unit', 'web / build', 'docs', 'GitGuardian Security Checks'].map(name => ({ name, kind: 'check_run' as const, status: 'COMPLETED', conclusion: 'SUCCESS', bucket: 'pass' as const, url: null })),
    ],
  },
})

// ---- Actions ---------------------------------------------------------------------------------------------------------

/** The command a GitHub action shows, as `server/githubActions.ts` `githubDisplay` words it: the confirmed repository, branch and full head. */
const COMMAND = (verb: string, rest: string) => `$PY -m workflow github ${verb} "$RUN" --repo ${GITHUB_CHECKOUT} --repo-name ${GITHUB_REPO} --branch ${GITHUB_BRANCH} --head ${LOCAL_SHA}${rest ? ` ${rest}` : ''} --by operator`
const exampleAction = (id: GithubAction['id']) => exampleActions.actions.find(action => action.id === id)!
/** The server's reasons (`server/githubActions.ts`), word for word. */
const OFF_REASON = 'GitHub actions are off on this dashboard: start it with MD_MANAGER_GITHUB_ACTIONS=on'
const NO_PR = 'No pull request is open for this branch'
export const PUSH_FIRST = 'Push the branch first: GitHub does not have the run branch at its head'

const push = (available: boolean, visibility: RunGithubActions['visibility']): GithubAction => ({
  ...exampleAction('push_branch'),
  available, reason: available ? null : 'The branch is already on GitHub at the same commit',
  command: COMMAND('push', ''),
  confirm: visibility === 'PRIVATE' || visibility === 'INTERNAL' ? 'plain' : 'typed_repo',
  params: visibility === 'PRIVATE' || visibility === 'INTERNAL' ? [] : [{ name: 'confirm_repo', kind: 'typed', required: true }],
  publishes: visibility === 'PRIVATE' ? '3 commits become visible to everyone with access to kleros/vea' : '3 commits become public on kleros/vea',
})
const openPrAction = (available: boolean, reason: string | null): GithubAction => ({
  ...exampleAction('open_pr'), available, reason: available ? null : reason,
  command: COMMAND('pr', '--base dev --title=<title> --body-file <body>'),
  defaults: available ? { title: `${'Run controls on the run page'}: ${RUN_FINISHED}`, body: `### Run controls on the run page: ${RUN_FINISHED}\n\n- **Status:** succeeded\n- **Branch:** \`${GITHUB_BRANCH}\`\n\n_Generated by md-manager from the run's records._\n` } : {},
  publishes: 'The title and body become public on kleros/vea',
})
const ready = (available: boolean): GithubAction => ({ ...exampleAction('mark_ready'), available, reason: available ? null : NO_PR, command: COMMAND('ready', '--pr 531') })
const reviewers = (available: boolean): GithubAction => ({ ...exampleAction('request_reviewers'), available, reason: available ? null : NO_PR, command: COMMAND('reviewers', '--pr 531 --add <reviewers>') })
const offers = (actions: GithubAction[], extra: Partial<RunGithubActions> = {}): RunGithubActions => ({ version: '1.0.0', enabled: true, state_token: 'gh-3f9a1c2b7d6e5f40', repo: GITHUB_REPO, visibility: 'PUBLIC', actions, records: [], ...extra })

const at = (minute: number) => `2026-10-16T09:${String(minute).padStart(2, '0')}:00Z`

export const GITHUB_ACTIONS = {
  off: offers([push(false, 'PUBLIC'), openPrAction(false, OFF_REASON), ready(false), reviewers(false)].map(action => ({ ...action, available: false, reason: OFF_REASON })), { enabled: false }),
  pushPublic: offers([push(true, 'PUBLIC'), openPrAction(false, PUSH_FIRST), ready(false), reviewers(false)]),
  pushPrivate: offers([push(true, 'PRIVATE'), openPrAction(false, PUSH_FIRST), ready(false), reviewers(false)], { visibility: 'PRIVATE' }),
  openPr: offers([push(false, 'PUBLIC'), openPrAction(true, null), ready(false), reviewers(false)]),
  markReady: offers([push(false, 'PUBLIC'), openPrAction(false, 'Pull request #531 is already open for this branch'), ready(true), reviewers(true)]),
  requestReviewers: offers([push(false, 'PUBLIC'), openPrAction(false, 'Pull request #531 is already open for this branch'), ready(false), reviewers(true)].map(action => (action.id === 'mark_ready' ? { ...action, reason: 'Pull request #531 is already ready for review' } : action))),
  records: offers([push(false, 'PUBLIC'), openPrAction(false, 'Pull request #531 is already open for this branch'), ready(true), reviewers(true)], {
    records: [
      { record_id: 'g-00000000000c', request_id: '3c4e28ba-2fa1-4d3b-8b2c-6a1f0e9d8c7b', action: 'request_reviewers', params: { reviewers: ['nobody-here'] }, command: COMMAND('reviewers', '--pr 531 --add nobody-here'), status: 'failed', exit_code: 1, started_at: at(59), ended_at: at(59), output_tail: ['GraphQL: Could not resolve to a User with the login of \'nobody-here\'. (requestReviews)'], url: null },
      { record_id: 'g-00000000000b', request_id: '2b4e28ba-2fa1-4d3b-8b2c-6a1f0e9d8c7b', action: 'push_branch', params: {}, command: COMMAND('push', ''), status: 'refused', exit_code: 2, started_at: at(58), ended_at: at(58), output_tail: ['Blocked: the run branch moved since the offer (6b6d894 is not 1a2b3c4)'], url: null },
      ...exampleActions.records,
    ],
  }),
} satisfies Record<string, RunGithubActions>

/** Registers the default payloads (the example's checks-failing draft and its offers); the spec swaps them per scenario. */
export const uxRunGithub: UxFixtureModule = {
  payloads: {
    runGithub: { [GITHUB_RUN]: GITHUB_SITUATIONS['checks-failing'] },
    runGithubActions: { [GITHUB_RUN]: GITHUB_ACTIONS.markReady },
  },
}

// ---- The candidate phase: a real repository and run branches for the real server to read ---------------------------------

export const PUBLISH_PROJECT = { project_id: 'publish', name: 'Publish' } as const
export const PUBLISH_WORKFLOW_ID = 'publish'
export const PUBLISH_WORKFLOW_NAME = 'Publish the run branch'
export const PUBLISH_REPO = 'acme/publish'
export const PUBLISH_RUNS = { unpushed: 'publish-unpushed', pushed: 'publish-pushed' } as const
export const PUBLISH_BRANCHES = { unpushed: `feature/${PUBLISH_WORKFLOW_ID}/${PUBLISH_RUNS.unpushed}`, pushed: `feature/${PUBLISH_WORKFLOW_ID}/${PUBLISH_RUNS.pushed}` } as const
export const PUBLISH_PR = 7
export const PUBLISH_PR_TITLE = 'Publish the run branch'
/** The commit author every seeded commit carries (`fixtures/dispatch.ts` `GIT_SEED_ENV`). */
export const PUBLISH_AUTHOR = 'Seed <seed@example.com>'
const PUBLISH_READ_AT = '2026-10-16T10:00:00Z'
const PUBLISH_DAY = '2025-02-10'

/** A registry project as `seedCandidate` writes it. */
export type RegistryProject = { project_id: string; name: string; repository: string; workflows: RegistryWorkflow[] }

/** One integrated run of the `publish` workflow: the export records its branch and the commit it fast-forwarded to. */
function writePublishRun(context: SeedContext, root: string, runId: string, branch: string, integrated: string) {
  const { writeRun, receipt, internalEvent, leakFor, repository } = context
  const runDir = join(root, runId)
  const at = (clock: string) => `${PUBLISH_DAY}T${clock}Z`
  const inputs = rawInputsSection(runId, leakFor(root, runId))!
  writeRun(root, repository, runId, {
    createdAt: at('08:00:00'), updatedAt: at('09:00:00'), definitionNodes: GRAPH_NODES, definitionName: PUBLISH_WORKFLOW_NAME,
    values: {
      ui: receipt('ui', runDir, UI_SESSION, at('08:00:10')), adapter: receipt('adapter', runDir, ADAPTER_SESSION, at('08:00:12')),
      snapshots: { ui: OUTPUT_COMMIT_UI, adapter: OUTPUT_COMMIT_ADAPTER },
      ui_packet: 'verification/worker/ui/1/packet.json', adapter_packet: 'verification/worker/adapter/1/packet.json',
      bundle: { run_id: runId, base_commit: BASE_COMMIT, candidate_commit: integrated, policy_sha256: 'e'.repeat(64) },
      review: { run_id: runId, verdict: 'approved', independent: true, reviewer: 'synthetic-reviewer', findings: [] },
      approved_bundle: 'f'.repeat(64), integrated_commit: integrated,
    },
    next: [], tasks: [],
    events: [
      internalEvent(1, at('08:00:10'), 'ui', 'running', 'Launching or reconciling the exact native session'),
      internalEvent(2, at('08:00:12'), 'adapter', 'running', 'Launching or reconciling the exact native session'),
      internalEvent(3, at('08:30:00'), 'freeze', 'succeeded', 'Captured both worker snapshots'),
      internalEvent(4, at('08:40:00'), 'verify_ui', 'succeeded', 'UI verification passed'),
      internalEvent(5, at('08:40:00'), 'verify_adapter', 'succeeded', 'Adapter verification passed'),
      internalEvent(6, at('08:50:00'), 'review', 'approved', 'Independent reviewer approved the candidate'),
      internalEvent(7, at('09:00:00'), 'integrate', 'succeeded', `Fast-forwarded to ${integrated}`),
    ],
    packets: dir => finishedPackets(context, runId, dir),
    review: null,
    inputs: { ...inputs, feature: PUBLISH_WORKFLOW_NAME, source_branch: branch },
  })
}

/**
 * Writes the `publish` project under `<root>/run-github` (a bare origin, the checkout cloned from it, both run branches, then
 * origin's URL pointed at GitHub) and its two runs; returns the registry project and the GitHub fixture's repository and branch
 * reads to merge into `github-fixture.json`.
 */
export function seedRunGithubCandidate(root: string, context: SeedContext): { project: RegistryProject; repos: Record<string, GithubRepoRead>; branches: Record<string, FixtureBranchRead> } {
  const base = join(root, 'run-github')
  mkdirSync(base, { recursive: true })
  const origin = join(base, 'origin.git')
  initRepo(origin, true)
  const checkout = join(base, 'checkout')
  git(base, ['clone', origin, 'checkout'])
  commit(checkout, 'Initial commit'); commit(checkout, 'Add the relayer')
  git(checkout, ['push', 'origin', 'main'])
  git(checkout, ['remote', 'set-head', 'origin', 'main'])
  // The pushed run's branch: two commits, pushed (the push moves the remote-tracking ref to its head).
  git(checkout, ['checkout', '-b', PUBLISH_BRANCHES.pushed, 'main'])
  commit(checkout, `Workflow ${PUBLISH_RUNS.pushed}: relayer classifies revert shapes`); commit(checkout, `Workflow ${PUBLISH_RUNS.pushed}: integrate candidate`)
  git(checkout, ['push', 'origin', PUBLISH_BRANCHES.pushed])
  // The unpushed run's branch: three commits on neither origin's branch nor origin/main.
  git(checkout, ['checkout', '-b', PUBLISH_BRANCHES.unpushed, 'main'])
  commit(checkout, `Workflow ${PUBLISH_RUNS.unpushed}: tests for the revert shapes`); commit(checkout, `Workflow ${PUBLISH_RUNS.unpushed}: relayer classifies revert shapes`)
  commit(checkout, `Workflow ${PUBLISH_RUNS.unpushed}: integrate candidate`)
  git(checkout, ['checkout', 'main'])
  git(checkout, ['remote', 'set-url', 'origin', `https://github.com/${PUBLISH_REPO}.git`])
  const tip = (ref: string) => gitOut(checkout, ['rev-parse', `refs/heads/${ref}`])
  const pushedTip = tip(PUBLISH_BRANCHES.pushed)

  const runsRoot = join(base, 'runs', PUBLISH_WORKFLOW_ID)
  mkdirSync(runsRoot, { recursive: true })
  writePublishRun(context, runsRoot, PUBLISH_RUNS.unpushed, PUBLISH_BRANCHES.unpushed, tip(PUBLISH_BRANCHES.unpushed))
  writePublishRun(context, runsRoot, PUBLISH_RUNS.pushed, PUBLISH_BRANCHES.pushed, pushedTip)

  const pr: RunPr = {
    number: PUBLISH_PR, title: PUBLISH_PR_TITLE, url: `https://github.com/${PUBLISH_REPO}/pull/${PUBLISH_PR}`, state: 'OPEN', draft: true, author: 'octocat',
    head_ref: PUBLISH_BRANCHES.pushed, base_ref: 'main', head_sha: pushedTip, updated_at: '2026-10-16T09:50:00Z', merged_at: null,
    review_decision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', comments: 0, review_threads: 0, unresolved_threads: 0,
    requested_reviewers: [{ kind: 'team', login: 'acme/maintainers' }, { kind: 'user', login: 'octocat' }], latest_reviews: [],
    checks: { state: 'PENDING', passing: 2, failing: 0, pending: 1, skipped: 0, total: 3, items: [
      { name: 'e2e', kind: 'check_run', status: 'IN_PROGRESS', conclusion: null, bucket: 'pending', url: null },
      { name: 'build', kind: 'check_run', status: 'COMPLETED', conclusion: 'SUCCESS', bucket: 'pass', url: null },
      { name: 'lint', kind: 'check_run', status: 'COMPLETED', conclusion: 'SUCCESS', bucket: 'pass', url: null },
    ] },
  }
  const branchRead = (githubSha: string | null, branchPr: RunPr | null): FixtureBranchRead => ({
    read_at: PUBLISH_READ_AT, visibility: 'PUBLIC', viewer_permission: 'WRITE', default_branch: 'main', github_sha: githubSha, pr: branchPr, earlier_prs: [],
  })
  return {
    project: {
      project_id: PUBLISH_PROJECT.project_id, name: PUBLISH_PROJECT.name, repository: checkout,
      workflows: [{ workflow_id: PUBLISH_WORKFLOW_ID, runs_root: runsRoot, definition: { name: PUBLISH_WORKFLOW_NAME, nodes: GRAPH_NODES } }],
    },
    repos: {
      [PUBLISH_REPO]: {
        read_at: PUBLISH_READ_AT, visibility: 'PUBLIC', default_branch: 'main', pushed_at: '2026-10-16T09:45:00Z',
        head: { sha: gitOut(checkout, ['rev-parse', 'refs/heads/main']), committed_at: '2026-10-16T09:00:00Z' }, open_prs: 0, open_issues: 0, prs: [], issues: [],
      },
    },
    branches: {
      [`${PUBLISH_REPO}#${PUBLISH_BRANCHES.unpushed}`]: branchRead(null, null),
      [`${PUBLISH_REPO}#${PUBLISH_BRANCHES.pushed}`]: branchRead(pushedTip, pr),
    },
  }
}
