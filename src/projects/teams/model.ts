/**
 * The Team view's pure model (docs/PRD_RUN_TEAMS.md "Team view" 3, "Run view integration" 5, the node page's Team section 6,
 * "Accessibility" 10, and the switcher suffix of 2). Pure: no React, no DOM, no `.tsx` import, so the unit tests read the
 * same words the page shows. Every value comes from the served teams payload (`contracts/projects/teams.ts`) and the run
 * inputs (a lane's owned paths); where the records hold nothing the value is null and the page says "not recorded", never a
 * guessed 0, time or model. The one clock (`clock`, epoch ms) is passed in by the run page.
 */
import type { AgentState, TeamAgent, TeamPhase, Teams, TeamSession, TeamWorkflow } from '../../../contracts/projects/teams.ts'
import { formatAgo, formatSpan } from '../time.ts'
import { agentTone, phaseTone, type Suffix, type Tone } from '../tone.ts'

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
const instant = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  const time = Date.parse(iso)
  return Number.isNaN(time) ? null : time
}

/**
 * The Team segment's suffix (docs/PRD_RUN_TEAMS.md 2), the first rule that holds:
 * - `{n} running` (run), adding ` · {f} failed` when an agent failed, while an agent runs;
 * - `{f} failed` (fail) when an agent failed;
 * - `interrupted` (pause) when a workflow is interrupted and none runs;
 * - `{a} agents` (no tone) when every workflow ended, and likewise while a workflow runs between agents (nothing to tone);
 * - none when the teams were not read (null) or no session has team records.
 */
export function teamSuffix(teams: Teams | null): Suffix | null {
  if (teams === null || teams.totals.sessions_with_teams === 0) return null
  const { running, failed, agents, workflows_running: workflowsRunning } = teams.totals
  if (running > 0) {
    const word = failed > 0 ? `${running} running · ${failed} failed` : `${running} running`
    const spoken = failed > 0 ? `${plural(running, 'agent', 'agents')} running, ${failed} failed` : `${plural(running, 'agent', 'agents')} running`
    return { tone: 'run', word, spoken }
  }
  if (failed > 0) return { tone: 'fail', word: `${failed} failed`, spoken: `${plural(failed, 'agent', 'agents')} failed` }
  const interrupted = teams.sessions.some(session => session.workflows.some(workflow => workflow.status === 'interrupted'))
  if (interrupted && workflowsRunning === 0) return { tone: 'pause', word: 'interrupted', spoken: 'a team workflow was interrupted' }
  const word = plural(agents, 'agent', 'agents')
  return { tone: null, word, spoken: word }
}

// ---- Lanes and owned paths (3.1, 3.7) ----------------------------------------------------------------------------------

/** What the model reads of a run inputs worker: its lane, the step that launched it and the paths it owns. */
export type LaneWorker = { node_id: string; launch_node_id: string; owned_paths: readonly string[] }

/** The workers the model reads from the run inputs (lane, launch step, owned paths); null while the inputs are not loaded or not recorded. */
export function laneWorkers(inputs: { workers: readonly LaneWorker[] } | null): LaneWorker[] | null {
  return inputs === null ? null : inputs.workers.map(worker => ({ node_id: worker.node_id, launch_node_id: worker.launch_node_id, owned_paths: worker.owned_paths }))
}

/** One lane panel: the lane, its launch step and worker entry (null when the inputs do not list it), its sessions in payload order. */
export type LaneGroup = { lane: string; launchNodeId: string | null; worker: LaneWorker | null; sessions: TeamSession[] }

/**
 * The lane panels and the other sessions (3.1): one lane per `inputs.workers[]` entry in definition order, each holding the
 * sessions whose `lane` is its id (the worker first, then repairs, as the payload orders them); a lane the payload names but the
 * inputs do not (inputs not loaded) follows, in payload order. Sessions without a lane (challenge, reviewers, panel) are `other`.
 */
export function laneGroups(teams: Teams, workers: readonly LaneWorker[] | null): { lanes: LaneGroup[]; other: TeamSession[] } {
  const lanes: LaneGroup[] = (workers ?? []).map(worker => ({ lane: worker.node_id, launchNodeId: worker.launch_node_id, worker, sessions: [] }))
  const byLane = new Map(lanes.map(group => [group.lane, group]))
  const other: TeamSession[] = []
  for (const session of teams.sessions) {
    if (session.lane === null) { other.push(session); continue }
    let group = byLane.get(session.lane)
    if (!group) {
      group = { lane: session.lane, launchNodeId: session.role === 'worker' ? session.node_id : null, worker: null, sessions: [] }
      lanes.push(group)
      byLane.set(session.lane, group)
    }
    if (group.launchNodeId === null && session.role === 'worker') group.launchNodeId = session.node_id
    group.sessions.push(session)
  }
  return { lanes, other }
}

/**
 * The paths a session's lane owns, when the owned-paths flag applies to it (3.7): only a `worker` session (ownership is enforced
 * at the worker handoff), and only when the inputs list its lane; null otherwise (no flag, nothing compared).
 */
export function ownedPathsOf(session: Pick<TeamSession, 'role' | 'lane'>, workers: readonly LaneWorker[] | null): readonly string[] | null {
  if (session.role !== 'worker' || session.lane === null || workers === null) return null
  return workers.find(worker => worker.node_id === session.lane)?.owned_paths ?? null
}

/** Whether an edited path is compared at all (3.7): a worktree-relative path; `/…`, `~…` and redacted paths are not compared. */
export function isComparablePath(path: string): boolean {
  return !path.startsWith('/') && !path.startsWith('~') && !path.includes('<path>') && !path.includes('<redacted>')
}

/** The controller's own `owns()` rule: `f` is inside when some owned `p` gives `f === p` or `f` starts with `p + '/'`. */
export function isOutside(path: string, owned: readonly string[]): boolean {
  if (!isComparablePath(path)) return false
  return !owned.some(prefix => path === prefix || path.startsWith(`${prefix.replace(/\/+$/, '')}/`))
}

/** The listed files (first 50; `files_edited_more` stays uncompared) an agent edited outside the owned paths; none when not owned. */
export function outsideFiles(agent: Pick<TeamAgent, 'files_edited'>, owned: readonly string[] | null): string[] {
  if (owned === null) return []
  return agent.files_edited.filter(path => isOutside(path, owned))
}

/** Every distinct file a session's agents edited outside its lane's paths. */
export function sessionOutsideFiles(session: TeamSession, owned: readonly string[] | null): string[] {
  if (owned === null) return []
  const files = new Set<string>()
  for (const workflow of session.workflows) for (const agent of workflow.agents) for (const path of outsideFiles(agent, owned)) files.add(path)
  return [...files]
}

/** The owned-paths copy (3.7), with the lane's own paths. */
export function outsideCopy(owned: readonly string[]): string {
  return `Edited outside this lane's paths. Verification refuses a changed file outside them. This lane owns: ${owned.join(', ')}.`
}

// ---- The quiet flag (3.7) ----------------------------------------------------------------------------------------------

export const QUIET_MS = 10 * 60_000

