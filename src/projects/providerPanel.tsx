import type { PanelEntry, PanelFinding, PanelProvider, PanelResults } from './api.ts'
import { REPORT_ONLY } from './node/AttackSections.tsx'
import {
  acceptedFindings, contextText, fileLocation, foldedFindings, overlapCount, PANEL_STATUS_WORDING, panelDuration, panelHeadline, panelsAtStage, PROVIDER_STATUS_WORDING, providerCostText,
  providerName, TERMINAL_PANEL, thresholdText,
} from './node/providerPanel.ts'
import { ErrorPanel, LoadingPanel } from './panels.tsx'
import { formatSpan } from './time.ts'
import { Card, Chip, SeverityChip } from './ui/index.tsx'
import type { Tone } from './tone.ts'
import type { Resource } from './useResource.ts'
import './providerPanel.css'

const PANEL_TONE: { [status in PanelEntry['status']]: Tone } = { pending: 'idle', running: 'run', succeeded: 'ok', failed: 'fail', timed_out: 'fail' }
const PROVIDER_TONE: { [status in PanelProvider['status']]: Tone } = { pending: 'idle', running: 'run', ok: 'ok', timed_out: 'fail', error: 'fail', parse_failed: 'warn' }

/** The providers that raised a finding, one chip each, and the overlap badge when more than one did. */
function RaisedBy({ finding }: { finding: PanelFinding }) {
  const overlap = overlapCount(finding)
  return (
    <p className="panel-raised" data-testid="panel-raised" data-overlap={overlap}>
      <span className="projects-muted">raised by</span>
      {finding.providers_raised.map(provider => <Chip key={provider} tone="idle" plain data-testid="panel-raised-provider">{provider}</Chip>)}
      {overlap > 1 && <Chip tone="ok" data-testid="panel-overlap">overlap ×{overlap}</Chip>}
    </p>
  )
}

function AcceptedCard({ finding }: { finding: PanelFinding }) {
  return (
    <li data-testid="panel-finding" data-id={finding.id} data-severity={finding.severity} data-accepted="true" data-unanchored={finding.unanchored}>
      <Card tone={finding.severity === 'P2' ? 'warn' : 'fail'} className="panel-card">
        <p className="panel-card-head">
          <SeverityChip severity={finding.severity} data-testid="panel-severity" />
          <code data-testid="panel-location">{fileLocation(finding)}</code>
          <strong data-testid="panel-title">{finding.title}</strong>
        </p>
        <p data-testid="panel-detail">{finding.detail}</p>
        <RaisedBy finding={finding} />
      </Card>
    </li>
  )
}

function FoldedLine({ finding }: { finding: PanelFinding }) {
  return (
    <li className="panel-folded-line" data-testid="panel-finding" data-id={finding.id} data-severity={finding.severity} data-accepted="false" data-unanchored={finding.unanchored}>
      <p className="panel-card-head">
        <SeverityChip severity={finding.severity} data-testid="panel-severity" />
        <code data-testid="panel-location">{fileLocation(finding)}</code>
        <strong data-testid="panel-title">{finding.title}</strong>
        {finding.unanchored && <Chip tone="warn" plain data-testid="panel-unanchored">unanchored: matches no context label</Chip>}
      </p>
      <p data-testid="panel-detail">{finding.detail}</p>
      <RaisedBy finding={finding} />
    </li>
  )
}

function ProviderLine({ provider }: { provider: PanelProvider }) {
  const context = contextText(provider.context_bytes)
  return (
    <li className="panel-provider" data-testid="panel-provider" data-transport={provider.transport} data-model={provider.model ?? ''} data-status={provider.status}>
      <p className="panel-provider-head">
        <strong data-testid="panel-provider-name">{providerName(provider)}</strong>
        <span className="projects-muted">· transport {provider.transport}{provider.model === null && ' (default model)'}{provider.effort !== null && ` · effort ${provider.effort}`}</span>
        <Chip tone={PROVIDER_TONE[provider.status]} live={provider.status === 'running'} data-testid="panel-provider-status">{PROVIDER_STATUS_WORDING[provider.status]}</Chip>
        <span>· cost <span data-testid="panel-cost">{providerCostText(provider)}</span></span>
        {context !== null && <span className="projects-muted">· {context} of context</span>}
        {provider.finding_ids.length > 0 && <span className="projects-muted">· raised {provider.finding_ids.join(', ')}</span>}
      </p>
      {provider.error !== null && <p className="panel-error-line" data-testid="panel-provider-error">Error: {provider.error}</p>}
    </li>
  )
}

