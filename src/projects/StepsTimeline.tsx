import { useMemo, useState } from 'react'
import type { ActivityRow, MarkerKind, Timeline } from '../../contracts/projects/triage.ts'
import { AppLink } from './panels.tsx'
import { STATUS_LABEL } from './status.ts'
import { outageBands, STATUS_GLYPH, timeAxis, type StepRow, type TimeAxis } from './steps.ts'
import { Time } from './Time.tsx'
import { formatSpan } from './time.ts'
import { useTimeZone } from './useNow.ts'

/** Where the Activity order is remembered in this browser; the page works the same without it. */
export const ACTIVITY_ORDER_STORAGE_KEY = 'mdm.projects.activityOrder'

function readNewestFirst(): boolean {
  try {
    return window.localStorage.getItem(ACTIVITY_ORDER_STORAGE_KEY) === 'newest'
  } catch {
    return false
  }
}

function rememberNewestFirst(newest: boolean) {
  try {
    window.localStorage.setItem(ACTIVITY_ORDER_STORAGE_KEY, newest ? 'newest' : 'oldest')
  } catch {
    // Not remembered; the order still switches.
  }
}

const sourceNote = (row: StepRow) => [row.start?.note ?? (row.start ? `start from ${row.start.source}` : null), row.end?.note ?? (row.end ? `end from ${row.end.source}` : null)]
  .filter(Boolean).join('; ')

/**
 * The Steps bar of one row: each attempt from its start to its end (to now while it runs) on the run's time axis, with the
 * controller's outages hatched over a worker's bar (Activity says them in words).
 */
function Bar({ row, axis, gaps, now }: { row: StepRow; axis: TimeAxis; gaps: Timeline['gaps']; now: number }) {
  return (
    <span className="step-bar-track">
      {row.spans.flatMap((span, index) => {
        const start = span.start ?? span.end
        if (!start) return []
        const end = span.end ?? (span.live ? { at: new Date(now).toISOString() } : start)
        const left = axis.position(Date.parse(start.at))
        const right = axis.position(Date.parse(end.at))
        const status = span.live ? 'running' : span.status
        return [<span key={index} className={`step-bar-segment status-fill-${status}`} style={{ left: `${left * 100}%`, width: `${Math.max(0, right - left) * 100}%` }} />]
      })}
      {outageBands(row, gaps, now).map(band => {
        const left = axis.position(band.start)
        return <span key={band.start} className="step-bar-outage" data-outage="controller_down" style={{ left: `${left * 100}%`, width: `${Math.max(0, axis.position(band.end) - left) * 100}%` }} />
      })}
      {axis.breaks.map(item => <span key={item.at} className="step-bar-break" style={{ left: `${item.at * 100}%` }} />)}
    </span>
  )
}

type StepsProps = {
  rows: StepRow[]
  timeline: Timeline | null
  now: number
  /** The run can still move by itself (running or awaiting a decision): its axis runs to now, else to its last activity. */
  live: boolean
  nodeHref: (nodeId: string) => string
  onNavigate: (pathname: string) => void
}

/**
 * The Steps table (docs/PRD_VIEWER_UX.md 4.2, `run-node-list`): one row per step with when it started, how long it took, its
 * attempts and their marks, its outcome and a bar on the run's time axis. Each row's step link opens the node page; the
 * bar is decoration, its times are in the text cells. Inferred times carry `≈`, their source in the tooltip.
 */
