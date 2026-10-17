import assert from 'node:assert/strict'
import fs, { chmod, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { SessionRow } from '../contracts/projects/sessions.ts'
import { validateTeams, type TeamWorkflow, type Teams } from '../contracts/projects/teams.ts'
import { createApp } from './app.ts'
import { parseProjectsConfig } from './projectsConfig.ts'
import { MAX_WORKFLOWS, TeamReader, UNREADABLE_REASON, claudeHomeOf, parseScriptMeta, providersOfCommand, teamSessionRows } from './teams.ts'

/**
 * The team reader and the teams route (docs/PRD_RUN_TEAMS.md "Team reader"): finished and live Workflow-tool records, agent
 * states (queued, running, done, failed, interrupted), cached and repeated agents, the 400-agent cap, torn transcript lines,
 * a session's two slug folders, providers and edited files (relative or redacted), symlinked and unreadable folders, and the
 * route's HTTP contract. Every Claude home, run directory and worktree lives under a temporary root; the real `~/.claude` is
 * never read.
 */

const SID = {
  worker: '9f1c2d3e-4b5a-6789-8abc-def012345678',
  repair: '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9',
  challenge: '11223344-5566-7788-99aa-bbccddeeff00',
  pi: '22334455-6677-4899-8aab-bccddeeff001',
}
const T0 = Date.parse('2026-10-16T09:00:00Z')
const SLUG = '-tmp-worktree-server'
const OTHER_SLUG = '-tmp-elsewhere'

const json = (value: unknown) => `${JSON.stringify(value)}\n`
const agentId = (n: number) => `a${n.toString(16).padStart(16, '0')}`

function row(key: string, role: SessionRow['role'], sessionId: string | null, fields: Partial<SessionRow> = {}): SessionRow {
  return {
    key, role, label: key, node_id: null, lane: null, round: null, transport: null, model: null, status: 'running', verdict: null, findings: null,
    started_at: null, ended_at: null, duration_seconds: null, cost_usd: null, cost_kind: null, session_id: sessionId, resume: null, ...fields,
  }
}

type Env = { root: string; claudeHome: string; projects: string; worktree: string; folder: (sid?: string, slug?: string) => Promise<string> }

async function withEnv(run: (env: Env) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'md-manager-teams-'))
  try {
    const claudeHome = join(root, 'claude-home')
    const projects = join(claudeHome, 'projects')
    const worktree = join(root, 'run', 'worktree-server')
    await mkdir(worktree, { recursive: true })
    await mkdir(projects, { recursive: true })
    const folder = async (sid = SID.worker, slug = SLUG) => {
      const path = join(projects, slug, sid)
      await mkdir(path, { recursive: true })
      return path
    }
    await run({ root, claudeHome, projects, worktree, folder })
  } finally {
    await chmodTree(root)
    await rm(root, { recursive: true, force: true })
  }
}

/** Restores permissions a test removed so the temporary root can be deleted. */
async function chmodTree(root: string) {
  await chmod(join(root, 'claude-home', 'projects', SLUG, SID.challenge), 0o700).catch(() => {})
  await chmod(join(root, 'claude-home', 'projects'), 0o700).catch(() => {})
}

async function read(env: Env, rows: SessionRow[], options: { now?: number; worktree?: string | null } = {}): Promise<Teams> {
  const reader = new TeamReader({ claudeHome: env.claudeHome, now: () => options.now ?? Date.now() })
  const worktrees = new Map<string, string>()
  if (options.worktree !== null) for (const r of rows) worktrees.set(r.key, options.worktree ?? env.worktree)
  return validateTeams(await reader.read({ runId: 'run-001', rows, worktrees }))
}

const workerRow = (fields: Partial<SessionRow> = {}) => row('worker:server', 'worker', SID.worker, { lane: 'server', node_id: 'launch_server', label: 'Worker · server', ...fields })

function progressAgent(index: number, fields: Record<string, unknown> = {}) {
  return {
    type: 'workflow_agent', index, label: `impl:part-${index}`, phaseIndex: 1, phaseTitle: 'Implement', agentId: agentId(index), model: 'claude-opus-5-5',
    state: 'done', startedAt: T0 + index * 1000, queuedAt: T0, attempt: 1, lastToolName: 'Bash', lastToolSummary: 'npm test', promptPreview: 'Build it',
    lastProgressAt: T0 + 60_000 + index * 1000, tokens: 1000 + index, toolCalls: 10, durationMs: 59_000, resultPreview: '{"ok":true}', ...fields,
  }
}

function summary(runId: string, fields: Record<string, unknown> = {}) {
  return {
    runId, taskId: 'wabc', timestamp: new Date(T0 + 120_000).toISOString(), startTime: T0, durationMs: 120_000, workflowName: 'build-run-teams',
    summary: 'Build and review', script: 'export const meta = {}', scriptPath: '/somewhere/else.js', status: 'completed', defaultModel: 'claude-opus-5-5',
    phases: [{ title: 'Implement', detail: 'parallel builders' }, { title: 'Review' }], agentCount: 2, totalTokens: 2003, totalToolCalls: 20,
    result: { implemented: true }, logs: ['2 builders done', 'wrote /home/agentops/secret/file.ts'],
    workflowProgress: [{ type: 'workflow_phase', index: 1, title: 'Implement' }, progressAgent(1), progressAgent(2)],
    ...fields,
  }
}

async function writeFinal(folder: string, runId: string, value: unknown) {
  await mkdir(join(folder, 'workflows'), { recursive: true })
  await writeFile(join(folder, 'workflows', `${runId}.json`), json(value))
}

type Tool = { name: string; input: Record<string, unknown> }
function assistantLine(at: number, tools: Tool[], usage = { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 }) {
  return JSON.stringify({
    parentUuid: null, isSidechain: true, type: 'assistant', timestamp: new Date(at).toISOString(), sessionId: SID.worker,
    message: { model: 'claude-sonnet-5-5', usage, content: [{ type: 'text', text: 'working on it' }, ...tools.map((tool, n) => ({ type: 'tool_use', id: `t${n}`, ...tool }))] },
  })
}
function userLine(at: number) {
  return JSON.stringify({ type: 'user', timestamp: new Date(at).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 't0', content: 'secret transcript text' }] } })
}

