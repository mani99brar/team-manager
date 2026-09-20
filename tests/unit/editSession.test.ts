import { test } from 'node:test'
import { Text } from '@codemirror/state'
import assert from 'node:assert/strict'
import {
  canRevert,
  canSave,
  edit,
  hasUnacknowledgedWork,
  reloaded,
  requestRevert,
  requestSave,
  settleFailure,
  settleSuccess,
  startSession,
  status,
  type Session,
} from '../../src/document/editSession.ts'
import { analyzeText, serializeText, textFromContent } from '../../src/document/serialize.ts'

const doc = { content: '# One\n', hash: 'h0' }

function sent(session: Session) {
  assert.ok(session.inFlight, 'a request is in flight')
  return session.inFlight!
}

test('entering Edit captures an immutable baseline and starts Saved with no request', () => {
  const session = startSession(doc)
  assert.deepEqual(session.baseline, doc)
  assert.deepEqual(session.acknowledged, doc)
  assert.equal(session.draft, doc.content)
  assert.equal(session.inFlight, null)
  assert.equal(session.queued, null)
  assert.equal(status(session), 'saved')
  assert.equal(hasUnacknowledgedWork(session), false)
  assert.equal(canRevert(session), false)
})

test('keystrokes mark the draft Unsaved and never enqueue a request', () => {
  let session = startSession(doc)
  session = edit(session, '# One\nmore')
  assert.equal(status(session), 'unsaved')
  assert.equal(session.inFlight, null)
  assert.equal(session.queued, null)
  assert.equal(hasUnacknowledgedWork(session), true)
  session = edit(session, doc.content)
  assert.equal(status(session), 'saved')
  assert.equal(hasUnacknowledgedWork(session), false)
})

test('explicit save sends the draft snapshot with the acknowledged hash; success acknowledges exactly that snapshot', () => {
  let session = edit(startSession(doc), 'A')
  session = requestSave(session)
  const request = sent(session)
  assert.equal(request.content, 'A')
  assert.equal(request.expectedHash, 'h0')
  assert.equal(status(session), 'saving')
  // Typing during the in-flight save is kept and is not part of the request.
  session = edit(session, 'AB')
  assert.equal(sent(session).content, 'A')
  assert.equal(status(session), 'saving')
  session = settleSuccess(session, request.token, 'h1')
  assert.deepEqual(session.acknowledged, { content: 'A', hash: 'h1' })
  assert.equal(session.draft, 'AB')
  assert.equal(status(session), 'unsaved', 'unsent later edits never show Saved')
  assert.equal(session.inFlight, null)
  session = edit(session, 'A')
  assert.equal(status(session), 'saved')
  // Successful saves never move the edit-session baseline.
  assert.deepEqual(session.baseline, doc)
})

test('saving an unchanged draft sends nothing', () => {
  const session = requestSave(startSession(doc))
  assert.equal(session.inFlight, null)
  assert.equal(status(session), 'saved')
})

test('only one request is in flight: later explicit saves fill one pending slot with the latest snapshot', () => {
  let session = requestSave(edit(startSession(doc), 'A'))
  const first = sent(session)
  session = requestSave(edit(session, 'AB'))
  assert.equal(sent(session).token, first.token, 'no second concurrent request')
  assert.deepEqual(session.queued, { content: 'AB' })
  session = requestSave(edit(session, 'ABC'))
  assert.deepEqual(session.queued, { content: 'ABC' }, 'the pending slot is replaced, not appended')
  assert.equal(sent(session).token, first.token)
  // Keystrokes after the last explicit save do not change the queued snapshot.
  session = edit(session, 'ABCD')
  assert.deepEqual(session.queued, { content: 'ABC' })

  session = settleSuccess(session, first.token, 'h1')
  const second = sent(session)
  assert.equal(second.content, 'ABC')
  assert.equal(second.expectedHash, 'h1', 'the queued request uses the hash returned by the first success')
  assert.notEqual(second.token, first.token)
  assert.equal(session.queued, null)
  assert.deepEqual(session.acknowledged, { content: 'A', hash: 'h1' })
  assert.equal(status(session), 'saving')

  session = settleSuccess(session, second.token, 'h2')
  assert.deepEqual(session.acknowledged, { content: 'ABC', hash: 'h2' })
  assert.equal(status(session), 'unsaved', 'ABCD was never sent')
  assert.equal(session.inFlight, null)
})

test('a failure stops the queue, keeps the latest draft and the acknowledged hash, and retry uses that hash', () => {
  let session = requestSave(edit(startSession(doc), 'A'))
  const first = sent(session)
  session = requestSave(edit(session, 'AB'))
  session = edit(session, 'ABC')
  session = settleFailure(session, first.token, { kind: 'failed', message: 'The API could not be reached.' })
  assert.equal(session.inFlight, null)
  assert.equal(session.queued, null, 'queued write is not retried automatically')
  assert.equal(session.draft, 'ABC')
  assert.equal(status(session), 'error')
  assert.equal(session.error?.kind, 'failed')
  assert.deepEqual(session.acknowledged, doc)
  assert.equal(hasUnacknowledgedWork(session), true)
  assert.equal(canSave(session), true)
  session = requestSave(session)
  assert.equal(sent(session).content, 'ABC')
  assert.equal(sent(session).expectedHash, 'h0')
  assert.equal(status(session), 'saving')
  assert.equal(session.error, null)
})

