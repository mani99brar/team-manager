import type { MouseEvent } from 'react'
import type { JudgedPanelEntry, JudgeRuling, PanelFinding, PanelJudge, PanelSeat } from '../../contracts/projects/v1.ts'
import {
  fallbackBanner, groupRulings, JUDGE_STATUS_WORDING, judgeDuration, laneText, reviewerNodeId, rulingCountsText, rulingLocation, seatAnchorId, seatCostText, seatCounts,
  seatDuration, seatModelText, seatStatusText, sourceTarget,
} from './node/judgedPanel.ts'
import { costText, fileLocation, PANEL_STATUS_WORDING, panelDuration } from './node/providerPanel.ts'
import { AppLink } from './panels.tsx'
import { formatSpan } from './time.ts'
import { Card, Chip, SeverityChip } from './ui/index.tsx'
import type { Tone } from './tone.ts'

/** Where a reviewer source chip links: the reviewer's own node page. Absent, a reviewer chip names its reviewer without a link. */
export type PanelLinks = { nodeHref: (nodeId: string) => string; onNavigate: (pathname: string) => void }

const PANEL_TONE: { [status in JudgedPanelEntry['status']]: Tone } = { pending: 'idle', running: 'run', succeeded: 'ok', failed: 'fail', timed_out: 'fail' }
const SEAT_TONE: { [status in PanelSeat['status']]: Tone } = {
  pending: 'idle', running: 'run', ok: 'ok', timed_out: 'fail', error: 'fail', parse_failed: 'warn', unavailable: 'idle', auth_required: 'warn', usage_limit: 'warn', model_mismatch: 'warn',
}
const JUDGE_TONE: { [status in PanelJudge['status']]: Tone } = { pending: 'idle', running: 'run', judged: 'ok', failed: 'fail', timed_out: 'fail', incomplete: 'warn' }
const RULING_TONE: { [ruling in JudgeRuling['ruling']]: Tone } = { confirmed: 'fail', deferred: 'warn', refuted: 'idle' }

/** Moves to a seat's line in place (no route change): the line scrolls into view and takes focus. */
function goToSeat(event: MouseEvent<HTMLAnchorElement>, id: string) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
  const target = document.getElementById(id)
  if (!target) return
  event.preventDefault()
  target.scrollIntoView({ block: 'nearest' })
  target.focus({ preventScroll: true })
}

/** One source of a ruling as a link with its id as the label: a seat finding to that seat's line, a reviewer's to its page. */
function SourceChip({ source, panel, links }: { source: string; panel: JudgedPanelEntry; links?: PanelLinks }) {
  const target = sourceTarget(source, panel)
  if (target?.kind === 'seat') {
    const id = seatAnchorId(panel.id, target.name)
    return (
      <a className="judge-source" href={`#${id}`} onClick={event => goToSeat(event, id)} data-testid="judge-source" data-source={source} data-target-kind="seat" data-target={target.name}
        aria-label={`${source}, raised by the ${target.name} seat`}>
        {source}
      </a>
    )
  }
  if (target?.kind === 'reviewer' && links) {
    return (
      <AppLink className="judge-source" href={links.nodeHref(reviewerNodeId(target.reviewerId))} onNavigate={links.onNavigate} data-testid="judge-source" data-source={source}
        data-target-kind="reviewer" data-target={target.reviewerId} aria-label={`${source}, raised by reviewer ${target.reviewerId}`}>
        {source}
      </AppLink>
    )
  }
  return <span className="judge-source judge-source-plain" data-testid="judge-source" data-source={source} data-target-kind="none">{source}</span>
}

function RulingCard({ ruling, panel, links }: { ruling: JudgeRuling; panel: JudgedPanelEntry; links?: PanelLinks }) {
  const location = rulingLocation(ruling)
  return (
    <li data-testid="judge-ruling" data-id={ruling.id} data-ruling={ruling.ruling} data-severity={ruling.severity}>
      <Card tone={ruling.ruling === 'confirmed' ? (ruling.severity === 'P2' ? 'warn' : 'fail') : RULING_TONE[ruling.ruling]} className="panel-card judge-ruling">
        <p className="panel-card-head">
          <strong className="judge-ruling-id" data-testid="judge-ruling-id">{ruling.id}</strong>
          <SeverityChip severity={ruling.severity} data-testid="judge-ruling-severity" />
          <strong data-testid="judge-ruling-title">{ruling.title}</strong>
        </p>
        <p className="judge-ruling-where">
          {location !== null && <code data-testid="judge-ruling-location">{location}</code>}
          <span className="projects-muted" data-testid="judge-ruling-lane">{laneText(ruling.worker)}</span>
        </p>
        {ruling.detail && <p data-testid="judge-ruling-detail">{ruling.detail}</p>}
        {ruling.requirement !== null && <p className="judge-ruling-fact" data-testid="judge-ruling-requirement"><span className="projects-muted">Requirement</span> {ruling.requirement}</p>}
        <p className="judge-ruling-fact" data-testid="judge-ruling-reason"><span className="projects-muted">Reason</span> {ruling.reason}</p>
        {ruling.evidence !== null && <p className="judge-ruling-fact" data-testid="judge-ruling-evidence"><span className="projects-muted">Evidence</span> <code>{ruling.evidence}</code></p>}
        <div className="judge-sources" data-testid="judge-sources">
          <span className="projects-muted">Sources</span>
          <ul>{ruling.sources.map(source => <li key={source}><SourceChip source={source} panel={panel} links={links} /></li>)}</ul>
        </div>
      </Card>
    </li>
  )
}

