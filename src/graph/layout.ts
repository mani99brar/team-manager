import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force'
import type { GraphEdge, GraphNode, NodeKind, Source } from './model.ts'

export type Point = { x: number; y: number }

export type SimNode = SimulationNodeDatum & {
  id: string
  kind: NodeKind
  source: Source
  parentId: string | null
  x: number
  y: number
}

type SimLink = SimulationLinkDatum<SimNode> & { source: SimNode; target: SimNode }

/** Drawn radius of each node type; also used to trim edges. */
export const NODE_RADIUS: Record<NodeKind, number> = { source: 30, directory: 20, file: 14 }
/** Personal space for collision avoidance, leaving room for the label below the shape. */
const COLLIDE_RADIUS: Record<NodeKind, number> = { source: 54, directory: 42, file: 34 }
const CHARGE: Record<NodeKind, number> = { source: -700, directory: -380, file: -160 }
/** Each source cluster is gently pulled to its own side so Pi and Claude stay recognisable. */
const SOURCE_ANCHOR: Record<Source, Point> = { Pi: { x: -180, y: 0 }, Claude: { x: 180, y: 0 } }
const ALPHA_MIN = 0.02
const MAX_SYNC_TICKS = 400

function linkDistance(link: SimLink): number {
  if (link.source.kind === 'source') return 130
  return link.target.kind === 'file' ? 80 : 105
}

/**
 * Owns the force simulation and every node position for the session. Positions of hidden nodes are
 * remembered so that expanding, collapsing and refreshing never rearranges unrelated parts of the graph.
 */
export class GraphLayout {
  private readonly nodes = new Map<string, SimNode>()
  private readonly pinned = new Set<string>()
  private readonly simulation: Simulation<SimNode, SimLink>
  private readonly listeners = new Set<() => void>()
  private visibleIds: string[] = []
  private hasLaidOut = false
  private synchronous: boolean

  constructor(options: { synchronous: boolean }) {
    this.synchronous = options.synchronous
    this.simulation = forceSimulation<SimNode>([])
      .stop()
      .alphaMin(ALPHA_MIN)
      .alphaDecay(0.05)
      .force('link', forceLink<SimNode, SimLink>([]).id(node => node.id).distance(linkDistance).strength(0.9))
      .force('charge', forceManyBody<SimNode>().strength(node => CHARGE[node.kind]).distanceMax(520))
      .force('collide', forceCollide<SimNode>().radius(node => COLLIDE_RADIUS[node.kind]).strength(0.9).iterations(2))
      .force('x', forceX<SimNode>(node => SOURCE_ANCHOR[node.source].x).strength(0.03))
      .force('y', forceY<SimNode>(node => SOURCE_ANCHOR[node.source].y).strength(0.03))
      .on('tick', () => this.notify())
      .on('end', () => this.notify())
  }

