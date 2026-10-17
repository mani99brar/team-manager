import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { validateSessions, type Sessions } from '../contracts/projects/sessions.ts'
import { deriveFocus, deriveNow } from '../contracts/projects/triage.ts'
import type { PanelResults, RunDetail, WorkflowDefinition } from '../contracts/projects/v1.ts'
import { createApp } from './app.ts'
import { nightShiftDir } from './nightShift.ts'
import { redactText, RunStore } from './projects.ts'
import { parseProjectsConfig } from './projectsConfig.ts'
import {
  composeResume, isProjectedSessionNode, laneReviewNodeId, panelNodeStatus, projectSessionNodes, reviewerNodeId, reviewerStateOf,
  type SessionNodeInput,
} from './sessions.ts'

/**
 * The sessions route and its readers (docs/PRD_RUN_SESSIONS.md 3, 4; Acceptance of the run-sessions task): every role's rows
 * from its own files, facts null for missing or malformed files, both totals, the lane reviews' fix rounds and no-fix reasons,
 * the night-shift matching and forms, the projected nodes and their statuses, the resume command, redaction and the route's
 * HTTP contract. Every run directory, the night-shift folder and HOME live under a temporary root.
 */

const SHA40 = 'a'.repeat(40)
const SHA64 = 'b'.repeat(64)
const T0 = '2026-01-01T11:00:00Z'
const T1 = '2026-01-01T12:00:00Z'
const SECRET_PATH = '/home/u/x'
const FAKE_KEY = `sk-${'A1b2C3d4'.repeat(3)}`
const BAD_TIME = '2026-02-30T12:00:00Z'

const ID = {
  challenge1: 'd5974d39-f2c8-4e0d-958f-ffd47229d831', challenge2: 'd5974d39-f2c8-4e0d-958f-ffd47229d832',
  server: '2ec98f78-7ccf-44c4-9d09-63b372816e19', viewer: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', repair: '7a1c0f3e-2b4d-4c8e-9f60-1a2b3c4d5e61',
  general: '3f2504e0-4f89-41d3-9a0c-0305e82c3306', coverage: '85323d9c-d437-4b65-8d21-161b3dfb7b6f', critique: 'abda90ef-5635-47b5-a11e-d81f0e899100',
  general1: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', critique1: 'c13bc3d3-d518-4457-8d56-54adfd8eccea',
  sidecar: '11111111-2222-4333-8444-555555555555', attack: '66666666-7777-4888-8999-aaaaaaaaaaaa', laneClaude: '99999999-8888-4777-8666-555555555555',
}

const NODES = [
  { node_id: 'challenge', label: 'Design challenge', kind: 'review', depends_on: [] },
  { node_id: 'launch_server', label: 'Server worker', kind: 'worker', depends_on: ['challenge'] },
  { node_id: 'verify_server', label: 'Verify server', kind: 'verification', depends_on: ['launch_server'] },
  { node_id: 'launch_viewer', label: 'Viewer worker', kind: 'worker', depends_on: ['challenge'] },
  { node_id: 'verify_viewer', label: 'Verify viewer', kind: 'verification', depends_on: ['launch_viewer'] },
  { node_id: 'candidate', label: 'Candidate', kind: 'verification', depends_on: ['verify_server', 'verify_viewer'] },
  { node_id: 'review', label: 'Independent review', kind: 'review', depends_on: ['candidate'] },
  { node_id: 'approval', label: 'Approval', kind: 'integration', depends_on: ['review'] },
] as const

