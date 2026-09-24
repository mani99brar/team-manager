"""The Herdr CLI helper: every pane/tab command the workflow sends goes through here."""
from __future__ import annotations

import json
import os
import subprocess


def herdr(*args: str) -> dict:
    output = herdr_text(*args)
    # Inspection/creation commands return JSON; rename/run may succeed silently.
    return json.loads(output) if output.strip() else {}


def herdr_text(*args: str) -> str:
    """A command's output as printed: `pane read` prints the pane's screen, not JSON."""
    if os.environ.get("HERDR_ENV") != "1":
        raise RuntimeError("Herdr controls require a Herdr-managed caller pane (HERDR_ENV=1)")
    return subprocess.run(["herdr", *args], capture_output=True, text=True, check=True, timeout=15).stdout
