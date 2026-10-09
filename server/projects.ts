import { createHash } from 'node:crypto'
import fs, { type FileHandle } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import { buildTimeline, deriveAttention, deriveFocus, deriveNow, humanizeEvent, type Focus, type Now, type RunAttention, type RunData } from '../contracts/projects/triage.ts'
import {
  CHALLENGE_CONCERN_KINDS, CHALLENGE_STATUSES, EFFORT_LEVELS, validateFixLoop, CHECK_KINDS, COMPLETION_STATUSES, COMPLETION_VERSIONS, DEFAULT_REVIEWER_ID, FINDING_ATTRIBUTIONS, LANE_ID_PATTERN, REVIEWER_STATUSES, REVIEW_TRANSPORTS, RUN_DIR_PATTERN,
  RUN_PROFILES, runControllerSchema, TRYOUT_RESULTS, runRolesSchema, sidecarLedgerFileSchema, attackRecordSchema, panelRecordSchema, validateAttackResult, validatePanelResults, validateReviewResult, validateRunDetail, validateRunInputs, validateSidecarLedger,
  type AttackRecord, type AttackResult, type FixLoop, type RepairEntry, type PanelRecord, type PanelResults, type Project, type ReviewFinding, type ReviewResult, type ReviewerEntry, type RunActivity, type RunDetail, type RunInputs, type RunSummary, type SidecarLedger, type SidecarLedgerFile,
  type WorkerQuestion, type WorkflowDefinition,
} from '../contracts/projects/v1.ts'
import { eventSchema, validateWorkerResult, type RunSnapshot, type WorkerResult, type WorkflowEvent } from '../contracts/workflow/v1.ts'
import { DIRECTORY_FLAGS, at } from './files.ts'
import { archivedRounds, FixLoopError, mapRepairs, mapReviewRounds, REPAIRS_FILE, REPAIR_BYTE_LIMIT, redactDeep, REVIEW_ROUNDS_FILE } from './fixLoop.ts'
import { ID_PATTERN, publishDefinition, storedDefinitionSchema, type ProjectConfig, type ProjectsConfig, type WorkflowConfig } from './projectsConfig.ts'

/**
 * Read-only access to persisted workflow runs. A run is a directory below a registered workflow's `runs_root`
 * containing the controller's atomic `run-state.json` export (plus `plan.json`, `events.jsonl`,
 * `verification/<phase>/<node>/<attempt>/packet.json` evidence and, once reviewed, `review.diff`). Nothing here
 * spawns a process, decodes the checkpoint database or writes to run storage; every request re-reads the
 * persisted files and projects them onto the public contract. Missing or contradictory evidence is reported as
 * an error or a paused/failed state, never as success.
 *
 * Export versions: 1.0.0 (graph state only), 1.1.0 (adds the `review` section from `review.json`), 1.2.0
 * (adds the `inputs` section pinned from `plan.json`, `policy.json` and the worker receipts), 1.3.0 (worker
 * lanes from configuration: `inputs.workers` is keyed by any lane ID, `inputs` records the selected and excluded
 * lanes, per-lane graph state lives under `lanes` and `packets`) and 1.4.0 (parallel reviewers: the `review`
 * section lists `reviewers` and tags every finding with its `reviewer`) and 1.5.0 (the guardrails of feature.json 2.2.0:
 * `inputs.decisions`, `inputs.challenge`, the completion's version, evidence and unrecorded question and `questions`
 * per worker, and a `challenge` graph node before the launches; older exports serve them as null and `[]`, and their
 * completions as 1.0.0) and 1.6.0 (the review sidecar: a top-level `sidecar` section holding its ledger, or null, and a
 * `sidecar` graph node after the challenge) and 1.7.0 (C52: `inputs.roles`, `inputs.controller` and `inputs.automatic.profile`,
 * each absent for a run prepared before it and served as null; C8: `inputs.challenge.hold`, absent without a hold and served as
 * null, and a challenge node served paused while its hold waits for `resume --launch`; C49: `inputs.challenge.history`, the
 * replaced records with their P0/P1, absent before and served as [], and a top-level `costs` section the viewer does not read
 * yet) and 1.8.0 (the attack pass: a top-level `attack` section holding its record, a `pending` record or null, and an `attack`
 * graph node beside `review`) and 1.9.0 (the multi-provider panel: a top-level `panels` section holding the `panel.json`
 * record verbatim, a `pending` record or null; no graph node and no events this slice). A section is served only when the
 * export carries it; `values` is never mined for either. Exports before 1.4.0 have one reviewer named `review`:
 * the adapter fills its `reviewers` entry from the single section, so the viewer has one code path.
 *
 * The lane list comes from `inputs.workers` (policy order). Exports without an `inputs` section, which only
 * 1.0.0 and 1.1.0 produce, fall back to the fixed `ui`/`adapter` pair those versions always had. The node map
 * follows the `launch_<lane>`, `verify_<lane>` and `candidate_<lane>` naming the controller guarantees.
 *
 * Contract 1.5.0 (docs/PRD_VIEWER_UX.md 9.2): every summary carries the run's `activity`, derived with the viewer's own
 * triage rules (`contracts/projects/triage.ts`) from the files above plus each live lane's `<lane>.questions.json`, and
 * every detail its `run_dir`, served only for projects the registry lists under `viewer.expose_run_dir`.
 *
 * Contract 1.6.0 (docs/PRD_REVIEW_SIDECAR.md 4.7, 4.8): the review sidecar's ledger is served on its own route, read live from
 * `<run>/sidecar.ledger.json` (the export is rewritten only at graph steps) and else from the export's `sidecar` section. The
 * section is never parsed with the export, so no ledger can fail a run or the run list; the sidecar node's status comes from
 * its events like any node's.
 *
 * Contract 1.8.0 (docs/PRD_ATTACK_PASS.md 4.6, Appendix A): the attack pass's record is served on its own route the same way,
 * read live from `<run>/attack.json` (rewritten while the pass runs) and else from the export's `attack` section, which is
 * never parsed with the export either. The `attack` node is report-only: its rows never speak for the run.
 *
 * Contract 1.9.0 (docs/PRD_MULTI_PROVIDER_PANEL.md Appendix A): the panel's record is served on its own route the same way, read
 * live from `<run>/panel.json` whenever it is readable and valid (no mtime comparison) and else from the export's `panels`
 * section, never parsed with the export. The panel has no graph node this slice, so nothing of the run's activity reads it.
 *
 * Export 1.10.0 (docs/PRD_VIEWER_REFINE.md Appendix A): the in-run fix loop. The export's `definition` is unchanged; this
 * server projects one `repair-<n>` node of kind `worker` per session repair into the run detail's `definition` and `snapshot`
 * (after the definition hash, so `definition_revision` never moves) from the one `fixLoop` it chose: `repairs.json`,
 * `review-rounds.json` and the repair receipts read live for every registered project (the export is rewritten only at step
 * ends, so it lags a running round), each falling back to the export's `fix_loop`. A repair node's status never enters the
 * run's status; the steps a running repair re-enters read `running`. The review node's attempt is the review round.
 */

/** A rejected or failed project request. `message` is safe to send: it never carries absolute paths. */
export class ProjectApiError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export const DEFAULT_EXPORT_BYTE_LIMIT = 16 * 1024 * 1024
export const DEFAULT_PACKET_BYTE_LIMIT = 16 * 1024 * 1024
export const DEFAULT_ARTIFACT_BYTE_LIMIT = 32 * 1024 * 1024
export const DEFAULT_RUN_LIMIT = 50
export const MAX_RUN_LIMIT = 100

const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const EXPORT_VERSIONS = ['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0', '1.5.0', '1.6.0', '1.7.0', '1.8.0', '1.9.0', '1.10.0'] as const
/** Exports without an `inputs` section predate configured lanes and always had exactly these two. */
const LEGACY_LANES = ['ui', 'adapter'] as const
/**
 * Node IDs a lane can never take: the fixed graph tail, the finding attributions, the per-lane node prefixes, and the nodes
 * and files of the design challenge, the review sidecar and the attack pass.
 */
const RESERVED_LANE_IDS = new Set(['review', 'candidate', 'handoff', 'approval', 'integrate', 'multiple', 'none', 'both', 'challenge', 'sidecar', 'attack'])
const RESERVED_LANE_PREFIXES = ['launch_', 'verify_', 'candidate_', 'review-', 'challenge-', 'sidecar-', 'attack-']
/** Required check kinds the controller derived from the role before policies declared them (verification.py before 1.2.0). */
const ROLE_REQUIRED_KINDS: Record<string, readonly (typeof CHECK_KINDS)[number][]> = { frontend: ['build', 'browser'], backend: ['unit'] }
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** Task and prompt texts are served up to this many characters; the rest is replaced by a marker. */
const TEXT_LIMIT = 65536
/** The diff the reviewer saw, registered by the export relative to the run root. */
const REVIEW_DIFF_FILE = 'review.diff'
/** The delta against the previous round's candidate (or the followed run's), registered beside `review.diff` at export 1.10.0. */
const DELTA_DIFF_FILE = 'review.delta.diff'
const REVIEW_ARTIFACT_PREFIX = 'patch-review-'
/** The review sidecar's node (export 1.6.0) and the ledger the controller rewrites while the workers run. */
const SIDECAR_NODE = 'sidecar'
const SIDECAR_LEDGER_FILE = 'sidecar.ledger.json'
/** The live ledger is read up to the engine's own bound on it (PRD_REVIEW_SIDECAR 4.4), not the questions file's. */
export const SIDECAR_LEDGER_BYTE_LIMIT = 4 * 1024 * 1024
/** The attack pass's node (export 1.8.0) and the record the controller rewrites while the pass runs. */
const ATTACK_NODE = 'attack'
const ATTACK_FILE = 'attack.json'
/** The live record is read up to this bound: at most 20 findings per angle, each with at most 200 lines of output. */
export const ATTACK_BYTE_LIMIT = 4 * 1024 * 1024
/** The multi-provider panel's record (export 1.9.0), rewritten by the controller while the panel runs; no graph node this slice. */
const PANEL_FILE = 'panel.json'
/** The live record is read up to this bound, the attack pass's; a panel holds a handful of findings per provider. */
export const PANEL_BYTE_LIMIT = 4 * 1024 * 1024

/**
 * Absolute filesystem paths in persisted messages are never forwarded to clients. A path starts at the string start
 * or after any character that cannot be part of a path (so Markdown punctuation such as `[`, `|`, `<`, `*` and `(`
 * counts), or as the target of a `file://` URI, which is redacted together with its scheme.
 */
export function redactPaths(text: string): string {
  return text.replace(/(?:file:\/\/(?=\/)|(?<![A-Za-z0-9._@~+/-]))(?:~|\/[A-Za-z0-9._@~+-]+)(?:\/[A-Za-z0-9._@~+-]*)+/g, '<path>')
}

/** `stored` id pattern shared with the registry; also keeps run directories one safe component. */
const id = z.string().regex(ID_PATTERN)
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
const hex64 = z.string().regex(/^[a-f0-9]{64}$/)
const commit = z.string().regex(/^[a-f0-9]{40}$/)
const timestamp = z.iso.datetime()
/** Receipts store `+00:00` offsets; the contract wants a trailing Z, so these are normalised on projection. */
const zonedTimestamp = z.iso.datetime({ offset: true })
const relativePath = z.string().min(1).regex(/^(?!\/)(?![A-Za-z]:)(?!.*\\)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/)
const assumptions = z.array(z.string())
/** A configured lane ID: the policy's pattern, never a reserved graph node, attribution or per-lane node prefix. */
const laneKey = z.string().regex(LANE_ID_PATTERN).refine(lane => !RESERVED_LANE_IDS.has(lane) && !RESERVED_LANE_PREFIXES.some(prefix => lane.startsWith(prefix)), 'reserved lane id')
/** A finding attribution: a lane ID, `multiple`, `none` or the legacy `both`; the lane check happens against the run's lanes later. */
const attribution = z.string().regex(LANE_ID_PATTERN)

/** A reviewer ID as the plan pins it (`review` for the default reviewer); the same shape as a lane ID. */
const reviewerKey = z.string().regex(LANE_ID_PATTERN)

const reviewFindingSectionSchema = z.strictObject({
  severity: z.enum(['P0', 'P1', 'P2']),
  message: z.string().min(1),
  disposition: z.enum(['open', 'resolved', 'accepted']),
  worker: attribution.nullable(),
  requirement: z.string().min(1).nullable(),
  /** Present from export 1.4.0; earlier exports have the single reviewer `review`. */
  reviewer: reviewerKey.nullable().optional(),
})

/** One reviewer of the review node as export 1.4.0 records it. */
const reviewerSectionSchema = z.strictObject({
  reviewer_id: reviewerKey,
  transport: z.enum(REVIEW_TRANSPORTS),
  session_id: z.string().min(1).nullable(),
  verdict: z.enum(['approved', 'blocked']).nullable(),
  findings: z.array(reviewFindingSectionSchema),
  launched_at: zonedTimestamp.nullable(),
  accepted_at: zonedTimestamp.nullable(),
  status: z.enum(REVIEWER_STATUSES),
})

/** The export's `review` section: `review.json` plus the reviewer receipts, exactly as workflow/export_state.py writes it. */
const reviewSectionSchema = z.strictObject({
  attempt: z.number().int().positive(),
  transport: z.enum(REVIEW_TRANSPORTS),
  reviewer_session_id: z.string().min(1),
  independent: z.literal(true),
  bundle_sha256: hex64,
  candidate_commit: commit,
  verdict: z.enum(['approved', 'blocked']),
  findings: z.array(reviewFindingSectionSchema),
  /** Absent before 1.4.0: the single reviewer `review`, filled from the section itself. */
  reviewers: z.array(reviewerSectionSchema).min(1).optional(),
  reviewed_at: zonedTimestamp,
  diff: z.strictObject({ path: z.literal(REVIEW_DIFF_FILE), sha256: hex64, bytes: z.number().int().nonnegative() }).nullable(),
  /** Export 1.10.0: the review round (1 + the archived rounds), the commit the delta starts from and `review.delta.diff`; absent before. */
  round: z.number().int().positive().optional(),
  delta_from: commit.nullable().optional(),
  delta_diff: z.strictObject({ path: z.literal(DELTA_DIFF_FILE), sha256: hex64, bytes: z.number().int().nonnegative() }).nullable().optional(),
})

