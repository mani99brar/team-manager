# MD Manager — Slice 2 PRD: Select and Preview (TDD)

**Status:** Ready for implementation.

**Prerequisite:** Slice 1 is complete.

**Scope authority:** Slice 2 of `docs/PRD_CHALLENGE_DAY2.md`. This document makes its implementation and testing contracts explicit without including Slice 3.

## 1. Goal

Allow users to open any eligible Pi or Claude Markdown file from the existing graph or outline, read rendered Markdown or exact source text, share its URL, and return to their previous browsing position.

The app remains read-only, single-user, and localhost-only.

## 2. Existing baseline

The completed Slice 1 uses a containment graph and an accessible outline, not folder cards. Preserve both interfaces and their existing behavior.

Relevant implementation locations:

- `src/App.tsx`: application state, loading, navigation, graph/outline selection.
- `src/graph/`: graph, outline, breadcrumbs, layout, and URL/model helpers.
- `server/app.ts`: Fastify `createApp(root)`, source configuration, and `GET /api/entries`.
- `server/app.test.ts`, `tests/unit/model.test.ts`: existing API/model tests.
- `tests/`: Playwright browser tests and fixture-cleanliness gate.

`react-markdown` and `remark-gfm` are already installed. Use them rather than introducing another renderer.

## 3. Included and excluded

### Included

- File activation in graph and outline.
- Dedicated read-only document view.
- File URLs, reloads, browser history, breadcrumbs, and return navigation.
- Rendered and Source tabs.
- Secure `GET /api/file`, returning content and a content hash.
- Explicit loading, empty, missing, and failed-read states.
- API, unit, and browser tests developed test-first.
- README updates.

### Excluded

- Editing, CodeMirror integration, Save, autosave, conflict UI, or draft recovery.
- Create, rename, move, copy, or delete operations.
- `PUT /api/file` and `POST /api/mutate`.
- Relative-image serving or an asset endpoint.
- Following relative document links.
- Search, live agent directories, persistent layout storage, or a permanent two-pane layout.

## 4. User experience requirements

### 4.1 Open a file

- Clicking a file in either graph or outline opens its dedicated document view.
- File actions are keyboard accessible with a meaningful accessible name and visible focus. Enter activates the action; follow native semantics for other keys.
- Dragging/pinning a graph node must not accidentally open the file.
- Files are identified by **source plus relative path**, never filename alone.
- Existing source/folder selection, expansion, pinning, refresh, and outline behavior remain intact.

### 4.2 Document view

- Display the source, full relative path, breadcrumbs, and **Back to folder**.
- Breadcrumbs link to Home, source root, and ancestor folders; the filename is the current, non-navigation item.
- Replace the browsing workspace with the document view; do not add a permanent preview pane.
- **Rendered** is selected when opening a document. **Source** displays the returned text without trimming, formatting, frontmatter removal, or newline normalization.
- Switching tabs does not refetch the file or change its identity. An empty file has an explicit “This file is empty” message separate from its source content.
- Tabs expose selected state and support standard keyboard tab navigation.
- Preserve system light/dark styling, responsive layout, visible focus, and readable overflow for code blocks and tables.
- On opening a document, move focus to its heading or equivalent document entry point. Announce loading and failures accessibly.

### 4.3 URLs and navigation

Use this unambiguous document route while preserving existing folder URLs:

```text
/file/Pi/skills/review.md
/file/Claude/a%20b/c%23d%3F%25.md
```

- Encode each relative-path segment individually. Decode exactly once when parsing a document URL; malformed encoding produces an invalid-link state, not a crash.
- Support spaces, `#`, `?`, `%`, Unicode, nested paths, and identical filenames in different sources.
- Direct links and reloads load the requested document without requiring prior graph selection. The file endpoint, not a cached listing, determines whether a file is readable.
- Back/Forward updates the document or browsing view consistently. Never show a previous file's content under a new file's identity.
- Capture browsing state before opening a file: selected folder/Home, graph versus outline mode, expanded nodes, node positions/pins, graph pan/zoom, outline scroll position, and originating file focus.
- **Back to folder** restores that browsing context during the same page session. Browser Back to the originating browsing entry restores it too. No forced Fit or layout reset on return.
- If no originating browsing context exists (direct link or reload), **Back to folder** opens the file's containing folder and reveals its ancestors. It must not blindly navigate out of the app via browser history.
- Cross-reload restoration of graph layout or scroll position is not required.
- Rapid navigation must cancel or ignore stale requests, including stale errors.

## 5. Markdown rendering and safety

