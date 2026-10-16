/**
 * The dispatch feature's fixtures (docs/PRD_PROJECTS_DISPATCH.md, [P16]): new registry projects with their own repositories,
 * the git and GitHub states behind the Projects page, the rail and the project page, and the step chart data. The worker phase
 * registers these projects and their runs into the shared maps and serves the dispatch overview and steps from `mock.ts`; the
 * candidate phase (`seed`) creates real git repositories under the test root and registers the same projects for the real server.
 *
 * Projects, in registry order (the clone's primary is the first registry project with a clone id): the existing alpha and empty
 * projects keep their place; then `dispatch-local` (a non-GitHub remote with a run awaiting approval), `dispatch-widgets` (the
 * primary clone of acme/widgets, 2 ahead and 1 behind, with an integrated run and a run that failed verification three times),
 * `dispatch-widgets-wt` (a worktree that shares the clone), `dispatch-trio` (three features whose worst latest result is failed),
 * `dispatch-noorigin` (no origin ref), and `dispatch-unreadable` (its run state cannot be read).
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Project, RunDetail, RunSummary, WorkflowDefinition } from '../../../contracts/projects/v1.ts'
import type { RunPr } from '../../../contracts/projects/github.ts'
import { done, runDetail, type NodeState } from '../fixtures.ts'
import type { DispatchOverview, GithubRepoRead, GithubState, ProjectDispatch, ProjectSteps, ProjectStepsRun } from '../../../src/projects/dispatch/types.ts'

const REVISION = 'a'.repeat(64)
const READ_AT = '2026-10-11T03:38:00Z'
const VIEWER_LOGIN = 'mani99brar'
// Shas are opaque 40-char hex ids; the contract enforces /^[0-9a-f]{7,40}$/, so the seed cannot appear
// verbatim (it may contain non-hex letters). Map each seed char to a hex nibble for a stable, distinct id.
const sha = (seed: string) => {
  let hex = ''
  for (let i = 0; i < seed.length; i++) hex += (seed.charCodeAt(i) & 0xf).toString(16)
  return (hex + '0'.repeat(40)).slice(0, 40)
}

export const DISPATCH_LOCAL = 'dispatch-local'
export const DISPATCH_WIDGETS = 'dispatch-widgets'
export const DISPATCH_WIDGETS_WT = 'dispatch-widgets-wt'
export const DISPATCH_TRIO = 'dispatch-trio'
export const DISPATCH_NOORIGIN = 'dispatch-noorigin'
export const DISPATCH_UNREADABLE = 'dispatch-unreadable'
/** A project of its own for the waiting and running runs, 52 commits ahead, so the Widgets primary keeps its "2 unpushed"
 * badge and rail place ([P24]) and "and 2 more" has a seed ([P33]); its clone has no origin reflog, so its time is missing ([L9]). */
export const DISPATCH_BUSY = 'dispatch-busy'
/** The Trio workflow whose runs cannot be listed ([P34]): a workflow-level `error`, the literal `<run-id>` placeholder row (V18). */
export const DISPATCH_TRIO_LOCKED = 'trio-locked'
/** Workflows whose runs the worker-phase mock answers with a listing error, mirroring the candidate's unlistable `runs_root`. */
/** The unreadable project's sole workflow, whose runs also cannot be listed ([L1]), so the project reads "cannot be read". */
export const DISPATCH_UNREADABLE_WORKFLOW = 'x'
/**
 * The project whose runs record Claude costs: five integrated runs of `ledger` (two priced, one
 * recorded 0, one with a null total, one with no `costs` section) and a `ledger-broken` workflow whose only run cannot be read.
 */
export const DISPATCH_SPEND = 'dispatch-spend'
export const SPEND_WORKFLOW = 'ledger'
export const SPEND_BROKEN_WORKFLOW = 'ledger-broken'
export const DISPATCH_UNLISTABLE_WORKFLOWS = new Set<string>([DISPATCH_TRIO_LOCKED, DISPATCH_UNREADABLE_WORKFLOW, SPEND_BROKEN_WORKFLOW])
/** Each seeded run's export `costs.total_usd`, keyed `<project>/<workflow>/<run>`: a number, null (a section with a null total) or absent (no section). */
export const SPEND_RUN_COSTS: Record<string, number | null> = {
  'ledger-001': 1.234567, 'ledger-002': 2.5, 'ledger-003': 0, 'ledger-004': null,
}
export const SPEND_RUNS = ['ledger-001', 'ledger-002', 'ledger-003', 'ledger-004', 'ledger-005'] as const
/**
 * Reuse evidence (GH7): Spend's `reuse` workflow holds a one-lane run whose candidate packet reuses its worker packet of attempt
 * 1 (`reused_from`, as workflow/checks.py reuse_packet writes it) and a twin whose candidate checks ran again. Neither records costs.
 */
export const REUSE_WORKFLOW = 'reuse'
export const RUN_REUSED = 'reuse-001'
export const RUN_NOT_REUSED = 'reuse-002'
export const REUSE_GATE_MESSAGE = 'Combined revision {commit}; worker checks reused from verification/worker/ui/1/packet.json (one lane, no browser check, the candidate is its snapshot)'
export const DISPATCH_RUN_COSTS: Record<string, number | null> = Object.fromEntries(Object.entries(SPEND_RUN_COSTS).map(([runId, cost]) => [`${DISPATCH_SPEND}/${SPEND_WORKFLOW}/${runId}`, cost]))

export const DISPATCH_PROJECTS: Project[] = [
  { project_id: DISPATCH_LOCAL, name: 'Local only' },
  { project_id: DISPATCH_WIDGETS, name: 'Widgets' },
  { project_id: DISPATCH_WIDGETS_WT, name: 'Widgets worktree' },
  { project_id: DISPATCH_TRIO, name: 'Trio' },
  { project_id: DISPATCH_NOORIGIN, name: 'No origin' },
  { project_id: DISPATCH_BUSY, name: 'Busy' },
  { project_id: DISPATCH_UNREADABLE, name: 'Unreadable' },
  { project_id: DISPATCH_SPEND, name: 'Spend' },
]

const PIPELINE: { node_id: string; label: string; kind: WorkflowDefinition['nodes'][number]['kind'] }[] = [
  { node_id: 'challenge', label: 'Design challenge', kind: 'review' },
  { node_id: 'launch_ui', label: 'Launch ui worker', kind: 'worker' },
  { node_id: 'handoff', label: 'Freeze worker handoffs', kind: 'prepare' },
  { node_id: 'verify_ui', label: 'Verify ui', kind: 'verification' },
  { node_id: 'candidate', label: 'Verify combined candidate', kind: 'verification' },
  { node_id: 'review', label: 'Independent review', kind: 'review' },
  { node_id: 'approval', label: 'Integration approval', kind: 'integration' },
  { node_id: 'integrate', label: 'Integrate candidate', kind: 'integration' },
]

function def(projectId: string, workflowId: string): WorkflowDefinition {
  return {
    contract_version: '1.0.0', project_id: projectId, workflow_id: workflowId, name: 'Feature implementation',
    definition_revision: REVISION, nodes: PIPELINE.map(node => ({ ...node, depends_on: [] })),
  }
}

type Stop = { node_id: string; attempt?: number; status?: string }

/** A run summary (contract 1.5.0) stopped at `stop`: steps before it succeed, the stop step takes its status, the rest pend. */
function summary(projectId: string, workflowId: string, runId: string, options: {
  status: RunSummary['status']; stop: string; feature: string
  attentionKind?: 'approval' | 'question'; finished?: boolean; accepted?: boolean
}): RunSummary {
  const idx = PIPELINE.findIndex(n => n.node_id === options.stop)
  const stopNode = PIPELINE[idx]
  const finished = options.finished ?? ['succeeded', 'failed', 'cancelled'].includes(options.status)
  const attention = options.attentionKind
    ? { kind: options.attentionKind, node_id: stopNode.node_id, since: '2026-10-10T09:00:00Z' } as const
    : null
  // Dispatch runs are dated well in the past so they never land in another spec's Today/Recent window (those specs pin an
  // earlier clock and read the shared registry); the dispatch pages do not sort or filter runs by recency.
  const CREATED = '2025-01-01T08:00:00Z'
  const MOVED = '2025-01-01T09:00:00Z'
  return {
    contract_version: '1.5.0', project_id: projectId, workflow_id: workflowId, definition_revision: REVISION, run_id: runId,
    status: options.status, created_at: CREATED, updated_at: MOVED,
    activity: {
      feature: options.feature,
      last_activity_at: MOVED,
      finished_at: finished ? MOVED : null,
      focus: options.status === 'succeeded' ? null : { node_id: stopNode.node_id, label: stopNode.label, status: options.status === 'failed' ? 'failed' : 'awaiting_approval', since: MOVED },
      attention,
      waiting_questions: 0,
      headline: `${stopNode.label} · ${options.status === 'succeeded' ? 'integrated' : options.status}`,
      controller: null,
    },
    ...(options.accepted ? { accepted: { candidate: sha('acc'), reason: 'merged by hand', by: 'operator', accepted_at: MOVED, on_main: true, review: 'recorded', open_findings: [], abandoned: null } } : {}),
  }
}