const writeJson = (path: string, value: unknown) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`)

type Severity = 'P0' | 'P1' | 'P2'
function findingsFor(id: string, entries: [Severity, 'open' | 'accepted' | 'resolved'][]) {
  return entries.map(([severity, disposition], index) => ({ severity, message: `${id} finding ${index}`, disposition, worker: null, requirement: null, reviewer: id }))
}
function reviewer(id: string, verdict: 'approved' | 'blocked' | null, status: string, session: string, findings: ReturnType<typeof findingsFor>) {
  return { reviewer_id: id, transport: 'native', session_id: session, verdict, status, findings, launched_at: T0, accepted_at: verdict === null ? null : T1 }
}

type SeedOptions = {
  /** null: no review section (a round is running); undefined: the default blocked round-2 section. */
  review?: unknown
  version?: string
  plan?: string[] | null
  panels?: unknown
  events?: { sequence: number; time: string; node: string; status: string; message: string }[]
  tasks?: unknown[]
  next?: string[]
  fixLoop?: unknown
}

const GENERAL_FINDINGS = findingsFor('general', [['P1', 'open'], ['P1', 'accepted'], ['P2', 'open'], ['P1', 'resolved']])
const COVERAGE_FINDINGS = findingsFor('coverage', [['P1', 'open']])
const CRITIQUE_FINDINGS = findingsFor('critique', [['P2', 'open']])

function defaultReview() {
  return {
    attempt: 2, round: 2, transport: 'native', reviewer_session_id: `${ID.general}, ${ID.coverage}, ${ID.critique}`, independent: true,
    bundle_sha256: SHA64, candidate_commit: SHA40, verdict: 'blocked', reviewed_at: T1, diff: null, delta_from: null, delta_diff: null,
    findings: [...GENERAL_FINDINGS, ...COVERAGE_FINDINGS, ...CRITIQUE_FINDINGS],
    reviewers: [
      reviewer('general', 'blocked', 'blocked', ID.general, GENERAL_FINDINGS),
      reviewer('coverage', 'blocked', 'blocked', ID.coverage, COVERAGE_FINDINGS),
      reviewer('critique', 'approved', 'accepted', ID.critique, CRITIQUE_FINDINGS),
    ],
  }
}

const PANEL_RECORD = {
  version: '1.0.0',
  panels: [{
    id: 'p1', stage: 'review', status: 'succeeded', overlap_threshold: 1, context_bytes: 1000, budget_usd: 1, started_at: T0, ended_at: T1, error: null,
    providers: [
      { transport: 'pi', model: 'openai-codex/gpt-6-sol', effort: null, status: 'ok', cost_usd: 0.2, context_bytes: 1000, finding_ids: ['f1'], error: null },
      { transport: 'claude', model: null, effort: null, status: 'ok', cost_usd: 1.1, context_bytes: 1000, finding_ids: [], error: null },
    ],
    findings: [{ id: 'f1', severity: 'P1', file: 'a.ts', line: 1, title: 'panel finding', detail: 'd', providers_raised: ['openai-codex/gpt-6-sol'], accepted: true, unanchored: false }],
  }],
}

const FIX_LOOP = {
  version: '1.0.0', rounds: 3,
  repairs: [{
    n: 1, node_id: 'repair-1', mode: 'session', lane: 'server', trigger: 'verify', round: 1, rounds: 3, status: 'applied', by: 'controller',
    recorded_at: T0, applied_at: T1, blocked_step: 'verify_server', reentered_steps: ['verify_server'], reason: 'repair session round 1: verify',
    workspace_commit: 'c'.repeat(40), session_id: ID.repair, review_round: null, findings: [], delta: false, fix_files: [], left_behind: [],
    requested: { model: 'claude-opus-5-5', effort: 'medium' }, gate_reasons: [],
  }],
  review_rounds: [],
}

/** Writes the run-state, plan and events of a run directory; the per-session files are each test's own. */
async function writeRunState(runDir: string, runId: string, options: SeedOptions = {}) {
  const version = options.version ?? '1.12.0'
  const events = options.events ?? []
  const state: Record<string, unknown> = {
    version, run_id: runId, base_commit: SHA40, created_at: T0, updated_at: T1,
    definition: { name: 'Sessions flow', nodes: NODES }, values: {}, next: options.next ?? [], tasks: options.tasks ?? [], events,
    verification_packets: [], review: options.review === undefined ? defaultReview() : options.review, inputs: null,
  }
  if (['1.6.0', '1.8.0', '1.9.0', '1.12.0'].includes(version)) state.sidecar = null
  if (['1.8.0', '1.9.0', '1.12.0'].includes(version)) state.attack = null
  if (['1.9.0', '1.12.0'].includes(version)) state.panels = options.panels === undefined ? PANEL_RECORD : options.panels
  if (version === '1.12.0') Object.assign(state, { fix_loop: options.fixLoop ?? null, accepted: null })
  await writeJson(join(runDir, 'run-state.json'), state)
  const plan = options.plan === undefined ? ['general', 'coverage', 'critique'] : options.plan
  await writeJson(join(runDir, 'plan.json'), { run_id: runId, base_commit: SHA40, ...(plan ? { reviewers: plan.map(reviewer_id => ({ reviewer_id })) } : {}) })
  await writeFile(join(runDir, 'events.jsonl'), events.map(event => JSON.stringify({ ...event, run_id: runId })).join('\n') + (events.length ? '\n' : ''))
}

/** Every per-session file of a decided round-2 run (PRD 4's sources), the controller's own status words. */
async function seedFull(runsRoot: string, runId: string) {
  const runDir = join(runsRoot, runId)
  for (const dir of ['lane-review/server', 'lane-review/viewer', 'worktree-server', 'worktree-viewer', 'review-worktree', 'repair-workspace-1', 'critique/1', 'critique/2']) {
    await mkdir(join(runDir, dir), { recursive: true })
  }
  await writeJson(join(runDir, 'challenge.json'), { version: '1.0.0', run_id: runId, status: 'passed', attempt: 2 })
  for (const n of [1, 2]) {
    await writeJson(join(runDir, `challenge-${n}.stdout.json`), { session_id: n === 1 ? ID.challenge1 : ID.challenge2, total_cost_usd: 1.5, duration_ms: 240000, modelUsage: { 'claude-opus-5-5': {} } })
    await writeJson(join(runDir, `challenge-${n}.role.json`), { observed_models: ['claude-opus-5-5'] })
  }
  for (const [lane, session, cost] of [['server', ID.server, 9.17806], ['viewer', ID.viewer, 3.5]] as const) {
    await writeJson(join(runDir, `${lane}.interactive.json`), { session_id: session, worktree: join(runDir, `worktree-${lane}`), launch_requested_at: T0, requested: { model: 'claude-opus-4-8' } })
    await writeJson(join(runDir, `${lane}.cost.json`), { session_id: session, cost_usd: cost, duration_ms: 3463992, recorded_at: T1, models: ['claude-opus-4-8'] })
  }
  await writeJson(join(runDir, 'repair-1.interactive.json'), { session_id: ID.repair, worktree: join(runDir, 'repair-workspace-1'), launch_requested_at: T0, requested: { model: 'claude-opus-5-5' } })
  await writeJson(join(runDir, 'repair-1.cost.json'), { session_id: ID.repair, cost_usd: 1.75, duration_ms: 600000, recorded_at: T1, models: ['claude-opus-5-5'] })
  // Lane reviews: server round 1 has a pi and a claude reviewer and started repair 1; viewer round 1 was refused a fix round.
  await writeJson(join(runDir, 'lane-review', 'server', '1.json'), {
    version: '1.0.0', lane: 'server', round: 1, snapshot: '2635fbfe1da48811b687b96c9de4159efc1168b7', status: 'reviewed', started_at: T0, ended_at: T1, spent_marks: [], repair: 1,
    reviewers: [
      { index: 1, transport: 'pi', model: 'openai-codex/gpt-6.1-sol', status: 'ok', cost_usd: 0.13, duration_seconds: 28.1, cwd: '/tmp/lane-review-a', findings: [{ severity: 'P1', file: 'server/x.ts', line: null, title: 'T1', detail: 'D1' }], error: null },
      { index: 2, transport: 'claude', model: 'claude-opus-5-5', status: 'ok', cost_usd: 1, duration_seconds: 90, cwd: join(runDir, 'worktree-server'), findings: [{ severity: 'P1', file: 'server/y.ts', line: 3, title: 'T2', detail: 'D2' }], error: null },
    ],
  })
  await writeJson(join(runDir, 'lane-review', 'server', 'r1-2-1.pid'), { pid: 1, cwd: join(runDir, 'worktree-server'), marker: `--session-id ${ID.laneClaude}`, worktree: join(runDir, 'worktree-server') })
  await writeJson(join(runDir, 'lane-review', 'viewer', '1.json'), {
    version: '1.0.0', lane: 'viewer', round: 1, snapshot: 'e6cec9dac58e6b821472d56e6c3f085a420fee88', status: 'reviewed', started_at: T0, ended_at: T1, spent_marks: [], repair: null,
    reviewers: [{ index: 1, transport: 'pi', model: null, status: 'ok', cost_usd: 0.2, duration_seconds: 37.7, findings: [{ severity: 'P1', file: 'src/v.ts', line: 7, title: 'T3', detail: 'D3' }], error: null }],
  })
  // Reviewers, round 2: receipts with the controller's words, launch receipts in the review worktree, cost files.
  for (const [id, status, session, late] of [['general', 'blocked', ID.general, false], ['coverage', 'blocked', ID.coverage, true]] as const) {
    await writeJson(join(runDir, `automatic-review-${id}.json`), { reviewer_id: id, transport: 'native', status, session_id: session, accepted_at: T1, accepted_decision: { verdict: 'blocked' }, ...(late ? { late: true } : {}) })
    await writeJson(join(runDir, `review-${id}.interactive.json`), { session_id: session, worktree: join(runDir, 'review-worktree'), launch_requested_at: T0 })
    await writeJson(join(runDir, `review-${id}.cost.json`), { session_id: session, cost_usd: id === 'general' ? 4.2 : 3.1, duration_ms: 2400000, recorded_at: T1, models: ['claude-opus-5-5'] })
  }
  await writeJson(join(runDir, 'automatic-review-critique.json'), { reviewer_id: 'critique', status: 'accepted', session_id: ID.critique, round: 2, launched_at: T0, finished_at: T1 })
  for (const [round, session, cost] of [[1, ID.critique1, 0.69], [2, ID.critique, 0.48]] as const) {
    await writeJson(join(runDir, 'critique', String(round), 'status.json'), { reviewer_id: 'critique', round, session_id: session, launched_at: T0, accepted_decision: { verdict: round === 1 ? 'blocked' : 'approved' } })
    await writeJson(join(runDir, 'critique', String(round), 'stdout.json'), { session_id: session, total_cost_usd: cost, duration_ms: 300000, modelUsage: { 'claude-sonnet-5-5': {} } })
  }
  // The archived round 1.
  await writeJson(join(runDir, 'review.round-1.json'), {
    run_id: runId, verdict: 'blocked', findings: [...findingsFor('general', [['P1', 'open']])],
    reviewers: [reviewer('general', 'blocked', 'blocked', ID.general1, findingsFor('general', [['P1', 'open']])), reviewer('critique', 'blocked', 'blocked', ID.critique1, [])],
  })
  await writeJson(join(runDir, 'automatic-review-general.round-1.json'), { reviewer_id: 'general', status: 'blocked', session_id: ID.general1, accepted_at: T0 })
  // archive_review moved round 1's session files into review-round-1/; the live ones are round 2's.
  await mkdir(join(runDir, 'review-round-1'), { recursive: true })
  await writeJson(join(runDir, 'review-round-1', 'review-general.cost.json'), { session_id: ID.general1, cost_usd: 2.6, duration_ms: 1800000, recorded_at: T0, models: ['claude-opus-4-8'] })
  // Sidecar passes and attack angles: print jobs (workflow/costs.py ROLES).
  await writeJson(join(runDir, 'sidecar-1.stdout.json'), { session_id: ID.sidecar, total_cost_usd: 0.3, duration_ms: 60000, modelUsage: { 'claude-sonnet-5-5': {} } })
  await writeJson(join(runDir, 'attack-1.stdout.json'), { session_id: ID.attack, total_cost_usd: 0.4, duration_ms: 70000, is_error: false, modelUsage: { 'claude-opus-5-5': {} } })
  await writeRunState(runDir, runId, {
    fixLoop: FIX_LOOP,
    events: [
      { sequence: 1, time: T1, node: 'verify_server', status: 'running', message: 'lane_review: server round 1: fix round started as repair-1' },
      { sequence: 2, time: T1, node: 'verify_viewer', status: 'running', message: 'lane_review: viewer round 1: 0 P0, 1 P1 recorded, no fix round (rounds used up, fix loop off or repair cap)' },
    ],
    tasks: [{ node_id: 'review', error: 'Independent review blocked the candidate', interrupts: [], result: null }],
  })
  return runDir
}

async function seedNightShift(dir: string, entry: string, record: Record<string, unknown>, jev?: unknown) {
  const stateDir = join(dir, '2026-01-01', 'states', entry)
  await mkdir(stateDir, { recursive: true })
  await writeJson(join(stateDir, 'record.json'), record)
  if (jev !== undefined) await writeJson(join(stateDir, 'jev.json'), jev)
}

const nightRecord = (runId: string, over: Record<string, unknown>) => ({
  key: `${runId}|${T1}|awaiting_approval|approval`, run_id: runId, kind: 'awaiting_approval', node: 'approval',
  providers: [{ name: 'claude', option: 'hold', text: 'hold', confidence: 'high', needs_operator: true }],
  agreement: 'one provider', decision: 'held', option: 'hold', command: null, held_reason: 'held', ...over,
})

type Env = { root: string; home: string; nightDir: string; store: RunStore; runsRoot: (workflow?: string) => string; sessions: (runId: string, workflow?: string) => Promise<Sessions> }

/** A registry under a temporary root (HOME is the root too), the night-shift folder beside it, the env variable pointing at it. */
async function withEnv(run: (env: Env) => Promise<void>, options: { exposed?: boolean; workflows?: string[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'md-manager-sessions-'))
  const previous = process.env.MD_MANAGER_NIGHT_SHIFT_DIR
  const nightDir = join(root, 'night-shift')
  process.env.MD_MANAGER_NIGHT_SHIFT_DIR = nightDir
  try {
    const workflows = options.workflows ?? ['main']
    const runsRoot = (workflow = 'main') => join(root, 'runs', 'sessions', workflow)
    for (const workflow of workflows) await mkdir(runsRoot(workflow), { recursive: true })
    await mkdir(join(root, 'repo'), { recursive: true })
    const registry = {
      version: 1, ...(options.exposed === false ? {} : { viewer: { expose_run_dir: ['sessions'] } }),
      projects: [{ project_id: 'sessions', name: 'Sessions', repository: join(root, 'repo'), workflows: workflows.map(workflow_id => ({ workflow_id, runs_root: runsRoot(workflow_id), definition: { name: 'Sessions flow', nodes: NODES } })) }],
    }
    const config = await parseProjectsConfig(JSON.stringify(registry), join(root, 'projects.json'))
    const store = new RunStore(config, { home: root, warn: () => {} })
    await run({ root, home: root, nightDir, store, runsRoot, sessions: async (runId, workflow = 'main') => validateSessions(await store.sessions(store.scope('sessions', workflow), runId)) })
  } finally {
    if (previous === undefined) delete process.env.MD_MANAGER_NIGHT_SHIFT_DIR
    else process.env.MD_MANAGER_NIGHT_SHIFT_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
}

// ---- Every role from its files; both totals --------------------------------------------------------------------

test('sessions: every role of PRD 4 becomes rows from its own files, with both totals', async () => {
  await withEnv(async ({ runsRoot, sessions }) => {
    const runDir = await seedFull(runsRoot(), 'full')
    await writeJson(join(runDir, 'server.completion.json'), { status: 'completed' })
    const payload = await sessions('full')
    const byKey = new Map(payload.sessions.map(row => [row.key, row]))
    const roles = new Set(payload.sessions.map(row => row.role))
    for (const role of ['challenge', 'worker', 'repair', 'lane_reviewer', 'reviewer', 'critique', 'sidecar', 'attack', 'panel_provider'] as const) assert.ok(roles.has(role), role)

    assert.deepEqual([byKey.get('challenge:2')!.session_id, byKey.get('challenge:2')!.model, byKey.get('challenge:2')!.cost_usd], [ID.challenge2, 'claude-opus-5-5', 1.5])
    const worker = byKey.get('worker:server')!
    assert.deepEqual([worker.node_id, worker.model, worker.cost_usd, worker.cost_kind, worker.started_at, worker.ended_at], ['launch_server', 'claude-opus-4-8', 9.17806, 'metered', '2026-01-01T11:00:00.000Z', '2026-01-01T12:00:00.000Z'])
    const repair = byKey.get('repair:1')!
    assert.deepEqual([repair.node_id, repair.session_id, repair.cost_usd, repair.status], ['repair-1', ID.repair, 1.75, 'succeeded'])

    // Lane reviewers: one row per reviewer, each its own transport, model, cost (kind) and duration ([L10] 6).
    const pi = byKey.get('lane:server:1:1')!
    const claude = byKey.get('lane:server:1:2')!
    assert.deepEqual([pi.transport, pi.model, pi.cost_usd, pi.cost_kind, pi.duration_seconds, pi.session_id, pi.resume], ['pi', 'openai-codex/gpt-6.1-sol', 0.13, 'covered', 28.1, null, null])
    assert.deepEqual([claude.transport, claude.cost_usd, claude.cost_kind, claude.duration_seconds, claude.session_id], ['claude', 1, 'metered', 90, ID.laneClaude])
    assert.equal(claude.resume!.command, `cd ~/'runs/sessions/main/full/worktree-server' && claude --resume ${ID.laneClaude}`, 'the pid marker names the session; its worktree still exists')
    assert.deepEqual([byKey.get('lane:viewer:1:1')!.model, byKey.get('lane:viewer:1:1')!.findings], [null, { p0: 0, p1: 1, p2: 0 }])

    // Reviewers: the latest round from the export and receipts (late from automatic-review-<id>.json), the archived round too.
    const general = byKey.get('reviewer:general:2')!
    assert.deepEqual([general.node_id, general.verdict, general.status, general.cost_usd, general.model, general.label], ['reviewer-general', 'blocked', 'succeeded', 4.2, 'claude-opus-5-5', 'Reviewer · general · round 2'])
    assert.equal(byKey.get('reviewer:coverage:2')!.verdict, 'late blocked')
    // [L10] 13: an accepted P1 still blocks; a resolved one does not.
    assert.deepEqual(general.findings, { p0: 0, p1: 2, p2: 1 })
    const archived = byKey.get('reviewer:general:1')!
    assert.deepEqual([archived.verdict, archived.session_id, archived.cost_usd, archived.model, archived.duration_seconds, archived.cost_kind, archived.resume!.command],
      ['blocked', ID.general1, 2.6, 'claude-opus-4-8', 1800, 'metered', `claude --resume ${ID.general1}`], 'round 1 reads its own files in review-round-1/')

    // The critique's own sources: its receipt and critique/<round>/{status,stdout}.json, each round its own cost.
    const critique = byKey.get('reviewer:critique:2')!
    assert.deepEqual([critique.role, critique.verdict, critique.cost_usd, critique.model, critique.session_id], ['critique', 'approved', 0.48, 'claude-sonnet-5-5', ID.critique])
    assert.deepEqual([byKey.get('reviewer:critique:1')!.cost_usd, byKey.get('reviewer:critique:1')!.verdict], [0.69, 'blocked'])
    assert.equal(critique.resume!.command, `claude --resume ${ID.critique}`, 'the critique records no directory: the bare form')

    // Sidecar passes and attack angles ([P12]).
    assert.deepEqual([byKey.get('sidecar:1')!.session_id, byKey.get('sidecar:1')!.cost_usd, byKey.get('sidecar:1')!.label], [ID.sidecar, 0.3, 'Sidecar pass 1'])
    assert.deepEqual([byKey.get('attack:1')!.session_id, byKey.get('attack:1')!.cost_usd, byKey.get('attack:1')!.status], [ID.attack, 0.4, 'succeeded'])

    // Panel providers through the panels route's reader; the claude provider is metered, the pi one covered.
    const panel = payload.sessions.filter(row => row.role === 'panel_provider')
    assert.deepEqual(panel.map(row => [row.transport, row.cost_kind, row.node_id]), [['pi', 'covered', 'panel'], ['claude', 'metered', 'panel']])

    // Both totals, apart, by value; every row with no cost counted ([P11]).
    const metered = payload.sessions.filter(row => row.cost_kind === 'metered').reduce((sum, row) => sum + row.cost_usd!, 0)
    const covered = payload.sessions.filter(row => row.cost_kind === 'covered').reduce((sum, row) => sum + row.cost_usd!, 0)
    assert.equal(payload.totals.metered_usd, Math.round(metered * 1e6) / 1e6)
    assert.equal(payload.totals.covered_usd, Math.round(covered * 1e6) / 1e6)
    assert.equal(payload.totals.not_recorded, payload.sessions.filter(row => row.cost_usd === null).length)
    assert.ok(payload.totals.covered_usd >= 0.53)
    assert.ok(payload.totals.metered_usd >= 4.2 + 2.6, 'the archived round\'s spend is in the metered total')

    // Rows in start order, rows without a time last.
    const starts = payload.sessions.map(row => row.started_at ?? row.ended_at).filter((value): value is string => value !== null).map(value => Date.parse(value))
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b))
  })
})

test('sessions: a missing or malformed file makes that fact null or drops that row, never an error for the run', async () => {
  await withEnv(async ({ runsRoot, sessions }) => {
    const runDir = await seedFull(runsRoot(), 'bad')
    await writeFile(join(runDir, 'server.cost.json'), '{not json')
    await writeFile(join(runDir, 'review-general.cost.json'), JSON.stringify({ cost_usd: -3, duration_ms: 'x' }))
    await writeFile(join(runDir, 'lane-review', 'viewer', '1.json'), '[]')
    await writeFile(join(runDir, 'sidecar-1.stdout.json'), 'garbage')
    await writeFile(join(runDir, 'critique', '2', 'stdout.json'), JSON.stringify({ total_cost_usd: 'free' }))
    const payload = await sessions('bad')
    const byKey = new Map(payload.sessions.map(row => [row.key, row]))
    assert.deepEqual([byKey.get('worker:server')!.cost_usd, byKey.get('worker:server')!.session_id], [null, ID.server])
    assert.equal(byKey.get('reviewer:general:2')!.cost_usd, null)
    assert.equal(payload.lane_reviews.some(review => review.lane === 'viewer'), false, 'a malformed record drops its own lane review')
    assert.equal(byKey.has('lane:viewer:1:1'), false)
    assert.deepEqual([byKey.get('sidecar:1')!.status, byKey.get('sidecar:1')!.cost_usd, byKey.get('sidecar:1')!.session_id], ['unknown', null, null])
    assert.equal(byKey.get('reviewer:critique:2')!.session_id, ID.critique, 'the receipt still names the session')
  })
})

test('sessions: a finite but absurd cost reads as not recorded and never makes the totals overflow nor fail the route', async () => {
  await withEnv(async ({ runsRoot, sessions }) => {
    const runDir = await seedFull(runsRoot(), 'huge')
    await writeJson(join(runDir, 'server.cost.json'), { session_id: ID.server, cost_usd: 1e308, duration_ms: 1e308 })
    await writeJson(join(runDir, 'review-general.cost.json'), { cost_usd: 9e307 })
    await writeJson(join(runDir, 'critique', '2', 'stdout.json'), { total_cost_usd: 9e307 })
    const payload = await sessions('huge')
    const byKey = new Map(payload.sessions.map(row => [row.key, row]))
    assert.deepEqual([byKey.get('worker:server')!.cost_usd, byKey.get('worker:server')!.duration_seconds, byKey.get('worker:server')!.session_id], [null, null, ID.server])
    assert.equal(byKey.get('reviewer:general:2')!.cost_usd, null)
    assert.equal(byKey.get('reviewer:critique:2')!.cost_usd, null)
    assert.ok(Number.isFinite(payload.totals.metered_usd) && Number.isFinite(payload.totals.covered_usd))
    assert.ok(payload.totals.metered_usd < 1e9)
  })
})

// ---- The boundary pass ([L11] 3) ----------------------------------------------------------------------------------

test('sessions: a path, a credential and an out-of-range time in every file type never fail the route nor reach the body', async () => {
  await withEnv(async ({ root, runsRoot, nightDir }) => {
    const runDir = await seedFull(runsRoot(), 'hostile')
    const poison = (value: string) => `${value} ${SECRET_PATH} ${FAKE_KEY} /données/runs/x (/用户/run)`
    await writeJson(join(runDir, 'challenge-1.role.json'), { observed_models: [poison('model')] })
    await writeJson(join(runDir, 'server.interactive.json'), { session_id: ID.server, worktree: SECRET_PATH, launch_requested_at: BAD_TIME, requested: { model: poison('m') } })
    await writeJson(join(runDir, 'server.cost.json'), { session_id: ID.server, cost_usd: 1, recorded_at: BAD_TIME, models: [poison('m')] })
    await writeJson(join(runDir, 'repair-1.interactive.json'), { session_id: ID.repair, worktree: SECRET_PATH, launch_requested_at: BAD_TIME, requested: { model: poison('m') } })
    await writeJson(join(runDir, 'review-general.cost.json'), { session_id: ID.general, cost_usd: 4, recorded_at: BAD_TIME, models: [poison('m')] })
    await writeJson(join(runDir, 'automatic-review-critique.json'), { reviewer_id: 'critique', status: 'accepted', session_id: ID.critique, launched_at: BAD_TIME, finished_at: BAD_TIME })
    await writeJson(join(runDir, 'critique', '2', 'stdout.json'), { session_id: ID.critique, total_cost_usd: 0.1, modelUsage: { [poison('m')]: {} } })
    await writeJson(join(runDir, 'sidecar-1.stdout.json'), { session_id: ID.sidecar, total_cost_usd: 0.1, modelUsage: { [poison('m')]: {} } })
    await writeJson(join(runDir, 'lane-review', 'viewer', '1.json'), {
      version: '1.0.0', lane: 'viewer', round: 1, snapshot: poison('snap'), status: poison('reviewed'), started_at: BAD_TIME, ended_at: '2026-01-01T24:00:00Z', spent_marks: [], repair: null,
      reviewers: [{ index: 1, transport: poison('pi'), model: poison('m'), status: poison('ok'), cost_usd: 0.2, duration_seconds: 1, findings: [{ severity: 'P1', file: poison('f'), line: 1, title: poison('t'), detail: poison('d') }], error: poison('e') }],
    })
    await seedNightShift(nightDir, 'hostile-awaiting_approval-1', nightRecord('hostile', {
      key: `hostile|${BAD_TIME}|awaiting_approval|approval`, kind: poison('awaiting_approval'), agreement: poison('agree'), held_reason: poison('held'),
      providers: [{ name: poison('claude'), option: poison('hold'), text: poison('t'), confidence: poison('high'), needs_operator: true, error: poison('e') }],
    }), { pick: poison('claude'), confidence: 0.5, pass_floor: false, model: poison('jev'), cost_usd: 0.01 })
    const config = await parseProjectsConfig(JSON.stringify({ version: 1, projects: [{ project_id: 'sessions', name: 'Sessions', repository: join(root, 'repo'), workflows: [{ workflow_id: 'main', runs_root: runsRoot(), definition: { name: 'Sessions flow', nodes: NODES } }] }] }), 'test registry')
    const app = createApp([], { projects: config })
    try {
      const response = await app.inject({ method: 'GET', url: '/api/projects/sessions/workflows/main/runs/hostile/sessions' })
      assert.equal(response.statusCode, 200, response.body)
      const body = response.body
      for (const needle of [SECRET_PATH, FAKE_KEY, BAD_TIME, '2026-01-01T24:00:00Z', root, '/données', 'données/runs', '/用户', '用户/run']) assert.ok(!body.includes(needle), `${needle} leaked`)
      const payload = validateSessions(response.json())
      assert.equal(payload.night_shift.length, 1, 'the poisoned record is still served, redacted')
      assert.equal(payload.night_shift[0]!.decided_at, '2026-03-02T12:00:00.000Z', 'Feb 30 normalises, never fails the route')
      assert.equal(payload.lane_reviews.find(review => review.lane === 'viewer')!.ended_at, '2026-01-02T00:00:00.000Z')
      // Ordinary words survive the credential filter ([L1]).
      assert.ok(body.includes('openai-codex/gpt-6.1-sol'))
    } finally { await app.close() }
  })
})

test('sessions redaction: a path (one root-level segment too) and a fake 40-character key are removed; task-file and a lone sk- stay intact', () => {
  assert.equal(redactText('see /home/you/secret/run'), 'see <path>')
  assert.equal(redactText('see /données/runs/x, (/用户/run) and file:///Users/zoë/x'), 'see <path>, (<path>) and <path>')
  assert.equal(redactText('a relative données/runs/x stays'), 'a relative données/runs/x stays')
  // CJK puts no space before a path: a path right after a CJK letter is still absolute.
  assert.equal(redactText('无法读取/home/agentops/.ssh/id'), '无法读取<path>')
  assert.equal(redactText('文件/home/u/secret/run と ファイル/etc/x'), '文件<path> と ファイル<path>')
  // A one-segment root path is absolute too; a slash between letters or digits is not a path.
  assert.equal(redactText('cannot open /secret'), 'cannot open <path>')
  assert.equal(redactText('/srv, (/tmp) and file:///etc'), '<path>, (<path>) and <path>')
  assert.equal(redactText('P0/P1 and/or 1/2 stay; ~ and ~5 stay; http://example.com/x stays'), 'P0/P1 and/or 1/2 stay; ~ and ~5 stay; http://example.com/x stays')
  assert.equal(redactText(`token sk-${'x'.repeat(40)}`), 'token <redacted>')
  assert.equal(redactText(`ghp_${'A'.repeat(36)} github_pat_${'b'.repeat(30)} xoxb-1234567890-abc Bearer ${'c'.repeat(30)} token=abcdefghijklmnop password=hunter22`), '<redacted> <redacted> <redacted> <redacted> <redacted> <redacted>')
  assert.equal(redactText('the task-file is fine, sk- alone stays, and so does openai-codex/gpt-6.1-sol'), 'the task-file is fine, sk- alone stays, and so does openai-codex/gpt-6.1-sol')
})

test('sessions redaction (F1.1): credential assignments and Bearer match in any case; ordinary words with those names stay', () => {
  for (const name of ['token', 'Token', 'TOKEN', 'api_key', 'API_KEY', 'ApiKey', 'apikey', 'access_key', 'Access_Key']) {
    assert.equal(redactText(`set ${name}=abcdefghijklmnop now`), name === name.toUpperCase() ? `set ${name}=<redacted> now` : 'set <redacted> now', name)
  }
  for (const name of ['password', 'Password', 'PASSWORD', 'passwd', 'Passwd', 'secret', 'Secret', 'SECRET']) {
    assert.equal(redactText(`use ${name}=hunter2-correct here`), name === name.toUpperCase() ? `use ${name}=<redacted> here` : 'use <redacted> here', name)
  }
  assert.equal(redactText(`bearer ${'a'.repeat(26)} and BEARER ${'b'.repeat(30)}`), '<redacted> and <redacted>')
  assert.equal(redactText('api_key=some-secret-value'), '<redacted>')
  // The minimum tails stay: short values and ordinary words are not credentials.
  const ordinary = 'The token count is 5; Password policy: twelve characters; keyboard, tokenizer, secretary, passwords and api keys; bearer of bad news; Token=short; secret=abc; apikey=12345'
  assert.equal(redactText(ordinary), ordinary)
})

test('sessions redaction: gh OAuth/server/user/refresh tokens, upper-case secret assignments and PEM blocks are removed; ordinary text stays', () => {
  for (const prefix of ['gho', 'ghs', 'ghu', 'ghr']) assert.equal(redactText(`token ${prefix}_${'a1B2'.repeat(9)} printed`), 'token <redacted> printed')
  assert.equal(redactText('TELEGRAM_BOT_TOKEN=123456:AAH-xyz_abc and AWS_SECRET_ACCESS_KEY="wJalr XUtnFEMI" set'), 'TELEGRAM_BOT_TOKEN=<redacted> and AWS_SECRET_ACCESS_KEY=<redacted> set')
  assert.equal(redactText("export OPENAI_API_KEY='abc' DB_PASSWORD=hunter2 MY_SECRET_VALUE=s3 GH_TOKEN=x"), 'export OPENAI_API_KEY=<redacted> DB_PASSWORD=<redacted> MY_SECRET_VALUE=<redacted> GH_TOKEN=<redacted>')
  const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA/BG9uZQ+AAAA\nAAAAAQAAADMAAAAL\n-----END OPENSSH PRIVATE KEY-----`
  assert.equal(redactText(`key:\n${pem}\ndone`), 'key:\n<redacted>\ndone')
  // A block cut before its end line is redacted to the text's end.
  assert.equal(redactText('head -----BEGIN RSA PRIVATE KEY-----\nMIIEow'), 'head <redacted>')
  const ordinary = 'The KEY idea: MONKEY business, TOKEN_COUNT=5, max_tokens=100, SORT_ORDER=asc, KEY = value, ghp_short, gho_, a ----- rule, the TOKEN= alone and -----BEGIN of nothing'
  assert.equal(redactText(ordinary), ordinary)
})

