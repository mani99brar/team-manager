import type { RefObject } from 'react'
import type { TeamAgent } from '../../../contracts/projects/teams.ts'
import { AgentDrawer } from './AgentDrawer.tsx'
import { useTeam } from './context.ts'
import { agentKey, filteredAgents, filterFor, ownedPathsOf } from './model.ts'

/**
 * The drawer of the selected agent (docs/PRD_RUN_TEAMS.md 3.8): the selection's session, workflow and agent `index` (labels
 * repeat; the index is the key), from the URL on the Team view and from the page's own state on a node page. Previous and Next
 * walk the roster as its filter shows it; closing hands the focus back to the row that opened it (`opener`), or to the agent's
 * row when that element is gone.
 */
export function DrawerHost({ opener }: { opener: RefObject<Element | null> }) {
  const { teams, query, onQuery, workers } = useTeam()
  if (query.session === null || query.workflow === null || query.agent === null) return null
  const session = teams.sessions.find(entry => entry.key === query.session) ?? null
  const workflow = session?.workflows.find(entry => entry.run_id === query.workflow) ?? null
  const agent = workflow?.agents.find(entry => entry.index === query.agent) ?? null
  if (session === null || workflow === null || agent === null) return null
  const owned = ownedPathsOf(session, workers)
  const roster = filteredAgents(workflow, filterFor(query, session, workflow, false), owned)
  const at = roster.findIndex(entry => entry.index === agent.index)
  const previous = at > 0 ? roster[at - 1] : null
  const next = at >= 0 && at < roster.length - 1 ? roster[at + 1] : null
  const walk = (target: TeamAgent) => onQuery({ ...query, agent: target.index }, 'replace')
  const close = () => {
    const key = agentKey(session.key, workflow.run_id, agent.index)
    const element = opener.current
    onQuery({ ...query, agent: null }, 'replace')
    // The row re-renders with the same element; focus it once the drawer is gone.
    window.setTimeout(() => {
      const target = element instanceof HTMLElement && element.isConnected ? element : document.querySelector<HTMLElement>(`[data-agent-key="${CSS.escape(key)}"]`)
      target?.focus({ preventScroll: false })
    }, 0)
  }
  return <AgentDrawer session={session} workflow={workflow} agent={agent} owned={owned} previous={previous} next={next} onWalk={walk} onClose={close} />
}
