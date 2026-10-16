"""The shared reviewer list of a judged review panel (features/review-panel-registry/prd.md sections 4 and 5, Appendix A; RUNBOOK
"Judged review panel (feature.json 2.11.0)").

- One file, synced to every machine through agent-memory: `~/.local/share/agent-memory/repo/learnings/skills/review-panel/
  reviewers.json` (DEFAULT_FILE, expanded from HOME), or the absolute path in env WORKFLOW_REVIEWERS_FILE. Validated against
  contracts/workflow/reviewers.schema.json plus the rules a schema cannot state (`check`); `load` raises
  `ValueError("<path>: <first error>")`.
- Read only at launch (dry run included) and only for a feature.json 2.11.0 feature with a judged panel: `resolve` turns the
  panel's seat names (or every enabled entry, in list order) into the resolved seat objects launch hands to prepare inside
  `--panel-settings`, and prepare pins them with the file's sha256 ([G2], [G3]). The run never reads the file again.
- A named seat absent from the list refuses the launch; a disabled seat, a missing binary or a failing probe pins the seat
  `unavailable` with the reason and never blocks ([G27]). The probes are injectable (`which`, `run`), so tests spawn nothing.
- Credentials by construction ([G14], [G18]): an entry holds `cli-login` or `{file, env}`; the controller only stats `file`
  (never opens it) and hands its expanded path to the seat in env `env`. `cli_env` builds a `cli` seat's environment from
  nothing, so no other controller variable (META_API_KEY, GEMINI_API_KEY, ...) reaches it.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

from .verification import CONTRACTS

VERSION = "1.0.0"
ENV = "WORKFLOW_REVIEWERS_FILE"
DEFAULT_FILE = "~/.local/share/agent-memory/repo/learnings/skills/review-panel/reviewers.json"
SCHEMA = CONTRACTS / "reviewers.schema.json"
TRANSPORTS = ("claude", "pi", "cli")
PLACEHOLDERS = ("{model}", "{prompt_file}", "{worktree}", "{timeout_minutes}")
PLACEHOLDER = re.compile(r"\{[^{}]*\}")
# The agent-memory sync holds back JSON with such a property name (agent_memory/scan.py), so the list may hold none.
SECRET_NAME = re.compile(r"key|token|secret|password", re.I)
BASE_ENV = ("PATH", "HOME", "LANG", "TMPDIR")  # Every cli seat's environment; `env.set`/`env.pass` may not replace them.
CLI_PATH_TAIL = "/usr/bin:/bin"
LOCAL_BIN = "~/.local/bin"
CAP_DEFAULTS = {"timeout_minutes": 15}
CLAUDE_BUDGET_DEFAULT = 5
PROBE_SECONDS = 20
VERSION_CHARS = 200
DISABLED = "disabled in the reviewer list"
SEAT_KEYS = ("status", "error", "bin", "cli_version")


def path_of(env=None) -> Path:
    """WORKFLOW_REVIEWERS_FILE when set (it must be absolute), else DEFAULT_FILE under the environment's HOME."""
    env = os.environ if env is None else env
    override = env.get(ENV)
    if override:
        if not Path(override).is_absolute():
            raise ValueError(f"{ENV} must be an absolute path, got {override!r}")
        return Path(override)
    home = env.get("HOME") or str(Path.home())
    return Path(home) / DEFAULT_FILE[2:]


def label_of(path: Path, env=None) -> str:
    """How the plan names the list file: `~/...` under HOME, else the absolute path (never a credential)."""
    env = os.environ if env is None else env
    home = Path(env.get("HOME") or str(Path.home()))
    try:
        return "~/" + str(Path(path).relative_to(home))
    except ValueError:
        return str(path)


def _names(value, where: str = ""):
    """Every property name in the value, with where it sits."""
    if isinstance(value, dict):
        for key, item in value.items():
            yield key, f"{where}{key}"
            yield from _names(item, f"{where}{key}.")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from _names(item, f"{where}{index}.")


