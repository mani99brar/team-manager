"""The judge of a judged review panel (feature.json 2.11.0; features/review-panel-registry/prd.md 7.3-7.6, Appendix A; RUNBOOK
"Judged review panel (feature.json 2.11.0)").

After every built-in reviewer and every seat has finished, failed or timed out (automatic.py waits, then `panel.settle`), one
read-only Claude print job rules on every finding, whatever its source ([O7], [O9], [G9]): it groups findings by meaning,
checks each group against the candidate in its own throwaway worktree and gives it one ruling (`confirmed`, `refuted` or
`deferred`) and one severity. Its input (the brief `workflow/prompts/judge.md`, every finding with its id, then the diff and
the requirement documents) goes to stdin, never argv, capped at INPUT_CAP_BYTES. The code then checks the output: every input
finding id appears in exactly one ruling's sources, else the judge is `incomplete` ([G32]); a `refuted` ruling without
`path:line` evidence is recorded `confirmed` at its highest source severity; each ruling gets `J<n>` and the lane that owns its
file (`none` when no selected lane does). The judge object is written into `panel.json` through `panel.record_judge`
(`pending -> running -> judged | failed | timed_out | incomplete`). Any judge that does not end `judged` has `fallback: true`,
and the review step then decides by today's rule ([G10]).

`run` never raises except KeyboardInterrupt and TransientInfraError: on those it kills the job's process group, removes its
worktree and leaves the record `running`, so a resume reruns it; a terminal record is never rerun (automatic.judge_outcome).
"""
from __future__ import annotations

import json
import os
import re
import signal
import tempfile
import time
import uuid
from pathlib import Path

from .sessions import TransientInfraError, job_env, popen_claude, read_json, save_json, terminate

JUDGE = "judge"  # The reviewer id of the judge's review.json entry; reserved in sessions.validate_reviewer_id.
BRIEF = Path(__file__).resolve().parent / "prompts" / "judge.md"
DIR = "judge"  # `<run>/judge/`: each job's input, stdout, stderr and pid files; archived per fix-loop round with panel.json.
EFFORT = "high"  # Whatever the judges' pinned effort ([G9]).
DEFAULTS = {"timeout_minutes": 30, "budget_usd": 15, "input_cap_bytes": 600_000}  # [G22]
DETAIL_LIMIT = 2000  # Characters of one finding's detail (or a reviewer finding's message) in the input.
POLL_SECONDS = 1.0
TERMINAL = frozenset({"judged", "failed", "timed_out", "incomplete"})
RULINGS = ("confirmed", "refuted", "deferred")
SEVERITIES = ("P0", "P1", "P2")
FALLBACK = "the built-in reviewers' P0/P1 decided (today's rule) and the panel findings stay unjudged"
OVER_CAP = "judge input over the cap"
DIFF_LABEL = "the candidate diff (the run's base to the candidate)"
# A `path:line` citation: a path with a dot or a slash in it, a colon, a line number (`workflow/judge.py:88`, `a.ts:3-9`).
CITATION = re.compile(r"[\w@+~-]*[./][\w@+~./-]*:\d+")
NO_FILE = "(no file)"  # panel.NO_FILE: a seat finding returned without a file.


class OverCap(ValueError):
    """The brief and the findings alone exceed the input cap: the judge does not run (PRD 7.3)."""


def judged(plan: dict) -> dict | None:
    """The plan's judged panel: its one `plan.panels` item with `report_only: false`; None for every other plan (no panels,
    report-only panels only, a plan pinned before panels)."""
    items = plan.get("panels") if isinstance(plan, dict) else None
    if not isinstance(items, list):
        return None
    return next((item for item in items if isinstance(item, dict) and item.get("report_only") is False), None)