async function writeLive(folder: string, runId: string, agents: { id: string; label: string; phase: string; lines: string[]; meta?: Record<string, unknown>; result?: unknown; failed?: boolean }[]) {
  const dir = join(folder, 'subagents', 'workflows', runId)
  await mkdir(dir, { recursive: true })
  const journal = [json({ type: 'launched' })]
  for (const agent of agents) {
    journal.push(json({ type: 'started', key: `v2:${agent.id}`, agentId: agent.id, label: agent.label, phase: agent.phase }))
    await writeFile(join(dir, `agent-${agent.id}.meta.json`), json({ agentType: 'workflow-subagent', description: agent.label, workflowPhase: agent.phase, model: 'sonnet', ...agent.meta }))
    await writeFile(join(dir, `agent-${agent.id}.jsonl`), agent.lines.join('\n') + '\n')
  }
  for (const agent of agents) {
    if (agent.result !== undefined) journal.push(json({ type: 'result', key: `v2:${agent.id}`, agentId: agent.id, result: agent.result }))
    if (agent.failed) journal.push(json({ type: 'failed', key: `v2:${agent.id}`, agentId: agent.id }))
  }
  await writeFile(join(dir, 'journal.jsonl'), journal.join(''))
  return dir
}

async function ageTree(dir: string, names: string[], ms: number) {
  const when = new Date(Date.now() - ms)
  for (const name of names) await utimes(join(dir, name), when, when)
}

function only(teams: Teams, key = 'worker:server'): TeamWorkflow[] {
  const session = teams.sessions.find(entry => entry.key === key)
  assert.ok(session, `session ${key}`)
  return session.workflows
}

// ---- Finished workflows -------------------------------------------------------------------------------------------

test('teams: a finished completed workflow is read from its summary, with phases, agents, logs, result and totals', async () => {
  await withEnv(async env => {
    const folder = await env.folder()
    await writeFinal(folder, 'wf_1a2b3c4d-5e6', summary('wf_1a2b3c4d-5e6'))
    const teams = await read(env, [workerRow()])
    assert.equal(teams.contract_version, '1.0.0')
    assert.equal(teams.run_id, 'run-001')
    const [session] = teams.sessions
    assert.equal(session!.records, 'found')
    assert.equal(session!.reason, null)
    assert.equal(session!.lane, 'server')
    const [workflow] = session!.workflows
    assert.equal(workflow!.run_id, 'wf_1a2b3c4d-5e6')
    assert.equal(workflow!.record, 'final')
    assert.equal(workflow!.status, 'completed')
    assert.equal(workflow!.name, 'build-run-teams')
    assert.equal(workflow!.description, 'Build and review')
    assert.equal(workflow!.started_at, new Date(T0).toISOString())
    assert.equal(workflow!.ended_at, new Date(T0 + 120_000).toISOString())
    assert.equal(workflow!.duration_ms, 120_000)
    assert.equal(workflow!.agent_count, 2)
    assert.equal(workflow!.tool_calls, 20)
    assert.equal(workflow!.context_tokens, 2003)
    assert.equal(workflow!.default_model, 'claude-opus-5-5')
    assert.deepEqual(workflow!.phases.map(phase => [phase.index, phase.title, phase.detail, phase.agents, phase.done]), [[1, 'Implement', 'parallel builders', 2, 2], [2, 'Review', null, 0, 0]])
    assert.deepEqual(workflow!.logs, ['2 builders done', 'wrote <path>'])
    assert.equal(workflow!.result_preview, '{"implemented":true}')
    assert.equal(workflow!.error, null)
    const agent = workflow!.agents[0]!
    assert.equal(agent.agent_id, agentId(1))
    assert.equal(agent.label, 'impl:part-1')
    assert.equal(agent.role, 'impl')
    assert.equal(agent.state, 'done')
    assert.equal(agent.phase, 'Implement')
    assert.equal(agent.phase_index, 1)
    assert.equal(agent.context_tokens, 1001)
    assert.equal(agent.tool_calls, 10)
    assert.equal(agent.started_at, new Date(T0 + 1000).toISOString())
    assert.equal(agent.last_tool_summary, 'npm test')
    assert.equal(agent.prompt_preview, 'Build it')
    assert.equal(agent.result_preview, '{"ok":true}')
    assert.equal(agent.cached, false)
    assert.equal(agent.isolated, false)
    assert.deepEqual(teams.totals, { sessions_with_teams: 1, workflows: 1, workflows_running: 0, agents: 2, queued: 0, running: 0, done: 2, failed: 0, interrupted: 0, tool_calls: 20 })
  })
})

test('teams: a killed workflow lists its unfinished agents as interrupted and its queued ones as queued; its error is one redacted line', async () => {
  await withEnv(async env => {
    const folder = await env.folder()
    await writeFinal(folder, 'wf_00000001-aaa', summary('wf_00000001-aaa', {
      status: 'killed', error: 'Error: Workflow aborted at /home/agentops/x.js\n    at stack (/tmp/y.js:1:1)',
      workflowProgress: [progressAgent(1, { state: 'progress' }), { type: 'workflow_agent', index: 2, label: 'review', phaseIndex: 2, state: 'start', queuedAt: T0 }],
    }))
    await writeFinal(folder, 'wf_00000002-bbb', summary('wf_00000002-bbb', { status: 'weird', startTime: T0 + 999_999 }))
    const [killed, odd] = only(await read(env, [workerRow()]))
    assert.equal(killed!.status, 'killed')
    assert.equal(killed!.error, 'Error: Workflow aborted at <path>')
    assert.deepEqual(killed!.agents.map(agent => [agent.index, agent.state, agent.agent_id, agent.role]), [[1, 'interrupted', agentId(1), 'impl'], [2, 'queued', null, null]])
    assert.deepEqual(killed!.phases.map(phase => [phase.title, phase.interrupted, phase.queued]), [['Implement', 1, 0], ['Review', 0, 1]])
    // An unknown status word is interrupted; workflows are oldest first.
    assert.equal(odd!.status, 'interrupted')
  })
})