def check(listing) -> None:
    """The list's schema and the rules a schema cannot state (PRD 4.2); the first broken rule as ValueError."""
    from jsonschema import Draft202012Validator
    from jsonschema.exceptions import best_match
    for name, where in _names(listing):
        if SECRET_NAME.search(name):
            raise ValueError(f"property {where} looks like a secret name (key/token/secret/password): the agent-memory sync would hold the file back")
    error = best_match(Draft202012Validator(json.loads(SCHEMA.read_text())).iter_errors(listing))
    if error is not None:
        place = ".".join(str(part) for part in error.absolute_path)
        raise ValueError(f"{place or '(root)'}: {error.message}")
    names, prefixes = set(), set()
    for index, entry in enumerate(listing["reviewers"]):
        where = f"reviewers[{index}] ({entry['name']})"
        check_entry(entry, where)
        if entry["name"] in names:
            raise ValueError(f"{where}: duplicate name {entry['name']!r}")
        if entry["prefix"] in prefixes:
            raise ValueError(f"{where}: duplicate prefix {entry['prefix']!r}")
        names.add(entry["name"])
        prefixes.add(entry["prefix"])


def check_entry(entry: dict, where: str) -> None:
    """One entry's cross-field rules (the schema has checked its keys and types)."""
    from .panel import MODEL_PATTERN
    transport = entry["transport"]
    if (transport == "cli") != ("cli" in entry):
        raise ValueError(f"{where}: `cli` is required on a cli entry and forbidden on a {transport} entry")
    if entry["model"] is None and transport != "claude":
        raise ValueError(f"{where}: model may be null only on a claude entry")
    if transport == "pi" and not MODEL_PATTERN.fullmatch(entry["model"]):
        raise ValueError(f"{where}: a pi entry needs a model of the form provider/id, got {entry['model']!r}")
    if entry["effort"] is not None and transport != "claude":
        raise ValueError(f"{where}: effort applies to a claude entry only (must be null on {transport})")
    if "budget_usd" in entry["cap"] and transport != "claude":
        raise ValueError(f"{where}: cap.budget_usd applies to a claude entry only")
    if isinstance(entry["credential"], dict) and entry["credential"]["env"] in BASE_ENV:
        raise ValueError(f"{where}: credential env {entry['credential']['env']} clashes with the seat's other variables")
    if transport != "cli":
        return
    cli = entry["cli"]
    for argument in cli["argv"]:
        for found in PLACEHOLDER.findall(argument):
            if found not in PLACEHOLDERS:
                raise ValueError(f"{where}: cli.argv placeholder {found} is not one of {', '.join(PLACEHOLDERS)}")
    for argument in cli["version_argv"]:
        if PLACEHOLDER.search(argument):
            raise ValueError(f"{where}: cli.version_argv takes no placeholder ({argument!r})")
    for name in [*cli["env"]["pass"], *cli["env"]["set"]]:
        if SECRET_NAME.search(name):
            raise ValueError(f"{where}: cli.env name {name} looks like a secret name (key/token/secret/password)")
        if name in BASE_ENV:
            raise ValueError(f"{where}: cli.env may not set or pass {name} (the controller builds it)")
    credential = entry["credential"]
    if isinstance(credential, dict) and credential["env"] in [*BASE_ENV, *cli["env"]["pass"], *cli["env"]["set"]]:
        raise ValueError(f"{where}: credential env {credential['env']} clashes with the seat's other variables")
    for kind in ("auth", "quota"):
        for pattern in cli["failures"][kind]:
            try:
                re.compile(pattern)
            except re.error as error:
                raise ValueError(f"{where}: cli.failures.{kind} pattern {pattern!r} does not compile ({error})") from None


def read(path: Path | None = None, env=None) -> tuple[dict, str, Path]:
    """`(listing, sha256 of the bytes read, path)`: the one read a launch makes."""
    env = os.environ if env is None else env
    path = Path(path) if path is not None else path_of(env)
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        raise ValueError(f"{path}: the reviewer list does not exist (set {ENV} or write {DEFAULT_FILE})") from None
    except OSError as error:
        raise ValueError(f"{path}: the reviewer list cannot be read ({error.strerror or error})") from None
    try:
        listing = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        raise ValueError(f"{path}: the reviewer list is not valid JSON ({error})") from None
    try:
        check(listing)
    except ValueError as error:
        raise ValueError(f"{path}: {error}") from None
    return listing, hashlib.sha256(data).hexdigest(), path


