"""attention.py: one record per state that needs the operator, in the run directory and in the feed beside the registry."""
import contextlib
import fcntl
import io
import json
import tempfile
import threading
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from .attention import KINDS, RESERVED_KINDS, attention, feed_path
from .sessions import read_json, save_json

NOON = datetime(2026, 10, 3, 12, 0, tzinfo=timezone.utc).timestamp()


class AttentionRecord(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.run = self.root / "runs" / "demo-001"
        self.run.mkdir(parents=True)
        save_json(self.run / "plan.json", {"run_id": "demo-001"})
        # Never the operator's registry folder: the feed lands beside this temporary registry.
        self.env = {"MD_MANAGER_PROJECTS_CONFIG": str(self.root / "config" / "projects.json")}
        self.feed = self.root / "config" / "attention.jsonl"

    def lines(self) -> list:
        return [json.loads(line) for line in self.feed.read_text().splitlines()] if self.feed.exists() else []

    def record(self, kind="question", text="Worker ui asked question 1 of 3: A or B?", node="ui", at=NOON):
        with contextlib.redirect_stderr(io.StringIO()) as errors:
            written = attention(self.run, kind, text, node=node, clock=lambda: at, env=self.env)
        self.errors = errors.getvalue()
        return written

    def test_a_record_goes_to_the_run_and_one_line_to_the_feed_beside_the_registry(self):
        written = self.record()
        expected = {"version": "1.0.0", "run_id": "demo-001", "kind": "question", "node": "ui",
                    "text": "Worker ui asked question 1 of 3: A or B?", "at": "2026-10-03T12:00:00Z"}
        self.assertEqual(written, expected)
        # The file also keeps the latest record of each state the run reported (kind and node), which is what a repeat is
        # compared with.
        question = {"kind": "question", "node": "ui", "text": "Worker ui asked question 1 of 3: A or B?", "at": "2026-10-03T12:00:00Z"}
        self.assertEqual(read_json(self.run / "attention.json"), {**expected, "states": [question]})
        self.assertEqual(self.lines(), [{"at": "2026-10-03T12:00:00Z", "run_id": "demo-001", "run_dir": str(self.run.resolve()),
                                         "kind": "question", "node": "ui", "text": "Worker ui asked question 1 of 3: A or B?"}])
        self.assertEqual(self.feed.parent, Path(self.env["MD_MANAGER_PROJECTS_CONFIG"]).parent)
        # A run-level record names no node; each new state appends one more line and replaces the run's record.
        finished = self.record("finished", "feature/demo fast-forwarded to abc; nothing was pushed", node=None, at=NOON + 90.5)
        self.assertEqual((finished["node"], finished["at"]), (None, "2026-10-03T12:01:30.500000Z"))
        self.assertEqual(read_json(self.run / "attention.json"),
                         {**finished, "states": [question, {key: finished[key] for key in ("kind", "node", "text", "at")}]})
        self.assertEqual([(line["kind"], line["node"]) for line in self.lines()], [("question", "ui"), ("finished", None)])

    def test_the_runs_latest_record_again_writes_nothing(self):
        first = self.record()
        before = (self.run / "attention.json").read_bytes()
        # A restarted controller, or the next poll, reports the same state later: no second line, the record keeps its time.
        self.assertIsNone(self.record(at=NOON + 600))
        self.assertEqual((self.run / "attention.json").read_bytes(), before)
        self.assertEqual(len(self.lines()), 1)
        # Another text, another node or another kind is a new state.
        self.assertIsNotNone(self.record(text="Worker ui asked question 2 of 3: C or D?"))
        self.assertIsNotNone(self.record(text="Worker ui asked question 2 of 3: C or D?", node="adapter"))
        self.assertIsNotNone(self.record(kind="pane", text="Worker ui asked question 2 of 3: C or D?", node="adapter"))
        self.assertEqual(len(self.lines()), 4)
        # Each state (kind and node) keeps its latest text: one whose text changed, then changed back, is recorded again.
        self.assertEqual(self.record(at=NOON + 900), {**first, "at": "2026-10-03T12:15:00Z"})
        self.assertEqual(len(self.lines()), 5)

    def test_states_open_at_once_are_not_repeated_by_a_restart(self):
        # Two lanes need the operator at once, one in its pane and one with a question. A controller that restarts (Ctrl-C
        # and `automatic --live`, an update's exit) reports both again from a fresh process: neither is repeated, though
        # only one of them can be the run's latest record.
        pane = ("pane", "Worker ui needs attention in its pane (native state blocked)", "ui")
        question = ("question", "Worker adapter asked question 1 of 3: A or B?", "adapter")
        self.assertIsNotNone(self.record(*pane))
        self.assertIsNotNone(self.record(*question, at=NOON + 30))
        for restart in (NOON + 600, NOON + 1200):
            self.assertIsNone(self.record(*pane, at=restart))
            self.assertIsNone(self.record(*question, at=restart))
        self.assertEqual([(line["kind"], line["node"]) for line in self.lines()], [("pane", "ui"), ("question", "adapter")])
        record = read_json(self.run / "attention.json")
        self.assertEqual((record["kind"], record["node"], record["at"]), ("question", "adapter", "2026-10-03T12:00:30Z"))
        self.assertEqual([(state["kind"], state["node"], state["at"]) for state in record["states"]],
                         [("pane", "ui", "2026-10-03T12:00:00Z"), ("question", "adapter", "2026-10-03T12:00:30Z")])

    def test_a_resolved_state_is_recorded_again_when_it_comes_back(self):
        # The pane's text never changes, so only resolved() tells a pane that blocks again from one still blocked.
        from .attention import resolved
        pane = ("pane", "Worker ui needs attention in its pane (native state blocked)", "ui")
        self.record(*pane)
        self.record("question", "Worker adapter asked question 1 of 3: A or B?", "adapter")
        self.assertIsNone(self.record(*pane, at=NOON + 60))
        with contextlib.redirect_stderr(io.StringIO()) as errors:
            self.assertTrue(resolved(self.run, "pane", node="ui", env=self.env))
            self.assertFalse(resolved(self.run, "pane", node="ui", env=self.env))  # Nothing left to forget: nothing written.
            self.assertFalse(resolved(self.run, "pane", node="adapter", env=self.env))
        self.assertEqual(errors.getvalue(), "")
        self.assertEqual(len(self.lines()), 2)  # Resolving writes no line.
        self.assertEqual([state["node"] for state in read_json(self.run / "attention.json")["states"]], ["adapter"])
        self.assertEqual(self.record(*pane, at=NOON + 900)["at"], "2026-10-03T12:15:00Z")
        self.assertEqual([line["kind"] for line in self.lines()], ["pane", "question", "pane"])
        # The adapter's question was not resolved: still not repeated.
        self.assertIsNone(self.record("question", "Worker adapter asked question 1 of 3: A or B?", "adapter", at=NOON + 960))
        # A record written before the per-state list existed counts as its one state.
        save_json(self.run / "attention.json", {"version": "1.0.0", "run_id": "demo-001", "kind": "pane", "node": "ui", "text": pane[1],
                                                "at": "2026-10-03T12:15:00Z"})
        self.assertIsNone(self.record(*pane, at=NOON + 1000))
        self.assertIsNotNone(self.record("question", "Worker adapter asked question 1 of 3: A or B?", "adapter", at=NOON + 1000))

    def test_kinds_are_fixed_and_the_reserved_ones_write_nothing_yet(self):
        self.assertEqual(KINDS, frozenset({"question", "pane", "challenge_paused", "review_blocked", "controller_blocked", "finished", "sidecar"}))
        self.assertEqual(RESERVED_KINDS, frozenset({"usage_limit"}))
        self.assertFalse(KINDS & RESERVED_KINDS)
        for kind in ("usage_limit", "blocked", ""):
            with self.subTest(kind):
                self.assertIsNone(self.record(kind=kind))
                self.assertIn("attention kind", self.errors)
        self.assertIsNone(self.record(text="  "))
        self.assertFalse((self.run / "attention.json").exists())
        self.assertEqual(self.lines(), [])
        # The review sidecar's P0/P1 that reached no lane, and its escalations (C41), are a kind of their own, per lane.
        written = self.record("sidecar", "Review sidecar pass 2: P1 S-2 on lane ui did not reach the lane (refused, lane_finished)", node="ui")
        self.assertEqual((written["kind"], written["node"], self.errors), ("sidecar", "ui", ""))
        self.assertEqual([(line["kind"], line["node"]) for line in self.lines()], [("sidecar", "ui")])

    def test_attention_never_raises(self):
        # The registry folder cannot be created (a file is in its way): nothing is written, and the caller goes on.
        blocked = self.root / "blocked"
        blocked.write_text("not a folder")
        self.env = {"MD_MANAGER_PROJECTS_CONFIG": str(blocked / "projects.json")}
        self.assertIsNone(self.record())
        self.assertIn("Attention record not written (question)", self.errors)
        self.assertFalse((self.run / "attention.json").exists())
        # A run directory that is gone writes no line for it.
        self.env = {"MD_MANAGER_PROJECTS_CONFIG": str(self.root / "config" / "projects.json")}
        self.run = self.root / "runs" / "gone-001"
        self.assertIsNone(self.record())
        self.assertEqual(self.lines(), [])
        # A clock that cannot be read, or an attention.json that is not a record (replaced by the next record).
        self.run = self.root / "runs" / "demo-001"
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertIsNone(attention(self.run, "question", "A or B?", node="ui", clock=lambda: "noon", env=self.env))
        (self.run / "attention.json").write_text("{not json")
        self.assertEqual(self.record()["kind"], "question")
        self.assertEqual(read_json(self.run / "attention.json")["kind"], "question")
        # Without plan.json the run id is the directory's name, as prepare names it.
        (self.run / "plan.json").unlink()
        self.assertEqual(self.record(kind="pane")["run_id"], "demo-001")

    def test_the_line_is_appended_under_the_feeds_lock(self):
        self.feed.parent.mkdir(parents=True)
        done = threading.Event()
        with self.feed.open("a") as holder:
            fcntl.flock(holder, fcntl.LOCK_EX)  # A Monitor, another run or another controller holds the feed.
            writer = threading.Thread(target=lambda: (self.record(), done.set()))
            writer.start()
            self.assertFalse(done.wait(0.3))
            self.assertEqual((self.lines(), (self.run / "attention.json").exists()), ([], False))
        writer.join(10)
        self.assertTrue(done.is_set())
        self.assertEqual(len(self.lines()), 1)
        # Writers of one state at the same moment: the run's latest record is checked under the lock, so one line.
        records = []
        threads = [threading.Thread(target=lambda: records.append(attention(self.run, "pane", "Worker ui needs attention in its pane",
                                                                           node="ui", env=self.env))) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(10)
        self.assertEqual(sum(record is not None for record in records), 1)
        self.assertEqual([line["kind"] for line in self.lines()], ["question", "pane"])

    def test_a_feed_locked_past_the_bound_writes_nothing_and_the_call_returns(self):
        # A holder that never lets go (a controller suspended with Ctrl-Z inside attention(), a reader that flocks the feed,
        # a hung filesystem) must not stop the controller that asks: it waits LOCK_WAIT_SECONDS, says so once and goes on.
        self.feed.parent.mkdir(parents=True)
        done, results = threading.Event(), []
        with self.feed.open("a") as holder, patch("workflow.attention.LOCK_WAIT_SECONDS", 0.3, create=True):
            fcntl.flock(holder, fcntl.LOCK_EX)
            started = time.monotonic()
            writer = threading.Thread(target=lambda: (results.append(self.record()), done.set()))
            writer.start()
            returned = done.wait(5)
            waited = time.monotonic() - started
        writer.join(10)
        self.assertTrue(returned, "attention() waited for the feed's lock without a bound")
        self.assertGreaterEqual(waited, 0.3)
        self.assertEqual(results, [None])
        self.assertEqual(self.errors, f"Attention record not written (question): {self.feed} stayed locked for 0.3 s\n")
        self.assertEqual((self.lines(), (self.run / "attention.json").exists()), ([], False))
        # Released, the same state is written: nothing was recorded as seen.
        self.assertEqual(self.record()["kind"], "question")
        self.assertEqual(len(self.lines()), 1)

    def test_the_package_import_the_controller_uses_records_too(self):
        # automatic.py imports the helper as `from . import attention as attention_record`, since its waits keep sets
        # named `attention` that a function of that name would shadow. That import binds this module: calling it records.
        from . import attention as attention_record
        with contextlib.redirect_stderr(io.StringIO()):
            written = attention_record(self.run, "pane", "Worker ui needs attention in its pane", node="ui", clock=lambda: NOON, env=self.env)
            self.assertIsNone(attention_record.attention(self.run, "pane", "Worker ui needs attention in its pane", node="ui", env=self.env))
        self.assertEqual((written["kind"], written["node"], written["at"]), ("pane", "ui", "2026-10-03T12:00:00Z"))
        self.assertIs(attention_record.attention, attention)
        self.assertEqual(len(self.lines()), 1)

    def test_the_feed_is_next_to_the_registry_the_launch_writes(self):
        self.assertEqual(feed_path(self.env), self.root / "config" / "attention.jsonl")
        self.assertEqual(feed_path({}), Path.home() / ".config/md-manager/attention.jsonl")
        self.assertEqual(feed_path({"MD_MANAGER_PROJECTS_CONFIG": "  "}), Path.home() / ".config/md-manager/attention.jsonl")


if __name__ == "__main__":
    unittest.main()
