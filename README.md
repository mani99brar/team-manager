# MD Manager

Read-only, free-form graph explorer for the Pi and Claude Markdown fixture folders. Built with React, Vite, Fastify, TypeScript and d3-force.

## Start

Requires Node.js 22.12+ (tested with 24) and npm.

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5173. This starts Vite and the Fastify API together; Ctrl-C stops both. The API listens on http://127.0.0.1:3001 and Vite proxies `/api` requests to it. Everything is single-user and localhost-only.

To preview the production frontend, run `npm run build`, then `npm run start:api` in one terminal and `npm run preview` in another.

## Checks

```sh
npx playwright install chromium  # first-time browser setup
npm test        # API + model unit tests, then the browser suite
npm run lint
npm run build
```

`npm run test:unit` runs the API tests (temporary fixture roots covering nested and empty directories, uppercase `.MD`, ignored extensions, symlink exclusion and source failures) and the pure graph-model tests. `npm run test:e2e` starts the app against the committed fixtures on a single Playwright worker with reduced motion, so the layout settles instantly and no test depends on animation timing.

### Fixture testing rules

- Browser tests use the default fixture root. Never modify the committed sample files.
- Tests that need changes on disk create uniquely named `scratch-*` artifacts under `fixtures/pi/` or `fixtures/claude/` and remove them in `afterEach`, including on failure.
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

The client builds the whole graph from this one response: expanding folders needs no further requests, and Refresh performs exactly one refetch. No file contents are ever read, fetched or parsed.

### Filesystem boundary

- Sources default to `fixtures/pi/` and `fixtures/claude/`, resolved from the server module rather than the shell's working directory.
- `MD_MANAGER_FIXTURE_ROOT=/path/to/root` points the API at another root for local experiments. The root must contain `pi/` and `claude/` subdirectories. It is read once at startup; no request can change it.
- Regular `.md` files (case-insensitive) and directories, including empty ones, are included. Symlinks, whether files or directories, are skipped and never followed. Other file types are ignored.

## Graph explorer

The page shows a header with Refresh, a breadcrumb bar (Home / source / folder …), a toolbar, the graph canvas and a legend.

- **Nodes**: large circles are the Pi and Claude sources, folder shapes are directories and small document shapes are Markdown files. File nodes only show their name; there is no document action.
- **Edges** always mean *contains*, drawn from parent to child with an arrowhead. Pi and Claude are never connected to each other and no reference or dependency edges are inferred.
- **Expand / collapse** with the `+` / `−` control on each source or folder node. Expanding reveals immediate children beside their parent; collapsing hides all descendants and forgets their expansion state. Empty folders stay visible and are marked *empty*.
- **Select** a source or folder by clicking its body. The breadcrumb, folder/file counts and URL update, and its containment edges are highlighted. Selection and expansion are separate.
- **Drag** any node to pin it where you drop it; a pin badge appears, and pressing the badge unpins it. Pins survive selection changes and refreshes for as long as the node exists (until Reset or a page reload).
- **Toolbar**: `+` / `−` zoom, **Fit** frames all visible nodes, **Reset** clears pins and expansion and returns to Home, **Outline** switches to the outline view. The mouse wheel, pointer/touch drag on the background and two-finger pinch also pan and zoom. Zoom is bounded.
- **URLs**: the selected folder is stored in the path with every segment encoded (`/Claude/a%20b/c%23d`), so direct links, reloads and browser back/forward work, including names with spaces, `#`, `?` or `%`. Opening a folder link reveals its ancestors, expands it and scrolls it into view. Unknown folders show an explanation with links to the source root and Home.
- **Refresh** refetches the listing while keeping selection, expansion and positions. New entries appear under expanded parents, removed entries disappear, and if the selected folder is gone the missing-folder state is shown. If the refresh fails, the previous graph stays and is labelled as possibly outdated.
- The layout is a force-directed simulation with collision avoidance; it settles after each change instead of moving continuously and never auto-fits after interactions. Light/dark theme follows the system preference, and reduced-motion preferences make layout changes instant.

## Accessibility

- **Outline view** (toolbar button) replaces the graph with nested lists that share the same data, expansion state, selection, breadcrumbs and Refresh.
- **Keyboard order** in the graph is the outline order: Pi, its visible children depth-first, then Claude. Each node's body is followed by its expand/collapse control and, when pinned, its unpin control.
- On a focused node: **Enter** or **Space** selects a folder, **→** expands, **←** collapses, **P** pins or unpins. Toggle and unpin controls respond to Enter/Space.
- File nodes are exposed as “name, Markdown file” with no button role. The current breadcrumb carries `aria-current="page"`; long trails collapse the middle behind a “…” button.
- Loading, refresh results, expansion and pin changes are announced through a polite live region. Full names remain in accessible labels even when zoomed-out labels are hidden.

## Out of scope

No file viewing, editing or file operations, no search or filters, no reference/dependency edges, no persistence of layout positions, and no access to live agent directories.
