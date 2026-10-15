"""A report-only panel's claude provider for the judge lane's regression runs: the findings come from control.json beside
the copy the test makes (never from the environment)."""
import json, os, sys
from pathlib import Path
CONTROL = Path(__file__).with_name("control.json")
argv = sys.argv[1:]
spec = (json.loads(CONTROL.read_text()) if CONTROL.exists() else {}).get("claude", {})
assert argv[argv.index("--tools") + 1] == "Read,Glob,Grep"
sys.stdin.read()
result = {"session_id": argv[argv.index("--session-id") + 1], "is_error": False, "subtype": "success",
          "total_cost_usd": spec.get("cost", 0.021), "structured_output": {"findings": spec.get("findings", [])}}
sys.stdout.write(json.dumps(result) + "\n")
