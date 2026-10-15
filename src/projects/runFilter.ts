/**
 * The run lists' filter bar, without React so the unit tests import it: the filter state (status toggles, the stopped-at
 * phase, the date window, the search words, the sort), which runs match it, how many each status toggle keeps under the
 * other controls, and the scope line that says which runs were searched.
 *
 * The model reads a served run array and a scope kind only; it never issues a request. Every list states its actual scope:
 * a loaded subset is never called complete while a cursor remains.
 */
import type { RunSummary } from './api.ts'
import { PHASES, PHASE_INTEGRATE, phaseOf, type Phase } from './dispatch/phases.ts'
import { dayKey, lastActivityAt, type ListSort, type RunClass } from './lists.ts'
import type { Zone } from './time.ts'

/** The status toggles, in the bar's order; several can be pressed at once. */
export const STATUS_FILTERS = ['needs', 'running', 'paused', 'failed', 'succeeded', 'override', 'cancelled'] as const
export type StatusFilter = (typeof STATUS_FILTERS)[number]
export const STATUS_FILTER_LABEL: Record<StatusFilter, string> = {
  needs: 'Needs you', running: 'Running', paused: 'Paused', failed: 'Failed', succeeded: 'Succeeded', override: 'Override', cancelled: 'Cancelled',
}

/** The date windows, from a run's last activity in the viewer's zone; `any` is every run the page read. */
export const DATE_FILTERS = ['any', 'today', '7d', '30d', 'all'] as const
export type DateFilter = (typeof DATE_FILTERS)[number]
export const DATE_FILTER_LABEL: Record<DateFilter, string> = { any: 'Any date', today: 'Today', '7d': '7 days', '30d': '30 days', all: 'All time' }

/**
 * Which list the bar sits on: it decides the date choices, the sort choices and the scope line. `all` is Triage under "All
 * time": the registry's pages over every project, read on request.
 */
export type ScopeKind = 'feature' | 'project' | 'triage' | 'all'

/**
 * The date choices each list offers: Triage reads beyond its window only under "All time" (the registry's pages), the feature
 * page reads its own older pages.
 */
export const DATE_CHOICES: Record<ScopeKind, readonly DateFilter[]> = {
  triage: ['any', 'today', '7d', 'all'],
  project: ['any', 'today', '7d', '30d'],
  feature: ['any', 'today', '7d', '30d', 'all'],
  all: ['any', 'today', '7d', 'all'],
}

/** The sort choices each list offers, each naming its key. */
export const SORT_CHOICES: Record<ScopeKind, readonly { id: ListSort; label: string }[]> = {
  triage: [{ id: 'live', label: 'Needs you and running first' }, { id: 'newest', label: 'Newest created first' }, { id: 'oldest', label: 'Oldest created first' }],
  feature: [{ id: 'live', label: 'Needs you and running first' }, { id: 'newest', label: 'Newest created first' }, { id: 'oldest', label: 'Oldest created first' }],
  project: [{ id: 'live', label: 'Needs you and running first' }, { id: 'newest', label: 'Latest activity first' }, { id: 'oldest', label: 'Earliest activity first' }],
  all: [{ id: 'live', label: 'Needs you and running first' }, { id: 'newest', label: 'Newest created first' }, { id: 'oldest', label: 'Oldest created first' }],
}

/** The URL's date as a list reads it: a date the list does not offer (the URL key is shared by every list) is "Any date". */
export function offeredDate(kind: ScopeKind, date: DateFilter): DateFilter {
  return DATE_CHOICES[kind].includes(date) ? date : 'any'
}

export type RunFilterState = {
  q: string
  status: readonly StatusFilter[]
  phase: Phase | null
  date: DateFilter
  sort: ListSort
}

export const DEFAULT_FILTER: RunFilterState = { q: '', status: [], phase: null, date: 'any', sort: 'live' }

/** Whether any control narrows the list (the sort only orders it). "All time" narrows nothing: it reads more. */
export function filterActive(state: RunFilterState): boolean {
  return state.q.trim() !== '' || state.status.length > 0 || state.phase !== null || (state.date !== 'any' && state.date !== 'all')
}

/**
 * The one status toggle a run matches: "Needs you" from its class only; "Override" for an accepted run only; a superseded
 * paused run is "Paused"; a failed run is "Failed" whatever attention it is served with. A run that waits to start (pending,
 * awaiting approval without a wait) matches no toggle.
 */
export function statusOf(run: Pick<RunSummary, 'status' | 'accepted'>, cls: RunClass): StatusFilter | null {
  if (run.accepted) return 'override'
  if (cls.needs !== null) return 'needs'
  if (run.status === 'running') return 'running'
  if (run.status === 'paused') return 'paused'
  if (run.status === 'failed') return 'failed'
  if (run.status === 'succeeded') return 'succeeded'
  if (run.status === 'cancelled') return 'cancelled'
  return null
}

/** How the page names a focus step's kind: the run's recorded step, else the held definition; undefined when neither knows it. */
export type KindOf = (nodeId: string) => string | undefined

/**
 * The phase a run stopped at, from its served focus step under the phase map (`phaseOf`): the step's kind comes from `kindOf`
 * when the page holds it, else the node-id rule alone decides. A succeeded or accepted run without a focus is at Integrate;
 * any other run without activity or focus has no phase (it matches only "Any step").
 */
export function runPhase(run: Pick<RunSummary, 'status' | 'accepted' | 'activity'>, kindOf: KindOf = () => undefined): number | null {
  if (!run.activity) return null
  const nodeId = run.activity.focus?.node_id ?? null
  if (nodeId === null) return run.status === 'succeeded' || run.accepted ? PHASE_INTEGRATE : null
  return phaseOf(nodeId, kindOf(nodeId) ?? '')
}

