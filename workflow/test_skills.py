import json
import os
import stat
import tempfile
import unittest
from pathlib import Path

from . import skills
from .sessions import lane_skills, worker_settings


def write_skill(root: Path, name: str, *, frontmatter="name: x\ndescription: y", files=None) -> Path:
    folder = root / name
    (folder).mkdir(parents=True)
    (folder / "SKILL.md").write_text(f"---\n{frontmatter}\n---\n# {name}\n")
    for rel, text in (files or {}).items():
        path = folder / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    return folder


class SkillsModuleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.root = skills.skills_root(self.home)

    def test_validate_names_pattern_count_and_duplicates(self):
        self.assertEqual(skills.validate_names("pages", ["impeccable", "design-2"]), ["impeccable", "design-2"])
        for bad in ([], ["Up"], ["a" * 65], ["x", "x"], list("abcdefghi"), ["-x"], [""]):
            with self.assertRaises(ValueError):
                skills.validate_names("pages", bad)

    def test_resolve_refuses_a_missing_or_irregular_skill_md_naming_the_lane_and_skill(self):
        with self.assertRaisesRegex(ValueError, "lane pages names skill ghost.*does not exist"):
            skills.resolve_skill("pages", "ghost", self.root)
        folder = (self.root / "dir-md"); folder.mkdir(parents=True); (folder / "SKILL.md").mkdir()
        with self.assertRaisesRegex(ValueError, "lane pages skill dir-md.*not a regular file"):
            skills.resolve_skill("pages", "dir-md", self.root)

    def test_check_refuses_hooks_frontmatter_but_allows_allowed_tools(self):
        write_skill(self.root, "hooked", frontmatter="name: h\nhooks:\n  PreToolUse: ./x.sh")
        with self.assertRaisesRegex(ValueError, "lane pages skill hooked: SKILL.md declares hooks"):
            skills.check_skill("pages", "hooked", self.root)
        write_skill(self.root, "tooled", frontmatter="name: t\nallowed-tools: Read, Bash")
        self.assertTrue(skills.check_skill("pages", "tooled", self.root).is_dir())

    def test_check_refuses_an_oversized_file_and_an_oversized_folder(self):
        write_skill(self.root, "bigfile", files={"ref.txt": "A" * (skills.MAX_FILE_BYTES + 1)})
        with self.assertRaisesRegex(ValueError, "bigfile: ref.txt is .* over the 2 MB"):
            skills.check_skill("pages", "bigfile", self.root)
        write_skill(self.root, "bigfolder", files={f"r{i}.txt": "B" * (2 * 1024 * 1024 - 10) for i in range(5)})
        with self.assertRaisesRegex(ValueError, "bigfolder: the skill folder is over the 8 MB"):
            skills.check_skill("pages", "bigfolder", self.root)

    def test_check_refuses_a_symlink_that_escapes_the_folder(self):
        folder = write_skill(self.root, "leaky")
        secret = self.home / "secret.txt"
        secret.write_text("TOP SECRET")
        os.symlink(secret, folder / "link.txt")
        with self.assertRaisesRegex(ValueError, "leaky: link.txt resolves outside the skill folder"):
            skills.check_skill("pages", "leaky", self.root)

    def test_resolve_follows_a_skill_md_symlinked_to_a_regular_file_inside_the_folder(self):
        # Design (settled): "each name resolves to ~/.claude/skills/<name>/SKILL.md (symlinks followed)". A SKILL.md that
        # is a symlink to a regular file inside the folder resolves, passes check_skill, and copies as a real file.
        folder = self.root / "linked-md"
        (folder).mkdir(parents=True)
        (folder / "real.md").write_text("---\nname: linked\ndescription: y\n---\n# linked\n")
        os.symlink("real.md", folder / "SKILL.md")  # relative link inside the folder
        self.assertEqual(skills.resolve_skill("pages", "linked-md", self.root), folder.resolve())
        self.assertTrue(skills.check_skill("pages", "linked-md", self.root).is_dir())
        dest = Path(self.temp.name) / "linked-copy"
        skills.copy_skill("pages", "linked-md", folder.resolve(), dest)
        self.assertEqual((dest / "SKILL.md").read_text().splitlines()[-1], "# linked")
        self.assertFalse((dest / "SKILL.md").is_symlink())  # copied as a real file, not a dangling link

    def test_check_refuses_a_skill_md_symlinked_outside_the_folder(self):
        # The escape boundary still applies (PRD 4.5, RUNBOOK): a SKILL.md symlinked out of the folder resolves but is
        # refused by check_skill, the same as any other escaping symlink.
        folder = self.root / "escaping-md"
        (folder).mkdir(parents=True)
        shared = self.home / "shared.md"
        shared.write_text("---\nname: shared\n---\n# shared\n")
        os.symlink(shared, folder / "SKILL.md")
        self.assertEqual(skills.resolve_skill("pages", "escaping-md", self.root), folder.resolve())
        with self.assertRaisesRegex(ValueError, "escaping-md: SKILL.md resolves outside the skill folder"):
            skills.check_skill("pages", "escaping-md", self.root)

    def test_digest_is_stable_per_skill_and_covers_contents(self):
        write_skill(self.root, "s", files={"ref/a.md": "alpha"})
        first = skills.skill_digest("pages", "s", skills.resolve_skill("pages", "s", self.root))
        # The same text in another location gives the same digest (two runs of the same skill).
        other = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(other, ignore_errors=True))
        write_skill(other, "s", files={"ref/a.md": "alpha"})
        self.assertEqual(first, skills.skill_digest("pages", "s", other / "s"))
        write_skill(self.root, "t", files={"ref/a.md": "beta"})
        self.assertNotEqual(first, skills.skill_digest("pages", "t", skills.resolve_skill("pages", "t", self.root)))

    def test_copy_preserves_an_executable_bit_and_follows_a_symlinked_folder(self):
        folder = write_skill(self.root, "launcher", files={"scripts/run": "#!/bin/sh\necho hi\n"})
        os.chmod(folder / "scripts" / "run", 0o755)
        # A real copy, symlinks resolved: a skill whose root is a symlink copies real files.
        linked = self.root / "aliased"
        os.symlink(folder, linked)
        dest = Path(self.temp.name) / "copy"
        resolved = skills.resolve_skill("pages", "aliased", self.root)
        skills.copy_skill("pages", "aliased", resolved, dest)
        self.assertEqual((dest / "SKILL.md").read_text().splitlines()[-1], "# launcher")
        self.assertTrue((dest / "scripts" / "run").is_file() and not (dest / "scripts" / "run").is_symlink())
        self.assertTrue(os.stat(dest / "scripts" / "run").st_mode & stat.S_IXUSR)

    def test_advisor_model_reads_only_that_key(self):
        claude = self.home / ".claude"
        claude.mkdir()
        self.assertIsNone(skills.advisor_model(self.home))  # no settings file
        (claude / "settings.json").write_text(json.dumps({"model": "x", "permissions": {"deny": []}}))
        self.assertIsNone(skills.advisor_model(self.home))  # key absent
        (claude / "settings.json").write_text(json.dumps({"advisorModel": "fable", "hooks": {"PreToolUse": "x"}}))
        self.assertEqual(skills.advisor_model(self.home), "fable")


