# Workflow CLI cheatsheet

Every command below was taken from the argparse definitions in `workflow/pipeline.py`, `workflow/launch.py` and `workflow/interactive.py` after the worker-lanes slice (PRD_WORKER_LANES). Longer explanations live in [RUNBOOK.md](RUNBOOK.md) and [features/project-workflows/README.md](../features/project-workflows/README.md).

Worker lanes come from the feature's configuration: `features/<f>/feature.json` (2.0.0 or 2.1.0) declares every lane with its task file, `features/<f>/policy.json` (1.2.0) gives each lane its role label, owned paths, checks and `required_check_kinds`. A run launches every declared lane or the subset named with `--workers`; `<lane>` below is any selected lane id. Reviewers come from the same file: a 2.1.0 `reviewers` list gives each reviewer an id and a brief; without it the run has the single built-in reviewer `review`. `<reviewer>` below is a declared reviewer id; its node and files are `review-<reviewer>`, the default reviewer's stay `review`.

```bash
PY="$PWD/.venv/bin/python"                                   # controller interpreter, run from the repo root
RUN="$HOME/.local/state/md-manager-workflows/<feature>/<run-id>"   # run directory, always outside the repo
```

Two entry points:

| Entry point | Shape | Use |
| --- | --- | --- |
| `$PY -m workflow launch <feature> [flags]` | one command | prepare and start a committed feature |
| `$PY -m workflow <action> "$RUN" [flags]` | one action per call | every other pipeline step, status, recovery |

Nothing launches a Claude session without `--live`. Nothing ever pushes or merges `main`.

## 1. One-command launch

```bash
$PY -m workflow launch project-workflows --dry-run --automatic          # validate and print the commands, execute nothing
$PY -m workflow launch project-workflows --live --automatic             # unattended run to a verified feature branch
$PY -m workflow launch project-workflows --live                         # manual run with operator gates
$PY -m workflow launch project-workflows --live --automatic --workers adapter   # only the named lanes; the rest stay off-limits
```

| Flag | Meaning | Default |
| --- | --- | --- |
| `<feature>` | a directory under `features/` listed in `FEATURES` in `workflow/launch.py` | required |
| `--run-id ID` | opaque run identifier, not a path | `<feature>-001` |
| `--run-root DIR` | run storage outside the repository | `~/.local/state/md-manager-workflows/<feature>` |
| `--workers a,b` | launch only these declared lanes (unknown ids, duplicates and an empty list are refused before any Git action); the selection is pinned in `plan.json` | every declared lane |
| `--live` | authorize Claude usage | off |
| `--automatic` | run-scoped permission bypass for workers, automatic freeze, checks, native reviewer, verified feature branch | off, manual gates |
| `--worker-timeout-seconds N` | per-worker deadline from launch to completion signal, automatic only | 4 h, max 24 h |
| `--review-timeout-seconds N` | reviewer deadline from its launch to its completion file, automatic only | 30 min, max 24 h |
| `--reviewer-transport native\|print` | attachable reviewer session, or headless `claude --print`, automatic only | `native` |
| `--no-herdr` | omit terminal attachments | attaches |
| `--dry-run` | validate the feature configuration and print the commands | off |

`launch` refuses an existing run directory. It runs, in order: `preflight`, `git switch -c <branch_prefix>/<run-id>`, `prepare`, `start`, and with `--automatic` also `automatic`. A `feature.json` still at version 1.0.0 (`ui_task`/`adapter_task`) is translated to the 2.0.0 shape and a deprecation line is printed; `--dry-run` lists it under `notes`. A policy `failure_drill` that names a lane the selection leaves out is skipped, with a note and a timeline event.

## 2. Step-by-step pipeline (what `launch` runs for you)

```bash
$PY -m workflow preflight "$RUN" --repo "$PWD" --policy features/<f>/policy.json --herdr [--automatic]
$PY -m workflow prepare   "$RUN" --repo "$PWD" --policy features/<f>/policy.json \
                                 [--workers ui,docs] --task ui=features/<f>/ui-task.md --task docs=features/<f>/docs-task.md \
                                 [--reviewer general=features/<f>/reviewers/general.md --reviewer coverage=features/<f>/reviewers/coverage.md] \
                                 [--automatic --worker-timeout-seconds N --review-timeout-seconds N --reviewer-transport native|print]
$PY -m workflow start     "$RUN" --live [--herdr]
```

