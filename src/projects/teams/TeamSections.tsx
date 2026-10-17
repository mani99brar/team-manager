import { useMemo, useRef, useState } from 'react'
import type { TeamAgent, Teams, TeamSession } from '../../../contracts/projects/teams.ts'
import { describeApiError, type RunDetail, type RunInputs, type RunScope, type Sessions } from '../api.ts'
import { AppLink, LoadingPanel } from '../panels.tsx'
import { EMPTY_TEAM_QUERY, type TeamQuery } from '../routes.ts'
import { Glyph } from '../signal/Glyph.tsx'
import { toneClass, workflowTone } from '../tone.ts'
import type { Resource } from '../useResource.ts'
import { leadRunning, TeamContext, type TeamContextValue } from './context.ts'
import { DrawerHost } from './DrawerHost.tsx'
import { AttentionLine, LaneBody, LeadCommands, NoteButton } from './LanePanel.tsx'
import { agentPhase, attentionLine, laneWorkers, ownedPathsOf, phaseSegments, sessionSentence, sheetWorkflowLine, toolSummary, workflowName } from './model.ts'
import './teams.css'

type Shared = {
  scope: RunScope
  detail: RunDetail
  inputs: RunInputs | null
  sessions: Sessions | null
  clock: number
  live: boolean
  nodeHref: (nodeId: string) => string
  onNavigate: (pathname: string) => void
  /** The Team view's link with a selection. */
  teamHref: (query: Partial<TeamQuery>) => string
}

const SHEET_AGENTS = 3

/**
 * The step sheet's Team section (docs/PRD_RUN_TEAMS.md 5), before Events: the lane's attention line, one line per workflow
 * (name, pill, "{a} agents · {k} running · for 12m"), the latest workflow's phases as wrapping chips, up to three running agents
 * (label · phase · last tool), Open in Team view › and, when offered and paired, Send a note to the lead, then the Lead commands
 * disclosure (7: each lead's resume command with Copy and Show command). A records-`none`
 * worker shows the rule 9 or 10 sentence, an unreadable session its reason.
 */
export function SheetTeamSection({ teams, sessionsOfNode, shared }: { teams: Teams; sessionsOfNode: readonly TeamSession[]; shared: Shared }) {
  const workers = laneWorkers(shared.inputs)
  const context = { sessions: shared.sessions, detail: shared.detail }
  const line = attentionLine(sessionsOfNode, { owned: session => ownedPathsOf(session, workers), running: session => leadRunning(context, session), readAt: teams.read_at, clock: shared.clock })
  const workflows = sessionsOfNode.flatMap(session => session.workflows.map(workflow => ({ session, workflow })))
  const latest = workflows.at(-1)?.workflow ?? null
  const running = workflows.flatMap(({ workflow }) => workflow.agents.filter(agent => agent.state === 'running').map(agent => ({ agent, workflow }))).slice(0, SHEET_AGENTS)
  const first = sessionsOfNode[0]
  const found = sessionsOfNode.some(session => session.records === 'found')
  const lane = first?.lane ?? null
  return (
    <section className="sb-sheet-record team-sheet team-tones" data-testid="sheet-team-section" aria-labelledby="run-team-title">
      <h4 id="run-team-title">Team</h4>
      {found && line && <AttentionLine line={line} />}
      {!found && sessionsOfNode.map(session => <p key={session.key} className="team-session-empty" data-testid="team-session-empty">{sessionSentence(session, leadRunning(context, session))}</p>)}
      {workflows.length > 0 && (
        <ul className="team-sheet-workflows">
          {workflows.map(({ session, workflow }) => {
            const { tone, word } = workflowTone(workflow.status)
            return (
              <li key={`${session.key}|${workflow.run_id}`} data-workflow={workflow.run_id}>
                <b className={workflow.name === null ? 'team-mono' : undefined}>{workflowName(workflow)}</b>
                <span className={`team-pill ${toneClass(tone)}`}><Glyph tone={tone} className="team-glyph" />{word}</span>
                <span className="team-dim">{sheetWorkflowLine(workflow, shared.clock)}</span>
              </li>
            )
          })}
        </ul>
      )}
      {latest !== null && latest.phases.length > 0 && (
        <ul className="team-sheet-phases" aria-label={`Phases of ${workflowName(latest)}`}>
          {phaseSegments(latest.phases).map(segment => (
            <li key={segment.index} className={toneClass(segment.tone)}><Glyph tone={segment.tone} className="team-glyph" />{segment.title} · {segment.counts}</li>
          ))}
        </ul>
      )}
      {running.length > 0 && (
        <ul className="team-sheet-agents">
          {running.map(({ agent, workflow }) => <li key={`${workflow.run_id}|${agent.index}`}><span className="team-agent-label">{agent.label}</span> · {agentPhase(agent, workflow.phases) ?? 'no phase recorded'} · {toolSummary(agent) ?? 'no tool recorded'}</li>)}
        </ul>
      )}
      <div className="team-sheet-links">
        {first && <AppLink href={shared.teamHref({ session: first.key })} onNavigate={shared.onNavigate} className="team-link" data-testid="sheet-team-link">Open in Team view ›</AppLink>}
        {lane !== null && first?.role === 'worker' && <NoteButton scope={shared.scope} lane={lane} />}
      </div>
      <LeadCommands sessions={sessionsOfNode} rows={shared.sessions} />
    </section>
  )
}

