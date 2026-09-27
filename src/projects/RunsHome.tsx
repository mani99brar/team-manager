import type { ReactNode } from 'react'
import { describeApiError, type Project, type ProjectRuns, type RunSummary, type WorkflowDefinition, type WorkflowRuns } from './api.ts'
import { homeSections, latestFeature, projectFacts, workflowTitle } from './lists.ts'
import { LiveStatus } from './LiveStatus.tsx'
import { AppLink, LoadingPanel } from './panels.tsx'
import { projectPathname, runPathname, workflowPathname } from './routes.ts'
import { RunRow } from './RunRow.tsx'
import { shortRevision } from './status.ts'
import { formatAgo } from './time.ts'
import type { Resource, ResourceMeta } from './useResource.ts'
import './lists.css'

/** One row of a list that mixes workflows: the run with what names it. */
type Row = { run: RunSummary; project: Project; workflow: WorkflowDefinition; title: string; labels: ReadonlyMap<string, string> }

const labelsOf = (workflow: WorkflowDefinition) => new Map(workflow.nodes.map(node => [node.node_id, node.label]))

function rowsOf(project: Project, entries: readonly WorkflowRuns[]): Row[] {
  return entries.flatMap(({ workflow, runs }) => {
    const title = workflowTitle(workflow, latestFeature(runs))
    const labels = labelsOf(workflow)
    return runs.map(run => ({ run, project, workflow, title, labels }))
  })
}

/** The context a mixed list names beside the run id: the workflow's title, the run's feature when it is not the title, and the project. */
const contextOf = (row: Row, project = true) => {
  const feature = row.run.activity?.feature ?? null
  return [row.title, feature !== row.title ? feature : null, project ? row.project.name : null]
}

/** A workflow or project whose runs could not be read: said once under the lists, never replaced by other data. */
function LoadErrors({ errors }: { errors: { what: string; error: unknown }[] }) {
  if (errors.length === 0) return null
  return (
    <div className="lists-errors" role="alert" data-testid="lists-errors">
      <p><strong>Some runs could not be loaded</strong>, so these lists may be incomplete.</p>
      <ul>{errors.map(({ what, error }) => <li key={what}>{what}: {describeApiError(error)}</li>)}</ul>
    </div>
  )
}

function Section({ id, title, count, note, empty, children }: { id: string; title: string; count: number | null; note?: string; empty: string; children: ReactNode }) {
  return (
    <section className="lists-section" aria-labelledby={`${id}-title`} data-testid={id}>
      <h3 id={`${id}-title`} className="lists-section-title">
        {title}{count !== null && <span className="lists-count"> · {count}</span>}
        {note && <span className="lists-note"> {note}</span>}
      </h3>
      {count === 0 ? <p className="projects-muted lists-empty">{empty}</p> : children}
    </section>
  )
}

type HomeProps = {
  projects: readonly Project[]
  runs: Resource<ProjectRuns[]>
  meta: ResourceMeta
  now: number
  onNavigate: (pathname: string) => void
}

/**
 * Runs home, `/projects` (docs/PRD_VIEWER_UX.md 4.1): does anything need the operator, what is running and what finished in
 * the last seven days, across every registered project, then the projects as compact cards. Rows come from the run lists'
 * served activity; no run detail is read for them.
 */
export function RunsHome({ projects, runs, meta, now, onNavigate }: HomeProps) {
  const loaded = runs.status === 'ready' ? runs.data : null
  const rows = loaded?.flatMap(entry => rowsOf(entry.project, entry.workflows)) ?? []
  const sections = homeSections(rows, now)
  const errors = (loaded ?? []).flatMap(entry => entry.error !== null
    ? [{ what: entry.project.name, error: entry.error }]
    : entry.workflows.filter(item => item.error !== null).map(item => ({ what: `${entry.project.name} · ${item.workflow.workflow_id}`, error: item.error })))
  const list = (items: Row[]) => (
    <ul className="run-rows">
      {items.map(row => (
        <RunRow
          key={`${row.project.project_id}/${row.workflow.workflow_id}/${row.run.run_id}`}
          run={row.run} labels={row.labels} context={contextOf(row)} now={now} onNavigate={onNavigate}
          href={runPathname(row.project.project_id, row.workflow.workflow_id, row.run.run_id)}
        />
      ))}
    </ul>
  )
  const count = (items: Row[]) => (loaded === null ? null : items.length)
  return (
    <>
      <section className="runs-home" aria-labelledby="runs-home-title">
        <div className="runs-home-head">
          <h2 id="runs-home-title">Runs</h2>
          {loaded !== null && <LiveStatus status="running" meta={meta} now={now} />}
        </div>
        {runs.status === 'loading' || runs.status === 'idle' ? <LoadingPanel>Loading the runs of every project…</LoadingPanel> : (
          <>
            <Section id="needs-you" title="Needs you" count={count(sections.needsYou)} empty="Nothing waits on you.">{list(sections.needsYou)}</Section>
            <Section id="running-runs" title="Running" count={count(sections.running)} empty="Nothing is running.">{list(sections.running)}</Section>
            <Section id="recent-runs" title="Recent" count={count(sections.recent)} note="(finished in the last 7 days)" empty="No run finished in the last 7 days.">{list(sections.recent)}</Section>
            <LoadErrors errors={errors} />
          </>
        )}
      </section>
      <section className="runs-home-projects" aria-labelledby="projects-title">
        <h2 id="projects-title">Projects</h2>
        <ul className="projects-list lists-projects" data-testid="projects-list">
          {projects.map(project => {
            const entry = loaded?.find(item => item.project.project_id === project.project_id) ?? null
            const facts = entry && entry.error === null ? projectFacts(entry.workflows.length, entry.workflows.flatMap(item => item.runs)) : null
            return (
              <li key={project.project_id}>
                <AppLink href={projectPathname(project.project_id)} onNavigate={onNavigate} className="projects-card lists-project-card">
                  <span className="projects-card-title">{project.name}</span>
                  <span className="projects-muted">
                    {project.project_id}
                    {facts && <> · {facts.features}{facts.lastRun !== null && <> · last run {formatAgo(facts.lastRun, now)}</>}</>}
                  </span>
                </AppLink>
              </li>
            )
          })}
        </ul>
      </section>
    </>
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
 * The project page's rows (docs/PRD_VIEWER_UX.md 4.1): the run rows of each feature under a header that links to the
 * feature's runs (`workflows-list`), with the workflow id, the run count, the node count and the current revision as
 * secondary text. Runs of any age are listed here; only Runs home's Recent stops at seven days.
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
        return (
          <li key={workflow.workflow_id} className="lists-group" data-workflow-id={workflow.workflow_id}>
            <AppLink href={workflowPathname(projectId, workflow.workflow_id)} onNavigate={onNavigate} className="projects-card lists-group-head">
              <span className="projects-card-title">{title}</span>
              <span className="projects-muted">
                {workflow.workflow_id}{count !== null && <> · {count}</>} · {workflow.nodes.length} {workflow.nodes.length === 1 ? 'node' : 'nodes'} · current revision {shortRevision(workflow.definition_revision)}
                {title !== workflow.name && <> · {workflow.name}</>}
              </span>
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
