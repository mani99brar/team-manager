"""Read-only observer. Closing this process/pane cannot signal a Claude worker."""
from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path

from .sessions import TERMINAL, plan_workers, read_json, save_json, validate_node_id


def safe_text(value: str) -> str:
    # Strip terminal escape/control bytes before displaying model-controlled output.
    value = re.sub(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)", "", value)
    value = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", value)
    return "".join(char for char in value if char in "\n\t" or (char.isprintable() and char != "\x1b"))


def render(line: str) -> str:
    try:
        event = json.loads(line)
    except ValueError:
        return safe_text(line.rstrip())
    if not isinstance(event, dict):
        return ""
    if event.get("type") == "assistant":
        blocks = event.get("message", {}).get("content", [])
        return "\n".join(safe_text(block.get("text", "")) if block.get("type") == "text"
                         else f"[tool: {safe_text(str(block.get('name', 'unknown')))}]"
                         for block in blocks if isinstance(block, dict))
    if event.get("type") == "result":
        return safe_text(f"[{event.get('subtype', 'result')}] {event.get('result', '')}")
    if event.get("type") == "system":
        return safe_text(f"[system: {event.get('subtype', '')}]")
    return ""


def herdr(*args: str) -> dict:
    if os.environ.get("HERDR_ENV") != "1":
        raise RuntimeError("Herdr controls require a Herdr-managed caller pane (HERDR_ENV=1)")
    result = subprocess.run(["herdr", *args], capture_output=True, text=True, check=True, timeout=15)
    # Inspection/creation commands return JSON; rename/run may succeed silently.
    return json.loads(result.stdout) if result.stdout.strip() else {}


def open_panels(directory: Path) -> dict:
    """Only run the observer command in newly created panes; never Claude itself."""
    directory = directory.resolve()
    workers = plan_workers(read_json(directory / "plan.json"))
    mapping_path = directory / "observers.json"
    if mapping_path.exists():
        raise RuntimeError("Observer mapping already exists; inspect it before opening duplicate panes")
    current = herdr("pane", "current", "--current")["result"]["pane"]
    source = Path(__file__).resolve().parents[1]
    created = herdr("tab", "create", "--workspace", current["workspace_id"],
                    "--cwd", str(source), "--label", f"Workflow: {directory.name}", "--no-focus")["result"]
    tab_id = created["tab"]["tab_id"]
    pane = created["root_pane"]["pane_id"]
    mapping = {}
    for index, node in enumerate(workers):
        if index == 0:
            new_pane = pane
        else:
            split = herdr("pane", "split", "--pane", pane, "--direction", "right",
                          "--cwd", str(source), "--no-focus")
            new_pane = split["result"]["pane"]["pane_id"]
        mapping[node] = {"pane_id": new_pane, "tab_id": tab_id, "mode": "read-only-observer"}
        save_json(mapping_path, mapping)  # Retain ownership even if the next command fails.
        herdr("pane", "rename", new_pane, f"Workflow {directory.name}: {node}")
        command = shlex.join([sys.executable, "-m", "workflow.observer", str(directory), node])
        herdr("pane", "run", new_pane, command)
        pane = new_pane
    return mapping


def watch(directory: Path, node: str, once: bool = False) -> None:
    print(f"READ-ONLY OBSERVER | {directory.name} / {node}\nClosing this pane does not stop Claude.", flush=True)
    offset = 0
    last_status = None
    while True:
        log = directory / f"{node}.stream.jsonl"
        if log.exists():
            with log.open("rb") as handle:
                handle.seek(offset)
                while True:
                    line = handle.readline()
                    if not line or not line.endswith(b"\n"):
                        break
                    offset = handle.tell()
                    text = render(line.decode(errors="replace"))
                    if text:
                        print(text, flush=True)
        state_path = directory / f"{node}.json"
        state = read_json(state_path) if state_path.exists() else {"status": "pending"}
        if state["status"] != last_status:
            last_status = state["status"]
            print(safe_text(f"[{last_status}] session={state.get('session_id', 'not launched')}"), flush=True)
            if state.get("error"):
                print(safe_text(state["error"]), flush=True)
        if once or last_status in TERMINAL:
            # Drain bytes written between the first read and the terminal receipt.
            if last_status in TERMINAL and log.exists():
                with log.open("rb") as handle:
                    handle.seek(offset)
                    for line in handle:
                        text = render(line.decode(errors="replace"))
                        if text:
                            print(text, flush=True)
            if not once and last_status in TERMINAL and os.environ.get("HERDR_ENV") == "1":
                try:
                    herdr("notification", "show", f"Workflow {node}: {last_status}",
                          "--body", f"Run {directory.name}; verification/review still required", "--sound", "none")
                except (OSError, ValueError, subprocess.SubprocessError):
                    pass  # Notification delivery never controls agent execution.
            print("Session receipt only — browser checks, review and integration are separate.", flush=True)
            return
        time.sleep(0.25)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("node", type=validate_node_id, help="A worker lane id of the run")
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    try:
        if args.node not in plan_workers(read_json(args.directory.resolve() / "plan.json")):
            parser.error(f"{args.node} is not a worker lane of this run")
        watch(args.directory.resolve(), args.node, args.once)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
