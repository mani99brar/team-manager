/**
 * Run triage (PRD_VIEWER_UX sections 5 and 6): the pure model behind the run page's Now banner, Steps table and
 * Activity list, the node pages' attempt strips and the server's run-list activity. No React and no I/O, so the client
 * and the server import the same rules and the list headline and the run page agree by construction.
 *
 * It reads only served contract payloads: the run detail, its events, the run inputs, the review and worker results by
 * URI. Where the controller records nothing (a print review's start, an approval, a candidate lane's start) the value is
 * inferred and says so (`source: 'inferred'`). Next steps are RUNBOOK commands with the `"$PY"` and `"$RUN"`
 * placeholders; every other value the viewer cannot know (a feature name, a run id, a commit, a reason) stays a `<…>`
 * placeholder. Nothing here runs a command or changes a run.
 */
import { isBlockingFinding, type FixLoopReviewRound, type RepairEntry, type ReviewResult, type RunDetail, type RunInputs, type RunInputWorker } from './v1.ts'
import type { WorkerResult, WorkflowEvent } from '../workflow/v1.ts'

export type NodeStatus = RunDetail['snapshot']['status']
type NodeKind = RunDetail['definition']['nodes'][number]['kind']

/** Everything the triage model reads about one run. Only `detail` and `events` are required; the rest refines the answer. */
export type RunData = {
  detail: RunDetail
  events: readonly WorkflowEvent[]
  inputs?: RunInputs | null
  review?: ReviewResult | null
  /** Immutable worker and candidate results keyed by their result URI (`…/results/<lane>/<k>`, `…/results/candidate_<lane>/<k>`). */
  results?: ReadonlyMap<string, WorkerResult>
}

// ---- Timeline types (5.1) ------------------------------------------------------------------------------------------

/** Where a time comes from; the UI shows the source in a tooltip and prefixes inferred values with `≈`. */
export type InstantSource = 'event' | 'receipt' | 'check' | 'review' | 'inferred'
export type Instant = { at: string; source: InstantSource; note?: string }
/** A node status, or `no_record` for an attempt a later attempt replaced before any verdict was recorded. */
export type SpanStatus = NodeStatus | 'no_record'

/** One attempt of one node (for the candidate: of one lane). `end` is null while it runs; `ms` is null until both ends are known. */
export type Span = {
  node_id: string
  lane: string | null
  attempt: number
  start: Instant | null
  end: Instant | null
  ms: number | null
  status: SpanStatus
  /** The humanized message that closed the span (or, while it runs, the latest one). */
  outcome: string
  live: boolean
  /** The result this attempt produced, when its URI is known (verify attempts, matched candidate lanes). */
  result_uri: string | null
  /** 5.2 rule 8, when the attempt's result is loaded: attempt start → first check start, first check start → last check finish. */
  split: { setup_ms: number; checks_ms: number } | null
}

export type MarkerKind = 'diagnosis' | 'repair' | 'controller_start' | 'controller_error' | 'controller_blocked' | 'interrupted' | 'question' | 'answer' | 'log'

/** A moment that is not a node status: controller rows (5.2 rules 2 and 5) and worker questions and answers (rule 7). */
export type Marker = {
  kind: MarkerKind
  at: string
  /** The event it came from; null for question and answer rows read from the run inputs. */
  sequence: number | null
  /** The node it concerns: a diagnosis or repair names the lane's verify or candidate node; null for the controller itself. */
  node_id: string | null
  lane: string | null
  /** A controller row: served without a node, or (before B1) aliased onto a lane named `controller`. */
  run_level: boolean
  /** The controller wrote it as `blocked` (served `failed` with B1): 6.2 reason source 0. */
  blocked: boolean
  message: string
  raw: string
  /** A repair: the operator's `--commit` repair as the timeline shows it, or (`session`) an in-run repair session of the fix loop with its round and trigger. */
  repair?: { n: number; snapshot: string | null; files: string[]; session?: true; round?: number; trigger?: 'verify' | 'candidate' | 'review' }
  /** A `controller_blocked` row's cause when a blocked repair session of the fix loop explains it (the loop was exhausted). */
  cause?: { node_id: string; repair_n: number; lane: string }
  question?: { n: number; text: string; asked_at: string; answered_at: string | null; wait_ms: number | null; live: boolean; exported: boolean }
}

/** A silence over two minutes, classified by what surrounds it (5.2 rule 6). `lanes` are the workers it overlaps. */
export type GapKind = 'operator' | 'controller_down' | 'waiting_worker' | 'idle'
export type Gap = { kind: GapKind; from: string; to: string; ms: number; lanes: string[] }

/** One Activity row, oldest first. `controller_log` rows (PID checkpoints) sit behind the "Controller log (n)" toggle. */
export type ActivityRow = {
  at: string
  source: InstantSource
  sequence: number | null
  node_id: string | null
  lane: string | null
  attempt: number | null
  kind: 'start' | 'end' | 'update' | 'marker' | 'gap'
  status: SpanStatus | null
  marker: MarkerKind | null
  text: string
  /** The served message, for the expander; null for rows built from receipts, the review or the inputs. */
  raw: string | null
  /** The closed span's duration on `end` rows, the silence on `gap` rows. */
  ms: number | null
  inferred: boolean
  controller_log: boolean
  gap: Gap | null
}

export type Timeline = {
  runStart: Instant
  /** The last non-controller activity of a finished run (never `updated_at`); null while the run can still move. */
  runEnd: Instant | null
  /** The latest moment that is not a PID checkpoint, with its humanized text in `note`. */
  lastActivity: Instant | null
  spans: Span[]
  markers: Marker[]
  gaps: Gap[]
  byNode: ReadonlyMap<string, Span[]>
  activity: ActivityRow[]
}

// ---- Now types (6.1, 6.2) -----------------------------------------------------------------------------------------

/** The `run-now[data-situation]` ids, in the order `deriveNow` checks them (6.2). */
export type Situation = 'question' | 'pane_attention' | 'awaiting_approval' | 'challenge_held' | 'challenge_paused' | 'interrupted' | 'blocked_before_freeze'
  | 'blocked_identical' | 'check_failed' | 'review_blocked' | 'running' | 'succeeded' | 'inactive' | 'no_rule_matched'

/**
 * Rich text: plain strings and times the UI renders in the viewer's zone (`clock` as `<time>`), relative to its ticking
 * clock (`ago`, `elapsed`, `left`) or as a duration (`span`). `textToString` flattens it for tests and plain text.
 */
export type TextPart = string
  | { kind: 'clock'; at: string; inferred?: boolean }
  | { kind: 'ago'; at: string }
  | { kind: 'span'; ms: number; inferred?: boolean }
  | { kind: 'elapsed'; from: string }
  | { kind: 'left'; until: string }
export type Text = TextPart[]

/** A RUNBOOK.md heading (`section`, exact text) and, optionally, a bold paragraph label inside it (`topic`). */
export type RunbookRef = { section: string; topic: string | null }
/** One numbered step: a copyable command (with an optional lead-in caption) or plain text. */
export type Step = { kind: 'command'; text: string; caption?: string } | { kind: 'text'; text: string }
/**
 * The "Likely next step" block. `required`: the run waits on the operator; `none`: nothing is needed (any command is
 * optional); `unknown`: no rule matched and only `status` is offered.
 */
export type NextStep = { action: 'required' | 'none' | 'unknown'; label: string; runbook: RunbookRef[]; steps: Step[]; caveat: string | null }

export type Focus = { node_id: string; label: string; kind: NodeKind; status: NodeStatus; since: string | null }
/** B2 `activity.controller`, as polled; the client keeps the readings of recent polls for the 15 s rule. */
export type ControllerState = 'running' | 'not_running' | 'unknown' | null
export type ControllerReading = { at: string; value: ControllerState }
/** The part of B2 `RunSummary.activity` the triage reads, when the server serves it. */
export type ServedActivity = { waiting_questions?: number; attention?: { kind: string; node_id: string | null; since: string | null } | null }

export type Now = {
  situation: Situation
  /** Rule 5's case: (a) a controller row, (b) the focus node's own note, (c) the controller not running, (d) a repair not yet continued. */
  interruption: 'a' | 'b' | 'c' | 'd' | null
  tone: 'failed' | 'blocked' | 'paused' | 'interrupted' | 'waiting' | 'running' | 'succeeded' | 'inactive'
  glyph: '✗' | '‖' | '?' | '●' | '✓' | '○'
  focus: Focus | null
  /** The lane (or comma-separated lanes) the situation concerns, when it concerns lanes. */
  lane: string | null
  since: string | null
  headline: Text
  reason: Text | null
  /**
   * 6.2 reason sources: 0 controller row, 1 review, 2 lane result, 3 the worker's completion, 4 the focus node's last
   * message (for a focus with none, the failed dependency row that opened the scope window).
   */
  reasonSource: 0 | 1 | 2 | 3 | 4 | null
  next: NextStep
  /** Result URIs the rules would read but were not given (among `nowResultUris(detail, events)`): fetch them and derive again. */
  missing: string[]
}
export type NowInput = RunData & { controller?: readonly ControllerReading[]; activity?: ServedActivity | null }

export type AttentionKind = 'question' | 'pane' | 'approval'
export type Attention = { kind: AttentionKind; node_id: string; lane: string | null; since: string | null; detail: string }
/** `top` follows the precedence question > pane > approval; `nodes` carries each node's own kind for `data-attention`. */
export type RunAttention = { top: Attention | null; nodes: ReadonlyMap<string, Attention> }

export type GateReason = {
  /** The segment as served, e.g. `unit: no passing test evidence or failed tests`. */
  text: string
  /** Without its `<check id>: ` prefix. */
  reason: string
  /** The check id its prefix names; null for a gate-level reason. */
  check_id: string | null
  /** For a gate-level reason: the one check whose command ends with the text after `<path>`, else null. */
  attached_to: string | null
}
export type GateReasons = { reasons: GateReason[]; gate: GateReason[]; byCheck: ReadonlyMap<string, GateReason[]> }
export type AttemptResultUri = { lane: string; phase: 'worker' | 'candidate'; attempt: number; uri: string }
export type LaneLine = { lane: string; steps: { node_id: string; step: 'worker' | 'verify' | 'candidate'; status: NodeStatus; text: string }[] }

// ---- Command wording (6.1) ----------------------------------------------------------------------------------------

/** The one-line caption of every command block. */
export const COMMAND_CAPTION = 'Run these in your terminal; this viewer never changes a run.'
/** The `$PY/$RUN` legend of a command block without a served run directory. */
export const COMMAND_LEGEND = 'PY: md-manager\'s .venv/bin/python, run from its checkout. RUN: this run\'s directory, <runs root of this workflow>/<run id>; the viewer does not serve the path by default.'
/** A worker gets at most three answered questions (guardrails.py MAX_QUESTIONS). */
export const MAX_QUESTIONS = 3
/** `activity.controller` must read `not_running` for this long before the viewer believes it (6.3). */
export const CONTROLLER_DEBOUNCE_MS = 15_000
/** A silence longer than this becomes a gap row (5.2 rule 6). */
export const GAP_MS = 120_000

/** The gate actions (workflow/actor.py, C17): each requires `--by`, and the commands the viewer offers are the operator's. */
const GATES: ReadonlySet<string> = new Set(['start', 'automatic', 'retry', 'reconcile', 'approve', 'resume', 'answer', 'repair', 'tryout'])
export const BY_OPERATOR = '--by operator'
const workflow = (verb: string, ...args: string[]) => ['"$PY" -m workflow', verb, '"$RUN"', ...args, ...(GATES.has(verb) ? [BY_OPERATOR] : [])].join(' ')
const command = (text: string, caption?: string): Step => caption ? { kind: 'command', text, caption } : { kind: 'command', text }
const prose = (text: string): Step => ({ kind: 'text', text })

const RUNBOOK = {
  launch: { section: 'One-command launch', topic: null },
  questions: { section: 'Guardrails (feature.json 2.2.0)', topic: 'Worker questions' },
  challenge: { section: 'Guardrails (feature.json 2.2.0)', topic: 'The design challenge' },
  contract: { section: '1. Define and commit the feature contract', topic: null },
  interact: { section: '3. Start and interact (explicit model usage)', topic: null },
  handoff: { section: '4. Explicit handoff, freeze and verification', topic: null },
  review: { section: '5. Review the exact candidate', topic: null },
  reviewerPanes: { section: 'Automatic mode: the review step', topic: 'Reviewer panes' },
  reviewInterruption: { section: 'Automatic mode: the review step', topic: 'Interruption' },
  verdict: { section: 'Automatic mode: the review step', topic: 'Verdict' },
  approve: { section: '6. Approve local integration', topic: null },
  recovery: { section: 'Status, failures and recovery', topic: null },
  failedVerification: { section: 'Status, failures and recovery', topic: 'Failed verification' },
  failedCandidate: { section: 'Status, failures and recovery', topic: 'Failed combined check' },
  changedCode: { section: 'Status, failures and recovery', topic: 'Changed code' },
  unavailable: { section: 'Status, failures and recovery', topic: 'Claude Code unavailable (exit 75)' },
  stopping: { section: 'Status, failures and recovery', topic: 'Stopping an unfinished run' },
  sourceBranch: { section: 'Status, failures and recovery', topic: 'Source feature branch changed' },
  ambiguousStartup: { section: 'Status, failures and recovery', topic: 'Ambiguous startup' },
  repair: { section: 'Blocked after freeze: repair a lane', topic: null },
  tryout: { section: 'Tryouts and the untried-feature limit (feature.json 2.4.0 `tryout`)', topic: 'Try it' },
} satisfies Record<string, RunbookRef>

// ---- Controller message patterns (workflow/*.py) --------------------------------------------------------------------

/** automatic.py:1244, logged by each `automatic-step` child. */
const PID_ROW = /^Automatic checkpoint controller PID (\d+)/
const ERRNO_ROW = /^\[Errno \d+\]/
/** automatic.py:1288, the freeze's cleanup after a controller block. */
const STOP_UNCONFIRMED = /^Could not confirm worker stop: /
/** automatic.py:983 (`<phase>/<lane>`), written by advance_or_block as a `blocked` controller row (:1011). */
const IDENTICAL = /\b(worker|candidate)\/([a-z][a-z0-9-]*) failed identically on attempts (\d+) and (\d+)/
/** repair.py:450 and :442; the actor (C17) is the operator, or the maintainer before the rule refused it, maybe via Claude Code. */
const REPAIR_APPLIED = /^Repair (\d+) applied/
const REPAIR_BY_OPERATOR = /^Repair (\d+) by the (?:operator|maintainer)(?: \(via a Claude Code session\))?: snapshot ([0-9a-f]+) = [^(]*\(([^)]*)\)/
/** repair.py:109-114: the continuation a repair names for its run's mode. */
const CONTINUE_WITH = /Continue with python -m workflow (automatic|retry)\b/
/** automatic.py RESUME_NOTE (:1116) and UNAVAILABLE_NOTE (:1121). */
const INTERRUPTED_ROW = /^Supervisor interrupted|Claude Code was unavailable/
/** UNAVAILABLE_NOTE, and the outage errors a node's own note quotes (sessions.py:272, interactive.py:63). */
const UNAVAILABLE = /Claude Code (?:was |is )?unavailable|Claude session inventory unavailable/
/** REVIEW_RESUME_NOTE (:337) and FREEZE_RESUME_NOTE (:1194), recorded on the review node or the freeze. */
const NODE_RESUME_NOTE = /interrupted|resume with: python -m workflow automatic/
const FREEZE_NOTE = /The freeze was stopping the workers/
/**
 * automatic.py resumable_stop: drive stops before any step, stops and relaunches nothing, and records a `controller`
 * `interrupted` row naming what comes before `automatic --live`: the run's source checkout (its own worktree since per-run
 * checkouts; the target checkout for older runs) switched back to the run's source branch
 * (source_branch_note), or a start that did not complete reconciled, or started when the run never was (start_note).
 */
