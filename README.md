# MD Manager

Free-form graph explorer, document viewer and explicit-save Markdown editor for the Pi and Claude fixture folders, with bounded create/rename/move/delete/copy operations. Built with React, Vite, Fastify, TypeScript, d3-force, react-markdown and CodeMirror.

## Start

Requires **Linux with procfs mounted at `/proc`**, Node.js 22.12+ (tested with 24), and npm. The backend fails closed at startup without Linux/procfs descriptor access; macOS/Windows backends are not currently supported (Linux-only scope approved for Slice 2).

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5173. This starts Vite and the Fastify API together; Ctrl-C stops both. The API listens on http://127.0.0.1:3001 and Vite proxies `/api` requests to it. Everything is single-user and localhost-only.

To preview the production frontend, run `npm run build`, then `npm run start:api` in one terminal and `npm run preview` in another (http://127.0.0.1:4173). Both Vite modes serve malformed document direct links/reloads to the app’s invalid-link UI without changing the URL.

## Checks

```sh
npx playwright install chromium  # first-time browser setup
npm test        # API + model unit tests, then the browser suite
npm run lint
npm run build
```

`npm run test:unit` runs the API tests (temporary fixture roots covering nested and empty directories, uppercase `.MD`, ignored extensions, symlink exclusion, source failures, the `GET /api/file` validator: traversal, absolute and Windows/UNC paths, encoded separators, NULs, symlinks at every level, non-Markdown targets and simulated read failures; the `PUT /api/file` write pipeline: byte preservation, stale-hash and concurrent-save conflicts, mode preservation, injected write/chmod/rename failures, external changes during staging, size limits; and the `POST /api/mutate` matrix: every operation in both sources, collisions including dangling symlinks, nonempty folders, source escapes, concurrency), the pure graph-model, document URL and edit-session state-machine tests. `npm run test:e2e` starts the app against the committed fixtures on a single Playwright worker with reduced motion, so the layout settles instantly and no test depends on animation timing. Browser tests that need Markdown content create `scratch-*` files and remove them afterwards; HTTPS image requests are intercepted so nothing depends on public servers.

### Isolated test ports and final Slice 2 evidence

`MD_MANAGER_WEB_PORT` and `MD_MANAGER_API_PORT` override the default web/API ports (5173 dev, 4173 preview, 3001 API). Pick **free** ports; do not stop or reuse another development server. Vite uses `strictPort`, and Playwright starts/checks both owned servers with `reuseExistingServer: false` and one worker. Set `MD_MANAGER_TEST_PREVIEW=1` to test the built frontend instead of dev serving; build first.

Validated on 2026-09-19, using these free ports while existing 5173/3001 servers remained running:

```sh
npm run test:unit  # 47 passed
MD_MANAGER_WEB_PORT=5184 MD_MANAGER_API_PORT=3014 npm run test:e2e  # 50 passed
npm run lint
npm run build
MD_MANAGER_TEST_PREVIEW=1 MD_MANAGER_WEB_PORT=4184 MD_MANAGER_API_PORT=3014 npm run test:e2e  # 50 passed
git diff --check
git status --short -- fixtures/  # empty
```

These are example environment overrides, not hardcoded alternate defaults. See `docs/HANDOFF_SLICE2.md` for observed red/green corrections and the limitations of the earlier historical TDD evidence.

### Fixture testing rules

- Browser tests use the default fixture root. Never modify the committed sample files.
- Tests that need changes on disk create uniquely named `scratch-*` artifacts under `fixtures/pi/` or `fixtures/claude/` and remove them in `afterEach`, including on failure. Editing and operation tests only ever save, rename, move, delete or copy their own scratch files; conflict tests change those scratch files through `node:fs`.
- The last spec (`tests/zz-fixtures-clean.spec.ts`) asserts that `git status` reports no modified or untracked files under `fixtures/`.

## API

### `GET /api/entries`

```json
{
  "entries": [
    { "source": "Pi", "path": "skills", "kind": "directory" },
    { "source": "Pi", "path": "skills/review.md", "kind": "file" },
    { "source": "Claude", "path": "workflow.md", "kind": "file" }
  ]
}
```

- `source` is `"Pi"` or `"Claude"`; `path` is relative to that source and uses `/`; `kind` is `"directory"` or `"file"`.
- Every eligible descendant of both sources is returned as one flat list in deterministic pre-order (Pi first, then Claude; byte-wise name order within each directory). Source roots are implicit.
- The endpoint accepts no path or root parameter; query strings are ignored.
- Discovery failures (a missing, unreadable or symlinked source) return HTTP 500 with `{ "error": "..." }` naming the failing source but never an absolute path. There is no partial listing.

The client builds the whole graph from this one response: expanding folders needs no further requests, and Refresh performs exactly one refetch. The listing never reads file contents; a document is fetched only when it is opened.

### `GET /api/file?source=Pi&path=skills%2Freview.md`

Reads are anchored to a fixture-root descriptor opened at startup. Each allowlisted source and intermediate directory is opened relative to its retained parent descriptor via `/proc/self/fd`, with `O_NOFOLLOW | O_DIRECTORY`; the final target uses `O_NOFOLLOW | O_NONBLOCK`, a regular-file `fstat`, and a descriptor read. Concurrent symlink replacement therefore cannot redirect the read; it either reads the pinned original or reports unavailable. All request handles close on success/failure. The configured fixture-root path and its ancestors are trusted startup configuration (ancestor symlinks may be resolved there); the fixture root itself and all source/descendant components must not be symlinks. No request chooses that root.

Missing/disappeared/rejected targets return safe 404 errors; unexpected metadata/read failures return safe 500 errors. Neither error includes absolute paths or file contents. The existing listing is not used as a security check.

```json
{
  "source": "Pi",
  "path": "skills/review.md",
  "content": "# Review\n",
  "hash": "<lowercase SHA-256 hex digest of the file bytes>"
}
```

- `source` is `"Pi"` or `"Claude"` and `path` is the complete source-relative path with `/` separators, both passed as ordinary query parameters (build them with `URLSearchParams`; the value is decoded exactly once, so a literal `%` in a filename works). Each parameter must appear exactly once.
- Only regular files whose name ends in `.md` (case-insensitive) are readable. `content` is the file decoded as UTF-8 with no trimming, newline normalisation or frontmatter removal; `hash` is the SHA-256 of the exact bytes of that same read. An empty file returns `""` and the digest of empty input.
- Responses carry `Cache-Control: no-store`, so reopening or reloading a file always reflects the disk. The hash is the `expectedHash` for `PUT /api/file`.
- Errors are `{ "error": "..." }`: **400** for missing, duplicate or non-string parameters, an unknown source, an empty path, `..` or `.` components, empty components, backslashes, NULs, absolute paths (including `C:` and UNC forms); **404** for a missing file, a directory, a non-Markdown or non-regular target, or a symlink; **500** for an unexpected read failure. Error bodies never contain absolute paths, stack traces or file content.

### `PUT /api/file`

Hash-guarded content write of an existing Markdown file. There is no implicit create.

```json
{ "source": "Pi", "path": "skills/review.md", "content": "# Updated review\n", "expectedHash": "<SHA-256 from the last read or successful write>" }
```

Success is HTTP 200 with `{ "source": "Pi", "path": "skills/review.md", "hash": "<SHA-256 of the bytes written>" }` and `Cache-Control: no-store`.

- The body must be a JSON object with a valid source, a shared-validator path, a string `content` and a 64-character lowercase hexadecimal `expectedHash`. `content` is written as UTF-8 with no trimming, newline or frontmatter changes.
- The target must be an existing regular `.md` file reached through the same descriptor walk as reads (symlinks at any component are refused). The current bytes are read and hashed first; a mismatch returns **409 `HASH_CONFLICT`** and the file is untouched.
- Writes are staged in an exclusively created temp file in the same directory (its name never ends in `.md`), which receives the original file's permission mode via `fstat`/`fchmod`, is written and synced, then renamed over the original after the original's identity and bytes are re-checked. Handled failures remove the temp file and leave the original bytes and mode intact. Ownership, timestamps, ACLs and extended attributes are not preserved.
- App requests are serialized through one process-local queue, so two saves carrying the same hash cannot both succeed. This is **not** an OS-wide compare-and-swap: an external writer racing between the final re-check and the rename is not detected.
- Request bodies are limited to **8 MiB**; larger requests return **413 `REQUEST_TOO_LARGE`** without touching the file. Documents well over 100 KB save normally.

### `POST /api/mutate`

One discriminated JSON request per operation. Every path is source-relative and validated by the shared validator; paths are literal (never URL-decoded).

```text
{ "op": "create-file",   "source": "Pi", "path": "skills/new.md", "content": "" }   // content optional, default ""
{ "op": "create-folder", "source": "Pi", "path": "skills/topics" }
{ "op": "rename",        "source": "Pi", "path": "skills/new.md", "destinationPath": "skills/renamed.md" }
{ "op": "move",          "source": "Pi", "path": "skills/renamed.md", "destinationPath": "archive/renamed.md" }
{ "op": "delete",        "source": "Pi", "path": "skills/topics" }
{ "op": "copy",          "source": "Pi", "path": "skills/review.md", "destinationSource": "Claude", "destinationPath": "imported/review.md" }
```

Success is **201** for `create-file`, `create-folder` and `copy`, **200** for `rename`, `move` and `delete`, with `{ "op", "source", "path" }` plus `destinationSource` and `destinationPath` for rename/move/copy.

- `create-file` needs a `.md` name and an existing parent (parents are never created implicitly); `create-folder` needs a name that does not end in `.md`.
- `rename` keeps the same parent; `move` stays within the source and needs an existing destination parent; a folder cannot move into itself. Files keep a `.md` name, folders never take one. Identical source and destination is **409 `NO_CHANGE`**.
- `rename`, `move` and `delete` accept a regular Markdown file or an **empty** directory. Emptiness is checked on disk at execution and counts hidden and non-Markdown entries: **409 `FOLDER_NOT_EMPTY`**. Nothing recurses.
- `copy` duplicates the saved bytes of one Markdown file (mode included) into the other source only.
- Source roots (empty path) are never targets. Symlinks anywhere in a source or destination path are refused (404).
- No operation overwrites: the destination is probed on disk (`lstat`, so dangling symlinks count as occupied) and creation uses exclusive primitives; file renames use `link` + `unlink`, which fails atomically on an existing name. Existing entries return **409 `DESTINATION_EXISTS`**. A case-only rename therefore succeeds on a case-sensitive filesystem and is refused on a case-insensitive one, without overwriting either way.
- Mutations carry no content hash: deletion is irreversible within the app and the UI requires explicit confirmation. Cross-device moves fail safely rather than falling back to copy-and-delete.

### Errors

Both write routes (and `GET /api/file`) return `{ "code": "...", "error": "..." }` with stable codes: **400** `INVALID_BODY`, `INVALID_OP`, `INVALID_SOURCE`, `INVALID_PATH`, `INVALID_CONTENT`, `INVALID_HASH`; **404** `NOT_FOUND`; **409** `HASH_CONFLICT`, `DESTINATION_EXISTS`, `FOLDER_NOT_EMPTY`, `NO_CHANGE`; **413** `REQUEST_TOO_LARGE`; **415** `UNSUPPORTED_MEDIA_TYPE`; **500** `READ_FAILED`, `WRITE_FAILED`, `MUTATION_FAILED`. Messages never include absolute paths, stack traces or document content. There is no cross-origin access; the API is a localhost tool.

### Filesystem boundary

Every route that takes a path uses one shared validator (`server/files.ts`): the request source is mapped to `pi/` or `claude/` (never used as a directory name), the relative components are rejected before any normalisation if unsafe, containment is checked on the resolved path, and the real filesystem is then walked from the source root to the target so that a symlinked source root, intermediate directory or target file is refused rather than followed.

- Sources default to `fixtures/pi/` and `fixtures/claude/`, resolved from the server module rather than the shell's working directory.
- `MD_MANAGER_FIXTURE_ROOT=/path/to/root` points the API at another root for local experiments. The root must contain `pi/` and `claude/` subdirectories. It is read once at startup; no request can change it.
- Regular `.md` files (case-insensitive) and directories, including empty ones, are included. Symlinks, whether files or directories, are skipped and never followed. Other file types are ignored.

## Graph explorer

The page shows a header with Refresh, a breadcrumb bar (Home / source / folder …), a toolbar, the graph canvas and a legend.

- **Nodes**: large circles are the Pi and Claude sources, folder shapes are directories and small document shapes are Markdown files. Activating a file node (click, Enter or Space) opens it in the document view; dragging a file node only pins it.
- **Edges** always mean *contains*, drawn from parent to child with an arrowhead. Pi and Claude are never connected to each other and no reference or dependency edges are inferred.
- **Expand / collapse** with the `+` / `−` control on each source or folder node. Expanding reveals immediate children beside their parent; collapsing hides all descendants and forgets their expansion state. Empty folders stay visible and are marked *empty*.
- **Select** a source or folder by clicking its body. The breadcrumb, folder/file counts and URL update, and its containment edges are highlighted. Selection and expansion are separate.
- **Drag** any node to pin it where you drop it; a pin badge appears, and pressing the badge unpins it. Pins survive selection changes and refreshes for as long as the node exists (until Reset or a page reload).
- **Toolbar**: `+` / `−` zoom, **Fit** frames all visible nodes, **Reset** clears pins and expansion and returns to Home, **Outline** switches to the outline view. The mouse wheel, pointer/touch drag on the background and two-finger pinch also pan and zoom. Zoom is bounded.
- **URLs**: the selected folder is stored in the path with every segment encoded (`/Claude/a%20b/c%23d`), so direct links, reloads and browser back/forward work, including names with spaces, `#`, `?` or `%`. Opening a folder link reveals its ancestors, expands it and scrolls it into view. Unknown folders show an explanation with links to the source root and Home. Documents use `/file/<source>/<segments…>` (see below).
- **Refresh** refetches the listing while keeping selection, expansion and positions. New entries appear under expanded parents, removed entries disappear, and if the selected folder is gone the missing-folder state is shown. If the refresh fails, the previous graph stays and is labelled as possibly outdated.
- The layout is a force-directed simulation with collision avoidance; it settles after each change instead of moving continuously and never auto-fits after interactions. Light/dark theme follows the system preference, and reduced-motion preferences make layout changes instant.

## Document view

Opening a file from the graph or the outline replaces the browsing workspace with the document view. There is no permanent preview pane.

- **Identity**: the heading shows the filename and the line below it the source and full relative path, so `workflow.md` in Pi and in Claude are never confused. Breadcrumbs link to Home, the source root and each ancestor folder; the filename is the current item and not a link.
- **URLs**: `/file/Pi/skills/review.md`, `/file/Claude/a%20b/c%23d%3F%25.md`. Every path segment is encoded individually and decoded exactly once, so spaces, `#`, `?`, `%`, Unicode and nested paths survive direct links, reloads and Back/Forward. A malformed link shows an invalid-link explanation with links to Home and the source roots. Whether a file is readable is decided by `GET /api/file` at open time, never by a cached listing.
- **Rendered / Source tabs**: Rendered is selected whenever a document is opened. Source shows the returned text exactly, including leading and trailing whitespace, CRLF line endings and frontmatter. Switching tabs never refetches. An empty file shows “This file is empty.” on both tabs, with an exactly empty Source. The tabs are a standard tablist (Arrow keys, Home and End move between them; only the selected tab is in the Tab order).
- **Back to folder** restores the browsing context from before the file was opened, during the same page session: selected folder or Home, graph or outline mode, expanded nodes, pins and positions, pan/zoom, outline scroll position, and focus on the file that was opened. Browser Back does the same. For a direct link or reload there is no such context, so Back to folder opens the file's containing folder and reveals its ancestors instead of leaving the app through browser history.
- **Rendering** uses `react-markdown` with `remark-gfm`: headings, lists, links, fenced code, tables, task lists, strikethrough and autolinks. Embedded HTML is never interpreted: it is shown as literal text (a browser test fails if `rehype-raw` or an equivalent is enabled). Unsafe URL schemes such as `javascript:` are stripped by the renderer's default URL policy. `http(s)` links open in a new tab with `rel="noopener noreferrer"`. Relative document links and anchors are inert text; activating them never navigates or fetches another document.
- **Images**: HTTPS images are loaded. **Privacy note:** loading a remote image contacts that third-party server from your browser. Relative images are not served in this slice and appear as an accessible “image unavailable” placeholder; they are never resolved against the app's routes or fetched through an asset endpoint (deferred until a fixture needs one).
- **States**: loading (“Loading name…”, announced), empty, not found or unavailable (Back to folder), invalid link, and failed read or unreachable API (Retry and Back to folder). A stale response can never replace a newer selection or reopen a document after navigating away, and a failed load keeps the saved browsing context.
- Light/dark theme follows the system preference; long code lines and wide tables scroll inside the document rather than the page.

## Editing

Editing is explicit and the fixtures are editable: what you save is written to `fixtures/pi/` or `fixtures/claude/` (or the configured root).

- **Edit** appears once a document has loaded. It is unavailable for files that cannot be round-tripped byte for byte: mixed or bare-CR line endings, or bytes that are not valid UTF-8 (detected by comparing the re-encoded text's SHA-256 with the server's hash). Such files stay read-only with an explanation.
- The editor is CodeMirror with Markdown highlighting and **Edit** / **Preview** tabs; Preview renders the current draft with the same safe renderer as the document view. Switching tabs never saves or discards anything.
- **No autosave.** Nothing is written on keystrokes, tab switches, navigation or timers. Save with the **Save** button or **Ctrl/Cmd+S** (the browser's Save Page is suppressed while editing). Unchanged text is written back byte for byte, including CRLF endings, a BOM and a missing final newline; new lines take the file's own line ending.
- Status is shown next to the buttons: **Unsaved**, **Saving**, **Saved** or **Error**. Saved is only shown once the server has acknowledged exactly the current draft; edits made during a save keep the status at Unsaved after it completes.
- One save is in flight at a time. Pressing Save again while one is pending queues one snapshot (the latest requested draft replaces it) and sends it with the hash the first save returned. A failure or conflict empties the queue and never retries on its own.
- **Failed save**: the draft, including edits made during the failed request, is kept. **Retry** re-sends with the last acknowledged hash; if the earlier write actually reached the disk, the retry reports a conflict rather than overwriting silently. **Copy draft** copies the current draft, with a selectable-text fallback when the clipboard is unavailable.
- **Conflict** (the file changed on disk since it was read or last saved): Save and Revert are blocked, the draft is kept, and **Reload** (after confirmation) discards the draft and starts a fresh editing session from the file on disk. A failed reload keeps the draft and the conflict.
- **Revert** saves the content the file had when Edit was pressed (not the last save), after confirmation, through the same hash check. It is unavailable while a save is pending or while conflicted.
- **Done** leaves editing mode and shows the saved content.

### Recovery limits

- In-app navigation that would abandon a dirty draft (breadcrumbs, Back to folder, Done) asks **Discard changes?**; Cancel keeps the draft, the URL and focus. While a save is pending those actions are refused until it settles.
- The browser's own leave-page warning is registered while there is unsaved or unacknowledged work; browsers decide whether and how to show it.
- Browser Back/Forward are **not** intercepted: unsaved drafts, including after a failed save, are lost when history navigation leaves the editor, and returning reads the file from disk. Drafts are never persisted across reloads or browser closure. A request already sent may still complete after you leave.
- Deleted files and folders have no recovery in the app: there is no trash, backup or version history. For the committed fixtures, git is the only safety net.

## File and folder operations

The **File operations** toolbar acts on the selected source or folder while browsing: **New file…**, **New folder…**, and, for folders other than a source root, **Rename…**, **Move…** and **Delete…**. The document header offers **Rename…**, **Move…**, **Delete…** and **Copy to Pi/Claude…** for the open file. Every operation uses a labelled dialog with Cancel; only one request is submitted per dialog and repeated confirmation is disabled while it is pending.

- Names must be single components (no `/`); files end in `.md`, folders do not. The dialog validates first, and the server remains authoritative: its errors (already exists, not empty, not found) are shown in the dialog.
- Rename keeps the folder; Move chooses another folder of the same source from a list (never an arbitrary path); Delete shows the full source and relative path and cannot be undone; only empty folders can be renamed, moved or deleted, and nothing recurses.
- Copy sends the **saved bytes on disk** to the other source, never the unsaved editor buffer; the button says so while a draft is dirty and is disabled while a save is pending. Frontmatter is copied as is and may not be accepted by the other agent.
- The open file cannot be renamed, moved or deleted while it has unsaved changes, an unresolved conflict or a pending save; the app explains that you must save or discard first and does neither for you.
- After success the listing is refetched without resetting expansion, pins or positions. Creating a file opens it, creating a folder reveals and selects it, renaming or moving the open file updates its URL, deleting it returns to its folder, and copying keeps the original open and reports the destination. If the operation succeeded but the refresh failed, both facts are reported with a Refresh button; the operation is never offered again as a retry.

## Accessibility

- **Outline view** (toolbar button) replaces the graph with nested lists that share the same data, expansion state, selection, breadcrumbs and Refresh.
- **Keyboard order** in the graph is the outline order: Pi, its visible children depth-first, then Claude. Each node's body is followed by its expand/collapse control and, when pinned, its unpin control.
- On a focused node: **Enter** or **Space** selects a folder or opens a file, **→** expands, **←** collapses, **P** pins or unpins. Toggle and unpin controls respond to Enter/Space.
- File nodes are buttons exposed as “name, Markdown file” in both the graph and the outline. The current breadcrumb carries `aria-current="page"`; long trails collapse the middle behind a “…” button.
- Opening a document moves focus to its heading; Back to folder returns focus to the file that was opened. Document loading, completion and failures are announced through the same polite live region as loading, refresh results, expansion and pin changes. Full names remain in accessible labels even when zoomed-out labels are hidden.

## Out of scope

No autosave, automatic formatting, draft persistence, version history, trash or automatic conflict merging; no recursive or bulk folder operations, image uploads, relative-image or asset serving, following of relative document links, search or filters, reference/dependency edges, persistence of layout positions or scroll positions across reloads, multi-user collaboration or access to live agent directories.
