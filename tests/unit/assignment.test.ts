/**
 * The Assignment tab's model (src/projects/Assignment.tsx, docs/PRD_VIEWER_REFINE 5.5): one setup line (feature, mode,
 * profile, base commit, fix_rounds, the reviewers from the latest review result) and one lane row (lane, role, model and
 * effort or "no pin", skills, owned paths count, checks count, task length), read from a 1.10.0 detail and a 1.9.0 detail.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { assignmentModel, taskLengthLabel } from '../../src/projects/status.ts'
import { payloads } from '../../tests/project-workflows/fixtures/ux-refine.ts'
import type { RunInputs } from '../../contracts/projects/v1.ts'

const RUN = 'run-loop-done'
const inputs1010 = payloads.runInputs![RUN]
const review = payloads.reviewResults![RUN]

/** The same inputs as a server before 1.10.0 served them: no lane pins, no skills, no `fix_rounds`. */
function as19(inputs: RunInputs): RunInputs {
  return {
    ...inputs,
    automatic: inputs.automatic ? { ...inputs.automatic, fix_rounds: undefined } : null,
    workers: inputs.workers.map(worker => ({ ...worker, roles: undefined, skills: undefined })),
  } as RunInputs
}

describe('assignmentModel', () => {
  test('a 1.10.0 detail: the setup line carries fix_rounds and the reviewers from the review', () => {
    const { setup } = assignmentModel(inputs1010, review)
    assert.equal(setup.feature, 'Viewer refine')
    assert.equal(setup.mode, 'automatic')
    assert.equal(setup.baseCommit, inputs1010.base_commit)
    assert.equal(setup.fixRounds, 2)
    assert.deepEqual(setup.reviewers, review.reviewers.map(reviewer => reviewer.reviewer_id))
  })

  test('a 1.10.0 detail: a pinned lane shows its model and effort and its skills; an unpinned lane shows "no pin"', () => {
    const { lanes } = assignmentModel(inputs1010, review)
    const viewer = lanes.find(lane => lane.node_id === 'viewer')!
    const shell = lanes.find(lane => lane.node_id === 'shell')!
    assert.equal(viewer.pin, 'opus-4-8 · medium')
    assert.deepEqual(viewer.skills, ['impeccable'])
    assert.equal(shell.pin, null)
    assert.deepEqual(shell.skills, [])
    // The sizes come before any long text: counts, never the text itself.
    assert.ok(viewer.ownedPaths > 0)
    assert.ok(viewer.checks > 0)
    assert.ok(viewer.taskLength > 0)
    assert.equal(viewer.taskTruncated, false)
  })

  test('before a review the setup line says the reviewers are not recorded', () => {
    const { setup } = assignmentModel(inputs1010, null)
    assert.equal(setup.reviewers, null)
  })

  test('the task length label: a count for an intact task, the pinned "over 65,536 characters (truncated)" for a truncated one', () => {
    assert.equal(taskLengthLabel({ taskLength: 4096, taskTruncated: false }), '4096')
    // A truncated length is the already-cut text's length (it includes the API's marker), so the label never prints it.
    assert.equal(taskLengthLabel({ taskLength: 65612, taskTruncated: true }), 'over 65,536 characters (truncated)')
  })

  test('a 1.9.0 detail: no lane pins, no skills, a null fix_rounds', () => {
    const { setup, lanes } = assignmentModel(as19(inputs1010), null)
    assert.equal(setup.fixRounds, null)
    assert.equal(setup.reviewers, null)
    for (const lane of lanes) {
      assert.equal(lane.pin, null)
      assert.deepEqual(lane.skills, [])
    }
  })
})
