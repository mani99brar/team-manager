import type { ReactNode } from 'react'
import { acceptedOf, type Now } from '../../contracts/projects/triage.ts'
import type { RunDetail } from './api.ts'
import { LiveStatus } from './LiveStatus.tsx'
import { RichText } from './NowBanner.tsx'
import { AppLink, StatusBadge } from './panels.tsx'
import { OVERRIDE_SHORT, RUN_STATUS_SHORT } from './status.ts'
import { withoutGlyph } from './steps.ts'
import { TimeZoneToggle } from './TimeZoneToggle.tsx'
import type { ResourceMeta } from './useResource.ts'

/**
 * The one-line run bar of a node page (docs/PRD_VIEWER_UX.md 4.4): the run, its status in a few words and the Now headline,
 * which links back to the run page, where the full banner is; then the run's four views as plain links (docs/PRD_RUN_TEAMS.md 2
 * "Node pages"), the live chip and the Local/UTC switch.
 */
export function RunBar({ detail, now, clock, runHref, views, freshness, onNavigate }: {
  detail: RunDetail
  now: Now | null
  clock: number
  runHref: string
  /** The run's view switcher as four plain links (`RunViews` with `plain`). */
  views: ReactNode
  freshness: ResourceMeta
  onNavigate: (pathname: string) => void
}) {
  const { summary } = detail
  const accepted = acceptedOf(detail) !== null
  return (
    <section className="run-summary run-bar" aria-labelledby="run-summary-title">
      <h2 id="run-summary-title" className="run-bar-title"><AppLink href={runHref} onNavigate={onNavigate}>{summary.run_id}</AppLink></h2>
      <p className="run-status-line run-bar-status" data-testid="run-status">
        <StatusBadge status={summary.status} accepted={accepted} /> <span className="run-status-meaning" data-testid="run-status-meaning">{accepted ? OVERRIDE_SHORT : RUN_STATUS_SHORT[summary.status]}</span>
        {now && (
          <span className="run-bar-now">
            <span aria-hidden="true"> · </span>
            <AppLink href={runHref} onNavigate={onNavigate} title="The run page shows the whole situation and the next step">
              <RichText text={withoutGlyph(now.headline, now.glyph)} now={clock} />
            </AppLink>
          </span>
        )}
      </p>
      {views}
      <div className="run-freshness">
        <LiveStatus status={summary.status} meta={freshness} now={clock} />
        <TimeZoneToggle />
      </div>
    </section>
  )
}
