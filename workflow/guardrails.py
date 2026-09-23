"""The guardrails of feature.json 2.2.0 (docs/PRD_PORTABLE_WORKFLOW.md sections 2 and 4.3 to 4.6).

- Outcome briefs: every lane task has non-empty `## Goal`, `## Acceptance` and `## Stop` sections.
- Decisions: the feature directory holds a non-empty `decisions.md` (written by the `workflow-grill` skill); it is
  pinned into the plan and every worker and reviewer prompt includes it after the task.
- Design challenge: one read-only `claude --print` job reads the pinned PRD, tasks and decisions before any worker
  starts and writes `challenge.json`. It runs inside `start` and `resume`, outside the LangGraph graph (it must decide
  before any worker session exists, and it pauses and resumes on its own); the export shows it as the first node.
  A P0 or P1 concern pauses the run; `resume` commits the edited feature files on the run's branch, moves the run to
  that commit, re-pins them and reruns it, `resume --accept-challenge <reason>` records an override.
- Completion 1.1.0 and questions: a worker may end its turn with status `question`; its deadline pauses (persisted
  in `<node>.deadline.json`) until `answer` records the reply and types it into the worker's pane. A delivery that
  fails leaves the answer recorded but undelivered; rerunning `answer` delivers it, once.

2.0.0 and 2.1.0 features, and every run prepared before this slice, carry none of the plan keys read here and
behave exactly as before.
"""
from __future__ import annotations

import argparse
import copy
import fcntl
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from .checks import now
from .sessions import git, plan_workers, read_json, run_lock, save_json, terminate
from .verification import CONTRACTS, validate_schema

GUARDED_VERSION = "2.2.0"
REQUIRED_HEADINGS = ("Goal", "Acceptance", "Stop")
DECISIONS = "decisions.md"
COMPLETION_VERSION = "1.1.0"
LEGACY_COMPLETION_VERSION = "1.0.0"
MAX_QUESTIONS = 3
CHALLENGE = "challenge"
BLOCKING = frozenset({"P0", "P1"})
DEFAULT_CHALLENGE_TIMEOUT = 1800
CHALLENGE_SCHEMA = CONTRACTS / "challenge.schema.json"
REVISION_INTENT = "challenge-revision.json"  # `resume` is moving the run to revised feature files; see commit_revision.
UNFINISHED_REVISION = f"An interrupted resume has not finished moving this run to the revised feature files ({REVISION_INTENT})"
MIGRATION_NOTE = ("feature.json {version}: no guardrail is enforced (outcome-brief headings, decisions.md, design challenge, "
                  "completion evidence). To migrate, set \"version\": \"2.2.0\", give every task non-empty ## Goal, ## Acceptance "
                  "and ## Stop sections, and write decisions.md with the workflow-grill skill (workflow/README.md).")


# ---- Outcome briefs and decisions (launch and prepare) -------------------------------------------------------

def sections(text: str) -> dict[str, str]:
    """The level-2 sections of a Markdown text by heading, each with its body up to the next `## ` heading.

    Lines inside fenced code blocks are body text, never headings.
    """
    found: dict[str, list[str]] = {}
    current = None
    fence = None
    for line in text.splitlines():
        stripped = line.strip()
        marker = re.match(r"(`{3,}|~{3,})", stripped)
        if marker and (fence is None or marker.group(1)[0] == fence[0] and len(marker.group(1)) >= len(fence)):
            fence = None if fence else marker.group(1)
        elif fence is None and re.match(r"## \S", line):
            current = line[3:].strip().rstrip("#").strip()
            found.setdefault(current, [])
            continue
        if current is not None:
            found[current].append(line)
    return {heading: "\n".join(lines) for heading, lines in found.items()}


def brief_problems(text: str) -> list[str]:
    """`missing ## Stop`, `empty ## Acceptance`, ...: a required heading needs at least one non-blank line before the next `## `."""
    found = sections(text)
    problems = []
    for heading in REQUIRED_HEADINGS:
        if heading not in found:
            problems.append(f"missing ## {heading}")
        elif not found[heading].strip():
            problems.append(f"empty ## {heading}")
    return problems


def stop_rule(text: str) -> str | None:
    """The body of the task's `## Stop` section, which the worker prompt repeats as its bound."""
    body = sections(text).get("Stop", "").strip()
    return body or None


def is_guarded(manifest: dict) -> bool:
    return manifest.get("version") == GUARDED_VERSION


def migration_note(manifest: dict) -> str | None:
    """The note a launch of a feature before 2.2.0 prints; None for a guarded feature."""
    return None if is_guarded(manifest) else MIGRATION_NOTE.format(version=manifest.get("version"))


def prd_path(target: Path, value: str) -> Path:
    """The feature's `prd` inside the target; refused when it escapes the target or does not exist."""
    path = (target / value).resolve()
    if not path.is_relative_to(target.resolve()) or not path.is_file():
        raise ValueError(f"prd {value!r} does not exist in the target {target}")
    return path


def refusals(target: Path, folder: Path, manifest: dict, tasks: dict[str, Path]) -> list[str]:
    """Every reason a 2.2.0 feature may not launch; empty for a feature before 2.2.0."""
    if not is_guarded(manifest):
        return []
    found = []
    for path in tasks.values():
        problems = brief_problems(path.read_text())
        if problems:
            found.append(f"{os.path.relpath(path, folder)}: {', '.join(problems)} (an outcome brief needs non-empty ## Goal, ## Acceptance and ## Stop)")
    decisions = folder / DECISIONS
    if decisions.is_symlink() or not decisions.is_file() or not decisions.read_text().strip():
        found.append(f"{DECISIONS} is missing or empty: interview the operator with the workflow-grill skill, which writes it")
    if "prd" in manifest:
        try:
            prd_path(target, manifest["prd"])
        except ValueError as error:
            found.append(str(error))
    return found


