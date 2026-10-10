"""`python -m workflow accept <run> --candidate <sha> --reason "<text>" --by operator` (docs/PRD_ACCEPT_OVERRIDE.md).

Records that the operator merged a blocked (or abandoned) run's candidate by hand, and why: the one operator-override run
outcome. `accept` reads Git and writes only inside the run directory; it never merges, fast-forwards or pushes, and never
rewrites another run's record (decisions.md [O1]). It is the operator's decision, so the maintainer is refused
(actor.OPERATOR_ONLY). It takes the supervisor and controller locks as `abandon` does and refuses while a controller holds
either ([L6]); it refuses while a recorded session of the run is still live, naming it (abandon first, then accept, [L13](e)).

It writes `<run>/accepted.json` ({version, run_id, candidate, reason, by, via?, accepted_at, on_main, review,
open_findings}, contracts/workflow/accepted.schema.json [L8]), validated against its schema and replaced atomically, and
one `controller` event with the status `succeeded` (`Accepted by the operator: <reason>`, [G3]). The candidate must be the
run's own candidate commit (brief.candidate_commit, [L3]); `--candidate` is resolved with `git rev-parse` first, so a short
prefix is accepted and the full sha is stored (design challenge note 5). `on_main` is whether the candidate is an ancestor
of the target's main/master/base branch, never fetched ([O4], [G2]); when it is not, the override is still recorded with
`on_main: false` and a warning is printed. `open_findings` are the findings open at acceptance ([L5]). accept resolves every
`review_blocked`/`controller_blocked` attention state, whatever its node, and writes no new attention record ([G3], [L11]).

Accept may follow abandon: it is the one command an abandoned run still allows ([O3]); the outcome becomes the override and
the abandon reason stays as history. Afterwards every command that would change the run refuses it (`refuse_accepted`), as
for an abandoned run; a second accept is refused with its own message, and `abandon` refuses an accepted run ([L13](b)). The
ledger counts the candidate as `accepted (override)` (ledger.py). `status`, `export` and `brief` still read the run.
"""
from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

from .actor import actor_record, actor_text, add_actor_argument, require_actor
from .checks import now
from .sessions import DEFAULT_REVIEWER, plan_workers, read_json, run_lock, save_json

ACCEPTED = "accepted.json"
ACCEPTED_VERSION = "1.0.0"


def accepted(directory: Path) -> dict | None:
    """The run's accept record, or None. An unreadable record still counts: the run was accepted (as abandon.abandoned)."""
    path = Path(directory) / ACCEPTED
    if not path.exists():
        return None
    try:
        record = read_json(path)
    except (OSError, ValueError):
        return {"reason": "accepted.json is unreadable", "by": None, "accepted_at": None, "review": "none", "open_findings": []}
    return record if isinstance(record, dict) else {"reason": "accepted.json is malformed", "by": None, "accepted_at": None,
                                                     "review": "none", "open_findings": []}


def refuse_accepted(directory: Path) -> None:
    """ValueError when the run's candidate was accepted by an operator override: only status, export and brief read it any more."""
    record = accepted(directory)
    if record is not None:
        raise ValueError(f"The run's candidate was accepted by the operator (override: {record.get('reason')}); it is integrated and "
                         "nothing changes it any more. status, export and brief still read it; follow it up with a new run: "
                         "launch <feature> --repo <target repo> --run-id <next> --follows <this run>")


def export_section(directory: Path) -> dict | None:
    """The top-level `accepted` of export 1.12.0 ([L8], design note 7): the record verbatim, validated against its schema;
    null for a run without one. A present-but-invalid accepted.json fails the export, naming the file, so a corrupt override
    never hides the run from the viewer silently (the viewer keeps its strict parse)."""
    path = Path(directory) / ACCEPTED
    if not path.exists():
        return None
    from jsonschema.exceptions import ValidationError
    from .verification import validate_schema
    try:
        item = read_json(path)
    except (OSError, ValueError) as error:
        raise ValueError(f"{ACCEPTED} ({path}) cannot be read: {error}") from error
    try:
        validate_schema("accepted", item)
    except ValidationError as error:
        raise ValueError(f"{ACCEPTED} ({path}) does not validate against accepted.schema.json: {error.message}") from error
    return item


def collect_open_findings(directory: Path, plan: dict) -> list[dict]:
    """Every finding open at acceptance ([L5]): the blocking P0/P1 (not resolved, accepted ones included, as pipeline's
    blocking rule) then the P2s whose disposition is `open` (as outcome.py), each `{severity, reviewer, title, lane}` where
    `title` is the review finding's message verbatim and `lane` is its `worker` when that is a lane id, else null. [] without
    a review.json."""
    from .export_state import review_section
    from .pipeline import blocking_findings
    section = review_section(directory)
    if section is None:
        return []
    findings = section["findings"]
    lanes = set(plan_workers(plan))
    ordered = [*blocking_findings(findings), *(item for item in findings if item.get("severity") == "P2" and item.get("disposition") == "open")]
    result = []
    for finding in ordered:
        worker = finding.get("worker")
        result.append({"severity": finding["severity"], "reviewer": finding.get("reviewer") or DEFAULT_REVIEWER,
                       "title": finding["message"], "lane": worker if worker in lanes else None})
    return result


