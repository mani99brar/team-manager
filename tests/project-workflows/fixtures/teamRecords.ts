/**
 * Claude Code's own records for a teams payload (docs/PRD_RUN_TEAMS.md "Team reader", "Team view"): the candidate-phase seed
 * of `ux-teams.ts` and the parity unit test (`tests/unit/teamsSeed.test.ts`) write, from the very payload the worker-phase mock
 * serves, the files `server/teams.ts` reads, so the real reader serves the same sessions, workflows and agents:
 *
 * - `<claudeHome>/projects/<slug>/<sid>.jsonl`, the lead session's transcript (a stub: the reader never opens it);
 * - a finished workflow's summary `<slug>/<sid>/workflows/wf_<id>.json` (`workflowProgress` with one `workflow_agent` entry per
 *   agent: `done`, `start` for a queued one, `progress` for an interrupted or failed one), plus, when an agent failed or edited
 *   files or called another provider, its live folder with the journal's `failed` lines and that agent's transcript;
 * - a live workflow's `<slug>/<sid>/subagents/workflows/wf_<id>/{journal.jsonl, agent-<id>.meta.json, agent-<id>.jsonl}` and
 *   its script `<slug>/<sid>/workflows/scripts/<name>-wf_<id>.js` with a `meta` literal (name, description, phase titles). Its
 *   files get the current time when the workflow runs (the reader's 15-minute window) and an old one when it is interrupted;
 *   `refreshRunningRecords` gives a running workflow's files the current time again before a browser check reads them.
 *
 * The shapes are the ones `server/teams.test.ts` writes. Times in the payload are the reader's ISO form (`…:00.000Z`); a live
 * workflow's `last_activity_at` comes from its journal's modification time on the server, so comparisons leave it out. The
 * session files of the run directory (`<lane>.interactive.json` with the session id and worktree, `<lane>.completion.json`,
 * `<lane>.cost.json`) are written by `writeLaneSessionFiles`, so the sessions and teams readers find the same sessions.
 * Paths stay under the given roots; nothing here reads or writes the operator's `~/.claude`.
 */
import { mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TeamAgent, TeamSession, TeamWorkflow, Teams } from '../../../contracts/projects/teams.ts'

/** A workflow's files when it is interrupted: older than the reader's 15-minute live window. */
export const STALE_RECORD_TIME = new Date('2026-10-16T09:00:00Z')

/** Claude Code's project folder name for a working directory: every character but a letter or digit becomes `-`. */
export const claudeSlug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-')

const json = (value: unknown) => `${JSON.stringify(value)}\n`
const epoch = (value: string | null) => (value === null ? undefined : Date.parse(value))

/** The provider a Bash command called, as `providersOfCommand` reads it back (`pi --model <m>`). */
const providerCommand = (provider: string) => `pi -p --model ${provider} "review the diff"`

type Tool = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

/** The tool calls that make an agent's edited files and providers: an Edit per file, a Bash per provider. */
function fileAndProviderTools(agent: TeamAgent, worktree: string): Tool[] {
  return [
    ...agent.files_edited.map((file, n): Tool => ({ type: 'tool_use', id: `e${n}`, name: 'Edit', input: { file_path: join(worktree, file) } })),
    ...agent.providers.map((provider, n): Tool => ({ type: 'tool_use', id: `p${n}`, name: 'Bash', input: { command: providerCommand(provider) } })),
  ]
}

const assistantLine = (sessionId: string, at: string, model: string | null, content: unknown[], usage?: Record<string, number>) => JSON.stringify({
  parentUuid: null, isSidechain: true, type: 'assistant', timestamp: at, sessionId,
  message: { ...(model !== null ? { model } : {}), ...(usage ? { usage } : {}), content },
})

/**
 * A live agent's transcript: the first line at `started_at` holds its Edits, its provider calls and fillers, the last at
 * `last_activity_at` holds its last tool and the usage that gives its context size and model. The agent must say all of it.
 */
