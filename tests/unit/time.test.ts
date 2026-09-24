/**
 * The viewer's time helpers (docs/PRD_VIEWER_UX.md section 5.3): clocks in the local zone or UTC with the date only when it
 * differs from the day read against, relative ages, compact durations, spans between served timestamps, and the freshness
 * state of the live chip (section 6.3). Local-zone cases switch `process.env.TZ`, which Node applies immediately.
 */
import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { formatAgo, formatClock, formatSpan, freshnessState, spanBetween, utcTitle } from '../../src/projects/time.ts'

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const originalTz = process.env.TZ

afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ
  else process.env.TZ = originalTz
})

describe('formatSpan', () => {
  test('edges: seconds, the minute boundary, the hour boundary and more than a day', () => {
    assert.equal(formatSpan(0), '0s')
    assert.equal(formatSpan(59 * SECOND), '59s')
    assert.equal(formatSpan(60 * SECOND), '1m00s')
    assert.equal(formatSpan(59 * MINUTE + 59 * SECOND), '59m59s')
    assert.equal(formatSpan(HOUR), '1h00m')
    assert.equal(formatSpan(HOUR + 5 * MINUTE + 59 * SECOND), '1h05m')
    assert.equal(formatSpan(25 * HOUR + 3 * MINUTE), '25h03m')
  })

  test('rounds to the nearest second, carrying into the next unit', () => {
    assert.equal(formatSpan(2540), '3s')
    assert.equal(formatSpan(59_600), '1m00s')
    assert.equal(formatSpan(HOUR - 400), '1h00m')
    assert.equal(formatSpan(28 * MINUTE + 21 * SECOND), '28m21s')
  })

  test('a negative span reads as zero', () => {
    assert.equal(formatSpan(-5 * SECOND), '0s')
  })
})

describe('spanBetween', () => {
  test('measures served timestamps, including microsecond precision', () => {
    // skeleton-fixes-001: reviewer general launched and accepted (PRD 4.7 "general ✓ approved 3m49s").
    const general = spanBetween('2026-09-24T10:10:13.246800Z', '2026-09-24T10:14:02.199946Z')
    assert.equal(general !== null && formatSpan(general), '3m49s')
    const coverage = spanBetween('2026-09-24T10:10:18.805627Z', '2026-09-24T10:12:22.444735Z')
    assert.equal(coverage !== null && formatSpan(coverage), '2m04s')
  })

  test('is null when either end is missing or unreadable, or the end precedes the start', () => {
    assert.equal(spanBetween(null, '2026-09-24T10:00:00Z'), null)
    assert.equal(spanBetween('2026-09-24T10:00:00Z', undefined), null)
    assert.equal(spanBetween('not a time', '2026-09-24T10:00:00Z'), null)
    assert.equal(spanBetween('2026-09-24T10:00:01Z', '2026-09-24T10:00:00Z'), null)
    assert.equal(spanBetween('2026-09-24T10:00:00Z', '2026-09-24T10:00:00Z'), 0)
  })
})

describe('formatClock', () => {
  const start = '2026-03-01T10:00:00Z'

  test('UTC: HH:MM, or HH:MM:SS on request, whatever the process zone', () => {
    process.env.TZ = 'America/Los_Angeles'
    assert.equal(formatClock('2026-03-01T10:20:00Z', { zone: 'utc', reference: start }), '10:20')
    assert.equal(formatClock('2026-03-01T10:20:07Z', { zone: 'utc', reference: start, seconds: true }), '10:20:07')
    assert.equal(formatClock('2026-09-24T09:28:42.709921Z', { zone: 'utc', reference: '2026-09-24T08:39:00Z', seconds: true }), '09:28:42')
  })

  test('local time follows the zone: America/Los_Angeles and UTC', () => {
    process.env.TZ = 'America/Los_Angeles'
    assert.equal(formatClock('2026-03-01T10:20:00Z', { zone: 'local', reference: start }), '02:20')
    // Summer time: UTC-7.
    assert.equal(formatClock('2026-09-24T09:32:31Z', { zone: 'local', reference: '2026-09-24T08:39:00Z', seconds: true }), '02:32:31')
    process.env.TZ = 'UTC'
    assert.equal(formatClock('2026-03-01T10:20:00Z', { zone: 'local', reference: start }), '10:20')
  })

  test('the date is prefixed only when the day differs from the reference day, read in the same zone', () => {
    const runStart = '2026-09-23T23:30:00Z'
    const afterMidnight = '2026-09-24T00:10:00Z'
    process.env.TZ = 'UTC'
    assert.equal(formatClock(runStart, { zone: 'utc', reference: runStart }), '23:30')
    assert.equal(formatClock(afterMidnight, { zone: 'utc', reference: runStart }), 'Sep 24 00:10')
    // In Los Angeles both instants fall on the evening of Sep 23: no prefix.
    process.env.TZ = 'America/Los_Angeles'
    assert.equal(formatClock(afterMidnight, { zone: 'local', reference: runStart }), '17:10')
    // A time before the run's day, and one in another year, name their date.
    assert.equal(formatClock('2026-09-20T12:00:00Z', { zone: 'utc', reference: runStart }), 'Sep 20 12:00')
    assert.equal(formatClock('2025-12-31T23:00:00Z', { zone: 'utc', reference: runStart }), 'Dec 31 2025 23:00')
  })

  test('without a reference the day is read against today, and the day before is "yesterday"', () => {
    process.env.TZ = 'UTC'
    const now = Date.parse('2026-09-24T12:00:00Z')
    assert.equal(formatClock('2026-09-24T09:32:00Z', { zone: 'utc', now }), '09:32')
    assert.equal(formatClock('2026-09-23T20:27:00Z', { zone: 'utc', now }), 'yesterday 20:27')
    assert.equal(formatClock('2026-09-20T09:32:00Z', { zone: 'utc', now }), 'Sep 20 09:32')
    // Across midnight in the local zone: 01:00 UTC on Sep 24 is still Sep 23 in Los Angeles, the day before its "today".
    process.env.TZ = 'America/Los_Angeles'
    assert.equal(formatClock('2026-09-24T01:00:00Z', { zone: 'local', now }), 'yesterday 18:00')
    assert.equal(formatClock('2026-09-24T01:00:00Z', { zone: 'utc', now }), '01:00')
  })

  test('an unreadable value is shown as served', () => {
    assert.equal(formatClock('soon', { zone: 'utc', reference: start }), 'soon')
  })
})

