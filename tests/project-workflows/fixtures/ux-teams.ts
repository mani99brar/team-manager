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
 * - `teams-seeded`: lane ui ran the example's finished workflow and a later killed one; lane adapter ran none.
 * - `teams-seeded-live` (running): lane ui runs a live workflow (two agents running, one done, one failed); lane adapter's live
 *   workflow was interrupted (its records are older than the reader's 15-minute window).
 *
 * The candidate phase (`seed`) writes every run's directory in the documented storage format (so the real server serves every
 * run the mock does), each lane's session files with a session id of its own, and, for the two seeded runs, Claude Code's own
 * records under the test root's Claude home (`fixtures/teamRecords.ts`), written from the very payload the mock serves for
 * them: the real teams reader serves the same sessions, workflows and agents (`tests/unit/teamsSeed.test.ts` proves it, and
 * `teams.spec.ts` checks it through the page). The other runs have no records there: their team scenarios read mock-only
 * payloads (a malformed payload, a 404, 400 agents, exact times against a fixed clock) and stay in the worker phase. Run
 * `teams-base` also seeds the files behind its Sessions table (a challenge attempt and both workers), so its mocked
 * `/sessions` payload is the server's own.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { teams as exampleTeams } from '../../../contracts/projects/teamExamples.ts'
import type { TeamAgent, Teams, TeamSession, TeamWorkflow } from '../../../contracts/projects/teams.ts'
import type { Sessions, SessionRow } from '../../../contracts/projects/sessions.ts'
import type { RunDetail, RunInputs } from '../../../contracts/projects/v1.ts'
import type { WorkerResult, WorkflowEvent } from '../../../contracts/workflow/v1.ts'
import {
  ADAPTER_SESSION, BASE_COMMIT, CANDIDATE_COMMIT, LANE_ARTIFACTS, OUTPUT_COMMIT_ADAPTER, OUTPUT_COMMIT_UI, adapterResult, candidateOf, definition, done, GRAPH_NODES,
  PROJECT, rawInputsSection, runDetail, runInputs, UI_SESSION, uiResult, workerResults, type NodeState,
} from '../fixtures.ts'
import type { SeedContext } from '../seed.ts'
import type { UxFixtureModule, UxPayloads } from './index.ts'
import { writeLaneSessionFiles, writeTeamRecords, type LaneSessionFiles } from './teamRecords.ts'

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
  seeded: 'teams-seeded',
  seededLive: 'teams-seeded-live',
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

// ---- The seeded runs: payloads the candidate seed writes as Claude Code's records ------------------------------------

/**
 * Each seeded run's lane sessions: ids of their own (the core runs share `UI_SESSION`/`ADAPTER_SESSION`, and the reader finds a
 * session's records by its id alone, so records under a shared id would show on every run that names it).
 */
export const SEEDED_SESSIONS = {
  [TEAMS_RUNS.seeded]: { ui: '5eed0001-7ea3-4000-8000-00000000a001', adapter: '5eed0001-7ea3-4000-8000-00000000a002' },
  [TEAMS_RUNS.seededLive]: { ui: '5eed0002-7ea3-4000-8000-00000000a001', adapter: '5eed0002-7ea3-4000-8000-00000000a002' },
} as const

/** The reader's ISO form of a clock time on the fixtures' day (`…:00.000Z`). */
const readerAt = (clock: string) => new Date(at(clock)).toISOString()
const readerIso = (value: string | null) => (value === null ? null : new Date(value).toISOString())

/** A payload's times in the reader's ISO form, so the mock serves exactly what the reader serves for the seeded records. */
function readerTimes(workflow: TeamWorkflow): TeamWorkflow {
  return {
    ...workflow,
    started_at: readerIso(workflow.started_at), ended_at: readerIso(workflow.ended_at), last_activity_at: readerIso(workflow.last_activity_at),
    agents: workflow.agents.map(agent => ({ ...agent, started_at: readerIso(agent.started_at), last_activity_at: readerIso(agent.last_activity_at) })),
  }
}