- Use `react-markdown` with `remark-gfm` for tables, task lists, strikethrough, and autolinks, plus normal Markdown headings, lists, links, and fenced code.
- Embedded HTML is disabled and displayed as literal text, not interpreted or silently removed. Do not enable `rehype-raw`, equivalent HTML parsing, or unsafe HTML injection.
- External HTTP/HTTPS links open in a new tab with `rel="noopener"` (adding `noreferrer` is acceptable).
- Relative document links are inert: activating them must not navigate or fetch another document.
- Unsafe URL schemes such as `javascript:` cannot execute. Do not weaken the renderer's URL safety defaults.
- HTTPS images may load. Document in the README that loading remote images contacts third-party servers.
- Relative images show a broken/unavailable-image state with accessible alternative text. Do not fetch them through an application asset route or resolve them against the SPA route.
- Do not implement local image serving in this slice, even if a new test fixture demonstrates a relative image.

## 6. API contract

### `GET /api/file?source=Pi&path=skills%2Freview.md`

Construct query parameters with `URLSearchParams` or equivalent, rather than string concatenation. The query encodes the complete relative-path value; this differs from segment encoding in the document URL.

Successful response: HTTP 200

```json
{
  "source": "Pi",
  "path": "skills/review.md",
  "content": "# Review\n",
  "hash": "<lowercase SHA-256 hex digest>"
}
```

- `source` is exactly `Pi` or `Claude`, matching `/api/entries`.
- `path` is a nonempty, source-relative path using `/` separators.
- Read regular Markdown files only; eligibility is case-insensitive `.md`, matching Slice 1.
- Decode file content as UTF-8 without text transformations. Hash the exact file bytes read for this response using SHA-256; content and hash must come from the same read.
- Empty files succeed with `content: ""` and the SHA-256 digest of empty bytes.
- The hash is reserved for Slice 3's expected-hash writes. No write behavior is introduced here.
- Return `Cache-Control: no-store` so reopening/reloading a file can observe changes on disk.

Errors use `{ "error": "<safe user-facing message>" }`:

| Status | Condition |
|---|---|
| 400 | Missing/invalid/duplicate source or path parameters, malformed path, traversal, or absolute path |
| 404 | Missing file, directory/non-Markdown/non-regular target, or rejected symlink |
| 500 | Unexpected filesystem read failure |

Do not expose absolute filesystem paths, stack traces, or file content in error responses.

### Shared filesystem validator

Introduce one reusable validator for this endpoint and future Slice 3 path-taking routes. Do not implement future routes now.

- The root is fixed at startup via `MD_MANAGER_FIXTURE_ROOT` or the existing default. No request can select a root.
- Map the source allowlist to `pi/` and `claude/`; never use a request source as an arbitrary directory name.
- Reject `..` components before normalization, absolute paths (including Windows/UNC forms), backslashes, NULs, empty components, and `.` components.
- Check containment using resolved filesystem paths, not a naive string-prefix comparison.
- Reject symlinks at the source root, any descendant directory, or the target file. Inspect filesystem components rather than trusting the entries listing.
- Avoid repeated URL decoding. Encoded traversal must not bypass validation; a literal percent-containing filename must still work.
- Test encoded separators explicitly: query-encoded `/` is valid between safe relative components; separators that introduce traversal or an absolute path are not.
- No collision checks are needed for this read-only endpoint; future mutation validation will add filesystem collision probes.

## 7. Loading and failure states

| State | Required behavior |
|---|---|
| Loading | Show a document loading message; do not retain unrelated content under the new path |
| Empty | Show “This file is empty”; Source remains exactly empty |
| Missing | Explain that the file was not found or is unavailable; offer Back to folder |
| Invalid link | Explain that the link is invalid; offer Home/source navigation where possible |
| Failed read/network | Explain that the file could not be loaded; offer Retry and Back to folder |
| Retry succeeds | Replace the error with the current document and hash |

A failed document load must not destroy the saved browsing context. Navigation away during a pending request must not reopen the document when that request finishes.

## 8. Mandatory TDD workflow

Use **Red → Green → Refactor** for each behavior below. Do not implement the entire feature and add tests afterward.

1. Write the smallest relevant test and run it.
2. Confirm it fails for the missing behavior, not a broken test harness or setup failure.
3. Implement only enough production code to pass.
4. Refactor with the relevant tests green.
5. Run existing regression tests before moving to the next increment.

In the implementation handoff/PR, provide a short record of each increment's failing test, intended failure, and passing command. Separate red/green commits are optional; observed red/green evidence is required.

### Increment 1 — Secure reads and hash

**Tests first:** API tests through `createApp(tempRoot)` and Fastify injection.

Cover:

- Both sources; nested paths; duplicate filenames; uppercase `.MD`.
- Empty file, Unicode, spaces, `#`, `?`, and literal `%` in filenames.
- Exact content including leading/trailing whitespace and CRLF; independently calculated SHA-256; changed disk bytes produce a changed hash.
- Missing/invalid/duplicate parameters, missing file, directory, non-Markdown file, and non-regular target.
- Traversal, absolute paths, Windows/UNC paths, encoded traversal/separators, NUL, source-root symlink, intermediate-directory symlink, and target symlink.
- Safe 500 response on a deterministically simulated read error; do not rely solely on permissions that privileged runners may bypass.
- No outside-source content returned, no absolute-path disclosure, and no-store headers on success.

**Then implement:** shared validator, file read/hash helper, and GET route.

### Increment 2 — File URL model

**Tests first:** pure model/parser/serializer tests.

Cover round trips for both sources, nested and special-character names, literal encoded-looking filenames, malformed encoding, invalid sources, parent-folder derivation, and unchanged existing folder routes.

**Then implement:** document location type and URL helpers.

### Increment 3 — Open and return

**Tests first:** Playwright journeys for graph and outline activation, keyboard activation, direct links, reload, Back/Forward, and Back to folder.

Assert browsing state and focus restoration; test direct-link fallback separately. Add a graph drag regression proving drag does not open the document. Use a deliberately delayed response to verify that stale success/error responses cannot replace a newer selection.

**Then implement:** file actions, document shell, request lifecycle, and navigation restoration.

### Increment 4 — Rendered and Source tabs

**Tests first:** browser tests using owned scratch Markdown files.

Cover GFM tables/task lists/strikethrough, fenced code, exact source whitespace/newlines, empty files, tab keyboard interaction, external-link attributes, inert relative links, HTTPS images, and unavailable relative images.

Add a raw-HTML fixture containing an element and an event-handler/script payload. Assert the literal markup is visible, the corresponding DOM element is absent, and nothing executes. This behavioral test must fail if raw-HTML interpretation is enabled through `rehype-raw` or an equivalent.

Intercept HTTPS image requests with Playwright so tests do not depend on public servers.

**Then implement:** renderer configuration, link/image behavior, and accessible tabs.

### Increment 5 — Failure states, performance, and regression

**Tests first:** missing/deleted files, simulated API/network failures, retry, navigation while loading, and loading announcements.

Create a representative Markdown file over 100 KB with headings, lists, code, and tables. On the local Playwright runner, require document visibility within 5 seconds of a successful API response and tab-switch/Back-to-folder completion within 2 seconds each. These are bounded responsiveness checks, not claims about all devices. Avoid fixed sleeps.

**Then implement:** remaining state handling and any performance fixes demonstrated by failing tests.

Finish with all existing Slice 1 tests, lint, build, and README updates.

## 9. Test isolation and commands

- API tests use temporary roots and clean them up even on failure.
- Browser tests use the committed fixture root with **one Playwright worker**.
- Tests read but never modify committed sample files.
- Each test needing files creates uniquely named `scratch-*` artifacts and removes them in `afterEach`, including after failure.
- Security symlinks belong in temporary API-test roots, not the committed fixture tree.
- Keep the final fixture-cleanliness test: modified or untracked files under `fixtures/` fail the suite.
- Test observable behavior; do not couple browser tests to component internals or exact force-layout coordinates.
- Ensure newly added unit/API test files are included in `test:unit`; its current script explicitly lists test files.

Required final commands:

```sh
npm run test:unit
npm run test:e2e
npm run lint
npm run build
git status --short -- fixtures/
```

The final command must report no fixture changes.

## 10. Acceptance and handoff checklist

- [ ] Every existing fixture Markdown file opens from graph and outline.
- [ ] Empty, nested, special-character, and duplicate-name files are covered by tests.
- [ ] Rendered is the default; Source preserves the returned text exactly.
- [ ] File URLs survive direct navigation, reload, and Back/Forward.
- [ ] Return navigation restores the existing browsing context; direct links fall back to the containing folder.
- [ ] API content and SHA-256 match one read; invalid paths and symlinks never disclose outside-source content.
- [ ] GFM works; raw HTML is literal text; unsafe links cannot execute.
- [ ] External links and image behavior match this PRD.
- [ ] Loading, empty, missing, failed-read, retry, and stale-request behavior are tested.
- [ ] The >100 KB responsiveness checks pass.
- [ ] Keyboard, focus, light/dark, and narrow-screen behavior are verified.
- [ ] Slice 1 regressions, new tests, lint, and production build pass; fixtures remain clean.
- [ ] README documents the GET endpoint, file URLs, viewing controls, remote-image privacy note, and deferred relative assets. Remove claims that file viewing is unavailable; editing and autosave remain absent.
- [ ] Handoff lists changed files, red/green evidence, final check results, and any known limitations.

**Done means Slice 2 only:** a tested, secure, read-only document preview built on the completed Slice 1 browser. No editing or mutation functionality is required or authorized by this PRD.
