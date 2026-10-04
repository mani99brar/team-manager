"""The review replay (C39): a sample's prompt is the print reviewer's own, built on _review_print's code path, a brief
substitution changes only the brief, and a sample reads a copy of the run without its recorded verdicts. A fake `claude`
stands in for every print job."""
import contextlib
import io
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from . import replay
from .automatic import _review_print, automatic_settings, review_brief
from .launch import BUILTIN_BRIEFS
from .sessions import git, read_json, save_json
from .verification import policy_digest

TESTDATA = Path(__file__).resolve().parent / "testdata" / "project-workflows"
FINDING = {"severity": "P1", "message": "The one-clock rule has no test. Consequence: two clocks drift.", "disposition": "open",
           "worker": "ui", "requirement": None}


class ReplayTests(unittest.TestCase):
    """A run of the testdata feature (lanes ui and adapter, completion 1.1.0, two declared reviewers) and its repository."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.repo = self.root / "repo"
        self.repo.mkdir()
        (self.repo / "ui.txt").write_text("before\n")
        for args in (["init", "-q", "-b", "main"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"], ["add", "."],
                     ["commit", "-qm", "Base"], ["switch", "-qc", "candidate"]):
            subprocess.run(["git", "-C", str(self.repo), *args], check=True)
        self.base = git(self.repo, "rev-parse", "HEAD")
        (self.repo / "ui.txt").write_text("after\n")
        subprocess.run(["git", "-C", str(self.repo), "commit", "-qam", "Candidate"], check=True)
        self.candidate = git(self.repo, "rev-parse", "HEAD")
        # An archived run: it ran in `recorded`, which its lane worktrees and the bundle's packet paths still name.
        self.run = self.root / "archive" / "run-1"
        self.recorded = self.root / "state" / "run-1"
        packet = self.run / "verification" / "candidate" / "ui" / "1"
        packet.mkdir(parents=True)
        policy = read_json(TESTDATA / "policy.json")
        save_json(self.run / "policy.json", policy)
        save_json(self.run / "plan.json", {
            "run_id": "run-1", "repository": str(self.repo), "base_commit": self.base, "allow_edits": True, "workers": ["ui", "adapter"],
            "excluded_workers": [], "source_branch": "feature/replay-test", "automatic": automatic_settings(reviewer_transport="print"),
            "policy_sha256": policy_digest(policy), "completion_version": "1.1.0",
            "nodes": {lane: {"worktree": str(self.recorded / f"worktree-{lane}"), "task": (TESTDATA / f"{lane}-task.md").read_text(),
                             "session_id": f"{lane}-token", "observed_start_commit": self.base} for lane in ("ui", "adapter")},
            "prd": {"path": "/target/docs/PRD.md", "copy": "challenge-inputs/prd.md", "sha256": "e" * 64},
            "decisions": {"path": "/target/features/x/decisions.md", "text": "# Decisions\n\n- One clock for every lane.\n"},
            "reviewers": [{"reviewer_id": "general", "prompt": "General brief."},
                          {"reviewer_id": "coverage", "prompt": "Pinned coverage brief.\n\nMap every line."}]})
        (self.run / "challenge-inputs").mkdir()
        (self.run / "challenge-inputs" / "prd.md").write_text("# PRD\n")
        for lane in ("ui", "adapter"):
            save_json(self.run / f"{lane}.completion.json", {
                "version": "1.1.0", "run_id": "run-1", "node_id": lane, "launch_token": f"{lane}-token", "status": "completed",
                "summary": "Work done", "open_assumptions": [], "untested": [f"The {lane} edge"], "falsifying_check": "unit",
                "verify_yourself": "Times stay in UTC", "question": None})
        with (self.run / "review.diff").open("w") as handle:
            subprocess.run(["git", "-C", str(self.repo), "diff", "--binary", self.base, self.candidate], stdout=handle, check=True)
        self.bundle = {"run_id": "run-1", "base_commit": self.base, "candidate_commit": self.candidate, "policy_sha256": policy_digest(policy),
                       "snapshots": {}, "packets": [{"path": str(self.recorded / packet.relative_to(self.run) / "packet.json"), "sha256": "0" * 64}]}
        save_json(self.run / "review-bundle.json", self.bundle)
        save_json(packet / "packet.json", {"artifact_root": str(packet / "artifacts")})
        self.fake = self.root / "fake-claude"
        self.launches = self.root / "launches.jsonl"

    def claude(self, decision: dict) -> None:
        """A fake print job: logs where it ran and what it read, then returns `decision` as its structured output."""
        self.fake.write_text(f'''#!/usr/bin/env python3
import json, os, sys
args = sys.argv
prompt = sys.stdin.read()
with open({str(self.launches)!r}, "a") as handle:
    handle.write(json.dumps({{"cwd": os.getcwd(), "add_dirs": [args[i + 1] for i, item in enumerate(args) if item == "--add-dir"],
                             "tools": args[args.index("--tools") + 1], "schema": json.loads(args[args.index("--json-schema") + 1]),
                             "prompt": prompt}}) + "\\n")
print(json.dumps({{"session_id": args[args.index("--session-id") + 1], "is_error": False, "subtype": "success", "total_cost_usd": 0.5,
                  "duration_ms": 1000, "num_turns": 3, "modelUsage": {{"claude-test": {{}}}}, "structured_output": json.loads({json.dumps(decision)!r})}}))
''')
        self.fake.chmod(0o700)

    def logged(self) -> list:
        return [json.loads(line) for line in self.launches.read_text().splitlines()] if self.launches.exists() else []

    def test_the_replay_prompt_is_the_one_review_print_writes_and_a_brief_changes_only_the_brief(self):
        # Built before the review: review.json (written by the fake approval) is not this fixture's to validate.
        prompts = {reviewer_id: replay.prompt(self.run, reviewer_id) for reviewer_id in ("general", "coverage")}
        substituted = replay.prompt(self.run, "coverage", "New coverage brief.\n\nA second paragraph.\n")
        self.claude({"verdict": "approved", "findings": []})
        runtime = SimpleNamespace(directory=self.run, plan=read_json(self.run / "plan.json"), sessions=SimpleNamespace(executable=str(self.fake)),
                                  validate_bundle=lambda: (self.bundle, "b" * 64), validate_review=lambda review: None, event=lambda *args: None)
        git(self.repo, "switch", "-q", "--detach", self.candidate)  # The reviewers' checkout: clean, at the candidate.
        _review_print(runtime, self.bundle, "b" * 64, self.repo, self.run / "review.diff")
        for reviewer_id, text in prompts.items():
            self.assertEqual(text, (self.run / f"review-{reviewer_id}.prompt.txt").read_text())
        self.assertEqual(sorted(launch["prompt"] for launch in self.logged()), sorted(prompts.values()))  # The jobs run in parallel.
        pinned, new = review_brief({"prompt": "Pinned coverage brief.\n\nMap every line."}), "New coverage brief. A second paragraph."
        self.assertTrue(prompts["coverage"].startswith(pinned + " ") and substituted.startswith(new + " "))
        self.assertEqual(substituted.removeprefix(new), prompts["coverage"].removeprefix(pinned))

    def listing(self, directory: Path) -> dict:
        return {str(path.relative_to(directory)): (path.stat().st_size, path.stat().st_mtime_ns) for path in sorted(directory.rglob("*"))}

    def test_a_sample_reads_a_copy_without_the_recorded_verdicts_and_its_verdict_is_derived_from_its_findings(self):
        recorded = {"review.json": "{}", "review-coverage.completion.json": "{}", "review-coverage.stdout.json": "{}", "review-coverage.prompt.txt": "Old",
                    "review-general.interactive.json": "{}", "automatic-review.json": "{}", "automatic-review-coverage.json": "{}",
                    "events.jsonl": "{}\n", "run-state.json": "{}", "report.html": "<p>blocked</p>", "pipeline.sqlite": "",
                    ".review.json.0f.tmp": "{}", "worktree-ui/.git": "gitdir: elsewhere", "worktree-ui/ui.txt": "work",
                    "verification/candidate/ui/1/worktree/.git": "gitdir: elsewhere", "verification/candidate/ui/1/npm_config_cache/x": "cache",
                    "verification/candidate/ui/1/check-0.log": f"ran in {self.recorded}/verification\n"}
        for name, text in recorded.items():
            (self.run / name).parent.mkdir(parents=True, exist_ok=True)
            (self.run / name).write_text(text)
        before = self.listing(self.run)
        self.claude({"verdict": "approved", "findings": [FINDING]})
        cases = self.root / "cases.json"
        cases.write_text(json.dumps([{"case": "case-a", "run": str(self.run), "reviewer": "coverage", "brief": "builtin:coverage"}]))
        out = self.root / "out"
        arguments = [str(cases), "--out", str(out), "--samples", "2", "--executable", str(self.fake), "--min-available-mb", "0"]
        with contextlib.redirect_stdout(io.StringIO()):
            replay.main(arguments)
        copy = out / "case-a" / "run"
        # Every recorded verdict, the old prompt, the worktrees and the caches stay behind; the candidate tree is the commit's files.
        self.assertEqual(sorted(path.name for path in copy.iterdir()),
                         ["adapter.completion.json", "challenge-inputs", "plan.json", "policy.json", "review-bundle.json", "review-coverage.prompt.txt",
                          "review-worktree", "review.diff", "ui.completion.json", "verification"])
        self.assertEqual(sorted(path.name for path in (copy / "verification/candidate/ui/1").iterdir()), ["check-0.log", "packet.json"])
        self.assertEqual(sorted(path.name for path in (copy / "review-worktree").iterdir()), ["ui.txt"])
        self.assertEqual((copy / "review-worktree" / "ui.txt").read_text(), "after\n")
        # The run's own paths, where it ran and where it lies, name the copy; the policy keeps its digest.
        self.assertEqual(read_json(copy / "review-bundle.json")["packets"][0]["path"], str(copy / "verification/candidate/ui/1/packet.json"))
        self.assertEqual(read_json(copy / "verification/candidate/ui/1/packet.json")["artifact_root"], str(copy / "verification/candidate/ui/1/artifacts"))
        self.assertEqual((copy / "verification/candidate/ui/1/check-0.log").read_text(), f"ran in {copy}/verification\n")
        self.assertEqual((copy / "policy.json").read_bytes(), (self.run / "policy.json").read_bytes())
        # Each sample is the print job _review_print starts, on the copy: its prompt with this checkout's bundled brief.
        expected = replay.prompt(copy, "coverage", (BUILTIN_BRIEFS / "coverage.md").read_text())
        self.assertTrue(expected.startswith(review_brief({"prompt": (BUILTIN_BRIEFS / "coverage.md").read_text()}) + " "))
        self.assertEqual((copy / "review-coverage.prompt.txt").read_text(), expected)
        for launch in self.logged():
            self.assertEqual((launch["cwd"], launch["add_dirs"], launch["tools"], launch["prompt"]), (str(copy / "review-worktree"), [str(copy)], "Read,Glob,Grep", expected))
            self.assertEqual(launch["schema"]["properties"]["findings"]["items"]["properties"]["worker"]["enum"], ["ui", "adapter", "multiple", "none"])
        tally = read_json(out / "tally.json")["cases"]["case-a"]
        self.assertEqual((tally["raw_verdicts"], tally["derived_verdicts"]), (["approved", "approved"], ["blocked", "blocked"]))
        for number, sample in enumerate(tally["samples"], 1):
            self.assertEqual((sample["sample"], sample["status"], sample["cost_usd"], sample["findings"]),
                             (number, "ok", 0.5, [{"severity": "P1", "disposition": "open", "worker": "ui", "sentence": "The one-clock rule has no test."}]))
        self.assertEqual(self.listing(self.run), before)  # Nothing was written in the run directory.
        # A second invocation keeps the tallied samples and starts nothing.
        with contextlib.redirect_stdout(io.StringIO()):
            replay.main(arguments)
        self.assertEqual(len(self.logged()), 2)

    def test_a_path_that_extends_a_run_name_is_not_rewritten_whichever_name_is_longer(self):
        # The copy rewrites the run's own paths, where it lies (archive/run-1) and where it ran (state/run-1), and nothing else: a
        # sibling whose name extends either one (run-1-2, run-1.old) keeps its text, the longer name's sibling included.
        log = self.run / "verification" / "candidate" / "ui" / "1" / "check-1.log"
        log.write_text(f"{self.run}/a {self.recorded}/b {self.run}-2/c {self.recorded}-2/d {self.run}.old/e {self.recorded}.old/f\n")
        copy = self.root / "copy"
        replay.stage(self.run, copy)
        self.assertEqual((copy / log.relative_to(self.run)).read_text(),
                         f"{copy}/a {copy}/b {self.run}-2/c {self.recorded}-2/d {self.run}.old/e {self.recorded}.old/f\n")

    def test_a_candidate_gone_from_the_repository_is_rebuilt_from_the_base_and_the_diff(self):
        for args in (["switch", "-q", "main"], ["branch", "-qD", "candidate"], ["reflog", "expire", "--expire=now", "--all"], ["gc", "-q", "--prune=now"]):
            subprocess.run(["git", "-C", str(self.repo), *args], check=True)
        self.assertNotEqual(subprocess.run(["git", "-C", str(self.repo), "cat-file", "-e", f"{self.candidate}^{{commit}}"], capture_output=True).returncode, 0)
        tree = self.root / "tree"
        self.assertEqual(replay.candidate_tree(self.repo, self.base, self.candidate, self.run / "review.diff", tree), "base + review.diff")
        self.assertEqual(sorted(os.listdir(tree)), ["ui.txt"])
        self.assertEqual((tree / "ui.txt").read_text(), "after\n")


if __name__ == "__main__":
    unittest.main()
