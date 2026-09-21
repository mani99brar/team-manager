# MD Manager

Graph explorer, document viewer and explicit-save Markdown editor for the Pi and Claude skill directories on this machine, with bounded create/rename/move/delete/copy operations. Built with React, Vite, Fastify, TypeScript, d3-force, react-markdown and CodeMirror.

Pi and Claude are the two top-level sources. Underneath each, one or more **configured locations** (personal skills, package or plugin skill directories, project skill directories) are browsed and edited in place: nothing is imported, mirrored or copied into this repository.

## Agent workflow lab

The separate [LangGraph workflow runbook](workflow/RUNBOOK.md) covers two interactive Claude workers, a dedicated Herdr tab, isolated verification, screenshots, independent review and explicit integration approval. It does not change the Markdown-manager application or start agents automatically.

## Start

Requires **Linux with procfs mounted at `/proc`**, Node.js 22.12+ (tested with 24), and npm. The backend fails closed at startup without Linux/procfs descriptor access; macOS/Windows backends are not supported.

```sh
npm ci
cp config/sources.example.json ~/.config/md-manager/sources.json   # then edit the paths (see “Live skills”)
npm run dev
```

Open http://127.0.0.1:5173. This starts Vite and the Fastify API together; Ctrl-C stops both. The API listens on http://127.0.0.1:3001 and Vite proxies `/api` requests to it. Everything is single-user and localhost-only: both servers bind to loopback and there is no authentication and no cross-origin access.

