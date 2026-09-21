import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ancestorIds,
  breadcrumbsFor,
  breadcrumbsForFile,
  buildIndex,
  childCounts,
  collapseNode,
  describeCounts,
  fileToPathname,
  folderExists,
  folderToPathname,
  locationOf,
  nodeId,
  parentFolderOf,
  parsePathname,
  pruneIds,
  revealFolder,
  visibleGraph,
  type Listing,
  type Location,
} from '../../src/graph/model.ts'
import { wrapLabel } from '../../src/graph/labels.ts'
import { GraphLayout } from '../../src/graph/layout.ts'

const locations: Location[] = [
  { id: 'pi-personal', source: 'Pi', label: 'Personal skills', category: 'personal', status: 'available', error: null },
  { id: 'pi-package', source: 'Pi', label: 'Package: demo', category: 'package', status: 'available', error: null },
  { id: 'pi-missing', source: 'Pi', label: 'Project: gone', category: 'project', status: 'unavailable', error: 'The configured folder does not exist.' },
  { id: 'claude-personal', source: 'Claude', label: 'Personal and synced skills', category: 'personal', status: 'available', error: null },
]

const listing: Listing = {
  locations,
  entries: [
    { source: 'Pi', locationId: 'pi-personal', path: 'skills', kind: 'directory' },
    { source: 'Pi', locationId: 'pi-personal', path: 'skills/review.md', kind: 'file' },
    { source: 'Pi', locationId: 'pi-personal', path: 'skills/empty', kind: 'directory' },
    { source: 'Pi', locationId: 'pi-personal', path: 'workflow.md', kind: 'file' },
    { source: 'Pi', locationId: 'pi-personal', path: 'archive.md', kind: 'file' },
    // The same relative path in a second location of the same source.
    { source: 'Pi', locationId: 'pi-package', path: 'skills', kind: 'directory' },
    { source: 'Pi', locationId: 'pi-package', path: 'skills/review.md', kind: 'file' },
    { source: 'Claude', locationId: 'claude-personal', path: 'workflow.md', kind: 'file' },
    { source: 'Claude', locationId: 'claude-personal', path: 'orphan/deeper/note.md', kind: 'file' }, // parents omitted on purpose
    // Entries for an unconfigured location are ignored rather than inventing a location.
    { source: 'Claude', locationId: 'ghost', path: 'x.md', kind: 'file' },
  ],
}

test('node ids are source, source/location and source/location/path', () => {
  assert.equal(nodeId('Pi', null, ''), 'Pi')
  assert.equal(nodeId('Pi', 'pi-personal', ''), 'Pi/pi-personal')
  assert.equal(nodeId('Pi', 'pi-personal', 'skills/review.md'), 'Pi/pi-personal/skills/review.md')
})

