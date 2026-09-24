/**
 * The run page's Steps model (docs/PRD_VIEWER_UX.md 4.2, 5.3): one row per step in definition order with its start, how long
 * it took, its attempt and attempt markers (✗ failed, ? ended without a record, ⚑ the controller's diagnosis, ⚒ an operator
 * repair, ✓ passed), its outcome and whether it waits on the operator; the time axis of the bars, which breaks silences over
 * 30 minutes; and the step strip's short labels. Read on the captured skeleton-001 and workflow-guardrails-001 payloads.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateReviewResult, validateRunDetail, validateRunInputs } from '../../contracts/projects/v1.ts'
import { eventSchema, validateWorkerResult } from '../../contracts/workflow/v1.ts'
import { buildTimeline, deriveAttention, type RunData } from '../../contracts/projects/triage.ts'
import { formatShortSpan, shortStepLabel, stepRows, timeAxis, type StepRow } from '../../src/projects/steps.ts'
import { formatSpan } from '../../src/projects/time.ts'

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