test('teams: a journal failed line marks the agent failed; cached agents are cached; repeated labels keep distinct indexes', async () => {
  await withEnv(async env => {
    const folder = await env.folder()
    await writeFinal(folder, 'wf_00000003-ccc', summary('wf_00000003-ccc', {
      workflowProgress: [
        progressAgent(1, { label: 'review:gpt', state: 'progress' }),
        progressAgent(2, { label: 'review:gpt', cached: true }),
        progressAgent(2, { label: 'review:gpt', agentId: agentId(3) }),
      ],
    }))
    await writeLive(folder, 'wf_00000003-ccc', [
      { id: agentId(1), label: 'review:gpt', phase: 'Implement', lines: [assistantLine(T0, [])], failed: true },
    ])
    const [workflow] = only(await read(env, [workerRow()]))
    assert.deepEqual(workflow!.agents.map(agent => [agent.index, agent.label, agent.state, agent.cached]), [
      [1, 'review:gpt', 'failed', false], [2, 'review:gpt', 'done', true], [3, 'review:gpt', 'done', false],
    ])
  })
})

test('teams: at most 400 agents are listed and agents_more counts the rest; totals count the listed ones', async () => {
  await withEnv(async env => {
    const folder = await env.folder()
    const progress = Array.from({ length: 450 }, (_, n) => progressAgent(n + 1))
    await writeFinal(folder, 'wf_00000004-ddd', summary('wf_00000004-ddd', { agentCount: 450, workflowProgress: progress }))
    const teams = await read(env, [workerRow()])
    const [workflow] = only(teams)
    assert.equal(workflow!.agents.length, 400)
    assert.equal(workflow!.agents_more, 50)
    assert.equal(workflow!.agent_count, 450)
    assert.equal(teams.totals.agents, 400)
    assert.equal(teams.totals.tool_calls, 4000)
  })
})

// ---- Transcripts ----------------------------------------------------------------------------------------------------

test('teams: a torn last transcript line is skipped; times come from the first and the last complete line', async () => {
  await withEnv(async env => {
    const folder = await env.folder()
    const lines = [
      assistantLine(T0, [{ name: 'Read', input: { file_path: join(env.worktree, 'a.ts') } }]),
      userLine(T0 + 1000),
      // Two lines spliced together: unparseable, skipped.
      assistantLine(T0 + 2000, [{ name: 'Edit', input: { file_path: join(env.worktree, 'spliced.ts') } }]).slice(0, 80) + assistantLine(T0 + 2500, []),
      assistantLine(T0 + 3000, [{ name: 'Write', input: { file_path: join(env.worktree, 'src', 'b.ts') } }], { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 }),
    ]
    const dir = await writeLive(folder, 'wf_00000005-eee', [{ id: agentId(1), label: 'impl', phase: 'Build', lines }])
    // A torn last line, as a live file ends mid-write.
    await writeFile(join(dir, `agent-${agentId(1)}.jsonl`), lines.join('\n') + '\n' + assistantLine(T0 + 9000, [{ name: 'Edit', input: { file_path: '/x' } }]).slice(0, 120))
    const [workflow] = only(await read(env, [workerRow()]))
    const agent = workflow!.agents[0]!
    assert.equal(workflow!.record, 'live')
    assert.equal(agent.started_at, new Date(T0).toISOString())
    assert.equal(agent.last_activity_at, new Date(T0 + 3000).toISOString())
    assert.equal(agent.duration_ms, 3000)
    assert.equal(agent.tool_calls, 2)
    assert.equal(agent.last_tool, 'Write')
    assert.equal(agent.context_tokens, 6)
    assert.equal(agent.model, 'claude-sonnet-5-5')
    assert.deepEqual(agent.files_edited, ['src/b.ts'])
    assert.ok(!JSON.stringify(workflow).includes('secret transcript text'))
    assert.ok(!JSON.stringify(workflow).includes('working on it'))
  })
})

test('teams: providers come from Bash commands (pi --model, muse exec, agy); edited files are worktree-relative or redacted', async () => {
  assert.deepEqual(providersOfCommand('cd x && pi -p --model openai-codex/gpt-6-astra "review"'), ['openai-codex/gpt-6-astra'])
  assert.deepEqual(providersOfCommand('muse exec --model wonder-2 < prompt'), ['muse/wonder-2'])
  assert.deepEqual(providersOfCommand('muse exec < prompt'), ['muse'])
  assert.deepEqual(providersOfCommand('agy --model=gemini-4-argon -p x'), ['agy/gemini-4-argon'])
  assert.deepEqual(providersOfCommand('curl https://api example; pip install x; npm run api --model y'), [])
  await withEnv(async env => {
    const folder = await env.folder()
    const isolated = join(env.root, 'isolated-wt')
    const lines = [assistantLine(T0, [
      { name: 'Bash', input: { command: 'pi -p --model openai-codex/gpt-6-astra "go"' } },
      { name: 'Bash', input: { command: 'muse exec --model wonder-2 x' } },
      { name: 'Bash', input: { command: 'pi -p --model openai-codex/gpt-6-astra again' } },
      { name: 'Edit', input: { replace_all: false, file_path: join(env.worktree, 'server', 'teams.ts') } },
      { name: 'MultiEdit', input: { file_path: join(env.worktree, 'server', 'teams.ts') } },
      { name: 'Write', input: { file_path: '/home/agentops/.ssh/config' } },
      { name: 'NotebookEdit', input: { notebook_path: join(env.root, 'outside', 'n.ipynb') } },
    ])]
    await writeLive(folder, 'wf_00000006-fff', [
      { id: agentId(1), label: 'impl:server', phase: 'Build', lines },
      { id: agentId(2), label: 'impl:iso', phase: 'Build', lines: [assistantLine(T0, [{ name: 'Write', input: { file_path: join(isolated, 'iso.ts') } }])], meta: { worktreePath: isolated } },
    ])
    const teams = await read(env, [workerRow()])
    const [workflow] = only(teams)
    const [server, iso] = workflow!.agents
    assert.deepEqual(server!.providers, ['openai-codex/gpt-6-astra', 'muse/wonder-2'])
    // Two different outside files stay two entries, each with the <path> marker (never compared, never absolute).
    assert.deepEqual(server!.files_edited, ['server/teams.ts', '<path>/config', '<path>/n.ipynb'])
    assert.equal(server!.files_edited_more, 0)
    assert.equal(iso!.isolated, true)
    assert.deepEqual(iso!.files_edited, ['iso.ts'])
    const text = JSON.stringify(teams)
    assert.ok(!text.includes('/home/'), text)
    assert.ok(!text.includes('/tmp/'), text)
  })
})

