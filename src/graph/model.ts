/**
 * Pure graph model: builds a containment tree from the flat /api/entries listing and
 * derives what is visible for a given expansion state. No DOM or layout concerns live here.
 */

export type Source = 'Pi' | 'Claude'
export const SOURCES: readonly Source[] = ['Pi', 'Claude']
export type EntryKind = 'directory' | 'file'
export type Entry = { source: Source; path: string; kind: EntryKind }
export type NodeKind = 'source' | 'directory' | 'file'

/** A source root (path '') or a directory inside it. */
export type FolderRef = { source: Source; path: string }

export type GraphNode = {
  id: string
  source: Source
  path: string
  name: string
  kind: NodeKind
  parentId: string | null
  depth: number
}

export type GraphEdge = { id: string; parentId: string; childId: string }

export type TreeIndex = {
  nodes: Map<string, GraphNode>
  /** Immediate children in display order: directories first, then files, each alphabetical. */
  children: Map<string, GraphNode[]>
}

export type ChildCounts = { directories: number; files: number }

export function isSource(value: string): value is Source {
  return value === 'Pi' || value === 'Claude'
}

export function nodeId(source: Source, path: string): string {
  return path ? `${source}/${path}` : source
}

export function refId(ref: FolderRef): string {
  return nodeId(ref.source, ref.path)
}

export function sameRef(a: FolderRef | null, b: FolderRef | null): boolean {
  return a === b || (a !== null && b !== null && a.source === b.source && a.path === b.path)
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function parentPath(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

function compareNodes(a: GraphNode, b: GraphNode): number {
  if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
  return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

/** Builds the containment index. Parents are created implicitly if the listing omits them. */
export function buildIndex(entries: readonly Entry[]): TreeIndex {
  const nodes = new Map<string, GraphNode>()
  for (const source of SOURCES) {
    nodes.set(source, { id: source, source, path: '', name: source, kind: 'source', parentId: null, depth: 0 })
  }
  function ensure(source: Source, path: string, kind: NodeKind): GraphNode {
    const id = nodeId(source, path)
    const existing = nodes.get(id)
    if (existing) return existing
    const parent = path.includes('/') ? ensure(source, parentPath(path), 'directory') : nodes.get(source)!
    const node: GraphNode = { id, source, path, name: baseName(path), kind, parentId: parent.id, depth: parent.depth + 1 }
    nodes.set(id, node)
    return node
  }
  for (const entry of entries) {
    if (!isSource(entry.source) || !entry.path || entry.path.split('/').some(segment => segment === '')) continue
    ensure(entry.source, entry.path, entry.kind === 'directory' ? 'directory' : 'file')
  }
  const children = new Map<string, GraphNode[]>()
  for (const node of nodes.values()) {
    if (node.parentId === null) continue
    const siblings = children.get(node.parentId) ?? []
    siblings.push(node)
    children.set(node.parentId, siblings)
  }
  for (const siblings of children.values()) siblings.sort(compareNodes)
  return { nodes, children }
}

export function childrenOf(index: TreeIndex, id: string): GraphNode[] {
  return index.children.get(id) ?? []
}

export function childCounts(index: TreeIndex, id: string): ChildCounts {
  const counts = { directories: 0, files: 0 }
  for (const child of childrenOf(index, id)) {
    if (child.kind === 'file') counts.files += 1
    else counts.directories += 1
  }
  return counts
}

export function describeCounts({ directories, files }: ChildCounts): string {
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

/** Ids of the source and every ancestor directory of `node`, outermost first (excluding the node itself). */
export function ancestorIds(node: GraphNode): string[] {
  const ids: string[] = []
  if (node.kind === 'source') return ids
  ids.push(node.source)
  const segments = node.path.split('/')
  for (let i = 1; i < segments.length; i += 1) ids.push(nodeId(node.source, segments.slice(0, i).join('/')))
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

export function folderExists(index: TreeIndex, ref: FolderRef | null): boolean {
  if (ref === null) return true
  const node = index.nodes.get(refId(ref))
  return node !== undefined && node.kind !== 'file'
}

// ---- URLs ---------------------------------------------------------------------------------------

/** Encodes the selected folder as a pathname, encoding every segment so spaces, #, ? and % survive. */
export function folderToPathname(ref: FolderRef | null): string {
  if (ref === null) return '/'
  const segments = ref.path ? [ref.source, ...ref.path.split('/')] : [ref.source]
  return `/${segments.map(encodeURIComponent).join('/')}`
}

export type ParsedLocation =
  | { kind: 'home' }
  | { kind: 'folder'; ref: FolderRef }
  | { kind: 'unknown-source'; name: string }
  | { kind: 'malformed' }

export function parsePathname(pathname: string): ParsedLocation {
  const raw = pathname.split('/').filter(segment => segment !== '')
  if (raw.length === 0) return { kind: 'home' }
  let segments: string[]
  try {
    segments = raw.map(decodeURIComponent)
  } catch {
    return { kind: 'malformed' }
  }
  const [source, ...rest] = segments
  if (!isSource(source)) return { kind: 'unknown-source', name: source }
  return { kind: 'folder', ref: { source, path: rest.join('/') } }
}

export type Breadcrumb = { label: string; ref: FolderRef | null; id: string }

/** Home, then the source, then one crumb per directory segment. */
export function breadcrumbsFor(ref: FolderRef | null): Breadcrumb[] {
  const crumbs: Breadcrumb[] = [{ label: 'Home', ref: null, id: 'home' }]
  if (ref === null) return crumbs
  crumbs.push({ label: ref.source, ref: { source: ref.source, path: '' }, id: ref.source })
  if (!ref.path) return crumbs
  const segments = ref.path.split('/')
  for (let i = 0; i < segments.length; i += 1) {
    const path = segments.slice(0, i + 1).join('/')
    crumbs.push({ label: segments[i], ref: { source: ref.source, path }, id: nodeId(ref.source, path) })
  }
  return crumbs
}
