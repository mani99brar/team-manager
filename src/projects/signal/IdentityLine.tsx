import { isUntried } from '../../../contracts/projects/triage.ts'
import type { RunDetail, RunInputs, WorkflowDefinition } from '../api.ts'
import { INPUTS_NONE_SENTENCE } from '../Assignment.tsx'
import { LiveStatus } from '../LiveStatus.tsx'
import { AppLink, ErrorPanel, StatusBadge } from '../panels.tsx'
import { deadlinesLabel, RUN_STATUS_SHORT, shortRevision, workflowTitle } from '../status.ts'
import { Time } from '../Time.tsx'
import { TimeZoneToggle } from '../TimeZoneToggle.tsx'
import { toneClass, type Tone } from '../tone.ts'
import type { Resource, ResourceMeta } from '../useResource.ts'

type Props = {
  detail: RunDetail
  inputs: Resource<RunInputs | null>
  onRetryInputs: () => void
  /** The workflow's current definition, when the workflow list loaded; used only to say whether it changed. */
  current: WorkflowDefinition | null
  freshness: ResourceMeta
  clock: number
  /** The run's tone (`stateTone`): the status chip's colour. */
  tone: Tone
  /** The word beside the status when the run waits on the operator. */
  attentionWord: string | null
  /** The other view of the run, as a link: Assignment from the graph, the graph from Assignment. */
  other: { label: string; href: string; testId: string }
  onNavigate: (pathname: string) => void
}

/**
 * The identity line (the Signal Box design): one row that names the run in monospace, its status in colour, glyph and
 * word, its feature, the pinned definition, how fresh the page is, the Local/UTC switch and the link to its other view.
 * Every other pinned fact (branch, base commit, mode, deadlines, created and export times) waits behind Details, so the
 * first screen stays the graph.
 */
export function IdentityLine({ detail, inputs, onRetryInputs, current, freshness, clock, tone, attentionWord, other, onNavigate }: Props) {
  const { summary, definition } = detail
  const data = inputs.status === 'ready' ? inputs.data : null
  const title = data?.feature ?? workflowTitle(definition)
  const definitionChanged = current !== null && current.definition_revision !== definition.definition_revision
  return (
    <header className={`sb-idline ${toneClass(tone)}`} data-testid="run-header" data-tone={tone} aria-labelledby="run-summary-title">
      <h2 id="run-summary-title" className="sb-runid">{summary.run_id}</h2>
      <p className="run-status-line sb-state" data-testid="run-status">
        <StatusBadge status={summary.status} />
        <span className="run-status-meaning" data-testid="run-status-meaning">{attentionWord ?? RUN_STATUS_SHORT[summary.status]}</span>
        {isUntried({ detail, inputs: data }) && (
          <span className={`ui-chip ${toneClass('warn')} run-untried`} data-testid="untried-chip"
            title="This run asks for your tryout (feature.json tryout: true) and has no verdict yet; the live dock says what to try and how to record it.">Untried</span>
        )}
      </p>
      <p className="sb-feature" title={title} data-testid="run-title">{title}</p>
      <span className="sb-def" data-testid={current === null ? 'pinned-definition' : definitionChanged ? 'definition-changed' : 'definition-current'}
        title={definitionChanged ? `The workflow's current definition is revision ${shortRevision(current!.definition_revision)}; this run is shown against its own pinned graph.` : `${definition.name} · pinned definition revision`}>
        definition <code>{shortRevision(definition.definition_revision)}</code>{current === null ? '' : definitionChanged ? ' · changed since' : ' · current'}
      </span>
      <div className="sb-fresh">
        <LiveStatus status={summary.status} meta={freshness} now={clock} />
        <TimeZoneToggle />
      </div>
      <AppLink href={other.href} onNavigate={onNavigate} className="sb-other" data-testid={other.testId}>{other.label}</AppLink>
      <details className="run-details sb-details" data-testid="run-details">
        <summary>Details</summary>
        <div className="sb-details-body">
          {inputs.status === 'error' && <ErrorPanel error={inputs.error} what="The run inputs" onRetry={onRetryInputs} />}
          {inputs.status === 'ready' && inputs.data === null && <p className="projects-muted" data-testid="inputs-none">{INPUTS_NONE_SENTENCE}</p>}
          {(inputs.status === 'loading' || inputs.status === 'idle') && <p className="projects-muted">Loading the run inputs…</p>}
          <dl className="projects-facts run-details-facts" data-testid={data ? 'run-inputs-facts' : undefined}>
            {data && (
              <>
                <div><dt>Feature</dt><dd>{data.feature}</dd></div>
                <div><dt>Source branch</dt><dd>{data.source_branch === null ? 'None recorded' : <code>{data.source_branch}</code>}</dd></div>
                <div><dt>Base commit</dt><dd><code>{data.base_commit}</code></dd></div>
                <div><dt>Mode</dt><dd>{data.mode}</dd></div>
                {data.automatic && (
                  <>
                    <div><dt>Deadlines</dt><dd data-testid="run-deadlines">{deadlinesLabel(data.automatic)}</dd></div>
                    <div><dt>Permission mode</dt><dd><code>{data.automatic.permission_mode}</code></dd></div>
                    <div><dt>Finish</dt><dd>{data.automatic.finish}</dd></div>
                  </>
                )}
              </>
            )}
            <div><dt>Pinned definition</dt><dd>{definition.name} · revision <code>{shortRevision(definition.definition_revision)}</code></dd></div>
            <div><dt>Created</dt><dd><Time iso={summary.created_at} anchor /></dd></div>
            <div><dt>Export updated</dt><dd><Time iso={summary.updated_at} /></dd></div>
          </dl>
        </div>
      </details>
    </header>
  )
}