/** A live agent: no attempt, summary or prompt (the transcript carries none); times, tools, context and model from its transcript. */
function liveAgent(index: number, fields: Partial<TeamAgent> & Pick<TeamAgent, 'label' | 'state' | 'phase' | 'phase_index' | 'last_tool' | 'tool_calls' | 'context_tokens'> & { from: string; to: string }): TeamAgent {
  const { from, to, ...rest } = fields
  return teamAgent(index, { attempt: null, started_at: readerAt(from), last_activity_at: readerAt(to), duration_ms: Date.parse(at(to)) - Date.parse(at(from)), ...rest })
}

/** `teams-seeded`: lane ui ran the example's finished workflow, then a workflow that was killed; lane adapter ran none. */
export function seededTeams(runId: string = TEAMS_RUNS.seeded): Teams {
  const ids = SEEDED_SESSIONS[TEAMS_RUNS.seeded]
  const finished = readerTimes(exampleTeams.sessions[0]!.workflows[0]!)
  const killed = readerTimes(teamWorkflow({
    run_id: 'wf_5eed0c1d-001', name: 'rename-everything', description: 'Rename the run views', status: 'killed',
    started_at: at('09:42:00'), ended_at: at('09:50:00'), last_activity_at: at('09:50:00'), duration_ms: 480000,
    phaseTitles: ['Rename', 'Verify'],
    agents: [
      teamAgent(1, { label: 'rename:a', state: 'done', phase: 'Rename', phase_index: 1, duration_ms: 240000, tool_calls: 12 }),
      teamAgent(2, { label: 'rename:b', state: 'interrupted', phase: 'Rename', phase_index: 1, started_at: at('09:43:00'), tool_calls: 7 }),
      teamAgent(3, { label: 'verify:all', state: 'queued', phase: 'Verify', phase_index: 2 }),
    ],
  }))
  return teamsPayload(runId, [
    teamSession({ key: 'worker:ui', role: 'worker', label: 'Worker · ui', node_id: 'launch_ui', lane: 'ui', session_id: ids.ui, workflows: [finished, killed] }),
    teamSession({ key: 'worker:adapter', role: 'worker', label: 'Worker · adapter', node_id: 'launch_adapter', lane: 'adapter', session_id: ids.adapter }),
  ])
}

/** `teams-seeded-live`: lane ui's workflow runs (two agents running, one done, one failed); lane adapter's was interrupted. */
export function seededLiveTeams(runId: string = TEAMS_RUNS.seededLive): Teams {
  const ids = SEEDED_SESSIONS[TEAMS_RUNS.seededLive]
  const ui = teamWorkflow({
    run_id: 'wf_5eed1a7e-001', name: 'build-team-view', description: 'Build the Team view', status: 'running',
    started_at: readerAt('09:40:05'), last_activity_at: readerAt('09:58:10'), phaseTitles: ['Implement', 'Review'],
    agents: [
      liveAgent(1, { label: 'impl:model', state: 'done', phase: 'Implement', phase_index: 1, from: '09:40:05', to: '09:50:00', tool_calls: 40, last_tool: 'Edit', context_tokens: 61000, files_edited: ['src/projects/teams/model.ts'], result_preview: '{"files":1}' }),
      liveAgent(2, { label: 'impl:view', state: 'running', phase: 'Implement', phase_index: 1, from: '09:41:00', to: '09:58:10', tool_calls: 31, last_tool: 'Bash', context_tokens: 74000, files_edited: ['src/projects/teams/TeamView.tsx'] }),
      liveAgent(3, { label: 'review:claude', state: 'running', phase: 'Review', phase_index: 2, from: '09:52:00', to: '09:58:00', tool_calls: 12, last_tool: 'Read', context_tokens: 30500 }),
      liveAgent(4, { label: 'review:gpt', state: 'failed', phase: 'Review', phase_index: 2, from: '09:52:00', to: '09:53:10', tool_calls: 4, last_tool: 'Bash', context_tokens: 9000, providers: ['openai-codex/gpt-6-astra'] }),
    ],
  })
  const adapter = teamWorkflow({
    run_id: 'wf_5eed1a7e-002', name: 'build-teams-reader', description: 'Build the teams reader', status: 'interrupted',
    started_at: readerAt('09:42:10'), last_activity_at: readerAt('09:55:00'), phaseTitles: ['Read', 'Write'],
    agents: [
      liveAgent(1, { label: 'read:journal', state: 'done', phase: 'Read', phase_index: 1, from: '09:42:10', to: '09:50:00', tool_calls: 15, last_tool: 'Read', context_tokens: 41000, result_preview: '{"read":true}' }),
      liveAgent(2, { label: 'write:tests', state: 'interrupted', phase: 'Write', phase_index: 2, from: '09:50:00', to: '09:55:00', tool_calls: 9, last_tool: 'Edit', context_tokens: 22000, files_edited: ['server/teams.test.ts'] }),
    ],
  })
  return teamsPayload(runId, [
    teamSession({ key: 'worker:ui', role: 'worker', label: 'Worker · ui', node_id: 'launch_ui', lane: 'ui', session_id: ids.ui, workflows: [ui] }),
    teamSession({ key: 'worker:adapter', role: 'worker', label: 'Worker · adapter', node_id: 'launch_adapter', lane: 'adapter', session_id: ids.adapter, workflows: [adapter] }),
  ])
}

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
  [TEAMS_RUNS.malformed]: 'succeeded', [TEAMS_RUNS.empty]: 'running', [TEAMS_RUNS.seeded]: 'succeeded', [TEAMS_RUNS.seededLive]: 'running',
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