def resolve_candidate(repository: str, revision: str) -> str:
    """The full 40-hex commit `revision` names in `repository` (`git rev-parse --verify <rev>^{commit}`); ValueError when it
    names no commit. A short prefix resolves to the full sha the record stores (design note 5)."""
    try:
        result = subprocess.run(["git", "-C", str(repository), "rev-parse", "--verify", "--quiet", f"{revision}^{{commit}}"],
                                capture_output=True, text=True)
    except (OSError, subprocess.SubprocessError) as error:
        raise ValueError(f"{repository} could not be read to resolve --candidate {revision}: {error}") from error
    sha = result.stdout.strip()
    if result.returncode != 0 or not sha:
        raise ValueError(f"--candidate {revision} is not a commit of {repository}")
    return sha


def target_branch(repository: str, plan: dict) -> str | None:
    """The branch [O4]'s on-main check reads: the target's `main`, else `master`, else the branch `prepare` recorded as the
    base (plan.source_branch); None when none of them resolves. The check never fetches ([G2])."""
    for branch in ("main", "master"):
        result = subprocess.run(["git", "-C", str(repository), "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}"], capture_output=True)
        if result.returncode == 0:
            return branch
    source = plan.get("source_branch")
    if isinstance(source, str) and source.strip():
        result = subprocess.run(["git", "-C", str(repository), "rev-parse", "--verify", "--quiet", source], capture_output=True)
        if result.returncode == 0:
            return source
    return None


def on_main(repository: str, candidate: str, plan: dict) -> tuple[bool, str | None]:
    """(whether `candidate` is an ancestor of the target's branch, a warning line when it is not). Never fetches ([O4], [G2])."""
    branch = target_branch(repository, plan)
    if branch is None:
        return False, f"No main, master or base branch in {repository} to check the candidate against: recorded with on_main: false."
    ancestor = subprocess.run(["git", "-C", str(repository), "merge-base", "--is-ancestor", candidate, branch], capture_output=True).returncode == 0
    if ancestor:
        return True, None
    return False, f"Candidate {candidate[:12]} is not an ancestor of {branch} in {repository} (never fetched): recorded with on_main: false."


def live_nodes(runtime) -> list[str]:
    """The run's recorded sessions that are still live, by exact id, read-only (it stops nothing). As abandon's loop, but it
    lists only when a node has a receipt and collects the live ones instead of stopping them ([L13](e)).

    A node abandon already confirmed not running (named in abandon.json's `stopped` or `not_running`) is not live and needs no
    listing: abandon confirmed it under the same locks and refuse_abandoned has blocked any relaunch since. A node the run
    itself confirmed stopped (`<node>.stop.json` with `stopped: true`, what Pipeline.stop_workers/stop_reviewer write on a
    review block) is not live either, and its skip needs no listing. The listing is taken lazily, only when a node past those
    confirmed-stop checks still might run (as abandon's rows()): so accept on a run whose every recorded node is confirmed
    stopped records even while `claude agents` is down, whether or not the run was abandoned (widening of [L14], design
    challenge note 1; the blocked-but-not-abandoned case the coverage review named)."""
    from .abandon import abandoned, listed_live, recorded_nodes, unbound_live
    from .pipeline import pid_alive
    directory = runtime.directory
    nodes = recorded_nodes(runtime.plan, directory)
    record = abandoned(directory)
    settled = {*(record.get("stopped") or []), *(record.get("not_running") or [])} if record is not None else set()
    nodes = [node for node in nodes if node not in settled]
    if not nodes:
        return []
    listing: list = []

    def rows() -> list[dict]:
        # Listed once, and only when a node past the confirmed-stop checks needs it (as abandon.rows()): accept records while
        # `claude agents` is down when every remaining node is already confirmed stopped.
        if not listing:
            listing.append(runtime.sessions.inventory())
        return listing[0]
    live = []
    for node in nodes:
        receipt = read_json(directory / f"{node}.interactive.json")
        marker = directory / f"{node}.stop.json"
        if marker.exists():
            intent = read_json(marker)
            if intent.get("stopped") is True:
                continue
            pid = intent.get("pid")
            if listed_live(rows(), intent, receipt) or (isinstance(pid, int) and pid > 0 and pid_alive(pid)):
                live.append(node)
        elif (listed_live(rows(), receipt) if receipt.get("background_id") else unbound_live(runtime, node, rows())):
            live.append(node)
    return live


