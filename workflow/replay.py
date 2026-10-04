"""Replay recorded reviews with this checkout's reviewer prompt (C39): `python -m workflow.replay CASES --out DIR`.

A brief, the shared rubric or the derived verdict is measured on past runs before it ships. CASES is a JSON list:

    [{"case": "revamp-004", "run": "~/.local/state/md-manager-workflows/viewer-revamp/viewer-revamp-004",
      "reviewer": "coverage", "brief": "builtin:coverage"}]

`reviewer` is one of the run's reviewers (`review` for a run with the single built-in one). `brief`, optional, replaces the
brief the run pinned: `builtin:<id>` is this checkout's bundled brief, anything else a file. `repository`, optional, holds
the candidate when the plan's repository is gone.

Each case is copied to DIR/<case>/run: the run directory without what records a verdict (every reviewer's own files,
review.json, automatic-review*.json, events.jsonl, and the exports and checkpoint that repeat them), without worktrees,
caches and hidden files, and with the run's own paths (where it lies and where it ran) rewritten to the copy. The candidate
tree goes to DIR/<case>/run/review-worktree, where the controller puts the reviewers' checkout: `git archive` of the
candidate commit, or the base plus review.diff when the repository no longer holds it. No worktree or ref is added to any
repository, and nothing is written in the run directory.

Each sample is the print job _review_print starts for that reviewer, on the copy: print_review_prompt, print_command with
review_schema, the copy as its added directory and the tree as its working directory. Its output goes to
DIR/<case>/samples/<n>/, outside the copy, so no sample reads another's verdict. At most two jobs run at a time, and none
starts while the host's available memory is under --min-available-mb. DIR/tally.json gets each sample's raw verdict, the
verdict derived_verdict gives and its findings (severity and first sentence), with the cost and duration the job reported.
It is written after every sample; a rerun keeps the samples it holds and starts only the missing or failed ones. Whether a
sample found a case's expected subject stays a hand label.
"""
from __future__ import annotations

import argparse
import contextlib
import fnmatch
import hashlib
import json
import os
import re
import shutil
import subprocess
import tarfile
import time
import uuid
from pathlib import Path

from .automatic import derived_verdict, first_sentence, print_command, print_review_prompt, print_verdict, review_schema, reviewers
from .checks import now
from .launch import BUILTIN_PREFIX, reviewer_brief
from .pipeline import ExportRuntime
from .sessions import git, job_env, popen_claude, read_json, review_node, review_nodes, role_flags, save_json, terminate

MAX_JOBS = 2  # Print jobs at once: each is a Claude Code process of up to half a gigabyte on a shared host.
MIN_AVAILABLE_MB = 1536  # No job starts while the host's available memory (`free -m`) is under this.
LAUNCH_SPACING_SECONDS = 20  # Between two launches while memory is checked, so the check sees the job started before.
POLL_SECONDS = 5
TREE = "review-worktree"
CASE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
# The review's inputs, kept although they start like a review node's files.
REVIEW_INPUTS = frozenset({"review-bundle.json", "review.diff"})
# Run files a sample must not read, beside every reviewer's own `<review node>.*` (completion, output, prompt, receipts):
# the combined record and statuses, the timeline, the exports and checkpoint that repeat the verdict, attention and locks.
LEFT_OUT = ("review.json", "automatic-review*.json", "events.jsonl", "run-state.json", "report.html", "pipeline.sqlite", "attention.json", "*.lock")
CACHES = frozenset({"node_modules", "npm_config_cache", "xdg_cache_home"})
# Copied byte for byte: policy.json is pinned by its digest, and a diff is the candidate's own text.
VERBATIM = ("policy.json", "*.diff")


def recorded_directory(plan: dict) -> Path | None:
    """Where the run ran, which an archived run's files still name: prepare puts each lane's worktree at <run>/worktree-<lane>."""
    for node, item in (plan.get("nodes") or {}).items():
        worktree = Path(item.get("worktree") or "")
        if worktree.name == f"worktree-{node}":
            return worktree.parent
    return None


def left_out(name: str, nodes: list[str]) -> bool:
    """A run file that records a verdict or a reviewer's launch, which no sample may read."""
    if name in REVIEW_INPUTS:
        return False
    return any(name.startswith(f"{node}.") for node in nodes) or any(fnmatch.fnmatch(name, pattern) for pattern in LEFT_OUT)


