import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { childCounts, describeCounts, type GraphEdge, type GraphNode, type TreeIndex } from './model.ts'
import { GraphLayout, NODE_RADIUS, type Point } from './layout.ts'
import { wrapLabel } from './labels.ts'

export type ViewRequest = { token: number; type: 'fit' } | { token: number; type: 'reveal'; id: string }

export type GraphCanvasHandle = { zoomIn(): void; zoomOut(): void; fit(): void }

type Props = {
  layout: GraphLayout
  index: TreeIndex
  nodes: GraphNode[]
  edges: GraphEdge[]
  expanded: ReadonlySet<string>
  selectedId: string | null
  viewRequest: ViewRequest | null
  onSelect: (node: GraphNode) => void
  onToggleExpand: (node: GraphNode) => void
  onTogglePin: (node: GraphNode) => void
}

type View = { x: number; y: number; k: number }

const MIN_ZOOM = 0.15
const MAX_ZOOM = 3
const DRAG_THRESHOLD = 4
const FIT_PADDING = 70

function clampZoom(k: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k))
}

type NodeBox = { halfWidth: number; top: number; bottom: number }

/** Distance from a node's centre to the edge of its box (shape plus label) along a unit direction. */
function reach(box: NodeBox, ux: number, uy: number): number {
  const tx = Math.abs(ux) < 1e-6 ? Infinity : box.halfWidth / Math.abs(ux)
  const ty = Math.abs(uy) < 1e-6 ? Infinity : (uy > 0 ? box.bottom : box.top) / Math.abs(uy)
  return Math.min(tx, ty)
}

/** Edge endpoints trimmed so lines stop at the shapes and their labels, leaving room for the arrowhead. */
function edgeGeometry(parent: Point, child: Point, parentBox: NodeBox, childBox: NodeBox) {
  const dx = child.x - parent.x
  const dy = child.y - parent.y
  const length = Math.hypot(dx, dy) || 1
  const ux = dx / length
  const uy = dy / length
  const start = Math.min(reach(parentBox, ux, uy), length / 2)
  const end = Math.min(reach(childBox, -ux, -uy) + 5, length / 2)
  return { x1: parent.x + ux * start, y1: parent.y + uy * start, x2: child.x - ux * end, y2: child.y - uy * end }
}

function nodeBox(node: GraphNode, labelLines: number): NodeBox {
  const radius = NODE_RADIUS[node.kind]
  if (node.kind === 'source') return { halfWidth: radius, top: radius, bottom: radius }
  return { halfWidth: Math.max(radius, 36), top: radius, bottom: radius + 6 + labelLines * 13 }
}

