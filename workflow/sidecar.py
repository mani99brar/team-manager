"""The review sidecar of feature.json 2.3.0 (docs/PRD_REVIEW_SIDECAR.md sections 3 to 4.7).

An independent senior-engineering reviewer beside the workers of a run, never a LangGraph node and never a gate:

- Passes, not a session. Each pass is one read-only `claude --print` job (Read, Glob and Grep, structured output
  against `contracts/workflow/sidecar.schema.json` `$defs.output`) over `<run>/sidecar-inputs/<n>/`: the lanes' diffs
  against the base, their visible panes, their completion and question files, the pinned tasks and the ledger it holds.
- The controller owns `<run>/sidecar.ledger.json`: it merges each output (new findings get the next `S-<n>`, an upsert
  overwrites the finding and appends its history), validates the result against the schema and replaces the file
  atomically under `<run>/sidecar.lock`. A rejected output leaves the file byte-identical.
- Messages reach a worker only through the controller: refused for a lane that is not launched, went on, waits on a
  question, already got one this pass or reached `max_messages_per_lane`, and after freeze; typed (`[Review sidecar
  S-n] <text>`, then Enter) only while the lane's row is `working` or `idle`, its pane shows `claude attach <id>` and
  the Claude Code input line is empty. The merged ledger with the messages `pending` is written before anything is typed.
- In automatic mode `automatic.wait_handoffs` schedules the passes (Scheduler): on a cadence, at once when a lane
  writes a `completed` completion, and a final pass once every lane's completion is accepted, each a polled child.
  Manual runs use `python -m workflow sidecar-pass <run> [--final]`.
- Never blocks the run, never raises into it: every step runs under one guard that catches everything except
  KeyboardInterrupt, records the pass `failed` or the message `undeliverable` and writes one `interactive` event. The
  `sidecar` node only receives `running`, `interactive` and `succeeded`; event messages hold counts and ids only.

A plan without `sidecar` (every feature without one, every 2.2.0 feature, every run prepared before) touches none of this.
"""
from __future__ import annotations

import argparse
import copy
import fcntl
import json
import os
import re
import shutil
import signal
import subprocess
import threading
import time
import traceback
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

from .attention import attention
from .guardrails import epoch, input_shown, iso, pane_attachment, went_on, waiting_question
from .sessions import plan_reviewers, plan_workers, popen_claude, read_json, save_json, terminate
from .verification import CONTRACTS, validate_schema

SIDECAR = "sidecar"
SIDECAR_VERSION = "2.3.0"
LEDGER_VERSION = "1.0.0"
SCHEMA = CONTRACTS / "sidecar.schema.json"
BUILTIN_BRIEFS = Path(__file__).resolve().parent / "prompts" / "sidecar"
BUILTIN_PREFIX = "builtin:"
DEFAULTS = {"cadence_seconds": 900, "pass_timeout_seconds": 600, "max_passes": 16, "max_messages_per_lane": 6}
BOUNDS = {"cadence_seconds": (60, 7200), "pass_timeout_seconds": (60, 3600), "max_passes": (1, 64), "max_messages_per_lane": (0, 20)}
OUTPUT_LIMIT = 256 * 1024
LEDGER_LIMIT = 4 * 1024 * 1024
KEPT_INPUTS = 8
MESSAGE_CHARACTERS = 1200  # What the protocol asks of a message; the schema's bound is the stored text's 2,000.
FINDING_FIELDS = ("category", "severity", "lane", "file", "locator", "revision", "problem", "evidence", "remedy", "disposition", "note")
TERMINAL = frozenset({"verified_resolved", "withdrawn", "accepted_trade_off"})
GATE_STATES = frozenset({"working", "idle"})
LANE_STATES = frozenset({"idle", "working", "blocked", "done"})
OPEN = ("open", "acknowledged", "fix_reported")
RANK = {"P1": 1, "P0": 2}  # The severities that page the operator when no lane takes them (Pass.page); P2 never does.
GIT_ENV = {"GIT_OPTIONAL_LOCKS": "0"}  # The sidecar never takes a worker's index.lock.
GIT_TIMEOUT_SECONDS = 60  # A lane Git call that waits longer (on a FIFO planted in the shared .git) fails its pass, not the poll.
LEDGER = "sidecar.ledger.json"
LOCK = "sidecar.lock"
RUNNING = "sidecar.running.json"
INPUTS = "sidecar-inputs"
SUPERVISOR_LOCK = "automatic-supervisor.lock"


# ---- Configuration: feature.json 2.3.0 and plan.sidecar ------------------------------------------------------------

def settings(value: dict, where: str = "sidecar ") -> dict:
    """The four bounds with the defaults filled in; a missing or out-of-range value is refused, naming the key."""
    result = dict(DEFAULTS)
    for key, item in value.items():
        if key not in BOUNDS:
            raise ValueError(f"{where}{key} is not a sidecar setting ({', '.join(BOUNDS)})")
        low, high = BOUNDS[key]
        if type(item) is not int or not low <= item <= high:
            raise ValueError(f"{where}{key} must be an integer from {low} to {high}, got {item!r}")
        result[key] = item
    return result


def declared(manifest: dict) -> dict | None:
    """The feature's `sidecar` as `{prompt, <bounds>}` with the defaults filled in; None without one (absent or false).

    Refused, naming feature.json and the key: `sidecar` before 2.3.0, a value that is neither false nor an object with a
    non-empty `prompt`, an unknown key and a bound out of range.
    """
    value = manifest.get("sidecar", False)
    if value is False:
        return None
    if manifest.get("version") != SIDECAR_VERSION:
        raise ValueError(f"feature.json sidecar needs version {SIDECAR_VERSION} (this file is {manifest.get('version')})")
    if not isinstance(value, dict):
        raise ValueError("feature.json sidecar must be false or an object with a prompt")
    prompt = value.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("feature.json sidecar.prompt must name a brief file in the feature directory or builtin:<id>")
    return {"prompt": prompt, **settings({key: item for key, item in value.items() if key != "prompt"}, "feature.json sidecar.")}


def builtin_briefs() -> list[str]:
    return sorted(path.stem for path in BUILTIN_BRIEFS.glob("*.md"))


def brief_path(folder: Path, prompt: str) -> Path:
    """`builtin:<id>` names a brief bundled in workflow/prompts/sidecar/, anything else an existing non-empty feature file."""
    if prompt.startswith(BUILTIN_PREFIX):
        name = prompt[len(BUILTIN_PREFIX):]
        if name not in builtin_briefs():
            raise ValueError(f"feature.json sidecar.prompt names an unknown bundled sidecar brief {prompt!r}; bundled: "
                             f"{', '.join(BUILTIN_PREFIX + item for item in builtin_briefs())}")
        return BUILTIN_BRIEFS / f"{name}.md"
    path = (folder / prompt).resolve()
    if not path.is_relative_to(folder.resolve()):
        raise ValueError(f"feature.json sidecar.prompt {prompt!r} escapes the feature directory")
    if not path.is_file() or not path.read_text().strip():
        raise ValueError(f"feature.json sidecar.prompt {prompt!r} is missing or empty in {folder}")
    return path


def has_sidecar(plan: dict) -> bool:
    """The run declares a review sidecar: `plan.sidecar`, pinned at prepare. Never an entry of `plan["nodes"]`."""
    return isinstance(plan.get("sidecar"), dict)


def pin(plan: dict, brief: Path, values: dict) -> None:
    """`prepare --sidecar-brief --sidecar-settings`: the brief text and the bounds as `plan.sidecar`."""
    text = brief.read_text()
    if not text.strip():
        raise ValueError(f"Sidecar brief {brief} is empty")
    plan["sidecar"] = {"prompt": text, **settings(values, "--sidecar-settings ")}
    plan["feature_version"] = SIDECAR_VERSION


def validate_plan(plan: dict) -> None:
    item = plan.get("sidecar")
    if item is None:
        return
    if not isinstance(item, dict) or set(item) != {"prompt", *DEFAULTS} or not isinstance(item["prompt"], str) or not item["prompt"].strip():
        raise ValueError("Malformed plan.sidecar: expected {prompt, " + ", ".join(DEFAULTS) + "}")
    settings({key: item[key] for key in DEFAULTS}, "plan.sidecar.")


