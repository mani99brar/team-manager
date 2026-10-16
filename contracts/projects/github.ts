import { z } from 'zod'

/**
 * The run's GitHub contracts (docs/PRD_RUN_TEAMS.md Appendix B and C).
 *
 * **Read** (`runGithubSchema`, 1.0.0): `GET /api/dispatch/projects/:project_id/workflows/:workflow_id/runs/:run_id/github`
 * (GET and HEAD). Where the run's branch stands against GitHub: the project's repository and its GitHub remote, the gh reader's
 * state (viewer, visibility, permission), the run branch (`inputs.source_branch`) locally and on the remote with the commits a
 * push would publish, and the pull request whose head is that branch (state, draft, review decision, mergeability, reviews,
 * requested reviewers, comment and thread counts, and every check by name). Local git facts are read per request (cached a few
 * seconds); GitHub facts come from the timer-driven gh reader (`server/dispatchGithub.ts`), so a branch first asked for answers
 * `github.status: 'pending'` until the next tick. No field carries an absolute path or a credential; reasons are fixed texts.
 *
 * **Actions** (`runGithubActionsSchema`, 1.0.0): mounted in the run-control scope (`/api/run-controls/:project_id/:workflow_id/
 * :run_id/github`), so every route inherits its browser guards and pairing token (docs/PRD_RUN_CONTROLS.md 5.2). Four actions on
 * the repository, never on the run: push the run branch (never forced, never the default branch), open a draft pull request,
 * mark it ready for review, and request reviewers (users or `org/team`). The run summary is copied, never posted. As every run control, each
 * maps to one fixed controller argv, `python -m workflow github <action> <run> ... --by operator` (PRD_RUN_CONTROLS principle
 * 1); the controller checks the branch and sha again and runs git or gh without a shell. Each publishes something, so each
 * states what becomes visible, and an action on a PUBLIC repository (or one whose visibility is unknown) is confirmed by typing
 * the repository's `owner/name`. They are off unless the dashboard runs with `MD_MANAGER_GITHUB_ACTIONS=on` and run controls on;
 * off, every action is unavailable with that reason and the GitHub view shows the commands to run by hand.
 *
 * This module imports only zod.
 */
export const RUN_GITHUB_VERSION = '1.0.0'
export const GITHUB_ACTIONS_VERSION = '1.0.0'

const sha = z.string().regex(/^[0-9a-f]{7,40}$/)
const ts = z.iso.datetime()
const count = z.number().int().nonnegative()
/** `owner/name` as GitHub spells it. */
export const OWNER_NAME = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/

export const REPO_STATUSES = ['github', 'not_github', 'no_remote', 'unavailable'] as const
export const GITHUB_STATUSES = ['read', 'pending', 'off', 'unavailable', 'not_github'] as const
export const VISIBILITIES = ['PUBLIC', 'PRIVATE', 'INTERNAL'] as const
export const PERMISSIONS = ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] as const

/**
 * Where the run branch stands against its remote-tracking ref (the last fetch or push; nothing here fetches):
 * `not_pushed` (no remote branch), `up_to_date`, `local_ahead` (a push would add commits), `remote_ahead` (the remote has
 * commits the run branch lacks), `diverged`, `no_local_branch` (the run branch is not in the repository), `unknown`.
 */
export const PUSH_STATES = ['not_pushed', 'up_to_date', 'local_ahead', 'remote_ahead', 'diverged', 'no_local_branch', 'unknown'] as const

export const runRepoSchema = z.strictObject({
  status: z.enum(REPO_STATUSES),
  reason: z.string().min(1).nullable(),
  owner_name: z.string().regex(OWNER_NAME).nullable(),
  url: z.string().nullable(),
  remote: z.string().min(1).nullable(),
  default_branch: z.string().min(1).nullable(),
})

export const runGithubStateSchema = z.strictObject({
  status: z.enum(GITHUB_STATUSES),
  reason: z.string().min(1).nullable(),
  read_at: ts.nullable(),
  viewer_login: z.string().min(1).nullable(),
  visibility: z.enum(VISIBILITIES).nullable(),
  viewer_permission: z.enum(PERMISSIONS).nullable(),
})

/** `author` is the commit's `Name <email>` exactly as a push would publish it, so the preview shows what becomes public. */
export const unpublishedCommitSchema = z.strictObject({ sha, subject: z.string(), author: z.string(), committed_at: ts })

