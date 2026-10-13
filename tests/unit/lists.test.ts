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
  controllerSuffix, dayKey, cardElapsed, dayLabel, filterRecent, firstRows, groupByDay, groupByProject, homeSections, laneNamesOf, latestFeature, latestRun,
  NEXT_STEP, PREFIX_GROUP_MIN, projectFacts, projectPrefix, projectTone, railEntries, readsNextPage, RECENT_FILTERS, RECENT_SHOWN, recentCounts,
  recordHomeReadings, recordReading, RECENT_WINDOW_MS, reviewStepsOf, rowSummary, rowTime, searchRows, servedDisagreement, servedNow, sincePausedLabel, stepTally, waitingKind, workflowTitle, type ServedRun,
  classifyRuns, classOf, rowLook, stoppedLabel, type RunClass,
} from '../../src/projects/lists.ts'
import { createPinStore, PINS_KEY, PINS_MAX, type PinStorage } from '../../src/projects/pins.ts'
import { projectRunInfo } from '../../src/projects/dispatch/projectModel.ts'
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

function summary(runId: string, status: RunSummary['status'], fields: { created?: string; updated?: string; activity?: RunActivity | null; workflow?: string; project?: string } = {}): RunSummary {
  const base: RunSummary = {
    contract_version: '1.0.0', project_id: fields.project ?? 'alpha-project', workflow_id: fields.workflow ?? 'ux-lists', definition_revision: DEFINITION.definition_revision, run_id: runId, status,
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
  test('Today holds every run that moved today and waits on nobody, running first, then latest activity first', () => {
    // `interrupted` is paused and a later run of its workflow exists (every run here shares created_at; the tie goes to the
    // greater run id, `too-old`): it is superseded, folded apart, never in Today.
    assert.deepEqual(ids(sections.today), ['live'])
    assert.deepEqual(ids(sections.superseded), ['interrupted'])
    assert.equal(sections.classes.get('alpha-project\u0000ux-lists\u0000interrupted')?.supersededBy, 'too-old')
    // A run finished today is Today's, not Recent's; a run that moved today in UTC but yesterday in a zone west of it follows the zone.
    const done = summary('done-today', 'succeeded', { activity: activity({ finished_at: '2026-03-20T00:30:00Z' }) })
    assert.deepEqual(ids(homeSections([row(done)], NOW).today), ['done-today'])
    const west = homeSections([row(done)], NOW, 'local')
    const sameDay = new Date(NOW).getDate() === new Date('2026-03-20T00:30:00Z').getDate()
    assert.deepEqual(ids(west.today), sameDay ? ['done-today'] : [])
    assert.deepEqual(ids(west.recent), sameDay ? [] : ['done-today'])
  })
  test('Running holds the unfinished runs since an earlier day that are not paused and wait on nobody, latest activity first', () => {
    assert.deepEqual(ids(sections.running), ['legacy-running'])
  })
  test('Paused holds the paused runs since an earlier day that wait on nobody, oldest first (longest stopped at the top)', () => {
    assert.deepEqual(ids(sections.paused), [])
    // Two paused runs: the one stopped longer ago leads; a since-less paused run orders by its last activity.
    // Each in its own workflow, so each is the latest of its workflow and none is superseded.
    const older = summary('paused-older', 'paused', { workflow: 'w-older', activity: activity({ attention: { kind: 'paused', node_id: 'handoff', since: '2026-03-18T08:00:00Z' } }) })
    const newer = summary('paused-newer', 'paused', { workflow: 'w-newer', activity: activity({ attention: { kind: 'paused', node_id: 'handoff', since: '2026-03-20T08:00:00Z' } }) })
    const sinceless = summary('paused-sinceless', 'paused', { workflow: 'w-sinceless', activity: activity({ attention: { kind: 'paused', node_id: null, since: null }, last_activity_at: '2026-03-19T08:00:00Z' }) })
    assert.deepEqual(ids(homeSections([row(newer), row(older), row(sinceless)], NOW).paused), ['paused-older', 'paused-sinceless', 'paused-newer'])
  })
  test('Recent holds finished runs of the last seven days before today, newest first; an older run is absent, and no run appears twice', () => {
    assert.deepEqual(ids(sections.recent), ['legacy-recent', 'failed-now', 'failed-earlier'])
    const all = [...ids(sections.needsYou), ...ids(sections.today), ...ids(sections.running), ...ids(sections.paused), ...ids(sections.superseded), ...ids(sections.recent)]
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

// ---- Viewer revamp (docs/PRD_VIEWER_REVAMP.md 5.1): search, filters, day groups, the rail ---------------------------------

describe('Recent search', () => {
  const failed = summary('desk-fail-1', 'failed', { activity: activity({ feature: 'Operator desk', finished_at: '2026-03-19T10:00:00Z', headline: 'Verify ui · Injected gate failure' }) })
  const ok = summary('desk-ok-1', 'succeeded', { activity: activity({ feature: 'Operator desk', finished_at: '2026-03-19T11:00:00Z', headline: 'Integrate candidate · fast-forwarded' }) })
  const other = summary('lists-failed', 'failed', { activity: activity({ finished_at: '2026-03-19T09:00:00Z', headline: 'Verify adapter · exit 1' }) })
  const project = { project_id: 'alpha-project', name: 'Alpha project' }
  const rows = [
    { run: failed, title: 'Revamp desk', project },
    { run: ok, title: 'Revamp desk', project },
    { run: other, title: 'Runs home lists', project: { project_id: 'beta', name: 'Beta' } },
  ]
  const ids = (list: readonly { run: RunSummary }[]) => list.map(row => row.run.run_id)
  test('an empty or blank query keeps every row in order', () => {
    assert.deepEqual(ids(searchRows(rows, '')), ['desk-fail-1', 'desk-ok-1', 'lists-failed'])
    assert.deepEqual(ids(searchRows(rows, '   ')), ['desk-fail-1', 'desk-ok-1', 'lists-failed'])
  })
  test('matches the run id, the feature title and the outcome, case-insensitively', () => {
    assert.deepEqual(ids(searchRows(rows, 'DESK-FAIL-1')), ['desk-fail-1'])
    assert.deepEqual(ids(searchRows(rows, 'revamp desk')), ['desk-fail-1', 'desk-ok-1'])
    assert.deepEqual(ids(searchRows(rows, 'operator')), ['desk-fail-1', 'desk-ok-1'])
    assert.deepEqual(ids(searchRows(rows, 'gate failure')), ['desk-fail-1'])
    assert.deepEqual(ids(searchRows(rows, 'FAILED')), ['desk-fail-1', 'lists-failed'])
    assert.deepEqual(ids(searchRows(rows, 'beta')), ['lists-failed'])
  })
  test('every word must match; an unmatched query leaves nothing', () => {
    assert.deepEqual(ids(searchRows(rows, 'desk exit')), [])
    assert.deepEqual(ids(searchRows(rows, 'nothing-like-this')), [])
  })
})

describe('Recent filters and day groups', () => {
  const NOW_MARCH_12 = Date.parse('2026-03-12T20:00:00Z')
  const finished = (runId: string, status: RunSummary['status'], at: string) =>
    ({ run: summary(runId, status, { created: at, activity: activity({ finished_at: at }) }), title: 't', project: { project_id: 'p', name: 'P' } })
  const legacy = { run: summary('legacy', 'succeeded', { updated: '2026-03-11T08:00:00Z' }), title: 't', project: { project_id: 'q', name: 'Q' } }
  const rows = [
    finished('f-today', 'failed', '2026-03-12T19:00:00Z'),
    finished('s-today', 'succeeded', '2026-03-12T01:00:00Z'),
    finished('s-yesterday', 'succeeded', '2026-03-11T23:59:59Z'),
    legacy,
    finished('f-older', 'failed', '2026-03-10T12:00:00Z'),
    finished('c-older', 'cancelled', '2026-03-10T11:00:00Z'),
  ]
  const ids = (list: readonly { run: RunSummary }[]) => list.map(row => row.run.run_id)
  test('All keeps every row; Failed and Succeeded keep their status; Today keeps what ended today', () => {
    assert.deepEqual(ids(filterRecent(rows, 'all', NOW_MARCH_12, 'utc')), ids(rows))
    assert.deepEqual(ids(filterRecent(rows, 'failed', NOW_MARCH_12, 'utc')), ['f-today', 'f-older'])
    assert.deepEqual(ids(filterRecent(rows, 'succeeded', NOW_MARCH_12, 'utc')), ['s-today', 's-yesterday', 'legacy'])
    assert.deepEqual(ids(filterRecent(rows, 'today', NOW_MARCH_12, 'utc')), ['f-today', 's-today'])
    assert.deepEqual(recentCounts(rows, NOW_MARCH_12, 'utc'), { all: 6, failed: 2, succeeded: 3, today: 2 })
    assert.deepEqual([...RECENT_FILTERS], ['all', 'failed', 'succeeded', 'today'])
  })
  test('the filter counts are over the searched set, so a button names the rows that filter keeps (P2 1)', () => {
    // Searching the run id "f-" narrows to the two failed runs; the counts are then over that set, not every row.
    assert.deepEqual(recentCounts(searchRows(rows, 'f-'), NOW_MARCH_12, 'utc'), { all: 2, failed: 2, succeeded: 0, today: 1 })
    assert.deepEqual(recentCounts(searchRows(rows, 'nothing-matches'), NOW_MARCH_12, 'utc'), { all: 0, failed: 0, succeeded: 0, today: 0 })
  })
  test('a day key is the calendar day in the chosen zone', () => {
    assert.equal(dayKey('2026-03-12T01:00:00Z', 'utc'), '2026-03-12')
    assert.equal(dayKey('2026-03-11T23:59:59Z', 'utc'), '2026-03-11')
    assert.match(dayKey('2026-03-11T23:59:59Z', 'local'), /^2026-03-1[12]$/)
  })
  test('rows are grouped under Today, Yesterday and then the date, in the order given (newest first)', () => {
    const groups = groupByDay(rows, NOW_MARCH_12, 'utc')
    assert.deepEqual(groups.map(group => group.label), ['Today', 'Yesterday', 'Mar 10'])
    assert.deepEqual(groups.map(group => ids(group.rows)), [['f-today', 's-today'], ['s-yesterday', 'legacy'], ['f-older', 'c-older']])
    assert.deepEqual(groups.map(group => group.key), ['2026-03-12', '2026-03-11', '2026-03-10'])
  })
  test('a day in another year names its year; a day after today is named by its date', () => {
    assert.equal(dayLabel('2025-12-31', NOW_MARCH_12, 'utc'), 'Dec 31 2025')
    assert.equal(dayLabel('2026-03-19', NOW_MARCH_12, 'utc'), 'Mar 19')
    assert.equal(dayLabel('2026-03-12', NOW_MARCH_12, 'utc'), 'Today')
    assert.equal(dayLabel('2026-03-11', NOW_MARCH_12, 'utc'), 'Yesterday')
  })
  test('Group by project groups by project in first-seen order', () => {
    const groups = groupByProject(rows)
    assert.deepEqual(groups.map(group => group.label), ['P', 'Q'])
    assert.deepEqual(groups.map(group => group.rows.length), [5, 1])
  })
  test('the first rows across groups are shown; the rest are counted behind Show older', () => {
    const groups = groupByDay(rows, NOW_MARCH_12, 'utc')
    const shown = firstRows(groups, 3)
    assert.deepEqual(shown.groups.map(group => ids(group.rows)), [['f-today', 's-today'], ['s-yesterday']])
    assert.equal(shown.hidden, 3)
    const all = firstRows(groups, RECENT_SHOWN)
    assert.equal(all.hidden, 0)
    assert.deepEqual(all.groups.map(group => ids(group.rows)), groups.map(group => ids(group.rows)))
    assert.equal(RECENT_SHOWN, 10)
    assert.deepEqual(firstRows(groups, 0), { groups: [], hidden: 6 })
  })
})

describe('the project rail', () => {
  const project = (project_id: string) => ({ project_id, name: project_id })
  const shape = (entries: ReturnType<typeof railEntries<{ project_id: string; name: string }>>) =>
    entries.map(entry => (entry.kind === 'project' ? entry.project.project_id : `${entry.prefix}(${entry.projects.map(item => item.project_id).join(',')})`))
  test('three or more siblings sharing the prefix before the last segment fold into one group, at the first one\'s place', () => {
    const projects = ['alpha-project', 'project-B-1', 'empty-project', 'project-B-2', 'project-B-3'].map(project)
    assert.deepEqual(shape(railEntries(projects)), ['alpha-project', 'project-B(project-B-1,project-B-2,project-B-3)', 'empty-project'])
    assert.equal(PREFIX_GROUP_MIN, 3)
  })
  test('two siblings stay flat; an id without a dash has no prefix', () => {
    assert.deepEqual(shape(railEntries(['game-1', 'game-2', 'solo', 'other'].map(project))), ['game-1', 'game-2', 'solo', 'other'])
    assert.equal(projectPrefix('solo'), null)
    assert.equal(projectPrefix('project-B-27'), 'project-B')
    assert.equal(projectPrefix('-x'), null)
  })
  test('the threshold is a parameter', () => {
    assert.deepEqual(shape(railEntries(['game-1', 'game-2'].map(project), 2)), ['game(game-1,game-2)'])
  })
  test('a project\'s dot: needs you, then failed (its latest finished run), then running, else idle', () => {
    const waiting = summary('w', 'running', { activity: activity({ attention: { kind: 'pane', node_id: 'launch_ui', since: null } }) })
    const live = summary('l', 'running', { activity: activity() })
    const failedLast = summary('f', 'failed', { activity: activity({ finished_at: '2026-03-19T10:00:00Z' }) })
    const okBefore = summary('o', 'succeeded', { activity: activity({ finished_at: '2026-03-18T10:00:00Z' }) })
    const okLast = summary('o2', 'succeeded', { activity: activity({ finished_at: '2026-03-20T10:00:00Z' }) })
    assert.equal(projectTone([live, failedLast, waiting]), 'warn')
    assert.equal(projectTone([live, okBefore, failedLast]), 'fail')
    assert.equal(projectTone([live, failedLast, okLast]), 'run')
    assert.equal(projectTone([okBefore, okLast]), 'ok')
    assert.equal(projectTone([]), 'idle')
    // A paused run is stopped, not running: its project's dot says Paused.
    const paused = summary('p', 'paused', { activity: activity() })
    assert.equal(projectTone([paused]), 'pause')
    assert.equal(projectTone([paused, okBefore]), 'pause')
    assert.equal(projectTone([paused, live]), 'run')
    assert.equal(projectTone([paused, failedLast]), 'fail')
    assert.equal(projectTone([summary('a', 'awaiting_approval', { activity: activity() }), live]), 'warn')
    assert.equal(projectTone([summary('n', 'pending', { activity: activity() })]), 'idle')
  })
})

describe('Runs home cards', () => {
  test('each waiting kind has a next-step label and no command', () => {
    assert.equal(NEXT_STEP.question, 'answer the question')
    assert.equal(NEXT_STEP.pane, 'attend the pane')
    assert.equal(NEXT_STEP.approval, 'approve the candidate')
    for (const label of Object.values(NEXT_STEP)) assert.doesNotMatch(label, /workflow|\$RUN|python/)
  })
  test('lanes are named from the definition\'s launch nodes, in definition order', () => {
    assert.deepEqual(laneNamesOf(NODES), ['ui', 'adapter'])
    assert.deepEqual(laneNamesOf(laneGraphNodes(['ui', 'adapter', 'docs'])), ['ui', 'adapter', 'docs'])
    assert.deepEqual(laneNamesOf([{ node_id: 'review' }]), [])
  })
  test('controller readings are recorded per run across polls and dropped for runs no longer listed', () => {
    const first = recordHomeReadings(new Map(), [{ key: 'a', value: 'not_running' }, { key: 'b', value: 'running' }], '2026-03-20T12:00:00Z')
    assert.equal(controllerSuffix('running', first.get('a')!), null)
    assert.equal(controllerSuffix('running', first.get('b')!), 'running')
    const second = recordHomeReadings(first, [{ key: 'a', value: 'not_running' }], '2026-03-20T12:00:16Z')
    assert.equal(second.has('b'), false)
    assert.equal(second.get('a')!.length, 2)
    assert.equal(controllerSuffix('running', second.get('a')!), 'not_running')
  })
  test('a Running card names a stopped run in the stopped rows\' words, never as a span of how long it has been stopped (run 006)', () => {
    const now = Date.parse('2026-03-12T20:00:00Z')
    const created = '2026-03-12T16:00:00Z'
    const live = (status: RunSummary['status'], since: string | null, kind: 'interrupted' | 'paused' = 'interrupted') => ({ status, created_at: created, activity: { attention: since === null ? null : { kind, node_id: 'handoff', since } } })
    assert.deepEqual(cardElapsed(live('running', null), now), { elapsed: 'running for 4h00m', since: null, started: created })
    // Interrupted at 16:20 after starting at 16:00: at 20:00 it says it has been interrupted since today, with its stop time.
    assert.deepEqual(cardElapsed(live('paused', '2026-03-12T16:20:00Z'), now), { elapsed: 'interrupted today (since Mar 12)', since: '2026-03-12T16:20:00Z', started: null })
    assert.deepEqual(cardElapsed(live('paused', '2026-03-09T16:20:00Z', 'paused'), now), { elapsed: 'paused 3 d (since Mar 9)', since: '2026-03-09T16:20:00Z', started: null })
    // Served without a since (run 007): the stop counts from the start, and no start time follows the line a second time.
    assert.deepEqual(cardElapsed(live('paused', null), now), { elapsed: 'paused today (since Mar 12)', since: null, started: null })
    assert.deepEqual(cardElapsed(live('awaiting_approval', null), now), { elapsed: 'awaiting approval · started 4h00m ago', since: null, started: null })
    // An interrupted running run has stopped moving: its line is the stop, never a ticking span.
    assert.deepEqual(cardElapsed(live('running', '2026-03-12T16:20:00Z'), now), { elapsed: 'interrupted today (since Mar 12)', since: '2026-03-12T16:20:00Z', started: null })
    assert.equal(cardElapsed({ status: 'failed', created_at: created, activity: { attention: null } }, now), null)
  })
  test('a paused run served without attention.since waits on nobody: a Paused row, not a Needs-you card (run 007)', () => {
    const held = summary('held', 'paused', { created: '2026-03-20T07:00:00Z', activity: activity({ last_activity_at: '2026-03-20T07:00:16Z', attention: { kind: 'paused', node_id: 'handoff', since: null } }) })
    assert.equal(waitingKind(held), null)
    // Held today: a Today row (it moved today); held since an earlier day: a Paused row. Never a Needs-you card.
    const sections = homeSections([{ run: held }], NOW)
    assert.deepEqual(sections.today.map(row => row.run.run_id), ['held'])
    assert.equal(sections.paused.length + sections.running.length + sections.needsYou.length, 0)
    const earlier = homeSections([{ run: held }], NOW + 2 * DAY)
    assert.deepEqual(earlier.paused.map(row => row.run.run_id), ['held'])
    assert.equal(earlier.today.length + earlier.needsYou.length, 0)
    assert.deepEqual(cardElapsed(held, NOW), { elapsed: 'paused today (since Mar 20)', since: null, started: null })
  })
  test('sincePausedLabel: whole days from the paused since in the stopped rows\' words, else today under a day, never 0 d', () => {
    const paused = (since: string | null, lastActivity = '2026-03-20T09:00:00Z') => summary('p', 'paused', { activity: activity({ last_activity_at: lastActivity, attention: { kind: 'paused', node_id: 'handoff', since } }) })
    assert.equal(sincePausedLabel(paused('2026-03-20T09:30:00Z'), NOW), 'paused today (since Mar 20)')
    assert.equal(sincePausedLabel(paused('2026-03-19T11:00:00Z'), NOW), 'paused 1 d (since Mar 19)')
    assert.equal(sincePausedLabel(paused('2026-03-17T12:00:00Z'), NOW), 'paused 3 d (since Mar 17)')
    // Without a since, the last activity is the clock it counts from.
    assert.equal(sincePausedLabel(paused(null, '2026-03-14T12:00:00Z'), NOW), 'paused 6 d (since Mar 14)')
    assert.doesNotMatch(sincePausedLabel(paused('2026-03-20T11:59:00Z'), NOW), /\b0 d\b/)
    // Another year is named.
    assert.equal(sincePausedLabel(paused('2025-12-31T12:00:00Z'), NOW), 'paused 79 d (since Dec 31 2025)')
  })
  test('stepTally names and counts the step each row sits at, in first-seen order; rows without a focus step counted apart', () => {
    const at = (nodeId: string, label: string) => summary(`${nodeId}-run`, 'running', { activity: activity({ focus: { node_id: nodeId, label, status: 'running', since: null } }) })
    const bare = summary('bare', 'running', { activity: activity() })
    assert.equal(stepTally([{ run: at('launch_ui', 'Launch ui worker') }, { run: at('launch_ui', 'Launch ui worker') }, { run: at('verify_ui', 'Verify ui') }]), '2 at Launch ui worker, 1 at Verify ui')
    assert.equal(stepTally([{ run: at('verify_ui', 'Verify ui') }, { run: bare }]), '1 at Verify ui, 1 without a step')
    assert.equal(stepTally([]), '')
  })
  test('the review steps a feature declares come from its definition, in definition order (run 007)', () => {
    assert.deepEqual(reviewStepsOf(NODES), ['Independent review'])
    const guarded = [{ node_id: 'challenge', label: 'Design challenge', kind: 'review' as const }, ...NODES]
    assert.deepEqual(reviewStepsOf(guarded), ['Design challenge', 'Independent review'])
    assert.deepEqual(reviewStepsOf(NODES.filter(node => node.kind !== 'review')), [])
  })
})

describe('Needs you: the closed set of runs that need the operator (M2)', () => {
  type Attention = NonNullable<RunActivity['attention']>
  const run = (runId: string, status: RunSummary['status'], attention: Attention | null, fields: { created?: string; workflow?: string; project?: string; feature?: string | null } = {}) =>
    summary(runId, status, { created: fields.created ?? '2026-03-19T09:00:00Z', workflow: fields.workflow ?? 'w', project: fields.project ?? 'p',
      activity: activity({ attention, feature: fields.feature === undefined ? 'F' : fields.feature, finished_at: ['failed', 'succeeded', 'cancelled'].includes(status) ? '2026-03-19T10:00:00Z' : null }) })
  const challenge: Attention = { kind: 'paused', node_id: 'challenge', since: '2026-03-19T09:05:00Z' }
  const interrupted: Attention = { kind: 'interrupted', node_id: 'handoff', since: '2026-03-19T09:30:00Z' }
  const at = (kind: Attention['kind'], node: string | null = 'launch_ui'): Attention => ({ kind, node_id: node, since: '2026-03-19T09:10:00Z' })
  const later = (runId: string, fields: { workflow?: string; project?: string; feature?: string | null; created?: string; status?: RunSummary['status'] } = {}) =>
    run(runId, fields.status ?? 'succeeded', null, { created: fields.created ?? '2026-03-19T12:00:00Z', ...fields })
  const classOfRun = (runs: RunSummary[], runId: string): RunClass => classOf(classifyRuns(runs), runs.find(item => item.run_id === runId)!)
  const sectionOf = (runs: RunSummary[], runId: string) => {
    const sections = homeSections(runs.map(item => ({ run: item })), NOW)
    const names = (['needsYou', 'today', 'running', 'paused', 'superseded', 'recent'] as const).filter(name => sections[name].some(row => row.run.run_id === runId))
    assert.ok(names.length <= 1, `${runId} is listed in ${names.join(', ')}`)
    return names[0] ?? null
  }

  test('in: the latest run paused at the challenge (challenge_paused and challenge_held both serve it), interrupted paused, interrupted running', () => {
    assert.deepEqual(classOfRun([run('c', 'paused', challenge)], 'c'), { needs: 'decision', supersededBy: null })
    // A held challenge (C8) is served exactly the same way: the challenge node paused, status paused.
    assert.deepEqual(classOfRun([run('held', 'paused', { ...challenge, since: null })], 'held'), { needs: 'decision', supersededBy: null })
    assert.deepEqual(classOfRun([run('i', 'paused', interrupted)], 'i'), { needs: 'interrupted', supersededBy: null })
    assert.deepEqual(classOfRun([run('ir', 'running', interrupted)], 'ir'), { needs: 'interrupted', supersededBy: null })
    // Listed once, as a Needs-you row, never also under Running or Today (the interrupted running run moved today).
    for (const runId of ['c', 'i', 'ir']) {
      const runs = [run('c', 'paused', challenge, { workflow: 'a' }), run('i', 'paused', interrupted, { workflow: 'b' }), run('ir', 'running', { ...interrupted, since: '2026-03-20T11:00:00Z' }, { workflow: 'c', created: '2026-03-20T10:00:00Z' })]
      assert.equal(sectionOf(runs, runId), 'needsYou', runId)
    }
  })
  test('in, today\'s rule: an unfinished run with a question, a pane or an approval, whatever its status', () => {
    for (const kind of ['question', 'pane', 'approval'] as const) {
      assert.equal(classOfRun([run('r', 'running', at(kind))], 'r').needs, kind)
      assert.equal(classOfRun([run('a', 'awaiting_approval', at(kind))], 'a').needs, kind)
      // Not the latest of its workflow, and running: still waits (only a paused run is superseded).
      assert.equal(classOfRun([run('r', 'running', at(kind)), later('z')], 'r').needs, kind)
    }
  })
  test('out: a superseded paused run, whatever its attention, and whatever the later run\'s feature text (or none)', () => {
    for (const attention of [challenge, interrupted, at('question'), at('pane'), at('approval'), at('paused', 'handoff')]) {
      for (const feature of ['Another feature', null, 'F']) {
        const runs = [run('old', 'paused', attention), later('new', { feature })]
        assert.deepEqual(classOfRun(runs, 'old'), { needs: null, supersededBy: 'new' }, `${attention.kind} / ${feature}`)
        assert.equal(sectionOf(runs, 'old'), 'superseded')
      }
    }
  })
  test('out: a superseded interrupted running run keeps Running or Today; a plain running run; paused elsewhere; finished; accepted; no activity', () => {
    const runs = [run('ir', 'running', interrupted, { created: '2026-03-10T09:00:00Z' }), later('ir-next', { created: '2026-03-11T09:00:00Z', status: 'failed' })]
    assert.deepEqual(classOfRun(runs, 'ir'), { needs: null, supersededBy: null })
    assert.ok(['running', 'today'].includes(sectionOf(runs, 'ir')!))
    assert.equal(classOfRun([run('live', 'running', null)], 'live').needs, null)
    assert.equal(sectionOf([run('live', 'running', null, { created: '2026-03-10T09:00:00Z' })], 'live'), 'running')
    assert.equal(classOfRun([run('parked', 'paused', at('paused', 'handoff'))], 'parked').needs, null)
    assert.equal(classOfRun([run('held', 'paused', at('paused', null))], 'held').needs, null)
    for (const status of ['failed', 'succeeded', 'cancelled'] as const) {
      assert.equal(classOfRun([run('f', status, interrupted)], 'f').needs, null, status)
      assert.equal(classOfRun([run('f', status, challenge)], 'f').needs, null, status)
    }
    const accepted = { ...run('acc', 'succeeded', challenge), accepted: { candidate: 'a'.repeat(40), reason: 'merged', by: 'operator', accepted_at: '2026-03-19T10:00:00Z', on_main: true, review: 'recorded' as const, open_findings: [], abandoned: null } }
    assert.equal(classOfRun([accepted], 'acc').needs, null)
    assert.equal(classOfRun([summary('bare', 'paused', { workflow: 'w', project: 'p' })], 'bare').needs, null)
    // Status alone never puts a run in Needs you.
    assert.equal(classOfRun([run('aw', 'awaiting_approval', null)], 'aw').needs, null)
  })
  test('not superseded: a later run only in another workflow of the project, in the same workflow id of another project, or an older run', () => {
    assert.equal(classOfRun([run('c', 'paused', challenge), later('other', { workflow: 'w2' })], 'c').needs, 'decision')
    assert.equal(classOfRun([run('c', 'paused', challenge), later('elsewhere', { project: 'p2' })], 'c').needs, 'decision')
    assert.equal(classOfRun([run('c', 'paused', challenge), later('older', { created: '2026-03-18T09:00:00Z' })], 'c').needs, 'decision')
  })
  test('a created_at tie resolves by run id, and "superseded by" names the greatest later run, whatever the input order', () => {
    const tie = [run('b', 'paused', challenge), run('a', 'paused', challenge)]
    assert.deepEqual(classOfRun(tie, 'a'), { needs: null, supersededBy: 'b' })
    assert.equal(classOfRun(tie, 'b').needs, 'decision')
    // Pages come ordered by updated_at, not created_at: the superseding run may come after its predecessor.
    const runs = [run('first', 'paused', at('question')), later('second', { created: '2026-03-19T10:00:00Z' }), later('third', { created: '2026-03-19T11:00:00Z' })]
    for (const order of [runs, [...runs].reverse(), [runs[1], runs[0], runs[2]]]) {
      assert.deepEqual(classOfRun(order, 'first'), { needs: null, supersededBy: 'third' })
    }
  })
  test('a superseded question, pane or approval paused row is drawn as a paused row: never warn, never \'?\', no data-attention', () => {
    for (const kind of ['question', 'pane', 'approval'] as const) {
      const runs = [run('old', 'paused', at(kind)), later('new')]
      const look = rowLook(runs[0], classOfRun(runs, 'old'))
      assert.notEqual(look.tone, 'warn')
      assert.equal(look.tone, 'pause')
      assert.equal(look.glyph, null)
      assert.equal(look.attention, null)
      assert.doesNotMatch(rowSummary(runs[0], LABELS, classOfRun(runs, 'old').needs), /asked a question|needs attention|awaits your decision/)
    }
    assert.deepEqual(rowLook(run('c', 'paused', challenge), { needs: 'decision', supersededBy: null }), { tone: 'warn', glyph: '?', attention: 'decision' })
  })
  test('every count reads the one classification: a needs-operator run is one wait, never running; a superseded run is in none', () => {
    const runs = [
      run('decide', 'paused', challenge, { workflow: 'a' }),
      run('halt', 'paused', interrupted, { workflow: 'b' }),
      run('halt-live', 'running', interrupted, { workflow: 'c' }),
      run('redo-old', 'paused', at('question'), { workflow: 'd' }), later('redo-new', { workflow: 'd', status: 'failed' }),
      run('rerun-old', 'running', interrupted, { workflow: 'e' }), later('rerun-new', { workflow: 'e', status: 'failed' }),
      run('parked', 'paused', at('paused', 'review'), { workflow: 'f' }),
    ]
    const project = { project_id: 'p', name: 'P' }
    const info = projectRunInfo({ project, error: null, workflows: ['a', 'b', 'c', 'd', 'e', 'f'].map(id => ({ workflow: { workflow_id: id } as never, runs: runs.filter(item => item.workflow_id === id), more: false, error: null })) } as never)
    assert.equal(info.state, 'read')
    assert.equal(info.waits, 3)
    assert.equal(info.running, 1)
    assert.equal(info.paused, 1)
    const sections = homeSections(runs.map(item => ({ run: item })), NOW)
    assert.deepEqual(sections.needsYou.map(row => row.run.run_id).sort(), ['decide', 'halt', 'halt-live'])
    assert.deepEqual(sections.superseded.map(row => row.run.run_id), ['redo-old'])
    const listed = (['needsYou', 'today', 'running', 'paused', 'superseded', 'recent'] as const).flatMap(name => sections[name].map(row => row.run.run_id))
    assert.equal(new Set(listed).size, listed.length)
  })
  test('a refresh that clears the interrupted attention returns a running run to Running or Today', () => {
    const before = [run('ir', 'running', interrupted, { created: '2026-03-10T09:00:00Z' })]
    assert.equal(sectionOf(before, 'ir'), 'needsYou')
    const after = [run('ir', 'running', null, { created: '2026-03-10T09:00:00Z' })]
    assert.ok(['running', 'today'].includes(sectionOf(after, 'ir')!))
  })
  test('the new kinds name their next step and what waits', () => {
    assert.equal(NEXT_STEP.decision, 'resume or accept the challenge on the run page')
    assert.equal(NEXT_STEP.interrupted, 'resume the run on the run page')
    assert.match(rowSummary(run('c', 'paused', challenge), new Map([['challenge', 'Design challenge']]), 'decision'), /^Design challenge paused · your decision waits$/)
  })
})

describe('a row\'s time: dates and days for a stopped run, a span only while it runs (M14)', () => {
  const at = (runId: string, status: RunSummary['status'], attention: RunActivity['attention'], finished: string | null = null) =>
    summary(runId, status, { created: '2026-03-08T12:00:00Z', activity: activity({ attention, finished_at: finished, last_activity_at: '2026-03-10T12:00:00Z' }) })
  test('a paused row reads paused n d (since Mon D), from its attention since, else its last activity; no span', () => {
    const paused = at('p', 'paused', { kind: 'paused', node_id: 'handoff', since: '2026-03-10T08:00:00Z' })
    assert.deepEqual(rowTime(paused, NOW), { kind: 'stopped', how: 'paused', since: '2026-03-10T08:00:00Z' })
    assert.equal(stoppedLabel('paused', '2026-03-10T08:00:00Z', NOW), 'paused 10 d (since Mar 10)')
    assert.deepEqual(rowTime(at('q', 'paused', null), NOW), { kind: 'stopped', how: 'paused', since: '2026-03-10T12:00:00Z' })
  })
  test('an interrupted row reads interrupted n d whether its status is paused or running; never a span', () => {
    const attention = { kind: 'interrupted' as const, node_id: 'handoff', since: '2026-03-18T08:00:00Z' }
    assert.deepEqual(rowTime(at('ip', 'paused', attention), NOW), { kind: 'stopped', how: 'interrupted', since: '2026-03-18T08:00:00Z' })
    assert.deepEqual(rowTime(at('ir', 'running', attention), NOW), { kind: 'stopped', how: 'interrupted', since: '2026-03-18T08:00:00Z' })
    assert.equal(stoppedLabel('interrupted', '2026-03-18T08:00:00Z', NOW), 'interrupted 2 d (since Mar 18)')
  })
  test('under a day it reads today, never 0 d', () => {
    assert.equal(stoppedLabel('paused', '2026-03-20T11:00:00Z', NOW), 'paused today (since Mar 20)')
    assert.equal(stoppedLabel('interrupted', '2026-03-19T12:30:00Z', NOW), 'interrupted today (since Mar 19)')
  })
  test('a running row ticks; a finished row keeps its end and duration whatever attention it carries', () => {
    assert.equal(rowTime(at('r', 'running', null), NOW).kind, 'live')
    // A run that waits to start or on an approval does not run: it says when it last moved, with no ticking span.
    assert.deepEqual(rowTime(at('w', 'awaiting_approval', { kind: 'approval', node_id: 'handoff', since: '2026-03-10T08:00:00Z' }), NOW), { kind: 'updated', at: '2026-03-10T12:00:00Z' })
    assert.deepEqual(rowTime(at('n', 'pending', null), NOW), { kind: 'updated', at: '2026-03-10T12:00:00Z' })
    const finished = at('f', 'failed', { kind: 'interrupted', node_id: 'handoff', since: '2026-03-09T08:00:00Z' }, '2026-03-10T14:00:00Z')
    assert.deepEqual(rowTime(finished, NOW), { kind: 'finished', at: '2026-03-10T14:00:00Z', ms: 50 * 60 * 60 * 1000 })
  })
})

describe('the Triage pin store ([O10])', () => {
  /** A fake Web Storage that counts its calls, can throw, and can hold any text. */
  function fakeStorage(initial: string | null = null, options: { throwOnRead?: boolean; throwOnWrite?: boolean } = {}) {
    let value = initial
    const calls = { get: 0, set: 0 }
    const storage: PinStorage = {
      getItem: key => { calls.get += 1; if (options.throwOnRead) throw new Error('denied'); return key === PINS_KEY ? value : null },
      setItem: (key, text) => { calls.set += 1; if (options.throwOnWrite) throw new Error('quota'); if (key === PINS_KEY) value = text },
    }
    return { storage, calls, value: () => value }
  }
  const target = (runId: string) => ({ project_id: 'p', workflow_id: 'w', run_id: runId })
  let tick = 0
  const clock = () => new Date(Date.UTC(2026, 9, 13, 12, 0, tick++))

  test('pins persist newest first under the key, with the entry shape, and survive a new store (a reload)', () => {
    const fake = fakeStorage()
    const store = createPinStore(fake.storage, clock)
    store.add(target('a'))
    store.add(target('b'))
    assert.deepEqual(store.list().map(pin => pin.run_id), ['b', 'a'])
    const stored = JSON.parse(fake.value()!) as unknown[]
    assert.deepEqual(Object.keys(stored[0] as object).sort(), ['pinned_at', 'project_id', 'run_id', 'workflow_id'])
    assert.deepEqual(createPinStore(fake.storage).list().map(pin => pin.run_id), ['b', 'a'])
    assert.equal(store.saved(), true)
  })
  test('a duplicate pin leaves one entry (moved to the top); remove and toggle undo it', () => {
    const store = createPinStore(fakeStorage().storage, clock)
    store.add(target('a')); store.add(target('b')); store.add(target('a'))
    assert.deepEqual(store.list().map(pin => pin.run_id), ['a', 'b'])
    store.remove(target('a'))
    assert.equal(store.has(target('a')), false)
    store.toggle(target('b'))
    assert.deepEqual(store.list(), [])
  })
  test('at most 50 runs: the 51st pin drops the oldest', () => {
    const store = createPinStore(fakeStorage().storage, clock)
    for (let index = 0; index <= PINS_MAX; index += 1) store.add(target(`r${index}`))
    assert.equal(store.list().length, PINS_MAX)
    assert.equal(store.has(target('r0')), false)
    assert.equal(store.list()[0].run_id, `r${PINS_MAX}`)
    // A stored list longer than 50 is cut too.
    const long = JSON.stringify(Array.from({ length: 60 }, (_, index) => ({ ...target(`s${index}`), pinned_at: '2026-10-13T12:00:00Z' })))
    assert.equal(createPinStore(fakeStorage(long).storage).list().length, PINS_MAX)
  })
  test('a malformed, missing or foreign stored value reads as no pins', () => {
    for (const text of ['not json', '{"a":1}', '[1,2]', '[{"run_id":"x"}]', 'null', null]) {
      assert.deepEqual(createPinStore(fakeStorage(text).storage).list(), [], String(text))
    }
  })
  test('a storage that throws never makes the store throw: pins live in memory and saved() turns false', () => {
    const reads = createPinStore(fakeStorage(null, { throwOnRead: true }).storage, clock)
    assert.equal(reads.saved(), false)
    assert.doesNotThrow(() => reads.add(target('a')))
    assert.deepEqual(reads.list().map(pin => pin.run_id), ['a'])
    const writes = createPinStore(fakeStorage(null, { throwOnWrite: true }).storage, clock)
    assert.doesNotThrow(() => writes.add(target('b')))
    assert.equal(writes.has(target('b')), true)
    assert.equal(writes.saved(), false)
    const none = createPinStore(null, clock)
    assert.doesNotThrow(() => none.toggle(target('c')))
    assert.equal(none.saved(), false)
  })
  test('pinning and unpinning issue no request: only the storage is touched', () => {
    const original = globalThis.fetch
    let requests = 0
    globalThis.fetch = (() => { requests += 1; return Promise.reject(new Error('no request expected')) }) as typeof fetch
    try {
      const fake = fakeStorage()
      const store = createPinStore(fake.storage, clock)
      const changes: number[] = []
      store.subscribe(() => changes.push(store.list().length))
      store.add(target('a')); store.toggle(target('a')); store.toggle(target('b')); store.remove(target('b'))
      assert.equal(requests, 0)
      assert.equal(fake.calls.set, 4)
      assert.deepEqual(changes, [1, 0, 1, 0])
    } finally {
      globalThis.fetch = original
    }
  })
})