def plan_settings(plan: dict) -> dict:
    return {key: plan["sidecar"][key] for key in DEFAULTS}


# ---- The ledger ------------------------------------------------------------------------------------------------------

class Rejected(ValueError):
    """An output the merge refuses as a whole; `reason` is a fixed word the event may carry, never the model's text."""

    def __init__(self, reason: str, detail: str):
        super().__init__(f"{reason}: {detail}")
        self.reason = reason


def ledger_path(directory: Path) -> Path:
    return directory / LEDGER


def initial_ledger(plan: dict) -> dict:
    return {"version": LEDGER_VERSION, "run_id": plan["run_id"], "settings": plan_settings(plan), "passes": [], "findings": [],
            "messages": [], "escalations": [], "handoff": None, "closed_at": None}


def load_ledger(directory: Path, plan: dict) -> dict:
    path = ledger_path(directory)
    return read_json(path) if path.exists() else initial_ledger(plan)


@contextmanager
def ledger_lock(directory: Path):
    """Serialises every ledger write: the automatic controller, `sidecar-pass` and freeze."""
    with (directory / LOCK).open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


DEFERRING = []  # The main thread's active deferred_interrupt blocks: an inner one only yields.


@contextmanager
def deferred_interrupt():
    """A Ctrl-C during the block is raised once the block finished, so a ledger write is never cut short (main thread only).
    Re-entrant: inside an active block an inner one only yields, so a block that holds a write and the pages it triggers
    (Pass.merge, Pass.deliver, recover) raises after the pages, not after save_ledger's own block. The Ctrl-C always wins: when the
    block raises another error too (a full disk, a failed page), the Ctrl-C is raised with that error as its cause."""
    if threading.current_thread() is not threading.main_thread() or DEFERRING:
        yield
        return
    caught = []
    previous = signal.signal(signal.SIGINT, lambda *_: caught.append(True))
    DEFERRING.append(True)
    try:
        yield
    except BaseException as error:
        if caught:
            raise KeyboardInterrupt from error
        raise
    finally:
        DEFERRING.pop()
        signal.signal(signal.SIGINT, previous)
    if caught:
        raise KeyboardInterrupt


def ledger_bytes(ledger: dict) -> int:
    return len(json.dumps(ledger, indent=2).encode()) + 1  # As save_json writes it.


def save_ledger(directory: Path, ledger: dict) -> None:
    """Validate, bound and replace atomically; the caller holds the ledger lock."""
    validate_schema("sidecar", ledger)
    if ledger_bytes(ledger) > LEDGER_LIMIT:
        raise Rejected("size", f"the ledger would grow past {LEDGER_LIMIT} bytes")
    with deferred_interrupt():
        save_json(ledger_path(directory), ledger)


def write_initial(directory: Path, plan: dict) -> None:
    """prepare: the empty ledger, so the viewer shows the sidecar before its first pass."""
    with ledger_lock(directory):
        if not ledger_path(directory).exists():
            save_ledger(directory, initial_ledger(plan))


def numbered(prefix: str, ids) -> int:
    values = [int(item[len(prefix):]) for item in ids if isinstance(item, str) and re.fullmatch(re.escape(prefix) + r"[0-9]+", item)]
    return max(values, default=0)


def merge(ledger: dict, output: dict, record: dict, lanes: list[str], at: str, refusal=None) -> tuple[dict, list[dict], list[dict]]:
    """The ledger with one pass's output merged and its `record` appended: (ledger, new messages, new escalations).

    Pure: `ledger` is not changed, and any refusal raises Rejected before anything is built. Refused: an unknown id, a
    lane that is not the run's, two upserts sharing an id or a ref, a citation that is neither an existing id nor a ref
    of this output, and an illegal transition (`verified_resolved` and `withdrawn` need evidence, `accepted_trade_off` a
    note, reopening a terminal disposition evidence). New findings get the next `S-<n>`; an upsert overwrites the
    finding's own fields, and each created or changed finding appends that upsert's disposition, revision, evidence and
    note to its history. A message gets the next `M-<n>`, its citations resolved, and the status `pending`, or `refused`
    with `refusal(lane)`'s reason (lane state), `rate_limited` for a second one to the same lane in this pass or past
    `max_messages_per_lane` delivered. A final pass's handoff replaces the ledger's; any other pass's is ignored.
    """
    if len(json.dumps(output).encode()) > OUTPUT_LIMIT:
        raise Rejected("output_size", f"the output exceeds {OUTPUT_LIMIT} bytes")
    existing = {finding["id"]: finding for finding in ledger["findings"]}
    ids, refs = set(), set()
    for upsert in output["findings"]:
        if upsert["lane"] not in lanes:
            raise Rejected("unknown_lane", f"a finding names lane {upsert['lane']!r}, not a lane of this run")
        if upsert["id"] is not None:
            if upsert["id"] not in existing:
                raise Rejected("unknown_id", f"no finding {upsert['id']!r} in the ledger")
            if upsert["id"] in ids:
                raise Rejected("duplicate", f"two upserts of {upsert['id']}")
            ids.add(upsert["id"])
        elif upsert.get("ref") is None:
            raise Rejected("schema", "a new finding without a ref")
        if upsert.get("ref") is not None:
            if upsert["ref"] in refs:
                raise Rejected("duplicate", f"two upserts share the ref {upsert['ref']}")
            refs.add(upsert["ref"])
        evidence, note = upsert["evidence"].strip(), (upsert["note"] or "").strip()
        if upsert["disposition"] in {"verified_resolved", "withdrawn"} and not evidence:
            raise Rejected("transition", f"{upsert['disposition']} without evidence")
        if upsert["disposition"] == "accepted_trade_off" and not note:
            raise Rejected("transition", "accepted_trade_off without a note naming the owner decision")
        before = existing.get(upsert["id"])
        if before and before["disposition"] in TERMINAL and upsert["disposition"] not in TERMINAL and not evidence:
            raise Rejected("transition", f"{before['id']} reopened from {before['disposition']} without evidence")
    for message in output["messages"]:
        if message["lane"] not in lanes:
            raise Rejected("unknown_lane", f"a message names lane {message['lane']!r}, not a lane of this run")
    cited = [item for message in output["messages"] for item in message["finding_ids"]] + [item["finding_id"] for item in output["escalations"]]
    for item in cited:
        if item not in existing and item not in refs:
            raise Rejected("unknown_ref", f"a citation of {item!r} is neither a finding of the ledger nor a ref of this output")
    merged = copy.deepcopy(ledger)
    findings = {finding["id"]: finding for finding in merged["findings"]}
    resolved, counter, new, changed = {}, numbered("S-", findings), 0, 0
    for upsert in output["findings"]:
        fields = {key: upsert[key] for key in FINDING_FIELDS}
        entry = {"pass": record["n"], "disposition": upsert["disposition"], "revision": upsert["revision"], "evidence": upsert["evidence"],
                 "note": upsert["note"], "at": at}
        if upsert["id"] is None:
            counter += 1
            finding = {"id": f"S-{counter}", **fields, "messages": [], "history": [entry]}
            merged["findings"].append(finding)
            findings[finding["id"]] = finding
            new += 1
        else:
            finding = findings[upsert["id"]]
            if any(finding[key] != value for key, value in fields.items()):
                finding.update(fields)
                finding["history"].append(entry)
                changed += 1
        if upsert.get("ref") is not None:
            resolved[upsert["ref"]] = finding["id"]
    resolve = lambda item: resolved.get(item, item)
    delivered = {}
    for message in merged["messages"]:
        if message["status"] == "delivered":
            delivered[message["lane"]] = delivered.get(message["lane"], 0) + 1
    limit = merged["settings"]["max_messages_per_lane"]
    sent, messages = set(), []
    counter = numbered("M-", [message["id"] for message in merged["messages"]])
    for item in output["messages"]:
        counter += 1
        lane = item["lane"]
        reason = refusal(lane) if refusal else None
        if reason is None and lane in sent:
            reason = "rate_limited"
        if reason is None and delivered.get(lane, 0) + sum(1 for message in messages if message["lane"] == lane and message["status"] == "pending") >= limit:
            reason = "rate_limited"
        message = {"id": f"M-{counter}", "pass": record["n"], "lane": lane, "finding_ids": list(dict.fromkeys(map(resolve, item["finding_ids"]))),
                   "text": item["text"], "status": "refused" if reason else "pending", "reason": reason, "at": at}
        if reason is None:
            sent.add(lane)
        messages.append(message)
        merged["messages"].append(message)
        for finding_id in message["finding_ids"]:
            findings[finding_id]["messages"].append(message["id"])
    escalations = [{"pass": record["n"], "finding_id": resolve(item["finding_id"]), "kind": item["kind"], "text": item["text"], "at": at}
                   for item in output["escalations"]]
    merged["escalations"].extend(escalations)
    if record["trigger"] == "final" and output["handoff"] is not None:
        merged["handoff"] = output["handoff"]
    merged["passes"].append({**record, "counts": {"new": new, "changed": changed, "messages": len(messages)}, "summary": output["summary"]})
    return merged, messages, escalations


