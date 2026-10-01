/**
 * The review sidecar page's model (docs/PRD_REVIEW_SIDECAR.md 4.9): the one headline, the open findings P0/P1 first then by
 * id, the closed ones apart, the last transition of a finding, message and pass wording, and the section index entries. Pure
 * (no React), so the sections and the unit tests read the same values.
 */
import {
  SIDECAR_OPEN_DISPOSITIONS,
  type SidecarFinding, type SidecarLedger, type SidecarMessage, type SidecarPass,
} from '../../../contracts/projects/v1.ts'
import type { SectionEntry } from './model.ts'

type Ledger = Pick<SidecarLedger, 'passes' | 'findings' | 'messages' | 'escalations'>
type Severity = SidecarFinding['severity']

/** The headline's parts; `empty` when no pass has run yet (or no ledger is recorded). */
export type SidecarHeadline = { empty: boolean; passes: string; open: string; messages: string; lastPassAt: string | null }
/** A finding's last transition: its latest history entry, else its own values (a ledger without history). */
export type Transition = { pass: number | null; disposition: SidecarFinding['disposition']; revision: string; evidence: string; at: string | null }

const SEVERITY_RANK: Record<Severity, number> = { P0: 0, P1: 1, P2: 2 }
const OPEN: readonly string[] = SIDECAR_OPEN_DISPOSITIONS
const MESSAGE_STATUSES: readonly SidecarMessage['status'][] = ['delivered', 'undeliverable', 'refused', 'pending']