const BRANCH_CHANGED = /^Source feature branch changed\b/
const START_INCOMPLETE = /^Automatic supervision requires a completed start\b/
const NEVER_STARTED = /\bthe run was never started\b/
/** automatic.py record_blocked: the reason drive gives before a stop it does not retry. */
const CONTROLLER_BLOCKED = /^Controller blocked: /
/**
 * automatic.py final_stop: off the source branch, a check that reached its attempt limit and workers stopped when their wait
 * failed are said bare, without CONTROLLER_BLOCKED's prefix, as advance_or_block and the failed wait say them. Then the failed
 * wait's own texts: wait_handoffs' (a lane's deadline, an explicit block, an unrecorded question, a fourth question from
 * guardrails.py record_question, a missing session) and read_signal's refusals (`Invalid completion` covers `Invalid completion file for`).
 */
const BARE_STOPS = [/^Verification retry limit exhausted\b/, /^Handoff changed after stop intent\b/, /^Invalid completion\b/,
  /^Worker \S+ (deadline exhausted|explicitly blocked|asked a question that is not recorded yet)\b/, /^Native worker missing\b/,
  /^Worker \S+ asked question \d+; at most \d+ are answered\b/,
  /^Malformed completion signal\b/, /^Stale or foreign worker completion signal\b/, /^Completion version \S+ refused\b/]
/**
 * automatic.py note_controller_drift: a `controller` `warning` row before the PID row when a step runs another controller commit
 * than prepare pinned. `warning` is no event status, so it is served without one: a note, never a block.
 */
const CONTROLLER_DRIFT = /^Controller commit [0-9a-f]+ runs this step\b/
/** pipeline.py action_event: who ran a gate action (C17), a log line. */
const ACTION_ROW = /^(?:Start|Automatic|Retry|Reconcile|Approve|Resume) by the (?:operator|maintainer)\b/
/** abandon.py (C30): the `cancelled` row of a run the operator abandoned. */
const ABANDONED_ROW = /^Abandoned by the (?:operator|maintainer)\b/
/** pipeline.py prepare: the launch's notes (C23, C27), recorded before any lane launches. */
const LAUNCH_NOTES = /^Launch notes: /
/** tryout.py (C7): the operator's tryout verdict, a `controller` `note` (served with no status), a log line. */
const TRYOUT_ROW = /^Tryout recorded by the (?:operator|maintainer)\b/
/**
 * Node-less rows that are no block: the controller's running rows, and C17's action rows (raw status note, served with no status).
 * Any other node-less row without a status was `blocked` (before B1).
 */
const RUNNING_ROWS = [PID_ROW, /^Rerunning /, /^Resuming /, REPAIR_APPLIED, /^Design challenge disabled/, /^Failure drill skipped/, ACTION_ROW, CONTROLLER_DRIFT, LAUNCH_NOTES, TRYOUT_ROW]
/** B1's controller-process patterns: on a lane named `controller` these rows belong to the controller, not the lane. */
const CONTROLLER_LANE_ROWS = [PID_ROW, INTERRUPTED_ROW, IDENTICAL, REPAIR_APPLIED, ERRNO_ROW, BRANCH_CHANGED, START_INCOMPLETE, CONTROLLER_BLOCKED, ACTION_ROW, CONTROLLER_DRIFT, ABANDONED_ROW, ...BARE_STOPS, LAUNCH_NOTES, TRYOUT_ROW]
/** notes.py send_note: a note's delivery, recorded on the lane. It says nothing of the lane's state, so it neither clears a pane nor closes a span's outcome. */
const NOTE_ROW = /^Note N-\d+ from the (?:operator|maintainer)\b/
/** automatic.py:281 (workers) and :556 (reviewers). */
const PANE = /needs attention in its pane( \([^)]*\))?/
const PANE_REVIEWER = /^Reviewer (\S+) needs attention in its pane/
/** guardrails.py:760 and :751 (a fourth question blocks the run). */
const QUESTION_EVENT = /^Worker (\S+) asked question (\d+) of \d+;[^`]*`[^`]*`: ([\s\S]*)$/
const FOURTH_QUESTION = /^Worker (\S+) asked question \d+; at most \d+ are answered, so it is treated as blocked: ([\s\S]*)$/
const ATTEMPT = /\battempt (\d+)/i
const COMMIT = /\b[0-9a-f]{40}\b/
/**
 * pipeline.py's second event of a lane's candidate verdict: the gate's reasons (`Candidate gate blocked on attempt <k>: …`),
 * or a pass after the attempt before failed. A note on the verdict before it, carrying its status: never a verdict itself.
 */
const CANDIDATE_NOTE = /^(?:\[[a-z][a-z0-9-]*\] )?Candidate gate /
const CONTROLLER_LANE_NODE = 'launch_controller'
/**
 * The review sidecar's node (docs/PRD_REVIEW_SIDECAR.md 4.8): an advisor beside the lanes, never what the run is doing. It
 * never takes the focus from another running step, is left out of the running headline, of the last activity, of attention,
 * of the scope's parents and of gap classification, so a run's activity reads the same with and without it.
 */
export const SIDECAR_NODE_ID = 'sidecar'
/**
 * The attack pass's node (docs/PRD_ATTACK_PASS.md 4.6, Appendix A): report-only beside the review. Like the sidecar it is left
 * out of the last activity, attention, the scope's parents, gap classification and the running headline; unlike the sidecar it
 * never takes the focus, not even when it is the only step still running (the review decided and the controller waits for
 * the pass), so the run's headline, Now banner and current step stay the review's.
 */
export const ATTACK_NODE_ID = 'attack'
/** The nodes whose rows never speak for the run: the review sidecar and the attack pass. */
const ADVISORY_NODE_IDS: ReadonlySet<string | null> = new Set([SIDECAR_NODE_ID, ATTACK_NODE_ID])

// ---- Small helpers ------------------------------------------------------------------------------------------------

const ms = (iso: string) => Date.parse(iso)
const latestOf = (times: readonly (string | null | undefined)[]) => times.reduce<string | null>((a, b) => !b ? a : a === null || ms(b) > ms(a) ? b : a, null)
const TERMINAL: ReadonlySet<SpanStatus> = new Set(['succeeded', 'failed', 'paused', 'cancelled'])
const FINISHED_RUN: ReadonlySet<NodeStatus> = new Set(['succeeded', 'failed', 'cancelled'])
const GLYPH: Record<NodeStatus, string> = { pending: '○', running: '●', awaiting_approval: '?', paused: '‖', succeeded: '✓', failed: '✗', cancelled: '○' }

/** The fix loop's session repairs served on the run detail (export 1.10.0); [] without a loop and in its error form. */
function repairsOf(detail: RunDetail): readonly RepairEntry[] {
  return detail.fixLoop?.repairs ?? []
}

function roundsOf(detail: RunDetail): readonly FixLoopReviewRound[] {
  return detail.fixLoop?.review_rounds ?? []
}

function repairOf(detail: RunDetail, nodeId: string): RepairEntry | undefined {
  return repairsOf(detail).find(repair => repair.node_id === nodeId)
}

function laneOf(nodeId: string): string | null {
  return nodeId.startsWith('launch_') || nodeId.startsWith('verify_') ? nodeId.slice('launch_'.length) : null
}

function runRoute(detail: RunDetail): string {
  const { project_id, workflow_id, run_id } = detail.summary
  return `/api/projects/${encodeURIComponent(project_id)}/workflows/${encodeURIComponent(workflow_id)}/runs/${encodeURIComponent(run_id)}`
}

function resultUri(detail: RunDetail, phase: 'worker' | 'candidate', lane: string, attempt: number): string {
  return `${runRoute(detail)}/results/${encodeURIComponent(phase === 'worker' ? lane : `candidate_${lane}`)}/${attempt}`
}

function lanesOf(run: Pick<RunData, 'detail' | 'inputs'>): string[] {
  return run.inputs?.selected_workers ?? run.detail.definition.nodes.flatMap(node => node.node_id.startsWith('launch_') ? [node.node_id.slice('launch_'.length)] : [])
}

function labelOf(detail: RunDetail, nodeId: string): string {
  return detail.definition.nodes.find(node => node.node_id === nodeId)?.label ?? nodeId
}

function snapshotNode(detail: RunDetail, nodeId: string) {
  return detail.snapshot.nodes.find(node => node.node_id === nodeId)
}

function workerOf(inputs: RunInputs | null | undefined, lane: string | null): RunInputWorker | undefined {
  return lane === null ? undefined : inputs?.workers.find(worker => worker.node_id === lane)
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function firstSentence(text: string): string {
  return text.split(/(?<=[.!?])\s/)[0]
}

// ---- humanizeEvent (5.3) ------------------------------------------------------------------------------------------

type Phrase = [RegExp, (...groups: string[]) => string]
const PHRASES: Phrase[] = [
  [/^Awaiting explicit completion signal; idle is not acceptance$/, () => 'waiting for the worker\'s completion signal (idle is not acceptance)'],
  [/^Launching or reconciling the exact native session$/, () => 'launching the native session'],
  [PID_ROW, pid => `controller started (PID ${pid})`],
  [/^Attempt (\d+); revision (\S+)$/, (k, revision) => `attempt ${k} started · revision ${revision}`],
  // The retry, then C27's slow note, follow the checks; C28's reuse note or the slow note follow a combined revision.
  [/^Required tests and artifacts passed; recorded for the candidate gate: (.+?)(?:; (passed on attempt \d+ after attempt \d+ failed))?(?:; (slow: .+))?$/,
    (checks, retry, slow) => `passed · ${checks} gated at the candidate${retry ? ` · ${retry}` : ''}${slow ? ` · ${slow}` : ''}`],
  [/^Combined revision (\S+)(?:; (.+))?$/, (revision, note) => `combined revision ${revision}${note ? ` · ${note}` : ''}`],
  [/^Candidate gate blocked on attempt (\d+): (.+)$/, (k, reasons) => `gate blocked on attempt ${k}: ${reasons}`],
  [/^Candidate gate passed on attempt (\d+) after attempt (\d+) failed$/, (k, before) => `gate passed on attempt ${k} after attempt ${before} failed`],
  [/^Fast-forwarded to (\S+); no push performed$/, commit => `fast-forwarded to ${commit} · no push performed`],
  [/^Immutable snapshots captured; worker-reported checks are not trusted$/, () => 'snapshots captured (worker-reported checks are not trusted)'],
  [/^Native workers stopped before snapshot capture: (.+)$/, lanes => `workers stopped before snapshot capture: ${lanes}`],
  [/^Design challenge attempt (\d+): one print job, session (\S+)$/, (k, session) => `attempt ${k} started (print job, session ${session})`],
  [/^Feature files re-pinned for design challenge attempt (\d+) on base (\S+)$/, (k, base) => `attempt ${k} started after re-pinning the feature files (base ${base})`],
  [/^Design challenge attempt (\d+) passed \((\d+) (P\d) concern\(s\)\); launching workers$/, (k, n, severity) => `attempt ${k} passed · ${n} ${severity} ${Number(n) === 1 ? 'concern' : 'concerns'}`],
  [/^Design challenge attempt (\d+) passed \((\d+) (P\d) concern\(s\)\); held for the operator$/, (k, n, severity) => `attempt ${k} passed · ${n} ${severity} ${Number(n) === 1 ? 'concern' : 'concerns'} · held for you`],
  [/^Design challenge attempt (\d+) passed \((\d+) (P\d) concern\(s\)\) and is held for the operator before any worker launch$/,
    (k, n, severity) => `attempt ${k} held for you: ${n} ${severity} ${Number(n) === 1 ? 'concern' : 'concerns'}; no worker launched`],
  [/^Design challenge attempt (\d+) paused the run before any worker launch: (\d+) P0\/P1 concern\(s\)$/,
    (k, n) => `attempt ${k} paused the run: ${n} P0/P1 ${Number(n) === 1 ? 'concern' : 'concerns'}; no worker launched`],
  [/^KeyboardInterrupt$/, () => 'interrupted (KeyboardInterrupt)'],
  [/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?:, [0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})*$/, () => 'verdict recorded'],
  [/^\[Errno (\d+)\] No such file or directory: (.+)$/, (n, what) => `[Errno ${n}] ${what} not found`],
  [/^(?:worker|candidate)\/([a-z][a-z0-9-]*) (failed identically on attempts \d+ and \d+); not transient, inspect \S+ ?(.*)$/, (lane, what, rest) => `${lane} ${what}; not transient. ${rest}`.trim()],
  [/^Repair (\d+) by the (?:operator|maintainer)(?: \(via a Claude Code session\))?: snapshot (\S+) = (\S+) \+ (\S+) on \S+ \S+ \(([^)]*)\)[\s\S]*$/,
    (n, snapshot, base, fix, files) => `repair ${n}: snapshot ${snapshot} = ${base} + ${fix} (${plural(files.split(', ').length, 'file')})`],
]
/** 40/64-character SHAs and 8-character abbreviations; session UUIDs are matched first and kept whole. */
const HASHES = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b(?=[0-9a-f]*[a-f])[0-9a-f]{8,64}\b/g

/** An event message for people: known controller phrases reworded, the `[<lane>] ` B1 prefix dropped, SHAs cut to 7 characters. */
export function humanizeEvent(event: Pick<WorkflowEvent, 'message'>): string {
  const message = event.message.replace(/^\[[a-z][a-z0-9-]*\] /, '')
  let text = message
  for (const [pattern, render] of PHRASES) {
    const match = pattern.exec(message)
    if (match) { text = render(...match.slice(1)); break }
  }
  return text.replace(HASHES, hash => hash.includes('-') ? hash : hash.slice(0, 7))
}

// ---- Event classification (5.2 rules 1, 2 and 5) ------------------------------------------------------------------

type Row = {
  event: WorkflowEvent
  /** The node whose history it belongs to; null for controller rows (see `Marker.run_level`). */
  node: string | null
  status: NodeStatus | null
  /** Rule 1: re-read from the message, else null (the served `event.attempt` is case-sensitive before B1). */
  attempt: number | null
  marker: MarkerKind | null
  blocked: boolean
  text: string
}

function classify(detail: RunDetail, events: readonly WorkflowEvent[]): Row[] {
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence)
  const lastPid = Math.max(0, ...sorted.filter(event => PID_ROW.test(event.message)).map(event => event.sequence))
  const lastSucceeded = new Map<string, number>()
  for (const event of sorted) if (event.node_id && event.status === 'succeeded') lastSucceeded.set(event.node_id, event.sequence)
  const nodeStatus = new Map(detail.snapshot.nodes.map(node => [node.node_id, node.status]))
  return sorted.map(event => {
    const message = event.message
    // An [Errno] failure the controller came back from (a later checkpoint, or the node succeeded after all) is its own error, not a verdict.
    const recovered = lastPid > event.sequence || (event.node_id !== null
      && (nodeStatus.get(event.node_id) === 'succeeded' || (lastSucceeded.get(event.node_id) ?? 0) > event.sequence))
    const row = (marker: MarkerKind | null, node: string | null, status: NodeStatus | null, blocked = false): Row => ({
      event, node, status, marker, blocked, attempt: marker ? null : Number(ATTEMPT.exec(message)?.[1] ?? NaN) || null, text: humanizeEvent(event),
    })
    const runLevel = event.node_id === null || (event.node_id === CONTROLLER_LANE_NODE && CONTROLLER_LANE_ROWS.some(pattern => pattern.test(message)))
    if (PID_ROW.test(message)) return row('controller_start', null, null)
    if (runLevel) {
      // Before B1 a node-less row has no status; with B1 the controller's own status is kept (blocked → failed, interrupted → paused).
      const status = event.status
      if (IDENTICAL.test(message)) return row('diagnosis', null, status, true)
      if (REPAIR_APPLIED.test(message)) return row('repair', null, status)
      if (INTERRUPTED_ROW.test(message) || status === 'paused') return row('interrupted', null, status)
      if (ERRNO_ROW.test(message) && recovered) return row('controller_error', null, status)
      if (status === 'failed' || (status === null && !RUNNING_ROWS.some(pattern => pattern.test(message)))) return row('controller_blocked', null, status, true)
      return row('log', null, status)
    }
    if (event.status === 'failed' && recovered && (ERRNO_ROW.test(message) || STOP_UNCONFIRMED.test(message))) return row('controller_error', event.node_id, null)
    return row(null, event.node_id, event.status)
  })
}

