"""Auto-registration of a launched feature in md-manager's Projects registry (`server/projectsConfig.ts`).

`registry_entry` is pure: the project entry for one target, feature, runs root and lane list. `merge_registry`
is pure too: it splices that entry into the registry text, replacing only the workflow with the same
`workflow_id` under the same `project_id` (or adding the project), so every other byte of the file is kept.
`register` holds a lock on the registry's directory across read, merge and write, so concurrent launches cannot drop
each other's entries, and writes through a symlinked registry to its target. Nothing here ever removes or rewrites
another entry.

`registered_runs` reads every run under every registered runs root, for the launch notes on parallel work (C23):
`overlap_notes` names each owned path another feature's recent run on the same repository also owns.
"""
from __future__ import annotations

import contextlib
import fcntl
import json
import os
import re
import subprocess
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .export_state import definition
from .sessions import plan_workers, read_json
from .verification import owns

REGISTRY_ENV = "MD_MANAGER_PROJECTS_CONFIG"
REGISTRY_VERSION = 1
ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def registry_path(env: dict | None = None) -> Path:
    """`MD_MANAGER_PROJECTS_CONFIG` when set and not blank (as the server reads it), else `~/.config/md-manager/projects.json`."""
    setting = (os.environ if env is None else env).get(REGISTRY_ENV, "").strip()
    return Path(setting).expanduser().resolve() if setting else Path.home() / ".config/md-manager/projects.json"


def repo_name(target: Path) -> str:
    """The target directory's name restricted to [A-Za-z0-9._-]; other characters become `-`."""
    name = re.sub(r"[^A-Za-z0-9._-]", "-", target.name).lstrip("._-")[:128]
    if not ID_PATTERN.fullmatch(name):
        raise ValueError(f"Cannot derive a repository name from {target}")
    return name


def registry_entry(target: Path, feature: str, runs_root: Path, lanes: list[str], challenge: bool = False, sidecar: bool = False) -> dict:
    """The project entry a launch registers: one workflow named after the feature, over every lane the feature declares.

    The workflow's definition is the feature's graph, not one run's: a `--workers` subset launch registers the same graph.
    `challenge` (a 2.2.0 feature that keeps its design challenge) puts the challenge node first; `sidecar` (a 2.3.0
    feature that declares a review sidecar) adds the sidecar node after it, before every launch.
    """
    name = repo_name(target)
    if not ID_PATTERN.fullmatch(feature):
        raise ValueError(f"Feature name is not a registry id: {feature}")
    return {"project_id": name.lower(), "name": name, "repository": str(target),
            "workflows": [{"workflow_id": feature, "runs_root": str(runs_root), "definition": definition(list(lanes), None, challenge, sidecar)}]}


# A minimal position-aware JSON reader: enough to find the byte spans of the registry's projects and workflows.
DECODER = json.JSONDecoder()
WHITESPACE = re.compile(r"[ \t\n\r]*")


def skip(text: str, index: int) -> int:
    return WHITESPACE.match(text, index).end()


def expect(text: str, index: int, char: str) -> int:
    index = skip(text, index)
    if text[index:index + 1] != char:
        raise ValueError(f"Registry is not valid JSON: expected {char!r} at offset {index}")
    return index + 1


def object_members(text: str, index: int) -> tuple[dict, int]:
    """`{key: (value_start, value_end)}` of the object starting at `index`, and the index after its `}`."""
    index = expect(text, index, "{")
    members = {}
    index = skip(text, index)
    if text[index:index + 1] == "}":
        return members, index + 1
    while True:
        key, index = DECODER.raw_decode(text, skip(text, index))
        index = expect(text, index, ":")
        start = skip(text, index)
        _, index = DECODER.raw_decode(text, start)
        members[key] = (start, index)
        index = skip(text, index)
        if text[index:index + 1] == ",":
            index += 1
            continue
        return members, expect(text, index, "}")


def array_items(text: str, index: int) -> tuple[list[tuple[int, int]], int]:
    """The `(start, end)` span of every element of the array starting at `index`, and the offset of its `]`."""
    index = expect(text, index, "[")
    items = []
    index = skip(text, index)
    if text[index:index + 1] == "]":
        return items, index
    while True:
        start = skip(text, index)
        _, index = DECODER.raw_decode(text, start)
        items.append((start, index))
        index = skip(text, index)
        if text[index:index + 1] == ",":
            index += 1
            continue
        if text[index:index + 1] != "]":
            raise ValueError(f"Registry is not valid JSON: expected ']' at offset {index}")
        return items, index


def indentation(text: str, index: int) -> str:
    return text[text.rfind("\n", 0, index) + 1:index]


