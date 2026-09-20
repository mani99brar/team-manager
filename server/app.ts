import Fastify from 'fastify'
import { lstat, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { RequestError, openFixtureRoot, readMarkdownFile, writeMarkdownFile, type FixtureRoot, type ReadFile } from './files.ts'
import { parseMutationBody, performMutation } from './mutations.ts'

export type Source = 'Pi' | 'Claude'
export type EntryKind = 'directory' | 'file'
export type Entry = { source: Source; path: string; kind: EntryKind }

const sources: ReadonlyArray<{ name: Source; directory: string }> = [
  { name: 'Pi', directory: 'pi' },
  { name: 'Claude', directory: 'claude' },
]

/** The repository's fixtures/ folder, resolved from this module rather than the shell's working directory. */
export const defaultFixtureRoot = fileURLToPath(new URL('../fixtures/', import.meta.url))

/**
 * The fixture root is fixed at startup: MD_MANAGER_FIXTURE_ROOT (containing pi/ and claude/) when set,
 * otherwise the repository fixtures. No request can change it.
 */
export function resolveFixtureRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MD_MANAGER_FIXTURE_ROOT?.trim()
  return override ? resolve(override) : defaultFixtureRoot
}

export class SourceError extends Error {
  readonly source: Source
  constructor(source: Source, cause: unknown) {
    super(`Unable to read the ${source} fixture folder. Check that both fixture folders exist and are readable, then refresh.`, { cause })
    this.source = source
  }
}

// Byte-wise ordering keeps the listing deterministic regardless of locale.
function byName(a: { name: string }, b: { name: string }) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/**
 * Lists every directory and regular Markdown file below each source root as one flat, pre-ordered list.
 * Symlinks (including symlinked source roots) are never followed, and a failing source fails the whole listing.
 */
export async function listEntries(root: string): Promise<Entry[]> {
  const entries: Entry[] = []
  async function walk(directory: string, source: Source, prefix: string) {
    const dirents = (await readdir(directory, { withFileTypes: true })).sort(byName)
    for (const dirent of dirents) {
      if (dirent.isSymbolicLink()) continue
      const path = prefix ? `${prefix}/${dirent.name}` : dirent.name
      if (dirent.isDirectory()) {
        entries.push({ source, path, kind: 'directory' })
        await walk(join(directory, dirent.name), source, path)
      } else if (dirent.isFile() && dirent.name.toLowerCase().endsWith('.md')) {
        entries.push({ source, path, kind: 'file' })
      }
    }
  }
  for (const { name, directory } of sources) {
    const sourceRoot = join(root, directory)
    try {
      const stats = await lstat(sourceRoot)
      if (!stats.isDirectory()) throw new Error(`${directory} is not a directory`)
      await walk(sourceRoot, name, '')
    } catch (error) {
      throw new SourceError(name, error)
    }
  }
  return entries
}

export type AppOptions = {
  /** Injectable for tests that simulate a filesystem read failure deterministically. */
  readFile?: ReadFile
}

function singleString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** Request bodies above this size are rejected with 413 before any file is touched. */
export const REQUEST_BODY_LIMIT = 8 * 1024 * 1024

const HASH_PATTERN = /^[0-9a-f]{64}$/

type WriteBody = { source: string; path: string; content: string; expectedHash: string }

function parseWriteBody(body: unknown): WriteBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RequestError(400, 'INVALID_BODY', 'The request body must be a JSON object with source, path, content and expectedHash.')
  }
  const { source, path, content, expectedHash } = body as Record<string, unknown>
  if (typeof source !== 'string') throw new RequestError(400, 'INVALID_SOURCE', 'The source must be Pi or Claude.')
  if (typeof path !== 'string') throw new RequestError(400, 'INVALID_PATH', 'The file path is invalid.')
  if (typeof content !== 'string') throw new RequestError(400, 'INVALID_CONTENT', 'The content must be a string.')
  if (typeof expectedHash !== 'string' || !HASH_PATTERN.test(expectedHash)) {
    throw new RequestError(400, 'INVALID_HASH', 'The expected hash must be the 64-character lowercase SHA-256 from the last read or save.')
  }
  return { source, path, content, expectedHash }
}

