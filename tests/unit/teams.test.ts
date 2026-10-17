/**
 * The Team view's pure model (src/projects/teams/model.ts, docs/PRD_RUN_TEAMS.md 3, 5, 6, 10 and 11 P0 items 3-6): lane
 * grouping, the attention line's rules, the workflow card's facts and status lines, the phase strip, the roster's grouping,
 * folding and filters, Working now, the two computed flags (every case of section 3.7), the accessible names, and what the
 * run view, the dock, the Sessions table and the node page read. Payloads are the contract example `teams` and the
 * `ux-teams.ts` fixtures the browser specs open.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { teams as example } from '../../contracts/projects/teamExamples.ts'
import { validateTeams, type TeamAgent, type Teams } from '../../contracts/projects/teams.ts'
import {
  agentMatches, agentName, attentionLine, attentionRules, BAR_WIDTH, cardStartsOpen, countsText, dockTeamLine, durationFraction, filterActive, filteredAgents, filterFor, FILTERS_FROM,
  headSentence, idleLine, isComparablePath, longestDuration, roleChoices, ROLES_FROM,
  isOutside, laneGroups, NO_FILTER, noResultText, outsideCopy, outsideFiles, ownedPathsOf, phaseSegments, quietMinutes, recordSource, ROW_LIMIT, rosterGroups, scopeLine,
  sessionOutsideFiles, sessionSentence, sessionTeamFacts, sheetShowsTeam, sheetWorkflowLine, stageTeam, stageTeamName, stateChoices, teamChanges, teamSectionEntry,
  teamSessionsOf, teamSuffix, workflowFacts, workflowStatusLine, workingFoldLine, workingRows, workingTitle, type AttentionContext, type LaneWorker,
} from '../../src/projects/teams/model.ts'
import { stageExecutor, TEAM_EXECUTOR } from '../../src/projects/signal/executor.ts'
import { launchSectionEntries } from '../../src/projects/node/launch.ts'
import {
  baseTeams, failedTeams, interruptedTeams, killedTeams, largeTeams, liveTeams, noneTeams, TEAMS_NOW, teamAgent, teamSession, teamsPayload, teamWorkflow, unreadableTeams,
} from '../project-workflows/fixtures/ux-teams.ts'

const CLOCK = Date.parse(TEAMS_NOW)
/** The core inputs' lanes: ui owns the frontend paths, adapter the server. */
const WORKERS: LaneWorker[] = [
  { node_id: 'ui', launch_node_id: 'launch_ui', owned_paths: ['src/App.tsx', 'src/App.css', 'src/projects', 'tests/project-workflows'] },
  { node_id: 'adapter', launch_node_id: 'launch_adapter', owned_paths: ['server', 'config/projects.example.json'] },
]
const context = (teams: Teams, running: (key: string) => boolean = () => false): AttentionContext => ({
  owned: session => ownedPathsOf(session, WORKERS), running: session => running(session.key), readAt: teams.read_at, clock: CLOCK,
})
const lane = (teams: Teams, id: string) => laneGroups(teams, WORKERS).lanes.find(group => group.lane === id)!

