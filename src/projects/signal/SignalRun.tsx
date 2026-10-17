import { useCallback, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import type { Now, RunAttention, Timeline } from '../../../contracts/projects/triage.ts'
import type { PanelResults, ReviewResult, RunDetail, RunInputs, Sessions, WorkflowEvent } from '../api.ts'
import type { Teams } from '../../../contracts/projects/teams.ts'
import type { TeamQuery } from '../routes.ts'
import { dockTeamLine, SPENT_TEAM_NOTE } from '../teams/model.ts'
import type { StepRow } from '../steps.ts'
import { formatSpan } from '../time.ts'
import { sessionsCueText } from '../sessions/model.ts'
import { spentText } from '../sessions/model.ts'
import { GlyphDefs } from './Glyph.tsx'
import { DOCK_COLUMN_FRAME, dockReserve, PHONE_STAGE_WIDTH } from './layout.ts'
import { readDockOpen } from './dock.ts'
import { LiveDock } from './LiveDock.tsx'
import { latestEvents, nowNodeId, stageNodes } from './model.ts'
import { NodeSheet } from './NodeSheet.tsx'
import { RunStage, type StageHandle } from './RunStage.tsx'
import './signal.css'

/** The stage never shrinks below this, whatever the window and the cue under it. */
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
  /** The run's sessions payload (run-sessions): enriches the projected reviewer/panel/lane-review cards; null when unread. */
  sessions: Sessions | null
  /** The panels route's record (null when unread or not recorded): the Panel card's own state word ([L12] 1). */
  panels?: PanelResults | null
  nodeHref: (nodeId: string) => string
  onNavigate: (pathname: string) => void
  /** Run-level records shown on the sheet of the step they belong to (the attack pass, the provider panel); null for the rest. */
  sheetExtras?: (nodeId: string) => ReactNode
  /**
   * The run's teams read (docs/PRD_RUN_TEAMS.md 5): a card whose sessions have team records gains its team line and the stacked
   * deck, and the live dock its Working now row; null (unread, not served, or no records) leaves the page exactly as before.
   */
  teams?: Teams | null
  /** The Team view's link with a selection (the dock's Working now row opens `/team?state=running`). */
  teamHref?: (query: Partial<TeamQuery>) => string
}

/**
 * The run page (the Signal Box design, 2026-10-09): the graph is the page. Under the identity line the stage fills the rest
 * of the window; the live dock sits on it with the last-known live state and the next command; a step opens its sheet on the
 * stage's edge and from there its full page. The page keeps one selected step in its own state (the URL stays the run's), so
 * Back leaves the run, not the sheet.
 */
