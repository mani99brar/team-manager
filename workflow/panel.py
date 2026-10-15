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
- On a follow-up run (`plan.follows` whose candidate still resolves; RUNBOOK "Follow-up runs: brief, --follows and
  abandon") the touched files and their diffs come from the followed run's candidate to this one, restricted to the lanes'
  owned paths as the reviewers' `review.delta.diff` is (`automatic.delta_base`), and `panel.json` records that commit as
  each panel's `delta_from` (null otherwise).
- The context is capped at MAX_CONTEXT_BYTES (cap_sections: full bodies dropped first, then the PRD and requirement
  documents cut to half the cap, then diffs cut, then whole file sections dropped; still over is refused, never sent),
  recorded as `context_truncated`; once review.json exists a provider still running gets at
  most PANEL_GRACE_AFTER_VERDICT_SECONDS from the verdict (RUNBOOK "Multi-provider panel (feature.json 2.6.0)").
- Never raises into the review step: `ensure_started` and `collect` swallow every failure into the record (`failed` with
  its `error`); the only thing that propagates is a KeyboardInterrupt, which terminates the jobs and leaves the record
  non-terminal so `resume` reruns the non-terminal providers (each from its own start, into a new numbered output file).

A plan without `panels`, every feature before 2.6.0 and every run prepared before this change touch none of this.

feature.json 2.11.0 adds the JUDGED review panel (features/review-panel-registry/prd.md sections 4-7, Appendix A; RUNBOOK
"Judged review panel (feature.json 2.11.0)"): `report_only: false`, seats named from the shared reviewer list
(workflow/reviewers.py), resolved at launch and pinned at prepare with the list's sha256 ([G2], [G3]). At most one per feature,
at the review stage, and in step 1 alone ([L5]). Its seats run blind, beside the built-in reviewers, through the `claude` and
`pi` transports (today's commands and placement, [G19], [L1]) or the generic `cli` one (a throwaway worktree of the candidate
and a scratch dir outside the run directory, an environment built from nothing, PRD 5). Their context adds the pinned
decisions.md, their brief defaults to `review-judged.md` ([G13]; `review.md` stays the report-only brief), their findings are
numbered `<prefix><n>` with no overlap clustering, and they never write attention. `settle` waits for every seat and returns
them for the judge; `record_judge` stores the judge's object in `panel.json` 1.1.0 and sets each finding's `accepted` ([L4]).
Report-only panels keep record 1.0.0 and every behaviour above, byte for byte.
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
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .sessions import EFFORT_LEVELS, job_env, popen_claude, read_json, role_flags, save_json, terminate, worker_settings
from .verification import CONTRACTS, validate_schema

PANEL = "panel"
PANEL_VERSION = "2.6.0"  # The feature version that may declare `panels`.
PANEL_VERSIONS = frozenset({PANEL_VERSION, "2.7.0", "2.8.0", "2.9.0", "2.10.0", "2.11.0"})  # 2.7.0 (per-lane worker pins), 2.8.0 (per-lane skills), 2.9.0 (critique), 2.10.0 (per-lane reviewer) and 2.11.0 (judged panel) keep the panels.
JUDGED_VERSION = "2.11.0"  # The feature version that may declare a judged panel (`report_only: false`).
RECORD_VERSION = "1.0.0"
JUDGED_RECORD_VERSION = "1.1.0"  # panel.json of a run whose plan has a judged panel (PRD Appendix A).
SCHEMA = CONTRACTS / "panel.schema.json"
RECORD = "panel.json"
DIR = "panel"  # `<run>/panel/<id>/`: the context file, each provider's prompt/output/stderr files and the pi scratch dirs.
CONTEXT = "context.txt"
# The context cap (PRD 4.3): a 2.4 MB context was about 1.04M tokens, over one provider's 1M limit; 1.5 MB leaves headroom.
MAX_CONTEXT_BYTES = 1_500_000
FULL_FILE = "\n--- full file at the candidate ---\n"
OMITTED = "\n--- full file omitted: {size} bytes, over the context cap ---\n"
TRUNCATED = "=== truncated: kept {kept} of {total} bytes ==="
SECTION_OMITTED = "--- section omitted: {label}, {size} bytes, over the context cap ---"
TRUNCATED_LINE = re.compile(r"truncated: kept \d+ of \d+ bytes")  # Shaped like a label line; never one (context_labels).
NO_FILE = "(no file)"  # The record's `file` placeholder for a finding a provider returned with no file: the viewer pins `file` min length 1, so an empty string would drop the whole panel section (P1).
STAGES = ("challenge", "review")
LIVE_STAGES = ("review",)  # This slice; `challenge` is refused at launch (PRD 4.2, [L3]).
TRANSPORTS = ("claude", "pi")
BUILTIN_BRIEFS = Path(__file__).resolve().parent / "prompts" / "panels"
BUILTIN_PREFIX = "builtin:"
# A judged panel's default brief ([G13], design-challenge note 1): `builtin:review` (or no prompt) resolves here for a judged
# panel only; report-only panels keep review.md byte for byte. Not listed by builtin_briefs, so no report-only panel names it.
JUDGED_BRIEF = BUILTIN_BRIEFS / "review-judged.md"
JUDGED_DEFAULT_PROMPT = "builtin:review"
SEAT_TRANSPORTS = ("claude", "pi", "cli")
MAX_SEATS = 16
JUDGE_DEFAULTS = {"timeout_minutes": 30, "budget_usd": 15}
JUDGE_BOUNDS = {"timeout_minutes": (5, 60), "budget_usd": (1, 50)}
JUDGE_EFFORT = "high"
JUDGE_INPUT_CAP_BYTES = 600_000
JUDGED_KEYS = {"id", "stage", "report_only", "seats", "prompt", "requirements", "judge"}
JUDGED_REFUSED = ("providers", "overlap_threshold", "budget_usd", "timeout_minutes")
TERMINAL_SEAT = frozenset({"ok", "timed_out", "error", "parse_failed", "unavailable", "auth_required", "usage_limit", "model_mismatch"})
JUDGE_STATUSES = ("pending", "running", "judged", "failed", "timed_out", "incomplete")
KILL_GRACE_SECONDS = 10  # A cli seat past its timeout: SIGTERM to its group, SIGKILL this long after (PRD 5.1).
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
# After the review verdict (review.json) a still-running provider gets this long, the reviewers' REVIEW_GRACE_SECONDS, then it
# is terminated: a 30-minute provider once held the review step 23 minutes after the verdict.
PANEL_GRACE_AFTER_VERDICT_SECONDS = 600
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


def settings(value, where: str = "panels[] ", *, feature: bool = False) -> dict:
    """One panel's settings with the defaults filled in; a missing, unknown or out-of-range value is refused, naming the key.
    `report_only` must be true (blocking is not in v1, [O4]), except a judged panel (`report_only: false`, judged_settings):
    `feature` says the value is a feature.json entry (seat names), else a pinned one (--panel-settings, the plan)."""
    from .attack import requirements_of
    if not isinstance(value, dict):
        raise ValueError(f"{where}must be an object")
    if value.get("report_only") is False:
        return judged_settings(value, where, feature=feature)
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


def _bounded(value: dict, key: str, low, high, integer: bool, where: str):
    item = value[key]
    if not (type(item) is int if integer else _number(item)) or not low <= item <= high:
        raise ValueError(f"{where}{key} must be {'an integer' if integer else 'a number'} from {low} to {high}, got {item!r}")
    return item


def judged_settings(value: dict, where: str, *, feature: bool) -> dict:
    """A judged panel (feature.json 2.11.0, PRD 6), closed keys `{id, stage: review, report_only: false, seats?, prompt?,
    requirements?, judge?}`. From feature.json (`feature`) `seats` holds 1-16 distinct reviewer names and `judge` only
    `{timeout_minutes 5..60, budget_usd 1..50}`; a resolved seat object, `reviewers_file` or `judge.model` there is refused, so a
    feature file can never inline a command or a credential (design-challenge note 5). Pinned (--panel-settings, the plan) it
    holds the resolved seats (reviewers.check_seat), `reviewers_file {label, sha256}` and the full `judge`."""
    from .attack import requirements_of
    from . import reviewers
    for key in JUDGED_REFUSED:
        if key in value:
            raise ValueError(f"{where}{key} is not a judged-panel setting: a judged panel (report_only: false) takes its seats from the "
                             "reviewer list and its caps from each entry (PRD 6)")
    known = JUDGED_KEYS if feature else JUDGED_KEYS | {"reviewers_file"}
    unknown = sorted(set(value) - known)
    if unknown:
        raise ValueError(f"{where}{unknown[0]} is not a judged-panel setting ({', '.join(sorted(known))})")
    for key in ("id", "stage") if feature else ("id", "stage", "seats", "prompt", "reviewers_file", "judge"):
        if key not in value:
            raise ValueError(f"{where}{key} is required")
    panel_id = value["id"]
    if not isinstance(panel_id, str) or not ID_PATTERN.fullmatch(panel_id):
        raise ValueError(f"{where}id must be lower-case, at most 32 characters, starting with a letter, got {panel_id!r}")
    if value["stage"] == "challenge":
        raise ValueError(f"{where}stage challenge: a judged panel runs at the review stage only (the design-challenge panel is step 2)")
    if value["stage"] != "review":
        raise ValueError(f"{where}stage must be review for a judged panel, got {value['stage']!r}")
    prompt = value.get("prompt", JUDGED_DEFAULT_PROMPT)
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError(f"{where}prompt must name a brief file in the feature directory or builtin:review")
    seats = value.get("seats")
    if feature:
        if seats is not None and (not isinstance(seats, list) or not 1 <= len(seats) <= MAX_SEATS
                                  or not all(isinstance(name, str) and ID_PATTERN.fullmatch(name) for name in seats)
                                  or len(set(seats)) != len(seats)):
            raise ValueError(f"{where}seats must be 1 to {MAX_SEATS} distinct reviewer names from the reviewer list (never inline "
                             f"entries), got {seats!r}")
    else:
        if not isinstance(seats, list) or len(seats) > MAX_SEATS:
            raise ValueError(f"{where}seats must be a list of at most {MAX_SEATS} resolved seats")
        seats = [reviewers.check_seat(seat, f"{where}seats[{index}].") for index, seat in enumerate(seats)]
        for key in ("name", "prefix"):
            found = [seat[key] for seat in seats]
            if len(set(found)) != len(found):
                raise ValueError(f"{where}seats repeat a {key}: {found}")
        listed = value["reviewers_file"]
        if not isinstance(listed, dict) or set(listed) != {"label", "sha256"} or not isinstance(listed["label"], str) or not listed["label"] \
                or not isinstance(listed["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", listed["sha256"]):
            raise ValueError(f"{where}reviewers_file must be {{label, sha256}} of the reviewer list read at launch")
    judge = value.get("judge", {})
    if not isinstance(judge, dict):
        raise ValueError(f"{where}judge must be an object")
    allowed = set(JUDGE_DEFAULTS) if feature else {"model", "effort", *JUDGE_DEFAULTS, "input_cap_bytes"}
    unknown = sorted(set(judge) - allowed)
    if unknown:
        raise ValueError(f"{where}judge.{unknown[0]} is not a judge setting ({', '.join(sorted(allowed))})")
    pinned_judge = {**JUDGE_DEFAULTS}
    for key, (low, high) in JUDGE_BOUNDS.items():
        if key in judge:
            pinned_judge[key] = _bounded(judge, key, low, high, key == "timeout_minutes", f"{where}judge.")
    result = {"id": panel_id, "stage": "review", "report_only": False, "prompt": prompt, "requirements": requirements_of(value, where)}
    if feature:
        return {**result, "seats": seats, "judge": pinned_judge}
    model, effort = judge.get("model"), judge.get("effort")
    if not isinstance(model, str) or not model.strip():
        raise ValueError(f"{where}judge.model must be the run's judge model (launch --judge-model)")
    if effort != JUDGE_EFFORT or judge.get("input_cap_bytes") != JUDGE_INPUT_CAP_BYTES or set(judge) != allowed:
        raise ValueError(f"{where}judge must be {{model, effort: {JUDGE_EFFORT}, timeout_minutes, budget_usd, input_cap_bytes: {JUDGE_INPUT_CAP_BYTES}}}")
    return {**result, "reviewers_file": dict(value["reviewers_file"]), "seats": seats,
            "judge": {"model": model, "effort": JUDGE_EFFORT, **pinned_judge, "input_cap_bytes": JUDGE_INPUT_CAP_BYTES}}


def is_judged(item) -> bool:
    """A judged panel item (feature, --panel-settings or plan form): `report_only` is false."""
    return isinstance(item, dict) and item.get("report_only") is False


def judged_item(plan: dict) -> dict | None:
    """The plan's one judged panel item, else None (the seats lane's own check; judge.judged is the judge lane's)."""
    items = plan.get("panels") if isinstance(plan, dict) else None
    if not isinstance(items, list):
        return None
    return next((item for item in items if is_judged(item)), None)


def check_alone(items: list[dict], where: str) -> None:
    """At most one judged panel, and in step 1 no other panel beside it ([L5])."""
    judged = [item for item in items if is_judged(item)]
    if len(judged) > 1:
        raise ValueError(f"{where}declares a second judged panel: at most one judged panel per feature (PRD 6)")
    if judged and len(items) > 1:
        raise ValueError(f"{where}declares a judged panel beside another panel: in step 1 a judged panel runs alone ([L5]); "
                         "drop the report-only panel or the judged one")


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
    if manifest.get("version") != JUDGED_VERSION and any(is_judged(item) for item in value):
        raise ValueError(f"feature.json panels[].report_only must be true before {JUDGED_VERSION}: report_only false (a judged panel) "
                         f"needs version {JUDGED_VERSION} (this file is {manifest.get('version')})")
    panels = [settings(item, f"feature.json panels[{index}].", feature=True) for index, item in enumerate(value)]
    ids = [item["id"] for item in panels]
    if len(set(ids)) != len(ids):
        raise ValueError("feature.json panels declares a panel id twice")
    check_alone(panels, "feature.json panels ")
    return panels


def has_panels(plan: dict) -> bool:
    """The run declares panels: `plan.panels`, pinned at prepare. Never an entry of `plan["nodes"]`."""
    return isinstance(plan.get("panels"), list) and bool(plan["panels"])


def builtin_briefs() -> list[str]:
    return sorted(path.stem for path in BUILTIN_BRIEFS.glob("*.md") if path != JUDGED_BRIEF)


def brief_path(folder: Path, prompt: str, judged: bool = False) -> Path:
    """`builtin:<stage>` names a brief bundled in workflow/prompts/panels/, anything else an existing non-empty feature file.
    A judged panel's `builtin:review` (its default) is the judged brief, review-judged.md ([G13], design-challenge note 1)."""
    if judged and prompt == JUDGED_DEFAULT_PROMPT:
        return JUDGED_BRIEF
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
    """The launch refusals that need no binary: the stage this slice runs, and the DeepSeek key guard (a judged panel's
    resolved `pi` seats included; seat names are checked once launch has resolved them)."""
    check_alone(panels, "feature.json panels ")
    for item in panels:
        if is_judged(item):
            for seat in item.get("seats") or []:
                if isinstance(seat, dict) and seat["transport"] == "pi" and seat["status"] == "pending" \
                        and seat["model"].split("/", 1)[0] == "deepseek":
                    deepseek_guard(environ, fingerprint, pi_store)
            continue
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
        if is_judged(item):  # PRD Appendix B `plan-panel-judged`: the resolved seats, the list's label and sha256, the judge pins.
            pinned.append({"id": item["id"], "stage": item["stage"], "report_only": False,
                           "prompt": {"source": source, "text": text, "sha256": digest_text(text)}, "requirements": item["requirements"],
                           "requirement_docs": {rel: requirement_docs[rel] for rel in item["requirements"]}, "pi_bin": pi_bin,
                           "prd_label": prd_label, "reviewers_file": item["reviewers_file"], "seats": item["seats"], "judge": item["judge"]})
            continue
        pinned.append({**item, "prompt": {"source": source, "text": text, "sha256": digest_text(text)},
                       "requirement_docs": {rel: requirement_docs[rel] for rel in item["requirements"]},
                       "pi_bin": pi_bin, "prd_label": prd_label})
    check_alone(pinned, "--panel-settings ")
    plan["panels"] = pinned
    plan["feature_version"] = PANEL_VERSION


PLAN_KEYS = {"id", "stage", "providers", "prompt", "requirements", "report_only", *DEFAULTS, "requirement_docs", "pi_bin", "prd_label"}
JUDGED_PLAN_KEYS = {"id", "stage", "report_only", "prompt", "requirements", "requirement_docs", "pi_bin", "prd_label", "reviewers_file", "seats", "judge"}


def validate_plan(plan: dict) -> None:
    items = plan.get("panels")
    if items is None:
        return
    if not isinstance(items, list) or not items:
        raise ValueError("Malformed plan.panels: expected a non-empty list")
    check_alone([item for item in items if isinstance(item, dict)], "Malformed plan.panels: ")
    for item in items:
        if is_judged(item):
            if set(item) != JUDGED_PLAN_KEYS or not isinstance(item["prompt"], dict) or set(item["prompt"]) != {"source", "text", "sha256"}:
                raise ValueError("Malformed plan.panels: a judged panel expects {" + ", ".join(sorted(JUDGED_PLAN_KEYS)) + "} with prompt {source, text, sha256}")
            settings({key: item[key] for key in ("id", "stage", "report_only", "seats", "requirements", "reviewers_file", "judge")}
                     | {"prompt": item["prompt"]["source"]}, "plan.panels[] ")
            continue
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


def validate_record(record) -> None:
    """The panel schema, applied through the record's own version (1.0.0 or 1.1.0) so a refusal names the field that broke it
    rather than the root's `oneOf`; any other version is refused by the whole schema."""
    from jsonschema import Draft202012Validator, FormatChecker
    schema = json.loads(SCHEMA.read_text())
    version = record.get("version") if isinstance(record, dict) else None
    branch = {RECORD_VERSION: "record100", JUDGED_RECORD_VERSION: "record110"}.get(version)
    if branch is None:
        validate_schema("panel", record)
        return
    Draft202012Validator({"$ref": f"#/$defs/{branch}", "$defs": schema["$defs"]}, format_checker=FormatChecker()).validate(record)


def save_record(directory: Path, record: dict) -> None:
    """Validate against the schema and replace atomically; the controller holds `controller.lock` (its sole writer)."""
    validate_record(record)
    save_json(record_path(directory), record)


def pending_provider(entry: dict) -> dict:
    return {"transport": entry["transport"], "model": entry.get("model"), "effort": entry.get("effort") if entry["transport"] == "claude" else None,
            "status": "pending", "cost_usd": None, "context_bytes": None, "finding_ids": [], "error": None}


def seat_effort(plan: dict, seat: dict) -> str | None:
    """A claude seat's effective effort: its own, else the judges' pinned one (claude_command's rule); null for pi and cli."""
    if seat["transport"] != "claude":
        return None
    if seat.get("effort"):
        return seat["effort"]
    pins = role_flags(plan, "judges")
    return pins[pins.index("--effort") + 1] if "--effort" in pins else None


def pending_seat(plan: dict, seat: dict) -> dict:
    """A seat's record entry before it runs: `unavailable` with its reason when launch pinned it so, else `pending`."""
    unavailable = seat["status"] == "unavailable"
    return {"name": seat["name"], "prefix": seat["prefix"], "transport": seat["transport"], "model": seat["model"], "served_model": None,
            "cli_version": seat.get("cli_version"), "effort": seat_effort(plan, seat), "status": "unavailable" if unavailable else "pending",
            "cost_usd": None, "context_bytes": None, "finding_ids": [], "error": clip(seat.get("error"), 4000) if unavailable else None}


def pending_judge(item: dict) -> dict:
    """The `pending` judge object of PRD Appendix B (`judge-states`), with the plan's judge model (design-challenge note 2)."""
    return {"status": "pending", "fallback": False, "model": item["judge"]["model"], "effort": JUDGE_EFFORT, "session_id": None,
            "started_at": None, "ended_at": None, "cost_usd": None, "error": None, "inputs": [], "reviewer_findings": [], "rulings": []}


def judged_pending_record(plan: dict, item: dict) -> dict:
    """Record 1.1.0 of a judged plan before any seat ran: every seat pending (or unavailable), the judge `pending`."""
    entry = {"id": item["id"], "stage": item["stage"], "status": "pending", "judged": True, "overlap_threshold": None, "context_bytes": None,
             "providers": [pending_seat(plan, seat) for seat in item["seats"]], "findings": [], "started_at": None, "ended_at": None,
             "budget_usd": DEFAULTS["budget_usd"], "error": None, "delta_from": None, "context_truncated": None, "judge": pending_judge(item)}
    return {"version": JUDGED_RECORD_VERSION, "panels": [entry]}


def pending_record(plan: dict) -> dict:
    """The export's `pending` record (Appendix A) built from `plan.panels`, before panel.json exists (1.1.0 for a judged plan)."""
    item = judged_item(plan)
    if item is not None:
        return judged_pending_record(plan, item)
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
            validate_record(item)
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
    """The canonical labels of a context file: one per `=== <label> ===` line, in order; a truncation marker is none."""
    return [label for label in re.findall(r"^=== (.+) ===$", text, re.M) if not TRUNCATED_LINE.fullmatch(label)]


def git_text(worktree: Path, *args: str) -> str:
    completed = subprocess.run(["git", "-C", str(worktree), *args], capture_output=True, check=True)
    return completed.stdout.decode("utf-8", errors="replace")


def added_file(worktree: Path, base: str, path: str) -> bool:
    """True when the file does not exist at the base, so its diff against the base is its whole text."""
    return subprocess.run(["git", "-C", str(worktree), "cat-file", "-e", f"{base}:{path}"], capture_output=True).returncode != 0


class Section:
    """One labelled section of a context file: a touched file (`diff` is `--- diff ---` and its hunks, `tail` a new/deleted/
    omitted note, `body` its full text at the candidate or None) or a document (`diff` its text). Kept apart until the file
    is written so the cap (cap_sections) can drop bodies and cut texts."""

    def __init__(self, label: str, diff: str, tail: str = "", body: str | None = None, document: bool = False):
        self.label, self.diff, self.tail, self.body, self.document = label, diff, tail, body, document
        self.omitted = None  # The one line a whole section dropped by the cap leaves (no label line: it is no longer a label).

    def render(self) -> str:
        if self.omitted is not None:
            return self.omitted + "\n\n"
        text = self.diff + self.tail + (FULL_FILE + self.body if self.body is not None else "")
        return label_line(self.label) + text.rstrip("\n") + "\n\n"

    def size(self) -> int:
        return len(self.render().encode())


def review_sections(worktree: Path, base: str, candidate: str, paths: list[str] | None = None) -> list[Section]:
    """One section per touched text file of the frozen candidate: its diff hunks against the base, then its full text at the
    candidate (`git show`), under the file's repository-relative path as the label. Binary files are skipped; a deleted file
    carries its diff only. Read from the review worktree's Git objects, never from its working files. `paths` (a follow-up's
    owned paths, with the followed candidate as `base`) restricts the touched files to those paths."""
    sections = []
    limit = ["--", *paths] if paths else []
    for line in git_text(worktree, "diff", "--numstat", "--no-ext-diff", "--no-textconv", "--no-renames", base, candidate, *limit).splitlines():
        parts = line.split("\t", 2)
        if len(parts) != 3 or parts[0] == "-" or parts[1] == "-":
            continue  # A binary file (numstat prints `-`), or a line that is no numstat row.
        path = parts[2]
        diff = "--- diff ---\n" + git_text(worktree, "diff", "--no-ext-diff", "--no-textconv", "--no-renames", base, candidate, "--", path)
        try:
            full = git_text(worktree, "show", f"{candidate}:{path}")
        except subprocess.CalledProcessError:
            sections.append(Section(path, diff, "\n--- deleted at the candidate ---\n"))
        else:
            if added_file(worktree, base, path):
                sections.append(Section(path, diff, "\n--- new file: the diff above is its whole text ---\n"))  # Its full text would repeat the diff and double the context.
            else:
                sections.append(Section(path, diff, body=full))
    return sections


def truncate(section: Section, excess: int) -> None:
    """Cut the section's text (a file's diff, a document's text) by at least `excess` bytes plus the marker, at a line break,
    ending in `=== truncated: kept <k> of <n> bytes ===`; never below nothing kept."""
    data = section.diff.encode()
    keep = max(0, len(data) - excess - len(TRUNCATED.format(kept=len(data), total=len(data))) - 2)
    cut = data[:keep]
    if b"\n" in cut:
        cut = cut[:cut.rindex(b"\n") + 1]  # At a line break; one long line (a minified file) keeps its prefix instead.
    text = cut.decode("utf-8", errors="ignore")  # Never half a character.
    section.diff = text + ("" if not text or text.endswith("\n") else "\n") + TRUNCATED.format(kept=len(text.encode()), total=len(data)) + "\n"


def cap_sections(sections: list[Section], cap: int = None) -> dict | None:
    """Bring the context under `cap` bytes (MAX_CONTEXT_BYTES), stopping as soon as it fits, in this order:
    1. drop the files' full bodies, largest first, each replaced by one `--- full file omitted ---` line;
    2. cut the PRD and requirement documents, largest first, until together they take at most half the cap (so pinned
       documents over the cap never cost the diffs everything);
    3. cut the files' diffs, largest first;
    4. drop whole file sections, largest first, each replaced by one `--- section omitted: <label>, <n> bytes ---` line
       (when labels, notes and markers alone are over the cap).
    Raises ValueError when the context is still over the cap (the caller records the panel failed rather than send it).
    Returns `context_truncated` ({original_bytes, omitted_bodies, truncated, omitted_sections}) or None when nothing was cut."""
    cap = MAX_CONTEXT_BYTES if cap is None else cap
    sizes = [section.size() for section in sections]
    original = sum(sizes)
    if original <= cap:
        return None
    omitted, cut, dropped = [], [], []

    def total() -> int:
        return sum(sizes)

    def resize(index: int) -> None:
        sizes[index] = sections[index].size()

    def shorten(index: int, excess: int) -> None:
        """truncate, kept only when it makes the section smaller (a short text plus the marker can be longer than the text)."""
        section, before = sections[index], sections[index].diff
        truncate(section, excess)
        if section.size() >= sizes[index]:
            section.diff = before
            return
        resize(index)
        if section.label not in cut:
            cut.append(section.label)

    for index in sorted((i for i, s in enumerate(sections) if s.body is not None), key=lambda i: -len(sections[i].body.encode())):
        if total() <= cap:
            break
        section = sections[index]
        section.tail += OMITTED.format(size=len(section.body.encode()))
        section.body = None
        resize(index)
        omitted.append(section.label)
    documents = [i for i, s in enumerate(sections) if s.document]
    for index in sorted(documents, key=lambda i: -len(sections[i].diff.encode())):
        over = sum(sizes[i] for i in documents) - cap // 2
        if total() <= cap or over <= 0:
            break
        shorten(index, over)
    files = [i for i, s in enumerate(sections) if not s.document]
    for index in sorted(files, key=lambda i: -len(sections[i].diff.encode())):
        if total() <= cap:
            break
        shorten(index, total() - cap)
    for index in sorted(files, key=lambda i: -sizes[i]):
        if total() <= cap:
            break
        section = sections[index]
        section.omitted = SECTION_OMITTED.format(label=section.label, size=sizes[index])
        if section.size() >= sizes[index]:  # Its one line would be no shorter than what is left of it.
            section.omitted = None
            continue
        resize(index)
        dropped.append(section.label)
    if total() > cap:
        raise ValueError(f"context still {total()} bytes after the cap of {cap} (from {original}): not sent")
    return {"original_bytes": original, "omitted_bodies": omitted, "truncated": cut, "omitted_sections": dropped}


def delta_from(directory: Path, plan: dict) -> tuple[str, list[str]] | None:
    """A follow-up run's (followed candidate, owned paths), as the reviewers' delta (automatic.delta_base); None otherwise."""
    from types import SimpleNamespace
    from .automatic import delta_base
    return delta_base(SimpleNamespace(directory=Path(directory), plan=plan), Path(directory) / "review-worktree")


def decisions_label(plan: dict) -> str | None:
    """The pinned decisions.md's repository label (`features/<f>/decisions.md`): its path relative to the run's repository,
    else from its last `features/` segment; None without a pinned decisions.md."""
    decisions = plan.get("decisions")
    if not isinstance(decisions, dict) or not decisions.get("path"):
        return None
    path = Path(decisions["path"])
    try:
        return str(path.relative_to(Path(plan.get("repository") or "/nonexistent")))
    except ValueError:
        parts = path.parts
        if "features" in parts:
            index = len(parts) - 1 - parts[::-1].index("features")
            return "/".join(parts[index:])
        return path.name


def assemble_review_context(directory: Path, plan: dict, item: dict) -> tuple[Path, int, dict | None]:
    """`<run>/panel/<id>/context.txt`: the candidate's touched files (diff + full text, from the frozen candidate; on a
    follow-up only the files the delta touches, diffed from the followed candidate: delta_from), then the pinned PRD copy and
    the pinned requirement documents, each section headed by one canonical label, capped at MAX_CONTEXT_BYTES (cap_sections).
    Returns the path, its size and `{delta_from, context_truncated}`. The same bytes go to every provider; an existing file
    is reused (the candidate is frozen), so a resumed rerun reads what the first run read, and the third value is None: the
    record keeps what the first assembly recorded."""
    panel_dir = directory / DIR / item["id"]
    panel_dir.mkdir(parents=True, exist_ok=True)
    path = panel_dir / CONTEXT
    if path.is_file() and path.stat().st_size > 0:
        return path, path.stat().st_size, None
    bundle = read_json(directory / "review-bundle.json")
    worktree = directory / "review-worktree"
    delta = delta_from(directory, plan)
    base, paths = delta if delta else (plan["base_commit"], None)
    sections = review_sections(worktree, base, bundle["candidate_commit"], paths)
    prd = plan.get("prd")
    if isinstance(prd, dict) and prd.get("copy") and item.get("prd_label"):
        try:
            text = (directory / prd["copy"]).read_text(errors="replace")
        except OSError:
            text = None
        if text:
            sections.append(Section(item["prd_label"], text, document=True))
    for rel, text in (item.get("requirement_docs") or {}).items():
        sections.append(Section(rel, text, document=True))
    if is_judged(item):  # A judged panel's seats also read the pinned decisions.md ([G13], PRD 5.2), unless a pinned requirement
        # already is it; a candidate's own edit of the file (a touched-file section of that label) never stands in for the pinned text.
        decisions = plan.get("decisions")
        label = decisions_label(plan)
        if isinstance(decisions, dict) and decisions.get("text") and label and label not in [section.label for section in sections if section.document]:
            sections.append(Section(label, decisions["text"], document=True))
    truncated = cap_sections(sections)
    data = "".join(section.render() for section in sections).encode()
    if len(data) > MAX_CONTEXT_BYTES:  # cap_sections raises first; never send an oversized context whatever happens above.
        raise ValueError(f"context is {len(data)} bytes, over the cap of {MAX_CONTEXT_BYTES}: not sent")
    temporary = path.with_name(f".{path.name}.{uuid.uuid4()}.tmp")
    temporary.write_bytes(data)
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
    return path, len(data), {"delta_from": delta[0] if delta else None, "context_truncated": truncated}


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
        self.expired = False  # Set by a seat's watchdog before its first signal ([L13]); only this makes an exited seat timed_out.
        self.watchdog, self.watchdog_cancelled = None, None

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
    if judged_item(plan) is not None:
        return _ensure_seats(runtime, clock)
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
                context, size, assembled = assemble_review_context(directory, plan, item)
            except Exception as error:  # noqa: BLE001 - recorded, never raised into the review step.
                for index in owed:
                    entry["providers"][index].update(status="error", error=clip(f"context assembly failed: {type(error).__name__}: {error}", 4000))
                entry.update(status="failed", started_at=entry["started_at"] or now, ended_at=now,
                             error=clip(f"context assembly failed: {type(error).__name__}: {error}", 4000))
                continue
            entry.update(status="running", started_at=entry["started_at"] or now, context_bytes=size, ended_at=None, error=None,
                         **(assembled or {}))  # A reused context file keeps what its first assembly recorded.
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


def verdict_time(directory: Path) -> float:
    """When the review decided: the `decided_at` the controller saves beside the verdict in automatic-review.json (review.json
    itself has a closed key set, pipeline.check_review; one there is read first all the same), else review.json's
    modification time (a run decided before decided_at existed)."""
    path = Path(directory) / "review.json"
    for source in (path, Path(directory) / "automatic-review.json"):
        try:
            decided = read_json(source).get("decided_at")
            if isinstance(decided, str):
                return datetime.fromisoformat(decided.replace("Z", "+00:00")).timestamp()
        except (OSError, ValueError, AttributeError):
            continue
    return path.stat().st_mtime


def collect(runtime, error: BaseException | None = None, *, clock=time.time, sleep=time.sleep) -> None:
    """Every exit of review_candidate goes through this, after `close_or_wait_attack` (its own try/finally). `collect_print`
    semantics: every exited provider is reaped from its output file first (findings kept whatever the clock), then a provider
    still running past its own `timeout_minutes` (from its launch) or past PANEL_GRACE_AFTER_VERDICT_SECONDS from the later of
    the verdict (verdict_time) and its own launch, whichever ends first, is terminated and `timed_out`. The grace is applied
    here, once the attack pass's decided wait (close_or_wait_attack, its own overall bound) has ended; the panel status derives from
    the providers and the terminal record is written. The attack split on a non-decided exit (no review.json): a
    KeyboardInterrupt/TransientInfraError terminates the jobs and leaves the record non-terminal (resume reruns them);
    any other exit terminates them and records the panel `failed` with the error. A KeyboardInterrupt raised inside the wait
    terminates the jobs, leaves the record non-terminal and propagates. Never raises otherwise."""
    plan = runtime.plan
    if not has_panels(plan):
        return
    jobs = getattr(runtime, "panel_jobs", None)
    if jobs is None:
        return  # Nothing was started by this process (the reconciliation raise), or `settle` already ended them: a no-op.
    if judged_item(plan) is not None:
        return _collect_seats(runtime, error, clock, sleep)
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
        decided_at = verdict_time(directory)
        try:
            while True:
                reap_exited()
                running = [job for items in jobs.values() for job in items if job.result is None]
                for job in running:
                    own_end = job.launched + job.timeout
                    # From the verdict, or from the provider's own launch when it was (re)launched after it (a resume of a
                    # decided review): a relaunched provider gets a fresh grace, never the old verdict's.
                    grace_end = max(decided_at, job.launched) + PANEL_GRACE_AFTER_VERDICT_SECONDS
                    if clock() >= min(own_end, grace_end):
                        terminate(job.process)
                        job.result = {"timed_out": True}
                        provider = record["panels"][job.panel_index]["providers"][job.provider_index]
                        cost = job.transport.parse(job.stdout, job.process.returncode, job.session_id)["cost_usd"]
                        reason = (f"timed_out after {job.timeout:.0f} s ({record['panels'][job.panel_index]['context_bytes'] or 0} context bytes)"
                                  if own_end <= grace_end else f"timed_out after the review verdict: {PANEL_GRACE_AFTER_VERDICT_SECONDS} s grace")
                        provider.update(status="timed_out", cost_usd=cost, error=clip(reason, 4000))
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


# ---- The judged panel's seats (features/review-panel-registry/prd.md 5, 7.1, 7.2, 7.6, Appendix A) ---------------------

def seat_entry(seat: dict) -> dict:
    """A claude or pi seat as the provider entry today's builders take ([G19], [L1]: the same argv as a report-only provider)."""
    return {"transport": seat["transport"], "model": seat["model"], "effort": seat["effort"] if seat["transport"] == "claude" else None}


def seat_argv(seat: dict, prompt_file: Path, worktree: Path) -> list[str]:
    """A cli seat's argv: the entry's argv with its placeholders filled and argv[0] the pinned binary. The prompt itself is never
    in it (only `{prompt_file}`'s path, in a scratch dir outside the run directory), nor any credential (PRD 5, [L1])."""
    from .reviewers import PLACEHOLDER
    values = {"{model}": seat["model"] or "", "{prompt_file}": str(prompt_file), "{worktree}": str(worktree),
              "{timeout_minutes}": str(seat["cap"]["timeout_minutes"])}
    argv = [PLACEHOLDER.sub(lambda match: values[match.group(0)], argument) for argument in seat["cli"]["argv"]]
    argv[0] = seat["bin"]
    return argv


def seat_file_pattern(slug: str) -> re.Pattern:
    return re.compile(rf"{re.escape(slug)}-(\d+)\.(?:pid|stdout\.jsonl?|stdout\.txt|prompt\.txt)")


def next_seat_number(panel_dir: Path, slug: str) -> int:
    pattern = seat_file_pattern(slug)
    found = [int(match.group(1)) for path in panel_dir.iterdir() if (match := pattern.fullmatch(path.name))] if panel_dir.exists() else []
    return max(found, default=0) + 1


def remove_worktree(repository: str, worktree: Path) -> None:
    """`git worktree remove --force` then `prune` (lane_review's rule): a stale worktree never stays registered."""
    from .worktrees import git_worktree
    try:
        if worktree.exists():
            git_worktree(repository, "remove", "--force", str(worktree))
    except Exception:  # noqa: BLE001 - pruned below whatever remove said.
        pass
    shutil.rmtree(worktree, ignore_errors=True)
    try:
        git_worktree(repository, "prune")
    except Exception:  # noqa: BLE001
        pass


def kill_orphan_seat(panel_dir: Path, slug: str, repository: str) -> None:
    """A seat a crashed controller left behind: its latest pid file's process group is killed (when that pid still runs with
    the recorded cwd and marker), and the throwaway worktree and scratch dir it recorded are removed, before the rerun."""
    pattern = re.compile(rf"{re.escape(slug)}-(\d+)\.pid")
    pids = sorted((int(match.group(1)), path) for path in panel_dir.glob("*.pid") if (match := pattern.fullmatch(path.name))) if panel_dir.exists() else []
    if not pids:
        return
    try:
        info = read_json(pids[-1][1])
    except (OSError, ValueError):
        return
    pid, cwd, marker = info.get("pid"), info.get("cwd"), info.get("marker")
    if isinstance(pid, int) and pid > 0:
        try:
            command = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
            current = os.readlink(f"/proc/{pid}/cwd")
        except OSError:
            command, current = "", None
        if marker and marker in command and current == cwd:
            for sig in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.killpg(pid, sig)
                except (ProcessLookupError, PermissionError):
                    break
                for _ in range(30):
                    if _gone(pid):
                        break
                    time.sleep(0.1)
                else:
                    continue
                break
    if info.get("worktree"):
        remove_worktree(repository, Path(info["worktree"]))
    if info.get("scratch"):
        shutil.rmtree(info["scratch"], ignore_errors=True)


def start_seat(runtime, index: int, item: dict, seat: dict, context: Path, clock) -> Job:
    """One seat in its own process group, stdout/stderr to files (never a PIPE), a `.pid` file under `<run>/panel/<id>/`.
    claude: today's read-only print job in the review worktree; pi: today's tool-less job in a neutral scratch cwd; cli: its own
    tools in a throwaway worktree of the candidate (`review-seat-*`) with the prompt in a scratch dir (`review-seat-ctx-*`), both
    outside the run directory and removed on every path ([G7], [G19])."""
    directory = Path(runtime.directory)
    plan = runtime.plan
    panel_dir = directory / DIR / item["id"]
    panel_dir.mkdir(parents=True, exist_ok=True)
    from .reviewers import cli_env, credential_env
    slug = seat["name"]
    kill_orphan_seat(panel_dir, slug, plan["repository"])
    number = next_seat_number(panel_dir, slug)
    stem = panel_dir / f"{slug}-{number}"
    brief = item["prompt"]["text"]  # The pinned text, never re-read from a checkout.
    material = brief.rstrip() + "\n\n=== MATERIAL ===\n\n" + context.read_text(errors="replace")
    session_id = str(uuid.uuid4())
    worktree = scratch = None
    if seat["transport"] == "claude":
        cwd = directory / "review-worktree"
        stdout_path, stderr_path = stem.with_name(stem.name + ".stdout.json"), stem.with_name(stem.name + ".stderr.log")
        prompt_path = stem.with_name(stem.name + ".prompt.txt")
        prompt_path.write_text(material)
        os.chmod(prompt_path, 0o600)
        budget = {"budget_usd": seat["cap"].get("budget_usd", DEFAULTS["budget_usd"])}
        command = claude_command(_executable(runtime), session_id, seat_entry(seat), budget, directory, plan)
        with prompt_path.open() as stdin, stdout_path.open("w") as out, stderr_path.open("w") as err:
            process = popen_claude(command, cwd=cwd, env={**job_env(), **credential_env(seat)}, stdin=stdin, stdout=out, stderr=err,
                                   text=True, start_new_session=True)
        marker = f"--session-id {session_id}"
    elif seat["transport"] == "pi":
        pi_bin = str(Path(seat["bin"]).parent)
        cwd = Path(tempfile.mkdtemp(prefix="mpp-panel-"))  # As a report-only pi provider: a neutral temp root (pi absolutizes @context.txt).
        shutil.copyfile(context, cwd / CONTEXT)
        stdout_path, stderr_path = stem.with_name(stem.name + ".stdout.jsonl"), stem.with_name(stem.name + ".stderr.log")
        command = pi_command(pi_bin, seat_entry(seat), brief)
        with stdout_path.open("w") as out, stderr_path.open("w") as err:
            process = subprocess.Popen(command, cwd=str(cwd), env={**pi_env(pi_bin, seat["model"]), **credential_env(seat)},
                                       stdin=subprocess.DEVNULL,
                                       stdout=out, stderr=err, text=True, start_new_session=True)
        marker = f"--model {seat['model']}"
    else:
        from .worktrees import git_worktree
        repository = plan["repository"]
        candidate = read_json(directory / "review-bundle.json")["candidate_commit"]
        try:
            worktree = Path(tempfile.mkdtemp(prefix="review-seat-"))
            git_worktree(repository, "add", "--detach", str(worktree), candidate)
            scratch = Path(tempfile.mkdtemp(prefix="review-seat-ctx-"))
            prompt_file = scratch / "prompt.txt"
            prompt_file.write_text(material)
            os.chmod(prompt_file, 0o600)
            stdout_path, stderr_path = scratch / "stdout.txt", scratch / "stderr.txt"
            command = seat_argv(seat, prompt_file, worktree)
            stdin = prompt_file.open() if seat["cli"]["prompt_via"] == "stdin" else subprocess.DEVNULL
            try:
                with stdout_path.open("w") as out, stderr_path.open("w") as err:
                    process = subprocess.Popen(command, cwd=str(worktree), env=cli_env(seat), stdin=stdin, stdout=out, stderr=err,
                                               text=True, start_new_session=True)
            finally:
                if stdin is not subprocess.DEVNULL:
                    stdin.close()
        except BaseException:
            if worktree is not None:
                remove_worktree(repository, worktree)
            if scratch is not None:
                shutil.rmtree(scratch, ignore_errors=True)
            raise
        cwd = worktree
        marker = seat["bin"]
    save_json(stem.with_name(stem.name + ".pid"), {"pid": process.pid, "cwd": str(Path(cwd).resolve()), "marker": marker,
                                                  "worktree": str(worktree) if worktree else None, "scratch": str(scratch) if scratch else None})
    job = Job(0, index, seat, process, clock(), seat["cap"]["timeout_minutes"] * 60, stdout_path, session_id, number)
    job.stderr, job.stem, job.worktree, job.scratch, job.repository = stderr_path, stem, worktree, scratch, plan["repository"]
    arm_watchdog(job)
    return job


def watchdog_timer(seconds: float, callback) -> threading.Timer:
    """The timer behind a seat's watchdog ([L13]); tests patch this factory to shorten the cap."""
    return threading.Timer(seconds, callback)


def _expire_seat(job: Job) -> None:
    """A seat's watchdog at its cap, from its own start ([L12] B1, [L13]): nothing once the seat has exited or been reaped;
    otherwise `job.expired` first, then SIGTERM to its group and SIGKILL KILL_GRACE_SECONDS later unless the timer is cancelled
    in the grace. It touches only `os.killpg` and `job.expired`: the reap, the record and the cleanup stay on the main thread."""
    if job.process.poll() is not None or job.result is not None:
        return
    job.expired = True
    try:
        os.killpg(job.process.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return
    if job.watchdog_cancelled.wait(KILL_GRACE_SECONDS):  # A reap or a stop in the grace: no late SIGKILL (challenge note 1).
        return
    try:
        os.killpg(job.process.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def arm_watchdog(job: Job) -> None:
    job.watchdog_cancelled = threading.Event()
    job.watchdog = watchdog_timer(job.timeout, lambda: _expire_seat(job))
    job.watchdog.daemon = True
    job.watchdog.start()


def cancel_watchdog(job: Job) -> None:
    if job.watchdog is not None:
        job.watchdog_cancelled.set()
        job.watchdog.cancel()


def cleanup_seat(job: Job) -> None:
    """A cli seat's outputs copied to `<run>/panel/<id>/<name>-<n>.stdout.txt|.stderr.log`, then its throwaway worktree and
    scratch dir removed. Idempotent; nothing for a claude or pi seat."""
    if getattr(job, "scratch", None) is not None:
        scratch, job.scratch = job.scratch, None
        for source, suffix in ((job.stdout, ".stdout.txt"), (job.stderr, ".stderr.log")):
            try:
                shutil.copyfile(source, job.stem.with_name(job.stem.name + suffix))
            except OSError:
                pass
        job.stdout, job.stderr = job.stem.with_name(job.stem.name + ".stdout.txt"), job.stem.with_name(job.stem.name + ".stderr.log")
        shutil.rmtree(scratch, ignore_errors=True)
    if getattr(job, "worktree", None) is not None:
        worktree, job.worktree = job.worktree, None
        remove_worktree(job.repository, worktree)


def stop_seat(job: Job) -> None:
    """SIGTERM the seat's process group, SIGKILL it KILL_GRACE_SECONDS later (PRD 5.1), then SIGKILL what is left of the group
    even when the leader exited on the SIGTERM (PRD 7.6), then clean up. Its watchdog is cancelled."""
    cancel_watchdog(job)
    if job.running():
        try:
            os.killpg(job.process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            job.process.wait(timeout=KILL_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(job.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            job.process.wait()
    _kill_group(job)
    cleanup_seat(job)


def _kill_group(job: Job) -> None:
    """SIGKILL what an exited seat's leader left in its process group (a background process it spawned): nothing outlives it."""
    try:
        os.killpg(job.process.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def _stop_seats(jobs: list[Job]) -> None:
    for job in jobs:
        try:
            stop_seat(job)
        except Exception:  # noqa: BLE001
            pass


def extract(extractor: dict, stdout: str) -> tuple[bool, str | None]:
    """`(matched, value)` of an output extractor (PRD 5): `jsonl_event` takes the last stdout JSON object whose top-level keys
    equal `match`; `json_field` reads stdout as one JSON object that `match` must hold. `field` is a dotted path to a string."""
    candidate = None
    if extractor["format"] == "jsonl_event":
        for line in stdout.splitlines():
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if isinstance(event, dict) and all(event.get(key) == value for key, value in extractor["match"].items()):
                candidate = event
    else:
        try:
            event = json.loads(stdout)
        except ValueError:
            event = None
        if isinstance(event, dict) and all(event.get(key) == value for key, value in extractor["match"].items()):
            candidate = event
    if candidate is None:
        return False, None
    value = candidate
    for part in extractor["field"].split("."):
        value = value.get(part) if isinstance(value, dict) else None
    return True, value if isinstance(value, str) else None


def _failure_line(patterns: list[str], text: str) -> str | None:
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            start, end = text.rfind("\n", 0, match.start()) + 1, text.find("\n", match.end())
            return text[start:end if end >= 0 else len(text)].strip()[:300] or match.group(0)
    return None


def parse_cli(seat: dict, stdout: str, stderr: str, returncode: int | None) -> dict:
    """A finished cli seat (PRD 5.1, first match wins after the caller's timeout): an `auth` pattern → auth_required; a `quota`
    one → usage_limit; a served model other than the entry's → model_mismatch; no answer, a failed match or exit ≠ 0 → error
    (exit 0 alone never means success); an answer that is not the findings JSON (or holds an entry that is not an object)
    → parse_failed; else ok.
    `{status, findings, served_model, error}`."""
    cli = seat["cli"]
    matched, answer = extract(cli["output"], stdout)
    served = extract(cli["served_model"], stdout)[1] if cli["served_model"] else None
    text = stderr + "\n" + (answer or "")
    result = {"status": "ok", "findings": None, "served_model": served, "error": None}
    for kind, status in (("auth", "auth_required"), ("quota", "usage_limit")):
        line = _failure_line(cli["failures"][kind], text)
        if line is not None:
            return {**result, "status": status, "error": clip(line, 4000)}
    if served is not None and served != seat["model"]:
        return {**result, "status": "model_mismatch", "error": f"served model {served!r}, not the entry's {seat['model']!r}: findings discarded"}
    if returncode != 0 or not matched or answer is None:
        reason = f"exit {returncode}" if returncode != 0 else (
            f"no output matching {json.dumps(cli['output']['match'])}" if not matched else f"no {cli['output']['field']} in the matching output")
        return {**result, "status": "error", "error": clip(f"the {seat['name']} seat did not succeed: {reason}", 4000)}
    try:
        findings = parse_reply(answer)
    except ValueError:
        findings = None
    if findings is None or not all(isinstance(entry, dict) for entry in findings):
        return {**result, "status": "parse_failed", "error": clip(f"parse_failed: {answer}", 4000)}
    return {**result, "findings": findings}


def seat_side_file(directory: Path, item: dict, seat: dict) -> Path:
    """`<run>/panel/<id>/<name>.seat-findings.json`: a seat's normalized findings, kept for a resumed finalize."""
    return Path(directory) / DIR / item["id"] / f"{seat['name']}.seat-findings.json"


def _reap_seat(directory: Path, item: dict, job: Job, provider: dict, labels: list[str], size: int) -> list[dict]:
    """An exited seat: what it left in its process group killed, its status from its transport's parser, its normalized
    findings kept in its side file and returned. Its watchdog is cancelled."""
    seat = job.entry
    cancel_watchdog(job)
    _kill_group(job)
    if seat["transport"] == "cli":
        worktree = str(job.worktree) if job.worktree else None
        cleanup_seat(job)
        try:
            stdout = job.stdout.read_text(errors="replace")
        except OSError:
            stdout = ""
        try:
            stderr = job.stderr.read_text(errors="replace")
        except OSError:
            stderr = ""
        result = parse_cli(seat, stdout, stderr, job.process.returncode)
        job.result = result
        provider.update(served_model=result["served_model"], cost_usd=None)
        if result["status"] != "ok":
            provider.update(status=result["status"], error=result["error"])
            return []
        raw = result["findings"]
    else:
        worktree = str(Path(directory) / "review-worktree")
        result = TRANSPORT[seat["transport"]].parse(job.stdout, job.process.returncode, job.session_id)
        job.result = result
        provider["cost_usd"] = result["cost_usd"]
        if result["findings"] is None:
            if result["raw"] is not None:
                provider.update(status="parse_failed", error=clip(f"parse_failed ({size} context bytes): {result['raw']}", 4000))
            else:
                provider.update(status="error", error=clip(f"{result['error']} ({size} context bytes)", 4000))
            return []
        raw = result["findings"]
    provider.update(status="ok", error=None)
    findings = normalize_findings(raw, labels, worktree)
    save_json(seat_side_file(directory, item, seat), {"seat": seat["name"], "findings": findings})
    return findings


def _time_out(job: Job, provider: dict) -> None:
    stop_seat(job)
    job.result = {"timed_out": True}
    cost = None
    if job.entry["transport"] != "cli":
        cost = TRANSPORT[job.entry["transport"]].parse(job.stdout, job.process.returncode, job.session_id)["cost_usd"]
    minutes = job.timeout / 60
    provider.update(status="timed_out", cost_usd=cost, error=f"timed out after {minutes:g} minutes")


def _wait_seats(directory: Path, item: dict, record: dict, jobs: list[Job], clock, sleep) -> dict[int, list[dict]]:
    """Every seat to its end or its own timeout (from its own launch). Before the reap only `job.expired` (its watchdog fired) makes
    a seat timed_out: an exited seat without it keeps its result whatever the clock says, and the clock applies only to a seat
    still running ([L13]). A KeyboardInterrupt stops
    every seat (groups killed, worktrees removed), saves the record with the still-running seats non-terminal, and propagates."""
    entry = record["panels"][0]
    try:
        labels = context_labels((Path(directory) / DIR / item["id"] / CONTEXT).read_text(errors="replace"))
    except OSError:
        labels = []
    reaped: dict[int, list[dict]] = {}
    try:
        while True:
            for job in jobs:
                if job.result is None:
                    provider = entry["providers"][job.provider_index]
                    if job.expired:
                        _time_out(job, provider)
                    elif not job.running():
                        reaped[job.provider_index] = _reap_seat(directory, item, job, provider, labels, entry["context_bytes"] or 0)
                    elif clock() >= job.launched + job.timeout:
                        if job.expired or job.running():
                            _time_out(job, provider)
                        else:  # Exited since the check above: its exit is re-checked before the timeout ([L13]).
                            reaped[job.provider_index] = _reap_seat(directory, item, job, provider, labels, entry["context_bytes"] or 0)
            if all(job.result is not None for job in jobs):
                return reaped
            sleep(POLL_SECONDS)
    except KeyboardInterrupt:
        _stop_seats(jobs)
        try:
            save_record(directory, record)
        except Exception:  # noqa: BLE001
            pass
        raise


def _finalize_seats(directory: Path, plan: dict, record: dict, reaped: dict[int, list[dict]], now: str, error: str | None = None) -> None:
    """The judged panel's findings: each `ok` seat's findings (reaped now, else its side file) numbered `<prefix><n>` in emission
    order, no overlap clustering, `accepted` false until the judge rules (record_judge). The panel status derives from the seats;
    `ended_at` is now until the judge's end replaces it ([L4]). No attention record ([PRD 7.7])."""
    item = plan["panels"][0]
    entry = record["panels"][0]
    findings = []
    for index, seat in enumerate(item["seats"]):
        provider = entry["providers"][index]
        if index in reaped:
            own = reaped[index]
        else:
            side = seat_side_file(directory, item, seat)
            try:
                own = read_json(side).get("findings", []) if side.exists() else []
            except (OSError, ValueError, AttributeError):
                own = []
        if provider["status"] != "ok":
            own = []
        ids = []
        for number, finding in enumerate(own, 1):
            finding_id = f"{seat['prefix']}{number}"
            findings.append({"id": finding_id, "severity": finding["severity"], "file": finding["file"], "line": finding["line"],
                             "title": finding["title"], "detail": finding["detail"], "providers_raised": [seat["name"]], "accepted": False,
                             "unanchored": finding["unanchored"]})
            ids.append(finding_id)
        provider["finding_ids"] = ids
    entry["findings"] = findings
    statuses = [provider["status"] for provider in entry["providers"]]
    if error is not None:
        entry.update(status="failed", error=clip(error, 4000))
    elif any(status == "ok" for status in statuses):
        entry.update(status="succeeded", error=None)
    elif statuses and all(status == "timed_out" for status in statuses):
        entry.update(status="timed_out", error="every seat timed out")
    else:
        entry.update(status="failed", error=clip("no seat returned findings: " + ", ".join(
            f"{provider['name']} {provider['status']}" for provider in entry["providers"]), 4000))
    entry["ended_at"] = now


def _ensure_seats(runtime, clock) -> None:
    """ensure_started for a judged plan: start every non-terminal seat (a resume reruns only those, each from its own new start);
    `unavailable` seats never start. Raises nothing but a KeyboardInterrupt, after stopping the seats it already started (groups
    killed, worktrees removed) and saving the record with them non-terminal; the handles live on `runtime.panel_jobs`."""
    plan = runtime.plan
    item = judged_item(plan)
    directory = Path(runtime.directory)
    jobs: dict[str, list[Job]] = {}
    record = None
    try:
        record = load_record(directory) or pending_record(plan)
        entry = record["panels"][0]
        now = iso(clock())
        if entry["status"] not in TERMINAL_PANEL:
            owed = [index for index, provider in enumerate(entry["providers"]) if provider["status"] not in TERMINAL_SEAT]
            if not owed:
                _finalize_seats(directory, plan, record, {}, now)
            else:
                try:
                    context, size, assembled = assemble_review_context(directory, plan, item)
                except Exception as error:  # noqa: BLE001 - recorded, never raised into the review step.
                    reason = clip(f"context assembly failed: {type(error).__name__}: {error}", 4000)
                    for index in owed:
                        entry["providers"][index].update(status="error", error=reason)
                    _finalize_seats(directory, plan, record, {}, now, error=reason)
                    entry["started_at"] = entry["started_at"] or now
                else:
                    entry.update(status="running", started_at=entry["started_at"] or now, context_bytes=size, ended_at=None, error=None,
                                 **(assembled or {}))
                    for index in owed:
                        provider = entry["providers"][index]
                        try:
                            job = start_seat(runtime, index, item, item["seats"][index], context, clock)
                        except Exception as error:  # noqa: BLE001
                            provider.update(status="error", context_bytes=size, error=clip(f"launch failed: {type(error).__name__}: {error}", 4000))
                            continue
                        provider.update(status="running", context_bytes=size, error=None)
                        jobs.setdefault(item["id"], []).append(job)
                    if item["id"] not in jobs:
                        _finalize_seats(directory, plan, record, {}, now)
        save_record(directory, record)
    except KeyboardInterrupt:
        _stop_seats([job for items in jobs.values() for job in items])  # The started seats stay `running`: resume reruns them.
        if record is not None:
            try:
                save_record(directory, record)
            except Exception:  # noqa: BLE001
                pass
        runtime.panel_jobs = None
        raise
    except Exception as error:  # noqa: BLE001
        _warn(f"could not start the seats: {type(error).__name__}: {error}")
    runtime.panel_jobs = jobs


def _fail_seats(directory: Path, plan: dict, record: dict | None, jobs: list[Job], failure: BaseException) -> None:
    _stop_seats(jobs)
    try:
        record = record or load_record(directory) or pending_record(plan)
        entry = record["panels"][0]
        reason = clip(f"{type(failure).__name__}: {failure}", 4000)
        for provider in entry["providers"]:
            if provider["status"] not in TERMINAL_SEAT:
                provider.update(status="error", error=reason)
        if entry["status"] not in TERMINAL_PANEL:
            _finalize_seats(directory, plan, record, {}, iso(time.time()), error=reason)
        save_record(directory, record)
    except Exception as second:  # noqa: BLE001
        _warn(f"could not record the seats' failure: {type(second).__name__}: {second} (after {type(failure).__name__}: {failure})")


def settled(record: dict) -> list[dict]:
    """settle's return (design-challenge note 6): every pinned seat's provider record plus `findings`, the panel findings whose
    ids are in its `finding_ids`, cut to {id, severity, file, line, title, detail}."""
    entry = record["panels"][0]
    by_id = {finding["id"]: finding for finding in entry["findings"]}
    keys = ("id", "severity", "file", "line", "title", "detail")
    return [{**json.loads(json.dumps(provider)),
             "findings": [{key: by_id[finding_id][key] for key in keys} for finding_id in provider["finding_ids"] if finding_id in by_id]}
            for provider in entry["providers"]]


def settle(runtime, *, clock=time.time, sleep=time.sleep) -> list[dict]:
    """Appendix A / PRD 7.2: block until every seat of the judged panel has ended or hit its own timeout, a seat relaunched on
    resume included (a non-terminal record with nothing started in this process starts its non-terminal seats first), then write
    the terminal seat part of panel.json and return the seats (settled). Afterwards `collect` is a no-op. A KeyboardInterrupt or
    TransientInfraError stops the seats, leaves them non-terminal and propagates; any other failure records the panel failed."""
    from .sessions import TransientInfraError
    plan = runtime.plan
    if judged_item(plan) is None:
        return []
    directory = Path(runtime.directory)
    if getattr(runtime, "panel_jobs", None) is None:
        record = load_record(directory)
        if record is None or record["panels"][0]["status"] not in TERMINAL_PANEL:
            ensure_started(runtime, clock=clock)
    jobs = [job for items in (getattr(runtime, "panel_jobs", None) or {}).values() for job in items]
    runtime.panel_jobs = None
    record = None
    try:
        record = load_record(directory) or pending_record(plan)
        if jobs:
            reaped = _wait_seats(directory, plan["panels"][0], record, jobs, clock, sleep)
            _finalize_seats(directory, plan, record, reaped, iso(clock()))
            save_record(directory, record)
    except (KeyboardInterrupt, TransientInfraError):
        _stop_seats(jobs)
        raise
    except Exception as failure:  # noqa: BLE001
        _fail_seats(directory, plan, record, jobs, failure)
        record = load_record(directory) or record or pending_record(plan)
    return settled(record)


def _collect_seats(runtime, error, clock, sleep) -> None:
    """collect for a judged plan whose seats `settle` did not end: an interrupt stops them and leaves them non-terminal; an exit
    with no review.json terminates them and records the panel failed; a decided review waits for them as settle does."""
    from .sessions import TransientInfraError
    plan = runtime.plan
    directory = Path(runtime.directory)
    jobs = [job for items in runtime.panel_jobs.values() for job in items]
    runtime.panel_jobs = None
    record = None
    try:
        record = load_record(directory) or pending_record(plan)
        item = plan["panels"][0]
        entry = record["panels"][0]
        if isinstance(error, (KeyboardInterrupt, TransientInfraError)) or not (directory / "review.json").exists():
            labels = context_labels((directory / DIR / item["id"] / CONTEXT).read_text(errors="replace")) \
                if (directory / DIR / item["id"] / CONTEXT).exists() else []
            reaped = {}
            for job in jobs:
                if job.result is None and not job.running():
                    if job.expired:  # Killed at its cap by its watchdog (challenge note 2).
                        _time_out(job, entry["providers"][job.provider_index])
                    else:
                        reaped[job.provider_index] = _reap_seat(directory, item, job, entry["providers"][job.provider_index], labels,
                                                                entry["context_bytes"] or 0)
            if isinstance(error, (KeyboardInterrupt, TransientInfraError)):
                _stop_seats(jobs)  # The still-running seats stay `running`: resume reruns them.
                save_record(directory, record)
                return
            reason = f"review exited with no review.json ({type(error).__name__ if error else 'no error'})"
            for job in jobs:
                if job.result is None:
                    job.result = {"terminated": True}
                    entry["providers"][job.provider_index].update(status="error", error=clip(f"terminated: {reason}", 4000))
            _stop_seats(jobs)
            _finalize_seats(directory, plan, record, reaped, iso(clock()), error=reason)
            save_record(directory, record)
            return
        reaped = _wait_seats(directory, item, record, jobs, clock, sleep)
        _finalize_seats(directory, plan, record, reaped, iso(clock()))
        save_record(directory, record)
    except KeyboardInterrupt:
        raise
    except Exception as failure:  # noqa: BLE001
        _fail_seats(directory, plan, record, jobs, failure)


def record_judge(runtime, panel_id: str, judge: dict) -> None:
    """Appendix A / PRD 7.3: the judge object (any status of `pending → running → judged | failed | timed_out | incomplete`)
    stored in the judged panel `panel_id` of panel.json 1.1.0, validated against the schema before the write (the controller
    holds `controller.lock`, panel.json's sole writer). [L4]: each seat finding's `accepted` is true exactly when its id is a
    source of a `confirmed` ruling of a `judged` record (all false otherwise, and on fallback); the panel's `ended_at` becomes
    the judge's. A record or object that breaks the schema is refused with ValueError, and nothing is written."""
    from jsonschema.exceptions import ValidationError
    directory = Path(runtime.directory)
    record = load_record(directory)
    if record is None:
        if judged_item(runtime.plan) is None:
            raise ValueError("record_judge: the plan has no judged panel")
        record = pending_record(runtime.plan)
    if record.get("version") != JUDGED_RECORD_VERSION:
        raise ValueError(f"record_judge: panel.json is version {record.get('version')}, not the judged record {JUDGED_RECORD_VERSION}")
    entry = next((item for item in record["panels"] if item.get("id") == panel_id and item.get("judged") is True), None)
    if entry is None:
        raise ValueError(f"record_judge: panel.json has no judged panel {panel_id!r}")
    if not isinstance(judge, dict):
        raise ValueError("record_judge: the judge must be an object")
    judge = json.loads(json.dumps(judge))
    confirmed = set()
    if judge.get("status") == "judged" and judge.get("fallback") is False:
        confirmed = {source for ruling in judge.get("rulings") or [] if isinstance(ruling, dict) and ruling.get("ruling") == "confirmed"
                     for source in ruling.get("sources") or []}
    entry["judge"] = judge
    for finding in entry["findings"]:
        finding["accepted"] = finding["id"] in confirmed
    entry["ended_at"] = judge.get("ended_at")
    try:
        save_record(directory, record)
    except ValidationError as error:
        place = ".".join(str(part) for part in error.absolute_path)
        raise ValueError(f"record_judge: the judge object breaks panel record {JUDGED_RECORD_VERSION} at {place}: {error.message}") from None


def judged_line(directory: Path, plan: dict) -> str:
    """PRD 7.7: `Panel (judged): <n> seats ok, <n> not ok; judge: <c> confirmed (<b> P0/P1), <d> deferred, <r> refuted` once the
    judge ruled, `Panel (judged): judge <status>; today's rule decided` on its fallback, and the step's progress before."""
    record = load_record(directory)
    entry = record["panels"][0] if record and record.get("panels") else None
    if entry is None or entry["status"] == "pending":
        return "Panel (judged): runs at the review step."
    if entry["status"] == "running":
        return "Panel (judged): seats running."
    ok = sum(1 for provider in entry["providers"] if provider["status"] == "ok")
    seats = f"{ok} seats ok, {len(entry['providers']) - ok} not ok"
    judge = entry.get("judge") or {}
    status = judge.get("status", "pending")
    if status == "judged":
        rulings = judge.get("rulings") or []
        confirmed = [ruling for ruling in rulings if ruling["ruling"] == "confirmed"]
        blocking = sum(1 for ruling in confirmed if ruling["severity"] in ("P0", "P1"))
        deferred = sum(1 for ruling in rulings if ruling["ruling"] == "deferred")
        refuted = sum(1 for ruling in rulings if ruling["ruling"] == "refuted")
        return f"Panel (judged): {seats}; judge: {len(confirmed)} confirmed ({blocking} P0/P1), {deferred} deferred, {refuted} refuted"
    if status in ("pending", "running"):
        return f"Panel (judged): {seats}; judge {status}"
    return f"Panel (judged): judge {status}; today's rule decided"


# ---- Status and outcome ---------------------------------------------------------------------------------------------

def status_lines(directory: Path, plan: dict) -> list[str]:
    """`panel <id>: <a> accepted of <n>` per panel, or its status while it has no findings yet; a judged panel's PRD 7.7 line."""
    if not has_panels(plan):
        return []
    if judged_item(plan) is not None:
        return [judged_line(directory, plan)]
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
    """One report-only line per panel after the review lines (Appendix A); none for a plan without `panels`. Never the verdict.
    A judged panel has its one PRD 7.7 line instead."""
    if not has_panels(plan):
        return []
    if judged_item(plan) is not None:
        return [judged_line(directory, plan)]
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
