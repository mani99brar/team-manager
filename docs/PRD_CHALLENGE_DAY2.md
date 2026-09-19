# MD Manager — Challenge Day 2 PRD

## Status and goal

**Status:** Agreed scope, ready for implementation planning. This revision replaces v1 (`PRD_GRILL_DAY2.md`) after review on **2026-09-19**. The original document is retained for reference.

**Goal:** Evolve the existing fixture listing into a folder-style workspace for browsing, previewing, editing, and managing Pi and Claude Markdown files, delivered in three independently reviewable slices:

1. Improved folder UI.
2. File selection and preview.
3. Editing and file operations.

### What changed from v1

- The Chromium prerequisite is removed. Review confirmed that Chromium launches on the VPS and the four existing browser tests pass.
- Autosave is replaced by explicit Save. Conflict detection stays and is tested by simulation.
- The server exposes four routes instead of one per operation. Slice 1 adds no route that accepts a path.
- A failed save followed by browser Back loses the draft. No attempt is made to block browser history.
- Browser tests mutate the committed fixtures under rules that keep the tree clean.
- The relative-image asset endpoint is deferred until a fixture file needs one.

## Scope boundaries

- Access only `fixtures/pi/` and `fixtures/claude/` by default. The root may be overridden by an environment variable for local experiments. No request parameter can change it.
- Identify files by **source plus relative path**.
- Single-user, localhost only.
- No live agent directory integration, search, comparison, synchronization, bulk operations, autosave, or persistent version history.
- Every path the server accepts passes through one shared validator. It resolves the path inside the source root, rejects `..`, absolute paths, and symlinks at any component, and probes the filesystem for collisions rather than comparing strings.
- Fixture files are editable test data. Tests may create, modify, and delete files under `fixtures/` subject to the testing rules below.

## API surface

Four routes. Only three accept a path, and all three share the validator above.

| Route | Slice | Purpose | Accepts a path |
|---|---|---|---|
| `GET /api/entries` | 1 | Flat list of every eligible file and directory in both sources, with kind | No |
| `GET /api/file` | 2 | Content plus content hash for one file | Yes |
| `PUT /api/file` | 3 | Write content with expected hash; return 409 on mismatch | Yes |
| `POST /api/mutate` | 3 | Create, rename, move, delete, or copy, selected by an `op` field | Yes |

The existing `GET /api/files` is replaced by `/api/entries`. The client builds the folder tree from the flat list, so refresh is a refetch of one call.

## Slice 1 — Folder UI

Replace the table with a folder browser built on the client from the flat entries list.

### Requirements

- `GET /api/entries` returns every Markdown file and directory in both sources as a flat list with `source`, `path`, and `kind`. Directories are included so empty folders are navigable. Symlinks and non-Markdown files are excluded.
- Home shows **Pi** and **Claude** source cards.
- A breadcrumb bar navigates, for example, `Home / Pi / skills`. The current folder is stored in the URL with each segment encoded.
- The view shows the current directory's immediate contents, folders first, alphabetical within each group.
- Manual refresh refetches the entries list. Source navigation replaces a separate source filter.
- Minimal developer-tool styling, system light and dark theme, and responsive layout.
- Keyboard navigation, visible focus indicators, and loading, empty, and error states.
- No search and no permanent two-pane layout.

### Acceptance criteria

- Users can navigate both fixture trees through cards and breadcrumbs.
- Empty directories appear and remain navigable.
- Non-Markdown files do not appear as cards.
- Refresh updates the displayed contents after a file is added on disk.
- Nested paths and duplicate filenames across sources remain unambiguous.
- A folder URL with encoded characters reloads to the same folder.
- The entries list for a copy of a real agent tree of several hundred files renders without visible delay.

## Slice 2 — Select and preview

Selecting a Markdown file opens a dedicated document view served by `GET /api/file`.

### Requirements

- The document view shows source, relative path, breadcrumbs, and **Back to folder**. Back restores the previous folder position.
- Selection lives in the URL with every path segment encoded, so direct links, reloads, and browser history work for filenames containing `#`, `?`, `%`, or spaces.
- Rendered Markdown is the default tab. A **Source** tab shows the exact text.
- GitHub-flavored Markdown via `remark-gfm`.
- Embedded HTML stays disabled. This is `react-markdown`'s default; a test asserts that `rehype-raw` or an equivalent is not enabled.
- External links open in a new tab with `rel="noopener"`.
- HTTPS images load. Remote images contact third-party servers when loaded.
- Relative images and the restricted asset endpoint are deferred until a fixture file contains one. Until then, a relative image shows the broken-image state.
- Relative document links are inert.
- `GET /api/file` returns content and a content hash. The hash is what Slice 3 sends back on write.
- Empty file, missing file, and failed read each show an explicit message.

