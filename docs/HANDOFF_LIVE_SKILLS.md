# Handoff: live Pi and Claude skills (PRD_LIVE_SKILLS)

Implements `docs/PRD_LIVE_SKILLS.md`: configured filesystem locations under the Pi and Claude sources replace the fixture-only experience. Work was done in the four PRD slices, each red → green → refactor, on branch `slice-3-editing-and-file-operations`. Commits are left to the user. Scratch evidence files referenced below live in the session scratchpad and are summarised here; the reproducible evidence is the test suites themselves.

## Summary of what changed

- **Configuration** (`server/config.ts`): `MD_MANAGER_CONFIG` or `$HOME/.config/md-manager/sources.json`, version 1, absolute paths, stable ids, categories, duplicate/overlapping/aliased roots rejected, `MD_MANAGER_FIXTURE_ROOT` as explicit fixture mode, both set is an error, missing config is a startup failure (exit 1, no fixture fallback). `loadConfig(env)` takes an explicit environment so tests never discover a live config.
- **Backend** (`server/registry.ts`, `files.ts`, `mutations.ts`, `app.ts`, `index.ts`): `LocationRegistry` opens the trusted configured root no-follow for exactly one operation; unknown/mismatched ids are 400 `INVALID_LOCATION`, roots that are missing/symlinked/unreadable are 404 `LOCATION_UNAVAILABLE` with a path-free reason; the listing reports per-location status and never fails as a whole; `.git` is excluded and refused everywhere; moves stay in one location; copy names a destination location; every request/response carries `locationId`.
- **Frontend** (`src/graph/model.ts` and the components): identity is `(source, locationId, path)`; node ids `Pi`, `Pi/<loc>`, `Pi/<loc>/<path>`; location nodes with labels, categories and availability in graph and outline; URLs `/browse/<source>[/<loc>[/segments]]` and `/file/<source>/<loc>/segments`; legacy `/<Source>/…` and `/file/<Source>/<name>.md` links and unconfigured locations are explained with per-location links, never resolved by guessing; creation at a source node requires choosing a location; copy chooses a destination location then a folder; package/plugin files show a persistent installed-file notice (`data-testid="installed-notice"`); Refresh retries unavailable locations and never touches an open draft.
- **Harness**: unit tests use temporary roots; `playwright.config.ts` builds an isolated temp root with five locations (one deliberately missing), writes its own `sources.json`, passes it to the API and removes it in `tests/global-teardown.ts`. No test reads or writes a live skill directory or the committed fixtures.
- **Rollout**: `config/sources.example.json`; the live `~/.config/md-manager/sources.json` (25 locations) generated from a read-only inventory; README rewritten (setup, restart, SSH tunnel, loopback, API contract, test rules).

## Red/green evidence per slice

Commands are `npx tsx --test …` (unit) and `npx playwright test` (browser) unless noted. Test-authoring mistakes are listed separately from product reds.

### Slice 1 — configuration and location registry (unit)

- Red: `server/config.test.ts` first failed with `ERR_MODULE_NOT_FOUND` (no `server/config.ts`), then 9 behavioural failures against a skeleton exporting the names with no logic (wrong ids, no validation, no ordering).
- Green: 9/9.

### Slice 2 — multi-root backend (unit)

- Red (`slice2-red-2.txt`): 55 failing / 11 passing across `server/app.test.ts`, `file.test.ts`, `write.test.ts`, `mutate.test.ts`, `locations.test.ts`, `config.test.ts` against the unchanged server. The migrated suites failed behaviourally (`createApp(fixtureLocations(root))` crashed on the old string-root signature, requests without `locationId` were accepted, the listing had no `locations`, `.git` was listed). `mutate.test.ts` and the new `locations.test.ts` could not load `server/registry.ts`.
- Green after implementation: 97/102, then 102/102 after five corrections:
  - Product: Linux reports a symlink opened with `O_NOFOLLOW|O_DIRECTORY` as `ENOTDIR`, not `ELOOP`; the unavailable-reason classifier now distinguishes the two with an `lstat` used only for the diagnostic.
  - Product: the registry did not order locations Pi-first (only the config loader did); it now applies `orderLocations`.
  - Product: copy opened the destination root before checking the source file, so a missing source in a copy into a symlinked destination reported the wrong error; the destination is now opened only after the source bytes are read.
  - Test-authoring: the `.git` listing assertion used a substring check that matched the `.github` directory I had added to the same test.
  - Contract decision: a symlinked/missing/unreadable *root* is `LOCATION_UNAVAILABLE` (404) on every route, not `NOT_FOUND`; two assertions migrated in the previous session (`write.test.ts`, `mutate.test.ts`) were updated to say so.
- `npm run test:unit` 126/126 (later 130/130 with the migrated model/document tests); `npm run build` clean.

### Slice 3 — navigation and live-file UI

