"""The critique reviewer of feature.json 2.9.0 (docs/PRD_USER_CRITIQUE.md sections 3-6).

A feature.json 2.9.0 may declare `critique` (lanes, skills, max_budget_usd, timeout_minutes) with a policy 1.4.0
`critique_app`. Its automatic run's review step then gains one reviewer, `critique`, run as a controller-owned headless
`claude --print --json-schema` job (PRD 4.4, decisions.md [L1]), launched and supervised like an attack-pass attacker
(`workflow/attack.py`), never as a native `claude --bg` reviewer:

- Opt-in. `critique.declared` refuses `critique` before 2.9.0; prepare pins `plan.critique` (the lanes intersected with the
  selected lanes, the skills with digests, the advisor model, the job argv's settings digest, the worktree paths). A plan
  without `plan.critique` means no critique reviewer, and the review launches byte for byte as today.
- The job. In a disposable worktree of the frozen candidate with the policy `setup` run, the controller starts the app on
  free ports under one browser-queue slot and runs the headless job with `Bash`, the pinned `impeccable` skill and the
  `builtin:critique` brief. The session uses the app as a user and returns structured findings (P1 or P2 only).
- The decision. The controller turns the output into a reviewer decision (verdict, findings with `worker` one of the critique
  lanes) that joins `review.json` after the native reviewers (not into `ReviewStatus.ids`, PRD 4.5). An open P1 blocks the
  review like any reviewer's and feeds the fix loop; a failed critique (app not starting, timeout, spent budget, invalid
  output) is verdict `null` which `combined_review` counts as blocking, its reason in `automatic-review-critique.json`.
- Evidence travels outside review.json's closed key sets: `$RUN/critique/<round>/evidence.json` keyed by the digest of
  `(severity, worker, message)` plus the occurrence index, with the screenshots registered as run artifacts of kind
  `screenshot` (ids `critique-<round>-<sha12>`). The export (1.11.0) carries each critique finding's `evidence`.

Every feature before 2.9.0, and a 2.9.0 one without `critique`, touches none of this.
"""
from __future__ import annotations

import argparse
import copy
import fcntl
import hashlib
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from .sessions import popen_claude, read_json, role_flags, save_json, terminate

CRITIQUE = "critique"
CRITIQUE_VERSION = "2.9.0"  # The feature version that may declare `critique`.
CRITIQUE_VERSIONS = frozenset({CRITIQUE_VERSION})  # A set the next bump must join (version-gates-are-sets-add-a-keeps-everything-test).
BUILTIN_BRIEF = Path(__file__).resolve().parent / "prompts" / "reviewers" / "critique.md"

DEFAULTS = {"skills": ["impeccable"], "max_budget_usd": 15, "timeout_minutes": 45}
BOUNDS = {"max_budget_usd": (1, 100), "timeout_minutes": (10, 120)}
INT_SETTINGS = frozenset({"timeout_minutes"})

RECORD = "automatic-review-critique.json"  # The reviewer-status file the export reads (PRD 4.4).
STATUS = "status.json"  # Under $RUN/critique/<round>/: the persisted translated decision (resume reuses it).
EVIDENCE = "evidence.json"  # Under $RUN/critique/<round>/: steps and screenshots, keyed by digest + occurrence index.
RUNNING = "critique.running.json"
JOBS = "critique.jobs.json"
STARTUP_GRACE = 15  # close_or_wait waits this for the child's running marker before it concludes the child died.
READY_POLL_SECONDS = 0.5
SLACK_SECONDS = 600  # Added to the overall bound for the slot wait and setup (the controller's wait past the review decision).

WEB_PORT_ENV = "CRITIQUE_WEB_PORT"
API_PORT_ENV = "CRITIQUE_API_PORT"


# ---- Configuration: feature.json 2.9.0 and plan.critique ------------------------------------------------------------

def settings(value: dict, where: str = "critique ") -> dict:
    """`skills`, `max_budget_usd` and `timeout_minutes` with the defaults filled in; an out-of-range or unknown key is
    refused, naming it. `lanes` is validated separately (it is a list of lanes)."""
    from .skills import validate_names
    result = {"skills": list(DEFAULTS["skills"]), "max_budget_usd": DEFAULTS["max_budget_usd"], "timeout_minutes": DEFAULTS["timeout_minutes"]}
    for key, item in value.items():
        if key == "lanes":
            continue
        if key == "skills":
            result["skills"] = validate_names(CRITIQUE, item)
            continue
        if key not in BOUNDS:
            raise ValueError(f"{where}{key} is not a critique setting ({', '.join(['lanes', 'skills', *BOUNDS])})")
        low, high = BOUNDS[key]
        number = type(item) is int or (key not in INT_SETTINGS and type(item) in (int, float))
        if not number or not low <= item <= high:
            kind = "an integer" if key in INT_SETTINGS else "a number"
            raise ValueError(f"{where}{key} must be {kind} from {low} to {high}, got {item!r}")
        result[key] = item
    return result


LANE_ID = re.compile(r"[a-z][a-z0-9-]{0,31}")


def lanes_of(value: dict, where: str = "critique ") -> list[str]:
    lanes = value.get("lanes")
    if not isinstance(lanes, list) or not lanes or len(set(lanes)) != len(lanes) or any(not isinstance(item, str) or not LANE_ID.fullmatch(item) for item in lanes):
        raise ValueError(f"{where}lanes must be 1 or more distinct lane ids, got {lanes!r}")
    return list(lanes)


def declared(manifest: dict) -> dict | None:
    """The feature's `critique` as `{lanes, skills, max_budget_usd, timeout_minutes}` with the defaults filled in; None
    without one (absent or false). Refused, naming feature.json and the key: `critique` before 2.9.0, a value that is
    neither false nor an object, an unknown key and an out-of-range bound. (That the lanes are lanes of the feature and
    the policy declares `critique_app` are checked at launch, which has the workers and the policy.)"""
    value = manifest.get("critique", False)
    if value is False:
        return None
    if manifest.get("version") not in CRITIQUE_VERSIONS:
        raise ValueError(f"feature.json critique needs version {CRITIQUE_VERSION} or later (this file is {manifest.get('version')})")
    if not isinstance(value, dict):
        raise ValueError("feature.json critique must be false or an object with lanes")
    result = {"lanes": lanes_of(value, "feature.json critique.")}
    result.update(settings(value, "feature.json critique."))
    return result


