/**
 * The run-sessions views (docs/PRD_RUN_SESSIONS.md 3.1-3.5): the Sessions section on the run page, the session block on every
 * node page, the reviewer/panel/lane-review node bodies, the night-shift block and the run page's night-shift count. Every
 * value comes from the `/sessions` payload; a fact the payload lacks reads "not recorded". No transcript, no absolute path,
 * no credential is ever shown: the server redacted the payload and composed the resume command after redaction.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { LaneReview, NightShiftDecision, SessionRow, Sessions } from '../api.ts'
import { AppLink } from '../panels.tsx'
import { Time } from '../Time.tsx'
import {
  costText, durationText, findingCountsText, fixRoundText, groupSessions, jevText, laneResultText, nightShiftCountText, nightShiftNodes,
  outcomeText, providerText, resumeText, reviewerRoundsOf, reviewerTone, totalsText,
} from './model.ts'
import './sessions.css'

const NOT_RECORDED = <span className="ss-nr">not recorded</span>

/** A copyable resume command (PRD 3.5): the whole line, a Copy button that says when it copied, and the worktree note. */
export function ResumeCommand({ row }: { row: SessionRow }) {
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null)
  const timer = useRef<number | null>(null)
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current) }, [])
  const text = resumeText(row)
  const copy = useCallback(async () => {
    if (!text) return
    let outcome: 'copied' | 'failed' = 'copied'
    try {
      await navigator.clipboard.writeText(text.command)
    } catch {
      // No clipboard (an insecure origin or a denied permission): the command stays on screen to select by hand.
      outcome = 'failed'
    }
    setCopied(outcome)
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(null), 2500)
  }, [text])
  if (!text) return null
  return (
    <div className="ss-resume" data-testid="session-resume">
      <span className="ss-resume-label">Resume</span>
      <code className="ss-resume-cmd" data-testid="session-resume-command">{text.command}</code>
      <button type="button" className="ss-copy" onClick={copy} aria-label={`Copy the resume command for ${row.label}`} data-testid="session-resume-copy">
        {copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Select to copy' : 'Copy'}
      </button>
      <span className="ss-sr" aria-live="polite">{copied === 'copied' ? 'Resume command copied' : copied === 'failed' ? 'Copy failed; select the command to copy it' : ''}</span>
      {text.note && <span className="ss-resume-note" data-testid="session-resume-note">{text.note}</span>}
    </div>
  )
}

function Fact({ label, value, testId }: { label: string; value: ReactNode | null; testId?: string }) {
  return <div className="ss-fact"><dt>{label}</dt><dd data-testid={testId}>{value ?? NOT_RECORDED}</dd></div>
}

/** One session's facts and, for a Claude Code session, its resume command (PRD 3.4, 3.5). Titled by the session's own label. */
export function SessionBlock({ row }: { row: SessionRow }) {
  return (
    <div className="ss-block" data-testid="session-block" data-session-key={row.key} data-role={row.role}>
      <h4 className="ss-block-title">{row.label}</h4>
      <dl className="ss-facts">
        <Fact label="Model" value={row.model} testId="session-model" />
        <Fact label="Transport" value={row.transport} testId="session-transport" />
        <Fact label="Status" value={row.status} testId="session-status" />
        {row.verdict !== null && <Fact label="Verdict" value={row.verdict} testId="session-verdict" />}
        <Fact label="Started" value={row.started_at ? <Time iso={row.started_at} seconds /> : null} testId="session-started" />
        <Fact label="Ended" value={row.ended_at ? <Time iso={row.ended_at} seconds /> : null} testId="session-ended" />
        <Fact label="Duration" value={durationText(row.duration_seconds)} testId="session-duration" />
        <Fact label="Cost" value={row.cost_usd === null ? null : costText(row.cost_usd, row.cost_kind)} testId="session-cost" />
        {row.findings !== null && <Fact label="Findings" value={findingCountsText(row.findings)} testId="session-findings" />}
        <Fact label="Session id" value={row.session_id ? <code className="ss-id">{row.session_id}</code> : null} testId="session-id" />
      </dl>
      <ResumeCommand row={row} />
    </div>
  )
}

