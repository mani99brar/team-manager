/**
 * The dispatch pages' pure logic (docs/PRD_PROJECTS_DISPATCH.md sections 4 and 5): the step-to-phase map (node_id first,
 * kind as the fallback, [L2]/[P22]), the landing wording for a commit on neither ref, the rail order and badge words, the
 * card state word, pull-request and issue grouping, the relative time that adds the year, and the sync wording for every
 * origin state.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { CHART_COLUMNS, PHASE_SHORT, PHASES, phaseOf } from '../../src/projects/dispatch/phases.ts'
import {
  cardStateWord, commitsAheadMore, everyRunListFailed, githubHeadState, githubNoHeadText, issueGroups, landingWording,
  OLDER_THAN_LISTED, prGroups, prRelation, railBadge, railBadgeTone, railOrder, relatedWhy, relTime, resolveRunWorkflow, sameRepoText,
  showMoreText, syncAsOf, syncPhrase, UPDATE_TIME_NOT_RECORDED, type RailInfo,
} from '../../src/projects/dispatch/derive.ts'
import { FAILED_RUN_INFO, projectRunInfo } from '../../src/projects/dispatch/projectModel.ts'
import type { ProjectRuns, RunSummary, WorkflowDefinition, Project } from '../../src/projects/api.ts'
import type { GithubState, GitState, Issue, Pr, ProjectStepsRun } from '../../src/projects/dispatch/types.ts'
import { endedCounts, landingKnown, noStopWording, runStepsRead, stopOf } from '../../src/projects/dispatch/stops.ts'
import type { RunClass } from '../../src/projects/lists.ts'

const phaseName = (nodeId: string, kind: string) => PHASES[phaseOf(nodeId, kind)]

describe('the step-to-phase map', () => {
  test('matches node_id first for the known pipeline nodes', () => {
    assert.equal(phaseName('challenge', 'review'), 'Challenge')
    assert.equal(phaseName('launch_ui', 'worker'), 'Launch')
    assert.equal(phaseName('handoff', 'prepare'), 'Freeze')
    assert.equal(phaseName('verify_ui', 'verification'), 'Verify')
    assert.equal(phaseName('candidate', 'verification'), 'Candidate')
    assert.equal(phaseName('review', 'review'), 'Review')
    assert.equal(phaseName('approval', 'integration'), 'Approval')
    assert.equal(phaseName('integrate', 'integration'), 'Integrate')
  })

  test('the sidecar (kind review) is Launch, and attack, critique and panel are Review', () => {
    assert.equal(phaseName('sidecar', 'review'), 'Launch')
    assert.equal(phaseName('attack', 'review'), 'Review')
    assert.equal(phaseName('critique', 'review'), 'Review')
    assert.equal(phaseName('panel', 'review'), 'Review')
  })

  test('a repair node (kind worker) is Verify, not Launch', () => {
    assert.equal(phaseName('repair-1', 'worker'), 'Verify')
    assert.equal(phaseName('repair-2', 'worker'), 'Verify')
  })

  test('falls back to kind for an unknown node id', () => {
    assert.equal(phaseName('surprise', 'review'), 'Review')
    assert.equal(phaseName('surprise', 'worker'), 'Launch')
    assert.equal(phaseName('surprise', 'prepare'), 'Freeze')
    assert.equal(phaseName('surprise', 'verification'), 'Verify')
    assert.equal(phaseName('surprise', 'integration'), 'Integrate')
    assert.equal(phaseName('surprise', 'nonsense'), 'Verify')
  })
})

describe('landing wording', () => {
  test('a landing false on both refs reads "integrated into <source_branch>", never "not landed"', () => {
    const text = landingWording({ on_default: false, on_origin: false }, 'main', 'feature/widgets/widgets-003')
    assert.equal(text, 'not on local main or origin/main; integrated into feature/widgets/widgets-003')
    assert.doesNotMatch(text, /not landed/)
  })

  test('on local and on origin', () => {
    assert.equal(landingWording({ on_default: true, on_origin: true }, 'main', 'b'), 'on local main, on origin/main')
    assert.equal(landingWording({ on_default: true, on_origin: false }, 'main', 'b'), 'on local main, not on origin/main')
  })

  test('an unknown ref is shown as unknown', () => {
    assert.match(landingWording({ on_default: null, on_origin: true }, 'main', 'b'), /unknown/)
  })
})

const info = (over: Partial<RailInfo>): RailInfo => ({
  projectId: 'p', name: 'p', waits: 0, paused: 0, running: 0, allBad: false, lastActivity: 0, unpushed: null, ...over,
})

describe('rail order and badge words', () => {
  test('needs you, then running, then readable before unreadable, then by last activity', () => {
    const a = info({ projectId: 'a', lastActivity: 10 })
    const needs = info({ projectId: 'needs', waits: 1, lastActivity: 1 })
    const running = info({ projectId: 'running', running: 2, lastActivity: 1 })
    const bad = info({ projectId: 'bad', allBad: true, lastActivity: 999 })
    const order = railOrder([a, bad, running, needs]).map(x => x.projectId)
    assert.deepEqual(order, ['needs', 'running', 'a', 'bad'])
  })

  test('the badge word is the most pressing state, and unpushed only on the primary', () => {
    assert.equal(railBadge(info({ waits: 2 })), '2 waits on you')
    assert.equal(railBadge(info({ paused: 3 })), '3 paused')
    assert.equal(railBadge(info({ running: 1 })), '1 running')
    assert.equal(railBadge(info({ unpushed: 2 })), '2 unpushed')
    assert.equal(railBadge(info({ unpushed: null })), null)
    // waits outrank everything else.
    assert.equal(railBadge(info({ waits: 1, paused: 2, running: 3, unpushed: 5 })), '1 waits on you')
  })
})

describe('the card state word', () => {
  test('a multi-feature project reads "N of M features <result> last"', () => {
    assert.equal(cardStateWord({ tone: 'fail', waits: 0, running: 0, allBad: false, featureCount: 3, worstLatestCount: 1 }), '1 of 3 features failed last')
  })

  test('a single-feature project reads its own word, and an unreadable one "cannot be read"', () => {
    assert.equal(cardStateWord({ tone: 'ok', waits: 0, running: 0, allBad: false, featureCount: 1, worstLatestCount: 1 }), 'succeeded')
    assert.equal(cardStateWord({ tone: 'idle', waits: 0, running: 0, allBad: true, featureCount: 2, worstLatestCount: 2 }), 'cannot be read')
    assert.equal(cardStateWord({ tone: 'warn', waits: 2, running: 0, allBad: false, featureCount: 3, worstLatestCount: 1 }), '2 waits on you')
  })
})

const pr = (over: Partial<Pr>): Pr => ({
  number: 1, title: 't', url: 'u', state: 'OPEN', draft: false, author: 'someone', author_is_bot: false,
  head_ref: 'x', base_ref: 'main', updated_at: '2026-10-10T00:00:00Z', merged_at: null, review_decision: null, checks: null, labels: [], ...over,
})

describe('the axis column template and short labels (V3)', () => {
  test('the axis and the tracks share one column template; every phase has an un-elided short form', () => {
    assert.equal(CHART_COLUMNS, 'repeat(8, minmax(0, 1fr))')
    assert.equal(PHASE_SHORT.Challenge, 'Chal.')
    assert.equal(PHASE_SHORT.Candidate, 'Cand.')
    assert.equal(PHASE_SHORT.Approval, 'Appr.')
    assert.equal(PHASE_SHORT.Integrate, 'Integ.')
    for (const phase of PHASES) { assert.ok(PHASE_SHORT[phase].length > 0); assert.doesNotMatch(PHASE_SHORT[phase], /…/) }
  })
})

describe('the possibly-related rule ([L5], V14)', () => {
  test('a head match, a base match only when the base is not the default branch, and the match wording', () => {
    const branches = new Set(['feature/x', 'dev'])
    assert.deepEqual(prRelation({ head_ref: 'feature/x', base_ref: 'main' }, branches, 'main'), { kind: 'head', branch: 'feature/x' })
    assert.deepEqual(prRelation({ head_ref: 'z', base_ref: 'dev' }, branches, 'main'), { kind: 'base', branch: 'dev' })
    // base equals the default branch: not related, even though the default is in the branch set.
    assert.equal(prRelation({ head_ref: 'z', base_ref: 'main' }, new Set(['main']), 'main'), null)
    assert.equal(prRelation({ head_ref: 'z', base_ref: 'w' }, branches, 'main'), null)
    assert.equal(relatedWhy({ kind: 'head', branch: 'feature/x' }), 'head is feature/x')
    assert.equal(relatedWhy({ kind: 'base', branch: 'dev' }), 'base is dev')
  })

  test('prGroups applies the rule: a PR whose only tie is the default branch as its base is not related', () => {
    const base = pr({ number: 1, head_ref: 'h', base_ref: 'main' })
    const groups = prGroups([base], { branches: new Set(['main']), viewerLogin: null, readAt: 0, defaultBranch: 'main' })
    assert.deepEqual(groups.related.map(p => p.number), [])
  })
})

describe('commits-ahead and fold wording (V6, V8)', () => {
  test('"and N more" when the ahead count exceeds the listed commits', () => {
    assert.equal(commitsAheadMore(52, 50), 'and 2 more')
    assert.equal(commitsAheadMore(50, 50), null)
    assert.equal(commitsAheadMore(3, 50), null)
  })
  test('"Show N more" when a group is longer than the shown five', () => {
    assert.equal(showMoreText(8, 5), 'Show 3 more')
    assert.equal(showMoreText(6, 5), 'Show 1 more')
    assert.equal(showMoreText(5, 5), null)
  })
})

describe("a commit's run links to its workflow, else shows as older (V24, [L10])", () => {
  const known = new Map<string, string>([['ui-polish-001', 'ui-polish']])
  test('known from the run lists resolves to that workflow', () => {
    assert.equal(resolveRunWorkflow('ui-polish-001', known, null), 'ui-polish')
    // A single-workflow fallback never overrides a known run.
    assert.equal(resolveRunWorkflow('ui-polish-001', known, 'only'), 'ui-polish')
  })
  test('a single-workflow project resolves an unknown run to that one workflow', () => {
    assert.equal(resolveRunWorkflow('ship-900', new Map(), 'ship'), 'ship')
  })
  test('an unknown run on a multi-workflow project resolves to null (shown as older, not a dead link)', () => {
    assert.equal(resolveRunWorkflow('ui-polish-900', known, null), null)
    assert.equal(OLDER_THAN_LISTED, 'older than the newest 50 runs')
  })
})

describe('"Needs you and running" run-list state (V25, [L12] note 5)', () => {
  test('every workflow failed is "Runs not read"; a partial or empty list is not', () => {
    assert.equal(everyRunListFailed([{ error: new Error('x') }, { error: new Error('y') }]), true)
    assert.equal(everyRunListFailed([{ error: null }, { error: new Error('y') }]), false)
    assert.equal(everyRunListFailed([{ error: null }]), false)
    // A project with no workflows is fully read (the plain all-clear), never "Runs not read" with no reason.
    assert.equal(everyRunListFailed([]), false)
  })
})

const github = (over: Partial<GithubState>): GithubState => ({
  status: 'read', reason: null, repo: 'acme/widgets', read_at: '2026-10-11T00:00:00Z', visibility: 'PUBLIC', default_branch: 'main',
  pushed_at: null, head: { sha: 'abc1234', committed_at: '2026-10-10T00:00:00Z' }, open_prs: 0, open_issues: 0, prs: [], issues: [], ...over,
})

describe('the GitHub head line (V26)', () => {
  test('a read with a head shows the head; a read with no head says the branch has no commits; a not-read project says not read', () => {
    assert.equal(githubHeadState(github({})), 'head')
    assert.equal(githubHeadState(github({ head: null })), 'no-head')
    assert.equal(githubHeadState(github({ head: null, default_branch: null })), 'no-head')
    assert.equal(githubHeadState(github({ status: 'not_github', reason: 'not a GitHub remote', repo: null, head: null })), 'not-read')
    assert.equal(githubHeadState(null), 'not-read')
  })
  test('the no-head wording names the default branch only when GitHub reports one, never the local branch', () => {
    assert.equal(githubNoHeadText('main'), "GitHub's main has no commits.")
    assert.equal(githubNoHeadText(null), "GitHub's default branch has no commits.")
  })
})

describe('header wording (V10)', () => {
  test('"same repo as …" names the other projects of the clone, and the no-reflog wording is fixed', () => {
    assert.equal(sameRepoText(['Widgets']), 'same repo as Widgets')
    assert.equal(sameRepoText(['Alpha', 'Beta']), 'same repo as Alpha and Beta')
    assert.equal(sameRepoText(['Alpha', 'Beta', 'Gamma']), 'same repo as Alpha, Beta and Gamma')
    assert.equal(sameRepoText([]), null)
    assert.equal(UPDATE_TIME_NOT_RECORDED, 'update time not recorded')
  })
})

describe('the card state word counts only readable features ([L8], V18)', () => {
  const run = (status: string): RunSummary => ({
    contract_version: '1.5.0', project_id: 't', workflow_id: 'w', definition_revision: 'r', run_id: `${status}-1`,
    status, created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T01:00:00Z',
  } as unknown as RunSummary)
  const wfr = (id: string, runs: RunSummary[], error: unknown = null) => ({ workflow: { workflow_id: id } as unknown as WorkflowDefinition, runs, more: false, error })
  test('three readable workflows (one failed last) plus one error workflow reads "1 of 3 features failed last"', () => {
    const entry: ProjectRuns = {
      project: { project_id: 't', name: 'Trio' } as unknown as Project, error: null,
      workflows: [wfr('a', [run('succeeded')]), wfr('b', [run('cancelled')]), wfr('c', [run('failed')]), wfr('d', [], new Error('unreadable'))],
    }
    const info = projectRunInfo(entry)
    assert.equal(info.readableFeatures, 3)
    assert.equal(info.badFeatures, 1)
    assert.equal(cardStateWord({ tone: info.tone, waits: info.waits, running: info.running, allBad: info.allBad, featureCount: info.readableFeatures, worstLatestCount: info.worstLatestCount }), '1 of 3 features failed last')
  })
})

describe('pull request grouping', () => {
  test('possibly related is an exact branch match only; yours, others and merged split the rest', () => {
    const related = pr({ number: 1, head_ref: 'feature/widgets/widgets-003', author: 'other' })
    const mine = pr({ number: 2, head_ref: 'chore', author: 'me' })
    const others = pr({ number: 3, head_ref: 'chore2', author: 'other' })
    const near = pr({ number: 4, head_ref: 'feature/widgets/widgets-00', author: 'other' }) // not an exact match
    const merged = pr({ number: 5, state: 'MERGED', merged_at: '2026-10-09T00:00:00Z', author: 'other' })
    const old = pr({ number: 6, state: 'MERGED', merged_at: '2026-09-01T00:00:00Z', author: 'other' })
    const groups = prGroups([related, mine, others, near, merged, old], {
      branches: new Set(['feature/widgets/widgets-003']), viewerLogin: 'me', readAt: Date.parse('2026-10-11T00:00:00Z'),
    })
    assert.deepEqual(groups.related.map(p => p.number), [1])
    assert.deepEqual(groups.mine.map(p => p.number), [2])
    assert.deepEqual(groups.others.map(p => p.number), [3, 4])
    assert.deepEqual(groups.merged.map(p => p.number), [5])
  })
})

const issue = (over: Partial<Issue>): Issue => ({
  number: 1, title: 't', url: 'u', author: 'someone', author_is_bot: false, labels: [], assignees: [],
  created_at: '2026-10-10T00:00:00Z', updated_at: '2026-10-10T00:00:00Z', ...over,
})

describe('issue grouping', () => {
  test('assigned to you first, then people, with bots folded', () => {
    const assigned = issue({ number: 1, assignees: ['me'] })
    const person = issue({ number: 2, author: 'alice' })
    const bot1 = issue({ number: 3, author: 'dependabot', author_is_bot: true })
    const bot2 = issue({ number: 4, author: 'dependabot', author_is_bot: true })
    const groups = issueGroups([assigned, person, bot1, bot2], { viewerLogin: 'me' })
    assert.deepEqual(groups.assigned.map(i => i.number), [1])
    assert.deepEqual(groups.people.map(i => i.number), [2])
    assert.equal(groups.botCount, 2)
    assert.deepEqual(groups.botAuthors, ['dependabot'])
  })
})

describe('relative time', () => {
  const readAt = Date.parse('2026-10-11T12:00:00Z')
  test('today, yesterday, days, weeks', () => {
    assert.equal(relTime('2026-10-11T01:00:00Z', readAt), 'today')
    assert.equal(relTime('2026-10-10T23:00:00Z', readAt), 'yesterday')
    assert.equal(relTime('2026-10-05T00:00:00Z', readAt), '6 d ago')
    assert.equal(relTime('2026-09-20T00:00:00Z', readAt), '3 wk ago')
  })

  test('an older date adds the year when it differs from the read year', () => {
    assert.equal(relTime('2026-07-01T00:00:00Z', readAt), 'Jul 1')
    assert.equal(relTime('2025-03-02T00:00:00Z', readAt), 'Mar 2 2025')
  })
})

const git = (over: Partial<GitState>): GitState => ({
  status: 'read', reason: null, repository_label: '~/dev/widgets', checkout: 'main', head: 'abc1234',
  default_branch: 'main', clone_id: 'c1', clone_primary: 'p', origin: null, ahead_commits: [], ahead_naming_run: 0, landings: [], read_at: '2026-10-11T00:00:00Z', ...over,
})

const origin = (over: Partial<NonNullable<GitState['origin']>>): GitState['origin'] => ({
  ref: 'origin/main', sha: 'def5678', updated_at: '2026-10-09T00:00:00Z', compare: 'compared', ahead: 0, behind: 0, ...over,
})

describe('sync wording', () => {
  test('diverged, ahead, behind, level', () => {
    assert.equal(syncPhrase(git({ origin: origin({ ahead: 2, behind: 1 }) }), 'p', null), '2 ahead, 1 behind origin/main')
    assert.equal(syncPhrase(git({ origin: origin({ ahead: 16, behind: 0 }) }), 'p', null), '16 ahead of origin/main')
    assert.equal(syncPhrase(git({ default_branch: 'dev', origin: origin({ ref: 'origin/dev', ahead: 0, behind: 29 }) }), 'p', null), '29 behind origin/dev')
    assert.equal(syncPhrase(git({ origin: origin({ ahead: 0, behind: 0 }) }), 'p', null), 'level with origin/main')
  })

  test('no local branch, no origin, shared clone and git unavailable', () => {
    assert.equal(syncPhrase(git({ default_branch: 'dev', origin: origin({ ref: 'origin/dev', sha: 'abcdef0', compare: 'no_local_branch', ahead: null, behind: null }) }), 'p', null),
      'origin/dev at abcdef0; no local dev to compare')
    assert.equal(syncPhrase(git({ origin: null }), 'p', null), 'not compared with origin')
    assert.equal(syncPhrase(git({ clone_primary: 'primary' }), 'worktree', 'The Primary'), 'shares its clone with The Primary')
    assert.equal(syncPhrase(git({ status: 'unavailable', reason: 'not a git repository', origin: null }), 'p', null), 'git not read: not a git repository')
  })

  test('the as-of addendum names the ref and whether its time was recorded', () => {
    assert.deepEqual(syncAsOf(git({ origin: origin({ ahead: 1, updated_at: '2026-10-09T11:54:00Z' }) })), { ref: 'origin/main', updatedAt: '2026-10-09T11:54:00Z' })
    assert.deepEqual(syncAsOf(git({ origin: origin({ ahead: 1, updated_at: null }) })), { ref: 'origin/main', updatedAt: null })
    assert.equal(syncAsOf(git({ origin: null })), null)
  })
})

describe('a project\'s run state while it loads, when it failed, once read (M1)', () => {
  test('a read that has not settled is loading: nothing failed, nothing counted, no badge', () => {
    const info = projectRunInfo(null)
    assert.equal(info.state, 'loading')
    assert.equal(info.allBad, false)
    assert.equal(railBadge({ ...info, projectId: 'p', name: 'p', unpushed: 3, loading: true }), null)
    assert.equal(cardStateWord({ tone: info.tone, waits: 0, running: 0, allBad: info.allBad, loading: true, featureCount: 0, worstLatestCount: 0 }), 'reading runs…')
  })
  test('an errored entry, or one whose every workflow failed, is failed and reads "cannot be read"', () => {
    const errored = projectRunInfo({ project: { project_id: 't', name: 'T' } as unknown as Project, error: new Error('down'), workflows: [] })
    assert.equal(errored.state, 'failed')
    assert.equal(errored.allBad, true)
    assert.equal(FAILED_RUN_INFO.state, 'failed')
    const allFailed = projectRunInfo({ project: { project_id: 't', name: 'T' } as unknown as Project, error: null, workflows: [{ workflow: { workflow_id: 'w' } as unknown as WorkflowDefinition, runs: [], more: false, error: new Error('x') }] })
    assert.equal(allFailed.state, 'failed')
    assert.equal(cardStateWord({ tone: allFailed.tone, waits: 0, running: 0, allBad: allFailed.allBad, featureCount: 0, worstLatestCount: 0 }), 'cannot be read')
  })
})

describe('badges carry their own state tone (M19)', () => {
  const run = (runId: string, workflowId: string, status: string, created: string, attention: object | null = null): RunSummary => ({
    contract_version: '1.5.0', project_id: 'q', workflow_id: workflowId, definition_revision: 'r', run_id: runId, status, created_at: created, updated_at: created,
    activity: { feature: 'F', last_activity_at: created, finished_at: ['succeeded', 'failed', 'cancelled'].includes(status) ? created : null, focus: null, attention, waiting_questions: 0, headline: null, controller: null },
  } as unknown as RunSummary)
  const entry = (runs: RunSummary[]): ProjectRuns => ({
    project: { project_id: 'q', name: 'Q' } as unknown as Project, error: null,
    workflows: [...new Set(runs.map(item => item.workflow_id))].map(id => ({ workflow: { workflow_id: id } as unknown as WorkflowDefinition, runs: runs.filter(item => item.workflow_id === id), more: false, error: null })),
  })
  const rail = (info: ReturnType<typeof projectRunInfo>): RailInfo => ({ projectId: 'q', name: 'Q', waits: info.waits, paused: info.paused, running: info.running, allBad: info.allBad, lastActivity: info.lastActivity, unpushed: null })
  test('each badge is toned by what it counts: warn for waits, pause for paused, run for running, neutral otherwise', () => {
    assert.equal(railBadgeTone(info({ waits: 1, paused: 2, running: 3 })), 'warn')
    assert.equal(railBadgeTone(info({ paused: 2, running: 3 })), 'pause')
    assert.equal(railBadgeTone(info({ running: 3 })), 'run')
    assert.equal(railBadgeTone(info({ unpushed: 2 })), null)
    assert.equal(railBadgeTone(info({ waits: 1, loading: true })), null)
  })
  test('a live paused run sets the pause glyph when nothing waits or runs, even when a newer run of another feature was cancelled or failed', () => {
    const paused = run('parked-1', 'parked', 'paused', '2024-11-01T08:00:00Z', { kind: 'paused', node_id: 'review', since: '2024-11-01T09:00:00Z' })
    for (const status of ['cancelled', 'failed', 'succeeded']) {
      const info = projectRunInfo(entry([paused, run('dropped-1', 'dropped', status, '2025-02-01T08:00:00Z')]))
      assert.equal(info.paused, 1, status)
      assert.equal(info.tone, 'pause', status)
      assert.equal(railBadge(rail(info)), '1 paused')
      assert.equal(railBadgeTone(rail(info)), 'pause')
    }
  })
  test('a paused run superseded in its own workflow adds no paused badge', () => {
    const old = run('redo-1', 'redo', 'paused', '2024-12-02T08:00:00Z', { kind: 'paused', node_id: 'handoff', since: '2024-12-02T09:00:00Z' })
    const info = projectRunInfo(entry([old, run('redo-2', 'redo', 'succeeded', '2024-12-03T08:00:00Z')]))
    assert.equal(info.paused, 0)
    assert.equal(railBadge(rail(info)), null)
    assert.notEqual(info.tone, 'pause')
  })
  test('a decision-waiting or interrupted running run counts as a wait, never running; a plain running run is running', () => {
    const decide = run('decide-1', 'decide', 'paused', '2024-12-01T08:00:00Z', { kind: 'paused', node_id: 'challenge', since: '2024-12-01T08:04:00Z' })
    const halted = run('halt-1', 'halt', 'running', '2024-12-04T10:00:00Z', { kind: 'interrupted', node_id: 'launch_ui', since: '2024-12-04T10:30:00Z' })
    const info = projectRunInfo(entry([decide, halted]))
    assert.equal(info.waits, 2)
    assert.equal(info.running, 0)
    assert.equal(railBadge(rail(info)), '2 waits on you')
    assert.equal(railBadgeTone(rail(info)), 'warn')
    const live = projectRunInfo(entry([run('live-1', 'live', 'running', '2024-12-04T10:00:00Z')]))
    assert.equal(railBadge(rail(live)), '1 running')
    assert.equal(railBadgeTone(rail(live)), 'run')
    assert.equal(live.tone, 'run')
  })
  test('the card says the paused count when nothing waits or runs', () => {
    assert.equal(cardStateWord({ tone: 'pause', waits: 0, running: 0, paused: 2, allBad: false, featureCount: 3, worstLatestCount: 1 }), '2 paused')
  })
})

describe('the step chart claims no stop while a run\'s steps are not read (M1)', () => {
  const run = (status: string): RunSummary => ({
    contract_version: '1.5.0', project_id: 'q', workflow_id: 'w', definition_revision: 'r', run_id: `w-${status}`, status, created_at: '2026-03-19T09:00:00Z', updated_at: '2026-03-19T09:00:00Z',
    activity: { feature: 'F', last_activity_at: '2026-03-19T09:00:00Z', finished_at: '2026-03-19T09:00:00Z', focus: null, attention: null, waiting_questions: 0, headline: null, controller: null },
  } as unknown as RunSummary)
  const cls = { needs: null, supersededBy: null } as unknown as RunClass
  const steps: ProjectStepsRun = {
    run_id: 'w-failed', source_branch: null, base_commit: null, integrated_commit: null, lanes: [],
    steps: [
      { node_id: 'challenge', label: 'Challenge', kind: 'agent', status: 'succeeded', attempt: 1 },
      { node_id: 'verify_ui', label: 'Verify ui', kind: 'command', status: 'failed', attempt: 1 },
    ],
  }
  test('a failed run without its steps has no stop and counts in no phase; with them it ends at its failed step', () => {
    assert.equal(stopOf({ run: run('failed'), cls, steps: null }), null)
    assert.deepEqual(endedCounts([{ run: run('failed'), cls, steps: null }, { run: run('cancelled'), cls, steps: null }]), PHASES.map(() => 0))
    const counts = endedCounts([{ run: run('failed'), cls, steps }])
    assert.equal(counts[phaseOf('verify_ui', 'command')], 1)
    assert.equal(counts.reduce((a: number, b: number) => a + b, 0), 1)
  })
  test('a row with no stop says its steps are reading while they load, "not read" only for a failed read, and "no steps recorded" for a read without them', () => {
    assert.deepEqual(noStopWording('loading'), { text: 'reading steps…', aria: 'Reading its steps.' })
    assert.deepEqual(noStopWording('failed'), { text: 'steps not read', aria: 'Steps not read.' })
    assert.deepEqual(noStopWording('read'), { text: 'no steps recorded', aria: 'No steps recorded.' })
    for (const state of ['loading', 'read'] as const) assert.doesNotMatch(`${noStopWording(state).text} ${noStopWording(state).aria}`, /not read|cannot/i)
  })
  test('a run whose own steps entry failed reads "failed", and a feature\'s landing is unknown until every run\'s steps are read (M1)', () => {
    const failedEntry = { run: run('failed'), cls, steps: null, stepsError: { code: 'unreadable', message: 'state.json is corrupt' } }
    const absentEntry = { run: run('failed'), cls, steps: null }
    assert.equal(runStepsRead(failedEntry, 'read'), 'failed')
    assert.equal(runStepsRead(absentEntry, 'read'), 'read')
    assert.equal(runStepsRead(absentEntry, 'loading'), 'loading')
    assert.equal(landingKnown([absentEntry], 'loading'), false)
    assert.equal(landingKnown([absentEntry], 'failed'), false)
    assert.equal(landingKnown([absentEntry, failedEntry], 'read'), false)
    assert.equal(landingKnown([absentEntry, { run: run('failed'), cls, steps }], 'read'), true)
  })
})
