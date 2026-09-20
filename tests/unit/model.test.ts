import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ancestorIds,
  breadcrumbsFor,
  buildIndex,
  childCounts,
  collapseNode,
  describeCounts,
  folderExists,
  folderToPathname,
  parsePathname,
  pruneIds,
  revealFolder,
  visibleGraph,
  type Entry,
} from '../../src/graph/model.ts'
import { wrapLabel } from '../../src/graph/labels.ts'
import { GraphLayout } from '../../src/graph/layout.ts'

const entries: Entry[] = [
  { source: 'Pi', path: 'skills', kind: 'directory' },
  { source: 'Pi', path: 'skills/review.md', kind: 'file' },
  { source: 'Pi', path: 'skills/empty', kind: 'directory' },
  { source: 'Pi', path: 'workflow.md', kind: 'file' },
  { source: 'Pi', path: 'archive.md', kind: 'file' },
  { source: 'Claude', path: 'workflow.md', kind: 'file' },
  { source: 'Claude', path: 'orphan/deeper/note.md', kind: 'file' }, // parents omitted on purpose
]

test('buildIndex creates source roots, implicit parents and ordered children (folders first)', () => {
  const index = buildIndex(entries)
  assert.deepEqual([...index.nodes.keys()].slice(0, 2), ['Pi', 'Claude'])
  assert.deepEqual(index.children.get('Pi')!.map(node => node.name), ['skills', 'archive.md', 'workflow.md'])
  assert.deepEqual(index.children.get('Pi/skills')!.map(node => node.id), ['Pi/skills/empty', 'Pi/skills/review.md'])
  assert.equal(index.nodes.get('Claude/orphan')?.kind, 'directory')
  assert.equal(index.nodes.get('Claude/orphan/deeper/note.md')?.parentId, 'Claude/orphan/deeper')
  assert.equal(index.nodes.get('Claude/orphan/deeper/note.md')?.depth, 3)
  // Same filename in both sources stays distinct.
  assert.notEqual(index.nodes.get('Pi/workflow.md'), index.nodes.get('Claude/workflow.md'))
})

test('visibleGraph reveals immediate children only, with one containment edge per child', () => {
  const index = buildIndex(entries)
  const initial = visibleGraph(index, new Set())
  assert.deepEqual(initial.nodes.map(node => node.id), ['Pi', 'Claude'])
  assert.deepEqual(initial.edges, [])

  const piOpen = visibleGraph(index, new Set(['Pi']))
  assert.deepEqual(piOpen.nodes.map(node => node.id), ['Pi', 'Pi/skills', 'Pi/archive.md', 'Pi/workflow.md', 'Claude'])
  assert.ok(piOpen.edges.every(edge => index.nodes.get(edge.childId)!.parentId === edge.parentId))
  assert.ok(!piOpen.nodes.some(node => node.id === 'Pi/skills/review.md'))

  const deep = visibleGraph(index, new Set(['Pi', 'Pi/skills']))
  assert.ok(deep.nodes.some(node => node.id === 'Pi/skills/review.md'))
  // Expansion state of hidden nodes is ignored until they are visible again.
  const hiddenChild = visibleGraph(index, new Set(['Pi/skills']))
  assert.deepEqual(hiddenChild.nodes.map(node => node.id), ['Pi', 'Claude'])
})

test('collapseNode clears descendants, revealFolder expands the ancestor chain, pruneIds drops stale ids', () => {
  const index = buildIndex(entries)
  const expanded = new Set(['Pi', 'Pi/skills', 'Pi/skills/empty', 'Claude'])
  const collapsed = collapseNode(index, expanded, 'Pi')
  assert.deepEqual([...collapsed], ['Claude'])

  const revealed = revealFolder(index, new Set(['Claude']), { source: 'Pi', path: 'skills/empty' })
  assert.deepEqual([...revealed].sort(), ['Claude', 'Pi', 'Pi/skills', 'Pi/skills/empty'])
  assert.deepEqual(ancestorIds(index.nodes.get('Pi/skills/empty')!), ['Pi', 'Pi/skills'])
  // Files are never expandable.
  assert.deepEqual([...revealFolder(index, new Set(), { source: 'Pi', path: 'workflow.md' })], [])

  const smaller = buildIndex(entries.filter(entry => !entry.path.startsWith('skills')))
  assert.deepEqual([...pruneIds(smaller, expanded)], ['Pi', 'Claude'])
  assert.equal(folderExists(smaller, { source: 'Pi', path: 'skills' }), false)
  assert.equal(folderExists(index, { source: 'Pi', path: 'skills' }), true)
  assert.equal(folderExists(index, { source: 'Pi', path: 'workflow.md' }), false)
  assert.equal(folderExists(index, null), true)
})

