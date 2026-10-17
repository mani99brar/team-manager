"""`python -m workflow github <push|pr|ready|reviewers> <run> --repo <checkout> --repo-name <o/n> --branch <b> --head <sha> ... --by operator`:
the four operator-confirmed GitHub actions on a run's branch (docs/PRD_RUN_TEAMS.md "GitHub actions"; RUNBOOK "GitHub actions").

The controller never pushes on its own: these commands are the only place it writes to a remote, and each runs only when
someone types it (or confirms it on the run page, which maps the dialog to exactly this argv, PRD_RUN_CONTROLS principle 1).
Every subcommand takes the identities the operator confirmed, `--repo-name owner/name`, `--branch` (the run branch) and
`--head` (its full commit sha), and refuses on any mismatch with what it reads now: the run's `plan.json` `source_branch`
must be `--branch`; `--repo` must be a checkout of the run's repository (the same Git common directory as
`plan.repository` while that checkout exists); `origin`'s fetch URLs (`git remote get-url --all origin`) and push URLs
(`git remote get-url --push --all origin`, which apply `pushurl`, `insteadOf` and `pushInsteadOf`) must all be github.com
remotes (https, ssh or scp form) naming one repository, `--repo-name`; `refs/heads/<branch>` must be at `--head`. Any
mismatch prints one `Blocked: ...` line and exits 2 without writing anything remote.

- `push`: the run must be integrated (run-state.json's `integrated_commit` with no next step) or accepted by the operator
  (`accepted.json`), and the branch head must be, or descend from, the run's integrated commit (run-state.json's
  `integrated_commit`, else the integrate node's `Fast-forwarded to <sha>` event, else the accepted candidate). The branch
  must be a valid ref name and neither GitHub's default branch (`gh api repos/<o>/<n> --jq .default_branch`, read-only; the
  local `refs/remotes/origin/HEAD` only when gh cannot tell, and refused when neither can) nor main, master, dev or develop;
  `git ls-remote origin` (read-only) must show the remote branch absent, or at an ancestor of the head. Then
  `git push --porcelain --no-follow-tags --no-recurse-submodules origin <head>:refs/heads/<b>`: never `--force`, never a
  `+` refspec, never a tag, never another branch.
- `pr --base B --title=T --body-file F`: `B` must be GitHub's default branch (read from GitHub; no local fallback); the
  remote branch must be at `--head`; no open same-repository pull request may have the branch as head (`gh pr list`, a
  fork's same-named branch is ignored); then `gh pr create --draft`. The title is 1-256 characters on one line and may
  start with `-` (pass it as `--title=T`); the body file must exist and hold at most 60000 bytes. Prints the pull request URL.
- `ready --pr N`: `gh pr view` must show the run branch as head (same repository) at `--head`, OPEN and draft; then `gh pr ready`.
- `reviewers --pr N --add a,b`: up to 15 GitHub logins or `org/team` slugs; the pull request must be the run branch's, at
  `--head` and OPEN; then `gh pr edit --add-reviewer`.

git and gh run as argv lists, never through a shell, with `GIT_TERMINAL_PROMPT=0` and `GH_PROMPT_DISABLED=1` so a missing
credential fails instead of prompting; the gh executable is `MD_MANAGER_GH` or `gh`, which keeps its own login (no token is
read or passed here). `python -m workflow` already turns Git hooks off for every git command it runs. Credentials in a URL
(`https://user:token@`) are cut from anything printed. The reads share a 180 s budget (a read that runs out is a refusal:
nothing was written) and the one write gets 120 s, so a command ends within about 300 s (the run page allows it 6 minutes).
A write that times out may have reached GitHub: it prints `Unknown: ... may have been published; check GitHub` and exits 3,
never `Blocked`. Nothing writes run state except one appended line per invocation in `<run>/github-actions.jsonl` (time,
action, actor, arguments without the body text, exit code, URL), under the run's `github.lock`, which two actions on one
run take one after the other (the second is refused while the first holds it); a record that cannot be appended prints a
warning and never changes the outcome (a write that succeeded still exits 0).
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path

from .actor import actor_record, add_actor_argument, require_actor

RECORDS = "github-actions.jsonl"
LOCK = "github.lock"
PROTECTED_BRANCHES = frozenset({"main", "master", "dev", "develop"})
MAX_TITLE = 256
MAX_BODY_BYTES = 60000
MAX_REVIEWERS = 15
GIT_TIMEOUT = 30
NETWORK_TIMEOUT = 120
CHECK_BUDGET = 180
WRITE_TIMEOUT = 120
EXIT_UNKNOWN = 3
LOGIN = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$")
TEAM = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$")
FULL_SHA = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
NAME = re.compile(r"^[A-Za-z0-9_.-]{1,100}$")
GITHUB_FORMS = (
    re.compile(r"^https://github\.com/([^/]+)/(.+?)(?:\.git)?/?$"),
    re.compile(r"^ssh://git@github\.com/([^/]+)/(.+?)(?:\.git)?/?$"),
    re.compile(r"^git@github\.com:([^/]+)/(.+?)(?:\.git)?/?$"),
)
CREDENTIAL_URL = re.compile(r"(\b[a-z][a-z0-9+.-]*://)[^/\s@]+@")
GITHUB_URL = re.compile(r"https://github\.com/\S+")
FAST_FORWARDED = re.compile(r"^Fast-forwarded to ([0-9a-f]{40})\b")

# The monotonic time by which every read must have finished; github_main sets it for each invocation.
_budget: dict = {"deadline": None}


class Blocked(Exception):
    """A refusal: printed as `Blocked: <message>`, exit 2, nothing written remotely."""


class Failed(Exception):
    """The git or gh write itself failed after every check passed: exit 1."""


class Unknown(Exception):
    """The git or gh write was cut off (timeout): it may have reached GitHub. Printed as `Unknown: ...`, exit 3."""


def scrub(text: str) -> str:
    """Text with any `scheme://user:secret@` credential cut, as printed and recorded."""
    return CREDENTIAL_URL.sub(r"\1", text)


def child_env() -> dict:
    env = dict(os.environ)
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GH_PROMPT_DISABLED"] = "1"
    return env


def gh_executable() -> str:
    return os.environ.get("MD_MANAGER_GH") or "gh"


def read_timeout(timeout: float) -> float:
    """The timeout of one read: its own bound, cut to what is left of the reads' shared budget (none left: a refusal)."""
    deadline = _budget["deadline"]
    if deadline is None:
        return timeout
    left = deadline - time.monotonic()
    if left <= 0:
        raise Blocked(f"the checks took longer than {CHECK_BUDGET} s; nothing was written")
    return min(timeout, left)