def became_blocking(before: dict | None, after: dict) -> bool:
    """`after` is an open P0/P1 it was not before the pass (`before` None for a new finding): new, raised from a lower
    severity, or reopened from a terminal disposition."""
    if after["severity"] not in RANK or after["disposition"] not in OPEN:
        return False
    return before is None or before["disposition"] not in OPEN or RANK[after["severity"]] > RANK.get(before["severity"], -1)


# ---- Paging the operator (C41, decision 12) --------------------------------------------------------------------------
# A finding a pass made an open P0/P1 that no message of that pass delivered to its lane, and every escalation, is one `sidecar`
# attention record on the finding's lane, written once: when the ledger first says the lane will not get it. Unlike the events,
# the text quotes the first sentence: the operator may have only this line. attention() never raises.

def read_it(directory: Path) -> str:
    return f"Read it in {ledger_path(directory)} or on the run's sidecar page."


def page_finding(directory: Path, n: int, finding: dict, why: str) -> None:
    """Pass `n`'s P0/P1 that did not reach its lane: `why` is how its message there ended (`refused, lane_finished`,
    `undeliverable, interrupted`, ...) or `no message to it`."""
    from .automatic import first_sentence
    attention(directory, "sidecar", f"Review sidecar pass {n}: {finding['severity']} {finding['id']} on lane {finding['lane']} did not reach "
                                    f"the lane ({why}): {first_sentence(finding['problem'])} {read_it(directory)}", node=finding["lane"])


def page_escalation(directory: Path, escalation: dict, lane: str | None) -> None:
    from .automatic import first_sentence
    attention(directory, "sidecar", f"Review sidecar pass {escalation['pass']}: escalation {escalation['finding_id']} ({escalation['kind']})"
                                    f"{f' on lane {lane}' if lane else ''}: {first_sentence(escalation['text'])} {read_it(directory)}", node=lane)


def findings_read(directory: Path, n: int) -> dict | None:
    """The severity and disposition of each finding, by id, in the ledger pass `n` read before its merge (its inputs'
    ledger.json, which only the controller writes); None once those inputs are gone or unreadable."""
    try:
        findings = read_json(directory / INPUTS / str(n) / "ledger.json")["findings"]
        return {finding["id"]: {"severity": finding["severity"], "disposition": finding["disposition"]} for finding in findings}
    except (OSError, ValueError, KeyError, TypeError):
        return None


def page_interrupted(directory: Path, ledger: dict, messages: list[dict]) -> None:
    """recover(): what the delivery of `messages`, now `undeliverable` (`interrupted`), would have paged had its controller not
    stopped (Pass.page_outcome): each finding a message carried on its own lane that the message's pass made an open P0/P1. A
    finding on another lane was paged at the merge, before anything was typed (Pass.page). The ledger that pass read says
    which ones it made blocking; without it, a finding with a history entry of that pass counts as new or raised there."""
    findings = {finding["id"]: finding for finding in ledger["findings"]}
    for message in messages:
        earlier = findings_read(directory, message["pass"])
        for finding_id in message["finding_ids"]:
            finding = findings.get(finding_id)
            if finding is None or finding["lane"] != message["lane"]:
                continue
            if earlier is not None:
                blocking = became_blocking(earlier.get(finding_id), finding)
            else:
                blocking = (finding["severity"] in RANK and finding["disposition"] in OPEN
                            and any(entry.get("pass") == message["pass"] for entry in finding["history"]))
            if blocking:
                page_finding(directory, message["pass"], finding, "undeliverable, interrupted")


# ---- The job's schema and prompt -----------------------------------------------------------------------------------

def schema() -> dict:
    return json.loads(SCHEMA.read_text())


def inline(value, defs: dict):
    """`value` with every `#/$defs/<name>` reference replaced by a copy of that definition (the CLI takes one self-contained schema)."""
    if isinstance(value, dict):
        if set(value) == {"$ref"} and value["$ref"].startswith("#/$defs/"):
            return inline(defs[value["$ref"][len("#/$defs/"):]], defs)
        return {key: inline(item, defs) for key, item in value.items() if key != "description"}
    if isinstance(value, list):
        return [inline(item, defs) for item in value]
    return value


def output_schema() -> dict:
    """The job's `--json-schema`: `$defs.output` self-contained. The `ref`-when-`id`-is-null rule is the merge's own."""
    defs = schema()["$defs"]
    output = inline(defs["output"], defs)
    output["properties"]["findings"]["items"].pop("allOf", None)
    return output


def validate_output(value) -> None:
    from jsonschema import Draft202012Validator
    Draft202012Validator({"$defs": schema()["$defs"], "$ref": "#/$defs/output"}).validate(value)


def owned_paths(directory: Path) -> dict[str, list[str]]:
    policy = directory / "policy.json"
    if not policy.is_file():
        return {}
    return {worker["node_id"]: list(worker["owned_paths"]) for worker in read_json(policy).get("workers", [])}


# The sidecar's own severity rule (C41, operator decisions 4 and 12, 3 Oct 2026), never a reviewer brief's bar: the briefs are
# context in tasks/reviewers/. Without a rule every finding of 35 live passes came out P2.
SEVERITY_RULE = ("Severity, the operator's rule for your findings, whatever a reviewer brief says: P0 or P1 only for a defect shown by the "
                 "code, a check or a pane; work that contradicts a line of a task, of decisions.md or a safety line of the PRD; a failure "
                 "the worker disclosed; or a security or data-loss risk. P0 when the lane's work must not merge at all. Untested "
                 "behaviour, risks and suggestions are P2, however likely; P2 is the lowest.")


