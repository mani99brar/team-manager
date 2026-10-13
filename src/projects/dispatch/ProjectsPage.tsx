/**
 * The Projects page, `/projects` (docs/PRD_PROJECTS_DISPATCH.md 4.1, [O3]): one card per registered project, in rail order,
 * each a single link to the project's page. A card shows the state word, a GitHub project's repository and visibility, the
 * checkout with the sync wording (the same as the header's), the non-zero run counts and the latest run, and open PRs and
 * issues when GitHub was read, else "GitHub not read: <reason>".
 */
import type { Project } from '../api.ts'
import { projectPathname } from '../routes.ts'
import { AppLink } from '../panels.tsx'
import { OVERRIDE_LABEL, STATUS_LABEL } from '../status.ts'
import { stateTone, toneClass } from '../tone.ts'
import { Time } from '../Time.tsx'
import { cardStateWord, syncPhrase } from './derive.ts'
import { StateGlyph, VisibilityChip } from './common.tsx'
import type { ProjectRunInfo } from './projectModel.ts'
import type { DispatchOverview, ProjectDispatch } from './types.ts'

export type CardData = { project: Project; dispatch: ProjectDispatch | null; info: ProjectRunInfo; primaryName: string | null }

const plural = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`

function countsText(info: ProjectRunInfo): string {
  const parts = (['succeeded', 'failed', 'cancelled'] as const).filter(key => info.counts[key] > 0).map(key => `${info.counts[key]} ${key}`)
  return parts.length ? `: ${parts.join(', ')}` : ''
}

function Card({ data, onNavigate }: { data: CardData; onNavigate: (pathname: string) => void }) {
  const { project, dispatch, info } = data
  const git = dispatch?.git ?? null
  const github = dispatch?.github ?? null
  const read = github?.status === 'read'
  const loading = info.state === 'loading'
  const word = cardStateWord({ tone: info.tone, waits: info.waits, running: info.running, paused: info.paused, allBad: info.allBad, loading, featureCount: info.readableFeatures, worstLatestCount: info.worstLatestCount })
  const latest = info.latestRun
  const latestTone = latest ? stateTone({ status: latest.status, accepted: latest.accepted }) : 'idle'
  const checkout = git?.checkout ?? null
  return (
    <li>
      <AppLink href={projectPathname(project.project_id)} onNavigate={onNavigate} className={`dispatch-card ui-card ${toneClass(loading ? 'idle' : info.tone)}`} data-project-id={project.project_id}>
        <span className="dispatch-card-top">
          <StateGlyph tone={loading ? 'idle' : info.tone} live={!loading && info.tone === 'run'} />
          <span className="dispatch-card-name">{project.name}</span>
          <span className="dispatch-card-word">{word}</span>
        </span>
        {github && github.repo && (
          <span className="dispatch-card-repo">
            <span className="dispatch-mono">{github.repo}</span>
            {read && <VisibilityChip visibility={github.visibility} />}
          </span>
        )}
        {git && (
          <span className="dispatch-card-line">
            {checkout ? <>on <code>{checkout}</code> · </> : null}{syncPhrase(git, project.project_id, data.primaryName)}
          </span>
        )}
        <span className="dispatch-card-line">
          {loading
            ? 'reading runs…'
            : info.allBad
              ? 'its run state cannot be read by this viewer'
              : <>{plural(info.features, 'feature')} · {plural(info.runCount, 'run')}{countsText(info)}{info.badFeatures > 0 ? ` · ${info.badFeatures} cannot be read` : ''}</>}
        </span>
        {!loading && (info.waits > 0 || info.paused > 0 || info.running > 0) && (
          // What needs the operator and what is live, each counted once: a run that needs the operator is a wait, never running.
          <span className="dispatch-card-line dispatch-card-live" data-testid="dispatch-card-live">
            {[info.waits > 0 ? `${info.waits} waits on you` : '', info.running > 0 ? `${info.running} running` : '', info.paused > 0 ? `${info.paused} paused` : ''].filter(Boolean).join(' · ')}
          </span>
        )}
        {latest && (
          <span className={`dispatch-card-line ${toneClass(latestTone)}`}>
            latest <code>{latest.run_id}</code> <span className="dispatch-word">{latest.accepted ? OVERRIDE_LABEL : STATUS_LABEL[latest.status]}</span>
            {' · '}<Time iso={latest.activity?.last_activity_at ?? latest.updated_at} />
          </span>
        )}
        <span className="dispatch-card-foot">
          {read
            ? <><span>{plural(github.open_prs ?? 0, 'open PR')}</span><span>{plural(github.open_issues ?? 0, 'open issue')}</span></>
            : <span className="dispatch-muted">GitHub not read: {github?.reason ?? 'not read yet'}</span>}
          <span className="dispatch-card-open" aria-hidden="true">Open ›</span>
        </span>
      </AppLink>
    </li>
  )
}

type Props = {
  cards: readonly CardData[]
  overview: DispatchOverview | null
  /** How many repositories the projects live in, null until the dispatch overview is read, 'failed' when that read failed. */
  repositoryCount: number | null | 'failed'
  /** When the run lists were read (`homeMeta.settledAt`), not a ticking clock; null until they are read (V15). */
  runsReadAt: number | null
  /** The reason the run read failed, when it did; null otherwise (V15). */
  runsError: string | null
  onNavigate: (pathname: string) => void
}

export function ProjectsPage({ cards, overview, repositoryCount, runsReadAt, runsError, onNavigate }: Props) {
  const githubReads = (overview?.projects ?? []).map(p => p.github).filter(g => g.status === 'read' && g.read_at !== null)
  const oldestGithub = githubReads.length ? githubReads.reduce((oldest, g) => (Date.parse(g.read_at!) < Date.parse(oldest) ? g.read_at! : oldest), githubReads[0].read_at!) : null
  return (
    <section className="dispatch-projects" aria-labelledby="dispatch-projects-title" data-testid="dispatch-projects">
      <header className="dispatch-page-head">
        <h1 id="dispatch-projects-title">Projects</h1>
        <p className="dispatch-meta" data-testid="dispatch-projects-meta">
          {repositoryCount === null
            ? <>{plural(cards.length, 'project')} · repositories: reading…</>
            : repositoryCount === 'failed'
            ? <>{plural(cards.length, 'project')} · repositories not read</>
            : <>{plural(cards.length, 'project')} in {plural(repositoryCount, 'repository').replace('repositorys', 'repositories')}</>}
          {' · '}<span data-testid="dispatch-runs-read">{runsReadAt !== null ? <>runs read <Time iso={new Date(runsReadAt).toISOString()} /></> : runsError ? `runs not read: ${runsError}` : 'reading runs…'}</span>
          {' · '}{oldestGithub ? <>GitHub read <Time iso={oldestGithub} /></> : 'GitHub not read'}
        </p>
        <p className="dispatch-muted">Each card opens the project's own page: runs by feature on the step chart, local against origin, pull requests and issues. Ordered as the rail is.</p>
      </header>
      <ul className="dispatch-cards" data-testid="dispatch-cards">
        {cards.map(data => <Card key={data.project.project_id} data={data} onNavigate={onNavigate} />)}
      </ul>
    </section>
  )
}
