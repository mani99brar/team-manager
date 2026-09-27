import { createContext, useContext } from 'react'
import { controllerSuffix, type ServedRun } from './lists.ts'
import type { RunStatus } from './status.ts'
import { formatAgo, formatClock, freshnessState, utcTitle, type FreshnessState } from './time.ts'
import { usePageVisibility, useTimeZone } from './useNow.ts'
import type { ResourceMeta } from './useResource.ts'

const GLYPH: Record<FreshnessState, string> = { live: '●', watching: '●', stale: '▲', finished: '○', hidden: '' }

/**
 * What the shown run's server says beyond its export (B2 `activity`, B3 `run_dir`) and the controller readings of its
 * polls, provided by `ProjectsView` around the run page for the live chip, the Now banner and every command block. Null
 * outside a run page.
 */
// eslint-disable-next-line react-refresh/only-export-components
export const ServedRunContext = createContext<ServedRun | null>(null)

// eslint-disable-next-line react-refresh/only-export-components
export function useServedRun(): ServedRun | null {
  return useContext(ServedRunContext)
}

/**
 * The live chip (docs/PRD_VIEWER_UX.md 6.3, `live-status` with `data-state`): whether the shown run is still polled and how
 * fresh its data is. `meta` is the polled run resource's and `now` ticks at the run view. On a run page it ends with the
 * controller's liveness (`data-controller`) while the run is running or paused: `controller running` as served, `▲
 * controller not running` only once that has held for 15 s. The chip is not a live region, since its age changes every
 * second; a separate polite status announces the stale state once.
 */
export function LiveStatus({ status, meta, now }: { status: RunStatus; meta: ResourceMeta; now: number }) {
  const { visible, since } = usePageVisibility()
  const [zone] = useTimeZone()
  const served = useServedRun()
  const state = freshnessState({ status, settledAt: meta.settledAt, failures: meta.failures, visible, visibleSince: since, now })
  const controller = served === null ? null : controllerSuffix(status, served.controller)
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
      <span className={`live-status live-status-${state}`} data-testid="live-status" data-state={state} data-controller={controller ?? undefined}>
        {GLYPH[state] && <span aria-hidden="true">{GLYPH[state]} </span>}
        {text}
        {controller === 'running' && <span className="live-status-controller"> · controller running</span>}
        {controller === 'not_running' && <span className="live-status-controller live-status-controller-down"> · ▲ controller not running</span>}
      </span>
      <span className="visually-hidden" role="status">
        {state === 'stale' ? `Not updating: showing data from ${loadedClock ?? 'an earlier load'}; retrying.` : ''}
      </span>
    </>
  )
}