def skipped(path: Path) -> bool:
    """A directory the copy leaves out: a worktree or repository (it holds `.git`), a cache, a hidden one or a link."""
    return path.name.startswith(".") or path.name in CACHES or path.is_symlink() or (path / ".git").exists()


def stage(source: Path, target: Path) -> None:
    """Copy the run at `source` to `target` without what a sample must not read, its own paths rewritten to the copy."""
    plan = read_json(source / "plan.json")
    nodes = review_nodes(plan)
    names = {str(source), str(source.resolve())} | ({str(recorded)} if (recorded := recorded_directory(plan)) else set())
    # Grouped, so that the lookahead holds for every name: a sibling such as <run>-2 is another directory, not the run's own.
    own = re.compile("(?:" + "|".join(re.escape(name) for name in sorted(names, key=len, reverse=True)) + r")(?![\w.-])")
    for folder, directories, files in os.walk(source):
        folder = Path(folder)
        relative = folder.relative_to(source)
        top = relative == Path(".")
        directories[:] = [name for name in directories if not skipped(folder / name) and not (top and left_out(name, nodes))]
        (target / relative).mkdir(parents=True, exist_ok=True)
        for name in files:
            path = folder / name
            if name.startswith(".") or path.is_symlink() or (top and left_out(name, nodes)):
                continue
            data = path.read_bytes()
            if not any(fnmatch.fnmatch(name, pattern) for pattern in VERBATIM):
                with contextlib.suppress(UnicodeDecodeError):
                    data = own.sub(lambda _: str(target), data.decode()).encode()
            copy = target / relative / name
            copy.write_bytes(data)
            os.chmod(copy, path.stat().st_mode & 0o777)


def has_commit(repository: Path, commit: str) -> bool:
    return subprocess.run(["git", "-C", str(repository), "cat-file", "-e", f"{commit}^{{commit}}"], capture_output=True).returncode == 0


def extract(repository: Path, commit: str, target: Path) -> None:
    """The commit's tracked files at `target`, from `git archive`: the repository gets no worktree, ref or file."""
    target.mkdir(parents=True)
    with subprocess.Popen(["git", "-C", str(repository), "archive", "--format=tar", commit], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as archive:
        with tarfile.open(fileobj=archive.stdout, mode="r|") as tar:
            tar.extractall(target, filter="tar")
    if archive.returncode != 0:
        raise RuntimeError(f"git archive {commit} in {repository} exited {archive.returncode}")


def candidate_tree(repository: Path, base: str, candidate: str, patch: Path, target: Path) -> str:
    """The candidate's files at `target`: `git archive` of the candidate, or, when the repository no longer holds it, of the
    base with `patch` (the run's review.diff, base to candidate) applied. Returns which of the two it did."""
    if not repository.is_dir():
        raise RuntimeError(f"The repository {repository} is gone; give the case a repository that holds its commits")
    if has_commit(repository, candidate):
        extract(repository, candidate, target)
        return "archive"
    if not has_commit(repository, base):
        raise RuntimeError(f"{repository} holds neither the candidate {candidate} nor the base {base}")
    extract(repository, base, target)
    # Without GIT_DIR, and with the tree's parent as a ceiling, git finds no repository: `git apply` patches plain files.
    env = {key: value for key, value in os.environ.items() if key not in {"GIT_DIR", "GIT_WORK_TREE"}}
    applied = subprocess.run(["git", "apply", "--whitespace=nowarn", str(patch)], cwd=target, capture_output=True, text=True,
                             env={**env, "GIT_CEILING_DIRECTORIES": str(target.parent)})
    if applied.returncode != 0:
        raise RuntimeError(f"review.diff does not apply to the base {base}: {applied.stderr.strip()}")
    return "base + review.diff"


def brief_text(value: str) -> str:
    """A substituted brief's text, read as prepare pins one: `builtin:<id>` is this checkout's bundled brief, else a file."""
    path = reviewer_brief(Path("."), value) if value.startswith(BUILTIN_PREFIX) else Path(value).expanduser()
    text = path.read_text()
    if not text.strip():
        raise ValueError(f"The brief {value} is empty")
    return text


def replayed_reviewer(runtime, reviewer_id: str, brief: str | None = None) -> dict:
    """The run's reviewer `reviewer_id`, with `brief` (a brief's text) in place of the one it pinned when given."""
    declared = reviewers(runtime)
    reviewer = next((item for item in declared if item["reviewer_id"] == reviewer_id), None)
    if reviewer is None:
        raise ValueError(f"{reviewer_id} is not a reviewer of {runtime.plan['run_id']} ({', '.join(item['reviewer_id'] for item in declared)})")
    return reviewer if brief is None else {**reviewer, "prompt": brief}


def replay_prompt(runtime, reviewer_id: str, brief: str | None = None) -> str:
    """What _review_print writes as that reviewer's stdin (print_review_prompt on the run's review.diff), `brief` substituted."""
    return print_review_prompt(runtime, runtime.directory / "review.diff", replayed_reviewer(runtime, reviewer_id, brief))


def prompt(directory: Path, reviewer_id: str, brief: str | None = None) -> str:
    """replay_prompt for the run at `directory`, read as the export reads a finished run (ExportRuntime)."""
    return replay_prompt(ExportRuntime(directory), reviewer_id, brief)


def available_mb() -> int | None:
    """MemAvailable in MiB, what `free -m` shows as available; None where /proc/meminfo cannot be read."""
    with contextlib.suppress(OSError, ValueError, IndexError):
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) // 1024
    return None


