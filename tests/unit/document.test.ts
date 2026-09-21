import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  breadcrumbsForFile,
  fileToPathname,
  folderToPathname,
  parentFolderOf,
  parsePathname,
  sameFileRef,
  type FileRef,
} from '../../src/graph/model.ts'

const PERSONAL = 'pi-personal'
const CLAUDE = 'claude-personal'

test('file URLs encode every segment individually and round-trip both sources and locations', () => {
  const pi: FileRef = { source: 'Pi', locationId: PERSONAL, path: 'skills/review.md' }
  assert.equal(fileToPathname(pi), '/file/Pi/pi-personal/skills/review.md')
  assert.deepEqual(parsePathname('/file/Pi/pi-personal/skills/review.md'), { kind: 'file', ref: pi })

  const claude: FileRef = { source: 'Claude', locationId: CLAUDE, path: 'a b/c#d?%.md' }
  assert.equal(fileToPathname(claude), '/file/Claude/claude-personal/a%20b/c%23d%3F%25.md')
  assert.deepEqual(parsePathname(fileToPathname(claude)), { kind: 'file', ref: claude })

  const unicode: FileRef = { source: 'Claude', locationId: CLAUDE, path: 'ünï 日本/nested/deeper/NOTE.MD' }
  assert.deepEqual(parsePathname(fileToPathname(unicode)), { kind: 'file', ref: unicode })

  // Same filename in both sources, and the same relative path in two locations, stay distinct.
  const piWorkflow: FileRef = { source: 'Pi', locationId: PERSONAL, path: 'workflow.md' }
  const claudeWorkflow: FileRef = { source: 'Claude', locationId: CLAUDE, path: 'workflow.md' }
  const packageWorkflow: FileRef = { source: 'Pi', locationId: 'pi-package', path: 'workflow.md' }
  assert.notEqual(fileToPathname(piWorkflow), fileToPathname(claudeWorkflow))
  assert.notEqual(fileToPathname(piWorkflow), fileToPathname(packageWorkflow))
  assert.equal(sameFileRef(piWorkflow, claudeWorkflow), false)
  assert.equal(sameFileRef(piWorkflow, packageWorkflow), false)
  assert.equal(sameFileRef(piWorkflow, { source: 'Pi', locationId: PERSONAL, path: 'workflow.md' }), true)
  assert.equal(sameFileRef(null, null), true)
  assert.equal(sameFileRef(piWorkflow, null), false)
})

test('encoded-looking filenames are decoded exactly once', () => {
  const literal: FileRef = { source: 'Pi', locationId: PERSONAL, path: '%2e%2e.md' }
  assert.equal(fileToPathname(literal), '/file/Pi/pi-personal/%252e%252e.md')
  assert.deepEqual(parsePathname('/file/Pi/pi-personal/%252e%252e.md'), { kind: 'file', ref: literal })
  // A single-encoded traversal segment is not a file link.
  assert.deepEqual(parsePathname('/file/Pi/pi-personal/%2e%2e'), { kind: 'malformed' })
  assert.deepEqual(parsePathname('/file/Pi/pi-personal/skills/%2E%2E/review.md'), { kind: 'malformed' })
  assert.deepEqual(parsePathname('/file/Pi/pi-personal/./review.md'), { kind: 'malformed' })
  // An encoded slash inside a segment would be ambiguous, so it is treated as malformed rather than split.
  assert.deepEqual(parsePathname('/file/Pi/pi-personal/skills%2Freview.md'), { kind: 'malformed' })
  assert.deepEqual(parsePathname('/file/Pi/pi%2Fpersonal/review.md'), { kind: 'malformed' })
})