function statusRows(rows: readonly Row[], nodeId: string): Row[] {
  return rows.filter(row => row.node === nodeId && row.status !== null && row.marker === null)
}

/** An automatic run: from the run inputs, else from the controller's PID checkpoints. */
function automaticRun(run: Pick<RunData, 'inputs'>, rows: readonly Row[]): boolean {
  return run.inputs ? run.inputs.mode === 'automatic' : rows.some(row => row.marker === 'controller_start')
}

/**
 * The row that re-entered a node the server still serves failed: a retried check, a resumed freeze or review. A failed
 * task keeps its graph error until the step that re-enters it ends (`retry_check` clears nothing), so the step runs
 * while its node, and the run, read failed. The row counts while it is the node's latest status row and, in an
 * automatic run, no controller started after it: automatic-step exits only once its step ended, so a later PID row
 * means the step ended without a verdict row. A manual run has no such row, so there only a retry counts (an earlier
 * attempt of the node failed).
 */
function reentered(detail: RunDetail, rows: readonly Row[], nodeId: string, automatic: boolean): Row | null {
  if (snapshotNode(detail, nodeId)?.status !== 'failed') return null
  const own = statusRows(rows, nodeId)
  const latest = own.at(-1)
  if (latest?.status !== 'running') return null
  const ended = automatic ? rows.some(row => row.marker === 'controller_start' && row.event.sequence > latest.event.sequence)
    : !own.some(row => row.status === 'failed')
  return ended ? null : latest
}

/**
 * The attempt whose verdict a failed verify node shows: its latest, or while a retry runs (`reentered`), the latest one
 * with a recorded failure before it (0 when there is none). `running` is the retry's opening row.
 */
function verdictAttempt(detail: RunDetail, rows: readonly Row[], nodeId: string, automatic: boolean): { attempt: number; running: Row | null } {
  const running = reentered(detail, rows, nodeId, automatic)
  if (!running) return { attempt: snapshotNode(detail, nodeId)?.attempt ?? 0, running: null }
  const failed = statusRows(rows, nodeId).filter(row => row.status === 'failed' && row.event.sequence < running.event.sequence).at(-1)
  return { attempt: failed ? failed.attempt ?? failed.event.attempt : 0, running }
}

// ---- buildTimeline (5.1, 5.2) -------------------------------------------------------------------------------------

type Internal = { rows: Row[]; lastActivityText: string | null }
const INTERNAL = new WeakMap<Timeline, Internal>()
const TIMELINES = new Map<string, { key: readonly unknown[]; timeline: Timeline }>()
const TIMELINE_CACHE_SIZE = 32

/**
 * The run's history as spans (one per node attempt), markers, gaps and Activity rows. Memoized per run on the served
 * state (last sequence, node states, the event count, and the inputs, review and results objects by identity), so a
 * poll that brings nothing new returns the same object. Treat the result as read-only.
 */
export function buildTimeline(run: RunData): Timeline {
  const { summary, snapshot, definition } = run.detail
  const id = `${summary.project_id}/${summary.workflow_id}/${summary.run_id}`
  const key = [snapshot.last_sequence, snapshot.status, snapshot.nodes.map(node => `${node.status}:${node.attempt}:${node.result_uri ?? ''}`).join(','),
    definition.definition_revision, fixLoopKey(run.detail), summary.created_at, run.events.length, run.events.at(-1)?.sequence, run.inputs ?? null, run.review ?? null, run.results ?? null]
  const cached = TIMELINES.get(id)
  if (cached && cached.key.every((value, index) => value === key[index])) return cached.timeline
  const timeline = computeTimeline(run)
  TIMELINES.delete(id)
  TIMELINES.set(id, { key, timeline })
  if (TIMELINES.size > TIMELINE_CACHE_SIZE) TIMELINES.delete(TIMELINES.keys().next().value!)
  return timeline
}

/** What of the fix loop the timeline reads, as one comparable value (the detail's objects are new on every poll). */
function fixLoopKey(detail: RunDetail): string {
  return [...repairsOf(detail).map(repair => `${repair.n}:${repair.status}:${repair.recorded_at}`), ...roundsOf(detail).map(round => `r${round.round}:${round.archived}:${round.started_at}:${round.restored_at ?? ''}`)].join(',')
}

function newSpan(nodeId: string, lane: string | null, attempt: number, start: Instant | null): Span {
  return { node_id: nodeId, lane, attempt, start, end: null, ms: null, status: 'running', outcome: '', live: false, result_uri: null, split: null }
}

function close(span: Span, status: SpanStatus, end: Instant, outcome: string) {
  span.status = status
  span.end = end
  span.outcome = outcome
  span.ms = span.start ? Math.max(0, ms(end.at) - ms(span.start.at)) : null
}

function reviewOutcome(review: ReviewResult): string {
  const counts = (['P0', 'P1', 'P2'] as const).map(severity => [severity, review.findings.filter(finding => finding.severity === severity).length] as const)
    .filter(([, count]) => count > 0).map(([severity, count]) => `${count} ${severity}`)
  const who = review.verdict === 'blocked'
    ? `blocked by ${review.reviewers.filter(entry => entry.status === 'blocked').map(entry => entry.reviewer_id).join(', ') || 'review'}`
    : `approved by ${review.reviewers.map(entry => entry.reviewer_id).join(' and ')}`
  return [who, ...counts].join(' · ')
}

/** An archived review round in the words of `reviewOutcome`: who blocked it and its findings by severity. */
function roundOutcome(round: FixLoopReviewRound): string {
  const counts = (['P0', 'P1', 'P2'] as const).map(severity => [severity, round.findings.filter(finding => finding.severity === severity).length] as const)
    .filter(([, count]) => count > 0).map(([severity, count]) => `${count} ${severity}`)
  const blockers = round.reviewers.filter(entry => entry.verdict === 'blocked').map(entry => entry.reviewer_id)
  const who = round.verdict === 'blocked' ? `blocked by ${blockers.join(', ') || round.lane}` : `approved by ${round.reviewers.map(entry => entry.reviewer_id).join(' and ') || 'review'}`
  return [`round ${round.round} ${who}`, ...counts].join(' · ')
}

function computeTimeline(run: RunData): Timeline {
  const { detail, inputs, review } = run
  const results = run.results ?? new Map<string, WorkerResult>()
  const rows = classify(detail, run.events)
  const spans: Span[] = []
  const open = new Map<string, Span>()
  const last = new Map<string, Span>()
  const openedBy = new Map<number, Span>()
  const closedBy = new Map<number, Span>()
  const reused = new Set<number>()
  const statusOf = (nodeId: string) => snapshotNode(detail, nodeId)?.status ?? 'pending'
  const at = (row: Row): Instant => ({ at: row.event.occurred_at, source: 'event' })
  const receiptWorkers = new Set((inputs?.workers ?? []).filter(worker => worker.launch).map(worker => worker.launch_node_id))
  const candidateRows: Row[] = []

  // Rule 3: running opens a span for (node, attempt); the next terminal status closes it; a new attempt closes an open one as "no record".
  for (const row of rows) {
    const node = row.node
    if (!node || !row.status || row.marker || receiptWorkers.has(node)) continue
    if (node === 'candidate') {
      // A gate note restates the verdict before it: matched to no lane result, never "reused", no span of its own.
      if (!CANDIDATE_NOTE.test(row.event.message)) candidateRows.push(row)
      continue
    }
    const current = open.get(node)
    const previous = last.get(node)
    if (row.status === 'running' || row.status === 'awaiting_approval') {
      if (!current && previous && /^Resuming /.test(row.event.message)) {
        // A resumed freeze or review continues the same attempt.
        Object.assign(previous, { end: null, ms: null, status: row.status, outcome: row.text })
        open.set(node, previous)
        continue
      }
      const attempt = row.attempt ?? current?.attempt ?? (previous ? previous.attempt + 1 : Math.max(1, row.event.attempt))
      if (current && current.attempt !== attempt) {
        close(current, 'no_record', { ...at(row), note: 'ended without a record' }, 'ended without a record')
        closedBy.set(row.event.sequence, current)
        open.delete(node)
      }
      const span = open.get(node)
      if (span) { span.outcome = row.text; span.status = row.status; continue }
      const created = newSpan(node, laneOf(node), attempt, at(row))
      created.status = row.status
      created.outcome = row.text
      spans.push(created)
      open.set(node, created)
      last.set(node, created)
      openedBy.set(row.event.sequence, created)
    } else if (TERMINAL.has(row.status)) {
      if (current) {
        close(current, row.status, at(row), row.text)
        open.delete(node)
        closedBy.set(row.event.sequence, current)
        continue
      }
      const attempt = row.attempt ?? previous?.attempt ?? Math.max(1, row.event.attempt)
      if (previous && previous.attempt === attempt) continue  // Restates a closed attempt (a repair note, a repeated verdict).
      // A step that records no start (the freeze, integration) is an instant at its verdict.
      const created = newSpan(node, laneOf(node), attempt, at(row))
      close(created, row.status, at(row), row.text)
      spans.push(created)
      last.set(node, created)
      closedBy.set(row.event.sequence, created)
    }
  }

  // Rule 4: a worker runs from its launch receipt to its stop receipt (or to now while it runs).
  for (const worker of inputs?.workers ?? []) {
    if (!worker.launch) continue
    const status = statusOf(worker.launch_node_id)
    const started = worker.launch.native_started_at ?? worker.launch.launch_requested_at
    const span = newSpan(worker.launch_node_id, worker.node_id, 1, { at: started, source: 'receipt', note: worker.launch.native_started_at ? 'launch receipt' : 'launch requested (receipt)' })
    span.status = status
    const latest = rows.filter(row => row.node === worker.launch_node_id && !row.marker && !NOTE_ROW.test(row.event.message)).at(-1)
    span.outcome = latest?.text ?? ''
    if (worker.stop?.confirmed_at) close(span, status, { at: worker.stop.confirmed_at, source: 'receipt', note: 'stop receipt' }, 'worked · stopped cleanly')
    spans.push(span)
  }

  // Rule 11: candidate verdicts are per lane; match each to the lane result whose last check finished just before it.
  const verifyEnd = latestOf(spans.filter(span => span.node_id.startsWith('verify_')).map(span => span.end?.at))
  const candidateNode = snapshotNode(detail, 'candidate')
  const known = (candidateNode?.lane_results ?? []).flatMap(entry => Array.from({ length: entry.attempt }, (_, index) => index + 1).flatMap(attempt => {
    const uri = attempt === entry.attempt ? entry.result_uri : resultUri(detail, 'candidate', entry.worker, attempt)
    const result = results.get(uri)
    return result && result.checks.length ? [{ lane: entry.worker, attempt, uri, result, finished: result.checks.at(-1)!.finished_at }] : []
  }))
  const claimed = new Set<string>()
  let previousCandidate: string | null = null
  let ordinal = 0
  for (const row of candidateRows) {
    const prefixed = /^\[([a-z][a-z0-9-]*)\] /.exec(row.event.message)?.[1] ?? null
    if (row.status === 'running' || row.status === 'awaiting_approval') { previousCandidate = row.event.occurred_at; continue }
    const fits = (entry: typeof known[number]) => entry.result.status === row.status && (prefixed === null || entry.lane === prefixed)
      && ms(entry.finished) <= ms(row.event.occurred_at) + 1000
    const match = known.filter(entry => !claimed.has(entry.uri) && fits(entry)).sort((a, b) => ms(b.finished) - ms(a.finished))[0]
    if (!match && known.some(entry => claimed.has(entry.uri) && fits(entry))) {
      reused.add(row.event.sequence)  // A reused lane result re-announced after a controller restart.
      continue
    }
    if (match) claimed.add(match.uri)
    const startAt = latestOf([previousCandidate, verifyEnd])
    const span = newSpan('candidate', match?.lane ?? prefixed, match?.attempt ?? row.attempt ?? ++ordinal,
      startAt ? { at: startAt, source: 'inferred', note: previousCandidate ? 'start inferred from the previous candidate verdict' : 'start inferred from the end of verification' } : null)
    close(span, row.status as SpanStatus, at(row), row.text)
    span.result_uri = match?.uri ?? null
    spans.push(span)
    closedBy.set(row.event.sequence, span)
    previousCandidate = row.event.occurred_at
  }

  // Rule 4: a review without events ends at its verdict and starts at the first reviewer launch, else ≈ at the candidate's end.
  const reviewStatus = statusOf('review')
  if (!spans.some(span => span.node_id === 'review') && reviewStatus !== 'pending' && detail.definition.nodes.some(node => node.node_id === 'review')) {
    const launched = (review?.reviewers ?? []).map(entry => entry.launched_at).filter(value => value !== null).sort()[0]
    const candidateEnd = latestOf(spans.filter(span => span.node_id === 'candidate').map(span => span.end?.at))
    const start: Instant | null = launched ? { at: launched, source: 'review', note: 'first reviewer launch' }
      : candidateEnd ? { at: candidateEnd, source: 'inferred', note: `start inferred from ${labelOf(detail, 'candidate')}; the review records no launch time` } : null
    const span = newSpan('review', null, Math.max(1, review?.attempt ?? 1), start)
    span.status = reviewStatus
    span.result_uri = snapshotNode(detail, 'review')?.result_uri ?? null
    if (review) close(span, reviewStatus, { at: review.reviewed_at, source: 'review' }, reviewOutcome(review))
    spans.push(span)
  }
  // Rule 4: an approval without an event is ≈ an instant at the integration.
  const integrated = spans.find(span => span.node_id === 'integrate' && span.end)
  if (!spans.some(span => span.node_id === 'approval') && statusOf('approval') === 'succeeded' && integrated) {
    const instant: Instant = { at: integrated.end!.at, source: 'inferred', note: 'no approval event recorded' }
    const span = newSpan('approval', null, 1, instant)
    close(span, 'succeeded', instant, 'approved · no approval event recorded')
    spans.push(span)
  }

  // Export 1.10.0: a repair session is a span of its node; one the event log does not carry is built from the journal entry.
  for (const repair of repairsOf(detail)) {
    const own = spans.filter(span => span.node_id === repair.node_id)
    for (const span of own) span.lane = repair.lane
    if (own.length) continue
    const span = newSpan(repair.node_id, repair.lane, 1, { at: repair.recorded_at, source: 'receipt', note: 'repair journal entry' })
    if (repair.status === 'applied' && repair.applied_at) close(span, 'succeeded', { at: repair.applied_at, source: 'receipt', note: 'repair applied' }, `repair ${repair.n} applied`)
    else if (repair.status === 'blocked') { span.status = 'failed'; span.outcome = repair.reason ?? `repair ${repair.n} blocked` }
    else span.outcome = `repair session launched (round ${repair.round} of ${repair.rounds})`
    spans.push(span)
  }
  // Export 1.10.0: the review node's attempts are the archived rounds plus the live one. Round k ends at the moment the fix loop
  // recorded it (review-rounds.json `started_at`); a restored round is not archived and stays the one live attempt.
  const archived = roundsOf(detail).filter(round => round.archived).sort((a, b) => a.round - b.round)
  if (archived.length > 0) {
    const mine = spans.filter(span => span.node_id === 'review')
    const lastRecorded = archived.at(-1)!.started_at
    const live = mine.filter(span => span.start !== null && ms(span.start.at) > ms(lastRecorded)).at(-1)
    const first = mine.map(span => span.start?.at).filter((value): value is string => value !== undefined).sort()[0]
    for (const span of mine) if (span !== live) spans.splice(spans.indexOf(span), 1)
    if (live) live.attempt = archived.length + 1
    const candidateEnd = latestOf(spans.filter(span => span.node_id === 'candidate').map(span => span.end?.at))
    for (const round of archived) {
      const fed = round.round === 1 ? undefined : repairsOf(detail).find(repair => repair.review_round === round.round - 1)?.applied_at ?? archived[round.round - 2]?.started_at
      const startAt = round.round === 1 ? first ?? candidateEnd : fed
      const span = newSpan('review', null, round.round, startAt ? { at: startAt, source: round.round === 1 && !first ? 'inferred' : 'receipt', note: round.round === 1 ? 'first review event' : 'the repair of the previous round applied' } : null)
      close(span, round.verdict === 'approved' ? 'succeeded' : 'failed', { at: round.started_at, source: 'receipt', note: 'review round recorded' }, roundOutcome(round))
      spans.push(span)
    }
  }

  const lastReview = spans.filter(span => span.node_id === 'review').at(-1)
  if (review && lastReview?.end) lastReview.outcome = reviewOutcome(review)
  const runStatus = detail.snapshot.status
  const automatic = automaticRun(run, rows)
  for (const span of spans) {
    if (span.node_id.startsWith('verify_') && span.lane) span.result_uri = resultUri(detail, 'worker', span.lane, span.attempt)
    const result = span.result_uri ? results.get(span.result_uri) : undefined
    if (result?.checks.length && span.start) {
      const first = result.checks.reduce((a, b) => ms(a.started_at) <= ms(b.started_at) ? a : b)
      const finish = result.checks.reduce((a, b) => ms(a.finished_at) >= ms(b.finished_at) ? a : b)
      span.split = { setup_ms: Math.max(0, ms(first.started_at) - ms(span.start.at)), checks_ms: Math.max(0, ms(finish.finished_at) - ms(first.started_at)) }
    }
    const nodeStatus = statusOf(span.node_id)
    // A retried check or a resumed freeze or review runs while its node (and the run) still read failed: see `reentered`.
    const rerun = open.get(span.node_id) === span && reentered(detail, rows, span.node_id, automatic) !== null
    span.live = span.end === null && (rerun || (!FINISHED_RUN.has(runStatus) && (nodeStatus === 'running' || nodeStatus === 'awaiting_approval')))
    if (span.end === null && !span.live && span.status === 'running') span.status = nodeStatus
  }
  const began = (span: Span) => { const at = span.start?.at ?? span.end?.at; return at ? ms(at) : Infinity }
  spans.sort((a, b) => began(a) - began(b))
  const byNode = new Map<string, Span[]>()
  for (const node of detail.definition.nodes) {
    const own = spans.filter(span => span.node_id === node.node_id)
    if (own.length) byNode.set(node.node_id, own)
  }

  const markers = buildMarkers(run, rows)
  const gaps = buildGaps(run, rows, spans)
  const activity = buildActivity(rows, spans, markers, gaps, { openedBy, closedBy, reused })

  // Rule 10: the run spans creation to the last non-controller activity (events, the verdict, stop receipts), never `updated_at`.
  const moments: { at: string; source: InstantSource; controller: boolean; pid: boolean; text: string }[] = [
    ...rows.filter(row => !ADVISORY_NODE_IDS.has(row.node))
      .map(row => ({ at: row.event.occurred_at, source: 'event' as const, controller: row.node === null || row.marker !== null, pid: row.marker === 'controller_start', text: row.text })),
    ...(inputs?.workers ?? []).flatMap(worker => worker.stop?.confirmed_at
      ? [{ at: worker.stop.confirmed_at, source: 'receipt' as const, controller: false, pid: false, text: `${worker.node_id} stopped (stop receipt)` }] : []),
    ...(review ? [{ at: review.reviewed_at, source: 'review' as const, controller: false, pid: false, text: `review ${reviewOutcome(review)}` }] : []),
  ]
  const latest = (pick: (moment: typeof moments[number]) => boolean) => moments.filter(pick).reduce<typeof moments[number] | null>((a, b) => a === null || ms(b.at) >= ms(a.at) ? b : a, null)
  const end = latest(moment => !moment.controller)
  const lastMoment = latest(moment => !moment.pid)
  const timeline: Timeline = {
    runStart: { at: detail.summary.created_at, source: 'receipt', note: 'run created' },
    runEnd: FINISHED_RUN.has(runStatus) && end ? { at: end.at, source: end.source } : null,
    lastActivity: lastMoment ? { at: lastMoment.at, source: lastMoment.source, note: lastMoment.text } : null,
    spans, markers, gaps, byNode, activity,
  }
  INTERNAL.set(timeline, { rows, lastActivityText: lastMoment?.text ?? null })
  return timeline
}

