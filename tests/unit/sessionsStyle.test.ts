/**
 * The run-sessions styles stay on DESIGN.md (src/projects/sessions/sessions.css, docs/PRD_RUN_SESSIONS.md): every font size
 * on the type ramp, every corner in the radius set, no literal colour (tokens on `.projects-shell` only) and no thick
 * coloured side-tab (a state shows as a band, a pill or a word, never a left border wider than a hairline). Only the file
 * run-sessions added is checked; older stylesheets keep their own sizes until a change of theirs is reviewed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const CSS = readFileSync(new URL('../../src/projects/sessions/sessions.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** DESIGN.md typography: headline 20, run id 16, title 15.5, body 15, body dense 13 to 13.5, meta 12.5, word 12, chips 11. */
const FONT_RAMP = new Set(['20px', '16px', '15.5px', '15px', '13.5px', '13px', '12.5px', '12px', '11px'])
/** DESIGN.md `rounded`: card 8 (`--radius`), node and control 10, panel 12, small 4, pill 999. */
const RADII = new Set(['var(--radius)', '8px', '10px', '12px', '4px', '999px'])

const values = (property: string) => [...CSS.matchAll(new RegExp(`(?<![-\\w])${property}\\s*:\\s*([^;}]+)`, 'g'))].map(match => match[1]!.trim())

test('sessions.css: every font size is on the DESIGN.md type ramp', () => {
  const sizes = values('font-size')
  assert.ok(sizes.length > 0)
  assert.deepEqual(sizes.filter(size => !FONT_RAMP.has(size)), [])
})

test('sessions.css: every border radius is in the DESIGN.md radius set', () => {
  const radii = values('border-radius')
  assert.ok(radii.length > 0)
  assert.deepEqual(radii.filter(radius => !radius.split(/\s+/).every(part => RADII.has(part))), [])
})

test('sessions.css: no literal colour and no left border wider than 2px', () => {
  assert.deepEqual(CSS.match(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi) ?? [], [])
  const widths = [...values('border-left'), ...values('border-left-width')].map(value => /(\d+(?:\.\d+)?)px/.exec(value)?.[1]).filter(width => width !== undefined)
  assert.deepEqual(widths.filter(width => Number(width) > 2), [])
})
