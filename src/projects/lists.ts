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
import { ATTACK_NODE_ID, GENERIC_WORKFLOW_NAME, OVERRIDE_LABEL, SIDECAR_NODE_ID, STATUS_LABEL, type RunStatus } from './status.ts'
import { formatSpan, type Zone } from './time.ts'
import { stateTone, statusTone, type Tone } from './tone.ts'

/** Recent lists every run that finished in the last seven days (decisions.md). */
export const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** Runs home and the project page re-read their run lists this often. */
export const LISTS_POLL_MS = 15_000
/** The registry home read and the overview re-read this often while no row read runs or needs the operator. */
export const LISTS_IDLE_POLL_MS = 60_000
/** How many controller readings a run page keeps; the debounce needs only the latest run of equal values. */
const READINGS_KEPT = 50

const FINISHED: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled']
/** The attention kinds that wait on the operator (6.4); `interrupted`, `paused` and `failed` are the run's own state. */
export const WAITING_KINDS = ['question', 'pane', 'approval'] as const
export type WaitingKind = (typeof WAITING_KINDS)[number]

/** Whether a run no longer moves. A run with the operator override (L12) is finished before its status is read. */
export const isFinished = (run: RunStatus | Pick<RunSummary, 'status' | 'accepted'>): boolean =>
  typeof run === 'string' ? FINISHED.includes(run) : Boolean(run.accepted) || FINISHED.includes(run.status)
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
export function waitingKind(run: Pick<RunSummary, 'status' | 'activity' | 'accepted'>): WaitingKind | null {
  const kind = run.activity?.attention?.kind
  if (!kind || isFinished(run)) return null
  return (WAITING_KINDS as readonly string[]).includes(kind) ? kind as WaitingKind : null
}

/** What a run that needs the operator waits on: today's kinds, a decision at the design challenge, or an interrupted run. */
export type NeedKind = WaitingKind | 'decision' | 'interrupted'
/**
 * One run's place in the lists, decided once per served list: what it needs from the operator (null when nothing), and for a
 * paused run with a later run in its project and workflow, that later run's id (it is superseded and needs nobody).
 */
export type RunClass = { needs: NeedKind | null; supersededBy: string | null }
export type RunClasses = ReadonlyMap<string, RunClass>
type ClassKey = Pick<RunSummary, 'project_id' | 'workflow_id' | 'run_id'>

const groupKey = (run: Pick<RunSummary, 'project_id' | 'workflow_id'>) => `${run.project_id}\u0000${run.workflow_id}`
const classKey = (run: ClassKey) => `${groupKey(run)}\u0000${run.run_id}`
const NO_CLASS: RunClass = { needs: null, supersededBy: null }
const NO_STOPPED: ReadonlySet<string> = new Set()
/** Whether `a` was created after `b`: a later `created_at`, a tie going to the greater `run_id`. */
const createdAfter = (a: Pick<RunSummary, 'created_at' | 'run_id'>, b: Pick<RunSummary, 'created_at' | 'run_id'>) =>
  ms(a.created_at) > ms(b.created_at) || (ms(a.created_at) === ms(b.created_at) && a.run_id > b.run_id)

/**
 * Decides, from the served run list only, which runs need the operator and which paused runs are superseded, in this order:
 * a paused run with a later run (by `created_at`, then `run_id`) in its project and workflow is superseded, whatever its
 * attention; an unfinished run whose attention is a question, a pane or an approval waits on the operator, whatever its
 * status; the latest run of its project and workflow needs a decision when it is paused at the design challenge, and needs
 * the operator when it is interrupted while paused or running. Every other run needs nobody. The feature text is never read:
 * the project and the workflow are the key. Pass the whole loaded list, in any order.
 *
 * `stopped` is the set of run keys (`registryKey`) whose controller has read `not_running` for 15 s (`controllerNotRunning`
 * over the readings the page keeps across polls); the latest, running run in it needs the operator as an interrupted one
 * does, as on its run page. Without it, or for a run that is not in it, nothing changes: status alone never decides.
 */
