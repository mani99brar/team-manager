/**
 * The reading pane (docs/PRD_PROJECTS_DISPATCH.md 4.3): it docks only while a run is selected. It shows the run's facts, its
 * steps with attempts, the lead sentence (where it stopped, or that it integrated), today's `CommandBlock` fed by the run's
 * `NextStep`, and "Open run page" — the primary action, where the run controls live ([D7]). Esc or Close undocks it (handled
 * by the page) and returns focus to the row. On a phone it fills the screen with "Queue" (back to the list) and "Next".
 *
 * The NextStep is the same one the run page shows: the pane reads the run detail with the existing `fetchRunDetail` and runs
 * `deriveNow` over it (events empty, as `servedNow` does), so the operator copies the real next-step commands, not a fixed
 * status line (V2, [P31]). While the detail loads, or when it fails, the pane says so and still offers "Open run page".
 */
import { useEffect, useRef, useState } from 'react'
import { deriveNow, type Now } from '../../../contracts/projects/triage.ts'
import { fetchRunDetail, type RunDetail, type RunSummary } from '../api.ts'
import { CommandBlock } from '../CommandBlock.tsx'
import { runPathname } from '../routes.ts'
import { OVERRIDE_LABEL, STATUS_LABEL } from '../status.ts'
import { stateTone, toneClass } from '../tone.ts'
import { Time } from '../Time.tsx'
import { formatSpan } from '../time.ts'
import { StateGlyph } from './common.tsx'
import { PHASES, phaseOf } from './phases.ts'
import type { ProjectStepsRun } from './types.ts'

type Props = {
  run: RunSummary
  steps: ProjectStepsRun
  projectId: string
  workflowId: string
  onClose: () => void
  onNavigate: (pathname: string) => void
  phone: boolean
  onNext?: () => void
}

type DetailState = { status: 'loading' } | { status: 'ready'; now: Now } | { status: 'error' }

