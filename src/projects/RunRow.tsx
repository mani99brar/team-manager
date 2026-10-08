import type { RunSummary } from './api.ts'
import { rowSummary, rowTime, waitingKind } from './lists.ts'
import { AppLink, StatusBadge } from './panels.tsx'
import { STATUS_GLYPH } from './steps.ts'
import { Time } from './Time.tsx'
import { formatAgo, formatSpan } from './time.ts'
import { stateTone } from './tone.ts'
import { Chip } from './ui/index.tsx'

type Props = {
  run: RunSummary
  href: string
  /** The node labels of the run's workflow, for naming the step an approval waits at. */
  labels: ReadonlyMap<string, string>
  /** What the row names beside its run id on lists that mix workflows: the workflow's title, the run's feature, the project. */
  context?: readonly (string | null)[]
  /** The lanes the run's definition launches, shown as plain chips on the Running and Paused rows (no per-lane state claim). */
  lanes?: readonly string[]
  /** An extra line under the row, in the given tone's muted colour (the paused "since <n> days"). */
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
export function RunRow({ run, href, labels, context = [], lanes = [], trailing = null, now, onNavigate }: Props) {
  const kind = waitingKind(run)
  const time = rowTime(run, now)
  const since = kind === null ? null : run.activity?.attention?.since ?? null
  const names = context.filter((name): name is string => Boolean(name))
  const summary = rowSummary(run, labels)
  return (
    <li className="run-row-item" data-tone={stateTone({ status: run.status, attention: kind })}>
      <AppLink href={href} onNavigate={onNavigate} className="run-row" data-run-id={run.run_id} data-status={run.status} data-attention={kind ?? undefined}>
        <span className="run-row-head">
          <span className="run-row-glyph" aria-hidden="true">{kind === null ? STATUS_GLYPH[run.status] : '?'}</span>
          <span className="run-row-id">{run.run_id}</span>
          {names.length > 0 && <span className="run-row-context">{names.join(' · ')}</span>}
          <StatusBadge status={run.status} explain />
          {lanes.length > 0 && (
            <span className="run-row-lanes">
              <span className="visually-hidden">Lanes: </span>
              {lanes.map(lane => <Chip key={lane} plain className="lane-chip" data-lane={lane}>{lane}</Chip>)}
            </span>
          )}
        </span>
        <span className="run-row-when">
          {time.kind === 'finished' && <><Time iso={time.at} /> · {formatAgo(time.at, now)} · <span className="run-row-span">{formatSpan(time.ms)}</span></>}
          {time.kind === 'live' && <>started <Time iso={time.started} /> · <span className="run-row-span">{formatSpan(time.ms)}</span>{time.last && <> · last activity {formatAgo(time.last, now)}</>}</>}
          {time.kind === 'updated' && <>updated <Time iso={time.at} /> · {formatAgo(time.at, now)}</>}
        </span>
        <span className="run-row-detail">
          {kind !== null && <span className="visually-hidden">Waiting on you: </span>}
          <span className="run-row-summary" title={summary}>{summary}</span>
          {since && <span className="run-row-since"> · since <Time iso={since} /></span>}
          {trailing && <span className={`run-row-paused-since${trailing.tone === 'pause' ? ' tone-pause-text' : ''}`}> · {trailing.text}</span>}
        </span>
      </AppLink>
    </li>
  )
}
