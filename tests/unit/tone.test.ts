/**
 * The one mapping from state to colour tone (docs/PRD_VIEWER_REVAMP.md section 4): every run status, attention kind and
 * severity maps to a tone, an unknown value is idle, attention wins over status, and the
 * contrast helper the `revamp-look` scenario measures with follows WCAG 2. The team and GitHub tones (docs/PRD_RUN_TEAMS.md 8)
 * each return a tone and its lower-case word, and the run switcher's suffixes follow section 2.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { STATUS_LABEL, type RunStatus } from '../../src/projects/status.ts'
import {
  agentTone, attentionTone, checkTone, contrastRatio, parseColor, phaseTone, precedenceTone, prTone, pushTone, severityClass, severityTone, stateTone, statusTone, TONE_LABEL,
  toneClass, workflowTone, type Tone,
} from '../../src/projects/tone.ts'
import { AGENT_STATES, WORKFLOW_STATUSES, type AgentState, type TeamPhase, type Teams, type WorkflowStatus } from '../../contracts/projects/teams.ts'
import { CHECK_BUCKETS, PUSH_STATES, type PushState } from '../../contracts/projects/github.ts'
import * as examples from '../../contracts/projects/teamExamples.ts'
import { teamSuffix } from '../../src/projects/teams/model.ts'
import { githubSuffix } from '../../src/projects/github/model.ts'

const TONES: readonly Tone[] = ['ok', 'run', 'warn', 'fail', 'pause', 'override', 'idle']

describe('statusTone', () => {
  test('maps every run status of the contract to a tone', () => {
    const expected: Record<RunStatus, Tone> = {
      pending: 'idle', running: 'run', awaiting_approval: 'warn', paused: 'pause', succeeded: 'ok', failed: 'fail', cancelled: 'idle',
    }
    const statuses = Object.keys(STATUS_LABEL) as RunStatus[]
    for (const status of statuses) assert.equal(statusTone(status), expected[status], status)
    assert.deepEqual([...statuses].sort(), Object.keys(expected).sort())
  })
  test('an unknown or empty status is idle', () => {
    assert.equal(statusTone('exploded'), 'idle')
    assert.equal(statusTone(''), 'idle')
    assert.equal(statusTone('toString'), 'idle')
  })
})

describe('attentionTone', () => {
  test('maps every served attention kind', () => {
    assert.equal(attentionTone('question'), 'warn')
    assert.equal(attentionTone('pane'), 'warn')
    assert.equal(attentionTone('approval'), 'warn')
    assert.equal(attentionTone('interrupted'), 'pause')
    assert.equal(attentionTone('paused'), 'pause')
    assert.equal(attentionTone('failed'), 'fail')
  })
  test('an unknown kind is idle', () => {
    assert.equal(attentionTone('bored'), 'idle')
    assert.equal(attentionTone('constructor'), 'idle')
  })
})

describe('severityTone', () => {
  test('maps P0, P1 and P2 and treats anything else as P2', () => {
    assert.equal(severityTone('P0'), 'p0')
    assert.equal(severityTone('P1'), 'p1')
    assert.equal(severityTone('P2'), 'p2')
    assert.equal(severityTone('P9'), 'p2')
    assert.equal(severityClass(severityTone('P0')), 'sev-p0')
  })
})

describe('stateTone', () => {
  test('attention wins over status; status alone maps; nothing is idle', () => {
    assert.equal(stateTone({ status: 'running', attention: 'question' }), 'warn')
    assert.equal(stateTone({ status: 'running', attention: 'failed' }), 'fail')
    assert.equal(stateTone({ status: 'paused', attention: null }), 'pause')
    assert.equal(stateTone({ status: 'succeeded' }), 'ok')
    assert.equal(stateTone({}), 'idle')
    assert.equal(stateTone({ status: 'weird' }), 'idle')
  })
  test('every tone has a class and a label, so colour never carries the state alone', () => {
    for (const tone of TONES) {
      assert.equal(toneClass(tone), `tone-${tone}`)
      assert.ok(TONE_LABEL[tone].length > 0, tone)
    }
    assert.deepEqual(Object.keys(TONE_LABEL).sort(), [...TONES].sort())
  })
})

describe('contrastRatio', () => {
  test('parses hex and rgb() colours as the browser resolves them', () => {
    assert.deepEqual(parseColor('#fff'), [255, 255, 255, 1])
    assert.deepEqual(parseColor(' #1a6b3e '), [26, 107, 62, 1])
    assert.deepEqual(parseColor('rgb(10, 20, 30)'), [10, 20, 30, 1])
    assert.deepEqual(parseColor('rgba(10, 20, 30, 0.5)'), [10, 20, 30, 0.5])
    assert.deepEqual(parseColor('transparent'), [0, 0, 0, 0])
    assert.equal(parseColor('var(--fg)'), null)
  })
  test('follows WCAG 2: black on white is 21, a colour on itself is 1, the order does not matter', () => {
    assert.equal(Math.round(contrastRatio('#000000', '#ffffff') * 10) / 10, 21)
    assert.equal(contrastRatio('#777777', '#777777'), 1)
    assert.equal(contrastRatio('#1a6b3e', '#dff3e6'), contrastRatio('#dff3e6', '#1a6b3e'))
    // #767676 on white is the classic 4.54:1 boundary colour.
    assert.ok(contrastRatio('rgb(118, 118, 118)', '#ffffff') >= 4.5)
    assert.ok(contrastRatio('#777777', '#ffffff') < 4.5)
  })
})

// ---- Teams and GitHub (docs/PRD_RUN_TEAMS.md 8 and 2) ------------------------------------------------------------------

describe('the team and GitHub tones (docs/PRD_RUN_TEAMS.md 8)', () => {
  test('agentTone and workflowTone follow the table, with the contract word lower case', () => {
    const agents: Record<AgentState, Tone> = { done: 'ok', running: 'run', failed: 'fail', interrupted: 'pause', queued: 'idle' }
    for (const state of AGENT_STATES) assert.deepEqual(agentTone(state), { tone: agents[state], word: state }, state)
    const workflows: Record<WorkflowStatus, Tone> = { completed: 'ok', running: 'run', failed: 'fail', interrupted: 'pause', killed: 'idle' }
    for (const status of WORKFLOW_STATUSES) assert.deepEqual(workflowTone(status), { tone: workflows[status], word: status }, status)
  })

  test('phaseTone takes fail > run > pause > ok > idle, never a percentage', () => {
    const phase = (counts: Partial<TeamPhase>) => ({ agents: 0, queued: 0, running: 0, done: 0, failed: 0, interrupted: 0, ...counts })
    assert.deepEqual(phaseTone(phase({ agents: 6, running: 2, done: 3, failed: 1 })), { tone: 'fail', word: 'failed' })
    assert.deepEqual(phaseTone(phase({ agents: 4, running: 1, interrupted: 1, done: 2 })), { tone: 'run', word: 'running' })
    assert.deepEqual(phaseTone(phase({ agents: 3, interrupted: 1, done: 2 })), { tone: 'pause', word: 'interrupted' })
    assert.deepEqual(phaseTone(phase({ agents: 2, done: 2 })), { tone: 'ok', word: 'all done' })
    assert.deepEqual(phaseTone(phase({})), { tone: 'idle', word: 'not started' })
    assert.deepEqual(phaseTone(phase({ agents: 6, queued: 6 })), { tone: 'idle', word: 'queued' })
    assert.deepEqual(phaseTone(phase({ agents: 6, queued: 4, done: 2 })), { tone: 'idle', word: 'queued' })
  })

  test('pushTone: up to date ok, behind GitHub warn, diverged fail, every other state idle', () => {
    const expected: Record<PushState, [Tone, string]> = {
      up_to_date: ['ok', 'up to date'], remote_ahead: ['warn', 'behind GitHub'], diverged: ['fail', 'diverged'], not_pushed: ['idle', 'not pushed'],
      local_ahead: ['idle', 'ahead'], unknown: ['idle', 'unknown'], no_local_branch: ['idle', 'not in repo'],
    }
    for (const state of PUSH_STATES) assert.deepEqual(pushTone(state), { tone: expected[state][0], word: expected[state][1] }, state)
  })

  test('prTone: merged ok, closed and draft idle, conflicts and changes requested fail, approved ok, review required idle, open run', () => {
    const open = { state: 'OPEN', draft: false, mergeable: 'MERGEABLE', review_decision: null } as const
    assert.deepEqual(prTone({ ...open, state: 'MERGED' }), { tone: 'ok', word: 'merged' })
    assert.deepEqual(prTone({ ...open, state: 'CLOSED', draft: true }), { tone: 'idle', word: 'closed' })
    assert.deepEqual(prTone({ ...open, draft: true, mergeable: 'CONFLICTING' }), { tone: 'idle', word: 'draft' })
    assert.deepEqual(prTone({ ...open, mergeable: 'CONFLICTING', review_decision: 'APPROVED' }), { tone: 'fail', word: 'conflicts' })
    assert.deepEqual(prTone({ ...open, review_decision: 'CHANGES_REQUESTED' }), { tone: 'fail', word: 'changes requested' })
    assert.deepEqual(prTone({ ...open, review_decision: 'APPROVED' }), { tone: 'ok', word: 'approved' })
    assert.deepEqual(prTone({ ...open, review_decision: 'REVIEW_REQUIRED' }), { tone: 'idle', word: 'review required' })
    assert.deepEqual(prTone(open), { tone: 'run', word: 'open' })
    assert.deepEqual(prTone(examples.runGithub.pr!), { tone: 'idle', word: 'draft' })
  })

  test('checkTone: pass ok, fail fail, pending run, skip and neutral idle', () => {
    const expected: Record<(typeof CHECK_BUCKETS)[number], [Tone, string]> = { pass: ['ok', 'pass'], fail: ['fail', 'failing'], pending: ['run', 'pending'], skip: ['idle', 'skipped'], neutral: ['idle', 'neutral'] }
    for (const bucket of CHECK_BUCKETS) assert.deepEqual(checkTone(bucket), { tone: expected[bucket][0], word: expected[bucket][1] }, bucket)
  })

  test('precedenceTone: a failure is never hidden by activity', () => {
    assert.equal(precedenceTone(['ok', 'run', 'fail', 'pause']), 'fail')
    assert.equal(precedenceTone(['ok', 'pause', 'run']), 'run')
    assert.equal(precedenceTone(['ok', 'pause', 'idle']), 'pause')
    assert.equal(precedenceTone(['idle', 'ok']), 'ok')
    assert.equal(precedenceTone([]), 'idle')
  })
})

describe('the switcher suffixes (docs/PRD_RUN_TEAMS.md 2)', () => {
  const teams = examples.teams
  const withTotals = (totals: Partial<Teams['totals']>, sessions = teams.sessions): Teams => ({ ...teams, sessions, totals: { ...teams.totals, ...totals } })
  const statuses = (status: Teams['sessions'][number]['workflows'][number]['status']) => teams.sessions.map(session => ({ ...session, workflows: session.workflows.map(workflow => ({ ...workflow, status })) }))

  test('Team: running (with failures), failed, interrupted, agents, or none', () => {
    assert.deepEqual(teamSuffix(teams), { tone: 'run', word: '1 running · 1 failed', spoken: '1 agent running, 1 failed' })
    assert.deepEqual(teamSuffix(withTotals({ running: 3, failed: 0 })), { tone: 'run', word: '3 running', spoken: '3 agents running' })
    assert.deepEqual(teamSuffix(withTotals({ running: 0, failed: 2, workflows_running: 0 })), { tone: 'fail', word: '2 failed', spoken: '2 agents failed' })
    assert.deepEqual(teamSuffix(withTotals({ running: 0, failed: 0, workflows_running: 0 }, statuses('interrupted'))), { tone: 'pause', word: 'interrupted', spoken: 'a team workflow was interrupted' })
    assert.deepEqual(teamSuffix(withTotals({ running: 0, failed: 0, workflows_running: 0 }, statuses('completed'))), { tone: null, word: '8 agents', spoken: '8 agents' })
    assert.deepEqual(teamSuffix(withTotals({ running: 0, failed: 0, workflows_running: 0, agents: 1 }, statuses('killed'))), { tone: null, word: '1 agent', spoken: '1 agent' })
    // An interrupted workflow beside a running one is not "interrupted".
    assert.equal(teamSuffix(withTotals({ running: 0, failed: 0, workflows_running: 1 }, statuses('interrupted')))?.tone, null)
    assert.equal(teamSuffix(null), null)
    assert.equal(teamSuffix(withTotals({ sessions_with_teams: 0 })), null)
  })

  test('GitHub: the section 4.2 situation\'s suffix and tone (tests/unit/github.test.ts has every row), none when not served', () => {
    assert.equal(githubSuffix(null), null)
    assert.deepEqual(githubSuffix({ ...examples.runGithub, github: { ...examples.runGithub.github, status: 'pending' } }), { tone: 'idle', word: 'reading', spoken: 'reading GitHub' })
    assert.deepEqual(githubSuffix(examples.runGithub), { tone: 'fail', word: '#531 checks failing', spoken: 'pull request 531, checks failing' })
    assert.equal(githubSuffix({ ...examples.runGithub, pr: null, branch: { ...examples.runGithub.branch, push_state: 'not_pushed' } })?.word, 'not pushed')
  })
})
