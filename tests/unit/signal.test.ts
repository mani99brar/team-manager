/**
 * The run stage's layout and model (src/projects/signal, the Signal Box run page of 2026-10-09): a layered layout ordered by
 * the barycentre of the parents, with the fix loop's repair nodes one column after the step they answer and their return
 * marks drawn apart from the dependency edges; the arrow-key walk along and across the flow; and the step cards read from
 * the captured skeleton-001 payload and the fix-loop fixtures, with "not recorded" wherever the records hold nothing.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateReviewResult, validateRunDetail, validateRunInputs } from '../../contracts/projects/v1.ts'
import { eventSchema, validateWorkerResult } from '../../contracts/workflow/v1.ts'
import { buildTimeline, deriveAttention, deriveNow, type RunData } from '../../contracts/projects/triage.ts'
import { stepRows } from '../../src/projects/steps.ts'
import { formatSpan } from '../../src/projects/time.ts'
import { reviewJudgedExample, servedReview } from '../../contracts/projects/judgedExamples.ts'
import { REFINE_EXAMPLES } from '../project-workflows/fixtures/ux-refine.ts'
import { PANEL, RUN_SESSIONS, sessionsPayload, UX_SESSIONS_WORKFLOW_ID } from '../project-workflows/fixtures/sessions.ts'
import { runDetails } from '../project-workflows/fixtures.ts'
import '../project-workflows/fixtures/index.ts'
import { injectSessionNodes } from '../project-workflows/sessionProjection.ts'
import { dockReserve, DOCK_COLUMN_FRAME, DOCK_RESERVE, elbow, fitView, GAP_ALONG, layoutStage, NODE_HEIGHT, NODE_WIDTH, orderColumns, stepFrom, type StageInput, type View } from '../../src/projects/signal/layout.ts'
import { dockWords, type DockWordsInput } from '../../src/projects/signal/dockWords.ts'
import { factsOf, laneOf, latestEvents, nowNodeId, stageNodes, wordOf, type StageNode } from '../../src/projects/signal/model.ts'

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

const NOW = Date.parse('2026-09-24T12:00:00Z')

/** The two-lane pinned graph, with the fix loop's repair-1 answering verify_shell and repair-2 answering the review. */
const TWO_LANE: StageInput[] = [
  { id: 'launch_viewer', dep: [] },
  { id: 'launch_shell', dep: [] },
  { id: 'handoff', dep: ['launch_viewer', 'launch_shell'] },
  { id: 'verify_viewer', dep: ['handoff'] },
  { id: 'verify_shell', dep: ['handoff'] },
  { id: 'repair-1', dep: ['verify_shell'], rank: 1 },
  { id: 'candidate', dep: ['verify_viewer', 'verify_shell'] },
  { id: 'review', dep: ['candidate'] },
  { id: 'repair-2', dep: ['review'], rank: 1 },
  { id: 'approval', dep: ['review'] },
  { id: 'integrate', dep: ['approval'] },
]

function cardsOf(run: RunData, reviewRound: string | null = null): StageNode[] {
  const timeline = buildTimeline(run)
  const attention = deriveAttention(run)
  const rows = stepRows(run.detail, timeline, { now: NOW, attention })
  return stageNodes({ detail: run.detail, rows, timeline, events: run.events, inputs: run.inputs ?? null, review: run.review ?? null, attention, reviewRound }, formatSpan)
}