/**
 * The reviewer node page (PRD 3.1): its verdict for the latest round, its own findings (the review page's cards filtered to
 * this reviewer, rendered by the caller), its earlier rounds' verdicts, and its session block.
 */
export function ReviewerNodeBody({ sessions, nodeId, findings }: { sessions: Sessions; nodeId: string; findings: ReactNode }) {
  const rounds = reviewerRoundsOf(sessions, nodeId)
  if (rounds.length === 0) return <p className="projects-muted" data-testid="reviewer-none">No session of this reviewer is recorded yet.</p>
  const [latest, ...earlier] = rounds
  const word = latest!.verdict ?? 'not recorded'
  return (
    <div className="ss-reviewer" data-testid="reviewer-body">
      <p className="ss-verdict" data-testid="reviewer-verdict" data-tone={reviewerTone(word)}>
        <span className={`ss-word tone-${reviewerTone(word)}`}>{word}</span>
        <span>round {latest!.round ?? '?'}{latest!.findings ? ` · ${findingCountsText(latest!.findings)} open` : ''}</span>
      </p>
      <h4 className="ss-h">Its findings, round {latest!.round ?? '?'}</h4>
      {findings}
      {earlier.length > 0 && (
        <>
          <h4 className="ss-h">Earlier rounds</h4>
          <ul className="ss-earlier" data-testid="reviewer-earlier">
            {earlier.map(round => (
              <li key={round.key} data-round={round.round}>
                <b>Round {round.round}</b>: <span className={`ss-word tone-${reviewerTone(round.verdict ?? '')}`}>{round.verdict ?? 'not recorded'}</span>
                {round.findings && <span className="ss-dim"> · {findingCountsText(round.findings)}</span>}
                {round.session_id && <span className="ss-dim"> · session <code className="ss-id">{round.session_id}</code></span>}
              </li>
            ))}
          </ul>
        </>
      )}
      <h4 className="ss-h">Session</h4>
      <SessionBlock row={latest!} />
    </div>
  )
}

