# MD Manager — Slice 3 PRD: Editing and File Operations (TDD)

**Status:** Ready for implementation. Slice 2's final independent review and quality gates passed on 2026-09-19; see `docs/HANDOFF_SLICE2.md` for evidence and disclosed limitations.

**Prerequisites:** Completed Slice 1 graph/outline browser and Slice 2 document preview/API.

**Scope authority:** Slice 3 of `docs/PRD_CHALLENGE_DAY2.md`. This document makes the implementation and testing contracts explicit. Slice 2's handoff contract is in `docs/PRD_SLICE2.md`.

**Slice 2 integration caution (Linux-only backend approved):** secure reads now use a startup-pinned fixture-root descriptor and `withMarkdownFile` in `server/files.ts`, not a validated pathname. `/proc/self/fd`, `O_NOFOLLOW` per component, final `fstat`, and descriptor lifetime are part of the confinement contract. Future writes/mutations must design descriptor-relative operations and collision/atomic-replacement handling; do not validate a path then reopen/rename it through an ordinary pathname. Slice 2 introduces no write routes. Document openings have fresh request lifecycles, and browsing snapshots are session-local and keyed per history entry, not URL; preserve these contracts when integrating drafts.

## 1. Goal

Let users explicitly edit and save Markdown files, detect changes made on disk before overwriting them, and perform bounded file/folder operations inside the configured Pi and Claude fixture sources.

Preserve the graph/outline browser, file URLs, safe Markdown rendering, and navigation behavior from earlier slices. The app remains single-user and localhost-only.

## 2. Included and excluded

### Included

- CodeMirror Markdown editor with Edit and Preview tabs.
- Explicit Save button and Ctrl/Cmd+S; no autosave.
- Content-hash conflict detection, Reload, Copy draft, and Revert.
- Unsaved-change warnings for in-app navigation and supported browser departures.
- Create Markdown files and folders.
- Rename, move, and delete Markdown files and empty folders.
- Copy one Markdown file between Pi and Claude.
- Secure mutation APIs, atomic content replacement, and file-mode preservation.
- Test-first development, regression coverage, and README updates.

### Excluded

- Recursive folder operations, operations on nonempty folders, bulk actions, or image uploads.
- Autosave, automatic formatting, persistent backups, version history, trash, or automatic conflict merging.
- Draft persistence across reloads, browser closure, or browser history navigation.
- Interception/blocking of browser Back/Forward.
- Live agent directories, multi-user collaboration, search, or synchronization.
- New relative-image serving or raw-HTML support.

## 3. Editing requirements

### 3.1 Enter editing

- A successfully loaded document exposes **Edit**. Do not allow editing while content is loading or unavailable.
- Use CodeMirror with Markdown syntax highlighting. Relevant packages are already installed; do not introduce a replacement editor without justification.
- Editing mode has **Edit** and **Preview** tabs. Preview renders the current draft using Slice 2's safe Markdown renderer, not stale saved content.
- Capture an immutable baseline when Edit begins: file identity, original text/byte representation, and read hash.
- Track the current draft separately from the last acknowledged saved content and hash.
- Do not trim, reformat, remove frontmatter, normalize line endings, or add a trailing newline automatically. Unchanged text must remain byte-for-byte identical, including CRLF, BOM if present, and absence of a final newline.
- Account for CodeMirror's internal newline representation when serializing. Test preservation explicitly; if a file cannot be round-tripped losslessly, keep it read-only with a clear explanation rather than silently corrupting it.

### 3.2 Save and status

- Save only through **Save** or Ctrl/Cmd+S while editing. Prevent the browser's Save Page action for this shortcut in editing mode.
- No writes on keystrokes, tab switches, navigation, or timers.
- Keep the editor usable while a save is pending.
- Each save captures a draft snapshot and the currently acknowledged hash.
- At most one save for the active document is in flight. A second explicit save during an in-flight request is queued, not sent concurrently.
- Maintain one pending slot: further explicit save actions replace it with their latest requested draft snapshot. Keystrokes alone never enqueue a save.
- After success, send any queued snapshot with the hash returned by that success. Do not send it with the previous hash.
- If a save fails or conflicts, stop the queue. Preserve the current draft; do not automatically retry queued writes.
- Async responses belong to their original document/session. A late response must not alter another file's editor, hash, or status.

