/**
 * The compact geometry of the definition graph (docs/PRD_VIEWER_REVAMP.md 5.3), as the feature page's picture and the
 * WorkflowGraph component draw it. Pure (no React), so the graph and the tests agree.
 */
import { DAG_PADDING, type DagLayout } from '../dag.ts'

/** The graph scales down to this share of its width before its box scrolls sideways (docs/PRD_VIEWER_UX.md 10). */
export const GRAPH_MIN_SCALE = 0.83
/** The compact geometry: node width, the gap between columns, and the label's line length in characters. */
export const COMPACT_GRAPH = { width: 112, gap: 16, chars: 14 }

/** The layout's columns redrawn with narrower nodes and gaps; rows, heights and edges are the layout's own. */
export function compactLayout(layout: DagLayout): DagLayout {
  const positions = new Map([...layout.positions].map(([id, position]) => [id, { ...position, x: DAG_PADDING + position.column * (COMPACT_GRAPH.width + COMPACT_GRAPH.gap) }]))
  const width = DAG_PADDING * 2 + Math.max(layout.columns, 1) * COMPACT_GRAPH.width + Math.max(layout.columns - 1, 0) * COMPACT_GRAPH.gap
  return { ...layout, positions, width }
}
