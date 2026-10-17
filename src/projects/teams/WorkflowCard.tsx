import { useLayoutEffect, useRef, useState } from 'react'
import type { TeamAgent, TeamSession, TeamWorkflow } from '../../../contracts/projects/teams.ts'
import { Glyph } from '../signal/Glyph.tsx'
import { Time } from '../Time.tsx'
import { toneClass, workflowTone } from '../tone.ts'
import { useTeam, usePhone } from './context.ts'
import {
  cardFilterQuery, cardOpensAtMount, filterFor, foldedFacts, idPart, logSummary, recordSource, RUNNING_CAPTION, workflowFacts, viewSearchOf, workflowMatches, workflowName, workflowStatusLine,
  type RosterFilter,
} from './model.ts'
import { PhaseStrip } from './PhaseStrip.tsx'
import { Roster } from './Roster.tsx'

const CHEVRON = <svg className="team-chev" viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>

/**
 * A description clamped to two lines (3.3), with More / Less beside it, not inside it (the clamp would swallow it), shown only
 * when the text really overflows its two lines (measured on layout and on every resize) or while it is expanded.
 */
function Description({ text }: { text: string }) {
  const [more, setMore] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const paragraph = useRef<HTMLParagraphElement>(null)
  useLayoutEffect(() => {
    const element = paragraph.current
    if (element === null || more) return
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [text, more])
  return (
    <div className="team-desc-wrap">
      <p ref={paragraph} className={`team-desc${more ? '' : ' clamped'}`} data-testid="team-workflow-description">{text}</p>
      {(overflows || more) && <button type="button" className="team-link-button team-desc-more" aria-expanded={more} onClick={() => setMore(value => !value)}>{more ? 'Less' : 'More'}</button>}
    </div>
  )
}

/**
 * One team workflow (docs/PRD_RUN_TEAMS.md 3.3): a Sheet card with a 5 px band in the workflow's tone; its name (the run id in
 * mono when unnamed), status pill and record source; the description clamped to two lines with More; the facts line (started,
 * duration, agents, tool calls, context, default model, each "not recorded" when absent); the status line; the phase strip,
 * the roster and the script log. The latest card and every running, failed or interrupted one start expanded; the others fold
 * to one 44 px head row (chevron, name, pill, "n agents · ran X"). A view-wide search opens every card holding a match.
 */
export function WorkflowCard({ session, workflow, latest, owned, onOpen }: { session: TeamSession; workflow: TeamWorkflow; latest: boolean; owned: readonly string[] | null; onOpen: (agent: TeamAgent) => void }) {
  const { clock, frozenAt, teams, query, wide = false, onQuery, idPrefix, extras, onExtras } = useTeam()
  const phone = usePhone()
  // A view-wide search (no workflow named) opens the card while one of its agents matches, and a selection naming the card opens
  // it: at mount (a deep link, a reload) and then once per new search text or selection, so the operator can still fold it.
  const viewQ = viewSearchOf(query, wide).trim()
  const [open, setOpen] = useState(() => cardOpensAtMount(workflow, latest, query, session.key, viewQ))
  const cue = `${query.session}|${query.workflow}|${viewQ}`
  const [seen, setSeen] = useState(cue)
  if (seen !== cue) {
    setSeen(cue)
    const named = query.session === session.key && query.workflow === workflow.run_id
    if (!open && (named || (viewQ !== '' && workflowMatches(workflow, viewQ)))) setOpen(true)
  }
  // The outside toggle and the role chip are the view's (`extras`), so the drawer's Previous and Next walk the same roster.
  const { outside, role } = extras(session.key, workflow.run_id)
  const { tone, word } = workflowTone(workflow.status)
  const base = `${idPrefix}-${idPart(session.key)}-${idPart(workflow.run_id)}`
  const filter = filterFor(query, session, workflow, outside, role, wide)
  const statusLine = workflowStatusLine(workflow)
  const facts = workflowFacts(workflow, clock, frozenAt)
  const setFilter = (change: Partial<RosterFilter>) => {
    if (change.outside !== undefined || change.role !== undefined) {
      onExtras(session.key, workflow.run_id, { ...(change.outside !== undefined ? { outside: change.outside } : {}), ...(change.role !== undefined ? { role: change.role } : {}) })
    }
    if (change.state === undefined && change.phase === undefined && change.q === undefined) return
    onQuery(cardFilterQuery(query, session.key, workflow.run_id, { ...filter, ...change }), 'replace')
  }
  return (
    <section className={`team-workflow ${toneClass(tone)}${open ? '' : ' folded'}`} data-testid="team-workflow" data-workflow={workflow.run_id} data-state={workflow.status} aria-labelledby={`${base}-title`}>
      <span className="team-band" aria-hidden="true" />
      <div className="team-wf-head">
        <h4 id={`${base}-title`} className="team-wf-title">
          <button type="button" className="team-wf-toggle" aria-expanded={open} aria-controls={`${base}-body`} data-team-select="" onClick={() => setOpen(value => !value)}>
            <svg className={`team-chev${open ? ' open' : ''}`} viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            {workflow.name === null ? <code className="team-mono">{workflow.run_id}</code> : workflow.name}
          </button>
        </h4>
        <span className={`team-pill ${toneClass(tone)}`} data-testid="team-workflow-status"><Glyph tone={tone} className={`team-glyph${workflow.status === 'running' ? ' breathe' : ''}`} />{word}</span>
        {open
          ? <span className="team-source">{recordSource(workflow, teams.read_at, clock)}</span>
          : <span className="team-source team-num" data-testid="team-workflow-folded">{foldedFacts(workflow, clock, frozenAt)}</span>}
      </div>
      <div id={`${base}-body`} className="team-wf-body" hidden={!open}>
        {workflow.description && <Description text={workflow.description} />}
        <p className="team-facts" data-testid="team-workflow-facts">
          <span>started {workflow.started_at ? <Time iso={workflow.started_at} /> : <span className="team-nr">not recorded</span>}</span>
          {facts.map(fact => <span key={fact} className={fact.endsWith('not recorded') ? 'team-nr' : undefined}>{fact}</span>)}
        </p>
        {statusLine && (
          <p className={`team-status-line${statusLine.tone ? ` team-finding ${toneClass(statusLine.tone)}` : ''}`} data-testid="team-workflow-line">
            {statusLine.tone && <Glyph tone={statusLine.tone} className="team-glyph" />}<span className="team-pre">{statusLine.text}</span>
          </p>
        )}
        <PhaseStrip phases={workflow.phases} pressed={filter.phase} label={workflowName(workflow)} onToggle={index => setFilter({ phase: filter.phase === index ? null : index })} />
        {workflow.status === 'running' && <p className="team-caption">{RUNNING_CAPTION}</p>}
        <Roster session={session} workflow={workflow} owned={owned} filter={filter} onFilter={setFilter} onOpen={onOpen} phone={phone} />
        {(workflow.logs.length > 0 || workflow.result_preview !== null) && (
          <details className="team-log">
            <summary data-testid="team-log-summary">{CHEVRON}{logSummary(workflow)}</summary>
            {workflow.logs.length > 0 && <pre className="team-pre-box" data-testid="team-workflow-logs">{workflow.logs.slice(0, 50).join('\n')}</pre>}
            {workflow.result_preview !== null && <pre className="team-pre-box" data-testid="team-workflow-result">{workflow.result_preview}</pre>}
            <p className="team-caption">agent text, as recorded</p>
          </details>
        )}
      </div>
    </section>
  )
}