const workerInputSchema = z.strictObject({
  /** A free label since policy 1.2.0; `frontend`/`backend` before, when it also determined the required check kinds. */
  role: z.string().min(1),
  /** Present from export 1.3.0; derived from the role for earlier exports. */
  required_check_kinds: z.array(z.enum(CHECK_KINDS)).optional(),
  task: z.string(),
  prompt: z.string().nullable(),
  owned_paths: z.array(relativePath),
  /** Check and scenario IDs are the policy's own labels (any non-empty string, as the policy schema allows), never route segments. */
  checks: z.array(z.strictObject({
    id: z.string().min(1),
    kind: z.enum(CHECK_KINDS),
    argv: z.array(z.string()),
    command: z.string().min(1),
    timeout_seconds: z.number().int().positive(),
    scenarios: z.array(z.strictObject({ id: z.string().min(1), description: z.string().min(1) })),
  })),
  launch: z.strictObject({
    session_id: z.string().min(1).nullable(),
    launch_token: z.string().min(1),
    launch_requested_at: zonedTimestamp,
    /** Epoch milliseconds as `claude agents` reports the native start. */
    native_started_at: z.number().int().nonnegative().nullable(),
    observed_state: z.string().min(1).nullable(),
    status: z.string().min(1),
    launcher_invocations: z.number().int().nonnegative(),
    background_id: z.string().nullable(),
  }).nullable(),
  completion: z.strictObject({
    /** Export 1.5.0: the completion version the run pinned; absent before, when every completion was 1.0.0. */
    version: z.enum(COMPLETION_VERSIONS).optional(),
    status: z.enum(COMPLETION_STATUSES),
    summary: z.string().min(1),
    open_assumptions: assumptions,
    /** Completion 1.1.0 evidence (export 1.5.0); null for a 1.0.0 completion, absent before 1.5.0. */
    untested: z.array(z.string()).nullable().optional(),
    falsifying_check: z.string().nullable().optional(),
    verify_yourself: z.string().nullable().optional(),
    /** Export 1.5.0: the text of a question the controller has not recorded (pending, or a fourth served as blocked); absent before. */
    question: z.string().nullable().optional(),
  }).nullable(),
  handoff: z.strictObject({ summary: z.string().min(1), open_assumptions: assumptions }).nullable(),
  stop: z.strictObject({ stopped: z.boolean(), confirmed_at: zonedTimestamp.nullable() }).nullable(),
  /** Export 1.5.0: `<lane>.questions.json`; absent before. */
  questions: z.array(z.strictObject({
    n: z.number().int().positive(),
    question: z.string().min(1),
    asked_at: zonedTimestamp,
    answer: z.string().nullable(),
    answered_at: zonedTimestamp.nullable(),
  })).optional(),
  /** Export 1.10.0: plan.nodes.<lane>.roles and .skills; absent before. */
  roles: z.strictObject({ model: z.string().min(1).nullable(), effort: z.enum(EFFORT_LEVELS).nullable() }).nullable().optional(),
  skills: z.array(z.strictObject({ name: z.string().min(1), sha256: hex64 })).optional(),
})

/** Export 1.5.0: the latest `challenge.json` of a feature.json 2.2.0 run, without `run_id` and `version`, plus `attempts`. */
const challengeSectionSchema = z.strictObject({
  status: z.enum(CHALLENGE_STATUSES),
  attempt: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  session_id: z.string().min(1).nullable(),
  pinned: z.strictObject({ tasks_sha256: hex64, decisions_sha256: hex64, prd_sha256: hex64.nullable() }),
  concerns: z.array(z.strictObject({ severity: z.enum(['P0', 'P1', 'P2']), kind: z.enum(CHALLENGE_CONCERN_KINDS), message: z.string().min(1), consequence: z.string().min(1) })),
  simpler_alternative: z.string().min(1).nullable(),
  cheap_experiment: z.string().min(1).nullable(),
  accepted_reason: z.string().min(1).nullable(),
  decided_at: zonedTimestamp,
  /** Export 1.7.0 (C8): the hold of this attempt (challenge-hold.json); absent for every challenge without one. */
  hold: z.strictObject({
    held_at: zonedTimestamp,
    released_at: zonedTimestamp.nullable(),
    released_by: z.enum(['operator', 'maintainer']).nullable(),
    dropped: z.array(z.number().int().positive()),
  }).optional(),
  /** Export 1.7.0 (C49): each record this attempt replaced (challenge-<n>.json) with its P0/P1; absent before. */
  history: z.array(z.strictObject({
    attempt: z.number().int().positive(),
    status: z.enum(CHALLENGE_STATUSES),
    decided_at: zonedTimestamp,
    concerns: z.array(z.strictObject({ severity: z.enum(['P0', 'P1']), kind: z.enum(CHALLENGE_CONCERN_KINDS), message: z.string().min(1), consequence: z.string().min(1) })),
  })).optional(),
})

/** The export's `inputs` section: what the run was asked to do, pinned from `plan.json`, `policy.json` and receipts. */
const inputsSectionSchema = z.strictObject({
  feature: z.string().min(1),
  policy_version: z.string().min(1),
  base_commit: commit,
  source_branch: z.string().min(1).nullable(),
  mode: z.enum(['automatic', 'manual']),
  automatic: z.strictObject({
    finish: z.string().min(1),
    permission_mode: z.string().min(1),
    worker_timeout_seconds: z.number().int().positive(),
    review_timeout_seconds: z.number().int().positive(),
    /** Null when the plan predates the setting and the run never reviewed; the export never guesses it. */
    reviewer_transport: z.enum(['native', 'print']).nullable(),
    /** Export 1.7.0: the pinned profile; absent for plans pinned before it. */
    profile: z.enum(RUN_PROFILES).nullable().optional(),
    /** Export 1.10.0: plan.automatic.fix_rounds; left out for a plan without it. */
    fix_rounds: z.number().int().nonnegative().optional(),
  }).nullable(),
  setup: z.array(z.strictObject({ argv: z.array(z.string()), command: z.string().min(1), timeout_seconds: z.number().int().positive() })),
  max_verification_attempts: z.number().int().positive(),
  failure_drill: z.strictObject({ node_id: z.string(), phase: z.string(), attempt: z.number().int() }).nullable(),
  /** The lanes the run launched, in policy order (export 1.3.0); earlier exports describe every lane they have under `workers`. */
  selected_workers: z.array(laneKey).min(1).optional(),
  /** Declared lanes the launch left out (export 1.3.0); absent before, when every declared lane ran. */
  excluded_workers: z.array(laneKey).optional(),
  /** Keyed by the selected lanes in policy order: the run's lane list. */
  workers: z.record(laneKey, workerInputSchema).refine(workers => Object.keys(workers).length > 0, 'at least one worker is required'),
  /** Export 1.5.0: the pinned decisions.md text, null for runs without one; absent before. */
  decisions: z.string().nullable().optional(),
  /** Export 1.5.0: the design challenge, null for runs without one; absent before. */
  challenge: challengeSectionSchema.nullable().optional(),
  /** Export 1.7.0: plan.roles and plan.controller as prepare pinned them; absent for runs prepared before them. */
  roles: runRolesSchema.nullable().optional(),
  controller: runControllerSchema.nullable().optional(),
  /** Export 1.7.0 (C7, C29): plan.tryout, tryout.json's verdicts and plan.allow_untried; absent for runs prepared before them. */
  tryout: z.strictObject({
    required: z.boolean(),
    verdicts: z.array(z.strictObject({
      result: z.enum(TRYOUT_RESULTS), note: z.string().nullable(), at: zonedTimestamp, by: z.enum(['operator', 'maintainer']), via: z.literal('claude-code').optional(),
    })),
    allow_untried: z.strictObject({ reason: z.string().min(1), at: zonedTimestamp, by: z.enum(['operator', 'maintainer']), via: z.literal('claude-code').optional() }).optional(),
  }).optional(),
})

const exportSchema = z.object({
  version: z.enum(EXPORT_VERSIONS),
  run_id: id,
  base_commit: sha,
  created_at: timestamp,
  updated_at: timestamp,
  definition: storedDefinitionSchema,
  values: z.record(z.string(), z.unknown()),
  next: z.array(z.string()),
  tasks: z.array(z.object({
    node_id: z.string(),
    error: z.string().nullable(),
    interrupts: z.array(z.record(z.string(), z.unknown())),
    result: z.record(z.string(), z.unknown()).nullable(),
  })),
  events: z.array(z.unknown()),
  verification_packets: z.array(z.object({
    phase: z.enum(['worker', 'candidate']),
    node_id: id,
    attempt: z.number().int().positive(),
    path: z.string().min(1),
    sha256: hex64,
  })),
  /** Absent before 1.1.0; null when the run has no `review.json`. */
  review: reviewSectionSchema.nullable().optional(),
  /** Absent before 1.2.0; null when the run has no `policy.json`. */
  inputs: inputsSectionSchema.nullable().optional(),
  /**
   * Export 1.6.0: the review sidecar's ledger, or null for a run without one; absent before. Kept as unknown data: it is
   * validated only when the sidecar route serves it, so a ledger can never fail the run.
   */
  sidecar: z.unknown().optional(),
  /**
   * Export 1.8.0: the attack pass's record, a `pending` record, or null for a run without a pass; absent before. Kept as
   * unknown data like the sidecar's: validated only when the attack route serves it, so a record can never fail the run.
   */
  attack: z.unknown().optional(),
  /**
   * Export 1.9.0: the panel record (`panel.json` verbatim), a `pending` record, or null for a run without panels; absent
   * before. Kept as unknown data like the attack's: validated only when the panels route serves it.
   */
  panels: z.unknown().optional(),
  /** Export 1.10.0: the in-run fix loop as written (a record, the error form or null); kept as unknown data, validated when chosen. */
  fix_loop: z.unknown().optional(),
})

const rawEventSchema = z.object({
  sequence: z.number().int().positive(),
  time: timestamp,
  node: z.string(),
  status: z.string(),
  message: z.string(),
})

const planSchema = z.object({ run_id: id, base_commit: sha })

const packetSchema = z.object({
  phase: z.enum(['worker', 'candidate']),
  result: z.record(z.string(), z.unknown()),
  gate: z.object({ status: z.string(), reasons: z.array(z.string()), deferred_checks: z.array(z.string()).optional() }),
  /** Evidence receipts map check IDs to `result.checks` entries; read only to name deferred checks. */
  evidence: z.object({ checks: z.array(z.object({ id: z.string(), worker_check_index: z.number().int().nonnegative() })) }).optional(),
  /**
   * A candidate packet that reused a lane's worker packet (workflow/checks.py reuse_packet): that packet's run-relative path.
   * Its result is a copy of the worker packet's, whose artifacts and worktree stay beside the worker packet.
   */
  reused_from: z.object({ path: z.string().regex(/^verification\/worker\/[^/]+\/\d+\/packet\.json$/), sha256: hex64 }).optional(),
})

/** A check the gate recorded but did not gate on in the packet's phase, by its executed `result.checks` index. */
type DeferredCheck = { id: string; check_index: number }

type RunExport = z.infer<typeof exportSchema>
type RawEvent = z.infer<typeof rawEventSchema>
type PacketRegistration = RunExport['verification_packets'][number]
type ReviewSection = z.infer<typeof reviewSectionSchema>
type InputsSection = z.infer<typeof inputsSectionSchema>

/** A registered packet after loading: either verified content or the reason it cannot be trusted. */
type LoadedPacket = PacketRegistration & (
  | { ok: true; gate: { status: string; reasons: string[] }; result: Record<string, unknown>; deferred: DeferredCheck[]; reusedFrom: string | null }
  | { ok: false; reason: string }
)

/** The review diff as the export registered it; the artifact route serves it only when the bytes still match. */
type ReviewDiffRegistration = { artifact_id: string; sha256: string; bytes: number }

type Scope = { project: ProjectConfig; workflow: WorkflowConfig }

export type LoadedRun = {
  detail: RunDetail
  events: WorkflowEvent[]
  packets: LoadedPacket[]
  /** The projected review result, or null when the export carries no review section. */
  review: ReviewResult | null
  /** The projected run inputs, or null when the export carries no inputs section. */
  inputs: RunInputs | null
  reviewDiff: ReviewDiffRegistration | null
  /** `review.delta.diff` as the export registered it (export 1.10.0); null without the file or before it. */
  deltaDiff: ReviewDiffRegistration | null
  /** The fix loop this run's repair nodes and review attempt were projected from (null for a run without session repairs). */
  fixLoop: FixLoop | null
  /** The export's `sidecar` section as written (export 1.6.0), unvalidated; null or undefined when absent. */
  sidecar: unknown
  /** The export's `attack` section as written (export 1.8.0), unvalidated; undefined when the export predates it. */
  attack: unknown
  /** The export's `panels` section as written (export 1.9.0), unvalidated; undefined when the export predates it. */
  panels: unknown
}

export type ArtifactContent = {
  artifact_id: string
  kind: 'patch' | 'log' | 'screenshot' | 'test_report' | 'other' | 'file'
  contentType: string
  disposition: 'inline' | 'attachment'
  bytes: Buffer
}

/** Fixed graph tail → the LangGraph state key whose presence proves that node completed. */
/** The design challenge node of a feature.json 2.2.0 run (export 1.5.0), before every launch node. */
const CHALLENGE_NODE = 'challenge'
const TAIL_EVIDENCE_KEY: Record<string, string> = { handoff: 'snapshots', candidate: 'bundle', review: 'review', approval: 'approved_bundle', integrate: 'integrated_commit' }

/**
 * The run's lanes and the graph nodes that concern each of them. Built per run from the export: the lane list is
 * `inputs.workers` in policy order (the fixed pair for exports without `inputs`); `launch_<lane>` and
 * `verify_<lane>` are that lane's nodes, raw events name a lane (`docs`) for its launch, `candidate_<lane>` for
 * the combined check and `freeze` for the handoff.
 */
export type LaneMap = {
  lanes: readonly string[]
  /** Graph node → the lane it concerns, for launch and verify nodes. */
  workerOf: ReadonlyMap<string, string>
  verifyNodes: ReadonlySet<string>
  /** Raw event node aliases → graph nodes. Anything else must already be a graph node or is left unattributed. */
  eventAliases: ReadonlyMap<string, string>
  /** The session repairs of the run's fix loop (export 1.10.0), for mapping a `repair_<lane>` row onto its `repair-<n>` node. */
  repairs?: readonly { n: number; lane: string; round: number }[]
}

/** The lane map with the fix loop's session repairs, so the events of a repair session sit on its node. */
export function withRepairs(map: LaneMap, loop: FixLoop | null): LaneMap {
  return loop && loop.repairs.length > 0 ? { ...map, repairs: loop.repairs.map(repair => ({ n: repair.n, lane: repair.lane, round: repair.round })) } : map
}

export function laneMap(lanes: readonly string[]): LaneMap {
  const workerOf = new Map<string, string>()
  const verifyNodes = new Set<string>()
  const eventAliases = new Map<string, string>([['freeze', 'handoff']])
  for (const lane of lanes) {
    workerOf.set(`launch_${lane}`, lane)
    workerOf.set(`verify_${lane}`, lane)
    verifyNodes.add(`verify_${lane}`)
    eventAliases.set(lane, `launch_${lane}`)
    eventAliases.set(`candidate_${lane}`, 'candidate')
  }
  return { lanes, workerOf, verifyNodes, eventAliases }
}

/**
 * Per-lane graph state: exports before 1.3.0 store a lane's launch receipt under `<lane>` and its packet under
 * `<lane>_packet`; 1.3.0 stores them under `lanes.<lane>` and `packets.<lane>`. Both spellings are read so a
 * re-exported old run keeps its evidence.
 */
function laneValue(record: Record<string, unknown>, lane: string, kind: 'launch' | 'packet'): unknown {
  const flat = record[kind === 'launch' ? lane : `${lane}_packet`]
  if (flat !== undefined && flat !== null) return flat
  const nested = record[kind === 'launch' ? 'lanes' : 'packets']
  return nested && typeof nested === 'object' ? (nested as Record<string, unknown>)[lane] : undefined
}

/** The state entry whose presence proves a graph node completed, read from `values` or from a preserved task result. */
function nodeEvidence(record: Record<string, unknown>, nodeId: string, map: LaneMap): unknown {
  const lane = map.workerOf.get(nodeId)
  if (lane !== undefined) return laneValue(record, lane, map.verifyNodes.has(nodeId) ? 'packet' : 'launch')
  const key = TAIL_EVIDENCE_KEY[nodeId]
  return key ? record[key] : undefined
}