const DAY = 86_400_000

/** Whether a run's last activity falls in the window, in the viewer's zone: today, or the last 7 or 30 calendar days. */
export function inDateWindow(run: Pick<RunSummary, 'status' | 'accepted' | 'updated_at' | 'activity'>, date: DateFilter, now: number, zone: Zone): boolean {
  if (date === 'any' || date === 'all') return true
  const at = lastActivityAt(run)
  if (at > now + 60_000) return false
  const days = date === 'today' ? 0 : date === '7d' ? 6 : 29
  return dayKey(at, zone) >= dayKey(now - days * DAY, zone)
}

/** Every word of the query occurs, ignoring case, in the run id, the served feature, the headline or the given extra names. */
export function matchesText(run: Pick<RunSummary, 'run_id' | 'activity'>, q: string, extra: readonly (string | null | undefined)[] = []): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const haystack = [run.run_id, run.activity?.feature, run.activity?.headline, ...extra].filter(Boolean).join('\n').toLowerCase()
  return words.every(word => haystack.includes(word))
}

/** One run as the bar reads it: the run, its class in the list's one classification, and what else names it. */
export type FilterItem = { run: RunSummary; cls: RunClass; kindOf?: KindOf; names?: readonly (string | null | undefined)[] }
export type FilterContext = { now: number; zone: Zone }

function matchesExcept(item: FilterItem, state: RunFilterState, context: FilterContext, skipStatus: boolean): boolean {
  if (!skipStatus && state.status.length > 0) {
    const status = statusOf(item.run, item.cls)
    if (status === null || !state.status.includes(status)) return false
  }
  if (state.phase !== null && runPhase(item.run, item.kindOf) !== PHASES.indexOf(state.phase)) return false
  if (!inDateWindow(item.run, state.date, context.now, context.zone)) return false
  return matchesText(item.run, state.q, item.names ?? [])
}

/** Whether a run matches every control of the bar. */
export const matchesFilter = (item: FilterItem, state: RunFilterState, context: FilterContext) => matchesExcept(item, state, context, false)

/** The items that match every control, in the order given. */
export function filterItems<T extends FilterItem>(items: readonly T[], state: RunFilterState, context: FilterContext): T[] {
  return items.filter(item => matchesFilter(item, state, context))
}

/** How many runs each status toggle keeps under the other controls (the phase, the date and the text), for its count. */
export function statusCounts(items: readonly FilterItem[], state: RunFilterState, context: FilterContext): Record<StatusFilter, number> {
  const counts = Object.fromEntries(STATUS_FILTERS.map(id => [id, 0])) as Record<StatusFilter, number>
  for (const item of items) {
    if (!matchesExcept(item, state, context, true)) continue
    const status = statusOf(item.run, item.cls)
    if (status !== null) counts[status] += 1
  }
  return counts
}

/**
 * The scope line, in its closed set: Triage under "All time" "<k> of <n> runs · every project · Load more runs" until every
 * page answered, then "<k> of <n> runs · every project, all loaded"; the feature page "<k> of <n> runs · Load more runs" while a cursor remains, "<k> of <n>
 * runs, all loaded" once none does; the project page "· the first 50 runs of each feature" while any feature has more, else
 * "all loaded"; Triage "· runs updated in the last 7 days and the 50 most recently updated runs of each feature" (the home read is by
 * `updated_at`, so it never says "latest" or "first"). `<k>` counts the matching runs, `<n>` the runs read.
 */
export function scopeLine(kind: ScopeKind, matched: number, read: number, more: boolean): string {
  const head = `${matched} of ${read} runs`
  if (kind === 'triage') return `${head} · runs updated in the last 7 days and the 50 most recently updated runs of each feature`
  // "All time": `more` while a cursor remains or a page failed, so "all loaded" is said only once every page answered.
  if (kind === 'all') return more ? `${head} · every project · Load more runs` : `${head} · every project, all loaded`
  if (!more) return `${head}, all loaded`
  return kind === 'feature' ? `${head} · Load more runs` : `${head} · the first 50 runs of each feature`
}

/**
 * The feature page's scope line once it read as many pages as its URL can restore (`MAX_LIST_PAGES`) and a cursor remains: it
 * says where it stopped and that "All time" reads on, never "Load more runs", which it cannot do there.
 */
export function cappedScopeLine(matched: number, read: number, pages: number): string {
  return `${matched} of ${read} runs · the first ${pages} pages; choose All time to read on`
}

/** How far the project page's run read got: the lists are still being read, failed as a whole, or were read (some features may not be). */
export type ProjectRead = { kind: 'loading' } | { kind: 'failed'; reason: string } | { kind: 'ready'; unread: string | null }

/**
 * The project page's scope line, in the closed set of `scopeLine` plus three strings the page already shows: "Reading runs…"
 * while the lists are read, "Runs not read: <reason>" when they failed, and "<k> of <n> runs · <unread>" (the page's own
 * "N feature(s) cannot be read") when some feature's list failed, followed by "· the first 50 runs of each feature" while any feature
 * has more. It says "all loaded" only when every feature was read and
 * none has more runs.
 */
export function projectScopeLine(read: ProjectRead, matched: number, total: number, more: boolean): string {
  if (read.kind === 'loading') return 'Reading runs…'
  if (read.kind === 'failed') return `Runs not read: ${read.reason}`
  if (read.unread !== null) return more ? `${matched} of ${total} runs · ${read.unread} · the first 50 runs of each feature` : `${matched} of ${total} runs · ${read.unread}`
  return scopeLine('project', matched, total, more)
}

