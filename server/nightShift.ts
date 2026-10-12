import fs from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type { NightShiftDecision, NightShiftProvider } from '../contracts/projects/sessions.ts'
import { ID_PATTERN } from './projectsConfig.ts'
import { realpathOrNull } from './projects.ts'
import { iso } from './sessions.ts'

/**
 * The night-shift panel's decisions for a run (docs/PRD_RUN_SESSIONS.md 3.3, 4, [O1], [P13], [P1], [G4]). The records live
 * outside the run directory, under `MD_MANAGER_NIGHT_SHIFT_DIR` (default `~/.local/state/md-manager-workflows/night-shift`,
 * resolved from `HOME`), as `<date>/states/<run>-<kind>-<time>/record.json` with `jev.json` beside each. This module reads
 * them read-only and maps each onto a `night_shift` decision; a missing folder yields an empty list, and a missing or
 * malformed record is skipped, never an error for the run.
 *
 * A record belongs to a run when its `run_id` matches and either a run directory named in its texts resolves (realpath) to
 * this run's directory, or no text names any registered run directory and exactly one registered run has that `run_id`
 * ([P13]). Every served text passes the caller's redaction; the executed command is served redacted, a held decision carries
 * none. `decided_at` is the time in the record's `key`; a provider's `confidence` is the record's word; `jev` is the pick
 * from `jev.json`, else the record's error form, else null ([P1]).
 */

/** The default night-shift folder, resolved from the given HOME (`server/projects.ts` resolves `run_dir` from the same HOME). */
export function nightShiftDir(home: string, override: string | undefined): string {
  if (override !== undefined && override.length > 0) return override
  return join(home, '.local', 'state', 'md-manager-workflows', 'night-shift')
}

/** A record's shape, read permissively: only the keys this module maps are typed, anything else is ignored. */
const providerSchema = z.object({
  name: z.string().min(1),
  option: z.string().nullish(),
  text: z.string().nullish(),
  confidence: z.string().nullish(),
  needs_operator: z.boolean().nullish(),
  cost_usd: z.number().nullish(),
  error: z.string().nullish(),
})
const recordSchema = z.object({
  key: z.string().nullish(),
  run_id: z.string(),
  kind: z.string().min(1),
  node: z.string().nullish(),
  // `text` is the state description the engine records (`night_shift.py`); it is scanned for paths and never served raw.
  text: z.string().nullish(),
  providers: z.array(providerSchema).default([]),
  agreement: z.string().nullish(),
  jev: z.unknown().optional(),
  decision: z.enum(['executed', 'held']),
  option: z.string().nullish(),
  command: z.string().nullish(),
  held_reason: z.string().nullish(),
})
const jevFileSchema = z.object({ pick: z.string().min(1), confidence: z.number().nullish(), pass_floor: z.boolean().nullish(), model: z.string().nullish(), cost_usd: z.number().nullish() })

/** One decision as read, with Jev's own session facts when `jev.json` holds a pick (its model and cost; the Jev row, PRD 3.4). */
export type NightShiftRead = { decision: NightShiftDecision; jevRun: { model: string | null; cost_usd: number | null } | null }

export type NightShiftContext = {
  runId: string
  /** The HOME a `~/` token in a record's text expands against, the same HOME the run dir is resolved from (PRD 4). */
  home: string
  /** The realpath of this run's directory; null when it cannot be resolved (then only the uniqueness rule can match). */
  runDirRealpath: string | null
  /** Realpaths of every registered workflow's `runs_root`: a candidate path names a run directory when its parent is one. */
  runsRootRealpaths: ReadonlySet<string>
  /** Whether exactly one registered run across the whole registry has this `run_id` (the no-directory rule, [P13]). */
  uniqueRunId: boolean
  /** Path redaction + the credential filter (`redactText` of `server/projects.ts`); the command is served through it too. */
  redact: (text: string) => string
}

