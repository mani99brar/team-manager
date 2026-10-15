/**
 * The run-sessions card model (src/projects/sessions/model.ts, src/projects/signal/, docs/PRD_RUN_SESSIONS.md 3.1-3.5): the
 * stage cards of reviewer, panel and lane-review nodes (word, tone, open P0/P1, cost; a blocked reviewer succeeded with a
 * non-ok tone), the executor wording of the owned wrapper per projected kind, the Sessions grouping and totals, the resume
 * command text, and the night-shift block's wording (executed, held, a Jev pick, a Jev error, Jev not called). The payload
 * is the browser fixture's own, so the run page, the stage and these tests read the same cards.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { NightShiftDecision, SessionRow, Sessions } from '../../contracts/projects/sessions.ts'
import {
  aggregateCostText, costText, decisionsForNode, durationText, fixRoundShort, fixRoundText, groupSessions, jevText, laneResultText,
  nightShiftCountText, nightShiftNodes, outcomeText, panelMeaning, providerText, resumeText, RESUME_NOTE, reviewerRoundsOf, reviewerTone, sessionsForNode,
  sessionsCueText, spentText, stageCardOf, totalsText,
} from '../../src/projects/sessions/model.ts'
import { stageExecutor } from '../../src/projects/signal/executor.ts'
import { stageNodes } from '../../src/projects/signal/model.ts'
import { formatSpan } from '../../src/projects/time.ts'
import { PANEL, RUN_SESSIONS, sessionsPayload, UX_SESSIONS_WORKFLOW_ID } from '../project-workflows/fixtures/sessions.ts'
import { runDetails } from '../project-workflows/fixtures.ts'
import '../project-workflows/fixtures/index.ts'
import { injectSessionNodes } from '../project-workflows/sessionProjection.ts'

const PAYLOAD: Sessions = sessionsPayload(RUN_SESSIONS, UX_SESSIONS_WORKFLOW_ID, 'home', true)
const BARE: Sessions = sessionsPayload(RUN_SESSIONS, UX_SESSIONS_WORKFLOW_ID, 'bare', true)

test('stageCardOf: reviewer cards carry their verdict, a fail tone when blocked, the open P0/P1 and the metered cost', () => {
  const general = stageCardOf(PAYLOAD, 'reviewer-general')!
  assert.deepEqual([general.word, general.tone, general.openP01, general.cost], ['blocked', 'fail', 2, '$4.20 reported by Claude'])
  const coverage = stageCardOf(PAYLOAD, 'reviewer-coverage')!
  assert.deepEqual([coverage.word, coverage.tone, coverage.openP01], ['late blocked', 'fail', 1])
  const critique = stageCardOf(PAYLOAD, 'reviewer-critique')!
  assert.deepEqual([critique.word, critique.tone, critique.openP01, critique.cost], ['approved', 'ok', 0, '$0.48 reported by Claude'])
  assert.deepEqual([general.models, general.seconds], [['claude-opus-5-5'], 2400])
  for (const [word, tone] of [['running', 'run'], ['not started', 'idle'], ['failed', 'fail'], ['approved', 'ok'], ['late approved', 'ok']] as const) assert.equal(reviewerTone(word), tone, word)
})

test('stageCardOf: the panel card aggregates its providers; costs stay apart', () => {
  const panel = stageCardOf(PAYLOAD, 'panel', PANEL)!
  assert.deepEqual([panel.word, panel.tone, panel.openP01, panel.cost], ['reviewed', 'ok', 1, '$1.10 reported by Claude · $0.20 covered'])
  assert.deepEqual(panel.models, ['openai-codex/gpt-6-sol', 'claude'])
  assert.equal(panel.did, '2 of 2 providers answered; 1 open P0/P1.')
  // Until the panel record has loaded the card says "not recorded" in the neutral tone, never a provider-derived word.
  assert.equal(stageCardOf(PAYLOAD, 'panel')!.word, 'not recorded')
})

type PanelEntry = (typeof PANEL)['panels'][number]
const provider = (model: string, status: PanelEntry['providers'][number]['status']): PanelEntry['providers'][number] =>
  ({ transport: 'pi', model, effort: null, status, cost_usd: 0.1, context_bytes: 1, finding_ids: [], error: status === 'ok' ? null : 'timed out after 600s' })
const finding = (id: string, severity: 'P0' | 'P1' | 'P2', accepted: boolean, raised: string[]): PanelEntry['findings'][number] =>
  ({ id, severity, file: 'a.ts', line: 1, title: id, detail: id, providers_raised: raised, accepted, unanchored: false })
const panelRecord = (status: PanelEntry['status'], providers: PanelEntry['providers'], findings: PanelEntry['findings'] = []) =>
  ({ panels: [{ ...PANEL.panels[0]!, status, providers, findings }] })

test('panelCard: the word follows the panel\'s own recorded status, the sheet counts the providers that answered ([L12] 1)', () => {
  // A succeeded panel with one provider timed out: reviewed, "2 of 3 providers answered", whatever the provider rows say.
  const timedOutRows: Sessions = { ...PAYLOAD, sessions: PAYLOAD.sessions.map(row => row.role === 'panel_provider' ? { ...row, status: 'stopped' as const } : row) }
  const succeeded = stageCardOf(timedOutRows, 'panel', panelRecord('succeeded', [provider('a/x', 'ok'), provider('b/y', 'ok'), provider('c/z', 'timed_out')]))!
  assert.deepEqual([succeeded.word, succeeded.tone], ['reviewed', 'ok'])
  assert.match(succeeded.did, /^2 of 3 providers answered; /)
  // A failed or timed-out panel reads failed; a running one running; an all-pending one not started.
  for (const status of ['failed', 'timed_out'] as const) {
    const card = stageCardOf(PAYLOAD, 'panel', panelRecord(status, [provider('a/x', 'error')]))!
    assert.deepEqual([card.word, card.tone], ['failed', 'fail'], status)
  }
  const running = stageCardOf(PAYLOAD, 'panel', panelRecord('running', [provider('a/x', 'running'), provider('b/y', 'ok')]))!
  assert.deepEqual([running.word, running.tone, running.did.startsWith('2 providers running')], ['running', 'run', true])
  assert.equal(stageCardOf(PAYLOAD, 'panel', panelRecord('pending', [provider('a/x', 'pending')]))!.word, 'not started')
})

test('panelCard: open P0/P1 counts the findings the panel accepted, once each, not every provider\'s ([L12] 1)', () => {
  // Two providers raised the same P1; the panel merged it into one accepted finding and rejected another P1 and a P0.
  const record = panelRecord('succeeded', [provider('a/x', 'ok'), provider('b/y', 'ok')], [
    finding('dup', 'P1', true, ['a/x', 'b/y']), finding('rejected', 'P1', false, ['a/x']), finding('rejected-p0', 'P0', false, ['b/y']), finding('minor', 'P2', true, ['a/x']),
  ])
  const twoRaised: Sessions = { ...PAYLOAD, sessions: PAYLOAD.sessions.map(row => row.role === 'panel_provider' ? { ...row, findings: { p0: 1, p1: 2, p2: 1 } } : row) }
  const card = stageCardOf(twoRaised, 'panel', record)!
  assert.equal(card.openP01, 1)
  assert.equal(card.did, '2 of 2 providers answered; 1 open P0/P1.')
})

test('panelCard: when the panels route fails or has not answered, the card never claims the node\'s served succeeded (run-sessions-006 review B)', () => {
  // The panel node's served status is `succeeded` for a failed panel too (PRD 3.2), so an unread record reads not recorded.
  const detail = injectSessionNodes(runDetails[RUN_SESSIONS]!)
  assert.equal(detail.snapshot.nodes.find(node => node.node_id === 'panel')!.status, 'succeeded')
  const nodes = stageNodes({ detail, rows: [], timeline: null, events: [], inputs: null, review: null, attention: null, reviewRound: null, sessions: PAYLOAD, panels: null }, formatSpan)
  const node = nodes.find(entry => entry.id === 'panel')!
  assert.deepEqual([node.status, node.word, node.tone, node.openFindings, node.cost], ['succeeded', 'not recorded', 'idle', null, 'cost not recorded'])
  assert.equal(node.did, 'The panel record has not loaded, so its state is not recorded.')
  for (const sessions of [PAYLOAD, null]) {
    const card = stageCardOf(sessions, 'panel', null)!
    assert.notEqual(card.word, 'succeeded')
    assert.deepEqual([card.word, card.tone], ['not recorded', 'idle'])
  }
})

test('panelCard: the Panel card reads the review-stage panels only, never the design challenge\'s (run-sessions-006 review D)', () => {
  // The panel-challenge shape: a challenge-stage panel that succeeded (two providers answered, one accepted P1) beside the
  // review stage's pending panel. The card is the review panel's: not started, no providers answered, no open P0/P1.
  const challenge = { ...PANEL.panels[0]!, id: 'challenge-panel', stage: 'challenge' as const, status: 'succeeded' as const, providers: [provider('a/x', 'ok'), provider('b/y', 'ok')], findings: [finding('f1', 'P1', true, ['a/x', 'b/y'])] }
  const review = { ...PANEL.panels[0]!, status: 'pending' as const, started_at: null, ended_at: null, providers: [provider('a/x', 'pending'), provider('b/y', 'pending')], findings: [] }
  const card = stageCardOf(PAYLOAD, 'panel', { panels: [challenge, review] })!
  assert.deepEqual([card.word, card.tone, card.openP01, card.did, card.startedAt], ['not started', 'idle', null, 'Not started.', null])
  // Once the review panel ran, the counts are its own: 1 of 2 answered, 0 open (the challenge's accepted P1 is not counted).
  const ran = { ...review, status: 'succeeded' as const, started_at: PANEL.panels[0]!.started_at, ended_at: PANEL.panels[0]!.ended_at, providers: [provider('c/z', 'ok'), provider('d/w', 'timed_out')] }
  const after = stageCardOf(PAYLOAD, 'panel', { panels: [challenge, ran] })!
  assert.deepEqual([after.word, after.openP01, after.did, after.models], ['reviewed', 0, '1 of 2 providers answered; 0 open P0/P1.', ['c/z', 'd/w']])
  // A failed challenge panel does not turn the review card red; a record with no review-stage panel reads not recorded.
  assert.equal(stageCardOf(PAYLOAD, 'panel', { panels: [{ ...challenge, status: 'failed' }, ran] })!.word, 'reviewed')
  assert.deepEqual([stageCardOf(PAYLOAD, 'panel', { panels: [challenge] })!.word, stageCardOf(PAYLOAD, 'panel', { panels: [challenge] })!.tone], ['not recorded', 'idle'])
})

test('panelMeaning: a failed or timed-out review panel says so on its succeeded node page; a succeeded one keeps the header wording (run-sessions-006 review C)', () => {
  for (const [status, word] of [['failed', 'failed'], ['timed_out', 'timed out']] as const) {
    assert.equal(panelMeaning(panelRecord(status, [provider('a/x', 'error')])), `The panel ${word} (report-only; the run's verdict is unchanged). Its error is below.`)
  }
  assert.equal(panelMeaning(panelRecord('succeeded', [provider('a/x', 'ok')])), null)
  assert.equal(panelMeaning({ panels: [{ ...PANEL.panels[0]!, stage: 'challenge', status: 'failed' }] }), null)
  assert.equal(panelMeaning(null), 'The panel record did not load, so whether the panel failed is not recorded.')
})

test('stageCardOf: a lane-review card says its fix round in short form, its result and cost', () => {
  const server = stageCardOf(PAYLOAD, 'lane-review-server-1')!
  assert.deepEqual([server.word, server.tone, server.openP01, server.cost], ['repair 1 started', 'fail', 1, '$0.13 covered'])
  assert.equal(server.did, '0 P0, 1 P1. Fix round started: repair 1.')
  const viewer = stageCardOf(PAYLOAD, 'lane-review-viewer-1')!
  assert.equal(viewer.word, 'no fix round')
  assert.equal(viewer.did, '0 P0, 1 P1. Recorded; no fix round: rounds used up, fix loop off or repair cap.')
  const review = PAYLOAD.lane_reviews[1]!
  assert.deepEqual([fixRoundText(review), fixRoundShort(review), laneResultText(review)], ['Recorded; no fix round: rounds used up, fix loop off or repair cap', 'no fix round', '0 P0, 1 P1'])
  const failed = { ...review, fix_round: { started: false as const, reason: 'the review failed: provider exploded' } }
  assert.equal(stageCardOf({ ...PAYLOAD, lane_reviews: [failed] }, review.node_id)!.tone, 'fail')
  const running = { ...review, status: 'running' }
  assert.deepEqual([stageCardOf({ ...PAYLOAD, lane_reviews: [running] }, review.node_id)!.word, stageCardOf({ ...PAYLOAD, lane_reviews: [running] }, review.node_id)!.tone], ['running', 'run'])
})

test('stageNodes: a blocked reviewer node is succeeded with a non-ok tone; projected cards take the session facts', () => {
  const detail = injectSessionNodes(runDetails[RUN_SESSIONS]!)
  const nodes = stageNodes({ detail, rows: [], timeline: null, events: [], inputs: null, review: null, attention: null, reviewRound: null, sessions: PAYLOAD, panels: PANEL }, formatSpan)
  const general = nodes.find(node => node.id === 'reviewer-general')!
  assert.deepEqual([general.status, general.tone, general.word, general.projected, general.openFindings, general.cost], ['succeeded', 'fail', 'blocked', 'reviewer', 2, '$4.20 reported by Claude'])
  assert.equal(general.start?.at, '2025-09-20T12:05:00.000Z')
  assert.equal(general.ms, 2400000)
  const lane = nodes.find(node => node.id === 'lane-review-server-1')!
  assert.deepEqual([lane.status, lane.tone, lane.projected], ['succeeded', 'fail', 'lane_review'])
  assert.deepEqual([nodes.find(node => node.id === 'panel')!.projected, nodes.find(node => node.id === 'review')!.projected], ['panel', null])
  assert.deepEqual([nodes.find(node => node.id === 'panel')!.word, nodes.find(node => node.id === 'panel')!.openFindings], ['reviewed', 1])
  // Before the sessions load, a projected card keeps its served status and tone.
  const bare = stageNodes({ detail, rows: [], timeline: null, events: [], inputs: null, review: null, attention: null, reviewRound: null, sessions: null }, formatSpan)
  assert.deepEqual([bare.find(node => node.id === 'reviewer-general')!.word, bare.find(node => node.id === 'reviewer-general')!.tone], ['succeeded', 'ok'])
})

test('stageExecutor: each projected kind names its own executor; pinned steps keep the kind\'s wording ([L2])', () => {
  assert.deepEqual(stageExecutor({ projected: 'reviewer', exec: 'agent', kind: 'review', id: 'reviewer-general' }), { word: 'reviewer', phrase: 'one reviewer' })
  assert.deepEqual(stageExecutor({ projected: 'panel', exec: 'agent', kind: 'review', id: 'panel' }), { word: 'panel', phrase: 'a multi-provider panel' })
  assert.deepEqual(stageExecutor({ projected: 'lane_review', exec: 'agent', kind: 'review', id: 'lane-review-server-1' }), { word: 'lane reviewer', phrase: 'one lane reviewer' })
  const review = stageExecutor({ projected: null, exec: 'agent', kind: 'review', id: 'review' })
  assert.equal(review.word, 'agent')
  assert.notEqual(review.phrase, 'one reviewer')
})

test('groupSessions and totalsText: every role group in PRD order, start order within a group, both totals by value', () => {
  const groups = groupSessions(PAYLOAD)
  assert.deepEqual(groups.map(group => group.label), ['Design challenge attempts', 'Workers', 'Repairs', 'Lane reviewers', 'Reviewers', 'Critique', 'Panel providers', 'Night-shift providers'])
  for (const group of groups) {
    const starts = group.rows.map(row => row.started_at ?? row.ended_at).filter((value): value is string => value !== null)
    assert.deepEqual(starts, [...starts].sort(), group.label)
  }
  const { metered_usd, covered_usd, not_recorded } = PAYLOAD.totals
  assert.equal(totalsText(PAYLOAD.totals), `Metered $${metered_usd.toFixed(2)} reported by Claude · subscription-covered estimates $${covered_usd.toFixed(2)} · ${not_recorded} costs not recorded`)
  assert.equal(totalsText({ metered_usd: 1, covered_usd: 0, not_recorded: 1 }), 'Metered $1.00 reported by Claude · subscription-covered estimates $0.00 · 1 cost not recorded')
  assert.equal(spentText(PAYLOAD.totals), `$${metered_usd.toFixed(2)} reported by Claude · $${covered_usd.toFixed(2)} covered`)
  assert.equal(spentText({ metered_usd: 0, covered_usd: 0, not_recorded: 3 }), null)
})

test('costText, aggregateCostText and durationText: metered and covered kept apart, spans as the app writes them', () => {
  assert.equal(costText(4.2, 'metered'), '$4.20 reported by Claude')
  assert.equal(costText(0.2, 'covered'), '$0.20 covered')
  assert.equal(costText(null, null), 'cost not recorded')
  assert.equal(aggregateCostText([{ cost_usd: 1, cost_kind: 'metered' }, { cost_usd: 0.25, cost_kind: 'covered' }, { cost_usd: null, cost_kind: null }]), '$1.00 reported by Claude · $0.25 covered')
  assert.equal(aggregateCostText([{ cost_usd: null, cost_kind: null }]), 'cost not recorded')
  assert.equal(durationText(3600), formatSpan(3600000))
  assert.equal(durationText(null), null)
})

test('resumeText: the ~/ form copies whole with no note; the bare form says to run it in the session\'s worktree; pi rows have none', () => {
  const worker = PAYLOAD.sessions.find(row => row.key === 'worker:server')!
  assert.deepEqual(resumeText(worker), { command: `cd ~/'runs/ux-sessions/sessions-run/worktree-server' && claude --resume ${worker.session_id}`, note: null })
  const bare = BARE.sessions.find(row => row.key === 'worker:server')!
  assert.deepEqual(resumeText(bare), { command: `claude --resume ${bare.session_id}`, note: RESUME_NOTE })
  assert.equal(RESUME_NOTE, "run it in the session's worktree")
  const pi = PAYLOAD.sessions.find(row => row.transport === 'pi')!
  assert.equal(resumeText(pi), null)
})

test('reviewerRoundsOf and sessionsForNode: the latest round first, then the earlier rounds; a challenge has one block per attempt', () => {
  assert.deepEqual(reviewerRoundsOf(PAYLOAD, 'reviewer-general').map(row => [row.round, row.verdict]), [[2, 'blocked'], [1, 'blocked']])
  assert.deepEqual(sessionsForNode(PAYLOAD, 'challenge').map(row => row.label), ['Design challenge attempt 2', 'Design challenge attempt 1'])
  assert.ok(sessionsForNode(PAYLOAD, 'challenge').every((row: SessionRow) => row.role !== 'night_shift'))
})

test('the night-shift block\'s wording: executed and held, each provider, Jev picked, Jev error and Jev not called', () => {
  const [executed, held] = PAYLOAD.night_shift as [NightShiftDecision, NightShiftDecision]
  assert.equal(outcomeText(executed), 'Executed')
  assert.equal(outcomeText(held), 'Held: one provider; needs the operator')
  assert.equal(providerText(held.providers[0]!), 'hold · confidence high · needs the operator')
  assert.equal(providerText(executed.providers[0]!), 'accept-challenge · confidence medium')
  assert.equal(jevText(executed.jev), 'Jev picked claude · confidence 0.82 · passed the floor')
  assert.equal(jevText(held.jev), 'Jev not called (one provider)')
  assert.equal(jevText({ error: 'not called (agree)' }), 'Jev not called (agree)')
  assert.equal(jevText({ error: 'jev timed out' }), 'Jev error: jev timed out')
  assert.equal(jevText(null), 'Jev not called')
  assert.equal(jevText({ pick: 'gpt', confidence: null, pass_floor: false }), 'Jev picked gpt · confidence not recorded · below the floor')
  assert.equal(nightShiftCountText(PAYLOAD), '2 panel decisions: 1 executed, 1 held')
  assert.equal(nightShiftCountText({ ...PAYLOAD, night_shift: [] }), null)
  assert.deepEqual(nightShiftNodes(PAYLOAD).map(entry => [entry.nodeId, entry.decisions.length]), [['challenge', 1], ['approval', 1]])
  assert.deepEqual(decisionsForNode(PAYLOAD, 'approval').map(decision => decision.decision), ['held'])
})

test('sessionsCueText: the cue counts the listed sessions and carries the dock\'s Spent text, or says the cost is not recorded', () => {
  const count = groupSessions(PAYLOAD).reduce((sum, group) => sum + group.rows.length, 0)
  assert.equal(sessionsCueText(PAYLOAD), `Sessions · ${count} · ${spentText(PAYLOAD.totals)} ↓`)
  assert.match(sessionsCueText(PAYLOAD)!, /reported by Claude · \$[\d.]+ covered ↓$/)
  assert.equal(sessionsCueText({ ...PAYLOAD, totals: { metered_usd: 0, covered_usd: 0, not_recorded: count } }), `Sessions · ${count} · cost not recorded ↓`)
  assert.equal(sessionsCueText({ ...PAYLOAD, sessions: [] }), null)
})
