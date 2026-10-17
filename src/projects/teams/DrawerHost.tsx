import type { RefObject } from 'react'
import type { TeamAgent } from '../../../contracts/projects/teams.ts'
import { AgentDrawer } from './AgentDrawer.tsx'
import { useTeam } from './context.ts'
import { teamQuerySearch } from '../routes.ts'
import { currentHistoryKey, drawerEntryKey } from './history.ts'
import { agentKey, closedQuery, closeMode, filteredAgents, filterFor, ownedPathsOf } from './model.ts'

/**
 * The drawer of the selected agent (docs/PRD_RUN_TEAMS.md 3.8): the selection's session, workflow and agent `index` (labels
 * repeat; the index is the key), from the URL on the Team view and from the page's own state on a node page. Previous and Next
 * walk the roster as its filter shows it, the card's outside-paths toggle and role chip included; closing hands the focus back to
 * the row that opened it (`opener`), or to the agent's row when that element is gone. On the Team view (`history`) one Close
 * always closes the drawer: when the current entry is the drawer entry the view pushed from a drawer-less entry it goes back,
 * then writes the filters and search changed while the drawer was open onto that entry, so one Back after Close leaves the view;
 * any other entry (a deep link, a reload) is replaced without the agent. A drawer opened from a view-wide search closes onto the
 * view-wide search.
 */
export function DrawerHost({ opener, history = false }: { opener: RefObject<Element | null>; history?: boolean }) {
  const { teams, query, wide = false, onQuery, workers, extras } = useTeam()
  if (query.session === null || query.workflow === null || query.agent === null) return null
  const session = teams.sessions.find(entry => entry.key === query.session) ?? null
  const workflow = session?.workflows.find(entry => entry.run_id === query.workflow) ?? null
  const agent = workflow?.agents.find(entry => entry.index === query.agent) ?? null
  if (session === null || workflow === null || agent === null) return null
  const owned = ownedPathsOf(session, workers)
  const { outside, role } = extras(session.key, workflow.run_id)
  const roster = filteredAgents(workflow, filterFor(query, session, workflow, outside, role, wide), owned)
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
    const closed = closedQuery(query, wide)
    if (history && closeMode(currentHistoryKey(), drawerEntryKey()) === 'back') {
      window.addEventListener('popstate', () => {
        // The entry the drawer was pushed from still holds the filters of that moment; keep the ones set since.
        if (teamQuerySearch(closed) !== window.location.search) onQuery(closed, 'replace')
        focus()
      }, { once: true })
      window.history.back()
      return
    }
    onQuery(closed, 'replace')
    focus()
  }
  return <AgentDrawer session={session} workflow={workflow} agent={agent} owned={owned} previous={previous} next={next} onWalk={walk} onClose={close} />
}
