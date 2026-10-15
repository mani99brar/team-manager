/**
 * The per-project run state the Projects page, the rail and the project header read, derived from the existing registry run
 * lists (`fetchRegistryRuns`) joined with the dispatch overview's git and GitHub. The run logic (what waits, what runs, the
 * project tone) reuses `lists.ts` so the dispatch pages and Runs home read state the same way.
 */
import type { ProjectRuns, RunSummary } from '../api.ts'
import { classifyRuns, classOf, compareCreated, compareLive, endedAt, isFinished, movedAt, type RunClasses } from '../lists.ts'
import { stateTone, type Tone } from '../tone.ts'

const ms = (iso: string) => Date.parse(iso)

/** The latest run of a workflow's runs, by last activity. */
export function latestRunOf(runs: readonly RunSummary[]): RunSummary | null {
  return runs.reduce<RunSummary | null>((latest, run) => (latest === null || ms(movedAt(run)) > ms(movedAt(latest)) ? run : latest), null)
}

/**
 * A run's tone in a classified list: warn while it needs the operator, else its status's own tone (a superseded run that is
 * served with a question is paused, never warn).
 */
export function runTone(run: RunSummary, classes: RunClasses): Tone {
  return classOf(classes, run).needs !== null ? 'warn' : stateTone({ status: run.status, accepted: run.accepted })
}

/** A feature's latest result tone: the latest run's tone in the classified list, or idle without runs. */
export function featureTone(runs: readonly RunSummary[], classes: RunClasses = classifyRuns(runs)): Tone {
  const latest = latestRunOf(runs)
  return latest ? runTone(latest, classes) : 'idle'
}

export type ProjectRunInfo = {
  /** Whether the registry run read has settled for this project: `loading` until it has, `failed` when nothing could be read. */
  state: 'loading' | 'failed' | 'read'
  /** Runs that need the operator: a question, a pane, an approval, a decision at the design challenge, an interrupted latest run. */
  waits: number
  /** Paused runs that need nobody and that no later run of their own workflow superseded. */
  paused: number
  /** Running runs that need nobody. */
  running: number
  /** The project's run state cannot be read at all (no workflow reads). */
  allBad: boolean
  /** How many workflows (features) could not be read. */
  badFeatures: number
  /** The newest run's last activity in epoch ms, 0 without runs. */
  lastActivity: number
  tone: Tone
  /** Every workflow the project has, readable or not (the "N features" line and the rail sub-line). */
  features: number
  /** Only the workflows whose runs could be read, for the state word "N of M features <result> last" ([L8]). */
  readableFeatures: number
  counts: { succeeded: number; failed: number; cancelled: number }
  runCount: number
  latestRun: RunSummary | null
  /** How many features share the project's worst latest tone (for "N of M features <result> last"). */
  worstLatestCount: number
}

const EMPTY: Omit<ProjectRunInfo, 'state' | 'allBad'> = {
  waits: 0, paused: 0, running: 0, badFeatures: 0, lastActivity: 0, tone: 'idle', features: 0, readableFeatures: 0,
  counts: { succeeded: 0, failed: 0, cancelled: 0 }, runCount: 0, latestRun: null, worstLatestCount: 0,
}

/** A project whose run read failed as a whole (the registry request itself): `failed`, so it says "cannot be read". */
export const FAILED_RUN_INFO: ProjectRunInfo = { ...EMPTY, state: 'failed', allBad: true }

/**
 * The run state of one project from its registry runs. Null is a read that has not settled (`loading`: nothing is claimed,
 * neither failed nor empty); a project whose read failed, or whose every workflow's run list failed, is `failed` (`allBad`).
 * Every count reads the project's one classification (`classifyRuns`), so a run needing the operator counts once, as a wait.
 */
