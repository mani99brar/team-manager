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

test('file URLs encode every segment individually and round-trip both sources', () => {
  const pi: FileRef = { source: 'Pi', path: 'skills/review.md' }
  assert.equal(fileToPathname(pi), '/file/Pi/skills/review.md')
  assert.deepEqual(parsePathname('/file/Pi/skills/review.md'), { kind: 'file', ref: pi })

  const claude: FileRef = { source: 'Claude', path: 'a b/c#d?%.md' }
  assert.equal(fileToPathname(claude), '/file/Claude/a%20b/c%23d%3F%25.md')
  assert.deepEqual(parsePathname(fileToPathname(claude)), { kind: 'file', ref: claude })

  const unicode: FileRef = { source: 'Claude', path: 'ünï 日本/nested/deeper/NOTE.MD' }
  assert.deepEqual(parsePathname(fileToPathname(unicode)), { kind: 'file', ref: unicode })

  // Same filename in both sources stays distinct.
  const piWorkflow: FileRef = { source: 'Pi', path: 'workflow.md' }
  const claudeWorkflow: FileRef = { source: 'Claude', path: 'workflow.md' }
  assert.notEqual(fileToPathname(piWorkflow), fileToPathname(claudeWorkflow))
  assert.equal(sameFileRef(piWorkflow, claudeWorkflow), false)
  assert.equal(sameFileRef(piWorkflow, { source: 'Pi', path: 'workflow.md' }), true)
  assert.equal(sameFileRef(null, null), true)
  assert.equal(sameFileRef(piWorkflow, null), false)
})

test('encoded-looking filenames are decoded exactly once', () => {
  const literal: FileRef = { source: 'Pi', path: '%2e%2e.md' }
  assert.equal(fileToPathname(literal), '/file/Pi/%252e%252e.md')
  assert.deepEqual(parsePathname('/file/Pi/%252e%252e.md'), { kind: 'file', ref: literal })
  // A single-encoded traversal segment is not a file link.
  assert.deepEqual(parsePathname('/file/Pi/%2e%2e'), { kind: 'malformed' })
  assert.deepEqual(parsePathname('/file/Pi/skills/%2E%2E/review.md'), { kind: 'malformed' })
  assert.deepEqual(parsePathname('/file/Pi/./review.md'), { kind: 'malformed' })
  // An encoded slash inside a segment would be ambiguous, so it is treated as malformed rather than split.
  assert.deepEqual(parsePathname('/file/Pi/skills%2Freview.md'), { kind: 'malformed' })
})

test('malformed encoding and incomplete file links are reported, not thrown', () => {
  assert.deepEqual(parsePathname('/file/Pi/%E0%A4%A'), { kind: 'malformed' })
  assert.deepEqual(parsePathname('/file/Pi/%'), { kind: 'malformed' })
  assert.deepEqual(parsePathname('/file'), { kind: 'malformed' })
  assert.deepEqual(parsePathname('/file/'), { kind: 'malformed' })
  assert.deepEqual(parsePathname('/file/Pi'), { kind: 'malformed' })
  assert.deepEqual(parsePathname('/file/Pi/'), { kind: 'malformed' })
  assert.deepEqual(parsePathname('/file/Nope/review.md'), { kind: 'unknown-source', name: 'Nope' })
  assert.deepEqual(parsePathname('/file/pi/review.md'), { kind: 'unknown-source', name: 'pi' })
})

test('existing folder routes are unchanged, including a folder literally named file', () => {
  assert.deepEqual(parsePathname('/'), { kind: 'home' })
  assert.deepEqual(parsePathname('/Pi'), { kind: 'folder', ref: { source: 'Pi', path: '' } })
  assert.deepEqual(parsePathname('/Pi/skills'), { kind: 'folder', ref: { source: 'Pi', path: 'skills' } })
  assert.deepEqual(parsePathname('/Pi/file/review.md'), { kind: 'folder', ref: { source: 'Pi', path: 'file/review.md' } })
  assert.deepEqual(parsePathname('/Claude/a%20b/c%23d'), { kind: 'folder', ref: { source: 'Claude', path: 'a b/c#d' } })
  assert.equal(folderToPathname({ source: 'Pi', path: 'file' }), '/Pi/file')
  assert.deepEqual(parsePathname('/Nope/x'), { kind: 'unknown-source', name: 'Nope' })
  assert.deepEqual(parsePathname('/Pi/%E0%A4%A'), { kind: 'malformed' })
})

test('parent folder derivation and file breadcrumbs', () => {
  assert.deepEqual(parentFolderOf({ source: 'Pi', path: 'skills/review.md' }), { source: 'Pi', path: 'skills' })
  assert.deepEqual(parentFolderOf({ source: 'Pi', path: 'workflow.md' }), { source: 'Pi', path: '' })
  assert.deepEqual(parentFolderOf({ source: 'Claude', path: 'a b/c/d.md' }), { source: 'Claude', path: 'a b/c' })

  const crumbs = breadcrumbsForFile({ source: 'Claude', path: 'subagents/deep/implementer.md' })
  assert.deepEqual(crumbs.map(crumb => crumb.label), ['Home', 'Claude', 'subagents', 'deep', 'implementer.md'])
  assert.deepEqual(crumbs.slice(0, -1).map(crumb => crumb.ref), [
    null,
    { source: 'Claude', path: '' },
    { source: 'Claude', path: 'subagents' },
    { source: 'Claude', path: 'subagents/deep' },
  ])
  // The filename is the current item and is not a folder navigation target.
  const last = crumbs[crumbs.length - 1]
  assert.equal(last.ref, undefined)
  assert.equal(last.id, 'Claude/subagents/deep/implementer.md')
  assert.deepEqual(breadcrumbsForFile({ source: 'Pi', path: 'workflow.md' }).map(crumb => crumb.label), ['Home', 'Pi', 'workflow.md'])
})
