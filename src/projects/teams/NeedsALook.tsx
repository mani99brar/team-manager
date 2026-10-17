import { useState } from 'react'
import type { TeamAgent, TeamSession } from '../../../contracts/projects/teams.ts'
import { Glyph } from '../signal/Glyph.tsx'
import { toneClass } from '../tone.ts'
import { useTeam } from './context.ts'
import { idPart, type LookRow } from './model.ts'

const DESK_ROWS = 6

/**
 * Needs a look (docs/PRD_RUN_TEAMS.md 3.1, between the head and Working now): one run-wide list of what the lanes' attention lines
 * say one lane at a time — failed agents, interrupted workflows, edits outside a lane's paths, quiet agents (words only) and
 * unreadable records — so a run of twenty lanes is not read lane head by lane head. Each 44 px row opens the agent's drawer, or
 * scrolls to the workflow or session it names. Lane and roster order stay as they are; the panel is absent when nothing needs a
 * look.
 */
export function NeedsALook({ rows, onOpen }: { rows: readonly LookRow[]; onOpen: (session: TeamSession, workflow: string, agent: TeamAgent) => void }) {
  const { idPrefix } = useTeam()
  const [all, setAll] = useState(false)
  if (rows.length === 0) return null
  const shown = all ? rows : rows.slice(0, DESK_ROWS)
  const titleId = `${idPrefix}-look-title`
  const go = (row: LookRow) => {
    if (row.agent !== null && row.workflow !== null) { onOpen(row.session, row.workflow.run_id, row.agent); return }
    const id = row.workflow !== null ? `${idPrefix}-${idPart(row.session.key)}-${idPart(row.workflow.run_id)}-title` : `${idPrefix}-session-${idPart(row.session.key)}`
    const target = document.getElementById(id)
    target?.scrollIntoView({ block: 'start' })
    target?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true })
  }
  return (
    <section className="team-look" data-testid="team-needs-look" aria-labelledby={titleId}>
      <h3 id={titleId} className="team-look-title">Needs a look · {rows.length}</h3>
      <ul className="team-look-rows">
        {shown.map(row => (
          <li key={row.key}>
            <button type="button" className={`team-look-row${row.tone ? ` ${toneClass(row.tone)}` : ''}`} data-testid="team-look-row" data-kind={row.kind} data-team-select="" onClick={() => go(row)}>
              {row.tone ? <Glyph tone={row.tone} className="team-glyph" /> : <span className="team-look-dot" aria-hidden="true" />}
              <span className="team-look-text">{row.text}</span>
            </button>
          </li>
        ))}
      </ul>
      {!all && rows.length > DESK_ROWS && <button type="button" className="team-more" onClick={() => setAll(true)}>Show all {rows.length}</button>}
    </section>
  )
}
