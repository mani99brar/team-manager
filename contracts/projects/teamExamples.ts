import type { TeamAgent, Teams } from './teams.js'
import type { RunGithub, RunGithubActions } from './github.js'

/**
 * Examples for the run-teams and run-GitHub contracts (docs/PRD_RUN_TEAMS.md Appendices A-C). `examples.ts` re-exports `teams`
 * under the `schemas` key the generic contract test reads; the GitHub ones have their own test.
 */

const agent = (index: number, fields: Partial<TeamAgent> & Pick<TeamAgent, 'label' | 'state'>): TeamAgent => ({
  agent_id: fields.state === 'queued' ? null : `a${index.toString(16).padStart(16, '0')}`,
  index,
  role: fields.label.includes(':') ? fields.label.split(':')[0] : null,
  phase: null,
  phase_index: null,
  model: 'claude-opus-5-5',
  cached: false,
  attempt: fields.state === 'queued' ? null : 1,
  isolated: false,
  started_at: null,
  last_activity_at: null,
  duration_ms: null,
  tool_calls: null,
  context_tokens: null,
  last_tool: null,
  last_tool_summary: null,
  prompt_preview: null,
  result_preview: null,
  files_edited: [],
  files_edited_more: 0,
  providers: [],
  ...fields,
})

const finishedAgents: TeamAgent[] = [
  agent(1, { label: 'map:ui', phase: 'Understand', phase_index: 1, state: 'done', started_at: '2026-10-16T09:00:05Z', last_activity_at: '2026-10-16T09:06:40Z', duration_ms: 395000, tool_calls: 41, context_tokens: 88214, last_tool: 'StructuredOutput', last_tool_summary: 'map of the run page', prompt_preview: 'Map the run page frontend: RunView, signal/*, node/* …', result_preview: '{"summary":"The run page has three renders …"}' }),
  agent(2, { label: 'map:server', phase: 'Understand', phase_index: 1, state: 'done', started_at: '2026-10-16T09:00:05Z', last_activity_at: '2026-10-16T09:05:12Z', duration_ms: 307000, tool_calls: 33, context_tokens: 71002, last_tool: 'StructuredOutput', last_tool_summary: 'map of the read API', prompt_preview: 'Map the read API and contracts …', result_preview: '{"summary":"RunStore projects the run on every call …"}' }),
  agent(3, { label: 'impl:frontend', phase: 'Implement', phase_index: 2, state: 'done', started_at: '2026-10-16T09:07:00Z', last_activity_at: '2026-10-16T09:31:10Z', duration_ms: 1450000, tool_calls: 96, context_tokens: 140551, last_tool: 'Bash', last_tool_summary: 'npm run build', files_edited: ['src/projects/teams/TeamView.tsx', 'src/projects/teams/model.ts', 'src/projects/teams/teams.css'], prompt_preview: 'Build the Team view …', result_preview: '{"commit":null,"files":3}' }),
  agent(4, { label: 'impl:server', phase: 'Implement', phase_index: 2, state: 'done', started_at: '2026-10-16T09:07:00Z', last_activity_at: '2026-10-16T09:28:44Z', duration_ms: 1304000, tool_calls: 88, context_tokens: 121003, last_tool: 'Bash', last_tool_summary: 'npx tsx --test server/teams.test.ts', files_edited: ['server/teams.ts', 'server/teams.test.ts'], prompt_preview: 'Build the teams reader …', result_preview: '{"tests":"14 passed"}' }),
  agent(5, { label: 'review:gpt', phase: 'Review', phase_index: 3, state: 'failed', model: 'claude-sonnet-5-5', started_at: '2026-10-16T09:32:00Z', last_activity_at: '2026-10-16T09:33:10Z', duration_ms: 70000, tool_calls: 4, last_tool: 'Bash', last_tool_summary: 'pi -p --model openai-codex/gpt-6-astra …', providers: ['openai-codex/gpt-6-astra'] }),
  agent(6, { label: 'review:claude', phase: 'Review', phase_index: 3, state: 'done', started_at: '2026-10-16T09:32:00Z', last_activity_at: '2026-10-16T09:41:30Z', duration_ms: 570000, tool_calls: 37, context_tokens: 99120, last_tool: 'StructuredOutput', last_tool_summary: 'issues', result_preview: '{"verdict":"issues","findings":[…]}' }),
]

const liveAgents: TeamAgent[] = [
  agent(1, { label: 'fix:finding-1', phase: 'Fix', phase_index: 1, state: 'done', started_at: '2026-10-16T09:45:00Z', last_activity_at: '2026-10-16T09:52:00Z', duration_ms: 420000, tool_calls: 22, context_tokens: 61000, last_tool: 'Edit', files_edited: ['server/teams.ts'] }),
  agent(2, { label: 'fix:finding-2', phase: 'Fix', phase_index: 1, state: 'running', started_at: '2026-10-16T09:45:00Z', last_activity_at: '2026-10-16T09:58:20Z', duration_ms: 800000, tool_calls: 31, context_tokens: 74000, last_tool: 'Bash', last_tool_summary: 'npx tsx --test tests/unit/teams.test.ts', files_edited: ['src/projects/teams/model.ts'] }),
]

