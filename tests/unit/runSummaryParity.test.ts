import assert from 'node:assert/strict'
import test from 'node:test'
import { runSummaryMarkdown } from '../../contracts/projects/summary.ts'
import { redactText } from '../../contracts/projects/redact.ts'
import { summaryInput as serverInput } from '../../server/githubActions.ts'
import { summaryInput as viewerInput } from '../../src/projects/github/model.ts'

// One run seen by the server (the draft PR body's defaults) and by the viewer (Copy run summary): the same headline, spend and text.
const summary = { run_id: 'run-001', workflow_id: 'feature-implementation', status: 'succeeded', activity: { headline: 'Succeeded · fast-forwarded to 6b6d894 · no push performed' } }
const inputs = { feature: 'Relayer revert shapes', source_branch: 'feature/x/run-001', base_commit: '34ef69ccf67f6deaf6e7d42e647e0dfcc9f52760', workers: [{ node_id: 'ui', completion: { summary: 'Did the work in /home/agentops/dev/x with TOKEN=abc123secret, Password=hunter2-correct and bearer abcdefghijklmnopqrstuvwxyz' } }] }

test('run summary parity: the draft PR body and Copy run summary say the same thing for the same run', () => {
  const loaded = { detail: { summary }, review: null, claudeUsd: 99, inputs } as unknown as Parameters<typeof serverInput>[0]
  const server = serverInput(loaded, 'feature-implementation', null, null, 7.53)
  const viewer = viewerInput({
    detail: { summary } as never, inputs: inputs as never, review: null, headline: summary.activity.headline, teams: null,
    sessions: { totals: { metered_usd: 7.53, covered_usd: 0, not_recorded: 0 } }, runGithub: null,
    reports: new Map([['ui', inputs.workers[0].completion.summary]]),
  })
  assert.equal(server.headline, 'fast-forwarded to 6b6d894 · no push performed')
  assert.equal(viewer.headline, server.headline)
  assert.equal(server.costUsd, 7.53, 'the sessions metered dollars, not the export total')
  assert.equal(viewer.costUsd, server.costUsd)
  const serverText = runSummaryMarkdown(server, redactText)
  const viewerText = runSummaryMarkdown(viewer, redactText)
  assert.equal(viewerText, serverText)
  assert.ok(!serverText.includes('/home/'), 'paths are redacted')
  assert.ok(!serverText.includes('abc123secret'), 'credentials are redacted')
  assert.ok(!serverText.includes('hunter2-correct') && !serverText.includes('abcdefghijklmnopqrstuvwxyz'), 'credentials in any case are redacted')
  assert.equal((serverText.match(/[Ss]ucceeded/g) ?? []).length, 1, 'the status is said once')
})

test('run summary parity: no metered spend means no spend line on either side', () => {
  const loaded = { detail: { summary }, review: null, claudeUsd: 12, inputs } as unknown as Parameters<typeof serverInput>[0]
  assert.equal(serverInput(loaded, 'feature-implementation', null, null, 0).costUsd, null)
  assert.equal(serverInput(loaded, 'feature-implementation', null, null, null).costUsd, null)
})