export const runBranchSchema = z.strictObject({
  /** `inputs.source_branch`; null when the run records none. */
  name: z.string().min(1).nullable(),
  local_sha: sha.nullable(),
  tracking_sha: sha.nullable(),
  /** The branch head GitHub reported at its last read; null before a read or when the branch is not on GitHub. */
  github_sha: sha.nullable(),
  push_state: z.enum(PUSH_STATES),
  ahead_of_remote: count.nullable(),
  behind_remote: count.nullable(),
  ahead_of_default: count.nullable(),
  behind_default: count.nullable(),
  /** The commits a push would publish (on the run branch, on neither its remote branch nor the remote default), newest first, at most 50. */
  unpublished: z.array(unpublishedCommitSchema).max(50),
  unpublished_more: count,
  integrated_commit: sha.nullable(),
  /** Whether the run branch contains the run's integrated commit; null when the run has none or git cannot tell. */
  contains_integrated: z.boolean().nullable(),
})

export const CHECK_BUCKETS = ['pass', 'fail', 'pending', 'skip', 'neutral'] as const

export const runCheckSchema = z.strictObject({
  name: z.string().min(1),
  kind: z.enum(['check_run', 'status']),
  /** GitHub's own words: QUEUED, IN_PROGRESS, COMPLETED for a check run; null for a status context. */
  status: z.string().nullable(),
  /** SUCCESS, FAILURE, NEUTRAL, SKIPPED, CANCELLED, TIMED_OUT, ACTION_REQUIRED, STALE, or a status context's state. */
  conclusion: z.string().nullable(),
  bucket: z.enum(CHECK_BUCKETS),
  url: z.string().nullable(),
})

export const runReviewerSchema = z.strictObject({ kind: z.enum(['user', 'team', 'bot']), login: z.string().min(1) })

export const runReviewSchema = z.strictObject({
  author: z.string().min(1),
  state: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING']),
  submitted_at: ts.nullable(),
})

export const runPrSchema = z.strictObject({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  draft: z.boolean(),
  author: z.string(),
  head_ref: z.string(),
  base_ref: z.string(),
  head_sha: sha.nullable(),
  updated_at: ts,
  merged_at: ts.nullable(),
  review_decision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).nullable(),
  mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']).nullable(),
  comments: count,
  review_threads: count,
  unresolved_threads: count.nullable(),
  requested_reviewers: z.array(runReviewerSchema).max(50),
  latest_reviews: z.array(runReviewSchema).max(50),
  checks: z.strictObject({
    /** The head commit's status-check rollup state; null when it has no checks. */
    state: z.enum(['SUCCESS', 'FAILURE', 'PENDING', 'ERROR', 'EXPECTED']).nullable(),
    passing: count,
    failing: count,
    pending: count,
    skipped: count,
    total: count,
    /** At most 100, failing first, then pending, then the rest by name. */
    items: z.array(runCheckSchema).max(100),
  }).nullable(),
})

export const earlierPrSchema = z.strictObject({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  updated_at: ts,
})

export const runGithubSchema = z.strictObject({
  contract_version: z.literal(RUN_GITHUB_VERSION),
  project_id: z.string().min(1),
  workflow_id: z.string().min(1),
  run_id: z.string().min(1),
  read_at: ts,
  repo: runRepoSchema,
  github: runGithubStateSchema,
  branch: runBranchSchema,
  /** The newest same-repository pull request whose head is the run branch, open first; null when none. */
  pr: runPrSchema.nullable(),
  /** Other pull requests from the same head (closed or merged earlier), newest first, at most 10. */
  earlier_prs: z.array(earlierPrSchema).max(10),
})

export type RunGithub = z.infer<typeof runGithubSchema>
export type RunRepo = z.infer<typeof runRepoSchema>
export type RunGithubState = z.infer<typeof runGithubStateSchema>
export type RunBranch = z.infer<typeof runBranchSchema>
export type RunPr = z.infer<typeof runPrSchema>
export type RunCheck = z.infer<typeof runCheckSchema>
export type PushState = (typeof PUSH_STATES)[number]

// ---- Actions -------------------------------------------------------------------------------------------------------------

/** In the order the GitHub view lists them. */
export const GITHUB_ACTION_IDS = ['push_branch', 'open_pr', 'mark_ready', 'request_reviewers'] as const
export const GITHUB_RECORD_STATUSES = ['running', 'succeeded', 'failed', 'refused', 'lost'] as const

export const githubActionIdSchema = z.enum(GITHUB_ACTION_IDS)

