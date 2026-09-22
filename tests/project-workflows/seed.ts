/**
 * Candidate-phase seeding: writes a disposable project registry and run directories in the documented
 * runtime storage format (`features/project-workflows/README.md`), so the real combined backend projects
 * the same logical runs that `mock.ts` serves in worker mode. All paths live under the temporary test root.
 *
 * Exports carry version 1.2.0 with the `review` and `inputs` sections (raw texts naming a real directory
 * under the run, so the adapter's path redaction is exercised), except the legacy run, which is written as
 * a 1.0.0 export without either section. The `lanes-flow` runs are 1.3.0 exports: their plan pins `workers`
 * and `excluded_workers`, their state keeps per-lane data under `lanes[<id>]` and `packets[<id>]`, and their
 * inputs section carries the selection and each lane's `required_check_kinds` (PRD_WORKER_LANES section 4).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ADAPTER_SESSION,
  BASE_COMMIT,
  BLOCKED_MESSAGE,
  CANDIDATE_COMMIT,
  EMPTY_PROJECT,
  EMPTY_WORKFLOW_DEFINITION,
  EMPTY_WORKFLOW_ID,
  EMPTY_WORKFLOW_NAME,
  GRAPH_NODES,
  LANE_ARTIFACTS,
  LANE_OUTPUT_COMMITS,
  LANE_SESSIONS,
  LANES_WORKFLOW_ID,
  LANES_WORKFLOW_NAME,
  ONE_LANE,
  ONE_LANE_NODES,
  OUTPUT_COMMIT_ADAPTER,
  OUTPUT_COMMIT_UI,
  PINNED_NODES,
  PROJECT,
  REVIEW_DIFF,
  RUN_AWAITING,
  RUN_BLOCKED,
  RUN_FAILED,
  RUN_LEGACY,
  RUN_ONE_LANE,
  RUN_SUCCEEDED,
  RUN_THREE_LANES,
  T0,
  T1,
  T2,
  T3,
  THREE_LANES,
  THREE_LANE_NODES,
  UI_SESSION,
  WORKFLOW_ID,
  WORKFLOW_NAME,
  adapterResult,
  adapterTask,
  backgroundId,
  docsTask,
  laneResult,
  launchToken,
  rawInputsSection,
  rawReviewSection,
  sha256,
  uiDeferredResult,
  uiResult,
  uiTask,
  type ArtifactFile,
  type RawInputsSection,
  type RawReviewSection,
} from './fixtures.ts'
import type { WorkerResult } from '../../contracts/workflow/v1.ts'

type InternalEvent = { sequence: number; time: string; node: string; status: string; message: string }
type Task = { node_id: string; error: string | null; interrupts: object[]; result: object | null }

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function receipt(node: string, runDir: string, sessionId: string, requestedAt: string) {
  return {
    node_id: node, session_id: sessionId, launch_token: launchToken(node),
    plan_digest: 'd'.repeat(64), worktree: join(runDir, `worktree-${node}`), base_commit: BASE_COMMIT,
    status: 'attached_session_available', attempt: 1, launcher_invocations: 1, launch_requested_at: requestedAt,
    background_id: backgroundId(node), observed_state: 'done', native_started_at: Date.parse(requestedAt),
  }
}

/** One verification packet in the `workflow/checks.py` layout; returns its registry entry. */
function writePacket(runDir: string, phase: 'worker' | 'candidate', node: string, attempt: number, result: WorkerResult, files: ArtifactFile[], gate: { status: string; reasons: string[]; deferred_checks?: string[] }) {
  const directory = join(runDir, 'verification', phase, node, String(attempt))
  const artifactsDir = join(directory, 'artifacts')
  mkdirSync(artifactsDir, { recursive: true })
  const artifactPaths: Record<string, string> = {}
  for (const file of files) {
    const destination = join(artifactsDir, file.artifact_id)
    writeFileSync(destination, file.content)
    artifactPaths[file.artifact_id] = destination
  }
  const worktree = join(directory, 'worktree')
  const expected = { run_id: result.run_id, node_id: node, attempt, base_commit: BASE_COMMIT, output_commit: result.output_commit ?? BASE_COMMIT, verification_cwd: worktree }
  // The immutable capture never carries `deferred_checks`; the adapter derives them from the gate when serving.
  const capture: Omit<WorkerResult, 'deferred_checks'> & { deferred_checks?: unknown } = { ...result }
  delete capture.deferred_checks
  const packet = {
    phase, expected,
    result: { ...capture, checks: capture.checks.map(check => ({ ...check, cwd: worktree })) },
    evidence: {
      version: '1.0.0', policy_sha256: 'e'.repeat(64), run_id: result.run_id, node_id: node, attempt, output_commit: expected.output_commit,
      checks: result.checks.map((_check, index) => ({ id: `check-${index}`, worker_check_index: index, tests: null, scenarios: [] })),
    },
    artifact_root: artifactsDir, artifact_paths: artifactPaths,
    capture_errors: gate.reasons, effective_commands: result.checks.map(check => check.command.split(' ')), gate,
  }
  const packetPath = join(directory, 'packet.json')
  writeJson(packetPath, packet)
  const relative = `verification/${phase}/${node}/${attempt}/packet.json`
  return { phase, node_id: node, attempt, path: relative, sha256: sha256(Buffer.from(`${JSON.stringify(packet, null, 2)}\n`)) }
}

