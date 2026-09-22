import { z } from 'zod'
import { artifactSchema, runSnapshotSchema } from '../workflow/v1.js'

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
const version = z.literal('1.0.0')
/** Payloads added by contract 1.1.0 (review results) and extended/added by 1.2.0 (finding links, run inputs). */
const version120 = z.literal('1.2.0')
const revision = z.string().regex(/^[a-f0-9]{64}$/)
const commit = z.string().regex(/^[a-f0-9]{40}$/)
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
  created_at: timestamp,
  updated_at: timestamp,
})

export const runDetailSchema = z.strictObject({
  summary: runSummarySchema,
  definition: definitionSchema,
  snapshot: runSnapshotSchema,
})

// ---- Review results (1.1.0, finding links added in 1.2.0) --------------------------------------------------

export const WORKER_LANES = ['ui', 'adapter'] as const
export const FINDING_WORKERS = ['ui', 'adapter', 'both', 'none'] as const

/** One reviewer finding. `worker`/`requirement` are null for reviews recorded before the reviewer prompt asked for them. */
export const reviewFindingSchema = z.strictObject({
  severity: z.enum(['P0', 'P1', 'P2']),
  message: z.string().min(1),
  disposition: z.enum(['open', 'resolved', 'accepted']),
  worker: z.enum(FINDING_WORKERS).nullable(),
  /** A verbatim quote from a worker's task text, as the reviewer wrote it. */
  requirement: z.string().min(1).nullable(),
  /** The worker lanes whose task text contains `requirement` verbatim; the backend never guesses a match. */
  requirement_found_in: z.array(z.enum(WORKER_LANES)),
})

/** The persisted verdict of a run's review node, served at `.../runs/{run_id}/reviews/{attempt}`. */
export const reviewResultSchema = z.strictObject({
  contract_version: version120,
  run_id: id,
  node_id: z.literal('review'),
  attempt: z.number().int().positive(),
  reviewer: z.strictObject({
    /** Native/print reviews: the Claude session UUID. Manual reviews: the operator-stated reviewer identity. */
    session_id: z.string().min(1),
    transport: z.enum(['native', 'print', 'manual']),
    independent: z.literal(true),
  }),
  bundle_sha256: revision,
  candidate_commit: commit,
  verdict: z.enum(['approved', 'blocked']),
  findings: z.array(reviewFindingSchema),
  reviewed_at: timestamp,
  /** The diff the reviewer saw (`review.diff`), registered as a bounded patch artifact of the run, when present. */
  diff: artifactSchema.nullable(),
})

// ---- Run inputs (1.2.0) ---------------------------------------------------------------------------------------

const boundedText = z.strictObject({ text: z.string(), truncated: z.boolean() })
const assumptions = z.array(z.string().min(1))

export const runInputWorkerSchema = z.strictObject({
  /** Logical worker (`ui`, `adapter`): the ID its results are served under. */
  node_id: id,
  /** The graph node that launched it (`launch_ui`, `launch_adapter`). */
  launch_node_id: id,
  role: z.enum(['frontend', 'backend']),
  /** The task text as pinned in the run plan (the authored assignment plus the appended ownership/checks JSON), rendered as Markdown. */
  task: boundedText,
  /** The exact prompt the native session received, when the run recorded it; null for runs that predate prompt capture. */
  prompt: boundedText.nullable(),
  owned_paths: z.array(relativePath),
  /** Check and scenario IDs are the policy's own labels (any non-empty string, e.g. `test:unit`), never route segments. */
  checks: z.array(z.strictObject({
    id: z.string().min(1),
    kind: z.enum(['build', 'typecheck', 'unit', 'integration', 'contract', 'browser']),
    /** The approved argv joined exactly as the verifier records executed commands, so check IDs can be matched to executed checks. */
    command: z.string().min(1),
    timeout_seconds: z.number().int().positive(),
    scenarios: z.array(z.strictObject({ id: z.string().min(1), description: z.string().min(1) })),
  })),
  launch: z.strictObject({
    session_id: z.string().min(1).nullable(),
    launch_requested_at: timestamp,
    native_started_at: timestamp.nullable(),
    observed_state: z.string().min(1).nullable(),
    status: z.string().min(1),
    launcher_invocations: z.number().int().nonnegative(),
  }).nullable(),
  completion: z.strictObject({ status: z.enum(['completed', 'blocked']), summary: z.string().min(1), open_assumptions: assumptions }).nullable(),
  handoff: z.strictObject({ summary: z.string().min(1), open_assumptions: assumptions }).nullable(),
  stop: z.strictObject({ stopped: z.boolean(), confirmed_at: timestamp.nullable() }).nullable(),
})

