"""Who acted (C17): every gate action names its actor with `--by operator|maintainer`, with no default.

The operator is the person who owns the run. The maintainer is a Claude session acting for them, limited to mechanical
recovery (decision 2a): it may retry, reconcile, supervise again (`automatic --live`), start, and resume a design
challenge that waits for nothing the operator decides. It is refused the operator's decisions: an answer, an accepted
challenge, a repair, an approval and a launch. `resume` refuses it on a paused challenge itself
(guardrails.resume_challenge), because only the run's state says whether a rerun would decide anything.

The label is cooperative: nothing checks it. The actor goes into the event text, the questions record (answered_by), the
repair journal and the note file, never into challenge.json, whose schema is closed. When CLAUDECODE=1 the command ran
from a Claude Code session, and the text says so; that is evidence, never a refusal, since the operator also runs commands
through Claude Code's `!` prefix.
"""
from __future__ import annotations

import os

ACTORS = ("operator", "maintainer")
# The operator's decisions: refused for --by maintainer whatever the run's state.
OPERATOR_ONLY = frozenset({"answer", "accept-challenge", "repair", "approve", "launch"})
# What every printed next-step command carries: they are addressed to the operator.
BY_OPERATOR = "--by operator"
VIA_CLAUDE_CODE = " (via a Claude Code session)"


def add_actor_argument(parser) -> None:
    parser.add_argument("--by", choices=ACTORS, help="Required: who runs this, the operator or the maintainer (a Claude session "
                                                     "acting for the operator, mechanical recovery only)")


def require_actor(args, action: str) -> str:
    """The actor `args.by` names for `action`; ValueError when it is missing, or when the maintainer asks for an operator decision."""
    actor = getattr(args, "by", None)
    if actor not in ACTORS:
        raise ValueError(f"{action} requires --by operator|maintainer: the operator, or the maintainer (a Claude session acting for "
                         "the operator)")
    if actor == "maintainer" and action in OPERATOR_ONLY:
        raise ValueError(f"{action} is the operator's decision: --by maintainer is refused; the operator runs it with {BY_OPERATOR}")
    return actor


def via_claude_code(environ=None) -> bool:
    return (os.environ if environ is None else environ).get("CLAUDECODE") == "1"


def actor_text(actor: str, environ=None) -> str:
    """`the operator`, or `the maintainer`, with ` (via a Claude Code session)` when the command ran from one."""
    return f"the {actor}" + (VIA_CLAUDE_CODE if via_claude_code(environ) else "")


def actor_record(actor: str, key: str = "by", environ=None) -> dict:
    """The fields a record keeps: the actor under `key`, and `via: "claude-code"` only when the command ran from a Claude Code session."""
    return {key: actor, **({"via": "claude-code"} if via_claude_code(environ) else {})}
