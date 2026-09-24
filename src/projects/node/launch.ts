/**
 * The launch node's model (docs/PRD_VIEWER_UX.md 4.5, 7, 8): the file rows, read from the worker's own freeze
 * (`results/<lane>/1`) with a `⚒ repair n` mark on each path the latest result changed or added and the review's findings
 * first; the verifier's addition to the worker's report; and the sections the index lists, the waiting Questions first.
 * Pure, so the page and the unit tests read the same values; `files.ts` holds a hook, so only its types are imported.
 */
import type { NextStep } from '../../../contracts/projects/triage.ts'
import type { ReviewFinding, RunInputWorker, WorkerResult } from '../api.ts'
import type { CapturedFile, NotCapturedFile } from '../files.ts'
import { findingsForFile } from '../findings.ts'
import { filesCount, type SectionEntry } from './model.ts'

/** How the latest result differs from the freeze for one path, and the repair it is credited to ("repair 1"). */
export type RepairMark = { kind: 'changed' | 'added'; label: string }
/** What the result's summary adds to the worker's report: nothing, the verifier's added text, or a different summary. */
export type ReportDelta = { kind: 'same' } | { kind: 'extends'; note: string } | { kind: 'differs'; summary: string }
export type FileFilter = 'findings' | 'repair' | 'all'
export type FileRow = {
  path: string
  /** The captured file whose content the row opens on: the latest result's, else the freeze's. */
  file: CapturedFile | null
  reason: NotCapturedFile['reason'] | null
  state: 'captured' | 'not-captured' | 'unlisted' | 'not-recorded'
  /** The review findings that name the path verbatim, in review order. */
  findings: ReviewFinding[]
  severity: ReviewFinding['severity'] | null
  repair: RepairMark | null
  markdown: boolean
}

const SEVERITY_RANK: Record<ReviewFinding['severity'], number> = { P0: 0, P1: 1, P2: 2 }

function captures(result: WorkerResult): Map<string, CapturedFile> {
  const files = result.artifacts.filter((artifact): artifact is CapturedFile => artifact.kind === 'file' && typeof artifact.path === 'string')
  return new Map(files.map(file => [file.path, file]))
}

function reasons(result: WorkerResult): Map<string, NotCapturedFile['reason']> {
  return new Map((result.files_not_captured ?? []).map(entry => [entry.path, entry.reason]))
}

/** Every path a result lists: its changed files in order, then any captured or not-captured path they do not name. */
function listedPaths(result: WorkerResult): string[] {
  const listed = [...result.changed_files]
  for (const path of [...captures(result).keys(), ...reasons(result).keys()]) if (!listed.includes(path)) listed.push(path)
  return listed
}

/**
 * The paths the latest result changed against the worker's freeze (9.1 "Repair badges"): a captured file whose sha256
 * differs, or a path only the later result lists. Nothing when either result is missing or they are the same result.
 */
export function repairMarks(first: WorkerResult | null, latest: WorkerResult | null, label: string): Map<string, RepairMark> {
  const marks = new Map<string, RepairMark>()
  if (first === null || latest === null || first.attempt === latest.attempt) return marks
  const before = captures(first)
  const known = new Set(listedPaths(first))
  for (const [path, file] of captures(latest)) {
    const frozen = before.get(path)
    if (frozen && frozen.sha256 !== file.sha256) marks.set(path, { kind: 'changed', label })
  }
  for (const path of listedPaths(latest)) if (!known.has(path)) marks.set(path, { kind: 'added', label })
  return marks
}

/**
 * The rows of Files: the freeze's paths (the latest result's when the freeze is not loaded) plus those a repair added, each
 * with how it was captured and the findings naming it. Files with findings come first (most severe first), then those a
 * repair touched, then the rest, each group in the result's order.
 */
