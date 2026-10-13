/**
 * The step chart (docs/PRD_PROJECTS_DISPATCH.md 4.3, the mock-up's "Lines"): every feature's runs on one shared axis of eight
 * phases, each run drawn up to where it stopped. A feature is an `li[data-workflow-id]` whose header is an `a.lists-group-head`
 * carrying the feature's tone class ([L1], so `accepted.spec.ts` keeps passing); its header lists the landed shas and a chain of
 * run chips, then one row per run with a sticky-axis track solid up to the stop and dotted after, lane dots and `×N` attempts.
 *
 * Each run row joins the run's recorded steps (the dispatch `ProjectSteps`) with its run summary (status, activity, accepted)
 * so the stop glyph and tone are the run's own. A feature that could not be read shows its recorded error and the status
 * command, with the literal `<run-id>` placeholder for a whole-workflow failure ([P21]).
 */
import type { WorkflowDefinition } from '../api.ts'
import { runPathname, workflowPathname } from '../routes.ts'
import { AppLink } from '../panels.tsx'
import { OVERRIDE_LABEL, STATUS_LABEL } from '../status.ts'
import { stateTone, toneClass, type Tone } from '../tone.ts'
import { CHART_COLUMNS, PHASE_SHORT, PHASES, phaseOf } from './phases.ts'
import { endedCounts, landingKnown, noStopWording, runStepsRead, stopOf, type ChartRun, type StepsReadState } from './stops.ts'
import { landingWording } from './derive.ts'
import { StateGlyph } from './common.tsx'
import type { Landing, ProjectStepsRun, ProjectStepsWorkflow } from './types.ts'

const num = (runId: string) => runId.replace(/^.*-(\d+)$/, '$1')

export type { ChartRun } from './stops.ts'

function runWord(entry: ChartRun): string {
  const { run, cls } = entry
  if (run.accepted) return OVERRIDE_LABEL
  if (cls.needs === 'question') return 'question'
  if (cls.needs === 'approval') return 'awaiting approval'
  if (cls.needs === 'pane') return 'needs you'
  if (cls.needs === 'decision') return 'decision waits'
  if (cls.needs === 'interrupted') return 'interrupted'
  return STATUS_LABEL[run.status]
}

function runTone(entry: ChartRun): Tone {
  return entry.cls.needs !== null ? 'warn' : stateTone({ status: entry.run.status, accepted: entry.run.accepted })
}

/** The run's own steps grouped into the eight phase columns. */
function phaseColumns(entry: ChartRun): ProjectStepsRun['steps'][] {
  const columns: ProjectStepsRun['steps'][] = PHASES.map(() => [])
  for (const step of entry.steps?.steps ?? []) columns[phaseOf(step.node_id, step.kind)].push(step)
  return columns
}

function Track({ entry }: { entry: ChartRun }) {
  const stop = stopOf(entry)
  const columns = phaseColumns(entry)
  const tone = runTone(entry)
  return (
    <span className="dispatch-track" aria-hidden="true" style={{ gridTemplateColumns: CHART_COLUMNS }}>
      {columns.map((lanes, phase) => {
        const cls = stop === null ? 'ahead' : phase < stop.phase ? 'pass' : phase === stop.phase ? 'stop' : 'ahead'
        const multi = lanes.length > 1 ? ' multi' : ''
        return (
          <span key={phase} className={`dispatch-cell ${cls}${multi}`}>
            {lanes.length === 0
              ? <i className="dispatch-seg" />
              : lanes.map((step, lane) => {
                const here = stop !== null && phase === stop.phase && step.node_id === stop.stepId
                const reached = step.status !== 'pending'
                const stepTone: Tone = here ? tone : reached ? stateTone({ status: step.status }) : 'idle'
                return (
                  <span key={step.node_id} className="dispatch-lane" data-lane={lane}>
                    {here
                      ? <StateGlyph tone={tone} live={tone === 'run'} className="dispatch-stop-glyph" />
                      : <i className={`dispatch-dot ${toneClass(stepTone)} ${reached ? 'reached' : ''}`} />}
                    {step.attempt >= 2 && <b className="dispatch-att">×{step.attempt}</b>}
                  </span>
                )
              })}
          </span>
        )
      })}
    </span>
  )
}

function landingText(landing: Landing | null, defaultBranch: string | null, sourceBranch: string | null): string {
  if (landing === null) return ''
  return landingWording(landing, defaultBranch, sourceBranch)
}