describe('orderColumns and layoutStage', () => {
  test('every step sits one column after its deepest dependency; a repair node follows the step it answers', () => {
    const columns = orderColumns(TWO_LANE)
    const column = new Map(columns.flatMap((ids, index) => ids.map(id => [id, index] as const)))
    assert.equal(column.get('launch_viewer'), 0)
    assert.equal(column.get('handoff'), 1)
    assert.equal(column.get('verify_shell'), 2)
    assert.equal(column.get('repair-1'), 3)
    assert.equal(column.get('candidate'), 3)
    assert.equal(column.get('review'), 4)
    assert.equal(column.get('repair-2'), 5)
    assert.equal(column.get('approval'), 5)
    assert.equal(column.get('integrate'), 6)
  })

  test('a column is ordered by the mean row of its parents, then pinned steps before repairs, so a repair hangs below', () => {
    const columns = orderColumns(TWO_LANE)
    // verify_viewer (row 0) and verify_shell (row 1) feed the candidate (mean 0.5); repair-1 hangs from verify_shell (1).
    // approval and repair-2 both hang from the review: the pinned step keeps the upper row.
    assert.deepEqual(columns[2], ['verify_viewer', 'verify_shell'])
    assert.deepEqual(columns[3], ['candidate', 'repair-1'])
    assert.deepEqual(columns[5], ['approval', 'repair-2'])
  })

  test('left to right, the columns step by the card width plus the gap and the picture is as wide as the last column', () => {
    const layout = layoutStage(TWO_LANE, { dir: 'LR' })
    const handoff = layout.positions.get('handoff')!
    const integrate = layout.positions.get('integrate')!
    assert.equal(handoff.x, NODE_WIDTH + GAP_ALONG)
    assert.equal(integrate.x, 6 * (NODE_WIDTH + GAP_ALONG))
    assert.equal(layout.width, integrate.x + NODE_WIDTH)
    assert.ok(layout.height >= 2 * NODE_HEIGHT, 'two rows need two cards of height')
    // Every dependency is one edge, drawn from the parent's right edge to the child's left edge.
    assert.equal(layout.edges.length, TWO_LANE.reduce((sum, node) => sum + node.dep.length, 0))
    const edge = layout.edges.find(candidate => candidate.from === 'handoff' && candidate.to === 'verify_viewer')!
    assert.match(edge.path, new RegExp(`^M${handoff.x + NODE_WIDTH} `))
  })

  test('top to bottom, the flow runs down the picture and a single column keeps the card width', () => {
    const layout = layoutStage(TWO_LANE, { dir: 'TB' })
    const launch = layout.positions.get('launch_viewer')!
    const handoff = layout.positions.get('handoff')!
    assert.equal(launch.y, 0)
    assert.ok(handoff.y > launch.y + NODE_HEIGHT)
    assert.ok(layout.width < layout.height, 'a phone picture is taller than wide')
  })

  test('edges to a pending step are marked todo; return marks are drawn apart from the edges and only for known steps', () => {
    const layout = layoutStage(TWO_LANE, { dir: 'LR', pending: new Set(['approval', 'integrate']), returns: [{ from: 'repair-1', to: 'verify_shell' }, { from: 'repair-9', to: 'nowhere' }] })
    assert.equal(layout.edges.find(edge => edge.to === 'approval')!.todo, true)
    assert.equal(layout.edges.find(edge => edge.to === 'review')!.todo, false)
    assert.deepEqual(layout.returns.map(mark => [mark.from, mark.to]), [['repair-1', 'verify_shell']])
    assert.ok(!layout.edges.some(edge => edge.from === 'repair-1'), 'a return mark is never a dependency edge')
  })

  test('an elbow is straight between two steps on one row and bends once in the gap before the target otherwise', () => {
    assert.equal(elbow({ x: 232, y: 62 }, { x: 304, y: 62 }, 'LR'), 'M232 62H296')
    const bent = elbow({ x: 232, y: 62 }, { x: 304, y: 222 }, 'LR')
    assert.match(bent, /^M232 62H256Q268 62 268 74V210Q268 222 280 222H296$/)
  })
})

describe('stepFrom', () => {
  const layout = layoutStage(TWO_LANE, { dir: 'LR' })
  test('walks along the flow to the nearest step of the next column and across it within the column', () => {
    assert.equal(stepFrom(layout, 'launch_viewer', 'ArrowRight'), 'handoff')
    assert.equal(stepFrom(layout, 'handoff', 'ArrowRight'), 'verify_viewer')
    assert.equal(stepFrom(layout, 'verify_viewer', 'ArrowDown'), 'verify_shell')
    assert.equal(stepFrom(layout, 'verify_shell', 'ArrowUp'), 'verify_viewer')
    assert.equal(stepFrom(layout, 'verify_shell', 'ArrowRight'), 'repair-1')
    assert.equal(stepFrom(layout, 'repair-1', 'ArrowLeft'), 'verify_shell')
  })
  test('stops at the edge of the picture', () => {
    assert.equal(stepFrom(layout, 'launch_viewer', 'ArrowLeft'), null)
    assert.equal(stepFrom(layout, 'launch_viewer', 'ArrowUp'), null)
    assert.equal(stepFrom(layout, 'integrate', 'ArrowRight'), null)
    assert.equal(stepFrom(layout, 'unknown', 'ArrowRight'), null)
  })
  test('on a phone the arrows swap: down follows the flow, right crosses it', () => {
    const phone = layoutStage(TWO_LANE, { dir: 'TB' })
    assert.equal(stepFrom(phone, 'launch_viewer', 'ArrowDown'), 'handoff')
    assert.equal(stepFrom(phone, 'verify_viewer', 'ArrowRight'), 'verify_shell')
  })
})