export function ReadingPane({ run, steps, projectId, workflowId, onClose, onNavigate, phone, onNext }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { closeRef.current?.focus() }, [run.run_id])
  const tone = stateTone({ status: run.status, attention: run.activity?.attention?.kind ?? null, accepted: run.accepted })
  const word = run.accepted ? OVERRIDE_LABEL : STATUS_LABEL[run.status]
  const activity = run.activity
  const finished = activity?.finished_at ?? null
  const wall = finished ? formatSpan(Date.parse(finished) - Date.parse(run.created_at)) : null

  // The run's NextStep, the same one the run page shows for it: read the run detail and derive it with events empty, exactly
  // as `servedNow` does for the live chip ([P31]). A failed or still-loading read keeps "Open run page" available.
  // The pane is keyed by run id in the page, so it mounts fresh per run and the initial 'loading' state needs no effect reset.
  // A running or waiting run advances under the page's poll; `moved` (the run's last-activity time, which advances with it)
  // is an effect dependency, so the pane re-reads the detail and shows the fresh NextStep, not an obsolete command (V2). The
  // re-read keeps the current 'ready' commands on screen until the new ones arrive, so there is no flash back to "loading".
  const moved = run.activity?.last_activity_at ?? run.updated_at
  const [detail, setDetail] = useState<DetailState>({ status: 'loading' })
  useEffect(() => {
    let live = true
    const controller = new AbortController()
    fetchRunDetail({ projectId, workflowId, runId: run.run_id }, controller.signal)
      .then((data: RunDetail) => { if (live) setDetail({ status: 'ready', now: deriveNow({ detail: data, events: [], activity: data.summary.activity ?? null }) }) })
      .catch(() => { if (live) setDetail({ status: 'error' }) })
    return () => { live = false; controller.abort() }
  }, [projectId, workflowId, run.run_id, moved])

  const facts: [string, React.ReactNode][] = [
    ['Started', <Time key="s" iso={run.created_at} />],
    finished ? ['Finished', <Time key="f" iso={finished} />] : ['Last activity', <Time key="l" iso={activity?.last_activity_at ?? run.updated_at} />],
    ['Wall time', wall ?? <span className="dispatch-nr">not recorded</span>],
    ['Lanes', steps.lanes.length ? steps.lanes.join(', ') : <span className="dispatch-nr">not recorded</span>],
    ['Feature', activity?.feature ?? <span className="dispatch-nr">not recorded</span>],
  ]
  const lead = run.status === 'succeeded' && steps.integrated_commit
    ? `Integrated: fast-forwarded to ${steps.integrated_commit.slice(0, 7)}.`
    : activity?.headline ?? `${word}.`
  return (
    <aside className={`dispatch-pane ${phone ? 'phone' : ''} ${toneClass(tone)}`} data-testid="dispatch-pane" data-run-id={run.run_id} aria-label={`Run ${run.run_id}`}>
      <header className="dispatch-pane-head">
        <div className="dispatch-pane-top">
          <StateGlyph tone={tone} live={tone === 'run'} />
          <h2 className="dispatch-pane-id">{run.run_id}</h2>
          <span className="dispatch-word">{word}</span>
          <button type="button" ref={closeRef} className="button button-small dispatch-pane-close" data-testid="dispatch-pane-close" onClick={onClose}>Close</button>
        </div>
      </header>
      <div className="dispatch-pane-body">
        <section className="dispatch-pane-sec">
          <p className="dispatch-lead" data-testid="dispatch-pane-lead">{lead}</p>
        </section>
        <section className="dispatch-pane-sec">
          <h3>Facts</h3>
          <dl className="dispatch-facts">
            {facts.map(([label, value]) => (
              <div key={label} className="dispatch-fact"><dt>{label}</dt><dd>{value}</dd></div>
            ))}
          </dl>
        </section>
        <section className="dispatch-pane-sec">
          <h3>Steps</h3>
          <ul className="dispatch-pane-steps" data-testid="dispatch-pane-steps">
            {steps.steps.map(step => (
              <li key={step.node_id} data-step={step.node_id}>
                <span className="dispatch-pane-phase">{PHASES[phaseOf(step.node_id, step.kind)]}</span>
                <span className="dispatch-pane-step-label">{step.label}</span>
                <span className={`dispatch-word ${toneClass(stateTone({ status: step.status }))}`}>{step.status}</span>
                {step.attempt >= 2 && <span className="dispatch-att">×{step.attempt}</span>}
              </li>
            ))}
          </ul>
        </section>
        <section className="dispatch-pane-sec" data-testid="dispatch-pane-nextstep">
          <h3>Next step</h3>
          {detail.status === 'loading' && <p className="dispatch-muted" data-testid="dispatch-pane-next-loading">Reading the run's commands…</p>}
          {detail.status === 'error' && <p className="dispatch-muted" data-testid="dispatch-pane-next-error">The run's commands could not be read. Open the run page for the next step.</p>}
          {/* No separate lead line: today's CommandBlock already states the next step's label (as "Likely next step — …" or
              the sentence itself), so a lead paragraph here would repeat it word for word (V27). */}
          {detail.status === 'ready' && <CommandBlock next={detail.now.next} />}
        </section>
        <section className="dispatch-pane-sec dispatch-pane-actions">
          <a className="button dispatch-pane-open" data-testid="dispatch-open-run" href={runPathname(projectId, workflowId, run.run_id)}
            onClick={e => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); onNavigate(runPathname(projectId, workflowId, run.run_id)) }}>
            Open run page
          </a>
          {phone && (
            <div className="dispatch-pane-nav">
              <button type="button" className="button button-small dispatch-pane-back" data-testid="dispatch-pane-queue" onClick={onClose}>Queue</button>
              <button type="button" className="button button-small" data-testid="dispatch-pane-next" onClick={onNext} disabled={!onNext}>Next</button>
            </div>
          )}
        </section>
      </div>
    </aside>
  )
}