/** One worker that ran two workflows (one finished, one live), a repair that ran none, and a challenge with an unreadable folder. */
export const teams: Teams = {
  contract_version: '1.0.0',
  run_id: 'run-001',
  read_at: '2026-10-16T09:58:30Z',
  sessions: [
    {
      key: 'worker:ui',
      role: 'worker',
      label: 'Worker · ui',
      node_id: 'launch_ui',
      lane: 'ui',
      session_id: '9f1c2d3e-4b5a-6789-8abc-def012345678',
      records: 'found',
      reason: null,
      workflows: [
        {
          run_id: 'wf_1a2b3c4d-5e6',
          name: 'build-run-teams',
          description: 'Understand, implement and review the run-teams slice',
          status: 'completed',
          record: 'final',
          started_at: '2026-10-16T09:00:04Z',
          ended_at: '2026-10-16T09:41:31Z',
          last_activity_at: '2026-10-16T09:41:31Z',
          duration_ms: 2487000,
          default_model: 'claude-opus-5-5',
          agent_count: 6,
          tool_calls: 299,
          context_tokens: 519890,
          phases: [
            { index: 1, title: 'Understand', detail: 'parallel readers', agents: 2, queued: 0, running: 0, done: 2, failed: 0, interrupted: 0 },
            { index: 2, title: 'Implement', detail: null, agents: 2, queued: 0, running: 0, done: 2, failed: 0, interrupted: 0 },
            { index: 3, title: 'Review', detail: 'Claude + GPT', agents: 2, queued: 0, running: 0, done: 1, failed: 1, interrupted: 0 },
          ],
          agents: finishedAgents,
          agents_more: 0,
          logs: ['2 readers done', 'review: 1 issue'],
          result_preview: '{"implemented":true,"review":"issues"}',
          error: null,
        },
        {
          run_id: 'wf_7f8e9d0c-b1a',
          name: 'fix-review-findings',
          description: 'Fix the review findings',
          status: 'running',
          record: 'live',
          started_at: '2026-10-16T09:45:00Z',
          ended_at: null,
          last_activity_at: '2026-10-16T09:58:20Z',
          duration_ms: null,
          default_model: null,
          agent_count: 2,
          tool_calls: 53,
          context_tokens: null,
          phases: [
            { index: 1, title: 'Fix', detail: null, agents: 2, queued: 0, running: 1, done: 1, failed: 0, interrupted: 0 },
            { index: 2, title: 'Check', detail: null, agents: 0, queued: 0, running: 0, done: 0, failed: 0, interrupted: 0 },
          ],
          agents: liveAgents,
          agents_more: 0,
          logs: [],
          result_preview: null,
          error: null,
        },
      ],
    },
    { key: 'repair:1', role: 'repair', label: 'Repair 1', node_id: 'repair-1', lane: 'ui', session_id: '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9', records: 'none', reason: null, workflows: [] },
    { key: 'challenge:1', role: 'challenge', label: 'Design challenge attempt 1', node_id: 'challenge', lane: null, session_id: '11223344-5566-7788-99aa-bbccddeeff00', records: 'unreadable', reason: 'The session folder could not be read', workflows: [] },
  ],
  totals: { sessions_with_teams: 1, workflows: 2, workflows_running: 1, agents: 8, queued: 0, running: 1, done: 6, failed: 1, interrupted: 0, tool_calls: 352 },
}

/** A run branch pushed with an open draft pull request whose checks are failing and which waits on one requested team. */
export const runGithub: RunGithub = {
  contract_version: '1.0.0',
  project_id: 'md-manager',
  workflow_id: 'feature-implementation',
  run_id: 'run-001',
  read_at: '2026-10-16T10:00:00Z',
  repo: { status: 'github', reason: null, owner_name: 'kleros/vea', url: 'https://github.com/kleros/vea', remote: 'origin', default_branch: 'dev' },
  github: { status: 'read', reason: null, read_at: '2026-10-16T09:59:10Z', viewer_login: 'mani99brar', visibility: 'PUBLIC', viewer_permission: 'MAINTAIN' },
  branch: {
    name: 'feature/relayer-revert-shapes/run-001',
    local_sha: '6b6d894aa1b2c3d4e5f60718293a4b5c6d7e8f90',
    tracking_sha: '6b6d894aa1b2c3d4e5f60718293a4b5c6d7e8f90',
    github_sha: '6b6d894aa1b2c3d4e5f60718293a4b5c6d7e8f90',
    push_state: 'up_to_date',
    ahead_of_remote: 0,
    behind_remote: 0,
    ahead_of_default: 3,
    behind_default: 0,
    unpublished: [],
    unpublished_more: 0,
    integrated_commit: '6b6d894aa1b2c3d4e5f60718293a4b5c6d7e8f90',
    contains_integrated: true,
  },
  pr: {
    number: 531,
    title: 'relayer: classify revert shapes (run-001)',
    url: 'https://github.com/kleros/vea/pull/531',
    state: 'OPEN',
    draft: true,
    author: 'mani99brar',
    head_ref: 'feature/relayer-revert-shapes/run-001',
    base_ref: 'dev',
    head_sha: '6b6d894aa1b2c3d4e5f60718293a4b5c6d7e8f90',
    updated_at: '2026-10-16T09:58:00Z',
    merged_at: null,
    review_decision: 'REVIEW_REQUIRED',
    mergeable: 'MERGEABLE',
    comments: 2,
    review_threads: 3,
    unresolved_threads: 1,
    requested_reviewers: [{ kind: 'team', login: 'kleros/vea-maintainers' }, { kind: 'user', login: 'jaybuidl' }],
    latest_reviews: [{ author: 'gitguardian', state: 'COMMENTED', submitted_at: '2026-10-16T09:50:00Z' }],
    checks: {
      state: 'FAILURE',
      passing: 14,
      failing: 1,
      pending: 1,
      skipped: 1,
      total: 17,
      items: [
        { name: 'relayer-cli / unit', kind: 'check_run', status: 'COMPLETED', conclusion: 'FAILURE', bucket: 'fail', url: 'https://github.com/kleros/vea/actions/runs/1/job/2' },
        { name: 'contracts / coverage', kind: 'check_run', status: 'IN_PROGRESS', conclusion: null, bucket: 'pending', url: null },
        { name: 'GitGuardian Security Checks', kind: 'status', status: null, conclusion: 'SUCCESS', bucket: 'pass', url: null },
      ],
    },
  },
  earlier_prs: [],
}

