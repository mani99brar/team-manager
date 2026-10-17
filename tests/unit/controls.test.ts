/**
 * The run-controls UI's rules (docs/PRD_RUN_CONTROLS.md section 6; decisions [L2], [L3], [L4]): the dialog model (inputs per
 * `ParamSpec`, Confirm only when valid, the typed run id), one `request_id` per dialog and none on the clean preview, the
 * record's wording, the 409 handling, which dock step gets Run, and a list that shows what the server sent.
 */
import { spawnSync } from 'node:child_process'
import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { ControlError, controlPaths, postCleanPreview, postControl } from '../../src/projects/controls/client.ts'
import {
  answerCheck, answerLost, askCheck, attemptFingerprint, buildParams, heldAfterFailure, nextAttempt, canOpen, controlRows, currentCheck, describeFailure, dialogValid, headlineOf, initialValues, matchStep, newRequestId, NOTE_CONFIRM, NOTE_FIELD_HELPER,
  NOTE_FIELD_LABEL, NOTE_UNDELIVERABLE, noteOutcome, noteTitle, paramProblem, pinToken, reasonOf, recordLine, relaunchConfirmable, shownRecord, stepControl,
} from '../../src/projects/controls/model.ts'
import { waitingQuestions } from '../../src/projects/controls/questions.ts'
import { CONTROL_ORDER, type Control, type ControlId, type ControlRecord, type RunControls } from '../../src/projects/controls/types.ts'
import { controlsFor } from '../project-workflows/fixtures/controls.ts'

const RUN = 'controls-stopped'
const SCOPE = { projectId: 'alpha-project', workflowId: 'controls', runId: RUN }
const HERDR_REASON = "Typing the answer needs the lane's Herdr pane; answer in your terminal"

const control = (id: ControlId, patch: Partial<Control> = {}): Control => ({
  id, label: id, available: true, reason: null, recommended: false, command: `$PY -m workflow ${id}`, runs: 'short', confirm: 'plain', params: [], effect: 'Does it.', not_effect: null, ...patch,
})
const record = (patch: Partial<ControlRecord> = {}): ControlRecord => ({
  record_id: 'c-000000000001', request_id: 'r', control: 'restart', params: {}, command: '$PY', status: 'running', exit_code: null, started_at: '2026-03-02T09:00:00Z', ended_at: null, output_tail: [], ...patch,
})
const payload = (controls: Control[], records: ControlRecord[] = []): RunControls => ({ version: '1.2.0', run_state_token: 'rs-1', supervisor: 'not_running', supervisor_since: null, controls, records })