def pass_prompt(directory: Path, plan: dict, n: int, trigger: str, inputs: Path) -> str:
    """The pinned brief, the project conventions, then the controller's protocol block (PRD section 3): vocabulary, owned
    paths, inputs, ledger, the severity rule and the rules. The conventions block is guardrails.conventions_block, word for word as
    the workers, reviewers and challenge get it."""
    from . import guardrails  # At use, never as a name of this module: the block has one definition.
    lanes = plan_workers(plan)
    owned = owned_paths(directory)
    vocabulary = "; ".join(f"{lane} (worktree {plan['nodes'][lane]['worktree']}, owns {', '.join(owned.get(lane, [])) or 'its assigned paths'})"
                           for lane in lanes)
    final = (" This is the final pass: every lane's completion was accepted and the run freezes after it. Fill handoff: unresolved "
             "(the open findings that matter), structural (design concerns), verified_resolved, withdrawn and gaps (what you could not "
             "check), each a list of short strings." if trigger == "final" else
             " handoff is null: only the final pass fills it.")
    limit = plan["sidecar"]["max_messages_per_lane"]
    tasks = ("tasks/ holds the pinned tasks, decisions.md, the policy, the design challenge record and, in reviewers/, the briefs of "
             "the run's reviewers: what review will look at, never a severity rule for your findings." if (inputs / "tasks" / "reviewers").is_dir()
             else "tasks/ holds the pinned tasks, decisions.md, the policy and the design challenge record.")
    return ((plan["sidecar"]["prompt"].rstrip() + guardrails.conventions_block(plan)).rstrip() + "\n\n"
            f"=== Review sidecar protocol (appended by the controller) ===\n"
            f"Run {plan['run_id']}, pass {n} ({trigger}), base commit {plan['base_commit']}. Lanes: {vocabulary}.\n"
            f"Inputs of this pass, in {inputs}: manifest.json lists per lane its head commit, native state (idle, working, blocked, done, "
            "stopped or unknown), completion, whether a question waits, its deadline, diff_file (git diff against the base commit, then "
            "the untracked files, which you read in the worktree), pane_file (the visible text of its pane, null when not captured) and the "
            "copies of its completion and questions files. ledger.json is the ledger you hold so far: your memory between passes, with "
            f"every finding, its disposition and history, and the messages sent and what became of them. {tasks}\n"
            f"{SEVERITY_RULE}\n"
            "Rules: only read; you change nothing and run nothing. Return the requested JSON schema. Every finding names a lane of this "
            "run, a file and a revision (the lane's head commit as the manifest spells it, or working-tree for uncommitted changes). "
            "Update a finding of the ledger by its id (S-<n>), giving every field: the upsert replaces them. A new finding has id null "
            "and a ref new-1, new-2, ... that your messages and escalations of this output cite. Dispositions: open, acknowledged, "
            "fix_reported (the worker says it fixed it), verified_resolved (you checked the fix in this revision; evidence required), "
            "withdrawn (you were wrong; evidence required) and accepted_trade_off (an owner decision; a note naming it required); "
            "reopening a verified_resolved, withdrawn or accepted_trade_off finding needs evidence. A finding is never deleted. A message "
            f"goes to one lane, cites at least one finding (S-<n> or new-<k>) and is plain text of at most {MESSAGE_CHARACTERS} "
            "characters, one per lane per pass. The controller decides whether it is typed into the lane's pane, prefixed "
            "[Review sidecar S-n]: never to a lane that finished or waits on the operator's answer to its question, never into a dialog "
            f"or a draft, at most {limit} per lane in the run. Workers reply in their pane, which your next pass reads. Escalate "
            "(security, data_loss, architecture) only what the operator must see now. No new findings is a valid pass: empty arrays."
            + final + "\n")


# ---- Pass inputs ---------------------------------------------------------------------------------------------------

def lane_git(worktree: Path, *args: str) -> str:
    """Git in a lane worktree, without optional locks, for at most GIT_TIMEOUT_SECONDS. A pass runs inside wait_handoffs' poll,
    and a FIFO planted at the shared .git's info/exclude blocks `git diff` and `git ls-files` there: past the bound Git is
    killed and TimeoutExpired fails the pass (Scheduler.guard records it `failed`), and the run goes on."""
    return subprocess.run(["git", "-C", str(worktree), *args], env={**os.environ, **GIT_ENV}, check=True, capture_output=True,
                          timeout=GIT_TIMEOUT_SECONDS).stdout.decode(errors="replace")


def safe_text(value: str) -> str:
    """Pane text without terminal escape sequences and control bytes (newlines and tabs kept)."""
    value = re.sub(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)", "", value)
    value = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", value)
    return "".join(char for char in value if char in "\n\t" or (char.isprintable() and char != "\x1b"))


class HerdrSkipped(RuntimeError):
    """A Herdr call this pass skips: an earlier call of the pass timed out."""


class Herdr:
    """One pass's Herdr calls: synchronous (15 s each), and after the pass's first timeout every later call is skipped."""

    def __init__(self, directory: Path):
        self.directory = directory
        self.timed_out = False

    def available(self) -> bool:
        return os.environ.get("HERDR_ENV") == "1"

    def pane(self, lane: str) -> str | None:
        path = self.directory / "terminals.json"
        mapping = read_json(path) if path.exists() else {}
        return (mapping.get(lane) or {}).get("pane_id")

    def call(self, *args: str, text: bool = False):
        from .herdr import herdr, herdr_text
        if self.timed_out:
            raise HerdrSkipped("an earlier Herdr call of this pass timed out")
        try:
            return herdr_text(*args) if text else herdr(*args)
        except subprocess.TimeoutExpired:
            self.timed_out = True
            raise


def lane_state(directory: Path, sessions, lane: str, rows) -> str:
    if (directory / f"{lane}.stop.json").exists():
        return "stopped"
    if rows is None:
        return "unknown"
    try:
        row = sessions.locate(lane, rows)
    except Exception:
        return "unknown"
    state = (row or {}).get("state")
    return state if state in LANE_STATES else "unknown"


def lane_completion(directory: Path, lane: str) -> dict | None:
    """The status of the lane's completion file and whether the controller accepted it (its deadline met, or its handoff saved)."""
    from .guardrails import deadline_met
    path = directory / f"{lane}.completion.json"
    try:
        status = read_json(path).get("status") if path.is_file() else None
    except (ValueError, AttributeError):
        status = "unreadable"
    if status is None:
        return None
    return {"status": str(status), "accepted": (directory / f"{lane}.handoff.json").exists() or deadline_met(directory, lane)}


def lane_deadline_at(runtime, lane: str) -> str | None:
    if not isinstance(runtime.plan.get("automatic"), dict):
        return None
    from .automatic import lane_deadline
    try:
        deadline = lane_deadline(runtime, lane)
    except (OSError, ValueError, KeyError):
        return None
    return iso(deadline) if deadline is not None else None


def write_inputs(runtime, n: int, trigger: str, rows, herdr: Herdr, lanes: dict) -> Path:
    """`<run>/sidecar-inputs/<n>/` (PRD 4.3); `lanes` collects each lane's head commit and capture as it is read."""
    directory, plan = runtime.directory, runtime.plan
    inputs = directory / INPUTS / str(n)
    inputs.mkdir(parents=True, mode=0o700)
    tasks = inputs / "tasks"
    tasks.mkdir(mode=0o700)
    for lane in plan_workers(plan):
        (tasks / f"{lane}.task.md").write_text(plan["nodes"][lane]["task"])
    from .guardrails import decisions_text
    if decisions_text(plan) is not None:
        (tasks / "decisions.md").write_text(decisions_text(plan))
    for name in ("policy.json", "challenge.json"):
        if (directory / name).is_file():
            shutil.copyfile(directory / name, tasks / name)
    if plan.get("reviewers") is not None:  # The briefs the run pinned, as context only (C41); the built-in reviewer pins none.
        (tasks / "reviewers").mkdir(mode=0o700)
        for reviewer in plan_reviewers(plan):
            (tasks / "reviewers" / f"{reviewer['reviewer_id']}.md").write_text(reviewer["prompt"])
    save_json(inputs / "ledger.json", load_ledger(directory, plan))
    manifest = {"run_id": plan["run_id"], "pass": n, "trigger": trigger, "base_commit": plan["base_commit"], "inputs": str(inputs),
                "ledger_file": str(inputs / "ledger.json"), "tasks_dir": str(tasks), "lanes": {}}
    for lane in plan_workers(plan):
        worktree = Path(plan["nodes"][lane]["worktree"])
        head = lane_git(worktree, "rev-parse", "HEAD").strip()
        diff = lane_git(worktree, "diff", "--no-color", "--no-ext-diff", "--no-textconv", plan["base_commit"])
        numstat = lane_git(worktree, "diff", "--numstat", "--no-renames", "-z", "--no-ext-diff", "--no-textconv", plan["base_commit"])
        binary = sorted(entry.split("\t", 2)[2] for entry in numstat.split("\0") if entry.startswith("-\t-\t"))
        untracked = sorted(filter(None, lane_git(worktree, "ls-files", "--others", "--exclude-standard", "-z").split("\0")))
        diff_file = inputs / f"{lane}.diff"
        diff_file.write_text(diff + "\n# Untracked files (read them in the worktree):\n" + "".join(f"{name}\n" for name in untracked))
        pane_file = None
        pane = herdr.pane(lane) if herdr.available() else None
        if pane and not herdr.timed_out:
            try:
                screen = herdr.call("pane", "read", pane, "--source", "visible", text=True)
            except subprocess.TimeoutExpired:
                screen = None  # Absent; every later Herdr call of this pass is skipped.
            if screen is not None:
                pane_file = inputs / f"{lane}.pane.txt"
                pane_file.write_text(safe_text(screen))
        copies = {}
        for kind in ("completion", "questions"):
            source = directory / f"{lane}.{kind}.json"
            copies[kind] = None
            if source.is_file() and not source.is_symlink():
                shutil.copyfile(source, inputs / source.name)
                copies[kind] = str(inputs / source.name)
        manifest["lanes"][lane] = {"worktree": str(worktree), "head_commit": head, "state": lane_state(directory, runtime.sessions, lane, rows),
                                   "completion": lane_completion(directory, lane), "question_waiting": waiting_question(directory, lane) is not None,
                                   "deadline": lane_deadline_at(runtime, lane), "diff_file": str(diff_file),
                                   "pane_file": str(pane_file) if pane_file else None, "untracked": untracked, "binary": binary,
                                   "completion_file": copies["completion"], "questions_file": copies["questions"]}
        lanes[lane] = {"head_commit": head, "pane_captured": pane_file is not None}
    save_json(inputs / "manifest.json", manifest)
    return inputs