def validate_critique_app(app) -> dict:
    """policy.critique_app: `{argv, ready_path, timeout_seconds}` with a ready_path that begins with `/`."""
    if not isinstance(app, dict):
        raise ValueError("policy critique_app must be an object {argv, ready_path, timeout_seconds}")
    argv = app.get("argv")
    if not isinstance(argv, list) or not argv or any(not isinstance(item, str) or not item for item in argv):
        raise ValueError("policy critique_app.argv must be a non-empty list of non-empty strings")
    ready = app.get("ready_path")
    if not isinstance(ready, str) or not ready.startswith("/"):
        raise ValueError("policy critique_app.ready_path must be a path beginning with /")
    timeout = app.get("timeout_seconds")
    if type(timeout) is not int or not 1 <= timeout <= 3600:
        raise ValueError("policy critique_app.timeout_seconds must be an integer from 1 to 3600")
    if set(app) != {"argv", "ready_path", "timeout_seconds"}:
        raise ValueError("policy critique_app has only argv, ready_path and timeout_seconds")
    return {"argv": list(argv), "ready_path": ready, "timeout_seconds": timeout}


def has_critique(plan: dict) -> bool:
    """The run declares a critique reviewer: `plan.critique`, pinned at prepare. Never an entry of `plan['nodes']`."""
    return isinstance(plan.get("critique"), dict)


def refuse_print_transport(transport) -> None:
    """Refuse the print transport for a critique run (PRD 4.4, one integration path): prepare calls this when it pins
    `plan.critique`."""
    if transport == "print":
        raise ValueError("The critique reviewer (feature.json 2.9.0) cannot run with --reviewer-transport print; use the native transport")