describe('the dialog model', () => {
  test('a text parameter needs its length, a typed one the run id, a choice a listed value', () => {
    const abandon = controlsFor('controls-stopped', 'rs-1')!.controls.find(item => item.id === 'abandon')!
    let values = initialValues(abandon)
    assert.equal(dialogValid(abandon, values, RUN), false)
    values = { ...values, reason: 'The design changed.' }
    assert.equal(dialogValid(abandon, values, RUN), false, 'the run id is still missing')
    assert.equal(paramProblem(abandon.params[1], { ...values, confirm_run_id: `${RUN}x` }, RUN), 'Type the run id exactly.')
    values = { ...values, confirm_run_id: RUN }
    assert.equal(dialogValid(abandon, values, RUN), true)
    assert.deepEqual(buildParams(abandon, values), { reason: 'The design changed.', confirm_run_id: RUN })
    // The reason's own bounds, and a NUL.
    assert.notEqual(paramProblem(abandon.params[0], { ...values, reason: 'ab' }, RUN), null)
    assert.notEqual(paramProblem(abandon.params[0], { ...values, reason: 'x'.repeat(501) }, RUN), null)
    assert.notEqual(paramProblem(abandon.params[0], { ...values, reason: 'abc\0' }, RUN), null)
  })

  test('a single choice is preselected, the dock command presets its lane and phase, a lane not offered is not', () => {
    const retry = controlsFor('controls-repair', 'rs-1')!.controls.find(item => item.id === 'retry')!
    assert.deepEqual({ ...initialValues(retry), drop: [] }, { lane: 'ui', phase: '', drop: [], text: '', reason: '', confirm_run_id: '' })
    assert.equal(initialValues(retry, { phase: 'candidate', lane: 'ghost' }).phase, 'candidate')
    assert.equal(initialValues(retry, { lane: 'ghost' }).lane, 'ui')
    assert.equal(dialogValid(retry, initialValues(retry), RUN), false, 'the phase is required')
    assert.equal(dialogValid(retry, initialValues(retry, { phase: 'worker' }), RUN), true)
  })

  test('an answer needs text; the optional drop list is sent only when chosen', () => {
    const answer = controlsFor('controls-question', 'rs-1')!.controls.find(item => item.id === 'answer')!
    assert.equal(dialogValid(answer, initialValues(answer), RUN), false)
    assert.equal(dialogValid(answer, { ...initialValues(answer), text: '   ' }, RUN), false, 'blank is empty')
    assert.equal(dialogValid(answer, { ...initialValues(answer), text: 'Yes.' }, RUN), true)
    const release = control('release_hold', { params: [{ name: 'drop', kind: 'multi', choices: [1, 2], required: false }] })
    assert.equal(dialogValid(release, initialValues(release), RUN), true)
    assert.deepEqual(buildParams(release, initialValues(release)), {})
    assert.deepEqual(buildParams(release, { ...initialValues(release), drop: [2, 1] }), { drop: [1, 2] })
  })

  test('each dialog has its own request id', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newRequestId()))
    assert.equal(ids.size, 50)
    for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe('the requests', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = originalFetch })
  const capture = () => {
    const calls: { url: string; init: RequestInit }[] = []
    globalThis.fetch = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify({ exitCode: 0, output: '', record: record() }), { status: 200 }) }) as typeof fetch
    return calls
  }

  test('the clean preview sends the run state token only, and the request id goes only on the clean POST ([L4])', async () => {
    const calls = capture()
    await postCleanPreview(SCOPE, 'secret-token', 'rs-1')
    await postControl(SCOPE, 'secret-token', 'clean', { request_id: 'req-1', run_state_token: 'rs-1', params: { confirm_run_id: RUN } })
    assert.equal(calls[0].url, `/api/run-controls/alpha-project/controls/${RUN}/clean-preview`)
    assert.deepEqual(JSON.parse(calls[0].init.body as string), { run_state_token: 'rs-1' })
    assert.equal(calls[1].url, `/api/run-controls/alpha-project/controls/${RUN}/clean`)
    assert.deepEqual(JSON.parse(calls[1].init.body as string), { request_id: 'req-1', run_state_token: 'rs-1', params: { confirm_run_id: RUN } })
  })

  test('the token travels in its header, never in a URL', async () => {
    const calls = capture()
    await postControl(SCOPE, 'secret-token', 'restart', { request_id: 'req-1', run_state_token: 'rs-1', params: {} })
    assert.equal((calls[0].init.headers as Record<string, string>)['X-MDM-Control-Token'], 'secret-token')
    assert.equal((calls[0].init.headers as Record<string, string>)['Content-Type'], 'application/json')
    assert.ok(!calls[0].url.includes('secret-token'))
    assert.ok(!controlPaths.record(SCOPE, 'c-1').includes('secret'))
  })

  test('an error body becomes a ControlError with the server code', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: 'STATE_CHANGED', message: 'moved' } }), { status: 409 })) as typeof fetch
    await assert.rejects(postControl(SCOPE, 't', 'restart', { request_id: 'r', run_state_token: 'x', params: {} }), (error: unknown) => error instanceof ControlError && error.code === 'STATE_CHANGED' && error.status === 409)
  })
})

