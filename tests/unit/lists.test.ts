/**
 * The run lists' pure rules (docs/PRD_VIEWER_UX.md 4.1, 6.3, 6.4; slice S6): the workflow title rule, the Runs home
 * sections and the 7-day Recent window, row wording with and without the served `activity`, the controller suffix and its
 * 15 s debounce, and when the Now banner reads the served activity over the export.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveNow, type ControllerReading, type Now } from '../../contracts/projects/triage.ts'
import { validateRunDetail, type RunActivity, type RunDetail, type RunSummary } from '../../contracts/projects/v1.ts'
import {
  controllerSuffix, homeSections, latestFeature, latestRun, projectFacts, readsNextPage, recordReading, RECENT_WINDOW_MS, rowSummary, rowTime,
  servedDisagreement, servedNow, workflowTitle, type ServedRun,
} from '../../src/projects/lists.ts'
import { definition, laneGraphNodes, runDetail, type NodeState } from '../project-workflows/fixtures.ts'

const NOW = Date.parse('2026-03-20T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const iso = (time: number) => new Date(time).toISOString().replace(/\.000Z$/, 'Z')
const NODES = laneGraphNodes(['ui', 'adapter'])
const DEFINITION = definition('alpha-project', 'ux-lists', 'Feature implementation', NODES)
const LABELS = new Map(NODES.map(node => [node.node_id, node.label]))

const activity = (fields: Partial<RunActivity> = {}): RunActivity => ({
  feature: 'Runs home lists', last_activity_at: null, finished_at: null, focus: null, attention: null, waiting_questions: 0, headline: null, controller: null, ...fields,
})

function summary(runId: string, status: RunSummary['status'], fields: { created?: string; updated?: string; activity?: RunActivity | null } = {}): RunSummary {
  const base: RunSummary = {
    contract_version: '1.0.0', project_id: 'alpha-project', workflow_id: 'ux-lists', definition_revision: DEFINITION.definition_revision, run_id: runId, status,
    created_at: fields.created ?? '2026-03-19T09:00:00Z', updated_at: fields.updated ?? fields.created ?? '2026-03-19T09:00:00Z',
  }
  return fields.activity ? { ...base, contract_version: '1.5.0', activity: fields.activity } : base
}

/** A running two-lane run, as the server serves it with contract 1.5.0. */
function runningDetail(runActivity: RunActivity, states: Record<string, NodeState> = { launch_ui: { status: 'running', attempt: 1 }, launch_adapter: { status: 'running', attempt: 1 } }): RunDetail {
  const base = runDetail('lists-live', 'running', DEFINITION, '2026-03-20T11:00:00Z', '2026-03-20T11:30:00Z', states, 4)
  return validateRunDetail({ ...base, summary: { ...base.summary, contract_version: '1.5.0', activity: runActivity }, run_dir: null })
}

const served = (detail: RunDetail, controller: ControllerReading[] = []): ServedRun => ({ detail, activity: detail.summary.activity ?? null, runDir: null, controller })
const reading = (seconds: number, value: ControllerReading['value']): ControllerReading => ({ at: iso(NOW + seconds * 1000), value })

describe('the workflow title rule', () => {
  test('a workflow with its own name keeps it, whatever feature its runs name', () => {
    assert.equal(workflowTitle({ workflow_id: 'feature-flow', name: 'Feature flow' }, 'Review visibility'), 'Feature flow')
    assert.equal(workflowTitle({ workflow_id: 'feature-flow', name: 'Feature flow' }), 'Feature flow')
  })
  test('the generic exporter name gives the latest run\'s feature', () => {
    assert.equal(workflowTitle({ workflow_id: 'duel-core', name: 'Feature implementation' }, 'Pirate Sea Race duel core'), 'Pirate Sea Race duel core')
  })
  test('the generic name without a served feature gives the workflow id', () => {
    assert.equal(workflowTitle({ workflow_id: 'duel-core', name: 'Feature implementation' }, null), 'duel-core')
    assert.equal(workflowTitle({ workflow_id: 'duel-core', name: 'Feature implementation' }), 'duel-core')
  })
  test('the latest run is the one updated last, and a run without activity names no feature', () => {
    const older = summary('a', 'failed', { updated: '2026-03-18T10:00:00Z', activity: activity({ feature: 'Old feature', finished_at: '2026-03-18T10:00:00Z' }) })
    const newer = summary('b', 'running', { updated: '2026-03-19T10:00:00Z', activity: activity({ feature: 'New feature' }) })
    assert.equal(latestRun([older, newer])?.run_id, 'b')
    assert.equal(latestFeature([older, newer]), 'New feature')
    assert.equal(latestFeature([summary('c', 'running', { updated: '2026-03-20T10:00:00Z' }), older]), null)
    assert.equal(latestFeature([]), null)
  })
})

