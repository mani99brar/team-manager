# Slice 2 handoff — Select and Preview

Implements `docs/PRD_SLICE2.md` on top of the completed Slice 1 graph/outline browser. Read-only; no write routes, editing, autosave or file operations were added.

## Changed and added files

| Area | Files |
|---|---|
| API | `server/files.ts` (new: shared path validator, single-read content + SHA-256 helper), `server/app.ts` (`GET /api/file`, injectable `readFile` for deterministic read-failure tests) |
| Client model | `src/graph/model.ts` (`FileRef`, `/file/…` URL parse/serialise, `parentFolderOf`, `breadcrumbsForFile`) |
| Document view | `src/document/api.ts`, `src/document/useDocument.ts`, `src/document/DocumentView.tsx`, `src/document/Markdown.tsx` (all new) |
| Browsing integration | `src/App.tsx` (file route, open/return navigation, per-history-entry immutable return snapshots, focus restoration), `src/graph/GraphCanvas.tsx` (file nodes are buttons, drag never activates, viewport store, no replayed fit on remount), `src/graph/Outline.tsx` (file buttons, scroll store), `src/graph/Breadcrumbs.tsx` (non-link current file crumb), `src/App.css` |
| Tests | `server/file.test.ts`, `tests/unit/document.test.ts`, `tests/document.spec.ts`, `tests/document-render.spec.ts`, `tests/document-failure.spec.ts` (all new); `tests/graph.spec.ts` (file nodes are now buttons); `package.json` (`test:unit` lists the new unit/API files) |
| Docs | `README.md` |

## Historical implementation record (before review fixes)

The earlier blanket claim that every behaviour was implemented test-first was incorrect. The table below is the prior handoff’s reported evidence, not newly observed runs. Increment 4 explicitly had five tests already passing because their implementation existed in Increment 3: GFM, exact Source, empty states, tabs, and raw HTML are regression coverage, not demonstrated historical Red→Green. The temporary raw-HTML mutation is a negative control, not test-first evidence. There is no contemporaneous evidence here establishing mandatory TDD for every original PRD behaviour; final green coverage cannot retroactively establish that sequence. Review corrections below have separately observed red/green evidence. Test-authoring/setup failures are not counted as product reds.

| Increment | Failing test run (red) | Intended failure observed | Passing command (green) |
|---|---|---|---|
| 1 — Secure reads and hash | `npx tsx --test server/file.test.ts` → 10 fail / 0 pass | Every request to `/api/file` returned Fastify's route-not-found 404 (the 404 test was made non-vacuous with a sanity 200 read before it counted as red) | same command → 10 pass; `npm run test:unit` → 26 pass |
| 2 — File URL model | `npx tsx --test tests/unit/document.test.ts` → suite fails to load | `SyntaxError: … does not provide an export named 'breadcrumbsForFile'` | `npm run test:unit` → 26 pass, `tsc -b`, `eslint .` clean |
| 3 — Open and return | `npx playwright test tests/document.spec.ts` → 8 fail / 0 pass | No document view, file nodes not buttons, URLs stayed `/` | `npx playwright test` → 25 pass (Slice 1 suite included) |
| 4 — Rendered and Source tabs | `npx playwright test tests/document-render.spec.ts` → 2 fail / 5 pass | External links lacked `target="_blank"`/`rel`; relative images had no unavailable state. The GFM, exact-source, empty, tabs and raw-HTML tests passed from the Increment 3 shell (react-markdown defaults) | same command → 7 pass |
| 4 — Raw-HTML gate proof | `rehype-raw` installed with `--no-save` and enabled temporarily → the raw-HTML test **fails** (`<div id="raw-element">` became an element) | Proves the gate detects raw-HTML interpretation | Reverted and uninstalled; test passes again; lockfile unchanged |
| 5 — Failure states and performance | `npx playwright test tests/document-failure.spec.ts` → 4 fail / 1 pass | No `data-hash` after retry; "not found" announcement overwritten by the entries-loaded announcement; malformed-link notice unreachable (historical gap; resolved by review corrections below) | same command → 5 pass; full `npm run test:e2e` → 38 pass |

Test-authoring mistakes fixed along the way (not product defects): `encodeURI` on an already-encoded pathname in a unit test; zooming before dragging pushed a node off-canvas; a folder direct link already expands the folder; the generated "large" file was 97 KB (raised to ~120 KB); a visible-node snapshot captured while the document view was open; `HTMLImageElement`/`window` types are unavailable under the tests tsconfig; locator ambiguities for "Back to folder" and "Home".

