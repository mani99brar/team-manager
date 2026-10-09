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
import { ATTACK_NODE_ID, GENERIC_WORKFLOW_NAME, SIDECAR_NODE_ID, STATUS_LABEL, type RunStatus } from './status.ts'
import { formatSpan, type Zone } from './time.ts'
import { statusTone, type Tone } from './tone.ts'

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

export type HomeSections<T> = { needsYou: T[]; today: T[]; running: T[]; paused: T[]; recent: T[] }

/**
 * Sorts rows into the four sections of Runs home (PRD_VIEWER_REFINE 5.7); a run appears in one section only. Needs you: a
 * question, a pane or an approval waits (served `activity.attention.kind`), longest waiting first — whatever its status.
 * Paused: a `paused` run that waits on nobody, oldest first (longest-stopped at the top), by its attention `since`, else
 * its last activity. Running: every other run that is not finished, latest activity first. Recent: finished runs that ended
 * within the seven days before `now`, newest first; older ones stay on their project page only.
 */
/**
 * Runs home's sections (docs/PRD_VIEWER_REVAMP.md 5.1, Today first since 2026-10-09): what waits on the operator; every run
 * that moved today (running ones first, then latest activity first), whatever its status; the runs still running since an
 * earlier day; the runs paused since an earlier day, longest paused first; and the runs finished in the last seven days
 * before today. A run sits in exactly one section. `zone` decides where today begins; without it, today is the UTC day.
 */
export function homeSections<T extends { run: RunSummary }>(rows: readonly T[], now: number, zone: Zone = 'utc'): HomeSections<T> {
  const needsYou: T[] = []
  const today: T[] = []
  const running: T[] = []
  const paused: T[] = []
  const recent: T[] = []
  const todayKey = dayKey(now, zone)
  for (const row of rows) {
    const finished = isFinished(row.run.status)
    const moved = finished ? endedAt(row.run) : movedAt(row.run)
    if (waitingKind(row.run) !== null) needsYou.push(row)
    else if (dayKey(moved, zone) === todayKey && ms(moved) <= now + 60_000) today.push(row)
    else if (finished) { if (ms(endedAt(row.run)) >= now - RECENT_WINDOW_MS) recent.push(row) }
    else if (row.run.status === 'paused') paused.push(row)
    else running.push(row)
  }
  const since = (row: T) => ms(row.run.activity?.attention?.since ?? movedAt(row.run))
  const moved = (row: T) => ms(isFinished(row.run.status) ? endedAt(row.run) : movedAt(row.run))
  needsYou.sort((a, b) => since(a) - since(b) || a.run.run_id.localeCompare(b.run.run_id))
  today.sort((a, b) => Number(b.run.status === 'running') - Number(a.run.status === 'running') || moved(b) - moved(a) || a.run.run_id.localeCompare(b.run.run_id))
  running.sort((a, b) => ms(movedAt(b.run)) - ms(movedAt(a.run)) || a.run.run_id.localeCompare(b.run.run_id))
  paused.sort((a, b) => since(a) - since(b) || a.run.run_id.localeCompare(b.run.run_id))
  recent.sort((a, b) => ms(endedAt(b.run)) - ms(endedAt(a.run)) || a.run.run_id.localeCompare(b.run.run_id))
  return { needsYou, today, running, paused, recent }
}

/** How many paused runs the Paused section shows before the rest fold behind "Show all". */
export const PAUSED_SHOWN = 5

/** Whole days from an instant to `now`, floored; never negative. */
const daysSince = (iso: string, now: number) => Math.max(0, Math.floor((now - ms(iso)) / (24 * 60 * 60 * 1000)))

/**
 * How long a paused run has waited, for its row in the Paused section (PRD_VIEWER_REFINE 5.7): "since <n> days" from its
 * attention `since`, else its last activity; "since today" under a day. Rendered in the paused tone by its caller.
 */
