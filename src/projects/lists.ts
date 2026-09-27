/**
 * The run lists' rules (docs/PRD_VIEWER_UX.md 4.1, 6.3 and 6.4), without React so the unit tests import them: the workflow
 * title rule, how Runs home sorts rows into Needs you, Running and Recent, what a row says, the controller suffix of the
 * live chip with its 15 s debounce, and when the Now banner reads the served `activity` over the export.
 *
 * Every row renders from the run summary alone (B2 `activity`); no run detail is fetched for a row. A summary without
 * `activity` (a server before contract 1.5.0) says only its status and when it was updated: no finish, no duration and no
 * Needs-you grouping.
 */
import {
  controllerNotRunning, deriveNow, type ControllerReading, type ControllerState, type Now, type Situation,
} from '../../contracts/projects/triage.ts'
import type { RunActivity, RunDetail, RunSummary } from './api.ts'
import { GENERIC_WORKFLOW_NAME, STATUS_LABEL, type RunStatus } from './status.ts'

/** Recent lists every run that finished in the last seven days (decisions.md). */
export const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** Runs home and the project page re-read their run lists this often. */
export const LISTS_POLL_MS = 15_000
/** How many controller readings a run page keeps; the debounce needs only the latest run of equal values. */
const READINGS_KEPT = 50

const FINISHED: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled']
/** The attention kinds that wait on the operator (6.4); `interrupted`, `paused` and `failed` are the run's own state. */
export const WAITING_KINDS = ['question', 'pane', 'approval'] as const
export type WaitingKind = (typeof WAITING_KINDS)[number]

export const isFinished = (status: RunStatus) => FINISHED.includes(status)
const ms = (iso: string) => Date.parse(iso)

// ---- The workflow title rule (4.1, reordered in decisions.md) -------------------------------------------------------

/**
 * A workflow's title in cards, headings and crumbs: a workflow under the exporter's generic name ("Feature implementation")
 * is named by its latest run's feature, else by its id; any other name is the title. The fixture names are not generic,
 * so every existing title stays as it was.
 */
export function workflowTitle(workflow: { workflow_id: string; name: string }, latestFeature: string | null = null): string {
  if (workflow.name !== GENERIC_WORKFLOW_NAME) return workflow.name
  return latestFeature ?? workflow.workflow_id
}

/** The run a workflow's title reads its feature from: the one updated last (lists are sorted that way, but pages are merged). */
export function latestRun<T extends Pick<RunSummary, 'updated_at' | 'run_id'>>(runs: readonly T[]): T | null {
  return runs.reduce<T | null>((latest, run) => (latest === null || ms(run.updated_at) > ms(latest.updated_at) ? run : latest), null)
}

export const latestFeature = (runs: readonly RunSummary[]) => latestRun(runs)?.activity?.feature ?? null

// ---- Runs home sections (4.1) -----------------------------------------------------------------------------------------

/** The kind a run waits on the operator for, from the served activity only; null without activity. */
export function waitingKind(run: Pick<RunSummary, 'status' | 'activity'>): WaitingKind | null {
  const kind = run.activity?.attention?.kind
  if (!kind || isFinished(run.status)) return null
  return (WAITING_KINDS as readonly string[]).includes(kind) ? kind as WaitingKind : null
}

/** When a finished run ended, for the Recent window and its order: the served finish, else (without activity) its last update. */
export const endedAt = (run: Pick<RunSummary, 'updated_at' | 'activity'>) => run.activity?.finished_at ?? run.updated_at
/** When a run last moved, for ordering live rows: the served last activity, else its last update. */
export const movedAt = (run: Pick<RunSummary, 'updated_at' | 'activity'>) => run.activity?.last_activity_at ?? run.updated_at

export type HomeSections<T> = { needsYou: T[]; running: T[]; recent: T[] }

/**
 * Sorts rows into the three sections of Runs home; a run appears in one section only. Needs you: a question, a pane or an
 * approval waits (served `activity.attention.kind`), longest waiting first. Running: every other run that is not finished,
 * latest activity first. Recent: finished runs that ended within the seven days before `now`, newest first; older ones
 * stay on their project page only.
 */