/** One panel of the record: its headline, the pending or error line, the accepted cards, the folded rest and its providers. */
function Panel({ panel }: { panel: PanelEntry }) {
  const headline = panelHeadline(panel)
  const accepted = acceptedFindings(panel)
  const folded = foldedFindings(panel)
  const duration = panelDuration(panel)
  return (
    <section className="provider-panel" data-testid="panel" data-id={panel.id} data-stage={panel.stage} data-status={panel.status} aria-label={`Panel ${panel.id}`}>
      <p className="panel-headline" data-testid="panel-headline" data-status={panel.status}>
        <strong data-testid="panel-id">{panel.id}</strong>
        {' '}· <Chip tone={PANEL_TONE[panel.status]} live={panel.status === 'running'}>{headline.status}</Chip>
        {' '}· <span data-testid="panel-stage">{headline.stage}</span>
        {headline.counts !== null && <> · <span data-testid="panel-counts">{headline.counts}</span></>}
        {' '}· <span data-testid="panel-threshold">{thresholdText(panel)}</span>
        {duration !== null && <> · took {formatSpan(duration)}</>}
      </p>
      {panel.status === 'pending' && <p data-testid="panel-pending">The panel runs at the {panel.stage} stage, beside the {panel.stage === 'review' ? 'reviewers' : 'design challenge'}; nothing has run yet.</p>}
      {(panel.status === 'failed' || panel.status === 'timed_out') && (
        <p className="panel-error-line" role="note" data-testid="panel-error">The panel {PANEL_STATUS_WORDING[panel.status]}: {panel.error ?? 'no error recorded'}</p>
      )}
      {accepted.length > 0 && (
        <div data-testid="panel-accepted">
          <h5>Accepted findings ({accepted.length})</h5>
          <ul className="panel-cards">{accepted.map(finding => <AcceptedCard key={finding.id} finding={finding} />)}</ul>
        </div>
      )}
      {accepted.length === 0 && TERMINAL_PANEL.has(panel.status) && panel.findings.length > 0 && <p className="projects-muted" data-testid="panel-none-accepted">No finding met the overlap threshold.</p>}
      {folded.length > 0 && (
        <details className="panel-folded" data-testid="panel-folded">
          <summary>{folded.length} not accepted or unanchored</summary>
          <ul className="panel-list">{folded.map(finding => <FoldedLine key={finding.id} finding={finding} />)}</ul>
        </details>
      )}
      {panel.providers.length > 0 && (
        <div data-testid="panel-providers">
          <h5>Providers ({panel.providers.length})</h5>
          <ul className="panel-list">{panel.providers.map((provider, index) => <ProviderLine key={`${providerName(provider)}-${index}`} provider={provider} />)}</ul>
        </div>
      )}
    </section>
  )
}


/**
 * The Panel section (docs/PRD_MULTI_PROVIDER_PANEL.md 4.5, Appendix A): the report-only line, where the record was read, then
 * per panel its headline (stage, finding and accepted counts, the overlap threshold), the accepted findings with severity,
 * `file:line`, title, detail, the providers that raised each and an overlap badge, the not-accepted and unanchored findings
 * folded, and each provider with its transport, model, status and cost (`subscription-covered` for an openai-codex row). A
 * pending panel says it runs at its stage; a failed or timed-out one shows its error. `stage` narrows the record to one stage
 * (the challenge view). Read-only: nothing here acts on the panel.
 */
export function ProviderPanelBody({ record, onRetry, stage }: { record: Resource<PanelResults | null>; onRetry: () => void; stage?: PanelEntry['stage'] }) {
  if (record.status === 'idle' || record.status === 'loading') return <LoadingPanel>Loading the panel record…</LoadingPanel>
  if (record.status === 'error') return <ErrorPanel error={record.error} what="The panel record" onRetry={onRetry} />
  const data = record.data
  if (data === null) return <p className="projects-muted" data-testid="panel-none">No panel is recorded for this run.</p>
  const panels = stage === undefined ? data.panels : panelsAtStage(data.panels, stage)
  if (panels.length === 0) return <p className="projects-muted" data-testid="panel-none">No panel is recorded{stage === undefined ? '' : ` for the ${stage} stage`}.</p>
  return (
    <div className="provider-panels" data-testid="panels" data-source={data.source} data-count={panels.length}>
      <p className="panel-report-only" data-testid="panel-report-only">{REPORT_ONLY}</p>
      <p className="projects-muted panel-source" data-testid="panel-source" data-source={data.source}>
        {data.source === 'live' ? 'Read live from the run\'s panel.json' : 'Read from the run\'s export'}
      </p>
      {panels.map(panel => <Panel key={panel.id} panel={panel} />)}
    </div>
  )
}
