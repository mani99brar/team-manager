import { ControlError } from './client.ts'
import type { Control, ControlId, ControlRecord, Params, ParamSpec, RunControls } from './types.ts'

/** What the operator has entered in a control's dialog; one field per kind of `ParamSpec`. */
export type DialogValues = { lane: string; phase: string; drop: number[]; text: string; reason: string; confirm_run_id: string }

export type DialogPreset = { lane?: string; phase?: string }

export const REASON_LABEL: Record<string, string> = { text: 'Your answer', reason: 'Reason' }

// ---- The note control (docs/PRD_RUN_TEAMS.md "Steering", section 7) ------------------------------------------------------

/** The note dialog's field label and helper (7). */
export const NOTE_FIELD_LABEL = 'Your note'
export const NOTE_FIELD_HELPER = 'Plain text, up to 4,000 characters. The lead reads it as an operator note, which may amend its task.'
export const NOTE_CONFIRM = 'Send note'
export const NOTE_UNDELIVERABLE = 'Not delivered: the pane was busy, not attached, or the lane was not working or idle. Nothing was typed; look at the pane, then send it again.'

/** The note dialog's title: "Send a note to the lead of {lane}" once a lane is chosen, the server's label before. */
export function noteTitle(label: string, lane: string): string {
  return lane === '' ? label : `Send a note to the lead of ${lane}`
}

/**
 * What a finished note record means (7 "Outcomes"), read from `workflow note`'s own output (workflow/notes.py `note_main`):
 * succeeded is "Typed into {lane}'s pane."; the `Blocked:` line of a note typed but left in the input line
 * (`enter_not_submitted`) and of one recorded `undeliverable` get their sentences. Anything else (a refusal before the note
 * was recorded, a running record, another control) is null, and the record's own line is shown instead.
 */
export function noteOutcome(record: ControlRecord): { tone: 'ok' | 'warn'; text: string } | null {
  if (record.control !== 'note') return null
  const lane = typeof record.params.lane === 'string' && record.params.lane !== '' ? record.params.lane : 'the lane'
  if (record.status === 'succeeded') return { tone: 'ok', text: `Typed into ${lane}'s pane.` }
  if (record.status !== 'failed') return null
  if (record.output_tail.some(line => /was typed but Enter did not submit it/.test(line))) {
    return { tone: 'warn', text: `The note is still in ${lane}'s input line: submit or clear it in the pane, and do not send it again.` }
  }
  if (record.output_tail.some(line => /is recorded undeliverable and was not typed/.test(line))) return { tone: 'warn', text: NOTE_UNDELIVERABLE }
  return null
}

/** A fresh id for one dialog: the server runs a repeated `request_id` once, so a double click or a retried fetch cannot act twice. */
export function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** The dialog's first values: a single choice is preselected, and so is the lane or phase the dock's command names. */
export function initialValues(control: Control, preset: DialogPreset = {}): DialogValues {
  const values: DialogValues = { lane: '', phase: '', drop: [], text: '', reason: '', confirm_run_id: '' }
  for (const spec of control.params) {
    if (spec.kind !== 'choice') continue
    const wanted = spec.name === 'lane' ? preset.lane : preset.phase
    const chosen = wanted !== undefined && (spec.choices as string[]).includes(wanted) ? wanted : spec.choices.length === 1 ? spec.choices[0] : ''
    if (spec.name === 'lane') values.lane = chosen
    else values.phase = chosen
  }
  return values
}

/** Whether one parameter is complete; the reason is the short hint the dialog shows beside the field. */
export function paramProblem(spec: ParamSpec, values: DialogValues, runId: string): string | null {
  switch (spec.kind) {
    case 'choice': return (spec.choices as string[]).includes(spec.name === 'lane' ? values.lane : values.phase) ? null : `Choose a ${spec.name}.`
    case 'multi': return values.drop.every(item => spec.choices.includes(item)) ? null : 'Choose from the listed notes.'
    case 'text': {
      const value = values[spec.name]
      if (value.includes('\0')) return 'Remove the NUL character.'
      if (value.trim().length < spec.min_length) return spec.min_length <= 1 ? 'Write something first.' : `Write at least ${spec.min_length} characters.`
      return value.length > spec.max_length ? `At most ${spec.max_length} characters.` : null
    }
    case 'typed': return values.confirm_run_id === runId ? null : 'Type the run id exactly.'
  }
}

