import { z } from 'zod'
import { artifactSchema, runSnapshotSchema } from '../workflow/v1.js'

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
const version = z.literal('1.0.0')
/**
 * Payloads added by contract 1.1.0 (review results), extended by 1.2.0 (finding links, run inputs), 1.3.0 (configured
 * worker lanes) and 1.4.0: the review result's `reviewers` (parallel reviewers) and the run inputs' guardrails
 * (decisions, the design challenge, completion evidence and worker questions). 1.5.0 adds the run summary's `activity`
 * and the run detail's `run_dir`; a summary that carries them says `contract_version: "1.5.0"`. 1.6.0 adds the review
 * sidecar's ledger (`sidecarLedger`). 1.7.0 adds the run inputs' optional `roles`, `controller` and `automatic.profile`, and the
 * challenge's optional `hold` (C8).
 */
const version140 = z.literal('1.4.0')
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

// ---- Run activity and the run directory (1.5.0) --------------------------------------------------------------------

/**
 * What a run waits on, by precedence: a worker's `question`, a worker or reviewer `pane` that needs attention, an
 * `approval`, then an `interrupted` controller, a `paused` or a `failed` run. The first three wait on the operator.
 */
export const ATTENTION_KINDS = ['question', 'pane', 'approval', 'interrupted', 'paused', 'failed'] as const
/** Whether the run's `automatic-step` controller process is alive, read from `/proc`; `unknown` when it cannot be told. */
export const CONTROLLER_STATES = ['running', 'not_running', 'unknown'] as const
const status = runSnapshotSchema.shape.status
const FINISHED_STATUSES: readonly string[] = ['succeeded', 'failed', 'cancelled']
const LIVE_STATUSES: readonly string[] = ['running', 'paused']

/**
 * A run's state for list rows (1.5.0), computed from the files a run detail reads plus each lane's live questions file,
 * with the rules of `triage.ts` the run page uses, so the two agree. `headline` is redacted and at most 160 characters.
 */
export const runActivitySchema = z.strictObject({
  /** The export's `inputs.feature`; null for exports without an inputs section. */
  feature: z.string().min(1).nullable(),
  /** The latest event that is not a controller PID checkpoint (or a later stop receipt or review verdict). */
  last_activity_at: timestamp.nullable(),
  /** A finished run's last non-controller activity; null while the run can still move. */
  finished_at: timestamp.nullable(),
  /** The first failed, paused or awaiting node in definition order, else the first running one. */
  focus: z.strictObject({ node_id: id, label: z.string().min(1), status, since: timestamp.nullable() }).nullable(),
  attention: z.strictObject({ kind: z.enum(ATTENTION_KINDS), node_id: id.nullable(), since: timestamp.nullable() }).nullable(),
  /** Lanes whose question waits on the operator, from each lane's live `<lane>.questions.json` over the export's record. */
  waiting_questions: z.number().int().nonnegative(),
  /** The focus step's label and its last status message, or the in-scope controller row that stopped the run. */
  headline: z.string().min(1).max(160).nullable(),
  /** Only while the run is running or paused and has logged a controller PID; null otherwise. */
  controller: z.enum(CONTROLLER_STATES).nullable(),
})

/**
 * A run directory as the registry's `viewer.expose_run_dir` serves it: home-relative, without `.` or `..` segments, and made
 * of characters a shell takes unquoted, so `RUN=<run_dir>` pastes as is. The server serves null for any other path.
 */
export const RUN_DIR_PATTERN = /^~(?!.*\/\.\.?(?:\/|$))\/[A-Za-z0-9._@+/-]+$/

export const runSummarySchema = z.strictObject({
  /** 1.5.0 carries `activity`; 1.0.0 (a server before it, and the viewer's worker-phase mocks) does not. */
  contract_version: z.enum(['1.0.0', '1.5.0']),
  ...scope,
  definition_revision: revision,
  run_id: id,
  status,
  created_at: timestamp,
  updated_at: timestamp,
  activity: runActivitySchema.optional(),
}).superRefine((summary, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message, path: ['activity'] })
  const { activity } = summary
  if ((summary.contract_version === '1.5.0') !== (activity !== undefined)) issue('A summary carries activity exactly when it is 1.5.0')
  if (!activity) return
  if (activity.finished_at !== null && !FINISHED_STATUSES.includes(summary.status)) issue('Only a finished run has a finish time')
  if (activity.controller !== null && !LIVE_STATUSES.includes(summary.status)) issue('The controller is read only while the run is running or paused')
  if ((activity.attention?.kind === 'question') !== (activity.waiting_questions > 0)) issue('Attention is a question exactly when a question waits')
})

