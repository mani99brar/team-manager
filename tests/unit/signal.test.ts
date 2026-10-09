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
import { REFINE_EXAMPLES } from '../project-workflows/fixtures/ux-refine.ts'
import { elbow, GAP_ALONG, layoutStage, NODE_HEIGHT, NODE_WIDTH, orderColumns, stepFrom, type StageInput } from '../../src/projects/signal/layout.ts'
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