function sessionRepair(repair: RepairEntry): NonNullable<Marker['repair']> {
  return { n: repair.n, snapshot: repair.workspace_commit.slice(0, 8), files: [...repair.fix_files], session: true, round: repair.round, trigger: repair.trigger }
}

function buildMarkers(run: RunData, rows: Row[]): Marker[] {
  const markers: Marker[] = []
  for (const row of rows) {
    if (!row.marker) continue
    const message = row.event.message
    const marker: Marker = {
      kind: row.marker, at: row.event.occurred_at, sequence: row.event.sequence, node_id: row.node, lane: row.node ? laneOf(row.node) : null,
      run_level: row.node === null, blocked: row.blocked, message: row.text, raw: message,
    }
    const identical = IDENTICAL.exec(message)
    if (row.marker === 'diagnosis' && identical) {
      marker.lane = identical[2]
      marker.node_id = identical[1] === 'worker' ? `verify_${identical[2]}` : 'candidate'
    }
    if (row.marker === 'repair') {
      const n = Number(REPAIR_APPLIED.exec(message)?.[1])
      const session = repairsOf(run.detail).find(repair => repair.n === n)
      if (session) {
        // A session repair's marker sits on the step it answers, not on the row's node (the controller's rows name `verify_<lane>` for every trigger).
        marker.node_id = session.blocked_step
        marker.lane = session.lane
        marker.repair = sessionRepair(session)
        markers.push(marker)
        continue
      }
      const noted = rows.filter(other => other.node && other.event.sequence <= row.event.sequence && REPAIR_BY_OPERATOR.exec(other.event.message)?.[1] === String(n)).at(-1)
      const detail = noted ? REPAIR_BY_OPERATOR.exec(noted.event.message) : null
      marker.node_id = noted?.node ?? null
      marker.lane = noted?.node ? laneOf(noted.node) : /worker:([a-z][a-z0-9-]*)/.exec(message)?.[1] ?? null
      marker.repair = { n, snapshot: detail?.[2] ?? null, files: detail ? detail[3].split(', ').filter(Boolean) : [] }
    }
    markers.push(marker)
  }
  // Export 1.10.0: each session repair has its marker on the step it answers, from the journal when no controller row carried it.
  for (const repair of repairsOf(run.detail)) {
    if (markers.some(marker => marker.kind === 'repair' && marker.repair?.session && marker.repair.n === repair.n)) continue
    markers.push({
      kind: 'repair', at: repair.recorded_at, sequence: null, node_id: repair.blocked_step, lane: repair.lane, run_level: false, blocked: false,
      message: `Repair ${repair.n} (${repair.lane}, round ${repair.round} of ${repair.rounds}) after ${repair.trigger} blocked`, raw: repair.reason ?? '', repair: sessionRepair(repair),
    })
  }
  // A `controller_blocked` row that follows an exhausted fix loop has the blocked repair session as its cause.
  const blocked = repairsOf(run.detail).filter(repair => repair.status === 'blocked')
  for (const marker of markers) {
    if (marker.kind !== 'controller_blocked' || !marker.run_level || blocked.length === 0) continue
    const named = /fix loop exhausted for lane ([a-z][a-z0-9-]*)/.exec(marker.raw)?.[1]
    const cause = [...blocked].reverse().find(repair => named === undefined || repair.lane === named) ?? blocked.at(-1)!
    marker.cause = { node_id: cause.node_id, repair_n: cause.n, lane: cause.lane }
  }
  // Rule 7: each question and answer is a row; the export's record wins, the event log stands in when it is stale.
  const exported = new Set<string>()
  for (const worker of run.inputs?.workers ?? []) {
    for (const question of worker.questions) {
      exported.add(`${worker.node_id}:${question.n}`)
      const event = rows.find(row => row.node === worker.launch_node_id && QUESTION_EVENT.exec(row.event.message)?.slice(1, 3).join(':') === `${worker.node_id}:${question.n}`)
      const wait = question.answered_at ? ms(question.answered_at) - ms(question.asked_at) : null
      markers.push({
        kind: 'question', at: question.asked_at, sequence: event?.event.sequence ?? null, node_id: worker.launch_node_id, lane: worker.node_id, run_level: false, blocked: false,
        message: `${worker.node_id} asked question ${question.n}`, raw: question.question,
        question: { n: question.n, text: question.question, asked_at: question.asked_at, answered_at: question.answered_at, wait_ms: wait, live: question.answer === null, exported: true },
      })
      if (question.answered_at && question.answer !== null) {
        markers.push({ kind: 'answer', at: question.answered_at, sequence: null, node_id: worker.launch_node_id, lane: worker.node_id, run_level: false, blocked: false,
          message: `${worker.node_id}'s question ${question.n} answered`, raw: question.answer })
      }
    }
  }
  for (const row of rows) {
    const asked = QUESTION_EVENT.exec(row.event.message)
    if (!asked || !row.node || exported.has(`${asked[1]}:${asked[2]}`)) continue
    markers.push({
      kind: 'question', at: row.event.occurred_at, sequence: row.event.sequence, node_id: row.node, lane: asked[1], run_level: false, blocked: false,
      message: `${asked[1]} asked question ${asked[2]}`, raw: asked[3],
      question: { n: Number(asked[2]), text: asked[3], asked_at: row.event.occurred_at, answered_at: null, wait_ms: null, live: true, exported: false },
    })
  }
  return markers.sort((a, b) => ms(a.at) - ms(b.at) || (a.sequence ?? Infinity) - (b.sequence ?? Infinity))
}

/** Rule 6: silences over two minutes, classified by the row before them and the spans they fall inside (never the sidecar's). */
function buildGaps(run: RunData, rows: Row[], allSpans: Span[]): Gap[] {
  const spans = allSpans.filter(span => !ADVISORY_NODE_IDS.has(span.node_id))
  const moments = [
    ...rows.map(row => ({ at: row.event.occurred_at, row })),
    ...spans.flatMap(span => [span.start, span.end]
      .filter((instant): instant is Instant => instant !== null && instant.source !== 'inferred' && instant.source !== 'event').map(instant => ({ at: instant.at, row: null }))),
    ...(run.inputs?.workers ?? []).flatMap(worker => worker.questions.flatMap(question => [question.asked_at, question.answered_at].filter(value => value !== null).map(value => ({ at: value, row: null })))),
  ].sort((a, b) => ms(a.at) - ms(b.at) || (a.row?.event.sequence ?? 0) - (b.row?.event.sequence ?? 0))
  const gaps: Gap[] = []
  for (let index = 1; index < moments.length; index += 1) {
    const from = moments[index - 1].at
    const to = moments[index].at
    const length = ms(to) - ms(from)
    if (length <= GAP_MS) continue
    const before = moments.slice(0, index).reverse().find(moment => moment.row !== null)?.row ?? null
    const next = moments.slice(index).find(moment => moment.row !== null)?.row ?? null
    const across = (span: Span) => span.start !== null && ms(span.start.at) <= ms(from) && (span.end === null || ms(span.end.at) >= ms(to))
    const workers = spans.filter(span => span.node_id.startsWith('launch_') && across(span)).map(span => span.lane ?? span.node_id)
    let kind: GapKind | null
    if (before?.marker === 'controller_error' && next?.marker === 'controller_start' && ms(next.event.occurred_at) === ms(to)) kind = 'controller_down'
    else if (before && (before.marker === 'diagnosis' || before.marker === 'controller_blocked' || before.marker === 'interrupted'
      || before.marker === 'controller_error' || (before.marker === null && (before.status === 'failed' || before.status === 'paused')))) kind = 'operator'
    else if (workers.length) kind = 'waiting_worker'
    else if (spans.some(span => !span.node_id.startsWith('launch_') && across(span))) kind = null  // A step is working; its bar shows it.
    else kind = 'idle'
    if (kind) gaps.push({ kind, from, to, ms: length, lanes: workers })
  }
  return gaps
}