describe('the record and the refusals', () => {
  const NOW = Date.parse('2026-03-02T09:02:00Z')
  test('a record reads as its label, status and duration; a failure leads with the controller\'s Blocked line', () => {
    assert.equal(recordLine(record(), 'Restart supervisor', NOW), 'Restart supervisor · running for 2 min')
    assert.equal(recordLine(record({ status: 'succeeded', exit_code: 0, ended_at: '2026-03-02T09:00:03Z' }), 'Restart supervisor', NOW), 'Restart supervisor · succeeded in 3 s')
    assert.equal(recordLine(record({ status: 'failed', exit_code: 1 }), 'Abandon', NOW), 'Abandon · failed (exit 1)')
    assert.match(recordLine(record({ status: 'lost' }), 'Restart', NOW), /lost: the server restarted/)
    assert.equal(headlineOf(record({ status: 'failed', output_tail: ['Starting', 'Blocked: another controller owns this run', 'Nothing changed'] })), 'Blocked: another controller owns this run')
    assert.equal(headlineOf(record({ status: 'succeeded', output_tail: ['a', 'Automatic by the operator'] })), 'Automatic by the operator')
    assert.equal(headlineOf(record({ output_tail: ['still going'] })), null, 'a running record has no result line yet')
  })

  test('the dock shows a running control, else this browser\'s last action', () => {
    const running = record({ record_id: 'c-1' })
    const mine = record({ record_id: 'c-2', status: 'succeeded' })
    assert.equal(shownRecord([mine, running], null), running)
    assert.equal(shownRecord([], mine), mine)
    assert.equal(shownRecord([], null), null)
  })

  test('409 STATE_CHANGED and BUSY are said plainly, refresh the controls and allow a new confirm; a refused token unpairs', () => {
    const changed = describeFailure(new ControlError(409, 'STATE_CHANGED', 'x'))
    assert.match(changed.message, /The run changed since you looked/)
    assert.deepEqual([changed.refresh, changed.retryable, changed.unpair], [true, true, false])
    const busy = describeFailure(new ControlError(409, 'BUSY', 'x'))
    assert.match(busy.message, /Another control of this run is running/)
    assert.deepEqual([busy.refresh, busy.retryable], [true, true])
    assert.equal(describeFailure(new ControlError(403, 'TOKEN_INVALID', 'x')).unpair, true)
    const gone = describeFailure(new ControlError(422, 'NOT_AVAILABLE', 'A supervisor is running'))
    assert.deepEqual([gone.message, gone.refresh, gone.retryable], ['A supervisor is running', true, false])
  })

  test('only STATE_CHANGED drops the pinned token once the controls are refreshed; BUSY, NOT_AVAILABLE and NETWORK keep it', () => {
    assert.equal(describeFailure(new ControlError(409, 'STATE_CHANGED', 'x')).repin, true)
    assert.equal(describeFailure(new ControlError(409, 'BUSY', 'x')).repin, false)
    assert.equal(describeFailure(new ControlError(422, 'NOT_AVAILABLE', 'x')).repin, false)
    assert.equal(describeFailure(new ControlError(0, 'NETWORK', 'x')).repin, false)
    // The dropped pin adopts the refreshed token the next poll brought.
    assert.equal(pinToken(null, 'rs-2'), 'rs-2')
  })
})

describe('which step gets Run', () => {
  const step = (verb: string, ...rest: string[]) => ['"$PY" -m workflow', verb, '"$RUN"', ...rest, '--by operator'].join(' ')
  const offered = ['restart', 'retry', 'answer', 'approve', 'repair_session', 'accept_challenge'].map(id => control(id as ControlId))

  test('the first command\'s verb, and its flags where one verb serves two controls, name the control', () => {
    assert.deepEqual(matchStep(step('automatic', '--live')), { id: 'restart' })
    assert.equal(matchStep(step('automatic')), null, 'a bare automatic is not the supervisor restart')
    assert.deepEqual(matchStep(step('retry', '--phase', 'candidate', '--node', 'ui')), { id: 'retry', lane: 'ui', phase: 'candidate' })
    assert.deepEqual(matchStep(step('answer', 'ui', '"<your answer>"')), { id: 'answer', lane: 'ui' })
    assert.deepEqual(matchStep(step('resume', '--accept-challenge', '"<reason>"')), { id: 'accept_challenge' })
    assert.deepEqual(matchStep(step('resume', '--launch')), { id: 'release_hold' })
    assert.deepEqual(matchStep(step('resume')), { id: 'resume' })
    assert.deepEqual(matchStep(step('repair', 'ui', '--session', '--live')), { id: 'repair_session', lane: 'ui' })
    assert.equal(matchStep(step('repair', 'ui', '--workspace')), null, 'a workspace repair is an edit that stays in the terminal')
    assert.equal(matchStep(step('status')), null)
    assert.equal(matchStep('echo hello'), null)
  })

  test('only an offered control gets Run, with the dock command\'s lane as the preset', () => {
    assert.equal(stepControl(step('automatic', '--live'), offered)?.control.id, 'restart')
    assert.deepEqual(stepControl(step('answer', 'ui', '"<your answer>"'), offered)?.preset, { lane: 'ui' })
    assert.equal(stepControl(step('abandon', '--reason', '"x"'), offered), null, 'abandon is not offered here')
    assert.equal(stepControl(step('automatic', '--live'), [control('restart', { available: false, reason: 'A supervisor is running' })]), null)
  })
})