Display these accessible statuses:

| Status | Meaning |
|---|---|
| Unsaved | Current draft differs from the last acknowledged content and no save is pending |
| Saving | A save request is in flight; do not imply subsequent unsent edits are saved |
| Saved | The acknowledged content equals the current draft and no save is pending |
| Error | The last save failed or conflicted; include actionable recovery guidance |

After an acknowledgment, use **Unsaved**, not **Saved**, if the user has since changed the draft. A successful HTTP response alone is insufficient to show Saved.

### 3.3 Failed saves

- Preserve the complete current draft and any edits made during the failed request.
- Show the failure and offer an explicit retry for ordinary network/server errors, plus Copy draft.
- Retry uses the last acknowledged hash. If the previous write succeeded but its response was lost, retry may correctly return a conflict; never bypass the hash check to hide that uncertainty.
- Never claim a failed or unacknowledged write is saved.

### 3.4 Conflict recovery

- A 409 from a content write enters a conflict state, shows a clear explanation, and blocks Save and Revert until Reload succeeds or the edit session is discarded.
- Offer **Reload** and **Copy draft**. Do not automatically merge, overwrite, or adopt the disk hash while keeping an unacknowledged draft writable.
- Reload explicitly warns that the draft will be discarded. Only replace the draft after a successful fresh read; a failed Reload keeps the draft and conflict state.
- Successful Reload establishes a new edit baseline, acknowledged content, and hash.
- Copy draft copies the current draft, not the baseline or last save snapshot. Report success only after the clipboard operation succeeds; provide a selectable-text fallback when unavailable.

### 3.5 Revert

- **Revert** means restore the content captured when Edit began **on disk**, not merely undo the last keystroke.
- Confirm that it will discard current draft changes and save the edit-session baseline.
- Submit the baseline through the same save pipeline and latest acknowledged hash check. Revert may itself return 409.
- Disable Revert while a save/queued save is pending or while conflicted. This avoids interleaving a destructive baseline restore with queued writes.
- On success, set draft and acknowledged content to the baseline and retain the returned hash. Ordinary successful saves do not change the original edit-session baseline.
- On failure, retain the pre-Revert draft and show recovery guidance. Reload or leaving/re-entering Edit starts a new baseline.

## 4. Navigation and recovery limits

- In-app actions that would abandon a dirty draft prompt **Discard changes?**, with Cancel preserving the draft, URL, focus, and editing state.
- Cover breadcrumbs, Back to folder, opening another file, leaving editing mode, and other app-controlled navigation. Switching Edit/Preview does not discard anything and must not prompt.
- While a write is pending, prevent app-controlled actions that would abandon its session; explain that the save must finish first. Browser history/departure remains outside this guarantee.
- Register `beforeunload` while there are unsaved changes or an unacknowledged save. Remove it once safe. Browsers control whether and how the native warning appears.
- Do not intercept browser Back/Forward. Unsaved drafts, including after a failed save, are lost when history navigation abandons editing; returning must not pretend the discarded draft is retained.
- Abrupt closure can lose unsaved work. A request already sent may complete after departure. Reopening reads the current file from disk.
- Deleted files have no built-in recovery beyond git for fixtures. Document these limits visibly in recovery guidance and the README.

## 5. File and folder operations

Provide keyboard-accessible controls from the existing graph/outline browsing context and document view where applicable. Use explicit labelled dialogs; do not add a permanent side pane.

| Operation | Allowed targets | Behavior |
|---|---|---|
| Create file | Existing folder or source root | Create a `.md` file, empty by default; do not create parent directories implicitly |
| Create folder | Existing folder or source root | Create one empty directory |
| Rename | Markdown file or empty folder | Change the basename within the same parent/source |
| Move | Markdown file or empty folder | Change location within the same source; destination parent must exist |
| Delete | Markdown file or empty folder | Confirm using the full source and relative path; never recurse |
| Copy | Individual Markdown file | Copy to the other source only; preserve file bytes/frontmatter as is |

Additional requirements:

- No source-root rename, move, or deletion. An empty relative path is not a mutation target.
- Folder emptiness is checked on disk at execution, including hidden and non-Markdown entries that the browser does not list.
- File destinations must retain a case-insensitive `.md` extension. Names and paths must pass shared validation.
- Destination selectors must not allow arbitrary filesystem roots. The server remains authoritative even if the client validates first.
- No operation overwrites an existing destination. Detect collisions using filesystem probes, not lowercased/string-only comparisons.
- Identical source/destination paths are rejected as no-op conflicts. Case-only rename succeeds if the filesystem reports the destination absent; if it reports an existing entry, reject without overwriting. Thus case-sensitive and case-insensitive filesystems behave safely without special rename workarounds.
- Copy uses saved on-disk bytes, never an unsaved editor buffer. Explain that copied frontmatter may not be accepted by the target agent.
- Refuse rename, move, or delete of the active file while it has unsaved changes, an unresolved conflict, or an in-flight/queued save. Explain that the user must save or discard first; do not implicitly discard or save.
- Disable copying the active file while a save is pending, and label copy as a copy of saved content when the draft is dirty.
- Only one operation request from a dialog is submitted at a time; disable repeated confirmation while pending.
- On success, refetch `/api/entries` and update the affected browsing state without resetting unrelated pins/expansion.
- Successful active-file rename/move updates its document URL and identity; deletion returns to its containing folder. Creating a file opens it; creating a folder reveals it. Copy keeps the original document selected and announces the destination.
- If a mutation succeeds but the listing refresh fails, report both facts clearly. Do not invite the user to repeat a successful destructive operation merely to refresh the listing.

## 6. API contracts

Reuse `createApp(root)`, the fixed startup root, source names (`Pi`, `Claude`), source-relative `/` paths, and the shared Slice 2 validator.

The final API surface remains exactly these four method/route combinations:

| Method/route | Purpose |
|---|---|
| `GET /api/entries` | Existing flat listing |
| `GET /api/file` | Existing content and SHA-256 read |
| `PUT /api/file` | Guarded content write |
| `POST /api/mutate` | File/folder operations selected by `op` |

### 6.1 `PUT /api/file`

Request:

```json
{
  "source": "Pi",
  "path": "skills/review.md",
  "content": "# Updated review\n",
  "expectedHash": "<SHA-256 from read or last successful write>"
}
```

Success: HTTP 200

```json
{
  "source": "Pi",
  "path": "skills/review.md",
  "hash": "<SHA-256 of the bytes written>"
}
```

- Validate the JSON shape, source, path, string content, and 64-character lowercase hexadecimal expected hash.
- Require an existing regular Markdown file. Do not turn PUT into implicit create.
- Read current disk bytes and compare their SHA-256 to `expectedHash` before writing. A mismatch returns 409 and leaves the file untouched.
- Encode content as UTF-8 without transformations. The client associates the successful hash with its exact submitted snapshot.
- Serialize conflicting server-side operations so two requests using the same old hash cannot both succeed and overwrite each other. A process-local mutation lock is acceptable for this single-user app.
- Write to an exclusively created, uniquely named temp file in the same directory; its name must not end in `.md`.
- Obtain the original file's mode with `fstat`, apply that mode to the temp file with `chmod`, finish/close the temp write, then atomically rename it over the original.
- Clean up temp files on handled failures. A failed write before rename must leave original bytes intact.
- Recheck disk identity/content before replacement to detect changes during staging. Abort with conflict when detected.
- Do not claim a fully transactional lock against arbitrary external filesystem writers: the hash check and rename have a residual external-writer race. This slice guarantees tested stale-hash rejection and serialization of app requests, not an OS-wide compare-and-swap.
- Preserve permission mode; preservation of ownership, timestamps, ACLs, and extended attributes is not required.
- Support at least the >100 KB document case from Slice 2. If enforcing a request-size limit, document it and show a clear 413 error without losing the draft.

### 6.2 `POST /api/mutate`

Use a discriminated JSON request contract:

```text
{ op: "create-file", source, path, content?: string }  // default content: ""
{ op: "create-folder", source, path }
{ op: "rename", source, path, destinationPath }
{ op: "move", source, path, destinationPath }
{ op: "delete", source, path }
{ op: "copy", source, path, destinationSource, destinationPath }
```