def load(path: Path | None = None, env=os.environ) -> dict:
    """Appendix A: read and validate the list (WORKFLOW_REVIEWERS_FILE, else the default path); `ValueError(<path>: <first error>)`."""
    return read(path, env)[0]


# ---- Resolve at launch (PRD 4.3) ---------------------------------------------------------------------------------------

def search_path(environ=None) -> str:
    """Where a seat's binary is looked up: the controller's PATH, then ~/.local/bin."""
    environ = os.environ if environ is None else environ
    home = environ.get("HOME") or str(Path.home())
    local = str(Path(home) / LOCAL_BIN[2:])
    return os.pathsep.join(part for part in (environ.get("PATH", ""), local) if part)


def cli_env(seat: dict, environ=None) -> dict:
    """A cli seat's environment, built from nothing (PRD 5): PATH (the pinned binary's directory, then /usr/bin:/bin), HOME,
    LANG, TMPDIR, the `env.pass` names that are set in the controller's environment, the `env.set` literals, and the credential
    env (the credential file's expanded path). Nothing else reaches the child."""
    environ = os.environ if environ is None else environ
    bin_dir = str(Path(seat["bin"]).parent) if seat.get("bin") else None
    env = {"PATH": ":".join(part for part in (bin_dir, CLI_PATH_TAIL) if part), "HOME": environ.get("HOME") or str(Path.home()),
           "LANG": environ.get("LANG") or "C.UTF-8", "TMPDIR": environ.get("TMPDIR") or "/tmp"}
    cli = seat["cli"]
    for name in cli["env"]["pass"]:
        if environ.get(name) is not None:
            env[name] = environ[name]
    env.update(cli["env"]["set"])
    env.update(credential_env(seat))
    return env


def credential_env(seat: dict) -> dict:
    """A seat's credential variable, whatever its transport: `{env: the expanded file path}` for a `{file, env}` credential,
    nothing for `cli-login`. The file itself is never opened."""
    credential = seat["credential"]
    if isinstance(credential, dict):
        return {credential["env"]: str(Path(credential["file"]).expanduser())}
    return {}


def _unavailable(seat: dict, reason: str) -> dict:
    seat.update(status="unavailable", error=str(reason)[:4000])
    return seat


def _probe(run, argv: list[str], env=None) -> tuple[int | None, str]:
    """`(exit code, stdout)` of a read-only probe, bounded by PROBE_SECONDS; `(None, reason)` when it did not run."""
    try:
        completed = run(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, text=True,
                        timeout=PROBE_SECONDS, **({"env": env} if env is not None else {}))
    except subprocess.TimeoutExpired:
        return None, f"did not finish within {PROBE_SECONDS} s"
    except (OSError, subprocess.SubprocessError) as error:
        return None, str(error)
    return completed.returncode, completed.stdout or ""