describe('the list shows what the server sent', () => {
  test('an answer control sent unavailable with the Herdr-pane reason is greyed with that reason and opens nothing ([L2])', () => {
    const answer = control('answer', { available: false, reason: HERDR_REASON })
    assert.equal(canOpen(answer), false)
    assert.equal(reasonOf(answer), HERDR_REASON)
    const [row] = controlRows(payload([answer]))
    assert.deepEqual([row.available, row.reason], [false, HERDR_REASON])
  })

  test('with a running restart record the list still shows Pause and Answer as the server sent them ([L3])', () => {
    const data = payload([
      control('restart', { available: false, reason: 'A supervisor is running (since 09:03 UTC)', runs: 'long' }),
      control('pause', { runs: 'signal' }),
      control('answer'),
    ], [record({ status: 'running', control: 'restart' })])
    const rows = controlRows(data)
    assert.deepEqual(rows.map(row => [row.control.id, row.available]), [['restart', false], ['pause', true], ['answer', true]])
    assert.ok(rows.filter(row => row.available).every(row => canOpen(row.control)))
  })

  test('the mocked payload lists all twelve controls in the PRD order', () => {
    assert.deepEqual(controlsFor('controls-running', 'rs-1')!.controls.map(item => item.id), [...CONTROL_ORDER])
  })
})

describe('the Answer dialog\'s question', () => {
  test('the export\'s latest unanswered question per lane; the live Now wins for its lane', () => {
    const inputs = { workers: [
      { node_id: 'ui', questions: [{ n: 1, question: 'old', answer: 'a', asked_at: 'x', answered_at: 'y' }, { n: 2, question: 'Which one?', answer: null, asked_at: 'x', answered_at: null }] },
      { node_id: 'adapter', questions: [{ n: 1, question: 'done', answer: 'a', asked_at: 'x', answered_at: 'y' }] },
    ] }
    assert.deepEqual(waitingQuestions(null, inputs as never), { ui: { n: 2, text: 'Which one?' } })
    const now = { situation: 'question', lane: 'adapter', reason: ['“Fresh question?”', ' (from the event log; answered state not yet exported)'] }
    assert.deepEqual(waitingQuestions(now as never, inputs as never), { ui: { n: 2, text: 'Which one?' }, adapter: { n: null, text: 'Fresh question?' } })
  })
})

