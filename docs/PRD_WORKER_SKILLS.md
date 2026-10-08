# PRD: Worker skills (a lane's sessions load named Claude Code skills)

Status: Proposed 2026-10-08, from the operator's grill of 2026-10-08 ("update the workers to give access to skill and other things like advisor"). Ships as feature `worker-skills` (one lane, `engine`), merged to main before `viewer-refine` ([PRD_VIEWER_REFINE.md](PRD_VIEWER_REFINE.md)) launches, because the controller that launches a run is the one on main at launch. Decisions: `features/worker-skills/decisions.md`.

## 1. Problem

Every worker session starts with `--safe-mode` (`workflow/interactive.py`, `InteractiveSessions.run`), which disables every customization: user skills, plugins, hooks, MCP servers, `CLAUDE.md`. The controller pins what a worker needs into the prompt instead (the task, `decisions.md`, the project conventions above the operator-notes heading of `CLAUDE.md`). A worker also gets `--tools Read,Glob,Grep,Edit,Write[,Bash]`, so it has no `Skill` tool: even Claude Code's bundled skills are unreachable.

The operator wants a UI lane to work with the `impeccable` design skill (`~/.claude/skills/impeccable`, a symlink into the shared agent-memory clone), which is 160 kB of references the skill loads on demand: pasting it into the task is not an option, and a worker without the `Skill` tool cannot invoke it.

Probes on 2026-10-08 (Claude Code 2.1.293, this host):

| Launch | User skills | `--plugin-dir` skill | advisor | `--settings` deny list |
|---|---|---|---|---|
| `--safe-mode` (today) | none | ignored | present (the operator's `settings.json` still applies) | applies |
| `--setting-sources ""` + `--plugin-dir` | none | loaded (`<plugin>:impeccable`) | absent | applies |
| `--setting-sources ""` + `--plugin-dir` + `--settings {"advisorModel": …}` | none | loaded | present | applies |

So a lane can get exactly the skills it is given, nothing else from the operator's folders, by dropping `--safe-mode` for that lane and replacing it with `--setting-sources ""` (no user, project or local settings file: no hooks, no user MCP servers, no user skills) plus `--plugin-dir` and the `Skill` tool, and the advisor comes back through the `advisorModel` key in the `--settings` JSON the controller already passes.

## 2. Outcome

A feature's lane may declare `skills`. Its worker session, and every repair session of that lane, starts with those skills available through the `Skill` tool and nothing else from the operator's customizations, with the advisor the operator's settings give, the same deny list, pinned model and effort, tools and permissions as today. The skill text each session saw is pinned in the run directory and its digest recorded, like the worker settings. A lane without `skills` launches exactly as today, byte for byte.

## 3. Configuration (feature.json 2.8.0)

```json
{
  "version": "2.8.0",
  "workers": [
    {"node_id": "pages", "task": "pages-task.md", "skills": ["impeccable"]},
    {"node_id": "adapter", "task": "adapter-task.md", "model": "claude-sonnet-5-5", "effort": "medium"}
  ]
}
```

- `skills`: 1 to 8 names, each `^[a-z][a-z0-9-]{0,63}$`, unique. Refused on a version before 2.8.0 (the existing exact-match version-gate pattern: 2.8.0 joins every set that lists 2.7.0, see the shared learning `version-gates-are-sets-add-a-keeps-everything-test.md`). Omitted means no skills, the launch of today.
- A name resolves to `~/.claude/skills/<name>/SKILL.md` on the controller's host, symlinks followed. `launch --dry-run` and `prepare` refuse a name that does not resolve, naming it (`Blocked: lane pages names skill impeccable, but ~/.claude/skills/impeccable/SKILL.md does not exist`). Nothing is fetched or installed.
- `prepare` pins each lane's skills into `plan.nodes[<lane>].skills` as `[{name, sha256}]` where `sha256` is the digest of the pinned copy (section 4.2), so a later edit of the skill folder changes no running run.
- The schema `contracts/workflow/feature.schema.json` gains 2.8.0 and the `skills` key; `contracts/workflow/examples/` gains a 2.8.0 example that the contract test validates; `init` keeps writing 2.4.0.

## 4. Design

### 4.1 The launch of a skills lane

`InteractiveSessions.run` (worker) and `run_repair` (a repair session of the lane: "a worker of the lane in all but its task") build the same command as today with these differences, for a lane whose plan entry has `skills`:

- `--safe-mode` is replaced by `--setting-sources ""`.
- `--plugin-dir <run>/skills/<lane>` (section 4.2).
- `Skill` joins `--tools`.
- The `--settings` JSON (`sessions.worker_settings`) gains `"advisorModel": <value>` when the operator's `~/.claude/settings.json` has the key; only that key is read from the file, nothing else, and the file is never copied. A missing key means no advisor, as a plain session without it.
- `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`, the deny list, `role_flags`, `--permission-mode`, `--dangerously-skip-permissions` (automatic), the launch name, the prompt and the receipt are unchanged.

The advisor is already present in today's safe-mode sessions (the operator's settings apply there), so a lane without `skills` keeps it with no change.

