"""Portable workflow slice 1 (docs/PRD_PORTABLE_WORKFLOW.md, section 6): one test per scenario id.

Targets are temporary Git repositories; HOME and the registry path point into temporary directories,
so nothing here reads or writes ~/.config or ~/.local/state. No Claude model calls.
"""
import contextlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from .launch import BUILTIN_BRIEFS, TOOL, feature_names, launch_commands, main as launch_main, resolve_target
from .pipeline import ExportRuntime, export_run
from .registry import merge_registry, register, registry_entry
from .scaffold import init
from .sessions import read_json, save_json
from .test_export import legacy_run
from .test_lanes import LANES, LaneRun
from .verification import CONTRACTS

PY = sys.executable
GOLDEN = CONTRACTS / "examples" / "registry-entry.json"
FOLDED_DOCS = ("CHEATSHEET.md", "LIVE_SESSIONS.md", "INTERACTIVE_SESSIONS.md", "VALIDATION.md", "VERIFICATION.md")
FINISHED_FEATURES = ("project-workflows", "worker-lanes", "parallel-reviewers", "parallel-reviewers-align")


def git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()


def commit_all(repo: Path, message: str = "Change") -> None:
    git(repo, "add", ".")
    git(repo, "commit", "-qm", message)


def make_target(root: Path, name: str = "project-B", *, feature: str | None = "skeleton", reviewers: list | None = None) -> Path:
    """A committed Git repository with `features/` and no `contracts/`; one lane `app` when `feature` is given."""
    repo = root / name
    (repo / "features").mkdir(parents=True)
    (repo / "app.txt").write_text("before\n")
    git(repo, "init", "-q")
    git(repo, "config", "user.name", "Test")
    git(repo, "config", "user.email", "test@example.invalid")
    if feature:
        folder = repo / "features" / feature
        folder.mkdir()
        save_json(folder / "policy.json", {
            "version": "1.2.0", "feature": "Skeleton", "independent_review": True, "integration_approval": True,
            "workers": [{"node_id": "app", "role": "backend", "required_check_kinds": ["unit"], "owned_paths": ["app.txt"],
                         "checks": [{"id": "unit", "kind": "unit", "argv": ["python", "-m", "unittest"], "timeout_seconds": 60, "scenarios": []}]}]})
        (folder / "app-task.md").write_text("## Goal\n\nBuild the app.\n")
        manifest = {"version": "2.1.0" if reviewers else "2.0.0", "name": "Skeleton", "branch_prefix": f"feature/{feature}",
                    "policy": "policy.json", "workers": [{"node_id": "app", "task": "app-task.md"}]}
        if reviewers:
            manifest["reviewers"] = reviewers
        save_json(folder / "feature.json", manifest)
    else:
        (repo / "features/.keep").write_text("")
    commit_all(repo, "Base")
    return repo