export function classifyRuns(
  runs: readonly Pick<RunSummary, 'project_id' | 'workflow_id' | 'run_id' | 'created_at' | 'status' | 'activity' | 'accepted'>[],
  stopped: ReadonlySet<string> = NO_STOPPED,
): Map<string, RunClass> {
  const newest = new Map<string, (typeof runs)[number]>()
  for (const run of runs) {
    const best = newest.get(groupKey(run))
    if (best === undefined || createdAfter(run, best)) newest.set(groupKey(run), run)
  }
  const classes = new Map<string, RunClass>()
  for (const run of runs) {
    const best = newest.get(groupKey(run))!
    const latest = best === run || !createdAfter(best, run)
    const attention = run.activity?.attention ?? null
    let cls: RunClass = NO_CLASS
    if (run.status === 'paused' && !latest) cls = { needs: null, supersededBy: best.run_id }
    else if (waitingKind(run) !== null) cls = { needs: waitingKind(run), supersededBy: null }
    else if (latest && !isFinished(run) && attention !== null) {
      if (attention.kind === 'paused' && attention.node_id === 'challenge' && run.status === 'paused') cls = { needs: 'decision', supersededBy: null }
      else if (attention.kind === 'interrupted' && (run.status === 'paused' || run.status === 'running')) cls = { needs: 'interrupted', supersededBy: null }
    }
    if (cls.needs === null && cls.supersededBy === null && latest && run.status === 'running' && !isFinished(run) && stopped.has(registryKey(run))) cls = { needs: 'interrupted', supersededBy: null }
    classes.set(classKey(run), cls)
  }
  return classes
}

/**
 * How a row draws a run from its class: warn with a `?` and `data-attention` only while it needs the operator; otherwise its
 * status's own tone and glyph, so a superseded run served with a question is a plain paused row.
 */
export function rowLook(run: Pick<RunSummary, 'status' | 'accepted'>, cls: RunClass): { tone: Tone; glyph: string | null; attention: NeedKind | null } {
  if (cls.needs !== null) return { tone: 'warn', glyph: '?', attention: cls.needs }
  return { tone: stateTone({ status: run.status, accepted: run.accepted }), glyph: null, attention: null }
}

/** A run's class in a classified list; a run the list did not classify needs nobody. */
export const classOf = (classes: RunClasses, run: ClassKey): RunClass => classes.get(classKey(run)) ?? NO_CLASS

/** When a finished run ended, for the Recent window and its order: the served finish, else (without activity) its last update. */
export const endedAt = (run: Pick<RunSummary, 'updated_at' | 'activity'>) => run.activity?.finished_at ?? run.updated_at
/** When a run last moved, for ordering live rows: the served last activity, else its last update. */
export const movedAt = (run: Pick<RunSummary, 'updated_at' | 'activity'>) => run.activity?.last_activity_at ?? run.updated_at

export type HomeSections<T> = { needsYou: T[]; today: T[]; running: T[]; paused: T[]; superseded: T[]; recent: T[]; classes: RunClasses }

/** When a run last moved, for every list order: its end once finished, else its last activity. */
export const lastActivityAt = (run: Pick<RunSummary, 'status' | 'accepted' | 'updated_at' | 'activity'>) => ms(isFinished(run) ? endedAt(run) : movedAt(run))

/**
 * A run's group in the one list order: 0 needs the operator (its class), 1 running, 2 paused and not superseded, 3 the rest
 * (finished runs, superseded paused runs, and runs that wait to start). A finished run never ranks above a live one, whatever
 * attention it is served with; status alone never makes a run need the operator.
 */
export function liveRank(run: Pick<RunSummary, 'status' | 'accepted'>, cls: RunClass): 0 | 1 | 2 | 3 {
  if (cls.needs !== null) return 0
  if (isFinished(run)) return 3
  if (run.status === 'running') return 1
  if (run.status === 'paused' && cls.supersededBy === null) return 2
  return 3
}

type Ordered = Pick<RunSummary, 'project_id' | 'workflow_id' | 'run_id' | 'status' | 'accepted' | 'updated_at' | 'created_at' | 'activity'>

