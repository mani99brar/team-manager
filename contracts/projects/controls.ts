import { z } from 'zod'

/**
 * The run-control API (docs/PRD_RUN_CONTROLS.md Appendix A, contract 1.0.0), mounted at /api/run-controls. The server validates
 * every payload it sends against these schemas; the viewer mirrors the types. decisions.md [L1] 3 and [L4] add the status route's
 * `enabled: false` form and the clean-preview route (`{ exitCode, output }`, the two camelCase keys).
 */
export const CONTROLS_VERSION = '1.0.0'

export const CONTROL_IDS = [
  'restart', 'pause', 'retry', 'reconcile', 'resume', 'accept_challenge', 'release_hold', 'answer', 'approve', 'repair_session', 'abandon', 'clean',
] as const

export const CONTROL_RUNS = ['short', 'long', 'signal'] as const
export const RECORD_STATUSES = ['running', 'succeeded', 'failed', 'refused', 'lost'] as const
export const SUPERVISOR_STATES = ['running', 'not_running', 'unknown'] as const

/** Every code the control routes answer with (Appendix A.1). */
export const CONTROL_ERROR_CODES = [
  'CONTROLS_DISABLED', 'NOT_FOUND', 'INVALID_PARAMS', 'INVALID_ID', 'FORBIDDEN_ORIGIN', 'TOKEN_REQUIRED', 'TOKEN_INVALID', 'STATE_CHANGED',
  'BUSY', 'UNSUPPORTED_MEDIA_TYPE', 'NOT_AVAILABLE', 'SPAWN_FAILED',
] as const

const timestamp = z.iso.datetime()

export const controlIdSchema = z.enum(CONTROL_IDS)
export const phaseSchema = z.enum(['worker', 'candidate'])

export const paramSpecSchema = z.discriminatedUnion('name', [
  z.strictObject({ name: z.literal('lane'), kind: z.literal('choice'), choices: z.array(z.string().min(1)), required: z.literal(true) }),
  z.strictObject({ name: z.literal('phase'), kind: z.literal('choice'), choices: z.array(phaseSchema), required: z.literal(true) }),
  z.strictObject({ name: z.literal('drop'), kind: z.literal('multi'), choices: z.array(z.number().int().positive()), required: z.literal(false) }),
  z.strictObject({ name: z.literal('text'), kind: z.literal('text'), min_length: z.number().int().nonnegative(), max_length: z.number().int().positive(), required: z.literal(true) }),
  z.strictObject({ name: z.literal('reason'), kind: z.literal('text'), min_length: z.number().int().nonnegative(), max_length: z.number().int().positive(), required: z.literal(true) }),
  z.strictObject({ name: z.literal('confirm_run_id'), kind: z.literal('typed'), required: z.literal(true) }),
])

export const paramsSchema = z.strictObject({
  lane: z.string().optional(),
  phase: phaseSchema.optional(),
  drop: z.array(z.number().int().positive()).optional(),
  text: z.string().optional(),
  reason: z.string().optional(),
  confirm_run_id: z.string().optional(),
})

export const controlSchema = z.strictObject({
  id: controlIdSchema,
  label: z.string().min(1),
  available: z.boolean(),
  reason: z.string().min(1).nullable(),
  recommended: z.boolean(),
  command: z.string().min(1),
  runs: z.enum(CONTROL_RUNS),
  confirm: z.enum(['plain', 'typed_run_id']),
  params: z.array(paramSpecSchema),
  effect: z.string().min(1),
  not_effect: z.string().min(1).nullable(),
})

/** The record as served: `confirm_run_id` is never part of `params` (Appendix A.2). */
export const recordParamsSchema = paramsSchema.omit({ confirm_run_id: true })

export const controlRecordSchema = z.strictObject({
  record_id: z.string().regex(/^c-[0-9a-f]{12}$/),
  request_id: z.uuid(),
  control: controlIdSchema,
  params: recordParamsSchema,
  command: z.string().min(1),
  status: z.enum(RECORD_STATUSES),
  exit_code: z.number().int().nullable(),
  started_at: timestamp,
  ended_at: timestamp.nullable(),
  output_tail: z.array(z.string()).max(40),
})

export const runControlsSchema = z.strictObject({
  version: z.literal(CONTROLS_VERSION),
  run_state_token: z.string().min(1).max(128),
  supervisor: z.enum(SUPERVISOR_STATES),
  supervisor_since: timestamp.nullable(),
  controls: z.array(controlSchema).length(CONTROL_IDS.length),
  records: z.array(controlRecordSchema).max(20),
}).superRefine((value, context) => {
  value.controls.forEach((control, index) => {
    if (control.id !== CONTROL_IDS[index]) context.addIssue({ code: 'custom', path: ['controls', index, 'id'], message: `Control ${index} is ${CONTROL_IDS[index]}, in the order of PRD section 4` })
    if (control.available !== (control.reason === null)) context.addIssue({ code: 'custom', path: ['controls', index, 'reason'], message: 'A control carries a reason exactly when it is unavailable' })
  })
})

export const controlsStatusSchema = z.strictObject({ version: z.literal(CONTROLS_VERSION), enabled: z.boolean(), paired: z.boolean() })

/** `POST .../:control_id` body. */
export const controlRequestSchema = z.strictObject({ request_id: z.uuid(), run_state_token: z.string().min(1).max(128), params: paramsSchema })
/** `POST .../clean-preview` body ([L4]): nothing but the state token. */
export const cleanPreviewRequestSchema = z.strictObject({ run_state_token: z.string().min(1).max(128) })

export const controlResponseSchema = z.strictObject({ record: controlRecordSchema })
export const cleanPreviewResponseSchema = z.strictObject({ exitCode: z.number().int().nullable(), output: z.string() })
export const controlErrorSchema = z.strictObject({ error: z.strictObject({ code: z.enum(CONTROL_ERROR_CODES), message: z.string().min(1) }) })

export type ControlId = z.infer<typeof controlIdSchema>
export type ParamSpec = z.infer<typeof paramSpecSchema>
export type Params = z.infer<typeof paramsSchema>
export type Control = z.infer<typeof controlSchema>
export type ControlRecord = z.infer<typeof controlRecordSchema>
export type RunControls = z.infer<typeof runControlsSchema>
export type ControlsStatus = z.infer<typeof controlsStatusSchema>
export type ControlRequest = z.infer<typeof controlRequestSchema>

export const controlSchemas = {
  controlsStatus: controlsStatusSchema, runControls: runControlsSchema, controlRecord: controlRecordSchema, controlRequest: controlRequestSchema,
  controlResponse: controlResponseSchema, cleanPreviewRequest: cleanPreviewRequestSchema, cleanPreviewResponse: cleanPreviewResponseSchema, controlError: controlErrorSchema,
} as const