// ---- The route's HTTP contract ------------------------------------------------------------------------------------

test('sessions route: GET and HEAD answer 200; an unknown project, workflow or run is a 404 with the error shape; writes are 405', async () => {
  await withEnv(async ({ root, runsRoot }) => {
    await seedFull(runsRoot(), 'routed')
    const config = await parseProjectsConfig(JSON.stringify({ version: 1, projects: [{ project_id: 'sessions', name: 'Sessions', repository: join(root, 'repo'), workflows: [{ workflow_id: 'main', runs_root: runsRoot(), definition: { name: 'Sessions flow', nodes: NODES } }] }] }), 'test registry')
    const app = createApp([], { projects: config })
    try {
      const url = '/api/projects/sessions/workflows/main/runs/routed/sessions'
      const get = await app.inject({ method: 'GET', url })
      assert.equal(get.statusCode, 200)
      assert.equal(validateSessions(get.json()).contract_version, '1.13.0')
      const head = await app.inject({ method: 'HEAD', url })
      assert.equal(head.statusCode, 200)
      assert.equal(head.body, '')
      for (const [path, code] of [
        ['/api/projects/nobody/workflows/main/runs/routed/sessions', 'PROJECT_NOT_FOUND'],
        ['/api/projects/sessions/workflows/nothing/runs/routed/sessions', 'WORKFLOW_NOT_FOUND'],
        ['/api/projects/sessions/workflows/main/runs/missing/sessions', 'RUN_NOT_FOUND'],
      ] as const) {
        const response = await app.inject({ method: 'GET', url: path })
        assert.equal(response.statusCode, 404, path)
        const body = response.json() as { error: { code: string; message: string } }
        assert.equal(body.error.code, code, path)
        assert.equal(typeof body.error.message, 'string')
      }
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
        const response = await app.inject({ method, url, payload: {} })
        assert.equal(response.statusCode, 405, method)
        assert.equal(response.headers.allow, 'GET, HEAD')
      }
    } finally { await app.close() }
  })
})