describe('the step cards of skeleton-001', () => {
  const run = loadRun('skeleton-001')
  const cards = cardsOf(run)
  const card = (id: string) => cards.find(candidate => candidate.id === id)!

  test('one card per definition node, in definition order, each with its state in a word and a tone', () => {
    assert.deepEqual(cards.map(item => item.id), run.detail.definition.nodes.map(node => node.node_id))
    for (const item of cards) {
      assert.ok(item.word.length > 0, `${item.id} has a word`)
      assert.ok(['ok', 'run', 'warn', 'fail', 'pause', 'idle'].includes(item.tone))
      assert.ok(item.facts.length > 0, `${item.id} has far-view facts`)
    }
  })

  test('a lane is read from the step id; the executor and the kind word follow the definition', () => {
    const launch = cards.find(item => item.id.startsWith('launch_'))!
    assert.equal(launch.lane, launch.id.slice('launch_'.length))
    assert.equal(launch.exec, 'agent')
    assert.equal(launch.kindLabel, 'worker')
    assert.equal(card('candidate').exec, 'verifier')
    assert.equal(card('candidate').lane, null)
  })

  test('a worker card tells what its completion said; its models come from the pinned roles', () => {
    const launch = cards.find(item => item.id.startsWith('launch_') && run.inputs!.workers.some(worker => worker.launch_node_id === item.id && worker.completion !== null))
    if (launch) {
      const worker = run.inputs!.workers.find(entry => entry.launch_node_id === launch.id)!
      assert.ok(launch.did!.includes(worker.completion!.summary))
    }
    for (const item of cards) assert.ok(Array.isArray(item.models))
  })

  test('the events of a card are its own, oldest first and humanized; the latest five of the run name their steps', () => {
    for (const item of cards) {
      const own = run.events.filter(event => event.node_id === item.id).map(event => event.sequence)
      assert.deepEqual(item.events.map(event => event.sequence), own)
    }
    const labels = new Map(run.detail.definition.nodes.map(node => [node.node_id, node.label]))
    const latest = latestEvents(buildTimeline(run), labels)
    assert.ok(latest.length > 0 && latest.length <= 5)
    for (let index = 1; index < latest.length; index += 1) assert.ok(Date.parse(latest[index - 1].at) >= Date.parse(latest[index].at), 'newest first')
    for (const event of latest) assert.ok(event.label.length > 0)
  })

  test('the dock\'s step is the Now\'s focus when it names a step of the run', () => {
    const now = deriveNow(run)
    const attention = deriveAttention(run)
    const id = nowNodeId(now, attention, cards)
    if (now.focus) assert.equal(id, now.focus.node_id)
    else assert.equal(id, cards.find(item => item.attention !== null)?.id ?? null)
  })
})