test('childCounts and describeCounts', () => {
  const index = buildIndex(entries)
  assert.deepEqual(childCounts(index, 'Pi'), { directories: 1, files: 2 })
  assert.equal(describeCounts(childCounts(index, 'Pi')), '1 folder, 2 Markdown files')
  assert.equal(describeCounts(childCounts(index, 'Pi/skills/empty')), 'This folder is empty.')
})

test('folder URLs encode every segment and round-trip awkward names', () => {
  const awkward = { source: 'Claude' as const, path: 'a b/c#d/e?f/g%h/100%' }
  const pathname = folderToPathname(awkward)
  assert.equal(pathname, '/Claude/a%20b/c%23d/e%3Ff/g%25h/100%25')
  assert.deepEqual(parsePathname(pathname), { kind: 'folder', ref: awkward })
  assert.deepEqual(parsePathname('/'), { kind: 'home' })
  assert.deepEqual(parsePathname('/Pi/'), { kind: 'folder', ref: { source: 'Pi', path: '' } })
  assert.deepEqual(parsePathname('/Nope/x'), { kind: 'unknown-source', name: 'Nope' })
  assert.deepEqual(parsePathname('/Pi/%E0%A4%A'), { kind: 'malformed' })
  assert.equal(folderToPathname(null), '/')
})

test('breadcrumbs start at Home and follow the source and directory segments', () => {
  assert.deepEqual(breadcrumbsFor(null).map(crumb => crumb.label), ['Home'])
  const crumbs = breadcrumbsFor({ source: 'Pi', path: 'skills/deep' })
  assert.deepEqual(crumbs.map(crumb => crumb.label), ['Home', 'Pi', 'skills', 'deep'])
  assert.deepEqual(crumbs.map(crumb => crumb.ref), [null, { source: 'Pi', path: '' }, { source: 'Pi', path: 'skills' }, { source: 'Pi', path: 'skills/deep' }])
})

test('a layout snapshot after pruning restores without retaining removed visible nodes', () => {
  const layout = new GraphLayout({ synchronous: true })
  try {
    const index = buildIndex([
      { source: 'Pi', path: 'removed.md', kind: 'file' },
      { source: 'Pi', path: 'kept.md', kind: 'file' },
    ])
    const graph = visibleGraph(index, new Set(['Pi']))
    layout.sync(graph.nodes, graph.edges)
    layout.pin('Pi/kept.md')
    const position = { x: layout.node('Pi/kept.md')!.x, y: layout.node('Pi/kept.md')!.y }
    layout.prune(new Set(['Pi', 'Claude', 'Pi/kept.md']))
    // In Outline mode there is no mounted graph to sync again before this snapshot.
    const snapshot = layout.snapshot()
    assert.doesNotThrow(() => layout.restore(snapshot))
    assert.ok(!snapshot.visibleIds.includes('Pi/removed.md'))
    assert.equal(layout.node('Pi/removed.md'), undefined)
    assert.equal(layout.isPinned('Pi/kept.md'), true)
    assert.deepEqual({ x: layout.node('Pi/kept.md')!.x, y: layout.node('Pi/kept.md')!.y }, position)
    const remaining = visibleGraph(buildIndex([{ source: 'Pi', path: 'kept.md', kind: 'file' }]), new Set(['Pi']))
    assert.doesNotThrow(() => layout.sync(remaining.nodes, remaining.edges))
    // Normalize a stale snapshot too, rather than relying only on snapshot() callers.
    snapshot.visibleIds.push('Pi/removed.md')
    snapshot.pinned.push('Pi/removed.md')
    assert.doesNotThrow(() => layout.restore(snapshot))
    assert.ok(!layout.snapshot().visibleIds.includes('Pi/removed.md'))
    assert.equal(layout.isPinned('Pi/removed.md'), false)
  } finally {
    layout.dispose()
  }
})

test('wrapLabel breaks long names at separators and truncates with an ellipsis', () => {
  assert.deepEqual(wrapLabel('review.md'), ['review.md'])
  assert.deepEqual(wrapLabel('release-notes-2026.md'), ['release-notes-', '2026.md'])
  const lines = wrapLabel('a'.repeat(60))
  assert.equal(lines.length, 3)
  assert.ok(lines[2].endsWith('…'))
})
