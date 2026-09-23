"""Worker-phase file capture (PRD_VIEWER_CLARITY 4.1): real Git snapshots, real verification worktrees and checks."""
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from jsonschema.exceptions import ValidationError

from . import checks
from .checks import FILE_CAPTURE_LIMIT, PACKET_FILE_CAPTURE_LIMIT, recheck_packet, verify_revision
from .sessions import git
from .verification import validate_schema

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


if __name__ == "__main__":
    unittest.main()
