import { isUntried, type Now, type Timeline } from '../../contracts/projects/triage.ts'
import type { RunDetail, RunInputs, WorkflowDefinition } from './api.ts'
import { INPUTS_NONE_SENTENCE } from './Assignment.tsx'
import { LiveStatus } from './LiveStatus.tsx'
import { RichText } from './NowBanner.tsx'
import { AppLink, ErrorPanel, StatusBadge } from './panels.tsx'
import { deadlinesLabel, formatDuration, RUN_STATUS_SHORT, shortRevision, workflowTitle } from './status.ts'
import { withoutGlyph } from './steps.ts'
import { Time } from './Time.tsx'
import { formatSpan } from './time.ts'
import { TimeZoneToggle } from './TimeZoneToggle.tsx'
import { toneClass, type Tone } from './tone.ts'
import type { Resource, ResourceMeta } from './useResource.ts'

type Props = {
  detail: RunDetail
  inputs: Resource<RunInputs | null>
  onRetryInputs: () => void
  /** The workflow's current definition, when the workflow list loaded; used only to say whether it changed. */
  current: WorkflowDefinition | null
  freshness: ResourceMeta
  timeline: Timeline | null
  clock: number
  /** The run's tone (`stateTone`): the header card's top rule. */
  tone: Tone
}

/** The run's span: start → end · duration once it finished, start and elapsed time while it runs, else its last activity. */
function RunSpan({ detail, timeline, clock }: { detail: RunDetail; timeline: Timeline | null; clock: number }) {
  const { status, created_at } = detail.summary
  const start = <Time iso={created_at} anchor />
  if (timeline?.runEnd) {
    return <>{start} → <Time iso={timeline.runEnd.at} /> · {formatSpan(Date.parse(timeline.runEnd.at) - Date.parse(created_at))}</>
  }
  if (status === 'running') return <>started {start} · running {formatSpan(clock - Date.parse(created_at))}</>
  if (timeline?.lastActivity) return <>started {start} · last activity <Time iso={timeline.lastActivity.at} /></>
  return <>started {start}</>
}

/**
 * The run header (docs/PRD_VIEWER_UX.md 4.2), a card with a top rule in the run's tone (docs/PRD_VIEWER_REVAMP.md 5.3): line 1
 * names the run (its feature, else the workflow's title), its status in a few words (with an Untried chip while a succeeded run
 * waits for your tryout, C7), its span and how fresh the page is, with
 * the Local/UTC switch; line 2 is the pinned inputs as one facts line (`run-inputs-facts`), whether the definition changed
 * since, and every other fact behind `Details`.
 */