test('a conflict blocks Save and Revert until a successful reload replaces the baseline', () => {
  let session = requestSave(edit(startSession(doc), 'A'))
  const first = sent(session)
  session = settleFailure(session, first.token, { kind: 'conflict', message: 'changed on disk' })
  assert.equal(status(session), 'error')
  assert.equal(session.conflicted, true)
  assert.equal(canSave(session), false)
  assert.equal(canRevert(session), false)
  assert.equal(requestSave(session).inFlight, null)
  assert.equal(requestRevert(session).inFlight, null)
  assert.equal(session.draft, 'A', 'draft preserved')
  const fresh = { content: 'external', hash: 'h9' }
  session = reloaded(session, fresh)
  assert.deepEqual(session.baseline, fresh)
  assert.deepEqual(session.acknowledged, fresh)
  assert.equal(session.draft, 'external')
  assert.equal(session.conflicted, false)
  assert.equal(session.error, null)
  assert.equal(status(session), 'saved')
  session = requestSave(edit(session, 'after reload'))
  assert.equal(sent(session).expectedHash, 'h9')
})

test('responses with a token that is not the in-flight token are ignored', () => {
  let session = requestSave(edit(startSession(doc), 'A'))
  const first = sent(session)
  const before = session
  session = settleSuccess(session, first.token + 100, 'late')
  assert.equal(session, before)
  session = settleFailure(session, first.token - 1, { kind: 'failed', message: 'late' })
  assert.equal(session, before)
  session = settleSuccess(session, first.token, 'h1')
  assert.equal(session.inFlight, null)
  // A duplicate settle after completion changes nothing.
  assert.equal(settleSuccess(session, first.token, 'h2'), session)
})

test('Revert sends the Edit baseline through the hash check and restores the baseline on success', () => {
  let session = requestSave(edit(startSession(doc), 'A'))
  session = settleSuccess(session, sent(session).token, 'h1')
  session = requestSave(edit(session, 'AB'))
  session = settleSuccess(session, sent(session).token, 'h2')
  assert.deepEqual(session.acknowledged, { content: 'AB', hash: 'h2' })
  assert.equal(canRevert(session), true)
  session = requestRevert(session)
  const revert = sent(session)
  assert.equal(revert.content, doc.content, 'the original Edit baseline, not the latest save')
  assert.equal(revert.expectedHash, 'h2')
  assert.equal(revert.purpose, 'revert')
  assert.equal(canRevert(session), false, 'disabled while pending')
  session = settleSuccess(session, revert.token, 'h3')
  assert.deepEqual(session.acknowledged, { content: doc.content, hash: 'h3' })
  assert.equal(session.draft, doc.content)
  assert.deepEqual(session.baseline, doc)
  assert.equal(status(session), 'saved')
})

test('Revert is unavailable while a save or queued save is pending, and a failed Revert keeps the pre-Revert draft', () => {
  let session = requestSave(edit(startSession(doc), 'A'))
  assert.equal(canRevert(session), false)
  const first = sent(session)
  session = requestSave(edit(session, 'AB'))
  session = settleSuccess(session, first.token, 'h1')
  assert.equal(canRevert(session), false, 'queued save now in flight')
  session = settleSuccess(session, sent(session).token, 'h2')
  assert.equal(canRevert(session), true)
  session = edit(session, 'ABC')
  session = requestRevert(session)
  const revert = sent(session)
  session = settleFailure(session, revert.token, { kind: 'conflict', message: 'stale' })
  assert.equal(session.draft, 'ABC')
  assert.deepEqual(session.acknowledged, { content: 'AB', hash: 'h2' })
  assert.equal(session.conflicted, true)
  assert.equal(status(session), 'error')
})

test('line endings: LF, CRLF and BOM round-trip byte for byte; mixed or lone CR is not editable', () => {
  for (const content of ['', 'a', 'a\n', 'a\nb', 'a\r\nb\r\n', '﻿# bom\r\nno final', '﻿a\nb\n', '\n\n\n', '\r\n']) {
    const analysis = analyzeText(content)
    assert.equal(analysis.editable, true, JSON.stringify(content))
    const text = textFromContent(content, analysis)
    assert.equal(serializeText(text, analysis), content, JSON.stringify(content))
  }
  for (const content of ['a\r\nb\nc', 'a\rb', 'a\n\r', '﻿a\r\nb\n']) {
    assert.equal(analyzeText(content).editable, false, JSON.stringify(content))
  }
  const crlf = analyzeText('x\r\ny')
  assert.equal(crlf.lineEnding, '\r\n')
  assert.equal(analyzeText('x\ny').lineEnding, '\n')
  assert.equal(analyzeText('x').lineEnding, '\n')
  assert.equal(analyzeText('﻿x').bom, true)
  // Edited text is serialized with the file's own line ending and BOM.
  const edited = textFromContent('﻿a\r\nb', analyzeText('﻿a\r\nb'))
  assert.equal(serializeText(edited.replace(0, 1, Text.of(['A'])), analyzeText('﻿a\r\nb')), '﻿A\r\nb')
})
