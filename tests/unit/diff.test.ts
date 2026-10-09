/**
 * The review diff parser (src/projects/diff.ts, docs/PRD_VIEWER_REFINE.md 5.6): files, added/removed counts, hunks with
 * line numbers, a GIT binary patch as a stat with no hunks, and the 2,000-line rule. Pure, so the renderer and this test
 * read the same model.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDiff, diffTotals, MAX_DIFF_LINES, fetchDiffText } from '../../src/projects/diff.ts'
import type { RunScope } from '../../src/projects/api.ts'

const PATCH = [
  'diff --git a/src/projects/WorkflowGraph.tsx b/src/projects/WorkflowGraph.tsx',
  'index 1111111..2222222 100644',
  '--- a/src/projects/WorkflowGraph.tsx',
  '+++ b/src/projects/WorkflowGraph.tsx',
  '@@ -10,4 +10,5 @@ export function WorkflowGraph() {',
  '   const layout = useMemo()',
  '-  const old = 1',
  '+  const next = 2',
  '+  const added = 3',
  '   return layout',
  'diff --git a/tests/unit/dag.test.ts b/tests/unit/dag.test.ts',
  '--- a/tests/unit/dag.test.ts',
  '+++ b/tests/unit/dag.test.ts',
  '@@ -1,2 +1,2 @@',
  '-import { old } from "./old.ts"',
  '+import { next } from "./next.ts"',
  ' // unchanged',
  '',
].join('\n')

describe('parseDiff', () => {
  test('reads every file with its path', () => {
    const files = parseDiff(PATCH)
    assert.equal(files.length, 2)
    assert.equal(files[0].path, 'src/projects/WorkflowGraph.tsx')
    assert.equal(files[1].path, 'tests/unit/dag.test.ts')
  })

  test('counts added and removed per file and in total', () => {
    const files = parseDiff(PATCH)
    assert.equal(files[0].added, 2)
    assert.equal(files[0].removed, 1)
    assert.equal(files[1].added, 1)
    assert.equal(files[1].removed, 1)
    assert.deepEqual(diffTotals(files), { files: 2, added: 3, removed: 2 })
  })

  test('keeps hunks with old and new line numbers in add, remove and context tones', () => {
    const [file] = parseDiff(PATCH)
    assert.equal(file.hunks.length, 1)
    const hunk = file.hunks[0]
    assert.equal(hunk.oldStart, 10)
    assert.equal(hunk.newStart, 10)
    const kinds = hunk.lines.map(line => line.kind)
    assert.deepEqual(kinds, ['context', 'remove', 'add', 'add', 'context'])
    // Context line advances both sides; a remove advances only old, an add only new.
    const context = hunk.lines[0]
    assert.equal(context.oldLine, 10)
    assert.equal(context.newLine, 10)
    const remove = hunk.lines[1]
    assert.equal(remove.oldLine, 11)
    assert.equal(remove.newLine, null)
    const firstAdd = hunk.lines[2]
    assert.equal(firstAdd.oldLine, null)
    assert.equal(firstAdd.newLine, 11)
    // The trailing context resumes from the lines each side has consumed.
    const trailing = hunk.lines[4]
    assert.equal(trailing.oldLine, 12)
    assert.equal(trailing.newLine, 13)
  })

  test('a GIT binary patch is a stat with no hunks', () => {
    const binary = parseDiff([
      'diff --git a/public/logo.png b/public/logo.png',
      'index 3333333..4444444 100644',
      'GIT binary patch',
      'literal 1024',
      'zcmZ...',
      '',
    ].join('\n'))
    assert.equal(binary.length, 1)
    assert.equal(binary[0].binary, true)
    assert.equal(binary[0].hunks.length, 0)
    assert.equal(binary[0].added, 0)
    assert.equal(binary[0].removed, 0)
  })

  test('the 2,000-line rule: lineCount lets the renderer stat a very large file', () => {
    const header = ['diff --git a/big.txt b/big.txt', '--- a/big.txt', '+++ b/big.txt', `@@ -1,${MAX_DIFF_LINES + 10} +1,${MAX_DIFF_LINES + 10} @@`]
    const body = Array.from({ length: MAX_DIFF_LINES + 10 }, (_unused, index) => `+line ${index}`)
    const [file] = parseDiff([...header, ...body, ''].join('\n'))
    assert.ok(file.lineCount > MAX_DIFF_LINES, 'a file past the limit is detectable by its line count')
    const [small] = parseDiff(PATCH)
    assert.ok(small.lineCount <= MAX_DIFF_LINES)
  })

  test('a rename records where the file came from', () => {
    const [file] = parseDiff([
      'diff --git a/old/name.ts b/new/name.ts',
      'similarity index 95%',
      'rename from old/name.ts',
      'rename to new/name.ts',
      '--- a/old/name.ts',
      '+++ b/new/name.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '',
    ].join('\n'))
    assert.equal(file.path, 'new/name.ts')
    assert.equal(file.renamedFrom, 'old/name.ts')
  })

  test('ignores unrecognised text rather than throwing', () => {
    assert.deepEqual(parseDiff(''), [])
    assert.doesNotThrow(() => parseDiff('not a diff at all\njust prose\n'))
  })
})

describe('fetchDiffText', () => {
  const scope: RunScope = { projectId: 'p', workflowId: 'w', runId: 'r' }
  // The fallback (no stream reader) path exercises the `limit` argument the over-limit "show it anyway" button drops.
  const stub = (text: string) => {
    const previous = globalThis.fetch
    globalThis.fetch = (async () => ({ ok: true, status: 200, body: null, text: async () => text })) as unknown as typeof fetch
    return () => { globalThis.fetch = previous }
  }

  test('a body past the given limit reports overLimit and no text; the same body under the limit reads whole', async () => {
    const restore = stub('x'.repeat(100))
    try {
      const over = await fetchDiffText(scope, 'review.diff', undefined, 10)
      assert.equal(over.overLimit, true)
      assert.equal(over.text, '')
      const whole = await fetchDiffText(scope, 'review.diff', undefined, Infinity)
      assert.equal(whole.overLimit, false)
      assert.equal(whole.text.length, 100)
    } finally {
      restore()
    }
  })
})