export function homeSections<T extends { run: RunSummary }>(rows: readonly T[], now: number): HomeSections<T> {
  const needsYou: T[] = []
  const running: T[] = []
  const recent: T[] = []
  for (const row of rows) {
    if (waitingKind(row.run) !== null) needsYou.push(row)
    else if (!isFinished(row.run.status)) running.push(row)
    else if (ms(endedAt(row.run)) >= now - RECENT_WINDOW_MS) recent.push(row)
  }
  const since = (row: T) => ms(row.run.activity?.attention?.since ?? movedAt(row.run))
  needsYou.sort((a, b) => since(a) - since(b) || a.run.run_id.localeCompare(b.run.run_id))
  running.sort((a, b) => ms(movedAt(b.run)) - ms(movedAt(a.run)) || a.run.run_id.localeCompare(b.run.run_id))
  recent.sort((a, b) => ms(endedAt(b.run)) - ms(endedAt(a.run)) || a.run.run_id.localeCompare(b.run.run_id))
  return { needsYou, running, recent }
}

/** Whether Runs home reads the next page of a workflow's runs: pages are newest first, so it stops at the Recent cutoff. */
export function readsNextPage(runs: readonly Pick<RunSummary, 'updated_at'>[], nextCursor: string | null, cutoff: number): boolean {
  const last = runs.at(-1)
  return nextCursor !== null && last !== undefined && ms(last.updated_at) >= cutoff
}

// ---- Row wording (4.1, 6.4) --------------------------------------------------------------------------------------------

/** The lane a launch node belongs to (`launch_<lane>`), else the node id itself (a reviewer's `review`). */
function who(nodeId: string | null): string {
  if (nodeId === null) return 'a step'
  return nodeId.startsWith('launch_') ? nodeId.slice('launch_'.length) : nodeId
}

/**
 * A row's second line: what waits on the operator for a Needs-you row, else the status at the focus step with its last
 * message (the served headline, which starts with the focus label). Without activity it is only the status; the row then
 * shows when the run was updated and nothing else.
 */
export function rowSummary(run: Pick<RunSummary, 'status' | 'activity'>, labels: ReadonlyMap<string, string> = new Map()): string {
  const status = STATUS_LABEL[run.status]
  const activity = run.activity
  if (!activity) return status
  const kind = waitingKind(run)
  const node = activity.attention?.node_id ?? null
  if (kind === 'question') return `${who(node)} asked a question · deadline paused`
  if (kind === 'pane') return `${who(node)} needs attention in its pane`
  if (kind === 'approval') return `${node === null ? 'A step' : labels.get(node) ?? node} awaits your decision`
  const { focus, headline } = activity
  if (focus && (run.status === 'failed' || run.status === 'paused' || run.status === 'cancelled')) {
    const at = headline && headline.startsWith(focus.label) ? headline : headline ? `${focus.label} · ${headline}` : focus.label
    return `${status} at ${at}`
  }
  return headline ? `${status} · ${headline}` : status
}

/** A row's time: a finished run's end and its duration, a live run's start and its elapsed time, or (without activity) only its last update. */
export type RowTime =
  | { kind: 'finished'; at: string; ms: number }
  | { kind: 'live'; started: string; last: string | null; ms: number }
  | { kind: 'updated'; at: string }

export function rowTime(run: Pick<RunSummary, 'status' | 'created_at' | 'updated_at' | 'activity'>, now: number): RowTime {
  const activity = run.activity
  if (!activity) return { kind: 'updated', at: run.updated_at }
  if (activity.finished_at !== null) return { kind: 'finished', at: activity.finished_at, ms: Math.max(0, ms(activity.finished_at) - ms(run.created_at)) }
  if (isFinished(run.status)) return { kind: 'updated', at: run.updated_at }
  return { kind: 'live', started: run.created_at, last: activity.last_activity_at, ms: Math.max(0, now - ms(run.created_at)) }
}

