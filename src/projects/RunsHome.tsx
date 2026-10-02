import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import type { ControllerReading } from '../../contracts/projects/triage.ts'
import { describeApiError, type Project, type ProjectRuns, type RunSummary, type WorkflowDefinition, type WorkflowRuns } from './api.ts'
import {
  cardElapsed, controllerSuffix, filterRecent, firstRows, groupByDay, groupByProject, homeSections, laneNamesOf, latestFeature, latestRun, movedAt, NEXT_STEP,
  projectFacts, projectTone, railEntries, RECENT_SHOWN, recentCounts, recordHomeReadings, rowSummary, rowTime, searchRows, waitingKind, workflowTitle,
  type ListRow, type RecentFilter, type WaitingKind,
} from './lists.ts'
import { LiveStatus } from './LiveStatus.tsx'
import { AppLink, LoadingPanel, StatusBadge } from './panels.tsx'
import { projectPathname, runPathname, workflowPathname } from './routes.ts'
import { RunRow } from './RunRow.tsx'
import { shortRevision } from './status.ts'
import { Time } from './Time.tsx'
import { formatAgo } from './time.ts'
import { stateTone, statusTone, TONE_LABEL, toneClass, type Tone } from './tone.ts'
import { Chip, FilterButton, FilterRow, Section } from './ui/index.tsx'
import { useTimeZone } from './useNow.ts'
import type { Resource, ResourceMeta } from './useResource.ts'
import './lists.css'

/** One row of a list that mixes workflows: the run with what names it. */
type Row = ListRow & { key: string; project: Project; workflow: WorkflowDefinition; labels: ReadonlyMap<string, string> }

const labelsOf = (workflow: WorkflowDefinition) => new Map(workflow.nodes.map(node => [node.node_id, node.label]))

function rowsOf(project: Project, entries: readonly WorkflowRuns[]): Row[] {
  return entries.flatMap(({ workflow, runs }) => {
    const title = workflowTitle(workflow, latestFeature(runs))
    const labels = labelsOf(workflow)
    return runs.map(run => ({ key: `${project.project_id}/${workflow.workflow_id}/${run.run_id}`, run, project, workflow, title, labels }))
  })
}

/** The context a mixed list names beside the run id: the workflow's title, the run's feature when it is not the title, and the project. */
const contextOf = (row: Row, project = true) => {
  const feature = row.run.activity?.feature ?? null
  return [row.title, feature !== row.title ? feature : null, project ? row.project.name : null]
}
const namesOf = (row: Row) => contextOf(row).filter((name): name is string => Boolean(name)).join(' · ')
const hrefOf = (row: Row) => runPathname(row.project.project_id, row.workflow.workflow_id, row.run.run_id)

/** What a Needs-you card's chip says waits, in words beside its colour. */
const WAITING_LABEL: Record<WaitingKind, string> = { question: 'question waits', pane: 'pane needs you', approval: 'approval waits' }
/** The rail groups the reader left open, remembered across visits. */
const RAIL_OPEN_KEY = 'mdm-rail-open'
const TONE_ORDER: readonly Tone[] = ['warn', 'fail', 'run', 'ok', 'pause', 'idle']