describe('Runs home sections', () => {
  const row = (run: RunSummary) => ({ run })
  const waiting = (kind: 'question' | 'pane' | 'approval', since: string) => activity({
    attention: { kind, node_id: kind === 'approval' ? 'handoff' : 'launch_ui', since }, waiting_questions: kind === 'question' ? 1 : 0,
  })
  const rows = [
    row(summary('asking', 'running', { activity: waiting('question', '2026-03-20T11:20:00Z') })),
    row(summary('pane', 'running', { activity: waiting('pane', '2026-03-20T11:10:00Z') })),
    row(summary('approval', 'awaiting_approval', { activity: waiting('approval', '2026-03-20T10:00:00Z') })),
    row(summary('live', 'running', { activity: activity({ last_activity_at: '2026-03-20T11:40:00Z' }) })),
    row(summary('interrupted', 'paused', { activity: activity({ attention: { kind: 'interrupted', node_id: 'review', since: null }, last_activity_at: '2026-03-20T09:00:00Z' }) })),
    row(summary('failed-now', 'failed', { activity: activity({ finished_at: '2026-03-19T09:52:51Z', attention: { kind: 'failed', node_id: 'verify_ui', since: null } }) })),
    row(summary('failed-earlier', 'failed', { activity: activity({ finished_at: '2026-03-17T10:00:00Z' }) })),
    row(summary('too-old', 'succeeded', { activity: activity({ finished_at: iso(NOW - RECENT_WINDOW_MS - 1000) }) })),
    row(summary('legacy-recent', 'succeeded', { updated: iso(NOW - DAY) })),
    row(summary('legacy-old', 'succeeded', { updated: iso(NOW - 8 * DAY) })),
    row(summary('legacy-running', 'running', { updated: iso(NOW - 30 * DAY) })),
  ]
  const sections = homeSections(rows, NOW)
  const ids = (list: { run: RunSummary }[]) => list.map(item => item.run.run_id)

  test('Needs you holds the questions, panes and approvals, longest waiting first', () => {
    assert.deepEqual(ids(sections.needsYou), ['approval', 'pane', 'asking'])
  })
  test('Running holds every other run that is not finished, including one without activity, latest activity first', () => {
    assert.deepEqual(ids(sections.running), ['live', 'interrupted', 'legacy-running'])
  })
  test('Recent holds finished runs of the last seven days, newest first; an older run is absent, and no run appears twice', () => {
    assert.deepEqual(ids(sections.recent), ['legacy-recent', 'failed-now', 'failed-earlier'])
    const all = [...ids(sections.needsYou), ...ids(sections.running), ...ids(sections.recent)]
    assert.equal(new Set(all).size, all.length)
    assert.ok(!all.includes('too-old') && !all.includes('legacy-old'))
  })
  test('a run without activity is never grouped as needing you, whatever its status', () => {
    const plain = homeSections([row(summary('plain', 'awaiting_approval'))], NOW)
    assert.deepEqual(ids(plain.needsYou), [])
    assert.deepEqual(ids(plain.running), ['plain'])
  })
  test('the next page of a workflow is read only while its last run is inside the window', () => {
    const cutoff = NOW - RECENT_WINDOW_MS
    assert.equal(readsNextPage([{ updated_at: iso(NOW) }, { updated_at: iso(cutoff + 1000) }], 'next', cutoff), true)
    assert.equal(readsNextPage([{ updated_at: iso(NOW) }, { updated_at: iso(cutoff - 1000) }], 'next', cutoff), false)
    assert.equal(readsNextPage([{ updated_at: iso(NOW) }], null, cutoff), false)
    assert.equal(readsNextPage([], 'next', cutoff), false)
  })
})