/** A dispatch steps run: steps up to `stop` succeed, the stop step takes `stopStatus`/attempt, the rest pend. */
function stepsRun(runId: string, stop: Stop, options: { integrated?: string | null; source?: string | null } = {}): ProjectStepsRun {
  const idx = PIPELINE.findIndex(n => n.node_id === stop.node_id)
  return {
    run_id: runId, source_branch: options.source ?? `feature/${runId}`, base_commit: sha('base'),
    integrated_commit: options.integrated ?? null, lanes: ['ui'],
    steps: PIPELINE.map((node, i) => ({
      node_id: node.node_id, label: node.label, kind: node.kind,
      status: i < idx ? 'succeeded' : i === idx ? (stop.status ?? 'succeeded') : 'pending',
      attempt: i === idx ? (stop.attempt ?? 1) : i < idx ? 1 : 0,
    })),
  }
}

/**
 * ui-polish-002 (failed at verification) with a second Launch lane, a parallel worker, so its Launch phase cell holds two
 * lanes and carries `.multi` — the only multi-lane cell in these fixtures, for the 440px collapse check (PRD 4.3, "a
 * multi-lane phase collapses to one mark"). Worker phase only: the candidate seed writes single-lane runs, so the scenario
 * asserts the collapse in the worker phase, as [P35] gates the failed-refresh line. The stop stays verify_ui in the Verify
 * phase, so the stop glyph and the axis-centre check are untouched.
 */
function uiPolish002WithParallelLaunch(): ProjectStepsRun {
  const run = stepsRun('ui-polish-002', { node_id: 'verify_ui', attempt: 3, status: 'failed' })
  const launchIdx = run.steps.findIndex(step => step.node_id === 'launch_ui')
  run.steps.splice(launchIdx + 1, 0, { node_id: 'launch_api', label: 'Launch api worker', kind: 'worker', status: 'succeeded', attempt: 1 })
  run.lanes = ['ui', 'api']
  return run
}

// ---- The runs behind each project ------------------------------------------------------------------------------------

const widgetsRuns = {
  'ui-polish-001': summary(DISPATCH_WIDGETS, 'ui-polish', 'ui-polish-001', { status: 'succeeded', stop: 'integrate', feature: 'UI polish' }),
  'ui-polish-002': summary(DISPATCH_WIDGETS, 'ui-polish', 'ui-polish-002', { status: 'failed', stop: 'verify_ui', feature: 'UI polish' }),
  // A second integrated run, so Widgets has exactly two integrated runs: one that landed on local main and origin, one on
  // local main only ([P25], V16). Its landing is seeded on_default true / on_origin false in the overview.
  'ui-polish-003': summary(DISPATCH_WIDGETS, 'ui-polish', 'ui-polish-003', { status: 'succeeded', stop: 'integrate', feature: 'UI polish' }),
}
const localRuns = {
  'sync-001': summary(DISPATCH_LOCAL, 'sync', 'sync-001', { status: 'awaiting_approval', stop: 'approval', feature: 'Sync', attentionKind: 'approval', finished: false }),
}
const busyRuns = {
  'ship-001': summary(DISPATCH_BUSY, 'ship', 'ship-001', { status: 'awaiting_approval', stop: 'approval', feature: 'Ship', attentionKind: 'approval', finished: false }),
  'ship-002': summary(DISPATCH_BUSY, 'ship', 'ship-002', { status: 'running', stop: 'launch_ui', feature: 'Ship', finished: false }),
}
const wtRuns = {
  'experiment-001': summary(DISPATCH_WIDGETS_WT, 'experiment', 'experiment-001', { status: 'succeeded', stop: 'integrate', feature: 'Experiment' }),
}
const trioRuns = {
  'alpha-feature-001': summary(DISPATCH_TRIO, 'alpha-feature', 'alpha-feature-001', { status: 'succeeded', stop: 'integrate', feature: 'Alpha' }),
  'beta-feature-001': summary(DISPATCH_TRIO, 'beta-feature', 'beta-feature-001', { status: 'cancelled', stop: 'review', feature: 'Beta' }),
  'gamma-feature-001': summary(DISPATCH_TRIO, 'gamma-feature', 'gamma-feature-001', { status: 'failed', stop: 'verify_ui', feature: 'Gamma' }),
}
const reuseRuns = Object.fromEntries([RUN_REUSED, RUN_NOT_REUSED].map(runId => [runId, summary(DISPATCH_SPEND, REUSE_WORKFLOW, runId, { status: 'succeeded', stop: 'integrate', feature: 'Reuse' })]))
const spendRuns = Object.fromEntries(SPEND_RUNS.map(runId => [runId, summary(DISPATCH_SPEND, SPEND_WORKFLOW, runId, { status: 'succeeded', stop: 'integrate', feature: 'Ledger' })]))
const nooriginRuns = {
  'main-001': summary(DISPATCH_NOORIGIN, 'main', 'main-001', { status: 'succeeded', stop: 'integrate', feature: 'Main' }),
}

// ---- The runs that need the operator, and the ones that do not ---------------------------------------------
// No Origin carries the Needs-you cases, each in its own workflow so that what is latest is decided per workflow: a run paused
// at the design challenge, an interrupted paused run and an interrupted running run (each the latest of its workflow); a
// challenge-paused run superseded by a later failed run of its workflow (whose feature text differs, and which ran 50 h); an
// interrupted running run superseded the same way (it stays in Running); and a run paused at another step (Paused). The
// decision run's only later run is in another workflow (`redo-002`), so it stays latest. Widgets worktree carries a live paused
// run while its newest run, in another workflow, was cancelled. Every date is in 2024 or January 2025, so none of these runs is
// ever in Today or Recent under the pinned clocks of the other specs.

/** The challenge-paused run whose only later run is in another workflow: it needs a decision. */
export const RUN_DECIDE = 'decide-001'
/** Paused at the challenge, then superseded by `redo-002` in its own workflow. */
export const RUN_REDO_OLD = 'redo-001'
/** The later run of `redo`: failed after 50 h, a different feature text. */
export const RUN_REDO_NEW = 'redo-002'
/** Interrupted while paused (a step paused, then the supervisor stopped): needs the operator. */
export const RUN_HALT = 'halt-001'
/** Interrupted while served running (a controller row nothing followed): needs the operator. */
export const RUN_HALT_LIVE = 'halt-live-001'
/** Interrupted while served running, but superseded by `rerun-live-002`: stays in Running. */
export const RUN_RERUN_OLD = 'rerun-live-001'
export const RUN_RERUN_NEW = 'rerun-live-002'
/** Paused at the review, not the challenge: a Paused row, needs nobody. */
export const RUN_PARKED = 'parked-001'
/** Widgets worktree's live paused run, and its newer cancelled run in another workflow. */
export const RUN_WT_PARKED = 'wt-parked-001'
export const RUN_WT_DROPPED = 'wt-dropped-001'
/** The No Origin runs that need the operator, and its paused and running counts, by value. */
export const NOORIGIN_NEEDS = [RUN_DECIDE, RUN_HALT, RUN_HALT_LIVE] as const
export const NOORIGIN_PAUSED = [RUN_PARKED] as const
export const NOORIGIN_RUNNING = [RUN_RERUN_OLD] as const
/** The paused at the review since this instant, for the stopped-row words. */
export const PARKED_SINCE = '2024-11-20T09:00:00Z'
export const REDO_NEW_CREATED = '2024-12-03T00:00:00Z'
export const REDO_NEW_FINISHED = '2024-12-05T02:00:00Z'

const CHALLENGE_PAUSED_MESSAGE = 'Design challenge attempt 1 paused the run before any worker launch: 1 P0/P1 concern(s)'
const SUPERVISOR_INTERRUPTED = 'Supervisor interrupted. Native workers were NOT stopped and keep running'