def prune_inputs(directory: Path, n: int) -> None:
    """A run keeps the inputs of its last KEPT_INPUTS passes; the ledger keeps every pass's summary."""
    root = directory / INPUTS
    if not root.is_dir():
        return
    for path in root.iterdir():
        if path.is_dir() and path.name.isdigit() and int(path.name) <= n - KEPT_INPUTS:
            shutil.rmtree(path)


def next_pass(directory: Path, plan: dict) -> int:
    """The next pass number: past every pass the ledger records and every pass whose files exist (a rejected one is in no ledger)."""
    numbers = [item["n"] for item in load_ledger(directory, plan)["passes"]]
    numbers += [int(match[1]) for path in directory.glob("sidecar-*.*") if (match := re.fullmatch(r"sidecar-([0-9]+)\..+", path.name))]
    if (directory / INPUTS).is_dir():
        numbers += [int(path.name) for path in (directory / INPUTS).iterdir() if path.name.isdigit()]
    marker = directory / RUNNING
    if marker.exists():
        try:
            numbers.append(int(read_json(marker)["pass"]))
        except (ValueError, KeyError, TypeError):
            pass
    return max(numbers, default=0) + 1


# ---- Message delivery ----------------------------------------------------------------------------------------------

def closed(directory: Path, plan: dict) -> bool:
    """After freeze: the ledger is closed, or the snapshots are captured."""
    if (directory / "snapshots.json").exists():
        return True
    path = ledger_path(directory)
    return path.exists() and read_json(path).get("closed_at") is not None


def refusal(directory: Path, plan: dict, lane: str) -> str | None:
    """Why a message to `lane` is refused before anything is typed, or None (the rate limits are the merge's)."""
    if closed(directory, plan):
        return "after_freeze"
    if not (directory / f"{lane}.interactive.json").exists():
        return "lane_not_launched"
    if went_on(directory, lane):
        return "lane_finished"  # Its completion file, handoff or stop: a completion pass never messages the lane that completed.
    if waiting_question(directory, lane) is not None:
        return "question_waiting"
    return None


def typed_text(message: dict) -> str:
    """`[Review sidecar S-3] <text>`: newlines become spaces, escape and control bytes are dropped."""
    text = safe_text(re.sub(r"[\r\n\t]", " ", message["text"]))
    return f"[Review sidecar {', '.join(message['finding_ids'])}] {text}"


def deliver_one(runtime, message: dict, herdr: Herdr) -> tuple[str, str | None]:
    """(status, reason) of one pending message; typed only after a fresh gate (PRD 4.5). Exceptions are the caller's."""
    return deliver_text(runtime, message["lane"], typed_text(message), herdr)


def deliver_text(runtime, lane: str, text: str, herdr: Herdr | None = None) -> tuple[str, str | None]:
    """(status, reason) of typing `text` into `lane`'s pane, then Enter, behind the sidecar's gate: `refused` for a run
    after freeze, a lane not launched, a lane that went on and a lane waiting on a question; `undeliverable` without
    Herdr, without a pane, while the lane's row is not `working` or `idle`, while the pane is not attached to the lane's
    session, and while its input line is not empty. A sidecar message (deliver_one) and an operator's note
    (`workflow note`) both pass it. `text` is typed as given. Exceptions are the caller's."""
    directory, plan = runtime.directory, runtime.plan
    herdr = herdr or Herdr(directory)
    reason = refusal(directory, plan, lane)
    if reason:
        return "refused", reason
    if not herdr.available():
        return "undeliverable", "herdr_unavailable"
    if herdr.timed_out:
        return "undeliverable", "herdr_timeout"
    pane = herdr.pane(lane)
    background_id = read_json(directory / f"{lane}.interactive.json").get("background_id")
    if not pane or not background_id:
        return "undeliverable", "pane_unknown"
    rows = runtime.sessions.inventory()  # Fresh: never the rows taken at the top of the poll.
    row = runtime.sessions.locate(lane, rows)
    if row is None or row.get("state") not in GATE_STATES:
        return "undeliverable", "lane_blocked"  # `blocked` is a dialog, a menu or a refusal: Enter would confirm its default.
    process = (herdr.call("pane", "process-info", "--pane", pane).get("result") or {}).get("process_info") or {}
    if pane_attachment(process, background_id):
        return "undeliverable", "pane_not_attached"
    if input_shown(herdr.call("pane", "read", pane, "--source", "visible", text=True), ""):
        return "undeliverable", "pane_busy"  # A dialog replaced the input line, or the operator has a draft typed.
    herdr.call("pane", "send-text", pane, text)
    herdr.call("pane", "send-keys", pane, "Enter")
    return "delivered", None


def failure_reason(error: BaseException) -> str:
    if isinstance(error, (subprocess.TimeoutExpired, HerdrSkipped)):
        return "herdr_timeout"
    if isinstance(error, subprocess.CalledProcessError):
        return "pane_unknown"  # Herdr refused the pane: closed or unknown.
    from .sessions import TransientInfraError
    if isinstance(error, TransientInfraError):
        return "lane_blocked"  # Its row could not be read: the gate does not hold.
    return "herdr_unavailable"


def flip(directory: Path, plan: dict, message_id: str, status: str, reason: str | None, at: str) -> None:
    """One message's delivery outcome, one atomic write; a Ctrl-C waits for it."""
    with deferred_interrupt(), ledger_lock(directory):
        ledger = load_ledger(directory, plan)
        for message in ledger["messages"]:
            if message["id"] == message_id:
                message.update(status=status, reason=reason, at=at)
        save_ledger(directory, ledger)


# ---- One pass ------------------------------------------------------------------------------------------------------

class JobFailed(RuntimeError):
    """The print job did not return a result of its own session."""


def log_error(path: Path, heading: str, error: BaseException) -> None:
    with path.open("a") as handle:
        handle.write(f"\n=== {heading}: {type(error).__name__} ===\n")
        handle.write("".join(traceback.format_exception(type(error), error, error.__traceback__)))


