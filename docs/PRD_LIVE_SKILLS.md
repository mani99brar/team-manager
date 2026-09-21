# PRD: Live Pi and Claude skills

Status: Draft for approval — implementation has not started.

## 1. Goal

Replace the fixture-only experience with browsing and managing real Markdown skills on this VPS. Preserve the existing graph, outline, document viewer, editor and bounded file operations. Keep Pi and Claude as the only top-level sources, with multiple configurable filesystem locations underneath them.

Success: the user can open the app through an SSH tunnel, find a real skill, edit it explicitly, and see the saved change at its original filesystem location without copying files into this repository.

## 2. Confirmed requirements

- Include personal, package/plugin-provided and project-specific skills for both agents.
- Allow additional locations through configuration without application code changes.
- Do not add UI for creating sources or attaching filesystem locations.
- New folder remains the existing operation: create a directory inside a configured location.
- Allow all existing file operations. No backups or trash are required.
- Manual Refresh is sufficient; no filesystem watching.
- Localhost-only, single-user access through an SSH tunnel.
- Develop using TDD. Automated tests must never mutate live skill directories.

## 3. Observed filesystem inventory

Read-only inspection found:

| Location | Category |
| --- | --- |
| `/home/agentops/.pi/agent/skills` | Personal Pi skills, including explain-diff, herdr-notes and team-prd |
| `/home/agentops/.pi/agent/npm/node_modules/pi-subagents/skills` | Package skills: council-mode and pi-subagents |
| `/home/agentops/.pi/agent/npm/node_modules/pi-mcp-adapter/skills` | Package skill: mcp-scripting |
| `/home/agentops/.claude/skills` | Personal/synced Claude skills, including nested synced collections |
| `/home/agentops/.claude/plugins/synced` | Synced plugin skills |
| `/home/agentops/.claude/plugins/marketplaces` | Marketplace/plugin skill definitions present on disk |
| `/home/agentops/dev/agent-workflow/.pi/skills` | Project-specific Pi skills |

This is an initial inventory, not proof that every definition is enabled or currently loaded by an agent. The UI must not claim activation. Before producing the local configuration, perform a bounded discovery pass for additional skill roots within the known agent directories and project directories. Avoid sessions, caches, `.git`, and unrelated dependency trees. Do not read agent credentials or session contents.

For plugin trees, configure individual `skills` directories, not whole marketplace repositories. Likewise, configure individual package skill roots instead of exposing all of `node_modules`. Use deterministic, stable IDs and useful labels. Discovery is a setup activity, not an automatic whole-home scan on every Refresh. Newly installed packages/projects require a configuration update and restart in this release.

## 4. Source and location model

Hierarchy:

```text
Pi
  Personal skills
    explain-diff/SKILL.md
  Package: pi-subagents
    council-mode/SKILL.md
  Project: agent-workflow
    agent-workflow/SKILL.md
Claude
  Personal and synced skills
    synced/.../pdf/SKILL.md
  Plugin: design
    ux-copy/SKILL.md
```

Pi/Claude and configured location nodes are virtual navigation boundaries, not ordinary mutable folders. Every real file/directory belongs to one location.

Identity is `(source, locationId, relativePath)`, never label or absolute filesystem path. Duplicate filenames and relative paths in different locations must remain distinct throughout graph state, URLs, requests and editor sessions. Labels can change without breaking bookmarks; location IDs must remain stable.

### Configuration

Proposed contract:

- `MD_MANAGER_CONFIG` selects a JSON configuration file, read once at startup.
- Default config path: `$HOME/.config/md-manager/sources.json`.
- Paths must be absolute; no shell expansion, glob execution or request-selected roots.
- Each location has a unique stable ID, source (`Pi` or `Claude`), label, path and category (`personal`, `package`, `plugin`, `project`).
- Adding another location requires editing the config and restarting, not changing code.
- Missing/invalid configuration fails startup with an actionable local diagnostic. Never silently fall back to fixtures.
- Duplicate IDs and duplicate/overlapping roots are rejected, including resolved aliases. This avoids duplicate file identities and ambiguous mutation boundaries.
- A syntactically valid location that is temporarily missing or unreadable is shown as unavailable; healthy locations remain usable. Refresh retries unavailable locations.

Example (abbreviated; the actual local config includes the discovered plugin/package roots):

```json
{
  "version": 1,
  "locations": [
    {
      "id": "pi-personal",
      "source": "Pi",
      "label": "Personal skills",
      "path": "/home/agentops/.pi/agent/skills",
      "category": "personal"
    },
    {
      "id": "pi-subagents",
      "source": "Pi",
      "label": "Package: pi-subagents",
      "path": "/home/agentops/.pi/agent/npm/node_modules/pi-subagents/skills",
      "category": "package"
    },
    {
      "id": "claude-personal",
      "source": "Claude",
      "label": "Personal and synced skills",
      "path": "/home/agentops/.claude/skills",
      "category": "personal"
    }
  ]
}
```

