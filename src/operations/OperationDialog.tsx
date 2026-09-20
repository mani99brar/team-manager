import { useMemo, useState, type FormEvent } from 'react'
import { nodeId, type FolderRef, type Source, type TreeIndex } from '../graph/model.ts'
import { Modal } from '../ui/Modal.tsx'
import { OperationError, performOperation, type MutationRequest, type MutationResponse } from './api.ts'
import { validateName } from './validate.ts'

/** What the user asked to do and to what. Folders use `kind: 'folder'`; a source root is a folder with path ''. */
export type OperationTarget =
  | { kind: 'folder'; ref: FolderRef }
  | { kind: 'file'; ref: { source: Source; path: string }; draftDirty: boolean }

export type Operation =
  | { op: 'create-file' | 'create-folder'; parent: FolderRef }
  | { op: 'rename' | 'move' | 'delete'; target: OperationTarget }
  | { op: 'copy'; target: Extract<OperationTarget, { kind: 'file' }> }

type Props = {
  operation: Operation
  index: TreeIndex
  onCancel: () => void
  onSuccess: (operation: Operation, response: MutationResponse) => void
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function parentPath(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

function describeFolder(ref: FolderRef): string {
  return ref.path ? `${ref.source} / ${ref.path}` : ref.source
}

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

/** Folders of one source, in listing order, optionally excluding a subtree (a folder cannot move into itself). */
function folderOptions(index: TreeIndex, source: Source, exclude: string | null): FolderRef[] {
  const options: FolderRef[] = []
  for (const node of index.nodes.values()) {
    if (node.source !== source || node.kind === 'file') continue
    if (exclude !== null && (node.path === exclude || node.path.startsWith(`${exclude}/`))) continue
    options.push({ source, path: node.path })
  }
  return options.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

const TITLES: Record<Operation['op'], string> = {
  'create-file': 'New file', 'create-folder': 'New folder', rename: 'Rename', move: 'Move', delete: 'Delete', copy: 'Copy',
}
const SUBMIT: Record<Operation['op'], string> = {
  'create-file': 'Create', 'create-folder': 'Create', rename: 'Rename', move: 'Move', delete: 'Delete', copy: 'Copy',
}

/** One labelled dialog per operation: name/destination fields, client validation, one pending request, server errors inline. */
export function OperationDialog({ operation, index, onCancel, onSuccess }: Props) {
  const { op } = operation
  const target = 'target' in operation ? operation.target : null
  const targetName = target ? baseName(target.ref.path) : ''
  const nameKind: 'file' | 'folder' = op === 'create-folder' || (target?.kind === 'folder') ? 'folder' : 'file'
  const [name, setName] = useState(op === 'rename' || op === 'copy' ? targetName : '')
  const destinationSource: Source | null = op === 'copy' ? (operation.target.ref.source === 'Pi' ? 'Claude' : 'Pi') : op === 'move' ? operation.target.ref.source : null
  const destinations = useMemo(() => {
    if (!destinationSource) return []
    const exclude = op === 'move' && operation.target.kind === 'folder' ? operation.target.ref.path : null
    const currentParent = op === 'move' ? parentPath(operation.target.ref.path) : null
    return folderOptions(index, destinationSource, exclude).filter(folder => folder.path !== currentParent)
  }, [destinationSource, index, op, operation])
  const [destination, setDestination] = useState(() => destinations[0]?.path ?? '')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const request = (): MutationRequest | string => {
    switch (op) {
      case 'create-file':
      case 'create-folder': {
        const invalid = validateName(name, nameKind)
        if (invalid) return invalid
        return { op, source: operation.parent.source, path: joinPath(operation.parent.path, name) }
      }
      case 'rename': {
        const invalid = validateName(name, nameKind)
        if (invalid) return invalid
        if (name === targetName) return 'Enter a different name.'
        return { op, source: operation.target.ref.source, path: operation.target.ref.path, destinationPath: joinPath(parentPath(operation.target.ref.path), name) }
      }
      case 'move': {
        if (destinations.length === 0) return 'There is no other folder to move this into.'
        return { op, source: operation.target.ref.source, path: operation.target.ref.path, destinationPath: joinPath(destination, targetName) }
      }
      case 'delete':
        return { op, source: operation.target.ref.source, path: operation.target.ref.path }
      case 'copy': {
        const invalid = validateName(name, 'file')
        if (invalid) return invalid
        return { op, source: operation.target.ref.source, path: operation.target.ref.path, destinationSource: destinationSource!, destinationPath: joinPath(destination, name) }
      }
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (pending) return
    const built = request()
    if (typeof built === 'string') { setError(built); return }
    setError(null)
    setPending(true)
    try {
      const response = await performOperation(built)
      onSuccess(operation, response)
    } catch (failure) {
      setError(failure instanceof OperationError ? failure.message : 'The operation failed unexpectedly.')
      setPending(false)
    }
  }

  let description: React.ReactNode
  let fields: React.ReactNode = null
  const destinationField = destinationSource && (
    <label className="field">
      <span>Destination folder</span>
      <select value={destination} onChange={event => setDestination(event.target.value)} disabled={pending || destinations.length === 0} aria-label="Destination folder">
        {destinations.map(folder => (
          <option key={nodeId(folder.source, folder.path)} value={folder.path}>{folder.path || `${folder.source} (source root)`}</option>
        ))}
      </select>
    </label>
  )
  switch (op) {
    case 'create-file':
    case 'create-folder':
      description = <p>In <span className="dialog-path">{describeFolder(operation.parent)}</span>. {op === 'create-file' ? 'The file starts empty and opens for editing.' : 'The folder starts empty.'}</p>
      fields = (
        <label className="field">
          <span>{op === 'create-file' ? 'File name' : 'Folder name'}</span>
          <input type="text" value={name} onChange={event => setName(event.target.value)} disabled={pending} placeholder={op === 'create-file' ? 'name.md' : 'name'} autoComplete="off" spellCheck={false} />
        </label>
      )
      break
    case 'rename':
      description = <p>Renames <span className="dialog-path">{describeFolder({ source: operation.target.ref.source, path: operation.target.ref.path })}</span> within its folder.</p>
      fields = (
        <label className="field">
          <span>New name</span>
          <input type="text" value={name} onChange={event => setName(event.target.value)} disabled={pending} autoComplete="off" spellCheck={false} />
        </label>
      )
      break
    case 'move':
      description = <p>Moves <span className="dialog-path">{describeFolder({ source: operation.target.ref.source, path: operation.target.ref.path })}</span> to another folder in {operation.target.ref.source}, keeping its name.</p>
      fields = destinationField
      break
    case 'delete':
      description = (
        <>
          <p>Delete <span className="dialog-path">{operation.target.ref.source} / {operation.target.ref.path}</span>?</p>
          <p>This cannot be undone in the app: there is no trash or version history, only whatever git or backups hold. {operation.target.kind === 'folder' ? 'Only an empty folder can be deleted.' : ''}</p>
        </>
      )
      break
    case 'copy':
      description = (
        <>
          <p>Copies the <strong>saved content</strong> of <span className="dialog-path">{operation.target.ref.source} / {operation.target.ref.path}</span> from disk into {destinationSource}{operation.target.draftDirty ? '; unsaved draft changes are not included' : ''}.</p>
          <p>The bytes are copied as they are, so frontmatter written for {operation.target.ref.source} may not be accepted by the {destinationSource} agent.</p>
        </>
      )
      fields = (
        <>
          {destinationField}
          <label className="field">
            <span>File name</span>
            <input type="text" value={name} onChange={event => setName(event.target.value)} disabled={pending} autoComplete="off" spellCheck={false} />
          </label>
        </>
      )
      break
  }

  const destructive = op === 'delete'
  return (
    <Modal title={op === 'copy' ? `Copy to ${destinationSource}` : TITLES[op]} initialFocus={fields ? 'first-field' : destructive ? 'cancel' : 'confirm'} pending={pending} onCancel={onCancel}>
      <form method="dialog" onSubmit={event => { void submit(event) }} aria-busy={pending}>
        <div className="confirm-description">{description}</div>
        {fields}
        {error && <p className="dialog-error" role="alert">{error}</p>}
        <div className="confirm-actions">
          <button type="button" className="button" data-dialog-cancel onClick={onCancel} disabled={pending}>Cancel</button>
          <button type="submit" className={destructive ? 'button button-danger' : 'button'} data-dialog-confirm disabled={pending} aria-busy={pending}>
            {pending ? `${SUBMIT[op]}…` : SUBMIT[op]}
          </button>
        </div>
      </form>
    </Modal>
  )
}
