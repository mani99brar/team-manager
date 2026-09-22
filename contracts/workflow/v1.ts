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

/** Finding fields shared by the reviewer's completion file and the persisted review record. */
export const reviewFindingSchema = z.strictObject({
  severity: z.enum(['P0', 'P1', 'P2']),
  message: z.string().min(1),
  disposition: z.enum(['open', 'resolved', 'accepted']),
  // Which worker's assignment the finding concerns, so a viewer can link it to that worker's task.
  worker: z.enum(['ui', 'adapter', 'both', 'none']),
  // A verbatim quote from that worker's task text, or null when the finding is not about a stated requirement.
  requirement: z.string().min(1).nullable(),
})

/**
 * Written once by the native reviewer session to `<run>/review.completion.json`. The controller accepts it
 * only when it validates, binds to the exact bundle/candidate under review and names the reviewer session
 * that the controller launched. The verdict lives only in this file; the transcript is the record.
 */
export const reviewCompletionSchema = z.strictObject({
  version: z.literal('1.0.0'),
  run_id: id,
  node_id: z.literal('review'),
  bundle_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  candidate_commit: sha,
  reviewer_session: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
  verdict: z.enum(['approved', 'blocked']),
  findings: z.array(reviewFindingSchema),
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
  reviewCompletion: reviewCompletionSchema,
}

export type RunSpec = z.infer<typeof runSpecSchema>
export type WorkerResult = z.infer<typeof workerResultSchema>
export type RunSnapshot = z.infer<typeof runSnapshotSchema>
export type WorkflowEvent = z.infer<typeof eventSchema>
export type ControlRequest = z.infer<typeof controlRequestSchema>
export type ReviewFinding = z.infer<typeof reviewFindingSchema>
export type ReviewCompletion = z.infer<typeof reviewCompletionSchema>

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

export function validateReviewCompletion(input: unknown): ReviewCompletion {
  const completion = reviewCompletionSchema.parse(input)
  if (completion.verdict === 'approved' && completion.findings.some(f => (f.severity === 'P0' || f.severity === 'P1') && f.disposition !== 'resolved'))
    throw new Error('An approved verdict cannot carry an unresolved P0/P1 finding')
  return completion
}