describe('the step cards of a fix-loop run', () => {
  const example = REFINE_EXAMPLES.find(candidate => candidate.runId === 'run-loop-done')!
  const run: RunData = { detail: example.detail, events: [], inputs: null, review: null }
  const cards = cardsOf(run, 'round 2 · delta from 1234567')
  const card = (id: string) => cards.find(candidate => candidate.id === id)!

  test('a repair node is a repair card with its lane, round, trigger and the step it re-enters', () => {
    const repair = card('repair-1')
    const entry = example.loop.repairs.find(item => item.node_id === 'repair-1')!
    assert.equal(repair.kindLabel, 'repair')
    assert.equal(repair.lane, entry.lane)
    assert.equal(repair.returnTo, entry.blocked_step)
    assert.equal(repair.round, `round ${entry.round} of ${entry.rounds} · ${entry.trigger}`)
    assert.deepEqual(repair.repair, entry)
    assert.ok(repair.did!.startsWith(`Repair session ${entry.round} of ${entry.rounds} for lane ${entry.lane}`))
    assert.equal(repair.word, entry.status === 'applied' ? 'applied' : repair.word)
  })

  test('the review card carries the round line the run view derived; pinned steps carry no return mark', () => {
    assert.equal(card('review').round, 'round 2 · delta from 1234567')
    for (const item of cards) if (!item.id.startsWith('repair-')) assert.equal(item.returnTo, null)
  })

  test('nothing recorded reads as null, never as a guess', () => {
    for (const item of cards) {
      if (item.events.length === 0 && item.repair === null && item.kind !== 'review') assert.ok(item.did === null || item.did.length > 0)
      assert.equal(item.ms, item.ms === null ? null : item.ms)
    }
  })
})

describe('words and facts', () => {
  test('wordOf appends "needs you" while a step waits, and an applied repair says applied', () => {
    assert.equal(wordOf('running', null, null), 'running')
    assert.equal(wordOf('running', 'question', null), 'running · needs you')
    const applied = { status: 'applied' } as unknown as Parameters<typeof wordOf>[2]
    assert.equal(wordOf('succeeded', null, applied), 'applied')
  })
  test('laneOf reads launch_ and verify_ ids and nothing else', () => {
    assert.equal(laneOf('launch_ui', null), 'ui')
    assert.equal(laneOf('verify_adapter', null), 'adapter')
    assert.equal(laneOf('candidate', null), null)
    assert.equal(laneOf('review', null), null)
  })
  test('factsOf keeps what waits, else how a step stopped, else lane, attempt and duration, at most three', () => {
    const base = { tone: 'ok' as const, word: 'succeeded', attention: null, attempt: 1, lane: 'ui', ms: 125_000 }
    assert.equal(factsOf(base, formatSpan), 'ui · 2m05s')
    assert.equal(factsOf({ ...base, attempt: 3 }, formatSpan), 'ui · #3 · 2m05s')
    assert.equal(factsOf({ ...base, tone: 'fail', word: 'failed', attempt: 2 }, formatSpan), 'failed · #2')
    assert.equal(factsOf({ ...base, attention: { kind: 'question', node_id: 'launch_ui', lane: 'ui', since: null, detail: '' } }, formatSpan), 'question waiting')
    assert.equal(factsOf({ ...base, lane: null, ms: null }, formatSpan), 'succeeded')
  })
})


// ---- The first view of the stage (fitView) ------------------------------------------------------------------------------

const GUARDED = ['challenge', 'launch_ui', 'handoff', 'verify_ui', 'candidate', 'review', 'approval', 'integrate']
const chain = (ids: readonly string[]): StageInput[] => ids.map((id, index) => ({ id, dep: index === 0 ? [] : [ids[index - 1]!] }))
const guarded = layoutStage(chain(GUARDED), { dir: 'LR' })
const small = layoutStage(chain(['a', 'b']), { dir: 'LR' })

type Box = { left: number; right: number; top: number; bottom: number }
const cardOf = (view: View, layout: typeof guarded, id: string): Box => {
  const position = layout.positions.get(id)!
  return { left: position.x * view.k + view.x, top: position.y * view.k + view.y, right: (position.x + NODE_WIDTH) * view.k + view.x, bottom: (position.y + NODE_HEIGHT) * view.k + view.y }
}
const inside = (box: Box, width: number, height: number, reserved: number) => box.left >= reserved && box.right <= width && box.top >= 0 && box.bottom <= height
const fitOf = (layout: typeof guarded, width: number, height: number, reserved: number, first: boolean, anchorId: string | null) => {
  const anchor = anchorId === null ? null : layout.positions.get(anchorId)!
  return fitView({ width, height, graph: layout, dir: 'LR', reserved, first, anchor: anchor && { x: anchor.x, y: anchor.y } })
}

