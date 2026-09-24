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
