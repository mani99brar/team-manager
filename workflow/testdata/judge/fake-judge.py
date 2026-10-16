"""A fake judge print job for workflow/test_judge.py, run as `python -I <copy>`; never a model call.

It reads `judge-control.json` beside its copy. A call without --max-budget-usd is a print-mode reviewer job, handed on to
the `reviewer` executable the control names. A judge call appends {argv, cwd, stdin, pid, pgid} to the control's `seen`
file (with `head`, the commit its cwd checks out), then: `hang` sleeps an hour (writing its pid to `pid` first; with
`stubborn_child`, a child in its process group that ignores SIGTERM writes its own pid to that path before), `delay` sleeps that many seconds, `output` prints that
text verbatim, `exit` sets the exit code. The structured output is `rulings` verbatim, or with `auto` one ruling per input
finding (read back from the FINDINGS block of its stdin) with that ruling, the finding's own severity unless `auto_severity`
is given, its file and line, and `auto_evidence` as evidence.
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

CONTROL = Path(__file__).with_name("judge-control.json")
argv = sys.argv[1:]
spec = json.loads(CONTROL.read_text()) if CONTROL.exists() else {}
if "--max-budget-usd" not in argv:
    os.execv(spec["reviewer"], [spec["reviewer"], *argv])
stdin = sys.stdin.read()
seen = Path(spec["seen"])
runs = json.loads(seen.read_text()) if seen.exists() else []
head = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
runs.append({"argv": argv, "cwd": os.getcwd(), "head": head, "stdin": stdin, "pid": os.getpid(), "pgid": os.getpgid(0)})
seen.write_text(json.dumps(runs))
if spec.get("hang"):
    if spec.get("stubborn_child"):
        child = Path(spec["stubborn_child"])
        stubborn = subprocess.Popen([sys.executable, "-I", "-c", "import os, signal, sys, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                                     "open(sys.argv[1], 'w').write(str(os.getpid())); time.sleep(3600)", str(child)])
        deadline = time.monotonic() + 120
        while not child.exists() or not child.read_text():
            if stubborn.poll() is not None or time.monotonic() > deadline:
                sys.exit(3)  # The child never came up: the judge run fails instead of hanging the suite.
            time.sleep(0.05)
    Path(spec["pid"]).write_text(str(os.getpid()))
    time.sleep(3600)
time.sleep(spec.get("delay", 0))
if "output" in spec:
    sys.stdout.write(spec["output"])
    sys.exit(int(spec.get("exit", 0)))
rulings = spec.get("rulings", [])
if spec.get("auto"):
    block = stdin.split("=== FINDINGS", 1)[1].split("\n", 1)[1].split("\n===", 1)[0]
    rulings = []
    for line in block.splitlines():
        if not line.startswith("{"):
            continue
        finding = json.loads(line)
        rulings.append({"ruling": spec["auto"], "severity": spec.get("auto_severity", finding["severity"]), "sources": [finding["id"]],
                        "file": finding.get("file"), "line": finding.get("line"), "title": f"Ruling on {finding['id']}",
                        "detail": finding.get("detail") or finding.get("message") or "", "requirement": None,
                        "reason": "Checked against the code.", "evidence": spec.get("auto_evidence", "")})
result = {"session_id": argv[argv.index("--session-id") + 1], "is_error": False, "subtype": "success",
          "total_cost_usd": spec.get("cost", 1.25), "structured_output": {"rulings": rulings}}
sys.stdout.write(json.dumps(result) + "\n")
sys.exit(int(spec.get("exit", 0)))
