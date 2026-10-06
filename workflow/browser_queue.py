"""A machine-wide queue for Playwright browser checks, off unless the operator switches it on.

A browser suite starts the API, a Vite dev server and Chromium. On an 8-core, 11 GiB machine one suite took about
2.7 GiB and 166 s alone, two at once 205 s each and three at once 321 s each: past two, every suite slows and the
machine gains little. With the queue on, every browser check (the verifier's, and a worker's own run before
`check-report`) first takes one of `slots` slots and waits while all are held, so runs keep working in parallel and
only their browser suites take turns.

A slot is an flock on `slot-<n>.lock` in the queue directory. The kernel releases it when its holder exits, however it
exits, so a killed check never leaves a slot taken. The settings are read again on every poll: `off`, or more slots,
frees waiting checks at once. The queue never fails a check: unreadable settings are reported and the check runs
unqueued. Waiting is not check time: the verifier's timeout starts once the slot is taken.

`python -m workflow browser-queue status | on [--slots N] | off | run [--label L] -- <command>`
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import subprocess
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from .sessions import save_json

QUEUE_ENV = "MD_MANAGER_BROWSER_QUEUE"
SETTINGS = "settings.json"
DEFAULT_SLOTS = 2
POLL_SECONDS = 2.0


def queue_dir(env: dict | None = None) -> Path:
    """`MD_MANAGER_BROWSER_QUEUE` when set and not blank, else `~/.config/md-manager/browser-queue` (beside the registry)."""
    setting = (os.environ if env is None else env).get(QUEUE_ENV, "").strip()
    return Path(setting).expanduser().resolve() if setting else Path.home() / ".config/md-manager/browser-queue"


def read_settings(directory: Path) -> dict:
    """`{"enabled", "slots"}`; no settings file is off with the default slots. A malformed file raises ValueError naming it."""
    path = directory / SETTINGS
    try:
        value = json.loads(path.read_text())
    except FileNotFoundError:
        return {"enabled": False, "slots": DEFAULT_SLOTS}
    except (OSError, ValueError) as error:
        raise ValueError(f"{path} is unreadable: {error}") from error
    if (not isinstance(value, dict) or not isinstance(value.get("enabled"), bool) or type(value.get("slots")) is not int
            or value["slots"] < 1):
        raise ValueError(f'{path} must be {{"enabled": true|false, "slots": <at least 1>}}')
    return {"enabled": value["enabled"], "slots": value["slots"]}


def write_settings(directory: Path, enabled: bool, slots: int) -> dict:
    if slots < 1:
        raise ValueError("--slots must be at least 1")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    settings = {"enabled": enabled, "slots": slots}
    save_json(directory / SETTINGS, settings)
    return settings


def open_slot(directory: Path, index: int):
    descriptor = os.open(directory / f"slot-{index + 1}.lock", os.O_RDWR | os.O_CREAT, 0o600)
    return os.fdopen(descriptor, "r+")


def try_slot(directory: Path, index: int, label: str):
    """The slot's open file, locked and naming its holder, or None when another process holds it."""
    handle = open_slot(directory, index)
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close()
        return None
    handle.seek(0)
    handle.truncate()
    handle.write(json.dumps({"pid": os.getpid(), "label": label, "since": now()}) + "\n")
    handle.flush()
    return handle


def holders(directory: Path, slots: int) -> list[dict | None]:
    """One entry per slot: what its holder wrote, or None when it is free. A slot above `slots` is listed while still held."""
    found = []
    count = max([slots, *(int(path.stem.removeprefix("slot-")) for path in directory.glob("slot-*.lock")
                          if path.stem.removeprefix("slot-").isdigit())]) if directory.is_dir() else slots
    for index in range(count):
        if not (directory / f"slot-{index + 1}.lock").exists():
            found.append(None)
            continue
        with open_slot(directory, index) as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                handle.seek(0)
                try:
                    found.append(json.loads(handle.read() or "{}"))
                except ValueError:
                    found.append({})
                continue
            fcntl.flock(handle, fcntl.LOCK_UN)
            found.append(None)
    while len(found) > slots and found[-1] is None:
        found.pop()
    return found