export function fileRows(first: WorkerResult | null, latest: WorkerResult, findings: readonly ReviewFinding[] | null, repair: string): FileRow[] {
  const base = first ?? latest
  const marks = repairMarks(first, latest, repair)
  const paths = listedPaths(base)
  for (const path of listedPaths(latest)) if (!paths.includes(path)) paths.push(path)
  const latestFiles = captures(latest)
  const baseFiles = captures(base)
  const why = new Map([...reasons(base), ...reasons(latest)])
  const recorded = baseFiles.size > 0 || base.files_not_captured !== undefined
  const rows = paths.map((path): FileRow => {
    const file = latestFiles.get(path) ?? baseFiles.get(path) ?? null
    const reason = file ? null : why.get(path) ?? null
    const named = findings === null ? [] : findingsForFile(findings, path)
    const worst = named.reduce<ReviewFinding['severity'] | null>((found, entry) => (found === null || SEVERITY_RANK[entry.severity] < SEVERITY_RANK[found] ? entry.severity : found), null)
    return {
      path, file, reason,
      state: file ? 'captured' : reason ? 'not-captured' : recorded ? 'unlisted' : 'not-recorded',
      findings: named,
      severity: worst,
      repair: marks.get(path) ?? null,
      markdown: /\.md$/i.test(path),
    }
  })
  const group = (row: FileRow) => (row.severity !== null ? SEVERITY_RANK[row.severity] : row.repair ? 3 : 4)
  return rows.map((row, index) => ({ row, index })).sort((a, b) => group(a.row) - group(b.row) || a.index - b.index).map(entry => entry.row)
}

export function filterRows(rows: readonly FileRow[], filter: FileFilter): FileRow[] {
  if (filter === 'findings') return rows.filter(row => row.findings.length > 0)
  if (filter === 'repair') return rows.filter(row => row.repair !== null)
  return [...rows]
}

/** The directory part of a path with its trailing slash; empty at the repository root. */
export function folderOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash + 1)
}

/** When the result's summary extends the worker's report, only the added text is shown, as the verifier's note (4.5). */
export function reportDelta(reported: string, recorded: string | null): ReportDelta {
  if (recorded === null || recorded.trim() === reported.trim()) return { kind: 'same' }
  if (recorded.startsWith(reported)) return { kind: 'extends', note: recorded.slice(reported.length).trim() }
  return { kind: 'differs', summary: recorded }
}

export function waitingQuestions(worker: RunInputWorker | null): number {
  return worker === null ? 0 : worker.questions.filter(question => question.answer === null).length
}

/** The index entries of a launch node's sections, in page order; empty ones are absent. */
export function launchSectionEntries(worker: RunInputWorker | null, result: WorkerResult | null): SectionEntry[] {
  const files = result === null ? 0 : filesCount(result)
  return [
    ...(waitingQuestions(worker) > 0 ? [{ key: 'questions', label: 'Questions', count: worker!.questions.length }] : []),
    ...(worker !== null || result !== null ? [{ key: 'report', label: 'Report' }] : []),
    ...(files > 0 ? [{ key: 'files', label: 'Files', count: files }] : []),
    ...(worker !== null ? [{ key: 'task', label: 'Task' }, { key: 'session', label: 'Session' }] : []),
  ]
}

/**
 * The two ways to answer a waiting question (4.5; guardrails.py:996-1001, RUNBOOK:56), worded as the Now banner words them:
 * inside Herdr the answer is typed into the lane's pane; from any other shell `--no-herdr` records it and prints the session
 * to type it into.
 */
export function answerNext(lane: string): NextStep {
  const answer = `"$PY" -m workflow answer "$RUN" ${lane} "<your answer>"`
  return {
    action: 'required', label: `Answer ${lane}'s question`, runbook: [{ section: 'Guardrails (feature.json 2.2.0)', topic: 'Worker questions' }],
    steps: [
      { kind: 'command', text: answer, caption: 'Inside Herdr, with the lane\'s pane showing its session:' },
      { kind: 'command', text: `${answer} --no-herdr`, caption: 'From any other shell: record it, then type it into the session it prints:' },
    ],
    caveat: 'Outside Herdr the first form records the answer and restarts the deadline, then exits 1: the worker has not received it.',
  }
}