test('teams: more than 50 edited files list the first 50 and count the rest', async () => {
  await withEnv(async env => {
    const folder = await env.folder()
    const tools = Array.from({ length: 60 }, (_, n) => ({ name: 'Write', input: { file_path: join(env.worktree, `f${n}.ts`) } }))
    await writeLive(folder, 'wf_00000007-abc', [{ id: agentId(1), label: 'impl', phase: 'Build', lines: [assistantLine(T0, tools)] }])
    const agent = only(await read(env, [workerRow()]))[0]!.agents[0]!
    assert.equal(agent.files_edited.length, 50)
    assert.equal(agent.files_edited_more, 10)
    // No worktree recorded: each file is redacted to its own marked entry and the count stays 60.
    const unknown = only(await read(env, [workerRow()], { worktree: null }))[0]!.agents[0]!
    assert.equal(unknown.files_edited.length, 50)
    assert.equal(unknown.files_edited_more, 10)
    assert.equal(unknown.files_edited[0], '<path>/f0.ts')
    assert.ok(unknown.files_edited.every(file => file.startsWith('<path>/')))
  })
})

test('teams: a transcript cwd is never a base; only files under the recorded worktree are relative, outside files stay distinct and counted', async () => {
  await withEnv(async env => {
    const folder = await env.folder()
    // The line's cwd is a scratch copy of the repository: its files must not pass as worktree-relative paths.
    const cwd = join(env.root, 'scratch-copy')
    const withCwd = (line: string) => JSON.stringify({ ...JSON.parse(line) as Record<string, unknown>, cwd })
    const copies = Array.from({ length: 2 }, (_, n) => ({ name: 'Write', input: { file_path: join(cwd, 'src', 'projects', `f${n}.ts`) } }))
    const inWorktree = { name: 'Write', input: { file_path: join(env.worktree, 'src', 'w.ts') } }
    const outside = [
      { name: 'Edit', input: { file_path: join(env.root, 'elsewhere', 'a.ts') } },
      // A basename clash: two raw paths serve the same string, and the second is counted, not lost.
      { name: 'Edit', input: { file_path: join(env.root, 'third', 'a.ts') } },
      // A relative path has no known base: it is marked too, never served as if it were worktree-relative.
      { name: 'Edit', input: { file_path: 'src/projects/rel.ts' } },
    ]
    await writeLive(folder, 'wf_00000007-cwd', [{ id: agentId(1), label: 'impl', phase: 'Build', lines: [withCwd(assistantLine(T0, [...copies, inWorktree, ...outside]))] }])
    const agent = only(await read(env, [workerRow()]))[0]!.agents[0]!
    assert.deepEqual(agent.files_edited, ['<path>/f0.ts', '<path>/f1.ts', 'src/w.ts', '<path>/a.ts', '<path>/rel.ts'])
    assert.equal(agent.files_edited.length + agent.files_edited_more, 6)
    // Without any recorded worktree no file is relative, whatever the line's cwd.
    const unknown = only(await read(env, [workerRow()], { worktree: null }))[0]!.agents[0]!
    assert.ok(unknown.files_edited.every(file => file.startsWith('<path>/')), JSON.stringify(unknown.files_edited))
    assert.equal(unknown.files_edited.length + unknown.files_edited_more, 6)
    const text = JSON.stringify([agent, unknown])
    assert.ok(!text.includes('/home/'), text)
    assert.ok(!text.includes('/tmp/'), text)
  })
})

// ---- Live workflows -----------------------------------------------------------------------------------------------

test('teams: a live workflow is running while its files changed in the last 15 minutes, else interrupted; a stopped session never runs', async () => {
  await withEnv(async env => {
    const folder = await env.folder()
    const dir = await writeLive(folder, 'wf_cd11e026-619', [
      { id: agentId(1), label: 'map:ui', phase: 'Understand', lines: [assistantLine(T0, []), assistantLine(T0 + 5000, [{ name: 'Read', input: {} }])], result: { summary: 'done' } },
      { id: agentId(2), label: 'map:server', phase: 'Understand', lines: [assistantLine(T0 + 1000, [{ name: 'Bash', input: { command: 'ls' } }])] },
    ])
    const fresh = await read(env, [workerRow()])
    const [running] = only(fresh)
    assert.equal(running!.status, 'running')
    assert.equal(running!.record, 'live')
    assert.equal(running!.ended_at, null)
    assert.equal(running!.duration_ms, null)
    assert.equal(running!.context_tokens, null)
    assert.equal(running!.agent_count, 2)
    assert.equal(running!.tool_calls, 2)
    assert.equal(running!.started_at, new Date(T0).toISOString())
    assert.deepEqual(running!.agents.map(agent => [agent.index, agent.state, agent.phase_index]), [[1, 'done', 1], [2, 'running', 1]])
    assert.equal(running!.agents[0]!.result_preview, '{"summary":"done"}')
    assert.deepEqual(running!.phases.map(phase => [phase.title, phase.running, phase.done]), [['Understand', 1, 1]])
    assert.equal(fresh.totals.workflows_running, 1)
    // The same files 20 minutes later: interrupted.
    const later = only(await read(env, [workerRow()], { now: Date.now() + 20 * 60_000 }))[0]!
    assert.equal(later.status, 'interrupted')
    assert.deepEqual(later.agents.map(agent => agent.state), ['done', 'interrupted'])
    // Fresh files but a stopped session: interrupted.
    assert.equal(only(await read(env, [workerRow({ status: 'stopped' })]))[0]!.status, 'interrupted')
    // Old modification times: interrupted at the current time too.
    await ageTree(dir, ['journal.jsonl', `agent-${agentId(1)}.jsonl`, `agent-${agentId(2)}.jsonl`], 30 * 60_000)
    assert.equal(only(await read(env, [workerRow()]))[0]!.status, 'interrupted')
  })
})

