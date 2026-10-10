/**
 * Fixtures of the operator override (`accepted.spec.ts`; docs/PRD_ACCEPT_OVERRIDE.md, decisions.md L8, L12), registered as the
 * workflow `ux-accepted`: mock payloads for the worker phase and a `seed` for the candidate phase, merged by `index.ts`.
 * Every run is a 1.12.0 export of the two-lane graph whose review blocked the candidate:
 * - `accepted-blocked`: never abandoned; accepted by the operator with a P1 and a P2 open (the fail-safe P1 that blocked it).
 * - `accepted-blocked-plain`: its twin without the record; it still reads `failed`.
 * - `accepted-abandoned`: abandoned, then accepted with no open findings (the review was recorded).
 * - `accepted-abandoned-plain`: its twin without the record; it still reads `cancelled`.
 */
import { join } from 'node:path'
import type { RunAccepted } from '../../../contracts/projects/v1.ts'
import {
  ADAPTER_ARTIFACTS, ADAPTER_SESSION, adapterResult, CANDIDATE_COMMIT, definition, done, event, GRAPH_NODES, OUTPUT_COMMIT_ADAPTER, OUTPUT_COMMIT_UI, PROJECT,
  runDetail, T1, T3, UI_ARTIFACTS, UI_SESSION, uiResult, type NodeState,
} from '../fixtures.ts'
import type { UxFixtureModule } from './index.ts'

export const UX_ACCEPTED_WORKFLOW_ID = 'ux-accepted'
export const UX_ACCEPTED_WORKFLOW_NAME = 'UX operator override'
export const RUN_ACCEPTED_BLOCKED = 'accepted-blocked'
export const RUN_ACCEPTED_BLOCKED_PLAIN = 'accepted-blocked-plain'
export const RUN_ACCEPTED_ABANDONED = 'accepted-abandoned'
export const RUN_ACCEPTED_ABANDONED_PLAIN = 'accepted-abandoned-plain'
export const ACCEPTED_REASON = 'Merged by hand: the one fail-safe P1 is a known gap with a follow-up tracked for the next run, and waiting for another review round would hold the whole release for a change nobody else depends on'
export const ABANDON_MESSAGE = 'Abandoned by the operator: usage limit; followed up by run-002. Stopped: review'
export const FAILSAFE_TITLE = 'The fail-safe path is not covered by a test'
export const STALE_TITLE = 'A code comment is stale'
export const ACCEPTED_AT = '2026-03-01T11:30:00Z'
export const BLOCKED_REVIEW_MESSAGE = 'Reviewer coverage blocked the candidate'

const FINDINGS = [
  { severity: 'P1', reviewer: 'coverage', title: FAILSAFE_TITLE, lane: 'adapter' },
  { severity: 'P2', reviewer: 'general', title: STALE_TITLE, lane: null },
] as const

/** accepted.json as the engine writes it (decisions.md L8). */
const exportRecord = (runId: string, openFindings: readonly object[]) => ({
  version: '1.0.0', run_id: runId, candidate: CANDIDATE_COMMIT, reason: ACCEPTED_REASON, by: 'operator', via: 'claude-code', accepted_at: ACCEPTED_AT,
  on_main: true, review: 'recorded', open_findings: openFindings,
})
/** The same record as the viewer serves it. */
const servedRecord = (openFindings: RunAccepted['open_findings'], abandoned: string | null): RunAccepted => ({
  candidate: CANDIDATE_COMMIT, reason: ACCEPTED_REASON, by: 'operator', accepted_at: ACCEPTED_AT, on_main: true, review: 'recorded', open_findings: [...openFindings], abandoned,
})

const UX_ACCEPTED_DEFINITION = definition(PROJECT.project_id, UX_ACCEPTED_WORKFLOW_ID, UX_ACCEPTED_WORKFLOW_NAME, GRAPH_NODES)

type Spec = { runId: string; abandoned: boolean; accepted: readonly object[] | null }
const SPECS: readonly Spec[] = [
  { runId: RUN_ACCEPTED_BLOCKED, abandoned: false, accepted: FINDINGS },
  { runId: RUN_ACCEPTED_BLOCKED_PLAIN, abandoned: false, accepted: null },
  { runId: RUN_ACCEPTED_ABANDONED, abandoned: true, accepted: [] },
  { runId: RUN_ACCEPTED_ABANDONED_PLAIN, abandoned: true, accepted: null },
]

const states: Record<string, NodeState> = {
  launch_ui: done(UI_SESSION, 'ui'), launch_adapter: done(ADAPTER_SESSION, 'adapter'), handoff: done(), verify_ui: done(undefined, 'ui'), verify_adapter: done(undefined, 'adapter'),
  candidate: done(), review: { status: 'failed', attempt: 1 },
}

/** The sequence of controller rows after the blocked review: the abandon row, then the accept row. */
const tail = (spec: Spec) => [
  ...spec.abandoned ? [{ status: 'cancelled', message: ABANDON_MESSAGE }] : [],
  ...spec.accepted ? [{ status: 'succeeded', message: `Accepted by the operator: ${ACCEPTED_REASON}` }] : [],
]

