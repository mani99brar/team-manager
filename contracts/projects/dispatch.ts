import { z } from 'zod'

/**
 * The dispatch API (docs/PRD_PROJECTS_DISPATCH.md Appendix A, contract 1.0.0): the Projects overview and a project's
 * step digests. Two read-only GET routes. Every response carries `contract_version: '1.0.0'`; the routes parse their
 * own output against these schemas before sending, and a part that cannot be projected degrades to a stated reason
 * rather than failing the whole response (decisions.md [L2], design-challenge note 6).
 *
 * Timestamps are ISO 8601 with a `Z` offset (`z.iso.datetime()` rejects numeric offsets), so the server converts every
 * git and gh time with `new Date(x).toISOString()`. No field ever carries an absolute filesystem path ([P8]); labels
 * are `~`-relative or a basename, clones are a hash, and reasons are the fixed texts of PRD section 5.
 */
export const DISPATCH_VERSION = '1.0.0'

const sha = z.string().regex(/^[0-9a-f]{7,40}$/)
const ts = z.iso.datetime()

export const prSchema = z.strictObject({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  draft: z.boolean(),
  author: z.string(),
  author_is_bot: z.boolean(),
  head_ref: z.string(),
  base_ref: z.string(),
  updated_at: ts,
  merged_at: ts.nullable(),
  review_decision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).nullable(),
  checks: z.strictObject({ passing: z.number().int(), failing: z.number().int(), pending: z.number().int() }).nullable(),
  labels: z.array(z.string()),
})

export const issueSchema = z.strictObject({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  author: z.string(),
  author_is_bot: z.boolean(),
  labels: z.array(z.string()),
  assignees: z.array(z.string()),
  created_at: ts,
  updated_at: ts,
})

/** The fields a single repository read carries, shared by the live state, the fixture file and the on-disk cache. */
const githubReadFields = {
  read_at: ts.nullable(),
  visibility: z.enum(['PUBLIC', 'PRIVATE', 'INTERNAL']).nullable(),
  default_branch: z.string().nullable(),
  pushed_at: ts.nullable(),
  head: z.strictObject({ sha, committed_at: ts }).nullable(),
  open_prs: z.number().int().nullable(),
  open_issues: z.number().int().nullable(),
  prs: z.array(prSchema),
  issues: z.array(issueSchema),
}

/** `GithubRepoRead` = `Omit<GithubState, 'status' | 'reason' | 'repo'>`: one repository's read, as the fixture and cache hold it. */
export const githubRepoReadSchema = z.strictObject(githubReadFields)

export const githubStateSchema = z.strictObject({
  status: z.enum(['read', 'pending', 'off', 'not_github', 'unavailable']),
  reason: z.string().nullable(),
  repo: z.string().nullable(),
  ...githubReadFields,
})

export const gitStateSchema = z.strictObject({
  status: z.enum(['read', 'unavailable']),
  reason: z.string().nullable(),
  repository_label: z.string(),
  checkout: z.string().nullable(),
  head: sha.nullable(),
  default_branch: z.string().nullable(),
  clone_id: z.string().nullable(),
  clone_primary: z.string().nullable(),
  origin: z.strictObject({
    ref: z.string(),
    sha,
    updated_at: ts.nullable(),
    compare: z.enum(['compared', 'no_local_branch']),
    ahead: z.number().int().nullable(),
    behind: z.number().int().nullable(),
  }).nullable(),
  ahead_commits: z.array(z.strictObject({ sha, subject: z.string(), committed_at: ts, run_id: z.string().nullable() })),
  ahead_naming_run: z.number().int(),
  landings: z.array(z.strictObject({ workflow_id: z.string(), run_id: z.string(), sha, on_default: z.boolean().nullable(), on_origin: z.boolean().nullable() })),
  read_at: ts,
})

export const projectDispatchSchema = z.strictObject({
  project_id: z.string(),
  git: gitStateSchema,
  github: githubStateSchema,
})

export const dispatchOverviewSchema = z.strictObject({
  contract_version: z.literal(DISPATCH_VERSION),
  read_at: ts,
  viewer_login: z.string().nullable(),
  projects: z.array(projectDispatchSchema),
})

export const stepSchema = z.strictObject({
  node_id: z.string(),
  label: z.string(),
  kind: z.string(),
  status: z.string(),
  attempt: z.number().int(),
})

export const projectStepsSchema = z.strictObject({
  contract_version: z.literal(DISPATCH_VERSION),
  project_id: z.string(),
  workflows: z.array(z.strictObject({
    workflow_id: z.string(),
    error: z.strictObject({ code: z.string(), message: z.string() }).nullable(),
    runs: z.array(z.strictObject({
      run_id: z.string(),
      source_branch: z.string().nullable(),
      base_commit: sha.nullable(),
      integrated_commit: sha.nullable(),
      lanes: z.array(z.string()),
      steps: z.array(stepSchema),
    })),
    errors: z.array(z.strictObject({ run_id: z.string(), code: z.string(), message: z.string() })),
  })),
})

/** The two routes, for the shared export and contract test (mirrors `schemas` in v1.ts). */
export const dispatchSchemas = {
  dispatchOverview: dispatchOverviewSchema,
  projectSteps: projectStepsSchema,
}

export type Pr = z.infer<typeof prSchema>
export type Issue = z.infer<typeof issueSchema>
export type GithubRepoRead = z.infer<typeof githubRepoReadSchema>
export type GithubState = z.infer<typeof githubStateSchema>
export type GitState = z.infer<typeof gitStateSchema>
export type ProjectDispatch = z.infer<typeof projectDispatchSchema>
export type DispatchOverview = z.infer<typeof dispatchOverviewSchema>
export type ProjectSteps = z.infer<typeof projectStepsSchema>
