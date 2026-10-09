import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { layoutStage, NODE_HEIGHT, NODE_WIDTH, PHONE_STAGE_WIDTH, stepFrom, type Direction, type StageLayout } from './layout.ts'
import type { StageNode } from './model.ts'
import { Glyph } from './Glyph.tsx'
import { executorOf, KIND_LABEL } from '../status.ts'
import { toneClass, type Tone } from '../tone.ts'
import { formatSpan } from '../time.ts'

export type StageHandle = {
  /** Centres a step (zooming in from the overview) and opens it. */
  goTo: (id: string) => void
  fit: () => void
}

type Props = {
  nodes: StageNode[]
  /** The step the run is at: its card is outlined as "now". */
  nowId: string | null
  selectedId: string | null
  onSelect: (id: string | null) => void
  /** Overlays drawn inside the stage: the live dock and the step sheet. */
  children?: ReactNode
  /** How wide the live dock is when open (the fit leaves it room on a desk); 0 when closed. */
  reservedLeft: number
  /** Whether the step sheet is open: the fit and the reveal leave it room. */
  sheetOpen: boolean
}

type View = { x: number; y: number; k: number }

const MIN_SCALE = 0.15
const MAX_SCALE = 2.6
const FIT_MAX_SCALE = 1.4
const SHEET_WIDTH = 440
/** The share of a phone stage the bottom sheet leaves visible above it. */
const PHONE_SHEET_FREE = 0.22
const LEVELS = ['Overview', 'Standard', 'Full detail'] as const

const levelOf = (k: number) => (k < 0.6 ? 0 : k < 1.25 ? 1 : 2)

const EXECUTOR_WORD = { agent: 'agent', verifier: 'verifier', controller: 'controller' } as const

const LEGEND_TONES: { tone: Tone; word: string }[] = [
  { tone: 'ok', word: 'succeeded' }, { tone: 'run', word: 'running' }, { tone: 'warn', word: 'needs you' },
  { tone: 'fail', word: 'failed or blocked' }, { tone: 'pause', word: 'paused' }, { tone: 'idle', word: 'pending' },
]

/** One step's card: the full card at the near levels, the chip at the overview; the accessible name carries it all. */
function StepCard({ node, position, current, selected, now }: { node: StageNode; position: { x: number; y: number }; current: boolean; selected: boolean; now: boolean }) {
  const last = node.events.at(-1) ?? null
  const duration = node.ms === null ? null : formatSpan(node.ms)
  const openP1 = node.findings === null ? null : node.findings.filter(finding => (finding.severity === 'P0' || finding.severity === 'P1') && finding.disposition !== 'resolved').length
  // The accessible name keeps the definition graph's order (label, kind, status, attempt, the meta line, the executor), then
  // what the card adds: the lane and the duration.
  const name = [
    node.label, node.repair ? 'repair' : KIND_LABEL[node.kind].toLowerCase(), node.word, `attempt ${node.attempt}`, node.round,
    `executed by ${executorOf(node.kind, undefined, node.id)}`, node.lane ? `lane ${node.lane}` : null, duration,
  ].filter(Boolean).join(', ')
  const classes = [
    'node', toneClass(node.tone), `exec-${node.exec}`, node.exec === 'agent' ? 'is-agent' : 'is-controller', `is-${node.shown}`,
    node.attention ? 'attn' : '', now ? 'now' : '', selected ? 'is-selected' : '',
  ].filter(Boolean).join(' ')
  return (
    <button
      type="button"
      className={classes}
      data-graph-node={node.id}
      data-node-id={node.id}
      data-status={node.shown}
      data-tone={node.tone}
      data-attention={node.attention?.kind ?? undefined}
      data-executor={node.exec}
      tabIndex={current ? 0 : -1}
      aria-label={name}
      aria-current={selected ? 'true' : undefined}
      style={{ left: position.x, top: position.y }}
    >
      <span className="band" />
      <span className="n-top"><Glyph tone={node.tone} className="g" /><span className="n-label">{node.label}</span></span>
      <span className="n-meta">
        <span className="n-word">{node.word}</span>
        <span>{node.kindLabel} · {EXECUTOR_WORD[node.exec]}</span>
        {node.attempt > 1 && <span>attempt <b>{node.attempt}</b></span>}
        {node.round && <span>{node.round}</span>}
      </span>
      {(node.lane || duration || openP1 !== null) && (
        <span className="n-meta">
          {node.lane && <span className="lane">{node.lane}</span>}
          {duration && <span><b>{duration}</b></span>}
          {openP1 !== null && <span><b>{openP1}</b> open P1</span>}
        </span>
      )}
      <span className="n-last">{last ? `${last.at.slice(11, 16)} · ${last.text}` : node.did ?? 'No event recorded yet.'}</span>
      <span className="n-chip"><span className="c1"><Glyph tone={node.tone} /><span>{node.label}</span></span><span className="c2">{node.facts}</span></span>
    </button>
  )
}