/** What a run was asked to do, served at `.../runs/{run_id}/inputs`; pinned from the run's own files. */
export const runInputsSchema = z.strictObject({
  contract_version: version120,
  run_id: id,
  feature: z.string().min(1),
  base_commit: commit,
  source_branch: z.string().min(1).nullable(),
  mode: z.enum(['automatic', 'manual']),
  automatic: z.strictObject({
    finish: z.string().min(1),
    permission_mode: z.string().min(1),
    worker_timeout_seconds: z.number().int().positive(),
    review_timeout_seconds: z.number().int().positive(),
    /** Null for runs pinned before the setting existed and never reviewed; otherwise the transport the run pinned or actually used. */
    reviewer_transport: z.enum(['native', 'print']).nullable(),
  }).nullable(),
  setup: z.array(z.strictObject({ command: z.string().min(1), timeout_seconds: z.number().int().positive() })),
  max_verification_attempts: z.number().int().positive(),
  workers: z.array(runInputWorkerSchema).min(1),
})

export const schemas = {
  projectList: z.strictObject({ projects: z.array(projectSchema) }),
  workflowList: z.strictObject({ workflows: z.array(definitionSchema) }),
  runList: z.strictObject({ runs: z.array(runSummarySchema), next_cursor: z.string().min(1).nullable() }),
  runDetail: runDetailSchema,
  reviewResult: reviewResultSchema,
  runInputs: runInputsSchema,
}

export type Project = z.infer<typeof projectSchema>
export type WorkflowDefinition = z.infer<typeof definitionSchema>
export type RunSummary = z.infer<typeof runSummarySchema>
export type RunDetail = z.infer<typeof runDetailSchema>
export type ReviewFinding = z.infer<typeof reviewFindingSchema>
export type ReviewResult = z.infer<typeof reviewResultSchema>
export type RunInputWorker = z.infer<typeof runInputWorkerSchema>
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

/** A finding blocks integration unless it is resolved; a review cannot be approved while such a finding is open or merely accepted. */
export function isBlockingFinding(finding: ReviewFinding): boolean {
  return (finding.severity === 'P0' || finding.severity === 'P1') && finding.disposition !== 'resolved'
}

export function validateReviewResult(input: unknown): ReviewResult {
  const result = reviewResultSchema.parse(input)
  if (result.verdict === 'approved' && result.findings.some(isBlockingFinding))
    throw new Error('An approved review cannot carry an unresolved P0/P1 finding')
  if (result.diff !== null && result.diff.kind !== 'patch') throw new Error('The review diff must be a patch artifact')
  for (const finding of result.findings) {
    if (new Set(finding.requirement_found_in).size !== finding.requirement_found_in.length) throw new Error('Duplicate requirement match lanes')
    if (finding.requirement === null && finding.requirement_found_in.length > 0) throw new Error('A finding without a requirement quote cannot match a task')
  }
  return result
}

export function validateRunInputs(input: unknown): RunInputs {
  const inputs = runInputsSchema.parse(input)
  if ((inputs.mode === 'automatic') !== (inputs.automatic !== null)) throw new Error('Automatic settings are present exactly for automatic runs')
  if (new Set(inputs.workers.map(worker => worker.node_id)).size !== inputs.workers.length) throw new Error('Duplicate worker IDs')
  if (new Set(inputs.workers.map(worker => worker.launch_node_id)).size !== inputs.workers.length) throw new Error('Duplicate launch node IDs')
  for (const worker of inputs.workers) {
    if (new Set(worker.checks.map(check => check.id)).size !== worker.checks.length) throw new Error(`Duplicate check IDs for ${worker.node_id}`)
    for (const check of worker.checks) {
      if ((check.kind === 'browser') !== (check.scenarios.length > 0)) throw new Error(`Browser checks need scenarios and other checks must not have them (${check.id})`)
      if (new Set(check.scenarios.map(scenario => scenario.id)).size !== check.scenarios.length) throw new Error(`Duplicate scenario IDs in ${check.id}`)
    }
    if (worker.stop !== null && !worker.stop.stopped && worker.stop.confirmed_at !== null) throw new Error('An unconfirmed stop has no confirmation time')
  }
  return inputs
}
