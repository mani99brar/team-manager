"""`python -m workflow github <push|pr|ready|reviewers>` (workflow/github.py; RUNBOOK "GitHub actions").

Every test builds a temporary bare origin and a clone whose origin URL reads as https://github.com/acme/widgets.git (a
local `url.<bare>.insteadOf` sends git's traffic to the bare repository, and a `git` wrapper first on PATH prints that
GitHub URL back where `git remote get-url` would print the bare path), so the only real push lands in that temporary
bare repository. gh is a fake script on MD_MANAGER_GH that records its argv and environment and prints canned answers.
HOME and CLAUDE_CONFIG_DIR point into the temporary root, global and system Git config are off, and nothing touches the
network, the real HOME, ~/.claude or GitHub."""
import contextlib
import shutil
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from . import github
from .github import github_main, github_owner_name, scrub

BRANCH = "feature/widgets/run-001"
OWNER_NAME = "acme/widgets"
GITHUB_URL = "https://github.com/acme/widgets.git"
ROOT = Path(__file__).resolve().parent.parent
REAL_GIT = shutil.which("git")
DEFAULT_ANSWERS = {"api repos/acme/widgets": {"stdout": "main\n"}}

FAKE_GH = """#!{python}
import json, os, sys
args = sys.argv[1:]
with open(os.environ["FAKE_GH_LOG"], "a") as handle:
    handle.write(json.dumps({{"argv": args, "prompt": os.environ.get("GH_PROMPT_DISABLED"), "git_prompt": os.environ.get("GIT_TERMINAL_PROMPT")}}) + "\\n")
answers = json.load(open(os.environ["FAKE_GH_ANSWERS"]))
answer = answers.get(" ".join(args[:2]), {{"stdout": "", "code": 0}})
sys.stdout.write(answer.get("stdout", ""))
sys.stderr.write(answer.get("stderr", ""))
sys.exit(answer.get("code", 0))
"""

# `git remote get-url` applies insteadOf, which here names the temporary bare origin: the wrapper prints it as the GitHub URL.
GIT_WRAPPER = """#!/bin/sh
case " $* " in
  *" remote get-url "*)
    out=$({git} "$@") || exit $?
    [ -n "$out" ] && printf '%s\\n' "$out" | sed 's|^{origin}$|{url}|'
    exit 0 ;;
  *) exec {git} "$@" ;;
esac
"""