export const githubParamSpecSchema = z.discriminatedUnion('name', [
  z.strictObject({ name: z.literal('title'), kind: z.literal('text'), min_length: count, max_length: z.number().int().positive(), required: z.literal(true) }),
  z.strictObject({ name: z.literal('body'), kind: z.literal('multiline'), min_length: count, max_length: z.number().int().positive(), required: z.literal(true) }),
  /** GitHub logins or `org/team` slugs; `suggestions` are the repository's recent reviewers, never required. */
  z.strictObject({ name: z.literal('reviewers'), kind: z.literal('list'), max_items: z.number().int().positive(), suggestions: z.array(z.string().min(1)).max(30), required: z.literal(true) }),
  z.strictObject({ name: z.literal('confirm_repo'), kind: z.literal('typed'), required: z.literal(true) }),
])

export const githubParamsSchema = z.strictObject({
  title: z.string().optional(),
  body: z.string().optional(),
  reviewers: z.array(z.string()).optional(),
  confirm_repo: z.string().optional(),
})

export const githubActionSchema = z.strictObject({
  id: githubActionIdSchema,
  label: z.string().min(1),
  available: z.boolean(),
  reason: z.string().min(1).nullable(),
  /** The exact controller command, redacted (home as `~`), with the server-filled values; typed params appear as `<title>`. */
  command: z.string().min(1),
  confirm: z.enum(['plain', 'typed_repo']),
  params: z.array(githubParamSpecSchema),
  /** Server-filled starting values for the dialog's fields (a generated title and body, no reviewers). */
  defaults: z.strictObject({ title: z.string().optional(), body: z.string().optional(), reviewers: z.array(z.string()).optional() }),
  effect: z.string().min(1),
  not_effect: z.string().min(1).nullable(),
  /** What becomes visible on GitHub and to whom, e.g. "3 commits become public on kleros/vea". */
  publishes: z.string().min(1),
})

/** The record as served: the body is never kept, only its length; `confirm_repo` is never part of it. */
export const githubRecordParamsSchema = z.strictObject({
  title: z.string().optional(),
  body_chars: count.optional(),
  reviewers: z.array(z.string()).optional(),
})

export const githubActionRecordSchema = z.strictObject({
  record_id: z.string().regex(/^g-[0-9a-f]{12}$/),
  request_id: z.uuid(),
  action: githubActionIdSchema,
  params: githubRecordParamsSchema,
  command: z.string().min(1),
  status: z.enum(GITHUB_RECORD_STATUSES),
  exit_code: z.number().int().nullable(),
  started_at: ts,
  ended_at: ts.nullable(),
  output_tail: z.array(z.string()).max(40),
  /** The pull request or comment the action produced, when gh printed one. */
  url: z.string().nullable(),
})

export const runGithubActionsSchema = z.strictObject({
  version: z.literal(GITHUB_ACTIONS_VERSION),
  /** False unless the dashboard runs with `MD_MANAGER_GITHUB_ACTIONS=on`; every action is then unavailable with that reason. */
  enabled: z.boolean(),
  /** A digest of the facts the offers were computed from (branch shas, pull request state); a stale one is 409 STATE_CHANGED. */
  state_token: z.string().min(1).max(128),
  repo: z.string().regex(OWNER_NAME).nullable(),
  visibility: z.enum(VISIBILITIES).nullable(),
  actions: z.array(githubActionSchema).length(GITHUB_ACTION_IDS.length),
  records: z.array(githubActionRecordSchema).max(20),
}).superRefine((value, context) => {
  value.actions.forEach((action, index) => {
    if (action.id !== GITHUB_ACTION_IDS[index]) context.addIssue({ code: 'custom', path: ['actions', index, 'id'], message: `Action ${index} is ${GITHUB_ACTION_IDS[index]}` })
    if (action.available !== (action.reason === null)) context.addIssue({ code: 'custom', path: ['actions', index, 'reason'], message: 'An action carries a reason exactly when it is unavailable' })
  })
})

/** `POST .../github/:action_id` body. */
export const githubActionRequestSchema = z.strictObject({ request_id: z.uuid(), state_token: z.string().min(1).max(128), params: githubParamsSchema })
export const githubActionResponseSchema = z.strictObject({ record: githubActionRecordSchema })

export type GithubActionId = z.infer<typeof githubActionIdSchema>
export type GithubParamSpec = z.infer<typeof githubParamSpecSchema>
export type GithubParams = z.infer<typeof githubParamsSchema>
export type GithubAction = z.infer<typeof githubActionSchema>
export type GithubActionRecord = z.infer<typeof githubActionRecordSchema>
export type RunGithubActions = z.infer<typeof runGithubActionsSchema>
export type GithubActionRequest = z.infer<typeof githubActionRequestSchema>

export const githubSchemas = {
  runGithub: runGithubSchema,
  runGithubActions: runGithubActionsSchema,
  githubActionRequest: githubActionRequestSchema,
  githubActionResponse: githubActionResponseSchema,
} as const