/** Whole minutes an agent has been quiet when the flag holds (running, a recorded last activity, 10 minutes or more before the read); null otherwise. */
export function quietMinutes(agent: Pick<TeamAgent, 'state' | 'last_activity_at'>, readAt: string): number | null {
  if (agent.state !== 'running') return null
  const last = instant(agent.last_activity_at)
  const read = instant(readAt)
  if (last === null || read === null || read - last < QUIET_MS) return null
  return Math.floor((read - last) / 60_000)
}

// ---- Words -------------------------------------------------------------------------------------------------------------

/** A workflow's name, else its run id (shown in mono by the page). */
export const workflowName = (workflow: Pick<TeamWorkflow, 'name' | 'run_id'>): string => workflow.name ?? workflow.run_id

/** A duration in spoken words, for accessible names: "4 minutes", "1 hour 12 minutes", "40 seconds". */
export function spokenSpan(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return plural(seconds, 'second', 'seconds')
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return plural(minutes, 'minute', 'minutes')
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? plural(hours, 'hour', 'hours') : `${plural(hours, 'hour', 'hours')} ${plural(rest, 'minute', 'minutes')}`
}

/**
 * The Team code's clock (docs/PRD_RUN_TEAMS.md 2 "Polling"): the page's clock, never earlier than the read it shows, so "read …
 * ago" never runs backwards when the read is newer than the last tick.
 */
export function teamClockOf(teams: Pick<Teams, 'read_at'>, clock: number): number {
  const read = instant(teams.read_at)
  return read === null ? clock : Math.max(clock, read)
}

/**
 * Where a running duration stops once the run finished (`live` false): the read the records come from. The records may still say
 * running (a workflow is marked interrupted only after 15 quiet minutes), but the page does not count on past the read. Null
 * while the run is live (durations follow the clock).
 */
export function frozenAtOf(teams: Pick<Teams, 'read_at'>, live: boolean): number | null {
  return live ? null : instant(teams.read_at)
}

/** The end of a running span: the clock, or once the run finished the later of the record's last activity and the read. */
function runningEnd(lastActivity: string | null | undefined, clock: number, frozenAt: number | null): number {
  if (frozenAt === null) return clock
  return Math.max(frozenAt, instant(lastActivity) ?? -Infinity)
}

/**
 * How long an agent ran: while running, from `started_at` to now (or, once the run finished, to the read: `frozenAt`); else its
 * recorded `duration_ms`; null when not recorded.
 */
export function agentRanMs(agent: Pick<TeamAgent, 'state' | 'started_at' | 'duration_ms'> & { last_activity_at?: string | null }, clock: number, frozenAt: number | null = null): number | null {
  if (agent.state === 'running') {
    const start = instant(agent.started_at)
    if (start !== null) return Math.max(0, runningEnd(agent.last_activity_at, clock, frozenAt) - start)
  }
  return agent.duration_ms
}

/** The suffix of a running span counted only up to the read (the run finished). */
export const AT_LAST_READ = 'at last read'

/** The roster's Ran cell (3.5): "for 4m10s" while running ("for 4m10s at last read" once the run finished), else the span; null ("not recorded") when nothing is recorded. */
export function agentRanText(agent: Pick<TeamAgent, 'state' | 'started_at' | 'duration_ms'> & { last_activity_at?: string | null }, clock: number, frozenAt: number | null = null): string | null {
  const ms = agentRanMs(agent, clock, frozenAt)
  if (ms === null) return null
  if (agent.state !== 'running') return formatSpan(ms)
  return frozenAt === null || agent.started_at === null ? `for ${formatSpan(ms)}` : `for ${formatSpan(ms)} ${AT_LAST_READ}`
}

/** The count line of a phase or a group: its non-zero counts ("1 running · 1 done"), "not started" when every count is zero. */
export function countsText(counts: Pick<TeamPhase, 'running' | 'failed' | 'interrupted' | 'done' | 'queued'>): string {
  const parts: string[] = []
  if (counts.running > 0) parts.push(`${counts.running} running`)
  if (counts.failed > 0) parts.push(`${counts.failed} failed`)
  if (counts.interrupted > 0) parts.push(`${counts.interrupted} interrupted`)
  if (counts.done > 0) parts.push(`${counts.done} done`)
  if (counts.queued > 0) parts.push(`${counts.queued} queued`)
  return parts.length === 0 ? 'not started' : parts.join(' · ')
}

type Counts = { agents: number; queued: number; running: number; done: number; failed: number; interrupted: number }

/** Counts agents by state. */
export function countAgents(agents: readonly Pick<TeamAgent, 'state'>[]): Counts {
  const counts: Counts = { agents: agents.length, queued: 0, running: 0, done: 0, failed: 0, interrupted: 0 }
  for (const agent of agents) counts[agent.state] += 1
  return counts
}

/** The phase title an agent's phase index names, else its own phase text, else null. */
function phaseTitleOf(agent: Pick<TeamAgent, 'phase' | 'phase_index'>, phases: readonly TeamPhase[]): string | null {
  if (agent.phase_index !== null) {
    const phase = phases.find(entry => entry.index === agent.phase_index)
    if (phase) return phase.title
  }
  return agent.phase
}

/** Distinct values in first-seen order. */
const distinct = <T,>(values: Iterable<T>): T[] => [...new Set(values)]

// ---- The attention line (3.2) ------------------------------------------------------------------------------------------

/** A line in a tone (null: no tone, plain text) with its glyph's tone. */
export type ToneLine = { text: string; tone: Tone | null }

export type AttentionContext = {
  /** The paths a session's lane owns, when the flag applies; null otherwise. */
  owned: (session: TeamSession) => readonly string[] | null
  /** Whether a session's lead is still running (the sessions payload, else the launch step). */
  running: (session: TeamSession) => boolean
  readAt: string
  clock: number
}

/**
 * A lane's attention line (3.2): the first two rules that hold, joined by " · ", the first setting the glyph and tone; null
 * when none holds (a lane whose only session has not started, or a workflow that runs between agents with nothing to say).
 */
export function attentionLine(sessions: readonly TeamSession[], context: AttentionContext): ToneLine | null {
  const rules = attentionRules(sessions, context)
  if (rules.length === 0) return null
  return { text: rules.slice(0, 2).map(rule => rule.text).join(' · '), tone: rules[0].tone }
}

