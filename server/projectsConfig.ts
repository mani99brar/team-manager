import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import { z } from 'zod'
import { validateDefinition, type WorkflowDefinition } from '../contracts/projects/v1.ts'

/**
 * The project registry: operator-configured associations between an opaque project ID, a repository and
 * one or more workflow run roots. Loaded once at startup from MD_MANAGER_PROJECTS_CONFIG, independently of
 * the skills configuration. Unset means an empty registry; an explicitly supplied file that is missing or
 * invalid fails startup. Requests can never add, change or select a root, and a run's own `plan.json` never
 * registers anything: runs belong to a workflow solely because they live under its configured `runs_root`.
 */
export const PROJECTS_CONFIG_ENV = 'MD_MANAGER_PROJECTS_CONFIG'
const SUPPORTED_VERSION = 1

/** A registry problem: the message is a local startup diagnostic and may name configured paths. */
export class ProjectsConfigError extends Error {}

export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const NODE_KINDS = ['prepare', 'worker', 'verification', 'review', 'integration'] as const

/** The exact on-disk shape from the feature README. Anything else is rejected. */
const absoluteDirectory = z.string().min(1).refine(path => !path.includes('\0'), 'must not contain NUL characters')
  .refine(path => isAbsolute(path) && !path.startsWith('~'), 'must be an absolute path; "~", environment variables and relative paths are not expanded')
  .refine(path => resolve(path) !== sep, 'must not be the filesystem root')

const nodeSchema = z.strictObject({
  node_id: z.string().regex(ID_PATTERN),
  label: z.string().min(1),
  kind: z.enum(NODE_KINDS),
  depends_on: z.array(z.string().regex(ID_PATTERN)),
})

export const storedDefinitionSchema = z.strictObject({ name: z.string().min(1), nodes: z.array(nodeSchema).min(1) })

const workflowSchema = z.strictObject({
  workflow_id: z.string().regex(ID_PATTERN),
  runs_root: absoluteDirectory,
  definition: storedDefinitionSchema,
})

const projectSchema = z.strictObject({
  project_id: z.string().regex(ID_PATTERN),
  name: z.string().trim().min(1),
  repository: absoluteDirectory,
  workflows: z.array(workflowSchema),
})

const fileSchema = z.strictObject({ version: z.literal(SUPPORTED_VERSION), projects: z.array(projectSchema) })

export type StoredDefinition = z.infer<typeof storedDefinitionSchema>

export type WorkflowConfig = {
  workflow_id: string
  /** Absolute, normalized directory containing one sub-directory per run. */
  runs_root: string
  /** The current public definition, including its computed revision. */
  definition: WorkflowDefinition
}

export type ProjectConfig = {
  project_id: string
  name: string
  /** Absolute, normalized repository directory. Informational only: nothing is read from it. */
  repository: string
  workflows: WorkflowConfig[]
}

export type ProjectsConfig = { projects: ProjectConfig[] }

export const EMPTY_PROJECTS: ProjectsConfig = { projects: [] }

/**
 * Canonical JSON as specified by the project contract: sorted object keys, compact separators, literal
 * (unescaped) non-ASCII characters, array order retained. Matches Python's
 * `json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)` for the JSON subset used here.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).filter(key => record[key] !== undefined).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

/** SHA-256 of the canonical public definition without its `definition_revision` field. */
export function definitionRevision(definition: Omit<WorkflowDefinition, 'definition_revision'>): string {
  const { contract_version, project_id, workflow_id, name, nodes } = definition
  return createHash('sha256').update(canonicalJson({ contract_version, project_id, workflow_id, name, nodes }), 'utf8').digest('hex')
}

/**
 * Builds and validates the public definition for a stored `{name, nodes}` graph in the given scope. Throws on
 * structural problems (duplicate nodes, unknown dependencies, cycles) so a malformed graph is never published.
 */
export function publishDefinition(project_id: string, workflow_id: string, stored: StoredDefinition): WorkflowDefinition {
  const base = {
    contract_version: '1.0.0' as const, project_id, workflow_id, name: stored.name,
    nodes: stored.nodes.map(node => ({ node_id: node.node_id, label: node.label, kind: node.kind, depends_on: [...node.depends_on] })),
  }
  return validateDefinition({ ...base, definition_revision: definitionRevision(base) })
}

function contains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)
}