Keep the machine-specific live config outside the repository. Commit an example config and setup documentation. Preserve explicit fixture mode for demos/regressions via `MD_MANAGER_FIXTURE_ROOT`; specifying it together with `MD_MANAGER_CONFIG` is an error. Automated tests must explicitly select their isolated config or fixture root, never discover the user's default config.

## 5. Functional requirements

### Listing and navigation

- List regular `.md` files case-insensitively, directories and empty directories recursively inside each location.
- Exclude `.git` directories at any depth. Preserve the existing exclusion of symlinks and non-Markdown files. Other dot directories remain eligible.
- Do not parse frontmatter to decide eligibility. Nested skill references and other Markdown documents within a skills root are included.
- Use Pi then Claude, configured location order, then existing byte-wise child ordering.
- Graph and outline show distinct location nodes and their labels. Counts and breadcrumbs respect location boundaries.
- Show a per-location unavailable state without hiding healthy locations or representing unavailable data as an empty directory.
- Refresh updates listing and availability while preserving surviving selection, expansion and positions. It must not discard or overwrite an unsaved editor draft.
- Existing open/reload behavior fetches current document contents; listing refresh alone does not silently replace editor content.

### Read and edit

- Read/write the original file directly; no import, fixture copy or mirrored working directory.
- Preserve explicit Save, hash conflict detection, byte/line-ending behavior, draft handling, request limits and safe Markdown rendering.
- Show source, location label and relative path so users can distinguish identically named files.
- Show a persistent notice for package/plugin locations: edits affect installed files and may be overwritten by updates or sync. This does not make them read-only.

### File operations

- Create file/folder within a selected location or descendant directory.
- At Pi/Claude virtual roots, require choosing a location before creation; never guess a destination.
- Rename, delete and move retain existing restrictions: regular Markdown files or empty directories only; no recursive mutations or overwrites.
- Move stays within one configured location. Cross-location moves are out of scope.
- Copy retains existing cross-agent behavior: choose a destination location and folder under the other source. Copy saved bytes, not the draft. Same-agent cross-location copy is out of scope for this release.
- Source and location nodes cannot be renamed, moved, deleted or copied as filesystem objects.
- Preserve delete confirmation, unsaved-change restrictions, server-authoritative validation and post-mutation refresh behavior.
- No backups, trash or new recovery guarantees. Explain irreversible deletion and package update risks.

### URLs and API

- Proposed document URL: `/file/<source>/<locationId>/<relative-path-segments>`.
- Proposed browsing URL: `/browse/<source>/<locationId>/<relative-path-segments>`; a location root has no relative path.
- Encode/decode path segments exactly once. Preserve literal percent signs, Unicode and special characters.
- Every file/mutation request identifies a configured location; copy identifies both locations. Validate consistency between source and location ID.
- Listing returns location metadata and per-location status along with entries. Responses do not expose absolute root paths.
- Unknown or removed location IDs yield safe unavailable/not-found states; never guess a new location.
- Live mode does not reinterpret old fixture bookmarks as real files. Show an actionable legacy-link explanation. Explicit fixture mode may preserve old fixture URLs for compatibility.

## 6. Filesystem and deployment safety

- Retain Linux/procfs descriptor-anchored reads and mutation boundaries, generalized to independently configured roots. Do not replace them with string-prefix containment checks.
- Root configuration is trusted administrator input; request parameters are not. Reject traversal, absolute request paths, invalid components and unknown locations.
- Keep no-follow protections for location roots and descendants. Trusted configured-path ancestors retain the existing documented startup trust model.
- A root replaced after opening must never redirect an in-flight operation to an unvalidated target. Root handles must be closed on shutdown and on failed initialization.
- Retain atomic staging/hash checks and existing documented external-writer race limitations; do not promise OS-wide compare-and-swap.
- Deny mutations to excluded `.git` content even if addressed directly through the API.
- UI/API errors must not leak absolute filesystem paths, file content or stack traces. Local startup diagnostics may identify invalid configured paths.
- Bind both API and frontend to loopback; no public listener or new authentication system. No permissive cross-origin access. Document SSH forwarding.
- Do not modify installed skills while developing or testing. An eventual live smoke check is read-only unless the user explicitly authorizes a separate write exercise.

## 7. Acceptance scenarios

