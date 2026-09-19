import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { listMarkdownFiles } from './files.ts'

const fixturesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
)

describe('listMarkdownFiles', () => {
  it('lists every Markdown fixture with its source and relative path', async () => {
    const files = await listMarkdownFiles([
      { source: 'pi', dir: path.join(fixturesDir, 'pi') },
      { source: 'claude', dir: path.join(fixturesDir, 'claude') },
    ])

    expect(files).toEqual([
      { source: 'claude', path: 'empty.md' },
      { source: 'claude', path: 'subagents/implementer.md' },
      { source: 'claude', path: 'workflow.md' },
      { source: 'pi', path: 'skills/review.md' },
      { source: 'pi', path: 'workflow.md' },
    ])
  })

  it('excludes non-Markdown files', async () => {
    const files = await listMarkdownFiles([
      { source: 'pi', dir: path.join(fixturesDir, 'pi') },
    ])
    expect(files.map((f) => f.path)).not.toContain('notes.txt')
  })

  it('returns an empty list for a folder with no Markdown files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'md-manager-'))
    await mkdir(path.join(dir, 'nested'))
    await writeFile(path.join(dir, 'nested', 'readme.txt'), 'not markdown')

    const files = await listMarkdownFiles([{ source: 'pi', dir }])
    expect(files).toEqual([])
  })

  it('rejects when a source folder does not exist', async () => {
    await expect(
      listMarkdownFiles([{ source: 'pi', dir: path.join(fixturesDir, 'nope') }]),
    ).rejects.toThrow()
  })
})
