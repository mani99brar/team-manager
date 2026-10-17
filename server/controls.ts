import { createHash } from 'node:crypto'
import fs, { type FileHandle } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import {
  CONTROLS_VERSION, CONTROL_IDS, cleanPreviewRequestSchema, cleanPreviewResponseSchema, controlRequestSchema, controlResponseSchema, controlsStatusSchema,
  relaunchPreviewRequestSchema, relaunchPreviewResponseSchema, runControlsSchema, type Control, type ControlId, type ControlRecord, type Params, type ParamSpec, type RunControls,
} from '../contracts/projects/controls.ts'
import {
  GITHUB_ACTIONS_VERSION, GITHUB_ACTION_IDS, githubActionRequestSchema, githubActionResponseSchema, runGithubActionsSchema, runGithubSchema, type GithubActionId,
  type GithubActionRecord, type GithubParams, type RunGithub, type RunGithubActions,
} from '../contracts/projects/github.ts'
import type { Teams } from '../contracts/projects/teams.ts'
import {
  CONTROLS_PREFIX, ControlsError, isPaired, requireBrowserGuards, requireToken, type ControlsConfig, type ControlsSetup,
} from './controlsGuard.ts'
import {
  RecordStore, Runner, holderIsSupervisorOf, newRecordId, probeLock, publicRecord, readHolder, readLogTail, redactLine, redactText, runKeyOf, systemdRunArgv, tailLines, unitName, userHome,
  type Holder, type LockProbe, type RunKey, type RunnerOptions, type StoredRecord,
} from './controlsRunner.ts'
import { DIRECTORY_FLAGS, at } from './files.ts'
import {
  GITHUB_ACTION_TIMEOUT_MS, GITHUB_EXIT_UNKNOWN, GITHUB_READ_FAILED, GITHUB_READ_MISSING, GITHUB_UNKNOWN_NOTE, GithubRecordStore, githubActionsOf, githubArgv, githubDisplay, githubStateToken, newGithubRecordId, reviewerSuggestions, shownPath,
  summaryDefaults, urlOf, validateGithubParams, type GithubSource, type StoredGithubRecord,
} from './githubActions.ts'
import { ProjectApiError, type LoadedRun, type RunStore } from './projects.ts'
import { ID_PATTERN } from './projectsConfig.ts'

/**
 * The run-control API (docs/PRD_RUN_CONTROLS.md sections 3 to 5 and Appendix A, decisions.md [L1] to [L5]): fifteen controls from a
 * closed table, the offer rules that hide what the controller would refuse, and a POST that runs exactly one existing
 * `python -m workflow ...` command as the operator. The controller stays the judge: nothing here edits a run file, writes a marker or
 * retries a refusal. Errors are `{ error: { code, message } }`, never a path or the token.
 *
 * The fifteenth control, `note` (docs/PRD_RUN_TEAMS.md "Steering"), types a note into a lane's lead session through `workflow note`.
 * The run's GitHub actions (docs/PRD_RUN_TEAMS.md "GitHub actions"; `githubActions.ts`) are a second family in this scope,
 * `GET/POST .../:run_id/github[/:action_id]`: they share the guards, the pairing token, the runner and the one-in-flight-per-run rule.
 */
const BYTE_LIMIT = 16 * 1024 * 1024
const SMALL_LIMIT = 1024 * 1024
const MAX_RECEIPTS = 40

export type ControlsRouteOptions = {
  store: RunStore
  setup: ControlsSetup
  runner?: RunnerOptions
  now?: () => Date
  /** The run's GitHub read (the GitHub-read lane's `RunGithub`) and its "read this branch again" hook; absent, every GitHub action is unavailable. */
  github?: GithubSource
  /** Whether the GitHub actions are on; defaults to `MD_MANAGER_GITHUB_ACTIONS=on` in the server's environment. */
  githubActions?: boolean
  /** The bound on one GitHub action's child; `GITHUB_ACTION_TIMEOUT_MS` (above the controller's worst case) unless a test lowers it. */
  githubTimeoutMs?: number
}

type ErrorBody = { error: { code: string; message: string } }

function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } }
}

function send(reply: FastifyReply, status: number, body: unknown) {
  return reply.code(status).header('Cache-Control', 'no-store').send(body)
}

function requireId(value: unknown, what: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new ControlsError(400, 'INVALID_ID', `The ${what} ID must be 1-128 characters of letters, digits, ".", "_" or "-", starting with a letter or digit.`)
  }
  return value
}

function conform<T>(schema: z.ZodType<T>, payload: unknown, log: FastifyInstance['log']): T {
  const result = schema.safeParse(payload)
  if (!result.success) {
    log.error({ issues: result.error.issues.slice(0, 5).map(issue => `${issue.path.join('.')}: ${issue.message}`) }, 'Run control payload violates the contract')
    throw new ControlsError(500, 'INTERNAL', 'The run control payload could not be produced.')
  }
  return result.data
}

// ---- The closed table ---------------------------------------------------------------------------------------------------

type Spec = {
  id: ControlId
  label: string
  runs: 'short' | 'long' | 'signal'
  confirm: 'plain' | 'typed_run_id'
  effect: string
  not_effect: string | null
  /** The redacted display command, with `$PY` and `$RUN`; parameters show as placeholders until given. */
  display: (params: Params, facts: Facts | null) => string
  /** The argv after the Python executable (`-m workflow ...`). */
  argv: (runDir: string, params: Params, facts: Facts) => string[]
}

const BY = ['--by', 'operator']
const W = ['-m', 'workflow']
const quoted = (value: string | undefined, placeholder: string) => (value === undefined ? placeholder : JSON.stringify(value))

