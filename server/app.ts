import Fastify from 'fastify'
import type { LocationConfig } from './config.ts'
import { RequestError, readMarkdownFile, writeMarkdownFile, type ReadFile } from './files.ts'
import { parseMutationBody, performMutation } from './mutations.ts'
import { LocationRegistry } from './registry.ts'

export type { Source } from './config.ts'
export type { Entry, EntryKind, Listing, LocationStatus } from './registry.ts'

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

type WriteBody = { source: string; locationId: string; path: string; content: string; expectedHash: string }

function parseWriteBody(body: unknown): WriteBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RequestError(400, 'INVALID_BODY', 'The request body must be a JSON object with source, locationId, path, content and expectedHash.')
  }
  const { source, locationId, path, content, expectedHash } = body as Record<string, unknown>
  if (typeof source !== 'string') throw new RequestError(400, 'INVALID_SOURCE', 'The source must be Pi or Claude.')
  if (typeof locationId !== 'string' || locationId.length === 0) throw new RequestError(400, 'INVALID_LOCATION', 'The locationId must name a configured location.')
  if (typeof path !== 'string') throw new RequestError(400, 'INVALID_PATH', 'The file path is invalid.')
  if (typeof content !== 'string') throw new RequestError(400, 'INVALID_CONTENT', 'The content must be a string.')
  if (typeof expectedHash !== 'string' || !HASH_PATTERN.test(expectedHash)) {
    throw new RequestError(400, 'INVALID_HASH', 'The expected hash must be the 64-character lowercase SHA-256 from the last read or save.')
  }
  return { source, locationId, path, content, expectedHash }
}

/**
 * The HTTP API over a fixed set of configured locations. Locations are startup configuration: no request can
 * add, change or select a root, and responses never carry absolute paths, file content of other files or
 * stack traces.
 */
export function createApp(locations: readonly LocationConfig[], options: AppOptions = {}) {
  const app = Fastify({ logger: true, bodyLimit: REQUEST_BODY_LIMIT })
  const registry = new LocationRegistry(locations, {
    // Log only the error code and location id: messages can carry absolute paths.
    warn: (error, location) => app.log.error({ id: location.id, code: (error as NodeJS.ErrnoException)?.code }, 'Location listing failed'),
  })
  // Body parsing failures (too large, malformed or non-JSON) must be safe JSON with a stable code.
  app.setErrorHandler((error: { statusCode?: number; code?: string }, _request, reply) => {
    const status = typeof error.statusCode === 'number' ? error.statusCode : 500
    if (status === 413) return reply.code(413).send({ code: 'REQUEST_TOO_LARGE', error: `The request is larger than the ${REQUEST_BODY_LIMIT / (1024 * 1024)} MiB limit. Shorten the document or copy your draft elsewhere.` })
    if (status === 415) return reply.code(415).send({ code: 'UNSUPPORTED_MEDIA_TYPE', error: 'The request body must be JSON.' })
    if (status >= 400 && status < 500) return reply.code(status).send({ code: 'INVALID_BODY', error: 'The request body could not be read as JSON.' })
    app.log.error({ code: error.code }, 'Unhandled request failure')
    return reply.code(500).send({ code: 'INTERNAL', error: 'The request failed unexpectedly.' })
  })
  app.addHook('onReady', async () => { await registry.open() })
  app.addHook('onClose', async () => { await registry.close() })
  app.get('/api/entries', async (_request, reply) => {
    try {
      return await registry.list()
    } catch (error) {
      app.log.error({ code: (error as NodeJS.ErrnoException)?.code }, 'Listing failed')
      return reply.code(500).send({ code: 'LISTING_FAILED', error: 'Unable to list the configured locations. Refresh to retry.' })
    }
  })
  app.get('/api/file', async (request, reply) => {
    const query = request.query as Record<string, unknown>
    const source = singleString(query.source)
    const locationId = singleString(query.locationId)
    const path = singleString(query.path)
    if (source === null || path === null) {
      return reply.code(400).send({ code: 'INVALID_QUERY', error: 'The source, locationId and path query parameters are each required exactly once.' })
    }
    if (locationId === null) {
      return reply.code(400).send({ code: 'INVALID_LOCATION', error: 'The locationId query parameter is required exactly once.' })
    }
    try {
      const document = await readMarkdownFile(registry, source, locationId, path, options.readFile)
      return reply.header('Cache-Control', 'no-store').send(document)
    } catch (error) {
      if (error instanceof RequestError) return reply.code(error.status).send({ code: error.code, error: error.message })
      app.log.error({ code: (error as NodeJS.ErrnoException)?.code }, 'File read failed')
      return reply.code(500).send({ code: 'READ_FAILED', error: 'The file could not be read. Check that it is readable, then retry.' })
    }
  })
  app.put('/api/file', async (request, reply) => {
    try {
      const body = parseWriteBody(request.body)
      const result = await writeMarkdownFile(registry, body.source, body.locationId, body.path, body.content, body.expectedHash)
      return reply.header('Cache-Control', 'no-store').send(result)
    } catch (error) {
      if (error instanceof RequestError) return reply.code(error.status).send({ code: error.code, error: error.message })
      app.log.error({ code: (error as NodeJS.ErrnoException)?.code }, 'File write failed')
      return reply.code(500).send({ code: 'WRITE_FAILED', error: 'The file could not be written. Your draft is unchanged; retry or copy it.' })
    }
  })
  app.post('/api/mutate', async (request, reply) => {
    try {
      const mutation = parseMutationBody(request.body)
      const result = await performMutation(registry, mutation)
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
