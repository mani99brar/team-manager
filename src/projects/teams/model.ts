/**
 * The Team view's pure model (docs/PRD_RUN_TEAMS.md 3 "Team view" and 2 "Views and routing"). Pure: no React, no DOM, no
 * `.tsx` import. The scaffold holds only the switcher's Team suffix; the Team view lane adds the lane grouping, the
 * attention lines, the roster, the flags and the stage-card facts here.
 */
import type { Teams } from '../../../contracts/projects/teams.ts'
import type { Suffix } from '../tone.ts'

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/**
 * The Team segment's suffix (docs/PRD_RUN_TEAMS.md 2), the first rule that holds:
 * - `{n} running` (run), adding ` · {f} failed` when an agent failed, while an agent runs;
 * - `{f} failed` (fail) when an agent failed;
 * - `interrupted` (pause) when a workflow is interrupted and none runs;
 * - `{a} agents` (no tone) when every workflow ended, and likewise while a workflow runs between agents (nothing to tone);
 * - none when the teams were not read (null) or no session has team records.
 */
export function teamSuffix(teams: Teams | null): Suffix | null {
  if (teams === null || teams.totals.sessions_with_teams === 0) return null
  const { running, failed, agents, workflows_running: workflowsRunning } = teams.totals
  if (running > 0) {
    const word = failed > 0 ? `${running} running · ${failed} failed` : `${running} running`
    const spoken = failed > 0 ? `${plural(running, 'agent', 'agents')} running, ${failed} failed` : `${plural(running, 'agent', 'agents')} running`
    return { tone: 'run', word, spoken }
  }
  if (failed > 0) return { tone: 'fail', word: `${failed} failed`, spoken: `${plural(failed, 'agent', 'agents')} failed` }
  const interrupted = teams.sessions.some(session => session.workflows.some(workflow => workflow.status === 'interrupted'))
  if (interrupted && workflowsRunning === 0) return { tone: 'pause', word: 'interrupted', spoken: 'a team workflow was interrupted' }
  const word = plural(agents, 'agent', 'agents')
  return { tone: null, word, spoken: word }
}
