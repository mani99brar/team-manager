# Handoff: run-teams lane A (team reader and the `/teams` route)

Branch `rt/teams`. PRD sections: docs/PRD_RUN_TEAMS.md "Team reader" (contract Appendix A, `contracts/projects/teams.ts`, unchanged).

## What was built

- **`server/teams.ts`** (new): `TeamReader` reads Claude Code's Workflow-tool records for the run's Claude sessions and returns the `teams` payload.
  - Claude home: `claudeHomeOf(env, home)` = `MD_MANAGER_CLAUDE_HOME` || `CLAUDE_CONFIG_DIR` || `<home>/.claude`; records under `<claudeHome>/projects`.
  - Rows: `teamSessionRows` keeps the sessions payload rows with role worker, repair, challenge, reviewer, sidecar or attack (and `critique`, should it become a role), an `ID_PATTERN` session id, and a transport that is not `pi` or `openrouter`. The payload's order is kept.
  - Worktrees: `readSessionWorktrees(directory, rows)` reads `<lane>.interactive.json`, `<lane>.launch-<n>.receipt.json` or `repair-<n>.interactive.json`, depending on the row key. A row without a worktree gets its edited files redacted.
  - Folder index: sid -> every `<projects>/<slug>/<sid>/` real directory (lstat; symlinks and non-directories are ignored). Cached 30 s and rebuilt on a miss at most every 5 s (injected clock). Every slug folder of a session is read, so the case where the script sits under the other slug is covered.
  - Final records (`workflows/wf_<id>.json`): the status word (completed, failed or killed; anything else is interrupted). Agents come from `workflow_agent` entries: `start` -> queued, `progress` -> interrupted (a final workflow is never running), `done` -> done, and a journal `failed` line -> failed. A duplicate or missing index is renumbered to the next free index. `files_edited` and `providers` come from the agent transcript when its live folder is still on disk. Phases come from `phases[]`, else the `workflow_phase` entries, else the script.
  - Live records (`subagents/workflows/wf_<id>/`): journal `started` lines in order, `result` -> done, `failed` -> failed, else running or interrupted. The workflow is running when the journal or an agent transcript changed within 15 min of now and the session row is not stopped, succeeded or failed. Each agent's label, phase, model and worktree come from `agent-<id>.meta.json`. Transcript facts are streamed: only `"tool_use"` lines are parsed for tools, the last `"usage"` line gives the context size and model, and times come from the first line and the last complete line. At most 64 MiB is read per file, and torn or spliced lines are skipped. Facts are cached per (path, mtimeMs, size). Phase titles and the name and description come from the script's `meta` literal (`parseScriptMeta`, a tolerant tokenizer and literal parser that evaluates nothing); otherwise the journal's phase order is used.
  - Limits: 400 agents (`agents_more`), 50 files (`files_edited_more`), 10 providers, 50 logs of 300 chars, workflow `result_preview` 600, agent previews 400, tool summary 60, `error` = first non-blank line, 300 chars. All text goes through `redactText`, including labels, phase titles, names and descriptions.
  - Empty and unreadable states: no folder, or no readable workflow records -> `records: 'none'`. A folder that cannot be listed (EACCES), or an unreadable projects folder -> `records: 'unreadable'` with the fixed reason "The session folder could not be read".
  - Totals: `teamTotals` computes them exactly as `validateTeams` does.
