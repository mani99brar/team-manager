import { z } from 'zod'

// Source of truth. Exported JSON Schema is the language-neutral boundary.
const id = z.string().min(1)
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
const timestamp = z.iso.datetime()
const relativePath = z.string().min(1).regex(/^(?!\/)(?![A-Za-z]:)(?!.*\\)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/)
const status = z.enum(['pending', 'running', 'awaiting_approval', 'paused', 'succeeded', 'failed', 'cancelled'])
const envelope = { contract_version: z.literal('1.0.0'), run_id: id }

export const artifactSchema = z.strictObject({
  artifact_id: id,
  kind: z.enum(['patch', 'log', 'screenshot', 'test_report', 'other']),
  uri: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
})

export const checkSchema = z.strictObject({
  command: z.string().min(1),
  cwd: z.string().min(1),
  started_at: timestamp,
  finished_at: timestamp,
  exit_code: z.number().int(),
  log_artifact_id: id,
})

/**
 * A check the gate executed and recorded but did not gate on in the phase that served this result. A lane's
 * build and browser checks need the whole application, so on the lane's isolated worker-phase snapshot they
 * are only recorded; the combined candidate gates on them. `check_index` names the entry of `checks` that ran.
 */
export const deferredCheckSchema = z.strictObject({ id, check_index: z.number().int().nonnegative() })

export const workerResultSchema = z.strictObject({
  ...envelope,
  node_id: id,
  attempt: z.number().int().positive(),
  session_id: id,
  status: z.enum(['succeeded', 'failed', 'cancelled']),
  base_commit: sha,
  output_commit: sha.nullable(),
  changed_files: z.array(relativePath),
  checks: z.array(checkSchema),
  open_assumptions: z.array(z.string().min(1)),
  artifacts: z.array(artifactSchema),
  summary: z.string().min(1),
  error: z.strictObject({ code: id, message: z.string().min(1), retryable: z.boolean() }).nullable(),
  /** Set by the serving adapter from the packet's gate; absent from the immutable capture and when nothing was deferred. */
  deferred_checks: z.array(deferredCheckSchema).optional(),
})

export const runSpecSchema = z.strictObject({
  ...envelope,
  objective: z.string().min(1),
  repository: z.string().min(1),
  base_commit: sha,
  max_concurrent_workers: z.number().int().min(1).max(2),
  workers: z.array(z.strictObject({
    node_id: id,
    executor: id,
    task: z.string().min(1),
    worktree: z.string().min(1),
    observed_start_commit: sha,
    owned_paths: z.array(relativePath).min(1),
    acceptance_criteria: z.array(z.string().min(1)).min(1),
  })).min(1).max(2),
  usage_exhaustion: z.strictObject({
    action: z.literal('pause_for_approval'),
    alternative_plan: z.string().min(1),
  }),
})

export const runSnapshotSchema = z.strictObject({
  ...envelope,
  status,
  last_sequence: z.number().int().nonnegative(),
  nodes: z.array(z.strictObject({
    node_id: id,
    kind: z.enum(['prepare', 'worker', 'verification', 'review', 'integration']),
    depends_on: z.array(id),
    status,
    attempt: z.number().int().nonnegative(),
    session_id: id.nullable(),
    result_uri: z.string().min(1).nullable(),
    /** The combined candidate verifies every lane on one revision; each lane's result is linked here. Empty for every other node. */
    lane_results: z.array(z.strictObject({ worker: id, attempt: z.number().int().positive(), result_uri: z.string().min(1) })),
  })),
})

export const eventSchema = z.strictObject({
  ...envelope,
  event_id: id,
  sequence: z.number().int().positive(),
  occurred_at: timestamp,
  node_id: id.nullable(),
  attempt: z.number().int().nonnegative(),
  type: z.enum(['status_changed', 'log', 'artifact_published', 'result_published', 'approval_requested', 'result_reused', 'return_note']),
  status: status.nullable(),
  message: z.string(),
  artifact: artifactSchema.nullable(),
  result_uri: z.string().min(1).nullable(),
  reused_from_attempt: z.number().int().positive().nullable(),
})

export const controlRequestSchema = z.strictObject({
  ...envelope,
  request_id: id,
  expected_sequence: z.number().int().nonnegative(),
  action: z.enum(['approve', 'pause', 'resume', 'retry', 'cancel']),
  node_id: id.nullable(),
  reason: z.string().min(1),
})

export const schemas = {
  runSpec: runSpecSchema,
  workerResult: workerResultSchema,
  runSnapshot: runSnapshotSchema,
  event: eventSchema,
  controlRequest: controlRequestSchema,
}

export type RunSpec = z.infer<typeof runSpecSchema>
export type WorkerResult = z.infer<typeof workerResultSchema>
export type RunSnapshot = z.infer<typeof runSnapshotSchema>
export type WorkflowEvent = z.infer<typeof eventSchema>
export type ControlRequest = z.infer<typeof controlRequestSchema>

// Cross-field rules must also be implemented by non-TypeScript consumers.
export function validateRunSpec(input: unknown): RunSpec {
  const spec = runSpecSchema.parse(input)
  if (new Set(spec.workers.map(w => w.node_id)).size !== spec.workers.length)
    throw new Error('Worker node IDs must be unique')
  if (new Set(spec.workers.map(w => w.worktree)).size !== spec.workers.length)
    throw new Error('Workers require distinct worktrees')
  if (spec.workers.some(w => w.observed_start_commit !== spec.base_commit))
    throw new Error('Every worker must start at the exact base commit')
  return spec
}

export function validateWorkerResult(input: unknown): WorkerResult {
  const result = workerResultSchema.parse(input)
  const artifacts = new Map(result.artifacts.map(a => [a.artifact_id, a]))
  if (artifacts.size !== result.artifacts.length) throw new Error('Artifact IDs must be unique')
  for (const check of result.checks) {
    if (artifacts.get(check.log_artifact_id)?.kind !== 'log')
      throw new Error('Every executed check requires a log artifact')
    if (Date.parse(check.finished_at) < Date.parse(check.started_at))
      throw new Error('Check finish time precedes start time')
  }
  if (result.status === 'failed' && result.error === null)
    throw new Error('Failed results require an error')
  if (result.status === 'succeeded' && result.error !== null)
    throw new Error('Successful results cannot contain an error')
  if (result.status === 'succeeded' && result.output_commit === null)
    throw new Error('Successful workers require a durable output commit')
  return result
}