test('buildIndex creates source roots, location nodes in listing order, implicit parents and ordered children (folders first)', () => {
  const index = buildIndex(listing)
  assert.deepEqual([...index.nodes.keys()].slice(0, 2), ['Pi', 'Claude'])
  assert.deepEqual(index.children.get('Pi')!.map(node => node.id), ['Pi/pi-personal', 'Pi/pi-package', 'Pi/pi-missing'])
  const personal = index.nodes.get('Pi/pi-personal')!
  assert.equal(personal.kind, 'location')
  assert.equal(personal.name, 'Personal skills')
  assert.equal(personal.locationId, 'pi-personal')
  assert.equal(personal.path, '')
  assert.equal(personal.parentId, 'Pi')
  assert.equal(personal.depth, 1)
  assert.deepEqual(index.children.get('Pi/pi-personal')!.map(node => node.name), ['skills', 'archive.md', 'workflow.md'])
  assert.deepEqual(index.children.get('Pi/pi-personal/skills')!.map(node => node.id), ['Pi/pi-personal/skills/empty', 'Pi/pi-personal/skills/review.md'])
  // An unavailable location is a node with no children, never an empty folder.
  assert.equal(index.nodes.get('Pi/pi-missing')?.kind, 'location')
  assert.deepEqual(index.children.get('Pi/pi-missing') ?? [], [])
  assert.equal(locationOf(index, { source: 'Pi', locationId: 'pi-missing' })?.status, 'unavailable')
  assert.equal(locationOf(index, { source: 'Pi', locationId: 'claude-personal' }), undefined, 'a location belongs to one source')
  assert.equal(locationOf(index, { source: 'Claude', locationId: 'ghost' }), undefined)
  assert.equal(index.nodes.get('Claude/ghost'), undefined)
  assert.equal(index.nodes.get('Claude/ghost/x.md'), undefined)
  // Implicit parents.
  assert.equal(index.nodes.get('Claude/claude-personal/orphan')?.kind, 'directory')
  assert.equal(index.nodes.get('Claude/claude-personal/orphan/deeper/note.md')?.parentId, 'Claude/claude-personal/orphan/deeper')
  assert.equal(index.nodes.get('Claude/claude-personal/orphan/deeper/note.md')?.depth, 4)
  // The same relative path in two locations stays distinct, and so does the same filename in two sources.
  assert.notEqual(index.nodes.get('Pi/pi-personal/skills/review.md'), index.nodes.get('Pi/pi-package/skills/review.md'))
  assert.equal(index.nodes.get('Pi/pi-package/skills/review.md')?.locationId, 'pi-package')
  assert.notEqual(index.nodes.get('Pi/pi-personal/workflow.md'), index.nodes.get('Claude/claude-personal/workflow.md'))
})

test('visibleGraph reveals immediate children only, with one containment edge per child', () => {
  const index = buildIndex(listing)
  const initial = visibleGraph(index, new Set())
  assert.deepEqual(initial.nodes.map(node => node.id), ['Pi', 'Claude'])
  assert.deepEqual(initial.edges, [])

  const piOpen = visibleGraph(index, new Set(['Pi']))
  assert.deepEqual(piOpen.nodes.map(node => node.id), ['Pi', 'Pi/pi-personal', 'Pi/pi-package', 'Pi/pi-missing', 'Claude'])
  assert.ok(piOpen.edges.every(edge => index.nodes.get(edge.childId)!.parentId === edge.parentId))

  const deep = visibleGraph(index, new Set(['Pi', 'Pi/pi-personal', 'Pi/pi-personal/skills']))
  assert.deepEqual(deep.nodes.map(node => node.id), [
    'Pi', 'Pi/pi-personal', 'Pi/pi-personal/skills', 'Pi/pi-personal/skills/empty', 'Pi/pi-personal/skills/review.md',
    'Pi/pi-personal/archive.md', 'Pi/pi-personal/workflow.md', 'Pi/pi-package', 'Pi/pi-missing', 'Claude',
  ])
  // Expansion state of hidden nodes is ignored until they are visible again.
  const hiddenChild = visibleGraph(index, new Set(['Pi/pi-personal']))
  assert.deepEqual(hiddenChild.nodes.map(node => node.id), ['Pi', 'Claude'])
})