describe('row wording', () => {
  test('a row without activity says only its status and when it was updated: no finish, no duration', () => {
    const run = summary('legacy', 'failed', { created: '2026-03-19T09:00:00Z', updated: '2026-03-19T09:36:07Z' })
    assert.equal(rowSummary(run), 'Failed')
    assert.deepEqual(rowTime(run, NOW), { kind: 'updated', at: '2026-03-19T09:36:07Z' })
  })
  test('a finished run shows its served finish and the duration from its creation', () => {
    const run = summary('failed', 'failed', { created: '2026-03-19T09:00:00Z', updated: '2026-03-19T09:56:00Z', activity: activity({ finished_at: '2026-03-19T09:52:51Z' }) })
    assert.deepEqual(rowTime(run, NOW), { kind: 'finished', at: '2026-03-19T09:52:51Z', ms: (52 * 60 + 51) * 1000 })
  })
  test('a live run shows its start, its last activity and the time elapsed since it started', () => {
    const run = summary('live', 'running', { created: '2026-03-20T11:00:00Z', activity: activity({ last_activity_at: '2026-03-20T11:40:00Z' }) })
    assert.deepEqual(rowTime(run, NOW), { kind: 'live', started: '2026-03-20T11:00:00Z', last: '2026-03-20T11:40:00Z', ms: 60 * 60 * 1000 })
  })
  test('a finished run without a served finish claims none', () => {
    assert.deepEqual(rowTime(summary('odd', 'cancelled', { updated: '2026-03-19T10:00:00Z', activity: activity() }), NOW), { kind: 'updated', at: '2026-03-19T10:00:00Z' })
  })
  test('a waiting row says what waits on the operator', () => {
    const question = summary('q', 'running', { activity: activity({ attention: { kind: 'question', node_id: 'launch_ui', since: null }, waiting_questions: 1 }) })
    const pane = summary('p', 'running', { activity: activity({ attention: { kind: 'pane', node_id: 'launch_adapter', since: null } }) })
    const reviewer = summary('r', 'running', { activity: activity({ attention: { kind: 'pane', node_id: 'review', since: null } }) })
    const approval = summary('a', 'awaiting_approval', { activity: activity({ attention: { kind: 'approval', node_id: 'handoff', since: null } }) })
    assert.equal(rowSummary(question, LABELS), 'ui asked a question · deadline paused')
    assert.equal(rowSummary(pane, LABELS), 'adapter needs attention in its pane')
    assert.equal(rowSummary(reviewer, LABELS), 'review needs attention in its pane')
    assert.equal(rowSummary(approval, LABELS), 'Freeze worker handoffs awaits your decision')
  })
  test('a stopped row names its status at the focus step with the served headline', () => {
    const focus = { node_id: 'verify_ui', label: 'Verify ui', status: 'failed' as const, since: null }
    const failed = summary('f', 'failed', { activity: activity({ finished_at: '2026-03-19T09:52:51Z', focus, headline: 'Verify ui · Injected gate failure' }) })
    const bare = summary('b', 'failed', { activity: activity({ finished_at: '2026-03-19T09:52:51Z', focus, headline: null }) })
    const other = summary('o', 'paused', { activity: activity({ focus: { ...focus, status: 'paused' }, headline: 'Controller stopped' }) })
    assert.equal(rowSummary(failed), 'Failed at Verify ui · Injected gate failure')
    assert.equal(rowSummary(bare), 'Failed at Verify ui')
    assert.equal(rowSummary(other), 'Paused at Verify ui · Controller stopped')
  })
  test('a running or succeeded row names its status and headline', () => {
    assert.equal(rowSummary(summary('s', 'succeeded', { activity: activity({ finished_at: '2026-03-19T10:00:00Z', headline: 'Integrate candidate · Fast-forwarded the feature branch' }) })),
      'Succeeded · Integrate candidate · Fast-forwarded the feature branch')
    assert.equal(rowSummary(summary('r', 'running', { activity: activity() })), 'Running')
  })
  test('a project card counts its features and names its latest run\'s last activity', () => {
    const runs = [summary('a', 'failed', { updated: '2026-03-18T10:00:00Z' }), summary('b', 'running', { updated: '2026-03-18T09:00:00Z', activity: activity({ last_activity_at: '2026-03-19T11:00:00Z' }) })]
    assert.deepEqual(projectFacts(3, runs), { features: '3 features', lastRun: '2026-03-19T11:00:00Z' })
    assert.deepEqual(projectFacts(1, []), { features: '1 feature', lastRun: null })
  })
})