test('teams: a session with two slug folders reads the script under the other slug for the live phases, name and description', async () => {
  await withEnv(async env => {
    const start = await env.folder(SID.worker, SLUG)
    const moved = await env.folder(SID.worker, OTHER_SLUG)
    await writeLive(start, 'wf_7f8e9d0c-b1a', [{ id: agentId(1), label: 'fix:finding-1', phase: 'Fix', lines: [assistantLine(T0, [])] }])
    await mkdir(join(moved, 'workflows', 'scripts'), { recursive: true })
    await writeFile(join(moved, 'workflows', 'scripts', 'fix-review-findings-wf_7f8e9d0c-b1a.js'), [
      'export const meta = {',
      "  name: 'fix-review-findings',",
      "  description: 'Fix the review findings in \\'server\\'', // a comment",
      '  phases: [',
      "    { title: 'Fix', detail: `one per finding` },",
      '    /* the check */ { title: "Check", model: someModel(), detail: `uses ${x}` },',
      '  ],',
      '}',
      'const x = 1',
    ].join('\n'))
    const [workflow] = only(await read(env, [workerRow()]))
    assert.equal(workflow!.name, 'fix-review-findings')
    assert.equal(workflow!.description, "Fix the review findings in 'server'")
    assert.deepEqual(workflow!.phases.map(phase => [phase.index, phase.title, phase.detail, phase.agents]), [[1, 'Fix', 'one per finding', 1], [2, 'Check', null, 0]])
  })
})

test('teams: parseScriptMeta tolerates non-literal values and returns null without a meta object', () => {
  assert.equal(parseScriptMeta('const a = 1'), null)
  assert.deepEqual(parseScriptMeta("export const meta = { name: 'a' + b, description: \"d\", phases: [{ title: 'P', detail: null }, { detail: 'no title' }, 3], extra: { deep: [1, { x: f(1, 2) }] } }"), {
    name: null, description: 'd', phases: [{ title: 'P', detail: null }],
  })
  assert.deepEqual(parseScriptMeta('export const meta = { phases: [ { title: \'Unclosed'), { name: null, description: null, phases: [] })
})

test('teams: the session folder index is cached and refreshed on a miss at most every 5 seconds', async () => {
  await withEnv(async env => {
    let now = Date.now()
    const reader = new TeamReader({ claudeHome: env.claudeHome, now: () => now })
    const readOnce = async () => validateTeams(await reader.read({ runId: 'run-001', rows: [workerRow()], worktrees: new Map() })).sessions[0]!.records
    assert.equal(await readOnce(), 'none')
    const folder = await env.folder()
    await writeFinal(folder, 'wf_1a2b3c4d-5e6', summary('wf_1a2b3c4d-5e6'))
    // Within 5 s of the last listing a miss does not list the projects folder again.
    now += 1000
    assert.equal(await readOnce(), 'none')
    now += 5000
    assert.equal(await readOnce(), 'found')
  })
})

// ---- Records none, unreadable, symlinks, rows -----------------------------------------------------------------------

test('teams: no folder or no workflow records is none; a symlinked session folder is ignored; an unreadable folder is unreadable', async () => {
  await withEnv(async env => {
    // The repair's folder holds only tool results: no workflows.
    const repairFolder = await env.folder(SID.repair)
    await mkdir(join(repairFolder, 'tool-results'), { recursive: true })
    // The worker's folder is a symlink to a folder full of records: never followed.
    const elsewhere = join(env.root, 'elsewhere', SID.worker)
    await mkdir(elsewhere, { recursive: true })
    await writeFinal(elsewhere, 'wf_1a2b3c4d-5e6', summary('wf_1a2b3c4d-5e6'))
    await mkdir(join(env.projects, SLUG), { recursive: true })
    await symlink(elsewhere, join(env.projects, SLUG, SID.worker))
    const unreadable = await env.folder(SID.challenge)
    await writeFinal(unreadable, 'wf_1a2b3c4d-5e6', summary('wf_1a2b3c4d-5e6'))
    await chmod(unreadable, 0o000)
    const rows = [
      workerRow(),
      row('repair:1', 'repair', SID.repair, { lane: 'server', node_id: 'repair-1' }),
      row('challenge:1', 'challenge', SID.challenge, { node_id: 'challenge', transport: 'print' }),
      row('worker:viewer', 'worker', '33333333-4444-4555-8666-777777777777'),
    ]
    const teams = await read(env, rows)
    const records = teams.sessions.map(session => [session.key, session.records, session.reason])
    const asRoot = process.getuid?.() === 0
    assert.deepEqual(records, [
      ['worker:server', 'none', null],
      ['repair:1', 'none', null],
      ['challenge:1', asRoot ? 'found' : 'unreadable', asRoot ? null : UNREADABLE_REASON],
      ['worker:viewer', 'none', null],
    ])
    assert.equal(teams.totals.sessions_with_teams, asRoot ? 1 : 0)
  })
})

test('teams: only Claude session rows with an ID-pattern session id are listed, in the payload order', () => {
  const rows = [
    row('lane:server:1:1', 'lane_reviewer', SID.worker, { transport: 'claude' }),
    row('reviewer:general:2', 'reviewer', SID.repair, { transport: 'native' }),
    row('panel:p1:1', 'panel_provider', SID.challenge, { transport: 'claude' }),
    row('reviewer:gpt:2', 'reviewer', SID.pi, { transport: 'pi' }),
    row('sidecar:1', 'sidecar', SID.challenge, { transport: 'print' }),
    row('worker:viewer', 'worker', null),
    row('worker:bad', 'worker', '../etc'),
    row('attack:1', 'attack', SID.worker, { transport: 'openrouter' }),
    row('night:approval:0', 'night_shift', SID.worker),
  ]
  assert.deepEqual(teamSessionRows(rows).map(entry => entry.key), ['reviewer:general:2', 'sidecar:1'])
})

test('teams: the Claude home is MD_MANAGER_CLAUDE_HOME, else CLAUDE_CONFIG_DIR, else ~/.claude', () => {
  assert.equal(claudeHomeOf({ MD_MANAGER_CLAUDE_HOME: '/t/a', CLAUDE_CONFIG_DIR: '/t/b' }, '/h'), '/t/a')
  assert.equal(claudeHomeOf({ CLAUDE_CONFIG_DIR: '/t/b' }, '/h'), '/t/b')
  assert.equal(claudeHomeOf({}, '/h'), '/h/.claude')
})

