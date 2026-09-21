/**
 * Deterministic layered layout for a workflow DAG: each node sits in the column after its deepest
 * dependency, rows are assigned in definition order. Pure, so the same definition always yields the same
 * picture and tests can reason about it. Cycles are impossible here because definitions are validated first.
 */
export type DagNode = { node_id: string; depends_on: string[] }

export type DagPosition = { id: string; column: number; row: number; x: number; y: number }

export type DagLayout = {
  positions: Map<string, DagPosition>
  columns: number
  rows: number
  width: number
  height: number
  edges: { from: string; to: string }[]
}

export const DAG_NODE_WIDTH = 150
export const DAG_NODE_HEIGHT = 56
export const DAG_COLUMN_GAP = 64
export const DAG_ROW_GAP = 24
export const DAG_PADDING = 16

export function layoutDag(nodes: DagNode[]): DagLayout {
  const depth = new Map<string, number>()
  const byId = new Map(nodes.map(node => [node.node_id, node]))
  function depthOf(id: string, trail: Set<string>): number {
    const known = depth.get(id)
    if (known !== undefined) return known
    const node = byId.get(id)
    if (!node || trail.has(id)) return 0
    trail.add(id)
    const value = node.depends_on.length === 0 ? 0 : 1 + Math.max(...node.depends_on.map(parent => depthOf(parent, trail)))
    trail.delete(id)
    depth.set(id, value)
    return value
  }
  const rowsPerColumn = new Map<number, number>()
  const positions = new Map<string, DagPosition>()
  for (const node of nodes) {
    const column = depthOf(node.node_id, new Set())
    const row = rowsPerColumn.get(column) ?? 0
    rowsPerColumn.set(column, row + 1)
    positions.set(node.node_id, { id: node.node_id, column, row, x: 0, y: 0 })
  }
  const columns = rowsPerColumn.size === 0 ? 0 : Math.max(...rowsPerColumn.keys()) + 1
  const rows = rowsPerColumn.size === 0 ? 0 : Math.max(...rowsPerColumn.values())
  const height = DAG_PADDING * 2 + Math.max(rows, 1) * DAG_NODE_HEIGHT + Math.max(rows - 1, 0) * DAG_ROW_GAP
  for (const position of positions.values()) {
    const count = rowsPerColumn.get(position.column) ?? 1
    const columnHeight = count * DAG_NODE_HEIGHT + (count - 1) * DAG_ROW_GAP
    const top = (height - columnHeight) / 2
    position.x = DAG_PADDING + position.column * (DAG_NODE_WIDTH + DAG_COLUMN_GAP)
    position.y = top + position.row * (DAG_NODE_HEIGHT + DAG_ROW_GAP)
  }
  const width = DAG_PADDING * 2 + Math.max(columns, 1) * DAG_NODE_WIDTH + Math.max(columns - 1, 0) * DAG_COLUMN_GAP
  const edges: { from: string; to: string }[] = []
  for (const node of nodes) {
    for (const parent of node.depends_on) if (byId.has(parent)) edges.push({ from: parent, to: node.node_id })
  }
  return { positions, columns, rows, width, height, edges }
}