// ---- Lane reviews (PRD 3.2) ---------------------------------------------------------------------------------------

test('lane reviews: fix_round from the record\'s own repair, and each recorded no-fix reason; a failed record is a succeeded node', async () => {
  await withEnv(async ({ runsRoot, sessions, store }) => {
    const runDir = join(runsRoot(), 'lanes')
    for (const lane of ['server', 'viewer']) await mkdir(join(runDir, 'lane-review', lane), { recursive: true })
    const record = (lane: string, round: number, over: Record<string, unknown>) => writeJson(join(runDir, 'lane-review', lane, `${round}.json`), {
      version: '1.0.0', lane, round, snapshot: SHA40, status: 'reviewed', started_at: T0, ended_at: T1, spent_marks: [], repair: null,
      reviewers: [{ index: 1, transport: 'pi', model: 'm', status: 'ok', cost_usd: 0.1, duration_seconds: 2, findings: [{ severity: 'P1', file: 'a.ts', line: 1, title: 't', detail: 'd' }], error: null }],
      ...over,
    })
    await record('server', 1, { repair: 4 })
    await record('server', 2, {})
    await record('server', 3, { reviewers: [{ index: 1, transport: 'pi', model: 'm', status: 'ok', cost_usd: 0.1, findings: [{ severity: 'P2', file: null, line: null, title: 't', detail: 'd' }] }] })
    await record('server', 4, { status: 'failed', reviewers: [{ index: 1, transport: 'pi', model: null, status: 'error', cost_usd: null, findings: [], error: 'provider exploded\nsecond line' }] })
    await record('viewer', 1, {})
    await record('viewer', 2, { status: 'running', ended_at: null })
    await record('viewer', 3, { status: 'pending', started_at: null, ended_at: null })
    await writeRunState(runDir, 'lanes', {
      events: [
        { sequence: 1, time: T1, node: 'verify_server', status: 'running', message: 'lane_review: server round 2: 0 P0, 1 P1 recorded, no fix round (rounds used up, fix loop off or repair cap)' },
        { sequence: 2, time: T1, node: 'verify_viewer', status: 'running', message: 'lane_review: viewer round 1: 0 P0, 1 P1 block the lane — a fix round starts' },
      ],
    })
    const payload = await sessions('lanes')
    const fix = (lane: string, round: number) => payload.lane_reviews.find(review => review.lane === lane && review.round === round)!.fix_round
    assert.deepEqual(fix('server', 1), { started: true, repair_node_id: 'repair-4' }, 'the record\'s own repair, never a join on lane and round')
    assert.deepEqual(fix('server', 2), { started: false, reason: 'rounds used up, fix loop off or repair cap' }, 'the gate refusal\'s own words')
    assert.deepEqual(fix('server', 3), { started: false, reason: 'no P0/P1' })
    assert.deepEqual(fix('server', 4), { started: false, reason: 'the review failed: provider exploded' })
    assert.deepEqual(fix('viewer', 1), { started: false, reason: '0 P0, 1 P1 block the lane — a fix round starts' }, 'any other case quotes the round\'s event verbatim')
    assert.deepEqual(fix('viewer', 3), { started: false, reason: 'not recorded' })
    const server1 = payload.lane_reviews.find(review => review.node_id === laneReviewNodeId('server', 1))!
    assert.deepEqual(server1.reviewers, [{ transport: 'pi', model: 'm', status: 'ok', duration_seconds: 2, cost_usd: 0.1, error: null }])
    assert.deepEqual(server1.findings, [{ severity: 'P1', file: 'a.ts', line: 1, title: 't', detail: 'd' }])
    // Node statuses from the records ([L10] 5, [L11] 2): failed → succeeded, running → running, pending → pending.
    const detail = (await store.loadRun(store.scope('sessions', 'main'), 'lanes')).detail
    const status = (id: string) => detail.snapshot.nodes.find(node => node.node_id === id)?.status
    assert.deepEqual([status('lane-review-server-4'), status('lane-review-viewer-2'), status('lane-review-viewer-3'), status('lane-review-server-1')], ['succeeded', 'running', 'pending', 'succeeded'])
    assert.deepEqual(detail.definition.nodes.find(node => node.node_id === 'lane-review-viewer-2')!.depends_on, ['verify_viewer'])
    assert.ok(detail.definition.nodes.every(node => !node.depends_on.some(dep => dep.startsWith('lane-review-'))), 'nothing depends on a lane review node')
  })
})

