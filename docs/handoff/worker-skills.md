# Handoff: worker skills (feature.json 2.8.0)

Engine lane of run `worker-skills-001`. Implements PRD_WORKER_SKILLS: a feature.json 2.8.0 lane may declare
`skills: ["<name>", ...]`; its worker and every repair session launch without `--safe-mode`, with
`--setting-sources ""`, `--plugin-dir <run>/skills/<lane>`, the `Skill` tool and the advisor, loading those skills
and nothing else of the operator's customizations. A lane without `skills`, and every feature before 2.8.0,
launches byte for byte as today.

## What changed

- `workflow/skills.py` (new): resolve/check/copy/digest the named skills and read `advisorModel`. Pure functions;
  `skills_root` and `home` injected so tests never touch the real `~/.claude`.
- `workflow/sessions.py`: `worker_settings(directory, *, skills_lane=None, advisor_model=None)` — the plain call is
  byte-for-byte today's; the skills variant adds `Edit(/<run>/skills/<lane>/**)` and `Write(/<run>/skills/<lane>/**)`
  denies (decisions.md [L1] g) and `advisorModel` when the plan pinned one. `worker_authority(directory, skills=None)` keeps
  `worker_settings_sha256` as the plain digest and adds `skills_sha256[<lane>]` (whole plugin tree) and
  `skills_settings_sha256[<lane>]`. New `lane_skills(plan, node)`. `ClaudeSessions.run` refuses a skills lane on the
  print transport (note 9).
- `workflow/interactive.py`: `worker_launch_flags` builds the skills vs plain launch; `run` and `run_repair` use it;
  both receipts gain `skills` (`[]` without). The advisor is read from `plan.nodes[<lane>].advisor_model`, never the
  file.
- `workflow/launch.py`: version gates (`CRITICAL_VERSIONS`, `LANE_ROLE_VERSIONS` gain 2.8.0; new `SKILLS_VERSIONS`);
  `lane_skills(manifest)` refuses `skills` before 2.8.0 in `load_feature`; `launch_commands` resolves and checks each
  lane's skills before any Git action and forwards `--lane-skills <lane>=a,b`; the dry run prints per-lane skills and
  the plugin dir, and a note that `advisorModel` is read at prepare — it does not read `~/.claude/settings.json`
  ([L1] b: launch and `launch --dry-run` read the plan, never the file).
