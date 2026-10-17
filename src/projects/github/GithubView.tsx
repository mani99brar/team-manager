import type { Now } from '../../../contracts/projects/triage.ts'
import type { ReviewResult, RunDetail, RunGithub, RunInputs, RunScope, Sessions, Teams } from '../api.ts'
import type { Zone } from '../time.ts'
import type { Resource, ResourceMeta } from '../useResource.ts'

/**
 * What the GitHub view reads (docs/PRD_RUN_TEAMS.md 4 "GitHub view"); every run-level resource is created in `RunView` and
 * passed down, and the one clock ticks there. The actions panel reads the run-control pairing itself through the controls
 * store (`useRunControls(scope)`, `controls/store.ts`) and `fetchGithubActions`/`postGithubAction` (`api.ts`), so an
 * unconfigured page asks nothing beyond the status probe.
 */
export type GithubViewProps = {
  scope: RunScope
  detail: RunDetail
  inputs: Resource<RunInputs | null>
  /** The run's sessions payload, for the run summary; null while not loaded or not recorded. */
  sessions: Sessions | null
  /** The teams read, for the run summary; null when not loaded or not served. */
  teams: Teams | null
  /** The run's GitHub read: `ready` with null when the server does not serve it (404 `NOT_RECORDED.runGithub`). */
  runGithub: Resource<RunGithub | null>
  runGithubMeta: ResourceMeta
  /** Reads the GitHub facts again now (after an action record ends). */
  onRetryRunGithub: () => void
  review: ReviewResult | null
  now: Now | null
  clock: number
  zone: Zone
  live: boolean
  nodeHref: (nodeId: string) => string
  onNavigate: (pathname: string) => void
  onAnnounce: (message: string) => void
}

/**
 * The GitHub view (docs/PRD_RUN_TEAMS.md 4). SCAFFOLD: the GitHub view lane replaces this body; `RunView` already renders the
 * identity line, the switcher and the visually hidden `h2#run-view-title` above it.
 */
export function GithubView(props: GithubViewProps) {
  void props
  return (
    <section className="gh-view" data-testid="gh-view" aria-labelledby="gh-view-heading">
      <h3 id="gh-view-heading">GitHub view</h3>
    </section>
  )
}
