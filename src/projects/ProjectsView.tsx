import { useCallback, useEffect, useMemo, useState } from 'react'
import { Breadcrumbs, type PathCrumb } from '../graph/Breadcrumbs.tsx'
import { fetchProjects, fetchRunDetail, fetchRuns, fetchWorkflows, ProjectsApiError, type RunPage, type RunSummary } from './api.ts'
import { AppLink, EmptyPanel, ErrorPanel, LoadingPanel, StatusBadge } from './panels.tsx'
import { projectPathname, projectsPathname, runPathname, workflowPathname, type ProjectsRoute } from './routes.ts'
import { RunView } from './RunView.tsx'
import { formatTime, shortRevision } from './status.ts'
import { useResource } from './useResource.ts'
import { WorkflowGraph } from './WorkflowGraph.tsx'

type Props = {
  /** Null when the pathname is under /projects but malformed. */
  route: ProjectsRoute | null
  refreshToken: number
  onNavigate: (pathname: string) => void
  onAnnounce: (message: string) => void
}

/**
 * The Projects root: registered projects, their workflow definitions and runs, read-only. Every level
 * loads from the scoped API and shows loading, empty, not-found and failure states in place; nothing
 * is ever substituted from fixtures.
 */
export function ProjectsView({ route, refreshToken, onNavigate, onAnnounce }: Props) {
  const projectId = route && route.level !== 'projects' ? route.projectId : null
  const workflowId = route && (route.level === 'workflow' || route.level === 'run') ? route.workflowId : null
  const runId = route && route.level === 'run' ? route.runId : null
  const nodeId = route && route.level === 'run' ? route.nodeId : null

  const { state: projects, reload: reloadProjects } = useResource('projects', fetchProjects, refreshToken)
  const loadWorkflows = useCallback((signal: AbortSignal) => fetchWorkflows(projectId!, signal), [projectId])
  const { state: workflows, reload: reloadWorkflows } = useResource(projectId === null ? null : `workflows:${projectId}`, loadWorkflows, refreshToken)
  const loadRuns = useCallback((signal: AbortSignal) => fetchRuns(projectId!, workflowId!, {}, signal), [projectId, workflowId])
  const runsKey = workflowId === null ? null : `runs:${projectId}/${workflowId}`
  const { state: firstPage, reload: reloadRuns } = useResource(runsKey, loadRuns, refreshToken)
  const scope = useMemo(() => (projectId === null || workflowId === null || runId === null ? null : { projectId, workflowId, runId }), [projectId, workflowId, runId])
  const loadDetail = useCallback((signal: AbortSignal) => fetchRunDetail({ projectId: projectId!, workflowId: workflowId!, runId: runId! }, signal), [projectId, workflowId, runId])
  const { state: detail, reload: reloadDetail } = useResource(scope === null ? null : `run:${scope.projectId}/${scope.workflowId}/${scope.runId}`, loadDetail, refreshToken)

  // Additional run pages are appended on demand; they belong to exactly one loaded first page and are dropped with it.
  const firstPageData = firstPage.status === 'ready' ? firstPage.data : null
  const [morePages, setMorePages] = useState<{ base: RunPage | null; pages: RunPage[]; loading: boolean; error: unknown }>({ base: null, pages: [], loading: false, error: null })
  const extra = morePages.base !== null && morePages.base === firstPageData ? morePages : { base: firstPageData, pages: [], loading: false, error: null }
  const pages: RunPage[] = firstPageData ? [firstPageData, ...extra.pages] : []
  const runs: RunSummary[] = pages.flatMap(page => page.runs)
  const nextCursor = pages.length ? pages[pages.length - 1].nextCursor : null
  const loadMore = async () => {
    if (!nextCursor || projectId === null || workflowId === null || firstPageData === null) return
    setMorePages({ ...extra, base: firstPageData, loading: true, error: null })
    try {
      const page = await fetchRuns(projectId, workflowId, { cursor: nextCursor })
      setMorePages(previous => (previous.base === firstPageData ? { ...previous, pages: [...previous.pages, page], loading: false } : previous))
    } catch (error) {
      setMorePages(previous => (previous.base === firstPageData ? { ...previous, loading: false, error } : previous))
    }
  }

  const projectName = projects.status === 'ready' && projectId !== null ? projects.data.find(project => project.project_id === projectId)?.name ?? projectId : projectId
  const currentWorkflow = workflows.status === 'ready' && workflowId !== null ? workflows.data.find(workflow => workflow.workflow_id === workflowId) ?? null : null
  const workflowName = currentWorkflow?.name ?? workflowId

  useEffect(() => {
    if (route === null) onAnnounce('This Projects link is invalid.')
    else if (route.level === 'projects' && projects.status === 'ready') onAnnounce(`Loaded ${projects.data.length} ${projects.data.length === 1 ? 'project' : 'projects'}.`)
    else if (route.level === 'project' && workflows.status === 'ready') onAnnounce(`Loaded ${workflows.data.length} ${workflows.data.length === 1 ? 'workflow' : 'workflows'} for ${projectName ?? route.projectId}.`)
    else if (route.level === 'workflow' && firstPage.status === 'ready') onAnnounce(`Loaded ${firstPage.data.runs.length} ${firstPage.data.runs.length === 1 ? 'run' : 'runs'} for ${workflowName ?? route.workflowId}.`)
    else if (route.level === 'run' && detail.status === 'ready') onAnnounce(`Loaded run ${route.runId}: ${detail.data.summary.status.replace('_', ' ')}.`)
    else if ((projects.status === 'error') || workflows.status === 'error' || firstPage.status === 'error' || detail.status === 'error') onAnnounce('Loading failed.')
  }, [route, projects, workflows, firstPage, detail, projectName, workflowName, onAnnounce])

  const crumbs: PathCrumb[] = [{ id: 'home', label: 'Home', pathname: '/' }, { id: 'projects', label: 'Projects', pathname: projectsPathname() }]
  if (projectId !== null) crumbs.push({ id: `project:${projectId}`, label: projectName ?? projectId, pathname: projectPathname(projectId) })
  if (projectId !== null && workflowId !== null) crumbs.push({ id: `workflow:${workflowId}`, label: workflowName ?? workflowId, pathname: workflowPathname(projectId, workflowId) })
  if (projectId !== null && workflowId !== null && runId !== null) crumbs.push({ id: `run:${runId}`, label: runId, pathname: runPathname(projectId, workflowId, runId) })
  if (route === null) crumbs.push({ id: 'invalid', label: 'Invalid link' })

  const notFound = (error: unknown) => error instanceof ProjectsApiError && error.notFound

  let info: string
  if (route === null) info = 'This Projects link is invalid.'
  else if (route.level === 'projects') info = 'Registered projects. Read-only: runs are started, approved and retried from the workflow CLI, never from this page.'
  else if (route.level === 'project') info = 'Workflow definitions registered for this project.'
  else if (route.level === 'workflow') info = 'Runs of this workflow, newest first. Each run keeps the definition it was started with.'
  else info = nodeId === null ? 'Run detail with its pinned definition graph.' : `Run detail, inspecting node ${nodeId}.`

  const busy = projects.status === 'loading' || workflows.status === 'loading' || firstPage.status === 'loading' || detail.status === 'loading'

  let content: React.ReactNode
  if (route === null) {
    content = (
      <div className="projects-error" role="alert">
        <p>This Projects link is invalid and could not be read. Links look like /projects/&lt;project&gt;/workflows/&lt;workflow&gt;/runs/&lt;run&gt;.</p>
        <p className="projects-actions"><AppLink href={projectsPathname()} onNavigate={onNavigate}>Go to Projects</AppLink></p>
      </div>
    )
  } else if (route.level === 'projects') {
    if (projects.status === 'loading' || projects.status === 'idle') content = <LoadingPanel>Loading registered projects…</LoadingPanel>
    else if (projects.status === 'error') content = <ErrorPanel error={projects.error} what="The project list" onRetry={reloadProjects} />
    else if (projects.data.length === 0) {
      content = (
        <EmptyPanel title="No projects are registered." testId="empty-projects">
          <p>The backend's project registry is empty. Projects are registered by the operator in the server configuration, not from this page.</p>
        </EmptyPanel>
      )
    } else {
      content = (
        <section aria-labelledby="projects-title">
          <h2 id="projects-title">Projects</h2>
          <ul className="projects-list" data-testid="projects-list">
            {projects.data.map(project => (
              <li key={project.project_id}>
                <AppLink href={projectPathname(project.project_id)} onNavigate={onNavigate} className="projects-card">
                  <span className="projects-card-title">{project.name}</span>
                  <span className="projects-muted">{project.project_id}</span>
                </AppLink>
              </li>
            ))}
          </ul>
        </section>
      )
    }
  } else if (route.level === 'project') {
    if (workflows.status === 'loading' || workflows.status === 'idle') content = <LoadingPanel>Loading workflows of {projectName}…</LoadingPanel>
    else if (workflows.status === 'error' && notFound(workflows.error)) {
      content = (
        <div className="projects-error" role="alert" data-testid="not-found">
          <p><strong>Project “{route.projectId}” is not registered.</strong> The API has no project with this ID; it may have been removed from the registry or the link may be wrong.</p>
          <p className="projects-actions"><AppLink href={projectsPathname()} onNavigate={onNavigate}>Go to Projects</AppLink></p>
        </div>
      )
    } else if (workflows.status === 'error') content = <ErrorPanel error={workflows.error} what={`The workflows of ${projectName}`} onRetry={reloadWorkflows} />
    else if (workflows.data.length === 0) {
      content = (
        <EmptyPanel title={`${projectName} has no workflow definitions.`} testId="empty-workflows">
          <p>The project is registered but no workflow is configured for it, so there is nothing to run or inspect here.</p>
        </EmptyPanel>
      )
    } else {
      content = (
        <section aria-labelledby="workflows-title">
          <h2 id="workflows-title">{projectName}: workflows</h2>
          <ul className="projects-list" data-testid="workflows-list">
            {workflows.data.map(workflow => (
              <li key={workflow.workflow_id}>
                <AppLink href={workflowPathname(route.projectId, workflow.workflow_id)} onNavigate={onNavigate} className="projects-card">
                  <span className="projects-card-title">{workflow.name}</span>
                  <span className="projects-muted">{workflow.workflow_id} · {workflow.nodes.length} {workflow.nodes.length === 1 ? 'node' : 'nodes'} · current revision {shortRevision(workflow.definition_revision)}</span>
                </AppLink>
              </li>
            ))}
          </ul>
        </section>
      )
    }
  } else if (route.level === 'workflow') {
    if (firstPage.status === 'loading' || firstPage.status === 'idle') content = <LoadingPanel>Loading runs of {workflowName}…</LoadingPanel>
    else if (firstPage.status === 'error' && notFound(firstPage.error)) {
      content = (
        <div className="projects-error" role="alert" data-testid="not-found">
          <p><strong>Workflow “{route.workflowId}” was not found in project “{route.projectId}”.</strong> Either the project is not registered or this workflow does not belong to it.</p>
          <p className="projects-actions">
            <AppLink href={projectPathname(route.projectId)} onNavigate={onNavigate}>Go to the project</AppLink>
            <AppLink href={projectsPathname()} onNavigate={onNavigate}>Go to Projects</AppLink>
          </p>
        </div>
      )
    } else if (firstPage.status === 'error') content = <ErrorPanel error={firstPage.error} what={`The runs of ${workflowName}`} onRetry={reloadRuns} />
    else {
      content = (
        <div className="workflow-view">
          <section aria-labelledby="runs-title">
            <h2 id="runs-title">{workflowName}: runs</h2>
            {runs.length === 0 ? (
              <EmptyPanel title="No runs have been recorded for this workflow." testId="empty-runs">
                <p>The workflow definition exists (see its current graph below) but it has never been run, or its runs are stored elsewhere. Runs are started from the workflow CLI.</p>
              </EmptyPanel>
            ) : (
              <ul className="projects-list run-list" data-testid="run-list">
                {runs.map(run => (
                  <li key={run.run_id} data-run-id={run.run_id} data-status={run.status}>
                    <AppLink href={runPathname(route.projectId, route.workflowId, run.run_id)} onNavigate={onNavigate} className="projects-card">
                      <span className="projects-card-title">{run.run_id} <StatusBadge status={run.status} explain /></span>
                      <span className="projects-muted">updated {formatTime(run.updated_at)} · created {formatTime(run.created_at)} · pinned revision {shortRevision(run.definition_revision)}</span>
                    </AppLink>
                  </li>
                ))}
              </ul>
            )}
            {nextCursor && (
              <div className="projects-actions">
                <button type="button" className="button" onClick={() => void loadMore()} disabled={extra.loading} aria-busy={extra.loading}>
                  {extra.loading ? 'Loading more runs…' : 'Load more runs'}
                </button>
              </div>
            )}
            {extra.error !== null && <ErrorPanel error={extra.error} what="The next page of runs" onRetry={() => void loadMore()} />}
          </section>
          <section aria-labelledby="definition-title" className="workflow-definition">
            <h3 id="definition-title">Current definition</h3>
            {workflows.status === 'loading' && <LoadingPanel>Loading the current definition…</LoadingPanel>}
            {workflows.status === 'error' && <ErrorPanel error={workflows.error} what="The current definition" onRetry={reloadWorkflows} />}
            {workflows.status === 'ready' && currentWorkflow === null && <p className="projects-error-inline" role="alert">The workflow list does not contain “{route.workflowId}”, so its current definition cannot be shown.</p>}
            {currentWorkflow && (
              <>
                <p className="projects-muted" data-testid="current-definition">{currentWorkflow.name} · revision <code>{shortRevision(currentWorkflow.definition_revision)}</code> · {currentWorkflow.nodes.length} nodes. Runs started before a definition change keep their own pinned graph.</p>
                <WorkflowGraph title={`Current definition graph of ${currentWorkflow.name}`} nodes={currentWorkflow.nodes} selectedId={null} />
              </>
            )}
          </section>
        </div>
      )
    }
  } else {
    const loading = detail.status === 'loading' || detail.status === 'idle'
    if (loading) content = <LoadingPanel>Loading run {route.runId}…</LoadingPanel>
    else if (detail.status === 'error' && notFound(detail.error)) {
      content = (
        <div className="projects-error" role="alert" data-testid="not-found">
          <p><strong>Run “{route.runId}” was not found in workflow “{route.workflowId}” of project “{route.projectId}”.</strong> Runs are only served under the project and workflow they belong to; a run of another project is not shown here.</p>
          <p className="projects-actions">
            <AppLink href={workflowPathname(route.projectId, route.workflowId)} onNavigate={onNavigate}>Go to the workflow's runs</AppLink>
            <AppLink href={projectsPathname()} onNavigate={onNavigate}>Go to Projects</AppLink>
          </p>
        </div>
      )
    } else if (detail.status === 'error') content = <ErrorPanel error={detail.error} what={`Run ${route.runId}`} onRetry={reloadDetail} />
    else content = <RunView scope={scope!} detail={detail.data} current={currentWorkflow} selectedNodeId={nodeId} refreshToken={refreshToken} onNavigate={onNavigate} />
  }

  return (
    <>
      <div className="navigation">
        <Breadcrumbs custom={{ crumbs, onNavigate }} selected={null} index={null} onNavigate={() => undefined} />
        <p className="folder-info" data-testid="projects-info">{info}</p>
      </div>
      <main className="workspace workspace-projects" aria-busy={busy} data-testid="projects-workspace">
        {content}
      </main>
    </>
  )
}