// ---- Session files: what each run's directory records about its sessions ---------------------------------------------

/** The base run's challenge attempt (its print receipt names the session; the graph has no `challenge` node). */
const BASE_CHALLENGE = { sessionId: '11223344-5566-7788-99aa-bbccddeeff00', costUsd: 4.2, durationMs: 1490000, model: 'claude-opus-5-5' }
/** Each lane's recorded session cost: its own figures, so the Sessions table and its totals read the same in both phases. */
const LANE_COST = { usd: 4.2, durationMs: 1490000, recordedAt: at('09:20:00') }

/**
 * Each run's lane session files (`writeLaneSessionFiles`): the base run's sessions are the example's (worker ui's id, the
 * adapter's), the seeded runs' their own (`SEEDED_SESSIONS`), every other run's a pair of ids no record names (`teams-absent`
 * reuses `teams-none`'s); `teams-empty`
 * started no session. A finished run's lanes completed; a running run's did not, and record no cost yet.
 */
function laneSessionsOf(runId: string, runDir: string): LaneSessionFiles[] {
  if (runId === TEAMS_RUNS.empty) return []
  const finished = RUN_SHAPES[runId] === 'succeeded'
  const seeded = SEEDED_SESSIONS[runId as keyof typeof SEEDED_SESSIONS] as { ui: string; adapter: string } | undefined
  // `teams-absent` shares `teams-none`'s sessions: the two run pages must be identical but for the run id.
  const position = Object.keys(RUN_SHAPES).indexOf(runId === TEAMS_RUNS.absent ? TEAMS_RUNS.none : runId).toString(16).padStart(2, '0')
  const ids = runId === TEAMS_RUNS.base ? { ui: exampleTeams.sessions[0]!.session_id, adapter: ADAPTER_SESSION }
    : seeded ?? { ui: `5eedf0${position}-7ea3-4000-8000-00000000a001`, adapter: `5eedf0${position}-7ea3-4000-8000-00000000a002` }
  return (['ui', 'adapter'] as const).map(lane => ({
    lane, sessionId: ids[lane], worktree: join(runDir, `worktree-${lane}`), requestedAt: at(lane === 'ui' ? '08:55:10' : '08:55:12'), model: 'claude-opus-5-5',
    completed: finished, ...(finished ? { cost: LANE_COST } : {}),
  }))
}

/** A lane's Sessions row as the server reads it from its session files (`server/sessions.ts` `workerRows`). */
function laneRow(files: LaneSessionFiles): SessionRow {
  return {
    key: `worker:${files.lane}`, role: 'worker', label: `Worker · ${files.lane}`, node_id: `launch_${files.lane}`, lane: files.lane, round: null, transport: null,
    model: files.model, status: files.completed ? 'succeeded' : 'running', verdict: null, findings: null,
    started_at: readerIso(files.requestedAt), ended_at: files.completed && files.cost ? readerIso(files.cost.recordedAt) : null,
    duration_seconds: files.cost ? files.cost.durationMs / 1000 : null, cost_usd: files.cost?.usd ?? null, cost_kind: files.cost ? 'metered' : null,
    session_id: files.sessionId, resume: { dir: null, command: `claude --resume ${files.sessionId}` },
  }
}