def pinned_task(text: str, worker: dict) -> str:
    """A lane's task as the plan pins it: the authored text plus the approved ownership and checks."""
    return text + "\nApproved ownership and checks:\n" + json.dumps(worker)


def pin_guardrails(plan: dict, directory: Path, task_files: dict[str, Path], decisions: Path, prd: Path | None, challenge: bool) -> None:
    """The plan keys of a 2.2.0 run: the completion version, the challenge flag, decisions.md, the PRD copy and the task paths."""
    text = decisions.read_text()
    if not text.strip():
        raise ValueError(f"{decisions} is empty")
    plan.update(feature_version=GUARDED_VERSION, completion_version=COMPLETION_VERSION, challenge=challenge,
                decisions={"path": str(decisions.resolve()), "text": text},
                prd=pin_prd(directory, prd) if prd else None,
                task_files={node: str(path.resolve()) for node, path in task_files.items()})


def pin_prd(directory: Path, source: Path) -> dict:
    """Copy the PRD (any format the challenge can Read, PDFs included) into the run's challenge inputs; the plan keeps its hash."""
    if not source.is_file():
        raise ValueError(f"PRD {source} does not exist")
    inputs = directory / "challenge-inputs"
    inputs.mkdir(mode=0o700, exist_ok=True)
    copy_path = inputs / ("prd" + "".join(source.suffixes[-1:]))
    temporary = copy_path.with_name(f".{copy_path.name}.{uuid.uuid4()}.tmp")
    shutil.copyfile(source, temporary)
    os.chmod(temporary, 0o600)
    os.replace(temporary, copy_path)
    return {"path": str(source.resolve()), "copy": str(copy_path.relative_to(directory)), "sha256": digest_bytes(copy_path.read_bytes())}


def completion_version(plan: dict) -> str:
    """1.1.0 for runs prepared from a 2.2.0 feature; every other run (all runs before slice 2 included) reads 1.0.0."""
    return plan.get("completion_version", LEGACY_COMPLETION_VERSION)


def decisions_text(plan: dict) -> str | None:
    decisions = plan.get("decisions")
    return decisions.get("text") if isinstance(decisions, dict) and isinstance(decisions.get("text"), str) else None


def decisions_block(plan: dict) -> str:
    """What every worker and reviewer prompt appends after the task; empty for runs without decisions."""
    text = decisions_text(plan)
    return "" if text is None else "\n\nDecisions recorded before launch (decisions.md; they bind this run):\n" + text.rstrip() + "\n"


def has_challenge(plan: dict) -> bool:
    """The run's graph starts with the challenge node: a 2.2.0 run whose feature did not set `challenge: false`."""
    return plan.get("challenge") is True


# ---- Design challenge ----------------------------------------------------------------------------------------

def digest_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def pinned_digests(directory: Path, plan: dict) -> dict:
    tasks = {node: plan["nodes"][node]["task"] for node in plan_workers(plan)}
    prd = plan.get("prd")
    return {"tasks_sha256": digest_bytes(json.dumps(tasks, sort_keys=True, ensure_ascii=False).encode()),
            "decisions_sha256": digest_bytes((decisions_text(plan) or "").encode()),
            "prd_sha256": digest_bytes((directory / prd["copy"]).read_bytes()) if prd else None}


def challenge_schema() -> dict:
    return json.loads(CHALLENGE_SCHEMA.read_text())


def output_schema() -> dict:
    """The job's `--json-schema`: the schema's `output` with the concern inlined (the CLI takes one self-contained schema)."""
    defs = challenge_schema()["$defs"]
    output = copy.deepcopy(defs["output"])
    output.pop("description", None)
    output["properties"]["concerns"]["items"] = copy.deepcopy(defs["concern"])
    return output


def validate_output(value) -> None:
    from jsonschema import Draft202012Validator
    Draft202012Validator({"$defs": challenge_schema()["$defs"], "$ref": "#/$defs/output"}).validate(value)


def challenge_prompt(directory: Path, plan: dict) -> str:
    prd = plan.get("prd")
    parts = ["You are the design challenge of a workflow run: a skeptical senior engineer who reads the plan before any worker "
             "starts. You only read; you change nothing and launch nothing. Your working directory is the repository at the "
             "run's base commit; read its code when a concern depends on it.\n\n"
             "Find the fragile assumptions, the strongest simpler alternative, the likely failure modes and one cheap experiment "
             "that could change the choice. Tie every concern to a concrete consequence and give it a severity: P0 when the plan "
             "cannot work as written, P1 when it is likely to produce the wrong result or major rework and must be settled before "
             "any worker starts, P2 when it is worth recording and the run can continue. A P0 or P1 pauses the run for the "
             "operator, so raise one only for a consequence you can name; do not reopen what decisions.md settles unless you "
             "show it cannot hold. kind is assumption, failure_mode, complexity or other. Return the requested JSON schema: "
             "concerns (possibly empty), simpler_alternative and cheap_experiment."]
    if prd:
        parts.append(f"\n\nThe PRD this feature implements: {directory / prd['copy']} (read it).")
    else:
        parts.append("\n\nThe feature names no PRD; challenge the tasks and decisions below.")
    for node in plan_workers(plan):
        parts.append(f"\n\n=== Task of lane {node} ===\n{plan['nodes'][node]['task']}")
    parts.append(f"\n\n=== decisions.md ===\n{decisions_text(plan) or ''}")
    return "".join(parts)


