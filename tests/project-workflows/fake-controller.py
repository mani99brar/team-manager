#!/usr/bin/env python3
"""The fake workflow controller of the run-controls browser checks and the critique app (docs/PRD_RUN_CONTROLS.md Appendix A.3).

It is set as MD_MANAGER_WORKFLOW_PYTHON, so the server runs `<this file> -m workflow <verb> <run directory> ...`. It appends
its argv as one JSON line to $MD_MANAGER_FAKE_CONTROLLER_LOG, prints one canned line per verb and exits 0, or prints
`Blocked: ...` and exits 1 when the run directory's name contains `refuse`. `automatic` sleeps 3 seconds so a `running`
record is visible. Standard library only; it never touches a run directory.

Like the real controller (workflow/guardrails.py: one parser per verb, no subparsers) it parses its argv with one
`argparse.ArgumentParser` per verb, so an argv the server builds wrongly fails here as it would there: free text must come
after `--` (answer) or be attached with `=` (`--reason=`, `--accept-challenge=`), or a leading `-` is read as an option and
the parse exits 2 with a usage message (decisions [L6] 3).

`github <push|pr|ready|reviewers> <run> --repo R --repo-name O/N --branch B --head SHA ... --by operator` (docs/PRD_RUN_TEAMS.md
"GitHub actions") is parsed like `workflow/github.py`'s parser (each action's own required options; a title must be attached
as `--title=T`), and a short head is refused as the controller refuses it (`Blocked: ...`, exit 2). It prints one line (the
pull request URL for `pr`) and exits 0; nothing is pushed and GitHub is never called.
"""
import argparse
import json
import os
import re
import sys
import time

CANNED = {
    "automatic": "Automatic by the operator: supervisor started",
    "retry": "Retry by the operator: attempt raised",
    "reconcile": "Reconcile by the operator: launches reconciled",
    "resume": "Resume by the operator: challenge rerun started",
    "answer": "Answer by the operator: recorded and typed into the lane's pane",
    "approve": "Approve by the operator: reviewed bundle integrated",
    "repair": "Repair by the operator: repair session started",
    "abandon": "Abandon by the operator: run abandoned",
    "clean": "Clean by the operator: worktrees removed",
}


def _parser(verb: str) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog=f"workflow {verb}", exit_on_error=False)
    parser.add_argument("run")
    parser.add_argument("--by", required=True)
    if verb == "automatic":
        parser.add_argument("--live", action="store_true")
    elif verb == "retry":
        parser.add_argument("--phase", required=True, choices=["worker", "candidate"])
        parser.add_argument("--node", required=True)
    elif verb == "resume":
        parser.add_argument("--accept-challenge")
        parser.add_argument("--launch", action="store_true")
        parser.add_argument("--drop")
    elif verb == "answer":
        parser.add_argument("lane")
        parser.add_argument("text")
    elif verb == "approve":
        parser.add_argument("--bundle-sha256", required=True)
    elif verb == "repair":
        parser.add_argument("lane")
        parser.add_argument("--session", action="store_true")
        parser.add_argument("--live", action="store_true")
    elif verb == "abandon":
        parser.add_argument("--reason", required=True)
    elif verb == "clean":
        parser.add_argument("--dry-run", action="store_true")
    return parser


GITHUB_ACTIONS = ("push", "pr", "ready", "reviewers")


def _github_parser(action: str) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog=f"workflow github {action}", exit_on_error=False)
    parser.add_argument("directory")
    parser.add_argument("--repo", required=True)
    parser.add_argument("--repo-name", required=True)
    parser.add_argument("--branch", required=True)
    parser.add_argument("--head", required=True)
    parser.add_argument("--by", required=True, choices=["operator", "maintainer"])
    if action == "pr":
        parser.add_argument("--base", required=True)
        parser.add_argument("--title", required=True)
        parser.add_argument("--body-file", required=True)
    elif action in ("ready", "reviewers"):
        parser.add_argument("--pr", type=int, required=True)
        if action == "reviewers":
            parser.add_argument("--add", required=True)
    return parser


def github(rest: list[str]) -> int:
    if not rest or rest[0] not in GITHUB_ACTIONS:
        print("Blocked: unknown github action", file=sys.stderr)
        return 2
    action = rest[0]
    try:
        args = _github_parser(action).parse_args(rest[1:])
    except (argparse.ArgumentError, SystemExit) as error:
        if isinstance(error, argparse.ArgumentError):
            print(f"usage: workflow github {action} ...\nerror: {error}", file=sys.stderr)
        return 2
    if "refuse" in os.path.basename(args.directory.rstrip("/")):
        print(f"Blocked: github {action} refused for this run (the fake controller refuses every run named refuse)", file=sys.stderr)
        return 2
    if not re.fullmatch(r"[0-9a-f]{40}([0-9a-f]{24})?", args.head):
        print("Blocked: --head must be the run branch's full commit sha", file=sys.stderr)
        return 2
    if action == "push":
        print(f"Pushed {args.head[:12]} to origin/{args.branch} on github.com/{args.repo_name}; never forced")
    elif action == "pr":
        print(f"https://github.com/{args.repo_name}/pull/8")
    elif action == "ready":
        print(f"Marked pull request #{args.pr} on {args.repo_name} ready for review")
    else:
        print(f"Requested reviewers on #{args.pr}: {args.add}")
    return 0


def main(argv: list[str]) -> int:
    log = os.environ.get("MD_MANAGER_FAKE_CONTROLLER_LOG")
    if log:
        with open(log, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(argv) + "\n")
    if argv[:2] != ["-m", "workflow"] or len(argv) < 4:
        print("Blocked: the fake controller only answers `-m workflow <verb> <run> ...`")
        return 2
    verb = argv[2]
    if verb == "github":
        return github(argv[3:])
    if verb not in CANNED:
        print(f"Blocked: unknown verb {verb}")
        return 2
    try:
        args = _parser(verb).parse_args(argv[3:])
    except (argparse.ArgumentError, SystemExit) as error:
        if isinstance(error, argparse.ArgumentError):
            print(f"usage: workflow {verb} ...\nerror: {error}", file=sys.stderr)
        return 2
    run = args.run
    if "refuse" in os.path.basename(run.rstrip("/")):
        print(f"Blocked: {verb} refused for this run (the fake controller refuses every run named refuse)")
        print("Nothing was changed.")
        return 1
    if verb == "clean" and args.dry_run:
        print("Would remove worktree-ui")
        print("Would remove worktree-adapter")
        return 0
    if verb == "automatic":
        print("Supervisor starting", flush=True)
        time.sleep(3)
    print(CANNED.get(verb, f"{verb} by the operator"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
