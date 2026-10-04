import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  validateReviewResult,
  validateRunDetail,
  validateRunInputs,
  type ReviewResult,
  type RunDetail,
  type RunInputs,
} from '../../contracts/projects/v1.ts'
import { eventSchema, validateWorkerResult, type WorkerResult, type WorkflowEvent } from '../../contracts/workflow/v1.ts'
import {
  attemptResultUris,
  buildTimeline,
  controllerNotRunning,
  deriveAttention,
  deriveFocus,
  deriveNow,
  gateReasonsByCheck,
  humanizeEvent,
  laneLines,
  nowResultUris,
  textToString,
  type Now,
  type RunData,
  type Span,
  type Step,
} from '../../contracts/projects/triage.ts'
import { uxSidecar, RUN_SIDECAR, RUN_SIDECAR_BLOCKED, RUN_SIDECAR_FROZEN, RUN_SIDECAR_ONE_LANE, SIDECAR_TWINS } from '../project-workflows/fixtures/ux-sidecar.ts'

const sidecarPayloads = uxSidecar.payloads!

/**
 * The triage model (PRD_VIEWER_UX 5 and 6) on the captured skeleton-001 (blocked by review), skeleton-fixes-001
 * (succeeded) and workflow-guardrails-001 (two lanes, candidate failed identically) payloads, trimmed to what these
 * tests read and validated against the contracts, plus synthetic runs for situations no captured run reached. Results
 * the capture did not include (skeleton-001 game/1, guardrails controller/1 and candidate_ui/1) are derived below from
 * a captured sibling and the event that recorded their verdict, and are marked as such.
 */

const ROOT = new URL('../../', import.meta.url)

type Bundle = { detail: RunDetail; events: WorkflowEvent[]; inputs: RunInputs; review: ReviewResult | null; results: Map<string, WorkerResult> }

