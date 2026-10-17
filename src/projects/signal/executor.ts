/**
 * The executor wording a stage card shows ([L2], run-sessions). A projected session card names its own executor (a reviewer
 * or the panel), so the stage never calls a reviewer node "agent"; every pinned step keeps the kind's wording from
 * `src/projects/status.ts` (which is not an owned path, so it is read, not edited). The node-page header names a projected
 * node's executor with the same phrase as its card's accessible name, and a finished reviewer or lane review says its verdict
 * is on the page rather than "This step completed."; a pinned step's header keeps the kind's wording. A step whose session
 * ran an agent team says `team`, "a lead session with a team of agents" (docs/PRD_RUN_TEAMS.md 5). The unit tests cover
 * this wrapper.
 */
import type { ReviewResult } from '../api.ts'
import { isProjectedSessionNode } from '../sessions/model.ts'
import { executorOf, type Executor, type NodeKind } from '../status.ts'

type Projected = 'reviewer' | 'panel' | 'lane_review'

const EXECUTOR_WORD: Record<Executor, string> = { agent: 'agent', verifier: 'verifier', controller: 'controller' }

const PROJECTED_EXECUTOR: Record<Projected, { word: string; phrase: string }> = {
  panel: { word: 'panel', phrase: 'a multi-provider panel' },
  reviewer: { word: 'reviewer', phrase: 'one reviewer' },
  lane_review: { word: 'lane reviewer', phrase: 'one lane reviewer' },
}

/** Which projected session card a node id is ([L2]); null for a pinned step. */
export function projectedSessionKind(nodeId: string): Projected | null {
  if (!isProjectedSessionNode(nodeId)) return null
  return nodeId === 'panel' ? 'panel' : nodeId.startsWith('lane-review-') ? 'lane_review' : 'reviewer'
}

/** A lead session with a team of agents (docs/PRD_RUN_TEAMS.md 5): the card's row two reads `worker · team`. */
export const TEAM_EXECUTOR = { word: 'team', phrase: 'a lead session with a team of agents' } as const

export function stageExecutor(node: { projected: Projected | null; exec: Executor; kind: NodeKind; id: string; team?: unknown }): { word: string; phrase: string } {
  if (node.projected) return PROJECTED_EXECUTOR[node.projected]
  if (node.team) return TEAM_EXECUTOR
  return { word: EXECUTOR_WORD[node.exec], phrase: executorOf(node.kind, undefined, node.id) }
}

/** The node-page header's executor: a projected node's card phrase ("one reviewer"), else the kind's wording (`executorOf`). */
export function nodeExecutor(kind: NodeKind, transport: ReviewResult['reviewer']['transport'] | undefined, nodeId: string): string {
  const projected = projectedSessionKind(nodeId)
  return projected ? PROJECTED_EXECUTOR[projected].phrase : executorOf(kind, transport, nodeId)
}

/**
 * What a succeeded reviewer or lane-review node's header means (PRD 3.1, 3.2): the session finished and its verdict or result
 * follows on the page, which may be blocked; null for every other node (the Panel's line is its own).
 */
export function projectedSucceededMeaning(nodeId: string): string | null {
  const projected = projectedSessionKind(nodeId)
  if (projected === 'reviewer') return 'The reviewer finished; its verdict is below.'
  if (projected === 'lane_review') return 'The lane review finished; its result is below.'
  return null
}