class WorkerSettingsSkillsVariantTests(unittest.TestCase):
    def test_the_skills_variant_adds_edit_and_write_denies_and_the_advisor(self):
        run = Path(tempfile.gettempdir()) / "runs" / "skill-run"
        plain = json.loads(worker_settings(run)[1])
        variant = json.loads(worker_settings(run, skills_lane="pages", advisor_model="fable")[1])
        plugin = run.resolve() / "skills" / "pages"
        edit, write = f"Edit(/{plugin}/**)", f"Write(/{plugin}/**)"
        # Exactly the Edit and Write denies on the lane's own plugin are added (decisions.md [L1] g); nothing is removed.
        self.assertEqual([rule for rule in variant["permissions"]["deny"] if rule not in plain["permissions"]["deny"]], [edit, write])
        self.assertTrue(set(plain["permissions"]["deny"]).issubset(variant["permissions"]["deny"]))
        # advisorModel is the only other difference; env and worktree are byte for byte the plain settings.
        self.assertEqual(variant["advisorModel"], "fable")
        self.assertEqual((variant["env"], variant["worktree"]), (plain["env"], plain["worktree"]))
        self.assertNotIn("advisorModel", plain)
        # No advisor key when the plan pinned none.
        self.assertNotIn("advisorModel", json.loads(worker_settings(run, skills_lane="pages", advisor_model=None)[1]))


class PrintTransportSkillsRefusalTests(unittest.TestCase):
    def test_the_print_transport_refuses_a_lane_with_skills(self):
        from .test_sessions import SessionTests
        case = SessionTests()
        case.setUp()
        self.addCleanup(case.doCleanups)
        plan = case.plan
        self.assertEqual(lane_skills(plan, "ui"), [])
        plan["nodes"]["ui"]["skills"] = [{"name": "impeccable", "sha256": "f" * 64}]
        from .sessions import save_json
        save_json(case.directory / "plan.json", plan)
        sessions = case.sessions()
        with self.assertRaisesRegex(RuntimeError, "Lane ui declares skills, which only an interactive session loads"):
            sessions.run("ui")


if __name__ == "__main__":
    unittest.main()
