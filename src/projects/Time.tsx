import { formatClock, utcTitle } from './time.ts'
import { useTimeReference, useTimeZone, useToday } from './useNow.ts'

/**
 * One served timestamp (docs/PRD_VIEWER_UX.md 5.3): a `<time>` with the ISO value as `dateTime` and the full UTC time as its
 * tooltip, shown as a clock in the remembered zone (`time-zone-toggle`). Inside a run page the date is added only when the
 * day is not the run's start day; elsewhere only when it is not today, and the day before reads "yesterday". The run's
 * start itself is the `anchor` the page's other times are read against: it is read against today, so a run page always
 * names the day its run started unless that is today.
 */
export function Time({ iso, seconds = false, anchor = false }: { iso: string; seconds?: boolean; anchor?: boolean }) {
  const [zone] = useTimeZone()
  const runStart = useTimeReference()
  const today = useToday()
  return <time dateTime={iso} title={utcTitle(iso)}>{formatClock(iso, { zone, seconds, reference: anchor ? null : runStart, now: today })}</time>
}
