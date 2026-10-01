/**
 * The fixture extension point of the viewer UX slices (docs/PRD_VIEWER_UX.md section 11). Each slice adds its runs in its
 * own module, `ux-<slice>.ts`, as a new workflow `ux-<slice>` appended after every workflow of `PROJECT`, so the existing
 * counts (two projects, five runs in `feature-flow`) do not change:
 * - `payloads`: the contract payloads the worker-phase mocks serve. This module spreads them into the maps `fixtures.ts`
 *   exports when it is first imported; `mock.ts` imports it, so they are merged before any request is served.
 * - `seed`: writes the same logical runs for the candidate phase and returns their registry entries; `seedCandidate`
 *   calls every module's seed with a `SeedContext`, appends the entries to `PROJECT`'s workflows and adds any top-level
 *   registry keys a module returns (S6's `viewer.expose_run_dir`, once the server accepts it).
 * After S1 no slice edits `fixtures.ts`, `mock.ts` or `seed.ts`: a slice changes only its own module. Modules import the
 * builders `fixtures.ts` exports and only types from here and from `seed.ts`, so no import cycle exists.
 */
import type { ReviewResult, RunDetail, RunInputs, SidecarLedger, WorkflowDefinition } from '../../../contracts/projects/v1.ts'
import type { WorkerResult, WorkflowEvent } from '../../../contracts/workflow/v1.ts'
import {
  artifactFiles, PROJECT, reviewResults, runDetails, runEvents, runInputs, runLists, sidecarLedgers, workerResults, workflowLists,
  type ArtifactFile, type DefinitionNode,
} from '../fixtures.ts'
import type { SeedContext } from '../seed.ts'
import { uxLaunch } from './ux-launch.ts'
import { uxLists } from './ux-lists.ts'
import { uxNode } from './ux-node.ts'
import { uxReview } from './ux-review.ts'
import { uxRun } from './ux-run.ts'
import { uxSidecar } from './ux-sidecar.ts'
import { uxTime } from './ux-time.ts'
import { uxVerify } from './ux-verify.ts'

/** A module's worker-phase payloads, keyed like the maps of `fixtures.ts`; run lists are derived from `runDetails`. */
export type UxPayloads = {
  /** Registered after every existing workflow of `PROJECT`, in module order. */
  workflows: WorkflowDefinition[]
  runDetails: Record<string, RunDetail>
  runEvents: Record<string, WorkflowEvent[]>
  /** Per run, keyed `<node>/<attempt>` or `candidate_<lane>/<attempt>` like the results route. */
  workerResults: Record<string, Record<string, WorkerResult>>
  reviewResults: Record<string, ReviewResult>
  runInputs: Record<string, RunInputs>
  artifactFiles: Record<string, ArtifactFile[]>
  /** The review sidecar's served ledger per run (contract 1.6.0). */
  sidecarLedgers?: Record<string, SidecarLedger>
}

/** One registry workflow entry, as `seedCandidate` writes them. */
export type RegistryWorkflow = { workflow_id: string; runs_root: string; definition: { name: string; nodes: DefinitionNode[] } }

/** What a module's candidate-phase seed adds to the registry. */
export type UxSeed = {
  workflows: RegistryWorkflow[]
  /** Top-level registry keys beside `version` and `projects`; a later module's key replaces an earlier one's. */
  registry?: Record<string, unknown>
}

export type UxFixtureModule = {
  payloads?: Partial<UxPayloads>
  seed?: (context: SeedContext) => UxSeed
}

/** In slice order; the order the added workflows are listed in, in both phases. */
export const UX_FIXTURE_MODULES: readonly UxFixtureModule[] = [uxTime, uxRun, uxNode, uxVerify, uxLaunch, uxReview, uxLists, uxSidecar]

function mergePayloads(modules: readonly UxFixtureModule[]) {
  for (const { payloads = {} } of modules) {
    const workflows = payloads.workflows ?? []
    workflowLists[PROJECT.project_id].workflows.push(...workflows)
    Object.assign(runDetails, payloads.runDetails)
    Object.assign(runEvents, payloads.runEvents)
    Object.assign(workerResults, payloads.workerResults)
    Object.assign(reviewResults, payloads.reviewResults)
    Object.assign(runInputs, payloads.runInputs)
    Object.assign(artifactFiles, payloads.artifactFiles)
    Object.assign(sidecarLedgers, payloads.sidecarLedgers)
    // The mocks index these per run: a run without events, results or artifacts serves none rather than failing.
    for (const runId of Object.keys(payloads.runDetails ?? {})) {
      runEvents[runId] ??= []
      workerResults[runId] ??= {}
      artifactFiles[runId] ??= []
    }
    // Each workflow's runs sorted by `updated_at` descending then `run_id` ascending, as the contract requires.
    for (const workflow of workflows) {
      runLists[workflow.workflow_id] = {
        runs: Object.values(runDetails).map(detail => detail.summary).filter(summary => summary.workflow_id === workflow.workflow_id)
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.run_id.localeCompare(b.run_id)),
        next_cursor: null,
      }
    }
  }
}

mergePayloads(UX_FIXTURE_MODULES)

/** Seeds every module's runs for the candidate phase; returns what to add to the registry, in module order. */
export function seedUxFixtures(context: SeedContext): Required<UxSeed> {
  const seeded = UX_FIXTURE_MODULES.map(module => module.seed?.(context) ?? { workflows: [] })
  return {
    workflows: seeded.flatMap(seed => seed.workflows),
    registry: Object.assign({}, ...seeded.map(seed => seed.registry ?? {})) as Record<string, unknown>,
  }
}