const SPECS: Spec[] = [
  {
    id: 'restart', label: 'Restart supervisor', runs: 'long', confirm: 'plain',
    effect: 'Starts the automatic supervisor again from the run\'s checkpoint; it may start model sessions.',
    not_effect: 'It relaunches nothing the controller has a receipt for.',
    display: () => '$PY -m workflow automatic "$RUN" --live --by operator',
    argv: runDir => [...W, 'automatic', runDir, '--live', ...BY],
  },
  {
    id: 'pause', label: 'Pause supervisor (workers keep running)', runs: 'signal', confirm: 'plain',
    effect: 'Sends Ctrl-C (SIGINT) to the supervisor\'s process group, as in its terminal; the controller records the interruption and keeps the sessions.',
    not_effect: 'It does not stop the workers or reviewers: their sessions keep running and a later restart waits for them again. To stop everything, abandon the run.',
    display: () => 'SIGINT to the supervisor\'s process group',
    argv: () => [],
  },
  {
    id: 'retry', label: 'Retry a check', runs: 'short', confirm: 'plain',
    effect: 'Raises the attempt of a lane\'s failed or interrupted check and reruns it.',
    not_effect: 'On an automatic run it prints the restart command instead of continuing; restart the supervisor next.',
    display: params => `$PY -m workflow retry "$RUN" --phase ${params.phase ?? '<phase>'} --node ${params.lane ?? '<lane>'} --by operator`,
    argv: (runDir, params) => [...W, 'retry', runDir, '--phase', params.phase!, '--node', params.lane!, ...BY],
  },
  {
    id: 'reconcile', label: 'Reconcile launches', runs: 'short', confirm: 'plain',
    effect: 'Binds the sessions the launch receipts name; inspect the receipts and `claude agents --json` first (RUNBOOK, Ambiguous startup).',
    not_effect: 'It launches nothing new.',
    display: () => '$PY -m workflow reconcile "$RUN" --by operator',
    argv: runDir => [...W, 'reconcile', runDir, ...BY],
  },
  {
    id: 'resume', label: 'Rerun the design challenge', runs: 'long', confirm: 'plain',
    effect: 'Reruns the design challenge for the run; it starts a model session.',
    not_effect: 'It does not edit the task or decisions files: edits stay in your terminal.',
    display: () => '$PY -m workflow resume "$RUN" --by operator',
    argv: runDir => [...W, 'resume', runDir, ...BY],
  },
  {
    id: 'accept_challenge', label: 'Accept the challenge', runs: 'long', confirm: 'plain',
    effect: 'Accepts the paused design challenge with your reason and launches the workers.',
    not_effect: 'It does not resolve the challenge\'s concerns; the reason is recorded.',
    display: params => `$PY -m workflow resume "$RUN" --accept-challenge=${quoted(params.reason, '"<reason>"')} --by operator`,
    argv: (runDir, params) => [...W, 'resume', runDir, `--accept-challenge=${params.reason!}`, ...BY],
  },
  {
    id: 'release_hold', label: 'Launch the workers', runs: 'long', confirm: 'plain',
    effect: 'Releases the held design challenge and launches the workers, leaving out the notes you drop.',
    not_effect: 'It does not change the challenge\'s record; dropped notes are only left out of the workers\' prompts.',
    display: params => `$PY -m workflow resume "$RUN" --launch${params.drop?.length ? ` --drop ${params.drop.join(',')}` : ''} --by operator`,
    argv: (runDir, params) => [...W, 'resume', runDir, '--launch', ...(params.drop?.length ? ['--drop', params.drop.join(',')] : []), ...BY],
  },
  {
    id: 'answer', label: 'Answer the question', runs: 'short', confirm: 'plain',
    effect: 'Records your answer to the lane\'s question and types it into the lane\'s Herdr pane.',
    not_effect: 'It does not restart the supervisor.',
    display: params => `$PY -m workflow answer "$RUN" ${params.lane ?? '<lane>'} --by operator -- ${quoted(params.text, '"<text>"')}`,
    argv: (runDir, params) => [...W, 'answer', runDir, params.lane!, ...BY, '--', params.text!],
  },
  {
    id: 'approve', label: 'Approve and integrate', runs: 'short', confirm: 'typed_run_id',
    effect: 'Approves the reviewed bundle and integrates it into the source branch.',
    not_effect: 'It approves only the bundle shown by its first 12 characters; a different bundle is refused.',
    display: (_params, facts) => `$PY -m workflow approve "$RUN" --bundle-sha256 ${facts?.digest ? `${facts.digest.slice(0, 12)}…` : '<digest>'} --by operator`,
    argv: (runDir, _params, facts) => [...W, 'approve', runDir, '--bundle-sha256', facts.digest!, ...BY],
  },
  {
    id: 'repair_session', label: 'Repair a lane', runs: 'long', confirm: 'typed_run_id',
    effect: 'Starts one model session that repairs the lane that blocked at a check after freeze, then applies its fix.',
    not_effect: 'It does not continue the run: restart the supervisor afterwards.',
    display: params => `$PY -m workflow repair "$RUN" ${params.lane ?? '<lane>'} --session --live --by operator`,
    argv: (runDir, params) => [...W, 'repair', runDir, params.lane!, '--session', '--live', ...BY],
  },
  {
    id: 'abandon', label: 'Abandon the run', runs: 'short', confirm: 'typed_run_id',
    effect: 'Stops every recorded session of the run and closes it for good.',
    not_effect: 'Worktrees and evidence stay until the run is cleaned.',
    display: params => `$PY -m workflow abandon "$RUN" --reason=${quoted(params.reason, '"<reason>"')} --by operator`,
    argv: (runDir, params) => [...W, 'abandon', runDir, `--reason=${params.reason!}`, ...BY],
  },
  {
    id: 'clean', label: 'Clean worktrees', runs: 'short', confirm: 'typed_run_id',
    effect: 'Removes the run\'s worktrees (and its source checkout once finished); a dry run shows what first.',
    not_effect: 'Evidence, packets, logs and every run file stay.',
    display: () => '$PY -m workflow clean "$RUN" --by operator',
    argv: runDir => [...W, 'clean', runDir, ...BY],
  },
  {
    id: 'retry_all', label: 'Retry all failed checks', runs: 'short', confirm: 'plain',
    effect: 'Raises the attempt of every lane whose worker check failed or was left without a verdict, in one command; Restart supervisor then reruns them.',
    not_effect: 'It runs no check itself and never retries a combined (candidate) check.',
    display: () => '$PY -m workflow retry "$RUN" --phase worker --all-failed --by operator',
    argv: runDir => [...W, 'retry', runDir, '--phase', 'worker', '--all-failed', ...BY],
  },
  {
    id: 'relaunch', label: 'Relaunch a lane', runs: 'short', confirm: 'plain',
    effect: 'Relaunches the lane\'s worker session once, after its dry run shows the controller allows it; continue with Reconcile launches and then Restart supervisor.',
    not_effect: 'It reconciles and restarts nothing itself, and relaunches a lane at most once.',
    display: params => `$PY -m workflow relaunch "$RUN" ${params.lane ?? '<lane>'} --by operator`,
    argv: (runDir, params) => [...W, 'relaunch', runDir, params.lane!, ...BY],
  },
  {
    id: 'note', label: 'Send a note to the lead', runs: 'short', confirm: 'plain',
    effect: 'Types your note into the lane\'s lead session pane as an operator note and records it in the lane\'s notes.',
    not_effect: 'A running team workflow takes no input: its agents never see the note, and the lead reads it when its current turn ends. It stops and restarts nothing.',
    display: params => `$PY -m workflow note "$RUN" ${params.lane ?? '<lane>'} --by operator -- ${quoted(params.text, '"<text>"')}`,
    argv: (runDir, params) => [...W, 'note', runDir, params.lane!, ...BY, '--', params.text!],
  },
]

/** The relaunch dry run's argv: the confirmed command with `--dry-run` before the actor. */
const relaunchDryRun = (runDir: string, lane: string) => [...W, 'relaunch', runDir, lane, '--dry-run', ...BY]

/** Whether the controller at MD_MANAGER_WORKFLOW_HOME has the two commands, read once when the routes start. */
export type Capabilities = { retryAll: boolean; relaunch: boolean }
export const RETRY_ALL_ABSENT = 'This controller has no `retry --all-failed` (workflow-collected-fixes is not merged)'
export const RELAUNCH_ABSENT = 'This controller has no `relaunch` command (workflow-collected-fixes is not merged)'

/**
 * Reads `-m workflow retry --help` and `-m workflow relaunch --help` once, through the run-control runner (its home, env and
 * timeout). A non-zero exit, a failed spawn, or a retry help that never names `--all-failed` reads as absent: fail closed.
 */
export async function readCapabilities(runner: Runner, python: string): Promise<Capabilities> {
  const has = async (args: string[], needle: RegExp) => {
    try {
      const result = await runner.capture(python, args)
      return result.exitCode === 0 && needle.test(result.output)
    } catch {
      return false
    }
  }
  const [retryAll, relaunch] = await Promise.all([has([...W, 'retry', '--help'], /--all-failed\b/), has([...W, 'relaunch', '--help'], /relaunch/)])
  return { retryAll, relaunch }
}

const SPEC_BY_ID = new Map(SPECS.map(spec => [spec.id, spec]))
if (SPECS.map(spec => spec.id).join() !== CONTROL_IDS.join()) throw new Error('The control table must follow the order of PRD section 4')

