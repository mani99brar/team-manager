import tempfile
import unittest
from pathlib import Path

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.types import Command

from .graph import AttemptLedger, build_graph


class GraphTests(unittest.TestCase):
    def test_failure_resume_reuses_successful_sibling_across_graph_recreation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ledger = AttemptLedger(root / "attempts.sqlite")
            config = {"configurable": {"thread_id": "failure-test"}, "max_concurrency": 2}
            with SqliteSaver.from_conn_string(str(root / "graph.sqlite")) as saver:
                graph = build_graph(saver, ledger)
                with self.assertRaisesRegex(RuntimeError, "Injected adapter failure"):
                    graph.invoke({"run_id": "failure-test", "base_commit": "a" * 40, "fail_adapter_once": True}, config)
            self.assertEqual(ledger.counts("failure-test"), {"ui": 1, "adapter": 1})
            # Reopen durable state, not merely the same in-memory graph.
            with SqliteSaver.from_conn_string(str(root / "graph.sqlite")) as saver:
                graph = build_graph(saver, AttemptLedger(root / "attempts.sqlite"))
                result = graph.invoke(None, config)
                self.assertIn("__interrupt__", result)
                self.assertEqual(ledger.counts("failure-test"), {"ui": 1, "adapter": 2})
                self.assertFalse(result["review"]["production_ready"])
                result = graph.invoke(Command(resume={"approve_stub_completion": True}), config)
                self.assertEqual(result["integration"], "stub_completed_no_merge")
                self.assertEqual(ledger.counts("failure-test"), {"ui": 1, "adapter": 2})
                self.assertFalse(graph.get_state(config).next)

    def test_happy_path_and_rejected_approval(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ledger = AttemptLedger(root / "attempts.sqlite")
            with SqliteSaver.from_conn_string(str(root / "graph.sqlite")) as saver:
                graph = build_graph(saver, ledger)
                config = {"configurable": {"thread_id": "happy"}, "max_concurrency": 2}
                result = graph.invoke({"run_id": "happy", "base_commit": "a" * 40}, config)
                self.assertIn("__interrupt__", result)
                result = graph.invoke(Command(resume=False), config)
                self.assertEqual(result["integration"], "rejected")
                self.assertEqual(ledger.counts("happy"), {"ui": 1, "adapter": 1})


if __name__ == "__main__":
    unittest.main()