const FIRST_LINE_LIMIT = 200
const RECORD_BYTE_LIMIT = 1024 * 1024
/** A path token in a record's text: an absolute or `~/`-relative path of safe components (no spaces), long enough to be real. */
const PATH_TOKEN = /(?:^|[\s"'`=(])(~?\/[A-Za-z0-9._@~+/-]{3,})/g

function firstLine(text: string, redact: (t: string) => string): string {
  return redact(text).split('\n')[0]!.slice(0, FIRST_LINE_LIMIT)
}

/**
 * The time in the record's key (`<run>|<time>|<kind>|<node>`), always re-serialised to the contract's UTC form (`iso` of
 * `server/sessions.ts`), else null: a legacy or out-of-range form (a space for the `T`, hour 24, Feb 30) never reaches the
 * strict contract, so one record, shared by every run under the night-shift folder, can never fail the route ([O2]).
 */
function decidedAt(key: string | null | undefined): string | null {
  if (!key) return null
  return iso(key.split('|')[1])
}

/**
 * Every absolute path a record's texts name (the command, each provider's text, the top-level `text`, the held reason), with
 * a leading `~/` expanded against HOME (PRD 4): a record that names this run's directory home-relative must still match it,
 * and one that names another run's directory that way must still block the uniqueness fallback ([P13]).
 */
function pathTokens(record: z.infer<typeof recordSchema>, home: string): string[] {
  const texts = [record.command, record.held_reason, record.text, ...record.providers.map(p => p.text)].filter((t): t is string => typeof t === 'string')
  const tokens = new Set<string>()
  for (const text of texts) {
    for (const match of text.matchAll(PATH_TOKEN)) {
      const raw = match[1]!
      const expanded = raw.startsWith('~/') ? join(home, raw.slice(2)) : raw
      if (isAbsolute(expanded)) tokens.add(expanded)
    }
  }
  return [...tokens]
}

/** Whether a resolved path, or any ancestor of it, is a run directory under a registered runs root (a run-id basename). */
async function ancestorRunDir(real: string, context: NightShiftContext): Promise<string | null> {
  let current = real
  while (true) {
    const parent = await realpathOrNull(dirname(current))
    if (parent !== null && context.runsRootRealpaths.has(parent) && ID_PATTERN.test(basename(current))) return current
    const next = dirname(current)
    if (next === current) return null
    current = next
  }
}

/**
 * Whether this record belongs to the run ([P13], note 2): a token that is this run's directory or a path inside it belongs;
 * a token naming another run directory (or a path inside one) counts as "names a run dir" and blocks the uniqueness rule.
 * When no token names any registered run directory, the record belongs only when exactly one registered run has this id.
 */
async function belongs(record: z.infer<typeof recordSchema>, context: NightShiftContext): Promise<boolean> {
  let namesARunDir = false
  for (const token of pathTokens(record, context.home)) {
    const real = await realpathOrNull(token)
    if (real === null) continue
    // This run's directory, or any file or worktree inside it.
    if (context.runDirRealpath !== null && (real === context.runDirRealpath || real.startsWith(`${context.runDirRealpath}/`))) return true
    if (await ancestorRunDir(real, context) !== null) namesARunDir = true
  }
  return !namesARunDir && context.uniqueRunId
}

function projectProvider(provider: z.infer<typeof providerSchema>, redact: (t: string) => string): NightShiftProvider {
  return {
    // Every field here is a permissively parsed string from a file; redact each so no absolute path or credential shape
    // reaches the page (PRD 6), the same filter the command already passes. `redact` never empties a non-matching name.
    name: redact(provider.name),
    option: provider.option != null ? redact(provider.option) : null,
    text: provider.text != null ? redact(provider.text) : null,
    confidence: provider.confidence != null ? redact(provider.confidence) : null,
    needs_operator: provider.needs_operator ?? null,
    cost_usd: typeof provider.cost_usd === 'number' && provider.cost_usd >= 0 ? provider.cost_usd : null,
    error: provider.error != null ? firstLine(provider.error, redact) : null,
  }
}

function projectJev(raw: unknown, redact: (t: string) => string): NightShiftDecision['jev'] {
  const file = jevFileSchema.safeParse(raw)
  // `pick` is a model-emitted free string; redact it so no absolute path or credential shape reaches the page (PRD 6).
  if (file.success) return { pick: redact(file.data.pick) || file.data.pick, confidence: typeof file.data.confidence === 'number' && Number.isFinite(file.data.confidence) ? file.data.confidence : null, pass_floor: file.data.pass_floor ?? null }
  return null
}

/** Jev's result: `jev.json`'s pick, else an inline pick, else an inline error form, else null (the empty `{}`/`false`/null forms). */
function projectRecordJev(record: z.infer<typeof recordSchema>, jevFile: unknown, redact: (t: string) => string): NightShiftDecision['jev'] {
  const fromFile = projectJev(jevFile, redact)
  if (fromFile) return fromFile
  const inline = record.jev
  if (!inline || typeof inline !== 'object') return null
  const inlinePick = projectJev(inline, redact)
  if (inlinePick) return inlinePick
  if ('error' in inline && typeof (inline as { error: unknown }).error === 'string') {
    return { error: firstLine((inline as { error: string }).error, redact) || 'jev error' }
  }
  return null
}

function projectDecision(record: z.infer<typeof recordSchema>, jevFile: unknown, redact: (t: string) => string): NightShiftDecision {
  const executed = record.decision === 'executed'
  return {
    // `kind` and `agreement` are the record's own free strings; redact them like every other served text (PRD 6).
    kind: redact(record.kind),
    // An empty `node` is "no node", not a zero-length node id the strict contract would reject ([O2]).
    node_id: record.node && record.node.length > 0 ? record.node : null,
    decided_at: decidedAt(record.key),
    providers: record.providers.map(provider => projectProvider(provider, redact)),
    agreement: record.agreement && record.agreement.length > 0 ? redact(record.agreement) : 'one provider',
    jev: projectRecordJev(record, jevFile, redact),
    decision: record.decision,
    option: record.option != null ? redact(record.option) : null,
    command: executed && record.command != null ? redact(record.command) : null,
    held_reason: record.held_reason != null ? redact(record.held_reason) : null,
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    const bytes = await fs.readFile(path, { encoding: 'utf8' })
    if (bytes.length > RECORD_BYTE_LIMIT) return undefined
    return JSON.parse(bytes)
  } catch {
    return undefined
  }
}

/** Jev's own session facts from `jev.json` (its served model and cost), when the file holds a pick; else null. */
function jevRunOf(raw: unknown, redact: (t: string) => string): NightShiftRead['jevRun'] {
  const file = jevFileSchema.safeParse(raw)
  if (!file.success) return null
  const cost = file.data.cost_usd
  return { model: file.data.model != null ? redact(file.data.model) : null, cost_usd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null }
}

/** The run's night-shift decisions in `decided_at` order (nulls last), each redacted; [] when the folder is absent. */
export async function readNightShift(dir: string, context: NightShiftContext): Promise<NightShiftRead[]> {
  let dates: string[]
  try {
    dates = (await fs.readdir(dir, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name)
  } catch {
    return []
  }
  const decisions: NightShiftRead[] = []
  for (const date of dates.sort()) {
    const states = join(dir, date, 'states')
    let entries: string[]
    try {
      entries = (await fs.readdir(states, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name)
    } catch {
      continue
    }
    for (const entry of entries.sort()) {
      const stateDir = join(states, entry)
      const parsed = recordSchema.safeParse(await readJson(join(stateDir, 'record.json')))
      if (!parsed.success || parsed.data.run_id !== context.runId) continue
      // The contract requires an executed decision to carry a command; a record that executed but recorded none is dropped,
      // never served as a decision the strict payload would reject and 500 the whole route ([O2]).
      if (parsed.data.decision === 'executed' && parsed.data.command == null) continue
      if (!(await belongs(parsed.data, context))) continue
      const jevFile = await readJson(join(stateDir, 'jev.json'))
      decisions.push({ decision: projectDecision(parsed.data, jevFile, context.redact), jevRun: jevRunOf(jevFile, context.redact) })
    }
  }
  return decisions.sort(({ decision: a }, { decision: b }) => {
    if (a.decided_at === b.decided_at) return 0
    if (a.decided_at === null) return 1
    if (b.decided_at === null) return -1
    return Date.parse(a.decided_at) - Date.parse(b.decided_at)
  })
}
