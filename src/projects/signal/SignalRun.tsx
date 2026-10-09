import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Now, RunAttention, Timeline } from '../../../contracts/projects/triage.ts'
import type { ReviewResult, RunDetail, RunInputs, WorkflowEvent } from '../api.ts'
import type { StepRow } from '../steps.ts'
import { formatSpan } from '../time.ts'
import { GlyphDefs } from './Glyph.tsx'
import { PHONE_STAGE_WIDTH } from './layout.ts'
import { readDockOpen } from './dock.ts'
import { LiveDock } from './LiveDock.tsx'
import { latestEvents, nowNodeId, stageNodes } from './model.ts'
import { NodeSheet } from './NodeSheet.tsx'
import { RunStage, type StageHandle } from './RunStage.tsx'
import './signal.css'

/** The live dock's width plus its margin, which the fit keeps clear on a desk. */
const DOCK_RESERVE = 336
/** The stage never shrinks below this, whatever the window. */
const MIN_STAGE_HEIGHT = 420

type Props = {
  detail: RunDetail
  rows: readonly StepRow[]
  timeline: Timeline | null
  events: readonly WorkflowEvent[]
  inputs: RunInputs | null
  review: ReviewResult | null
  attention: RunAttention | null
  now: Now | null
  clock: number
  reviewRound: string | null
  nodeHref: (nodeId: string) => string
  onNavigate: (pathname: string) => void
  /** Run-level records shown on the sheet of the step they belong to (the attack pass, the provider panel); null for the rest. */
  sheetExtras?: (nodeId: string) => ReactNode
}

/**
 * The run page (the Signal Box design, 2026-10-09): the graph is the page. Under the identity line the stage fills the rest
 * of the window; the live dock sits on it with the last-known live state and the next command; a step opens its sheet on the
 * stage's edge and from there its full page. The page keeps one selected step in its own state (the URL stays the run's), so
 * Back leaves the run, not the sheet.
 */
export function SignalRun({ detail, rows, timeline, events, inputs, review, attention, now, clock, reviewRound, nodeHref, onNavigate, sheetExtras }: Props) {
  const stage = useRef<StageHandle>(null)
  const frame = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [dockOpen, setDockOpen] = useState(readDockOpen)
  const [height, setHeight] = useState<number | null>(null)
  const nodes = useMemo(() => stageNodes({ detail, rows, timeline, events, inputs, review, attention, reviewRound }, formatSpan), [detail, rows, timeline, events, inputs, review, attention, reviewRound])
  const labels = useMemo(() => new Map(detail.definition.nodes.map(node => [node.node_id, node.label])), [detail.definition.nodes])
  const latest = useMemo(() => latestEvents(timeline, labels), [timeline, labels])
  const nowId = nowNodeId(now, attention, nodes)
  // A step that leaves the picture (a re-export) has no sheet; the selection is simply not found.
  const selectedNode = selected === null ? null : nodes.find(node => node.id === selected) ?? null

  // The stage takes the window below the identity line, so the graph is the page and nothing under it needs a scroll.
  useLayoutEffect(() => {
    const element = frame.current
    if (!element) return
    const measure = () => setHeight(Math.max(MIN_STAGE_HEIGHT, window.innerHeight - element.getBoundingClientRect().top - 8))
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  // On a phone the dock and the sheet would cover each other: opening a step folds the dock to its bar.
  const phone = () => (frame.current?.clientWidth ?? Number.POSITIVE_INFINITY) <= PHONE_STAGE_WIDTH
  const select = useCallback((nodeId: string | null) => {
    if (nodeId !== null && phone()) setDockOpen(false)
    setSelected(nodeId)
  }, [])
  const goTo = useCallback((nodeId: string) => {
    if (phone()) setDockOpen(false)
    stage.current?.goTo(nodeId)
  }, [])

  return (
    <div ref={frame} className="sb-frame" data-testid="run-board" style={height === null ? undefined : { height }}>
      <GlyphDefs />
      <RunStage ref={stage} nodes={nodes} nowId={nowId} selectedId={selected} onSelect={select} reservedLeft={dockOpen ? DOCK_RESERVE : 0} sheetOpen={selectedNode !== null}>
        <LiveDock detail={detail} now={now} clock={clock} nodes={nodes} nowId={nowId} latest={latest} timeline={timeline} inputs={inputs} open={dockOpen} onOpenChange={setDockOpen} onGo={goTo} nodeHref={nodeHref} onNavigate={onNavigate} />
        {selectedNode && (
          <NodeSheet node={selectedNode} now={now} isFocus={selectedNode.id === (now?.focus?.node_id ?? null)} href={nodeHref(selectedNode.id)} onNavigate={onNavigate} onClose={() => select(null)}>
            {sheetExtras?.(selectedNode.id)}
          </NodeSheet>
        )}
      </RunStage>
      <p className="visually-hidden" role="status">{selectedNode ? `${selectedNode.label} details open` : ''}</p>
    </div>
  )
}