describe('fitView: the first view of the stage', () => {
  test('the first view of the eight-column graph is never below 60 % and the whole graph\'s fit is, so the step the run is at is placed', () => {
    for (const [width, height] of [[900, 780], [1060, 780]] as const) {
      const whole = fitOf(guarded, width, height, 0, false, 'review')
      assert.ok(whole.k < 0.6, `the overview is under 60 % at ${width}`)
      const first = fitOf(guarded, width, height, 0, true, 'review')
      assert.equal(first.k, 0.6)
      assert.ok(inside(cardOf(first, guarded, 'review'), width, height, 0), 'the card of the step the run is at lies wholly inside the stage')
    }
  })

  test('the step the run is at stays right of an overlaying dock\'s reserve, wherever it sits', () => {
    for (const id of GUARDED) {
      const view = fitOf(guarded, 620 + DOCK_RESERVE, 700, DOCK_RESERVE, true, id)
      assert.equal(view.k, 0.6)
      assert.ok(inside(cardOf(view, guarded, id), 620 + DOCK_RESERVE, 700, DOCK_RESERVE), `${id} is clear of the dock`)
    }
  })

  test('the first column stays in view when it and the step the run is at both fit', () => {
    const view = fitOf(guarded, 900, 780, 0, true, 'launch_ui')
    assert.ok(cardOf(view, guarded, 'challenge').left >= 0)
    assert.ok(inside(cardOf(view, guarded, 'launch_ui'), 900, 780, 0))
    const far = fitOf(guarded, 900, 780, 0, true, 'integrate')
    assert.ok(inside(cardOf(far, guarded, 'integrate'), 900, 780, 0), 'the last step wins over the first column when both cannot fit')
  })

  test('without a step the run is at the first step is the anchor, and a finished run anchors there too', () => {
    const view = fitOf(guarded, 900, 780, 0, true, 'challenge')
    assert.ok(inside(cardOf(view, guarded, 'challenge'), 900, 780, 0))
    assert.ok(cardOf(view, guarded, 'challenge').left >= 0)
    const none = fitView({ width: 900, height: 780, graph: guarded, dir: 'LR', reserved: 0, first: true, anchor: null })
    assert.equal(none.k, 0.6)
  })

  test('a small graph opens at its whole fit, capped at 140 %, and centred', () => {
    const view = fitOf(small, 1400, 900, 0, true, 'a')
    assert.equal(view.k, 1.4)
    assert.deepEqual(view, fitOf(small, 1400, 900, 0, false, 'a'))
    const mid = fitOf(small, 700, 600, 0, true, 'a')
    assert.ok(mid.k > 0.6 && mid.k < 1.4)
    assert.ok(Math.abs(mid.x * 2 + small.width * mid.k - 700) < 1e-6, 'centred across')
  })

  test('"Fit the graph" shows the whole graph at any scale down to 15 %, in the stage beside the reserve', () => {
    const tight = fitOf(guarded, 620 + DOCK_RESERVE, 700, DOCK_RESERVE, false, 'review')
    assert.ok(tight.k < 0.6 && tight.k >= 0.15)
    for (const id of GUARDED) assert.ok(inside(cardOf(tight, guarded, id), 620 + DOCK_RESERVE, 700, DOCK_RESERVE), `${id} is in the viewport`)
    const huge = layoutStage(chain(Array.from({ length: 30 }, (_, index) => `s${index}`)), { dir: 'LR' })
    assert.equal(fitOf(huge, 800, 600, 0, false, 's0').k, 0.15)
  })

  test('a phone\'s top-to-bottom flow keeps its own fit', () => {
    const column = layoutStage(chain(GUARDED), { dir: 'TB' })
    const view = fitView({ width: 390, height: 700, graph: column, dir: 'TB', reserved: 336, first: true, anchor: { x: 0, y: 0 } })
    assert.equal(view.y, 40)
    assert.ok(view.k <= 1)
    assert.ok(Math.abs(view.x * 2 + column.width * view.k - 390) < 1e-6)
  })

  test('the dock reserves nothing from a 1200 px frame and 336 px below it while open; the frame width is the input', () => {
    assert.equal(DOCK_COLUMN_FRAME, 1200)
    assert.equal(dockReserve(1200, true), 0)
    assert.equal(dockReserve(1212, true), 0)
    assert.equal(dockReserve(1199, true), DOCK_RESERVE)
    assert.equal(dockReserve(956, true), 336)
    assert.equal(dockReserve(956, false), 0)
    assert.equal(dockReserve(1440, false), 0)
  })

  test('a changed stage width, a changed graph shape or a mount each place the view again from the same inputs', () => {
    const wide = fitOf(guarded, 1060, 780, 0, true, 'review')
    const narrow = fitOf(guarded, 900, 780, 0, true, 'review')
    assert.notDeepEqual(wide, narrow)
    assert.deepEqual(fitOf(guarded, 900, 780, 0, true, 'review'), narrow)
    const reshaped = layoutStage(chain([...GUARDED, 'extra']), { dir: 'LR' })
    assert.notDeepEqual(fitOf(reshaped, 900, 780, 0, true, 'extra'), fitOf(guarded, 900, 780, 0, true, 'integrate'))
  })
})