/** Every rule of the 3.2 table that holds, in table order. */
export function attentionRules(sessions: readonly TeamSession[], context: AttentionContext): ToneLine[] {
  const rules: ToneLine[] = []
  const unreadable = sessions.find(session => session.records === 'unreadable')
  if (unreadable) rules.push({ text: `Team records could not be read: ${unreadable.reason ?? 'no reason recorded'}.`, tone: 'idle' })
  const workflows = sessions.flatMap(session => session.workflows)
  const failedPhases: string[] = []
  let failed = 0
  for (const workflow of workflows) for (const agent of workflow.agents) if (agent.state === 'failed') {
    failed += 1
    const title = phaseTitleOf(agent, workflow.phases)
    if (title !== null) failedPhases.push(title)
  }
  if (failed > 0) {
    const phases = distinct(failedPhases)
    rules.push({ text: `${plural(failed, 'agent', 'agents')} failed${phases.length ? ` in ${phases.join(', ')}` : ''}`, tone: 'fail' })
  }
  const interrupted = workflows.find(workflow => workflow.status === 'interrupted')
  if (interrupted) {
    const phase = lastActivePhase(interrupted)
    rules.push({ text: `${workflowName(interrupted)} was interrupted${phase ? ` in ${phase}` : ''}; no summary was written`, tone: 'pause' })
  }
  const outside = new Set<string>()
  for (const session of sessions) for (const path of sessionOutsideFiles(session, context.owned(session))) outside.add(path)
  if (outside.size > 0) rules.push({ text: `${plural(outside.size, 'file', 'files')} edited outside this lane's paths`, tone: 'fail' })
  const running: { phase: string | null; index: number }[] = []
  for (const workflow of workflows) for (const agent of workflow.agents) if (agent.state === 'running') running.push({ phase: phaseTitleOf(agent, workflow.phases), index: agent.phase_index ?? Number.MAX_SAFE_INTEGER })
  if (running.length > 0) {
    const phases = distinct([...running].sort((a, b) => a.index - b.index).map(entry => entry.phase).filter((phase): phase is string => phase !== null))
    const where = phases.length === 0 ? '' : ` in ${phases.slice(0, 2).join(', ')}${phases.length > 2 ? ` +${phases.length - 2}` : ''}`
    const last = latestActivity(workflows)
    rules.push({ text: `${running.length} running${where}${last ? ` · last activity ${formatAgo(last, context.clock)}` : ''}`, tone: 'run' })
  }
  const quiet = workflows.flatMap(workflow => workflow.agents.map(agent => quietMinutes(agent, context.readAt)).filter((minutes): minutes is number => minutes !== null))
  if (quiet.length > 0) rules.push({ text: `${quiet.length} quiet for ${Math.min(...quiet)}m or more`, tone: null })
  const killed = workflows.find(workflow => workflow.status === 'killed')
  if (killed) rules.push({ text: `${workflowName(killed)} was killed`, tone: 'idle' })
  if (workflows.length > 0 && workflows.every(workflow => workflow.status === 'completed')) {
    const agents = workflows.reduce((sum, workflow) => sum + workflow.agent_count, 0)
    const ran = workflowsRanMs(workflows)
    rules.push({ text: `Done · ${plural(workflows.length, 'workflow', 'workflows')} · ${plural(agents, 'agent', 'agents')} · ${ran === null ? 'workflow time not recorded' : `${formatSpan(ran)} of workflow time`}`, tone: 'ok' })
  }
  const found = sessions.some(session => session.records === 'found')
  if (!found && sessions.some(session => session.records === 'none')) {
    rules.push(sessions.some(session => session.records === 'none' && context.running(session))
      ? { text: 'No team workflow recorded yet; the lead session is working on its own.', tone: 'idle' }
      : { text: 'Single session, no team records.', tone: null })
  }
  return rules
}

/** The phase a workflow last worked in: the highest phase holding an interrupted or running agent, else the highest phase any agent reached. */
function lastActivePhase(workflow: TeamWorkflow): string | null {
  const active = [...workflow.phases].sort((a, b) => b.index - a.index)
  const stopped = active.find(phase => phase.interrupted > 0 || phase.running > 0) ?? active.find(phase => phase.agents > 0)
  if (stopped) return stopped.title
  return workflow.agents.map(agent => agent.phase).filter((phase): phase is string => phase !== null).at(-1) ?? null
}

/** The latest `last_activity_at` of the workflows (or their agents), null when none is recorded. */
export function latestActivity(workflows: readonly TeamWorkflow[]): string | null {
  let best: string | null = null
  let bestAt = -Infinity
  const consider = (iso: string | null) => {
    const at = instant(iso)
    if (at !== null && at > bestAt) { bestAt = at; best = iso }
  }
  for (const workflow of workflows) {
    consider(workflow.last_activity_at)
    for (const agent of workflow.agents) consider(agent.last_activity_at)
  }
  return best
}

/**
 * How long a set of ended workflows ran: the sum of their recorded durations (workflow time, not wall-clock: workflows of one lane
 * may overlap or leave gaps, so the page says "of workflow time"); null when any is not recorded.
 */
function workflowsRanMs(workflows: readonly TeamWorkflow[]): number | null {
  let total = 0
  for (const workflow of workflows) {
    if (workflow.duration_ms === null) return null
    total += workflow.duration_ms
  }
  return total
}

// ---- Session bodies (3.2) ----------------------------------------------------------------------------------------------

/** A session block's sentence when it holds no workflow cards (3.2); null for `found`. */
export function sessionSentence(session: TeamSession, running: boolean): string | null {
  if (session.records === 'unreadable') return `Team records could not be read: ${session.reason ?? 'no reason recorded'}.`
  if (session.records === 'none') {
    return running
      ? 'No team workflow recorded yet; the lead session is working on its own.'
      : 'Single session, no team records. This session ran on its own; its row is in the Sessions table.'
  }
  return null
}

// ---- Workflow cards (3.3) ----------------------------------------------------------------------------------------------

/** Whether a card starts expanded: the latest card and every running, failed or interrupted one. */
export function cardStartsOpen(workflow: Pick<TeamWorkflow, 'status'>, latest: boolean): boolean {
  return latest || workflow.status === 'running' || workflow.status === 'failed' || workflow.status === 'interrupted'
}

/** Where a card's facts come from (3.3): the final summary, or the live records with the age of the read. */
export function recordSource(workflow: Pick<TeamWorkflow, 'record'>, readAt: string, clock: number): string {
  return workflow.record === 'final' ? 'from the final summary' : `from the live records, read ${formatAgo(readAt, clock)}`
}

/** The card's facts line (3.3) after the start time, each part a fact or "… not recorded". */
export function workflowFacts(workflow: TeamWorkflow, clock: number, frozenAt: number | null = null): string[] {
  let duration: string
  if (workflow.status === 'running') {
    const start = instant(workflow.started_at)
    const span = start === null ? null : formatSpan(Math.max(0, runningEnd(workflow.last_activity_at, clock, frozenAt) - start))
    duration = span === null ? 'duration not recorded' : frozenAt === null ? `for ${span}` : `for ${span} ${AT_LAST_READ}`
  } else duration = workflow.duration_ms === null ? 'duration not recorded' : `ran ${formatSpan(workflow.duration_ms)}`
  const agents = workflow.agents_more > 0 ? `${workflow.agents.length} of ${workflow.agent_count} agents listed` : `${workflow.agent_count} agents`
  const tools = workflow.tool_calls === null ? 'tool calls not recorded' : `${workflow.tool_calls.toLocaleString('en-US')} tool calls`
  const context = workflow.context_tokens !== null
    ? `context ${workflow.context_tokens.toLocaleString('en-US')}`
    : workflow.status === 'running' ? 'context arrives with the final summary' : 'context not recorded'
  const model = workflow.default_model === null ? 'default model not recorded' : `default model ${workflow.default_model}`
  return [duration, agents, tools, context, model]
}

