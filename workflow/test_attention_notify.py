"""attention_notify.py: the tailer folds the feed's new records per run, sends them through the configured command, logs
each pushed line and moves its offset only after every message went; the cap, the digest and the presence flag hold what
must wait; a failure exits 2 with the offset unchanged and the records that went remembered by key, so a retry repeats
nothing and loses nothing when the feed changed under it; nothing here sends a real notification or touches the
operator's ~/.config/md-manager/."""
import contextlib
import fcntl
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from . import attention_notify
from .attention import KINDS
from .attention_notify import (BODY_LIMIT, CAP, COMMAND_LIMIT, COPY_TEXT_LIMIT, HELD, IMMEDIATE, TEXT_LIMIT, attention_notify_main, command_token,
                               config_dir, cut_words, describe, fold, parse_duration, presence_main, presence_status, render_digest, render_run)
from .sessions import read_json, save_json

TOOL = Path(__file__).resolve().parents[1]
NOON = datetime(2026, 10, 7, 12, 0, tzinfo=timezone.utc).timestamp()
# Records its arguments as one JSON line per call; exits 1 while a `fail` file sits beside the log or the body says
# POISON; sleeps while a `slow` file does (never past the test's patched timeout by much).
# The topic command: records the name, prints a fresh thread id (100, 101, ...); exits 1 while a `topicfail` file sits
# beside its log.
RENAME_STUB = """\
import os, sys
log = sys.argv[1]
if os.path.exists(log + ".renamefail"):
    print("stub refused the rename", file=sys.stderr)
    sys.exit(1)
with open(log, "a") as handle:  # The thread and the new name.
    handle.write(sys.argv[2] + "|" + sys.argv[3] + "\\n")
"""
TOPIC_STUB = """\
import os, sys
log = sys.argv[1]
if os.path.exists(log + ".topicfail"):
    print("stub refused the topic", file=sys.stderr)
    sys.exit(1)
count = len(open(log).read().splitlines()) if os.path.exists(log) else 0
with open(log, "a") as handle:  # The name, and the chat the command would create it in: notify.json's `env` reaches it too.
    handle.write(sys.argv[2] + "|" + os.environ.get("TELEGRAM_CHAT_ID", "") + "\\n")
print(100 + count)
"""
STUB = """\
import json, os, sys, time
log = sys.argv[1]
if os.path.exists(log + ".slow"):
    time.sleep(2)
with open(log, "a") as handle:
    handle.write(json.dumps(sys.argv[2:]) + "\\n")
with open(log + ".chat", "a") as handle:  # The chat and the topic the command would send to: notify.json's `env` reaches it.
    handle.write(os.environ.get("TELEGRAM_CHAT_ID", "") + "|" + os.environ.get("TELEGRAM_THREAD_ID", "") + "\\n")
with open(log + ".style", "a") as handle:  # The parse mode and the keyboard a formatted message carries.
    handle.write(os.environ.get("NOTIFY_PARSE_MODE", "") + "|" + os.environ.get("NOTIFY_REPLY_MARKUP", "") + "\\n")
if os.path.exists(log + ".fail") or "POISON" in sys.argv[-1]:
    print("stub refused the message", file=sys.stderr)
    sys.exit(1)
"""