export function StepsTable({ rows, timeline, now, live, nodeHref, onNavigate }: StepsProps) {
  const [zone] = useTimeZone()
  const from = timeline ? Math.min(Date.parse(timeline.runStart.at), ...rows.flatMap(row => row.start ? [Date.parse(row.start.at)] : [])) : null
  const ends = rows.flatMap(row => row.end ? [Date.parse(row.end.at)] : [])
  const to = timeline === null ? null
    : timeline.runEnd ? Date.parse(timeline.runEnd.at)
      : live ? Math.max(now, ...ends)
        : Math.max(timeline.lastActivity ? Date.parse(timeline.lastActivity.at) : 0, ...ends)
  const busy = rows.flatMap(row => row.spans.flatMap(span => {
    const start = span.start ?? span.end
    if (!start) return []
    return [{ start: Date.parse(start.at), end: span.end ? Date.parse(span.end.at) : span.live ? now : Date.parse(start.at) }]
  }))
  const axis = from !== null && to !== null && to > from ? timeAxis(from, to, busy) : null
  return (
    <section className="run-steps" aria-labelledby="run-steps-title">
      <h3 id="run-steps-title" className="visually-hidden">Steps</h3>
      <table className="steps-table" data-testid="run-node-list" role="table" aria-labelledby="run-steps-title">
        <caption className="steps-hint" data-testid="node-hint">Select a step to open its evidence. ≈ marks a time no event recorded: it is inferred (hover for the source).</caption>
        <thead role="rowgroup">
          <tr role="row">
            <th scope="col" role="columnheader" className="step-name">Step</th>
            <th scope="col" role="columnheader" className="step-started">Started{zone === 'utc' ? ' (UTC)' : ''}</th>
            <th scope="col" role="columnheader" className="step-took">Took</th>
            <th scope="col" role="columnheader" className="step-attempts">Attempts</th>
            <th scope="col" role="columnheader" className="step-outcome">Outcome</th>
            <th scope="col" role="columnheader" className="step-bar">
              {axis && timeline ? (
                <span className="step-axis" aria-hidden="true">
                  <Time iso={new Date(axis.from).toISOString()} />
                  <span className="step-axis-rule" title={axis.breaks.length ? `Silences over 30 minutes are shortened: ${axis.breaks.map(item => formatSpan(item.ms)).join(', ')}` : undefined}>
                    {formatSpan(axis.to - axis.from)}{axis.breaks.length > 0 ? ` · ${axis.breaks.length} ${axis.breaks.length === 1 ? 'break' : 'breaks'}` : ''}
                  </span>
                  <Time iso={new Date(axis.to).toISOString()} />
                </span>
              ) : <span className="visually-hidden">Timeline</span>}
            </th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          {rows.map(row => {
            const glyph = row.attention ? '?' : STATUS_GLYPH[row.shown]
            const note = sourceNote(row)
            return (
              <tr key={row.node_id} role="row" className={`step-row status-row-${row.shown}`} data-node-id={row.node_id} data-status={row.status} data-attention={row.attention ?? undefined}>
                <th scope="row" role="rowheader" className="step-name">
                  <AppLink href={nodeHref(row.node_id)} onNavigate={onNavigate} className="step-link" title={`${row.label}: ${STATUS_LABEL[row.shown].toLowerCase()}${row.attention ? ', waits on you' : ''}`}>
                    <span className={`step-glyph status-text-${row.shown}`} aria-hidden="true">{glyph}</span>
                    <span className="step-label">{row.label}</span>
                  </AppLink>
                </th>
                <td role="cell" className="step-started" title={row.start?.note ?? undefined}>{row.start ? <>{row.start.source === 'inferred' ? '≈' : ''}<Time iso={row.start.at} /></> : '—'}</td>
                <td role="cell" className="step-took" title={note || undefined}>{row.ms === null ? '—' : `${row.inferred ? '≈' : ''}${formatSpan(row.ms)}`}</td>
                <td role="cell" className="step-attempts">{row.attempt === 0 ? '—' : `attempt ${row.attempt}`}{row.marks && <> · <span className="step-marks">{row.marks}</span></>}</td>
                <td role="cell" className="step-outcome" title={row.outcome}>{row.outcome}</td>
                <td role="cell" className="step-bar" aria-hidden="true">{axis && timeline && <Bar row={row} axis={axis} gaps={timeline.gaps} now={now} />}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}

const MARKER_WHO: Partial<Record<MarkerKind, string>> = { diagnosis: '⚑ Controller', repair: '⚒ Operator', question: '? Question', answer: 'Answer' }
const STATUS_WORD: Record<string, string> = { failed: 'failed', succeeded: 'succeeded', paused: 'paused', cancelled: 'cancelled', no_record: 'ended without a record' }

type ActivityProps = {
  timeline: Timeline
  labels: ReadonlyMap<string, string>
  nodeHref: (nodeId: string) => string
  onNavigate: (pathname: string) => void
}

/**
 * Activity (docs/PRD_VIEWER_UX.md 4.2, `run-timeline`): the run's history as rows, oldest first unless the reader chose
 * newest first (remembered). Node-less controller rows, the diagnosis and the repair included, are shown like any other; only
 * the controller's PID checkpoints sit behind "Controller log (n)". Silences are rows of text. An attempt row opens its node;
 * a reworded row's `#n` button shows the event number's full served message under it.
 */
export function Activity({ timeline, labels, nodeHref, onNavigate }: ActivityProps) {
  const [zone] = useTimeZone()
  const [newestFirst, setNewestFirst] = useState(readNewestFirst)
  const [showLog, setShowLog] = useState(false)
  // The rows whose event number and served message are expanded, by row key.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (key: string) => setExpanded(previous => {
    const next = new Set(previous)
    if (!next.delete(key)) next.add(key)
    return next
  })
  const logCount = timeline.activity.filter(row => row.controller_log).length
  const rows = useMemo(() => {
    const shown = timeline.activity.filter(row => showLog || !row.controller_log)
    return newestFirst ? [...shown].reverse() : shown
  }, [timeline, showLog, newestFirst])
  const attempts = (nodeId: string) => timeline.byNode.get(nodeId)?.length ?? 0

  const who = (row: ActivityRow) => {
    if (row.marker && MARKER_WHO[row.marker]) return MARKER_WHO[row.marker]!
    if (row.node_id === null || row.marker === 'controller_start' || row.marker === 'controller_error' || row.marker === 'controller_blocked' || row.marker === 'interrupted') return 'Controller'
    return labels.get(row.node_id) ?? row.node_id
  }
  const text = (row: ActivityRow) => {
    let value = row.text
    if (row.kind === 'end' && row.attempt !== null && row.node_id !== null && attempts(row.node_id) > 1 && !/^attempt \d+/i.test(value)) {
      value = `attempt ${row.attempt} ${STATUS_WORD[row.status ?? ''] ?? ''} · ${value}`.replace(/ {2}/g, ' ')
    }
    if (row.kind === 'end' && row.ms !== null) value += ` · ${row.inferred ? '≈' : ''}${formatSpan(row.ms)}`
    return value
  }

  return (
    <section className="run-activity" data-testid="run-timeline" aria-labelledby="run-activity-title">
      <div className="activity-head">
        <h3 id="run-activity-title">Activity{zone === 'utc' ? ' (UTC)' : ''}</h3>
        <span className="projects-muted">{newestFirst ? 'newest first' : 'oldest first'}</span>
        <button
          type="button"
          className="button button-small"
          aria-pressed={newestFirst}
          data-testid="activity-order"
          onClick={() => setNewestFirst(previous => { rememberNewestFirst(!previous); return !previous })}
        >
          Newest first
        </button>
        {logCount > 0 && (
          <button type="button" className="button button-small" aria-pressed={showLog} data-testid="activity-controller-log" onClick={() => setShowLog(previous => !previous)}>
            Controller log ({logCount})
          </button>
        )}
      </div>
      <ol className="activity-list">
        {rows.map((row, index) => {
          if (row.kind === 'gap') {
            return (
              <li key={`gap-${row.at}-${index}`} className="activity-row activity-gap" data-kind="gap" data-gap={row.gap?.kind}>
                <span className="activity-gap-text">┆ {row.text} {row.ms === null ? '' : formatSpan(row.ms)}</span>
              </li>
            )
          }
          const status = row.kind === 'end' ? row.status : null
          const link = row.kind === 'end' && row.node_id !== null && labels.has(row.node_id) && (row.status === 'failed' || attempts(row.node_id) > 1)
          const key = `${row.sequence ?? row.at}-${row.kind}-${row.node_id ?? ''}-${row.lane ?? ''}`
          // The served message, when the row reworded it, opens under the row with its event number.
          const detail = row.raw !== null && row.raw !== row.text
          const open = detail && expanded.has(key)
          const rawId = `activity-raw-${key}`.replace(/[^\w-]/g, '_')
          return (
            <li
              key={`${key}-${index}`}
              className={`activity-row${row.controller_log ? ' activity-log' : ''}`}
              data-kind={row.kind}
              data-marker={row.marker ?? undefined}
              data-node-id={row.node_id ?? undefined}
              data-status={status ?? undefined}
            >
              <span className="activity-time">{row.inferred ? '≈' : ''}<Time iso={row.at} seconds /></span>
              <span className="activity-who">{who(row)}</span>
              <span className="activity-text">
                {status && <span className={`activity-glyph status-text-${status === 'no_record' ? 'pending' : status}`} aria-hidden="true">{status === 'no_record' ? '?' : STATUS_GLYPH[status]} </span>}
                {text(row)}
                {detail && (
                  <button
                    type="button"
                    className="activity-more"
                    aria-expanded={open}
                    aria-controls={open ? rawId : undefined}
                    aria-label={`${open ? 'Hide' : 'Show'} the recorded message${row.sequence === null ? '' : ` of event ${row.sequence}`}`}
                    data-testid="activity-more"
                    onClick={() => toggle(key)}
                  >
                    {row.sequence === null ? 'message' : `#${row.sequence}`}
                  </button>
                )}
                {open && <span id={rawId} className="activity-raw" data-testid="activity-raw">{row.raw}</span>}
              </span>
              {link && (
                <AppLink href={nodeHref(row.node_id!)} onNavigate={onNavigate} className="activity-open" aria-label={`Open ${labels.get(row.node_id!)}, attempt ${row.attempt ?? ''}`.trim()}>open ›</AppLink>
              )}
            </li>
          )
        })}
      </ol>
    </section>
  )
}
