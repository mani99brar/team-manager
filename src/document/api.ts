import type { FileRef, Source } from '../graph/model.ts'

export type FileDocument = { source: Source; path: string; content: string; hash: string }

export type DocumentErrorKind = 'missing' | 'invalid' | 'failed'

export class DocumentError extends Error {
  readonly kind: DocumentErrorKind
  constructor(kind: DocumentErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

/** Fetches one document. The query is built with URLSearchParams so any character in the path survives. */
export async function fetchDocument(ref: FileRef, signal?: AbortSignal): Promise<FileDocument> {
  const query = new URLSearchParams({ source: ref.source, path: ref.path })
  let response: Response
  try {
    response = await fetch(`/api/file?${query.toString()}`, { signal, cache: 'no-store' })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new DocumentError('failed', 'The API could not be reached. Check that it is running.')
  }
  let body: unknown = null
  try { body = await response.json() } catch { /* not JSON */ }
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : null
  const serverMessage = typeof record?.error === 'string' ? record.error : null
  if (response.status === 404) throw new DocumentError('missing', serverMessage ?? 'The file was not found.')
  if (response.status === 400) throw new DocumentError('invalid', serverMessage ?? 'The file link is invalid.')
  if (!response.ok) throw new DocumentError('failed', serverMessage ?? `The API responded with status ${response.status}.`)
  if (!record || typeof record.content !== 'string' || typeof record.hash !== 'string' || record.source !== ref.source || record.path !== ref.path) {
    throw new DocumentError('failed', 'The API returned an unexpected response.')
  }
  return { source: ref.source, path: ref.path, content: record.content, hash: record.hash }
}
