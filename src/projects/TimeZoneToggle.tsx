import type { Zone } from './time.ts'
import { useTimeZone } from './useNow.ts'

const OPTIONS: { zone: Zone; label: string; title: string }[] = [
  { zone: 'local', label: 'Local', title: 'Show times in this browser’s time zone' },
  { zone: 'utc', label: 'UTC', title: 'Show times in UTC, the zone of the run’s event log and the workflow CLI' },
]

/**
 * The remembered Local/UTC switch for every time on the page (docs/PRD_VIEWER_UX.md 5.3, `time-zone-toggle`). Whichever is
 * chosen, each time's tooltip names its UTC value.
 */
export function TimeZoneToggle() {
  const [zone, setZone] = useTimeZone()
  return (
    <div className="time-zone-toggle" role="group" aria-label="Time zone" data-testid="time-zone-toggle">
      {OPTIONS.map(option => (
        <button
          key={option.zone}
          type="button"
          className="button button-small"
          aria-pressed={zone === option.zone}
          title={option.title}
          onClick={() => setZone(option.zone)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
