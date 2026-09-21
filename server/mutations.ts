import fs, { type FileHandle } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import type { LocationConfig } from './config.ts'
import {
  CREATE_FLAGS, NOT_FOUND, PathError, RequestError, at, isMarkdownName, isSource, openRegularFile, temporaryFileName, validateEntryPath,
  withParentDirectory, type Source,
} from './files.ts'
import type { LocationRegistry } from './registry.ts'

/**
 * Bounded file and folder operations. Every step is descriptor-relative (see files.ts); nothing here
 * re-resolves a validated pathname. All operations run through the same serial queue as content saves.
 * Each operation opens its location root(s) for its own duration only (see registry.ts).
 *
 * Collision policy: a filesystem probe (lstat of the destination name inside its open parent) refuses
 * anything that exists, including dangling symlinks; file creation stages with O_EXCL then links,
 * folders use mkdir, file renames use
 * link + unlink (link fails on an existing name), folder renames use rename after the probe.
 */
type Addressed = { source: Source; locationId: string; path: string }
export type MutationRequest =
  | (Addressed & { op: 'create-file'; content: string })
  | (Addressed & { op: 'create-folder' })
  | (Addressed & { op: 'rename'; destinationPath: string })
  | (Addressed & { op: 'move'; destinationPath: string })
  | (Addressed & { op: 'delete' })
  | (Addressed & { op: 'copy'; destinationSource: Source; destinationLocationId: string; destinationPath: string })

export type MutationResult = {
  status: 200 | 201
  body: Addressed & { op: string; destinationSource?: Source; destinationLocationId?: string; destinationPath?: string }
}

const DESTINATION_EXISTS = new RequestError(409, 'DESTINATION_EXISTS', 'Something already exists at that destination. Choose another name.')
const FOLDER_NOT_EMPTY = new RequestError(409, 'FOLDER_NOT_EMPTY', 'The folder is not empty. Only empty folders can be renamed, moved or deleted.')
const NO_CHANGE = new RequestError(409, 'NO_CHANGE', 'The destination is the same as the current path.')

function field(body: Record<string, unknown>, name: string): string {
  const value = body[name]
  if (typeof value !== 'string') throw new RequestError(400, 'INVALID_BODY', `The ${name} field must be a string.`)
  return value
}

function locationField(body: Record<string, unknown>, name: string): string {
  const value = body[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new RequestError(400, 'INVALID_LOCATION', `The ${name} field must name a configured location.`)
  }
  return value
}

/**
 * Parses the discriminated request body. Source names and location id shapes are checked here; whether an id
 * is configured is checked by the registry, and paths are validated by the operation.
 */
export function parseMutationBody(body: unknown): MutationRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RequestError(400, 'INVALID_BODY', 'The request body must be a JSON object with an op, source, locationId and path.')
  }
  const record = body as Record<string, unknown>
  const source = record.source
  if (!isSource(source)) throw new RequestError(400, 'INVALID_SOURCE', 'The source must be Pi or Claude.')
  const locationId = locationField(record, 'locationId')
  const path = field(record, 'path')
  switch (record.op) {
    case 'create-file': {
      const content = record.content === undefined ? '' : record.content
      if (typeof content !== 'string') throw new RequestError(400, 'INVALID_CONTENT', 'The content must be a string.')
      return { op: 'create-file', source, locationId, path, content }
    }
    case 'create-folder':
      return { op: 'create-folder', source, locationId, path }
    case 'delete':
      return { op: 'delete', source, locationId, path }
    case 'rename':
    case 'move': {
      if (record.destinationSource !== undefined && record.destinationSource !== source) {
        throw new RequestError(400, 'INVALID_SOURCE', `A ${record.op} stays within the same source.`)
      }
      if (record.destinationLocationId !== undefined && record.destinationLocationId !== locationId) {
        throw new RequestError(400, 'INVALID_LOCATION', `A ${record.op} stays within one location. Use copy to reach another location.`)
      }
      return { op: record.op, source, locationId, path, destinationPath: field(record, 'destinationPath') }
    }
    case 'copy': {
      const destinationSource = record.destinationSource
      if (!isSource(destinationSource)) throw new RequestError(400, 'INVALID_SOURCE', 'The destination source must be Pi or Claude.')
      if (destinationSource === source) throw new RequestError(400, 'INVALID_SOURCE', 'Copy targets the other source only.')
      const destinationLocationId = locationField(record, 'destinationLocationId')
      return { op: 'copy', source, locationId, path, destinationSource, destinationLocationId, destinationPath: field(record, 'destinationPath') }
    }
    default:
      throw new RequestError(400, 'INVALID_OP', 'The op must be create-file, create-folder, rename, move, delete or copy.')
  }
}

