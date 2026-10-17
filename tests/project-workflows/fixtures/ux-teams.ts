/**
 * Fixtures of the Team view, its run-view integration and the node page's Team section (`teams.spec.ts`,
 * docs/PRD_RUN_TEAMS.md 3, 5, 6 and 11 P0 items 2-6), registered as the workflow `ux-teams` of `PROJECT`. Every run is the core
 * two-lane graph (`launch_ui`, `launch_adapter` … `integrate`) with the core inputs, so lane `ui` owns `src/App.tsx`,
 * `src/App.css`, `src/projects` and `tests/project-workflows` and lane `adapter` owns `server` and `config/projects.example.json`;
 * each run carries one teams payload:
 *
 * - `teams-base`: the contract example `teams` (a finished and a live workflow in lane ui, Repair 1 with no records, the
 *   challenge unreadable); `impl:server` edited `server/…` from lane ui, so the owned-paths flag holds. It also serves a
 *   sessions payload, for the Sessions table's Team link.
 * - `teams-live` (running): lanes ui and adapter each run a workflow with eight running agents between them, one of them quiet
 *   for 12 minutes; Working now has more rows than a desk shows.
 * - `teams-large` (running): one workflow of 6 phases, 400 listed agents and `agents_more` 112; duplicate labels; a `<b>` in a
 *   preview that must stay literal.
 * - `teams-failed`: a workflow that failed with an error line and a failed agent.
 * - `teams-killed`: a killed workflow whose running agents show interrupted.
 * - `teams-interrupted` (running): a workflow interrupted mid-phase while the run is live (the dock's interrupted line).
 * - `teams-none`: run 002's shape, both workers with records `none`; `teams-absent` is the same run with no teams payload (a
 *   404, "not served"), so the run page of both must be identical.
 * - `teams-unreadable`: lane ui's worker folder could not be read.
 * - `teams-malformed`: a payload whose totals disagree with its agents (the not-loaded state).
 * - `teams-empty`: no Claude session has started (`sessions: []`).
 *
 * Worker phase only: the teams reader lives in the server lane, so there is no candidate-phase seed; `teams.spec.ts` runs in
 * the worker phase.
 */
import { teams as exampleTeams } from '../../../contracts/projects/teamExamples.ts'
import type { TeamAgent, Teams, TeamSession, TeamWorkflow } from '../../../contracts/projects/teams.ts'
import type { Sessions, SessionRow } from '../../../contracts/projects/sessions.ts'
import type { RunDetail, RunInputs } from '../../../contracts/projects/v1.ts'
import type { WorkerResult, WorkflowEvent } from '../../../contracts/workflow/v1.ts'
import { ADAPTER_SESSION, candidateOf, definition, done, GRAPH_NODES, PROJECT, runDetail, runInputs, UI_SESSION, workerResults, type NodeState } from '../fixtures.ts'
import type { UxFixtureModule, UxPayloads } from './index.ts'

export const UX_TEAMS_WORKFLOW_ID = 'ux-teams'
export const UX_TEAMS_WORKFLOW_NAME = 'UX teams'
export const TEAMS_RUNS = {
  base: 'teams-base',
  live: 'teams-live',
  large: 'teams-large',
  failed: 'teams-failed',
  killed: 'teams-killed',
  interrupted: 'teams-interrupted',
  none: 'teams-none',
  absent: 'teams-absent',
  unreadable: 'teams-unreadable',
  malformed: 'teams-malformed',
  empty: 'teams-empty',
} as const

/** The page's fixed clock for every team scenario: eight seconds after the example's read. */
export const TEAMS_NOW = '2026-10-16T09:58:38Z'
const READ_AT = exampleTeams.read_at
const DAY = '2026-10-16'
const at = (clock: string) => `${DAY}T${clock}Z`

export const TEAMS_DEFINITION = definition(PROJECT.project_id, UX_TEAMS_WORKFLOW_ID, UX_TEAMS_WORKFLOW_NAME, GRAPH_NODES)

// ---- Team payload builders (pure; the unit tests read them too) ---------------------------------------------------------

