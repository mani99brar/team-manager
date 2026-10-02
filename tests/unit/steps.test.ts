/**
 * The run page's Steps model (docs/PRD_VIEWER_UX.md 4.2, 5.3): one row per step in definition order with its start, how long
 * it took, its attempt and attempt markers (✗ failed, ? ended without a record, ⚑ the controller's diagnosis, ⚒ an operator
 * repair, ✓ passed), its outcome and whether it waits on the operator; the time axis of the bars, which breaks silences over
 * 30 minutes; and the step strip's short labels. Read on the captured skeleton-001 and workflow-guardrails-001 payloads.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { validateReviewResult, validateRunDetail, validateRunInputs } from '../../contracts/projects/v1.ts'
import { eventSchema, validateWorkerResult } from '../../contracts/workflow/v1.ts'
import { buildTimeline, deriveAttention, type RunData } from '../../contracts/projects/triage.ts'
import { formatShortSpan, outageBands, shortStepLabel, stepRows, timeAxis, type StepRow } from '../../src/projects/steps.ts'
import { formatSpan } from '../../src/projects/time.ts'
import { ACTIVITY_PHASE_LABEL, groupActivity, nodePhase, orderActivityGroups, phaseState, type ActivityPhase } from '../../src/projects/node/model.ts'
import { RUN_SIDECAR, RUN_SIDECAR_FROZEN, uxSidecar } from '../project-workflows/fixtures/ux-sidecar.ts'

type Tone = 'ok' | 'run' | 'warn' | 'fail' | 'pause' | 'idle'
type ToneModule = { statusTone: (status: string) => Tone; stateTone: (input: { status?: string | null; attention?: string | null }) => Tone }
// tone.ts (the shell's) is loaded by URL so `tsc -b` under nodenext does not follow its extensionless contract import; the
// tests still run the very functions the pages call.
const { statusTone, stateTone } = await import(new URL('../../src/projects/tone.ts', import.meta.url).href) as ToneModule

const MINUTE = 60_000
const HOUR = 60 * MINUTE

function loadRun(name: string): RunData {
  const raw = JSON.parse(readFileSync(new URL(`fixtures/runs/${name}.json`, import.meta.url), 'utf8')) as {
    detail: unknown; events: unknown[]; inputs: unknown; review: unknown; results: Record<string, unknown>
  }
  return {
    detail: validateRunDetail(raw.detail),
    events: raw.events.map(event => eventSchema.parse(event)),
    inputs: validateRunInputs(raw.inputs),
    review: raw.review === null ? null : validateReviewResult(raw.review),
    results: new Map(Object.entries(raw.results).map(([uri, result]) => [uri, validateWorkerResult(result)])),
  }
}

const skeleton = loadRun('skeleton-001')
const guardrails = loadRun('workflow-guardrails-001')
const rowsOf = (run: RunData) => stepRows(run.detail, buildTimeline(run), { now: Date.parse('2026-09-24T12:00:00Z'), attention: deriveAttention(run) })
const byId = (rows: StepRow[], id: string) => rows.find(row => row.node_id === id)!
const took = (row: StepRow) => (row.ms === null ? null : `${row.inferred ? '≈' : ''}${formatSpan(row.ms)}`)

describe('stepRows on skeleton-001', () => {
  const rows = rowsOf(skeleton)

  test('one row per step, in definition order', () => {
    assert.deepEqual(rows.map(row => row.node_id), skeleton.detail.definition.nodes.map(node => node.node_id))
  })

  test('the design challenge: three attempts, the first ended without a record, 11m07s from its first start', () => {
    const row = byId(rows, 'challenge')
    assert.equal(row.attempt, 3)
    assert.equal(row.marks, '?✗✓')
    assert.equal(row.start?.at.slice(11, 19), '08:39:42')
    assert.equal(took(row), '11m07s')
    assert.match(row.outcome, /passed/)
  })

  test('the worker: its launch and stop receipts, one attempt and no markers', () => {
    const row = byId(rows, 'launch_game')
    assert.equal(row.start?.source, 'receipt')
    assert.equal(row.start?.at.slice(11, 19), '08:50:52')
    assert.equal(took(row), '28m21s')
    assert.equal(row.attempt, 1)
    assert.equal(row.marks, '')
  })

  test('the freeze is an instant', () => {
    assert.equal(took(byId(rows, 'handoff')), '0s')
  })

  test('verification: two identical failures, the diagnosis and the repair on its own row, then the pass', () => {
    const row = byId(rows, 'verify_game')
    assert.equal(row.attempt, 3)
    assert.equal(row.marks, '✗✗⚑⚒✓')
    assert.equal(row.start?.at.slice(11, 19), '09:19:13')
    assert.equal(took(row), '10m02s')
    assert.equal(row.status, 'succeeded')
  })

  test('the candidate and the print review start where the step before them ended, marked inferred', () => {
    assert.equal(took(byId(rows, 'candidate')), '≈1m06s')
    const review = byId(rows, 'review')
    assert.equal(took(review), '≈2m10s')
    assert.equal(review.start?.source, 'inferred')
    assert.equal(review.status, 'failed')
    assert.match(review.outcome, /blocked by general/)
  })

  test('steps never reached have no times and read "not started", never attempt 0', () => {
    for (const id of ['approval', 'integrate']) {
      const row = byId(rows, id)
      assert.equal(row.status, 'pending')
      assert.equal(row.start, null)
      assert.equal(row.ms, null)
      assert.equal(row.attempt, 0)
      assert.equal(row.outcome, 'not started')
    }
  })

  test('nothing waits on the operator in a finished run', () => {
    assert.ok(rows.every(row => row.attention === null))
  })
})

describe('stepRows on skeleton-001 as served at #21, waiting for the repair to be continued', () => {
  // The operator's repair note (#20) restates attempt 2 and pauses the step; the node-less "applied" row (#21) follows.
  const events = skeleton.events.filter(event => event.sequence <= 21)
  const detail = {
    ...skeleton.detail,
    summary: { ...skeleton.detail.summary, status: 'paused' as const },
    snapshot: {
      ...skeleton.detail.snapshot, status: 'paused' as const, last_sequence: 21,
      nodes: skeleton.detail.snapshot.nodes.map(node => (node.node_id === 'verify_game' ? { ...node, status: 'paused' as const, attempt: 2 }
        : ['candidate', 'review'].includes(node.node_id) ? { ...node, status: 'pending' as const, attempt: 0, result_uri: null } : node)),
    },
  }
  const run: RunData = { ...skeleton, detail, events, review: null }
  const row = byId(stepRows(detail, buildTimeline(run), { now: Date.parse('2026-09-24T12:00:00Z') }), 'verify_game')

  test('the outcome is the step\'s latest state, the repair, not the verdict of the attempt before it', () => {
    assert.equal(row.status, 'paused')
    assert.match(row.outcome, /^repair 1: snapshot 50b14b3/)
    assert.equal(row.marks, '✗✗⚑⚒')
    assert.equal(took(row), '2m16s')
  })
})

describe('stepRows on workflow-guardrails-001', () => {
  const rows = rowsOf(guardrails)

  test('controller checkpoints and outages are never attempts of the lane named controller', () => {
    const row = byId(rows, 'launch_controller')
    assert.equal(row.attempt, 1)
    assert.equal(row.marks, '')
    assert.equal(row.start?.source, 'receipt')
  })

  test('the verify retry of the controller lane', () => {
    const row = byId(rows, 'verify_controller')
    assert.equal(row.attempt, 2)
    assert.equal(row.marks, '✗✓')
  })

  test('the candidate names the lane its outcome concerns', () => {
    const row = byId(rows, 'candidate')
    assert.equal(row.status, 'failed')
    assert.match(row.outcome, /^ui: /)
  })

  test('the candidate marks one mark per attempt, not per lane: two attempts, both failed on the ui lane', () => {
    // Attempt 1 passed on controller and failed on ui; attempt 2 ran ui alone and failed again.
    const row = byId(rows, 'candidate')
    assert.equal(row.attempt, 2)
    assert.equal(row.marks, '✗✗')
  })
})

describe('outageBands on workflow-guardrails-001', () => {
  const timeline = buildTimeline(guardrails)
  const rows = stepRows(guardrails.detail, timeline, { now: Date.parse('2026-09-24T12:00:00Z') })
  const bands = (id: string) => outageBands(byId(rows, id), timeline.gaps, Date.parse('2026-09-24T12:00:00Z'))

  test('both controller outages fall inside each worker\'s bar: 4m56s and 6m35s', () => {
    for (const id of ['launch_controller', 'launch_ui']) {
      assert.deepEqual(bands(id).map(band => formatSpan(band.end - band.start)), ['4m56s', '6m35s'])
      assert.equal(new Date(bands(id)[0].start).toISOString(), '2026-09-23T19:42:47.499Z')
    }
  })

  test('steps that are not workers, or ran after the outages, get none', () => {
    for (const id of ['handoff', 'verify_controller', 'candidate']) assert.deepEqual(bands(id), [])
  })
})

describe('timeAxis', () => {
  test('without a long silence, time maps linearly from the run start to its end', () => {
    const axis = timeAxis(0, 60 * MINUTE, [{ start: 0, end: 20 * MINUTE }, { start: 25 * MINUTE, end: 60 * MINUTE }])
    assert.equal(axis.position(0), 0)
    assert.equal(axis.position(60 * MINUTE), 1)
    assert.equal(axis.position(30 * MINUTE), 0.5)
    assert.deepEqual(axis.breaks, [])
  })

  test('a silence over 30 minutes becomes a short break, so an overnight gap does not squash the bars', () => {
    const end = 8 * HOUR + 10 * MINUTE
    const axis = timeAxis(0, end, [{ start: 0, end: 10 * MINUTE }, { start: 8 * HOUR, end }])
    assert.equal(axis.breaks.length, 1)
    assert.equal(axis.breaks[0].ms, 8 * HOUR - 10 * MINUTE)
    assert.ok(axis.position(8 * HOUR) < 0.6, `the second cluster starts at ${axis.position(8 * HOUR)}`)
    assert.ok(axis.position(10 * MINUTE) > 0.3, `the first cluster ends at ${axis.position(10 * MINUTE)}`)
    assert.equal(axis.position(end), 1)
    assert.ok(axis.position(4 * HOUR) > axis.position(10 * MINUTE) && axis.position(4 * HOUR) < axis.position(8 * HOUR))
  })

  test('positions outside the axis are clamped', () => {
    const axis = timeAxis(10 * MINUTE, 20 * MINUTE, [])
    assert.equal(axis.position(0), 0)
    assert.equal(axis.position(30 * MINUTE), 1)
  })
})

describe('labels', () => {
  test('the step strip shortens the fixed step names', () => {
    const label = (node_id: string, label: string) => shortStepLabel({ node_id, label })
    assert.equal(label('launch_game', 'Launch game worker'), 'Launch game')
    assert.equal(label('verify_game', 'Verify game'), 'Verify game')
    assert.equal(label('handoff', 'Freeze worker handoffs'), 'Freeze')
    assert.equal(label('candidate', 'Verify combined candidate'), 'Candidate')
    assert.equal(label('review', 'Independent review'), 'Review')
    assert.equal(label('approval', 'Integration approval'), 'Approval')
    assert.equal(label('integrate', 'Integrate candidate'), 'Integrate')
    assert.equal(label('challenge', 'Design challenge'), 'Challenge')
    assert.equal(label('custom_step', 'Custom step'), 'Custom step')
  })

  test('short durations for the strip', () => {
    assert.equal(formatShortSpan(46_000), '46s')
    assert.equal(formatShortSpan(28 * MINUTE + 21_000), '28m')
    assert.equal(formatShortSpan(HOUR + 5 * MINUTE + 59_000), '1h05m')
  })
})

describe('the review sidecar step (docs/PRD_REVIEW_SIDECAR.md 4.9)', () => {
  const payloads = uxSidecar.payloads!
  const runOf = (runId: string): RunData => ({ detail: payloads.runDetails![runId], events: payloads.runEvents![runId], inputs: payloads.runInputs![runId], review: null, results: new Map() })

  test('the step strip calls it Sidecar', () => {
    assert.equal(shortStepLabel({ node_id: 'sidecar', label: 'Review sidecar' }), 'Sidecar')
  })

  test('its row follows the challenge, before the launches, with its span from its own events and no new code', () => {
    const rows = stepRows(runOf(RUN_SIDECAR).detail, buildTimeline(runOf(RUN_SIDECAR)), { now: Date.parse('2026-10-01T14:00:00Z') })
    assert.deepEqual(rows.slice(0, 3).map(row => row.node_id), ['challenge', 'sidecar', 'launch_engine'])
    const row = byId(rows, 'sidecar')
    assert.equal(row.kind, 'review')
    assert.equal(row.shown, 'running')
    assert.equal(row.start?.at, '2026-10-01T12:10:00Z')
    assert.equal(row.live, true)
    assert.equal(row.ms, Date.parse('2026-10-01T14:00:00Z') - Date.parse('2026-10-01T12:10:00Z'))
    assert.equal(row.attempt, 1)
    assert.equal(row.marks, '')
    // Closed at freeze: from its first pass to its `succeeded`.
    const frozen = byId(stepRows(runOf(RUN_SIDECAR_FROZEN).detail, buildTimeline(runOf(RUN_SIDECAR_FROZEN)), { now: Date.parse('2026-10-01T15:00:00Z') }), 'sidecar')
    assert.equal(frozen.status, 'succeeded')
    assert.equal(frozen.end?.at, '2026-10-01T14:26:00Z')
    assert.equal(took(frozen), formatSpan(Date.parse('2026-10-01T14:26:00Z') - Date.parse('2026-10-01T12:10:00Z')))
  })
})

describe('Activity grouped by phase (docs/PRD_VIEWER_REVAMP.md 5.3)', () => {
  const phaseOfRun = (run: RunData) => {
    const nodes = new Map(run.detail.definition.nodes.map(node => [node.node_id, node]))
    return (nodeId: string) => {
      const node = nodes.get(nodeId)
      return node ? nodePhase(node) : null
    }
  }
  const flat = <T>(groups: { rows: T[] }[]) => groups.flatMap(group => group.rows)

  test('each node kind maps to its phase; the sidecar and unknown nodes have none of their own', () => {
    const phase = (node_id: string, kind: Parameters<typeof nodePhase>[0]['kind']) => nodePhase({ node_id, kind })
    assert.equal(phase('challenge', 'review'), 'challenge')
    assert.equal(phase('launch_ui', 'worker'), 'workers')
    assert.equal(phase('handoff', 'prepare'), 'verification')
    assert.equal(phase('verify_ui', 'verification'), 'verification')
    assert.equal(phase('candidate', 'verification'), 'verification')
    assert.equal(phase('review', 'review'), 'review')
    assert.equal(phase('approval', 'integration'), 'review')
    assert.equal(phase('integrate', 'integration'), 'review')
    assert.equal(phase('sidecar', 'review'), null)
    assert.deepEqual(Object.keys(ACTIVITY_PHASE_LABEL), ['challenge', 'workers', 'verification', 'review', 'run'])
    assert.equal(ACTIVITY_PHASE_LABEL.verification, 'Freeze and verification')
  })

  test('on skeleton-001 the groups keep every row in order, and the node-less diagnosis and repair sit in the phase where they occur', () => {
    const activity = buildTimeline(skeleton).activity
    const groups = groupActivity(activity, phaseOfRun(skeleton))
    assert.deepEqual(flat(groups), activity, 'every row, in the same order, exactly once')
    // Consecutive groups never share a phase: a group is one stretch of the run.
    for (let index = 1; index < groups.length; index++) assert.notEqual(groups[index].phase, groups[index - 1].phase)
    assert.equal(new Set(groups.map(group => group.key)).size, groups.length)
    const markers = activity.filter(row => row.marker === 'diagnosis' || row.marker === 'repair')
    assert.ok(markers.length >= 2, 'skeleton-001 records a diagnosis and a repair')
    for (const row of markers) {
      const group = groups.find(candidate => candidate.rows.includes(row))!
      assert.equal(group.phase, 'verification', `${row.marker} sits with the verification it concerns`)
    }
    assert.equal(groups[0].rows[0], activity[0])
  })

  test('node-less rows before any step join the first phase; after one they join the current phase; with no step at all they form one Run group', () => {
    type Row = { node_id: string | null; text: string }
    const phases: Record<string, ActivityPhase> = { launch_ui: 'workers', verify_ui: 'verification', review: 'review' }
    const rows: Row[] = [
      { node_id: null, text: 'controller started' },
      { node_id: 'launch_ui', text: 'launched' },
      { node_id: 'sidecar', text: 'sidecar pass' },
      { node_id: 'verify_ui', text: 'verify failed' },
      { node_id: null, text: 'diagnosis' },
      { node_id: null, text: 'repair' },
      { node_id: 'verify_ui', text: 'verify passed' },
      { node_id: 'review', text: 'review approved' },
    ]
    const groups = groupActivity(rows, nodeId => phases[nodeId] ?? null)
    assert.deepEqual(groups.map(group => [group.phase, group.rows.map(row => row.text)]), [
      ['workers', ['controller started', 'launched', 'sidecar pass']],
      ['verification', ['verify failed', 'diagnosis', 'repair', 'verify passed']],
      ['review', ['review approved']],
    ])
    assert.deepEqual(groups.map(group => group.label), ['Workers', 'Freeze and verification', 'Review and integration'])
    const alone = groupActivity([{ node_id: null, text: 'controller started' }], () => null)
    assert.deepEqual(alone.map(group => [group.phase, group.rows.length]), [['run', 1]])
    assert.deepEqual(groupActivity([], () => null), [])
  })

  test('a group keeps its key when the controller log is toggled or a poll adds rows before, inside or after it (run 006)', () => {
    type Row = { node_id: string | null; sequence: number; text: string; log?: boolean }
    const phases: Record<string, ActivityPhase> = { launch_ui: 'workers', launch_api: 'workers', candidate: 'verification', review: 'review' }
    const phaseOf = (nodeId: string) => phases[nodeId] ?? null
    const keys = (rows: Row[]) => Object.fromEntries(groupActivity(rows, phaseOf).map(group => [group.rows.map(row => row.text).join(','), group.key]))
    const log = (sequence: number): Row => ({ node_id: null, sequence, text: `log${sequence}`, log: true })
    const rows: Row[] = [
      log(1),
      { node_id: 'launch_ui', sequence: 2, text: 'ui' },
      log(3),
      { node_id: 'launch_api', sequence: 5, text: 'api' },
      { node_id: 'candidate', sequence: 6, text: 'candidate' },
      { node_id: 'review', sequence: 7, text: 'review' },
    ]
    const all = groupActivity(rows, phaseOf)
    const without = groupActivity(rows.filter(row => !row.log), phaseOf)
    assert.deepEqual(without.map(group => group.key), all.map(group => group.key), 'hiding the controller log keeps every key')
    // A late poll brings a candidate row that occurred between the two launches: the workers stretch splits in two.
    const split = [...rows.slice(0, 3), { node_id: 'candidate', sequence: 4, text: 'early' }, ...rows.slice(3)]
    const before = groupActivity(rows, phaseOf)
    const after = groupActivity(split, phaseOf)
    assert.equal(after.length, before.length + 2)
    const keyOf = (groups: typeof before, text: string) => groups.find(group => group.rows.some(row => row.text === text))!.key
    for (const text of ['ui', 'candidate', 'review']) assert.equal(keyOf(after, text), keyOf(before, text), `the group holding ${text} keeps its key`)
    assert.equal(new Set(after.map(group => group.key)).size, after.length, 'keys stay unique')
    // A poll that appends rows extends the last group and adds new ones without renaming any.
    const grown = keys([...rows, { node_id: 'review', sequence: 8, text: 'approved' }])
    assert.equal(grown['review,approved'], keys(rows).review)
  })

  test('newest first reverses the groups and the rows inside them, so the first row is the last event; keys stay', () => {
    const activity = buildTimeline(guardrails).activity
    const groups = groupActivity(activity, phaseOfRun(guardrails))
    const newest = orderActivityGroups(groups, true)
    assert.deepEqual(flat(newest), [...activity].reverse())
    assert.deepEqual(newest.map(group => group.key), groups.map(group => group.key).reverse())
    assert.deepEqual(orderActivityGroups(groups, false), groups)
    assert.deepEqual(flat(groups), activity)
  })
})

describe('a phase group says where it stands, in tone and words (docs/PRD_VIEWER_REVAMP.md 5.3)', () => {
  // The page's own mapping (tone.ts `statusTone`), not a copy of its table, so a change there shows up here.
  const toneOf = (status: string) => statusTone(status)
  type Row = { at: string; sequence: number | null; node_id: string | null; lane: string | null; kind: string; status: string | null }
  let clock = 0
  // Each row one minute after the one before, in the order written.
  const row = (node_id: string | null, status: string | null, kind = 'end', lane: string | null = null): Row => {
    clock += 1
    return { at: new Date(Date.UTC(2026, 2, 12, 9, clock)).toISOString(), sequence: clock, node_id, lane, kind, status }
  }

  test('each step counts by its latest status: a verification that failed and then passed after a repair is passed', () => {
    assert.deepEqual(phaseState([row('verify_ui', 'running', 'start'), row('verify_ui', 'failed'), row(null, null, 'marker'), row('verify_ui', 'succeeded')], toneOf), { tone: 'ok', words: 'all passed' })
    assert.deepEqual(phaseState([row('verify_ui', 'failed'), row('verify_adapter', 'failed'), row('candidate', 'succeeded')], toneOf), { tone: 'fail', words: '2 failed' })
    // Newest first hands the rows over reversed: the repaired step still reads passed.
    const repaired = [row('verify_ui', 'running', 'start'), row('verify_ui', 'failed'), row(null, null, 'marker'), row('verify_ui', 'running', 'start'), row('verify_ui', 'succeeded')]
    assert.deepEqual(phaseState([...repaired].reverse(), toneOf), { tone: 'ok', words: 'all passed' })
    assert.deepEqual(phaseState(repaired, toneOf), phaseState([...repaired].reverse(), toneOf))
  })

  test('waiting on the operator is warn as statusTone says, then paused, then running; a lane of the candidate is its own step', () => {
    assert.deepEqual(phaseState([row('handoff', 'awaiting_approval', 'update'), row('verify_ui', 'running', 'start')], toneOf), { tone: 'warn', words: 'waiting on you' })
    assert.deepEqual(phaseState([row('review', 'paused', 'update')], toneOf), { tone: 'pause', words: 'paused' })
    assert.deepEqual(phaseState([row('candidate', 'succeeded', 'end', 'ui'), row('candidate', 'running', 'start', 'adapter')], toneOf), { tone: 'run', words: 'running' })
  })

  test('a step that waits on the operator makes its phase say so, whatever its status (the page passes stateTone)', () => {
    // As StepsTimeline passes it: tone.ts `stateTone` with the step's attention, so a question wins over `running`.
    const waiting = (status: string, nodeId: string) => stateTone({ status, attention: nodeId === 'launch_adapter' ? 'question' : null })
    assert.deepEqual(phaseState([row('launch_ui', 'running', 'start'), row('launch_adapter', 'running', 'update')], waiting), { tone: 'warn', words: 'waiting on you' })
  })

  test('gaps and node-less rows say nothing; a phase without a status is idle with no words', () => {
    assert.deepEqual(phaseState([row(null, 'running', 'marker'), row(null, null, 'gap')], toneOf), { tone: 'idle', words: '' })
    // A phase with a step not started (pending) is not green: idle, no words.
    assert.deepEqual(phaseState([row('launch_ui', 'succeeded'), row('launch_adapter', 'pending', 'update')], toneOf), { tone: 'idle', words: '' })
  })
})

describe('the tone a phase takes is the page mapping\'s, for every status a step can have', () => {
  test('a phase of one finished, waiting, paused or running step takes statusTone of that status', () => {
    const cases: [string, string][] = [['succeeded', 'all passed'], ['failed', '1 failed'], ['awaiting_approval', 'waiting on you'], ['paused', 'paused'], ['running', 'running']]
    for (const [status, words] of cases) {
      const rows = [{ at: '2026-03-12T09:00:00Z', sequence: 1, node_id: 'verify_ui', lane: null, kind: 'end', status }]
      assert.deepEqual(phaseState(rows, (value: string) => statusTone(value)), { tone: statusTone(status), words }, status)
    }
  })
})

/**
 * One clock (docs/PRD_VIEWER_UX.md, PRD_VIEWER_REVAMP.md section 6 safety rules): a run page ticks from `RunView` and the lists
 * from `ProjectsView`; every section takes the time as a prop. A file under src/projects that calls or imports `useNow`
 * anywhere else starts a second clock, so this fails.
 */