function sameComponents(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((component, index) => component === b[index])
}

/** lstat inside the open parent: reports whatever occupies the name, including a dangling symlink. */
async function probe(parent: FileHandle, name: string): Promise<Stats | null> {
  try {
    return await fs.lstat(at(parent, name))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function assertAbsent(parent: FileHandle, name: string): Promise<void> {
  if (await probe(parent, name)) throw DESTINATION_EXISTS
}

/** Resolves an existing mutation target: a regular Markdown file or a directory, never a symlink or other type. */
async function existingTarget(parent: FileHandle, name: string): Promise<'file' | 'folder'> {
  const stats = await probe(parent, name)
  if (!stats || stats.isSymbolicLink()) throw new PathError(404, NOT_FOUND)
  if (stats.isDirectory()) return 'folder'
  if (stats.isFile() && isMarkdownName(name)) return 'file'
  throw new PathError(404, NOT_FOUND)
}

async function assertEmptyFolder(parent: FileHandle, name: string): Promise<void> {
  // Includes hidden and non-Markdown entries the listing never shows.
  if ((await fs.readdir(at(parent, name))).length > 0) throw FOLDER_NOT_EMPTY
}

function conflictFromErrno(error: unknown): never {
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'EEXIST') throw DESTINATION_EXISTS
  if (code === 'ENOTEMPTY') throw FOLDER_NOT_EMPTY
  throw error
}

/** Finish bytes and permissions privately, then publish with an exclusive hard link. A failed
 * stage never owns the destination name, so cleanup cannot delete an external replacement there. */
async function publishFile(parent: FileHandle, name: string, bytes: Buffer, mode?: number): Promise<void> {
  await assertAbsent(parent, name)
  const temporary = at(parent, temporaryFileName())
  const file = await fs.open(temporary, CREATE_FLAGS, 0o644)
  try {
    if (mode !== undefined) await file.chmod(mode)
    await file.writeFile(bytes)
    await file.close()
    await fs.link(temporary, at(parent, name)).catch(conflictFromErrno)
  } finally {
    await file.close().catch(() => undefined)
    // Publication commits at link(): cleanup must neither turn success into failure nor
    // mask an earlier write/collision error. A leaked non-Markdown stage is logged only.
    await fs.unlink(temporary).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('Could not remove mutation staging file:', error)
      }
    })
  }
}

async function createFile(root: FileHandle, components: string[], content: string): Promise<void> {
  await withParentDirectory(root, components, (parent, name) => publishFile(parent, name, Buffer.from(content, 'utf8')))
}

async function createFolder(root: FileHandle, components: string[]): Promise<void> {
  await withParentDirectory(root, components, async (parent, name) => {
    await assertAbsent(parent, name)
    await fs.mkdir(at(parent, name)).catch(conflictFromErrno)
  })
}

async function deleteEntry(root: FileHandle, components: string[]): Promise<void> {
  await withParentDirectory(root, components, async (parent, name) => {
    const kind = await existingTarget(parent, name)
    if (kind === 'file') {
      await fs.unlink(at(parent, name))
    } else {
      await assertEmptyFolder(parent, name)
      await fs.rmdir(at(parent, name)).catch(conflictFromErrno)
    }
  })
}

