import { useMemo, useState, type FormEvent } from 'react'
import { locationLabel, nodeId, type FolderRef, type Location, type Source, type TreeIndex } from '../graph/model.ts'
import { Modal } from '../ui/Modal.tsx'
import { OperationError, performOperation, type MutationRequest, type MutationResponse } from './api.ts'
import { validateName } from './validate.ts'

/** A file or directory inside one configured location. */
export type Located = { source: Source; locationId: string; path: string }

/** What the user asked to do and to what. Folder targets are directories: sources and locations are never targets. */
export type OperationTarget =
  | { kind: 'folder'; ref: Located }
  | { kind: 'file'; ref: Located; draftDirty: boolean }

export type Operation =
  /** `parent.locationId` is null when creating from a source node: the dialog then requires choosing a location. */
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

function describeFolder(ref: FolderRef, index: TreeIndex): string {
  const parts: string[] = [ref.source]
  if (ref.locationId !== null) {
    parts.push(locationLabel(index, { source: ref.source, locationId: ref.locationId }))
    if (ref.path) parts.push(ref.path)
  }
  return parts.join(' / ')
}

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

/** Available locations of one source, in configured order. Unavailable locations are never offered as destinations. */
function locationOptions(index: TreeIndex, source: Source): Location[] {
  return [...index.locations.values()].filter(location => location.source === source && location.status === 'available')
}

