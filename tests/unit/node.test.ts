/**
 * The node view's header model (docs/PRD_VIEWER_UX.md 4.4, 5.3, 7): "not started" instead of "attempt 0"; the timing line
 * of an attempt with its setup and check split and its source when that is not an event; the attempt strip with the
 * controller's diagnosis and the operator's repair between the attempts they concern; and which node shows a shared
 * result's facts (verify) and which its worker narrative (launch). Read on the captured skeleton-001 and
 * workflow-guardrails-001 payloads.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateReviewResult, validateRunDetail, validateRunInputs } from '../../contracts/projects/v1.ts'
import { eventSchema, validateWorkerResult } from '../../contracts/workflow/v1.ts'
import { buildTimeline, type RunData } from '../../contracts/projects/triage.ts'
import { attemptStrip, attemptWord, nodeTiming, resultRole, type StripItem } from '../../src/projects/node/model.ts'
import { formatSpan } from '../../src/projects/time.ts'

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
// The run page's timeline reads only the results the Now banner needs, not every attempt's.
const timelineOf = (run: RunData) => buildTimeline({ ...run, results: new Map() })
const GAME_3 = '/api/projects/project-b/workflows/skeleton/runs/skeleton-001/results/game/3'
const clock = (at: string | undefined) => at?.slice(11, 19)
const describeStrip = (items: StripItem[]) => items.map(item => (item.kind === 'attempt' ? `#${item.chip.attempt} ${item.chip.status}` : item.kind))

describe('attemptWord', () => {
  test('a step that never started reads "not started", never "attempt 0"', () => {
    assert.equal(attemptWord(0), 'not started')
    assert.equal(attemptWord(3), '3')
  })
})

describe('nodeTiming on skeleton-001', () => {
  const timeline = timelineOf(skeleton)

  test('the latest verify attempt: its start, end and duration, split into setup and checks once its result is read', () => {
    const timing = nodeTiming(timeline, 'verify_game', null, skeleton.results!.get(GAME_3))!
    assert.equal(timing.attempt, 3)
    assert.equal(clock(timing.start?.at), '09:28:00')
    assert.equal(clock(timing.end?.at), '09:29:15')
    assert.equal(formatSpan(timing.ms!), '1m15s')
    assert.equal(formatSpan(timing.setupMs!), '42s')
    assert.equal(formatSpan(timing.checksMs!), '33s')
    assert.equal(timing.source, null)
    assert.equal(timing.inferred, false)
  })

  test('an earlier attempt, chosen by number; no split without its result', () => {
    const timing = nodeTiming(timeline, 'verify_game', 1)!
    assert.equal(timing.attempt, 1)
    assert.equal(clock(timing.start?.at), '09:19:13')
    assert.equal(formatSpan(timing.ms!), '1m07s')
    assert.equal(timing.setupMs, null)
  })

  test('the worker names its receipts as the source', () => {
    const timing = nodeTiming(timeline, 'launch_game', null)!
    assert.equal(formatSpan(timing.ms!), '28m21s')
    assert.equal(timing.source, 'from the launch receipt and the stop receipt')
  })

  test('the print review names its inferred start', () => {
    const timing = nodeTiming(timeline, 'review', null)!
    assert.equal(timing.inferred, true)
    assert.match(timing.source!, /start inferred from Verify combined candidate|start inferred from/)
  })

  test('a step that never started has no timing', () => {
    assert.equal(nodeTiming(timeline, 'approval', null), null)
  })
})

describe('attemptStrip', () => {
  test('skeleton-001 verify: two failures, the diagnosis and the repair where they happened, then the pass, each with its result', () => {
    const strip = attemptStrip(skeleton.detail, timelineOf(skeleton), 'verify_game')
    assert.deepEqual(describeStrip(strip), ['#1 failed', '#2 failed', 'diagnosis', 'repair', '#3 succeeded'])
    const chips = strip.flatMap(item => (item.kind === 'attempt' ? [item.chip] : []))
    assert.deepEqual(chips.map(chip => chip.uris), [1, 2, 3].map(k => [`/api/projects/project-b/workflows/skeleton/runs/skeleton-001/results/game/${k}`]))
    assert.deepEqual(chips.map(chip => formatSpan(chip.ms!)), ['1m07s', '1m07s', '1m15s'])
    const repair = strip.find(item => item.kind === 'repair')!
    assert.equal(repair.kind === 'repair' && repair.label, 'repair 1')
  })

  test('a step with one attempt has no strip', () => {
    assert.deepEqual(attemptStrip(skeleton.detail, timelineOf(skeleton), 'launch_game'), [])
    assert.deepEqual(attemptStrip(skeleton.detail, timelineOf(skeleton), 'approval'), [])
  })

  test('the design challenge: three attempts with no result to link', () => {
    const strip = attemptStrip(skeleton.detail, timelineOf(skeleton), 'challenge')
    assert.deepEqual(describeStrip(strip), ['#1 no_record', '#2 failed', '#3 succeeded'])
    assert.ok(strip.every(item => item.kind !== 'attempt' || item.chip.uris.length === 0))
  })

  test('workflow-guardrails-001 candidate: one chip per attempt, carrying each lane result of that attempt', () => {
    // Before B1 a candidate row names no lane; the timeline matches it to a lane through the loaded lane results, which
    // the run page reads for a run of two lanes (`nowResultUris`).
    const strip = attemptStrip(guardrails.detail, buildTimeline(guardrails), 'candidate')
    const chips = strip.flatMap(item => (item.kind === 'attempt' ? [item.chip] : []))
    assert.deepEqual(chips.map(chip => [chip.attempt, chip.status]), [[1, 'failed'], [2, 'failed']])
    const base = '/api/projects/md-manager/workflows/workflow-guardrails/runs/workflow-guardrails-001/results'
    assert.deepEqual(chips[0].uris.sort(), [`${base}/candidate_controller/1`, `${base}/candidate_ui/1`])
    assert.deepEqual(chips[1].uris, [`${base}/candidate_ui/2`])
  })
})

describe('resultRole: dedup by result_uri', () => {
  test('launch and verify share results/game/3: the facts on verify, the narrative on launch', () => {
    assert.deepEqual(resultRole(skeleton.detail, 'verify_game'), { facts: true, narrative: false, partner: 'launch_game' })
    assert.deepEqual(resultRole(skeleton.detail, 'launch_game'), { facts: false, narrative: true, partner: 'verify_game' })
  })

  test('a node whose result no other node shows keeps both', () => {
    const detail = structuredClone(skeleton.detail)
    detail.snapshot.nodes.find(node => node.node_id === 'launch_game')!.result_uri = null
    assert.deepEqual(resultRole(detail, 'verify_game'), { facts: true, narrative: true, partner: null })
  })
})
