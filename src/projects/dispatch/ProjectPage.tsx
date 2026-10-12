/**
 * The dedicated project page, `/projects/<p>` (docs/PRD_PROJECTS_DISPATCH.md 4.3, [O2]): a header with the repository, the
 * checkout and sync, outcome figures and jump buttons; the step chart of every feature's runs; the GitHub column; and a
 * reading pane that docks only while a run is selected. j/k moves the selection, Esc (or Close) undocks it. With nothing
 * selected the page uses the full width.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Project, RunSummary, WorkflowDefinition, WorkflowRuns } from '../api.ts'
import { waitingKind } from '../lists.ts'
import { runPathname } from '../routes.ts'
import { AppLink } from '../panels.tsx'
import { formatSpan } from '../time.ts'
import type { Zone } from '../time.ts'
import { Time } from '../Time.tsx'
import { stateTone } from '../tone.ts'
import { resolveRunWorkflow, sameRepoText, syncAsOf, syncPhrase, UPDATE_TIME_NOT_RECORDED } from './derive.ts'
import { StateGlyph, VisibilityChip } from './common.tsx'
import { GithubColumn } from './GithubColumn.tsx'
import { ReadingPane } from './ReadingPane.tsx'
import { AheadPane } from './AheadPane.tsx'
import { StepChart, type ChartRun, type FeatureGroup } from './StepChart.tsx'
import type { DispatchOverview, Landing, ProjectDispatch, ProjectSteps } from './types.ts'

/** What the reading pane docks for: a selected run, or the commits-ahead and landings list from the Local and GitHub card. */
type Selection = { kind: 'run'; runId: string } | { kind: 'ahead' } | null

/**
 * The state of this project's run lists, as the page needs it for "Needs you and running" (V5, V25). `ProjectsView` derives
 * it from the run-list resource: `loading` while the lists load, `failed` when the request failed or every workflow's run
 * list failed (with the reason to show), `ready` once they were read (partial failures are counted on the page from the run
 * lists themselves). The section never claims an all-clear the data does not hold ([L12]).
 */
export type RunsState = { kind: 'loading' } | { kind: 'failed'; reason: string } | { kind: 'ready' }

const ms = (iso: string) => Date.parse(iso)
const movedOf = (entry: ChartRun) => ms(entry.run.activity?.last_activity_at ?? entry.run.updated_at)

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

type Props = {
  project: Project
  workflows: readonly WorkflowDefinition[]
  projectRuns: readonly WorkflowRuns[]
  runsState: RunsState
  steps: ProjectSteps | null
  dispatch: ProjectDispatch | null
  overview: DispatchOverview | null
  allProjects: readonly Project[]
  now: number
  zone: Zone
  onNavigate: (pathname: string) => void
}

