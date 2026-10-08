"""Named Claude Code skills pinned for a lane (RUNBOOK "Skills for a lane (feature.json 2.8.0)").

A feature.json 2.8.0 lane may declare `skills: ["<name>", ...]`. Each name resolves to
`~/.claude/skills/<name>/SKILL.md` on the controller's host (symlinks followed); the controller copies the
folder into the run's own plugin tree `<run>/skills/<lane>/skills/<name>/` and pins its digest, so a later
edit of the operator's skill folder changes no running run. This module has only the pure functions that
resolve, check, copy and digest those folders; `launch.py` and `pipeline.py` call them, the two interactive
launches (`interactive.py`) read the pins. Standard library only; `skills_root` and `home` are injected so
tests never touch the real `~/.claude`.
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
from pathlib import Path

# PRD section 3: 1 to 8 unique names, each ^[a-z][a-z0-9-]{0,63}$.
SKILL_NAME = re.compile(r"[a-z][a-z0-9-]{0,63}")
MAX_SKILLS = 8
MAX_FILE_BYTES = 2 * 1024 * 1024   # PRD 4.2: no file over 2 MB.
MAX_TOTAL_BYTES = 8 * 1024 * 1024  # PRD 4.5: a skill folder over 8 MB in total is refused.


def skills_root(home: Path | None = None) -> Path:
    """`~/.claude/skills` under `home` (default: the operator's home)."""
    return (home or Path.home()) / ".claude" / "skills"


def plugin_dir(directory: Path, lane: str) -> Path:
    """The lane's pinned plugin tree `<run>/skills/<lane>`, the `--plugin-dir` a skills session launches with."""
    return Path(directory) / "skills" / lane


def plugin_json(lane: str, run_id: str) -> dict:
    """`<run>/skills/<lane>/.claude-plugin/plugin.json` (PRD 4.2)."""
    return {"name": f"workflow-{lane}", "description": f"Skills pinned for lane {lane} of run {run_id}", "version": "1.0.0"}


def validate_names(lane: str, names) -> list[str]:
    """The lane's declared skill names, refused (naming the lane and the name) when malformed, duplicated or out of
    bounds. The schema enforces the same on a 2.8.0 feature; this is the explicit guard for `launch` and `prepare`."""
    if not isinstance(names, list) or not (1 <= len(names) <= MAX_SKILLS):
        raise ValueError(f"feature.json workers[{lane}].skills must be 1 to {MAX_SKILLS} skill names")
    seen: set[str] = set()
    for name in names:
        if not isinstance(name, str) or not SKILL_NAME.fullmatch(name):
            raise ValueError(f"feature.json workers[{lane}].skills: {name!r} must match ^{SKILL_NAME.pattern}$")
        if name in seen:
            raise ValueError(f"feature.json workers[{lane}].skills lists {name} twice")
        seen.add(name)
    return list(names)


def _frontmatter_lines(text: str) -> list[str]:
    """The lines of a SKILL.md's leading `---`…`---` YAML frontmatter, or [] when it has none."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return []
    for index in range(1, len(lines)):
        if lines[index].strip() == "---":
            return lines[1:index]
    return []


def _declares_hooks(text: str) -> bool:
    """Whether the SKILL.md frontmatter declares a top-level `hooks` key (refused; `allowed-tools` is allowed)."""
    return any(re.match(r"hooks\s*:", line) for line in _frontmatter_lines(text))


def resolve_skill(lane: str, name: str, root: Path) -> Path:
    """The resolved skill folder `<root>/<name>` (symlinks followed), refused naming the lane and the skill when its
    `SKILL.md` does not exist or is not a regular file (Design: "symlinks followed"; PRD 4.5)."""
    folder = (Path(root) / name).resolve()
    manifest = folder / "SKILL.md"
    if not manifest.exists():  # exists() follows the link, so a dangling SKILL.md symlink is "does not exist"
        raise ValueError(f"Blocked: lane {lane} names skill {name}, but {Path(root) / name / 'SKILL.md'} does not exist")
    if not manifest.is_file():  # is_file() follows the link: a SKILL.md symlinked to a regular file resolves; a link to a directory or special node is refused
        raise ValueError(f"Blocked: lane {lane} skill {name}: {manifest} is not a regular file")
    return folder


def _walk(lane: str, name: str, folder: Path):
    """Yield `(relative_posix_path, real_file_path)` for every regular file under the resolved skill `folder`,
    following symlinks, skipping `.git`, refusing (naming the lane and the skill) a symlink that resolves outside
    the folder or forms a loop. Entries are visited in sorted order so a digest over them is stable."""
    root = str(Path(folder).resolve())
    seen: set[str] = set()

    def inside(target: str) -> bool:
        return target == root or target.startswith(root + os.sep)

    def descend(path: str, base: str):
        real = os.path.realpath(path)
        if real in seen:
            raise ValueError(f"Blocked: lane {lane} skill {name}: {base or '.'} forms a symlink loop")
        seen.add(real)
        for entry in sorted(os.scandir(path), key=lambda item: item.name):
            if entry.name == ".git":
                continue
            rel = f"{base}{entry.name}"
            target = os.path.realpath(entry.path)
            if not inside(target):
                raise ValueError(f"Blocked: lane {lane} skill {name}: {rel} resolves outside the skill folder")
            if entry.is_dir():  # follows a directory symlink, guarded by the loop and escape checks above
                yield from descend(entry.path, rel + "/")
            elif entry.is_file():
                yield rel, entry.path

    yield from descend(root, "")


def check_skill(lane: str, name: str, root: Path) -> Path:
    """Resolve the skill and refuse (PRD 4.5), without writing anything, a SKILL.md that is not a regular file, a
    `hooks` frontmatter, a file over 2 MB, a folder over 8 MB in total, or a symlink that escapes the folder or
    loops. Returns the resolved folder. `launch` and `prepare` both call it before anything is written."""
    folder = resolve_skill(lane, name, root)
    if _declares_hooks((folder / "SKILL.md").read_text(errors="replace")):
        raise ValueError(f"Blocked: lane {lane} skill {name}: SKILL.md declares hooks in its frontmatter, which a pinned skill may not")
    total = 0
    for rel, real in _walk(lane, name, folder):
        size = os.path.getsize(real)
        if size > MAX_FILE_BYTES:
            raise ValueError(f"Blocked: lane {lane} skill {name}: {rel} is {size} bytes, over the 2 MB a pinned file may hold")
        total += size
        if total > MAX_TOTAL_BYTES:
            raise ValueError(f"Blocked: lane {lane} skill {name}: the skill folder is over the 8 MB a pinned skill may hold")
    return folder


def skill_digest(lane: str, name: str, folder: Path) -> str:
    """The sha256 over the skill subtree's sorted relative paths and contents (PRD 4.2, note 4): the same skill text
    gives the same digest in two runs. Recorded per skill as `plan.nodes[<lane>].skills[].sha256`."""
    digest = hashlib.sha256()
    for rel, real in _walk(lane, name, folder):
        digest.update(rel.encode())
        digest.update(b"\0")
        digest.update(Path(real).read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def copy_skill(lane: str, name: str, folder: Path, destination: Path) -> None:
    """Copy the resolved skill subtree to `destination` as real files, following symlinks, skipping `.git`, with
    modes preserved (copy2 semantics) so an executable launcher stays executable (PRD 4.2, note 5)."""
    for rel, real in _walk(lane, name, folder):
        target = Path(destination) / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(real, target)  # real file, mode preserved; never a symlink


def tree_digest(directory: Path) -> str:
    """The sha256 over the whole pinned plugin tree (`plugin.json` included), its sorted relative paths and contents.
    Recorded as `plan.worker_authority.skills_sha256[<lane>]` (note 4); it changes with the run id in `plugin.json`."""
    directory = Path(directory)
    files = sorted(path for path in directory.rglob("*") if path.is_file())
    digest = hashlib.sha256()
    for path in files:
        digest.update(path.relative_to(directory).as_posix().encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def advisor_model(home: Path | None = None) -> str | None:
    """The operator's `advisorModel`, read once from `<home>/.claude/settings.json` and nothing else from the file; None
    when the key, the file or a readable JSON object is absent. A skills session gets the advisor back through this key
    in its `--settings` (PRD 4.1); every other key of the operator's settings is lost under `--setting-sources ""`."""
    import json
    path = (home or Path.home()) / ".claude" / "settings.json"
    try:
        document = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    if isinstance(document, dict) and isinstance(document.get("advisorModel"), str):
        return document["advisorModel"]
    return None