/** Confirm is enabled only when every parameter validates (the typed run id included). */
export function dialogValid(control: Control, values: DialogValues, runId: string): boolean {
  return control.params.every(spec => paramProblem(spec, values, runId) === null)
}

/** The request body's `params`: only what the control's specs name; a dropped note list is left out when empty. */
export function buildParams(control: Control, values: DialogValues): Params {
  const params: Params = {}
  for (const spec of control.params) {
    if (spec.name === 'lane') params.lane = values.lane
    else if (spec.name === 'phase') params.phase = values.phase as 'worker' | 'candidate'
    else if (spec.name === 'drop') { if (values.drop.length > 0) params.drop = [...values.drop].sort((a, b) => a - b) }
    else if (spec.name === 'text') params.text = values.text
    else if (spec.name === 'reason') params.reason = values.reason
    else params.confirm_run_id = values.confirm_run_id
  }
  return params
}

/** Whether the dialog asks for the run id typed. */
export const typedConfirm = (control: Control) => control.confirm === 'typed_run_id'

/** A control opens its dialog only when the server offers it; an unavailable one is read, never clicked. */
export const canOpen = (control: Control) => control.available

export type ControlRow = { control: Control; available: boolean; reason: string | null }

/**
 * The list's rows exactly as the server sent them (decisions [L3] 4): availability and reason are the server's, and a
 * `running` record never greys a control, so Pause and Answer stay offered while a restart runs.
 */
export function controlRows(data: RunControls): ControlRow[] {
  return data.controls.map(control => ({ control, available: canOpen(control), reason: reasonOf(control) }))
}

const SINCE = /\bsince\b/

/** The reason as the server sent it; nothing is rewritten, so a lock holder's start time stays the server's. */
export function reasonOf(control: Control): string | null {
  return control.available ? null : control.reason ?? 'Not available now.'
}

export const hasSince = (reason: string | null) => reason !== null && SINCE.test(reason)

const minutes = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 90) return `${seconds} s`
  const total = Math.round(seconds / 60)
  return total < 90 ? `${total} min` : `${Math.floor(total / 60)} h ${total % 60} min`
}

/** The record's one-line wording: label, status and how long it ran; a failure leads with the controller's `Blocked:` line. */
export function recordLine(record: ControlRecord, label: string, now: number): string {
  const started = Date.parse(record.started_at)
  const span = record.ended_at !== null ? Date.parse(record.ended_at) - started : now - started
  switch (record.status) {
    case 'running': return `${label} · running for ${minutes(span)}`
    case 'succeeded': return `${label} · succeeded${record.ended_at !== null ? ` in ${minutes(span)}` : ''}`
    case 'failed': return `${label} · failed${record.exit_code !== null ? ` (exit ${record.exit_code})` : ''}`
    case 'refused': return `${label} · refused, nothing ran`
    case 'lost': return `${label} · lost: the server restarted while it ran; check the run`
  }
}

/** The line a finished record shows first: the controller's `Blocked:` line when there is one, else its last line. */
export function headlineOf(record: ControlRecord): string | null {
  const blocked = record.output_tail.find(line => line.startsWith('Blocked:'))
  if (blocked !== undefined) return blocked
  return record.status === 'running' ? null : record.output_tail.filter(line => line.trim() !== '').at(-1) ?? null
}

/**
 * The `request_id` rule of both confirmation dialogs (the run controls' and the GitHub actions'). Each Confirm is an attempt
 * `{ id, sent }`, `sent` being the fingerprint of what it carried (the token and the params). The dialog holds the last
 * attempt only while its answer was lost:
 * - a retry after a lost answer with UNCHANGED values keeps the id, so a POST that did reach the server answers with its
 *   first record instead of acting twice;
 * - an edit of any field after that starts a new id, since the server's dedup would otherwise answer the edited request with
 *   the first one's record (and its old values);
 * - an answered refusal that means nothing ran (STATE_CHANGED, BUSY, NOT_AVAILABLE, INVALID_PARAMS, TOKEN_*, a refused spawn
 *   SPAWN_FAILED, which the server records under the id) drops the held attempt, so the next Confirm is a new request; a 5xx
 *   or an UNKNOWN answer keeps it (`answerLost`).
 */
export type RequestAttempt = { id: string; sent: string }