/** The line under the facts by status (3.3); null while running (the caption sits under the phase strip). */
export function workflowStatusLine(workflow: Pick<TeamWorkflow, 'status' | 'error'>): ToneLine | null {
  switch (workflow.status) {
    case 'running': return null
    case 'completed': return { text: "Workflow completed; the lane's verification is separate.", tone: null }
    case 'failed': return workflow.error ? { text: workflow.error, tone: 'fail' } : { text: 'The summary records no error text.', tone: null }
    case 'killed': return { text: 'This workflow was stopped before it finished (the summary says killed). Agents still running then show interrupted.', tone: null }
    case 'interrupted': return { text: 'No summary was written and its records have not changed for 15 minutes: the lead session stopped or went quiet before the workflow finished.', tone: null }
  }
}

export const RUNNING_CAPTION = 'Agents waiting to start are not recorded until they start.'

// ---- Phase strip (3.4) -------------------------------------------------------------------------------------------------

export type PhaseSegment = { index: number; title: string; detail: string | null; tone: Tone; word: string; counts: string; notStarted: boolean }

/** The strip's segments in `index` order: tone by precedence, the non-zero counts, "not started" (dashed) when every count is zero. */
export function phaseSegments(phases: readonly TeamPhase[]): PhaseSegment[] {
  return [...phases].sort((a, b) => a.index - b.index).map(phase => {
    const { tone, word } = phaseTone(phase)
    const counts = countsText(phase)
    return { index: phase.index, title: phase.title, detail: phase.detail, tone, word, counts, notStarted: counts === 'not started' }
  })
}

// ---- Roster: groups, filters and folding (3.5) -------------------------------------------------------------------------

/** A group starts open at or under this many agents. */
export const FOLD_AT = 6
/** An open group renders at most this many rows, then "Show {m} more". */
export const ROW_LIMIT = 20
/** The filters appear when a workflow lists more agents than this. */
export const FILTERS_FROM = 12

export type RosterGroup = {
  /** The phase index, null for "No phase recorded". */
  index: number | null
  title: string
  agents: TeamAgent[]
  counts: string
  /** First `started_at` to last `last_activity_at`, when both are recorded. */
  spanMs: number | null
  startsOpen: boolean
}

/** Groups agents by `phase_index` in index order, "No phase recorded" last; rows keep `index` order inside a group. */
export function rosterGroups(workflow: Pick<TeamWorkflow, 'phases' | 'agents'>, agents: readonly TeamAgent[] = workflow.agents): RosterGroup[] {
  const groups = new Map<number | null, TeamAgent[]>()
  for (const agent of [...agents].sort((a, b) => a.index - b.index)) {
    const key = agent.phase_index
    const list = groups.get(key) ?? []
    list.push(agent)
    groups.set(key, list)
  }
  const keys = [...groups.keys()].sort((a, b) => (a === null ? 1 : b === null ? -1 : a - b))
  return keys.map(key => {
    const list = groups.get(key)!
    const phase = key === null ? null : workflow.phases.find(entry => entry.index === key) ?? null
    const title = key === null ? 'No phase recorded' : `${key} · ${phase?.title ?? list.find(agent => agent.phase !== null)?.phase ?? `Phase ${key}`}`
    const counts = countAgents(list)
    const starts = list.map(agent => instant(agent.started_at)).filter((value): value is number => value !== null)
    const lasts = list.map(agent => instant(agent.last_activity_at)).filter((value): value is number => value !== null)
    const spanMs = starts.length > 0 && lasts.length > 0 ? Math.max(0, Math.max(...lasts) - Math.min(...starts)) : null
    const startsOpen = counts.running + counts.failed + counts.interrupted > 0 || list.length <= FOLD_AT
    return { index: key, title, agents: list, counts: countsText(counts), spanMs, startsOpen }
  })
}

/** The roster's filter: one state (null for All), a phase index, the search text, the outside-paths toggle and one role (P2 item 15). */
export type RosterFilter = { state: AgentState | null; phase: number | null; q: string; outside: boolean; role: string | null }

export const NO_FILTER: RosterFilter = { state: null, phase: null, q: '', outside: false, role: null }

/** The roster filter the URL holds for a workflow: the query's state, phase and search apply where it names this workflow (or none). */
export function filterFor(query: { session: string | null; workflow: string | null; state: AgentState | null; phase: number | null; q: string }, session: Pick<TeamSession, 'key'>, workflow: Pick<TeamWorkflow, 'run_id'>, outside: boolean, role: string | null = null): RosterFilter {
  const applies = (query.workflow === null || query.workflow === workflow.run_id) && (query.session === null || query.session === session.key)
  return applies ? { state: query.state, phase: query.phase, q: query.q, outside, role } : { ...NO_FILTER, outside, role }
}

/** An id-safe form of a session key or workflow id. */
export const idPart = (text: string): string => text.replace(/[^A-Za-z0-9_-]/g, '-')

/** The key a drawer's opener is found by when the focus returns to it. */
export const agentKey = (sessionKey: string, workflowId: string, index: number): string => `${sessionKey}|${workflowId}|${index}`

/** Whether a filter narrows the roster. */
export const filterActive = (filter: RosterFilter): boolean => filter.state !== null || filter.phase !== null || filter.q.trim() !== '' || filter.outside || filter.role !== null

/** Whether an agent matches the filter: its state, its phase, the outside toggle and the search over label, role, `#index`, agent id and edited path. */
export function agentMatches(agent: TeamAgent, filter: RosterFilter, owned: readonly string[] | null): boolean {
  if (filter.state !== null && agent.state !== filter.state) return false
  if (filter.phase !== null && agent.phase_index !== filter.phase) return false
  if (filter.outside && outsideFiles(agent, owned).length === 0) return false
  if (filter.role !== null && agent.role !== filter.role) return false
  const q = filter.q.trim().toLowerCase()
  if (q === '') return true
  const hay = [agent.label, agent.role ?? '', `#${agent.index}`, agent.agent_id ?? '', ...agent.files_edited].map(text => text.toLowerCase())
  return hay.some(text => text.includes(q))
}

/** The roster in shown order (groups in index order, rows in `index` order), narrowed by the filter: Previous and Next walk it. */
export function filteredAgents(workflow: Pick<TeamWorkflow, 'phases' | 'agents'>, filter: RosterFilter, owned: readonly string[] | null): TeamAgent[] {
  const matching = workflow.agents.filter(agent => agentMatches(agent, filter, owned))
  return rosterGroups(workflow, matching).flatMap(group => group.agents)
}

/** The state choices (3.5): All, then each state with agents, in the spec's order. */
export function stateChoices(agents: readonly TeamAgent[]): { state: AgentState | null; label: string; count: number }[] {
  const counts = countAgents(agents)
  const order: [AgentState, string][] = [['running', 'Running'], ['failed', 'Failed'], ['interrupted', 'Interrupted'], ['queued', 'Queued'], ['done', 'Done']]
  return [{ state: null, label: 'All', count: agents.length }, ...order.filter(([state]) => counts[state] > 0).map(([state, label]) => ({ state, label, count: counts[state] }))]
}

/** The role filter (11 P2 item 15) appears when a workflow's agents carry this many distinct roles or more. */
export const ROLES_FROM = 3

/**
 * The role chips (P2 item 15): one per distinct `agent.role`, in the order roles first appear in `index` order (so the chips
 * never move when the page polls), with their agent counts; none when fewer than three roles are recorded. Agents without a
 * role are only counted under All.
 */