type RunOptions = {
  createdAt: string; updatedAt: string; definitionNodes: typeof GRAPH_NODES; values: Record<string, unknown>; next: string[]; tasks: Task[]; events: InternalEvent[]
  packets: (runDir: string) => object[]
  /** Export version; 1.2.0 (the default) carries the `review` and `inputs` sections, 1.0.0 neither, 1.3.0 also pins the lane selection. */
  version?: '1.0.0' | '1.2.0' | '1.3.0'
  /** The selected lanes the plan pins (`plan.nodes`, and `plan.workers` from 1.3.0); the two-lane runs predate the selection. */
  lanes?: readonly string[]
  /** The pinned definition's name (the registered workflow's name, so an unchanged graph hashes to the current revision). */
  definitionName?: string
  review?: RawReviewSection | null
  inputs?: RawInputsSection | null
  /** Content of `<run>/review.diff`, the diff the reviewer saw. */
  diff?: string
}

function writeRun(runsRoot: string, repository: string, runId: string, options: RunOptions) {
  const runDir = join(runsRoot, runId)
  mkdirSync(runDir, { recursive: true })
  const inputs = options.inputs ?? null
  const version = options.version ?? '1.2.0'
  const lanes = options.lanes ?? ['ui', 'adapter']
  const pinnedTask = (lane: string) => inputs?.workers[lane]?.task ?? (lane === 'ui' ? uiTask(leakFor(runsRoot, runId)) : lane === 'adapter' ? adapterTask() : docsTask())
  const plan = {
    run_id: runId, repository, base_commit: BASE_COMMIT, allow_edits: true,
    nodes: Object.fromEntries(lanes.map(lane => [lane, { worktree: join(runDir, `worktree-${lane}`), task: pinnedTask(lane), session_id: LANE_SESSIONS[lane], observed_start_commit: BASE_COMMIT }])),
    ...(version === '1.3.0' ? { workers: [...lanes], excluded_workers: inputs?.excluded_workers ?? [] } : {}),
    mode: 'live', policy_sha256: 'e'.repeat(64), created_at: options.createdAt, source_branch: inputs?.source_branch ?? 'feature/synthetic',
    ...(inputs === null || inputs.automatic !== null ? { automatic: inputs?.automatic ?? { worker_timeout_seconds: 14400, review_timeout_seconds: 1800 } } : {}),
  }
  writeJson(join(runDir, 'plan.json'), plan)
  writeFileSync(join(runDir, 'events.jsonl'), options.events.map(event => JSON.stringify(event)).join('\n') + '\n')
  if (options.diff !== undefined) writeFileSync(join(runDir, 'review.diff'), options.diff)
  const packets = options.packets(runDir)
  const state = {
    version, run_id: runId, base_commit: BASE_COMMIT, created_at: options.createdAt,
    definition: { name: options.definitionName ?? WORKFLOW_NAME, nodes: options.definitionNodes },
    values: { run_id: runId, ...options.values }, next: options.next, tasks: options.tasks, events: options.events,
    verification_packets: packets, updated_at: options.updatedAt,
    ...(version !== '1.0.0' ? { review: options.review ?? null, inputs } : {}),
  }
  writeJson(join(runDir, 'run-state.json'), state)
  return runDir
}

