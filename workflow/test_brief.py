"""`python -m workflow brief <run>` (C30): what a follow-up run's tasks need from a finished run, read-only."""
import contextlib
import io
import shlex
import subprocess
import tempfile
import unittest
from pathlib import Path

from .pipeline import digest_file
from .sessions import git, prepare, read_json, save_json
from .verification import policy_digest

GENERAL_TOKEN = "11111111-1111-4111-8111-111111111111"
COVERAGE_TOKEN = "22222222-2222-4222-8222-222222222222"
GENERAL_FINDINGS = [
    {"severity": "P1", "message": "Private matches can be joined without their code. The join route never checks it.", "disposition": "open",
     "worker": "ui", "requirement": None},
    {"severity": "P2", "message": "The two lanes disagree on the error copy.", "disposition": "open", "worker": "multiple", "requirement": None},
]
# coverage was superseded: its bound file arrived after the run was decided, so review.json does not hold it.
COVERAGE_FINDINGS = [{"severity": "P2", "message": "No test asserts that legacy.py's removal keeps the import working.", "disposition": "open",
                      "worker": "adapter", "requirement": None}]


def commit(repo: Path, message: str, edits: dict) -> str:
    """A commit on a detached HEAD at the repository's current HEAD with `edits` ({path: text, or None to delete}); the branch stays."""
    branch = git(repo, "symbolic-ref", "--short", "HEAD")
    git(repo, "checkout", "-q", "--detach")
    for path, text in edits.items():
        if text is None:
            git(repo, "rm", "-q", path)
        else:
            (repo / path).write_text(text)
            git(repo, "add", path)
    git(repo, "commit", "-qm", message)
    sha = git(repo, "rev-parse", "HEAD")
    git(repo, "checkout", "-q", branch)
    return sha