export function roleChoices(agents: readonly Pick<TeamAgent, 'role' | 'index'>[]): { role: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const agent of [...agents].sort((a, b) => a.index - b.index)) {
    if (agent.role === null) continue
    counts.set(agent.role, (counts.get(agent.role) ?? 0) + 1)
  }
  return counts.size < ROLES_FROM ? [] : [...counts].map(([role, count]) => ({ role, count }))
}

/** The duration bar's full width (P2 item 14): 48 × 6 px. */
export const BAR_WIDTH = 48

/** The longest recorded `duration_ms` of a workflow's agents, the duration bars' full scale; null when none is recorded. */
export function longestDuration(agents: readonly Pick<TeamAgent, 'duration_ms'>[]): number | null {
  const recorded = agents.map(agent => agent.duration_ms).filter((ms): ms is number => ms !== null)
  return recorded.length === 0 ? null : Math.max(...recorded)
}

/**
 * An agent's inline duration bar (P2 item 14): its `duration_ms` over the workflow's longest, as a fraction from 0 to 1. Null
 * (no bar) when its duration is not recorded; a running agent's growing span is not drawn, so the scale never moves under
 * the pointer. There is no time axis.
 */
export function durationFraction(agent: Pick<TeamAgent, 'duration_ms'>, longest: number | null): number | null {
  if (agent.duration_ms === null || longest === null) return null
  return longest <= 0 ? 0 : Math.min(1, Math.max(0, agent.duration_ms / longest))
}

/**
 * The scope line while a filter narrows the roster: "Showing 5 of 61 agents", or, when the reader listed only part of the team
 * (`ran` above `total`), "Showing 6 of 400 listed agents (512 ran)".
 */
export const scopeLine = (shown: number, total: number, ran: number = total): string =>
  ran > total ? `Showing ${shown} of ${total} listed agents (${ran} ran)` : `Showing ${shown} of ${plural(total, 'agent', 'agents')}`

/** The rows "Show {m} more" adds to an open group: the next 20, or what is left. */
export const moreStep = (shown: number, total: number): number => Math.max(0, Math.min(ROW_LIMIT, total - shown))

/** The last line when the reader listed only the first 400. */
export const moreAgentsLine = (more: number): string => `${more} more agents are not listed; the reader lists the first 400.`

/** At most 60 characters of the last tool's summary, one line. */
export function toolSummary(agent: Pick<TeamAgent, 'last_tool' | 'last_tool_summary'>): string | null {
  if (agent.last_tool === null) return null
  const summary = agent.last_tool_summary?.replace(/\s+/g, ' ').trim() ?? ''
  const cut = summary.length > 60 ? `${summary.slice(0, 59)}…` : summary
  return cut === '' ? agent.last_tool : `${agent.last_tool} · ${cut}`
}

/** The edited-files count of an agent: the listed files plus those not listed. */
export const filesCount = (agent: Pick<TeamAgent, 'files_edited' | 'files_edited_more'>): number => agent.files_edited.length + agent.files_edited_more

/**
 * An agent row's accessible name (10): "impl:frontend #3, running, Implement, 4 minutes, 96 tool calls, 2 files outside lane
 * paths"; facts the records lack are left out rather than guessed.
 */
export function agentName(agent: TeamAgent, phases: readonly TeamPhase[], clock: number, outside: number, readAt?: string): string {
  const ran = agentRanMs(agent, clock)
  const quiet = readAt === undefined ? null : quietMinutes(agent, readAt)
  return [
    `${agent.label} #${agent.index}`,
    agent.state,
    agent.cached ? 'replayed' : null,
    phaseTitleOf(agent, phases),
    ran === null ? null : spokenSpan(ran),
    agent.tool_calls === null ? null : plural(agent.tool_calls, 'tool call', 'tool calls'),
    outside > 0 ? `${plural(outside, 'file', 'files')} outside lane paths` : null,
    quiet === null ? null : `quiet ${quiet} minutes`,
  ].filter(Boolean).join(', ')
}

/** An agent's phase title (the strip's), else its own phase text, else null. */
export const agentPhase = (agent: TeamAgent, phases: readonly TeamPhase[]): string | null => phaseTitleOf(agent, phases)

/** The drawer's "Returned" text when no result is recorded (3.8). */
export function noResultText(agent: Pick<TeamAgent, 'state'>): string {
  if (agent.state === 'running') return 'No result yet.'
  if (agent.state === 'failed') return 'failed · no reason recorded'
  if (agent.state === 'interrupted') return 'never finished'
  return 'not recorded'
}

/** An agent's tone and word (the contract's own state word). */
export const agentState = agentTone

// ---- Working now (3.6) -------------------------------------------------------------------------------------------------

export type WorkingRow = { session: TeamSession; workflow: TeamWorkflow; agent: TeamAgent }

/** Every running agent across every session, sorted by `started_at` (unrecorded last), then `index`, so the order is stable. */
export function workingRows(teams: Teams): WorkingRow[] {
  const rows: WorkingRow[] = []
  for (const session of teams.sessions) for (const workflow of session.workflows) for (const agent of workflow.agents) if (agent.state === 'running') rows.push({ session, workflow, agent })
  const at = (row: WorkingRow) => instant(row.agent.started_at) ?? Number.MAX_SAFE_INTEGER
  return rows.sort((a, b) => at(a) - at(b) || a.agent.index - b.agent.index)
}

/** The number of distinct lanes (sessions without a lane count by their own key). */
const laneCount = (sessions: readonly TeamSession[]): number => new Set(sessions.map(session => session.lane ?? `session:${session.key}`)).size

/** "Working now · {n} running in {L} lane(s)". */
export function workingTitle(rows: readonly WorkingRow[]): string {
  return `Working now · ${rows.length} running in ${plural(laneCount(rows.map(row => row.session)), 'lane', 'lanes')}`
}

/** The phone's folded head line: "5 running · 1 failed ›". */
export function workingFoldLine(teams: Teams): string {
  return `${teams.totals.running} running${teams.totals.failed > 0 ? ` · ${teams.totals.failed} failed` : ''} ›`
}

/**
 * The panel's one line when no agent runs (3.6): the run live with workflows, the run finished, or null when no session has
 * team records (the panel is absent).
 */
export function idleLine(teams: Teams, live: boolean, clock: number): string | null {
  if (teams.totals.sessions_with_teams === 0) return null
  const sessions = teams.sessions.filter(session => session.workflows.length > 0)
  if (live) {
    const last = latestActivity(sessions.flatMap(session => session.workflows))
    return `Nothing is running in any team. Last activity ${last === null ? 'not recorded' : formatAgo(last, clock)}.`
  }
  return `Nobody is working. ${plural(teams.totals.workflows, 'team workflow', 'team workflows')} ran in ${plural(laneCount(sessions), 'lane', 'lanes')}.`
}

// ---- The view's head (3.1) ---------------------------------------------------------------------------------------------

