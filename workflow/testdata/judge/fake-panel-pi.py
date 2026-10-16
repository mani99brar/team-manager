"""A report-only panel's pi provider for the judge lane's regression runs: one assistant reply with the CONTROL findings."""
import json, sys
from pathlib import Path
CONTROL = Path(__file__).with_name("control.json")
spec = (json.loads(CONTROL.read_text()) if CONTROL.exists() else {}).get("pi", {})
def line(event):
    sys.stdout.write(json.dumps(event) + "\n")
line({"type": "session", "version": 3, "id": "fake"})
line({"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": json.dumps(spec.get("findings", []))}],
                                          "usage": {"input": 10, "output": 5, "cost": {"input": 0.004, "output": 0.0007, "total": spec.get("cost", 0.0047)}}}})
line({"type": "agent_end"})