def claim(directory: Path, record: dict) -> None:
    """Create sidecar.running.json exclusively: two passes can never both run."""
    try:
        descriptor = os.open(directory / RUNNING, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise RuntimeError(f"A sidecar pass is already running ({directory / RUNNING})") from None
    with os.fdopen(descriptor, "w") as handle:
        json.dump(record, handle)
        handle.flush()
        os.fsync(handle.fileno())


class Pass:
    """One pass: inputs, the polled print job, the merge, the deliveries, the events and the pages. Every step may raise; the
    caller guards."""

    def __init__(self, runtime, n: int, trigger: str, clock, detail: str = ""):
        self.runtime, self.directory, self.plan = runtime, runtime.directory, runtime.plan
        self.n, self.trigger, self.clock, self.detail = n, trigger, clock, detail
        self.started = clock()
        self.started_at = iso(self.started)
        self.session_id = str(uuid.uuid4())
        self.process = None
        self.claimed = False
        self.lanes: dict = {}
        self.herdr = Herdr(self.directory)
        self.log = self.directory / f"sidecar-{n}.stderr.log"

    @property
    def label(self) -> str:
        return f"Review sidecar pass {self.n} ({self.trigger}{': ' + self.detail if self.detail else ''})"

    def event(self, status: str, message: str) -> None:
        self.runtime.event(SIDECAR, status, message)

    def start(self, rows) -> None:
        claim(self.directory, {"pass": self.n, "pid": None, "session_id": self.session_id, "started_at": self.started_at, "trigger": self.trigger})
        self.claimed = True
        if self.n == 1:
            self.event("running", f"{self.label} started: one read-only print job, session {self.session_id}")
        prune_inputs(self.directory, self.n)
        inputs = write_inputs(self.runtime, self.n, self.trigger, rows, self.herdr, self.lanes)
        prompt = self.directory / f"sidecar-{self.n}.prompt.txt"
        prompt.write_text(pass_prompt(self.directory, self.plan, self.n, self.trigger, inputs))
        os.chmod(prompt, 0o600)
        from .automatic import print_command
        worktrees = [self.plan["nodes"][lane]["worktree"] for lane in plan_workers(self.plan)]
        command = print_command(self.runtime.sessions.executable, self.session_id, output_schema(), [str(inputs), *worktrees])
        env = {key: value for key, value in os.environ.items() if not key.startswith("HERDR_")}
        with prompt.open() as stdin, (self.directory / f"sidecar-{self.n}.stdout.json").open("w") as output, self.log.open("w") as errors:
            self.process = popen_claude(command, cwd=inputs, env=env, stdin=stdin, stdout=output, stderr=errors, text=True, start_new_session=True)
        save_json(self.directory / RUNNING, {"pass": self.n, "pid": self.process.pid, "session_id": self.session_id,
                                             "started_at": self.started_at, "trigger": self.trigger})

    def poll(self) -> str | None:
        """None while the job runs; `exited` once it ended; `timed_out` (its process group terminated) past the pass timeout."""
        if self.process.poll() is not None:
            return "exited"
        if self.clock() - self.started >= self.plan["sidecar"]["pass_timeout_seconds"]:
            terminate(self.process)
            return "timed_out"
        return None

    def stop(self) -> None:
        """Terminate the job's process group, recording nothing (the controller's interrupt path)."""
        if self.process is not None and self.process.poll() is None:
            terminate(self.process)

    def record(self, status: str, summary: str | None = None) -> None:
        """A pass that returned no output to merge: `failed`, `timed_out` or `interrupted`."""
        record = {"n": self.n, "trigger": self.trigger, "started_at": self.started_at, "finished_at": iso(self.clock()), "status": status,
                  "session_id": None, "lanes": self.lanes, "counts": {"new": 0, "changed": 0, "messages": 0},
                  "summary": summary[:4000] if summary else None}
        try:
            with ledger_lock(self.directory):
                ledger = load_ledger(self.directory, self.plan)
                if not any(item["n"] == self.n for item in ledger["passes"]):
                    ledger["passes"].append(record)
                    save_ledger(self.directory, ledger)
        finally:
            self.release()

    def release(self) -> None:
        if self.claimed:
            (self.directory / RUNNING).unlink(missing_ok=True)
            self.claimed = False

    def output(self) -> dict:
        stdout = self.directory / f"sidecar-{self.n}.stdout.json"
        try:
            result = read_json(stdout)
        except (OSError, ValueError):
            result = {}
        if not isinstance(result, dict):
            result = {}
        if (self.process.returncode != 0 or result.get("session_id") != self.session_id or result.get("is_error") is not False
                or result.get("subtype") != "success"):
            raise JobFailed(f"the print job did not succeed (exit {self.process.returncode}); inspect {stdout}")
        output = result.get("structured_output")
        from jsonschema.exceptions import ValidationError
        try:
            validate_output(output)
        except ValidationError as error:
            raise Rejected("schema", error.message) from None
        return output

    def settle(self, status: str) -> None:
        """The job ended (`exited`) or was stopped (`timed_out`): record it, merging and delivering a valid output."""
        if status == "timed_out":
            self.record("timed_out")
            self.event("interactive", f"{self.label} timed out after {self.plan['sidecar']['pass_timeout_seconds']}s; its job was stopped "
                                      "and the run continues without it")
            return
        try:
            output = self.output()
        except JobFailed as error:
            self.fail(error)
            return
        except Rejected as error:
            self.reject(error)
            return
        self.merge(output)

    def reject(self, error: Rejected) -> None:
        """A refused output: the ledger stays byte-identical; the reason goes to the pass's log and event."""
        try:
            log_error(self.log, "output rejected", error)
        finally:
            self.release()
        self.event("interactive", f"{self.label} output rejected ({error.reason}); the ledger is unchanged, see {self.log.name}")

    def fail(self, error: BaseException) -> None:
        """Any error of the pass: its job stopped, recorded `failed` with the error's type and text (log and summary), one event."""
        self.stop()
        try:
            log_error(self.log, "pass failed", error)
        except Exception:
            pass
        try:
            self.record("failed", f"failed: {type(error).__name__}: {error}")
        finally:
            self.event("interactive", f"{self.label} failed ({type(error).__name__}); the run continues without it, see {self.log.name}")

    def interrupt(self, why: str) -> None:
        self.stop()
        self.record("interrupted", f"interrupted: {why}")
        self.event("interactive", f"{self.label} interrupted: {why}; the run continues")

    def merge(self, output: dict) -> None:
        directory, plan = self.directory, self.plan
        at = iso(self.clock())
        record = {"n": self.n, "trigger": self.trigger, "started_at": self.started_at, "finished_at": at, "status": "completed",
                  "session_id": self.session_id, "lanes": self.lanes}
        with deferred_interrupt():  # A Ctrl-C waits for the write and for what it pages: recover() could not page it later.
            try:
                with ledger_lock(directory):
                    before = load_ledger(directory, plan)
                    merged, messages, escalations = merge(before, output, record, plan_workers(plan), at, lambda lane: refusal(directory, plan, lane))
                    save_ledger(directory, merged)  # Before anything is typed: a pane never holds an id the ledger does not.
            except Rejected as error:
                rejected = error
            else:
                rejected = None
                self.release()
                earlier = {finding["id"]: finding for finding in before["findings"]}
                blocking = {finding["id"]: finding for finding in merged["findings"] if became_blocking(earlier.get(finding["id"]), finding)}
                # Said and paged before anything is typed: a controller stopped while typing (a Ctrl-C, a kill) loses neither.
                for escalation in escalations:
                    self.event("interactive", f"escalation {escalation['finding_id']} ({escalation['kind']}): see the sidecar page")
                self.page(merged, blocking, messages, escalations)
        if rejected is not None:
            self.reject(rejected)
            return
        outcomes = self.deliver([message for message in messages if message["status"] == "pending"], blocking)
        counts = merged["passes"][-1]["counts"]
        resolved = sum(1 for upsert in output["findings"] if upsert["disposition"] == "verified_resolved")
        delivered = [message["lane"] for message in outcomes if message["status"] == "delivered"]
        refused = sum(1 for message in messages if message["status"] == "refused") + sum(1 for message in outcomes if message["status"] == "refused")
        undeliverable = sum(1 for message in outcomes if message["status"] == "undeliverable")
        self.event("running", f"{self.label}: {counts['new']} new finding(s), {counts['changed']} changed, {resolved} verified resolved; "
                              f"{len(delivered)} message(s) delivered" + (f" to {', '.join(delivered)}" if delivered else "")
                              + f", {refused} refused, {undeliverable} undeliverable")

    def page(self, merged: dict, blocking: dict, messages: list[dict], escalations: list[dict]) -> None:
        """Right after the merge write, before anything is typed: the operator's `sidecar` attention record of every escalation,
        and of every finding this pass made an open P0/P1 (`blocking`: new, raised or reopened) that no message of this pass can
        still deliver to its lane: each one there refused, or none sent. One with a message pending on its lane waits for that
        delivery, paged by page_outcome when it fails, or by recover() when the controller stops first. A delivered one is the
        lane's to act on."""
        for finding in blocking.values():
            tried = [message for message in messages if message["lane"] == finding["lane"] and finding["id"] in message["finding_ids"]]
            if not any(message["status"] == "pending" for message in tried):
                page_finding(self.directory, self.n, finding, f"{tried[-1]['status']}, {tried[-1]['reason']}" if tried else "no message to it")
        lanes = {finding["id"]: finding["lane"] for finding in merged["findings"]}
        for escalation in escalations:
            page_escalation(self.directory, escalation, lanes.get(escalation["finding_id"]))

    def page_outcome(self, message: dict, blocking: dict) -> None:
        """A pending message the ledger now records undelivered (refused at the gate, or undeliverable): each finding it carried
        on its lane that this pass made an open P0/P1, paged with that outcome."""
        for finding_id in message["finding_ids"]:
            finding = blocking.get(finding_id)
            if finding is not None and finding["lane"] == message["lane"]:
                page_finding(self.directory, self.n, finding, f"{message['status']}, {message['reason']}")

    def deliver(self, messages: list[dict], blocking: dict) -> list[dict]:
        """Each pending message in order: gated, typed or not, then flipped with one atomic write. Errors make it undeliverable.
        An outcome the ledger records undelivered pages at once (page_outcome), before the next message is tried."""
        outcomes = []
        for message in messages:
            try:
                status, reason = deliver_one(self.runtime, message, self.herdr)
                error = None
            except KeyboardInterrupt:
                raise  # It stays pending; the next controller makes it undeliverable (interrupted) and pages it (recover).
            except BaseException as caught:
                status, reason, error = "undeliverable", failure_reason(caught), caught
            with deferred_interrupt():  # A Ctrl-C waits for the flip and its page: the message is no longer pending for recover().
                try:
                    flip(self.directory, self.plan, message["id"], status, reason, iso(self.clock()))
                    recorded = True
                except KeyboardInterrupt:
                    raise
                except BaseException as caught:
                    error, recorded = error or caught, False
                if error is not None:
                    try:
                        log_error(self.log, f"message {message['id']} undeliverable", error)
                    except Exception:
                        pass
                    self.event("interactive", f"{self.label}: message {message['id']} to {message['lane']} undeliverable after an error "
                                              f"({type(error).__name__}); see {self.log.name}")
                outcomes.append({**message, "status": status, "reason": reason})
                if recorded and status != "delivered":
                    self.page_outcome(outcomes[-1], blocking)  # A flip that failed leaves it pending: recover() pages it, so never twice.
        return outcomes


# ---- Restart, freeze and the stopped run ---------------------------------------------------------------------------

def process_gone(pid: int) -> bool:
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0] == "Z"
    except (OSError, IndexError):
        return True


