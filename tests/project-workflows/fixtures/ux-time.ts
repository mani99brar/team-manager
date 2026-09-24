/**
 * Fixtures of viewer UX slice S1, time and freshness (`ux-time.spec.ts`) (docs/PRD_VIEWER_UX.md 12.2), registered as the
 * workflow `ux-time`: mock payloads for the worker phase and a `seed` for the candidate phase, merged by `index.ts`.
 * One run, shaped like `run-failed`, whose ui verification's first check took 2.54 s (the first check of the captured
 * skeleton-001 game result), so a check row shows a sub-minute duration rounded to the second: `3s`.
 */
import { join } from 'node:path'
import {
  ADAPTER_ARTIFACTS, ADAPTER_SESSION, adapterResult, definition, done, event, GRAPH_NODES, OUTPUT_COMMIT_ADAPTER, OUTPUT_COMMIT_UI, PROJECT,
  runDetail, T1, T2, UI_ARTIFACTS, UI_SESSION, uiResult,
} from '../fixtures.ts'
import type { WorkerResult } from '../../../contracts/workflow/v1.ts'
import type { UxFixtureModule } from './index.ts'

export const UX_TIME_WORKFLOW_ID = 'ux-time'
export const UX_TIME_WORKFLOW_NAME = 'UX time'
export const RUN_SHORT_CHECK = 'run-short-check'
/** The short check's start and end: 2.54 s apart, shown as `3s`. */
export const SHORT_CHECK_START = '2026-03-01T10:05:00.709921Z'
export const SHORT_CHECK_FINISH = '2026-03-01T10:05:03.252411Z'

const UX_TIME_DEFINITION = definition(PROJECT.project_id, UX_TIME_WORKFLOW_ID, UX_TIME_WORKFLOW_NAME, GRAPH_NODES)

/** The ui verification with its build check shortened to 2.54 s; the other checks are `uiResult`'s. */
function shortCheckResult(runId: string): WorkerResult {
  const base = uiResult(runId)
  return { ...base, checks: base.checks.map((check, index) => (index === 0 ? { ...check, started_at: SHORT_CHECK_START, finished_at: SHORT_CHECK_FINISH } : check)) }
}

export const uxTime: UxFixtureModule = {
  payloads: {
    workflows: [UX_TIME_DEFINITION],
    runDetails: {
      [RUN_SHORT_CHECK]: runDetail(RUN_SHORT_CHECK, 'failed', UX_TIME_DEFINITION, T1, T2, {
        launch_ui: done(UI_SESSION, 'ui'), launch_adapter: done(ADAPTER_SESSION, 'adapter'), handoff: done(),
        verify_ui: done(undefined, 'ui'), verify_adapter: { status: 'failed', attempt: 1, result: 'adapter' },
      }, 5),
    },
    runEvents: {
      [RUN_SHORT_CHECK]: [
        event(RUN_SHORT_CHECK, 1, { type: 'status_changed', node_id: 'verify_ui', attempt: 1, status: 'succeeded', message: 'UI verification passed' }),
        event(RUN_SHORT_CHECK, 2, { type: 'status_changed', node_id: 'verify_adapter', attempt: 1, status: 'failed', message: 'Injected gate failure (failure drill); checks preserved' }),
      ],
    },
    workerResults: { [RUN_SHORT_CHECK]: { 'ui/1': shortCheckResult(RUN_SHORT_CHECK), 'adapter/1': adapterResult(RUN_SHORT_CHECK, true) } },
    artifactFiles: { [RUN_SHORT_CHECK]: [...UI_ARTIFACTS, ...ADAPTER_ARTIFACTS] },
  },
  seed: ({ repository, runsRoot, writeRun, writePacket, receipt, internalEvent }) => {
    const root = runsRoot(UX_TIME_WORKFLOW_ID)
    const runDir = join(root, RUN_SHORT_CHECK)
    writeRun(root, repository, RUN_SHORT_CHECK, {
      createdAt: T1, updatedAt: T2, definitionNodes: GRAPH_NODES, definitionName: UX_TIME_WORKFLOW_NAME,
      values: {
        ui: receipt('ui', runDir, UI_SESSION, T1), adapter: receipt('adapter', runDir, ADAPTER_SESSION, T1),
        snapshots: { ui: OUTPUT_COMMIT_UI, adapter: OUTPUT_COMMIT_ADAPTER },
        ui_packet: 'verification/worker/ui/1/packet.json',
      },
      next: ['verify_adapter'],
      tasks: [{ node_id: 'verify_adapter', error: 'Injected gate failure: adapter verification attempt 1 was blocked by the configured failure drill', interrupts: [], result: null }],
      events: [
        internalEvent(1, T1, 'ui', 'running', 'Launching or reconciling the exact native session'),
        internalEvent(2, T1, 'adapter', 'running', 'Launching or reconciling the exact native session'),
        internalEvent(3, T2, 'freeze', 'succeeded', 'Captured both worker snapshots'),
        internalEvent(4, T2, 'verify_ui', 'succeeded', 'UI verification passed'),
        internalEvent(5, T2, 'verify_adapter', 'failed', 'Injected gate failure (failure drill); checks preserved'),
      ],
      packets: directory => [
        writePacket(directory, 'worker', 'ui', 1, shortCheckResult(RUN_SHORT_CHECK), UI_ARTIFACTS, { status: 'passed', reasons: [] }),
        writePacket(directory, 'worker', 'adapter', 1, adapterResult(RUN_SHORT_CHECK, true), ADAPTER_ARTIFACTS, { status: 'blocked', reasons: ['Injected gate failure (failure drill)'] }),
      ],
      review: null,
      inputs: null,
    })
    return { workflows: [{ workflow_id: UX_TIME_WORKFLOW_ID, runs_root: root, definition: { name: UX_TIME_WORKFLOW_NAME, nodes: GRAPH_NODES } }] }
  },
}