export function RunHeader({ detail, inputs, onRetryInputs, current, freshness, timeline, clock, tone }: Props) {
  const { summary, definition } = detail
  const data = inputs.status === 'ready' ? inputs.data : null
  const definitionChanged = current !== null && current.definition_revision !== definition.definition_revision
  const title = data?.feature ?? workflowTitle(definition)

  const details = (
    <details className="run-details" data-testid="run-details">
      <summary>Details</summary>
      <dl className="projects-facts run-details-facts">
        {data && (
          <>
            <div><dt>Feature</dt><dd>{data.feature}</dd></div>
            <div><dt>Source branch</dt><dd>{data.source_branch === null ? 'None recorded' : <code>{data.source_branch}</code>}</dd></div>
            <div><dt>Base commit</dt><dd><code>{data.base_commit}</code></dd></div>
            <div><dt>Mode</dt><dd>{data.mode}</dd></div>
            {data.automatic && (
              <>
                <div><dt>Deadlines</dt><dd>{deadlinesLabel(data.automatic)}</dd></div>
                <div><dt>Permission mode</dt><dd><code>{data.automatic.permission_mode}</code></dd></div>
                <div><dt>Finish</dt><dd>{data.automatic.finish}</dd></div>
              </>
            )}
          </>
        )}
        <div>
          <dt>Pinned definition</dt>
          <dd data-testid="pinned-definition">{definition.name} · revision <code>{shortRevision(definition.definition_revision)}</code></dd>
        </div>
        <div><dt>Created</dt><dd><Time iso={summary.created_at} anchor /></dd></div>
        <div><dt>Export updated</dt><dd><Time iso={summary.updated_at} /></dd></div>
      </dl>
    </details>
  )
  const definitionChip = current === null ? null : definitionChanged
    ? <span className="run-definition projects-warning" data-testid="definition-changed" title={`The workflow's current definition is revision ${shortRevision(current.definition_revision)}; this run is shown against its own pinned graph.`}>definition <code>{shortRevision(definition.definition_revision)}</code> (changed since; this run keeps its own)</span>
    : <span className="run-definition" data-testid="definition-current">definition <code>{shortRevision(definition.definition_revision)}</code> (current)</span>

  return (
    <section className={`run-summary run-header ${toneClass(tone)}`} data-testid="run-header" data-tone={tone} aria-labelledby="run-summary-title">
      <div className="run-header-line">
        <h2 id="run-summary-title"><span className="run-title" title={title}>{title}</span> <span className="run-id">{summary.run_id}</span></h2>
        <p className="run-status-line" data-testid="run-status">
          <StatusBadge status={summary.status} /> <span className="run-status-meaning" data-testid="run-status-meaning">{RUN_STATUS_SHORT[summary.status]}</span>
          {isUntried({ detail, inputs: data }) && (
            <> <span className={`ui-chip ${toneClass('warn')} run-untried`} data-testid="untried-chip"
              title="This run asks for your tryout (feature.json tryout: true) and has no verdict yet; the Now banner says what to try and how to record it.">Untried</span></>
          )}
        </p>
        <p className="run-span" data-testid="run-span"><RunSpan detail={detail} timeline={timeline} clock={clock} /></p>
        <div className="run-freshness">
          <LiveStatus status={summary.status} meta={freshness} now={clock} />
          <TimeZoneToggle />
        </div>
      </div>
      {inputs.status === 'error' && <ErrorPanel error={inputs.error} what="The run inputs" onRetry={onRetryInputs} />}
      <div className="run-facts" data-testid={data ? 'run-inputs-facts' : undefined}>
        {data?.automatic && (
          <span className="run-deadline-chips" data-testid="run-deadlines">
            <span className="ui-chip" title="The worker deadline: the configured limit for a worker's turn, not how long it ran.">worker {formatDuration(data.automatic.worker_timeout_seconds)}</span>
            <span className="ui-chip" title="The review deadline: the configured limit for a review, not how long it ran.">review {formatDuration(data.automatic.review_timeout_seconds)}</span>
          </span>
        )}
        {inputs.status === 'ready' && inputs.data === null && <span className="projects-muted" data-testid="inputs-none">{INPUTS_NONE_SENTENCE}</span>}
        {(inputs.status === 'loading' || inputs.status === 'idle') && <span className="projects-muted">Loading the run inputs…</span>}
        {definitionChip}
        {details}
      </div>
    </section>
  )
}

/**
 * The one-line run bar of a node page (docs/PRD_VIEWER_UX.md 4.4): the run, its status in a few words and the Now headline,
 * which links back to the run page, where the full banner is; then the live chip and the Local/UTC switch.
 */
export function RunBar({ detail, now, clock, runHref, freshness, onNavigate }: {
  detail: RunDetail
  now: Now | null
  clock: number
  runHref: string
  freshness: ResourceMeta
  onNavigate: (pathname: string) => void
}) {
  const { summary } = detail
  return (
    <section className="run-summary run-bar" aria-labelledby="run-summary-title">
      <h2 id="run-summary-title" className="run-bar-title"><AppLink href={runHref} onNavigate={onNavigate}>{summary.run_id}</AppLink></h2>
      <p className="run-status-line run-bar-status" data-testid="run-status">
        <StatusBadge status={summary.status} /> <span className="run-status-meaning" data-testid="run-status-meaning">{RUN_STATUS_SHORT[summary.status]}</span>
        {now && (
          <span className="run-bar-now">
            <span aria-hidden="true"> · </span>
            <AppLink href={runHref} onNavigate={onNavigate} title="The run page shows the whole situation and the next step">
              <RichText text={withoutGlyph(now.headline, now.glyph)} now={clock} />
            </AppLink>
          </span>
        )}
      </p>
      <div className="run-freshness">
        <LiveStatus status={summary.status} meta={freshness} now={clock} />
        <TimeZoneToggle />
      </div>
    </section>
  )
}