describe('decisions [L6]', () => {
  test('a dialog keeps the run state token it was opened on when the polls bring a new one (6c)', () => {
    let pinned = pinToken(null, 'rs-1')
    assert.equal(pinned, 'rs-1')
    pinned = pinToken(pinned, 'rs-2')
    assert.equal(pinned, 'rs-1', 'the later poll is not the one posted')
    assert.equal(pinToken(null, null), null)
  })

  test('the fake controller parses every argv form the server builds, and a bare leading-dash text fails as in the real controller (3)', () => {
    const fake = new URL('../project-workflows/fake-controller.py', import.meta.url).pathname
    const R = '/runs/run-1'
    const forms: string[][] = [
      ['automatic', R, '--live', '--by', 'operator'], ['retry', R, '--phase', 'worker', '--node', 'ui', '--by', 'operator'], ['reconcile', R, '--by', 'operator'],
      ['resume', R, '--by', 'operator'], ['resume', R, '--accept-challenge=-x', '--by', 'operator'], ['resume', R, '--launch', '--drop', '1,2', '--by', 'operator'],
      ['answer', R, 'ui', '--by', 'operator', '--', '-x'], ['answer', R, 'ui', '--by', 'operator', '--', '-h'], ['answer', R, 'ui', '--by', 'operator', '--', '--help'],
      ['answer', R, 'ui', '--by', 'operator', '--', '--reason'], ['approve', R, '--bundle-sha256', 'a7a7a7a7a7a7', '--by', 'operator'],
      ['repair', R, 'ui', '--session', '--live', '--by', 'operator'], ['abandon', R, '--reason=-x', '--by', 'operator'], ['abandon', R, '--reason=--reason', '--by', 'operator'],
      ['clean', R, '--by', 'operator'], ['clean', R, '--by', 'operator', '--dry-run'],
    ]
    for (const form of forms) {
      if (form[0] === 'automatic') continue // sleeps 3 s to show a running record; its parser is the same as the rest
      const result = spawnSync('python3', [fake, '-m', 'workflow', ...form], { encoding: 'utf8' })
      assert.equal(result.status, 0, `${form.join(' ')}: ${result.stderr}`)
    }
    for (const form of [['answer', R, 'ui', '--by', 'operator', '-x'], ['abandon', R, '--reason', '-x', '--by', 'operator']]) {
      assert.equal(spawnSync('python3', [fake, '-m', 'workflow', ...form], { encoding: 'utf8' }).status, 2, form.join(' '))
    }
  })
})