/** An agent with every optional fact absent unless given; `agent_id` follows its index, null for a queued agent. */
export function teamAgent(index: number, fields: Partial<TeamAgent> & Pick<TeamAgent, 'label' | 'state'>): TeamAgent {
  return {
    agent_id: fields.state === 'queued' ? null : `a${index.toString(16).padStart(12, '0')}`,
    index,
    role: fields.label.includes(':') ? fields.label.split(':')[0]! : null,
    phase: null,
    phase_index: null,
    model: 'claude-opus-5-5',
    cached: false,
    attempt: fields.state === 'queued' ? null : 1,
    isolated: false,
    started_at: null,
    last_activity_at: null,
    duration_ms: null,
    tool_calls: null,
    context_tokens: null,
    last_tool: null,
    last_tool_summary: null,
    prompt_preview: null,
    result_preview: null,
    files_edited: [],
    files_edited_more: 0,
    providers: [],
    ...fields,
  }
}

/** A workflow whose phase counts are derived from its agents (a phase with none reads all zeros). */
export function teamWorkflow(fields: Partial<TeamWorkflow> & Pick<TeamWorkflow, 'run_id' | 'status' | 'agents'> & { phaseTitles: string[] }): TeamWorkflow {
  const { phaseTitles, ...rest } = fields
  const phases = phaseTitles.map((title, offset) => {
    const index = offset + 1
    const members = fields.agents.filter(agent => agent.phase_index === index)
    const count = (state: TeamAgent['state']) => members.filter(agent => agent.state === state).length
    return { index, title, detail: null, agents: members.length, queued: count('queued'), running: count('running'), done: count('done'), failed: count('failed'), interrupted: count('interrupted') }
  })
  const live = fields.status === 'running' || fields.status === 'interrupted'
  return {
    name: null,
    description: null,
    record: live ? 'live' : 'final',
    started_at: null,
    ended_at: null,
    last_activity_at: null,
    duration_ms: null,
    default_model: live ? null : 'claude-opus-5-5',
    agent_count: fields.agents.length + (fields.agents_more ?? 0),
    tool_calls: fields.agents.reduce((sum, agent) => sum + (agent.tool_calls ?? 0), 0),
    context_tokens: null,
    agents_more: 0,
    logs: [],
    result_preview: null,
    error: null,
    ...rest,
    phases,
  }
}

/** A session of the run: its records follow its workflows (found) or the reason (unreadable), else none. */
export function teamSession(fields: Pick<TeamSession, 'key' | 'role' | 'label' | 'node_id' | 'lane' | 'session_id'> & { workflows?: TeamWorkflow[]; reason?: string }): TeamSession {
  const workflows = fields.workflows ?? []
  const reason = fields.reason ?? null
  return {
    key: fields.key, role: fields.role, label: fields.label, node_id: fields.node_id, lane: fields.lane, session_id: fields.session_id,
    records: reason !== null ? 'unreadable' : workflows.length > 0 ? 'found' : 'none',
    reason,
    workflows,
  }
}

/** The payload with totals counted over its listed agents, as `validateTeams` requires. */
export function teamsPayload(runId: string, sessions: TeamSession[], readAt = READ_AT): Teams {
  const totals = { sessions_with_teams: 0, workflows: 0, workflows_running: 0, agents: 0, queued: 0, running: 0, done: 0, failed: 0, interrupted: 0, tool_calls: 0 }
  for (const session of sessions) {
    if (session.workflows.length > 0) totals.sessions_with_teams += 1
    for (const workflow of session.workflows) {
      totals.workflows += 1
      if (workflow.status === 'running') totals.workflows_running += 1
      for (const agent of workflow.agents) {
        totals.agents += 1
        totals[agent.state] += 1
        totals.tool_calls += agent.tool_calls ?? 0
      }
    }
  }
  return { contract_version: '1.0.0', run_id: runId, read_at: readAt, sessions, totals }
}

const uiWorker = (workflows: TeamWorkflow[] = [], reason?: string) => teamSession({ key: 'worker:ui', role: 'worker', label: 'Worker · ui', node_id: 'launch_ui', lane: 'ui', session_id: UI_SESSION, workflows, reason })
const adapterWorker = (workflows: TeamWorkflow[] = []) => teamSession({ key: 'worker:adapter', role: 'worker', label: 'Worker · adapter', node_id: 'launch_adapter', lane: 'adapter', session_id: ADAPTER_SESSION, workflows })