/**
 * The one list order ("needs you and running first, then latest activity"): needs the operator, running, paused (not
 * superseded), the rest; inside each group the latest activity first (`movedAt` unfinished, `endedAt` finished), ties by
 * `run_id`. `classes` is the list's one classification (`classifyRuns`), computed once per list by the caller.
 */
export function compareLive(classes: RunClasses): (a: Ordered, b: Ordered) => number {
  return (a, b) => liveRank(a, classOf(classes, a)) - liveRank(b, classOf(classes, b))
    || lastActivityAt(b) - lastActivityAt(a) || a.run_id.localeCompare(b.run_id)
}

/** The list sorts: the default order above, or by creation time newest or oldest first, ties by `run_id` ascending. */
export const LIST_SORTS = ['live', 'newest', 'oldest'] as const
export type ListSort = (typeof LIST_SORTS)[number]

/** Runs by `created_at`, newest (`desc`) or oldest first, ties by `run_id` ascending in both directions. */
export function compareCreated(direction: 'desc' | 'asc'): (a: Pick<RunSummary, 'created_at' | 'run_id'>, b: Pick<RunSummary, 'created_at' | 'run_id'>) => number {
  const sign = direction === 'desc' ? -1 : 1
  return (a, b) => sign * (ms(a.created_at) - ms(b.created_at)) || a.run_id.localeCompare(b.run_id)
}

/** A list's rows in the chosen sort: the default order, or by creation time. */
export function sortRuns<T extends { run: Ordered }>(rows: readonly T[], sort: ListSort, classes: RunClasses): T[] {
  const compare = sort === 'live' ? compareLive(classes) : compareCreated(sort === 'newest' ? 'desc' : 'asc')
  return [...rows].sort((a, b) => compare(a.run, b.run))
}

/**
 * Runs home's sections (Triage): what needs the operator (a question, a pane, an approval, a decision at the design
 * challenge or an interrupted latest run), longest waiting first; every running run that needs nobody, whatever day it last
 * moved (with the runs that wait to start); the runs that finished today; the paused runs no later run superseded; the
 * superseded paused runs, folded apart; and the runs finished in the last seven days before today. A run sits in exactly one
 * section, and the rows of every section but Needs you follow the list order (`compareLive`). `zone` decides where today
 * begins; without it, today is the UTC day. `classes` is the list's classification (`classifyRuns`), computed here when not given.
 */
export function homeSections<T extends { run: RunSummary }>(rows: readonly T[], now: number, zone: Zone = 'utc', classes: RunClasses = classifyRuns(rows.map(row => row.run))): HomeSections<T> {
  const needsYou: T[] = []
  const today: T[] = []
  const running: T[] = []
  const paused: T[] = []
  const superseded: T[] = []
  const recent: T[] = []
  const todayKey = dayKey(now, zone)
  for (const row of rows) {
    const cls = classOf(classes, row.run)
    if (cls.supersededBy !== null) superseded.push(row)
    else if (cls.needs !== null) needsYou.push(row)
    else if (isFinished(row.run)) {
      const ended = endedAt(row.run)
      if (dayKey(ended, zone) === todayKey && ms(ended) <= now + 60_000) today.push(row)
      else if (ms(ended) >= now - RECENT_WINDOW_MS) recent.push(row)
    } else if (row.run.status === 'paused') paused.push(row)
    else running.push(row)
  }
  const since = (row: T) => ms(row.run.activity?.attention?.since ?? movedAt(row.run))
  needsYou.sort((a, b) => since(a) - since(b) || a.run.run_id.localeCompare(b.run.run_id))
  const live = compareLive(classes)
  for (const section of [today, running, paused, superseded, recent]) section.sort((a, b) => live(a.run, b.run))
  return { needsYou, today, running, paused, superseded, recent, classes }
}

/**
 * Triage's sections under a sort: the default keeps `homeSections`' rows; "newest" and "oldest" keep every run in its
 * section and order the rows inside each section by `created_at`. Section order and placement never move.
 */
