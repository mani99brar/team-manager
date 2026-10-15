import { monthDay, stoppedLabel } from '../lists.ts'
import { STATUS_LABEL, type RunStatus } from '../status.ts'
import { formatAgo, formatSpan, type Zone } from '../time.ts'

export type DockWordsInput = {
  status: RunStatus
  /** An operator override: the run reads as its override, never as the reviewed integration it is served under. */
  accepted: boolean
  /** The run's served attention is `interrupted` (the list's `activity.attention`, or the Now's interrupted situation). */
  interrupted: boolean
  /** When it stopped: the attention's `since`, else the Now's; null when neither is recorded. */
  stoppedSince: string | null
  /** When the step the run is at started (the Now's `since`, else the step's first event); the base of "for <span>". */
  runningSince: string | null
  /** The run's end: `timeline.runEnd`, else the served `activity.finished_at`; null when neither is recorded. */
  end: string | null
  /** The run's start, for "ran <span>". */
  created: string
  clock: number
  zone: Zone
}

/**
 * The live dock bar's words after the step: `word` replaces the step's own word when the run stopped or finished ("failed",
 * "paused"), `since` follows it. A running run says how long the step has run ("for 41m15s"); a stopped one since when it
 * stopped ("paused 10 d (since Oct 2)", in the lists' words); a finished one how long ago it ended and how long it ran
 * ("failed 4 d ago · ran 1h05m"); an accepted run keeps its override word and adds only the age and the span. A time that is
 * not recorded is left out, never guessed. Pure: the clock is the page's.
 */
export function dockWords(input: DockWordsInput): { word: string | null; since: string | null } {
  const { status, accepted, interrupted, clock, zone } = input
  const finished = accepted || status === 'succeeded' || status === 'cancelled' || status === 'failed'
  if (finished) {
    const age = input.end === null ? null : formatAgo(input.end, clock)
    const span = input.end === null ? null : formatSpan(Math.max(0, Date.parse(input.end) - Date.parse(input.created)))
    const tail = [age || null, span === null ? null : `ran ${span}`].filter((part): part is string => part !== null).join(' · ')
    if (accepted) return { word: null, since: tail || null }
    return { word: status === 'succeeded' ? 'integrated' : status, since: tail || null }
  }
  if (status === 'paused' || (interrupted && status === 'running')) {
    const how = interrupted ? 'interrupted' : 'paused'
    if (input.stoppedSince === null) return { word: how, since: null }
    return { word: how, since: stoppedLabel(how, input.stoppedSince, clock, zone).slice(how.length + 1) }
  }
  if (input.runningSince === null) return { word: null, since: null }
  // Only a running run ticks; one that waits to start or on an approval says since when, never a growing span.
  if (status !== 'running') return { word: null, since: `${(STATUS_LABEL[status] ?? status).toLowerCase()} since ${monthDay(input.runningSince, clock, zone)}` }
  return { word: null, since: `for ${formatSpan(Math.max(0, clock - Date.parse(input.runningSince)))}` }
}
