import { useMemo, type KeyboardEvent } from 'react'
import { DAG_NODE_HEIGHT, DAG_NODE_WIDTH, layoutDag } from './dag.ts'
import { KIND_LABEL, STATUS_LABEL, type NodeKind, type RunStatus } from './status.ts'
import { wrapLabel } from '../graph/labels.ts'

export type GraphNodeView = {
  node_id: string
  label: string
  kind: NodeKind
  depends_on: string[]
  /** Absent for a definition without a run (current workflow definition). */
  status?: RunStatus
  attempt?: number
}

type Props = {
  /** Identifies what the picture shows, e.g. "Pinned definition of run-001". */
  title: string
  nodes: GraphNodeView[]
  selectedId: string | null
  /** When omitted, the graph is a static picture of a definition. */
  onSelect?: (nodeId: string) => void
}

/**
 * Layered SVG rendering of a workflow definition, optionally coloured by a run's node statuses. Every node
 * is a keyboard-focusable control describing its label, kind, status and attempt; the surrounding node
 * list is the equivalent non-graphical view.
 */
export function WorkflowGraph({ title, nodes, selectedId, onSelect }: Props) {
  const layout = useMemo(() => layoutDag(nodes), [nodes])
  const interactive = onSelect !== undefined

  const keyHandler = (nodeId: string, index: number) => (event: KeyboardEvent<SVGGElement>) => {
    if (!interactive) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelect(nodeId)
      return
    }
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (delta === 0) return
    event.preventDefault()
    const next = nodes[(index + delta + nodes.length) % nodes.length]
    const target = event.currentTarget.ownerSVGElement?.querySelector<SVGGElement>(`[data-graph-node="${CSS.escape(next.node_id)}"]`)
    target?.focus()
  }

  return (
    <div className="workflow-graph-scroll">
      <svg
        className="workflow-graph"
        role="group"
        aria-label={title}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width={layout.width}
        height={layout.height}
        data-testid="workflow-graph"
      >
        <defs>
          <marker id="workflow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className="workflow-edge-arrow" />
          </marker>
        </defs>
        {layout.edges.map(edge => {
          const from = layout.positions.get(edge.from)!
          const to = layout.positions.get(edge.to)!
          const x1 = from.x + DAG_NODE_WIDTH
          const y1 = from.y + DAG_NODE_HEIGHT / 2
          const x2 = to.x
          const y2 = to.y + DAG_NODE_HEIGHT / 2
          const bend = (x2 - x1) / 2
          return (
            <path
              key={`${edge.from}->${edge.to}`}
              className="workflow-edge"
              d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`}
              markerEnd="url(#workflow-arrow)"
              data-edge-from={edge.from}
              data-edge-to={edge.to}
            />
          )
        })}
        {nodes.map((node, index) => {
          const position = layout.positions.get(node.node_id)!
          const status = node.status
          const lines = wrapLabel(node.label, 18, 2)
          const description = [
            node.label,
            KIND_LABEL[node.kind].toLowerCase(),
            status ? STATUS_LABEL[status].toLowerCase() : null,
            node.attempt !== undefined ? `attempt ${node.attempt}` : null,
          ].filter(Boolean).join(', ')
          const className = [
            'workflow-node',
            `workflow-node-${node.kind}`,
            status ? `is-${status}` : 'is-definition',
            node.node_id === selectedId ? 'is-selected' : '',
          ].filter(Boolean).join(' ')
          return (
            <g
              key={node.node_id}
              className={className}
              transform={`translate(${position.x} ${position.y})`}
              data-graph-node={node.node_id}
              data-status={status ?? 'definition'}
              role={interactive ? 'button' : undefined}
              tabIndex={interactive ? 0 : undefined}
              aria-label={description}
              aria-pressed={interactive ? node.node_id === selectedId : undefined}
              onClick={interactive ? () => onSelect(node.node_id) : undefined}
              onKeyDown={keyHandler(node.node_id, index)}
            >
              <rect className="workflow-node-shape" width={DAG_NODE_WIDTH} height={DAG_NODE_HEIGHT} rx="8" />
              <rect className="workflow-node-focus" x="-3" y="-3" width={DAG_NODE_WIDTH + 6} height={DAG_NODE_HEIGHT + 6} rx="10" />
              <rect className="workflow-node-status-bar" x="0" y="0" width="6" height={DAG_NODE_HEIGHT} rx="3" />
              <text className="workflow-node-label" x="14" y={lines.length === 1 ? 24 : 20} aria-hidden="true">
                {lines.map((line, lineIndex) => (
                  <tspan key={lineIndex} x="14" dy={lineIndex === 0 ? 0 : 14}>{line}</tspan>
                ))}
              </text>
              <text className="workflow-node-meta" x="14" y={DAG_NODE_HEIGHT - 10} aria-hidden="true">
                {status ? `${STATUS_LABEL[status]}${node.attempt !== undefined ? ` · attempt ${node.attempt}` : ''}` : KIND_LABEL[node.kind]}
              </text>
              {!interactive && <title>{description}</title>}
            </g>
          )
        })}
      </svg>
    </div>
  )
}
