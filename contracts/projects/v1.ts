import { z } from 'zod'
import { artifactSchema, runSnapshotSchema } from '../workflow/v1.js'

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
// Payload versions are per message. Unchanged messages keep 1.0.0; `reviewResult` was added in 1.1.0 and
// `runInputs` in 1.2.0. Consumers accept exactly the version each message declares here.
const version = z.literal('1.0.0')
const revision = z.string().regex(/^[a-f0-9]{64}$/)
const sha = z.string().regex(/^[a-f0-9]{40}$/)
const timestamp = z.iso.datetime()
const relativePath = z.string().min(1).regex(/^(?!\/)(?![A-Za-z]:)(?!.*\\)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/)
const scope = { project_id: id, workflow_id: id }

export const projectSchema = z.strictObject({
  project_id: id,
  name: z.string().min(1),
})

export const definitionSchema = z.strictObject({
  contract_version: version,
  ...scope,
  name: z.string().min(1),
  definition_revision: revision,
  nodes: z.array(z.strictObject({
    node_id: id,
    label: z.string().min(1),
    kind: z.enum(['prepare', 'worker', 'verification', 'review', 'integration']),
    depends_on: z.array(id),
  })).min(1),
})

export const runSummarySchema = z.strictObject({
  contract_version: version,
  ...scope,
  definition_revision: revision,
  run_id: id,
  status: runSnapshotSchema.shape.status,
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
})

export const runDetailSchema = z.strictObject({
  summary: runSummarySchema,
  definition: definitionSchema,
  snapshot: runSnapshotSchema,
})

/**
 * One recorded independent review of a run's candidate (contract 1.1.0). Served at
 * `.../runs/{run_id}/reviews/{attempt}`; the review node's `result_uri` points here and its `session_id`
 * is `reviewer_session`. Findings carry the reviewer's `worker`/`requirement` link fields when the review
 * was recorded with them (slice A reviewers onward); older reviews serve `null` for both.
 */
export const reviewFindingSchema = z.strictObject({
  severity: z.enum(['P0', 'P1', 'P2']),
  message: z.string().min(1),
  disposition: z.enum(['open', 'resolved', 'accepted']),
  worker: z.enum(['ui', 'adapter', 'both', 'none']).nullable(),
  requirement: z.string().min(1).nullable(),
  // 1.2.0: whether `requirement` was found verbatim in that worker's task text. Absent or null when the
  // adapter did not look it up (a null `requirement` or `worker` never matches); never a fuzzy guess.
  requirement_verbatim: z.boolean().nullable().optional(),
})

export const reviewResultSchema = z.strictObject({
  contract_version: z.literal('1.1.0'),
  run_id: id,
  node_id: z.literal('review'),
  attempt: z.number().int().positive(),
  reviewer_session: z.string().min(1),
  independent: z.boolean(),
  transport: z.enum(['native', 'print', 'manual']),
  bundle_sha256: revision,
  candidate_commit: sha,
  verdict: z.enum(['approved', 'blocked']),
  findings: z.array(reviewFindingSchema),
  reviewed_at: timestamp,
  diff_artifact: artifactSchema.nullable(),
})

/**
 * What a run and its workers were given (contract 1.2.0), pinned from the run's own files. Served at
 * `.../runs/{run_id}/inputs`; `null` at that route means the run's export has no `inputs` section.
 */
export const workerInputsSchema = z.strictObject({
  node_id: id,
  role: z.string().min(1),
  // The assignment text exactly as prepared for the worker, including the appended policy JSON block.
  task: z.string().min(1),
  task_truncated: z.boolean(),
  owned_paths: z.array(relativePath).min(1),
  checks: z.array(z.strictObject({
    id: id,
    kind: z.enum(['build', 'unit', 'browser', 'contract']),
    command: z.string().min(1),
    timeout_seconds: z.number().int().positive(),
    scenarios: z.array(z.strictObject({ id: id, description: z.string().min(1) })),
  })).min(1),
  launch: z.strictObject({
    status: z.string().min(1),
    session_id: z.string().min(1).nullable(),
    launch_token: z.string().min(1).nullable(),
    launch_requested_at: timestamp,
    native_started_at: timestamp.nullable(),
    observed_state: z.string().min(1).nullable(),
    launcher_invocations: z.number().int().nonnegative(),
  }).nullable(),
  completion: z.strictObject({
    status: z.enum(['completed', 'blocked']),
    summary: z.string().min(1),
    open_assumptions: z.array(z.string().min(1)),
  }).nullable(),
  handoff: z.strictObject({ summary: z.string().min(1), open_assumptions: z.array(z.string().min(1)) }).nullable(),
  stopped: z.boolean().nullable(),
  // Stop markers written before 1.2.0 carry no time; the marker's existence is still reported through `stopped`.
  stopped_at: timestamp.nullable(),
})