/** A real absolute path under the run directory that the raw seeded texts name; the adapter must redact it. */
function leakFor(runsRoot: string, runId: string): string {
  return join(runsRoot, runId, 'worktree-ui', 'test-results')
}

const internalEvent = (sequence: number, time: string, node: string, status: string, message: string): InternalEvent => ({ sequence, time, node, status, message })

/** Seeds registry + runs under `root`; returns the registry path for MD_MANAGER_PROJECTS_CONFIG. */
export function seedCandidate(root: string): string {
  const repository = join(root, 'repository')
  const runsRoot = join(root, 'runs', WORKFLOW_ID)
  const emptyRunsRoot = join(root, 'runs', EMPTY_WORKFLOW_ID)
  const lanesRunsRoot = join(root, 'runs', LANES_WORKFLOW_ID)
  mkdirSync(repository, { recursive: true })
  mkdirSync(runsRoot, { recursive: true })
  mkdirSync(emptyRunsRoot, { recursive: true })
  mkdirSync(lanesRunsRoot, { recursive: true })

  const packetSet = (runDir: string, phases: { phase: 'worker' | 'candidate'; node: string; attempt: number; result: WorkerResult; blocked?: string }[]) =>
    phases.map(entry => writePacket(runDir, entry.phase, entry.node, entry.attempt, entry.result, LANE_ARTIFACTS[entry.node],
      entry.blocked ? { status: 'blocked', reasons: [entry.blocked] }
        // Seeded evidence receipts are `check-<index>`, so a deferred check is named by its executed index.
        : { status: 'passed', reasons: [], ...(entry.result.deferred_checks ? { deferred_checks: entry.result.deferred_checks.map(check => `check-${check.check_index}`) } : {}) }))
  const fullPackets = (runId: string, runDir: string) => packetSet(runDir, [
    { phase: 'worker', node: 'ui', attempt: 1, result: uiResult(runId) },
    { phase: 'worker', node: 'adapter', attempt: 1, result: adapterResult(runId, false) },
    { phase: 'candidate', node: 'ui', attempt: 1, result: uiResult(runId) },
    { phase: 'candidate', node: 'adapter', attempt: 1, result: adapterResult(runId, false) },
  ])
  const reviewedValues = (runId: string, requestedAt: string) => ({
    ui: receipt('ui', join(runsRoot, runId), UI_SESSION, requestedAt), adapter: receipt('adapter', join(runsRoot, runId), ADAPTER_SESSION, requestedAt),
    snapshots: { ui: OUTPUT_COMMIT_UI, adapter: OUTPUT_COMMIT_ADAPTER },
    ui_packet: 'verification/worker/ui/1/packet.json', adapter_packet: 'verification/worker/adapter/1/packet.json',
    bundle: { run_id: runId, base_commit: BASE_COMMIT, candidate_commit: CANDIDATE_COMMIT, policy_sha256: 'e'.repeat(64) },
  })
  const launchEvents = (time: string) => [
    internalEvent(1, time, 'ui', 'running', 'Launching or reconciling the exact native session'),
    internalEvent(2, time, 'adapter', 'running', 'Launching or reconciling the exact native session'),
  ]

  writeRun(runsRoot, repository, RUN_SUCCEEDED, {
    createdAt: T0, updatedAt: T3, definitionNodes: PINNED_NODES,
    values: {
      ...reviewedValues(RUN_SUCCEEDED, T0),
      review: { run_id: RUN_SUCCEEDED, verdict: 'approved', independent: true, reviewer: 'synthetic-reviewer', findings: [] },
      approved_bundle: 'f'.repeat(64), integrated_commit: CANDIDATE_COMMIT,
    },
    next: [], tasks: [],
    events: [
      ...launchEvents(T0),
      internalEvent(3, T1, 'freeze', 'succeeded', 'Captured both worker snapshots'),
      internalEvent(4, T2, 'verify_ui', 'succeeded', 'UI verification passed'),
      internalEvent(5, T2, 'verify_adapter', 'succeeded', 'Adapter verification passed'),
      internalEvent(6, T3, 'review', 'approved', 'Independent reviewer approved the candidate'),
      internalEvent(7, T3, 'integrate', 'succeeded', 'Fast-forwarded the feature branch'),
    ],
    packets: runDir => fullPackets(RUN_SUCCEEDED, runDir),
    review: rawReviewSection(RUN_SUCCEEDED, leakFor(runsRoot, RUN_SUCCEEDED)),
    inputs: rawInputsSection(RUN_SUCCEEDED, leakFor(runsRoot, RUN_SUCCEEDED)),
    diff: REVIEW_DIFF,
  })

  writeRun(runsRoot, repository, RUN_FAILED, {
    createdAt: T1, updatedAt: T2, definitionNodes: GRAPH_NODES,
    values: {
      ui: receipt('ui', join(runsRoot, RUN_FAILED), UI_SESSION, T1), adapter: receipt('adapter', join(runsRoot, RUN_FAILED), ADAPTER_SESSION, T1),
      snapshots: { ui: OUTPUT_COMMIT_UI, adapter: OUTPUT_COMMIT_ADAPTER },
      ui_packet: 'verification/worker/ui/1/packet.json',
    },
    next: ['verify_adapter'],
    tasks: [{ node_id: 'verify_adapter', error: 'Injected gate failure: adapter verification attempt 1 was blocked by the configured failure drill', interrupts: [], result: null }],
    events: [
      ...launchEvents(T1),
      internalEvent(3, T2, 'freeze', 'succeeded', 'Captured both worker snapshots'),
      internalEvent(4, T2, 'verify_ui', 'succeeded', 'UI verification passed'),
      internalEvent(5, T2, 'verify_adapter', 'failed', 'Injected gate failure (failure drill); checks preserved'),
    ],
    packets: runDir => packetSet(runDir, [
      { phase: 'worker', node: 'ui', attempt: 1, result: uiResult(RUN_FAILED) },
      { phase: 'worker', node: 'adapter', attempt: 1, result: adapterResult(RUN_FAILED, true), blocked: 'Injected gate failure (failure drill)' },
    ]),
    review: null,
    inputs: rawInputsSection(RUN_FAILED, leakFor(runsRoot, RUN_FAILED)),
  })

  writeRun(runsRoot, repository, RUN_AWAITING, {
    createdAt: T2, updatedAt: T3, definitionNodes: GRAPH_NODES,
    values: reviewedValues(RUN_AWAITING, T2),
    next: ['review'],
    tasks: [{ node_id: 'review', error: null, interrupts: [{ kind: 'independent_review', message: 'Independent review required before integration' }], result: null }],
    events: [
      ...launchEvents(T2),
      internalEvent(3, T3, 'freeze', 'succeeded', 'Captured both worker snapshots'),
      internalEvent(4, T3, 'candidate', 'succeeded', 'Combined candidate checks passed'),
      internalEvent(5, T3, 'review', 'awaiting_approval', 'Independent review required before integration'),
    ],
    packets: runDir => fullPackets(RUN_AWAITING, runDir),
    review: null,
    inputs: rawInputsSection(RUN_AWAITING, leakFor(runsRoot, RUN_AWAITING)),
  })

  // The print-mode reviewer blocked this candidate: review.json holds the verdict, the graph task the error.
  writeRun(runsRoot, repository, RUN_BLOCKED, {
    createdAt: T1, updatedAt: T3, definitionNodes: GRAPH_NODES,
    values: reviewedValues(RUN_BLOCKED, T1),
    next: [],
    tasks: [{ node_id: 'review', error: `${BLOCKED_MESSAGE}; see ${join(runsRoot, RUN_BLOCKED, 'review.json')}`, interrupts: [], result: null }],
    events: [
      ...launchEvents(T1),
      internalEvent(3, T2, 'freeze', 'succeeded', 'Captured both worker snapshots'),
      internalEvent(4, T2, 'verify_ui', 'succeeded', 'UI verification passed'),
      internalEvent(5, T2, 'verify_adapter', 'succeeded', 'Adapter verification passed'),
      internalEvent(6, T2, 'candidate', 'succeeded', 'Combined candidate checks passed'),
      internalEvent(7, T3, 'review', 'running', 'Launching the print-mode reviewer'),
      internalEvent(8, T3, 'review', 'blocked', BLOCKED_MESSAGE),
    ],
    packets: runDir => packetSet(runDir, [
      { phase: 'worker', node: 'ui', attempt: 1, result: uiDeferredResult(RUN_BLOCKED) },
      { phase: 'worker', node: 'adapter', attempt: 1, result: adapterResult(RUN_BLOCKED, false) },
      { phase: 'candidate', node: 'ui', attempt: 1, result: uiResult(RUN_BLOCKED) },
      { phase: 'candidate', node: 'adapter', attempt: 1, result: adapterResult(RUN_BLOCKED, false) },
    ]),
    review: rawReviewSection(RUN_BLOCKED, leakFor(runsRoot, RUN_BLOCKED)),
    inputs: rawInputsSection(RUN_BLOCKED, leakFor(runsRoot, RUN_BLOCKED)),
  })

  // Integrated before review results and run inputs were exported: a 1.0.0 export whose `values.review` is never mined.
  writeRun(runsRoot, repository, RUN_LEGACY, {
    createdAt: T0, updatedAt: T2, definitionNodes: GRAPH_NODES,
    values: {
      ...reviewedValues(RUN_LEGACY, T0),
      review: { run_id: RUN_LEGACY, verdict: 'approved', independent: true, reviewer: 'synthetic-reviewer', findings: [] },
      approved_bundle: 'f'.repeat(64), integrated_commit: CANDIDATE_COMMIT,
    },
    next: [], tasks: [],
    events: [
      ...launchEvents(T0),
      internalEvent(3, T1, 'freeze', 'succeeded', 'Captured both worker snapshots'),
      internalEvent(4, T1, 'verify_ui', 'succeeded', 'UI verification passed'),
      internalEvent(5, T1, 'verify_adapter', 'succeeded', 'Adapter verification passed'),
      internalEvent(6, T2, 'review', 'approved', 'Review accepted (recorded before review results were exported)'),
      internalEvent(7, T2, 'integrate', 'succeeded', 'Fast-forwarded the feature branch'),
    ],
    packets: runDir => fullPackets(RUN_LEGACY, runDir),
    version: '1.0.0',
  })

  // ---- lanes-flow: 1.3.0 exports of runs whose lanes come from configuration (`ui`, `adapter`, `docs`) ----

  /** Per-lane state as the plan-driven pipeline keeps it: receipts under `lanes`, packet paths under `packets`. */
  const laneValues = (runId: string, lanes: readonly string[], requestedAt: string) => ({
    lanes: Object.fromEntries(lanes.map(lane => [lane, receipt(lane, join(lanesRunsRoot, runId), LANE_SESSIONS[lane], requestedAt)])),
    snapshots: Object.fromEntries(lanes.map(lane => [lane, LANE_OUTPUT_COMMITS[lane]])),
    packets: Object.fromEntries(lanes.map(lane => [lane, `verification/worker/${lane}/1/packet.json`])),
    bundle: { run_id: runId, base_commit: BASE_COMMIT, candidate_commit: CANDIDATE_COMMIT, policy_sha256: 'e'.repeat(64) },
    review: { run_id: runId, verdict: 'approved', independent: true, reviewer: 'synthetic-reviewer', findings: [] },
    approved_bundle: 'f'.repeat(64), integrated_commit: CANDIDATE_COMMIT,
  })
  const lanePackets = (runId: string, runDir: string, lanes: readonly string[]) => packetSet(runDir, lanes.flatMap(lane => [
    { phase: 'worker' as const, node: lane, attempt: 1, result: laneResult(lane, runId) },
    { phase: 'candidate' as const, node: lane, attempt: 1, result: laneResult(lane, runId) },
  ]))
  const laneEvents = (lanes: readonly string[], start: string, extra: InternalEvent[] = []): InternalEvent[] => {
    const events: InternalEvent[] = []
    const push = (time: string, node: string, status: string, message: string) => events.push(internalEvent(events.length + 1, time, node, status, message))
    for (const lane of lanes) push(start, lane, 'running', 'Launching or reconciling the exact native session')
    for (const event of extra) push(event.time, event.node, event.status, event.message)
    push(T2, 'freeze', 'succeeded', `Captured ${lanes.length === 1 ? 'the' : 'every'} worker snapshot`)
    for (const lane of lanes) push(T2, `verify_${lane}`, 'succeeded', `${lane} verification passed`)
    push(T2, 'candidate', 'succeeded', 'Combined candidate checks passed')
    push(T3, 'review', 'approved', 'Independent reviewer approved the candidate')
    push(T3, 'integrate', 'succeeded', 'Fast-forwarded the feature branch')
    return events
  }

  writeRun(lanesRunsRoot, repository, RUN_THREE_LANES, {
    createdAt: T1, updatedAt: T3, definitionNodes: THREE_LANE_NODES, definitionName: LANES_WORKFLOW_NAME, version: '1.3.0', lanes: THREE_LANES,
    values: laneValues(RUN_THREE_LANES, THREE_LANES, T1),
    next: [], tasks: [],
    events: laneEvents(THREE_LANES, T1),
    packets: runDir => lanePackets(RUN_THREE_LANES, runDir, THREE_LANES),
    review: rawReviewSection(RUN_THREE_LANES, leakFor(lanesRunsRoot, RUN_THREE_LANES)),
    inputs: rawInputsSection(RUN_THREE_LANES, leakFor(lanesRunsRoot, RUN_THREE_LANES)),
  })

  // Launched with `--workers docs`: the plan pins one lane and excludes the other two; the drill's lane was not selected.
  writeRun(lanesRunsRoot, repository, RUN_ONE_LANE, {
    createdAt: T2, updatedAt: T3, definitionNodes: ONE_LANE_NODES, definitionName: LANES_WORKFLOW_NAME, version: '1.3.0', lanes: ONE_LANE,
    values: laneValues(RUN_ONE_LANE, ONE_LANE, T2),
    next: [], tasks: [],
    events: laneEvents(ONE_LANE, T2, [internalEvent(0, T2, 'failure_drill', 'skipped', 'Failure drill skipped: its lane adapter was not selected')]),
    packets: runDir => lanePackets(RUN_ONE_LANE, runDir, ONE_LANE),
    review: rawReviewSection(RUN_ONE_LANE, leakFor(lanesRunsRoot, RUN_ONE_LANE)),
    inputs: rawInputsSection(RUN_ONE_LANE, leakFor(lanesRunsRoot, RUN_ONE_LANE)),
  })

  const registry = {
    version: 1,
    projects: [
      {
        project_id: PROJECT.project_id, name: PROJECT.name, repository,
        workflows: [
          { workflow_id: WORKFLOW_ID, runs_root: runsRoot, definition: { name: WORKFLOW_NAME, nodes: GRAPH_NODES } },
          { workflow_id: EMPTY_WORKFLOW_ID, runs_root: emptyRunsRoot, definition: { name: EMPTY_WORKFLOW_NAME, nodes: EMPTY_WORKFLOW_DEFINITION.nodes } },
          { workflow_id: LANES_WORKFLOW_ID, runs_root: lanesRunsRoot, definition: { name: LANES_WORKFLOW_NAME, nodes: THREE_LANE_NODES } },
        ],
      },
      { project_id: EMPTY_PROJECT.project_id, name: EMPTY_PROJECT.name, repository, workflows: [] },
    ],
  }
  const configPath = join(root, 'projects.json')
  writeJson(configPath, registry)
  return configPath
}