/** automatic.py:1244: each `automatic-step` child logs its PID as a `controller` row when it starts. */
const PID_ROW = /^Automatic checkpoint controller PID (\d+)\b/
/**
 * The controller process's own rows. `controller` is not a reserved lane ID (C6), so on a lane of that name the raw
 * `controller` node would alias these onto the lane's launch node; they concern the run, so they stay node-less (B1).
 * Then automatic.py's resumable stops (resumable_stop): a changed source branch, a start that did not complete; and the
 * reason drive gives before a stop it does not retry (record_blocked, `Controller blocked: …`), who ran a gate
 * action (pipeline.py action_event, C17), and an abandoned run's row (abandon.py, C30).
 */
const CONTROLLER_PROCESS_ROWS = [PID_ROW, /^Supervisor interrupted/, /Claude Code was unavailable/, /failed identically/, /^Repair \d+ applied/, /^\[Errno/,
  /^Source feature branch changed\b/, /^Automatic supervision requires a completed start\b/, /^Controller blocked: /,
  /^(?:Start|Automatic|Retry|Reconcile|Approve|Resume) by the (?:operator|maintainer)\b/,
  // automatic.py note_controller_drift: the step runs another controller commit than prepare pinned (a `warning`, served status-less).
  /^Controller commit [0-9a-f]+ runs this step\b/,
  // abandon.py: the run's `cancelled` row.
  /^Abandoned by the (?:operator|maintainer)\b/,
  // automatic.py final_stop: off the source branch these stops are said bare, as drive and the failed wait say them. Then the
  // failed wait's own texts: wait_handoffs' (a lane's deadline, an explicit block, an unrecorded question, a fourth question
  // from guardrails.py record_question, a missing session) and read_signal's refusals (`Invalid completion` covers
  // `Invalid completion file for`).
  /^Verification retry limit exhausted\b/, /^Handoff changed after stop intent\b/, /^Invalid completion\b/,
  /^Worker \S+ (deadline exhausted|explicitly blocked|asked a question that is not recorded yet)\b/, /^Native worker missing\b/,
  /^Worker \S+ asked question \d+; at most \d+ are answered\b/,
  /^Malformed completion signal\b/, /^Stale or foreign worker completion signal\b/, /^Completion version \S+ refused\b/,
  // pipeline.py prepare: the launch's notes (C23, C27), recorded before any lane launches.
  /^Launch notes: /,
  // tryout.py (C7): the operator's tryout verdict, a `note` row.
  /^Tryout recorded by the (?:operator|maintainer)\b/]
const FINISHED_STATUSES: ReadonlySet<RunSnapshot['status']> = new Set(['succeeded', 'failed', 'cancelled'])
/** A lane's live question record is read up to this size; a larger one is not read (the export's copy stands). */
const QUESTIONS_BYTE_LIMIT = 256 * 1024
/** `/proc` files are read up to this size; a controller's argv is far shorter. */
const PROC_FILE_LIMIT = 64 * 1024
/** Linux USER_HZ: `/proc/<pid>/stat` counts a process's start in clock ticks since boot at this rate. */
const CLOCK_TICKS_PER_SECOND = 100
/** A controller may start this much after the time its PID row records (tick and clock rounding). */
const START_TOLERANCE_MS = 1000
const HEADLINE_LIMIT = 160

const EVENT_STATUS: Record<string, RunSnapshot['status']> = {
  running: 'running', interactive: 'running', blocked: 'failed', succeeded: 'succeeded', passed: 'succeeded', approved: 'succeeded',
  /** The design challenge found a P0/P1 and no worker was launched: the operator resumes or accepts it. */
  paused: 'paused',
  /** The controller stepped away (Ctrl-C) while a native session kept running: unresolved until `automatic --live` resumes it. */
  interrupted: 'paused',
  /** `workflow abandon` (abandon.py, C30): the operator closed the run; nothing changes it any more. */
  cancelled: 'cancelled',
}
const CONTENT_TYPES: Record<ArtifactContent['kind'], string> = {
  log: 'text/plain; charset=utf-8', patch: 'text/plain; charset=utf-8', test_report: 'application/json; charset=utf-8',
  screenshot: 'image/png', other: 'application/octet-stream',
  /** A changed text file captured from the snapshot (UTF-8 by the capture rule), served verbatim like a log. */
  file: 'text/plain; charset=utf-8',
}

export function encodeCursor(scope: { project_id: string; workflow_id: string }, run: { updated_at: string; run_id: string }): string {
  return Buffer.from(JSON.stringify({ v: 1, p: scope.project_id, w: scope.workflow_id, u: run.updated_at, r: run.run_id }), 'utf8').toString('base64url')
}

const cursorSchema = z.strictObject({ v: z.literal(1), p: id, w: id, u: timestamp, r: id })

/** Cursors are opaque keyset tokens bound to one workflow; anything else is a 400, never a path or a guess. */
export function decodeCursor(cursor: string, scope: { project_id: string; workflow_id: string }): { updated_at: string; run_id: string } {
  const invalid = new ProjectApiError(400, 'INVALID_CURSOR', 'The cursor is not a paging token issued for this workflow. Restart from the first page.')
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw invalid
  }
  const result = cursorSchema.safeParse(parsed)
  if (!result.success || result.data.p !== scope.project_id || result.data.w !== scope.workflow_id) throw invalid
  return { updated_at: result.data.u, run_id: result.data.r }
}

/** Sort key: newest update first, then run ID ascending; the same order the keyset cursor walks. */
export function compareRuns(a: { updated_at: string; run_id: string }, b: { updated_at: string; run_id: string }): number {
  const byTime = Date.parse(b.updated_at) - Date.parse(a.updated_at)
  if (byTime !== 0) return byTime
  return a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0
}

/** Why a fix loop was refused, as a short text without paths: a mapping error's own words, or the schema's first issues. */
function reason(error: unknown): string {
  const text = error instanceof z.ZodError ? issueText(error) : error instanceof Error ? error.message : String(error)
  return redactPaths(text).slice(0, 500) || 'the fix loop is invalid'
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code
}

function isMissing(error: unknown): boolean {
  const code = errno(error)
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP' || code === 'ENXIO'
}

/**
 * Reads `components` below an open directory with one no-follow open per step, so no symlink inside a run can
 * redirect the read outside it. Returns null when any component is missing, a symlink or not the expected kind.
 * The final file is read at most `limit` bytes; a larger file is refused rather than truncated.
 */
async function readBounded(directory: FileHandle, components: readonly string[], limit: number): Promise<Buffer | null> {
  const handles: FileHandle[] = []
  try {
    let parent = directory
    for (const component of components.slice(0, -1)) {
      parent = await fs.open(at(parent, component), DIRECTORY_FLAGS)
      handles.push(parent)
    }
    const file = await fs.open(at(parent, components[components.length - 1]), FILE_FLAGS)
    handles.push(file)
    if (!(await file.stat()).isFile()) return null
    const buffer = Buffer.allocUnsafe(limit + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > limit) throw new ProjectApiError(500, 'FILE_TOO_LARGE', `The file ${components.join('/')} exceeds the ${limit} byte read limit.`)
    return buffer.subarray(0, offset)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  } finally {
    await Promise.all(handles.reverse().map(handle => handle.close()))
  }
}

async function openDirectory(parent: FileHandle, name: string): Promise<FileHandle | null> {
  try {
    return await fs.open(at(parent, name), DIRECTORY_FLAGS)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

function parseJson(bytes: Buffer, describe: string): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new ProjectApiError(500, 'RUN_STORAGE_INVALID', `${describe} is not valid JSON.`)
  }
}

function invalidRun(runId: string, detail: string): ProjectApiError {
  return new ProjectApiError(500, 'RUN_STORAGE_INVALID', `Run "${runId}" has malformed or contradictory persisted state: ${redactPaths(detail)}`)
}

