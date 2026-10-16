import { useState } from 'react'
import type { TeamAgent, TeamSession, TeamWorkflow } from '../../../contracts/projects/teams.ts'
import { Glyph } from '../signal/Glyph.tsx'
import { Time } from '../Time.tsx'
import { toneClass, workflowTone } from '../tone.ts'
import { useTeam, usePhone } from './context.ts'
import { cardStartsOpen, filterFor, idPart, recordSource, RUNNING_CAPTION, workflowFacts, workflowName, workflowStatusLine, type RosterFilter } from './model.ts'
import { PhaseStrip } from './PhaseStrip.tsx'
import { Roster } from './Roster.tsx'

/**
 * One team workflow (docs/PRD_RUN_TEAMS.md 3.3): a Sheet card with a 5 px band in the workflow's tone; its name (the run id in
 * mono when unnamed), status pill and record source; the description clamped to two lines with More; the facts line (started,
 * duration, agents, tool calls, context, default model, each "not recorded" when absent); the status line; the phase strip,
 * the roster and the script log. The latest card and every running, failed or interrupted one start expanded; the others fold
 * to their head line.
 */
export function WorkflowCard({ session, workflow, latest, owned, onOpen }: { session: TeamSession; workflow: TeamWorkflow; latest: boolean; owned: readonly string[] | null; onOpen: (agent: TeamAgent) => void }) {
  const { clock, teams, query, onQuery, idPrefix } = useTeam()
  const phone = usePhone()
  const [open, setOpen] = useState(() => cardStartsOpen(workflow, latest))
  const [more, setMore] = useState(false)
  const [outside, setOutside] = useState(false)
  const { tone, word } = workflowTone(workflow.status)
  const base = `${idPrefix}-${idPart(session.key)}-${idPart(workflow.run_id)}`
  const filter = filterFor(query, session, workflow, outside)
  const statusLine = workflowStatusLine(workflow)
  const facts = workflowFacts(workflow, clock)
  const setFilter = (change: Partial<RosterFilter>) => {
    if (change.outside !== undefined) setOutside(change.outside)
    const next = { ...filter, ...change }
    if (change.state === undefined && change.phase === undefined && change.q === undefined) return
    onQuery({ ...query, session: session.key, workflow: workflow.run_id, state: next.state, phase: next.phase, q: next.q }, 'replace')
  }
  const longDescription = (workflow.description ?? '').length > 140
  return (
    <section className={`team-workflow ${toneClass(tone)}`} data-testid="team-workflow" data-workflow={workflow.run_id} data-state={workflow.status} aria-labelledby={`${base}-title`}>
      <span className="team-band" aria-hidden="true" />
      <div className="team-wf-head">
        <h4 id={`${base}-title`} className="team-wf-title">
          <button type="button" className="team-wf-toggle" aria-expanded={open} aria-controls={`${base}-body`} data-team-select="" onClick={() => setOpen(value => !value)}>
            <svg className={`team-chev${open ? ' open' : ''}`} viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            {workflow.name === null ? <code className="team-mono">{workflow.run_id}</code> : workflow.name}
          </button>
        </h4>
        <span className={`team-pill ${toneClass(tone)}`} data-testid="team-workflow-status"><Glyph tone={tone} className={`team-glyph${workflow.status === 'running' ? ' breathe' : ''}`} />{word}</span>
        <span className="team-source">{recordSource(workflow, teams.read_at, clock)}</span>
      </div>
      <div id={`${base}-body`} className="team-wf-body" hidden={!open}>
        {workflow.description && (
          <p className={`team-desc${more ? '' : ' clamped'}`}>
            {workflow.description}
            {longDescription && <> <button type="button" className="team-link-button" aria-expanded={more} onClick={() => setMore(value => !value)}>{more ? 'Less' : 'More'}</button></>}
          </p>
        )}
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
            <summary>Script log and result</summary>
            {workflow.logs.length > 0 && <pre className="team-pre-box" data-testid="team-workflow-logs">{workflow.logs.slice(0, 50).join('\n')}</pre>}
            {workflow.result_preview !== null && <pre className="team-pre-box" data-testid="team-workflow-result">{workflow.result_preview}</pre>}
            <p className="team-caption">agent text, as recorded</p>
          </details>
        )}
      </div>
    </section>
  )
}
