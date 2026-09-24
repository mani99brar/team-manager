import { useState } from 'react'
import { formatClock, utcTitle } from './time.ts'
import { useTimeReference, useTimeZone } from './useNow.ts'

/**
 * One served timestamp (docs/PRD_VIEWER_UX.md 5.3): a `<time>` with the ISO value as `dateTime` and the full UTC time as its
 * tooltip, shown as a clock in the remembered zone (`time-zone-toggle`). Inside a run page the date is added only when the
 * day is not the run's start day; elsewhere only when it is not today, and the day before reads "yesterday".
 */
export function Time({ iso, seconds = false }: { iso: string; seconds?: boolean }) {
  const [zone] = useTimeZone()
  const reference = useTimeReference()
  // Lists read dates against the day they were rendered on.
  const [today] = useState(() => Date.now())
  return <time dateTime={iso} title={utcTitle(iso)}>{formatClock(iso, { zone, seconds, reference, now: today })}</time>
}
