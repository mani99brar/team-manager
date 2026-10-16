"""Run each verification check once on the combined candidate (features/run-checks-once/prd.md sections 4 to 7; RUNBOOK
"Verification policy and evidence"). Never launches agents.

**Shared execution.** For each candidate attempt the step creates one shared verification worktree at
`shared-checks/<generation>/<attempt>/worktree`, runs the policy `setup` once in it and runs every distinct non-browser
argv once: the lanes' checks in declared lane order and policy order, then the policy 1.5.0 `run_checks`, skipping an argv
that already ran. An execution runs at the largest timeout of the checks that declare it; each lane still gates under
its own id, kind and timeout. The environment is checks.check_env's, which names no lane, with one private TMPDIR per
shared attempt outside the run (decisions [L3]). `git status --porcelain` runs after each execution: an execution after
which the worktree is not clean is `modified`, as is every later one, and only the checks that declare them are blocked
for it (challenge note 2). Ignored outputs of earlier commands stay visible to later ones. A command that cannot start
ends the execution (`launch_error`): the executions before it keep their verdicts, so an earlier lane still blocks
first, and the first lane (or the run checks) citing an argv that never ran stops the step without one (launch_failed).

**The shared record** (`record.json` beside the logs, never a packet.json and never at `verification/<phase>/<lane>/<n>/`)
describes the executions. Each lane's candidate packet copies its executions and logs (checks.cite_execution) and names
the record in `shared_record: {path, sha256}`; recheck_packet follows it (cited_record). A record of the same commit,
policy, attempt and lanes is reused; anything else is refused, and a new attempt reruns it. Lane attempts move in
lockstep while a run has shared records (decisions [L2]): the step first raises every lane's candidate attempt to the
highest, so one attempt has one record and every packet of it cites that record.

**Run checks** gate once every lane's own checks passed (SharedCandidate.finish). A run check whose execution recorded a
transient kind (checks.TRANSIENT_KINDS: killed for memory, out of disk, timed out under host load) makes every lane's
packet transient (repair.transient_packet), its kind kept in the marker's `transients` for the waits
(repair.transient_kinds), unless another run check failed for real beside it: then the transient one is only listed, as
for lane checks. Any other failure is attributed (attribute): its failing test ids are
rerun one target at a time on the candidate, the base and each lane snapshot, and the outcome blocks one lane, or every
lane with an `unattributed` marker that the fix loop never repairs (repair.unattributed_block).
"""
from __future__ import annotations

import argparse
import hashlib
import os
import shlex
import shutil
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Callable

from .checks import (TRANSIENT_KINDS, check_env, execute, now, prune_attempt, registered_worktree, remove_tree, remove_worktree,
                     text_test_counts, transient_kind)
from .sessions import git, read_json, save_json
from .verification import SLOW_SHARE, owns, policy_digest
from .worktrees import git_worktree

SHARED_DIR = "shared-checks"
RECORD = "record.json"
ATTRIBUTION = "attribution.json"
MARKER = "run_check_block"  # The structured marker on a packet a failed run check blocked; the reasons are for display.
RECORD_VERSION = "1.0.0"
TEST_KINDS = frozenset({"unit", "integration", "contract"})
# How a candidate event names a transient run check's kind (checks.TRANSIENT_KINDS).
TRANSIENT_TEXT = {"memory": "killed for memory", "disk": "out of disk", "load": "timed out under host load"}
SHOWN_IDS = 5  # Ids a reason lists before `and <n> more`.
NOT_RUN = "not run"  # An id a target was never asked to rerun, or one an interrupted rerun never reached (decisions [L7]).


