/**
 * The gate's verdict on a verified result (docs/PRD_VIEWER_UX.md 4.6, 7), read on the captured workflow-guardrails-001 and
 * skeleton-001 payloads: each executed check gets its declared id by exact command, and a check is rejected when a reason
 * names it, by its `<check id>:` prefix or, for an unkeyed `<path>` reason, by the one command that ends the same, whatever
 * its exit code.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateRunInputs } from '../../contracts/projects/v1.ts'
import { eventSchema, validateWorkerResult, type WorkerResult } from '../../contracts/workflow/v1.ts'
import { checkGate } from '../../src/projects/node/gate.ts'

type Raw = { events: unknown[]; inputs: unknown; results: Record<string, unknown> }
const load = (name: string) => JSON.parse(readFileSync(new URL(`fixtures/runs/${name}.json`, import.meta.url), 'utf8')) as Raw

const guardrails = load('workflow-guardrails-001')
const skeleton = load('skeleton-001')
const GUARDRAILS_RUN = '/api/projects/md-manager/workflows/workflow-guardrails/runs/workflow-guardrails-001'
const SKELETON_RUN = '/api/projects/project-b/workflows/skeleton/runs/skeleton-001'
const resultOf = (raw: Raw, uri: string) => validateWorkerResult(raw.results[uri])
const checksOf = (raw: Raw, lane: string) => validateRunInputs(raw.inputs).workers.find(worker => worker.node_id === lane)!.checks
/** A captured result failed with the reasons a served event recorded (the attempt itself was not captured). */
const failedWith = (result: WorkerResult, raw: Raw, sequence: number): WorkerResult => validateWorkerResult({
  ...result, attempt: 1, status: 'failed',
  error: { code: 'VERIFICATION_BLOCKED', message: raw.events.map(event => eventSchema.parse(event)).find(event => event.sequence === sequence)!.message, retryable: true },
})

describe('checkGate', () => {
  test('guardrails candidate_ui/2: the browser check exited 0 and is the one rejected check, with its three reasons', () => {
    const result = resultOf(guardrails, `${GUARDRAILS_RUN}/results/candidate_ui/2`)
    const gate = checkGate(result, checksOf(guardrails, 'ui'))
    assert.deepEqual(gate.ids, ['frontend-build', 'frontend-unit-regression', 'project-workflows-browser'])
    assert.equal(gate.rejected, 1)
    assert.equal(result.checks[2].exit_code, 0)
    assert.equal(gate.reasons.byCheck.get('project-workflows-browser')?.length, 3)
    assert.deepEqual(gate.reasons.gate, [])
  })

  test('guardrails controller/1: the unkeyed <path> reason stays at the gate and joins the workflow-unit check, one rejected check', () => {
    const result = failedWith(resultOf(guardrails, `${GUARDRAILS_RUN}/results/controller/2`), guardrails, 23)
    const gate = checkGate(result, checksOf(guardrails, 'controller'))
    assert.equal(gate.ids[0], 'workflow-unit', 'the unredacted interpreter path still matches the declared command exactly')
    assert.equal(gate.rejected, 1)
    assert.deepEqual(gate.reasons.gate.map(reason => reason.attached_to), ['workflow-unit'])
    assert.equal(gate.reasons.byCheck.get('workflow-unit')?.length, 3)
  })

  test('skeleton-001 game/1: two checks rejected; a passed result rejects none', () => {
    const passed = resultOf(skeleton, `${SKELETON_RUN}/results/game/3`)
    const checks = checksOf(skeleton, 'game')
    assert.equal(checkGate(failedWith(passed, skeleton, 14), checks).rejected, 2)
    assert.equal(checkGate(passed, checks).rejected, 0)
  })

  test('without declared checks nothing is named or keyed, and every reason stays at the gate', () => {
    const result = resultOf(guardrails, `${GUARDRAILS_RUN}/results/candidate_ui/2`)
    const gate = checkGate(result, [])
    assert.deepEqual(gate.ids, [null, null, null])
    assert.equal(gate.rejected, 0)
    assert.equal(gate.reasons.gate.length, 3)
  })
})
