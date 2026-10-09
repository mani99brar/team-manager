import { useEffect, useId, useMemo, useRef, type KeyboardEvent } from 'react'
import type { AttentionKind } from '../../contracts/projects/triage.ts'
import { DAG_NODE_HEIGHT, DAG_NODE_WIDTH, layoutDag } from './dag.ts'
import { COMPACT_GRAPH as COMPACT, compactLayout, GRAPH_MIN_SCALE as MIN_SCALE } from './node/board.ts'
import { executorCategory, executorOf, KIND_LABEL, STATUS_LABEL, type Executor, type NodeKind, type RunStatus } from './status.ts'
import { STATUS_GLYPH } from './steps.ts'
import { stateTone, toneClass } from './tone.ts'
import { wrapLabel } from '../graph/labels.ts'
import './run.css'

export type GraphNodeView = {
  node_id: string
  label: string
  kind: NodeKind
  depends_on: string[]
  /** Absent for a definition without a run (current workflow definition). */
  status?: RunStatus
  attempt?: number
  /** What the step waits on the operator for, if anything (docs/PRD_VIEWER_UX.md 6.4): an amber ring and a `?` glyph. */
  attention?: AttentionKind | null
}

type Props = {
  /** Identifies what the picture shows, e.g. "Pinned definition of run-001". */
  title: string
  nodes: GraphNodeView[]
  selectedId: string | null
  /** The step the run is at (the Now banner's focus): when the graph scrolls inside its box, this step is scrolled into view. */
  focusId?: string | null
  /** When omitted, the graph is a static picture of a definition. */
  onSelect?: (nodeId: string) => void
  /**
   * Narrower nodes and gaps, for the run page's Pipeline beside the Steps (docs/PRD_VIEWER_REVAMP.md 5.3): the same columns,
   * rows, meta line and 83 % floor.
   */
  compact?: boolean
  /**
   * A per-node meta line override (docs/PRD_VIEWER_REFINE 5.2): a repair node's "round r of n · trigger", a launch node's
   * model pin, the review node's round and delta base. Null keeps the default status/executor line.
   */
  metaOf?: (node: GraphNodeView) => string | null
  /**
   * The fix loop's return marks: a dashed edge from a repair node back to the step it answers, a drawing from the fix-loop
   * section and never a dependency edge (the contract graph stays acyclic). `from` is the repair node, `to` the step.
   */
  returns?: { from: string; to: string }[]
}

/** Controller and verifier nodes are outlined dashed (an inline attribute, so no stylesheet rule is needed); agents stay solid. */
const DASH: Record<Executor, string | undefined> = { agent: undefined, verifier: '8 4', controller: '3 3' }
/** The short executor word of the node meta line; the accessible name and the legend carry the full wording. */
const EXECUTOR_SHORT: Record<Executor, string> = { agent: 'agent', verifier: 'verifier', controller: 'controller' }
const LEGEND: { executor: Executor; label: string; meaning: string }[] = [
  { executor: 'agent', label: 'Agent session', meaning: 'solid outline; workers, and reviewers one per session or print job' },
  { executor: 'verifier', label: 'Trusted verifier', meaning: 'dashed outline; verification and the combined candidate' },
  { executor: 'controller', label: 'Controller', meaning: 'dotted outline; handoff, approval and integration' },
]
/** Beyond this many characters the 10px meta line would overflow the node, so it is fitted to the node width. */
const META_FIT = 22

/**
 * Layered SVG rendering of a workflow definition, optionally coloured by a run's node statuses. It is fitted to the width
 * of its box (down to 83 %, then it scrolls inside the box, with the run's focus step in view). Every node is a keyboard-focusable control describing its
 * label, kind, status, attempt and executor; a status glyph repeats the status so colour never carries it alone, and a
 * step that waits on the operator gets an amber ring and a `?`. The outline says who executes it, as the legend explains.
 */
