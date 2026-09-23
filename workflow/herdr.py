"""The Herdr CLI helper: every pane/tab command the workflow sends goes through here."""
from __future__ import annotations

import json
import os
import subprocess


def herdr(*args: str) -> dict:
    if os.environ.get("HERDR_ENV") != "1":
        raise RuntimeError("Herdr controls require a Herdr-managed caller pane (HERDR_ENV=1)")
    result = subprocess.run(["herdr", *args], capture_output=True, text=True, check=True, timeout=15)
    # Inspection/creation commands return JSON; rename/run may succeed silently.
    return json.loads(result.stdout) if result.stdout.strip() else {}