function buildActivity(rows: Row[], spans: Span[], markers: Marker[], gaps: Gap[],
  links: { openedBy: Map<number, Span>; closedBy: Map<number, Span>; reused: Set<number> }): ActivityRow[] {
  const activity: ActivityRow[] = []
  const base = { sequence: null, raw: null, ms: null, inferred: false, controller_log: false, gap: null, marker: null, status: null, attempt: null }
  const questionAt = new Map(markers.filter(marker => marker.kind === 'question' && marker.sequence !== null).map(marker => [marker.sequence!, marker]))
  for (const row of rows) {
    const opened = links.openedBy.get(row.event.sequence)
    const ended = links.closedBy.get(row.event.sequence)
    const closed = ended?.status === 'no_record' ? undefined : ended
    const span = closed ?? opened
    const question = questionAt.get(row.event.sequence)
    activity.push({
      ...base, at: row.event.occurred_at, source: 'event', sequence: row.event.sequence, raw: row.event.message,
      node_id: row.node ?? (row.marker === 'diagnosis' || row.marker === 'repair' ? markers.find(marker => marker.sequence === row.event.sequence)?.node_id ?? null : null),
      lane: span?.lane ?? (row.node ? laneOf(row.node) : null),
      attempt: span?.attempt ?? row.attempt,
      kind: row.marker ? 'marker' : closed ? 'end' : opened ? 'start' : 'update',
      status: closed ? closed.status : row.status,
      marker: row.marker ?? (question ? 'question' : null),
      text: closed ? closed.outcome : links.reused.has(row.event.sequence) ? `${row.text} · lane result reused` : row.text,
      ms: closed?.ms ?? null,
      inferred: closed?.start?.source === 'inferred',
      controller_log: row.marker === 'controller_start',
    })
  }
  for (const span of spans) {
    for (const edge of ['start', 'end'] as const) {
      const instant = span[edge]
      const noRecord = edge === 'end' && span.status === 'no_record'
      if (!instant || (instant.source === 'event' && !noRecord) || (edge === 'start' && instant.source === 'inferred')) continue
      const text = noRecord ? `attempt ${span.attempt} ended without a record`
        : span.node_id.startsWith('launch_')
          ? edge === 'start' ? `session started (from the ${instant.note ?? 'launch receipt'})` : 'stopped cleanly (from the stop receipt)'
          : edge === 'end' ? span.outcome : `started (${instant.note ?? instant.source})`
      activity.push({ ...base, at: instant.at, source: instant.source, node_id: span.node_id, lane: span.lane, attempt: span.attempt, kind: edge,
        status: edge === 'end' ? span.status : 'running', text, ms: edge === 'end' ? span.ms : null, inferred: span.start?.source === 'inferred' || instant.source === 'inferred' })
    }
  }
  for (const marker of markers) {
    if (marker.sequence !== null) continue
    activity.push({ ...base, at: marker.at, source: 'receipt', node_id: marker.node_id, lane: marker.lane, kind: 'marker', marker: marker.kind,
      text: marker.kind === 'question' ? `${marker.message}: ${marker.raw}` : marker.message, raw: marker.raw })
  }
  for (const gap of gaps) activity.push({ ...base, at: gap.from, source: 'inferred', node_id: null, lane: null, kind: 'gap', text: gapText(gap), ms: gap.ms, gap })
  const order = (row: ActivityRow) => row.kind === 'gap' ? 2 : row.sequence === null ? 0 : 1
  return activity.sort((a, b) => ms(a.at) - ms(b.at) || order(a) - order(b) || (a.sequence ?? 0) - (b.sequence ?? 0))
}

function gapText(gap: Gap): string {
  switch (gap.kind) {
    case 'operator': return 'operator time'
    case 'controller_down': return 'controller not running'
    case 'waiting_worker': return gap.lanes.length > 1 ? `workers ${gap.lanes.join(', ')} working` : `worker ${gap.lanes[0]} working`
    case 'idle': return 'no activity'
  }
}

// ---- Focus, scope and attention (6.2, 6.4) ------------------------------------------------------------------------

function depths(detail: RunDetail): Map<string, number> {
  const depth = new Map<string, number>()
  for (const node of detail.definition.nodes) depth.set(node.node_id, Math.max(-1, ...node.depends_on.map(parent => depth.get(parent) ?? 0)) + 1)
  return depth
}

function focusOf(detail: RunDetail, rows: readonly Row[]): Focus | null {
  const depth = depths(detail)
  const since = (nodeId: string) => statusRows(rows, nodeId).at(-1)?.event.occurred_at ?? repairOf(detail, nodeId)?.recorded_at ?? null
  const repairIds = new Set(repairsOf(detail).map(repair => repair.node_id))
  // A running repair session is the run's focus: the steps it re-enters read running beside it and come second.
  const runningRepair = detail.snapshot.nodes.filter(node => repairIds.has(node.node_id) && node.status === 'running')
  if (runningRepair.length) {
    const node = runningRepair.reduce((best, candidate) => ms(since(candidate.node_id) ?? '') >= ms(since(best.node_id) ?? '') ? candidate : best)
    return { node_id: node.node_id, label: labelOf(detail, node.node_id), kind: node.kind, status: node.status, since: since(node.node_id) }
  }
  // A blocked repair is a focus candidate only while no pinned node runs or awaits approval and the run has not succeeded.
  const hideBlockedRepairs = detail.snapshot.status === 'succeeded'
    || detail.snapshot.nodes.some(node => !repairIds.has(node.node_id) && (node.status === 'running' || node.status === 'awaiting_approval'))
  const pick = (wanted: readonly NodeStatus[], skip: string | null = null) => {
    const matches = detail.snapshot.nodes.filter(node => wanted.includes(node.status) && node.node_id !== skip && node.node_id !== ATTACK_NODE_ID
      && !(hideBlockedRepairs && repairIds.has(node.node_id)))
    if (!matches.length) return null
    // Parallel lanes share a column: the tie goes to the latest event.
    const tied = matches.filter(node => depth.get(node.node_id) === depth.get(matches[0].node_id))
    return tied.reduce((best, node) => ms(since(node.node_id) ?? '') > ms(since(best.node_id) ?? '') ? node : best)
  }
  // The sidecar runs beside the lanes for the whole work phase: it is the running focus only when nothing else runs.
  const othersRun = detail.snapshot.nodes.some(node => node.status === 'running' && !ADVISORY_NODE_IDS.has(node.node_id))
  let node = pick(['failed', 'paused', 'awaiting_approval']) ?? pick(['running'], othersRun ? SIDECAR_NODE_ID : null)
  // The attack pass runs beside the review inside the review step (docs/PRD_ATTACK_PASS.md 4.6). When it runs on alone after
  // the review decided — approved, so the review node reads `succeeded` (a blocked review reads `failed` and is already the
  // focus above) — the run is still in its review step, so the review keeps the focus, never the report-only attack node.
  if (!node && detail.snapshot.nodes.some(candidate => candidate.node_id === ATTACK_NODE_ID && candidate.status === 'running')) {
    node = detail.snapshot.nodes.find(candidate => candidate.node_id === 'review') ?? null
  }
  if (!node) return null
  return { node_id: node.node_id, label: labelOf(detail, node.node_id), kind: node.kind, status: node.status, since: since(node.node_id) }
}

/** The focus node (6.2): the first failed, paused or awaiting node in definition order, else the first running one. */
export function deriveFocus(detail: RunDetail, events: readonly WorkflowEvent[] = []): Focus | null {
  return focusOf(detail, classify(detail, events))
}

/** The scope window (6.2) opens after this sequence: the focus's latest `running` row, else its dependencies' latest status row. */
function scopeStart(detail: RunDetail, rows: readonly Row[], focus: Focus | null): number {
  if (!focus) return 0
  const running = statusRows(rows, focus.node_id).filter(row => row.status === 'running').at(-1)
  if (running) return running.event.sequence
  const parents = (detail.definition.nodes.find(node => node.node_id === focus.node_id)?.depends_on ?? []).filter(parent => !ADVISORY_NODE_IDS.has(parent))
  return rows.filter(row => row.node !== null && parents.includes(row.node) && row.status !== null && row.marker === null).at(-1)?.event.sequence ?? 0
}

type Waiting = { lane: string; n: number | null; text: string | null; asked_at: string | null; fromLog: boolean }

/** Rule 1: questions waiting on the operator, from the export, the worker's completion, the event log or B2. */
function waitingQuestions(run: NowInput, rows: readonly Row[]): Waiting[] {
  if (FINISHED_RUN.has(run.detail.snapshot.status)) return []
  const waiting: Waiting[] = []
  for (const worker of run.inputs?.workers ?? []) {
    if (worker.stop?.stopped) continue
    const latest = worker.questions.at(-1)
    if (latest && latest.answer === null) waiting.push({ lane: worker.node_id, n: latest.n, text: latest.question, asked_at: latest.asked_at, fromLog: false })
    else if (worker.completion?.status === 'question') waiting.push({ lane: worker.node_id, n: worker.questions.length + 1, text: worker.completion.question, asked_at: null, fromLog: false })
  }
  for (const lane of lanesOf(run)) {
    if (waiting.some(item => item.lane === lane)) continue
    const worker = workerOf(run.inputs, lane)
    if (worker?.stop?.stopped) continue
    const latest = statusRows(rows, `launch_${lane}`).at(-1)
    const asked = latest ? QUESTION_EVENT.exec(latest.event.message) : null
    if (!asked || asked[1] !== lane || worker?.questions.some(question => question.n === Number(asked[2]))) continue
    waiting.push({ lane, n: Number(asked[2]), text: asked[3], asked_at: latest!.event.occurred_at, fromLog: true })
  }
  const served = run.activity?.attention
  if (!waiting.length && (run.activity?.waiting_questions ?? 0) > 0 && served?.kind === 'question' && served.node_id) {
    const lane = laneOf(served.node_id)
    if (lane) waiting.push({ lane, n: null, text: null, asked_at: served.since, fromLog: false })
  }
  return waiting
}

type Pane = { node_id: string; target: string; who: string; state: string; since: string }

/** Rule 2: a worker or reviewer whose latest event says it needs attention in its pane, with no later event for that node. */
function panes(run: NowInput, rows: readonly Row[]): Pane[] {
  if (FINISHED_RUN.has(run.detail.snapshot.status)) return []
  const found: Pane[] = []
  for (const node of run.detail.definition.nodes) {
    if (!node.node_id.startsWith('launch_') && node.node_id !== 'review') continue
    const latest = rows.filter(row => row.node === node.node_id && row.marker === null && !NOTE_ROW.test(row.event.message)).at(-1)
    const match = latest ? PANE.exec(latest.event.message) : null
    if (!latest || !match) continue
    const reviewer = PANE_REVIEWER.exec(latest.event.message)?.[1]
    const lane = laneOf(node.node_id)
    const target = reviewer ? (reviewer === 'review' ? 'review' : `review-${reviewer}`) : lane ?? node.node_id
    found.push({ node_id: node.node_id, target, who: reviewer ? `reviewer ${reviewer}` : lane ?? node.node_id, state: match[1] ?? '', since: latest.event.occurred_at })
  }
  const served = run.activity?.attention
  if (!found.length && served?.kind === 'pane' && served.node_id && served.since) {
    const lane = laneOf(served.node_id)
    found.push({ node_id: served.node_id, target: lane ?? served.node_id, who: lane ?? served.node_id, state: '', since: served.since })
  }
  return found
}

/** Which nodes wait on the operator (6.4): a question, a pane that needs attention, or an approval; `top` by that precedence. */
export function deriveAttention(run: RunData & { activity?: ServedActivity | null }): RunAttention {
  // The sidecar's rows (an escalation included) wait on nobody: no new attention kind (docs/PRD_REVIEW_SIDECAR.md 4.6).
  const rows = classify(run.detail, run.events.filter(event => !ADVISORY_NODE_IDS.has(event.node_id)))
  const found = new Map<string, Attention>()
  for (const item of waitingQuestions(run, rows)) {
    const node = `launch_${item.lane}`
    if (!found.has(node)) found.set(node, { kind: 'question', node_id: node, lane: item.lane, since: item.asked_at, detail: item.text ?? `${item.lane} asked a question` })
  }
  for (const pane of panes(run, rows)) {
    if (!found.has(pane.node_id)) found.set(pane.node_id, { kind: 'pane', node_id: pane.node_id, lane: laneOf(pane.node_id), since: pane.since, detail: `${pane.who} needs attention in its pane${pane.state}` })
  }
  if (!FINISHED_RUN.has(run.detail.snapshot.status)) {
    for (const node of run.detail.snapshot.nodes) {
      if (node.status === 'awaiting_approval' && !found.has(node.node_id)) {
        const since = statusRows(rows, node.node_id).at(-1)?.event.occurred_at ?? null
        found.set(node.node_id, { kind: 'approval', node_id: node.node_id, lane: null, since, detail: `${labelOf(run.detail, node.node_id)} awaits your decision` })
      }
    }
  }
  const nodes = new Map(run.detail.definition.nodes.flatMap(node => found.has(node.node_id) ? [[node.node_id, found.get(node.node_id)!] as const] : []))
  const top = (['question', 'pane', 'approval'] as const).map(kind => [...nodes.values()].find(item => item.kind === kind)).find(item => item !== undefined) ?? null
  return { top, nodes }
}

// ---- Gate reasons (4.6) -------------------------------------------------------------------------------------------

/**
 * A gate's `error.message` split on `"; "` into reasons keyed by their `<check id>: ` prefix. A segment without one is a
 * gate-level reason; it is also attached to a check only when the text after `<path>` is the tail of exactly one check's
 * command (the message is redacted, the command is not). With two or more matching tails, or none, it stays gate-level.
 */
export function gateReasonsByCheck(message: string | null | undefined, checks: readonly { id: string; command: string }[]): GateReasons {
  const ids = [...checks].sort((a, b) => b.id.length - a.id.length)
  const reasons = (message ?? '').split('; ').map(segment => segment.trim()).filter(Boolean).map((text): GateReason => {
    const keyed = ids.find(check => text.startsWith(`${check.id}: `))
    if (keyed) return { text, reason: text.slice(keyed.id.length + 2), check_id: keyed.id, attached_to: null }
    const at = text.lastIndexOf('<path>')
    const tail = at < 0 ? '' : text.slice(at + '<path>'.length)
    const matching = tail.trim() ? checks.filter(check => check.command.endsWith(tail)) : []
    return { text, reason: text, check_id: null, attached_to: matching.length === 1 ? matching[0].id : null }
  })
  const byCheck = new Map<string, GateReason[]>()
  for (const reason of reasons) {
    const id = reason.check_id ?? reason.attached_to
    if (id !== null) byCheck.set(id, [...byCheck.get(id) ?? [], reason])
  }
  return { reasons, gate: reasons.filter(reason => reason.check_id === null), byCheck }
}

/** One line for a failed gate: the rejected check ids and their distinct reasons, e.g. "unit, integration — no passing test evidence". */
function gateSummary(result: WorkerResult, checks: readonly { id: string; command: string }[]): string {
  const reasons = gateReasonsByCheck(result.error?.message, checks)
  const keyed = reasons.reasons.filter(reason => reason.check_id !== null)
  if (!keyed.length) return result.error?.message ?? 'the gate did not pass'
  return `${[...new Set(keyed.map(reason => reason.check_id))].join(', ')} — ${[...new Set(keyed.map(reason => reason.reason))].join('; ')}`
}

// ---- Result URIs (4.4, 6.2 reason source 2) ------------------------------------------------------------------------

/**
 * The result URI of every attempt of a verification node, oldest first per lane: `verify_<lane>` → `results/<lane>/<k>`,
 * `candidate` → `results/candidate_<lane>/<k>` for each lane. `last` keeps only each lane's latest attempts. Other nodes: [].
 */
export function attemptResultUris(detail: RunDetail, nodeId: string, options: { last?: number } = {}): AttemptResultUri[] {
  const node = snapshotNode(detail, nodeId)
  if (!node) return []
  const series = (lane: string, phase: 'worker' | 'candidate', attempts: number) => Array.from({ length: attempts }, (_, index) => index + 1)
    .slice(options.last ? -options.last : 0).map(attempt => ({ lane, phase, attempt, uri: resultUri(detail, phase, lane, attempt) }))
  if (nodeId.startsWith('verify_')) return series(nodeId.slice('verify_'.length), 'worker', node.attempt)
  if (nodeId === 'candidate') return node.lane_results.flatMap(entry => series(entry.worker, 'candidate', entry.attempt))
  return []
}

/**
 * The results the run page's Now banner and lanes line read: the failing focus's latest two attempts, plus each lane's
 * candidate result. Given the events, a verify retry that is still running is left out: its result exists only once it
 * ends, so the two attempts before it are read instead.
 */