def run_child(argv: list[str], what: str, timeout: float, write: bool) -> subprocess.CompletedProcess:
    """One git or gh child. A read that cannot run or times out is a refusal; a write that times out is Unknown."""
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=WRITE_TIMEOUT if write else read_timeout(timeout),
                              env=child_env(), check=False)
    except subprocess.TimeoutExpired as error:
        if write:
            raise Unknown(f"{what} did not finish within {WRITE_TIMEOUT} s and was stopped: it may have been published; check GitHub") from error
        raise Blocked(f"{what} did not finish in time; nothing was written") from error
    except (OSError, subprocess.SubprocessError) as error:
        hint = "; install it or set MD_MANAGER_GH" if argv[0] == gh_executable() else ""
        raise Blocked(f"{what.split()[0]} could not run ({type(error).__name__}){hint}") from error


def git(repo: Path, *args: str, timeout: float = GIT_TIMEOUT, write: bool = False) -> subprocess.CompletedProcess:
    return run_child(["git", "-C", str(repo), *args], f"git {args[0]}", timeout, write)


def gh(*args: str, timeout: float = NETWORK_TIMEOUT, write: bool = False) -> subprocess.CompletedProcess:
    return run_child([gh_executable(), *args], f"gh {' '.join(args[:2])}", timeout, write)


def last_line(result: subprocess.CompletedProcess) -> str:
    lines = [line.strip() for line in (result.stderr or result.stdout or "").splitlines() if line.strip()]
    return scrub(lines[-1]) if lines else f"exit {result.returncode}"


