# Slice 3 handoff — Editing and file operations

Implements `docs/PRD_SLICE3.md` on top of the completed Slice 2 baseline (commit `03a6fb8`). Work in progress; each increment below records the observed failing run (Red), the intended failure, and the passing command (Green). Test-authoring mistakes are listed separately and do not count as product Reds.

Test ports: the development servers on 5173/3001 stayed running; browser runs used `MD_MANAGER_WEB_PORT=5184 MD_MANAGER_API_PORT=3014`.

## Increment 1 — Guarded server writes (`PUT /api/file`)

| Step | Command | Observed |
|---|---|---|
| Red | `npx tsx --test server/write.test.ts` | **15 failed / 0 passed**. Every request returned Fastify's route-not-found 404 (`actual: 404, expected: 200/400/409`), i.e. the route did not exist. |
| Green | same command | **15 passed**. `npm run test:unit` → **63 passed** (48 existing + 15). `npx tsc -b` and `npx eslint .` clean after one typing fix in the Fastify error handler. |

Coverage: exact UTF-8 bytes and returned hash; empty/whitespace/CRLF/BOM/no-final-newline/frontmatter preservation; two reads then a stale-hash 409 with unchanged bytes; external change invalidating the acknowledged hash; two concurrent saves with the same hash (exactly one 200, one 409, file holds the winner); mode preservation for 0600/0640/0664/0755; exclusive temp create in the same directory via `/proc/self/fd`, never ending in `.md`, no artifact on success, all descriptors closed; injected `writeFile`, `chmod` and `rename` failures (safe 500 `WRITE_FAILED`, original bytes and mode intact, temp removed, retry works); external change during staging detected before rename (409, external bytes kept, no temp); invalid bodies (array/string/null JSON, missing/typed fields, malformed hash forms, traversal/absolute/backslash/NUL/drive/UNC/trailing slash, malformed JSON, wrong media type) with stable codes and no disk change; never-create and 404 for missing/directory/non-Markdown/socket/symlinked targets including a symlinked source root, with outside bytes untouched; literal `%2e%2e.md` and special-character names; >200 KB save and 9 MiB body → 413 `REQUEST_TOO_LARGE` with the file unchanged; committed fixtures never written.

## Increment 2 — Editor and explicit save state machine

| Step | Command | Observed |
|---|---|---|
| Red (unit) | `npx tsx --test tests/unit/editSession.test.ts` | Suite failed to load: `ERR_MODULE_NOT_FOUND … src/document/editSession.ts`. |
| Red (browser) | `MD_MANAGER_WEB_PORT=5184 MD_MANAGER_API_PORT=3014 npx playwright test tests/edit.spec.ts` | **8 failed / 0 passed**: no Edit control existed (`element(s) not found` for the Edit button in every test). |
| Green (unit) | `npx tsx --test tests/unit/editSession.test.ts` | **11 passed** (state machine + line-ending serialization). |
| Green (browser) | same browser command | **8 passed**. Full suite `npx playwright test` (same ports) → **61 passed** after the regression fix below; `npx eslint .`, `npx tsc -b` clean. |

Product defects found by the red tests during implementation:

- Saves never settled in the dev build: a liveness ref was set to `false` by React StrictMode's simulated unmount and never reset (status stuck on Saving). Fixed by re-establishing liveness on every mount.
- Fast typing lost characters (`typed` → `tped`, `# Was empty` → `#Was empty`): a draft-sync effect replaced the editor text from a render that lagged behind CodeMirror. Replaced by a one-way flow (editor → session) plus an explicit `generation` counter that only replaces the editor text on Revert success or Reload.
- Slice 2 regression caught by the full suite (6 failures in `document-failure`, `document-review`, `document.spec`): the rewritten `DocumentView` dropped the tablist/tabpanel during loading and error states. Restored; the editing session replaces the tabs only when editing.

Test-authoring fixes (not product Reds): ambiguous loading-text locator; `Text.replace` needs a `Text`; DOM types under the tests tsconfig; a `next()` helper that handed out an already-consumed request; a `once` keydown listener consumed by the Control key; an un-awaited listener install racing the key press; Backspace sent while focus was on the Save button; `innerText` of the editor contains line breaks; graph node click blocked by the canvas background for an off-screen scratch node (the test uses the outline).

## Increment 3 — Conflict, Revert and departure

The API half (two reads, a save with one, then the stale hash → 409 with unchanged bytes) is covered by `server/write.test.ts` from Increment 1.