function issueText(error: z.ZodError): string {
  return error.issues.slice(0, 3).map(issue => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`).join('; ')
}

function packetPath(packet: PacketRegistration): string {
  return `verification/${packet.phase}/${packet.node_id}/${packet.attempt}/packet.json`
}

function resultRoute(scope: Scope, runId: string, phase: 'worker' | 'candidate', worker: string, attempt: number): string {
  const node = phase === 'worker' ? worker : `candidate_${worker}`
  return `${runRoute(scope, runId)}/results/${encodeURIComponent(node)}/${attempt}`
}

function runRoute(scope: Scope, runId: string): string {
  return `/api/projects/${encodeURIComponent(scope.project.project_id)}/workflows/${encodeURIComponent(scope.workflow.workflow_id)}/runs/${encodeURIComponent(runId)}`
}

function reviewRoute(scope: Scope, runId: string, attempt: number): string {
  return `${runRoute(scope, runId)}/reviews/${attempt}`
}

function artifactRoute(scope: Scope, runId: string, artifactId: string): string {
  return `${runRoute(scope, runId)}/artifacts/${encodeURIComponent(artifactId)}`
}

/** The review diff's artifact ID is derived from its registered content hash, so it changes whenever the diff does. */
function reviewArtifactId(sha256: string): string {
  return `${REVIEW_ARTIFACT_PREFIX}${sha256.slice(0, 12)}`
}

/** Receipts record `+00:00`; the contract wants a trailing Z. Other offsets are converted, dropping sub-millisecond digits. */
function utcTimestamp(value: string): string {
  if (value.endsWith('Z')) return value
  if (value.endsWith('+00:00')) return `${value.slice(0, -6)}Z`
  return new Date(value).toISOString()
}

/** Redacts, then bounds a persisted text so a cut can never expose a partial path; the marker counts what was dropped. */
function boundedText(raw: string): { text: string; truncated: boolean } {
  const text = redactPaths(raw)
  if (text.length <= TEXT_LIMIT) return { text, truncated: false }
  let cut = TEXT_LIMIT
  const last = text.charCodeAt(cut - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1
  return { text: `${text.slice(0, cut)}\n\n[… truncated by the viewer API: ${text.length - cut} more characters]`, truncated: true }
}

function nonBlank(items: readonly string[]): string[] {
  return items.filter(item => item.trim().length > 0)
}

/**
 * The lanes whose pinned task text (or, when the task is empty, prompt) contains the reviewer's quote verbatim.
 * Matching runs on the raw texts before redaction, so a quote that names a path still links and a quote written
 * with the redaction marker does not; the redacted quote must also survive in the served (bounded) text, so a
 * link never points at a task whose visible text cannot show the quote. Nothing is inferred.
 */
function lanesQuoting(requirement: string | null, inputs: InputsSection | null): string[] {
  if (requirement === null || inputs === null) return []
  const served = redactPaths(requirement)
  return Object.entries(inputs.workers).filter(([, worker]) => {
    const text = worker.task.length > 0 ? worker.task : worker.prompt ?? ''
    return text.includes(requirement) && boundedText(text).text.includes(served)
  }).map(([lane]) => lane)
}

type FindingSection = z.infer<typeof reviewFindingSectionSchema>

/** One persisted finding onto the contract: redacted texts, verbatim task links, and its reviewer (`review` before export 1.4.0). */
function projectFinding(finding: FindingSection, inputs: InputsSection | null): ReviewFinding {
  return {
    severity: finding.severity, message: redactPaths(finding.message), disposition: finding.disposition, worker: finding.worker,
    requirement: finding.requirement === null ? null : redactPaths(finding.requirement),
    requirement_found_in: lanesQuoting(finding.requirement, inputs),
    reviewer: finding.reviewer ?? DEFAULT_REVIEWER_ID,
  }
}

/**
 * The reviewers of a review: export 1.4.0 records them; an older export is the single reviewer `review`, filled from
 * the section itself (its session, verdict, every finding and the review time), so the viewer has one code path.
 */
function projectReviewers(section: ReviewSection, findings: ReviewFinding[], inputs: InputsSection | null): ReviewerEntry[] {
  if (section.reviewers) {
    return section.reviewers.map(entry => ({
      reviewer_id: entry.reviewer_id, transport: entry.transport, session_id: entry.session_id === null ? null : redactPaths(entry.session_id),
      verdict: entry.verdict, findings: entry.findings.map(finding => projectFinding({ ...finding, reviewer: finding.reviewer ?? entry.reviewer_id }, inputs)),
      launched_at: entry.launched_at === null ? null : utcTimestamp(entry.launched_at),
      accepted_at: entry.accepted_at === null ? null : utcTimestamp(entry.accepted_at), status: entry.status,
    }))
  }
  return [{
    reviewer_id: DEFAULT_REVIEWER_ID, transport: section.transport, session_id: redactPaths(section.reviewer_session_id), verdict: section.verdict,
    findings, launched_at: null, accepted_at: utcTimestamp(section.reviewed_at), status: section.verdict === 'approved' ? 'accepted' : 'blocked',
  }]
}

/** Projects the export's review section onto the review-result contract; the caller applies the cross-field rules. */
function projectReview(scope: Scope, runId: string, section: ReviewSection, inputs: InputsSection | null, loop: FixLoop | null = null): ReviewResult {
  const findings = section.findings.map(finding => projectFinding(finding, inputs))
  const attempt = reviewAttempt(section, loop)
  return {
    contract_version: '1.4.0', run_id: runId, node_id: 'review', attempt,
    reviewer: { session_id: redactPaths(section.reviewer_session_id), transport: section.transport, independent: true },
    bundle_sha256: section.bundle_sha256, candidate_commit: section.candidate_commit, verdict: section.verdict,
    findings,
    reviewers: projectReviewers(section, findings, inputs),
    reviewed_at: utcTimestamp(section.reviewed_at),
    diff: section.diff === null ? null : reviewDiffArtifact(scope, runId, section.diff.sha256),
    // Export 1.10.0 only: an older export renders exactly as before.
    ...(section.round !== undefined ? {
      round: section.round, delta_from: section.delta_from ?? null,
      delta_diff: section.delta_diff == null ? null : reviewDiffArtifact(scope, runId, section.delta_diff.sha256),
    } : {}),
  }
}

/** The review diff as a scoped patch artifact link; its content is served only through the artifact route's registry checks. */
function reviewDiffArtifact(scope: Scope, runId: string, sha256: string): NonNullable<ReviewResult['diff']> {
  const artifact_id = reviewArtifactId(sha256)
  return { artifact_id, kind: 'patch', uri: artifactRoute(scope, runId, artifact_id), sha256 }
}

/** Projects the export's inputs section onto the run-inputs contract: policy order, redacted and bounded texts, Z timestamps. */
function projectInputs(runId: string, definition: WorkflowDefinition, section: InputsSection): RunInputs {
  const nodes = new Set(definition.nodes.map(node => node.node_id))
  const workers = Object.entries(section.workers).map(([lane, worker]) => ({
    node_id: lane,
    launch_node_id: nodes.has(`launch_${lane}`) ? `launch_${lane}` : lane,
    role: worker.role,
    // Exports before 1.3.0 carry no required kinds; the controller derived them from the role exactly like this.
    required_check_kinds: worker.required_check_kinds ? [...worker.required_check_kinds] : [...(ROLE_REQUIRED_KINDS[worker.role] ?? [])],
    task: boundedText(worker.task),
    prompt: worker.prompt === null ? null : boundedText(worker.prompt),
    owned_paths: [...worker.owned_paths],
    checks: worker.checks.map(check => ({
      id: check.id, kind: check.kind, command: check.command, timeout_seconds: check.timeout_seconds,
      scenarios: check.scenarios.map(scenario => ({ id: scenario.id, description: scenario.description })),
    })),
    launch: worker.launch === null ? null : {
      session_id: worker.launch.session_id, launch_requested_at: utcTimestamp(worker.launch.launch_requested_at),
      native_started_at: worker.launch.native_started_at === null ? null : new Date(worker.launch.native_started_at).toISOString(),
      observed_state: worker.launch.observed_state, status: worker.launch.status, launcher_invocations: worker.launch.launcher_invocations,
    },
    completion: worker.completion === null ? null : {
      // Exports before 1.5.0 carry only 1.0.0 completions: the controllers that wrote them read no other version.
      version: worker.completion.version ?? '1.0.0',
      status: worker.completion.status, summary: redactPaths(worker.completion.summary), open_assumptions: nonBlank(worker.completion.open_assumptions).map(redactPaths),
      // A 1.0.0 completion and every export before 1.5.0 carry no evidence: served as null, never guessed.
      untested: worker.completion.untested == null ? null : nonBlank(worker.completion.untested).map(redactPaths),
      falsifying_check: falsifyingCheck(worker.completion.falsifying_check, worker.checks),
      verify_yourself: optionalText(worker.completion.verify_yourself),
      question: optionalText(worker.completion.question),
    },
    handoff: worker.handoff === null ? null : { summary: redactPaths(worker.handoff.summary), open_assumptions: nonBlank(worker.handoff.open_assumptions).map(redactPaths) },
    stop: worker.stop === null ? null : { stopped: worker.stop.stopped, confirmed_at: worker.stop.confirmed_at === null ? null : utcTimestamp(worker.stop.confirmed_at) },
    questions: (worker.questions ?? []).map(question => ({
      n: question.n, question: redactPaths(question.question), asked_at: utcTimestamp(question.asked_at),
      answer: optionalText(question.answer), answered_at: question.answered_at === null ? null : utcTimestamp(question.answered_at),
    })),
    // Export 1.10.0 only: an older export renders exactly as before.
    ...(worker.roles !== undefined ? { roles: worker.roles === null ? null : { ...worker.roles } } : {}),
    ...(worker.skills !== undefined ? { skills: worker.skills.map(skill => ({ ...skill })) } : {}),
  }))
  const challenge = section.challenge ?? null
  return {
    contract_version: '1.4.0', run_id: runId, feature: redactPaths(section.feature), base_commit: section.base_commit, source_branch: section.source_branch,
    mode: section.mode, automatic: section.automatic === null ? null : { ...section.automatic, profile: section.automatic.profile ?? null },
    setup: section.setup.map(step => ({ command: step.command, timeout_seconds: step.timeout_seconds })),
    max_verification_attempts: section.max_verification_attempts,
    // Exports before 1.3.0 describe every lane they ran and excluded nothing.
    selected_workers: section.selected_workers ? [...section.selected_workers] : Object.keys(section.workers),
    excluded_workers: section.excluded_workers ? [...section.excluded_workers] : [],
    workers,
    // Exports before 1.5.0, and runs of features before 2.2.0, have neither.
    decisions: section.decisions == null ? null : redactPaths(section.decisions),
    challenge: challenge === null ? null : {
      ...challenge,
      pinned: { ...challenge.pinned },
      concerns: challenge.concerns.map(concern => ({ ...concern, message: redactPaths(concern.message), consequence: redactPaths(concern.consequence) })),
      simpler_alternative: challenge.simpler_alternative === null ? null : redactPaths(challenge.simpler_alternative),
      cheap_experiment: challenge.cheap_experiment === null ? null : redactPaths(challenge.cheap_experiment),
      accepted_reason: challenge.accepted_reason === null ? null : redactPaths(challenge.accepted_reason),
      decided_at: utcTimestamp(challenge.decided_at),
      hold: challenge.hold === undefined ? null : {
        ...challenge.hold,
        held_at: utcTimestamp(challenge.hold.held_at),
        released_at: challenge.hold.released_at === null ? null : utcTimestamp(challenge.hold.released_at),
        dropped: [...challenge.hold.dropped],
      },
      // Export 1.7.0 (C49); exports before it serve [].
      history: (challenge.history ?? []).map(entry => ({
        ...entry, decided_at: utcTimestamp(entry.decided_at),
        concerns: entry.concerns.map(concern => ({ ...concern, message: redactPaths(concern.message), consequence: redactPaths(concern.consequence) })),
      })),
    },
    // Export 1.7.0; runs prepared before the pins, and older exports, serve null.
    roles: section.roles == null ? null : { worker: { ...section.roles.worker }, judges: { ...section.roles.judges } },
    controller: section.controller == null ? null : { ...section.controller },
    // Export 1.7.0 (C7, C29); runs prepared before the tryout, and older exports, serve null. `via` is evidence the viewer does not show.
    tryout: section.tryout === undefined ? null : {
      required: section.tryout.required,
      verdicts: section.tryout.verdicts.map(verdict => ({ result: verdict.result, note: optionalText(verdict.note), at: utcTimestamp(verdict.at), by: verdict.by })),
      allow_untried: section.tryout.allow_untried === undefined ? null
        : { reason: redactPaths(section.tryout.allow_untried.reason), by: section.tryout.allow_untried.by, at: utcTimestamp(section.tryout.allow_untried.at) },
    },
  }
}

/** A worker-written text, redacted; null when absent or blank. */
function optionalText(value: string | null | undefined): string | null {
  return value == null || !value.trim() ? null : redactPaths(value)
}

/** The falsifying check verbatim when it names one of the lane's checks (by ID or exact command), so the viewer can link it; redacted text otherwise. */
function falsifyingCheck(value: string | null | undefined, checks: readonly { id: string; command: string }[]): string | null {
  if (value == null || !value.trim()) return null
  return checks.some(check => check.id === value || check.command === value) ? value : redactPaths(value)
}

/**
 * The lanes of a run: `inputs.workers` in policy order, or the fixed pair for exports without an `inputs` section.
 * A definition whose per-lane nodes name a lane the export does not describe is contradictory once `inputs` exists.
 */
function runLanes(runId: string, definition: WorkflowDefinition, inputs: InputsSection | null): LaneMap {
  const map = laneMap(inputs ? Object.keys(inputs.workers) : LEGACY_LANES)
  if (inputs) {
    for (const node of definition.nodes) {
      const prefix = ['launch_', 'verify_'].find(candidate => node.node_id.startsWith(candidate))
      if (prefix && !map.workerOf.has(node.node_id)) throw invalidRun(runId, `graph node ${node.node_id} names a lane the inputs section does not describe`)
    }
  }
  return map
}

/** Splits `ui`/`candidate_ui` result route IDs back into a registered packet phase and worker. */
function parseResultNode(nodeId: string): { phase: 'worker' | 'candidate'; worker: string } {
  return nodeId.startsWith('candidate_') ? { phase: 'candidate', worker: nodeId.slice('candidate_'.length) } : { phase: 'worker', worker: nodeId }
}

function laterTimestamp(a: string, b: string): string {
  return Date.parse(b) > Date.parse(a) ? b : a
}

export type RunStoreOptions = {
  exportByteLimit?: number
  packetByteLimit?: number
  artifactByteLimit?: number
  /** Receives skipped legacy directories and unexpected failures for logging; details may name run directories. */
  warn?: (message: string, details: Record<string, unknown>) => void
  /**
   * Re-reads the registry: a new config when its file changed, else null. Launches register workflows while the
   * viewer runs, so every Projects request syncs first; a failed read keeps the last loaded registry.
   */
  refresh?: () => Promise<ProjectsConfig | null>
  /** The `/proc` tree the controller liveness check reads; tests pass a fake one. */
  procRoot?: string
  /** The home directory a served `run_dir` is relative to; defaults to the server's `$HOME`. */
  home?: string
}

export class RunStore {
  private current: ProjectsConfig
  private projectsById = new Map<string, ProjectConfig>()
  private syncing: Promise<void> | null = null
  private readonly options: Required<Omit<RunStoreOptions, 'warn' | 'refresh'>> & Pick<RunStoreOptions, 'warn' | 'refresh'>

  constructor(config: ProjectsConfig, options: RunStoreOptions = {}) {
    this.current = config
    this.index(config)
    this.options = {
      exportByteLimit: options.exportByteLimit ?? DEFAULT_EXPORT_BYTE_LIMIT,
      packetByteLimit: options.packetByteLimit ?? DEFAULT_PACKET_BYTE_LIMIT,
      artifactByteLimit: options.artifactByteLimit ?? DEFAULT_ARTIFACT_BYTE_LIMIT,
      procRoot: options.procRoot ?? '/proc',
      home: options.home ?? homedir(),
      warn: options.warn,
      refresh: options.refresh,
    }
  }

  get config(): ProjectsConfig {
    return this.current
  }

  private index(config: ProjectsConfig) {
    this.projectsById = new Map(config.projects.map(project => [project.project_id, project]))
  }

  /** Picks up a changed registry file before a request is served; concurrent requests share one read. */
  async sync(): Promise<void> {
    const refresh = this.options.refresh
    if (!refresh) return
    this.syncing ??= refresh().then(
      config => {
        if (config === null) return
        this.current = config
        this.index(config)
      },
      error => this.options.warn?.('Project registry reload failed; the last loaded registry stays in use', { message: (error as Error).message }),
    ).finally(() => { this.syncing = null })
    await this.syncing
  }

  projects(): Project[] {
    return this.config.projects.map(project => ({ project_id: project.project_id, name: project.name }))
  }

  project(projectId: string): ProjectConfig {
    const project = this.projectsById.get(projectId)
    if (!project) throw new ProjectApiError(404, 'PROJECT_NOT_FOUND', 'No project with that ID is registered.')
    return project
  }

  workflows(projectId: string): WorkflowDefinition[] {
    return this.project(projectId).workflows.map(workflow => workflow.definition)
  }

  scope(projectId: string, workflowId: string): Scope {
    const project = this.project(projectId)
    const workflow = project.workflows.find(candidate => candidate.workflow_id === workflowId)
    if (!workflow) throw new ProjectApiError(404, 'WORKFLOW_NOT_FOUND', 'No workflow with that ID is registered in this project.')
    return { project, workflow }
  }

  /** Opens the workflow's configured run root no-follow for one operation. An unusable root is a 503, never an empty list. */
  private async withRunsRoot<T>(scope: Scope, operation: (root: FileHandle) => Promise<T>): Promise<T> {
    let root: FileHandle
    try {
      root = await fs.open(scope.workflow.runs_root, DIRECTORY_FLAGS)
    } catch (error) {
      const code = errno(error)
      const reason = code === 'ENOENT' ? 'does not exist' : code === 'EACCES' || code === 'EPERM' ? 'is not readable' : 'is not a directory (symbolic links are never followed)'
      if (!isMissing(error) && code !== 'EACCES' && code !== 'EPERM') throw error
      throw new ProjectApiError(503, 'RUNS_ROOT_UNAVAILABLE', `The configured run storage for this workflow ${reason}. Check the registry configuration.`)
    }
    try {
      return await operation(root)
    } finally {
      await root.close()
    }
  }

  /** Every run under the workflow root, newest first. Legacy directories without a supported export are skipped with a warning. */
  async listRuns(scope: Scope): Promise<RunSummary[]> {
    return this.withRunsRoot(scope, async root => {
      const names = (await fs.readdir(at(root), { withFileTypes: true }))
        .filter(dirent => dirent.isDirectory() && ID_PATTERN.test(dirent.name)).map(dirent => dirent.name).sort()
      const summaries: RunSummary[] = []
      const seen = new Set<string>()
      for (const name of names) {
        const directory = await openDirectory(root, name)
        if (!directory) continue
        try {
          const state = await readBounded(directory, ['run-state.json'], this.options.exportByteLimit)
          if (state === null) {
            if (await readBounded(directory, ['plan.json'], this.options.exportByteLimit) !== null) {
              this.options.warn?.('Skipping run directory without a supported run-state.json export; explicit import is required', { project_id: scope.project.project_id, workflow_id: scope.workflow.workflow_id, run: name })
            }
            continue
          }
          const run = await this.projectRun(scope, name, directory, state)
          if (seen.has(run.detail.summary.run_id)) throw invalidRun(name, 'duplicate run ID within the workflow')
          seen.add(run.detail.summary.run_id)
          summaries.push(run.detail.summary)
        } finally {
          await directory.close()
        }
      }
      return summaries.sort(compareRuns)
    })
  }

  async loadRun(scope: Scope, runId: string): Promise<LoadedRun> {
    return this.withRunsRoot(scope, async root => {
      const directory = await openDirectory(root, runId)
      if (!directory) throw new ProjectApiError(404, 'RUN_NOT_FOUND', 'No run with that ID exists in this workflow.')
      try {
        const state = await readBounded(directory, ['run-state.json'], this.options.exportByteLimit)
        if (state === null) {
          if (await readBounded(directory, ['plan.json'], this.options.exportByteLimit) !== null) {
            throw new ProjectApiError(404, 'RUN_UNSUPPORTED', 'This run predates the supported state export and needs an explicit import; it is not displayed.')
          }
          throw new ProjectApiError(404, 'RUN_NOT_FOUND', 'No run with that ID exists in this workflow.')
        }
        return await this.projectRun(scope, runId, directory, state)
      } finally {
        await directory.close()
      }
    })
  }

  async workerResult(scope: Scope, runId: string, nodeId: string, attempt: number): Promise<WorkerResult> {
    const run = await this.loadRun(scope, runId)
    const { phase, worker } = parseResultNode(nodeId)
    const packet = run.packets.find(candidate => candidate.phase === phase && candidate.node_id === worker && candidate.attempt === attempt)
    if (!packet) throw new ProjectApiError(404, 'RESULT_NOT_FOUND', 'No verified result is registered for that node and attempt.')
    if (!packet.ok) throw new ProjectApiError(500, 'EVIDENCE_MISMATCH', `The registered verification packet for ${nodeId}/${attempt} cannot be trusted: ${packet.reason}`)
    return projectWorkerResult(scope, runId, nodeId, packet)
  }

  /** The recorded review of a run. Absent sections and other attempts are 404: not recorded, never an error page. */
  async reviewResult(scope: Scope, runId: string, attempt: number): Promise<ReviewResult> {
    const run = await this.loadRun(scope, runId)
    if (!run.review || run.review.attempt !== attempt) {
      throw new ProjectApiError(404, 'REVIEW_NOT_FOUND', 'No review is recorded for that attempt: either the review has not happened or the run export predates review results.')
    }
    return run.review
  }

  /** What the run was asked to do. Absent sections are 404: not recorded, never an error page. */
  async runInputs(scope: Scope, runId: string): Promise<RunInputs> {
    const run = await this.loadRun(scope, runId)
    if (!run.inputs) throw new ProjectApiError(404, 'INPUTS_NOT_FOUND', 'No inputs are recorded for this run: its export predates run inputs.')
    return run.inputs
  }

  /**
   * The review sidecar's ledger (contract 1.6.0): the live `<run>/sidecar.ledger.json` when it is readable and valid, else the
   * export's `sidecar` section, else 404 `SIDECAR_NOT_FOUND` (a run without the sidecar node, an export before 1.6.0, no pass
   * recorded yet). A file or section that fails the contract is skipped with its reason logged, never an error page.
   */
  async sidecarLedger(scope: Scope, runId: string): Promise<SidecarLedger> {
    const run = await this.loadRun(scope, runId)
    const notRecorded = () => new ProjectApiError(404, 'SIDECAR_NOT_FOUND', 'No review sidecar ledger is recorded for this run: it has no sidecar, no pass has run yet or its export predates the sidecar.')
    if (!run.detail.definition.nodes.some(node => node.node_id === SIDECAR_NODE)) throw notRecorded()
    const skip = (source: SidecarLedger['source'], reason: string) => this.options.warn?.('Review sidecar ledger skipped', {
      project_id: scope.project.project_id, workflow_id: scope.workflow.workflow_id, run: runId, source, reason,
    })
    const live = await this.withRunsRoot(scope, async root => {
      const directory = await openDirectory(root, runId)
      if (!directory) return null
      try {
        return await readBounded(directory, [SIDECAR_LEDGER_FILE], SIDECAR_LEDGER_BYTE_LIMIT)
      } catch (error) {
        if (!(error instanceof ProjectApiError)) throw error
        skip('live', `${SIDECAR_LEDGER_FILE} exceeds the ${SIDECAR_LEDGER_BYTE_LIMIT} byte read limit`)
        return null
      } finally {
        await directory.close()
      }
    })
    if (live !== null) {
      let parsed: unknown
      try {
        parsed = JSON.parse(live.toString('utf8'))
      } catch {
        parsed = undefined
      }
      const served = parsed === undefined ? { error: `${SIDECAR_LEDGER_FILE} is not valid JSON` } : projectSidecarLedger(runId, parsed, 'live')
      if ('ledger' in served) return served.ledger
      skip('live', served.error)
    }
    if (run.sidecar !== null && run.sidecar !== undefined) {
      const served = projectSidecarLedger(runId, run.sidecar, 'export')
      if ('ledger' in served) return served.ledger
      skip('export', served.error)
    }
    throw notRecorded()
  }

  /**
   * The attack pass's record (contract 1.8.0): the live `<run>/attack.json` when it is readable and valid, else the export's
   * `attack` section when it is a valid record (the `pending` and `failed` records included), else 404 `ATTACK_NOT_FOUND` (an
   * export before 1.8.0, a run without a pass, a record that is unreadable or invalid both live and in the export). A file or
   * section that fails the contract is skipped with its reason logged, never an error page.
   */
  async attackResult(scope: Scope, runId: string): Promise<AttackResult> {
    const run = await this.loadRun(scope, runId)
    const notRecorded = () => new ProjectApiError(404, 'ATTACK_NOT_FOUND', 'No attack pass is recorded for this run: it has no attack pass, its record is not readable or its export predates the attack pass.')
    if (run.attack === undefined) throw notRecorded()
    if (run.attack === null && !run.detail.definition.nodes.some(node => node.node_id === ATTACK_NODE)) throw notRecorded()
    const skip = (source: AttackResult['source'], reason: string) => this.options.warn?.('Attack pass record skipped', {
      project_id: scope.project.project_id, workflow_id: scope.workflow.workflow_id, run: runId, source, reason,
    })
    const live = await this.withRunsRoot(scope, async root => {
      const directory = await openDirectory(root, runId)
      if (!directory) return null
      try {
        return await readBounded(directory, [ATTACK_FILE], ATTACK_BYTE_LIMIT)
      } catch (error) {
        if (!(error instanceof ProjectApiError)) throw error
        skip('live', `${ATTACK_FILE} exceeds the ${ATTACK_BYTE_LIMIT} byte read limit`)
        return null
      } finally {
        await directory.close()
      }
    })
    if (live !== null) {
      let parsed: unknown
      try {
        parsed = JSON.parse(live.toString('utf8'))
      } catch {
        parsed = undefined
      }
      const served = parsed === undefined ? { error: `${ATTACK_FILE} is not valid JSON` } : projectAttack(runId, parsed, 'live')
      if ('result' in served) return served.result
      skip('live', served.error)
    }
    if (run.attack !== null) {
      const served = projectAttack(runId, run.attack, 'export')
      if ('result' in served) return served.result
      skip('export', served.error)
    }
    throw notRecorded()
  }

  /**
   * The multi-provider panel's record (contract 1.9.0, Appendix A's live-vs-export rule): the live `<run>/panel.json` whenever
   * it is readable and valid (no mtime comparison: a valid live file always wins), else the export's `panels` section when it
   * is a valid record (the `pending` record included), else 404 `PANELS_NOT_FOUND` (an export before 1.9.0 or a run without
   * panels, each even beside a live file; a record unreadable or invalid both live and in the export). A file or section that fails the
   * contract is skipped with its reason logged, never an error page. There is no graph node to consult this slice.
   */
  async panelResults(scope: Scope, runId: string): Promise<PanelResults> {
    const run = await this.loadRun(scope, runId)
    const notRecorded = () => new ProjectApiError(404, 'PANELS_NOT_FOUND', 'No panel is recorded for this run: it has no panels, its record is not readable or its export predates the multi-provider panel.')
    // A run without `plan.panels` exports null and never writes `panel.json`: a stray live file is not a panel of this run.
    if (run.panels === undefined || run.panels === null) throw notRecorded()
    const skip = (source: PanelResults['source'], reason: string) => this.options.warn?.('Panel record skipped', {
      project_id: scope.project.project_id, workflow_id: scope.workflow.workflow_id, run: runId, source, reason,
    })
    const live = await this.withRunsRoot(scope, async root => {
      const directory = await openDirectory(root, runId)
      if (!directory) return null
      try {
        return await readBounded(directory, [PANEL_FILE], PANEL_BYTE_LIMIT)
      } catch (error) {
        if (!(error instanceof ProjectApiError)) throw error
        skip('live', `${PANEL_FILE} exceeds the ${PANEL_BYTE_LIMIT} byte read limit`)
        return null
      } finally {
        await directory.close()
      }
    })
    if (live !== null) {
      let parsed: unknown
      try {
        parsed = JSON.parse(live.toString('utf8'))
      } catch {
        parsed = undefined
      }
      const served = parsed === undefined ? { error: `${PANEL_FILE} is not valid JSON` } : projectPanels(parsed, 'live')
      if ('result' in served) return served.result
      skip('live', served.error)
    }
    const served = projectPanels(run.panels, 'export')
    if ('result' in served) return served.result
    skip('export', served.error)
    throw notRecorded()
  }

  /**
   * Serves one registered artifact: a packet artifact beside its verification packet, or the review diff the
   * export registered at the run root. Both registries are consulted; an ID registered with different hashes,
   * a malformed entry or an untrusted packet is refused, and the content is served only when it still hashes
   * (and, for the review diff, measures) as registered.
   */
  async artifact(scope: Scope, runId: string, artifactId: string): Promise<ArtifactContent> {
    const run = await this.loadRun(scope, runId)
    const registered: { components: string[]; kind: ArtifactContent['kind']; sha256: string; bytes: number | null }[] = []
    if (run.reviewDiff && run.reviewDiff.artifact_id === artifactId) {
      registered.push({ components: [REVIEW_DIFF_FILE], kind: 'patch', sha256: run.reviewDiff.sha256, bytes: run.reviewDiff.bytes })
    }
    if (run.deltaDiff && run.deltaDiff.artifact_id === artifactId) {
      registered.push({ components: [DELTA_DIFF_FILE], kind: 'patch', sha256: run.deltaDiff.sha256, bytes: run.deltaDiff.bytes })
    }
    let untrusted = false
    for (const packet of run.packets) {
      if (!packet.ok) { untrusted = true; continue }
      if (packet.reusedFrom !== null) continue  // Its artifacts are the reused worker packet's, registered beside that packet.
      const artifacts = Array.isArray(packet.result.artifacts) ? packet.result.artifacts as Record<string, unknown>[] : []
      for (const artifact of artifacts) {
        if (artifact?.artifact_id !== artifactId) continue
        const parsed = artifactRegistrationSchema.safeParse(artifact)
        if (!parsed.success) throw new ProjectApiError(500, 'EVIDENCE_MISMATCH', 'The registered artifact entry is malformed.')
        registered.push({ components: ['verification', packet.phase, packet.node_id, String(packet.attempt), 'artifacts', parsed.data.uri], kind: parsed.data.kind, sha256: parsed.data.sha256, bytes: null })
      }
    }
    if (registered.length === 0) {
      if (untrusted) throw new ProjectApiError(500, 'EVIDENCE_MISMATCH', 'A verification packet in this run cannot be trusted, so its artifacts are not served.')
      throw new ProjectApiError(404, 'ARTIFACT_NOT_FOUND', 'No artifact with that ID is registered for this run.')
    }
    const digests = new Set(registered.map(entry => entry.sha256))
    if (digests.size !== 1) throw new ProjectApiError(500, 'EVIDENCE_MISMATCH', 'The artifact ID is registered with conflicting content hashes.')
    const artifact = registered[0]
    const components = artifact.components
    const bytes = await this.withRunsRoot(scope, async root => {
      const directory = await openDirectory(root, runId)
      if (!directory) throw new ProjectApiError(404, 'RUN_NOT_FOUND', 'No run with that ID exists in this workflow.')
      try {
        return await readBounded(directory, components, this.options.artifactByteLimit)
      } catch (error) {
        if (error instanceof ProjectApiError && error.code === 'FILE_TOO_LARGE') throw new ProjectApiError(500, 'ARTIFACT_TOO_LARGE', 'The registered artifact exceeds the size limit for viewing.')
        throw error
      } finally {
        await directory.close()
      }
    })
    if (bytes === null) throw new ProjectApiError(500, 'ARTIFACT_UNAVAILABLE', 'The registered artifact file is missing, is not a regular file or is a symbolic link.')
    if ((artifact.bytes !== null && bytes.length !== artifact.bytes) || sha256(bytes) !== artifact.sha256) {
      throw new ProjectApiError(500, 'ARTIFACT_HASH_MISMATCH', 'The artifact content does not match its registered hash or size and is not served.')
    }
    const png = artifact.kind === 'screenshot' && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    const kind = artifact.kind === 'screenshot' && !png ? 'other' : artifact.kind
    return { artifact_id: artifactId, kind: artifact.kind, contentType: CONTENT_TYPES[kind], disposition: kind === 'other' ? 'attachment' : 'inline', bytes }
  }

  /** Validates the export and companion files, then projects them onto the public contract. */
  private async projectRun(scope: Scope, runId: string, directory: FileHandle, stateBytes: Buffer): Promise<LoadedRun> {
    const parsedExport = exportSchema.safeParse(parseJson(stateBytes, `run-state.json of run "${runId}"`))
    if (!parsedExport.success) throw invalidRun(runId, `run-state.json ${issueText(parsedExport.error)}`)
    const state = parsedExport.data
    if (state.run_id !== runId) throw invalidRun(runId, 'run-state.json names a different run_id than its directory')
    const planBytes = await readBounded(directory, ['plan.json'], this.options.exportByteLimit)
    if (planBytes === null) throw invalidRun(runId, 'plan.json is missing')
    const plan = planSchema.safeParse(parseJson(planBytes, `plan.json of run "${runId}"`))
    if (!plan.success) throw invalidRun(runId, `plan.json ${issueText(plan.error)}`)
    if (plan.data.run_id !== state.run_id || plan.data.base_commit !== state.base_commit) throw invalidRun(runId, 'plan.json and run-state.json disagree about the run identity')
    let definition: WorkflowDefinition
    try {
      definition = publishDefinition(scope.project.project_id, scope.workflow.workflow_id, state.definition)
    } catch (error) {
      throw invalidRun(runId, `pinned definition is invalid (${error instanceof z.ZodError ? issueText(error) : (error as Error).message})`)
    }
    const packets = await this.loadPackets(runId, directory, state.verification_packets)
    const rawEvents = await this.readEvents(runId, directory, state)
    const lanes = runLanes(runId, definition, state.inputs ?? null)
    // The one fixLoop every projection of this run reads; repair nodes are added after the definition hash (Appendix A.1 item 13).
    const loop = await this.fixLoopOf(scope, runId, directory, state, definition)
    const shown = projectedDefinition(definition, loop)
    const events = normalizeEvents(state.run_id, shown, rawEvents, withRepairs(lanes, loop))
    const snapshot = projectSnapshot(scope, definition, state, rawEvents, packets, lanes, loop)
    const created_at = state.created_at
    const updated_at = laterTimestamp(laterTimestamp(state.updated_at, rawEvents.at(-1)?.time ?? created_at), created_at)
    const summary: RunSummary = {
      contract_version: '1.0.0', project_id: scope.project.project_id, workflow_id: scope.workflow.workflow_id,
      definition_revision: definition.definition_revision, run_id: state.run_id, status: snapshot.status, created_at, updated_at,
    }
    const contractFailure = (what: string, error: unknown) => invalidRun(runId, `${what} violates the contract (${error instanceof z.ZodError ? issueText(error) : (error as Error).message})`)
    // The graph projection is validated on its own first, so a contradictory graph is reported before anything derived from it.
    let detail: RunDetail
    try {
      detail = validateRunDetail({ summary, definition: shown, snapshot, ...(loop ? { fixLoop: loop } : {}) })
    } catch (error) {
      throw contractFailure('projection', error)
    }
    // Sections are projected eagerly so a contradictory review or assignment fails the run as a whole, like any other malformed export.
    let inputs: RunInputs | null = null
    if (state.inputs) {
      try {
        inputs = validateRunInputs(projectInputs(state.run_id, definition, state.inputs))
      } catch (error) {
        throw contractFailure('inputs section', error)
      }
    }
    let review: ReviewResult | null = null
    if (state.review) {
      try {
        review = validateReviewResult(projectReview(scope, state.run_id, state.review, state.inputs ?? null, loop))
        // A finding names a lane this run had, an attribution (`multiple`, `none`, the legacy `both`) or nothing; anything else is contradictory.
        for (const item of review.findings) {
          if (item.worker !== null && !lanes.lanes.includes(item.worker) && !(FINDING_ATTRIBUTIONS as readonly string[]).includes(item.worker)) {
            throw new Error(`finding names "${item.worker}", which is neither a lane of this run nor an attribution`)
          }
        }
      } catch (error) {
        throw contractFailure('review section', error)
      }
    }
    const reviewDiff = state.review?.diff ? { artifact_id: reviewArtifactId(state.review.diff.sha256), sha256: state.review.diff.sha256, bytes: state.review.diff.bytes } : null
    const deltaDiff = state.review?.delta_diff ? { artifact_id: reviewArtifactId(state.review.delta_diff.sha256), sha256: state.review.delta_diff.sha256, bytes: state.review.delta_diff.bytes } : null
    const activity = await this.runActivity(directory, { detail, events, inputs, review }, rawEvents)
    const run_dir = await this.runDirectory(scope, directory)
    try {
      detail = validateRunDetail({ summary: { ...summary, contract_version: '1.5.0', activity }, definition: shown, snapshot, run_dir, ...(loop ? { fixLoop: loop } : {}) })
    } catch (error) {
      throw contractFailure('run activity', error)
    }
    return { detail, events, packets, review, inputs, reviewDiff, deltaDiff, fixLoop: loop, sidecar: state.sidecar ?? null, attack: state.attack, panels: state.panels }
  }


  /**
   * The fix loop of a run (export 1.10.0, Appendix A.1 item 6 and A.2): `repairs.json` read live for every registered project
   * whenever it is readable and holds valid session entries (`source: "live"`), else the export's `fix_loop` (`"export"`).
   * `review-rounds.json`, the archived `review.round-<k>.json` and `repair-<n>.interactive.json` are read live too, each falling
   * back to the export's record on its own without changing `source`. A loop that validates from neither source is served as
   * the error form with a warning, never a failed run; a run with no session repairs and no export record has none (null).
   */
  private async fixLoopOf(scope: Scope, runId: string, directory: FileHandle, state: RunExport, definition: WorkflowDefinition): Promise<FixLoop | null> {
    const skip = (source: 'live' | 'export', reason: string) => this.options.warn?.('Fix loop skipped', {
      project_id: scope.project.project_id, workflow_id: scope.workflow.workflow_id, run: runId, source, reason,
    })
    const read = async (name: string): Promise<unknown> => {
      try {
        const bytes = await readBounded(directory, [name], REPAIR_BYTE_LIMIT)
        return bytes === null ? undefined : JSON.parse(bytes.toString('utf8'))
      } catch {
        return undefined
      }
    }
    const header = (source: 'live' | 'export') => ({ contract_version: '1.10.0' as const, source })
    const check = (candidate: unknown): FixLoop => {
      const loop = validateFixLoop(redactDeep(candidate, redactPaths))
      checkLoopGraph(loop, definition)
      return loop
    }
    let exported: FixLoop | null = null
    let exportFailure: string | null = null
    if (state.fix_loop !== undefined && state.fix_loop !== null) {
      try {
        exported = check({ ...header('export'), ...(state.fix_loop as object) })
      } catch (error) {
        exportFailure = reason(error)
        skip('export', exportFailure)
      }
    }
    const exportedRepairs = exported && 'error' in exported ? [] : exported?.repairs ?? []
    const exportedRounds = exported && 'error' in exported ? [] : exported?.review_rounds ?? []
    let liveFailure: string | null = null
    const journal = await read(REPAIRS_FILE)
    if (journal !== undefined) {
      try {
        const sessions = (Array.isArray((journal as { repairs?: unknown }).repairs) ? (journal as { repairs: unknown[] }).repairs : [])
          .flatMap(item => (item as { mode?: unknown; n?: unknown } | null)?.mode === 'session' && Number.isInteger((item as { n: unknown }).n) ? [(item as { n: number }).n] : [])
        const receipts = new Map<number, unknown>()
        for (const n of sessions) receipts.set(n, await read(`repair-${n}.interactive.json`))
        const repairs = mapRepairs(journal, n => receipts.get(n) ?? (exportedRepairs.find(repair => repair.n === n)?.requested ? { requested: exportedRepairs.find(repair => repair.n === n)!.requested } : undefined))
        let rounds: ReturnType<typeof mapReviewRounds>
        const rawRounds = await read(REVIEW_ROUNDS_FILE)
        const archives = new Map<number, unknown>()
        if (rawRounds !== undefined) {
          for (const item of (rawRounds as { rounds?: unknown[] }).rounds ?? []) {
            const round = (item as { round?: unknown } | null)?.round
            if (typeof round === 'number') archives.set(round, await read(`review.round-${round}.json`))
          }
        }
        try {
          if (rawRounds === undefined) throw new FixLoopError(`${REVIEW_ROUNDS_FILE} is not readable`)
          rounds = mapReviewRounds(rawRounds, repairs, round => archives.get(round)).map(round => {
            const kept = exportedRounds.find(other => other.round === round.round)
            return round.archived && round.reviewers.length === 0 && kept ? { ...round, reviewers: kept.reviewers } : round
          })
        } catch (error) {
          // Unreadable or invalid: the export's rounds (an absent file simply means no round was archived).
          if (rawRounds !== undefined) skip('live', reason(error))
          rounds = rawRounds === undefined && exportedRounds.length === 0 ? [] : exportedRounds.map(round => ({ ...round }))
        }
        if (repairs.length === 0 && rounds.length === 0 && exported === null && exportFailure === null) return null
        const configured = exported && !('error' in exported) ? exported.rounds : state.inputs?.automatic?.fix_rounds ?? repairs.at(-1)?.rounds ?? 0
        return check({ ...header('live'), version: '1.0.0', rounds: configured, repairs, review_rounds: rounds })
      } catch (error) {
        liveFailure = reason(error)
        skip('live', liveFailure)
      }
    }
    if (exported) return exported
    const failure = liveFailure ?? exportFailure
    if (failure === null) return null
    return { ...header('export'), version: '1.0.0', error: failure, rounds: null, repairs: [], review_rounds: [] }
  }

  /**
   * What a list row says about a run (contract 1.5.0, docs/PRD_VIEWER_UX.md B2), from what `projectRun` already read and
   * nothing else except each live lane's question record: no review file, lane result or packet is opened, so list polls
   * stay cheap. The focus, attention, headline and times follow the run page's triage rules, so the two agree.
   */
  private async runActivity(directory: FileHandle, run: RunData, rawEvents: readonly RawEvent[]): Promise<RunActivity> {
    const status = run.detail.snapshot.status
    // A finished run waits on nobody: only a run that can still move reads its lanes' live question records.
    const current = !FINISHED_STATUSES.has(status) && run.inputs ? { ...run, inputs: await this.liveQuestions(directory, run.inputs) } : run
    const timeline = buildTimeline(current)
    const attention = deriveAttention(current)
    const now = deriveNow(current)
    const focus = deriveFocus(current.detail, current.events)
    return {
      feature: run.inputs?.feature ?? null,
      last_activity_at: timeline.lastActivity?.at ?? null,
      finished_at: timeline.runEnd?.at ?? null,
      focus: focus && { node_id: focus.node_id, label: focus.label, status: focus.status, since: focus.since },
      attention: activityAttention(status, attention, now, focus),
      waiting_questions: [...attention.nodes.values()].filter(item => item.kind === 'question').length,
      headline: activityHeadline(current, focus, now),
      controller: status === 'running' || status === 'paused' ? await this.controllerState(directory, rawEvents) : null,
    }
  }

  /**
   * The run inputs with each running lane's questions as the controller records them now: `run-state.json` is not
   * re-exported while the handoff waits (C5), so only `<lane>.questions.json` knows a question asked or answered since.
   * Its entries replace the export's by number; a file that is missing, oversized, malformed or inconsistent is ignored.
   */
  private async liveQuestions(directory: FileHandle, inputs: RunInputs): Promise<RunInputs> {
    const workers = await Promise.all(inputs.workers.map(async worker => {
      if (worker.stop?.stopped) return worker
      const recorded = await readQuestions(directory, worker.node_id)
      if (recorded === null) return worker
      const byNumber = new Map(worker.questions.map(question => [question.n, question]))
      for (const question of recorded) byNumber.set(question.n, question)
      const questions = [...byNumber.values()].sort((a, b) => a.n - b.n)
      if (!consistentQuestions(questions)) return worker
      // The controller moves a `question` completion aside once it records the question; a stale export still shows it.
      const moved = worker.completion?.status === 'question' && questions.length > worker.questions.length
      return { ...worker, questions, completion: moved ? null : worker.completion }
    }))
    return { ...inputs, workers }
  }

  /**
   * Whether the run's controller is alive, read-only from `/proc` (B2): only for a run that logged
   * `Automatic checkpoint controller PID <n>`, whose `automatic-step` child runs on this host as this user
   * (automatic.py:1103, :1244). Never a signal: `process.kill(pid, 0)` would trust a PID that may have been reused.
   */
  private async controllerState(directory: FileHandle, rawEvents: readonly RawEvent[]): Promise<RunActivity['controller']> {
    const logged = rawEvents.findLast(event => event.node === 'controller' && PID_ROW.test(event.message))
    if (!logged) return null
    const runDir = await realpathOrNull(at(directory))
    return runDir === null ? 'unknown' : controllerLiveness(this.options.procRoot, Number(PID_ROW.exec(logged.message)![1]), logged.time, runDir)
  }

  /**
   * The run directory, `~`-relative (B3), for a project the registry lists under `viewer.expose_run_dir`; null for any other
   * project, a directory outside the home, and a path that would not paste unquoted as `RUN=<path>`.
   */
  private async runDirectory(scope: Scope, directory: FileHandle): Promise<string | null> {
    if (!this.config.viewer?.expose_run_dir.includes(scope.project.project_id)) return null
    const [runDir, home] = await Promise.all([realpathOrNull(at(directory)), realpathOrNull(this.options.home)])
    if (runDir === null || home === null) return null
    const inside = relative(home, runDir)
    if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return null
    const served = `~/${inside.split(sep).join('/')}`
    return RUN_DIR_PATTERN.test(served) ? served : null
  }

  private async loadPackets(runId: string, directory: FileHandle, registrations: PacketRegistration[]): Promise<LoadedPacket[]> {
    const keys = new Set<string>()
    const packets: LoadedPacket[] = []
    for (const registration of registrations) {
      const key = `${registration.phase}:${registration.node_id}:${registration.attempt}`
      if (keys.has(key)) throw invalidRun(runId, `duplicate verification packet registration ${key}`)
      keys.add(key)
      if (registration.path !== packetPath(registration)) throw invalidRun(runId, `verification packet ${key} is registered outside the run's verification directory`)
      let bytes: Buffer | null
      try {
        bytes = await readBounded(directory, registration.path.split('/'), this.options.packetByteLimit)
      } catch (error) {
        if (!(error instanceof ProjectApiError)) throw error
        packets.push({ ...registration, ok: false, reason: 'packet exceeds the read limit' })
        continue
      }
      if (bytes === null) { packets.push({ ...registration, ok: false, reason: 'packet file is missing or not a regular file' }); continue }
      if (sha256(bytes) !== registration.sha256) { packets.push({ ...registration, ok: false, reason: 'packet content does not match its registered hash' }); continue }
      let parsed: unknown
      try {
        parsed = JSON.parse(bytes.toString('utf8'))
      } catch {
        packets.push({ ...registration, ok: false, reason: 'packet is not valid JSON' })
        continue
      }
      const packet = packetSchema.safeParse(parsed)
      if (!packet.success) { packets.push({ ...registration, ok: false, reason: `packet ${issueText(packet.error)}` }); continue }
      if (packet.data.phase !== registration.phase) { packets.push({ ...registration, ok: false, reason: 'packet phase differs from its registration' }); continue }
      const deferredIds = new Set(packet.data.gate.deferred_checks ?? [])
      const deferred = (packet.data.evidence?.checks ?? []).filter(check => deferredIds.has(check.id)).map(check => ({ id: check.id, check_index: check.worker_check_index }))
      packets.push({ ...registration, ok: true, gate: packet.data.gate, result: packet.data.result, deferred, reusedFrom: packet.data.reused_from?.path ?? null })
    }
    return packets
  }

  /** `events.jsonl` is the live append-only log; the export's embedded copy is the fallback when it is absent. */
  private async readEvents(runId: string, directory: FileHandle, state: RunExport): Promise<RawEvent[]> {
    const bytes = await readBounded(directory, ['events.jsonl'], this.options.exportByteLimit)
    let raw: unknown[]
    if (bytes === null) {
      raw = state.events
    } else {
      const text = bytes.toString('utf8')
      const lines = text.split('\n')
      // A partially appended final line (no trailing newline) is in flight, not corruption.
      if (lines.length && lines[lines.length - 1] !== '' && !text.endsWith('\n')) lines.pop()
      raw = []
      for (const line of lines) {
        if (line.trim() === '') continue
        try {
          raw.push(JSON.parse(line))
        } catch {
          throw invalidRun(runId, 'events.jsonl contains a malformed line')
        }
      }
    }
    const events: RawEvent[] = []
    for (const [index, item] of raw.entries()) {
      const parsed = rawEventSchema.safeParse(item)
      if (!parsed.success) throw invalidRun(runId, `event ${index} ${issueText(parsed.error)}`)
      if (events.length && parsed.data.sequence <= events[events.length - 1].sequence) throw invalidRun(runId, 'event sequence numbers are not strictly increasing')
      events.push(parsed.data)
    }
    return events
  }
}

