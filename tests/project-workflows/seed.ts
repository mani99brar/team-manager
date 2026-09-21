/**
 * Candidate-phase seeding: writes a disposable project registry and run directories in the documented
 * runtime storage format (`features/project-workflows/README.md`), so the real combined backend projects
 * the same logical runs that `mock.ts` serves in worker mode. All paths live under the temporary test root.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ADAPTER_ARTIFACTS,
  ADAPTER_SESSION,
  BASE_COMMIT,
  EMPTY_PROJECT,
  EMPTY_WORKFLOW_DEFINITION,
  EMPTY_WORKFLOW_ID,
  EMPTY_WORKFLOW_NAME,
  GRAPH_NODES,
  OUTPUT_COMMIT_ADAPTER,
  OUTPUT_COMMIT_UI,
  PINNED_NODES,
  PROJECT,
  RUN_AWAITING,
  RUN_FAILED,
  RUN_SUCCEEDED,
  T0,
  T1,
  T2,
  T3,
  UI_ARTIFACTS,
  UI_SESSION,
  WORKFLOW_ID,
  WORKFLOW_NAME,
  adapterResult,
  sha256,
  uiResult,
  type ArtifactFile,
} from './fixtures.ts'
import type { WorkerResult } from '../../contracts/workflow/v1.ts'

type InternalEvent = { sequence: number; time: string; node: string; status: string; message: string }
type Task = { node_id: string; error: string | null; interrupts: object[]; result: object | null }

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function receipt(node: 'ui' | 'adapter', runDir: string, sessionId: string, requestedAt: string) {
  return {
    node_id: node, session_id: sessionId, launch_token: `00000000-0000-4000-8000-00000000000${node === 'ui' ? 1 : 2}`,
    plan_digest: 'd'.repeat(64), worktree: join(runDir, `worktree-${node}`), base_commit: BASE_COMMIT,
    status: 'attached_session_available', attempt: 1, launcher_invocations: 1, launch_requested_at: requestedAt,
    background_id: node === 'ui' ? '10001' : '10002', observed_state: 'done', native_started_at: Date.parse(requestedAt),
  }
}

/** One verification packet in the `workflow/checks.py` layout; returns its registry entry. */
function writePacket(runDir: string, phase: 'worker' | 'candidate', node: 'ui' | 'adapter', attempt: number, result: WorkerResult, files: ArtifactFile[], gate: { status: string; reasons: string[] }) {
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
  const packet = {
    phase, expected,
    result: { ...result, checks: result.checks.map(check => ({ ...check, cwd: worktree })) },
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

function writeRun(runsRoot: string, repository: string, runId: string, options: {
  createdAt: string; updatedAt: string; definitionNodes: typeof GRAPH_NODES; values: Record<string, unknown>; next: string[]; tasks: Task[]; events: InternalEvent[]
  packets: (runDir: string) => object[]
}) {
  const runDir = join(runsRoot, runId)
  mkdirSync(runDir, { recursive: true })
  const plan = {
    run_id: runId, repository, base_commit: BASE_COMMIT, allow_edits: true,
    nodes: {
      ui: { worktree: join(runDir, 'worktree-ui'), task: 'UI task (synthetic)', session_id: UI_SESSION, observed_start_commit: BASE_COMMIT },
      adapter: { worktree: join(runDir, 'worktree-adapter'), task: 'Adapter task (synthetic)', session_id: ADAPTER_SESSION, observed_start_commit: BASE_COMMIT },
    },
    mode: 'live', policy_sha256: 'e'.repeat(64), created_at: options.createdAt, source_branch: 'feature/synthetic',
    automatic: { worker_timeout_seconds: 14400, review_timeout_seconds: 1800 },
  }
  writeJson(join(runDir, 'plan.json'), plan)
  writeFileSync(join(runDir, 'events.jsonl'), options.events.map(event => JSON.stringify(event)).join('\n') + '\n')
  const packets = options.packets(runDir)
  const state = {
    version: '1.0.0', run_id: runId, base_commit: BASE_COMMIT, created_at: options.createdAt,
    definition: { name: WORKFLOW_NAME, nodes: options.definitionNodes },
    values: { run_id: runId, ...options.values }, next: options.next, tasks: options.tasks, events: options.events,
    verification_packets: packets, updated_at: options.updatedAt,
  }
  writeJson(join(runDir, 'run-state.json'), state)
  return runDir
}

const internalEvent = (sequence: number, time: string, node: string, status: string, message: string): InternalEvent => ({ sequence, time, node, status, message })

/** Seeds registry + runs under `root`; returns the registry path for MD_MANAGER_PROJECTS_CONFIG. */
export function seedCandidate(root: string): string {
  const repository = join(root, 'repository')
  const runsRoot = join(root, 'runs', WORKFLOW_ID)
  const emptyRunsRoot = join(root, 'runs', EMPTY_WORKFLOW_ID)
  mkdirSync(repository, { recursive: true })
  mkdirSync(runsRoot, { recursive: true })
  mkdirSync(emptyRunsRoot, { recursive: true })

  const packetSet = (runDir: string, phases: { phase: 'worker' | 'candidate'; node: 'ui' | 'adapter'; attempt: number; result: WorkerResult; blocked?: string }[]) =>
    phases.map(entry => writePacket(runDir, entry.phase, entry.node, entry.attempt, entry.result, entry.node === 'ui' ? UI_ARTIFACTS : ADAPTER_ARTIFACTS,
      entry.blocked ? { status: 'blocked', reasons: [entry.blocked] } : { status: 'passed', reasons: [] }))

  writeRun(runsRoot, repository, RUN_SUCCEEDED, {
    createdAt: T0, updatedAt: T3, definitionNodes: PINNED_NODES,
    values: {
      ui: receipt('ui', join(runsRoot, RUN_SUCCEEDED), UI_SESSION, T0), adapter: receipt('adapter', join(runsRoot, RUN_SUCCEEDED), ADAPTER_SESSION, T0),
      snapshots: { ui: OUTPUT_COMMIT_UI, adapter: OUTPUT_COMMIT_ADAPTER },
      ui_packet: 'verification/worker/ui/1/packet.json', adapter_packet: 'verification/worker/adapter/1/packet.json',
      bundle: { run_id: RUN_SUCCEEDED, base_commit: BASE_COMMIT, candidate_commit: 'c'.repeat(40), policy_sha256: 'e'.repeat(64) },
      review: { run_id: RUN_SUCCEEDED, verdict: 'approved', independent: true, reviewer: 'synthetic-reviewer', findings: [] },
      approved_bundle: 'f'.repeat(64), integrated_commit: 'c'.repeat(40),
    },
    next: [], tasks: [],
    events: [
      internalEvent(1, T0, 'ui', 'running', 'Launching or reconciling the exact native session'),
      internalEvent(2, T0, 'adapter', 'running', 'Launching or reconciling the exact native session'),
      internalEvent(3, T1, 'freeze', 'succeeded', 'Captured both worker snapshots'),
      internalEvent(4, T2, 'verify_ui', 'succeeded', 'UI verification passed'),
      internalEvent(5, T2, 'verify_adapter', 'succeeded', 'Adapter verification passed'),
      internalEvent(6, T3, 'integrate', 'succeeded', 'Fast-forwarded the feature branch'),
    ],
    packets: runDir => packetSet(runDir, [
      { phase: 'worker', node: 'ui', attempt: 1, result: uiResult(RUN_SUCCEEDED) },
      { phase: 'worker', node: 'adapter', attempt: 1, result: adapterResult(RUN_SUCCEEDED, false) },
      { phase: 'candidate', node: 'ui', attempt: 1, result: uiResult(RUN_SUCCEEDED) },
      { phase: 'candidate', node: 'adapter', attempt: 1, result: adapterResult(RUN_SUCCEEDED, false) },
    ]),
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
      internalEvent(1, T1, 'ui', 'running', 'Launching or reconciling the exact native session'),
      internalEvent(2, T1, 'adapter', 'running', 'Launching or reconciling the exact native session'),
      internalEvent(3, T2, 'freeze', 'succeeded', 'Captured both worker snapshots'),
      internalEvent(4, T2, 'verify_ui', 'succeeded', 'UI verification passed'),
      internalEvent(5, T2, 'verify_adapter', 'failed', 'Injected gate failure (failure drill); checks preserved'),
    ],
    packets: runDir => packetSet(runDir, [
      { phase: 'worker', node: 'ui', attempt: 1, result: uiResult(RUN_FAILED) },
      { phase: 'worker', node: 'adapter', attempt: 1, result: adapterResult(RUN_FAILED, true), blocked: 'Injected gate failure (failure drill)' },
    ]),
  })

  writeRun(runsRoot, repository, RUN_AWAITING, {
    createdAt: T2, updatedAt: T3, definitionNodes: GRAPH_NODES,
    values: {
      ui: receipt('ui', join(runsRoot, RUN_AWAITING), UI_SESSION, T2), adapter: receipt('adapter', join(runsRoot, RUN_AWAITING), ADAPTER_SESSION, T2),
      snapshots: { ui: OUTPUT_COMMIT_UI, adapter: OUTPUT_COMMIT_ADAPTER },
      ui_packet: 'verification/worker/ui/1/packet.json', adapter_packet: 'verification/worker/adapter/1/packet.json',
      bundle: { run_id: RUN_AWAITING, base_commit: BASE_COMMIT, candidate_commit: 'c'.repeat(40), policy_sha256: 'e'.repeat(64) },
    },
    next: ['review'],
    tasks: [{ node_id: 'review', error: null, interrupts: [{ kind: 'independent_review', message: 'Independent review required before integration' }], result: null }],
    events: [
      internalEvent(1, T2, 'ui', 'running', 'Launching or reconciling the exact native session'),
      internalEvent(2, T2, 'adapter', 'running', 'Launching or reconciling the exact native session'),
      internalEvent(3, T3, 'freeze', 'succeeded', 'Captured both worker snapshots'),
      internalEvent(4, T3, 'candidate', 'succeeded', 'Combined candidate checks passed'),
      internalEvent(5, T3, 'review', 'awaiting_approval', 'Independent review required before integration'),
    ],
    packets: runDir => packetSet(runDir, [
      { phase: 'worker', node: 'ui', attempt: 1, result: uiResult(RUN_AWAITING) },
      { phase: 'worker', node: 'adapter', attempt: 1, result: adapterResult(RUN_AWAITING, false) },
      { phase: 'candidate', node: 'ui', attempt: 1, result: uiResult(RUN_AWAITING) },
      { phase: 'candidate', node: 'adapter', attempt: 1, result: adapterResult(RUN_AWAITING, false) },
    ]),
  })

  const registry = {
    version: 1,
    projects: [
      {
        project_id: PROJECT.project_id, name: PROJECT.name, repository,
        workflows: [
          { workflow_id: WORKFLOW_ID, runs_root: runsRoot, definition: { name: WORKFLOW_NAME, nodes: GRAPH_NODES } },
          { workflow_id: EMPTY_WORKFLOW_ID, runs_root: emptyRunsRoot, definition: { name: EMPTY_WORKFLOW_NAME, nodes: EMPTY_WORKFLOW_DEFINITION.nodes } },
        ],
      },
      { project_id: EMPTY_PROJECT.project_id, name: EMPTY_PROJECT.name, repository, workflows: [] },
    ],
  }
  const configPath = join(root, 'projects.json')
  writeJson(configPath, registry)
  return configPath
}
