/**
 * The per-project run state the Projects page, the rail and the project header read, derived from the existing registry run
 * lists (`fetchRegistryRuns`) joined with the dispatch overview's git and GitHub. The run logic (what waits, what runs, the
 * project tone) reuses `lists.ts` so the dispatch pages and Runs home read state the same way.
 */
import type { ProjectRuns, RunSummary } from '../api.ts'
import { endedAt, isFinished, movedAt, waitingKind } from '../lists.ts'
import { stateTone, type Tone } from '../tone.ts'

const ms = (iso: string) => Date.parse(iso)

/** The latest run of a workflow's runs, by last activity. */
export function latestRunOf(runs: readonly RunSummary[]): RunSummary | null {
  return runs.reduce<RunSummary | null>((latest, run) => (latest === null || ms(movedAt(run)) > ms(movedAt(latest)) ? run : latest), null)
}

/** A feature's latest result tone: the latest run's state tone, or idle without runs. */
function featureTone(runs: readonly RunSummary[]): Tone {
  const latest = latestRunOf(runs)
  return latest ? stateTone({ status: latest.status, attention: latest.activity?.attention?.kind ?? null, accepted: latest.accepted }) : 'idle'
}

export type ProjectRunInfo = {
  /** Runs waiting on the operator (question, pane, approval). */
  waits: number
  /** Paused runs waiting on nobody. */
  paused: number
  /** Running runs. */
  running: number
  /** The project's run state cannot be read at all (no workflow reads). */
  allBad: boolean
  /** How many workflows (features) could not be read. */
  badFeatures: number
  /** The newest run's last activity in epoch ms, 0 without runs. */
  lastActivity: number
  tone: Tone
  features: number
  counts: { succeeded: number; failed: number; cancelled: number }
  runCount: number
  latestRun: RunSummary | null
  /** How many features share the project's worst latest tone (for "N of M features <result> last"). */
  worstLatestCount: number
}

const EMPTY: ProjectRunInfo = {
  waits: 0, paused: 0, running: 0, allBad: true, badFeatures: 0, lastActivity: 0, tone: 'idle', features: 0,
  counts: { succeeded: 0, failed: 0, cancelled: 0 }, runCount: 0, latestRun: null, worstLatestCount: 0,
}

/** The run state of one project from its registry runs; a project whose runs could not be read is `allBad`. */
export function projectRunInfo(entry: ProjectRuns | null): ProjectRunInfo {
  if (entry === null || entry.error !== null) return EMPTY
  const workflows = entry.workflows
  const runs = workflows.flatMap(w => (w.error === null ? w.runs : []))
  const readable = workflows.filter(w => w.error === null)
  const allBad = workflows.length > 0 && readable.length === 0
  const badFeatures = workflows.filter(w => w.error !== null).length
  const waits = runs.filter(run => waitingKind(run) !== null).length
  const paused = runs.filter(run => run.status === 'paused' && waitingKind(run) === null).length
  const running = runs.filter(run => run.status === 'running' && waitingKind(run) === null).length
  const finished = runs.filter(run => isFinished(run))
  const counts = {
    succeeded: finished.filter(run => !run.accepted && run.status === 'succeeded').length,
    failed: finished.filter(run => run.status === 'failed').length,
    cancelled: finished.filter(run => run.status === 'cancelled').length,
  }
  const lastActivity = runs.reduce((max, run) => Math.max(max, ms(isFinished(run) ? endedAt(run) : movedAt(run))), 0)
  // The project's state word is the worst latest result across its features (the mock-up's `projInfo`): waiting and running win,
  // then the worst per-feature latest tone. `projectTone` (a single latest run) would hide a failed feature behind a newer success.
  const featureTones = readable.map(w => featureTone(w.runs))
  const order: Tone[] = ['fail', 'pause', 'override', 'ok', 'idle']
  const tone: Tone = waits > 0 ? 'warn' : running > 0 ? 'run' : order.find(candidate => featureTones.includes(candidate)) ?? 'idle'
  const latestRun = latestRunOf(runs)
  const worstLatestCount = featureTones.filter(candidate => candidate === tone).length
  return { waits, paused, running, allBad, badFeatures, lastActivity, tone, features: workflows.length, counts, runCount: runs.length, latestRun, worstLatestCount }
}
