/**
 * The Team view's styles stay on DESIGN.md (src/projects/teams/teams.css, docs/PRD_RUN_TEAMS.md 8 "Density" and "Surfaces"),
 * the same rules `sessionsStyle.test.ts` holds run-sessions to: every font size on the spec's ramp {11, 13, 13.5, 14, 15, 15.5,
 * 16, 20} or the floor, every corner in {4, 8, 10, 12, 999} (the phone drawer's 16 px top corners are section 3.1's one
 * exception), no literal colour, no thick coloured side-tab, and only the agent drawer casts a shadow (a list page has none).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const CSS = readFileSync(new URL('../../src/projects/teams/teams.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** docs/PRD_RUN_TEAMS.md 8: font sizes come from {11, 13, 13.5, 14, 15, 15.5, 16, 20}. */
const FONT_RAMP = new Set(['20px', '16px', '15.5px', '15px', '14px', '13.5px', '13px', '11px'])
/** docs/PRD_RUN_TEAMS.md 8: radii from {4, 8, 10, 12, 999}. */
const RADII = new Set(['var(--radius)', '8px', '10px', '12px', '4px', '999px'])
/** Section 3.1: the phone drawer is a bottom sheet with 16 px top corners. */
const DRAWER_CORNERS = '16px 16px 0 0'

const values = (property: string) => [...CSS.matchAll(new RegExp(`(?<![-\\w])${property}\\s*:\\s*([^;}]+)`, 'g'))].map(match => match[1]!.trim())

const onRamp = (size: string) => FONT_RAMP.has(size) || size === 'var(--type-floor)'
  || FONT_RAMP.has(/^max\(([\d.]+px), var\(--type-floor\)\)$/.exec(size)?.[1] ?? '')

test('teams.css: every font size is on the spec ramp or its floor', () => {
  const sizes = values('font-size')
  assert.ok(sizes.length > 0)
  assert.deepEqual(sizes.filter(size => !onRamp(size)), [])
})

test('teams.css: every border radius is in the radius set (the phone drawer\'s top corners aside)', () => {
  const radii = values('border-radius')
  assert.ok(radii.length > 0)
  assert.deepEqual(radii.filter(radius => radius !== DRAWER_CORNERS && !radius.split(/\s+/).every(part => RADII.has(part) || part === '0')), [])
  assert.ok(radii.filter(radius => radius === DRAWER_CORNERS).length <= 1, 'only the phone drawer takes 16 px corners')
})

test('teams.css: no literal colour and no left border wider than 2px', () => {
  assert.deepEqual(CSS.match(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi) ?? [], [])
  const widths = [...values('border-left'), ...values('border-left-width')].map(value => /(\d+(?:\.\d+)?)px/.exec(value)?.[1]).filter(width => width !== undefined)
  assert.deepEqual(widths.filter(width => Number(width) > 2), [])
})

test('teams.css: only the agent drawer floats (a list page casts no shadow)', () => {
  const rules = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(match => /box-shadow\s*:/.test(match[2]!) && !/box-shadow\s*:\s*none/.test(match[2]!))
  assert.deepEqual(rules.map(match => match[1]!.trim()).filter(selector => !selector.split(',').every(part => part.trim().startsWith('.team-drawer'))), [])
})