def settings(item: dict, plan: dict) -> dict:
    """The judge's pinned settings, `{model, effort, timeout_minutes, budget_usd, input_cap_bytes}`: the plan item's `judge`
    (PRD Appendix B, plan-panel-judged), each default filled in; the model falls back to the judges' pinned model."""
    pinned = item.get("judge") if isinstance(item.get("judge"), dict) else {}
    roles = plan.get("roles") if isinstance(plan.get("roles"), dict) else {}
    model = pinned.get("model") or (roles.get("judges") or {}).get("model")
    return {"model": model, "effort": EFFORT, **{key: pinned.get(key) or value for key, value in DEFAULTS.items()}}


def pending(item: dict, plan: dict) -> dict:
    """The `pending` judge object of PRD Appendix B (judge-states), with the pinned model."""
    return {"status": "pending", "fallback": False, "model": settings(item, plan)["model"], "effort": EFFORT, "session_id": None,
            "started_at": None, "ended_at": None, "cost_usd": None, "error": None, "inputs": [], "reviewer_findings": [], "rulings": []}


def current(directory: Path, panel_id: str) -> dict | None:
    """The judge object `panel.json` holds for panel `panel_id`; None without one (or without a readable record)."""
    try:
        record = read_json(Path(directory) / "panel.json")
    except (OSError, ValueError):
        return None
    for entry in record.get("panels") or [] if isinstance(record, dict) else []:
        if isinstance(entry, dict) and entry.get("id") == panel_id and isinstance(entry.get("judge"), dict):
            return entry["judge"]
    return None


def iso(timestamp: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(timestamp))


def clip(text, limit: int = DETAIL_LIMIT) -> str:
    text = "" if text is None else str(text)
    return text if len(text) <= limit else text[:limit - 1] + "…"


# ---- The input -------------------------------------------------------------------------------------------------------

def gather(reviewers: dict, seats: list[dict]) -> tuple[list[dict], list[dict], list[dict]]:
    """(`inputs`, `reviewer_findings`, `entries`) for the judge object and its input.

    `reviewers` maps each built-in reviewer id, in declared order, to `{status, findings}` (status: its derived verdict, or
    `timed_out`/`error` for one without a verdict); its findings get ids `<reviewer_id>-<n>` in review order. `seats` are
    `panel.settle`'s terminal provider records, each with its findings (`id`, `severity`, `file`, `line`, `title`, `detail`),
    whose ids the seat lane assigned (`<prefix><n>`). Every source is an input, with or without findings."""
    inputs, reviewer_findings, entries = [], [], []
    for reviewer_id, item in reviewers.items():
        ids = []
        for n, finding in enumerate(item.get("findings") or [], 1):
            finding_id = f"{reviewer_id}-{n}"
            ids.append(finding_id)
            reviewer_findings.append({"id": finding_id, "reviewer": reviewer_id, "severity": finding["severity"],
                                      "worker": finding.get("worker"), "message": clip(finding["message"])})
            entries.append({"id": finding_id, "source": reviewer_id, "kind": "reviewer", "severity": finding["severity"],
                            "worker": finding.get("worker"), "requirement": finding.get("requirement"),
                            "disposition": finding.get("disposition"), "message": clip(finding["message"])})
        inputs.append({"source": reviewer_id, "kind": "reviewer", "status": item["status"], "finding_ids": ids})
    for seat in seats:
        ids = []
        for finding in seat.get("findings") or []:
            ids.append(finding["id"])
            entries.append({"id": finding["id"], "source": seat["name"], "kind": "seat", "severity": finding["severity"],
                            "file": finding.get("file"), "line": finding.get("line"), "title": finding.get("title"),
                            "detail": clip(finding.get("detail"))})
        inputs.append({"source": seat["name"], "kind": "seat", "status": seat.get("status"), "finding_ids": ids})
    return inputs, reviewer_findings, entries