describe('the relaunch dry run (1.1.0)', () => {
  const asking = (lane: string, token: string, ask = 1) => ({ lane, token, ask, state: 'asking' as const })
  const answered = (lane: string, token: string, exitCode: number | null, line = `relaunch ${lane}: allowed`, ask = 1) => ({ lane, token, ask, state: 'answered' as const, exitCode, line })
  test('Confirm needs an exit-0 dry run of the lane and token chosen now', () => {
    assert.equal(relaunchConfirmable(null, 'ui', 'rs-1'), false)
    assert.equal(relaunchConfirmable(asking('ui', 'rs-1'), 'ui', 'rs-1'), false, 'not before the answer')
    assert.equal(relaunchConfirmable(answered('ui', 'rs-1', 0), 'ui', 'rs-1'), true)
    assert.equal(relaunchConfirmable(answered('ui', 'rs-1', 1, 'relaunch ui: refused: session x (\'done\') carries the launch name'), 'ui', 'rs-1'), false, 'a refusal keeps it off')
    assert.equal(relaunchConfirmable(answered('ui', 'rs-1', null), 'ui', 'rs-1'), false)
    assert.equal(relaunchConfirmable({ lane: 'ui', token: 'rs-1', ask: 1, state: 'failed', message: 'x' }, 'ui', 'rs-1'), false)
  })
  test('a change of lane or token invalidates the preview', () => {
    const check = answered('ui', 'rs-1', 0)
    assert.equal(relaunchConfirmable(check, 'adapter', 'rs-1'), false, 'another lane')
    assert.equal(relaunchConfirmable(check, 'ui', 'rs-2'), false, 'another token')
    assert.equal(relaunchConfirmable(check, 'ui', null), false)
    assert.equal(currentCheck(check, 'adapter', 'rs-1'), null)
    assert.equal(currentCheck(check, 'ui', 'rs-2'), null)
  })
  test('a late answer for an earlier choice never enables Confirm', () => {
    // Asked for ui, then the operator chose adapter: the dialog asks again, and ui's late "allowed" lands nowhere.
    let check: ReturnType<typeof answerCheck> = asking('adapter', 'rs-1')
    check = answerCheck(check, answered('ui', 'rs-1', 0))
    assert.deepEqual(check, asking('adapter', 'rs-1'))
    assert.equal(relaunchConfirmable(check, 'adapter', 'rs-1'), false)
    assert.equal(relaunchConfirmable(check, 'ui', 'rs-1'), false)
    // An answer under an earlier token is late too.
    check = answerCheck(asking('ui', 'rs-2'), answered('ui', 'rs-1', 0))
    assert.equal(relaunchConfirmable(check, 'ui', 'rs-2'), false)
    // A second answer to an answered check changes nothing either.
    check = answerCheck(answered('ui', 'rs-1', 1, 'relaunch ui: refused: x'), answered('ui', 'rs-1', 0))
    assert.equal(relaunchConfirmable(check, 'ui', 'rs-1'), false)
    // The answer to the current ask lands.
    assert.equal(relaunchConfirmable(answerCheck(asking('ui', 'rs-2'), answered('ui', 'rs-2', 0)), 'ui', 'rs-2'), true)
  })
  test('an answer to an earlier ask of the same lane and token never enables Confirm', () => {
    // ui (ask 1), then adapter (ask 2), then ui again (ask 3) before ask 1 answers: ask 1's "allowed" is not ask 3's.
    let check = askCheck(null, 'ui', 'rs-1')
    check = askCheck(check, 'adapter', 'rs-1')
    check = askCheck(check, 'ui', 'rs-1')
    assert.deepEqual(check, asking('ui', 'rs-1', 3))
    const late = answerCheck(check, answered('ui', 'rs-1', 0, 'relaunch ui: allowed', 1))
    assert.deepEqual(late, check)
    assert.equal(relaunchConfirmable(late, 'ui', 'rs-1'), false)
    assert.equal(relaunchConfirmable(answerCheck(check, answered('ui', 'rs-1', 0, 'relaunch ui: allowed', 3)), 'ui', 'rs-1'), true)
  })
  test('the preview path is the run\'s relaunch-preview route; the control ids end with retry_all, relaunch and note', () => {
    assert.equal(controlPaths.relaunchPreview(SCOPE), '/api/run-controls/alpha-project/controls/controls-stopped/relaunch-preview')
    assert.equal(CONTROL_ORDER.length, 15)
    assert.deepEqual(CONTROL_ORDER.slice(12), ['retry_all', 'relaunch', 'note'])
  })
})

describe('the note control (docs/PRD_RUN_TEAMS.md 7)', () => {
  const note = (patch: Partial<ControlRecord>) => record({ control: 'note', params: { lane: 'ui', text: 'Use the shared tone map.' }, status: 'succeeded', exit_code: 0, ended_at: '2026-03-02T09:00:02Z', ...patch })
  test('the dialog copy: title with the lane, the field label and helper, and the button', () => {
    assert.equal(noteTitle('Send a note to the lead', 'ui'), 'Send a note to the lead of ui')
    assert.equal(noteTitle('Send a note to the lead', ''), 'Send a note to the lead', 'before a lane is chosen the server\'s label stands')
    assert.equal(NOTE_FIELD_LABEL, 'Your note')
    assert.equal(NOTE_FIELD_HELPER, 'Plain text, up to 4,000 characters. The lead reads it as an operator note, which may amend its task.')
    assert.equal(NOTE_CONFIRM, 'Send note')
  })
  test('the outcomes, read from workflow note\'s own lines', () => {
    assert.deepEqual(noteOutcome(note({ output_tail: ["Note N-1 typed into ui's pane and recorded in ~/runs/r/ui.notes.json."] })), { tone: 'ok', text: "Typed into ui's pane." })
    assert.deepEqual(noteOutcome(note({ status: 'failed', exit_code: 1, output_tail: ['Blocked: note N-2 to ui is recorded undeliverable and was not typed (pane_busy). Look at the pane, then send it again as a new note.'] })), { tone: 'warn', text: NOTE_UNDELIVERABLE })
    assert.equal(NOTE_UNDELIVERABLE, 'Not delivered: the pane was busy, not attached, or the lane was not working or idle. Nothing was typed; look at the pane, then send it again.')
    assert.deepEqual(noteOutcome(note({ status: 'failed', exit_code: 1, output_tail: ["Blocked: note N-3 to ui was typed but Enter did not submit it; the text is still in ui's input line. Submit or clear it in the pane; do not send it again."] })),
      { tone: 'warn', text: "The note is still in ui's input line: submit or clear it in the pane, and do not send it again." })
    // A refusal before the note was recorded, a running record and another control keep the record's own line.
    assert.equal(noteOutcome(note({ status: 'failed', exit_code: 1, output_tail: ['Blocked: A note to ui is refused (frozen); nothing was recorded or typed'] })), null)
    assert.equal(noteOutcome(note({ status: 'running', exit_code: null, ended_at: null })), null)
    assert.equal(noteOutcome(record({ control: 'answer', status: 'succeeded' })), null)
  })
})

