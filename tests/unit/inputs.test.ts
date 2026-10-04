/**
 * The run inputs' profile and roles line (export 1.7.0, C52): what an automatic run's profile is and which model and effort
 * the workers and the judges were pinned to, or that the run predates the pins.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rolesLabel } from '../../src/projects/status.ts'

const automatic = { finish: 'verified-feature-branch', permission_mode: 'bypassPermissions', worker_timeout_seconds: 3600, review_timeout_seconds: 1800, reviewer_transport: 'native' as const }

test('the inputs line names the profile, then each role with its model and effort, the CLI default when unset', () => {
  const roles = { worker: { model: 'claude-sonnet-5', effort: 'low' as const }, judges: { model: null, effort: 'high' as const } }
  assert.equal(rolesLabel({ automatic: { ...automatic, profile: 'attended' }, roles }),
    'attended · workers claude-sonnet-5, effort low · judges default model, effort high')
  assert.equal(rolesLabel({ automatic: null, roles: { ...roles, worker: { model: null, effort: null } } }),
    'workers default model, default effort · judges default model, effort high')
  // A run prepared before the pins: the profile and the roles were never recorded, null or absent alike.
  assert.equal(rolesLabel({ automatic: { ...automatic, profile: null }, roles: null }), 'profile not pinned · roles not pinned')
  assert.equal(rolesLabel({ automatic }), 'profile not pinned · roles not pinned')
  assert.equal(rolesLabel({ automatic: null, roles: null }), 'roles not pinned')
})
