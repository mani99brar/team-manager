"""Worker-phase file capture (PRD_VIEWER_CLARITY 4.1): real Git snapshots, real verification worktrees and checks."""
import contextlib
import hashlib
import io
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from jsonschema.exceptions import ValidationError

from . import checks
from .checks import FILE_CAPTURE_LIMIT, PACKET_FILE_CAPTURE_LIMIT, recheck_packet, reuse_packet, text_test_counts, verify_revision
from .sessions import git, save_json
from .verification import validate_schema
from .worktrees import git_worktree

UNIT = [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"]
PNG = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"


class FileCaptureTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.repo = self.root / "repo"
        (self.repo / "tests").mkdir(parents=True)
        (self.repo / "docs").mkdir()
        (self.repo / "tests/test_ok.py").write_text("import unittest\nclass Ok(unittest.TestCase):\n    def test_ok(self):\n        pass\n")
        (self.repo / "docs/OLD.md").write_text("# Old\n")
        (self.repo / ".gitignore").write_text("__pycache__/\n")
        for args in (["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"], ["add", "."], ["commit", "-qm", "Base"]):
            subprocess.run(["git", "-C", str(self.repo), *args], check=True)
        self.base = git(self.repo, "rev-parse", "HEAD")
        self.run_dir = self.root / "run"
        self.run_dir.mkdir()
        self.plan = {"repository": str(self.repo), "run_id": "run", "base_commit": self.base}

    def policy(self, argv=UNIT):
        return {"version": "1.0.0", "feature": "Capture test", "independent_review": True, "integration_approval": True,
                "workers": [{"node_id": "adapter", "role": "backend", "owned_paths": ["docs", "src", "assets", "tests"],
                             "checks": [{"id": "unit", "kind": "unit", "argv": argv, "timeout_seconds": 60, "scenarios": []}]}]}

    def snapshot(self, files: dict[str, bytes], deleted=()) -> tuple[str, list[str]]:
        for path, content in files.items():
            (self.repo / path).parent.mkdir(parents=True, exist_ok=True)
            (self.repo / path).write_bytes(content)
        for path in deleted:
            (self.repo / path).unlink()
        subprocess.run(["git", "-C", str(self.repo), "add", "-A"], check=True)
        subprocess.run(["git", "-C", str(self.repo), "commit", "-qm", "Snapshot"], check=True)
        commit = git(self.repo, "rev-parse", "HEAD")
        changed = git(self.repo, "diff", "--no-renames", "--name-only", self.base, commit).splitlines()
        return commit, changed

    def verify(self, commit, changed, phase="worker", policy=None, attempt=1):
        return verify_revision(self.run_dir, self.plan, policy or self.policy(), "adapter", commit, changed, "session", phase=phase, attempt=attempt)

    def files(self, packet):
        return [artifact for artifact in packet["result"]["artifacts"] if artifact["kind"] == "file"]

    def test_capture_text_files(self):
        """[scenario:capture-text-files] text files become `file` artifacts; binary, too large and deleted paths are listed."""
        content = {"docs/GUIDE.md": b"# Guide\n\nSee `src/app.ts:3`.\n", "src/app.ts": "export const greeting = 'héllo'\n".encode(),
                   "docs/large.txt": b"x" * (600 * 1024), "assets/logo.png": PNG}
        commit, changed = self.snapshot(content, deleted=["docs/OLD.md"])
        packet = self.verify(commit, changed)
        self.assertEqual(packet["gate"]["status"], "passed", packet["gate"]["reasons"])
        files = self.files(packet)
        self.assertEqual([artifact["path"] for artifact in files], ["docs/GUIDE.md", "src/app.ts"])
        for artifact in files:
            retained = Path(packet["artifact_paths"][artifact["artifact_id"]]).read_bytes()
            self.assertEqual(retained, content[artifact["path"]])
            self.assertEqual(artifact["sha256"], hashlib.sha256(content[artifact["path"]]).hexdigest())
        self.assertEqual(sorted(packet["result"]["files_not_captured"], key=lambda entry: entry["path"]),
                         [{"path": "assets/logo.png", "reason": "binary"}, {"path": "docs/OLD.md", "reason": "missing"},
                          {"path": "docs/large.txt", "reason": "too_large"}])
        validate_schema("workerResult", packet["result"])
        saved = json.loads((self.run_dir / "verification/worker/adapter/1/packet.json").read_text())
        self.assertEqual(saved["result"]["files_not_captured"], packet["result"]["files_not_captured"])
        # The candidate phase lists changed files as before and captures nothing.
        candidate = self.verify(commit, changed, phase="candidate")
        self.assertEqual(candidate["gate"]["status"], "passed", candidate["gate"]["reasons"])
        self.assertEqual(candidate["result"]["changed_files"], changed)
        self.assertEqual(self.files(candidate), [])
        self.assertNotIn("files_not_captured", candidate["result"])

    def test_caps_and_text_rule(self):
        self.assertEqual((FILE_CAPTURE_LIMIT, PACKET_FILE_CAPTURE_LIMIT), (512 * 1024, 8 * 1024 * 1024))
        content = {"docs/at-cap.txt": b"a" * FILE_CAPTURE_LIMIT, "docs/over-cap.txt": b"a" * (FILE_CAPTURE_LIMIT + 1),
                   "docs/nul.txt": b"text\0with a NUL\n", "docs/latin1.txt": "café".encode("latin-1"), "docs/empty.md": b""}
        commit, changed = self.snapshot(content)
        packet = self.verify(commit, changed)
        self.assertEqual(sorted(artifact["path"] for artifact in self.files(packet)), ["docs/at-cap.txt", "docs/empty.md"])
        self.assertEqual(sorted((entry["path"], entry["reason"]) for entry in packet["result"]["files_not_captured"]),
                         [("docs/latin1.txt", "binary"), ("docs/nul.txt", "binary"), ("docs/over-cap.txt", "too_large")])

    def test_budget_is_spent_in_changed_file_order(self):
        content = {"docs/a.md": b"a" * 60, "docs/b.md": b"b" * 60, "docs/c.md": b"c" * 30}
        commit, changed = self.snapshot(content)
        with patch.object(checks, "PACKET_FILE_CAPTURE_LIMIT", 100):
            packet = self.verify(commit, changed)
        self.assertEqual(packet["gate"]["status"], "passed", packet["gate"]["reasons"])
        self.assertEqual([artifact["path"] for artifact in self.files(packet)], ["docs/a.md", "docs/c.md"])
        self.assertEqual(packet["result"]["files_not_captured"], [{"path": "docs/b.md", "reason": "budget"}])

    def test_symbolic_link_is_not_followed(self):
        (self.repo / "docs").mkdir(exist_ok=True)
        (self.repo / "docs/link.md").symlink_to("/etc/hostname")
        commit, changed = self.snapshot({"docs/real.md": b"# Real\n"})
        packet = self.verify(commit, changed)
        self.assertEqual([artifact["path"] for artifact in self.files(packet)], ["docs/real.md"])
        self.assertEqual(packet["result"]["files_not_captured"], [{"path": "docs/link.md", "reason": "missing"}])

    def test_capture_before_checks(self):
        """[scenario:capture-before-checks] a check that rewrites a captured file cannot change the recorded bytes."""
        original = b"# Notes\n\nOriginal snapshot content.\n"
        commit, changed = self.snapshot({"docs/NOTES.md": original})
        rewrite = [sys.executable, "-c", "import pathlib, unittest; pathlib.Path('docs/NOTES.md').write_text('rewritten by a check'); "
                   "unittest.main(module=None, argv=['unit', 'discover', '-s', 'tests', '-p', 'test_*.py'])"]
        packet = self.verify(commit, changed, policy=self.policy(rewrite))
        [artifact] = self.files(packet)
        self.assertEqual(Path(packet["artifact_paths"][artifact["artifact_id"]]).read_bytes(), original)
        self.assertEqual(artifact["sha256"], hashlib.sha256(original).hexdigest())
        self.assertEqual(packet["gate"]["status"], "blocked")
        self.assertIn("Verification modified the tested source revision", packet["gate"]["reasons"])

    def test_tampered_file_artifact(self):
        """[scenario:tampered-file-artifact] recheck_packet rejects a retained file whose bytes no longer match."""
        commit, changed = self.snapshot({"docs/GUIDE.md": b"# Guide\n"})
        policy = self.policy()
        packet = self.verify(commit, changed, policy=policy)
        self.assertEqual(packet["gate"]["status"], "passed", packet["gate"]["reasons"])
        [artifact] = self.files(packet)
        retained = Path(packet["artifact_paths"][artifact["artifact_id"]])
        retained.chmod(0o600)
        retained.write_bytes(b"# Guide\n\nEdited after capture.\n")
        rechecked = recheck_packet(json.loads(json.dumps(packet)), policy, self.run_dir)
        self.assertEqual(rechecked["gate"]["status"], "blocked")
        self.assertIn(f"Artifact hash mismatch: {artifact['artifact_id']}", rechecked["gate"]["reasons"])
        # The saved packet is rechecked the same way when verification is asked again for the same revision.
        self.assertEqual(self.verify(commit, changed, policy=policy)["gate"]["status"], "blocked")

    def test_a_cached_packet_of_another_phase_lane_or_attempt_is_refused_not_reused(self):
        """A passed worker packet at the candidate path once answered a candidate request whose build failed: the cache
        reuses a packet only when its own phase, lane and attempt are the call's."""
        commit, changed = self.snapshot({"docs/GUIDE.md": b"# Guide\n"})
        worker = self.verify(commit, changed)
        self.assertEqual(worker["gate"]["status"], "passed", worker["gate"]["reasons"])
        lane = json.loads(json.dumps(worker))
        lane["expected"]["node_id"] = "ui"
        for phase, attempt, packet, found in (("candidate", 1, worker, "worker packet of adapter attempt 1"),
                                              ("worker", 2, worker, "worker packet of adapter attempt 1"),
                                              ("worker", 3, lane, "worker packet of ui attempt 1")):
            with self.subTest(phase=phase, attempt=attempt):
                path = self.run_dir / "verification" / phase / "adapter" / str(attempt) / "packet.json"
                path.parent.mkdir(parents=True)
                path.write_text(json.dumps(packet))
                with self.assertRaisesRegex(ValueError, re.escape(f"Existing verification at {path} is the {found}, not the {phase} packet of "
                                                                  f"adapter attempt {attempt}")):
                    self.verify(commit, changed, phase=phase, attempt=attempt)
                self.assertEqual(sorted(item.name for item in path.parent.iterdir()), ["packet.json"])  # Nothing ran.
        # The packet of the call's own phase, lane and attempt is still reused.
        self.assertEqual(self.verify(commit, changed), worker)

    def test_schema_requires_a_safe_path_exactly_on_file_artifacts(self):
        commit, changed = self.snapshot({"docs/GUIDE.md": b"# Guide\n"})
        result = self.verify(commit, changed)["result"]
        validate_schema("workerResult", result)
        legacy = {key: value for key, value in result.items() if key != "files_not_captured"}
        legacy["artifacts"] = [artifact for artifact in result["artifacts"] if artifact["kind"] != "file"]
        validate_schema("workerResult", legacy)
        file_artifact = next(artifact for artifact in result["artifacts"] if artifact["kind"] == "file")
        log_artifact = next(artifact for artifact in result["artifacts"] if artifact["kind"] == "log")
        bad_artifacts = [{key: value for key, value in file_artifact.items() if key != "path"}, {**log_artifact, "path": "docs/GUIDE.md"}]
        bad_artifacts += [{**file_artifact, "path": path} for path in ("/etc/passwd", "../secret", "docs/../../secret", "C:/secret", "docs\\x", "")]
        for artifact in bad_artifacts:
            with self.assertRaises(ValidationError, msg=artifact):
                validate_schema("workerResult", {**result, "artifacts": [log_artifact, artifact]})
        for entry in ({"path": "docs/GUIDE.md", "reason": "unreadable"}, {"path": "/docs/GUIDE.md", "reason": "binary"}, {"path": "docs/GUIDE.md"}):
            with self.assertRaises(ValidationError, msg=entry):
                validate_schema("workerResult", {**result, "files_not_captured": [entry]})

    def test_files_not_captured_must_name_distinct_changed_files(self):
        commit, changed = self.snapshot({"docs/GUIDE.md": b"# Guide\n", "assets/logo.png": PNG})
        policy = self.policy()
        packet = self.verify(commit, changed, policy=policy)
        self.assertEqual(packet["gate"]["status"], "passed", packet["gate"]["reasons"])
        for entries in ([{"path": "docs/OTHER.md", "reason": "missing"}], [{"path": "docs/GUIDE.md", "reason": "binary"}],
                        [{"path": "assets/logo.png", "reason": "binary"}] * 2):
            forged = json.loads(json.dumps(packet))
            forged["result"]["files_not_captured"] = entries
            self.assertEqual(recheck_packet(forged, policy, self.run_dir)["gate"]["status"], "blocked", entries)

    def test_checks_never_inherit_a_surrounding_claude_sessions_variables_or_its_model_and_effort_overrides(self):
        # C52 hygiene (sessions.scrub_env): a check's own `claude` call runs as no part of the controller's session. The scrubbed
        # names are not secrets, so the packet does not list them; the config and provider variables stay.
        from .checks import check_environment
        env, dropped = check_environment({"PATH": "/usr/bin", "CLAUDE_CONFIG_DIR": "/home/operator/.claude", "CLAUDE_CODE_USE_BEDROCK": "1",
                                          "CLAUDECODE": "1", "CLAUDE_CODE_ENTRYPOINT": "cli", "CLAUDE_CODE_EFFORT_LEVEL": "low",
                                          "ANTHROPIC_MODEL": "claude-haiku", "HERDR_PANE_ID": "w1:p1", "GH_TOKEN": "ghp_fake"})
        self.assertEqual(env, {"PATH": "/usr/bin", "CLAUDE_CONFIG_DIR": "/home/operator/.claude", "CLAUDE_CODE_USE_BEDROCK": "1",
                               "HUSKY": "0", "GIT_TERMINAL_PROMPT": "0"})
        self.assertEqual(dropped, ["GH_TOKEN"])

    def test_checks_run_without_secret_like_names_and_the_packet_names_them(self):
        """C14 slice 1: names ending in _KEY, _TOKEN, _SECRET or _PASSWORD, and GH_* and GITHUB_* names, never reach a check;
        *_URL names do (pine-chain's fork check reads GNOSIS_RPC_URL). Hooks and Git prompts are off. The packet lists the
        dropped names, never their values, beside the evidence, whose schema is closed."""
        secrets = {"GH_TOKEN": "ghp_fake0token", "GITHUB_ACTOR": "fake-actor", "DEEPSEEK_API_KEY": "sk-fake0deepseek",
                   "DEPLOYER_KEY": "0xfake0deployer", "APP_SECRET": "fake0app0secret", "MY_SERVICE_PASSWORD": "fake0password"}
        kept = {"GNOSIS_RPC_URL": "https://rpc.example.invalid/v1", "GITHUB_API_URL": "https://api.example.invalid"}
        names = [*secrets, *kept, "PATH", "HUSKY", "GIT_TERMINAL_PROMPT"]
        probe = [sys.executable, "-c", "import json, os\n"
                 f"print('SEEN ' + json.dumps({{name: os.environ.get(name) for name in {names!r}}}))\n"
                 "print('Ran 1 test in 0.001s\\n\\nOK')\n"]
        commit, changed = self.snapshot({"docs/GUIDE.md": b"# Guide\n"})
        policy = self.policy(probe)
        with patch.dict("os.environ", {**secrets, **kept, "HUSKY": "1", "GIT_TERMINAL_PROMPT": "1"}):
            packet = self.verify(commit, changed, policy=policy)
        self.assertEqual(packet["gate"]["status"], "passed", packet["gate"]["reasons"])
        log = Path(packet["artifact_paths"][packet["result"]["checks"][0]["log_artifact_id"]]).read_text()
        seen = json.loads(next(line for line in log.splitlines() if line.startswith("SEEN "))[len("SEEN "):])
        self.assertEqual({name: seen[name] for name in secrets}, dict.fromkeys(secrets))
        self.assertEqual({name: seen[name] for name in kept}, kept)
        self.assertTrue(seen["PATH"])
        self.assertEqual((seen["HUSKY"], seen["GIT_TERMINAL_PROMPT"]), ("0", "0"))
        # Every dropped name is listed in order (the controller's own environment may add more of the same kind), no value is.
        dropped = packet["dropped_env_names"]
        self.assertEqual(dropped, sorted(dropped))
        self.assertLessEqual(set(secrets), set(dropped))
        self.assertFalse(set(kept) & set(dropped))
        for name in dropped:
            self.assertRegex(name.upper(), r"(_KEY|_TOKEN|_SECRET|_PASSWORD)$|^(GH|GITHUB)_")
        saved = (self.run_dir / "verification/worker/adapter/1/packet.json").read_text()
        self.assertEqual(json.loads(saved)["dropped_env_names"], dropped)
        for value in secrets.values():
            self.assertNotIn(value, saved)
        validate_schema("verificationEvidence", packet["evidence"])
        validate_schema("workerResult", packet["result"])
        self.assertEqual(recheck_packet(json.loads(saved), policy, self.run_dir)["gate"]["status"], "passed")


class ReusedPacketTests(unittest.TestCase):
    """C28: a single lane without a browser check reuses its worker packet at the candidate gate, by reference."""

    def setUp(self):
        self.fixture = FileCaptureTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        f = self.fixture
        self.commit, self.changed = f.snapshot({"docs/GUIDE.md": b"# Guide\n"})
        self.worker = f.verify(self.commit, self.changed)
        self.worker_path = f.run_dir / "verification/worker/adapter/1/packet.json"

    def reuse(self, policy=None, attempt=1, worker_path=None, commit=None):
        f = self.fixture
        return reuse_packet(f.run_dir, f.plan, policy or f.policy(), "adapter", commit or self.commit, worker_path or self.worker_path, attempt=attempt)

    def test_the_candidate_packet_names_the_worker_packet_and_runs_nothing(self):
        f = self.fixture
        packet = self.reuse()
        path = f.run_dir / "verification/candidate/adapter/1/packet.json"
        saved = json.loads(path.read_text())
        self.assertEqual(saved["phase"], "candidate")
        self.assertEqual({key: saved["expected"][key] for key in ("run_id", "node_id", "attempt", "output_commit")},
                         {"run_id": "run", "node_id": "adapter", "attempt": 1, "output_commit": self.commit})
        self.assertEqual(saved["reused_from"], {"path": "verification/worker/adapter/1/packet.json",
                                                "sha256": hashlib.sha256(self.worker_path.read_bytes()).hexdigest()})
        self.assertEqual(sorted(item.name for item in path.parent.iterdir()), ["packet.json"])  # No worktree, no check ran.
        self.assertEqual((saved["gate"]["status"], saved["result"]["attempt"], saved["result"]["node_id"]), ("passed", 1, "adapter"))
        self.assertEqual(saved["artifact_paths"], self.worker["artifact_paths"])  # The links resolve to the worker's artifacts.
        self.assertEqual((packet["phase"], packet["gate"]["status"], packet["reused_from"]), ("candidate", "passed", saved["reused_from"]))
        # The cache answers the same call with the same packet; recheck_packet re-gates the referenced worker packet.
        self.assertEqual(recheck_packet(json.loads(path.read_text()), f.policy(), f.run_dir)["gate"]["status"], "passed")
        self.assertEqual(self.reuse()["gate"]["status"], "passed")
        self.assertEqual(f.verify(self.commit, self.changed, phase="candidate")["gate"]["status"], "passed")

    def test_the_worker_packet_is_regated_in_the_candidate_phase(self):
        f = self.fixture
        policy = f.policy()
        policy["workers"][0]["checks"].append({"id": "build", "kind": "build", "argv": [sys.executable, "-c", "raise SystemExit(1)"],
                                               "timeout_seconds": 60, "scenarios": []})
        commit, changed = f.snapshot({"docs/OTHER.md": b"# Other\n"})
        worker = verify_revision(f.run_dir, f.plan, policy, "adapter", commit, changed, "session", attempt=2)
        self.assertEqual((worker["gate"]["status"], worker["gate"]["deferred_checks"]), ("passed", ["build"]))
        packet = self.reuse(policy=policy, commit=commit, worker_path=f.run_dir / "verification/worker/adapter/2/packet.json")
        self.assertEqual(packet["gate"]["status"], "blocked")
        self.assertIn("build: exit 1", packet["gate"]["reasons"])
        self.assertEqual(json.loads((f.run_dir / "verification/candidate/adapter/1/packet.json").read_text())["gate"]["status"], "blocked")

    def test_a_changed_or_foreign_worker_packet_is_refused(self):
        f = self.fixture
        with self.assertRaisesRegex(ValueError, "is not the worker packet of adapter at"):
            self.reuse(commit=self.fixture.base)  # Another revision than the one the worker packet verified.
        self.assertFalse((f.run_dir / "verification/candidate").exists())
        self.reuse()
        path = f.run_dir / "verification/candidate/adapter/1/packet.json"
        saved = json.loads(path.read_text())
        # C24 still holds: the reused packet at another attempt's path is not that attempt's packet, and runs nothing.
        other = f.run_dir / "verification/candidate/adapter/2/packet.json"
        other.parent.mkdir(parents=True)
        other.write_text(json.dumps(saved))
        with self.assertRaisesRegex(ValueError, re.escape(f"Existing verification at {other} is the candidate packet of adapter attempt 1, "
                                                          "not the candidate packet of adapter attempt 2")):
            f.verify(self.commit, self.changed, phase="candidate", attempt=2)
        # A reference to another file, or a worker packet changed after the reuse, is refused when rechecked.
        for reference, message in (({**saved["reused_from"], "sha256": "0" * 64}, "Reused worker packet .* changed"),
                                   ({**saved["reused_from"], "path": "../outside/packet.json"}, "Reused worker packet .* outside the run"),
                                   ({**saved["reused_from"], "path": "verification/candidate/adapter/1/packet.json",
                                     "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}, "is not the worker packet of adapter")):
            with self.subTest(reference=reference["path"]), self.assertRaisesRegex(ValueError, message):
                recheck_packet({**saved, "reused_from": reference}, f.policy(), f.run_dir)
        self.worker_path.chmod(0o600)
        self.worker_path.write_text(self.worker_path.read_text() + " ")
        with self.assertRaisesRegex(ValueError, "Reused worker packet .* changed"):
            recheck_packet(json.loads(path.read_text()), f.policy(), f.run_dir)


class PruneTests(unittest.TestCase):
    """C47: a passed attempt keeps its folder, packet, logs, artifacts and browser reports, and loses its worktree, its caches and
    the raw browser output; a failed attempt is kept whole."""

    setUp, policy, snapshot, verify = FileCaptureTests.setUp, FileCaptureTests.policy, FileCaptureTests.snapshot, FileCaptureTests.verify

    # Writes what a real attempt leaves beside its evidence: a cache entry, raw browser output and a browser report.
    LEAVE = ("import os, pathlib, sys\n"
             "pathlib.Path(os.environ['npm_config_cache'], 'entry').write_text('cached')\n"
             "pathlib.Path(os.environ['XDG_CACHE_HOME'], 'entry').write_text('cached')\n"
             "pathlib.Path('../browser-0/trace').mkdir(parents=True)\n"
             "pathlib.Path('../browser-0/trace/shot.png').write_bytes(b'png')\n"
             "pathlib.Path('../browser-report-0.json').write_text('{}')\n")

    def attempt(self, code):
        commit, changed = self.snapshot({"docs/GUIDE.md": b"# Guide\n"})
        argv = [sys.executable, "-c", self.LEAVE + f"print('Ran 1 test in 0.001s\\n\\nOK'); sys.exit({code})"]
        policy = self.policy(argv)
        return self.verify(commit, changed, policy=policy), policy, self.run_dir / "verification/worker/adapter/1"

    def worktrees(self):
        return git(self.repo, "worktree", "list", "--porcelain")

    def test_a_passed_attempt_keeps_its_evidence_and_loses_its_worktree_and_caches(self):
        packet, policy, folder = self.attempt(0)
        self.assertEqual(packet["gate"]["status"], "passed", packet["gate"]["reasons"])
        for name in ("worktree", "npm_config_cache", "xdg_cache_home", "browser-0"):
            self.assertFalse((folder / name).exists(), name)
        self.assertNotIn(str(folder / "worktree"), self.worktrees())
        for name in ("packet.json", "check-0.log", "browser-report-0.json"):
            self.assertTrue((folder / name).is_file(), name)
        self.assertTrue(all(Path(path).is_file() for path in packet["artifact_paths"].values()))
        saved = json.loads((folder / "packet.json").read_text())
        self.assertEqual(recheck_packet(saved, policy, self.run_dir)["gate"]["status"], "passed")
        # Asked again for the same revision, the pruned attempt's packet is rechecked and reused.
        self.assertEqual(self.verify(packet["expected"]["output_commit"], packet["result"]["changed_files"], policy=policy)["gate"]["status"], "passed")

    def test_a_failed_attempt_is_kept_whole(self):
        packet, _, folder = self.attempt(1)
        self.assertEqual(packet["gate"]["status"], "blocked")
        for name in ("worktree", "npm_config_cache/entry", "xdg_cache_home/entry", "browser-0/trace/shot.png", "browser-report-0.json"):
            self.assertTrue((folder / name).exists(), name)
        self.assertIn(str(folder / "worktree"), self.worktrees())

    def test_prune_attempt_is_idempotent(self):
        packet, _, folder = self.attempt(0)
        self.assertEqual(checks.prune_attempt(self.repo, folder), [])
        self.assertTrue((folder / "packet.json").is_file())

    def test_an_unreadable_cache_directory_is_removed_too(self):
        # A check may leave a directory its owner cannot list (0o000, 0o300), or can list but not search (0o400, 0o600),
        # where rmtree's lstat and unlink of each entry fail; every mode is removed.
        self.LEAVE = (self.LEAVE + "for name, mode in (('m000', 0o000), ('m100', 0o100), ('m300', 0o300), ('m400', 0o400), ('m500', 0o500), "
                      "('m555', 0o555), ('m600', 0o600), ('m700', 0o700)):\n"
                      "    path = pathlib.Path(os.environ['npm_config_cache'], name, 'inner')\n"
                      "    path.mkdir(parents=True); (path / 'entry').write_text('x'); path.parent.chmod(mode)\n")
        packet, _, folder = self.attempt(0)
        self.assertEqual(packet["gate"]["status"], "passed", packet["gate"]["reasons"])
        self.assertFalse((folder / "npm_config_cache").exists())

    def test_a_removal_that_fails_is_only_a_warning(self):
        with patch.object(checks, "prune_attempt", side_effect=TypeError("boom")):
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                packet, _, folder = self.attempt(0)
        self.assertEqual(packet["gate"]["status"], "passed")
        self.assertIn(f"Warning: passed attempt {folder} was not pruned (boom)", err.getvalue())

    def test_a_worktree_git_no_longer_lists_is_deleted(self):
        # `git worktree remove --force` that fails partway still unregisters the worktree; a leftover is deleted and pruned.
        for breaking in ("read-only", "unregistered"):
            with self.subTest(breaking=breaking):
                folder = self.run_dir / breaking
                worktree = folder / "worktree"
                git_worktree(self.repo, "add", "--detach", str(worktree), self.base)
                if breaking == "read-only":
                    (worktree / "locked").mkdir()
                    (worktree / "locked/entry").write_text("x")
                    (worktree / "locked").chmod(0o500)
                else:
                    (worktree / ".git").unlink()
                    git_worktree(self.repo, "prune")
                self.assertEqual(checks.prune_attempt(self.repo, folder), [worktree])
                self.assertFalse(worktree.exists())
                self.assertNotIn(str(worktree), self.worktrees())

    def test_a_worktree_git_still_lists_is_never_deleted_as_a_leftover(self):
        # A locked worktree: `git worktree remove --force` refuses it, and Git still lists it, so nothing deletes it.
        folder = self.run_dir / "locked"
        worktree = folder / "worktree"
        git_worktree(self.repo, "add", "--detach", str(worktree), self.base)
        (worktree / "uncommitted.txt").write_text("keep me\n")
        git(self.repo, "worktree", "lock", str(worktree))
        with self.assertRaises(checks.WorktreeError):
            checks.prune_attempt(self.repo, folder)
        self.assertEqual((worktree / "uncommitted.txt").read_text(), "keep me\n")
        self.assertIn(str(worktree), self.worktrees())
        git(self.repo, "worktree", "unlock", str(worktree))

    def test_an_independent_repository_is_never_deleted_as_a_leftover(self):
        folder = self.run_dir / "clone"
        subprocess.run(["git", "clone", "-q", str(self.repo), str(folder / "worktree")], check=True)
        with self.assertRaises(checks.WorktreeError):
            checks.prune_attempt(self.repo, folder)
        self.assertTrue((folder / "worktree/.git").is_dir())

    def test_a_failed_deferred_browser_check_keeps_its_raw_output(self):
        # Browser checks are deferred in the worker phase: a passed attempt may hold one that failed, whose raw output is
        # the only copy of its failure screenshots and traces.
        folder = self.run_dir / "verification/worker/adapter/1"
        for index in (0, 1, 2):
            (folder / f"browser-{index}/trace").mkdir(parents=True)
        save_json(folder / "packet.json", {"gate": {"status": "passed"}, "capture_errors": ["e2e: exit 1"], "scenario_errors": ["smoke/home: no screenshot"],
                                           "evidence": {"checks": [{"id": "e2e", "worker_check_index": 0}, {"id": "smoke", "worker_check_index": 1},
                                                                   {"id": "fine", "worker_check_index": 2}]}})
        self.assertEqual(checks.prunable(folder), [folder / "browser-2"])
        checks.prune_attempt(self.repo, folder)
        self.assertEqual(sorted(path.name for path in folder.iterdir()), ["browser-0", "browser-1", "packet.json"])


class MemoryKilledCheckTests(unittest.TestCase):
    """A check killed under memory pressure is recorded as transient: the gate still blocks, the packet names the check."""

    setUp, policy, snapshot, verify = FileCaptureTests.setUp, FileCaptureTests.policy, FileCaptureTests.snapshot, FileCaptureTests.verify
    attempts = 0

    def run_check(self, script: str) -> dict:
        if not self.attempts:
            self.commit, self.changed = self.snapshot({"docs/NEW.md": b"# New\n"})
        self.attempts += 1
        return self.verify(self.commit, self.changed, policy=self.policy([sys.executable, "-c", script]), attempt=self.attempts)

    def test_a_log_that_says_killed_is_transient(self):
        packet = self.run_check("import sys; print('Ran 3 tests'); print('Killed'); sys.exit(1)")
        self.assertEqual(packet["gate"]["status"], "blocked")
        self.assertEqual(packet["result"]["checks"][0]["transient"], "memory")
        self.assertEqual(packet["result"]["transient_checks"], ["unit"])
        validate_schema("workerResult", packet["result"])

    def test_a_signal_exit_and_a_heap_limit_are_transient(self):
        for script in ("import os, signal; os.kill(os.getpid(), signal.SIGKILL)", "import sys; sys.exit(137)",
                       "import sys; print('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'); sys.exit(134)"):
            with self.subTest(script=script):
                packet = self.run_check(script)
                self.assertEqual((packet["gate"]["status"], packet["result"].get("transient_checks")), ("blocked", ["unit"]))

    def test_another_signal_and_a_marker_inside_a_longer_line_are_not_transient(self):
        for script in ("import os, signal; os.kill(os.getpid(), signal.SIGSEGV)",
                       "import sys; print('FAILED tests/test_x.py::test_killed'); print('expected SIGKILL handling'); sys.exit(1)",
                       "import sys; print('Killed'); print('\\n'.join(['noise'] * 25)); sys.exit(1)"):  # Killed above the last 20 lines.
            with self.subTest(script=script):
                packet = self.run_check(script)
                self.assertEqual(packet["gate"]["status"], "blocked")
                self.assertNotIn("transient_checks", packet["result"])
        for line in ("Out of memory: Killed process 4242 (node)", "Error: ENOMEM: not enough memory"):
            log = self.root / "kernel.log"
            log.write_text(f"running\n{line}\n")
            self.assertTrue(checks.memory_killed(1, log), line)

    def test_a_real_failure_and_a_pass_are_not_transient(self):
        packet = self.run_check("import sys; print('AssertionError: 1 != 2'); sys.exit(1)")
        self.assertEqual(packet["gate"]["status"], "blocked")
        self.assertNotIn("transient", packet["result"]["checks"][0])
        self.assertNotIn("transient_checks", packet["result"])
        self.assertFalse(checks.memory_killed(0, self.root / "missing.log"))
        self.assertFalse(checks.memory_killed(124, self.root / "missing.log"))  # A timeout is execute's own kill, never memory.


class VitestCountsTests(unittest.TestCase):
    SUMMARY = ("\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[32m6 passed\x1b[39m\x1b[22m\x1b[90m (6)\x1b[39m\n"
               "\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[32m70 passed\x1b[39m\x1b[22m\x1b[90m (70)\x1b[39m\n\x1b[2m   Start at \x1b[22m 09:20:57\n")

    def test_a_passing_vitest_run_is_test_evidence(self):
        self.assertEqual(text_test_counts(" \u2713 |unit| tests/unit/purity.test.ts (10 tests) 20ms\n" + self.SUMMARY), {"passed": 70, "failed": 0, "skipped": 0})
        self.assertEqual(text_test_counts("      Tests  67 passed | 2 skipped | 1 todo (70)\n"), {"passed": 67, "failed": 0, "skipped": 3})

    def test_failed_tests_files_and_unhandled_errors_are_failures(self):
        self.assertEqual(text_test_counts(" Test Files  1 failed | 5 passed (6)\n      Tests  2 failed | 68 passed (70)\n"), {"passed": 68, "failed": 3, "skipped": 0})
        # A file that failed to load counts no failed test, yet the suite did not pass.
        self.assertEqual(text_test_counts(" Test Files  1 failed | 5 passed (6)\n      Tests  60 passed (60)\n"), {"passed": 60, "failed": 1, "skipped": 0})
        self.assertEqual(text_test_counts("      Tests  70 passed (70)\n     Errors  2 errors\n"), {"passed": 70, "failed": 2, "skipped": 0})

    def test_expected_failures_pass_and_every_run_in_the_log_counts(self):
        self.assertEqual(text_test_counts("      Tests  68 passed | 2 expected fail (70)\n"), {"passed": 70, "failed": 0, "skipped": 0})
        # Two vitest runs in one check: the first run's failure is not overwritten by the second's pass.
        self.assertEqual(text_test_counts("      Tests  1 failed | 2 passed (3)\n...\n      Tests  3 passed (3)\n"), {"passed": 5, "failed": 1, "skipped": 0})
        # `node --test; vitest run`: the failing Node summary still fails the check.
        self.assertEqual(text_test_counts("# tests 4\n# pass 3\n# fail 1\n# skipped 0\n      Tests  3 passed (3)\n"), {"passed": 3, "failed": 1, "skipped": 0})
        # A reporter restating vitest's counts in TAP form is not counted twice.
        self.assertEqual(text_test_counts(self.SUMMARY + "\n# tests 70\n# pass 70\n# fail 0\n# skipped 0\n# cancelled 0\n"), {"passed": 70, "failed": 0, "skipped": 0})

    def test_an_inconsistent_or_partial_summary_is_no_evidence(self):
        self.assertIsNone(text_test_counts("      Tests  70 passed (71)\n"))
        self.assertIsNone(text_test_counts(" Test Files  6 passed (6)\n"))
        self.assertIsNone(text_test_counts("      Tests  70 passed | 1 exploded (71)\n"))
        self.assertIsNone(text_test_counts(" Test Files  1 failed (1)\n"))
        self.assertIsNone(text_test_counts("      Tests  3 passed (3)\n# tests 4\n# pass 3\n"))


if __name__ == "__main__":
    unittest.main()
