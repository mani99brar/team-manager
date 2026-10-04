import contextlib
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from .export_state import export_state
from .launch import TOOL, launch_commands, main
from .sessions import git, read_json, save_json

TESTDATA = Path(__file__).resolve().parent / "testdata"


def fixture_target(root: Path) -> Path:
    """A committed Git repository holding a copy of the finished project-workflows feature."""
    repo = root / "target"
    shutil.copytree(TESTDATA / "project-workflows", repo / "features/project-workflows")
    for args in (["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"], ["add", "."], ["commit", "-qm", "Feature"]):
        subprocess.run(["git", "-C", str(repo), *args], check=True)
    return repo


class FeatureLaunchTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.repo = fixture_target(self.root)
        # A live launch registers the run: never in the operator's real registry.
        environment = patch.dict(os.environ, {"MD_MANAGER_PROJECTS_CONFIG": str(self.root / "projects.json"), "HOME": str(self.root / "home")})
        environment.start()
        self.addCleanup(environment.stop)

    def test_committed_feature_plans_preflight_branch_prepare_and_start(self):
        run, commands, _ = launch_commands(self.repo, "project-workflows", "project-workflows-001", Path("/tmp/workflow-launch-tests"))
        self.assertEqual(run.name, "project-workflows-001")
        self.assertEqual(commands[0][3], "preflight")
        self.assertEqual(commands[1], ["git", "switch", "-c", "feature/project-workflows/project-workflows-001"])
        self.assertEqual(commands[2][3], "prepare")
        self.assertNotIn("--workers", commands[2])  # Every declared lane: the selection is not spelled out.
        tasks = [commands[2][index + 1] for index, item in enumerate(commands[2]) if item == "--task"]
        self.assertEqual([task.split("=", 1)[0] for task in tasks], ["ui", "adapter"])
        self.assertTrue(all(Path(task.split("=", 1)[1]).is_file() for task in tasks))
        self.assertEqual(commands[3][3], "start")
        self.assertIn("--live", commands[3])
        self.assertIn("--herdr", commands[3])

    def test_automatic_plan_keeps_launches_in_graph_and_adds_supervision(self):
        _, commands, _ = launch_commands(self.repo, "project-workflows", "auto-test", Path("/tmp/workflow-launch-tests"), automatic=True)
        self.assertIn("--automatic", commands[2])
        self.assertEqual(commands[-1][3], "automatic")
        self.assertIn("--live", commands[-1])
        self.assertFalse(any("push" in command for command in commands))
        self.assertFalse(any(command[0] == "claude" for command in commands))

    def test_automatic_deadlines_are_pinned_into_prepare(self):
        _, commands, _ = launch_commands(self.repo, "project-workflows", "auto-test", Path("/tmp/workflow-launch-tests"), automatic=True)
        prepare = commands[2]
        self.assertEqual(prepare[prepare.index("--worker-timeout-seconds") + 1], str(4 * 3600))
        self.assertEqual(prepare[prepare.index("--review-timeout-seconds") + 1], "1800")
        _, commands, _ = launch_commands(self.repo, "project-workflows", "auto-test", Path("/tmp/workflow-launch-tests"), automatic=True,
                                      worker_timeout_seconds=7200, review_timeout_seconds=600)
        prepare = commands[2]
        self.assertEqual(prepare[prepare.index("--worker-timeout-seconds") + 1], "7200")
        self.assertEqual(prepare[prepare.index("--review-timeout-seconds") + 1], "600")
        with self.assertRaisesRegex(ValueError, "bounded"):
            launch_commands(self.repo, "project-workflows", "auto-test", Path("/tmp/workflow-launch-tests"), automatic=True, worker_timeout_seconds=0)
        with self.assertRaisesRegex(ValueError, "automatic runs only"):
            launch_commands(self.repo, "project-workflows", "auto-test", Path("/tmp/workflow-launch-tests"), worker_timeout_seconds=7200)

    def test_reviewer_transport_is_pinned_into_prepare(self):
        _, commands, _ = launch_commands(self.repo, "project-workflows", "auto-test", Path("/tmp/workflow-launch-tests"), automatic=True)
        prepare = commands[2]
        self.assertEqual(prepare[prepare.index("--reviewer-transport") + 1], "native")
        _, commands, _ = launch_commands(self.repo, "project-workflows", "auto-test", Path("/tmp/workflow-launch-tests"), automatic=True,
                                      reviewer_transport="print")
        prepare = commands[2]
        self.assertEqual(prepare[prepare.index("--reviewer-transport") + 1], "print")
        with self.assertRaisesRegex(ValueError, "reviewer transport"):
            launch_commands(self.repo, "project-workflows", "auto-test", Path("/tmp/workflow-launch-tests"), automatic=True, reviewer_transport="stdio")
        with self.assertRaisesRegex(ValueError, "automatic runs only"):
            launch_commands(self.repo, "project-workflows", "auto-test", Path("/tmp/workflow-launch-tests"), reviewer_transport="print")
        with patch("workflow.launch.subprocess.run") as command, contextlib.redirect_stdout(io.StringIO()) as output:
            main(["project-workflows", "--repo", str(self.repo), "--dry-run", "--automatic", "--reviewer-transport", "print"])
        command.assert_not_called()
        printed = json.loads(output.getvalue())
        self.assertIn("print", printed["commands"][2])

    def test_automatic_launch_passes_a_resumable_exit_on_and_still_blocks_on_a_failure(self):
        # `automatic` exits 75 when Claude Code itself was unavailable: the launch says how to resume, not that it is blocked.
        for returncode, expected_code, expected in ((75, 75, "Claude Code was unavailable; nothing was stopped"), (1, 1, "Launch blocked")):
            def run(command, cwd, check):
                if command[3:4] == ["automatic"]:
                    raise subprocess.CalledProcessError(returncode, command)
            with self.subTest(returncode=returncode), patch("workflow.launch.subprocess.run", side_effect=run), \
                    contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as errors:
                with self.assertRaises(SystemExit) as exited:
                    main(["project-workflows", "--repo", str(self.repo), "--live", "--automatic", "--no-herdr",
                          "--run-id", f"auto-{returncode}", "--run-root", str(self.root / "runs")])
                self.assertEqual(exited.exception.code, expected_code)
                self.assertIn(expected, errors.getvalue())
                if returncode == 75:
                    self.assertIn(f"-m workflow automatic {self.root / 'runs' / 'auto-75'} --live", errors.getvalue())

    def test_a_live_launch_first_says_how_the_run_finishes(self):
        # From the automatic settings prepare pins (plan.automatic), not from plan.mode, which is "interactive" for every run.
        finishes = {True: "automatic, finish verified-feature-branch: once every reviewer approves, the controller fast-forwards {branch} "
                          "itself; it does not stop for integration approval, and nothing merges main or pushes",
                    False: "manual: you freeze the workers, import each review and approve the fast-forward of {branch}; nothing is pushed"}
        for automatic, finish in finishes.items():
            run_id = "finish-automatic" if automatic else "finish-manual"
            with self.subTest(automatic=automatic), patch("workflow.launch.subprocess.run"), contextlib.redirect_stdout(io.StringIO()) as output, \
                    contextlib.redirect_stderr(io.StringIO()):
                main(["project-workflows", "--repo", str(self.repo), "--live", "--no-herdr", "--run-id", run_id, "--run-root", str(self.root / "runs"),
                      *(["--automatic"] if automatic else [])])
                run = (self.root / "runs" / run_id).resolve()
                self.assertEqual(output.getvalue().splitlines()[0],
                                 f"Run {run}: {finish.format(branch=f'feature/project-workflows/{run_id}')}.")

    def test_dry_run_does_not_execute_anything(self):
        with patch("workflow.launch.subprocess.run") as command, contextlib.redirect_stdout(io.StringIO()):
            main(["project-workflows", "--repo", str(self.repo), "--dry-run"])
        command.assert_not_called()

    def test_missing_live_consent_never_runs_commands(self):
        with patch("workflow.launch.subprocess.run") as command, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                main(["project-workflows", "--repo", str(self.repo)])
        command.assert_not_called()

    def test_duplicate_run_is_not_relaunched(self):
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / "project-workflows-001").mkdir()
            with patch("workflow.launch.subprocess.run") as command, contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    main(["project-workflows", "--repo", str(self.repo), "--live", "--run-root", root])
            command.assert_not_called()

    def test_run_id_cannot_escape_storage(self):
        for run_id in ("../other", "/tmp/other", "bad/id"):
            with self.assertRaises(ValueError):
                launch_commands(self.repo, "project-workflows", run_id, Path("/tmp/workflow-launch-tests"))

    def test_export_is_stable_until_state_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plan = {"run_id": "demo", "base_commit": "a" * 40, "created_at": "2026-01-01T00:00:00Z"}
            save_json(root / "plan.json", plan)
            runtime = SimpleNamespace(directory=root, plan=plan)
            state = SimpleNamespace(values={}, next=("launch_ui", "launch_adapter"), tasks=[])
            first = export_state(runtime, state)
            contents = (root / "run-state.json").read_bytes()
            self.assertEqual(export_state(runtime, state), first)
            self.assertEqual((root / "run-state.json").read_bytes(), contents)
            state.values = {"ui": {"session_id": "observed"}}
            second = export_state(runtime, state)
            self.assertEqual(second["created_at"], first["created_at"])
            self.assertNotEqual(second["values"], first["values"])
            self.assertEqual(len(second["definition"]["nodes"]), 9)