/** Two lanes at work: ui's workflow runs five agents (one quiet for 12 minutes), adapter's three. */
export function liveTeams(runId: string): Teams {
  const running = (index: number, label: string, phase: string, phaseIndex: number, started: string, last: string, tool: string, summary: string, files: string[] = []) =>
    teamAgent(index, { label, state: 'running', phase, phase_index: phaseIndex, started_at: at(started), last_activity_at: at(last), tool_calls: 10 + index, last_tool: tool, last_tool_summary: summary, files_edited: files })
  const ui = teamWorkflow({
    run_id: 'wf_11aa22bb-001', name: 'build-team-view', description: 'Build the Team view', status: 'running', started_at: at('09:40:00'), last_activity_at: at('09:58:20'),
    phaseTitles: ['Implement', 'Review'],
    agents: [
      teamAgent(1, { label: 'impl:model', state: 'done', phase: 'Implement', phase_index: 1, started_at: at('09:40:05'), last_activity_at: at('09:50:00'), duration_ms: 595000, tool_calls: 40, last_tool: 'Edit', files_edited: ['src/projects/teams/model.ts'] }),
      running(2, 'impl:view', 'Implement', 1, '09:41:00', '09:58:10', 'Bash', 'npx tsc -b', ['src/projects/teams/TeamView.tsx']),
      running(3, 'impl:css', 'Implement', 1, '09:41:30', '09:46:30', 'Bash', 'npm run test:unit'),
      running(4, 'review:claude', 'Review', 2, '09:52:00', '09:58:00', 'Read', 'src/projects/teams/Roster.tsx'),
      running(5, 'review:gpt', 'Review', 2, '09:52:00', '09:57:40', 'Bash', 'pi -p --model openai-codex/gpt-6-astra'),
      running(6, 'review:muse', 'Review', 2, '09:52:10', '09:57:50', 'Bash', 'muse exec review'),
    ],
  })
  const adapter = teamWorkflow({
    run_id: 'wf_33cc44dd-002', name: 'build-teams-reader', description: 'Build the teams reader', status: 'running', started_at: at('09:42:00'), last_activity_at: at('09:58:25'),
    phaseTitles: ['Read', 'Write'],
    agents: [
      running(1, 'read:journal', 'Read', 1, '09:42:10', '09:58:25', 'Read', 'server/teams.ts'),
      running(2, 'read:meta', 'Read', 1, '09:42:20', '09:58:05', 'Grep', 'agent-.*meta'),
      running(3, 'write:tests', 'Write', 2, '09:50:00', '09:58:15', 'Edit', 'server/teams.test.ts', ['server/teams.test.ts']),
    ],
  })
  return teamsPayload(runId, [uiWorker([ui]), adapterWorker([adapter])])
}