export const runDetailSchema = z.strictObject({
  summary: runSummarySchema,
  definition: definitionSchema,
  snapshot: runSnapshotSchema,
  /** 1.5.0: the run directory, `~`-relative, for projects the registry lists in `viewer.expose_run_dir`; null otherwise. */
  run_dir: z.string().regex(RUN_DIR_PATTERN).nullable().optional(),
})

// ---- Review results (1.1.0, finding links 1.2.0, lanes from configuration 1.3.0, parallel reviewers 1.4.0) ----

/**
 * A worker lane ID as the verification policy declares it (`contracts/workflow/verification.schema.json` 1.2.0):
 * lower-case, at most 32 characters. `multiple` and `none` are the finding attributions that name no single lane;
 * the legacy `both` still appears in reviews recorded before 1.3.0 and is rendered as "multiple workers".
 */
export const LANE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
export const laneId = z.string().regex(LANE_ID_PATTERN)
/** Finding attributions that are not lane IDs. `both` is never written any more but is accepted from old exports. */
export const FINDING_ATTRIBUTIONS = ['multiple', 'none', 'both'] as const

/**
 * A reviewer ID as `features/<name>/feature.json` 2.1.0 declares it (same shape as a lane ID). A run without declared
 * reviewers, and every export recorded before 1.4.0, has exactly one reviewer named `review`.
 */
export const reviewerId = laneId
export const DEFAULT_REVIEWER_ID = 'review'
export const REVIEW_TRANSPORTS = ['native', 'print', 'manual'] as const
/**
 * What became of one reviewer: `accepted` (its file was accepted; with an approved verdict it is part of the approval),
 * `blocked` (its verdict, an unresolved P0/P1, a rejected file or its deadline blocked the run), `superseded` (the run was
 * decided while it was still working, and it was stopped) or `pending` (no verdict recorded yet).
 */
export const REVIEWER_STATUSES = ['accepted', 'blocked', 'superseded', 'pending'] as const

/** One reviewer finding. `worker`/`requirement` are null for reviews recorded before the reviewer prompt asked for them. */
export const reviewFindingSchema = z.strictObject({
  severity: z.enum(['P0', 'P1', 'P2']),
  message: z.string().min(1),
  disposition: z.enum(['open', 'resolved', 'accepted']),
  /** The lane the finding concerns, `multiple`, `none`, the legacy `both`, or null when unrecorded. */
  worker: laneId.nullable(),
  /** A verbatim quote from a worker's task text, as the reviewer wrote it. */
  requirement: z.string().min(1).nullable(),
  /** The worker lanes whose task text contains `requirement` verbatim; the backend never guesses a match. */
  requirement_found_in: z.array(laneId),
  /** The reviewer that reported it: one of `reviewers[].reviewer_id` (`review` for a single-reviewer run). Duplicates across reviewers are kept, never merged. */
  reviewer: reviewerId,
})

/** One reviewer of the review node (1.4.0). Findings are unioned in the combined list; this entry repeats the reviewer's own. */
export const reviewerEntrySchema = z.strictObject({
  reviewer_id: reviewerId,
  /** The run-wide transport; every reviewer of a run uses the same one. */
  transport: z.enum(REVIEW_TRANSPORTS),
  /** The Claude session UUID (native/print) or the operator-stated identity (manual); null only when the reviewer never got a session. */
  session_id: z.string().min(1).nullable(),
  /**
   * The controller's verdict for this reviewer, derived from its findings (C34); the verdict the reviewer wrote is `accepted_decision`
   * in its status file (a manual import keeps the imported file's verdict). Null when it produced none (deadline, superseded, or still working).
   */
  verdict: z.enum(['approved', 'blocked']).nullable(),
  findings: z.array(reviewFindingSchema),
  launched_at: timestamp.nullable(),
  accepted_at: timestamp.nullable(),
  status: z.enum(REVIEWER_STATUSES),
})