export function projectRunInfo(entry: ProjectRuns | null): ProjectRunInfo {
  if (entry === null) return { ...EMPTY, state: 'loading', allBad: false }
  if (entry.error !== null) return { ...EMPTY, state: 'failed', allBad: true }
  const workflows = entry.workflows
  const runs = workflows.flatMap(w => (w.error === null ? w.runs : []))
  const readable = workflows.filter(w => w.error === null)
  const allBad = workflows.length > 0 && readable.length === 0
  const badFeatures = workflows.filter(w => w.error !== null).length
  const classes = classifyRuns(runs)
  const cls = (run: RunSummary) => classOf(classes, run)
  const waits = runs.filter(run => cls(run).needs !== null).length
  const paused = runs.filter(run => run.status === 'paused' && cls(run).needs === null && cls(run).supersededBy === null).length
  const running = runs.filter(run => run.status === 'running' && cls(run).needs === null).length
  const finished = runs.filter(run => isFinished(run))
  const counts = {
    succeeded: finished.filter(run => !run.accepted && run.status === 'succeeded').length,
    failed: finished.filter(run => run.status === 'failed').length,
    cancelled: finished.filter(run => run.status === 'cancelled').length,
  }
  const lastActivity = runs.reduce((max, run) => Math.max(max, ms(isFinished(run) ? endedAt(run) : movedAt(run))), 0)
  // The project's state word is the worst latest result across its features (the mock-up's `projInfo`): waiting and running win,
  // then the worst per-feature latest tone. `projectTone` (a single latest run) would hide a failed feature behind a newer success.
  // A live paused run sets the pause tone when nothing waits or runs, whatever result a newer run of another feature had.
  const featureTones = readable.map(w => featureTone(w.runs, classes))
  const order: Tone[] = ['fail', 'pause', 'override', 'ok', 'idle']
  const tone: Tone = waits > 0 ? 'warn' : running > 0 ? 'run' : paused > 0 ? 'pause' : order.find(candidate => featureTones.includes(candidate)) ?? 'idle'
  const latestRun = latestRunOf(runs)
  const worstLatestCount = featureTones.filter(candidate => candidate === tone).length
  return { state: allBad ? 'failed' : 'read', waits, paused, running, allBad, badFeatures, lastActivity, tone, features: workflows.length, readableFeatures: readable.length, counts, runCount: runs.length, latestRun, worstLatestCount }
}

/**
 * The project page's features in a sort: by default the feature with the most urgent run first (needs the operator, running,
 * paused, none), then the latest activity, then `workflow_id`; under "newest" / "oldest" by last activity descending /
 * ascending, ties by `workflow_id`. A feature with no read run comes after the rest under every sort, by `workflow_id`.
 */
export function orderFeatures<T extends { workflow: { workflow_id: string }; rank: number; lastActivity: number | null }>(groups: readonly T[], sort: 'live' | 'newest' | 'oldest'): T[] {
  return [...groups].sort((a, b) => {
    if ((a.lastActivity === null) !== (b.lastActivity === null)) return a.lastActivity === null ? 1 : -1
    const byId = a.workflow.workflow_id.localeCompare(b.workflow.workflow_id)
    if (a.lastActivity === null || b.lastActivity === null) return byId
    if (sort === 'live') return a.rank - b.rank || b.lastActivity - a.lastActivity || byId
    return (sort === 'newest' ? b.lastActivity - a.lastActivity : a.lastActivity - b.lastActivity) || byId
  })
}

/** An open feature's run rows in a sort: the list order by default, else by `created_at` in the features' direction. */
export function orderFeatureRuns<T extends { run: RunSummary }>(runs: readonly T[], sort: 'live' | 'newest' | 'oldest', classes: RunClasses): T[] {
  const compare = sort === 'live' ? compareLive(classes) : compareCreated(sort === 'newest' ? 'desc' : 'asc')
  return [...runs].sort((a, b) => compare(a.run, b.run))
}

/**
 * Whether a feature is open: the operator's own toggle when given; else, while the bar filters, a feature with a match (an
 * unreadable one stays open with its read error, never "0 of 0"); else a feature with a run that needs the operator or is
 * running, or one that cannot be read.
 */
export function featureOpen(group: { rank: number; unreadable: boolean; matches: number }, filtering: boolean, own: boolean | undefined): boolean {
  if (own !== undefined) return own
  if (group.unreadable) return true
  if (filtering) return group.matches > 0
  return group.rank <= 1
}
