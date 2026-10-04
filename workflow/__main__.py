"""`python -m workflow` exposes the complete operator-driven pipeline CLI, plus `launch`, `init`, `resume`, `answer`, `note`, `sidecar-pass`, `repair`, `brief`, `abandon`, `check-report`, `clean` and `ledger`."""
import os
import sys

if __name__ == "__main__":
    # Every Git command the controller runs, and every controller it starts, inherits hooks and fsmonitor off: a lane's
    # worktree shares the target's .git. Claude sessions and checks get the environment without them (worktrees.py).
    from .worktrees import controller_git_config
    controller_git_config(os.environ)
    if len(sys.argv) > 1 and sys.argv[1] == "launch":
        from .launch import main
        main(sys.argv[2:])
    elif len(sys.argv) > 1 and sys.argv[1] == "init":
        from .scaffold import main
        main(sys.argv[2:])
    elif len(sys.argv) > 1 and sys.argv[1] == "resume":
        from .guardrails import resume_main
        resume_main(sys.argv[2:])
    elif len(sys.argv) > 1 and sys.argv[1] == "answer":
        from .guardrails import answer_main
        answer_main(sys.argv[2:])
    elif len(sys.argv) > 1 and sys.argv[1] == "note":
        from .notes import note_main
        note_main(sys.argv[2:])
    elif len(sys.argv) > 1 and sys.argv[1] == "sidecar-pass":
        from .sidecar import pass_main
        pass_main(sys.argv[2:])
    elif len(sys.argv) > 1 and sys.argv[1] == "repair":
        from .repair import repair_main
        repair_main(sys.argv[2:])
    elif len(sys.argv) > 1 and sys.argv[1] == "brief":
        from .brief import brief_main
        brief_main(sys.argv[2:])
    elif len(sys.argv) > 1 and sys.argv[1] == "abandon":
        from .abandon import abandon_main
        abandon_main(sys.argv[2:])
    elif len(sys.argv) > 1 and sys.argv[1] == "check-report":
        from .checks import check_report_main
        check_report_main(sys.argv[2:])
    elif len(sys.argv) > 1 and sys.argv[1] == "clean":
        from .clean import clean_main
        clean_main(sys.argv[2:])
    elif len(sys.argv) > 1 and sys.argv[1] == "ledger":
        from .ledger import ledger_main
        ledger_main(sys.argv[2:])
    else:
        from .pipeline import main
        main()
