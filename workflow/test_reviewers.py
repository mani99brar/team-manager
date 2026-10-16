"""The shared reviewer list (features/review-panel-registry/prd.md 4, Appendix A; seats task Acceptance 1 and 2): `reviewers.load`
and `reviewers.resolve`, with injected `which` and `run`, so nothing here runs a real CLI or reads the operator's list. Every test
that reads a list points WORKFLOW_REVIEWERS_FILE at a temporary file."""
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from . import reviewers
from .verification import validate_schema

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / "features" / "review-panel-registry" / "examples"


def example() -> dict:
    return json.loads((EXAMPLES / "reviewers.example.json").read_text())


class Load(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.path = self.tmp / "reviewers.json"
        environment = mock.patch.dict(os.environ, {reviewers.ENV: str(self.path)})
        environment.start()
        self.addCleanup(environment.stop)

    def write(self, listing) -> None:
        self.path.write_text(json.dumps(listing) if not isinstance(listing, str) else listing)

    def refused(self, pattern: str, mutate) -> None:
        listing = example()
        mutate(listing)
        self.write(listing)
        with self.assertRaises(ValueError) as caught:
            reviewers.load()
        self.assertTrue(str(caught.exception).startswith(f"{self.path}: "), str(caught.exception))
        self.assertRegex(str(caught.exception), pattern)

    def test_the_shipped_example_loads_verbatim_and_validates_against_the_schema(self):
        self.path.write_bytes((EXAMPLES / "reviewers.example.json").read_bytes())
        listing = reviewers.load()
        self.assertEqual(listing, example())
        validate_schema("reviewers", listing)
        self.assertEqual([(e["name"], e["prefix"], e["enabled"]) for e in listing["reviewers"]],
                         [("claude", "C", True), ("gpt", "G", True), ("muse", "M", True), ("argon", "A", False)])
        self.assertNotIn("deepseek", json.dumps(listing))  # [G6]: DeepSeek is simply absent.
        # The explicit path argument wins over the variable.
        other = self.tmp / "other.json"
        other.write_bytes(self.path.read_bytes())
        self.assertEqual(reviewers.load(other, env={}), listing)

    def test_each_bad_input_of_prd_10_1_is_refused_with_the_path(self):
        self.refused("unexpected|not allowed|Additional properties", lambda l: l["reviewers"][0].update(extra=1))
        self.refused("unexpected|Additional properties", lambda l: l.update(extra=1))
        self.refused("duplicate name 'claude'", lambda l: l["reviewers"][1].update(name="claude"))
        self.refused("duplicate prefix 'C'", lambda l: l["reviewers"][1].update(prefix="C"))
        for word in ("api_key", "TOKEN_FILE", "client_secret", "Password"):
            self.refused("looks like a secret name", lambda l, w=word: l["reviewers"][2]["cli"]["env"]["set"].update({w: "x"}))
        self.refused("looks like a secret name", lambda l: l["reviewers"][0].update(apikey="x"))
        self.refused("looks like a secret name", lambda l: l["reviewers"][2]["cli"]["env"]["pass"].append("META_API_KEY"))
        self.refused(r"placeholder \{prompt\}", lambda l: l["reviewers"][2]["cli"]["argv"].append("{prompt}"))
        self.refused("version_argv takes no placeholder", lambda l: l["reviewers"][2]["cli"]["version_argv"].append("{model}"))
        self.refused("`cli` is required on a cli entry and forbidden on a pi entry",
                     lambda l: l["reviewers"][1].update(cli=l["reviewers"][2]["cli"]))
        self.refused("`cli` is required on a cli entry", lambda l: l["reviewers"][2].pop("cli"))
        self.refused("effort applies to a claude entry only", lambda l: l["reviewers"][1].update(effort="high"))
        self.refused("effort applies to a claude entry only", lambda l: l["reviewers"][2].update(effort="low"))
        self.refused("cap.budget_usd applies to a claude entry only", lambda l: l["reviewers"][2]["cap"].update(budget_usd=5))
        self.refused("budget_usd applies to a claude entry only", lambda l: l["reviewers"][1]["cap"].update(budget_usd=5))
        self.refused("does not match", lambda l: l["reviewers"][2].update(credential={"file": "~/.config/muse/login.json", "env": "muse_login"}))
        self.refused("may not set or pass PATH", lambda l: l["reviewers"][2]["cli"]["env"]["set"].update(PATH="/evil"))
        self.refused("credential env HOME clashes", lambda l: l["reviewers"][0].update(credential={"file": "~/.claude/login.json", "env": "HOME"}))
        self.refused("credential env PATH clashes", lambda l: l["reviewers"][1].update(credential={"file": "~/.pi/login.json", "env": "PATH"}))
        self.refused("model may be null only on a claude entry", lambda l: l["reviewers"][2].update(model=None))
        self.refused("provider/id", lambda l: l["reviewers"][1].update(model="gpt"))
        self.refused("does not compile", lambda l: l["reviewers"][2]["cli"]["failures"]["auth"].append("(unclosed"))
        self.refused("is not valid|is not one of|was expected", lambda l: l["reviewers"][0].update(transport="codex"))
        self.refused("too long|is too long|non-empty|should be non-empty|expected", lambda l: l.update(reviewers=[]))
        self.refused("too long|is too long", lambda l: l.update(reviewers=[dict(l["reviewers"][1], name=f"g{i}", prefix=chr(65 + i)) for i in range(17)]))
        self.refused("is greater than the maximum|maximum", lambda l: l["reviewers"][2]["cap"].update(timeout_minutes=61))

    def test_a_missing_an_unreadable_and_an_invalid_json_file_are_refused_with_the_path(self):
        with self.assertRaisesRegex(ValueError, f"^{self.path}: the reviewer list does not exist"):
            reviewers.load()
        self.write("{not json")
        with self.assertRaisesRegex(ValueError, f"^{self.path}: the reviewer list is not valid JSON"):
            reviewers.load()
        self.write(example())
        self.path.chmod(0)
        self.addCleanup(self.path.chmod, 0o600)
        if os.access(self.path, os.R_OK):
            self.skipTest("running as a user that reads mode-000 files")
        with self.assertRaisesRegex(ValueError, f"^{self.path}: the reviewer list cannot be read"):
            reviewers.load()

    def test_the_default_path_is_under_agent_memory_and_a_relative_override_is_refused(self):
        self.assertEqual(reviewers.path_of({"HOME": "/home/op"}),
                         Path("/home/op/.local/share/agent-memory/repo/learnings/skills/review-panel/reviewers.json"))
        self.assertEqual(reviewers.label_of(reviewers.path_of({"HOME": "/home/op"}), {"HOME": "/home/op"}),
                         "~/.local/share/agent-memory/repo/learnings/skills/review-panel/reviewers.json")
        with self.assertRaisesRegex(ValueError, "must be an absolute path"):
            reviewers.path_of({reviewers.ENV: "relative.json", "HOME": "/home/op"})


class FakeProbes:
    """Injected `which` and `run`: binaries on a fake PATH and each probe's exit and output, recorded."""

    def __init__(self, found: dict, results: dict):
        self.found, self.results, self.calls = found, results, []

    def which(self, name, path=None):
        return self.found.get(name)

    def run(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        key = (Path(argv[0]).name, argv[1])
        outcome = self.results.get(key, (0, ""))
        if isinstance(outcome, BaseException):
            raise outcome
        return subprocess.CompletedProcess(argv, outcome[0], stdout=outcome[1])


HELP = "Usage: claude [options]\n  --max-budget-usd <n>  stop after this spend\n"


def all_found() -> FakeProbes:
    return FakeProbes({"claude": "/opt/bin/claude", "pi": "/opt/nvm/bin/pi", "muse": "/opt/bin/muse", "agy": "/opt/bin/agy"},
                      {("claude", "--help"): (0, HELP), ("pi", "--version"): (0, "0.85.1\n"),
                       ("muse", "--version"): (0, "Muse Code 1.4.7 (1.4.7-R6101.1)\nbuilt 2026-10-01\n"), ("agy", "--version"): (0, "agy 0.9.3\n")})


class Resolve(unittest.TestCase):
    def resolve(self, seats, probes, listing=None):
        return reviewers.resolve(listing or example(), seats, which=probes.which, run=probes.run)

    def test_seats_omitted_takes_every_enabled_entry_in_list_order_with_bin_and_cli_version(self):
        probes = all_found()
        seats = self.resolve(None, probes)
        self.assertEqual([seat["name"] for seat in seats], ["claude", "gpt", "muse"])
        self.assertEqual([(s["status"], s["error"], s["bin"], s["cli_version"]) for s in seats],
                         [("pending", None, "/opt/bin/claude", None), ("pending", None, "/opt/nvm/bin/pi", None),
                          ("pending", None, "/opt/bin/muse", "Muse Code 1.4.7 (1.4.7-R6101.1)")])
        # The entry rides whole, its cap defaults filled; the version probe runs the pinned binary with an environment built from nothing.
        self.assertEqual(seats[2]["cli"], example()["reviewers"][2]["cli"])
        self.assertEqual(seats[1]["cap"], {"timeout_minutes": 15})
        self.assertEqual(seats[0]["cap"], {"timeout_minutes": 15, "budget_usd": 5})
        [muse_probe] = [kwargs for argv, kwargs in probes.calls if argv[0] == "/opt/bin/muse"]
        self.assertEqual(set(muse_probe["env"]), {"PATH", "HOME", "LANG", "TMPDIR", "MUSE_NO_AUTO_UPDATE"})
        self.assertEqual(muse_probe["timeout"], reviewers.PROBE_SECONDS)
        for seat in seats:
            reviewers.check_seat(seat, "seat ")

    def test_an_absent_named_seat_is_refused_and_a_disabled_one_is_pinned_unavailable(self):
        with self.assertRaisesRegex(ValueError, "panel seat 'deepseek' is not in the reviewer list"):
            self.resolve(["claude", "deepseek"], all_found())
        probes = all_found()
        [argon] = self.resolve(["argon"], probes)
        self.assertEqual((argon["status"], argon["error"], argon["bin"]), ("unavailable", "disabled in the reviewer list", None))
        self.assertEqual(probes.calls, [])  # A disabled seat is never probed.

    def test_a_missing_cli_binary_or_a_failing_version_argv_pins_unavailable_with_the_reason(self):
        probes = all_found()
        del probes.found["muse"]
        [muse] = self.resolve(["muse"], probes)
        self.assertEqual((muse["status"], muse["error"]), ("unavailable", "muse not found on PATH or in ~/.local/bin"))
        probes = all_found()
        probes.results[("muse", "--version")] = (2, "boom\n")
        [muse] = self.resolve(["muse"], probes)
        self.assertEqual((muse["status"], muse["error"], muse["bin"]), ("unavailable", "`muse --version` failed: exit 2", None))
        probes = all_found()
        probes.results[("muse", "--version")] = subprocess.TimeoutExpired(["muse"], 20)
        [muse] = self.resolve(["muse"], probes)
        self.assertEqual(muse["status"], "unavailable")
        self.assertIn("did not finish within 20 s", muse["error"])

    def test_a_claude_without_max_budget_usd_or_a_failing_pi_probe_pins_unavailable_and_never_raises(self):
        probes = all_found()
        probes.results[("claude", "--help")] = (0, "Usage: claude [options]\n")
        probes.results[("pi", "--version")] = (1, "")
        seats = self.resolve(["claude", "gpt"], probes)
        self.assertEqual([(s["status"], s["error"]) for s in seats],
                         [("unavailable", "the installed Claude CLI lacks --max-budget-usd"), ("unavailable", "`pi --version` failed: exit 1")])
        probes = FakeProbes({}, {})
        from . import panel
        with mock.patch.object(panel, "NVM_BINS", "/nonexistent-nvm/versions/node/*/bin"):  # Never the host's nvm tree.
            seats = self.resolve(None, probes)
        self.assertEqual([s["status"] for s in seats], ["unavailable"] * 3)  # All unavailable: resolve still returns, launch proceeds.

    def test_a_file_credential_is_only_stat_ed_and_its_env_carries_the_expanded_path(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        login = tmp / "muse-login.json"
        login.write_text("{}")
        login.chmod(0)  # Unreadable: a controller that opened it would fail.
        self.addCleanup(login.chmod, 0o600)
        listing = example()
        listing["reviewers"][2]["credential"] = {"file": str(login), "env": "MUSE_LOGIN_FILE"}
        reviewers.check(listing)
        probes = all_found()
        with mock.patch("builtins.open", side_effect=AssertionError("a credential file was opened")):
            [muse] = self.resolve(["muse"], probes, listing)
        self.assertEqual(muse["status"], "pending")
        self.assertEqual(reviewers.cli_env(muse, {"HOME": "/h", "META_API_KEY": "leak"})["MUSE_LOGIN_FILE"], str(login))
        self.assertNotIn(str(login), json.dumps([argv for argv, _ in probes.calls]))
        listing["reviewers"][2]["credential"] = {"file": str(tmp / "absent"), "env": "MUSE_LOGIN_FILE"}
        [muse] = self.resolve(["muse"], all_found(), listing)
        self.assertEqual(muse["status"], "unavailable")
        self.assertIn("credential file", muse["error"])

    def test_cli_env_is_built_from_nothing(self):
        [muse] = self.resolve(["muse"], all_found())
        env = reviewers.cli_env(muse, {"HOME": "/h", "LANG": "en_US.UTF-8", "META_API_KEY": "m", "GEMINI_API_KEY": "g", "OTHER": "o"})
        self.assertEqual(env, {"PATH": "/opt/bin:/usr/bin:/bin", "HOME": "/h", "LANG": "en_US.UTF-8", "TMPDIR": "/tmp", "MUSE_NO_AUTO_UPDATE": "1"})
        listing = example()
        listing["reviewers"][3]["enabled"] = True
        [argon] = self.resolve(["argon"], all_found(), listing)
        env = reviewers.cli_env(argon, {"HOME": "/h", "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/bus", "GEMINI_API_KEY": "g"})
        self.assertEqual(env, {"PATH": "/opt/bin:/usr/bin:/bin", "HOME": "/h", "LANG": "C.UTF-8", "TMPDIR": "/tmp",
                               "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/bus", "AGY_CLI_DISABLE_AUTO_UPDATE": "true"})


if __name__ == "__main__":
    unittest.main()