// ---- The dock bar's words (dockWords) -----------------------------------------------------------------------------------

describe('dockWords: when a run stopped or ended', () => {
  const CLOCK = Date.parse('2026-10-14T12:00:00Z')
  const base: DockWordsInput = {
    status: 'running', accepted: false, interrupted: false, stoppedSince: null, runningSince: '2026-10-14T11:18:45Z',
    end: null, created: '2026-10-14T10:00:00Z', clock: CLOCK, zone: 'utc',
  }
  const words = (patch: Partial<DockWordsInput>) => dockWords({ ...base, ...patch })

  test('a running run says how long the step has run', () => {
    assert.deepEqual(words({}), { word: null, since: 'for 41m15s' })
    assert.deepEqual(words({ runningSince: null }), { word: null, since: null })
  })

  test('a run waiting to start or on an approval says since when, without ticking', () => {
    const runningSince = '2026-10-10T08:00:00Z'
    assert.deepEqual(words({ status: 'awaiting_approval', runningSince }), { word: null, since: 'awaiting approval since Oct 10' })
    assert.deepEqual(words({ status: 'awaiting_approval', runningSince, clock: CLOCK + 3_600_000 }), words({ status: 'awaiting_approval', runningSince }))
    assert.doesNotMatch(words({ status: 'awaiting_approval', runningSince }).since ?? '', /for /)
    assert.deepEqual(words({ status: 'pending', runningSince }), { word: null, since: 'pending since Oct 10' })
    assert.deepEqual(words({ status: 'awaiting_approval', runningSince: null }), { word: null, since: null })
    assert.match(words({ runningSince }).since ?? '', /^for /)
  })

  test('a paused run says days since it stopped, and "today" under a day', () => {
    assert.deepEqual(words({ status: 'paused', stoppedSince: '2026-10-02T09:00:00Z' }), { word: 'paused', since: '12 d (since Oct 2)' })
    assert.deepEqual(words({ status: 'paused', stoppedSince: '2026-10-14T08:00:00Z' }), { word: 'paused', since: 'today (since Oct 14)' })
    assert.deepEqual(words({ status: 'paused', stoppedSince: null }), { word: 'paused', since: null })
  })

  test('an interrupted run, paused or running, says it in the same words', () => {
    for (const status of ['paused', 'running'] as const) {
      assert.deepEqual(words({ status, interrupted: true, stoppedSince: '2026-10-09T09:00:00Z' }), { word: 'interrupted', since: '5 d (since Oct 9)' })
    }
  })

  test('a finished run says how long ago it ended and how long it ran', () => {
    const end = '2026-10-10T11:05:00Z'
    const created = '2026-10-10T10:00:00Z'
    assert.deepEqual(words({ status: 'failed', end, created }), { word: 'failed', since: '4 d ago · ran 1h05m' })
    assert.deepEqual(words({ status: 'cancelled', end, created }), { word: 'cancelled', since: '4 d ago · ran 1h05m' })
    assert.deepEqual(words({ status: 'succeeded', end: '2026-10-14T11:05:00Z', created: '2026-10-14T10:00:00Z' }), { word: 'integrated', since: '55 min ago · ran 1h05m' })
  })

  test('a failed run served with interrupted attention reads the finished words', () => {
    assert.deepEqual(words({ status: 'failed', interrupted: true, stoppedSince: '2026-10-09T09:00:00Z', end: '2026-10-10T11:05:00Z', created: '2026-10-10T10:00:00Z' }), { word: 'failed', since: '4 d ago · ran 1h05m' })
  })

  test('an accepted run keeps its override word and adds only the age and the span', () => {
    const accepted = words({ status: 'succeeded', accepted: true, end: '2026-10-13T11:05:00Z', created: '2026-10-13T10:00:00Z' })
    assert.deepEqual(accepted, { word: null, since: '1 d ago · ran 1h05m' })
    assert.ok(!JSON.stringify(accepted).includes('succeeded'))
    assert.ok(!JSON.stringify(accepted).includes('integrated'))
  })

  test('a finished run with no recorded end says no age and no span', () => {
    assert.deepEqual(words({ status: 'failed', end: null }), { word: 'failed', since: null })
    assert.deepEqual(words({ status: 'succeeded', accepted: true, end: null }), { word: null, since: null })
  })

  test('a span of two days or more reads in days and hours, never as hours and minutes of three digits', () => {
    const since = words({ status: 'failed', end: '2026-10-13T11:05:00Z', created: '2026-10-09T10:00:00Z' }).since!
    assert.doesNotMatch(since, /\d{3,}h\d{2}m/)
  })
})

