/**
 * The run page's board geometry (docs/PRD_VIEWER_REVAMP.md 5.3): the compact graph the Pipeline draws beside the Steps, and the
 * width the board needs before the two sit side by side. Pure (no React), so the graph, the run page and the tests agree.
 */
import { DAG_PADDING, layoutDag, type DagLayout, type DagNode } from '../dag.ts'

/** The graph scales down to this share of its width before its box scrolls sideways (docs/PRD_VIEWER_UX.md 10). */
export const GRAPH_MIN_SCALE = 0.83
/** The compact geometry: node width, the gap between columns, and the label's line length in characters. */
export const COMPACT_GRAPH = { width: 112, gap: 16, chars: 14 }
/** What the graph's box adds around the picture: its padding and border. */
const GRAPH_FRAME = 10
/** The Steps column's narrowest width beside the Pipeline, and the gap between the two. */
export const STEPS_MIN_WIDTH = 400
const BOARD_GAP = 16

/** The layout's columns redrawn with narrower nodes and gaps; rows, heights and edges are the layout's own. */
export function compactLayout(layout: DagLayout): DagLayout {
  const positions = new Map([...layout.positions].map(([id, position]) => [id, { ...position, x: DAG_PADDING + position.column * (COMPACT_GRAPH.width + COMPACT_GRAPH.gap) }]))
  const width = DAG_PADDING * 2 + Math.max(layout.columns, 1) * COMPACT_GRAPH.width + Math.max(layout.columns - 1, 0) * COMPACT_GRAPH.gap
  return { ...layout, positions, width }
}

/** The board width from which the compact graph, at its floor, and the Steps fit side by side. */
export function boardSplitWidth(nodes: DagNode[]): number {
  return Math.round(compactLayout(layoutDag(nodes)).width * GRAPH_MIN_SCALE) + GRAPH_FRAME + BOARD_GAP + STEPS_MIN_WIDTH
}
