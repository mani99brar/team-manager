import { ControlError } from './client.ts'
import type { Control, ControlId, ControlRecord, Params, ParamSpec, RunControls } from './types.ts'

/** What the operator has entered in a control's dialog; one field per kind of `ParamSpec`. */
export type DialogValues = { lane: string; phase: string; drop: number[]; text: string; reason: string; confirm_run_id: string }

export type DialogPreset = { lane?: string; phase?: string }

export const REASON_LABEL: Record<string, string> = { text: 'Your answer', reason: 'Reason' }

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

export type Outcome = {
  /** What the dialog says. */
  message: string
  /** The controls are read again (the run moved or the control is no longer offered). */
  refresh: boolean
  /** The token was refused: forget it and ask again. */
  unpair: boolean
  /** The request never ran, so the dialog may send again with a new `request_id`. */
  retryable: boolean
}

/** What a failed request means to the operator (PRD 5.2 codes); a 409 never resends by itself. */
export function describeFailure(error: unknown): Outcome {
  if (!(error instanceof ControlError)) return { message: 'The request failed.', refresh: false, unpair: false, retryable: false }
  switch (error.code) {
    case 'STATE_CHANGED': return { message: 'The run changed since you looked. The controls were refreshed; check them, then confirm again.', refresh: true, unpair: false, retryable: true }
    case 'BUSY': return { message: 'Another control of this run is running. Wait for it to finish, then confirm again.', refresh: true, unpair: false, retryable: true }
    case 'NOT_AVAILABLE': return { message: error.message, refresh: true, unpair: false, retryable: false }
    case 'TOKEN_INVALID':
    case 'TOKEN_REQUIRED': return { message: 'This browser is not paired any more. Pair it again to use the controls.', refresh: false, unpair: true, retryable: false }
    case 'NETWORK': return { message: error.message, refresh: false, unpair: false, retryable: true }
    default: return { message: error.message, refresh: false, unpair: false, retryable: false }
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