export function createApp(root: string = resolveFixtureRoot(), options: AppOptions = {}) {
  const app = Fastify({ logger: true, bodyLimit: REQUEST_BODY_LIMIT })
  let fixtureRoot: FixtureRoot
  // Body parsing failures (too large, malformed or non-JSON) must be safe JSON with a stable code.
  app.setErrorHandler((error: { statusCode?: number; code?: string }, _request, reply) => {
    const status = typeof error.statusCode === 'number' ? error.statusCode : 500
    if (status === 413) return reply.code(413).send({ code: 'REQUEST_TOO_LARGE', error: `The request is larger than the ${REQUEST_BODY_LIMIT / (1024 * 1024)} MiB limit. Shorten the document or copy your draft elsewhere.` })
    if (status === 415) return reply.code(415).send({ code: 'UNSUPPORTED_MEDIA_TYPE', error: 'The request body must be JSON.' })
    if (status >= 400 && status < 500) return reply.code(status).send({ code: 'INVALID_BODY', error: 'The request body could not be read as JSON.' })
    app.log.error({ code: error.code }, 'Unhandled request failure')
    return reply.code(500).send({ code: 'INTERNAL', error: 'The request failed unexpectedly.' })
  })
  app.addHook('onReady', async () => { fixtureRoot = await openFixtureRoot(root) })
  app.addHook('onClose', async () => { await fixtureRoot?.handle.close() })
  app.get('/api/entries', async (_request, reply) => {
    try {
      return { entries: await listEntries(root) }
    } catch (error) {
      app.log.error(error, 'Fixture discovery failed')
      const message = error instanceof SourceError
        ? error.message
        : 'Unable to list the fixture folders. Check that both fixture folders exist and are readable, then refresh.'
      return reply.code(500).send({ error: message })
    }
  })
  app.get('/api/file', async (request, reply) => {
    const query = request.query as Record<string, unknown>
    const source = singleString(query.source)
    const path = singleString(query.path)
    if (source === null || path === null) {
      return reply.code(400).send({ error: 'Both the source and path query parameters are required exactly once.' })
    }
    try {
      const document = await readMarkdownFile(fixtureRoot, source, path, options.readFile)
      return reply.header('Cache-Control', 'no-store').send(document)
    } catch (error) {
      if (error instanceof RequestError) return reply.code(error.status).send({ code: error.code, error: error.message })
      app.log.error(error, 'File read failed')
      return reply.code(500).send({ code: 'READ_FAILED', error: 'The file could not be read. Check that it is readable, then retry.' })
    }
  })
  app.put('/api/file', async (request, reply) => {
    try {
      const body = parseWriteBody(request.body)
      const result = await writeMarkdownFile(fixtureRoot, body.source, body.path, body.content, body.expectedHash)
      return reply.header('Cache-Control', 'no-store').send(result)
    } catch (error) {
      if (error instanceof RequestError) return reply.code(error.status).send({ code: error.code, error: error.message })
      // Log only the error code: messages can carry absolute paths.
      app.log.error({ code: (error as NodeJS.ErrnoException)?.code }, 'File write failed')
      return reply.code(500).send({ code: 'WRITE_FAILED', error: 'The file could not be written. Your draft is unchanged; retry or copy it.' })
    }
  })
  app.post('/api/mutate', async (request, reply) => {
    try {
      const mutation = parseMutationBody(request.body)
      const result = await performMutation(fixtureRoot, mutation)
      return reply.code(result.status).header('Cache-Control', 'no-store').send(result.body)
    } catch (error) {
      if (error instanceof RequestError) return reply.code(error.status).send({ code: error.code, error: error.message })
      const code = (error as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') {
        return reply.code(404).send({ code: 'NOT_FOUND', error: 'The target or its folder was not found.' })
      }
      app.log.error({ code }, 'Mutation failed')
      return reply.code(500).send({ code: 'MUTATION_FAILED', error: 'The operation failed unexpectedly. Refresh the listing to see the current state.' })
    }
  })
  return app
}