type M2Row = [time: string, node: string, status: string, message: string]
type M2Run = {
  projectId: string; workflowId: string; runId: string; status: RunSummary['status']; created: string; feature: string
  events: M2Row[]; next: string[]; tasks?: { node_id: string; error: string | null; interrupts: object[]; result: object | null }[]
  focus: string | null; attention: { kind: 'paused' | 'interrupted' | 'failed'; node_id: string | null; since: string | null } | null
  finished?: string
}
const label = (nodeId: string) => PIPELINE.find(node => node.node_id === nodeId)!.label
const challengePaused = (projectId: string, workflowId: string, runId: string, created: string, feature: string): M2Run => {
  const paused = new Date(Date.parse(created) + 4 * 60_000).toISOString().replace('.000Z', 'Z')
  return {
    projectId, workflowId, runId, status: 'paused', created, feature, next: [], focus: 'challenge',
    events: [[created, 'challenge', 'running', 'Design challenge attempt 1 launched'], [paused, 'challenge', 'paused', CHALLENGE_PAUSED_MESSAGE]],
    attention: { kind: 'paused', node_id: 'challenge', since: paused },
  }
}
const at = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString().replace('.000Z', 'Z')
const interruptedRunning = (projectId: string, workflowId: string, runId: string, created: string, feature: string): M2Run => ({
  projectId, workflowId, runId, status: 'running', created, feature, next: ['launch_ui'], focus: 'launch_ui',
  events: [[at(created, 5), 'challenge', 'succeeded', 'Design challenge accepted'], [at(created, 10), 'launch_ui', 'running', 'UI worker launched'],
    [at(created, 30), 'controller', 'interrupted', SUPERVISOR_INTERRUPTED]],
  attention: { kind: 'interrupted', node_id: 'launch_ui', since: at(created, 30) },
})
const failedRun = (projectId: string, workflowId: string, runId: string, created: string, failedAt: string, feature: string): M2Run => ({
  projectId, workflowId, runId, status: 'failed', created, feature, next: ['verify_ui'], focus: 'verify_ui', finished: failedAt,
  events: [[at(created, 5), 'challenge', 'succeeded', 'Design challenge accepted'], [failedAt, 'verify_ui', 'failed', 'Attempt 1; verification failed']],
  tasks: [{ node_id: 'verify_ui', error: 'Gate failed after 1 attempts', interrupts: [], result: null }],
  attention: { kind: 'failed', node_id: 'verify_ui', since: null },
})
const pausedAtReview = (projectId: string, workflowId: string, runId: string, created: string, feature: string): M2Run => ({
  projectId, workflowId, runId, status: 'paused', created, feature, next: [], focus: 'review',
  events: [[at(created, 5), 'challenge', 'succeeded', 'Design challenge accepted'], [at(created, 60), 'review', 'paused', 'Review held by the operator']],
  attention: { kind: 'paused', node_id: 'review', since: at(created, 60) },
})

export const M2_RUNS: readonly M2Run[] = [
  challengePaused(DISPATCH_NOORIGIN, 'decide', RUN_DECIDE, '2024-12-01T08:00:00Z', 'Decide'),
  challengePaused(DISPATCH_NOORIGIN, 'redo', RUN_REDO_OLD, '2024-12-02T08:00:00Z', 'Redo'),
  failedRun(DISPATCH_NOORIGIN, 'redo', RUN_REDO_NEW, REDO_NEW_CREATED, REDO_NEW_FINISHED, 'Redo, second take'),
  {
    projectId: DISPATCH_NOORIGIN, workflowId: 'halt', runId: RUN_HALT, status: 'paused', created: '2024-12-04T08:00:00Z', feature: 'Halt', next: [], focus: 'verify_ui',
    events: [['2024-12-04T08:05:00Z', 'challenge', 'succeeded', 'Design challenge accepted'], ['2024-12-04T09:00:00Z', 'verify_ui', 'paused', 'Attempt 1; verification paused'],
      ['2024-12-04T09:30:00Z', 'controller', 'interrupted', SUPERVISOR_INTERRUPTED]],
    attention: { kind: 'interrupted', node_id: 'verify_ui', since: '2024-12-04T09:30:00Z' },
  },
  interruptedRunning(DISPATCH_NOORIGIN, 'halt-live', RUN_HALT_LIVE, '2024-12-04T10:00:00Z', 'Halt live'),
  interruptedRunning(DISPATCH_NOORIGIN, 'rerun-live', RUN_RERUN_OLD, '2024-12-05T08:00:00Z', 'Rerun live'),
  failedRun(DISPATCH_NOORIGIN, 'rerun-live', RUN_RERUN_NEW, '2024-12-06T08:00:00Z', '2024-12-06T09:00:00Z', 'Rerun live'),
  pausedAtReview(DISPATCH_NOORIGIN, 'parked', RUN_PARKED, '2024-11-20T08:00:00Z', 'Parked'),
  pausedAtReview(DISPATCH_WIDGETS_WT, 'wt-parked', RUN_WT_PARKED, '2024-11-01T08:00:00Z', 'Parked worktree'),
  {
    projectId: DISPATCH_WIDGETS_WT, workflowId: 'wt-dropped', runId: RUN_WT_DROPPED, status: 'cancelled', created: '2025-02-01T08:00:00Z', feature: 'Dropped',
    // The server reads the cancelled run's end at its last step's row, not at the abandon row.
    next: [], focus: null, finished: '2025-02-01T08:05:00Z',
    events: [['2025-02-01T08:05:00Z', 'challenge', 'succeeded', 'Design challenge accepted'], ['2025-02-01T09:00:00Z', 'controller', 'cancelled', 'Abandoned by the operator']],
    attention: null,
  },
]
export const M2_WORKFLOWS: Record<string, readonly string[]> = {
  [DISPATCH_NOORIGIN]: ['decide', 'redo', 'halt', 'halt-live', 'rerun-live', 'parked'],
  [DISPATCH_WIDGETS_WT]: ['wt-parked', 'wt-dropped'],
}

/** A seeded run's summary as the server serves it (contract 1.5.0), for the worker-phase mocks. */
function m2Summary(run: M2Run): RunSummary {
  const last = run.events.at(-1)![0]
  // The focus step's since is its own last row (none for a failed step), as the server reads it.
  const focusRow = run.events.findLast(([, node]) => node === run.focus)
  const focus = run.focus === null ? null : {
    node_id: run.focus, label: label(run.focus), since: run.status === 'failed' ? null : focusRow?.[0] ?? null,
    status: (run.status === 'failed' ? 'failed' : run.status === 'running' ? 'running' : 'paused') as 'failed' | 'running' | 'paused',
  }
  return {
    contract_version: '1.5.0', project_id: run.projectId, workflow_id: run.workflowId, definition_revision: REVISION, run_id: run.runId,
    status: run.status, created_at: run.created, updated_at: last,
    activity: {
      feature: run.feature, last_activity_at: last, finished_at: run.finished ?? null, focus, attention: run.attention, waiting_questions: 0,
      headline: `${focus?.label ?? 'Run'} · ${run.events.at(-1)![3]}`, controller: null,
    },
  }
}
const m2Lists: Record<string, { runs: RunSummary[]; next_cursor: null }> = {}
for (const run of M2_RUNS) (m2Lists[run.workflowId] ??= { runs: [], next_cursor: null }).runs.push(m2Summary(run))
for (const list of Object.values(m2Lists)) list.runs.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.run_id.localeCompare(b.run_id))

/** Every new workflow's runs, keyed by workflow id, for the shared `runLists`. */
export const DISPATCH_RUN_LISTS: Record<string, { runs: RunSummary[]; next_cursor: null }> = {
  'ui-polish': { runs: [widgetsRuns['ui-polish-003'], widgetsRuns['ui-polish-002'], widgetsRuns['ui-polish-001']], next_cursor: null },
  sync: { runs: [localRuns['sync-001']], next_cursor: null },
  experiment: { runs: [wtRuns['experiment-001']], next_cursor: null },
  'alpha-feature': { runs: [trioRuns['alpha-feature-001']], next_cursor: null },
  'beta-feature': { runs: [trioRuns['beta-feature-001']], next_cursor: null },
  'gamma-feature': { runs: [trioRuns['gamma-feature-001']], next_cursor: null },
  main: { runs: [nooriginRuns['main-001']], next_cursor: null },
  ship: { runs: [busyRuns['ship-002'], busyRuns['ship-001']], next_cursor: null },
  [SPEND_WORKFLOW]: { runs: SPEND_RUNS.map(runId => spendRuns[runId]), next_cursor: null },
  [REUSE_WORKFLOW]: { runs: [reuseRuns[RUN_REUSED], reuseRuns[RUN_NOT_REUSED]], next_cursor: null },
  ...m2Lists,
}

/** Each new project's workflow definitions, keyed by project id, for the shared `workflowLists`. `dispatch-unreadable` is
 * deliberately absent: its workflow list 404s, so its run state cannot be read and it shows "cannot be read". */
export const DISPATCH_WORKFLOW_LISTS: Record<string, { workflows: WorkflowDefinition[] }> = {
  [DISPATCH_LOCAL]: { workflows: [def(DISPATCH_LOCAL, 'sync')] },
  [DISPATCH_WIDGETS]: { workflows: [def(DISPATCH_WIDGETS, 'ui-polish'), def(DISPATCH_WIDGETS, 'broken')] },
  [DISPATCH_WIDGETS_WT]: { workflows: [def(DISPATCH_WIDGETS_WT, 'experiment'), ...M2_WORKFLOWS[DISPATCH_WIDGETS_WT].map(id => def(DISPATCH_WIDGETS_WT, id))] },
  // Trio lists its three readable workflows and the unlistable one ([P34]); the mock answers the latter's run list with an error.
  [DISPATCH_TRIO]: { workflows: [def(DISPATCH_TRIO, 'alpha-feature'), def(DISPATCH_TRIO, 'beta-feature'), def(DISPATCH_TRIO, 'gamma-feature'), def(DISPATCH_TRIO, DISPATCH_TRIO_LOCKED)] },
  [DISPATCH_NOORIGIN]: { workflows: [def(DISPATCH_NOORIGIN, 'main'), ...M2_WORKFLOWS[DISPATCH_NOORIGIN].map(id => def(DISPATCH_NOORIGIN, id))] },
  [DISPATCH_BUSY]: { workflows: [def(DISPATCH_BUSY, 'ship')] },
  // The unreadable project lists one workflow whose runs cannot be listed, so its run state reads "cannot be read" while its
  // project page still renders (git unavailable → "git not read", V10). The candidate seeds the same workflow with an unreadable run.
  [DISPATCH_UNREADABLE]: { workflows: [def(DISPATCH_UNREADABLE, DISPATCH_UNREADABLE_WORKFLOW)] },
  [DISPATCH_SPEND]: { workflows: [def(DISPATCH_SPEND, SPEND_WORKFLOW), def(DISPATCH_SPEND, SPEND_BROKEN_WORKFLOW), def(DISPATCH_SPEND, REUSE_WORKFLOW)] },
}

