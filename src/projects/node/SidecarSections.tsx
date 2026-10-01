import type { SidecarFinding, SidecarLedger, SidecarPass } from '../api.ts'
import { ErrorPanel, LoadingPanel } from '../panels.tsx'
import { NodeSection } from '../SectionIndex.tsx'
import { formatDuration } from '../status.ts'
import { Time } from '../Time.tsx'
import { formatAgo, formatSpan } from '../time.ts'
import type { Resource } from '../useResource.ts'
import { useTimeZone } from '../useNow.ts'
import { findingGroups, lastTransition, messageStatusWording, passDuration, passLanes, sidecarHeadline } from './sidecar.ts'
import './sidecar.css'

type Ledger = SidecarLedger

const HANDOFF_LISTS: { key: keyof NonNullable<Ledger['handoff']>; label: string }[] = [
  { key: 'unresolved', label: 'Unresolved' },
  { key: 'structural', label: 'Structural' },
  { key: 'verified_resolved', label: 'Verified resolved' },
  { key: 'withdrawn', label: 'Withdrawn' },
  { key: 'gaps', label: 'Gaps' },
]

const location = (finding: Pick<SidecarFinding, 'file' | 'locator'>) => (finding.locator ? `${finding.file}:${finding.locator}` : finding.file)
const words = (value: string) => value.replace(/_/g, ' ')

/**
 * The sidecar's one headline above the section index (docs/PRD_REVIEW_SIDECAR.md 4.9): its passes (failed ones counted), what
 * is open by severity, its messages by status and when its last pass ended; "no pass yet" before its first. `clock` is the
 * run page's own.
 */
export function SidecarHeadline({ ledger, clock }: { ledger: Resource<Ledger | null>; clock: number }) {
  const [zone] = useTimeZone()
  if (ledger.status !== 'ready') return null
  const headline = sidecarHeadline(ledger.data)
  const last = headline.lastPassAt
  return (
    <p className="sidecar-headline" data-testid="sidecar-headline">
      {headline.empty ? headline.passes : (
        <>
          {headline.passes} · {headline.open} · {headline.messages}
          {last !== null && <> · last pass <Time iso={last} />{zone === 'utc' ? ' UTC' : ''} ({formatAgo(last, clock)})</>}
        </>
      )}
    </p>
  )
}

function FindingCard({ finding }: { finding: SidecarFinding }) {
  return (
    <li className={`sidecar-card sidecar-severity-${finding.severity}`} data-testid="sidecar-finding" data-id={finding.id} data-severity={finding.severity} data-disposition={finding.disposition} data-lane={finding.lane}>
      <p className="sidecar-card-head">
        <span className="finding-severity">{finding.severity}</span> · {finding.category} · <strong>{finding.id}</strong> · lane {finding.lane}
        {' '}<span className={`sidecar-chip sidecar-disposition-${finding.disposition}`}>{words(finding.disposition)}</span>
      </p>
      <p className="sidecar-card-where"><code>{location(finding)}</code> · revision <code>{finding.revision}</code></p>
      <p className="sidecar-card-problem">{finding.problem}</p>
      <dl className="sidecar-card-facts">
        <div><dt>Evidence</dt><dd>{finding.evidence || <span className="projects-muted">none recorded yet</span>}</dd></div>
        <div><dt>Remedy</dt><dd>{finding.remedy}</dd></div>
        {finding.note !== null && <div><dt>Note</dt><dd>{finding.note}</dd></div>}
        <div><dt>Messages</dt><dd>{finding.messages.length ? finding.messages.join(', ') : <span className="projects-muted">none sent</span>}</dd></div>
      </dl>
    </li>
  )
}

function ResolvedLine({ finding }: { finding: SidecarFinding }) {
  const last = lastTransition(finding)
  return (
    <li className="sidecar-resolved-line" data-testid="sidecar-finding" data-id={finding.id} data-severity={finding.severity} data-disposition={finding.disposition} data-lane={finding.lane}>
      <strong>{finding.id}</strong> · {finding.severity} · {finding.lane} · <code>{finding.file}</code> · <span className={`sidecar-chip sidecar-disposition-${finding.disposition}`}>{words(finding.disposition)}</span>
      {last.pass !== null && <> on pass {last.pass}</>}
      {last.evidence && <> — {last.evidence}</>}
    </li>
  )
}

function PassRow({ pass }: { pass: SidecarPass }) {
  const duration = passDuration(pass)
  return (
    <tr data-testid="sidecar-pass" data-status={pass.status}>
      <td data-label="Pass">{pass.n}</td>
      <td data-label="Trigger">{pass.trigger}</td>
      <td data-label="Start"><Time iso={pass.started_at} seconds /></td>
      <td data-label="Took">{duration === null ? '—' : formatSpan(duration)}</td>
      <td data-label="Status"><span className={`sidecar-chip sidecar-pass-${pass.status}`}>{words(pass.status)}</span></td>
      <td data-label="Lanes read">
        {passLanes(pass).map((lane, index) => (
          <span key={lane.lane}>{index > 0 && ' · '}{lane.lane} <code>{lane.head}</code>{!lane.pane && <span className="projects-muted"> (pane not captured)</span>}</span>
        ))}
      </td>
      <td data-label="Summary">{pass.summary ?? <span className="projects-muted">no summary</span>}</td>
    </tr>
  )
}