def rendered(value: dict, indent: str) -> str:
    """`value` as indented JSON whose continuation lines start at `indent`."""
    return json.dumps(value, indent=2, ensure_ascii=False).replace("\n", "\n" + indent)


def append_item(text: str, items: list, close: int, value: dict) -> str:
    """`value` appended after the last element of an array, in that element's indentation; into an empty array one level deeper."""
    if items:
        indent = indentation(text, items[-1][0])
        return text[:items[-1][1]] + ",\n" + indent + rendered(value, indent) + text[items[-1][1]:]
    line = indentation(text, close)
    base = line[:len(line) - len(line.lstrip())]
    indent = base + "  "
    return text[:close].rstrip() + "\n" + indent + rendered(value, indent) + "\n" + base + text[close:]


def nodes_of(workflow: dict) -> list[str]:
    """The lanes of a registered workflow, from its launch nodes (`launch_<lane>`)."""
    return [node["node_id"].removeprefix("launch_") for node in workflow["definition"]["nodes"] if node.get("kind") == "worker"]


def has_challenge_node(workflow: dict) -> bool:
    return any(node.get("node_id") == "challenge" for node in workflow["definition"]["nodes"])


def has_sidecar_node(workflow: dict) -> bool:
    return any(node.get("node_id") == "sidecar" for node in workflow["definition"]["nodes"])


def overlaps(left: str, right: str) -> bool:
    """Containment after resolving symlinks where the paths exist, as the server's `assertCanonicalRoots` does."""
    left, right = os.path.realpath(left), os.path.realpath(right)
    return left == right or left.startswith(right.rstrip(os.sep) + os.sep) or right.startswith(left.rstrip(os.sep) + os.sep)


def merge_registry(text: str | None, entry: dict) -> tuple[str | None, str]:
    """The new registry text with `entry` merged in, or None when nothing may be written, plus a note saying why.

    A missing file becomes `{version: 1, projects: [entry]}`. An existing project keeps its name, repository and
    every other workflow; only the workflow with the entry's `workflow_id` is replaced or added. A malformed
    registry is refused (ValueError), never rewritten. A runs root another workflow already covers is left alone.
    """
    workflow = entry["workflows"][0]
    where = f"{entry['project_id']}/{workflow['workflow_id']}"
    if text is None or not text.strip():
        return json.dumps({"version": REGISTRY_VERSION, "projects": [entry]}, indent=2, ensure_ascii=False) + "\n", f"Registry created with {where}"
    try:
        document = json.loads(text)
    except ValueError as error:
        raise ValueError(f"Registry is not valid JSON: {error}") from None
    if not isinstance(document, dict) or document.get("version") != REGISTRY_VERSION or not isinstance(document.get("projects"), list):
        raise ValueError(f"Registry must be {{\"version\": {REGISTRY_VERSION}, \"projects\": [...]}}; refusing to rewrite it")
    for project in document["projects"]:
        for other in project.get("workflows", []) if isinstance(project, dict) else []:
            if not isinstance(other, dict) or not isinstance(other.get("runs_root"), str):
                raise ValueError("Registry has a malformed workflow entry; refusing to rewrite it")
            if (project.get("project_id"), other.get("workflow_id")) == (entry["project_id"], workflow["workflow_id"]):
                continue
            if overlaps(other["runs_root"], workflow["runs_root"]):
                return None, (f"Registry not changed: {project.get('project_id')}/{other.get('workflow_id')} already covers "
                              f"{other['runs_root']}, which overlaps {workflow['runs_root']}")
    members, _ = object_members(text, 0)
    projects, close = array_items(text, members["projects"][0])
    for (start, end), project in zip(projects, document["projects"]):
        if not isinstance(project, dict) or project.get("project_id") != entry["project_id"]:
            continue
        if os.path.normpath(str(project.get("repository"))) != os.path.normpath(entry["repository"]):
            return None, (f"Registry not changed: project {entry['project_id']} already names the repository "
                          f"{project.get('repository')}, not {entry['repository']}")
        fields, _ = object_members(text, start)
        if "workflows" not in fields or not isinstance(project.get("workflows"), list):
            raise ValueError(f"Registry project {entry['project_id']} has no workflows list; refusing to rewrite it")
        workflows, workflows_close = array_items(text, fields["workflows"][0])
        for (item_start, item_end), existing in zip(workflows, project["workflows"]):
            if existing.get("workflow_id") == workflow["workflow_id"]:
                # The stored definition is kept verbatim (operator-edited labels included) while its nodes are unchanged.
                workflow = {**workflow, "definition": definition(nodes_of(workflow), existing, has_challenge_node(workflow), has_sidecar_node(workflow))}
                if existing == workflow:
                    return None, f"Registry already has {where}"
                indent = indentation(text, item_start)
                return text[:item_start] + rendered(workflow, indent) + text[item_end:], f"Registry updated {where}"
        return append_item(text, workflows, workflows_close, workflow), f"Registry added {where}"
    return append_item(text, projects, close, entry), f"Registry added project {entry['project_id']} with {where}"


