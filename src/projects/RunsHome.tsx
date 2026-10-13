import { useEffect, useMemo, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from 'react'
import { describeApiError, type Project, type ProjectRuns, type RunSummary, type WorkflowDefinition, type WorkflowRuns } from './api.ts'
import {
  PAUSED_SHOWN,
  classifyRuns, classOf, filterRecent, firstRows, groupByDay, groupByProject, homeSections, laneNamesOf, latestFeature, latestRun, movedAt, NEXT_STEP,
  RECENT_SHOWN, recentCounts, rowSummary, searchRows, stepTally, workflowTitle,
  type ListRow, type NeedKind, type RecentFilter, type RunClasses,
} from './lists.ts'
import { LiveStatus } from './LiveStatus.tsx'
import { AppLink, LoadingPanel, StatusBadge } from './panels.tsx'
import { runPathname, workflowPathname } from './routes.ts'
import { PinToggle, RunRow } from './RunRow.tsx'
import { pinStore } from './pins.ts'
import { shortRevision } from './status.ts'
import { Time } from './Time.tsx'
import { formatAgo } from './time.ts'
import { stateTone, toneClass } from './tone.ts'
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
const WAITING_LABEL: Record<NeedKind, string> = {
  question: 'question waits', pane: 'pane needs you', approval: 'approval waits', decision: 'decision waits', interrupted: 'run interrupted',
}

/**
 * A run that waits on the operator (docs/PRD_VIEWER_REVAMP.md 5.1): a warn card whose link is its direct child, named by the
 * run id first, then what waits, the feature and project, the served headline, the next step as a label and since when. The
 * exact command needs the run detail, so it stays on the run page.
 */
function NeedsCard({ row, kind, now, onNavigate }: { row: Row; kind: NeedKind; now: number; onNavigate: (pathname: string) => void }) {
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
          <StatusBadge status={run.status} accepted={Boolean(run.accepted)} />
        </span>
        <span className="home-card-context">{namesOf(row)}</span>
        <span className="home-card-summary">{rowSummary(run, row.labels, kind)}</span>
        {headline && <span className="home-card-cause" data-testid="run-cause">{headline}</span>}
        <span className="home-card-foot">
          <span className="home-card-next" data-testid="next-step">Next: {NEXT_STEP[kind]}</span>
          {since && <span className="home-card-when">since <Time iso={since} /> · {formatAgo(since, now)}</span>}
          <span className="home-card-open" aria-hidden="true">open run ›</span>
        </span>
      </AppLink>
      <PinToggle target={run} className="home-card-pin" />
    </li>
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
export function RunsHome({ runs, meta, now, note = null, onNavigate }: HomeProps) {
  const [zone] = useTimeZone()
  const loaded = runs.status === 'ready' ? runs.data : null
  const rows = useMemo(() => loaded?.flatMap(entry => rowsOf(entry.project, entry.workflows)) ?? [], [loaded])
  // The list's one classification: every section, row, card and count below reads it, never a run's attention alone.
  const classes = useMemo(() => classifyRuns(rows.map(row => row.run)), [rows])
  const sections = homeSections(rows, now, zone, classes)
  const [allPaused, setAllPaused] = useState(false)
  const errors = (loaded ?? []).flatMap(entry => entry.error !== null
    ? [{ what: entry.project.name, error: entry.error }]
    : entry.workflows.filter(item => item.error !== null).map(item => ({ what: `${entry.project.name} · ${item.workflow.workflow_id}`, error: item.error })))
  // A project is unread when its own read failed or every one of its workflows' run lists did.
  const unreadProjects = (loaded ?? []).filter(entry => entry.error !== null || (entry.workflows.length > 0 && entry.workflows.every(item => item.error !== null))).length
  // With nothing waiting, moved today or running, Paused is the only work left: it shows every paused run, unfolded. With no
  // run list read there is no evidence for that, so the quiet line needs one read list (a partial read says it is incomplete).
  const listsRead = (loaded ?? []).some(entry => entry.error === null && entry.workflows.some(item => item.error === null))
  const quiet = listsRead && sections.needsYou.length === 0 && sections.today.length === 0 && sections.running.length === 0
  const pausedShown = allPaused || quiet ? sections.paused : sections.paused.slice(0, PAUSED_SHOWN)
  const count = (items: Row[]) => (loaded === null ? null : items.length)
  const needsCount = count(sections.needsYou)

  // The tab title keeps the count of what waits, so a background tab still says it.
  useEffect(() => {
    if (!needsCount) return
    const title = document.title
    document.title = `(${needsCount}) ${title}`
    return () => { document.title = title }
  }, [needsCount])

  // A jump link scrolls its section into view and hands the focus to its first run, so the keyboard continues from there.
  const jumpTo = (id: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    const target = document.getElementById(id)
    target?.scrollIntoView({ block: 'start' })
    target?.querySelector<HTMLElement>('a[data-run-id]')?.focus({ preventScroll: true })
  }
  const jumps: { id: string; label: string; count: number | null }[] = [
    { id: 'needs-you', label: 'Needs you', count: needsCount },
    { id: 'today-runs', label: 'Today', count: count(sections.today) },
    { id: 'running-runs', label: 'Running', count: count(sections.running) },
    { id: 'paused-runs', label: 'Paused', count: count(sections.paused) },
    { id: 'recent-runs', label: 'Recent', count: count(sections.recent) },
  ]
  const rowsList = (items: Row[], trailing?: (row: Row) => { text: string; tone?: 'pause' } | null): ReactNode => (
    <ul className="run-rows">
      {items.map(row => (
        <RunRow key={row.key} run={row.run} cls={classOf(classes, row.run)} labels={row.labels} context={contextOf(row)} lanes={laneNamesOf(row.workflow.nodes)}
          trailing={trailing?.(row) ?? null} now={now} onNavigate={onNavigate} href={hrefOf(row)} />
      ))}
    </ul>
  )

  return (
    <div className="triage-layout">
      <section className="runs-home" aria-labelledby="runs-home-title">
        <div className="runs-home-head">
          <h2 id="runs-home-title">Runs</h2>
          {loaded !== null && <LiveStatus status="running" meta={meta} now={now} />}
          {loaded !== null && (
            <nav className="home-jumps" aria-label="Sections" data-testid="home-jumps">
              {jumps.map(jump => (
                <a key={jump.id} href={`#${jump.id}`} className={jump.count ? 'has-rows' : ''} onClick={jumpTo(jump.id)} data-section={jump.id}>
                  {jump.label}{jump.count !== null && <span className="home-jump-count">{jump.count}</span>}
                </a>
              ))}
            </nav>
          )}
        </div>
        {runs.status === 'loading' || runs.status === 'idle' ? <LoadingPanel>Loading the runs of every project…</LoadingPanel> : (
          <>
            {unreadProjects > 0 && loaded !== null && (
              <p className="home-incomplete" role="status" data-testid="lists-incomplete">
                {loaded.length - unreadProjects} of {loaded.length} projects read; lists incomplete
              </p>
            )}
            <Pinned rows={rows} classes={classes} now={now} onNavigate={onNavigate} />
            {quiet && <p className="home-quiet" data-testid="home-quiet">Nothing waits on you, moved today or runs</p>}
            <Section id="needs-you" headingId="needs-you-title" data-testid="needs-you" className="home-section" hidden={quiet} title={`Needs you${needsCount !== null ? ` · ${needsCount}` : ''}`}
              sub={needsCount === 0 ? 'nothing waits on you' : 'longest waiting first; the command is on the run page'}>
              {sections.needsYou.length > 0 && (
                <ul className="home-cards">
                  {sections.needsYou.map(row => <NeedsCard key={row.key} row={row} kind={classOf(classes, row.run).needs!} now={now} onNavigate={onNavigate} />)}
                </ul>
              )}
            </Section>
            <Section id="today-runs" headingId="today-title" data-testid="today-runs" className="home-section" hidden={quiet} title={`Today${count(sections.today) !== null ? ` · ${count(sections.today)}` : ''}`}
              sub={sections.today.length === 0 ? 'nothing moved today' : `every run that moved today, running first · ${stepTally(sections.today) || 'latest activity first'}`}>
              {sections.today.length > 0 && rowsList(sections.today)}
            </Section>
            <Section id="running-runs" headingId="running-title" data-testid="running-runs" className="home-section" hidden={quiet} title={`Running${count(sections.running) !== null ? ` · ${count(sections.running)}` : ''}`}
              sub={sections.running.length === 0 ? 'nothing else is running' : `since an earlier day · ${stepTally(sections.running) || 'latest activity first'}`}>
              {sections.running.length > 0 && rowsList(sections.running)}
            </Section>
            <Section id="paused-runs" headingId="paused-title" data-testid="paused-runs" className="home-section" title={`Paused${count(sections.paused) !== null ? ` · ${count(sections.paused)}` : ''}`}
              sub={sections.paused.length === 0 ? 'nothing is paused' : `since an earlier day, longest paused first · ${stepTally(sections.paused) || ''}`}>
              {sections.paused.length > 0 && rowsList(pausedShown)}
              {sections.paused.length > pausedShown.length && (
                <button type="button" className="home-show-older" data-testid="paused-show-all" onClick={() => setAllPaused(true)}>Show all {sections.paused.length} paused</button>
              )}
              {sections.superseded.length > 0 && (
                // Paused runs a later run of their own feature replaced: nobody waits on them, so they stay folded away.
                <details className="home-superseded" data-testid="superseded-runs">
                  <summary>{sections.superseded.length} superseded</summary>
                  {rowsList(sections.superseded, row => ({ text: `superseded by ${classOf(classes, row.run).supersededBy}` }))}
                </details>
              )}
            </Section>
            <Recent rows={sections.recent} classes={classes} now={now} zone={zone} onNavigate={onNavigate} />
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
        {note !== null && <p className="rail-note" data-testid="projects-info">{note}</p>}
      </section>
    </div>
  )
}

/**
 * Triage's Pinned section ("Add to Triage", decisions.md [O6]): the runs the operator pinned in this browser, newest first, at
 * the top. A shortcut only: a pinned run keeps its place in its own section too. A pin whose run Triage did not read names
 * its id as a link to its run page; when the browser cannot keep pins, the section says so.
 */
function Pinned({ rows, classes, now, onNavigate }: { rows: readonly Row[]; classes: RunClasses; now: number; onNavigate: (pathname: string) => void }) {
  const pinned = pinStore()
  const pins = useSyncExternalStore(pinned.subscribe, pinned.list)
  const saved = useSyncExternalStore(pinned.subscribe, pinned.saved)
  if (pins.length === 0 && saved) return null
  const byKey = new Map(rows.map(row => [row.key, row]))
  return (
    <Section id="pinned-runs" headingId="pinned-title" data-testid="pinned-runs" className="home-section" title={`Pinned · ${pins.length}`}
      sub={pins.length === 0 ? 'no run pinned' : 'pinned in this browser, newest first; each run also stays in its own section'}>
      {!saved && <p className="projects-muted lists-empty" data-testid="pins-not-saved">Pins are not saved in this browser</p>}
      {pins.length > 0 && (
        <ul className="run-rows">
          {pins.map(pin => {
            const key = `${pin.project_id}/${pin.workflow_id}/${pin.run_id}`
            const row = byKey.get(key)
            if (row) {
              return <RunRow key={key} run={row.run} cls={classOf(classes, row.run)} labels={row.labels} context={contextOf(row)} now={now} onNavigate={onNavigate} href={hrefOf(row)} />
            }
            return (
              <li key={key} className="run-row-item pinned-unread">
                <span className="run-row pinned-unread-row">
                  <AppLink href={runPathname(pin.project_id, pin.workflow_id, pin.run_id)} onNavigate={onNavigate} className="pinned-unread-link">{pin.run_id}</AppLink>
                  <span className="projects-muted">not among the runs read</span>
                </span>
                <PinToggle target={pin} />
              </li>
            )
          })}
        </ul>
      )}
    </Section>
  )
}

const FILTER_LABEL: Record<RecentFilter, string> = { all: 'All', failed: 'Failed', succeeded: 'Succeeded', today: 'Today' }

/**
 * Recent (docs/PRD_VIEWER_REVAMP.md 5.1): finished runs of the last seven days, newest first, searched client-side on the run
 * id, the feature and the outcome, filtered (All, Failed, Succeeded, Today) and grouped by day or by project; the first ten
 * rows show, the rest behind "Show older" until the search, the filter or the grouping changes.
 */
function Recent({ rows, classes, now, zone, onNavigate }: { rows: Row[]; classes: RunClasses; now: number; zone: 'local' | 'utc'; onNavigate: (pathname: string) => void }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<RecentFilter>('all')
  const [byProject, setByProject] = useState(false)
  const view = `${query}\u0000${filter}\u0000${byProject}`
  const [expandedFor, setExpandedFor] = useState<string | null>(null)
  // The filter counts are over the set the search narrowed to (P2 1), so a button's number equals the rows that filter keeps.
  const searched = searchRows(rows, query)
  const counts = recentCounts(searched, now, zone)
  const kept = filterRecent(searched, filter, now, zone)
  const groups = byProject ? groupByProject(kept) : groupByDay(kept, now, zone)
  const shown = expandedFor === view ? { groups, hidden: 0 } : firstRows(groups, RECENT_SHOWN)
  const filters = (['all', 'failed', 'succeeded', 'today'] as const).map(id => ({ id, label: FILTER_LABEL[id], count: id === 'failed' || id === 'succeeded' ? counts[id] : undefined }))
  return (
    <Section id="recent-runs" headingId="recent-title" data-testid="recent-runs" className="home-section" title={`Recent · ${rows.length}`} sub="finished in the last 7 days, before today">
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
              <RunRow key={row.key} run={row.run} cls={classOf(classes, row.run)} labels={row.labels} context={contextOf(row)} now={now} onNavigate={onNavigate} href={hrefOf(row)} />
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
        const classes = classifyRuns(entry?.runs ?? [])
        return (
          <li key={workflow.workflow_id} className="lists-group" data-workflow-id={workflow.workflow_id}>
            <AppLink href={workflowPathname(projectId, workflow.workflow_id)} onNavigate={onNavigate}
              className={`projects-card lists-group-head ui-card ${toneClass(last ? stateTone({ status: last.status, accepted: last.accepted }) : 'idle')}`}>
              <span className="projects-card-title">{title}</span>
              <span className="projects-muted">
                {workflow.workflow_id}{count !== null && <> · {count}</>} · {workflow.nodes.length} {workflow.nodes.length === 1 ? 'node' : 'nodes'} · current revision {shortRevision(workflow.definition_revision)}
                {title !== workflow.name && <> · {workflow.name}</>}
              </span>
              {last && <span className="lists-group-last">last run <StatusBadge status={last.status} accepted={Boolean(last.accepted)} /> · last activity {formatAgo(movedAt(last), now)}</span>}
            </AppLink>
            {entry === null && runs.status !== 'error' && <p className="projects-muted lists-empty">Loading runs…</p>}
            {entry !== null && entry.error !== null && (
              <p className="projects-error-inline" role="alert" data-testid="lists-errors">The runs of {title} could not be loaded: {describeApiError(entry.error)}</p>
            )}
            {entry !== null && entry.error === null && entry.runs.length === 0 && <p className="projects-muted lists-empty">No runs recorded yet.</p>}
            {entry !== null && entry.runs.length > 0 && (
              <ul className="run-rows" data-testid="project-runs">
                {entry.runs.map(run => (
                  <RunRow key={run.run_id} run={run} cls={classOf(classes, run)} labels={labels} now={now} onNavigate={onNavigate} href={runPathname(projectId, workflow.workflow_id, run.run_id)} />
                ))}
              </ul>
            )}
          </li>
        )
      })}
    </ul>
  )
}