// ---- Review findings (F5.1-F5.9) ----------------------------------------------------------------------------------

/** A summary whose phases can only come from a script: no `phases`, no `workflow_phase` entries. */
function scriptOnlySummary(runId: string, scriptPath: string) {
  return summary(runId, { phases: [], scriptPath, workflowProgress: [progressAgent(1)] })
}

test('teams: a summary scriptPath is never followed (another session, a symlinked folder); only the session\'s own script is read (F5.1, F5.2)', async () => {
  await withEnv(async env => {
    const folder = await env.folder()
    // Another session's script under the projects root.
    const otherScripts = join(await env.folder(SID.repair), 'workflows', 'scripts')
    await mkdir(otherScripts, { recursive: true })
    await writeFile(join(otherScripts, 'other-wf_99999999-999.js'), "export const meta = { name: 'other', phases: [{ title: 'OtherPhase' }] }")
    // A slug folder that is a symlink to a folder outside the Claude home.
    const outside = join(env.root, 'outside')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'leak.js'), "export const meta = { name: 'leak', phases: [{ title: 'LeakedPhase' }] }")
    await symlink(outside, join(env.projects, '-linked-slug'))
    await writeFinal(folder, 'wf_00000011-aaa', scriptOnlySummary('wf_00000011-aaa', join(otherScripts, 'other-wf_99999999-999.js')))
    await writeFinal(folder, 'wf_00000012-bbb', scriptOnlySummary('wf_00000012-bbb', join(env.projects, '-linked-slug', 'leak.js')))
    // The session's own script is read for the third.
    await mkdir(join(folder, 'workflows', 'scripts'), { recursive: true })
    await writeFile(join(folder, 'workflows', 'scripts', 'own-wf_00000013-ccc.js'), "export const meta = { name: 'own', phases: [{ title: 'OwnPhase' }] }")
    await writeFinal(folder, 'wf_00000013-ccc', scriptOnlySummary('wf_00000013-ccc', '/anything.js'))
    const teams = await read(env, [workerRow()])
    const byId = new Map(only(teams).map(workflow => [workflow.run_id, workflow]))
    assert.deepEqual(byId.get('wf_00000011-aaa')!.phases, [])
    assert.deepEqual(byId.get('wf_00000012-bbb')!.phases, [])
    assert.deepEqual(byId.get('wf_00000013-ccc')!.phases.map(phase => phase.title), ['OwnPhase'])
    const body = JSON.stringify(teams)
    assert.ok(!body.includes('OtherPhase') && !body.includes('LeakedPhase'), body)
  })
})

test('teams: models, tool names, labels, names and descriptions are redacted or shape-checked; blank ones are null (F5.3)', async () => {
  await withEnv(async env => {
    const folder = await env.folder()
    const key = `ghp_${'A'.repeat(36)}`
    await writeFinal(folder, 'wf_00000021-aaa', summary('wf_00000021-aaa', {
      defaultModel: '/home/agentops/secret-model', workflowName: '   ', summary: '',
      workflowProgress: [progressAgent(1, { model: key, lastToolName: '/home/agentops/tool', label: '', phaseTitle: '  ' }), progressAgent(2, { model: 'claude-opus-5-5[1m]', lastToolName: 'mcp__docs__read' })],
    }))
    const line = JSON.stringify({
      type: 'assistant', timestamp: new Date(T0).toISOString(),
      message: { model: '/home/u/model', usage: { input_tokens: 1 }, content: [{ type: 'tool_use', id: 't', name: `sk-${'x'.repeat(40)}`, input: {} }] },
    })
    await writeLive(folder, 'wf_00000022-bbb', [{ id: agentId(1), label: 'impl', phase: 'Build', lines: [line], meta: { model: `/home/agentops/${key}` } }])
    const teams = await read(env, [workerRow()])
    const [final, live] = only(teams)
    assert.equal(final!.default_model, null)
    assert.equal(final!.name, null)
    assert.equal(final!.description, null)
    assert.deepEqual(final!.agents.map(agent => [agent.label, agent.model, agent.last_tool]), [['agent 1', null, null], ['impl:part-2', 'claude-opus-5-5[1m]', 'mcp__docs__read']])
    assert.equal(final!.agents[0]!.phase, 'Implement', 'a blank phase title falls back to the phase list')
    assert.equal(live!.agents[0]!.model, null)
    assert.equal(live!.agents[0]!.last_tool, null)
    const body = JSON.stringify(teams)
    for (const needle of ['/home/', 'ghp_', 'sk-x']) assert.ok(!body.includes(needle), `${needle} leaked: ${body}`)
  })
})

test('teams: a tool_use block with an empty name is not a tool call and never fails the payload (F5.5)', async () => {
  await withEnv(async env => {
    const folder = await env.folder()
    await writeLive(folder, 'wf_00000031-aaa', [{ id: agentId(1), label: 'impl', phase: 'Build', lines: [assistantLine(T0, [{ name: 'Read', input: {} }, { name: '', input: {} }])] }])
    const agent = only(await read(env, [workerRow()]))[0]!.agents[0]!
    assert.equal(agent.last_tool, 'Read')
    assert.equal(agent.tool_calls, 1)
  })
})

test('teams: a summary that exists but cannot be parsed makes the session unreadable unless a live record stands in (F5.6)', async () => {
  await withEnv(async env => {
    const broken = await env.folder()
    await mkdir(join(broken, 'workflows'), { recursive: true })
    await writeFile(join(broken, 'workflows', 'wf_00000041-aaa.json'), '{"runId": "wf_00000041-aaa", "workflowProg')
    const shapeless = await env.folder(SID.repair)
    await writeFinal(shapeless, 'wf_00000042-bbb', { runId: 'wf_00000042-bbb', status: 'completed' })
    const fallback = await env.folder(SID.challenge)
    await mkdir(join(fallback, 'workflows'), { recursive: true })
    await writeFile(join(fallback, 'workflows', 'wf_00000043-ccc.json'), 'not json')
    await writeLive(fallback, 'wf_00000043-ccc', [{ id: agentId(1), label: 'impl', phase: 'Build', lines: [assistantLine(T0, [])] }])
    const teams = await read(env, [workerRow(), row('repair:1', 'repair', SID.repair), row('challenge:1', 'challenge', SID.challenge)])
    assert.deepEqual(teams.sessions.map(session => [session.key, session.records, session.reason]), [
      ['worker:server', 'unreadable', UNREADABLE_REASON],
      ['repair:1', 'unreadable', UNREADABLE_REASON],
      ['challenge:1', 'found', null],
    ])
    assert.equal(teams.sessions[2]!.workflows[0]!.record, 'live')
  })
})