test('sessions: a worker\'s status comes from its completion and stop evidence, never from its cost file', async () => {
  await withEnv(async ({ runsRoot, sessions }) => {
    const runDir = await seedFull(runsRoot(), 'workers')
    const status = async (lane: string) => (await sessions('workers')).sessions.find(row => row.key === `worker:${lane}`)!.status
    // Both lanes have a cost file; neither has completed or stopped yet.
    assert.deepEqual([await status('server'), await status('viewer')], ['running', 'running'], 'a recorded cost is not completion')
    await writeJson(join(runDir, 'server.completion.json'), { status: 'completed', launch_token: 'tok-1' })
    await writeJson(join(runDir, 'viewer.completion.json'), { status: 'blocked' })
    assert.deepEqual([await status('server'), await status('viewer')], ['succeeded', 'failed'])
    await writeJson(join(runDir, 'viewer.completion.json'), { status: 'question' })
    assert.equal(await status('viewer'), 'stopped')
    // A completion of an earlier launch (another launch token) does not finish this one; a confirmed stop of it does.
    await writeJson(join(runDir, 'server.interactive.json'), { session_id: ID.server, worktree: join(runDir, 'worktree-server'), launch_requested_at: T0, launch_token: 'tok-2' })
    assert.equal(await status('server'), 'running')
    await rm(join(runDir, 'server.cost.json'))
    await writeJson(join(runDir, 'server.stop.json'), { stopped: true, session_id: ID.server })
    assert.equal(await status('server'), 'stopped', 'a stopped worker whose cost was not recorded')
    await writeJson(join(runDir, 'server.stop.json'), { stopped: false, session_id: ID.server })
    assert.equal(await status('server'), 'running')
  })
})

test('sessions: a relaunched lane keeps its archived launch sessions, ended, before its current one', async () => {
  await withEnv(async ({ runsRoot, sessions }) => {
    const runDir = await seedFull(runsRoot(), 'relaunched')
    const before = JSON.stringify((await sessions('relaunched')).sessions)
    const archivedId = 'bbbbbbbb-1111-4222-8333-444444444444'
    // relaunch renamed the dead launch's receipt; the current receipt binds the new session.
    await writeJson(join(runDir, 'server.launch-1.receipt.json'), { session_id: archivedId, worktree: join(runDir, 'worktree-server'), launch_requested_at: T0,
      launch_token: 'tok-0', status: 'needs_reconciliation', requested: { model: 'claude-opus-5-5' } })
    const rows = (await sessions('relaunched')).sessions.filter(row => row.role === 'worker' && row.lane === 'server')
    assert.deepEqual(rows.map(row => [row.key, row.label, row.session_id, row.status]), [
      ['worker:server:launch-1', 'Worker · server (launch 1)', archivedId, 'failed'],
      ['worker:server', 'Worker · server', ID.server, 'running'],
    ])
    assert.equal(rows[0].node_id, rows[1].node_id, 'both on the lane\'s launch node')
    assert.match(rows[0].resume?.command ?? '', new RegExp(`claude --resume ${archivedId}$`))
    // Archives come in number order, not name order (the payload then orders every row by its start); one that does not parse
    // is skipped.
    await writeJson(join(runDir, 'server.launch-10.receipt.json'), { session_id: 'cccccccc-1111-4222-8333-444444444444', launch_requested_at: T0, status: 'attached_session_available' })
    await writeJson(join(runDir, 'server.launch-2.receipt.json'), { session_id: 42 })
    const keys = (await sessions('relaunched')).sessions.filter(row => row.lane === 'server' && row.role === 'worker').map(row => [row.key, row.status])
    assert.deepEqual(keys, [['worker:server:launch-1', 'failed'], ['worker:server:launch-10', 'stopped'], ['worker:server', 'running']])
    // Without an archive the rows are exactly today's.
    for (const n of [1, 2, 10]) await rm(join(runDir, `server.launch-${n}.receipt.json`))
    assert.equal(JSON.stringify((await sessions('relaunched')).sessions), before)
  })
})

test('sessions: a running worker shows no end time, and a relaunch is never given the earlier session\'s cost', async () => {
  await withEnv(async ({ runsRoot, sessions }) => {
    const runDir = await seedFull(runsRoot(), 'relaunch')
    const worker = async (lane: string) => (await sessions('relaunch')).sessions.find(row => row.key === `worker:${lane}`)!
    const facts = (row: Awaited<ReturnType<typeof worker>>) => [row.status, row.session_id, row.started_at, row.ended_at, row.cost_usd, row.model]
    // The same session, still running: its cost so far, but no end time (the cost file's time is when it was recorded).
    assert.deepEqual(facts(await worker('viewer')), ['running', ID.viewer, '2026-01-01T11:00:00.000Z', null, 3.5, 'claude-opus-4-8'])
    // Relaunched: a new launch receipt (another session, no completion or stop of it) beside the earlier session's cost file.
    const relaunched = '7a1c0f3e-2b4d-4c8e-9f60-1a2b3c4d5e62'
    await writeJson(join(runDir, 'server.interactive.json'), { session_id: relaunched, worktree: join(runDir, 'worktree-server'), launch_requested_at: T1, launch_token: 'tok-2', requested: { model: 'claude-opus-5-5' } })
    assert.deepEqual(facts(await worker('server')), ['running', relaunched, '2026-01-01T12:00:00.000Z', null, null, 'claude-opus-5-5'])
    assert.equal((await worker('server')).duration_seconds, null, 'the earlier session\'s duration is not this one\'s')
    // Once the relaunch completes, its own cost file gives its end time and spend.
    await writeJson(join(runDir, 'server.completion.json'), { status: 'completed', launch_token: 'tok-2' })
    await writeJson(join(runDir, 'server.cost.json'), { session_id: relaunched, cost_usd: 2.25, duration_ms: 60000, recorded_at: '2026-01-01T13:00:00Z', models: ['claude-opus-5-5'] })
    assert.deepEqual(facts(await worker('server')), ['succeeded', relaunched, '2026-01-01T12:00:00.000Z', '2026-01-01T13:00:00.000Z', 2.25, 'claude-opus-5-5'])
    assert.equal((await worker('server')).duration_seconds, 60)
  })
})

test('sessions: a decided reviewer whose receipt records an error is failed, not decided', async () => {
  await withEnv(async ({ runsRoot, sessions }) => {
    const runDir = await seedFull(runsRoot(), 'reverr')
    const review = defaultReview()
    review.reviewers[0] = reviewer('general', null, 'blocked', ID.general, GENERAL_FINDINGS)
    await writeRunState(runDir, 'reverr', { review, fixLoop: FIX_LOOP })
    await writeJson(join(runDir, 'automatic-review-general.json'), { reviewer_id: 'general', transport: 'native', status: 'blocked', session_id: ID.general, error: 'deadline passed with no decision' })
    const general = (await sessions('reverr')).sessions.find(row => row.key === 'reviewer:general:2')!
    assert.deepEqual([general.status, general.verdict], ['failed', 'failed'])
    const coverage = (await sessions('reverr')).sessions.find(row => row.key === 'reviewer:coverage:2')!
    assert.deepEqual([coverage.status, coverage.verdict], ['succeeded', 'late blocked'], 'a blocked verdict without an error stays decided')
  })
})

