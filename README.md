# MD Manager

Minimal, read-only Markdown file listing built with React, Vite, Fastify and TypeScript.

## Start

Requires Node.js 22.12+ (tested with 24) and npm.

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5173. This starts Vite and the Fastify API together; Ctrl-C stops both. The API listens on http://127.0.0.1:3001 and Vite proxies `/api` requests to it.

## Checks

```sh
npx playwright install chromium  # first-time browser setup
npm test
npm run lint
npm run build
```

API tests verify the exact fixture listing, empty results, failure handling and symlink exclusion. Browser tests start the app and verify its real listing plus simulated loading, empty, HTTP-error and network-error states.

To preview the production frontend, run `npm run start:api` in one terminal and `npm run preview` in another after building.

## Listing boundary

`GET /api/files` returns `{ files: [{ source: "Pi" | "Claude", path: string }] }`. Paths are relative to `fixtures/pi/` or `fixtures/claude/`. These locations are resolved from the server module, not the shell's working directory. No request parameter can change them.

Discovery recursively includes regular `.md` files (case-insensitive), including empty files. Symlinks and other extensions are skipped. Results are ordered by source (Pi, Claude), then sorted directory traversal. Missing or unreadable source folders produce an error rather than an incomplete listing. Only filenames are read; file contents and live agent configuration folders are never accessed.

This slice intentionally has no file viewing, rendering, editing, saving, search or filters.