const artifactRegistrationSchema = z.object({
  artifact_id: z.string().min(1),
  kind: z.enum(['patch', 'log', 'screenshot', 'test_report', 'other', 'file']),
  /** Producer registries store the artifact's basename beside the packet; anything else is not followed. */
  uri: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/),
  sha256: hex64,
})

/** Maps a raw event node name onto the pinned graph, or null when it names nothing in this definition. */
function eventNode(definition: WorkflowDefinition, node: string, map: LaneMap): string | null {
  const known = new Set(definition.nodes.map(item => item.node_id))
  if (known.has(node)) return node
  const alias = map.eventAliases.get(node)
  return alias && known.has(alias) ? alias : null
}

/** The graph node a raw event concerns. The controller process's own rows concern the run, even beside a lane named `controller`. */
function eventGraphNode(definition: WorkflowDefinition, event: RawEvent, map: LaneMap): string | null {
  if (event.node === 'controller' && map.lanes.includes('controller') && CONTROLLER_PROCESS_ROWS.some(pattern => pattern.test(event.message))) return null
  const repair = map.repairs ? repairRowNode(event, map.repairs) : null
  if (repair !== null) return definition.nodes.some(node => node.node_id === repair) ? repair : null
  return eventNode(definition, event.node, map)
}

const REPAIR_ROW = /^repair_(.+)$/
const REPAIR_TOKEN = /\brepair-([1-9][0-9]*)\b/
const REPAIR_ROUND = /^round (\d+):/