describe('the request_id rule of both dialogs (final review F5.2, F5.3)', () => {
  const lost = new ControlError(0, 'NETWORK', 'The viewer could not reach its server.')
  test('a retry after a lost answer with unchanged values keeps the request_id', () => {
    const sent = attemptFingerprint('rs-1', { text: 'hello' })
    const first = nextAttempt(null, sent)
    const held = heldAfterFailure(first, lost)
    assert.equal(nextAttempt(held, attemptFingerprint('rs-1', { text: 'hello' })).id, first.id)
    // A 2xx answer that could not be read, or a dropped body (not a ControlError), may have run too: the id is kept.
    assert.equal(answerLost(new ControlError(200, 'UNKNOWN', 'does not match')), true)
    assert.equal(answerLost(new TypeError('body stream dropped')), true)
  })
  test('an edit after a lost answer starts a new request_id, so the server cannot answer the edited request with the first record', () => {
    const first = nextAttempt(null, attemptFingerprint('gh-1', { title: 'Old' }))
    const held = heldAfterFailure(first, lost)
    const edited = nextAttempt(held, attemptFingerprint('gh-1', { title: 'New' }))
    assert.notEqual(edited.id, first.id)
    assert.match(edited.id, /^[0-9a-f-]{36}$/)
  })
  test('every answered refusal that means nothing ran (refused spawn, STATE_CHANGED, BUSY, NOT_AVAILABLE, INVALID_PARAMS, TOKEN_*) starts a new request_id even with unchanged values', () => {
    for (const [status, code] of [[500, 'SPAWN_FAILED'], [409, 'STATE_CHANGED'], [409, 'BUSY'], [409, 'NOT_AVAILABLE'], [400, 'INVALID_PARAMS'], [401, 'TOKEN_INVALID'], [401, 'TOKEN_REQUIRED']] as const) {
      const sent = attemptFingerprint('rs-1', {})
      const first = nextAttempt(null, sent)
      const error = new ControlError(status, code as ControlError['code'], 'no')
      assert.equal(answerLost(error), false, code)
      assert.equal(heldAfterFailure(first, error), null, code)
      assert.notEqual(nextAttempt(heldAfterFailure(first, error), sent).id, first.id, code)
    }
  })
  test('a 5xx (INTERNAL after the action ran, a proxy 502) or an UNKNOWN answer keeps the request_id: the action may have run (final review F5.1)', () => {
    for (const [status, code] of [[500, 'INTERNAL'], [500, 'UNKNOWN'], [502, 'UNKNOWN'], [503, 'UNKNOWN'], [404, 'UNKNOWN']] as const) {
      const sent = attemptFingerprint('rs-1', { text: 'hello' })
      const first = nextAttempt(null, sent)
      const error = new ControlError(status, code as ControlError['code'], 'no')
      assert.equal(answerLost(error), true, `${status} ${code}`)
      assert.equal(nextAttempt(heldAfterFailure(first, error), sent).id, first.id, `${status} ${code}`)
      // An edit after it still starts a new request.
      assert.notEqual(nextAttempt(heldAfterFailure(first, error), attemptFingerprint('rs-1', { text: 'edited' })).id, first.id)
    }
  })
})