describe('utcTitle', () => {
  test('the full UTC value for the tooltip, to the second', () => {
    assert.equal(utcTitle('2026-09-24T09:32:31.411386Z'), '2026-09-24 09:32:31 UTC')
    assert.equal(utcTitle('2026-03-01T10:00:00Z'), '2026-03-01 10:00:00 UTC')
    assert.equal(utcTitle('2026-03-01T11:00:00+01:00'), '2026-03-01 10:00:00 UTC')
    assert.equal(utcTitle('soon'), 'soon')
  })
})

describe('formatAgo', () => {
  const now = Date.parse('2026-09-24T12:00:00Z')

  test('seconds, minutes, hours and days, rounded down', () => {
    assert.equal(formatAgo(now - 400, now), 'just now')
    assert.equal(formatAgo(now - 3 * SECOND, now), '3 s ago')
    assert.equal(formatAgo(now - 59 * SECOND, now), '59 s ago')
    assert.equal(formatAgo(now - 60 * SECOND, now), '1 min ago')
    assert.equal(formatAgo('2026-09-24T11:46:00Z', now), '14 min ago')
    assert.equal(formatAgo(now - 2 * HOUR - 59 * MINUTE, now), '2 h ago')
    assert.equal(formatAgo(now - 25 * HOUR, now), '1 d ago')
  })

  test('a time after now (clock skew) is "just now"; an unreadable one is empty', () => {
    assert.equal(formatAgo(now + 5 * SECOND, now), 'just now')
    assert.equal(formatAgo('soon', now), '')
  })
})

describe('freshnessState', () => {
  const now = Date.parse('2026-09-24T12:00:00Z')
  const fresh = { settledAt: now - 3 * SECOND, failures: 0 }
  const page = { visible: true, visibleSince: now - HOUR }

  test('a polled run is live, or watched when it failed or paused; a finished one is not polled', () => {
    assert.equal(freshnessState({ status: 'running', ...fresh, ...page, now }), 'live')
    assert.equal(freshnessState({ status: 'awaiting_approval', ...fresh, ...page, now }), 'live')
    assert.equal(freshnessState({ status: 'failed', ...fresh, ...page, now }), 'watching')
    assert.equal(freshnessState({ status: 'paused', ...fresh, ...page, now }), 'watching')
    assert.equal(freshnessState({ status: 'succeeded', ...fresh, ...page, now }), 'finished')
    assert.equal(freshnessState({ status: 'cancelled', settledAt: now - HOUR, failures: 5, ...page, now }), 'finished')
  })

  test('stale after two failed polls in a row, or 15 s without a success', () => {
    assert.equal(freshnessState({ status: 'failed', settledAt: now - 6 * SECOND, failures: 1, ...page, now }), 'watching')
    assert.equal(freshnessState({ status: 'failed', settledAt: now - 11 * SECOND, failures: 2, ...page, now }), 'stale')
    assert.equal(freshnessState({ status: 'running', settledAt: now - 15 * SECOND, failures: 0, ...page, now }), 'live')
    assert.equal(freshnessState({ status: 'running', settledAt: now - 16 * SECOND, failures: 0, ...page, now }), 'stale')
  })

  test('a hidden tab is paused, and the 15 s start over when it becomes visible again', () => {
    assert.equal(freshnessState({ status: 'running', settledAt: now - HOUR, failures: 0, visible: false, visibleSince: now - HOUR, now }), 'hidden')
    assert.equal(freshnessState({ status: 'running', settledAt: now - HOUR, failures: 0, visible: true, visibleSince: now - 2 * SECOND, now }), 'live')
    assert.equal(freshnessState({ status: 'running', settledAt: now - HOUR, failures: 0, visible: true, visibleSince: now - 20 * SECOND, now }), 'stale')
  })
})
