/**
 * The one mapping from state to colour tone (docs/PRD_VIEWER_REVAMP.md section 4): every run status, attention kind and
 * severity maps to a tone, an unknown value is idle, attention wins over status, and the
 * contrast helper the `revamp-look` scenario measures with follows WCAG 2.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { STATUS_LABEL, type RunStatus } from '../../src/projects/status.ts'
import {
  attentionTone, contrastRatio, parseColor, severityClass, severityTone, stateTone, statusTone, TONE_LABEL,
  toneClass, type Tone,
} from '../../src/projects/tone.ts'

const TONES: readonly Tone[] = ['ok', 'run', 'warn', 'fail', 'pause', 'idle']

describe('statusTone', () => {
  test('maps every run status of the contract to a tone', () => {
    const expected: Record<RunStatus, Tone> = {
      pending: 'idle', running: 'run', awaiting_approval: 'warn', paused: 'pause', succeeded: 'ok', failed: 'fail', cancelled: 'idle',
    }
    const statuses = Object.keys(STATUS_LABEL) as RunStatus[]
    for (const status of statuses) assert.equal(statusTone(status), expected[status], status)
    assert.deepEqual([...statuses].sort(), Object.keys(expected).sort())
  })
  test('an unknown or empty status is idle', () => {
    assert.equal(statusTone('exploded'), 'idle')
    assert.equal(statusTone(''), 'idle')
    assert.equal(statusTone('toString'), 'idle')
  })
})

describe('attentionTone', () => {
  test('maps every served attention kind', () => {
    assert.equal(attentionTone('question'), 'warn')
    assert.equal(attentionTone('pane'), 'warn')
    assert.equal(attentionTone('approval'), 'warn')
    assert.equal(attentionTone('interrupted'), 'pause')
    assert.equal(attentionTone('paused'), 'pause')
    assert.equal(attentionTone('failed'), 'fail')
  })
  test('an unknown kind is idle', () => {
    assert.equal(attentionTone('bored'), 'idle')
    assert.equal(attentionTone('constructor'), 'idle')
  })
})

describe('severityTone', () => {
  test('maps P0, P1 and P2 and treats anything else as P2', () => {
    assert.equal(severityTone('P0'), 'p0')
    assert.equal(severityTone('P1'), 'p1')
    assert.equal(severityTone('P2'), 'p2')
    assert.equal(severityTone('P9'), 'p2')
    assert.equal(severityClass(severityTone('P0')), 'sev-p0')
  })
})

describe('stateTone', () => {
  test('attention wins over status; status alone maps; nothing is idle', () => {
    assert.equal(stateTone({ status: 'running', attention: 'question' }), 'warn')
    assert.equal(stateTone({ status: 'running', attention: 'failed' }), 'fail')
    assert.equal(stateTone({ status: 'paused', attention: null }), 'pause')
    assert.equal(stateTone({ status: 'succeeded' }), 'ok')
    assert.equal(stateTone({}), 'idle')
    assert.equal(stateTone({ status: 'weird' }), 'idle')
  })
  test('every tone has a class and a label, so colour never carries the state alone', () => {
    for (const tone of TONES) {
      assert.equal(toneClass(tone), `tone-${tone}`)
      assert.ok(TONE_LABEL[tone].length > 0, tone)
    }
    assert.deepEqual(Object.keys(TONE_LABEL).sort(), [...TONES].sort())
  })
})

describe('contrastRatio', () => {
  test('parses hex and rgb() colours as the browser resolves them', () => {
    assert.deepEqual(parseColor('#fff'), [255, 255, 255, 1])
    assert.deepEqual(parseColor(' #1a6b3e '), [26, 107, 62, 1])
    assert.deepEqual(parseColor('rgb(10, 20, 30)'), [10, 20, 30, 1])
    assert.deepEqual(parseColor('rgba(10, 20, 30, 0.5)'), [10, 20, 30, 0.5])
    assert.deepEqual(parseColor('transparent'), [0, 0, 0, 0])
    assert.equal(parseColor('var(--fg)'), null)
  })
  test('follows WCAG 2: black on white is 21, a colour on itself is 1, the order does not matter', () => {
    assert.equal(Math.round(contrastRatio('#000000', '#ffffff') * 10) / 10, 21)
    assert.equal(contrastRatio('#777777', '#777777'), 1)
    assert.equal(contrastRatio('#1a6b3e', '#dff3e6'), contrastRatio('#dff3e6', '#1a6b3e'))
    // #767676 on white is the classic 4.54:1 boundary colour.
    assert.ok(contrastRatio('rgb(118, 118, 118)', '#ffffff') >= 4.5)
    assert.ok(contrastRatio('#777777', '#ffffff') < 4.5)
  })
})
