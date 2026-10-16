import assert from 'node:assert/strict'
import test from 'node:test'
import { runSummaryMarkdown, runSummaryTitle, type RunSummaryInput } from '../../contracts/projects/summary.ts'

const base: RunSummaryInput = {
  runId: 'relayer-revert-shapes-002', workflowId: 'relayer-revert-shapes', feature: null, status: 'succeeded',
  headline: 'Integrate candidate · fast-forwarded to 6b6d894 · no push performed', branch: 'feature/relayer-revert-shapes/relayer-revert-shapes-002',
  baseCommit: '34ef69c0123456789', integratedCommit: '6b6d894aa1b2c3', review: { verdict: 'approved', reviewers: ['general', 'coverage'], open: { p0: 0, p1: 0, p2: 4 } },
  lanes: [{ lane: 'revert-shapes', summary: 'Applied [L1]/[L2] to the candidate.\n\nSecond paragraph is left out.', team: null }],
  costUsd: 7.534, pr: null,
}

test('run summary: title falls back to the workflow id and the body states only recorded facts', () => {
  assert.equal(runSummaryTitle(base), 'relayer-revert-shapes: relayer-revert-shapes-002')
  const text = runSummaryMarkdown(base)
  assert.match(text, /^### relayer-revert-shapes: relayer-revert-shapes-002\n/)
  assert.match(text, /\*\*Integrated:\*\* `6b6d894`/)
  assert.match(text, /approved by general, coverage · 4 P2 open/)
  assert.match(text, /\$7\.53/)
  assert.ok(!text.includes('Second paragraph'))
  assert.ok(!text.includes('Pull request'))
})

test('run summary: a team lane, a missing report, a draft PR, no review and redaction through the given function', () => {
  const text = runSummaryMarkdown({
    ...base, feature: 'Relayer revert shapes', review: null, costUsd: null,
    lanes: [{ lane: 'ui', summary: null, team: { workflows: 2, agents: 8, failed: 1 } }],
    pr: { number: 531, url: 'https://github.com/kleros/vea/pull/531', state: 'OPEN', draft: true },
    headline: 'worked in /home/agentops/dev/x',
  }, value => value.replace(/\/home\/[^\s]+/g, '<path>'))
  assert.match(text, /Worked as a team: 8 agents in 2 workflows, 1 failed\./)
  assert.match(text, /_The worker's report is not recorded\._/)
  assert.match(text, /\[#531\]\(https:\/\/github.com\/kleros\/vea\/pull\/531\) \(draft\)/)
  assert.ok(!text.includes('/home/'))
  assert.ok(!text.includes('Review'))
  assert.ok(!text.includes('spend'))
})
