import type { RefObject } from 'react'
import type { TeamAgent } from '../../../contracts/projects/teams.ts'
import { AgentDrawer } from './AgentDrawer.tsx'
import { useTeam } from './context.ts'
import { agentKey, filteredAgents, filterFor, ownedPathsOf } from './model.ts'

/**
 * The drawer of the selected agent (docs/PRD_RUN_TEAMS.md 3.8): the selection's session, workflow and agent `index` (labels
 * repeat; the index is the key), from the URL on the Team view and from the page's own state on a node page. Previous and Next
 * walk the roster as its filter shows it, the card's outside-paths toggle and role chip included; closing hands the focus back to
 * the row that opened it (`opener`), or to the agent's row when that element is gone. A drawer the view opened with a pushed
 * history entry (`pushedRef`) closes by going back, so one Back after Close never lands on the same view again; a deep-linked
 * drawer closes by replacing the entry.
 */
export function DrawerHost({ opener, pushedRef }: { opener: RefObject<Element | null>; pushedRef?: RefObject<boolean> }) {
  const { teams, query, onQuery, workers, extras } = useTeam()
  if (query.session === null || query.workflow === null || query.agent === null) return null
  const session = teams.sessions.find(entry => entry.key === query.session) ?? null
  const workflow = session?.workflows.find(entry => entry.run_id === query.workflow) ?? null
  const agent = workflow?.agents.find(entry => entry.index === query.agent) ?? null
  if (session === null || workflow === null || agent === null) return null
  const owned = ownedPathsOf(session, workers)
  const { outside, role } = extras(session.key, workflow.run_id)
  const roster = filteredAgents(workflow, filterFor(query, session, workflow, outside, role), owned)
  const at = roster.findIndex(entry => entry.index === agent.index)
  const previous = at > 0 ? roster[at - 1] : null
  const next = at >= 0 && at < roster.length - 1 ? roster[at + 1] : null
  const walk = (target: TeamAgent) => onQuery({ ...query, agent: target.index }, 'replace')
  const close = () => {
    const key = agentKey(session.key, workflow.run_id, agent.index)
    const element = opener.current
    // The row re-renders with the same element; focus it once the drawer is gone.
    const focus = () => window.setTimeout(() => {
      const target = element instanceof HTMLElement && element.isConnected ? element : document.querySelector<HTMLElement>(`[data-agent-key="${CSS.escape(key)}"]`)
      target?.focus({ preventScroll: false })
    }, 0)
    if (pushedRef?.current) {
      pushedRef.current = false
      window.addEventListener('popstate', focus, { once: true })
      window.history.back()
      return
    }
    onQuery({ ...query, agent: null }, 'replace')
    focus()
  }
  return <AgentDrawer session={session} workflow={workflow} agent={agent} owned={owned} previous={previous} next={next} onWalk={walk} onClose={close} />
}