export const ANSWER_PANE_REASON = 'Typing the answer needs the lane\'s Herdr pane; answer in your terminal'
export const NOTE_PANE_REASON = 'Typing a note needs the lane\'s Herdr pane; send it in your terminal'

const TEXT_LIMITS = { text: { min: 1, max: 4000 }, note: { min: 1, max: 4000 }, accept: { min: 10, max: 500 }, abandon: { min: 1, max: 500 } } as const

// ---- Reading the run ----------------------------------------------------------------------------------------------------

async function readSmall(directory: FileHandle, name: string, limit = SMALL_LIMIT): Promise<Buffer | null> {
  let file: FileHandle
  try {
    file = await fs.open(at(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return null
  }
  try {
    if (!(await file.stat()).isFile()) return null
    const buffer = Buffer.allocUnsafe(limit + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return offset > limit ? null : buffer.subarray(0, offset)
  } catch {
    return null
  } finally {
    await file.close()
  }
}

async function readJson(directory: FileHandle, name: string, limit = SMALL_LIMIT): Promise<unknown> {
  const bytes = await readSmall(directory, name, limit)
  if (bytes === null) return undefined
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    return undefined
  }
}

async function exists(directory: FileHandle, name: string): Promise<boolean> {
  try {
    await fs.lstat(at(directory, name))
    return true
  } catch {
    return false
  }
}

function sha(value: Buffer | string | null): string {
  return value === null ? '-' : createHash('sha256').update(value).digest('hex')
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

type RetryTarget = { phase: 'worker' | 'candidate'; lane: string }

type Facts = {
  runId: string
  runDir: string
  status: string
  automatic: boolean
  abandoned: boolean
  finished: boolean
  lanes: string[]
  supervisor: LockProbe
  controller: LockProbe
  /** The holder of the supervisor lock when held. */
  holder: Holder | null
  holderMatches: boolean
  since: string | null
  challenge: { status: string; held: boolean; concerns: number; rerunning: boolean } | null
  retryTargets: RetryTarget[]
  /** The lanes a relaunch may be offered for: `launch_<lane>` in next, the receipt absent or needing reconciliation, no completion, handoff or stop file. */
  relaunchLanes: string[]
  capabilities: Capabilities
  reconcile: boolean
  repairRecorded: boolean
  repairLanes: string[]
  waiting: string[]
  panes: Set<string>
  digest: string | null
  longReason: string | null
  token: string
  /** What the note control's offer reads (workflow/sidecar.py `refusal`): launched lanes that have not gone on, frozen, accepted. */
  notes: { working: string[]; frozen: boolean; accepted: boolean }
  /** The loaded run (for the GitHub actions' default pull request title and body) and the project's registered repository. */
  loaded: LoadedRun
  repository: string
}

/** The lane list a run launched: `plan.json` workers, else the projected inputs, else none. */
function lanesOf(plan: unknown, loaded: LoadedRun): string[] {
  const workers = isRecord(plan) && Array.isArray(plan.workers) ? plan.workers : loaded.inputs?.selected_workers
  return (workers ?? []).filter((lane): lane is string => typeof lane === 'string' && ID_PATTERN.test(lane))
}

/** `pipeline.awaiting_approval` (workflow/pipeline.py:1109): finish "approval" and exactly one `integration_approval` interrupt with a digest. */
function approvalDigest(plan: unknown, state: unknown): string | null {
  const automatic = isRecord(plan) ? plan.automatic : null
  if (!isRecord(automatic) || automatic.finish !== 'approval' || !isRecord(state) || !Array.isArray(state.tasks)) return null
  const gates = state.tasks.flatMap(task => (isRecord(task) && Array.isArray(task.interrupts) ? task.interrupts.filter(isRecord) : []))
  if (gates.length !== 1 || gates[0].kind !== 'integration_approval') return null
  const digest = gates[0].bundle_sha256
  return typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest) ? digest : null
}

async function laneQuestions(directory: FileHandle, lane: string, loaded: LoadedRun): Promise<{ waiting: boolean; hash: string }> {
  const bytes = await readSmall(directory, `${lane}.questions.json`)
  let questions: unknown
  if (bytes !== null) {
    try { questions = (JSON.parse(bytes.toString('utf8')) as { questions?: unknown }).questions } catch { questions = undefined }
  }
  if (!Array.isArray(questions)) {
    const worker = loaded.inputs?.workers.find(candidate => candidate.node_id === lane)
    questions = worker && !worker.stop?.stopped ? worker.questions : []
  }
  const list = (questions as unknown[]).filter(isRecord)
  const last = list.at(-1)
  return { waiting: last !== undefined && (last.answer === null || last.answer === undefined), hash: sha(bytes) }
}

async function receiptsNeedReconciling(directory: FileHandle): Promise<boolean> {
  const names = (await fs.readdir(at(directory)).catch(() => [] as string[])).filter(name => /\.interactive\.json$|^automatic-review[^/]*\.json$/.test(name)).slice(0, MAX_RECEIPTS)
  for (const name of names) {
    const receipt = await readJson(directory, name)
    if (isRecord(receipt) && receipt.status === 'needs_reconciliation') return true
  }
  return false
}

/** Everything the offer rules read, from the run's files (bounded, no-follow) and the lock probe. */
async function readFacts(store: RunStore, key: RunKey, config: ControlsConfig, runner: Runner, capabilities: Promise<Capabilities>): Promise<Facts> {
  let scope
  try {
    await store.sync()
    scope = store.scope(key.project, key.workflow)
  } catch (error) {
    if (error instanceof ProjectApiError) throw new ControlsError(404, 'NOT_FOUND', 'No such project, workflow or run is registered.')
    throw error
  }
  let root: FileHandle
  try {
    root = await fs.open(scope.workflow.runs_root, DIRECTORY_FLAGS)
  } catch {
    throw new ControlsError(404, 'NOT_FOUND', 'No such run is registered.')
  }
  try {
    let directory: FileHandle
    try {
      directory = await fs.open(at(root, key.run), DIRECTORY_FLAGS)
    } catch {
      throw new ControlsError(404, 'NOT_FOUND', 'No such run is registered.')
    }
    try {
      let loaded: LoadedRun
      try {
        loaded = await store.loadRun(scope, key.run)
      } catch (error) {
        if (error instanceof ProjectApiError && error.status === 404) throw new ControlsError(404, 'NOT_FOUND', 'No such run is registered.')
        if (error instanceof ProjectApiError) throw new ControlsError(500, 'INTERNAL', 'The run could not be read.')
        throw error
      }
      const runDir = join(scope.workflow.runs_root, key.run)
      const [plan, state, attention, abandonFile, rerunning] = await Promise.all([
        readJson(directory, 'plan.json', BYTE_LIMIT), readJson(directory, 'run-state.json', BYTE_LIMIT), readSmall(directory, 'attention.json'),
        exists(directory, 'abandon.json'), exists(directory, 'challenge.running.json'),
      ])
      const snapshot = loaded.detail.snapshot
      const status = snapshot.status
      const nodeStatus = new Map(snapshot.nodes.map(node => [node.node_id, node.status]))
      const lanes = lanesOf(plan, loaded)
      const automatic = (isRecord(plan) && isRecord(plan.automatic)) || loaded.inputs?.mode === 'automatic'
      const abandoned = abandonFile || status === 'cancelled'
      const finished = status === 'succeeded' || status === 'cancelled'

      const questions = await Promise.all(lanes.map(async lane => [lane, await laneQuestions(directory, lane, loaded)] as const))
      const waiting = questions.filter(([, entry]) => entry.waiting).map(([lane]) => lane)
      let panes = new Set<string>()
      if (config.herdr) {
        const terminals = await readJson(directory, 'terminals.json')
        if (isRecord(terminals)) panes = new Set(Object.entries(terminals).filter(([, entry]) => isRecord(entry) && typeof entry.pane_id === 'string' && entry.pane_id.length > 0).map(([lane]) => lane))
      }

      const retryTargets: RetryTarget[] = []
      const bad = (value: string | undefined) => value === 'failed' || value === 'paused'
      for (const lane of lanes) if (bad(nodeStatus.get(`verify_${lane}`))) retryTargets.push({ phase: 'worker', lane })
      if (bad(nodeStatus.get('candidate'))) for (const lane of lanes) retryTargets.push({ phase: 'candidate', lane })
      // A lane blocked at a check verdict after freeze, before any review (triage.ts identicalLanes: no review record, review pending).
      const frozen = nodeStatus.get('handoff') === 'succeeded' && !loaded.review && nodeStatus.get('review') === 'pending'
      const repairLanes = !frozen ? [] : [...new Set(retryTargets.filter(target => nodeStatus.get(target.phase === 'worker' ? `verify_${target.lane}` : 'candidate') === 'failed').map(target => target.lane))]

      const next = isRecord(state) && Array.isArray(state.next) ? state.next : []
      const reconcileEvent = loaded.events.slice(-20).some(event => /\bworkflow reconcile\b/.test(event.message))
      const reconcile = next.some(name => typeof name === 'string' && name.startsWith('launch_')) || reconcileEvent || await receiptsNeedReconciling(directory)

      // Cheap facts only, a superset of the controller's rule: its dry run decides for the lane chosen.
      const relaunchLanes: string[] = []
      for (const lane of lanes) {
        if (!next.includes(`launch_${lane}`)) continue
        const receipt = await readJson(directory, `${lane}.interactive.json`)
        if (receipt !== undefined && !(isRecord(receipt) && receipt.status === 'needs_reconciliation')) continue
        const finished = await Promise.all(['completion', 'handoff', 'stop'].map(kind => exists(directory, `${lane}.${kind}.json`)))
        if (!finished.some(Boolean)) relaunchLanes.push(lane)
      }

      const challenge = loaded.inputs?.challenge ?? null
      const held = challenge !== null && challenge.status === 'passed' && challenge.hold != null && challenge.hold.released_at === null
      const challengeFacts = challenge === null ? null : { status: challenge.status, held, concerns: challenge.concerns.length, rerunning: rerunning }

      const supervisor = await probeLock(config.procRoot, join(runDir, 'automatic-supervisor.lock'))
      const controller = await probeLock(config.procRoot, join(runDir, 'controller.lock'))
      const holderPid = supervisor.state === 'held' ? supervisor.pid : controller.state === 'held' ? controller.pid : null
      const holder = holderPid === null ? null : await readHolder(config.procRoot, holderPid)
      const holderMatches = supervisor.state === 'held' && holder !== null && holder.pgrp !== null && await holderIsSupervisorOf(holder, runDir)
      const longAvailability = await runner.longAvailable()

      // The note's gate, as workflow/sidecar.py `refusal` reads it: frozen (snapshots, or a closed sidecar ledger), launched, not gone on.
      const ledger = await readJson(directory, 'sidecar.ledger.json', BYTE_LIMIT)
      const notesFrozen = await exists(directory, 'snapshots.json') || (isRecord(ledger) && ledger.closed_at !== null && ledger.closed_at !== undefined)
      const working: string[] = []
      for (const lane of lanes) {
        if (!(await exists(directory, `${lane}.interactive.json`))) continue
        const wentOn = await Promise.all(['stop', 'handoff', 'completion'].map(kind => exists(directory, `${lane}.${kind}.json`)))
        if (!wentOn.some(Boolean)) working.push(lane)
      }
      const accepted = Boolean(loaded.detail.summary.accepted) || await exists(directory, 'accepted.json')

      const repairRecorded = (loaded.fixLoop?.repairs ?? []).some(repair => repair.status === 'recorded')
      const token = createHash('sha256').update(JSON.stringify([
        loaded.detail.summary.updated_at, snapshot.last_sequence, status, sha(attention), questions.map(([lane, entry]) => [lane, entry.hash]), abandoned,
        supervisor.state, controller.state, holder?.since ?? null, rerunning,
      ])).digest('hex')
      return {
        runId: key.run, runDir, status, automatic, abandoned, finished, lanes, supervisor, controller, holder, holderMatches, since: holder?.since ?? null,
        challenge: challengeFacts, retryTargets, relaunchLanes, capabilities: await capabilities, reconcile, repairRecorded, repairLanes, waiting, panes, digest: approvalDigest(plan, state),
        longReason: longAvailability.ok ? null : longAvailability.reason, token, notes: { working, frozen: notesFrozen, accepted }, loaded, repository: scope.project.repository,
      }
    } finally {
      await directory.close()
    }
  } finally {
    await root.close()
  }
}

// ---- The offer rules (PRD section 4) -----------------------------------------------------------------------------------

type Offer = { available: boolean; reason: string | null; params: ParamSpec[] }

const uniq = <T>(items: T[]): T[] => [...new Set(items)]
const textSpec = (name: 'text' | 'reason', min: number, max: number): ParamSpec => ({ name, kind: 'text', min_length: min, max_length: max, required: true })
const typedSpec: ParamSpec = { name: 'confirm_run_id', kind: 'typed', required: true }

function sinceText(since: string | null): string {
  return since ? ` (since ${since.slice(11, 16)} UTC)` : ''
}

/** The lock reason, checked first for every control whose rule says "no supervisor/controller running". */
function liveReason(facts: Facts): string | null {
  if (facts.supervisor.state === 'held') return `A supervisor is running${sinceText(facts.since)}`
  if (facts.controller.state === 'held') return `A controller is running${sinceText(facts.since)}`
  return null
}

function offerOf(spec: Spec, facts: Facts): Offer {
  const no = (reason: string, params: ParamSpec[] = []): Offer => ({ available: false, reason, params })
  const yes = (params: ParamSpec[] = []): Offer => ({ available: true, reason: null, params })
  const live = liveReason(facts)
  const needsQuiet = (rest: () => Offer, params: ParamSpec[] = []): Offer => (live !== null ? no(live, params) : rest())
  const lanes = (choices: string[]): ParamSpec => ({ name: 'lane', kind: 'choice', choices, required: true })
  const longBlocked = spec.runs === 'long' ? facts.longReason : null
  const withLong = (offer: Offer): Offer => (offer.available && longBlocked !== null ? no(longBlocked, offer.params) : offer)
  switch (spec.id) {
    case 'restart':
      return withLong(needsQuiet(() => {
        if (!facts.automatic) return no('Only an automatic run has a supervisor')
        if (facts.abandoned) return no('The run was abandoned')
        if (facts.finished) return no('The run is finished')
        if (facts.repairRecorded) return no('A repair is recorded and not yet applied; rerun that repair in your terminal first')
        return yes()
      }))
    case 'pause': {
      if (facts.supervisor.state === 'unknown') return no('The lock probe is unavailable on this host (no /proc/locks)')
      if (facts.supervisor.state !== 'held') return no('No supervisor is running')
      if (!facts.holderMatches) return no('The lock holder is not a supervisor of this run (its command line does not name this run); pause it in its terminal')
      return yes()
    }
    case 'retry': {
      const params: ParamSpec[] = [lanes(uniq(facts.retryTargets.map(target => target.lane))), { name: 'phase', kind: 'choice', choices: uniq(facts.retryTargets.map(target => target.phase)), required: true }]
      return needsQuiet(() => {
        if (facts.abandoned) return no('The run was abandoned', params)
        if (facts.finished) return no('The run is finished', params)
        return facts.retryTargets.length === 0 ? no('No check failed or was interrupted without a verdict', params) : yes(params)
      }, params)
    }
    case 'reconcile':
      return needsQuiet(() => {
        if (facts.abandoned) return no('The run was abandoned')
        return facts.reconcile ? yes() : no('No launch needs reconciling')
      })
    case 'resume': {
      return withLong(needsQuiet(() => {
        if (facts.abandoned) return no('The run was abandoned')
        const challenge = facts.challenge
        return challenge !== null && (challenge.status === 'paused' || challenge.held || challenge.rerunning) ? yes() : no('The design challenge is not paused, held or interrupted')
      }))
    }
    case 'accept_challenge': {
      const params = [textSpec('reason', TEXT_LIMITS.accept.min, TEXT_LIMITS.accept.max)]
      return withLong(needsQuiet(() => {
        if (facts.abandoned) return no('The run was abandoned', params)
        return facts.challenge?.status === 'paused' ? yes(params) : no('The latest design challenge is not paused', params)
      }, params))
    }
    case 'release_hold': {
      const params: ParamSpec[] = [{ name: 'drop', kind: 'multi', choices: Array.from({ length: facts.challenge?.held ? facts.challenge.concerns : 0 }, (_, index) => index + 1), required: false }]
      return withLong(needsQuiet(() => {
        if (facts.abandoned) return no('The run was abandoned', params)
        return facts.challenge?.held ? yes(params) : no('The design challenge is not held', params)
      }, params))
    }
    case 'answer': {
      const choices = facts.waiting.filter(lane => facts.panes.has(lane))
      const params = [lanes(choices), textSpec('text', TEXT_LIMITS.text.min, TEXT_LIMITS.text.max)]
      if (facts.waiting.length === 0) return no('No lane has an unanswered question', params)
      if (choices.length === 0) return no(ANSWER_PANE_REASON, params)
      return yes(params)
    }
    case 'approve':
      if (facts.status !== 'awaiting_approval') return no('The run is not waiting for your approval', [typedSpec])
      return facts.digest === null ? no('No reviewed bundle digest is recorded for this approval', [typedSpec]) : yes([typedSpec])
    case 'repair_session': {
      const params = [lanes(facts.repairLanes), typedSpec]
      return withLong(needsQuiet(() => {
        if (!facts.automatic) return no('Only an automatic run can repair a lane in a session', params)
        if (facts.abandoned) return no('The run was abandoned', params)
        return facts.repairLanes.length === 0 ? no('The run is not blocked at a check verdict after freeze, before review', params) : yes(params)
      }, params))
    }
    case 'abandon': {
      const params = [textSpec('reason', TEXT_LIMITS.abandon.min, TEXT_LIMITS.abandon.max), typedSpec]
      return needsQuiet(() => {
        if (facts.abandoned) return no('The run was abandoned', params)
        if (facts.status === 'succeeded') return no('The run is already integrated', params)
        return yes(params)
      }, params)
    }
    case 'clean':
      return needsQuiet(() => (facts.finished || facts.abandoned ? yes([typedSpec]) : no('The run is not finished or abandoned', [typedSpec])), [typedSpec])
    case 'retry_all': {
      if (!facts.capabilities.retryAll) return no(RETRY_ALL_ABSENT)
      return needsQuiet(() => {
        if (facts.abandoned) return no('The run was abandoned')
        if (facts.finished) return no('The run is finished')
        const workerLanes = uniq(facts.retryTargets.filter(target => target.phase === 'worker').map(target => target.lane))
        return workerLanes.length >= 2 ? yes() : no('Fewer than two worker checks failed')
      })
    }
    case 'relaunch': {
      const params = [lanes(facts.relaunchLanes)]
      if (!facts.capabilities.relaunch) return no(RELAUNCH_ABSENT, params)
      return needsQuiet(() => (facts.relaunchLanes.length > 0 ? yes(params) : no('No lane launch is waiting to be relaunched', params)), params)
    }
    case 'note': {
      // workflow note's own refusals the server can see; it needs no quiet run (a note reaches a lead while the supervisor runs).
      const open = facts.notes.working.filter(lane => !facts.waiting.includes(lane))
      const choices = open.filter(lane => facts.panes.has(lane))
      const params = [lanes(choices), textSpec('text', TEXT_LIMITS.note.min, TEXT_LIMITS.note.max)]
      if (facts.abandoned) return no('The run was abandoned', params)
      if (facts.notes.accepted) return no('The run was accepted by the operator', params)
      if (facts.notes.frozen) return no('The workers are frozen: a note reaches a lead only before freeze', params)
      if (facts.notes.working.length === 0) return no('No lane\'s worker is launched and still working', params)
      if (open.length === 0) return no('Every working lane waits on a question; answer it instead', params)
      if (choices.length === 0) return no(NOTE_PANE_REASON, params)
      return yes(params)
    }
  }
}

function controlsOf(facts: Facts): { controls: Control[]; offers: Map<ControlId, Offer> } {
  const offers = new Map<ControlId, Offer>()
  const controls = SPECS.map((spec): Control => {
    const offer = offerOf(spec, facts)
    offers.set(spec.id, offer)
    return {
      id: spec.id, label: spec.label, available: offer.available, reason: offer.reason, recommended: false, command: spec.display({}, facts), runs: spec.runs,
      confirm: spec.confirm, params: offer.params, effect: spec.effect, not_effect: spec.not_effect,
    }
  })
  return { controls, offers }
}

// ---- Parameters (PRD 5.2 item 8) ----------------------------------------------------------------------------------------

function invalid(message: string): never {
  throw new ControlsError(400, 'INVALID_PARAMS', message)
}

/** Validates `params` against the control's offered spec: only its parameters, each within its choices and lengths. */
function validateParams(offer: Offer, params: Params, runId: string): Params {
  const names = new Set<string>(offer.params.map(param => param.name))
  for (const key of Object.keys(params)) if (!names.has(key)) invalid(`The parameter "${key}" does not belong to this control.`)
  const clean: Params = {}
  for (const param of offer.params) {
    const value = (params as Record<string, unknown>)[param.name]
    if (value === undefined) {
      if (param.required) invalid(`The parameter "${param.name}" is required.`)
      continue
    }
    switch (param.kind) {
      case 'choice':
        if (typeof value !== 'string' || !(param.choices as string[]).includes(value)) invalid(`The ${param.name} is not one of the offered choices.`)
        ;(clean as Record<string, unknown>)[param.name] = value
        break
      case 'multi': {
        const list = value as number[]
        if (!Array.isArray(list) || new Set(list).size !== list.length || list.some(item => !param.choices.includes(item))) invalid('The notes to drop must be distinct numbers of the held challenge.')
        clean.drop = [...list].sort((a, b) => a - b)
        break
      }
      case 'text': {
        if (typeof value !== 'string' || value.includes('\0')) invalid(`The ${param.name} must be text without NUL characters.`)
        if (value.length > param.max_length) invalid(`The ${param.name} is longer than ${param.max_length} characters.`)
        if (value.trim().length < param.min_length) invalid(`The ${param.name} needs at least ${param.min_length} characters.`)
        ;(clean as Record<string, unknown>)[param.name] = value
        break
      }
      case 'typed':
        if (value !== runId) invalid('The typed run id does not match this run.')
        break
    }
  }
  return clean
}

// ---- The routes ---------------------------------------------------------------------------------------------------------

function fresh(now: () => Date): string {
  return now().toISOString().replace(/\.\d+Z$/, 'Z')
}

export async function controlRoutes(scope: FastifyInstance, options: ControlsRouteOptions): Promise<void> {
  const { store, setup } = options
  const log = scope.log
  scope.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof ControlsError) {
      if (error.status >= 500) log.error({ code: error.code }, 'Run control request failed')
      else log.warn({ code: error.code, status: error.status }, 'Run control request refused')
      return send(reply, error.status, errorBody(error.code, error.message))
    }
    const status = typeof (error as { statusCode?: number }).statusCode === 'number' ? (error as { statusCode: number }).statusCode : 500
    if ((error as { code?: string }).code === 'FST_ERR_MAX_PARAM_LENGTH') return send(reply, 400, errorBody('INVALID_ID', 'A path segment is longer than any valid ID.'))
    if (status === 415) return send(reply, 415, errorBody('UNSUPPORTED_MEDIA_TYPE', 'The request body must be application/json.'))
    if (status >= 400 && status < 500) return send(reply, 400, errorBody('INVALID_PARAMS', 'The request body must be a JSON object this control accepts.'))
    log.error({ code: (error as NodeJS.ErrnoException)?.code }, 'Unhandled run control failure')
    return send(reply, 500, errorBody('INTERNAL', 'The request failed unexpectedly. Check the server log.'))
  })

  if (!setup.enabled) {
    scope.get('/status', async (_request, reply) => send(reply, 200, conform(controlsStatusSchema, { version: CONTROLS_VERSION, enabled: false, paired: false }, log)))
    scope.setNotFoundHandler((_request, reply) => send(reply, 404, errorBody('CONTROLS_DISABLED', 'Run controls are off on this server.')))
    return
  }
  const config: ControlsConfig = setup
  const now = options.now ?? (() => new Date())
  const runner = new Runner(config, options.runner)
  const secrets = { home: userHome(config.childEnv), token: config.token.toString('utf8') }
  const records = new RecordStore(config.stateDir, now, secrets)
  // The controller's two newer commands, read once as the routes start (never on a request) and kept for the process.
  const capabilities = readCapabilities(runner, config.python)
  scope.setNotFoundHandler((_request, reply) => send(reply, 404, errorBody('NOT_FOUND', 'No run control resource exists at that path.')))
  const githubSource = options.github ?? null
  const githubEnabled = options.githubActions ?? config.childEnv.MD_MANAGER_GITHUB_ACTIONS === 'on'
  const githubTimeoutMs = options.githubTimeoutMs ?? GITHUB_ACTION_TIMEOUT_MS
  const githubRecords = new GithubRecordStore(config.stateDir, now, secrets)
  scope.addHook('onReady', async () => {
    const lost = await records.recoverLost() + await githubRecords.recoverLost()
    if (lost > 0) log.warn({ lost }, 'Run control records still running at startup were marked lost')
  })

  // Guards 1 to 4 run before the body is read: a refused request is never parsed and never reaches a handler.
  scope.addHook('onRequest', async request => {
    if (request.method === 'POST') {
      requireBrowserGuards(config, request)
      requireToken(config, request)
    } else if ((request.method === 'GET' || request.method === 'HEAD') && request.url.split('?')[0] !== `${CONTROLS_PREFIX}/status`) {
      // Only the exact status route is open: a run named "status" is a run like any other.
      requireToken(config, request)
    }
  })

  // One short control per run in flight, and a long control while it is being spawned ([L3]); a `running` long record holds nothing.
  const inFlight = new Set<string>()

  const keyOf = (params: Record<string, string | undefined>): RunKey => ({
    project: requireId(params.project_id, 'project'), workflow: requireId(params.workflow_id, 'workflow'), run: requireId(params.run_id, 'run'),
  })

  scope.get('/status', async (request, reply) => send(reply, 200, conform(controlsStatusSchema, { version: CONTROLS_VERSION, enabled: true, paired: isPaired(config, request) }, log)))

  scope.get('/:project_id/:workflow_id/:run_id', async (request, reply) => {
    const key = keyOf(request.params as Record<string, string>)
    const facts = await readFacts(store, key, config, runner, capabilities)
    const { controls } = controlsOf(facts)
    const supervisor = facts.supervisor.state === 'held' || facts.controller.state === 'held' ? 'running'
      : facts.supervisor.state === 'unknown' || facts.controller.state === 'unknown' ? 'unknown' : 'not_running'
    const body: RunControls = {
      version: CONTROLS_VERSION, run_state_token: facts.token, supervisor, supervisor_since: supervisor === 'running' ? facts.since : null, controls,
      records: await records.list(key),
    }
    return send(reply, 200, conform(runControlsSchema, body, log))
  })

  scope.get('/:project_id/:workflow_id/:run_id/records/:record_id', async (request, reply) => {
    const params = request.params as Record<string, string>
    const key = keyOf(params)
    if (!/^c-[0-9a-f]{12}$/.test(params.record_id ?? '')) throw new ControlsError(404, 'NOT_FOUND', 'No such record.')
    await readFacts(store, key, config, runner, capabilities)
    const record = await records.get(key, params.record_id)
    if (!record) throw new ControlsError(404, 'NOT_FOUND', 'No such record.')
    return send(reply, 200, conform(controlResponseSchema, { record }, log))
  })

  const refuseIfStale = (facts: Facts, token: string) => {
    if (facts.token !== token) throw new ControlsError(409, 'STATE_CHANGED', 'The run changed since you looked; review it and try again.')
  }

  // [L4]: the clean preview. Guards 1 to 4 and 6, `clean` offered; no request_id, no record, no BUSY.
  scope.post('/:project_id/:workflow_id/:run_id/clean-preview', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    const key = keyOf(request.params as Record<string, string>)
    const parsed = cleanPreviewRequestSchema.safeParse(request.body)
    if (!parsed.success) invalid('The preview body must be exactly { run_state_token }.')
    const facts = await readFacts(store, key, config, runner, capabilities)
    refuseIfStale(facts, parsed.data.run_state_token)
    const offer = offerOf(SPEC_BY_ID.get('clean')!, facts)
    if (!offer.available) throw new ControlsError(422, 'NOT_AVAILABLE', offer.reason ?? 'This control is not available.')
    let result
    try {
      result = await runner.capture(config.python, [...SPEC_BY_ID.get('clean')!.argv(facts.runDir, {}, facts), '--dry-run'])
    } catch {
      throw new ControlsError(500, 'SPAWN_FAILED', 'The dry run could not be started.')
    }
    const output = tailLines(result.output, secrets, 200).join('\n')
    return send(reply, 200, conform(cleanPreviewResponseSchema, { exitCode: result.exitCode, output }, log))
  })

  // The relaunch dry run for the lane the dialog chose: guards 1 to 4 and 6, `relaunch` offered and the lane among its choices; no
  // request_id, no record. Its first line is the controller's verdict, shown before Confirm.
  scope.post('/:project_id/:workflow_id/:run_id/relaunch-preview', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    const key = keyOf(request.params as Record<string, string>)
    const parsed = relaunchPreviewRequestSchema.safeParse(request.body)
    if (!parsed.success) invalid('The preview body must be exactly { run_state_token, lane }.')
    const facts = await readFacts(store, key, config, runner, capabilities)
    refuseIfStale(facts, parsed.data.run_state_token)
    const offer = offerOf(SPEC_BY_ID.get('relaunch')!, facts)
    if (!offer.available) throw new ControlsError(422, 'NOT_AVAILABLE', offer.reason ?? 'This control is not available.')
    if (!facts.relaunchLanes.includes(parsed.data.lane)) invalid('The lane is not one of the offered choices.')
    let result
    try {
      result = await runner.captureStreams(config.python, relaunchDryRun(facts.runDir, parsed.data.lane))
    } catch {
      throw new ControlsError(500, 'SPAWN_FAILED', 'The dry run could not be started.')
    }
    const first = (text: string, pick: (line: string) => boolean = () => true) => text.split('\n').map(line => line.trimEnd()).find(line => line.trim() !== '' && pick(line))
    const line = first(result.stdout) ?? first(result.stderr, candidate => candidate.startsWith('Blocked:')) ?? first(result.stderr) ?? ''
    return send(reply, 200, conform(relaunchPreviewResponseSchema, { exitCode: result.exitCode, line: redactLine(line, secrets) }, log))
  })

  // ---- The GitHub actions (githubActions.ts): the same guards, token, runner and one-in-flight rule as the controls ----------

  /** The run's GitHub read, the four offers and their state token. A read that fails leaves every action unavailable. */
  async function githubView(key: RunKey, facts: Facts) {
    let read: RunGithub | null = null
    let readReason: string | null = null
    if (githubSource === null) {
      readReason = GITHUB_READ_MISSING
    } else {
      try {
        const parsed = runGithubSchema.safeParse(await githubSource.read(key.project, key.workflow, key.run))
        if (parsed.success) read = parsed.data
        else readReason = GITHUB_READ_FAILED
      } catch {
        readReason = GITHUB_READ_FAILED
      }
    }
    let recent: string[] = []
    if (githubSource?.recentAuthors) {
      try { recent = await githubSource.recentAuthors(key.project) } catch { recent = [] }
    }
    // The draft PR body says when a lane worked as a team; the team read is only worth its cost while a PR can still be opened.
    // The draft PR body says when a lane worked as a team and states the sessions' metered spend, as Copy run summary does;
    // both reads are only worth their cost while a PR can still be opened.
    let teams: Teams | null = null
    let meteredUsd: number | null = null
    if (githubEnabled && read !== null && read.pr === null) {
      const scope = store.scope(key.project, key.workflow)
      try { teams = await store.teams(scope, key.run) } catch { teams = null }
      try { meteredUsd = (await store.sessions(scope, key.run)).totals.metered_usd } catch { meteredUsd = null }
    }
    const repositoryShown = shownPath(facts.repository, secrets)
    const actions = githubActionsOf({
      enabled: githubEnabled, read, readReason, runStatus: facts.status, repositoryShown, suggestions: reviewerSuggestions(read, recent),
      defaults: summaryDefaults(facts.loaded, key.workflow, read, teams, meteredUsd),
    })
    return { read, actions, repositoryShown, token: githubStateToken(read, facts.status) }
  }

  scope.get('/:project_id/:workflow_id/:run_id/github', async (request, reply) => {
    const key = keyOf(request.params as Record<string, string>)
    const facts = await readFacts(store, key, config, runner, capabilities)
    const view = await githubView(key, facts)
    const body: RunGithubActions = {
      version: GITHUB_ACTIONS_VERSION, enabled: githubEnabled, state_token: view.token, repo: view.read?.repo.owner_name ?? null, visibility: view.read?.github.visibility ?? null,
      actions: view.actions, records: await githubRecords.list(key),
    }
    return send(reply, 200, conform(runGithubActionsSchema, body, log))
  })

  scope.post('/:project_id/:workflow_id/:run_id/github/:action_id', { bodyLimit: 512 * 1024 }, async (request, reply) => {
    const routeParams = request.params as Record<string, string>
    const key = keyOf(routeParams)
    const id = routeParams.action_id as GithubActionId
    if (!(GITHUB_ACTION_IDS as readonly string[]).includes(id)) throw new ControlsError(404, 'NOT_FOUND', 'No such GitHub action.')
    const parsed = githubActionRequestSchema.safeParse(request.body)
    if (!parsed.success) invalid('The body must be { request_id, state_token, params } with parameters this action accepts.')
    const body = parsed.data
    const runKey = runKeyOf(key)
    const repeated = await githubRecords.byRequest(key, body.request_id)
    if (repeated) return send(reply, repeated.status === 'running' ? 202 : 200, conform(githubActionResponseSchema, { record: repeated }, log))
    const leased = !inFlight.has(runKey)
    if (leased) inFlight.add(runKey)
    try {
      const facts = await readFacts(store, key, config, runner, capabilities)
      const view = await githubView(key, facts)
      if (view.token !== body.state_token) throw new ControlsError(409, 'STATE_CHANGED', 'The branch or pull request changed since you looked; review it and try again.')
      if (!leased) throw new ControlsError(409, 'BUSY', 'Another control or GitHub action of this run is starting or running. Wait for it to finish.')
      const action = view.actions.find(candidate => candidate.id === id)!
      if (!action.available || view.read === null) throw new ControlsError(422, 'NOT_AVAILABLE', action.reason ?? 'This action is not available.')
      const params = validateGithubParams(action, body.params, view.read.repo.owner_name)
      const record = await executeGithub(id, facts, view.read, view.repositoryShown, key, body.request_id, params)
      return send(reply, 200, conform(githubActionResponseSchema, { record }, log))
    } finally {
      if (leased) inFlight.delete(runKey)
    }
  })

  /** Runs one GitHub action as a short child and returns its final record; an `open_pr` body lives in a mode-600 file for the call only. */
  async function executeGithub(id: GithubActionId, facts: Facts, read: RunGithub, repositoryShown: string, key: RunKey, requestId: string, params: GithubParams): Promise<GithubActionRecord> {
    const recordId = newGithubRecordId()
    await githubRecords.prepare(key)
    let bodyFile: string | null = null
    try {
      if (id === 'open_pr') {
        bodyFile = githubRecords.bodyPath(key, recordId)
        await fs.writeFile(bodyFile, params.body!, { mode: 0o600, flag: 'wx' })
        await fs.chmod(bodyFile, 0o600)
      }
      const argv = githubArgv(id, facts.runDir, facts.repository, read, params, bodyFile)
      const shownParams = {
        ...(params.title !== undefined ? { title: params.title } : {}), ...(params.body !== undefined ? { body_chars: params.body.length } : {}),
        ...(params.reviewers !== undefined ? { reviewers: params.reviewers } : {}),
      }
      const base: StoredGithubRecord = {
        record_id: recordId, request_id: requestId, action: id, params: shownParams, command: githubDisplay(id, repositoryShown, read, params), status: 'running', exit_code: null,
        started_at: fresh(now), ended_at: null, output_tail: [], url: null, argv: [config.python, ...argv].map(element => redactText(element, secrets)),
      }
      await githubRecords.write(key, base)
      const logPath = githubRecords.logPath(key, recordId)
      let child
      try {
        child = await runner.start(config.python, argv, logPath, true, githubTimeoutMs)
      } catch {
        await githubRecords.write(key, { ...base, status: 'refused', ended_at: fresh(now), output_tail: ['The command could not be started.'] })
        throw new ControlsError(500, 'SPAWN_FAILED', 'The command could not be started.')
      }
      const done = await child.done
      const result = await settle(done)
      // A command stopped by the bound, or the controller's exit 3, may have published: never told as "nothing happened".
      const unknown = (done.kind === 'exit' && done.timedOut) || result.code === GITHUB_EXIT_UNKNOWN
      const note = done.kind === 'exit' && done.timedOut ? GITHUB_UNKNOWN_NOTE : result.note
      const output = tailLines(await readLogTail(logPath), secrets)
      const ended: StoredGithubRecord = {
        ...base, status: result.status, exit_code: result.code, ended_at: fresh(now), output_tail: [...output, ...(note ? [note] : [])].slice(-40),
        url: result.status === 'succeeded' ? urlOf(output) : null,
      }
      await githubRecords.write(key, ended)
      if (ended.status === 'refused') throw new ControlsError(500, 'SPAWN_FAILED', 'The command could not be started.')
      if (ended.status === 'succeeded' || unknown) githubSource?.markDue(key.project, key.workflow, key.run)
      const { argv: _argv, ...shown } = ended
      void _argv
      return shown
    } finally {
      if (bodyFile !== null) await fs.rm(bodyFile, { force: true }).catch(() => undefined)
    }
  }

  scope.post('/:project_id/:workflow_id/:run_id/:control_id', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    const routeParams = request.params as Record<string, string>
    const key = keyOf(routeParams)
    const spec = SPEC_BY_ID.get(routeParams.control_id as ControlId)
    if (!spec) throw new ControlsError(404, 'NOT_FOUND', 'No such control.')
    const parsed = controlRequestSchema.safeParse(request.body)
    if (!parsed.success) invalid('The body must be { request_id, run_state_token, params } with parameters this control accepts.')
    const body = parsed.data
    const runKey = runKeyOf(key)

    // Guard 5: a repeated request_id answers with the first request's record and runs nothing.
    const repeated = await records.byRequest(key, body.request_id)
    if (repeated) return send(reply, repeated.status === 'running' ? 202 : 200, conform(controlResponseSchema, { record: repeated }, log))

    // Guard 7, taken synchronously so two requests cannot both pass: the loser is BUSY once the other guards had their say.
    const leased = !inFlight.has(runKey)
    if (leased) inFlight.add(runKey)
    try {
      const facts = await readFacts(store, key, config, runner, capabilities)
      refuseIfStale(facts, body.run_state_token)
      if (!leased) throw new ControlsError(409, 'BUSY', 'Another control of this run is starting or running. Wait for it to finish.')
      const offer = offerOf(spec, facts)
      if (!offer.available) throw new ControlsError(422, 'NOT_AVAILABLE', offer.reason ?? 'This control is not available.')
      const params = validateParams(offer, body.params, key.run)
      if (spec.id === 'retry' && !facts.retryTargets.some(target => target.lane === params.lane && target.phase === params.phase)) {
        invalid('That phase and lane are not a check that failed or was interrupted.')
      }
      const record = await execute(spec, facts, key, body.request_id, params)
      return send(reply, record.status === 'running' ? 202 : 200, conform(controlResponseSchema, { record }, log))
    } finally {
      if (leased) inFlight.delete(runKey)
    }
  })

  /** Runs one control and returns its record: final for a short or signal control, `running` for a long one once its child is spawned. */
  async function execute(spec: Spec, facts: Facts, key: RunKey, requestId: string, params: Params): Promise<ControlRecord> {
    const recordId = newRecordId()
    const { confirm_run_id: _typed, ...shown } = params
    void _typed
    const command = spec.display(params, facts)
    const base: StoredRecord = {
      record_id: recordId, request_id: requestId, control: spec.id, params: shown, command, status: 'running', exit_code: null, started_at: fresh(now), ended_at: null, output_tail: [],
      argv: [], unit: null,
    }
    if (spec.runs === 'signal') return signal(base, facts, key)
    await records.prepare(key)
    const argv = spec.argv(facts.runDir, params, facts)
    const logPath = records.logPath(key, recordId)
    let command0 = config.python
    let args = argv
    if (spec.runs === 'long' && config.spawnMode === 'systemd') {
      base.unit = unitName(key, (await records.all(key)).length + 1)
      command0 = 'systemd-run'
      args = systemdRunArgv(config, base.unit, [config.python, ...argv])
    }
    base.argv = [command0, ...args].map(element => redactText(element, secrets))
    await records.write(key, base)
    const finish = async (result: Awaited<ReturnType<typeof settle>>) => {
      const output = tailLines(await readLogTail(logPath), secrets)
      const extra = result.note ? [result.note] : []
      const ended: StoredRecord = { ...base, status: result.status, exit_code: result.code, ended_at: fresh(now), output_tail: [...output, ...extra].slice(-40) }
      await records.write(key, ended)
      return publicRecord(ended)
    }
    let child
    try {
      child = await runner.start(command0, args, logPath, spec.runs === 'short')
    } catch {
      return refused(base, key, 'The command could not be started.')
    }
    if (spec.runs === 'long') {
      void child.done.then(result => settle(result)).then(finish).catch(error => log.error({ code: (error as NodeJS.ErrnoException)?.code }, 'Run control record update failed'))
      return publicRecord(base)
    }
    const result = await settle(await child.done)
    const ended = await finish(result)
    if (ended.status === 'refused') throw new ControlsError(500, 'SPAWN_FAILED', 'The command could not be started.')
    return ended
  }

  async function refused(base: StoredRecord, key: RunKey, why: string): Promise<never> {
    await records.write(key, { ...base, status: 'refused', ended_at: fresh(now), output_tail: [why] })
    throw new ControlsError(500, 'SPAWN_FAILED', 'The command could not be started.')
  }

  async function settle(result: import('./controlsRunner.ts').ChildResult): Promise<{ status: ControlRecord['status']; code: number | null; note: string | null }> {
    if (result.kind === 'error') return { status: 'refused', code: null, note: `The command could not be started (${result.code}).` }
    if (result.timedOut) return { status: 'failed', code: null, note: 'The command ran longer than 5 minutes and was stopped.' }
    if (result.signal) return { status: 'failed', code: null, note: `The command was terminated by ${result.signal}.` }
    return { status: result.code === 0 ? 'succeeded' : 'failed', code: result.code, note: null }
  }

  async function signal(base: StoredRecord, facts: Facts, key: RunKey): Promise<ControlRecord> {
    const group = facts.holder?.pgrp
    const finishWith = async (status: 'succeeded' | 'failed', line: string): Promise<ControlRecord> => {
      const ended: StoredRecord = { ...base, status, exit_code: status === 'succeeded' ? 0 : 1, ended_at: fresh(now), output_tail: [redactLine(line, secrets)] }
      await records.write(key, ended)
      return publicRecord(ended)
    }
    if (group === null || group === undefined) return finishWith('failed', 'The supervisor\'s process group could not be read; nothing was signalled.')
    // [L1] 5: a fake /proc is a test tree, so its pids are not real processes; only an injected kill may be called.
    if (config.procOverridden && !runner.killInjected) return finishWith('succeeded', `SIGINT to group ${group} (test /proc: not sent)`)
    try {
      runner.kill(group, 'SIGINT')
    } catch (error) {
      return finishWith('failed', `SIGINT to group ${group} failed (${(error as NodeJS.ErrnoException).code ?? 'error'}).`)
    }
    return finishWith('succeeded', `SIGINT to group ${group}`)
  }
}