def sh(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()


class Rig:
    """A run directory, a bare origin, a clone on a GitHub-looking URL and a fake gh."""

    def __init__(self, root: Path):
        self.root = root
        self.origin = root / "origin.git"
        self.repo = root / "repo"
        bin_dir = root / "bin"
        bin_dir.mkdir()
        wrapper = bin_dir / "git"
        wrapper.write_text(GIT_WRAPPER.format(git=REAL_GIT, origin=str(self.origin), url=GITHUB_URL))
        wrapper.chmod(0o755)
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(self.origin)], check=True, capture_output=True)
        subprocess.run(["git", "init", "-q", "-b", "main", str(self.repo)], check=True, capture_output=True)
        (self.repo / "a.txt").write_text("base\n")
        sh(self.repo, "add", ".")
        sh(self.repo, "commit", "-qm", "Base")
        sh(self.repo, "config", "remote.origin.url", GITHUB_URL)
        sh(self.repo, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*")
        sh(self.repo, "config", f"url.{self.origin}.insteadOf", GITHUB_URL)
        sh(self.repo, "push", "-q", "origin", "main")
        sh(self.repo, "fetch", "-q", "origin")
        sh(self.repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
        sh(self.repo, "switch", "-q", "-c", BRANCH)
        for n in (1, 2):
            (self.repo / "a.txt").write_text(f"change {n}\n")
            sh(self.repo, "commit", "-qam", f"Change {n}")
        sh(self.repo, "switch", "-q", "--detach", "main")
        self.head = sh(self.repo, "rev-parse", f"refs/heads/{BRANCH}")
        self.base = sh(self.repo, "rev-parse", "main")
        self.run = root / "runs" / "run-001"
        self.run.mkdir(parents=True)
        self.plan({"run_id": "run-001", "source_branch": BRANCH, "repository": str(self.repo)})
        self.integrated(self.head)
        self.gh = bin_dir / "gh"
        self.gh.write_text(FAKE_GH.format(python=sys.executable))
        self.gh.chmod(0o755)
        self.gh_log = root / "gh.jsonl"
        self.answers_file = root / "gh-answers.json"
        self.answer({})
        self.body = root / "body.md"
        self.body.write_text("### Widgets: run-001\n\nThe body text stays out of every record.\n")

    def plan(self, plan: dict) -> None:
        (self.run / "plan.json").write_text(json.dumps(plan))

    def integrated(self, sha: str | None) -> None:
        (self.run / "run-state.json").write_text(json.dumps({"values": {"integrated_commit": sha}, "next": []}))

    def answer(self, answers: dict) -> None:
        """gh's canned answers; GitHub's default branch is `main` unless the test says otherwise."""
        self.answers_file.write_text(json.dumps({**DEFAULT_ANSWERS, **answers}))

    def gh_calls(self) -> list[dict]:
        return [json.loads(line) for line in self.gh_log.read_text().splitlines()] if self.gh_log.exists() else []

    def records(self) -> list[dict]:
        path = self.run / "github-actions.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def remote(self, branch: str = BRANCH) -> str | None:
        result = subprocess.run(["git", "-C", str(self.origin), "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}"], capture_output=True, text=True)
        return result.stdout.strip() or None

    def call(self, *argv: str, by: str = "operator", repo_name: str = OWNER_NAME, branch: str = BRANCH, head: str | None = None,
             timeout_on=None) -> tuple[int, str, str, list[list[str]]]:
        """Runs github_main in-process with the confirmed identities (the head defaults to the branch's); `timeout_on(argv)`
        picks the children that time out. (exit code, stdout, stderr, every argv it ran through subprocess.run)."""
        confirmed = ["--repo-name", repo_name, "--branch", branch, "--head", head or self.head]
        ran: list[list[str]] = []
        real = subprocess.run

        def recording(command, *args, **kwargs):
            ran.append(list(command))
            if timeout_on is not None and timeout_on(list(command)):
                raise subprocess.TimeoutExpired(command, kwargs.get("timeout"))
            return real(command, *args, **kwargs)

        out, err = io.StringIO(), io.StringIO()
        code = 0
        with patch.object(github.subprocess, "run", side_effect=recording), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                github_main([argv[0], str(self.run), "--repo", str(self.repo), *confirmed, *argv[1:], *(["--by", by] if by else [])], clock=lambda: 1_790_000_000)
            except SystemExit as stop:
                code = stop.code if isinstance(stop.code, int) else 1
        return code, out.getvalue(), err.getvalue(), ran


class GithubCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        (root / "home").mkdir()
        self.env = patch.dict(os.environ, {
            "HOME": str(root / "home"), "CLAUDE_CONFIG_DIR": str(root / "claude-config"), "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": "Test", "GIT_AUTHOR_EMAIL": "test@example.invalid", "GIT_COMMITTER_NAME": "Test", "GIT_COMMITTER_EMAIL": "test@example.invalid",
            "PATH": f"{root / 'bin'}{os.pathsep}{os.environ.get('PATH', '')}", "MD_MANAGER_GH": str(root / "bin" / "gh"), "FAKE_GH_LOG": str(root / "gh.jsonl"), "FAKE_GH_ANSWERS": str(root / "gh-answers.json"),
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        os.environ.pop("CLAUDECODE", None)
        self.addCleanup(self.temp.cleanup)
        self.rig = Rig(root)

    def assertBlocked(self, result, pattern: str):
        code, out, err, _ran = result
        self.assertEqual(code, 2, (out, err))
        self.assertRegex(err, r"^Blocked: ")
        self.assertRegex(err, pattern)
        self.assertEqual(err.count("\n"), 1, "one line")


def is_push(command: list[str]) -> bool:
    return command[:1] == ["git"] and "push" in command


class PushTest(GithubCase):
    def test_push_publishes_the_run_branch_at_the_head_without_force_or_tags(self):
        result = self.rig.call("push")
        code, out, err, ran = result
        self.assertEqual(code, 0, err)
        self.assertEqual(out, f"Pushed {self.rig.head[:12]} to acme/widgets refs/heads/{BRANCH} (new branch).\n")
        self.assertEqual(self.rig.remote(), self.rig.head)
        pushes = [command for command in ran if is_push(command)]
        self.assertEqual(pushes, [["git", "-C", str(self.rig.repo), "push", "--porcelain", "--no-follow-tags", "--no-recurse-submodules", "--end-of-options",
                                   "origin", f"{self.rig.head}:refs/heads/{BRANCH}"]])
        for command in ran:
            self.assertNotIn("--force", command)
            self.assertNotIn("-f", command)
            self.assertFalse(any(arg.startswith("+") for arg in command))
            self.assertNotIn("bash", command[0])
        ls_remote = [command for command in ran if "ls-remote" in command]
        self.assertEqual(ls_remote, [["git", "-C", str(self.rig.repo), "ls-remote", "--end-of-options", "origin", f"refs/heads/{BRANCH}"]])
        self.assertIn(["git", "-C", str(self.rig.repo), "remote", "get-url", "--push", "--all", "origin"], ran)
        [record] = self.rig.records()
        self.assertEqual(record, {"time": "2026-09-21T14:13:20Z", "action": "push", "actor": "operator", "exit": 0, "url": None,
                                  "args": {"repo_name": OWNER_NAME, "branch": BRANCH, "head": self.rig.head}})
        self.assertEqual([call["argv"] for call in self.rig.gh_calls()], [["api", "repos/acme/widgets", "--jq", ".default_branch"]],
                         "push only reads GitHub's default branch")

    def test_push_follow_tags_config_publishes_no_tag(self):
        sh(self.rig.repo, "config", "push.followTags", "true")
        sh(self.rig.repo, "tag", "-a", "-m", "Unconfirmed", "v9", self.rig.head)
        code, _out, err, _ = self.rig.call("push")
        self.assertEqual(code, 0, err)
        self.assertEqual(self.rig.remote(), self.rig.head)
        self.assertEqual(sh(self.rig.origin, "tag", "--list"), "", "no tag reaches origin")

    def test_a_fast_forward_of_an_older_remote_branch_is_pushed(self):
        older = sh(self.rig.repo, "rev-parse", f"{BRANCH}~1")
        sh(self.rig.repo, "push", "-q", "origin", f"{older}:refs/heads/{BRANCH}")
        code, out, err, _ = self.rig.call("push")
        self.assertEqual(code, 0, err)
        self.assertIn("(fast-forward)", out)
        self.assertEqual(self.rig.remote(), self.rig.head)

    def test_an_accepted_run_is_pushed_when_the_branch_holds_the_accepted_candidate(self):
        self.rig.integrated(None)
        (self.rig.run / "accepted.json").write_text(json.dumps({"reason": "merged by hand", "by": "operator", "candidate": self.rig.head}))
        self.assertEqual(self.rig.call("push")[0], 0)

    def test_the_integrated_commit_comes_from_the_integrate_event_when_run_state_lacks_it(self):
        self.rig.integrated(None)
        (self.rig.run / "accepted.json").write_text(json.dumps({"reason": "merged by hand", "by": "operator"}))
        self.assertBlocked(self.rig.call("push"), r"integrated commit is not recorded")
        older = sh(self.rig.repo, "rev-parse", f"{BRANCH}~1")
        (self.rig.run / "events.jsonl").write_text(json.dumps({"node": "integrate", "status": "succeeded", "message": f"Fast-forwarded to {older}"}) + "\n")
        self.assertEqual(self.rig.call("push")[0], 0, "the head descends from the integrated commit")

    def test_a_branch_that_no_longer_holds_the_integrated_commit_is_refused(self):
        sh(self.rig.repo, "switch", "-q", "-c", "elsewhere", "main")
        (self.rig.repo / "e.txt").write_text("unreviewed\n")
        sh(self.rig.repo, "add", "e.txt")
        sh(self.rig.repo, "commit", "-qm", "Unreviewed")
        sh(self.rig.repo, "switch", "-q", "--detach", "main")
        self.rig.integrated(sh(self.rig.repo, "rev-parse", "elsewhere"))
        self.assertBlocked(self.rig.call("push"), rf"does not contain the run's integrated commit")
        self.assertIsNone(self.rig.remote())

    def test_refusals_push_nothing(self):
        self.rig.integrated(None)
        self.assertBlocked(self.rig.call("push"), r"not integrated or accepted")
        self.rig.integrated(self.rig.head)
        self.assertBlocked(self.rig.call("push", head="xyz"), r"--head must be the branch head's full commit sha")
        self.assertBlocked(self.rig.call("push", head=self.rig.head[:12]), r"--head must be the branch head's full")
        self.assertBlocked(self.rig.call("push", head=self.rig.base), rf"is at {self.rig.head[:12]}, not the confirmed {self.rig.base[:12]}")
        self.assertIsNone(self.rig.remote())
        self.assertEqual([record["exit"] for record in self.rig.records()], [2, 2, 2, 2])
        self.assertTrue(all("reason" in record for record in self.rig.records()))

    def test_the_confirmed_repository_and_branch_must_match(self):
        self.assertBlocked(self.rig.call("push", repo_name="acme/other"), r"origin is acme/widgets, not the confirmed acme/other")
        sh(self.rig.repo, "branch", "-f", "feature/widgets/other", self.rig.head)
        self.assertBlocked(self.rig.call("push", branch="feature/widgets/other"), rf"the run's branch is {BRANCH}, not the confirmed feature/widgets/other")
        self.assertIsNone(self.rig.remote())

    def test_a_push_destination_other_than_the_checked_repository_is_refused(self):
        sh(self.rig.repo, "config", "remote.origin.pushurl", "https://github.com/evil/fork.git")
        self.assertBlocked(self.rig.call("push"), r"origin fetches from acme/widgets but pushes to evil/fork")
        sh(self.rig.repo, "config", "--unset", "remote.origin.pushurl")
        sh(self.rig.repo, "config", "url.https://github.com/evil/.pushInsteadOf", "https://github.com/acme/")
        self.assertBlocked(self.rig.call("push"), r"but pushes to evil/widgets")
        sh(self.rig.repo, "config", "--unset", "url.https://github.com/evil/.pushInsteadOf")
        sh(self.rig.repo, "config", "--add", "remote.origin.pushurl", GITHUB_URL)
        sh(self.rig.repo, "config", "--add", "remote.origin.pushurl", "/somewhere/else.git")
        self.assertBlocked(self.rig.call("push"), r"origin is not a github.com repository")
        self.assertIsNone(self.rig.remote())

    def test_the_default_and_protected_branches_are_refused(self):
        for branch in ("main", "master", "dev", "develop"):
            sh(self.rig.repo, "branch", "-f", branch, self.rig.head)
            self.rig.plan({"source_branch": branch, "repository": str(self.rig.repo)})
            self.assertBlocked(self.rig.call("push", branch=branch), rf"{branch} is a default or protected branch")
        self.assertEqual(sh(self.rig.origin, "rev-parse", "main"), self.rig.base)

    def test_githubs_default_branch_is_refused_even_without_origin_head(self):
        sh(self.rig.repo, "branch", "-f", "trunk", self.rig.head)
        sh(self.rig.repo, "push", "-q", "origin", "main:refs/heads/trunk")
        sh(self.rig.repo, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD")
        self.rig.plan({"source_branch": "trunk", "repository": str(self.rig.repo)})
        self.rig.answer({"api repos/acme/widgets": {"stdout": "trunk\n"}})
        self.assertBlocked(self.rig.call("push", branch="trunk"), r"trunk is a default or protected branch")
        self.assertEqual(sh(self.rig.origin, "rev-parse", "trunk"), self.rig.base)

    def test_origin_head_is_the_fallback_only_when_gh_cannot_tell(self):
        sh(self.rig.repo, "branch", "-f", "trunk", self.rig.head)
        sh(self.rig.repo, "push", "-q", "origin", "main:refs/heads/trunk")
        sh(self.rig.repo, "fetch", "-q", "origin")
        sh(self.rig.repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk")
        self.rig.plan({"source_branch": "trunk", "repository": str(self.rig.repo)})
        self.rig.answer({"api repos/acme/widgets": {"code": 1, "stderr": "gh auth login\n"}})
        self.assertBlocked(self.rig.call("push", branch="trunk"), r"trunk is a default or protected branch")
        self.rig.plan({"source_branch": BRANCH, "repository": str(self.rig.repo)})
        sh(self.rig.repo, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD")
        self.assertBlocked(self.rig.call("push"), r"default branch of acme/widgets is not known")
        self.assertIsNone(self.rig.remote())

    def test_a_remote_branch_with_other_commits_is_refused(self):
        sh(self.rig.repo, "switch", "-q", "-c", "other", "main")
        (self.rig.repo / "b.txt").write_text("elsewhere\n")
        sh(self.rig.repo, "add", "b.txt")
        sh(self.rig.repo, "commit", "-qm", "Elsewhere")
        sh(self.rig.repo, "push", "-q", "origin", f"other:refs/heads/{BRANCH}")
        remote = self.rig.remote()
        self.assertBlocked(self.rig.call("push"), r"has commits the run branch lacks")
        self.assertEqual(self.rig.remote(), remote)

    def test_a_remote_head_this_repository_lacks_is_refused(self):
        other = self.rig.root / "other"
        subprocess.run(["git", "clone", "-q", str(self.rig.origin), str(other)], check=True, capture_output=True)
        (other / "c.txt").write_text("unseen\n")
        sh(other, "add", "c.txt")
        sh(other, "commit", "-qm", "Unseen")
        sh(other, "push", "-q", "origin", f"HEAD:refs/heads/{BRANCH}")
        self.assertBlocked(self.rig.call("push"), r"a commit this repository does not have")

    def test_nothing_to_push_when_origin_has_the_head(self):
        sh(self.rig.repo, "push", "-q", "origin", f"{BRANCH}:refs/heads/{BRANCH}")
        self.assertBlocked(self.rig.call("push"), r"already has .* nothing to push")

    def test_a_push_that_times_out_is_unknown_not_blocked(self):
        code, out, err, _ = self.rig.call("push", timeout_on=is_push)
        self.assertEqual(code, github.EXIT_UNKNOWN, (out, err))
        self.assertRegex(err, r"^Unknown: git push did not finish within 120 s and was stopped: it may have been published; check GitHub\n$")
        [record] = self.rig.records()
        self.assertEqual((record["exit"], record["outcome"]), (3, "unknown"))

    def test_a_read_that_times_out_is_a_refusal(self):
        self.assertBlocked(self.rig.call("push", timeout_on=lambda command: "ls-remote" in command), r"git ls-remote did not finish in time; nothing was written")

    def test_the_reads_share_one_budget(self):
        with patch.object(github, "CHECK_BUDGET", -1):
            self.assertBlocked(self.rig.call("push"), r"the checks took longer than -1 s; nothing was written")
        self.assertIsNone(self.rig.remote())

    def test_a_record_that_cannot_be_appended_after_a_push_still_exits_0(self):
        (self.rig.run / "github-actions.jsonl").mkdir()
        code, out, err, _ = self.rig.call("push")
        self.assertEqual(code, 0, err)
        self.assertIn("Pushed", out)
        self.assertRegex(err, r"^Warning: the record could not be appended to github-actions.jsonl")
        self.assertEqual(self.rig.remote(), self.rig.head)

    def test_run_and_repository_mismatches_are_refused(self):
        self.rig.plan({"source_branch": "bad..name", "repository": str(self.rig.repo)})
        self.assertBlocked(self.rig.call("push"), r"not a valid branch name")
        self.rig.plan({"source_branch": "-x", "repository": str(self.rig.repo)})
        self.assertBlocked(self.rig.call("push"), r"not a valid branch name")
        self.rig.plan({"repository": str(self.rig.repo)})
        self.assertBlocked(self.rig.call("push"), r"records no source_branch")
        self.rig.plan({"source_branch": "feature/widgets/absent", "repository": str(self.rig.repo)})
        self.assertBlocked(self.rig.call("push", branch="feature/widgets/absent"), r"is not in the repository")
        elsewhere = self.rig.root / "elsewhere"
        subprocess.run(["git", "init", "-q", str(elsewhere)], check=True, capture_output=True)
        self.rig.plan({"source_branch": BRANCH, "repository": str(elsewhere)})
        self.assertBlocked(self.rig.call("push"), r"not a checkout of the run's repository")
        self.rig.plan({"source_branch": BRANCH, "repository": str(self.rig.repo)})
        sh(self.rig.repo, "config", "remote.origin.url", "https://gitlab.com/acme/widgets.git")
        self.assertBlocked(self.rig.call("push"), r"origin is not a github.com repository")
        sh(self.rig.repo, "config", "--unset", "remote.origin.url")
        self.assertBlocked(self.rig.call("push"), r"has no origin remote")
        self.assertIsNone(self.rig.remote())

    def test_actor_rules_and_a_missing_run(self):
        self.assertBlocked(self.rig.call("push", by=""), r"requires --by operator")
        self.assertBlocked(self.rig.call("push", by="panel"), r"--by panel is refused")
        # Publishing is the operator's decision (actor.OPERATOR_ONLY): a maintainer session may not push or open a PR.
        self.assertBlocked(self.rig.call("push", by="maintainer"), r"--by maintainer is refused")
        self.assertEqual(self.rig.records(), [], "an actor refusal records nothing")
        (self.rig.run / "plan.json").unlink()
        self.assertBlocked(self.rig.call("push"), r"not a run directory")
        self.assertFalse((self.rig.run / "github-actions.jsonl").exists())
        (self.rig.run / "plan.json").write_text(json.dumps({"source_branch": BRANCH, "repository": str(self.rig.repo)}))
        code, _out, err, _ = self.rig.call("push", by="operator")
        self.assertEqual(code, 0, err)
        self.assertEqual(self.rig.records()[-1]["actor"], "operator")

    def test_a_second_action_is_refused_while_the_lock_is_held(self):
        import fcntl
        with (self.rig.run / "github.lock").open("a") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            self.assertBlocked(self.rig.call("push"), r"another GitHub action of this run is running")
        self.assertIsNone(self.rig.remote())

    def test_the_module_entry_dispatches_github(self):
        env = {**os.environ, "PYTHONPATH": str(ROOT)}
        helped = subprocess.run([sys.executable, "-m", "workflow", "github", "--help"], capture_output=True, text=True, cwd=ROOT, env=env)
        self.assertEqual(helped.returncode, 0, helped.stderr)
        for name in ("push", "pr", "ready", "reviewers"):
            self.assertIn(name, helped.stdout)
        result = subprocess.run([sys.executable, "-m", "workflow", "github", "push", str(self.rig.run), "--repo", str(self.rig.repo), "--repo-name", OWNER_NAME,
                                 "--branch", BRANCH, "--head", self.rig.head, "--by", "operator"], capture_output=True, text=True, cwd=ROOT, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.rig.remote(), self.rig.head)


class PullRequestTest(GithubCase):
    def pushed(self):
        sh(self.rig.repo, "push", "-q", "origin", f"{BRANCH}:refs/heads/{BRANCH}")

    def test_open_a_draft_pull_request(self):
        self.pushed()
        url = "https://github.com/acme/widgets/pull/12"
        self.rig.answer({"pr list": {"stdout": "[]\n"}, "pr create": {"stdout": f"Creating draft pull request\n{url}\n"}})
        code, out, err, _ = self.rig.call("pr", "--base", "main", "--title=Widgets: run-001", "--body-file", str(self.rig.body))
        self.assertEqual(code, 0, err)
        self.assertEqual(out, f"{url}\n")
        self.assertEqual([call["argv"] for call in self.rig.gh_calls()], [
            ["api", "repos/acme/widgets", "--jq", ".default_branch"],
            ["pr", "list", "--repo", OWNER_NAME, "--head", BRANCH, "--state", "open", "--json", "number,isCrossRepository"],
            ["pr", "create", "--repo", OWNER_NAME, "--head", BRANCH, "--base", "main", "--draft", "--title=Widgets: run-001", "--body-file", str(self.rig.body)],
        ])
        for call in self.rig.gh_calls():
            self.assertEqual((call["prompt"], call["git_prompt"]), ("1", "0"))
        [record] = self.rig.records()
        self.assertEqual(record["args"], {"repo_name": OWNER_NAME, "branch": BRANCH, "head": self.rig.head, "base": "main", "title": "Widgets: run-001",
                                          "body_bytes": self.rig.body.stat().st_size})
        self.assertEqual((record["exit"], record["url"]), (0, url))
        self.assertNotIn("stays out of every record", json.dumps(record))

    def test_a_title_that_starts_with_a_dash_is_a_title(self):
        self.pushed()
        self.rig.answer({"pr list": {"stdout": "[]\n"}, "pr create": {"stdout": "https://github.com/acme/widgets/pull/13\n"}})
        for title in ("-WIP- widgets", "--draft"):
            code, _out, err, _ = self.rig.call("pr", "--base", "main", f"--title={title}", "--body-file", str(self.rig.body))
            self.assertEqual(code, 0, err)
            self.assertEqual(self.rig.gh_calls()[-1]["argv"][-3], f"--title={title}")

    def test_a_fork_pull_request_from_the_same_branch_name_does_not_block(self):
        self.pushed()
        self.rig.answer({"pr list": {"stdout": '[{"number": 9, "isCrossRepository": true}]\n'}, "pr create": {"stdout": "https://github.com/acme/widgets/pull/14\n"}})
        code, _out, err, _ = self.rig.call("pr", "--base", "main", "--title=W", "--body-file", str(self.rig.body))
        self.assertEqual(code, 0, err)
        self.rig.answer({"pr list": {"stdout": '[{"number": 9, "isCrossRepository": true}, {"number": 10, "isCrossRepository": false}]\n'}})
        self.assertBlocked(self.rig.call("pr", "--base", "main", "--title=W", "--body-file", str(self.rig.body)), r"already open \(#10\)")

    def test_the_base_must_be_githubs_default_branch(self):
        self.pushed()
        self.rig.answer({"pr list": {"stdout": "[]\n"}, "api repos/acme/widgets": {"stdout": "trunk\n"}})
        self.assertBlocked(self.rig.call("pr", "--base", "main", "--title=W", "--body-file", str(self.rig.body)),
                           r"default branch of acme/widgets is trunk on GitHub, not --base main")
        self.rig.answer({"pr list": {"stdout": "[]\n"}, "api repos/acme/widgets": {"code": 1, "stderr": "HTTP 401\n"}})
        self.assertBlocked(self.rig.call("pr", "--base", "main", "--title=W", "--body-file", str(self.rig.body)), r"default branch of acme/widgets could not be read")
        self.assertNotIn("create", [call["argv"][1] for call in self.rig.gh_calls()])

    def test_the_confirmed_head_must_be_the_branch_head(self):
        older = sh(self.rig.repo, "rev-parse", f"{BRANCH}~1")
        self.pushed()
        self.rig.answer({"pr list": {"stdout": "[]\n"}})
        self.assertBlocked(self.rig.call("pr", "--base", "main", "--title=W", "--body-file", str(self.rig.body), head=older), r"not the confirmed")
        self.assertNotIn("create", [call["argv"][1] for call in self.rig.gh_calls()])

    def test_a_create_that_times_out_is_unknown(self):
        self.pushed()
        self.rig.answer({"pr list": {"stdout": "[]\n"}})
        code, _out, err, _ = self.rig.call("pr", "--base", "main", "--title=W", "--body-file", str(self.rig.body),
                                           timeout_on=lambda command: command[1:3] == ["pr", "create"])
        self.assertEqual(code, 3, err)
        self.assertRegex(err, r"^Unknown: gh pr create did not finish .* may have been published; check GitHub")
        self.assertEqual(self.rig.records()[-1]["exit"], 3)

    def test_refusals(self):
        self.rig.answer({"pr list": {"stdout": "[]\n"}})
        title = ["--title=Widgets"]
        body = ["--body-file", str(self.rig.body)]
        self.assertBlocked(self.rig.call("pr", "--base", "main", *title, *body), r"is not on origin; push it first")
        self.pushed()
        sh(self.rig.repo, "switch", "-q", BRANCH)
        (self.rig.repo / "a.txt").write_text("later\n")
        sh(self.rig.repo, "commit", "-qam", "Later")
        sh(self.rig.repo, "switch", "-q", "--detach", "main")
        later = sh(self.rig.repo, "rev-parse", BRANCH)
        self.assertBlocked(self.rig.call("pr", "--base", "main", *title, *body, head=later), r"on origin at .*, not at the confirmed")
        sh(self.rig.repo, "push", "-q", "origin", f"{BRANCH}:refs/heads/{BRANCH}")
        self.assertBlocked(self.rig.call("pr", "--base", "main", "--title", "two\nlines", *body, head=later), r"--title must be 1-256 characters on one line")
        self.assertBlocked(self.rig.call("pr", "--base", "main", "--title", "x" * 257, *body, head=later), r"--title must be")
        self.assertBlocked(self.rig.call("pr", "--base", "main", "--title", "  ", *body, head=later), r"--title must be")
        self.assertBlocked(self.rig.call("pr", "--base=-main", *title, *body, head=later), r"--base must be a valid branch name")
        self.assertBlocked(self.rig.call("pr", "--base", BRANCH, *title, *body, head=later), r"--base must be a valid branch name other than the run branch")
        self.assertBlocked(self.rig.call("pr", "--base", "main", *title, "--body-file", str(self.rig.root / "absent.md"), head=later), r"--body-file does not exist")
        big = self.rig.root / "big.md"
        big.write_text("x" * 60001)
        self.assertBlocked(self.rig.call("pr", "--base", "main", *title, "--body-file", str(big), head=later), r"holds 60001 bytes; at most 60000")
        self.rig.answer({"pr list": {"stdout": '[{"number": 7}]\n'}})
        self.assertBlocked(self.rig.call("pr", "--base", "main", *title, *body, head=later), r"already open \(#7\)")
        self.assertNotIn("create", [call["argv"][1] for call in self.rig.gh_calls()])

    def test_a_failed_create_exits_1_without_the_credential(self):
        self.pushed()
        self.rig.answer({"pr list": {"stdout": "[]"}, "pr create": {"code": 1, "stderr": "error: remote https://bot:ghp_secret123456789@github.com/acme/widgets.git refused\n"}})
        code, _out, err, _ = self.rig.call("pr", "--base", "main", "--title", "W", "--body-file", str(self.rig.body))
        self.assertEqual(code, 1)
        self.assertRegex(err, r"^Failed: gh pr create failed")
        self.assertNotIn("ghp_secret", err)
        self.assertNotIn("bot:", err)
        self.assertNotIn("ghp_secret", (self.rig.run / "github-actions.jsonl").read_text())


class ReadyAndReviewersTest(GithubCase):
    def view(self, **overrides):
        value = {"headRefName": BRANCH, "headRefOid": self.rig.head, "isCrossRepository": False, "isDraft": True, "state": "OPEN", **overrides}
        return {"stdout": json.dumps(value)}

    def test_mark_ready(self):
        self.rig.answer({"pr view": self.view()})
        code, out, err, _ = self.rig.call("ready", "--pr", "12")
        self.assertEqual(code, 0, err)
        self.assertEqual(out, "Pull request #12 on acme/widgets is ready for review.\n")
        self.assertEqual([call["argv"] for call in self.rig.gh_calls()], [
            ["pr", "view", "12", "--repo", OWNER_NAME, "--json", "headRefName,headRefOid,isCrossRepository,isDraft,state"],
            ["pr", "ready", "12", "--repo", OWNER_NAME],
        ])
        self.assertEqual(self.rig.records()[-1]["args"], {"repo_name": OWNER_NAME, "branch": BRANCH, "head": self.rig.head, "pr": 12})

    def test_ready_refusals(self):
        cases = [
            (self.view(headRefName="someone/else"), r"is not from the run branch"),
            (self.view(isCrossRepository=True), r"is not from the run branch"),
            (self.view(isCrossRepository=None), r"is not from the run branch"),
            (self.view(isDraft=False), r"is not a draft"),
            (self.view(state="CLOSED"), r"is closed, not open"),
            (self.view(headRefOid="c" * 40), rf"#12's head is cccccccccccc, not the confirmed {self.rig.head[:12]}"),
            (self.view(headRefOid=None), r"#12's head is None, not the confirmed"),
            ({"stdout": "not json"}, r"printed no JSON"),
            ({"code": 1, "stderr": "could not resolve to a PullRequest\n"}, r"gh pr view 12 failed \(could not resolve"),
        ]
        for answer, pattern in cases:
            self.rig.answer({"pr view": answer})
            self.assertBlocked(self.rig.call("ready", "--pr", "12"), pattern)
        self.assertBlocked(self.rig.call("ready", "--pr", "0"), r"--pr must be a positive number")
        self.assertNotIn("ready", [call["argv"][1] for call in self.rig.gh_calls()])

    def test_ready_refuses_when_the_local_branch_moved_from_the_confirmed_head(self):
        older = sh(self.rig.repo, "rev-parse", f"{BRANCH}~1")
        self.rig.answer({"pr view": self.view(headRefOid=older)})
        self.assertBlocked(self.rig.call("ready", "--pr", "12", head=older), rf"is at {self.rig.head[:12]}, not the confirmed {older[:12]}")
        self.assertEqual(self.rig.gh_calls(), [], "nothing reaches gh")

    def test_request_reviewers(self):
        self.rig.answer({"pr view": self.view(isDraft=False)})
        code, out, err, _ = self.rig.call("reviewers", "--pr", "12", "--add", "jaybuidl, acme/maintainers,jaybuidl")
        self.assertEqual(code, 0, err)
        self.assertEqual(out, "Requested review of #12 on acme/widgets from jaybuidl, acme/maintainers.\n")
        self.assertEqual(self.rig.gh_calls()[-1]["argv"], ["pr", "edit", "12", "--repo", OWNER_NAME, "--add-reviewer", "jaybuidl,acme/maintainers"])
        self.assertEqual(self.rig.records()[-1]["url"], "https://github.com/acme/widgets/pull/12")

    def test_reviewers_refuse_a_pull_request_at_another_head(self):
        self.rig.answer({"pr view": self.view(isDraft=False, headRefOid="d" * 40)})
        self.assertBlocked(self.rig.call("reviewers", "--pr", "12", "--add", "jaybuidl"), r"not the confirmed")
        self.assertNotIn("edit", [call["argv"][1] for call in self.rig.gh_calls()])

    def test_reviewer_refusals(self):
        self.rig.answer({"pr view": self.view()})
        self.assertBlocked(self.rig.call("reviewers", "--pr", "12", "--add=-rf"), r"not a GitHub login or org/team slug")
        self.assertBlocked(self.rig.call("reviewers", "--pr", "12", "--add", "a" * 40), r"not a GitHub login")
        self.assertBlocked(self.rig.call("reviewers", "--pr", "12", "--add", "a/b/c"), r"not a GitHub login")
        self.assertBlocked(self.rig.call("reviewers", "--pr", "12", "--add", " , "), r"names no reviewer")
        self.assertBlocked(self.rig.call("reviewers", "--pr", "12", "--add", ",".join(f"user{n}" for n in range(16))), r"names 16 reviewers; at most 15")
        self.assertEqual(self.rig.gh_calls(), [], "a bad list never reaches gh")
        self.rig.answer({"pr view": self.view(state="MERGED")})
        self.assertBlocked(self.rig.call("reviewers", "--pr", "12", "--add", "jaybuidl"), r"is merged, not open")


class HelpersTest(unittest.TestCase):
    def test_github_remote_forms(self):
        self.assertEqual(github_owner_name("https://github.com/kleros/vea.git"), "kleros/vea")
        self.assertEqual(github_owner_name("ssh://git@github.com/kleros/vea"), "kleros/vea")
        self.assertEqual(github_owner_name("git@github.com:kleros/vea.git"), "kleros/vea")
        self.assertIsNone(github_owner_name("https://gitlab.com/kleros/vea.git"))
        self.assertIsNone(github_owner_name("https://github.com/kleros/../x"))
        self.assertIsNone(github_owner_name("/home/someone/vea.git"))

    def test_scrub_cuts_url_credentials(self):
        self.assertEqual(scrub("fatal: https://user:tok@github.com/o/n.git"), "fatal: https://github.com/o/n.git")
        self.assertEqual(scrub("https://github.com/o/n/pull/1"), "https://github.com/o/n/pull/1")


if __name__ == "__main__":
    unittest.main()