function ChartRow({ entry, landing, defaultBranch, stepsRead, selected, onSelect }: {
  entry: ChartRun; landing: Landing | null; defaultBranch: string | null; stepsRead: StepsReadState
  selected: boolean; onSelect: (runId: string) => void
}) {
  const tone = runTone(entry)
  const word = runWord(entry)
  const stop = stopOf(entry)
  const stopStep = stop === null ? undefined : entry.steps?.steps[stop.index]
  // Without its recorded steps a row names only the served focus step, never a guessed stop.
  const stopLabel = stopStep?.label ?? (stop === null ? entry.run.activity?.focus?.label ?? null : 'launch')
  const repairs = (entry.steps?.steps ?? []).filter(s => /^repair-/.test(s.node_id)).length
  const integrated = entry.steps?.integrated_commit ?? null
  // A row with no stop to name says whether its steps are still loading, failed to read, or hold nothing for it (M1).
  const noStop = noStopWording(runStepsRead(entry, stepsRead))
  return (
    <button type="button" className={`dispatch-run tone-${tone}`} data-run-id={entry.run.run_id} aria-selected={selected} aria-pressed={selected}
      aria-label={`${entry.run.run_id}, ${word}. ${entry.run.status === 'succeeded' ? 'Reached Integrate.' : stopLabel === null ? noStop.aria : `Stopped at ${stopLabel}.`}`}
      onClick={() => onSelect(entry.run.run_id)}>
      <span className="dispatch-run-1">
        <StateGlyph tone={tone} live={tone === 'run'} />
        <span className="dispatch-run-id">{num(entry.run.run_id)}</span>
        <span className="dispatch-word">{word}</span>
        {repairs > 0 && <span className="dispatch-tag">{repairs} {repairs === 1 ? 'repair' : 'repairs'}</span>}
        <span className="dispatch-run-r">
          {integrated && <span className="dispatch-res"><code>{integrated.slice(0, 7)}</code>{landing && <span className="dispatch-off">{landingText(landing, defaultBranch, entry.steps?.source_branch ?? null)}</span>}</span>}
        </span>
      </span>
      <span className="dispatch-run-2">
        {entry.run.status === 'succeeded'
          ? <>integrated{integrated ? <> · <code>{integrated.slice(0, 7)}</code></> : null}</>
          : stopLabel === null
            ? <>{noStop.text}{entry.run.activity?.headline ? ` · ${entry.run.activity.headline}` : ''}</>
            : <>at <b>{stopLabel}</b>{entry.run.activity?.headline ? ` · ${entry.run.activity.headline}` : ''}</>}
      </span>
      <Track entry={entry} />
    </button>
  )
}

/**
 * The "Steps of this definition" fold (PRD 4.3, V7): the workflow's current definition steps (label and phase), read from
 * the definition the chart already holds (`workflow.nodes`), so a feature with no runs, or one whose definition changed since
 * its latest run, still shows the right steps; the run tracks keep their own recorded steps ([P30]).
 */
function DefinitionFold({ workflow }: { workflow: WorkflowDefinition }) {
  return (
    <details className="dispatch-def" data-testid="dispatch-def">
      <summary>Steps of this definition <span className="dispatch-muted">{workflow.nodes.length} steps</span></summary>
      <ol className="dispatch-def-list">
        {workflow.nodes.map(node => (
          <li key={node.node_id} data-node-id={node.node_id}>
            <span className="dispatch-def-phase">{PHASES[phaseOf(node.node_id, node.kind)]}</span>
            <span className="dispatch-def-label">{node.label}</span>
          </li>
        ))}
      </ol>
    </details>
  )
}

export type FeatureGroup = {
  workflow: WorkflowDefinition
  steps: ProjectStepsWorkflow | null
  runs: ChartRun[]
  /** The feature's run count before any filter, so a filtered-to-empty group reads "0 of N runs match", not "0 runs" (V30). */
  total: number
  /** The feature header's tone: the latest registry run's state tone, so it is correct even when the step data is absent ([L1]). */
  headTone: Tone
  /** The landings this project's git read reports, keyed by run id. */
  landings: Map<string, Landing>
  /** The feature's run list: still loading, failed, or read. Only a read list may say how many runs it holds. */
  runsRead: 'loading' | 'failed' | 'read'
}

type Props = {
  projectId: string
  defaultBranch: string | null
  groups: readonly FeatureGroup[]
  /** Whether the project's run filter is active, so a group filtered to nothing says "0 of N runs match" (V30). */
  filtering: boolean
  /** The project's steps read, so a run row without a stop says "reading steps…" while it loads, never "not read" (M1). */
  stepsRead: StepsReadState
  selectedRunId: string | null
  onSelect: (runId: string) => void
  onNavigate: (pathname: string) => void
}