export function WorkflowGraph({ title, nodes, selectedId, focusId = null, onSelect, compact = false, metaOf, returns = [] }: Props) {
  const layout = useMemo(() => (compact ? compactLayout(layoutDag(nodes)) : layoutDag(nodes)), [nodes, compact])
  const nodeWidth = compact ? COMPACT.width : DAG_NODE_WIDTH
  const interactive = onSelect !== undefined
  const hintId = useId()
  const scrollRef = useRef<HTMLDivElement>(null)

  // Between 760 and 1,100 px the graph scrolls inside its box: centre the focus step when it starts outside the box. Only
  // the box scrolls, never the page, and a box the reader already scrolled is left alone until the focus moves.
  useEffect(() => {
    const box = scrollRef.current
    if (!box || focusId === null || box.scrollWidth <= box.clientWidth) return
    const node = box.querySelector(`[data-graph-node="${CSS.escape(focusId)}"]`)
    if (!node) return
    const frame = box.getBoundingClientRect()
    const shape = node.getBoundingClientRect()
    if (shape.left >= frame.left && shape.right <= frame.right) return
    box.scrollLeft += shape.left - frame.left - (frame.width - shape.width) / 2
  }, [focusId, layout])

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
      <div className="workflow-graph-scroll" ref={scrollRef}>
        <svg
          className={compact ? 'workflow-graph is-compact' : 'workflow-graph'}
          role="group"
          aria-label={title}
          aria-describedby={interactive ? hintId : undefined}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          width="100%"
          style={{ maxWidth: layout.width, minWidth: Math.round(layout.width * MIN_SCALE) }}
          data-testid="workflow-graph"
        >
          <defs>
            <marker id="workflow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="workflow-edge-arrow" />
            </marker>
            <marker id="workflow-return-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="workflow-return-arrow" />
            </marker>
          </defs>
          {layout.edges.map(edge => {
            const from = layout.positions.get(edge.from)!
            const to = layout.positions.get(edge.to)!
            const x1 = from.x + nodeWidth
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
          {returns.flatMap(mark => {
            const from = layout.positions.get(mark.from)
            const to = layout.positions.get(mark.to)
            if (!from || !to) return []
            // The repair node sits right of the step it answers; the return mark arcs back from the repair's top-left to
            // the step's top, dashed and distinct from the solid dependency edges (a drawing, never a dependency edge).
            const x1 = from.x + nodeWidth / 2
            const y1 = from.y
            const x2 = to.x + nodeWidth / 2
            const y2 = to.y
            const lift = Math.min(y1, y2) - 22
            return [(
              <path
                key={`return-${mark.from}-${mark.to}`}
                className="workflow-return"
                d={`M ${x1} ${y1} C ${x1} ${lift}, ${x2} ${lift}, ${x2} ${y2}`}
                markerEnd="url(#workflow-return-arrow)"
                data-return-from={mark.from}
                data-return-to={mark.to}
                aria-hidden="true"
              />
            )]
          })}
          {nodes.map((node, index) => {
            const position = layout.positions.get(node.node_id)!
            const status = node.status
            const lines = wrapLabel(node.label, compact ? COMPACT.chars : 16, 2)
            const executor = executorCategory(node.kind)
            const metaOverride = metaOf?.(node) ?? null
            const description = [
              node.label,
              KIND_LABEL[node.kind].toLowerCase(),
              status ? STATUS_LABEL[status].toLowerCase() : null,
              node.attempt !== undefined ? `attempt ${node.attempt}` : null,
              metaOverride,
              `executed by ${executorOf(node.kind, undefined, node.node_id)}`,
            ].filter(Boolean).join(', ')
            const meta = metaOverride ?? (status
              ? `${STATUS_LABEL[status]}${node.attempt !== undefined ? ` · attempt ${node.attempt}` : ''} · ${EXECUTOR_SHORT[executor]}`
              : `${KIND_LABEL[node.kind]} · ${EXECUTOR_SHORT[executor]}`)
            const glyph = node.attention ? '?' : status ? STATUS_GLYPH[status] : null
            // Fill and stroke by status through the one tone mapping, a wait on the operator winning (`stateTone`); the glyph and
            // the meta line say it in text too.
            const tone = status ? stateTone({ status, attention: node.attention ?? null }) : null
            const className = [
              'workflow-node',
              `workflow-node-${node.kind}`,
              executor === 'agent' ? 'is-agent' : 'is-controller',
              status ? `is-${status}` : 'is-definition',
              tone ? toneClass(tone) : '',
              node.node_id === selectedId ? 'is-selected' : '',
            ].filter(Boolean).join(' ')
            return (
              <g
                key={node.node_id}
                className={className}
                transform={`translate(${position.x} ${position.y})`}
                data-graph-node={node.node_id}
                data-status={status ?? 'definition'}
                data-tone={tone ?? undefined}
                data-executor={executor}
                data-attention={node.attention ?? undefined}
                role={interactive ? 'button' : undefined}
                tabIndex={interactive ? 0 : undefined}
                aria-label={description}
                aria-pressed={interactive ? node.node_id === selectedId : undefined}
                onClick={interactive ? () => onSelect(node.node_id) : undefined}
                onKeyDown={keyHandler(node.node_id, index)}
              >
                <rect className="workflow-node-ring" x="-5" y="-5" width={nodeWidth + 10} height={DAG_NODE_HEIGHT + 10} rx="12" />
                <rect className="workflow-node-shape" width={nodeWidth} height={DAG_NODE_HEIGHT} rx="8" strokeDasharray={DASH[executor]} />
                <rect className="workflow-node-focus" x="-3" y="-3" width={nodeWidth + 6} height={DAG_NODE_HEIGHT + 6} rx="10" />
                <rect className="workflow-node-status-bar" x="0" y="0" width="6" height={DAG_NODE_HEIGHT} rx="3" />
                <text className="workflow-node-label" x="14" y={lines.length === 1 ? 24 : 20} aria-hidden="true">
                  {lines.map((line, lineIndex) => (
                    <tspan key={lineIndex} x="14" dy={lineIndex === 0 ? 0 : 14}>{line}</tspan>
                  ))}
                </text>
                {glyph && (
                  <g className="workflow-node-badge" transform={`translate(${nodeWidth - 3} 3)`} aria-hidden="true">
                    <circle r="8" />
                    <text className="workflow-node-glyph" y="4" textAnchor="middle">{glyph}</text>
                  </g>
                )}
                <text
                  className="workflow-node-meta"
                  x="14"
                  y={DAG_NODE_HEIGHT - 10}
                  aria-hidden="true"
                  textLength={meta.length > META_FIT * nodeWidth / DAG_NODE_WIDTH ? nodeWidth - 22 : undefined}
                  lengthAdjust={meta.length > META_FIT * nodeWidth / DAG_NODE_WIDTH ? 'spacingAndGlyphs' : undefined}
                >
                  {meta}
                </text>
                {!interactive && <title>{description}</title>}
              </g>
            )
          })}
        </svg>
        {interactive && <p id={hintId} className="visually-hidden">Arrow keys move between steps; Enter or Space opens one.</p>}
      </div>
      <ul className="workflow-graph-legend" aria-label="Who executes each node" data-testid="graph-legend">
        {LEGEND.map(entry => (
          <li key={entry.executor} data-executor={entry.executor} title={`${entry.label}: ${entry.meaning}`}>
            <svg width="24" height="12" aria-hidden="true">
              <rect className="workflow-node-shape" x="1" y="1" width="22" height="10" rx="3" strokeDasharray={DASH[entry.executor]} />
            </svg>
            <span>{entry.label}</span>
            <span className="visually-hidden">: {entry.meaning}</span>
          </li>
        ))}
        {returns.length > 0 && (
          <li data-legend="return" title="Return mark: a repair session answers the step it points back to (a drawing from the fix loop, not a dependency).">
            <svg width="24" height="12" aria-hidden="true">
              <path className="workflow-return" d="M 2 10 C 2 2, 22 2, 22 10" markerEnd="url(#workflow-return-arrow)" />
            </svg>
            <span>Return mark</span>
            <span className="visually-hidden">: a repair session answers the step it points back to.</span>
          </li>
        )}
      </ul>
    </>
  )
}