- `rename` requires the same parent; `move` stays within the source.
- `copy` requires a different valid destination source and a Markdown file target.
- Validate source and destination paths independently with the shared validator. For new paths, validate existing parent components and reject existing symlink destinations, including dangling symlinks.
- Success is HTTP 201 for create/copy and HTTP 200 for rename/move/delete, with `{ "op": "...", "source": "Pi", "path": "..." }`. For rename/move/copy, also return `destinationSource` and `destinationPath`.
- Use exclusive/no-overwrite primitives where available, and serialize app mutations with saves. Never intentionally use overwrite semantics for a destination collision.
- Check all eligibility, parent existence, emptiness, and collision conditions before changing disk state. Expected validation failures must leave source and destination untouched.
- Cross-device rename/move may return a safe failure; do not introduce a silent copy-and-delete fallback.
- Mutation requests do not carry content hashes. Content-save conflict protection applies to PUT, not destructive operations; deletion is irreversible within the app and requires explicit confirmation.

### 6.3 Errors and boundaries

Both new endpoints return safe JSON errors with stable machine-readable codes:

```json
{ "code": "HASH_CONFLICT", "error": "This file changed on disk. Reload it or copy your draft." }
```

| Status | Examples |
|---|---|
| 400 | Invalid body/op/source/hash, absolute path, traversal, malformed path, invalid extension, unsupported operation |
| 404 | Missing source target/parent, rejected symlink, unavailable target |
| 409 | `HASH_CONFLICT`, `DESTINATION_EXISTS`, `FOLDER_NOT_EMPTY`, or `NO_CHANGE` |
| 413 | Document/request exceeds a documented size limit |
| 500 | Unexpected filesystem failure |

- Never expose absolute paths, stack traces, or draft content in error responses/log messages.
- Reject traversal, absolute and Windows/UNC paths, backslashes, NULs, invalid components, source escapes, and symlinks at any component, including source roots.
- JSON paths are already path strings: do not URL-decode them. A literal `%` in a filename remains literal.
- A request cannot change the configured root or operate on non-Markdown files.
- Do not add permissive cross-origin access. This remains a localhost tool, not an authenticated remote service.

## 7. Mandatory TDD workflow

Use **Red → Green → Refactor** for every increment. Write and run the smallest relevant failing test before production code; confirm failure is due to missing behavior, implement enough to pass, then refactor with tests green.

Keep a brief handoff record of failing tests, intended failures, and passing commands. Red/green commits are optional; observed test-first evidence is required.

### Increment 1 — Guarded server writes

**Tests first:** API tests using `createApp(tempRoot)`.

Cover exact UTF-8 bytes, empty content, whitespace/CRLF/BOM/no-final-newline preservation, returned hash, stale-hash 409 with unchanged disk bytes, and two concurrent saves using the same hash (only one succeeds).

Cover original mode preservation, non-Markdown temp names, cleanup and original-file integrity on simulated temp-write/chmod/rename failures, and an external disk change during staging. Inject failures deterministically rather than relying on permissions that privileged runners may bypass.

Add invalid-body, missing-file, directory/non-regular target, traversal, source-escape, encoded-looking literal filename, and symlink tests for PUT before implementing its shared validation integration and write pipeline.

### Increment 2 — Editor and explicit save state machine

**Tests first:** pure state/queue tests plus browser interactions.

Cover entry baseline, Edit/Preview, syntax highlighting, unchanged text round trip, no autosave, Save button, Ctrl/Cmd+S, dirty-to-saved status, and keystrokes during an in-flight save.

Use controlled responses to prove:

- Only one request is in flight.
- A second explicit save is queued with its own snapshot.
- The queued request uses the first response's hash.
- Further explicit saves replace the pending slot.
- Unsent later edits never show Saved.
- Failure stops the queue and preserves the latest draft.
- Responses from an abandoned session cannot affect another document.

**Then implement:** editor integration, serialization, and save state machine.

### Increment 3 — Conflict, Revert, and departure

**Tests first:** API and Playwright conflict tests.

- Read a file twice, save using one read, then submit the stale hash; assert 409 and no overwrite.
- From Playwright, open an owned scratch file, edit it, change it using `node:fs`, then Save. Assert conflict, blocked further saves/Revert, and preserved draft.
- Cover Copy draft success and clipboard failure/fallback; Reload cancel, success, and failure.
- Cover Revert after multiple successful saves: it restores the original Edit baseline, not the most recent saved version.
- Cover stale-hash Revert and failed Revert without losing the pre-Revert draft.
- Cover Cancel/Discard for app-controlled navigation, save-pending navigation, supported beforeunload warning behavior, and browser Back after failed Save losing the draft as documented.

