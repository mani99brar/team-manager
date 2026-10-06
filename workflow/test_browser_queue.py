"""The machine-wide browser queue: off unless switched on; slots taken and freed by flock; `off` and more slots free waiting
checks; unreadable settings never fail a check; `run` holds a slot for its command only; the verifier's browser check runs
in a slot and its other checks do not; a browser lane's pinned task routes the worker's own Playwright run through it."""
import contextlib
import io
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from . import browser_queue
from .browser_queue import acquire, browser_queue_main, browser_slot, holders, read_settings, write_settings
from .checks import verify_revision
from .guardrails import BROWSER_QUEUE, pinned_task
from .sessions import git

TOOL = Path(__file__).resolve().parents[1]


class QueueCase(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.queue = self.root / "queue"
        environment = patch.dict(os.environ, {browser_queue.QUEUE_ENV: str(self.queue)})
        environment.start()
        self.addCleanup(environment.stop)

    def cli(self, *argv) -> tuple[int, str, str]:
        out, err, code = io.StringIO(), io.StringIO(), 0
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                browser_queue_main(list(argv))
            except SystemExit as exit:
                code = exit.code
        return code, out.getvalue(), err.getvalue()


class Settings(QueueCase):
    def test_no_settings_file_is_off_and_a_check_runs_at_once_without_a_slot(self):
        self.assertEqual(read_settings(self.queue), {"enabled": False, "slots": 2})
        with browser_slot("lane", out=io.StringIO()) as slot:
            self.assertIsNone(slot)
        self.assertFalse(self.queue.exists())

    def test_on_and_off_switch_and_keep_the_slots(self):
        self.assertEqual(self.cli("on")[0], 0)
        self.assertEqual(read_settings(self.queue), {"enabled": True, "slots": 2})
        code, out, _ = self.cli("on", "--slots", "3")
        self.assertEqual((code, read_settings(self.queue)), (0, {"enabled": True, "slots": 3}))
        self.assertIn("Browser queue: on, 3 slots", out)
        self.cli("off")
        self.assertEqual(read_settings(self.queue), {"enabled": False, "slots": 3})
        self.assertEqual(self.cli("on", "--slots", "0")[0], 2)

    def test_malformed_settings_never_fail_a_check_and_switching_rewrites_them(self):
        self.queue.mkdir()
        (self.queue / "settings.json").write_text('{"enabled": "yes"}')
        warnings = io.StringIO()
        with browser_slot("ui", out=warnings) as slot:
            self.assertIsNone(slot)
        self.assertIn("ui runs unqueued", warnings.getvalue())
        self.assertEqual(self.cli("status")[0], 2)
        self.cli("on")
        self.assertEqual(read_settings(self.queue), {"enabled": True, "slots": 2})


class Slots(QueueCase):
    def setUp(self):
        super().setUp()
        write_settings(self.queue, True, 1)

    def waiter(self, label="second"):
        """A thread acquiring a slot (its own open file, so flock contends as across processes), and its result."""
        result, out = {}, io.StringIO()

        def take():
            result["handle"] = acquire(label, poll=0.05, out=out)
        thread = threading.Thread(target=take)
        thread.start()
        return thread, result, out

    def test_a_held_slot_makes_the_next_check_wait_until_it_is_released(self):
        first = acquire("first", out=io.StringIO())
        self.assertIsNotNone(first)
        self.assertEqual(holders(self.queue, 1)[0]["label"], "first")
        thread, result, out = self.waiter()
        time.sleep(0.3)
        self.assertTrue(thread.is_alive())
        self.assertIn("second waits for one of 1 slots (held by first)", out.getvalue())
        first.close()
        thread.join(5)
        self.assertIsNotNone(result["handle"])
        self.assertIn("second took slot 1", out.getvalue())
        result["handle"].close()
        self.assertEqual(holders(self.queue, 1), [None])

    def test_switching_off_or_adding_a_slot_frees_a_waiting_check(self):
        first = acquire("first", out=io.StringIO())
        self.addCleanup(first.close)
        thread, result, out = self.waiter()
        time.sleep(0.2)
        write_settings(self.queue, True, 2)
        thread.join(5)
        self.assertIsNotNone(result["handle"])
        result["handle"].close()
        second = acquire("second", out=io.StringIO())
        self.addCleanup(second.close)
        thread, result, out = self.waiter("third")
        time.sleep(0.2)
        write_settings(self.queue, False, 2)
        thread.join(5)
        self.assertIsNone(result["handle"])
        self.assertIn("switched off; third runs now", out.getvalue())

    def test_a_killed_holder_frees_its_slot(self):
        script = ("import fcntl, os, sys, time; f = open(sys.argv[1], 'a'); fcntl.flock(f, fcntl.LOCK_EX); "
                  "print('held', flush=True); time.sleep(60)")
        self.queue.mkdir(exist_ok=True)
        holder = subprocess.Popen([sys.executable, "-c", script, str(self.queue / "slot-1.lock")], stdout=subprocess.PIPE, text=True)
        self.addCleanup(holder.stdout.close)
        self.addCleanup(holder.kill)
        self.assertEqual(holder.stdout.readline().strip(), "held")
        self.assertEqual(holders(self.queue, 1), [{}])
        holder.kill()
        holder.wait()
        slot = acquire("next", poll=0.05, out=io.StringIO())
        self.assertIsNotNone(slot)
        slot.close()

    def test_run_holds_a_slot_for_its_command_and_exits_with_its_code(self):
        probe = ("import fcntl, sys; f = open(sys.argv[1], 'a')\n"
                 "try:\n    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB); print('free')\nexcept BlockingIOError:\n    print('held')\n"
                 "sys.exit(7)")
        result = subprocess.run([sys.executable, "-m", "workflow", "browser-queue", "run", "--label", "ui", "--",
                                 sys.executable, "-c", probe, str(self.queue / "slot-1.lock")],
                                cwd=TOOL, capture_output=True, text=True, timeout=30)
        self.assertEqual((result.returncode, result.stdout.strip()), (7, "held"), result.stderr)
        self.assertEqual(holders(self.queue, 1), [None])
        self.assertEqual(self.cli("run")[0], 2)


class VerifierAndWorker(QueueCase):
    def test_the_verifier_runs_a_browser_check_in_a_slot_and_other_checks_without_one(self):
        write_settings(self.queue, True, 1)
        repo = self.root / "repo"
        repo.mkdir()
        (repo / "README.md").write_text("# Repo\n")
        for args in (["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"], ["add", "."], ["commit", "-qm", "Base"]):
            subprocess.run(["git", "-C", str(repo), *args], check=True)
        commit = git(repo, "rev-parse", "HEAD")
        probe = ("import fcntl, sys; f = open(sys.argv[1], 'a')\n"
                 "try:\n    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB); print('slot free')\nexcept BlockingIOError:\n    print('slot held')\n")
        argv = [sys.executable, "-c", probe, str(self.queue / "slot-1.lock")]
        policy = {"version": "1.0.0", "feature": "Queue test", "independent_review": True, "integration_approval": True,
                  "workers": [{"node_id": "ui", "role": "frontend", "owned_paths": ["src"],
                               "checks": [{"id": "build", "kind": "build", "argv": argv, "timeout_seconds": 30, "scenarios": []},
                                          {"id": "e2e", "kind": "browser", "argv": argv, "timeout_seconds": 30, "scenarios": []}]}]}
        run = self.root / "run"
        run.mkdir()
        waits = io.StringIO()
        with contextlib.redirect_stderr(waits):
            verify_revision(run, {"repository": str(repo), "run_id": "run-1", "base_commit": commit}, policy, "ui", commit, [], "session", prune=False)
        folder = run / "verification/worker/ui/1"
        self.assertIn("slot free", (folder / "check-0.log").read_text())
        self.assertIn("slot held", (folder / "check-1.log").read_text())
        self.assertEqual(holders(self.queue, 1), [None])

    def test_a_browser_lane_runs_its_own_playwright_through_the_queue(self):
        browser = {"node_id": "ui", "role": "frontend", "owned_paths": ["src"],
                   "checks": [{"id": "e2e", "kind": "browser", "argv": ["npx", "playwright", "test"], "timeout_seconds": 10, "scenarios": []}]}
        task = pinned_task("## Goal\n\nChange ui.\n", browser)
        self.assertIn("report.json " + BROWSER_QUEUE.format(lane="ui") + " npx --no-install playwright test", task)
        self.assertIn("-m workflow browser-queue run --label ui --", task)
        self.assertNotIn("browser-queue", pinned_task("## Goal\n\nChange ui.\n", {**browser, "checks": []}))


if __name__ == "__main__":
    unittest.main()