class Isolated(unittest.TestCase):
    """HOME and the registry live in a temporary directory for every test."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.home = self.root / "home"
        self.registry = self.root / "config" / "projects.json"
        environment = patch.dict(os.environ, {"HOME": str(self.home), "MD_MANAGER_PROJECTS_CONFIG": str(self.registry)})
        environment.start()
        self.addCleanup(environment.stop)

    def dry_run(self, *argv: str) -> dict:
        with patch("workflow.launch.subprocess.run") as command, contextlib.redirect_stdout(io.StringIO()) as output:
            launch_main([*argv, "--dry-run"])
        command.assert_not_called()
        return json.loads(output.getvalue())

    def refused(self, *argv: str) -> str:
        with patch("workflow.launch.subprocess.run") as command, contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as errors:
            with self.assertRaises(SystemExit) as exit_:
                launch_main(list(argv))
        command.assert_not_called()
        self.assertEqual(exit_.exception.code, 1)
        return errors.getvalue()

    def live(self, *argv: str) -> list:
        """A live launch with every command intercepted; returns (command, cwd) pairs in order."""
        calls = []
        with patch("workflow.launch.subprocess.run", side_effect=lambda command, cwd, check: calls.append((command, cwd))), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            launch_main([*argv, "--live"])
        return calls


class RepoFlag(Isolated):
    def test_repo_flag_resolves_the_feature_in_the_target_and_keys_run_storage_by_repository_name(self):
        """Scenario repo-flag."""
        target = make_target(self.root)
        printed = self.dry_run("skeleton", "--repo", str(target), "--no-herdr")
        root = self.home / ".local/state/agent-workflows/project-B/skeleton"
        self.assertEqual((printed["repository"], printed["run_directory"]), (str(target), str(root / "skeleton-001")))
        preflight, switch, prepare, start = printed["commands"]
        self.assertEqual(preflight[preflight.index("--repo") + 1], str(target))
        self.assertEqual(prepare[prepare.index("--repo") + 1], str(target))
        self.assertEqual(preflight[preflight.index("--policy") + 1], str(target / "features/skeleton/policy.json"))
        self.assertEqual(prepare[prepare.index("--task") + 1], f"app={target / 'features/skeleton/app-task.md'}")
        self.assertEqual(switch, ["git", "switch", "-c", "feature/skeleton/skeleton-001"])
        # Live: `git switch` runs in the target; the workflow commands run from the tool's directory.
        calls = self.live("skeleton", "--repo", str(target), "--no-herdr")
        self.assertEqual([cwd for _, cwd in calls], [TOOL, target, TOOL, TOOL])
        self.assertEqual([command for command, _ in calls], printed["commands"])
        # A path inside the target selects that target; a target without features/ or outside Git is refused.
        self.assertEqual(self.dry_run("skeleton", "--repo", str(target / "features"), "--no-herdr")["repository"], str(target))
        bare = self.root / "bare"
        bare.mkdir()
        self.assertIn("not inside a Git repository", self.refused("skeleton", "--repo", str(bare), "--dry-run"))
        git(bare, "init", "-q")
        self.assertIn("has no features/ directory", self.refused("skeleton", "--repo", str(bare), "--dry-run"))
        # Run storage inside the target is refused, and --run-root still overrides the default.
        self.assertIn("outside the repository", self.refused("skeleton", "--repo", str(target), "--run-root", str(target / "runs"), "--dry-run"))
        self.assertEqual(self.dry_run("skeleton", "--repo", str(target), "--run-root", str(self.root / "runs"))["run_directory"], str(self.root / "runs/skeleton-001"))


class CwdTarget(Isolated):
    def test_cwd_target_is_used_only_for_a_git_repository_with_features_and_repo_wins(self):
        """Scenario cwd-target."""
        target = make_target(self.root)
        other = make_target(self.root, "other", feature="skeleton")
        plain = self.root / "plain"
        plain.mkdir()
        no_features = self.root / "no-features"
        no_features.mkdir()
        git(no_features, "init", "-q")
        self.assertEqual(resolve_target(None, target), target)
        self.assertEqual(resolve_target(None, target / "features"), target)  # A subdirectory of the target.
        self.assertEqual(resolve_target(None, plain), TOOL)
        self.assertEqual(resolve_target(None, no_features), TOOL)
        self.assertEqual(resolve_target(other, target), other)
        with contextlib.chdir(target):
            printed = self.dry_run("skeleton", "--no-herdr")
            self.assertEqual(printed["repository"], str(target))
            self.assertIn("/agent-workflows/project-B/", printed["run_directory"])
            self.assertEqual(self.dry_run("skeleton", "--repo", str(other), "--no-herdr")["repository"], str(other))
        with contextlib.chdir(plain):
            self.assertEqual(self.dry_run("viewer-clarity", "--no-herdr")["repository"], str(TOOL))


class FeatureScan(Isolated):
    def test_feature_scan_lists_directories_with_a_feature_file_and_refuses_unknown_names(self):
        """Scenario feature-scan."""
        target = make_target(self.root)
        (target / "features/notes").mkdir()
        (target / "features/notes/README.md").write_text("Not a feature.\n")
        (target / "features/zeta").mkdir()
        save_json(target / "features/zeta/feature.json", {})
        self.assertEqual(feature_names(target), ["skeleton", "zeta"])
        errors = self.refused("nope", "--repo", str(target), "--dry-run")
        self.assertIn("Unknown feature 'nope'", errors)
        self.assertIn("found: skeleton, zeta", errors)
        self.assertIn("Unknown feature 'notes'", self.refused("notes", "--repo", str(target), "--dry-run"))
        self.assertIn("Unknown feature '../features/skeleton'", self.refused("../features/skeleton", "--repo", str(target), "--dry-run"))
        # md-manager's own features launch by name, with no tuple to maintain.
        self.assertIn("viewer-clarity", feature_names(TOOL))
        self.assertIn("portable-workflow", feature_names(TOOL))
        run, commands, _ = launch_commands(TOOL, "viewer-clarity", "scan-001", self.root / "runs")
        self.assertEqual(commands[1], ["git", "switch", "-c", "feature/viewer-clarity/scan-001"])


class NoTargetSchema(LaneRun):
    def test_no_target_schema_preflight_prepare_and_verification_use_the_bundled_schemas(self):
        """Scenario no-target-schema: the target has no contracts/ directory at all."""
        self.feature_dir()
        self.assertFalse((self.repo / "contracts").exists())
        self.assertEqual(CONTRACTS, TOOL / "contracts/workflow")
        run, commands, _ = launch_commands(self.repo, "lanes", "lanes-001", self.run_root, herdr=False)
        # Preflight needs a Claude CLI; a stand-in answers --help and auth status, nothing else.
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        (bin_dir / "claude").write_text("#!/bin/sh\nif [ \"$1\" = --help ]; then echo '--bg --safe-mode --tools --permission-mode --settings'; "
                                        "elif [ \"$1\" = auth ]; then echo '{\"loggedIn\": true}'; else exit 2; fi\n")
        (bin_dir / "node").write_text("#!/bin/sh\nexit 0\n")
        for item in bin_dir.iterdir():
            item.chmod(0o755)
        env = {**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}"}
        result = subprocess.run(commands[0], cwd=TOOL, env=env, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["preflight"], "passed")
        result = subprocess.run(commands[2], cwd=TOOL, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = read_json(run / "plan.json")
        self.assertEqual((plan["repository"], plan["workers"]), (str(self.repo), LANES))
        # Every lane's result is validated (workerResult, verificationEvidence) and passes against the tool's schemas.
        self.attach(run)
        commit = self.manual_run()
        self.assertEqual(git(self.repo, "rev-parse", "HEAD"), commit)
        for node in LANES:
            self.assertEqual(read_json(run / f"verification/worker/{node}/1/packet.json")["gate"]["status"], "passed")
        self.assertFalse((self.repo / "contracts").exists())


class PreflightClaudeFlags(Isolated):
    def test_preflight_refuses_a_claude_cli_without_settings(self):
        """Every `claude --bg` command passes --settings (the auto-updater off inside its session): a CLI without it is refused."""
        target = make_target(self.root)
        run = self.root / "runs/skeleton-001"
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        (bin_dir / "node").write_text("#!/bin/sh\nexit 0\n")
        env = {**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}"}
        preflight = [PY, "-m", "workflow", "preflight", str(run), "--repo", str(target), "--policy", str(target / "features/skeleton/policy.json")]
        for flags, code in (("--bg --safe-mode --tools --permission-mode --settings", 0), ("--bg --safe-mode --tools --permission-mode", 1)):
            # A stand-in answers --help with exactly these flags, and auth status; nothing else.
            (bin_dir / "claude").write_text(f"#!/bin/sh\nif [ \"$1\" = --help ]; then echo '{flags}'; "
                                            "elif [ \"$1\" = auth ]; then echo '{\"loggedIn\": true}'; else exit 2; fi\n")
            for item in bin_dir.iterdir():
                item.chmod(0o755)
            with self.subTest(flags):
                result = subprocess.run(preflight, cwd=TOOL, env=env, capture_output=True, text=True, timeout=120)
                self.assertEqual(result.returncode, code, result.stderr)
                if code:
                    self.assertIn("Installed Claude CLI lacks required flags", result.stderr)
                else:
                    self.assertEqual(json.loads(result.stdout)["preflight"], "passed")
        self.assertFalse(run.exists())  # The preflight writes nothing.


class MdManagerDefaults(Isolated):
    def test_md_manager_defaults_launch_without_repo_builds_the_same_commands_run_root_and_branch(self):
        """Scenario md-manager-defaults: the commands the launch built before this slice, spelled out."""
        folder = TOOL / "features/viewer-clarity"
        run = self.home / ".local/state/md-manager-workflows/viewer-clarity/viewer-clarity-001"
        base = [PY, "-m", "workflow"]
        policy = str(folder / "policy.json")
        expected = [
            [*base, "preflight", str(run), "--repo", str(TOOL), "--policy", policy, "--herdr", "--automatic"],
            ["git", "switch", "-c", "feature/viewer-clarity/viewer-clarity-001"],
            [*base, "prepare", str(run), "--repo", str(TOOL), "--policy", policy,
             "--task", f"ui={folder / 'ui-task.md'}", "--task", f"adapter={folder / 'adapter-task.md'}",
             "--reviewer", f"general={folder / 'reviewers/general.md'}", "--reviewer", f"coverage={folder / 'reviewers/coverage.md'}",
             "--automatic", "--worker-timeout-seconds", "14400", "--review-timeout-seconds", "1800", "--reviewer-transport", "print"],
            [*base, "start", str(run), "--live", "--herdr"],
            [*base, "automatic", str(run), "--live"],
        ]
        with contextlib.chdir(TOOL):
            printed = self.dry_run("viewer-clarity", "--automatic", "--reviewer-transport", "print")
            self.assertEqual((printed["repository"], printed["run_directory"], printed["commands"]), (str(TOOL), str(run), expected))
            self.assertEqual((printed["workers"], printed["reviewers"], printed["notes"]), (["ui", "adapter"], ["general", "coverage"], []))
            calls = self.live("viewer-clarity", "--automatic", "--reviewer-transport", "print")
        self.assertEqual(calls, [(command, TOOL) for command in expected])  # Every command still runs in md-manager's checkout.


class RegistryEntry(Isolated):
    def other_project(self) -> str:
        """A registry written by hand: compact, with its own spacing, which the merge must keep byte for byte."""
        return ('{\n  "version": 1,\n  "projects": [\n    { "project_id": "md-manager", "name": "MD Manager", "repository": "/srv/md-manager",\n'
                '      "workflows": [ { "workflow_id": "feature-implementation", "runs_root": "/srv/runs/project-workflows",\n'
                '        "definition": { "name": "Feature implementation", "nodes": [ { "node_id": "launch_ui", "label": "Launch UI worker", "kind": "worker", "depends_on": [] } ] } } ] }\n'
                '  ]\n}\n')

    def test_registry_entry_dry_run_prints_it_and_live_launches_add_then_update_only_their_own_workflow(self):
        """Scenario registry-entry."""
        # The golden entry is exactly what the builder produces (the contract test parses it with the server's schema).
        golden = registry_entry(Path("/home/operator/dev/project-B"), "skeleton", Path("/home/operator/.local/state/agent-workflows/project-B/skeleton"), ["app", "api"])
        self.assertEqual(golden, json.loads(GOLDEN.read_text()))
        target = make_target(self.root)
        runs_root = self.home / ".local/state/agent-workflows/project-B/skeleton"
        printed = self.dry_run("skeleton", "--repo", str(target), "--no-herdr")
        self.assertEqual(printed["registry"], {"path": str(self.registry), "entry": registry_entry(target, "skeleton", runs_root, ["app"])})
        self.assertEqual((printed["registry"]["entry"]["project_id"], printed["registry"]["entry"]["name"]), ("project-b", "project-B"))
        self.assertFalse(self.registry.exists())  # A dry run writes nothing.
        # First live launch: the project is added after the other one, which stays byte-identical.
        self.registry.parent.mkdir(parents=True)
        original = self.other_project()
        self.registry.write_text(original)
        self.live("skeleton", "--repo", str(target), "--no-herdr")
        first = self.registry.read_text()
        other_span = original[original.index('    { "project_id"'):original.index("\n  ]\n}")]
        self.assertTrue(first.startswith(original[:original.index("\n  ]\n}")]))
        document = json.loads(first)
        self.assertEqual([project["project_id"] for project in document["projects"]], ["md-manager", "project-b"])
        self.assertEqual(document["projects"][1], registry_entry(target, "skeleton", runs_root, ["app"]))
        # A second feature in the same project is added beside the first; relaunching the first updates only its workflow.
        entry = registry_entry(target, "second", self.root / "second-runs", ["app"])
        self.assertEqual(register(self.registry, entry), "Registry added project-b/second")
        before = self.registry.read_text()
        second_span = before[before.index('"workflow_id": "second"') - 20:]
        updated = registry_entry(target, "skeleton", runs_root, ["app", "api"])
        self.assertEqual(register(self.registry, updated), "Registry updated project-b/skeleton")
        after = self.registry.read_text()
        self.assertIn(other_span, after)
        self.assertTrue(after.endswith(second_span))
        document = json.loads(after)
        self.assertEqual(document["projects"][0], json.loads(original)["projects"][0])
        self.assertEqual([workflow["workflow_id"] for workflow in document["projects"][1]["workflows"]], ["skeleton", "second"])
        self.assertEqual(document["projects"][1]["workflows"][0], updated["workflows"][0])
        self.assertEqual(register(self.registry, updated), "Registry already has project-b/skeleton")
        self.assertEqual(self.registry.read_text(), after)
        # Atomic: a failed replace leaves the previous file and no temporary file behind.
        with patch("workflow.registry.os.replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                register(self.registry, registry_entry(target, "third", self.root / "third-runs", ["app"]))
        self.assertEqual(self.registry.read_text(), after)
        self.assertEqual(sorted(path.name for path in self.registry.parent.iterdir()), ["projects.json"])
        # Never rewritten: an overlapping runs root, a project naming another repository, a malformed file.
        text, note = merge_registry(after, registry_entry(target, "nested", runs_root / "nested", ["app"]))
        self.assertIsNone(text)
        self.assertIn("overlaps", note)
        text, note = merge_registry(after, registry_entry(self.root / "elsewhere" / "project-B", "skeleton", self.root / "x", ["app"]))
        self.assertIsNone(text)
        self.assertIn("already names the repository", note)
        self.registry.write_text('{"version": 2, "projects": []}')
        errors = self.refused("skeleton", "--repo", str(target), "--no-herdr", "--live", "--run-id", "again")
        self.assertIn("refusing to rewrite", errors)
        self.assertEqual(self.registry.read_text(), '{"version": 2, "projects": []}')
        # Without an existing file the registry is created with just this project.
        self.registry.unlink()
        self.assertEqual(register(self.registry, updated), "Registry created with project-b/skeleton")
        self.assertEqual(json.loads(self.registry.read_text()), {"version": 1, "projects": [updated]})


class InitScaffold(Isolated):
    def test_init_scaffold_writes_the_files_never_overwrites_and_launch_names_every_placeholder(self):
        """Scenario init-scaffold."""
        target = make_target(self.root, feature=None)
        result = subprocess.run([PY, "-m", "workflow", "init", "skeleton", "--repo", str(target)], cwd=TOOL, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        folder = target / "features/skeleton"
        self.assertEqual(sorted(path.name for path in folder.iterdir()), ["README.md", "decisions.md", "feature.json", "main-task.md", "policy.json"])
        self.assertTrue((target / "CLAUDE.md").is_file())
        manifest = read_json(folder / "feature.json")
        self.assertEqual((manifest["version"], manifest["branch_prefix"], manifest["reviewers"]),
                         ("2.2.0", "feature/skeleton", [{"reviewer_id": "general", "prompt": "builtin:general"}, {"reviewer_id": "coverage", "prompt": "builtin:coverage"}]))
        decisions = (folder / "decisions.md").read_text()
        for heading in ("## Decisions", "## Assumptions", "## Deferred"):
            self.assertIn(heading, decisions)
        task = (folder / "main-task.md").read_text()
        for heading in ("## Goal", "## Acceptance", "## Stop"):
            self.assertIn(heading, task)
        # Never overwrites: a second init is refused and changes nothing; CLAUDE.md is written only when missing.
        snapshot = {path: path.read_bytes() for path in [*folder.iterdir(), target / "CLAUDE.md"]}
        result = subprocess.run([PY, "-m", "workflow", "init", "skeleton", "--repo", str(target)], cwd=TOOL, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 1)
        self.assertIn("never overwrites", result.stderr)
        self.assertEqual({path: path.read_bytes() for path in snapshot}, snapshot)
        (target / "CLAUDE.md").write_text("# Mine\n")
        written = init(target, "second")
        self.assertNotIn(target / "CLAUDE.md", written)
        self.assertEqual((target / "CLAUDE.md").read_text(), "# Mine\n")
        shutil.rmtree(target / "features/second")
        # Launch refuses the scaffold and names every placeholder.
        errors = self.refused("skeleton", "--repo", str(target), "--dry-run")
        expected = [f"{name}:{number}:" for name in ("README.md", "decisions.md", "feature.json", "main-task.md", "policy.json")
                    for number, line in enumerate((folder / name).read_text().splitlines(), 1) if "TODO:" in line]
        self.assertEqual(len(expected), 15)
        self.assertIn(f"still has {len(expected)} placeholder(s)", errors)
        for item in expected:
            self.assertIn(item, errors)
        # Filled in, the dry run passes.
        manifest["name"] = "Skeleton of project B"
        manifest["prd"] = "app.txt"
        save_json(folder / "feature.json", manifest)
        (folder / "decisions.md").write_text("# Decisions\n\n## Decisions\n\n- One lane.\n\n## Assumptions\n\nNone.\n\n## Deferred\n\nNothing.\n")
        policy = read_json(folder / "policy.json")
        policy["feature"] = "Skeleton"
        policy["workers"][0].update(role="backend", owned_paths=["app.txt"])
        policy["workers"][0]["checks"][0]["argv"] = ["python", "-m", "unittest"]
        save_json(folder / "policy.json", policy)
        (folder / "main-task.md").write_text("## Goal\n\nBuild it.\n\n## Acceptance\n\nIt runs.\n\n## Stop\n\nAfter three failed fixes.\n")
        (folder / "README.md").write_text("# skeleton\n\nThe first feature.\n")
        printed = self.dry_run("skeleton", "--repo", str(target))
        self.assertEqual((printed["workers"], printed["reviewers"]), (["main"], ["general", "coverage"]))


class BuiltinBriefs(Isolated):
    def test_builtin_briefs_resolve_to_the_bundled_files_and_unknown_ids_are_refused_before_git(self):
        """Scenario builtin-briefs."""
        target = make_target(self.root, reviewers=[{"reviewer_id": "general", "prompt": "builtin:general"},
                                                   {"reviewer_id": "coverage", "prompt": "builtin:coverage"}])
        printed = self.dry_run("skeleton", "--repo", str(target), "--no-herdr")
        prepare = printed["commands"][2]
        briefs = [prepare[index + 1] for index, item in enumerate(prepare) if item == "--reviewer"]
        self.assertEqual(briefs, [f"general={BUILTIN_BRIEFS / 'general.md'}", f"coverage={BUILTIN_BRIEFS / 'coverage.md'}"])
        self.assertEqual(BUILTIN_BRIEFS, TOOL / "workflow/prompts/reviewers")
        for name in ("general", "coverage"):
            text = (BUILTIN_BRIEFS / f"{name}.md").read_text()
            self.assertTrue(text.strip())
            for specific in ("md-manager", "browser", "Playwright", "contracts/projects", "screenshot"):
                self.assertNotIn(specific, text)
        # An unknown bundled id is refused before any Git action: no command runs and no branch appears.
        manifest = read_json(target / "features/skeleton/feature.json")
        manifest["reviewers"][1]["prompt"] = "builtin:nope"
        save_json(target / "features/skeleton/feature.json", manifest)
        commit_all(target)
        branches = git(target, "branch", "--list")
        errors = self.refused("skeleton", "--repo", str(target), "--no-herdr", "--live")
        self.assertIn("Unknown bundled reviewer brief 'builtin:nope'", errors)
        self.assertIn("builtin:coverage, builtin:general", errors)
        self.assertEqual(git(target, "branch", "--list"), branches)
        self.assertFalse(self.registry.exists())


class Trimmed(unittest.TestCase):
    def test_trimmed_files_are_gone_and_old_runs_still_export(self):
        """Scenario trimmed."""
        self.assertFalse((TOOL / "workflow/observer.py").exists())
        self.assertIsNone(importlib.util.find_spec("workflow.observer"))
        for name in FOLDED_DOCS:
            self.assertFalse((TOOL / "workflow" / name).exists(), name)
        for name in FINISHED_FEATURES:
            self.assertFalse((TOOL / "features" / name).exists(), name)
        for name in ("project-workflows/feature.json", "project-workflows/policy.json", "worker-lanes/policy.json"):
            self.assertTrue((TOOL / "workflow/testdata" / name).is_file(), name)
        self.assertTrue((TOOL / "workflow/herdr.py").is_file())
        # No document or module (tests and the fixture copies aside) still points at a deleted file.
        deleted = ["observer.py", "workflow.observer", *FOLDED_DOCS, *(f"features/{name}" for name in FINISHED_FEATURES)]
        for folder in (TOOL / "workflow", TOOL / "contracts/workflow"):
            for path in folder.rglob("*"):
                if path.is_file() and path.suffix in {".py", ".md", ".ts", ".json"} and not path.name.startswith("test_") and not {"__pycache__", "testdata"} & set(path.parts):
                    text = path.read_text()
                    for name in deleted:
                        self.assertNotIn(name, text, f"{path} mentions {name}")
        # The standalone interactive flow is gone; attach-one (what the panes run) stays.
        from .interactive import main as interactive_main
        for action in ("prepare", "run", "status", "attach"):
            with patch("workflow.interactive.sys.argv", ["interactive", action, "/nonexistent"]), contextlib.redirect_stderr(io.StringIO()) as errors:
                with self.assertRaises(SystemExit):
                    interactive_main()
            self.assertIn("invalid choice", errors.getvalue())
        # A run recorded before this slice still exports.
        with tempfile.TemporaryDirectory() as root:
            directory = legacy_run(Path(root))
            exported = export_run(ExportRuntime(directory))
            self.assertEqual((exported["run_id"], exported["review"]["verdict"]), ("legacy-001", "approved"))


if __name__ == "__main__":
    unittest.main()


class RegistryFollowUps(Isolated):
    """Review follow-ups of portable-workflow-001: locking, symlinks, aliases, the feature's graph, placeholders."""

    def test_concurrent_registrations_keep_every_workflow(self):
        target = make_target(self.root)
        entries = [registry_entry(target, f"feature-{index}", self.root / f"runs-{index}", ["app"]) for index in range(8)]
        real_merge = merge_registry

        def slow_merge(text, entry):
            time.sleep(0.05)  # Widen the read-to-write window so an unlocked register would lose entries.
            return real_merge(text, entry)

        with patch("workflow.registry.merge_registry", side_effect=slow_merge):
            threads = [threading.Thread(target=register, args=(self.registry, entry)) for entry in entries]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
        document = json.loads(self.registry.read_text())
        self.assertEqual(sorted(workflow["workflow_id"] for workflow in document["projects"][0]["workflows"]),
                         sorted(f"feature-{index}" for index in range(8)))
        self.assertEqual(sorted(path.name for path in self.registry.parent.iterdir()), ["projects.json"])

    def test_a_symlinked_registry_stays_a_symlink_and_its_target_is_updated(self):
        target = make_target(self.root)
        dotfiles = self.root / "dotfiles" / "projects.json"
        dotfiles.parent.mkdir()
        dotfiles.write_text('{"version": 1, "projects": []}\n')
        self.registry.parent.mkdir(parents=True)
        self.registry.symlink_to(dotfiles)
        entry = registry_entry(target, "skeleton", self.root / "runs", ["app"])
        self.assertIn("added project", register(self.registry, entry))
        self.assertTrue(self.registry.is_symlink())
        self.assertEqual(json.loads(dotfiles.read_text())["projects"], [entry])

    def test_an_aliased_runs_root_counts_as_overlapping(self):
        target = make_target(self.root)
        real = self.root / "state" / "runs"
        real.mkdir(parents=True)
        alias = self.root / "alias"
        alias.symlink_to(real)
        register(self.registry, registry_entry(target, "first", real, ["app"]))
        text, note = merge_registry(self.registry.read_text(), registry_entry(target, "second", alias / "nested", ["app"]))
        self.assertIsNone(text)
        self.assertIn("overlaps", note)

    def test_a_subset_launch_registers_the_features_graph_and_relaunch_keeps_edited_labels(self):
        target = make_target(self.root)
        folder = target / "features" / "skeleton"
        policy = read_json(folder / "policy.json")
        second = json.loads(json.dumps(policy["workers"][0]))
        second.update(node_id="api", owned_paths=["api.txt"])
        policy["workers"].append(second)
        save_json(folder / "policy.json", policy)
        (folder / "api-task.md").write_text("## Goal\n\nBuild the api.\n")
        manifest = read_json(folder / "feature.json")
        manifest["workers"].append({"node_id": "api", "task": "api-task.md"})
        save_json(folder / "feature.json", manifest)
        commit_all(target, "Two lanes")
        runs_root = self.home / ".local/state/agent-workflows/project-B/skeleton"
        full = registry_entry(target, "skeleton", runs_root, ["app", "api"])
        self.assertEqual(self.dry_run("skeleton", "--repo", str(target), "--no-herdr", "--workers", "app")["registry"]["entry"], full)
        self.live("skeleton", "--repo", str(target), "--no-herdr", "--workers", "app")
        document = json.loads(self.registry.read_text())
        self.assertEqual(document["projects"][0], full)
        # An operator relabels a node; the next launch over the same graph keeps the label.
        document["projects"][0]["workflows"][0]["definition"]["nodes"][0]["label"] = "Build the app"
        self.registry.write_text(json.dumps(document, indent=2))
        self.assertEqual(register(self.registry, full), "Registry already has project-b/skeleton")
        self.assertEqual(json.loads(self.registry.read_text())["projects"][0]["workflows"][0]["definition"]["nodes"][0]["label"], "Build the app")

    def test_placeholders_are_only_values_and_lines_that_begin_with_the_marker_in_scaffolded_files(self):
        target = make_target(self.root, reviewers=[{"reviewer_id": "general", "prompt": "reviewers/general.md"}])
        folder = target / "features" / "skeleton"
        (folder / "reviewers").mkdir()
        (folder / "reviewers/general.md").write_text("TODO: in a brief is never a placeholder.\n")
        (folder / "README.md").write_text("Launch refuses a line that begins with `TODO:` in the scaffolded files.\n")
        (folder / "app-task.md").write_text("## Goal\n\nKeep the `TODO:` rule working.\n\n## Acceptance\n\nA task that says TODO: mid-line passes.\n")
        (folder / "notes.txt").write_text("TODO: files init does not write are not scanned.\n")
        commit_all(target, "Prose")
        self.assertEqual(self.dry_run("skeleton", "--repo", str(target), "--no-herdr")["workers"], ["app"])
        (folder / "app-task.md").write_text("## Goal\n\n  TODO: fill this in.\n")
        manifest = read_json(folder / "feature.json")
        manifest["name"] = "TODO: name it"
        save_json(folder / "feature.json", manifest)
        errors = self.refused("skeleton", "--repo", str(target), "--no-herdr", "--dry-run")
        self.assertIn("2 placeholder(s)", errors)
        self.assertIn("app-task.md:3: TODO: fill this in.", errors)
        self.assertIn('"name": "TODO: name it"', errors)