def digest(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def shared_folder(run: Path, generation: int, attempt: int) -> Path:
    return run / SHARED_DIR / str(generation) / str(attempt)


def lockstep(run: Path) -> bool:
    """Whether the run's candidate attempts move in lockstep: it has written a shared record folder (decisions [L2])."""
    return (run / SHARED_DIR).is_dir()


def planned(policy: dict, lanes: list[str]) -> list[dict]:
    """The distinct non-browser executions of a candidate attempt, in execution order (PRD 4): each with its argv, the
    largest timeout of its declarers, and the lane checks and run checks that declare it."""
    entries, by_argv = [], {}

    def add(check: dict, key: str, declarer: dict) -> None:
        entry = by_argv.get(tuple(check["argv"]))
        if entry is None:
            entry = by_argv[tuple(check["argv"])] = {"argv": list(check["argv"]), "timeout_seconds": 0, "lanes": [], "run_checks": []}
            entries.append(entry)
        entry[key].append(declarer)
        entry["timeout_seconds"] = max(entry["timeout_seconds"], check["timeout_seconds"])

    workers = {worker["node_id"]: worker for worker in policy["workers"]}
    for lane in lanes:
        for check in workers[lane]["checks"]:
            if check["kind"] != "browser":
                add(check, "lanes", {"lane": lane, "id": check["id"], "kind": check["kind"], "timeout_seconds": check["timeout_seconds"]})
    for check in policy.get("run_checks", []):
        add(check, "run_checks", {"id": check["id"], "kind": check["kind"], "timeout_seconds": check["timeout_seconds"]})
    return entries


def worktree_clean(worktree: Path, commit: str) -> bool:
    return git(worktree, "rev-parse", "HEAD") == commit and not git(worktree, "status", "--porcelain")


def execution_passed(execution: dict) -> bool:
    """Whether every check declaring a shared execution passes on it, as its own gate reads it: exit 0 on a clean tree,
    within each declarer's own timeout, and for a test kind parsed counts with passed >= 1 and failed == 0. Only then may
    the attempt be pruned; a failed one is kept whole."""
    if execution.get("exit_code") != 0 or execution.get("modified"):
        return False
    try:
        seconds = (datetime.fromisoformat(execution["finished_at"]) - datetime.fromisoformat(execution["started_at"])).total_seconds()
        tests = execution["tests"]
        for declarer in [*execution["lanes"], *execution["run_checks"]]:
            if seconds > declarer["timeout_seconds"] or declarer["kind"] in TEST_KINDS and (
                    tests is None or tests["passed"] < 1 or tests["failed"] > 0):
                return False
    except (KeyError, TypeError, ValueError):
        return False
    return True


def run_shared(run: Path, plan: dict, policy: dict, folder: Path, commit: str, generation: int, attempt: int, lanes: list[str]) -> dict:
    """The shared record of this candidate attempt: reused when it exists for this commit, policy, attempt and lanes,
    else the shared worktree, setup once and each planned execution once. A passed record's worktree is pruned (execution_passed)."""
    path = folder / RECORD
    entries = planned(policy, lanes)
    if path.exists():
        record = read_json(path)
        found = (record.get("run_id"), record.get("commit"), record.get("attempt"), record.get("policy_sha256"), record.get("lanes"))
        if found != (plan["run_id"], commit, attempt, policy_digest(policy), lanes):
            raise ValueError(f"Existing shared record {path} is of another revision, attempt, policy or lane set; it is never reused")
        return record
    if folder.exists():
        raise RuntimeError("Interrupted shared check attempt exists; use an explicitly incremented attempt")
    folder.mkdir(parents=True, mode=0o700)
    worktree = folder / "worktree"
    git_worktree(plan["repository"], "add", "--detach", str(worktree), commit)
    if not worktree_clean(worktree, commit):
        raise RuntimeError("Shared verification worktree did not start clean at expected revision")
    env, dropped, tmpdir = check_env(folder, "candidate")
    setup, setup_errors, executions, launch_error = [], [], [], None
    try:
        for index, item in enumerate(policy.get("setup", [])):
            log = folder / f"setup-{index}.log"
            code, started, finished = execute(item["argv"], worktree, log, item["timeout_seconds"], env)
            setup.append({"argv": list(item["argv"]), "exit_code": code, "started_at": started, "finished_at": finished, "log": log.name})
            if code != 0:
                setup_errors.append(f"Setup {index} failed with exit {code}")
                break
        modified = False
        for index, entry in enumerate([] if setup_errors else entries):
            log = folder / f"check-{index}.log"
            try:
                code, started, finished = execute(entry["argv"], worktree, log, entry["timeout_seconds"], env)
            except OSError as error:
                # A command that cannot start is no verdict, as it ended a lane's own attempt; the executions before it keep
                # theirs, so an earlier lane's failure still blocks that lane first (launch_failed). Nothing later runs.
                launch_error = {"execution": index, "command": shlex.join(entry["argv"]), "error": str(error)}
                break
            # Today's rule after a lane's checks, after each shared execution: a check that leaves the source changed
            # invalidates its own evidence and that of every execution after it, which ran on the changed tree.
            modified = modified or not worktree_clean(worktree, commit)
            executions.append({**entry, "command": shlex.join(entry["argv"]), "cwd": str(worktree), "started_at": started,
                               "finished_at": finished, "exit_code": code, "log": log.name, "log_sha256": digest(log),
                               "tests": text_test_counts(log.read_text(errors="replace")),
                               "errors": [f"exit {code}"] if code != 0 else [],
                               **({"transient": kind} if (kind := transient_kind(code, log)) else {}),
                               **({"modified": True} if modified else {})})
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
    record = {"version": RECORD_VERSION, "run_id": plan["run_id"], "generation": generation, "attempt": attempt, "commit": commit,
              "base_commit": plan["base_commit"], "policy_sha256": policy_digest(policy), "lanes": lanes, "worktree": str(worktree),
              "tmpdir": str(tmpdir), "dropped_env_names": dropped, "setup": setup, "setup_errors": setup_errors,
              "executions": executions, **({"launch_error": launch_error} if launch_error else {}), "recorded_at": now()}
    save_json(path, record)
    if not setup_errors and not launch_error and all(execution_passed(item) for item in executions):
        try:
            prune_attempt(plan["repository"], folder)
        except Exception as error:  # The record is saved; what is left only takes disk, and `workflow clean` prunes it.
            print(f"Warning: shared attempt {folder} was not pruned ({error})")
    return record


def launch_failed(record: dict, argvs: list[list[str]]) -> str | None:
    """Why a lane or the run checks have no verdict on the record: one of `argvs` has no execution because a command
    could not start (run_shared's `launch_error`), at it or before it. None when every one ran."""
    error = record.get("launch_error")
    ran = {tuple(execution["argv"]) for execution in record["executions"]}
    if error is None or all(tuple(argv) in ran for argv in argvs):
        return None
    return f"Shared check `{error['command']}` could not start ({error['error']}); no verdict on the checks from it on"


def reference(run: Path, folder: Path) -> dict:
    path = folder / RECORD
    return {"path": str(path.resolve().relative_to(run.resolve())), "sha256": digest(path)}


def load_record(run: Path, cited: dict) -> dict:
    """The record a packet cites: inside the run, a record.json in a shared attempt folder, unchanged since (sha256)."""
    path = (run / cited["path"]).resolve()
    if not path.is_relative_to((run / SHARED_DIR).resolve()) or path.name != RECORD:
        raise ValueError(f"Shared record {cited['path']} is not a shared record of the run")
    if not path.is_file():
        raise ValueError(f"Shared record {cited['path']} is missing")
    if digest(path) != cited["sha256"]:
        raise ValueError(f"Shared record {cited['path']} changed after it was cited")
    return read_json(path)


def cited_record(packet: dict, policy: dict, run: Path, lane_checks: bool = True) -> dict:
    """The record a candidate packet cites, checked against the packet: of this run, revision, attempt and policy, naming
    the packet's lane, with every run check's log unchanged, and (`lane_checks`, not for a reused C28 packet whose checks
    are its worker packet's) holding exactly the packet's executions, counts and errors of the lane's non-browser checks,
    or none when the lane's own browser setup failed."""
    from .checks import cited_execution
    record = load_record(run, packet["shared_record"])
    expected = packet["expected"]
    node = expected["node_id"]
    if packet.get("phase") != "candidate" or (record["run_id"], record["commit"], record["attempt"], record["policy_sha256"]) != (
            expected["run_id"], expected["output_commit"], expected["attempt"], policy_digest(policy)) or node not in record["lanes"] and lane_checks:
        raise ValueError(f"Shared record {packet['shared_record']['path']} is not of {node}'s candidate attempt {expected['attempt']}")
    folder = (run / packet["shared_record"]["path"]).parent
    for execution in record["executions"]:
        # A run check's log belongs to no lane: every packet citing the record vouches for it (decisions [L6]).
        if execution["run_checks"] and (not (folder / execution["log"]).is_file() or digest(folder / execution["log"]) != execution["log_sha256"]):
            raise ValueError(f"run check {', '.join(item['id'] for item in execution['run_checks'])}: the shared execution's log changed")
    if not lane_checks or record["setup_errors"]:
        return record
    if not packet["evidence"]["checks"] and any(error.startswith("Setup ") for error in packet["capture_errors"]):
        # The record's setup passed, so this is a browser lane's own setup failing: no check ran (checks.run_lane_commands)
        # and evaluate_worker blocks the packet for its missing evidence, as for an uncited packet.
        return record
    worker = next(worker for worker in policy["workers"] if worker["node_id"] == node)
    receipts = {receipt["id"]: receipt for receipt in packet["evidence"]["checks"]}
    artifacts = {artifact["artifact_id"]: artifact for artifact in packet["result"]["artifacts"]}
    for check in worker["checks"]:
        if check["kind"] == "browser":
            continue
        shared = cited_execution(record, check["argv"])
        receipt = receipts.get(check["id"])
        if receipt is None:
            raise ValueError(f"{check['id']}: no evidence of the shared execution it cites")
        execution = packet["result"]["checks"][receipt["worker_check_index"]]
        own = {key: execution.get(key) for key in ("command", "cwd", "started_at", "finished_at", "exit_code", "transient")}
        if own != {key: shared.get(key) for key in own} or artifacts.get(execution["log_artifact_id"], {}).get("sha256") != shared["log_sha256"]:
            raise ValueError(f"{check['id']}: its execution differs from the shared record's")
        if receipt["tests"] != (shared["tests"] if check["kind"] in TEST_KINDS else None):
            raise ValueError(f"{check['id']}: its test counts differ from the shared record's")
        errors = [f"{check['id']}: {message}" for message in shared["errors"]]
        if not set(errors) <= set(packet["capture_errors"]) or shared.get("modified") and "Verification modified the tested source revision" not in packet["capture_errors"]:
            raise ValueError(f"{check['id']}: the shared execution's errors are missing from the packet")
        if not (folder / shared["log"]).is_file() or digest(folder / shared["log"]) != shared["log_sha256"]:
            raise ValueError(f"{check['id']}: the shared execution's log changed")
    return record


# ---- Run checks --------------------------------------------------------------------------------------------------

def run_check_gates(policy: dict, record: dict) -> list[dict]:
    """Each run check's gate on the record, in policy order, recomputed from its execution as evaluate_worker gates a lane
    check (PRD 6.2): its own timeout, exit 0, and for a test kind parsed counts with passed >= 1 and failed == 0. A failed
    one's `transient` is its execution's recorded kind (checks.TRANSIENT_KINDS: "memory", "disk" or "load"), as
    checks.transient_checks reads a lane check's, else None."""
    gates = []
    by_argv = {tuple(item["argv"]): index for index, item in enumerate(record["executions"])}
    for check in policy.get("run_checks", []):
        index = by_argv.get(tuple(check["argv"]))
        execution = record["executions"][index] if index is not None else None
        reasons = [f"{check['id']}: {error}" for error in record["setup_errors"]]
        if not reasons and execution is None:
            reasons.append(f"{check['id']}: the shared record has no execution of it")
        elif execution is not None:
            seconds = (datetime.fromisoformat(execution["finished_at"]) - datetime.fromisoformat(execution["started_at"])).total_seconds()
            if seconds > check["timeout_seconds"]:
                reasons.append(f"{check['id']}: execution exceeded approved timeout")
            reasons.extend(f"{check['id']}: {error}" for error in execution["errors"])
            tests = execution["tests"]
            if check["kind"] in TEST_KINDS and (tests is None or tests["passed"] < 1 or tests["failed"] > 0):
                reasons.append(f"{check['id']}: no passing test evidence or failed tests")
            if execution.get("modified"):
                reasons.append(f"{check['id']}: Verification modified the tested source revision")
        gates.append({**check, "execution": index, "reasons": reasons,
                      "transient": execution.get("transient") if reasons and execution is not None
                      and execution.get("transient") in TRANSIENT_KINDS else None})
    return gates


def slow_run_checks(policy: dict, record: dict) -> list[str]:
    """Each run check whose execution took more than SLOW_SHARE of its own timeout, as verification.slow_checks names a
    lane check (C27; PRD 6.2): `full took 1500 s of its 1800 s timeout (83%)`."""
    named = []
    for gate in run_check_gates(policy, record):
        if gate["execution"] is None:
            continue
        execution, timeout = record["executions"][gate["execution"]], gate["timeout_seconds"]
        try:
            seconds = (datetime.fromisoformat(execution["finished_at"]) - datetime.fromisoformat(execution["started_at"])).total_seconds()
        except (KeyError, TypeError, ValueError):
            continue
        if seconds > SLOW_SHARE * timeout:
            named.append(f"{gate['id']} took {seconds:.0f} s of its {timeout} s timeout ({round(100 * seconds / timeout)}%)")
    return named


def gate_run_checks(packet: dict, policy: dict, run: Path, record: dict, run_checks: bool = True) -> dict:
    """A citing packet's run-check gate (PRD 6.3), reproduced from the record and its attribution, never read back from
    the packet: nothing when every run check passed (or `run_checks` is False); every lane blocked as transient when each
    failed one recorded a transient kind (killed for memory, out of disk, timed out under host load; the marker's
    `transients` maps each id to its kind); else the attribution of the ones that failed for real blocks its lane, or every
    lane, marked `unattributed`, with any kill only listed (result.transient_checks and its reasons). A packet that
    recorded an attribution's digest must find it unchanged."""
    saved = packet.pop(MARKER, None)
    ids = [check["id"] for check in policy.get("run_checks", [])]
    result = packet["result"]
    transient = [check_id for check_id in result.get("transient_checks", []) if check_id not in ids]
    result.pop("transient_checks", None)
    if transient:
        result["transient_checks"] = transient
    failed = [gate for gate in run_check_gates(policy, record) if gate["reasons"]] if run_checks else []
    if not failed:
        return packet
    killed = [gate for gate in failed if gate["transient"]]
    real = [gate for gate in failed if not gate["transient"]]
    attribution = None
    if killed:
        result["transient_checks"] = transient + [gate["id"] for gate in killed]
    if not real:
        # A transient run check takes the transient path first and gets no attribution reruns (PRD 7.1): every lane reruns
        # free, once the controller waited on each recorded kind (repair.transient_kinds reads `transients`).
        reasons = [reason for gate in killed for reason in gate["reasons"]]
        marker = {"kind": "transient", "lane": None, "checks": [gate["id"] for gate in killed], "attribution": None,
                  "transients": {gate["id"]: gate["transient"] for gate in killed}}
    else:
        # A real failure beside a kill makes the attempt a real failure, as for lane checks (repair.transient_packet):
        # the real ones are attributed, and the kill is only listed after them.
        listed_kills = [reason for gate in killed for reason in gate["reasons"]]
        path = (run / packet["shared_record"]["path"]).parent / ATTRIBUTION
        if not path.is_file():
            reasons = [f"run check {gate['id']} failed; not attributed" for gate in real] + listed_kills
            marker = {"kind": "unattributed", "lane": None, "checks": [gate["id"] for gate in real], "attribution": None}
        else:
            attribution = {"path": str(path.resolve().relative_to(run.resolve())), "sha256": digest(path)}
            if isinstance(saved, dict) and saved.get("attribution") not in (None, attribution):
                raise ValueError(f"Run-check attribution {attribution['path']} changed after it was recorded")
            recorded = read_json(path)
            if recorded.get("record") != packet["shared_record"] or [item["id"] for item in recorded["checks"]] != [gate["id"] for gate in real]:
                raise ValueError(f"Run-check attribution {attribution['path']} is not of the failed run checks of {packet['shared_record']['path']}")
            lane, reasons = decide(recorded)
            if lane is not None and lane != packet["expected"]["node_id"]:
                if killed:
                    result.pop("transient_checks", None)
                    if transient:
                        result["transient_checks"] = transient
                return packet  # Attributed to another lane: this lane's packet passes on its own checks.
            reasons += listed_kills
            marker = {"kind": "attributed" if lane else "unattributed", "lane": lane, "checks": [gate["id"] for gate in real],
                      "attribution": attribution}
    packet["gate"]["reasons"].extend(reasons)
    packet["gate"]["status"] = "blocked"
    packet[MARKER] = marker
    return packet


# ---- Attribution (PRD 7) -----------------------------------------------------------------------------------------

def runner(argv: list[str]) -> tuple[str, int] | None:
    """`("run_tests", i)` or `("unittest", i)` when argv runs `-m workflow.run_tests` or `-m unittest` at index i; None
    for any other runner, whose failing ids are not parsed ([G4])."""
    for index in range(len(argv) - 1):
        if argv[index] == "-m" and argv[index + 1] in ("workflow.run_tests", "unittest"):
            return ("run_tests" if argv[index + 1] == "workflow.run_tests" else "unittest"), index
    return None


def import_root(argv: list[str], is_dir: Callable[[str], bool] | None = None) -> str:
    """The directory, relative to the worktree, that a plain-unittest `discover` run check imports its tests from, so a
    rerun of its ids imports them the same way (decisions [L14]): the top-level directory (`-t`, `--top-level-directory`
    or the third positional), else the start directory (`-s`, `--start-directory` or the first positional), else `.`.
    Options are read as unittest's discover parser reads them (`-stests`, `--start-directory=tests`), and `discover` in
    any case, as unittest matches it (G3, [L15]). A start that `is_dir` (the commit's view: tree_at, or a worktree's)
    says is no directory, a dotted `pkg.tests`, is imported as a module from the top level, the worktree root, so it is
    `.` (G3, [L15]); without `is_dir` a start is taken as a directory. Any other run check, and a root that is absolute or
    leaves the worktree, is `.`: a rerun never imports tests from outside its snapshot."""
    mode = runner(argv)
    if mode is None or mode[0] != "unittest" or [item.lower() for item in argv[mode[1] + 2:mode[1] + 3]] != ["discover"]:
        return "."
    parser = argparse.ArgumentParser(add_help=False, exit_on_error=False)
    for flags in (("-v", "--verbose"), ("-q", "--quiet"), ("-f", "--failfast"), ("-c", "--catch"), ("-b", "--buffer"), ("--locals",)):
        parser.add_argument(*flags, action="store_true")
    parser.add_argument("-k", action="append")
    parser.add_argument("--durations")
    for short, long, dest in (("-s", "--start-directory", "start"), ("-p", "--pattern", "pattern"), ("-t", "--top-level-directory", "top")):
        parser.add_argument(short, long, dest=dest)
    for dest in ("start", "pattern", "top"):
        parser.add_argument(dest, nargs="?", default=argparse.SUPPRESS)
    try:
        parsed, _ = parser.parse_known_args(argv[mode[1] + 3:])
    except (argparse.ArgumentError, SystemExit):
        return "."
    root = os.path.normpath(parsed.top or parsed.start or ".")
    if os.path.isabs(root) or root == ".." or root.startswith("../"):
        return "."
    if not parsed.top and root != "." and is_dir is not None and not is_dir(root):
        return "."  # unittest imports a start that is no directory as a module, top level implicit at the worktree root.
    return root


def tree_at(repository: str, commit: str) -> Callable[[str], bool]:
    """import_root's `is_dir` for a commit: whether a path is a directory (a tree) there."""
    return lambda path: subprocess.run(["git", "-C", repository, "cat-file", "-t", f"{commit}:{path}"],
                                       capture_output=True, text=True).stdout.strip() == "tree"


def safe_path(argv: list[str], mode: tuple[str, int] | None, cwd: Path, env: dict) -> bool:
    """Whether the run check's own Python (argv before `-m`) takes `-P` (Python 3.11+), probed in the rerun's worktree
    and environment: an older interpreter refuses the option, and its rerun keeps the working directory first."""
    if mode is None:
        return False
    try:
        return subprocess.run([*argv[:mode[1]], "-P", "-c", ""], cwd=cwd, env=env, capture_output=True, timeout=60).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def rooted_env(root: Path, worktree: Path, env: dict) -> str:
    """The rerun's PYTHONPATH for a discover root ([L15], f2): `<worktree>/<root>:<worktree>[:existing]`, the order
    discover's own sys.path has (the root it inserts first, then the working directory `-m` adds, which `-P` drops)."""
    return os.pathsep.join([str(root), str(worktree), *([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])])


def brief_command(argv: list[str], root: str) -> str:
    """The repair brief's rerun command, run from the worktree root: rerun()'s PYTHONPATH order spelled relative, any
    existing PYTHONPATH kept after it ([L15])."""
    command = shlex.join(argv)
    return command if root == "." else f"PYTHONPATH={shlex.quote(root)}:.${{PYTHONPATH:+:$PYTHONPATH}} {command}"


def rerun_argv(argv: list[str], ids: list[str], mode: tuple[str, int] | None, unittest_form: bool = False, root: str = ".",
               safe: bool = True) -> list[str]:
    """The command that reruns only `ids` with the run check's own Python: `-m workflow.run_tests --tests <ids>`, or
    `-m unittest <ids>` (plain unittest, or a commit whose run_tests has no --tests); the whole run check without ids.
    Under a discover import root other than `.`, `-P` goes immediately before `-m` (f2, [L15]): the working directory
    then never shadows the root's modules, which rerun() puts first on PYTHONPATH. `safe` is false for a Python before
    3.11 (safe_path), which has no `-P`."""
    if mode is None:
        return list(argv)
    name, index = mode
    flag = ["-P"] if root != "." and safe else []
    if name == "run_tests" and not unittest_form:
        return [*argv[:index], *flag, "-m", "workflow.run_tests", "--tests", *ids]
    return [*argv[:index], *flag, "-m", "unittest", *ids]


def loader_errors(text: str) -> list[tuple[str, str]]:
    """Each name the loader could not load, with why: run_tests' `WORKFLOW: no test named <id>: <why>` lines and plain
    unittest's `ERROR: <name> (unittest.loader._FailedTest.<name>)` blocks, up to the next rule."""
    import re
    from .run_report import LOADER_FAILURE, UNITTEST_ID, UNITTEST_RULE, unittest_lines
    from .run_tests import NO_TEST
    found = re.findall(rf"^\s*{re.escape(NO_TEST)} (\S+?): (.*)$", text, re.MULTILINE)
    lines = [line for line, _ in unittest_lines(text)]
    for index, line in enumerate(lines):
        match = UNITTEST_ID.match(line)
        if match and match[2] == f"{LOADER_FAILURE}.{match[1]}":
            block = []
            for following in lines[index + 2:]:  # Past the rule under the header.
                if UNITTEST_RULE.match(following):
                    break
                block.append(following)
            found.append((match[1], "\n".join(block)))
    return found


def absent(test_id: str, why: str) -> bool:
    """Whether a loader error says the id names no test at that commit (PRD 7.2: `not applicable`): no module of one of
    its dotted prefixes, no attribute of one of its parts, or no test at all. Any other error (a module of it that fails
    to import, or one it imports that is missing) is the id failing."""
    import re
    parts = test_id.split(".")
    prefixes = {".".join(parts[:size]) for size in range(1, len(parts) + 1)}
    return (any(name in prefixes for name in re.findall(r"No module named '([^']+)'", why))
            or any(name in parts[1:] for name in re.findall(r"has no attribute '([^']+)'", why)) or "it names no test" in why)


def interrupted(code: int | None) -> bool:
    """Whether a rerun ended on its timeout (execute's exit 124) or a signal (negative, or 128 + n from a shell)."""
    return code is not None and (code == 124 or code < 0 or code > 128)


def statuses(ids: list[str], text: str, code: int, check: dict, mode) -> dict:
    """Each id's outcome in one rerun's log: `failed`, `passed` or `not applicable` (no such test there: PRD 7.2). A
    loader error naming the id is `not applicable` only when it says the id is absent (absent): a module that fails to
    import has failed. The whole-check form ([G4]) gates the run again: exit 0, and for a test kind passing counts.
    A rerun that timed out or was killed passes no id (decisions [L7]): each id without a failure header is `not run`,
    and the whole-check form's one id too."""
    from .run_report import failing_ids
    if interrupted(code) and mode is None:
        return {test_id: NOT_RUN for test_id in ids}
    if mode is None:
        tests = text_test_counts(text)
        bad = code != 0 or (check["kind"] in TEST_KINDS and (tests is None or tests["passed"] < 1 or tests["failed"] > 0))
        return {test_id: "failed" if bad else "passed" for test_id in ids}
    loader = loader_errors(text)
    failing = [item for item in failing_ids(text) if item not in {name for name, _ in loader}]
    result = {}
    for test_id in ids:
        errors = [why for name, why in loader
                  if test_id == name or test_id.startswith(name + ".") or test_id.endswith("." + name) or f".{name}." in test_id]
        if errors and all(absent(test_id, why) for why in errors):
            result[test_id] = "not applicable"
        elif errors or any(item == test_id or item.startswith(test_id + ".") or test_id.startswith(item + ".") for item in failing):
            result[test_id] = "failed"
        else:
            result[test_id] = "passed"
    if interrupted(code):
        # Incomplete evidence: an id the log shows no failure of may simply never have run, so it is not known to pass.
        result = {test_id: NOT_RUN if status == "passed" else status for test_id, status in result.items()}
    elif code != 0 and not failing and text_test_counts(text) is None:
        # Crashed before a summary: no id is known to pass.
        result = {test_id: "failed" if status == "passed" else status for test_id, status in result.items()}
    return result


def rerun(plan: dict, policy: dict, folder: Path, name: str, commit: str, check: dict, ids: list[str], mode, index: int = 0) -> dict:
    """One attribution rerun: a fresh worktree of `commit` at `<attempt folder>/attribution/<index>/<name>/`, setup, then
    only `ids`, capped at the run check's timeout; the worktree and caches are removed after, the logs kept. Never
    concurrent. `index` is the run check's policy index, so one failed run check's reruns never replace another's logs.
    A discover run check's import root (read at this commit) goes first on PYTHONPATH, then the worktree, then any
    existing entries, the interpreter runs with `-P` (f2: the working directory never shadows the root), and the root
    goes into the entry's `import_root` ([L14], [L15]).
    A setup step that fails or times out runs no id: each is `not run` (decisions [L7]), never `failed`, so an
    environmental setup failure neither names a lane nor makes an id pre-existing at base."""
    target = folder / "attribution" / str(index) / name
    worktree = target / "worktree"
    if target.exists():
        # An interrupted rerun of an attribution that was never recorded: Git still lists its worktree, so it is removed
        # through Git before the folder, and a registration whose folder is gone is pruned, or the add below is refused.
        if worktree.exists() or worktree.is_symlink():
            remove_worktree(plan["repository"], worktree)
        remove_tree(target)
        if registered_worktree(plan["repository"], worktree):
            git_worktree(plan["repository"], "prune")
    target.mkdir(parents=True, mode=0o700)
    git_worktree(plan["repository"], "add", "--detach", str(worktree), commit)
    env, _, tmpdir = check_env(target, "candidate")
    root = import_root(check["argv"], lambda path: (worktree / path).is_dir()) if mode is not None else "."
    safe = root == "." or safe_path(check["argv"], mode, worktree, env)
    argv = rerun_argv(check["argv"], ids, mode, root=root, safe=safe)
    if root != ".":
        # discover put the root first on sys.path; ids are dotted from it ([L14]). Children inherit it, unlike discover's.
        env["PYTHONPATH"] = rooted_env(worktree / root, worktree, env)
    try:
        for step, item in enumerate(policy.get("setup", [])):
            setup_log = target / f"setup-{step}.log"
            code, _, _ = execute(item["argv"], worktree, setup_log, item["timeout_seconds"], env)
            if code != 0:
                return {"target": name, "commit": commit, "argv": argv, "import_root": root, "log": str(setup_log.relative_to(folder)), "exit_code": None,
                        "statuses": {test_id: NOT_RUN for test_id in ids}, "setup_failed": step, "setup_exit_code": code}
        log = target / "check.log"
        code, _, _ = execute(argv, worktree, log, check["timeout_seconds"], env)
        text = log.read_text(errors="replace")
        if mode is not None and mode[0] == "run_tests" and code == 2 and "unrecognized arguments: --tests" in text:
            argv = rerun_argv(check["argv"], ids, mode, unittest_form=True, root=root, safe=safe)  # A commit before run_tests --tests.
            log = target / "check-unittest.log"
            code, _, _ = execute(argv, worktree, log, check["timeout_seconds"], env)
            text = log.read_text(errors="replace")
        return {"target": name, "commit": commit, "argv": argv, "import_root": root, "log": str(log.relative_to(folder)), "exit_code": code,
                "statuses": statuses(ids, text, code, check, mode)}
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
        try:
            remove_worktree(plan["repository"], worktree)
            for cache in ("npm_config_cache", "xdg_cache_home"):
                if (target / cache).exists():
                    remove_tree(target / cache)
        except Exception as error:  # Only disk: `workflow clean` and git worktree prune take what is left.
            print(f"Warning: attribution worktree {worktree} was not removed ({error})")


def test_file(repository: str, commit: str, test_id: str, root: str = ".") -> str | None:
    """The repository file of a dotted test id at `commit`: the longest module prefix that is a `.py` file there, under
    the run check's import root (import_root)."""
    parts = test_id.split(".")
    for size in range(len(parts), 0, -1):
        path = "/".join(([] if root == "." else [root]) + parts[:size]) + ".py"
        if subprocess.run(["git", "-C", repository, "cat-file", "-e", f"{commit}:{path}"], capture_output=True).returncode == 0:
            return path
    return None


def attribute_check(plan: dict, policy: dict, record: dict, folder: Path, gate: dict, snapshots: dict, lanes: list[str]) -> dict:
    """One failed run check's attribution (PRD 7, challenge note 5): parse its failing ids, rerun them on the candidate,
    then (only if any reproduced) on the base, then (only if any remain) on each lane snapshot; a commit is rerun once
    whatever names it. The outcome of each id, in order: not run (a rerun of it timed out, was killed before it or
    failed its setup, decisions [L7]: never attributed, and no later target, lane snapshots included, reruns it), did
    not reproduce, pre-existing at base, the one lane whose snapshot alone fails it (snapshot), else the one lane owning
    its test file (owner, [G3]), else unattributed."""
    from .run_report import failing_ids
    if record["setup_errors"] or gate["execution"] is None:
        return {"id": gate["id"], "mode": "setup", "ids": [], "reruns": [], "outcomes": {}}
    execution = record["executions"][gate["execution"]]
    mode = runner(gate["argv"])
    ids = failing_ids((folder / execution["log"]).read_text(errors="replace")) if mode else []
    whole = not ids
    if whole:
        ids, mode = [gate["id"]], None  # The check is one id: it reruns whole ([G4]).
    reruns, by_commit = [], {}
    # Each failed run check reruns under its own `attribution/<policy index>/`: the logs attribution.json cites stay.
    index = [check["id"] for check in policy["run_checks"]].index(gate["id"])

    def run_on(name: str, commit: str, selected: list[str]) -> dict:
        if not selected:
            return {}
        if commit in by_commit and set(selected) <= set(by_commit[commit]):
            return {test_id: by_commit[commit][test_id] for test_id in selected}
        done = rerun(plan, policy, folder, name, commit, gate, selected, mode, index)
        reruns.append({key: value for key, value in done.items()})
        by_commit.setdefault(commit, {}).update(done["statuses"])
        return done["statuses"]

    candidate = run_on("candidate", record["commit"], ids)
    reproduced = [test_id for test_id in ids if candidate[test_id] == "failed"]
    base = run_on("base", plan["base_commit"], reproduced)
    remaining = [test_id for test_id in reproduced if base[test_id] not in ("failed", NOT_RUN)]
    snapshot = {}
    for lane in lanes:
        snapshot[lane] = run_on(f"lane-{lane}", snapshots[lane]["commit"], remaining)
        # An id one snapshot never reached is unattributed whatever the others show: no later snapshot waits it out again.
        remaining = [test_id for test_id in remaining if snapshot[lane].get(test_id) != NOT_RUN]
    workers = {worker["node_id"]: worker for worker in policy["workers"]}
    outcomes = {}
    for test_id in ids:
        outcome = {"candidate": candidate[test_id], "base": base.get(test_id, NOT_RUN),
                   "lanes": {lane: snapshot[lane].get(test_id, NOT_RUN) for lane in lanes}}
        if NOT_RUN in (candidate[test_id], base.get(test_id), *(snapshot[lane].get(test_id) for lane in lanes)):
            # Incomplete evidence never clears a lane nor names one (decisions [L7]; challenge note 1): a test hanging at
            # base too must not reach the owner rule.
            outcome.update(result=NOT_RUN, lane=None)
        elif candidate[test_id] != "failed":
            outcome.update(result="did not reproduce", lane=None)
        elif base[test_id] == "failed":
            outcome.update(result="pre-existing at base", lane=None)
        else:
            failing = [lane for lane in lanes if snapshot[lane][test_id] == "failed"]
            if len(failing) == 1:
                outcome.update(result="snapshot", lane=failing[0])
            else:
                root = import_root(gate["argv"], tree_at(plan["repository"], record["commit"]))  # G3: a dotted start is `.`.
                path = None if whole else test_file(plan["repository"], record["commit"], test_id, root)
                owners = [lane for lane in lanes if path and any(owns(path, prefix.rstrip("/")) for prefix in workers[lane]["owned_paths"])]
                outcome.update(file=path, **({"result": "owner", "lane": owners[0]} if len(owners) == 1 else {"result": "unattributed", "lane": None}))
        outcomes[test_id] = outcome
    return {"id": gate["id"], "mode": "whole" if whole else (mode[0] if mode else "whole"), "ids": ids, "reruns": reruns, "outcomes": outcomes}


def listed(ids: list[str]) -> str:
    shown = ", ".join(ids[:SHOWN_IDS])
    return shown + (f" and {len(ids) - SHOWN_IDS} more" if len(ids) > SHOWN_IDS else "")


def check_outcome(check: dict) -> tuple[str | None, bool, str]:
    """One run check's attribution as (lane or None, attributed, the reason after `run check <id> failed`). Reasons
    name ids and outcome classes only, never a path or an attempt, so a deterministic failure repeats word for word
    (challenge note 4: automatic.check_retries' identical-failure stop)."""
    if check["mode"] == "setup":
        return None, False, ", unattributed: the setup failed before it ran"
    groups = {}
    for test_id in check["ids"]:
        outcome = check["outcomes"][test_id]
        groups.setdefault(outcome["result"], []).append(test_id)
    lanes = {check["outcomes"][test_id]["lane"] for kind in ("snapshot", "owner") for test_id in groups.get(kind, [])}
    context = [f"{label}: {listed(groups[kind])}" for kind, label in (("pre-existing at base", "pre-existing at base"),
                                                                       ("did not reproduce", "did not reproduce")) if groups.get(kind)]
    if len(lanes) == 1 and not groups.get("unattributed") and not groups.get(NOT_RUN):
        lane = lanes.pop()
        attributed = groups.get("snapshot", []) + groups.get("owner", [])
        owner = f" (owner-attributed: {listed(groups['owner'])})" if groups.get("owner") else ""
        return lane, True, f": {len(attributed)} test(s) attributed to {lane}: {listed(attributed)}{owner}" + "".join(f"; {item}" for item in context)
    parts = list(context)
    if len(lanes) > 1:
        named = [f"{test_id} ({check['outcomes'][test_id]['lane']})" for kind in ("snapshot", "owner") for test_id in groups.get(kind, [])]
        parts.append(f"attributed to several lanes: {listed(named)}")
    if groups.get(NOT_RUN):
        parts.append(f"not run (a rerun timed out, was killed or its setup failed): {listed(groups[NOT_RUN])}")
    if groups.get("unattributed"):
        parts.append(f"unattributed: {listed(groups['unattributed'])}")
    return None, False, ", unattributed: " + "; ".join(parts)


def decide(attribution: dict) -> tuple[str | None, list[str]]:
    """The lane an attribution blocks, or None when it blocks every lane (unattributed), and the gate reasons: one per
    failed run check. Run checks attributed to different lanes are unattributed together."""
    reasons, lanes, unattributed = [], set(), False
    for check in attribution["checks"]:
        lane, attributed, text = check_outcome(check)
        reasons.append(f"run check {check['id']} failed{text}")
        if attributed:
            lanes.add(lane)
        else:
            unattributed = True
    if len(lanes) > 1:
        reasons.append(f"run checks name several lanes: {', '.join(sorted(lanes))}")
    return (lanes.pop() if len(lanes) == 1 and not unattributed else None), reasons


# ---- The candidate step's hook -----------------------------------------------------------------------------------

class SharedCandidate:
    """`Pipeline.candidate`'s hook: `start` before the lanes (lockstep, the shared execution, its event and the run checks'
    slow note), `reference` for
    each lane's packet, `finish` once every lane's own checks passed (the run checks' gate and attribution)."""

    def __init__(self, runtime, commit: str, generation: int, state: dict, repaired: bool):
        self.runtime, self.commit, self.generation = runtime, commit, generation
        self.reference = None
        self.record = None
        self.folder = None
        self.state = state
        policy = runtime.policy
        lanes = list(runtime.workers)
        attempts = {node: runtime.attempt("candidate", node) for node in lanes}
        reused = {node for node in lanes if runtime.reusable_packet(node, attempts[node], commit, state, repaired)}
        checked = [node for node in lanes if node not in reused]
        if not planned(policy, checked):
            return  # Nothing to share (only browser checks, or a reused lane on a policy without run checks): as before.
        attempt = self.lockstep(attempts)
        self.folder = shared_folder(runtime.directory, generation, attempt)
        commands = planned(policy, checked)
        lane_checks = sum(len(entry["lanes"]) for entry in commands)
        run_checks = len(policy.get("run_checks", []))
        runtime.event("candidate", "running", f"Shared checks: {len(commands)} commands for {lane_checks} lane checks on {commit}"
                                              + (f"; run checks: {run_checks}" if policy.get("version") == "1.5.0" else ""))
        self.record = run_shared(runtime.directory, runtime.plan, policy, self.folder, commit, generation, attempt, checked)
        self.reference = reference(runtime.directory, self.folder)
        slow = slow_run_checks(policy, self.record)
        if slow:  # The lane checks' slow note (C27), on the candidate's own event: a run check belongs to no lane. Here, not in
            # finish, so a lane blocked on its own checks still gets it (decisions [L5]).
            runtime.event("candidate", "running", f"Run checks on {commit}; slow: {', '.join(slow)}")

    def lockstep(self, attempts: dict) -> int:
        """Raise every lane's candidate attempt to the highest one (decisions [L2]), after checking each lane's limit
        (challenge note 1): a lane past its own budget ends the run with the retry-limit error, never a ValueError."""
        from .repair import attempt_limit
        runtime = self.runtime
        target = max(attempts.values())
        behind = [node for node, value in attempts.items() if value < target]
        for node in behind:
            if target >= attempt_limit(runtime.directory, runtime.policy, "candidate", node, target - 1):
                raise RuntimeError("Verification retry limit exhausted; work and evidence retained")
        if behind:
            path = runtime.directory / "attempts.json"
            counters = read_json(path) if path.exists() else {}
            counters.update({f"candidate:{node}": target for node in behind})
            save_json(path, counters)
        (runtime.directory / SHARED_DIR).mkdir(exist_ok=True)
        return target

    def finish(self) -> None:
        """Once every lane's own checks passed: gate the run checks. A failure is attributed (or transient), every lane's
        packet is written again with its run-check gate, the `candidate` and blocked `candidate_<lane>` events say why,
        and the step raises."""
        if self.record is None:
            return
        runtime = self.runtime
        directory, policy = runtime.directory, runtime.policy
        unstarted = launch_failed(self.record, [check["argv"] for check in policy.get("run_checks", [])])
        if unstarted:  # Every lane's own checks ran and passed; the run checks have no verdict to gate or attribute.
            raise RuntimeError(f"{unstarted}; see {self.folder / RECORD}")
        failed = [gate for gate in run_check_gates(policy, self.record) if gate["reasons"]]
        if not failed:
            return
        killed = [gate for gate in failed if gate["transient"]]
        real = [gate for gate in failed if not gate["transient"]]
        for gate in killed:
            runtime.event("candidate", "blocked", f"Run check {gate['id']} failed; {TRANSIENT_TEXT[gate['transient']]}: "
                          + ("transient, rerun without attribution" if not real else "listed beside the real failure, not attributed"))
        if real:
            attribution = self.attribution(real)
            for check in attribution["checks"]:
                lane, _, text = check_outcome(check)
                runtime.event("candidate", "blocked", f"Run check {check['id']} failed; {text.lstrip(':, ')}")
        from .checks import recheck_packet
        blocked = []
        for node in runtime.workers:
            attempt = runtime.attempt("candidate", node)
            path = directory / "verification" / "candidate" / node / str(attempt) / "packet.json"
            saved = read_json(path)
            gated = recheck_packet(read_json(path), policy, directory)
            saved["gate"] = gated["gate"]
            saved["result"] = {**saved["result"], **{key: gated["result"][key] for key in ("transient_checks",) if key in gated["result"]}}
            if "transient_checks" not in gated["result"]:
                saved["result"].pop("transient_checks", None)
            saved.pop(MARKER, None)
            if MARKER in gated:
                saved[MARKER] = gated[MARKER]
                for gate in failed:
                    execution = self.record["executions"][gate["execution"]] if gate["execution"] is not None else None
                    if execution is not None:
                        index = [check["id"] for check in policy["run_checks"]].index(gate["id"])
                        shutil.copyfile(self.folder / execution["log"], path.parent / f"run-check-{index}.log")
            save_json(path, saved)
            if saved["gate"]["status"] != "passed":
                blocked.append((node, attempt, path, saved["gate"]["reasons"]))
        for node, attempt, _, reasons in blocked:
            runtime.event(f"candidate_{node}", "blocked", f"Candidate gate blocked on attempt {attempt}: {'; '.join(reasons)}")
        if blocked:
            raise RuntimeError(f"Combined candidate failed {blocked[0][0]} checks; see {blocked[0][2]}")
        raise RuntimeError(f"Combined candidate failed run check {failed[0]['id']}; see {self.folder / RECORD}")  # Never reached: fail closed.

    def attribution(self, failed: list[dict]) -> dict:
        """The attempt's attribution.json: reused when it exists for this record, else every failed run check attributed,
        each rerun after the last ended."""
        runtime = self.runtime
        path = self.folder / ATTRIBUTION
        if path.exists():
            saved = read_json(path)
            if saved.get("record") == self.reference and [item["id"] for item in saved["checks"]] == [gate["id"] for gate in failed]:
                return saved
            raise ValueError(f"Existing attribution {path} is not of this attempt's failed run checks")
        snapshots = self.state["snapshots"]
        checks = [attribute_check(runtime.plan, runtime.policy, self.record, self.folder, gate, snapshots, list(runtime.workers)) for gate in failed]
        lane, reasons = decide({"checks": checks})
        attribution = {"version": RECORD_VERSION, "record": self.reference, "checks": checks, "lane": lane, "reasons": reasons, "recorded_at": now()}
        save_json(path, attribution)
        return attribution


# ---- Repair brief and clean --------------------------------------------------------------------------------------

def brief_lines(run: Path, policy: dict, packet_path: Path) -> list[str]:
    """The repair brief's lines for a packet a run check blocked (challenge note 6): each failed run check's attributed
    ids, the command that reruns them from the worktree root (for a discover run check, the candidate rerun's import
    root and `-P` behind a relative `PYTHONPATH=<root>:.` that keeps any existing entries: brief_command, [L15]), and
    the tail of its log copied beside the packet as `run-check-<i>.log`."""
    from .repair import LOG_TAIL_LINES, log_tail
    packet = read_json(packet_path)
    marker = packet.get(MARKER)
    if not isinstance(marker, dict) or not marker.get("attribution"):
        return []
    attribution = read_json(run / marker["attribution"]["path"])
    ids = [check["id"] for check in policy.get("run_checks", [])]
    lines = []
    for check in attribution["checks"]:
        index = ids.index(check["id"])
        argv = policy["run_checks"][index]["argv"]
        mine = [test_id for test_id in check["ids"] if check["outcomes"][test_id].get("lane") == packet["expected"]["node_id"]]
        mode = runner(argv) if check["mode"] != "whole" else None
        # The candidate rerun's root and `-P` (read at that commit, with that interpreter), else the argv's own.
        done = next((item for item in check.get("reruns", []) if item.get("target") == "candidate" and "import_root" in item), None)
        root = (done["import_root"] if done else import_root(argv)) if mode else "."
        found = runner(done["argv"]) if done else None
        safe = found is None or "-P" in done["argv"][:found[1]]
        command = rerun_argv(argv, mine or check["ids"], mode, root=root, safe=safe)
        log = packet_path.parent / f"run-check-{index}.log"
        lines += ["", f"### run check {check['id']} ({policy['run_checks'][index]['kind']}): {shlex.join(argv)}", "",
                  f"Failing tests attributed to this lane: {', '.join(mine) or 'none'}",
                  f"Rerun them: `{brief_command(command, root)}`", "",
                  f"Last {LOG_TAIL_LINES} lines of {log}:", "```", log_tail(log), "```"]
    return lines


def shared_attempts(run: Path) -> list[Path]:
    """The run's shared attempt folders (`shared-checks/<generation>/<attempt>`), in order."""
    return sorted((path for path in (run / SHARED_DIR).glob("*/*") if path.is_dir()),
                  key=lambda path: (int(path.parent.name) if path.parent.name.isdigit() else 0, int(path.name) if path.name.isdigit() else 0))


def passed_record(folder: Path) -> bool:
    """A shared attempt whose every execution passed every declaring check's gate (execution_passed): clean prunes its
    worktree and caches, never the record and logs the packets cite; a failed or interrupted one is kept whole."""
    try:
        record = read_json(folder / RECORD)
    except (OSError, ValueError):
        return False
    return not record.get("setup_errors") and not record.get("launch_error") and all(execution_passed(item) for item in record.get("executions", []))
