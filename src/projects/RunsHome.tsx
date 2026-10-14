import { useEffect, useMemo, useSyncExternalStore, type MouseEvent, type ReactNode } from 'react'
import { describeApiError, type Project, type ProjectRuns, type RunSummary, type WorkflowDefinition, type WorkflowRuns } from './api.ts'
import {
  PAUSED_SHOWN,
  classifyRuns, classOf, compareCreated, firstRows, groupByDay, groupByProject, homeSections, laneNamesOf, latestFeature, latestRun, movedAt, NEXT_STEP,
  RECENT_SHOWN, rowSummary, sectionOrderWords, sortHomeSections, stepTally, workflowTitle,
  type HomeSections, type ListRow, type ListSort, type NeedKind, type RowGroup, type RunClasses,
} from './lists.ts'
import { FilterBar, NoMatch, type ListControl } from './FilterBar.tsx'
import { matchesFilter, scopeLine, statusCounts, type FilterItem } from './runFilter.ts'
import { LiveStatus } from './LiveStatus.tsx'
import { AppLink, LoadingPanel, StatusBadge } from './panels.tsx'
import { runPathname, workflowPathname } from './routes.ts'
import { PinToggle, RunRow } from './RunRow.tsx'
import { pinStore } from './pins.ts'
import { shortRevision } from './status.ts'
import { Time } from './Time.tsx'
import { formatAgo } from './time.ts'
import { stateTone, toneClass } from './tone.ts'
import { Chip, FilterButton, Section } from './ui/index.tsx'
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
  /** The list's state from the URL (the one filter bar) and its writers. */
  list: ListControl
  /** The opened folds of this page (Paused's "Show all", the superseded fold) and their writer. */
  folds: Readonly<Record<string, boolean>>
  onFold: (key: string, open: boolean | null) => void
}

/** A Triage row as the filter bar reads it: the run, its class in the unfiltered list, and the names it is searched by. */
const itemOf = (row: Row, classes: RunClasses): FilterItem => ({ run: row.run, cls: classOf(classes, row.run), names: [row.title, row.project.name] })

/**
 * Runs home, `/projects` (docs/PRD_VIEWER_REVAMP.md 5.1, after PRD_VIEWER_UX 4.1): a project rail with a status dot per
 * project, then what needs the operator, what runs and what finished in the last seven days across every registered project,
 * as cards and a searchable, filterable Recent grouped by day. Everything renders from the run lists' served activity; no run
 * detail is read for it.
 */