/** The persisted verdict of a run's review node, served at `.../runs/{run_id}/reviews/{attempt}`. */
export const reviewResultSchema = z.strictObject({
  contract_version: version140,
  run_id: id,
  node_id: z.literal('review'),
  attempt: z.number().int().positive(),
  reviewer: z.strictObject({
    /**
     * Native/print reviews: the Claude session UUID. Manual reviews: the operator-stated reviewer identity. With several
     * reviewers the combined record lists every session, comma-separated; `reviewers` is the per-reviewer record.
     */
    session_id: z.string().min(1),
    transport: z.enum(REVIEW_TRANSPORTS),
    independent: z.literal(true),
  }),
  bundle_sha256: revision,
  candidate_commit: commit,
  /** Unanimous: `approved` only when every reviewer approved without an unresolved P0/P1. */
  verdict: z.enum(['approved', 'blocked']),
  /** The union of every reviewer's findings, each tagged with its `reviewer`. */
  findings: z.array(reviewFindingSchema),
  /** Every reviewer of the run in declared order; exactly one entry named `review` for runs without declared reviewers and for exports before 1.4.0. */
  reviewers: z.array(reviewerEntrySchema).min(1),
  reviewed_at: timestamp,
  /** The diff the reviewers saw (`review.diff`), registered as a bounded patch artifact of the run, when present. */
  diff: artifactSchema.nullable(),
})

// ---- Run inputs (1.2.0, worker lanes from configuration in 1.3.0, guardrails in 1.4.0) --------------------------

const boundedText = z.strictObject({ text: z.string(), truncated: z.boolean() })
const assumptions = z.array(z.string().min(1))
export const CHECK_KINDS = ['build', 'typecheck', 'unit', 'integration', 'contract', 'browser'] as const

/** The status words of a worker's completion file; `question` (completion 1.1.0) asks the operator before finishing. */
export const COMPLETION_STATUSES = ['completed', 'blocked', 'question'] as const
/** Completion file versions: 1.0.0 for runs prepared before the guardrails, 1.1.0 (evidence and questions) for feature.json 2.2.0 runs. */
export const COMPLETION_VERSIONS = ['1.0.0', '1.1.0'] as const

/**
 * One question a worker asked with a `question` completion (1.4.0), in order from `n` 1. The worker's deadline was
 * paused while it waited; `answer` and `answered_at` are null while it still waits on the operator.
 */
export const workerQuestionSchema = z.strictObject({
  n: z.number().int().positive(),
  question: z.string().min(1),
  asked_at: timestamp,
  answer: z.string().min(1).nullable(),
  answered_at: timestamp.nullable(),
})

export const CHALLENGE_STATUSES = ['passed', 'paused', 'accepted', 'disabled'] as const
export const CHALLENGE_CONCERN_KINDS = ['assumption', 'failure_mode', 'complexity', 'other'] as const

/**
 * The design challenge of a feature.json 2.2.0 run (1.4.0): the latest `challenge.json` without `run_id` and `version`,
 * plus `attempts`. `passed` had no P0/P1 concern and launched the workers; `paused` has one and launched none; `accepted`
 * is a paused attempt the operator overrode with `accepted_reason`; `disabled` (attempt 0, no job) when the feature set
 * `challenge: false`.
 */
export const runChallengeSchema = z.strictObject({
  status: z.enum(CHALLENGE_STATUSES),
  /** The challenge job this record decides, from 1; 0 only when disabled. */
  attempt: z.number().int().nonnegative(),
  /** How many challenge jobs the run has run (earlier attempts are kept as `challenge-<n>.json`). */
  attempts: z.number().int().nonnegative(),
  session_id: z.string().min(1).nullable(),
  /** SHA-256 of the pinned inputs the job read; `prd_sha256` is null when the feature names no PRD. */
  pinned: z.strictObject({ tasks_sha256: revision, decisions_sha256: revision, prd_sha256: revision.nullable() }),
  concerns: z.array(z.strictObject({
    severity: z.enum(['P0', 'P1', 'P2']),
    kind: z.enum(CHALLENGE_CONCERN_KINDS),
    message: z.string().min(1),
    consequence: z.string().min(1),
  })),
  simpler_alternative: z.string().min(1).nullable(),
  cheap_experiment: z.string().min(1).nullable(),
  accepted_reason: z.string().min(1).nullable(),
  decided_at: timestamp,
  /**
   * 1.7.0 (C8): a passed attempt the plan holds until `resume --launch` (`launch --hold-challenge`, or profile attended): when it
   * was held and, once released, when, by whom and the note numbers left out of the workers' prompts. Null for every other
   * challenge (or absent, from a server before it). The status stays `passed` while held; the challenge node is served paused.
   */
  hold: z.strictObject({
    held_at: timestamp,
    released_at: timestamp.nullable(),
    released_by: z.enum(['operator', 'maintainer']).nullable(),
    dropped: z.array(z.number().int().positive()),
  }).nullable().optional(),
})