export function nowResultUris(detail: RunDetail, events: readonly WorkflowEvent[] = []): string[] {
  const rows = classify(detail, events)
  const focus = focusOf(detail, rows)
  const uris: string[] = []
  if (focus?.status === 'failed' && focus.node_id.startsWith('verify_')) {
    const { attempt } = verdictAttempt(detail, rows, focus.node_id, automaticRun({}, rows))
    uris.push(...attemptResultUris(detail, focus.node_id).filter(item => item.attempt <= attempt).slice(-2).map(item => item.uri))
  } else if (focus?.status === 'failed') uris.push(...attemptResultUris(detail, focus.node_id, { last: 2 }).map(item => item.uri))
  if (lanesOf({ detail }).length >= 2) uris.push(...(snapshotNode(detail, 'candidate')?.lane_results ?? []).map(entry => entry.result_uri))
  return [...new Set(uris)]
}

// ---- deriveNow (6.2) ----------------------------------------------------------------------------------------------

type Context = {
  run: NowInput
  timeline: Timeline
  rows: Row[]
  focus: Focus | null
  scope: number
  automatic: boolean
  status: NodeStatus
  results: ReadonlyMap<string, WorkerResult>
  missing: Set<string>
}

type Draft = Omit<Now, 'focus' | 'missing' | 'interruption' | 'lane' | 'reason' | 'reasonSource' | 'since'> & Partial<Pick<Now, 'interruption' | 'lane' | 'reason' | 'reasonSource' | 'since'>>

const DID_NOT_COMPLETE = ' The workflow did not complete.'
const clock = (at: string): TextPart => ({ kind: 'clock', at })
const ago = (at: string): TextPart => ({ kind: 'ago', at })

/**
 * The run's situation and the operator's likely next step (6.2): the first matching rule of thirteen, from the run's
 * current state only. Controller rows count only inside the scope window, so stale errors never decide it. When the
 * rules need lane results that were not given, `missing` names them; derive again once they are loaded.
 */
export function deriveNow(run: NowInput): Now {
  const timeline = buildTimeline(run)
  const rows = INTERNAL.get(timeline)?.rows ?? classify(run.detail, run.events)
  const focus = focusOf(run.detail, rows)
  const context: Context = {
    run, timeline, rows, focus, scope: scopeStart(run.detail, rows, focus), status: run.detail.snapshot.status, results: run.results ?? new Map(), missing: new Set(),
    automatic: automaticRun(run, rows),
  }
  // An abandoned run (C30) reads cancelled at run level while its nodes keep their statuses: the rules that assume a live
  // run (a gate to decide, a challenge to resume, a lane to repair or retry, steps still running) no longer apply, since
  // abandon refuses every command they name. A review-blocked run keeps its brief and follow-up launch.
  const live = context.status !== 'cancelled'
  const rules = [questionNow, paneNow, ...live ? [approvalNow, challengeHeldNow, challengeNow] : [], interruptedNow, blockedBeforeFreezeNow,
    ...live ? [identicalNow, checkFailedNow] : [], reviewBlockedNow, ...live ? [runningNow] : [], succeededNow, inactiveNow, unmatchedNow]
  const now = rules.reduce<Draft | null>((found, rule) => found ?? rule(context), null)!  // The last rule always matches.
  return { interruption: null, lane: null, reason: null, reasonSource: null, since: focus?.since ?? null, ...now, focus, missing: [...context.missing] }
}

/** Reason source 0: the latest in-scope controller row that blocked or interrupted the run. */
function controllerRow(context: Context, kinds: readonly MarkerKind[] = ['controller_blocked', 'diagnosis', 'interrupted']): Marker | null {
  return context.timeline.markers.filter(marker => marker.run_level && marker.sequence !== null && marker.sequence > context.scope
    && kinds.includes(marker.kind) && (marker.blocked || marker.kind === 'interrupted')).at(-1) ?? null
}

function lastMessage(context: Context, nodeId: string): Row | null {
  return statusRows(context.rows, nodeId).at(-1) ?? null
}

function result(context: Context, uri: string): WorkerResult | null {
  const found = context.results.get(uri)
  if (!found) context.missing.add(uri)
  return found ?? null
}

function checksOf(context: Context, lane: string) {
  return workerOf(context.run.inputs, lane)?.checks ?? []
}

function questionNow(context: Context): Draft | null {
  const [waiting] = waitingQuestions(context.run, context.rows)
  if (!waiting) return null
  const { lane } = waiting
  const headline: Text = [`? Waiting on you: ${lane} asked ${waiting.n === null ? 'a question' : `question ${waiting.n} of ${MAX_QUESTIONS}`}`]
  if (waiting.asked_at) headline.push(' · ', ago(waiting.asked_at))
  headline.push(' · deadline paused')
  const reason: Text | null = waiting.text === null ? null : [`“${waiting.text}”`, ...(waiting.fromLog ? [' (from the event log; answered state not yet exported)'] : [])]
  const answer = workflow('answer', lane, '"<your answer>"')
  return {
    situation: 'question', tone: 'waiting', glyph: '?', lane, since: waiting.asked_at, headline, reason, reasonSource: reason ? 3 : null,
    next: {
      action: 'required', label: `Answer ${lane}'s question`, runbook: [RUNBOOK.questions],
      steps: [command(answer, 'Inside Herdr, with the lane\'s pane showing its session:'), command(`${answer} --no-herdr`, 'From any other shell: record it, then type it into the session it prints:')],
      caveat: 'Outside Herdr the first form records the answer and restarts the deadline, then exits 1: the worker has not received it.',
    },
  }
}

function paneNow(context: Context): Draft | null {
  const [pane] = panes(context.run, context.rows)
  if (!pane) return null
  const reviewer = pane.node_id === 'review'
  return {
    situation: 'pane_attention', tone: 'waiting', glyph: '?', lane: laneOf(pane.node_id), since: pane.since, reasonSource: 4,
    headline: [`? Waiting on you: ${pane.who} needs attention in its pane${pane.state} · since `, clock(pane.since)],
    next: {
      action: 'required', label: `Attach to ${pane.who}'s pane and answer it there`, caveat: null,
      runbook: reviewer ? [RUNBOOK.reviewerPanes, RUNBOOK.interact] : [RUNBOOK.interact, RUNBOOK.launch],
      steps: [command(`"$PY" -m workflow.interactive attach-one "$RUN" --node ${pane.target}`)],
    },
  }
}

function approvalNow(context: Context): Draft | null {
  const node = context.run.detail.snapshot.nodes.find(item => item.status === 'awaiting_approval')
  if (!node) return null
  const since = lastMessage(context, node.node_id)?.event.occurred_at ?? null
  const when: Text = since ? [' since ', clock(since), ' (', ago(since), ')'] : []
  const verdict = ' Not complete until you decide it in the CLI; viewing approves nothing.'
  const base = { situation: 'awaiting_approval' as const, tone: 'waiting' as const, glyph: '?' as const, since }
  if (node.node_id === 'handoff') {
    const handoffs = lanesOf(context.run).map(lane => `--handoff ${lane}=<${lane}-handoff.json>`)
    return {
      ...base, headline: ['? Awaiting your handoff', ...when, '.', verdict],
      next: { action: 'required', label: 'Freeze the workers with each lane\'s handoff', runbook: [RUNBOOK.handoff], caveat: null,
        steps: [prose('Save each lane\'s final summary and open assumptions as JSON ({"summary": "…", "open_assumptions": []}).'), command(workflow('freeze', ...handoffs))] },
    }
  }
  if (node.node_id === 'review') {
    return {
      ...base, headline: ['? Awaiting the review import', ...when, '.', verdict],
      next: { action: 'required', label: 'Import the independent review', runbook: [RUNBOOK.review], caveat: null,
        steps: [command(workflow('review', '--review-file', '<review.json>')), prose('A feature with declared reviewers needs one import per reviewer, each with --reviewer <id>.')] },
    }
  }
  const hash = context.run.review?.bundle_sha256 ?? '<bundle sha256>'
  return {
    ...base, headline: ['? Awaiting your approval', ...when, '. Not complete until you approve it in the CLI; viewing approves nothing.'],
    next: { action: 'required', label: 'Approve the reviewed bundle: a local fast-forward of the source branch, nothing is pushed', runbook: [RUNBOOK.approve], caveat: null,
      steps: [command(workflow('approve', '--bundle-sha256', hash))] },
  }
}

/**
 * A passed design challenge the plan holds (C8, `launch --hold-challenge` or profile attended) and nothing released: the operator
 * reads every concern, then `resume --launch` launches the workers. Nothing blocks, so the accept command is never offered.
 */
function challengeHeldNow(context: Context): Draft | null {
  const challenge = context.run.inputs?.challenge ?? null
  const hold = challenge?.hold ?? null
  if (challenge?.status !== 'passed' || hold === null || hold.released_at !== null) return null
  const [first] = challenge.concerns
  return {
    situation: 'challenge_held', tone: 'paused', glyph: '‖', since: lastMessage(context, 'challenge')?.event.occurred_at ?? hold.held_at,
    headline: [`‖ Held: the design challenge passed with ${plural(challenge.concerns.length, 'P2 concern')}; no worker launched until you release it`],
    reason: first ? [`${first.severity}: ${first.message}${challenge.concerns.length > 1 ? ` (+${challenge.concerns.length - 1} more)` : ''}`] : null,
    next: {
      action: 'required', label: 'Read every concern, then launch the workers, or revise the feature files and rerun the challenge', runbook: [RUNBOOK.challenge],
      caveat: 'Add --drop <n>,<m> to leave numbered notes out of the workers\' prompts.',
      steps: [command(workflow('resume', '--launch'), 'Launch the workers with the challenge notes:'),
        command(workflow('resume'), "Or edit the tasks, decisions.md or the PRD in the run's source checkout, then rerun the challenge; it holds again when it passes:")],
    },
  }
}

function challengeNow(context: Context): Draft | null {
  const node = snapshotNode(context.run.detail, 'challenge')
  const challenge = context.run.inputs?.challenge ?? null
  if (node?.status !== 'paused' && challenge?.status !== 'paused') return null
  const blocking = (challenge?.concerns ?? []).filter(concern => concern.severity === 'P0' || concern.severity === 'P1')
  const counts = (['P0', 'P1'] as const).map(severity => [severity, blocking.filter(concern => concern.severity === severity).length] as const)
    .filter(([, count]) => count > 0).map(([severity, count]) => `${count} ${severity}`).join(' and ')
  const [first] = blocking
  return {
    situation: 'challenge_paused', tone: 'paused', glyph: '‖', since: lastMessage(context, 'challenge')?.event.occurred_at ?? challenge?.decided_at ?? null,
    headline: [`‖ Paused: the design challenge found ${counts || 'a blocking concern'}; no worker launched`],
    reason: first ? [`${first.severity}: ${first.message}${blocking.length > 1 ? ` (+${blocking.length - 1} more)` : ''}`] : null,
    next: {
      action: 'required', label: 'Revise the feature files and rerun the challenge, or accept it with a reason', runbook: [RUNBOOK.challenge], caveat: null,
      steps: [command(workflow('resume'), "After editing the tasks, decisions.md or the PRD in the run's source checkout (the paused message and status name it):"),
        command(workflow('resume', '--accept-challenge', '"<reason>"'), 'Or record an override with your reason and launch the workers:')],
    },
  }
}

/**
 * Rule 5 (b)'s note: the focus node's latest row is its own raw `interrupted` status (served paused on the row) with a
 * resume note. After Ctrl-C the node is served paused (automatic.py:804); after an outage its task keeps the graph error
 * and the node is served failed (the freeze's note at :1314, the review's at :624 and :811). `resumed` is the PID row of
 * a controller started since: it re-enters the node, and a resumed review may record nothing more until its verdict.
 */
function interruptionNote(context: Context): { row: Row; resumed: Marker | null } | null {
  const { focus } = context
  if (!focus || (focus.status !== 'paused' && focus.status !== 'failed')) return null
  const latest = context.rows.filter(other => other.node === focus.node_id && other.marker === null).at(-1)
  if (!latest || latest.status !== 'paused' || !NODE_RESUME_NOTE.test(latest.event.message) || CONTINUE_WITH.test(latest.event.message)) return null
  const resumed = context.timeline.markers.find(marker => marker.kind === 'controller_start' && marker.sequence !== null && marker.sequence > latest.event.sequence) ?? null
  return { row: latest, resumed }
}

/**
 * The run moves without the operator: it is served running, the supervisor retries a failed check (rule 8), or a
 * resumed controller re-entered a step that still reads failed or paused until it ends.
 */
function moving(context: Context): boolean {
  if (context.status === 'running' || interruptionNote(context)?.resumed) return true
  if (context.run.detail.snapshot.nodes.some(node => context.timeline.byNode.get(node.node_id)?.at(-1)?.live)) return true
  return context.automatic && retryPlan(context) !== null
}

/**
 * Rule 5 (a)'s next step after a resumable stop of the controller's own (BRANCH_CHANGED, START_INCOMPLETE): the step its row
 * names, then the resume. Null for every other interrupted row.
 */
function resumableStopNext(context: Context, raw: string): NextStep | null {
  const resume = command(workflow('automatic', '--live'))
  if (BRANCH_CHANGED.test(raw)) {
    const branch = context.run.inputs?.source_branch ?? '<source branch>'
    // The stop names the checkout (automatic.py source_branch_note), but the server redacts every path in a message, so the
    // first step is the command that prints it: the run's own worktree since C56, the target checkout before. The switch is
    // text, not a command step: those are the workflow CLI's own.
    const find = command(workflow('status'), "Find the run's source checkout: status prints its path as source_checkout (for runs launched since per-run checkouts, the run directory's path plus .source):")
    return {
      action: 'required', label: `Switch the run's source checkout back to ${branch}, then resume the controller: it relaunches nothing`,
      runbook: [RUNBOOK.sourceBranch], steps: [find, prose(`git -C <source checkout> switch ${branch}`), resume], caveat: null,
    }
  }
  if (!START_INCOMPLETE.test(raw)) return null
  if (NEVER_STARTED.test(raw)) {
    return { action: 'required', label: 'Start the run, then resume the controller', runbook: [RUNBOOK.ambiguousStartup], steps: [command(workflow('start', '--live')), resume], caveat: null }
  }
  return {
    action: 'required', label: 'Reconcile the launches that did not complete, then resume the controller: nothing is relaunched', runbook: [RUNBOOK.ambiguousStartup],
    steps: [prose('Inspect each lane\'s launch receipt (<lane>.interactive.json) and claude agents --json.'), command(workflow('reconcile')), resume], caveat: null,
  }
}