Product fixes driven by red tests: initial fit was skipped because the viewport store was written before the mount effect checked it; returning to the graph after expanding in outline mode did not re-render (layout subscription now precedes the sync); duplicate "Back to folder" in the error state removed; entries-loaded announcement suppressed while a document is open.

## Accepted review corrections (observed 2026-09-19)

The owner explicitly approved **Linux-only for now** before the descriptor architecture was implemented. No dependency, editing, write/mutation route, or Slice 3 behaviour was added.

| Correction | Observed Red | Green / regression evidence |
|---|---|---|
| Descriptor confinement, missing/operational statuses, fail-closed capability | `npx tsx --test server/file.test.ts`: **6 failed / 13 passed**. Replacing source root, intermediate directory, or final file immediately before the old pathname read returned outside bytes (3 failures); read ENOENT returned 500 instead of 404; metadata EIO returned 404 instead of 500; missing procfs was not rejected at startup. | Same command: **19 passed** after descriptor implementation. Expanded before/after-open replacement, fstat errors, unsupported platform/non-procfs/descriptor access, and handle-close checks were subsequently added as regression coverage, not independent historical reds. Final full unit suite: **47 passed**. |
| Operational ENXIO read classification | `npx tsx --test --test-name-pattern='read ENXIO' server/file.test.ts`: **1 failed**, a simulated read ENXIO incorrectly returned 404. | Same command: **1 passed**. ENXIO means special target only at final open (socket); a read ENXIO is 500. |
| Fresh reopening, loading announcements, malformed direct link, Back focus/collapse, repeated origins | `MD_MANAGER_WEB_PORT=5184 MD_MANAGER_API_PORT=3014 npx playwright test tests/document-review.spec.ts`: initially **8 failed**. **7 intended failures**: old ready/error on reopening (2), absent direct/reload/retry live announcements (3), malformed direct-link 404 (1), missing Back focus (1). The repeated-origin test initially had a whitespace locator error, which does not count as Red. | After fixing the locator, `MD_MANAGER_WEB_PORT=5184 MD_MANAGER_API_PORT=3014 npx playwright test tests/document-review.spec.ts -g 'repeated document'` failed for missing Back focus. The full suite’s assertions now verify both historical origins, selection, mode, expansion, all node positions, pins, viewport and focus. |
| Real malformed direct/reload routes in both serving modes | The direct-navigation test above failed with a server 404 (no pushState substitution). An unused `decodeURIComponent` call was optimized away by Vite’s config bundler during the first fix; consuming the result corrected the middleware. | `MD_MANAGER_WEB_PORT=5184 MD_MANAGER_API_PORT=3014 npx playwright test tests/document-review.spec.ts -g malformed`: **1 passed**. `MD_MANAGER_TEST_PREVIEW=1 MD_MANAGER_WEB_PORT=4184 MD_MANAGER_API_PORT=3014 npx playwright test tests/document-review.spec.ts -g malformed`: **1 passed**. Preview was validated after the fix, not independently test-first. |
| Session-only origins and departing native-history snapshots | `MD_MANAGER_WEB_PORT=5184 MD_MANAGER_API_PORT=3014 npx playwright test tests/document-history-review.spec.ts`: **2 failed / 1 passed**. Reload incorrectly retained `/Claude` origin instead of falling back to `/Pi`; native Back/Forward lost the departing browsing entry’s latest outline mode. Historical outline scroll test already passed and is regression coverage. | `MD_MANAGER_WEB_PORT=5184 MD_MANAGER_API_PORT=3014 npx playwright test tests/document-review.spec.ts tests/document-history-review.spec.ts`: **11 passed** at this point. |
| Browse-to-browse viewport restore | `MD_MANAGER_WEB_PORT=5184 MD_MANAGER_API_PORT=3014 npx playwright test tests/document-history-review.spec.ts -g 'Back between browsing'`: **1 failed**, old canvas viewport survived the restored snapshot. | Same command: **1 passed** after remounting restored browsing views; final suite has **50 browser tests**. |
| Large-document tab performance (found during final regression) | A repeated full dev run was **49 passed / 1 failed**: returning to Rendered took **2043 ms**, exceeding the existing strict **<2000 ms** requirement. The gate was not loosened. | Retain the already memoized rendered subtree behind `hidden` while Source is selected, instead of unmounting/reparsing it. `MD_MANAGER_WEB_PORT=5184 MD_MANAGER_API_PORT=3014 npx playwright test tests/document-failure.spec.ts -g 'over 100 KB' --repeat-each=3`: **3 passed**, each complete journey ~3.0–3.2s. Tab accessibility regression also asserts the hidden rendered heading is absent from the accessible role query. |

