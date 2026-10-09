import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Now } from '../../../contracts/projects/triage.ts'
import { CommandBlock } from '../CommandBlock.tsx'
import { AppLink } from '../panels.tsx'
import { formatSpan } from '../time.ts'
import { Time } from '../Time.tsx'
import { severityClass, severityTone, toneClass } from '../tone.ts'
import { SeverityChip } from '../ui/index.tsx'
import { Glyph } from './Glyph.tsx'
import { repairCommit, type StageNode } from './model.ts'

/** How many findings the sheet lists before "Show all". */
const FINDINGS_SHOWN = 6

type Props = {
  node: StageNode
  /** The run's situation; its next step shows on the step it concerns. */
  now: Now | null
  isFocus: boolean
  /** The step page's path. */
  href: string
  onNavigate: (pathname: string) => void
  onClose: () => void
  /** Run-level records that belong to this step (the attack pass, the provider panel), rendered before its events. */
  children?: ReactNode
}

function Fact({ label, value, testId }: { label: string; value: ReactNode | null; testId?: string }) {
  return (
    <div data-testid={testId}>
      <dt>{label}</dt>
      <dd className={value === null ? 'nr' : undefined}>{value === null ? 'not recorded' : value}</dd>
    </div>
  )
}

/**
 * The step sheet (the Signal Box design): docked to the stage's right edge (the bottom on a phone), it shows the selected
 * step's record: what it did, its facts, the command to type when the run waits at this step, the reviewers and findings of
 * the review, a repair session's trigger, files and gate reasons, a worker's questions, and the step's events. "Open step
 * page" leads to the full evidence. Nothing in it acts on the run.
 */