/** The run's Sessions payload as the server reads it from the files `seed` writes (the parity spec compares the two). */
function sessionsOf(runId: string): Sessions {
  const rows: SessionRow[] = laneSessionsOf(runId, `/runs/${runId}`).map(laneRow)
  if (runId === TEAMS_RUNS.base) {
    rows.unshift({
      key: 'challenge:1', role: 'challenge', label: 'Design challenge attempt 1', node_id: null, lane: null, round: 1, transport: 'print', model: BASE_CHALLENGE.model,
      status: 'succeeded', verdict: null, findings: null, started_at: null, ended_at: null, duration_seconds: BASE_CHALLENGE.durationMs / 1000,
      cost_usd: BASE_CHALLENGE.costUsd, cost_kind: 'metered', session_id: BASE_CHALLENGE.sessionId, resume: { dir: null, command: `claude --resume ${BASE_CHALLENGE.sessionId}` },
    })
  }
  // Rows sort by start; a row without one (the challenge) goes last.
  const start = (row: SessionRow) => (row.started_at === null && row.ended_at === null ? Number.POSITIVE_INFINITY : Date.parse((row.started_at ?? row.ended_at)!))
  const sorted = rows.map((row, index) => ({ row, index })).sort((a, b) => (start(a.row) - start(b.row)) || (a.index - b.index)).map(item => item.row)
  const metered = Math.round(sorted.reduce((sum, row) => sum + (row.cost_usd ?? 0), 0) * 1e6) / 1e6
  return {
    contract_version: '1.13.0', sessions: sorted,
    totals: { metered_usd: metered, covered_usd: 0, not_recorded: sorted.filter(row => row.cost_usd === null).length },
    lane_reviews: [], night_shift: [],
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
  [TEAMS_RUNS.seeded]: seededTeams(),
  [TEAMS_RUNS.seededLive]: seededLiveTeams(),
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
    sessions: { [TEAMS_RUNS.base]: sessionsOf(TEAMS_RUNS.base), [TEAMS_RUNS.seeded]: sessionsOf(TEAMS_RUNS.seeded) },
  }
}

// ---- The candidate seed --------------------------------------------------------------------------------------------

const LAUNCHING = 'Launching or reconciling the exact native session'
/**
 * The seeded exports' clock: a day before every clock the other specs pin, so these runs never fill another spec's Today or
 * Recent (the mock's details keep the fixtures' day; no team scenario reads a run date, and the session files keep it).
 */
const exportAt = (clock: string) => `2024-03-05T${clock}Z`

/** The four verification packets of a finished two-lane run, in the `workflow/checks.py` layout (as the core seed writes them). */
export function finishedPackets(context: Pick<SeedContext, 'writePacket'>, runId: string, runDir: string) {
  const entries = [
    { phase: 'worker' as const, node: 'ui', result: uiResult(runId) }, { phase: 'worker' as const, node: 'adapter', result: adapterResult(runId, false) },
    { phase: 'candidate' as const, node: 'ui', result: uiResult(runId) }, { phase: 'candidate' as const, node: 'adapter', result: adapterResult(runId, false) },
  ]
  return entries.map(entry => context.writePacket(runDir, entry.phase, entry.node, 1, entry.result, LANE_ARTIFACTS[entry.node]!, {
    status: 'passed', reasons: [], ...(entry.result.deferred_checks ? { deferred_checks: entry.result.deferred_checks.map(check => `check-${check.check_index}`) } : {}),
  }))
}