def digest_text(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def pin(plan: dict, values: dict, selected: list[str], skills: list[dict], settings_sha256: str, advisor_model: str | None,
        critique_app: dict, worktree: str) -> None:
    """prepare: `plan.critique`. `values` is `critique.declared`; `selected` is the run's selected lanes. The pinned lanes
    are the intersection of `critique.lanes` with the selected lanes (design-challenge note 2); an empty intersection is
    refused. `skills` is `[{name, sha256}]` as a lane's. `settings_sha256` is the digest of the job's `--settings` JSON.
    """
    if CRITIQUE in selected:  # A feature that declares `critique` may not have a lane named `critique` (PRD 4.7); refused at launch and prepare.
        raise ValueError("A feature that declares critique may not have a lane named `critique` (PRD 4.7)")
    pinned_lanes = [lane for lane in values["lanes"] if lane in selected]
    if not pinned_lanes:
        raise ValueError(f"critique.lanes {values['lanes']} name no selected lane ({', '.join(selected)}); select one of them or drop critique")
    plan["critique"] = {
        "lanes": pinned_lanes, "skills": skills, "max_budget_usd": values["max_budget_usd"],
        "timeout_minutes": values["timeout_minutes"], "settings_sha256": settings_sha256,
        "advisor_model": advisor_model, "critique_app": validate_critique_app(critique_app), "worktree": worktree}
    plan["feature_version"] = CRITIQUE_VERSION


PLAN_KEYS = {"lanes", "skills", "max_budget_usd", "timeout_minutes", "settings_sha256", "advisor_model", "critique_app", "worktree"}


def validate_plan(plan: dict) -> None:
    item = plan.get("critique")
    if item is None:
        return
    if not isinstance(item, dict) or set(item) != PLAN_KEYS:
        raise ValueError("Malformed plan.critique: expected {" + ", ".join(sorted(PLAN_KEYS)) + "}")
    lanes_of(item, "plan.critique.")
    for key in ("max_budget_usd", "timeout_minutes"):  # The pinned bounds; `skills` is the pinned [{name, sha256}] list, not names.
        low, high = BOUNDS[key]
        if not low <= item[key] <= high:
            raise ValueError(f"plan.critique.{key} out of range")
    if not isinstance(item["skills"], list) or any(not isinstance(s, dict) or set(s) != {"name", "sha256"} for s in item["skills"]):
        raise ValueError("plan.critique.skills must be a list of {name, sha256}")
    validate_critique_app(item["critique_app"])


# ---- Rounds, records and evidence keys ------------------------------------------------------------------------------

def critique_dir(directory: Path) -> Path:
    return Path(directory) / "critique"


def round_dir(directory: Path, round_number: int) -> Path:
    return critique_dir(directory) / str(round_number)


class MalformedRounds(RuntimeError):
    """review-rounds.json cannot be read: current_round fails closed rather than guess round 1 (panel item 10)."""


def current_round(directory: Path) -> int:
    """The fix loop's current review round (1 for the first review). `review-rounds.json` holds the archived rounds;
    the live round is one past the last archived one. A malformed journal fails closed (never a silent round 1), so the
    critique is recorded failed rather than reviewing the wrong round or overwriting another round's evidence."""
    path = Path(directory) / "review-rounds.json"
    if not path.exists():
        return 1
    try:
        data = read_json(path)
    except (OSError, ValueError) as error:
        raise MalformedRounds(f"review-rounds.json is unreadable: {error}") from None
    rounds = data.get("rounds") if isinstance(data, dict) else None
    if not isinstance(rounds, list) or any(not isinstance(item, dict) for item in rounds):
        raise MalformedRounds("review-rounds.json has no valid rounds list")
    return len([r for r in rounds if r.get("archived")]) + 1


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"  # The 8-byte PNG magic; a `.png` whose content is not a PNG is refused (followup P2 #31).


def confined_png(directory: Path, round_number: int, raw, base: Path | None = None) -> Path | None:
    """A screenshot path resolved to its real file only when it lies (symlinks resolved) inside `$RUN/critique/<round>/`,
    is a regular `.png` AND begins with the PNG magic bytes; None otherwise. The one confinement, applied when the job
    reports a path (safe_screenshots, a path relative to the round folder or absolute) and again on read from
    evidence.json (round_evidence, artifacts, where the stored path is run-relative — `base=directory`), so a rewritten
    evidence.json cannot point the server at a host file (panel item 4). The magic-byte check stops a verbatim copy of a
    non-PNG host file from being published through the artifact route (the Bash write limit is advisory, followup P2 #31)."""
    if not isinstance(raw, str) or not raw:
        return None
    root = round_dir(directory, round_number).resolve()
    base = root if base is None else Path(base).resolve()
    resolved = Path(raw).resolve() if os.path.isabs(raw) else (base / raw).resolve()
    if not resolved.is_relative_to(root) or resolved.is_symlink() or not resolved.is_file() or resolved.suffix.lower() != ".png":
        return None
    try:
        with resolved.open("rb") as handle:
            if handle.read(len(PNG_SIGNATURE)) != PNG_SIGNATURE:
                return None
    except OSError:
        return None
    return resolved


def evidence_key(severity: str, worker: str, message: str, occurrence: int) -> str:
    """A critique finding's evidence key: the digest of `(severity, worker, message)` plus the occurrence index among
    critique findings with that digest, so duplicates keep their own evidence (PRD 4.5, decisions.md [L2])."""
    base = digest_text("\0".join([severity, worker, message]))
    return f"{base}:{occurrence}"


def artifact_id(round_number: int, path: Path) -> str:
    """`critique-<round>-<sha12>`: a run artifact id for one critique screenshot, from the file's content digest. Cannot
    collide with `screenshot-<scenario>` ids (PRD 4.5)."""
    with Path(path).open("rb") as handle:
        sha = hashlib.file_digest(handle, "sha256").hexdigest()
    return f"critique-{round_number}-{sha[:12]}"


def record_path(directory: Path) -> Path:
    return Path(directory) / RECORD


def load_record(directory: Path) -> dict | None:
    path = record_path(directory)
    return read_json(path) if path.exists() else None


# ---- The job's output schema ----------------------------------------------------------------------------------------

def output_schema(lanes: list[str]) -> dict:
    """The critique job's `--json-schema`: verdict, findings with severity P1 or P2 only (PRD 4.4; the schema makes P0 and
    P3 impossible), `worker` one of the critique lanes, and evidence (1-20 numbered steps, 0-6 screenshots under the
    round folder). The brief requires a P1 to carry numbered steps inline in its message and at least one screenshot."""
    return {
        "type": "object", "additionalProperties": False, "required": ["verdict", "findings"],
        "properties": {
            "verdict": {"enum": ["approved", "blocked"]},
            "findings": {"type": "array", "maxItems": 50, "items": {
                "type": "object", "additionalProperties": False,
                "required": ["severity", "worker", "message", "evidence"],
                "properties": {
                    "severity": {"enum": ["P1", "P2"]},
                    "worker": {"enum": list(lanes)},
                    "message": {"type": "string", "minLength": 1, "maxLength": 8000},
                    "evidence": {
                        "type": "object", "additionalProperties": False, "required": ["steps", "screenshots"],
                        "properties": {
                            "steps": {"type": "array", "minItems": 1, "maxItems": 20,
                                      "items": {"type": "string", "minLength": 1, "maxLength": 300}},
                            "screenshots": {"type": "array", "maxItems": 6, "items": {
                                "type": "object", "additionalProperties": False, "required": ["path", "caption"],
                                "properties": {"path": {"type": "string", "minLength": 1},
                                               "caption": {"type": "string", "maxLength": 200}}}}}}}}}}}


def validate_output(value, lanes: list[str]) -> None:
    from jsonschema import Draft202012Validator
    Draft202012Validator(output_schema(lanes)).validate(value)


# ---- The job's settings, command and environment --------------------------------------------------------------------

def critique_settings(directory: Path, advisor_model: str | None) -> list[str]:
    """The critique job's `--settings`: `worker_settings(directory, skills_lane="critique", advisor_model)` plus Edit and
    Write denies on all of the run directory, with no exception (PRD 4.4, design-challenge note 1). The same every round,
    so one digest is pinned at prepare."""
    from .sessions import worker_settings
    return worker_settings(directory, skills_lane=CRITIQUE, advisor_model=advisor_model, deny_run=True)


def critique_command(executable: str, session_id: str, schema: dict, worktree: Path, directory: Path, settings_flags: list[str],
                     budget_usd, pins: list[str] | tuple[str, ...] = ()) -> list[str]:
    """One `claude --print --output-format json --json-schema` critique job (PRD 4.4): the 2.8.0 skills mechanism
    (`--setting-sources "" --plugin-dir <run>/skills/critique`, no `--safe-mode`), the empty MCP config, the tools
    Read,Glob,Grep,Bash,Skill,Write, the pinned `--settings`, the attacker's permission mode for Bash and Write under
    `--print`, a budget, and the pinned judges' model and effort. cwd is the worktree, added as `--add-dir`."""
    plugin = Path(directory).resolve() / "skills" / CRITIQUE
    command = [executable, "--print", "--output-format", "json", "--session-id", session_id, *pins,
               "--setting-sources", "", "--plugin-dir", str(plugin),
               "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
               "--tools", "Read,Glob,Grep,Bash,Skill,Write", *settings_flags,
               "--permission-mode", "bypassPermissions", "--dangerously-skip-permissions",
               "--max-budget-usd", str(budget_usd), "--add-dir", str(worktree)]
    return command + ["--json-schema", json.dumps(schema)]


def critique_env(environ=None) -> dict:
    """The attacker's environment (checks.check_environment scrubbed, the Claude Code auth/provider variables put back),
    so the app the job starts gets the scrubbed environment and the job's own Claude credentials survive (PRD 4.4, G5)."""
    from .attack import attacker_env
    return attacker_env(environ)


# ---- The prompt -----------------------------------------------------------------------------------------------------

def completion_verify(directory: Path, lane: str) -> str | None:
    """A lane worker's `verify_yourself` from its completion file (`$RUN/<lane>.completion.json`, contracts/projects/v1.ts),
    the line the critique walks as a user (PRD 4.4, [O1]); None when the completion is absent, unreadable or carries none.
    It is a field of the worker's completion, NOT a line of the task text (review finding 7)."""
    path = Path(directory) / f"{lane}.completion.json"
    if not path.exists():
        return None
    try:
        value = read_json(path).get("verify_yourself")
    except (OSError, ValueError):
        return None
    return value.strip() if isinstance(value, str) and value.strip() else None


def critique_prompt(directory: Path, plan: dict, url: str, previous: list[dict] | None = None, delta: str | None = None) -> str:
    """`builtin:critique`, the app URL, and for each critique lane its task's `## Goal` and the worker's `verify_yourself`
    line (from the lane's completion file); on round 2 or later the previous round's findings and the delta (PRD 4.4)."""
    from .attack import goal_section
    brief = BUILTIN_BRIEF.read_text()
    parts = [brief.rstrip(), "=== The running app ===", f"The candidate's app is running at {url}. Use it as a user through Bash (a headless browser you start there, or curl); save screenshots under {round_dir(directory, current_round(directory))}."]
    parts.append("=== The lanes to walk ===")
    nodes = plan.get("nodes", {})
    for lane in plan["critique"]["lanes"]:
        task = (nodes.get(lane) or {}).get("task", "")
        goal = goal_section(task) if task else "(no task)"
        vy = completion_verify(directory, lane)
        parts.append(f"--- Lane {lane} ---\nGoal:\n{goal}" + (f"\n\nverify_yourself: {vy}" if vy else ""))
    if previous:
        parts.append("=== The previous round's critique findings (fix or confirm each) ===")
        for finding in previous:
            parts.append(f"[{finding.get('severity')}] {finding.get('worker')}: {finding.get('message')}")
    if delta:
        parts.append("=== What changed since the previous round (delta) ===\n" + delta[:40000])
    parts.append("Return the requested JSON schema. P1 only for a promised flow that does not work or a UI that misleads the user, each with numbered steps inline in the message and at least one screenshot; everything else is P2.")
    return "\n\n".join(parts) + "\n"


# ---- Free ports and the app -----------------------------------------------------------------------------------------

def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def app_ready(web_port: int, ready_path: str) -> bool:
    url = f"http://127.0.0.1:{web_port}{ready_path}"
    try:
        with urllib.request.urlopen(url, timeout=2) as response:
            return 200 <= response.status < 500
    except urllib.error.HTTPError as error:
        return 200 <= error.code < 500
    except (urllib.error.URLError, OSError, ValueError):
        return False


# ---- Helpers shared with attack -------------------------------------------------------------------------------------

def iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat().replace("+00:00", "Z")


def clip(text: str | None, limit: int) -> str | None:
    return text if text is None else text[:limit]


def git(worktree: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(worktree), *args], capture_output=True, text=True)