| Step | Command | Observed |
|---|---|---|
| Red | `MD_MANAGER_WEB_PORT=5184 MD_MANAGER_API_PORT=3014 npx playwright test tests/edit-recovery.spec.ts` | **8 failed / 2 passed**. Intended failures: no confirm dialogs for Reload/Revert/Discard (`getByRole('dialog')` not found), no clipboard fallback textbox, no in-app navigation guard (URL changed without a prompt), no save-pending refusal notice, the document hash did not follow a Reload. The two passing tests (conflict blocks Save/Revert and keeps the draft; browser Back after a failed save loses the draft) were already satisfied by the Increment 2 state machine and count as regression coverage, not Reds. |
| Green | same command | **10 passed**; `-g 'stale or failed Revert|Reload asks' --repeat-each=5` → 10 passed. Full suite → **70 passed**, fixtures clean. |

Product defects found by the red tests: focus did not return to the invoking button after Cancel because the native dialog was closed after React detached it (now a layout-effect cleanup that closes and refocuses the opener); a second dropped-keystroke race after Reload, because the editor replacement ran in a passive effect after paint (now a layout effect, with the latest-props ref updated in a layout effect ahead of it).

Test-authoring fixes: a held-then-fallback route that let the "failed" Revert reach the real server; `page.reload()` hangs when the beforeunload prompt is dismissed (the test now triggers `location.reload()` from the page and waits for the dialog event); an ambiguous clipboard-unavailable locator.

## Increment 4 — Mutation API (`POST /api/mutate`)

| Step | Command | Observed |
|---|---|---|
| Red | `npx tsx --test server/mutate.test.ts` | **15 failed / 0 passed**, every request returned route-not-found 404. |
| Green | same command | **15 passed**; `npm run test:unit` → **89 passed**; `npx tsc -b`, `npx eslint .` clean. |

Test-authoring fix: a "create-folder over file" case used a `.md` folder name, which is rejected lexically (400) before any probe; replaced with a plain-named existing file and a directory named like a file for the create-file collision.

Platform note: the fixture filesystem here is ext4 (case-sensitive), so the real case-only rename succeeds. The case-insensitive branch (probe reports an entry → 409 without overwriting) is exercised by mocking `fs.lstat` for the destination spelling; no real case-insensitive volume was available (casefold requires root/`tune2fs`), so that platform coverage is simulated, not observed.

## Increment 5 — Operation UI and browsing integration

| Step | Command | Observed |
|---|---|---|
| Red | `MD_MANAGER_WEB_PORT=5184 MD_MANAGER_API_PORT=3014 npx playwright test tests/operations.spec.ts` | **8 failed / 0 passed**: every journey timed out waiting for the New file/New folder/Rename/Move/Delete/Copy controls, which did not exist. |
| Green | same command | **8 passed** after the implementation (client mutation API, shared native modal, one operation dialog, File operations toolbar, document-header controls, post-operation navigation and listing refresh with a separate outcome banner). |

Design decision made while implementing: operation outcomes are shown in a visible banner (`data-testid="operation-outcome"`) and also announced, because opening a created file immediately announces its own loading state; the tests assert the banner. Refusals for a dirty/conflicted/pending active file are an inline alert with an explanation, rather than disabled buttons, so keyboard and screen-reader users can discover why.

Test-authoring fixes: unrouting a held route while its handler was still pending (`Route is already handled`); a case-sensitive substring; a disk check that ran before the delete response had arrived.

## Increment 6 — Regression and documentation gates

Discovered gap (regression test first): the full suite after Increment 5 failed **3** Slice 1/2 tests (`document-failure` retry, `document.spec` drag and stale-response tests) with `<div class="app"> intercepts pointer events`. Cause: the new File operations toolbar stacked under the graph controls, shrinking the canvas so nodes fell below the visible workspace. Fix: both toolbars share one wrapping row. The three existing tests are the regression coverage; `npx playwright test tests/document-failure.spec.ts tests/document.spec.ts tests/graph.spec.ts` → 27 passed after the fix.

## Changed and added files

