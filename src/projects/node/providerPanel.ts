/**
 * The Panel section's model (docs/PRD_MULTI_PROVIDER_PANEL.md 4.5, Appendix A): a panel's counts and headline, the accepted
 * and folded findings' orders, a finding's `file:line` and overlap, a provider's name as `providers_raised` spells it, and
 * its cost line (`subscription-covered` for an openai-codex row, the dollar estimate for a metered one). Pure (no React), so
 * the section and the unit tests read the same values. The record is read-only: nothing here acts on the panel.
 */
import type { PanelEntry, PanelFinding, PanelProvider } from '../../../contracts/projects/v1.ts'

type Severity = PanelFinding['severity']

/** A panel's counts as the headline names them: every finding (unanchored included) and those accepted by the overlap rule. */
export type PanelCounts = { findings: number; accepted: number }

const SEVERITY_RANK: { [severity in Severity]: number } = { P0: 0, P1: 1, P2: 2 }

/** The panel status in words. */
export const PANEL_STATUS_WORDING: { [status in PanelEntry['status']]: string } = {
  pending: 'pending',
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  timed_out: 'timed out',
}

/** A provider's status in words: `error` is a provider that died, `parse_failed` one that answered without findings JSON. */
export const PROVIDER_STATUS_WORDING: { [status in PanelProvider['status']]: string } = {
  pending: 'pending',
  running: 'running',
  ok: 'ok',
  timed_out: 'timed out',
  error: 'failed',
  parse_failed: 'parse failed',
}

/** The statuses that no longer run anything. */
export const TERMINAL_PANEL: ReadonlySet<PanelEntry['status']> = new Set(['succeeded', 'failed', 'timed_out'])

/** `f2` before `f10`: the trailing number, else the id as text; equal ids keep their declaration order. */
function byId(a: { id: string }, b: { id: string }): number {
  const number = (id: string) => Number(/(\d+)$/.exec(id)?.[1] ?? NaN)
  const [x, y] = [number(a.id), number(b.id)]
  if (!Number.isNaN(x) && !Number.isNaN(y) && x !== y) return x - y
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function panelCounts(panel: Pick<PanelEntry, 'findings'>): PanelCounts {
  return { findings: panel.findings.length, accepted: panel.findings.filter(finding => finding.accepted).length }
}

/** `3 finding(s), 1 accepted`. */
export function countsText(counts: PanelCounts): string {
  return `${counts.findings} finding(s), ${counts.accepted} accepted`
}

/** The overlap rule in words: `accepted when raised by ≥2 providers`, `… by every provider (2)`, `… by any provider`. */
export function thresholdText(panel: Pick<PanelEntry, 'overlap_threshold' | 'providers'>): string {
  const threshold = panel.overlap_threshold
  if (threshold === 'all') return `accepted when raised by every provider (${panel.providers.length})`
  if (threshold === 1) return 'accepted when raised by any provider'
  return `accepted when raised by ≥${threshold} providers`
}

/** `review stage` / `challenge stage`. */
export function stageText(panel: Pick<PanelEntry, 'stage'>): string {
  return `${panel.stage} stage`
}

/**
 * The headline: `Succeeded`, `review stage`, `3 finding(s), 1 accepted`; a pending panel says it runs at its stage and names
 * no counts yet.
 */
export function panelHeadline(panel: Pick<PanelEntry, 'status' | 'stage' | 'findings'>): { status: string; stage: string; counts: string | null } {
  const wording = panel.status === 'pending' ? `pending: runs at the ${panel.stage} stage` : PANEL_STATUS_WORDING[panel.status]
  return { status: wording.charAt(0).toUpperCase() + wording.slice(1), stage: stageText(panel), counts: panel.status === 'pending' ? null : countsText(panelCounts(panel)) }
}

/** The accepted findings, one card each: P0 first, then P1, then P2, each by id. */
export function acceptedFindings(panel: Pick<PanelEntry, 'findings'>): PanelFinding[] {
  return panel.findings.filter(finding => finding.accepted)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || byId(a, b))
}

/** The findings folded under one disclosure: the anchored but not accepted ones first, then the unanchored, each by severity then id. */
export function foldedFindings(panel: Pick<PanelEntry, 'findings'>): PanelFinding[] {
  return panel.findings.filter(finding => !finding.accepted)
    .sort((a, b) => Number(a.unanchored) - Number(b.unanchored) || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || byId(a, b))
}

/** `packages/api/src/reconcile.ts:52`; the file alone when the provider gave no line. */
export function fileLocation(finding: Pick<PanelFinding, 'file' | 'line'>): string {
  return finding.line === null ? finding.file : `${finding.file}:${finding.line}`
}

/** How many providers raised the finding: above one it is an overlap, the record's highest-confidence signal. */
export function overlapCount(finding: Pick<PanelFinding, 'providers_raised'>): number {
  return finding.providers_raised.length
}

/** A provider's name as `providers_raised` spells it: its `provider/id` model, or its transport for a default claude. */
export function providerName(provider: Pick<PanelProvider, 'transport' | 'model'>): string {
  return provider.model ?? provider.transport
}

/** An `openai-codex` provider runs on a flat-rate ChatGPT account: its reported cost is pi's estimate, not out-of-pocket. */
export function isSubscriptionCovered(provider: Pick<PanelProvider, 'model'>): boolean {
  return provider.model !== null && provider.model.startsWith('openai-codex/')
}

/** `$0.021`, `$0.0047`, `$5.00` (small estimates keep up to four decimals so they never read as $0.00); `—` when not recorded. */
export function costText(cost: number | null): string {
  if (cost === null) return '—'
  if (cost >= 1 || cost === 0) return `$${cost.toFixed(2)}`
  const trimmed = cost.toFixed(4).replace(/0+$/, '')
  const decimals = trimmed.length - trimmed.indexOf('.') - 1
  return `$${decimals < 2 ? cost.toFixed(2) : trimmed}`
}

/** The literal `subscription-covered` for an openai-codex row (the record keeps its estimate); the dollar estimate otherwise. */
export function providerCostText(provider: Pick<PanelProvider, 'model' | 'cost_usd'>): string {
  return isSubscriptionCovered(provider) ? 'subscription-covered' : costText(provider.cost_usd)
}

/** `48.2 kB` of context; null when not recorded. */
export function contextText(bytes: number | null): string | null {
  if (bytes === null) return null
  return bytes < 1000 ? `${bytes} B` : `${(bytes / 1000).toFixed(1)} kB`
}

/** How long the panel ran; null when either time is missing or does not read. */
export function panelDuration(panel: Pick<PanelEntry, 'started_at' | 'ended_at'>): number | null {
  if (panel.started_at === null || panel.ended_at === null) return null
  const ms = Date.parse(panel.ended_at) - Date.parse(panel.started_at)
  return Number.isNaN(ms) || ms < 0 ? null : ms
}

/** The panels of one stage, in record order: the challenge view shows only the `challenge` ones. */
export function panelsAtStage<T extends Pick<PanelEntry, 'stage'>>(panels: readonly T[], stage: PanelEntry['stage']): T[] {
  return panels.filter(panel => panel.stage === stage)
}