test('malformed encoding and incomplete file links are reported, not thrown', () => {
  assert.deepEqual(parsePathname('/file/Pi/pi-personal/%E0%A4%A'), { kind: 'malformed' })
  assert.deepEqual(parsePathname('/file/Pi/pi-personal/%'), { kind: 'malformed' })
  assert.deepEqual(parsePathname('/file'), { kind: 'malformed' })
  assert.deepEqual(parsePathname('/file/'), { kind: 'malformed' })
  assert.deepEqual(parsePathname('/file/Pi'), { kind: 'malformed' })
  assert.deepEqual(parsePathname('/file/Pi/'), { kind: 'malformed' })
  assert.deepEqual(parsePathname('/file/Pi/pi-personal'), { kind: 'malformed' })
  assert.deepEqual(parsePathname('/file/Pi/pi-personal/'), { kind: 'malformed' })
  assert.deepEqual(parsePathname('/file/Nope/pi-personal/review.md'), { kind: 'unknown-source', name: 'Nope' })
  assert.deepEqual(parsePathname('/file/pi/pi-personal/review.md'), { kind: 'unknown-source', name: 'pi' })
})

test('browse routes carry the location, including a folder literally named file or browse', () => {
  assert.deepEqual(parsePathname('/'), { kind: 'home' })
  assert.deepEqual(parsePathname('/browse/Pi'), { kind: 'folder', ref: { source: 'Pi', locationId: null, path: '' } })
  assert.deepEqual(parsePathname('/browse/Pi/pi-personal'), { kind: 'folder', ref: { source: 'Pi', locationId: PERSONAL, path: '' } })
  assert.deepEqual(parsePathname('/browse/Pi/pi-personal/skills'), { kind: 'folder', ref: { source: 'Pi', locationId: PERSONAL, path: 'skills' } })
  assert.deepEqual(parsePathname('/browse/Pi/pi-personal/file/review.md'), { kind: 'folder', ref: { source: 'Pi', locationId: PERSONAL, path: 'file/review.md' } })
  assert.deepEqual(parsePathname('/browse/Pi/pi-personal/browse'), { kind: 'folder', ref: { source: 'Pi', locationId: PERSONAL, path: 'browse' } })
  assert.deepEqual(parsePathname('/browse/Claude/claude-personal/a%20b/c%23d'), { kind: 'folder', ref: { source: 'Claude', locationId: CLAUDE, path: 'a b/c#d' } })
  assert.equal(folderToPathname({ source: 'Pi', locationId: PERSONAL, path: 'file' }), '/browse/Pi/pi-personal/file')
  assert.deepEqual(parsePathname('/browse/Nope/x'), { kind: 'unknown-source', name: 'Nope' })
  assert.deepEqual(parsePathname('/browse/Pi/pi-personal/%E0%A4%A'), { kind: 'malformed' })
})

test('parent folder derivation and file breadcrumbs without a loaded listing', () => {
  assert.deepEqual(parentFolderOf({ source: 'Pi', locationId: PERSONAL, path: 'skills/review.md' }), { source: 'Pi', locationId: PERSONAL, path: 'skills' })
  assert.deepEqual(parentFolderOf({ source: 'Pi', locationId: PERSONAL, path: 'workflow.md' }), { source: 'Pi', locationId: PERSONAL, path: '' })
  assert.deepEqual(parentFolderOf({ source: 'Claude', locationId: CLAUDE, path: 'a b/c/d.md' }), { source: 'Claude', locationId: CLAUDE, path: 'a b/c' })

  const crumbs = breadcrumbsForFile({ source: 'Claude', locationId: CLAUDE, path: 'subagents/deep/implementer.md' }, null)
  assert.deepEqual(crumbs.map(crumb => crumb.label), ['Home', 'Claude', CLAUDE, 'subagents', 'deep', 'implementer.md'])
  assert.deepEqual(crumbs.slice(0, -1).map(crumb => crumb.ref), [
    null,
    { source: 'Claude', locationId: null, path: '' },
    { source: 'Claude', locationId: CLAUDE, path: '' },
    { source: 'Claude', locationId: CLAUDE, path: 'subagents' },
    { source: 'Claude', locationId: CLAUDE, path: 'subagents/deep' },
  ])
  // The filename is the current item and is not a folder navigation target.
  const last = crumbs[crumbs.length - 1]
  assert.equal(last.ref, undefined)
  assert.equal(last.id, 'Claude/claude-personal/subagents/deep/implementer.md')
  assert.deepEqual(breadcrumbsForFile({ source: 'Pi', locationId: PERSONAL, path: 'workflow.md' }, null).map(crumb => crumb.label), ['Home', 'Pi', PERSONAL, 'workflow.md'])
})