const REASON_WORDING: Record<NonNullable<SidecarMessage['reason']>, string> = {
  question_waiting: 'a question was waiting',
  lane_finished: 'the lane had gone on (a completion, a handoff or a stop)',
  lane_not_launched: 'the lane was not launched',
  rate_limited: 'the lane had its messages for this pass or this run',
  after_freeze: 'the run was frozen',
  lane_blocked: 'the lane was blocked (a dialog, a menu or a refusal)',
  pane_busy: 'the pane was busy (a dialog, a menu or a draft)',
  pane_unknown: 'the pane is unknown',
  pane_not_attached: 'the pane was not showing the session',
  herdr_unavailable: 'Herdr was unavailable',
  herdr_timeout: 'Herdr timed out',
  interrupted: 'interrupted before delivery',
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/** `S-2` before `S-10`: the number after the last dash, else the id as text. */
function byId(a: { id: string }, b: { id: string }): number {
  const number = (id: string) => Number(/-(\d+)$/.exec(id)?.[1] ?? NaN)
  const [x, y] = [number(a.id), number(b.id)]
  if (!Number.isNaN(x) && !Number.isNaN(y) && x !== y) return x - y
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function isOpenFinding(finding: Pick<SidecarFinding, 'disposition'>): boolean {
  return OPEN.includes(finding.disposition)
}

/** Open, acknowledged and fix_reported findings: P0 first, then P1, then P2, each by id. */
export function openFindings(ledger: Pick<Ledger, 'findings'>): SidecarFinding[] {
  return ledger.findings.filter(isOpenFinding).sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || byId(a, b))
}

/** Verified resolved, withdrawn and accepted trade-offs, by id. */
export function resolvedFindings(ledger: Pick<Ledger, 'findings'>): SidecarFinding[] {
  return ledger.findings.filter(finding => !isOpenFinding(finding)).sort(byId)
}

/** The page's two groups by disposition. */
export function findingGroups(ledger: Pick<Ledger, 'findings'>): { open: SidecarFinding[]; resolved: SidecarFinding[] } {
  return { open: openFindings(ledger), resolved: resolvedFindings(ledger) }
}

/** Passes that did not complete: failed, rejected, timed out or interrupted. */
export function failedPasses(ledger: Pick<Ledger, 'passes'>): number {
  return ledger.passes.filter(pass => pass.status !== 'completed').length
}

function openWords(ledger: Pick<Ledger, 'findings'>): string {
  const open = openFindings(ledger)
  if (open.length === 0) return 'nothing open'
  const severe = (['P0', 'P1'] as const).map(severity => [severity, open.filter(finding => finding.severity === severity).length] as const)
    .filter(([, count]) => count > 0).map(([severity, count]) => `${count} ${severity}`)
  return `${open.length} open${severe.length ? ` (${severe.join(', ')})` : ''}`
}

function messageWords(ledger: Pick<Ledger, 'messages'>): string {
  const counts = MESSAGE_STATUSES.map(status => [status, ledger.messages.filter(message => message.status === status).length] as const).filter(([, count]) => count > 0)
  if (counts.length === 0) return 'no message'
  return counts.map(([status, count], index) => (index === 0 ? `${plural(count, 'message')} ${status}` : `${count} ${status}`)).join(', ')
}

/**
 * The headline (4.9): `2 of 6 passes failed · 3 open (2 P1) · 2 messages delivered, 1 undeliverable · last pass <time>`; a
 * run whose sidecar has not run yet, or whose ledger is not recorded, has none.
 */
export function sidecarHeadline(ledger: Ledger | null): SidecarHeadline {
  if (ledger === null || ledger.passes.length === 0) return { empty: true, passes: 'no pass yet', open: '', messages: '', lastPassAt: null }
  const failed = failedPasses(ledger)
  const count = ledger.passes.length
  const last = ledger.passes.reduce((latest, pass) => (pass.n > latest.n ? pass : latest))
  return {
    empty: false,
    passes: failed > 0 ? `${failed} of ${count} ${count === 1 ? 'pass' : 'passes'} failed` : `${count} ${count === 1 ? 'pass' : 'passes'}`,
    open: openWords(ledger),
    messages: messageWords(ledger),
    lastPassAt: last.finished_at,
  }
}

/** The headline as one string; the page renders the clock and the age through its own components. */
export function headlineText(headline: SidecarHeadline, format: { clock: (iso: string) => string; ago: (iso: string) => string }): string {
  if (headline.empty) return headline.passes
  const last = headline.lastPassAt === null ? [] : [`last pass ${format.clock(headline.lastPassAt)} (${format.ago(headline.lastPassAt)})`]
  return [headline.passes, headline.open, headline.messages, ...last].join(' · ')
}

/** A finding's own fields are its latest values; the latest history entry names the pass and time of that transition. */
export function lastTransition(finding: SidecarFinding): Transition {
  const entry = finding.history.at(-1)
  if (!entry) return { pass: null, disposition: finding.disposition, revision: finding.revision, evidence: finding.evidence, at: null }
  return { pass: entry.pass, disposition: entry.disposition, revision: entry.revision, evidence: entry.evidence, at: entry.at }
}

/** `delivered`, `refused: a question was waiting`, `undeliverable: the pane was busy (…)`, `pending`. */
export function messageStatusWording(message: Pick<SidecarMessage, 'status' | 'reason'>): string {
  return message.reason === null ? message.status : `${message.status}: ${REASON_WORDING[message.reason]}`
}

/** How long a pass took; null when either time does not read. */
export function passDuration(pass: Pick<SidecarPass, 'started_at' | 'finished_at'>): number | null {
  const ms = Date.parse(pass.finished_at) - Date.parse(pass.started_at)
  return Number.isNaN(ms) || ms < 0 ? null : ms
}

/** The lanes a pass read, with the head it read and whether their pane text was captured. */
export function passLanes(pass: Pick<SidecarPass, 'lanes'>): { lane: string; head: string; pane: boolean }[] {
  return Object.entries(pass.lanes).map(([lane, read]) => ({ lane, head: read.head_commit, pane: read.pane_captured }))
}

/** The page's index: each section only when it holds something; Handoff whenever a ledger is recorded (it says when no final pass ran). */
export function sidecarSectionEntries(ledger: Ledger | null): SectionEntry[] {
  if (ledger === null) return []
  const { open, resolved } = findingGroups(ledger)
  const counted = (key: string, label: string, count: number): SectionEntry[] => (count > 0 ? [{ key, label, count }] : [])
  return [
    ...counted('sidecar-open', 'Open', open.length),
    ...counted('sidecar-escalations', 'Escalations', ledger.escalations.length),
    ...counted('sidecar-resolved', 'Resolved', resolved.length),
    ...counted('sidecar-messages', 'Messages', ledger.messages.length),
    ...counted('sidecar-passes', 'Passes', ledger.passes.length),
    { key: 'sidecar-handoff', label: 'Handoff' },
  ]
}