class NotifyCase(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.config = self.root / "config"
        self.config.mkdir()
        # Only the registry's location: every file of the feature follows it, so nothing under the real home is read.
        self.env = {"MD_MANAGER_PROJECTS_CONFIG": str(self.config / "projects.json")}
        self.feed = self.config / "attention.jsonl"
        self.stub = self.root / "notify-stub.py"
        self.stub.write_text(STUB)
        self.log = self.root / "sent.jsonl"
        save_json(self.config / "notify.json", {"argv": [sys.executable, str(self.stub), str(self.log)]})
        self.now = NOON

    def append(self, run_id="demo-001", kind="question", text="Worker ui asked question 1 of 3: A or B?", node="ui", at=None, raw=None, run_dir=None):
        at = self.now if at is None else at
        line = raw if raw is not None else json.dumps({"at": attention_notify.iso(at), "run_id": run_id, "run_dir": run_dir or f"/runs/{run_id}",
                                                       "kind": kind, "node": node, "text": text}) + "\n"
        with self.feed.open("a") as handle:
            handle.write(line)

    def run_once(self, *argv) -> tuple[int, str, str]:
        out, err, code = io.StringIO(), io.StringIO(), 0
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                attention_notify_main(list(argv), env=self.env, clock=lambda: self.now)
            except SystemExit as exit:
                code = exit.code or 0
        return code, out.getvalue(), err.getvalue()

    def presence(self, *argv) -> tuple[int, str, str]:
        out, err, code = io.StringIO(), io.StringIO(), 0
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                presence_main(list(argv), env=self.env, clock=lambda: self.now)
            except SystemExit as exit:
                code = exit.code or 0
        return code, out.getvalue(), err.getvalue()

    def sent(self) -> list[list[str]]:
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def bodies(self) -> list[str]:
        return [call[-1] for call in self.sent()]

    def notified(self) -> list[dict]:
        path = self.config / "attention-notified.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def state(self) -> dict:
        return read_json(self.config / "attention-notify.state.json")

    def test_new_records_fold_per_run_into_one_message_each_and_the_offset_moves_once_sent(self):
        self.append("demo-001", "question", "Worker ui asked question 1 of 3: A or B?")
        self.append("other-002", "finished", "feature/other fast-forwarded to abc", node=None, at=NOON + 1)
        self.append("demo-001", "pane", "Worker ui needs attention in its pane", at=NOON + 2)
        self.now = NOON + 60
        code, out, err = self.run_once()
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(out, "Attention notify: sent 2 message(s) for 3 record(s), held 0\n")
        # One message per run in feed order; the title and the body are the configured argv's last two arguments.
        self.assertEqual(self.sent(), [["md-manager", "[demo-001] question: Worker ui asked question 1 of 3: A or B?\n"
                                                      "[demo-001] pane: Worker ui needs attention in its pane"],
                                       ["md-manager", "[other-002] finished: feature/other fast-forwarded to abc"]])
        self.assertEqual(self.notified(), [
            {"at": "2026-10-07T12:00:00Z", "sent_at": "2026-10-07T12:01:00Z", "run_id": "demo-001", "kind": "question"},
            {"at": "2026-10-07T12:00:02Z", "sent_at": "2026-10-07T12:01:00Z", "run_id": "demo-001", "kind": "pane"},
            {"at": "2026-10-07T12:00:01Z", "sent_at": "2026-10-07T12:01:00Z", "run_id": "other-002", "kind": "finished"}])
        self.assertEqual(self.state()["offset"], self.feed.stat().st_size)
        self.assertEqual(self.state()["pushed"], [])
        self.assertEqual(sorted(self.state()), ["held", "offset", "pushed", "sent", "topics", "version"])
        # The next minute: nothing new, nothing sent, nothing printed, the state untouched.
        before = (self.config / "attention-notify.state.json").stat().st_mtime_ns
        self.now = NOON + 120
        self.assertEqual(self.run_once(), (0, "", ""))
        self.assertEqual(len(self.sent()), 2)
        self.assertEqual((self.config / "attention-notify.state.json").stat().st_mtime_ns, before)
        # All ten kinds are pushed, one line each.
        for index, kind in enumerate(sorted(KINDS)):
            self.append("kinds-003", kind, f"text of {kind}", at=NOON + 200 + index)
        self.now = NOON + 300
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(self.bodies()[-1].splitlines(), [f"[kinds-003] {kind}: text of {kind}" for kind in sorted(KINDS)])
        self.assertEqual(len(self.notified()), 13)

    def test_a_failing_or_slow_notify_command_keeps_the_offset_exits_2_and_the_records_go_again(self):
        self.append()
        self.append("demo-001", "pane", "Worker ui needs attention in its pane", at=NOON + 1)
        (self.log.parent / "sent.jsonl.fail").touch()
        self.now = NOON + 60
        code, out, err = self.run_once()
        self.assertEqual(code, 2)
        self.assertEqual(err.count("\n"), 1)
        self.assertRegex(err, r"^Attention notify failed: notify command .* exited 1: stub refused the message\n$")
        self.assertEqual(len(self.sent()), 1)  # The attempt reached the command once.
        self.assertEqual((self.state()["offset"], self.state()["pushed"], self.state()["sent"]), (0, [], []))  # Not a send: no cap count.
        self.assertEqual(sorted(self.state()), ["held", "offset", "pushed", "sent", "topics", "version"])  # No byte span, no failure count: nothing reads one.
        self.assertEqual(self.notified(), [])
        # A command that does not end within the timeout is the same failure.
        (self.log.parent / "sent.jsonl.fail").unlink()
        (self.log.parent / "sent.jsonl.slow").touch()
        self.now = NOON + 120
        with patch("workflow.attention_notify.TIMEOUT_SECONDS", 0.3):
            code, out, err = self.run_once()
        self.assertEqual(code, 2)
        self.assertIn("did not end within 0.3 s", err)
        self.assertEqual((self.state()["offset"], self.state()["pushed"]), (0, []))
        # A command that is not there, too.
        (self.log.parent / "sent.jsonl.slow").unlink()
        save_json(self.config / "notify.json", {"argv": [str(self.root / "missing-notify")]})
        self.now = NOON + 180
        code, out, err = self.run_once()
        self.assertEqual(code, 2)
        self.assertIn("could not run", err)
        self.assertEqual(self.state()["offset"], 0)
        # The next run sends the same records again, and only then the offset moves.
        save_json(self.config / "notify.json", {"argv": [sys.executable, str(self.stub), str(self.log)]})
        self.now = NOON + 240
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(self.bodies()[-1], "[demo-001] question: Worker ui asked question 1 of 3: A or B?\n"
                                            "[demo-001] pane: Worker ui needs attention in its pane")
        self.assertEqual(self.state()["offset"], self.feed.stat().st_size)
        self.assertEqual(len(self.state()["sent"]), 1)
        self.assertEqual([line["kind"] for line in self.notified()], ["question", "pane"])

    def test_a_missing_or_malformed_notify_json_or_an_unreadable_feed_sends_nothing_and_exits_2(self):
        self.append()
        for content in (None, "{not json", '{"argv": []}', '{"argv": "notify.sh"}', '{"argv": ["notify.sh", 3]}', '["notify.sh"]'):
            with self.subTest(content):
                if content is None:
                    (self.config / "notify.json").unlink()
                else:
                    (self.config / "notify.json").write_text(content)
                code, out, err = self.run_once()
                self.assertEqual(code, 2)
                self.assertEqual(err.count("\n"), 1)
                self.assertTrue(err.startswith("Attention notify failed: "), err)
                self.assertIn("notify.json", err)
        self.assertEqual(self.sent(), [])
        self.assertFalse((self.config / "attention-notify.state.json").exists())
        # A feed that cannot be read (here a folder in its place): the same, with the offset where it was.
        save_json(self.config / "notify.json", {"argv": [sys.executable, str(self.stub), str(self.log)]})
        self.assertEqual(self.run_once()[0], 0)
        offset = self.state()["offset"]
        self.feed.unlink()
        self.feed.mkdir()
        code, out, err = self.run_once()
        self.assertEqual(code, 2)
        self.assertIn("attention.jsonl cannot be read", err)
        self.assertEqual(self.state()["offset"], offset)
        self.assertEqual(len(self.sent()), 1)
        # No feed at all (no controller recorded anything yet) is an empty feed, not a failure.
        self.feed.rmdir()
        self.assertEqual(self.run_once(), (0, "", ""))

    def test_a_feed_shorter_than_the_offset_is_read_from_the_start(self):
        self.append(text="first " * 20)
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(self.state()["offset"], self.feed.stat().st_size)
        # The feed was replaced (rotated by hand): shorter than the offset, so it is read again from its first byte.
        self.feed.write_text("")
        self.append("fresh-002", "finished", "feature/fresh fast-forwarded to def", node=None)
        self.assertLess(self.feed.stat().st_size, self.state()["offset"])
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(self.bodies()[-1], "[fresh-002] finished: feature/fresh fast-forwarded to def")
        self.assertEqual(self.state()["offset"], self.feed.stat().st_size)

    def test_the_eleventh_message_in_an_hour_is_held_and_one_digest_per_window_follows(self):
        for index in range(CAP):
            self.append(f"run-{index:03d}", at=NOON + index)
        self.now = NOON + 60
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(len(self.sent()), CAP)
        # The eleventh message is held: nothing sent, the record waits in the state.
        self.append("run-010", "finished", "feature/run-010 fast-forwarded to abc", node=None, at=NOON + 70)
        self.now = NOON + 120
        code, out, err = self.run_once()
        self.assertEqual((code, err, out), (0, "", "Attention notify: sent 0 message(s) for 0 record(s), held 1\n"))
        self.assertEqual(len(self.sent()), CAP)
        self.assertEqual([(item["run_id"], item["reason"]) for item in self.state()["held"]], [("run-010", "cap")])
        self.assertEqual(self.state()["offset"], self.feed.stat().st_size)  # Held is not unsent: the offset moves.
        # The next run sends one `N more records` message for the held lines instead; it counts as a send.
        self.now = NOON + 180
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(self.bodies()[-1], "1 more records\n[run-010] finished: feature/run-010 fast-forwarded to abc")
        self.assertEqual(self.state()["held"], [])
        self.assertEqual(len(self.state()["sent"]), CAP + 1)
        self.assertEqual(self.notified()[-1]["run_id"], "run-010")
        # A twelfth record within the hour: held, and no second digest while the window already carries one.
        self.append("run-011", "pane", "Worker ui needs attention in its pane", at=NOON + 190)
        for minute in (4, 5, 6):
            self.now = NOON + 60 * minute
            self.assertEqual(self.run_once()[0], 0)
            self.assertEqual(len(self.sent()), CAP + 1)
        self.assertEqual([item["run_id"] for item in self.state()["held"]], ["run-011"])
        # The window opens (the first sends are an hour old): the held lines go out as one digest.
        self.now = NOON + 60 + 3601
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(self.bodies()[-1], "1 more records\n[run-011] pane: Worker ui needs attention in its pane")
        self.assertEqual(self.state()["held"], [])

    def test_only_sent_messages_count_toward_the_cap(self):
        for index in range(CAP - 1):
            self.append(f"run-{index:03d}", at=NOON + index)
        self.assertEqual(self.run_once()[0], 0)
        self.append("run-fail", "question", "POISON: a body the channel refuses", at=NOON + 20)
        self.now = NOON + 60
        self.assertEqual(self.run_once()[0], 2)
        self.assertEqual(len(self.state()["sent"]), CAP - 1)  # The refused attempt is not a send.
        self.feed.write_text("")  # Drop the poison (the feed shrank: read from the start).
        self.append("run-last", at=NOON + 80)
        self.now = NOON + 120
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(self.bodies()[-1], "[run-last] question: Worker ui asked question 1 of 3: A or B?")
        self.assertEqual(self.state()["held"], [])

    def test_away_pushes_what_waits_on_the_operator_and_holds_the_rest_until_working(self):
        self.assertEqual(IMMEDIATE, frozenset({"question", "pane", "challenge_paused", "review_blocked", "controller_blocked", "awaiting_approval"}))
        self.assertEqual(HELD, frozenset({"finished", "sidecar", "attack", "panel"}))
        self.assertEqual(self.presence("away")[0], 0)
        self.append("demo-001", "question", "Worker ui asked question 1 of 3: A or B?")
        self.append("demo-001", "finished", "feature/demo fast-forwarded to abc", node=None, at=NOON + 1)
        self.append("other-002", "sidecar", "Review sidecar pass 2: P1 S-2 did not reach lane ui", at=NOON + 2)
        self.now = NOON + 60
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(self.bodies(), ["[demo-001] question: Worker ui asked question 1 of 3: A or B?"])
        self.assertEqual([(item["run_id"], item["kind"], item["reason"]) for item in self.state()["held"]],
                         [("demo-001", "finished", "away"), ("other-002", "sidecar", "away")])
        self.assertEqual(self.state()["offset"], self.feed.stat().st_size)
        self.now = NOON + 120
        self.assertEqual(self.run_once(), (0, "", ""))  # Still away: the held lines wait.
        self.assertEqual(self.presence("working")[0], 0)
        self.now = NOON + 180
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(self.bodies()[-1], "2 more records\n[demo-001] finished: feature/demo fast-forwarded to abc\n"
                                            "[other-002] sidecar: Review sidecar pass 2: P1 S-2 did not reach lane ui")
        self.assertEqual(self.state()["held"], [])
        self.assertEqual([line["kind"] for line in self.notified()], ["question", "finished", "sidecar"])
        # `until` passing returns the status to working by itself and releases the held lines the same way.
        self.assertEqual(self.presence("away", "--for", "9h")[0], 0)
        self.append("demo-001", "panel", "Panel ended with 1 accepted finding", node=None, at=NOON + 200)
        self.now = NOON + 240
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(len(self.bodies()), 2)
        self.now = NOON + 180 + 9 * 3600 + 1
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(self.bodies()[-1], "1 more records\n[demo-001] panel: Panel ended with 1 accepted finding")

    def test_the_presence_command_reads_and_sets_the_flag(self):
        self.assertEqual(self.presence(), (0, "working\n", ""))  # No file: working.
        self.assertEqual(presence_status(self.config, self.now), "working")
        code, out, err = self.presence("away", "--for", "9h")
        self.assertEqual((code, err, out), (0, "", "away since 2026-10-07T12:00:00Z until 2026-10-07T21:00:00Z\n"))
        self.assertEqual(read_json(self.config / "presence.json"), {"status": "away", "since": "2026-10-07T12:00:00Z", "until": "2026-10-07T21:00:00Z"})
        self.assertEqual(self.presence(), (0, "away since 2026-10-07T12:00:00Z until 2026-10-07T21:00:00Z\n", ""))
        self.now = NOON + 9 * 3600
        self.assertEqual(self.presence(), (0, "working (away until 2026-10-07T21:00:00Z passed)\n", ""))
        self.assertEqual(presence_status(self.config, self.now), "working")
        self.assertEqual(self.presence("working"), (0, "working since 2026-10-07T21:00:00Z\n", ""))
        self.assertEqual(read_json(self.config / "presence.json"), {"status": "working", "since": "2026-10-07T21:00:00Z", "until": None})
        self.assertEqual(self.presence("away"), (0, "away since 2026-10-07T21:00:00Z\n", ""))
        self.assertEqual(presence_status(self.config, self.now + 10 ** 6), "away")  # No `until`: away until set by hand.
        # A malformed file reads working; so does a duration that is not one, or --for with working, which are refused.
        (self.config / "presence.json").write_text('{"status": "asleep"}')
        self.assertEqual(self.presence(), (0, "working\n", ""))
        (self.config / "presence.json").write_text("{not json")
        self.assertEqual(presence_status(self.config, self.now), "working")
        self.assertEqual(self.presence("away", "--for", "soon")[0], 2)
        self.assertEqual(self.presence("working", "--for", "9h")[0], 2)
        self.assertEqual([parse_duration(text) for text in ("9h", "30m", "1h30m", "2d", "45s")], [32400, 1800, 5400, 172800, 45])
        self.assertEqual(self.presence("tired")[0], 2)  # argparse refuses any other word.

    def test_a_long_text_is_cut_and_a_long_body_ends_with_how_many_more_are_in_the_feed(self):
        self.append(text="x" * 400)
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(self.bodies()[-1], "[demo-001] question: " + "x" * (TEXT_LIMIT - 1) + "…")
        self.assertEqual(len(self.bodies()[-1].split(": ", 1)[1]), TEXT_LIMIT)
        self.append(text="y" * TEXT_LIMIT, at=NOON + 1)  # Exactly the limit: untouched.
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(self.bodies()[-1], "[demo-001] question: " + "y" * TEXT_LIMIT)
        # Twenty long records of one run: the body stays under the limit and says how many lines it leaves out.
        for index in range(20):
            self.append("long-002", "sidecar", f"{index:02d} " + "z" * 290, at=NOON + 10 + index)
        self.now = NOON + 60
        self.assertEqual(self.run_once()[0], 0)
        body = self.bodies()[-1]
        self.assertLessEqual(len(body), BODY_LIMIT)
        lines = body.splitlines()
        self.assertEqual(lines[-1], f"… and {20 - (len(lines) - 1)} more in the feed")
        self.assertTrue(lines[0].startswith("[long-002] sidecar: 00 "))
        self.assertEqual(len(self.notified()), 2 + len(lines) - 1)  # Only the pushed lines are logged.
        # The lines left out are held, and go out in the next digest.
        left = 20 - (len(lines) - 1)
        self.assertEqual([item["reason"] for item in self.state()["held"]], ["overflow"] * left)
        self.now = NOON + 120
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(self.bodies()[-1].splitlines()[0], f"{left} more records")
        self.assertEqual(self.state()["held"], [])
        self.assertEqual(fold([]), ("", 0))

    # --- format html: the message the operator reads on a phone ----------------------------------------------------------

    CHALLENGE = ("Design challenge attempt 1 paused the run before any worker launch: 1 P0/P1 concern(s). Edit the task files, decisions.md or "
                 "the PRD in the source checkout /h/.local/state/md-manager-workflows/att/att-003.source, then run: /h/dev/md-manager/.venv/bin/python "
                 "-m workflow resume /h/.local/state/md-manager-workflows/att/att-003 --by operator --herdr; or accept it: "
                 "/h/dev/md-manager/.venv/bin/python -m workflow resume /h/.local/state/md-manager-workflows/att/att-003 --by operator "
                 "--accept-challenge \"<reason>\" --herdr")

    def html_config(self, **extra):
        save_json(self.config / "notify.json", {"argv": [sys.executable, str(self.stub), str(self.log)], "format": "html", "bot": "panel_bot", **extra})

    def styles(self) -> list[str]:
        path = self.log.with_name(self.log.name + ".style")
        return path.read_text().splitlines() if path.exists() else []

    def test_format_html_escapes_the_text_and_lists_its_commands_as_code_buttons_and_panel_commands(self):
        # The live challenge text quotes `--accept-challenge "<reason>"`: unescaped, Telegram rejects the body and the
        # tailer would retry it every minute. Escaped once, before any tag, and the commands copy as written.
        self.html_config()
        record = {"at": "2026-10-07T12:00:00Z", "run_id": "att-003", "run_dir": "/h/.local/state/md-manager-workflows/att/att-003",
                  "kind": "challenge_paused", "node": "challenge", "text": self.CHALLENGE}
        with self.feed.open("a") as handle:
            handle.write(json.dumps(record) + "\n")
        self.now = NOON + 60
        self.assertEqual(self.run_once()[0], 0)
        title, body = self.sent()[-1]
        self.assertEqual(title, "md-manager")
        self.assertEqual(body.splitlines(), [
            "⏸ <b>att-003 · challenge paused</b>",
            "<b>challenge</b>: Design challenge attempt 1 paused the run before any worker launch: 1 P0/P1 concern(s). Edit the task files, "
            "decisions.md or the PRD in the source checkout att-003.source",
            "👉 Edit the task, decisions or PRD and resume, or accept the challenge.",
            "resume: <code>/h/dev/md-manager/.venv/bin/python -m workflow resume /h/.local/state/md-manager-workflows/att/att-003 --by operator --herdr</code>",
            "accept: <code>/h/dev/md-manager/.venv/bin/python -m workflow resume /h/.local/state/md-manager-workflows/att/att-003 --by operator "
            "--accept-challenge \"&lt;reason&gt;\" --herdr</code>",
            "/resume_att_003@panel_bot /accept_att_003@panel_bot /status_att_003@panel_bot"])
        self.assertNotIn("<reason>", body)
        mode, markup = self.styles()[-1].split("|", 1)
        self.assertEqual(mode, "HTML")
        keyboard = json.loads(markup)["inline_keyboard"]
        self.assertEqual([button["text"] for button in keyboard[0]], ["📋 resume", "📋 accept"])
        self.assertTrue(keyboard[0][1]["copy_text"]["text"].endswith('--accept-challenge "<reason>" --herdr'))  # Verbatim: no HTML in a button.
        self.assertTrue(all(len(button["copy_text"]["text"]) <= COPY_TEXT_LIMIT for button in keyboard[0]))
        # The home folder is shortened to `~` in commands (bash expands it back) and in prose; the run's folder only in prose.
        shown = describe(record, home="/h")
        self.assertEqual(shown["commands"][0], ("resume", "~/dev/md-manager/.venv/bin/python -m workflow resume ~/.local/state/md-manager-workflows/att/att-003 --by operator --herdr"))
        self.assertEqual(shown["prose"][-len("att-003.source"):], "att-003.source")
        # Plain is the default and is byte for byte what it was.
        save_json(self.config / "notify.json", {"argv": [sys.executable, str(self.stub), str(self.log)]})
        self.append("demo-001", "question", "A <b>bold</b> & co?", at=NOON + 70)
        self.now = NOON + 120
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(self.sent()[-1], ["md-manager", "[demo-001] question: A <b>bold</b> & co?"])
        self.assertEqual(self.styles()[-1], "|")
        # A malformed format or bot name is refused like the rest of notify.json.
        for bad in ({"format": "markdown"}, {"bot": "@panel_bot"}, {"bot": 7}):
            save_json(self.config / "notify.json", {"argv": [sys.executable, str(self.stub), str(self.log)], **bad})
            self.append("demo-001", "question", "again?", at=NOON + 130)
            self.now = NOON + 180
            code, out, err = self.run_once()
            self.assertEqual(code, 2, bad)
            self.assertIn('"format" must be' if "format" in bad else '"bot" must be', err)

    def test_format_html_folds_a_runs_records_under_one_title_the_first_waiting_kind_naming_the_state(self):
        self.html_config()
        self.append("att-003", "review_blocked", "Review blocked by general (blocked, 1 open P1). Read /runs/att-003/review.json; review findings are fixed in a new run.",
                    node="review", at=NOON)
        self.append("att-003", "controller_blocked", "Controller blocked: the review step failed: [P1 general] x & y; not retried, inspect retained evidence. "
                    "Status: python -m workflow status /runs/att-003", node="controller", at=NOON + 1)
        self.append("att-003", "finished", "feature/att fast-forwarded to abc: the run is finished. Nothing was pushed.", node=None, at=NOON + 2)
        self.now = NOON + 60
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(self.sent()[-1][1].splitlines(), [
            "🛑 <b>att-003 · review blocked</b>",
            "🛑 <b>review</b>: Review blocked by general (blocked, 1 open P1). Read att-003/review.json; review findings are fixed in a new run.",
            "⛔ <b>controller</b>: Controller blocked: the review step failed: [P1 general] x &amp; y; not retried, inspect retained evidence.",
            "✅ feature/att fast-forwarded to abc: the run is finished. Nothing was pushed.",
            "👉 Read the findings; they are fixed in a follow-up run.",
            "status: <code>python -m workflow status /runs/att-003</code>",
            "/review_att_003@panel_bot /status_att_003@panel_bot"])
        self.assertEqual(json.loads(self.styles()[-1].split("|", 1)[1]), {"inline_keyboard": [[{"text": "📋 status", "copy_text": {"text": "python -m workflow status /runs/att-003"}}]]})
        # A run with nothing waiting is titled by its last record; a finished run has no todo line and no buttons.
        self.append("other-002", "finished", "feature/other fast-forwarded to def: the run is finished.", node=None, at=NOON + 70)
        self.now = NOON + 120
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(self.sent()[-1][1].splitlines(), ["✅ <b>other-002 · finished</b>", "feature/other fast-forwarded to def: the run is finished.",
                                                            "/status_other_002@panel_bot"])
        self.assertEqual(self.styles()[-1], "HTML|")
        # Without `bot` the panel commands carry no @name (a DM needs none).
        save_json(self.config / "notify.json", {"argv": [sys.executable, str(self.stub), str(self.log)], "format": "html"})
        self.append("other-002", "awaiting_approval", "Candidate abc awaits your approval.", node=None, at=NOON + 130)
        self.now = NOON + 180
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(self.sent()[-1][1].splitlines()[-1], "/approve_other_002 /status_other_002")
        # The command's alphabet and Telegram's 32 characters: the run id is folded to [a-z0-9_] and cut from the front.
        self.assertEqual(command_token("status", "md-manager 9b9ba4d9", "b"), "/status_md_manager_9b9ba4d9@b")
        long = command_token("resume", "multi-provider-panel-experiment-012", None)
        self.assertLessEqual(len(long) - 1, COMMAND_LIMIT)
        self.assertTrue(long.startswith("/resume_") and long.endswith("_012"))

    def test_format_html_knows_a_sessions_permission_prompt_and_turn_ended_and_cuts_at_a_word(self):
        # The session hook's records: kind `pane` with `[tab] permission_prompt: …`, kind `finished` with `turn ended: …`,
        # the reply's last lines joined by ` / ` with markdown bold and code.
        self.html_config()
        self.append("md-manager 9b9ba4d9", "pane", "[Current ideas] permission_prompt: Claude needs your permission to use Bash", node="9b9ba4d9", at=NOON)
        self.append("md-manager 9b9ba4d9", "finished", "turn ended: 1. **Get the chat ID** from `getUpdates` & co. / 2. Add the group. / If it <fails>, retry.",
                    node="9b9ba4d9", at=NOON + 1)
        self.now = NOON + 60
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(self.sent()[-1][1].splitlines(), [
            "🔐 <b>Current ideas · permission prompt</b>",
            "🔐 Claude needs your permission to use Bash",
            "💬 1. <b>Get the chat ID</b> from <code>getUpdates</code> &amp; co.",
            "2. Add the group.",
            "If it &lt;fails&gt;, retry.",
            "👉 Allow or deny: the prompt with its buttons is in the bot's DM, or answer in the pane.",
            "/show_md_manager_9b9ba4d9@panel_bot /status_md_manager_9b9ba4d9@panel_bot"])
        # A sentence after a command stays prose and out of the command (the awaiting_approval text); a worker's question
        # keeps its answer command whole.
        shown = describe({"kind": "awaiting_approval", "text": "Awaiting your approval: python -m workflow approve /runs/x --bundle abc --by operator. "
                                                               "Nothing is fast-forwarded or pushed until then."})
        self.assertEqual(shown["commands"], [("approve", "python -m workflow approve /runs/x --bundle abc --by operator")])
        self.assertEqual(shown["prose"], "Awaiting your approval Nothing is fast-forwarded or pushed until then.")
        shown = describe({"kind": "question", "text": "Worker ui asked question 1 of 3: A or B? Answer: python -m workflow answer /runs/x ui --by operator \"<text>\""})
        self.assertEqual(shown["commands"], [("answer", "python -m workflow answer /runs/x ui --by operator \"<text>\"")])
        self.assertEqual(shown["prose"], "Worker ui asked question 1 of 3: A or B? Answer")
        shown = describe({"kind": "attack", "text": "Attack pass (report-only): 2 verified finding(s) to label: python -m workflow attack-label r-1 <id> --label real|false|out-of-scope --by operator"})
        self.assertEqual(shown["commands"][0][1], "python -m workflow attack-label r-1 <id> --label real|false|out-of-scope --by operator")
        self.assertEqual(shown["prose"], "Attack pass (report-only): 2 verified finding(s) to label")
        # Any other notification type is a bell with the event as its state; a bare `turn ended` has no prose.
        self.assertEqual(describe({"kind": "pane", "text": "auth_success: Signed in"})["emoji"], "🔔")
        self.assertEqual(describe({"kind": "pane", "text": "auth_success: Signed in"})["state"], "auth success")
        self.assertEqual(describe({"kind": "finished", "text": "turn ended"})["prose"], "")
        # A worker's own words are not mistaken for a session event.
        self.assertEqual(describe({"kind": "question", "text": "Worker ui asked question 1 of 3: A or B?"})["emoji"], "❓")
        self.assertFalse(describe({"kind": "question", "text": "ask: A or B?"})["session"])
        # Long prose is cut at a word; the digest names each run and carries no commands.
        self.assertEqual(cut_words("word " * 100, 50), "word word word word word word word word word…")
        self.assertEqual(cut_words("x" * 400, 50), "x" * 49 + "…")
        body, left = render_digest([{"run_id": "att-003", "kind": "challenge_paused", "node": "challenge", "text": self.CHALLENGE,
                                     "run_dir": "/h/.local/state/md-manager-workflows/att/att-003"},
                                    {"run_id": "md-manager 9b9ba4d9", "kind": "finished", "node": "9b9ba4d9", "text": "turn ended: done."}], home="/h")
        self.assertEqual(left, 0)
        self.assertEqual(body.splitlines(), [
            "📬 <b>2 more records</b>",
            "⏸ <b>att-003</b> challenge paused: Design challenge attempt 1 paused the run before any worker launch: 1 P0/P1 concern(s). Edit the task files, "
            "decisions.md or the PRD in the source checkout att-003.source",
            "💬 <b>md-manager 9b9ba4d9</b> turn ended: done."])
        self.assertNotIn("<code>", body)
        # A body past the limit leaves lines out but keeps the footer, and the lines left out are held like the plain format's.
        records = [{"at": attention_notify.iso(NOON + 100 + i), "run_id": "long-002", "kind": "sidecar", "node": "engine", "text": f"{i:02d} " + "z" * 290}
                   for i in range(20)]
        body, left, markup = render_run("long-002", records, {"format": "html", "bot": None})
        self.assertLessEqual(len(body), BODY_LIMIT)
        lines = body.splitlines()
        self.assertEqual(lines[-1], "/review_long_002 /status_long_002")
        self.assertEqual(lines[-3], f"… and {left} more in the feed")
        self.assertEqual(lines[-2], "👉 Read the sidecar's finding.")
        self.assertIsNone(markup)
        self.assertGreater(left, 0)

    def test_format_html_keeps_presence_cap_dedupe_and_topics_as_they_are_and_the_digest_is_formatted(self):
        topic_stub, topic_log = self.root / "topic-stub.py", self.root / "topics.txt"
        topic_stub.write_text(TOPIC_STUB)
        self.html_config(env={"TELEGRAM_CHAT_ID": "-100777"}, topic={"argv": [sys.executable, str(topic_stub), str(topic_log)], "env": "TELEGRAM_THREAD_ID"})
        self.assertEqual(self.presence("away")[0], 0)
        self.append("demo-001", "finished", "feature/demo fast-forwarded to abc: the run is finished.", node=None, at=NOON)
        self.append("demo-001", "question", "Worker ui asked question 1 of 3: A or B?", at=NOON + 1)
        self.now = NOON + 60
        self.assertEqual(self.run_once()[0], 0)  # Away: the question goes at once, in the run's topic; the finished line is held.
        self.assertEqual(self.sent()[-1][1].splitlines()[0], "❓ <b>demo-001 · question</b>")
        self.assertEqual(self.log.with_name(self.log.name + ".chat").read_text().splitlines()[-1], "-100777|100")
        self.assertEqual(self.styles()[-1], "HTML|")
        self.assertEqual([item["reason"] for item in self.state()["held"]], ["away"])
        self.assertEqual(self.presence("working")[0], 0)
        self.now = NOON + 120
        self.assertEqual(self.run_once()[0], 0)  # Back: the held line goes as a formatted digest, without a topic.
        self.assertEqual(self.sent()[-1][1].splitlines(), ["📬 <b>1 more records</b>", "✅ <b>demo-001</b> finished: feature/demo fast-forwarded to abc: the run is finished."])
        self.assertEqual(self.log.with_name(self.log.name + ".chat").read_text().splitlines()[-1], "-100777|")
        self.assertEqual(self.state()["held"], [])
        self.assertEqual(len(self.state()["sent"]), 2)
        # The cap: ten sent, the eleventh run's message held; a retry after a refusal repeats nothing (dedupe by key).
        for index in range(CAP - 2):
            self.append(f"run-{index:03d}", "question", f"q {index}?", at=NOON + 130 + index)
        self.append("late-999", "question", "late?", at=NOON + 150)
        self.now = NOON + 180
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(len(self.state()["sent"]), CAP)
        self.assertEqual([item["run_id"] for item in self.state()["held"]], ["late-999"])
        self.assertEqual(len(self.notified()), CAP)

    def test_the_tailer_never_takes_the_feeds_lock(self):
        # A controller appends under the feed's exclusive lock and drops its record after 5 s without it: the tailer reads
        # with a plain open, so a slow notify call never costs the controller a record.
        self.append()
        with self.feed.open("a") as holder:
            fcntl.flock(holder, fcntl.LOCK_EX)
            self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(self.bodies(), ["[demo-001] question: Worker ui asked question 1 of 3: A or B?"])
        self.assertNotIn("fcntl", Path(attention_notify.__file__).read_text().split("def read_feed")[1].split("def cut")[0])

    def test_a_trailing_partial_line_waits_and_a_junk_line_is_skipped(self):
        self.append()
        self.append(raw='{"at": "2026-10-07T12:00:01Z", "run_id": "demo-001", "kind": "pa')  # The controller is mid-write.
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(len(self.bodies()), 1)
        self.assertEqual(self.state()["offset"], len(self.feed.read_text().splitlines()[0]) + 1)
        with self.feed.open("a") as handle:  # The write completes.
            handle.write('ne", "node": "ui", "text": "Worker ui needs attention in its pane"}\n')
        self.now = NOON + 60
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(self.bodies()[-1], "[demo-001] pane: Worker ui needs attention in its pane")
        self.assertEqual(self.state()["offset"], self.feed.stat().st_size)
        # A complete line that is not a record: one stderr line, skipped, the offset moves past it; the next record goes.
        offset = self.state()["offset"]
        self.append(raw="not a record\n")
        self.append(raw='{"kind": "finished"}\n')
        self.append("demo-001", "finished", "feature/demo fast-forwarded to abc", node=None, at=NOON + 70)
        self.now = NOON + 120
        code, out, err = self.run_once()
        self.assertEqual(code, 0)
        self.assertEqual(err.splitlines(), [f"Attention notify: skipped a line of {self.feed} that is not a record (line 1 after offset {offset})",
                                            f"Attention notify: skipped a line of {self.feed} that is not a record (line 2 after offset {offset})"])
        self.assertEqual(self.bodies()[-1], "[demo-001] finished: feature/demo fast-forwarded to abc")
        self.assertEqual(self.state()["offset"], self.feed.stat().st_size)

    def test_a_record_that_went_is_not_repeated_while_a_later_message_fails_and_what_follows_waits_unlost(self):
        self.append("first-001", "question", "Worker ui asked question 1 of 3: A or B?", at=NOON)
        self.append("second-002", "question", "POISON: Worker ui asked question 1 of 3: C or D?", at=NOON + 1)
        self.now = NOON + 60
        self.assertEqual(self.run_once()[0], 2)
        self.assertEqual(self.bodies()[0], "[first-001] question: Worker ui asked question 1 of 3: A or B?")
        # The state names what went by record key, never by byte span or by run.
        self.assertEqual((self.state()["offset"], self.state()["pushed"]), (0, [["first-001", "2026-10-07T12:00:00Z", "question", "ui"]]))
        self.now = NOON + 120
        self.assertEqual(self.run_once()[0], 2)
        self.assertEqual([body[:12] for body in self.bodies()], ["[first-001] ", "[second-002]", "[second-002]"])
        # A new record of the first run arrives while the second still fails. Its run's first unsent record follows the
        # refused line, so it waits, unlost: the pass stops at the first refusal.
        self.append("first-001", "pane", "Worker ui needs attention in its pane", at=NOON + 130)
        self.now = NOON + 180
        self.assertEqual(self.run_once()[0], 2)
        self.assertEqual([body[:12] for body in self.bodies()], ["[first-001] ", "[second-002]", "[second-002]", "[second-002]"])
        self.assertEqual(len(self.state()["pushed"]), 1)
        # The operator edits the offending line's text: the same pass sends it and the record that waited behind it.
        lines = self.feed.read_text().splitlines()
        self.feed.write_text("\n".join(line.replace("POISON: ", "") for line in lines) + "\n")
        self.now = NOON + 240
        code, out, err = self.run_once()
        self.assertEqual((code, err, out), (0, "", "Attention notify: sent 2 message(s) for 2 record(s), held 0\n"))
        self.assertEqual(self.bodies()[-2:], ["[second-002] question: Worker ui asked question 1 of 3: C or D?",
                                              "[first-001] pane: Worker ui needs attention in its pane"])
        self.assertEqual([(line["run_id"], line["kind"]) for line in self.notified()],
                         [("first-001", "question"), ("second-002", "question"), ("first-001", "pane")])
        self.assertEqual((self.state()["offset"], self.state()["pushed"]), (self.feed.stat().st_size, []))
        self.now = NOON + 300
        self.assertEqual(self.run_once(), (0, "", ""))

    def test_a_record_appended_while_a_batch_fails_is_sent_once_the_poison_line_is_deleted(self):
        # [L2]: the retry identifies what went by record (run_id, at, kind, node), never by a byte span, so a feed edited
        # under it loses nothing. Every record gets its own `at`.
        poison_text = "POISON: Worker ui asked question 1 of 3: C or D? " + "(a body the channel refuses) " * 3
        self.append("first-001", "question", "Worker ui asked question 1 of 3: A or B?", at=NOON)
        self.append("second-002", "question", poison_text, at=NOON + 1)
        self.now = NOON + 60
        self.assertEqual(self.run_once()[0], 2)
        self.assertEqual([body[:12] for body in self.bodies()], ["[first-001] ", "[second-002]"])
        self.assertEqual(self.state()["offset"], 0)
        self.assertEqual([(line["run_id"], line["kind"]) for line in self.notified()], [("first-001", "question")])
        # The operator deletes the whole poison line. Meanwhile a later record of the already-sent run was appended, and its
        # line is shorter than the deleted one, so it ends inside the deleted line's byte span.
        lines = self.feed.read_text().splitlines(keepends=True)
        self.feed.write_text(lines[0])
        self.append("first-001", "pane", "Worker ui needs attention in its pane", at=NOON + 130)
        self.assertLess(len(self.feed.read_text().splitlines(keepends=True)[1]), len(lines[1]))
        self.now = NOON + 180
        code, out, err = self.run_once()
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(self.bodies()[-1], "[first-001] pane: Worker ui needs attention in its pane")
        self.assertEqual(len(self.bodies()), 3)  # The first run's question is not repeated.
        self.assertEqual([(line["run_id"], line["kind"]) for line in self.notified()], [("first-001", "question"), ("first-001", "pane")])
        self.assertEqual(self.state()["offset"], self.feed.stat().st_size)
        self.assertEqual(self.state()["pushed"], [])  # Every message went: the set is cleared with the offset move.
        self.assertEqual(sorted(self.state()), ["held", "offset", "pushed", "sent", "topics", "version"])
        self.now = NOON + 240
        self.assertEqual(self.run_once(), (0, "", ""))
        self.assertEqual(self.notified().count({"at": "2026-10-07T12:02:10Z", "sent_at": "2026-10-07T12:03:00Z", "run_id": "first-001", "kind": "pane"}), 1)

    def test_a_record_held_inside_a_failing_batch_goes_out_once_when_presence_flips(self):
        # Away: a question goes, a finished record is held, a later run's line is refused. Working again: the digest
        # carries the held record, and the retry does not plan it a second time as a run message.
        self.assertEqual(self.presence("away")[0], 0)
        self.append("first-001", "question", "Worker ui asked question 1 of 3: A or B?", at=NOON)
        self.append("first-001", "finished", "feature/first fast-forwarded to abc", node=None, at=NOON + 1)
        self.append("second-002", "question", "POISON: Worker ui asked question 1 of 3: C or D?", at=NOON + 2)
        self.now = NOON + 60
        self.assertEqual(self.run_once()[0], 2)
        self.assertEqual([body[:12] for body in self.bodies()], ["[first-001] ", "[second-002]"])
        self.assertEqual([(item["run_id"], item["kind"], item["node"], item["reason"]) for item in self.state()["held"]],
                         [("first-001", "finished", None, "away")])
        self.assertEqual(self.state()["pushed"], [["first-001", "2026-10-07T12:00:00Z", "question", "ui"]])
        self.now = NOON + 120
        self.assertEqual(self.run_once()[0], 2)  # Still away: the held record stays held once, the question is not repeated.
        self.assertEqual([body[:12] for body in self.bodies()], ["[first-001] ", "[second-002]", "[second-002]"])
        self.assertEqual(len(self.state()["held"]), 1)
        self.assertEqual(self.presence("working")[0], 0)
        self.now = NOON + 180
        self.assertEqual(self.run_once()[0], 2)
        # The run messages go first and the digest last: the refused line stops the pass before the digest, which waits.
        self.assertEqual(self.bodies()[-1], "[second-002] question: POISON: Worker ui asked question 1 of 3: C or D?")
        self.assertEqual(len(self.state()["held"]), 1)
        self.assertEqual(self.state()["pushed"], [["first-001", "2026-10-07T12:00:00Z", "question", "ui"]])
        self.now = NOON + 240
        self.assertEqual(self.run_once()[0], 2)
        self.assertEqual([body[:12] for body in self.bodies()[-2:]], ["[second-002]", "[second-002]"])  # Only the refused line again.
        lines = self.feed.read_text().splitlines()
        self.feed.write_text("\n".join(line.replace("POISON: ", "") for line in lines) + "\n")
        self.now = NOON + 300
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(self.bodies()[-2:], ["[second-002] question: Worker ui asked question 1 of 3: C or D?",
                                              "1 more records\n[first-001] finished: feature/first fast-forwarded to abc"])
        self.assertEqual([(line["run_id"], line["kind"]) for line in self.notified()],
                         [("first-001", "question"), ("second-002", "question"), ("first-001", "finished")])
        self.assertEqual(sum(1 for line in self.notified() if line["kind"] == "finished"), 1)
        self.assertEqual((self.state()["offset"], self.state()["pushed"], self.state()["held"]), (self.feed.stat().st_size, [], []))

    def test_a_refused_held_line_blocks_nothing_that_waits_on_the_operator_and_is_unstuck_in_the_state_file(self):
        # Away: a finished record whose text the channel refuses is held. Working again, with a new question in the feed:
        # the question goes out (the digest is planned last), the pass exits 2 on the digest, and the held copy, which
        # the feed was already read past, is unstuck by editing its entry in the state file, never a feed line.
        self.assertEqual(self.presence("away")[0], 0)
        self.append("first-001", "finished", "POISON: feature/first fast-forwarded to abc", node=None, at=NOON)
        self.now = NOON + 60
        self.assertEqual(self.run_once(), (0, "Attention notify: sent 0 message(s) for 0 record(s), held 1\n", ""))
        self.assertEqual(self.state()["offset"], self.feed.stat().st_size)
        self.assertEqual(self.presence("working")[0], 0)
        self.append("second-002", "question", "Worker ui asked question 1 of 3: C or D?", at=NOON + 70)
        self.now = NOON + 120
        code, out, err = self.run_once()
        self.assertEqual(code, 2)
        self.assertEqual(self.bodies(), ["[second-002] question: Worker ui asked question 1 of 3: C or D?",  # Went, then the digest was refused.
                                         "1 more records\n[first-001] finished: POISON: feature/first fast-forwarded to abc"])
        self.assertEqual([(line["run_id"], line["kind"]) for line in self.notified()], [("second-002", "question")])
        # The refusal keeps the offset for the retry, as any refusal does; the question that went is remembered by key.
        self.assertLess(self.state()["offset"], self.feed.stat().st_size)
        self.assertEqual(self.state()["pushed"], [["second-002", "2026-10-07T12:01:10Z", "question", "ui"]])
        self.assertEqual([item["run_id"] for item in self.state()["held"]], ["first-001"])
        self.append("third-003", "pane", "Worker ui needs attention in its pane", at=NOON + 130)
        self.now = NOON + 180
        self.assertEqual(self.run_once()[0], 2)  # The pane record still reaches the operator; only the digest is refused again.
        self.assertEqual(self.bodies()[-2:], ["[third-003] pane: Worker ui needs attention in its pane",
                                              "1 more records\n[first-001] finished: POISON: feature/first fast-forwarded to abc"])
        # The unstick the RUNBOOK gives for a held record: edit that entry's text in the state file.
        state = self.state()
        state["held"][0]["text"] = state["held"][0]["text"].replace("POISON: ", "")
        save_json(self.config / "attention-notify.state.json", state)
        self.now = NOON + 240
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(self.bodies()[-1], "1 more records\n[first-001] finished: feature/first fast-forwarded to abc")
        self.assertEqual([(line["run_id"], line["kind"]) for line in self.notified()],
                         [("second-002", "question"), ("third-003", "pane"), ("first-001", "finished")])
        self.assertEqual((self.state()["held"], self.state()["pushed"]), ([], []))
        self.assertIn("A held record (the digest", (TOOL / "workflow/RUNBOOK.md").read_text())

    def test_notify_json_env_names_the_target_chat_and_never_a_secret(self):
        # The command's own files decide the channel and its token; notify.json's `env` only redirects it (the group
        # instead of the DM, [O6]) by setting variables the command reads, here TELEGRAM_CHAT_ID.
        chats = self.log.with_name(self.log.name + ".chat")
        self.append()
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(chats.read_text().splitlines(), ["|"])  # No env: the command's own default chat, no topic.
        save_json(self.config / "notify.json", {"argv": [sys.executable, str(self.stub), str(self.log)], "env": {"TELEGRAM_CHAT_ID": "-1001234567890"}})
        self.append(at=NOON + 1)
        self.now = NOON + 60
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(chats.read_text().splitlines(), ["|", "-1001234567890|"])
        for env, detail in (({"TELEGRAM_BOT_TOKEN": "123:abc"}, "TELEGRAM_BOT_TOKEN"), ({"NTFY_TOPIC": 7}, '"env" must be an object'), ("x", '"env" must be an object')):
            save_json(self.config / "notify.json", {"argv": [sys.executable, str(self.stub), str(self.log)], "env": env})
            self.append(at=NOON + 70)
            self.now = NOON + 120
            code, out, err = self.run_once()
            self.assertEqual((code, out), (2, ""))
            self.assertIn(detail, err)
            self.assertEqual(err.count("\n"), 1)
        self.assertEqual(len(self.bodies()), 2)  # The refused configs sent nothing.

    def test_a_forum_group_gets_one_topic_per_run_kept_in_the_state_and_a_failed_topic_is_a_warning(self):
        # [O7]: with `topic` in notify.json, each run's first message creates a topic named after the run (the topic
        # command prints its thread id), the id is kept in the state and every later message of the run carries it in
        # the topic's variable; a digest (several runs) goes without one. A topic command that fails is one stderr line
        # and exit 2: the message still goes, without a topic, and the next message of that run tries again.
        chats = self.log.with_name(self.log.name + ".chat")
        topic_stub, topic_log = self.root / "topic-stub.py", self.root / "topics.txt"
        topic_stub.write_text(TOPIC_STUB)
        save_json(self.config / "notify.json", {"argv": [sys.executable, str(self.stub), str(self.log)], "env": {"TELEGRAM_CHAT_ID": "-100777"},
                                                "topic": {"argv": [sys.executable, str(topic_stub), str(topic_log)], "env": "TELEGRAM_THREAD_ID"}})
        self.append("demo-001", at=NOON)
        self.append("other-002", "pane", "Worker ui needs attention in its pane", at=NOON + 1)
        self.now = NOON + 60
        self.assertEqual(self.run_once()[0], 0)
        # Created in the target chat, named by the state's emoji, the run id and the feature folder (`/runs/<run>` here).
        self.assertEqual(topic_log.read_text().splitlines(), ["❓ demo-001 · Runs|-100777", "🖥 other-002 · Runs|-100777"])
        self.assertEqual(chats.read_text().splitlines(), ["-100777|100", "-100777|101"])
        self.assertEqual(self.state()["topics"], {"demo-001": {"thread": 100, "name": "❓ demo-001 · Runs"}, "other-002": {"thread": 101, "name": "🖥 other-002 · Runs"}})
        self.append("demo-001", "review_blocked", "Review blocked by general (blocked, 1 open P1)", node="review", at=NOON + 70)
        self.now = NOON + 120
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(topic_log.read_text().splitlines(), ["❓ demo-001 · Runs|-100777", "🖥 other-002 · Runs|-100777"])  # Created once per run.
        self.assertEqual(chats.read_text().splitlines()[-1], "-100777|100")
        # A digest carries lines of several runs: no topic.
        self.assertEqual(self.presence("away")[0], 0)
        self.append("demo-001", "finished", "feature/demo fast-forwarded to abc", node=None, at=NOON + 130)
        self.append("other-002", "finished", "feature/other fast-forwarded to def", node=None, at=NOON + 131)
        self.now = NOON + 180
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(self.presence("working")[0], 0)
        self.now = NOON + 240
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(self.bodies()[-1].splitlines()[0], "2 more records")
        self.assertEqual(chats.read_text().splitlines()[-1], "-100777|")
        # The topic command fails for a new run: the message goes without a topic, the pass says so and exits 2.
        topic_log.with_name(topic_log.name + ".topicfail").write_text("")
        self.append("third-003", "question", "Worker ui asked question 1 of 3: E or F?", at=NOON + 250)
        self.now = NOON + 300
        code, out, err = self.run_once()
        self.assertEqual(code, 2)
        self.assertEqual(err, "Attention notify: topic for third-003 not created, sent without it: topic command " + sys.executable
                              + " exited 1: stub refused the topic\n")
        self.assertEqual(self.bodies()[-1], "[third-003] question: Worker ui asked question 1 of 3: E or F?")
        self.assertEqual(chats.read_text().splitlines()[-1], "-100777|")
        self.assertEqual(self.state()["offset"], self.feed.stat().st_size)  # Sent: nothing is retried.
        self.assertNotIn("third-003", self.state()["topics"])
        topic_log.with_name(topic_log.name + ".topicfail").unlink()
        self.append("third-003", "pane", "Worker ui needs attention in its pane", at=NOON + 310)
        self.now = NOON + 360
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(self.state()["topics"]["third-003"]["thread"], 102)
        self.assertEqual(chats.read_text().splitlines()[-1], "-100777|102")
        self.assertEqual([line["run_id"] for line in self.notified()].count("third-003"), 2)
        # A malformed `topic` is refused like a malformed `env`.
        save_json(self.config / "notify.json", {"argv": [sys.executable, str(self.stub), str(self.log)], "topic": {"argv": [], "env": "X"}})
        self.append(at=NOON + 370)
        self.now = NOON + 420
        code, out, err = self.run_once()
        self.assertEqual((code, out), (2, ""))
        self.assertIn('"topic" must hold', err)

    def test_a_topic_is_named_after_the_pane_title_or_the_feature_and_renamed_when_the_state_or_title_changes(self):
        topic_stub, topic_log = self.root / "topic-stub.py", self.root / "topics.txt"
        rename_stub, rename_log = self.root / "rename-stub.py", self.root / "renames.txt"
        topic_stub.write_text(TOPIC_STUB)
        rename_stub.write_text(RENAME_STUB)
        self.html_config(env={"TELEGRAM_CHAT_ID": "-100777"},
                         topic={"argv": [sys.executable, str(topic_stub), str(topic_log)], "env": "TELEGRAM_THREAD_ID",
                                "rename": [sys.executable, str(rename_stub), str(rename_log)]})
        # A run under `<feature>/<run>` with a source checkout: the feature's name, first clause, in the topic's name.
        run_dir = self.root / "state" / "attention-notify" / "attention-notify-003"
        (run_dir.with_name(run_dir.name + ".source") / "features" / "attention-notify").mkdir(parents=True)
        save_json(run_dir.with_name(run_dir.name + ".source") / "features" / "attention-notify" / "feature.json",
                  {"name": "Attention notifications: a oneshot tailer of the feed", "version": "2.4.0"})
        with self.feed.open("a") as handle:
            handle.write(json.dumps({"at": attention_notify.iso(NOON), "run_id": "attention-notify-003", "run_dir": str(run_dir), "kind": "challenge_paused",
                                     "node": "challenge", "text": "Design challenge attempt 1 paused the run."}) + "\n")
            # A session record carries the pane's title: the topic is named after it, and so is the message's title line.
            handle.write(json.dumps({"at": attention_notify.iso(NOON + 1), "run_id": "md-manager ab7716e7", "run_dir": "/home/x/dev/md-manager", "kind": "finished",
                                     "node": "ab7716e7", "text": "turn ended: Both notifiers are on.", "title": "Current ideas"}) + "\n")
        self.now = NOON + 60
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(topic_log.read_text().splitlines(), ["⏸ attention-notify-003 · Attention notifications|-100777", "💬 Current ideas|-100777"])
        self.assertEqual(self.sent()[-1][1].splitlines()[:2], ["💬 <b>Current ideas · turn ended</b>", "Both notifiers are on."])
        self.assertEqual(self.state()["topics"], {"attention-notify-003": {"thread": 100, "name": "⏸ attention-notify-003 · Attention notifications"},
                                                  "md-manager ab7716e7": {"thread": 101, "name": "💬 Current ideas"}})
        self.assertFalse(rename_log.exists())
        # A session's state changes alone renames nothing: its emoji is fixed, so a permission prompt costs no rename.
        with self.feed.open("a") as handle:
            handle.write(json.dumps({"at": attention_notify.iso(NOON + 61), "run_id": "md-manager ab7716e7", "run_dir": "/home/x/dev/md-manager", "kind": "pane",
                                     "node": "ab7716e7", "text": "permission_prompt: Claude needs your permission to use Bash", "title": "Current ideas"}) + "\n")
        self.now = NOON + 65
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(self.sent()[-1][1].splitlines()[0], "🔐 <b>Current ideas · permission prompt</b>")
        self.assertFalse(rename_log.exists())
        # The run is blocked and the pane's title changed: both topics are renamed, the new names kept.
        self.append("attention-notify-003", "review_blocked", "Review blocked by general (blocked, 1 open P1).", node="review", at=NOON + 70, run_dir=str(run_dir))
        with self.feed.open("a") as handle:
            handle.write(json.dumps({"at": attention_notify.iso(NOON + 71), "run_id": "md-manager ab7716e7", "run_dir": "/home/x/dev/md-manager", "kind": "pane",
                                     "node": "ab7716e7", "text": "permission_prompt: Claude needs your permission to use Bash", "title": "Notifier rollout"}) + "\n")
        self.now = NOON + 120
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(rename_log.read_text().splitlines(), ["100|🛑 attention-notify-003 · Attention notifications", "101|💬 Notifier rollout"])
        self.assertEqual(self.state()["topics"]["md-manager ab7716e7"], {"thread": 101, "name": "💬 Notifier rollout"})
        self.assertEqual(self.log.with_name(self.log.name + ".chat").read_text().splitlines()[-2:], ["-100777|100", "-100777|101"])
        # A rename that fails is a warning and exit 2: the message still goes, in its topic, and the rename is tried again.
        rename_log.with_name(rename_log.name + ".renamefail").write_text("")
        self.append("attention-notify-003", "finished", "feature/attention-notify fast-forwarded to abc: the run is finished.", node=None, at=NOON + 130, run_dir=str(run_dir))
        self.now = NOON + 180
        code, out, err = self.run_once()
        self.assertEqual(code, 2)
        self.assertIn("topic for attention-notify-003 not renamed to '✅ attention-notify-003 · Attention notifications': rename command", err)
        self.assertEqual(self.log.with_name(self.log.name + ".chat").read_text().splitlines()[-1], "-100777|100")
        self.assertEqual(self.state()["topics"]["attention-notify-003"]["name"], "🛑 attention-notify-003 · Attention notifications")
        rename_log.with_name(rename_log.name + ".renamefail").unlink()
        self.append("attention-notify-003", "sidecar", "Review sidecar pass 1: P2 S-1 on lane main did not reach the lane.", node="main", at=NOON + 190, run_dir=str(run_dir))
        self.now = NOON + 240
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(rename_log.read_text().splitlines()[-1], "100|🔎 attention-notify-003 · Attention notifications")
        # A state file from the first version holds bare thread ids: read as topics without a name, renamed at the next message.
        state = self.state()
        state["topics"] = {"attention-notify-003": 100}
        save_json(self.config / "attention-notify.state.json", state)
        self.append("attention-notify-003", "question", "Worker main asked question 1 of 3: A or B?", node="main", at=NOON + 250, run_dir=str(run_dir))
        self.now = NOON + 300
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(rename_log.read_text().splitlines()[-1], "100|❓ attention-notify-003 · Attention notifications")
        self.assertEqual(self.state()["topics"]["attention-notify-003"], {"thread": 100, "name": "❓ attention-notify-003 · Attention notifications"})
        # Without a source checkout the feature slug is the name, in words; a malformed `rename` is refused.
        self.assertEqual(attention_notify.feature_words({"run_dir": "/state/review-sidecar/review-sidecar-002"}), "Review sidecar")
        self.assertEqual(attention_notify.feature_words({}), "")
        save_json(self.config / "notify.json", {"argv": [sys.executable, str(self.stub), str(self.log)],
                                                "topic": {"argv": [sys.executable, str(topic_stub), str(topic_log)], "env": "X", "rename": "no"}})
        self.append(at=NOON + 310)
        self.now = NOON + 360
        self.assertIn('"topic" must hold', self.run_once()[2])

    def test_a_second_instance_at_once_sends_nothing_and_exits_0(self):
        self.append()
        with (self.config / "attention-notify.lock").open("a") as holder:
            fcntl.flock(holder, fcntl.LOCK_EX)
            code, out, err = self.run_once()
        self.assertEqual((code, out, err), (0, "", "Attention notify: another instance is running; nothing done\n"))
        self.assertEqual(self.sent(), [])
        self.assertFalse((self.config / "attention-notify.state.json").exists())
        self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(len(self.sent()), 1)

    def test_every_file_lives_beside_the_registry_and_nothing_under_the_real_home_is_read(self):
        self.assertEqual(config_dir(self.env), self.config)
        self.assertEqual(config_dir({}), Path.home() / ".config/md-manager")
        self.presence("away")
        self.append()
        with patch("pathlib.Path.home", side_effect=AssertionError("the real home was consulted")):
            self.assertEqual(self.run_once()[0], 0)
        self.assertEqual(sorted(path.name for path in self.config.iterdir()),
                         ["attention-notified.jsonl", "attention-notify.lock", "attention-notify.state.json", "attention.jsonl",
                          "notify.json", "presence.json"])
        self.assertNotIn("Path.home", Path(attention_notify.__file__).read_text())

    def test_the_commands_dispatch_from_python_m_workflow(self):
        self.append()
        env = {**os.environ, **self.env}
        done = subprocess.run([sys.executable, "-m", "workflow", "presence", "away", "--for", "2h"], cwd=TOOL, env=env, capture_output=True, text=True)
        self.assertEqual((done.returncode, done.stderr), (0, ""))
        self.assertTrue(done.stdout.startswith("away since "), done.stdout)
        done = subprocess.run([sys.executable, "-m", "workflow", "attention-notify"], cwd=TOOL, env=env, capture_output=True, text=True)
        self.assertEqual((done.returncode, done.stderr, done.stdout), (0, "", "Attention notify: sent 1 message(s) for 1 record(s), held 0\n"))
        self.assertEqual(self.bodies(), ["[demo-001] question: Worker ui asked question 1 of 3: A or B?"])
        done = subprocess.run([sys.executable, "-m", "workflow", "attention-notify"], cwd=TOOL, env=env, capture_output=True, text=True)
        self.assertEqual((done.returncode, done.stdout), (0, ""))


class UnitsAndDocs(unittest.TestCase):
    def test_the_example_units_are_a_oneshot_every_minute_without_catch_up(self):
        service = (TOOL / "workflow/systemd/attention-notify.service").read_text()
        timer = (TOOL / "workflow/systemd/attention-notify.timer").read_text()
        self.assertIn("Type=oneshot", service)
        self.assertIn("-m workflow attention-notify", service)
        self.assertIn("WorkingDirectory=", service)
        self.assertIn(".venv/bin/python", service)
        self.assertIn("# Environment=MD_MANAGER_PROJECTS_CONFIG=", service)
        self.assertIn("OnCalendar=*-*-* *:*:00", timer)
        self.assertIn("Persistent=false", timer)
        self.assertIn("WantedBy=timers.target", timer)

    def test_the_runbook_section_and_the_readme_rows(self):
        runbook = (TOOL / "workflow/RUNBOOK.md").read_text()
        section = runbook.split("## Attention notifications", 1)[1].split("\n## ", 1)[0]
        for text in ("systemctl --user enable --now attention-notify.timer", "loginctl enable-linger $USER", "loginctl show-user $USER -p Linger",
                     '"argv"', '"status"', '"until"', "python -m workflow presence", "attention-notify.state.json", "attention-notified.jsonl",
                     "notify.json", "presence.json", "10 messages", "exits 2",
                     # [O6]: the target chat is set in notify.json's `env`, never a token; the group's id and the bot in it.
                     '"env"', "TELEGRAM_CHAT_ID", "the group's chat id", "never a token",
                     # [O7]: a forum group, one topic per run, the thread ids in the state; the bot an admin with Manage topics.
                     '"topic"', "TELEGRAM_THREAD_ID", "Manage topics", "one topic per run", '"topics"',
                     "--create-topic", "message_thread_id", "/telegram:access group add",
                     # The install block starts the offset at the feed's end before the first pass, or the whole feed is replayed.
                     '"offset": %s, "sent": [], "held": [], "pushed": []', "stat -c %s ~/.config/md-manager/attention.jsonl",
                     "without this the first pass replays every record the feed holds",
                     # The notify script's contract is checked by hand before the timer is enabled.
                     "once more with the network cut: it must exit non-zero",
                     # [L2]: the retry skips what went by record key and sends the rest; a refused line is unstuck by editing
                     # or deleting that line only, which sits at or after the offset; never an earlier line or the state file.
                     "skips the records already sent", "`pushed`", "run id, timestamp, kind and node", "not lost",
                     "edit that line's text in `attention.jsonl`, or delete the line",
                     "at or after the saved offset", "Never edit or delete a feed line before the offset",
                     # A held record was read past; its copy is the state file's `held` entry, edited with the timer stopped.
                     "A held record (the digest", "entry of `held` in `attention-notify.state.json`",
                     "systemctl --user stop attention-notify.timer", "edit that entry's `text`",
                     "the digest is planned last, so a refused digest holds back nothing else",
                     "wait, unlost, until the line is edited or deleted",
                     "Do not delete the state file for this: that replays the whole feed",
                     "Deleting it replays the whole feed from its first byte, drops the held lines and resets the cap window"):
            with self.subTest(text):
                self.assertIn(text, section)
        for text in ("fallback line", "failed: true", "after 5 attempts",  # [L1]: no fallback, so none documented.
                     "pending", "move `offset`", "sent_runs"):  # [L2]: no saved batch, no offset-moving recipe.
            self.assertNotIn(text, section)
        # The install block's starter state holds the keys the module writes, so the first pass reads it whole.
        printf = next(line for line in section.splitlines() if line.startswith("printf '{\"version\""))
        self.assertEqual(json.loads(printf.split("printf '", 1)[1].split("\\n'", 1)[0] % 0), {**attention_notify.empty_state(), "offset": 0})
        self.assertNotIn("pending", Path(attention_notify.__file__).read_text())
        install = section.split("```bash", 1)[1].split("```", 1)[0].splitlines()
        self.assertLess(next(i for i, line in enumerate(install) if "attention-notify.state.json" in line),
                        next(i for i, line in enumerate(install) if line.startswith('"$PY" -m workflow attention-notify')))
        readme = (TOOL / "workflow/README.md").read_text()
        self.assertIn("| `$PY -m workflow attention-notify` |", readme)
        self.assertIn("| `$PY -m workflow presence [working\\|away] [--for 9h]` |", readme)


if __name__ == "__main__":
    unittest.main()