| Area | Files |
|---|---|
| API | `server/files.ts` (`RequestError` with stable codes, `validateEntryPath`, exported descriptor helpers, `MutationQueue`, `writeMarkdownFile` atomic hash-guarded replace), `server/mutations.ts` (new: body parsing, create/rename/move/delete/copy with probes and exclusive primitives), `server/app.ts` (`PUT /api/file`, `POST /api/mutate`, 8 MiB body limit, JSON error handler) |
| Client editing | `src/document/editSession.ts` (pure save/queue/conflict/revert state machine), `src/document/serialize.ts` (line-ending/BOM analysis, lossless CodeMirror round trip, hash check), `src/document/useEditSession.ts`, `src/document/Editor.tsx` (CodeMirror, Edit/Preview, status, Ctrl/Cmd+S, beforeunload), `src/document/EditingSession.tsx` (Reload/Revert confirmations, Copy draft fallback), `src/document/ConfirmDialog.tsx`, `src/ui/Modal.tsx`, `src/document/api.ts` (`saveDocument`), `src/document/DocumentView.tsx` (Edit button, editability, acknowledged-content override, operation buttons) |
| Operations | `src/operations/api.ts`, `src/operations/validate.ts`, `src/operations/OperationDialog.tsx`; `src/App.tsx` (navigation guards, discard dialog, pending-save refusal, File operations toolbar, post-operation navigation/refresh, outcome banner); `src/App.css`, `src/index.css` |
| Tests | `server/write.test.ts`, `server/mutate.test.ts`, `tests/unit/editSession.test.ts`, `tests/edit.spec.ts`, `tests/edit-recovery.spec.ts`, `tests/operations.spec.ts` (all new); `package.json` (`test:unit` lists the new files; `@lezer/highlight` declared as a direct dependency, it was already installed transitively) |
| Docs | `README.md`, this handoff |

## Platform gaps and residual limitations

- **Linux only** (inherited): descriptor-relative operations need procfs. Writes and mutations use the same `/proc/self/fd` walk; no pathname fallback exists.
- **External-writer race**: the hash check, the post-staging re-check and the final `rename` are not one atomic step. An outside writer that changes the file between the last re-check and the rename is not detected. App-side requests are fully serialized, and stale hashes are always rejected.
- **Collision probes**: `create-*` and file rename/move use exclusive primitives (`O_EXCL`, `mkdir`, `link`); folder rename/move relies on the `lstat` probe plus serialization, so an outside process creating the destination between probe and `rename` could be overwritten. Cross-device moves fail rather than copy-and-delete. Filesystems that forbid hard links make file rename/move fail safely.
- **Case-insensitive volumes**: not available on this runner; the refusal branch is verified only through a mocked probe.
- **Lossless editing** is refused for mixed/bare-CR line endings and invalid UTF-8; such files remain read-only.
- **Drafts** live only in the page session: browser Back/Forward, reload and closure lose them (beforeunload warns where the browser allows); a request already in flight may still complete. Deleted files have no recovery beyond git.
- The production bundle now exceeds Vite's 500 kB chunk warning because of CodeMirror; it is a warning, not a failure, and no code splitting was added in this slice.

## Final checks (2026-09-20)

The development servers on 5173/3001 kept running untouched; test runs owned 5184/4184 and 3014. The unit suite must not run concurrently with the browser suite (its committed-fixture listing test sees scratch files).

```sh
npm run test:unit
# 89 tests, 0 failures
npm run lint
# clean
npm run build
# tsc -b + vite build OK (chunk-size warning from CodeMirror, not an error)
MD_MANAGER_WEB_PORT=5184 MD_MANAGER_API_PORT=3014 npm run test:e2e
# 78 passed, one worker, dev frontend
MD_MANAGER_TEST_PREVIEW=1 MD_MANAGER_WEB_PORT=4184 MD_MANAGER_API_PORT=3014 npm run test:e2e
# 78 passed, one worker, built preview frontend
git diff --check
# clean
git status --short -- fixtures/
# empty
```

Honesty note: the first full dev-mode run of the final gate had **1 failed / 77 passed** (`operations.spec.ts` "New file …", after 6.4 s, not a timeout). Its diagnostics were overwritten by the following preview run. The test then passed 5/5 when repeated in isolation and the complete dev suite was rerun with full output captured and passed **78/78**, so the failure is recorded as an unreproduced flake, not as resolved. The suspected area is the held-route double-submit section of that test.

Definition of done (PRD §9): every item is covered by the tests above; README documents all four routes, request contracts, `MD_MANAGER_FIXTURE_ROOT`, editable fixtures, explicit saves/no autosave, the 8 MiB request limit, the copy-frontmatter caveat and the recovery limits. No commits, stashes or pushes were made.