const PUBLIC_NOTE = 'kleros/vea is PUBLIC: anyone can read what this publishes.'

/** The actions as a paired browser sees them for `runGithub`: the branch is pushed and a draft PR is open. */
export const runGithubActions: RunGithubActions = {
  version: '1.0.0',
  enabled: true,
  state_token: 'gh-3f9a1c2b7d6e5f40',
  repo: 'kleros/vea',
  visibility: 'PUBLIC',
  actions: [
    { id: 'push_branch', label: 'Push branch', available: false, reason: 'The branch is already on GitHub at the same commit', command: 'python -m workflow github push run-001 --repo ~/dev/vea-cook-relayer-revert-shapes --sha 6b6d894aa1b2 --by operator', confirm: 'typed_repo', params: [{ name: 'confirm_repo', kind: 'typed', required: true }], defaults: {}, effect: 'Pushes the run branch to origin without force, so GitHub has it.', not_effect: 'It never force-pushes, never pushes another branch and never opens a pull request.', publishes: `0 commits; ${PUBLIC_NOTE}` },
    { id: 'open_pr', label: 'Open draft pull request', available: false, reason: 'Pull request #531 is already open for this branch', command: 'python -m workflow github pr run-001 --repo ~/dev/vea-cook-relayer-revert-shapes --base dev --title <title> --body-file <body> --by operator', confirm: 'typed_repo', params: [{ name: 'title', kind: 'text', min_length: 1, max_length: 256, required: true }, { name: 'body', kind: 'multiline', min_length: 1, max_length: 60000, required: true }, { name: 'confirm_repo', kind: 'typed', required: true }], defaults: {}, effect: 'Opens a draft pull request from the run branch into dev.', not_effect: 'It requests no reviewers and merges nothing.', publishes: `The title and body; ${PUBLIC_NOTE}` },
    { id: 'mark_ready', label: 'Mark ready for review', available: true, reason: null, command: 'python -m workflow github ready run-001 --repo ~/dev/vea-cook-relayer-revert-shapes --pr 531 --by operator', confirm: 'plain', params: [], defaults: {}, effect: 'Takes #531 out of draft so reviewers are notified.', not_effect: 'It merges nothing and changes no code.', publishes: 'Notifies the requested reviewers.' },
    { id: 'request_reviewers', label: 'Request reviewers', available: true, reason: null, command: 'python -m workflow github reviewers run-001 --repo ~/dev/vea-cook-relayer-revert-shapes --pr 531 --add <reviewers> --by operator', confirm: 'plain', params: [{ name: 'reviewers', kind: 'list', max_items: 15, suggestions: ['jaybuidl', 'kleros/vea-maintainers'], required: true }], defaults: { reviewers: [] }, effect: 'Asks the named people or teams to review #531.', not_effect: 'It removes no reviewer and approves nothing.', publishes: 'GitHub notifies each reviewer.' },
  ],
  records: [
    { record_id: 'g-0a1b2c3d4e5f', request_id: '1b4e28ba-2fa1-4d3b-8b2c-6a1f0e9d8c7b', action: 'open_pr', params: { title: 'relayer: classify revert shapes (run-001)', body_chars: 812 }, command: 'python -m workflow github pr run-001 --repo ~/dev/vea-cook-relayer-revert-shapes --base dev --title <title> --body-file <body> --by operator', status: 'succeeded', exit_code: 0, started_at: '2026-10-16T09:57:40Z', ended_at: '2026-10-16T09:57:44Z', output_tail: ['https://github.com/kleros/vea/pull/531'], url: 'https://github.com/kleros/vea/pull/531' },
  ],
}