export function sortHomeSections<T extends { run: RunSummary }>(sections: HomeSections<T>, sort: ListSort): HomeSections<T> {
  if (sort === 'live') return sections
  const compare = compareCreated(sort === 'newest' ? 'desc' : 'asc')
  const by = (rows: T[]) => [...rows].sort((a, b) => compare(a.run, b.run))
  return {
    needsYou: by(sections.needsYou), today: by(sections.today), running: by(sections.running), paused: by(sections.paused),
    superseded: by(sections.superseded), recent: by(sections.recent), classes: sections.classes,
  }
}

/** A Triage section's row order in words, under each sort; Needs you keeps its longest-waiting order under the default. */
export function sectionOrderWords(sort: ListSort, needsYou = false): string {
  if (sort === 'newest') return 'newest created first'
  if (sort === 'oldest') return 'oldest created first'
  return needsYou ? 'longest waiting first' : 'latest activity first'
}

/** Triage's state sections in page order (Pinned, when shown, comes before them); the jump links follow it. */
export const HOME_SECTION_ORDER = ['needs-you', 'running-runs', 'today-runs', 'paused-runs', 'recent-runs'] as const

/** How many paused runs the Paused section shows before the rest fold behind "Show all". */
export const PAUSED_SHOWN = 5

/** Whole days from an instant to `now`, floored; never negative. */
const daysSince = (iso: string, now: number) => Math.max(0, Math.floor((now - ms(iso)) / (24 * 60 * 60 * 1000)))

/** A day as the lists write it beside a stop: "Oct 2", with the year when it is not the year of `now` ("Dec 31 2025"). */
export function monthDay(iso: string, now: number, zone: Zone): string {
  const [year, month, day] = dayKey(iso, zone).split('-').map(Number)
  return `${MONTH_NAMES[month - 1]} ${day}${year === Number(dayKey(now, zone).slice(0, 4)) ? '' : ` ${year}`}`
}

/** How a stopped row reads: "paused 10 d (since Oct 2)", "interrupted today (since Oct 13)"; never "0 d". */
export function stoppedLabel(how: 'paused' | 'interrupted', since: string, now: number, zone: Zone = 'utc'): string {
  const n = daysSince(since, now)
  return `${how} ${n === 0 ? 'today' : `${n} d`} (since ${monthDay(since, now, zone)})`
}

/**
 * How long a paused run has waited, for its row (PRD_VIEWER_REFINE 5.7, in the stopped rows' words): "paused <n> d (since
 * <Mon D>)" from its attention `since`, else its last activity; "paused today (since <Mon D>)" under a day.
 */
