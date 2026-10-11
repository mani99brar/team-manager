/**
 * The dedicated project page, `/projects/<p>` (docs/PRD_PROJECTS_DISPATCH.md 4.3, [O2]): a header with the repository, the
 * checkout and sync, outcome figures and jump buttons; the step chart of every feature's runs; the GitHub column; and a
 * reading pane that docks only while a run is selected. j/k moves the selection, Esc (or Close) undocks it. With nothing
 * selected the page uses the full width.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Project, RunSummary, WorkflowDefinition, WorkflowRuns } from '../api.ts'
import { formatSpan } from '../time.ts'
import type { Zone } from '../time.ts'
import { Time } from '../Time.tsx'
import { stateTone } from '../tone.ts'
import { syncAsOf, syncPhrase } from './derive.ts'
import { StateGlyph, VisibilityChip } from './common.tsx'
import { GithubColumn } from './GithubColumn.tsx'
import { ReadingPane } from './ReadingPane.tsx'
import { StepChart, type ChartRun, type FeatureGroup } from './StepChart.tsx'
import type { DispatchOverview, Landing, ProjectDispatch, ProjectSteps } from './types.ts'

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
  steps: ProjectSteps | null
  dispatch: ProjectDispatch | null
  overview: DispatchOverview | null
  allProjects: readonly Project[]
  now: number
  zone: Zone
  onNavigate: (pathname: string) => void
}

export function ProjectPage({ project, workflows, projectRuns, steps, dispatch, overview, allProjects, now, onNavigate }: Props) {
  const git = dispatch?.git ?? null
  const github = dispatch?.github ?? null
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const filterRef = useRef<HTMLInputElement>(null)
  const chartRef = useRef<HTMLDivElement>(null)

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
      return { workflow, steps: stepsWorkflow, runs, headTone, landings }
    })
  }, [workflows, projectRuns, steps, git])

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
  const selectedEntry = useMemo(() => filtered.flatMap(g => g.runs).find(e => e.run.run_id === selected) ?? null, [filtered, selected])
  const selectedWorkflowId = useMemo(() => filtered.find(g => g.runs.some(e => e.run.run_id === selected))?.workflow.workflow_id ?? null, [filtered, selected])

  const move = useCallback((delta: number) => {
    setSelected(current => {
      if (order.length === 0) return current
      const index = current ? order.indexOf(current) : -1
      const next = index < 0 ? (delta > 0 ? 0 : order.length - 1) : Math.min(order.length - 1, Math.max(0, index + delta))
      return order[next]
    })
  }, [order])

  const close = useCallback(() => {
    setSelected(null)
    const row = chartRef.current?.querySelector<HTMLElement>(`[data-run-id="${CSS.escape(selected ?? '')}"]`)
    row?.focus()
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
  const jump = (id: string) => () => {
    const target = document.getElementById(id)
    target?.scrollIntoView({ block: 'start' })
    target?.querySelector<HTMLElement>('a, button, h3, input')?.focus({ preventScroll: true })
    if (target && !target.querySelector('a, button, input')) { target.setAttribute('tabindex', '-1'); target.focus({ preventScroll: true }) }
  }
  const asOf = git ? syncAsOf(git) : null
  const runBranches = new Set<string>(projectRuns.flatMap(w => w.runs).map(run => (run as { source_branch?: string }).source_branch ?? '').filter(Boolean)
    .concat((steps?.workflows ?? []).flatMap(w => w.runs.map(r => r.source_branch ?? '').filter(Boolean))))
  const others = allProjects
    .filter(p => p.project_id !== project.project_id && overviewMap.get(p.project_id)?.github.repo && github?.repo && overviewMap.get(p.project_id)!.github.repo === github.repo)
    .map(p => ({ project: p, cloneId: overviewMap.get(p.project_id)?.git.clone_id ?? null, checkout: overviewMap.get(p.project_id)?.git.checkout ?? null }))

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
          {git && <>checkout <code>{git.checkout ?? 'detached'}</code> in <code>{git.repository_label}</code> · </>}
          {git && <span data-testid="dispatch-sync">{syncPhrase(git, project.project_id, primaryName)}{asOf && asOf.updatedAt && <> · as of <code>{asOf.ref}</code> updated here <Time iso={asOf.updatedAt} /></>}</span>}
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
      <div className="dispatch-project-body">
        <div className="dispatch-project-main">
          <section id="dispatch-runs-section" aria-label="Runs by feature" ref={chartRef}>
            <StepChart projectId={project.project_id} defaultBranch={git?.default_branch ?? null} groups={filtered} selectedRunId={selected} onSelect={setSelected} onNavigate={onNavigate} />
          </section>
        </div>
        <GithubColumn project={project} git={git} github={github} runBranches={runBranches} others={others} primaryName={primaryName}
          viewerLogin={overview?.viewer_login ?? null} readAt={overview ? ms(overview.read_at) : now} onNavigate={onNavigate} />
      </div>
      {selectedEntry && selectedWorkflowId && (
        <ReadingPane run={selectedEntry.run} steps={selectedEntry.steps} projectId={project.project_id} workflowId={selectedWorkflowId}
          onClose={close} onNavigate={onNavigate} phone={typeof window !== 'undefined' && window.innerWidth <= 480}
          onPrev={() => move(-1)} onNext={() => move(1)} />
      )}
    </div>
  )
}