/** Counts the opens and lstats of files naming one of `ids` while `run` runs. */
async function countTouches(ids: readonly string[], run: () => Promise<void>): Promise<number> {
  const open = fs.open
  const lstat = fs.lstat
  let touches = 0
  const hit = (path: unknown) => { if (typeof path === 'string' && ids.some(id => path.includes(id))) touches += 1 }
  fs.open = ((path: Parameters<typeof open>[0], ...rest: unknown[]) => { hit(path); return (open as (...args: unknown[]) => unknown)(path, ...rest) }) as typeof open
  fs.lstat = ((path: Parameters<typeof lstat>[0], ...rest: unknown[]) => { hit(path); return (lstat as (...args: unknown[]) => unknown)(path, ...rest) }) as typeof lstat
  try {
    await run()
  } finally {
    fs.open = open
    fs.lstat = lstat
  }
  return touches
}

test('teams: the 400-agent cap is applied before any agent meta or transcript is read, final and live (F5.7)', async () => {
  await withEnv(async env => {
    const folder = await env.folder()
    const beyond = Array.from({ length: 50 }, (_, n) => agentId(401 + n))
    await writeFinal(folder, 'wf_00000051-aaa', summary('wf_00000051-aaa', { agentCount: 450, workflowProgress: Array.from({ length: 450 }, (_, n) => progressAgent(n + 1)) }))
    await writeLive(folder, 'wf_00000051-aaa', [])
    const liveDir = join(folder, 'subagents', 'workflows', 'wf_00000052-bbb')
    await mkdir(liveDir, { recursive: true })
    await writeFile(join(liveDir, 'journal.jsonl'), Array.from({ length: 450 }, (_, n) => json({ type: 'started', agentId: agentId(n + 1), label: `impl:${n + 1}`, phase: 'Build' })).join(''))
    let teams: Teams | null = null
    const touches = await countTouches(beyond, async () => { teams = await read(env, [workerRow()]) })
    assert.equal(touches, 0, 'no file of an agent past the cap is opened or statted')
    const [final, live] = only(teams!)
    assert.deepEqual([final!.agents.length, final!.agents_more, final!.agent_count], [400, 50, 450])
    assert.deepEqual([live!.agents.length, live!.agents_more, live!.agent_count], [400, 50, 450])
  })
})

test(`teams: at most ${MAX_WORKFLOWS} workflows per session are listed, the newest by record time (F5.7)`, async () => {
  await withEnv(async env => {
    const folder = await env.folder()
    const ids = Array.from({ length: MAX_WORKFLOWS + 5 }, (_, n) => `wf_${(n + 1).toString(16).padStart(8, '0')}-aaa`)
    for (const [n, id] of ids.entries()) {
      await writeFinal(folder, id, summary(id, { startTime: T0 + n * 1000, workflowProgress: [] }))
      const when = new Date(Date.now() - (ids.length - n) * 60_000)
      await utimes(join(folder, 'workflows', `${id}.json`), when, when)
    }
    const listed = only(await read(env, [workerRow()])).map(workflow => workflow.run_id)
    assert.deepEqual(listed, ids.slice(5))
  })
})

test('teams: a transcript is read on from its last complete line within a per-request byte budget (F5.8)', async () => {
  await withEnv(async env => {
    const folder = await env.folder()
    const first = assistantLine(T0, [{ name: 'Read', input: {} }])
    const second = assistantLine(T0 + 1000, [{ name: 'Write', input: { file_path: join(env.worktree, 'w.ts') } }])
    const dir = await writeLive(folder, 'wf_00000061-aaa', [{ id: agentId(1), label: 'impl', phase: 'Build', lines: [first, second] }])
    const transcript = join(dir, `agent-${agentId(1)}.jsonl`)
    const reader = new TeamReader({ claudeHome: env.claudeHome, readBudgetBytes: Math.max(Buffer.byteLength(first), Buffer.byteLength(second)) + 1 })
    const agentOf = async () => validateTeams(await reader.read({ runId: 'run-001', rows: [workerRow()], worktrees: new Map([['worker:server', env.worktree]]) })).sessions[0]!.workflows[0]!.agents[0]!
    // The first request's budget runs out inside the second line: a cut first read serves nothing, never a partial count.
    const cut = await agentOf()
    assert.equal(cut.tool_calls, null)
    // The next request reads on from that line (the budget covers the rest) and serves the whole file.
    const whole = await agentOf()
    assert.deepEqual([whole.tool_calls, whole.last_tool, whole.files_edited], [2, 'Write', ['w.ts']])
    // A grown file is read on from where it stopped: the bytes already consumed are not read again (a same-length change of
    // the first line, past its head, is not seen), only the new line is.
    const pad = (line: string, length: number) => line + ' '.repeat(length - line.length)
    const changedFirst = pad(assistantLine(T0, []), Buffer.byteLength(first))
    assert.equal(changedFirst.slice(0, 256), first.slice(0, 256))
    const third = assistantLine(T0 + 2000, [{ name: 'Grep', input: {} }])
    await writeFile(transcript, [changedFirst, second, third].join('\n') + '\n')
    const grown = new TeamReader({ claudeHome: env.claudeHome })
    // A fresh reader reads from byte 0 (two tools); the reader with the cached offset counts three.
    assert.equal(validateTeams(await grown.read({ runId: 'run-001', rows: [workerRow()], worktrees: new Map() })).sessions[0]!.workflows[0]!.agents[0]!.tool_calls, 2)
    assert.deepEqual([(await agentOf()).tool_calls, (await agentOf()).last_tool], [3, 'Grep'])
    // A rewritten (shorter, new head) file is read again from byte 0.
    await writeFile(transcript, assistantLine(T0 + 5000, [{ name: 'Bash', input: { command: 'ls' } }]) + '\n')
    assert.deepEqual([(await agentOf()).tool_calls, (await agentOf()).last_tool], [1, 'Bash'])
  })
})