/** The agents the team ran (the sum of `agent_count`) and how many of them the reader listed (`agents.length`). */
export function agentTotals(workflows: readonly Pick<TeamWorkflow, 'agent_count' | 'agents' | 'agents_more'>[]): { ran: number; listed: number; more: boolean } {
  let ran = 0
  let listed = 0
  let more = false
  for (const workflow of workflows) {
    ran += workflow.agent_count
    listed += workflow.agents.length
    if (workflow.agents_more > 0) more = true
  }
  return { ran, listed, more }
}

/**
 * The head sentence: "3 lanes · 2 with teams · 4 workflows · 61 agents · 5 running now · read 8 s ago" ("400 of 512 agents
 * listed" when the reader listed only part of a workflow), or the no-teams sentence. Unreadable records are never told as single
 * sessions: "Team records of 1 session could not be read", with the single-session claim kept for records `none` only.
 */
export function headSentence(teams: Teams, lanes: readonly LaneGroup[], clock: number): string {
  if (teams.totals.sessions_with_teams === 0) {
    const unreadable = teams.sessions.filter(session => session.records === 'unreadable').length
    if (unreadable === 0) return 'No session of this run has team records; every worker ran as a single session.'
    const none = teams.sessions.filter(session => session.records === 'none').length
    const read = `Team records of ${plural(unreadable, 'session', 'sessions')} could not be read`
    return none === 0 ? `${read}.` : `${read}; ${plural(none, 'other session', 'other sessions')} ran as a single session.`
  }
  const withTeams = lanes.filter(lane => lane.sessions.some(session => session.records === 'found')).length
  const totals = agentTotals(teams.sessions.flatMap(session => session.workflows))
  return [
    plural(lanes.length, 'lane', 'lanes'),
    `${withTeams} with ${withTeams === 1 ? 'a team' : 'teams'}`,
    plural(teams.totals.workflows, 'workflow', 'workflows'),
    totals.more ? `${totals.listed} of ${plural(totals.ran, 'agent', 'agents')} listed` : plural(totals.ran, 'agent', 'agents'),
    `${teams.totals.running} running now`,
    `read ${formatAgo(teams.read_at, clock)}`,
  ].join(' · ')
}

export const CONTEXT_NOTE = "Context is each agent's last context size, not spend. The lead session's cost in the Sessions table covers its agents."

/** "6 other sessions ran without a team." */
export const otherSessionsLine = (count: number): string => `${plural(count, 'other session', 'other sessions')} ran without a team.`

/** Whether the other sessions get their own panel: one of them has records `found` or `unreadable`. */
export const otherSessionsPanel = (sessions: readonly TeamSession[]): boolean => sessions.some(session => session.records !== 'none')

// ---- Run view integration (5) ------------------------------------------------------------------------------------------

/** What a step card adds for its team (5); null when the node's sessions have no records `found`. */
export type StageTeam = {
  workflows: number
  agents: number
  running: number
  failed: number
  /** Distinct files edited outside the lane's paths (the worker session only). */
  outside: number
  /** Row four while an agent runs: "{phase} · {label} · {last_tool}: {summary}" of the most recently active running agent. */
  agentLine: string | null
  /** The finished-run caption (`workingCaption`) while the records still say an agent runs; null otherwise. */
  caption: string | null
}

/** The sessions of a node (`session.node_id`), in payload order. */
export const teamSessionsOf = (teams: Teams | null, nodeId: string): TeamSession[] => teams === null ? [] : teams.sessions.filter(session => session.node_id === nodeId)

/** A step card's team facts (5), from the node's sessions with records `found`; null otherwise (the card renders as today). */
export function stageTeam(teams: Teams | null, nodeId: string, workers: readonly LaneWorker[] | null, live = true): StageTeam | null {
  const sessions = teamSessionsOf(teams, nodeId).filter(session => session.records === 'found')
  if (sessions.length === 0) return null
  const workflows = sessions.flatMap(session => session.workflows)
  const agents = workflows.flatMap(workflow => workflow.agents.map(agent => ({ agent, workflow })))
  const outside = new Set<string>()
  for (const session of sessions) for (const path of sessionOutsideFiles(session, ownedPathsOf(session, workers))) outside.add(path)
  const running = agents.filter(entry => entry.agent.state === 'running')
  const latest = [...running].sort((a, b) => (instant(b.agent.last_activity_at) ?? -Infinity) - (instant(a.agent.last_activity_at) ?? -Infinity))[0]
  let agentLine: string | null = null
  if (latest) {
    const phase = phaseTitleOf(latest.agent, latest.workflow.phases)
    const tool = latest.agent.last_tool === null ? null : `${latest.agent.last_tool}${latest.agent.last_tool_summary ? `: ${latest.agent.last_tool_summary}` : ''}`
    agentLine = [phase, latest.agent.label, tool].filter(Boolean).join(' · ')
  }
  return {
    workflows: workflows.length,
    agents: workflows.reduce((sum, workflow) => sum + workflow.agent_count, 0),
    running: running.length,
    failed: agents.filter(entry => entry.agent.state === 'failed').length,
    outside: outside.size,
    agentLine,
    caption: !live && running.length > 0 ? FINISHED_RUNNING_CAPTION : null,
  }
}

/** The card's accessible-name suffix: "team of 8 agents, 1 running, 1 failed" (and the finished-run caption when it applies). */
export const stageTeamName = (team: StageTeam): string => `team of ${plural(team.agents, 'agent', 'agents')}, ${team.running} running, ${team.failed} failed${team.caption ? `. ${team.caption}` : ''}`

/** What the page says when the run finished but the records still say agents run (PRD App. A: 15 quiet minutes). */
export const FINISHED_RUNNING_CAPTION = 'The run has finished; these records still say running. The reader marks a workflow interrupted after 15 quiet minutes.'

/** The caption under Working now, in the dock row and the sheet's Team section: the finished-run note while an agent still reads running; null otherwise. */
export function workingCaption(teams: Pick<Teams, 'totals'> | null, live: boolean): string | null {
  return teams !== null && !live && teams.totals.running > 0 ? FINISHED_RUNNING_CAPTION : null
}

/** The live dock's row (5): agents running, else an interrupted workflow while the run is live; null otherwise (the row is absent). */
export type DockTeamLine = { kind: 'running'; text: string } | { kind: 'interrupted'; text: string }

export function dockTeamLine(teams: Teams | null, live: boolean, clock: number): DockTeamLine | null {
  if (teams === null || teams.totals.sessions_with_teams === 0) return null
  const rows = workingRows(teams)
  if (rows.length > 0) {
    const phases = distinct(rows.map(row => phaseTitleOf(row.agent, row.workflow.phases)).filter((phase): phase is string => phase !== null))
    const where = phases.length === 0 ? '' : ` · ${phases.slice(0, 2).join(', ')}${phases.length > 2 ? ` +${phases.length - 2}` : ''}`
    const last = latestActivity(rows.map(row => row.workflow))
    const lanes = laneCount(rows.map(row => row.session))
    return { kind: 'running', text: `Working now · ${plural(rows.length, 'agent', 'agents')} in ${plural(lanes, 'lane', 'lanes')}${where}${last ? ` · last activity ${formatAgo(last, clock)}` : ''} ›` }
  }
  if (live) {
    const session = teams.sessions.find(entry => entry.workflows.some(workflow => workflow.status === 'interrupted'))
    if (session) return { kind: 'interrupted', text: `A team workflow in ${session.lane ?? session.label} was interrupted · Team ›` }
  }
  return null
}