describe('one clock: useNow is called only in RunView.tsx and ProjectsView.tsx', () => {
  const root = new URL('../../src/projects/', import.meta.url)
  const ALLOWED = new Set(['RunView.tsx', 'ProjectsView.tsx', 'useNow.ts'])
  const files = (dir: URL, prefix = ''): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`)
    : /\.(ts|tsx)$/.test(entry.name) ? [`${prefix}${entry.name}`] : [])
  /**
   * Where a source starts a clock, by line: a `useNow(` call (not its definition, `ns.useNow(` included) or an import that names
   * `useNow`, matched over the whole source so an import spread over several lines or aliased (`useNow as tick`) counts too.
   */
  const clockUses = (source: string): number[] => {
    const lineOf = (offset: number) => source.slice(0, offset).split('\n').length
    const code = source.replace(/\/\/[^\n]*/g, match => ' '.repeat(match.length))
    const lines = new Set<number>()
    for (const match of code.matchAll(/\bimport\s*(?:type\s+)?\{[^}]*\buseNow\b[^}]*\}\s*from/g)) lines.add(lineOf(match.index))
    for (const match of code.matchAll(/\buseNow\s*\(/g)) {
      if (!/function\s+$/.test(code.slice(Math.max(0, match.index - 20), match.index))) lines.add(lineOf(match.index))
    }
    return [...lines].sort((a, b) => a - b)
  }

  test('the scanner finds a section\'s own clock (WorkerQuestions as run 004 shipped it) and RunView\'s', () => {
    const run004 = "import { useNow } from './useNow.ts'\nexport function WorkerQuestions() {\n  const now = useNow(waiting > 0, 30_000)\n}\n"
    assert.deepEqual(clockUses(run004), [1, 3])
    assert.deepEqual(clockUses('export function useNow(active: boolean, intervalMs = 1000): number {'), [])
    assert.deepEqual(clockUses("import { useTimeZone } from './useNow.ts'"), [], 'the time-zone hook from the same module is no clock')
    // An import over several lines with an alias, then the alias called: the import names the clock.
    assert.deepEqual(clockUses("import { formatAgo } from './time.ts'\nimport {\n  useTimeZone,\n  useNow as tick,\n} from './useNow.ts'\nconst now = tick(true)\n"), [2])
    assert.deepEqual(clockUses("import * as clocks from './useNow.ts'\nconst now = clocks.useNow(true)\n"), [2])
    assert.ok(clockUses(readFileSync(new URL('RunView.tsx', root), 'utf8')).length > 0, 'RunView keeps the run page clock')
    assert.ok(clockUses(readFileSync(new URL('ProjectsView.tsx', root), 'utf8')).length > 0, 'ProjectsView keeps the lists clock')
  })

  test('no other file under src/projects calls or imports useNow', () => {
    const all = files(root)
    assert.ok(all.includes('WorkerInputs.tsx') && all.includes('node/WorkerSections.tsx'), 'the scan reaches nested sections')
    const offenders = all.filter(file => !ALLOWED.has(file)).flatMap(file => clockUses(readFileSync(new URL(file, root), 'utf8')).map(line => `${file}:${line}`))
    assert.deepEqual(offenders, [], 'a section takes the clock as a prop from RunView instead of starting its own')
  })
})