function SeatLine({ seat, panel }: { seat: PanelSeat; panel: JudgedPanelEntry }) {
  const duration = seatDuration(panel, seat)
  return (
    <li id={seatAnchorId(panel.id, seat.name)} tabIndex={-1} className="panel-provider panel-seat" data-testid="panel-seat" data-name={seat.name} data-transport={seat.transport} data-status={seat.status}>
      <p className="panel-provider-head">
        <strong data-testid="panel-seat-name">{seat.name}</strong>
        <Chip tone="idle" plain data-testid="panel-seat-prefix" aria-label={`prefix ${seat.prefix}`}>{seat.prefix}</Chip>
        <Chip tone={SEAT_TONE[seat.status]} live={seat.status === 'running'} className="panel-seat-status" data-testid="panel-seat-status">{seatStatusText(seat)}</Chip>
      </p>
      <dl className="panel-seat-facts">
        <div><dt>transport</dt><dd data-testid="panel-seat-transport">{seat.transport}</dd></div>
        <div><dt>model</dt><dd data-testid="panel-seat-model">{seatModelText(seat)}</dd></div>
        {seat.cli_version !== null && <div><dt>CLI</dt><dd data-testid="panel-seat-cli-version">{seat.cli_version}</dd></div>}
        {seat.effort !== null && <div><dt>effort</dt><dd>{seat.effort}</dd></div>}
        <div><dt>duration</dt><dd data-testid="panel-seat-duration">{duration === null ? 'not recorded' : `≤ ${formatSpan(duration)}`}</dd></div>
        <div><dt>cost</dt><dd data-testid="panel-seat-cost">{seatCostText(seat)}</dd></div>
        {seat.finding_ids.length > 0 && <div><dt>raised</dt><dd data-testid="panel-seat-raised">{seat.finding_ids.join(', ')}</dd></div>}
      </dl>
      {seat.error !== null && seat.status !== 'unavailable' && <p className="panel-error-line" data-testid="panel-seat-error">Error: {seat.error}</p>}
    </li>
  )
}

function FindingLine({ finding }: { finding: PanelFinding }) {
  return (
    <li className="panel-folded-line" data-testid="panel-finding" data-id={finding.id} data-severity={finding.severity} data-accepted={finding.accepted} data-unanchored={finding.unanchored}>
      <p className="panel-card-head">
        <strong data-testid="panel-finding-id">{finding.id}</strong>
        <SeverityChip severity={finding.severity} data-testid="panel-severity" />
        <code data-testid="panel-location">{fileLocation(finding)}</code>
        <strong data-testid="panel-title">{finding.title}</strong>
      </p>
      <p data-testid="panel-detail">{finding.detail}</p>
      <p className="panel-raised projects-muted">raised by {finding.providers_raised.join(', ')}{finding.accepted ? ' · source of a confirmed ruling' : ''}</p>
    </li>
  )
}