test('teams: the script meta parser stops at a nesting depth; a deeply nested script never fails the route (F5.9)', async () => {
  const deep = `${'['.repeat(60_000)}${']'.repeat(60_000)}`
  assert.deepEqual(parseScriptMeta(`export const meta = { name: 'n', extra: ${deep}, phases: [{ title: 'P' }] }`), { name: 'n', description: null, phases: [{ title: 'P', detail: null }] })
  assert.deepEqual(parseScriptMeta(`export const meta = { name: 'm', phases: ${deep} }`), { name: 'm', description: null, phases: [] })
  await withEnv(async env => {
    const folder = await env.folder()
    await writeLive(folder, 'wf_00000071-aaa', [{ id: agentId(1), label: 'impl', phase: 'Build', lines: [assistantLine(T0, [])] }])
    await mkdir(join(folder, 'workflows', 'scripts'), { recursive: true })
    await writeFile(join(folder, 'workflows', 'scripts', 'deep-wf_00000071-aaa.js'), `export const meta = { name: 'deep', phases: [{ title: 'Plan', x: ${deep} }] }`)
    const [workflow] = only(await read(env, [workerRow()]))
    assert.equal(workflow!.name, 'deep')
    assert.deepEqual(workflow!.phases.map(phase => phase.title), ['Plan', 'Build'])
  })
})

// ---- The route ----------------------------------------------------------------------------------------------------

const NODES = [
  { node_id: 'launch_server', label: 'Server worker', kind: 'worker', depends_on: [] },
  { node_id: 'verify_server', label: 'Verify server', kind: 'verification', depends_on: ['launch_server'] },
] as const

async function seedRun(runsRoot: string, runId: string, worktree: string) {
  const runDir = join(runsRoot, runId)
  await mkdir(runDir, { recursive: true })
  const T = '2026-10-16T09:00:00Z'
  await writeFile(join(runDir, 'run-state.json'), json({
    version: '1.12.0', run_id: runId, base_commit: 'a'.repeat(40), created_at: T, updated_at: T, definition: { name: 'Teams flow', nodes: NODES },
    values: {}, next: [], tasks: [], events: [], verification_packets: [], review: null, inputs: null, sidecar: null, attack: null, panels: null, fix_loop: null, accepted: null,
  }))
  await writeFile(join(runDir, 'plan.json'), json({ run_id: runId, base_commit: 'a'.repeat(40) }))
  await writeFile(join(runDir, 'events.jsonl'), '')
  await writeFile(join(runDir, 'server.interactive.json'), json({ session_id: SID.worker, worktree, launch_requested_at: T, requested: { model: 'claude-opus-5-5' } }))
}

test('teams route: GET and HEAD answer 200 with a validated payload; unknown project, workflow or run is a 404; writes are 405', async () => {
  await withEnv(async env => {
    const previous = process.env.MD_MANAGER_NIGHT_SHIFT_DIR
    process.env.MD_MANAGER_NIGHT_SHIFT_DIR = join(env.root, 'night-shift')
    try {
      const runsRoot = join(env.root, 'runs')
      await seedRun(runsRoot, 'routed', env.worktree)
      const folder = await env.folder()
      await writeFinal(folder, 'wf_1a2b3c4d-5e6', summary('wf_1a2b3c4d-5e6'))
      await writeLive(folder, 'wf_1a2b3c4d-5e6', [{ id: agentId(1), label: 'impl:part-1', phase: 'Implement', lines: [assistantLine(T0, [{ name: 'Edit', input: { file_path: join(env.worktree, 'server', 'x.ts') } }])] }])
      const config = await parseProjectsConfig(JSON.stringify({ version: 1, projects: [{ project_id: 'teams', name: 'Teams', repository: join(env.root, 'repo'), workflows: [{ workflow_id: 'main', runs_root: runsRoot, definition: { name: 'Teams flow', nodes: NODES } }] }] }), 'test registry')
      const app = createApp([], { projects: config, runStore: { claudeHome: env.claudeHome } })
      try {
        const url = '/api/projects/teams/workflows/main/runs/routed/teams'
        const get = await app.inject({ method: 'GET', url })
        assert.equal(get.statusCode, 200, get.body)
        const teams = validateTeams(get.json())
        assert.equal(teams.run_id, 'routed')
        assert.deepEqual(teams.sessions.map(session => [session.key, session.records]), [['worker:server', 'found']])
        // The worktree came from the lane's receipt: the edited file is relative to it.
        assert.deepEqual(teams.sessions[0]!.workflows[0]!.agents[0]!.files_edited, ['server/x.ts'])
        assert.ok(!get.body.includes('/tmp/') && !get.body.includes('/home/'), get.body)
        const head = await app.inject({ method: 'HEAD', url })
        assert.equal(head.statusCode, 200)
        assert.equal(head.body, '')
        for (const [path, code] of [
          ['/api/projects/nobody/workflows/main/runs/routed/teams', 'PROJECT_NOT_FOUND'],
          ['/api/projects/teams/workflows/nothing/runs/routed/teams', 'WORKFLOW_NOT_FOUND'],
          ['/api/projects/teams/workflows/main/runs/missing/teams', 'RUN_NOT_FOUND'],
        ] as const) {
          const response = await app.inject({ method: 'GET', url: path })
          assert.equal(response.statusCode, 404, path)
          assert.equal((response.json() as { error: { code: string } }).error.code, code, path)
        }
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
          const response = await app.inject({ method, url, payload: {} })
          assert.equal(response.statusCode, 405, method)
          assert.equal(response.headers.allow, 'GET, HEAD')
        }
      } finally {
        await app.close()
      }
    } finally {
      if (previous === undefined) delete process.env.MD_MANAGER_NIGHT_SHIFT_DIR
      else process.env.MD_MANAGER_NIGHT_SHIFT_DIR = previous
    }
  })
})