// ---- Run details the reading pane reads for its NextStep ([P31], V2) -------------------------------------------------
// The pane reads the run detail with `fetchRunDetail` and derives the run's NextStep with `deriveNow`; the worker-phase mock
// must serve a detail for every dispatch run the specs dock. These three are the Widgets `ui-polish` runs the pane scenario
// selects: a run that failed at verification (so `deriveNow` yields a retry command, not a fixed status line) and two integrated runs.
const UI_POLISH_DEF = def(DISPATCH_WIDGETS, 'ui-polish')
const C = '2025-01-01T08:00:00Z'
const U = '2025-01-01T09:00:00Z'
const allDone: Record<string, NodeState> = Object.fromEntries(PIPELINE.map(node => [node.node_id, done()]))
export const DISPATCH_RUN_DETAILS: Record<string, RunDetail> = {
  'ui-polish-001': runDetail('ui-polish-001', 'succeeded', UI_POLISH_DEF, C, U, allDone, 10),
  'ui-polish-003': runDetail('ui-polish-003', 'succeeded', UI_POLISH_DEF, C, U, allDone, 10),
  'ui-polish-002': runDetail('ui-polish-002', 'failed', UI_POLISH_DEF, C, U, {
    challenge: done(), launch_ui: done('sess-ui', 'ui'), handoff: done(), verify_ui: { status: 'failed', attempt: 3, result: 'ui' },
  }, 8),
}

// ---- The dispatch overview (git + GitHub per project) ----------------------------------------------------------------

const prList = (repo: string): GithubState['prs'] => [
  // Possibly related: the head branch is a run's source branch (`feature/ui-polish-002`), an exact match ([D5]).
  { number: 43, title: 'Land the verify fix', url: `https://github.com/${repo}/pull/43`, state: 'OPEN', draft: false, author: 'octocat', author_is_bot: false, head_ref: 'feature/ui-polish-002', base_ref: 'main', updated_at: '2026-10-10T11:00:00Z', merged_at: null, review_decision: 'REVIEW_REQUIRED', checks: { passing: 3, failing: 0, pending: 1 }, labels: ['ui'] },
  // Yours, open: the viewer's PR on an unrelated branch.
  { number: 42, title: 'Polish the widget header', url: `https://github.com/${repo}/pull/42`, state: 'OPEN', draft: false, author: VIEWER_LOGIN, author_is_bot: false, head_ref: 'chore/header', base_ref: 'main', updated_at: '2026-10-10T10:00:00Z', merged_at: null, review_decision: 'CHANGES_REQUESTED', checks: { passing: 2, failing: 1, pending: 0 }, labels: [] },
  // Others, open.
  { number: 41, title: 'Refactor the store', url: `https://github.com/${repo}/pull/41`, state: 'OPEN', draft: true, author: 'octocat', author_is_bot: false, head_ref: 'chore/store', base_ref: 'main', updated_at: '2026-10-09T10:00:00Z', merged_at: null, review_decision: 'APPROVED', checks: { passing: 5, failing: 0, pending: 0 }, labels: [] },
  // Merged in the last 14 days.
  { number: 40, title: 'Bump deps', url: `https://github.com/${repo}/pull/40`, state: 'MERGED', draft: false, author: 'octocat', author_is_bot: false, head_ref: 'deps', base_ref: 'main', updated_at: '2026-10-05T10:00:00Z', merged_at: '2026-10-05T10:00:00Z', review_decision: 'APPROVED', checks: null, labels: [] },
]
const issueList = (repo: string): GithubState['issues'] => [
  { number: 100, title: 'Header overflows on mobile', url: `https://github.com/${repo}/issues/100`, author: 'octocat', author_is_bot: false, labels: ['bug'], assignees: [VIEWER_LOGIN], created_at: '2026-10-08T10:00:00Z', updated_at: '2026-10-09T10:00:00Z' },
  { number: 99, title: 'Document the config', url: `https://github.com/${repo}/issues/99`, author: 'alice', author_is_bot: false, labels: ['docs'], assignees: [], created_at: '2025-11-01T10:00:00Z', updated_at: '2025-11-01T10:00:00Z' },
  // Six "Newest from people" issues in all, so that group is longer than five and folds to "Show N more" (V8).
  ...[98, 97, 96, 95, 94].map(number => ({ number, title: `Open question ${number}`, url: `https://github.com/${repo}/issues/${number}`, author: 'bob', author_is_bot: false, labels: [], assignees: [], created_at: '2026-10-06T10:00:00Z', updated_at: '2026-10-06T10:00:00Z' })),
  { number: 90, title: 'Dependency alert', url: `https://github.com/${repo}/issues/90`, author: 'dependabot[bot]', author_is_bot: true, labels: [], assignees: [], created_at: '2025-11-01T10:00:00Z', updated_at: '2025-11-01T10:00:00Z' },
]

const ghRead = (repo: string, visibility: GithubState['visibility'], open_prs: number, open_issues: number): GithubState => ({
  status: 'read', reason: null, repo, read_at: READ_AT, visibility, default_branch: 'main', pushed_at: '2026-10-10T10:00:00Z',
  head: { sha: sha('ghhead'), committed_at: '2026-10-10T09:30:00Z' }, open_prs, open_issues, prs: prList(repo), issues: issueList(repo),
})
const ghNone = (status: GithubState['status'], reason: string): GithubState => ({
  status, reason, repo: null, read_at: null, visibility: null, default_branch: null, pushed_at: null, head: null, open_prs: null, open_issues: null, prs: [], issues: [],
})

const CLONE_A = 'a1b2c3d4e5f6'
const widgetsGit = (projectId: string, primary: string, checkout: string): ProjectDispatch['git'] => ({
  status: 'read', reason: null, repository_label: primary === projectId ? '~/dev/widgets' : '~/dev/widgets-wt', checkout, head: sha('head'),
  default_branch: 'main', clone_id: CLONE_A, clone_primary: primary,
  origin: primary === projectId
    ? { ref: 'origin/main', sha: sha('origin'), updated_at: '2026-10-09T11:54:00Z', compare: 'compared', ahead: 2, behind: 1 }
    : { ref: 'origin/main', sha: sha('origin'), updated_at: '2026-10-09T11:54:00Z', compare: 'compared', ahead: 2, behind: 1 },
  ahead_commits: primary === projectId
    ? [{ sha: sha('c1'), subject: 'Workflow ui-polish-001: integrate', committed_at: '2026-10-10T08:00:00Z', run_id: 'ui-polish-001' }, { sha: sha('c2'), subject: 'Local tweak', committed_at: '2026-10-09T08:00:00Z', run_id: null }]
    : [],
  ahead_naming_run: primary === projectId ? 1 : 0,
  // Exactly two integrated runs ([P25], V16): one on local main and origin, one on local main only. 2 on local, 1 on origin, 0 unknown.
  landings: primary === projectId
    ? [
      { workflow_id: 'ui-polish', run_id: 'ui-polish-001', sha: sha('c1'), on_default: true, on_origin: true },
      { workflow_id: 'ui-polish', run_id: 'ui-polish-003', sha: sha('c3'), on_default: true, on_origin: false },
    ]
    : [],
  read_at: READ_AT,
})

// Busy is 52 commits ahead; the server lists at most 50, so the pane shows 50 and "and 2 more" ([P33], V6). The first names a run.
const busyAheadCommits: ProjectDispatch['git']['ahead_commits'] = Array.from({ length: 50 }, (_, i) => ({
  sha: (i + 256).toString(16).padStart(40, '0'), // a distinct 40-hex sha per commit (no zero-padding collisions)
  subject: i === 0 ? 'Workflow ship-001: integrate' : `Local change ${50 - i}`,
  committed_at: '2026-10-10T08:00:00Z',
  run_id: i === 0 ? 'ship-001' : null,
}))

