/**
 * The gate's verdict on one verified result, read against the lane's declared checks (docs/PRD_VIEWER_UX.md 4.6, 7). Pure, so
 * the check rows, the Gate section and the candidate's lane table count the same rejected checks.
 */
import { gateReasonsByCheck, type GateReasons } from '../../../contracts/projects/triage.ts'
import type { WorkerResult } from '../api.ts'

/** A check the lane declared (`inputs.workers[].checks`): executed checks are matched to it by exact command. */
export type DeclaredCheck = { id: string; command: string; kind?: string }

/** What the gate said about one result: its reasons, the declared id of each executed check, and how many checks it rejected. */
export type CheckGate = { reasons: GateReasons; ids: (string | null)[]; rejected: number }

/**
 * Reads the gate's `error.message` against the lane's declared checks (docs/PRD_VIEWER_UX.md 4.6, 7): each executed check
 * gets the id of the declared check with its exact command (as TaskPanel matches them), and each reason goes to the check
 * its `<check id>:` prefix names, or, for a reason without one, to the single check whose command ends with the text after
 * `<path>` (`gateReasonsByCheck`). A check is rejected when a reason names it, whatever its exit code.
 */
export function checkGate(result: WorkerResult, declared: readonly DeclaredCheck[]): CheckGate {
  const reasons = gateReasonsByCheck(result.error?.message, declared)
  const ids = result.checks.map(check => declared.find(entry => entry.command === check.command)?.id ?? null)
  return { reasons, ids, rejected: reasons.byCheck.size }
}

/** How the executed checks of one result came out, as the check rows say it: passed, failed or rejected, and deferred. */
export type CheckTally = { passed: number; failed: number; deferred: number }

/**
 * The verify node's figures (docs/PRD_VIEWER_REVAMP.md 5.4), counted the way `Checks` marks its rows: a check recorded for the
 * candidate gate is deferred; else one that exited non-zero, or that a gate reason names, failed; the rest passed.
 */
export function checkTally(result: WorkerResult, gate: CheckGate, deferred: ReadonlyMap<number, string>): CheckTally {
  const tally: CheckTally = { passed: 0, failed: 0, deferred: 0 }
  result.checks.forEach((check, index) => {
    const id = gate.ids[index]
    if (deferred.has(index)) tally.deferred += 1
    else if (check.exit_code !== 0 || (id !== null && (gate.reasons.byCheck.get(id)?.length ?? 0) > 0)) tally.failed += 1
    else tally.passed += 1
  })
  return tally
}