test('sessions: a single-reviewer run whose reviewer returned blocked reads blocked, not failed, though the combined file records the round\'s error', async () => {
  await withEnv(async ({ runsRoot, store, sessions }) => {
    const runDir = join(runsRoot(), 'single')
    await mkdir(runDir, { recursive: true })
    const findings = findingsFor('review', [['P1', 'open']])
    const review = { ...defaultReview(), attempt: 1, round: 1, reviewer_session_id: ID.general, findings, reviewers: [reviewer('review', 'blocked', 'blocked', ID.general, findings)] }
    await writeRunState(runDir, 'single', { review, plan: null, fixLoop: FIX_LOOP })
    // workflow/automatic.py: the default reviewer's status is merged into automatic-review.json, and every block writes its error.
    const error = 'Independent review blocked: review blocked the candidate'
    await writeJson(join(runDir, 'automatic-review.json'), { reviewer_id: 'review', transport: 'native', status: 'blocked', session_id: ID.general, accepted_at: T1, accepted_decision: { verdict: 'blocked' }, error })
    const row = (await sessions('single')).sessions.find(candidate => candidate.key === 'reviewer:review:1')!
    assert.deepEqual([row.node_id, row.status, row.verdict], ['reviewer-review', 'succeeded', 'blocked'])
    const detail = (await store.loadRun(store.scope('sessions', 'main'), 'single')).detail
    assert.equal(detail.snapshot.nodes.find(node => node.node_id === 'reviewer-review')?.status, 'succeeded')
    // The same file with no recorded verdict: the session ended without one, so it failed.
    await writeJson(join(runDir, 'automatic-review.json'), { reviewer_id: 'review', transport: 'native', status: 'blocked', session_id: ID.general, error })
    const crashed = { ...review, findings: [], reviewers: [reviewer('review', null, 'blocked', ID.general, [])] }
    await writeRunState(runDir, 'single', { review: crashed, plan: null, fixLoop: FIX_LOOP })
    const failed = (await sessions('single')).sessions.find(candidate => candidate.key === 'reviewer:review:1')!
    assert.deepEqual([failed.status, failed.verdict], ['failed', 'failed'])
  })
})

test('night shift: a question names its lane and lands on the worker node; controller_blocked and review_blocked on no node (the controller section)', async () => {
  await withEnv(async ({ runsRoot, nightDir, sessions }) => {
    await seedFull(runsRoot(), 'placed')
    await seedNightShift(nightDir, 'q', nightRecord('placed', { key: `placed|${T0}|question|server`, kind: 'question', node: 'server' }))
    await seedNightShift(nightDir, 'c', nightRecord('placed', { key: `placed|${T1}|controller_blocked|controller`, kind: 'controller_blocked', node: 'controller' }))
    await seedNightShift(nightDir, 'a', nightRecord('placed', { key: `placed|2026-01-01T13:00:00Z|review_blocked|review`, kind: 'review_blocked', node: 'review' }))
    const payload = await sessions('placed')
    assert.deepEqual(payload.night_shift.map(decision => [decision.kind, decision.node_id]), [['question', 'launch_server'], ['controller_blocked', null], ['review_blocked', null]], 'PRD 3.3: the controller section, though the record names review')
    const rows = payload.sessions.filter(row => row.role === 'night_shift')
    assert.deepEqual(rows.map(row => row.node_id).sort(), ['launch_server', null, null].sort())
  })
})

// ---- Night shift ([P13], [P1]) -----------------------------------------------------------------------------------

test('night shift: realpath and ~/ matching, another run\'s directory blocks the fallback, the no-dir case only for a unique id', async () => {
  await withEnv(async ({ runsRoot, nightDir, sessions, home }) => {
    const runDir = await seedFull(runsRoot('main'), 'dup')
    const otherDir = await seedFull(runsRoot('other'), 'dup')
    await seedFull(runsRoot('main'), 'unique')
    // Matches through the realpath of a path inside this run's directory.
    await seedNightShift(nightDir, 'a', nightRecord('dup', { key: `dup|${T0}|awaiting_approval|approval`, text: `Awaiting approval for ${join(runDir, 'worktree-server')}` }))
    // Matches home-relative (`~` expanded against HOME).
    await seedNightShift(nightDir, 'b', nightRecord('dup', { key: `dup|${T1}|challenge_paused|challenge`, kind: 'challenge_paused', node: 'challenge', held_reason: `confirm ~/${join('runs', 'sessions', 'main', 'dup')} in the morning` }))
    // Names the other run's directory through `~/`: belongs to that run, never this one.
    await seedNightShift(nightDir, 'c', nightRecord('dup', { held_reason: `see ~/${join('runs', 'sessions', 'other', 'dup')}`, kind: 'question' }))
    // Names no directory: the id is not unique (two `dup` runs), so it is omitted.
    await seedNightShift(nightDir, 'd', nightRecord('dup', { kind: 'controller_blocked', node: 'controller' }))
    // Another run id altogether.
    await seedNightShift(nightDir, 'e', nightRecord('someone-else', {}))
    // `unique` names no directory and its id is unique in the registry: served.
    await seedNightShift(nightDir, 'f', nightRecord('unique', {}))
    const main = await sessions('dup')
    assert.deepEqual(main.night_shift.map(decision => decision.kind), ['awaiting_approval', 'challenge_paused'])
    const other = await sessions('dup', 'other')
    assert.deepEqual(other.night_shift.map(decision => decision.kind), ['question'], `the other run's record lands on it (${otherDir})`)
    assert.equal((await sessions('unique')).night_shift.length, 1)
    assert.equal(nightShiftDir(home, undefined), join(home, '.local', 'state', 'md-manager-workflows', 'night-shift'), 'the default folder resolves from HOME')
  }, { workflows: ['main', 'other'] })
})

test('night shift: a missing folder is an empty list; decided_at from the key, word confidence and every jev form', async () => {
  await withEnv(async ({ runsRoot, nightDir, sessions }) => {
    await seedFull(runsRoot(), 'forms')
    assert.deepEqual((await sessions('forms')).night_shift, [], 'no night-shift folder at all')
    const jevs: [string, unknown, unknown][] = [
      ['empty', {}, undefined], ['false', false, undefined], ['null', null, undefined], ['missing', undefined, undefined],
      ['error', { error: 'jev timed out\nstack' }, undefined], ['not-called', { error: 'not called: one provider' }, undefined],
      ['file', { error: 'not called (agree)' }, { pick: 'gpt', confidence: 0.71, pass_floor: true, model: 'typesafe/jev-1.13', cost_usd: 0.004 }],
    ]
    for (const [index, [name, inline, file]] of jevs.entries()) {
      const record = nightRecord('forms', { key: `forms|2026-01-01T1${index}:00:00Z|${name}|approval`, kind: name, ...(inline === undefined ? {} : { jev: inline }) })
      await seedNightShift(nightDir, name, record, file)
    }
    await seedNightShift(nightDir, 'nokey', nightRecord('forms', { key: null, kind: 'nokey', providers: [{ name: 'gpt-6-astra', option: 'accept', text: 'x', confidence: null, needs_operator: false }] }))
    const payload = await sessions('forms')
    const byKind = new Map(payload.night_shift.map(decision => [decision.kind, decision]))
    for (const name of ['empty', 'false', 'null', 'missing']) assert.equal(byKind.get(name)!.jev, null, name)
    assert.deepEqual(byKind.get('error')!.jev, { error: 'jev timed out' })
    assert.deepEqual(byKind.get('not-called')!.jev, { error: 'not called: one provider' })
    assert.deepEqual(byKind.get('file')!.jev, { pick: 'gpt', confidence: 0.71, pass_floor: true }, 'jev.json wins over the inline form')
    assert.equal(byKind.get('error')!.decided_at, '2026-01-01T14:00:00.000Z')
    assert.equal(byKind.get('nokey')!.decided_at, null)
    assert.equal(byKind.get('empty')!.providers[0]!.confidence, 'high')
    assert.equal(byKind.get('nokey')!.providers[0]!.confidence, null)
    // Rows: one per provider (no transport claimed), plus Jev when it was called (a pick or a real error), never a resume.
    const rows = payload.sessions.filter(row => row.role === 'night_shift')
    assert.ok(rows.every(row => row.transport === null && row.resume === null))
    const jevRows = rows.filter(row => row.label.endsWith('· Jev'))
    assert.deepEqual(jevRows.map(row => [row.label, row.model, row.cost_usd, row.status]).sort(), [
      ['Night shift · error · Jev', null, null, 'failed'], ['Night shift · file · Jev', 'typesafe/jev-1.13', 0.004, 'succeeded'],
    ])
    const gpt = rows.find(row => row.model === 'gpt-6-astra')!
    assert.equal(gpt.cost_kind, null)
  })
})

// ---- The projected nodes ([L1], [L4], [L10] 1/5, [L11] 1/2/4) ------------------------------------------------------

const DEFINITION: WorkflowDefinition = {
  contract_version: '1.0.0', project_id: 'sessions', workflow_id: 'main', definition_revision: SHA64, name: 'Sessions flow',
  nodes: NODES.map(node => ({ ...node, depends_on: [...node.depends_on] })),
}
const EXISTING = new Set(DEFINITION.nodes.map(node => node.node_id))
const input = (over: Partial<SessionNodeInput>): SessionNodeInput => ({
  reviewSection: true, exportAtLeast140: true, rawReviewers: null, planReviewerIds: [], receipts: {}, reviewNodeStatus: 'succeeded',
  panelStatus: null, laneReviews: [], existingNodeIds: EXISTING, ...over,
})
const pairs = (nodes: ReturnType<typeof projectSessionNodes>) => nodes.map(node => `${node.node_id}:${node.status}`)

test('projectSessionNodes: reviewer, panel and lane-review nodes and their dependencies; a collision is refused', () => {
  const nodes = projectSessionNodes(DEFINITION, input({
    rawReviewers: [{ reviewer_id: 'general', status: 'blocked' }, { reviewer_id: 'coverage', status: 'accepted' }, { reviewer_id: 'critique', status: 'pending' }],
    panelStatus: 'succeeded', laneReviews: [{ lane: 'server', round: 1, status: 'reviewed' }, { lane: 'nolane', round: 1, status: 'reviewed' }],
  }))
  assert.deepEqual(pairs(nodes), ['reviewer-general:succeeded', 'reviewer-coverage:succeeded', 'reviewer-critique:pending', 'panel:succeeded', 'lane-review-server-1:succeeded'])
  for (const node of nodes.filter(node => node.projected !== 'lane_review')) assert.deepEqual(node.depends_on, ['candidate'])
  assert.deepEqual(nodes.find(node => node.node_id === 'lane-review-server-1')!.depends_on, ['verify_server'])
  assert.ok(nodes.every(node => node.kind === 'review' && isProjectedSessionNode(node.node_id)))
  const collide = projectSessionNodes(DEFINITION, input({ rawReviewers: [{ reviewer_id: 'general', status: 'accepted' }, { reviewer_id: 'coverage', status: 'accepted' }], panelStatus: 'running', existingNodeIds: new Set([...EXISTING, reviewerNodeId('general'), 'panel']) }))
  assert.deepEqual(pairs(collide), ['reviewer-coverage:succeeded'])
})

