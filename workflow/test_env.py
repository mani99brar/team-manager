"""The test suite's own browser queue: no test's browser check ever waits for a slot of the operator's machine-wide queue.

`isolate_browser_queue(directory)` sets MD_MANAGER_BROWSER_QUEUE to `<directory>/browser-queue`, so browser_queue.queue_dir()
(and every browser_slot a verifier, a critique child or a fixture subprocess takes) lies in a directory the caller owns,
never `~/.config/md-manager/browser-queue`, where another run may hold the slots. The caller owns `directory` and restores
the environment: the call goes inside a patch.dict of os.environ (test_pipeline.isolate_registry per test module, the
setUpModule of test_browser_rules and test_critique), and a test that sets the variable itself still wins. Run-checks-once
[L10]-[L12]: run 002's fixture browser checks waited on the live queue while another run held it.
"""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from .browser_queue import QUEUE_ENV, queue_dir

TOOL = Path(__file__).resolve().parents[1]


def isolate_browser_queue(directory) -> Path:
    """Point MD_MANAGER_BROWSER_QUEUE at `<directory>/browser-queue` in os.environ and return that directory. No settings file
    there means the queue is off, so a check runs at once; a test that switches it on writes the settings itself."""
    queue = Path(directory) / "browser-queue"
    os.environ[QUEUE_ENV] = str(queue)
    return queue


LIVE_QUEUE = Path(".config/md-manager/browser-queue")


class BrowserQueueIsolation(unittest.TestCase):
    """isolate_registry() takes the queue out of HOME, even when TMPDIR lies under HOME, and its children inherit it. The
    module cleanups isolate_registry registers are collected and run here, so this test leaves no module state behind."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name) / "home"
        self.tmpdir = self.home / "tmp"
        self.tmpdir.mkdir(parents=True)

    def isolated(self):
        """isolate_registry() under a HOME of this test's own, with TMPDIR and tempfile.tempdir under it: the queue it sets and
        the isolate's temporary directory (the parent of its registry's folder). Undone by this test's cleanups, in order."""
        from .test_pipeline import isolate_registry
        cleanups = []
        environment = patch.dict(os.environ, {"HOME": str(self.home), "TMPDIR": str(self.tmpdir)})
        environment.start()
        self.addCleanup(environment.stop)
        tempdir = patch.object(tempfile, "tempdir", str(self.tmpdir))
        tempdir.start()
        self.addCleanup(tempdir.stop)
        with patch("unittest.addModuleCleanup", side_effect=cleanups.append):
            isolate_registry()
        self.addCleanup(lambda: [cleanup() for cleanup in reversed(cleanups)])
        self.assertEqual(Path.home(), self.home)
        return queue_dir(), Path(os.environ["MD_MANAGER_PROJECTS_CONFIG"]).parents[1]

    def assert_not_live(self, queue: Path):
        live = Path.home() / LIVE_QUEUE
        self.assertNotEqual(queue, live)
        self.assertFalse(queue.is_relative_to(live), queue)
        self.assertNotEqual(queue, self.home.resolve() / LIVE_QUEUE)

    def test_isolate_registry_puts_the_queue_in_its_own_temporary_directory_with_tmpdir_under_home(self):
        before = os.environ.get(QUEUE_ENV)
        queue, isolate = self.isolated()
        self.assertEqual(os.environ[QUEUE_ENV], str(isolate / "browser-queue"))
        self.assertEqual(queue, (isolate / "browser-queue").resolve())
        self.assertTrue(queue.is_relative_to(self.tmpdir.resolve()), (queue, self.tmpdir))  # tempfile honoured TMPDIR under HOME
        self.assert_not_live(queue)
        self.doCleanups()
        self.assertEqual(os.environ.get(QUEUE_ENV), before)  # The isolate's cleanups restore the variable.

    def test_fixture_subprocesses_inherit_the_isolated_queue(self):
        from .checks import check_environment
        queue, _ = self.isolated()
        probe = [sys.executable, "-c", f"import sys; sys.path.insert(0, {str(TOOL)!r}); from workflow.browser_queue import queue_dir; print(queue_dir())"]
        inherited = subprocess.run(probe, capture_output=True, text=True, check=True).stdout.strip()
        self.assertEqual(Path(inherited), queue)
        # A check's environment (the verifier's scrubbed copy) keeps it too.
        checked = subprocess.run(probe, capture_output=True, text=True, check=True, env=check_environment(os.environ)[0]).stdout.strip()
        self.assertEqual(Path(checked), queue)
        self.assert_not_live(Path(inherited))
