import type { Source } from '../graph/model.ts'

export type OperationKind = 'create-file' | 'create-folder' | 'rename' | 'move' | 'delete' | 'copy'

export type MutationRequest =
  | { op: 'create-file'; source: Source; path: string; content?: string }
  | { op: 'create-folder'; source: Source; path: string }
  | { op: 'rename'; source: Source; path: string; destinationPath: string }
  | { op: 'move'; source: Source; path: string; destinationPath: string }
  | { op: 'delete'; source: Source; path: string }
  | { op: 'copy'; source: Source; path: string; destinationSource: Source; destinationPath: string }

export type MutationResponse = { op: OperationKind; source: Source; path: string; destinationSource?: Source; destinationPath?: string }

export class OperationError extends Error {
  readonly code: string
  readonly status: number
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** Submits one operation. The server is authoritative; its safe message is shown to the user. */
export async function performOperation(request: MutationRequest): Promise<MutationResponse> {
  let response: Response
  try {
    response = await fetch('/api/mutate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) })
  } catch {
    throw new OperationError(0, 'NETWORK', 'The API could not be reached. Check that it is running, then try again.')
  }
  let body: unknown = null
  try { body = await response.json() } catch { /* not JSON */ }
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : null
  if (!response.ok) {
    const code = typeof record?.code === 'string' ? record.code : 'FAILED'
    const message = typeof record?.error === 'string' ? record.error : `The API responded with status ${response.status}.`
    throw new OperationError(response.status, code, message)
  }
  if (!record || record.op !== request.op || record.source !== request.source || typeof record.path !== 'string') {
    throw new OperationError(response.status, 'UNEXPECTED', 'The API returned an unexpected response.')
  }
  return record as MutationResponse
}