/**
 * The node page's Team section body (docs/PRD_RUN_TEAMS.md 6): the lane panel body scoped to this node's sessions (the attention
 * line, the workflow cards, the phase strips, the roster with its filters and folding) and the Lead commands; the agent drawer
 * opens as on the Team view, its selection local to the page, and its Open in Team view › carries the selection to `/team`.
 * The teams are the run page's resource; this section fetches nothing.
 */
export function NodeTeamSection({ teams, onRetry, nodeId, shared }: { teams: Resource<Teams | null>; onRetry: () => void; nodeId: string; shared: Shared }) {
  const [query, setQuery] = useState<TeamQuery>(EMPTY_TEAM_QUERY)
  const opener = useRef<Element | null>(null)
  const workers = useMemo(() => laneWorkers(shared.inputs), [shared.inputs])
  if (teams.status === 'idle' || teams.status === 'loading') return <LoadingPanel>Reading team records…</LoadingPanel>
  if (teams.status === 'error') {
    return (
      <div className="projects-error team-error" role="alert" data-testid="team-not-loaded">
        <p>Team records were not loaded: {describeApiError(teams.error).replace(/\.$/, '')}.</p>
        <div className="projects-actions"><button type="button" className="button" onClick={onRetry}>Read again</button></div>
      </div>
    )
  }
  const data = teams.data
  if (data === null) return null
  const sessions = data.sessions.filter(session => session.node_id === nodeId)
  const context: TeamContextValue = {
    scope: shared.scope, detail: shared.detail, teams: data, workers, sessions: shared.sessions, clock: shared.clock, live: shared.live,
    query, onQuery: next => setQuery(next), nodeHref: shared.nodeHref, onNavigate: shared.onNavigate, teamViewHref: shared.teamHref, idPrefix: `node-${nodeId}`,
  }
  const open = (session: TeamSession, workflow: string, agent: TeamAgent) => {
    opener.current = document.activeElement
    setQuery(previous => ({ ...previous, session: session.key, workflow, agent: agent.index }))
  }
  return (
    <TeamContext.Provider value={context}>
      <div className="team-node team-tones" data-testid="team-node-body">
        <LaneBody sessions={sessions} attention onOpen={open} />
        <div className="team-sheet-links">
          {sessions[0]?.role === 'worker' && sessions[0].lane !== null && <NoteButton scope={shared.scope} lane={sessions[0].lane} />}
          <LeadCommands sessions={sessions} rows={shared.sessions} />
        </div>
        {sessions[0] && <AppLink href={shared.teamHref({ session: sessions[0].key })} onNavigate={shared.onNavigate} className="team-link" data-testid="node-team-link">Open in Team view ›</AppLink>}
        <DrawerHost opener={opener} />
      </div>
    </TeamContext.Provider>
  )
}
