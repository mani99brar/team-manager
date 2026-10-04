"""`workflow clean` (C47): the operator's cleanup of a run's checkouts, with real Git worktrees and a stand-in session listing."""
import contextlib
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from . import clean
from .sessions import git, run_lock, save_json
from .worktrees import git_worktree


class CleanTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        (self.repo / "README.md").write_text("# Repo\n")
        for args in (["init", "-q", "-b", "main"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"],
                     ["add", "."], ["commit", "-qm", "Base"]):
            subprocess.run(["git", "-C", str(self.repo), *args], check=True)
        self.base = git(self.repo, "rev-parse", "HEAD")
        self.run = self.root / "runs" / "feature-001"
        self.run.mkdir(parents=True)
        lane = self.add(self.run / "worktree-ui")
        save_json(self.run / "plan.json", {"run_id": self.run.name, "repository": str(self.repo), "base_commit": self.base,
                                          "workers": ["ui"], "excluded_workers": [], "nodes": {"ui": {"worktree": str(lane)}}})
        for name in ("candidate", "candidate-1", "review-worktree", "challenge-worktree", "repair-workspace-1"):
            self.add(self.run / name)
        save_json(self.run / "candidate.json", {"commit": self.base, "worktree": str(self.run / "candidate")})
        self.passed = self.attempt("worker", 1, "passed")
        self.failed = self.attempt("worker", 2, "blocked")
        self.candidate_passed = self.attempt("candidate", 1, "passed")
        save_json(self.run / "ui.interactive.json", {"node_id": "ui", "background_id": "bg-ui", "session_id": "11111111-1111-4111-8111-111111111111"})
        self.source = self.root / "runs" / "feature-001.source"
        self.add(self.source)
        self.rows = []
        inventory = patch.object(clean, "inventory", side_effect=lambda: self.rows)
        inventory.start()
        self.addCleanup(inventory.stop)

    def add(self, path: Path) -> Path:
        git_worktree(self.repo, "add", "--detach", str(path), self.base)
        return path

    def attempt(self, phase: str, number: int, status: str) -> Path:
        folder = self.run / "verification" / phase / "ui" / str(number)
        self.add(folder / "worktree")
        for name in ("npm_config_cache/_cacache/entry", "xdg_cache_home/entry", "browser-0/trace/shot.png", "artifacts/log-0-abc"):
            (folder / name).parent.mkdir(parents=True, exist_ok=True)
            (folder / name).write_text("x")
        (folder / "npm_config_cache/_cacache").chmod(0o500)  # npm leaves read-only content behind.
        (folder / "browser-report-0.json").write_text("{}")
        (folder / "check-0.log").write_text("log")
        save_json(folder / "packet.json", {"phase": phase, "gate": {"status": status, "reasons": []}})
        return folder

    def clean(self, *arguments: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        code = 0
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                clean.clean_main([str(self.run), *arguments])
            except SystemExit as exit_:
                code = exit_.code
        return code, out.getvalue(), err.getvalue()

    def listed(self) -> str:
        return git(self.repo, "worktree", "list", "--porcelain")

    def untouched(self):
        for path in (self.passed / "worktree", self.passed / "npm_config_cache", self.run / "worktree-ui", self.run / "candidate",
                     self.run / "review-worktree", self.run / "challenge-worktree", self.source):
            self.assertTrue(path.exists(), path)

    def finish(self):
        save_json(self.run / "run-state.json", {"next": [], "values": {"integrated_commit": self.base}})

    def test_a_maintainer_is_refused(self):
        code, _, err = self.clean("--by", "maintainer")
        self.assertEqual(code, 1)
        self.assertIn("Blocked: only the operator runs clean: cleanup is not mechanical recovery", err)
        self.untouched()

    def test_by_is_required(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            clean.clean_main([str(self.run)])
        self.untouched()

    def test_a_running_run_is_refused(self):
        for lock in ("controller.lock", "automatic-supervisor.lock"):
            with self.subTest(lock=lock), run_lock(self.run, lock):
                code, out, err = self.clean("--by", "operator")
                self.assertEqual(code, 1)
                self.assertIn("Blocked: Another controller owns this run", err)
                self.assertNotIn("will remove", out)
        self.untouched()

    def test_a_listed_session_is_refused(self):
        self.rows = [{"id": "bg-other", "sessionId": "22222222-2222-4222-8222-222222222222"},
                     {"id": "bg-ui", "sessionId": "11111111-1111-4111-8111-111111111111", "state": "idle"}]
        code, out, err = self.clean("--by", "operator")
        self.assertEqual(code, 1)
        self.assertIn("Blocked: claude agents still lists ui (bg-ui) from this run's receipts; stop it first", err)
        self.assertNotIn("will remove", out)
        self.untouched()

    def test_an_unknown_session_listing_is_refused(self):
        with patch.object(clean, "inventory", side_effect=RuntimeError("`claude agents --json` exited 1")):
            code, _, err = self.clean("--by", "operator")
        self.assertEqual(code, 1)
        self.assertIn("Blocked: `claude agents --json` exited 1", err)
        self.untouched()

    def test_dry_run_lists_and_removes_nothing(self):
        code, out, err = self.clean("--by", "operator", "--dry-run")
        self.assertEqual(code, 0, err)
        self.assertIn(f"Clean {self.run} will remove:", out)
        self.assertIn("Dry run: nothing removed", out)
        self.untouched()

    def test_clean_prunes_passed_attempts_and_removes_the_run_checkouts_after_listing_them(self):
        removals = []
        real = clean.git_worktree
        def recording(repository, *arguments):
            removals.append((arguments, out.getvalue()))
            return real(repository, *arguments)
        out, err = io.StringIO(), io.StringIO()
        with patch.object(clean, "git_worktree", side_effect=recording), patch("workflow.checks.git_worktree", side_effect=recording), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            clean.clean_main([str(self.run), "--by", "operator"])
        text = out.getvalue()
        listing = text[:text.index("Removed")]
        for line in (f"  passed attempt verification/worker/ui/1: worktree, npm_config_cache, xdg_cache_home, browser-0",
                     f"  passed attempt verification/candidate/ui/1: worktree, npm_config_cache, xdg_cache_home, browser-0",
                     f"  lane worktree {self.run / 'worktree-ui'}", f"  candidate worktree {self.run / 'candidate'}",
                     f"  candidate worktree {self.run / 'candidate-1'}", f"  review worktree {self.run / 'review-worktree'}",
                     f"  challenge worktree {self.run / 'challenge-worktree'}"):
            self.assertIn(line, listing)
        self.assertIn(f"Kept: {self.source}: the run is not finished", listing)
        self.assertIn(f"Kept: {self.run / 'repair-workspace-1'}", listing)
        self.assertIn("verification/worker/ui/2", listing)  # The failed attempt is named as kept whole.
        # Every removal came after the whole listing was printed; the last call prunes.
        self.assertTrue(removals)
        self.assertTrue(all("will remove:" in printed and "Kept:" in printed for _, printed in removals))
        self.assertEqual(removals[-1][0], ("prune",))
        for path in (self.passed / "worktree", self.passed / "npm_config_cache", self.passed / "xdg_cache_home", self.passed / "browser-0",
                     self.candidate_passed / "worktree", self.run / "worktree-ui", self.run / "candidate", self.run / "candidate-1",
                     self.run / "review-worktree", self.run / "challenge-worktree"):
            self.assertFalse(path.exists(), path)
            self.assertNotIn(str(path), self.listed())
        for path in ("packet.json", "check-0.log", "browser-report-0.json", "artifacts/log-0-abc"):
            self.assertTrue((self.passed / path).is_file(), path)
        for path in ("worktree", "npm_config_cache/_cacache/entry", "xdg_cache_home/entry", "browser-0/trace/shot.png"):
            self.assertTrue((self.failed / path).exists(), path)
        self.assertTrue(self.source.exists())
        self.assertTrue((self.run / "repair-workspace-1").exists())
        self.assertTrue((self.run / "candidate.json").is_file())
        # A second clean has nothing left to remove but the kept ones.
        code, out, err = self.clean("--by", "operator")
        self.assertEqual(code, 0, err)
        self.assertIn("Nothing to remove", out)

    def test_the_source_checkout_goes_only_with_a_finished_run(self):
        self.finish()
        code, out, err = self.clean("--by", "operator")
        self.assertEqual(code, 0, err)
        self.assertIn(f"  source checkout {self.source}", out)
        self.assertFalse(self.source.exists())
        self.assertNotIn(str(self.source), self.listed())

    def test_a_lane_path_outside_the_run_is_never_removed(self):
        outside = self.add(self.root / "elsewhere")
        plan = json.loads((self.run / "plan.json").read_text())
        plan["nodes"]["ui"]["worktree"] = str(outside)
        save_json(self.run / "plan.json", plan)
        code, out, err = self.clean("--by", "operator")
        self.assertEqual(code, 0, err)
        self.assertIn(f"Kept: {outside}: outside the run directory", out)
        self.assertTrue(outside.exists())


if __name__ == "__main__":
    unittest.main()
