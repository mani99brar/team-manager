import { z } from 'zod'
import { SESSION_ROLES } from './sessions.js'

/**
 * The run-teams contract (1.0.0, docs/PRD_RUN_TEAMS.md Appendix A), served at
 * `GET /api/projects/:project_id/workflows/:workflow_id/runs/:run_id/teams` (GET and HEAD). A team is the set of agents a
 * Claude Code session fanned out with the Workflow tool ("ultracode"): one session may run several workflows in turn, each
 * with named phases and many agents. The server reads Claude Code's own records of them, metadata only, for every Claude
 * session the run's sessions payload names (`server/teams.ts`):
 *
 * - a finished workflow's summary `<session>/workflows/wf_<id>.json` (`record: 'final'`), written once when it ends;
 * - a live workflow's `<session>/subagents/workflows/<wf>/journal.jsonl`, the agents' `agent-<id>.meta.json` and the facts a
 *   transcript line carries without its text (times, model, tool names, the files an Edit or Write named) (`record: 'live'`).
 *
 * Nothing here is a transcript, an absolute path or a credential: previews are cut and redacted, edited files are relative to
 * the session's worktree (or redacted), and an agent's own words appear only in the 400-character previews the records keep.
 * A session whose folder holds no workflow records is `records: 'none'` (today's single-session workers); a folder that cannot
 * be read is `records: 'unreadable'` with a fixed reason, never an error for the run.
 *
 * This module imports only zod and the sessions contract (which imports only zod), so `contracts/projects/v1.ts` can add
 * `teams: teamsSchema` to its `schemas` map without an import cycle.
 */
export const TEAMS_VERSION = '1.0.0'

const timestamp = z.iso.datetime()
const count = z.number().int().nonnegative()

/** Whether a session's Claude folder holds workflow records. */
export const TEAM_RECORDS = ['found', 'none', 'unreadable'] as const

/**
 * A workflow's status: the summary's own word (`completed`, `failed`, `killed`) once it ended; `running` while its journal or
 * an agent transcript changed in the last 15 minutes and no summary exists; `interrupted` when neither holds (the session
 * stopped or went quiet before the workflow wrote its summary).
 */
export const WORKFLOW_STATUSES = ['running', 'completed', 'failed', 'killed', 'interrupted'] as const

/** Which record a workflow was read from: the final summary, or the live journal and agent files. */
export const WORKFLOW_RECORDS = ['final', 'live'] as const

/**
 * An agent's state: `queued` (in the summary but never started), `running` (started, no result yet, workflow running),
 * `done` (a result, or the summary's `done`), `failed` (the journal's `failed` line), `interrupted` (started, never finished,
 * and its workflow is no longer running).
 */
export const AGENT_STATES = ['queued', 'running', 'done', 'failed', 'interrupted'] as const

export const teamAgentSchema = z.strictObject({
  /** `a` + hex as Claude Code names it; null for an agent that never started (the summary's queued entries). */
  agent_id: z.string().regex(/^a[0-9a-f]{6,40}$/).nullable(),
  /** 1-based order within the workflow (the summary's `index`, else the journal's start order); unique per workflow. */
  index: z.number().int().positive(),
  /** The script's label, e.g. `impl:frontend`; labels repeat, `index` is the key. */
  label: z.string().min(1),
  /** The label's part before its first `:` (`impl`, `review`), null when it has none. */
  role: z.string().min(1).nullable(),
  phase: z.string().min(1).nullable(),
  phase_index: z.number().int().positive().nullable(),
  model: z.string().min(1).nullable(),
  state: z.enum(AGENT_STATES),
  /** Replayed from a resume's cache rather than run again. */
  cached: z.boolean(),
  attempt: z.number().int().positive().nullable(),
  /** Ran in its own git worktree (the summary's `isolation: "worktree"` or a meta `worktreePath`). */
  isolated: z.boolean(),
  started_at: timestamp.nullable(),
  last_activity_at: timestamp.nullable(),
  duration_ms: count.nullable(),
  tool_calls: count.nullable(),
  /** The agent's last context size in tokens (not its spend): the summary's `tokens`, or the last assistant turn's usage. */
  context_tokens: count.nullable(),
  last_tool: z.string().min(1).nullable(),
  /** At most 60 characters, redacted. */
  last_tool_summary: z.string().nullable(),
  /** At most 400 characters, redacted; untrusted agent text, rendered as text only. */
  prompt_preview: z.string().nullable(),
  /** At most 400 characters, redacted; untrusted agent text, rendered as text only. */
  result_preview: z.string().nullable(),
  /** Files an Edit, Write, MultiEdit or NotebookEdit call named, worktree-relative, first 50; edits made through Bash are not seen. */
  files_edited: z.array(z.string().min(1)).max(50),
  files_edited_more: count,
  /** Other providers the agent called through its shell (`pi --model <m>`, `muse exec`, `agy`), e.g. `openai-codex/gpt-6-astra`. */
  providers: z.array(z.string().min(1)).max(10),
})

export const teamPhaseSchema = z.strictObject({
  /** 1-based, in the script's order. */
  index: z.number().int().positive(),
  title: z.string().min(1),
  detail: z.string().nullable(),
  /** The listed agents of this phase by state; a phase the script declares but no agent reached has all zeros. */
  agents: count,
  queued: count,
  running: count,
  done: count,
  failed: count,
  interrupted: count,
})

