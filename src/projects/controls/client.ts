import { TOKEN_KEY, type CleanPreview, type ControlErrorCode, type ControlRecord, type ControlScope, type ControlsStatus, type Params, type RunControls } from './types.ts'

const TOKEN_HEADER = 'X-MDM-Control-Token'

export class ControlError extends Error {
  readonly status: number
  readonly code: ControlErrorCode | 'NETWORK' | 'UNKNOWN'
  constructor(status: number, code: ControlError['code'], message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

type TokenStore = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
// Reached through globalThis so the tests (which type-check without the DOM) can import this module.
const storage = (): TokenStore => (globalThis as unknown as { localStorage: TokenStore }).localStorage

/** A blocked storage means "not paired". */
export function readToken(): string | null {
  try {
    const value = storage().getItem(TOKEN_KEY)
    return value !== null && value !== '' ? value : null
  } catch {
    return null
  }
}

export function writeToken(token: string | null): void {
  try {
    if (token === null) storage().removeItem(TOKEN_KEY)
    else storage().setItem(TOKEN_KEY, token)
  } catch {
    // A blocked storage keeps the browser unpaired.
  }
}

const segments = (scope: ControlScope) => [scope.projectId, scope.workflowId, scope.runId].map(encodeURIComponent).join('/')
export const controlPaths = {
  status: '/api/run-controls/status',
  run: (scope: ControlScope) => `/api/run-controls/${segments(scope)}`,
  control: (scope: ControlScope, id: string) => `/api/run-controls/${segments(scope)}/${encodeURIComponent(id)}`,
  preview: (scope: ControlScope) => `/api/run-controls/${segments(scope)}/clean-preview`,
  record: (scope: ControlScope, recordId: string) => `/api/run-controls/${segments(scope)}/records/${encodeURIComponent(recordId)}`,
}

function parseBody(text: string): unknown {
  try { return text === '' ? null : JSON.parse(text) } catch { return null }
}

async function request<T>(path: string, token: string | null, body?: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Accept: 'application/json', ...(token ? { [TOKEN_HEADER]: token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch {
    throw new ControlError(0, 'NETWORK', 'The viewer could not reach its server.')
  }
  const text = await response.text()
  const parsed = parseBody(text)
  if (!response.ok) {
    const error = (parsed as { error?: { code?: string; message?: string } } | null)?.error
    throw new ControlError(response.status, (error?.code as ControlError['code'] | undefined) ?? 'UNKNOWN', error?.message ?? `The server answered ${response.status}.`)
  }
  return parsed as T
}

export const fetchStatus = (token: string | null) => request<ControlsStatus>(controlPaths.status, token)
export const fetchControls = (scope: ControlScope, token: string) => request<RunControls>(controlPaths.run(scope), token)
export const fetchRecord = (scope: ControlScope, token: string, recordId: string) => request<{ record: ControlRecord }>(controlPaths.record(scope, recordId), token)

/** The dialog's one request: its `request_id` is generated once per dialog, the `run_state_token` is the one the list rendered from. */
export const postControl = (scope: ControlScope, token: string, id: string, body: { request_id: string; run_state_token: string; params: Params }) =>
  request<{ record: ControlRecord }>(controlPaths.control(scope, id), token, body)

/** Clean's dry run: body is the run state token only, never a `request_id` (decisions [L4]). */
export const postCleanPreview = (scope: ControlScope, token: string, runStateToken: string) =>
  request<CleanPreview>(controlPaths.preview(scope), token, { run_state_token: runStateToken })