function loadRun(name: string): Bundle {
  const raw = JSON.parse(readFileSync(new URL(`tests/unit/fixtures/runs/${name}.json`, ROOT), 'utf8')) as {
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
const fixes = loadRun('skeleton-fixes-001')
const guardrails = loadRun('workflow-guardrails-001')

const SKELETON_RUN = '/api/projects/project-b/workflows/skeleton/runs/skeleton-001'
const GUARDRAILS_RUN = '/api/projects/md-manager/workflows/workflow-guardrails/runs/workflow-guardrails-001'

const seconds = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 1000)
const spanSeconds = (span: Span | undefined) => span?.ms === null || span?.ms === undefined ? null : Math.round(span.ms / 1000)
const eventAt = (bundle: Bundle, sequence: number) => bundle.events.find(event => event.sequence === sequence)!

function shiftChecks(result: WorkerResult, lastFinish: string): WorkerResult['checks'] {
  const offset = Date.parse(lastFinish) - Date.parse(result.checks.at(-1)!.finished_at)
  const move = (iso: string) => new Date(Date.parse(iso) + offset).toISOString()
  return result.checks.map(check => ({ ...check, started_at: move(check.started_at), finished_at: move(check.finished_at) }))
}

/** skeleton-001 results/game/1: served (HTTP 200) but not captured; its gate reasons are the ones event #14 recorded. */
const skeletonGame1 = validateWorkerResult({
  ...skeleton.results.get(`${SKELETON_RUN}/results/game/3`)!,
  attempt: 1, status: 'failed', error: { code: 'VERIFICATION_BLOCKED', message: eventAt(skeleton, 14).message, retryable: true },
})
/** guardrails results/controller/1: not captured; its gate reasons are the ones event #23 recorded. */
const guardrailsController1 = validateWorkerResult({
  ...guardrails.results.get(`${GUARDRAILS_RUN}/results/controller/2`)!,
  attempt: 1, status: 'failed', error: { code: 'VERIFICATION_BLOCKED', message: eventAt(guardrails, 23).message, retryable: true },
})
/** guardrails candidate_ui/1: not captured; it failed identically to /2 (RUNBOOK "Blocked after freeze"), its checks ending before event #28. */
const candidateUi2 = guardrails.results.get(`${GUARDRAILS_RUN}/results/candidate_ui/2`)!
const guardrailsCandidateUi1 = validateWorkerResult({ ...candidateUi2, attempt: 1, checks: shiftChecks(candidateUi2, '2026-09-23T20:24:50.300000Z') })

function runData(bundle: Bundle, extra: Record<string, WorkerResult> = {}): RunData {
  return { detail: bundle.detail, events: bundle.events, inputs: bundle.inputs, review: bundle.review, results: new Map([...bundle.results, ...Object.entries(extra)]) }
}

const guardrailsFull = () => runData(guardrails, { [`${GUARDRAILS_RUN}/results/candidate_ui/1`]: guardrailsCandidateUi1 })

// ---- Synthetic single-lane runs on the skeleton-001 definition ------------------------------------------------------

const T0 = Date.parse('2026-09-24T10:00:00Z')
const t = (second: number) => new Date(T0 + second * 1000).toISOString()

type NodeState = NodeStatusName | [NodeStatusName, number]
type NodeStatusName = RunDetail['snapshot']['status']
type EventSpec = [second: number, node: string | null, status: NodeStatusName | null, message: string]

function synthetic(options: {
  status: NodeStatusName
  nodes: Record<string, NodeState>
  events: EventSpec[]
  inputs?: (inputs: RunInputs) => void
  review?: ReviewResult | null
  results?: Record<string, WorkerResult>
  /** The captured run whose definition and inputs it starts from (skeleton-001 by default). */
  base?: Bundle
}): RunData {
  const from = options.base ?? skeleton
  const base = from.detail
  const runId = base.summary.run_id
  const last = options.events.length ? Math.max(...options.events.map(([second]) => second)) : 0
  const summary = { ...base.summary, status: options.status, created_at: t(-60), updated_at: t(last + 1) }
  const nodes = base.snapshot.nodes.map(node => {
    const state = options.nodes[node.node_id] ?? 'pending'
    const [status, attempt] = Array.isArray(state) ? state : [state, state === 'pending' ? 0 : 1]
    return { ...node, status, attempt, session_id: null, result_uri: null, lane_results: [] }
  })
  const detail = validateRunDetail({ summary, definition: base.definition, snapshot: { ...base.snapshot, status: options.status, last_sequence: options.events.length, nodes } })
  const attempts = new Map<string, number>()
  const events = options.events.map(([second, node, status, message], index) => {
    const parsed = /\bAttempt (\d+)\b/.exec(message)
    if (node && parsed) attempts.set(node, Number(parsed[1]))
    return eventSchema.parse({
      contract_version: '1.0.0', run_id: runId, event_id: `${runId}:${index + 1}`, sequence: index + 1, occurred_at: t(second),
      node_id: node, attempt: node ? attempts.get(node) ?? 1 : 0, type: status ? 'status_changed' : 'log', status, message,
      artifact: null, result_uri: null, reused_from_attempt: null,
    })
  })
  const inputs = structuredClone(from.inputs)
  for (const worker of inputs.workers) {
    worker.launch = { ...worker.launch!, launch_requested_at: t(-2), native_started_at: t(0) }
    worker.stop = null
    worker.completion = null
    worker.handoff = null
  }
  options.inputs?.(inputs)
  return { detail, events, inputs: validateRunInputs(inputs), review: options.review ?? null, results: new Map(Object.entries(options.results ?? {})) }
}

type LaneResult = RunDetail['snapshot']['nodes'][number]['lane_results'][number]

/**
 * A captured run as the server served it right after event `last`: its events up to there, and the node states the
 * server's projection gives at that point (a task keeps its graph error, and so its node and the run read `failed`,
 * until the step that re-enters it ends).
 */
function servedAt(bundle: Bundle, last: number, status: NodeStatusName, states: Record<string, NodeState>,
  extra: { laneResults?: LaneResult[]; results?: Record<string, WorkerResult>; events?: WorkflowEvent[] } = {}): RunData {
  const base = bundle.detail
  const events = [...bundle.events.filter(event => event.sequence <= last), ...extra.events ?? []]
  const nodes = base.snapshot.nodes.map(node => {
    const state = states[node.node_id] ?? 'pending'
    const [nodeStatus, attempt] = Array.isArray(state) ? state : [state, state === 'pending' ? 0 : 1]
    const pending = nodeStatus === 'pending'
    return { ...node, status: nodeStatus, attempt, session_id: pending ? null : node.session_id, result_uri: pending ? null : node.result_uri,
      lane_results: node.node_id === 'candidate' && !pending ? extra.laneResults ?? [] : [] }
  })
  const detail = validateRunDetail({ summary: { ...base.summary, status, updated_at: events.at(-1)!.occurred_at }, definition: base.definition,
    snapshot: { ...base.snapshot, status, last_sequence: events.at(-1)!.sequence, nodes } })
  return { detail, events, inputs: bundle.inputs, review: null, results: new Map(Object.entries(extra.results ?? {})) }
}

/** A later copy of a captured event (a PID checkpoint, say) at another sequence and time. */
function laterEvent(bundle: Bundle, like: number, sequence: number, at: string, change: Partial<WorkflowEvent> = {}): WorkflowEvent {
  return eventSchema.parse({ ...eventAt(bundle, like), sequence, event_id: `${bundle.detail.summary.run_id}:${sequence}`, occurred_at: at, ...change })
}

const GAME_1 = `${SKELETON_RUN}/results/game/1`
const BEFORE_VERIFY: Record<string, NodeState> = { challenge: ['succeeded', 3], launch_game: 'succeeded', handoff: 'succeeded' }
/** skeleton-001 as served between #14 (attempt 1 failed) and #15: the supervisor has not started the retry yet. */
const skeletonFailedOnce = () => servedAt(skeleton, 14, 'failed', { ...BEFORE_VERIFY, verify_game: 'failed' }, { results: { [GAME_1]: skeletonGame1 } })
/** skeleton-001 as served between #16 ("Attempt 2" running) and #17: results/game/2 does not exist until the attempt ends. */
const skeletonRetrying = () => servedAt(skeleton, 16, 'failed', { ...BEFORE_VERIFY, verify_game: ['failed', 2] }, { results: { [GAME_1]: skeletonGame1 } })

/** A Claude Code outage as sessions.py:272 words it. */
const OUTAGE = "Claude Code unavailable for 60s ([Errno 2] No such file or directory: 'claude'); an update may be replacing it."

const LAUNCHED: EventSpec[] = [
  [0, 'launch_game', 'running', 'Launching or reconciling the exact native session'],
  [3, 'launch_game', 'running', 'Awaiting explicit completion signal; idle is not acceptance'],
  [5, null, null, 'Automatic checkpoint controller PID 4242'],
]
const WORKING = { challenge: 'succeeded', launch_game: 'running' } as const

// ---- Assertions shared by every deriveNow case ------------------------------------------------------------------

const commands = (now: Now) => now.next.steps.filter((step): step is Extract<Step, { kind: 'command' }> => step.kind === 'command').map(step => step.text)
const prose = (now: Now) => [textToString(now.headline, T0), textToString(now.reason, T0), now.next.label, now.next.caveat ?? '',
  ...now.next.steps.map(step => step.kind === 'text' ? step.text : step.caption ?? '')].join('\n')

const PYTHON = (file: string) => readFileSync(new URL(`workflow/${file}`, ROOT), 'utf8')
function body(source: string, header: string): string {
  const start = source.indexOf(header)
  assert.ok(start >= 0, `${header} exists`)
  const end = source.indexOf('\ndef ', start + header.length)
  return source.slice(start, end < 0 ? undefined : end)
}
const PIPELINE = body(PYTHON('pipeline.py'), 'def main(')
/** Where each verb's argparse lives (workflow/__main__.py dispatches launch, init, resume, answer and repair). */
const CLI: Record<string, string> = {
  launch: body(PYTHON('launch.py'), 'def main('),
  init: body(PYTHON('scaffold.py'), 'def main('),
  resume: body(PYTHON('guardrails.py'), 'def resume_main('),
  answer: body(PYTHON('guardrails.py'), 'def answer_main('),
  repair: body(PYTHON('repair.py'), 'def repair_main('),
  'attach-one': body(PYTHON('interactive.py'), 'def main('),
}

/** Every command is the RUNBOOK form `"$PY" -m workflow[.interactive] <verb> ...`, and each verb and flag exists in that verb's argparse. */
function assertRealCli(now: Now) {
  for (const command of commands(now)) {
    const tokens = command.match(/"[^"]*"|\S+/g)!
    assert.equal(tokens[0], '"$PY"', command)
    assert.equal(tokens[1], '-m', command)
    const verb = tokens[3]
    const parser = CLI[verb] ?? PIPELINE
    assert.equal(tokens[2], verb === 'attach-one' ? 'workflow.interactive' : 'workflow', command)
    assert.ok(parser.includes(verb === 'attach-one' ? '"attach-one"' : CLI[verb] ? 'argparse' : `"${verb}"`), `${verb} is a CLI action (${command})`)
    // --by (C17) is declared by actor.add_actor_argument on every gate's parser.
    for (const flag of tokens.filter(token => token.startsWith('--'))) {
      assert.ok(parser.includes(flag === '--by' ? 'add_actor_argument(parser)' : `add_argument("${flag}"`), `${verb} takes ${flag} (${command})`)
    }
    if (['start', 'automatic', 'retry', 'reconcile', 'approve', 'resume', 'answer', 'repair', 'launch'].includes(verb)) {
      assert.ok(command.endsWith(' --by operator') || command.includes(' --by operator '), `a gate command names the operator (${command})`)
    }
    if (tokens.includes('"$RUN"')) assert.equal(tokens[4], '"$RUN"', `the run directory follows the verb (${command})`)
  }
}

const RUNBOOK = readFileSync(new URL('workflow/RUNBOOK.md', ROOT), 'utf8').split('\n')
function assertRunbook(now: Now) {
  assert.ok(now.next.runbook.length > 0 || ['running', 'inactive'].includes(now.situation), 'names its RUNBOOK section')
  for (const ref of now.next.runbook) {
    const start = RUNBOOK.findIndex(line => /^#{1,4} /.test(line) && line.replace(/^#+ /, '') === ref.section)
    assert.ok(start >= 0, `RUNBOOK has the section "${ref.section}"`)
    const level = RUNBOOK[start].indexOf(' ')
    const next = RUNBOOK.findIndex((line, index) => index > start && /^#{1,4} /.test(line) && line.indexOf(' ') <= level)
    if (ref.topic) assert.ok(RUNBOOK.slice(start, next < 0 ? undefined : next).join('\n').includes(`**${ref.topic}`), `"${ref.section}" has the topic "${ref.topic}"`)
  }
}

function checked(run: Parameters<typeof deriveNow>[0]): Now {
  const now = deriveNow(run)
  assertRealCli(now)
  assertRunbook(now)
  assert.ok(commands(now).every(command => !/git push|\bmerge\b/.test(command)), 'never a push or merge command')
  return now
}

// ---- buildTimeline -----------------------------------------------------------------------------------------------

describe('buildTimeline', () => {
  const timeline = buildTimeline(runData(skeleton))

  it('re-reads challenge attempts 1-3 from the messages; attempt 1 ended without a record', () => {
    const challenge = timeline.byNode.get('challenge') ?? []
    assert.deepEqual(challenge.map(span => [span.attempt, span.status]), [[1, 'no_record'], [2, 'failed'], [3, 'succeeded']])
    assert.deepEqual(challenge.map(spanSeconds), [seconds(eventAt(skeleton, 1).occurred_at, eventAt(skeleton, 2).occurred_at), 47, 149])
    assert.equal(spanSeconds(challenge[0]), 373)
    assert.match(challenge[1].outcome, /interrupted \(KeyboardInterrupt\)/)
  })

  it('spans the worker from its launch and stop receipts: 28m21s', () => {
    const [worker] = timeline.byNode.get('launch_game') ?? []
    assert.equal(worker.start?.source, 'receipt')
    assert.equal(worker.end?.source, 'receipt')
    assert.equal(worker.start?.at, '2026-09-24T08:50:52.345Z')
    assert.equal(spanSeconds(worker), 28 * 60 + 21)
    assert.equal(worker.live, false)
  })

  it('times the verify attempts 1m07s, 1m07s and 1m15s, attempt 3 split into setup 42s and checks 33s', () => {
    const verify = timeline.byNode.get('verify_game') ?? []
    assert.deepEqual(verify.map(span => [span.attempt, span.status, spanSeconds(span)]), [[1, 'failed', 67], [2, 'failed', 67], [3, 'succeeded', 75]])
    assert.equal(verify[2].result_uri, `${SKELETON_RUN}/results/game/3`)
    assert.deepEqual(verify[2].split && [Math.round(verify[2].split.setup_ms / 1000), Math.round(verify[2].split.checks_ms / 1000)], [42, 33])
  })

  it('turns the node-less diagnosis and repair rows into markers, with the 5m37s of operator time between them', () => {
    const diagnosis = timeline.markers.find(marker => marker.kind === 'diagnosis')
    assert.equal(diagnosis?.lane, 'game')
    assert.equal(diagnosis?.node_id, 'verify_game')
    assert.equal(diagnosis?.at, eventAt(skeleton, 19).occurred_at)
    const repair = timeline.markers.find(marker => marker.kind === 'repair')
    assert.deepEqual(repair?.repair, { n: 1, snapshot: '50b14b3c', files: ['tests/reporters/testSummary.ts', 'tests/unit/testSummary.test.ts', 'vitest.config.ts'] })
    assert.equal(repair?.node_id, 'verify_game')
    const operator = timeline.gaps.filter(gap => gap.kind === 'operator')
    assert.deepEqual(operator.map(gap => [gap.from, Math.round(gap.ms / 1000)]), [[diagnosis?.at, 5 * 60 + 37]])
    assert.ok(timeline.activity.some(row => row.kind === 'gap' && row.gap?.kind === 'operator'), 'the gap is an Activity row')
    assert.ok(timeline.markers.every(marker => marker.kind !== 'controller_blocked'), 'the diagnosis is not also a second blocked marker')
  })

  it('infers the print-transport review start from the candidate: ≈2m10s', () => {
    const [review] = timeline.byNode.get('review') ?? []
    assert.equal(review.start?.source, 'inferred')
    assert.equal(review.start?.at, eventAt(skeleton, 25).occurred_at)
    assert.equal(review.end?.source, 'review')
    assert.equal(spanSeconds(review), 130)
    assert.equal(review.status, 'failed')
    const [candidate] = timeline.byNode.get('candidate') ?? []
    assert.equal(candidate.start?.source, 'inferred')
    assert.equal(spanSeconds(candidate), 66)
    assert.deepEqual(timeline.byNode.get('handoff')?.map(span => [span.status, span.ms]), [['succeeded', 0]])
    assert.equal(timeline.byNode.get('approval'), undefined, 'a step that never ran has no span')
  })

  it('spans the run from creation to the last non-controller activity: 52m51s ending 09:32:31, not updated_at', () => {
    assert.equal(timeline.runEnd?.at, skeleton.review!.reviewed_at)
    assert.equal(timeline.runEnd?.source, 'review')
    assert.equal(seconds(timeline.runStart.at, timeline.runEnd!.at), 52 * 60 + 51)
    assert.notEqual(timeline.runEnd?.at, skeleton.detail.summary.updated_at)
    assert.equal(timeline.lastActivity?.at, skeleton.review!.reviewed_at)
  })

  it('lists Activity oldest first: an attempt that ended without a record gets its own row, the verdicts read as outcomes', () => {
    const challenge = timeline.activity.filter(row => row.node_id === 'challenge').slice(0, 3)
    assert.deepEqual(challenge.map(row => [row.kind, row.text]), [
      ['start', 'attempt 1 started (print job, session f18dee3c-424c-4e3e-9379-a7ad784c9e37)'],
      ['end', 'attempt 1 ended without a record'],
      ['start', 'attempt 2 started after re-pinning the feature files (base 313eb87)'],
    ])
    assert.equal(Math.round(challenge[1].ms! / 1000), 373)
    const review = timeline.activity.find(row => row.node_id === 'review')
    assert.deepEqual([review?.kind, review?.source, review?.text, review?.inferred], ['end', 'review', 'blocked by general · 1 P1 · 3 P2', true])
    const tail = buildTimeline(runData(fixes)).activity.slice(-3).map(row => [row.node_id, row.text])
    assert.deepEqual(tail, [
      ['review', 'approved by general and coverage · 3 P2'],
      ['approval', 'approved · no approval event recorded'],
      ['integrate', 'fast-forwarded to ee74298 · no push performed'],
    ])
    assert.ok(timeline.activity.every((row, index, rows) => index === 0 || Date.parse(rows[index - 1].at) <= Date.parse(row.at)))
  })

  it('keeps PID checkpoints in the controller log, never as a running node', () => {
    const pid = timeline.activity.filter(row => row.controller_log)
    assert.equal(pid.length, 5)
    assert.ok(pid.every(row => row.marker === 'controller_start' && row.node_id === null))
  })

  describe('guardrails (two lanes, a lane named controller)', () => {
    const run = buildTimeline(guardrailsFull())

    it('turns PID and [Errno] rows aliased onto launch_controller into controller markers, never a node running or failed', () => {
      assert.equal(run.markers.filter(marker => marker.kind === 'controller_start').length, 8)
      assert.equal(run.markers.filter(marker => marker.kind === 'controller_error').length, 8, 'four [Errno] rows and their four stop failures')
      assert.deepEqual(run.byNode.get('launch_controller')?.map(span => [span.status, span.start?.source]), [['succeeded', 'receipt']])
      assert.deepEqual(run.byNode.get('handoff')?.map(span => span.status), ['succeeded'])
      assert.ok(run.markers.filter(marker => marker.kind === 'controller_start').every(marker => marker.run_level))
    })

    it('marks the two controller outages as controller-down gaps: 4m56s and 6m35s', () => {
      assert.deepEqual(run.gaps.filter(gap => gap.kind === 'controller_down').map(gap => Math.round(gap.ms / 1000)), [4 * 60 + 56, 6 * 60 + 35])
      const outage = run.gaps.find(gap => gap.kind === 'controller_down')!
      assert.deepEqual(outage.lanes, ['controller', 'ui'], 'drawn over both running workers')
      assert.ok(run.gaps.some(gap => gap.kind === 'waiting_worker'))
    })

    it('runs the lanes in parallel', () => {
      const [controller] = run.byNode.get('launch_controller')!
      const [ui] = run.byNode.get('launch_ui')!
      assert.ok(Date.parse(controller.start!.at) < Date.parse(ui.end!.at) && Date.parse(ui.start!.at) < Date.parse(controller.end!.at))
      assert.deepEqual(run.byNode.get('verify_controller')?.map(span => [span.attempt, span.status]), [[1, 'failed'], [2, 'succeeded']])
      const [verifyUi] = run.byNode.get('verify_ui')!
      assert.ok(Date.parse(verifyUi.start!.at) < Date.parse(run.byNode.get('verify_controller')![0].end!.at))
    })

    it('matches candidate failures #28 and #31 to lane ui by check times', () => {
      const candidate = run.byNode.get('candidate') ?? []
      const failed = candidate.filter(span => span.status === 'failed')
      assert.deepEqual(failed.map(span => [span.lane, span.attempt, span.end?.at]),
        [['ui', 1, eventAt(guardrails, 28).occurred_at], ['ui', 2, eventAt(guardrails, 31).occurred_at]])
      assert.deepEqual(failed.map(span => span.result_uri), [`${GUARDRAILS_RUN}/results/candidate_ui/1`, `${GUARDRAILS_RUN}/results/candidate_ui/2`])
      assert.deepEqual(candidate.filter(span => span.status === 'succeeded').map(span => [span.lane, span.attempt]), [['controller', 1]], '#30 restates the reused controller lane')
      assert.equal(run.runEnd?.at, eventAt(guardrails, 31).occurred_at, 'the trailing PID row is controller activity')
    })

    /**
     * The run as pipeline.py records a candidate verdict now: a second `[<lane>] Candidate gate …` row right after it, with
     * the verdict's status. Here after #28 and #31 (ui blocked), and, only to exercise a passing note, after #30 (the
     * captured controller lane passed at once). Sequences are renumbered; nothing else changes.
     */
    function withGateNotes(bundle: RunData): RunData {
      const notes: Record<number, string> = {
        28: '[ui] Candidate gate blocked on attempt 1: Executed check failed: project-workflows-browser',
        30: '[controller] Candidate gate passed on attempt 2 after attempt 1 failed',
        31: '[ui] Candidate gate blocked on attempt 2: Executed check failed: project-workflows-browser',
      }
      const events: WorkflowEvent[] = []
      const add = (event: WorkflowEvent, changes: Partial<WorkflowEvent> = {}) => {
        const sequence = events.length + 1
        events.push(eventSchema.parse({ ...event, ...changes, sequence, event_id: `${event.run_id}:${sequence}` }))
      }
      for (const event of bundle.events) {
        add(event)
        const note = notes[event.sequence]
        if (note) add(event, { message: note, occurred_at: new Date(Date.parse(event.occurred_at) + 5).toISOString() })
      }
      return { ...bundle, events, detail: { ...bundle.detail, snapshot: { ...bundle.detail.snapshot, last_sequence: events.length } } }
    }
    const lanesOf = (timeline: ReturnType<typeof buildTimeline>) =>
      (timeline.byNode.get('candidate') ?? []).map(span => [span.lane, span.attempt, span.status, span.result_uri])

    it('reads the candidate gate notes as notes: never a verdict, never a reused lane result, no span, with results or without', () => {
      const noted = buildTimeline(withGateNotes(guardrailsFull()))
      assert.deepEqual(lanesOf(noted), lanesOf(run))
      const rows = noted.activity.filter(row => row.raw?.includes('Candidate gate '))
      assert.deepEqual(rows.map(row => [row.kind, row.status, row.text]), [
        ['update', 'failed', 'gate blocked on attempt 1: Executed check failed: project-workflows-browser'],
        ['update', 'succeeded', 'gate passed on attempt 2 after attempt 1 failed'],
        ['update', 'failed', 'gate blocked on attempt 2: Executed check failed: project-workflows-browser'],
      ])
      // Without the results (the server's run list, a poll before they load, a result that is missing) each verdict still
      // opens one span and each note none: the steps keep their attempt counts.
      const bare = (bundle: RunData) => buildTimeline({ ...bundle, results: new Map() })
      assert.equal(lanesOf(bare(withGateNotes(guardrailsFull()))).length, lanesOf(bare(guardrailsFull())).length)
      assert.equal(lanesOf(bare(guardrailsFull())).length, 4)
    })
  })

  it('reads controller_blocked from node-less rows: B1 status failed, and before B1 by the message rule', () => {
    const rows = (status: NodeStatusName | null) => synthetic({
      status: 'failed', nodes: { challenge: 'succeeded', launch_game: 'running', handoff: 'failed' },
      events: [...LAUNCHED, [60, null, status, 'Worker game deadline exhausted; no automatic relaunch'], [61, null, null, 'Rerunning verify:game at the attempt retry raised']],
    })
    for (const status of ['failed', null] as const) {
      const markers = buildTimeline(rows(status)).markers
      assert.deepEqual(markers.filter(marker => marker.blocked).map(marker => [marker.kind, marker.raw]),
        [['controller_blocked', 'Worker game deadline exhausted; no automatic relaunch']], `status ${status}`)
      assert.equal(markers.find(marker => marker.raw.startsWith('Rerunning'))?.kind, 'log')
    }
  })

  it('reads who ran a gate action (C17) as a log row, never a blocked controller, before B1 too', () => {
    const rows = (status: NodeStatusName | null) => synthetic({
      status: 'running', nodes: { challenge: 'succeeded', launch_game: 'running' },
      events: [...LAUNCHED, [60, null, status, 'Automatic by the maintainer (via a Claude Code session): the supervisor continues the run'],
        [61, null, status, 'Retry by the operator: worker/game attempt 2']],
    })
    for (const status of ['running', null] as const) {
      const markers = buildTimeline(rows(status)).markers.filter(marker => / by the (operator|maintainer)/.test(marker.raw))
      assert.deepEqual(markers.map(marker => [marker.kind, marker.blocked]), [['log', false], ['log', false]], `status ${status}`)
    }
  })

  it('keeps a retried attempt running while the export still serves its node failed; a later controller start ends it', () => {
    const retrying = buildTimeline(skeletonRetrying())
    assert.deepEqual(retrying.byNode.get('verify_game')?.map(span => [span.attempt, span.status, span.end === null, span.live]),
      [[1, 'failed', false, false], [2, 'running', true, true]])
    // A later checkpoint controller means the process that ran attempt 2 exited: it ended, and failed without a verdict row.
    const exited = servedAt(skeleton, 16, 'failed', { ...BEFORE_VERIFY, verify_game: ['failed', 2] }, { events: [laterEvent(skeleton, 15, 17, '2026-09-24T09:22:00Z')] })
    assert.deepEqual(buildTimeline(exited).byNode.get('verify_game')?.map(span => [span.attempt, span.status, span.live]), [[1, 'failed', false], [2, 'failed', false]])
  })

  it('is memoized on the served state: an identical poll returns the same timeline, a new event rebuilds it', () => {
    const first = runData(skeleton)
    const again = buildTimeline({ ...first, detail: structuredClone(first.detail), events: [...first.events] })
    assert.equal(buildTimeline(first), again)
    const more = { ...first, detail: { ...first.detail, snapshot: { ...first.detail.snapshot, last_sequence: 27 } }, events: [...first.events, { ...first.events[25], sequence: 27, event_id: 'skeleton-001:27' }] }
    assert.notEqual(buildTimeline(more), again)
  })
})

// ---- deriveNow: one case per data-situation ------------------------------------------------------------------------

describe('deriveNow', () => {
  it('review_blocked', () => {
    const now = checked(runData(skeleton))
    assert.equal(now.situation, 'review_blocked')
    assert.equal(now.focus?.node_id, 'review')
    assert.equal(now.reasonSource, 1)
    assert.match(textToString(now.headline, T0), /^✗ Blocked by review at Independent review · 09:32 .*did not complete/)
    const reason = textToString(now.reason, T0)
    assert.match(reason, /general blocked the candidate: 1 open P1 — Private matches can be joined without their code\./)
    assert.match(reason, /coverage was superseded \(no verdict\)/)
    assert.deepEqual(now.next.steps.map(step => step.kind), ['command', 'text', 'command'])
    assert.deepEqual(commands(now), [
      '"$PY" -m workflow init <fixes-feature> --repo <target repo>',
      '"$PY" -m workflow launch <fixes-feature> --repo <target repo> --live --automatic --by operator',
    ])
    assert.match((now.next.steps[1] as { text: string }).text, /\/workflow-grill <fixes-feature>.*decisions\.md.*commit/)
    const everything = JSON.stringify(now.next)
    for (const invented of ['skeleton', 'Pirate', 'skeleton-001', '<run id>']) assert.ok(!everything.includes(invented), `no concrete ${invented}`)
  })

  it('review_blocked: the reviewer that blocked is named first, whatever the declared order (S3)', () => {
    // A feature can declare the superseded reviewer first (reviewers-flow: general, then coverage, which blocked).
    const review = { ...skeleton.review!, reviewers: [...skeleton.review!.reviewers].reverse() }
    assert.deepEqual(review.reviewers.map(entry => entry.status), ['superseded', 'blocked'])
    const reason = textToString(checked({ ...runData(skeleton), review }).reason, T0)
    assert.match(reason, /^general blocked the candidate: 1 open P1 — .*\. coverage was superseded \(no verdict\)\.$/)
  })

  it('blocked_identical', () => {
    const now = checked(guardrailsFull())
    assert.equal(now.situation, 'blocked_identical')
    assert.equal(now.lane, 'ui')
    assert.equal(now.focus?.node_id, 'candidate')
    assert.equal(buildTimeline(guardrailsFull()).markers.filter(marker => marker.kind === 'diagnosis').length, 0, 'guardrails has no diagnosis event')
    assert.match(textToString(now.headline, T0), /^✗ Blocked at Verify combined candidate · lane ui failed identically on attempts 1 and 2 · 20:27/)
    assert.match(textToString(now.reason, T0), /project-workflows-browser/)
    assert.deepEqual(commands(now), [
      '"$PY" -m workflow repair "$RUN" ui --workspace --by operator',
      '"$PY" -m workflow repair "$RUN" ui --commit <sha> --reason "<why>" --dry-run --by operator',
      '"$PY" -m workflow repair "$RUN" ui --commit <sha> --reason "<why>" --by operator',
      '"$PY" -m workflow automatic "$RUN" --live --by operator',
    ])
    assert.match((now.next.steps[1] as { text: string }).text, /\$RUN\/repair-workspace-<n>.*never on the source branch/)
    assert.doesNotMatch(prose(now), /[Ii]nterrupted|Claude Code|retry/, 'the four stale [Errno] rows are out of scope')
    assert.deepEqual(now.missing, [])
    const partial = deriveNow(runData(guardrails))
    assert.deepEqual(partial.missing, [`${GUARDRAILS_RUN}/results/candidate_ui/1`], 'names the result it still needs')
  })

  describe('blocked_identical needs one revision, as advance_failed_checks does (same_revision)', () => {
    const OLD = '5c1a734e71c3312a8d9174f50951e27fcd26d0b7'
    const NEW = '50b14b3c766005cf076331e8e8a59261cf90d16b'
    const gate = eventAt(skeleton, 14).message
    const result = (attempt: number, revision: string) => validateWorkerResult({ ...skeletonGame1, attempt, output_commit: revision })
    const uri = (attempt: number) => `${SKELETON_RUN}/results/game/${attempt}`
    const twice = (second: string, mode: 'automatic' | 'manual' = 'automatic') => synthetic({
      status: 'failed', nodes: { ...BEFORE_VERIFY, verify_game: ['failed', 2] },
      events: [[0, 'verify_game', 'running', `Attempt 1; revision ${OLD}`], [60, 'verify_game', 'failed', gate],
        [62, null, null, 'Automatic checkpoint controller PID 5151'], [62, 'verify_game', 'running', `Attempt 2; revision ${second}`], [120, 'verify_game', 'failed', gate]],
      results: { [uri(1)]: result(1, OLD), [uri(2)]: result(2, second) },
      inputs: inputs => { if (mode === 'manual') { inputs.mode = 'manual'; inputs.automatic = null } },
    })

    it('two failures with one reason on one revision are identical, without a diagnosis row', () => {
      const now = checked(twice(OLD))
      assert.equal(now.situation, 'blocked_identical')
      assert.match(textToString(now.headline, T0), /lane game failed identically on attempts 1 and 2/)
    })

    it('the same reason on another revision is not', () => {
      assert.equal(checked(twice(NEW)).situation, 'check_failed')
    })

    it('attempts on either side of a repair are not: attempt 3 is attempt 1 of 3 on the repaired revision', () => {
      const repaired = (mode: 'automatic' | 'manual') => synthetic({
        status: 'failed', nodes: { ...BEFORE_VERIFY, verify_game: ['failed', 3] },
        events: [[0, 'verify_game', 'running', `Attempt 1; revision ${OLD}`], [60, 'verify_game', 'failed', gate],
          [62, null, null, 'Automatic checkpoint controller PID 5151'], [62, 'verify_game', 'running', `Attempt 2; revision ${OLD}`], [120, 'verify_game', 'failed', gate],
          [122, null, null, 'Automatic checkpoint controller PID 5152'],
          [122, null, null, 'worker/game failed identically on attempts 1 and 2; not transient, inspect <path> Before review a code fix is a lane repair (RUNBOOK)'],
          [400, 'verify_game', 'paused', 'Repair 1 by the operator: snapshot 50b14b3c = 5c1a734e + b27d726a on snapshot 5c1a734e (vitest.config.ts). Reason: Vitest summaries. Continue with python -m workflow automatic <path> --live'],
          [400, null, null, 'Repair 1 applied: checkpoint forked from 1f1b7f90 (after handoff); attempts worker:game 3'],
          [460, null, null, 'Automatic checkpoint controller PID 5153'], [460, 'verify_game', 'running', `Attempt 3; revision ${NEW}`], [520, 'verify_game', 'failed', gate]],
        results: { [uri(2)]: result(2, OLD), [uri(3)]: result(3, NEW) },
        inputs: inputs => { if (mode === 'manual') { inputs.mode = 'manual'; inputs.automatic = null } },
      })
      const automatic = checked(repaired('automatic'))
      assert.equal(automatic.situation, 'check_failed')
      assert.match(textToString(automatic.headline, T0), /^✗ Verify game failed attempt 1 of 3: unit, integration — /)
      assert.deepEqual(commands(automatic), [], 'the supervisor retries by itself')
      assert.deepEqual(commands(checked(repaired('manual'))), ['"$PY" -m workflow retry "$RUN" --phase worker --node game --by operator'])
      const withoutAttempt2 = deriveNow({ ...repaired('automatic'), results: new Map([[uri(3), result(3, NEW)]]) })
      assert.deepEqual(withoutAttempt2.missing, [], 'attempt 2 checked another revision, so it is not read')
    })
  })

  it('succeeded', () => {
    const now = checked(runData(fixes))
    assert.equal(now.situation, 'succeeded')
    assert.equal(now.next.action, 'none')
    assert.deepEqual(now.next.steps, [], 'no command')
    assert.match(now.next.label, /Merging or pushing is your decision/)
    assert.equal(textToString(now.headline, T0),
      '✓ Integrated ee74298 into feature/skeleton-fixes/skeleton-fixes-001 · no push performed · took 31m50s · review approved by general and coverage · 2 open P2')
  })

  it('question', () => {
    const now = checked(synthetic({
      status: 'running', nodes: WORKING,
      events: [...LAUNCHED, [600, 'launch_game', 'running', 'Worker game asked question 1 of 3; its deadline is paused until `python -m workflow answer <path> game "<text>"`: Keep the seed on rematch, or reroll it?']],
      inputs: inputs => { inputs.workers[0].questions = [{ n: 1, question: 'Keep the seed on rematch, or reroll it?', asked_at: t(600), answer: null, answered_at: null }] },
    }))
    assert.equal(now.situation, 'question')
    assert.equal(now.tone, 'waiting')
    assert.match(textToString(now.headline, T0 + 1200_000), /^\? Waiting on you: game asked question 1 of 3 · 10 min ago · deadline paused/)
    assert.match(textToString(now.reason, T0), /Keep the seed on rematch, or reroll it\?/)
    assert.deepEqual(commands(now), ['"$PY" -m workflow answer "$RUN" game "<your answer>" --by operator', '"$PY" -m workflow answer "$RUN" game "<your answer>" --by operator --no-herdr'])
    assert.match(now.next.caveat ?? '', /exits 1/)
  })

  it('question, from the event log when the export has not recorded it yet', () => {
    const now = deriveNow(synthetic({
      status: 'running', nodes: WORKING,
      events: [...LAUNCHED, [600, 'launch_game', 'running', 'Worker game asked question 2 of 3; its deadline is paused until `python -m workflow answer <path> game "<text>"`: Which map size?']],
    }))
    assert.equal(now.situation, 'question')
    assert.match(textToString(now.headline, T0), /game asked question 2 of 3/)
    assert.match(textToString(now.reason, T0), /Which map size\?.*from the event log; answered state not yet exported/)
  })

  it('pane_attention', () => {
    const pane: EventSpec = [900, 'launch_game', 'running', 'Worker game needs attention in its pane (native state blocked); waiting until its deadline']
    const now = checked(synthetic({ status: 'running', nodes: WORKING, events: [...LAUNCHED, pane] }))
    assert.equal(now.situation, 'pane_attention')
    assert.match(textToString(now.headline, T0), /^\? Waiting on you: game needs attention in its pane \(native state blocked\) · since 10:15/)
    assert.deepEqual(commands(now), ['"$PY" -m workflow.interactive attach-one "$RUN" --node game'])
    const later = deriveNow(synthetic({ status: 'running', nodes: WORKING, events: [...LAUNCHED, pane, [960, 'launch_game', 'running', 'Awaiting explicit completion signal; idle is not acceptance']] }))
    assert.equal(later.situation, 'running', 'a later event for the node clears it')
    // pipeline.py/notes.py send_note: a note's outcome row on the lane says nothing about the pane's state.
    for (const outcome of ['undeliverable, not typed (lane_blocked)', 'typed into its pane']) {
      const noted = deriveNow(synthetic({ status: 'running', nodes: WORKING, events: [...LAUNCHED, pane, [930, 'launch_game', 'running', `Note N-1 from the maintainer to worker game: ${outcome}`]] }))
      assert.equal(noted.situation, 'pane_attention', `a note row (${outcome}) does not clear the pane`)
    }
    const reviewer = deriveNow(synthetic({
      status: 'running', nodes: { challenge: 'succeeded', launch_game: 'succeeded', handoff: 'succeeded', verify_game: 'succeeded', candidate: 'succeeded', review: 'running' },
      events: [[0, 'review', 'running', 'Launching the native reviewer session general'], [60, 'review', 'running', 'Reviewer general needs attention in its pane (native state blocked); waiting until the deadline']],
    }))
    assert.deepEqual(commands(reviewer), ['"$PY" -m workflow.interactive attach-one "$RUN" --node review-general'])
  })

  it('interrupted (a): a run-level controller row after the latest launch event', () => {
    const now = checked(synthetic({
      status: 'paused', nodes: { ...WORKING, handoff: 'paused' },
      events: [...LAUNCHED, [1800, null, null, 'Supervisor interrupted. Native workers were NOT stopped and keep running; resume with: python -m workflow automatic <path> --live']],
    }))
    assert.equal(now.situation, 'interrupted')
    assert.equal(now.interruption, 'a')
    assert.equal(now.reasonSource, 0)
    assert.match(textToString(now.headline, T0), /^‖ Interrupted at Freeze worker handoffs · 10:30: the controller stopped; sessions keep running/)
    assert.deepEqual(commands(now), ['"$PY" -m workflow automatic "$RUN" --live --by operator'])
  })

  it('interrupted (a): the resumed controller\'s PID row ends it, before B1 (no status) and with B1 (running)', () => {
    for (const status of [null, 'running'] as const) {
      // As served after `automatic --live`: the PID row is the latest controller row, so the handoff is pending again.
      const now = checked(synthetic({
        status: 'running', nodes: WORKING,
        events: [...LAUNCHED, [1800, null, null, 'Supervisor interrupted. Native workers were NOT stopped and keep running; resume with: python -m workflow automatic <path> --live'],
          [1900, null, status, 'Automatic checkpoint controller PID 5151']],
      }))
      assert.equal(now.situation, 'running', `PID row status ${status}`)
      assert.doesNotMatch(prose(now), /Interrupted/)
      assert.deepEqual(commands(now), ['"$PY" -m workflow.interactive attach-one "$RUN" --node game'], 'never another `automatic`: the run is locked by the resumed controller')
    }
  })

  it('interrupted (a): also on a run served failed, when the review keeps its error (automatic.py:1316)', () => {
    const done = { challenge: 'succeeded', launch_game: 'succeeded', handoff: 'succeeded', verify_game: 'succeeded', candidate: 'succeeded' } as const
    const now = checked(synthetic({
      status: 'failed', nodes: { ...done, review: 'failed' },
      events: [[0, 'review', 'running', 'Launching the native reviewer session general'], [300, 'review', 'running', 'Could not confirm reviewer stop: timed out; resume retries the stop'],
        [301, null, null, `${OUTAGE} Claude Code was unavailable (an update replacing it, or its background service restarting). Nothing was stopped: the native sessions keep running. Once \`claude\` works, resume with: python -m workflow automatic <path> --live`]],
    }))
    assert.equal(now.situation, 'interrupted')
    assert.equal(now.interruption, 'a')
    assert.match(textToString(now.headline, T0), /^‖ Interrupted at Independent review · 10:05: Claude Code was unavailable; sessions keep running/)
    assert.doesNotMatch(prose(now), /Failed/)
  })

  // automatic.py resumable_stop, as the server serves its rows (interrupted is paused, node-less). Each used to be a
  // `Controller blocked:` row, which rule 6 answered with a new run while the run could go on.
  const BRANCH_STOP = 'Source feature branch changed: <path> is on feature/elsewhere, not feature/skeleton/skeleton-001. Nothing was stopped or relaunched: switch it back with: git -C <path> switch feature/skeleton/skeleton-001, then resume with: python -m workflow automatic <path> --live'
  const RECONCILE_STOP = 'Automatic supervision requires a completed start: launch_game did not complete. Nothing was stopped or relaunched: inspect its receipt and `claude agents --json`, reconcile with: python -m workflow reconcile <path>, then resume with: python -m workflow automatic <path> --live'
  const NEVER_STARTED_STOP = 'Automatic supervision requires a completed start: the run was never started, so no worker was launched. Start it with: python -m workflow start <path> --live, then resume with: python -m workflow automatic <path> --live'

  it('interrupted (a): a changed source branch is resumed once the checkout is switched back, never with a new run', () => {
    const now = checked(synthetic({ status: 'paused', nodes: { ...WORKING, handoff: 'paused' }, events: [...LAUNCHED, [1800, null, 'paused', BRANCH_STOP]] }))
    assert.equal(now.situation, 'interrupted')
    assert.equal(now.interruption, 'a')
    assert.equal(now.reasonSource, 0)
    assert.match(textToString(now.headline, T0), /^‖ Interrupted at Freeze worker handoffs · 10:30: the controller stopped; sessions keep running/)
    assert.equal(now.next.label, 'Switch the target checkout back to feature/skeleton/skeleton-001, then resume the controller: it relaunches nothing')
    assert.deepEqual(now.next.steps, [{ kind: 'text', text: 'In the target repository: git switch feature/skeleton/skeleton-001' },
      { kind: 'command', text: '"$PY" -m workflow automatic "$RUN" --live --by operator' }])
    assert.deepEqual(now.next.runbook, [{ section: 'Status, failures and recovery', topic: 'Source feature branch changed' }])
    assert.doesNotMatch(prose(now), /new run|Blocked/)
  })

  it('interrupted (a): a note or an answer sent while no controller runs keeps the interruption', () => {
    // notes.py send_note and guardrails.py answer_main need no controller. They write plain records (raw status `note`),
    // which the server serves on the lane with no status, as log lines: they neither end the scope nor read as running.
    const RESUME_NOTE = 'Supervisor interrupted. Native workers were NOT stopped and keep running; resume with: python -m workflow automatic <path> --live'
    const stops: EventSpec[] = [[1800, null, null, RESUME_NOTE], [1800, null, 'paused', BRANCH_STOP]]
    const records = ['Note N-1 from the operator to worker game: undeliverable, not typed (lane_blocked)', 'Note N-1 from the maintainer to worker game: typed into its pane',
      'Question 1 of game answered by the operator', 'Question 1 of game answered by the maintainer (via a Claude Code session)']
    for (const stop of stops) {
      for (const record of records) {
        const now = checked(synthetic({ status: 'paused', nodes: { ...WORKING, handoff: 'paused' }, events: [...LAUNCHED, stop, [1900, 'launch_game', null, record]] }))
        assert.equal(now.situation, 'interrupted', `${stop[3].slice(0, 20)} then ${record}`)
        assert.equal(now.interruption, 'a', record)
        assert.ok(commands(now).includes('"$PY" -m workflow automatic "$RUN" --live --by operator'), record)
        assert.doesNotMatch(prose(now), /No action needed/, record)
      }
    }
  })

  it('interrupted (a): a start that did not complete is reconciled, or started when the run never was, then resumed', () => {
    const reconcile = checked(synthetic({
      status: 'failed', nodes: { challenge: 'succeeded', launch_game: 'failed' },
      events: [[0, 'launch_game', 'running', 'Launching or reconciling the exact native session'], [5, null, 'running', 'Automatic checkpoint controller PID 4242'], [6, null, 'paused', RECONCILE_STOP]],
    }))
    assert.equal(reconcile.situation, 'interrupted')
    assert.equal(reconcile.interruption, 'a')
    assert.deepEqual(commands(reconcile), ['"$PY" -m workflow reconcile "$RUN" --by operator', '"$PY" -m workflow automatic "$RUN" --live --by operator'])
    assert.equal(reconcile.next.label, 'Reconcile the launches that did not complete, then resume the controller: nothing is relaunched')
    assert.deepEqual(reconcile.next.runbook, [{ section: 'Status, failures and recovery', topic: 'Ambiguous startup' }])
    assert.doesNotMatch(prose(reconcile), /new run|Blocked before freeze/)
    const never = checked(synthetic({ status: 'running', nodes: { challenge: 'succeeded' }, events: [[5, null, 'running', 'Automatic checkpoint controller PID 4242'], [6, null, 'paused', NEVER_STARTED_STOP]] }))
    assert.equal(never.situation, 'interrupted')
    assert.equal(never.interruption, 'a')
    assert.deepEqual(commands(never), ['"$PY" -m workflow start "$RUN" --live --by operator', '"$PY" -m workflow automatic "$RUN" --live --by operator'])
  })

  it('interrupted (a): on a lane named controller, a resumable stop belongs to the run, not to the lane', () => {
    // As a server before B1 serves the row: aliased onto the lane's launch node, which CONTROLLER_LANE_ROWS undoes.
    const now = checked(synthetic({
      base: guardrails, status: 'paused', nodes: { launch_controller: 'running', launch_ui: 'running', handoff: 'paused' },
      events: [[0, 'launch_controller', 'running', 'Launching or reconciling the exact native session'], [1, 'launch_ui', 'running', 'Launching or reconciling the exact native session'],
        [5, 'launch_controller', 'running', 'Automatic checkpoint controller PID 4242'], [1800, 'launch_controller', 'paused', BRANCH_STOP]],
    }))
    assert.equal(now.situation, 'interrupted')
    assert.equal(now.interruption, 'a')
    assert.deepEqual(commands(now), ['"$PY" -m workflow automatic "$RUN" --live --by operator'])
    assert.match(now.next.label, /^Switch the target checkout back to feature\/workflow-guardrails\/workflow-guardrails-001,/)
  })

  const REVIEWED ={ challenge: 'succeeded', launch_game: 'succeeded', handoff: 'succeeded', verify_game: 'succeeded', candidate: 'succeeded' } as const
  const REVIEW_NOTE = 'Controller interrupted while waiting for the reviewers. The native reviewer sessions were NOT stopped and keep running; resume with: python -m workflow automatic <path> --live'
  const REVIEW_LAUNCH: EventSpec = [0, 'review', 'running', 'Launching the native reviewer session general']

  it('interrupted (b): the review node recorded it, with no controller row', () => {
    // Ctrl-C (automatic.py:804) records no graph error: the raw `interrupted` row serves the review, and the run, paused.
    const now = checked(synthetic({ status: 'paused', nodes: { ...REVIEWED, review: 'paused' }, events: [REVIEW_LAUNCH, [300, 'review', 'paused', REVIEW_NOTE]] }))
    assert.equal(now.situation, 'interrupted')
    assert.equal(now.interruption, 'b')
    assert.equal(now.tone, 'interrupted')
    assert.match(textToString(now.headline, T0), /^‖ Interrupted at Independent review/)
    assert.doesNotMatch(prose(now), /Failed/)
    assert.deepEqual(commands(now), ['"$PY" -m workflow automatic "$RUN" --live --by operator'])
  })

  it('interrupted (b): the review recorded an outage, and keeps its graph error, so it is served failed (automatic.py:811)', () => {
    const now = checked(synthetic({
      status: 'failed', nodes: { ...REVIEWED, review: 'failed' },
      events: [REVIEW_LAUNCH, [300, 'review', 'paused', `${OUTAGE} ${REVIEW_NOTE}`]],
    }))
    assert.equal(now.situation, 'interrupted')
    assert.equal(now.interruption, 'b')
    assert.match(textToString(now.headline, T0), /^‖ Interrupted at Independent review/)
    assert.doesNotMatch(prose(now), /Failed/)
    assert.deepEqual(commands(now), ['"$PY" -m workflow automatic "$RUN" --live --by operator'])
  })

  const FREEZE_NOTE: EventSpec = [1800, 'handoff', 'paused', `${OUTAGE} The freeze was stopping the workers: resume completes the stops it recorded (<lane>.stop.json) and relaunches nothing. Once \`claude\` works, resume with: python -m workflow automatic <path> --live`]

  it('interrupted (b): the freeze recorded it on the handoff, which keeps its graph error, so it is served failed', () => {
    const now = checked(synthetic({ status: 'failed', nodes: { challenge: 'succeeded', launch_game: 'succeeded', handoff: 'failed' }, events: [...LAUNCHED, FREEZE_NOTE] }))
    assert.equal(now.situation, 'interrupted')
    assert.equal(now.interruption, 'b')
    assert.match(textToString(now.headline, T0), /^‖ Interrupted at Freeze worker handoffs/)
    assert.doesNotMatch(prose(now), /Failed/)
    assert.deepEqual(commands(now), ['"$PY" -m workflow automatic "$RUN" --live --by operator'])
    // Resumed: the freeze runs again (automatic.py resume_interrupted_freeze) while the handoff still reads failed.
    const resumed = checked(synthetic({
      status: 'failed', nodes: { challenge: 'succeeded', launch_game: 'succeeded', handoff: 'failed' },
      events: [...LAUNCHED, FREEZE_NOTE, [1900, null, null, 'Automatic checkpoint controller PID 5151'],
        [1901, 'handoff', 'running', 'Resuming the freeze interrupted by: Claude Code unavailable for 60s; its recorded stops are completed, nothing is relaunched']],
    }))
    assert.equal(resumed.situation, 'running')
    assert.match(textToString(resumed.headline, T0), /^● Running · Freeze worker handoffs/)
  })

  it('interrupted (b): a resumed controller\'s PID row ends it; the review is running again though still served paused', () => {
    const now = checked(synthetic({
      status: 'paused', nodes: { ...REVIEWED, review: 'paused' },
      events: [REVIEW_LAUNCH, [300, 'review', 'paused', REVIEW_NOTE], [360, null, null, 'Automatic checkpoint controller PID 5151']],
    }))
    assert.equal(now.situation, 'running')
    assert.match(textToString(now.headline, T0), /^● Running · Independent review · resumed at 10:06/)
    assert.deepEqual(commands(now), [])
  })

  it('interrupted (c): the controller is not running on polls 20 s apart; a single poll does not match', () => {
    const run = synthetic({ status: 'running', nodes: WORKING, events: LAUNCHED })
    const now = checked({ ...run, controller: [{ at: t(100), value: 'running' }, { at: t(120), value: 'not_running' }, { at: t(140), value: 'not_running' }] })
    assert.equal(now.situation, 'interrupted')
    assert.equal(now.interruption, 'c')
    assert.deepEqual(commands(now), ['"$PY" -m workflow automatic "$RUN" --live --by operator'])
    assert.equal(deriveNow({ ...run, controller: [{ at: t(120), value: 'not_running' }] }).situation, 'running')
    assert.equal(controllerNotRunning([{ at: t(120), value: 'not_running' }, { at: t(130), value: 'not_running' }]), false, '10 s is a checkpoint hand-over')
  })

  it('interrupted (c): since is the start of the current not-running streak, not an earlier hand-over', () => {
    const run = synthetic({ status: 'running', nodes: WORKING, events: LAUNCHED })
    const now = deriveNow({ ...run, controller: [{ at: t(10), value: 'not_running' }, { at: t(15), value: 'running' }, { at: t(3000), value: 'not_running' }, { at: t(3020), value: 'not_running' }] })
    assert.equal(now.interruption, 'c')
    assert.equal(now.since, t(3000))
  })

  it('interrupted (c): also while an automatic retry is served failed', () => {
    const now = checked({ ...skeletonRetrying(), controller: [{ at: '2026-09-24T09:21:00Z', value: 'not_running' }, { at: '2026-09-24T09:21:20Z', value: 'not_running' }] })
    assert.equal(now.situation, 'interrupted')
    assert.equal(now.interruption, 'c')
    assert.match(textToString(now.headline, T0), /^‖ Interrupted at Verify game: the controller is not running/)
  })

  it('interrupted (d): a repair applied and not yet continued', () => {
    const verifying = { challenge: 'succeeded', launch_game: 'succeeded', handoff: 'succeeded' } as const
    const repaired = (mode: 'automatic' | 'retry') => synthetic({
      status: 'paused', nodes: { ...verifying, verify_game: ['paused', 2] },
      events: [[0, 'verify_game', 'running', 'Attempt 1; revision 5c1a734e71c3312a8d9174f50951e27fcd26d0b7'], [60, 'verify_game', 'failed', 'unit: no passing test evidence or failed tests'],
        [62, 'verify_game', 'running', 'Attempt 2; revision 5c1a734e71c3312a8d9174f50951e27fcd26d0b7'], [120, 'verify_game', 'failed', 'unit: no passing test evidence or failed tests'],
        [122, null, null, 'worker/game failed identically on attempts 1 and 2; not transient, inspect <path> Before review a code fix is a lane repair (RUNBOOK)'],
        [400, 'verify_game', 'paused', `Repair 1 by the operator: snapshot 50b14b3c = 5c1a734e + b27d726a on snapshot 5c1a734e (vitest.config.ts). Reason: Vitest summaries. Answers worker/game attempt 2: unit: no passing test evidence or failed tests. Continue with python -m workflow ${mode === 'automatic' ? 'automatic <path> --live' : 'retry <path>'}`],
        [400, null, null, 'Repair 1 applied: checkpoint forked from 1f1b7f90 (after handoff); attempts worker:game 3']],
      inputs: inputs => { if (mode === 'retry') { inputs.mode = 'manual'; inputs.automatic = null } },
    })
    const now = checked(repaired('automatic'))
    assert.equal(now.situation, 'interrupted')
    assert.equal(now.interruption, 'd')
    assert.match(textToString(now.headline, T0), /^‖ Repair 1 applied; the run continues when you resume it/)
    assert.deepEqual(commands(now), ['"$PY" -m workflow automatic "$RUN" --live --by operator'])
    assert.deepEqual(commands(checked(repaired('retry'))), ['"$PY" -m workflow retry "$RUN" --by operator'])
  })

  describe('blocked_before_freeze', () => {
    const blocked = (rows: EventSpec[], inputs?: (inputs: RunInputs) => void) => checked(synthetic({
      status: 'failed', nodes: { challenge: 'succeeded', launch_game: 'running', handoff: 'failed' }, events: [...LAUNCHED, ...rows], inputs,
    }))

    it('quotes the deadline row and offers a new run, never repair', () => {
      for (const status of ['failed', null] as const) {
        const now = blocked([[3600, null, status, 'Worker game deadline exhausted; no automatic relaunch']])
        assert.equal(now.situation, 'blocked_before_freeze', `row status ${status}`)
        assert.equal(now.reasonSource, 0)
        assert.match(textToString(now.headline, T0), /^✗ Blocked before freeze at Freeze worker handoffs · Worker game deadline exhausted; no automatic relaunch/)
        assert.match(textToString(now.reason, T0), /11:00.*Worker game deadline exhausted/)
        assert.deepEqual(commands(now), ['"$PY" -m workflow launch <feature> --repo <target repo> --run-id <new run id> --live --automatic --by operator'])
        assert.match(now.next.label, /`repair` refuses a lane blocked before freeze; an automatic run then needs a new run/)
        assert.doesNotMatch(prose(now), /retry/)
      }
    })

    it('names the worker\'s own blocked completion', () => {
      const now = blocked([], inputs => {
        inputs.workers[0].completion = { ...skeleton.inputs.workers[0].completion!, status: 'blocked', summary: 'The package registry is unreachable from the worktree.' }
      })
      assert.equal(now.situation, 'blocked_before_freeze')
      assert.equal(now.reasonSource, 3)
      assert.match(textToString(now.reason, T0), /^game reported blocked: The package registry is unreachable from the worktree\./)
    })

    it('quotes a fourth question', () => {
      const now = blocked([[3000, null, null, 'Worker game asked question 4; at most 3 are answered, so it is treated as blocked: Should the HUD show ping?']])
      assert.match(textToString(now.headline, T0), /game asked a fourth question: Should the HUD show ping\?/)
    })

    it('stops the unconfirmed sessions first', () => {
      const now = blocked([[3600, null, null, 'Worker game deadline exhausted; no automatic relaunch'], [3601, 'handoff', 'failed', 'Could not confirm worker stop: session vanished']])
      assert.equal(now.next.steps[0].kind, 'text')
      assert.match((now.next.steps[0] as { text: string }).text, /^Stop the sessions .* exact ids/)
      assert.ok(now.next.runbook.some(ref => ref.topic === 'Stopping an unfinished run'))
    })
  })

  it('challenge_paused', () => {
    const now = checked(synthetic({
      status: 'paused', nodes: { challenge: 'paused' },
      events: [[0, 'challenge', 'running', 'Design challenge attempt 1: one print job, session 81e2b324-da2f-47a3-9d66-e9f8ad35e964'],
        [150, 'challenge', 'paused', 'Design challenge attempt 1 paused the run before any worker launch: 1 P0/P1 concern(s)']],
      inputs: inputs => {
        const challenge = inputs.challenge!
        inputs.challenge = { ...challenge, status: 'paused', attempt: 1, attempts: 1, concerns: [{ ...challenge.concerns[0], severity: 'P1', message: 'Seats can be squatted.' }, ...challenge.concerns.slice(1)] }
      },
    }))
    assert.equal(now.situation, 'challenge_paused')
    assert.match(textToString(now.headline, T0), /^‖ Paused: the design challenge found 1 P1; no worker launched/)
    assert.match(textToString(now.reason, T0), /Seats can be squatted\./)
    assert.deepEqual(commands(now), ['"$PY" -m workflow resume "$RUN" --by operator', '"$PY" -m workflow resume "$RUN" --accept-challenge "<reason>" --by operator'])
  })

  it('awaiting_approval', () => {
    const done = { challenge: 'succeeded', launch_game: 'succeeded', handoff: 'succeeded', verify_game: 'succeeded', candidate: 'succeeded', review: 'succeeded' } as const
    const now = checked(synthetic({
      status: 'awaiting_approval', nodes: { ...done, approval: 'awaiting_approval' }, review: { ...fixes.review!, run_id: 'skeleton-001' },
      events: [[0, 'approval', 'awaiting_approval', 'Waiting for explicit approval of the reviewed bundle']],
      inputs: inputs => { inputs.mode = 'manual'; inputs.automatic = null },
    }))
    assert.equal(now.situation, 'awaiting_approval')
    assert.match(textToString(now.headline, T0 + 720_000), /^\? Awaiting your approval since 10:00 \(12 min ago\)/)
    assert.deepEqual(commands(now), [`"$PY" -m workflow approve "$RUN" --bundle-sha256 ${fixes.review!.bundle_sha256} --by operator`])
    assert.match(prose(now), /viewing approves nothing/)
  })

  it('check_failed', () => {
    // skeleton-001 as served: the verify task keeps its graph error until the retry ends, so the run reads failed throughout.
    const automatic = checked(skeletonFailedOnce())
    assert.equal(automatic.situation, 'check_failed')
    assert.equal(automatic.reasonSource, 2)
    assert.equal(textToString(automatic.headline, T0), '✗ Verify game failed attempt 1 of 3: unit, integration — no passing test evidence or failed tests')
    assert.equal(automatic.next.action, 'none')
    assert.match(automatic.next.label, /the supervisor retries by itself/)
    assert.deepEqual(commands(automatic), [], 'the supervisor retries by itself')
    assert.deepEqual(automatic.missing, [])
    const manual = checked(synthetic({
      status: 'failed', nodes: { ...BEFORE_VERIFY, verify_game: 'failed' },
      events: [[0, 'verify_game', 'running', 'Attempt 1; revision 5c1a734e71c3312a8d9174f50951e27fcd26d0b7'], [67, 'verify_game', 'failed', eventAt(skeleton, 14).message]],
      results: { [GAME_1]: skeletonGame1 }, inputs: inputs => { inputs.mode = 'manual'; inputs.automatic = null },
    }))
    assert.equal(manual.situation, 'check_failed')
    assert.deepEqual(commands(manual), ['"$PY" -m workflow retry "$RUN" --phase worker --node game --by operator'])
  })

  it('check_failed: while the retry runs, the headline reads the failed attempt and never asks for the running one', () => {
    const retrying = skeletonRetrying()
    const now = checked(retrying)
    assert.equal(now.situation, 'check_failed')
    assert.equal(textToString(now.headline, T0), '✗ Verify game failed attempt 1 of 3: unit, integration — no passing test evidence or failed tests · attempt 2 running since 09:20')
    assert.equal(now.since, eventAt(skeleton, 14).occurred_at)
    assert.deepEqual(commands(now), [])
    assert.deepEqual(now.missing, [], 'results/game/2 does not exist until attempt 2 ends')
    assert.deepEqual(nowResultUris(retrying.detail, retrying.events), [GAME_1])
    assert.deepEqual(nowResultUris(skeletonFailedOnce().detail, skeletonFailedOnce().events), [GAME_1])
  })

  it('check_failed: a candidate lane retry (guardrails #28 to #31)', () => {
    const lane = (worker: string, attempt: number) => ({ worker, attempt, result_uri: `${GUARDRAILS_RUN}/results/candidate_${worker}/${attempt}` })
    const run = servedAt(guardrails, 30, 'failed',
      { launch_controller: 'succeeded', launch_ui: 'succeeded', handoff: 'succeeded', verify_controller: ['succeeded', 2], verify_ui: 'succeeded', candidate: 'failed' },
      { laneResults: [lane('controller', 1), lane('ui', 1)],
        results: { [lane('controller', 1).result_uri]: guardrails.results.get(lane('controller', 1).result_uri)!, [lane('ui', 1).result_uri]: guardrailsCandidateUi1 } })
    const now = checked(run)
    assert.equal(now.situation, 'check_failed')
    assert.equal(now.lane, 'ui')
    assert.match(textToString(now.headline, T0), /^✗ Verify combined candidate failed attempt 1 of 3 \(lane ui\): project-workflows-browser — /)
    assert.deepEqual(commands(now), [])
    assert.deepEqual(now.missing, [])
  })

  it('check_failed: a controller block after the failure means the supervisor stopped, and rule 13 quotes it', () => {
    const now = checked(synthetic({
      status: 'failed', nodes: { ...BEFORE_VERIFY, verify_game: 'failed' },
      events: [[0, 'verify_game', 'running', 'Attempt 1; revision 5c1a734e71c3312a8d9174f50951e27fcd26d0b7'], [67, 'verify_game', 'failed', eventAt(skeleton, 14).message],
        [70, null, null, `${OUTAGE} The verify_game step ended on it in a state no resume continues; inspect retained evidence`]],
      results: { [GAME_1]: skeletonGame1 },
    }))
    assert.equal(now.situation, 'no_rule_matched')
    assert.equal(now.reasonSource, 0)
    assert.match(textToString(now.reason, T0), /no resume continues/)
  })

  it('running', () => {
    const now = checked(synthetic({ status: 'running', nodes: WORKING, events: LAUNCHED }))
    assert.equal(now.situation, 'running')
    assert.equal(now.next.action, 'none')
    assert.match(textToString(now.headline, T0 + 300_000), /^● Running · Launch game worker · working 5m00s · deadline 13:00 \(2h55m left\) · last activity 5 min ago: waiting for the worker's completion signal/)
    assert.deepEqual(commands(now), ['"$PY" -m workflow.interactive attach-one "$RUN" --node game'])
  })

  it('inactive', () => {
    assert.equal(checked(synthetic({ status: 'pending', nodes: {}, events: [] })).situation, 'inactive')
  })

  it('no_rule_matched: a failed run', () => {
    const now = checked(synthetic({
      status: 'failed', nodes: { challenge: 'succeeded', launch_game: 'succeeded', handoff: 'succeeded', verify_game: 'succeeded', candidate: 'succeeded', review: 'succeeded', approval: 'succeeded', integrate: 'failed' },
      events: [[0, 'integrate', 'running', 'Fast-forwarding the source branch'], [5, 'integrate', 'failed', 'Source branch moved since the run started']],
    }))
    assert.equal(now.situation, 'no_rule_matched')
    assert.equal(now.next.action, 'unknown')
    assert.match(textToString(now.headline, T0), /^✗ Failed at Integrate candidate · Source branch moved since the run started/)
    assert.match(now.next.label, /No known next step matched/)
    assert.deepEqual(commands(now), ['"$PY" -m workflow status "$RUN"'])
    assert.match(prose(now), /changes no run progress/)
    assert.doesNotMatch(prose(now), /read-only/)
    // status writes nothing, report.html included: the caption sends a reader who wants a fresh report to export.
    assert.match(prose(now), /it writes nothing \(export refreshes report\.html\)/)
    assert.doesNotMatch(prose(now), /it refreshes report\.html/)
  })

  it('no_rule_matched: a paused run is never called failed', () => {
    const now = checked(synthetic({
      status: 'paused', nodes: { challenge: 'succeeded', launch_game: 'succeeded', handoff: 'succeeded', verify_game: 'paused' },
      events: [[0, 'verify_game', 'running', 'Attempt 1; revision 5c1a734e71c3312a8d9174f50951e27fcd26d0b7'], [60, 'verify_game', 'paused', 'Packet hash mismatch; evidence retained']],
    }))
    assert.equal(now.situation, 'no_rule_matched')
    assert.match(textToString(now.headline, T0), /^‖ Paused at Verify game · Packet hash mismatch; evidence retained/)
    assert.doesNotMatch(prose(now), /Failed/)
  })

  it('no_rule_matched: a controller block aliased onto a lane named controller (C6) is still the reason, as source 4', () => {
    // Before and with B1, `Worker ui deadline exhausted` matches no controller-process pattern, so it stays on launch_controller.
    const now = checked(synthetic({
      base: guardrails, status: 'failed', nodes: { launch_controller: 'succeeded', launch_ui: 'succeeded', handoff: 'failed' },
      events: [[0, 'launch_controller', 'running', 'Launching or reconciling the exact native session'], [0, 'launch_ui', 'running', 'Launching or reconciling the exact native session'],
        [5, 'launch_controller', 'running', 'Automatic checkpoint controller PID 5151'], [3600, 'launch_controller', 'failed', 'Worker ui deadline exhausted; no automatic relaunch'],
        [3601, 'handoff', null, 'Native workers stopped before snapshot capture: controller, ui']],
    }))
    assert.equal(now.situation, 'no_rule_matched')
    assert.equal(now.reasonSource, 4)
    assert.equal(textToString(now.headline, T0), '✗ Failed at Freeze worker handoffs · Worker ui deadline exhausted; no automatic relaunch. The workflow did not complete.')
  })

  it('blocked_before_freeze: on a lane named controller, a Controller blocked row aliased onto the lane is the run\'s, as source 0', () => {
    // automatic.py record_blocked says why drive stops (`Controller blocked: …`). As a server before B1 serves the row, aliased onto
    // launch_controller; CONTROLLER_LANE_ROWS makes it the run's row, as for the deadline row above once B1 serves it node-less.
    const stop = 'Controller blocked: Freeze failed: Stop failed for ui; inspect native session before retrying; non-retryable graph failure, inspect retained evidence'
    const now = checked(synthetic({
      base: guardrails, status: 'failed', nodes: { launch_controller: 'succeeded', launch_ui: 'succeeded', handoff: 'failed' },
      events: [[0, 'launch_controller', 'running', 'Launching or reconciling the exact native session'], [0, 'launch_ui', 'running', 'Launching or reconciling the exact native session'],
        [5, 'launch_controller', 'running', 'Automatic checkpoint controller PID 5151'], [3600, 'launch_controller', 'failed', stop]],
    }))
    assert.equal(now.situation, 'blocked_before_freeze')
    assert.equal(now.reasonSource, 0)
    assert.match(textToString(now.reason, T0), /Controller blocked: Freeze failed: Stop failed for ui/)
  })

  it('scope: a stale [Errno 2] row before the focus attempt is ignored', () => {
    const run = (second: number) => synthetic({
      status: 'failed', nodes: { challenge: 'succeeded', launch_game: 'succeeded', handoff: 'succeeded', verify_game: 'succeeded', candidate: 'succeeded', review: 'succeeded', approval: 'succeeded', integrate: 'failed' },
      events: ([[0, 'launch_game', 'running', 'Launching or reconciling the exact native session'], [second, null, null, "[Errno 2] No such file or directory: 'claude'"],
        [100, 'integrate', 'running', 'Fast-forwarding the source branch'], [105, 'integrate', 'failed', 'Source branch moved since the run started']] as EventSpec[]).sort((a, b) => a[0] - b[0]),
    })
    const stale = checked(run(50))
    assert.equal(stale.reasonSource, 4)
    assert.doesNotMatch(prose(stale), /Errno/)
    const inScope = checked(run(102))
    assert.equal(inScope.reasonSource, 0)
    assert.match(textToString(inScope.reason, T0), /\[Errno 2\]/)
  })
})

// ---- The other exports ---------------------------------------------------------------------------------------------

describe('gateReasonsByCheck', () => {
  const skeletonChecks = skeleton.inputs.workers[0].checks
  const [controllerChecks, uiChecks] = guardrails.inputs.workers.map(worker => worker.checks)

  it('keys skeleton-001 results/game/1 by unit: and integration:', () => {
    const reasons = gateReasonsByCheck(skeletonGame1.error?.message, skeletonChecks)
    assert.deepEqual(reasons.gate, [])
    assert.deepEqual([...reasons.byCheck.keys()], ['unit', 'integration'])
    assert.deepEqual(reasons.byCheck.get('unit')?.map(reason => reason.reason), ['no passing test evidence or failed tests'])
  })

  it('keys guardrails candidate_ui/2 by project-workflows-browser:', () => {
    const reasons = gateReasonsByCheck(candidateUi2.error?.message, uiChecks)
    assert.deepEqual([...reasons.byCheck.keys()], ['project-workflows-browser'])
    assert.equal(reasons.byCheck.get('project-workflows-browser')?.length, 3)
    assert.equal(reasons.byCheck.get('project-workflows-browser')?.[2].reason, 'Expected one screenshot attachment for inert-markdown')
  })

  it('lists the unkeyed <path> reason of guardrails results/controller/1 at the gate and attaches it to the one check whose command ends the same', () => {
    const reasons = gateReasonsByCheck(guardrailsController1.error?.message, controllerChecks)
    assert.deepEqual(reasons.gate.map(reason => [reason.text, reason.check_id, reason.attached_to]), [['Executed check failed: <path> -m workflow.run_tests', null, 'workflow-unit']])
    assert.deepEqual(reasons.byCheck.get('workflow-unit')?.map(reason => reason.text),
      ['Executed check failed: <path> -m workflow.run_tests', 'workflow-unit: no passing test evidence or failed tests', 'workflow-unit: exit 1'])
    const twice = [...controllerChecks, { ...controllerChecks[0], id: 'workflow-unit-again', command: '/opt/other/python -m workflow.run_tests' }]
    const ambiguous = gateReasonsByCheck(guardrailsController1.error?.message, twice)
    assert.deepEqual(ambiguous.gate.map(reason => reason.attached_to), [null], 'two matching tails: gate-level only')
    assert.equal(ambiguous.byCheck.get('workflow-unit')?.length, 2)
  })
})

describe('deriveAttention', () => {
  const lanes = (events: EventSpec[], options: { question?: boolean; approval?: boolean } = {}) => {
    const base = guardrails.detail
    const nodes = base.snapshot.nodes.map(node => ({
      ...node, lane_results: [], result_uri: null, session_id: null,
      status: node.node_id.startsWith('launch_') ? 'running' as const : node.node_id === 'approval' && options.approval ? 'awaiting_approval' as const : 'pending' as const,
      attempt: node.node_id.startsWith('launch_') || (node.node_id === 'approval' && options.approval) ? 1 : 0,
    }))
    const detail = validateRunDetail({ ...base, summary: { ...base.summary, status: 'running' }, snapshot: { ...base.snapshot, status: 'running', nodes } })
    const inputs = structuredClone(guardrails.inputs)
    for (const worker of inputs.workers) { worker.stop = null; worker.completion = null; worker.handoff = null }
    if (options.question) inputs.workers[1].questions = [{ n: 1, question: 'Which fixture?', asked_at: t(30), answer: null, answered_at: null }]
    const served = events.map(([second, node, status, message], index) => eventSchema.parse({
      contract_version: '1.0.0', run_id: base.summary.run_id, event_id: `x:${index + 1}`, sequence: index + 1, occurred_at: t(second), node_id: node,
      attempt: node ? 1 : 0, type: status ? 'status_changed' : 'log', status, message, artifact: null, result_uri: null, reused_from_attempt: null,
    }))
    return { detail, events: served, inputs: validateRunInputs(inputs) }
  }
  const pane: EventSpec = [40, 'launch_controller', 'running', 'Worker controller needs attention in its pane (native state blocked); waiting until its deadline']

  it('orders question > pane > approval', () => {
    const all = deriveAttention(lanes([pane], { question: true, approval: true }))
    assert.equal(all.top?.kind, 'question')
    assert.equal(all.top?.node_id, 'launch_ui')
    assert.deepEqual([...all.nodes].map(([node, attention]) => [node, attention.kind]), [['launch_controller', 'pane'], ['launch_ui', 'question'], ['approval', 'approval']])
    assert.equal(deriveAttention(lanes([pane], { approval: true })).top?.kind, 'pane')
    assert.equal(deriveAttention(lanes([], { approval: true })).top?.kind, 'approval')
  })

  it('keeps a pane on a lane named controller past the controller\'s own action rows and a note', () => {
    for (const message of ['Automatic by the maintainer: the supervisor continues the run', 'Start by the operator (via a Claude Code session)', 'Note N-2 from the operator to worker controller: undeliverable, not typed (lane_blocked)']) {
      const kept = deriveAttention(lanes([pane, [50, 'launch_controller', 'running', message]]))
      assert.equal(kept.top?.kind, 'pane', message)
      assert.equal(kept.top?.node_id, 'launch_controller', message)
    }
  })

  it('clears a pane once any later event names that node', () => {
    const cleared = deriveAttention(lanes([pane, [50, 'launch_controller', 'running', 'Awaiting explicit completion signal; idle is not acceptance']]))
    assert.equal(cleared.top, null)
    assert.equal(cleared.nodes.size, 0)
  })
})

describe('deriveFocus, humanizeEvent, attemptResultUris, laneLines', () => {
  it('focuses the first failed, paused or awaiting node in definition order, else the first running one', () => {
    assert.deepEqual(deriveFocus(skeleton.detail, skeleton.events), { node_id: 'review', label: 'Independent review', kind: 'review', status: 'failed', since: null })
    const focus = deriveFocus(guardrails.detail, guardrails.events)
    assert.deepEqual([focus?.node_id, focus?.since], ['candidate', eventAt(guardrails, 31).occurred_at])
    const running = synthetic({ status: 'running', nodes: WORKING, events: LAUNCHED })
    assert.equal(deriveFocus(running.detail, running.events)?.node_id, 'launch_game')
    assert.equal(deriveFocus(fixes.detail, fixes.events), null)
  })

  it('humanizes known phrases and cuts SHAs to 7 characters', () => {
    assert.equal(humanizeEvent(eventAt(skeleton, 9)), "waiting for the worker's completion signal (idle is not acceptance)")
    assert.equal(humanizeEvent(eventAt(skeleton, 13)), 'attempt 1 started · revision 5c1a734')
    assert.equal(humanizeEvent(eventAt(skeleton, 25)), 'combined revision 0bc381f')
    assert.equal(humanizeEvent(eventAt(fixes, 25)), 'fast-forwarded to ee74298 · no push performed')
    assert.equal(humanizeEvent(eventAt(guardrails, 6)), "[Errno 2] 'claude' not found")
    assert.equal(humanizeEvent(eventAt(skeleton, 10)), 'controller started (PID 3242976)')
    assert.match(humanizeEvent(eventAt(skeleton, 1)), /session f18dee3c-424c-4e3e-9379-a7ad784c9e37/, 'session UUIDs are not SHAs')
  })

  it('humanizes the verify message with exit codes and a retry, and the candidate gate notes (pipeline.py)', () => {
    const recorded = 'Required tests and artifacts passed; recorded for the candidate gate: '
    assert.equal(humanizeEvent({ message: `${recorded}build (exit 1), lint` }), 'passed · build (exit 1), lint gated at the candidate')
    assert.equal(humanizeEvent({ message: `${recorded}build (exit 1); passed on attempt 2 after attempt 1 failed` }),
      'passed · build (exit 1) gated at the candidate · passed on attempt 2 after attempt 1 failed')
    assert.equal(humanizeEvent({ message: '[ui] Candidate gate blocked on attempt 2: Executed check failed: npm test; unit: exit 1' }),
      'gate blocked on attempt 2: Executed check failed: npm test; unit: exit 1')
    assert.equal(humanizeEvent({ message: '[adapter] Candidate gate passed on attempt 3 after attempt 2 failed' }), 'gate passed on attempt 3 after attempt 2 failed')
    assert.equal(humanizeEvent({ message: '[ui] Combined revision 1ab6b9505a4269f5b6f68195fc4915446a5944ae' }), 'combined revision 1ab6b95', 'the verdict reads as before')
  })

  it('humanizes a repair whoever recorded it (C17)', () => {
    const rest = 'snapshot 50b14b3c = 5c1a734e + b27d726a on snapshot 5c1a734e (vitest.config.ts). Reason: Vitest summaries.'
    for (const actor of ['the operator', 'the operator (via a Claude Code session)', 'the maintainer']) {
      assert.equal(humanizeEvent({ message: `Repair 1 by ${actor}: ${rest}` }), 'repair 1: snapshot 50b14b3 = 5c1a734 + b27d726 (1 file)', actor)
    }
  })

  it('lists attempt result URIs per lane, oldest first', () => {
    assert.deepEqual(attemptResultUris(skeleton.detail, 'verify_game').map(item => item.uri), [1, 2, 3].map(k => `${SKELETON_RUN}/results/game/${k}`))
    assert.deepEqual(attemptResultUris(skeleton.detail, 'verify_game', { last: 2 }).map(item => item.attempt), [2, 3])
    assert.deepEqual(attemptResultUris(guardrails.detail, 'candidate').map(item => [item.lane, item.phase, item.attempt]),
      [['controller', 'candidate', 1], ['ui', 'candidate', 1], ['ui', 'candidate', 2]])
    assert.deepEqual(attemptResultUris(skeleton.detail, 'review'), [])
    assert.deepEqual(nowResultUris(guardrails.detail).sort(), [...guardrails.results.keys()].filter(uri => uri.includes('candidate_')).concat(`${GUARDRAILS_RUN}/results/candidate_ui/1`).sort())
    assert.deepEqual(nowResultUris(skeleton.detail), [], 'a review block needs no lane result')
  })

  it('gives one line per lane for runs with two or more lanes', () => {
    const lines = laneLines(guardrailsFull())
    assert.deepEqual(lines.map(line => [line.lane, line.steps.map(step => step.text)]), [
      ['controller', ['worker ✓', 'verify ✓ attempt 2 (1 failed)', 'candidate ✓ 5 checks']],
      ['ui', ['worker ✓', 'verify ✓', 'candidate ✗ attempt 2 of 3: project-workflows-browser — no passing test evidence or failed tests; missing/unknown browser scenarios; Expected one screenshot attachment for inert-markdown']],
    ])
    assert.deepEqual(laneLines(runData(skeleton)), [])
    // guardrails as served at #25: verify_controller's attempt 2 runs while its node still reads failed.
    const retrying = servedAt(guardrails, 25, 'failed',
      { launch_controller: 'succeeded', launch_ui: 'succeeded', handoff: 'succeeded', verify_controller: ['failed', 2], verify_ui: 'succeeded' })
    assert.deepEqual(laneLines(retrying).map(line => [line.lane, line.steps.map(step => step.text)]), [
      ['controller', ['worker ✓', 'verify ● attempt 2 (1 failed)', 'candidate ○']],
      ['ui', ['worker ✓', 'verify ✓', 'candidate ○']],
    ])
  })
})

// ---- The review sidecar (docs/PRD_REVIEW_SIDECAR.md 4.8): never the focus, never the running headline, no gap hider ----

describe('the review sidecar in the triage model', () => {
  const runOf = (runId: string): RunData => ({
    detail: sidecarPayloads.runDetails![runId], events: sidecarPayloads.runEvents![runId], inputs: sidecarPayloads.runInputs![runId], review: null, results: new Map(),
  })
  const text = (now: Now) => textToString(now.headline, Date.parse('2026-10-01T14:00:00Z'), { clock: at => at.slice(11, 19), ago: () => 'a while ago', span: ms => `${ms}ms` })

  it('never takes the focus from a running lane, while its own events are the latest', () => {
    const run = runOf(RUN_SIDECAR)
    assert.equal(run.events.at(-1)!.node_id, 'sidecar')
    assert.equal(run.detail.snapshot.nodes.find(node => node.node_id === 'sidecar')!.status, 'running')
    assert.equal(deriveFocus(run.detail, run.events)?.node_id, 'launch_viewer')
    assert.equal(deriveNow(run).focus?.node_id, 'launch_viewer')
    assert.equal(deriveFocus(runOf(RUN_SIDECAR_ONE_LANE).detail, runOf(RUN_SIDECAR_ONE_LANE).events)?.node_id, 'launch_engine')
  })

  it('is left out of the running headline and of its last activity, which read like the run without a sidecar', () => {
    for (const [withSidecar, without] of SIDECAR_TWINS) {
      const a = deriveNow(runOf(withSidecar))
      const b = deriveNow(runOf(without))
      assert.equal(a.situation, b.situation, withSidecar)
      assert.equal(text(a), text(b), withSidecar)
      assert.equal(a.focus?.node_id, b.focus?.node_id)
      assert.deepEqual(buildTimeline(runOf(withSidecar)).lastActivity, buildTimeline(runOf(without)).lastActivity)
      assert.deepEqual(buildTimeline(runOf(withSidecar)).runEnd, buildTimeline(runOf(without)).runEnd)
      assert.deepEqual(deriveAttention(runOf(withSidecar)), deriveAttention(runOf(without)))
    }
    const now = deriveNow(runOf(RUN_SIDECAR))
    assert.equal(now.situation, 'running')
    assert.match(text(now), /Launch engine worker.*Launch viewer worker/)
    assert.doesNotMatch(text(now), /Review sidecar|escalation|pass \d/)
  })

  it('a blocked run whose sidecar closed after the block still names the block: the sidecar is no parent of the scope', () => {
    const now = deriveNow(runOf(RUN_SIDECAR_BLOCKED))
    assert.equal(now.situation, 'blocked_before_freeze')
    assert.equal(now.focus?.node_id, 'handoff')
    assert.match(text(now), /Worker engine deadline exhausted/)
    assert.equal(runOf(RUN_SIDECAR_BLOCKED).detail.snapshot.nodes.find(node => node.node_id === 'sidecar')!.status, 'succeeded')
  })

  it('may be the focus only when nothing else runs', () => {
    const run = runOf(RUN_SIDECAR_ONE_LANE)
    const alone = structuredClone(run.detail)
    alone.snapshot.nodes = alone.snapshot.nodes.map(node => node.node_id === 'launch_engine' ? { ...node, status: 'succeeded' as const } : node)
    assert.equal(deriveFocus(alone, run.events)?.node_id, 'sidecar')
  })

  it('its span hides no silence: once the lanes stopped, a silence it spans is a gap', () => {
    const run = runOf(RUN_SIDECAR_FROZEN)
    // The lanes' stop receipts at 14:00, twenty minutes before the final pass started (its row at 14:20).
    const stopped: RunData = { ...run, inputs: { ...run.inputs!, workers: run.inputs!.workers.map(worker => ({ ...worker, stop: { stopped: true, confirmed_at: '2026-10-01T14:00:00Z' } })) } }
    const sidecarSpan = buildTimeline(stopped).byNode.get('sidecar')!.at(-1)!
    assert.ok(Date.parse(sidecarSpan.start!.at) < Date.parse('2026-10-01T14:00:00Z') && Date.parse(sidecarSpan.end!.at) > Date.parse('2026-10-01T14:20:00Z'))
    const gaps = buildTimeline(stopped).gaps.filter(gap => gap.from === '2026-10-01T14:00:00Z')
    assert.deepEqual(gaps.map(gap => [gap.kind, gap.to]), [['idle', '2026-10-01T14:20:00Z']])
  })
})
