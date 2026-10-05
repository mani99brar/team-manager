import { COMMAND_LEGEND } from '../../../contracts/projects/triage.ts'
import type { AttackAttacker, AttackFinding, AttackResult } from '../api.ts'
import {
  attackerDuration, attackHeadline, costText, currentLabel, effectiveSeverity, FINDING_STATUS_WORDING, foldedFindings, labelCommand, rerunLine, verifiedFindings,
} from '../attack.ts'
import { ErrorPanel, LoadingPanel } from '../panels.tsx'
import { formatSpan } from '../time.ts'
import { Card, Chip, SeverityChip } from '../ui/index.tsx'
import type { Tone } from '../tone.ts'
import type { Resource } from '../useResource.ts'
import './attack.css'

type Pass = AttackResult

export const REPORT_ONLY = 'Report-only: never changes the run\'s verdict'

const PASS_TONE: { [status in Pass['status']]: Tone } = { pending: 'idle', running: 'run', succeeded: 'ok', failed: 'fail', refused: 'warn' }
const ATTACKER_TONE: { [status in AttackAttacker['status']]: Tone } = { running: 'run', succeeded: 'ok', failed: 'fail', refused: 'warn', timed_out: 'fail' }
const words = (value: string) => value.replace(/_/g, ' ')

function VerifiedCard({ finding }: { finding: AttackFinding }) {
  const label = currentLabel(finding)
  const severity = effectiveSeverity(finding)
  return (
    <li data-testid="attack-finding" data-id={finding.id} data-status={finding.status} data-severity={severity} data-label={label?.label ?? 'unlabelled'}>
      <Card tone={severity === 'P2' ? 'warn' : 'fail'} className="attack-card">
        <p className="attack-card-head">
          <SeverityChip severity={severity} data-testid="attack-severity" /> <strong>{finding.id}</strong> · {finding.title}
          {severity !== finding.severity && <span className="projects-muted"> (attacker said {finding.severity}; the skeptic's severity is shown)</span>}
        </p>
        <dl className="attack-facts">
          <div><dt>Threat</dt><dd>{finding.threat}</dd></div>
          <div><dt>Requirement</dt><dd data-testid="attack-requirement">{finding.requirement ?? <span className="projects-muted">No requirement quoted</span>}</dd></div>
          <div><dt>Test</dt><dd><code data-testid="attack-test-file">{finding.test_file}</code></dd></div>
          <div>
            <dt>Label</dt>
            <dd data-testid="attack-label">
              {label === null ? (
                <>
                  <Chip tone="warn" plain>Unlabelled</Chip>
                  <span className="attack-command"><span aria-hidden="true">$ </span><code data-testid="attack-label-command">{labelCommand(finding.id)}</code></span>
                </>
              ) : (
                <>
                  <Chip tone={label.label === 'real' ? 'fail' : 'idle'} plain>{label.label}</Chip>
                  {' '}· review found: {label.review_found ?? 'not said'}
                  {label.note !== null && <> · {label.note}</>}
                </>
              )}
            </dd>
          </div>
        </dl>
      </Card>
    </li>
  )
}

function FoldedLine({ record, finding }: { record: Pass; finding: AttackFinding }) {
  const reason = rerunLine(record, finding)
  return (
    <li className="attack-folded-line" data-testid="attack-finding" data-id={finding.id} data-status={finding.status} data-severity={finding.severity}>
      <SeverityChip severity={finding.severity} /> <strong>{finding.id}</strong> · {finding.title} · <span className="attack-status">{FINDING_STATUS_WORDING[finding.status]}</span>
      {reason !== null && <> — {reason}</>}
      {finding.status === 'refuted' && finding.skeptic !== null && <> — skeptic: {finding.skeptic.reason}</>}
      {' '}· <code>{finding.test_file}</code>
    </li>
  )
}

function AttackerLine({ attacker }: { attacker: AttackAttacker }) {
  const duration = attackerDuration(attacker)
  return (
    <li className="attack-attacker" data-testid="attack-attacker" data-angle={attacker.angle} data-status={attacker.status}>
      <p>
        <strong>{attacker.angle}</strong> · <Chip tone={ATTACKER_TONE[attacker.status]}>{words(attacker.status)}</Chip> · cost {costText(attacker.cost_usd)}
        {' '}· {duration === null ? 'still running or not timed' : `took ${formatSpan(duration)}`}
        {' '}· skeptic {words(attacker.skeptic.status)}{attacker.skeptic.cost_usd !== null && <> ({costText(attacker.skeptic.cost_usd)})</>}
      </p>
      {attacker.error !== null && <p className="attack-error-line">Error: {attacker.error}</p>}
      {attacker.skeptic.error !== null && <p className="attack-error-line">Skeptic error: {attacker.skeptic.error}</p>}
      {attacker.summary !== null && <p className="projects-muted">{attacker.summary}</p>}
    </li>
  )
}

/**
 * The attack pass's record (docs/PRD_ATTACK_PASS.md 4.6): the report-only line, the pass status and its counts, one card per
 * verified finding (the skeptic's severity, title, threat, requirement, test file and the current label, or Unlabelled with
 * the command to label it), the other findings folded, the attackers and the out-of-reach notes. A pending pass says it runs
 * at the review step; a failed or refused one shows its error. Read-only: the viewer prints the label command, never runs it.
 */
export function AttackPassBody({ record, onRetry }: { record: Resource<Pass | null>; onRetry: () => void }) {
  if (record.status === 'idle' || record.status === 'loading') return <LoadingPanel>Loading the attack pass record…</LoadingPanel>
  if (record.status === 'error') return <ErrorPanel error={record.error} what="The attack pass record" onRetry={onRetry} />
  const data = record.data
  if (data === null) {
    return <p className="projects-muted" data-testid="attack-none">Attack pass record not recorded: its record is not readable, or the run's export predates the attack pass.</p>
  }
  const headline = attackHeadline(data)
  const verified = verifiedFindings(data)
  const folded = foldedFindings(data)
  const notes = data.attackers.flatMap(attacker => attacker.out_of_reach.map(note => ({ angle: attacker.angle, note })))
  return (
    <div className="attack" data-testid="attack" data-status={data.status} data-source={data.source}>
      <p className="attack-report-only" data-testid="attack-report-only">{REPORT_ONLY}</p>
      <p className="attack-headline" data-testid="attack-headline" data-status={data.status}>
        <Chip tone={PASS_TONE[data.status]} live={data.status === 'running'}>{headline.status}</Chip>
        {headline.counts !== null && <> · <span data-testid="attack-counts">{headline.counts}</span></>}
      </p>
      <p className="projects-muted attack-source" data-testid="attack-source" data-source={data.source}>
        {data.source === 'live' ? 'Read live from the run\'s attack.json' : 'Read from the run\'s export'}
        {' '}· angles {data.settings.angles.join(', ')} · ${data.settings.budget_usd} and {data.settings.timeout_minutes} min per attacker, at most {data.settings.max_findings} findings
      </p>
      {data.status === 'pending' && <p data-testid="attack-pending">The attack pass runs at the review step, beside the reviewers; nothing has run yet.</p>}
      {(data.status === 'failed' || data.status === 'refused') && (
        <p className="attack-error-line" role="note" data-testid="attack-error">The pass {data.status === 'refused' ? 'was refused' : 'failed'}: {data.error ?? 'no error recorded'}</p>
      )}
      {verified.length > 0 && (
        <div data-testid="attack-verified">
          <h5>Verified findings ({verified.length})</h5>
          <ul className="attack-cards">{verified.map(finding => <VerifiedCard key={finding.id} finding={finding} />)}</ul>
          {verified.some(finding => currentLabel(finding) === null) && <p className="projects-muted attack-legend">{COMMAND_LEGEND}</p>}
        </div>
      )}
      {folded.length > 0 && (
        <details className="attack-folded" data-testid="attack-folded">
          <summary>{folded.length} not verified: reproduced but not judged, refuted or not reproduced</summary>
          <ul className="attack-list">{folded.map(finding => <FoldedLine key={finding.id} record={data} finding={finding} />)}</ul>
        </details>
      )}
      {data.attackers.length > 0 && (
        <div data-testid="attack-attackers">
          <h5>Attackers ({data.attackers.length})</h5>
          <ul className="attack-list">{data.attackers.map(attacker => <AttackerLine key={attacker.id} attacker={attacker} />)}</ul>
        </div>
      )}
      {notes.length > 0 && (
        <div data-testid="attack-out-of-reach">
          <h5>Out of reach</h5>
          <ul className="attack-notes">{notes.map((item, index) => <li key={index}>{item.angle}: {item.note}</li>)}</ul>
        </div>
      )}
    </div>
  )
}