export function ProjectPage({ project, workflows, projectRuns, runsState, steps, dispatch, overview, allProjects, now, onNavigate }: Props) {
  const git = dispatch?.git ?? null
  const github = dispatch?.github ?? null
  const [selected, setSelected] = useState<Selection>(null)
  const [query, setQuery] = useState('')
  const filterRef = useRef<HTMLInputElement>(null)
  const chartRef = useRef<HTMLDivElement>(null)
  const selectedRunId = selected?.kind === 'run' ? selected.runId : null
  const selectRun = useCallback((runId: string) => setSelected({ kind: 'run', runId }), [])

  const overviewMap = useMemo(() => new Map((overview?.projects ?? []).map(p => [p.project_id, p])), [overview])
  const primaryName = git?.clone_primary && git.clone_primary !== project.project_id
    ? allProjects.find(p => p.project_id === git.clone_primary)?.name ?? git.clone_primary : null

  // Join the dispatch steps with the registry run summaries per workflow, newest first.
  const groups: FeatureGroup[] = useMemo(() => {
    const stepsByWorkflow = new Map((steps?.workflows ?? []).map(w => [w.workflow_id, w]))
    const runsByWorkflow = new Map(projectRuns.map(w => [w.workflow.workflow_id, w]))
    const landings = new Map<string, Landing>((git?.landings ?? []).map(l => [l.run_id, l]))
    return workflows.map(workflow => {
      const stepsWorkflow = stepsByWorkflow.get(workflow.workflow_id) ?? null
      const registryRuns = runsByWorkflow.get(workflow.workflow_id)?.runs ?? []
      const summaries = new Map(registryRuns.map(run => [run.run_id, run]))
      const runs: ChartRun[] = (stepsWorkflow?.runs ?? [])
        .map(stepsRun => { const run = summaries.get(stepsRun.run_id); return run ? { run, steps: stepsRun } : null })
        .filter((entry): entry is ChartRun => entry !== null)
        .sort((a, b) => movedOf(b) - movedOf(a) || a.run.run_id.localeCompare(b.run.run_id))
      // The header tone reads the latest registry run, so it is right even where the step data is absent ([L1]).
      const latest = registryRuns.reduce<RunSummary | null>((best, run) => (best === null || ms(run.activity?.last_activity_at ?? run.updated_at) > ms(best.activity?.last_activity_at ?? best.updated_at) ? run : best), null)
      const headTone = latest ? stateTone({ status: latest.status, attention: latest.activity?.attention?.kind ?? null, accepted: latest.accepted }) : 'idle'
      return { workflow, steps: stepsWorkflow, runs, total: runs.length, headTone, landings }
    })
  }, [workflows, projectRuns, steps, git])

  // A filter is active when the box holds any non-blank word; the step chart then says "0 of N runs match" for a group whose
  // runs all filter out, never "0 runs" as if the feature never ran (V30).
  const filtering = query.trim().length > 0
  const filtered: FeatureGroup[] = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (words.length === 0) return groups
    return groups.map(group => ({
      ...group,
      runs: group.runs.filter(entry => {
        const hay = `${entry.run.run_id} ${entry.run.activity?.feature ?? ''} ${entry.run.activity?.headline ?? ''}`.toLowerCase()
        return words.every(word => hay.includes(word))
      }),
    }))
  }, [groups, query])

  const order = useMemo(() => filtered.flatMap(group => group.runs.map(entry => entry.run.run_id)), [filtered])
  const selectedEntry = useMemo(() => filtered.flatMap(g => g.runs).find(e => e.run.run_id === selectedRunId) ?? null, [filtered, selectedRunId])
  const selectedWorkflowId = useMemo(() => filtered.find(g => g.runs.some(e => e.run.run_id === selectedRunId))?.workflow.workflow_id ?? null, [filtered, selectedRunId])

  const move = useCallback((delta: number) => {
    setSelected(current => {
      if (order.length === 0) return current
      const runId = current?.kind === 'run' ? current.runId : null
      const index = runId ? order.indexOf(runId) : -1
      const next = index < 0 ? (delta > 0 ? 0 : order.length - 1) : Math.min(order.length - 1, Math.max(0, index + delta))
      return { kind: 'run', runId: order[next] }
    })
  }, [order])

  // Undocking returns focus to what opened the pane: a run row for a run, the "Commits ahead and landings" button for the
  // commits view, as the run pane already did (V28). Both targets stay in the DOM when the pane unmounts, so Esc and Close
  // (which both call this) land focus reliably.
  const close = useCallback(() => {
    setSelected(null)
    if (selected?.kind === 'run') chartRef.current?.querySelector<HTMLElement>(`[data-run-id="${CSS.escape(selected.runId)}"]`)?.focus()
    else if (selected?.kind === 'ahead') document.querySelector<HTMLElement>('[data-testid="dispatch-ahead-button"]')?.focus()
  }, [selected])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
      if (event.key === 'Escape') {
        if (typing && target === filterRef.current) { setQuery(''); return }
        if (selected) { close(); return }
      }
      if (typing) return
      if (event.key === '/') { event.preventDefault(); filterRef.current?.focus(); return }
      if (event.key === 'j') { event.preventDefault(); move(1) }
      if (event.key === 'k') { event.preventDefault(); move(-1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [move, close, selected])

  const finished = projectRuns.flatMap(w => w.runs).filter(run => run.activity?.finished_at)
  const dur = (run: typeof finished[number]) => ms(run.activity!.finished_at!) - ms(run.created_at)
  const counts = {
    waits: projectRuns.flatMap(w => w.runs).filter(run => run.activity?.attention && ['question', 'pane', 'approval'].includes(run.activity.attention.kind)).length,
    succeeded: finished.filter(run => !run.accepted && run.status === 'succeeded').length,
    failed: finished.filter(run => run.status === 'failed').length,
    cancelled: finished.filter(run => run.status === 'cancelled').length,
  }
  const medOk = median(finished.filter(run => run.status === 'succeeded').map(dur))
  const medStop = median(finished.filter(run => run.status !== 'succeeded').map(dur))

  const openPrs = github?.status === 'read' ? github.open_prs ?? 0 : null
  const openIssues = github?.status === 'read' ? github.open_issues ?? 0 : null
  // Every jump button moves focus to its section, not only scrolls (V4): the four targets carry tabindex="-1" (set in the
  // JSX), so focusing the section itself is reliable, where focusing a descendant heading was a no-op (a heading is not focusable).
  const jump = (id: string) => () => {
    const target = document.getElementById(id)
    if (!target) return
    target.scrollIntoView({ block: 'start' })
    target.focus({ preventScroll: true })
  }
  const asOf = git ? syncAsOf(git) : null
  const runBranches = new Set<string>(projectRuns.flatMap(w => w.runs).map(run => (run as { source_branch?: string }).source_branch ?? '').filter(Boolean)
    .concat((steps?.workflows ?? []).flatMap(w => w.runs.map(r => r.source_branch ?? '').filter(Boolean))))
  const others = allProjects
    .filter(p => p.project_id !== project.project_id && overviewMap.get(p.project_id)?.github.repo && github?.repo && overviewMap.get(p.project_id)!.github.repo === github.repo)
    .map(p => ({ project: p, cloneId: overviewMap.get(p.project_id)?.git.clone_id ?? null, checkout: overviewMap.get(p.project_id)?.git.checkout ?? null }))
  // The header's "same repo as" names the other projects of this *clone* ([P28], V10), keyed on clone_id (a hash, [P8]), not
  // the GitHub repo: a non-GitHub shared clone still has clone mates, and separate clones of one GitHub repo are not clone mates.
  const cloneId = git?.clone_id ?? null
  const cloneMates = cloneId === null ? [] : allProjects.filter(p => p.project_id !== project.project_id && overviewMap.get(p.project_id)?.git.clone_id === cloneId)
  const sameRepo = sameRepoText(cloneMates.map(p => p.name))

  // The run's workflow, so an ahead commit that names a run can link to its run page (V24). The map knows a run from the
  // registry run lists and from the dispatch steps; both are bounded to the newest 50 per workflow (DEFAULT_RUN_LIMIT), so an
  // older run names no workflow here. When the project has exactly one workflow, that one is the answer; otherwise the commit
  // shows the run id as plain text with "older than the newest 50 runs", never a dead or guessed link ([L10], [L12]).
  const workflowOfRun = useMemo(() => {
    const map = new Map<string, string>()
    for (const w of projectRuns) for (const run of w.runs) map.set(run.run_id, w.workflow.workflow_id)
    for (const w of steps?.workflows ?? []) for (const r of w.runs) if (!map.has(r.run_id)) map.set(r.run_id, w.workflow_id)
    return map
  }, [projectRuns, steps])
  const singleWorkflowId = workflows.length === 1 ? workflows[0].workflow_id : null
  const runHref = useCallback((runId: string): string | null => {
    const workflowId = resolveRunWorkflow(runId, workflowOfRun, singleWorkflowId)
    return workflowId ? runPathname(project.project_id, workflowId, runId) : null
  }, [workflowOfRun, singleWorkflowId, project.project_id])
  // A landing carries its own `workflow_id`, so it always links to its run page ([L10]: Landings always link).
  const landingHref = useCallback((workflowId: string, runId: string): string => runPathname(project.project_id, workflowId, runId), [project.project_id])

  // "Needs you and running" (PRD 2, V5, V25): the runs of the readable workflows that wait on the operator or are running,
  // before the chart. A workflow whose run list failed contributes no runs (its `runs` is empty) but is counted as unread, so
  // the section says "N feature(s) cannot be read" and never claims a plain all-clear the data does not hold ([L10], [L12]).
  const allRuns = useMemo(() => projectRuns.flatMap(w => w.runs.map(run => ({ run, workflowId: w.workflow.workflow_id }))), [projectRuns])
  const waitingRuns = allRuns.filter(({ run }) => waitingKind(run) !== null)
  const runningRuns = allRuns.filter(({ run }) => run.status === 'running' && waitingKind(run) === null)
  const unreadFeatures = projectRuns.filter(w => w.error !== null).length
  const unreadText = unreadFeatures > 0 ? `${unreadFeatures} feature${unreadFeatures === 1 ? '' : 's'} cannot be read` : null

  return (
    <div className={`dispatch-project ${selected ? 'has-pane' : ''}`} data-testid="dispatch-project">
      <header className="dispatch-page-head dispatch-project-head" data-testid="dispatch-project-header">
        <div className="dispatch-project-title">
          <h1>{project.name}</h1>
          {github && github.repo
            ? <><a className="dispatch-ext dispatch-repo-l" href={`https://github.com/${github.repo}`} target="_blank" rel="noopener"><span className="dispatch-mono">{github.repo}</span></a>{github.status === 'read' && <VisibilityChip visibility={github.visibility} />}</>
            : null}
        </div>
        <p className="dispatch-meta">
          {git && git.status !== 'unavailable' && <>checkout <code>{git.checkout ?? 'detached'}</code> in <code>{git.repository_label}</code> · </>}
          {git && <span data-testid="dispatch-sync">{syncPhrase(git, project.project_id, primaryName)}{asOf && (asOf.updatedAt
            ? <> · as of <code>{asOf.ref}</code> updated here <Time iso={asOf.updatedAt} /></>
            : <> · {UPDATE_TIME_NOT_RECORDED}</>)}</span>}
          {sameRepo && <span data-testid="dispatch-same-repo"> · {sameRepo}</span>}
        </p>
        {(finished.length > 0 || counts.waits > 0) && (
          <p className="dispatch-figs" data-testid="dispatch-figures">
            {counts.waits > 0 && <span className="dispatch-fig tone-warn"><StateGlyph tone="warn" /><b>{counts.waits}</b> {counts.waits === 1 ? 'waits' : 'wait'} on you</span>}
            <span className="dispatch-fig tone-ok"><StateGlyph tone="ok" /><b>{counts.succeeded}</b> succeeded</span>
            <span className="dispatch-fig tone-fail"><StateGlyph tone="fail" /><b>{counts.failed}</b> failed</span>
            <span className="dispatch-fig tone-idle"><StateGlyph tone="idle" /><b>{counts.cancelled}</b> cancelled</span>
            <span className="dispatch-fig q">{medOk !== null ? <>median <b>{formatSpan(medOk)}</b> to land</> : 'nothing landed'}</span>
            {medStop !== null && <span className="dispatch-fig q">median <b>{formatSpan(medStop)}</b> before a stop</span>}
            <span className="dispatch-fig q">spend not recorded</span>
          </p>
        )}
        <nav className="dispatch-jump" aria-label="On this page">
          <button type="button" onClick={jump('dispatch-runs-section')}>Runs by feature</button>
          <button type="button" onClick={jump('g-local')}>Local and GitHub</button>
          {openPrs !== null && <button type="button" onClick={jump('g-prs')}>Pull requests · {openPrs} open</button>}
          {openIssues !== null && <button type="button" onClick={jump('g-iss')}>Issues · {openIssues} open</button>}
        </nav>
        <div className="dispatch-filter">
          <label htmlFor="dispatch-filter" className="visually-hidden">Filter this project's runs</label>
          <input id="dispatch-filter" ref={filterRef} type="search" autoComplete="off" placeholder="Filter this project's runs" value={query} onChange={e => setQuery(e.target.value)} />
        </div>
      </header>
      {/* The body is wrapped so its own width drives the chart/GitHub column count via a container query (V23): a container
          query cannot style the container itself, so the inner `.dispatch-project-body` grid is queried against this wrapper. */}
      <div className="dispatch-body-container">
      <div className="dispatch-project-body">
        <div className="dispatch-project-main">
          <section className="dispatch-needs" aria-label="Needs you and running" data-testid="dispatch-needs">
            <h2 className="dispatch-needs-h">Needs you and running</h2>
            {runsState.kind === 'loading'
              ? <p className="dispatch-muted" data-testid="dispatch-needs-loading">Reading runs…</p>
              : runsState.kind === 'failed'
                ? <p className="dispatch-muted" data-testid="dispatch-needs-failed">Runs not read: {runsState.reason}</p>
                : waitingRuns.length === 0 && runningRuns.length === 0 && unreadText === null
                  ? <p className="dispatch-muted" data-testid="dispatch-needs-none">Nothing waits on you; nothing running.</p>
                  : (
                    <>
                      {waitingRuns.length === 0 && runningRuns.length === 0
                        ? <p className="dispatch-muted" data-testid="dispatch-needs-clear">Nothing waits on you; nothing running</p>
                        : (
                          <ul className="dispatch-needs-list">
                            {waitingRuns.map(({ run, workflowId }) => (
                              <li key={run.run_id} className="tone-warn">
                                <StateGlyph tone="warn" />
                                <AppLink href={runPathname(project.project_id, workflowId, run.run_id)} onNavigate={onNavigate}><code>{run.run_id}</code></AppLink>
                                <span className="dispatch-muted">waits on you{run.activity?.feature ? ` · ${run.activity.feature}` : ''}</span>
                              </li>
                            ))}
                            {runningRuns.map(({ run, workflowId }) => (
                              <li key={run.run_id} className="tone-run">
                                <StateGlyph tone="run" live />
                                <AppLink href={runPathname(project.project_id, workflowId, run.run_id)} onNavigate={onNavigate}><code>{run.run_id}</code></AppLink>
                                <span className="dispatch-muted">running{run.activity?.feature ? ` · ${run.activity.feature}` : ''}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      {unreadText && <p className="dispatch-muted" data-testid="dispatch-needs-unread"> · {unreadText}</p>}
                    </>
                  )}
          </section>
          <section id="dispatch-runs-section" aria-label="Runs by feature" tabIndex={-1} ref={chartRef}>
            <StepChart projectId={project.project_id} defaultBranch={git?.default_branch ?? null} groups={filtered} filtering={filtering} selectedRunId={selectedRunId} onSelect={selectRun} onNavigate={onNavigate} />
          </section>
        </div>
        <GithubColumn project={project} git={git} github={github} runBranches={runBranches} others={others} primaryName={primaryName}
          viewerLogin={overview?.viewer_login ?? null} readAt={overview ? ms(overview.read_at) : now}
          onShowAhead={() => setSelected({ kind: 'ahead' })} aheadOpen={selected?.kind === 'ahead'} onNavigate={onNavigate} />
      </div>
      </div>
      {selected?.kind === 'run' && selectedEntry && selectedWorkflowId && (
        <ReadingPane key={selectedEntry.run.run_id} run={selectedEntry.run} steps={selectedEntry.steps} projectId={project.project_id} workflowId={selectedWorkflowId}
          onClose={close} onNavigate={onNavigate} phone={typeof window !== 'undefined' && window.innerWidth <= 480}
          onNext={() => move(1)} />
      )}
      {selected?.kind === 'ahead' && git && (
        <AheadPane git={git} onClose={close} runHref={runHref} landingHref={landingHref} onNavigate={onNavigate}
          phone={typeof window !== 'undefined' && window.innerWidth <= 480} />
      )}
    </div>
  )
}