def github_owner_name(url: str) -> str | None:
    """`owner/name` from one of the three github.com remote forms; None for anything else (server/dispatchGit.ts parseGithubRemote)."""
    for form in GITHUB_FORMS:
        match = form.match(url.strip())
        if match and all(NAME.match(part) and part not in {".", ".."} for part in match.groups()):
            return f"{match.group(1)}/{match.group(2)}"
    return None


def valid_branch(repo: Path, branch: object) -> bool:
    return (isinstance(branch, str) and bool(branch) and not branch.startswith("-") and "\n" not in branch
            and git(repo, "check-ref-format", f"refs/heads/{branch}").returncode == 0)


def common_dir(path: Path) -> Path | None:
    result = git(path, "rev-parse", "--path-format=absolute", "--git-common-dir")
    return Path(result.stdout.strip()).resolve() if result.returncode == 0 and result.stdout.strip() else None


def resolve_ref(repo: Path, ref: str) -> str | None:
    result = git(repo, "rev-parse", "--verify", "--quiet", "--end-of-options", f"{ref}^{{commit}}")
    value = result.stdout.strip()
    return value if result.returncode == 0 and re.fullmatch(r"[0-9a-f]{40,64}", value) else None


def remote_head(repo: Path, branch: str) -> str | None:
    """The remote branch's head as `git ls-remote origin` reports it now (read-only network); None when it is absent."""
    result = git(repo, "ls-remote", "--end-of-options", "origin", f"refs/heads/{branch}", timeout=NETWORK_TIMEOUT)
    if result.returncode != 0:
        raise Blocked(f"git ls-remote origin failed ({last_line(result)}); nothing was pushed")
    for line in result.stdout.splitlines():
        sha, _, ref = line.partition("\t")
        if ref.strip() == f"refs/heads/{branch}":
            return sha.strip()
    return None


def remote_urls(repo: Path, push: bool) -> list[str]:
    """origin's URLs as git uses them (`insteadOf` applied; for pushing also `pushurl` and `pushInsteadOf`); [] without origin."""
    result = git(repo, "remote", "get-url", *(["--push"] if push else []), "--all", "origin")
    return [line.strip() for line in result.stdout.splitlines() if line.strip()] if result.returncode == 0 else []


def local_default_branch(repo: Path) -> str | None:
    """origin's default branch as the local `refs/remotes/origin/HEAD` remembers it (it may be absent or stale)."""
    result = git(repo, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD")
    ref = result.stdout.strip()
    return ref.removeprefix("refs/remotes/origin/") if result.returncode == 0 and ref.startswith("refs/remotes/origin/") else None


def github_default_branch(repo: Path, owner_name: str) -> str | None:
    """The repository's default branch as GitHub reports it now (`gh api`, read-only); None when gh cannot tell."""
    try:
        result = gh("api", f"repos/{owner_name}", "--jq", ".default_branch")
    except Blocked:
        return None
    name = result.stdout.strip()
    return name if result.returncode == 0 and valid_branch(repo, name) else None


def integrated_commit(directory: Path) -> str | None:
    """The run's integrated commit: run-state.json's value, else the integrate node's `Fast-forwarded to` event (as
    registry.run_record reads it), else the operator-accepted candidate."""
    try:
        state = json.loads((directory / "run-state.json").read_text())
    except (OSError, ValueError):
        state = None
    values = state.get("values") if isinstance(state, dict) else None
    if isinstance(values, dict) and isinstance(values.get("integrated_commit"), str) and values["integrated_commit"]:
        return values["integrated_commit"]
    found = None
    try:
        lines = (directory / "events.jsonl").read_text().splitlines()
    except (OSError, UnicodeDecodeError):
        lines = []
    for line in lines:
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict) and event.get("node") == "integrate" and event.get("status") == "succeeded":
            match = FAST_FORWARDED.match(str(event.get("message", "")))
            found = match[1] if match else found
    if found:
        return found
    from .accept import accepted
    record = accepted(directory)
    candidate = record.get("candidate") if isinstance(record, dict) else None
    return candidate if isinstance(candidate, str) and candidate else None


