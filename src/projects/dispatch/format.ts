/** Pure formatting helpers of the dispatch pages (kept out of the component file so fast refresh stays happy). */
import type { Tone } from '../tone.ts'
import type { Zone } from '../time.ts'

/** One glyph per tone, the same character the step chart and run rows use. */
export const TONE_GLYPH: Record<Tone, string> = { ok: '✓', run: '●', warn: '?', fail: '✗', pause: '‖', override: '◆', idle: '○' }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Oct 10" (or "Mar 2 2025" across a year boundary) in the reader's zone. */
export function dateOnly(iso: string, zone: Zone): string {
  const date = new Date(iso)
  const now = new Date()
  const [year, month, day, nowYear] = zone === 'utc'
    ? [date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), now.getUTCFullYear()]
    : [date.getFullYear(), date.getMonth(), date.getDate(), now.getFullYear()]
  return `${MONTHS[month]} ${day}${year === nowYear ? '' : ` ${year}`}`
}