**Then implement:** recovery UI and navigation guards. Do not block history to make a test pass.

### Increment 4 — Mutation API

**Tests first:** an API matrix covering every supported operation and both sources.

Cover create defaults, nested parents, uppercase `.MD`, duplicate names across sources, special-character paths, byte-identical cross-source copy/frontmatter, same-source move, rename, and deletion.

For every applicable operation cover:

- Invalid/missing fields, unknown op, nonexistent parent/target, source-root operations, and extension violations.
- Source and destination traversal/absolute paths/source escapes and symlinks, including dangling destinations.
- Existing destination collisions with unchanged source/destination bytes.
- Nonempty folders, including folders containing only hidden/non-Markdown files.
- Concurrent app operations targeting the same destination or a file being saved.
- Case-only rename expectations determined by filesystem probe, not an assumed operating system. Run a real case-insensitive-volume check where available; report missing platform coverage honestly.

**Then implement:** mutation service and route using shared validation and serialized operations.

### Increment 5 — Operation UI and browsing integration

**Tests first:** Playwright journeys for each supported operation in its relevant browsing/document context.

Assert full-path delete confirmation and Cancel, dialog validation/errors, double-submit prevention, dirty active-file refusal, saved-content copy labeling, active-file URL updates, deletion fallback, and create/copy outcomes.

Cover successful operation followed by failed entries refresh: the UI reports operation success separately and offers refresh recovery, not mutation retry.

Verify graph and outline update without resetting unrelated state. Test keyboard interaction, focus return, visible pending/error states, and narrow-screen usability.

**Then implement:** operation dialogs, controls, and listing/navigation reconciliation.

### Increment 6 — Regression and documentation gates

Run all Slice 1/2/3 tests, including encoded URLs, safe HTML/link/image rendering, empty documents, large-document responsiveness, and secure GET reads.

Add regression tests first for any discovered gap. Finish README updates and record final evidence.

## 8. Test isolation

- API tests use temporary fixture roots and remove them on completion/failure.
- Browser tests use the committed fixture root with **one Playwright worker**.
- Never write committed sample files. Each mutation test creates uniquely named `scratch-*` artifacts and removes them in `afterEach`, including on failure.
- Track all renamed, moved, copied, and temporary paths so cleanup covers both sources and every intermediate name.
- Browser conflict tests modify only their own scratch files through `node:fs`.
- Security symlinks belong in temporary API-test roots.
- No external services are needed; simulate network errors, lost/delayed responses, and clipboard failures deterministically.
- Keep the final fixture-cleanliness test; modified or untracked files under `fixtures/` fail the suite.
- Ensure new test files are included in the test scripts; do not assume automatic discovery if the script explicitly lists files.

## 9. Definition of done and handoff

- [ ] Edits persist after explicit Save and reload; there is no autosave.
- [ ] Unchanged content round-trips byte-for-byte, including CRLF/BOM where present.
- [ ] Queued saves cannot overlap, use stale acknowledged hashes, or falsely report Saved.
- [ ] Save failure retains the draft; conflict refuses overwrite and provides Reload/Copy draft.
- [ ] Revert restores the Edit baseline through a hash-checked write and handles failures safely.
- [ ] In-app dirty navigation can be cancelled; supported departures warn; browser-history recovery limits are documented and tested.
- [ ] Every supported operation updates disk and UI correctly; nonempty-folder/recursive operations remain unavailable.
- [ ] Invalid paths, symlinks, source escapes, and destination collisions are rejected by both mutation routes.
- [ ] Atomic replacement preserves original file mode; handled staging failures leave no temporary artifacts.
- [ ] Keyboard, focus, theme, responsive layout, loading, and error states are verified.
- [ ] README describes all four routes, request contracts, root environment variable, editable fixtures, explicit saves/no autosave, copy-frontmatter caveat, and recovery limits.
- [ ] Handoff lists changed files, red/green evidence, final checks, platform gaps, and residual limitations (including the external-writer race).

Required final commands:

```sh
npm run test:unit
npm run test:e2e
npm run lint
npm run build
git status --short -- fixtures/
```

All checks must pass and the final command must report no fixture changes.

**Done means Slice 3 only:** explicit editing and bounded filesystem operations, with tested conflict handling and honest recovery limits—not a collaborative editor or a general-purpose file manager.