function JudgeBlock({ panel, judge, links }: { panel: JudgedPanelEntry; judge: PanelJudge | undefined; links?: PanelLinks }) {
  if (!judge) {
    return (
      <div className="judge-block" data-testid="panel-judge" data-status="pending">
        <h5>Judge</h5>
        <p className="projects-muted">The judge has not started: it rules once every reviewer and seat has ended.</p>
      </div>
    )
  }
  const duration = judgeDuration(judge)
  const groups = groupRulings(judge.rulings)
  return (
    <div className="judge-block" data-testid="panel-judge" data-status={judge.status} data-fallback={judge.fallback}>
      <h5>Judge</h5>
      <p className="panel-provider-head judge-head">
        <Chip tone={JUDGE_TONE[judge.status]} live={judge.status === 'running'} data-testid="panel-judge-status">{JUDGE_STATUS_WORDING[judge.status]}</Chip>
        <span>· model <span data-testid="panel-judge-model">{judge.model ?? 'not pinned'}</span>{judge.effort !== null && <span className="projects-muted"> · effort {judge.effort}</span>}</span>
        <span>· cost <span data-testid="panel-judge-cost">{judge.cost_usd === null ? 'not reported' : costText(judge.cost_usd)}</span></span>
        <span>· <span data-testid="panel-judge-duration">{duration === null ? (judge.status === 'running' ? 'still judging' : 'duration not recorded') : `took ${formatSpan(duration)}`}</span></span>
      </p>
      {judge.status === 'judged' && <p className="projects-muted" data-testid="panel-judge-counts">{rulingCountsText(judge.rulings)}</p>}
      {judge.status === 'pending' && <p className="projects-muted">The judge rules once every reviewer and seat has ended.</p>}
      {judge.status === 'running' && <p className="projects-muted">The judge is reading {judge.inputs.reduce((sum, input) => sum + input.finding_ids.length, 0)} finding(s) from {judge.inputs.length} source(s).</p>}
      {judge.error !== null && !judge.fallback && <p className="panel-error-line" data-testid="panel-judge-error">Error: {judge.error}</p>}
      {groups.map(group => (
        <section key={group.ruling} className="judge-group" data-testid="judge-group" data-ruling={group.ruling} aria-label={`${group.label} rulings`}>
          <h6>{group.label} ({group.rulings.length})</h6>
          <ul className="panel-cards">{group.rulings.map(ruling => <RulingCard key={ruling.id} ruling={ruling} panel={panel} links={links} />)}</ul>
        </section>
      ))}
    </div>
  )
}

/**
 * One judged panel (panel record 1.1.0, PRD 8): the headline, the fallback banner when today's rule decided, each seat with
 * its name, prefix, transport, model, CLI version, status in words, duration and cost; then the judge with its status, model,
 * cost and duration and its rulings grouped Confirmed (P0/P1 first), Deferred and Refuted, each with its sources as links;
 * the panel findings below, listed as unjudged on a fallback and folded as raised otherwise. Nothing here acts on the run.
 */
export function JudgedPanel({ panel, links }: { panel: JudgedPanelEntry; links?: PanelLinks }) {
  const judge = panel.judge
  const banner = fallbackBanner(judge)
  const counts = seatCounts(panel)
  const duration = panelDuration(panel)
  const unjudged = judge === undefined || judge.status !== 'judged' || judge.fallback
  const status = PANEL_STATUS_WORDING[panel.status]
  return (
    <section className="provider-panel judged-panel" data-testid="panel" data-id={panel.id} data-stage={panel.stage} data-status={panel.status} data-judged="true" aria-label={`Panel ${panel.id}`}>
      <p className="panel-headline" data-testid="panel-headline" data-status={panel.status}>
        <strong data-testid="panel-id">{panel.id}</strong>
        {' '}· <Chip tone={PANEL_TONE[panel.status]} live={panel.status === 'running'}>{status.charAt(0).toUpperCase() + status.slice(1)}</Chip>
        {' '}· <span data-testid="panel-stage">{panel.stage} stage</span>
        {' '}· <span data-testid="panel-counts">{counts.ok} seat(s) ok, {counts.notOk} not ok</span>
        {duration !== null && <> · took {formatSpan(duration)}</>}
      </p>
      {banner !== null && <p className="judge-fallback" role="note" data-testid="panel-fallback-banner">{banner}</p>}
      {judge?.fallback && judge.error !== null && <p className="projects-muted" data-testid="panel-fallback-error">{judge.error}</p>}
      {panel.status === 'pending' && <p data-testid="panel-pending">The seats run beside the built-in reviewers at the review stage; nothing has run yet.</p>}
      {(panel.status === 'failed' || panel.status === 'timed_out') && panel.error !== null && (
        <p className="panel-error-line" role="note" data-testid="panel-error">The panel {status}: {panel.error}</p>
      )}
      <div data-testid="panel-seats">
        <h5>Seats ({panel.providers.length})</h5>
        <ul className="panel-list">{panel.providers.map(seat => <SeatLine key={seat.name} seat={seat} panel={panel} />)}</ul>
      </div>
      <JudgeBlock panel={panel} judge={judge} links={links} />
      {panel.findings.length > 0 && (unjudged ? (
        <div data-testid="panel-unjudged">
          <h5>Unjudged panel findings ({panel.findings.length})</h5>
          <ul className="panel-list">{panel.findings.map(finding => <FindingLine key={finding.id} finding={finding} />)}</ul>
        </div>
      ) : (
        <details className="panel-folded" data-testid="panel-folded">
          <summary>{panel.findings.length} seat finding(s) as raised</summary>
          <ul className="panel-list">{panel.findings.map(finding => <FindingLine key={finding.id} finding={finding} />)}</ul>
        </details>
      ))}
    </section>
  )
}
