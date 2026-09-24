import type { RunStatus } from './status.ts'
import { formatAgo, formatClock, freshnessState, utcTitle, type FreshnessState } from './time.ts'
import { usePageVisibility, useTimeZone } from './useNow.ts'
import type { ResourceMeta } from './useResource.ts'

const GLYPH: Record<FreshnessState, string> = { live: '●', watching: '●', stale: '▲', finished: '○', hidden: '' }

/**
 * The live chip (docs/PRD_VIEWER_UX.md 6.3, `live-status` with `data-state`): whether the shown run is still polled and how
 * fresh its data is. `meta` is the polled run resource's and `now` ticks at the run view. The chip is not a live region,
 * since its age changes every second; a separate polite status announces the stale state once.
 */
export function LiveStatus({ status, meta, now }: { status: RunStatus; meta: ResourceMeta; now: number }) {
  const { visible, since } = usePageVisibility()
  const [zone] = useTimeZone()
  const state = freshnessState({ status, settledAt: meta.settledAt, failures: meta.failures, visible, visibleSince: since, now })
  const loadedAt = meta.settledAt === null ? null : new Date(meta.settledAt).toISOString()
  const loadedClock = loadedAt === null ? null : formatClock(loadedAt, { zone, seconds: true, now })
  const updated = meta.settledAt === null ? '' : ` · updated ${formatAgo(meta.settledAt, now)}`
  let text: React.ReactNode
  if (state === 'live') text = `Live${updated}`
  else if (state === 'watching') text = `Watching${updated}`
  else if (state === 'finished') text = 'Finished · not polling'
  else if (state === 'hidden') text = 'Paused while this tab is hidden'
  else text = <>Not updating{loadedAt !== null && <> · showing data from <time dateTime={loadedAt} title={utcTitle(loadedAt)}>{loadedClock}</time></>} · retrying</>
  return (
    <>
      <span className={`live-status live-status-${state}`} data-testid="live-status" data-state={state}>
        {GLYPH[state] && <span aria-hidden="true">{GLYPH[state]} </span>}
        {text}
      </span>
      <span className="visually-hidden" role="status">
        {state === 'stale' ? `Not updating: showing data from ${loadedClock ?? 'an earlier load'}; retrying.` : ''}
      </span>
    </>
  )
}
