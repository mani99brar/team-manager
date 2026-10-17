/**
 * The Team view's model after the run-teams review (src/projects/teams/model.ts, docs/PRD_RUN_TEAMS.md 3, 5, 6): the lane
 * sentence of a lane without a team session (T2), the folded history (T3), the finished-run caption (T4), the drawer's walk with
 * the card's own filters (T5), Needs a look (T7), the view-wide search (T8), the clock and frozen durations (T9), workflow time
 * (T10), the step sheet's capped workflow lines (T11), the open and filter queries (T18), unreadable records in the head (T19),
 * the interrupted card's context (T20), the node page's entry while the teams load or failed (T21), listed versus ran agents
 * (T23), "Show {m} more" (T14) and the script log's label (T29). Payloads are the contract example and the `ux-teams.ts` fixtures.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { teams as example } from '../../contracts/projects/teamExamples.ts'
import type { TeamWorkflow } from '../../contracts/projects/teams.ts'
import {
  agentRanText, attentionRules, cardFilterQuery, earlierLine, earlierWorkflows, filteredAgents, filterFor, FINISHED_RUNNING_CAPTION, foldedFacts, frozenAtOf, headSentence,
  laneGroups, laneNoSessionSentence, logSummary, moreStep, needsALook, NO_FILTER, openQuery, ownedPathsOf, scopeLine, sheetWorkflowLine, sheetWorkflowPick, stageTeam, stageTeamName,
  teamClockOf, teamSectionEntryFor, viewScopeLine, workflowFacts, workflowMatches, workingCaption, type LaneWorker,
} from '../../src/projects/teams/model.ts'
import { interruptedTeams, largeTeams, liveTeams, noneTeams, TEAMS_NOW, teamAgent, teamSession, teamsPayload, teamWorkflow, unreadableTeams } from '../project-workflows/fixtures/ux-teams.ts'

const CLOCK = Date.parse(TEAMS_NOW)
const READ = Date.parse(example.read_at)
const WORKERS: LaneWorker[] = [
  { node_id: 'ui', launch_node_id: 'launch_ui', owned_paths: ['src/App.tsx', 'src/App.css', 'src/projects', 'tests/project-workflows'] },
  { node_id: 'adapter', launch_node_id: 'launch_adapter', owned_paths: ['server', 'config/projects.example.json'] },
]
const [finished, live] = example.sessions[0]!.workflows as [TeamWorkflow, TeamWorkflow]
const EMPTY = { session: null, workflow: null, agent: null, state: null, phase: null, q: '' }

describe('T2: a lane without a team session', () => {
  test('pending: not started; running or ended: no Claude team records, pointing to the Sessions row when there is one', () => {
    assert.equal(laneNoSessionSentence('pending', null), 'No Claude session of this lane has started yet.')
    const row = { key: 'worker:adapter' }
    assert.equal(laneNoSessionSentence('running', row), "This lane's session has no Claude team records (it ran on another transport or recorded no session id); its row is in the Sessions table.")
    assert.equal(laneNoSessionSentence('succeeded', row), "This lane's session has no Claude team records (it ran on another transport or recorded no session id); its row is in the Sessions table.")
    assert.equal(laneNoSessionSentence('failed', null), "This lane's session has no Claude team records (it ran on another transport or recorded no session id).")
  })
})

describe('T3: the folded history', () => {
  const many = (statuses: TeamWorkflow['status'][]) => statuses.map((status, index) => ({ run_id: `wf_${index}`, status }))
  test('at most four workflows: nothing is tucked away', () => {
    assert.deepEqual(earlierWorkflows(many(['completed', 'completed', 'completed', 'completed'])), [])
  })
  test('past four: the older completed and killed ones, in order; the latest and running, failed or interrupted ones stay out', () => {
    const workflows = many(['completed', 'failed', 'killed', 'completed', 'interrupted', 'completed', 'running', 'completed'])
    assert.deepEqual(earlierWorkflows(workflows).map(workflow => workflow.run_id), ['wf_0', 'wf_2', 'wf_3', 'wf_5'])
    assert.equal(earlierLine(4), 'Show 4 earlier workflows')
    assert.equal(earlierLine(1), 'Show 1 earlier workflow')
  })
  test('a folded card says its agents and its duration on its head row', () => {
    assert.equal(foldedFacts(finished, CLOCK), '6 agents · ran 41m27s')
  })
})

describe('T4: a finished run whose records still say running', () => {
  test('the caption only when the run finished and an agent reads running', () => {
    assert.equal(workingCaption(example, false), FINISHED_RUNNING_CAPTION)
    assert.equal(workingCaption(example, true), null)
    assert.equal(workingCaption(noneTeams('r'), false), null)
    assert.equal(workingCaption(null, false), null)
  })
  test('the step card names it in its accessible name', () => {
    const team = stageTeam(example, 'launch_ui', WORKERS, false)!
    assert.equal(team.caption, FINISHED_RUNNING_CAPTION)
    assert.equal(stageTeamName(team), `team of 8 agents, 1 running, 1 failed. ${FINISHED_RUNNING_CAPTION}`)
    assert.equal(stageTeam(example, 'launch_ui', WORKERS, true)!.caption, null)
  })
})

describe('T5: the walk follows the card\'s outside toggle and role chip', () => {
  const session = example.sessions[0]!
  const owned = ownedPathsOf(session, WORKERS)
  const query = { ...EMPTY, session: session.key, workflow: finished.run_id, agent: 4 }
  test('with a role', () => {
    assert.deepEqual(filteredAgents(finished, filterFor(query, session, finished, false, 'impl'), owned).map(agent => agent.index), [3, 4])
  })
  test('with the outside toggle', () => {
    assert.deepEqual(filteredAgents(finished, filterFor(query, session, finished, true, null), owned).map(agent => agent.index), [4])
  })
  test('with both', () => {
    assert.deepEqual(filteredAgents(finished, filterFor(query, session, finished, true, 'review'), owned).map(agent => agent.index), [])
    assert.deepEqual(filteredAgents(finished, filterFor(query, session, finished, true, 'impl'), owned).map(agent => agent.index), [4])
  })
})

describe('T7: Needs a look', () => {
  const look = (teams: typeof example) => needsALook(teams.sessions, { owned: session => ownedPathsOf(session, WORKERS), readAt: teams.read_at })
  test('failed agents, outside edits and unreadable sessions of the example, in that order', () => {
    assert.deepEqual(look(example).map(row => [row.kind, row.tone, row.text]), [
      ['failed', 'fail', 'review:gpt #5 failed in Review · build-run-teams · ui'],
      ['outside', 'fail', "impl:server #4 edited 2 files outside lane ui's paths · build-run-teams"],
      ['outside', 'fail', "fix:finding-1 #1 edited 1 file outside lane ui's paths · fix-review-findings"],
      ['unreadable', 'idle', 'Team records of Design challenge attempt 1 could not be read: The session folder could not be read.'],
    ])
  })
  test('a quiet agent in words only; an interrupted workflow; nothing for records none', () => {
    assert.deepEqual(look(liveTeams('r')).map(row => [row.kind, row.tone, row.text]), [['quiet', null, 'impl:css #3 quiet 12m · build-team-view · ui']])
    const interrupted = look(interruptedTeams('r'))
    assert.deepEqual(interrupted.map(row => [row.kind, row.tone, row.text, row.agent]), [['interrupted', 'pause', 'wire-the-dock was interrupted in Test; no summary was written · ui', null]])
    assert.deepEqual(look(noneTeams('r')), [])
  })
  test('agent rows carry the agent (they open its drawer); session and workflow rows do not', () => {
    const rows = look(example)
    assert.equal(rows[0]!.agent?.index, 5)
    assert.equal(rows.at(-1)!.agent, null)
    assert.equal(rows.at(-1)!.workflow, null)
  })
})

describe('T8: the view-wide search', () => {
  test('a workflow matches when one of its agents does; the scope line counts matches and the workflows holding them', () => {
    assert.equal(workflowMatches(finished, 'review'), true)
    assert.equal(workflowMatches(live, 'review'), false)
    assert.equal(workflowMatches(finished, ''), false)
    assert.equal(viewScopeLine(example, 'review'), 'Showing 2 of 8 agents in 1 workflow')
    assert.equal(viewScopeLine(example, 'fin'), 'Showing 2 of 8 agents in 1 workflow')
  })
  test('a partly listed team says listed and ran', () => {
    assert.equal(viewScopeLine(largeTeams('r'), '#7'), 'Showing 11 of 400 listed agents (512 ran) in 1 workflow')
  })
})

describe('T9: the clock never runs behind the read, and a finished run\'s running durations stop at the read', () => {
  test('teamClockOf: the later of the clock and the read', () => {
    assert.equal(teamClockOf(example, CLOCK), CLOCK)
    assert.equal(teamClockOf(example, READ - 60_000), READ)
  })
  test('live: durations follow the clock, with no suffix', () => {
    const running = live.agents.find(agent => agent.state === 'running')!
    assert.equal(frozenAtOf(example, true), null)
    assert.equal(agentRanText(running, CLOCK, frozenAtOf(example, true)), 'for 13m38s')
    assert.equal(workflowFacts(live, CLOCK, null)[0], 'for 13m38s')
  })
  test('finished: durations stop at the read (or a later last activity) and say "at last read", however late the page is opened', () => {
    const running = live.agents.find(agent => agent.state === 'running')!
    const frozen = frozenAtOf(example, false)
    assert.equal(frozen, READ)
    assert.equal(agentRanText(running, CLOCK, frozen), 'for 13m30s at last read')
    assert.equal(agentRanText(running, CLOCK + 17 * 3_600_000, frozen), 'for 13m30s at last read')
    assert.equal(workflowFacts(live, CLOCK + 17 * 3_600_000, frozen)[0], 'for 13m30s at last read')
    assert.equal(sheetWorkflowLine(live, CLOCK, frozen), '2 agents · 1 running · for 13m30s at last read')
    // An ended agent keeps its recorded duration.
    assert.equal(agentRanText(finished.agents[0]!, CLOCK, frozen), agentRanText(finished.agents[0]!, CLOCK, null))
  })
})

describe('T10: workflow time, not wall-clock', () => {
  test('rule 8 says "of workflow time"', () => {
    const completed = teamsPayload('r', [teamSession({ key: 'worker:ui', role: 'worker', label: 'Worker · ui', node_id: 'launch_ui', lane: 'ui', session_id: 's', workflows: [
      teamWorkflow({ run_id: 'wf_a', status: 'completed', duration_ms: 125000, phaseTitles: [], agents: [teamAgent(1, { label: 'a', state: 'done' }), teamAgent(2, { label: 'b', state: 'done' })] }),
    ] })])
    const sessions = laneGroups(completed, WORKERS).lanes[0]!.sessions
    assert.deepEqual(attentionRules(sessions, { owned: () => null, running: () => false, readAt: completed.read_at, clock: CLOCK }).at(-1), { text: 'Done · 1 workflow · 2 agents · 2m05s of workflow time', tone: 'ok' })
  })
})

describe('T11: the step sheet\'s workflow lines', () => {
  const entries = (statuses: TeamWorkflow['status'][]) => statuses.map((status, index) => ({ id: index, workflow: { status } }))
  test('running, failed and interrupted ones plus the latest, at most three, then a count', () => {
    const picked = sheetWorkflowPick(entries(['completed', 'completed', 'running', 'completed', 'completed']))
    assert.deepEqual(picked.shown.map(entry => entry.id), [2, 4])
    assert.deepEqual([picked.more, picked.word], [3, 'completed'])
    const crowded = sheetWorkflowPick(entries(['failed', 'interrupted', 'running', 'running', 'killed']))
    assert.deepEqual(crowded.shown.map(entry => entry.id), [0, 1, 4])
    assert.deepEqual([crowded.more, crowded.word], [2, null])
    assert.deepEqual(sheetWorkflowPick(entries(['completed', 'running'])).shown.map(entry => entry.id), [1])
  })
  test('one agent is "1 agent"', () => {
    const one = teamWorkflow({ run_id: 'wf_one', status: 'completed', duration_ms: 1000, phaseTitles: [], agents: [teamAgent(1, { label: 'a', state: 'done' })] })
    assert.match(sheetWorkflowLine(one, CLOCK), /^1 agent · /)
  })
})

describe('T14: Show more steps by twenty', () => {
  test('the next twenty, or what is left', () => {
    assert.equal(moreStep(20, 120), 20)
    assert.equal(moreStep(100, 120), 20)
    assert.equal(moreStep(110, 120), 10)
    assert.equal(moreStep(120, 120), 0)
  })
})

describe('T18: opening an agent and changing a card\'s filter', () => {
  test('an open keeps the filters of the same workflow or of a view-wide search, and resets another workflow\'s', () => {
    const scoped = { ...EMPTY, session: 'worker:ui', workflow: 'wf_a', state: 'failed' as const, phase: 2, q: 'x' }
    assert.deepEqual(openQuery(scoped, 'worker:ui', 'wf_a', 3), { ...scoped, agent: 3 })
    assert.deepEqual(openQuery(scoped, 'worker:ui', 'wf_b', 3), { session: 'worker:ui', workflow: 'wf_b', agent: 3, state: null, phase: null, q: '' })
    assert.deepEqual(openQuery({ ...EMPTY, q: 'review' }, 'worker:ui', 'wf_b', 5), { session: 'worker:ui', workflow: 'wf_b', agent: 5, state: null, phase: null, q: 'review' })
  })
  test('a filter change on another card closes the open drawer rather than retargeting it', () => {
    const open = { ...EMPTY, session: 'worker:ui', workflow: 'wf_a', agent: 4 }
    assert.equal(cardFilterQuery(open, 'worker:ui', 'wf_b', { ...NO_FILTER, state: 'done' }).agent, null)
    assert.equal(cardFilterQuery(open, 'worker:ui', 'wf_a', { ...NO_FILTER, state: 'done' }).agent, 4)
    assert.deepEqual(cardFilterQuery(open, 'worker:ui', 'wf_b', { ...NO_FILTER, phase: 1 }), { session: 'worker:ui', workflow: 'wf_b', agent: null, state: null, phase: 1, q: '' })
  })
})

describe('T19 and T23: the head sentence', () => {
  test('unreadable records are not told as single sessions', () => {
    const teams = unreadableTeams('r')
    assert.equal(headSentence(teams, laneGroups(teams, WORKERS).lanes, CLOCK), 'Team records of 1 session could not be read; 1 other session ran as a single session.')
    const all = teamsPayload('r', [teamSession({ key: 'worker:ui', role: 'worker', label: 'Worker · ui', node_id: 'launch_ui', lane: 'ui', session_id: 's', reason: 'unreadable' })])
    assert.equal(headSentence(all, laneGroups(all, WORKERS).lanes, CLOCK), 'Team records of 1 session could not be read.')
    assert.equal(headSentence(noneTeams('r'), laneGroups(noneTeams('r'), WORKERS).lanes, CLOCK), 'No session of this run has team records; every worker ran as a single session.')
  })
  test('a partly listed team counts the agents that ran and says how many are listed', () => {
    const teams = largeTeams('r')
    assert.equal(headSentence(teams, laneGroups(teams, WORKERS).lanes, CLOCK), '2 lanes · 1 with a team · 1 workflow · 400 of 512 agents listed · 6 running now · read 8 s ago')
    assert.equal(scopeLine(6, 400, 512), 'Showing 6 of 400 listed agents (512 ran)')
    assert.equal(scopeLine(5, 61), 'Showing 5 of 61 agents')
  })
})

describe('T20: an interrupted card does not promise a summary', () => {
  test('context arrives only while running', () => {
    const interrupted = interruptedTeams('r').sessions[0]!.workflows[0]!
    assert.equal(interrupted.record, 'live')
    assert.equal(workflowFacts(interrupted, CLOCK)[3], 'context not recorded')
    assert.equal(workflowFacts(live, CLOCK)[3], 'context arrives with the final summary')
  })
})

describe('T21: the node page keeps a worker\'s Team section while the teams load or failed', () => {
  test('loading, idle and error give a worker an entry without a count; others none; ready reads the sessions', () => {
    for (const status of ['idle', 'loading', 'error'] as const) {
      assert.deepEqual(teamSectionEntryFor(status, null, 'launch_ui', true), { count: null })
      assert.equal(teamSectionEntryFor(status, null, 'repair-1', false), null)
    }
    assert.equal(teamSectionEntryFor('ready', null, 'launch_ui', true), null)
    assert.deepEqual(teamSectionEntryFor('ready', example, 'launch_ui', true), { count: 8 })
  })
})

describe('T29: the script log\'s label', () => {
  test('it counts the lines and says when a result is recorded', () => {
    assert.equal(logSummary({ logs: ['a', 'b'], result_preview: '{}' }), 'Script log and result (2 lines · result)')
    assert.equal(logSummary({ logs: ['a'], result_preview: null }), 'Script log and result (1 line)')
    assert.equal(logSummary({ logs: [], result_preview: 'x' }), 'Script log and result (result)')
  })
})
