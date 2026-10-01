/**
 * One mapping from state to colour tone for the Projects viewer (docs/PRD_VIEWER_REVAMP.md section 4).
 * Pure: no React, no DOM. Chips, card stripes, rail dots, graph nodes and step bars all go through it, so the
 * same state always shows the same colour. The accent hue is never a tone.
 */
import type { RunDetail, RunSummary } from '../../contracts/projects/v1'

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
  return (STATUS_TONE as Record<string, Tone>)[status] ?? 'idle'
}

/** The tone of a served attention kind; an unknown value is `idle`. */
export function attentionTone(kind: string): Tone {
  return (ATTENTION_TONE as Record<string, Tone>)[kind] ?? 'idle'
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
