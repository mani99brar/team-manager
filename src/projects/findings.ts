/**
 * How review findings are attributed to the lanes a run actually had. A finding's `worker` is a lane id, `multiple`
 * or `none`; exports of two-lane runs recorded `both`, which reads as `multiple`; null predates the vocabulary.
 * Pure helpers, kept out of the component file so it only exports components.
 */
import type { ReviewFinding, RunDetail, RunInputs } from './api.ts'
import type { Resource } from './useResource.ts'

type DefinitionNode = RunDetail['definition']['nodes'][number]

const MULTIPLE = 'multiple'
const LEGACY_MULTIPLE = 'both'
const NONE = 'none'
const UNRECORDED = 'unrecorded'
const SPECIAL_GROUPS: readonly string[] = [MULTIPLE, NONE, UNRECORDED]
const SPECIAL_LABEL: Record<string, string> = { [MULTIPLE]: 'Multiple workers', [NONE]: 'No worker (cross-cutting)', [UNRECORDED]: 'Worker not recorded' }

/** The group a finding belongs to when grouped by worker: a lane id, `multiple` (also for legacy `both`), `none` or `unrecorded`. */
export function workerGroupOf(finding: Pick<ReviewFinding, 'worker'>): string {
  if (finding.worker === null) return UNRECORDED
  if (finding.worker === LEGACY_MULTIPLE) return MULTIPLE
  return finding.worker
}

/** The Worker column wording: lane ids verbatim, the multi-lane values as words. */
export function workerWording(worker: string): string {
  if (worker === MULTIPLE || worker === LEGACY_MULTIPLE) return 'multiple workers'
  if (worker === NONE) return 'none'
  return worker
}

/**
 * The run's lanes in policy order: from the recorded inputs when loaded, else from the pinned graph's `launch_<id>`
 * nodes (the naming the exporter guarantees), so findings group by lane even for a run whose inputs are not recorded.
 */
export function runLanes(definitionNodes: DefinitionNode[], inputs: Resource<RunInputs | null>): string[] {
  if (inputs.status === 'ready' && inputs.data !== null) return inputs.data.workers.map(worker => worker.node_id)
  return definitionNodes.filter(node => node.kind === 'worker' && node.node_id.startsWith('launch_')).map(node => node.node_id.slice('launch_'.length))
}

/**
 * Worker groups in display order: the run's lanes, then any lane id a finding names that the run does not list
 * (never dropped), then `multiple`, `none` and `unrecorded`. Only populated groups are rendered.
 */
export function workerGroups(lanes: readonly string[], findings: readonly Pick<ReviewFinding, 'worker'>[]): { key: string; label: string }[] {
  const keys = [...lanes]
  for (const finding of findings) {
    const group = workerGroupOf(finding)
    if (!keys.includes(group) && !SPECIAL_GROUPS.includes(group)) keys.push(group)
  }
  return [...keys.map(lane => ({ key: lane, label: `Worker ${lane}` })), ...SPECIAL_GROUPS.map(key => ({ key, label: SPECIAL_LABEL[key] }))]
}