def run_integrated(directory: Path) -> bool:
    """Integrated (the exported run-state.json has an integrated commit and no next step, as clean.finished) or accepted."""
    from .accept import accepted
    if accepted(directory) is not None:
        return True
    try:
        state = json.loads((directory / "run-state.json").read_text())
    except (OSError, ValueError):
        return False
    values = state.get("values") if isinstance(state, dict) else None
    return isinstance(values, dict) and bool(values.get("integrated_commit")) and not state.get("next")


@contextmanager
def action_lock(directory: Path):
    """One GitHub action per run at a time; a second is refused while the first holds `<run>/github.lock`."""
    with (directory / LOCK).open("a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise Blocked("another GitHub action of this run is running; wait for it to finish") from error
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def append_record(directory: Path, entry: dict) -> None:
    with (directory / RECORDS).open("a", encoding="utf-8") as handle:
        os.chmod(directory / RECORDS, 0o600)
        handle.write(json.dumps(entry, sort_keys=True) + "\n")


def record_or_warn(directory: Path, entry: dict) -> None:
    """Appends the record; one that cannot be written never changes the outcome, it prints a warning instead."""
    try:
        append_record(directory, entry)
    except OSError as error:
        print(f"Warning: the record could not be appended to {RECORDS} ({type(error).__name__}: {error.strerror or error})", file=sys.stderr)
        sys.stderr.flush()


class Context:
    """The run and repository facts every subcommand checks first, against the identities the operator confirmed."""

    def __init__(self, directory: Path, repo: Path, args):
        self.directory = directory
        plan_path = directory / "plan.json"
        try:
            plan = json.loads(plan_path.read_text())
        except (OSError, ValueError) as error:
            raise Blocked(f"{directory.name} is not a run directory (no readable plan.json)") from error
        if not isinstance(plan, dict):
            raise Blocked(f"{directory.name}'s plan.json is not an object")
        self.plan = plan
        head = args.head.lower()
        if not FULL_SHA.match(head):
            raise Blocked("--head must be the branch head's full commit sha (40 hexadecimal characters)")
        self.head = head
        if not repo.is_dir():
            raise Blocked("--repo is not a directory")
        self.repo = repo
        repo_common = common_dir(repo)
        if repo_common is None:
            raise Blocked("--repo is not a Git checkout")
        planned = plan.get("repository")
        if isinstance(planned, str) and Path(planned).is_dir():
            planned_common = common_dir(Path(planned))
            if planned_common is not None and planned_common != repo_common:
                raise Blocked("--repo is not a checkout of the run's repository (its Git directory differs from the run's)")
        branch = plan.get("source_branch")
        if not isinstance(branch, str) or not branch:
            raise Blocked("the run records no source_branch")
        if not valid_branch(repo, branch):
            raise Blocked(f"the run's source_branch {branch!r} is not a valid branch name")
        if branch != args.branch:
            raise Blocked(f"the run's branch is {branch}, not the confirmed {args.branch}; look at the run again")
        self.branch = branch
        fetch, push = remote_urls(repo, push=False), remote_urls(repo, push=True)
        if not fetch or not git(repo, "config", "--get", "remote.origin.url").stdout.strip():
            raise Blocked("the repository has no origin remote")
        fetch_names = {github_owner_name(url) for url in fetch}
        push_names = {github_owner_name(url) for url in push}
        if None in fetch_names or None in push_names or not push_names:
            raise Blocked("origin is not a github.com repository (https://github.com/o/n, ssh://git@github.com/o/n or git@github.com:o/n) "
                          "for fetching and for pushing")
        if len(fetch_names | push_names) != 1:
            raise Blocked(f"origin fetches from {', '.join(sorted(fetch_names))} but pushes to {', '.join(sorted(push_names))} "
                          "(pushurl or pushInsteadOf); a branch is pushed only to the repository it was checked against")
        owner_name = next(iter(fetch_names))
        if owner_name != args.repo_name:
            raise Blocked(f"origin is {owner_name}, not the confirmed {args.repo_name}; look at the run again")
        self.owner_name = owner_name

    def local_head(self) -> str:
        """The run branch's head, which must be the confirmed `--head`."""
        head = resolve_ref(self.repo, f"refs/heads/{self.branch}")
        if head is None:
            raise Blocked(f"the run branch {self.branch} is not in the repository")
        if head != self.head:
            raise Blocked(f"the run branch {self.branch} is at {head[:12]}, not the confirmed {self.head[:12]}; look at the run again")
        return head

    def open_pr(self, number: int, draft: bool | None) -> dict:
        """`gh pr view` for the pull request, checked to be the run branch's (same repository) at the confirmed head, with the
        local branch there too, and OPEN (and draft when asked)."""
        self.local_head()
        result = gh("pr", "view", str(number), "--repo", self.owner_name, "--json", "headRefName,headRefOid,isCrossRepository,isDraft,state")
        if result.returncode != 0:
            raise Blocked(f"gh pr view {number} failed ({last_line(result)})")
        try:
            view = json.loads(result.stdout)
        except ValueError as error:
            raise Blocked(f"gh pr view {number} printed no JSON") from error
        if not isinstance(view, dict) or view.get("headRefName") != self.branch or view.get("isCrossRepository") is not False:
            raise Blocked(f"pull request #{number} on {self.owner_name} is not from the run branch {self.branch}")
        if view.get("state") != "OPEN":
            raise Blocked(f"pull request #{number} is {str(view.get('state')).lower()}, not open")
        oid = view.get("headRefOid")
        if not isinstance(oid, str) or oid.lower() != self.head:
            raise Blocked(f"pull request #{number}'s head is {str(oid)[:12]}, not the confirmed {self.head[:12]}; look at the run again")
        if draft is True and view.get("isDraft") is not True:
            raise Blocked(f"pull request #{number} is not a draft (already ready for review)")
        return view


def do_push(context: Context, args) -> tuple[str, str | None]:
    if not run_integrated(context.directory):
        raise Blocked("the run is not integrated or accepted; only an integrated or accepted run's branch is pushed")
    branch = context.branch
    if branch in PROTECTED_BRANCHES:
        raise Blocked(f"{branch} is a default or protected branch; the run branch is pushed only under its own name")
    head = context.local_head()
    integrated = integrated_commit(context.directory)
    if integrated is None or resolve_ref(context.repo, integrated) is None:
        raise Blocked("the run's integrated commit is not recorded or not in this repository; nothing was pushed")
    if git(context.repo, "merge-base", "--is-ancestor", "--end-of-options", integrated, head).returncode != 0:
        raise Blocked(f"the run branch {branch} at {head[:12]} does not contain the run's integrated commit {integrated[:12]}; "
                      "only the integrated branch is pushed")
    default = github_default_branch(context.repo, context.owner_name) or local_default_branch(context.repo)
    if default is None:
        raise Blocked(f"the default branch of {context.owner_name} is not known (gh could not read it and origin/HEAD is not set: "
                      "git remote set-head origin --auto); nothing was pushed")
    if branch == default:
        raise Blocked(f"{branch} is a default or protected branch; the run branch is pushed only under its own name")
    remote = remote_head(context.repo, branch)
    if remote == head:
        raise Blocked(f"origin already has {branch} at {head[:12]}; nothing to push")
    if remote is not None:
        if resolve_ref(context.repo, remote) is None:
            raise Blocked(f"origin's {branch} is at {remote[:12]}, a commit this repository does not have; fetch and look before pushing")
        ancestor = git(context.repo, "merge-base", "--is-ancestor", "--end-of-options", remote, head)
        if ancestor.returncode != 0:
            raise Blocked(f"origin's {branch} has commits the run branch lacks ({remote[:12]} is not an ancestor of {head[:12]}); nothing was pushed")
    result = git(context.repo, "push", "--porcelain", "--no-follow-tags", "--no-recurse-submodules", "--end-of-options", "origin",
                 f"{head}:refs/heads/{branch}", write=True)
    if result.returncode != 0:
        raise Failed(f"git push failed ({last_line(result)})")
    return f"Pushed {head[:12]} to {context.owner_name} refs/heads/{branch} ({'new branch' if remote is None else 'fast-forward'}).", None


def do_pr(context: Context, args) -> tuple[str, str | None]:
    title, base = args.title, args.base
    if not title.strip() or len(title) > MAX_TITLE or "\n" in title or "\r" in title:
        raise Blocked(f"--title must be 1-{MAX_TITLE} characters on one line")
    if not valid_branch(context.repo, base) or base == context.branch:
        raise Blocked("--base must be a valid branch name other than the run branch")
    body = Path(args.body_file)
    try:
        size = body.stat().st_size if body.is_file() else None
    except OSError:
        size = None
    if size is None:
        raise Blocked("--body-file does not exist or is not a file")
    if size > MAX_BODY_BYTES:
        raise Blocked(f"--body-file holds {size} bytes; at most {MAX_BODY_BYTES}")
    head = context.local_head()
    default = github_default_branch(context.repo, context.owner_name)
    if default is None:
        raise Blocked(f"GitHub's default branch of {context.owner_name} could not be read (gh api); nothing was opened")
    if base != default:
        raise Blocked(f"the default branch of {context.owner_name} is {default} on GitHub, not --base {base}; look at the run again")
    remote = remote_head(context.repo, context.branch)
    if remote != head:
        state = "not on origin" if remote is None else f"on origin at {remote[:12]}, not at the confirmed {head[:12]}"
        raise Blocked(f"the run branch {context.branch} is {state}; push it first")
    listed = gh("pr", "list", "--repo", context.owner_name, "--head", context.branch, "--state", "open", "--json", "number,isCrossRepository")
    if listed.returncode != 0:
        raise Blocked(f"gh pr list failed ({last_line(listed)})")
    try:
        open_prs = json.loads(listed.stdout)
    except ValueError as error:
        raise Blocked("gh pr list printed no JSON") from error
    if not isinstance(open_prs, list):
        raise Blocked("gh pr list printed no list")
    # A fork's pull request from a same-named branch is not this branch's (Context.open_pr and the server ignore it too).
    own = [item for item in open_prs if not (isinstance(item, dict) and item.get("isCrossRepository") is True)]
    if own:
        numbers = ", ".join(f"#{item.get('number')}" for item in own if isinstance(item, dict))
        raise Blocked(f"a pull request from {context.branch} is already open ({numbers})")
    result = gh("pr", "create", "--repo", context.owner_name, "--head", context.branch, "--base", base, "--draft", f"--title={title}",
                "--body-file", str(body), write=True)
    if result.returncode != 0:
        raise Failed(f"gh pr create failed ({last_line(result)})")
    url = next(iter(GITHUB_URL.findall(result.stdout)), None)
    return (url or f"Draft pull request opened from {context.branch} into {base}."), url


def do_ready(context: Context, args) -> tuple[str, str | None]:
    context.open_pr(args.pr, draft=True)
    result = gh("pr", "ready", str(args.pr), "--repo", context.owner_name, write=True)
    if result.returncode != 0:
        raise Failed(f"gh pr ready failed ({last_line(result)})")
    return f"Pull request #{args.pr} on {context.owner_name} is ready for review.", f"https://github.com/{context.owner_name}/pull/{args.pr}"


def reviewer_list(text: str) -> list[str]:
    names = []
    for item in text.split(","):
        name = item.strip()
        if not name:
            continue
        if not (LOGIN.match(name) or TEAM.match(name)):
            raise Blocked(f"{name!r} is not a GitHub login or org/team slug")
        if name not in names:
            names.append(name)
    if not names:
        raise Blocked("--add names no reviewer")
    if len(names) > MAX_REVIEWERS:
        raise Blocked(f"--add names {len(names)} reviewers; at most {MAX_REVIEWERS}")
    return names


def do_reviewers(context: Context, args) -> tuple[str, str | None]:
    names = reviewer_list(args.add)
    context.open_pr(args.pr, draft=None)
    result = gh("pr", "edit", str(args.pr), "--repo", context.owner_name, "--add-reviewer", ",".join(names), write=True)
    if result.returncode != 0:
        raise Failed(f"gh pr edit failed ({last_line(result)})")
    return f"Requested review of #{args.pr} on {context.owner_name} from {', '.join(names)}.", f"https://github.com/{context.owner_name}/pull/{args.pr}"


ACTIONS = {"push": do_push, "pr": do_pr, "ready": do_ready, "reviewers": do_reviewers}


def recorded_args(args) -> dict:
    """The arguments a record keeps: the confirmed identities and the action's own, never the body text (its size only)."""
    common = {"repo_name": args.repo_name, "branch": args.branch, "head": args.head}
    if args.action == "push":
        return common
    if args.action == "pr":
        try:
            body_bytes = Path(args.body_file).stat().st_size
        except OSError:
            body_bytes = None
        return {**common, "base": args.base, "title": args.title, "body_bytes": body_bytes}
    if args.action == "ready":
        return {**common, "pr": args.pr}
    return {**common, "pr": args.pr, "add": args.add}


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="python -m workflow github", description="Operator-confirmed GitHub actions on a run's branch: push "
                                   "it (never forced), open a draft pull request, mark it ready, request reviewers. RUNBOOK \"GitHub actions\".")
    commands = root.add_subparsers(dest="action", required=True)

    def command(name: str, help_text: str) -> argparse.ArgumentParser:
        sub = commands.add_parser(name, help=help_text, description=help_text)
        sub.add_argument("directory", type=Path, help="The run directory")
        sub.add_argument("--repo", type=Path, required=True, help="A checkout of the run's repository (origin on github.com)")
        sub.add_argument("--repo-name", required=True, help="The confirmed GitHub owner/name; origin must fetch from and push to exactly it")
        sub.add_argument("--branch", required=True, help="The confirmed run branch; the run's source_branch must be it")
        sub.add_argument("--head", required=True, help="The confirmed full commit sha of the run branch's head")
        add_actor_argument(sub)
        return sub

    command("push", "Push the integrated run branch to origin at --head, never forced")
    pr = command("pr", "Open a draft pull request from the run branch into GitHub's default branch")
    pr.add_argument("--base", required=True, help="GitHub's default branch, as confirmed")
    pr.add_argument("--title", required=True, help="One line of 1-256 characters; write --title=T when it starts with -")
    pr.add_argument("--body-file", required=True)
    command("ready", "Mark the run branch's draft pull request ready for review").add_argument("--pr", type=int, required=True)
    reviewers = command("reviewers", "Request reviewers on the run branch's open pull request")
    reviewers.add_argument("--pr", type=int, required=True)
    reviewers.add_argument("--add", required=True, help="Comma-separated GitHub logins or org/team slugs, at most 15")
    return root


