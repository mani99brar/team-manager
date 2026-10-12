import { createApp, type LocationStatus } from './app.ts'
import { loadControlsConfig } from './controlsGuard.ts'
import { ConfigError, loadConfig, type AppConfig } from './config.ts'
import { ProjectsConfigError, loadProjectsConfig, projectsConfigReloader, type LoadedProjectsConfig } from './projectsConfig.ts'
import { realGitRunner } from './dispatchGit.ts'
import { GithubReader, githubReaderOptions } from './dispatchGithub.ts'

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
// Afterwards it is re-read whenever the file changes, since launches register workflows while the viewer runs.
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

// Run controls are off unless the whole environment of PRD Appendix A.3 is valid (decisions.md [L5]); a failed condition is a warning, never a startup failure.
const controls = await loadControlsConfig(process.env)

// The dispatch API's GitHub reads (PRD Appendix A.3). Options are resolved here from the environment (the same
// `githubReaderOptions` a unit test exercises, [S5]/[P36]); the reader is passed to createApp so a plain server stays
// GitHub-off (note 7). Discovery is wired inside buildDispatch, where the store the registry reloader keeps current
// exists — the tick follows the reloaded registry rather than the start-up snapshot ([S3], [L9]).
const gitRunner = realGitRunner()
const github = new GithubReader(githubReaderOptions(process.env, Date.now))

const app = createApp(config.locations, {
  controls: { setup: controls }, projects, refreshProjects: projects.configPath === null ? undefined : projectsConfigReloader(projects.configPath),
  dispatch: { gitRunner, github },
})
try {
  await app.listen({ port: Number(process.env.MD_MANAGER_API_PORT ?? 3001), host: '127.0.0.1' })
  for (const warning of controls.warnings) app.log.warn(warning)
  app.log.info({ controls: controls.enabled }, controls.enabled ? 'Run controls are on' : 'Run controls are off')
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
