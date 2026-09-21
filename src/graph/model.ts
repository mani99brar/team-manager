/**
 * Pure graph model: builds a containment tree from the /api/entries listing (the configured locations plus a
 * flat entry list) and derives what is visible for a given expansion state. No DOM or layout concerns live here.
 *
 * Identity is (source, locationId, relativePath). Pi/Claude and the configured locations are virtual
 * navigation boundaries: every real file or directory belongs to exactly one location, and the same relative
 * path in two locations is two different things.
 */

export type Source = 'Pi' | 'Claude'
export const SOURCES: readonly Source[] = ['Pi', 'Claude']
export type Category = 'personal' | 'package' | 'plugin' | 'project'
export type LocationStatus = 'available' | 'unavailable'
/** One configured filesystem location as the API reports it: never an absolute path. */
export type Location = { id: string; source: Source; label: string; category: Category; status: LocationStatus; error: string | null }
export type EntryKind = 'directory' | 'file'
export type Entry = { source: Source; locationId: string; path: string; kind: EntryKind }
export type Listing = { locations: Location[]; entries: Entry[] }
export type NodeKind = 'source' | 'location' | 'directory' | 'file'

/** A source root (locationId null), a location root (path '') or a directory inside a location. */
export type FolderRef = { source: Source; locationId: string | null; path: string }

/** A Markdown file identified by source, location and nonempty location-relative path. Filename alone is never enough. */
export type FileRef = { source: Source; locationId: string; path: string }

export type LocationKey = { source: Source; locationId: string }

export type GraphNode = {
  id: string
  source: Source
  locationId: string | null
  path: string
  name: string
  kind: NodeKind
  parentId: string | null
  depth: number
  /** Location nodes carry their configured metadata and availability. */
  location?: Location
}

export type GraphEdge = { id: string; parentId: string; childId: string }

export type TreeIndex = {
  nodes: Map<string, GraphNode>
  /** Immediate children in display order: locations in configured order; directories first, then files, each alphabetical. */
  children: Map<string, GraphNode[]>
  /** Configured locations keyed by their node id (`<source>/<locationId>`). */
  locations: Map<string, Location>
}

export type ChildCounts = { locations: number; directories: number; files: number }

/** Matches the server's location id contract; anything else in a URL is malformed rather than looked up. */
export const LOCATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function isSource(value: string): value is Source {
  return value === 'Pi' || value === 'Claude'
}

export function isLocationId(value: string): boolean {
  return LOCATION_ID_PATTERN.test(value)
}

export function nodeId(source: Source, locationId: string | null, path: string): string {
  if (locationId === null) return source
  return path ? `${source}/${locationId}/${path}` : `${source}/${locationId}`
}

export function refId(ref: FolderRef): string {
  return nodeId(ref.source, ref.locationId, ref.path)
}

export function sameRef(a: FolderRef | null, b: FolderRef | null): boolean {
  return a === b || (a !== null && b !== null && a.source === b.source && a.locationId === b.locationId && a.path === b.path)
}

export function sameFileRef(a: FileRef | null, b: FileRef | null): boolean {
  return sameRef(a, b)
}

