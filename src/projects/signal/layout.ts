/**
 * The run stage's layered layout (docs/PRD_VIEWER_REFINE.md 5.2 and the Signal Box design of 2026-10-09): every step sits in
 * the column after its deepest dependency, columns are ordered by the barycentre of their parents (twice, so long edges
 * straighten), and each column is centred on the tallest one. Left to right on a desk, top to bottom on a phone. Pure, so
 * the same definition always yields the same picture and the unit tests can reason about it.
 *
 * A projected repair node (`repair-<n>`) depends on the step it answers, so it lands one column after it; its return mark
 * (the dashed path back to that step) is drawn from `returns`, never as a dependency edge, so the graph stays acyclic.
 */
export type Direction = 'LR' | 'TB'

/** A step to lay out. `rank` orders steps of equal barycentre: pinned steps (0) before the fix loop's repair nodes (1). */
export type StageInput = { id: string; dep: readonly string[]; rank?: number }

export type StagePosition = { id: string; x: number; y: number; col: number; row: number }

export type StageLayout = {
  dir: Direction
  positions: Map<string, StagePosition>
  /** The steps of each column, top to bottom (left to right on a phone). */
  columns: string[][]
  width: number
  height: number
  edges: { from: string; to: string; path: string; todo: boolean }[]
  returns: { from: string; to: string; path: string }[]
}

/** One step's card, at the standard detail level. */
export const NODE_WIDTH = 232
export const NODE_HEIGHT = 136
/** Space between columns (along the flow) and between the rows of a column (across it). */
export const GAP_ALONG = 72
export const GAP_ACROSS = 44

/** Below this stage width the flow runs top to bottom (a phone held upright). */
export const PHONE_STAGE_WIDTH = 720

const RADIUS = 12
/** How far an edge stops short of the step it enters, so the arrowhead stays outside the card. */
const ARROW_INSET = 8

/** The depth of each step: 0 without dependencies, else one more than its deepest parent. An unknown parent counts as depth 0. */
function depths(nodes: readonly StageInput[]): Map<string, number> {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const depth = new Map<string, number>()
  const of = (id: string, trail: Set<string>): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    const node = byId.get(id)
    if (!node || trail.has(id)) return 0
    trail.add(id)
    const value = node.dep.length === 0 ? 0 : 1 + Math.max(...node.dep.map(parent => of(parent, trail)))
    trail.delete(id)
    depth.set(id, value)
    return value
  }
  for (const node of nodes) of(node.id, new Set())
  return depth
}

/** Columns in depth order, each ordered by the mean row of its parents (the rank, then definition order, break ties), twice over. */
export function orderColumns(nodes: readonly StageInput[]): string[][] {
  const depth = depths(nodes)
  const byId = new Map(nodes.map(node => [node.id, node]))
  const columns: string[][] = []
  for (const node of nodes) (columns[depth.get(node.id) ?? 0] ??= []).push(node.id)
  for (let index = 0; index < columns.length; index += 1) columns[index] ??= []
  const row = new Map<string, number>()
  for (let pass = 0; pass < 2; pass += 1) {
    columns.forEach((column, index) => {
      if (index > 0) {
        const centre = (id: string) => {
          const rows = (byId.get(id)?.dep ?? []).map(parent => row.get(parent)).filter((value): value is number => value !== undefined)
          return rows.length === 0 ? Number.POSITIVE_INFINITY : rows.reduce((sum, value) => sum + value, 0) / rows.length
        }
        const order = new Map(column.map((id, position) => [id, position]))
        const rank = (id: string) => byId.get(id)?.rank ?? 0
        column.sort((a, b) => centre(a) - centre(b) || rank(a) - rank(b) || order.get(a)! - order.get(b)!)
      }
      column.forEach((id, position) => row.set(id, position))
    })
  }
  return columns
}

/** The point where an edge leaves (`out`) or enters (`in`) a step. */
function anchor(position: StagePosition, side: 'out' | 'in', dir: Direction): { x: number; y: number } {
  if (dir === 'LR') return side === 'out' ? { x: position.x + NODE_WIDTH, y: position.y + NODE_HEIGHT / 2 } : { x: position.x, y: position.y + NODE_HEIGHT / 2 }
  return side === 'out' ? { x: position.x + NODE_WIDTH / 2, y: position.y + NODE_HEIGHT } : { x: position.x + NODE_WIDTH / 2, y: position.y }
}

const round = (value: number) => Math.round(value * 100) / 100

/** An orthogonal edge with rounded elbows: straight when the two steps share a row, else one bend in the gap before the target. */
export function elbow(a: { x: number; y: number }, b: { x: number; y: number }, dir: Direction): string {
  if (dir === 'LR') {
    if (Math.abs(a.y - b.y) < 1) return `M${round(a.x)} ${round(a.y)}H${round(b.x - ARROW_INSET)}`
    const middle = b.x - GAP_ALONG / 2
    const sign = b.y > a.y ? 1 : -1
    const radius = Math.min(RADIUS, Math.abs(b.y - a.y) / 2)
    return `M${round(a.x)} ${round(a.y)}H${round(middle - radius)}Q${round(middle)} ${round(a.y)} ${round(middle)} ${round(a.y + sign * radius)}V${round(b.y - sign * radius)}Q${round(middle)} ${round(b.y)} ${round(middle + radius)} ${round(b.y)}H${round(b.x - ARROW_INSET)}`
  }
  if (Math.abs(a.x - b.x) < 1) return `M${round(a.x)} ${round(a.y)}V${round(b.y - ARROW_INSET)}`
  const middle = b.y - GAP_ACROSS * 0.8
  const sign = b.x > a.x ? 1 : -1
  const radius = Math.min(RADIUS, Math.abs(b.x - a.x) / 2)
  return `M${round(a.x)} ${round(a.y)}V${round(middle - radius)}Q${round(a.x)} ${round(middle)} ${round(a.x + sign * radius)} ${round(middle)}H${round(b.x - sign * radius)}Q${round(b.x)} ${round(middle)} ${round(b.x)} ${round(middle + radius)}V${round(b.y - ARROW_INSET)}`
}

