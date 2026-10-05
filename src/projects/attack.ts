/**
 * The attack pass section's model (docs/PRD_ATTACK_PASS.md 4.6 and Appendix A): the pass's counts and headline, a finding's
 * effective severity and current label, the verified cards' order, the folded findings' order and the label command the
 * operator types. Pure (no React), so the section and the unit tests read the same values. The viewer never runs the command.
 */
import { BY_OPERATOR } from '../../contracts/projects/triage.ts'
import type { AttackFinding, AttackLabel, AttackRecord } from '../../contracts/projects/v1.ts'

type PassRecord = Pick<AttackRecord, 'status' | 'findings'>
type Severity = AttackFinding['severity']

/** The pass's counts as the closing event names them: every finding, those whose re-run reproduced, those verified. */
export type AttackCounts = { findings: number; reproduced: number; verified: number }

const SEVERITY_RANK: { [severity in Severity]: number } = { P0: 0, P1: 1, P2: 2 }
/** The folded findings, in this order: reproduced but not judged, refuted by the skeptic, then not reproduced. */
const FOLDED_ORDER: readonly AttackFinding['status'][] = ['unjudged', 'refuted', 'not_reproduced']

/** The pass status in words: `pending` says it runs at the review step. */
export const ATTACK_STATUS_WORDING: { [status in AttackRecord['status']]: string } = {
  pending: 'pending: runs at the review step',
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  refused: 'refused',
}

/** A finding's status in words. */
export const FINDING_STATUS_WORDING: { [status in AttackFinding['status']]: string } = {
  verified: 'verified',
  unjudged: 'reproduced, not judged',
  refuted: 'refuted by the skeptic',
  not_reproduced: 'not reproduced',
}

/** Why a re-run did not reproduce, in words. */
const RERUN_REASON_WORDING: { [reason in NonNullable<NonNullable<AttackFinding['rerun']>['reason']>]: string } = {
  passed: 'the test passed on the clean copy',
  no_test: 'no test ran',
  setup_failed: 'the setup failed',
  timed_out: 'the re-run timed out',
  error: 'an import, collection or setup error, not a failed assertion',
}

/** `A-2` before `A-10`: the number after the last dash, else the id as text. */
function byId(a: { id: string }, b: { id: string }): number {
  const number = (id: string) => Number(/-(\d+)$/.exec(id)?.[1] ?? NaN)
  const [x, y] = [number(a.id), number(b.id)]
  if (!Number.isNaN(x) && !Number.isNaN(y) && x !== y) return x - y
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function attackCounts(record: Pick<AttackRecord, 'findings'>): AttackCounts {
  return {
    findings: record.findings.length,
    reproduced: record.findings.filter(finding => finding.rerun?.status === 'reproduced').length,
    verified: record.findings.filter(finding => finding.status === 'verified').length,
  }
}

/** `2 finding(s), 1 reproduced, 1 verified`: the closing event's own wording (Appendix A, Events). */
export function countsText(counts: AttackCounts): string {
  return `${counts.findings} finding(s), ${counts.reproduced} reproduced, ${counts.verified} verified`
}

/** A verified finding shows the skeptic's severity (it may only lower it); any other finding its own. */
export function effectiveSeverity(finding: Pick<AttackFinding, 'status' | 'severity' | 'skeptic'>): Severity {
  return finding.status === 'verified' && finding.skeptic !== null ? finding.skeptic.severity : finding.severity
}

/** The latest entry of `labels`, or null when the operator has not labelled the finding. */
export function currentLabel(finding: Pick<AttackFinding, 'labels'>): AttackLabel | null {
  return finding.labels.at(-1) ?? null
}

/** The verified findings, one card each: P0 first, then P1, then P2 (by the severity shown), each by id. */
export function verifiedFindings(record: Pick<AttackRecord, 'findings'>): AttackFinding[] {
  return record.findings.filter(finding => finding.status === 'verified')
    .sort((a, b) => SEVERITY_RANK[effectiveSeverity(a)] - SEVERITY_RANK[effectiveSeverity(b)] || byId(a, b))
}

/** The findings folded under one disclosure: unjudged, then refuted, then not reproduced, each by id. */
export function foldedFindings(record: Pick<AttackRecord, 'findings'>): AttackFinding[] {
  return record.findings.filter(finding => finding.status !== 'verified')
    .sort((a, b) => FOLDED_ORDER.indexOf(a.status) - FOLDED_ORDER.indexOf(b.status) || byId(a, b))
}

/** Verified findings the operator has not labelled yet. */
export function unlabelled(record: Pick<AttackRecord, 'findings'>): number {
  return verifiedFindings(record).filter(finding => currentLabel(finding) === null).length
}

/**
 * The command that labels a verified finding (PRD 4.7), to copy: `"$PY" -m workflow attack-label "$RUN" <id> --label
 * real|false|out-of-scope --by operator`. `--review-found` and `--note` are optional and left to the operator.
 */
export function labelCommand(findingId: string): string {
  return `"$PY" -m workflow attack-label "$RUN" ${findingId} --label real|false|out-of-scope ${BY_OPERATOR}`
}

/** A folded finding's re-run reason in words; null when it reproduced (or was not re-run). */
export function rerunReason(finding: Pick<AttackFinding, 'rerun'>): string | null {
  const reason = finding.rerun?.reason ?? null
  return reason === null ? null : RERUN_REASON_WORDING[reason]
}

/** The pass statuses that no longer run anything: a `rerun: null` finding will never be re-run now. */
const TERMINAL_PASS: ReadonlySet<AttackRecord['status']> = new Set(['succeeded', 'failed', 'refused'])

/**
 * A folded finding's re-run line: its reason (prefixed `re-run:`), or — for a `not_reproduced` finding whose `rerun` is still
 * null, a re-run the controller still owes (decisions L15) — `re-run pending` while the pass runs, `not re-run` once it ended.
 * Null for a finding with nothing to say (a reproduced one). It takes the pass status so a live record never throws.
 */
export function rerunLine(record: Pick<AttackRecord, 'status'>, finding: Pick<AttackFinding, 'status' | 'rerun'>): string | null {
  const reason = rerunReason(finding)
  if (reason !== null) return `re-run: ${reason}`
  if (finding.status === 'not_reproduced' && finding.rerun === null) return TERMINAL_PASS.has(record.status) ? 'not re-run' : 're-run pending'
  return null
}

/** The headline: `Succeeded · 2 finding(s), 1 reproduced, 1 verified`; a pending pass names only its status. */
export function attackHeadline(record: PassRecord): { status: string; counts: string | null } {
  const status = ATTACK_STATUS_WORDING[record.status]
  return { status: status.charAt(0).toUpperCase() + status.slice(1), counts: record.status === 'pending' ? null : countsText(attackCounts(record)) }
}

/** How long an attacker ran; null when either time is missing or does not read. */
export function attackerDuration(attacker: { started_at: string | null; finished_at: string | null }): number | null {
  if (attacker.started_at === null || attacker.finished_at === null) return null
  const ms = Date.parse(attacker.finished_at) - Date.parse(attacker.started_at)
  return Number.isNaN(ms) || ms < 0 ? null : ms
}

/** `$7.42`; `—` when the cost is not recorded. */
export function costText(cost: number | null): string {
  return cost === null ? '—' : `$${cost.toFixed(2)}`
}
