/**
 * Time display for the Projects viewer (docs/PRD_VIEWER_UX.md section 5.3): clocks in the local zone or in UTC with the date
 * only when it differs from the day they are read against, relative ages, compact durations, spans between served
 * timestamps, and how fresh a polled run is (section 6.3). Pure functions: the components own the zone preference and the
 * ticking clock and pass them in.
 */
import type { RunStatus } from './status.ts'

/** Where clocks are read: the viewer's local zone (the default) or UTC, the zone of `events.jsonl` and the CLI. */
export type Zone = 'local' | 'utc'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAY_MS = 86_400_000

type Parts = { year: number; month: number; day: number; hours: number; minutes: number; seconds: number }

function instant(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const time = typeof value === 'number' ? value : Date.parse(value)
  return Number.isNaN(time) ? null : time
}

function partsOf(time: number, zone: Zone): Parts {
  const date = new Date(time)
  return zone === 'utc'
    ? { year: date.getUTCFullYear(), month: date.getUTCMonth(), day: date.getUTCDate(), hours: date.getUTCHours(), minutes: date.getUTCMinutes(), seconds: date.getUTCSeconds() }
    : { year: date.getFullYear(), month: date.getMonth(), day: date.getDate(), hours: date.getHours(), minutes: date.getMinutes(), seconds: date.getSeconds() }
}

/** The calendar day as a number, so two days read in the same zone can be compared and subtracted. */
const dayNumber = (parts: Parts) => Date.UTC(parts.year, parts.month, parts.day) / DAY_MS
const pad = (value: number) => String(value).padStart(2, '0')

export type ClockOptions = {
  zone: Zone
  /** HH:MM:SS (Activity rows, node timing lines, check rows) instead of HH:MM. */
  seconds?: boolean
  /** The instant whose day the time is read against, on run pages the run's start: the date is prefixed only when the days differ. */
  reference?: string | number | null
  /** Without a reference the day is read against today (lists), and the day before reads "yesterday". Defaults to the current time. */
  now?: number
}

/** "09:32", "09:32:31", "Sep 23 09:32", "yesterday 20:27" or "Dec 31 2025 23:00"; an unreadable value is returned as served. */
export function formatClock(iso: string, { zone, seconds = false, reference = null, now }: ClockOptions): string {
  const time = instant(iso)
  if (time === null) return iso
  const parts = partsOf(time, zone)
  const clock = `${pad(parts.hours)}:${pad(parts.minutes)}${seconds ? `:${pad(parts.seconds)}` : ''}`
  const referenceTime = instant(reference)
  const against = partsOf(referenceTime ?? now ?? Date.now(), zone)
  if (dayNumber(parts) === dayNumber(against)) return clock
  if (referenceTime === null && dayNumber(against) - dayNumber(parts) === 1) return `yesterday ${clock}`
  return `${MONTHS[parts.month]} ${parts.day}${parts.year === against.year ? '' : ` ${parts.year}`} ${clock}`
}

/** The full UTC value to the second, for the tooltip of every shown time: "2026-09-24 09:32:31 UTC". */
export function utcTitle(iso: string): string {
  const time = instant(iso)
  if (time === null) return iso
  return `${new Date(time).toISOString().slice(0, 19).replace('T', ' ')} UTC`
}

/** "just now", "3 s ago", "14 min ago", "2 h ago" or "1 d ago", rounded down; empty for an unreadable value. */
export function formatAgo(at: string | number, now: number): string {
  const time = instant(at)
  if (time === null) return ''
  const seconds = Math.floor((now - time) / 1000)
  if (seconds < 1) return 'just now'
  if (seconds < 60) return `${seconds} s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}

/** A duration rounded to the second: "46s", "2m29s", "28m21s", "1h05m". */
export function formatSpan(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m${pad(total % 60)}s`
  return `${Math.floor(minutes / 60)}h${pad(minutes % 60)}m`
}

/** Milliseconds from `start` to `end`, or null when either is missing or unreadable or the end precedes the start: never a guess. */
export function spanBetween(start: string | null | undefined, end: string | null | undefined): number | null {
  const from = instant(start)
  const to = instant(end)
  if (from === null || to === null || to < from) return null
  return to - from
}

/**
 * The live chip's state (section 6.3): `finished` for a run that is no longer polled (succeeded or cancelled), `hidden` while
 * the tab is hidden (polling pauses), `stale` after two failed polls in a row or 15 s without a success while the tab is
 * visible, else `watching` for a failed or paused run (it can still be repaired or resumed) and `live` for the others.
 */
export type FreshnessState = 'live' | 'watching' | 'stale' | 'finished' | 'hidden'

export const STALE_AFTER_FAILURES = 2
export const STALE_AFTER_MS = 15_000

export function freshnessState({ status, settledAt, failures, visible, visibleSince, now }: {
  status: RunStatus
  /** When the run last loaded successfully; null before it ever did. */
  settledAt: number | null
  /** Failed loads since the last success. */
  failures: number
  visible: boolean
  /** When the tab last became visible: a poll resumes then, so the 15 s start over. */
  visibleSince: number
  now: number
}): FreshnessState {
  if (status === 'succeeded' || status === 'cancelled') return 'finished'
  if (!visible) return 'hidden'
  if (failures >= STALE_AFTER_FAILURES) return 'stale'
  if (settledAt !== null && now - Math.max(settledAt, visibleSince) > STALE_AFTER_MS) return 'stale'
  return status === 'failed' || status === 'paused' ? 'watching' : 'live'
}