def write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o600
    temporary = path.with_name(f".{path.name}.{uuid.uuid4()}.tmp")
    try:
        with temporary.open("x") as handle:
            os.chmod(temporary, mode)
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)  # Readers see the old file or the new one, never a partial write.
    finally:
        temporary.unlink(missing_ok=True)


def read_registry(path: Path) -> str | None:
    return path.read_text() if path.exists() else None


@contextlib.contextmanager
def locked(directory: Path):
    """An exclusive lock on the registry's directory, held by every registering launch; it adds no file."""
    directory.mkdir(parents=True, exist_ok=True)
    handle = os.open(directory, os.O_RDONLY)
    try:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield
    finally:
        os.close(handle)  # Closing releases the lock.


def register(path: Path, entry: dict) -> str:
    """Merge `entry` into the registry at `path` and write it atomically under the lock; returns what happened.

    A symlinked registry (for example a dotfiles-managed file) stays a symlink: its target is what gets replaced.
    """
    path = path.resolve() if path.is_symlink() else path
    with locked(path.parent):
        text, note = merge_registry(read_registry(path), entry)
        if text is not None:
            write_atomic(path, text)
    return note


# Run records for launch notes (C23). Reading only: a run that cannot be read is left out, never an error.
RECENT = timedelta(hours=48)  # A run with no event for longer is idle and gives no note.
FAST_FORWARDED = re.compile(r"^Fast-forwarded to ([0-9a-f]{40})\b")


def parse_time(value) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def run_record(directory: Path) -> dict | None:
    """One run directory: its plan, pinned policy (None before prepare pinned one), integration state, candidate commit and
    last event time; None when it has no readable plan."""
    try:
        plan = read_json(directory / "plan.json")
        if not isinstance(plan, dict):
            return None
    except (OSError, ValueError):
        return None
    def optional(name: str):
        try:
            return read_json(directory / name) if (directory / name).is_file() else None
        except (OSError, ValueError):
            return None
    events = []
    with contextlib.suppress(OSError, UnicodeDecodeError):
        for line in (directory / "events.jsonl").read_text().splitlines():
            with contextlib.suppress(ValueError):
                events.append(json.loads(line))
    events = [event for event in events if isinstance(event, dict)]
    integrated = None
    for event in events:
        found = FAST_FORWARDED.match(str(event.get("message", ""))) if event.get("node") == "integrate" and event.get("status") == "succeeded" else None
        integrated = found[1] if found else integrated
    # The candidate the run reviewed, else its latest candidate generation (candidate.json, then candidate-<g>.json).
    candidate = (optional("review-bundle.json") or {}).get("candidate_commit")
    if candidate is None:
        generations = {}
        for path in directory.glob("candidate*.json"):
            suffix = path.stem.removeprefix("candidate")
            if suffix == "" or (suffix.startswith("-") and suffix[1:].isdigit()):
                generations[int(suffix[1:] or 0)] = path
        candidate = (optional(generations[max(generations)].name) or {}).get("commit") if generations else None
    times = [parsed for parsed in (parse_time(event.get("time")) for event in events) if parsed]
    return {"directory": directory, "run_id": plan.get("run_id", directory.name), "plan": plan, "policy": optional("policy.json"),
            "integration": {"intent": (directory / "integration-intent.json").is_file(), "integrated_commit": integrated},
            "candidate_commit": candidate if isinstance(candidate, str) else None, "last_event": max(times) if times else None}


def runs_in(runs_root: Path) -> list[dict]:
    """Every readable run directly under a runs root, by name."""
    try:
        folders = sorted(item for item in runs_root.iterdir() if item.is_dir() and (item / "plan.json").is_file())
    except OSError:
        return []
    return [record for record in (run_record(folder) for folder in folders) if record is not None]


def registered_runs(path: Path | None = None) -> list[dict]:
    """Each run under each runs root the registry at `path` (default registry_path()) names, once per runs root, with its
    project_id, workflow_id and resolved runs_root. A missing or malformed registry has no runs."""
    try:
        document = json.loads((path or registry_path()).read_text())
    except (OSError, ValueError):
        return []
    runs, seen = [], set()
    for project in document.get("projects", []) if isinstance(document, dict) and isinstance(document.get("projects"), list) else []:
        for workflow in project.get("workflows", []) if isinstance(project, dict) and isinstance(project.get("workflows"), list) else []:
            if not isinstance(workflow, dict) or not isinstance(workflow.get("runs_root"), str):
                continue
            root = Path(workflow["runs_root"]).expanduser().resolve()
            if root in seen:
                continue
            seen.add(root)
            for record in runs_in(root):
                runs.append({**record, "project_id": project.get("project_id"), "workflow_id": workflow.get("workflow_id"), "runs_root": root})
    return runs


