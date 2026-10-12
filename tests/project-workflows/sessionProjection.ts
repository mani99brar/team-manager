/**
 * The worker-phase session-node projection ([L1]/[P2]/[L4]/[L5]/[L11], run-sessions). The mock injects the same reviewer/
 * panel/lane-review nodes, with the same statuses, the real server projects, so both phases show the same `data-node-id`
 * cards. It calls the server's own `projectSessionNodes` (the one pure function) with explicit inputs: per run the raw facts
 * its seed writes (`reviewerIds` of `UxPayloads`, which each fixture module fills from the builder its seed writes), falling
 * back to `rawReviewSection(runId)` for the core runs (none when the section or its list is absent, the server's raw rule),
 * whether the panels route answers (the mock's own panel map) and the lane-review records. The candidate-phase parity spec
 * proves the (node_id, status) pairs equal the real server's for every run the config serves.
 */
import { panelNodeStatus, projectSessionNodes, type SessionNodeInput } from '../../server/sessions.ts'
import type { RunDetail } from '../../contracts/projects/v1.ts'
import { panelResults, rawReviewSection } from './fixtures.ts'
import { reviewerIdsByRun, type SessionFacts } from './fixtures/index.ts'

const EXPORT_ORDER = ['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0', '1.5.0', '1.6.0', '1.7.0', '1.8.0', '1.9.0', '1.10.0', '1.11.0', '1.12.0']

/** The raw facts for a run: the module's own (from its seed's builders), else the core runs' raw review section. */
export function sessionFactsFor(runId: string): Required<Pick<SessionFacts, 'review' | 'version' | 'plan' | 'receipts' | 'laneReviews'>> {
  const facts: SessionFacts = reviewerIdsByRun[runId] ?? {}
  const core = rawReviewSection(runId)
  const review = facts.review !== undefined ? facts.review
    : core === null ? null : { reviewers: core.reviewers?.map(entry => ({ reviewer_id: entry.reviewer_id, status: entry.status })) ?? null }
  return {
    review,
    // The core seed's default export version (`seed.ts` `writeRun`); a module names its own when the plan fallback needs it.
    version: facts.version ?? '1.2.0',
    plan: facts.plan ?? [],
    receipts: facts.receipts ?? {},
    laneReviews: facts.laneReviews ?? [],
  }
}

/** The projection input for a run, built from the raw facts the way `server/projects.ts` `sessionNodeInput` builds it. */
export function sessionInputFor(detail: RunDetail): SessionNodeInput {
  const runId = detail.summary.run_id
  const facts = sessionFactsFor(runId)
  const panels = panelResults[runId]
  return {
    reviewSection: facts.review !== null,
    exportAtLeast140: EXPORT_ORDER.indexOf(facts.version) >= EXPORT_ORDER.indexOf('1.4.0'),
    rawReviewers: facts.review?.reviewers ?? null,
    planReviewerIds: facts.plan,
    receipts: Object.fromEntries(Object.entries(facts.receipts).map(([id, receipt]) => [id, { status: receipt.status, error: receipt.error ?? false }])),
    reviewNodeStatus: detail.snapshot.nodes.find(node => node.node_id === 'review')?.status ?? null,
    panelStatus: panels ? panelNodeStatus(panels) : null,
    laneReviews: facts.laneReviews,
    existingNodeIds: new Set(detail.definition.nodes.map(node => node.node_id)),
  }
}

/** The run detail with the projected session nodes joined (definition + snapshot), as `projectRun` does. */
export function injectSessionNodes(detail: RunDetail): RunDetail {
  const nodes = projectSessionNodes(detail.definition, sessionInputFor(detail))
  if (nodes.length === 0) return detail
  const gate = nodes.filter(node => node.projected !== 'lane_review').map(node => node.node_id)
  const withGate = <T extends { node_id: string; depends_on: string[] }>(arr: readonly T[]): T[] =>
    arr.map(node => node.node_id === 'review' && gate.length > 0 ? { ...node, depends_on: [...node.depends_on, ...gate] } : node)
  return {
    ...detail,
    definition: { ...detail.definition, nodes: [...withGate(detail.definition.nodes), ...nodes.map(node => ({ node_id: node.node_id, label: node.label, kind: node.kind, depends_on: [...node.depends_on] }))] },
    snapshot: { ...detail.snapshot, nodes: [...withGate(detail.snapshot.nodes), ...nodes.map(node => ({ node_id: node.node_id, kind: node.kind, depends_on: [...node.depends_on], status: node.status, attempt: node.status === 'pending' ? 0 : 1, session_id: node.session_id, result_uri: null, lane_results: [] }))] },
  }
}

/** The projected session nodes of a run as sorted `node_id:status` pairs (the parity spec compares these across phases). */
export function sessionNodePairs(detail: RunDetail): string[] {
  return projectSessionNodes(detail.definition, sessionInputFor(detail)).map(node => `${node.node_id}:${node.status}`).sort()
}
