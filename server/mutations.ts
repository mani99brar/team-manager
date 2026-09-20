import fs, { type FileHandle } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import {
  CREATE_FLAGS, NOT_FOUND, PathError, RequestError, at, isMarkdownName, isSource, openRegularFile, validateEntryPath,
  withParentDirectory, type FixtureRoot, type Source, type Target,
} from './files.ts'

/**
 * Bounded file and folder operations. Every step is descriptor-relative (see files.ts); nothing here
 * re-resolves a validated pathname. All operations run through the same serial queue as content saves.
 *
 * Collision policy: a filesystem probe (lstat of the destination name inside its open parent) refuses
 * anything that exists, including dangling symlinks; creation uses O_EXCL/mkdir, file renames use
 * link + unlink (link fails on an existing name), folder renames use rename after the probe.
 */
export type MutationRequest =
  | { op: 'create-file'; source: Source; path: string; content: string }
  | { op: 'create-folder'; source: Source; path: string }
  | { op: 'rename'; source: Source; path: string; destinationPath: string }
  | { op: 'move'; source: Source; path: string; destinationPath: string }
  | { op: 'delete'; source: Source; path: string }
  | { op: 'copy'; source: Source; path: string; destinationSource: Source; destinationPath: string }

export type MutationResult = { status: 200 | 201; body: { op: string; source: Source; path: string; destinationSource?: Source; destinationPath?: string } }

const DESTINATION_EXISTS = new RequestError(409, 'DESTINATION_EXISTS', 'Something already exists at that destination. Choose another name.')
const FOLDER_NOT_EMPTY = new RequestError(409, 'FOLDER_NOT_EMPTY', 'The folder is not empty. Only empty folders can be renamed, moved or deleted.')
const NO_CHANGE = new RequestError(409, 'NO_CHANGE', 'The destination is the same as the current path.')

function field(body: Record<string, unknown>, name: string): string {
  const value = body[name]
  if (typeof value !== 'string') throw new RequestError(400, 'INVALID_BODY', `The ${name} field must be a string.`)
  return value
}