export function SignalRun({ detail, rows, timeline, events, inputs, review, attention, now, clock, reviewRound, sessions, panels = null, nodeHref, onNavigate, sheetExtras, teams = null, teamHref }: Props) {
  const stage = useRef<StageHandle>(null)
  const frame = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [dockOpen, setDockOpen] = useState(readDockOpen)
  const cue = useRef<HTMLAnchorElement>(null)
  const [height, setHeight] = useState<number | null>(null)
  // The run frame's measured width, never the viewport's: the dock takes its own column from 1200 px of it.
  const [frameWidth, setFrameWidth] = useState(0)
  // The page scrollbar's width, read with the frame: the column decision counts it back in (below), so the Sessions table's scrollbar
  // appearing after load does not flip a column to an overlay.
  const [gutter, setGutter] = useState(0)
  const cueText = sessions ? sessionsCueText(sessions) : null
  const nodes = useMemo(() => stageNodes({ detail, rows, timeline, events, inputs, review, attention, reviewRound, sessions, panels, teams }, formatSpan), [detail, rows, timeline, events, inputs, review, attention, reviewRound, sessions, panels, teams])
  const labels = useMemo(() => new Map(detail.definition.nodes.map(node => [node.node_id, node.label])), [detail.definition.nodes])
  const latest = useMemo(() => latestEvents(timeline, labels), [timeline, labels])
  const nowId = nowNodeId(now, attention, nodes)
  // A step that leaves the picture (a re-export) has no sheet; the selection is simply not found.
  const selectedNode = selected === null ? null : nodes.find(node => node.id === selected) ?? null

  // The frame takes the window below the identity line, less the cue under the stage when it renders, so the graph is the page
  // and nothing but the Sessions table needs a scroll; measured on mount, on resize and when the cue comes or goes.
  const hasCue = cueText !== null
  useLayoutEffect(() => {
    const element = frame.current
    if (!element) return
    const measure = () => {
      const cueHeight = cue.current?.getBoundingClientRect().height ?? 0
      const top = element.getBoundingClientRect().top + window.scrollY
      setHeight(Math.max(MIN_STAGE_HEIGHT + cueHeight + 2, window.innerHeight - top - 4))
      setFrameWidth(element.clientWidth)
      setGutter(Math.max(0, window.innerWidth - document.documentElement.clientWidth))
    }
    measure()
    window.addEventListener('resize', measure)
    // The identity line above may grow after the first paint (its rows wrap, Details opens): the frame follows its top.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(element)
    if (element.parentElement) observer?.observe(element.parentElement)
    return () => {
      window.removeEventListener('resize', measure)
      observer?.disconnect()
    }
  }, [hasCue])

  // The cue leads to the Sessions heading: scrolled into view, focused, the URL untouched.
  const toSessions = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    const heading = document.getElementById('sessions-title')
    if (!heading) return
    heading.scrollIntoView({ block: 'start' })
    heading.focus({ preventScroll: true })
  }

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

  // The dock sits outside the stage, so Escape pressed inside it closes the open sheet here.
  const closeFromDock = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && selected !== null && event.target instanceof Element && event.target.closest('.sb-live')) select(null)
  }
  // A column from a run frame of 1200 px, measured as it would be without the page's scrollbar.
  const column = frameWidth + gutter >= DOCK_COLUMN_FRAME
  // The dock's Working now row (docs/PRD_RUN_TEAMS.md 5): agents running, else an interrupted team workflow while the run is live.
  const live = detail.summary.status !== 'succeeded' && detail.summary.status !== 'cancelled'
  const teamLine = dockTeamLine(teams, live, clock)
  const team = teamLine === null || !teamHref ? null : { line: teamLine, href: teamHref(teamLine.kind === 'running' ? { state: 'running' } : {}) }
  const spentNote = teams !== null && teams.totals.sessions_with_teams > 0 ? SPENT_TEAM_NOTE : null
  return (
    <div ref={frame} className={`sb-frame${column ? ' dock-col' : ''}`} data-testid="run-board" data-dock={column ? 'column' : 'overlay'} style={height === null ? undefined : { height }} onKeyDown={closeFromDock}>
      <GlyphDefs />
      <LiveDock detail={detail} now={now} clock={clock} nodes={nodes} nowId={nowId} latest={latest} timeline={timeline} inputs={inputs} open={dockOpen} onOpenChange={setDockOpen} onGo={goTo} nodeHref={nodeHref} onNavigate={onNavigate} spent={sessions ? spentText(sessions.totals) : null} team={team} spentNote={spentNote} />
      <RunStage ref={stage} nodes={nodes} nowId={nowId} selectedId={selected} onSelect={select} reservedLeft={column ? 0 : dockReserve(frameWidth, dockOpen)} sheetOpen={selectedNode !== null} cued={hasCue}>
        {selectedNode && (
          <NodeSheet node={selectedNode} now={now} isFocus={selectedNode.id === (now?.focus?.node_id ?? null)} href={nodeHref(selectedNode.id)} onNavigate={onNavigate} onClose={() => select(null)}>
            {sheetExtras?.(selectedNode.id)}
          </NodeSheet>
        )}
      </RunStage>
      {cueText !== null && <a ref={cue} href="#sessions-title" className="sb-cue" data-testid="sessions-cue" onClick={toSessions}>{cueText}</a>}
      <p className="visually-hidden" role="status">{selectedNode ? `${selectedNode.label} details open` : ''}</p>
    </div>
  )
}
