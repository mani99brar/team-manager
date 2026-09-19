import { createApp } from './app.ts'

const app = createApp()
try {
  await app.listen({ port: 3001, host: '127.0.0.1' })
} catch (error) {
  app.log.error(error)
  process.exitCode = 1
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close() })
}