Refactoring with regression gates: browsing snapshots moved from serialised history state to an in-memory map keyed by opaque history-entry IDs (reload discards the map); origin snapshots do not share mutable simulation nodes. Layout restore rebinds force links without running Fit/reveal or rearranging positions. Loading announcements now belong to the request lifecycle rather than click handlers. The final file operation is descriptor-scoped, never a returned “validated” pathname.

Additional honest validation notes:

- The first full preview run was **49 passed / 1 failed**: the existing image test mistook production JS/CSS under `/assets/` for forbidden document image requests. It now observes actual image resource requests and requires exactly the intercepted HTTPS image. This is a harness correction, not a product Red. Focused preview image test and the full preview suite then passed.
- Two intermediate TypeScript checks caught test-authoring types (Fastify’s thenable passed directly to `assert.rejects`, then untyped mock callback arguments). These were corrected; final build is clean.
- The deleted scratch-file reopening test now also holds its response and asserts loading, no previous content, and no old hash before the eventual 404. Committed sample files were never modified.
- The raw-byte hashing test includes BOM, CRLF and invalid UTF-8 and asserts one descriptor read; it passed immediately against the old buffer implementation and is regression coverage, not a new Red.

## Changes made during review corrections

- `server/files.ts`, `server/app.ts`: startup-pinned fixture root; Linux/procfs capability rejection; per-component no-follow directory handles, final no-follow/nonblocking open + regular-file fstat + single descriptor read; safe missing versus operational status classification; all handles close on success/failure.
- `server/file.test.ts`: deterministic replacement before/after source, intermediate and final opens, replacement before read, error classification, capability failures, descriptor cleanup, exact single-read raw-byte hash.
- `src/App.tsx`, `src/graph/layout.ts`, `src/graph/GraphCanvas.tsx`: page-session history snapshots with full browsing state; separate origins even for identical document URLs; restore focus without native scroll or graph reveal; preserve historical layout links and viewport on remount.
- `src/document/DocumentView.tsx`: retain the hidden memoized rendered subtree between tabs to meet the unchanged large-document tab-switch bound; unmount it normally on loading/error/close.
- `src/document/useDocument.ts`: stable per-opening ref identity plus retry attempt gates settled results; abort/stale protections retained; every loading request announces itself.
- `vite.config.ts`, `server/index.ts`, `playwright.config.ts`: malformed document-link SPA middleware for dev/preview; environment port overrides; independently owned API/web test servers, strict ports, no reuse, one worker.
- `tests/document-review.spec.ts`, `tests/document-history-review.spec.ts` (new), `tests/document-failure.spec.ts`, `tests/document-render.spec.ts`: review regressions and supported preview-mode test correction.
- `README.md`, this handoff, `docs/PRD_SLICE3.md` (integration caution only). Existing uncommitted Slice 2 work was preserved; no reset/stash/commit/push or staging occurred.

## Independent-review follow-up: pruned layout restoration

The independent reviewer found a P1 crash when Refresh removes a file while GraphCanvas is unmounted in Outline mode, then the user opens a remaining file and returns. `prune()` removed the node but left its ID in the layout's visible list; restoration passed `undefined` to d3-force.

Observed test-first correction:

- `npx tsx --test --test-name-pattern='snapshot after pruning' tests/unit/model.test.ts`: **1 failed**, `Cannot set properties of undefined (setting 'index')`, then **1 passed** after the fix. The regression also verifies surviving pins/positions and normalizes stale incoming snapshot IDs.
- `MD_MANAGER_WEB_PORT=5184 MD_MANAGER_API_PORT=3014 npx playwright test tests/document-history-review.spec.ts -g 'listing deletion'`: **2 failed → 2 passed**, covering Back to folder and native Back, restored focus, switching back to graph, and no page errors. The listing deletion is simulated at the entries response; no committed fixture is modified.
- Minimal production correction: filter missing visible IDs when capturing/restoring snapshots and missing pin IDs when restoring. Do not alter `prune()`'s visibility list in-place, which could incorrectly trigger `sync()`'s unchanged-list early return.