def documents(runtime, item: dict) -> list[tuple[str, str]]:
    """(label, text) of the material after the findings: the candidate diff (labelled DIFF_LABEL), the pinned PRD copy,
    decisions.md and the panel's pinned requirement documents (the seats' requirement sections, PRD 5.2), each once."""
    from .guardrails import decisions_text
    directory, plan = Path(runtime.directory), runtime.plan
    found = []
    diff = directory / "review.diff"
    if diff.is_file():
        found.append((DIFF_LABEL, diff.read_text(errors="replace")))
    prd = plan.get("prd")
    if isinstance(prd, dict) and isinstance(prd.get("copy"), str):
        try:
            found.append((f"the PRD, {item.get('prd_label') or prd.get('path') or 'prd.md'}", (directory / prd["copy"]).read_text(errors="replace")))
        except OSError:
            pass
    decisions = decisions_text(plan)
    if decisions:
        found.append(("decisions.md", decisions))
    seen = {text for _, text in found}
    for rel, text in (item.get("requirement_docs") or {}).items():
        if isinstance(text, str) and text not in seen:
            found.append((f"requirement document {rel}", text))
            seen.add(text)
    return found


def section(label: str, text: str) -> str:
    return f"\n=== {label} ===\n{text.rstrip()}\n"


def size_of(text: str) -> int:
    return len(text.encode())


def omitted(label: str, text: str) -> str:
    return f"\n=== omitted: {label}, {size_of(text)} bytes, over the input cap ===\n"


def fit(docs: list[tuple[str, str]], room: int) -> list[str]:
    """The blocks of `docs`, in order, within `room` bytes: each whole when it fits, else cut at its tail with a
    `=== truncated: kept <k> of <n> bytes of <label> ===` note, else named by an `=== omitted: <label>, <n> bytes ... ===`
    line. Room for every later document (whole, or its omitted line when that is shorter) is held back, so no document
    disappears unnamed."""
    blocks, used = [], 0
    for index, (label, text) in enumerate(docs):
        avail = room - used - sum(min(size_of(section(*later)), size_of(omitted(*later))) for later in docs[index + 1:])
        block = section(label, text)
        if size_of(block) > avail:
            where = "; the candidate's files are in your worktree" if label == DIFF_LABEL else ""
            note = lambda kept: f"\n=== truncated: kept {kept} of {size_of(text)} bytes of {label}{where} ===\n"  # noqa: E731
            keep = avail - size_of(section(label, "")) - size_of(note(size_of(text)))
            if keep > 0:
                kept = text.encode()[:keep].decode(errors="ignore")
                block = section(label, kept) + note(size_of(kept))
            else:
                block = omitted(label, text)
                if size_of(block) > avail:
                    continue  # Only when the room cannot hold even the names.
        blocks.append(block)
        used += size_of(block)
    return blocks