describe('the controller suffix (6.3)', () => {
  test('running is shown from the first reading', () => {
    assert.equal(controllerSuffix('running', [reading(0, 'running')]), 'running')
    assert.equal(controllerSuffix('paused', [reading(0, 'running')]), 'running')
  })
  test('not_running is shown only once it has held for 15 s', () => {
    let readings: ControllerReading[] = []
    readings = recordReading(readings, reading(0, 'not_running'))
    assert.equal(controllerSuffix('running', readings), null, 'one reading can be a checkpoint hand-over')
    readings = recordReading(readings, reading(5, 'not_running'))
    readings = recordReading(readings, reading(10, 'not_running'))
    assert.equal(controllerSuffix('running', readings), null, '10 s is not enough')
    readings = recordReading(readings, reading(14.999, 'not_running'))
    assert.equal(controllerSuffix('running', readings), null, 'just under 15 s is not enough')
    readings = recordReading(readings, reading(15, 'not_running'))
    assert.equal(controllerSuffix('running', readings), 'not_running')
  })
  test('a running reading in between starts the 15 s again', () => {
    const readings = [reading(0, 'not_running'), reading(10, 'running'), reading(20, 'not_running'), reading(30, 'not_running')]
    assert.equal(controllerSuffix('running', readings), null)
    assert.equal(controllerSuffix('running', [...readings, reading(35, 'not_running')]), 'not_running')
  })
  test('unknown, null and no reading show nothing; a finished or waiting run shows nothing', () => {
    assert.equal(controllerSuffix('running', []), null)
    assert.equal(controllerSuffix('running', [reading(0, 'unknown'), reading(30, 'unknown')]), null)
    assert.equal(controllerSuffix('running', [reading(0, null), reading(30, null)]), null)
    assert.equal(controllerSuffix('failed', [reading(0, 'running')]), null)
    assert.equal(controllerSuffix('awaiting_approval', [reading(0, 'not_running'), reading(30, 'not_running')]), null)
  })
  test('readings stay bounded and an out-of-order reading starts over', () => {
    let readings: ControllerReading[] = []
    for (let second = 0; second < 200; second += 1) readings = recordReading(readings, reading(second, 'not_running'))
    assert.ok(readings.length <= 50)
    assert.equal(controllerSuffix('running', readings), 'not_running')
    assert.deepEqual(recordReading(readings, reading(-10, 'running')), [reading(-10, 'running')])
  })
})

describe('the Now banner reads the served activity', () => {
  const nowOf = (detail: RunDetail, extra: Partial<Parameters<typeof deriveNow>[0]> = {}): Now => deriveNow({ detail, events: [], inputs: null, ...extra })
  const QUESTION = activity({ attention: { kind: 'question', node_id: 'launch_ui', since: '2026-03-20T11:20:00Z' }, waiting_questions: 1 })
  const PANE = activity({ attention: { kind: 'pane', node_id: 'launch_adapter', since: '2026-03-20T11:10:00Z' } })

  test('it keeps the export\'s Now when both agree', () => {
    const detail = runningDetail(activity())
    const now = nowOf(detail)
    assert.equal(now.situation, 'running')
    assert.equal(servedDisagreement(now, served(detail)), null)
    assert.equal(servedNow(now, served(detail)), now)
    assert.equal(servedNow(now, null), now)
  })
  test('a question only the live record holds is shown as waiting', () => {
    const detail = runningDetail(QUESTION)
    const exported = nowOf(detail)
    assert.equal(servedDisagreement(exported, served(detail)), 'question-asked')
    const now = servedNow(exported, served(detail))
    assert.equal(now.situation, 'question')
    assert.equal(now.lane, 'ui')
  })
  test('a question the live record answered is no longer shown as waiting; the served pane is', () => {
    const detail = runningDetail(PANE)
    // The export's view: ui's question 1 still waits.
    const exported = { ...nowOf(detail), situation: 'question' as const, lane: 'ui' }
    assert.equal(servedDisagreement(exported, served(detail)), 'question-answered')
    const now = servedNow(exported, served(detail))
    assert.equal(now.situation, 'pane_attention')
    assert.match(now.headline.join(''), /adapter needs attention in its pane/)
  })
  test('a controller read not running for 15 s interrupts a running run (rule 5 case c), and not before', () => {
    const detail = runningDetail(activity({ controller: 'not_running' }))
    const exported = nowOf(detail)
    const early = [reading(0, 'not_running'), reading(10, 'not_running')]
    assert.equal(servedDisagreement(exported, served(detail, early)), null)
    const held = [...early, reading(20, 'not_running')]
    assert.equal(servedDisagreement(exported, served(detail, held)), 'controller-stopped')
    const now = servedNow(exported, served(detail, held))
    assert.equal(now.situation, 'interrupted')
    assert.equal(now.interruption, 'c')
  })
  test('a stopped controller never hides a waiting question', () => {
    const detail = runningDetail({ ...QUESTION, controller: 'not_running' })
    const held = [reading(0, 'not_running'), reading(20, 'not_running')]
    const now = servedNow(nowOf(detail, { activity: detail.summary.activity }), served(detail, held))
    assert.equal(now.situation, 'question')
  })
})