/**
 * The `repair-<n>` node a `repair_<lane>` timeline row (repair.py) concerns: the row's own `repair-<n>` token first (the launch
 * row, the stop warnings), else the `round <r>` it opens with, counted per lane. Null for any other row and for a row naming no repair of the loop.
 */
function repairRowNode(event: RawEvent, repairs: NonNullable<LaneMap['repairs']>): string | null {
  const row = REPAIR_ROW.exec(event.node)
  if (!row) return null
  const token = REPAIR_TOKEN.exec(event.message)
  const named = token ? repairs.find(repair => repair.n === Number(token[1])) : undefined
  if (named) return `repair-${named.n}`
  const round = REPAIR_ROUND.exec(event.message)
  const counted = round ? repairs.find(repair => repair.lane === row[1] && repair.round === Number(round[1])) : undefined
  return counted ? `repair-${counted.n}` : null
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null
}

function hasEvidence(state: RunExport, nodeId: string, map: LaneMap): boolean {
  if (present(nodeEvidence(state.values, nodeId, map))) return true
  return state.tasks.some(task => task.result !== null && present(nodeEvidence(task.result, nodeId, map)))
}

/**
 * The attempt a row states of its own node, only at the start of the controller's phrases: "Attempt 2; revision …"
 * (pipeline.py), and "Design challenge attempt 2 …" and "Feature files re-pinned for design challenge attempt 2 …"
 * (guardrails.py), in lower case. Elsewhere in a message an attempt is quoted: a repair note answers other packets
 * ("Answers candidate/ui attempt 3") after the operator's free-text reason, and neither is its node's attempt.
 */
const OWN_ATTEMPT = /^(?:Attempt|Design challenge attempt|Feature files re-pinned for design challenge attempt) (\d+)\b/

function attemptFromMessage(message: string): number | null {
  const match = OWN_ATTEMPT.exec(message)
  return match ? Number(match[1]) : null
}

/** Normalizes internal `{sequence,time,node,status,message}` records into workflow-v1 events. */
export function normalizeEvents(runId: string, definition: WorkflowDefinition, raw: readonly RawEvent[], map: LaneMap = laneMap(LEGACY_LANES)): WorkflowEvent[] {
  const attempts = new Map<string, number>()
  return raw.map(event => {
    const node_id = eventGraphNode(definition, event, map)
    let attempt = 0
    if (node_id) {
      const parsed = attemptFromMessage(event.message)
      if (parsed !== null) attempts.set(node_id, parsed)
      attempt = attempts.get(node_id) ?? 1
    }
    // A status only means something for a node in the pinned graph; unattributed records are plain log lines. The
    // controller's own rows keep theirs (blocked is failed, interrupted is paused) as logs, so the viewer can say why it stopped.
    // A repair session's rows (repair.py) end `failed` when the round blocks; no other node's row says `failed`.
    const repairFailed = node_id !== null && node_id.startsWith('repair-') && event.status === 'failed'
    const status = node_id || event.node === 'controller' ? EVENT_STATUS[event.status] ?? (repairFailed ? 'failed' : null) : null
    // The combined check reports per lane; its rows are aliased onto `candidate`, so the message keeps the lane.
    const lane = node_id === 'candidate' && event.node !== node_id ? event.node.slice('candidate_'.length) : null
    return eventSchema.parse({
      contract_version: '1.0.0', run_id: runId, event_id: `${runId}:${event.sequence}`, sequence: event.sequence, occurred_at: event.time,
      node_id, attempt, type: node_id && status ? 'status_changed' : 'log', status, message: redactPaths(lane ? `[${lane}] ${event.message}` : event.message),
      artifact: null, result_uri: null, reused_from_attempt: null,
    })
  })
}

