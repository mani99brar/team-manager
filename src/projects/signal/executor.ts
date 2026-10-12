/**
 * The executor wording a stage card shows ([L2], run-sessions). A projected session card names its own executor (a reviewer
 * or the panel), so the stage never calls a reviewer node "agent"; every pinned step keeps the kind's wording from
 * `src/projects/status.ts` (which is not an owned path, so it is read, not edited). The node-page header keeps the kind's
 * wording unchanged. The unit tests cover this wrapper.
 */
import { executorOf, type Executor, type NodeKind } from '../status.ts'

const EXECUTOR_WORD: Record<Executor, string> = { agent: 'agent', verifier: 'verifier', controller: 'controller' }

export function stageExecutor(node: { projected: 'reviewer' | 'panel' | 'lane_review' | null; exec: Executor; kind: NodeKind; id: string }): { word: string; phrase: string } {
  if (node.projected === 'panel') return { word: 'panel', phrase: 'a multi-provider panel' }
  if (node.projected === 'reviewer') return { word: 'reviewer', phrase: 'one reviewer' }
  if (node.projected === 'lane_review') return { word: 'lane reviewer', phrase: 'one lane reviewer' }
  return { word: EXECUTOR_WORD[node.exec], phrase: executorOf(node.kind, undefined, node.id) }
}