def challenge_path(directory: Path) -> Path:
    return directory / "challenge.json"


def load_challenge(directory: Path) -> dict | None:
    path = challenge_path(directory)
    return read_json(path) if path.exists() else None


def save_challenge(directory: Path, record: dict) -> None:
    """Validate, keep the record it replaces as `challenge-<attempt>.json`, then write the new one."""
    validate_schema("challenge", record)
    previous = load_challenge(directory)
    if previous is not None and previous.get("attempt"):
        archive = directory / f"challenge-{previous['attempt']}.json"
        if not archive.exists():  # The attempt as it was first decided (an accepted override keeps the paused record).
            save_json(archive, previous)
    save_json(challenge_path(directory), record)


def challenge_timeout(plan: dict) -> int:
    automatic = plan.get("automatic")
    return automatic["review_timeout_seconds"] if isinstance(automatic, dict) else DEFAULT_CHALLENGE_TIMEOUT


def challenge_worktree(runtime) -> Path:
    """A detached checkout at the base commit; the job gets only Read, Glob and Grep, and a change to it refuses the result."""
    cwd = runtime.directory / "challenge-worktree"
    base = runtime.plan["base_commit"]
    if not cwd.exists():
        subprocess.run(["git", "-C", runtime.plan["repository"], "worktree", "add", "--detach", str(cwd), base], check=True, capture_output=True)
    if git(cwd, "rev-parse", "HEAD") != base or git(cwd, "status", "--porcelain"):
        raise RuntimeError("Challenge worktree is not the clean base commit; reconcile before rerunning the challenge")
    return cwd


def run_challenge(runtime, attempt: int) -> dict:
    """One print job, validated and decided: `passed` without a P0/P1 concern, `paused` with one. No worker is launched here."""
    from .automatic import print_command
    directory, plan = runtime.directory, runtime.plan
    try:
        cwd = challenge_worktree(runtime)
    except BaseException as error:  # No job ran; the node must not keep a re-pin's `running` as its last status.
        runtime.event(CHALLENGE, "blocked", str(error) or type(error).__name__)
        raise
    session_id = str(uuid.uuid4())
    running = directory / "challenge.running.json"
    save_json(running, {"attempt": attempt, "session_id": session_id, "started_at": now()})
    prompt_path = directory / f"challenge-{attempt}.prompt.txt"
    prompt_path.write_text(challenge_prompt(directory, plan))
    os.chmod(prompt_path, 0o600)
    add_dirs = [str(directory / "challenge-inputs")] if plan.get("prd") else []
    command = print_command(runtime.sessions.executable, session_id, output_schema(), add_dirs)
    runtime.event(CHALLENGE, "running", f"Design challenge attempt {attempt}: one print job, session {session_id}")
    env = {key: value for key, value in os.environ.items() if not key.startswith("HERDR_")}
    stdout = directory / f"challenge-{attempt}.stdout.json"
    try:
        with prompt_path.open() as stdin, stdout.open("w") as output, (directory / f"challenge-{attempt}.stderr.log").open("w") as errors:
            process = subprocess.Popen(command, cwd=cwd, env=env, stdin=stdin, stdout=output, stderr=errors, text=True, start_new_session=True)
        try:
            process.wait(timeout=challenge_timeout(plan))
        except subprocess.TimeoutExpired:
            terminate(process)
            raise RuntimeError(f"Design challenge attempt {attempt} deadline exhausted; no worker was launched") from None
        except BaseException:
            terminate(process)
            raise
        try:
            result = read_json(stdout)
        except ValueError:
            result = {}
        if not isinstance(result, dict):  # A JSON array or string is no result either.
            result = {}
        if process.returncode != 0 or result.get("session_id") != session_id or result.get("is_error") is not False or result.get("subtype") != "success":
            raise RuntimeError(f"Design challenge attempt {attempt} did not succeed; inspect {stdout}. No worker was launched.")
        output = result.get("structured_output")
        try:
            validate_output(output)
        except Exception as error:
            raise RuntimeError(f"Design challenge attempt {attempt} output violates {CHALLENGE_SCHEMA.name}: {getattr(error, 'message', error)}") from None
        if git(cwd, "rev-parse", "HEAD") != plan["base_commit"] or git(cwd, "status", "--porcelain"):
            raise RuntimeError("Challenge worktree changed during the job; refusing its result")
    except BaseException as error:
        runtime.event(CHALLENGE, "blocked", str(error) or type(error).__name__)
        raise
    blocking = [concern for concern in output["concerns"] if concern["severity"] in BLOCKING]
    record = {"version": "1.0.0", "run_id": plan["run_id"], "status": "paused" if blocking else "passed", "attempt": attempt,
              "session_id": session_id, "pinned": pinned_digests(directory, plan), "concerns": output["concerns"],
              "simpler_alternative": output["simpler_alternative"], "cheap_experiment": output["cheap_experiment"],
              "accepted_reason": None, "decided_at": now()}
    save_challenge(directory, record)
    running.unlink()
    if blocking:
        runtime.event(CHALLENGE, "paused", f"Design challenge attempt {attempt} paused the run before any worker launch: "
                                           f"{len(blocking)} P0/P1 concern(s)")
    else:
        runtime.event(CHALLENGE, "succeeded", f"Design challenge attempt {attempt} passed ({len(output['concerns'])} P2 concern(s)); launching workers")
    return record