def ago(hours: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat().replace("+00:00", "Z")


class LaunchNotes(unittest.TestCase):
    """C23 and C27: notes at launch, dry runs included, that prepare records as one run event. Never a refusal."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.repo = fixture_target(self.root)
        # The launched feature's adapter lane also owns package.json.
        policy_path = self.repo / "features/project-workflows/policy.json"
        policy = json.loads(policy_path.read_text())
        policy["workers"][1]["owned_paths"].append("package.json")
        policy_path.write_text(json.dumps(policy, indent=2) + "\n")
        git(self.repo, "commit", "-qam", "adapter owns package.json")
        self.base = git(self.repo, "rev-parse", "HEAD")
        self.registry = self.root / "config" / "projects.json"
        environment = patch.dict(os.environ, {"MD_MANAGER_PROJECTS_CONFIG": str(self.registry), "HOME": str(self.root / "home")})
        environment.start()
        self.addCleanup(environment.stop)
        self.runs = self.root / "runs"
        self.own_root = self.runs / "project-workflows"
        # Another feature of the same repository, still running: its web lane owns package.json too.
        self.first = self.make_run(self.runs / "first" / "first-001", self.repo, [{"node_id": "web", "owned_paths": ["package.json", "web"]}])
        self.registry.parent.mkdir(parents=True)
        save_json(self.registry, {"version": 1, "projects": [{"project_id": "target", "name": "target", "repository": str(self.repo), "workflows": [
            {"workflow_id": "first", "runs_root": str(self.runs / "first")},
            {"workflow_id": "project-workflows", "runs_root": str(self.own_root)}]}]})

    def make_run(self, directory: Path, repository: Path, lanes: list[dict], *, hours: float = 1, kinds: dict | None = None) -> Path:
        """A run directory as prepare and the controller leave it: plan, pinned policy and an event `hours` ago."""
        workers = [{"node_id": lane["node_id"], "role": "backend", "required_check_kinds": (kinds or {}).get(lane["node_id"], ["unit"]),
                    "owned_paths": lane["owned_paths"], "checks": [
                        {"id": f"{lane['node_id']}-{kind}", "kind": kind, "argv": ["npm", "run", f"{lane['node_id']}-{kind}"], "timeout_seconds": 60, "scenarios": []}
                        for kind in (kinds or {}).get(lane["node_id"], ["unit"])]} for lane in lanes]
        directory.mkdir(parents=True, exist_ok=True)
        save_json(directory / "plan.json", {"run_id": directory.name, "repository": str(repository), "base_commit": self.base, "created_at": ago(hours),
                                            "workers": [lane["node_id"] for lane in lanes], "excluded_workers": []})
        save_json(directory / "policy.json", {"version": "1.2.0", "feature": directory.parent.name, "independent_review": True,
                                              "integration_approval": True, "workers": workers})
        (directory / "events.jsonl").write_text(json.dumps({"sequence": 1, "time": ago(hours), "node": "controller", "status": "running", "message": "x"}) + "\n")
        return directory

    def notes(self, run_id: str = "project-workflows-002") -> list[str]:
        _, _, notes = launch_commands(self.repo, "project-workflows", run_id, self.own_root, herdr=False)
        return notes

    def overlaps(self) -> list[str]:
        return [note for note in self.notes() if "overlaps" in note]

    def test_a_running_feature_of_the_same_repository_that_owns_the_same_path_is_named(self):
        [note] = self.overlaps()
        self.assertIn("package.json", note)
        self.assertIn("first-001", note)
        self.assertIn("no candidate yet", note)
        # The dry run prints it among its notes and runs nothing.
        with patch("workflow.launch.subprocess.run") as command, contextlib.redirect_stdout(io.StringIO()) as output, \
                contextlib.redirect_stderr(io.StringIO()) as errors:
            main(["project-workflows", "--repo", str(self.repo), "--dry-run", "--run-root", str(self.own_root)])
        command.assert_not_called()
        self.assertEqual([item for item in json.loads(output.getvalue())["notes"] if "overlaps" in item], [note])
        self.assertIn(f"Note: {note}", errors.getvalue())
        # A candidate that is not in the new base still counts.
        git(self.repo, "switch", "-qc", "side")
        (self.repo / "package.json").write_text("{}\n")
        git(self.repo, "add", "package.json")
        git(self.repo, "commit", "-qm", "side")
        side = git(self.repo, "rev-parse", "HEAD")
        git(self.repo, "switch", "-q", "-")
        save_json(self.first / "review-bundle.json", {"candidate_commit": side})
        [note] = self.overlaps()
        self.assertIn(f"candidate {side[:12]} is not in this base", note)

    def test_runs_whose_work_is_in_the_base_idle_runs_earlier_runs_of_the_feature_and_other_repositories_give_none(self):
        with self.subTest("candidate in the new base"):
            save_json(self.first / "review-bundle.json", {"candidate_commit": self.base})
            self.assertEqual(self.overlaps(), [])
            (self.first / "review-bundle.json").unlink()
        with self.subTest("idle for more than 48 hours"):
            self.make_run(self.first, self.repo, [{"node_id": "web", "owned_paths": ["package.json"]}], hours=49)
            self.assertEqual(self.overlaps(), [])
        with self.subTest("an earlier run of the same feature"):
            self.make_run(self.own_root / "project-workflows-001", self.repo, [{"node_id": "adapter", "owned_paths": ["package.json"]}])
            self.assertEqual(self.overlaps(), [])
        with self.subTest("another repository"):
            other = self.root / "other"
            other.mkdir()
            for args in (["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"], ["commit", "-q", "--allow-empty", "-m", "Other"]):
                subprocess.run(["git", "-C", str(other), *args], check=True)
            self.make_run(self.first, other, [{"node_id": "web", "owned_paths": ["package.json"]}])
            self.assertEqual(self.overlaps(), [])
        with self.subTest("a checkout that is gone"):
            self.make_run(self.first, self.root / "gone", [{"node_id": "web", "owned_paths": ["package.json"]}])
            self.assertEqual(self.overlaps(), [])

    def test_a_linked_worktree_and_a_clone_of_the_same_repository_each_give_one(self):
        worktree, clone = self.root / "linked", self.root / "clone"
        git(self.repo, "worktree", "add", "-q", "--detach", str(worktree))
        subprocess.run(["git", "clone", "-q", str(self.repo), str(clone)], check=True)
        for checkout in (worktree, clone):
            with self.subTest(checkout=checkout.name):
                self.make_run(self.first, checkout, [{"node_id": "web", "owned_paths": ["package.json"]}])
                self.assertEqual(len(self.overlaps()), 1)

    def test_a_kind_removed_since_the_previous_run_is_noted_and_prepare_records_the_notes(self):
        self.make_run(self.own_root / "project-workflows-001", self.repo, [{"node_id": "ui", "owned_paths": ["src"]}, {"node_id": "adapter", "owned_paths": ["server"]}],
                 kinds={"ui": ["build", "browser"], "adapter": ["unit", "contract", "integration"]})
        removed = ("Lane adapter requires fewer checks than the policy of project-workflows-001: required kind contract removed; "
                   "required kind integration removed; check adapter-contract removed; check adapter-integration removed; check adapter-unit removed.")
        with patch("workflow.launch.subprocess.run"), contextlib.redirect_stdout(io.StringIO()) as output, contextlib.redirect_stderr(io.StringIO()):
            main(["project-workflows", "--repo", str(self.repo), "--dry-run", "--run-root", str(self.own_root), "--run-id", "project-workflows-002"])
        notes = json.loads(output.getvalue())["notes"]
        self.assertIn(removed, notes)
        # prepare (the real command, no agent) records the launch's notes as one run event.
        run, commands, expected = launch_commands(self.repo, "project-workflows", "project-workflows-002", self.own_root, herdr=False)
        self.assertEqual(expected, notes)
        result = subprocess.run(commands[2], cwd=TOOL, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        events = [json.loads(line) for line in (run / "events.jsonl").read_text().splitlines()]
        launch = [event for event in events if event["message"].startswith("Launch notes: ")]
        self.assertEqual([(event["node"], event["status"]) for event in launch], [("controller", "running")])
        for note in expected:
            self.assertIn(note, launch[0]["message"])


if __name__ == "__main__":
    unittest.main()
