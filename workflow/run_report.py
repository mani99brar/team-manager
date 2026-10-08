"""`run-report`: a worker's test command run with its output in a log file, and only a bounded summary printed
(RUNBOOK.md, "run-report: test output for workers").

A worker that runs its tests through Bash reads their whole output into its context. `run-report -- <argv...>` runs the
command instead (argv, no shell, the current directory as cwd, the verifier's check environment plus
`NO_COLOR=1 FORCE_COLOR=0 CI=1`), writes its combined stdout and stderr to a log and prints at most `--max-lines`
lines (default 60) and about 6 KB: the command, exit code and duration, the counts the verifier's own parser reads
(checks.text_test_counts) or `no summary parsed`, each failing test with its first assertion or error line (unittest
`FAIL:`/`ERROR:` headers with the exception line, vitest `FAIL` lines with the first `Error:`, TAP `not ok` lines with
their `error:`), else the log's last lines when the command failed, then `full log: <path> (<n> bytes)`. Its exit code
is the command's (127 when the command cannot start).

The default log lies under the temporary directory, in a folder named for a hash of the cwd, never in the worktree:
freeze snapshots untracked files. `--log` names another file.

`--summarise haiku`, off by default, then starts one headless read-only Claude Code job (automatic.print_command on
`claude-haiku-4-5-20251001` with a small `--max-budget-usd`, sessions.scrub_env, the executable WORKFLOW_CLAUDE names,
else `claude`) on the log's last 200 lines and appends at most ten lines under `summary (haiku):`. A job that is
unavailable, fails or takes over 60 s gets one line saying so; the deterministic summary always prints first and the
exit code stays the command's.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .checks import check_environment, execute, text_test_counts
from .sessions import scrub_env, terminate

DEFAULT_MAX_LINES = 60
MAX_BYTES = 6 * 1024
LINE_CAP = 200        # Characters of one summary line, before its indent.
TAIL_LINES = 10       # The log's last lines shown when a failing command left nothing parsed.
HAIKU_MODEL = "claude-haiku-4-5-20251001"
HAIKU_BUDGET_USD = "0.25"
HAIKU_TIMEOUT = 60    # Seconds.
HAIKU_LOG_LINES = 200
HAIKU_MAX_LINES = 10
HAIKU_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["lines"],
                "properties": {"lines": {"type": "array", "maxItems": HAIKU_MAX_LINES, "items": {"type": "string"}}}}
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")  # The escape text_test_counts strips.


def default_log(cwd: Path) -> Path:
    """`<tmp>/workflow-run-report-<cwd hash>/<UTC time>-<pid>.log`: one folder per worktree, outside it."""
    digest = hashlib.sha256(str(cwd.resolve()).encode()).hexdigest()[:16]
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    return Path(tempfile.gettempdir()) / f"workflow-run-report-{digest}" / f"{stamp}-{os.getpid()}.log"


def cap(line: str, size: int = LINE_CAP) -> str:
    line = line.rstrip()
    return line if len(line) <= size else line[:size - 1] + "…"


UNITTEST_HEADER = re.compile(r"^(?:FAIL|ERROR|UNEXPECTED SUCCESS): \S")
UNITTEST_RULE = re.compile(r"^(?:={6,}|-{6,})$")
VITEST_HEADER = re.compile(r"^\s*FAIL\s+\S")
VITEST_END = re.compile(r"^\s*(?:FAIL\s|⎯{3,}|Test Files\s)")
TAP_NOT_OK = re.compile(r"^\s*not ok \d+\b(?!.*#\s*(?:TODO|SKIP)\b)", re.IGNORECASE)
TAP_ANY = re.compile(r"^\s*(?:not )?ok \d+\b")


def failures(text: str) -> list[tuple[str, str | None]]:
    """Each failing test the log names, in log order, with its first assertion or error line when the format gives one."""
    lines = ANSI.sub("", text).splitlines()
    found, seen = [], set()

    def add(name, detail):
        if name not in seen:
            seen.add(name)
            found.append((name, detail))

    for index, line in enumerate(lines):
        if UNITTEST_HEADER.match(line) and index > 0 and lines[index - 1].startswith("======"):
            # The traceback runs to the next rule after the one under the header; the exception line is its first
            # unindented line (the source lines of each frame are indented).
            detail, traceback = None, False
            for following in lines[index + 2:]:
                if UNITTEST_RULE.match(following):
                    break
                if following.startswith("Traceback ("):
                    traceback = True
                elif traceback and following and not following[0].isspace() and not following.startswith(
                        ("During handling", "The above exception")):
                    detail = following
                    break
            add(line.strip(), detail)
        elif VITEST_HEADER.match(line):
            detail = None
            for following in lines[index + 1:]:
                if VITEST_END.match(following):
                    break
                if "Error:" in following or re.match(r"^\s*\w*Error\b", following):
                    detail = following.strip()
                    break
            add(line.strip(), detail)
        elif TAP_NOT_OK.match(line):
            detail = None
            for following in lines[index + 1:]:
                if TAP_ANY.match(following):
                    break
                if re.match(r"^\s*error:\s", following):
                    detail = following.strip()
                    break
            add(line.strip(), detail)
    return found


def summary(argv: list[str], code: int, seconds: float, log: Path, max_lines: int = DEFAULT_MAX_LINES,
            max_bytes: int = MAX_BYTES) -> str:
    """The bounded, deterministic summary: header, failures (cut with a `… more` line to fit), `full log:` last."""
    text = log.read_bytes().decode("utf-8", errors="replace")
    counts = text_test_counts(text)
    head = [cap(f"run-report: {shlex.join(argv)}"), f"exit {code} after {seconds:.1f} s",
            f"counts: {counts['passed']} passed, {counts['failed']} failed, {counts['skipped']} skipped" if counts
            else "counts: no summary parsed"]
    body = []
    found = failures(text)
    if found:
        body.append(f"failing ({len(found)}):")
        for name, detail in found:
            body.append("  " + cap(name))
            if detail:
                body.append("    " + cap(detail))
    elif code != 0:
        tail = [line for line in ANSI.sub("", text).splitlines() if line.strip()][-TAIL_LINES:]
        if tail:
            body.append(f"last {len(tail)} lines of the log:")
            body.extend("  " + cap(line) for line in tail)
    foot = [f"full log: {log} ({log.stat().st_size} bytes)"]

    def size(lines):
        return len("\n".join(lines).encode()) + 1

    if len(head) + len(body) + len(foot) <= max_lines and size(head + body + foot) <= max_bytes:
        return "\n".join(head + body + foot)
    # Keep as many body lines as fit beside the `… more` line.
    kept = list(body)
    while kept:
        kept.pop()
        more = [f"… {len(body) - len(kept)} more lines in the full log"]
        lines = head + kept + more + foot
        if len(lines) <= max_lines and size(lines) <= max_bytes:
            return "\n".join(lines)
    return "\n".join(head + [f"… {len(body)} more lines in the full log"] + foot)


def haiku(argv: list[str], code: int, log: Path, cwd: Path) -> list[str]:
    """The haiku job's lines under their header, or one line saying why there are none."""
    tail = ANSI.sub("", log.read_bytes().decode("utf-8", errors="replace")).splitlines()[-HAIKU_LOG_LINES:]
    prompt = (f"These are the last {len(tail)} lines of the log of a test command (`{shlex.join(argv)}`, exit {code}). "
              f"Answer in `lines`, at most {HAIKU_MAX_LINES} short lines: the failing tests, the likely cause and the file:line "
              "to look at first. Do not restate passing output; do not edit anything.\n\n<log>\n" + "\n".join(tail) + "\n</log>\n")
    session_id = str(uuid.uuid4())
    try:
        from .automatic import print_command  # LangGraph only when asked.
        command = print_command(os.environ.get("WORKFLOW_CLAUDE", "claude"), session_id, HAIKU_SCHEMA, [],
                                ["--model", HAIKU_MODEL]) + ["--max-budget-usd", HAIKU_BUDGET_USD]
        process = subprocess.Popen(command, cwd=cwd, env=scrub_env(os.environ), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, text=True, start_new_session=True)
    except (OSError, ImportError) as error:
        return [f"summary (haiku): unavailable: {error}"]
    try:
        stdout, _ = process.communicate(prompt, timeout=HAIKU_TIMEOUT)
    except subprocess.TimeoutExpired:
        terminate(process)
        process.communicate()
        return [f"summary (haiku): unavailable: no answer within {HAIKU_TIMEOUT} s"]
    except BaseException:
        terminate(process)
        process.communicate()
        raise
    if process.returncode != 0:
        return [f"summary (haiku): unavailable: the job exited {process.returncode}"]
    try:
        result = json.loads(stdout)
        lines = result["structured_output"]["lines"]
        if result.get("is_error") or result.get("session_id") != session_id or not isinstance(lines, list):
            raise ValueError
        lines = [cap(str(line)) for line in lines if str(line).strip()][:HAIKU_MAX_LINES]
    except (ValueError, KeyError, TypeError):
        return ["summary (haiku): unavailable: the job returned no usable answer"]
    return ["summary (haiku):", *("  " + line for line in lines)]


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    parser = argparse.ArgumentParser(prog="python -m workflow run-report", usage="%(prog)s [--log FILE] [--max-lines N] "
                                     "[--summarise haiku] -- COMMAND [ARG...]",
                                     description="Run a test command with its output in a log file and print only a bounded "
                                     "summary: counts, failing tests with their first error line, and the log's path.")
    parser.add_argument("--log", type=Path, help="The log file (default: under the temporary directory, named for the cwd)")
    parser.add_argument("--max-lines", type=int, default=DEFAULT_MAX_LINES, help=f"Lines of the summary (default {DEFAULT_MAX_LINES})")
    parser.add_argument("--summarise", choices=["haiku"], help="Append a short summary by one headless Claude Code job on Haiku")
    if "--" not in argv:
        parser.error("give the command after --")
    split = argv.index("--")
    args, command = parser.parse_args(argv[:split]), argv[split + 1:]
    if not command:
        parser.error("give the command after --")
    if args.max_lines < 5:
        parser.error("--max-lines must be at least 5")
    cwd = Path.cwd()
    log = (args.log if args.log is not None else default_log(cwd)).absolute()
    log.parent.mkdir(parents=True, exist_ok=True)
    env, _ = check_environment(os.environ)
    env.update(NO_COLOR="1", FORCE_COLOR="0", CI="1")
    began = time.monotonic()
    try:
        code, _, _ = execute(command, cwd, log, None, env)
    except OSError as error:
        print(f"run-report: cannot run {command[0]}: {error}")
        sys.exit(127)
    print(summary(command, code, time.monotonic() - began, log, args.max_lines), flush=True)
    if args.summarise == "haiku":
        print("\n".join(haiku(command, code, log, cwd)), flush=True)
    sys.exit(code)
