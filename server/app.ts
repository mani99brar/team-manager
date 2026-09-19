import Fastify from 'fastify'
import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

export type MarkdownFile = { source: 'Pi' | 'Claude'; path: string }
export const fixtureRoot = fileURLToPath(new URL('../fixtures/', import.meta.url))

// Only regular files/directories are followed; symlinks cannot escape the fixtures.
export async function listMarkdownFiles(root = fixtureRoot): Promise<MarkdownFile[]> {
  const files: MarkdownFile[] = []
  async function walk(directory: string, source: MarkdownFile['source'], prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(join(directory, entry.name), source, path)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        files.push({ source, path })
      }
    }
  }
  await walk(join(root, 'pi'), 'Pi')
  await walk(join(root, 'claude'), 'Claude')
  return files
}

export function createApp(root = fixtureRoot) {
  const app = Fastify({ logger: true })
  app.get('/api/files', async (_request, reply) => {
    try {
      return { files: await listMarkdownFiles(root) }
    } catch (error) {
      app.log.error(error, 'Fixture listing failed')
      return reply.code(500).send({ error: 'Unable to list Markdown files. Check that both fixture folders are readable.' })
    }
  })
  return app
}