/** Parses the discriminated request body. Source names are checked here; paths are validated by the operation. */
export function parseMutationBody(body: unknown): MutationRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RequestError(400, 'INVALID_BODY', 'The request body must be a JSON object with an op, source and path.')
  }
  const record = body as Record<string, unknown>
  const source = record.source
  if (!isSource(source)) throw new RequestError(400, 'INVALID_SOURCE', 'The source must be Pi or Claude.')
  const path = field(record, 'path')
  switch (record.op) {
    case 'create-file': {
      const content = record.content === undefined ? '' : record.content
      if (typeof content !== 'string') throw new RequestError(400, 'INVALID_CONTENT', 'The content must be a string.')
      return { op: 'create-file', source, path, content }
    }
    case 'create-folder':
      return { op: 'create-folder', source, path }
    case 'delete':
      return { op: 'delete', source, path }
    case 'rename':
    case 'move': {
      if (record.destinationSource !== undefined && record.destinationSource !== source) {
        throw new RequestError(400, 'INVALID_SOURCE', `A ${record.op} stays within the same source.`)
      }
      return { op: record.op, source, path, destinationPath: field(record, 'destinationPath') }
    }
    case 'copy': {
      const destinationSource = record.destinationSource
      if (!isSource(destinationSource)) throw new RequestError(400, 'INVALID_SOURCE', 'The destination source must be Pi or Claude.')
      if (destinationSource === source) throw new RequestError(400, 'INVALID_SOURCE', 'Copy targets the other source only.')
      return { op: 'copy', source, path, destinationSource, destinationPath: field(record, 'destinationPath') }
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

async function createFile(root: FixtureRoot, target: Target, content: string): Promise<void> {
  await withParentDirectory(root, target.source, target.components, async (parent, name) => {
    await assertAbsent(parent, name)
    const file = await fs.open(at(parent, name), CREATE_FLAGS, 0o644).catch(conflictFromErrno)
    try { await file.writeFile(Buffer.from(content, 'utf8')) } finally { await file.close() }
  })
}

async function createFolder(root: FixtureRoot, target: Target): Promise<void> {
  await withParentDirectory(root, target.source, target.components, async (parent, name) => {
    await assertAbsent(parent, name)
    await fs.mkdir(at(parent, name)).catch(conflictFromErrno)
  })
}

async function deleteEntry(root: FixtureRoot, target: Target): Promise<void> {
  await withParentDirectory(root, target.source, target.components, async (parent, name) => {
    const kind = await existingTarget(parent, name)
    if (kind === 'file') {
      await fs.unlink(at(parent, name))
    } else {
      await assertEmptyFolder(parent, name)
      await fs.rmdir(at(parent, name)).catch(conflictFromErrno)
    }
  })
}

/** Rename and move share one implementation; the caller has already checked the parent relationship. */
async function relocate(root: FixtureRoot, from: Target, to: Target): Promise<void> {
  if (sameComponents(from.components, to.components)) throw NO_CHANGE
  const fromParent = from.components.slice(0, -1)
  if (to.components.length > from.components.length && sameComponents(from.components, to.components.slice(0, from.components.length))) {
    throw new PathError(400, 'A folder cannot be moved into itself.')
  }
  await withParentDirectory(root, from.source, from.components, async (sourceParent, sourceName) => {
    const kind = await existingTarget(sourceParent, sourceName)
    const destinationName = to.components[to.components.length - 1]
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
    if (sameComponents(fromParent, to.components.slice(0, -1))) await run(sourceParent)
    else await withParentDirectory(root, to.source, to.components, destinationParent => run(destinationParent))
  })
}

async function copyFile(root: FixtureRoot, from: Target, to: Target): Promise<void> {
  await withParentDirectory(root, from.source, from.components, async (sourceParent, sourceName, track) => {
    const source = await openRegularFile(sourceParent, sourceName)
    track(source)
    const stats = await source.stat()
    const bytes = await source.readFile()
    await withParentDirectory(root, to.source, to.components, async (destinationParent, destinationName) => {
      await assertAbsent(destinationParent, destinationName)
      const file = await fs.open(at(destinationParent, destinationName), CREATE_FLAGS, 0o644).catch(conflictFromErrno)
      try {
        await file.chmod(stats.mode & 0o7777)
        await file.writeFile(bytes)
      } finally { await file.close() }
    })
  })
}

/** Validates everything lexically, then runs the operation inside the shared serial queue. */
export async function performMutation(root: FixtureRoot, request: MutationRequest): Promise<MutationResult> {
  const { op, source, path } = request
  return root.mutations.run(async (): Promise<MutationResult> => {
    switch (op) {
      case 'create-file': {
        const target = validateEntryPath(source, path, 'file')
        await createFile(root, target, request.content)
        return { status: 201, body: { op, source, path: target.components.join('/') } }
      }
      case 'create-folder': {
        const target = validateEntryPath(source, path, 'folder')
        await createFolder(root, target)
        return { status: 201, body: { op, source, path: target.components.join('/') } }
      }
      case 'delete': {
        const target = validateEntryPath(source, path, 'any')
        await deleteEntry(root, target)
        return { status: 200, body: { op, source, path: target.components.join('/') } }
      }
      case 'rename':
      case 'move': {
        const from = validateEntryPath(source, path, 'any')
        const to = validateEntryPath(source, request.destinationPath, 'any')
        if (op === 'rename' && !sameComponents(from.components.slice(0, -1), to.components.slice(0, -1))) {
          throw new PathError(400, 'A rename keeps the same parent folder. Use move to change folders.')
        }
        await relocate(root, from, to)
        return { status: 200, body: { op, source, path: from.components.join('/'), destinationSource: source, destinationPath: to.components.join('/') } }
      }
      case 'copy': {
        const from = validateEntryPath(source, path, 'any')
        if (!isMarkdownName(from.components[from.components.length - 1])) throw new PathError(404, NOT_FOUND)
        const to = validateEntryPath(request.destinationSource, request.destinationPath, 'file')
        await copyFile(root, from, to)
        return { status: 201, body: { op, source, path: from.components.join('/'), destinationSource: request.destinationSource, destinationPath: to.components.join('/') } }
      }
    }
  })
}