/** A return mark: a curve from under (beside, on a phone) the repair node back to the step it re-enters. */
function returnPath(from: StagePosition, to: StagePosition, dir: Direction): string {
  if (dir === 'LR') {
    const ax = from.x + NODE_WIDTH / 2, ay = from.y + NODE_HEIGHT, bx = to.x + NODE_WIDTH / 2, by = to.y + NODE_HEIGHT
    return `M${round(ax)} ${round(ay)}C${round(ax)} ${round(ay + 70)} ${round(bx)} ${round(by + 70)} ${round(bx)} ${round(by + 6)}`
  }
  const ax = from.x + NODE_WIDTH, ay = from.y + NODE_HEIGHT / 2, bx = to.x + NODE_WIDTH, by = to.y + NODE_HEIGHT / 2
  return `M${round(ax)} ${round(ay)}C${round(ax + 60)} ${round(ay)} ${round(bx + 60)} ${round(by)} ${round(bx + 6)} ${round(by)}`
}

export type LayoutOptions = {
  dir: Direction
  /** Steps that have not started: their edges are drawn dashed. */
  pending?: ReadonlySet<string>
  /** Return marks of the fix loop: `from` the repair node, `to` the step it re-enters. Unknown ids are left out. */
  returns?: readonly { from: string; to: string }[]
}

export function layoutStage(nodes: readonly StageInput[], { dir, pending = new Set(), returns = [] }: LayoutOptions): StageLayout {
  const columns = orderColumns(nodes)
  const tallest = Math.max(1, ...columns.map(column => column.length))
  const positions = new Map<string, StagePosition>()
  const along = dir === 'LR' ? NODE_WIDTH + GAP_ALONG : NODE_HEIGHT + GAP_ACROSS * 1.6
  const across = dir === 'LR' ? NODE_HEIGHT + GAP_ACROSS : NODE_WIDTH + GAP_ALONG * 0.4
  columns.forEach((column, col) => {
    const offset = (tallest - column.length) / 2
    column.forEach((id, row) => {
      const main = col * along
      const cross = (row + offset) * across
      positions.set(id, dir === 'LR' ? { id, x: main, y: cross, col, row } : { id, x: cross, y: main, col, row })
    })
  })
  let width = 0
  let height = 0
  for (const position of positions.values()) {
    width = Math.max(width, position.x + NODE_WIDTH)
    height = Math.max(height, position.y + NODE_HEIGHT)
  }
  const edges: StageLayout['edges'] = []
  for (const node of nodes) {
    const to = positions.get(node.id)
    if (!to) continue
    for (const parent of node.dep) {
      const from = positions.get(parent)
      if (!from) continue
      edges.push({ from: parent, to: node.id, path: elbow(anchor(from, 'out', dir), anchor(to, 'in', dir), dir), todo: pending.has(parent) || pending.has(node.id) })
    }
  }
  const marks: StageLayout['returns'] = []
  for (const mark of returns) {
    const from = positions.get(mark.from)
    const to = positions.get(mark.to)
    if (from && to) marks.push({ from: mark.from, to: mark.to, path: returnPath(from, to, dir) })
  }
  return { dir, positions, columns, width, height, edges, returns: marks }
}

/**
 * The step an arrow key reaches from `id`: along the flow, the nearest step of the next or previous column; across it, the
 * neighbour row of the same column. Null at the edge of the picture.
 */
export function stepFrom(layout: StageLayout, id: string, key: 'ArrowRight' | 'ArrowLeft' | 'ArrowDown' | 'ArrowUp'): string | null {
  const position = layout.positions.get(id)
  if (!position) return null
  const along: Partial<Record<typeof key, number>> = layout.dir === 'LR' ? { ArrowRight: 1, ArrowLeft: -1 } : { ArrowDown: 1, ArrowUp: -1 }
  const across: Partial<Record<typeof key, number>> = layout.dir === 'LR' ? { ArrowDown: 1, ArrowUp: -1 } : { ArrowRight: 1, ArrowLeft: -1 }
  const sideways = across[key]
  if (sideways !== undefined) {
    const column = layout.columns[position.col]
    return column[position.row + sideways] ?? null
  }
  const column = layout.columns[position.col + (along[key] ?? 0)]
  if (!column) return null
  const mine = layout.dir === 'LR' ? position.y : position.x
  let best: string | null = null
  let distance = Number.POSITIVE_INFINITY
  for (const candidate of column) {
    const other = layout.positions.get(candidate)!
    const gap = Math.abs((layout.dir === 'LR' ? other.y : other.x) - mine)
    if (gap < distance) {
      distance = gap
      best = candidate
    }
  }
  return best
}