export const runInputWorkerSchema = z.strictObject({
  /** Logical worker lane (`ui`, `adapter`, `docs`, ...): the ID its results are served under. */
  node_id: laneId,
  /** The graph node that launched it (`launch_<node_id>`). */
  launch_node_id: id,
  /** A free label from the policy (`frontend`, `backend`, `docs`, ...); it no longer determines required checks. */
  role: z.string().min(1).max(40),
  /** The check kinds this lane must pass, from the policy (derived from the role for policies before 1.2.0). */
  required_check_kinds: z.array(z.enum(CHECK_KINDS)).min(1),
  /** The task text as pinned in the run plan (the authored assignment plus the appended ownership/checks JSON), rendered as Markdown. */
  task: boundedText,
  /** The exact prompt the native session received, when the run recorded it; null for runs that predate prompt capture. */
  prompt: boundedText.nullable(),
  owned_paths: z.array(relativePath),
  /** Check and scenario IDs are the policy's own labels (any non-empty string, e.g. `test:unit`), never route segments. */
  checks: z.array(z.strictObject({
    id: z.string().min(1),
    kind: z.enum(CHECK_KINDS),
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
  /** The worker's completion file as the controller reads it; null when there is none or the controller refuses it. */
  completion: z.strictObject({
    /** The version the run pinned and the file carries; exports before 1.5.0 only carry 1.0.0 completions. */
    version: z.enum(COMPLETION_VERSIONS),
    /** As the controller treats it: a `question` asked after the third is `blocked` (at most three are answered). */
    status: z.enum(COMPLETION_STATUSES),
    summary: z.string().min(1),
    open_assumptions: assumptions,
    /** Completion 1.1.0 evidence; all three are null for a 1.0.0 completion (runs prepared before the guardrails). */
    untested: z.array(z.string().min(1)).nullable(),
    /** The check that would fail if the work were wrong: a check ID of this lane or a command. */
    falsifying_check: z.string().min(1).nullable(),
    verify_yourself: z.string().min(1).nullable(),
    /**
     * The text of a question the controller has not recorded in `questions`: a `question` completion it has not polled yet,
     * or a fourth question, served as `blocked`. Null for every other completion.
     */
    question: z.string().min(1).nullable(),
  }).nullable(),
  handoff: z.strictObject({ summary: z.string().min(1), open_assumptions: assumptions }).nullable(),
  stop: z.strictObject({ stopped: z.boolean(), confirmed_at: timestamp.nullable() }).nullable(),
  /** Every question the worker asked, oldest first; `[]` when it asked none and for runs before 1.4.0. */
  questions: z.array(workerQuestionSchema),
})

/** How hard a role's sessions think: Claude Code's `--effort` levels. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
/** The profile of an automatic run (1.7.0): unattended when the launch named none. */
export const RUN_PROFILES = ['attended', 'unattended'] as const

/** One role's pins: a model (null: Claude Code's default, no `--model` passed) and an effort (null: none passed). */
const rolePinSchema = z.strictObject({ model: z.string().min(1).nullable(), effort: z.enum(EFFORT_LEVELS).nullable() })

/**
 * The roles a run pinned at prepare (1.7.0): the workers, and the judges (the design challenge, every reviewer and the review
 * sidecar). Null for runs prepared before roles, which passed the workers WORKFLOW_WORKER_EFFORT and the judges nothing.
 */
export const runRolesSchema = z.strictObject({ worker: rolePinSchema, judges: rolePinSchema })

/** The controller that prepared the run (1.7.0): its checkout's commit and dirty flag and `claude --version`; each null when unreadable. */
export const runControllerSchema = z.strictObject({
  commit: commit.nullable(),
  dirty: z.boolean().nullable(),
  claude_version: z.string().min(1).nullable(),
})

/** What a run was asked to do, served at `.../runs/{run_id}/inputs`; pinned from the run's own files. */
export const runInputsSchema = z.strictObject({
  contract_version: version140,
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
    /** 1.7.0: the profile the run pinned; null (or absent, from a server before 1.7.0) for runs pinned before profiles. */
    profile: z.enum(RUN_PROFILES).nullable().optional(),
  }).nullable(),
  setup: z.array(z.strictObject({ command: z.string().min(1), timeout_seconds: z.number().int().positive() })),
  max_verification_attempts: z.number().int().positive(),
  /** The lanes the run actually launched, in policy order; `workers` describes exactly these. */
  selected_workers: z.array(laneId).min(1),
  /** Declared lanes the launch left out; their owned paths stayed off-limits and they have no node in the run. */
  excluded_workers: z.array(laneId),
  workers: z.array(runInputWorkerSchema).min(1),
  /** The `decisions.md` text pinned at prepare (Markdown); null for runs without one (feature.json before 2.2.0). */
  decisions: z.string().nullable(),
  /** The design challenge; null for runs without one (feature.json before 2.2.0). */
  challenge: runChallengeSchema.nullable(),
  /** 1.7.0: the roles' pinned models and efforts; null (or absent, from a server before 1.7.0) for runs prepared before roles. */
  roles: runRolesSchema.nullable().optional(),
  /** 1.7.0: the controller that prepared the run; null (or absent) for runs prepared before the record. */
  controller: runControllerSchema.nullable().optional(),
})

// ---- Review sidecar ledger (1.6.0) ------------------------------------------------------------------------------

/** The pass triggers, statuses and the finding, message and escalation vocabularies of the ledger (PRD_REVIEW_SIDECAR Appendix B). */
export const SIDECAR_TRIGGERS = ['cadence', 'completion', 'final', 'manual'] as const
export const SIDECAR_PASS_STATUSES = ['completed', 'rejected', 'failed', 'timed_out', 'interrupted'] as const
export const SIDECAR_CATEGORIES = ['defect', 'risk', 'structure', 'operational', 'suggestion'] as const
export const SIDECAR_SEVERITIES = ['P0', 'P1', 'P2'] as const
export const SIDECAR_DISPOSITIONS = ['open', 'acknowledged', 'fix_reported', 'verified_resolved', 'withdrawn', 'accepted_trade_off'] as const
/** A finding with one of these dispositions is still open; the others are closed (`verified_resolved`, `withdrawn`, `accepted_trade_off`). */
export const SIDECAR_OPEN_DISPOSITIONS = ['open', 'acknowledged', 'fix_reported'] as const
/** `pending` only between the controller's merge write and its delivery write. */
export const SIDECAR_MESSAGE_STATUSES = ['pending', 'delivered', 'undeliverable', 'refused'] as const
export const SIDECAR_MESSAGE_REASONS = [
  'question_waiting', 'lane_finished', 'lane_not_launched', 'rate_limited', 'after_freeze', 'lane_blocked', 'pane_busy', 'pane_unknown',
  'pane_not_attached', 'herdr_unavailable', 'herdr_timeout', 'interrupted',
] as const
export const SIDECAR_ESCALATION_KINDS = ['security', 'data_loss', 'architecture'] as const
/** The handoff the final pass writes: five lists of strings. */
export const SIDECAR_HANDOFF_LISTS = ['unresolved', 'structural', 'verified_resolved', 'withdrawn', 'gaps'] as const

/**
 * Appendix B's field rules, shared with `contracts/workflow/sidecar.schema.json` 1.0.0: every id, sha, revision, lane and
 * time is a non-empty string with no format check; `locator` and `evidence` may be empty; `note`, `summary`, a pass's
 * `session_id`, a message's `reason`, `handoff` and `closed_at` are the only nullable fields; texts are bounded as the engine
 * bounds them; arrays may be empty; no reference is resolved (a message's finding ids, a history entry's pass). Objects are
 * not strict: a key the engine adds is dropped, never a reason to refuse the ledger.
 */
const sidecarId = z.string().min(1)
const sidecarTime = z.string().min(1)
const sidecarCount = z.number().int().nonnegative()
const sidecarNote = z.string().max(1000).nullable()

export const sidecarPassSchema = z.object({
  n: z.number().int().positive(),
  trigger: z.enum(SIDECAR_TRIGGERS),
  started_at: sidecarTime,
  finished_at: sidecarTime,
  status: z.enum(SIDECAR_PASS_STATUSES),
  session_id: sidecarId.nullable(),
  /** Per lane read: the head commit as `git rev-parse` printed it and whether its pane text was captured. */
  lanes: z.record(sidecarId, z.object({ head_commit: sidecarId, pane_captured: z.boolean() })),
  counts: z.object({ new: sidecarCount, changed: sidecarCount, messages: sidecarCount }),
  summary: z.string().max(4000).nullable(),
})

export const sidecarHistoryEntrySchema = z.object({
  pass: z.number().int().positive(),
  disposition: z.enum(SIDECAR_DISPOSITIONS),
  revision: sidecarId,
  evidence: z.string().max(2000),
  note: sidecarNote,
  at: sidecarTime,
})

/** A finding as it stands: its own fields are its latest values, `history[0]` holds the values it was created with. */
export const sidecarFindingSchema = z.object({
  id: sidecarId,
  category: z.enum(SIDECAR_CATEGORIES),
  severity: z.enum(SIDECAR_SEVERITIES),
  lane: sidecarId,
  file: z.string().min(1).max(512),
  locator: z.string().max(1000),
  revision: sidecarId,
  problem: z.string().min(1).max(2000),
  evidence: z.string().max(2000),
  remedy: z.string().min(1).max(2000),
  disposition: z.enum(SIDECAR_DISPOSITIONS),
  note: sidecarNote,
  /** The ids of the messages sent for it. */
  messages: z.array(sidecarId),
  history: z.array(sidecarHistoryEntrySchema),
})

export const sidecarMessageSchema = z.object({
  id: sidecarId,
  pass: z.number().int().positive(),
  lane: sidecarId,
  finding_ids: z.array(sidecarId).min(1),
  text: z.string().min(1).max(2000),
  status: z.enum(SIDECAR_MESSAGE_STATUSES),
  reason: z.enum(SIDECAR_MESSAGE_REASONS).nullable(),
  at: sidecarTime,
})

/** Appendix B pins only the output's escalation (`finding_id`, `kind`, `text`); the stored entry may add the pass and its time. */
export const sidecarEscalationSchema = z.object({
  finding_id: sidecarId,
  kind: z.enum(SIDECAR_ESCALATION_KINDS),
  text: z.string().min(1).max(2000),
  pass: z.number().int().positive().optional(),
  at: sidecarTime.optional(),
})

const handoffList = z.array(z.string().max(4000))

/** `<run>/sidecar.ledger.json` as the controller writes it (Appendix B, `contracts/workflow/sidecar.schema.json` 1.0.0). */
export const sidecarLedgerFileSchema = z.object({
  version: z.literal('1.0.0'),
  run_id: sidecarId,
  settings: z.object({
    cadence_seconds: z.number().int().min(60).max(7200),
    pass_timeout_seconds: z.number().int().min(60).max(3600),
    max_passes: z.number().int().min(1).max(64),
    max_messages_per_lane: z.number().int().min(0).max(20),
  }),
  passes: z.array(sidecarPassSchema),
  findings: z.array(sidecarFindingSchema),
  messages: z.array(sidecarMessageSchema),
  escalations: z.array(sidecarEscalationSchema),
  handoff: z.object({
    unresolved: handoffList, structural: handoffList, verified_resolved: handoffList, withdrawn: handoffList, gaps: handoffList,
  }).nullable(),
  closed_at: sidecarTime.nullable(),
})

/**
 * The review sidecar's ledger, served at `.../runs/{run_id}/sidecar` (1.6.0): the ledger's own fields plus where it was read,
 * `live` (`<run>/sidecar.ledger.json`, written while the workers run) or `export` (the export's `sidecar` section, the fallback).
 */
export const sidecarLedgerSchema = sidecarLedgerFileSchema.extend({
  contract_version: z.literal('1.6.0'),
  node_id: z.literal('sidecar'),
  source: z.enum(['live', 'export']),
})

export const schemas = {
  projectList: z.strictObject({ projects: z.array(projectSchema) }),
  workflowList: z.strictObject({ workflows: z.array(definitionSchema) }),
  runList: z.strictObject({ runs: z.array(runSummarySchema), next_cursor: z.string().min(1).nullable() }),
  runDetail: runDetailSchema,
  reviewResult: reviewResultSchema,
  runInputs: runInputsSchema,
  sidecarLedger: sidecarLedgerSchema,
}

export type Project = z.infer<typeof projectSchema>
export type WorkflowDefinition = z.infer<typeof definitionSchema>
export type RunSummary = z.infer<typeof runSummarySchema>
export type RunActivity = z.infer<typeof runActivitySchema>
export type RunDetail = z.infer<typeof runDetailSchema>
export type ReviewFinding = z.infer<typeof reviewFindingSchema>
export type ReviewerEntry = z.infer<typeof reviewerEntrySchema>
export type ReviewResult = z.infer<typeof reviewResultSchema>
export type RunInputWorker = z.infer<typeof runInputWorkerSchema>
export type WorkerQuestion = z.infer<typeof workerQuestionSchema>
export type RunChallenge = z.infer<typeof runChallengeSchema>
export type RunInputs = z.infer<typeof runInputsSchema>
export type SidecarLedgerFile = z.infer<typeof sidecarLedgerFileSchema>
export type SidecarLedger = z.infer<typeof sidecarLedgerSchema>
export type SidecarFinding = z.infer<typeof sidecarFindingSchema>
export type SidecarMessage = z.infer<typeof sidecarMessageSchema>
export type SidecarPass = z.infer<typeof sidecarPassSchema>
export type SidecarEscalation = z.infer<typeof sidecarEscalationSchema>

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
  if ((detail.summary.contract_version === '1.5.0') !== (detail.run_dir !== undefined)) throw new Error('A run detail carries run_dir exactly when its summary is 1.5.0')
  const activity = detail.summary.activity
  if (activity) {
    const focus = activity.focus
    if (focus && detail.snapshot.nodes.find(node => node.node_id === focus.node_id)?.status !== focus.status) throw new Error('The focus names a node of the run in its snapshot status')
    if (activity.attention?.node_id && !definitions.has(activity.attention.node_id)) throw new Error('Attention names a node of the run')
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
  const reviewerIds = result.reviewers.map(entry => entry.reviewer_id)
  if (new Set(reviewerIds).size !== reviewerIds.length) throw new Error('Duplicate reviewer IDs')
  const sessions = result.reviewers.map(entry => entry.session_id).filter(session => session !== null)
  if (new Set(sessions).size !== sessions.length) throw new Error('Reviewers must be distinct sessions')
  if (result.reviewers.some(entry => entry.transport !== result.reviewer.transport)) throw new Error('Every reviewer uses the run-wide transport')
  if (result.verdict === 'approved' && result.reviewers.some(entry => entry.verdict !== 'approved')) throw new Error('An approved review requires every reviewer\'s approval')
  for (const entry of result.reviewers) {
    if (entry.verdict === 'approved' && entry.findings.some(isBlockingFinding) && result.verdict === 'approved') throw new Error(`Reviewer ${entry.reviewer_id} approved with an unresolved P0/P1 finding`)
    if (entry.status === 'accepted' && entry.verdict === null) throw new Error(`Reviewer ${entry.reviewer_id} was accepted without a verdict`)
    const own = result.findings.filter(finding => finding.reviewer === entry.reviewer_id)
    if (JSON.stringify(own) !== JSON.stringify(entry.findings)) throw new Error(`Reviewer ${entry.reviewer_id} findings differ from the combined list`)
  }
  for (const finding of result.findings) {
    if (!reviewerIds.includes(finding.reviewer)) throw new Error(`Finding names reviewer "${finding.reviewer}", which is not a reviewer of this review`)
    if (new Set(finding.requirement_found_in).size !== finding.requirement_found_in.length) throw new Error('Duplicate requirement match lanes')
    if (finding.requirement === null && finding.requirement_found_in.length > 0) throw new Error('A finding without a requirement quote cannot match a task')
    if (finding.requirement_found_in.some(lane => (FINDING_ATTRIBUTIONS as readonly string[]).includes(lane))) throw new Error('Requirement matches name lanes, not attributions')
  }
  return result
}

export function validateRunInputs(input: unknown): RunInputs {
  const inputs = runInputsSchema.parse(input)
  if ((inputs.mode === 'automatic') !== (inputs.automatic !== null)) throw new Error('Automatic settings are present exactly for automatic runs')
  if (new Set(inputs.workers.map(worker => worker.node_id)).size !== inputs.workers.length) throw new Error('Duplicate worker IDs')
  if (new Set(inputs.workers.map(worker => worker.launch_node_id)).size !== inputs.workers.length) throw new Error('Duplicate launch node IDs')
  if (JSON.stringify(inputs.selected_workers) !== JSON.stringify(inputs.workers.map(worker => worker.node_id))) throw new Error('selected_workers must list exactly the described workers in order')
  if (new Set(inputs.excluded_workers).size !== inputs.excluded_workers.length) throw new Error('Duplicate excluded worker IDs')
  if (inputs.excluded_workers.some(lane => inputs.selected_workers.includes(lane))) throw new Error('A lane cannot be both selected and excluded')
  for (const lane of [...inputs.selected_workers, ...inputs.excluded_workers]) {
    if ((FINDING_ATTRIBUTIONS as readonly string[]).includes(lane)) throw new Error(`"${lane}" is a finding attribution, not a lane`)
  }
  for (const worker of inputs.workers) {
    for (const kind of worker.required_check_kinds) {
      if (!worker.checks.some(check => check.kind === kind)) throw new Error(`${worker.node_id} requires a ${kind} check it does not declare`)
    }
    if (new Set(worker.required_check_kinds).size !== worker.required_check_kinds.length) throw new Error(`Duplicate required check kinds for ${worker.node_id}`)
    if (new Set(worker.checks.map(check => check.id)).size !== worker.checks.length) throw new Error(`Duplicate check IDs for ${worker.node_id}`)
    for (const check of worker.checks) {
      if ((check.kind === 'browser') !== (check.scenarios.length > 0)) throw new Error(`Browser checks need scenarios and other checks must not have them (${check.id})`)
      if (new Set(check.scenarios.map(scenario => scenario.id)).size !== check.scenarios.length) throw new Error(`Duplicate scenario IDs in ${check.id}`)
    }
    if (worker.stop !== null && !worker.stop.stopped && worker.stop.confirmed_at !== null) throw new Error('An unconfirmed stop has no confirmation time')
    worker.questions.forEach((question, index) => {
      if (question.n !== index + 1) throw new Error(`Questions of ${worker.node_id} must be numbered 1, 2, ... in order`)
      if ((question.answer === null) !== (question.answered_at === null)) throw new Error(`Question ${question.n} of ${worker.node_id} needs both an answer and its time, or neither`)
      if (question.answer === null && index !== worker.questions.length - 1) throw new Error(`Only the latest question of ${worker.node_id} can be waiting`)
    })
    if (worker.questions.length > 3) throw new Error(`${worker.node_id} has more than three questions; a fourth is treated as blocked`)
    const completion = worker.completion
    if (completion !== null) {
      if (completion.version === '1.0.0' && (completion.status === 'question' || [completion.untested, completion.falsifying_check, completion.verify_yourself, completion.question].some(value => value !== null))) {
        throw new Error(`The 1.0.0 completion of ${worker.node_id} has no evidence and no question`)
      }
      if (completion.status === 'question' && (completion.question === null || worker.questions.length >= 3)) {
        throw new Error(`A question completion of ${worker.node_id} has its text and follows fewer than three questions; a fourth is served as blocked`)
      }
      if (completion.question !== null && completion.status !== 'question' && !(completion.status === 'blocked' && worker.questions.length === 3)) {
        throw new Error(`Only a question completion of ${worker.node_id}, or a fourth question served as blocked, has a question`)
      }
    }
  }
  const challenge = inputs.challenge
  if (challenge !== null) {
    if ((challenge.status === 'accepted') !== (challenge.accepted_reason !== null)) throw new Error('An accepted challenge, and only one, has a reason')
    if (challenge.status === 'disabled') {
      if (challenge.attempt !== 0 || challenge.session_id !== null || challenge.concerns.length > 0) throw new Error('A disabled challenge ran no job')
    } else {
      if (challenge.attempt < 1 || challenge.session_id === null || challenge.simpler_alternative === null || challenge.cheap_experiment === null) throw new Error('A challenge job has an attempt, a session and its findings')
      const blocking = challenge.concerns.some(concern => concern.severity === 'P0' || concern.severity === 'P1')
      if (challenge.status === 'passed' && blocking) throw new Error('A passed challenge has no P0/P1 concern')
      if (challenge.status !== 'passed' && !blocking) throw new Error(`A ${challenge.status} challenge has a P0/P1 concern`)
    }
    if (challenge.attempts < challenge.attempt) throw new Error('A challenge cannot decide an attempt it has not run')
  }
  return inputs
}

/**
 * The served ledger's cross-field rules. Like the engine's schema it resolves no reference (a message may cite a finding the
 * ledger does not hold); it only refuses what the viewer could not show unambiguously: two findings, messages or passes
 * sharing an id or number.
 */
export function validateSidecarLedger(input: unknown): SidecarLedger {
  const ledger = sidecarLedgerSchema.parse(input)
  const unique = (values: readonly (string | number)[], what: string) => {
    if (new Set(values).size !== values.length) throw new Error(`Duplicate ${what}`)
  }
  unique(ledger.findings.map(finding => finding.id), 'finding ids')
  unique(ledger.messages.map(message => message.id), 'message ids')
  unique(ledger.passes.map(pass => pass.n), 'pass numbers')
  return ledger
}