type NodeStatus = RunSnapshot['nodes'][number]['status']

/**
 * Projects the persisted graph state onto the pinned definition. Precedence per node: a task error is failed, an
 * interrupt is awaiting approval, confirmed completion evidence is succeeded (verification nodes additionally need
 * their registered packet to load, match its hash and have passed), then the last persisted event, then pending.
 * The run succeeds only once integrated with nothing pending; contradictory evidence is paused.
 *
 * While the handoff holds its `worker_handoff` interrupt the lanes' sessions are still live, so a launch receipt
 * only proves the launch: a launch node is running until a freeze record (the freeze, or the controller stopping
 * the workers as it gives up) follows its last event. In an automatic run that interrupt waits on the workers'
 * completion signals and the controller freezes by itself, so it is no decision: the handoff shows the latest of
 * its own events and the controller's (blocked is failed, interrupted is paused, a freeze in progress is running),
 * else pending. A manual run's handoff still awaits approval, since the operator freezes it. The export is rewritten
 * only at checkpoints, so after a `freeze succeeded` event the interrupt it still holds is stale: the handoff has
 * succeeded and the rest of the graph is read as usual.
 */
export function projectSnapshot(scope: Scope, definition: WorkflowDefinition, state: RunExport, rawEvents: readonly RawEvent[], packets: readonly LoadedPacket[], map: LaneMap = laneMap(LEGACY_LANES), loop: FixLoop | null = null): RunSnapshot {
  const lastEvent = new Map<string, RawEvent>()
  const eventAttempt = new Map<string, number>()
  let lastController: RawEvent | undefined
  let lastFreezeRecord = 0
  for (const event of rawEvents) {
    if (event.node === 'controller' && EVENT_STATUS[event.status] !== undefined) lastController = event
    const node = eventGraphNode(definition, event, map)
    if (node === 'handoff') lastFreezeRecord = event.sequence
    if (!node) continue
    // Only a status-bearing event moves a node; a plain record (`stopped`, a note) never hides the last status, and a
    // controller starting (its PID row) says nothing about any node.
    if (EVENT_STATUS[event.status] !== undefined && !PID_ROW.test(event.message)) lastEvent.set(node, event)
    const attempt = attemptFromMessage(event.message)
    if (attempt !== null) eventAttempt.set(node, Math.max(attempt, eventAttempt.get(node) ?? 0))
  }
  const latestPacket = (phase: 'worker' | 'candidate', worker: string) => packets
    .filter(packet => packet.phase === phase && packet.node_id === worker).sort((a, b) => b.attempt - a.attempt)[0]
  const workers = new Set(packets.map(packet => packet.node_id))
  const handoffEvent = lastEvent.get('handoff')
  const handoffInterrupted = state.tasks.some(task => task.node_id === 'handoff' && task.interrupts.some(item => item.kind === 'worker_handoff'))
  const frozen = handoffInterrupted && handoffEvent !== undefined && EVENT_STATUS[handoffEvent.status] === 'succeeded'
  const handoffOpen = handoffInterrupted && !frozen
  const automatic = state.inputs?.mode === 'automatic'
  const waitingHandoff = (): NodeStatus => {
    const latest = [handoffEvent, lastController].filter(event => event !== undefined).sort((a, b) => b.sequence - a.sequence)[0]
    const latestStatus = latest ? EVENT_STATUS[latest.status] : undefined
    if (latestStatus === 'failed' || latestStatus === 'paused') return latestStatus
    return latest === handoffEvent && latestStatus === 'running' ? 'running' : 'pending'
  }
  const nodes = definition.nodes.map(node => {
    const task = state.tasks.find(candidate => candidate.node_id === node.node_id)
    const evidenced = map.workerOf.has(node.node_id) || node.node_id in TAIL_EVIDENCE_KEY
    const worker = map.workerOf.get(node.node_id)
    const workerPacket = worker ? latestPacket('worker', worker) : undefined
    let attempt = 0
    let session_id: string | null = null
    let result_uri: string | null = null
    if (worker) {
      if (workerPacket) {
        attempt = map.verifyNodes.has(node.node_id) ? workerPacket.attempt : 1
        result_uri = resultRoute(scope, state.run_id, 'worker', worker, workerPacket.attempt)
        const session = workerPacket.ok ? workerPacket.result.session_id : null
        session_id = typeof session === 'string' && session.length > 0 ? session : null
      }
      if (!map.verifyNodes.has(node.node_id)) {
        const receipt = laneValue(state.values, worker, 'launch')
        const session = receipt && typeof receipt === 'object' ? (receipt as Record<string, unknown>).session_id : null
        if (typeof session === 'string' && session.length > 0) session_id = session
      }
    }
    if (node.node_id === 'candidate') attempt = Math.max(0, ...packets.filter(packet => packet.phase === 'candidate').map(packet => packet.attempt))
    if (map.verifyNodes.has(node.node_id)) attempt = Math.max(attempt, eventAttempt.get(node.node_id) ?? 0)
    // The review node names its reviewer and links to the recorded result only from the export's review section, never from `values`.
    if (node.node_id === 'review' && state.review) {
      attempt = reviewAttempt(state.review, loop)
      session_id = redactPaths(state.review.reviewer_session_id)
      result_uri = reviewRoute(scope, state.run_id, attempt)
    }
    let status: NodeStatus
    const event = lastEvent.get(node.node_id)
    const eventStatus = event ? EVENT_STATUS[event.status] ?? null : null
    // The design challenge node is decided by the export's challenge record when there is one, never by `values`.
    const challenge = node.node_id === CHALLENGE_NODE ? state.inputs?.challenge ?? null : null
    if (challenge) { attempt = challenge.attempts; session_id = challenge.session_id }
    // A passed attempt the plan holds (C8) is paused until `resume --launch` records its release; challenge.json stays passed.
    if (challenge?.status === 'paused' || (challenge?.status === 'passed' && challenge.hold && challenge.hold.released_at === null)) status = 'paused'
    else if (challenge) status = 'succeeded'
    // A retried lane keeps the failed attempt's error on its checkpoint task until the graph moves on, while its newest packet
    // passed: a verified lane is not failed (the run showed `failed` through the whole candidate check after a retry).
    else if (task?.error && !(map.verifyNodes.has(node.node_id) && workerPacket?.ok && workerPacket.gate.status === 'passed')) status = 'failed'
    else if (frozen && node.node_id === 'handoff') status = 'succeeded'
    else if (handoffOpen && automatic && node.node_id === 'handoff') status = waitingHandoff()
    else if (task && task.interrupts.length > 0) status = 'awaiting_approval'
    else if (handoffOpen && worker && !map.verifyNodes.has(node.node_id) && hasEvidence(state, node.node_id, map) && lastFreezeRecord <= (event?.sequence ?? 0)) status = 'running'
    else if (hasEvidence(state, node.node_id, map)) {
      if (map.verifyNodes.has(node.node_id)) status = workerPacket?.ok && workerPacket.gate.status === 'passed' ? 'succeeded' : 'paused'
      else if (node.node_id === 'candidate') {
        const latest = [...workers].map(candidate => latestPacket('candidate', candidate)).filter(packet => packet !== undefined)
        status = latest.length > 0 && latest.every(packet => packet.ok && packet.gate.status === 'passed') ? 'succeeded' : 'paused'
      } else status = 'succeeded'
    } else if (eventStatus === 'succeeded') status = evidenced ? 'paused' : 'succeeded'
    else if (eventStatus) status = eventStatus
    else status = 'pending'
    if (status !== 'pending' && attempt === 0) attempt = 1
    // While the reviewers of round k > 1 run, review.json is archived and the review section is null: the attempt is the round.
    if (node.node_id === 'review' && !state.review && status !== 'pending' && archivedRounds(loop) > 0) attempt = 1 + archivedRounds(loop)
    if (status === 'pending') { attempt = 0; session_id = null; result_uri = null }
    // The combined candidate holds one verified result per lane; link each so its evidence (screenshots included) is reachable.
    const lane_results = node.node_id === 'candidate' && status !== 'pending'
      ? map.lanes.flatMap(lane => {
        const packet = latestPacket('candidate', lane)
        return packet ? [{ worker: lane, attempt: packet.attempt, result_uri: resultRoute(scope, state.run_id, 'candidate', lane, packet.attempt) }] : []
      })
      : []
    return { node_id: node.node_id, kind: node.kind, depends_on: [...node.depends_on], status, attempt, session_id, result_uri, lane_results }
  })
  // The steps a running repair re-enters read running (attempt and result unchanged), so the fold below keeps the run alive.
  const running = (loop?.repairs ?? []).filter(repair => REPAIR_RUNNING.has(repair.status))
  for (const node of nodes) {
    if (running.some(repair => repair.reentered_steps.includes(node.node_id))) node.status = 'running'
  }
  // A repair node's status never enters the run's status: the fold reads the pinned steps only.
  const statuses = new Set(nodes.map(node => node.status))
  const integrated = hasEvidence(state, 'integrate', map)
  // An abandoned run (its controller `cancelled` row, abandon.py) is closed whatever its steps read: it leaves the running lists.
  const abandoned = rawEvents.some(event => event.node === 'controller' && event.status === 'cancelled')
  let status: NodeStatus
  if (abandoned) status = 'cancelled'
  else if (statuses.has('failed')) status = 'failed'
  else if (statuses.has('awaiting_approval')) status = 'awaiting_approval'
  else if (statuses.has('paused')) status = 'paused'
  else if (integrated && state.next.length === 0 && !statuses.has('running') && !statuses.has('pending')) status = 'succeeded'
  else if (integrated) status = 'paused'
  else if (statuses.has('running') || state.next.length > 0) status = 'running'
  else if (statuses.size === 1 && statuses.has('pending')) status = 'pending'
  else status = 'paused'
  return { contract_version: '1.0.0', run_id: state.run_id, status, last_sequence: rawEvents.at(-1)?.sequence ?? 0, nodes: insertRepairs(nodes, loop, repairSnapshotNode) }
}

const REPAIR_RUNNING: ReadonlySet<RepairEntry['status']> = new Set(['launched', 'captured', 'recorded'])

/** The review attempt: the export's review round, else one plus the fix loop's archived rounds (a 1.9.0 export read live). */
function reviewAttempt(review: ReviewSection, loop: FixLoop | null): number {
  return review.round ?? 1 + archivedRounds(loop)
}

/** A repair node's status from its journal entry: launched, captured and recorded run; applied succeeded; blocked failed. */
function repairStatus(repair: RepairEntry): NodeStatus {
  return REPAIR_RUNNING.has(repair.status) ? 'running' : repair.status === 'applied' ? 'succeeded' : 'failed'
}

function repairSnapshotNode(repair: RepairEntry): RunSnapshot['nodes'][number] {
  const session = repair.session_id !== null && ID_PATTERN.test(repair.session_id) ? repair.session_id : null
  return { node_id: repair.node_id, kind: 'worker', depends_on: [repair.blocked_step], status: repairStatus(repair), attempt: 1, session_id: session, result_uri: null, lane_results: [] }
}

function repairDefinitionNode(repair: RepairEntry): WorkflowDefinition['nodes'][number] {
  return { node_id: repair.node_id, label: `Repair ${repair.lane} ${repair.n}`, kind: 'worker', depends_on: [repair.blocked_step] }
}

/** Inserts each repair node right after the step it answers (repairs of one step in journal order); nothing depends on them. */
function insertRepairs<T extends { node_id: string }>(nodes: readonly T[], loop: FixLoop | null, make: (repair: RepairEntry) => T): T[] {
  if (!loop || loop.repairs.length === 0) return [...nodes]
  return nodes.flatMap(node => [node, ...[...loop.repairs].sort((a, b) => a.n - b.n).filter(repair => repair.blocked_step === node.node_id).map(make)])
}

/** The definition with the loop's repair nodes; its revision is the pinned definition's, hashed before any round existed. */
function projectedDefinition(definition: WorkflowDefinition, loop: FixLoop | null): WorkflowDefinition {
  return loop && loop.repairs.length > 0 ? { ...definition, nodes: insertRepairs(definition.nodes, loop, repairDefinitionNode) } : definition
}

/** A loop is projectable only when every step it answers is a node of the pinned definition and no repair id collides with one. */
function checkLoopGraph(loop: FixLoop, definition: WorkflowDefinition): void {
  const known = new Set(definition.nodes.map(node => node.node_id))
  for (const repair of loop.repairs) {
    if (!known.has(repair.blocked_step)) throw new FixLoopError(`repair ${repair.n} answers ${repair.blocked_step}, which is not a step of this run`)
    if (known.has(repair.node_id)) throw new FixLoopError(`repair ${repair.n} collides with a node of this run`)
    for (const step of repair.reentered_steps) {
      if (!known.has(step)) throw new FixLoopError(`repair ${repair.n} re-enters ${step}, which is not a step of this run`)
    }
  }
}

// ---- The review sidecar's ledger (contract 1.6.0) --------------------------------------------------------------