export const runInputsSchema = z.strictObject({
  contract_version: z.literal('1.2.0'),
  run_id: id,
  feature: id.nullable(),
  base_commit: sha,
  source_branch: z.string().min(1),
  mode: z.enum(['interactive']),
  created_at: timestamp,
  automatic: z.strictObject({
    finish: z.string().min(1),
    permission_mode: z.string().min(1),
    worker_timeout_seconds: z.number().int().positive(),
    review_timeout_seconds: z.number().int().positive(),
    reviewer_transport: z.enum(['native', 'print']),
  }).nullable(),
  setup: z.array(z.strictObject({ command: z.string().min(1), timeout_seconds: z.number().int().positive() })),
  max_verification_attempts: z.number().int().positive(),
  workers: z.array(workerInputsSchema).min(1),
})

export const schemas = {
  projectList: z.strictObject({ projects: z.array(projectSchema) }),
  workflowList: z.strictObject({ workflows: z.array(definitionSchema) }),
  runList: z.strictObject({ runs: z.array(runSummarySchema), next_cursor: z.string().min(1).nullable() }),
  runDetail: runDetailSchema,
  reviewResult: reviewResultSchema,
  runInputs: runInputsSchema,
  // `.../runs/{run_id}/inputs`: null when the run's export has no `inputs` section (recorded before 1.2.0).
  runInputsResponse: z.strictObject({ inputs: runInputsSchema.nullable() }),
}

export type Project = z.infer<typeof projectSchema>
export type WorkflowDefinition = z.infer<typeof definitionSchema>
export type RunSummary = z.infer<typeof runSummarySchema>
export type RunDetail = z.infer<typeof runDetailSchema>
export type ReviewFinding = z.infer<typeof reviewFindingSchema>
export type ReviewResult = z.infer<typeof reviewResultSchema>
export type WorkerInputs = z.infer<typeof workerInputsSchema>
export type RunInputs = z.infer<typeof runInputsSchema>

export function validateDefinition(input: unknown): WorkflowDefinition {
  const definition = definitionSchema.parse(input)
  const nodes = new Map(definition.nodes.map(node => [node.node_id, node]))
  if (nodes.size !== definition.nodes.length) throw new Error('Duplicate node IDs')
  const remaining = new Set(nodes.keys())
  for (const node of nodes.values()) {
    if (new Set(node.depends_on).size !== node.depends_on.length || node.depends_on.some(id => !nodes.has(id)))
      throw new Error('Duplicate or unknown dependency')
  }
  while (remaining.size) {
    const ready = [...remaining].filter(id => nodes.get(id)!.depends_on.every(parent => !remaining.has(parent)))
    if (!ready.length) throw new Error('Workflow graph contains a cycle')
    ready.forEach(id => remaining.delete(id))
  }
  return definition
}

export function validateRunDetail(input: unknown): RunDetail {
  const detail = runDetailSchema.parse(input)
  validateDefinition(detail.definition)
  for (const field of ['project_id', 'workflow_id', 'definition_revision'] as const) {
    if (detail.summary[field] !== detail.definition[field]) throw new Error(`Mismatched ${field}`)
  }
  if (detail.summary.run_id !== detail.snapshot.run_id || detail.summary.status !== detail.snapshot.status)
    throw new Error('Summary and snapshot disagree')
  if (Date.parse(detail.summary.updated_at) < Date.parse(detail.summary.created_at))
    throw new Error('Run update precedes creation')
  const definitions = new Map(detail.definition.nodes.map(node => [node.node_id, node]))
  if (detail.snapshot.nodes.length !== definitions.size || new Set(detail.snapshot.nodes.map(node => node.node_id)).size !== definitions.size)
    throw new Error('Snapshot must contain every definition node exactly once')
  for (const node of detail.snapshot.nodes) {
    const definition = definitions.get(node.node_id)
    if (!definition || definition.kind !== node.kind || JSON.stringify([...definition.depends_on].sort()) !== JSON.stringify([...node.depends_on].sort()))
      throw new Error('Snapshot graph differs from pinned definition')
  }
  return detail
}

export function validateReviewResult(input: unknown): ReviewResult {
  const review = reviewResultSchema.parse(input)
  if (review.verdict === 'approved' && review.findings.some(f => (f.severity === 'P0' || f.severity === 'P1') && f.disposition !== 'resolved'))
    throw new Error('An approved review cannot carry an unresolved P0/P1 finding')
  if (review.diff_artifact && review.diff_artifact.kind !== 'patch') throw new Error('The review diff artifact must be a patch')
  if (review.transport === 'manual' && review.independent !== true) throw new Error('Manual reviews are operator attestations of independence')
  for (const finding of review.findings) {
    if (finding.requirement_verbatim === true && (finding.requirement === null || finding.worker === null || finding.worker === 'none'))
      throw new Error('A verbatim match needs a requirement quote and a worker to match it against')
  }
  return review
}

export function validateRunInputs(input: unknown): RunInputs {
  const inputs = runInputsSchema.parse(input)
  if (new Set(inputs.workers.map(w => w.node_id)).size !== inputs.workers.length) throw new Error('Worker node IDs must be unique')
  for (const worker of inputs.workers) {
    if (new Set(worker.checks.map(c => c.id)).size !== worker.checks.length) throw new Error('Check IDs must be unique per worker')
    if (worker.completion === null && worker.handoff !== null) throw new Error('A handoff is derived from a completion signal')
  }
  return inputs
}