def resolve_seat(entry: dict, *, which=shutil.which, run=subprocess.run, environ=None) -> dict:
    """One entry as a resolved seat: the entry (cap defaults filled) plus `status` (`pending` or `unavailable`), `error`,
    `bin` (the absolute binary, or null) and `cli_version` (a cli seat's first `version_argv` stdout line, or null)."""
    from .panel import resolve_pi
    environ = os.environ if environ is None else environ
    seat = json.loads(json.dumps(entry))
    seat["cap"] = {**CAP_DEFAULTS, **({"budget_usd": CLAUDE_BUDGET_DEFAULT} if seat["transport"] == "claude" else {}), **seat["cap"]}
    seat.update(status="pending", error=None, bin=None, cli_version=None)
    if not seat["enabled"]:
        return _unavailable(seat, DISABLED)
    credential = seat["credential"]
    if isinstance(credential, dict):
        try:
            os.stat(Path(credential["file"]).expanduser())  # Only stat: the controller never opens a credential file.
        except OSError:
            return _unavailable(seat, f"credential file {credential['file']} does not exist")
    transport = seat["transport"]
    if transport == "claude":
        found = which("claude", path=search_path(environ))
        if not found:
            return _unavailable(seat, "claude not found on PATH or in ~/.local/bin")
        code, text = _probe(run, [found, "--help"])
        if code is None:
            return _unavailable(seat, f"`claude --help` did not run: {text}")
        if "--max-budget-usd" not in text:
            return _unavailable(seat, "the installed Claude CLI lacks --max-budget-usd")
        seat["bin"] = str(found)
    elif transport == "pi":
        found = resolve_pi({**environ, "PATH": search_path(environ)}, which)
        if found is None:
            return _unavailable(seat, "pi not found on PATH, in ~/.local/bin or under ~/.nvm/versions/node/*/bin")
        code, text = _probe(run, [str(found), "--version"])
        if code != 0:
            return _unavailable(seat, f"`pi --version` failed: {text.strip()[:200] if code is None else f'exit {code}'}")
        seat["bin"] = str(found)
    else:
        name = seat["cli"]["argv"][0]
        found = which(name, path=search_path(environ))
        if not found:
            return _unavailable(seat, f"{name} not found on PATH or in ~/.local/bin")
        seat["bin"] = str(Path(found).resolve()) if not Path(found).is_absolute() else str(found)
        version = list(seat["cli"]["version_argv"])
        if version[0] == name:
            version[0] = seat["bin"]
        code, text = _probe(run, version, cli_env(seat, environ))
        if code != 0:
            seat["bin"] = None
            return _unavailable(seat, f"`{' '.join(seat['cli']['version_argv'])}` failed: {text.strip()[:200] if code is None else f'exit {code}'}")
        first = next((line.strip() for line in text.splitlines() if line.strip()), "")
        seat["cli_version"] = first[:VERSION_CHARS] or None
    return seat


def resolve(listing: dict, seats: list[str] | None, *, which=shutil.which, run=subprocess.run) -> list[dict]:
    """Appendix A / PRD 4.3: the named seats (absent: every enabled entry, in list order) as resolved seat objects. A name the
    list lacks refuses with ValueError; a disabled seat, a missing binary or a failing probe is pinned `unavailable`."""
    entries = {entry["name"]: entry for entry in listing["reviewers"]}
    if seats is None:
        names = [entry["name"] for entry in listing["reviewers"] if entry["enabled"]]
    else:
        if not isinstance(seats, list) or not all(isinstance(name, str) for name in seats) or len(set(seats)) != len(seats):
            raise ValueError(f"panel seats must be a list of distinct reviewer names, got {seats!r}")
        missing = [name for name in seats if name not in entries]
        if missing:
            raise ValueError(f"panel seat {missing[0]!r} is not in the reviewer list (names: {', '.join(entries)})")
        names = seats
    return [resolve_seat(entries[name], which=which, run=run) for name in names]


def check_seat(seat, where: str) -> dict:
    """A resolved seat as `--panel-settings` and the plan carry it: a valid entry plus status/error/bin/cli_version."""
    if not isinstance(seat, dict) or not set(SEAT_KEYS) <= set(seat):
        raise ValueError(f"{where}must be a resolved seat (a reviewer-list entry with {', '.join(SEAT_KEYS)})")
    entry = {key: value for key, value in seat.items() if key not in SEAT_KEYS}
    try:
        check({"version": VERSION, "reviewers": [entry]})
    except ValueError as error:
        raise ValueError(f"{where}{error}") from None
    if seat["status"] not in ("pending", "unavailable"):
        raise ValueError(f"{where}status must be pending or unavailable, got {seat['status']!r}")
    if seat["status"] == "pending" and not (isinstance(seat["bin"], str) and Path(seat["bin"]).is_absolute()):
        raise ValueError(f"{where}a pending seat needs its resolved absolute bin")
    for key in ("error", "bin", "cli_version"):
        if seat[key] is not None and not isinstance(seat[key], str):
            raise ValueError(f"{where}{key} must be a string or null")
    if "timeout_minutes" not in seat["cap"]:
        raise ValueError(f"{where}cap.timeout_minutes must be pinned")
    return seat