| ID | Scenario | Expected result |
| --- | --- | --- |
| A1 | Start with config pointing at two unrelated temporary directories | Both appear under their configured Pi/Claude locations; repository fixtures are absent |
| A2 | Add another location and restart without code changes | New location appears and its Markdown files can be opened |
| A3 | Two locations contain `review/SKILL.md` | Distinct nodes, URLs, content and save destinations |
| A4 | Open and save a skill | Only its original configured file changes; fixture files and other locations remain unchanged |
| A5 | Create a folder inside a location | Directory is created there; selecting a virtual source alone cannot create an arbitrary root |
| A6 | Rename/move/delete a file or empty folder; copy to the other agent | Existing restrictions hold; explicit destination location receives the saved bytes |
| A7 | Attempt to mutate a location/source node or move across locations | Refused without touching disk |
| A8 | External edit occurs before Save | Hash conflict; draft retained; external file not silently overwritten |
| A9 | External files are added/removed, then Refresh | Listing updates without resetting surviving browse state or losing an unsaved draft |
| A10 | One location is missing/unreadable | Its error is visible; healthy locations work; restoring it and refreshing recovers |
| A11 | Unsafe path, source/location mismatch, symlink or excluded `.git` path is requested | Safe rejection; no outside data read or changed |
| A12 | Open nested filenames with spaces, Unicode, `%`, `#` or `?` | Direct links, reloads and history resolve the same file |
| A13 | Browse an installed package/plugin location | Update/sync warning is visible; existing operations remain available |
| A14 | Config is invalid, conflicting, duplicate or overlapping | Clear startup failure; no fixture fallback or mutation |
| A15 | Run automated tests with a live config present in HOME | Tests use only explicit isolated roots; no live skill writes or discovery |
| A16 | Inspect listening addresses and tunnel instructions | App is accessible through the tunnel; servers bind only to loopback |
| A17 | Open an old fixture URL in live mode | Explanation, not an accidentally matched live document |

## 8. TDD implementation plan

For each slice: write the acceptance/regression tests first, run and record the expected behavioral failure, implement the minimum fix, rerun to green, then refactor with tests passing. A compile error alone is not sufficient red evidence. Record commands, test names and outcomes; do not retroactively claim existing passing tests as new TDD evidence.

### Slice 1 — Configuration and location registry

- Unit tests first: parsing, deterministic IDs/order, source validation, absolute paths, duplicates/overlaps, missing config, conflicting modes and environment isolation.
- Implement registry/config loader and explicit fixture compatibility adapter.
- Use temporary directories; prove default live config cannot influence tests.

### Slice 2 — Multi-root backend

- API tests first: listing/status, duplicate relative paths, reads, all mutation routes, copy destinations, conflicts, unavailable-root recovery and handle cleanup.
- Parameterize the existing traversal/symlink/write-failure suites across unrelated roots.
- Assert rejected operations preserve bytes throughout all roots and an outside sentinel directory.
- Implement per-location descriptor boundaries and location-aware API contracts.

### Slice 3 — Navigation and live-file UI

- Model/routing tests first for location identity, graph/outline structure, breadcrumbs, URLs and legacy links.
- Browser tests first for multiple locations, unavailable states, creation location selection, copy destination selection and installed-file warnings.
- Update the existing UI rather than replace browsing/editor behavior.

### Slice 4 — Regression and rollout

- Browser tests prove save/create/rename/move/delete/copy hit isolated external roots, not fixtures.
- Re-run existing editor conflict, save/recovery and navigation regressions using location-aware identities.
- Provide generated temporary test configurations to both API and browser server processes; include guaranteed teardown on failure.
- Perform bounded read-only inventory, prepare the external live config, and document setup/restart and SSH tunnel access.
- Read-only smoke check against actual configured roots: listing and opening representative personal, package/plugin and project documents.

### Release gates

- `npm run test:unit`
- `npm run test:e2e` using explicit isolated test configuration and owned free ports
- `npm run lint`
- `npm run build`
- Production-preview browser suite using isolated roots
- `git diff --check`
- `git status --short -- fixtures/` remains empty
- Test harness evidence establishes all mutation roots are test-owned temporary directories; no automated tests use live skill paths.

## 9. Non-goals and limits

No additional top-level source types, GUI location attachment, automatic continuous skill discovery, agent activation management, search, watchers, autosave, backups/trash, recursive folder operations, same-agent cross-location copy, cross-location move, multi-user access or remote filesystem protocols.

Only Markdown content is managed. Copying `SKILL.md` does not install a complete skill or copy its scripts/assets. Showing marketplace files does not mean the corresponding plugin is enabled. Package/synced files may be replaced externally. Existing editor recovery and external-write race limitations remain documented.

## 10. Proposed defaults requiring PRD approval

The following make the confirmed scope implementable without further feature expansion: config-only attachment with restart; explicit location nodes; fail startup for invalid config but tolerate unavailable roots; skip `.git`; refuse overlapping roots; moves stay within a location; cross-agent copy gains a destination-location selector; package/plugin roots are individually enumerated during setup. These are proposed acceptance decisions, not claims that implementation already exists.