export const GraphCanvas = forwardRef<GraphCanvasHandle, Props>(function GraphCanvas(props, ref) {
  const { layout, index, nodes, edges, expanded, selectedId, viewRequest, onSelect, onToggleExpand, onTogglePin } = props
  const svgRef = useRef<SVGSVGElement>(null)
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 })
  const viewRef = useRef(view)
  useLayoutEffect(() => { viewRef.current = view }, [view])
  const [, rerender] = useReducer((count: number) => count + 1, 0)
  const pointers = useRef(new Map<number, Point>())
  const drag = useRef<{ id: string; pointerId: number; start: Point; offset: Point; moved: boolean } | null>(null)
  const suppressClick = useRef(false)

  useEffect(() => layout.subscribe(rerender), [layout])
  useLayoutEffect(() => { layout.sync(nodes, edges) }, [layout, nodes, edges])

  const size = useCallback(() => {
    const rect = svgRef.current?.getBoundingClientRect()
    return { width: rect?.width ?? 0, height: rect?.height ?? 0 }
  }, [])

  const toWorld = useCallback((clientX: number, clientY: number): Point => {
    const rect = svgRef.current!.getBoundingClientRect()
    const { x, y, k } = viewRef.current
    return { x: (clientX - rect.left - x) / k, y: (clientY - rect.top - y) / k }
  }, [])

  const zoomAt = useCallback((screen: Point, factor: number) => {
    setView(current => {
      const k = clampZoom(current.k * factor)
      const ratio = k / current.k
      return { k, x: screen.x - (screen.x - current.x) * ratio, y: screen.y - (screen.y - current.y) * ratio }
    })
  }, [])

  const fit = useCallback(() => {
    const { width, height } = size()
    const points = nodes.map(node => layout.node(node.id)).filter((node): node is NonNullable<typeof node> => node !== undefined)
    if (!width || !height || points.length === 0) return
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const point of points) {
      minX = Math.min(minX, point.x - FIT_PADDING)
      maxX = Math.max(maxX, point.x + FIT_PADDING)
      minY = Math.min(minY, point.y - FIT_PADDING)
      maxY = Math.max(maxY, point.y + FIT_PADDING)
    }
    const k = clampZoom(Math.min(width / (maxX - minX), height / (maxY - minY), 1.25))
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    setView({ k, x: width / 2 - cx * k, y: height / 2 - cy * k })
  }, [layout, nodes, size])

  const ensureVisible = useCallback((id: string) => {
    const node = layout.node(id)
    const { width, height } = size()
    if (!node || !width || !height) return
    setView(current => {
      const sx = node.x * current.k + current.x
      const sy = node.y * current.k + current.y
      const margin = 80
      if (sx > margin && sx < width - margin && sy > margin && sy < height - margin) return current
      return { ...current, x: width / 2 - node.x * current.k, y: height / 2 - node.y * current.k }
    })
  }, [layout, size])

  useImperativeHandle(ref, () => ({
    fit,
    zoomIn: () => { const { width, height } = size(); zoomAt({ x: width / 2, y: height / 2 }, 1.3) },
    zoomOut: () => { const { width, height } = size(); zoomAt({ x: width / 2, y: height / 2 }, 1 / 1.3) },
  }), [fit, size, zoomAt])

  // Fit once on mount; afterwards only explicit requests move the viewport.
  const mounted = useRef(false)
  useEffect(() => {
    if (mounted.current) return
    mounted.current = true
    fit()
  }, [fit])

  const handledRequest = useRef(0)
  useEffect(() => {
    if (!viewRequest || viewRequest.token === handledRequest.current) return
    handledRequest.current = viewRequest.token
    if (viewRequest.type === 'fit') fit()
    else ensureVisible(viewRequest.id)
  }, [viewRequest, fit, ensureVisible])

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = svg.getBoundingClientRect()
      const factor = Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0025))
      zoomAt({ x: event.clientX - rect.left, y: event.clientY - rect.top }, factor)
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  // ---- Background panning and pinch zoom ----
  const onBackgroundPointerDown = (event: ReactPointerEvent<SVGElement>) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onBackgroundPointerMove = (event: ReactPointerEvent<SVGElement>) => {
    const previous = pointers.current.get(event.pointerId)
    if (!previous) return
    const next = { x: event.clientX, y: event.clientY }
    if (pointers.current.size === 1) {
      setView(current => ({ ...current, x: current.x + next.x - previous.x, y: current.y + next.y - previous.y }))
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.entries()]
      const other = a[0] === event.pointerId ? b[1] : a[1]
      const rect = svgRef.current!.getBoundingClientRect()
      const oldDistance = Math.hypot(previous.x - other.x, previous.y - other.y) || 1
      const newDistance = Math.hypot(next.x - other.x, next.y - other.y) || 1
      const oldMid = { x: (previous.x + other.x) / 2 - rect.left, y: (previous.y + other.y) / 2 - rect.top }
      const newMid = { x: (next.x + other.x) / 2 - rect.left, y: (next.y + other.y) / 2 - rect.top }
      setView(current => {
        const k = clampZoom(current.k * (newDistance / oldDistance))
        const ratio = k / current.k
        return { k, x: newMid.x - (oldMid.x - current.x) * ratio, y: newMid.y - (oldMid.y - current.y) * ratio }
      })
    }
    pointers.current.set(event.pointerId, next)
  }
  const onBackgroundPointerEnd = (event: ReactPointerEvent<SVGElement>) => {
    pointers.current.delete(event.pointerId)
  }

  // ---- Node dragging ----
  const onNodePointerDown = (node: GraphNode) => (event: ReactPointerEvent<SVGGElement>) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return
    const position = layout.node(node.id)
    if (!position) return
    const world = toWorld(event.clientX, event.clientY)
    drag.current = {
      id: node.id,
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      offset: { x: position.x - world.x, y: position.y - world.y },
      moved: false,
    }
    suppressClick.current = false
    event.currentTarget.setPointerCapture(event.pointerId)
    event.stopPropagation()
  }
  const onNodePointerMove = (event: ReactPointerEvent<SVGGElement>) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    if (!current.moved) {
      if (Math.hypot(event.clientX - current.start.x, event.clientY - current.start.y) < DRAG_THRESHOLD) return
      current.moved = true
      suppressClick.current = true
    }
    const world = toWorld(event.clientX, event.clientY)
    layout.drag(current.id, { x: world.x + current.offset.x, y: world.y + current.offset.y })
  }
  const onNodePointerEnd = (event: ReactPointerEvent<SVGGElement>) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    drag.current = null
    if (current.moved) layout.endDrag()
  }
  const onNodeClick = (node: GraphNode) => () => {
    if (suppressClick.current) { suppressClick.current = false; return }
    if (node.kind !== 'file') onSelect(node)
  }
  const onNodeKeyDown = (node: GraphNode) => (event: KeyboardEvent<SVGGElement>) => {
    const isFolder = node.kind !== 'file'
    switch (event.key) {
      case 'Enter':
      case ' ':
        if (isFolder) onSelect(node)
        break
      case 'ArrowRight':
        if (isFolder && !expanded.has(node.id)) onToggleExpand(node)
        break
      case 'ArrowLeft':
        if (isFolder && expanded.has(node.id)) onToggleExpand(node)
        break
      case 'p':
      case 'P':
        onTogglePin(node)
        break
      default:
        return
    }
    event.preventDefault()
  }
  const stop = (event: ReactPointerEvent) => event.stopPropagation()
  const activate = (action: () => void) => (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); action() }
  }

  const showFileLabels = view.k >= 0.45
  const showFolderLabels = view.k >= 0.28
  const nodeById = new Map(nodes.map(node => [node.id, node]))
  const labelLines = (node: GraphNode) => {
    const shown = node.kind === 'source' || (node.kind === 'file' ? showFileLabels : showFolderLabels)
    return shown && node.kind !== 'source' ? wrapLabel(node.name).length : 0
  }

  return (
    <svg
      ref={svgRef}
      className="graph-canvas"
      role="group"
      aria-label="Directory graph"
      onPointerDown={onBackgroundPointerDown}
      onPointerMove={onBackgroundPointerMove}
      onPointerUp={onBackgroundPointerEnd}
      onPointerCancel={onBackgroundPointerEnd}
    >
      <defs>
        <marker id="contains-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 1 1 L 9 5 L 1 9 z" className="edge-arrow" />
        </marker>
      </defs>
      <rect className="graph-background" width="100%" height="100%" />
      <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
        <g className="edges" aria-hidden="true">
          {edges.map(edge => {
            const parent = layout.node(edge.parentId)
            const child = layout.node(edge.childId)
            const parentNode = nodeById.get(edge.parentId)
            const childNode = nodeById.get(edge.childId)
            if (!parent || !child || !parentNode || !childNode) return null
            const highlighted = edge.parentId === selectedId || edge.childId === selectedId
            const geometry = edgeGeometry(parent, child, nodeBox(parentNode, labelLines(parentNode)), nodeBox(childNode, labelLines(childNode)))
            return (
              <line
                key={edge.id}
                className={highlighted ? 'edge edge-highlight' : 'edge'}
                data-edge-parent={edge.parentId}
                data-edge-child={edge.childId}
                {...geometry}
                markerEnd="url(#contains-arrow)"
              />
            )
          })}
        </g>
        <g className="nodes">
          {nodes.map(node => {
            const position = layout.node(node.id)
            if (!position) return null
            const radius = NODE_RADIUS[node.kind]
            const isFolder = node.kind !== 'file'
            const isExpanded = isFolder && expanded.has(node.id)
            const isSelected = node.id === selectedId
            const pinned = layout.isPinned(node.id)
            const counts = isFolder ? childCounts(index, node.id) : null
            const isEmpty = counts !== null && counts.directories + counts.files === 0
            const description = counts ? describeCounts(counts) : 'Markdown file'
            const label = isFolder
              ? `${node.name}, ${node.kind === 'source' ? 'source folder' : 'folder'}, ${description}${pinned ? ', pinned' : ''}`
              : `${node.name}, Markdown file${pinned ? ', pinned' : ''}`
            const showLabel = node.kind === 'source' || (node.kind === 'file' ? showFileLabels : showFolderLabels)
            const lines = node.kind === 'source' ? [node.name] : wrapLabel(node.name)
            const classes = ['node', `node-${node.kind}`, isSelected ? 'is-selected' : '', pinned ? 'is-pinned' : '']
            return (
              <g
                key={node.id}
                className={classes.join(' ').trim()}
                transform={`translate(${position.x} ${position.y})`}
                data-node-id={node.id}
                data-node-kind={node.kind}
                onFocus={event => {
                  // Pointer focus must not move the click/drag target before the gesture finishes.
                  if (event.target.matches(':focus-visible')) ensureVisible(node.id)
                }}
              >
                <g
                  className="node-body"
                  role={isFolder ? 'button' : 'group'}
                  tabIndex={0}
                  aria-label={label}
                  aria-pressed={isFolder ? isSelected : undefined}
                  onPointerDown={onNodePointerDown(node)}
                  onPointerMove={onNodePointerMove}
                  onPointerUp={onNodePointerEnd}
                  onPointerCancel={onNodePointerEnd}
                  onClick={onNodeClick(node)}
                  onKeyDown={onNodeKeyDown(node)}
                >
                  <title>{label}</title>
                  <circle className="focus-ring" r={radius + 6} />
                  {node.kind === 'source' && <circle className="shape" r={radius} />}
                  {node.kind === 'directory' && <path className="shape" d="M -20 -15 h 12 l 4 4 h 24 v 26 h -40 z" />}
                  {node.kind === 'file' && (
                    <>
                      <path className="shape" d="M -10 -14 h 14 l 6 6 v 22 h -20 z" />
                      <path className="shape-detail" d="M 4 -14 v 6 h 6 M -6 0 h 12 M -6 6 h 12" />
                    </>
                  )}
                  {showLabel && (
                    <text className="label" textAnchor="middle" y={node.kind === 'source' ? 5 : radius + 16} aria-hidden="true">
                      {lines.map((line, i) => <tspan key={i} x="0" dy={i === 0 ? 0 : 13}>{line}</tspan>)}
                    </text>
                  )}
                  {isExpanded && isEmpty && (
                    <text className="empty-tag" textAnchor="middle" y={radius + 16 + lines.length * 13} aria-hidden="true">empty</text>
                  )}
                </g>
                {isFolder && (
                  <g
                    className="node-toggle"
                    role="button"
                    tabIndex={0}
                    aria-expanded={isExpanded}
                    aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${node.name}`}
                    transform={`translate(${radius * 0.85} ${-radius * 0.85})`}
                    onPointerDown={stop}
                    onClick={() => onToggleExpand(node)}
                    onKeyDown={activate(() => onToggleExpand(node))}
                  >
                    <circle r={9} />
                    <path d={isExpanded ? 'M -4 0 h 8' : 'M -4 0 h 8 M 0 -4 v 8'} />
                  </g>
                )}
                {pinned && (
                  <g
                    className="node-pin"
                    role="button"
                    tabIndex={0}
                    aria-label={`Unpin ${node.name}`}
                    transform={`translate(${-radius * 0.85} ${-radius * 0.85})`}
                    onPointerDown={stop}
                    onClick={() => onTogglePin(node)}
                    onKeyDown={activate(() => onTogglePin(node))}
                  >
                    <circle r={8} />
                    <path d="M -3 -3 h 6 l -1 4 h -4 z M 0 1 v 5" />
                  </g>
                )}
              </g>
            )
          })}
        </g>
      </g>
    </svg>
  )
})
