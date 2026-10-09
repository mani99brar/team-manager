import { useEffect, useState } from 'react'
import type { Now, Timeline } from '../../../contracts/projects/triage.ts'
import type { RunDetail, RunInputs } from '../api.ts'
import { NowBanner } from '../NowBanner.tsx'
import { deadlinesLabel } from '../status.ts'
import { formatAgo, formatSpan, utcTitle } from '../time.ts'
import { stateTone, toneClass } from '../tone.ts'
import { Time } from '../Time.tsx'
import { Glyph } from './Glyph.tsx'
import { rememberDockOpen } from './dock.ts'
import type { LatestEvent, StageNode } from './model.ts'

type Props = {
  detail: RunDetail
  /** Null while the events, inputs, review or lane results the rules read are still loading. */
  now: Now | null
  clock: number
  nodes: readonly StageNode[]
  /** The step the dock calls "now": the Now's focus, or the first step that waits. */
  nowId: string | null
  latest: readonly LatestEvent[]
  timeline: Timeline | null
  inputs: RunInputs | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Centres a step on the stage and opens its sheet. */
  onGo: (nodeId: string) => void
  /** The step page's link, for the Now banner's "Open" affordance, which here centres the step instead. */
  nodeHref: (nodeId: string) => string
  onNavigate: (pathname: string) => void
}

/**
 * The live dock (the Signal Box design): the run's last-known live state in a small panel pinned to the stage. Its bar
 * names the step the run is at, its state and for how long; its body holds the Now banner (the situation, its cause and the
 * command to type next, copied, never run), the latest five moments of the run, how long it ran and its deadlines, and where
 * the state came from. Everything in it links to the step on the stage. Collapsed, only the bar stays.
 */
export function LiveDock({ detail, now, clock, nodes, nowId, latest, timeline, inputs, open, onOpenChange, onGo, nodeHref, onNavigate }: Props) {
  const [, tick] = useState(0)
  // The ages in the dock move every half minute; the clock prop already ticks every second while the run can change.
  useEffect(() => {
    const timer = window.setInterval(() => tick(value => value + 1), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  const step = nowId === null ? null : nodes.find(node => node.id === nowId) ?? null
  const tone = step ? step.tone : stateTone({ status: detail.summary.status, attention: null })
  const word = step ? step.word : detail.summary.status.replace('_', ' ')
  const since = now?.since ?? step?.start?.at ?? null
  const sinceText = since === null ? null : `for ${formatSpan(Math.max(0, clock - Date.parse(since)))}`
  const start = Date.parse(detail.summary.created_at)
  const end = timeline?.runEnd ? Date.parse(timeline.runEnd.at) : null
  const ran = end === null ? (detail.summary.status === 'running' ? clock - start : null) : end - start
  const finished = detail.summary.status === 'succeeded' || detail.summary.status === 'cancelled' || detail.summary.status === 'failed'
  const toggle = () => {
    rememberDockOpen(!open)
    onOpenChange(!open)
  }
  return (
    <section className={`sb-live${open ? '' : ' collapsed'}`} data-testid="live-dock" data-open={open} aria-labelledby="sb-live-title">
      <h3 id="sb-live-title" className="visually-hidden">Live state</h3>
      <button
        type="button"
        className={`lv-bar ${toneClass(tone)}`}
        data-testid="live-dock-bar"
        aria-expanded={open}
        aria-controls="sb-live-body"
        aria-label={`Live state: ${step ? step.label : detail.summary.run_id}, ${word}${sinceText ? `, ${sinceText}` : ''}. ${open ? 'Collapse' : 'Expand'} the live panel.`}
        onClick={toggle}
      >
        <Glyph tone={tone} />
        <span className="lv-now"><b>{step ? step.label : detail.summary.run_id}</b> <span className="w">{word}</span></span>
        {sinceText && <span className="lv-since">{sinceText}</span>}
        <span className="lv-chev" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l5-5 5 5" /></svg></span>
      </button>
      <div className="lv-body" id="sb-live-body" hidden={!open}>
        <div className="lv-sec lv-sec-now">
          <NowBanner now={now} clock={clock} focusHref={now?.focus ? nodeHref(now.focus.node_id) : null} onNavigate={onNavigate} onOpenFocus={onGo} />
        </div>
        <div className="lv-sec">
          <p className="lv-h">Latest events</p>
          {latest.length === 0
            ? <p className="lv-none">No event recorded yet.</p>
            : (
              <ul className="lv-ev" data-testid="live-dock-events">
                {latest.map(event => {
                  const eventTone = stateTone({ status: event.status, attention: null })
                  const body = (
                    <>
                      <span><Glyph tone={eventTone} size={14} /></span>
                      <span><span className="who">{event.label}</span><span className="ago"><time dateTime={event.at} title={utcTitle(event.at)}>{formatAgo(event.at, clock)}</time></span></span>
                      <span className="msg">{event.status ? `${event.status.replace('_', ' ')} · ` : ''}{event.text}</span>
                    </>
                  )
                  return (
                    <li key={event.key}>
                      {event.nodeId === null
                        ? <span className={`lv-row ${toneClass(eventTone)}`}>{body}</span>
                        : <button type="button" className={`lv-row ${toneClass(eventTone)}`} data-go={event.nodeId} onClick={() => onGo(event.nodeId!)}>{body}</button>}
                    </li>
                  )
                })}
              </ul>
            )}
        </div>
        <div className="lv-sec">
          <dl className="lv-figs" data-testid="live-dock-figures">
            <div><dt>Ran</dt><dd data-testid="run-span">{ran === null ? <span className="nr">not recorded</span> : formatSpan(ran)}</dd></div>
            <div><dt>Spent</dt><dd><span className="nr" title="The export carries no cost section the viewer can read.">not recorded</span></dd></div>
            <div><dt>Deadlines</dt><dd>{inputs?.automatic ? deadlinesLabel(inputs.automatic) : <span className="nr">not recorded</span>}</dd></div>
          </dl>
        </div>
        <p className="lv-src">
          {finished
            ? <>Last-known state from the run's records, last written <Time iso={detail.summary.updated_at} />. The run is finished, so nothing new arrives.</>
            : <>From the run's records as served, last written <Time iso={detail.summary.updated_at} />; the page re-reads them while the run can change.</>}
        </p>
      </div>
    </section>
  )
}
