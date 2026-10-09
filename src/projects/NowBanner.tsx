import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Now, Text, TextPart } from '../../contracts/projects/triage.ts'
import { CommandBlock } from './CommandBlock.tsx'
import { servedNow } from './lists.ts'
import { useServedRun } from './LiveStatus.tsx'
import { AppLink } from './panels.tsx'
import { withoutGlyph } from './steps.ts'
import { Time } from './Time.tsx'
import { formatAgo, formatSpan, utcTitle } from './time.ts'

/** One part of the triage model's rich text: a clock as `<Time>`, ages, durations and deadlines against the page's ticking clock. */
function Part({ part, now }: { part: TextPart; now: number }): ReactNode {
  if (typeof part === 'string') return part
  switch (part.kind) {
    case 'clock': return <>{part.inferred ? '≈' : ''}<Time iso={part.at} /></>
    case 'ago': return <time dateTime={part.at} title={utcTitle(part.at)}>{formatAgo(part.at, now)}</time>
    case 'span': return `${part.inferred ? '≈' : ''}${formatSpan(part.ms)}`
    case 'elapsed': return formatSpan(Math.max(0, now - Date.parse(part.from)))
    case 'left': return formatSpan(Math.max(0, Date.parse(part.until) - now))
  }
}

/** Renders the triage model's rich text (headlines and reasons) in the viewer's zone and against its clock. */
export function RichText({ text, now }: { text: Text; now: number }) {
  return <>{text.map((part, index) => <Part key={index} part={part} now={now} />)}</>
}

/** The reason, clamped to two lines with a More toggle once it is longer; `after` (the focus link) stays outside the clamp. */
function Reason({ children, after }: { children: ReactNode; after: ReactNode }) {
  const paragraph = useRef<HTMLParagraphElement>(null)
  const [open, setOpen] = useState(false)
  const [clamped, setClamped] = useState(false)
  // Measured after every change of the text: only an overflowing reason gets a More toggle.
  useLayoutEffect(() => {
    const element = paragraph.current
    if (element && !open) setClamped(element.scrollHeight > element.clientHeight + 1)
  }, [open, children])
  return (
    <div className="run-now-reason-row">
      <p ref={paragraph} className={open ? 'run-now-reason' : 'run-now-reason is-clamped'} data-testid="now-reason">{children}</p>
      {(clamped || open) && (
        <button type="button" className="button button-small run-now-more" aria-expanded={open} onClick={() => setOpen(previous => !previous)}>{open ? 'Less' : 'More'}</button>
      )}
      {after}
    </div>
  )
}

type Props = {
  /** Null while the events, inputs, review or the lane results the rules read are still loading. */
  now: Now | null
  clock: number
  /** The focus step's page, for its "Open" link; null when there is no focus. */
  focusHref: string | null
  onNavigate: (pathname: string) => void
  /** When given, the "Open" affordance centres the focus step on the run stage instead of leaving the page. */
  onOpenFocus?: (nodeId: string) => void
}

/**
 * The Now banner (docs/PRD_VIEWER_UX.md 4.2, 6.2): where the run is or stopped, why, since when, and what to type next,
 * derived from the run's current state only (`deriveNow`). `data-situation` names the matched rule. What the server reads
 * live wins over the export (6.4, S6): a question the live `<lane>.questions.json` answered or asked since the export, and
 * a controller read not running for 15 s (rule 5 case c). It is not a live region: the page announces only a change of
 * situation.
 */
export function NowBanner({ now: exported, clock, focusHref, onNavigate, onOpenFocus }: Props) {
  const served = useServedRun()
  const now = useMemo(() => (exported === null ? null : servedNow(exported, served)), [exported, served])
  if (now === null) {
    return (
      <section className="run-now run-now-loading" data-testid="run-now" aria-busy="true" aria-labelledby="run-now-title">
        <h3 id="run-now-title" className="visually-hidden">Now</h3>
        <p className="run-now-headline projects-muted">Reading the run's events and results…</p>
      </section>
    )
  }
  // The focus page's link names the node its last segment ends in (`/nodes/<n>`); a served situation can move the focus.
  const href = now.focus && focusHref ? focusHref.replace(/[^/]+$/, encodeURIComponent(now.focus.node_id)) : null
  const focusId = now.focus?.node_id ?? null
  const open = now.focus && href
    ? <AppLink href={href} onNavigate={onOpenFocus && focusId !== null ? () => onOpenFocus(focusId) : onNavigate} className="run-now-open" data-testid="now-open">Open {now.focus.label} ›</AppLink>
    : null
  return (
    <section className={`run-now run-now-${now.tone}`} data-testid="run-now" data-situation={now.situation} aria-labelledby="run-now-title">
      <h3 id="run-now-title" className="visually-hidden">Now</h3>
      <p className="run-now-headline" data-testid="now-headline">
        <span className="run-now-glyph" aria-hidden="true">{now.glyph}</span>
        <span><RichText text={withoutGlyph(now.headline, now.glyph)} now={clock} /></span>
        {now.reason === null && open}
      </p>
      {now.reason !== null && <Reason after={open}><RichText text={now.reason} now={clock} /></Reason>}
      <CommandBlock next={now.next} />
    </section>
  )
}