/** One workflow of 6 phases and 400 listed agents (112 more not listed), running in its fifth phase. */
export function largeTeams(runId: string): Teams {
  const plan: [title: string, count: number, make: (offset: number) => Pick<TeamAgent, 'state'> & Partial<TeamAgent>][] = [
    ['Understand', 60, () => ({ state: 'done', duration_ms: 240000, tool_calls: 12 })],
    ['Plan', 40, () => ({ state: 'done', duration_ms: 180000, tool_calls: 9 })],
    ['Implement', 120, offset => (offset < 5 ? { state: 'failed', duration_ms: 60000, tool_calls: 3 } : { state: 'done', duration_ms: 900000, tool_calls: 60 })],
    ['Review', 100, () => ({ state: 'done', duration_ms: 300000, tool_calls: 20 })],
    ['Fix', 70, offset => (offset < 6 ? { state: 'running', started_at: at('09:50:00'), last_activity_at: at('09:58:00'), tool_calls: 8, last_tool: 'Bash', last_tool_summary: 'npm test' } : { state: 'done', duration_ms: 200000, tool_calls: 14 })],
    ['Check', 10, () => ({ state: 'queued' })],
  ]
  const agents: TeamAgent[] = []
  plan.forEach(([title, count, make], phaseOffset) => {
    for (let offset = 0; offset < count; offset += 1) {
      const index = agents.length + 1
      // Labels repeat (the script names each agent by its role and area); the index is the key.
      const label = `${title.toLowerCase()}:${['frontend', 'server', 'docs', 'tests'][offset % 4]}`
      agents.push(teamAgent(index, {
        label, phase: title, phase_index: phaseOffset + 1, ...make(offset),
        prompt_preview: index === 1 ? 'Map the page. <b>bold</b> stays literal; <a href="https://example.com">a link</a> is text.' : null,
      }))
    }
  })
  const workflow = teamWorkflow({
    run_id: 'wf_55ee66ff-003', name: 'sweep-the-codebase', description: 'A large sweep: understand, plan, implement, review, fix and check', status: 'running',
    started_at: at('09:00:00'), last_activity_at: at('09:58:00'), phaseTitles: plan.map(([title]) => title), agents, agents_more: 112,
  })
  return teamsPayload(runId, [uiWorker([workflow]), adapterWorker()])
}

/** A workflow that failed: one agent failed and the summary records the error's first line. */
export function failedTeams(runId: string): Teams {
  const workflow = teamWorkflow({
    run_id: 'wf_77aa88bb-004', name: 'migrate-styles', description: 'Migrate the styles', status: 'failed', started_at: at('09:00:00'), ended_at: at('09:20:00'), last_activity_at: at('09:20:00'), duration_ms: 1200000,
    error: 'TypeError: Cannot read properties of undefined (reading \'phases\')',
    phaseTitles: ['Migrate'],
    agents: [
      teamAgent(1, { label: 'migrate:css', state: 'done', phase: 'Migrate', phase_index: 1, duration_ms: 600000, tool_calls: 30 }),
      teamAgent(2, { label: 'migrate:tokens', state: 'failed', phase: 'Migrate', phase_index: 1, duration_ms: 90000, tool_calls: 4 }),
    ],
  })
  return teamsPayload(runId, [uiWorker([workflow]), adapterWorker()])
}

/** A killed workflow: the agents still running when it stopped show interrupted. */
export function killedTeams(runId: string): Teams {
  const workflow = teamWorkflow({
    run_id: 'wf_99cc00dd-005', name: 'rename-everything', description: 'Rename the run views', status: 'killed', started_at: at('09:00:00'), ended_at: at('09:10:00'), last_activity_at: at('09:10:00'), duration_ms: 600000,
    phaseTitles: ['Rename', 'Verify'],
    agents: [
      teamAgent(1, { label: 'rename:a', state: 'done', phase: 'Rename', phase_index: 1, duration_ms: 300000, tool_calls: 12 }),
      teamAgent(2, { label: 'rename:b', state: 'interrupted', phase: 'Rename', phase_index: 1, started_at: at('09:01:00'), tool_calls: 7 }),
      teamAgent(3, { label: 'verify:all', state: 'queued', phase: 'Verify', phase_index: 2 }),
    ],
  })
  return teamsPayload(runId, [uiWorker([workflow]), adapterWorker()])
}

/** A workflow interrupted in its second phase while the run is still live. */
export function interruptedTeams(runId: string): Teams {
  const workflow = teamWorkflow({
    run_id: 'wf_12ab34cd-006', name: 'wire-the-dock', description: 'Wire the dock', status: 'interrupted', started_at: at('09:00:00'), last_activity_at: at('09:30:00'),
    phaseTitles: ['Build', 'Test'],
    agents: [
      teamAgent(1, { label: 'build:dock', state: 'done', phase: 'Build', phase_index: 1, duration_ms: 600000, tool_calls: 20 }),
      teamAgent(2, { label: 'test:dock', state: 'interrupted', phase: 'Test', phase_index: 2, started_at: at('09:20:00'), last_activity_at: at('09:30:00'), tool_calls: 6 }),
    ],
  })
  return teamsPayload(runId, [uiWorker([workflow]), adapterWorker()])
}