  /** Synchronous mode settles the layout instantly (reduced motion, tests) instead of animating ticks. */
  setSynchronous(value: boolean) {
    this.synchronous = value
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify() {
    for (const listener of this.listeners) listener()
  }

  node(id: string): SimNode | undefined {
    return this.nodes.get(id)
  }

  isPinned(id: string): boolean {
    return this.pinned.has(id)
  }

  /** Aligns the simulation with the currently visible nodes. New nodes appear beside their parent. */
  sync(visible: readonly GraphNode[], edges: readonly GraphEdge[]) {
    const previous = this.visibleIds
    const nextIds = visible.map(node => node.id)
    const unchanged = previous.length === nextIds.length && previous.every((id, i) => id === nextIds[i])
    if (unchanged && this.hasLaidOut) return
    const previouslyVisible = new Set(previous)
    const siblingCounter = new Map<string, number>()
    const simNodes: SimNode[] = []
    for (const node of visible) {
      let sim = this.nodes.get(node.id)
      if (!sim) {
        sim = { id: node.id, kind: node.kind, source: node.source, parentId: node.parentId, x: 0, y: 0 }
        this.nodes.set(node.id, sim)
        this.place(sim, siblingCounter)
      } else if (!previouslyVisible.has(node.id) && !this.pinned.has(node.id)) {
        this.place(sim, siblingCounter)
      }
      simNodes.push(sim)
    }
    const links: SimLink[] = []
    for (const edge of edges) {
      const source = this.nodes.get(edge.parentId)
      const target = this.nodes.get(edge.childId)
      if (source && target) links.push({ source, target })
    }
    this.visibleIds = nextIds
    this.simulation.nodes(simNodes)
    this.simulation.force<ReturnType<typeof forceLink<SimNode, SimLink>>>('link')!.links(links)
    // The very first layout has nothing to transition from, so it always settles instantly.
    this.run(this.hasLaidOut ? 0.6 : 1, !this.hasLaidOut)
    this.hasLaidOut = true
  }

  /** Deterministic placement: fan children out on the side of the parent facing away from the grandparent. */
  private place(sim: SimNode, siblingCounter: Map<string, number>) {
    if (sim.parentId === null) {
      const anchor = SOURCE_ANCHOR[sim.source]
      sim.x = anchor.x
      sim.y = anchor.y
      return
    }
    const parent = this.nodes.get(sim.parentId)
    if (!parent) return
    const index = siblingCounter.get(parent.id) ?? 0
    siblingCounter.set(parent.id, index + 1)
    const grandparent = parent.parentId ? this.nodes.get(parent.parentId) : undefined
    const base = grandparent ? Math.atan2(parent.y - grandparent.y, parent.x - grandparent.x) : -Math.PI / 2
    const angle = base + (index * 2.399963) // golden angle keeps siblings spread without randomness
    const distance = 60 + (index % 3) * 18
    sim.x = parent.x + Math.cos(angle) * distance
    sim.y = parent.y + Math.sin(angle) * distance
    sim.vx = 0
    sim.vy = 0
  }

  private run(alpha: number, forceSynchronous = false) {
    this.simulation.alpha(alpha)
    if (this.synchronous || forceSynchronous) {
      this.simulation.stop()
      for (let i = 0; i < MAX_SYNC_TICKS && this.simulation.alpha() > ALPHA_MIN; i += 1) this.simulation.tick()
      this.notify()
    } else {
      this.simulation.restart()
    }
  }

  /** Moves a node while it is being dragged. The node becomes pinned; the rest of the graph waits. */
  drag(id: string, point: Point) {
    const sim = this.nodes.get(id)
    if (!sim) return
    this.simulation.stop()
    sim.x = sim.fx = point.x
    sim.y = sim.fy = point.y
    sim.vx = 0
    sim.vy = 0
    this.pinned.add(id)
    this.notify()
  }

  /** After a drop, neighbours settle around the pinned node. */
  endDrag() {
    this.run(0.3)
  }

  pin(id: string) {
    const sim = this.nodes.get(id)
    if (!sim) return
    sim.fx = sim.x
    sim.fy = sim.y
    this.pinned.add(id)
    this.notify()
  }

  unpin(id: string) {
    const sim = this.nodes.get(id)
    if (!sim || !this.pinned.has(id)) return
    sim.fx = null
    sim.fy = null
    this.pinned.delete(id)
    this.run(0.3)
  }

  togglePin(id: string) {
    if (this.pinned.has(id)) this.unpin(id)
    else this.pin(id)
  }

  /** Forget nodes that no longer exist after a refresh. */
  prune(existing: ReadonlySet<string>) {
    for (const id of this.nodes.keys()) {
      if (!existing.has(id)) {
        this.nodes.delete(id)
        this.pinned.delete(id)
      }
    }
  }

  /** Clears pins and remembered positions. */
  reset() {
    this.simulation.stop()
    this.nodes.clear()
    this.pinned.clear()
    this.visibleIds = []
    this.hasLaidOut = false
    this.notify()
  }

  dispose() {
    this.simulation.stop()
  }
}