test('collapseNode clears descendants, revealFolder expands the ancestor chain, pruneIds drops stale ids', () => {
  const index = buildIndex(listing)
  const expanded = new Set(['Pi', 'Pi/pi-personal', 'Pi/pi-personal/skills', 'Pi/pi-personal/skills/empty', 'Claude'])
  const collapsed = collapseNode(index, expanded, 'Pi')
  assert.deepEqual([...collapsed], ['Claude'])

  const revealed = revealFolder(index, new Set(['Claude']), { source: 'Pi', locationId: 'pi-personal', path: 'skills/empty' })
  assert.deepEqual([...revealed].sort(), ['Claude', 'Pi', 'Pi/pi-personal', 'Pi/pi-personal/skills', 'Pi/pi-personal/skills/empty'])
  assert.deepEqual(ancestorIds(index.nodes.get('Pi/pi-personal/skills/empty')!), ['Pi', 'Pi/pi-personal', 'Pi/pi-personal/skills'])
  assert.deepEqual(ancestorIds(index.nodes.get('Pi/pi-personal')!), ['Pi'])
  // Revealing a location expands the source and the location; revealing a source expands only the source.
  assert.deepEqual([...revealFolder(index, new Set(), { source: 'Pi', locationId: 'pi-package', path: '' })].sort(), ['Pi', 'Pi/pi-package'])
  assert.deepEqual([...revealFolder(index, new Set(), { source: 'Claude', locationId: null, path: '' })], ['Claude'])
  // Files are never expandable.
  assert.deepEqual([...revealFolder(index, new Set(), { source: 'Pi', locationId: 'pi-personal', path: 'workflow.md' })], [])

  const smaller = buildIndex({ locations, entries: listing.entries.filter(entry => !entry.path.startsWith('skills')) })
  assert.deepEqual([...pruneIds(smaller, expanded)], ['Pi', 'Pi/pi-personal', 'Claude'])
  assert.equal(folderExists(smaller, { source: 'Pi', locationId: 'pi-personal', path: 'skills' }), false)
  assert.equal(folderExists(index, { source: 'Pi', locationId: 'pi-personal', path: 'skills' }), true)
  assert.equal(folderExists(index, { source: 'Pi', locationId: 'pi-personal', path: 'workflow.md' }), false)
  assert.equal(folderExists(index, { source: 'Pi', locationId: 'pi-missing', path: '' }), true, 'an unavailable location still exists')
  assert.equal(folderExists(index, { source: 'Pi', locationId: 'pi-missing', path: 'anything' }), false)
  assert.equal(folderExists(index, { source: 'Pi', locationId: 'nope', path: '' }), false)
  assert.equal(folderExists(index, { source: 'Pi', locationId: null, path: '' }), true)
  assert.equal(folderExists(index, null), true)
})

test('childCounts and describeCounts distinguish locations from folders and files', () => {
  const index = buildIndex(listing)
  assert.deepEqual(childCounts(index, 'Pi'), { locations: 3, directories: 0, files: 0 })
  assert.equal(describeCounts(childCounts(index, 'Pi'), 'source'), '3 locations')
  assert.equal(describeCounts({ locations: 1, directories: 0, files: 0 }, 'source'), '1 location')
  assert.equal(describeCounts({ locations: 0, directories: 0, files: 0 }, 'source'), 'No locations are configured for this source.')
  assert.deepEqual(childCounts(index, 'Pi/pi-personal'), { locations: 0, directories: 1, files: 2 })
  assert.equal(describeCounts(childCounts(index, 'Pi/pi-personal'), 'location'), '1 folder, 2 Markdown files')
  assert.equal(describeCounts(childCounts(index, 'Pi/pi-personal/skills/empty'), 'directory'), 'This folder is empty.')
  assert.equal(describeCounts(childCounts(index, 'Pi/pi-package'), 'location'), '1 folder, 0 Markdown files')
})

test('parentFolderOf a top-level file is its location root', () => {
  assert.deepEqual(parentFolderOf({ source: 'Pi', locationId: 'pi-personal', path: 'workflow.md' }), { source: 'Pi', locationId: 'pi-personal', path: '' })
  assert.deepEqual(parentFolderOf({ source: 'Pi', locationId: 'pi-personal', path: 'skills/review.md' }), { source: 'Pi', locationId: 'pi-personal', path: 'skills' })
})

