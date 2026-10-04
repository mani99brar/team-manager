"""The Herdr CLI helper: every pane/tab command the workflow sends goes through here."""
from __future__ import annotations

import json
import os
import subprocess

from .worktrees import without_controller_git_config


def herdr(*args: str) -> dict:
    output = herdr_text(*args)
    # Inspection/creation commands return JSON; rename/run may succeed silently.
    return json.loads(output) if output.strip() else {}


def herdr_text(*args: str) -> str:
    """A command's output as printed: `pane read` prints the pane's screen, not JSON.

    A tab or pane Herdr creates may start from this environment, so it never carries the controller's own Git
    configuration: the operator's shell and attach-one there run Git and Claude Code as configured.
    """
    if os.environ.get("HERDR_ENV") != "1":
        raise RuntimeError("Herdr controls require a Herdr-managed caller pane (HERDR_ENV=1)")
    return subprocess.run(["herdr", *args], capture_output=True, text=True, check=True, timeout=15,
                          env=without_controller_git_config(os.environ)).stdout