/** One run directory: the export (finished: integrated through review; running: both lanes launched), its lanes' session files. */
function seedRun(context: SeedContext, root: string, runId: string): LaneSessionFiles[] {
  const { writeRun, receipt, internalEvent, leakFor, repository } = context
  const at = exportAt
  const runDir = join(root, runId)
  const lanes = laneSessionsOf(runId, runDir)
  const sessionOf = (lane: string) => lanes.find(entry => entry.lane === lane)?.sessionId ?? (lane === 'ui' ? UI_SESSION : ADAPTER_SESSION)
  const launched = { ui: receipt('ui', runDir, sessionOf('ui'), at('08:55:10')), adapter: receipt('adapter', runDir, sessionOf('adapter'), at('08:55:12')) }
  const launch = [internalEvent(1, at('08:55:10'), 'ui', 'running', LAUNCHING), internalEvent(2, at('08:55:12'), 'adapter', 'running', LAUNCHING)]
  const finished = RUN_SHAPES[runId] === 'succeeded'
  writeRun(root, repository, runId, {
    createdAt: at('08:55:00'), updatedAt: finished ? at('09:45:00') : at('09:58:30'), definitionNodes: GRAPH_NODES, definitionName: UX_TEAMS_WORKFLOW_NAME,
    values: finished ? {
      ...launched, snapshots: { ui: OUTPUT_COMMIT_UI, adapter: OUTPUT_COMMIT_ADAPTER },
      ui_packet: 'verification/worker/ui/1/packet.json', adapter_packet: 'verification/worker/adapter/1/packet.json',
      bundle: { run_id: runId, base_commit: BASE_COMMIT, candidate_commit: CANDIDATE_COMMIT, policy_sha256: 'e'.repeat(64) },
      review: { run_id: runId, verdict: 'approved', independent: true, reviewer: 'synthetic-reviewer', findings: [] },
      approved_bundle: 'f'.repeat(64), integrated_commit: CANDIDATE_COMMIT,
    } : {},
    next: finished ? [] : ['handoff'],
    tasks: [],
    events: finished ? [
      ...launch,
      internalEvent(3, at('09:21:00'), 'freeze', 'succeeded', 'Captured both worker snapshots'),
      internalEvent(4, at('09:30:00'), 'verify_ui', 'succeeded', 'UI verification passed'),
      internalEvent(5, at('09:30:00'), 'verify_adapter', 'succeeded', 'Adapter verification passed'),
      internalEvent(6, at('09:40:00'), 'review', 'approved', 'Independent reviewer approved the candidate'),
      internalEvent(7, at('09:45:00'), 'integrate', 'succeeded', 'Fast-forwarded the feature branch'),
    ] : launch,
    packets: dir => (finished ? finishedPackets(context, runId, dir) : []),
    review: null,
    inputs: rawInputsSection(runId, leakFor(root, runId)),
  })
  writeLaneSessionFiles(runDir, runId, lanes)
  if (runId === TEAMS_RUNS.base) {
    const write = (name: string, value: unknown) => writeFileSync(join(runDir, name), `${JSON.stringify(value, null, 2)}\n`)
    write('challenge.json', { version: '1.0.0', run_id: runId, status: 'passed', attempt: 1 })
    write('challenge-1.stdout.json', { session_id: BASE_CHALLENGE.sessionId, total_cost_usd: BASE_CHALLENGE.costUsd, duration_ms: BASE_CHALLENGE.durationMs, modelUsage: { [BASE_CHALLENGE.model]: {} } })
  }
  for (const lane of lanes) mkdirSync(lane.worktree, { recursive: true })
  return lanes
}

/** Every run of the workflow, so the real server serves each run the mock does; the seeded runs also get Claude Code's records. */
function seed(context: SeedContext) {
  const root = context.runsRoot(UX_TEAMS_WORKFLOW_ID)
  for (const runId of Object.keys(RUN_SHAPES)) {
    const lanes = seedRun(context, root, runId)
    const teams = runId === TEAMS_RUNS.seeded ? seededTeams() : runId === TEAMS_RUNS.seededLive ? seededLiveTeams() : null
    if (teams === null) continue
    const worktreeOf = (lane: string | null) => lanes.find(entry => entry.lane === lane)!.worktree
    writeTeamRecords(context.claudeHome, teams.sessions.map(session => ({ session, worktree: worktreeOf(session.lane) })))
  }
  return { workflows: [{ workflow_id: UX_TEAMS_WORKFLOW_ID, runs_root: root, definition: { name: UX_TEAMS_WORKFLOW_NAME, nodes: GRAPH_NODES } }] }
}

export const uxTeams: UxFixtureModule = { payloads: payloads(), seed }

/** For the parity unit test: the seeded runs' lane session files and payloads, written the way `seed` writes them. */
export const SEEDED_TEAMS = { [TEAMS_RUNS.seeded]: seededTeams, [TEAMS_RUNS.seededLive]: seededLiveTeams } as const
export { laneSessionsOf, sessionsOf }