def job_running(pid, session_id) -> bool:
    """A live process with that pid whose command line holds the pass's session id: the pass's own job, not a reused pid."""
    if type(pid) is not int or pid <= 0 or not isinstance(session_id, str) or not session_id or process_gone(pid):
        return False
    try:
        command = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
    except OSError:
        return False
    return session_id in command


def kill_orphan(pid, session_id) -> bool:
    """Kill a pass's job left by a controller that is gone: only when that pid's command line holds the pass's session id."""
    if not job_running(pid, session_id):
        return False  # Gone, or the pid now belongs to another command.
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            if os.getpgid(pid) == pid:
                os.killpg(pid, sig)  # The job leads its own session (start_new_session).
            else:
                os.kill(pid, sig)
        except ProcessLookupError:
            return True
        for _ in range(50):
            if process_gone(pid):
                return True
            time.sleep(0.1)
    return True


def recover(runtime, clock=time.time) -> None:
    """A controller (re)starting: every `pending` message becomes `undeliverable` (interrupted), paging what its delivery would
    have (page_interrupted), and a pass left running is recorded `interrupted` after its orphaned job, if it still runs, is
    killed. Then the running marker is removed."""
    directory, plan = runtime.directory, runtime.plan
    marker = directory / RUNNING
    with deferred_interrupt():  # A Ctrl-C waits for the write and the pages it triggers: no message is pending any more.
        with ledger_lock(directory):
            path = ledger_path(directory)
            ledger = load_ledger(directory, plan)
            changed = False
            at = iso(clock())
            pending = [message for message in ledger["messages"] if message["status"] == "pending"]
            for message in pending:
                message.update(status="undeliverable", reason="interrupted", at=at)
                changed = True
            stale = None
            if marker.exists():
                try:
                    stale = read_json(marker)
                    n = int(stale["pass"])
                except (ValueError, KeyError, TypeError):
                    stale, n = None, None
                if stale is not None:
                    killed = kill_orphan(stale.get("pid"), stale.get("session_id"))
                    stale["killed"] = killed
                    if not any(item["n"] == n for item in ledger["passes"]):
                        lanes = {}
                        manifest = directory / INPUTS / str(n) / "manifest.json"
                        try:
                            for lane, item in read_json(manifest)["lanes"].items():
                                lanes[lane] = {"head_commit": item["head_commit"], "pane_captured": item["pane_file"] is not None}
                        except (OSError, ValueError, KeyError, TypeError):
                            lanes = {}
                        trigger = stale.get("trigger") if stale.get("trigger") in {"cadence", "completion", "final", "manual"} else "cadence"
                        started = stale.get("started_at") if isinstance(stale.get("started_at"), str) and stale["started_at"] else at
                        ledger["passes"].append({"n": n, "trigger": trigger, "started_at": started, "finished_at": at, "status": "interrupted",
                                                 "session_id": None, "lanes": lanes, "counts": {"new": 0, "changed": 0, "messages": 0},
                                                 "summary": "interrupted: the controller stopped while the pass ran"})
                        changed = True
                        stale["recorded"] = True
            if changed and (path.exists() or stale is not None):
                save_ledger(directory, ledger)
            marker.unlink(missing_ok=True)
        if pending:
            runtime.event(SIDECAR, "interactive", f"Review sidecar: {len(pending)} message(s) left pending by a stopped controller recorded "
                                                  f"undeliverable (interrupted): {', '.join(message['id'] for message in pending)}")
            page_interrupted(directory, ledger, pending)  # After the write: stopped before it, the next controller pages them; never twice.
        if stale is not None and stale.get("recorded"):
            runtime.event(SIDECAR, "interactive", f"Review sidecar pass {stale['pass']} recorded interrupted: the controller stopped while it ran"
                                                  + ("; its orphaned job was stopped" if stale["killed"] else ""))


def summary_line(ledger: dict) -> str:
    passes = ledger["passes"]
    unfinished = sum(1 for item in passes if item["status"] != "completed")
    open_findings = [finding for finding in ledger["findings"] if finding["disposition"] in OPEN]
    blocking = sum(1 for finding in open_findings if finding["severity"] in {"P0", "P1"})
    resolved = sum(1 for finding in ledger["findings"] if finding["disposition"] == "verified_resolved")
    delivered = sum(1 for message in ledger["messages"] if message["status"] == "delivered")
    return (f"{len(passes)} pass(es) ({unfinished} not completed), {len(open_findings)} open finding(s) ({blocking} P0/P1), "
            f"{resolved} verified resolved, {delivered} message(s) delivered")


def close(runtime, how: str, clock=time.time) -> None:
    """Close the ledger (`closed_at`) and the node (`succeeded`), once. Guarded: never raises into freeze or the error path."""
    if not has_sidecar(runtime.plan):
        return
    directory, plan = runtime.directory, runtime.plan
    try:
        if how == "stopped":
            recover(runtime, clock)
        with deferred_interrupt(), ledger_lock(directory):
            ledger = load_ledger(directory, plan)
            if ledger["closed_at"] is not None:
                return
            ledger["closed_at"] = iso(clock())
            save_ledger(directory, ledger)
        final = any(item["trigger"] == "final" for item in ledger["passes"])
        if how == "stopped":
            message = f"Review sidecar stopped with the run after {len(ledger['passes'])} pass(es): {summary_line(ledger)}"
        else:
            message = f"Review sidecar closed at freeze: {summary_line(ledger)}; " + ("final pass recorded" if final else "no final pass")
        runtime.event(SIDECAR, "succeeded", message)
    except KeyboardInterrupt:
        raise
    except BaseException as error:
        try:
            runtime.event(SIDECAR, "interactive", f"Review sidecar could not be closed ({type(error).__name__}); the run continues")
        except Exception:
            pass