/** Run 002's shape: both workers ran as single sessions. */
export const noneTeams = (runId: string): Teams => teamsPayload(runId, [uiWorker(), adapterWorker()])

/** Lane ui's worker folder could not be read. */
export const unreadableTeams = (runId: string): Teams => teamsPayload(runId, [uiWorker([], 'The session folder could not be read'), adapterWorker()])

/** The contract example, for another run. */
export const baseTeams = (runId: string): Teams => ({ ...exampleTeams, run_id: runId })

// ---- The runs ------------------------------------------------------------------------------------------------------

const SUCCEEDED_STATES: Record<string, NodeState> = {
  launch_ui: done(UI_SESSION, 'ui'), launch_adapter: done(ADAPTER_SESSION, 'adapter'), handoff: done(),
  verify_ui: done(undefined, 'ui'), verify_adapter: done(undefined, 'adapter'), candidate: candidateOf(['ui', 'adapter']),
  review: done(), approval: done(), integrate: done(),
}
const RUNNING_STATES: Record<string, NodeState> = {
  launch_ui: { status: 'running', attempt: 1, session: UI_SESSION }, launch_adapter: { status: 'running', attempt: 1, session: ADAPTER_SESSION },
}

const event = (runId: string, sequence: number, occurredAt: string, nodeId: string, status: 'running' | 'succeeded', message: string): WorkflowEvent => ({
  contract_version: '1.0.0', run_id: runId, event_id: `${runId}-event-${sequence}`, sequence, occurred_at: occurredAt, node_id: nodeId, attempt: 1,
  type: 'status_changed', status, message, artifact: null, result_uri: null, reused_from_attempt: null,
} as WorkflowEvent)

type RunShape = 'succeeded' | 'running'
const RUN_SHAPES: Record<string, RunShape> = {
  [TEAMS_RUNS.base]: 'succeeded', [TEAMS_RUNS.live]: 'running', [TEAMS_RUNS.large]: 'running', [TEAMS_RUNS.failed]: 'succeeded', [TEAMS_RUNS.killed]: 'succeeded',
  [TEAMS_RUNS.interrupted]: 'running', [TEAMS_RUNS.none]: 'succeeded', [TEAMS_RUNS.absent]: 'succeeded', [TEAMS_RUNS.unreadable]: 'succeeded',
  [TEAMS_RUNS.malformed]: 'succeeded', [TEAMS_RUNS.empty]: 'running',
}

/** Every string of a core record names the core run; the clone names its own. */
const renamed = <T,>(value: T, runId: string): T => JSON.parse(JSON.stringify(value).replaceAll('/workflows/feature-flow/runs/run-succeeded/', `/workflows/${UX_TEAMS_WORKFLOW_ID}/runs/${runId}/`).replaceAll('run-succeeded', runId)) as T

function runOf(runId: string, shape: RunShape): { detail: RunDetail; events: WorkflowEvent[]; inputs: RunInputs; results: Record<string, WorkerResult> } {
  const running = shape === 'running'
  const detail = runDetail(runId, running ? 'running' : 'succeeded', TEAMS_DEFINITION, at('08:55:00'), running ? at('09:58:30') : at('09:45:00'), running ? RUNNING_STATES : SUCCEEDED_STATES, running ? 2 : 6)
  const events = running
    ? [event(runId, 1, at('08:55:10'), 'launch_ui', 'running', 'Launching the native UI session'), event(runId, 2, at('08:55:12'), 'launch_adapter', 'running', 'Launching the native adapter session')]
    : [
      event(runId, 1, at('08:55:10'), 'launch_ui', 'running', 'Launching the native UI session'),
      event(runId, 2, at('08:55:12'), 'launch_adapter', 'running', 'Launching the native adapter session'),
      event(runId, 3, at('09:20:00'), 'launch_ui', 'succeeded', 'Completion signal recorded'),
      event(runId, 4, at('09:21:00'), 'launch_adapter', 'succeeded', 'Completion signal recorded'),
      event(runId, 5, at('09:40:00'), 'review', 'succeeded', 'Review approved'),
      event(runId, 6, at('09:45:00'), 'integrate', 'succeeded', 'Integrated'),
    ]
  const results = running ? {} : renamed(workerResults['run-succeeded'] ?? {}, runId)
  return { detail, events, inputs: renamed(runInputs['run-succeeded']!, runId), results }
}