def previous_policy(runs_root: Path, current: Path) -> tuple[str, dict] | None:
    """The pinned policy of the feature's latest other run in `runs_root` (by the plan's created_at), with its run id."""
    pinned = [record for record in runs_in(runs_root) if record["directory"].resolve() != current.resolve() and isinstance(record["policy"], dict)]
    if not pinned:
        return None
    latest = max(pinned, key=lambda record: (str(record["plan"].get("created_at") or ""), record["directory"].name))
    return latest["run_id"], latest["policy"]


def read_git(path: Path, *arguments: str) -> tuple[int, str]:
    """A read-only Git command's exit code and output, (-1, "") when it cannot run. Popen, not subprocess.run: a dry run is
    checked by patching subprocess.run, and its notes still read Git."""
    try:
        with subprocess.Popen(["git", "-C", str(path), *arguments], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, text=True) as process:
            try:
                output, _ = process.communicate(timeout=30)
            except subprocess.TimeoutExpired:
                process.kill()
                return -1, ""
            return process.returncode, output.strip()
    except OSError:
        return -1, ""


def repository_identity(path: Path) -> tuple[str, frozenset] | None:
    """A checkout's git common directory and root commits; None when it is gone or not a repository."""
    code, common = read_git(path, "rev-parse", "--path-format=absolute", "--git-common-dir")
    roots_code, roots = read_git(path, "rev-list", "--max-parents=0", "HEAD")
    if code != 0 or roots_code != 0:
        return None
    return os.path.realpath(common), frozenset(roots.split())


def in_base(repository: Path, commit: str, base: str) -> bool:
    """`commit` is an ancestor of `base`; an unknown commit is not."""
    return read_git(repository, "merge-base", "--is-ancestor", commit, base)[0] == 0


def overlap_notes(repository: Path, lanes: list[dict], runs_root: Path, base: str, runs: list[dict] | None = None,
                  now: datetime | None = None) -> list[str]:
    """A launch note for each owned path of `lanes` (policy workers) that a run of another feature on the same repository
    also owns while its work is not in `base` (C23). Only runs from another runs root (a feature's own lanes are disjoint
    and its earlier runs superseded), with an event in the last RECENT. The same repository is the same git common
    directory (a linked worktree) or a shared root commit (a clone); a run whose checkout is gone is skipped. The work is in
    the base when its integrated, else its candidate, commit is an ancestor of `base`."""
    own = repository_identity(repository)
    if own is None:
        return []
    now = now or datetime.now(timezone.utc)
    runs = registered_runs() if runs is None else runs
    identities: dict[str, tuple | None] = {}
    notes = []
    for run in runs:
        if Path(run["runs_root"]).resolve() == runs_root.resolve() or run["last_event"] is None or now - run["last_event"] > RECENT:
            continue
        checkout = run["plan"].get("repository")
        if not isinstance(checkout, str) or not isinstance(run["policy"], dict):
            continue
        if checkout not in identities:
            identities[checkout] = repository_identity(Path(checkout)) if Path(checkout).is_dir() else None
        other = identities[checkout]
        if other is None or (other[0] != own[0] and not other[1] & own[1]):
            continue
        landed = run["integration"]["integrated_commit"] or run["candidate_commit"]
        if landed and in_base(repository, landed, base):
            continue
        try:
            selected = set(plan_workers(run["plan"]))
            claimed = [(worker["node_id"], path) for worker in run["policy"]["workers"] if worker["node_id"] in selected
                       for path in worker["owned_paths"] if isinstance(path, str)]
        except (KeyError, TypeError, ValueError):
            continue
        state = f"its candidate {landed[:12]} is not in this base" if landed else "no candidate yet"
        for worker in lanes:
            for path in worker["owned_paths"]:
                matches = [f"{other_path} (lane {other_lane})" for other_lane, other_path in claimed
                           if owns(path.rstrip("/"), other_path.rstrip("/")) or owns(other_path.rstrip("/"), path.rstrip("/"))]
                if matches:
                    hours = (now - run["last_event"]).total_seconds() / 3600
                    notes.append(f"Owned path {path} of lane {worker['node_id']} overlaps {', '.join(matches)} of run {run['run_id']} "
                                 f"(feature {run.get('workflow_id') or Path(run['runs_root']).name}, last event {hours:.0f} h ago), whose work is "
                                 f"not in this base: {state}. Check that the two runs do not conflict before merging either.")
    return notes
