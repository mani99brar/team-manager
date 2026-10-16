import type { Now } from '../../../contracts/projects/triage.ts'
import type { ReviewResult, RunDetail, RunInputs, RunScope, Sessions, Teams } from '../api.ts'
import type { TeamQuery, TeamQueryMode } from '../routes.ts'
import type { Zone } from '../time.ts'
import type { Resource, ResourceMeta } from '../useResource.ts'

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

/**
 * The Team view (docs/PRD_RUN_TEAMS.md 3), a sibling view of the run like Assignment. SCAFFOLD: the Team view lane replaces
 * this body; `RunView` already renders the identity line, the switcher and the visually hidden `h2#run-view-title` above it.
 */
export function TeamView(props: TeamViewProps) {
  void props
  return (
    <section className="team-view" data-testid="team-view" aria-labelledby="team-view-heading">
      <h3 id="team-view-heading">Team view</h3>
    </section>
  )
}