export function StepChart({ projectId, defaultBranch, groups, filtering, stepsRead, selectedRunId, onSelect, onNavigate }: Props) {
  return (
    <div className="dispatch-chart" data-testid="dispatch-chart">
      <div className="dispatch-axis" data-testid="dispatch-axis">
        <span className="dispatch-axis-l" aria-hidden="true">phase</span>
        <span className="dispatch-axis-track" style={{ gridTemplateColumns: CHART_COLUMNS }}>
          {PHASES.map((phase, i) => (
            <span key={phase} className="dispatch-ax" data-phase={i} title={phase} aria-label={phase}>
              <span className="dispatch-ax-full" aria-hidden="true">{phase}</span>
              <span className="dispatch-ax-short" aria-hidden="true">{PHASE_SHORT[phase]}</span>
            </span>
          ))}
        </span>
      </div>
      <ul className="lists-groups" data-testid="dispatch-features">
        {groups.map(group => {
          const error = group.steps?.error ?? null
          const tone: Tone = error ? 'idle' : group.headTone
          const landed = group.runs.filter(entry => entry.steps?.integrated_commit).map(entry => entry.steps!.integrated_commit!)
          const counts = endedCounts(group.runs)
          const total = counts.slice(0, 7).reduce((a, b) => a + b, 0)
          return (
            <li key={group.workflow.workflow_id} className="lists-group dispatch-feature" data-workflow-id={group.workflow.workflow_id}>
              <AppLink href={workflowPathname(projectId, group.workflow.workflow_id)} onNavigate={onNavigate}
                className={`projects-card lists-group-head ui-card ${toneClass(tone)}`}>
                <span className="dispatch-feature-id">{group.workflow.workflow_id}</span>
                <span className="dispatch-muted">
                  {error || group.runsRead === 'failed'
                    ? 'cannot be read'
                    : group.runsRead === 'loading'
                      ? 'reading runs…'
                      : filtering && group.runs.length === 0 && group.total > 0
                      ? `0 of ${group.total} runs match`
                      : `${group.runs.length} ${group.runs.length === 1 ? 'run' : 'runs'}`}
                  {landed.length > 0 && <> · landed {landed.map(sha => <code key={sha}>{sha.slice(0, 7)}</code>)}</>}
                  {/* "nothing landed" only when every run's steps were read: a pending or failed read leaves it unknown (M1). */}
                  {!error && group.runsRead === 'read' && landed.length === 0 && group.runs.length > 0 && landingKnown(group.runs, stepsRead) && ' · nothing landed'}
                </span>
                {group.runs.length > 1 && (
                  <span className="dispatch-chain" aria-label="Runs oldest first">
                    {[...group.runs].reverse().map(entry => (
                      <span key={entry.run.run_id} className={`dispatch-chip-run tone-${runTone(entry)}`}>
                        <StateGlyph tone={runTone(entry)} />
                        <span className="dispatch-mono">{num(entry.run.run_id)}</span>
                        {entry.steps?.integrated_commit && <code>{entry.steps.integrated_commit.slice(0, 7)}</code>}
                      </span>
                    ))}
                  </span>
                )}
              </AppLink>
              {error
                ? (
                  <div className="dispatch-badrows">
                    <p className="dispatch-badrow" role="alert">
                      <span className="dispatch-word">cannot be read</span> {error.message}
                      {' · '}<code>python -m workflow status &lt;run-id&gt; --by operator</code>
                    </p>
                  </div>
                )
                : (
                  <>
                    <div className="dispatch-runs">
                      {group.runs.map(entry => (
                        <ChartRow key={entry.run.run_id} entry={entry} landing={group.landings.get(entry.run.run_id) ?? null} defaultBranch={defaultBranch} stepsRead={stepsRead}
                          selected={selectedRunId === entry.run.run_id} onSelect={onSelect} />
                      ))}
                      {(group.steps?.errors ?? []).map(err => (
                        <p key={err.run_id} className="dispatch-badrow" role="alert">
                          <span className="dispatch-word">cannot be read</span> {err.message}
                          {' · '}<code>python -m workflow status {err.run_id} --by operator</code>
                        </p>
                      ))}
                    </div>
                    {total > 0 && (
                      <div className="dispatch-ends" data-testid="dispatch-ends">
                        <span className="dispatch-ends-l">ended here</span>
                        <span className="dispatch-ends-track" style={{ gridTemplateColumns: CHART_COLUMNS }}>
                          {counts.map((n, i) => <span key={i} className={`dispatch-en ${i === 7 ? 'land' : ''}`}>{n > 0 ? `${n}${i === 7 ? ' landed' : ''}` : ''}</span>)}
                        </span>
                      </div>
                    )}
                  </>
                )}
              {/* The "Steps of this definition" fold reads the current definition (`workflow.nodes`), which is held whether or
                  not the runs could be listed, so every feature group exposes it — an unreadable workflow included (V7, [P30]). */}
              <DefinitionFold workflow={group.workflow} />
              {/* keep the run links discoverable for keyboard and deep-linking without leaving the pane */}
              {group.runs.map(entry => (
                <a key={`link-${entry.run.run_id}`} className="visually-hidden" href={runPathname(projectId, group.workflow.workflow_id, entry.run.run_id)}
                  onClick={e => { e.preventDefault(); onSelect(entry.run.run_id) }}>Open {entry.run.run_id}</a>
              ))}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
