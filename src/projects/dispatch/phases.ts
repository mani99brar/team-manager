/**
 * The step chart's shared axis of eight phases (docs/PRD_PROJECTS_DISPATCH.md 4.3, the mock-up's `PHASES`), and the map from
 * a run's own recorded step to its column. Every definition is the same pipeline with a different number of lanes, so phases
 * line up across features; a phase with several lanes draws one dot per lane.
 *
 * The map reads the step's `node_id` first and its `kind` only as a fallback ([L2], [P22]): recorded definitions give the
 * sidecar `kind: review` and repair nodes `kind: worker`, so `kind` first would place them in the wrong columns. `sidecar`
 * (kind review) is Launch and `repair-1` (kind worker) is Verify.
 */

export const PHASES = ['Challenge', 'Launch', 'Freeze', 'Verify', 'Candidate', 'Review', 'Approval', 'Integrate'] as const
export type Phase = (typeof PHASES)[number]

export const PHASE_CHALLENGE = 0
export const PHASE_LAUNCH = 1
export const PHASE_FREEZE = 2
export const PHASE_VERIFY = 3
export const PHASE_CANDIDATE = 4
export const PHASE_REVIEW = 5
export const PHASE_APPROVAL = 6
export const PHASE_INTEGRATE = 7

/**
 * The phase index of a step, from its `node_id` first (the exact pipeline nodes) and its `kind` as the fallback for a node
 * named by a definition this viewer does not know. A repair node (`repair-*`, kind worker) goes to Verify; the sidecar,
 * attack, critique and panel nodes (kind review) go to Launch and Review respectively.
 */
export function phaseOf(nodeId: string, kind: string): number {
  // node_id first: the known pipeline nodes.
  if (nodeId === 'challenge') return PHASE_CHALLENGE
  if (/^launch_/.test(nodeId) || nodeId === 'sidecar') return PHASE_LAUNCH
  if (nodeId === 'handoff') return PHASE_FREEZE
  if (/^verify_/.test(nodeId)) return PHASE_VERIFY
  if (/^candidate/.test(nodeId)) return PHASE_CANDIDATE
  if (/^review/.test(nodeId) || /^attack/.test(nodeId) || /^critique/.test(nodeId) || /^panel/.test(nodeId)) return PHASE_REVIEW
  if (nodeId === 'approval') return PHASE_APPROVAL
  if (nodeId === 'integrate') return PHASE_INTEGRATE
  if (/^repair-/.test(nodeId)) return PHASE_VERIFY
  // kind fallback.
  switch (kind) {
    case 'review': return PHASE_REVIEW
    case 'worker': return PHASE_LAUNCH
    case 'prepare': return PHASE_FREEZE
    case 'verification': return PHASE_VERIFY
    case 'integration': return PHASE_INTEGRATE
    default: return PHASE_VERIFY
  }
}