function issueText(error: z.ZodError): string {
  return error.issues.map(issue => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`).join('; ')
}

/**
 * Lexical validation of a parsed registry: shape, ID uniqueness within scope, graph validity and non-overlapping
 * run roots (two spellings of one directory, or a nested root, would make a run belong to two workflows).
 * Nothing on disk is consulted; `assertCanonicalRoots` additionally resolves aliases where roots exist.
 */
export function validateProjectsConfig(input: unknown): ProjectsConfig {
  const parsed = fileSchema.safeParse(input)
  if (!parsed.success) throw new ProjectsConfigError(issueText(parsed.error))
  const projects: ProjectConfig[] = []
  const projectIds = new Set<string>()
  const roots: { root: string; where: string }[] = []
  for (const project of parsed.data.projects) {
    if (projectIds.has(project.project_id)) throw new ProjectsConfigError(`Duplicate project_id "${project.project_id}"; project IDs must be unique.`)
    projectIds.add(project.project_id)
    const workflowIds = new Set<string>()
    const workflows: WorkflowConfig[] = []
    for (const workflow of project.workflows) {
      const where = `${project.project_id}/${workflow.workflow_id}`
      if (workflowIds.has(workflow.workflow_id)) throw new ProjectsConfigError(`Duplicate workflow_id "${workflow.workflow_id}" in project "${project.project_id}".`)
      workflowIds.add(workflow.workflow_id)
      let definition: WorkflowDefinition
      try {
        definition = publishDefinition(project.project_id, workflow.workflow_id, workflow.definition)
      } catch (error) {
        throw new ProjectsConfigError(`Workflow "${where}" definition is invalid: ${error instanceof z.ZodError ? issueText(error) : (error as Error).message}`)
      }
      const root = resolve(workflow.runs_root)
      for (const other of roots) {
        if (contains(other.root, root) || contains(root, other.root)) {
          throw new ProjectsConfigError(`Workflows "${other.where}" and "${where}" have overlapping runs_root directories (${other.root} and ${root}); every run must belong to exactly one workflow.`)
        }
      }
      roots.push({ root, where })
      workflows.push({ workflow_id: workflow.workflow_id, runs_root: root, definition })
    }
    projects.push({ project_id: project.project_id, name: project.name.trim(), repository: resolve(project.repository), workflows })
  }
  return { projects }
}

/**
 * Re-validates an already-built registry object (for example one injected into createApp by a test) by
 * rebuilding it from its stored shape, so revisions are recomputed and every registry rule is re-applied.
 */
export function assertProjectsConfig(config: ProjectsConfig): ProjectsConfig {
  return validateProjectsConfig({
    version: SUPPORTED_VERSION,
    projects: config.projects.map(project => ({
      project_id: project.project_id, name: project.name, repository: project.repository,
      workflows: project.workflows.map(workflow => ({
        workflow_id: workflow.workflow_id, runs_root: workflow.runs_root,
        definition: {
          name: workflow.definition.name,
          nodes: workflow.definition.nodes.map(node => ({ node_id: node.node_id, label: node.label, kind: node.kind, depends_on: [...node.depends_on] })),
        },
      })),
    })),
  })
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

/** Rejects run roots that are aliases of each other (symlinks, bind mounts) once the directories exist. */
export async function assertCanonicalRoots(config: ProjectsConfig): Promise<void> {
  const entries = config.projects.flatMap(project => project.workflows.map(workflow => ({ where: `${project.project_id}/${workflow.workflow_id}`, root: workflow.runs_root })))
  const canonicals = await Promise.all(entries.map(entry => canonical(entry.root)))
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      if (contains(canonicals[i], canonicals[j]) || contains(canonicals[j], canonicals[i])) {
        throw new ProjectsConfigError(`Workflows "${entries[i].where}" and "${entries[j].where}" have overlapping runs_root directories (${entries[i].root} and ${entries[j].root}); every run must belong to exactly one workflow.`)
      }
    }
  }
}

/** Parses and fully validates registry text. `describe` names the file for diagnostics. */
export async function parseProjectsConfig(text: string, describe: string): Promise<ProjectsConfig> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new ProjectsConfigError(`${describe} is not valid JSON: ${(error as Error).message}`)
  }
  try {
    const config = validateProjectsConfig(parsed)
    await assertCanonicalRoots(config)
    return config
  } catch (error) {
    if (error instanceof ProjectsConfigError) throw new ProjectsConfigError(`${describe}: ${error.message}`)
    throw error
  }
}

export type LoadedProjectsConfig = ProjectsConfig & { configPath: string | null }

/** Unset or blank means an empty registry; an explicitly named file must exist and be valid. */
export async function loadProjectsConfig(env: NodeJS.ProcessEnv): Promise<LoadedProjectsConfig> {
  const setting = env[PROJECTS_CONFIG_ENV]?.trim()
  if (!setting) return { ...EMPTY_PROJECTS, configPath: null }
  const configPath = resolve(setting)
  let text: string
  try {
    text = await readFile(configPath, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const reason = code === 'ENOENT' ? 'does not exist' : `could not be read (${code ?? 'unknown error'})`
    throw new ProjectsConfigError(`Project registry ${configPath} ${reason}. Create it from config/projects.example.json or unset ${PROJECTS_CONFIG_ENV} for an empty Projects root.`)
  }
  return { ...(await parseProjectsConfig(text, configPath)), configPath }
}
