"""`python -m workflow accept <run> --candidate <sha> --reason "<text>" --by operator` (docs/PRD_ACCEPT_OVERRIDE.md):
the operator-override run outcome. Its record, the refusals, the open-findings rule, the on-main check, accept after
abandon, the attention it resolves, and that every mutating command refuses an accepted run. The ledger's own classifier
is covered in test_ledger.py."""
import contextlib
import io
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from . import attention
from .interactive import InteractiveSessions
from .sessions import git, prepare, read_json, save_json
from .verification import policy_digest, validate_schema

POLICY = {"version": "1.2.0", "feature": "Accept test", "independent_review": True, "integration_approval": True, "workers": [
    {"node_id": "ui", "role": "frontend", "owned_paths": ["ui.txt"], "required_check_kinds": ["unit"],
     "checks": [{"id": "unit", "kind": "unit", "argv": ["true"], "timeout_seconds": 10, "scenarios": []}]}]}


def git_run(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


def build_run(root: Path, base_on_main: bool = True):
    """A prepared one-lane run on branch `main`. Returns (directory, repo, on_main_sha, off_main_sha). The run's base (and the
    candidate.json it writes) is a commit on main when `base_on_main`, else a side commit off main."""
    repo = root / "repo"
    repo.mkdir()
    (repo / "ui.txt").write_text("base\n")
    git_run(repo, "init", "-q", "-b", "main")
    git_run(repo, "config", "user.name", "Test")
    git_run(repo, "config", "user.email", "test@example.invalid")
    git_run(repo, "add", ".")
    git_run(repo, "commit", "-qm", "Base")
    base = git(repo, "rev-parse", "HEAD")
    (repo / "ui.txt").write_text("more\n")
    git_run(repo, "add", ".")
    git_run(repo, "commit", "-qm", "On main")
    on_main_sha = git(repo, "rev-parse", "HEAD")
    git_run(repo, "checkout", "-q", "--detach", base)
    (repo / "side.txt").write_text("side\n")
    git_run(repo, "add", ".")
    git_run(repo, "commit", "-qm", "Off main")
    off_main_sha = git(repo, "rev-parse", "HEAD")
    git_run(repo, "checkout", "-q", "main")
    directory = root / "run"
    chosen = on_main_sha if base_on_main else off_main_sha
    plan = prepare(directory, repo, chosen, {"ui": "## Goal\nShow the run list.\n"}, True)
    plan.update(mode="interactive", policy_sha256=policy_digest(POLICY), source_branch="main")
    save_json(directory / "plan.json", plan)
    save_json(directory / "policy.json", POLICY)
    save_json(directory / "candidate.json", {"commit": chosen, "worktree": str(directory / "candidate")})
    return directory, repo, on_main_sha, off_main_sha


def accept_cli(*argv: str) -> tuple[int, str]:
    from .accept import accept_main
    output = io.StringIO()
    code = 0
    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
        try:
            accept_main(list(argv))
        except SystemExit as exit_:
            code = exit_.code or 0
    return code, output.getvalue()


class AcceptTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.registry = self.root / "config" / "projects.json"
        env = patch.dict(os.environ, {"CLAUDECODE": "", "MD_MANAGER_PROJECTS_CONFIG": str(self.registry)})
        env.start()
        self.addCleanup(env.stop)

    def test_a_valid_accept_writes_the_record_one_event_and_the_export_key(self):
        directory, repo, on_main_sha, _ = build_run(self.root)
        code, output = accept_cli(str(directory), "--candidate", on_main_sha, "--reason", "Merged by hand over one P1.", "--by", "operator")
        self.assertEqual(code, 0, output)
        record = read_json(directory / "accepted.json")
        self.assertEqual((record["version"], record["by"], record["candidate"], record["on_main"], record["review"], record["open_findings"]),
                         ("1.0.0", "operator", on_main_sha, True, "none", []))
        self.assertNotIn("via", record)  # CLAUDECODE empty: a plain shell.
        validate_schema("accepted", record)  # It is schema-valid as written.
        events = [json.loads(line) for line in (directory / "events.jsonl").read_text().splitlines()]
        accepted_events = [event for event in events if event["message"].startswith("Accepted by")]
        self.assertEqual([(event["node"], event["status"], event["message"]) for event in accepted_events],
                         [("controller", "succeeded", "Accepted by the operator: Merged by hand over one P1.")])
        exported = read_json(directory / "run-state.json")
        self.assertEqual(exported["version"], "1.12.0")
        self.assertEqual(exported["accepted"], record)
        self.assertIn(f"Accepted {directory}", output)

    def test_an_export_without_an_accept_carries_a_null_accepted_key(self):
        directory, repo, _, _ = build_run(self.root)
        from .pipeline import ExportRuntime, persisted_state, report
        runtime = ExportRuntime(directory)
        report(runtime, persisted_state(runtime))
        exported = read_json(directory / "run-state.json")
        self.assertEqual((exported["version"], exported["accepted"]), ("1.12.0", None))

    def test_a_candidate_off_main_is_recorded_with_on_main_false_and_a_warning(self):
        directory, repo, _, off_main_sha = build_run(self.root, base_on_main=False)
        code, output = accept_cli(str(directory), "--candidate", off_main_sha, "--reason", "Shipped off main.", "--by", "operator")
        self.assertEqual(code, 0, output)
        self.assertIs(read_json(directory / "accepted.json")["on_main"], False)
        self.assertIn("Warning:", output)
        self.assertIn("is not an ancestor of main", output)

    def test_a_via_is_recorded_from_a_claude_code_session(self):
        directory, repo, on_main_sha, _ = build_run(self.root)
        with patch.dict(os.environ, {"CLAUDECODE": "1"}):
            code, output = accept_cli(str(directory), "--candidate", on_main_sha, "--reason", "r", "--by", "operator")
        self.assertEqual(code, 0, output)
        self.assertEqual(read_json(directory / "accepted.json")["via"], "claude-code")

    def test_the_maintainer_and_a_missing_actor_are_refused(self):
        directory, repo, on_main_sha, _ = build_run(self.root)
        code, output = accept_cli(str(directory), "--candidate", on_main_sha, "--reason", "r", "--by", "maintainer")
        self.assertEqual(code, 1, output)
        self.assertIn("accept is the operator's decision: --by maintainer is refused", output)
        self.assertFalse((directory / "accepted.json").exists())
        from .actor import OPERATOR_ONLY
        self.assertIn("accept", OPERATOR_ONLY)

    def test_a_second_accept_is_refused_with_its_own_message(self):
        directory, repo, on_main_sha, _ = build_run(self.root)
        self.assertEqual(accept_cli(str(directory), "--candidate", on_main_sha, "--reason", "first", "--by", "operator")[0], 0)
        before = (directory / "accepted.json").read_text()
        code, output = accept_cli(str(directory), "--candidate", on_main_sha, "--reason", "second", "--by", "operator")
        self.assertEqual(code, 1, output)
        self.assertIn("already accepted by the operator", output)
        self.assertEqual((directory / "accepted.json").read_text(), before)  # The first record is never rewritten.

    def test_a_candidate_that_is_not_the_runs_is_refused_and_a_prefix_resolves(self):
        # brief.candidate_commit is the latest generation; its gen-0 is a different commit ([L3], design note 5).
        directory, repo, on_main_sha, off_main_sha = build_run(self.root)
        (directory / "candidate.json").unlink()
        save_json(directory / "candidate-0.json", {"commit": off_main_sha, "worktree": str(directory / "c0")})
        save_json(directory / "candidate-1.json", {"commit": on_main_sha, "worktree": str(directory / "c1")})
        # The generation-0 commit, full or as a prefix of another commit, is refused as not the run's candidate.
        for revision in (off_main_sha, off_main_sha[:8]):
            code, output = accept_cli(str(directory), "--candidate", revision, "--reason", "r", "--by", "operator")
            self.assertEqual(code, 1, output)
            self.assertIn("is not the run's candidate", output)
            self.assertFalse((directory / "accepted.json").exists())
        # A 7-char prefix of the latest generation resolves and is accepted.
        code, output = accept_cli(str(directory), "--candidate", on_main_sha[:7], "--reason", "r", "--by", "operator")
        self.assertEqual(code, 0, output)
        self.assertEqual(read_json(directory / "accepted.json")["candidate"], on_main_sha)

    def test_a_run_with_no_candidate_and_one_that_integrated_normally_are_refused(self):
        directory, repo, on_main_sha, _ = build_run(self.root)
        (directory / "candidate.json").unlink()
        code, output = accept_cli(str(directory), "--candidate", on_main_sha, "--reason", "r", "--by", "operator")
        self.assertEqual(code, 1, output)
        self.assertIn("has no candidate yet", output)
        save_json(directory / "candidate.json", {"commit": on_main_sha, "worktree": str(directory / "candidate")})
        (directory / "integration-intent.json").write_text("{}")
        code, output = accept_cli(str(directory), "--candidate", on_main_sha, "--reason", "r", "--by", "operator")
        self.assertEqual(code, 1, output)
        self.assertIn("integrated normally", output)
        self.assertFalse((directory / "accepted.json").exists())

    def test_a_live_recorded_session_is_refused_naming_it(self):
        directory, repo, on_main_sha, _ = build_run(self.root)
        save_json(directory / "ui.interactive.json", {"background_id": "bg-ui-1", "session_id": "11111111-1111-4111-8111-111111111111"})
        with patch.object(InteractiveSessions, "inventory", lambda self: [{"id": "bg-ui-1", "state": "running"}]):
            code, output = accept_cli(str(directory), "--candidate", on_main_sha, "--reason", "r", "--by", "operator")
        self.assertEqual(code, 1, output)
        self.assertIn("live recorded session (ui)", output)
        self.assertIn("abandon it first", output)
        self.assertFalse((directory / "accepted.json").exists())

    def test_a_hand_edited_non_iso_accepted_at_fails_the_export(self):
        # [L14]/note 2: accepted_at's pattern makes export_section reject a non-ISO value the way the viewer's strict parse would,
        # so a hand-fixed accepted.json cannot pass `workflow export` and then vanish from the viewer as RUN_STORAGE_INVALID.
        directory, repo, on_main_sha, _ = build_run(self.root)
        self.assertEqual(accept_cli(str(directory), "--candidate", on_main_sha, "--reason", "r", "--by", "operator")[0], 0)
        from .accept import export_section
        self.assertIsNotNone(export_section(directory))  # The record accept wrote (a Z ISO time) validates.
        record = read_json(directory / "accepted.json")
        save_json(directory / "accepted.json", {**record, "accepted_at": "yesterday"})
        with self.assertRaisesRegex(ValueError, "does not validate"):
            export_section(directory)

    def test_accept_on_an_abandoned_run_lists_no_session_abandon_already_stopped(self):
        # [L14]/note 1: a node abandon named in not_running (or stopped) is not live and needs no listing. accept records even
        # while `claude agents` is down, because abandon confirmed the stop under the same locks and refuse_abandoned blocks relaunch.
        directory, repo, on_main_sha, _ = build_run(self.root)
        save_json(directory / "ui.interactive.json", {"background_id": "bg-ui-1", "session_id": "11111111-1111-4111-8111-111111111111"})
        save_json(directory / "abandon.json", {"version": "1.0.0", "run_id": "run", "reason": "paused", "by": "operator",
                                               "abandoned_at": "2026-10-08T09:00:00Z", "stopped": [], "not_running": ["ui"]})

        def unavailable(self):
            raise RuntimeError("`claude agents --json` gave no listing")
        with patch.object(InteractiveSessions, "inventory", unavailable):
            code, output = accept_cli(str(directory), "--candidate", on_main_sha, "--reason", "shipped", "--by", "operator")
        self.assertEqual(code, 0, output)
        self.assertTrue((directory / "accepted.json").exists())

    def test_accept_on_a_blocked_not_abandoned_run_lists_no_session_when_every_node_is_confirmed_stopped(self):
        # [L14]/note 1, the coverage review's case (1): a review-blocked run that was never abandoned, whose recorded node has a
        # confirmed `<node>.stop.json` (stopped: true, what Pipeline.stop_workers/stop_reviewer write). No abandon.json. accept
        # must record even while `claude agents` is down: no node still might run, so the listing is never taken.
        directory, repo, on_main_sha, _ = build_run(self.root)
        save_json(directory / "ui.interactive.json", {"background_id": "bg-ui-1", "session_id": "11111111-1111-4111-8111-111111111111"})
        save_json(directory / "ui.stop.json", {"stopped": True})
        self.assertFalse((directory / "abandon.json").exists())  # The run was never abandoned: this is the normal blocked shape.

        def unavailable(self):
            raise RuntimeError("`claude agents --json` gave no listing")
        with patch.object(InteractiveSessions, "inventory", unavailable):
            code, output = accept_cli(str(directory), "--candidate", on_main_sha, "--reason", "shipped", "--by", "operator")
        self.assertEqual(code, 0, output)
        self.assertTrue((directory / "accepted.json").exists())

    def test_a_controller_holding_the_lock_is_refused(self):
        from .sessions import run_lock
        directory, repo, on_main_sha, _ = build_run(self.root)
        with run_lock(directory):  # A controller owns the run.
            code, output = accept_cli(str(directory), "--candidate", on_main_sha, "--reason", "r", "--by", "operator")
        self.assertEqual(code, 1, output)
        self.assertIn("Another controller owns this run", output)
        self.assertFalse((directory / "accepted.json").exists())

    def test_accept_follows_abandon_and_resolves_blocked_attention(self):
        directory, repo, on_main_sha, _ = build_run(self.root)
        save_json(directory / "abandon.json", {"version": "1.0.0", "run_id": "run", "reason": "paused overnight", "by": "operator",
                                               "abandoned_at": "2026-10-08T09:00:00Z", "stopped": [], "not_running": []})
        attention.attention(directory, "controller_blocked", "the controller is stuck", node="ui")
        attention.attention(directory, "review_blocked", "coverage blocked it", node="review")
        attention.attention(directory, "finished", "a finished state", node="integrate")
        code, output = accept_cli(str(directory), "--candidate", on_main_sha, "--reason", "shipped over the block", "--by", "operator")
        self.assertEqual(code, 0, output)
        self.assertEqual(read_json(directory / "accepted.json")["reason"], "shipped over the block")
        kinds = {item["kind"] for item in attention.states(attention.load_record(directory))}
        self.assertNotIn("controller_blocked", kinds)
        self.assertNotIn("review_blocked", kinds)
        self.assertIn("finished", kinds)  # Only review_blocked/controller_blocked are resolved ([L11]).

    def test_abandon_refuses_an_accepted_run_with_its_own_message(self):
        from .test_pipeline import pipeline_cli
        directory, repo, on_main_sha, _ = build_run(self.root)
        self.assertEqual(accept_cli(str(directory), "--candidate", on_main_sha, "--reason", "r", "--by", "operator")[0], 0)
        from .abandon import abandon_main
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            with self.assertRaises(SystemExit) as exit_:
                abandon_main([str(directory), "--reason", "too late", "--by", "operator"])
        self.assertEqual(exit_.exception.code, 1)
        self.assertIn("was accepted by the operator", output.getvalue())
        self.assertIn("cannot be abandoned", output.getvalue())

    def test_approve_and_automatic_refuse_an_accepted_run(self):
        from .test_pipeline import pipeline_cli
        directory, repo, on_main_sha, _ = build_run(self.root)
        self.assertEqual(accept_cli(str(directory), "--candidate", on_main_sha, "--reason", "r", "--by", "operator")[0], 0)
        for action in ("approve", "automatic"):
            code, out, err = pipeline_cli(action, str(directory))
            self.assertEqual(code, 1, (out, err))
            self.assertIn("accepted by the operator (override", err)

    def test_the_open_findings_follow_the_blocking_and_open_p2_rules(self):
        # [L5]: the blocking P0/P1 (not resolved, accepted ones included) then the P2s whose disposition is open; title is the
        # message verbatim; lane is the worker when it is a lane id, else null.
        directory, repo, on_main_sha, _ = build_run(self.root)
        from .accept import collect_open_findings
        save_json(directory / "review.json", {
            "run_id": "run", "reviewer": "rev-1", "independent": True, "bundle_sha256": "x", "candidate_commit": on_main_sha,
            "verdict": "blocked", "findings": [
                {"severity": "P1", "message": "open P1 on ui", "disposition": "open", "worker": "ui", "reviewer": "coverage"},
                {"severity": "P1", "message": "accepted P1", "disposition": "accepted", "worker": "ui", "reviewer": "general"},
                {"severity": "P0", "message": "resolved P0", "disposition": "resolved", "worker": "ui", "reviewer": "general"},
                {"severity": "P2", "message": "open P2 across lanes", "disposition": "open", "worker": "multiple", "reviewer": "general"},
                {"severity": "P2", "message": "accepted P2", "disposition": "accepted", "worker": "ui", "reviewer": "general"}]})
        plan = read_json(directory / "plan.json")
        self.assertEqual(collect_open_findings(directory, plan), [
            {"severity": "P1", "reviewer": "coverage", "title": "open P1 on ui", "lane": "ui"},
            {"severity": "P1", "reviewer": "general", "title": "accepted P1", "lane": "ui"},
            {"severity": "P2", "reviewer": "general", "title": "open P2 across lanes", "lane": None}])

    def test_the_outcome_block_names_the_override_the_reason_and_the_findings(self):
        from .outcome import outcome_block
        directory, repo, _, _ = build_run(self.root)
        save_json(directory / "accepted.json", {
            "version": "1.0.0", "run_id": "run", "candidate": "a" * 40, "reason": "shipped over one P1", "by": "operator",
            "accepted_at": "2026-10-08T12:00:00Z", "on_main": True, "review": "recorded",
            "open_findings": [{"severity": "P1", "reviewer": "coverage", "title": "a fail-safe is untested", "lane": "ui"}]})
        block = outcome_block(directory)
        self.assertIn("integrated (operator override): shipped over one P1", block)
        self.assertIn("[P1 coverage ui] a fail-safe is untested", block)
        # A record with no review reads "no review recorded" (design note 4, [L4]).
        save_json(directory / "accepted.json", {**read_json(directory / "accepted.json"), "review": "none", "open_findings": []})
        self.assertIn("no review recorded", outcome_block(directory))

    def test_status_names_the_override_and_its_next_step_suggests_no_refused_command(self):
        from .pipeline import run_status
        directory, repo, _, _ = build_run(self.root)
        save_json(directory / "accepted.json", {
            "version": "1.0.0", "run_id": "run", "candidate": "a" * 40, "reason": "shipped over one P1", "by": "operator",
            "accepted_at": "2026-10-08T12:00:00Z", "on_main": True, "review": "recorded",
            "open_findings": [{"severity": "P1", "reviewer": "coverage", "title": "a fail-safe is untested", "lane": "ui"}]})
        status, _ = run_status(directory)
        self.assertEqual(status["accepted"]["reason"], "shipped over one P1")
        self.assertEqual(status["accepted"]["open_findings"][0]["title"], "a fail-safe is untested")
        self.assertTrue(status["next_step"].startswith("none: the run's candidate was accepted"))
        for refused in ("approve", "repair", "retry"):
            self.assertNotIn(f"workflow {refused} ", status["next_step"])


if __name__ == "__main__":
    unittest.main()