/**
 * The review sidecar's sections (docs/PRD_REVIEW_SIDECAR.md 4.9), each only when it holds something: the open findings as
 * cards (P0/P1 first), the escalations, the closed findings one line each behind a closed disclosure, every message with its
 * status and reason, the passes and the final handoff. The ledger is polled by the run page while the run can move; a run
 * whose ledger is not recorded (no pass yet, or an export before the sidecar) says so. Read-only: a message that could not
 * be delivered is shown for the operator to relay, nothing here sends it.
 */
export function SidecarSections({ ledger, onRetry }: { ledger: Resource<Ledger | null>; onRetry: () => void }) {
  if (ledger.status === 'idle' || ledger.status === 'loading') return <LoadingPanel>Loading the sidecar ledger…</LoadingPanel>
  if (ledger.status === 'error') return <ErrorPanel error={ledger.error} what="The sidecar ledger" onRetry={onRetry} />
  const data = ledger.data
  if (data === null) {
    return <p className="projects-muted" data-testid="sidecar-none">Sidecar ledger not recorded: no pass has run yet, or the run's export predates the review sidecar.</p>
  }
  const { open, resolved } = findingGroups(data)
  const { settings } = data
  return (
    <div className="sidecar" data-testid="sidecar" data-source={data.source}>
      <p className="projects-muted sidecar-source" data-testid="sidecar-source" data-source={data.source}>
        {data.source === 'live' ? 'Read live from the run\'s sidecar.ledger.json' : 'Read from the run\'s export'}
        {' '}· a pass every {formatDuration(settings.cadence_seconds)} (at most {formatDuration(settings.pass_timeout_seconds)}), {settings.max_passes} passes, {settings.max_messages_per_lane} messages per lane
        {data.closed_at !== null && <> · closed <Time iso={data.closed_at} seconds /></>}
        . The sidecar advises; it blocks, approves and integrates nothing.
      </p>
      {open.length > 0 && (
        <NodeSection sectionKey="sidecar-open" title="Open findings" testId="sidecar-open">
          <ul className="sidecar-cards">{open.map(finding => <FindingCard key={finding.id} finding={finding} />)}</ul>
        </NodeSection>
      )}
      {data.escalations.length > 0 && (
        <NodeSection sectionKey="sidecar-escalations" title="Escalations" testId="sidecar-escalations">
          <ul className="sidecar-list">
            {data.escalations.map((escalation, index) => (
              <li key={index} className="sidecar-escalation" data-testid="sidecar-escalation" data-kind={escalation.kind}>
                <span className="sidecar-chip sidecar-escalation-kind">{words(escalation.kind)}</span> · <strong>{escalation.finding_id}</strong>
                {escalation.at !== undefined && <> · <Time iso={escalation.at} seconds /></>}
                {escalation.pass !== undefined && <> · pass {escalation.pass}</>}
                {' '}— {escalation.text}
              </li>
            ))}
          </ul>
        </NodeSection>
      )}
      {resolved.length > 0 && (
        <NodeSection sectionKey="sidecar-resolved" title="Resolved" testId="sidecar-resolved">
          <details className="sidecar-resolved">
            <summary>{resolved.length} closed: verified resolved, withdrawn or accepted as a trade-off</summary>
            <ul className="sidecar-list">{resolved.map(finding => <ResolvedLine key={finding.id} finding={finding} />)}</ul>
          </details>
        </NodeSection>
      )}
      {data.messages.length > 0 && (
        <NodeSection sectionKey="sidecar-messages" title="Messages" testId="sidecar-messages">
          <ul className="sidecar-list">
            {data.messages.map(message => (
              <li key={message.id} className="sidecar-message" data-testid="sidecar-message" data-status={message.status} data-lane={message.lane}>
                <p className="sidecar-message-head">
                  <Time iso={message.at} seconds /> · <strong>{message.id}</strong> to {message.lane} · <span className={`sidecar-chip sidecar-message-${message.status}`}>{messageStatusWording(message)}</span> · {message.finding_ids.join(', ')}
                </p>
                <p className="sidecar-message-text">{message.text}</p>
              </li>
            ))}
          </ul>
        </NodeSection>
      )}
      {data.passes.length > 0 && (
        <NodeSection sectionKey="sidecar-passes" title="Passes" testId="sidecar-passes">
          <div className="table-wrap">
            <table className="sidecar-passes-table">
              <thead><tr><th scope="col">Pass</th><th scope="col">Trigger</th><th scope="col">Start</th><th scope="col">Took</th><th scope="col">Status</th><th scope="col">Lanes read</th><th scope="col">Summary</th></tr></thead>
              <tbody>{data.passes.map(pass => <PassRow key={pass.n} pass={pass} />)}</tbody>
            </table>
          </div>
        </NodeSection>
      )}
      <NodeSection sectionKey="sidecar-handoff" title="Handoff" testId="sidecar-handoff">
        {data.handoff === null ? <p className="projects-muted">no final pass recorded</p> : (
          <div className="sidecar-handoff">
            {HANDOFF_LISTS.map(list => (
              <div key={list.key} data-list={list.key}>
                <h5>{list.label}</h5>
                {data.handoff![list.key].length === 0 ? <p className="projects-muted">none</p> : <ul>{data.handoff![list.key].map((entry, index) => <li key={index}>{entry}</li>)}</ul>}
              </div>
            ))}
          </div>
        )}
      </NodeSection>
    </div>
  )
}