test('projectSessionNodes: an id whose projected node id would pass 128 characters gets no node', () => {
  const long = 'r'.repeat(128)
  const nodes = projectSessionNodes(DEFINITION, input({ reviewSection: false, planReviewerIds: [long, 'general'], reviewNodeStatus: 'running' }))
  assert.deepEqual(pairs(nodes), ['reviewer-general:pending'])
  const raw = projectSessionNodes(DEFINITION, input({ rawReviewers: [{ reviewer_id: long, status: 'accepted' }], laneReviews: [{ lane: 'server', round: 1, status: 'reviewed' }] }))
  assert.deepEqual(pairs(raw), ['lane-review-server-1:succeeded'])
  assert.ok(nodes.every(node => node.node_id.length <= 128))
})

test('projectSessionNodes: no reviewer node when the review section lists none, whatever the review status or the plan', () => {
  for (const reviewNodeStatus of ['succeeded', 'failed', 'running', 'awaiting_approval'] as const) {
    assert.deepEqual(projectSessionNodes(DEFINITION, input({ reviewSection: true, rawReviewers: null, planReviewerIds: ['general'], reviewNodeStatus })), [], reviewNodeStatus)
  }
  // A 1.4.0+ single-reviewer section lists `{reviewer_id: 'review'}`: one `reviewer-review` node ([L4]).
  assert.deepEqual(pairs(projectSessionNodes(DEFINITION, input({ rawReviewers: [{ reviewer_id: 'review', status: 'accepted' }] }))), ['reviewer-review:succeeded'])
})

test('projectSessionNodes: while the section is null, the plan\'s reviewers with receipt statuses; round 2 running has no round-1 verdict', () => {
  // Round 1 running: general launched, coverage launching, critique not started.
  const round1 = projectSessionNodes(DEFINITION, input({
    reviewSection: false, reviewNodeStatus: 'running', planReviewerIds: ['general', 'coverage', 'critique'],
    receipts: { general: { status: 'running', error: false }, coverage: { status: 'launching', error: false } },
  }))
  assert.deepEqual(pairs(round1), ['reviewer-general:running', 'reviewer-coverage:running', 'reviewer-critique:pending'])
  // Round 2 running after round 1 was archived: the receipts are the live round's, so a decided round-1 verdict never shows.
  const round2 = projectSessionNodes(DEFINITION, input({ reviewSection: false, reviewNodeStatus: 'running', planReviewerIds: ['general'], receipts: { general: { status: 'pending', error: false } } }))
  assert.deepEqual(pairs(round2), ['reviewer-general:pending'])
  // A 1.4.0+ plan without reviewers launches the single `review`; an older export draws none; a pending review draws none.
  assert.deepEqual(pairs(projectSessionNodes(DEFINITION, input({ reviewSection: false, reviewNodeStatus: 'running' }))), ['reviewer-review:pending'])
  assert.deepEqual(projectSessionNodes(DEFINITION, input({ reviewSection: false, reviewNodeStatus: 'running', exportAtLeast140: false })), [])
  assert.deepEqual(projectSessionNodes(DEFINITION, input({ reviewSection: false, reviewNodeStatus: 'pending', planReviewerIds: ['general'] })), [])
})

test('reviewerStateOf: every word the controller writes maps to a status and a state word', () => {
  const cases: [string | null, boolean, string, string][] = [
    [null, false, 'pending', 'not started'], ['pending', false, 'pending', 'not started'],
    ['launching', false, 'running', 'running'], ['running', false, 'running', 'running'],
    ['accepted', false, 'succeeded', 'decided'], ['succeeded', false, 'succeeded', 'decided'], ['blocked', false, 'succeeded', 'decided'],
    ['blocked', true, 'succeeded', 'failed'], ['needs_reconciliation', true, 'succeeded', 'failed'], ['superseded', false, 'succeeded', 'failed'],
    ['failed', false, 'succeeded', 'failed'],
  ]
  for (const [word, error, status, state] of cases) assert.deepEqual(reviewerStateOf(word, error), { status, word: state }, `${word} ${error}`)
  assert.equal(panelNodeStatus({ panels: [] }), 'pending')
  // PRD 3.2: the panel is report-only, so a failed or timed-out panel record is a decided (`succeeded`) node, never `failed`.
  const panelsOf = (...statuses: PanelResults['panels'][number]['status'][]) => ({ panels: statuses.map(status => ({ status })) }) as Pick<PanelResults, 'panels'>
  assert.equal(panelNodeStatus(panelsOf('failed')), 'succeeded')
  assert.equal(panelNodeStatus(panelsOf('timed_out')), 'succeeded')
  assert.equal(panelNodeStatus(panelsOf('succeeded', 'timed_out')), 'succeeded')
  assert.equal(panelNodeStatus(panelsOf('running', 'failed')), 'running')
  assert.equal(panelNodeStatus(panelsOf('succeeded')), 'succeeded')
  assert.equal(panelNodeStatus(panelsOf('pending', 'pending')), 'pending')
})

test('the panel node exists exactly when the panels route answers: a valid live panel.json beside an invalid export section', async () => {
  await withEnv(async ({ root, runsRoot, store }) => {
    const runDir = join(runsRoot(), 'live-panel')
    await mkdir(runDir, { recursive: true })
    await writeRunState(runDir, 'live-panel', { panels: { version: '1.0.0', panels: [{ id: 'broken', status: 'exploded' }] } })
    const scope = store.scope('sessions', 'main')
    assert.equal((await store.loadRun(scope, 'live-panel')).detail.definition.nodes.some(node => node.node_id === 'panel'), false, 'invalid export, no live file: no node')
    await writeJson(join(runDir, 'panel.json'), PANEL_RECORD)
    const config = await parseProjectsConfig(JSON.stringify({ version: 1, projects: [{ project_id: 'sessions', name: 'Sessions', repository: join(root, 'repo'), workflows: [{ workflow_id: 'main', runs_root: runsRoot(), definition: { name: 'Sessions flow', nodes: NODES } }] }] }), 'test registry')
    const app = createApp([], { projects: config })
    try {
      assert.equal((await app.inject({ method: 'GET', url: '/api/projects/sessions/workflows/main/runs/live-panel/panels' })).statusCode, 200)
    } finally { await app.close() }
    const detail = (await store.loadRun(scope, 'live-panel')).detail
    assert.equal(detail.snapshot.nodes.find(node => node.node_id === 'panel')?.status, 'succeeded')
    // A pre-1.9.0 export answers PANELS_NOT_FOUND even beside a valid live file: no node.
    const old = join(runsRoot(), 'old-panel')
    await mkdir(old, { recursive: true })
    await writeRunState(old, 'old-panel', { version: '1.8.0' })
    await writeJson(join(old, 'panel.json'), PANEL_RECORD)
    await assert.rejects(store.panelResults(scope, 'old-panel'), /No panel is recorded/)
    assert.equal((await store.loadRun(scope, 'old-panel')).detail.definition.nodes.some(node => node.node_id === 'panel'), false)
  })
})

test('a running round: reviewer rows from the live receipts while the section is null, and triage never focuses a projected node', async () => {
  await withEnv(async ({ runsRoot, store, sessions }) => {
    const runDir = join(runsRoot(), 'running')
    await mkdir(join(runDir, 'review-worktree'), { recursive: true })
    await writeJson(join(runDir, 'automatic-review-general.json'), { reviewer_id: 'general', status: 'running', session_id: ID.general, transport: 'native' })
    await writeJson(join(runDir, 'review-general.interactive.json'), { session_id: ID.general, worktree: join(runDir, 'review-worktree'), launch_requested_at: T0 })
    await writeJson(join(runDir, 'automatic-review-coverage.json'), { reviewer_id: 'coverage', status: 'blocked', error: 'Reviewer deadline exhausted; no second reviewer is launched' })
    await writeRunState(runDir, 'running', {
      review: null, plan: ['general', 'coverage', 'critique'],
      events: [{ sequence: 1, time: T0, node: 'review', status: 'running', message: 'Launching or reconciling the exact native session' }],
    })
    const run = await store.loadRun(store.scope('sessions', 'main'), 'running')
    const status = (id: string) => run.detail.snapshot.nodes.find(node => node.node_id === id)?.status
    assert.equal(status('review'), 'running')
    assert.deepEqual([status('reviewer-general'), status('reviewer-coverage'), status('reviewer-critique')], ['running', 'succeeded', 'pending'])
    const payload = await sessions('running')
    const general = payload.sessions.find(row => row.key === 'reviewer:general:1')!
    assert.deepEqual([general.status, general.verdict, general.session_id, general.resume!.command], ['running', 'running', ID.general, `cd ~/'runs/sessions/main/running/review-worktree' && claude --resume ${ID.general}`])
    assert.deepEqual([payload.sessions.find(row => row.key === 'reviewer:coverage:1')!.verdict, payload.sessions.find(row => row.key === 'reviewer:critique:1')!.verdict], ['failed', 'not started'])
    // Triage keeps them advisory: the focus and the Now banner name the review, never a reviewer card.
    const now = deriveNow({ detail: run.detail, events: run.events })
    assert.equal(now.focus?.node_id, 'review')
    assert.equal(isProjectedSessionNode(run.detail.summary.activity?.focus?.node_id ?? null), false)
  })
})

test('triage focuses a failed pinned step that only shares a projected id; a failed projected card stays advisory', async () => {
  await withEnv(async ({ runsRoot, store }) => {
    const runDir = join(runsRoot(), 'pinned-panel')
    await mkdir(runDir, { recursive: true })
    await writeRunState(runDir, 'pinned-panel', {
      review: null, plan: ['general'],
      events: [{ sequence: 1, time: T0, node: 'review', status: 'running', message: 'Launching or reconciling the exact native session' }],
    })
    const { detail, events } = await store.loadRun(store.scope('sessions', 'main'), 'pinned-panel')
    assert.ok(detail.definition.nodes.some(node => node.node_id === 'panel' && node.kind === 'review'), 'the projected panel node is joined')
    // `panel` failed: as the projected card (kind review, a dependency of the review gate), or as a pinned step of that id
    // (the projection refuses to join its own panel beside it), here a worker the review does not depend on.
    const failedPanel = (pinned: boolean): RunDetail => {
      const edit = <T extends { node_id: string; kind: string; depends_on: string[] }>(node: T): T =>
        node.node_id === 'review' && pinned ? { ...node, depends_on: node.depends_on.filter(id => id !== 'panel') }
          : node.node_id === 'panel' && pinned ? { ...node, kind: 'worker', depends_on: ['challenge'] } : node
      return {
        ...detail,
        definition: { ...detail.definition, nodes: detail.definition.nodes.map(edit) },
        snapshot: { ...detail.snapshot, nodes: detail.snapshot.nodes.map(node => edit(node.node_id === 'panel' ? { ...node, status: 'failed' as const } : node)) },
      }
    }
    assert.equal(deriveFocus(failedPanel(false), events)?.node_id, 'review', 'a projected card is never the focus')
    assert.equal(deriveFocus(failedPanel(true), events)?.node_id, 'panel', 'a pinned step named panel is')
  })
})

