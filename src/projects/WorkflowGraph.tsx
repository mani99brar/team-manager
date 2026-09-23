import { useMemo, type KeyboardEvent } from 'react'
import { DAG_NODE_HEIGHT, DAG_NODE_WIDTH, layoutDag } from './dag.ts'
import { EXECUTOR_LABEL, executorCategory, KIND_LABEL, STATUS_LABEL, type Executor, type NodeKind, type RunStatus } from './status.ts'
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

/** Controller and verifier nodes are outlined dashed (an inline attribute, so no stylesheet rule is needed); agents stay solid. */
const DASH: Record<Executor, string | undefined> = { agent: undefined, verifier: '8 4', controller: '3 3' }
/** The short executor word of the node meta line; the accessible name and the legend carry the full wording. */
const EXECUTOR_SHORT: Record<Executor, string> = { agent: 'agent', verifier: 'verifier', controller: 'controller' }
const LEGEND: { executor: Executor; label: string }[] = [
  { executor: 'agent', label: 'Agent session (solid): workers, and reviewers one per session or print job' },
  { executor: 'verifier', label: 'Trusted verifier (dashed): verification and the combined candidate' },
  { executor: 'controller', label: 'Controller (dashed): handoff, approval and integration' },
]
/** Beyond this many characters the 10px meta line would overflow the node, so it is fitted to the node width. */
const META_FIT = 24

/**
 * Layered SVG rendering of a workflow definition, optionally coloured by a run's node statuses. Every node
 * is a keyboard-focusable control describing its label, kind, status, attempt and executor; the surrounding node
 * list is the equivalent non-graphical view, and the legend below explains the outlines.
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
    <>
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
            const executor = executorCategory(node.kind)
            const description = [
              node.label,
              KIND_LABEL[node.kind].toLowerCase(),
              status ? STATUS_LABEL[status].toLowerCase() : null,
              node.attempt !== undefined ? `attempt ${node.attempt}` : null,
              `executed by ${EXECUTOR_LABEL[node.kind]}`,
            ].filter(Boolean).join(', ')
            const meta = status
              ? `${STATUS_LABEL[status]}${node.attempt !== undefined ? ` · attempt ${node.attempt}` : ''} · ${EXECUTOR_SHORT[executor]}`
              : `${KIND_LABEL[node.kind]} · ${EXECUTOR_SHORT[executor]}`
            const className = [
              'workflow-node',
              `workflow-node-${node.kind}`,
              executor === 'agent' ? 'is-agent' : 'is-controller',
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
                data-executor={executor}
                role={interactive ? 'button' : undefined}
                tabIndex={interactive ? 0 : undefined}
                aria-label={description}
                aria-pressed={interactive ? node.node_id === selectedId : undefined}
                onClick={interactive ? () => onSelect(node.node_id) : undefined}
                onKeyDown={keyHandler(node.node_id, index)}
              >
                <rect className="workflow-node-shape" width={DAG_NODE_WIDTH} height={DAG_NODE_HEIGHT} rx="8" strokeDasharray={DASH[executor]} />
                <rect className="workflow-node-focus" x="-3" y="-3" width={DAG_NODE_WIDTH + 6} height={DAG_NODE_HEIGHT + 6} rx="10" />
                <rect className="workflow-node-status-bar" x="0" y="0" width="6" height={DAG_NODE_HEIGHT} rx="3" />
                <text className="workflow-node-label" x="14" y={lines.length === 1 ? 24 : 20} aria-hidden="true">
                  {lines.map((line, lineIndex) => (
                    <tspan key={lineIndex} x="14" dy={lineIndex === 0 ? 0 : 14}>{line}</tspan>
                  ))}
                </text>
                <text
                  className="workflow-node-meta"
                  x="14"
                  y={DAG_NODE_HEIGHT - 10}
                  aria-hidden="true"
                  textLength={meta.length > META_FIT ? DAG_NODE_WIDTH - 22 : undefined}
                  lengthAdjust={meta.length > META_FIT ? 'spacingAndGlyphs' : undefined}
                >
                  {meta}
                </text>
                {!interactive && <title>{description}</title>}
              </g>
            )
          })}
        </svg>
      </div>
      <ul className="workflow-graph-legend" aria-label="Who executes each node" data-testid="graph-legend" style={{ listStyle: 'none', padding: 0, margin: '0.5em 0' }}>
        {LEGEND.map(entry => (
          <li key={entry.executor} data-executor={entry.executor} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4em', marginRight: '1.25em' }}>
            <svg width="28" height="14" aria-hidden="true">
              <rect className="workflow-node-shape" x="1" y="1" width="26" height="12" rx="3" strokeDasharray={DASH[entry.executor]} />
            </svg>
            <span>{entry.label}</span>
          </li>
        ))}
      </ul>
    </>
  )
}
