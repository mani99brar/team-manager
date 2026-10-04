"""The guardrails of feature.json 2.2.0 (docs/PRD_PORTABLE_WORKFLOW.md sections 2 and 4.3 to 4.6).

- Outcome briefs: every lane task has non-empty `## Goal`, `## Acceptance` and `## Stop` sections; init's default
  line on running the checks alone leaves a section empty.
- Decisions: the feature directory holds a non-empty `decisions.md` (written by the `workflow-grill` skill); it is
  pinned into the plan and every worker and reviewer prompt includes it after the task. With the `## Operator
  decisions` heading only those bind and win over the task, the rest stays open to the challenge, and reviewers
  count a worker's named departure from the rest inside its lane as no contradicted requirement; a file without it
  (every one written before) binds as a whole, as before, and launch prints a note saying so.
- Project conventions: sessions run with --safe-mode, which loads no CLAUDE.md, so prepare pins the target's CLAUDE.md as
  the base commit holds it, up to the operator-notes heading, and every worker, challenge and reviewer prompt gets it
  right before decisions.md.
- Design challenge: one read-only `claude --print` job reads the pinned PRD, tasks and decisions before any worker
  starts and writes `challenge.json`. It runs inside `start` and `resume`, outside the LangGraph graph (it must decide
  before any worker session exists, and it pauses and resumes on its own); the export shows it as the first node.
  A P0 or P1 concern pauses the run; `resume` commits the edited feature files on the run's branch, moves the run to
  that commit, re-pins them and reruns it, `resume --accept-challenge <reason>` records an override. A `resume` with
  nothing edited since the paused attempt is refused: it would only re-roll the same challenge. The final record's
  concerns reach every worker prompt as advisory notes (challenge_block), never a reviewer's.
- The hold (C8): a run that pins `holds.challenge` (launch --hold-challenge, or profile attended) stops after a passing
  attempt too: `challenge-hold.json` records it, `start` prints every concern and launches nothing, and `resume --launch`
  (the operator's decision) records the release, with the note numbers `--drop` leaves out of the workers' prompts.
- Completion 1.1.0 and questions: a worker may end its turn with status `question`; its deadline pauses (persisted
  in `<node>.deadline.json`) until `answer` records the reply and types it into the worker's pane, only while that pane
  shows the worker's session. A delivery that fails leaves the answer recorded but undelivered; rerunning `answer`
  delivers it, typing the text at most once (after a Herdr timeout on the text the operator looks at the pane first).

- Restore from a candidate (C12): `--restore-from <commit>` on launch and prepare pins `plan.restore_from` (the commit
  and each lane's owned paths present at it), keeps the commit under the run's `refs/workflow/<hash>/restore-from` and
  writes a read-only copy of those paths at it into `challenge-inputs/restore/`, a plain directory, never a worktree.
  Automatic runs only: a manual worker has no shell to run its restore command. The challenge reads it through --add-dir, and each worker's prompt starts with its own `git restore` command.

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
import tarfile
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

from .actor import BY_OPERATOR, actor_record, actor_text, add_actor_argument, require_actor
from .checks import now
from .sessions import (TransientInfraError, git, job_env, plan_workers, note_role, popen_claude, read_json, record_role, role_flags, run_lock, save_json,
                       stale_claude_warning, terminate)
from .verification import CONTRACTS, safe_path, validate_schema
from .worktrees import git_worktree

GUARDED_VERSION = "2.2.0"
# 2.3.0 keeps every guardrail and adds the optional review sidecar (workflow/sidecar.py); 2.4.0 adds the optional `critical`
# (C51), keeping both.
GUARDED_VERSIONS = frozenset({GUARDED_VERSION, "2.3.0", "2.4.0"})
REQUIRED_HEADINGS = ("Goal", "Acceptance", "Stop")
# The one default line init's Acceptance template keeps (C16 step 8). It says how a lane runs its checks, not what the lane
# delivers, so a section that holds nothing else is empty (brief_problems), as it was before the line existed (1943ea8).
CHECKS_DEFAULT = ("Run targeted tests while iterating, then this lane's non-browser policy checks once before writing the completion; "
                  "run browser specs only through check-report on this lane's own specs.")
DECISIONS = "decisions.md"
PLACEHOLDER = "TODO:"  # What launch refuses in the files `init` writes, and resume in the tasks and decisions.md it re-pins.
COMPLETION_VERSION = "1.1.0"
LEGACY_COMPLETION_VERSION = "1.0.0"
MAX_QUESTIONS = 3
CHALLENGE = "challenge"
BLOCKING = frozenset({"P0", "P1"})
DEFAULT_CHALLENGE_TIMEOUT = 1800
CHALLENGE_HEARTBEAT_SECONDS = 60  # How often the terminal hears that the challenge's job still runs (never the timeline).
CHALLENGE_SCHEMA = CONTRACTS / "challenge.schema.json"
REVISION_INTENT = "challenge-revision.json"  # `resume` is moving the run to revised feature files; see commit_revision.
UNFINISHED_REVISION = f"An interrupted resume has not finished moving this run to the revised feature files ({REVISION_INTENT})"
# Said beside a `start` or `resume` command named without knowing whether the run's `start` was given --herdr.
HERDR_HINT = "add --herdr for the worker panes, as launch opens them unless --no-herdr"
MIGRATION_NOTE = ("feature.json {version}: no guardrail is enforced (outcome-brief headings, decisions.md, design challenge, "
                  "completion evidence). To migrate, set \"version\": \"2.2.0\", give every task non-empty ## Goal, ## Acceptance "
                  "and ## Stop sections, and write decisions.md with the workflow-grill skill (workflow/README.md).")
# The heading the workflow-grill skill writes the operator's own answers under (C4). Its presence alone decides how the
# prompts word decisions.md's precedence; no section is parsed.
OPERATOR_DECISIONS = "## Operator decisions"
LEGACY_DECISIONS_NOTE = (f"{DECISIONS} has no '{OPERATOR_DECISIONS}' heading, so all of it binds the run, as before. Rerun the "
                         "workflow-grill skill to bind only the operator's answers and leave its own defaults open to the design "
                         "challenge (workflow/README.md, Guardrails).")
# The target's own conventions file (C15). Sessions start with --safe-mode, which never loads it, so prepare pins it and the
# prompts carry it. What sessions get ends at the operator-notes heading, a line of its own: below it are the operator's notes
# about running workflows (init's starter CLAUDE.md ends with it).
CLAUDE_MD = "CLAUDE.md"
OPERATOR_NOTES = "## Workflow (operator notes; workers skip this section)"


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
    """`missing ## Stop`, `empty ## Acceptance`, ...: a required heading needs at least one non-blank line before the next `## `.
    init's default line on running the checks (CHECKS_DEFAULT, however wrapped, bulleted or not) is process, not content: alone
    it leaves the section empty, so an Acceptance emptied of everything init wrote but that line is still refused, saying so."""
    found = sections(text)
    problems = []
    default = re.compile(r"(?:^|(?<= ))(?:[-*+]|\d+[.)])? ?" + re.escape(CHECKS_DEFAULT))
    for heading in REQUIRED_HEADINGS:
        body = " ".join(found.get(heading, "").split())
        if heading not in found:
            problems.append(f"missing ## {heading}")
        elif not body:
            problems.append(f"empty ## {heading}")
        elif not default.sub("", body).strip():
            problems.append(f"## {heading} has only init's default line on running the checks; add the results it must deliver")
    return problems


def stop_rule(text: str) -> str | None:
    """The body of the task's `## Stop` section, which the worker prompt repeats as its bound. Only the authored text
    counts: in a pinned task the approved ownership and checks (and a browser lane's rules) follow a last `## Stop`."""
    body = sections(text.partition(APPROVED)[0]).get("Stop", "").strip()
    return body or None


def is_guarded(manifest: dict) -> bool:
    return manifest.get("version") in GUARDED_VERSIONS


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
    """Every reason a 2.2.0, 2.3.0 or 2.4.0 feature may not launch; empty for a feature before 2.2.0."""
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


# The check-report command spelled out for a lane: this controller's interpreter with this tool on PYTHONPATH (a
# target's worktree cannot import `workflow`, and `python` is not on every PATH), PYTHONSAFEPATH so that a target's
# own `workflow` package does not shadow it, and the run's pinned policy, which is the one the verifier applies:
# sessions.prepare puts each lane's worktree at <run>/worktree-<lane>, beside <run>/policy.json.
CHECK_REPORT = (f"PYTHONSAFEPATH=1 PYTHONPATH={shlex.quote(str(Path(__file__).resolve().parents[1]))} {shlex.quote(sys.executable)} "
                '-m workflow check-report "$(git rev-parse --show-toplevel)/../policy.json"')
BROWSER_RULES = ("\nBrowser scenarios: each scenario id of your browser checks appears in exactly one test title as `[scenario:<id>]`, "
                 "and that test, when it passes, attaches exactly one image/png named `screenshot:<id>` (other attachments are fine); "
                 "before completing, run the spec files you changed with `WORKFLOW_VERIFICATION_PHASE=<worker|candidate> "
                 "PLAYWRIGHT_JSON_OUTPUT_FILE=<tmp>/report.json npx --no-install playwright test --config=<config> --reporter=json "
                 "<spec files>` and check the report with the verifier's own rules against the run's pinned policy (it only "
                 "reads it), from anywhere in your worktree: `{check_report} {lane} <tmp>/report.json`.")
APPROVED = "\nApproved ownership and checks:\n"


def pinned_task(text: str, worker: dict) -> str:
    """A lane's task as the plan pins it: the authored text plus the approved ownership and checks, and for a lane
    with browser checks the scenario rules the verifier applies and the command that applies them to a report."""
    task = text + APPROVED + json.dumps(worker)
    if any(check["kind"] == "browser" for check in worker["checks"]):
        task += BROWSER_RULES.format(check_report=CHECK_REPORT, lane=worker["node_id"])
    return task


def authored_task(task: str) -> str:
    """The task file's text a pinned task holds: everything before the approved ownership and checks. What follows is
    the controller's own, and for a browser lane it names the interpreter and checkout of the process that pinned it."""
    return task.rpartition(APPROVED)[0]


def pin_guardrails(plan: dict, directory: Path, task_files: dict[str, Path], decisions: Path, prd: Path | None, challenge: bool) -> None:
    """The plan keys of a 2.2.0 run: the completion version, the challenge flag, decisions.md, the project's conventions (the
    base commit's CLAUDE.md up to the operator-notes heading), the PRD copy and the task paths."""
    text = decisions.read_text()
    if not text.strip():
        raise ValueError(f"{decisions} is empty")
    plan.update(feature_version=GUARDED_VERSION, completion_version=COMPLETION_VERSION, challenge=challenge,
                decisions={"path": str(decisions.resolve()), "text": text}, conventions=conventions(plan),
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


# ---- Restore from a candidate (C12) ----------------------------------------------------------------------------

RESTORE = "restore"  # The read-only copy's directory under challenge-inputs/.
RESTORE_REF = "restore-from"  # Beside the lanes' snapshot refs under refs/workflow/<run hash>/; prepare refuses a lane of that name.


def resolve_commit(repo: Path, name: str) -> str:
    """The commit `--restore-from <name>` names in `repo`, by `git rev-parse --verify <name>^{commit}`; ValueError for
    anything else (an unknown name, a tree or blob, an option)."""
    refused = ValueError(f"--restore-from {name} is not a commit in {repo}")
    if not name or name.startswith("-"):
        raise refused
    try:  # git_read: launch's dry run resolves it too, under the tests' patched subprocess.run.
        commit = git_read(repo, "rev-parse", "--verify", "-q", f"{name}^{{commit}}").decode().strip()
    except (OSError, subprocess.CalledProcessError):
        raise refused from None
    if not commit:
        raise refused
    return commit


def check_restore(automatic: bool, lanes: list[str]) -> None:
    """launch and prepare refuse `--restore-from` here, before any Git or filesystem action: in a manual run (its workers
    get no shell to run their restore command), and in a run with a lane named after the restore ref."""
    if not automatic:
        raise ValueError("--restore-from needs --automatic: a manual worker has no shell to run its git restore command")
    if RESTORE_REF in lanes:
        raise ValueError(f"--restore-from needs the ref name {RESTORE_REF}, which a lane of this run takes; rename the lane")


def restore_ref(directory: Path) -> str:
    """The run's own ref that keeps the pinned commit reachable, beside its lane snapshot refs (Pipeline.freeze)."""
    return f"refs/workflow/{hashlib.sha256(str(directory).encode()).hexdigest()[:16]}/{RESTORE_REF}"


def present_paths(repo: Path, commit: str, prefixes: list[str]) -> list[str]:
    """The owned paths (files or directories) that exist at `commit`, in policy order."""
    present = []
    for prefix in prefixes:
        path = safe_path(prefix)
        listed = subprocess.check_output(["git", "-C", str(repo), "--literal-pathspecs", "ls-tree", "-z", "--name-only", commit, "--", path])
        if listed:
            present.append(path)
    return present


def restore_member(member: tarfile.TarInfo, path: str) -> tarfile.TarInfo | None:
    """The copy holds regular files and directories only: a link is left out, never followed out of the copy."""
    if member.issym() or member.islnk():
        return None
    return tarfile.data_filter(member, path)


def write_restore_copy(directory: Path, repo: Path, commit: str, paths: list[str]) -> Path:
    """`challenge-inputs/restore/`: `paths` as `commit` holds them, streamed from `git archive` (so the target's export-ignore
    and export-subst attributes apply, and links are left out). Files 0444; directories 0755, so a plain `rm -rf` of the run
    still works (the challenge has no write tool)."""
    inputs = directory / "challenge-inputs"
    inputs.mkdir(mode=0o700, exist_ok=True)
    target = inputs / RESTORE
    target.mkdir(mode=0o700)
    if paths:
        with subprocess.Popen(["git", "-C", str(repo), "--literal-pathspecs", "archive", "--format=tar", commit, "--", *paths],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE) as archive:
            with tarfile.open(fileobj=archive.stdout, mode="r|") as tar:
                tar.extractall(target, filter=restore_member)
            errors = archive.stderr.read()
        if archive.returncode != 0:
            raise subprocess.CalledProcessError(archive.returncode, archive.args, stderr=errors)
    for root, folders, files in os.walk(target, topdown=False):
        for name in files:
            os.chmod(Path(root) / name, 0o444)
        for name in folders:
            os.chmod(Path(root) / name, 0o755)
    os.chmod(target, 0o755)
    return target


def pin_restore(plan: dict, directory: Path, policy: dict, commit: str) -> None:
    """`prepare --restore-from`: plan.restore_from = {commit, paths: {lane: its owned paths present at the commit}}, the copy of
    their union, and the ref that keeps the commit. `commit` is resolve_commit's."""
    repo = Path(plan["repository"])
    owned = {worker["node_id"]: worker["owned_paths"] for worker in policy["workers"]}
    paths = {node: present_paths(repo, commit, owned[node]) for node in plan_workers(plan)}
    write_restore_copy(directory, repo, commit, sorted({path for items in paths.values() for path in items}))
    subprocess.run(["git", "-C", str(repo), "update-ref", restore_ref(directory), commit], check=True, capture_output=True)
    plan["restore_from"] = {"commit": commit, "paths": paths}


def restore_step(plan: dict, node: str) -> str:
    """The worker prompt's first step in a run with `restore_from`: the lane's own `git restore` (no overlay, so the files
    the commit lacks under those paths are removed). Owned paths absent at the commit are left out. Nothing for other runs."""
    restore = plan.get("restore_from")
    if not isinstance(restore, dict):
        return ""
    commit, paths = restore["commit"], restore["paths"].get(node) or []
    if not paths:
        return (f"\n\nThis run continues from commit {commit}, but none of your owned paths exist at it: there is nothing to "
                "restore, and you start from the base.")
    command = shlex.join(["git", "restore", f"--source={commit}", "--staged", "--worktree", "--", *paths])
    return (f"\n\nFirst step, before anything else: this run continues from commit {commit}. Restore your owned paths from it in "
            f"your worktree:\n{command}\nIt replaces those paths with their contents at that commit and removes the files the commit "
            "lacks under them. You get only your own restored paths, not the other lanes'; the task below starts from there.")


def restore_block(directory: Path, plan: dict) -> str:
    """The challenge prompt's note on `restore_from`: the commit, the read-only copy, and each lane's restored paths."""
    restore = plan.get("restore_from")
    if not isinstance(restore, dict):
        return ""
    lanes = "; ".join(f"{node}: {', '.join(restore['paths'].get(node) or []) or 'none of its owned paths exist at it'}" for node in plan_workers(plan))
    return (f"\n\nThis run continues from commit {restore['commit']}: the lanes start from the base with their owned paths replaced "
            f"by their contents at that commit (files the commit lacks under them are removed). A read-only copy of those paths at "
            f"that commit is in {directory / 'challenge-inputs' / RESTORE} (read it). Each lane sees only its own restored paths, "
            f"not the other lanes': {lanes}.")


def completion_version(plan: dict) -> str:
    """1.1.0 for runs prepared from a 2.2.0 feature; every other run (all runs before slice 2 included) reads 1.0.0."""
    return plan.get("completion_version", LEGACY_COMPLETION_VERSION)


READING = ("When you would build on a reading of a task line that departs from its plain words (your own reading, or one an advisory "
           "note or a sidecar message suggests), ")


def reading_rule(plan: dict) -> str:
    """C16 step 1: what a worker does before it builds on its own reading of a task line. An attended run's worker asks (status
    question) and a manual run's asks in its pane; an unattended run's records the reading where reviewers read it and goes on.
    The profile is plan.automatic.profile (automatic.profile; unattended for a plan pinned before it). A 1.0.0 run (a 2.0.0 or
    2.1.0 feature) has no question status and no untested field: its automatic worker records the reading in open_assumptions,
    which 1.0.0 has, whatever the profile."""
    from .automatic import profile
    automatic = plan.get("automatic")
    if not isinstance(automatic, dict):
        return READING + "ask in this pane, quoting that line, before building on it."
    record = READING + "record an open assumption that starts with \"reading:\" and quotes that line, and go on."
    if completion_version(plan) != COMPLETION_VERSION:
        return record
    if profile(plan) == "attended":
        rule = READING + "write the completion file with status question quoting that line before building on it."
    else:
        rule = record
    return rule + " A behaviour you could not test is no such reading: list it in untested."


def decisions_text(plan: dict) -> str | None:
    decisions = plan.get("decisions")
    return decisions.get("text") if isinstance(decisions, dict) and isinstance(decisions.get("text"), str) else None


def has_operator_decisions(text: str) -> bool:
    """Whether decisions.md has the `## Operator decisions` heading: then only those bind (C4). The heading as sections() reads
    it, which brief_problems uses too: a line inside a fenced code block, such as a quoted template, is never a heading."""
    return OPERATOR_DECISIONS[3:] in sections(text)


def decisions_block(plan: dict) -> str:
    """What every worker and reviewer prompt appends after the task; empty for runs without decisions.

    A file with `## Operator decisions` binds only those; workers follow the rest and may depart from it only as stated.
    Reviewers read the same block: only a contradicted Operator decision, or a departure the worker did not name or took
    outside its lane, is a contradicted requirement, which the rubric (automatic.REVIEW_RUBRIC) makes P1 at least.
    A file without the heading (every one written before C4) binds as a whole, in the wording runs always had.
    """
    text = decisions_text(plan)
    if text is None:
        return ""
    if not has_operator_decisions(text):
        return "\n\nDecisions recorded before launch (decisions.md; they bind this run):\n" + text.rstrip() + "\n"
    return ("\n\nDecisions recorded before launch (decisions.md). Its Operator decisions are the operator's own answers: they bind this "
            "run and win over the task. Workers follow its other sections too, and may depart from a grill default or a change after "
            "launch only to apply a design-challenge note, or when the code shows the bullet cannot hold, and only inside their own "
            "lane's owned paths; a departure that would change anything another lane reads is a question for the operator instead. "
            "Each departure is named, with the bullet's id, in the completion's open_assumptions. For reviewers: a candidate behaviour "
            "that contradicts an Operator decision is P1 at least, and one that an Operator decision requires contradicts no line of a "
            "task or of a document a task cites. A departure from another section that is named so, stays inside the lane's owned "
            "paths and changes nothing another lane reads is no contradicted requirement: judge only what it does. An unnamed or "
            "out-of-lane departure is a contradicted requirement. The file:\n" + text.rstrip() + "\n")


def git_read(repo: Path, *arguments: str, stdin: bytes = b"") -> bytes:
    """The stdout of a git command that only reads, fed `stdin`; CalledProcessError when it fails.

    It runs through Popen for a test constraint, not a production one: dry-run tests used to patch
    workflow.launch.subprocess.run (the one `subprocess` module, so every caller's run) to fake launch's steps, while
    conventions_summary reads CLAUDE.md during such a dry run. Routed through subprocess.run, sessions.git or check_output
    (both call run), it would get the mock's return value and fail with "not enough values to unpack". Those tests now
    patch launch.run_command, the seam for launch's steps, so this could move to sessions.git."""
    with subprocess.Popen(["git", "-C", str(repo), *arguments], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as process:
        output, errors = process.communicate(stdin)
    if process.returncode:
        raise subprocess.CalledProcessError(process.returncode, process.args, output, errors)
    return output


def claude_md(repo: Path, commit: str) -> str | None:
    """The target's CLAUDE.md as `commit` holds it at the root, or None when it holds none. A link inside the repository is
    followed, as Claude Code follows it on disk; one that leaves the repository or dangles is none."""
    found = git_read(repo, "cat-file", "--batch", "--follow-symlinks", stdin=f"{commit}:{CLAUDE_MD}\n".encode())
    header, _, body = found.partition(b"\n")
    fields = header.split()
    if len(fields) != 3 or fields[1] != b"blob":
        return None  # `<name> missing`, `symlink`, `dangling`, `loop` or `notdir` with its size, or a directory.
    return body[:int(fields[2])].decode(errors="replace")


def cut_conventions(text: str) -> tuple[str, list[str] | None]:
    """What sessions get of a CLAUDE.md: its text above the first OPERATOR_NOTES line, with the `## ` headings below that line,
    whose sections are cut with the operator's notes; the whole text and None without that line. As in sections(), a line
    inside a fenced code block is never a heading."""
    lines = text.splitlines(keepends=True)
    fence, cut, below = None, None, []
    for index, line in enumerate(lines):
        marker = re.match(r"(`{3,}|~{3,})", line.strip())
        if marker and (fence is None or marker.group(1)[0] == fence[0] and len(marker.group(1)) >= len(fence)):
            fence = None if fence else marker.group(1)
        elif fence is None and re.match(r"## \S", line):
            if cut is not None:
                below.append(line.strip())
            elif line.rstrip() == OPERATOR_NOTES:
                cut = index
    return ("".join(lines[:cut]), below) if cut is not None else (text, None)


def conventions(plan: dict) -> dict:
    """plan['conventions'] (C15): CLAUDE.md as the run's base commit holds it, cut at the operator-notes heading, with that
    commit and the text's sha256; a base without the file pins an empty text. Pinned once at prepare: `repin` keeps it, since
    resume commits only the pinned feature files, so CLAUDE.md is the same at every base a run moves to."""
    commit = plan["base_commit"]
    text = cut_conventions(claude_md(Path(plan["repository"]), commit) or "")[0]
    return {"commit": commit, "sha256": digest_bytes(text.encode()), "text": text}


def conventions_block(plan: dict) -> str:
    """The project's conventions as every session's prompt has them, right before decisions_block: workers, reviewers (both
    transports) and the design challenge. Empty for a plan that pinned none (a feature before 2.2.0, a run prepared before
    C15) or an empty text."""
    pinned = plan.get("conventions")
    text = pinned.get("text") if isinstance(pinned, dict) else None
    if not isinstance(text, str) or not text.strip():
        return ""
    return (f"\n\nProject conventions ({CLAUDE_MD} at {pinned.get('commit')}; the controller's rules, the task and {DECISIONS} take "
            f"precedence):\n{text.rstrip()}\n")


def conventions_summary(repo: Path) -> tuple[str, str | None]:
    """What `launch --dry-run` says of the conventions a guarded run would pin: CLAUDE.md at HEAD (the commit prepare pins)
    with the size of the text sessions get, or "none"; and a note naming each section below the operator-notes heading, which
    no session gets, or None."""
    text = claude_md(repo, "HEAD")
    if text is None:
        return "none", None
    sent, below = cut_conventions(text)
    commit = git_read(repo, "rev-parse", "HEAD").decode().strip()
    source = ("none" if not sent.strip() else f"{CLAUDE_MD} at {commit}: {len(sent.encode())} bytes, "
              + ("up to the operator-notes heading" if below is not None else "the whole file (it has no operator-notes heading)"))
    note = (f"{CLAUDE_MD} at {commit} has {', '.join(below)} below '{OPERATOR_NOTES}': that text is cut with the operator's notes, so "
            "no session gets it. Move what sessions must follow above the heading." if below else None)
    return source, note


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


def stale_pins(directory: Path, plan: dict, record: dict) -> list[str]:
    """What the plan pins otherwise than `record`'s attempt read it, by that attempt's digests: `tasks`, `decisions`, `prd`."""
    return [key.removesuffix("_sha256") for key, value in pinned_digests(directory, plan).items() if record["pinned"].get(key) != value]


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


def task_block(plan: dict, node: str) -> str:
    """A lane's pinned task as the challenge prompt shows it; another block (`\\n\\n=== `: a task, CLAUDE.md or decisions.md)
    always follows it."""
    return f"\n\n=== Task of lane {node} ===\n{plan['nodes'][node]['task']}"


def changed_since(directory: Path, plan: dict, record: dict) -> list[str]:
    """The pinned feature files the plan holds otherwise than `record`'s attempt read them, named for the rerun's prompt:
    decisions.md and the PRD by that attempt's digests, each lane's task when that attempt's own prompt
    (challenge-<n>.prompt.txt) does not show the text the operator wrote as the plan pins it now. As in changed_pins,
    what the controller appends is no change: a browser lane's check-report command names the interpreter and checkout
    of the process that pinned it, so a resume from another checkout re-pins other text. Repository-relative where the
    files lie in the target."""
    stale = stale_pins(directory, plan, record)
    prompt = directory / f"challenge-{record['attempt']}.prompt.txt"
    read = prompt.read_text() if "tasks" in stale and prompt.exists() else ""
    authored = lambda node: f"\n\n=== Task of lane {node} ===\n{authored_task(plan['nodes'][node]['task'])}{APPROVED}"
    files = [(f"the task of lane {node}", plan["task_files"][node]) for node in plan_workers(plan)
             if "tasks" in stale and authored(node) not in read]
    files += [("decisions.md", plan["decisions"]["path"])] if "decisions" in stale else []
    files += [("the PRD", plan["prd"]["path"])] if "prd" in stale else []
    repo = Path(plan["repository"])
    return [f"{name} ({Path(path).relative_to(repo).as_posix() if Path(path).is_relative_to(repo) else path})" for name, path in files]


def challenge_prompt(directory: Path, plan: dict) -> str:
    """The job's prompt. A rerun after a paused attempt (attempt 2 on) also gets that attempt's P0/P1 concerns and the
    feature files changed since, and is asked to raise each concern again unless the change resolves it. What decisions.md
    settles follows decisions_block: with `## Operator decisions` only those, otherwise all of it. Each concern's message ends
    with its recommendation and who acts on it, which challenge_block shows the workers (C10: text only, the schema stays
    1.0.0 and the pause rule as it was)."""
    prd = plan.get("prd")
    settled = ("reopen an Operator decision of decisions.md (the operator's own answer) only by showing it cannot hold, and then as a "
               "P1; the rest of decisions.md is open to challenge, like the tasks" if has_operator_decisions(decisions_text(plan) or "")
               else "do not reopen what decisions.md settles unless you show it cannot hold")
    parts = ["You are the design challenge of a workflow run: a skeptical senior engineer who reads the plan before any worker "
             "starts. You only read; you change nothing and launch nothing. Your working directory is the repository at the "
             "run's base commit; read its code when a concern depends on it.\n\n"
             "Find the fragile assumptions, the strongest simpler alternative, the likely failure modes and one cheap experiment "
             "that could change the choice. Tie every concern to a concrete consequence and give it a severity: P0 when the plan "
             "cannot work as written, P1 when it is likely to produce the wrong result or major rework and must be settled before "
             "any worker starts, P2 when it is worth recording and the run can continue. A P0 or P1 pauses the run for the "
             f"operator, so raise one only for a consequence you can name; {settled}. kind is assumption, failure_mode, complexity "
             "or other. End each concern's message with two lines: \"Recommendation: <one action and its done-condition>\" and "
             "\"Acts: operator | worker | note\" (operator: a decision only the operator can make; worker: a lane acts on it; note: "
             "nobody needs to act). A recommendation never offers a fallback such as \"or at least\": when two options remain, the "
             "concern is a decision for the operator (Acts: operator), with the recommended option first. Each P0 and P1 message "
             "cites the file:line it rests on, or says \"no file evidence\". Return the requested JSON schema: concerns (possibly "
             "empty), simpler_alternative and cheap_experiment."]
    if prd:
        parts.append(f"\n\nThe PRD this feature implements: {directory / prd['copy']} (read it).")
    else:
        parts.append("\n\nThe feature names no PRD; challenge the tasks and decisions below.")
    parts.append(restore_block(directory, plan))
    for node in plan_workers(plan):
        parts.append(task_block(plan, node))
    conventions = conventions_block(plan)
    if conventions:  # Under a banner like every other block here, so it never reads as part of the last lane's task.
        parts.append(f"\n\n=== {CLAUDE_MD} ==={conventions}")
    parts.append(f"\n\n=== decisions.md ===\n{decisions_text(plan) or ''}")
    previous = load_challenge(directory)
    if previous is not None and previous["status"] == "paused":
        concerns = "".join(f"- {item['severity']} [{item['kind']}] {item['message']}\n" for item in previous["concerns"] if item["severity"] in BLOCKING)
        changed = changed_since(directory, plan, previous)
        ask = (f"Changed since then: {'; '.join(changed)}. Raise each of these concerns again, at its severity, unless the change resolves it"
               if changed else "None of the feature files changed since then. Raise each of these concerns again, at its severity")
        parts.append(f"\n\n=== Design challenge attempt {previous['attempt']} ===\nIt paused the run on these concerns:\n{concerns}{ask}; "
                     "challenge the rest of the plan as before.")
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


def wait_challenge(process, attempt: int, timeout: float, *, clock=time.monotonic) -> None:
    """Wait for the challenge's print job, printing `Design challenge attempt <n> still running (<m> min)` to stdout once
    per CHALLENGE_HEARTBEAT_SECONDS: the supervising terminal sees the job is alive, the timeline gets nothing. Raises
    subprocess.TimeoutExpired once the job has run for `timeout` seconds."""
    started = clock()
    while True:
        try:
            process.wait(timeout=max(0.0, min(CHALLENGE_HEARTBEAT_SECONDS, timeout - (clock() - started))))
            return
        except subprocess.TimeoutExpired:
            elapsed = clock() - started
            if elapsed >= timeout:
                raise
            print(f"Design challenge attempt {attempt} still running ({int(elapsed // 60)} min)", flush=True)


def challenge_worktree(runtime) -> Path:
    """A detached checkout at the base commit; the job gets only Read, Glob and Grep, and a change to it refuses the result.

    One that cannot be created, or is not the clean base, is refused before any job with the command that goes on
    once it is fixed: `resume`, which runs attempt 1, launches the workers and supervises an automatic run. `launch`
    refuses the run directory it already prepared, and `start` would leave an automatic run's workers unsupervised.
    """
    cwd = runtime.directory / "challenge-worktree"
    base = runtime.plan["base_commit"]
    then = f"no job ran; fix it, then run the challenge and launch the workers with: {resume_command(runtime.directory)} ({HERDR_HINT})"
    try:
        if not cwd.exists():
            git_worktree(runtime.plan["repository"], "add", "--detach", str(cwd), base)
        clean = git(cwd, "rev-parse", "HEAD") == base and not git(cwd, "status", "--porcelain")
    except subprocess.CalledProcessError as error:
        raise RuntimeError(f"Challenge worktree {cwd} could not be created or read: {error}\n{then}") from None
    if not clean:
        raise RuntimeError(f"Challenge worktree is not the clean base commit; {then}")
    return cwd


def run_challenge(runtime, attempt: int, herdr: bool = False, released: bool = False) -> dict:
    """One print job, validated and decided: `passed` without a P0/P1 concern, `paused` with one. No worker is launched here.
    `herdr`: the `start` or `resume` that runs it was given --herdr, which the paused record's commands keep. `released`: the
    operator asked for the launch before this attempt ran (`resume --launch`), so a pass the plan would hold launches the workers."""
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
    add_dirs = [str(directory / "challenge-inputs")] if plan.get("prd") or plan.get("restore_from") else []
    runtime.event(CHALLENGE, "running", f"Design challenge attempt {attempt}: one print job, session {session_id}")
    stdout = directory / f"challenge-{attempt}.stdout.json"
    try:
        # Inside the guard: malformed plan roles or a role file that cannot be written block the node, never leave it `running`.
        command = print_command(runtime.sessions.executable, session_id, output_schema(), add_dirs, role_flags(plan, "judges"))
        env = job_env()
        record_role(directory, f"challenge-{attempt}", plan, "judges")  # The pins it asks for; challenge.json's schema is closed.
        with prompt_path.open() as stdin, stdout.open("w") as output, (directory / f"challenge-{attempt}.stderr.log").open("w") as errors:
            process = popen_claude(command, cwd=cwd, env=env, stdin=stdin, stdout=output, stderr=errors, text=True, start_new_session=True)
        try:
            wait_challenge(process, attempt, challenge_timeout(plan))
        except subprocess.TimeoutExpired:
            terminate(process)
            raise RuntimeError(f"Design challenge attempt {attempt} deadline exhausted; no worker was launched") from None
        except KeyboardInterrupt:
            # Said first: a `launch` interrupted with it may not wait long for this process. The job has its own session, so
            # the terminal's Ctrl-C never reached it.
            print(f"Design challenge attempt {attempt} interrupted; no worker was launched. Run the challenge again and launch the "
                  f"workers with:\n  {resume_command(directory)}\n({HERDR_HINT})", flush=True)
            terminate(process)
            raise
        except BaseException:
            terminate(process)
            raise
        note_role(directory, f"challenge-{attempt}", plan, "judges", stdout)  # And the models its output reports, never failing it.
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
        paused = f"Design challenge attempt {attempt} paused the run before any worker launch: {len(blocking)} P0/P1 concern(s)"
        runtime.event(CHALLENGE, "paused", paused)
        from .attention import attention
        attention(directory, "challenge_paused", f"{paused}. Edit the task files, decisions.md or the PRD {edited_in(plan)}, then run: "
                                                 f"{resume_command(directory, herdr)}; "
                                                 f"or accept it: {resume_command(directory, herdr, accept=True)}", node=CHALLENGE)
    elif hold_pinned(plan) and not released:  # challenge_gate holds it next: no worker launches before `resume --launch`.
        runtime.event(CHALLENGE, "succeeded", f"Design challenge attempt {attempt} passed ({len(output['concerns'])} P2 concern(s)); held for the operator")
    else:
        runtime.event(CHALLENGE, "succeeded", f"Design challenge attempt {attempt} passed ({len(output['concerns'])} P2 concern(s)); launching workers")
    return record


def disabled_record(directory: Path, plan: dict) -> dict:
    return {"version": "1.0.0", "run_id": plan["run_id"], "status": "disabled", "attempt": 0, "session_id": None,
            "pinned": pinned_digests(directory, plan), "concerns": [], "simpler_alternative": None, "cheap_experiment": None,
            "accepted_reason": None, "decided_at": now()}


def challenge_gate(runtime, herdr: bool = False, announce=None) -> bool:
    """Called by `start` before any worker launch. True: launch the workers. False: the challenge paused the run.

    Runs without the plan's `challenge` key (every feature before 2.2.0 and every earlier run) pass untouched. The
    `resume` commands it names keep `start`'s --herdr (`herdr`). `announce`, when given, is called once the start is
    not refused, before the challenge runs or the workers launch: `start` records who ran it there.
    """
    announce = announce or (lambda: None)
    plan, directory = runtime.plan, runtime.directory
    if "challenge" not in plan:
        announce()
        return True
    if (directory / REVISION_INTENT).exists():
        raise RuntimeError(f"{UNFINISHED_REVISION}; no worker launches before it does. Rerun it with: {resume_command(directory, herdr)}")
    current = load_challenge(directory)
    if plan["challenge"] is False:
        announce()
        if current is None:
            save_challenge(directory, disabled_record(directory, plan))
            runtime.event("controller", "running", "Design challenge disabled by the feature (challenge: false)")
        return True
    if current is not None:
        if current["status"] in {"passed", "accepted"}:
            announce()
            return not hold(runtime, current, herdr)
        raise RuntimeError(f"The design challenge paused this run; edit the feature files {edited_in(plan)}, then: {resume_command(directory, herdr)}")
    if (directory / "challenge.running.json").exists():
        raise RuntimeError(f"A design challenge job was started and never decided; rerun it with: {resume_command(directory, herdr)}")
    announce()
    record = run_challenge(runtime, 1, herdr)
    return record["status"] == "passed" and not hold(runtime, record, herdr)


# ---- The hold after a passing challenge (C8) -------------------------------------------------------------------

HOLD = "challenge-hold.json"  # {attempt, held_at, released_at, released_by, dropped, held?}: the latest held attempt and its release.


def hold_pinned(plan: dict) -> bool:
    """The run holds after a passing challenge: prepare pinned plan.holds.challenge (launch --hold-challenge, or profile
    attended) and the challenge runs. Every run prepared before C8 pins no holds and launches as it always did."""
    holds = plan.get("holds")
    return has_challenge(plan) and isinstance(holds, dict) and holds.get("challenge") is True


def load_hold(directory: Path) -> dict | None:
    path = directory / HOLD
    return read_json(path) if path.exists() else None


def is_held(directory: Path, plan: dict, record: dict | None) -> bool:
    """`record` (challenge.json) passed, the plan holds it, and no release is recorded for its attempt. An accepted record is
    never held: the override is the operator's decision and counts as the release."""
    if not hold_pinned(plan) or not record or record.get("status") != "passed":
        return False
    found = load_hold(directory)
    return not (found and found.get("attempt") == record.get("attempt") and found.get("released_at"))


def released_drops(directory: Path) -> frozenset[int]:
    """The note numbers `resume --launch --drop` left out of the workers' prompts: the release's, for the attempt challenge.json
    holds now; none for any other run."""
    found, record = load_hold(directory), load_challenge(directory)
    if not found or not record or found.get("attempt") != record.get("attempt") or not found.get("released_at"):
        return frozenset()
    return frozenset(found.get("dropped") or [])


def save_hold(directory: Path, entry: dict) -> None:
    """Write the hold record, keeping the one of an earlier attempt it replaces as `challenge-hold-<attempt>.json`."""
    previous = load_hold(directory)
    if previous is not None and previous.get("attempt") != entry["attempt"]:
        archive = directory / f"challenge-hold-{previous['attempt']}.json"
        if not archive.exists():
            save_json(archive, previous)
    save_json(directory / HOLD, entry)


def hold(runtime, record: dict, herdr: bool = False) -> bool:
    """Hold the run at `record`'s passing attempt when the plan pins the hold and nothing released it: the hold record, a challenge
    `paused` event and the `challenge_paused` attention record, once per attempt. True while held."""
    directory, plan = runtime.directory, runtime.plan
    if not is_held(directory, plan, record):
        return False
    found = load_hold(directory)
    if found and found.get("attempt") == record["attempt"]:
        return True  # Held already: a second `start` prints the hold again and records nothing.
    save_hold(directory, {"attempt": record["attempt"], "held_at": now(), "released_at": None, "released_by": None, "dropped": []})
    held = (f"Design challenge attempt {record['attempt']} passed ({len(record['concerns'])} P2 concern(s)) and is held for the operator "
            "before any worker launch")
    runtime.event(CHALLENGE, "paused", held)
    from .attention import attention
    attention(directory, "challenge_paused", f"{held}. Read every concern, then launch the workers: {resume_command(directory, herdr, launch=True)}; "
                                             f"or edit the task files, decisions.md or the PRD {edited_in(plan)} and rerun it: "
                                             f"{resume_command(directory, herdr)}", node=CHALLENGE)
    return True


def parse_drop(value: str | None) -> frozenset[int]:
    """`--drop 2,5`: the note numbers, each a positive integer; ValueError otherwise."""
    if value is None:
        return frozenset()
    try:
        numbers = frozenset(int(item) for item in value.split(","))
    except ValueError:
        raise ValueError(f"--drop {value}: give the note numbers, comma-separated (--drop 2,5)") from None
    if not numbers or min(numbers) < 1:
        raise ValueError(f"--drop {value}: note numbers start at 1")
    return numbers


def release_hold(runtime, record: dict, actor: str, dropped: frozenset[int], held: bool = True) -> None:
    """`resume --launch`: record the release of `record`'s attempt (when, by whom, the notes left out). A rerun that passed under
    `--launch` was never held (`held` false): its record is written released and marked `"held": false`, which the export reads as
    no hold. Records before it carry no `held` and export as held, including a rerun that an earlier controller released under
    `--launch`."""
    directory = runtime.directory
    found = load_hold(directory)
    held_at = found["held_at"] if found and found.get("attempt") == record["attempt"] else now()
    entry = {"attempt": record["attempt"], "held_at": held_at, "released_at": now(), "released_by": actor, "dropped": sorted(dropped)}
    save_hold(directory, entry if held else {**entry, "held": False})


def unheld_drop(directory: Path, current: dict | None, dropped: frozenset[int]) -> str:
    """Why `--drop` is refused on a run that holds no attempt: only the release of a held attempt consumes it, so anywhere else it
    would be ignored. A paused or undecided attempt's rerun numbers its own notes; a released hold recorded its drops already,
    and a rerun that passed under `--launch` was never held."""
    numbers = ",".join(map(str, sorted(dropped)))
    if current is None or current["status"] == "paused":
        what = f"design challenge attempt {current['attempt']} paused this run" if current else "no design challenge attempt was decided"
        return f"--drop {numbers}: {what}, and the rerun numbers its own notes. Resume --launch without --drop"
    if current["status"] == "accepted":
        return f"--drop {numbers}: design challenge attempt {current['attempt']} was accepted, and nothing holds it. Resume --launch without --drop"
    found = load_hold(directory) or {}
    if found.get("attempt") == current["attempt"] and found.get("held") is False:
        return (f"--drop {numbers}: design challenge attempt {current['attempt']} passed under resume --launch and was never held; the "
                "workers launch with all its notes. Resume --launch without --drop")
    kept = found.get("dropped") or [] if found.get("attempt") == current["attempt"] else []
    earlier = f", with note {', '.join(map(str, kept))} dropped" if kept else ", with no note dropped"
    return (f"--drop {numbers}: the hold of design challenge attempt {current['attempt']} was released already{earlier}; the workers "
            "launch with those notes. Resume --launch without --drop")


def held_refusal(directory: Path, record: dict, herdr: bool = False, unchanged: bool = True) -> str:
    """What `resume` says on a held run when nothing changed since its attempt, and to `--accept-challenge` on a held run. With
    feature files edited since the attempt (`unchanged` false), what each resume does with them, or resume's refusal when its
    read-only checks fail (resume_refusal): never a command that refuses."""
    plan = read_json(directory / "plan.json")
    if not unchanged:
        changed = f"Design challenge attempt {record['attempt']} passed and is held for the operator, and feature files changed since it read them"
        refusal = resume_refusal(plan)
        if refusal:
            return f"{changed}, but resume refuses: {refusal}; nothing is accepted"
        return (f"{changed}: nothing is accepted. {resume_command(directory, herdr, launch=True)} commits them, reruns the challenge and "
                f"launches the workers unless it finds a P0/P1; or {resume_command(directory, herdr)} reruns it and holds again")
    return (f"Design challenge attempt {record['attempt']} passed and is held for the operator: nothing is accepted and nothing it "
            f"read has changed since. Launch the workers (add --drop <n>,<m> to leave notes out of their prompts): "
            f"{resume_command(directory, herdr, launch=True)}\nOr edit the task files, decisions.md or the PRD {edited_in(plan)}, then "
            f"rerun the challenge: {resume_command(directory, herdr)}")


def source_checkout(directory: Path) -> Path:
    """The run's own checkout that `launch` adds with `git worktree add`: `<run>.source`, beside the run directory and so
    outside it, where run_worktrees and move_base would take it for one of the run's. plan.repository names it."""
    return directory.parent / f"{directory.name}.source"


def edited_in(plan: dict) -> str:
    """Where a paused run's feature files are edited: its source checkout, the run's own worktree since launch adds one."""
    return f"in the source checkout {plan.get('repository')}"


def finished_note(source: Path, branch: str, checkout: Path | None = None) -> str:
    """How a run launched on its own worktree ends: the branch merges into your checkout without switching it, and the
    worktree is removed by hand (C47's cleanup is later)."""
    where = f"git -C {checkout} " if checkout else "git "
    return (f"Merge the run branch from your checkout without switching it: {where}merge --ff-only {branch}. Once the run is "
            f"finished, remove its source checkout: {where}worktree remove {source}")


# Set by launch on the `automatic` it runs: launch prints finished_note itself, in its `git -C <your checkout>` form.
LAUNCH_NOTE_ENV = "WORKFLOW_LAUNCH_PRINTS_FINISH_NOTE"


def run_finished_note(directory: Path, plan: dict) -> str | None:
    """finished_note for a run whose plan.repository is its own source checkout; None for a run prepared in your checkout."""
    source = source_checkout(directory)
    if Path(plan.get("repository", "")) != source:
        return None
    return finished_note(source, plan["source_branch"])


def resume_command(directory: Path, herdr: bool = False, accept: bool = False, launch: bool = False) -> str:
    command = f"{sys.executable} -m workflow resume {directory} {BY_OPERATOR}"
    if launch:
        command += " --launch"
    if accept:
        command += ' --accept-challenge "<reason>"'
    return command + (" --herdr" if herdr else "")


def paused_message(directory: Path, herdr: bool = False) -> str:
    record = load_challenge(directory) or {}
    if record.get("status") == "passed":
        return hold_message(directory, herdr)
    lines = [f"Design challenge attempt {record.get('attempt')} paused the run before any worker launch. Concerns:"]
    for severity in ("P0", "P1", "P2"):
        for concern in record.get("concerns", []):
            if concern["severity"] == severity:
                lines.append(f"  {severity} [{concern['kind']}] {concern['message']}\n      Consequence: {concern['consequence']}")
    lines.append(f"Simpler alternative: {record.get('simpler_alternative')}")
    lines.append(f"Cheap experiment: {record.get('cheap_experiment')}")
    plan = read_json(directory / "plan.json")
    lines.append(f"Edit the task files, decisions.md or the PRD {edited_in(plan)}, then rerun the challenge:\n  " + resume_command(directory, herdr))
    lines.append("Or record an override and launch the workers:\n  " + resume_command(directory, herdr, accept=True))
    return "\n".join(lines)


def hold_message(directory: Path, herdr: bool = False) -> str:
    """What `start` and `resume` print on a held run: every concern numbered in challenge.json's order (the numbers --drop
    takes), the alternative, the experiment and both commands. No accept line: nothing blocks, so nothing is overridden."""
    record = load_challenge(directory) or {}
    plan = read_json(directory / "plan.json")
    lines = [f"Design challenge attempt {record.get('attempt')} passed and is held for the operator; no worker was launched. Concerns:"]
    lines += [f"  {number}. {item['severity']} [{item['kind']}] {item['message']}\n      Consequence: {item['consequence']}"
              for number, item in enumerate(record.get("concerns", []), 1)] or ["  none"]
    lines.append(f"Simpler alternative: {record.get('simpler_alternative')}")
    lines.append(f"Cheap experiment: {record.get('cheap_experiment')}")
    lines.append("Launch the workers with these notes (add --drop <n>,<m> to leave notes out of their prompts):\n  "
                 + resume_command(directory, herdr, launch=True))
    lines.append(f"Or edit the task files, decisions.md or the PRD {edited_in(plan)}, then rerun the challenge; it holds again when it "
                 "passes:\n  " + resume_command(directory, herdr))
    return "\n".join(lines)


def challenge_block(directory: Path, plan: dict, dropped: set[int] | frozenset[int] = frozenset()) -> str:
    """The final design challenge as advisory notes for the worker prompt only, after decisions_block (C9, decision 11):
    reviewers never get it, and it is never pinned into a lane's task. A passed or accepted challenge.json's concerns keep its
    numbering, each with severity, kind, message and consequence; the simpler alternative and the cheap experiment are left
    out. An accepted record lists the P0/P1s the operator overrode apart, with the reason, as context only. Nothing for a
    disabled, paused or absent record, nor for a note whose number is in `dropped` (slice 3's --drop at a hold release)."""
    record = load_challenge(directory)
    if record is None or record["status"] not in {"passed", "accepted"}:
        return ""
    numbered = [(number, concern) for number, concern in enumerate(record["concerns"], 1) if number not in dropped]
    if not numbered:
        return ""
    accepted = record["status"] == "accepted"
    notes = [(number, concern) for number, concern in numbered if not (accepted and concern["severity"] in BLOCKING)]
    overridden = [(number, concern) for number, concern in numbered if accepted and concern["severity"] in BLOCKING]
    ask = "write the completion file with status question" if isinstance(plan.get("automatic"), dict) else "ask in this pane"
    item = lambda number, concern: f"{number}. {concern['severity']} [{concern['kind']}] {concern['message']}\n   Consequence: {concern['consequence']}"
    lines = [f"\n\nDesign challenge notes (advisory, attempt {record['attempt']})\nDo each note's recommendation, or say in your completion "
             "why not; a fallback such as \"or at least\" is not the recommendation. A note marked \"Acts: operator\" is the operator's "
             f"decision: if your work depends on it, {ask} instead of choosing.", *(item(*note) for note in notes)]
    if overridden:
        lines.append("Accepted by the operator: context only. Do not act on them and do not ask about them, whatever their \"Acts:\" line "
                     "says: the operator decided them. These P0/P1 concerns paused the run, and the operator launched it with the reason: "
                     f"{record['accepted_reason']}")
        lines += [item(*concern) for concern in overridden]
    return "\n".join(lines) + "\n"


def refuse_placeholders(path: Path, text: str) -> None:
    """Refuse a Markdown feature file with a line that begins with `TODO:`, as launch refuses one (launch.placeholders): a
    placeholder, or a question the grill asked and never had answered (`TODO: Q<n> <question>`)."""
    left = [f"{path}:{number}: {line.strip()}" for number, line in enumerate(text.splitlines(), 1) if line.strip().startswith(PLACEHOLDER)]
    if left:
        raise ValueError(f"{'; '.join(left)} (launch refuses it too: answer or remove each line that begins with {PLACEHOLDER}, then rerun resume)")


def read_pinned(plan: dict) -> tuple[dict[str, str], str]:
    """The lanes' tasks and decisions.md as the paths pinned at prepare hold them now; refused as prepare refuses them, and
    as launch refuses a line that begins with `TODO:` in them (`resume` calls it before it commits anything)."""
    tasks = {}
    for node in plan_workers(plan):
        path = Path(plan["task_files"][node])
        text = path.read_text()
        problems = brief_problems(text)
        if problems:
            raise ValueError(f"{path}: {', '.join(problems)}")
        refuse_placeholders(path, text)
        tasks[node] = text
    decisions = Path(plan["decisions"]["path"])
    text = decisions.read_text()
    if not text.strip():
        raise ValueError(f"{decisions} is empty")
    refuse_placeholders(decisions, text)
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
    """Every path `git status` reports: staged or unstaged changes (a rename as both of its paths) and untracked files.
    It never takes the index lock to write back refreshed stat data, so `status` can read the checkout while a `resume` commits in it."""
    output = subprocess.check_output(["git", "-C", str(repo), "status", "--porcelain", "-z", "--no-renames", "--untracked-files=all"], text=True,
                                     env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"})
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


def revision_checks(plan: dict) -> tuple[list[str], list[str]]:
    """commit_revision's read-only checks, which refuse before anything is written: the source checkout is on the run's
    branch, nothing but the pinned feature files changed in it, and the branch holds only revision commits after the base.
    The dirty paths and those revision commits; ValueError otherwise."""
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
    return dirty, earlier


def resume_refusal(plan: dict) -> str | None:
    """Why `resume` would refuse to commit the edited feature files, from its read-only checks (read_pinned, then
    revision_checks), or None. `status` and the override's refusal run it before they promise that resume commits them."""
    try:
        read_pinned(plan)
        revision_checks(plan)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        return str(error)
    return None


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
    dirty, earlier = revision_checks(plan)
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


def changed_pins(plan: dict) -> list[Path]:
    """The pinned feature files that no longer hold the plan's copies: edited, committed without `resume`, or removed.

    A task file is compared with the authored part of its pinned task, never with a task pinned again here: another
    interpreter, tool checkout or tool version appends other text to a browser lane's task than prepare did.
    """
    changed = []
    for node in plan_workers(plan):
        path = Path(plan["task_files"][node])
        if not path.is_file() or path.read_text() != authored_task(plan["nodes"][node]["task"]):
            changed.append(path)
    decisions = Path(plan["decisions"]["path"])
    if not decisions.is_file() or decisions.read_text() != plan["decisions"]["text"]:
        changed.append(decisions)
    prd = plan.get("prd")
    if prd and (not Path(prd["path"]).is_file() or digest_bytes(Path(prd["path"]).read_bytes()) != prd["sha256"]):
        changed.append(Path(prd["path"]))
    return changed


def unused_edits(directory: Path, plan: dict) -> str | None:
    """Why the plan's pinned copies at its base are not all a rerun would read, or None: an unfinished resume
    (REVISION_INTENT), revision commits it made that the run does not use yet, or pinned feature files edited since (in
    the source checkout, committed by hand, or removed). The reason says how to go on instead of an override."""
    repo = Path(plan["repository"])
    if (directory / REVISION_INTENT).exists():
        return f"{UNFINISHED_REVISION}; rerun resume without --accept-challenge to finish it"
    pending = [commit for commit in commits_after(repo, plan["base_commit"]) or [] if is_revision(repo, commit, plan)]
    if pending:
        return (f"An interrupted resume committed revised feature files ({', '.join(pending)}) that this run does not use yet; "
                "rerun resume without --accept-challenge to finish moving the run to them")
    edited = {path for path in dirty_paths(repo) if path in pinned_paths(plan)}
    edited |= {path.relative_to(repo).as_posix() if path.is_relative_to(repo) else str(path) for path in changed_pins(plan)}
    if edited:
        changed = f"Feature files changed since they were pinned ({', '.join(sorted(edited))}); the override would launch the workers without them."
        refusal = resume_refusal(plan)
        if refusal:
            return f"{changed} resume refuses: {refusal}. Fix that and rerun resume without --accept-challenge, or revert them"
        return f"{changed} Rerun resume without --accept-challenge to commit them and rerun the challenge, or revert them"
    return None


def refuse_unused_edits(directory: Path, plan: dict) -> None:
    """An override launches the workers on the plan's pinned copies at its base; an unfinished resume, an unused revision or a changed pin refuses it."""
    reason = unused_edits(directory, plan)
    if reason:
        raise ValueError(reason)


def unchanged_since(directory: Path, plan: dict, record: dict) -> bool:
    """Whether a rerun would read exactly what `record`'s attempt read, and so only sample the same challenge again: the
    plan pins what that attempt read (its digests), no later attempt was started (a newer challenge.running.json), and
    no edit waits to be committed, moved to or re-pinned (unused_edits). A rerun that failed after its re-pin, its job
    failed, its checkout refused or its process killed, leaves other digests or a newer running file: it is rerun.
    `resume` refuses a bare rerun of a paused attempt while this holds."""
    running = directory / "challenge.running.json"
    return (not stale_pins(directory, plan, record) and not (running.exists() and read_json(running)["attempt"] > record["attempt"])
            and unused_edits(directory, plan) is None)


def interrupted_rerun(directory: Path, plan: dict, record: dict) -> bool:
    """A rerun started after `record`'s paused attempt and never decided: its job was started (a newer
    challenge.running.json), it re-pinned the files and failed before its job (stale_pins), or it was moving the run to the
    revised files (REVISION_INTENT). The operator decided that rerun; finishing it decides nothing new."""
    running = directory / "challenge.running.json"
    return ((running.exists() and read_json(running)["attempt"] > record["attempt"]) or (directory / REVISION_INTENT).exists()
            or bool(stale_pins(directory, plan, record)))


def refuse_maintainer(directory: Path, plan: dict, current: dict | None, actor: str) -> None:
    """`resume --by maintainer` only where it decides nothing (C17, decision 2a): no record yet, a challenge passed or accepted
    (the workers' launch), or an interrupted rerun newer than the paused record. A paused challenge itself, with or without
    edits, waits on the operator: a rerun of edits is theirs to commit, a bare rerun re-rolls their challenge. So does a
    pinned file edited after the interrupted rerun: that rerun committed its own edits before its re-pin and its job (an
    interrupted commit lists them in REVISION_INTENT), so any other is a later edit, perhaps half-written. With no record
    yet (an interrupted first attempt), a dirty pinned file is such a later edit too."""
    held = is_held(directory, plan, current)
    if actor != "maintainer" or current is not None and current["status"] != "paused" and not held:
        return

    def refuse_later_edits(after: str) -> None:
        intent = directory / REVISION_INTENT
        committing = set(read_json(intent)["paths"]) if intent.exists() else set()
        later = [path for path in dirty_paths(Path(plan["repository"])) if path in pinned_paths(plan) and path not in committing]
        if later:
            raise ValueError(f"Feature files were edited after {after} ({', '.join(later)}): committing them is the operator's "
                             f"decision, so resume --by maintainer is refused. The operator runs: {resume_command(directory)}")

    if current is None:
        running = directory / "challenge.running.json"
        refuse_later_edits(f"design challenge attempt {read_json(running).get('attempt', 1)} was interrupted" if running.exists()
                           else "the run was prepared")
        return
    if interrupted_rerun(directory, plan, current):
        refuse_later_edits("the interrupted rerun")
        return
    if held:
        raise ValueError(f"Design challenge attempt {current['attempt']} passed and is held for the operator: releasing or rerunning it is "
                         f"the operator's decision, so resume --by maintainer is refused. The operator runs: {resume_command(directory, launch=True)}")
    raise ValueError(f"Design challenge attempt {current['attempt']} paused this run: rerunning or accepting it is the operator's "
                     f"decision, so resume --by maintainer is refused. The operator runs: {resume_command(directory)}")


def launched_workers(directory: Path, plan: dict) -> list[str]:
    """Lanes with a launch receipt, which InteractiveSessions saves before `claude --bg`. `<lane>.json` is none: only the
    legacy print workers write it, and a lane may share its name with a run file (plan.json, policy.json, terminals.json)."""
    return [node for node in plan_workers(plan) if (directory / f"{node}.interactive.json").exists()]


def resume_challenge(runtime, accept_reason: str | None = None, herdr: bool = False, actor: str = "operator", launch: bool = False,
                     dropped: frozenset[int] = frozenset()) -> dict:
    """`resume`: rerun the challenge on the re-pinned feature files as the next attempt, or record `accepted` with a reason.

    Only before any worker launch. Edited feature files are committed on the run's branch first and the run moves to
    that commit, so the source checkout stays clean for integration. A challenge that already passed or was accepted
    is returned as it is. The override accepts only an attempt that read what the plan pins now: a rerun that failed
    after its re-pin leaves the paused record of the previous attempt, which read other files. A rerun of a paused
    attempt is refused while nothing changed since it (unchanged_since): it would only re-roll the same challenge.
    The commands the refusal and a paused rerun's record name keep `resume`'s --herdr (`herdr`). `actor` (resume's --by)
    is checked by refuse_maintainer and named in the event each path writes, never in challenge.json.

    A held run (C8: plan.holds, a passed attempt not released): `launch` with nothing changed since that attempt records the
    release (`dropped` are the note numbers left out of the workers' prompts) and returns it; with edits it reruns as after a
    pause, and a pass is released at once. A plain resume with edits reruns and the gate holds the pass again; with none, and
    an override, it is refused naming both commands. `launch` needs a plan that holds; `dropped` needs `launch` (resume_main).
    """
    from .pipeline import action_event
    directory, plan = runtime.directory, runtime.plan
    if not has_challenge(plan):
        raise ValueError("This run has no design challenge to resume (feature.json before 2.2.0, or challenge: false)")
    if launch and not hold_pinned(plan):
        raise ValueError("--launch applies to a run that holds after a passing design challenge (launch --hold-challenge, or profile "
                         f"attended); this one launches its workers once the challenge passes: {resume_command(directory, herdr)}")
    launched = launched_workers(directory, plan)
    if launched:
        raise ValueError(f"Workers already launched ({', '.join(launched)}); resume applies only before any worker starts")
    current = load_challenge(directory)
    refuse_maintainer(directory, plan, current, actor)
    if is_held(directory, plan, current):
        unchanged = unchanged_since(directory, plan, current)
        if accept_reason is not None or (unchanged and not launch):
            raise ValueError(held_refusal(directory, current, herdr, unchanged))
        if unchanged:
            beyond = sorted(number for number in dropped if number > len(current["concerns"]))
            if beyond:
                raise ValueError(f"--drop {','.join(map(str, beyond))}: design challenge attempt {current['attempt']} has "
                                 f"{len(current['concerns'])} note(s)")
            release_hold(runtime, current, actor, dropped)
            notes = f" (note {', '.join(map(str, sorted(dropped)))} dropped)" if dropped else ""
            action_event(runtime.event, actor, "resume", f"design challenge attempt {current['attempt']} hold released{notes}; launching the workers")
            return current
        if dropped:
            raise ValueError(f"--drop numbers the notes of design challenge attempt {current['attempt']}, but feature files changed since it "
                             "read them: the rerun numbers its own. Resume --launch without --drop, or revert the edits")
    elif dropped:
        raise ValueError(unheld_drop(directory, current, dropped))
    elif current is not None and current["status"] in {"passed", "accepted"}:
        action_event(runtime.event, actor, "resume", f"design challenge attempt {current['attempt']} {current['status']}; launching the workers")
        return current
    if accept_reason is not None:
        if not accept_reason.strip():
            raise ValueError("--accept-challenge needs a non-empty reason")
        if current is None or current["status"] != "paused":
            raise ValueError("Only a paused design challenge can be accepted")
        refuse_unused_edits(directory, plan)
        changed = stale_pins(directory, plan, current)
        if changed:
            raise ValueError(f"Design challenge attempt {current['attempt']} read other feature files than the plan now pins ({', '.join(changed)}): "
                             "a later resume re-pinned them and its challenge decided nothing. The override would launch the workers on "
                             "files no challenge read; rerun resume without --accept-challenge")
        record = {**current, "status": "accepted", "accepted_reason": accept_reason.strip(), "decided_at": now()}
        save_challenge(directory, record)
        runtime.event(CHALLENGE, "succeeded", f"Design challenge attempt {record['attempt']} accepted by {actor_text(actor)}: {record['accepted_reason']}")
        return record
    if current is not None and current["status"] == "paused" and unchanged_since(directory, plan, current):
        raise ValueError(f"Design challenge attempt {current['attempt']} paused this run, and nothing it read has changed since: a rerun "
                         f"would only sample the same challenge again. Edit the task files, decisions.md or the PRD {edited_in(plan)}, then rerun the "
                         f"challenge: {resume_command(directory, herdr)}\nOr record an override and launch the workers: "
                         f"{resume_command(directory, herdr, accept=True)}\nA concern outside the feature files (the code at the base, the "
                         "policy) needs a new run.")
    running = directory / "challenge.running.json"
    attempt = max(current["attempt"] if current else 0, read_json(running)["attempt"] if running.exists() else 0) + 1
    read_pinned(plan)  # A brief that lost a required section is refused before anything is committed.
    commit_revision(runtime, attempt - 1)
    repin(directory, plan, runtime.policy)  # The moved base and the re-pinned files in one plan.json write.
    (directory / REVISION_INTENT).unlink()
    action_event(runtime.event, actor, "resume", f"rerunning the design challenge as attempt {attempt}")
    runtime.event(CHALLENGE, "running", f"Feature files re-pinned for design challenge attempt {attempt} on base {plan['base_commit']}")
    record = run_challenge(runtime, attempt, herdr, released=launch)
    if launch and record["status"] == "passed" and hold_pinned(plan):
        release_hold(runtime, record, actor, frozenset(), held=False)  # The operator asked for the launch before this attempt passed.
        action_event(runtime.event, actor, "resume", f"design challenge attempt {attempt} passed under --launch, hold released; launching the workers")
    return record


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


def deadline_met(directory: Path, node: str) -> bool:
    """Whether the controller accepted the lane's completion signal once its turn ended (`met_at`): its deadline is met
    while other lanes still work; once every lane's was accepted, wait_handoffs holds it to the latest lane deadline."""
    return bool(load_deadline(directory, node).get("met_at"))


def mark_deadline_met(directory: Path, node: str, at: float) -> None:
    """Record, once, that the lane's completion signal met its deadline while other lanes still work."""
    with question_lock(directory):
        deadline = load_deadline(directory, node)
        if not deadline.get("met_at"):
            save_json(directory / f"{node}.deadline.json", {**deadline, "met_at": iso(at)})


def resume_deadline(directory: Path, node: str, at: float) -> None:
    deadline = load_deadline(directory, node)
    if deadline["paused_at"]:
        deadline["paused_seconds"] = float(deadline["paused_seconds"]) + max(0.0, at - epoch(deadline["paused_at"]))
        deadline["paused_at"] = None
        save_json(directory / f"{node}.deadline.json", deadline)


def record_question(runtime, node: str, item: dict, clock=None) -> dict:
    """A `question` completion: kept as `<node>.question-<n>.json`, listed, and the lane's deadline paused. A fourth blocks.
    The event is followed by the run's `question` attention record (C44), on one line; the poll forgets it once answered."""
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
                                       f"`python -m workflow answer {directory} {node} {BY_OPERATOR} \"<text>\"`: {item['question']}")
    from .attention import attention
    asked = " ".join(item["question"].split())
    attention(directory, "question", f"Worker {node} asked question {number} of {MAX_QUESTIONS}: {asked}{'' if asked.endswith(('.', '?', '!')) else '.'} "
                                     f"Answer: python -m workflow answer {directory} {node} {BY_OPERATOR} \"<text>\"", node=node)
    return entry


# What the controller records when the session works again while its question waits: the operator typed in the pane,
# or something else woke the session (a background command it started ending). It never claims an answer.
PANE_ANSWER = "(no answer recorded: the worker's session worked again in its pane)"


def went_on(directory: Path, node: str) -> str | None:
    """What shows the worker went on from its latest question, or None: record_question moved that question's file away,
    so a completion file is its next signal; a saved handoff or a stop follows one. A stopped worker's pane is a shell."""
    for name, reason in (("stop", "stopped by the controller"), ("handoff", "its handoff saved"), ("completion", "its next completion signal written")):
        if (directory / f"{node}.{name}.json").exists():
            return reason
    return None


def record_answer(directory: Path, node: str, text: str, clock=None, delivered: bool | None = None, actor: str | None = None) -> dict:
    """The latest question's answer; the deadline restarts now. Refused when no question waits.

    `answer` records `delivered: false` and sets it once the text reached the worker, so a failed delivery can be
    retried. It also replaces PANE_ANSWER, which the controller records (without the flag) once the session works
    again: that deadline already runs, and the text still reaches the worker while it is on that question. Once it
    went on, the text would reach no question (or a shell), so nothing is recorded. `actor` (answer's --by) is kept as
    `answered_by`, with `via` when it ran from a Claude Code session.
    """
    if not text.strip():
        raise ValueError("The answer is empty")
    with question_lock(directory):
        questions = load_questions(directory, node)
        if not questions or questions[-1]["answer"] not in {None, PANE_ANSWER}:
            raise ValueError(f"Worker {node} has no unanswered question")
        reason = went_on(directory, node)
        if reason:
            raise ValueError(f"Worker {node} has no unanswered question: it went on from question {questions[-1]['n']} ({reason}); "
                             "nothing is typed into its pane")
        at = (clock or time.time)()
        questions[-1].update(answer=text, answered_at=iso(at))
        if actor is not None:
            questions[-1].update(actor_record(actor, "answered_by"))
        if delivered is not None:
            questions[-1]["delivered"] = delivered
        save_questions(directory, node, questions)
        resume_deadline(directory, node, at)
    return questions[-1]


def record_pane_answer(directory: Path, node: str, clock=None) -> dict | None:
    """The session works again while its latest question waits: PANE_ANSWER, and the deadline runs again.

    Checked and written under the lock: when `answer` recorded the answer meanwhile, nothing is recorded (None).
    """
    with question_lock(directory):
        questions = load_questions(directory, node)
        if not questions or questions[-1]["answer"] is not None:
            return None
        at = (clock or time.time)()
        questions[-1].update(answer=PANE_ANSWER, answered_at=iso(at))
        save_questions(directory, node, questions)
        resume_deadline(directory, node, at)
    return questions[-1]


def undelivered_answer(directory: Path, node: str, text: str) -> dict | None:
    """The latest question when `answer` recorded this text but never delivered it: a rerun delivers it, recording nothing.

    A different text is refused: a question is answered once, and its deadline already runs again. So is any rerun once
    the worker went on: the text would reach no question (or a shell).
    """
    questions = load_questions(directory, node)
    if not questions or questions[-1]["answer"] is None or questions[-1].get("delivered") is not False:
        return None
    entry = questions[-1]
    if entry["answer"] != text:
        raise ValueError(f"Question {entry['n']} of {node} is already answered and that answer was never delivered; "
                         f"rerun answer with the recorded text to deliver it: {entry['answer']!r}")
    reason = went_on(directory, node)
    if reason:
        raise ValueError(f"Question {entry['n']} of {node} is answered but that answer was never delivered, and the worker went on from it "
                         f"({reason}); nothing is typed into its pane")
    return entry


def mark_delivered(directory: Path, node: str, number: int, step: str = "delivered", typed_text: str | None = None) -> None:
    """One delivery step of the answer: `typed` once its text is in the pane (with `typed_text`, the exact text typed),
    `delivered` once it reached the worker."""
    with question_lock(directory):
        questions = load_questions(directory, node)
        questions[number - 1][step] = True
        if typed_text is not None:
            questions[number - 1]["typed_text"] = typed_text
        save_questions(directory, node, questions)


def pane_attachment(process: dict, background_id: str) -> str | None:
    """None when the pane's foreground runs `claude attach <background_id>` (attach-one's, or one typed by hand), else what it shows.

    `process` is `herdr pane process-info`'s: the pane's shell and every process of its foreground process group, so
    attach-one's `claude attach` is listed beside attach-one while it is attached, and attach-one alone while it waits.
    """
    foreground = process.get("foreground_processes") or []
    argvs = [item.get("argv") or [] for item in foreground]
    if any(argv[-2:] == ["attach", background_id] and any("claude" in Path(arg).name for arg in argv[:-2]) for argv in argvs):
        return None
    if not foreground:
        return "Herdr lists no foreground process in it"
    if all(item.get("pid") == process.get("shell_pid") for item in foreground):
        return "its shell is in the foreground (attach-one ended: a detach, an interrupt or a give-up)"
    others = [f"`{item.get('cmdline') or shlex.join(argv)}`" for item, argv in zip(foreground, argvs) if "attach-one" not in argv]
    return f"it runs {', '.join(others)}" if others else "attach-one is between two attaches"


def input_shown(screen: str, text: str) -> str | None:
    """None when the Claude Code input on the pane's screen (`herdr pane read`) holds `text`, else what the screen shows.

    The input is the last line starting with `❯` under a rule (a line of `─`, perhaps labelled), wrapped onto the lines
    below it down to the closing rule, or to the end of the screen when no rule closes it: Herdr's capture can end at the
    input (20 of the 25 sidecar `pane_busy` refusals on pine did, 17 of them on an empty input). The transcript above it never counts.
    Whitespace is ignored: a wrap may split a word. Both the sidecar's gate and `answer`'s Enter-only rerun read it.
    """
    lines = screen.splitlines()
    start = next((index for index in range(len(lines) - 1, 0, -1)
                  if lines[index].lstrip().startswith("❯") and lines[index - 1].lstrip().startswith("─")), None)
    if start is None:
        return "Herdr shows no Claude Code input line in it"
    end = next((index for index in range(start + 1, len(lines)) if lines[index].lstrip().startswith("─")), len(lines))
    held = " ".join(" ".join([lines[start].lstrip()[1:], *lines[start + 1:end]]).split())
    if held.replace(" ", "") == "".join(text.split()):
        return None
    return f"its input line shows {held!r}" if held else "its input line is empty"


def answer_text(directory: Path, node: str, answer: str) -> str:
    """What `answer` types into the worker's pane: the answer, then, in an automatic run, the deadline the controller holds
    the lane to, in UTC, as automatic._poll_handoffs applies it. That is the lane's own deadline, which the question's wait
    moved (automatic.lane_deadline), unless the lane's completion was accepted before (deadline_met): such a lane has none
    while another lane works or waits on its answer, and the latest lane deadline once every lane's completion was
    accepted. Recorded files decide it; the entry keeps the text it typed (`typed_text`) for a rerun after a failed Enter."""
    plan = read_json(directory / "plan.json")
    if not isinstance(plan.get("automatic"), dict):
        return answer  # Only an automatic run has a lane deadline.
    from .automatic import lane_deadline, latest_deadline
    runtime = SimpleNamespace(directory=directory, plan=plan)
    deadline = lane_deadline(runtime, node)
    if deadline is None:  # Never once the answer is recorded: a question's wait ends there.
        return answer
    if not deadline_met(directory, node):
        return f"{answer} [Controller: your deadline is now {iso(deadline)} (UTC); the time your question waited was added to it.]"
    workers = plan_workers(plan)
    latest = latest_deadline(runtime, workers) if all(deadline_met(directory, lane) for lane in workers) else None
    if latest is None:
        return (f"{answer} [Controller: your completion was accepted before this question, so no deadline applies to you while another "
                "lane works or waits on its answer; after that, the latest lane deadline does.]")
    return f"{answer} [Controller: your deadline is now {iso(latest)} (UTC), the latest lane deadline: every lane's completion was accepted.]"


def deliver_answer(directory: Path, node: str, entry: dict, use_herdr: bool = True) -> str:
    """Type the answer into the worker's Herdr pane (send-text, then Enter), or say how to type it after `claude attach`.

    Only a pane that shows the lane's session is typed into: once attach-one ended (a detach, an interrupt, a give-up)
    the pane is a shell, which would run the text, and between two attaches the text would wait for whatever reads the
    terminal next. `typed` is recorded once the text is in the pane, with that text (`typed_text`), so a rerun after a
    failed Enter presses Enter only, and only while the pane shows that text in the session's input: a session an update
    respawned (a new PID) has an empty one, and Enter there would submit nothing while the answer counted as delivered.
    An entry a controller before `typed_text` typed holds the bare answer, which is what it typed. The text is
    answer_text's: in an automatic run the answer and the deadline the controller holds the lane to.
    """
    receipt = read_json(directory / f"{node}.interactive.json")
    background_id = receipt.get("background_id")
    text = answer_text(directory, node, entry["answer"])
    if not use_herdr:
        to_type = "" if text == entry["answer"] else f"\nThe text to type, with the controller's deadline note: {text}"
        if entry.get("typed"):
            return (f"The answer is typed in the worker's session but not submitted: claude attach {background_id}, then press Enter "
                    "(type it first if the session's input does not hold it)" + to_type)
        return f"Type the answer in the worker's session: claude attach {background_id}" + to_type
    from .herdr import herdr, herdr_text
    terminals = directory / "terminals.json"
    mapping = read_json(terminals) if terminals.exists() else {}  # A run started without --herdr has none.
    if node not in mapping:
        raise RuntimeError(f"No Herdr pane is recorded for {node} in {terminals}")
    if not background_id:
        raise RuntimeError(f"No background session id is recorded for {node}; cannot tell whether its pane shows it")
    pane = mapping[node]["pane_id"]
    shown = pane_attachment((herdr("pane", "process-info", "--pane", pane).get("result") or {}).get("process_info") or {}, background_id)
    if shown:
        attach = shlex.join([sys.executable, "-m", "workflow.interactive", "attach-one", str(directory), "--node", node])
        raise RuntimeError(f"Pane {pane} ({node}) is not attached to its session {background_id}: {shown}; nothing is typed into it. "
                           f"Attach it again in that pane ({attach}) and rerun answer, or type the answer yourself after "
                           f"`claude attach {background_id}` (--no-herdr)")
    if entry.get("typed"):
        held = input_shown(herdr_text("pane", "read", pane, "--source", "visible"), entry.get("typed_text", entry["answer"]))
        if held:
            raise RuntimeError(f"Pane {pane} ({node}) does not show the answer typed before in its session's input: {held}; Enter is not "
                               "pressed. Look at the pane: the input may have lost it (a session an update respawned starts with an empty one)")
        herdr("pane", "send-keys", pane, "Enter")
        return f"Enter pressed in pane {pane} ({node}), whose session's input showed the answer typed before"
    try:
        herdr("pane", "send-text", pane, text)
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(f"Herdr did not confirm the text within {error.timeout:g}s, so it may be in pane {pane}'s input already: look "
                           "before rerunning answer, and if the input holds the text, press Enter there instead") from error
    mark_delivered(directory, node, entry["n"], "typed", typed_text=text)
    entry.update(typed=True, typed_text=text)
    herdr("pane", "send-keys", pane, "Enter")
    return f"Answer typed into pane {pane} ({node})"


# ---- CLI: python -m workflow resume | answer -------------------------------------------------------------------

def resume_main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m workflow resume", description="Rerun a paused design challenge on the edited feature "
                                     "files, or accept it with a reason; then launch the workers (and supervise an automatic run).")
    parser.add_argument("directory", type=Path)
    parser.add_argument("--accept-challenge", metavar="REASON", help="Record the override with this reason and continue without rerunning")
    parser.add_argument("--launch", action="store_true", help="A run held after a passing challenge: launch the workers (the challenge "
                                                              "reruns first when feature files changed)")
    parser.add_argument("--drop", metavar="N,M", help="With --launch: leave these numbered challenge notes out of the workers' prompts")
    parser.add_argument("--herdr", action="store_true", help="Attach the worker panes after the launch")
    add_actor_argument(parser)
    args = parser.parse_args(argv)
    directory = args.directory.resolve()
    try:
        action = "accept-challenge" if args.accept_challenge is not None else "resume --launch" if args.launch else "resume"
        actor = require_actor(args, action)
        if args.drop is not None and not args.launch:
            raise ValueError("--drop applies to resume --launch: it leaves notes out of the prompts of the workers that launch")
        dropped = parse_drop(args.drop)
    except ValueError as error:
        parser.exit(1, f"Blocked: {error}\nNothing was changed.\n")
    from langgraph.checkpoint.sqlite import SqliteSaver
    from .pipeline import Pipeline, build_pipeline, graph_config, outcome_lines, report, start_workers
    warning = stale_claude_warning()
    if warning:
        print(warning, file=sys.stderr)

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
                record = resume_challenge(runtime, args.accept_challenge, args.herdr, actor, args.launch, dropped)
            except BaseException:
                # A rerun that failed after its re-pin has moved the base and the files: the viewer refuses an export
                # whose base is not plan.json's, and shows the failed attempt's event. A refusal that changed nothing
                # keeps the lock short, so a supervisor's next step is not refused for it.
                if moved() != before:
                    print(f"Report: {export(Pipeline(directory))}")
                raise
            runtime = Pipeline(directory)  # The re-pinned plan on its current base: session receipts bind to its digest.
            # A pass the plan holds and nothing released: the hold record, its event and attention, as `start` writes them.
            if record["status"] == "paused" or hold(runtime, record, args.herdr):
                print(paused_message(directory, args.herdr))
                print(f"Report: {export(runtime)}")
                return
            start_workers(runtime, attach=args.herdr)
        print(f"Design challenge {record['status']} (attempt {record['attempt']}); workers launched: {', '.join(runtime.workers)}")
        if runtime.plan.get("automatic"):
            from .automatic import AWAITING_APPROVAL, supervise
            from .pipeline import approval_stop
            try:
                stopped = supervise(directory)
            except TransientInfraError as error:
                parser.exit(75, f"Interrupted: {error}\n")  # Resumable, like `automatic --live`.
            if stopped == AWAITING_APPROVAL:  # Finish "approval" (C51): the approve command and the open items.
                print(approval_stop(directory), end="")
                return
            print(f"Automatic run reached a verified feature branch. Evidence: {directory / 'report.html'}. No main merge or push.")
            print(outcome_lines(directory), end="")
            note = run_finished_note(directory, runtime.plan)
            if note:
                print(note)
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Blocked: {error}\nAll work/evidence retained at {directory}. No automatic fallback or push.\n{outcome_lines(directory)}")


def answer_command(directory: Path, node: str, text: str, herdr: bool = True) -> str:
    return f"{sys.executable} -m workflow answer {directory} {node} {BY_OPERATOR} {shlex.quote(text)}" + ("" if herdr else " --no-herdr")


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
    add_actor_argument(parser)
    args = parser.parse_args(argv)
    directory = args.directory.resolve()
    entry = delivered = None
    try:
        actor = require_actor(args, "answer")
        plan = read_json(directory / "plan.json")
        if args.node not in plan_workers(plan):
            raise ValueError(f"{args.node} is not a lane of this run ({', '.join(plan_workers(plan))})")
        entry = undelivered_answer(directory, args.node, args.text)
        if entry is None:
            entry = record_answer(directory, args.node, args.text, delivered=False, actor=actor)
            from .pipeline import append_event
            # A plain record, like a note's: no lane status, so an interrupted controller stays visible.
            append_event(directory, args.node, "note", f"Question {entry['n']} of {args.node} answered by {actor_text(actor)}")
            print(f"Recorded the answer to question {entry['n']} of {args.node}; its deadline runs again.")
        else:
            typed = " (typed into its pane, not submitted)" if entry.get("typed") else ""
            print(f"Question {entry['n']} of {args.node} was answered at {entry['answered_at']} and never delivered{typed}; delivering it now "
                  "(nothing is recorded again, and its deadline has run since).")
        print(deliver_answer(directory, args.node, entry, not args.no_herdr))
        delivered = True
        mark_delivered(directory, args.node, entry["n"])
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as error:
        if delivered:
            parser.exit(1, f"Blocked: {error}\nThe answer reached the worker but is not marked delivered; do not rerun answer for this question.\n")
        if entry is not None and entry.get("typed"):
            parser.exit(1, f"Blocked: {error}\nThe answer to question {entry['n']} was typed into the worker's pane but not submitted; its "
                           f"deadline runs. Rerunning from a Herdr pane presses Enter only, never types the text again, and only while the pane "
                           f"shows the answer in the session's input (a session an update respawned starts with an empty one):\n"
                           f"  {answer_command(directory, args.node, args.text)}\nor look at the pane and print the claude attach command to submit "
                           f"it yourself (press Enter if the session's input holds the answer, else type it first):\n"
                           f"  {answer_command(directory, args.node, args.text, herdr=False)}\n")
        if entry is not None:
            parser.exit(1, f"Blocked: {error}\nThe answer to question {entry['n']} stays recorded and its deadline runs, but it did not reach "
                           f"the worker. Deliver it by rerunning, from a Herdr pane:\n  {answer_command(directory, args.node, args.text)}\n"
                           f"or print the claude attach command and type it yourself:\n  {answer_command(directory, args.node, args.text, herdr=False)}\n")
        parser.exit(1, f"Blocked: {error}\n")