def checkout_head() -> dict:
    """The commit of this checkout, whose prompts, rubric and schema the samples get, and whether it has local changes."""
    root = Path(__file__).resolve().parents[1]
    return {"head": git(root, "rev-parse", "HEAD"), "dirty": bool(git(root, "status", "--porcelain", "--", "workflow"))}


def load_cases(path: Path, out: Path) -> list[dict]:
    cases = json.loads(path.read_text())
    if not isinstance(cases, list) or not cases:
        raise ValueError("The cases file must hold a non-empty JSON list")
    names = set()
    for case in cases:
        if not isinstance(case, dict) or not {"case", "run", "reviewer"} <= set(case) or not set(case) <= {"case", "run", "reviewer", "brief", "repository"}:
            raise ValueError(f"A case needs case, run and reviewer, and may add brief and repository: {case!r}")
        if not isinstance(case["case"], str) or not CASE_NAME.fullmatch(case["case"]) or case["case"] in names:
            raise ValueError(f"Case names must be distinct plain names: {case['case']!r}")
        names.add(case["case"])
        run = Path(case["run"]).expanduser().resolve()
        if out.resolve().is_relative_to(run):
            raise ValueError(f"--out must lie outside the run directory {run}: nothing is written there")
    return cases


def prepare(case: dict, out: Path) -> dict:
    """The case's copy, candidate tree and prompt, as a job template; a copy an earlier invocation finished is kept."""
    source = Path(case["run"]).expanduser()
    folder = out / case["case"]
    copy = folder / "run"
    staged = folder / "staged.json"
    if not staged.exists():
        if copy.exists():
            shutil.rmtree(copy)  # An interrupted copy: staged.json is written last.
        stage(source, copy)
        plan, bundle = read_json(copy / "plan.json"), read_json(copy / "review-bundle.json")
        repository = Path(case.get("repository") or plan["repository"]).expanduser()
        tree = candidate_tree(repository, plan["base_commit"], bundle["candidate_commit"], copy / "review.diff", copy / TREE)
        save_json(staged, {"source": str(source), "repository": str(repository), "candidate_commit": bundle["candidate_commit"], "tree": tree, "staged_at": now()})
    runtime = ExportRuntime(copy)
    text = replay_prompt(runtime, case["reviewer"], brief_text(case["brief"]) if case.get("brief") else None)
    path = runtime.directory / f"{review_node(case['reviewer'])}.prompt.txt"
    path.write_text(text)
    os.chmod(path, 0o600)
    return {"name": case["case"], "case": case, "runtime": runtime, "reviewer_id": case["reviewer"], "node": review_node(case["reviewer"]),
            "prompt": path, "prompt_sha256": hashlib.sha256(text.encode()).hexdigest(), "tree": runtime.directory / TREE,
            "folder": folder, "timeout": runtime.plan["automatic"]["review_timeout_seconds"], "staged": read_json(staged)}


