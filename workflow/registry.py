"""Auto-registration of a launched feature in md-manager's Projects registry (`server/projectsConfig.ts`).

`registry_entry` is pure: the project entry for one target, feature, runs root and lane list. `merge_registry`
is pure too: it splices that entry into the registry text, replacing only the workflow with the same
`workflow_id` under the same `project_id` (or adding the project), so every other byte of the file is kept.
`register` holds a lock on the registry's directory across read, merge and write, so concurrent launches cannot drop
each other's entries, and writes through a symlinked registry to its target. Nothing here ever removes or rewrites
another entry.
"""
from __future__ import annotations

import contextlib
import fcntl
import json
import os
import re
import uuid
from pathlib import Path

from .export_state import definition

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


def registry_entry(target: Path, feature: str, runs_root: Path, lanes: list[str], challenge: bool = False) -> dict:
    """The project entry a launch registers: one workflow named after the feature, over every lane the feature declares.

    The workflow's definition is the feature's graph, not one run's: a `--workers` subset launch registers the same graph.
    `challenge` (a 2.2.0 feature that keeps its design challenge) puts the challenge node first.
    """
    name = repo_name(target)
    if not ID_PATTERN.fullmatch(feature):
        raise ValueError(f"Feature name is not a registry id: {feature}")
    return {"project_id": name.lower(), "name": name, "repository": str(target),
            "workflows": [{"workflow_id": feature, "runs_root": str(runs_root), "definition": definition(list(lanes), None, challenge)}]}


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
                workflow = {**workflow, "definition": definition(nodes_of(workflow), existing, has_challenge_node(workflow))}
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