/** The folder that contains a file: the location root for top-level files. */
export function parentFolderOf(ref: FileRef): FolderRef {
  return { source: ref.source, locationId: ref.locationId, path: parentPath(ref.path) }
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function parentPath(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

const KIND_ORDER: Record<NodeKind, number> = { source: 0, location: 1, directory: 2, file: 3 }

function compareNodes(a: GraphNode, b: GraphNode): number {
  if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
  // Locations keep their configured order (the sort is stable).
  if (a.kind === 'location') return 0
  return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

/**
 * Builds the containment index. Location nodes come from the configured list, in its order, whether or not
 * they are available; entries naming an unconfigured location are dropped rather than inventing one.
 * Directory parents are created implicitly if the listing omits them.
 */
export function buildIndex(listing: Listing): TreeIndex {
  const nodes = new Map<string, GraphNode>()
  const locations = new Map<string, Location>()
  for (const source of SOURCES) {
    nodes.set(source, { id: source, source, locationId: null, path: '', name: source, kind: 'source', parentId: null, depth: 0 })
  }
  for (const location of listing.locations) {
    if (!isSource(location.source) || typeof location.id !== 'string' || !isLocationId(location.id)) continue
    const id = nodeId(location.source, location.id, '')
    if (nodes.has(id)) continue
    nodes.set(id, { id, source: location.source, locationId: location.id, path: '', name: location.label, kind: 'location', parentId: location.source, depth: 1, location })
    locations.set(id, location)
  }
  function ensure(source: Source, locationId: string, path: string, kind: NodeKind): GraphNode {
    const id = nodeId(source, locationId, path)
    const existing = nodes.get(id)
    if (existing) return existing
    const parent = path.includes('/') ? ensure(source, locationId, parentPath(path), 'directory') : nodes.get(nodeId(source, locationId, ''))!
    const node: GraphNode = { id, source, locationId, path, name: baseName(path), kind, parentId: parent.id, depth: parent.depth + 1 }
    nodes.set(id, node)
    return node
  }
  for (const entry of listing.entries) {
    if (!isSource(entry.source) || typeof entry.locationId !== 'string' || !entry.path) continue
    if (entry.path.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) continue
    const location = locations.get(nodeId(entry.source, entry.locationId, ''))
    if (!location || location.status !== 'available') continue
    ensure(entry.source, entry.locationId, entry.path, entry.kind === 'directory' ? 'directory' : 'file')
  }
  const children = new Map<string, GraphNode[]>()
  for (const node of nodes.values()) {
    if (node.parentId === null) continue
    const siblings = children.get(node.parentId) ?? []
    siblings.push(node)
    children.set(node.parentId, siblings)
  }
  for (const siblings of children.values()) siblings.sort(compareNodes)
  return { nodes, children, locations }
}

/** The configured location for a key, only when it belongs to that source. */
export function locationOf(index: TreeIndex, key: LocationKey): Location | undefined {
  return index.locations.get(nodeId(key.source, key.locationId, ''))
}

export function childrenOf(index: TreeIndex, id: string): GraphNode[] {
  return index.children.get(id) ?? []
}

export function childCounts(index: TreeIndex, id: string): ChildCounts {
  const counts = { locations: 0, directories: 0, files: 0 }
  for (const child of childrenOf(index, id)) {
    if (child.kind === 'file') counts.files += 1
    else if (child.kind === 'location') counts.locations += 1
    else counts.directories += 1
  }
  return counts
}

/** Human text for a node's contents. A source counts locations; locations and directories count folders and files. */
export function describeCounts({ locations, directories, files }: ChildCounts, kind: NodeKind = 'directory'): string {
  if (kind === 'source') {
    if (locations === 0) return 'No locations are configured for this source.'
    return `${locations} ${locations === 1 ? 'location' : 'locations'}`
  }
  if (directories + files === 0) return 'This folder is empty.'
  const parts = [
    `${directories} ${directories === 1 ? 'folder' : 'folders'}`,
    `${files} ${files === 1 ? 'Markdown file' : 'Markdown files'}`,
  ]
  return parts.join(', ')
}

/** Ids of every descendant of `id`, depth-first. */
export function descendantIds(index: TreeIndex, id: string): string[] {
  const result: string[] = []
  const stack = [...childrenOf(index, id)]
  while (stack.length) {
    const node = stack.pop()!
    result.push(node.id)
    stack.push(...childrenOf(index, node.id))
  }
  return result
}

/** Ids of the source, the location and every ancestor directory of `node`, outermost first (excluding the node itself). */
export function ancestorIds(node: GraphNode): string[] {
  const ids: string[] = []
  if (node.kind === 'source' || node.locationId === null) return ids
  ids.push(node.source)
  if (node.kind === 'location') return ids
  ids.push(nodeId(node.source, node.locationId, ''))
  const segments = node.path.split('/')
  for (let i = 1; i < segments.length; i += 1) ids.push(nodeId(node.source, node.locationId, segments.slice(0, i).join('/')))
  return ids
}

/** Visible nodes in keyboard/DOM order (pre-order: Pi subtree, then Claude subtree), and their containment edges. */
export function visibleGraph(index: TreeIndex, expanded: ReadonlySet<string>): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  function visit(node: GraphNode) {
    nodes.push(node)
    if (node.kind === 'file' || !expanded.has(node.id)) return
    for (const child of childrenOf(index, node.id)) {
      edges.push({ id: child.id, parentId: node.id, childId: child.id })
      visit(child)
    }
  }
  for (const source of SOURCES) visit(index.nodes.get(source)!)
  return { nodes, edges }
}

/** Collapsing hides every descendant and forgets their expansion state. */
export function collapseNode(index: TreeIndex, expanded: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(expanded)
  next.delete(id)
  for (const descendant of descendantIds(index, id)) next.delete(descendant)
  return next
}

/** Expands the ancestor chain and the folder itself so it is visible, leaving other branches alone. */
export function revealFolder(index: TreeIndex, expanded: ReadonlySet<string>, ref: FolderRef): Set<string> {
  const node = index.nodes.get(refId(ref))
  if (!node || node.kind === 'file') return new Set(expanded)
  const next = new Set(expanded)
  for (const id of ancestorIds(node)) next.add(id)
  next.add(node.id)
  return next
}

/** Drops ids that no longer exist after a refresh. */
export function pruneIds(index: TreeIndex, ids: ReadonlySet<string>): Set<string> {
  return new Set([...ids].filter(id => index.nodes.has(id)))
}

/** Whether a folder ref names a source, a configured location (available or not) or an existing directory. */
export function folderExists(index: TreeIndex, ref: FolderRef | null): boolean {
  if (ref === null) return true
  const node = index.nodes.get(refId(ref))
  return node !== undefined && node.kind !== 'file'
}

// ---- URLs ---------------------------------------------------------------------------------------

const BROWSE_ROUTE = 'browse'
const FILE_ROUTE = 'file'
const PROJECTS_ROUTE = 'projects'

/** Encodes the selected folder as `/browse/<source>[/<locationId>[/segments…]]`, encoding every segment. */
export function folderToPathname(ref: FolderRef | null): string {
  if (ref === null) return '/'
  const segments: string[] = [ref.source]
  if (ref.locationId !== null) {
    segments.push(ref.locationId)
    if (ref.path) segments.push(...ref.path.split('/'))
  }
  return `/${BROWSE_ROUTE}/${segments.map(encodeURIComponent).join('/')}`
}

/** Encodes a document as `/file/<source>/<locationId>/<segment>/…`, encoding every path segment individually. */
export function fileToPathname(ref: FileRef): string {
  return `/${FILE_ROUTE}/${[ref.source, ref.locationId, ...ref.path.split('/')].map(encodeURIComponent).join('/')}`
}

export type ParsedLocation =
  | { kind: 'home' }
  | { kind: 'folder'; ref: FolderRef }
  | { kind: 'file'; ref: FileRef }
  | { kind: 'unknown-source'; name: string }
  | { kind: 'malformed' }
  /** The read-only Projects root (`/projects/…`), a separate domain parsed by `src/projects/routes.ts`. */
  | { kind: 'projects'; pathname: string }
  /** A link from the fixture-only layout (`/<Source>/…`, `/file/<Source>/<name>.md`): explained, never resolved. */
  | { kind: 'legacy'; source: Source; pathname: string }

/** Decodes each raw segment exactly once; malformed percent-encoding yields null instead of throwing. */
function decodeSegments(raw: string[]): string[] | null {
  try {
    return raw.map(decodeURIComponent)
  } catch {
    return null
  }
}

/** Decoded path segments must be plain names: no separators, no dot components, nothing empty. */
function validSegments(segments: string[]): boolean {
  return segments.every(segment => segment !== '' && segment !== '.' && segment !== '..' && !segment.includes('/'))
}

export function parsePathname(pathname: string): ParsedLocation {
  const raw = pathname.split('/').filter(segment => segment !== '')
  if (raw.length === 0) return { kind: 'home' }
  const [route, ...rest] = raw
  if (route === PROJECTS_ROUTE) return { kind: 'projects', pathname }
  if (route === BROWSE_ROUTE) {
    if (rest.length === 0) return { kind: 'home' }
    const segments = decodeSegments(rest)
    if (!segments) return { kind: 'malformed' }
    const [source, locationId, ...path] = segments
    if (!isSource(source)) return { kind: 'unknown-source', name: source }
    if (locationId === undefined) return { kind: 'folder', ref: { source, locationId: null, path: '' } }
    if (!isLocationId(locationId) || !validSegments(path)) return { kind: 'malformed' }
    return { kind: 'folder', ref: { source, locationId, path: path.join('/') } }
  }
  if (route === FILE_ROUTE) {
    if (rest.length < 2) return { kind: 'malformed' }
    const segments = decodeSegments(rest)
    if (!segments) return { kind: 'malformed' }
    const [source, locationId, ...path] = segments
    if (!isSource(source)) return { kind: 'unknown-source', name: source }
    if (path.length === 0) {
      // `/file/<Source>/<name>.md` was a fixture-layout document link; a location root is never a file.
      return locationId.toLowerCase().endsWith('.md') ? { kind: 'legacy', source, pathname } : { kind: 'malformed' }
    }
    if (!isLocationId(locationId) || !validSegments(path)) return { kind: 'malformed' }
    return { kind: 'file', ref: { source, locationId, path: path.join('/') } }
  }
  const decoded = decodeSegments([route])
  if (!decoded) return { kind: 'malformed' }
  const first = decoded[0]
  if (isSource(first)) return { kind: 'legacy', source: first, pathname }
  return { kind: 'unknown-source', name: first }
}

/** `ref` is the folder to navigate to (null = Home). A crumb without `ref` is the current document and not a link. */
export type Breadcrumb = { label: string; ref?: FolderRef | null; id: string }

/** The configured label of a location, or its id when the listing is not loaded or does not know it. */
export function locationLabel(index: TreeIndex | null, key: LocationKey): string {
  return (index && locationOf(index, key)?.label) || key.locationId
}

/** Home, then the source, then the location (by label), then one crumb per directory segment. */
export function breadcrumbsFor(ref: FolderRef | null, index: TreeIndex | null): Breadcrumb[] {
  const crumbs: Breadcrumb[] = [{ label: 'Home', ref: null, id: 'home' }]
  if (ref === null) return crumbs
  crumbs.push({ label: ref.source, ref: { source: ref.source, locationId: null, path: '' }, id: ref.source })
  if (ref.locationId === null) return crumbs
  const locationId = ref.locationId
  crumbs.push({ label: locationLabel(index, { source: ref.source, locationId }), ref: { source: ref.source, locationId, path: '' }, id: nodeId(ref.source, locationId, '') })
  if (!ref.path) return crumbs
  const segments = ref.path.split('/')
  for (let i = 0; i < segments.length; i += 1) {
    const path = segments.slice(0, i + 1).join('/')
    crumbs.push({ label: segments[i], ref: { source: ref.source, locationId, path }, id: nodeId(ref.source, locationId, path) })
  }
  return crumbs
}

/** The containing folder's trail plus the filename as a non-navigating current item. */
export function breadcrumbsForFile(ref: FileRef, index: TreeIndex | null): Breadcrumb[] {
  return [...breadcrumbsFor(parentFolderOf(ref), index), { label: baseName(ref.path), id: nodeId(ref.source, ref.locationId, ref.path) }]
}