describe('the fixtures hold the contract', () => {
  test('every fixture payload passes validateTeams', () => {
    for (const payload of [baseTeams('r'), liveTeams('r'), largeTeams('r'), failedTeams('r'), killedTeams('r'), interruptedTeams('r'), noneTeams('r'), unreadableTeams('r')]) validateTeams(payload)
  })
  test('the model is pure: no React, no .tsx import', () => {
    const source = readFileSync(new URL('../../src/projects/teams/model.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(source, /from 'react'|\.tsx'/)
  })
})

describe('the Team suffix (2)', () => {
  test('running with failures, failed alone, interrupted, ended, none', () => {
    assert.deepEqual(teamSuffix(example), { tone: 'run', word: '1 running · 1 failed', spoken: '1 agent running, 1 failed' })
    assert.deepEqual(teamSuffix(failedTeams('r')), { tone: 'fail', word: '1 failed', spoken: '1 agent failed' })
    assert.deepEqual(teamSuffix(interruptedTeams('r')), { tone: 'pause', word: 'interrupted', spoken: 'a team workflow was interrupted' })
    assert.equal(teamSuffix(killedTeams('r'))?.word, '3 agents')
    assert.equal(teamSuffix(killedTeams('r'))?.tone, null)
    assert.equal(teamSuffix(noneTeams('r')), null)
    assert.equal(teamSuffix(null), null)
  })
})

describe('lanes (3.1)', () => {
  test('one lane per inputs worker in definition order, sessions in payload order, laneless sessions are other', () => {
    const { lanes, other } = laneGroups(example, WORKERS)
    assert.deepEqual(lanes.map(group => group.lane), ['ui', 'adapter'])
    assert.deepEqual(lanes[0]!.sessions.map(session => session.key), ['worker:ui', 'repair:1'])
    assert.equal(lanes[0]!.launchNodeId, 'launch_ui')
    assert.deepEqual(lanes[1]!.sessions, [])
    assert.deepEqual(other.map(session => session.key), ['challenge:1'])
  })
  test('without inputs, the lanes come from the payload', () => {
    const { lanes } = laneGroups(example, null)
    assert.deepEqual(lanes.map(group => [group.lane, group.launchNodeId, group.worker]), [['ui', 'launch_ui', null]])
  })
  test('the head sentence counts lanes, teams, workflows, agents and running agents, then the read age', () => {
    const { lanes } = laneGroups(example, WORKERS)
    assert.equal(headSentence(example, lanes, CLOCK), '2 lanes · 1 with a team · 2 workflows · 8 agents · 1 running now · read 8 s ago')
    assert.equal(headSentence(noneTeams('r'), laneGroups(noneTeams('r'), WORKERS).lanes, CLOCK), 'No session of this run has team records; every worker ran as a single session.')
  })
})

describe('the owned-paths flag (3.7)', () => {
  const owned = ['src/projects']
  test('server/x.ts is outside a lane owning src/projects; src/projects and src/projects/a.ts are inside', () => {
    assert.equal(isOutside('server/x.ts', owned), true)
    assert.equal(isOutside('src/projects', owned), false)
    assert.equal(isOutside('src/projects/a.ts', owned), false)
    assert.equal(isOutside('src/projectsX/a.ts', owned), true, 'a prefix only counts at a path boundary')
  })
  test('~/x, /x and redacted paths are not compared', () => {
    for (const path of ['~/x', '/x', '/home/someone/x.ts', '<path>/x.ts', '<redacted>']) {
      assert.equal(isComparablePath(path), false)
      assert.equal(isOutside(path, owned), false)
    }
  })
  test('only a worker session of a listed lane is compared; a repair, a laneless session or no inputs raise no flag', () => {
    const worker = example.sessions[0]!
    assert.deepEqual(ownedPathsOf(worker, WORKERS), WORKERS[0]!.owned_paths)
    assert.equal(ownedPathsOf({ role: 'repair', lane: 'ui' }, WORKERS), null)
    assert.equal(ownedPathsOf({ role: 'challenge', lane: null }, WORKERS), null)
    assert.equal(ownedPathsOf(worker, null), null)
    assert.equal(ownedPathsOf({ role: 'worker', lane: 'docs' }, WORKERS), null)
    assert.deepEqual(outsideFiles({ files_edited: ['server/x.ts'] }, null), [])
  })
  test('only the listed files are compared (files_edited_more stays uncompared)', () => {
    const agent = teamAgent(1, { label: 'x', state: 'done', files_edited: ['src/projects/a.ts'], files_edited_more: 7 })
    assert.deepEqual(outsideFiles(agent, owned), [])
  })
  test('the example worker edited two server files from lane ui; the copy names the lane\'s paths', () => {
    assert.deepEqual(sessionOutsideFiles(example.sessions[0]!, WORKERS[0]!.owned_paths), ['server/teams.ts', 'server/teams.test.ts'])
    assert.equal(outsideCopy(['src/projects', 'server']), "Edited outside this lane's paths. Verification refuses a changed file outside them. This lane owns: src/projects, server.")
  })
  test('the flag never changes a step\'s tone: the team facts carry a count only', () => {
    const team = stageTeam(example, 'launch_ui', WORKERS)!
    assert.equal(team.outside, 2)
    assert.equal('tone' in team, false)
  })
})

describe('the quiet flag (3.7)', () => {
  const readAt = '2026-10-16T10:00:00Z'
  test('holds at 10 minutes, not at 9; only for a running agent with a recorded last activity', () => {
    assert.equal(quietMinutes({ state: 'running', last_activity_at: '2026-10-16T09:50:00Z' }, readAt), 10)
    assert.equal(quietMinutes({ state: 'running', last_activity_at: '2026-10-16T09:51:00Z' }, readAt), null)
    assert.equal(quietMinutes({ state: 'running', last_activity_at: null }, readAt), null)
    assert.equal(quietMinutes({ state: 'done', last_activity_at: '2026-10-16T09:00:00Z' }, readAt), null)
  })
  test('the live fixture has one agent quiet for 12 minutes', () => {
    const live = liveTeams('r')
    const quiet = live.sessions.flatMap(session => session.workflows.flatMap(workflow => workflow.agents)).map(agent => quietMinutes(agent, live.read_at)).filter(value => value !== null)
    assert.deepEqual(quiet, [12])
  })
})

describe('the attention line (3.2)', () => {
  test('lane ui of the example: failed agents, then the owned-paths flag (the first sets the tone)', () => {
    const rules = attentionRules(lane(example, 'ui').sessions, context(example))
    assert.deepEqual(rules.map(rule => rule.tone), ['fail', 'fail', 'run'])
    assert.deepEqual(attentionLine(lane(example, 'ui').sessions, context(example)), { text: "1 agent failed in Review · 2 files edited outside this lane's paths", tone: 'fail' })
  })
  test('rule 1, unreadable', () => {
    const teams = unreadableTeams('r')
    assert.deepEqual(attentionLine(lane(teams, 'ui').sessions, context(teams)), { text: 'Team records could not be read: The session folder could not be read.', tone: 'idle' })
  })
  test('rule 3, interrupted, names the phase it stopped in', () => {
    const teams = interruptedTeams('r')
    assert.equal(attentionLine(lane(teams, 'ui').sessions, context(teams))?.text, 'wire-the-dock was interrupted in Test; no summary was written')
    assert.equal(attentionLine(lane(teams, 'ui').sessions, context(teams))?.tone, 'pause')
  })
  test('rules 5 and 6, running with the phases and the last activity, then quiet', () => {
    const teams = liveTeams('r')
    assert.deepEqual(attentionLine(lane(teams, 'ui').sessions, context(teams)), { text: '5 running in Implement, Review · last activity 18 s ago · 1 quiet for 12m or more', tone: 'run' })
  })
  test('rule 7, killed', () => {
    const teams = killedTeams('r')
    assert.deepEqual(attentionRules(lane(teams, 'ui').sessions, context(teams)).at(-1), { text: 'rename-everything was killed', tone: 'idle' })
  })
  test('rule 8, every workflow completed', () => {
    const completed = teamsPayload('r', [teamSession({ key: 'worker:ui', role: 'worker', label: 'Worker · ui', node_id: 'launch_ui', lane: 'ui', session_id: 's', workflows: [teamWorkflow({ run_id: 'wf_a', status: 'completed', duration_ms: 125000, phaseTitles: [], agents: [teamAgent(1, { label: 'a', state: 'done' })] })] })])
    assert.deepEqual(attentionLine(lane(completed, 'ui').sessions, context(completed)), { text: 'Done · 1 workflow · 1 agent · 2m05s of workflow time', tone: 'ok' })
  })
  test('rules 9 and 10, records none while the lead runs and after it ended', () => {
    const teams = noneTeams('r')
    assert.deepEqual(attentionLine(lane(teams, 'ui').sessions, context(teams, () => true)), { text: 'No team workflow recorded yet; the lead session is working on its own.', tone: 'idle' })
    assert.deepEqual(attentionLine(lane(teams, 'ui').sessions, context(teams)), { text: 'Single session, no team records.', tone: null })
  })
  test('session sentences: none (running or ended) and unreadable', () => {
    const none = noneTeams('r').sessions[0]!
    assert.equal(sessionSentence(none, true), 'No team workflow recorded yet; the lead session is working on its own.')
    assert.equal(sessionSentence(none, false), 'Single session, no team records. This session ran on its own; its row is in the Sessions table.')
    assert.equal(sessionSentence(unreadableTeams('r').sessions[0]!, false), 'Team records could not be read: The session folder could not be read.')
    assert.equal(sessionSentence(example.sessions[0]!, false), null)
  })
})

describe('the workflow card (3.3)', () => {
  const [finished, live] = example.sessions[0]!.workflows
  test('the latest and every running, failed or interrupted card start open', () => {
    assert.equal(cardStartsOpen(finished!, false), false)
    assert.equal(cardStartsOpen(live!, true), true)
    assert.equal(cardStartsOpen({ status: 'failed' }, false), true)
    assert.equal(cardStartsOpen({ status: 'interrupted' }, false), true)
    assert.equal(cardStartsOpen({ status: 'killed' }, false), false)
  })
  test('facts: ran, agents, tool calls, context, default model; a live one runs "for", its context arrives later', () => {
    assert.deepEqual(workflowFacts(finished!, CLOCK), ['ran 41m27s', '6 agents', '299 tool calls', 'context 519,890', 'default model claude-opus-5-5'])
    assert.deepEqual(workflowFacts(live!, CLOCK), ['for 13m38s', '2 agents', '53 tool calls', 'context arrives with the final summary', 'default model not recorded'])
    assert.equal(workflowFacts(largeTeams('r').sessions[0]!.workflows[0]!, CLOCK)[1], '400 of 512 agents listed')
  })
  test('the record source', () => {
    assert.equal(recordSource(finished!, example.read_at, CLOCK), 'from the final summary')
    assert.equal(recordSource(live!, example.read_at, CLOCK), 'from the live records, read 8 s ago')
  })
  test('status lines by status', () => {
    assert.equal(workflowStatusLine(live!), null)
    assert.deepEqual(workflowStatusLine(finished!), { text: "Workflow completed; the lane's verification is separate.", tone: null })
    assert.deepEqual(workflowStatusLine({ status: 'failed', error: 'boom' }), { text: 'boom', tone: 'fail' })
    assert.deepEqual(workflowStatusLine({ status: 'failed', error: null }), { text: 'The summary records no error text.', tone: null })
    assert.match(workflowStatusLine({ status: 'killed', error: null })!.text, /^This workflow was stopped before it finished/)
    assert.match(workflowStatusLine({ status: 'interrupted', error: null })!.text, /^No summary was written/)
  })
})

describe('the phase strip (3.4)', () => {
  test('tone by precedence, the non-zero counts, "not started" for an all-zero phase, never a percentage', () => {
    const segments = phaseSegments(example.sessions[0]!.workflows[0]!.phases)
    assert.deepEqual(segments.map(segment => [segment.tone, segment.counts]), [['ok', '2 done'], ['ok', '2 done'], ['fail', '1 failed · 1 done']])
    const live = phaseSegments(example.sessions[0]!.workflows[1]!.phases)
    assert.deepEqual(live.map(segment => [segment.tone, segment.counts, segment.notStarted]), [['run', '1 running · 1 done', false], ['idle', 'not started', true]])
    assert.equal(phaseSegments(killedTeams('r').sessions[0]!.workflows[0]!.phases)[0]!.tone, 'pause')
    for (const segment of [...segments, ...live]) assert.doesNotMatch(segment.counts, /%| of /)
    assert.equal(countsText({ queued: 6, running: 0, done: 0, failed: 0, interrupted: 0 }), '6 queued')
  })
})

describe('the roster (3.5)', () => {
  const large = largeTeams('r').sessions[0]!.workflows[0]!
  test('groups by phase in index order, "No phase recorded" last, rows in index order', () => {
    const workflow = teamWorkflow({ run_id: 'wf_b', status: 'completed', phaseTitles: ['One'], agents: [teamAgent(2, { label: 'b', state: 'done', phase_index: 1, phase: 'One' }), teamAgent(1, { label: 'a', state: 'done' }), teamAgent(3, { label: 'c', state: 'done', phase_index: 1, phase: 'One' })] })
    const groups = rosterGroups(workflow)
    assert.deepEqual(groups.map(group => [group.title, group.agents.map(agent => agent.index)]), [['1 · One', [2, 3]], ['No phase recorded', [1]]])
  })
  test('teams-large: done-only groups over six agents fold; running or failed groups open; at most 20 rows show', () => {
    const groups = rosterGroups(large)
    assert.deepEqual(groups.map(group => [group.title, group.agents.length, group.startsOpen]), [
      ['1 · Understand', 60, false], ['2 · Plan', 40, false], ['3 · Implement', 120, true], ['4 · Review', 100, false], ['5 · Fix', 70, true], ['6 · Check', 10, false],
    ])
    assert.equal(ROW_LIMIT, 20)
    assert.ok(large.agents.length > FILTERS_FROM)
  })
  test('state choices hide empty states, All always shows', () => {
    assert.deepEqual(stateChoices(large.agents).map(choice => `${choice.label} ${choice.count}`), ['All 400', 'Running 6', 'Failed 5', 'Queued 10', 'Done 379'])
  })
  test('filters: state, phase, outside, and the search over label, role, #index, agent id and edited path', () => {
    const failed = filteredAgents(large, { ...NO_FILTER, state: 'failed' }, null)
    assert.deepEqual(failed.map(agent => agent.index), [101, 102, 103, 104, 105])
    assert.equal(scopeLine(failed.length, large.agents.length), 'Showing 5 of 400 agents')
    assert.equal(filteredAgents(large, { ...NO_FILTER, phase: 6 }, null).length, 10)
    assert.deepEqual(filteredAgents(large, { ...NO_FILTER, q: '#7' }, null).map(agent => agent.index), [7, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79])
    const agent = example.sessions[0]!.workflows[0]!.agents[3]!
    assert.equal(agentMatches(agent, { ...NO_FILTER, q: 'server/teams.test' }, null), true)
    assert.equal(agentMatches(agent, { ...NO_FILTER, q: 'IMPL' }, null), true)
    assert.equal(agentMatches(agent, { ...NO_FILTER, q: agent.agent_id! }, null), true)
    assert.equal(agentMatches(agent, { ...NO_FILTER, outside: true }, WORKERS[0]!.owned_paths), true)
    assert.equal(agentMatches(example.sessions[0]!.workflows[0]!.agents[0]!, { ...NO_FILTER, outside: true }, WORKERS[0]!.owned_paths), false)
  })
  test('duplicate labels stay distinct agents by index', () => {
    const same = large.agents.filter(agent => agent.label === 'understand:frontend')
    assert.ok(same.length > 1)
    assert.equal(new Set(same.map(agent => agent.index)).size, same.length)
  })
})

describe('agent words (3.8, 10)', () => {
  test('the row\'s accessible name: label #index, state, phase, duration, tool calls, outside files, quiet', () => {
    const workflow = example.sessions[0]!.workflows[0]!
    assert.equal(agentName(workflow.agents[2]!, workflow.phases, CLOCK, 0), 'impl:frontend #3, done, Implement, 24 minutes, 96 tool calls')
    assert.equal(agentName(workflow.agents[3]!, workflow.phases, CLOCK, 2), 'impl:server #4, done, Implement, 21 minutes, 88 tool calls, 2 files outside lane paths')
    const live = liveTeams('r').sessions[0]!.workflows[0]!
    assert.equal(agentName(live.agents[2]!, live.phases, CLOCK, 0, liveTeams('r').read_at), 'impl:css #3, running, Implement, 17 minutes, 13 tool calls, quiet 12 minutes')
  })
  test('Returned when no result is recorded', () => {
    assert.equal(noResultText({ state: 'running' }), 'No result yet.')
    assert.equal(noResultText({ state: 'failed' }), 'failed · no reason recorded')
    assert.equal(noResultText({ state: 'interrupted' }), 'never finished')
  })
})

describe('Working now (3.6)', () => {
  test('every running agent across lanes, by started_at then index; the title counts lanes', () => {
    const teams = liveTeams('r')
    const rows = workingRows(teams)
    assert.deepEqual(rows.map(row => `${row.session.lane}:${row.agent.index}`), ['ui:2', 'ui:3', 'adapter:1', 'adapter:2', 'adapter:3', 'ui:4', 'ui:5', 'ui:6'])
    assert.equal(workingTitle(rows), 'Working now · 8 running in 2 lanes')
    assert.equal(workingFoldLine(teams), '8 running ›')
  })
  test('nothing running: the live and finished lines; absent without team records', () => {
    assert.equal(idleLine(killedTeams('r'), true, CLOCK), 'Nothing is running in any team. Last activity 48 min ago.')
    assert.equal(idleLine(killedTeams('r'), false, CLOCK), 'Nobody is working. 1 team workflow ran in 1 lane.')
    assert.equal(idleLine(noneTeams('r'), false, CLOCK), null)
  })
})

describe('run view integration (5)', () => {
  test('a step card\'s team facts from its found sessions; none for records none or another node', () => {
    const team = stageTeam(example, 'launch_ui', WORKERS)!
    assert.deepEqual(team, { workflows: 2, agents: 8, running: 1, failed: 1, outside: 2, agentLine: 'Fix · fix:finding-2 · Bash: npx tsx --test tests/unit/teams.test.ts', caption: null })
    assert.equal(stageTeamName(team), 'team of 8 agents, 1 running, 1 failed')
    assert.equal(stageTeam(noneTeams('r'), 'launch_ui', WORKERS), null)
    assert.equal(stageTeam(example, 'repair-1', WORKERS), null)
    assert.equal(stageTeam(null, 'launch_ui', WORKERS), null)
  })
  test('the executor word: team for a step with a team, the plain word otherwise', () => {
    const node = { projected: null, exec: 'agent' as const, kind: 'worker' as const, id: 'launch_ui' }
    assert.deepEqual(stageExecutor({ ...node, team: stageTeam(example, 'launch_ui', WORKERS) }), TEAM_EXECUTOR)
    assert.equal(TEAM_EXECUTOR.phrase, 'a lead session with a team of agents')
    assert.notEqual(stageExecutor({ ...node, team: null }).word, 'team')
  })
  test('the dock line: running agents, an interrupted workflow while live, else none', () => {
    assert.deepEqual(dockTeamLine(liveTeams('r'), true, CLOCK), { kind: 'running', text: 'Working now · 8 agents in 2 lanes · Implement, Read +2 · last activity 13 s ago ›' })
    assert.deepEqual(dockTeamLine(interruptedTeams('r'), true, CLOCK), { kind: 'interrupted', text: 'A team workflow in ui was interrupted · Team ›' })
    assert.equal(dockTeamLine(interruptedTeams('r'), false, CLOCK), null)
    assert.equal(dockTeamLine(noneTeams('r'), true, CLOCK), null)
  })
  test('the Sessions row facts', () => {
    assert.deepEqual(sessionTeamFacts(example, 'worker:ui'), { kind: 'found', text: 'team · 2 workflows · 8 agents' })
    assert.deepEqual(sessionTeamFacts(example, 'challenge:1'), { kind: 'unreadable', text: 'team records not read' })
    assert.equal(sessionTeamFacts(example, 'repair:1'), null)
    assert.equal(sessionTeamFacts(null, 'worker:ui'), null)
  })
  test('the sheet: a worker always, another node only for found or unreadable; one line per workflow', () => {
    assert.equal(sheetShowsTeam(teamSessionsOf(noneTeams('r'), 'launch_ui'), true), true)
    assert.equal(sheetShowsTeam(teamSessionsOf(example, 'repair-1'), false), false)
    assert.equal(sheetShowsTeam(teamSessionsOf(example, 'challenge'), false), true)
    assert.equal(sheetShowsTeam([], true), false)
    assert.equal(sheetWorkflowLine(example.sessions[0]!.workflows[1]!, CLOCK), '2 agents · 1 running · for 13m38s')
  })
})

describe('the node page (6)', () => {
  test('the Team index entry: the agents\' count, no count for a records-none worker, none otherwise; after Files, before Task', () => {
    assert.deepEqual(teamSectionEntry(teamSessionsOf(example, 'launch_ui'), true), { count: 8 })
    assert.deepEqual(teamSectionEntry(teamSessionsOf(noneTeams('r'), 'launch_ui'), true), { count: null })
    assert.equal(teamSectionEntry(teamSessionsOf(example, 'repair-1'), false), null)
    assert.deepEqual(teamSectionEntry(teamSessionsOf(example, 'challenge'), false), { count: null })
    const worker = { node_id: 'ui', questions: [] } as unknown as Parameters<typeof launchSectionEntries>[0]
    assert.deepEqual(launchSectionEntries(worker, null, null, { count: 8 }).map(entry => entry.key), ['report', 'team', 'task', 'session'])
    assert.deepEqual(launchSectionEntries(worker, null, null).map(entry => entry.key), ['report', 'task', 'session'])
  })
})

describe('the announcer (10)', () => {
  test('nothing on the first read; a status change, then a newly failed agent; never counts', () => {
    assert.deepEqual(teamChanges(null, example), [])
    assert.deepEqual(teamChanges(example, example), [])
    const next: Teams = structuredClone(example)
    const live = next.sessions[0]!.workflows[1]!
    live.status = 'completed'
    ;(live.agents[1] as TeamAgent).state = 'failed'
    assert.deepEqual(teamChanges(example, next), ['Workflow fix-review-findings in ui completed', 'fix:finding-2 #2 failed in Fix'])
  })
})

describe('P2: inline duration bars and the role filter (docs/PRD_RUN_TEAMS.md 11 items 14 and 15)', () => {
  const base = baseTeams('r').sessions[0]!.workflows[0]!
  test('a bar is the duration over the workflow\'s longest; absent when the duration is not recorded; never past full', () => {
    assert.equal(BAR_WIDTH, 48)
    assert.equal(longestDuration(base.agents), 1_450_000)
    const byIndex = (index: number) => base.agents.find(agent => agent.index === index)!
    assert.equal(durationFraction(byIndex(3), 1_450_000), 1, 'the longest agent fills the bar')
    assert.equal(durationFraction(byIndex(5), 1_450_000), 70_000 / 1_450_000)
    const unrecorded = teamAgent(9, { label: 'impl:x', state: 'running', duration_ms: null })
    assert.equal(durationFraction(unrecorded, 1_450_000), null, 'no bar without a recorded duration')
    assert.equal(longestDuration([unrecorded]), null)
    assert.equal(durationFraction(byIndex(3), null), null)
    assert.equal(durationFraction(teamAgent(10, { label: 'a', state: 'done', duration_ms: 0 }), 0), 0, 'a zero scale draws an empty bar, not NaN')
    assert.equal(durationFraction(teamAgent(11, { label: 'a', state: 'done', duration_ms: 2_000_000 }), 1_450_000), 1)
  })
  test('role chips: one per role in first-seen index order with counts, only from three roles; agents without a role are not a chip', () => {
    assert.equal(ROLES_FROM, 3)
    assert.deepEqual(roleChoices(base.agents), [{ role: 'map', count: 2 }, { role: 'impl', count: 2 }, { role: 'review', count: 2 }])
    assert.deepEqual(roleChoices(baseTeams('r').sessions[0]!.workflows[1]!.agents), [], 'one role: no chips')
    const two = [teamAgent(1, { label: 'a:x', state: 'done' }), teamAgent(2, { label: 'b:x', state: 'done' }), teamAgent(3, { label: 'plain', state: 'done' })]
    assert.equal(two[2]!.role, null)
    assert.deepEqual(roleChoices(two), [], 'two roles and a role-less agent: no chips')
    // Order follows index, whatever order the payload lists them in.
    assert.deepEqual(roleChoices([teamAgent(5, { label: 'c:x', state: 'done' }), teamAgent(1, { label: 'a:x', state: 'done' }), teamAgent(3, { label: 'b:x', state: 'done' })]).map(choice => choice.role), ['a', 'b', 'c'])
  })
  test('the role filter narrows the roster, counts as active, and composes with the other filters', () => {
    const query = { session: null, workflow: null, state: null, phase: null, q: '' }
    const filter = filterFor(query, { key: 'worker:ui' }, base, false, 'review')
    assert.equal(filter.role, 'review')
    assert.equal(filterActive(filter), true)
    assert.equal(filterActive(filterFor(query, { key: 'worker:ui' }, base, false)), false, 'no role by default')
    assert.deepEqual(filteredAgents(base, filter, null).map(agent => agent.index), [5, 6])
    assert.deepEqual(filteredAgents(base, { ...filter, state: 'failed' }, null).map(agent => agent.index), [5])
    assert.equal(agentMatches(base.agents[0]!, { ...NO_FILTER, role: 'review' }, null), false)
    // Another workflow's URL filter does not apply, but the card's own role still does.
    assert.equal(filterFor({ ...query, workflow: 'wf_other', state: 'failed' }, { key: 'worker:ui' }, base, false, 'map').state, null)
    assert.equal(filterFor({ ...query, workflow: 'wf_other' }, { key: 'worker:ui' }, base, false, 'map').role, 'map')
  })
})
