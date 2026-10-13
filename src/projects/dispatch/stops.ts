/**
 * Where a step-chart run stopped and how many runs ended in each phase (docs/PRD_PROJECTS_DISPATCH.md 4.3), from the run's
 * own recorded steps. A run whose steps are not read (pending or failed) has no stop: nothing is claimed from their absence.
 */
import type { RunSummary } from '../api.ts'
import type { RunClass } from '../lists.ts'
import { PHASES, phaseOf } from './phases.ts'
import type { ProjectStepsRun } from './types.ts'

/**
 * One run of the chart: its summary, its class in the project's classified run list, and its recorded steps once the
 * dispatch steps are read (null until then: the row still shows, from the summary alone). `stepsError` is the read's own
 * error for this run (a per-run entry of `errors`, or its workflow's `error`), so a failed entry never reads as an absent one.
 */
export type ChartRun = { run: RunSummary; cls: RunClass; steps: ProjectStepsRun | null; stepsError?: { code: string; message: string } | null }

/**
 * Where a run stopped: its step index, that step's phase, from the run's own recorded steps; null while they are not read
 * (pending or failed), so no stop is claimed from their absence.
 */
export function stopOf(entry: ChartRun): { index: number; phase: number; stepId: string } | null {
  const steps = entry.steps?.steps ?? []
  if (steps.length === 0) return null
  const ids = steps.map(s => s.node_id)
  let k: number
  if (entry.run.status === 'succeeded' || entry.run.accepted) k = steps.length - 1
  else {
    const focus = entry.run.activity?.focus?.node_id ?? null
    k = focus ? ids.indexOf(focus) : -1
    if (k < 0) {
      const failed = steps.findIndex(s => s.status === 'failed')
      if (failed >= 0) k = failed
      else { k = 0; steps.forEach((s, i) => { if (s.status !== 'pending') k = Math.max(k, i) }) }
    }
  }
  const step = steps[k]
  return { index: k, phase: phaseOf(step.node_id, step.kind), stepId: step.node_id }
}

/** How many runs ended in each phase; a failed or cancelled run whose steps are not read counts nowhere. */
export function endedCounts(entries: readonly ChartRun[]): number[] {
  const counts = PHASES.map(() => 0)
  for (const entry of entries) {
    if (entry.run.status === 'succeeded') counts[7] += 1
    else if (['failed', 'cancelled'].includes(entry.run.status)) {
      const stop = stopOf(entry)
      if (stop !== null) counts[stop.phase] += 1
    }
  }
  return counts
}

/** The project's steps read: still loading, failed, or read (the reading pane's `StepsRead`). */
export type StepsReadState = 'loading' | 'failed' | 'read'

/**
 * What a run row says in place of a stop it cannot name (no recorded stop and no served focus label): "reading steps…" while
 * the steps load, "steps not read" only when the read failed, "no steps recorded" when the read holds no steps for the run,
 * so a load never reads as a failure (M1). The `aria` sentence is the row's spoken form.
 */
export function noStopWording(stepsRead: StepsReadState): { text: string; aria: string } {
  if (stepsRead === 'loading') return { text: 'reading steps…', aria: 'Reading its steps.' }
  if (stepsRead === 'failed') return { text: 'steps not read', aria: 'Steps not read.' }
  return { text: 'no steps recorded', aria: 'No steps recorded.' }
}

/** One run's steps read: the project's read, except that a run whose own entry failed to read is 'failed' (M1). */
export function runStepsRead(entry: ChartRun, stepsRead: StepsReadState): StepsReadState {
  return entry.stepsError ? 'failed' : stepsRead
}

/**
 * Whether a feature's landing state is known: only once the steps are read and none of its runs' entries failed to read.
 * Until then an empty landing list is unknown, never "nothing landed" (M1).
 */
export function landingKnown(entries: readonly ChartRun[], stepsRead: StepsReadState): boolean {
  return entries.every(entry => runStepsRead(entry, stepsRead) === 'read')
}