function overviewFor(projectIds: readonly string[]): DispatchOverview {
  const known: Record<string, ProjectDispatch> = {
    [DISPATCH_LOCAL]: {
      project_id: DISPATCH_LOCAL,
      git: { status: 'read', reason: null, repository_label: '~/dev/localonly', checkout: 'main', head: sha('loc'), default_branch: 'main', clone_id: 'loc000000000', clone_primary: DISPATCH_LOCAL, origin: { ref: 'origin/main', sha: sha('locorigin'), updated_at: '2026-10-08T10:00:00Z', compare: 'compared', ahead: 0, behind: 0 }, ahead_commits: [], ahead_naming_run: 0, landings: [], read_at: READ_AT },
      github: ghNone('not_github', 'not a GitHub remote'),
    },
    // The worker-phase overview marks Widgets' GitHub read with a failed latest refresh ([P35], V20): status stays `read`, the
    // data shows, and the viewer adds the "latest refresh failed" line. The candidate server cannot produce this, so the spec
    // asserts the line in the worker phase only, and the GitHub fixture file (candidate) carries no `reason`.
    [DISPATCH_WIDGETS]: { project_id: DISPATCH_WIDGETS, git: widgetsGit(DISPATCH_WIDGETS, DISPATCH_WIDGETS, 'feature/ui-polish'), github: { ...ghRead('acme/widgets', 'PUBLIC', 3, 3), reason: 'gh timed out after 20 s' } },
    [DISPATCH_BUSY]: {
      project_id: DISPATCH_BUSY,
      git: {
        status: 'read', reason: null, repository_label: '~/dev/busy', checkout: 'main', head: sha('busy'), default_branch: 'main',
        clone_id: 'busy00000000', clone_primary: DISPATCH_BUSY,
        // 52 ahead, 1 behind; the reflog time is missing ([L9]), so the sync says "update time not recorded".
        origin: { ref: 'origin/main', sha: sha('busyorigin'), updated_at: null, compare: 'compared', ahead: 52, behind: 1 },
        ahead_commits: busyAheadCommits, ahead_naming_run: 1, landings: [], read_at: READ_AT,
      },
      github: ghRead('acme/busy', 'PUBLIC', 0, 0),
    },
    [DISPATCH_WIDGETS_WT]: { project_id: DISPATCH_WIDGETS_WT, git: widgetsGit(DISPATCH_WIDGETS_WT, DISPATCH_WIDGETS, 'experiment'), github: ghRead('acme/widgets', 'PUBLIC', 2, 3) },
    [DISPATCH_TRIO]: {
      project_id: DISPATCH_TRIO,
      git: { status: 'read', reason: null, repository_label: '~/dev/trio', checkout: 'main', head: sha('trio'), default_branch: 'main', clone_id: 'trio00000000', clone_primary: DISPATCH_TRIO, origin: { ref: 'origin/main', sha: sha('trioorigin'), updated_at: '2026-10-09T10:00:00Z', compare: 'compared', ahead: 0, behind: 0 }, ahead_commits: [], ahead_naming_run: 0, landings: [], read_at: READ_AT },
      github: ghRead('acme/trio', 'PRIVATE', 2, 3),
    },
    [DISPATCH_NOORIGIN]: {
      project_id: DISPATCH_NOORIGIN,
      git: { status: 'read', reason: null, repository_label: '~/dev/noorigin', checkout: 'main', head: sha('noo'), default_branch: 'main', clone_id: 'noo000000000', clone_primary: DISPATCH_NOORIGIN, origin: null, ahead_commits: [], ahead_naming_run: 0, landings: [], read_at: READ_AT },
      github: ghRead('acme/noorigin', 'PUBLIC', 0, 0),
    },
    [DISPATCH_UNREADABLE]: {
      project_id: DISPATCH_UNREADABLE,
      git: { status: 'unavailable', reason: 'not a git repository', repository_label: 'unreadable', checkout: null, head: null, default_branch: null, clone_id: null, clone_primary: null, origin: null, ahead_commits: [], ahead_naming_run: 0, landings: [], read_at: READ_AT },
      github: ghNone('unavailable', 'git is unavailable'),
    },
  }
  const fallback = (projectId: string): ProjectDispatch => ({
    project_id: projectId,
    git: { status: 'unavailable', reason: 'not a git repository', repository_label: projectId, checkout: null, head: null, default_branch: null, clone_id: null, clone_primary: null, origin: null, ahead_commits: [], ahead_naming_run: 0, landings: [], read_at: READ_AT },
    github: ghNone('not_github', 'not a GitHub remote'),
  })
  return {
    contract_version: '1.0.0', read_at: READ_AT, viewer_login: VIEWER_LOGIN,
    projects: projectIds.map(id => known[id] ?? fallback(id)),
  }
}

// ---- The step chart data per project ---------------------------------------------------------------------------------

const DISPATCH_STEPS: Record<string, ProjectSteps> = {
  [DISPATCH_WIDGETS]: {
    contract_version: '1.0.0', project_id: DISPATCH_WIDGETS,
    workflows: [
      { workflow_id: 'ui-polish', error: null, errors: [], runs: [
        stepsRun('ui-polish-003', { node_id: 'integrate', status: 'succeeded' }, { integrated: sha('c3') }),
        uiPolish002WithParallelLaunch(),
        stepsRun('ui-polish-001', { node_id: 'integrate', status: 'succeeded' }, { integrated: sha('c1') }),
      ] },
      // An unreadable run is a per-run entry in `errors` (contracts/projects/examples.ts, server-task.md item 76): the server loads
      // each run directory itself and only the invalid one fails, with the actual run id — never a whole-workflow `error` here.
      { workflow_id: 'broken', error: null, errors: [{ run_id: 'broken-001', code: 'RUN_STORAGE_INVALID', message: 'Run "broken-001" has malformed or contradictory persisted state: plan.json is missing' }], runs: [] },
    ],
  },
  [DISPATCH_LOCAL]: {
    contract_version: '1.0.0', project_id: DISPATCH_LOCAL,
    workflows: [{ workflow_id: 'sync', error: null, errors: [], runs: [stepsRun('sync-001', { node_id: 'approval', status: 'awaiting_approval' })] }],
  },
  [DISPATCH_WIDGETS_WT]: {
    contract_version: '1.0.0', project_id: DISPATCH_WIDGETS_WT,
    workflows: [{ workflow_id: 'experiment', error: null, errors: [], runs: [stepsRun('experiment-001', { node_id: 'integrate', status: 'succeeded' }, { integrated: sha('e1') })] }],
  },
  [DISPATCH_TRIO]: {
    contract_version: '1.0.0', project_id: DISPATCH_TRIO,
    workflows: [
      { workflow_id: 'alpha-feature', error: null, errors: [], runs: [stepsRun('alpha-feature-001', { node_id: 'integrate', status: 'succeeded' }, { integrated: sha('a1') })] },
      { workflow_id: 'beta-feature', error: null, errors: [], runs: [stepsRun('beta-feature-001', { node_id: 'review', status: 'cancelled' })] },
      { workflow_id: 'gamma-feature', error: null, errors: [], runs: [stepsRun('gamma-feature-001', { node_id: 'verify_ui', attempt: 2, status: 'failed' })] },
      // The workflow whose runs could not be listed at all: a whole-workflow `error`, shown with the literal `<run-id>` placeholder ([P21], V18).
      { workflow_id: DISPATCH_TRIO_LOCKED, error: { code: 'RUNS_UNREADABLE', message: 'The runs directory of this workflow could not be listed.' }, errors: [], runs: [] },
    ],
  },
  [DISPATCH_NOORIGIN]: {
    contract_version: '1.0.0', project_id: DISPATCH_NOORIGIN,
    workflows: [{ workflow_id: 'main', error: null, errors: [], runs: [stepsRun('main-001', { node_id: 'integrate', status: 'succeeded' }, { integrated: sha('m1') })] }],
  },
  [DISPATCH_BUSY]: {
    contract_version: '1.0.0', project_id: DISPATCH_BUSY,
    workflows: [{ workflow_id: 'ship', error: null, errors: [], runs: [
      stepsRun('ship-002', { node_id: 'launch_ui', status: 'running' }),
      stepsRun('ship-001', { node_id: 'approval', status: 'awaiting_approval' }),
    ] }],
  },
}

/** The worker-phase dispatch responses, served by `mock.ts`. `projectIds` is the registry order at serve time. */
export function dispatchOverview(projectIds: readonly string[]): DispatchOverview {
  return overviewFor(projectIds)
}

export function dispatchSteps(projectId: string): ProjectSteps | null {
  return DISPATCH_STEPS[projectId] ?? { contract_version: '1.0.0', project_id: projectId, workflows: [] }
}

// ---- Candidate-phase seeding: real git repositories under the test root ([P16], [L2]) --------------------------------