/** Rename and move share one implementation within one location root; the caller has already checked the parent relationship. */
async function relocate(root: FileHandle, from: string[], to: string[]): Promise<void> {
  if (sameComponents(from, to)) throw NO_CHANGE
  const fromParent = from.slice(0, -1)
  if (to.length > from.length && sameComponents(from, to.slice(0, from.length))) {
    throw new PathError(400, 'A folder cannot be moved into itself.')
  }
  await withParentDirectory(root, from, async (sourceParent, sourceName) => {
    const kind = await existingTarget(sourceParent, sourceName)
    const destinationName = to[to.length - 1]
    if (kind === 'file' && !isMarkdownName(destinationName)) throw new PathError(400, 'The file name must end in .md.')
    if (kind === 'folder' && isMarkdownName(destinationName)) throw new PathError(400, 'A folder name must not end in .md.')
    if (kind === 'folder') await assertEmptyFolder(sourceParent, sourceName)
    const run = async (destinationParent: FileHandle) => {
      await assertAbsent(destinationParent, destinationName)
      if (kind === 'file') {
        // link() refuses an existing destination atomically; the old name is removed only once the new one exists.
        await fs.link(at(sourceParent, sourceName), at(destinationParent, destinationName)).catch(conflictFromErrno)
        try {
          await fs.unlink(at(sourceParent, sourceName))
        } catch (error) {
          await fs.unlink(at(destinationParent, destinationName)).catch(() => undefined)
          throw error
        }
      } else {
        await fs.rename(at(sourceParent, sourceName), at(destinationParent, destinationName)).catch(conflictFromErrno)
      }
    }
    if (sameComponents(fromParent, to.slice(0, -1))) await run(sourceParent)
    else await withParentDirectory(root, to, destinationParent => run(destinationParent))
  })
}

/** Reads the source first, so a missing source is reported before the destination location is even opened. */
async function copyFile(sourceRoot: FileHandle, from: string[], openDestination: <T>(operation: (root: FileHandle) => Promise<T>) => Promise<T>, to: string[]): Promise<void> {
  await withParentDirectory(sourceRoot, from, async (sourceParent, sourceName, track) => {
    const source = await openRegularFile(sourceParent, sourceName)
    track(source)
    const stats = await source.stat()
    const bytes = await source.readFile()
    await openDestination(destinationRoot => withParentDirectory(destinationRoot, to, async (destinationParent, destinationName) => {
      await publishFile(destinationParent, destinationName, bytes, stats.mode & 0o7777)
    }))
  })
}

function addressed(location: LocationConfig, components: string[]): Addressed {
  return { source: location.source, locationId: location.id, path: components.join('/') }
}

/** Resolves locations and validates paths lexically, then runs the operation inside the shared serial queue. */
export async function performMutation(registry: LocationRegistry, request: MutationRequest): Promise<MutationResult> {
  const { op, source, locationId, path } = request
  const location = registry.resolve(source, locationId)
  return registry.mutations.run(async (): Promise<MutationResult> => {
    switch (op) {
      case 'create-file': {
        const target = validateEntryPath(path, 'file')
        await registry.withRoot(location, root => createFile(root, target, request.content))
        return { status: 201, body: { op, ...addressed(location, target) } }
      }
      case 'create-folder': {
        const target = validateEntryPath(path, 'folder')
        await registry.withRoot(location, root => createFolder(root, target))
        return { status: 201, body: { op, ...addressed(location, target) } }
      }
      case 'delete': {
        const target = validateEntryPath(path, 'any')
        await registry.withRoot(location, root => deleteEntry(root, target))
        return { status: 200, body: { op, ...addressed(location, target) } }
      }
      case 'rename':
      case 'move': {
        const from = validateEntryPath(path, 'any')
        const to = validateEntryPath(request.destinationPath, 'any')
        if (op === 'rename' && !sameComponents(from.slice(0, -1), to.slice(0, -1))) {
          throw new PathError(400, 'A rename keeps the same parent folder. Use move to change folders.')
        }
        await registry.withRoot(location, root => relocate(root, from, to))
        return {
          status: 200,
          body: { op, ...addressed(location, from), destinationSource: location.source, destinationLocationId: location.id, destinationPath: to.join('/') },
        }
      }
      case 'copy': {
        const from = validateEntryPath(path, 'any')
        if (!isMarkdownName(from[from.length - 1])) throw new PathError(404, NOT_FOUND)
        const destination = registry.resolve(request.destinationSource, request.destinationLocationId)
        const to = validateEntryPath(request.destinationPath, 'file')
        await registry.withRoot(location, sourceRoot => copyFile(sourceRoot, from, operation => registry.withRoot(destination, operation), to))
        return {
          status: 201,
          body: { op, ...addressed(location, from), destinationSource: destination.source, destinationLocationId: destination.id, destinationPath: to.join('/') },
        }
      }
    }
  })
}