function liveTranscript(sessionId: string, agent: TeamAgent, worktree: string): string {
  const { started_at: first, last_activity_at: last, tool_calls: calls, last_tool: lastTool, context_tokens: context } = agent
  const tools = fileAndProviderTools(agent, worktree)
  if (first === null || last === null || calls === null || lastTool === null || context === null || calls < tools.length + 1) {
    throw new Error(`live agent ${agent.label} #${agent.index} needs times, a last tool, a context size and tool calls >= its files and providers + 1`)
  }
  if (agent.duration_ms !== Date.parse(last) - Date.parse(first)) throw new Error(`live agent ${agent.label} #${agent.index}: duration_ms must be last - first`)
  const fillers = Array.from({ length: calls - 1 - tools.length }, (_, n): Tool => ({ type: 'tool_use', id: `r${n}`, name: 'Read', input: {} }))
  return [
    assistantLine(sessionId, first, agent.model, [{ type: 'text', text: 'Working on it.' }, ...tools, ...fillers]),
    JSON.stringify({ type: 'user', timestamp: first, message: { content: [{ type: 'tool_result', tool_use_id: 'r0', content: 'tool output stays on this machine' }] } }),
    assistantLine(sessionId, last, agent.model, [{ type: 'tool_use', id: 'last', name: lastTool, input: {} }], { input_tokens: context, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }),
  ].join('\n') + '\n'
}

/** A finished workflow's agent as one `workflow_agent` entry of the summary's `workflowProgress`. */
function progressEntry(agent: TeamAgent) {
  const state = agent.state === 'done' ? 'done' : agent.state === 'queued' ? 'start' : 'progress'
  const entry: Record<string, unknown> = {
    type: 'workflow_agent', index: agent.index, label: agent.label, phaseIndex: agent.phase_index ?? undefined, phaseTitle: agent.phase ?? undefined,
    agentId: agent.agent_id ?? undefined, model: agent.model ?? undefined, state, cached: agent.cached, attempt: agent.attempt ?? undefined,
    startedAt: epoch(agent.started_at), lastProgressAt: epoch(agent.last_activity_at), durationMs: agent.duration_ms ?? undefined,
    toolCalls: agent.tool_calls ?? undefined, tokens: agent.context_tokens ?? undefined, lastToolName: agent.last_tool ?? undefined,
    lastToolSummary: agent.last_tool_summary ?? undefined, promptPreview: agent.prompt_preview ?? undefined, resultPreview: agent.result_preview ?? undefined,
  }
  return JSON.parse(JSON.stringify(entry)) as Record<string, unknown>
}

/** The summary Claude Code writes when a workflow ends (`server/teams.test.ts` `summary`). */
function finalSummary(workflow: TeamWorkflow) {
  return {
    runId: workflow.run_id, taskId: `w${workflow.run_id.slice(3, 11)}`, timestamp: workflow.ended_at ?? undefined, startTime: epoch(workflow.started_at),
    durationMs: workflow.duration_ms ?? undefined, workflowName: workflow.name ?? undefined, summary: workflow.description ?? undefined,
    script: 'export const meta = {}', status: workflow.status === 'interrupted' ? 'aborted' : workflow.status, defaultModel: workflow.default_model ?? undefined,
    phases: workflow.phases.map(phase => (phase.detail === null ? { title: phase.title } : { title: phase.title, detail: phase.detail })),
    agentCount: workflow.agent_count, totalTokens: workflow.context_tokens ?? undefined, totalToolCalls: workflow.tool_calls ?? undefined,
    result: workflow.result_preview ?? undefined, logs: workflow.logs, error: workflow.error ?? undefined,
    workflowProgress: [
      ...workflow.phases.map(phase => ({ type: 'workflow_phase', index: phase.index, title: phase.title })),
      ...workflow.agents.map(progressEntry),
    ],
  }
}

/** A script whose `meta` literal declares the workflow's name, description and phase titles (parsed, never run, by the reader). */
function scriptSource(workflow: TeamWorkflow): string {
  const phases = workflow.phases.map(phase => `    { title: ${JSON.stringify(phase.title)}${phase.detail === null ? '' : `, detail: ${JSON.stringify(phase.detail)}`} },`)
  return [
    'export const meta = {',
    `  name: ${JSON.stringify(workflow.name)},`,
    `  description: ${JSON.stringify(workflow.description)},`,
    '  phases: [',
    ...phases,
    '  ],',
    '}',
    '',
    'export default async function run() {}',
    '',
  ].join('\n')
}