/** Folders of one location (its root first), in listing order, optionally excluding a subtree (a folder cannot move into itself). */
function folderOptions(index: TreeIndex, source: Source, locationId: string, exclude: string | null): Located[] {
  const options: Located[] = []
  for (const node of index.nodes.values()) {
    if (node.source !== source || node.locationId !== locationId || node.kind === 'file' || node.kind === 'source') continue
    if (exclude !== null && (node.path === exclude || node.path.startsWith(`${exclude}/`))) continue
    options.push({ source, locationId, path: node.path })
  }
  return options.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

const TITLES: Record<Operation['op'], string> = {
  'create-file': 'New file', 'create-folder': 'New folder', rename: 'Rename', move: 'Move', delete: 'Delete', copy: 'Copy',
}
const SUBMIT: Record<Operation['op'], string> = {
  'create-file': 'Create', 'create-folder': 'Create', rename: 'Rename', move: 'Move', delete: 'Delete', copy: 'Copy',
}

/** One labelled dialog per operation: location/name/destination fields, client validation, one pending request, server errors inline. */
export function OperationDialog({ operation, index, onCancel, onSuccess }: Props) {
  const { op } = operation
  const target = 'target' in operation ? operation.target : null
  const targetName = target ? baseName(target.ref.path) : ''
  const nameKind: 'file' | 'folder' = op === 'create-folder' || (target?.kind === 'folder') ? 'folder' : 'file'
  const [name, setName] = useState(op === 'rename' || op === 'copy' ? targetName : '')

  // Creating from a source node: the location must be chosen explicitly unless exactly one is available.
  const creationLocations = useMemo(
    () => (op === 'create-file' || op === 'create-folder') && operation.parent.locationId === null ? locationOptions(index, operation.parent.source) : [],
    [index, op, operation],
  )
  const [chosenLocation, setChosenLocation] = useState(() => (creationLocations.length === 1 ? creationLocations[0].id : ''))

  // Copy: the destination is a location of the other source, chosen explicitly unless exactly one is available, then a folder in it.
  const destinationSource: Source | null = op === 'copy' ? (operation.target.ref.source === 'Pi' ? 'Claude' : 'Pi') : op === 'move' ? operation.target.ref.source : null
  const destinationLocations = useMemo(() => (op === 'copy' && destinationSource ? locationOptions(index, destinationSource) : []), [destinationSource, index, op])
  const [destinationLocation, setDestinationLocation] = useState(() => (op === 'copy' ? (destinationLocations.length === 1 ? destinationLocations[0].id : '') : ''))
  const destinationLocationId = op === 'move' ? operation.target.ref.locationId : destinationLocation
  const destinations = useMemo(() => {
    if (!destinationSource || !destinationLocationId) return []
    const exclude = op === 'move' && operation.target.kind === 'folder' ? operation.target.ref.path : null
    const currentParent = op === 'move' ? parentPath(operation.target.ref.path) : null
    return folderOptions(index, destinationSource, destinationLocationId, exclude).filter(folder => folder.path !== currentParent)
  }, [destinationSource, destinationLocationId, index, op, operation])
  const [destination, setDestination] = useState<string | null>(null)
  // A remembered folder only counts while it is still offered (the location may have changed since).
  const effectiveDestination = destination !== null && destinations.some(folder => folder.path === destination) ? destination : (destinations[0]?.path ?? '')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const request = (): MutationRequest | string => {
    switch (op) {
      case 'create-file':
      case 'create-folder': {
        const locationId = operation.parent.locationId ?? chosenLocation
        if (!locationId) return creationLocations.length === 0 ? `No ${operation.parent.source} location is available to create in.` : 'Choose a location.'
        const invalid = validateName(name, nameKind)
        if (invalid) return invalid
        return { op, source: operation.parent.source, locationId, path: joinPath(operation.parent.path, name) }
      }
      case 'rename': {
        const invalid = validateName(name, nameKind)
        if (invalid) return invalid
        if (name === targetName) return 'Enter a different name.'
        const { source, locationId, path } = operation.target.ref
        return { op, source, locationId, path, destinationPath: joinPath(parentPath(path), name) }
      }
      case 'move': {
        if (destinations.length === 0) return 'There is no other folder in this location to move this into.'
        const { source, locationId, path } = operation.target.ref
        return { op, source, locationId, path, destinationPath: joinPath(effectiveDestination, targetName) }
      }
      case 'delete': {
        const { source, locationId, path } = operation.target.ref
        return { op, source, locationId, path }
      }
      case 'copy': {
        if (!destinationLocationId) return destinationLocations.length === 0 ? `No ${destinationSource} location is available to copy into.` : 'Choose a destination location.'
        const invalid = validateName(name, 'file')
        if (invalid) return invalid
        const { source, locationId, path } = operation.target.ref
        return { op, source, locationId, path, destinationSource: destinationSource!, destinationLocationId, destinationPath: joinPath(effectiveDestination, name) }
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

  const locationSelect = (label: string, options: Location[], value: string, onChange: (id: string) => void) => (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={event => onChange(event.target.value)} disabled={pending || options.length === 0} aria-label={label}>
        {(value === '' || options.length === 0) && <option value="">{options.length === 0 ? 'No location available' : 'Choose a location…'}</option>}
        {options.map(location => <option key={location.id} value={location.id}>{location.label}</option>)}
      </select>
    </label>
  )
  const destinationField = destinationSource && destinationLocationId && (
    <label className="field">
      <span>Destination folder</span>
      <select value={effectiveDestination} onChange={event => setDestination(event.target.value)} disabled={pending || destinations.length === 0} aria-label="Destination folder">
        {destinations.map(folder => (
          <option key={nodeId(folder.source, folder.locationId, folder.path)} value={folder.path}>
            {folder.path || `${locationLabel(index, folder)} (location root)`}
          </option>
        ))}
      </select>
    </label>
  )

  let description: React.ReactNode
  let fields: React.ReactNode = null
  switch (op) {
    case 'create-file':
    case 'create-folder':
      description = operation.parent.locationId === null
        ? <p>{operation.parent.source} is a source, not a folder: choose which configured location the new {op === 'create-file' ? 'file' : 'folder'} belongs to. {op === 'create-file' ? 'The file starts empty and opens for editing.' : 'The folder starts empty.'}</p>
        : <p>In <span className="dialog-path">{describeFolder(operation.parent, index)}</span>. {op === 'create-file' ? 'The file starts empty and opens for editing.' : 'The folder starts empty.'}</p>
      fields = (
        <>
          {operation.parent.locationId === null && locationSelect('Location', creationLocations, chosenLocation, setChosenLocation)}
          <label className="field">
            <span>{op === 'create-file' ? 'File name' : 'Folder name'}</span>
            <input type="text" value={name} onChange={event => setName(event.target.value)} disabled={pending} placeholder={op === 'create-file' ? 'name.md' : 'name'} autoComplete="off" spellCheck={false} />
          </label>
        </>
      )
      break
    case 'rename':
      description = <p>Renames <span className="dialog-path">{describeFolder(operation.target.ref, index)}</span> within its folder.</p>
      fields = (
        <label className="field">
          <span>New name</span>
          <input type="text" value={name} onChange={event => setName(event.target.value)} disabled={pending} autoComplete="off" spellCheck={false} />
        </label>
      )
      break
    case 'move':
      description = <p>Moves <span className="dialog-path">{describeFolder(operation.target.ref, index)}</span> to another folder in the same location ({locationLabel(index, operation.target.ref)}), keeping its name. Moving between locations is not supported.</p>
      fields = destinationField
      break
    case 'delete':
      description = (
        <>
          <p>Delete <span className="dialog-path">{describeFolder(operation.target.ref, index)}</span>?</p>
          <p>This cannot be undone in the app: there is no trash or version history, only whatever git or backups hold. {operation.target.kind === 'folder' ? 'Only an empty folder can be deleted.' : ''}</p>
        </>
      )
      break
    case 'copy':
      description = (
        <>
          <p>Copies the <strong>saved content</strong> of <span className="dialog-path">{describeFolder(operation.target.ref, index)}</span> from disk into a {destinationSource} location{operation.target.draftDirty ? '; unsaved draft changes are not included' : ''}.</p>
          <p>The bytes are copied as they are, so frontmatter written for {operation.target.ref.source} may not be accepted by the {destinationSource} agent.</p>
        </>
      )
      fields = (
        <>
          {locationSelect('Destination location', destinationLocations, destinationLocation, id => { setDestinationLocation(id); setDestination(null) })}
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