/** What one attempt carries, as compared between attempts. */
export const attemptFingerprint = (token: string | null, params: unknown): string => JSON.stringify([token, params])

/** The attempt the next Confirm sends: the held one when its values are unchanged, else a new id. */
export function nextAttempt(held: RequestAttempt | null, sent: string): RequestAttempt {
  return held !== null && held.sent === sent ? held : { id: newRequestId(), sent }
}

/**
 * The answered refusals that mean nothing ran (final review F5.1): the server checked the request and turned it down before any
 * command started (a 4xx of the contract's codes), or the spawn itself failed and the server stored a refused record under the
 * request_id (SPAWN_FAILED, a 500). Only these start a new request_id with unchanged values.
 */
const NOTHING_RAN: ReadonlySet<string> = new Set([
  'STATE_CHANGED', 'BUSY', 'NOT_AVAILABLE', 'INVALID_PARAMS', 'INVALID_ID', 'TOKEN_REQUIRED', 'TOKEN_INVALID', 'CONTROLS_DISABLED', 'NOT_FOUND',
  'FORBIDDEN_ORIGIN', 'UNSUPPORTED_MEDIA_TYPE', 'SPAWN_FAILED',
])

/**
 * Whether a failure may have lost only the answer, so the action may have run and a retry must carry the same request_id:
 * a NETWORK failure (the POST may have reached the server), an answer that came back 2xx but could not be read, any 5xx but a
 * stored refused spawn (an INTERNAL raised after the command ran, a proxy's 502 while the API restarted), an UNKNOWN code (a
 * proxy's page, not the API's answer) and a failure that is not the server's (a dropped body). Only an answered refusal of
 * `NOTHING_RAN` is not.
 */
export function answerLost(error: unknown): boolean {
  if (!(error instanceof ControlError)) return true
  if (error.code === 'NETWORK' || (error.status >= 200 && error.status < 300)) return true
  return !NOTHING_RAN.has(error.code)
}

/** Said beside the dialog's Cancel while a Confirm is being sent (final review F4.1): closing then would lose the request's answer. */
export const SENDING_HINT = 'Sending: the dialog stays open until the server answers.'

/** The attempt held after a failure: kept only when its answer was lost, so only a retry with unchanged values reuses it. */
export const heldAfterFailure = (attempt: RequestAttempt, error: unknown): RequestAttempt | null => (answerLost(error) ? attempt : null)

export type Outcome = {
  /** What the dialog says. */
  message: string
  /** The controls are read again (the run moved or the control is no longer offered). */
  refresh: boolean
  /** The token was refused: forget it and ask again. */
  unpair: boolean
  /** The request never ran, so the dialog may send again with a new `request_id`. */
  retryable: boolean
  /** The run moved on: once the controls are refreshed, the dialog drops its pinned token and adopts the refreshed one. */
  repin: boolean
}

/** What a failed request means to the operator (PRD 5.2 codes); a 409 never resends by itself. */
export function describeFailure(error: unknown): Outcome {
  if (!(error instanceof ControlError)) return { message: 'The request failed.', refresh: false, unpair: false, retryable: false, repin: false }
  switch (error.code) {
    case 'STATE_CHANGED': return { message: 'The run changed since you looked. The controls were refreshed; check them, then confirm again.', refresh: true, unpair: false, retryable: true, repin: true }
    case 'BUSY': return { message: 'Another control of this run is running. Wait for it to finish, then confirm again.', refresh: true, unpair: false, retryable: true, repin: false }
    case 'NOT_AVAILABLE': return { message: error.message, refresh: true, unpair: false, retryable: false, repin: false }
    case 'TOKEN_INVALID':
    case 'TOKEN_REQUIRED': return { message: 'This browser is not paired any more. Pair it again to use the controls.', refresh: false, unpair: true, retryable: false, repin: false }
    case 'NETWORK': return { message: error.message, refresh: false, unpair: false, retryable: true, repin: false }
    default: return { message: error.message, refresh: false, unpair: false, retryable: false, repin: false }
  }
}

type Match = { id: ControlId; lane?: string; phase?: string }

/**
 * Which control a dock step runs (decisions [L1] 3c): the first command's verb, and its flags where one verb serves two
 * controls, name the control; its lane and phase pre-fill the dialog. `null` for a command no control runs.
 */