def github_main(argv=None, clock=None) -> None:
    command_parser = parser()
    args = command_parser.parse_args(argv)
    directory = args.directory.resolve()
    if getattr(args, "pr", None) is not None and args.pr <= 0:
        command_parser.exit(2, "Blocked: --pr must be a positive number\n")
    try:
        actor = require_actor(args, f"github {args.action}")
    except ValueError as error:
        command_parser.exit(2, f"Blocked: {error}\n")
    if not (directory / "plan.json").is_file():
        command_parser.exit(2, f"Blocked: {directory.name} is not a run directory (no plan.json)\n")
    from .guardrails import iso
    entry = {"time": iso((clock or time.time)()), "action": args.action, **actor_record(actor, "actor"), "args": recorded_args(args),
             "exit": None, "url": None}
    _budget["deadline"] = time.monotonic() + CHECK_BUDGET
    try:
        with action_lock(directory):
            context = Context(directory, args.repo.resolve(), args)
            line, url = ACTIONS[args.action](context, args)
    except Blocked as error:
        entry.update(exit=2, reason=scrub(str(error)))
        record_or_warn(directory, entry)
        command_parser.exit(2, f"Blocked: {scrub(str(error))}\n")
    except Failed as error:
        entry.update(exit=1, reason=scrub(str(error)))
        record_or_warn(directory, entry)
        command_parser.exit(1, f"Failed: {scrub(str(error))}\n")
    except Unknown as error:
        entry.update(exit=EXIT_UNKNOWN, outcome="unknown", reason=scrub(str(error)))
        record_or_warn(directory, entry)
        command_parser.exit(EXIT_UNKNOWN, f"Unknown: {scrub(str(error))}\n")
    finally:
        _budget["deadline"] = None
    entry.update(exit=0, url=url)
    print(scrub(line))
    sys.stdout.flush()
    record_or_warn(directory, entry)
