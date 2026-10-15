import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { spendFigure } from '../../src/projects/dispatch/spend.ts'

/** The project header's spend figure: the recorded Claude totals only, to the cent, with how many runs were priced. */
describe('spendFigure', () => {
  test('rounds the served total to the cent and says k of n runs priced', () => {
    assert.equal(spendFigure({ claude_usd: 3.734567, priced_runs: 3, runs: 5 }), '$3.73 Claude spend · 3 of 5 runs priced')
    assert.equal(spendFigure({ claude_usd: 12.005001, priced_runs: 1, runs: 1 }), '$12.01 Claude spend · 1 of 1 runs priced')
    assert.equal(spendFigure({ claude_usd: 0.004, priced_runs: 2, runs: 9 }), '$0.00 Claude spend · 2 of 9 runs priced')
    assert.equal(spendFigure({ claude_usd: 1234.5, priced_runs: 60, runs: 60 }), '$1234.50 Claude spend · 60 of 60 runs priced')
  })
  test('a recorded 0 is a priced spend, never "no spend recorded"', () => {
    assert.equal(spendFigure({ claude_usd: 0, priced_runs: 1, runs: 1 }), '$0.00 Claude spend · 1 of 1 runs priced')
  })
  test('no priced run says no Claude spend was recorded', () => {
    assert.equal(spendFigure({ claude_usd: null, priced_runs: 0, runs: 4 }), 'no Claude spend recorded')
    assert.equal(spendFigure({ claude_usd: null, priced_runs: 0, runs: 0 }), 'no Claude spend recorded')
  })
  test('nothing while unread, for a null spend or an older server without one', () => {
    assert.equal(spendFigure(null), null)
    assert.equal(spendFigure(undefined), null)
  })
  test('never the old literal, never a covered estimate', () => {
    for (const spend of [{ claude_usd: 5, priced_runs: 1, runs: 2 }, { claude_usd: null, priced_runs: 0, runs: 2 }]) {
      const text = spendFigure(spend)!
      assert.doesNotMatch(text, /spend not recorded|covered|estimate|Spent/)
    }
  })
})
