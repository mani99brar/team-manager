import { readdir } from 'node:fs/promises'
import path from 'node:path'

export type Source = 'pi' | 'claude'

export interface MarkdownFile {
  source: Source
  path: string
}

export interface SourceRoot {
  source: Source
  dir: string
}

async function walk(dir: string, relative: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const found: string[] = []
  for (const entry of entries) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      found.push(...(await walk(path.join(dir, entry.name), rel)))
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      found.push(rel)
    }
  }
  return found
}

export async function listMarkdownFiles(
  roots: SourceRoot[],
): Promise<MarkdownFile[]> {
  const files: MarkdownFile[] = []
  for (const root of roots) {
    const paths = await walk(root.dir, '')
    for (const p of paths) files.push({ source: root.source, path: p })
  }
  return files.sort(
    (a, b) =>
      a.source.localeCompare(b.source) || a.path.localeCompare(b.path),
  )
}