/** The lane-review node page (PRD 3.2): its reviewers, every finding, the reviewed snapshot and the fix round it started. */
export function LaneReviewBody({ review, rows, repairHref, onNavigate }: { review: LaneReview; rows: readonly SessionRow[]; repairHref: (nodeId: string) => string | null; onNavigate: (pathname: string) => void }) {
  const href = review.fix_round.started && review.fix_round.repair_node_id ? repairHref(review.fix_round.repair_node_id) : null
  return (
    <div className="ss-lane" data-testid="lane-review-body">
      <p className="ss-verdict" data-testid="lane-review-result"><span className="ss-word">{laneResultText(review)}</span><span>{review.status}</span></p>
      <p className="ss-fix-round" data-testid="lane-review-fix-round">
        {review.fix_round.started && href
          ? <>Fix round started: <AppLink href={href} onNavigate={onNavigate} data-testid="lane-review-repair-link">{(review.fix_round.repair_node_id ?? '').replace(/^repair-/, 'repair ')}</AppLink></>
          : fixRoundText(review)}
      </p>
      <p className="ss-dim" data-testid="lane-review-snapshot">Reviewed snapshot <code className="ss-id">{review.snapshot.slice(0, 7) || 'not recorded'}</code></p>
      <h4 className="ss-h">Reviewers</h4>
      <ul className="ss-lines" data-testid="lane-review-reviewers">
        {review.reviewers.map((reviewer, index) => (
          <li key={index} data-testid="lane-reviewer">
            <span className="ss-item"><span className="ss-k">transport</span> {reviewer.transport}</span>
            <span className="ss-item"><span className="ss-k">model</span> {reviewer.model ?? NOT_RECORDED}</span>
            <span className="ss-item"><span className="ss-k">status</span> {reviewer.status}</span>
            <span className="ss-item"><span className="ss-k">took</span> {durationText(reviewer.duration_seconds) ?? NOT_RECORDED}</span>
            <span className="ss-item">{reviewer.cost_usd === null ? 'cost not recorded' : costText(reviewer.cost_usd, reviewer.transport === 'pi' || reviewer.transport === 'openrouter' ? 'covered' : 'metered')}</span>
            {reviewer.error && <span className="ss-item ss-error">{reviewer.error}</span>}
          </li>
        ))}
      </ul>
      <h4 className="ss-h">Findings, {review.findings.length}</h4>
      {review.findings.length === 0 ? <p className="projects-muted">No findings recorded.</p> : (
        <ul className="ss-findings" data-testid="lane-review-findings">
          {review.findings.map((finding, index) => (
            <li key={index} data-testid="lane-review-finding" data-severity={finding.severity}>
              <span className={`ss-sev ss-sev-${finding.severity}`}>{finding.severity}</span>
              <span>
                {finding.file && <code className="ss-loc">{finding.file}{finding.line !== null ? `:${finding.line}` : ''}</code>}
                <b>{finding.title}</b>
                {finding.detail && <span className="ss-detail">{finding.detail}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {rows.some(row => row.session_id !== null) && (
        <>
          <h4 className="ss-h">Sessions</h4>
          {rows.filter(row => row.session_id !== null).map(row => <SessionBlock key={row.key} row={row} />)}
        </>
      )}
    </div>
  )
}

/** The panel node page's session blocks (PRD 3.3): one per provider, beside today's panel section the caller renders. */
export function PanelSessions({ sessions }: { sessions: Sessions }) {
  const rows = sessions.sessions.filter(row => row.role === 'panel_provider')
  if (rows.length === 0) return <p className="projects-muted" data-testid="panel-sessions-none">No panel provider session is recorded.</p>
  return <div className="ss-blocks" data-testid="panel-sessions">{rows.map(row => <SessionBlock key={row.key} row={row} />)}</div>
}

/** The night-shift decisions a node received (PRD 3.3): each provider's answer, the agreement, Jev's pick, executed or held. */
export function NightShiftBlock({ decisions }: { decisions: readonly NightShiftDecision[] }) {
  if (decisions.length === 0) return null
  return (
    <div className="ss-night" data-testid="night-shift-block">
      {decisions.map((decision, index) => (
        <div key={index} className="ss-decision" data-testid="night-shift-decision" data-decision={decision.decision} data-kind={decision.kind}>
          <p className="ss-decision-head">
            <span className="ss-decision-kind" data-testid="night-shift-kind">{decision.kind}</span>
            <span className={`ss-word tone-${decision.decision === 'executed' ? 'ok' : 'warn'}`} data-testid="night-shift-outcome">{outcomeText(decision)}</span>
            <span className="ss-dim" data-testid="night-shift-when">{decision.decided_at ? <>decided <Time iso={decision.decided_at} seconds /></> : 'decided: not recorded'}</span>
          </p>
          <ul className="ss-lines" data-testid="night-shift-providers">
            {decision.providers.map((provider, providerIndex) => (
              <li key={providerIndex} data-testid="night-shift-provider">
                <span className="ss-item"><b>{provider.name}</b></span>
                <span className="ss-item">{providerText(provider)}</span>
                {provider.text && <span className="ss-detail">{provider.text}</span>}
                {provider.error && <span className="ss-detail ss-error">{provider.error}</span>}
              </li>
            ))}
          </ul>
          <p className="ss-dim" data-testid="night-shift-agreement">Agreement: {decision.agreement}</p>
          <p className="ss-dim" data-testid="night-shift-jev">{jevText(decision.jev)}</p>
          {decision.decision === 'executed' && decision.command && <p className="ss-command" data-testid="night-shift-command">Ran <code>{decision.command}</code></p>}
        </div>
      ))}
    </div>
  )
}

/** The run page's one-line count of night-shift decisions, linking to each node they decided (PRD 3.3). */
export function NightShiftCount({ sessions, nodeHref, nodeLabel, onNavigate }: { sessions: Sessions; nodeHref: (nodeId: string) => string; nodeLabel: (nodeId: string) => string; onNavigate: (pathname: string) => void }) {
  const text = nightShiftCountText(sessions)
  if (text === null) return null
  const nodes = nightShiftNodes(sessions)
  // Decisions on no served node (`controller_blocked`, `review_blocked`) are the run's: shown here, its controller section.
  const controller = sessions.night_shift.filter(decision => decision.node_id === null)
  return (
    <>
      <p className="ss-night-count" data-testid="night-shift-count">
        <span data-testid="night-shift-count-text">{text}</span>
        {nodes.map(({ nodeId, decisions }) => (
          <AppLink key={nodeId} href={nodeHref(nodeId)} onNavigate={onNavigate} className="ss-chip-link" data-testid="night-shift-link" data-node-id={nodeId}>
            {nodeLabel(nodeId)}: {decisions.map(decision => decision.decision).join(', ')}
          </AppLink>
        ))}
      </p>
      {controller.length > 0 && (
        <section className="ss-night-controller" data-testid="night-shift-controller" aria-label="Controller night-shift decisions">
          <h4 className="ss-h">Controller</h4>
          <NightShiftBlock decisions={controller} />
        </section>
      )}
    </>
  )
}

function SessionRowLine({ row, nodeHref, onNavigate }: { row: SessionRow; nodeHref: (nodeId: string) => string; onNavigate: (pathname: string) => void }) {
  const items: [string, ReactNode][] = [
    ['model', row.model ? <>{row.model}{row.transport ? <span className="ss-dim"> via {row.transport}</span> : null}</> : row.transport ? <>model not recorded<span className="ss-dim"> via {row.transport}</span></> : 'model not recorded'],
    ['status', row.verdict ? `${row.status} · ${row.verdict}` : row.status],
    ['started', row.started_at ? <>started <Time iso={row.started_at} seconds /></> : 'start not recorded'],
    ['duration', durationText(row.duration_seconds) ?? 'duration not recorded'],
    ['cost', costText(row.cost_usd, row.cost_kind)],
    ['session', row.session_id ? <code className="ss-id">{row.session_id}</code> : 'no session id'],
  ]
  return (
    <li className="ss-row" data-testid="session-row" data-role={row.role} data-session-key={row.key}>
      <span className="ss-row-label">
        {row.node_id ? <AppLink href={nodeHref(row.node_id)} onNavigate={onNavigate} data-testid="session-row-link">{row.label}</AppLink> : <span>{row.label}</span>}
      </span>
      <span className="ss-row-meta">
        {items.map(([key, value]) => <span key={key} className="ss-item" data-fact={key}>{value}</span>)}
      </span>
      {/* The list folds each resume command behind a 44 px disclosure, so a long run's list stays short on a phone; the
          session block on the node page shows it open. */}
      {resumeText(row) && (
        <details className="ss-resume-fold" data-testid="session-resume-fold">
          <summary>Resume command<span className="ss-sr"> for {row.label}</span></summary>
          <ResumeCommand row={row} />
        </details>
      )}
    </li>
  )
}

/** The run page's Sessions section (PRD 3.4): every session in start order grouped by role, both totals, and each Claude row's resume command behind a disclosure. */
export function SessionsSection({ sessions, nodeHref, onNavigate }: { sessions: Sessions; nodeHref: (nodeId: string) => string; onNavigate: (pathname: string) => void }) {
  const groups = groupSessions(sessions)
  if (groups.length === 0) return null
  return (
    <section className="ss-section" data-testid="sessions-section" aria-labelledby="sessions-title">
      <h3 id="sessions-title">Sessions</h3>
      <p className="ss-totals" data-testid="sessions-totals">{totalsText(sessions.totals)}</p>
      {groups.map(group => (
        <div key={group.role} className="ss-group" data-testid={`session-group-${group.role}`}>
          <h4>{group.label} <span className="ss-dim">{group.rows.length}</span></h4>
          <ul className="ss-rows">
            {group.rows.map(row => <SessionRowLine key={row.key} row={row} nodeHref={nodeHref} onNavigate={onNavigate} />)}
          </ul>
        </div>
      ))}
    </section>
  )
}