def build_input(runtime, item: dict, entries: list[dict], cap: int) -> str:
    """The judge's stdin: the brief, every finding (one JSON object per line), then the documents, cut to fit `cap` bytes.
    OverCap when the brief and the findings alone exceed it: the documents are cut, the findings never are. Over the cap,
    the requirements (PRD, decisions.md, requirement documents: pinned, so not in the judge's worktree) keep at least half
    the room left after the findings, or all the room the diff leaves, so a large diff never costs them everything."""
    head = (BRIEF.read_text().rstrip() + "\n" + section(f"FINDINGS ({len(entries)}; rule on every id exactly once)",
                                                        "\n".join(json.dumps(entry, ensure_ascii=False) for entry in entries) or "(none)"))
    size = size_of(head)
    if size > cap:
        raise OverCap(f"{OVER_CAP}: the brief and the findings are {size} bytes, the cap is {cap}")
    room = cap - size
    found = documents(runtime, item)
    diff = [doc for doc in found if doc[0] == DIFF_LABEL]
    requirements = [doc for doc in found if doc[0] != DIFF_LABEL]
    diff_size = sum(size_of(section(*doc)) for doc in diff)
    wanted = sum(size_of(section(*doc)) for doc in requirements)
    kept = fit(requirements, min(wanted, max(room // 2, room - diff_size)) if diff_size + wanted > room else room)
    return "".join([head, *fit(diff, room - sum(size_of(block) for block in kept)), *kept])


# ---- The job ---------------------------------------------------------------------------------------------------------

def output_schema() -> dict:
    """The job's `--json-schema` (an object root, which Claude Code requires): examples/judge-output.example.json's shape."""
    nullable = lambda kind, **more: {"type": [kind, "null"], **more}  # noqa: E731
    ruling = {"type": "object", "additionalProperties": False,
              "required": ["ruling", "severity", "sources", "file", "line", "title", "detail", "requirement", "reason", "evidence"],
              "properties": {"ruling": {"enum": list(RULINGS)}, "severity": {"enum": list(SEVERITIES)},
                             "sources": {"type": "array", "minItems": 1, "items": {"type": "string", "minLength": 1}},
                             "file": nullable("string"), "line": nullable("integer", minimum=1),
                             "title": {"type": "string", "minLength": 1}, "detail": {"type": "string"},
                             "requirement": nullable("string"), "reason": {"type": "string", "minLength": 1}, "evidence": {"type": "string"}}}
    return {"type": "object", "additionalProperties": False, "required": ["rulings"],
            "properties": {"rulings": {"type": "array", "items": ruling}}}


def command(executable: str, session_id: str, model: str | None, budget_usd) -> list[str]:
    """One read-only print job (automatic.print_command: Read, Glob and Grep, --safe-mode, no MCP, dontAsk) at effort high with
    the pinned model and a dollar cap; no --add-dir (its cwd is its own worktree) and no prompt (stdin)."""
    from .automatic import print_command
    pins = [*(["--model", model] if model else []), "--effort", EFFORT]
    base = print_command(executable, session_id, output_schema(), [], pins)
    return base[:-2] + ["--max-budget-usd", str(budget_usd)] + base[-2:]  # Before the trailing --json-schema <schema>.


def executable(runtime) -> str:
    sessions = getattr(runtime, "sessions", None)
    return getattr(sessions, "executable", None) or os.environ.get("WORKFLOW_CLAUDE", "claude")


def kill_orphan(directory: Path, repository: str) -> None:
    """A judge job a crashed controller left behind: the latest `judge-<n>.pid` names its worktree, cwd and session marker
    before the worktree or the job exists, and its pid once launched. Every process that still runs with that cwd and marker
    (the recorded pid, or any found in /proc when a crash came before the pid was written) is terminated with its whole group,
    and the recorded worktree is removed, before a rerun starts."""
    folder = Path(directory) / DIR
    pids = sorted(folder.glob("judge-*.pid"), key=lambda path: int(re.sub(r"\D", "", path.stem) or 0)) if folder.exists() else []
    if not pids:
        return
    try:
        info = read_json(pids[-1])
    except (OSError, ValueError):
        return
    pid, cwd, marker = info.get("pid"), info.get("cwd"), info.get("marker")
    if marker and cwd:
        found = [pid] if isinstance(pid, int) and pid > 0 else []
        found += [int(entry.name) for entry in Path("/proc").iterdir() if entry.name.isdigit() and int(entry.name) not in found]
        for candidate in found:
            if candidate == os.getpid() or not runs(candidate, cwd, marker):
                continue
            try:
                group = os.getpgid(candidate)
            except ProcessLookupError:
                continue
            for sig in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.killpg(group, sig)
                except (ProcessLookupError, PermissionError):
                    break
                time.sleep(0.5)
    if info.get("worktree"):
        remove_worktree(repository, Path(info["worktree"]))


def kill_group(process) -> None:
    """SIGKILL whatever is left in the judge job's process group once its leader is stopped (PRD 7.6): a member that ignored
    SIGTERM never outlives the job or has its worktree removed under it (panel._kill_group's rule)."""
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def runs(pid: int, cwd: str, marker: str) -> bool:
    """Whether process `pid` runs with cwd `cwd` and `marker` (`--session-id <uuid>`) in its command line."""
    try:
        line = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
        return marker in line and os.readlink(f"/proc/{pid}/cwd") == cwd
    except OSError:
        return False


def remove_worktree(repository: str, worktree: Path) -> None:
    """`git worktree remove --force` then `prune`, whatever each says (lane_review._remove_worktree's rule)."""
    from .worktrees import git_worktree
    for args in (("remove", "--force", str(worktree)), ("prune",)):
        try:
            if args[0] == "prune" or worktree.exists():
                git_worktree(repository, *args)
        except Exception:  # noqa: BLE001 - a stale worktree is pruned whatever remove said.
            pass
    if worktree.exists():
        import shutil
        shutil.rmtree(worktree, ignore_errors=True)


def next_number(folder: Path) -> int:
    found = [int(match.group(1)) for path in folder.glob("judge-*.pid") if (match := re.fullmatch(r"judge-(\d+)\.pid", path.name))]
    return max(found, default=0) + 1


# ---- The output checks -----------------------------------------------------------------------------------------------

def cites(evidence) -> bool:
    return isinstance(evidence, str) and CITATION.search(evidence) is not None


def worker_of(runtime):
    """The lane whose owned paths own a file (verification.owns), among the run's selected lanes; `none` for no file, the
    seats' `(no file)` placeholder, or a file no selected lane owns."""
    from .automatic import lane_paths, lanes
    from .verification import owns
    owners = []
    try:
        for lane in lanes(runtime):
            owners += [(lane, str(path).rstrip("/")) for path in lane_paths(runtime, lane)]
    except Exception:  # noqa: BLE001 - a run without a readable policy attributes nothing.
        owners = []

    def lane(file) -> str:
        if not isinstance(file, str) or not file.strip() or file == NO_FILE:
            return "none"
        path = file.strip()
        while path.startswith("./"):
            path = path[2:]
        return next((name for name, prefix in owners if owns(path, prefix)), "none")
    return lane


def check(raw: list[dict], entries: list[dict], lane) -> tuple[list[dict], str | None]:
    """(the recorded rulings, None), or ([], the reason) when the rulings do not account for every input id exactly once."""
    ids = [entry["id"] for entry in entries]
    counts: dict[str, int] = {}
    for ruling in raw:
        for source in ruling["sources"]:
            counts[source] = counts.get(source, 0) + 1
    problems = []
    for words, found in (("missing from the rulings", [i for i in ids if i not in counts]),
                         ("in more than one ruling", [i for i in ids if counts.get(i, 0) > 1]),
                         ("unknown to the input", [i for i in counts if i not in set(ids)])):
        if found:
            problems.append(f"source ids {words}: {', '.join(found)}")
    if problems:
        return [], "judge output incomplete: " + "; ".join(problems)
    severity = {entry["id"]: entry["severity"] for entry in entries}
    rulings = []
    for n, item in enumerate(raw, 1):
        ruling = {"id": f"J{n}", "ruling": item["ruling"], "severity": item["severity"], "sources": list(item["sources"]),
                  "file": item["file"], "line": item["line"], "title": item["title"], "detail": item["detail"],
                  "requirement": item["requirement"], "worker": lane(item["file"]), "reason": item["reason"], "evidence": item["evidence"]}
        if ruling["ruling"] == "refuted" and not cites(ruling["evidence"]):
            # The evidence rule (PRD 7.3): a dismissal must show the code; one that does not stands as the sources said.
            ruling.update(ruling="confirmed", severity=min((severity[source] for source in ruling["sources"]), key=SEVERITIES.index),
                          reason=f"{ruling['reason']} (recorded confirmed: a refuted ruling must cite path:line evidence)")
        rulings.append(ruling)
    return rulings, None


# ---- The run ---------------------------------------------------------------------------------------------------------

def record(runtime, panel_id: str, judge: dict) -> str | None:
    """Write the judge object through the seats lane's port; the error text when it refuses (never raised)."""
    from . import panel
    try:
        panel.record_judge(runtime, panel_id, judge)
    except (KeyboardInterrupt, TransientInfraError):
        raise
    except Exception as error:  # noqa: BLE001 - a refused record makes the judge fail, never the review step.
        return f"{type(error).__name__}: {error}"
    return None


def unjudged(runtime, panel_item: dict, reviewers: dict, error: str, *, clock=time.time) -> dict:
    """A judge that could not start because the seats could not be settled (`panel.settle` raised): `failed`, fallback, the
    built-in reviewers as its only inputs; recorded when the port accepts it, returned either way."""
    inputs, reviewer_findings, _ = gather(reviewers, [])
    at = iso(clock())
    judge = {**pending(panel_item, runtime.plan), "status": "failed", "fallback": True, "started_at": at, "ended_at": at,
             "error": clip(f"{error}; {FALLBACK}", 4000), "inputs": inputs, "reviewer_findings": reviewer_findings}
    record(runtime, panel_item["id"], judge)
    return judge


def run(runtime, panel_item: dict, seats: list[dict], reviewers: dict, *, clock=time.time, sleep=time.sleep) -> dict:
    """One judge job over every finding (PRD 7.3); returns the terminal judge object, also recorded via panel.record_judge."""
    directory = Path(runtime.directory)
    pinned = settings(panel_item, runtime.plan)
    inputs, reviewer_findings, entries = gather(reviewers, seats)
    judge = {**pending(panel_item, runtime.plan), "inputs": inputs, "reviewer_findings": reviewer_findings}
    panel_id = panel_item["id"]

    def end(status: str, error: str | None = None, rulings: list | None = None) -> dict:
        judge.update(status=status, fallback=status != "judged", ended_at=iso(clock()), rulings=rulings or [],
                     error=None if error is None else clip(f"{error}; {FALLBACK}" if status != "judged" else error, 4000))
        refused = record(runtime, panel_id, judge)
        if refused and status == "judged":  # The rulings cannot be kept: today's rule decides, as for any failed judge.
            judge.update(status="failed", fallback=True, rulings=[], error=clip(f"judge record refused: {refused}; {FALLBACK}", 4000))
            record(runtime, panel_id, judge)
        return judge

    repository = runtime.plan["repository"]
    folder = directory / DIR
    worktree = process = None
    try:
        folder.mkdir(exist_ok=True)
        kill_orphan(directory, repository)
        try:
            text = build_input(runtime, panel_item, entries, pinned["input_cap_bytes"])
        except OverCap as error:
            judge["started_at"] = iso(clock())
            return end("failed", str(error))
        session_id = str(uuid.uuid4())
        judge.update(status="running", session_id=session_id, started_at=iso(clock()))
        refused = record(runtime, panel_id, judge)
        if refused:
            return end("failed", f"judge record refused: {refused}")
        number = next_number(folder)
        stem = folder / f"judge-{number}"
        input_path = stem.with_suffix(".input.txt")
        input_path.write_text(text)
        os.chmod(input_path, 0o600)
        candidate = read_json(directory / "review-bundle.json")["candidate_commit"]
        from .worktrees import git_worktree
        worktree = Path(tempfile.mkdtemp(prefix="review-judge-"))  # Outside ~/dev and the run directory; removed in the finally.
        # Persisted before the worktree and the job exist: a crash from here on leaves kill_orphan the worktree and the marker.
        tracked = {"pid": None, "cwd": str(worktree.resolve()), "marker": f"--session-id {session_id}", "worktree": str(worktree.resolve())}
        save_json(stem.with_suffix(".pid"), tracked)
        git_worktree(repository, "add", "--detach", str(worktree), candidate)
        stdout = stem.with_suffix(".stdout.json")
        with input_path.open() as stdin, stdout.open("w") as out, stem.with_suffix(".stderr.log").open("w") as err:
            process = popen_claude(command(executable(runtime), session_id, pinned["model"], pinned["budget_usd"]), cwd=str(worktree),
                                   env=job_env(), stdin=stdin, stdout=out, stderr=err, text=True, start_new_session=True)
        save_json(stem.with_suffix(".pid"), {**tracked, "pid": process.pid})
        started, limit = clock(), pinned["timeout_minutes"] * 60
        while process.poll() is None:
            if clock() - started >= limit:
                terminate(process)
                # Killed at its deadline, the job reported neither its session nor its cost (examples/panel-fallback).
                judge.update(session_id=None, cost_usd=cost(stdout))
                return end("timed_out", f"judge timed out after {pinned['timeout_minutes']} minutes")
            sleep(POLL_SECONDS)
        judge["cost_usd"] = cost(stdout)
        try:
            result = read_json(stdout)
        except (OSError, ValueError) as error:
            return end("failed", f"judge job failed (exit {process.returncode}): its output is not JSON ({error})")
        if (process.returncode != 0 or not isinstance(result, dict) or result.get("session_id") != session_id
                or result.get("is_error") is not False or result.get("subtype") != "success"):
            return end("failed", f"judge job failed (exit {process.returncode}, subtype {result.get('subtype') if isinstance(result, dict) else None!r})")
        from jsonschema import ValidationError, validate
        output = result.get("structured_output")
        try:
            validate(output, output_schema())
        except ValidationError as error:
            return end("incomplete", f"judge output malformed: {error.message}")
        rulings, problem = check(output["rulings"], entries, worker_of(runtime))
        if problem:
            return end("incomplete", problem)
        return end("judged", rulings=rulings)
    except (KeyboardInterrupt, TransientInfraError):
        if process is not None and process.poll() is None:
            terminate(process)
        raise  # The record stays non-terminal (pending or running): a resume reruns the judge.
    except Exception as error:  # noqa: BLE001 - every other failure is the judge's, never the review step's.
        if process is not None and process.poll() is None:
            terminate(process)
        if judge["started_at"] is None:
            judge["started_at"] = iso(clock())
        return end("failed", f"judge failed: {type(error).__name__}: {error}")
    finally:
        if process is not None and process.poll() is None:
            terminate(process)
        if process is not None:
            kill_group(process)
        if worktree is not None:
            remove_worktree(repository, worktree)


def cost(stdout: Path) -> float | None:
    try:
        value = read_json(stdout).get("total_cost_usd")
    except (OSError, ValueError, AttributeError):
        return None
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


# ---- review.json (PRD 7.4) -------------------------------------------------------------------------------------------

def confirmed(judge: dict) -> list[dict]:
    return [ruling for ruling in judge.get("rulings") or [] if ruling.get("ruling") == "confirmed"]


def verdict(judge: dict) -> str:
    """The judge entry's verdict: blocked when any confirmed ruling is P0 or P1."""
    return "blocked" if any(ruling["severity"] in ("P0", "P1") for ruling in confirmed(judge)) else "approved"


def message(ruling: dict) -> str:
    """`[J<n> from <source ids>] <title> (<file>:<line>): <detail>`; the place is `(<file>)` without a line and absent
    without a file."""
    file, line = ruling.get("file"), ruling.get("line")
    place = "" if not file or file == NO_FILE else f" ({file}:{line})" if line is not None else f" ({file})"
    return f"[{ruling['id']} from {', '.join(ruling['sources'])}] {ruling['title']}{place}: {ruling['detail']}"


def review_findings(judge: dict) -> list[dict]:
    """review.json's findings from the judge: the confirmed rulings only, each `reviewer: judge` with its lane, open."""
    findings = []
    for ruling in confirmed(judge):
        finding = {"severity": ruling["severity"], "message": message(ruling), "disposition": "open", "worker": ruling["worker"]}
        if ruling.get("requirement"):
            finding["requirement"] = ruling["requirement"]
        finding["reviewer"] = JUDGE
        findings.append(finding)
    return findings