test('browse URLs encode every segment and round-trip awkward names; the location id is its own segment', () => {
  const awkward = { source: 'Claude' as const, locationId: 'claude-personal', path: 'a b/c#d/e?f/g%h/100%' }
  const pathname = folderToPathname(awkward)
  assert.equal(pathname, '/browse/Claude/claude-personal/a%20b/c%23d/e%3Ff/g%25h/100%25')
  assert.deepEqual(parsePathname(pathname), { kind: 'folder', ref: awkward })
  assert.equal(folderToPathname(null), '/')
  assert.equal(folderToPathname({ source: 'Pi', locationId: null, path: '' }), '/browse/Pi')
  assert.equal(folderToPathname({ source: 'Pi', locationId: 'pi-personal', path: '' }), '/browse/Pi/pi-personal')
  assert.deepEqual(parsePathname('/'), { kind: 'home' })
  assert.deepEqual(parsePathname('/browse'), { kind: 'home' })
  assert.deepEqual(parsePathname('/browse/Pi/'), { kind: 'folder', ref: { source: 'Pi', locationId: null, path: '' } })
  assert.deepEqual(parsePathname('/browse/Pi/pi-personal'), { kind: 'folder', ref: { source: 'Pi', locationId: 'pi-personal', path: '' } })
  assert.deepEqual(parsePathname('/browse/Nope/x'), { kind: 'unknown-source', name: 'Nope' })
  assert.deepEqual(parsePathname('/browse/Pi/pi-personal/%E0%A4%A'), { kind: 'malformed' })
  assert.deepEqual(parsePathname('/browse/Pi/..%2F/x'), { kind: 'malformed' })
  assert.deepEqual(parsePathname('/browse/Pi/pi-personal/..'), { kind: 'malformed' })
  assert.deepEqual(parsePathname('/browse/Pi/not%20an%20id'), { kind: 'malformed' })
})

test('file URLs carry the location and decode each segment once', () => {
  const ref = { source: 'Claude' as const, locationId: 'claude-personal', path: 'a b/c#d?e%f.md' }
  assert.equal(fileToPathname(ref), '/file/Claude/claude-personal/a%20b/c%23d%3Fe%25f.md')
  assert.deepEqual(parsePathname(fileToPathname(ref)), { kind: 'file', ref })
  assert.deepEqual(parsePathname('/file/Pi/pi-personal/%252e%252e.md'), { kind: 'file', ref: { source: 'Pi', locationId: 'pi-personal', path: '%2e%2e.md' } })
  assert.deepEqual(parsePathname('/file/Pi/pi-personal/a/../b.md'), { kind: 'malformed' })
  assert.deepEqual(parsePathname('/file/Pi/pi-personal/'), { kind: 'malformed' })
  assert.deepEqual(parsePathname('/file/Pi'), { kind: 'malformed' })
  assert.deepEqual(parsePathname('/file'), { kind: 'malformed' })
  assert.deepEqual(parsePathname('/file/Nope/loc/x.md'), { kind: 'unknown-source', name: 'Nope' })
  assert.deepEqual(parsePathname('/file/Pi/pi-personal/%E0%A4%A'), { kind: 'malformed' })
})

test('old fixture-layout links are recognised as legacy and never resolved to a live location', () => {
  assert.deepEqual(parsePathname('/Pi'), { kind: 'legacy', source: 'Pi', pathname: '/Pi' })
  assert.deepEqual(parsePathname('/Claude/subagents'), { kind: 'legacy', source: 'Claude', pathname: '/Claude/subagents' })
  assert.deepEqual(parsePathname('/file/Pi/workflow.md'), { kind: 'legacy', source: 'Pi', pathname: '/file/Pi/workflow.md' })
  // An old nested document link parses structurally as a file in a location named after the old folder;
  // the app reports that location as unconfigured instead of guessing.
  assert.deepEqual(parsePathname('/file/Pi/skills/review.md'), { kind: 'file', ref: { source: 'Pi', locationId: 'skills', path: 'review.md' } })
  assert.deepEqual(parsePathname('/Nope/anything'), { kind: 'unknown-source', name: 'Nope' })
})