// ---- The resume command (PRD 3.5) ---------------------------------------------------------------------------------

test('resume: the ~/ form for an exposed project whose directory exists under HOME; bare otherwise, and for a quote', async () => {
  const home = await mkdtemp(join(tmpdir(), 'md-manager-sessions-home-'))
  try {
    const id = ID.server
    for (const dir of ['wt', "it's", 'tab\there']) await mkdir(join(home, dir), { recursive: true })
    assert.deepEqual(await composeResume(id, join(home, 'wt'), { exposed: true, home }), { dir: "~/'wt'", command: `cd ~/'wt' && claude --resume ${id}` })
    assert.deepEqual(await composeResume(id, join(home, 'wt'), { exposed: false, home }), { dir: null, command: `claude --resume ${id}` }, 'unexposed project')
    assert.deepEqual(await composeResume(id, join(home, "it's"), { exposed: true, home }), { dir: null, command: `claude --resume ${id}` }, 'a quote in the directory')
    assert.deepEqual(await composeResume(id, join(home, 'tab\there'), { exposed: true, home }), { dir: null, command: `claude --resume ${id}` }, 'a control character')
    assert.deepEqual(await composeResume(id, join(home, 'gone'), { exposed: true, home }), { dir: null, command: `claude --resume ${id}` }, 'the directory no longer exists')
    assert.deepEqual(await composeResume(id, tmpdir(), { exposed: true, home }), { dir: null, command: `claude --resume ${id}` }, 'not under HOME')
    assert.deepEqual(await composeResume(id, null, { exposed: true, home }), { dir: null, command: `claude --resume ${id}` }, 'not recorded')
    assert.equal(await composeResume('not a session id!', null, { exposed: true, home }), null)
    // The command is exempt from redaction: a credential-shaped id that the ID pattern accepts never enters it.
    const credential = `sk-${'A1b2C3d4e5'.repeat(4)}`
    assert.equal(await composeResume(credential, join(home, 'wt'), { exposed: true, home }), null, 'a credential-shaped session id')
    await mkdir(join(home, credential), { recursive: true })
    assert.deepEqual(await composeResume(id, join(home, credential), { exposed: true, home }), { dir: null, command: `claude --resume ${id}` }, 'a credential-shaped directory')
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('resume: the quoted ~/ form keeps spaces, non-ASCII and $; a quote, a bidi override or a C1 control gives the bare form ([L12] 2)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'md-manager-sessions-home-'))
  try {
    const id = ID.server
    const bare = { dir: null, command: `claude --resume ${id}` }
    const quoted = ['dev/my project/wt', 'dev/café-wt', 'dev/$HOME-wt']
    const refused = ["dev/it's", 'dev/a\u202eb', 'dev/a\u0085b', 'dev/a\u200bb', 'dev/a\u2028b']
    for (const dir of [...quoted, ...refused]) await mkdir(join(home, dir), { recursive: true })
    for (const dir of quoted) {
      assert.deepEqual(await composeResume(id, join(home, dir), { exposed: true, home }), { dir: `~/'${dir}'`, command: `cd ~/'${dir}' && claude --resume ${id}` }, dir)
    }
    assert.equal((await composeResume(id, join(home, 'dev/my project/wt'), { exposed: true, home }))!.command, `cd ~/'dev/my project/wt' && claude --resume ${id}`)
    for (const dir of refused) assert.deepEqual(await composeResume(id, join(home, dir), { exposed: true, home }), bare, JSON.stringify(dir))
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('a stray review.round-99999999.json neither hangs the sessions request nor labels the running round ([L12] 3)', async () => {
  await withEnv(async ({ runsRoot, sessions }) => {
    const runDir = join(runsRoot(), 'stray')
    await mkdir(runDir, { recursive: true })
    await writeJson(join(runDir, 'automatic-review-general.json'), { reviewer_id: 'general', status: 'running', session_id: ID.general, transport: 'native' })
    await writeJson(join(runDir, 'review.round-1.json'), { round: 1, reviewers: [{ reviewer_id: 'general', verdict: 'blocked', status: 'accepted', session_id: ID.general1, transport: 'native', findings: [] }], findings: [] })
    await writeJson(join(runDir, 'review.round-99999999.json'), { round: 99999999, reviewers: [{ reviewer_id: 'general', verdict: 'approved', status: 'accepted', transport: 'native', findings: [] }], findings: [] })
    await writeRunState(runDir, 'stray', {
      review: null, plan: ['general'],
      events: [{ sequence: 1, time: T0, node: 'review', status: 'running', message: 'Launching or reconciling the exact native session' }],
    })
    const started = Date.now()
    const payload = await sessions('stray')
    assert.ok(Date.now() - started < 5000, 'answered promptly')
    const reviewers = payload.sessions.filter(row => row.role === 'reviewer').map(row => [row.key, row.round, row.verdict])
    assert.deepEqual(reviewers.sort(), [['reviewer:general:1', 1, 'blocked'], ['reviewer:general:2', 2, 'running']])
  })
})

test('archived rounds are read from the files that exist: round 1 and 3 archived, round 2 restored, round 4 running ([L12] 3)', async () => {
  await withEnv(async ({ runsRoot, sessions }) => {
    const runDir = join(runsRoot(), 'gap')
    await mkdir(runDir, { recursive: true })
    await writeJson(join(runDir, 'automatic-review-general.json'), { reviewer_id: 'general', status: 'running', session_id: ID.general, transport: 'native' })
    for (const [k, verdict, session] of [[1, 'blocked', ID.general1], [3, 'approved', ID.coverage]] as const) {
      await writeJson(join(runDir, `review.round-${k}.json`), { round: k, reviewers: [{ reviewer_id: 'general', verdict, status: 'accepted', session_id: session, transport: 'native', findings: [] }], findings: [] })
    }
    // A stray file the fix loop never recorded is still not a round.
    await writeJson(join(runDir, 'review.round-99999999.json'), { round: 99999999, reviewers: [{ reviewer_id: 'general', verdict: 'approved', status: 'accepted', transport: 'native', findings: [] }], findings: [] })
    // The controller numbers a round after every round in review-rounds.json; round 2 was restored (its file went back to review.json, then was archived as round 3).
    const reviewRound = (round: number, restored: boolean) => ({
      round, verdict: 'blocked', candidate: SHA40, lane: 'server', findings: [], reviewer_sessions: [], started_at: T0,
      archived: !restored, restored_at: restored ? T1 : null, repair_n: null, reviewers: [],
    })
    await writeRunState(runDir, 'gap', {
      review: null, plan: ['general'],
      fixLoop: { version: '1.0.0', rounds: 3, repairs: [], review_rounds: [reviewRound(1, false), reviewRound(2, true), reviewRound(3, false)] },
      events: [{ sequence: 1, time: T0, node: 'review', status: 'running', message: 'Launching or reconciling the exact native session' }],
    })
    const payload = await sessions('gap')
    const reviewers = payload.sessions.filter(row => row.role === 'reviewer').map(row => [row.key, row.round, row.verdict, row.session_id])
    assert.deepEqual(reviewers.sort(), [
      ['reviewer:general:1', 1, 'blocked', ID.general1], ['reviewer:general:3', 3, 'approved', ID.coverage], ['reviewer:general:4', 4, 'running', ID.general],
    ])
  })
})

test('resume through the route: a reviewer resumes from its receipt worktree on an exposed project, bare on an unexposed one', async () => {
  for (const exposed of [true, false]) {
    await withEnv(async ({ runsRoot, sessions }) => {
      await seedFull(runsRoot(), 'resumed')
      const payload = await sessions('resumed')
      const general = payload.sessions.find(row => row.key === 'reviewer:general:2')!
      assert.equal(general.resume!.command, exposed ? `cd ~/'runs/sessions/main/resumed/review-worktree' && claude --resume ${ID.general}` : `claude --resume ${ID.general}`)
      // pi and panel providers never offer one; Claude Code sessions always do.
      assert.ok(payload.sessions.filter(row => row.transport === 'pi' || row.role === 'panel_provider' || row.role === 'night_shift').every(row => row.resume === null))
      assert.ok(payload.sessions.filter(row => ['challenge', 'worker', 'repair', 'reviewer', 'critique', 'sidecar', 'attack'].includes(row.role)).every(row => row.resume !== null))
      const json = JSON.stringify(payload)
      assert.doesNotMatch(json, /"\/(?:home|tmp)\//)
    }, { exposed })
  }
})

test('an export whose review section lists no reviewers keeps its rows on the review node and projects no reviewer node', async () => {
  await withEnv(async ({ runsRoot, store, sessions }) => {
    const runDir = join(runsRoot(), 'legacy')
    await mkdir(runDir, { recursive: true })
    const { reviewers: _drop, round: _round, delta_from: _from, delta_diff: _diff, ...section } = defaultReview()
    void _drop; void _round; void _from; void _diff
    await writeRunState(runDir, 'legacy', { version: '1.3.0', review: { ...section, attempt: 1, reviewer_session_id: ID.general, findings: section.findings.map(({ reviewer: _r, ...finding }) => { void _r; return finding }) }, plan: null })
    const detail = (await store.loadRun(store.scope('sessions', 'main'), 'legacy')).detail
    assert.equal(detail.definition.nodes.some(node => isProjectedSessionNode(node.node_id)), false)
    const rows = (await sessions('legacy')).sessions.filter(row => row.role === 'reviewer')
    assert.deepEqual(rows.map(row => [row.key, row.node_id]), [['reviewer:review:1', 'review']])
  })
})
