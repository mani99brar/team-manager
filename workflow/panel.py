"""The multi-provider panel of feature.json 2.6.0 (docs/PRD_MULTI_PROVIDER_PANEL.md sections 3, 4 and Appendix A).

A report-only, configurable panel of providers beside the review of an automatic run, never a LangGraph node and never a gate:

- Opt-in. A feature.json 2.6.0 declares `panels`; prepare pins each one as `plan.panels[]` with its brief (text + sha256,
  a feature file or `builtin:<stage>`), its requirement documents (resolved like the attack pass's `requirement_docs`), the
  pi bin directory the launch proved, and the PRD's repository label. A plan without `panels` means no panel.
- Placement (this slice: the `review` stage only). `automatic._review_candidate` calls `ensure_started` right after the
  attack pass's, on both reviewer transports and on the two re-entry paths; `review_candidate`'s `finally` calls `collect`
  after `close_or_wait_attack`, whatever that raised. The providers run IN-PROCESS as bounded subprocesses (started like
  print reviewers, stdout/stderr to files, their own process groups) and the controller writes `<run>/panel.json` itself:
  no detached child, running marker, liveness, lock or panel events this slice (decisions [L6], [L7]).
- Each provider job reviews ONE read-only context file, assembled once per panel under `<run>/panel/<id>/context.txt`
  with every section headed by one canonical repository-relative label; the normalizer anchors each finding's `file` to
  that label set, the overlap clusters findings across providers and `accepted` follows the panel's threshold.
- Never raises into the review step: `ensure_started` and `collect` swallow every failure into the record (`failed` with
  its `error`); the only thing that propagates is a KeyboardInterrupt, which terminates the jobs and leaves the record
  non-terminal so `resume` reruns the non-terminal providers (each from its own start, into a new numbered output file).

A plan without `panels`, every feature before 2.6.0 and every run prepared before this change touch none of this.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .sessions import EFFORT_LEVELS, job_env, popen_claude, read_json, role_flags, save_json, terminate, worker_settings
from .verification import CONTRACTS, validate_schema

PANEL = "panel"
PANEL_VERSION = "2.6.0"  # The feature version that may declare `panels`.
PANEL_VERSIONS = frozenset({PANEL_VERSION, "2.7.0"})  # 2.7.0 (per-lane worker pins) keeps the panels.
RECORD_VERSION = "1.0.0"
SCHEMA = CONTRACTS / "panel.schema.json"
RECORD = "panel.json"
DIR = "panel"  # `<run>/panel/<id>/`: the context file, each provider's prompt/output/stderr files and the pi scratch dirs.
CONTEXT = "context.txt"
NO_FILE = "(no file)"  # The record's `file` placeholder for a finding a provider returned with no file: the viewer pins `file` min length 1, so an empty string would drop the whole panel section (P1).
STAGES = ("challenge", "review")
LIVE_STAGES = ("review",)  # This slice; `challenge` is refused at launch (PRD 4.2, [L3]).
TRANSPORTS = ("claude", "pi")
BUILTIN_BRIEFS = Path(__file__).resolve().parent / "prompts" / "panels"
BUILTIN_PREFIX = "builtin:"
DEFAULTS = {"budget_usd": 5, "timeout_minutes": 15, "overlap_threshold": 2}
BOUNDS = {"budget_usd": (0.5, 50), "timeout_minutes": (1, 180)}
MAX_PROVIDERS = 4
ID_PATTERN = re.compile(r"[a-z][a-z0-9-]{0,31}")
MODEL_PATTERN = re.compile(r"[a-z0-9][a-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._:-]*")  # pi's `provider/id`.
TERMINAL_PROVIDER = frozenset({"ok", "timed_out", "error", "parse_failed"})
TERMINAL_PANEL = frozenset({"succeeded", "failed", "timed_out"})
SEVERITIES = ("P0", "P1", "P2")
SEVERITY_MAP = {"critical": "P0", "high": "P1"}  # Anything else a provider freelances is P2 (PRD 4.4).
LINE_WINDOW = 5
TITLE_JACCARD = 0.6
POLL_SECONDS = 1.0
THINKING_EVENTS = frozenset({"thinking", "thinking_start", "thinking_end"})
# The DeepSeek key guard (PRD 4.2, [G12]): the variable the operator sets, and the 0600 file holding the rotated key's SHA-256.
DEEPSEEK_ENV = "WORKFLOW_PANEL_ALLOW_DEEPSEEK"
DEEPSEEK_FINGERPRINT = "~/.config/md-manager/panel-deepseek.fingerprint"
DEEPSEEK_REFUSAL = ("Blocked: the DeepSeek key (C42) must be rotated and its fingerprint recorded before a DeepSeek panel provider runs; "
                    "see PRD_MULTI_PROVIDER_PANEL 4.2")
# The one credential variable a pi job gets per provider prefix; `openai-codex` needs only HOME (~/.pi/agent/auth.json).
CREDENTIALS = {"deepseek": "DEEPSEEK_API_KEY"}
PI_PATH_TAIL = "/usr/local/bin:/usr/bin:/bin"
NVM_BINS = "~/.nvm/versions/node/*/bin"
# Claude provider: beside the C14 worker deny rules, the run directory's siblings of the review worktree (PRD 4.6; the probe of
# 2026-10-06 showed the cwd restriction already denies them on claude 2.1.291 — these are belt and braces).
RUN_SIBLINGS = ("*.json", "*.jsonl", "*.txt", "*.log", "*.diff", "*.sqlite", "panel/**", "attack/**", "challenge-inputs/**", "verification/**")


# ---- Configuration: feature.json 2.6.0 and plan.panels ---------------------------------------------------------------

def _number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def provider_name(entry: dict) -> str:
    """How the record names a provider: its `model`, or `claude` for a default claude (Appendix A's `providers_raised`)."""
    return entry.get("model") or entry["transport"]


def provider_slug(entry: dict) -> str:
    """The provider's file stem under `<run>/panel/<id>/`: its name with every non-alphanumeric run as one dash."""
    return re.sub(r"[^A-Za-z0-9]+", "-", provider_name(entry)).strip("-").lower()


def provider_settings(value, where: str) -> dict:
    if not isinstance(value, dict) or set(value) - {"transport", "model", "effort"}:
        raise ValueError(f"{where}must be an object {{transport, model?, effort?}}, got {value!r}")
    transport = value.get("transport")
    if transport not in TRANSPORTS:
        raise ValueError(f"{where}transport must be one of {', '.join(TRANSPORTS)}, got {transport!r}")
    model = value.get("model")
    effort = value.get("effort")
    if model is not None and (not isinstance(model, str) or not model.strip()):
        raise ValueError(f"{where}model must be a non-empty string when given")
    if transport == "pi":
        if not isinstance(model, str) or not MODEL_PATTERN.fullmatch(model):
            raise ValueError(f"{where}a pi provider needs a model of the form provider/id (for example openai-codex/gpt-6-sol), got {model!r}")
        if effort is not None:
            raise ValueError(f"{where}effort applies to a claude provider only (pi has no effort flag)")
    elif effort is not None and effort not in EFFORT_LEVELS:
        raise ValueError(f"{where}effort must be one of {', '.join(EFFORT_LEVELS)}, got {effort!r}")
    return {"transport": transport, "model": model, "effort": effort}


def settings(value, where: str = "panels[] ") -> dict:
    """One panel's settings with the defaults filled in; a missing, unknown or out-of-range value is refused, naming the key.
    `report_only` must be true (blocking is not in v1, [O4])."""
    from .attack import requirements_of
    if not isinstance(value, dict):
        raise ValueError(f"{where}must be an object")
    known = {"id", "stage", "providers", "prompt", "requirements", "report_only", *DEFAULTS}
    unknown = sorted(set(value) - known)
    if unknown:
        raise ValueError(f"{where}{unknown[0]} is not a panel setting ({', '.join(sorted(known))})")
    for key in ("id", "stage", "providers", "prompt"):
        if key not in value:
            raise ValueError(f"{where}{key} is required")
    panel_id = value["id"]
    if not isinstance(panel_id, str) or not ID_PATTERN.fullmatch(panel_id):
        raise ValueError(f"{where}id must be lower-case, at most 32 characters, starting with a letter, got {panel_id!r}")
    if value["stage"] not in STAGES:
        raise ValueError(f"{where}stage must be one of {', '.join(STAGES)}, got {value['stage']!r}")
    providers = value["providers"]
    if not isinstance(providers, list) or not 1 <= len(providers) <= MAX_PROVIDERS:
        raise ValueError(f"{where}providers must be a list of 1 to {MAX_PROVIDERS} entries")
    providers = [provider_settings(item, f"{where}providers[{index}].") for index, item in enumerate(providers)]
    names = [provider_name(item) for item in providers]
    if len(set(names)) != len(names):
        raise ValueError(f"{where}providers must be distinct by model (or by transport for a default claude), got {names}")
    prompt = value["prompt"]
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError(f"{where}prompt must name a brief file in the feature directory or builtin:<stage>")
    if value.get("report_only") is not True:
        raise ValueError(f"{where}report_only must be true (a blocking panel is not in v1; PRD_MULTI_PROVIDER_PANEL 4.2)")
    result = {"id": panel_id, "stage": value["stage"], "providers": providers, "prompt": prompt,
              "requirements": requirements_of(value, where), **DEFAULTS, "report_only": True}
    for key, (low, high) in BOUNDS.items():
        if key in value:
            item = value[key]
            integer = key == "timeout_minutes"
            if not (type(item) is int if integer else _number(item)) or not low <= item <= high:
                raise ValueError(f"{where}{key} must be {'an integer' if integer else 'a number'} from {low} to {high}, got {item!r}")
            result[key] = item
    if "overlap_threshold" in value:
        threshold = value["overlap_threshold"]
        if not (threshold == "all" or (type(threshold) is int and threshold >= 1)):
            raise ValueError(f"{where}overlap_threshold must be an integer of at least 1 or \"all\", got {threshold!r}")
        result["overlap_threshold"] = threshold
    return result


def declared(manifest: dict) -> list[dict] | None:
    """The feature's `panels` with the defaults filled in; None without the key. Refused, naming feature.json and the key:
    `panels` before 2.6.0, a value that is not a non-empty list, a duplicate id, and every per-panel refusal of `settings`."""
    value = manifest.get("panels")
    if value is None:
        return None
    if manifest.get("version") not in PANEL_VERSIONS:
        raise ValueError(f"feature.json panels needs version {PANEL_VERSION} or later (this file is {manifest.get('version')})")
    if not isinstance(value, list) or not value:
        raise ValueError("feature.json panels must be a non-empty list of panel objects")
    panels = [settings(item, f"feature.json panels[{index}].") for index, item in enumerate(value)]
    ids = [item["id"] for item in panels]
    if len(set(ids)) != len(ids):
        raise ValueError("feature.json panels declares a panel id twice")
    return panels


def has_panels(plan: dict) -> bool:
    """The run declares panels: `plan.panels`, pinned at prepare. Never an entry of `plan["nodes"]`."""
    return isinstance(plan.get("panels"), list) and bool(plan["panels"])


def builtin_briefs() -> list[str]:
    return sorted(path.stem for path in BUILTIN_BRIEFS.glob("*.md"))


def brief_path(folder: Path, prompt: str) -> Path:
    """`builtin:<stage>` names a brief bundled in workflow/prompts/panels/, anything else an existing non-empty feature file."""
    if prompt.startswith(BUILTIN_PREFIX):
        name = prompt[len(BUILTIN_PREFIX):]
        if name not in builtin_briefs():
            raise ValueError(f"feature.json panels[].prompt names an unknown bundled panel brief {prompt!r}; bundled: "
                             f"{', '.join(BUILTIN_PREFIX + item for item in builtin_briefs())}")
        return BUILTIN_BRIEFS / f"{name}.md"
    path = (folder / prompt).resolve()
    if not path.is_relative_to(folder.resolve()):
        raise ValueError(f"feature.json panels[].prompt {prompt!r} escapes the feature directory")
    if not path.is_file() or not path.read_text().strip():
        raise ValueError(f"feature.json panels[].prompt {prompt!r} is missing or empty in {folder}")
    return path


# ---- Launch guards (PRD 4.2) ----------------------------------------------------------------------------------------

PI_AUTH_STORE = "~/.pi/agent/auth.json"


def pi_store_key(provider: str, store: Path | None = None) -> str | None:
    """The provider's key from pi's own login store (`/login` in pi): the key pi itself uses when the variable is unset."""
    path = Path(PI_AUTH_STORE).expanduser() if store is None else Path(store)
    try:
        value = json.loads(path.read_text()).get(provider, {}).get("key")
    except (OSError, ValueError, AttributeError):
        return None
    return value if isinstance(value, str) and value else None


def deepseek_guard(environ=None, fingerprint: Path | None = None, pi_store: Path | None = None) -> None:
    """A `deepseek/*` provider runs only when WORKFLOW_PANEL_ALLOW_DEEPSEEK=1 and the live key's SHA-256 equals the 0600
    fingerprint file's content (the rotated key's digest). The live key is DEEPSEEK_API_KEY, else (real environment, or an
    explicit `pi_store`) the key pi holds in its own login store, so it need not be exported in every shell. Refused otherwise,
    with one message (PRD 4.2)."""
    real_environment = environ is None
    environ = os.environ if environ is None else environ
    path = Path(DEEPSEEK_FINGERPRINT).expanduser() if fingerprint is None else Path(fingerprint)
    if environ.get(DEEPSEEK_ENV) != "1":
        raise ValueError(DEEPSEEK_REFUSAL)
    key = environ.get(CREDENTIALS["deepseek"])
    if not key and (real_environment or pi_store is not None):
        key = pi_store_key("deepseek", pi_store)
    if not key:
        raise ValueError(DEEPSEEK_REFUSAL)
    try:
        mode = path.stat().st_mode & 0o777
        recorded = path.read_text().strip()
    except OSError:
        raise ValueError(DEEPSEEK_REFUSAL) from None
    if mode & 0o077 or not recorded or hashlib.sha256(key.encode()).hexdigest() != recorded.lower():
        raise ValueError(DEEPSEEK_REFUSAL)


def check_launch(panels: list[dict], environ=None, fingerprint: Path | None = None, pi_store: Path | None = None) -> None:
    """The launch refusals that need no binary: the stage this slice runs, and the DeepSeek key guard."""
    for item in panels:
        if item["stage"] not in LIVE_STAGES:
            raise ValueError(f"feature.json panels[].stage {item['stage']!r} is not run by this slice: a panel runs at the review stage only "
                             "(the challenge stage is the follow-up slice, PRD_MULTI_PROVIDER_PANEL 5)")
        for provider in item["providers"]:
            if provider["transport"] == "pi" and provider["model"].split("/", 1)[0] == "deepseek":
                deepseek_guard(environ, fingerprint, pi_store)


def resolve_pi(environ=None, which=shutil.which) -> Path | None:
    """The `pi` executable: the controller's PATH first, then the newest nvm node bin."""
    environ = os.environ if environ is None else environ
    found = which("pi", path=environ.get("PATH"))
    if found:
        return Path(found)
    candidates = sorted(Path(NVM_BINS).expanduser().parent.glob("*/bin/pi")) if Path(NVM_BINS).expanduser().parent.exists() else []
    return candidates[-1] if candidates else None


def prove_transports(panels: list[dict], run=subprocess.run, environ=None, which=shutil.which) -> dict:
    """The two read-only probes a launch runs (dry run included) for the transports the panels declare: `claude --help` must
    list `--max-budget-usd` when a claude provider is declared; `pi --version` must succeed when a pi provider is, and the pi
    bin directory is returned as `{"pi_bin": <dir>|None}` for prepare to pin. Injectable `run`/`which`, so tests spawn nothing."""
    environ = os.environ if environ is None else environ
    transports = {provider["transport"] for item in panels for provider in item["providers"]}
    result = {"pi_bin": None}
    if "claude" in transports:
        executable = which("claude", path=environ.get("PATH")) or "claude"
        try:
            help_text = run([executable, "--help"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=15).stdout or ""
        except (OSError, subprocess.SubprocessError) as error:
            raise ValueError(f"Blocked: a claude panel provider needs `claude --help` to run ({error})") from None
        if "--max-budget-usd" not in help_text:
            raise ValueError("Installed Claude CLI lacks --max-budget-usd, which a claude panel provider needs")
    if "pi" in transports:
        pi = resolve_pi(environ, which)
        if pi is None:
            raise ValueError("Blocked: a pi panel provider needs `pi` on the controller's PATH or under ~/.nvm/versions/node/*/bin")
        try:
            completed = run([str(pi), "--version"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=30)
        except (OSError, subprocess.SubprocessError) as error:
            raise ValueError(f"Blocked: `{pi} --version` did not run ({error})") from None
        if completed.returncode != 0:
            raise ValueError(f"Blocked: `{pi} --version` exited {completed.returncode}")
        result["pi_bin"] = str(pi.parent)
    return result


# ---- prepare: plan.panels -------------------------------------------------------------------------------------------

def digest_text(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def pin(plan: dict, panels: list[dict], briefs: dict[str, tuple[str, str]], requirement_docs: dict[str, str],
        pi_bin: str | None, prd_label: str | None) -> None:
    """prepare: each panel with its brief (`{source, text, sha256}`), its requirement-document copies, the pi bin directory the
    launch proved and the PRD's repository label, as `plan.panels`. Runs last, so `plan.feature_version` reads 2.6.0."""
    pinned = []
    for item in panels:
        item = settings(item, "--panel-settings ")
        source, text = briefs[item["id"]]
        if not text.strip():
            raise ValueError(f"Panel brief {source} is empty")
        missing = [rel for rel in item["requirements"] if rel not in requirement_docs]
        if missing:
            raise ValueError(f"Panel {item['id']} requirements not read: {', '.join(missing)}")
        pinned.append({**item, "prompt": {"source": source, "text": text, "sha256": digest_text(text)},
                       "requirement_docs": {rel: requirement_docs[rel] for rel in item["requirements"]},
                       "pi_bin": pi_bin, "prd_label": prd_label})
    plan["panels"] = pinned
    plan["feature_version"] = PANEL_VERSION


PLAN_KEYS = {"id", "stage", "providers", "prompt", "requirements", "report_only", *DEFAULTS, "requirement_docs", "pi_bin", "prd_label"}


def validate_plan(plan: dict) -> None:
    items = plan.get("panels")
    if items is None:
        return
    if not isinstance(items, list) or not items:
        raise ValueError("Malformed plan.panels: expected a non-empty list")
    for item in items:
        if not isinstance(item, dict) or set(item) != PLAN_KEYS or not isinstance(item["prompt"], dict) \
                or set(item["prompt"]) != {"source", "text", "sha256"}:
            raise ValueError("Malformed plan.panels: expected {" + ", ".join(sorted(PLAN_KEYS)) + "} with prompt {source, text, sha256}")
        settings({key: item[key] for key in item if key in ("id", "stage", "providers", "requirements", "report_only", *DEFAULTS)} | {"prompt": item["prompt"]["source"]}, "plan.panels[] ")
        if any(provider["transport"] == "pi" for provider in item["providers"]) and not item["pi_bin"]:
            raise ValueError(f"plan.panels {item['id']} declares a pi provider without a pinned pi_bin")


# ---- The record ----------------------------------------------------------------------------------------------------

def record_path(directory: Path) -> Path:
    return directory / RECORD


def load_record(directory: Path) -> dict | None:
    path = record_path(directory)
    return read_json(path) if path.exists() else None


def save_record(directory: Path, record: dict) -> None:
    """Validate against the schema and replace atomically; the controller holds `controller.lock` (its sole writer)."""
    validate_schema("panel", record)
    save_json(record_path(directory), record)


def pending_provider(entry: dict) -> dict:
    return {"transport": entry["transport"], "model": entry.get("model"), "effort": entry.get("effort") if entry["transport"] == "claude" else None,
            "status": "pending", "cost_usd": None, "context_bytes": None, "finding_ids": [], "error": None}


def pending_record(plan: dict) -> dict:
    """The export's `pending` record (Appendix A) built from `plan.panels`, before panel.json exists."""
    panels = [{"id": item["id"], "stage": item["stage"], "status": "pending", "overlap_threshold": item["overlap_threshold"],
               "context_bytes": None, "providers": [pending_provider(entry) for entry in item["providers"]], "findings": [],
               "started_at": None, "ended_at": None, "budget_usd": item["budget_usd"], "error": None} for item in plan["panels"]]
    return {"version": RECORD_VERSION, "panels": panels}


def export_section(directory: Path, plan: dict) -> dict | None:
    """The top-level `panels` of export 1.9.0 (Appendix A): null without `plan.panels`; the `pending` record while panel.json
    does not exist; the record verbatim when it validates; a `failed` record (each panel with the error) when it does not."""
    if not has_panels(plan):
        return None
    path = record_path(directory)
    if not path.exists():
        return pending_record(plan)
    from jsonschema.exceptions import ValidationError
    try:
        item = read_json(path)
    except (OSError, ValueError) as error:
        item, reason = None, str(error)
    else:
        reason = None
    if item is not None:
        try:
            validate_schema("panel", item)
            return item
        except ValidationError as error:
            reason = error.message
    failed = pending_record(plan)
    for entry in failed["panels"]:
        entry.update(status="failed", error=clip(f"panel.json is not valid: {reason}", 4000))
    return failed


def clip(text, limit: int) -> str | None:
    return None if text is None else str(text)[:limit]


def iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat().replace("+00:00", "Z")


# ---- Context assembly (PRD 4.3, [G4]) --------------------------------------------------------------------------------

def label_line(label: str) -> str:
    return f"=== {label} ===\n"


def context_labels(text: str) -> list[str]:
    """The canonical labels of a context file: one per `=== <label> ===` line, in order."""
    return re.findall(r"^=== (.+) ===$", text, re.M)


def git_text(worktree: Path, *args: str) -> str:
    completed = subprocess.run(["git", "-C", str(worktree), *args], capture_output=True, check=True)
    return completed.stdout.decode("utf-8", errors="replace")


def added_file(worktree: Path, base: str, path: str) -> bool:
    """True when the file does not exist at the base, so its diff against the base is its whole text."""
    return subprocess.run(["git", "-C", str(worktree), "cat-file", "-e", f"{base}:{path}"], capture_output=True).returncode != 0


def review_sections(worktree: Path, base: str, candidate: str) -> list[tuple[str, str]]:
    """One section per touched text file of the frozen candidate: its diff hunks against the base, then its full text at the
    candidate (`git show`), under the file's repository-relative path as the label. Binary files are skipped; a deleted file
    carries its diff only. Read from the review worktree's Git objects, never from its working files."""
    sections = []
    for line in git_text(worktree, "diff", "--numstat", "--no-ext-diff", "--no-textconv", "--no-renames", base, candidate).splitlines():
        parts = line.split("\t", 2)
        if len(parts) != 3 or parts[0] == "-" or parts[1] == "-":
            continue  # A binary file (numstat prints `-`), or a line that is no numstat row.
        path = parts[2]
        body = "--- diff ---\n" + git_text(worktree, "diff", "--no-ext-diff", "--no-textconv", "--no-renames", base, candidate, "--", path)
        try:
            full = git_text(worktree, "show", f"{candidate}:{path}")
        except subprocess.CalledProcessError:
            body += "\n--- deleted at the candidate ---\n"
        else:
            if added_file(worktree, base, path):
                body += "\n--- new file: the diff above is its whole text ---\n"  # Its full text would repeat the diff and double the context.
            else:
                body += "\n--- full file at the candidate ---\n" + full
        sections.append((path, body))
    return sections


def assemble_review_context(directory: Path, plan: dict, item: dict) -> tuple[Path, int]:
    """`<run>/panel/<id>/context.txt`: the candidate's touched files (diff + full text, from the frozen candidate), then the
    pinned PRD copy and the pinned requirement documents, each section headed by one canonical label. The same bytes go to
    every provider; an existing file is reused (the candidate is frozen), so a resumed rerun reads what the first run read."""
    panel_dir = directory / DIR / item["id"]
    panel_dir.mkdir(parents=True, exist_ok=True)
    path = panel_dir / CONTEXT
    if path.is_file() and path.stat().st_size > 0:
        return path, path.stat().st_size
    bundle = read_json(directory / "review-bundle.json")
    worktree = directory / "review-worktree"
    parts = []
    for label, body in review_sections(worktree, plan["base_commit"], bundle["candidate_commit"]):
        parts.append(label_line(label) + body.rstrip("\n") + "\n\n")
    prd = plan.get("prd")
    if isinstance(prd, dict) and prd.get("copy") and item.get("prd_label"):
        try:
            text = (directory / prd["copy"]).read_text(errors="replace")
        except OSError:
            text = None
        if text:
            parts.append(label_line(item["prd_label"]) + text.rstrip("\n") + "\n\n")
    for rel, text in (item.get("requirement_docs") or {}).items():
        parts.append(label_line(rel) + text.rstrip("\n") + "\n\n")
    data = "".join(parts).encode()
    temporary = path.with_name(f".{path.name}.{uuid.uuid4()}.tmp")
    temporary.write_bytes(data)
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
    return path, len(data)


# ---- The transport adapter: one command-builder and one output-parser per transport -----------------------------------

def output_schema() -> dict:
    """The claude provider's `--json-schema`: `$defs.output` self-contained (an object root, which Claude Code requires)."""
    from .attack import inline
    defs = json.loads(SCHEMA.read_text())["$defs"]
    return inline(defs["output"], defs)


def panel_settings(directory: Path) -> list[str]:
    """The claude provider's `--settings`: the C14 worker deny rules plus Read denies on the run directory's siblings of the review
    worktree (the reviewers' prompts/verdicts, the sidecar ledger, attack.json, the other panel's output; PRD 4.6)."""
    settings = worker_settings(directory)
    value = json.loads(settings[1])
    run = Path(directory).resolve()
    value["permissions"]["deny"] += [f"Read(/{run}/{pattern})" for pattern in RUN_SIBLINGS]
    return ["--settings", json.dumps(value)]


def claude_command(executable: str, session_id: str, entry: dict, item: dict, directory: Path, plan: dict) -> list[str]:
    """One read-only `claude --print` provider job: print_command's Read,Glob,Grep/dontAsk, no --add-dir (cwd is the review
    worktree only), the panel `--settings`, the entry's `--effort` replacing the judges' pin (exactly one), the entry's model
    (else the judges' pin), the panel's `--max-budget-usd`, and the object-root findings schema."""
    from .automatic import print_command
    pins = list(role_flags(plan, "judges"))
    if entry.get("effort"):
        if "--effort" in pins:
            pins[pins.index("--effort") + 1] = entry["effort"]
        else:
            pins += ["--effort", entry["effort"]]
    if entry.get("model"):
        if "--model" in pins:
            pins[pins.index("--model") + 1] = entry["model"]
        else:
            pins = ["--model", entry["model"], *pins]
    command = print_command(executable, session_id, output_schema(), [], pins)
    at = command.index("--safe-mode")
    return command[:at] + panel_settings(directory) + command[at:-2] + ["--max-budget-usd", str(item["budget_usd"])] + command[-2:]


def pi_command(pi_bin: str, entry: dict, brief: str, context_name: str = CONTEXT) -> list[str]:
    """`pi -p --mode json --no-session -nt -nc -ns -ne -np --model <provider/id> <brief> @<context>`: the brief as the first
    positional message, the context as `@<file>` relative to the scratch cwd (never argv content, never an absolute path)."""
    return [str(Path(pi_bin) / "pi"), "-p", "--mode", "json", "--no-session", "-nt", "-nc", "-ns", "-ne", "-np",
            "--model", entry["model"], brief, f"@{context_name}"]


def pi_env(pi_bin: str, model: str, environ=None) -> dict:
    """The pi job's `env -i` set ([G12]): PATH (the pinned pi bin first, which holds node too), HOME (pi's auth), LANG, TMPDIR
    and only the one credential variable of the model's provider (`openai-codex` needs none)."""
    environ = os.environ if environ is None else environ
    env = {"PATH": f"{pi_bin}:{PI_PATH_TAIL}", "HOME": environ.get("HOME") or str(Path.home()),
           "LANG": environ.get("LANG") or "C.UTF-8", "TMPDIR": environ.get("TMPDIR") or "/tmp"}
    variable = CREDENTIALS.get(model.split("/", 1)[0])
    if variable and environ.get(variable):
        env[variable] = environ[variable]
    return env


def strip_fence(text: str) -> str:
    """One surrounding code fence (```json ... ``` or ``` ... ```) removed, when present."""
    text = text.strip()
    match = re.fullmatch(r"```[A-Za-z0-9_-]*[ \t]*\n(.*?)\n?```", text, re.S)
    return match.group(1).strip() if match else text


def parse_reply(text: str) -> list:
    """The findings a provider replied: a bare JSON array, or the object `{"findings": [...]}`; a ValueError otherwise."""
    value = json.loads(strip_fence(text))
    if isinstance(value, dict) and isinstance(value.get("findings"), list):
        return value["findings"]
    if isinstance(value, list):
        return value
    raise ValueError("the reply is neither a JSON array of findings nor an object {findings: [...]}")


def parse_pi_stream(text: str) -> dict:
    """The pi `--mode json` event stream: every non-JSON line and every `thinking*` event is skipped; the reply is the text parts
    of the LAST assistant `message_end` (the stream has a user echo first), and `cost_usd` its `usage.cost.total`."""
    assistant = None
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not isinstance(event, dict) or event.get("type") in THINKING_EVENTS:
            continue
        message = event.get("message")
        if event.get("type") == "message_end" and isinstance(message, dict) and message.get("role") == "assistant":
            assistant = message
    if assistant is None:
        return {"text": None, "cost_usd": None, "error": "no assistant message_end event in the pi stream"}
    parts = [part.get("text", "") for part in assistant.get("content", []) if isinstance(part, dict) and part.get("type") == "text"]
    cost = ((assistant.get("usage") or {}).get("cost") or {}).get("total")
    return {"text": "".join(parts), "cost_usd": cost if _number(cost) else None, "error": None}


class ClaudeTransport:
    name = "claude"
    output_suffix = "stdout.json"

    @staticmethod
    def parse(stdout_path: Path, returncode: int | None, session_id: str) -> dict:
        """`{findings|None, cost_usd, error, raw}`: the print job's JSON result, its own session, success, structured output."""
        try:
            result = read_json(stdout_path)
        except (OSError, ValueError):
            result = None
        if not isinstance(result, dict):
            return {"findings": None, "cost_usd": None, "error": f"the claude print job wrote no JSON result (exit {returncode})", "raw": None}
        cost = result.get("total_cost_usd")
        cost = cost if _number(cost) else None
        if returncode != 0 or result.get("session_id") != session_id or result.get("is_error") is not False or result.get("subtype") != "success":
            reason = result.get("result") if isinstance(result.get("result"), str) else result.get("subtype")
            return {"findings": None, "cost_usd": cost, "error": f"the claude print job did not succeed (exit {returncode}): {reason}", "raw": None}
        output = result.get("structured_output")
        if isinstance(output, dict) and isinstance(output.get("findings"), list):
            return {"findings": output["findings"], "cost_usd": cost, "error": None, "raw": None}
        raw = result.get("result") if isinstance(result.get("result"), str) else json.dumps(output)
        try:
            return {"findings": parse_reply(raw), "cost_usd": cost, "error": None, "raw": None}
        except ValueError:
            return {"findings": None, "cost_usd": cost, "error": None, "raw": raw}


class PiTransport:
    name = "pi"
    output_suffix = "stdout.jsonl"

    @staticmethod
    def parse(stdout_path: Path, returncode: int | None, session_id: str) -> dict:
        try:
            text = stdout_path.read_text(errors="replace")
        except OSError as error:
            return {"findings": None, "cost_usd": None, "error": f"the pi job's output could not be read: {error}", "raw": None}
        stream = parse_pi_stream(text)
        if stream["text"] is None:
            return {"findings": None, "cost_usd": None, "error": f"{stream['error']} (exit {returncode})", "raw": None}
        try:
            return {"findings": parse_reply(stream["text"]), "cost_usd": stream["cost_usd"], "error": None, "raw": None}
        except ValueError:
            return {"findings": None, "cost_usd": stream["cost_usd"], "error": None, "raw": stream["text"]}


TRANSPORT = {"claude": ClaudeTransport, "pi": PiTransport}


# ---- Findings: normalization and overlap (PRD 4.4, Appendix A) ----------------------------------------------------------

def normalize_severity(value) -> str:
    text = str(value or "").strip()
    if text.upper() in SEVERITIES:
        return text.upper()
    return SEVERITY_MAP.get(text.lower(), "P2")


def normalize_file(value, labels: list[str], worktree: str | None) -> tuple[str, bool, int | None]:
    """`(label or the provider's text, unanchored, line from a trailing :<n>)`: strips the worktree's absolute prefix, `./`,
    `a/` and `b/`, then anchors against the canonical label set (never the candidate tree)."""
    text = str(value or "").strip()
    line = None
    if worktree and text.startswith(worktree.rstrip("/") + "/"):
        text = text[len(worktree.rstrip("/")) + 1:]
    for prefix in ("./", "a/", "b/"):
        if text.startswith(prefix) and text not in labels:
            text = text[len(prefix):]
    if text not in labels:
        match = re.fullmatch(r"(.+?):(\d+)(?::\d+)?", text)
        if match and match.group(1) in labels:
            text, line = match.group(1), int(match.group(2))
    return text, text not in labels, line


def normalize_findings(raw: list, labels: list[str], worktree: str | None) -> list[dict]:
    """A provider's raw findings as `{severity, file, line, title, detail, unanchored}`; entries that are not objects are dropped."""
    result = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        file, unanchored, parsed_line = normalize_file(item.get("file"), labels, worktree)
        line = item.get("line")
        if isinstance(line, str) and line.strip().isdigit():
            line = int(line.strip())
        if not (type(line) is int and line >= 0):
            line = parsed_line
        result.append({"severity": normalize_severity(item.get("severity")), "file": clip(file, 512) or NO_FILE, "line": line,
                       "title": clip(item.get("title") or "(untitled)", 2000), "detail": clip(item.get("detail") or "", 4000),
                       "unanchored": unanchored})
    return result


def title_tokens(title: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", title.lower()))


def jaccard(a: str, b: str) -> float:
    left, right = title_tokens(a), title_tokens(b)
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def matches(a: dict, b: dict) -> bool:
    """Appendix A's overlap rule: both anchored, the same label, and (`line` within ±5 when both have one) or title Jaccard ≥ 0.6."""
    if a["unanchored"] or b["unanchored"] or a["file"] != b["file"]:
        return False
    if a["line"] is not None and b["line"] is not None and abs(a["line"] - b["line"]) <= LINE_WINDOW:
        return True
    return jaccard(a["title"], b["title"]) >= TITLE_JACCARD


def overlap(per_provider: list[tuple[str, list[dict]]], threshold, configured: int) -> tuple[list[dict], dict[str, list[str]]]:
    """Deterministic clustering: union-find over cross-provider matches only (one provider's own findings never merge), visiting
    providers in declaration order then findings in order. A merged finding keeps the most severe severity and the first-raising
    provider's title/detail/line; `providers_raised` names each provider once; `accepted` per the threshold (`all` = every
    configured provider); an unanchored finding is folded, never accepted. Returns the findings and each provider's ids."""
    units = [(name, finding) for name, findings in per_provider for finding in findings]
    parent = list(range(len(units)))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    for a in range(len(units)):
        for b in range(a + 1, len(units)):
            if units[a][0] != units[b][0] and matches(units[a][1], units[b][1]):
                root_a, root_b = find(a), find(b)
                if root_a != root_b:
                    parent[max(root_a, root_b)] = min(root_a, root_b)
    clusters: dict[int, list[int]] = {}
    for index in range(len(units)):
        clusters.setdefault(find(index), []).append(index)
    order = {name: position for position, (name, _) in enumerate(per_provider)}
    findings, ids = [], {name: [] for name, _ in per_provider}
    for number, root in enumerate(sorted(clusters), 1):
        members = clusters[root]
        first = units[members[0]][1]
        raised = sorted({units[index][0] for index in members}, key=order.get)
        severity = min((units[index][1]["severity"] for index in members), key=SEVERITIES.index)
        if first["unanchored"]:
            accepted = False
        elif threshold == "all":
            accepted = len(raised) >= configured
        else:
            accepted = len(raised) >= int(threshold)
        finding_id = f"f{number}"
        findings.append({"id": finding_id, "severity": severity, "file": first["file"], "line": first["line"], "title": first["title"],
                         "detail": first["detail"], "providers_raised": raised, "accepted": accepted, "unanchored": first["unanchored"]})
        for name in raised:
            ids[name].append(finding_id)
    return findings, ids


# ---- The provider jobs -----------------------------------------------------------------------------------------------

class Job:
    """One running provider subprocess of one panel, in its own process group, with its launch time on the injected clock."""

    def __init__(self, panel_index: int, provider_index: int, entry: dict, process, launched: float, timeout: float,
                 stdout: Path, session_id: str, number: int):
        self.panel_index, self.provider_index, self.entry = panel_index, provider_index, entry
        self.process, self.launched, self.timeout = process, launched, timeout
        self.stdout, self.session_id, self.number = stdout, session_id, number
        self.result = None  # The parsed reply once reaped.

    @property
    def transport(self):
        return TRANSPORT[self.entry["transport"]]

    def running(self) -> bool:
        return self.process.poll() is None


def _executable(runtime) -> str:
    sessions = getattr(runtime, "sessions", None)
    return getattr(sessions, "executable", None) or os.environ.get("WORKFLOW_CLAUDE", "claude")


def next_number(panel_dir: Path, slug: str) -> int:
    """The next `<slug>-<n>` output number under the panel directory (a rerun writes its own numbered file)."""
    pattern = re.compile(rf"{re.escape(slug)}-(\d+)\.stdout\.jsonl?")
    found = [int(match.group(1)) for path in panel_dir.iterdir() if (match := pattern.fullmatch(path.name))] if panel_dir.exists() else []
    return max(found, default=0) + 1


def kill_orphan(panel_dir: Path, slug: str) -> None:
    """A provider process a crashed controller left behind (design-challenge note 1): the latest `<slug>-<n>.pid` file whose pid
    still runs with that file's cwd and command marker is terminated (its whole group) before the rerun starts."""
    pids = sorted(panel_dir.glob(f"{slug}-*.pid")) if panel_dir.exists() else []
    if not pids:
        return
    try:
        info = read_json(pids[-1])
        pid, cwd, marker = info.get("pid"), info.get("cwd"), info.get("marker")
        if not isinstance(pid, int) or pid <= 0:
            return
        command = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
        current = os.readlink(f"/proc/{pid}/cwd")
    except (OSError, ValueError):
        return
    if marker and marker in command and current == cwd:
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(pid, sig)
            except (ProcessLookupError, PermissionError):
                return
            for _ in range(30):
                if _gone(pid):
                    return
                time.sleep(0.1)


def _gone(pid: int) -> bool:
    """No such process, or a zombie its (dead) parent never reaped."""
    try:
        status = Path(f"/proc/{pid}/status").read_text()
    except OSError:
        return True
    match = re.search(r"^State:\s+(\S)", status, re.M)
    return bool(match) and match.group(1) == "Z"


def start_provider(runtime, panel_index: int, provider_index: int, item: dict, entry: dict, context: Path, clock) -> Job:
    directory = Path(runtime.directory)
    panel_dir = directory / DIR / item["id"]
    panel_dir.mkdir(parents=True, exist_ok=True)
    slug = provider_slug(entry)
    kill_orphan(panel_dir, slug)
    number = next_number(panel_dir, slug)
    transport = TRANSPORT[entry["transport"]]
    stdout_path = panel_dir / f"{slug}-{number}.{transport.output_suffix}"
    stderr_path = panel_dir / f"{slug}-{number}.stderr.log"
    brief = item["prompt"]["text"]  # The pinned text, never re-read from a checkout.
    session_id = str(uuid.uuid4())
    if entry["transport"] == "claude":
        cwd = directory / "review-worktree"
        prompt_path = panel_dir / f"{slug}-{number}.prompt.txt"
        prompt_path.write_text(brief.rstrip() + "\n\n=== MATERIAL ===\n\n" + context.read_text(errors="replace"))
        os.chmod(prompt_path, 0o600)
        command = claude_command(_executable(runtime), session_id, entry, item, directory, runtime.plan)
        with prompt_path.open() as stdin, stdout_path.open("w") as out, stderr_path.open("w") as err:
            process = popen_claude(command, cwd=cwd, env=job_env(), stdin=stdin, stdout=out, stderr=err, text=True, start_new_session=True)
        marker = f"--session-id {session_id}"
    else:
        cwd = Path(tempfile.mkdtemp(prefix="mpp-panel-"))  # A neutral temp root, never the run/state tree: pi 0.85.1 absolutizes `@context.txt` into the `<file name>` tag it sends, so the cwd it expands must not carry the user/feature/run/panel path (PRD 4.3, P1).
        shutil.copyfile(context, cwd / CONTEXT)  # The same bytes, named relative to the scratch cwd.
        command = pi_command(item["pi_bin"], entry, brief)
        with stdout_path.open("w") as out, stderr_path.open("w") as err:
            process = subprocess.Popen(command, cwd=str(cwd), env=pi_env(item["pi_bin"], entry["model"]), stdin=subprocess.DEVNULL,
                                       stdout=out, stderr=err, text=True, start_new_session=True)
        marker = f"--model {entry['model']}"
    save_json(panel_dir / f"{slug}-{number}.pid", {"pid": process.pid, "cwd": str(Path(cwd).resolve()), "marker": marker})
    return Job(panel_index, provider_index, entry, process, clock(), item["timeout_minutes"] * 60, stdout_path, session_id, number)


def findings_side_file(directory: Path, item: dict, entry: dict) -> Path:
    """`<run>/panel/<id>/<slug>.findings.json`: a provider's normalized findings, kept so a resumed rerun re-merges the overlap
    over the terminal providers it keeps."""
    return directory / DIR / item["id"] / f"{provider_slug(entry)}.findings.json"


# ---- The review step's hooks -----------------------------------------------------------------------------------------

def _warn(message: str) -> None:
    try:
        print(f"Warning: panel: {message}", file=sys.stderr, flush=True)
    except Exception:
        pass


def ensure_started(runtime, *, clock=time.time) -> None:
    """Start the provider jobs once per controller process for every panel that is not terminal: a fresh panel starts every
    provider; a non-terminal record (a Ctrl-C or crash mid-review) reruns only its non-terminal providers and keeps the
    terminal ones. Writes the `running` record (the original `started_at` is kept). Never raises: an assembly failure records
    the panel `failed`; a provider that cannot be launched is recorded `error`. The handles live on `runtime.panel_jobs`."""
    plan = runtime.plan
    if not has_panels(plan):
        return
    if getattr(runtime, "panel_jobs", None) is not None:
        return  # Already started by this controller process.
    directory = Path(runtime.directory)
    jobs: dict[str, list[Job]] = {}
    try:
        record = load_record(directory) or pending_record(plan)
        now = iso(clock())
        for panel_index, item in enumerate(plan["panels"]):
            entry = record["panels"][panel_index]
            if entry["status"] in TERMINAL_PANEL or item["stage"] not in LIVE_STAGES:
                continue
            owed = [index for index, provider in enumerate(entry["providers"]) if provider["status"] not in TERMINAL_PROVIDER]
            if not owed:
                # Every provider exited before an interrupt or crash stopped the collect: nothing to rerun, the record only needs
                # its overlap and terminal status (from the providers' side files), never a perpetual `running`.
                _finalize(directory, plan, panel_index, record, {}, now)
                continue
            try:
                context, size = assemble_review_context(directory, plan, item)
            except Exception as error:  # noqa: BLE001 - recorded, never raised into the review step.
                for index in owed:
                    entry["providers"][index].update(status="error", error=clip(f"context assembly failed: {type(error).__name__}: {error}", 4000))
                entry.update(status="failed", started_at=entry["started_at"] or now, ended_at=now,
                             error=clip(f"context assembly failed: {type(error).__name__}: {error}", 4000))
                continue
            entry.update(status="running", started_at=entry["started_at"] or now, context_bytes=size, ended_at=None, error=None)
            for index in owed:
                provider = entry["providers"][index]
                try:
                    job = start_provider(runtime, panel_index, index, item, item["providers"][index], context, clock)
                except Exception as error:  # noqa: BLE001
                    provider.update(status="error", context_bytes=size, error=clip(f"launch failed ({size} context bytes): {type(error).__name__}: {error}", 4000))
                    continue
                provider.update(status="running", context_bytes=size, error=None)
                jobs.setdefault(item["id"], []).append(job)
            if item["id"] not in jobs:  # Every owed provider failed to launch (nothing is running): finalize to a terminal record now, never a perpetual `running` (P1).
                _finalize(directory, plan, panel_index, record, {}, now)
        save_record(directory, record)
    except Exception as error:  # noqa: BLE001
        _warn(f"could not start the provider jobs: {type(error).__name__}: {error}")
    runtime.panel_jobs = jobs


def _terminate_all(jobs: dict) -> None:
    for items in jobs.values():
        for job in items:
            if job.running():
                try:
                    terminate(job.process)
                except Exception:  # noqa: BLE001
                    pass


def _reap(job: Job, provider: dict, labels: list[str], worktree: str, size: int, side: Path) -> list[dict]:
    """An exited provider: parse its output file (whatever the clock says), set its status, keep its normalized findings in its
    side file (so an interrupted collect's reaped providers survive to the resume's re-merge) and return them."""
    result = job.transport.parse(job.stdout, job.process.returncode, job.session_id)
    job.result = result
    provider["cost_usd"] = result["cost_usd"]
    if result["findings"] is not None:
        provider.update(status="ok", error=None)
        findings = normalize_findings(result["findings"], labels, worktree)
        save_json(side, {"provider": provider_name(job.entry), "findings": findings})
        return findings
    if result["raw"] is not None:
        provider.update(status="parse_failed", error=clip(f"parse_failed ({size} context bytes): {result['raw']}", 4000))
    else:
        provider.update(status="error", error=clip(f"{result['error']} ({size} context bytes)", 4000))
    return []


def _finalize(directory: Path, plan: dict, panel_index: int, record: dict, reaped: dict[int, list[dict]], now: str, error: str | None = None) -> None:
    """Overlap over every provider's findings (those reaped now, and the kept terminal ones from their side files), the derived
    panel status, `ended_at`, and the attention record when a finding is accepted."""
    item = plan["panels"][panel_index]
    entry = record["panels"][panel_index]
    per_provider = []
    for index, provider_entry in enumerate(item["providers"]):
        name = provider_name(provider_entry)
        if index in reaped:
            findings = reaped[index]
        else:  # A terminal provider this collect did not run (a resume keeps it): its side file.
            side = findings_side_file(directory, item, provider_entry)
            try:
                findings = read_json(side).get("findings", []) if side.exists() else []
            except (OSError, ValueError, AttributeError):
                findings = []
        per_provider.append((name, findings if entry["providers"][index]["status"] == "ok" else []))
    findings, ids = overlap(per_provider, item["overlap_threshold"], len(item["providers"]))
    entry["findings"] = findings
    for index, provider_entry in enumerate(item["providers"]):
        entry["providers"][index]["finding_ids"] = ids.get(provider_name(provider_entry), [])
    statuses = [provider["status"] for provider in entry["providers"]]
    if error is not None:
        entry.update(status="failed", error=clip(error, 4000))
    elif any(status == "ok" for status in statuses):
        entry.update(status="succeeded", error=None)
    elif statuses and all(status == "timed_out" for status in statuses):
        entry.update(status="timed_out", error="every provider timed out")
    else:
        entry.update(status="failed", error=clip("no provider returned findings: " + ", ".join(
            f"{provider_name(p)} {s}" for p, s in zip(item["providers"], statuses)), 4000))
    entry["ended_at"] = now
    accepted = sum(1 for finding in findings if finding["accepted"])
    if accepted and entry["status"] == "succeeded":  # Never for a panel recorded failed by a non-decided exit.
        responding = sum(1 for status in statuses if status == "ok")
        from .attention import attention
        attention(directory, PANEL, f"Panel {item['id']} (report-only): {accepted} accepted finding(s) of {len(findings)} across "
                                    f"{responding} responding provider(s): read {directory / RECORD}")


def collect(runtime, error: BaseException | None = None, *, clock=time.time, sleep=time.sleep) -> None:
    """Every exit of review_candidate goes through this, after `close_or_wait_attack` (its own try/finally). `collect_print`
    semantics: every exited provider is reaped from its output file first (findings kept whatever the clock), then a provider
    still running past its own `timeout_minutes` (from its launch) is terminated and `timed_out`; the panel status derives from
    the providers and the terminal record is written. The attack split on a non-decided exit (no review.json): a
    KeyboardInterrupt/TransientInfraError terminates the jobs and leaves the record non-terminal (resume reruns them);
    any other exit terminates them and records the panel `failed` with the error. A KeyboardInterrupt raised inside the wait
    terminates the jobs, leaves the record non-terminal and propagates. Never raises otherwise."""
    plan = runtime.plan
    if not has_panels(plan):
        return
    jobs = getattr(runtime, "panel_jobs", None)
    if jobs is None:
        return  # Nothing was started by this process (the reconciliation raise): the record is left for the next resume.
    runtime.panel_jobs = None
    from .sessions import TransientInfraError
    directory = Path(runtime.directory)
    interrupted = isinstance(error, (KeyboardInterrupt, TransientInfraError))
    decided = (directory / "review.json").exists()
    worktree = str(directory / "review-worktree")
    record = None
    try:
        record = load_record(directory) or pending_record(plan)
        labels = {}
        reaped: dict[int, dict[int, list[dict]]] = {}

        def reap_exited() -> None:
            for panel_id, items in jobs.items():
                for job in items:
                    if job.result is None and not job.running():
                        item = plan["panels"][job.panel_index]
                        if job.panel_index not in labels:
                            try:
                                labels[job.panel_index] = context_labels((directory / DIR / item["id"] / CONTEXT).read_text(errors="replace"))
                            except OSError:
                                labels[job.panel_index] = []
                        entry = record["panels"][job.panel_index]
                        provider = entry["providers"][job.provider_index]
                        reaped.setdefault(job.panel_index, {})[job.provider_index] = _reap(
                            job, provider, labels[job.panel_index], worktree, entry["context_bytes"] or 0,
                            findings_side_file(directory, item, item["providers"][job.provider_index]))

        if interrupted:
            reap_exited()  # Their findings are kept (reap-first); the still-running ones are stopped and stay `running` for the next resume.
            _terminate_all(jobs)
            save_record(directory, record)
            return
        if not decided:
            reason = f"review exited with no review.json ({type(error).__name__ if error else 'no error'})"
            now = iso(clock())
            reap_exited()  # Exited before the exit: their findings stand.
            for panel_id, items in jobs.items():
                for job in items:
                    if job.result is None:  # Still running: terminated, recorded `error` (never a perpetual `running`).
                        job.result = {"terminated": True}
                        record["panels"][job.panel_index]["providers"][job.provider_index].update(status="error", error=clip(f"terminated: {reason}", 4000))
            _terminate_all(jobs)
            for panel_index in {job.panel_index for items in jobs.values() for job in items}:
                _finalize(directory, plan, panel_index, record, reaped.get(panel_index, {}), now, error=reason)
            save_record(directory, record)
            return
        try:
            while True:
                reap_exited()
                running = [job for items in jobs.values() for job in items if job.result is None]
                for job in running:
                    if clock() >= job.launched + job.timeout:
                        terminate(job.process)
                        job.result = {"timed_out": True}
                        provider = record["panels"][job.panel_index]["providers"][job.provider_index]
                        cost = job.transport.parse(job.stdout, job.process.returncode, job.session_id)["cost_usd"]
                        provider.update(status="timed_out", cost_usd=cost,
                                        error=clip(f"timed_out after {job.timeout:.0f} s ({record['panels'][job.panel_index]['context_bytes'] or 0} context bytes)", 4000))
                if not any(job.result is None for items in jobs.values() for job in items):
                    break
                sleep(POLL_SECONDS)
        except KeyboardInterrupt:
            # A Ctrl-C during the wait (design-challenge note 5): stop the jobs, record nothing terminal, let it propagate.
            _terminate_all(jobs)
            try:
                save_record(directory, record)
            except Exception:  # noqa: BLE001
                pass
            raise
        now = iso(clock())
        for panel_index in {job.panel_index for items in jobs.values() for job in items}:
            _finalize(directory, plan, panel_index, record, reaped.get(panel_index, {}), now)
        save_record(directory, record)
    except KeyboardInterrupt:
        raise
    except Exception as failure:  # noqa: BLE001 - an internal exception: the panel is recorded failed, the review step goes on.
        _terminate_all(jobs)
        try:
            record = record or load_record(directory) or pending_record(plan)
            now = iso(time.time())
            for entry in record["panels"]:
                if entry["status"] not in TERMINAL_PANEL:
                    entry.update(status="failed", ended_at=now, error=clip(f"{type(failure).__name__}: {failure}", 4000))
                    for provider in entry["providers"]:
                        if provider["status"] not in TERMINAL_PROVIDER:
                            provider.update(status="error", error=clip(f"{type(failure).__name__}: {failure}", 4000))
            save_record(directory, record)
        except Exception as second:  # noqa: BLE001
            _warn(f"could not record the panel failure: {type(second).__name__}: {second} (after {type(failure).__name__}: {failure})")


# ---- Status and outcome ---------------------------------------------------------------------------------------------

def status_lines(directory: Path, plan: dict) -> list[str]:
    """`panel <id>: <a> accepted of <n>` per panel, or its status while it has no findings yet."""
    if not has_panels(plan):
        return []
    record = load_record(directory)
    lines = []
    for index, item in enumerate(plan["panels"]):
        entry = record["panels"][index] if record and index < len(record.get("panels", [])) else None
        if entry is None or entry["status"] in ("pending", "running"):
            lines.append(f"panel {item['id']}: {entry['status'] if entry else 'pending'}")
            continue
        accepted = sum(1 for finding in entry["findings"] if finding["accepted"])
        lines.append(f"panel {item['id']}: {accepted} accepted of {len(entry['findings'])}")
    return lines


def outcome_lines(directory: Path, plan: dict) -> list[str]:
    """One report-only line per panel after the review lines (Appendix A); none for a plan without `panels`. Never the verdict."""
    if not has_panels(plan):
        return []
    record = load_record(directory)
    lines = []
    for index, item in enumerate(plan["panels"]):
        entry = record["panels"][index] if record and index < len(record.get("panels", [])) else None
        if entry is None or entry["status"] == "pending":
            lines.append(f"Panel {item['id']} (report-only): runs at the review step.")
        elif entry["status"] == "running":
            lines.append(f"Panel {item['id']} (report-only): running.")
        elif entry["status"] in ("failed", "timed_out"):
            lines.append(f"Panel {item['id']} (report-only): {entry['status']} ({entry.get('error') or 'see panel.json'}).")
        else:
            accepted = sum(1 for finding in entry["findings"] if finding["accepted"])
            providers = ", ".join(f"{provider_name(p)} {provider['status']}" for p, provider in zip(item["providers"], entry["providers"]))
            lines.append(f"Panel {item['id']} (report-only): {len(entry['findings'])} finding(s), {accepted} accepted at threshold "
                         f"{entry['overlap_threshold']}; providers: {providers}.")
    return lines
