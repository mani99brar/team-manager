/**
 * The reading pane (docs/PRD_PROJECTS_DISPATCH.md 4.3): it docks only while a run is selected. It shows the run's facts, its
 * steps with attempts, the lead sentence (where it stopped, or that it integrated), a command to copy, and "Open run page" —
 * the primary action, where the run controls live ([D7]). Esc or Close undocks it (handled by the page) and returns focus to
 * the row. On a phone it fills the screen with "Queue" and "Next" ([P..], the phone scenario).
 *
 * The pane reads the run summary and the dispatch steps the page already holds; it does not fetch the run detail. Its copy
 * block is a lightweight `$`-command rather than the run page's full `CommandBlock`, whose `NextStep`/served-run/controls
 * contexts belong to the run page: the primary action sends the operator there. (Reading of [D7] recorded in the handoff.)
 */
import { useEffect, useRef } from 'react'
import type { RunSummary } from '../api.ts'
import { runPathname } from '../routes.ts'
import { OVERRIDE_LABEL, STATUS_LABEL } from '../status.ts'
import { stateTone, toneClass } from '../tone.ts'
import { Time } from '../Time.tsx'
import { formatSpan } from '../time.ts'
import { StateGlyph } from './common.tsx'
import { PHASES, phaseOf } from './phases.ts'
import type { ProjectStepsRun } from './types.ts'

function CopyCommand({ text }: { text: string }) {
  const copy = () => { void navigator.clipboard?.writeText(text).catch(() => undefined) }
  return (
    <div className="dispatch-cmd">
      <span className="command-line"><span className="command-prompt" aria-hidden="true">$ </span><code data-testid="dispatch-pane-command">{text}</code></span>
      <button type="button" className="button button-small" data-testid="dispatch-pane-copy" aria-label="Copy command" onClick={copy}>Copy</button>
    </div>
  )
}

type Props = {
  run: RunSummary
  steps: ProjectStepsRun
  projectId: string
  workflowId: string
  onClose: () => void
  onNavigate: (pathname: string) => void
  phone: boolean
  onPrev?: () => void
  onNext?: () => void
}

export function ReadingPane({ run, steps, projectId, workflowId, onClose, onNavigate, phone, onPrev, onNext }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { closeRef.current?.focus() }, [run.run_id])
  const tone = stateTone({ status: run.status, attention: run.activity?.attention?.kind ?? null, accepted: run.accepted })
  const word = run.accepted ? OVERRIDE_LABEL : STATUS_LABEL[run.status]
  const activity = run.activity
  const finished = activity?.finished_at ?? null
  const wall = finished ? formatSpan(Date.parse(finished) - Date.parse(run.created_at)) : null
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
        <section className="dispatch-pane-sec">
          <h3>Command</h3>
          <CopyCommand text={`python -m workflow status ${run.run_id} --by operator`} />
        </section>
        <section className="dispatch-pane-sec dispatch-pane-actions">
          <a className="button dispatch-pane-open" data-testid="dispatch-open-run" href={runPathname(projectId, workflowId, run.run_id)}
            onClick={e => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); onNavigate(runPathname(projectId, workflowId, run.run_id)) }}>
            Open run page
          </a>
          {phone && (
            <div className="dispatch-pane-nav">
              <button type="button" className="button button-small" data-testid="dispatch-pane-queue" onClick={onPrev} disabled={!onPrev}>Queue</button>
              <button type="button" className="button button-small" data-testid="dispatch-pane-next" onClick={onNext} disabled={!onNext}>Next</button>
            </div>
          )}
        </section>
      </div>
    </aside>
  )
}