def disabled_record(directory: Path, plan: dict) -> dict:
    return {"version": "1.0.0", "run_id": plan["run_id"], "status": "disabled", "attempt": 0, "session_id": None,
            "pinned": pinned_digests(directory, plan), "concerns": [], "simpler_alternative": None, "cheap_experiment": None,
            "accepted_reason": None, "decided_at": now()}


def challenge_gate(runtime) -> bool:
    """Called by `start` before any worker launch. True: launch the workers. False: the challenge paused the run.

    Runs without the plan's `challenge` key (every feature before 2.2.0 and every earlier run) pass untouched.
    """
    plan, directory = runtime.plan, runtime.directory
    if "challenge" not in plan:
        return True
    if (directory / REVISION_INTENT).exists():
        raise RuntimeError(f"{UNFINISHED_REVISION}; no worker launches before it does. Rerun it with: {resume_command(directory)}")
    current = load_challenge(directory)
    if plan["challenge"] is False:
        if current is None:
            save_challenge(directory, disabled_record(directory, plan))
            runtime.event("controller", "running", "Design challenge disabled by the feature (challenge: false)")
        return True
    if current is not None:
        if current["status"] in {"passed", "accepted"}:
            return True
        raise RuntimeError(f"The design challenge paused this run; edit the feature files, then: {resume_command(directory)}")
    if (directory / "challenge.running.json").exists():
        raise RuntimeError(f"A design challenge job was started and never decided; rerun it with: {resume_command(directory)}")
    return run_challenge(runtime, 1)["status"] == "passed"


def resume_command(directory: Path, herdr: bool = False, accept: bool = False) -> str:
    command = f"{sys.executable} -m workflow resume {directory}"
    if accept:
        command += ' --accept-challenge "<reason>"'
    return command + (" --herdr" if herdr else "")


def paused_message(directory: Path, herdr: bool = False) -> str:
    record = load_challenge(directory) or {}
    lines = [f"Design challenge attempt {record.get('attempt')} paused the run before any worker launch. Concerns:"]
    for severity in ("P0", "P1", "P2"):
        for concern in record.get("concerns", []):
            if concern["severity"] == severity:
                lines.append(f"  {severity} [{concern['kind']}] {concern['message']}\n      Consequence: {concern['consequence']}")
    lines.append(f"Simpler alternative: {record.get('simpler_alternative')}")
    lines.append(f"Cheap experiment: {record.get('cheap_experiment')}")
    lines.append("Edit the task files, decisions.md or the PRD, then rerun the challenge:\n  " + resume_command(directory, herdr))
    lines.append("Or record an override and launch the workers:\n  " + resume_command(directory, herdr, accept=True))
    return "\n".join(lines)


def read_pinned(plan: dict) -> tuple[dict[str, str], str]:
    """The lanes' tasks and decisions.md as the paths pinned at prepare hold them now; refused as prepare refuses them."""
    tasks = {}
    for node in plan_workers(plan):
        path = Path(plan["task_files"][node])
        text = path.read_text()
        problems = brief_problems(text)
        if problems:
            raise ValueError(f"{path}: {', '.join(problems)}")
        tasks[node] = text
    decisions = Path(plan["decisions"]["path"])
    text = decisions.read_text()
    if not text.strip():
        raise ValueError(f"{decisions} is empty")
    if plan.get("prd") and not Path(plan["prd"]["path"]).is_file():
        raise ValueError(f"PRD {plan['prd']['path']} does not exist")
    return tasks, text


def repin(directory: Path, plan: dict, policy: dict) -> dict:
    """Re-read the task files, decisions.md and the PRD from the paths pinned at prepare; the policy is never re-pinned.

    One plan.json write, which also saves the base `move_base` set in `plan`: the base and the pinned files move together.
    """
    workers = {worker["node_id"]: worker for worker in policy["workers"]}
    tasks, decisions = read_pinned(plan)
    for node, text in tasks.items():
        plan["nodes"][node]["task"] = pinned_task(text, workers[node])
    plan["decisions"]["text"] = decisions
    if plan.get("prd"):
        plan["prd"] = pin_prd(directory, Path(plan["prd"]["path"]))
    save_json(directory / "plan.json", plan)
    return plan


# ---- Revised feature files: `resume` commits them and moves the run to that commit ------------------------------

def pinned_paths(plan: dict) -> set[str]:
    """The paths `repin` reads (the lanes' task files, decisions.md, the PRD) that lie in the source checkout, repository-relative."""
    repo = Path(plan["repository"])
    files = [*plan["task_files"].values(), plan["decisions"]["path"], *([plan["prd"]["path"]] if plan.get("prd") else [])]
    return {Path(path).relative_to(repo).as_posix() for path in files if Path(path).is_relative_to(repo)}


def dirty_paths(repo: Path) -> list[str]:
    """Every path `git status` reports: staged or unstaged changes (a rename as both of its paths) and untracked files."""
    output = subprocess.check_output(["git", "-C", str(repo), "status", "--porcelain", "-z", "--no-renames", "--untracked-files=all"], text=True)
    return sorted({entry[3:] for entry in output.split("\0") if entry})


def commits_after(repo: Path, base: str) -> list[str] | None:
    """The commits of the checked-out branch after `base`, oldest first; None when the branch no longer contains `base`."""
    if subprocess.run(["git", "-C", str(repo), "merge-base", "--is-ancestor", base, "HEAD"], capture_output=True).returncode != 0:
        return None
    return git(repo, "rev-list", "--reverse", f"{base}..HEAD").split()


def revision_subject(run_id: str) -> str:
    return f"Workflow {run_id}: feature files revised"