### Acceptance criteria

- Every fixture Markdown file opens, including empty and nested files.
- Rendered and Source tabs represent the selected file exactly.
- Direct links and back and forward navigation work, including for encoded paths.
- A path with `..`, an absolute path, or a symlink returns 400 or 404 from `GET /api/file`, never content from outside the source.
- A raw HTML block in a fixture file renders as escaped text, not as an element.
- A file over 100 KB renders without freezing the tab.

## Slice 3 — Editing and file operations

Editing is explicit, saves are explicit, and every content write is guarded by a content hash.

### Editing and saving

- Enter editing through an **Edit** action. Use CodeMirror with Markdown syntax highlighting and **Edit** and **Preview** tabs.
- Save on Ctrl/Cmd+S or a **Save** button. There is no autosave.
- Each save sends the hash received on read or on the last successful save. At most one save is in flight; a second request while one is pending is queued and sent with the hash returned by the first.
- Status shows **Unsaved**, **Saving**, **Saved**, or **Error**. Saved appears only when the acknowledged content equals the current buffer.
- In-app navigation with unsaved changes shows a confirm dialog that can cancel the navigation.
- Browser departure with unsaved changes triggers the `beforeunload` warning where supported.
- Browser Back after a failed save loses the draft. No attempt is made to intercept history.
- No automatic formatting. Unchanged text is written byte for byte.

### Conflict protection and recovery

- `PUT /api/file` compares the expected hash with the file on disk and returns 409 on mismatch without writing.
- On 409, the editor refuses further saves, shows the conflict, and offers **Reload** and **Copy draft**.
- **Revert** restores the content captured when Edit began and goes through the same hash check.
- Writes go to a temp file in the same directory whose name does not end in `.md`, copy the original's mode with `fstat` and `chmod`, then rename over the original.
- No persistent backups or revision history.

### File operations

All operations use `POST /api/mutate` and remain within the configured fixture sources:

- Create Markdown files and folders.
- Rename, move, and delete Markdown files.
- Rename, move, and delete empty folders.
- Copy an individual Markdown file between Pi and Claude sources. Frontmatter is copied as is; the target agent may not accept it.
- Delete confirms with the full source and path.
- Destination collisions are detected by filesystem probe and rejected, which makes case-only renames behave correctly on both Linux and macOS.
- An operation that moves, renames, or deletes the active file is refused while it has unsaved changes.
- No recursive folder operations, bulk actions, or image uploads.

### Acceptance criteria

- Edits survive reload after Save.
- Two rapid saves cannot produce out-of-order writes or a false Saved.
- A failed save keeps the draft and shows recovery guidance.
- A file changed on disk while open produces a 409 and a conflict view, never an overwrite.
- Revert restores the baseline when the hash check passes and shows a conflict when it does not.
- Each supported operation updates the folder view correctly.
- Invalid paths, source escapes, symlinks, and collisions are rejected by every mutation.
- File mode survives a write.

**Recovery limits:** Abrupt browser closure and browser Back after a failed save lose pending changes. Deleted files have no built-in recovery beyond git for the fixtures.

## Testing rules

Browser tests run against the committed fixtures and may mutate them. These rules keep the tree clean between runs:

- Playwright stays at one worker so mutations never overlap.
- Each mutation test creates its own uniquely named file or folder and removes it in `afterEach`, including on failure.
- The committed sample files are read but never written by tests.
- Conflict tests write the open file from the test process with `node:fs`, then save from the browser and assert the 409 conflict view. API tests do the same with two reads and a stale hash.
- Traversal tests send `..`, absolute paths, encoded separators, and a symlink created in a temp fixture root against every path-taking route.
- The test suite ends by asserting that git reports no modified or untracked files under `fixtures/`, so a leaked artifact fails the run instead of poisoning the next one.
- API tests use `createApp` with a temp root. Browser tests use the real fixture root.

## Delivery and quality gates

Each slice is independently reviewable and includes:

- Relevant API and browser tests, including the testing rules above.
- Keyboard-accessible interactions.
- Loading, empty, and failure-state coverage.
- Passing lint and production build.
- README updates. Across the three slices, the README gains the four-route table, the fixture root environment variable, the note that fixtures are editable test data, and the statement that autosave is intentionally absent.

### Recommended design check before Slice 1

Copy `~/.claude` to a scratch folder, point the app at the scratch data with the fixture root environment variable, and spend ten minutes navigating. Use a copy, not the live directory.

The fixtures hold 5 files at depth 2; the real tree reported in review holds 265 files across 150 folders at depth 10. This run is the cheapest check on the card and breadcrumb design.
