import type { Source } from '../graph/model.ts'

export type OperationKind = 'create-file' | 'create-folder' | 'rename' | 'move' | 'delete' | 'copy'

type Addressed = { source: Source; locationId: string; path: string }

export type MutationRequest =
  | (Addressed & { op: 'create-file'; content?: string })
  | (Addressed & { op: 'create-folder' })
  | (Addressed & { op: 'rename'; destinationPath: string })
  | (Addressed & { op: 'move'; destinationPath: string })
  | (Addressed & { op: 'delete' })
  | (Addressed & { op: 'copy'; destinationSource: Source; destinationLocationId: string; destinationPath: string })

export type MutationResponse = Addressed & { op: OperationKind; destinationSource?: Source; destinationLocationId?: string; destinationPath?: string }

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
  if (!record || record.op !== request.op || record.source !== request.source || record.locationId !== request.locationId || typeof record.path !== 'string') {
    throw new OperationError(response.status, 'UNEXPECTED', 'The API returned an unexpected response.')
  }
  return record as MutationResponse
}