def resolve_blocked_attention(directory: Path) -> None:
    """Resolve every attention state whose kind is review_blocked or controller_blocked, whatever its node ([G3], [L11]);
    accept writes no new attention record."""
    from . import attention
    for item in attention.states(attention.load_record(directory)):
        if item.get("kind") in {"review_blocked", "controller_blocked"}:
            attention.resolved(directory, item["kind"], node=item.get("node"))


def accept(runtime, candidate_arg: str, reason: str, actor: str) -> dict:
    """Record the operator override. Refuses a second accept (its own message), a run that integrated normally, a run with no
    candidate, a `--candidate` that is not the run's, and a run with a live recorded session; writes nothing on a refusal.
    Writes accepted.json atomically (validated), one event, and resolves the run's review/controller-blocked attention."""
    directory = runtime.directory
    if accepted(directory) is not None:  # Before any abandoned guard ([L11]): a second accept never rewrites the first.
        raise ValueError(f"The run was already accepted by the operator (override: {accepted(directory).get('reason')}); nothing was changed")
    if (directory / "integration-intent.json").exists():
        raise ValueError("The run integrated normally: its candidate is already the reviewed integration, not an operator override")
    from .brief import candidate_commit
    own = candidate_commit(directory)
    if own is None:
        raise ValueError("The run has no candidate yet: nothing to accept")
    repository = runtime.plan.get("repository")
    if not repository:
        raise ValueError("The run's plan records no repository: accept reads Git to resolve the candidate")
    candidate = resolve_candidate(repository, candidate_arg)
    if candidate != own:
        raise ValueError(f"--candidate {candidate_arg} ({candidate[:12]}) is not the run's candidate ({own[:12]}, brief.candidate_commit)")
    live = live_nodes(runtime)
    if live:
        raise ValueError(f"The run still has a live recorded session ({', '.join(live)}): abandon it first (abandon <run> --reason ... "
                         "--by operator), then accept. Nothing was recorded")
    on_main_flag, warning = on_main(repository, candidate, runtime.plan)
    review = "recorded" if (directory / "review.json").exists() else "none"
    record = {"version": ACCEPTED_VERSION, "run_id": runtime.plan["run_id"], "candidate": candidate, "reason": reason,
              **actor_record(actor), "accepted_at": now(), "on_main": on_main_flag, "review": review,
              "open_findings": collect_open_findings(directory, runtime.plan)}
    from .verification import validate_schema
    validate_schema("accepted", record)
    save_json(directory / ACCEPTED, record)
    runtime.event("controller", "succeeded", f"Accepted by {actor_text(actor)}: {reason}")
    resolve_blocked_attention(directory)
    record["_warning"] = warning  # Not persisted (validated above); the command prints it.
    return record


def accept_main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m workflow accept", description="Record that the operator merged a blocked or "
                                     "abandoned run's candidate by hand, and why: the operator-override run outcome. Reads Git, writes only "
                                     "inside the run directory. The operator's decision.")
    parser.add_argument("directory", type=Path)
    parser.add_argument("--candidate", required=True, help="The run's own candidate commit (a sha or a prefix); resolved in the run's repository")
    parser.add_argument("--reason", required=True, help="Why the candidate was accepted: recorded in accepted.json and on the timeline")
    add_actor_argument(parser)
    args = parser.parse_args(argv)
    directory = args.directory.resolve()
    try:
        actor = require_actor(args, "accept")
        if not args.reason.strip():
            raise ValueError("--reason must not be empty")
        if not (directory / "plan.json").is_file():
            raise ValueError(f"{directory} has no plan.json: name a run directory")
        from .pipeline import ExportRuntime, Pipeline, persisted_state, report
        with run_lock(directory, "automatic-supervisor.lock"), run_lock(directory):
            record = accept(Pipeline(directory, abandoned_ok=True, accepted_ok=True), args.candidate, args.reason.strip(), actor)
            recorded = (f"Accepted {directory}: {record['reason']}. Candidate {record['candidate'][:12]}, on_main: "
                        f"{str(record['on_main']).lower()}, review: {record['review']}, {len(record['open_findings'])} open finding(s). "
                        "status, export and brief still read it.")
            try:
                export_runtime = ExportRuntime(directory)
                report(export_runtime, persisted_state(export_runtime))  # run-state.json carries the override for the viewer.
            except Exception as error:  # The record stands: a rerun would be refused as a second accept.
                parser.exit(1, f"{recorded}\nThe export failed ({error}): the viewer still shows the run as before. Refresh it with "
                               f'python -m workflow export "{directory}"\n')
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Blocked: {error}\nNothing was recorded; all work/evidence retained at {directory}.\n")
    if record.get("_warning"):
        print(f"Warning: {record['_warning']}")
    print(recorded)
