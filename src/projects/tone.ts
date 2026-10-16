/**
 * One mapping from state to colour tone for the Projects viewer (docs/PRD_VIEWER_REVAMP.md section 4).
 * Pure: no React, no DOM. Chips, card stripes, rail dots, graph nodes and step bars all go through it, so the
 * same state always shows the same colour. The accent hue is never a tone.
 */
import type { RunDetail, RunSummary } from '../../contracts/projects/v1.ts'
import type { AgentState, TeamPhase, WorkflowStatus } from '../../contracts/projects/teams.ts'
import type { CHECK_BUCKETS, PushState, RunPr } from '../../contracts/projects/github.ts'

export type Tone = 'ok' | 'run' | 'warn' | 'fail' | 'pause' | 'override' | 'idle'
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
export function stateTone(input: { status?: string | null; attention?: string | null; accepted?: undefined }): Exclude<Tone, 'override'>
export function stateTone(input: { status?: string | null; attention?: string | null; accepted?: unknown }): Tone
export function stateTone(input: { status?: string | null; attention?: string | null; accepted?: unknown }): Tone {
  // The operator override (L12) is its own tone, whatever status it is served under; it waits on nobody.
  if (input.accepted) return 'override'
  if (input.attention) return attentionTone(input.attention)
  if (input.status) return statusTone(input.status)
  return 'idle'
}

/** CSS class for a tone, as `theme.css` spells it. */
export const toneClass = (tone: Tone): string => `tone-${tone}`

/** CSS class for a severity tone, as `theme.css` spells it. */
export const severityClass = (tone: SeverityTone): string => `sev-${tone}`

/** What each tone says in words, for the title of a rail dot and anything else drawn in a tone: colour never carries state alone. */
export const TONE_LABEL: Record<Tone, string> = {
  ok: 'Succeeded',
  run: 'Running',
  warn: 'Needs you',
  fail: 'Failed',
  pause: 'Paused',
  override: 'Integrated (operator override)',
  idle: 'Idle',
}

// ---- Teams and GitHub (docs/PRD_RUN_TEAMS.md 8 "Visual language and tokens") -------------------------------------------
// Each returns the tone and the lower-case word that repeats it, so no state is shown by colour alone.

/** A tone and the lower-case word said beside its glyph. */
export type ToneWord = { tone: Tone; word: string }

/**
 * A view's state suffix in the run switcher (docs/PRD_RUN_TEAMS.md 2): a glyph in `tone` (none when null), a lower-case
 * `word`, and `spoken`, the words its link's accessible name carries ("pull request 531, checks failing").
 */
export type Suffix = { tone: Tone | null; word: string; spoken: string }

const AGENT_TONE: Record<AgentState, Tone> = { done: 'ok', running: 'run', failed: 'fail', interrupted: 'pause', queued: 'idle' }

/** An agent's state: done ok, running run, failed fail, interrupted pause, queued idle; the word is the contract's own. */
export function agentTone(state: AgentState): ToneWord {
  return { tone: AGENT_TONE[state] ?? 'idle', word: state }
}

const WORKFLOW_TONE: Record<WorkflowStatus, Tone> = { completed: 'ok', running: 'run', failed: 'fail', interrupted: 'pause', killed: 'idle' }

/** A team workflow's status: completed ok, running run, failed fail, interrupted pause, killed idle. */
export function workflowTone(status: WorkflowStatus): ToneWord {
  return { tone: WORKFLOW_TONE[status] ?? 'idle', word: status }
}

/**
 * A phase by its agents' counts, in the precedence fail > run > pause > ok > idle: any failed, any running, any interrupted,
 * all done (and at least one), else idle: "not started" when no agent reached it, "queued" when only queued (or some done
 * and the rest queued).
 */
export function phaseTone(phase: Pick<TeamPhase, 'agents' | 'queued' | 'running' | 'done' | 'failed' | 'interrupted'>): ToneWord {
  if (phase.failed > 0) return { tone: 'fail', word: 'failed' }
  if (phase.running > 0) return { tone: 'run', word: 'running' }
  if (phase.interrupted > 0) return { tone: 'pause', word: 'interrupted' }
  if (phase.agents > 0 && phase.done === phase.agents) return { tone: 'ok', word: 'all done' }
  if (phase.agents === 0) return { tone: 'idle', word: 'not started' }
  return { tone: 'idle', word: 'queued' }
}

const PUSH_TONE: Record<PushState, ToneWord> = {
  up_to_date: { tone: 'ok', word: 'up to date' },
  remote_ahead: { tone: 'warn', word: 'behind GitHub' },
  diverged: { tone: 'fail', word: 'diverged' },
  not_pushed: { tone: 'idle', word: 'not pushed' },
  local_ahead: { tone: 'idle', word: 'ahead' },
  unknown: { tone: 'idle', word: 'unknown' },
  no_local_branch: { tone: 'idle', word: 'not in repo' },
}

/** Where the run branch stands against its remote: up to date ok, behind GitHub warn, diverged fail, the rest idle. */
export function pushTone(state: PushState): ToneWord {
  return PUSH_TONE[state] ?? { tone: 'idle', word: 'unknown' }
}

/**
 * A pull request's own state, then what holds it: merged ok, closed idle, draft idle, conflicts fail, changes requested
 * fail, approved ok, review required idle, otherwise open (run: it waits on review). Checks have their own `checkTone`.
 */
export function prTone(pr: Pick<RunPr, 'state' | 'draft'> & Partial<Pick<RunPr, 'mergeable' | 'review_decision'>>): ToneWord {
  if (pr.state === 'MERGED') return { tone: 'ok', word: 'merged' }
  if (pr.state === 'CLOSED') return { tone: 'idle', word: 'closed' }
  if (pr.draft) return { tone: 'idle', word: 'draft' }
  if (pr.mergeable === 'CONFLICTING') return { tone: 'fail', word: 'conflicts' }
  if (pr.review_decision === 'CHANGES_REQUESTED') return { tone: 'fail', word: 'changes requested' }
  if (pr.review_decision === 'APPROVED') return { tone: 'ok', word: 'approved' }
  if (pr.review_decision === 'REVIEW_REQUIRED') return { tone: 'idle', word: 'review required' }
  return { tone: 'run', word: 'open' }
}

const CHECK_TONE: Record<(typeof CHECK_BUCKETS)[number], ToneWord> = {
  pass: { tone: 'ok', word: 'pass' },
  fail: { tone: 'fail', word: 'failing' },
  pending: { tone: 'run', word: 'pending' },
  skip: { tone: 'idle', word: 'skipped' },
  neutral: { tone: 'idle', word: 'neutral' },
}

/** One check by its bucket: pass ok, fail fail ("failing"), pending run, skip and neutral idle. */
export function checkTone(bucket: (typeof CHECK_BUCKETS)[number]): ToneWord {
  return CHECK_TONE[bucket] ?? { tone: 'idle', word: 'neutral' }
}

/** The team precedence within a container: a failure is never hidden by activity. */
const TEAM_PRECEDENCE: readonly Tone[] = ['fail', 'run', 'pause', 'ok', 'idle']

/** The tone a container of these tones takes, fail > run > pause > ok > idle; `idle` for none (other tones count as idle). */
export function precedenceTone(tones: Iterable<Tone>): Tone {
  let best = TEAM_PRECEDENCE.length - 1
  for (const tone of tones) {
    const rank = TEAM_PRECEDENCE.indexOf(tone)
    if (rank >= 0 && rank < best) best = rank
  }
  return TEAM_PRECEDENCE[best]
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
