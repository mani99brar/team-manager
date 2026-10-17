import { useState } from 'react'
import type { TeamAgent, TeamSession, TeamWorkflow } from '../../../contracts/projects/teams.ts'
import { Glyph } from '../signal/Glyph.tsx'
import { Time } from '../Time.tsx'
import { toneClass } from '../tone.ts'
import { formatSpan } from '../time.ts'
import { useTeam } from './context.ts'
import {
  agentKey, agentMatches, agentName, agentPhase, agentRanText, agentState, BAR_WIDTH, durationFraction, FILTERS_FROM, filesCount, filterActive, idPart, longestDuration,
  moreAgentsLine, moreStep, outsideFiles, quietMinutes, roleChoices, ROW_LIMIT, rosterGroups, scopeLine, stateChoices, toolSummary, workflowName, type RosterFilter, type RosterGroup,
} from './model.ts'

const NR = <span className="team-nr">not recorded</span>

type Props = {
  session: TeamSession
  workflow: TeamWorkflow
  owned: readonly string[] | null
  filter: RosterFilter
  onFilter: (change: Partial<RosterFilter>) => void
  onOpen: (agent: TeamAgent) => void
  phone: boolean
}

/**
 * A workflow's roster (docs/PRD_RUN_TEAMS.md 3.5): agents grouped by phase in index order ("No phase recorded" last), rows in
 * `index` order so nothing moves under the pointer when the page polls. A group starts open when it holds a running, failed or
 * interrupted agent or six agents or fewer, else it folds to its header ("Show {n}"); an open group renders 20 rows, then "Show
 * {m} more". A filter or search opens every group with a match and shows only the matches. The filters (state, outside lane
 * paths, phase, search) appear past 12 agents, or while one narrows the roster. A desk reads a `<table>` (one button per row
 * in its label cell); a phone a list of cards, each a button, with the same accessible names.
 */
