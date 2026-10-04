"""What a branch holds unreviewed (C45): the ledger's classifier, prepare's `base_unreviewed` and `workflow ledger`, on a real
temporary repository with an approved run, a blocked run, a hand commit that copies the blocked run's file, a config commit
and a merge of the blocked candidate that a fix run takes as its base."""
import contextlib
import io
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from . import ledger
from .sessions import git, read_json, save_json
from .test_pipeline import pipeline_cli

POLICY = {"version": "1.0.0", "feature": "Ledger test", "independent_review": True, "integration_approval": True,
          "workers": [{"node_id": "main", "role": "backend", "owned_paths": ["src"],
                       "checks": [{"id": "unit", "kind": "unit", "argv": ["python", "-c", "pass"], "timeout_seconds": 10, "scenarios": []}]}]}


class LedgerTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.registry = self.root / "config" / "projects.json"
        environment = patch.dict(os.environ, {"MD_MANAGER_PROJECTS_CONFIG": str(self.registry)})
        environment.start()
        self.addCleanup(environment.stop)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "Test")
        self.git("config", "user.email", "test@example.invalid")
        self.base = self.commit({"README.md": "# Repo\n"}, "Base")
        # The approved run: its candidate is fast-forwarded into main.
        self.approved = self.candidate(self.base, {"src/app.ts": "export const app = 1\n"}, "Run a: app")
        self.git("merge", "-q", "--ff-only", self.approved)
        # The blocked run: its candidate is never integrated.
        self.blocked = self.candidate(self.approved, {"src/tone.ts": "export const tone = 'calm'\n", "src/theme.css": ":root{}\n"}, "Run x: tone")
        self.runs = self.root / "runs"
        self.record("run-a", self.base, self.approved, "approved")
        self.record("run-x", self.approved, self.blocked, "blocked")
        self.registry.parent.mkdir()
        save_json(self.registry, {"version": 1, "projects": [{"project_id": "repo", "name": "repo", "repository": str(self.repo),
                                                               "workflows": [{"workflow_id": "feature", "runs_root": str(self.runs)}]}]})
        # By hand on main: a copy of the blocked run's file, a docs note, then a merge of the blocked candidate.
        self.hand = self.commit({"src/tone.ts": "export const tone = 'calm'\n"}, "Take the tone from run x")
        self.config = self.commit({"docs/NOTES.md": "# Notes\n", "features/fix/task.md": "Fix it\n"}, "Notes")
        self.git("merge", "-q", "--no-ff", "-m", "Merge run x's candidate", self.blocked)
        self.merge = self.git("rev-parse", "HEAD")

    def git(self, *arguments: str) -> str:
        return git(self.repo, *arguments)

    def commit(self, files: dict, message: str) -> str:
        for path, text in files.items():
            (self.repo / path).parent.mkdir(parents=True, exist_ok=True)
            (self.repo / path).write_text(text)
        self.git("add", "-A")
        self.git("commit", "-qm", message)
        return self.git("rev-parse", "HEAD")

    def candidate(self, base: str, files: dict, message: str) -> str:
        branch = self.git("symbolic-ref", "--short", "HEAD")
        self.git("checkout", "-q", "--detach", base)
        commit = self.commit(files, message)
        self.git("checkout", "-q", branch)
        return commit

    def record(self, run_id: str, base: str, candidate: str, verdict: str):
        directory = self.runs / run_id
        directory.mkdir(parents=True, exist_ok=True)
        save_json(directory / "plan.json", {"run_id": run_id, "repository": str(self.repo), "base_commit": base})
        save_json(directory / "review.json", {"run_id": run_id, "candidate_commit": candidate, "verdict": verdict, "findings": []})

    def entry(self, entries, commit):
        return next(item for item in entries if item["commit"] == commit)

    def test_the_classifier_labels_every_first_parent_commit(self):
        entries = ledger.classify(self.repo, "main", None, ledger.known_runs(self.repo, ledger.runs_roots()))
        self.assertEqual([item["commit"] for item in entries], [self.merge, self.config, self.hand, self.approved, self.base])
        self.assertEqual({item["commit"]: (item["class"], item["run"]) for item in entries},
                         {self.merge: ("blocked", "run-x"), self.config: ("config", None), self.hand: ("code", None),
                          self.approved: ("reviewed", "run-a"), self.base: ("code", None)})
        self.assertEqual(self.entry(entries, self.hand)["files"], ["src/tone.ts"])
        self.assertEqual(self.entry(entries, self.merge)["files"], ["src/theme.css"])  # Against its first parent.
        self.assertEqual(self.entry(entries, self.config)["files"], ["docs/NOTES.md", "features/fix/task.md"])
        self.assertEqual(self.entry(entries, self.hand)["subject"], "Take the tone from run x")

    def test_prepare_pins_what_the_base_holds_unreviewed(self):
        policy, task = self.root / "policy.json", self.root / "task.md"
        save_json(policy, POLICY)
        task.write_text("Fix the tone.\n")
        run = self.root / "fix-runs" / "run-f"  # Outside the registered runs root: the registry names run-a and run-x.
        code, out, err = pipeline_cli("prepare", str(run), "--repo", str(self.repo), "--policy", str(policy), "--task", f"main={task}")
        self.assertEqual(code, 0, err)
        pinned = read_json(run / "plan.json")["base_unreviewed"]
        self.assertEqual((pinned["since"], pinned["since_run"], pinned["total"], pinned["more"]), (self.approved, "run-a", 3, 0))
        self.assertEqual([(item["commit"], item["class"], item["run"], item["files"]) for item in pinned["commits"]],
                         [(self.merge, "blocked", "run-x", ["src/theme.css"]), (self.config, "config", None, ["docs/NOTES.md", "features/fix/task.md"]),
                          (self.hand, "code", None, ["src/tone.ts"])])
        self.assertIn(f"Base {self.merge[:12]} holds 3 commits no approved run reviewed since {self.approved[:12]} (run-a):", out)
        self.assertIn(f"  {self.merge[:12]} from blocked run run-x: Merge run x's candidate (src/theme.css)", out)
        self.assertIn(f"  {self.hand[:12]} code outside any run: Take the tone from run x (src/tone.ts)", out)
        self.assertIn(f"  {self.config[:12]} config outside any run: Notes (docs/NOTES.md, features/fix/task.md)", out)

    def test_the_list_is_capped_and_says_how_many_more(self):
        with patch.object(ledger, "LIST_LIMIT", 1):
            pinned = ledger.base_unreviewed(self.repo, self.merge, ledger.runs_roots())
        self.assertEqual(([item["commit"] for item in pinned["commits"]], pinned["total"], pinned["more"]), ([self.merge], 3, 2))
        self.assertIn("  ... and 2 more", ledger.describe(pinned, self.merge))

    def test_without_an_approved_ancestor_every_commit_counts_and_unknown_runs_are_ignored(self):
        save_json(self.runs / "run-a" / "review.json", {"run_id": "run-a", "candidate_commit": self.approved, "verdict": "blocked", "findings": []})
        self.record("elsewhere", "0" * 40, "1" * 40, "approved")  # Another repository's run: its commits are not here.
        (self.runs / "half").mkdir()                              # A run that never reached review.
        pinned = ledger.base_unreviewed(self.repo, self.merge, ledger.runs_roots())
        self.assertEqual((pinned["since"], pinned["since_run"], pinned["total"]), (None, None, 5))
        self.assertEqual(self.entry(pinned["commits"], self.approved)["run"], "run-a")
        self.assertIn("no approved run's candidate is an ancestor", ledger.describe(pinned, self.merge))

    def test_a_base_that_an_approved_run_produced_has_nothing_unreviewed(self):
        pinned = ledger.base_unreviewed(self.repo, self.approved, ledger.runs_roots())
        self.assertEqual((pinned["since"], pinned["commits"], pinned["total"]), (self.approved, [], 0))
        self.assertEqual(ledger.describe(pinned, self.approved), f"Base {self.approved[:12]} is the candidate approved run run-a produced; nothing unreviewed.")

    def test_the_ledger_command_writes_ledger_json_beside_the_registry(self):
        registry_before = self.registry.read_text()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            ledger.ledger_main(["--repo", str(self.repo), "--branch", "main"])
        written = read_json(self.registry.parent / "ledger.json")
        [record] = written["ledgers"]
        self.assertEqual((record["repository"], record["branch"], record["tip"], record["since"]), (str(self.repo), "main", self.merge, None))
        self.assertEqual({item["commit"]: (item["class"], item["run"]) for item in record["commits"]},
                         {self.merge: ("blocked", "run-x"), self.config: ("config", None), self.hand: ("code", None),
                          self.approved: ("reviewed", "run-a"), self.base: ("code", None)})
        self.assertEqual(record["counts"], {"reviewed": 1, "blocked": 1, "config": 1, "code": 2})
        self.assertIn(f"Ledger of main at {self.merge[:12]}: 1 reviewed, 1 from blocked runs, 1 config and 2 code outside any run", out.getvalue())
        self.assertEqual(self.registry.read_text(), registry_before)
        # --since narrows the range; the same repository and branch replace their record, another branch is added beside it.
        with contextlib.redirect_stdout(io.StringIO()):
            ledger.ledger_main(["--repo", str(self.repo), "--branch", "main", "--since", self.approved])
            ledger.ledger_main(["--repo", str(self.repo), "--branch", self.blocked])
        records = read_json(self.registry.parent / "ledger.json")["ledgers"]
        self.assertEqual([(item["branch"], item["since"], len(item["commits"])) for item in records],
                         [("main", self.approved, 3), (self.blocked, None, 3)])

    def test_the_ledger_command_refuses_an_unknown_branch(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err), self.assertRaises(SystemExit) as exit_:
            ledger.ledger_main(["--repo", str(self.repo), "--branch", "nope"])
        self.assertEqual(exit_.exception.code, 1)
        self.assertIn("Blocked:", err.getvalue())
        self.assertFalse((self.registry.parent / "ledger.json").exists())


if __name__ == "__main__":
    unittest.main()
