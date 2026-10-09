/**
 * The layered layout with the fix loop's repair nodes (src/projects/dag.ts, docs/PRD_VIEWER_REFINE.md 5.2): a repair node
 * sits in the column of the step it answers, in a row below that step's lane rows, so the pinned rows never reshuffle and a
 * two-lane, two-round run keeps eight columns, which still fit the run page's box at 1440 px.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DAG_COLUMN_GAP, DAG_NODE_WIDTH, DAG_PADDING, isRepairNode, layoutDag, type DagNode } from '../../src/projects/dag.ts'
import { REFINE_EXAMPLES, reviewAttemptOf } from '../../tests/project-workflows/fixtures/ux-refine.ts'
import { validateRunDetail } from '../../contracts/projects/v1.ts'

/** The two-lane pinned graph (`launch_<lane>`, `handoff`, `verify_<lane>`, candidate, review, approval, integrate). */
const TWO_LANE: DagNode[] = [
  { node_id: 'launch_viewer', depends_on: [] },
  { node_id: 'launch_shell', depends_on: [] },
  { node_id: 'handoff', depends_on: ['launch_viewer', 'launch_shell'] },
  { node_id: 'verify_viewer', depends_on: ['handoff'] },
  { node_id: 'verify_shell', depends_on: ['handoff'] },
  { node_id: 'candidate', depends_on: ['verify_viewer', 'verify_shell'] },
  { node_id: 'review', depends_on: ['candidate'] },
  { node_id: 'approval', depends_on: ['review'] },
  { node_id: 'integrate', depends_on: ['approval'] },
]

/** The server inserts each `repair-<n>` right after the step it answers, in definition order. */
function withRepairs(base: DagNode[], repairs: { n: number; step: string }[]): DagNode[] {
  return base.flatMap(node => [
    node,
    ...repairs.filter(repair => repair.step === node.node_id).sort((a, b) => a.n - b.n).map(repair => ({ node_id: `repair-${repair.n}`, depends_on: [repair.step] })),
  ])
}

describe('isRepairNode', () => {
  test('matches only repair-<n> ids', () => {
    assert.equal(isRepairNode('repair-1'), true)
    assert.equal(isRepairNode('repair-12'), true)
    assert.equal(isRepairNode('verify_viewer'), false)
    assert.equal(isRepairNode('repair-0'), false)
  })
})

describe('layoutDag with repair nodes', () => {
  test('the worked example: repair-1 after verify_viewer, repair-2 after review, no new column, rows below the pinned step', () => {
    const nodes = withRepairs(TWO_LANE, [{ n: 1, step: 'verify_viewer' }, { n: 2, step: 'review' }])
    assert.equal(nodes.length, 11)
    const layout = layoutDag(nodes)
    const at = (id: string) => layout.positions.get(id)!
    // A repair shares its step's successor column but never grows the column count: 7 columns for the two-lane graph.
    assert.equal(layout.columns, 7)
    assert.equal(at('repair-1').column, at('candidate').column)
    assert.equal(at('repair-2').column, at('approval').column)
    // The pinned node keeps row 0 of its column; the repair takes the row beneath it.
    assert.ok(at('repair-1').row > at('candidate').row)
    assert.ok(at('repair-2').row > at('approval').row)
  })

  test('a two-lane, two-round run keeps 8 columns (15 nodes) and fits the 1440 px box', () => {
    // A guarded run (design challenge first) with repairs at both verifies, the candidate and two review rounds.
    const guarded: DagNode[] = [
      { node_id: 'challenge', depends_on: [] },
      ...TWO_LANE.map(node => (node.node_id.startsWith('launch_') ? { ...node, depends_on: ['challenge'] } : node)),
    ]
    const nodes = withRepairs(guarded, [
      { n: 1, step: 'verify_viewer' }, { n: 2, step: 'verify_shell' }, { n: 3, step: 'candidate' }, { n: 4, step: 'review' }, { n: 5, step: 'review' },
    ])
    assert.equal(nodes.length, 15)
    const layout = layoutDag(nodes)
    assert.equal(layout.columns, 8)
    // Eight columns are 1,316 px wide, inside the run page's box at 1440 px.
    assert.equal(layout.width, DAG_PADDING * 2 + 8 * DAG_NODE_WIDTH + 7 * DAG_COLUMN_GAP)
    assert.equal(layout.width, 1316)
    assert.ok(layout.width < 1440)
    // Every repair is below the pinned rows of its column (they come after the pinned steps in row order).
    for (const id of ['repair-1', 'repair-2', 'repair-3', 'repair-4', 'repair-5']) {
      const repair = layout.positions.get(id)!
      const pinnedRowsInColumn = nodes
        .filter(node => !isRepairNode(node.node_id) && layout.positions.get(node.node_id)!.column === repair.column)
        .map(node => layout.positions.get(node.node_id)!.row)
      for (const row of pinnedRowsInColumn) assert.ok(repair.row > row, `${id} sits below its column's pinned rows`)
    }
  })

  test('a definition with no repair nodes lays out exactly as before', () => {
    const layout = layoutDag(TWO_LANE)
    assert.equal(layout.columns, 7)
    assert.equal(layout.positions.get('launch_viewer')!.row, 0)
    assert.equal(layout.positions.get('launch_shell')!.row, 1)
  })
})

