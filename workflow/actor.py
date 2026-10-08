"""Who acted (C17): every gate action names its actor with `--by operator|maintainer|panel`, with no default.

The operator is the person who owns the run. The maintainer is a Claude session acting for them, limited to mechanical
recovery (decision 2a): it may retry, reconcile, supervise again (`automatic --live`), start, and resume a design
challenge that waits for nothing the operator decides. It is refused the operator's decisions: an answer, an accepted
challenge, the release of a held challenge (`resume --launch`, C8), a repair, an approval, a launch, abandoning a run,
cleaning one up, a tryout verdict (C7) and launching past the untried-feature limit (`--allow-untried`, C29). `resume` refuses it on a paused challenge itself (guardrails.resume_challenge), and, with no record or
after an interrupted rerun, while a pinned feature file holds a later edit, because only the run's state says whether a
rerun would decide anything.

The panel is the /night-shift skill acting overnight (shadow-panel decisions [G4], [L1], [L2]): when its providers agree,
or Jev picks one of their decisions, within the goals the operator wrote for the night. It may answer a worker's
question, accept a paused design challenge and approve an integration, and nothing else: every other action is
refused for it, the operator's decisions and the maintainer's recovery alike.

The label is cooperative: nothing checks it. The actor goes into the event text, the questions record (answered_by), the
repair journal and the note file, never into challenge.json, whose schema is closed. When CLAUDECODE=1 the command ran
from a Claude Code session, and the text says so; that is evidence, never a refusal, since the operator also runs commands
through Claude Code's `!` prefix.
"""
from __future__ import annotations

import os

ACTORS = ("operator", "maintainer", "panel")
# The operator's decisions: refused for --by maintainer whatever the run's state.
OPERATOR_ONLY = frozenset({"answer", "accept-challenge", "resume --launch", "repair", "approve", "launch", "abandon", "clean", "tryout",
                           "--allow-untried", "attack-pass", "attack-label"})
# The only actions --by panel may run ([G4]); everything else is refused for it.
PANEL_ALLOWED = frozenset({"answer", "accept-challenge", "approve"})
# What every printed next-step command carries: they are addressed to the operator.
BY_OPERATOR = "--by operator"
VIA_CLAUDE_CODE = " (via a Claude Code session)"


def add_actor_argument(parser) -> None:
    parser.add_argument("--by", choices=ACTORS, help="Required: who runs this, the operator, the maintainer (a Claude session "
                                                     "acting for the operator, mechanical recovery only) or the panel (the "
                                                     "night shift: answer, accept-challenge and approve only)")


def require_actor(args, action: str) -> str:
    """The actor `args.by` names for `action`; ValueError when it is missing, or when the maintainer asks for an operator decision."""
    actor = getattr(args, "by", None)
    if actor not in ACTORS and action in OPERATOR_ONLY:
        raise ValueError(f"{action} requires --by operator: it is the operator's decision, so --by maintainer is refused")
    if actor not in ACTORS:
        raise ValueError(f"{action} requires --by operator|maintainer: the operator, or the maintainer (a Claude session acting for "
                         "the operator)")
    if actor == "panel" and action not in PANEL_ALLOWED:
        raise ValueError(f"{action} is refused for --by panel: the night shift may only answer, accept-challenge and approve; "
                         f"the operator runs it with {BY_OPERATOR}")
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