def is_revision(repo: Path, commit: str, plan: dict) -> bool:
    """A commit `resume` made for this run: one parent, the pipeline's identity and subject, only the pinned feature files."""
    from .pipeline import commit_env
    parents = git(repo, "rev-list", "--parents", "-n", "1", commit).split()[1:]
    author, _, subject = git(repo, "log", "-1", "--format=%an%n%s", commit).partition("\n")
    paths = subprocess.check_output(["git", "-C", str(repo), "diff-tree", "--no-commit-id", "--no-renames", "--name-only", "-r", "-z", commit], text=True)
    return (len(parents) == 1 and author == commit_env()["GIT_AUTHOR_NAME"] and subject.startswith(revision_subject(plan["run_id"]))
            and set(filter(None, paths.split("\0"))) <= pinned_paths(plan))


def commit_revision(runtime, answered: int) -> None:
    """`resume` after an edit: commit the edited feature files on the run's branch, then move the run's worktrees to that commit.

    Only the paths `repin` reads may be changed and every run worktree must be a clean checkout of the base; anything
    else is refused before anything is written. Then `challenge-revision.json` records the move until `repin` has
    pinned its result: while it exists `start` and `--accept-challenge` refuse, so no worker launches on a half-moved
    run, and a rerun continues from the revisions the branch already carries without a second commit.
    """
    from .pipeline import commit_env
    directory, plan = runtime.directory, runtime.plan
    repo, base, branch = Path(plan["repository"]), plan["base_commit"], plan["source_branch"]
    head = subprocess.run(["git", "-C", str(repo), "symbolic-ref", "-q", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()
    if head != branch:
        raise ValueError(f"The source checkout is not on the run's branch {branch}{'' if head else ' (its HEAD is detached)'}; switch back before resume")
    dirty = dirty_paths(repo)
    others = [path for path in dirty if path not in pinned_paths(plan)]
    if others:
        raise ValueError(f"The source checkout has changes resume does not re-pin: {', '.join(others)}. Only the task files, "
                         "decisions.md and the PRD pinned at prepare may change before resume; stash or revert the rest")
    earlier = commits_after(repo, base)
    if earlier is None or not all(is_revision(repo, commit, plan) for commit in earlier):
        raise ValueError(f"The branch {branch} moved past the run's base {base} with commits resume did not make; resume commits the "
                         f"revised feature files itself. Reset the branch to the base (git reset --soft {base}) and rerun resume")
    check_run_worktrees(runtime, {base, *earlier})  # Before the commit: a refusal leaves the branch and the edits as they were.
    intent = directory / REVISION_INTENT
    previous = read_json(intent) if intent.exists() else {"base_commit": base, "paths": []}
    save_json(intent, {"base_commit": previous["base_commit"], "paths": sorted({*previous["paths"], *dirty})})
    if dirty:
        parent = git(repo, "rev-parse", "HEAD")
        subject = revision_subject(plan["run_id"]) + (f" after design challenge attempt {answered}" if answered else " before the design challenge")
        command = ["git", "-C", str(repo), "--literal-pathspecs", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"]
        subprocess.run([*command, "add", "-A", "--", *dirty], env=commit_env(), check=True, capture_output=True)
        subprocess.run([*command, "commit", "-q", "-m", subject, "--", *dirty], env=commit_env(), check=True, capture_output=True)
        commit = git(repo, "rev-parse", "HEAD")
        if git(repo, "rev-parse", f"{commit}^") != parent or not is_revision(repo, commit, plan) or git(repo, "status", "--porcelain"):
            raise RuntimeError(f"Revision commit {commit} is not exactly the edited feature files; reconcile the source checkout before resume")
        runtime.event(CHALLENGE, "running", f"Revised feature files committed on {branch} as {commit}: {', '.join(dirty)}")
    target = git(repo, "rev-parse", "HEAD")
    if target != base:
        move_base(runtime, target, {base, *earlier})


def run_worktrees(repo: Path, directory: Path) -> list[Path]:
    """The repository's worktrees inside the run directory: before any launch, the lane worktrees and the challenge worktree."""
    listing = subprocess.check_output(["git", "-C", str(repo), "worktree", "list", "--porcelain", "-z"], text=True)
    paths = [Path(field[len("worktree "):]) for field in listing.split("\0") if field.startswith("worktree ")]
    return sorted(path for path in paths if path.resolve().is_relative_to(directory))


def check_run_worktrees(runtime, heads: set[str]) -> dict[Path, str]:
    """Every worktree of the run (the lanes' and the challenge's) registered, present and a clean checkout of one of `heads`; their heads."""
    directory, plan = runtime.directory, runtime.plan
    repo, base = Path(plan["repository"]), plan["base_commit"]
    worktrees = run_worktrees(repo, directory)
    lanes = [Path(plan["nodes"][node]["worktree"]).resolve() for node in plan_workers(plan)]
    missing = [str(path) for path in lanes if path not in [item.resolve() for item in worktrees]]
    if missing:
        raise RuntimeError(f"Lane worktrees are not registered in {repo}: {', '.join(missing)}; reconcile before resume")
    found = {}
    for path in worktrees:
        if not path.is_dir():
            raise RuntimeError(f"Run worktree {path} is registered but missing; reconcile before resume")
        found[path] = git(path, "rev-parse", "HEAD")
        if found[path] not in heads or git(path, "status", "--porcelain"):
            raise RuntimeError(f"Run worktree {path} is not a clean checkout of the base {base}; reconcile before resume")
    return found


def move_base(runtime, target: str, heads: set[str]) -> None:
    """Check out `target` in every worktree of the run and set it as the plan's base and each lane's start commit, as prepare does.

    `repin` saves them in the same plan.json write as the re-pinned files. Every worktree must be a clean checkout of
    one of `heads` (the base and the revisions), or of `target` when an interrupted move already reached it.
    """
    plan = runtime.plan
    base = plan["base_commit"]
    found = check_run_worktrees(runtime, {*heads, target})
    for path, head in found.items():
        if head != target:
            subprocess.run(["git", "-C", str(path), "-c", "core.hooksPath=/dev/null", "checkout", "-q", "--detach", target], check=True, capture_output=True)
        if git(path, "rev-parse", "HEAD") != target or git(path, "status", "--porcelain"):
            raise RuntimeError(f"Run worktree {path} did not move cleanly to {target}")
    plan["base_commit"] = target
    for node in plan_workers(plan):
        plan["nodes"][node]["observed_start_commit"] = git(Path(plan["nodes"][node]["worktree"]), "rev-parse", "HEAD")
    runtime.event(CHALLENGE, "running", f"Run worktrees moved from base {base} to {target} ({len(found)}); plan.json pins it with the "
                                        "re-pinned files next; no worker exists yet")


def changed_pins(plan: dict, policy: dict) -> list[Path]:
    """The pinned feature files that no longer hold the plan's copies: edited, committed without `resume`, or removed."""
    workers = {worker["node_id"]: worker for worker in policy["workers"]}
    changed = []
    for node in plan_workers(plan):
        path = Path(plan["task_files"][node])
        if not path.is_file() or pinned_task(path.read_text(), workers[node]) != plan["nodes"][node]["task"]:
            changed.append(path)
    decisions = Path(plan["decisions"]["path"])
    if not decisions.is_file() or decisions.read_text() != plan["decisions"]["text"]:
        changed.append(decisions)
    prd = plan.get("prd")
    if prd and (not Path(prd["path"]).is_file() or digest_bytes(Path(prd["path"]).read_bytes()) != prd["sha256"]):
        changed.append(Path(prd["path"]))
    return changed


def refuse_unused_edits(directory: Path, plan: dict, policy: dict) -> None:
    """An override launches the workers on the plan's pinned copies at its base; an unfinished resume, an unused revision or a changed pin refuses it."""
    repo = Path(plan["repository"])
    if (directory / REVISION_INTENT).exists():
        raise ValueError(f"{UNFINISHED_REVISION}; rerun resume without --accept-challenge to finish it")
    pending = [commit for commit in commits_after(repo, plan["base_commit"]) or [] if is_revision(repo, commit, plan)]
    if pending:
        raise ValueError(f"An interrupted resume committed revised feature files ({', '.join(pending)}) that this run does not use yet; "
                         "rerun resume without --accept-challenge to finish moving the run to them")
    edited = {path for path in dirty_paths(repo) if path in pinned_paths(plan)}
    edited |= {path.relative_to(repo).as_posix() if path.is_relative_to(repo) else str(path) for path in changed_pins(plan, policy)}
    if edited:
        raise ValueError(f"Feature files changed since they were pinned ({', '.join(sorted(edited))}); the override would launch the workers "
                         "without them. Rerun resume without --accept-challenge to commit them and rerun the challenge, or revert them")


def launched_workers(directory: Path, plan: dict) -> list[str]:
    """Lanes with a launch receipt, which InteractiveSessions saves before `claude --bg`. `<lane>.json` is none: only the
    legacy print workers write it, and a lane may share its name with a run file (plan.json, policy.json, terminals.json)."""
    return [node for node in plan_workers(plan) if (directory / f"{node}.interactive.json").exists()]


def resume_challenge(runtime, accept_reason: str | None = None) -> dict:
    """`resume`: rerun the challenge on the re-pinned feature files as the next attempt, or record `accepted` with a reason.

    Only before any worker launch. Edited feature files are committed on the run's branch first and the run moves to
    that commit, so the source checkout stays clean for integration. A challenge that already passed or was accepted
    is returned as it is. The override accepts only an attempt that read what the plan pins now: a rerun that failed
    after its re-pin leaves the paused record of the previous attempt, which read other files.
    """
    directory, plan = runtime.directory, runtime.plan
    if not has_challenge(plan):
        raise ValueError("This run has no design challenge to resume (feature.json before 2.2.0, or challenge: false)")
    launched = launched_workers(directory, plan)
    if launched:
        raise ValueError(f"Workers already launched ({', '.join(launched)}); resume applies only before any worker starts")
    current = load_challenge(directory)
    if current is not None and current["status"] in {"passed", "accepted"}:
        return current
    if accept_reason is not None:
        if not accept_reason.strip():
            raise ValueError("--accept-challenge needs a non-empty reason")
        if current is None or current["status"] != "paused":
            raise ValueError("Only a paused design challenge can be accepted")
        refuse_unused_edits(directory, plan, runtime.policy)
        changed = [key.removesuffix("_sha256") for key, value in pinned_digests(directory, plan).items() if current["pinned"].get(key) != value]
        if changed:
            raise ValueError(f"Design challenge attempt {current['attempt']} read other feature files than the plan now pins ({', '.join(changed)}): "
                             "a later resume re-pinned them and its challenge decided nothing. The override would launch the workers on "
                             "files no challenge read; rerun resume without --accept-challenge")
        record = {**current, "status": "accepted", "accepted_reason": accept_reason.strip(), "decided_at": now()}
        save_challenge(directory, record)
        runtime.event(CHALLENGE, "succeeded", f"Design challenge attempt {record['attempt']} accepted by the operator: {record['accepted_reason']}")
        return record
    running = directory / "challenge.running.json"
    attempt = max(current["attempt"] if current else 0, read_json(running)["attempt"] if running.exists() else 0) + 1
    read_pinned(plan)  # A brief that lost a required section is refused before anything is committed.
    commit_revision(runtime, attempt - 1)
    repin(directory, plan, runtime.policy)  # The moved base and the re-pinned files in one plan.json write.
    (directory / REVISION_INTENT).unlink()
    runtime.event(CHALLENGE, "running", f"Feature files re-pinned for design challenge attempt {attempt} on base {plan['base_commit']}")
    return run_challenge(runtime, attempt)


# ---- Worker questions and the persisted deadline pause ---------------------------------------------------------

def iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat().replace("+00:00", "Z")


def epoch(value: str) -> float:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


@contextmanager
def question_lock(directory: Path):
    """Serialises the controller and `answer` over `<node>.questions.json` and `<node>.deadline.json`."""
    with (directory / "questions.lock").open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def load_questions(directory: Path, node: str) -> list[dict]:
    path = directory / f"{node}.questions.json"
    return read_json(path)["questions"] if path.exists() else []


def save_questions(directory: Path, node: str, questions: list[dict]) -> None:
    save_json(directory / f"{node}.questions.json", {"node_id": node, "questions": questions})


def waiting_question(directory: Path, node: str) -> dict | None:
    questions = load_questions(directory, node)
    return questions[-1] if questions and questions[-1]["answer"] is None else None


def load_deadline(directory: Path, node: str) -> dict:
    path = directory / f"{node}.deadline.json"
    return read_json(path) if path.exists() else {"node_id": node, "paused_seconds": 0.0, "paused_at": None}


def deadline_extension(directory: Path, node: str) -> float | None:
    """Seconds the worker's deadline moved by answered questions; None while a question waits (no deadline runs)."""
    deadline = load_deadline(directory, node)
    return None if deadline["paused_at"] else float(deadline["paused_seconds"])


def resume_deadline(directory: Path, node: str, at: float) -> None:
    deadline = load_deadline(directory, node)
    if deadline["paused_at"]:
        deadline["paused_seconds"] = float(deadline["paused_seconds"]) + max(0.0, at - epoch(deadline["paused_at"]))
        deadline["paused_at"] = None
        save_json(directory / f"{node}.deadline.json", deadline)


def record_question(runtime, node: str, item: dict, clock=None) -> dict:
    """A `question` completion: kept as `<node>.question-<n>.json`, listed, and the lane's deadline paused. A fourth blocks."""
    directory = runtime.directory
    with question_lock(directory):
        questions = load_questions(directory, node)
        number = len(questions) + 1
        if number > MAX_QUESTIONS:
            raise RuntimeError(f"Worker {node} asked question {number}; at most {MAX_QUESTIONS} are answered, so it is treated as blocked: "
                               f"{item['question']}")
        at = (clock or time.time)()
        os.replace(directory / f"{node}.completion.json", directory / f"{node}.question-{number}.json")
        entry = {"n": number, "question": item["question"], "asked_at": iso(at), "answer": None, "answered_at": None}
        save_questions(directory, node, [*questions, entry])
        deadline = load_deadline(directory, node)
        deadline["paused_at"] = iso(at)
        save_json(directory / f"{node}.deadline.json", deadline)
    runtime.event(node, "interactive", f"Worker {node} asked question {number} of {MAX_QUESTIONS}; its deadline is paused until "
                                       f"`python -m workflow answer {directory} {node} \"<text>\"`: {item['question']}")
    return entry


def record_answer(directory: Path, node: str, text: str, clock=None, delivered: bool | None = None) -> dict:
    """The latest question's answer; the deadline restarts now. Refused when no question waits.

    `answer` records `delivered: false` and sets it once the text reached the worker, so a failed delivery can be
    retried; an answer typed in the pane (recorded by the controller) carries no flag.
    """
    if not text.strip():
        raise ValueError("The answer is empty")
    with question_lock(directory):
        questions = load_questions(directory, node)
        if not questions or questions[-1]["answer"] is not None:
            raise ValueError(f"Worker {node} has no unanswered question")
        at = (clock or time.time)()
        questions[-1].update(answer=text, answered_at=iso(at))
        if delivered is not None:
            questions[-1]["delivered"] = delivered
        save_questions(directory, node, questions)
        resume_deadline(directory, node, at)
    return questions[-1]


def undelivered_answer(directory: Path, node: str, text: str) -> dict | None:
    """The latest question when `answer` recorded this text but never delivered it: a rerun delivers it, recording nothing.

    A different text is refused: a question is answered once, and its deadline already runs again.
    """
    questions = load_questions(directory, node)
    if not questions or questions[-1]["answer"] is None or questions[-1].get("delivered") is not False:
        return None
    entry = questions[-1]
    if entry["answer"] != text:
        raise ValueError(f"Question {entry['n']} of {node} is already answered and that answer was never delivered; "
                         f"rerun answer with the recorded text to deliver it: {entry['answer']!r}")
    return entry


def mark_delivered(directory: Path, node: str, number: int) -> None:
    with question_lock(directory):
        questions = load_questions(directory, node)
        questions[number - 1]["delivered"] = True
        save_questions(directory, node, questions)


PANE_ANSWER = "(answered by typing in the worker's pane)"


def deliver_answer(directory: Path, node: str, text: str, use_herdr: bool = True) -> str:
    """Type the answer into the worker's Herdr pane (send-text, then Enter), or say how to type it after `claude attach`."""
    receipt = read_json(directory / f"{node}.interactive.json")
    if not use_herdr:
        return f"Type the answer in the worker's session: claude attach {receipt.get('background_id')}"
    from .herdr import herdr
    terminals = directory / "terminals.json"
    mapping = read_json(terminals) if terminals.exists() else {}  # A run started without --herdr has none.
    if node not in mapping:
        raise RuntimeError(f"No Herdr pane is recorded for {node} in {terminals}")
    pane = mapping[node]["pane_id"]
    herdr("pane", "send-text", pane, text)
    herdr("pane", "send-keys", pane, "Enter")
    return f"Answer typed into pane {pane} ({node})"


# ---- CLI: python -m workflow resume | answer -------------------------------------------------------------------

def resume_main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m workflow resume", description="Rerun a paused design challenge on the edited feature "
                                     "files, or accept it with a reason; then launch the workers (and supervise an automatic run).")
    parser.add_argument("directory", type=Path)
    parser.add_argument("--accept-challenge", metavar="REASON", help="Record the override with this reason and continue without rerunning")
    parser.add_argument("--herdr", action="store_true", help="Attach the worker panes after the launch")
    args = parser.parse_args(argv)
    directory = args.directory.resolve()
    from langgraph.checkpoint.sqlite import SqliteSaver
    from .pipeline import Pipeline, build_pipeline, graph_config, report, start_workers

    def export(runtime) -> Path:
        """As `start` does on a pause: run-state.json shows the latest attempt and the plan's base and pinned files."""
        with SqliteSaver.from_conn_string(str(directory / "pipeline.sqlite")) as saver:
            return report(runtime, build_pipeline(saver, runtime).get_state(graph_config(runtime)))

    try:
        with run_lock(directory):
            runtime = Pipeline(directory)
            moved = lambda: tuple(path.read_bytes() if path.exists() else None for path in
                                  (directory / "plan.json", directory / "challenge.json", directory / "challenge.running.json"))
            before = moved()
            try:
                record = resume_challenge(runtime, args.accept_challenge)
            except BaseException:
                # A rerun that failed after its re-pin has moved the base and the files: the viewer refuses an export
                # whose base is not plan.json's, and shows the failed attempt's event. A refusal that changed nothing
                # keeps the lock short, so a supervisor's next step is not refused for it.
                if moved() != before:
                    print(f"Report: {export(Pipeline(directory))}")
                raise
            runtime = Pipeline(directory)  # The re-pinned plan on its current base: session receipts bind to its digest.
            if record["status"] == "paused":
                print(paused_message(directory, args.herdr))
                print(f"Report: {export(runtime)}")
                return
            start_workers(runtime, attach=args.herdr)
        print(f"Design challenge {record['status']} (attempt {record['attempt']}); workers launched: {', '.join(runtime.workers)}")
        if runtime.plan.get("automatic"):
            from .automatic import supervise
            supervise(directory)
            print(f"Automatic run reached a verified feature branch. Evidence: {directory / 'report.html'}. No main merge or push.")
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Blocked: {error}\nAll work/evidence retained at {directory}. No automatic fallback or push.\n")


def answer_command(directory: Path, node: str, text: str, herdr: bool = True) -> str:
    return f"{sys.executable} -m workflow answer {directory} {node} {shlex.quote(text)}" + ("" if herdr else " --no-herdr")


def answer_main(argv=None):
    """The deadline restarts when the answer is recorded (PRD 4.6), before the delivery, and stays running when the delivery
    fails: paused until a delivery, it would never run again if the operator then typed the answer in the pane (the
    controller records a pane answer only while the question waits). A rerun delivers the recorded answer within it."""
    parser = argparse.ArgumentParser(prog="python -m workflow answer", description="Answer a worker's question: record it, restart the "
                                     "worker's deadline and type it into the worker's pane. Rerun it to deliver an answer whose delivery failed.")
    parser.add_argument("directory", type=Path)
    parser.add_argument("node", help="The lane whose latest question this answers")
    parser.add_argument("text")
    parser.add_argument("--no-herdr", action="store_true", help="Print the claude attach command instead of typing into the pane")
    args = parser.parse_args(argv)
    directory = args.directory.resolve()
    entry = delivered = None
    try:
        plan = read_json(directory / "plan.json")
        if args.node not in plan_workers(plan):
            raise ValueError(f"{args.node} is not a lane of this run ({', '.join(plan_workers(plan))})")
        entry = undelivered_answer(directory, args.node, args.text)
        if entry is None:
            entry = record_answer(directory, args.node, args.text, delivered=False)
            print(f"Recorded the answer to question {entry['n']} of {args.node}; its deadline runs again.")
        else:
            print(f"Question {entry['n']} of {args.node} was answered at {entry['answered_at']} and never delivered; delivering it now "
                  "(nothing is recorded again, and its deadline has run since).")
        print(deliver_answer(directory, args.node, args.text, not args.no_herdr))
        delivered = True
        mark_delivered(directory, args.node, entry["n"])
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as error:
        if delivered:
            parser.exit(1, f"Blocked: {error}\nThe answer reached the worker but is not marked delivered; do not rerun answer for this question.\n")
        if entry is not None:
            parser.exit(1, f"Blocked: {error}\nThe answer to question {entry['n']} stays recorded and its deadline runs, but it did not reach "
                           f"the worker. Deliver it by rerunning, from a Herdr pane:\n  {answer_command(directory, args.node, args.text)}\n"
                           f"or print the claude attach command and type it yourself:\n  {answer_command(directory, args.node, args.text, herdr=False)}\n")
        parser.exit(1, f"Blocked: {error}\n")