def acquire(label: str, directory: Path | None = None, poll: float = POLL_SECONDS, out=sys.stderr):
    """A held slot's open file (closing it releases the slot), or None when the queue is off or its settings unreadable."""
    directory = queue_dir() if directory is None else directory
    waiting_since = None
    while True:
        try:
            settings = read_settings(directory)
        except ValueError as error:
            print(f"Browser queue: {error}; {label} runs unqueued", file=out, flush=True)
            return None
        if not settings["enabled"]:
            if waiting_since is not None:
                print(f"Browser queue: switched off; {label} runs now", file=out, flush=True)
            return None
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        for index in range(settings["slots"]):
            handle = try_slot(directory, index, label)
            if handle is not None:
                if waiting_since is not None:
                    print(f"Browser queue: {label} took slot {index + 1} after {round(time.monotonic() - waiting_since)} s",
                          file=out, flush=True)
                return handle
        if waiting_since is None:
            waiting_since = time.monotonic()
            busy = ", ".join(holder.get("label") or f"pid {holder.get('pid')}" for holder in holders(directory, settings["slots"]) if holder)
            print(f"Browser queue: {label} waits for one of {settings['slots']} slots (held by {busy or 'checks just finishing'})",
                  file=out, flush=True)
        time.sleep(poll)


@contextmanager
def browser_slot(label: str, directory: Path | None = None, poll: float = POLL_SECONDS, out=sys.stderr):
    handle = acquire(label, directory, poll, out)
    try:
        yield handle
    finally:
        if handle is not None:
            handle.close()


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def describe(directory: Path) -> str:
    settings = read_settings(directory)
    lines = [f"Browser queue: {'on' if settings['enabled'] else 'off'}, {settings['slots']} slot{'s' * (settings['slots'] != 1)} ({directory})"]
    for index, holder in enumerate(holders(directory, settings["slots"])):
        held = f"{holder.get('label') or 'unnamed'} (pid {holder.get('pid')}, since {holder.get('since')})" if holder is not None else "free"
        lines.append(f"  slot {index + 1}: {held}")
    return "\n".join(lines)


def browser_queue_main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(prog="python -m workflow browser-queue", description=__doc__.split("\n\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("status", help="Say whether the queue is on and who holds each slot")
    switch_on = commands.add_parser("on", help="Queue browser checks from now on, also those already waiting")
    switch_on.add_argument("--slots", type=int, help=f"Browser suites at once (kept when omitted; {DEFAULT_SLOTS} at first)")
    commands.add_parser("off", help="Let every browser check run at once, also those waiting")
    run = commands.add_parser("run", help="Run a command (a worker's Playwright run) in a slot and exit with its code")
    run.add_argument("--label", help="Shown to other waiting checks and in status (default: the current directory)")
    run.add_argument("argv", nargs=argparse.REMAINDER, help="-- <command> [arguments]")
    args = parser.parse_args(argv)
    directory = queue_dir()
    try:
        if args.command == "run":
            command = args.argv[1:] if args.argv[:1] == ["--"] else args.argv
            if not command:
                parser.error("run needs a command after --")
            sys.exit(run_in_slot(command, args.label or f"worker {Path.cwd().name}", directory))
        if args.command in ("on", "off"):
            try:
                current = read_settings(directory)["slots"]
            except ValueError:
                current = DEFAULT_SLOTS  # Switching rewrites a malformed file.
            slots = args.slots if args.command == "on" and args.slots is not None else current
            write_settings(directory, args.command == "on", slots)
        print(describe(directory))
    except ValueError as error:
        print(f"Refused: {error}", file=sys.stderr)
        sys.exit(2)


def run_in_slot(command: list[str], label: str, directory: Path) -> int:
    """The command's exit code (128 + n for signal n), run in a slot. The slot stays with this process, not the command's
    children (close_fds): a server the command leaves behind does not keep the slot."""
    from .worktrees import without_controller_git_config  # `python -m workflow` adds hooks-off; the command runs as written.
    with browser_slot(label, directory):
        try:
            process = subprocess.Popen(command, env=without_controller_git_config(os.environ))
        except FileNotFoundError as error:
            print(f"Refused: {error}", file=sys.stderr)
            return 127
        try:
            code = process.wait()
        except KeyboardInterrupt:  # The terminal's Ctrl-C reached the command too; wait for it to stop.
            code = process.wait()
    return 128 - code if code < 0 else code
