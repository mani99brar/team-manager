import { createApp, type LocationStatus } from './app.ts'
import { ConfigError, loadConfig, type AppConfig } from './config.ts'
import { ProjectsConfigError, loadProjectsConfig, type LoadedProjectsConfig } from './projectsConfig.ts'

// Configuration is read once, before anything listens. A missing or invalid config is a startup failure
// with a local diagnostic (which may name configured paths); there is no fallback to the fixtures.
let config: AppConfig
try {
  config = await loadConfig(process.env)
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`md-manager: ${error.message}`)
    process.exit(1)
  }
  throw error
}

// The project registry is optional and independent of the skills configuration: unset means an empty Projects
// root, while an explicitly named file that is missing or invalid is a startup failure (no demo data is substituted).
let projects: LoadedProjectsConfig
try {
  projects = await loadProjectsConfig(process.env)
} catch (error) {
  if (error instanceof ProjectsConfigError) {
    console.error(`md-manager: ${error.message}`)
    process.exit(1)
  }
  throw error
}

const app = createApp(config.locations, { projects })
try {
  await app.listen({ port: Number(process.env.MD_MANAGER_API_PORT ?? 3001), host: '127.0.0.1' })
  app.log.info({ mode: config.mode, configPath: config.configPath ?? null, locations: config.locations.length }, 'Configuration loaded')
  app.log.info({ configPath: projects.configPath, projects: projects.projects.length, workflows: projects.projects.reduce((count, project) => count + project.workflows.length, 0) }, 'Project registry loaded')
  // Per-location startup status: unavailable locations are a warning, never a startup failure.
  const { locations } = (await app.inject('/api/entries')).json() as { locations: LocationStatus[] }
  for (const status of locations) {
    const configured = config.locations.find(location => location.id === status.id)
    const details = { id: status.id, source: status.source, category: status.category, path: configured?.path }
    if (status.status === 'available') app.log.info(details, 'Location available')
    else app.log.warn({ ...details, error: status.error }, 'Location unavailable')
  }
} catch (error) {
  app.log.error(error)
  process.exitCode = 1
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close() })
}