export function matchStep(text: string): Match | null {
  const parsed = /-m workflow (\S+)((?:\s+\S+)*)/.exec(text)
  if (!parsed) return null
  const verb = parsed[1]
  const rest = parsed[2].trim().split(/\s+/).filter(Boolean)
  const flag = (name: string) => rest.includes(name)
  const after = (name: string) => rest[rest.indexOf(name) + 1]
  // The lane is the word right after the run argument ("$RUN" in the dock's commands); quoted text and flags are not lanes.
  const afterRun = rest[rest.indexOf('"$RUN"') + 1]
  const lane = afterRun !== undefined && /^[A-Za-z0-9_-]+$/.test(afterRun) ? afterRun : undefined
  switch (verb) {
    case 'automatic': return flag('--live') ? { id: 'restart' } : null
    case 'retry': return { id: 'retry', ...(after('--node') ? { lane: after('--node') } : {}), ...(after('--phase') ? { phase: after('--phase') } : {}) }
    case 'reconcile': return { id: 'reconcile' }
    case 'resume': return flag('--accept-challenge') ? { id: 'accept_challenge' } : flag('--launch') ? { id: 'release_hold' } : { id: 'resume' }
    case 'answer': return { id: 'answer', ...(lane ? { lane } : {}) }
    case 'approve': return { id: 'approve' }
    case 'repair': return flag('--session') ? { id: 'repair_session', ...(lane ? { lane } : {}) } : null
    case 'abandon': return { id: 'abandon' }
    case 'clean': return { id: 'clean' }
    default: return null
  }
}

/** The control the step's command runs, when the server offers it now; unavailable controls get no Run button. */
export function stepControl(text: string, controls: readonly Control[]): { control: Control; preset: DialogPreset } | null {
  const match = matchStep(text)
  if (match === null) return null
  const control = controls.find(item => item.id === match.id)
  if (control === undefined || !control.available) return null
  // A lane the control does not offer is no preset: the dialog asks.
  return { control, preset: { ...(match.lane ? { lane: match.lane } : {}), ...(match.phase ? { phase: match.phase } : {}) } }
}

/**
 * The record the dock shows: a control still running, else this browser's last action, so a result stays on the page after
 * the server's list moves on. A reload shows only what is still running.
 */
export function shownRecord(running: readonly ControlRecord[], mine: ControlRecord | null): ControlRecord | null {
  return running.find(record => record.status === 'running') ?? mine
}

/** The run state token a dialog posts: the first one it saw (the token it was opened on), never a later poll's ([L6] 6c). */
export function pinToken(pinned: string | null, latest: string | null): string | null {
  return pinned ?? latest
}

/**
 * The relaunch dialog's dry run: asked for one lane under one run state token, then answered (or failed). `ask` numbers the
 * request, so an answer to an earlier ask of the same lane and token (ui, adapter, ui again) is told from the current one's.
 */
export type RelaunchCheck =
  | { lane: string; token: string; ask: number; state: 'asking' }
  | { lane: string; token: string; ask: number; state: 'answered'; exitCode: number | null; line: string }
  | { lane: string; token: string; ask: number; state: 'failed'; message: string }

/** The check the dialog holds for the lane and token now chosen: one made for another choice is stale and reads as none. */
export function currentCheck(check: RelaunchCheck | null, lane: string, token: string | null): RelaunchCheck | null {
  return check !== null && token !== null && check.lane === lane && check.token === token ? check : null
}

/** The next ask for a lane and token: numbered after the one held, so no earlier request's answer can land on it. */
export function askCheck(check: RelaunchCheck | null, lane: string, token: string): RelaunchCheck {
  return { lane, token, ask: (check?.ask ?? 0) + 1, state: 'asking' }
}

/** An answer only lands on the ask that requested it: a late answer for an earlier ask, lane or token changes nothing. */
export function answerCheck(check: RelaunchCheck | null, answer: Exclude<RelaunchCheck, { state: 'asking' }>): RelaunchCheck | null {
  return check !== null && check.state === 'asking' && check.ask === answer.ask && check.lane === answer.lane && check.token === answer.token ? answer : check
}

/** Confirm is enabled only by an exit-0 dry run of the lane and token chosen now. */
export function relaunchConfirmable(check: RelaunchCheck | null, lane: string, token: string | null): boolean {
  const current = currentCheck(check, lane, token)
  return current !== null && current.state === 'answered' && current.exitCode === 0
}
