import { useEffect, useMemo, useRef } from 'react'
import type { Now } from '../../../contracts/projects/triage.ts'
import type { TeamAgent, TeamSession } from '../../../contracts/projects/teams.ts'
import { describeApiError, type ReviewResult, type RunDetail, type RunInputs, type RunScope, type Sessions, type Teams } from '../api.ts'
import { LoadingPanel } from '../panels.tsx'
import type { TeamQuery, TeamQueryMode } from '../routes.ts'
import { formatAgo, type Zone } from '../time.ts'
import type { Resource, ResourceMeta } from '../useResource.ts'
import { TeamContext, type TeamContextValue } from './context.ts'
import { DrawerHost } from './DrawerHost.tsx'
import { LaneBody, LanePanel } from './LanePanel.tsx'
import { CONTEXT_NOTE, headSentence, idPart, laneGroups, laneWorkers, otherSessionsLine, otherSessionsPanel, teamChanges } from './model.ts'
import { WorkingNow } from './WorkingNow.tsx'
import './teams.css'

/**
 * What the Team view reads (docs/PRD_RUN_TEAMS.md 3 "Team view"); every run-level resource is created in `RunView` and
 * passed down, and the one clock ticks there (`now`/`clock`), never here.
 */
export type TeamViewProps = {
  scope: RunScope
  detail: RunDetail
  /** The run inputs: `workers[]` orders the lane panels and gives each lane its owned paths. */
  inputs: Resource<RunInputs | null>
  /** The run's sessions payload (lead session ids, resume commands), null while not loaded or not recorded. */
  sessions: Sessions | null
  /** The teams read: `ready` with null when the server does not serve teams (404 `NOT_RECORDED.teams`). */
  teams: Resource<Teams | null>
  /** How fresh the teams read is ("read 8 s ago", "Last read failed; showing the read from …"). */
  teamsMeta: ResourceMeta
  onRetryTeams: () => void
  /** The recorded review, when it loaded. */
  review: ReviewResult | null
  /** The run's Now situation, when it settled. */
  now: Now | null
  /** The page's one clock (epoch ms), ticking while the run can still change. */
  clock: number
  zone: Zone
  /** Whether the run can still change (not succeeded or cancelled). */
  live: boolean
  /** The selection from the URL's search (session, workflow, agent, state, phase, q). */
  query: TeamQuery
  /** Changes the selection: `push` for opening an agent (Back closes the drawer), `replace` for filters and search. */
  onQuery: (query: TeamQuery, mode: TeamQueryMode) => void
  nodeHref: (nodeId: string) => string
  onNavigate: (pathname: string) => void
  /** The page's single polite announcer (docs/PRD_RUN_TEAMS.md 10). */
  onAnnounce: (message: string) => void
}

/** The announcer speaks at most every 10 s, coalescing what remains (docs/PRD_RUN_TEAMS.md 10). */
const ANNOUNCE_GAP_MS = 10_000

/**
 * The Team view (docs/PRD_RUN_TEAMS.md 3), a sibling view of the run like Assignment, one column of list-page panels: the head
 * sentence and the context note, Working now, one lane panel per `inputs.workers[]` entry in definition order, then the other
 * sessions (a panel when one has records, else one line), and the agent drawer of the selection. `RunView` renders the identity
 * line, the switcher and the visually hidden `h2#run-view-title` above it. The view states of 3.9: loading, not loaded (with
 * Read again; a failed poll keeps the last read and says so), not served, and no sessions yet.
 */