export function RunsHome({ runs, meta, now, note = null, onNavigate, list, folds, onFold }: HomeProps) {
  const [zone] = useTimeZone()
  const loaded = runs.status === 'ready' ? runs.data : null
  const rows = useMemo(() => loaded?.flatMap(entry => rowsOf(entry.project, entry.workflows)) ?? [], [loaded])
  // The list's one classification, over every loaded run before any filter: every section, row, card and count below reads
  // it, so hiding a run never changes what another needs.
  const classes = useMemo(() => classifyRuns(rows.map(row => row.run)), [rows])
  const all = homeSections(rows, now, zone, classes)
  // The one bar filters the full set before sectioning: each section keeps its runs that match, in the chosen sort.
  const filter = list.filter
  const filtering = list.active
  const context = { now, zone }
  const keep = (items: Row[]) => (filtering ? items.filter(row => matchesFilter(itemOf(row, classes), filter, context)) : items)
  const sections: HomeSections<Row> = sortHomeSections({
    needsYou: keep(all.needsYou), today: keep(all.today), running: keep(all.running), paused: keep(all.paused),
    superseded: keep(all.superseded), recent: keep(all.recent), classes,
  }, filter.sort)
  const sectioned = [...all.needsYou, ...all.running, ...all.today, ...all.paused, ...all.superseded, ...all.recent]
  const matched = sections.needsYou.length + sections.running.length + sections.today.length + sections.paused.length + sections.superseded.length + sections.recent.length
  const counts = statusCounts(sectioned.map(row => itemOf(row, classes)), filter, context)
  const allPaused = folds['paused-all'] === true
  const errors = (loaded ?? []).flatMap(entry => entry.error !== null
    ? [{ what: entry.project.name, error: entry.error }]
    : entry.workflows.filter(item => item.error !== null).map(item => ({ what: `${entry.project.name} · ${item.workflow.workflow_id}`, error: item.error })))
  // A project is unread when its own read failed or every one of its workflows' run lists did.
  const unreadProjects = (loaded ?? []).filter(entry => entry.error !== null || (entry.workflows.length > 0 && entry.workflows.every(item => item.error !== null))).length
  // With nothing waiting, running or finished today, Paused is the only work left: it shows every paused run, unfolded. With no
  // run list read there is no evidence for that, so the quiet line needs one read list (a partial read says it is incomplete).
  // Under a filter the sections say what matched instead.
  const listsRead = (loaded ?? []).some(entry => entry.error === null && entry.workflows.some(item => item.error === null))
  const quiet = !filtering && listsRead && all.needsYou.length === 0 && all.today.length === 0 && all.running.length === 0
  const pausedShown = allPaused || quiet ? sections.paused : sections.paused.slice(0, PAUSED_SHOWN)
  const count = (items: Row[]) => (loaded === null ? null : items.length)
  // The tab title counts what waits, over the unfiltered list.
  const needsCount = count(all.needsYou)
  /** A section's header count: its rows, or "<k> of <n>" while the bar filters. */
  const heading = (title: string, shown: Row[], total: Row[]) => `${title}${loaded === null ? '' : ` · ${filtering ? `${shown.length} of ${total.length}` : total.length}`}`
  const order = sectionOrderWords(filter.sort)

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
    { id: 'needs-you', label: 'Needs you', count: count(sections.needsYou) },
    { id: 'running-runs', label: 'Running', count: count(sections.running) },
    { id: 'today-runs', label: 'Today', count: count(sections.today) },
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
  const sub = (rows: Row[], empty: string, words = order) => (filtering && rows.length === 0 ? 'No run matches.' : rows.length === 0 ? empty : [stepTally(rows), words].filter(Boolean).join(' · '))
  const none = (shown: Row[], total: Row[]) => filtering && shown.length === 0 && total.length > 0 && <NoMatch />

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
            <FilterBar kind="triage" state={filter} counts={counts} scope={scopeLine('triage', matched, sectioned.length, false)} active={filtering}
              onChange={(next, options) => list.change(next, options)} onCommit={list.flush} onClear={list.clear} />
            {quiet && <p className="home-quiet" data-testid="home-quiet">Nothing waits on you, moved today or runs</p>}
            <Section id="needs-you" headingId="needs-you-title" data-testid="needs-you" className="home-section" hidden={quiet} title={heading('Needs you', sections.needsYou, all.needsYou)}
              sub={filtering && sections.needsYou.length === 0 ? 'No run matches.' : all.needsYou.length === 0 ? 'nothing waits on you' : `${sectionOrderWords(filter.sort, true)}; the command is on the run page`}>
              {none(sections.needsYou, all.needsYou)}
              {sections.needsYou.length > 0 && (
                <ul className="home-cards">
                  {sections.needsYou.map(row => <NeedsCard key={row.key} row={row} kind={classOf(classes, row.run).needs!} now={now} onNavigate={onNavigate} />)}
                </ul>
              )}
            </Section>
            <Section id="running-runs" headingId="running-title" data-testid="running-runs" className="home-section" hidden={quiet} title={heading('Running', sections.running, all.running)}
              sub={sub(sections.running, 'nothing is running')}>
              {none(sections.running, all.running)}
              {sections.running.length > 0 && rowsList(sections.running)}
            </Section>
            <Section id="today-runs" headingId="today-title" data-testid="today-runs" className="home-section" hidden={quiet} title={heading('Today', sections.today, all.today)}
              sub={sub(sections.today, 'nothing finished today')}>
              {none(sections.today, all.today)}
              {sections.today.length > 0 && rowsList(sections.today)}
            </Section>
            <Section id="paused-runs" headingId="paused-title" data-testid="paused-runs" className="home-section" title={heading('Paused', sections.paused, all.paused)}
              sub={sub(sections.paused, 'nothing is paused')}>
              {none(sections.paused, all.paused)}
              {sections.paused.length > 0 && rowsList(pausedShown)}
              {sections.paused.length > pausedShown.length && (
                <button type="button" className="home-show-older" data-testid="paused-show-all" onClick={() => onFold('paused-all', true)}>Show all {sections.paused.length} paused</button>
              )}
              {sections.superseded.length > 0 && (
                // Paused runs a later run of their own feature replaced: nobody waits on them, so they stay folded away.
                <details className="home-superseded" data-testid="superseded-runs" open={folds.superseded === true}
                  onToggle={event => { const open = (event.currentTarget as HTMLDetailsElement).open; if (open !== (folds.superseded === true)) onFold('superseded', open ? true : null) }}>
                  <summary>{sections.superseded.length} superseded</summary>
                  {rowsList(sections.superseded, row => ({ text: `superseded by ${classOf(classes, row.run).supersededBy}` }))}
                </details>
              )}
            </Section>
            <Recent rows={sections.recent} total={all.recent.length} filtering={filtering} sort={filter.sort} classes={classes} now={now} zone={zone} onNavigate={onNavigate} list={list} />
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
      sub={pins.length === 0 ? 'no run pinned' : saved ? 'pinned in this browser, newest first; each run also stays in its own section' : 'newest first; each run also stays in its own section'}>
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

/** Recent's groups under a sort: the groups keep the order the default rows give them; the rows inside each follow the sort. */
function sortedGroups<T extends { run: Row['run'] }>(groups: RowGroup<T>[], sort: ListSort): RowGroup<T>[] {
  if (sort === 'live') return groups
  const compare = compareCreated(sort === 'newest' ? 'desc' : 'asc')
  return groups.map(group => ({ ...group, rows: [...group.rows].sort((a, b) => compare(a.run, b.run)) }))
}

/**
 * Recent (docs/PRD_VIEWER_REVAMP.md 5.1): finished runs of the last seven days before today, latest first, grouped by day or
 * by project; the first ten rows show, the rest behind "Show older". Its search and status filters are Triage's one bar;
 * the grouping and "Show older" live in the URL with the bar's state.
 */
function Recent({ rows, total, filtering, sort, classes, now, zone, onNavigate, list }: {
  rows: Row[]; total: number; filtering: boolean; sort: ListSort; classes: RunClasses; now: number; zone: 'local' | 'utc'; onNavigate: (pathname: string) => void; list: ListControl
}) {
  const byProject = list.search.group
  // Groups are made from the rows in the default order, so a sort re-orders rows inside a group and never the groups.
  const live = [...rows].sort((a, b) => Date.parse(b.run.activity?.finished_at ?? b.run.updated_at) - Date.parse(a.run.activity?.finished_at ?? a.run.updated_at) || a.run.run_id.localeCompare(b.run.run_id))
  const groups = sortedGroups(byProject ? groupByProject(live) : groupByDay(live, now, zone), sort)
  const shown = list.search.older ? { groups, hidden: 0 } : firstRows(groups, RECENT_SHOWN)
  return (
    <Section id="recent-runs" headingId="recent-title" data-testid="recent-runs" className="home-section" title={`Recent · ${filtering ? `${rows.length} of ${total}` : total}`}
      sub={filtering && rows.length === 0 ? 'No run matches.' : `finished in the last 7 days, before today · ${sectionOrderWords(sort)}`}>
      <div className="home-tools">
        <div className="ui-filters" role="group" aria-label="Group recent runs">
          <FilterButton pressed={byProject} onClick={() => list.change({ group: !byProject })}>Group by project</FilterButton>
        </div>
      </div>
      {total === 0 && <p className="projects-muted lists-empty">No run finished in the last 7 days.</p>}
      {total > 0 && rows.length === 0 && <NoMatch />}
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
        <button type="button" className="home-show-older" onClick={() => list.change({ older: true })}>Show older {shown.hidden}</button>
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
