# Engine worker: skills for a lane (PRD_WORKER_SKILLS)

## Goal

A feature.json 2.8.0 lane may declare `skills: ["<name>", ...]`. Its worker session and every repair session of that lane start without `--safe-mode`, with `--setting-sources ""`, `--plugin-dir <run>/skills/<lane>` (a plugin the controller pins at prepare from `~/.claude/skills/<name>/`, symlinks resolved), the `Skill` tool, and `advisorModel` in the worker `--settings` when the operator's `~/.claude/settings.json` has that key. Everything else of the launch (deny list, `--strict-mcp-config`, pinned model and effort, permissions, launch name, prompt, receipt) is unchanged, and a lane without `skills`, and every feature before 2.8.0, launches byte for byte as today. `docs/PRD_WORKER_SKILLS.md` sections 3, 4 and 7 are the specification; `features/worker-skills/decisions.md` records the operator's decisions and the probes behind the design.

## Context

- The two launches: `workflow/interactive.py` `InteractiveSessions.run` (the worker) and `run_repair` (a repair session, "a worker of the lane in all but its task"). The settings and deny list: `workflow/sessions.py` `worker_settings`, `background_settings`, `worker_authority`; the lane pins: `lane_pins`, `role_flags`. The feature.json version gates are exact-match sets spread over `workflow/` (shared learning `version-gates-are-sets-add-a-keeps-everything-test.md` in `~/.local/share/agent-memory/repo/learnings/`): adding 2.8.0 means adding it to every set that lists 2.7.0, and one test that every 2.7.0 feature still launches unchanged.
- The 2.7.0 lane keys `model` and `effort` (feature.json 2.7.0, `contracts/workflow/feature.schema.json`, RUNBOOK "Per-lane model and effort") are the precedent for a per-lane key: follow how they are validated, pinned into `plan.nodes[<lane>]`, printed by `launch --dry-run` and recorded in the receipt (`requested`).
- Probes of 2026-10-08 (decisions.md [G3]): `--safe-mode` ignores `--plugin-dir`; `--setting-sources ""` plus `--plugin-dir` loads the plugin's skill and no user skill; the advisor disappears under `--setting-sources ""` and comes back with `"advisorModel"` in the `--settings` JSON; the deny list in `--settings` still applies; a session with `--setting-sources ""` reported no `CLAUDE.md` in its context. Re-check the `CLAUDE.md` point yourself (a probe is a `claude -p` call; do not rely on the record alone) and write the exact guarantee into the RUNBOOK section.
- Tests isolate every path under a temporary directory and a temporary `HOME`; `advisorModel` is read from a settings file the test writes, never from the real `~/.claude/settings.json`; nothing touches the real `~/.claude`, `~/.config/md-manager/` or systemd.

## Design (settled)

- Schema: `contracts/workflow/feature.schema.json` gains version `2.8.0` and, on a worker, `skills` (1 to 8 unique names matching `^[a-z][a-z0-9-]{0,63}$`); a 2.8.0 example under `contracts/workflow/examples/` that `test:contracts` validates. `init` keeps writing 2.4.0.
- Prepare: each name resolves to `~/.claude/skills/<name>/SKILL.md` (symlinks followed); the controller copies the folder to `<run>/skills/<lane>/skills/<name>/` and writes `<run>/skills/<lane>/.claude-plugin/plugin.json` `{"name": "workflow-<lane>", "description": "Skills pinned for lane <lane> of run <run id>", "version": "1.0.0"}`; `plan.nodes[<lane>].skills = [{name, sha256}]` and `plan.worker_authority.skills_sha256[<lane>]` record the digest (PRD 4.2). Refusals (PRD 4.5) happen before anything is written and name the lane and the skill.
- Launch: for a lane with `skills`, `--safe-mode` becomes `--setting-sources ""`; add `--plugin-dir <run>/skills/<lane>`; `Skill` joins `--tools`; `worker_settings` gains `advisorModel` when the operator's settings file has it (only that key is read). Same for `run_repair` of that lane. The receipt gains `skills: [{name, sha256}]` (`[]` without).
- Docs: RUNBOOK section "Skills for a lane (feature.json 2.8.0)" (what loads, what does not, the `CLAUDE.md` guarantee, the advisor, the pinned copy, the refusals) and the README's feature.json table and "What a worker can reach" paragraph. `docs/handoff/worker-skills.md`: what changed, the probes you ran with their exact commands and answers, every open P2.
- `workflow/test_verification.py` `PolicyLintTests` already counts 13 feature policies (`worker-skills` and `viewer-refine` are committed); keep it right if you add a feature fixture under `features/`.

## Constraints

- Owned paths only: `workflow`, `contracts/workflow`, `docs/handoff/worker-skills.md`. Do not touch `contracts/projects`, `server`, `src` or the export (`workflow/export_state.py` stays as it is: the export of skills is `viewer-refine`'s adapter lane, PRD_VIEWER_REFINE Appendix A).
- Judges (reviewers, challenge, sidecar, attack, panel) stay in safe mode. No fetching or installing of skills. No change to the deny list's content.
- Module docstrings cite the RUNBOOK section they implement; one behaviour per commit is not required of you (the controller captures your worktree), but keep the diff readable.

## Acceptance

PRD_WORKER_SKILLS section 7, each with a test the verifier runs through `workflow-unit`:
1. A 2.8.0 feature with `skills: ["<name>"]` on one of two lanes prepares the plugin tree, pins name and digest in `plan.nodes.<lane>.skills` and `worker_authority.skills_sha256`, and the launch argv of both lanes is asserted in full (the plain lane identical to today's, the skills lane with the three flag changes and `Skill` in the tools).
2. `run_repair` of the skills lane gets the same flags.
3. `advisorModel` from a temporary `HOME`'s settings file; absent key, absent flag.
4. Each refusal of PRD 4.5 with its message, nothing written.
5. A 2.7.0 feature with `skills` is refused; a test that every 2.7.0 feature still launches unchanged after 2.8.0 joins the gate sets.
6. `test:contracts` validates the 2.8.0 example; the full workflow suite is green.

Run targeted tests while iterating, then this lane's non-browser policy checks once before writing the completion; run browser specs only through check-report on this lane's own specs.

## Stop

Stop and report `blocked` when a skills lane cannot be kept from loading the operator's hooks, user skills or MCP servers under `--setting-sources ""` (the deny list must still apply), when the `CLAUDE.md` probe shows the operator-notes section reaching a session and no flag keeps it out (report the probe; the design challenge's note decides), or when adding 2.8.0 would change the launch of any existing feature. Do not widen scope to judges, the export, the viewer or a sandbox.