class PortablePrompts(unittest.TestCase):
    def test_prompts_name_the_tools_absolute_schema_and_carry_no_md_manager_wording(self):
        from types import SimpleNamespace
        from .automatic import BUILTIN_REVIEW_BRIEF, REVIEW_COMPLETION_SCHEMA, completion_prompt, completion_protocol_prompt, review_prompt
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp) / "run"
            plan = {"run_id": "run-1", "workers": ["app"], "nodes": {"app": {"session_id": "token"}}}
            runtime = SimpleNamespace(directory=directory, plan=plan, workers=["app"])
            protocol = completion_protocol_prompt(runtime, "token", "d" * 64, "c" * 40)
            self.assertTrue(REVIEW_COMPLETION_SCHEMA.is_absolute() and REVIEW_COMPLETION_SCHEMA.is_file())
            self.assertEqual(REVIEW_COMPLETION_SCHEMA.parent, CONTRACTS)
            self.assertIn(f"(schema: {REVIEW_COMPLETION_SCHEMA})", protocol)
            prompts = [protocol, review_prompt(runtime, directory / "review.diff"), completion_prompt(directory, plan, "app"),
                       BUILTIN_REVIEW_BRIEF.read_text(), *[path.read_text() for path in (TOOL / "workflow/prompts/reviewers").glob("*.md")]]
            for text in prompts:
                text = text.replace(str(TOOL), "<tool>")  # The tool's own path may name md-manager; the wording may not.
                for wording in ("this checkout", "this repository", "md-manager", "MD Manager", "Playwright", "npm"):
                    self.assertNotIn(wording, text)