function interruptedNow(context: Context): Draft | null {
  // A failed run too: a freeze or review interrupted by an outage, and a check being retried, keep their task's graph
  // error until they are re-entered, so the server serves the node and the run failed (projectSnapshot ranks task.error first).
  if (context.status !== 'paused' && context.status !== 'running' && context.status !== 'failed') return null
  const { focus } = context
  const where = focus?.label ?? 'the run'
  const resume = (caption?: string) => [command(workflow('automatic', '--live'), caption)]
  const claudeWorks = 'Once `claude --version` works:'
  const base = { situation: 'interrupted' as const, tone: 'interrupted' as const, glyph: '‖' as const }
  const label = 'Resume the controller: it waits for the same sessions and relaunches nothing'
  // (a) A run-level interrupted row that nothing followed: no status row, no resumed controller (its PID row) and no block.
  const row = controllerRow(context, ['interrupted'])
  const followed = (sequence: number) => context.rows.some(other => other.event.sequence > sequence
    && ((other.status !== null && other.marker === null) || other.marker === 'controller_start' || other.blocked))
  if (row && !followed(row.sequence!)) {
    const unavailable = UNAVAILABLE.test(row.raw)
    return {
      ...base, interruption: 'a', since: row.at, reasonSource: 0,
      headline: [`‖ Interrupted at ${where} · `, clock(row.at), unavailable ? ': Claude Code was unavailable; sessions keep running' : ': the controller stopped; sessions keep running'],
      reason: [clock(row.at), ` ${row.message}`],
      next: resumableStopNext(context, row.raw)
        ?? { action: 'required', label, runbook: unavailable ? [RUNBOOK.unavailable] : [RUNBOOK.launch, RUNBOOK.reviewInterruption], steps: resume(unavailable ? claudeWorks : undefined), caveat: null },
    }
  }
  // (b) The review or the freeze recorded the interruption on its own node, and no controller has resumed it since.
  const note = interruptionNote(context)
  if (note && !note.resumed) {
    const { row: latest } = note
    const freeze = FREEZE_NOTE.test(latest.event.message)
    return {
      ...base, interruption: 'b', since: latest.event.occurred_at, reasonSource: 4,
      headline: [`‖ Interrupted at ${where} · `, clock(latest.event.occurred_at),
        freeze ? ': the freeze was stopping the workers; resuming completes its recorded stops' : ': the controller stopped; sessions keep running'],
      reason: [latest.text],
      next: { action: 'required', label, runbook: freeze ? [RUNBOOK.unavailable] : [RUNBOOK.reviewInterruption], steps: resume(UNAVAILABLE.test(latest.event.message) ? claudeWorks : undefined), caveat: null },
    }
  }
  // (c) The run would move by itself, but its controller process is gone.
  const readings = context.run.controller ?? []
  if (controllerNotRunning(readings) && moving(context)) {
    return {
      ...base, interruption: 'c', since: notRunningSince(readings),
      headline: [`‖ Interrupted at ${where}: the controller is not running; sessions keep running`],
      next: { action: 'required', label, runbook: [RUNBOOK.launch, RUNBOOK.reviewInterruption], steps: resume(), caveat: null },
    }
  }
  // (d) A repair was applied and the run waits for its continuation.
  if (focus?.status === 'paused' && (focus.node_id.startsWith('verify_') || focus.node_id === 'candidate')) {
    const repair = context.rows.filter(other => other.node?.startsWith('verify_') && REPAIR_BY_OPERATOR.test(other.event.message) && CONTINUE_WITH.test(other.event.message)).at(-1)
    const newer = repair && context.rows.some(other => other.event.sequence > repair.event.sequence && other.status !== null && other.marker === null && !/^Repair \d+ /.test(other.event.message))
    if (repair && !newer) {
      const n = REPAIR_BY_OPERATOR.exec(repair.event.message)![1]
      const retry = CONTINUE_WITH.exec(repair.event.message)![1] === 'retry'
      return {
        ...base, interruption: 'd', since: repair.event.occurred_at, reasonSource: 4,
        headline: [`‖ Repair ${n} applied; the run continues when you resume it`],
        reason: [repair.text],
        next: { action: 'required', label: 'Continue the repaired run', runbook: [RUNBOOK.repair], caveat: null,
          steps: [command(retry ? workflow('retry') : workflow('automatic', '--live'))] },
      }
    }
  }
  return null
}

function blockedBeforeFreezeNow(context: Context): Draft | null {
  const { focus } = context
  if (!context.automatic || !focus) return null
  if (focus.node_id !== 'handoff' && !(focus.node_id.startsWith('launch_') && focus.status === 'failed')) return null
  if (context.run.detail.snapshot.nodes.some(node => node.node_id.startsWith('verify_') && node.status !== 'pending')) return null
  const row = controllerRow(context, ['controller_blocked', 'diagnosis'])
  const blocked = context.run.inputs?.workers.find(worker => worker.completion?.status === 'blocked')
  if (!row && !blocked) return null
  const fourth = row ? FOURTH_QUESTION.exec(row.raw) : null
  const cause = fourth ? `${fourth[1]} asked a fourth question: ${fourth[2]}` : row ? row.message : `${blocked!.node_id} reported blocked: ${blocked!.completion!.summary}`
  const unconfirmed = context.rows.some(other => other.node === 'handoff' && other.event.sequence > context.scope && STOP_UNCONFIRMED.test(other.event.message) && other.marker === null)
  const steps: Step[] = [
    ...(unconfirmed ? [prose('Stop the sessions the controller could not confirm stopped, by their exact ids from each lane\'s <lane>.interactive.json (claude stop <background_id>).')] : []),
    prose('Fix the cause in the feature files if it lies there, and commit them in the target.'),
    command(`"$PY" -m workflow launch <feature> --repo <target repo> --run-id <new run id> --live --automatic ${BY_OPERATOR}`),
  ]
  return {
    situation: 'blocked_before_freeze', tone: 'blocked', glyph: '✗', since: row?.at ?? focus.since, lane: fourth?.[1] ?? blocked?.node_id ?? null,
    headline: [`✗ Blocked before freeze at ${focus.label} · ${cause}.${DID_NOT_COMPLETE}`],
    reason: row ? [clock(row.at), ` ${row.message}`] : [cause], reasonSource: row ? 0 : 3,
    next: {
      action: 'required', label: '`repair` refuses a lane blocked before freeze; an automatic run then needs a new run', caveat: null,
      runbook: [RUNBOOK.repair, RUNBOOK.launch, ...(unconfirmed ? [RUNBOOK.stopping] : [])], steps,
    },
  }
}

type LaneVerdict = {
  lane: string
  attempt: number
  result: WorkerResult | null
  /** The attempt before, read only when it checked the lane's current revision (a repair restarts the comparison). */
  previous: WorkerResult | null
  phase: 'worker' | 'candidate'
  /** The row that opened a retry still running (`reentered`); `attempt` is then the failed attempt before it. */
  running: Row | null
}

/** The failing lanes of a failed verify or candidate focus, with their latest two results (reason source 2). */
function failingLanes(context: Context): LaneVerdict[] {
  const { focus } = context
  if (!focus || focus.status !== 'failed') return []
  const detail = context.run.detail
  const previousOf = (phase: 'worker' | 'candidate', lane: string, attempt: number) =>
    attempt - 1 > attemptFloor(context, phase, lane) ? result(context, resultUri(detail, phase, lane, attempt - 1)) : null
  if (focus.node_id.startsWith('verify_')) {
    const lane = focus.node_id.slice('verify_'.length)
    const { attempt, running } = verdictAttempt(detail, context.rows, focus.node_id, context.automatic)
    if (attempt < 1) return []
    return [{ lane, attempt, phase: 'worker', running, result: result(context, resultUri(detail, 'worker', lane, attempt)), previous: previousOf('worker', lane, attempt) }]
  }
  if (focus.node_id !== 'candidate') return []
  const lanes = snapshotNode(detail, 'candidate')!.lane_results.map(entry => ({
    lane: entry.worker, attempt: entry.attempt, phase: 'candidate' as const, running: null, result: result(context, entry.result_uri),
    previous: previousOf('candidate', entry.worker, entry.attempt),
  }))
  const failed = lanes.filter(lane => lane.result?.status === 'failed')
  return failed.length ? failed : lanes.filter(lane => lane.result === null)
}

/** The attempts before the lane's current revision: a repair restarts the budget at its floor ("attempts worker:game 3" gives 2). */
function attemptFloor(context: Context, phase: 'worker' | 'candidate', lane: string): number {
  const repaired = context.timeline.markers.filter(marker => marker.kind === 'repair').map(marker => new RegExp(`\\b${phase}:${lane} (\\d+)`).exec(marker.raw)).filter(match => match !== null).at(-1)
  return repaired ? Number(repaired[1]) - 1 : 0
}

/** automatic.py same_revision: both attempts checked one revision; an unknown commit counts as the same. */
function sameRevision(a: WorkerResult, b: WorkerResult): boolean {
  return a.output_commit === null || b.output_commit === null || a.output_commit === b.output_commit
}

function diagnoses(context: Context): Marker[] {
  const { focus } = context
  return context.timeline.markers.filter(marker => marker.kind === 'diagnosis' && marker.sequence! > context.scope && marker.node_id === focus?.node_id)
}

/**
 * Rule 7: the failing lanes the controller stops on before review. A diagnosis row for the lane in scope, or its latest
 * two attempts on one revision failing with one reason (advance_failed_checks: same_revision and equal gate reasons).
 */
function identicalLanes(context: Context): LaneVerdict[] {
  const { focus } = context
  if (!focus || focus.status !== 'failed' || !(focus.node_id.startsWith('verify_') || focus.node_id === 'candidate')) return []
  if (context.run.review || snapshotNode(context.run.detail, 'review')?.status !== 'pending') return []
  const diagnosed = diagnoses(context)
  return failingLanes(context).filter(lane => diagnosed.some(marker => marker.lane === lane.lane)
    || (lane.result?.status === 'failed' && lane.previous?.status === 'failed' && lane.result.error?.message === lane.previous.error?.message
      && sameRevision(lane.result, lane.previous)))
}

function identicalNow(context: Context): Draft | null {
  const { focus } = context
  const identical = identicalLanes(context)
  if (!focus || !identical.length) return null
  const diagnosed = diagnoses(context)
  const names = identical.map(lane => lane.lane).join(',')
  const [first] = identical
  const diagnosis = diagnosed.map(marker => IDENTICAL.exec(marker.raw)).find(match => match?.[2] === first.lane)
  const [a, b] = diagnosis ? [diagnosis[3], diagnosis[4]] : [first.attempt - 1, first.attempt]
  const commit = (dryRun: boolean) => workflow('repair', names, '--commit', '<sha>', '--reason', '"<why>"', ...(dryRun ? ['--dry-run'] : []))
  return {
    situation: 'blocked_identical', tone: 'blocked', glyph: '✗', lane: names,
    headline: [`✗ Blocked at ${focus.label} · lane${identical.length > 1 ? 's' : ''} ${identical.map(lane => lane.lane).join(', ')} failed identically on attempts ${a} and ${b}`,
      ...(focus.since ? [' · ', clock(focus.since)] : []), `.${DID_NOT_COMPLETE}`],
    reason: first.result ? [gateSummary(first.result, checksOf(context, first.lane))] : diagnosed.length ? [diagnosed.at(-1)!.message] : null,
    reasonSource: first.result ? 2 : 0,
    next: {
      action: 'required', label: 'A lane repair turns your fix commit into new snapshots; it launches nothing and runs no check', runbook: [RUNBOOK.repair], caveat: null,
      steps: [
        command(workflow('repair', names, '--workspace')),
        prose('Commit the fix in $RUN/repair-workspace-<n> (the command above prints it), never on the source branch.'),
        command(commit(true), 'Check what it would do:'),
        command(commit(false), 'The same command without --dry-run applies it:'),
        command(context.automatic ? workflow('automatic', '--live') : workflow('retry'), 'Then continue the run:'),
      ],
    },
  }
}

type RetryPlan = { lane: LaneVerdict; attempt: number; offset: number; cap: number }

/**
 * Rule 8's premise: a failed verify or candidate below its attempt cap on the lane's revision, not identical (rule 7),
 * and with no controller row in scope that stopped the run (such a row goes to rule 13 as reason source 0). An
 * automatic run reads failed for its whole retry: the task keeps its graph error until the retry ends.
 */
function retryPlan(context: Context): RetryPlan | null {
  const { focus } = context
  if (!focus || focus.status !== 'failed' || !(focus.node_id.startsWith('verify_') || focus.node_id === 'candidate')) return null
  const [lane] = failingLanes(context)
  if (!lane) return null
  const cap = context.run.inputs?.max_verification_attempts ?? 3
  const offset = attemptFloor(context, lane.phase, lane.lane)
  if (lane.attempt - offset >= cap || identicalLanes(context).length || controllerRow(context, ['controller_blocked', 'diagnosis'])) return null
  return { lane, attempt: lane.attempt - offset, offset, cap }
}

function checkFailedNow(context: Context): Draft | null {
  const plan = retryPlan(context)
  const { focus } = context
  if (!plan || !focus) return null
  const { lane, attempt, offset, cap } = plan
  const failed = statusRows(context.rows, focus.node_id).filter(row => row.status === 'failed').at(-1)
  const summary = lane.result ? gateSummary(lane.result, checksOf(context, lane.lane)) : failed?.text ?? 'the gate did not pass'
  const candidate = focus.node_id === 'candidate'
  const headline: Text = [`✗ ${focus.label} failed attempt ${attempt} of ${cap}${candidate ? ` (lane ${lane.lane})` : ''}: ${summary}`]
  const running = lane.running ? (lane.running.attempt ?? lane.attempt + 1) - offset : null
  if (lane.running) headline.push(` · attempt ${running} running since `, clock(lane.running.event.occurred_at))
  const runbook = [candidate ? RUNBOOK.failedCandidate : RUNBOOK.failedVerification]
  return {
    situation: 'check_failed', tone: 'failed', glyph: '✗', lane: lane.lane, since: failed?.event.occurred_at ?? focus.since, headline,
    reason: lane.result?.error ? [lane.result.error.message] : null, reasonSource: lane.result ? 2 : 4,
    next: context.automatic
      ? { action: 'none', label: 'No action: the supervisor retries by itself within the limit.', runbook, steps: [], caveat: null }
      : lane.running
        ? { action: 'none', label: `No action needed while attempt ${running} runs.`, runbook, steps: [], caveat: null }
        : {
          action: 'required', label: 'Rerun the check at the same revision when the failure was transient', caveat: null, runbook,
          steps: [command(workflow('retry', '--phase', lane.phase, '--node', lane.lane))],
        },
  }
}

function reviewBlockedNow(context: Context): Draft | null {
  const review = context.run.review
  if (review?.verdict !== 'blocked') return null
  // The cause first: the reviewers that blocked, then the others in their declared order.
  const ordered = [...review.reviewers].sort((a, b) => Number(b.status === 'blocked') - Number(a.status === 'blocked'))
  const reviewers = ordered.map(entry => {
    if (entry.status === 'superseded') return `${entry.reviewer_id} was superseded (no verdict)`
    if (entry.status === 'pending') return `${entry.reviewer_id} gave no verdict`
    const blocking = entry.findings.filter(isBlockingFinding)
    if (!blocking.length) return entry.status === 'blocked' ? `${entry.reviewer_id} blocked the candidate` : `${entry.reviewer_id} approved`
    const counts = (['P0', 'P1'] as const).map(severity => [severity, blocking.filter(finding => finding.severity === severity).length] as const)
      .filter(([, count]) => count > 0).map(([severity, count]) => `${count} open ${severity}`).join(' and ')
    return `${entry.reviewer_id} blocked the candidate: ${counts} — ${firstSentence(blocking[0].message)}`
  })
  const label = context.focus?.node_id === 'review' ? context.focus.label : labelOf(context.run.detail, 'review')
  return {
    situation: 'review_blocked', tone: 'blocked', glyph: '✗', since: review.reviewed_at,
    headline: [`✗ Blocked by review at ${label} · `, clock(review.reviewed_at), ' (', ago(review.reviewed_at), `).${DID_NOT_COMPLETE}`],
    reason: [reviewers.map(line => /[.!?]$/.test(line) ? line : `${line}.`).join(' ')], reasonSource: 1,
    next: {
      action: 'required', label: 'Findings after review are fixed in a follow-up run, not repaired in place', caveat: null,
      runbook: [RUNBOOK.changedCode, RUNBOOK.verdict, RUNBOOK.contract],
      // C30: the brief prints each lane's restore recipe, every reviewer's findings and the workers' claims; the follow-up is a
      // new run id of the same feature that pins what it follows (launch --follows). The label and the text step stay short: at
      // 390×844 the whole banner fits the first screen (ux-run [scenario:narrow-run]).
      steps: [
        command(workflow('brief')),
        prose('Paste what each lane needs from the brief (restore recipe, findings, untested claims) into its task and commit it.'),
        command(`"$PY" -m workflow launch <feature> --repo <target repo> --run-id <feature>-<next number> --follows "$RUN" --live --automatic ${BY_OPERATOR}`),
      ],
    },
  }
}