def reset_worktree(worktree: Path) -> None:
    git(worktree, "checkout", "--", ".")
    git(worktree, "clean", "-fd")
    status = git(worktree, "status", "--porcelain")
    if status.stdout.strip():
        raise RuntimeError(f"Critique worktree not clean after reset: {status.stdout.strip()[:500]}")


def setup_inputs_digest(worktree: Path) -> str:
    """The digest of the policy setup's inputs (package.json and package-lock.json), so setup reruns when a repair adds a
    dependency (PRD 4.7)."""
    digest = hashlib.sha256()
    for name in ("package.json", "package-lock.json"):
        path = worktree / name
        digest.update(name.encode())
        digest.update(b"\0")
        digest.update(path.read_bytes() if path.exists() else b"")
        digest.update(b"\0")
    return digest.hexdigest()


# ---- The child: one critique over the frozen candidate --------------------------------------------------------------

class CritiqueFailed(RuntimeError):
    """The critique could not produce a decision (app down, timeout, spent budget, invalid output): a failed reviewer."""


class CritiqueChild:
    """One run of the critique reviewer over the frozen candidate, in a disposable worktree. Launched and supervised like
    an attack-pass attacker; it persists a translated decision to `$RUN/critique/<round>/status.json` (resume reuses it)
    and never raises into the caller. A failure is recorded as a failed reviewer, never a finding (PRD 4.4)."""

    def __init__(self, directory: Path, clock=time.time):
        self.directory = Path(directory).resolve()
        self.plan = read_json(self.directory / "plan.json")
        self.policy = read_json(self.directory / "policy.json")
        self.executable = os.environ.get("WORKFLOW_CLAUDE", "claude")
        self.clock = clock
        self.item = self.plan["critique"]
        self.worktree = Path(self.item["worktree"])
        self.round = current_round(self.directory)
        self.round_dir = round_dir(self.directory, self.round)
        self.started = clock()

    # -- records and events --
    def event(self, status: str, message: str) -> None:
        from .pipeline import append_event
        append_event(self.directory, "review", status, message)

    def note_job(self, pid: int, session_id: str) -> None:
        # Keyed by round and session so a stale pid from an earlier round is never mistaken for a live one (panel item 8).
        save_json(self.directory / JOBS, {"critique": {"pid": pid, "session_id": session_id, "round": self.round}})

    def clear_jobs(self) -> None:
        (self.directory / JOBS).unlink(missing_ok=True)

    def jobs(self) -> dict:
        path = self.directory / JOBS
        return read_json(path) if path.exists() else {}

    def save_record(self, status: str, reason: str | None, session_id: str | None, launched_at: str | None) -> None:
        # `retries` counts the reruns of a FAILED critique for this round: 0 on the first failure (so a resume reruns it
        # once, decisions.md [L2](c)), 1 on the rerun's failure (so it is then settled). settled() reads it.
        retries = 0
        if status == "failed":
            existing = load_record(self.directory)
            if existing and existing.get("status") == "failed" and existing.get("round") == self.round:
                retries = int(existing.get("retries", 0)) + 1
        record = {"reviewer_id": CRITIQUE, "status": status, "reason": reason, "session_id": session_id,
                  "round": self.round, "retries": retries, "launched_at": launched_at, "finished_at": iso(self.clock())}
        save_json(record_path(self.directory), record)

    def cleanup(self) -> None:
        """Kill the `claude --print` job's process group (it runs in its own session, so an interrupt of this child does
        not reach it, panel item 5) and stop the app; both are reachable through instance attributes even when the job or
        the app's ready-wait was interrupted mid-way. The group is killed even after the job's own process exited, so a
        background process it started with Bash (a headless browser, a second dev server) does not outlive the round
        holding ports and memory (followup P2 #32)."""
        process = getattr(self, "job_process", None)
        if process is not None:
            for sig in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.killpg(process.pid, sig)  # the whole session group, even if the leader already exited but children remain
                except (ProcessLookupError, PermissionError):
                    break  # the group is gone (no member left): nothing more to reap
                for _ in range(30):
                    if process.poll() is not None:
                        break
                    time.sleep(0.1)
        self.stop_app(getattr(self, "app", None))
        self.clear_jobs()

    # -- the run --
    def run(self) -> None:
        if (self.round_dir / STATUS).exists():
            return  # A persisted decision (resume reuses it; the review reads it).
        self.claim()
        self.app = None
        self.job_process = None
        launched_at = None
        session_id = str(uuid.uuid4())
        try:
            self.round_dir.mkdir(parents=True, exist_ok=True)
            self.ensure_worktree()
            from .browser_queue import browser_slot
            with browser_slot(f"{self.plan['run_id']} critique"):  # the slot is held for the whole span, released on any exit
                self.start_app()  # sets self.app (the started process is reachable before the ready-wait returns)
                launched_at = iso(self.clock())
                output = self.run_job(session_id, self.app["url"], launched_at)
                decision, evidence = self.translate(output)
                self.persist(decision, evidence, session_id, launched_at)
                self.save_record("accepted", None, session_id, launched_at)
                self.event("note", f"Critique reviewer: {decision['verdict']}, {len(decision['findings'])} finding(s) (round {self.round})")
        except KeyboardInterrupt:
            self.cleanup()
            raise  # The controller interrupted the child: record nothing; the next controller resumes (reruns the job).
        except CritiqueFailed as error:
            self.cleanup()
            self.save_record("failed", clip(str(error), 2000), session_id, launched_at)
            self.event("note", f"Critique reviewer failed: {clip(str(error), 400)} (round {self.round})")
        except BaseException as error:  # noqa: BLE001 - the critique never raises into the review step.
            self.cleanup()
            self.save_record("failed", clip(f"{type(error).__name__}: {error}", 2000), session_id, launched_at)
            self.event("note", f"Critique reviewer failed: {type(error).__name__} (round {self.round})")
        finally:
            self.cleanup()
            (self.directory / RUNNING).unlink(missing_ok=True)

    def claim(self) -> None:
        save_json(self.directory / RUNNING, {"pid": os.getpid(), "started_at": iso(self.started),
                                             "cmdline": f"workflow.critique {self.directory}"})

    # -- the worktree --
    def _git_checked(self, *args: str) -> subprocess.CompletedProcess:
        result = git(self.worktree, *args)
        if result.returncode != 0:
            raise CritiqueFailed(f"git {' '.join(args)} failed in the critique worktree: {result.stderr.strip()[:300]}")
        return result

    def ensure_worktree(self) -> None:
        """The critique worktree at the candidate commit, reset every round, with the policy setup run once (or again when
        package.json/package-lock.json changed, PRD 4.7). Reset FIRST, then move to the candidate, and check every git
        call: a dirty tracked file left from a previous round must not fail the checkout, and the critique never reviews a
        stale candidate (panel item 2)."""
        from .worktrees import git_worktree
        from .attack import run_setup, _check_env
        bundle = read_json(self.directory / "review-bundle.json")
        commit = bundle["candidate_commit"]
        repo = self.plan["repository"]
        self.worktree.parent.mkdir(parents=True, exist_ok=True)
        if not (self.worktree / ".git").exists():
            git_worktree(repo, "add", "--detach", str(self.worktree), commit)
        else:
            self._git_checked("checkout", "--", ".")  # discard tracked modifications before the move
            self._git_checked("clean", "-fd")          # and untracked files (not ignored setup outputs)
            self._git_checked("checkout", "--detach", commit)
        head = self._git_checked("rev-parse", "HEAD").stdout.strip()
        if head != commit:
            raise CritiqueFailed(f"the critique worktree is at {head[:12]}, not the frozen candidate {commit[:12]}")
        dirty = self._git_checked("status", "--porcelain").stdout.strip()
        if dirty:
            raise CritiqueFailed(f"the critique worktree is not clean at the candidate: {dirty[:300]}")
        env, _ = _check_env()
        marker = critique_dir(self.directory) / "setup.done"
        inputs = setup_inputs_digest(self.worktree)
        previous = marker.read_text().strip() if marker.exists() else None
        if previous != inputs:
            critique_dir(self.directory).mkdir(parents=True, exist_ok=True)
            run_setup(self.policy, self.worktree, critique_dir(self.directory), env, prefix="setup")
            marker.write_text(inputs + "\n")

    # -- the app --
    def start_app(self) -> None:
        """Start `critique_app` on free ports and wait until it answers `ready_path`. The started process is recorded on
        `self.app` BEFORE the ready-wait loop, so an interrupt mid-wait can still stop it (panel item 5): `self.app` is no
        longer None once the process exists. Raises CritiqueFailed if the app exits or never answers."""
        from .attack import _check_env
        app = self.item["critique_app"]
        web_port, api_port = free_port(), free_port()
        env, _ = _check_env()
        env = {**env, WEB_PORT_ENV: str(web_port), API_PORT_ENV: str(api_port)}
        log = (self.round_dir / "app.log").open("w")
        process = subprocess.Popen(app["argv"], cwd=self.worktree, env=env, stdin=subprocess.DEVNULL,
                                   stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        self.app = {"process": process, "log": log, "web_port": web_port, "api_port": api_port, "url": f"http://127.0.0.1:{web_port}"}
        deadline = self.clock() + app["timeout_seconds"]
        while self.clock() < deadline:
            if process.poll() is not None:
                raise CritiqueFailed(f"the app exited (code {process.returncode}) before it answered; see critique/{self.round}/app.log")
            if app_ready(web_port, app["ready_path"]):
                return
            time.sleep(READY_POLL_SECONDS)
        raise CritiqueFailed(f"the app did not answer {app['ready_path']} within {app['timeout_seconds']}s; see critique/{self.round}/app.log")

    def stop_app(self, app) -> None:
        if not app:
            return
        process = app.get("process")
        if process is not None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
                for _ in range(30):
                    if process.poll() is not None:
                        break
                    time.sleep(0.1)
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        log = app.get("log")
        if log is not None:
            try:
                log.close()
            except OSError:
                pass

    # -- the job --
    def run_job(self, session_id: str, url: str, launched_at: str) -> dict:
        previous, delta = self.previous_round()
        prompt = critique_prompt(self.directory, self.plan, url, previous, delta)
        prompt_path = self.round_dir / "prompt.txt"
        prompt_path.write_text(prompt)
        os.chmod(prompt_path, 0o600)
        stdout_path = self.round_dir / "stdout.json"
        stderr_path = self.round_dir / "stderr.log"
        schema = output_schema(self.item["lanes"])
        command = critique_command(self.executable, session_id, schema, self.worktree, self.directory,
                                   critique_settings(self.directory, self.item.get("advisor_model")),
                                   self.item["max_budget_usd"], role_flags(self.plan, "judges"))
        self.save_record("running", None, session_id, launched_at)
        env = critique_env()
        with prompt_path.open() as stdin, stdout_path.open("w") as out, stderr_path.open("w") as err:
            process = popen_claude(command, cwd=self.worktree, env=env, stdin=stdin, stdout=out, stderr=err, text=True, start_new_session=True)
        self.job_process = process  # reachable for cleanup(): the job runs in its own session, so an interrupt of this child does not reach it (panel item 5)
        self.note_job(process.pid, session_id)
        limit = self.item["timeout_minutes"] * 60
        start = self.clock()
        while process.poll() is None:
            if self.clock() - start >= limit:
                terminate(process)
                raise CritiqueFailed(f"the critique job timed out after {self.item['timeout_minutes']} minutes; see critique/{self.round}/stderr.log")
            time.sleep(0.2)
        try:
            result = read_json(stdout_path)
        except (OSError, ValueError):
            result = {}
        if not isinstance(result, dict) or process.returncode != 0 or result.get("session_id") != session_id \
                or result.get("is_error") is not False or result.get("subtype") != "success":
            raise CritiqueFailed(f"the critique job did not succeed (exit {process.returncode}); see critique/{self.round}/stdout.json")
        output = result.get("structured_output")
        try:
            validate_output(output, self.item["lanes"])
        except Exception as error:  # noqa: BLE001
            raise CritiqueFailed(f"the critique job returned invalid output: {clip(str(error), 500)}") from error
        return output

    def previous_round(self) -> tuple[list[dict] | None, str | None]:
        """The previous round's critique findings and this round's delta, for round 2 or later (PRD 4.4). The delta is the
        LIVE `review.delta.diff` the review step wrote for this round (as `review_prompt` gives the native reviewers), not
        the previous round's archived `review.delta.round-<k-1>.diff` (panel item 1)."""
        if self.round <= 1:
            return None, None
        prev = round_dir(self.directory, self.round - 1) / STATUS
        findings = None
        if prev.exists():
            try:
                findings = read_json(prev).get("accepted_decision", {}).get("findings")
            except (OSError, ValueError):
                findings = None
        delta = None
        delta_path = self.directory / "review.delta.diff"
        if delta_path.exists():
            try:
                delta = delta_path.read_text(errors="replace")
            except OSError:
                delta = None
        return findings, delta

    # -- translation and evidence (PRD 4.5) --
    def translate(self, output: dict) -> tuple[dict, dict]:
        """The job output as a reviewer decision plus the evidence map. Each finding becomes
        `{severity, message, disposition: "open", worker, requirement: null, reviewer: "critique"}`; `evidence` is stripped
        to `$RUN/critique/<round>/evidence.json` keyed by the digest of `(severity, worker, message)` plus the occurrence
        index. Each screenshot path must resolve (symlinks resolved) inside the round folder and be a PNG; any other path
        is dropped and the refusal recorded, so no host file is read or exported through it."""
        findings, evidence, seen = [], {}, {}
        for raw in output["findings"]:
            severity, worker, message = raw["severity"], raw["worker"], raw["message"]
            key_base = digest_text("\0".join([severity, worker, message]))
            occurrence = seen.get(key_base, 0)
            seen[key_base] = occurrence + 1
            key = f"{key_base}:{occurrence}"
            shots, refusals = self.safe_screenshots(raw["evidence"].get("screenshots", []))
            evidence[key] = {"steps": [clip(step, 300) for step in raw["evidence"]["steps"][:20]], "screenshots": shots}
            if refusals:
                evidence[key]["refused"] = refusals
            findings.append({"severity": severity, "message": message, "disposition": "open", "worker": worker,
                             "requirement": None, "reviewer": CRITIQUE})
        verdict = "blocked" if any(f["severity"] in ("P0", "P1") for f in findings) or (output["verdict"] == "blocked" and not findings) else "approved"
        return {"verdict": verdict, "findings": findings}, evidence

    def safe_screenshots(self, screenshots: list[dict]) -> tuple[list[dict], list[str]]:
        """Each screenshot kept only when its path resolves (symlinks resolved) inside `$RUN/critique/<round>/` and is a
        PNG; any other path is dropped (the finding keeps its text) and the refusal recorded. The registered artifact id
        is `critique-<round>-<sha12>`."""
        kept, refused = [], []
        for shot in screenshots:
            raw = shot.get("path", "")
            resolved = confined_png(self.directory, self.round, raw)
            if resolved is None:
                refused.append(raw)
                continue
            kept.append({"artifact_id": artifact_id(self.round, resolved),
                         "path": str(resolved.relative_to(self.directory)), "caption": clip(shot.get("caption", ""), 200)})
        return kept, refused

    def persist(self, decision: dict, evidence: dict, session_id: str, launched_at: str) -> None:
        """The translated decision and evidence persisted before the slot is released (PRD 4.4): a resume reuses them."""
        save_json(self.round_dir / EVIDENCE, {"version": "1.0.0", "round": self.round, "evidence": evidence})
        save_json(self.round_dir / STATUS, {"reviewer_id": CRITIQUE, "round": self.round, "session_id": session_id,
                                            "launched_at": launched_at, "accepted_decision": decision})


def _sigterm(child: CritiqueChild):
    def handler(*_):
        for info in child.jobs().values():
            pid = info.get("pid")
            if isinstance(pid, int):
                try:
                    os.killpg(pid, signal.SIGTERM)
                except (ProcessLookupError, PermissionError):
                    pass
        raise KeyboardInterrupt
    return handler


def run_child(run: str) -> None:
    child = CritiqueChild(Path(run))
    signal.signal(signal.SIGTERM, _sigterm(child))
    try:
        child.run()
    except KeyboardInterrupt:
        pass


def main(argv=None) -> None:
    parser = argparse.ArgumentParser(prog="python -m workflow.critique", description="Run the critique reviewer child over a run's frozen candidate.")
    parser.add_argument("run", help="the run directory")
    args = parser.parse_args(argv)
    run_child(args.run)


if __name__ == "__main__":
    main()


# ---- The review step's hooks ----------------------------------------------------------------------------------------

def _controller_checkout() -> Path:
    return Path(__file__).resolve().parents[1]


def _child_pid(directory: Path):
    try:
        return read_json(directory / RUNNING).get("pid")
    except (OSError, ValueError):
        return None


def _child_running(directory: Path) -> bool:
    pid = _child_pid(directory)
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        command = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
    except OSError:
        return False
    return "workflow.critique" in command and str(directory) in command


def settled(directory: Path) -> bool:
    """The critique has a decision or is finally failed for the current round: the review may decide (PRD 4.4). A FAILED
    critique is settled only once the review has decided (review.json) or it has been rerun once ([L2](c), panel item 3);
    before that, settled is False so a resume reruns the failed critique once."""
    rnd = current_round(directory)
    if (round_dir(directory, rnd) / STATUS).exists():
        return True
    record = load_record(directory)
    if record is None or record.get("status") != "failed" or record.get("round") != rnd:
        return False
    if (directory / "review.json").exists():
        return True
    return int(record.get("retries", 0)) >= 1


def failed_record(directory: Path, reason: str, session_id: str | None = None, launched_at: str | None = None) -> dict:
    """A `failed` reviewer record with `retries` carried forward (0 on the first failure, +1 per rerun), so settled() can
    rerun a failed critique exactly once on resume ([L2](c))."""
    rnd = current_round(directory)
    existing = load_record(directory)
    retries = int(existing.get("retries", 0)) + 1 if existing and existing.get("status") == "failed" and existing.get("round") == rnd else 0
    return {"reviewer_id": CRITIQUE, "status": "failed", "reason": reason, "session_id": session_id,
            "round": rnd, "retries": retries, "launched_at": launched_at, "finished_at": iso(time.time())}


@contextmanager
def _start_lock(directory: Path):
    """Serialises the start claim so two near-simultaneous `ensure_started` calls (or controllers) do not spawn two
    children in the window before the child writes its RUNNING marker (panel item 6)."""
    with (directory / "critique.start.lock").open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def ensure_started(runtime) -> None:
    """Start the critique child once, before the reviewers launch and on a re-entry while it has not settled. Idempotent
    under the start lock: nothing happens for a plan without `critique`, when the round has settled or a live child runs;
    after a launch it waits briefly for the child's RUNNING marker so a following call sees the live child (panel item 6)."""
    if not has_critique(runtime.plan):
        return
    directory = runtime.directory
    with _start_lock(directory):
        if settled(directory) or _child_running(directory):
            return
        command = [sys.executable, "-m", "workflow.critique", str(directory)]
        subprocess.Popen(command, cwd=str(_controller_checkout()), start_new_session=True,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(150):  # up to ~3 s for the child to claim RUNNING, so a concurrent caller sees it and never double-launches
            if _child_running(directory) or settled(directory):
                return
            time.sleep(0.02)


CHILD_STOP_GRACE = 80  # 0.1 s each: 8 s, longer than the child's own up-to-3 s app stop plus its cleanup (panel item 7).


def stop_child(directory: Path) -> None:
    if not _child_running(directory):
        return
    pid = _child_pid(directory)
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(pid, sig)
        except (ProcessLookupError, PermissionError):
            return
        # Give SIGTERM long enough for the child to stop its app (up to 3 s) and release the slot before escalating.
        for _ in range(CHILD_STOP_GRACE):
            if not Path(f"/proc/{pid}").exists():
                return
            time.sleep(0.1)


def wait_bound(plan: dict, policy: dict) -> float:
    """How long the controller waits for the critique after the native reviewers settle: the job's own deadline plus the
    setup and slot-wait slack (PRD 4.4: the slot wait comes before the job's own deadline)."""
    from .attack import setup_seconds
    return plan["critique"]["timeout_minutes"] * 60 + 2 * setup_seconds(policy) + plan["critique"]["critique_app"]["timeout_seconds"] + SLACK_SECONDS


def wait_for_critique(runtime, *, clock=time.time, sleep=time.sleep, bound: float | None = None) -> None:
    """Block until the critique has a decision or failed for this round (PRD 4.4). A native block does not stop the job;
    the review waits here after the native reviewers are settled. On the bound the child is stopped and recorded failed.
    No-op for a plan without `critique`."""
    if not has_critique(runtime.plan):
        return
    directory = runtime.directory
    # Start the child only if it has neither settled nor already failed this round. A failure recorded for this round
    # means the child already ran to a failure in THIS step (started before the native reviewers): the review decides now
    # with its null verdict, and the rerun happens on a resume, through _review_candidate's ensure_started, exactly once
    # (PRD 4.4, 6, [L2](c)) — not a second run inside the same live review step (review finding 3).
    if not settled(directory) and not _failed_this_round(directory):
        ensure_started(runtime)
    limit = clock() + (bound if bound is not None else wait_bound(runtime.plan, _policy(runtime)))
    seen_alive = False
    while not settled(directory):
        alive = _child_running(directory)
        seen_alive = seen_alive or alive
        if not alive and (seen_alive or clock() - (limit - (bound or wait_bound(runtime.plan, _policy(runtime)))) > STARTUP_GRACE):
            if not settled(directory):
                _record_failed(directory, "the critique child exited without a decision")
            return
        if clock() >= limit:
            stop_child(directory)
            _record_failed(directory, "the critique did not settle within its bound")
            return
        sleep(1)


def _policy(runtime) -> dict:
    return getattr(runtime, "policy", None) or read_json(runtime.directory / "policy.json")


def _failed_this_round(directory: Path) -> bool:
    """The critique already recorded a failure for the current round (the child wrote its own real reason, session and
    launch time): the review decides now with its null verdict, and a resume reruns it once ([L2](c))."""
    record = load_record(directory)
    return bool(record and record.get("status") == "failed" and record.get("round") == current_round(directory))


def _record_failed(directory: Path, reason: str) -> None:
    """Record a failed critique ONLY when the child did not record its own failure for this round. The child's record
    carries the real reason, session id and launch time (save_record); the controller's generic reason must never
    overwrite it (review finding 3). A missing or non-failed record (the child died before recording) gets this reason."""
    if settled(directory) or _failed_this_round(directory):
        return
    save_json(record_path(directory), failed_record(directory, reason))


def close_or_wait_critique(runtime, error: BaseException | None = None) -> None:
    """Every exit of the review step goes through this. The detached child ran setup, took the browser slot, started the
    app and the headless job, so on EVERY exit before the critique settled it is stopped: its and the app's process groups
    are killed and the slot released (PRD 4.4). Otherwise an interrupt, a native reviewer's deadline, a rejected file or a
    partial record (review.json written with the critique still running) would leave it spending budget and holding the
    machine-wide slot for its whole deadline (panel item 9, review findings 1 and 2).

    - On a Ctrl-C or a transient-infra exit (exit 75) the child is stopped but nothing is recorded, so the next controller
      resumes and reruns the job with a new app process group (PRD 6).
    - On any other error the critique is recorded failed (its real reason, if the child wrote one, is kept).
    No-op for a plan without `critique` or once the critique settled (a persisted decision or a finally-failed critique;
    the child is already gone). review.json existing is NOT the guard: a `_record_partial` writes it while the critique is
    still unsettled, and the child would otherwise keep running."""
    if not has_critique(runtime.plan):
        return
    from .sessions import TransientInfraError
    directory = runtime.directory
    if settled(directory):
        return
    stop_child(directory)  # free the app's process group and the browser slot on every exit path (PRD 4.4).
    if isinstance(error, (KeyboardInterrupt, TransientInfraError)):
        return  # The child is stopped; the next controller resumes it (reruns the job, PRD 6).
    if error is not None:
        _record_failed(directory, f"the review step ended without a verdict ({type(error).__name__}); the critique was stopped")


# ---- The decision joins review.json (PRD 4.5) -----------------------------------------------------------------------

def current_decision(directory: Path) -> dict | None:
    """The current round's persisted critique decision `{verdict, findings}`, or None when the critique failed or has none
    yet. A failed critique returns None (the caller records a `null` verdict entry that blocks)."""
    path = round_dir(directory, current_round(directory)) / STATUS
    if not path.exists():
        return None
    try:
        return read_json(path).get("accepted_decision")
    except (OSError, ValueError):
        return None


def review_entry(runtime) -> dict | None:
    """The critique's `review.json` reviewers entry and its findings, appended after the native reviewers (PRD 4.5):
    `{reviewer_id: "critique", transport, session_id, verdict, findings, accepted_at}`. verdict `null` for a failed
    critique (which `combined_review` counts as blocking). None for a plan without `critique`."""
    if not has_critique(runtime.plan):
        return None
    directory = runtime.directory
    decision = current_decision(directory)
    record = load_record(directory)
    session_id = (record or {}).get("session_id")
    launched_at = (record or {}).get("launched_at")
    if decision is None:
        return {"reviewer_id": CRITIQUE, "session_id": session_id, "verdict": None, "accepted_at": None,
                "findings": [], "launched_at": launched_at}
    from .automatic import derived_verdict
    return {"reviewer_id": CRITIQUE, "session_id": session_id, "verdict": derived_verdict(decision),
            "accepted_at": (record or {}).get("finished_at") or launched_at, "findings": decision["findings"],
            "launched_at": launched_at}


def blocks(runtime) -> bool:
    """The critique's decision blocks the run: a failed critique (verdict null) or an open P0/P1 (PRD 4.4, 4.5)."""
    if not has_critique(runtime.plan):
        return False
    decision = current_decision(runtime.directory)
    if decision is None:
        return True  # Failed: verdict null blocks.
    from .automatic import decision_blocks
    return decision_blocks(decision)


# ---- Export (1.11.0): evidence and the critique artifact list -------------------------------------------------------

def round_evidence(directory: Path, round_number: int) -> dict:
    """The `{key: {steps, screenshots}}` evidence map for a round (live or archived); {} when absent or malformed. Each
    screenshot is re-confined on read (panel item 4): one whose `path` does not resolve to a `.png` inside
    `critique/<round>/` is dropped, so a rewritten evidence.json cannot carry an artifact id for a host file."""
    path = round_dir(directory, round_number) / EVIDENCE
    if not path.exists():
        return {}
    try:
        raw = read_json(path).get("evidence")
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    result = {}
    for key, item in raw.items():
        if not isinstance(item, dict):
            continue
        shots = [shot for shot in (item.get("screenshots") or [])
                 if isinstance(shot, dict) and confined_png(directory, round_number, shot.get("path"), base=directory) is not None]
        result[key] = {"steps": item.get("steps", []), "screenshots": shots}
    return result


def finding_evidence(directory: Path, round_number: int, findings: list[dict]) -> dict:
    """Appendix A `evidence` for each critique finding of a round, keyed by the digest of `(severity, worker, message)`
    plus the occurrence index among critique findings with that digest (never by position in a filtered list, PRD 4.5).
    Returns `{id(finding): {steps, screenshots: [{artifact_id, caption}]}}` where id is the finding's index in `findings`.
    A finding with no evidence entry, or an entry with no steps, is OMITTED: Appendix A's `steps` is 1 to 20, and the
    viewer treats a missing key as no evidence (review finding 11) — an empty `{steps: [], screenshots: []}` block is not
    a valid shape and would hide a dropped-steps export regression from the contract."""
    evidence = round_evidence(directory, round_number)
    seen, result = {}, {}
    for index, finding in enumerate(findings):
        if finding.get("reviewer") != CRITIQUE:
            continue
        base = digest_text("\0".join([finding["severity"], finding.get("worker") or "", finding["message"]]))
        occurrence = seen.get(base, 0)
        seen[base] = occurrence + 1
        item = evidence.get(f"{base}:{occurrence}")
        if item is None:
            continue
        steps = [step for step in item.get("steps", []) if isinstance(step, str)]
        if not steps:
            continue
        result[index] = {"steps": steps,
                         "screenshots": [{"artifact_id": s["artifact_id"], "caption": s.get("caption", "")} for s in item.get("screenshots", [])]}
    return result


def artifacts(directory: Path) -> list[dict]:
    """The critique artifact list the export carries and the server serves (PRD 4.5): `{id, kind: "screenshot", path,
    sha256, bytes}` over every critique screenshot of the live and the archived rounds. ids are `critique-<round>-<sha12>`."""
    found, seen = [], set()
    base = critique_dir(directory)
    if not base.exists():
        return found
    for evidence_file in sorted(base.glob("*/" + EVIDENCE)):
        round_name = evidence_file.parent.name
        if not round_name.isdigit():
            continue
        round_number = int(round_name)
        for item in round_evidence(directory, round_number).values():  # already re-confined to .png inside critique/<round>/
            for shot in item.get("screenshots", []):
                aid = shot.get("artifact_id")
                if not aid or aid in seen:
                    continue
                resolved = confined_png(directory, round_number, shot.get("path"), base=directory)
                if resolved is None:
                    continue
                with resolved.open("rb") as handle:
                    sha = hashlib.file_digest(handle, "sha256").hexdigest()
                found.append({"id": aid, "kind": "screenshot", "path": str(resolved.relative_to(directory)),
                              "sha256": sha, "bytes": resolved.stat().st_size})
                seen.add(aid)
    return found
