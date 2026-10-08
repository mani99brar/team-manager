# Decisions: worker-skills

From the grill session of 2026-10-08 with the operator (one interview for `worker-skills` and `viewer-refine`; the operator decisions are the same in both files, the grill defaults are per feature).

## Operator decisions

- [O1] Q1: The data plumbing is in scope (an adapter lane) and the run page is the primary surface; the operator added a controller change so workers get skills and things like the advisor. Operator: "Yeah thats true but we also need the data plumbing and update the workers to give access to skill and other things like advisor".
- [O2] Q2: A controller change in an engine lane: feature.json 2.8.0 adds a per-lane `skills` key; for such a lane the controller builds a session-only plugin from the named folders under `~/.claude/skills/`, launches it without `--safe-mode` but with `--setting-sources ""`, `--plugin-dir` and the `Skill` tool; lanes without the key keep today's launch unchanged. Operator: "sounds good".
- [O3] Q3: A refinement of the Calm look; a redesign stays possible. Operator: "A refinement and a possible redesign, also does all workers run a dockered env?".
- [O4] Q4: The fix loop becomes part of the graph: each repair session its own node, each review round an attempt of the review node labelled with its delta base; the export gains repairs, review rounds and per-lane pins at a new contract version. Operator: "Yes".
- [O5] Q5: This work supersedes the unfinished viewer slice S7 (`features/viewer-ux-depth`) and the 8 open P2s of `viewer-revamp-008`; the operator deletes `viewer-ux-depth` by hand afterwards. Operator: "yes".
- [O6] Read-back 2026-10-08: confirmed every grill default and deferral as written (no change). Operator: "looks good to me".

## Grill defaults

- [G1] Two features in order, not one run [added, not asked]: the controller that launches a run is the one on main at launch, so a UI lane cannot use a skills launch an engine lane of the same run is still writing. `worker-skills` (this feature, one `engine` lane) is merged to main first; `viewer-refine` follows with `skills: ["impeccable"]` on its UI lanes.
- [G2] The advisor needs no new mechanism for lanes in safe mode: the operator's `~/.claude/settings.json` applies there, and the transcripts of `attention-notify-003` and `multi-provider-panel-002` show every worker and reviewer session calling it 1 to 3 times. A skills lane gets it back through `advisorModel` in the worker `--settings` JSON (PRD 4.1).
- [G3] Probes of 2026-10-08 on this host (Claude Code 2.1.293, `claude -p` from the repository, `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`): (a) `--safe-mode --tools Read,Glob,Grep,Skill` lists only bundled skills; `--plugin-dir` adds nothing under `--safe-mode`. (b) `--setting-sources "" --plugin-dir <plugin with skills/impeccable>` lists `<plugin>:impeccable` plus the bundled skills and no skill from `~/.claude/skills/`. (c) Under (b) the tools are `Glob, Grep, Read, Skill`: no advisor; with `--settings '{"advisorModel":"fable", ...}'` the advisor is back; a `Read(~/.ssh/**)` deny in the same `--settings` is enforced (`READ: denied`). (d) Under `--setting-sources ""` the session reported no `CLAUDE.md` instructions in its context, as a `--safe-mode` session does. The engine lane re-checks (d) itself.
- [G4] The pinned plugin is a real copy under `<run>/skills/<lane>/` with its digest in `plan.nodes[<lane>].skills` and `worker_authority.skills_sha256` (PRD 4.2): a later edit of the operator's skill folder changes no running run, and the copy is run evidence like the prompt.
- [G5] The impeccable launcher's binary (`scripts/impeccable context`, downloaded once into `~/.impeccable/bin/`) is fetched by the operator before `viewer-refine` launches, not by a worker and not by the controller.
- [G6] Judges stay in safe mode; skills are a worker-and-repair-session facility only.
- [G7] Launch flags: `--profile attended`, `--fix-rounds 2`, the RUNBOOK canary first (first run after a controller change), launched from `~/dev/md-manager`, not from a worktree, and not on the same box as the three pilots of the learnings build.
- [G8] `workflow/test_verification.py` `PolicyLintTests` counts 13 feature policies as of the commit that adds `worker-skills` and `viewer-refine` (changed with the feature files, so main stays green; the untracked `features/shadow-panel/` is the operator's and is not counted).

## Changes after launch

None yet.

## Deferred

- Skills for judges (reviewers, challenge, sidecar, attack, panel).
- A per-run allowlist of hooks or MCP servers for a lane.
- Docker or any sandbox for workers (C14 of `docs/WORKFLOW_IMPROVEMENTS.md`); the exerciser (C38) after the three pilots.
- Fetching or installing a skill the host does not have.