function runningNow(context: Context): Draft | null {
  // Also a step re-entered while it still reads failed (a live span), and the focus a resumed controller re-entered (5 b).
  const resumed = interruptionNote(context)?.resumed ?? null
  const running = context.run.detail.snapshot.nodes.filter(node => !ADVISORY_NODE_IDS.has(node.node_id) && (node.status === 'running' || context.timeline.byNode.get(node.node_id)?.at(-1)?.live))
  if (!running.length && !resumed && context.status !== 'running') return null
  // The attack pass runs on inside the review step after the review decided (focusOf keeps the review): the review stays the
  // current step, so the banner names it, never "between steps" and never the report-only attack node (PRD_ATTACK_PASS 4.6).
  const attackWait = !running.length && context.focus?.node_id === 'review'
    && context.run.detail.snapshot.nodes.some(node => node.node_id === ATTACK_NODE_ID && node.status === 'running')
  const repair = repairOf(context.run.detail, context.focus?.node_id ?? '')
  const answering = repair && context.focus?.status === 'running' ? repair : undefined
  const headline: Text = [answering ? `● Running: repair ${answering.n} of ${answering.lane} (round ${answering.round} of ${answering.rounds}) after ${answering.trigger} blocked` : '● Running']
  // The repair's sentence names the step it answers; the generic prefixes below are for every other focus.
  if (!answering && resumed && context.focus) headline.push(` · ${context.focus.label} · resumed at `, clock(resumed.at))
  else if (!answering && attackWait && context.focus) headline.push(` · ${context.focus.label}`)
  else if (!answering && !running.length) headline.push(' · between steps')
  for (const node of answering ? [] : running.slice(0, 2)) {
    headline.push(` · ${labelOf(context.run.detail, node.node_id)}`)
    const span = context.timeline.byNode.get(node.node_id)?.at(-1)
    const worker = workerOf(context.run.inputs, node.node_id.startsWith('launch_') ? laneOf(node.node_id) : null)
    if (span?.start) headline.push(worker ? ' · working ' : ' · ', { kind: 'elapsed', from: span.start.at })
    const deadline = worker ? workerDeadline(context.run.inputs!, worker) : null
    if (deadline === 'paused') headline.push(' · deadline paused while a question waits')
    else if (deadline) headline.push(' · deadline ', clock(deadline), ' (', { kind: 'left', until: deadline }, ' left)')
  }
  const last = context.timeline.lastActivity
  if (last) headline.push(' · last activity ', ago(last.at), `: ${INTERNAL.get(context.timeline)?.lastActivityText ?? ''}`)
  const watch = running.flatMap(node => node.node_id.startsWith('launch_') ? [command(`"$PY" -m workflow.interactive attach-one "$RUN" --node ${laneOf(node.node_id)}`, 'Optional, to watch a pane:')] : [])
  return {
    situation: 'running', tone: 'running', glyph: '●', headline,
    since: answering ? context.timeline.byNode.get(answering.node_id)?.at(-1)?.start?.at ?? context.focus?.since ?? null
      : resumed?.at ?? (running.length ? context.timeline.byNode.get(running[0].node_id)?.at(-1)?.start?.at ?? null : attackWait ? context.focus?.since ?? null : null),
    next: { action: 'none', label: context.automatic ? 'No action needed: the controller is supervising.' : 'No action needed while the steps run.', runbook: [], steps: watch, caveat: null },
  }
}

/** Rule 9 of 5.2: `native_started_at + worker_timeout_seconds + Σ(question waits)`, or `paused` while a question waits. */
function workerDeadline(inputs: RunInputs, worker: RunInputWorker): string | 'paused' | null {
  if (!inputs.automatic || !worker.launch) return null
  if (worker.questions.some(question => question.answer === null)) return 'paused'
  const waited = worker.questions.reduce((sum, question) => sum + (question.answered_at ? ms(question.answered_at) - ms(question.asked_at) : 0), 0)
  const start = worker.launch.native_started_at ?? worker.launch.launch_requested_at
  return new Date(ms(start) + inputs.automatic.worker_timeout_seconds * 1000 + waited).toISOString()
}

/** C7: a succeeded run whose plan asks for a tryout (feature.json 2.4.0 `tryout: true`) and holds no verdict yet. */
export function isUntried(run: Pick<RunData, 'detail' | 'inputs'>): boolean {
  const tryout = run.inputs?.tryout
  return run.detail.snapshot.status === 'succeeded' && tryout?.required === true && tryout.verdicts.length === 0
}

/** The first paragraph of a pinned task's `## Goal` section, on one line; null when the task has none (or was cut before it). */
function taskGoal(text: string): string | null {
  const section = /^##[ \t]+Goal[ \t]*$([\s\S]*?)(?=^#{1,2}[ \t]|(?![\s\S]))/m.exec(text)?.[1] ?? ''
  const paragraph = section.trim().split(/\n\s*\n/)[0]?.replace(/\s+/g, ' ').trim()
  return paragraph || null
}

/** The try-this lines of an untried run (C7): each lane's task Goal and its worker's `verify_yourself`, from the inputs the viewer has. */
function tryThisLines(inputs: RunInputs): Step[] {
  return inputs.workers.flatMap(worker => {
    const goal = taskGoal(worker.task.text)
    const verify = worker.completion?.verify_yourself ?? null
    return [...goal ? [prose(`${worker.node_id}: ${goal}`)] : [], ...verify ? [prose(`${worker.node_id}, verify yourself: ${verify}`)] : []]
  })
}

function succeededNow(context: Context): Draft | null {
  if (context.status !== 'succeeded') return null
  const integrated = lastMessage(context, 'integrate')
  const commit = COMMIT.exec(integrated?.event.message ?? '')?.[0] ?? context.run.review?.candidate_commit ?? null
  const branch = context.run.inputs?.source_branch
  const { runStart, runEnd } = context.timeline
  const headline: Text = [commit ? `✓ Integrated ${commit.slice(0, 7)}${branch ? ` into ${branch}` : ''} · no push performed` : '✓ Succeeded · no push performed']
  if (runEnd) headline.push(' · took ', { kind: 'span', ms: ms(runEnd.at) - ms(runStart.at) })
  const review = context.run.review
  if (review) {
    const approvers = review.reviewers.filter(entry => entry.verdict === 'approved').map(entry => entry.reviewer_id)
    const openP2 = review.findings.filter(finding => finding.severity === 'P2' && finding.disposition === 'open').length
    headline.push(` · review approved${approvers.length ? ` by ${approvers.join(' and ')}` : ''}${openP2 ? ` · ${openP2} open P2` : ''}`)
  }
  const tryout = context.run.inputs?.tryout
  if (context.run.inputs && isUntried(context.run)) {
    // C7: the operator tries the candidate and records the verdict; the record is advisory, since nothing merges main.
    headline.push(' · untried')
    return {
      situation: 'succeeded', tone: 'succeeded', glyph: '✓', since: runEnd?.at ?? null, headline,
      next: {
        action: 'required', label: 'Try the candidate before you merge it, then record what you found', runbook: [RUNBOOK.tryout],
        steps: [...tryThisLines(context.run.inputs), command(workflow('tryout', '--result', '<works|broken|skipped>', '--note', '"<what you tried>"'))],
        caveat: 'Each check row keeps its screenshots. Merging or pushing is still your decision.',
      },
    }
  }
  if (tryout?.required && tryout.verdicts.length) headline.push(` · tried: ${tryout.verdicts.at(-1)!.result}`)
  return {
    situation: 'succeeded', tone: 'succeeded', glyph: '✓', since: runEnd?.at ?? null, headline,
    next: { action: 'none', label: 'Nothing required by the workflow. Merging or pushing is your decision.', runbook: [RUNBOOK.approve], steps: [], caveat: null },
  }
}

function inactiveNow(context: Context): Draft | null {
  if (context.status !== 'cancelled' && context.status !== 'pending') return null
  // abandon.py's row says who abandoned the run and why.
  const abandoned = context.rows.filter(row => row.status === 'cancelled' && ABANDONED_ROW.test(row.event.message)).at(-1) ?? null
  return {
    situation: 'inactive', tone: 'inactive', glyph: '○', ...abandoned ? { since: abandoned.event.occurred_at, reason: [abandoned.event.message], reasonSource: 0 as const } : {},
    headline: [context.status === 'cancelled' ? '○ Cancelled before completion' : '○ Not started: nothing has run yet'],
    next: { action: 'none', label: 'Nothing to do.', runbook: [], steps: [], caveat: null },
  }
}

function unmatchedNow(context: Context): Draft {
  const { focus } = context
  const where = focus?.label ?? 'the run'
  const row = controllerRow(context)
  let reason: string
  let source: Now['reasonSource']
  const failing = row ? [] : failingLanes(context)
  const completion = focus ? workerOf(context.run.inputs, laneOf(focus.node_id))?.completion : null
  if (row) { reason = row.message; source = 0 }
  else if (failing[0]?.result) { reason = gateSummary(failing[0].result, checksOf(context, failing[0].lane)); source = 2 }
  else if (completion && (completion.status === 'blocked' || completion.status === 'question')) { reason = completion.question ?? completion.summary; source = 3 }
  else {
    // A focus without a status row of its own takes the failed dependency row that opened the scope window: the handoff a
    // controller block failed when that block was aliased onto a lane named `controller` (C6; B1's patterns keep it there).
    const own = focus ? lastMessage(context, focus.node_id) : null
    const quoted = own ?? context.rows.find(other => other.event.sequence === context.scope && other.marker === null && other.status === 'failed' && other.node !== focus?.node_id) ?? null
    reason = quoted?.text || 'no reason was recorded'
    source = quoted ? 4 : null
  }
  const paused = context.status === 'paused'
  return {
    situation: 'no_rule_matched', tone: paused ? 'paused' : 'failed', glyph: paused ? '‖' : '✗', reasonSource: source,
    since: row?.at ?? focus?.since ?? null,
    headline: [`${paused ? '‖ Paused' : '✗ Failed'} at ${where} · ${reason}${paused ? '' : `.${DID_NOT_COMPLETE}`}`],
    reason: row ? [clock(row.at), ` ${row.message}`] : null,
    next: {
      action: 'unknown', label: 'No known next step matched.', runbook: [RUNBOOK.recovery], caveat: null,
      steps: [command(workflow('status'), 'Reports the run\'s state and its next step and changes no run progress; it writes nothing (export refreshes report.html):')],
    },
  }
}

// ---- Lanes line (4.2) ---------------------------------------------------------------------------------------------

/** One line per lane for runs with two or more lanes: worker, verify and candidate, with no durations. */
export function laneLines(run: RunData): LaneLine[] {
  const lanes = lanesOf(run)
  if (lanes.length < 2) return []
  const { detail } = run
  const timeline = buildTimeline(run)
  const cap = run.inputs?.max_verification_attempts ?? 3
  const candidate = snapshotNode(detail, 'candidate')
  return lanes.map(lane => {
    const steps: LaneLine['steps'] = []
    const launch = snapshotNode(detail, `launch_${lane}`)
    if (launch) steps.push({ node_id: launch.node_id, step: 'worker', status: launch.status, text: `worker ${GLYPH[launch.status]}` })
    const verify = snapshotNode(detail, `verify_${lane}`)
    if (verify) {
      const spans = timeline.byNode.get(verify.node_id) ?? []
      const failed = spans.filter(span => span.status === 'failed').length
      // A retry that still reads failed is running (see `reentered`).
      const status: NodeStatus = spans.at(-1)?.live ? 'running' : verify.status
      steps.push({ node_id: verify.node_id, step: 'verify', status,
        text: `verify ${GLYPH[status]}${verify.attempt > 1 ? ` attempt ${verify.attempt}${failed ? ` (${failed} failed)` : ''}` : ''}` })
    }
    if (candidate) {
      const entry = candidate.lane_results.find(item => item.worker === lane)
      const outcome = entry ? run.results?.get(entry.result_uri) : undefined
      const status: NodeStatus = outcome ? (outcome.status === 'cancelled' ? 'cancelled' : outcome.status) : candidate.status
      const checks = workerOf(run.inputs, lane)?.checks ?? []
      const text = outcome?.status === 'succeeded' ? `candidate ✓ ${plural(outcome.checks.length, 'check')}`
        : outcome?.status === 'failed' ? `candidate ✗ attempt ${entry!.attempt} of ${cap}: ${gateSummary(outcome, checks)}`
          : `candidate ${GLYPH[status]}`
      steps.push({ node_id: 'candidate', step: 'candidate', status, text })
    }
    return { lane, steps }
  })
}

// ---- Controller liveness (6.3) -------------------------------------------------------------------------------------

/** Where the current run of `not_running` readings began, or null when the latest reading is something else. */
function notRunningSince(readings: readonly ControllerReading[]): string | null {
  let since: string | null = null
  for (const reading of readings) since = reading.value === 'not_running' ? since ?? reading.at : null
  return since
}

/** True when the latest readings have said `not_running` for at least `minMs`: one reading can be a checkpoint hand-over. */
export function controllerNotRunning(readings: readonly ControllerReading[], minMs = CONTROLLER_DEBOUNCE_MS): boolean {
  const since = notRunningSince(readings)
  const latest = readings.at(-1)
  return since !== null && latest !== undefined && ms(latest.at) - ms(since) >= minMs
}

// ---- Plain text ---------------------------------------------------------------------------------------------------

/** How `textToString` renders times; the UI passes its own zone-aware formatters (S1's `time.ts`). */
export type TextFormat = { clock(at: string): string; ago(at: string, now: number): string; span(ms: number): string }

function spanText(duration: number): string {
  const seconds = Math.round(duration / 1000)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
  const minutes = Math.round(seconds / 60)
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

/** UTC `HH:MM`, `46s`/`2m29s`/`1h05m` and "12 min ago": enough for tests and plain-text consumers. */
export const plainTextFormat: TextFormat = {
  clock: at => new Date(at).toISOString().slice(11, 16),
  span: spanText,
  ago: (at, now) => {
    const seconds = Math.max(0, Math.round((now - ms(at)) / 1000))
    if (seconds < 60) return `${seconds} s ago`
    const minutes = Math.round(seconds / 60)
    if (minutes < 60) return `${minutes} min ago`
    const hours = Math.round(minutes / 60)
    return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`
  },
}

/** Flattens rich text at `now`; inferred clocks and spans get the `≈` prefix. */
export function textToString(text: Text | null, now = Date.now(), format: TextFormat = plainTextFormat): string {
  return (text ?? []).map(part => {
    if (typeof part === 'string') return part
    switch (part.kind) {
      case 'clock': return `${part.inferred ? '≈' : ''}${format.clock(part.at)}`
      case 'ago': return format.ago(part.at, now)
      case 'span': return `${part.inferred ? '≈' : ''}${format.span(part.ms)}`
      case 'elapsed': return format.span(Math.max(0, now - ms(part.from)))
      case 'left': return format.span(Math.max(0, ms(part.until) - now))
    }
  }).join('')
}