/** Spent's tooltip addition while the run has team records (5). */
export const SPENT_TEAM_NOTE = 'covers each lead session and its agents; per-agent cost is not recorded'

/** A Sessions row's team facts (5): "team · {w} workflows · {a} agents" for `found`, "team records not read" for `unreadable`; null otherwise. */
export function sessionTeamFacts(teams: Teams | null, key: string): { kind: 'found'; text: string } | { kind: 'unreadable'; text: string } | null {
  const session = teams?.sessions.find(entry => entry.key === key) ?? null
  if (session === null) return null
  if (session.records === 'unreadable') return { kind: 'unreadable', text: 'team records not read' }
  if (session.records !== 'found') return null
  const agents = session.workflows.reduce((sum, workflow) => sum + workflow.agent_count, 0)
  return { kind: 'found', text: `team · ${plural(session.workflows.length, 'workflow', 'workflows')} · ${plural(agents, 'agent', 'agents')}` }
}

/** The sheet's one line per workflow (5): "{a} agents · {k} running · for 12m". */
export function sheetWorkflowLine(workflow: TeamWorkflow, clock: number, frozenAt: number | null = null): string {
  const running = workflow.agents.filter(agent => agent.state === 'running').length
  const duration = workflowFacts(workflow, clock, frozenAt)[0]
  return [plural(workflow.agent_count, 'agent', 'agents'), running > 0 ? `${running} running` : null, duration].filter(Boolean).join(' · ')
}

/** The step sheet lists at most this many workflow lines. */
export const SHEET_WORKFLOWS = 3

/**
 * The workflow lines the step sheet lists (5): the running, failed and interrupted ones, then the latest, at most three, in
 * payload order; the rest are counted in one line ("and 11 more completed · Team ›"). `word` is "completed" only when every one
 * left out completed, else null ("and 2 more · Team ›").
 */
export function sheetWorkflowPick<T extends { workflow: Pick<TeamWorkflow, 'status'> }>(entries: readonly T[]): { shown: T[]; more: number; word: 'completed' | null } {
  const urgent = entries.filter(entry => entry.workflow.status === 'running' || entry.workflow.status === 'failed' || entry.workflow.status === 'interrupted')
  const picked = new Set<T>(urgent.slice(0, SHEET_WORKFLOWS))
  const latest = entries.at(-1)
  if (latest !== undefined && !picked.has(latest)) {
    if (picked.size >= SHEET_WORKFLOWS) picked.delete([...picked].at(-1)!)
    picked.add(latest)
  }
  const shown = entries.filter(entry => picked.has(entry))
  const rest = entries.filter(entry => !picked.has(entry))
  return { shown, more: rest.length, word: rest.every(entry => entry.workflow.status === 'completed') ? 'completed' : null }
}

/** Whether a node's sheet shows the Team section (5): a worker with any team session; another node only for records found or unreadable. */
export function sheetShowsTeam(sessions: readonly TeamSession[], worker: boolean): boolean {
  if (sessions.length === 0) return false
  return worker || sessions.some(session => session.records !== 'none')
}

// ---- Node page (6) -----------------------------------------------------------------------------------------------------

/**
 * The node page's index entry for the Team section (6): with the agents' count for a node whose sessions have records, without a
 * count for a records-`none` worker, and none when the node has no team session (or the teams were not read).
 */
/**
 * The node page's Team entry for any state of the teams read (6): a worker keeps its section (without a count) while the teams
 * load or after a failed read, so the section can say "Reading team records…" or offer Read again; once read it is
 * `teamSectionEntry`; a server that does not serve teams (ready with null) shows none.
 */
export function teamSectionEntryFor(status: 'idle' | 'loading' | 'ready' | 'error', teams: Teams | null, nodeId: string, worker: boolean): { count: number | null } | null {
  if (status !== 'ready') return worker ? { count: null } : null
  if (teams === null) return null
  return teamSectionEntry(teamSessionsOf(teams, nodeId), worker)
}

export function teamSectionEntry(sessions: readonly TeamSession[], worker: boolean): { count: number | null } | null {
  if (sessions.length === 0) return null
  const found = sessions.filter(session => session.records === 'found')
  if (found.length > 0) return { count: found.reduce((sum, session) => sum + session.workflows.reduce((total, workflow) => total + workflow.agent_count, 0), 0) }
  if (sessions.some(session => session.records === 'unreadable')) return { count: null }
  return worker ? { count: null } : null
}

// ---- Lane bodies, folded history and the drawer's walk (3.2, 3.3, 3.8) --------------------------------------------------

/**
 * The sentence of a lane panel without a team session (3.2). Pending: the lane has not started. Running or ended: the lane's
 * session has no Claude team records (it ran on pi or OpenRouter, or recorded no session id), not "not started"; when the
 * sessions payload has the lane's row the sentence points to it.
 */
export function laneNoSessionSentence(status: string, sessionRow: unknown): string {
  if (status === 'pending') return 'No Claude session of this lane has started yet.'
  const base = "This lane's session has no Claude team records (it ran on another transport or recorded no session id)"
  return sessionRow === null || sessionRow === undefined ? `${base}.` : `${base}; its row is in the Sessions table.`
}

/** A session holding more workflows than this tucks its older ended ones under "Show {n} earlier workflows". */
export const EARLIER_FROM = 4

/**
 * The workflows a session tucks under "Show {n} earlier workflows" (3.3): with more than four workflows, every completed or
 * killed one that is not the latest, in payload order. The latest and every running, failed or interrupted workflow stay out.
 */
export function earlierWorkflows<T extends Pick<TeamWorkflow, 'status' | 'run_id'>>(workflows: readonly T[]): T[] {
  if (workflows.length <= EARLIER_FROM) return []
  return workflows.slice(0, -1).filter(workflow => workflow.status === 'completed' || workflow.status === 'killed')
}

/** "Show 10 earlier workflows". */
export const earlierLine = (count: number): string => `Show ${count} earlier ${count === 1 ? 'workflow' : 'workflows'}`

/** A folded card's one-line facts (3.3): "6 agents · ran 41m27s". */
export function foldedFacts(workflow: TeamWorkflow, clock: number, frozenAt: number | null = null): string {
  return `${plural(workflow.agent_count, 'agent', 'agents')} · ${workflowFacts(workflow, clock, frozenAt)[0]}`
}

/** The script log disclosure's label (3.3): "Script log and result (12 lines · result)". */
export function logSummary(workflow: Pick<TeamWorkflow, 'logs' | 'result_preview'>): string {
  const parts = [workflow.logs.length > 0 ? plural(workflow.logs.length, 'line', 'lines') : null, workflow.result_preview !== null ? 'result' : null].filter(Boolean)
  return parts.length === 0 ? 'Script log and result' : `Script log and result (${parts.join(' · ')})`
}