| Action | Required flags | Optional flags | What it does |
| --- | --- | --- | --- |
| `preflight` | `--policy` | `--repo`, `--herdr`, `--automatic` | validates the policy, clean source, installed `git`/`claude`/`node`, the Claude CLI flags the run needs, Claude login; `--herdr` requires a managed Herdr pane (`HERDR_ENV=1`) |
| `prepare` | `--policy`, `--task <lane>=<path>` once per selected lane | `--workers a,b`, `--reviewer <id>=<brief>` once per declared reviewer, `--repo`, `--automatic`, the three automatic settings | pins base commit, branch, policy digest, `workers` (selected lanes in declared order), `excluded_workers` and `reviewers` (each reviewer's id and brief text; absent means the single built-in reviewer) into `plan.json`, creates one worktree per selected lane, writes the first `run-state.json`; `--automatic` requires a `feature/` branch |
| `start` | `--live` | `--herdr` | launches every selected lane's native session once; refuses an already-started run; with `--herdr` opens the workflow tab (one pane per lane, in declared order) |

Manual-mode gates after the workers finish:

```bash
$PY -m workflow freeze  "$RUN" --handoff ui=ui-handoff.json --handoff docs=docs-handoff.json   # one --handoff per selected lane
$PY -m workflow review  "$RUN" --review-file independent-review.json                            # single built-in reviewer
$PY -m workflow review  "$RUN" --reviewer general  --review-file general-review.json             # declared reviewers: one import each
$PY -m workflow review  "$RUN" --reviewer coverage --review-file coverage-review.json
$PY -m workflow approve "$RUN" --bundle-sha256 <hash printed at the approval interrupt>
```

| Action | Required flags | What it does |
| --- | --- | --- |
| `freeze` | `--handoff <lane>=<path>` for every selected lane (each `{"summary": "...", "open_assumptions": []}`) | validates every handoff, stops the recorded sessions, snapshots (an edit under an excluded lane's owned paths is an ownership violation naming both lanes), checks each lane, builds the candidate from the selected lanes in declared order and rechecks it |
| `review` | `--review-file` (one reviewer's approved review JSON in RUNBOOK section 5), `--reviewer <id>` when the run declares reviewers | stores the import as `<node>.imported.json`; once every declared reviewer is imported, combines them into `review.json` (`reviewers` list, findings tagged by reviewer) and resumes the graph; until then the run stays at the review gate |
| `approve` | `--bundle-sha256` | refused until every declared reviewer is imported and approved; then fast-forwards the source branch locally to the reviewed candidate; no push |

## 3. Automatic mode

```bash
$PY -m workflow automatic      "$RUN" --live     # supervise to a verified feature branch, or resume an interrupted run
$PY -m workflow automatic-step "$RUN" --live     # one controller step, exit 75 = checkpoint persisted, run again
```

Resume after Ctrl-C, a closed terminal or a dropped SSH session with the same `automatic --live`; workers and the reviewers keep running meanwhile. Do not repeat `launch` for an existing run. The review node launches every declared reviewer over the shared `review-worktree/` and waits for all of them: the run continues only when every reviewer approves without an unresolved P0/P1; any block, rejected file or expired deadline blocks it and stops the other reviewers (their status files say `superseded`). A run stopped by a deadline, a blocked worker, a quota block, a rejected completion file or a blocked review is retained but not resumable: start a new `--run-id`.

## 4. Inspect

```bash
$PY -m workflow status "$RUN"                        # next nodes, pending interrupts, errors; refreshes report.html
$PY -m workflow export "$RUN"                        # rebuild run-state.json at the current export version (1.4.0), launches nothing
$PY -m workflow attach "$RUN"                        # create the run's Herdr tab and panes when start ran without --herdr
$PY -m workflow.interactive status     "$RUN"        # native session inventory for the run
$PY -m workflow.interactive attach     "$RUN" [--reuse-observers observers.json]
$PY -m workflow.interactive attach-one "$RUN" --node <lane>|review|review-<reviewer>    # reconnect one session in this terminal
```

`status` prints the run's `workers` and `excluded_workers` with the pending nodes. `attach-one` needs an interactive terminal, accepts any lane of the run or any of its reviewer nodes (`review`, or `review-<reviewer>` per declared reviewer), and refuses to restart a missing session. `export` takes the controller lock, constructs no sessions, and refuses a run whose `plan.json`, policy or `review.json` fail validation. Run it on runs recorded before export 1.4.0 so the viewer shows their review, its reviewers and inputs; an old run keeps its stored graph labels, reports both legacy lanes as selected and its one reviewer as `review`.

## 5. Recovery

```bash
$PY -m workflow retry     "$RUN" --phase worker    --node docs      # rerun one failed lane check at the same revision
$PY -m workflow retry     "$RUN" --phase candidate --node ui        # rerun one failed combined check
$PY -m workflow retry     "$RUN"                                    # resume failed post-freeze graph steps, never relaunches
$PY -m workflow reconcile "$RUN"                                    # rebind surviving sessions after an ambiguous launch, never relaunches
```

| Flag | Values | Default |
| --- | --- | --- |
| `--phase` | `worker`, `candidate` | `worker` |
| `--node` | any lane of the run (`workers` in `plan.json`) | none, meaning resume without selecting a check |

Three verification attempts per lane and phase, including the first. `retry` refuses runs that are waiting at an interrupt and refuses to relaunch failed `launch_*` steps; use `reconcile` for those.

Native session controls, from the run's receipts:

```bash
claude agents --json                                  # list sessions; the run's are named workflow-<run-id>-<lane>, workflow-<run-id>-reviewer (default reviewer) and workflow-<run-id>-reviewer-<reviewer>
claude stop <background_id>                           # stop one session by its exact id from <node>.interactive.json
cd "$RUN/review-worktree" && claude --resume <uuid>   # reread or continue a reviewer transcript (every reviewer ran in this worktree)
```

## 6. Viewer

```bash
npm run dev                                              # API on 127.0.0.1:3001 plus Vite on 127.0.0.1:5173
MD_MANAGER_API_PORT=3010 npm run dev:api                 # API alone on another port
```

The Projects viewer reads registered run roots from the projects registry file named by `MD_MANAGER_PROJECTS_CONFIG`; `config/projects.example.json` shows the shape. Unset means no projects. Sources come from `MD_MANAGER_CONFIG`. The adapter accepts exports 1.0.0 to 1.4.0, derives the run's lanes from `inputs.workers` (the fixed `ui`/`adapter` pair for exports without `inputs`) and serves one reviewer named `review` for exports before 1.4.0.

Created files: worker-phase verification copies each changed text file (UTF-8, no NUL byte) into the packet before any check runs, as a `file` artifact with its repo-relative `path`. Caps: 512 KiB per file, 8 MiB per packet (`FILE_CAPTURE_LIMIT`, `PACKET_FILE_CAPTURE_LIMIT` in `workflow/checks.py`). Other changed paths are listed in `files_not_captured` as `binary`, `too_large`, `missing` (deleted, renamed away or not a regular file) or `budget` (over the packet cap). The candidate phase captures nothing. The viewer opens captured files through the artifact route (`text/plain`); runs verified before capture say the files were not captured.

## 7. Files in a run directory

| File | Written by | Meaning |
| --- | --- | --- |
| `plan.json`, `policy.json` | `prepare` | pinned base commit, branch, `workers`, `excluded_workers`, `failure_drill`, tasks, `reviewers` (ids and brief texts; absent means the built-in reviewer), automatic settings, policy |
| `run-state.json` | every CLI boundary, `export` | versioned export the viewer reads |
| `worktree-<lane>/` | `prepare` | one worktree per selected lane |
| `<lane\|review\|review-<reviewer>>.interactive.json` | launch | session receipt with UUID, launch token, status (one per lane and per reviewer) |
| `<node>.prompt.txt`, `<node>.launch.log` | launch | exact prompt (a reviewer's brief plus the fixed blocks and completion protocol) and launch output |
| `<lane>.completion.json` | the worker | automatic mode completion signal |
| `<lane>.handoff.json` | `freeze` or the controller | accepted handoff |
| `<node>.stop.json` | stop | identity-checked stop marker |
| `review-bundle.json`, `review.diff`, `review-worktree/` | candidate | what every reviewer sees (one shared worktree) |
| `review.completion.json`, `review-<reviewer>.completion.json` | each reviewer | its bound verdict file (`node_id` names the reviewer) |
| `<node>.imported.json` | `review --reviewer` | a manually imported review, one per reviewer |
| `automatic-review.json`, `automatic-review-<reviewer>.json`, `review.json` | controller | combined review status, each declared reviewer's status (launch token, session, decision, `accepted`/`blocked`/`superseded`), and the combined verdict: `reviewers` entries plus unioned findings tagged by `reviewer` |
| `verification/<phase>/<node>/<attempt>/packet.json` | checks | check evidence and screenshots; worker phase also the changed text files (`file` artifacts with `path`) and `files_not_captured` |
| `report.html`, `events.jsonl`, `terminals.json` | controller | local report, timeline, Herdr pane map |
| `controller.lock`, `pipeline.sqlite` | controller | lock and LangGraph checkpoint |

## 8. Adding a feature to launch

1. Create `features/<name>/` with `feature.json` matching `contracts/workflow/feature.schema.json` (`version` 2.0.0 or 2.1.0, `name`, `branch_prefix`, `policy`, `workers: [{node_id, task}]`, one entry per lane; 2.1.0 may add `reviewers: [{reviewer_id, prompt}]`, one brief file per reviewer that states only what to look for, ids under the same rules as lane ids and never a lane id), `policy.json` matching `contracts/workflow/verification.schema.json` (1.2.0: the same lane ids, a free `role` label, `owned_paths`, `checks` and `required_check_kinds` per lane; lane ids match `^[a-z][a-z0-9-]{0,31}$` and avoid `review`, `candidate`, `handoff`, `approval`, `integrate`, `multiple`, `none`, `both` and the `launch_`/`verify_`/`candidate_`/`review-` prefixes), and one task file per lane. `features/project-workflows/reviewers/` holds example briefs (`general.md`, the built-in brief; `coverage.md`, a test-coverage brief) that a 2.1.0 file can declare.
2. Add `<name>` to the `FEATURES` tuple in `workflow/launch.py`.
3. `$PY -m workflow launch <name> --dry-run --automatic` until it validates, then `--live`.
