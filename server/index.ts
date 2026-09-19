import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { listMarkdownFiles, type SourceRoot } from './files.ts'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixturesDir = path.join(projectRoot, 'fixtures')
const distDir = path.join(projectRoot, 'dist')

export const roots: SourceRoot[] = [
  { source: 'pi', dir: path.join(fixturesDir, 'pi') },
  { source: 'claude', dir: path.join(fixturesDir, 'claude') },
]

const app = Fastify({ logger: true })

app.get('/api/files', async () => {
  const files = await listMarkdownFiles(roots)
  return { files }
})

if (existsSync(distDir)) {
  await app.register(fastifyStatic, { root: distDir })
}

const port = Number(process.env.API_PORT ?? 3001)
await app.listen({ port, host: '127.0.0.1' })