- Model red (`slice3-model-red-2.txt`): `tests/unit/model.test.ts` rewritten for location-aware ids, URLs, breadcrumbs, counts and legacy links; with a one-line skeleton export added so the module loaded, 11 of 12 tests failed behaviourally. Green: 12/12 after the new `src/graph/model.ts`; `tests/unit/document.test.ts` migrated; `npm run test:unit` 130/130.
- Browser red (`e2e-1.txt`, isolated harness, ports 5184/3014): the migrated and new specs ran against the rewritten UI: 86 passed, 19 failed, 10.4 min. Failure causes:
  - Product (14 tests): with the extra location level, expanded nodes ended up outside the canvas behind the toolbars or legend, and multi-line labels ("Personal skills", "Personal and synced skills", long scratch names) moved the centre of a node body's box into the gap below its shape, so pointer activation hit the background. Fix: labels and tags are drawn in a sibling group of the focusable body (so the body's box is the shape), and the test helpers fit the view after expanding.
  - Product (2 tests): file breadcrumbs now have five crumbs (Home / source / location / folder / file), so the trail collapsed one level too early; the visible limit is now 5 (deeper trails still collapse, covered by `listing-refresh.spec.ts`).
  - Test-authoring (2 tests): a copy-destination assertion matched the substring "skills" inside "Personal and synced skills (location root)"; the legacy-link test forbade any `/api/file` request although a direct link is fetched before the listing arrives and is rejected with 400 (the assertion now checks that no such request succeeds).
  - Test-authoring (1 test, same root cause as the product fix above): `document.spec.ts` expected an uncollapsed trail.
- Second run (`e2e-2.txt`): 102 passed, 3 failed. Product: Back to folder from a *direct* file link never focused the file node, because the graph mounts without layout positions and the app's focus effect ran before the nodes existed (the saved-context path restores positions first, which is why it worked); pending focus is now retried once the layout notifies. Test-authoring: a `.nth(1)` on an "Expand review" control after the first review folder was already expanded, and a seeded draft file with a trailing newline that made the saved bytes differ from the expectation.
- Browser green: see "Final gates".

### Slice 4 — regression and rollout

- Live inventory (read-only, 2026-09-20): `~/.pi/agent/skills` (explain-diff, herdr-notes, team-prd); packages `pi-mcp-adapter` and `pi-subagents`; project `~/dev/agent-workflow/.pi/skills`; `~/.claude/skills` (with the nested synced collection); synced plugins `cowork-plugin-management` and `design`; 18 marketplace plugin `skills` directories under `claude-plugins-official/{plugins,external_plugins}`; no symlinked candidates; no other `.pi/skills` or `.claude/skills` under `~/dev` to depth 4.
- Live config written to `~/.config/md-manager/sources.json`: 25 locations (4 Pi, 21 Claude) with stable ids (`pi-personal`, `pi-pkg-<package>`, `pi-project-agent-workflow`, `claude-personal`, `claude-synced-<plugin>`, `claude-marketplace-<plugin>`).
- Read-only smoke check (API on a spare port with the live config): startup logged all 25 locations available; `GET /api/entries` returned 25 locations and 307 entries (162 Markdown files) with no absolute paths in the body; `GET /api/file` returned 200 for representative documents in a personal, a package, a project, a synced-plugin and a marketplace-plugin location. No live file was written.

## Final gates

Run from the repository root on 2026-09-20 with the dev servers on 5173/3001 left alone:

```sh
npm run test:unit                                                     # 130 passed
npx tsc -b && npm run lint                                            # clean
npm run build                                                         # clean
MD_MANAGER_WEB_PORT=5184 MD_MANAGER_API_PORT=3014 npm run test:e2e   # see below
MD_MANAGER_TEST_PREVIEW=1 MD_MANAGER_WEB_PORT=4184 MD_MANAGER_API_PORT=3014 npm run test:e2e   # see below
git diff --check                                                      # clean
git status --short -- fixtures/                                       # empty
```

Browser results (isolated temp roots, one worker): dev serving **105 passed** (2.8 min, `e2e-3.txt`), production preview **105 passed** (1.8 min, `e2e-preview.txt`); no `md-manager-e2e-*` directory left in the OS temp directory afterwards. Red history for the same suite: 86/105 → 102/105 → 105/105 as described under Slice 3.

## Decisions and limits to know about

- A root that is missing, unreadable or a symlink is `LOCATION_UNAVAILABLE` (404) for reads, saves and mutations; the listing shows it as unavailable with a path-free reason. Healthy locations are unaffected and Refresh recovers a restored root without a restart.
- Roots are opened per operation rather than retained: the same pinning guarantee (an in-flight operation continues on the original directory or fails safely) with nothing to leak, reopen or revalidate.
- A direct `/file/…` link is fetched as soon as the page loads; if the listing then shows the location is unconfigured, the document view is replaced by the explanation. The early request is rejected by the API (400) and no content is shown.
- `.git` components are refused with 400 on every route, including reads.
- The `npm run dev` API on this machine needs the live config (now present) or it exits at startup with the diagnostic; restart `npm run dev` after editing the config.
- Not done: same-agent cross-location copy, cross-location move, watching, activation state, search (all PRD non-goals).
