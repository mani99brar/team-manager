import { useState } from 'react'
import type { TeamAgent, TeamSession } from '../../../contracts/projects/teams.ts'
import { Glyph } from '../signal/Glyph.tsx'
import { useTeam, usePhone } from './context.ts'
import { agentKey, agentName, agentPhase, agentRanText, idleLine, outsideFiles, ownedPathsOf, quietMinutes, toolSummary, workingFoldLine, workingRows, workingTitle } from './model.ts'

const DESK_ROWS = 6
const PHONE_ROWS = 3

/**
 * Working now (docs/PRD_RUN_TEAMS.md 3.6): every running agent across every lane, by `started_at` then `index` so the order
 * holds between polls; six rows on a desk, three on a phone, then "Show all {n} running"; each row opens the agent drawer. On a
 * phone a panel with more than three rows folds to its head line. With nothing running it is one line (the run live, or
 * finished), and it is absent when no session has team records.
 */
export function WorkingNow({ onOpen }: { onOpen: (session: TeamSession, workflow: string, agent: TeamAgent) => void }) {
  const { teams, clock, live, workers, idPrefix } = useTeam()
  const phone = usePhone()
  const [all, setAll] = useState(false)
  const [unfolded, setUnfolded] = useState(false)
  const rows = workingRows(teams)
  if (rows.length === 0) {
    const line = idleLine(teams, live, clock)
    if (line === null) return null
    return <p className="team-working-idle" data-testid="team-working-now" data-state="idle">{line}</p>
  }
  const limit = phone ? PHONE_ROWS : DESK_ROWS
  const folded = phone && rows.length > PHONE_ROWS && !unfolded
  const shown = all ? rows : rows.slice(0, limit)
  const titleId = `${idPrefix}-working-title`
  return (
    <section className="team-working" data-testid="team-working-now" data-state="running" aria-labelledby={titleId}>
      <h3 id={titleId} className="team-working-title"><Glyph tone="run" className="team-glyph breathe" />{workingTitle(rows)}</h3>
      {folded ? (
        <button type="button" className="team-button team-fold" aria-expanded={false} onClick={() => setUnfolded(true)}>{workingFoldLine(teams)}</button>
      ) : (
        <>
          <ul className="team-working-rows">
            {shown.map(({ session, workflow, agent }) => {
              const quiet = quietMinutes(agent, teams.read_at)
              const tool = toolSummary(agent)
              const ran = agentRanText(agent, clock)
              const outside = outsideFiles(agent, ownedPathsOf(session, workers)).length
              return (
                <li key={agentKey(session.key, workflow.run_id, agent.index)}>
                  <button type="button" className="team-working-row" data-testid="team-working-row" data-session={session.key} data-workflow={workflow.run_id} data-index={agent.index} data-agent-key={agentKey(session.key, workflow.run_id, agent.index)} data-team-select="" aria-label={`${agentName(agent, workflow.phases, clock, outside, teams.read_at)}, lane ${session.lane ?? session.label}`} onClick={() => onOpen(session, workflow.run_id, agent)}>
                    <Glyph tone="run" className="team-glyph breathe" />
                    <span className="team-agent-label">{agent.label}</span> <span className="team-index">#{agent.index}</span>
                    <span className="team-lane-chip">{session.lane ?? session.label}</span>
                    {agentPhase(agent, workflow.phases) && <span className="team-dim">{agentPhase(agent, workflow.phases)}</span>}
                    {ran && <span className="team-num">{ran}</span>}
                    {tool && <span className="team-mono-line team-clamp1">{tool}</span>}
                    {quiet !== null && <span className="team-quiet" data-testid="team-quiet">quiet {quiet}m</span>}
                  </button>
                </li>
              )
            })}
          </ul>
          {!all && rows.length > limit && <button type="button" className="team-more" onClick={() => setAll(true)}>Show all {rows.length} running</button>}
        </>
      )}
    </section>
  )
}