Post-fix independent review closed the P1 and found no new P0/P1/P2 issues. Independent validation then passed all **152 test executions** (48 unit/API/model + 52 dev + 52 preview), lint, build, and fixture/diff/staging checks. Slice 2 is ready as the Slice 3 implementation baseline, subject to the documented Linux and historical-TDD limitations.

Final review/validation artifacts are `slice2-final-review.md` and `slice2-final-validation.md` under workflow `5617530b-6f8e-459e-bcf5-e40a441d3c66` in the session's subagent outputs.

## Final independently verified checks (2026-09-19)

Ports were checked free before use. The existing development servers on 5173/3001 were not intentionally killed or reused; their own watchers may restart workers on source/config changes. Test-owned processes used separate ports and were stopped by Playwright. A short-lived worker-owned debug server was also cleaned up; no permanent alternate/random defaults were introduced.

```sh
npm run test:unit
# 48 tests, 0 failures
MD_MANAGER_WEB_PORT=5184 MD_MANAGER_API_PORT=3014 npm run test:e2e
# 52 passed, one worker, dev frontend
npm run lint
# clean
npm run build
# tsc -b + vite build OK
MD_MANAGER_TEST_PREVIEW=1 MD_MANAGER_WEB_PORT=4184 MD_MANAGER_API_PORT=3014 npm run test:e2e
# 52 passed, one worker, built preview frontend
git diff --check
# clean
git status --short -- fixtures/
# empty
git diff --cached --name-only
# empty
```

Both browser runs include all Slice 1 regressions, real malformed direct/reload links, safe Markdown rendering, owned scratch fixtures, and the >100 KB response/render/tab/return bounds. Chromium/reduced motion is the configured browser gate; no cross-browser or general-device performance claim is made.

## Security and integration contract

- Backend support is **Linux with procfs at `/proc/self/fd`**; startup checks platform, procfs type, no-follow support and descriptor access. Unsupported capability fails closed, with no pathname fallback.
- The configured fixture-root path/ancestors are trusted startup configuration (ancestor symlinks may be resolved there); the fixture root itself is opened no-follow and pinned for the app lifetime. Requests never choose that root. Every source/intermediate/final component is opened relative to its retained parent descriptor, using one lexically validated segment at a time. Symlink replacement before open is rejected; replacement after open reads the pinned original, never outside-source replacement bytes.
- `withMarkdownFile` scopes the operation to a checked regular-file descriptor. Source/parent/final handles survive through that operation and close afterwards; the root closes with Fastify. Missing, non-directory, and rejected-link errors are 404; unexpected operational errors are safe 500. Content/hash come from one Buffer, with no byte-to-text-to-byte rehash.
- Slice 3 must not turn this into “validate path, then pathname write/rename”. Descriptor-relative mutation/collision/atomic-replacement semantics need their own design and race tests. No future write API is implemented here. Preserve the new per-opening request lifetime and per-entry session snapshots when integrating drafts; the existing hash remains the acknowledged read hash.

## Behavioural notes and remaining limitations

- Identical filenames in different sources remain distinct. Identical document URLs opened from different browsing origins also remain distinct history entries; snapshots include selection, mode, expansion, positions/pins, viewport, outline scroll and focus. Browser Back does not force reveal/re-expansion/Fit.
- Direct links and reloads have no retained origin and fall back to the containing folder. Cross-reload browsing/layout restoration remains intentionally absent.
- Every reopening/retry starts loading without old content/error/hash, even for the same URL. Direct, reload, click, retry and history requests use the same announcement/abort/stale-result lifecycle.
- Malformed direct links now work in **both** supported Vite modes; the earlier documented acceptance gap and pushState-only substitute are removed.
- YAML frontmatter renders as ordinary Markdown; Source is verbatim. Only HTTPS images load; relative/HTTP images are unavailable, and relative assets/document navigation remain deferred. Remote images contact third-party servers.
- The document hash is exposed as `data-hash` for tests/integration, not displayed.
- The earlier mandatory all-behaviour historical TDD sequence is **not established**; this handoff corrects the claim rather than manufacturing retrospective evidence. The current corrections and final regression gates are recorded above. Independent review and post-fix validation are complete; no unresolved findings remain.
