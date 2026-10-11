/**
 * The dispatch pages' pure logic (docs/PRD_PROJECTS_DISPATCH.md sections 4 and 5): the step-to-phase map (node_id first,
 * kind as the fallback, [L2]/[P22]), the landing wording for a commit on neither ref, the rail order and badge words, the
 * card state word, pull-request and issue grouping, the relative time that adds the year, and the sync wording for every
 * origin state.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { PHASES, phaseOf } from '../../src/projects/dispatch/phases.ts'
import {
  cardStateWord, issueGroups, landingWording, prGroups, railBadge, railOrder, relTime, syncAsOf, syncPhrase,
  type RailInfo,
} from '../../src/projects/dispatch/derive.ts'
import type { GitState, Issue, Pr } from '../../src/projects/dispatch/types.ts'

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