/** The Sessions table of `teams-base`: the two workers, Repair 1 and the challenge (keys match the teams payload). */
function baseSessions(): Sessions {
  const row = (fields: Pick<SessionRow, 'key' | 'role' | 'label' | 'node_id' | 'lane' | 'session_id'> & Partial<SessionRow>): SessionRow => ({
    round: null, transport: 'claude', model: 'claude-opus-5-5', status: 'succeeded', verdict: null, findings: null,
    started_at: at('08:55:10'), ended_at: at('09:20:00'), duration_seconds: 1490, cost_usd: 4.2, cost_kind: 'metered',
    resume: { dir: null, command: `claude --resume ${fields.session_id}` },
    ...fields,
  })
  return {
    contract_version: '1.13.0',
    sessions: [
      row({ key: 'challenge:1', role: 'challenge', label: 'Design challenge attempt 1', node_id: 'challenge', lane: null, round: 1, session_id: '11223344-5566-7788-99aa-bbccddeeff00' }),
      row({ key: 'worker:ui', role: 'worker', label: 'Worker · ui', node_id: 'launch_ui', lane: 'ui', session_id: '9f1c2d3e-4b5a-6789-8abc-def012345678' }),
      row({ key: 'worker:adapter', role: 'worker', label: 'Worker · adapter', node_id: 'launch_adapter', lane: 'adapter', session_id: ADAPTER_SESSION }),
      row({ key: 'repair:1', role: 'repair', label: 'Repair 1', node_id: 'repair-1', lane: 'ui', round: 1, session_id: '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9' }),
    ],
    totals: { metered_usd: 16.8, covered_usd: 0, not_recorded: 0 },
    lane_reviews: [],
    night_shift: [],
  }
}

/** A payload outside the contract's cross-field rules: its totals count one agent too many (the client refuses it). */
function malformedTeams(runId: string): Teams {
  const payload = baseTeams(runId)
  return { ...payload, totals: { ...payload.totals, agents: payload.totals.agents + 1 } }
}

const TEAMS_BY_RUN: Record<string, Teams> = {
  [TEAMS_RUNS.base]: baseTeams(TEAMS_RUNS.base),
  [TEAMS_RUNS.live]: liveTeams(TEAMS_RUNS.live),
  [TEAMS_RUNS.large]: largeTeams(TEAMS_RUNS.large),
  [TEAMS_RUNS.failed]: failedTeams(TEAMS_RUNS.failed),
  [TEAMS_RUNS.killed]: killedTeams(TEAMS_RUNS.killed),
  [TEAMS_RUNS.interrupted]: interruptedTeams(TEAMS_RUNS.interrupted),
  [TEAMS_RUNS.none]: noneTeams(TEAMS_RUNS.none),
  [TEAMS_RUNS.unreadable]: unreadableTeams(TEAMS_RUNS.unreadable),
  [TEAMS_RUNS.malformed]: malformedTeams(TEAMS_RUNS.malformed),
  [TEAMS_RUNS.empty]: teamsPayload(TEAMS_RUNS.empty, []),
}

function payloads(): Partial<UxPayloads> {
  const runs = Object.entries(RUN_SHAPES).map(([runId, shape]) => [runId, runOf(runId, shape)] as const)
  return {
    workflows: [TEAMS_DEFINITION],
    runDetails: Object.fromEntries(runs.map(([runId, run]) => [runId, run.detail])),
    runEvents: Object.fromEntries(runs.map(([runId, run]) => [runId, run.events])),
    runInputs: Object.fromEntries(runs.map(([runId, run]) => [runId, run.inputs])),
    workerResults: Object.fromEntries(runs.map(([runId, run]) => [runId, run.results])),
    reviewResults: {},
    artifactFiles: {},
    teams: TEAMS_BY_RUN,
    sessions: { [TEAMS_RUNS.base]: baseSessions() },
  }
}

export const uxTeams: UxFixtureModule = { payloads: payloads() }