To preview the production frontend, run `npm run build`, then `npm run start:api` in one terminal and `npm run preview` in another (http://127.0.0.1:4173). Both Vite modes serve malformed document links/reloads to the app’s invalid-link UI without changing the URL.

## Live skills

### Configuration

The API reads one JSON file at startup and never changes it:

- `MD_MANAGER_CONFIG=/path/to/sources.json` selects the file; the default is `$HOME/.config/md-manager/sources.json`.
- A missing or invalid file is a **startup failure** with a local diagnostic on stderr (exit code 1). The app never falls back to the repository fixtures on its own.
- `MD_MANAGER_FIXTURE_ROOT=/path/to/root` is the explicit fixture/demo mode instead: `<root>/pi` and `<root>/claude` become the locations `pi-fixtures` and `claude-fixtures`. Setting both variables is an error.

```json
{
  "version": 1,
  "locations": [
    { "id": "pi-personal", "source": "Pi", "label": "Personal skills", "path": "/home/you/.pi/agent/skills", "category": "personal" },
    { "id": "pi-subagents", "source": "Pi", "label": "Package: pi-subagents", "path": "/home/you/.pi/agent/npm/node_modules/pi-subagents/skills", "category": "package" },
    { "id": "claude-personal", "source": "Claude", "label": "Personal and synced skills", "path": "/home/you/.claude/skills", "category": "personal" }
  ]
}
```

- `version` must be `1`.
- `id` is the stable identity used in URLs and requests: 1–64 characters of letters, digits, `.`, `_` or `-`, starting with a letter or digit, unique across the file. Labels can change freely; changing an id breaks bookmarks.
- `source` is `"Pi"` or `"Claude"`; `category` is `personal`, `package`, `plugin` or `project` (package and plugin locations show an “installed file” notice in the document view).
- `path` must be absolute. `~`, environment variables and globs are not expanded. Roots must be distinct directories: identical, nested or aliased (symlinked) roots are rejected at startup, so every file belongs to exactly one location.
- Locations are shown Pi first, then Claude, in configured order within each source.
- A configured location whose directory is missing, unreadable or a symlink is reported **unavailable** (with a path-free reason) while the others keep working. Refresh retries it; restoring the directory needs no restart.

Adding a location means editing the file and restarting the API (`npm run dev` again, or restart `npm run start:api`). There is no UI for attaching directories and no automatic scan on Refresh.

### Setting up this machine

`config/sources.example.json` is the template. The live config on this VPS was produced from a bounded, read-only inventory of the known agent directories: `~/.pi/agent/skills`, each `~/.pi/agent/npm/node_modules/<package>/skills`, `~/dev/agent-workflow/.pi/skills`, `~/.claude/skills` (which contains the nested synced collection), each `~/.claude/plugins/synced/<id>/<plugin>/skills` and each `~/.claude/plugins/marketplaces/<market>/{plugins,external_plugins}/<plugin>/skills`. Individual `skills` directories are configured, never a whole `node_modules` or marketplace checkout. Showing a marketplace or package file does not mean the corresponding plugin or package is enabled by the agent; the app never claims activation. Newly installed packages or projects need a config edit and a restart.

### Access through an SSH tunnel

Both servers listen on 127.0.0.1 only. From your workstation:

```sh
ssh -L 5173:127.0.0.1:5173 -L 3001:127.0.0.1:3001 user@your-vps
```

then open http://127.0.0.1:5173 locally. Forwarding 3001 is only needed if you want to call the API directly; the web port proxies `/api` on its own. Nothing is exposed publicly.

## Checks

```sh
npx playwright install chromium  # first-time browser setup
npm test        # API + model unit tests, then the browser suite
npm run lint
npm run build
```

`npm run test:unit` runs the configuration tests (`server/config.test.ts`: parsing, ids, ordering, absolute paths, duplicate and overlapping roots, missing config, conflicting modes), the API tests (temporary roots covering nested and empty directories, uppercase `.MD`, ignored extensions, `.git` exclusion, symlink exclusion, per-location unavailability and recovery, the `GET /api/file` validator, the `PUT /api/file` write pipeline, the `POST /api/mutate` matrix and the multi-location contract in `server/locations.test.ts`: duplicate relative paths, unknown/mismatched locations, unavailable roots, cross-location refusals, root replacement during a read, descriptor cleanup), the pure graph-model/URL tests and the edit-session state machine.

`npm run test:e2e` starts the app on a single Playwright worker with reduced motion against **isolated temporary roots**: `playwright.config.ts` creates one temp directory per run (seeded from `fixtures/pi` and `fixtures/claude` as `pi-personal` and `claude-personal`, plus a `pi-package`, a `claude-plugin` and a deliberately missing `pi-missing` location), writes a `sources.json` there, passes it to the API through `MD_MANAGER_CONFIG`, and removes everything in `tests/global-teardown.ts`. No browser test reads or writes a live skill directory or the committed fixtures.

### Isolated test ports and evidence

`MD_MANAGER_WEB_PORT` and `MD_MANAGER_API_PORT` override the default web/API ports (5173 dev, 4173 preview, 3001 API). Pick **free** ports; do not stop or reuse another development server. Vite uses `strictPort`, and Playwright starts/checks both owned servers with `reuseExistingServer: false` and one worker. Set `MD_MANAGER_TEST_PREVIEW=1` to test the built frontend instead of dev serving; build first.

```sh
npm run test:unit
MD_MANAGER_WEB_PORT=5184 MD_MANAGER_API_PORT=3014 npm run test:e2e
npm run lint
npm run build
MD_MANAGER_TEST_PREVIEW=1 MD_MANAGER_WEB_PORT=4184 MD_MANAGER_API_PORT=3014 npm run test:e2e
git diff --check
git status --short -- fixtures/  # empty
```

See `docs/HANDOFF_LIVE_SKILLS.md` for the observed red/green evidence of the live-skills work and `docs/HANDOFF_SLICE2.md` / `docs/HANDOFF_SLICE3.md` for the earlier slices.

### Test rules

- Unit tests build their own temporary roots or use `fixtureLocations(defaultFixtureRoot)`; they never discover `$HOME/.config/md-manager/sources.json`, because `loadConfig` takes an explicit environment.
- Browser tests create uniquely named `scratch-*` artifacts inside the temporary roots and remove them in `afterEach`, including on failure. The committed sample files under `fixtures/` are never written; `tests/zz-fixtures-clean.spec.ts` asserts that `git status` reports nothing under `fixtures/`.
- Never run the unit suite concurrently with the browser suite.

## API

Every route identifies files by **source + location id + location-relative path**. Responses never contain absolute paths, other files’ content or stack traces.

### `GET /api/entries`

```json
{
  "locations": [
    { "id": "pi-personal", "source": "Pi", "label": "Personal skills", "category": "personal", "status": "available", "error": null },
    { "id": "pi-missing", "source": "Pi", "label": "Project: gone", "category": "project", "status": "unavailable", "error": "The configured folder does not exist. Refresh the listing to see which locations are available." }
  ],
  "entries": [
    { "source": "Pi", "locationId": "pi-personal", "path": "skills", "kind": "directory" },
    { "source": "Pi", "locationId": "pi-personal", "path": "skills/review.md", "kind": "file" }
  ]
}
```

- `locations` lists every configured location (Pi first, configured order) with its current availability; `entries` holds every eligible descendant of the available ones, in deterministic pre-order (byte-wise name order within a directory). Location roots are implicit.
- Regular `.md` files (case-insensitive) and directories, including empty ones, are included. `.git` directories are skipped at any depth; other dot directories are eligible. Symlinks are skipped and never followed. Other file types are ignored.
- An unavailable location never fails the whole listing and is never shown as an empty folder. The endpoint takes no parameters.

### `GET /api/file?source=Pi&locationId=pi-personal&path=skills%2Freview.md`

```json
{ "source": "Pi", "locationId": "pi-personal", "path": "skills/review.md", "content": "# Review\n", "hash": "<lowercase SHA-256 hex of the file bytes>" }
```

- The three parameters are ordinary query parameters, each exactly once (build them with `URLSearchParams`; values are decoded once, so a literal `%` in a filename works). `locationId` must be configured for `source`.
- Only regular `.md` files are readable. `content` is the file decoded as UTF-8 without trimming or normalisation; `hash` is the SHA-256 of the exact bytes of that same read and is the `expectedHash` for `PUT`. Responses carry `Cache-Control: no-store`.
- Errors are `{ "code", "error" }`: **400** `INVALID_QUERY`, `INVALID_SOURCE`, `INVALID_LOCATION` (missing, unknown or belonging to the other source), `INVALID_PATH` (traversal, absolute, dot components, backslashes, NULs, `.git`); **404** `NOT_FOUND` (missing, directory, non-Markdown, non-regular, symlinked) and `LOCATION_UNAVAILABLE` (the location’s root is missing, a symlink or unreadable); **500** `READ_FAILED`.

### `PUT /api/file`

Hash-guarded content write of an existing Markdown file; there is no implicit create.

```json
{ "source": "Pi", "locationId": "pi-personal", "path": "skills/review.md", "content": "# Updated\n", "expectedHash": "<SHA-256 from the last read or write>" }
```

Success is **200** with `{ "source", "locationId", "path", "hash" }`. The current bytes are hashed first: a mismatch is **409 `HASH_CONFLICT`** and the file is untouched. Writes are staged in an exclusively created sibling temp file (never `.md`) that receives the original mode, written and synced, then renamed over the original after its identity and bytes are re-checked. Handled failures remove the temp file and leave the original. App requests are serialized through one process-local queue; this is **not** an OS-wide compare-and-swap, so an external writer racing between the final re-check and the rename is not detected. Bodies over **8 MiB** are **413 `REQUEST_TOO_LARGE`**.

### `POST /api/mutate`

```text
{ "op": "create-file",   "source": "Pi", "locationId": "pi-personal", "path": "skills/new.md", "content": "" }
{ "op": "create-folder", "source": "Pi", "locationId": "pi-personal", "path": "skills/topics" }
{ "op": "rename",        "source": "Pi", "locationId": "pi-personal", "path": "skills/new.md", "destinationPath": "skills/renamed.md" }
{ "op": "move",          "source": "Pi", "locationId": "pi-personal", "path": "skills/renamed.md", "destinationPath": "archive/renamed.md" }
{ "op": "delete",        "source": "Pi", "locationId": "pi-personal", "path": "skills/topics" }
{ "op": "copy",          "source": "Pi", "locationId": "pi-personal", "path": "skills/review.md",
                         "destinationSource": "Claude", "destinationLocationId": "claude-personal", "destinationPath": "imported/review.md" }
```

Success is **201** for create/copy and **200** for rename/move/delete, echoing `op`, `source`, `locationId`, `path` and, for rename/move/copy, `destinationSource`, `destinationLocationId`, `destinationPath`.

- `rename` keeps the parent; `move` stays within **one location** (a different `destinationLocationId` is **400 `INVALID_LOCATION`**) and needs an existing destination parent. `copy` targets the other source and must name a configured, available location there. Same-agent cross-location copy and cross-location moves are not supported.
- Files keep a `.md` name, folders never take one; parents are never created implicitly; only **empty** directories can be renamed, moved or deleted (**409 `FOLDER_NOT_EMPTY`**, counting hidden entries); nothing recurses.
- Nothing overwrites: destinations are probed on disk (dangling symlinks count as occupied) and created with exclusive primitives (**409 `DESTINATION_EXISTS`**). Identical source and destination is **409 `NO_CHANGE`**.
- Location and source nodes are never targets (an empty path is 400). Symlinks anywhere in a path are refused (404). `.git` paths are refused (400) even when addressed directly.
- Mutations carry no content hash: deletion is irreversible within the app. There is no trash, backup or version history; package and plugin files may also be replaced by an update or sync.

### Errors

Stable codes: **400** `INVALID_BODY`, `INVALID_OP`, `INVALID_QUERY`, `INVALID_SOURCE`, `INVALID_LOCATION`, `INVALID_PATH`, `INVALID_CONTENT`, `INVALID_HASH`; **404** `NOT_FOUND`, `LOCATION_UNAVAILABLE`; **409** `HASH_CONFLICT`, `DESTINATION_EXISTS`, `FOLDER_NOT_EMPTY`, `NO_CHANGE`; **413** `REQUEST_TOO_LARGE`; **415** `UNSUPPORTED_MEDIA_TYPE`; **500** `READ_FAILED`, `WRITE_FAILED`, `MUTATION_FAILED`, `LISTING_FAILED`.

### Filesystem boundary

Configured roots are trusted administrator input; request parameters are not. For every operation the location’s configured path is opened `O_RDONLY | O_DIRECTORY | O_NOFOLLOW` for the duration of that one operation (the path’s ancestors are trusted; the root itself is never followed as a symlink), each further component is opened relative to its already-open parent through `/proc/self/fd` with `O_NOFOLLOW`, and the final target uses `O_NOFOLLOW | O_NONBLOCK` plus a regular-file `fstat`. A root or directory replaced or symlinked mid-operation therefore either continues on the pinned original or fails safely; it can never redirect the operation. No handle outlives its operation, so there is nothing to leak on shutdown, and the next operation re-opens the configured path and reports it unavailable if it is gone. The listing is never used as a security check.

## Graph explorer

The page shows a header with Refresh, a breadcrumb bar (Home / source / location / folder …), a toolbar, the graph canvas and a legend.

- **Nodes**: large circles are the Pi and Claude sources, rounded rectangles are configured locations (dashed and tagged *unavailable* when their directory cannot be read), folder shapes are directories and small document shapes are Markdown files. Activating a file (click, Enter or Space) opens it; dragging only pins it.
- **Edges** always mean *contains*, parent to child. Pi and Claude are never connected to each other.
- **Expand / collapse** with the `+` / `−` control on sources, locations and folders. Expanding a source reveals its locations; expanding a location reveals its top-level entries. Empty folders are marked *empty*.
- **Select** a source, location or folder by clicking its body. The breadcrumb, counts (locations for a source, folders and files otherwise, or the unavailability reason) and URL update.
- **Drag** to pin; the pin badge unpins. **Toolbar**: zoom, **Fit**, **Reset** (clears pins and expansion, returns Home), **Outline**.
- **URLs**: browsing uses `/browse/<source>`, `/browse/<source>/<locationId>` and `/browse/<source>/<locationId>/<segments…>` with every segment encoded; documents use `/file/<source>/<locationId>/<segments…>`. Direct links reveal the source, location and ancestors. Links to an unconfigured location, and links in the old fixture-only layout (`/Pi/...`, `/file/Pi/name.md`), show an explanation with one link per configured location; they are never resolved by guessing.
- **Refresh** refetches the listing while keeping selection, expansion, pins and positions, retries unavailable locations, and never touches an open document or its draft.

## Document view

- **Identity**: the heading shows the filename; the line below shows the source, the **location label** and the location-relative path, so the same relative path in two locations is never confused. Breadcrumbs link to Home, the source, the location and each ancestor folder.
- Files in `package` or `plugin` locations show a persistent notice: saving changes the installed copy, which an update or sync may overwrite. They stay editable.
- Rendered / Source tabs, safe rendering (raw HTML shown literally, unsafe schemes stripped, relative links inert, HTTPS images loaded), loading/missing/invalid/failed states, Back to folder restoring the exact browsing context, and stale-response protection are unchanged from the earlier slices.

## Editing

Explicit Save only (button or Ctrl/Cmd+S), no autosave, byte-for-byte round trips (CRLF, BOM, missing final newline), one save in flight with a single queued slot, hash conflicts that keep the draft and offer Reload/Copy draft, Revert to the Edit baseline, Done, and the recovery limits documented in `docs/HANDOFF_SLICE3.md` all apply unchanged to live files. What you save is written to the original file at its configured location.

## File and folder operations

The **File operations** toolbar acts on the selection while browsing: **New file…** and **New folder…** on a source, an available location or a folder; **Rename…**, **Move…** and **Delete…** on folders only. The document header offers **Rename…**, **Move…**, **Delete…** and **Copy to Pi/Claude…** for the open file.

- Creating from a source node requires choosing a location in the dialog (only available locations are offered; nothing is guessed). Creating from a location or folder uses that location.
- Move offers only folders of the file’s own location. Copy asks for a destination location under the other source, then a folder in it, and copies the **saved bytes on disk**, never the unsaved draft.
- Source and location nodes cannot be renamed, moved, deleted or copied as filesystem objects.
- The open file cannot be renamed, moved or deleted while it has unsaved changes, an unresolved conflict or a pending save.
- After success the listing is refetched without resetting expansion, pins or positions; a successful operation followed by a failed refresh reports both and offers Refresh, never a repeat.

## Accessibility

Outline view mirrors the graph as nested lists (sources, locations with their availability, folders, files). Keyboard order follows the outline; Enter/Space selects a source, location or folder or opens a file, → expands, ← collapses, P pins. Live-region announcements cover loading, refresh, expansion, pins and document states. The current breadcrumb carries `aria-current="page"`.

## Out of scope

No UI for attaching directories, no automatic skill discovery or filesystem watching, no agent activation management, no same-agent cross-location copy or cross-location move, no autosave, backups, trash or version history, no recursive folder operations, no search, no multi-user access, no remote filesystems. Only Markdown content is managed: copying `SKILL.md` does not install a complete skill.