/** Redacts a model-written text and keeps it within its bound (a redaction may lengthen a very short path). */
function boundedRedacted(text: string, limit: number): string {
  const redacted = redactPaths(text)
  if (redacted.length <= limit) return redacted
  let cut = limit
  const last = redacted.charCodeAt(cut - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1
  return redacted.slice(0, cut)
}

/** A ledger time with a trailing Z when it reads as one; anything else is served as written (no format check, Appendix B). */
function ledgerTime(value: string): string {
  return Number.isNaN(Date.parse(value)) ? value : utcTimestamp(value)
}

/**
 * The ledger (`<run>/sidecar.ledger.json` or the export's section) onto the contract: Appendix B's shape and bounds, this
 * run's id, path-redacted texts, Z times. Unknown keys are dropped. Returns the reason instead when it does not conform.
 */
function projectSidecarLedger(runId: string, raw: unknown, source: SidecarLedger['source']): { ledger: SidecarLedger } | { error: string } {
  const parsed = sidecarLedgerFileSchema.safeParse(raw)
  if (!parsed.success) return { error: `the ${source} ledger ${issueText(parsed.error)}` }
  const file: SidecarLedgerFile = parsed.data
  if (file.run_id !== runId) return { error: `the ${source} ledger names another run` }
  const note = (value: string | null) => value === null ? null : boundedRedacted(value, 1000)
  try {
    const ledger = validateSidecarLedger({
      contract_version: '1.6.0', node_id: SIDECAR_NODE, source,
      version: file.version, run_id: file.run_id, settings: { ...file.settings },
      passes: file.passes.map(pass => ({
        ...pass, started_at: ledgerTime(pass.started_at), finished_at: ledgerTime(pass.finished_at),
        lanes: Object.fromEntries(Object.entries(pass.lanes).map(([lane, read]) => [lane, { head_commit: read.head_commit, pane_captured: read.pane_captured }])),
        counts: { ...pass.counts }, summary: pass.summary === null ? null : boundedRedacted(pass.summary, 4000),
      })),
      findings: file.findings.map(finding => ({
        ...finding, file: boundedRedacted(finding.file, 512), locator: boundedRedacted(finding.locator, 1000),
        problem: boundedRedacted(finding.problem, 2000), evidence: boundedRedacted(finding.evidence, 2000), remedy: boundedRedacted(finding.remedy, 2000), note: note(finding.note),
        messages: [...finding.messages],
        history: finding.history.map(entry => ({ ...entry, evidence: boundedRedacted(entry.evidence, 2000), note: note(entry.note), at: ledgerTime(entry.at) })),
      })),
      messages: file.messages.map(message => ({ ...message, finding_ids: [...message.finding_ids], text: boundedRedacted(message.text, 2000), at: ledgerTime(message.at) })),
      escalations: file.escalations.map(escalation => ({ ...escalation, text: boundedRedacted(escalation.text, 2000), ...(escalation.at !== undefined ? { at: ledgerTime(escalation.at) } : {}) })),
      handoff: file.handoff === null ? null : Object.fromEntries(Object.entries(file.handoff).map(([list, entries]) => [list, entries.map(entry => boundedRedacted(entry, 4000))])),
      closed_at: file.closed_at === null ? null : ledgerTime(file.closed_at),
    })
    return { ledger }
  } catch (error) {
    return { error: `the ${source} ledger violates the contract (${error instanceof z.ZodError ? issueText(error) : (error as Error).message})` }
  }
}

// ---- The attack pass's record (contract 1.8.0) ----------------------------------------------------------------

/**
 * The record (`<run>/attack.json` or the export's section) onto the contract: Appendix A's shape and rules, this run's id,
 * path-redacted texts (the secret-file paths included), Z times. Unknown keys are dropped; `settings` must be exactly the
 * eight keys. Returns the reason instead when it does not conform.
 */
function projectAttack(runId: string, raw: unknown, source: AttackResult['source']): { result: AttackResult } | { error: string } {
  const parsed = attackRecordSchema.safeParse(raw)
  if (!parsed.success) return { error: `the ${source} record ${issueText(parsed.error)}` }
  const record: AttackRecord = parsed.data
  if (record.run_id !== runId) return { error: `the ${source} record names another run` }
  const text = (value: string) => boundedRedacted(value, 8000)
  const nullable = (value: string | null) => value === null ? null : text(value)
  const time = (value: string | null) => value === null ? null : ledgerTime(value)
  try {
    const result = validateAttackResult({
      contract_version: '1.8.0', node_id: ATTACK_NODE, source,
      version: record.version, run_id: record.run_id, candidate_commit: record.candidate_commit,
      settings: { ...record.settings, angles: [...record.settings.angles], requirements: [...record.settings.requirements], secret_files: record.settings.secret_files.map(redactPaths) },
      status: record.status, started_at: time(record.started_at), finished_at: time(record.finished_at), error: nullable(record.error),
      attackers: record.attackers.map(attacker => ({
        ...attacker, started_at: time(attacker.started_at), finished_at: time(attacker.finished_at), error: nullable(attacker.error),
        summary: nullable(attacker.summary), out_of_reach: attacker.out_of_reach.map(text),
        skeptic: { ...attacker.skeptic, started_at: time(attacker.skeptic.started_at), finished_at: time(attacker.skeptic.finished_at), error: nullable(attacker.skeptic.error) },
      })),
      findings: record.findings.map(finding => ({
        ...finding, title: text(finding.title), threat: text(finding.threat), requirement: nullable(finding.requirement),
        expected: text(finding.expected), observed: text(finding.observed),
        rerun: finding.rerun === null ? null : { ...finding.rerun, output_tail: redactPaths(finding.rerun.output_tail.split('\n').slice(-200).join('\n')), at: ledgerTime(finding.rerun.at) },
        skeptic: finding.skeptic === null ? null : { ...finding.skeptic, reason: text(finding.skeptic.reason) },
        labels: finding.labels.map(label => ({ ...label, note: nullable(label.note), at: ledgerTime(label.at) })),
      })),
    })
    return { result }
  } catch (error) {
    return { error: `the ${source} record violates the contract (${error instanceof z.ZodError ? issueText(error) : (error as Error).message})` }
  }
}

// ---- The multi-provider panel's record (contract 1.9.0) --------------------------------------------------------

/**
 * The record (`<run>/panel.json` or the export's `panels` section) onto the contract: Appendix A's shape and rules, path-
 * redacted texts (a finding's title, detail and file label, every error), Z times. Unknown keys are dropped. The record names
 * no run, so there is no foreign-file check. Returns the reason instead when it does not conform.
 */
function projectPanels(raw: unknown, source: PanelResults['source']): { result: PanelResults } | { error: string } {
  const parsed = panelRecordSchema.safeParse(raw)
  if (!parsed.success) return { error: `the ${source} record ${issueText(parsed.error)}` }
  const record: PanelRecord = parsed.data
  const text = (value: string) => boundedRedacted(value, 8000)
  const nullable = (value: string | null) => value === null ? null : text(value)
  const time = (value: string | null) => value === null ? null : ledgerTime(value)
  try {
    const result = validatePanelResults({
      contract_version: '1.9.0', source,
      version: record.version,
      panels: record.panels.map(panel => ({
        ...panel, started_at: time(panel.started_at), ended_at: time(panel.ended_at), error: nullable(panel.error),
        providers: panel.providers.map(provider => ({ ...provider, finding_ids: [...provider.finding_ids], error: nullable(provider.error) })),
        findings: panel.findings.map(finding => ({ ...finding, file: text(finding.file), title: text(finding.title), detail: text(finding.detail), providers_raised: [...finding.providers_raised] })),
      })),
    })
    return { result }
  } catch (error) {
    return { error: `the ${source} record violates the contract (${error instanceof z.ZodError ? issueText(error) : (error as Error).message})` }
  }
}

// ---- Run activity (contract 1.5.0) -----------------------------------------------------------------------------

/**
 * What the run waits on, by precedence: a question, a pane or an approval (triage's attention), else an interruption the
 * run page would name (6.2 rule 5), else the paused or failed run itself at its focus.
 */
function activityAttention(status: RunSnapshot['status'], attention: RunAttention, now: Now, focus: Focus | null): RunActivity['attention'] {
  const { top } = attention
  if (top) return { kind: top.kind, node_id: top.node_id, since: top.since }
  if (now.situation === 'interrupted') return { kind: 'interrupted', node_id: focus?.node_id ?? null, since: now.since }
  if (status === 'paused' || status === 'failed') return { kind: status, node_id: focus?.node_id ?? null, since: focus?.since ?? null }
  return null
}

/**
 * One line for a list row: the focus step's label and its last status message (a combined-check row names its lane), or,
 * when a controller row in scope stopped the run (6.2 reason source 0), that row. Without a focus (a finished run) the
 * step that recorded the last status speaks. Redacted, on one line, at most 160 characters.
 */
function activityHeadline(run: RunData, focus: Focus | null, now: Now): string | null {
  const controllerRow = now.reasonSource === 0 ? (now.reason ?? []).filter(part => typeof part === 'string').join('').trim() : ''
  // The review sidecar's rows never speak for the run (docs/PRD_REVIEW_SIDECAR.md 4.8), nor the report-only attack pass's
  // (docs/PRD_ATTACK_PASS.md 4.6): a run reads the same without them.
  const nodeId = focus?.node_id ?? run.events.findLast(event => event.node_id !== null && event.node_id !== SIDECAR_NODE && event.node_id !== ATTACK_NODE && event.status !== null)?.node_id ?? null
  let message = controllerRow
  if (!message && nodeId !== null) {
    const own = run.events.filter(event => event.node_id === nodeId)
    const row = own.findLast(event => event.status !== null) ?? own.at(-1)
    const lane = row ? /^\[([a-z][a-z0-9-]*)\] /.exec(row.message)?.[1] : undefined
    if (row) message = `${humanizeEvent(row)}${lane ? ` (${lane})` : ''}`
  }
  const label = nodeId === null ? null : run.detail.definition.nodes.find(node => node.node_id === nodeId)?.label ?? nodeId
  const text = redactPaths([label, message].filter(Boolean).join(' · ')).replace(/\s+/g, ' ').trim()
  if (!text) return null
  if (text.length <= HEADLINE_LIMIT) return text
  let cut = HEADLINE_LIMIT - 1
  const last = text.charCodeAt(cut - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1
  return `${text.slice(0, cut).trimEnd()}…`
}

/** `<lane>.questions.json` (guardrails.py save_questions) as the export's inputs section would serve it. */
const questionsFileSchema = z.object({
  questions: z.array(z.object({ n: z.number().int().positive(), question: z.string().min(1), asked_at: zonedTimestamp, answer: z.string().nullable(), answered_at: zonedTimestamp.nullable() })),
})

/** A lane's live question record, redacted like the export's; null when it is absent, oversized or malformed. */
async function readQuestions(directory: FileHandle, lane: string): Promise<WorkerQuestion[] | null> {
  let bytes: Buffer | null
  try {
    bytes = await readBounded(directory, [`${lane}.questions.json`], QUESTIONS_BYTE_LIMIT)
  } catch (error) {
    if (error instanceof ProjectApiError) return null
    throw error
  }
  if (bytes === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    return null
  }
  const file = questionsFileSchema.safeParse(parsed)
  if (!file.success) return null
  return file.data.questions.map(question => ({
    n: question.n, question: redactPaths(question.question), asked_at: utcTimestamp(question.asked_at),
    answer: optionalText(question.answer), answered_at: question.answered_at === null ? null : utcTimestamp(question.answered_at),
  }))
}

/** The run-inputs rules for questions: numbered from 1, at most three, an answer with its time, and only the latest waiting. */
function consistentQuestions(questions: readonly WorkerQuestion[]): boolean {
  return questions.length <= 3 && questions.every((question, index) => question.n === index + 1
    && (question.answer === null) === (question.answered_at === null) && (question.answer !== null || index === questions.length - 1))
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await fs.realpath(path)
  } catch {
    return null
  }
}

/** A `/proc` file's text (their sizes read as 0, so it is read to its end, bounded); null when it cannot be read. */
async function readProcFile(path: string): Promise<string | null> {
  let handle: FileHandle
  try {
    handle = await fs.open(path, constants.O_RDONLY)
  } catch {
    return null
  }
  try {
    const buffer = Buffer.alloc(PROC_FILE_LIMIT)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return buffer.subarray(0, offset).toString('utf8')
  } catch {
    return null
  } finally {
    await handle.close()
  }
}

/** When a process started, in epoch milliseconds: `stat` field 22 (clock ticks since boot) plus `btime` from `/proc/stat`. */
async function processStart(procRoot: string, pid: number): Promise<number | null> {
  const [stat, system] = await Promise.all([readProcFile(join(procRoot, String(pid), 'stat')), readProcFile(join(procRoot, 'stat'))])
  // The command name (field 2) may hold spaces and parentheses, so fields are counted from its last closing parenthesis:
  // the first one after it is field 3.
  const ticks = stat?.slice(stat.lastIndexOf(')') + 2).split(' ')[22 - 3]
  const boot = system === null ? undefined : /^btime (\d+)$/m.exec(system)?.[1]
  if (!ticks || !/^\d+$/.test(ticks) || !boot) return null
  return (Number(boot) + Number(ticks) / CLOCK_TICKS_PER_SECOND) * 1000
}

/**
 * The controller that logged its PID at `loggedAt`: `running` only while `/proc/<pid>` is an `automatic-step` whose
 * argument after it resolves to this run's directory and which started no later than it logged (so a reused PID never
 * reads running); `not_running` when the process is gone or runs something else; `unknown` without a readable `/proc`
 * or when the start time contradicts the row.
 */
async function controllerLiveness(procRoot: string, pid: number, loggedAt: string, runDir: string): Promise<'running' | 'not_running' | 'unknown'> {
  if (await readProcFile(join(procRoot, 'self', 'stat')) === null) return 'unknown'
  try {
    await fs.stat(join(procRoot, String(pid)))
  } catch (error) {
    return isMissing(error) ? 'not_running' : 'unknown'
  }
  const cmdline = await readProcFile(join(procRoot, String(pid), 'cmdline'))
  if (cmdline === null) return 'unknown'
  const argv = cmdline.split('\0')
  const step = argv.indexOf('automatic-step')
  const targets = step < 0 ? [] : await Promise.all(argv.slice(step + 1).filter(arg => isAbsolute(arg)).map(realpathOrNull))
  if (!targets.includes(runDir)) return 'not_running'
  const started = await processStart(procRoot, pid)
  if (started === null) return 'unknown'
  return started <= Date.parse(loggedAt) + START_TOLERANCE_MS ? 'running' : 'unknown'
}

/** Publishes a verified packet's result: scoped artifact links, no worktree paths, and a failed status when the gate did not pass. */
function projectWorkerResult(scope: Scope, runId: string, nodeId: string, packet: LoadedPacket & { ok: true }): WorkerResult {
  const raw = packet.result
  if (raw.run_id !== runId || raw.node_id !== packet.node_id || raw.attempt !== packet.attempt) {
    throw new ProjectApiError(500, 'EVIDENCE_MISMATCH', 'The verification packet result does not match its registration.')
  }
  const passed = packet.gate.status === 'passed'
  // A reused candidate packet's checks ran in its worker packet's worktree.
  const worktree = packet.reusedFrom !== null ? packet.reusedFrom.replace(/packet\.json$/, 'worktree') : `verification/${packet.phase}/${packet.node_id}/${packet.attempt}/worktree`
  const checks = Array.isArray(raw.checks) ? (raw.checks as Record<string, unknown>[]).map(check => ({ ...check, cwd: worktree })) : raw.checks
  const artifacts = Array.isArray(raw.artifacts) ? (raw.artifacts as Record<string, unknown>[]).map(artifact => ({
    ...artifact, uri: typeof artifact.artifact_id === 'string' ? `${runRoute(scope, runId)}/artifacts/${encodeURIComponent(artifact.artifact_id)}` : artifact.uri,
  })) : raw.artifacts
  const assumptions = Array.isArray(raw.open_assumptions) ? raw.open_assumptions.filter(item => typeof item === 'string' && item.trim().length > 0) : raw.open_assumptions
  const candidate = {
    contract_version: '1.0.0', run_id: runId, node_id: nodeId, attempt: packet.attempt, session_id: raw.session_id,
    status: passed ? raw.status : 'failed', base_commit: raw.base_commit, output_commit: raw.output_commit,
    changed_files: raw.changed_files, checks, open_assumptions: assumptions, artifacts,
    ...(packet.deferred.length > 0 ? { deferred_checks: packet.deferred } : {}),
    // Worker-phase captures list the changed paths not copied as `file` artifacts; older and candidate-phase results carry none.
    ...(raw.files_not_captured !== undefined ? { files_not_captured: raw.files_not_captured } : {}),
    summary: typeof raw.summary === 'string' ? redactPaths(raw.summary) : raw.summary,
    error: passed ? raw.error : { code: 'VERIFICATION_BLOCKED', message: redactPaths(packet.gate.reasons.join('; ')) || 'Verification did not pass.', retryable: true },
  }
  try {
    return validateWorkerResult(candidate)
  } catch (error) {
    throw new ProjectApiError(500, 'RESULT_INVALID', `The verification packet result does not conform to the worker result contract: ${error instanceof z.ZodError ? issueText(error) : (error as Error).message}`)
  }
}
