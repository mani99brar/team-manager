/**
 * One mapping from state to colour tone for the Projects viewer (docs/PRD_VIEWER_REVAMP.md section 4).
 * Pure: no React, no DOM. Chips, card stripes, rail dots, graph nodes and step bars all go through it, so the
 * same state always shows the same colour. The accent hue is never a tone.
 */
import type { RunDetail, RunSummary } from '../../contracts/projects/v1.ts'

export type Tone = 'ok' | 'run' | 'warn' | 'fail' | 'pause' | 'idle'
export type Severity = 'P0' | 'P1' | 'P2'
export type SeverityTone = 'p0' | 'p1' | 'p2'

type Status = RunDetail['summary']['status']
type AttentionKind = NonNullable<NonNullable<RunSummary['activity']>['attention']>['kind']

const STATUS_TONE: Record<Status, Tone> = {
  pending: 'idle',
  running: 'run',
  awaiting_approval: 'warn',
  paused: 'pause',
  succeeded: 'ok',
  failed: 'fail',
  cancelled: 'idle',
}

const ATTENTION_TONE: Record<AttentionKind, Tone> = {
  question: 'warn',
  pane: 'warn',
  approval: 'warn',
  interrupted: 'pause',
  paused: 'pause',
  failed: 'fail',
}

/** The tone of a run or node status; an unknown value is `idle`. */
export function statusTone(status: string): Tone {
  return Object.hasOwn(STATUS_TONE, status) ? (STATUS_TONE as Record<string, Tone>)[status] : 'idle'
}

/** The tone of a served attention kind; an unknown value is `idle`. */
export function attentionTone(kind: string): Tone {
  return Object.hasOwn(ATTENTION_TONE, kind) ? (ATTENTION_TONE as Record<string, Tone>)[kind] : 'idle'
}

/** The tone of a review severity; an unknown value is `p2`. */
export function severityTone(severity: string): SeverityTone {
  return severity === 'P0' ? 'p0' : severity === 'P1' ? 'p1' : 'p2'
}

/**
 * The one tone for an element that may carry a status and an attention: attention wins, because a running run
 * that waits on the operator is shown as "needs you" everywhere.
 */
export function stateTone(input: { status?: string | null; attention?: string | null }): Tone {
  if (input.attention) return attentionTone(input.attention)
  if (input.status) return statusTone(input.status)
  return 'idle'
}

/** CSS class for a tone, as `theme.css` spells it. */
export const toneClass = (tone: Tone): string => `tone-${tone}`

/** CSS class for a severity tone, as `theme.css` spells it. */
export const severityClass = (tone: SeverityTone): string => `sev-${tone}`

export const LOOKS = ['calm', 'bold'] as const
export type Look = (typeof LOOKS)[number]
export const LOOK_STORAGE_KEY = 'mdm-look'

/** The look to apply from a stored value: anything but `bold` is `calm`. */
export function lookFromStored(value: string | null | undefined): Look {
  return value === 'bold' ? 'bold' : 'calm'
}

/** What each tone says in words, for the title of a rail dot and anything else drawn in a tone: colour never carries state alone. */
export const TONE_LABEL: Record<Tone, string> = {
  ok: 'Succeeded',
  run: 'Running',
  warn: 'Needs you',
  fail: 'Failed',
  pause: 'Paused',
  idle: 'Idle',
}

/** An sRGB colour as `[r, g, b, alpha]`, from `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()` or `transparent`; null otherwise. */
export function parseColor(value: string): [number, number, number, number] | null {
  const text = value.trim().toLowerCase()
  if (text === 'transparent') return [0, 0, 0, 0]
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text)
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map(digit => digit + digit).join('') : hex[1]
    const channel = (index: number) => parseInt(digits.slice(index * 2, index * 2 + 2), 16)
    return [channel(0), channel(1), channel(2), digits.length === 8 ? channel(3) / 255 : 1]
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(text)
  if (rgb) {
    const alpha = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? Number(rgb[4].slice(0, -1)) / 100 : Number(rgb[4])
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), alpha]
  }
  return null
}

const luminance = ([r, g, b]: readonly number[]) => {
  const linear = (channel: number) => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

/** The WCAG 2 contrast ratio of two opaque colours (1 to 21); an unreadable colour gives 1, so a check on it fails. */
export function contrastRatio(a: string, b: string): number {
  const first = parseColor(a)
  const second = parseColor(b)
  if (first === null || second === null) return 1
  const [light, dark] = [luminance(first), luminance(second)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}