def launch(job: dict, executable: str) -> dict:
    """Start one sample as _review_print starts a reviewer's job; its output goes to DIR/<case>/samples/<n>/."""
    runtime = job["runtime"]
    folder = job["folder"] / "samples" / str(job["n"])
    folder.mkdir(parents=True, exist_ok=True)
    session_id = str(uuid.uuid4())
    command = print_command(executable, session_id, review_schema(runtime), [str(runtime.directory)], role_flags(runtime.plan, "judges"))
    env = job_env()
    output = folder / f"{job['node']}.stdout.json"
    with job["prompt"].open() as stdin, output.open("w") as stdout, (folder / f"{job['node']}.stderr.log").open("w") as stderr:
        process = popen_claude(command, cwd=job["tree"], env=env, stdin=stdin, stdout=stdout, stderr=stderr, text=True, start_new_session=True)
    return {**job, "process": process, "session_id": session_id, "output": output, "started": time.monotonic(), "started_at": now()}


def outcome(job: dict, timed_out: bool) -> dict:
    """One sample of the tally: accepted as the controller accepts a print job (print_verdict), its raw and derived verdicts,
    each finding's severity, disposition, lane and first sentence, and the cost and duration the job reported."""
    try:
        result = read_json(job["output"])
    except (OSError, ValueError):
        result = {}
    result = result if isinstance(result, dict) else {}
    record = {"sample": job["n"], "session_id": job["session_id"], "started_at": job["started_at"], "exit": job["process"].returncode,
              "stdout": str(job["output"]), "cost_usd": result.get("total_cost_usd"), "duration_ms": result.get("duration_ms"),
              "turns": result.get("num_turns"), "models": sorted(result.get("modelUsage") or {})}
    if timed_out:
        return {**record, "status": "failed", "error": f"Deadline exhausted: the run's review_timeout_seconds ({job['timeout']})"}
    try:
        decision = print_verdict(job["runtime"], job["reviewer_id"], job["process"], {"session_id": job["session_id"]}, job["output"])
    except Exception as error:
        return {**record, "status": "failed", "error": str(error), "subtype": result.get("subtype"), "result": str(result.get("result") or "")[:500]}
    return {**record, "status": "ok", "raw_verdict": decision["verdict"], "derived_verdict": derived_verdict(decision),
            "findings": [{"severity": finding["severity"], "disposition": finding["disposition"], "worker": finding["worker"],
                          "sentence": first_sentence(finding["message"])} for finding in decision["findings"]]}


def run_jobs(queue: list[dict], executable: str, jobs: int, min_available_mb: int, record) -> None:
    """Run the queued samples, at most `jobs` at a time; while memory is checked, no job starts under `min_available_mb` and
    launches are LAUNCH_SPACING_SECONDS apart. A job past the run's review deadline is stopped and recorded failed. `record`
    gets each finished job and its outcome; an interrupt stops the running jobs, which stay unrecorded."""
    running: list[dict] = []
    last_launch, waiting = None, False
    gated = min_available_mb > 0
    try:
        while queue or running:
            for job in list(running):
                finished = job["process"].poll() is not None
                if not finished and time.monotonic() < job["started"] + job["timeout"]:
                    continue
                if not finished:
                    terminate(job["process"])
                running.remove(job)
                record(job, outcome(job, timed_out=not finished))
            spaced = not gated or last_launch is None or time.monotonic() - last_launch >= LAUNCH_SPACING_SECONDS
            while queue and len(running) < jobs and spaced:
                available = available_mb() if gated else None
                if available is not None and available < min_available_mb:
                    if not waiting:
                        print(f"Waiting: {available} MB available, under {min_available_mb} MB", flush=True)
                    waiting = True
                    break
                waiting = False
                job = launch(queue.pop(0), executable)
                running.append(job)
                last_launch = time.monotonic()
                print(f"Started {job['name']} sample {job['n']} (session {job['session_id']}, {available if available is not None else '?'} MB available)", flush=True)
                spaced = not gated
            if running:
                with contextlib.suppress(subprocess.TimeoutExpired):
                    running[0]["process"].wait(timeout=POLL_SECONDS)  # Returns as soon as that job exits.
            elif queue:
                time.sleep(POLL_SECONDS)
    finally:
        for job in running:
            terminate(job["process"])