export function sincePausedLabel(run: Pick<RunSummary, 'updated_at' | 'activity'>, now: number): string {
  const n = daysSince(run.activity?.attention?.since ?? movedAt(run), now)
  if (n === 0) return 'since today'
  return `since ${n} ${n === 1 ? 'day' : 'days'}`
}

/**
 * A Running or Paused section's sub-header (PRD_VIEWER_REFINE 5.7): the step each row sits at, counted and named from the
 * served `activity.focus.label`, in first-seen order ("3 at Launch ui worker, 1 at Verify ui"); rows the server gives no
 * focus step are counted as "<n> without a step". Empty when there are no rows (the section shows its empty sub-header).
 */
export function stepTally<T extends { run: RunSummary }>(rows: readonly T[]): string {
  const order: string[] = []
  const counts = new Map<string, number>()
  for (const row of rows) {
    const key = row.run.activity?.focus?.label ?? ''
    if (!counts.has(key)) order.push(key)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return order.map(key => `${counts.get(key)} ${key === '' ? 'without a step' : `at ${key}`}`).join(', ')
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
  if (nodeId === SIDECAR_NODE_ID) return 'review sidecar'
  if (nodeId === ATTACK_NODE_ID) return 'attack pass'
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

/**
 * A Running card's time line (PRD_VIEWER_REVAMP 5.1), from the list clock: a running run says how long it has run; a live
 * run that stopped (paused, interrupted) says how long ago it *started*, never a bare span that reads as how long it has been
 * stopped, and gives the served attention `since` as when it stopped. `started` is the start time a card adds after the line,
 * only for a running run: a stopped run's line already says when it started, so without a served `since` nothing follows it.
 * A finished run has no such line.
 */
export function cardElapsed(
  run: Pick<RunSummary, 'status' | 'created_at'> & { activity?: { attention: { since: string | null } | null } | null },
  now: number,
): { elapsed: string; since: string | null; started: string | null } | null {
  if (isFinished(run.status)) return null
  const span = formatSpan(Math.max(0, now - ms(run.created_at)))
  if (run.status === 'running') return { elapsed: `running for ${span}`, since: null, started: run.created_at }
  return { elapsed: `${STATUS_LABEL[run.status].toLowerCase()} · started ${span} ago`, since: run.activity?.attention?.since ?? null, started: null }
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

/** Situations that come before rule 5 (c): a stopped controller never hides a question, a pane, an approval or a held or paused challenge. */
const BEFORE_INTERRUPTED: readonly Situation[] = ['question', 'pane_attention', 'awaiting_approval', 'challenge_held', 'challenge_paused', 'interrupted']

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

// ---- The revamp's Runs home (docs/PRD_VIEWER_REVAMP.md 5.1): search, filters, day groups, the rail, the cards ---------------

/** Recent shows this many rows; the rest wait behind "Show older". */
export const RECENT_SHOWN = 10
/** Projects fold into a rail group when this many or more share the prefix before their last `-` segment. */
export const PREFIX_GROUP_MIN = 3
export const RECENT_FILTERS = ['all', 'failed', 'succeeded', 'today'] as const
export type RecentFilter = (typeof RECENT_FILTERS)[number]

/** What a mixed list knows about a row beyond its run: its feature title and project, and its workflow's node labels. */
export type ListRow = { run: RunSummary; title: string; project: { project_id: string; name: string }; labels?: ReadonlyMap<string, string> }

/**
 * Recent's client-side search: every word of the query must occur, ignoring case, in the run id, the feature title, the
 * run's feature, the project or the outcome (the row's summary and the served headline). A blank query keeps every row.
 */
export function searchRows<T extends ListRow>(rows: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...rows]
  return rows.filter(row => {
    const haystack = [row.run.run_id, row.title, row.run.activity?.feature, row.project.name, row.run.activity?.headline, rowSummary(row.run, row.labels)]
      .filter(Boolean).join('\n').toLowerCase()
    return words.every(word => haystack.includes(word))
  })
}

const pad2 = (value: number) => String(value).padStart(2, '0')
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The calendar day of an instant in the reader's zone, as `YYYY-MM-DD`. */
export function dayKey(at: string | number, zone: Zone): string {
  const date = new Date(typeof at === 'number' ? at : ms(at))
  return zone === 'utc'
    ? `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`
    : `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** A day row's label: "Today", "Yesterday", else the date as the clocks write it ("Mar 10", "Dec 31 2025"). */
export function dayLabel(key: string, now: number, zone: Zone): string {
  const today = dayKey(now, zone)
  if (key === today) return 'Today'
  const [year, month, day] = key.split('-').map(Number)
  const [todayYear, todayMonth, todayDay] = today.split('-').map(Number)
  if ((Date.UTC(todayYear, todayMonth - 1, todayDay) - Date.UTC(year, month - 1, day)) / 86_400_000 === 1) return 'Yesterday'
  return `${MONTH_NAMES[month - 1]} ${day}${year === todayYear ? '' : ` ${year}`}`
}

/** Recent's filters: Failed and Succeeded by status, Today by the day the run ended in the reader's zone. */
export function filterRecent<T extends { run: RunSummary }>(rows: readonly T[], filter: RecentFilter, now: number, zone: Zone): T[] {
  if (filter === 'failed') return rows.filter(row => row.run.status === 'failed')
  if (filter === 'succeeded') return rows.filter(row => row.run.status === 'succeeded')
  if (filter === 'today') {
    const today = dayKey(now, zone)
    return rows.filter(row => dayKey(endedAt(row.run), zone) === today)
  }
  return [...rows]
}

/** How many rows each filter keeps, for the counts on its button. */
export function recentCounts<T extends { run: RunSummary }>(rows: readonly T[], now: number, zone: Zone): Record<RecentFilter, number> {
  return Object.fromEntries(RECENT_FILTERS.map(filter => [filter, filterRecent(rows, filter, now, zone).length])) as Record<RecentFilter, number>
}

export type RowGroup<T> = { key: string; label: string; rows: T[] }

function groupBy<T>(rows: readonly T[], keyOf: (row: T) => string, labelOf: (key: string, row: T) => string): RowGroup<T>[] {
  const groups = new Map<string, RowGroup<T>>()
  for (const row of rows) {
    const key = keyOf(row)
    const group = groups.get(key)
    if (group) group.rows.push(row)
    else groups.set(key, { key, label: labelOf(key, row), rows: [row] })
  }
  return [...groups.values()]
}

/** Recent's day rows: each group is the day the run ended, in the order the rows come (newest first). */
export function groupByDay<T extends { run: RunSummary }>(rows: readonly T[], now: number, zone: Zone): RowGroup<T>[] {
  return groupBy(rows, row => dayKey(endedAt(row.run), zone), key => dayLabel(key, now, zone))
}

/** Recent grouped by project instead of by day, projects in the order their first row comes. */
export function groupByProject<T extends ListRow>(rows: readonly T[]): RowGroup<T>[] {
  return groupBy(rows, row => row.project.project_id, (_, row) => row.project.name)
}

/** The first `limit` rows across the groups, in order, and how many are left behind "Show older". */
export function firstRows<T>(groups: readonly RowGroup<T>[], limit: number): { groups: RowGroup<T>[]; hidden: number } {
  const shown: RowGroup<T>[] = []
  let left = limit
  let hidden = 0
  for (const group of groups) {
    const take = group.rows.slice(0, Math.max(0, left))
    left -= take.length
    hidden += group.rows.length - take.length
    if (take.length > 0) shown.push({ ...group, rows: take })
  }
  return { groups: shown, hidden }
}

/** A project id's family prefix: everything before its last `-` segment, or null when it has none. */
export function projectPrefix(projectId: string): string | null {
  const index = projectId.lastIndexOf('-')
  return index > 0 ? projectId.slice(0, index) : null
}

export type RailEntry<P> = { kind: 'project'; project: P } | { kind: 'group'; prefix: string; projects: P[] }

/** The rail's entries: projects in registry order, families of `min` or more siblings folded into one group at the first one's place. */
export function railEntries<P extends { project_id: string }>(projects: readonly P[], min = PREFIX_GROUP_MIN): RailEntry<P>[] {
  const families = new Map<string, P[]>()
  for (const project of projects) {
    const prefix = projectPrefix(project.project_id)
    if (prefix !== null) families.set(prefix, [...(families.get(prefix) ?? []), project])
  }
  const entries: RailEntry<P>[] = []
  const placed = new Set<string>()
  for (const project of projects) {
    const prefix = projectPrefix(project.project_id)
    const family = prefix === null ? undefined : families.get(prefix)
    if (prefix === null || family === undefined || family.length < min) entries.push({ kind: 'project', project })
    else if (!placed.has(prefix)) {
      placed.add(prefix)
      entries.push({ kind: 'group', prefix, projects: family })
    }
  }
  return entries
}

/**
 * A project's rail dot from its listed runs: needs you while any run waits on the operator, failed when its latest finished
 * run failed, else its most pressing live run's own tone (awaiting approval, running, paused), succeeded when its latest
 * finished run did, else idle.
 */
export function projectTone(runs: readonly Pick<RunSummary, 'status' | 'activity' | 'updated_at'>[]): Tone {
  if (runs.some(run => waitingKind(run) !== null)) return 'warn'
  const latest = runs.filter(run => isFinished(run.status)).reduce<Pick<RunSummary, 'status' | 'activity' | 'updated_at'> | null>(
    (last, run) => (last === null || ms(endedAt(run)) > ms(endedAt(last)) ? run : last), null)
  if (latest?.status === 'failed') return 'fail'
  // A live run in its own tone (statusTone): awaiting approval is warn, running is run, paused is pause, never "Running".
  const live = runs.filter(run => !isFinished(run.status)).map(run => statusTone(run.status))
  const order: readonly Tone[] = ['warn', 'run', 'pause']
  const liveTone = order.find(tone => live.includes(tone))
  if (liveTone) return liveTone
  if (latest?.status === 'succeeded') return 'ok'
  return 'idle'
}

/** A Needs-you card's next step, a label only: the exact command needs the run detail and stays on the run page. */
export const NEXT_STEP: Record<WaitingKind, string> = {
  question: 'answer the question',
  pane: 'attend the pane',
  approval: 'approve the candidate',
}

/** The lanes a workflow definition launches (`launch_<lane>` nodes), in definition order. */
export function laneNamesOf(nodes: readonly { node_id: string }[]): string[] {
  return nodes.filter(node => node.node_id.startsWith('launch_')).map(node => node.node_id.slice('launch_'.length))
}

/**
 * Runs home's controller readings, one list per live run, extended with each poll's served `activity.controller` so a
 * Running card says "not running" only once it has held for 15 s (`controllerSuffix`); runs no longer listed are dropped.
 */
export function recordHomeReadings(previous: ReadonlyMap<string, readonly ControllerReading[]>, readings: readonly { key: string; value: ControllerState }[], at: string): Map<string, ControllerReading[]> {
  return new Map(readings.map(({ key, value }) => [key, recordReading(previous.get(key) ?? [], { at, value })]))
}

/**
 * The review steps a feature's definition declares (its `review` nodes, such as the design challenge and the independent
 * review), by label in definition order. The reviewer ids themselves are in each run's review result, which the lists never
 * fetch, so a feature's header names its review steps from the definition instead.
 */
export function reviewStepsOf(nodes: readonly { kind: string; label: string }[]): string[] {
  return nodes.filter(node => node.kind === 'review').map(node => node.label)
}
