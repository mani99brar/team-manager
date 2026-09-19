import Fastify from 'fastify'
import { lstat, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

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

export function createApp(root: string = resolveFixtureRoot()) {
  const app = Fastify({ logger: true })
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
  return app
}