describe('projectDetail mirrors the server projection (drift guard, docs/PRD_VIEWER_REFINE Appendix A)', () => {
  test('the three example records project to a valid detail with the server invariants', () => {
    for (const { detail, loop } of REFINE_EXAMPLES) {
      // Re-validation: the projected detail is a strict runDetail.
      assert.doesNotThrow(() => validateRunDetail(detail))
      // The definition and the snapshot carry exactly the same nodes.
      const defIds = detail.definition.nodes.map(node => node.node_id)
      const snapIds = detail.snapshot.nodes.map(node => node.node_id)
      assert.deepEqual(defIds, snapIds)
      // The run status equals the snapshot's status (folded from the pinned steps only).
      assert.equal(detail.summary.status, detail.snapshot.status)
      // Every session repair of the loop is a projected node of the right status.
      const statusOf = new Map(detail.snapshot.nodes.map(node => [node.node_id, node.status]))
      for (const repair of loop.repairs) {
        assert.ok(defIds.includes(repair.node_id), `${repair.node_id} is a definition node`)
        const expected = repair.status === 'applied' ? 'succeeded' : repair.status === 'blocked' ? 'failed' : 'running'
        assert.equal(statusOf.get(repair.node_id), expected)
      }
    }
  })

  test('the worked example: repairs succeeded, run succeeded, review at round 2; the restored example failed', () => {
    const byRun = new Map(REFINE_EXAMPLES.map(example => [example.runId, example]))
    const done = byRun.get('run-loop-done')!.detail
    assert.equal(done.summary.status, 'succeeded')
    const status = new Map(done.snapshot.nodes.map(node => [node.node_id, node.status]))
    assert.equal(status.get('repair-1'), 'succeeded')
    assert.equal(status.get('repair-2'), 'succeeded')
    assert.equal(done.snapshot.nodes.find(node => node.node_id === 'review')!.attempt, reviewAttemptOf(byRun.get('run-loop-done')!.loop, 2))

    const restored = byRun.get('run-loop-restored')!.detail
    assert.equal(restored.summary.status, 'failed')
    assert.equal(new Map(restored.snapshot.nodes.map(node => [node.node_id, node.status])).get('repair-1'), 'failed')

    const running = byRun.get('run-loop-running')!.detail
    assert.equal(running.summary.status, 'running')
    // The review step is re-entered while the round's repair runs.
    assert.equal(running.snapshot.nodes.find(node => node.node_id === 'review')!.status, 'running')
    assert.equal(new Map(running.snapshot.nodes.map(node => [node.node_id, node.status])).get('repair-2'), 'running')
  })
})