function setTimes(dir: string, names: readonly string[], when: Date) {
  for (const name of names) utimesSync(join(dir, name), when, when)
}

function writeFinal(folder: string, sessionId: string, workflow: TeamWorkflow, worktree: string) {
  mkdirSync(join(folder, 'workflows'), { recursive: true })
  writeFileSync(join(folder, 'workflows', `${workflow.run_id}.json`), json(finalSummary(workflow)))
  // The live folder is kept for what the summary does not carry: who failed (journal) and what each agent edited or called.
  const failed = workflow.agents.filter(agent => agent.state === 'failed' && agent.agent_id !== null)
  const traced = workflow.agents.filter(agent => agent.agent_id !== null && (agent.files_edited.length > 0 || agent.providers.length > 0))
  if (failed.length === 0 && traced.length === 0) return
  const dir = join(folder, 'subagents', 'workflows', workflow.run_id)
  mkdirSync(dir, { recursive: true })
  const journal = [json({ type: 'launched' })]
  for (const agent of workflow.agents) if (agent.agent_id !== null) journal.push(json({ type: 'started', key: `v2:${agent.agent_id}`, agentId: agent.agent_id, label: agent.label, phase: agent.phase }))
  for (const agent of failed) journal.push(json({ type: 'failed', key: `v2:${agent.agent_id}`, agentId: agent.agent_id }))
  writeFileSync(join(dir, 'journal.jsonl'), journal.join(''))
  for (const agent of traced) {
    const at = agent.started_at ?? workflow.started_at ?? STALE_RECORD_TIME.toISOString()
    writeFileSync(join(dir, `agent-${agent.agent_id}.jsonl`), assistantLine(sessionId, at, null, fileAndProviderTools(agent, worktree)) + '\n')
  }
}

function writeLive(folder: string, sessionId: string, workflow: TeamWorkflow, worktree: string, now: Date) {
  const dir = join(folder, 'subagents', 'workflows', workflow.run_id)
  mkdirSync(dir, { recursive: true })
  const journal = [json({ type: 'launched' })]
  const names = ['journal.jsonl']
  for (const agent of workflow.agents) {
    if (agent.agent_id === null) throw new Error(`live agent ${agent.label} #${agent.index} needs an agent id: the journal records started agents only`)
    journal.push(json({ type: 'started', key: `v2:${agent.agent_id}`, agentId: agent.agent_id, label: agent.label, phase: agent.phase }))
    writeFileSync(join(dir, `agent-${agent.agent_id}.meta.json`), json({ agentType: 'workflow-subagent', description: agent.label, workflowPhase: agent.phase, model: 'sonnet' }))
    writeFileSync(join(dir, `agent-${agent.agent_id}.jsonl`), liveTranscript(sessionId, agent, worktree))
    names.push(`agent-${agent.agent_id}.meta.json`, `agent-${agent.agent_id}.jsonl`)
  }
  for (const agent of workflow.agents) {
    if (agent.state === 'done') journal.push(json({ type: 'result', key: `v2:${agent.agent_id}`, agentId: agent.agent_id, result: agent.result_preview ?? 'done' }))
    if (agent.state === 'failed') journal.push(json({ type: 'failed', key: `v2:${agent.agent_id}`, agentId: agent.agent_id }))
  }
  writeFileSync(join(dir, 'journal.jsonl'), journal.join(''))
  mkdirSync(join(folder, 'workflows', 'scripts'), { recursive: true })
  writeFileSync(join(folder, 'workflows', 'scripts', `${workflow.name ?? 'workflow'}-${workflow.run_id}.js`), scriptSource(workflow))
  setTimes(dir, names, workflow.status === 'running' ? now : STALE_RECORD_TIME)
}

/** One session of a run and the worktree its receipt records (edited files are relative to it). */
export type RecordedSession = { session: TeamSession; worktree: string }

/**
 * Writes Claude Code's records for every session that has workflows (a session with records `none` gets no folder; this
 * writer cannot make `unreadable`). `now` is when a running workflow's files were last written.
 */