export const teamWorkflowSchema = z.strictObject({
  /** Claude Code's workflow run id, `wf_<8 hex>-<3 hex>`. */
  run_id: z.string().regex(/^wf_[0-9A-Za-z-]{1,64}$/),
  /** The script's `meta.name` and `meta.description`; null when not recorded. */
  name: z.string().min(1).nullable(),
  description: z.string().nullable(),
  status: z.enum(WORKFLOW_STATUSES),
  record: z.enum(WORKFLOW_RECORDS),
  started_at: timestamp.nullable(),
  ended_at: timestamp.nullable(),
  last_activity_at: timestamp.nullable(),
  duration_ms: count.nullable(),
  default_model: z.string().min(1).nullable(),
  /** Every agent the workflow started or queued (the summary's `agentCount`, else the journal's starts). */
  agent_count: count,
  tool_calls: count.nullable(),
  /** The summary's `totalTokens` (a sum of last context sizes); null for a live workflow. */
  context_tokens: count.nullable(),
  phases: z.array(teamPhaseSchema),
  /** At most 400 agents, in `index` order; `agents_more` counts the rest. */
  agents: z.array(teamAgentSchema).max(400),
  agents_more: count,
  /** The script's `log()` lines, at most 50 of at most 300 characters each, redacted. */
  logs: z.array(z.string()).max(50),
  /** The script's return value as text, at most 600 characters, redacted; untrusted. */
  result_preview: z.string().nullable(),
  /** The first line of the summary's `error`, redacted; null when none. */
  error: z.string().nullable(),
})

export const teamSessionSchema = z.strictObject({
  /** The sessions payload's row key (`worker:server`, `repair:2`); unique in the payload. */
  key: z.string().min(1),
  role: z.enum(SESSION_ROLES),
  label: z.string().min(1),
  node_id: z.string().min(1).nullable(),
  lane: z.string().min(1).nullable(),
  session_id: z.string().min(1),
  records: z.enum(TEAM_RECORDS),
  /** Why `unreadable`; null otherwise. */
  reason: z.string().min(1).nullable(),
  /** Oldest first. Empty unless `records` is `found`. */
  workflows: z.array(teamWorkflowSchema),
})

/** Counts over every listed agent of every workflow. */
export const teamTotalsSchema = z.strictObject({
  sessions_with_teams: count,
  workflows: count,
  workflows_running: count,
  agents: count,
  queued: count,
  running: count,
  done: count,
  failed: count,
  interrupted: count,
  tool_calls: count,
})

export const teamsSchema = z.strictObject({
  contract_version: z.literal(TEAMS_VERSION),
  run_id: z.string().min(1),
  read_at: timestamp,
  /** One entry per Claude session of the run with a session id, in the sessions payload's order. */
  sessions: z.array(teamSessionSchema),
  totals: teamTotalsSchema,
})

export type TeamAgent = z.infer<typeof teamAgentSchema>
export type TeamPhase = z.infer<typeof teamPhaseSchema>
export type TeamWorkflow = z.infer<typeof teamWorkflowSchema>
export type TeamSession = z.infer<typeof teamSessionSchema>
export type TeamTotals = z.infer<typeof teamTotalsSchema>
export type Teams = z.infer<typeof teamsSchema>
export type AgentState = (typeof AGENT_STATES)[number]
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number]

/**
 * The served teams payload's cross-field rules: unique session keys, a session lists workflows exactly when its records are
 * `found` and carries a reason exactly when `unreadable`, unique workflow ids within a session, unique agent indexes within a
 * workflow, and totals that equal the counts over the listed agents.
 */
export function validateTeams(input: unknown): Teams {
  const payload = teamsSchema.parse(input)
  const keys = payload.sessions.map(session => session.key)
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate team session keys')
  const totals = { sessions_with_teams: 0, workflows: 0, workflows_running: 0, agents: 0, queued: 0, running: 0, done: 0, failed: 0, interrupted: 0, tool_calls: 0 }
  for (const session of payload.sessions) {
    if ((session.records === 'found') !== (session.workflows.length > 0)) throw new Error(`Team session ${session.key} lists workflows exactly when its records are found`)
    if ((session.records === 'unreadable') !== (session.reason !== null)) throw new Error(`Team session ${session.key} carries a reason exactly when unreadable`)
    const ids = session.workflows.map(workflow => workflow.run_id)
    if (new Set(ids).size !== ids.length) throw new Error(`Duplicate workflow ids in team session ${session.key}`)
    if (session.workflows.length > 0) totals.sessions_with_teams += 1
    for (const workflow of session.workflows) {
      totals.workflows += 1
      if (workflow.status === 'running') totals.workflows_running += 1
      const indexes = workflow.agents.map(agent => agent.index)
      if (new Set(indexes).size !== indexes.length) throw new Error(`Duplicate agent indexes in workflow ${workflow.run_id}`)
      for (const agent of workflow.agents) {
        totals.agents += 1
        totals[agent.state] += 1
        totals.tool_calls += agent.tool_calls ?? 0
      }
    }
  }
  for (const [name, value] of Object.entries(totals)) {
    if (payload.totals[name as keyof TeamTotals] !== value) throw new Error(`Team totals: ${name} is ${payload.totals[name as keyof TeamTotals]}, the listed agents give ${value}`)
  }
  return payload
}
