"""`python -m workflow tryout <run>` (C7): the operator's verdict on a user-facing run, kept in <run>/tryout.json."""
import contextlib
import io
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from .sessions import git, prepare, read_json, save_json
from .verification import policy_digest

POLICY = {"version": "1.2.0", "feature": "Tryout test", "independent_review": True, "integration_approval": True, "workers": [
    {"node_id": "ui", "role": "frontend", "owned_paths": ["ui.txt"], "required_check_kinds": ["unit"],
     "checks": [{"id": "unit", "kind": "unit", "argv": ["true"], "timeout_seconds": 10, "scenarios": []}]}]}


def tryout_run(root: Path, tryout: bool | None = True, candidate: bool = True) -> Path:
    """A prepared run of one lane; `tryout` is plan.tryout (None: a plan from before C7), `candidate` writes candidate.json."""
    repo = root / "repo"
    repo.mkdir()
    (repo / "ui.txt").write_text("before")
    for args in (["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"], ["add", "."], ["commit", "-qm", "Base"]):
        subprocess.run(["git", "-C", str(repo), *args], check=True)
    directory = root / "run"
    plan = prepare(directory, repo, "HEAD", {"ui": "## Goal\nShow the run list.\n"}, True)
    plan.update(mode="interactive", policy_sha256=policy_digest(POLICY), source_branch=git(repo, "symbolic-ref", "--short", "HEAD"))
    if tryout is not None:
        plan["tryout"] = tryout
    save_json(directory / "plan.json", plan)
    save_json(directory / "policy.json", POLICY)
    if candidate:
        save_json(directory / "candidate.json", {"commit": plan["base_commit"], "worktree": str(directory / "candidate")})
    return directory


def tryout_cli(*argv: str) -> tuple[int, str]:
    from .tryout import tryout_main
    output = io.StringIO()
    code = 0
    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
        try:
            tryout_main(list(argv))
        except SystemExit as exit_:
            code = exit_.code or 0
    return code, output.getvalue()


class TryoutTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        environment = patch.dict(os.environ, {"CLAUDECODE": ""})  # The texts below are a plain shell's.
        environment.start()
        self.addCleanup(environment.stop)

    def test_each_result_is_appended_with_its_note_time_and_actor_and_the_history_is_kept(self):
        run = tryout_run(self.root)
        for result, note in (("broken", "The list is empty after a reload."), ("skipped", None), ("works", "Reload keeps the list.")):
            argv = [str(run), "--result", result, "--by", "operator"] + (["--note", note] if note else [])
            code, output = tryout_cli(*argv)
            self.assertEqual(code, 0, output)
            self.assertIn(f"Tryout recorded for {run.name}: {result}", output)
        verdicts = read_json(run / "tryout.json")["verdicts"]
        self.assertEqual([(item["result"], item["note"], item["by"]) for item in verdicts],
                         [("broken", "The list is empty after a reload.", "operator"), ("skipped", None, "operator"), ("works", "Reload keeps the list.", "operator")])
        self.assertTrue(all(item["at"].endswith("Z") or "+" in item["at"] for item in verdicts))
        # One plain record per verdict on the timeline, and the export carries them for the viewer.
        events = [json.loads(line) for line in (run / "events.jsonl").read_text().splitlines()]
        self.assertEqual([event["message"] for event in events if event["message"].startswith("Tryout recorded")],
                         ["Tryout recorded by the operator: broken. The list is empty after a reload.",
                          "Tryout recorded by the operator: skipped", "Tryout recorded by the operator: works. Reload keeps the list."])
        self.assertTrue(all(event["status"] == "note" for event in events if event["message"].startswith("Tryout recorded")))
        exported = read_json(run / "run-state.json")["inputs"]["tryout"]
        self.assertEqual(exported["required"], True)
        self.assertEqual([item["result"] for item in exported["verdicts"]], ["broken", "skipped", "works"])

    def test_an_unknown_result_is_refused_by_the_parser(self):
        run = tryout_run(self.root)
        code, output = tryout_cli(str(run), "--result", "fine", "--by", "operator")
        self.assertEqual(code, 2)
        self.assertIn("invalid choice: 'fine'", output)
        self.assertFalse((run / "tryout.json").exists())

    def test_a_run_whose_plan_does_not_ask_for_a_tryout_is_refused(self):
        for tryout in (False, None):
            with self.subTest(tryout=tryout), tempfile.TemporaryDirectory() as temp:
                run = tryout_run(Path(temp), tryout=tryout)
                code, output = tryout_cli(str(run), "--result", "works", "--by", "operator")
                self.assertEqual(code, 1, output)
                self.assertIn("plan does not ask for a tryout", output)
                self.assertFalse((run / "tryout.json").exists())

    def test_a_run_without_a_candidate_is_refused(self):
        run = tryout_run(self.root, candidate=False)
        code, output = tryout_cli(str(run), "--result", "works", "--by", "operator")
        self.assertEqual(code, 1, output)
        self.assertIn("has no candidate yet", output)
        self.assertFalse((run / "tryout.json").exists())

    def test_an_abandoned_run_is_refused(self):
        run = tryout_run(self.root)
        save_json(run / "abandon.json", {"reason": "followed up by run-002", "by": "operator", "abandoned_at": "2026-10-04T10:00:00Z"})
        code, output = tryout_cli(str(run), "--result", "works", "--by", "operator")
        self.assertEqual(code, 1, output)
        self.assertIn("The run was abandoned by the operator", output)
        self.assertFalse((run / "tryout.json").exists())
        self.assertFalse((run / "events.jsonl").exists() and "Tryout recorded" in (run / "events.jsonl").read_text())

    def test_an_export_that_fails_after_the_verdict_says_it_was_recorded(self):
        run = tryout_run(self.root)
        with patch("workflow.pipeline.report", side_effect=OSError("disk full")):
            code, output = tryout_cli(str(run), "--result", "works", "--by", "operator")
        self.assertEqual(code, 1, output)
        self.assertNotIn("Nothing was recorded", output)
        self.assertIn(f"Tryout recorded for {run.name}: works", output)
        self.assertIn("disk full", output)
        self.assertIn(f'python -m workflow export "{run}"', output)
        self.assertEqual([item["result"] for item in read_json(run / "tryout.json")["verdicts"]], ["works"])

    def test_a_tryout_json_that_cannot_be_read_is_refused_not_replaced(self):
        # The history is kept: a hand-edited file that is not JSON, or has no verdicts list, is never overwritten.
        run = tryout_run(self.root)
        for text in ("{not json", json.dumps({"version": "1.0.0", "verdicts": {"result": "works"}}), json.dumps(["works"])):
            with self.subTest(text=text):
                (run / "tryout.json").write_text(text)
                code, output = tryout_cli(str(run), "--result", "works", "--by", "operator")
                self.assertEqual(code, 1, output)
                self.assertIn("tryout.json cannot be read: fix or move it; nothing was recorded", output)
                self.assertEqual((run / "tryout.json").read_text(), text)
                self.assertFalse((run / "events.jsonl").exists() and "Tryout recorded" in (run / "events.jsonl").read_text())

    def test_the_maintainer_and_a_missing_actor_are_refused(self):
        run = tryout_run(self.root)
        code, output = tryout_cli(str(run), "--result", "works", "--by", "maintainer")
        self.assertEqual(code, 1, output)
        self.assertIn("tryout is the operator's decision: --by maintainer is refused", output)
        code, output = tryout_cli(str(run), "--result", "works")
        self.assertEqual(code, 1, output)
        self.assertIn("tryout requires --by operator", output)
        self.assertFalse((run / "tryout.json").exists())
        from .actor import OPERATOR_ONLY
        self.assertIn("tryout", OPERATOR_ONLY)


if __name__ == "__main__":
    unittest.main()