# ---- Automatic mode: the scheduler inside wait_handoffs -------------------------------------------------------------

class Scheduler:
    """The sidecar beside `wait_handoffs`' 2-second poll (PRD 4.2). `tick` never raises (except KeyboardInterrupt)."""

    def __init__(self, runtime, workers: list[str], clock):
        self.runtime, self.workers, self.clock = runtime, list(workers), clock
        self.directory, self.plan = runtime.directory, runtime.plan
        self.current: Pass | None = None
        self.final_started = self.final_done = False
        self.last_end: float | None = None
        self.attempted = 0  # Passes started so far, rejected ones included: the budget counts them all.
        from .guardrails import deadline_met
        self.reviewed = {node for node in self.workers if deadline_met(self.directory, node)}  # Accepted before this controller.
        self.guard(self.restart, False)

    def restart(self) -> None:
        recover(self.runtime, self.clock)
        self.attempted = next_pass(self.directory, self.plan) - 1
        passes = load_ledger(self.directory, self.plan)["passes"]
        self.final_started = self.final_done = any(item["trigger"] == "final" and item["status"] != "interrupted" for item in passes)
        if passes:
            self.last_end = epoch(passes[-1]["finished_at"])

    def guard(self, action, done: bool) -> None:
        try:
            action()
        except KeyboardInterrupt:
            raise
        except BaseException as error:
            current, self.current = self.current, None
            if done or (current is not None and current.trigger == "final"):
                self.final_done = True  # Freeze never waits on a sidecar that failed.
            try:
                if current is None:
                    raise error
                current.fail(error)
            except KeyboardInterrupt:
                raise
            except BaseException:
                try:  # Recording the failure failed too: one event still says so.
                    self.runtime.event(SIDECAR, "interactive", f"Review sidecar step failed ({type(error).__name__}); the run continues without it")
                except KeyboardInterrupt:
                    raise
                except BaseException:
                    pass
            self.last_end = self.clock()

    def tick(self, rows, accepted: dict, done: bool) -> bool:
        """One poll. True when the handoffs may be saved: always while a lane works, and once the final pass is recorded."""
        self.guard(lambda: self.step(rows, accepted, done), done)
        return not done or self.final_done

    def step(self, rows, accepted: dict, done: bool) -> None:
        if self.current is not None:
            # The pass stays current until it is recorded, so an error while recording it records it `failed` (guard).
            if done and self.current.trigger != "final":
                self.current.interrupt("every lane's completion was accepted; the final pass runs instead")
                self.current = None
                self.last_end = self.clock()
            else:
                status = self.current.poll()
                if status is None:
                    return
                self.current.settle(status)
                current, self.current = self.current, None
                self.last_end = self.clock()
                if current.trigger == "final":
                    self.final_done = True
                return
        if done:
            if not self.final_started:
                self.final_started = True
                self.begin("final", rows=rows, accepted=accepted)
            elif not self.final_done and self.current is None:
                self.final_done = True
            return
        trigger = self.due(accepted)
        if trigger:
            self.begin(*trigger, rows=rows, accepted=accepted)

    def due(self, accepted: dict) -> tuple[str, str] | None:
        if self.final_started:
            return None
        if self.attempted >= self.plan["sidecar"]["max_passes"]:
            return None
        launched = [node for node in self.workers if (self.directory / f"{node}.interactive.json").exists()]
        from .guardrails import deadline_met
        if not [node for node in launched if node not in accepted and not deadline_met(self.directory, node)]:
            return None
        fresh = [node for node in self.workers if node in accepted and node not in self.reviewed]
        if fresh:
            return "completion", ", ".join(fresh)
        since = self.last_end
        if since is None:
            times = [datetime.fromisoformat(read_json(self.directory / f"{node}.interactive.json")["launch_requested_at"]).timestamp() for node in launched]
            since = min(times) if times else None
        if since is not None and self.clock() - since >= self.plan["sidecar"]["cadence_seconds"]:
            return "cadence", ""
        return None

    def begin(self, trigger: str, detail: str = "", *, rows=None, accepted=None) -> None:
        self.reviewed |= set(accepted or {})
        self.current = Pass(self.runtime, next_pass(self.directory, self.plan), trigger, self.clock, detail)
        self.attempted = self.current.n
        self.current.start(rows)

    def abandon(self) -> None:
        """wait_handoffs ends on an error or an interrupt: terminate the job's process group and record nothing (the marker stays)."""
        if self.current is not None:
            self.current.stop()
            self.current = None


# ---- CLI: python -m workflow sidecar-pass ---------------------------------------------------------------------------

def supervised(directory: Path) -> bool:
    """An automatic supervisor holds automatic-supervisor.lock: it owns the run's passes."""
    path = directory / SUPERVISOR_LOCK
    if not path.exists():
        return False
    with path.open("a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        fcntl.flock(handle, fcntl.LOCK_UN)
    return False


def run_pass(runtime, trigger: str, clock=time.time, sleep=time.sleep) -> dict | None:
    """One pass synchronously (manual mode, or debugging): the pass's ledger entry, None when it was rejected."""
    try:
        rows = runtime.sessions.inventory()
    except Exception:
        rows = None
    current = Pass(runtime, next_pass(runtime.directory, runtime.plan), trigger, clock)
    try:
        current.start(rows)
        while (status := current.poll()) is None:
            sleep(1)
        current.settle(status)
    except KeyboardInterrupt:
        current.stop()
        if current.claimed:
            current.interrupt("sidecar-pass was interrupted")
        raise
    except BaseException as error:
        current.fail(error)
    return next((item for item in load_ledger(runtime.directory, runtime.plan)["passes"] if item["n"] == current.n), None)


def pass_main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m workflow sidecar-pass", description="Run one review sidecar pass synchronously: "
                                     "a manual run's passes, its final pass before freeze (--final), or debugging an automatic run.")
    parser.add_argument("directory", type=Path)
    parser.add_argument("--final", action="store_true", help="The final pass: fills the ledger's handoff; run it before freeze")
    args = parser.parse_args(argv)
    directory = args.directory.resolve()
    try:
        plan = read_json(directory / "plan.json")
        if not has_sidecar(plan):
            raise ValueError("This run has no review sidecar (its feature declares no sidecar, or it was prepared before 2.3.0)")
        if supervised(directory):
            raise ValueError(f"An automatic supervisor owns this run ({SUPERVISOR_LOCK} is held) and runs its own passes")
        if closed(directory, plan):
            raise ValueError("The run is frozen: the sidecar is closed and no pass runs after freeze")
        marker = directory / RUNNING
        if marker.exists():
            item = read_json(marker)
            starting = item.get("pid") is None and time.time() - marker.stat().st_mtime < 60  # Claimed, its job not started yet.
            if starting or job_running(item.get("pid"), item.get("session_id")):
                raise ValueError(f"A sidecar pass is already running (pass {item.get('pass')}, {RUNNING})")
        from .pipeline import Pipeline
        runtime = Pipeline(directory)
        recover(runtime)
        ledger = load_ledger(directory, plan)
        if args.final and any(item["trigger"] == "final" and item["status"] != "interrupted" for item in ledger["passes"]):
            raise ValueError("The final pass is already recorded")
        if not args.final and next_pass(directory, plan) - 1 >= plan["sidecar"]["max_passes"]:
            raise ValueError(f"max_passes ({plan['sidecar']['max_passes']}) reached; only the final pass (--final) may run")
        try:
            record = run_pass(runtime, "final" if args.final else "manual")
        except KeyboardInterrupt:
            parser.exit(130, "Interrupted: the pass's job was stopped and the pass recorded interrupted.\n")
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Blocked: {error}\n")
    if record is None:
        parser.exit(1, f"The pass's output was rejected; the ledger is unchanged. See the sidecar events and {directory}/sidecar-*.stderr.log\n")
    print(f"Pass {record['n']} ({record['trigger']}) {record['status']}: {record['counts']['new']} new, {record['counts']['changed']} changed, "
          f"{record['counts']['messages']} message(s). Ledger: {ledger_path(directory)}")
    if record["status"] != "completed":
        parser.exit(1)