/**
 * The run stage: a full-bleed pan and zoom track diagram of the run's steps (the Signal Box design, docs/PRD_VIEWER_REFINE 5.2).
 * Three detail levels follow the zoom: chips far out, the standard card, the full card with its last event up close. Every
 * step is a keyboard-focusable control: the arrows walk the columns and rows, Enter opens the step, plus and minus zoom, 0
 * fits, Escape closes the sheet; a pointer drags to pan, a wheel or a pinch zooms. The picture is a definition's steps
 * coloured by state only, with a glyph and a word repeating every colour; dashed edges lead to steps that have not started,
 * a dashed green return mark leads from a repair session back to the step it re-enters.
 */
export const RunStage = forwardRef<StageHandle, Props>(function RunStage({ nodes, nowId, selectedId, onSelect, children, reservedLeft, sheetOpen }, ref) {
  const stageRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const tagRef = useRef<HTMLSpanElement>(null)
  const view = useRef<View>({ x: 0, y: 0, k: 1 })
  const [dir, setDir] = useState<Direction>('LR')
  const [chosen, setCurrent] = useState<string | null>(null)
  const [legendOpen, setLegendOpen] = useState(false)
  const [level, setLevel] = useState(1)
  const levelRef = useRef(1)

  const pending = useMemo(() => new Set(nodes.filter(node => node.shown === 'pending').map(node => node.id)), [nodes])
  const returns = useMemo(() => nodes.flatMap(node => (node.returnTo ? [{ from: node.id, to: node.returnTo }] : [])), [nodes])
  const inputs = useMemo(() => nodes.map(node => ({ id: node.id, dep: node.dep, rank: node.repair ? 1 : 0 })), [nodes])
  const layout: StageLayout = useMemo(() => layoutStage(inputs, { dir, pending, returns }), [inputs, dir, pending, returns])
  // The imperative handlers (fit, reveal, goTo) read the latest layout and overlay state through refs, written after each render.
  const layoutRef = useRef(layout)
  const sheetRef = useRef(sheetOpen)
  const reservedRef = useRef(reservedLeft)
  useLayoutEffect(() => {
    layoutRef.current = layout
    sheetRef.current = sheetOpen
    reservedRef.current = reservedLeft
  })

  /** Writes the view to the world and the stage: the transform, the detail level and the grid that moves with the picture. */
  const apply = useCallback(() => {
    const world = worldRef.current
    const stage = stageRef.current
    if (!world || !stage) return
    const { x, y, k } = view.current
    world.style.transform = `translate(${x}px, ${y}px) scale(${k})`
    const detail = levelOf(k)
    world.dataset.level = String(detail)
    world.style.setProperty('--inv', detail === 0 ? Math.min(1 / k, 3.4).toFixed(3) : '1')
    stage.style.setProperty('--gs', `${24 * k}px`)
    stage.style.setProperty('--gx', `${x}px`)
    stage.style.setProperty('--gy', `${y}px`)
    if (tagRef.current) tagRef.current.textContent = `${Math.round(k * 100)}%`
    if (levelRef.current !== detail) {
      levelRef.current = detail
      setLevel(detail)
    }
  }, [])

  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    const k = Math.max(MIN_SCALE, Math.min(MAX_SCALE, view.current.k * factor))
    const ratio = k / view.current.k
    view.current = { x: cx - (cx - view.current.x) * ratio, y: cy - (cy - view.current.y) * ratio, k }
    apply()
  }, [apply])

  const fit = useCallback(() => {
    const stage = stageRef.current
    if (!stage) return
    const current = layoutRef.current
    const W = stage.clientWidth
    const H = stage.clientHeight
    const phone = current.dir === 'TB'
    const pad = phone ? 24 : 56
    const top = phone ? 40 : 40
    let k = Math.min((W - pad * 2) / current.width, (H - top - 90) / current.height)
    if (phone) k = Math.min((W - pad * 2) / current.width, 1)
    k = Math.max(MIN_SCALE, Math.min(FIT_MAX_SCALE, k))
    const left = !phone ? reservedRef.current : 0
    if (!phone) k = Math.max(MIN_SCALE, Math.min(k, (W - left - pad * 2) / current.width))
    view.current = {
      k,
      x: left + (W - left - current.width * k) / 2,
      y: phone ? top : top + Math.max(0, (H - top - 80 - current.height * k) / 2),
    }
    apply()
  }, [apply])

  /** Pans just enough for a step to be inside the visible part of the stage (beside the sheet, above a phone's sheet). */
  const reveal = useCallback((id: string) => {
    const stage = stageRef.current
    const position = layoutRef.current.positions.get(id)
    if (!stage || !position) return
    const W = stage.clientWidth
    const H = stage.clientHeight
    const phone = W <= PHONE_STAGE_WIDTH
    const vw = sheetRef.current && !phone ? W - SHEET_WIDTH : W
    const vh = sheetRef.current && phone ? H * PHONE_SHEET_FREE : H
    const { k } = view.current
    const sx = position.x * k + view.current.x
    const sy = position.y * k + view.current.y
    const w = NODE_WIDTH * k
    const h = NODE_HEIGHT * k
    const m = 24
    if (sx < m) view.current.x += m - sx
    else if (sx + w > vw - m) view.current.x -= sx + w - (vw - m)
    if (sy < m) view.current.y += m - sy
    else if (sy + h > vh - m) view.current.y -= sy + h - (vh - m)
    apply()
  }, [apply])

  const nodeElement = (id: string) => stageRef.current?.querySelector<HTMLButtonElement>(`[data-graph-node="${CSS.escape(id)}"]`) ?? null

  const focusStep = useCallback((id: string) => {
    setCurrent(id)
    nodeElement(id)?.focus({ preventScroll: true })
    reveal(id)
  }, [reveal])

  useImperativeHandle(ref, () => ({
    fit,
    goTo(id) {
      const stage = stageRef.current
      const position = layoutRef.current.positions.get(id)
      if (!stage || !position) return
      const W = stage.clientWidth
      const H = stage.clientHeight
      const phone = W <= PHONE_STAGE_WIDTH
      if (view.current.k < 0.6) view.current.k = Math.min(0.9, Math.max(view.current.k, 0.7))
      const vw = phone ? W : W - SHEET_WIDTH
      const vh = phone ? H * PHONE_SHEET_FREE : H
      view.current.x = vw / 2 - (position.x + NODE_WIDTH / 2) * view.current.k
      view.current.y = vh / 2 - (position.y + NODE_HEIGHT / 2) * view.current.k
      apply()
      setCurrent(id)
      onSelect(id)
    },
  }), [apply, fit, onSelect])

  // The flow direction follows the stage's width, and the picture is fitted again whenever the stage changes size (the
  // frame takes its height after the first paint; a window resize or a phone's rotation changes it later).
  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const measure = () => {
      setDir(stage.clientWidth < PHONE_STAGE_WIDTH ? 'TB' : 'LR')
      fit()
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [fit])
  const shape = `${dir}:${layout.columns.map(column => column.length).join(',')}`
  useLayoutEffect(() => { fit() }, [fit, shape])

  // The roving focus starts on the step the run is at, else the first step; a step that disappeared gives it back.
  const current = chosen !== null && nodes.some(node => node.id === chosen) ? chosen : nowId ?? nodes[0]?.id ?? null

  // Opening a step from elsewhere (the dock, a link) brings its card into view.
  useEffect(() => {
    if (selectedId !== null) reveal(selectedId)
  }, [selectedId, reveal])

  // Pointer input: one pointer drags, two pinch; a drag under five pixels is a click.
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)
  const pinch = useRef<{ d: number; k: number } | null>(null)
  const moved = useRef(false)
  const overlay = (target: EventTarget | null) => target instanceof Element && target.closest('.sb-dock, .sb-sheet, .sb-legend, .sb-live') !== null

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (overlay(event.target)) return
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    moved.current = false
    if (pointers.current.size === 1) drag.current = { x: event.clientX, y: event.clientY, vx: view.current.x, vy: view.current.y }
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), k: view.current.k }
      drag.current = null
    }
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const stage = stageRef.current
    if (!stage) return
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      const rect = stage.getBoundingClientRect()
      zoomAt((pinch.current.k * d / pinch.current.d) / view.current.k, (a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top)
      moved.current = true
      return
    }
    if (drag.current) {
      const dx = event.clientX - drag.current.x
      const dy = event.clientY - drag.current.y
      if (!moved.current && Math.hypot(dx, dy) < 5) return
      if (!moved.current) {
        moved.current = true
        stage.setPointerCapture(event.pointerId)
        stage.classList.add('dragging')
      }
      view.current.x = drag.current.vx + dx
      view.current.y = drag.current.vy + dy
      apply()
    }
  }
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId)
    if (pointers.current.size < 2) pinch.current = null
    if (pointers.current.size === 0) {
      drag.current = null
      stageRef.current?.classList.remove('dragging')
    }
  }
  // React registers wheel listeners passively; the stage must keep the page from scrolling, so it listens itself. A wheel
  // zooms about the pointer; a sideways wheel, or one with Shift, pans.
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (event: WheelEvent) => {
      if (event.target instanceof Element && event.target.closest('.sb-sheet, .sb-live')) return
      event.preventDefault()
      const rect = stage.getBoundingClientRect()
      if (event.ctrlKey || (Math.abs(event.deltaY) >= Math.abs(event.deltaX) && !event.shiftKey)) zoomAt(Math.exp(-event.deltaY * 0.0018), event.clientX - rect.left, event.clientY - rect.top)
      else {
        view.current.x -= event.deltaX
        view.current.y -= event.deltaY
        apply()
      }
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [apply, zoomAt])

  const onClickNodes = (event: ReactMouseEvent<HTMLDivElement>) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-graph-node]') : null
    if (!button || moved.current) return
    onSelect(button.dataset.graphNode!)
  }
  const onFocusNodes = (event: ReactFocusEvent<HTMLDivElement>) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-graph-node]') : null
    if (button) {
      setCurrent(button.dataset.graphNode!)
      reveal(button.dataset.graphNode!)
    }
  }

  const centre = () => ({ cx: (stageRef.current?.clientWidth ?? 0) / 2, cy: (stageRef.current?.clientHeight ?? 0) / 2 })
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest('.sb-sheet, .sb-live') && event.key !== 'Escape') return
    if (event.key === 'Escape' && selectedId !== null) {
      event.preventDefault()
      onSelect(null)
      return
    }
    if (target?.closest('.sb-dock') && !['+', '=', '-', '0'].includes(event.key)) return
    if (event.key === '+' || event.key === '=') { event.preventDefault(); const { cx, cy } = centre(); zoomAt(1.3, cx, cy); return }
    if (event.key === '-') { event.preventDefault(); const { cx, cy } = centre(); zoomAt(1 / 1.3, cx, cy); return }
    if (event.key === '0') { event.preventDefault(); fit(); return }
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft' || event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (current === null) return
      const next = stepFrom(layout, current, event.key)
      if (next) {
        focusStep(next)
        if (selectedId !== null) onSelect(next)
      }
      return
    }
    if (event.key === 'Enter' && target?.hasAttribute('data-graph-node')) {
      event.preventDefault()
      onSelect(target.getAttribute('data-graph-node'))
    }
  }

  // Closing the sheet hands the focus back to the step's card.
  const previousSelected = useRef(selectedId)
  useEffect(() => {
    const was = previousSelected.current
    previousSelected.current = selectedId
    if (was !== null && selectedId === null) nodeElement(was)?.focus({ preventScroll: true })
  }, [selectedId])

  return (
    <div
      ref={stageRef}
      className={`sb-stage${sheetOpen ? ' sheet-open' : ''}`}
      data-testid="run-stage"
      data-direction={dir}
      data-level={level}
      aria-label="Run graph. Arrow keys move between steps, Enter opens a step, plus and minus zoom, 0 fits."
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    >
      <p className="sb-hint" aria-hidden="true"><kbd>←↑→↓</kbd> walk · <kbd>Enter</kbd> open · <kbd>+</kbd><kbd>−</kbd> zoom · <kbd>0</kbd> fit · drag to pan</p>
      <div ref={worldRef} className="sb-world" data-level={level} style={{ width: layout.width, height: layout.height }}>
        <svg className="sb-edges" width={layout.width} height={layout.height} aria-hidden="true">
          <defs>
            <marker id="sb-arrow" viewBox="0 0 10 10" refX="2" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" /></marker>
          </defs>
          {layout.edges.map(edge => (
            <path key={`${edge.from}>${edge.to}`} data-edge={`${edge.from}>${edge.to}`} className={`${edge.todo ? 'todo' : ''}${selectedId !== null && (edge.from === selectedId || edge.to === selectedId) ? ' hot' : ''}`} d={edge.path} markerEnd="url(#sb-arrow)" />
          ))}
          {layout.returns.map(mark => (
            <path key={`${mark.from}>${mark.to}`} data-return={`${mark.from}>${mark.to}`} className={`ret${selectedId !== null && (mark.from === selectedId || mark.to === selectedId) ? ' hot' : ''}`} d={mark.path} />
          ))}
        </svg>
        <div className="sb-nodes" role="group" aria-label="Steps" data-testid="workflow-graph" onClick={onClickNodes} onFocus={onFocusNodes}>
          {nodes.map(node => {
            const position = layout.positions.get(node.id)
            if (!position) return null
            return <StepCard key={node.id} node={node} position={position} current={current === node.id} selected={selectedId === node.id} now={nowId === node.id} />
          })}
        </div>
      </div>
      <div className="sb-legend" id="sb-legend" hidden={!legendOpen}>
        <h3>Reading the graph</h3>
        <ul data-testid="graph-legend" aria-label="What each colour and outline means">
          {LEGEND_TONES.map(item => <li key={item.tone} className="li"><Glyph tone={item.tone} />{item.word}</li>)}
          <li className="li"><span className="sw" />agent session</li>
          <li className="li"><span className="sw" style={{ borderStyle: 'dashed' }} />trusted verifier</li>
          <li className="li"><span className="sw" style={{ borderStyle: 'dotted', borderWidth: 2 }} />controller</li>
          <li className="li"><svg viewBox="0 0 26 10" style={{ width: 26 }} aria-hidden="true"><path d="M1 5h24" stroke="var(--ok)" strokeWidth="2.4" strokeDasharray="3 5" /></svg>repair re-entry</li>
        </ul>
      </div>
      <div className="sb-dock">
        <button type="button" className="sb-legend-button" aria-expanded={legendOpen} aria-controls="sb-legend" onClick={() => setLegendOpen(previous => !previous)}>Legend</button>
        <span className="sb-level" data-testid="stage-level" data-level={level}><span ref={tagRef}>100%</span><b>{LEVELS[level]}</b></span>
        <div className="sb-zoom">
          <button type="button" aria-label="Zoom out" onClick={() => { const { cx, cy } = centre(); zoomAt(1 / 1.3, cx, cy) }}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg></button>
          <button type="button" aria-label="Fit the graph" onClick={fit}><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4" /></svg></button>
          <button type="button" aria-label="Zoom in" onClick={() => { const { cx, cy } = centre(); zoomAt(1.3, cx, cy) }}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h12M10 4v12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg></button>
        </div>
      </div>
      {children}
    </div>
  )
})