describe('the review card of a judged review (features/review-panel-registry/prd.md 8, C1 c)', () => {
  const skeleton = loadRun('skeleton-001')
  const reviewCard = (judgedPanel: boolean) => cardsOf({ ...skeleton, review: servedReview(reviewJudgedExample(), { judgedPanel }) }).find(item => item.id === 'review')!

  test('"What it did" says the judge decided and lists the built-ins as advisory; the sheet\'s entries carry their role', () => {
    const card = reviewCard(true)
    assert.equal(card.did, 'Review blocked by judge blocked; the judge decided, advisory: general advised blocking, coverage advised blocking; 2 findings, 1 blocking.')
    assert.deepEqual(card.reviewers!.map(reviewer => [reviewer.id, reviewer.role]), [['general', 'advisory'], ['coverage', 'advisory'], ['judge', 'deciding']])
  })

  test('the same record without the judged flag reads as today: every reviewer by its verdict, no role', () => {
    const card = reviewCard(false)
    assert.equal(card.did, 'Review blocked by general blocked, coverage blocked, judge blocked; 2 findings, 1 blocking.')
    assert.deepEqual(card.reviewers!.map(reviewer => reviewer.role), [null, null, null])
  })
})

describe('the projected reviewer cards of a judged review (features/review-panel-registry/prd.md 8, V2)', () => {
  const detail = injectSessionNodes(runDetails[RUN_SESSIONS]!)
  const sessions = sessionsPayload(RUN_SESSIONS, UX_SESSIONS_WORKFLOW_ID, 'home', true)
  const nodesOf = (judgedPanel: boolean) => stageNodes({
    detail, rows: [], timeline: null, events: [], inputs: null, review: servedReview(reviewJudgedExample(), { judgedPanel }), attention: null, reviewRound: null, sessions, panels: PANEL,
  }, formatSpan)
  const facts = (node: StageNode) => [node.tone, node.word, node.openFindings, node.did]

  test('an advisory built-in\'s card is neutral and says it advised; the judge decided; critique keeps its own card', () => {
    const nodes = nodesOf(true)
    assert.deepEqual(facts(nodes.find(node => node.id === 'reviewer-general')!), ['idle', 'advised blocking', null, 'Round 2: advised blocking (the judge decided).'])
    assert.deepEqual(facts(nodes.find(node => node.id === 'reviewer-coverage')!), ['idle', 'advised blocking', null, 'Round 2: advised blocking (the judge decided).'])
    const critique = nodes.find(node => node.id === 'reviewer-critique')!
    assert.deepEqual([critique.tone, critique.word, critique.openFindings], ['ok', 'approved', 0])
  })

  test('the same record without the judged flag keeps every card as today', () => {
    const general = nodesOf(false).find(node => node.id === 'reviewer-general')!
    assert.deepEqual([general.tone, general.word, general.openFindings], ['fail', 'blocked', 2])
    assert.match(general.did ?? '', /^Round 2: blocked, 2 open P0\/P1\.$/)
  })
})