test('breadcrumbs go Home, source, location label, then one crumb per directory segment', () => {
  const index = buildIndex(listing)
  assert.deepEqual(breadcrumbsFor(null, index).map(crumb => crumb.label), ['Home'])
  assert.deepEqual(breadcrumbsFor({ source: 'Pi', locationId: null, path: '' }, index).map(crumb => crumb.label), ['Home', 'Pi'])
  const crumbs = breadcrumbsFor({ source: 'Pi', locationId: 'pi-personal', path: 'skills/deep' }, index)
  assert.deepEqual(crumbs.map(crumb => crumb.label), ['Home', 'Pi', 'Personal skills', 'skills', 'deep'])
  assert.deepEqual(crumbs.map(crumb => crumb.ref), [
    null,
    { source: 'Pi', locationId: null, path: '' },
    { source: 'Pi', locationId: 'pi-personal', path: '' },
    { source: 'Pi', locationId: 'pi-personal', path: 'skills' },
    { source: 'Pi', locationId: 'pi-personal', path: 'skills/deep' },
  ])
  assert.deepEqual(crumbs.map(crumb => crumb.id), ['home', 'Pi', 'Pi/pi-personal', 'Pi/pi-personal/skills', 'Pi/pi-personal/skills/deep'])
  // Without a listing (or for an unconfigured location) the id stands in for the label.
  assert.deepEqual(breadcrumbsFor({ source: 'Pi', locationId: 'pi-personal', path: '' }, null).map(crumb => crumb.label), ['Home', 'Pi', 'pi-personal'])
  assert.deepEqual(breadcrumbsFor({ source: 'Pi', locationId: 'skills', path: '' }, index).map(crumb => crumb.label), ['Home', 'Pi', 'skills'])
  const file = breadcrumbsForFile({ source: 'Claude', locationId: 'claude-personal', path: 'orphan/note.md' }, index)
  assert.deepEqual(file.map(crumb => crumb.label), ['Home', 'Claude', 'Personal and synced skills', 'orphan', 'note.md'])
  assert.equal(file[file.length - 1].ref, undefined, 'the file itself is not a link')
})

test('a layout snapshot after pruning restores without retaining removed visible nodes', () => {
  const layout = new GraphLayout({ synchronous: true })
  try {
    const index = buildIndex({
      locations: locations.slice(0, 1),
      entries: [
        { source: 'Pi', locationId: 'pi-personal', path: 'removed.md', kind: 'file' },
        { source: 'Pi', locationId: 'pi-personal', path: 'kept.md', kind: 'file' },
      ],
    })
    const graph = visibleGraph(index, new Set(['Pi', 'Pi/pi-personal']))
    layout.sync(graph.nodes, graph.edges)
    layout.pin('Pi/pi-personal/kept.md')
    const position = { x: layout.node('Pi/pi-personal/kept.md')!.x, y: layout.node('Pi/pi-personal/kept.md')!.y }
    layout.prune(new Set(['Pi', 'Claude', 'Pi/pi-personal', 'Pi/pi-personal/kept.md']))
    // In Outline mode there is no mounted graph to sync again before this snapshot.
    const snapshot = layout.snapshot()
    assert.doesNotThrow(() => layout.restore(snapshot))
    assert.ok(!snapshot.visibleIds.includes('Pi/pi-personal/removed.md'))
    assert.equal(layout.node('Pi/pi-personal/removed.md'), undefined)
    assert.equal(layout.isPinned('Pi/pi-personal/kept.md'), true)
    assert.deepEqual({ x: layout.node('Pi/pi-personal/kept.md')!.x, y: layout.node('Pi/pi-personal/kept.md')!.y }, position)
    const remaining = visibleGraph(buildIndex({ locations: locations.slice(0, 1), entries: [{ source: 'Pi', locationId: 'pi-personal', path: 'kept.md', kind: 'file' }] }), new Set(['Pi', 'Pi/pi-personal']))
    assert.doesNotThrow(() => layout.sync(remaining.nodes, remaining.edges))
    // Normalize a stale snapshot too, rather than relying only on snapshot() callers.
    snapshot.visibleIds.push('Pi/pi-personal/removed.md')
    snapshot.pinned.push('Pi/pi-personal/removed.md')
    assert.doesNotThrow(() => layout.restore(snapshot))
    assert.ok(!layout.snapshot().visibleIds.includes('Pi/pi-personal/removed.md'))
    assert.equal(layout.isPinned('Pi/pi-personal/removed.md'), false)
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