def summary(entry: dict) -> None:
    entry["raw_verdicts"] = [sample.get("raw_verdict") for sample in entry["samples"]]
    entry["derived_verdicts"] = [sample.get("derived_verdict") for sample in entry["samples"]]


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m workflow.replay", description="Replay recorded reviews with this checkout's reviewer "
                                     "prompt: N print jobs per case, each on a copy of its run without the recorded verdicts, tallied "
                                     "with the verdict the controller derives from the findings.")
    parser.add_argument("cases", type=Path, help="JSON list of cases: {case, run, reviewer, brief?, repository?}")
    parser.add_argument("--out", type=Path, required=True, help="Scratch directory for the copies, the samples' output and tally.json")
    parser.add_argument("--tally", type=Path, help="The tally file (default: OUT/tally.json)")
    parser.add_argument("--samples", type=int, default=3, choices=range(1, 11), metavar="N", help="Samples per case (default 3, at most 10)")
    parser.add_argument("--jobs", type=int, default=MAX_JOBS, choices=range(1, MAX_JOBS + 1), metavar="J", help=f"Jobs at a time (default and most {MAX_JOBS})")
    parser.add_argument("--min-available-mb", type=int, default=MIN_AVAILABLE_MB, help=f"Start no job under this available memory (default {MIN_AVAILABLE_MB}; 0 turns the check off)")
    parser.add_argument("--executable", default="claude", help="The Claude Code executable (default: claude)")
    parser.add_argument("--prepare-only", action="store_true", help="Copy the runs, extract the trees and write the prompts; start no job")
    args = parser.parse_args(argv)
    out = args.out.expanduser().resolve()
    try:
        cases = load_cases(args.cases, out)
    except (OSError, ValueError) as error:
        parser.exit(1, f"Blocked: {error}\n")
    tally_path = (args.tally or out / "tally.json").expanduser().resolve()
    tally = read_json(tally_path) if tally_path.exists() else {"cases": {}}
    tally.update(checkout_head(), cases_file=str(args.cases.resolve()))
    out.mkdir(parents=True, exist_ok=True)
    queue = []
    for case in cases:
        name = case["case"]
        entry = tally["cases"].setdefault(name, {"samples": []})
        try:
            job = prepare(case, out)
        except Exception as error:  # A case that cannot be rebuilt is skipped and said; the others still run.
            entry.update(skipped=str(error), run=case["run"], reviewer=case["reviewer"])
            print(f"Skipped {name}: {error}", flush=True)
            continue
        if entry["samples"] and entry.get("prompt_sha256") != job["prompt_sha256"]:
            parser.exit(1, f"Blocked: {name}'s prompt changed since its tallied samples; replay into a new --out\n")
        entry.pop("skipped", None)
        entry.update(run=case["run"], reviewer=case["reviewer"], brief=case.get("brief"), candidate_commit=job["staged"]["candidate_commit"],
                     tree=job["staged"]["tree"], copy=str(job["runtime"].directory), prompt=str(job["prompt"]), prompt_sha256=job["prompt_sha256"])
        print(f"{name}: {job['prompt']} ({job['prompt'].stat().st_size} bytes), tree from {job['staged']['tree']}", flush=True)
        done = {sample["sample"] for sample in entry["samples"] if sample.get("status") == "ok"}
        queue.extend({**job, "n": n} for n in range(1, args.samples + 1) if n not in done)
    save_json(tally_path, tally)
    if args.prepare_only:
        print(f"Prepared; {len(queue)} print job(s) would run. Tally: {tally_path}")
        return

    def record(job: dict, sample: dict) -> None:
        entry = tally["cases"][job["name"]]
        entry["samples"] = sorted([item for item in entry["samples"] if item["sample"] != job["n"]] + [sample], key=lambda item: item["sample"])
        summary(entry)
        save_json(tally_path, tally)
        blocking = sum(finding["severity"] in {"P0", "P1"} and finding["disposition"] != "resolved" for finding in sample.get("findings", []))
        print(f"{job['name']} sample {job['n']}: " + (f"{sample['raw_verdict']}, derived {sample['derived_verdict']} ({blocking} open P0/P1 of "
                                                      f"{len(sample['findings'])})" if sample["status"] == "ok" else f"failed: {sample['error']}")
              + f", ${sample['cost_usd'] or 0:.2f}", flush=True)

    print(f"{len(queue)} print job(s) to run, at most {args.jobs} at a time. Tally: {tally_path}", flush=True)
    try:
        run_jobs(queue, args.executable, args.jobs, args.min_available_mb, record)
    except KeyboardInterrupt:
        parser.exit(130, "Interrupted: the running jobs were stopped; a rerun starts the samples the tally lacks.\n")
    for name, entry in tally["cases"].items():
        if "skipped" in entry:
            print(f"{name}: skipped ({entry['skipped']})")
        else:
            print(f"{name}: raw {entry.get('raw_verdicts')}, derived {entry.get('derived_verdicts')}")


if __name__ == "__main__":
    main()
