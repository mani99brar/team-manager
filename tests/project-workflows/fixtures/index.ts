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
import type { AttackResult, PanelResults, ReviewResult, RunDetail, RunInputs, SidecarLedger, WorkflowDefinition } from '../../../contracts/projects/v1.ts'
import type { Sessions } from '../../../contracts/projects/sessions.ts'
import type { WorkerResult, WorkflowEvent } from '../../../contracts/workflow/v1.ts'
import {
  artifactFiles, attackResults, panelResults, projectList, PROJECT, reviewResults, runDetails, runEvents, runInputs, runLists, sidecarLedgers, workerResults, workflowLists,
  type ArtifactFile, type DefinitionNode,
} from '../fixtures.ts'
import { DISPATCH_PROJECTS, DISPATCH_RUN_DETAILS, DISPATCH_RUN_LISTS, DISPATCH_WORKFLOW_LISTS } from './dispatch.ts'
import type { SeedContext } from '../seed.ts'
import { uxAccepted } from './ux-accepted.ts'
import { uxAttack } from './ux-attack.ts'
import { uxLaunch } from './ux-launch.ts'
import { uxLists } from './ux-lists.ts'
import { uxNode } from './ux-node.ts'
import { uxPanel } from './ux-panel.ts'
import { uxJudged } from './ux-judged.ts'
import { uxReview } from './ux-review.ts'
import { uxRun } from './ux-run.ts'
import { uxSidecar } from './ux-sidecar.ts'
import { uxRevampLists } from './ux-revamp-lists.ts'
import { uxRevampPages } from './ux-revamp-pages.ts'
import { uxTime } from './ux-time.ts'
import { uxVerify } from './ux-verify.ts'
import { uxRefine } from './ux-refine.ts'
import { uxCritique } from './ux-critique.ts'
import { uxControls } from './controls.ts'
import { uxSessions } from './sessions.ts'

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
  /** The attack pass's served record per run (contract 1.8.0). */
  attackResults?: Record<string, AttackResult>
  /** The multi-provider panel's served record per run (contract 1.9.0). */
  panelResults?: Record<string, PanelResults>
  /** The sessions payload served at `/sessions` per run (contract 1.13.0, run-sessions). */
  sessions?: Record<string, Sessions>
  /**
   * Per run, the raw facts the shared session-node projection reads ([L4]/[L5]/[L11]), filled from the same builder the
   * module's seed writes: the export's review section (null when none; its raw reviewers with status, null when it lists
   * none), the export version, the plan's reviewer ids, the reviewers' live receipts and the lane-review records. A run without
   * an entry falls back to the core `rawReviewSection(runId)` (`sessionProjection.ts`).
   */
  reviewerIds?: Record<string, SessionFacts>
}

/** The sessions payloads served at `/sessions`, merged across modules (run-sessions). */
export const sessionsByRun: Record<string, Sessions> = {}
/** The raw facts one run's seed writes for the session-node projection (run-sessions, [L5]); each key optional. */
export type SessionFacts = {
  review?: { reviewers: { reviewer_id: string; status: string | null }[] | null } | null
  version?: string
  plan?: string[]
  receipts?: Record<string, { status: string | null; error?: boolean }>
  laneReviews?: { lane: string; round: number; status: string | null }[]
}
/** The projection facts per run ([L4]/[L5]), merged across modules; read by `mock.ts` and the parity spec. */
export const reviewerIdsByRun: Record<string, SessionFacts> = {}

/** One registry workflow entry, as `seedCandidate` writes them. */
export type RegistryWorkflow = { workflow_id: string; runs_root: string; definition: { name: string; nodes: DefinitionNode[] }; /** Another project's id; `PROJECT` when absent. */ project_id?: string }

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
export const UX_FIXTURE_MODULES: readonly UxFixtureModule[] = [uxTime, uxRun, uxNode, uxVerify, uxLaunch, uxReview, uxLists, uxSidecar, uxRevampLists, uxRevampPages, uxAttack, uxPanel, uxRefine, uxCritique, uxAccepted, uxControls, uxSessions, uxJudged]

function mergePayloads(modules: readonly UxFixtureModule[]) {
  for (const { payloads = {} } of modules) {
    const workflows = payloads.workflows ?? []
    // Each workflow joins its own project's list (run-sessions adds one to the unexposed third project).
    for (const workflow of workflows) (workflowLists[workflow.project_id] ?? workflowLists[PROJECT.project_id]).workflows.push(workflow)
    Object.assign(runDetails, payloads.runDetails)
    Object.assign(runEvents, payloads.runEvents)
    Object.assign(workerResults, payloads.workerResults)
    Object.assign(reviewResults, payloads.reviewResults)
    Object.assign(runInputs, payloads.runInputs)
    Object.assign(artifactFiles, payloads.artifactFiles)
    Object.assign(sidecarLedgers, payloads.sidecarLedgers)
    Object.assign(attackResults, payloads.attackResults)
    Object.assign(panelResults, payloads.panelResults)
    Object.assign(sessionsByRun, payloads.sessions)
    Object.assign(reviewerIdsByRun, payloads.reviewerIds)
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

// The dispatch feature adds its own registry projects (not just workflows of PROJECT), with their own repositories ([P16]).
// The worker-phase mocks serve these and the dispatch overview/steps from them; `dispatch-unreadable` has no workflow list.
projectList.projects.push(...DISPATCH_PROJECTS)
Object.assign(workflowLists, DISPATCH_WORKFLOW_LISTS)
Object.assign(runLists, DISPATCH_RUN_LISTS)
// The reading pane reads these with `fetchRunDetail`; index them per run so the events/results/artifacts routes answer empty.
Object.assign(runDetails, DISPATCH_RUN_DETAILS)
for (const runId of Object.keys(DISPATCH_RUN_DETAILS)) { runEvents[runId] ??= []; workerResults[runId] ??= {}; artifactFiles[runId] ??= [] }

/** Seeds every module's runs for the candidate phase; returns what to add to the registry, in module order. */
export function seedUxFixtures(context: SeedContext): Required<UxSeed> {
  const seeded = UX_FIXTURE_MODULES.map(module => module.seed?.(context) ?? { workflows: [] })
  return {
    workflows: seeded.flatMap(seed => seed.workflows),
    // Keys merge shallowly, except `viewer`, whose `expose_run_dir` lists are joined (two modules expose the same project).
    registry: seeded.reduce<Record<string, unknown>>((merged, seed) => {
      const next = { ...merged, ...(seed.registry ?? {}) }
      const before = merged.viewer as { expose_run_dir?: string[] } | undefined
      const after = seed.registry?.viewer as { expose_run_dir?: string[] } | undefined
      if (before && after) next.viewer = { ...before, ...after, expose_run_dir: [...new Set([...(before.expose_run_dir ?? []), ...(after.expose_run_dir ?? [])])] }
      return next
    }, {}),
  }
}