- `workflow/pipeline.py`: preflight `required_flags` gain `--setting-sources` and `--plugin-dir` (note c, so a skills
  session's flags are proven on the installed CLI). Prepare parses `--lane-skills`, re-checks each skill before the run
  directory exists (note 3), then copies the plugin tree, writes `plugin.json`, pins `plan.nodes[<lane>].skills`
  (name + per-skill digest) and `.advisor_model`, and records `worker_authority` with the skills digests. `status`
  lists the skills per lane.
- Version-gate sets that list 2.7.0 all gain 2.8.0: `guardrails.GUARDED_VERSIONS`, `sidecar.SIDECAR_VERSIONS`,
  `attack.ATTACK_VERSIONS`, `panel.PANEL_VERSIONS`, the schema title/enum/description, `contract.test.ts:168` plus
  2.8.0 parse cases and the `examples/feature.2.8.0.json` validation, `workflow-grill/SKILL.md` line 10 and its test.
- `contracts/workflow/feature.schema.json`: version `2.8.0`, worker `skills` (array, 1–8, uniqueItems, items
  `^[a-z][a-z0-9-]{0,63}$`). `contracts/workflow/examples/feature.2.8.0.json`: the PRD section 3 file (one lane with
  `skills`, one with `model` and `effort`).
- Docs: RUNBOOK "Skills for a lane (feature.json 2.8.0)"; README "What a worker can reach" paragraph; this file.

## Probes (run on this host, 2026-10-08, Claude Code 2.1.293)

A scratch plugin (`.claude-plugin/plugin.json` + `skills/probe-skill/SKILL.md`) and a scratch git repo whose
`CLAUDE.md` held `PROBE-24d9864564f2` below an `## Operator notes` heading, trusted with the controller's own
`trust_workspace`. Two `claude --bg` canaries with the exact skills-lane argv (`env -u` for every name `scrub_env`
drops: `CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID CLAUDE_CODE_CHILD_SESSION CLAUDE_PID CLAUDE_EFFORT
CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN`):

```
claude --help | grep -E 'setting-sources|plugin-dir'   # both flags present on 2.1.293

claude --bg --name probe-md-<uuid> \
  --settings '{"env":{"DISABLE_AUTOUPDATER":"1","CLAUDE_BG_ISOLATION":"none","HUSKY":"0","GIT_TERMINAL_PROMPT":"0"},
               "worktree":{"bgIsolation":"none"},
               "permissions":{"deny":["Read(~/.ssh/**)","Edit(/<tmp>/probe-plugin/**)"]},
               "advisorModel":"fable"}' \
  --model claude-opus-4-8 \
  --setting-sources "" --plugin-dir <tmp>/probe-plugin \
  --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
  --tools Read,Glob,Grep,Edit,Write,Bash,Skill \
  --permission-mode bypassPermissions --dangerously-skip-permissions \
  '<prompt: print PROBE- tokens else NONE; CLAUDE.md present?; skills; tools; memory; hooks; mcp>'
```

Launched from inside the scratch repo (so its `CLAUDE.md` was in scope). Answer:

```
TOKENS: NONE
CLAUDEMD: no — no CLAUDE.md / project-instructions / operator-notes section is present in my context.
SKILLS: workflow-probe:probe-skill, dataviz, artifact-design, artifact-diagramming, artifact-capabilities,
        update-config, keybindings-help, code-review, simplify, fewer-permission-prompts, loop, schedule,
        claude-api, workflow-authoring, run, plugin-authoring, init, security-review
TOOLS: Bash, Edit, EndConversation, Glob, Grep, Read, Skill, Write, advisor
MEMORY: no    HOOKS: no    MCP: no
```

Reading: the pinned plugin skill (`workflow-probe:probe-skill`) and Claude Code's bundled skills load; **no** user
skill from `~/.claude/skills/` (no `impeccable`, `night-shift`, `review-map`, `workflow-grill`, …); **no** operator
hooks (the operator's `settings.json` has a `hooks` key) and **no** MCP servers; the `Skill` tool and the `advisor`
(from `advisorModel: fable`) are both present; and the worktree's `CLAUDE.md` operator-notes section does not reach
the session, the same answer a `--safe-mode` session gives. The `--bg` session started its task under bypass
permissions **without a dialog** (state `working`, `⏵⏵ bypass permissions on`), so the lost
`skipDangerousModePermissionPrompt` key does not hang a skills session. Both canaries were stopped
(`claude stop <id>`) and are gone from `claude agents`.

An earlier canary launched (by mistake) from the `worktree-engine` cwd rather than the scratch repo reported
`MEMORY: yes` (it quoted md-manager's `MEMORY.md` auto-memory). Auto-memory is Claude Code's own and PRD 4.3 carves it
out explicitly; the corrected canary, run inside a repo with no `MEMORY.md`, reported `MEMORY: no`. The Stop concern is
the worktree's `CLAUDE.md`, which does not reach the session.

## Decisions and departures

- The CLAUDE.md probe does **not** load the operator-notes section, so note 2's narrowing does not apply:
  `scaffold.py:99` and `test_portable.py:468-477` are unchanged and their guarantee holds for skills lanes too.
- The lane's `--settings` deny list gains **both** `Edit(/<run>/skills/<lane>/**)` and `Write(/<run>/skills/<lane>/**)`
  on its pinned plugin (decisions.md [L1] g); nothing is removed from the list. (Repair 2 reverted round 1's Edit-only
  departure, which had followed design-challenge note 6 without naming [L1] g; the operator's decision stands as written.)
- `advisorModel` is read once at prepare and pinned as `plan.nodes[<lane>].advisor_model`; the dry run reads the plan,
  never `~/.claude/settings.json` (decisions.md [L1] b). (Repair 2 reverted round 1's dry-run file read.)
- SKILL.md is resolved with symlinks followed (Design settled): a `SKILL.md` symlinked to a regular file inside the
  folder resolves and copies as a real file; a `SKILL.md` symlinked outside the folder still resolves but is refused by
  `check_skill`/`_walk` under the escape rule (PRD 4.5), the same as any other escaping symlink. (Repair 2 dropped the
  round-1 `is_symlink()` refusal that had rejected every symlinked SKILL.md.)
- No remaining departures from decisions.md Operator decisions or grill defaults.

## Open P2s / verify independently

- **Live `viewer-refine` behaviour.** The canary proves loading/isolation on this host with a tiny probe skill, not the
  160 kB `impeccable` skill nor its `scripts/impeccable` launcher (decisions.md [G5]: the operator fetches the binary
  before `viewer-refine`). Verify the real skill loads and its launcher runs before `viewer-refine` launches.
- **Note 8 (operator, acts: operator).** A skills lane loses every `permissions.deny` rule in the operator's
  `~/.claude/settings.json`; the controller's own deny list still applies, but if the operator's file denies a path the
  controller's list does not (and that is not in `WORKER_SECRETS`), the Read tool could reach it in a skills lane though
  not in a plain one. Compare the operator's `settings.json` `permissions.deny` with the controller's list before
  `viewer-refine` launches.
- **`CLAUDE_CONFIG_DIR`.** `advisorModel` is read from `~/.claude/settings.json` (PRD's plain words); if the operator
  runs with `CLAUDE_CONFIG_DIR` set, that is the wrong file. Not handled; verify the operator's config location.
- **Auto-memory.** A project `MEMORY.md` can reach a skills session through Claude Code's own auto-memory (as it can a
  safe-mode session); out of scope here, but worth noting for a lane that runs in a repository with project memory.