export function writeTeamRecords(claudeHome: string, sessions: readonly RecordedSession[], now: Date = new Date()) {
  for (const { session, worktree } of sessions) {
    if (session.records === 'unreadable') throw new Error(`session ${session.key}: unreadable records are not seeded`)
    if (session.workflows.length === 0) continue
    const slugDir = join(claudeHome, 'projects', claudeSlug(worktree))
    const folder = join(slugDir, session.session_id)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(slugDir, `${session.session_id}.jsonl`), [
      JSON.stringify({ type: 'user', timestamp: STALE_RECORD_TIME.toISOString(), sessionId: session.session_id, cwd: worktree, message: { role: 'user', content: 'Start the lane task.' } }),
      assistantLine(session.session_id, STALE_RECORD_TIME.toISOString(), 'claude-opus-5-5', [{ type: 'text', text: 'Starting a team workflow.' }]),
    ].join('\n') + '\n')
    for (const workflow of session.workflows) {
      if (workflow.record === 'final') writeFinal(folder, session.session_id, workflow, worktree)
      else writeLive(folder, session.session_id, workflow, worktree, now)
    }
  }
}

/**
 * Gives every file of the named live workflows the current time, as a session still writing them would, so the reader's
 * 15-minute window sees them running however long ago the seed ran. Workflows not named keep their times.
 */
export function refreshRunningRecords(claudeHome: string, workflowIds: readonly string[], now: Date = new Date()) {
  const projects = join(claudeHome, 'projects')
  const wanted = new Set(workflowIds)
  const list = (dir: string) => { try { return readdirSync(dir, { withFileTypes: true }) } catch { return [] } }
  for (const slug of list(projects).filter(entry => entry.isDirectory())) {
    for (const session of list(join(projects, slug.name)).filter(entry => entry.isDirectory())) {
      const lives = join(projects, slug.name, session.name, 'subagents', 'workflows')
      for (const workflow of list(lives).filter(entry => entry.isDirectory() && wanted.has(entry.name))) {
        const dir = join(lives, workflow.name)
        setTimes(dir, list(dir).filter(entry => entry.isFile()).map(entry => entry.name), now)
      }
    }
  }
}

/** The running workflows of a payload, whose records `refreshRunningRecords` keeps fresh. */
export const runningWorkflowIds = (teams: Teams) => teams.sessions.flatMap(session => session.workflows.filter(workflow => workflow.status === 'running').map(workflow => workflow.run_id))

/** What one lane's session files say: its session, worktree and model, whether it completed, and its recorded cost. */
export type LaneSessionFiles = { lane: string; sessionId: string; worktree: string; requestedAt: string; model: string; completed: boolean; cost?: { usd: number; durationMs: number; recordedAt: string } }

/** The run directory's per-lane session files the sessions reader reads (`server/sessions.ts` `workerRows`). */
export function writeLaneSessionFiles(runDir: string, runId: string, lanes: readonly LaneSessionFiles[]) {
  mkdirSync(runDir, { recursive: true })
  for (const lane of lanes) {
    writeFileSync(join(runDir, `${lane.lane}.interactive.json`), json({ session_id: lane.sessionId, worktree: lane.worktree, launch_requested_at: lane.requestedAt, requested: { model: lane.model } }))
    if (lane.cost) writeFileSync(join(runDir, `${lane.lane}.cost.json`), json({ session_id: lane.sessionId, cost_usd: lane.cost.usd, duration_ms: lane.cost.durationMs, recorded_at: lane.cost.recordedAt, models: [lane.model] }))
    if (lane.completed) writeFileSync(join(runDir, `${lane.lane}.completion.json`), json({ version: '1.1.0', run_id: runId, node_id: lane.lane, status: 'completed' }))
  }
}

/**
 * The payload as both phases agree on it: `read_at` dropped, and a live workflow's `last_activity_at` dropped (the server takes
 * the later of its agents' last line and its journal's modification time, which the seed cannot pin).
 */
export function comparableTeams(teams: Teams): Omit<Teams, 'read_at'> {
  const { read_at: _readAt, ...rest } = teams
  void _readAt
  return {
    ...rest,
    sessions: rest.sessions.map(session => ({
      ...session,
      workflows: session.workflows.map(workflow => (workflow.record === 'live' ? { ...workflow, last_activity_at: null } : workflow)),
    })),
  }
}
