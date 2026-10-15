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
import { dayKey, monthDay } from '../lists.ts'
import { runPathname, workflowPathname } from '../routes.ts'
import type { Zone } from '../time.ts'
import { AppLink } from '../panels.tsx'
import { OVERRIDE_LABEL, STATUS_LABEL } from '../status.ts'
import { stateTone, toneClass, type Tone } from '../tone.ts'
import { CHART_COLUMNS, endedText, PHASE_SHORT, PHASES, phaseLegend, phaseOf } from './phases.ts'
import { endedCounts, landingKnown, noStopWording, runStepsRead, runWhen, stopOf, type ChartRun, type StepsReadState } from './stops.ts'
import { landingWording } from './derive.ts'
import { StateGlyph } from './common.tsx'
import type { Landing, ProjectStepsRun, ProjectStepsWorkflow } from './types.ts'

/** A run chip in a feature's header is the run's number, with the whole id in its title (the run rows name the whole id). */
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

function ChartRow({ entry, landing, defaultBranch, stepsRead, selected, onSelect, now, zone }: {
  entry: ChartRun; landing: Landing | null; defaultBranch: string | null; stepsRead: StepsReadState
  selected: boolean; onSelect: (runId: string) => void; now: number; zone: Zone
}) {
  const tone = runTone(entry)
  const word = runWord(entry)
  const stop = stopOf(entry)
  const stopStep = stop === null ? undefined : entry.steps?.steps[stop.index]
  // Without its recorded steps a row names only the served focus step, never a guessed stop.
  const stopLabel = stopStep?.label ?? (stop === null ? entry.run.activity?.focus?.label ?? null : 'launch')
  const repairs = (entry.steps?.steps ?? []).filter(s => /^repair-/.test(s.node_id)).length
  const integrated = entry.steps?.integrated_commit ?? null
  // A row with no stop to name says whether its steps are still loading, failed to read, or hold nothing for it.
  const noStop = noStopWording(runStepsRead(entry, stepsRead))
  return (
    <button type="button" className={`dispatch-run tone-${tone}`} data-run-id={entry.run.run_id} aria-selected={selected} aria-pressed={selected}
      aria-label={`${entry.run.run_id}, ${word}. ${entry.run.status === 'succeeded' ? 'Reached Integrate.' : stopLabel === null ? noStop.aria : `Stopped at ${stopLabel}.`}`}
      onClick={() => onSelect(entry.run.run_id)}>
      <span className="dispatch-run-1">
        <StateGlyph tone={tone} live={tone === 'run'} />
        <span className="dispatch-run-id">{entry.run.run_id}</span>
        <span className="dispatch-word">{word}</span>
        {repairs > 0 && <span className="dispatch-tag">{repairs} {repairs === 1 ? 'repair' : 'repairs'}</span>}
        <span className="dispatch-run-when" data-testid="dispatch-run-when">{runWhen(entry, now, zone)}</span>
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
 * The "Steps of this definition" folds (PRD 4.3, V7), once per distinct definition revision above the chart: the current
 * definition's steps (label and phase) read from the definitions the page holds (`workflow.nodes`), naming how many features
 * use it, so every feature's steps stay reachable (an unreadable one's included, [P30]); the run tracks keep their own
 * recorded steps.
 */
export function DefinitionFolds({ workflows, order }: { workflows: readonly WorkflowDefinition[]; order?: string }) {
  const revisions = new Map<string, WorkflowDefinition[]>()
  for (const workflow of workflows) revisions.set(workflow.definition_revision, [...(revisions.get(workflow.definition_revision) ?? []), workflow])
  return (
    <div className="dispatch-defs" data-testid="dispatch-defs">
      {order && <p className="dispatch-muted dispatch-order" data-testid="project-features-sub">{order}</p>}
      {[...revisions.entries()].map(([revision, users]) => (
        <details key={revision} className="dispatch-def" data-testid="dispatch-def" data-revision={revision}>
          <summary>Steps of this definition <span className="dispatch-muted">{users[0].nodes.length} steps · {users.slice(0, 3).map(user => user.workflow_id).join(', ')}{users.length > 3 ? ` and ${users.length - 3} more` : ''}</span></summary>
          <p className="dispatch-muted dispatch-def-users">{users.map(user => user.workflow_id).join(', ')}</p>
          <ol className="dispatch-def-list">
            {users[0].nodes.map(node => (
              <li key={node.node_id} data-node-id={node.node_id}>
                <span className="dispatch-def-phase">{PHASES[phaseOf(node.node_id, node.kind)]}</span>
                <span className="dispatch-def-label">{node.label}</span>
              </li>
            ))}
          </ol>
        </details>
      ))}
    </div>
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
  /** The most urgent group among its runs (0 needs the operator, 1 running, 2 paused, 3 none), for the list order. */
  rank: number
  /** The latest last activity among its read runs, in epoch ms; null without a read run. */
  lastActivity: number | null
  /** Whether the feature has more runs than the page read (its first page only). */
  more: boolean
}

type Props = {
  projectId: string
  defaultBranch: string | null
  groups: readonly FeatureGroup[]
  /** Whether the project's run filter is active, so a group filtered to nothing says "0 of N runs match" (V30). */
  filtering: boolean
  /** The project's steps read, so a run row without a stop says "reading steps…" while it loads, never "not read". */
  stepsRead: StepsReadState
  selectedRunId: string | null
  onSelect: (runId: string) => void
  onNavigate: (pathname: string) => void
  /** Whether a feature's runs show (its "Show runs" disclosure), and its toggle. */
  isOpen: (group: FeatureGroup) => boolean
  onToggle: (group: FeatureGroup) => void
  /** The page's list clock and zone, for the dated rows. */
  now: number
  zone: Zone
  /** The features' order in words, shown above the definition folds. */
  order?: string
}

/** A feature's state word on its header: what its most urgent run is, else its latest run's outcome. */
function stateWord(group: FeatureGroup): string | null {
  if (group.runsRead !== 'read' || group.steps?.error) return null
  if (group.rank === 0) return 'needs you'
  if (group.rank === 1) return 'running'
  if (group.rank === 2) return 'paused'
  const latest = group.runs.reduce<ChartRun | null>((best, entry) => (best === null || Date.parse(entry.run.updated_at) > Date.parse(best.run.updated_at) ? entry : best), null)
  return latest === null ? 'no runs' : runWord(latest).toLowerCase()
}

export function StepChart({ projectId, defaultBranch, groups, filtering, stepsRead, selectedRunId, onSelect, onNavigate, isOpen, onToggle, now, zone, order }: Props) {
  return (
    <div className="dispatch-chart" data-testid="dispatch-chart">
      <DefinitionFolds workflows={groups.map(group => group.workflow)} order={order} />
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
          const open = isOpen(group)
          const word = stateWord(group)
          const bodyId = `dispatch-feature-runs-${group.workflow.workflow_id}`
          return (
            <li key={group.workflow.workflow_id} className={`lists-group dispatch-feature${open ? ' is-open' : ''}`} data-workflow-id={group.workflow.workflow_id} data-open={open ? 'true' : 'false'}>
              <div className="dispatch-feature-row">
              <AppLink href={workflowPathname(projectId, group.workflow.workflow_id)} onNavigate={onNavigate}
                className={`projects-card lists-group-head ui-card ${toneClass(tone)}`}>
                <span className="dispatch-feature-id">{group.workflow.workflow_id}</span>
                {word !== null && <span className="dispatch-feature-word" data-testid="dispatch-feature-word">{word}</span>}
                <span className="dispatch-muted">
                  {error || group.runsRead === 'failed'
                    ? 'cannot be read'
                    : group.runsRead === 'loading'
                      ? 'reading runs…'
                      : filtering && group.runs.length === 0 && group.total > 0
                      ? `0 of ${group.total} runs match`
                      : `${group.runs.length} ${group.runs.length === 1 ? 'run' : 'runs'}`}
                  {landed.length > 0 && <> · landed <span className="dispatch-landed">{[...new Set(landed)].map(sha => <code key={sha}>{sha.slice(0, 7)}</code>)}</span></>}
                  {/* "nothing landed" only when every run's steps were read: a pending or failed read leaves it unknown. */}
                  {!error && group.runsRead === 'read' && landed.length === 0 && group.runs.length > 0 && landingKnown(group.runs, stepsRead) && ' · nothing landed'}
                </span>
                {group.runs.length > 1 && (
                  <span className="dispatch-chain" aria-label="Runs oldest first">
                    {[...group.runs].sort((a, b) => Date.parse(a.run.created_at) - Date.parse(b.run.created_at) || a.run.run_id.localeCompare(b.run.run_id)).map(entry => (
                      <span key={entry.run.run_id} className={`dispatch-chip-run tone-${runTone(entry)}`} title={entry.run.run_id}>
                        <StateGlyph tone={runTone(entry)} />
                        <span className="dispatch-mono">{num(entry.run.run_id)}</span>
                        {entry.steps?.integrated_commit && <code>{entry.steps.integrated_commit.slice(0, 7)}</code>}
                      </span>
                    ))}
                  </span>
                )}
                {group.lastActivity !== null && (
                  <span className="dispatch-feature-last" data-testid="dispatch-feature-last">
                    last activity {dayKey(group.lastActivity, zone) === dayKey(now, zone) ? 'today' : monthDay(new Date(group.lastActivity).toISOString(), now, zone)}
                  </span>
                )}
              </AppLink>
              <button type="button" className="dispatch-feature-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => onToggle(group)} data-testid="dispatch-feature-toggle">
                {open ? 'Hide runs' : 'Show runs'}
              </button>
              </div>
              {open && <div id={bodyId} className="dispatch-feature-body">
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
                          selected={selectedRunId === entry.run.run_id} onSelect={onSelect} now={now} zone={zone} />
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
                          {counts.map((n, i) => n > 0
                            ? (
                              <span key={i} className={`dispatch-en ${i === 7 ? 'land' : ''}`} aria-label={endedText(n, i)} title={endedText(n, i)}>
                                <span className="dispatch-en-full" aria-hidden="true">{endedText(n, i)}</span>
                                <span className="dispatch-en-count" aria-hidden="true">{n}</span>
                                <span className="visually-hidden">{endedText(n, i)}</span>
                              </span>
                            )
                            : <span key={i} className="dispatch-en" />)}
                        </span>
                      </div>
                    )}
                  </>
                )}
              {/* keep the run links discoverable for keyboard and deep-linking without leaving the pane */}
              {group.runs.map(entry => (
                <a key={`link-${entry.run.run_id}`} className="visually-hidden" href={runPathname(projectId, group.workflow.workflow_id, entry.run.run_id)}
                  onClick={e => { e.preventDefault(); onSelect(entry.run.run_id) }}>Open {entry.run.run_id}</a>
              ))}
              </div>}
            </li>
          )
        })}
      </ul>
      {/* Shown only where the axis uses its short forms (a narrow container): every short form with its full name. */}
      <p className="dispatch-legend" data-testid="dispatch-axis-legend">
        {phaseLegend().map(({ phase, short }) => <span key={phase} className="dispatch-legend-item"><b>{short}</b> {phase}</span>)}
      </p>
    </div>
  )
}