function readOpenGroups(): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(RAIL_OPEN_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

/**
 * A run that waits on the operator (docs/PRD_VIEWER_REVAMP.md 5.1): a warn card whose link is its direct child, named by the
 * run id first, then what waits, the feature and project, the served headline, the next step as a label and since when. The
 * exact command needs the run detail, so it stays on the run page.
 */
function NeedsCard({ row, kind, now, onNavigate }: { row: Row; kind: WaitingKind; now: number; onNavigate: (pathname: string) => void }) {
  const { run } = row
  const since = run.activity?.attention?.since ?? null
  const headline = run.activity?.headline ?? null
  return (
    <li className={`ui-card ${toneClass('warn')} home-card`}>
      <AppLink href={hrefOf(row)} onNavigate={onNavigate} className="home-card-link" data-run-id={run.run_id} data-status={run.status} data-attention={kind}>
        <span className="home-card-head">
          <span className="home-card-id">{run.run_id}</span>
          <span className="visually-hidden">Waiting on you: </span>
          <Chip tone="warn">{WAITING_LABEL[kind]}</Chip>
          <StatusBadge status={run.status} />
        </span>
        <span className="home-card-context">{namesOf(row)}</span>
        <span className="home-card-summary">{rowSummary(run, row.labels)}</span>
        {headline && <span className="home-card-cause" data-testid="run-cause">{headline}</span>}
        <span className="home-card-foot">
          <span className="home-card-next" data-testid="next-step">Next: {NEXT_STEP[kind]}</span>
          {since && <span className="home-card-when">since <Time iso={since} /> · {formatAgo(since, now)}</span>}
          <span className="home-card-open" aria-hidden="true">open run ›</span>
        </span>
      </AppLink>
    </li>
  )
}

/**
 * A live run nothing waits on: toned by its state, the current step from the served headline, one chip per lane its
 * definition launches (no state claim: the served activity has none per lane), the elapsed time, and the controller only as
 * the debounced readings say.
 */
function RunningCard({ row, readings, now, onNavigate }: { row: Row; readings: readonly ControllerReading[]; now: number; onNavigate: (pathname: string) => void }) {
  const { run } = row
  const tone = stateTone({ status: run.status, attention: run.activity?.attention?.kind ?? null })
  const time = rowTime(run, now)
  const elapsed = cardElapsed(run, now)
  const controller = controllerSuffix(run.status, readings)
  const lanes = laneNamesOf(row.workflow.nodes)
  return (
    <li className={`ui-card ${toneClass(tone)} home-card`}>
      <AppLink href={hrefOf(row)} onNavigate={onNavigate} className="home-card-link" data-run-id={run.run_id} data-status={run.status}>
        <span className="home-card-head">
          <span className="home-card-id">{run.run_id}</span>
          <StatusBadge status={run.status} explain />
          {controller === 'running' && <Chip tone="run" data-controller="running">controller running</Chip>}
          {controller === 'not_running' && <Chip tone="warn" plain data-controller="not_running">▲ controller not running</Chip>}
        </span>
        <span className="home-card-context">{namesOf(row)}</span>
        <span className="home-card-summary">{rowSummary(run, row.labels)}</span>
        <span className="home-card-foot">
          {lanes.length > 0 && (
            <span className="home-card-lanes">
              <span className="visually-hidden">Lanes: </span>
              {lanes.map(lane => <Chip key={lane} plain className="lane-chip" data-lane={lane}>{lane}</Chip>)}
            </span>
          )}
          {time.kind === 'live' && elapsed && (
            <span className="home-card-when">
              <span data-testid="run-elapsed">{elapsed.elapsed}</span>
              {elapsed.since && <>{' '}· <span className="home-card-since">since <Time iso={elapsed.since} /></span></>}
              {elapsed.started && <>{' '}· started <Time iso={elapsed.started} /></>}
            </span>
          )}
          {time.kind !== 'live' && <span className="home-card-when">updated <Time iso={run.updated_at} /> · {formatAgo(run.updated_at, now)}</span>}
          <span className="home-card-open" aria-hidden="true">open run ›</span>
        </span>
      </AppLink>
    </li>
  )
}

function RailProject({ project, entry, onNavigate }: { project: Project; entry: ProjectRuns | null; onNavigate: (pathname: string) => void }) {
  const runs = entry && entry.error === null ? entry.workflows.flatMap(item => item.runs) : null
  const tone: Tone = runs === null ? 'idle' : projectTone(runs)
  const facts = runs === null || entry === null ? null : projectFacts(entry.workflows.length, runs)
  const more = entry?.workflows.some(item => item.more) ?? false
  return (
    <AppLink href={projectPathname(project.project_id)} onNavigate={onNavigate} className="rail-project" data-project-id={project.project_id}>
      <span className="rail-name">{project.name}</span>
      <span className={`rail-dot ${toneClass(tone)}`} data-tone={tone} title={TONE_LABEL[tone]} aria-hidden="true" />
      <span className="visually-hidden"> · {TONE_LABEL[tone]} · </span>
      {facts && runs && <span className="rail-facts">{facts.features} · {runs.length}{more ? '+' : ''} {runs.length === 1 && !more ? 'run' : 'runs'}</span>}
    </AppLink>
  )
}

type HomeProps = {
  projects: readonly Project[]
  runs: Resource<ProjectRuns[]>
  meta: ResourceMeta
  now: number
  /** The read-only note, said once at the rail's foot. */
  note?: string | null
  onNavigate: (pathname: string) => void
}

/**
 * Runs home, `/projects` (docs/PRD_VIEWER_REVAMP.md 5.1, after PRD_VIEWER_UX 4.1): a project rail with a status dot per
 * project, then what needs the operator, what runs and what finished in the last seven days across every registered project,
 * as cards and a searchable, filterable Recent grouped by day. Everything renders from the run lists' served activity; no run
 * detail is read for it.
 */
export function RunsHome({ projects, runs, meta, now, note = null, onNavigate }: HomeProps) {
  const [zone] = useTimeZone()
  const loaded = runs.status === 'ready' ? runs.data : null
  const rows = useMemo(() => loaded?.flatMap(entry => rowsOf(entry.project, entry.workflows)) ?? [], [loaded])
  const sections = homeSections(rows, now)
  const errors = (loaded ?? []).flatMap(entry => entry.error !== null
    ? [{ what: entry.project.name, error: entry.error }]
    : entry.workflows.filter(item => item.error !== null).map(item => ({ what: `${entry.project.name} · ${item.workflow.workflow_id}`, error: item.error })))
  const count = (items: Row[]) => (loaded === null ? null : items.length)
  const needsCount = count(sections.needsYou)

  // The controller chip of a Running card believes `not_running` only once the polls have read it for 15 s (PRD_VIEWER_UX 6.3).
  // One reading per settled poll, recorded while rendering that poll's rows (React's "adjust state on a prop change").
  const [readings, setReadings] = useState<{ settledAt: number | null; map: Map<string, ControllerReading[]> }>(() => ({ settledAt: null, map: new Map() }))
  if (meta.settledAt !== null && loaded !== null && meta.settledAt !== readings.settledAt) {
    const at = new Date(meta.settledAt).toISOString()
    const live = rows.filter(row => row.run.status === 'running' || row.run.status === 'paused')
    setReadings({ settledAt: meta.settledAt, map: recordHomeReadings(readings.map, live.map(row => ({ key: row.key, value: row.run.activity?.controller ?? null })), at) })
  }

  // The tab title keeps the count of what waits, so a background tab still says it.
  useEffect(() => {
    if (!needsCount) return
    const title = document.title
    document.title = `(${needsCount}) ${title}`
    return () => { document.title = title }
  }, [needsCount])

  const [openGroups, setOpenGroups] = useState<string[]>(readOpenGroups)
  const toggleGroup = (prefix: string, open: boolean) => {
    setOpenGroups(previous => {
      const next = open ? [...new Set([...previous, prefix])] : previous.filter(item => item !== prefix)
      try { window.localStorage.setItem(RAIL_OPEN_KEY, JSON.stringify(next)) } catch { /* remembered for this page only */ }
      return next
    })
  }
  const entryOf = (project: Project) => loaded?.find(item => item.project.project_id === project.project_id) ?? null
  const toneOf = (project: Project): Tone => {
    const entry = entryOf(project)
    return entry && entry.error === null ? projectTone(entry.workflows.flatMap(item => item.runs)) : 'idle'
  }
  const jumpToNeeds = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    const target = document.getElementById('needs-you')
    target?.scrollIntoView({ block: 'start' })
    target?.querySelector<HTMLElement>('a[data-run-id]')?.focus({ preventScroll: true })
  }

  return (
    <div className="home-layout">
      <aside className="home-rail" aria-label="Projects" data-testid="projects-rail">
        <a href="#needs-you" className={`rail-needs ${needsCount ? 'has-waiting' : ''}`} data-testid="rail-needs-you" onClick={jumpToNeeds}>
          Needs you{needsCount !== null && ` · ${needsCount}`}
        </a>
        <h2 className="rail-title" id="projects-title">Projects</h2>
        <ul className="projects-list rail-list" data-testid="projects-list">
          {railEntries(projects).map(entry => {
            if (entry.kind === 'project') {
              return <li key={entry.project.project_id}><RailProject project={entry.project} entry={entryOf(entry.project)} onNavigate={onNavigate} /></li>
            }
            const tone = TONE_ORDER.find(candidate => entry.projects.some(project => toneOf(project) === candidate)) ?? 'idle'
            return (
              <li key={`group:${entry.prefix}`} className="rail-group-item">
                <details className="rail-group" data-prefix={entry.prefix} open={openGroups.includes(entry.prefix)} onToggle={event => toggleGroup(entry.prefix, event.currentTarget.open)}>
                  <summary>
                    {entry.prefix} ({entry.projects.length})
                    <span className={`rail-dot ${toneClass(tone)}`} data-tone={tone} title={TONE_LABEL[tone]} aria-hidden="true" />
                    <span className="visually-hidden"> · {TONE_LABEL[tone]}</span>
                  </summary>
                  <ul className="rail-list">
                    {entry.projects.map(project => <li key={project.project_id}><RailProject project={project} entry={entryOf(project)} onNavigate={onNavigate} /></li>)}
                  </ul>
                </details>
              </li>
            )
          })}
        </ul>
        {note !== null && <p className="rail-note" data-testid="projects-info">{note}</p>}
      </aside>
      <section className="runs-home" aria-labelledby="runs-home-title">
        <div className="runs-home-head">
          <h2 id="runs-home-title">Runs</h2>
          {loaded !== null && <LiveStatus status="running" meta={meta} now={now} />}
        </div>
        {runs.status === 'loading' || runs.status === 'idle' ? <LoadingPanel>Loading the runs of every project…</LoadingPanel> : (
          <>
            <Section id="needs-you" headingId="needs-you-title" data-testid="needs-you" className="home-section" title={`Needs you${needsCount !== null ? ` · ${needsCount}` : ''}`}
              sub={needsCount === 0 ? 'nothing waits on you' : 'longest waiting first; the command is on the run page'}>
              {sections.needsYou.length > 0 && (
                <ul className="home-cards">
                  {sections.needsYou.map(row => <NeedsCard key={row.key} row={row} kind={waitingKind(row.run)!} now={now} onNavigate={onNavigate} />)}
                </ul>
              )}
            </Section>
            <Section headingId="running-title" data-testid="running-runs" className="home-section" title={`Running${count(sections.running) !== null ? ` · ${count(sections.running)}` : ''}`}
              sub={sections.running.length === 0 ? 'nothing is running' : 'latest activity first'}>
              {sections.running.length > 0 && (
                <ul className="home-cards">
                  {sections.running.map(row => <RunningCard key={row.key} row={row} readings={readings.map.get(row.key) ?? []} now={now} onNavigate={onNavigate} />)}
                </ul>
              )}
            </Section>
            <Recent rows={sections.recent} now={now} zone={zone} onNavigate={onNavigate} />
            {errors.length > 0 && (
              <Section headingId="attention-title" data-testid="lists-errors" role="alert" className="home-section" title={`Attention · ${errors.length}`}
                sub="Some runs could not be loaded, so these lists may be incomplete.">
                <ul className="home-cards">
                  {errors.map(({ what, error }) => (
                    <li key={what} className={`ui-card ${toneClass('fail')} home-card home-error`}>
                      <strong>{what}</strong>
                      <span>{describeApiError(error)}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </>
        )}
      </section>
    </div>
  )
}

const FILTER_LABEL: Record<RecentFilter, string> = { all: 'All', failed: 'Failed', succeeded: 'Succeeded', today: 'Today' }

/**
 * Recent (docs/PRD_VIEWER_REVAMP.md 5.1): finished runs of the last seven days, newest first, searched client-side on the run
 * id, the feature and the outcome, filtered (All, Failed, Succeeded, Today) and grouped by day or by project; the first ten
 * rows show, the rest behind "Show older" until the search, the filter or the grouping changes.
 */
function Recent({ rows, now, zone, onNavigate }: { rows: Row[]; now: number; zone: 'local' | 'utc'; onNavigate: (pathname: string) => void }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<RecentFilter>('all')
  const [byProject, setByProject] = useState(false)
  const view = `${query}\u0000${filter}\u0000${byProject}`
  const [expandedFor, setExpandedFor] = useState<string | null>(null)
  const counts = recentCounts(rows, now, zone)
  const kept = filterRecent(searchRows(rows, query), filter, now, zone)
  const groups = byProject ? groupByProject(kept) : groupByDay(kept, now, zone)
  const shown = expandedFor === view ? { groups, hidden: 0 } : firstRows(groups, RECENT_SHOWN)
  const filters = (['all', 'failed', 'succeeded', 'today'] as const).map(id => ({ id, label: FILTER_LABEL[id], count: id === 'failed' || id === 'succeeded' ? counts[id] : undefined }))
  return (
    <Section headingId="recent-title" data-testid="recent-runs" className="home-section" title={`Recent · ${rows.length}`} sub="finished in the last 7 days">
      <div className="home-tools">
        <label htmlFor="runs-search" className="visually-hidden">Search runs</label>
        <input id="runs-search" className="home-search" type="search" value={query} placeholder="Search run id, feature or outcome" autoComplete="off"
          onChange={event => setQuery(event.target.value)} />
        <FilterRow aria-label="Filter recent runs" filters={filters} selected={filter} onSelect={id => setFilter(id as RecentFilter)} />
        <div className="ui-filters" role="group" aria-label="Group recent runs">
          <FilterButton pressed={byProject} onClick={() => setByProject(value => !value)}>Group by project</FilterButton>
        </div>
      </div>
      {rows.length === 0 && <p className="projects-muted lists-empty">No run finished in the last 7 days.</p>}
      {rows.length > 0 && kept.length === 0 && <p className="projects-muted lists-empty">No recent run matches.</p>}
      {shown.groups.map(group => (
        <div key={group.key} className="recent-group" data-day={byProject ? undefined : group.key} data-group={byProject ? group.key : undefined}>
          <h3 className="recent-group-label">{group.label}</h3>
          <ul className="run-rows">
            {group.rows.map(row => (
              <RunRow key={row.key} run={row.run} labels={row.labels} context={contextOf(row)} now={now} onNavigate={onNavigate} href={hrefOf(row)} />
            ))}
          </ul>
        </div>
      ))}
      {shown.hidden > 0 && (
        <button type="button" className="home-show-older" onClick={() => setExpandedFor(view)}>Show older {shown.hidden}</button>
      )}
    </Section>
  )
}

type GroupsProps = {
  projectId: string
  workflows: readonly WorkflowDefinition[]
  runs: Resource<WorkflowRuns[]>
  now: number
  onNavigate: (pathname: string) => void
}

/**
 * The project page's rows (docs/PRD_VIEWER_UX.md 4.1, PRD_VIEWER_REVAMP 5.2): one card per feature whose header links to the
 * feature's runs (`workflows-list`) with the workflow id, the run count, the node count, the current revision and the latest
 * run's status and activity, then the feature's run rows. Runs of any age are listed here; only Runs home's Recent stops at
 * seven days.
 */
export function ProjectRunGroups({ projectId, workflows, runs, now, onNavigate }: GroupsProps) {
  const loaded = runs.status === 'ready' ? runs.data : null
  return (
    <ul className="lists-groups" data-testid="workflows-list">
      {workflows.map(workflow => {
        const entry = loaded?.find(item => item.workflow.workflow_id === workflow.workflow_id) ?? null
        const title = workflowTitle(workflow, entry ? latestFeature(entry.runs) : null)
        const labels = labelsOf(workflow)
        const count = entry === null ? null : `${entry.runs.length}${entry.more ? '+' : ''} ${entry.runs.length === 1 && !entry.more ? 'run' : 'runs'}`
        const last: RunSummary | null = entry ? latestRun(entry.runs) : null
        return (
          <li key={workflow.workflow_id} className="lists-group" data-workflow-id={workflow.workflow_id}>
            <AppLink href={workflowPathname(projectId, workflow.workflow_id)} onNavigate={onNavigate}
              className={`projects-card lists-group-head ui-card ${toneClass(last ? statusTone(last.status) : 'idle')}`}>
              <span className="projects-card-title">{title}</span>
              <span className="projects-muted">
                {workflow.workflow_id}{count !== null && <> · {count}</>} · {workflow.nodes.length} {workflow.nodes.length === 1 ? 'node' : 'nodes'} · current revision {shortRevision(workflow.definition_revision)}
                {title !== workflow.name && <> · {workflow.name}</>}
              </span>
              {last && <span className="lists-group-last">last run <StatusBadge status={last.status} /> · last activity {formatAgo(movedAt(last), now)}</span>}
            </AppLink>
            {entry === null && runs.status !== 'error' && <p className="projects-muted lists-empty">Loading runs…</p>}
            {entry !== null && entry.error !== null && (
              <p className="projects-error-inline" role="alert" data-testid="lists-errors">The runs of {title} could not be loaded: {describeApiError(entry.error)}</p>
            )}
            {entry !== null && entry.error === null && entry.runs.length === 0 && <p className="projects-muted lists-empty">No runs recorded yet.</p>}
            {entry !== null && entry.runs.length > 0 && (
              <ul className="run-rows" data-testid="project-runs">
                {entry.runs.map(run => (
                  <RunRow key={run.run_id} run={run} labels={labels} now={now} onNavigate={onNavigate} href={runPathname(projectId, workflow.workflow_id, run.run_id)} />
                ))}
              </ul>
            )}
          </li>
        )
      })}
    </ul>
  )
}