export function TeamView({ scope, detail, inputs, sessions, teams, teamsMeta, onRetryTeams, clock, live, query, onQuery, nodeHref, onNavigate, onAnnounce }: TeamViewProps) {
  const data = teams.status === 'ready' ? teams.data : null
  const workers = useMemo(() => laneWorkers(inputs.status === 'ready' ? inputs.data : null), [inputs])
  const opener = useRef<Element | null>(null)

  // The polite announcer: a workflow's status change, then a newly failed agent; nothing on the first read, at most every 10 s.
  const previous = useRef<Teams | null>(null)
  const pending = useRef<string[]>([])
  const spokenAt = useRef(0)
  useEffect(() => {
    if (data === null) return
    pending.current.push(...teamChanges(previous.current, data))
    previous.current = data
    if (pending.current.length === 0 || Date.now() - spokenAt.current < ANNOUNCE_GAP_MS) return
    spokenAt.current = Date.now()
    onAnnounce(pending.current.join('. '))
    pending.current = []
  }, [data, onAnnounce])

  // A link that names a session ("Open in Team view ›") scrolls its block into view once the records are there.
  const scrolledTo = useRef<string | null>(null)
  useEffect(() => {
    if (data === null || query.session === null || query.agent !== null || scrolledTo.current === query.session) return
    scrolledTo.current = query.session
    document.getElementById(`team-session-${idPart(query.session)}`)?.scrollIntoView({ block: 'start' })
  }, [data, query.session, query.agent])

  if (teams.status === 'idle' || teams.status === 'loading') return <section className="team-view team-tones" data-testid="team-view" data-state="loading" aria-label="Team"><LoadingPanel>Reading team records…</LoadingPanel></section>
  if (teams.status === 'error') {
    return (
      <section className="team-view team-tones" data-testid="team-view" data-state="not-loaded" aria-label="Team">
        <div className="projects-error team-error" role="alert" data-testid="team-not-loaded">
          <p>Team records were not loaded: {describeApiError(teams.error).replace(/\.$/, '')}.</p>
          <div className="projects-actions"><button type="button" className="button" onClick={onRetryTeams}>Read again</button></div>
        </div>
      </section>
    )
  }
  if (data === null) {
    return (
      <section className="team-view team-tones" data-testid="team-view" data-state="not-served" aria-label="Team">
        <p className="team-empty" data-testid="team-not-served">This server does not serve team records; update md-manager to see teams.</p>
      </section>
    )
  }
  if (data.sessions.length === 0) {
    return (
      <section className="team-view team-tones" data-testid="team-view" data-state="no-sessions" aria-label="Team">
        <p className="team-empty" data-testid="team-no-sessions">No Claude session of this run has started yet.</p>
      </section>
    )
  }

  const context: TeamContextValue = { scope, detail, teams: data, workers, sessions, clock, live, query, onQuery, nodeHref, onNavigate, idPrefix: 'team' }
  const { lanes, other } = laneGroups(data, workers)
  const open = (session: TeamSession, workflow: string, agent: TeamAgent) => {
    opener.current = document.activeElement
    onQuery({ ...query, session: session.key, workflow, agent: agent.index }, 'push')
  }
  const failedPoll = teamsMeta.failures > 0 && teamsMeta.settledAt !== null
  return (
    <TeamContext.Provider value={context}>
      <section className="team-view team-tones" data-testid="team-view" data-state="ready" aria-label="Team">
        <div className="team-head" data-testid="team-head">
          <p className="team-head-line">{headSentence(data, lanes, clock)}</p>
          {failedPoll && <p className="team-caption" data-testid="team-read-failed">Last read failed; showing the read from {formatAgo(teamsMeta.settledAt!, clock)}.</p>}
          {data.totals.sessions_with_teams > 0 && <p className="team-caption">{CONTEXT_NOTE}</p>}
        </div>
        <WorkingNow onOpen={open} />
        {lanes.map(group => <LanePanel key={group.lane} group={group} onOpen={open} />)}
        {other.length > 0 && (otherSessionsPanel(other) ? (
          <section className="team-lane team-other" data-testid="team-lane" data-lane="other" aria-labelledby="team-other-title">
            <div className="team-lane-head"><h3 id="team-other-title" className="team-lane-title">Other sessions</h3></div>
            <LaneBody sessions={other} attention={false} onOpen={open} />
          </section>
        ) : <p className="team-caption" data-testid="team-other-line">{otherSessionsLine(other.length)}</p>)}
        <DrawerHost opener={opener} />
      </section>
    </TeamContext.Provider>
  )
}
