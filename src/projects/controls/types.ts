/**
 * The run-controls API as docs/PRD_RUN_CONTROLS.md Appendix A writes it (contract 1.2.0), mirrored here because the viewer
 * lane is built beside the server lane and meets it only at the candidate. Wire names stay snake_case, except the two keys of
 * the clean preview (decisions [L4]).
 */
export type ControlId = 'restart' | 'pause' | 'retry' | 'reconcile' | 'resume' | 'accept_challenge' | 'release_hold'
  | 'answer' | 'approve' | 'repair_session' | 'abandon' | 'clean' | 'retry_all' | 'relaunch' | 'note'

export type ParamSpec =
  | { name: 'lane'; kind: 'choice'; choices: string[]; required: true }
  | { name: 'phase'; kind: 'choice'; choices: ('worker' | 'candidate')[]; required: true }
  | { name: 'drop'; kind: 'multi'; choices: number[]; required: false }
  | { name: 'text' | 'reason'; kind: 'text'; min_length: number; max_length: number; required: true }
  | { name: 'confirm_run_id'; kind: 'typed'; required: true }

export type Params = { lane?: string; phase?: 'worker' | 'candidate'; drop?: number[]; text?: string; reason?: string; confirm_run_id?: string }

export type Control = {
  id: ControlId
  label: string
  available: boolean
  reason: string | null
  recommended: boolean
  command: string
  runs: 'short' | 'long' | 'signal'
  confirm: 'plain' | 'typed_run_id'
  params: ParamSpec[]
  effect: string
  not_effect: string | null
}

export type RecordStatus = 'running' | 'succeeded' | 'failed' | 'refused' | 'lost'

export type ControlRecord = {
  record_id: string
  request_id: string
  control: ControlId
  params: Params
  command: string
  status: RecordStatus
  exit_code: number | null
  started_at: string
  ended_at: string | null
  output_tail: string[]
}

export type RunControls = {
  version: '1.2.0'
  run_state_token: string
  supervisor: 'running' | 'not_running' | 'unknown'
  supervisor_since: string | null
  controls: Control[]
  records: ControlRecord[]
}

export type ControlsStatus = { version: string; enabled: boolean; paired: boolean }

export type CleanPreview = { exitCode: number; output: string }

/** The relaunch dry run's answer: its exit and its first line (the controller's verdict on the lane). */
export type RelaunchPreview = { exitCode: number | null; line: string }

export type ControlErrorCode = 'CONTROLS_DISABLED' | 'NOT_FOUND' | 'INVALID_PARAMS' | 'INVALID_ID' | 'FORBIDDEN_ORIGIN' | 'TOKEN_REQUIRED'
  | 'TOKEN_INVALID' | 'STATE_CHANGED' | 'BUSY' | 'UNSUPPORTED_MEDIA_TYPE' | 'NOT_AVAILABLE' | 'SPAWN_FAILED'

/** The run a control acts on, the same three segments every run-controls route carries. */
export type ControlScope = { projectId: string; workflowId: string; runId: string }

/** The fifteen controls: the twelve in the order of PRD section 4, the two 1.1.0 adds after `clean`, then 1.2.0's `note`. */
export const CONTROL_ORDER: readonly ControlId[] = ['restart', 'pause', 'retry', 'reconcile', 'resume', 'accept_challenge', 'release_hold', 'answer', 'approve', 'repair_session', 'abandon', 'clean', 'retry_all', 'relaunch', 'note']

/** Where this browser keeps the pairing token (client.ts): the only place it is ever stored. */
export const TOKEN_KEY = 'md-manager.run-controls.token'