/** Git with an isolated config and identity, as every seed must ([L2], design-challenge note 9); never a global or system config. */
const GIT_SEED_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Seed', GIT_AUTHOR_EMAIL: 'seed@example.com', GIT_COMMITTER_NAME: 'Seed', GIT_COMMITTER_EMAIL: 'seed@example.com',
}
function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { env: { ...process.env, ...GIT_SEED_ENV }, stdio: 'ignore' })
}
/** A git command whose trimmed stdout is returned (for a commit sha); the same isolated config and identity as `git`. */
function gitOut(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { env: { ...process.env, ...GIT_SEED_ENV }, encoding: 'utf8' }).trim()
}
const commit = (repo: string, message: string) => {
  writeFileSync(join(repo, `${Date.now()}-${Math.random().toString(36).slice(2)}.txt`), `${message}\n`)
  git(repo, ['add', '-A'])
  git(repo, ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', message])
}
const initRepo = (dir: string, bare = false) => { mkdirSync(dir, { recursive: true }); git(dir, bare ? ['init', '--bare', '--initial-branch=main'] : ['init', '--initial-branch=main']) }

// ---- Run directories in the documented storage format, so the real server (candidate phase) projects the same runs -----
// `mock.ts` serves in worker mode, so these are untested in the viewer worktree; the server and the controller read them.

const RUN_BASE = sha('dispatch-base')
const RUN_CREATED = '2025-01-01T08:00:00Z'
type SeedNode = { node_id: string; label: string; kind: string }
/** The eight pipeline steps, and the subset an integrated run pins (its verify/candidate nodes need packets to read succeeded,
 * which this minimal seed does not write, so an integrated run omits them and still reads succeeded). */
const PIPELINE_NODES: SeedNode[] = PIPELINE.map(node => ({ node_id: node.node_id, label: node.label, kind: node.kind }))
const INTEGRATED_NODES: SeedNode[] = PIPELINE_NODES.filter(node => node.node_id !== 'verify_ui' && node.node_id !== 'candidate')

type RunShape =
  | { kind: 'integrated'; integratedSha: string }
  | { kind: 'failed'; attempt: number }
  | { kind: 'awaiting' }
  | { kind: 'running' }
  | { kind: 'cancelled' }
  | { kind: 'unreadable' }

/**
 * Writes one run directory (`run-state.json` version 1.0.0 + `plan.json`) whose derived snapshot reads the status this shape
 * asks for: an integrated run (every step succeeded through `integrate`), a run failed at verification (its attempt from the
 * event message), a run awaiting approval (a review interrupt), a cancelled run (a controller `cancelled` row) and an
 * unreadable run (its `plan.json` left out, so the server reads `RUN_STORAGE_INVALID: plan.json is missing`).
 */
function writeDispatchRun(runsRootDir: string, runId: string, updatedAt: string, shape: RunShape, costs?: { total_usd: number | null }): void {
  const dir = join(runsRootDir, runId)
  mkdirSync(dir, { recursive: true })
  const event = (sequence: number, node: string, status: string, message: string) => ({ sequence, time: RUN_CREATED, node, status, message })
  let nodes: SeedNode[] = INTEGRATED_NODES
  let values: Record<string, unknown> = { run_id: runId }
  let tasks: { node_id: string; error: string | null; interrupts: object[]; result: object | null }[] = []
  let next: string[] = []
  let events: { sequence: number; time: string; node: string; status: string; message: string }[] = []
  if (shape.kind === 'integrated') {
    values = { run_id: runId, ui: { session_id: 'sess-ui' }, snapshots: { ui: sha('snap') }, review: { run_id: runId, verdict: 'approved' }, approved_bundle: sha('bundle'), integrated_commit: shape.integratedSha }
    events = [event(1, 'challenge', 'succeeded', 'Design challenge accepted'), event(2, 'integrate', 'succeeded', `Fast-forwarded to ${shape.integratedSha}`)]
  } else if (shape.kind === 'failed') {
    nodes = PIPELINE_NODES
    values = { run_id: runId, ui: { session_id: 'sess-ui' }, snapshots: { ui: sha('snap') } }
    tasks = [{ node_id: 'verify_ui', error: `Gate failed after ${shape.attempt} attempts`, interrupts: [], result: null }]
    next = ['verify_ui']
    events = [event(1, 'challenge', 'succeeded', 'Design challenge accepted'), event(2, 'verify_ui', 'failed', `Attempt ${shape.attempt}; verification failed`)]
  } else if (shape.kind === 'awaiting') {
    values = { run_id: runId, ui: { session_id: 'sess-ui' }, snapshots: { ui: sha('snap') } }
    tasks = [{ node_id: 'review', error: null, interrupts: [{ kind: 'independent_review', message: 'Independent review required before integration' }], result: null }]
    next = ['review']
    events = [event(1, 'challenge', 'succeeded', 'Design challenge accepted')]
  } else if (shape.kind === 'running') {
    nodes = PIPELINE_NODES
    values = { run_id: runId, ui: { session_id: 'sess-ui' } }
    next = ['launch_ui']
    events = [event(1, 'challenge', 'succeeded', 'Design challenge accepted'), event(2, 'launch_ui', 'running', 'UI worker launched')]
  } else if (shape.kind === 'cancelled') {
    events = [event(1, 'challenge', 'succeeded', 'Design challenge accepted'), event(2, 'controller', 'cancelled', 'Abandoned by the operator')]
  }
  const state = {
    version: '1.0.0', run_id: runId, base_commit: RUN_BASE, created_at: RUN_CREATED, updated_at: updatedAt,
    definition: { name: 'Feature implementation', nodes: nodes.map(node => ({ ...node, depends_on: [] })) },
    values, next, tasks, events, verification_packets: [],
    // The `costs` section as workflow/costs.py writes it (the viewer reads only `total_usd`).
    ...(costs !== undefined ? { costs: { total_usd: costs.total_usd, by_role: { workers: costs.total_usd }, nodes: [] } } : {}),
  }
  writeFileSync(join(dir, 'run-state.json'), `${JSON.stringify(state, null, 2)}\n`)
  if (events.length) writeFileSync(join(dir, 'events.jsonl'), events.map(entry => JSON.stringify(entry)).join('\n') + '\n')
  // The unreadable run keeps its run-state but no plan.json, so the server reads it as RUN_STORAGE_INVALID "plan.json is missing".
  if (shape.kind !== 'unreadable') writeFileSync(join(dir, 'plan.json'), `${JSON.stringify({ run_id: runId, base_commit: RUN_BASE }, null, 2)}\n`)
}

/**
 * Writes a one-lane integrated run with its two verification packets in the workflow/checks.py layout (only the keys the server
 * reads: phase, result, gate and, for a reused candidate packet, `reused_from` naming the worker packet and its sha256), and the
 * controller's rows: the lane's check, then its `candidate_ui` gate row, which says it reused the worker checks when it did.
 */
function writeReuseRun(runsRootDir: string, runId: string, reused: boolean): void {
  const dir = join(runsRootDir, runId)
  const commit = sha(`out-${runId}`)
  const digest = (text: string) => createHash('sha256').update(text).digest('hex')
  const result = (phase: 'worker' | 'candidate') => ({
    contract_version: '1.0.0', run_id: runId, node_id: 'ui', attempt: 1, session_id: 'sess-ui', status: 'succeeded', base_commit: RUN_BASE, output_commit: commit,
    changed_files: ['src/ui.ts'], checks: [], open_assumptions: [], artifacts: [],
    summary: phase === 'candidate' && reused ? 'Worker check capture verification/worker/ui/1/packet.json reused for the candidate gate; not integration approval' : `Trusted ${phase} check capture; not integration approval`,
    error: null,
  })
  const registrations: { phase: string; node_id: string; attempt: number; path: string; sha256: string }[] = []
  const writePacketFile = (phase: 'worker' | 'candidate', extra: Record<string, unknown>) => {
    const relative = `verification/${phase}/ui/1/packet.json`
    mkdirSync(join(dir, 'verification', phase, 'ui', '1'), { recursive: true })
    const text = `${JSON.stringify({ phase, result: result(phase), gate: { status: 'passed', reasons: [] }, ...extra }, null, 2)}\n`
    writeFileSync(join(dir, relative), text)
    registrations.push({ phase, node_id: 'ui', attempt: 1, path: relative, sha256: digest(text) })
    return digest(text)
  }
  const workerDigest = writePacketFile('worker', {})
  writePacketFile('candidate', reused ? { reused_from: { path: 'verification/worker/ui/1/packet.json', sha256: workerDigest } } : {})
  const time = (minute: number) => `2025-01-01T08:${String(minute).padStart(2, '0')}:00Z`
  const rows: [string, string, string][] = [
    ['challenge', 'succeeded', 'Design challenge accepted'], ['ui', 'running', 'Launching or reconciling the exact native session'],
    ['freeze', 'succeeded', 'Immutable snapshots captured; worker-reported checks are not trusted'],
    ['verify_ui', 'running', `Attempt 1; revision ${commit}`], ['verify_ui', 'passed', 'Required tests and artifacts passed'],
    ...(reused ? [] : [['candidate_ui', 'running', `Attempt 1; combined revision ${commit}`] as [string, string, string]]),
    ['candidate_ui', 'passed', reused ? REUSE_GATE_MESSAGE.replace('{commit}', commit) : `Combined revision ${commit}`],
    ['review', 'approved', 'Independent reviewer approved the candidate'], ['integrate', 'succeeded', `Fast-forwarded to ${commit}`],
  ]
  const events = rows.map(([node, status, message], index) => ({ sequence: index + 1, time: time(index + 1), node, status, message }))
  const state = {
    version: '1.0.0', run_id: runId, base_commit: RUN_BASE, created_at: RUN_CREATED, updated_at: '2025-01-01T09:00:00Z',
    definition: { name: 'Feature implementation', nodes: PIPELINE_NODES.map(node => ({ ...node, depends_on: [] })) },
    values: { run_id: runId, ui: { session_id: 'sess-ui' }, snapshots: { ui: commit }, ui_packet: 'verification/worker/ui/1/packet.json', bundle: { run_id: runId, base_commit: RUN_BASE, candidate_commit: commit }, review: { run_id: runId, verdict: 'approved' }, approved_bundle: sha('bundle'), integrated_commit: commit },
    next: [], tasks: [], events, verification_packets: registrations,
  }
  writeFileSync(join(dir, 'run-state.json'), `${JSON.stringify(state, null, 2)}\n`)
  writeFileSync(join(dir, 'events.jsonl'), events.map(entry => JSON.stringify(entry)).join('\n') + '\n')
  writeFileSync(join(dir, 'plan.json'), `${JSON.stringify({ run_id: runId, base_commit: RUN_BASE }, null, 2)}\n`)
}

/** Writes one of the runs that need the operator, or not (`M2_RUNS`) in the storage format, its rows as given, so the server derives the same state. */
function writeM2Run(runsRootDir: string, run: M2Run): void {
  const dir = join(runsRootDir, run.runId)
  mkdirSync(dir, { recursive: true })
  const events = run.events.map(([time, node, status, message], index) => ({ sequence: index + 1, time, node, status, message }))
  const state = {
    version: '1.0.0', run_id: run.runId, base_commit: RUN_BASE, created_at: run.created, updated_at: run.events.at(-1)![0],
    definition: { name: 'Feature implementation', nodes: PIPELINE_NODES.map(node => ({ ...node, depends_on: [] })) },
    values: { run_id: run.runId }, next: run.next, tasks: run.tasks ?? [], events, verification_packets: [],
  }
  writeFileSync(join(dir, 'run-state.json'), `${JSON.stringify(state, null, 2)}\n`)
  writeFileSync(join(dir, 'events.jsonl'), events.map(entry => JSON.stringify(entry)).join('\n') + '\n')
  writeFileSync(join(dir, 'plan.json'), `${JSON.stringify({ run_id: run.runId, base_commit: RUN_BASE }, null, 2)}\n`)
}

/** One run branch as the GitHub fixture's optional `branches` map holds it (`server/dispatchGithub.ts` `githubBranchReadSchema`). */
export type FixtureBranchRead = {
  read_at: string | null; visibility: GithubRepoRead['visibility']; viewer_permission: 'ADMIN' | 'MAINTAIN' | 'WRITE' | 'TRIAGE' | 'READ' | null
  default_branch: string | null; github_sha: string | null; pr: RunPr | null
  earlier_prs: { number: number; title: string; url: string; state: 'OPEN' | 'MERGED' | 'CLOSED'; updated_at: string }[]
}

export type DispatchSeed = {
  /** Registry project entries to append (`project_id`, `name`, `repository`, `workflows`). */
  projects: { project_id: string; name: string; repository: string; workflows: { workflow_id: string; runs_root: string; definition: { name: string; nodes: unknown[] } }[] }[]
  /** The GitHub fixture `{ viewer_login, repos }` for `MD_MANAGER_GITHUB_FIXTURE`. */
  githubFixture: { viewer_login: string; repos: Record<string, GithubRepoRead>; branches: Record<string, FixtureBranchRead> }
}

/**
 * Creates the dispatch feature's git repositories under `<root>/dispatch` and returns the registry projects and the GitHub
 * fixture for the real server (candidate phase and the critique app). Opt-in: only `playwright.config.ts` and `dispatch-app.ts`
 * call it, never `controls-app.ts` ([L2]). Untested in the viewer worktree — the real server (the `server` lane) reads these;
 * the controller verifies the candidate phase after both lanes merge.
 */
export function seedDispatchCandidate(root: string): DispatchSeed {
  const base = join(root, 'dispatch')
  mkdirSync(base, { recursive: true })
  const nodes = PIPELINE.map(node => ({ ...node, depends_on: [] }))
  const runsRoot = (projectId: string, workflowId: string) => { const dir = join(base, 'runs', projectId, workflowId); mkdirSync(dir, { recursive: true }); return dir }
  const workflowsFor = (projectId: string, ids: string[]) => ids.map(workflowId => ({ workflow_id: workflowId, runs_root: runsRoot(projectId, workflowId), definition: { name: 'Feature implementation', nodes } }))

  // A bare origin, then a primary clone 2 ahead and 1 behind; the origin's URL is set to a GitHub https URL.
  const origin = join(base, 'origin.git')
  initRepo(origin, true)
  const seedClone = join(base, 'seed')
  git(base, ['clone', origin, 'seed'])
  commit(seedClone, 'base A'); commit(seedClone, 'base B')
  git(seedClone, ['push', 'origin', 'main'])
  const widgets = join(base, 'widgets')
  git(base, ['clone', origin, 'widgets'])
  commit(seedClone, 'origin C'); git(seedClone, ['push', 'origin', 'main'])
  git(widgets, ['fetch', 'origin'])
  // 2 ahead, 1 behind origin/main. One ahead commit's subject names a known run (`ui-polish-001`), so `ahead_naming_run` is 1;
  // the other names none. The run directory below gives that id to `run_ids`, which is what makes the name count.
  commit(widgets, 'Workflow ui-polish-001: integrate'); commit(widgets, 'Local tweak')
  git(widgets, ['remote', 'set-url', 'origin', 'https://github.com/acme/widgets.git'])
  // Base B (two commits back from the new tip) is an ancestor of both the local main and origin/main; using it as the run's
  // landed sha makes the landing read true on local main and true on origin. The first ahead commit (HEAD~1) is on local main
  // only, so a second integrated run that landed there reads true on local, false on origin ([P25], V16).
  const landedSha = gitOut(widgets, ['rev-parse', 'HEAD~2'])
  const localOnlySha = gitOut(widgets, ['rev-parse', 'HEAD~1'])
  // Check the primary clone out onto a feature branch (never the default branch, whose name every PR's base would match). It
  // matches PR #43's head, so that PR reads "possibly related"; ahead/behind stay measured on refs/heads/main.
  git(widgets, ['checkout', '-b', 'feature/ui-polish-002'])

  // A worktree of the primary clone, registered as a second project.
  const worktree = join(base, 'widgets-wt')
  git(widgets, ['worktree', 'add', '-b', 'experiment', worktree])

  // A non-GitHub remote, a repository with no origin, a readable three-feature project, and an unreadable (non-repo) directory.
  const localonly = join(base, 'localonly'); git(base, ['clone', origin, 'localonly']); git(localonly, ['remote', 'set-url', 'origin', 'git@gitlab.com:acme/localonly.git'])
  const noorigin = join(base, 'noorigin'); initRepo(noorigin); commit(noorigin, 'solo'); git(noorigin, ['remote', 'add', 'origin', 'https://github.com/acme/noorigin.git'])
  const trio = join(base, 'trio'); initRepo(trio); commit(trio, 'trio'); git(trio, ['remote', 'add', 'origin', 'https://github.com/acme/trio.git'])
  const unreadable = join(base, 'unreadable'); mkdirSync(unreadable, { recursive: true }); writeFileSync(join(unreadable, 'README.md'), 'not a git repo\n')

  // Busy: its own origin and clone, 52 ahead and 1 behind, with the origin remote-tracking reflog removed so its update time
  // is not recorded ([L9], [P33]). One ahead commit names a run (`ship-001`).
  const busyOrigin = join(base, 'busy-origin.git'); initRepo(busyOrigin, true)
  const busySeed = join(base, 'busy-seed'); git(base, ['clone', busyOrigin, 'busy-seed'])
  commit(busySeed, 'busy base'); git(busySeed, ['push', 'origin', 'main'])
  const busy = join(base, 'busy'); git(base, ['clone', busyOrigin, 'busy'])
  commit(busySeed, 'busy origin ahead'); git(busySeed, ['push', 'origin', 'main'])
  git(busy, ['fetch', 'origin'])
  for (let i = 0; i < 52; i++) commit(busy, i === 0 ? 'Workflow ship-001: integrate' : `Busy local change ${i}`)
  git(busy, ['remote', 'set-url', 'origin', 'https://github.com/acme/busy.git'])
  rmSync(join(busy, '.git', 'logs', 'refs', 'remotes', 'origin', 'main'), { force: true })

  // Trio's unlistable workflow ([P34]): its `runs_root` is a regular file, so the server cannot list it and reports a
  // workflow-level error (not a chmod 000 directory, which a root-run suite would read).
  const trioLockedRuns = join(base, 'runs', DISPATCH_TRIO, DISPATCH_TRIO_LOCKED)
  mkdirSync(join(base, 'runs', DISPATCH_TRIO), { recursive: true }); writeFileSync(trioLockedRuns, 'not a directory\n')

  // Seed each project's runs so the real server lists them with the states the worker-phase fixtures express.
  writeDispatchRun(runsRoot(DISPATCH_WIDGETS, 'ui-polish'), 'ui-polish-001', '2025-01-02T00:00:00Z', { kind: 'integrated', integratedSha: landedSha })
  writeDispatchRun(runsRoot(DISPATCH_WIDGETS, 'ui-polish'), 'ui-polish-002', '2025-01-01T00:00:00Z', { kind: 'failed', attempt: 3 })
  // The second integrated run landed on local main only (its sha is ahead of origin): on_default true, on_origin false ([P25]).
  writeDispatchRun(runsRoot(DISPATCH_WIDGETS, 'ui-polish'), 'ui-polish-003', '2025-01-03T00:00:00Z', { kind: 'integrated', integratedSha: localOnlySha })
  writeDispatchRun(runsRoot(DISPATCH_BUSY, 'ship'), 'ship-001', '2025-01-01T09:00:00Z', { kind: 'awaiting' })
  writeDispatchRun(runsRoot(DISPATCH_BUSY, 'ship'), 'ship-002', '2025-01-02T09:00:00Z', { kind: 'running' })
  // The widgets `broken` feature: one run whose plan.json is missing, so the server reports it as an unreadable run.
  writeDispatchRun(runsRoot(DISPATCH_WIDGETS, 'broken'), 'broken-001', '2025-01-01T00:00:00Z', { kind: 'unreadable' })
  writeDispatchRun(runsRoot(DISPATCH_LOCAL, 'sync'), 'sync-001', '2025-01-01T09:00:00Z', { kind: 'awaiting' })
  writeDispatchRun(runsRoot(DISPATCH_WIDGETS_WT, 'experiment'), 'experiment-001', '2025-01-01T09:00:00Z', { kind: 'integrated', integratedSha: sha('land-experiment') })
  writeDispatchRun(runsRoot(DISPATCH_TRIO, 'alpha-feature'), 'alpha-feature-001', '2025-01-01T09:00:00Z', { kind: 'integrated', integratedSha: sha('land-alpha') })
  writeDispatchRun(runsRoot(DISPATCH_TRIO, 'beta-feature'), 'beta-feature-001', '2025-01-01T09:00:00Z', { kind: 'cancelled' })
  writeDispatchRun(runsRoot(DISPATCH_TRIO, 'gamma-feature'), 'gamma-feature-001', '2025-01-01T09:00:00Z', { kind: 'failed', attempt: 2 })
  writeDispatchRun(runsRoot(DISPATCH_NOORIGIN, 'main'), 'main-001', '2025-01-01T09:00:00Z', { kind: 'integrated', integratedSha: sha('land-main') })
  for (const run of M2_RUNS) writeM2Run(runsRoot(run.projectId, run.workflowId), run)
  // The unreadable project's only run is unreadable too, so its whole run list fails and the project reads "cannot be read".
  writeDispatchRun(runsRoot(DISPATCH_UNREADABLE, 'x'), 'x-001', '2025-01-01T09:00:00Z', { kind: 'unreadable' })
  // Spend: the ledger runs with their recorded costs (one without a section), and a workflow whose only run cannot be read.
  const spendRepo = join(base, 'spend'); initRepo(spendRepo); commit(spendRepo, 'ledger')
  for (const runId of SPEND_RUNS) {
    const cost = SPEND_RUN_COSTS[runId]
    writeDispatchRun(runsRoot(DISPATCH_SPEND, SPEND_WORKFLOW), runId, '2025-01-01T09:00:00Z', { kind: 'integrated', integratedSha: sha(`land-${runId}`) }, cost === undefined ? undefined : { total_usd: cost })
  }
  writeDispatchRun(runsRoot(DISPATCH_SPEND, SPEND_BROKEN_WORKFLOW), 'ledger-broken-001', '2025-01-01T09:00:00Z', { kind: 'unreadable' })
  writeReuseRun(runsRoot(DISPATCH_SPEND, REUSE_WORKFLOW), RUN_REUSED, true)
  writeReuseRun(runsRoot(DISPATCH_SPEND, REUSE_WORKFLOW), RUN_NOT_REUSED, false)

  const repos: Record<string, GithubRepoRead> = {
    'acme/widgets': { read_at: READ_AT, visibility: 'PUBLIC', default_branch: 'main', pushed_at: '2026-10-10T10:00:00Z', head: { sha: sha('ghhead'), committed_at: '2026-10-10T09:30:00Z' }, open_prs: 3, open_issues: 3, prs: prList('acme/widgets'), issues: issueList('acme/widgets') },
    'acme/trio': { read_at: READ_AT, visibility: 'PRIVATE', default_branch: 'main', pushed_at: '2026-10-10T10:00:00Z', head: { sha: sha('ghhead'), committed_at: '2026-10-10T09:30:00Z' }, open_prs: 2, open_issues: 3, prs: prList('acme/trio'), issues: issueList('acme/trio') },
    'acme/noorigin': { read_at: READ_AT, visibility: 'PUBLIC', default_branch: 'main', pushed_at: '2026-10-10T10:00:00Z', head: { sha: sha('ghhead'), committed_at: '2026-10-10T09:30:00Z' }, open_prs: 0, open_issues: 0, prs: [], issues: [] },
    'acme/busy': { read_at: READ_AT, visibility: 'PUBLIC', default_branch: 'main', pushed_at: '2026-10-10T10:00:00Z', head: { sha: sha('ghhead'), committed_at: '2026-10-10T09:30:00Z' }, open_prs: 0, open_issues: 0, prs: [], issues: [] },
  }
  // The run GitHub view's branch read (docs/PRD_RUN_TEAMS.md "GitHub read"): PR #43's head, an open ready PR whose one
  // check is pending. Keyed `owner/name#<branch>`; the run branch is only served for runs whose export records it.
  const branches: Record<string, FixtureBranchRead> = {
    'acme/widgets#feature/ui-polish-002': {
      read_at: READ_AT, visibility: 'PUBLIC', viewer_permission: 'WRITE', default_branch: 'main', github_sha: sha('ghbranch'),
      pr: {
        number: 43, title: 'Land the verify fix', url: 'https://github.com/acme/widgets/pull/43', state: 'OPEN', draft: false, author: 'octocat',
        head_ref: 'feature/ui-polish-002', base_ref: 'main', head_sha: sha('ghbranch'), updated_at: '2026-10-10T11:00:00Z', merged_at: null,
        review_decision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', comments: 1, review_threads: 0, unresolved_threads: 0,
        requested_reviewers: [{ kind: 'user', login: VIEWER_LOGIN }], latest_reviews: [],
        checks: { state: 'PENDING', passing: 3, failing: 0, pending: 1, skipped: 0, total: 4, items: [
          { name: 'e2e', kind: 'check_run', status: 'IN_PROGRESS', conclusion: null, bucket: 'pending', url: null },
          { name: 'build', kind: 'check_run', status: 'COMPLETED', conclusion: 'SUCCESS', bucket: 'pass', url: null },
          { name: 'lint', kind: 'check_run', status: 'COMPLETED', conclusion: 'SUCCESS', bucket: 'pass', url: null },
          { name: 'unit', kind: 'check_run', status: 'COMPLETED', conclusion: 'SUCCESS', bucket: 'pass', url: null },
        ] },
      },
      earlier_prs: [],
    },
  }
  // Trio lists its three readable workflows plus the unlistable one, whose `runs_root` is a regular file ([P34], V18).
  const trioWorkflows = [
    ...workflowsFor(DISPATCH_TRIO, ['alpha-feature', 'beta-feature', 'gamma-feature']),
    { workflow_id: DISPATCH_TRIO_LOCKED, runs_root: trioLockedRuns, definition: { name: 'Feature implementation', nodes } },
  ]
  return {
    projects: [
      { project_id: DISPATCH_LOCAL, name: 'Local only', repository: localonly, workflows: workflowsFor(DISPATCH_LOCAL, ['sync']) },
      { project_id: DISPATCH_WIDGETS, name: 'Widgets', repository: widgets, workflows: workflowsFor(DISPATCH_WIDGETS, ['ui-polish', 'broken']) },
      { project_id: DISPATCH_WIDGETS_WT, name: 'Widgets worktree', repository: worktree, workflows: workflowsFor(DISPATCH_WIDGETS_WT, ['experiment', ...M2_WORKFLOWS[DISPATCH_WIDGETS_WT]]) },
      { project_id: DISPATCH_TRIO, name: 'Trio', repository: trio, workflows: trioWorkflows },
      { project_id: DISPATCH_NOORIGIN, name: 'No origin', repository: noorigin, workflows: workflowsFor(DISPATCH_NOORIGIN, ['main', ...M2_WORKFLOWS[DISPATCH_NOORIGIN]]) },
      { project_id: DISPATCH_BUSY, name: 'Busy', repository: busy, workflows: workflowsFor(DISPATCH_BUSY, ['ship']) },
      { project_id: DISPATCH_UNREADABLE, name: 'Unreadable', repository: unreadable, workflows: workflowsFor(DISPATCH_UNREADABLE, ['x']) },
      { project_id: DISPATCH_SPEND, name: 'Spend', repository: spendRepo, workflows: workflowsFor(DISPATCH_SPEND, [SPEND_WORKFLOW, SPEND_BROKEN_WORKFLOW, REUSE_WORKFLOW]) },
    ],
    githubFixture: { viewer_login: VIEWER_LOGIN, repos, branches },
  }
}