export function sincePausedLabel(run: Pick<RunSummary, 'updated_at' | 'activity'>, now: number, zone: Zone = 'utc'): string {
  return stoppedLabel(run.activity?.attention?.kind === 'interrupted' ? 'interrupted' : 'paused', run.activity?.attention?.since ?? movedAt(run), now, zone)
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

/**
 * The registry home read's cadence: every `LISTS_POLL_MS` while any row read is running or needs the operator (its class in
 * the one classification), else every `LISTS_IDLE_POLL_MS`. A run that starts running brings the fast cadence back on the
 * next read.
 */
export function listsPollMs(runs: readonly RunSummary[], classes: RunClasses = classifyRuns(runs)): number {
  return runs.some(run => (!isFinished(run) && run.status === 'running') || classOf(classes, run).needs !== null) ? LISTS_POLL_MS : LISTS_IDLE_POLL_MS
}

/** A run's identity across the registry: project, workflow and run id. */
export const registryKey = (run: Pick<RunSummary, 'project_id' | 'workflow_id' | 'run_id'>) => `${run.project_id}/${run.workflow_id}/${run.run_id}`

/** Every run read once, by project, workflow and run id: a run in both lists keeps its row from the first (the home read). */
export function mergeRunRows<T extends { run: Pick<RunSummary, 'project_id' | 'workflow_id' | 'run_id'> }>(first: readonly T[], second: readonly T[]): T[] {
  const seen = new Set(first.map(row => registryKey(row.run)))
  const merged = [...first]
  for (const row of second) {
    const key = registryKey(row.run)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(row)
  }
  return merged
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
export function rowSummary(run: Pick<RunSummary, 'status' | 'activity' | 'accepted'>, labels: ReadonlyMap<string, string> = new Map(), needs: NeedKind | null = waitingKind(run)): string {
  // The override (L12) reads as its own outcome, never as the succeeded status it is served under.
  if (run.accepted) return `${OVERRIDE_LABEL} ${run.accepted.candidate.slice(0, 7)}: ${run.accepted.reason}`
  const status = STATUS_LABEL[run.status]
  const activity = run.activity
  if (!activity) return status
  // A superseded run waits on nobody, whatever attention it is served with: it reads as its status at its step.
  const kind = needs
  const node = activity.attention?.node_id ?? null
  if (kind === 'decision') return `${node === null ? 'Design challenge' : labels.get(node) ?? 'Design challenge'} paused · your decision waits`
  if (kind === 'interrupted') return `Interrupted at ${activity.focus?.label ?? (node === null ? 'a step' : labels.get(node) ?? node)} · the controller stopped`
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

/**
 * A row's time: a finished run's end and its duration (whatever attention it carries), a stopped run's stop (paused, or
 * interrupted while paused or running) with no span, a running run's start and its elapsed time, or (without activity, or
 * while it waits unfinished in another status) only its last update. Only a running run gets a ticking span. A running run
 * the list moved to Needs you as interrupted (`cls`, D32: its controller is not running) is stopped too, dated from its last
 * activity (else its last update), the latest move the list knows of, not when the controller stopped.
 */
export type RowTime =
  | { kind: 'finished'; at: string; ms: number }
  | { kind: 'stopped'; how: 'paused' | 'interrupted'; since: string }
  | { kind: 'live'; started: string; last: string | null; ms: number }
  | { kind: 'updated'; at: string }

export function rowTime(run: Pick<RunSummary, 'status' | 'created_at' | 'updated_at' | 'activity' | 'accepted'>, now: number, cls?: RunClass): RowTime {
  const activity = run.activity
  if (!activity) return { kind: 'updated', at: run.updated_at }
  if (activity.finished_at !== null) return { kind: 'finished', at: activity.finished_at, ms: Math.max(0, ms(activity.finished_at) - ms(run.created_at)) }
  if (isFinished(run)) return { kind: 'updated', at: run.updated_at }
  const since = activity.attention?.since ?? movedAt(run)
  if (activity.attention?.kind === 'interrupted' && (run.status === 'paused' || run.status === 'running')) return { kind: 'stopped', how: 'interrupted', since }
  if (run.status === 'paused') return { kind: 'stopped', how: 'paused', since }
  if (run.status === 'running' && cls?.needs === 'interrupted') return { kind: 'stopped', how: 'interrupted', since: movedAt(run) }
  // Only a running run ticks; one that waits to start or on an approval says when it last moved.
  if (run.status !== 'running') return { kind: 'updated', at: movedAt(run) }
  return { kind: 'live', started: run.created_at, last: activity.last_activity_at, ms: Math.max(0, now - ms(run.created_at)) }
}

/**
 * A Running card's time line (PRD_VIEWER_REVAMP 5.1), from the list clock: a running run says how long it has run; a run that
 * stopped (paused, or interrupted) says it in the stopped rows' words ("paused 3 d (since Mar 9)"), never a span that reads
 * as how long it has been stopped, and gives the served attention `since` as when it stopped. `started` is the start time a
 * card adds after the line, only for a running run. A finished run has no such line.
 */
export function cardElapsed(
  run: Pick<RunSummary, 'status' | 'created_at' | 'accepted'> & { updated_at?: string; activity?: { attention: { kind?: string; since: string | null } | null; last_activity_at?: string | null } | null },
  now: number,
  zone: Zone = 'utc',
): { elapsed: string; since: string | null; started: string | null } | null {
  if (isFinished(run)) return null
  const attention = run.activity?.attention ?? null
  const interrupted = attention?.kind === 'interrupted'
  if (run.status === 'running' && !interrupted) return { elapsed: `running for ${formatSpan(Math.max(0, now - ms(run.created_at)))}`, since: null, started: run.created_at }
  if (run.status === 'paused' || interrupted) {
    const stop = attention?.since ?? run.activity?.last_activity_at ?? run.updated_at ?? run.created_at
    return { elapsed: stoppedLabel(interrupted ? 'interrupted' : 'paused', stop, now, zone), since: attention?.since ?? null, started: null }
  }
  return { elapsed: `${STATUS_LABEL[run.status].toLowerCase()} · started ${formatSpan(Math.max(0, now - ms(run.created_at)))} ago`, since: attention?.since ?? null, started: null }
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
  if (activity && !isFinished(served.detail.summary)) {
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
export const RECENT_FILTERS = ['all', 'failed', 'succeeded'] as const
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

/** Recent's filters: Failed and Succeeded by status. */
export function filterRecent<T extends { run: RunSummary }>(rows: readonly T[], filter: RecentFilter, now: number, zone: Zone): T[] {
  void now
  void zone
  // The override (L12) is not a failure; under Succeeded it appears only with its own marker (the row's chip), never as a reviewed success.
  if (filter === 'failed') return rows.filter(row => !row.run.accepted && row.run.status === 'failed')
  if (filter === 'succeeded') return rows.filter(row => row.run.status === 'succeeded')
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
export function projectTone(runs: readonly RunSummary[], classes: RunClasses = classifyRuns(runs)): Tone {
  if (runs.some(run => classOf(classes, run).needs !== null)) return 'warn'
  const latest = runs.filter(run => isFinished(run)).reduce<RunSummary | null>(
    (last, run) => (last === null || ms(endedAt(run)) > ms(endedAt(last)) ? run : last), null)
  if (latest?.status === 'failed') return 'fail'
  // A live run in its own tone (statusTone): awaiting approval is warn, running is run, paused is pause, never "Running";
  // a superseded paused run is no live run.
  const live = runs.filter(run => !isFinished(run) && classOf(classes, run).supersededBy === null).map(run => statusTone(run.status))
  const order: readonly Tone[] = ['warn', 'run', 'pause']
  const liveTone = order.find(tone => live.includes(tone))
  if (liveTone) return liveTone
  // The override (L12) sits where ok does: after the live tones.
  if (latest?.accepted) return 'override'
  if (latest?.status === 'succeeded') return 'ok'
  return 'idle'
}

/** A Needs-you card's next step, a label only: the exact command needs the run detail and stays on the run page. */
export const NEXT_STEP: Record<NeedKind, string> = {
  question: 'answer the question',
  pane: 'attend the pane',
  approval: 'approve the candidate',
  decision: 'resume or accept the challenge on the run page',
  interrupted: 'resume the run on the run page',
}

/** The line under a run list that could not read some of its runs: "1 run cannot be read: <run id>", "2 runs cannot be read: <id>, <id>". */
export function unreadRunsText(runIds: readonly string[]): string {
  return `${runIds.length} ${runIds.length === 1 ? 'run' : 'runs'} cannot be read: ${runIds.join(', ')}`
}

/** The lanes a workflow definition launches (`launch_<lane>` nodes), in definition order. */
export function laneNamesOf(nodes: readonly { node_id: string }[]): string[] {
  return nodes.filter(node => node.node_id.startsWith('launch_')).map(node => node.node_id.slice('launch_'.length))
}

/** The run keys whose controller has read `not_running` for 15 s in the kept readings, the `stopped` argument of `classifyRuns`. */
export function stoppedRunKeys(readings: ReadonlyMap<string, readonly ControllerReading[]>): Set<string> {
  const keys = new Set<string>()
  for (const [key, list] of readings) if (list.at(-1)?.value === 'not_running' && controllerNotRunning(list)) keys.add(key)
  return keys
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
