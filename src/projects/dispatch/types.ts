/**
 * The dispatch API, mirrored from `docs/PRD_PROJECTS_DISPATCH.md` Appendix A (contract 1.0.0). The `server` lane owns the
 * real `contracts/projects/dispatch.ts`; the viewer lane mirrors the same shapes here so it can type its client and its
 * worker-phase mocks without importing a contract another lane builds in the same run ([D2]). Keep these in step with
 * Appendix A: a field the pages need that Appendix A does not define is a `question` completion, never a new field here.
 */

export type Sha = string
export type Ts = string

export const DISPATCH_CONTRACT_VERSION = '1.0.0'

export interface DispatchOverview {
  contract_version: '1.0.0'
  read_at: Ts
  viewer_login: string | null
  projects: ProjectDispatch[]
}

export interface ProjectDispatch {
  project_id: string
  git: GitState
  github: GithubState
}

export interface GitOrigin {
  ref: string
  sha: Sha
  updated_at: Ts | null
  compare: 'compared' | 'no_local_branch'
  ahead: number | null
  behind: number | null
}

export interface GitState {
  status: 'read' | 'unavailable'
  reason: string | null
  repository_label: string
  checkout: string | null
  head: Sha | null
  default_branch: string | null
  clone_id: string | null
  clone_primary: string | null
  origin: GitOrigin | null
  ahead_commits: { sha: Sha; subject: string; committed_at: Ts; run_id: string | null }[]
  ahead_naming_run: number
  landings: Landing[]
  read_at: Ts
}

export interface Landing {
  workflow_id: string
  run_id: string
  sha: Sha
  on_default: boolean | null
  on_origin: boolean | null
}

export type GithubStatus = 'read' | 'pending' | 'off' | 'not_github' | 'unavailable'

export interface GithubState {
  status: GithubStatus
  reason: string | null
  repo: string | null
  read_at: Ts | null
  visibility: 'PUBLIC' | 'PRIVATE' | 'INTERNAL' | null
  default_branch: string | null
  pushed_at: Ts | null
  head: { sha: Sha; committed_at: Ts } | null
  open_prs: number | null
  open_issues: number | null
  prs: Pr[]
  issues: Issue[]
}

/** The read per repository, as the fixture file and the on-disk cache hold it. */
export type GithubRepoRead = Omit<GithubState, 'status' | 'reason' | 'repo'>

export interface Pr {
  number: number
  title: string
  url: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  draft: boolean
  author: string
  author_is_bot: boolean
  head_ref: string
  base_ref: string
  updated_at: Ts
  merged_at: Ts | null
  review_decision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  checks: { passing: number; failing: number; pending: number } | null
  labels: string[]
}

export interface Issue {
  number: number
  title: string
  url: string
  author: string
  author_is_bot: boolean
  labels: string[]
  assignees: string[]
  created_at: Ts
  updated_at: Ts
}

export interface ProjectStepsRun {
  run_id: string
  source_branch: string | null
  base_commit: Sha | null
  integrated_commit: Sha | null
  lanes: string[]
  steps: { node_id: string; label: string; kind: string; status: string; attempt: number }[]
}

export interface ProjectStepsWorkflow {
  workflow_id: string
  error: { code: string; message: string } | null
  runs: ProjectStepsRun[]
  errors: { run_id: string; code: string; message: string }[]
}

export interface ProjectSteps {
  contract_version: '1.0.0'
  project_id: string
  workflows: ProjectStepsWorkflow[]
}
