# MD Manager — PRD

**Status:** Agreed scope, ready for implementation planning.

## Goal

Evolve the existing fixture listing into a folder-style workspace for browsing, previewing, editing, and managing Pi and Claude Markdown files.

Deliver in three slices:
1. Improved folder UI
2. File selection and preview
3. File updates and management

## Scope boundaries

- Access only `fixtures/pi/` and `fixtures/claude/`.
- Identify files by **source + relative path**.
- Remain single-user and localhost-only.
- No live agent directories, search, comparison, synchronization, bulk operations, or persistent version history.
- Prevent traversal and symlink escapes for every read and mutation.

---

## Slice 1 — Folder UI

### Requirements
- Replace the table with a **folder browser using file and folder cards**.
- Home displays **Pi** and **Claude** source cards.
- A breadcrumb bar provides navigation, for example: `Home / Pi / skills`.
- Show the current directory’s immediate contents, with folders first and alphabetical ordering within each group.
- Include manual refresh; source navigation replaces a separate source filter.
- Use minimal developer-tool styling, system light/dark theme, and responsive layouts.
- Provide keyboard navigation, visible focus indicators, and loading, empty, and error states.
- Do not introduce search or a permanent two-pane layout.

### Acceptance criteria
- Users can navigate both fixture trees through cards and breadcrumbs.
- Empty directories remain navigable.
- Non-Markdown files do not appear as document cards.
- Refresh updates the displayed directory contents.
- Nested paths and duplicate filenames across sources remain unambiguous.

---

## Slice 2 — Select and Preview

### Requirements
- Selecting a Markdown file opens a dedicated document view.
- Display source, relative path, breadcrumbs, and **Back to folder**.
- Returning restores the previous folder position.
- Default to rendered Markdown, with a **Source** tab for exact text.
- Persist document selection in the URL for reloads, direct links, and browser history.
- Support GitHub-flavored Markdown.
- Disable embedded HTML.
- Open external links in a new tab.
- Support:
  - HTTPS images.
  - Relative images resolved within the selected fixture source through a restricted asset endpoint.
- Defer navigation through relative document links.
- Clearly handle empty files, missing files, failed reads, and broken images.

### Acceptance criteria
- All fixture Markdown files can be opened, including empty and nested files.
- Rendered and source views represent the selected file correctly.
- Direct links and back/forward navigation work.
- Local image requests cannot escape their fixture source.
- Embedded HTML is not executed or rendered as active HTML.

**Privacy consequence:** Remote images contact third-party servers when loaded.

---

## Slice 3 — File Updates and Management

### Editing and autosave
- Enter editing through an explicit **Edit** action.
- Use CodeMirror with Markdown syntax highlighting and Edit/Preview tabs.
- Autosave after **one second without typing**.
- Display **Unsaved / Saving / Saved / Error** status.
- Ctrl/Cmd+S triggers an immediate save.
- Flush pending changes before in-app navigation; block navigation if saving fails.
- Warn before browser departure while unsaved changes remain, where supported.
- Do not automatically format content.
- Preserve existing permissions and unchanged text formatting.

### Conflict protection and recovery
- Use content versions/hashes to reject stale saves.
- Stop autosave on conflict; never silently overwrite an external change.
- Offer reload and a way to copy the unsaved draft.
- Provide **Revert session changes**, restoring the content captured when Edit mode began.
- Apply conflict checks to reverts.
- Write through atomic replacement.
- No persistent backups or revision history.

### File operations
Within fixtures only:
- Create Markdown files and folders.
- Rename, move, and delete Markdown files.
- Rename, move, and delete empty folders.
- Copy individual Markdown files between Pi and Claude sources.
- Confirm deletion using the full source/path.
- Reject destination collisions; require another name or destination.
- Exclude recursive folder operations, bulk actions, and image uploads.

### Acceptance criteria
- Edits autosave and survive reload.
- Rapid edits cannot produce out-of-order writes or falsely report “Saved.”
- Failed saves retain the draft and show recovery guidance.
- External changes produce a conflict rather than an overwrite.
- Session revert restores the baseline when conflict checks pass.
- Each supported file operation updates the folder UI correctly.
- Invalid paths, source escapes, symlinks, and name collisions are rejected.
- Pending edits are resolved before an operation moves, renames, or deletes the active file.

**Recovery limits:** Abrupt browser closure may lose pending changes. Deleted files and edits from prior sessions have no built-in recovery.

---

## Delivery and Quality Gates

Each slice is independently reviewable and includes:
- Relevant API and browser tests.
- Keyboard-accessible interactions.
- Loading, empty, and failure-state coverage.
- Passing lint and production build.
- Updated usage and scope documentation.

**Prerequisite:** Restore browser-test execution on this VPS; Chromium currently cannot launch because `libatk-1.0.so.0` is missing.

Implementation has not started.