### 4.2 The pinned plugin

At `prepare`, for each lane with `skills`, the controller writes `<run>/skills/<lane>/.claude-plugin/plugin.json` (`{"name": "workflow-<lane>", "description": "Skills pinned for lane <lane> of run <run id>", "version": "1.0.0"}`) and copies each named skill folder to `<run>/skills/<lane>/skills/<name>/` (a real copy, symlinks resolved, no file over 2 MB, no `.git`, nothing executable is made executable that was not). The lane's plugin digest is the sha256 over the sorted relative paths and contents of that tree; it is what `plan.nodes[<lane>].skills[].sha256` records per skill and what `plan.worker_authority` gains as `skills_sha256` (per lane), beside `worker_settings_sha256`. A run directory is private to the operator, so the copy is evidence like `<node>.prompt.txt`.

The skill's own launcher (`scripts/impeccable context`) is a script the session runs through Bash; it downloads a binary into `~/.impeccable/bin/` on first use. That is the session's business, not the controller's; the operator runs it once before launch so no worker waits on a download (decisions.md [G5]).

### 4.3 What a non-safe-mode session loads besides the plugin

Verified on this host with `--setting-sources ""` (probes of 2026-10-08, recorded in `features/worker-skills/decisions.md` [G3]): the session loads no user, project or local settings (so no hooks and no user MCP servers), no user skills, the `--settings` JSON still applies, and a session started in this repository reported no `CLAUDE.md` instructions in its context, the same answer a `--safe-mode` session gives. The engine lane re-checks the `CLAUDE.md` point with its own probe before relying on it, and the RUNBOOK states the guarantee a skills lane gets in exact words: if a non-safe-mode session turns out to read the worktree's `CLAUDE.md`, the operator-notes section would reach it, and the design challenge then decides between keeping it out (the lane finds the flag or environment that does) and narrowing the RUNBOOK's "no session gets this section" to lanes without `skills`. Auto-memory, keychain reads and background prefetches are Claude Code's own; a skills lane neither enables nor disables them beyond what `--setting-sources ""` does.

### 4.4 Records

- The lane receipt `<lane>.interactive.json` (and `repair-<n>.interactive.json`) gains `skills: [{name, sha256}]` beside `requested` (the lane's pins), `[]` for a lane without skills.
- `launch --dry-run` prints per lane its skills and the plugin directory it would write.
- `status` lists the skills per lane.
- The export is not changed by this feature: `viewer-refine`'s adapter lane exports `skills` with the lane pins (export 1.10.0, PRD_VIEWER_REFINE Appendix A), so two features never bump the export at once.

### 4.5 Refusals (nothing written)

A `skills` key on a version before 2.8.0; a name that does not match the pattern or is listed twice; a name that does not resolve; a skill folder over 8 MB in total; a `SKILL.md` that is not a regular file. Each refusal names the lane and the skill.

## 5. Out of scope

Skills for judges (reviewers, the challenge, the sidecar, the attack pass, the panel): they stay in safe mode. Fetching or installing a skill. A per-run allowlist of hooks or MCP servers. Docker or any sandbox (C14). The viewer and the export (viewer-refine).

## 6. Files

`workflow/interactive.py` (the two launches), `workflow/sessions.py` (`worker_settings`, `worker_authority`, the advisor key), `workflow/launch.py` and `workflow/pipeline.py` (prepare: resolve, copy, pin, refuse), `workflow/guardrails.py` or the module that validates feature.json versions (the 2.8.0 gate), `contracts/workflow/feature.schema.json` and `contracts/workflow/examples/`, `workflow/test_interactive.py`, `workflow/test_feature_launch.py`, `workflow/test_sessions.py` (or where the launch argv is asserted), `workflow/test_verification.py` (`PolicyLintTests` counts 13 feature policies with `worker-skills` and `viewer-refine`), `workflow/RUNBOOK.md` (section "Skills for a lane (feature.json 2.8.0)"), `workflow/README.md` (the feature.json table, the "What a worker can reach" paragraph), `docs/handoff/worker-skills.md`.

## 7. Acceptance (what the verifier and reviewers check)

1. A 2.8.0 feature with `skills: ["impeccable"]` on one lane prepares: the plugin tree exists under the run directory with the skill's `SKILL.md` and references, `plan.nodes.<lane>.skills` records name and digest, `worker_authority.skills_sha256` holds the lane's digest; the other lane's entry has `skills: []` and its launch argv is byte-for-byte today's (a test asserts the argv of both lanes, including `--safe-mode` on the plain lane and `--setting-sources ""`, `--plugin-dir`, `Skill` on the skills lane).
2. The repair session of the skills lane gets the same flags (a test on `run_repair`'s argv).
3. `advisorModel` is read from a settings file the test writes under a temporary `HOME`, never from the real one; absent key, absent flag.
4. Refusals of section 4.5, each with its message, before anything is written.
5. A 2.7.0 feature with `skills` is refused; every 2.7.0 feature without it launches unchanged (the gate-set test).
6. The contract test validates the 2.8.0 example; `test:contracts` green; the full workflow suite green.
