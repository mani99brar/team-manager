import { useSyncExternalStore } from 'react'
import { acceptedFindingsText } from '../../contracts/projects/triage.ts'
import type { RunSummary } from './api.ts'
import { monthDay, rowLook, rowSummary, rowTime, type RunClass } from './lists.ts'
import { AppLink, StatusBadge } from './panels.tsx'
import { pinStore, type Pin, type PinStore, type PinTarget } from './pins.ts'
import { STATUS_GLYPH } from './steps.ts'
import { Time } from './Time.tsx'
import { formatAgo, formatSpan, utcTitle } from './time.ts'
import { Chip } from './ui/index.tsx'
import { useTimeZone } from './useNow.ts'

/** The shared pins and whether they are saved, re-rendering on every change. */
function usePins(): { pins: readonly Pin[]; saved: boolean; store: PinStore } {
  const store = pinStore()
  const pins = useSyncExternalStore(store.subscribe, store.list)
  const saved = useSyncExternalStore(store.subscribe, store.saved)
  return { pins, saved, store }
}

type Props = {
  run: RunSummary
  /** The run's class in its served list (`classifyRuns`): what it needs from the operator, and whether it is superseded. */
  cls: RunClass
  href: string
  /** The node labels of the run's workflow, for naming the step an approval waits at. */
  labels: ReadonlyMap<string, string>
  /** What the row names beside its run id on lists that mix workflows: the workflow's title, the run's feature, the project. */
  context?: readonly (string | null)[]
  /** The lanes the run's definition launches, shown as plain chips on the Running and Paused rows (no per-lane state claim). */
  lanes?: readonly string[]
  /** An extra line under the row, in the given tone's muted colour, or plain ("superseded by <run id>"). */
  trailing?: { text: string; tone?: 'pause' } | null
  now: number
  onNavigate: (pathname: string) => void
}

/**
 * One run in a list (docs/PRD_VIEWER_UX.md 4.1, 6.4): a single link in an `<li>` whose accessible name starts with the run
 * id, carrying `data-run-id`, `data-status` and, while a question, a pane or an approval waits, `data-attention` with an
 * amber `?`. It says what happened (the status at the focus step, from the served activity), when, and for how long. A run
 * served without activity says only its status and when it was updated: no finish and no duration are invented. The revamp
 * (PRD_VIEWER_REVAMP 5.1) draws it as a table row: a tone stripe from `stateTone`, the outcome on one line with its full text
 * in the title, and the waiting-since time outside the ellipsised outcome so it is never the part cut off.
 */
export function RunRow({ run, cls, href, labels, context = [], lanes = [], trailing = null, now, onNavigate }: Props) {
  const [zone] = useTimeZone()
  const look = rowLook(run, cls)
  const kind = look.attention
  const time = rowTime(run, now, cls)
  const since = kind === null ? null : run.activity?.attention?.since ?? null
  const names = context.filter((name): name is string => Boolean(name))
  const summary = rowSummary(run, labels, kind)
  const stoppedTone = time.kind === 'stopped' && kind === null ? ' tone-pause-text' : ''
  return (
    <li className="run-row-item" data-tone={look.tone}>
      <AppLink href={href} onNavigate={onNavigate} className="run-row" data-run-id={run.run_id} data-status={run.status} data-outcome={run.accepted ? 'override' : undefined}
        data-attention={kind ?? undefined} data-superseded-by={cls.supersededBy ?? undefined}>
        <span className="run-row-head">
          <span className="run-row-glyph" aria-hidden="true">{look.glyph ?? (run.accepted ? '◆' : STATUS_GLYPH[run.status])}</span>
          <span className="run-row-id">{run.run_id}</span>
          {names.length > 0 && <span className="run-row-context">{names.join(' · ')}</span>}
          <StatusBadge status={run.status} accepted={Boolean(run.accepted)} explain />
          {lanes.length > 0 && (
            <span className="run-row-lanes">
              <span className="visually-hidden">Lanes: </span>
              {lanes.map(lane => <Chip key={lane} plain className="lane-chip" data-lane={lane}>{lane}</Chip>)}
            </span>
          )}
        </span>
        <span className="run-row-when">
          {time.kind === 'finished' && <><Time iso={time.at} /> · {formatAgo(time.at, now)} · <span className="run-row-span">{formatSpan(time.ms)}</span></>}
          {time.kind === 'stopped' && <StoppedSince how={time.how} since={time.since} now={now} zone={zone} className={`run-row-stopped${stoppedTone}`} />}
          {time.kind === 'live' && <>started <Time iso={time.started} /> · <span className="run-row-span">{formatSpan(time.ms)}</span>{time.last && <> · last activity {formatAgo(time.last, now)}</>}</>}
          {time.kind === 'updated' && <>updated <Time iso={time.at} /> · {formatAgo(time.at, now)}</>}
        </span>
        <span className="run-row-detail">
          {kind !== null && <span className="visually-hidden">Waiting on you: </span>}
          <span className="run-row-summary" title={summary}>{summary}</span>
          {run.accepted && <span className="run-row-accepted" data-testid="row-accepted">accepted by {run.accepted.by} · {acceptedFindingsText(run.accepted)}</span>}
          {since && <span className="run-row-since"> · since <Time iso={since} /></span>}
          {trailing && <span className={`run-row-paused-since${trailing.tone === 'pause' ? ' tone-pause-text' : ''}`}> · {trailing.text}</span>}
        </span>
      </AppLink>
      <PinToggle target={run} />
    </li>
  )
}

/** "paused 10 d (since Oct 2)": how long a stopped run has been stopped, its day as a `<time>` with the full UTC value in its title. */
export function StoppedSince({ how, since, now, zone, className }: { how: 'paused' | 'interrupted'; since: string; now: number; zone: 'local' | 'utc'; className?: string }) {
  const days = Math.max(0, Math.floor((now - Date.parse(since)) / 86_400_000))
  return (
    <span className={className}>
      {how} {days === 0 ? 'today' : `${days} d`} (since <time dateTime={since} title={utcTitle(since)}>{monthDay(since, now, zone)}</time>)
    </span>
  )
}

/** The pin toggle's visible words; its accessible name is these words and the run id ("Add to Triage, <run id>"). */
const pinWords = (pinned: boolean) => (pinned ? 'In Triage' : 'Add to Triage')

/**
 * "Add to Triage, <run id>" / "In Triage, <run id>" (pressed; activating it removes the pin): pins a run to Triage's Pinned
 * section, in this browser only. It issues no request; every toggle on the page shares one store, so a change anywhere shows
 * everywhere.
 */
export function PinToggle({ target, className = '' }: { target: PinTarget; className?: string }) {
  const { pins, store } = usePins()
  const pinned = pins.some(pin => pin.project_id === target.project_id && pin.workflow_id === target.workflow_id && pin.run_id === target.run_id)
  return (
    <button type="button" className={`pin-toggle ${className}`.trim()} aria-pressed={pinned} data-pinned={pinned ? 'true' : 'false'}
      aria-label={`${pinWords(pinned)}, ${target.run_id}`} title={pinned ? `Remove ${target.run_id} from Triage` : `Add ${target.run_id} to Triage`}
      onClick={() => store.toggle({ project_id: target.project_id, workflow_id: target.workflow_id, run_id: target.run_id })}>
      <span aria-hidden="true">{pinned ? '★' : '☆'}</span> {pinWords(pinned)}
    </button>
  )
}
