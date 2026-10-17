/**
 * Parity of the teams fixtures (docs/PRD_RUN_TEAMS.md "Team reader", "Team view"): the candidate seed (`seedCandidate`, the
 * very function the browser suite's config calls) writes Claude Code's records for the `ux-teams` seeded runs under a temporary
 * Claude home, and the real server (`createApp` with the real `TeamReader`) serves from them a payload that validates with
 * `validateTeams` and equals the payload the worker-phase mock serves for the same run: the same sessions, workflows and agents
 * with the same states, facts and times (only `read_at` and a live workflow's journal-time `last_activity_at` are left out).
 * The `/sessions` payloads the mock serves for those runs equal the server's too, and the runs without records read `none`.
 * Every path is under a temporary root; the operator's `~/.claude`, `~/.config/md-manager` and GitHub are never read (the
 * seed runs without the dispatch option, so no git repository and no GitHub fixture is made).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateTeams, type Teams } from '../../contracts/projects/teams.ts'
import type { Sessions } from '../../contracts/projects/sessions.ts'
import { createApp } from '../../server/app.ts'
import { parseProjectsConfig } from '../../server/projectsConfig.ts'
import { claudeHomeOf } from '../../server/teams.ts'
import { seedCandidate } from '../project-workflows/seed.ts'
import { teamsByRun, sessionsByRun } from '../project-workflows/fixtures/index.ts'
import { TEAMS_RUNS, UX_TEAMS_WORKFLOW_ID } from '../project-workflows/fixtures/ux-teams.ts'
import { comparableTeams } from '../project-workflows/fixtures/teamRecords.ts'
import { PROJECT } from '../project-workflows/fixtures.ts'

type Served = { status: number; body: string }

async function withSeededServer(run: (get: (path: string) => Promise<Served>, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'md-manager-teams-seed-'))
  const previousNight = process.env.MD_MANAGER_NIGHT_SHIFT_DIR
  try {
    const configPath = seedCandidate(join(root, 'projects'))
    process.env.MD_MANAGER_NIGHT_SHIFT_DIR = join(root, 'projects', 'night-shift')
    const config = await parseProjectsConfig(await readFile(configPath, 'utf8'), configPath)
    // The Claude home exactly as the server resolves it from the browser suite's API environment.
    const claudeHome = claudeHomeOf({ MD_MANAGER_CLAUDE_HOME: join(root, 'claude-home') }, homedir())
    assert.equal(claudeHome, join(root, 'claude-home'))
    assert.ok(!claudeHome.startsWith(join(homedir(), '.claude')), 'the seeded Claude home is never the real one')
    const app = createApp([], { projects: config, runStore: { claudeHome } })
    try {
      await run(async path => {
        const response = await app.inject({ method: 'GET', url: path })
        return { status: response.statusCode, body: response.body }
      }, root)
    } finally {
      await app.close()
    }
  } finally {
    if (previousNight === undefined) delete process.env.MD_MANAGER_NIGHT_SHIFT_DIR
    else process.env.MD_MANAGER_NIGHT_SHIFT_DIR = previousNight
    await rm(root, { recursive: true, force: true })
  }
}

const runPath = (runId: string, route: string) => `/api/projects/${PROJECT.project_id}/workflows/${UX_TEAMS_WORKFLOW_ID}/runs/${runId}/${route}`

test('teams seed: the real reader serves the seeded records as the mock\'s payload, sessions, workflows, agents and states alike', async () => {
  await withSeededServer(async (get, root) => {
    for (const runId of [TEAMS_RUNS.seeded, TEAMS_RUNS.seededLive]) {
      const response = await get(runPath(runId, 'teams'))
      assert.equal(response.status, 200, `${runId}: ${response.body}`)
      const served: Teams = validateTeams(JSON.parse(response.body))
      const mocked = teamsByRun[runId]!
      assert.deepEqual(comparableTeams(served), comparableTeams(mocked), runId)
      assert.ok(served.totals.sessions_with_teams > 0, `${runId} has team records`)
      for (const leak of ['/home/', '/tmp/', root]) assert.ok(!response.body.includes(leak), `${runId}: ${leak} leaked`)
    }
    // The live run's ui workflow runs (its records were just written), the adapter's was interrupted (old records).
    const live = validateTeams(JSON.parse((await get(runPath(TEAMS_RUNS.seededLive, 'teams'))).body))
    assert.deepEqual(live.sessions.map(session => session.workflows.map(workflow => [workflow.run_id, workflow.status])), [[['wf_5eed1a7e-001', 'running']], [['wf_5eed1a7e-002', 'interrupted']]])
  })
})

test('teams seed: every other ux-teams run is served, its sessions with records none (or no session at all)', async () => {
  await withSeededServer(async get => {
    for (const runId of Object.values(TEAMS_RUNS)) {
      if (runId === TEAMS_RUNS.seeded || runId === TEAMS_RUNS.seededLive) continue
      const response = await get(runPath(runId, 'teams'))
      assert.equal(response.status, 200, `${runId}: ${response.body}`)
      const served = validateTeams(JSON.parse(response.body))
      const expected = runId === TEAMS_RUNS.empty ? [] : [['worker:ui', 'none'], ['worker:adapter', 'none']]
      // The base run's challenge attempt is a Claude session too (a print job), without records; it sorts last (no start).
      if (runId === TEAMS_RUNS.base) expected.push(['challenge:1', 'none'])
      assert.deepEqual(served.sessions.map(session => [session.key, session.records]), expected, runId)
      assert.equal(served.totals.sessions_with_teams, 0, runId)
    }
  })
})

test('teams seed: the mocked /sessions payloads of the ux-teams runs equal the server\'s for the same seed', async () => {
  await withSeededServer(async get => {
    const bare = (sessions: Sessions): Sessions => ({ ...sessions, sessions: sessions.sessions.map(row => ({ ...row, resume: row.resume && row.session_id ? { dir: null, command: `claude --resume ${row.session_id}` } : row.resume })) })
    for (const runId of [TEAMS_RUNS.base, TEAMS_RUNS.seeded]) {
      const response = await get(runPath(runId, 'sessions'))
      assert.equal(response.status, 200, `${runId}: ${response.body}`)
      assert.deepEqual(bare(JSON.parse(response.body) as Sessions), bare(sessionsByRun[runId]!), runId)
    }
  })
})