/** A project card's secondary text: how many features it registers and when its latest run last moved. */
export function projectFacts(workflows: number, runs: readonly Pick<RunSummary, 'updated_at' | 'activity'>[]): { features: string; lastRun: string | null } {
  const last = runs.reduce<string | null>((latest, run) => (latest === null || ms(movedAt(run)) > ms(latest) ? movedAt(run) : latest), null)
  return { features: `${workflows} ${workflows === 1 ? 'feature' : 'features'}`, lastRun: last }
}

// ---- Controller liveness (6.3) -----------------------------------------------------------------------------------------

/** Adds one poll's `activity.controller` reading; the list stays short, and an older reading never follows a newer one. */
export function recordReading(readings: readonly ControllerReading[], reading: ControllerReading): ControllerReading[] {
  const last = readings.at(-1)
  if (last && ms(last.at) > ms(reading.at)) return [reading]
  return [...readings, reading].slice(-READINGS_KEPT)
}

export type ControllerSuffix = 'running' | 'not_running' | null

/**
 * The live chip's controller suffix, shown only while the run is running or paused: `running` as soon as it is served;
 * `not_running` only once the readings have said so for 15 s, since one reading can be a checkpoint hand-over; nothing
 * for `unknown`, null or no reading, because the viewer never claims liveness it cannot check.
 */
export function controllerSuffix(status: RunStatus, readings: readonly ControllerReading[]): ControllerSuffix {
  if (status !== 'running' && status !== 'paused') return null
  const latest: ControllerState = readings.at(-1)?.value ?? null
  if (latest === 'running') return 'running'
  if (latest === 'not_running' && controllerNotRunning(readings)) return 'not_running'
  return null
}

// ---- The Now banner and the served activity (6.2, 6.4) -----------------------------------------------------------------

/** What the run page knows beyond its export: the served activity, the run directory and the controller readings. */
export type ServedRun = { detail: RunDetail; activity: RunActivity | null; runDir: string | null; controller: readonly ControllerReading[] }

/** Situations that come before rule 5 (c): a stopped controller never hides a question, a pane, an approval or a paused challenge. */
const BEFORE_INTERRUPTED: readonly Situation[] = ['question', 'pane_attention', 'awaiting_approval', 'challenge_paused', 'interrupted']

/**
 * Why the export-derived Now disagrees with what the server reads live, or null when it does not:
 * - `question-answered`: the export still shows a waiting question that the lane's live `<lane>.questions.json` records as
 *   answered (served `waiting_questions` is 0);
 * - `question-asked`: the live record holds a waiting question the export does not show (C5: the export is not rewritten
 *   while the handoff waits);
 * - `controller-stopped`: the controller has read `not_running` for 15 s while the run is running (rule 5 case c).
 */
export function servedDisagreement(now: Now, served: ServedRun): 'question-answered' | 'question-asked' | 'controller-stopped' | null {
  const { activity } = served
  const status = served.detail.summary.status
  if (activity && !isFinished(status)) {
    const asked = activity.waiting_questions > 0 && activity.attention?.kind === 'question'
    if (now.situation === 'question' && !asked) return 'question-answered'
    const lane = activity.attention?.node_id ? who(activity.attention.node_id) : null
    if (asked && (now.situation !== 'question' || (lane !== null && now.lane !== lane))) return 'question-asked'
  }
  if (status === 'running' && controllerNotRunning(served.controller) && !BEFORE_INTERRUPTED.includes(now.situation)) return 'controller-stopped'
  return null
}

/**
 * The Now banner's model once the served activity is read: the export's own when both agree, else the situation derived
 * from the served fields alone (the run's snapshot, `activity` and the controller readings). That derivation has no events,
 * so it names the served question, pane or stopped controller without the reason the export would add.
 */
export function servedNow(now: Now, served: ServedRun | null): Now {
  if (served === null || servedDisagreement(now, served) === null) return now
  return deriveNow({ detail: served.detail, events: [], inputs: null, activity: served.activity, controller: served.controller })
}