- **Route**: `GET|HEAD /api/projects/:p/workflows/:w/runs/:r/teams` in `server/projectRoutes.ts` (added to `paths`, so other methods get 405) -> `conform(schemas.teams, crossChecked(() => validateTeams(x)))`. `RunStore.teams(scope, runId)` in `server/projects.ts` calls `this.sessions()` (so a missing run is the usual 404 RUN_NOT_FOUND), reads the worktrees, then calls the reader. The reader instance lives on the store, so its caches persist between requests.
- **Wiring**: `RunStoreOptions.claudeHome` and `teamsNow` (default `<home>/.claude`). `AppOptions.runStore` passes both through. `server/index.ts` sets `claudeHome: claudeHomeOf(process.env, homedir())`.
- **Test isolation**: `MD_MANAGER_CLAUDE_HOME=<test root>/claude-home` is set in the root `playwright.config.ts` (API env), in `tests/project-workflows/playwright.config.ts` (`apiEnv`, which the controls pair also spreads, both phases), and in `tests/project-workflows/{sessions,dispatch,controls}-app.ts`. E2e runs never read the operator's `~/.claude`. The folder does not exist until a seed writes it, which gives `records: 'none'`.
- **Docs**: rows for `/sessions` (it was missing) and `/teams` in the API table of `contracts/projects/README.md`.

## Files

`server/teams.ts` (new), `server/teams.test.ts` (new), `server/projects.ts`, `server/projectRoutes.ts`, `server/app.ts`, `server/index.ts`, `contracts/projects/README.md`, `playwright.config.ts`, `tests/project-workflows/playwright.config.ts`, `tests/project-workflows/{sessions,dispatch,controls}-app.ts`, this file.

## Tests

- `npx --no-install tsx --test server/teams.test.ts server/sessions.test.ts server/projects.test.ts`: 160 tests, 160 pass (15 are in `teams.test.ts`). They cover: a final completed workflow; a killed workflow (progress -> interrupted, start -> queued, redacted first-line error); an unknown status -> interrupted; a journal failed agent; a cached agent; repeated labels; 450 agents -> 400 + `agents_more` 50; a torn last line plus spliced lines; two slug folders (the script under the other slug, with trailing code after `meta`); live running, interrupted 20 min later, interrupted when stopped, interrupted with old mtimes; providers (pi, muse, agy); files relative to the session or isolated worktree, absolute paths redacted, no `/home/` or `/tmp/` in the JSON; more than 50 files; the index refresh on a miss; a symlinked session folder ignored; chmod 000 -> unreadable (expects `found` when run as root); row filtering; Claude home resolution; HTTP GET and HEAD 200 (validated by `validateTeams`, worktree from the lane receipt), PROJECT/WORKFLOW/RUN 404, POST/PUT/PATCH/DELETE 405.
- `npx --no-install tsx --test server/app.test.ts`: 3 pass.
- `npm run test:contracts`: 58 pass (the contracts are unchanged).
- `npx --no-install tsc -b`: clean. `npx --no-install eslint` on every changed file: clean.
- A read-only smoke run against this host's real `~/.claude/projects` printed only aggregates: 133 sessions, 14 with teams, 63 workflows (55 completed, 3 killed, 1 failed, 4 live running), 477 agents. The payload passed `validateTeams` and contained neither `/home/` nor `/tmp/`. The cold read took 5.8 s for all 133 sessions, the warm read 1.1 s. A run has a handful of sessions.

## Known gaps

- When a final record has no live folder (Claude Code pruned it, or it never existed), its agents have no `files_edited` or `providers`. The summary itself carries neither.
- A live agent has no `prompt_preview`, `last_tool_summary` or `attempt`. Those exist only in the final summary, and the transcript text is not read for them.
- Final records are re-read on every request (only the folder index and transcript facts are cached). Summaries are at most about 1 MB, and the route stacks on `sessions()`, which re-projects the run.
- Edits made through Bash are invisible, as the contract notes.
- `pi` is reported only when `--model <m>` is present; `muse` and `agy` are reported with or without it.

## For the integrator

- Client: `src/projects/api.ts` needs the path and a fetcher. The worker-phase mock (`tests/project-workflows/mock.ts`, `fixtures/index.ts` `UxPayloads` / `mergePayloads`) has to serve `teams`. A candidate-phase seed should write a Claude home under `<root>/claude-home/projects/<slug>/<sid>/...` for the sessions it names. The env var is already set.
- No contract changes.