class BlockedRun:
    """A run of two lanes blocked by its review: general blocked with a P1, coverage superseded with its own bound file."""

    def __init__(self, root: Path):
        self.root = root
        self.repo = repo = root / "repo"
        repo.mkdir()
        (repo / "ui.txt").write_text("before")
        (repo / "backend.py").write_text("VALUE = 1\n")
        (repo / "legacy.py").write_text("OLD = True\n")
        for args in (["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"], ["add", "."], ["commit", "-qm", "Base"]):
            subprocess.run(["git", "-C", str(repo), *args], check=True)
        self.directory = directory = root / "run"
        self.plan = prepare(directory, repo, "HEAD", {"ui": "UI", "adapter": "Backend"}, True)
        self.policy = {"version": "1.2.0", "feature": "Brief test", "independent_review": True, "integration_approval": True, "workers": [
            {"node_id": "ui", "role": "frontend", "owned_paths": ["ui.txt"], "required_check_kinds": ["unit"],
             "checks": [{"id": "unit", "kind": "unit", "argv": ["true"], "timeout_seconds": 10, "scenarios": []}]},
            {"node_id": "adapter", "role": "backend", "owned_paths": ["backend.py", "legacy.py"], "required_check_kinds": ["unit"],
             "checks": [{"id": "unit", "kind": "unit", "argv": ["python", "-c", "pass"], "timeout_seconds": 10, "scenarios": []}]}]}
        self.plan.update(mode="interactive", policy_sha256=policy_digest(self.policy), source_branch=git(repo, "symbolic-ref", "--short", "HEAD"),
                         reviewers=[{"reviewer_id": "general", "prompt": "General."}, {"reviewer_id": "coverage", "prompt": "Coverage."}])
        save_json(directory / "plan.json", self.plan)
        save_json(directory / "policy.json", self.policy)
        base = self.plan["base_commit"]
        self.ui = commit(repo, "ui", {"ui.txt": "after"})
        self.adapter = commit(repo, "adapter", {"backend.py": "VALUE = 2\n", "legacy.py": None})
        git(repo, "checkout", "-q", "--detach", self.ui)
        git(repo, "cherry-pick", self.adapter)
        self.candidate = git(repo, "rev-parse", "HEAD")
        git(repo, "checkout", "-q", self.plan["source_branch"])
        self.snapshots = {
            "ui": {"commit": self.ui, "changed_files": ["ui.txt"], "session_id": "ui-session", "summary": "UI done", "open_assumptions": ["The copy is final"]},
            "adapter": {"commit": self.adapter, "changed_files": ["backend.py", "legacy.py"], "session_id": "adapter-session", "summary": "Adapter done",
                        "open_assumptions": []}}
        save_json(directory / "snapshots.json", self.snapshots)
        save_json(directory / "candidate.json", {"commit": self.candidate, "worktree": str(directory / "candidate")})
        save_json(directory / "review-bundle.json", {"run_id": "run", "base_commit": base, "candidate_commit": self.candidate,
                                                     "policy_sha256": self.plan["policy_sha256"], "snapshots": self.snapshots, "packets": []})
        digest = digest_file(directory / "review-bundle.json")
        for lane, untested, verify in (("ui", ["The page in Safari"], "Open the join page with a private match"), ("adapter", [], "Import backend")):
            save_json(directory / f"{lane}.completion.json", {
                "version": "1.1.0", "run_id": "run", "node_id": lane, "launch_token": self.plan["nodes"][lane]["session_id"], "status": "completed",
                "summary": f"{lane} done", "open_assumptions": self.snapshots[lane]["open_assumptions"], "untested": untested,
                "falsifying_check": "A failing unit test", "verify_yourself": verify, "question": None})
        for reviewer_id, token, findings, status in (("general", GENERAL_TOKEN, GENERAL_FINDINGS, "blocked"),
                                                     ("coverage", COVERAGE_TOKEN, COVERAGE_FINDINGS, "superseded")):
            save_json(directory / f"automatic-review-{reviewer_id}.json", {"reviewer_id": reviewer_id, "node_id": f"review-{reviewer_id}",
                                                                          "launch_token": token, "session_id": f"{reviewer_id}-uuid", "status": status})
            save_json(directory / f"review-{reviewer_id}.completion.json", {
                "version": "1.2.0", "run_id": "run", "node_id": f"review-{reviewer_id}", "launch_token": token, "bundle_sha256": digest,
                "candidate_commit": self.candidate, "verdict": "blocked" if reviewer_id == "general" else "approved", "findings": findings})
        save_json(directory / "automatic-review.json", {"reviewers": ["general", "coverage"], "status": "blocked"})
        save_json(directory / "review.json", {
            "run_id": "run", "bundle_sha256": digest, "candidate_commit": self.candidate, "reviewer": "general-uuid", "independent": True,
            "verdict": "blocked", "findings": [{**finding, "reviewer": "general"} for finding in GENERAL_FINDINGS],
            "reviewers": [{"reviewer_id": "general", "session_id": "general-uuid", "verdict": "blocked", "accepted_at": "2026-10-04T09:00:00Z"},
                          {"reviewer_id": "coverage", "session_id": None, "verdict": None, "accepted_at": None}]})
        save_json(directory / "sidecar.ledger.json", {"version": "1.0.0", "run_id": "run", "handoff": {
            "unresolved": ["ui: the empty state of the join page is unhandled"], "structural": [], "verified_resolved": [], "withdrawn": [], "gaps": []}})


def brief(directory: Path) -> tuple[int, str, str]:
    from .brief import brief_main
    out, err = io.StringIO(), io.StringIO()
    code = 0
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            brief_main([str(directory)])
        except SystemExit as exit_:
            code = exit_.code
    return code, out.getvalue(), err.getvalue()


def files_of(directory: Path) -> dict:
    return {path.relative_to(directory): path.read_bytes() for path in directory.rglob("*") if path.is_file()}


class BriefTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.run_ = BlockedRun(Path(temp.name))

    def test_a_blocked_run_gives_each_lanes_restore_every_finding_and_the_claims(self):
        run = self.run_
        before = files_of(run.directory)
        code, out, err = brief(run.directory)
        self.assertEqual(code, 0, err)
        self.assertEqual(files_of(run.directory), before)  # Read-only.
        self.assertIn(f"git restore --source={run.candidate} --staged --worktree -- ui.txt", out)
        self.assertIn(f"git restore --source={run.candidate} --staged --worktree -- backend.py legacy.py", out)
        self.assertIn(f"git diff --stat {run.candidate} -- backend.py legacy.py", out)
        self.assertNotIn("git checkout", out)  # The overlay-mode checkout never deletes a file the candidate removed.
        # Every finding verbatim; coverage's came only from its bound file, so it is marked unrecorded.
        for finding in GENERAL_FINDINGS:
            self.assertIn(finding["message"], out)
        self.assertIn(COVERAGE_FINDINGS[0]["message"], out)
        line = next(line for line in out.splitlines() if COVERAGE_FINDINGS[0]["message"] in line)
        self.assertIn("unrecorded", line)
        self.assertNotIn("unrecorded", next(line for line in out.splitlines() if GENERAL_FINDINGS[0]["message"] in line))
        self.assertEqual(out.count(GENERAL_FINDINGS[0]["message"]), 1)  # In review.json and general's file: listed once.
        # The P1 is listed in the ui lane's section, the multiple-lane P2 outside every lane.
        ui_section = out.split("## Lane ui")[1].split("## ")[0]
        self.assertIn(GENERAL_FINDINGS[0]["message"], ui_section)
        self.assertNotIn(GENERAL_FINDINGS[1]["message"], ui_section)
        # Each lane's claims and the sidecar's unresolved handoff.
        self.assertIn("The page in Safari", ui_section)
        self.assertIn("Open the join page with a private match", ui_section)
        self.assertIn("The copy is final", ui_section)
        self.assertIn("the empty state of the join page is unhandled", out)
        self.assertIn("Verdict: blocked", out)

    def test_the_printed_recipe_deletes_a_file_the_candidate_removed(self):
        run = self.run_
        _, out, _ = brief(run.directory)
        recipe = next(line.strip() for line in out.splitlines() if line.strip().startswith("git restore") and "legacy.py" in line)
        check = next(line.strip() for line in out.splitlines() if line.strip().startswith("git diff --stat") and "legacy.py" in line)
        follow = run.root / "follow"
        git(run.repo, "worktree", "add", "-q", "--detach", str(follow), run.plan["base_commit"])
        self.assertTrue((follow / "legacy.py").exists())
        subprocess.run(shlex.split(recipe), cwd=follow, check=True)
        self.assertFalse((follow / "legacy.py").exists())
        self.assertEqual((follow / "backend.py").read_text(), "VALUE = 2\n")
        self.assertEqual(subprocess.run(shlex.split(check), cwd=follow, check=True, capture_output=True, text=True).stdout, "")

    def test_without_a_candidate_the_lane_snapshot_is_restored(self):
        run = self.run_
        for name in ("review.json", "review-bundle.json", "candidate.json"):
            (run.directory / name).unlink()
        code, out, err = brief(run.directory)
        self.assertEqual(code, 0, err)
        self.assertIn(f"git restore --source={run.ui} --staged --worktree -- ui.txt", out)
        self.assertIn(f"git restore --source={run.adapter} --staged --worktree -- backend.py legacy.py", out)
        self.assertIn("Verdict: none recorded", out)

    def test_an_approved_run_lists_its_open_p2s(self):
        run = self.run_
        review = read_json(run.directory / "review.json")
        p2 = {"severity": "P2", "message": "Rename the helper for clarity.", "disposition": "open", "worker": "ui", "requirement": None, "reviewer": "general"}
        review.update(verdict="approved", findings=[p2], reviewers=[{**entry, "verdict": "approved", "session_id": f"{entry['reviewer_id']}-uuid",
                                                                    "accepted_at": "2026-10-04T09:00:00Z"} for entry in review["reviewers"]])
        save_json(run.directory / "review.json", review)
        for reviewer_id in ("general", "coverage"):
            (run.directory / f"review-{reviewer_id}.completion.json").unlink()
        code, out, err = brief(run.directory)
        self.assertEqual(code, 0, err)
        self.assertIn("Verdict: approved", out)
        self.assertIn("Rename the helper for clarity.", out)

    def test_a_malformed_or_foreign_reviewer_file_is_skipped_never_raised(self):
        run = self.run_
        (run.directory / "review-coverage.completion.json").write_text("{not json")
        completion = read_json(run.directory / "review-general.completion.json")
        save_json(run.directory / "review-general.completion.json", {**completion, "launch_token": COVERAGE_TOKEN,
                                                                     "findings": [{**COVERAGE_FINDINGS[0], "message": "Foreign finding."}]})
        code, out, err = brief(run.directory)
        self.assertEqual(code, 0, err)
        self.assertNotIn("Foreign finding.", out)
        self.assertNotIn(COVERAGE_FINDINGS[0]["message"], out)
        self.assertIn(GENERAL_FINDINGS[0]["message"], out)  # From review.json.
        self.assertIn("not read", out)

    def test_a_directory_without_plan_json_is_refused(self):
        code, _, err = brief(self.run_.root / "missing")
        self.assertEqual(code, 1)
        self.assertIn("plan.json", err)


if __name__ == "__main__":
    unittest.main()