export function NodeSheet({ node, now, isFocus, href, onNavigate, onClose, children }: Props) {
  const close = useRef<HTMLButtonElement>(null)
  const body = useRef<HTMLDivElement>(null)
  // "Show all" holds for the step it was pressed on; another step starts folded again.
  const [allFor, setAllFor] = useState<string | null>(null)
  const allFindings = allFor === node.id
  // A new step scrolls the sheet to its top and hands the focus to Close, so Escape and the arrows keep working.
  useEffect(() => {
    if (body.current) body.current.scrollTop = 0
    close.current?.focus()
  }, [node.id])
  const duration = node.ms === null ? null : formatSpan(node.ms)
  const findings = node.findings
  const blocking = findings?.filter(finding => finding.severity !== 'P2' && finding.disposition !== 'resolved').length ?? 0
  const shownFindings = findings === null ? [] : allFindings ? findings : findings.slice(0, FINDINGS_SHOWN)
  return (
    <aside className={`sb-sheet open ${toneClass(node.tone)}`} data-testid="node-sheet" data-node-id={node.id} role="dialog" aria-modal="false" aria-labelledby="sb-sheet-title">
      <div className="sh-head">
        <span className="band" />
        <div className="sh-id">
          <h3 id="sb-sheet-title">{node.label}</h3>
          <div className="sh-sub">
            <span className={`state ${toneClass(node.tone)}`} data-testid="sheet-status"><Glyph tone={node.tone} size={16} />{node.word}</span>
            <span>{node.kindLabel} · {node.exec}</span>
            <code>{node.id}</code>
          </div>
        </div>
        <button ref={close} type="button" className="sh-close" aria-label="Close step details" onClick={onClose}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        </button>
      </div>
      <div ref={body} className="sh-body">
        <section>
          <h4>What it did</h4>
          {node.did ? <p className="did" data-testid="sheet-did">{node.did}</p> : <p className="nr-p">{node.shown === 'pending' ? 'Not started; nothing recorded for this step yet.' : 'No summary recorded.'}</p>}
        </section>
        <section>
          <h4>Facts</h4>
          <dl className="sh-facts" data-testid="sheet-facts">
            <Fact label="Attempt" value={node.attempt > 0 ? String(node.attempt) : null} />
            <Fact label="Lane" value={node.lane} />
            <Fact label="Started" value={node.start ? <>{node.start.source === 'inferred' ? '≈' : ''}<Time iso={node.start.at} /></> : null} />
            <Fact label={node.live ? 'Running for' : 'Duration'} value={duration} />
            <Fact label="Models" value={node.models.length ? node.models.join(', ') : null} />
            {node.round && <Fact label="Round" value={node.round} />}
          </dl>
        </section>
        <section>
          <h4>Command</h4>
          {isFocus && now ? <CommandBlock next={now.next} /> : <p className="nr-p">{now === null && isFocus ? 'Reading the run\'s events and results…' : 'No command is recorded for this step; the run waits elsewhere.'}</p>}
        </section>
        {node.reviewers && (
          <section>
            <h4>Reviewers</h4>
            <div className="sh-revs" data-testid="sheet-reviewers">
              {node.reviewers.map(reviewer => {
                const tone = reviewer.verdict === 'approved' ? 'ok' : reviewer.verdict === 'blocked' ? 'fail' : reviewer.status === 'superseded' ? 'pause' : 'idle'
                return <span key={reviewer.id} className={`state ${toneClass(tone)}`}><Glyph tone={tone} size={14} />{reviewer.id} {reviewer.verdict ?? reviewer.status} · {reviewer.findings} finding{reviewer.findings === 1 ? '' : 's'}</span>
              })}
            </div>
          </section>
        )}
        {findings && (
          <section>
            <h4>Findings, {blocking} blocking of {findings.length}</h4>
            {findings.length === 0 ? <p className="nr-p">No findings recorded.</p> : (
              <ul className="sh-findings" data-testid="sheet-findings">
                {shownFindings.map((finding, index) => (
                  <li key={index} className={severityClass(severityTone(finding.severity))} data-disposition={finding.disposition}>
                    <SeverityChip severity={finding.severity} />
                    <span><span className="by">{finding.reviewer}{finding.worker ? ` · ${finding.worker}` : ''}{finding.disposition !== 'open' ? ` · ${finding.disposition}` : ''}</span> {finding.message}</span>
                  </li>
                ))}
              </ul>
            )}
            {findings.length > FINDINGS_SHOWN && !allFindings && <button type="button" className="sh-more" onClick={() => setAllFor(node.id)}>Show all {findings.length}</button>}
          </section>
        )}
        {node.repair && (
          <section data-testid="sheet-repair">
            <h4>Repair</h4>
            <dl className="sh-facts">
              <Fact label="Trigger" value={node.repair.trigger} />
              <Fact label="Round" value={`${node.repair.round} of ${node.repair.rounds}`} />
              <Fact label="Recorded" value={<Time iso={node.repair.recorded_at} />} />
              <Fact label="Applied" value={node.repair.applied_at ? <Time iso={node.repair.applied_at} /> : null} />
              <Fact label="Workspace" value={<code>{repairCommit(node.repair)}</code>} />
              <Fact label="Left behind" value={node.repair.left_behind.length ? node.repair.left_behind.join(', ') : 'none'} />
            </dl>
            {node.repair.reason && <p className="did">{node.repair.reason}</p>}
            <h4 className="sh-sub-h">Files it fixed</h4>
            {node.repair.fix_files.length ? <ul className="sh-files">{node.repair.fix_files.map((file: string) => <li key={file}>{file}</li>)}</ul> : <p className="nr-p">No file recorded.</p>}
            <h4 className="sh-sub-h">Why the gate blocked</h4>
            {node.repair.gate_reasons.length ? <ul className="sh-files">{node.repair.gate_reasons.map((reason: string) => <li key={reason}>{reason}</li>)}</ul> : <p className="nr-p">No reason recorded.</p>}
          </section>
        )}
        {node.questions && (
          <section data-testid="sheet-questions">
            <h4>Questions to you</h4>
            <ol className="sh-questions">
              {node.questions.map(question => (
                <li key={question.n} data-waiting={question.answer === null}>
                  <p><b>{question.n}.</b> {question.question}</p>
                  {question.answer === null ? <p className="waiting">Waiting since <Time iso={question.asked_at} /></p> : <p className="answer">Answered <Time iso={question.answered_at!} />: {question.answer}</p>}
                </li>
              ))}
            </ol>
          </section>
        )}
        {children}
        <section>
          <h4>Events{node.events.length ? `, ${node.events.length}` : ''}</h4>
          {node.events.length === 0 ? <p className="nr-p">No event recorded for this step.</p> : (
            <ul className="sh-events" data-testid="sheet-events">
              {[...node.events].reverse().map(event => (
                <li key={event.sequence}>
                  <Time iso={event.at} />
                  <span>{event.status && <span className="ew">{event.status.replace('_', ' ')}</span>}{event.text}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <div className="sh-foot">
        <AppLink href={href} onNavigate={onNavigate} className="sh-open" data-testid="sheet-open-page">
          Open step page
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 10h11M11 5l5 5-5 5" /></svg>
        </AppLink>
      </div>
    </aside>
  )
}