function statusOf(spec: Spec): 'succeeded' | 'cancelled' | 'failed' {
  return spec.accepted ? 'succeeded' : spec.abandoned ? 'cancelled' : 'failed'
}

function detailOf(spec: Spec) {
  const base = runDetail(spec.runId, statusOf(spec), UX_ACCEPTED_DEFINITION, T1, T3, states, 8 + tail(spec).length)
  if (!spec.accepted) return base
  const accepted = servedRecord(spec.accepted as RunAccepted['open_findings'], spec.abandoned ? ABANDON_MESSAGE : null)
  return { ...base, summary: { ...base.summary, accepted }, accepted }
}

export const uxAccepted: UxFixtureModule = {
  payloads: {
    workflows: [UX_ACCEPTED_DEFINITION],
    runDetails: Object.fromEntries(SPECS.map(spec => [spec.runId, detailOf(spec)])),
    runEvents: Object.fromEntries(SPECS.map(spec => [spec.runId, [
      event(spec.runId, 1, { type: 'status_changed', node_id: 'candidate', attempt: 1, status: 'succeeded', message: 'Combined candidate checks passed' }),
      event(spec.runId, 2, { type: 'status_changed', node_id: 'review', attempt: 1, status: 'failed', message: BLOCKED_REVIEW_MESSAGE }),
      ...tail(spec).map((row, index) => event(spec.runId, 3 + index, { type: 'status_changed', node_id: null, status: row.status as 'cancelled' | 'succeeded', message: row.message })),
    ]])),
    workerResults: Object.fromEntries(SPECS.map(spec => [spec.runId, { 'ui/1': uiResult(spec.runId), 'adapter/1': adapterResult(spec.runId, false) }])),
    artifactFiles: Object.fromEntries(SPECS.map(spec => [spec.runId, [...UI_ARTIFACTS, ...ADAPTER_ARTIFACTS]])),
  },
  seed: ({ repository, runsRoot, writeRun, writePacket, receipt, internalEvent }) => {
    const root = runsRoot(UX_ACCEPTED_WORKFLOW_ID)
    for (const spec of SPECS) {
      const runDir = join(root, spec.runId)
      writeRun(root, repository, spec.runId, {
        version: '1.12.0', createdAt: T1, updatedAt: T3, definitionNodes: GRAPH_NODES, definitionName: UX_ACCEPTED_WORKFLOW_NAME,
        values: {
          ui: receipt('ui', runDir, UI_SESSION, T1), adapter: receipt('adapter', runDir, ADAPTER_SESSION, T1),
          snapshots: { ui: OUTPUT_COMMIT_UI, adapter: OUTPUT_COMMIT_ADAPTER },
          ui_packet: 'verification/worker/ui/1/packet.json', adapter_packet: 'verification/worker/adapter/1/packet.json',
          bundle: { run_id: spec.runId, base_commit: 'a'.repeat(40), candidate_commit: CANDIDATE_COMMIT, policy_sha256: 'e'.repeat(64) },
        },
        next: [],
        tasks: [{ node_id: 'review', error: `${BLOCKED_REVIEW_MESSAGE}`, interrupts: [], result: null }],
        events: [
          internalEvent(1, T1, 'ui', 'running', 'Launching or reconciling the exact native session'),
          internalEvent(2, T1, 'adapter', 'running', 'Launching or reconciling the exact native session'),
          internalEvent(3, T1, 'freeze', 'succeeded', 'Captured both worker snapshots'),
          internalEvent(4, T1, 'verify_ui', 'succeeded', 'UI verification passed'),
          internalEvent(5, T1, 'verify_adapter', 'succeeded', 'Adapter verification passed'),
          internalEvent(6, T1, 'candidate', 'succeeded', 'Combined candidate checks passed'),
          internalEvent(7, T3, 'review', 'running', 'Launching the print-mode reviewer'),
          internalEvent(8, T3, 'review', 'blocked', BLOCKED_REVIEW_MESSAGE),
          ...tail(spec).map((row, index) => internalEvent(9 + index, T3, 'controller', row.status, row.message)),
        ],
        packets: directory => [
          writePacket(directory, 'worker', 'ui', 1, uiResult(spec.runId), UI_ARTIFACTS, { status: 'passed', reasons: [] }),
          writePacket(directory, 'worker', 'adapter', 1, adapterResult(spec.runId, false), ADAPTER_ARTIFACTS, { status: 'passed', reasons: [] }),
          writePacket(directory, 'candidate', 'ui', 1, uiResult(spec.runId), UI_ARTIFACTS, { status: 'passed', reasons: [] }),
          writePacket(directory, 'candidate', 'adapter', 1, adapterResult(spec.runId, false), ADAPTER_ARTIFACTS, { status: 'passed', reasons: [] }),
        ],
        review: null, inputs: null,
        ...spec.accepted ? { accepted: exportRecord(spec.runId, spec.accepted) } : {},
      })
    }
    return { workflows: [{ workflow_id: UX_ACCEPTED_WORKFLOW_ID, runs_root: root, definition: { name: UX_ACCEPTED_WORKFLOW_NAME, nodes: GRAPH_NODES } }] }
  },
}