/** The roster filters a card keeps outside the URL (the outside-paths toggle, the role chip), shared with the drawer's walk. */
export type RosterExtras = { outside: boolean; role: string | null }
export const NO_EXTRAS: RosterExtras = { outside: false, role: null }
/** The key of a card's extras: its session and workflow. */
export const extrasKey = (sessionKey: string, runId: string): string => `${sessionKey}|${runId}`

/**
 * The query an open lands on (3.8): the target's session, workflow and agent; the state, phase and search carry over only when
 * the query already named that workflow or named none (a view-wide search), else they reset so the opened agent is in the roster.
 */
export function openQuery<Q extends { session: string | null; workflow: string | null; agent: number | null; state: AgentState | null; phase: number | null; q: string }>(query: Q, sessionKey: string, runId: string, index: number): Q {
  const same = query.workflow === null || (query.workflow === runId && query.session === sessionKey)
  return { ...query, session: sessionKey, workflow: runId, agent: index, ...(same ? {} : { state: null, phase: null, q: '' }) }
}

/**
 * The query a card's filter change writes (3.5): the card's session and workflow with the new state, phase and search; an open
 * drawer of another workflow closes rather than jumping to the same index here.
 */
export function cardFilterQuery<Q extends { session: string | null; workflow: string | null; agent: number | null; state: AgentState | null; phase: number | null; q: string }>(query: Q, sessionKey: string, runId: string, filter: Pick<RosterFilter, 'state' | 'phase' | 'q'>): Q {
  const other = query.session !== sessionKey || query.workflow !== runId
  return { ...query, session: sessionKey, workflow: runId, state: filter.state, phase: filter.phase, q: filter.q, ...(other ? { agent: null } : {}) }
}

// ---- The view-wide search (3.5) ----------------------------------------------------------------------------------------

/** Whether a workflow lists an agent matching a view-wide search. */
export function workflowMatches(workflow: Pick<TeamWorkflow, 'agents'>, q: string): boolean {
  if (q.trim() === '') return false
  const filter = { ...NO_FILTER, q }
  return workflow.agents.some(agent => agentMatches(agent, filter, null))
}

/**
 * The view-wide search's scope line: "Showing 3 of 61 agents in 2 workflows", or "Showing 3 of 400 listed agents (512 ran) in 1
 * workflow" when the reader listed only part of a team.
 */
export function viewScopeLine(teams: Teams, q: string): string {
  const filter = { ...NO_FILTER, q }
  const workflows = teams.sessions.flatMap(session => session.workflows)
  let shown = 0
  let holding = 0
  for (const workflow of workflows) {
    const matches = workflow.agents.filter(agent => agentMatches(agent, filter, null)).length
    shown += matches
    if (matches > 0) holding += 1
  }
  const totals = agentTotals(workflows)
  const where = `in ${plural(holding, 'workflow', 'workflows')}`
  return totals.more
    ? `Showing ${shown} of ${totals.listed} listed agents (${totals.ran} ran) ${where}`
    : `Showing ${shown} of ${plural(totals.listed, 'agent', 'agents')} ${where}`
}

// ---- Needs a look (3.1) ------------------------------------------------------------------------------------------------

export type LookRow = {
  key: string
  kind: 'failed' | 'interrupted' | 'outside' | 'quiet' | 'unreadable'
  tone: Tone | null
  text: string
  session: TeamSession
  workflow: TeamWorkflow | null
  agent: TeamAgent | null
}

/**
 * The run-wide "Needs a look" rows, in this order: failed agents, interrupted workflows, agents that edited files outside their
 * lane's paths, quiet agents (words only, no tone) and sessions whose team records could not be read. Sessions are read in the
 * order given (the lanes, then the other sessions); empty when nothing needs a look (the panel is absent).
 */
export function needsALook(sessions: readonly TeamSession[], context: Pick<AttentionContext, 'owned' | 'readAt'>): LookRow[] {
  const failed: LookRow[] = []
  const interrupted: LookRow[] = []
  const outside: LookRow[] = []
  const quiet: LookRow[] = []
  const unreadable: LookRow[] = []
  for (const session of sessions) {
    const where = session.lane ?? session.label
    if (session.records === 'unreadable') {
      unreadable.push({ key: `unreadable|${session.key}`, kind: 'unreadable', tone: 'idle', text: `Team records of ${session.label} could not be read: ${session.reason ?? 'no reason recorded'}.`, session, workflow: null, agent: null })
    }
    const owned = context.owned(session)
    for (const workflow of session.workflows) {
      const name = workflowName(workflow)
      if (workflow.status === 'interrupted') {
        const phase = lastActivePhase(workflow)
        interrupted.push({ key: `interrupted|${session.key}|${workflow.run_id}`, kind: 'interrupted', tone: 'pause', text: `${name} was interrupted${phase ? ` in ${phase}` : ''}; no summary was written · ${where}`, session, workflow, agent: null })
      }
      for (const agent of workflow.agents) {
        const id = `${session.key}|${workflow.run_id}|${agent.index}`
        if (agent.state === 'failed') {
          const phase = phaseTitleOf(agent, workflow.phases)
          failed.push({ key: `failed|${id}`, kind: 'failed', tone: 'fail', text: `${agent.label} #${agent.index} failed${phase ? ` in ${phase}` : ''} · ${name} · ${where}`, session, workflow, agent })
        }
        const files = outsideFiles(agent, owned).length
        if (files > 0) outside.push({ key: `outside|${id}`, kind: 'outside', tone: 'fail', text: `${agent.label} #${agent.index} edited ${plural(files, 'file', 'files')} outside lane ${where}'s paths · ${name}`, session, workflow, agent })
        const minutes = quietMinutes(agent, context.readAt)
        if (minutes !== null) quiet.push({ key: `quiet|${id}`, kind: 'quiet', tone: null, text: `${agent.label} #${agent.index} quiet ${minutes}m · ${name} · ${where}`, session, workflow, agent })
      }
    }
  }
  return [...failed, ...interrupted, ...outside, ...quiet, ...unreadable]
}

// ---- The announcer (10) ------------------------------------------------------------------------------------------------

/**
 * What changed between two reads that the polite announcer says, in priority order: a workflow's status change, then a newly
 * failed agent. Nothing on the first read (no previous), never tool calls or counts.
 */
export function teamChanges(previous: Teams | null, next: Teams): string[] {
  if (previous === null) return []
  const before = new Map<string, TeamWorkflow>()
  for (const session of previous.sessions) for (const workflow of session.workflows) before.set(`${session.key}|${workflow.run_id}`, workflow)
  const statuses: string[] = []
  const failures: string[] = []
  for (const session of next.sessions) for (const workflow of session.workflows) {
    const old = before.get(`${session.key}|${workflow.run_id}`)
    if (old && old.status !== workflow.status) statuses.push(`Workflow ${workflowName(workflow)} in ${session.lane ?? session.label} ${workflow.status}`)
    const failedBefore = new Set((old?.agents ?? []).filter(agent => agent.state === 'failed').map(agent => agent.index))
    for (const agent of workflow.agents) if (agent.state === 'failed' && !failedBefore.has(agent.index) && old) {
      const phase = phaseTitleOf(agent, workflow.phases)
      failures.push(`${agent.label} #${agent.index} failed${phase ? ` in ${phase}` : ''}`)
    }
  }
  return [...statuses, ...failures]
}