export function Roster({ session, workflow, owned, filter, onFilter, onOpen, phone }: Props) {
  const { clock, frozenAt, teams, idPrefix, query } = useTeam()
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  // How many rows each open group shows: 20, then 20 more per "Show {m} more", or every row after "Show all {n}".
  const [shownCount, setShownCount] = useState<Record<string, number>>({})
  // The row whose drawer is open is marked, so the walk with Previous and Next stays visible in the roster.
  const selected = query.agent !== null && query.session === session.key && query.workflow === workflow.run_id ? query.agent : null
  const active = filterActive(filter)
  const matching = active ? workflow.agents.filter(agent => agentMatches(agent, filter, owned)) : workflow.agents
  const groups = rosterGroups(workflow, matching)
  const outsideCount = owned === null ? 0 : workflow.agents.filter(agent => outsideFiles(agent, owned).length > 0).length
  const showFilters = workflow.agents.length > FILTERS_FROM || active
  const base = `${idPrefix}-${idPart(session.key)}-${idPart(workflow.run_id)}`
  const groupKey = (group: RosterGroup) => String(group.index ?? 'none')
  const isOpen = (group: RosterGroup) => active || (toggled[groupKey(group)] ?? group.startsOpen)
  const limitOf = (group: RosterGroup) => shownCount[groupKey(group)] ?? ROW_LIMIT
  const shownRows = (group: RosterGroup) => group.agents.slice(0, limitOf(group))
  const name = workflowName(workflow)
  const roles = roleChoices(workflow.agents)
  // The Ran cell's inline bar (P2 item 14): duration over the workflow's longest, in the state's tone; absent when not recorded.
  const longest = longestDuration(workflow.agents)
  const bar = (agent: TeamAgent, tone: string) => {
    const fraction = durationFraction(agent, longest)
    if (fraction === null) return null
    return (
      <span className={`team-bar ${tone}`} data-testid="team-duration-bar" data-fraction={fraction.toFixed(3)} aria-hidden="true">
        <span className="team-bar-fill" style={{ width: `${Math.round(fraction * BAR_WIDTH)}px` }} />
      </span>
    )
  }

  const row = (agent: TeamAgent) => {
    const outside = outsideFiles(agent, owned).length
    const quiet = quietMinutes(agent, teams.read_at)
    const { tone, word } = agentState(agent.state)
    const ran = agentRanText(agent, clock, frozenAt)
    const isSelected = selected === agent.index
    const label = agentName(agent, workflow.phases, clock, outside, teams.read_at)
    const key = agentKey(session.key, workflow.run_id, agent.index)
    const tool = toolSummary(agent)
    const files = filesCount(agent)
    if (phone) {
      return (
        <li key={agent.index}>
          <button type="button" className={`team-card ${toneClass(tone)}`} data-selected={isSelected ? 'true' : undefined} data-testid="team-agent-row" data-index={agent.index} data-state={agent.state} data-agent-key={key} data-team-select="" aria-label={label} onClick={() => onOpen(agent)}>
            <span className="team-card-line">
              <Glyph tone={tone} className={`team-glyph${agent.state === 'running' ? ' breathe' : ''}`} />
              <span className="team-agent-label">{agent.label}</span> <span className="team-index">#{agent.index}</span>
              <span className="team-word">{word}</span>
              {ran && <span className="team-num">{ran}</span>}
              {bar(agent, toneClass(tone))}
              {quiet !== null && <span className="team-quiet" data-testid="team-quiet">quiet {quiet}m</span>}
            </span>
            <span className="team-card-line team-dim">
              {[agentPhase(agent, workflow.phases) ?? 'no phase', agent.model ?? 'model not recorded', agent.tool_calls === null ? 'tools not recorded' : `${agent.tool_calls} tools`, `${files} files`].join(' · ')}
            </span>
            {tool && <span className="team-card-line team-clamp team-mono-line">{tool}</span>}
            {outside > 0 && <span className="team-outside-chip" data-testid="team-outside-chip"><Glyph tone="fail" className="team-glyph" />{outside} outside</span>}
          </button>
        </li>
      )
    }
    return (
      <tr key={agent.index} className={`team-row ${toneClass(tone)}`} data-selected={isSelected ? 'true' : undefined} data-testid="team-agent-row" data-index={agent.index} data-state={agent.state} onClick={event => { if (!(event.target instanceof Element && event.target.closest('button'))) onOpen(agent) }}>
        <td className="team-cell-state"><span className="team-state"><Glyph tone={tone} className={`team-glyph${agent.state === 'running' ? ' breathe' : ''}`} />{word}</span>{agent.cached && <span className="team-chip">replayed</span>}</td>
        <td className="team-cell-agent">
          <button type="button" className="team-agent-button" data-agent-key={key} data-team-select="" aria-label={label} onClick={() => onOpen(agent)}>
            <span className="team-agent-label">{agent.label}</span> <span className="team-index">#{agent.index}</span>
          </button>
          {agent.providers.map(provider => <span key={provider} className="team-chip team-provider">via {provider.split('/').pop()}</span>)}
        </td>
        <td>{agent.model ?? NR}</td>
        <td className="team-num">{agent.started_at ? <Time iso={agent.started_at} /> : NR}</td>
        <td className="team-num team-cell-ran">{ran ?? NR}{bar(agent, toneClass(tone))}{quiet !== null && <span className="team-quiet" data-testid="team-quiet"> quiet {quiet}m</span>}</td>
        <td className="team-num">{agent.tool_calls ?? NR}</td>
        <td className="team-cell-tool">{tool ? <span className="team-mono-line">{tool}</span> : NR}</td>
        <td className="team-num">{files}{outside > 0 && <span className="team-outside-chip" data-testid="team-outside-chip"><Glyph tone="fail" className="team-glyph" />{outside} outside</span>}</td>
      </tr>
    )
  }

  const header = (group: RosterGroup, rowsId: string) => {
    const open = isOpen(group)
    return (
      <button type="button" className="team-group-head" aria-expanded={open} aria-controls={rowsId} data-team-select="" disabled={active} onClick={() => setToggled(previous => ({ ...previous, [groupKey(group)]: !open }))}>
        <span className="team-group-title">{group.title}</span>
        <span className="team-dim">{group.counts}</span>
        {group.spanMs !== null && <span className="team-dim team-num">{formatSpan(group.spanMs)}</span>}
        {!open && <span className="team-show">Show {group.agents.length}</span>}
        <svg className={`team-chev${open ? ' open' : ''}`} viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
    )
  }
  const moreButton = (group: RosterGroup) => {
    const shown = Math.min(limitOf(group), group.agents.length)
    if (!isOpen(group) || shown >= group.agents.length) return null
    const key = groupKey(group)
    const step = moreStep(shown, group.agents.length)
    return (
      <span className="team-more-buttons">
        <button type="button" className="team-more" onClick={() => setShownCount(previous => ({ ...previous, [key]: shown + step }))}>Show {step} more</button>
        {group.agents.length - shown > step && <button type="button" className="team-more" onClick={() => setShownCount(previous => ({ ...previous, [key]: group.agents.length }))}>Show all {group.agents.length}</button>}
      </span>
    )
  }

  return (
    <div className="team-roster-wrap">
      {showFilters && (
        <div className="team-filters" data-testid="team-filters">
          <div className="team-radios" role="radiogroup" aria-label={`Agents of ${name} by state`}>
            {stateChoices(workflow.agents).map(choice => (
              <button key={choice.label} type="button" role="radio" aria-checked={filter.state === choice.state} className="team-radio" data-state={choice.state ?? 'all'} onClick={() => onFilter({ state: choice.state })}>
                {choice.label} {choice.count}
              </button>
            ))}
          </div>
          {outsideCount > 0 && (
            <button type="button" className="team-radio" aria-pressed={filter.outside} data-testid="team-outside-filter" onClick={() => onFilter({ outside: !filter.outside })}>Outside lane paths {outsideCount}</button>
          )}
          {workflow.phases.length > 0 && (
            <select className="team-select" aria-label="Phase" value={filter.phase ?? ''} onChange={event => onFilter({ phase: event.target.value === '' ? null : Number(event.target.value) })}>
              <option value="">Every phase</option>
              {[...workflow.phases].sort((a, b) => a.index - b.index).map(phase => <option key={phase.index} value={phase.index}>{phase.index} · {phase.title}</option>)}
            </select>
          )}
          <input className="team-search" type="search" aria-label="Find an agent" placeholder="Find an agent" value={filter.q} onChange={event => onFilter({ q: event.target.value })} />
        </div>
      )}
      {roles.length > 0 && (
        <div className="team-roles" role="group" aria-label={`Agents of ${name} by role`} data-testid="team-role-filter">
          {roles.map(choice => (
            <button key={choice.role} type="button" className="team-radio" aria-pressed={filter.role === choice.role} data-role={choice.role} data-team-select="" onClick={() => onFilter({ role: filter.role === choice.role ? null : choice.role })}>
              {choice.role} {choice.count}
            </button>
          ))}
        </div>
      )}
      {active && <p className="team-scope" data-testid="team-scope" role="status">{scopeLine(matching.length, workflow.agents.length, workflow.agents_more > 0 ? workflow.agent_count : workflow.agents.length)}</p>}
      {groups.length === 0 && <p className="team-nr-p">{workflow.agents.length === 0 ? 'No agent is listed yet.' : 'No agent matches.'}</p>}
      {groups.length > 0 && (phone ? (
        <div className="team-cards-wrap">
          {groups.map(group => {
            const rowsId = `${base}-g${groupKey(group)}`
            return (
              <div key={groupKey(group)} className="team-phase-group" data-testid="team-phase-group" data-index={group.index ?? 'none'}>
                {header(group, rowsId)}
                <ul id={rowsId} className="team-cards" aria-label={group.title}>{isOpen(group) && shownRows(group).map(row)}</ul>
                {moreButton(group)}
              </div>
            )
          })}
        </div>
      ) : (
        <div className="team-table-scroll">
          <table className="team-roster">
            <caption className="team-sr">Agents of {name}</caption>
            <thead>
              <tr>{['State', 'Agent', 'Model', 'Started', 'Ran', 'Tools', 'Last tool', 'Files'].map(title => <th key={title} scope="col">{title}</th>)}</tr>
            </thead>
            {groups.map(group => {
              const rowsId = `${base}-g${groupKey(group)}`
              const extra = moreButton(group)
              return (
                <tbody key={groupKey(group)} id={rowsId} className="team-phase-group" data-testid="team-phase-group" data-index={group.index ?? 'none'}>
                  <tr className="team-group-row"><th colSpan={8} scope="rowgroup">{header(group, rowsId)}</th></tr>
                  {isOpen(group) && shownRows(group).map(row)}
                  {extra && <tr className="team-more-row"><td colSpan={8}>{extra}</td></tr>}
                </tbody>
              )
            })}
          </table>
        </div>
      ))}
      {workflow.agents_more > 0 && <p className="team-nr-p" data-testid="team-agents-more">{moreAgentsLine(workflow.agents_more)}</p>}
    </div>
  )
}
