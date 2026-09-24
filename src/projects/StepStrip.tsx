import { useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react'
import type { RunDetail } from './api.ts'
import { layoutDag } from './dag.ts'
import { AppLink } from './panels.tsx'
import { STATUS_LABEL } from './status.ts'
import { formatShortSpan, shortStepLabel, STATUS_GLYPH, type StepRow } from './steps.ts'

type Props = {
  detail: RunDetail
  rows: StepRow[]
  current: string
  runHref: string
  nodeHref: (nodeId: string) => string
  onNavigate: (pathname: string) => void
}

/**
 * The sticky step strip of a node page (docs/PRD_VIEWER_UX.md 4.4, `run-node-list`): every step as a chip in the graph's
 * column order, lanes stacked within a column, the current one marked; then the previous and next step. It replaces the
 * graph on node pages, so the two never share a screen. On a phone it scrolls sideways inside itself, never the page.
 */
export function StepStrip({ detail, rows, current, runHref, nodeHref, onNavigate }: Props) {
  const list = useRef<HTMLOListElement>(null)
  const layout = useMemo(() => layoutDag(detail.definition.nodes), [detail.definition.nodes])
  const index = rows.findIndex(row => row.node_id === current)
  const previous = index > 0 ? rows[index - 1] : null
  const next = index >= 0 && index < rows.length - 1 ? rows[index + 1] : null

  // Keep the current chip in view inside the strip, without scrolling the page.
  useLayoutEffect(() => {
    const element = list.current
    const chip = element?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!element || !chip || element.scrollWidth <= element.clientWidth) return
    // The list is positioned, so a chip's offsetLeft is measured from the list itself.
    element.scrollLeft = chip.offsetLeft - (element.clientWidth - chip.offsetWidth) / 2
  }, [current])

  return (
    <nav className="step-strip" aria-label={`Steps of run ${detail.summary.run_id}`}>
      <AppLink href={runHref} onNavigate={onNavigate} className="step-strip-run">‹ Run</AppLink>
      <ol ref={list} className="step-strip-list" data-testid="run-node-list" style={{ '--rows': Math.max(1, layout.rows) } as CSSProperties}>
        {rows.map(row => {
          const position = layout.positions.get(row.node_id)
          const alone = position ? [...layout.positions.values()].filter(other => other.column === position.column).length === 1 : true
          const glyph = row.attention ? '?' : STATUS_GLYPH[row.shown]
          return (
            <li
              key={row.node_id}
              data-node-id={row.node_id}
              data-status={row.status}
              data-attention={row.attention ?? undefined}
              style={position ? { '--column': position.column + 1, '--row': alone ? `1 / span ${Math.max(1, layout.rows)}` : position.row + 1 } as CSSProperties : undefined}
            >
              <AppLink
                href={nodeHref(row.node_id)}
                onNavigate={onNavigate}
                current={row.node_id === current}
                className={`step-chip status-row-${row.shown}`}
                aria-label={`${row.label}, ${STATUS_LABEL[row.shown].toLowerCase()}${row.attention ? ', waits on you' : ''}`}
                title={row.label}
              >
                <span className={`step-glyph status-text-${row.shown}`} aria-hidden="true">{glyph}</span>
                <span aria-hidden="true">{shortStepLabel(row)}</span>
                {row.ms !== null && <span className="step-chip-took" aria-hidden="true">{row.inferred ? '≈' : ''}{formatShortSpan(row.ms)}</span>}
              </AppLink>
            </li>
          )
        })}
      </ol>
      <span className="step-strip-nav">
        {previous
          ? <AppLink href={nodeHref(previous.node_id)} onNavigate={onNavigate} className="step-strip-step" title={`Previous step: ${previous.label}`} data-testid="step-previous">‹ Prev</AppLink>
          : <span className="step-strip-step is-disabled" aria-hidden="true">‹ Prev</span>}
        {next
          ? <AppLink href={nodeHref(next.node_id)} onNavigate={onNavigate} className="step-strip-step" title={`Next step: ${next.label}`} data-testid="step-next">Next ›</AppLink>
          : <span className="step-strip-step is-disabled" aria-hidden="true">Next ›</span>}
      </span>
    </nav>
  )
}
